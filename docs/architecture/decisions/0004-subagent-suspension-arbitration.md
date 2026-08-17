# 0004. subagent 挂起裁决协议 + bash 默认超时

- 日期：2026-03
- 状态：已接受

## 背景

主 agent 经 `subagent` 扩展把任务委派给隔离上下文的子 pi 进程时，曾暴露两类致命故障：

1. **子 agent 内 bash 永久卡死**：典型是子 agent 触发了死锁代码（例如有界并发 + 写锁未释放 / 跑进不可中断的 syscall）。原 `subagent` 没有任何超时 / watchdog，唯一 kill 路径是外部 AbortSignal，且只杀单 PID **不杀进程组** → 整条委派链 hang 死，主 agent 上下文被无关等待填满
2. **idle 子 agent 长期无事件**：子进程 stdout 长时间无 NDJSON 事件但仍存活；主 agent 不知道该继续等、kill 还是接管，行为不收敛

`entire` 扩展虽然给 `bash` 注入过 `GIT_TERMINAL_PROMPT=0`，但只防交互卡死，对**运行超时**与**idle**两类故障不起作用。

需求点：

- 给子 agent 内的工具调用加上**最低限度的时间防御**
- 当子 agent 长时间无活动时给主 agent 一个**明确的、可裁决的语义**——而不是等死

## 决策

两层独立、各管一段的协议化结构。

### 1. bash-guard 扩展（`.pi/extensions/bash-guard/`）

- 订阅 `tool_call`，在 `bash` 调用前判定：若用户**未传** `timeout` 字段，自动注入默认 **300s**；若用户**显式传值**，原样尊重、**不做封顶**
- 默认值可通过环境变量 `BASH_GUARD_DEFAULT_TIMEOUT_S` 覆写（任何合法正整数秒）
- 副作用明确接受：扩展**对主 agent 自己的 `bash` 同样生效**（`tool_call` 钩子无 caller 区分）。这是有意为之——把「超时防御」作为全局底层保障，而不是只给 subagent 兜底

> 设计取舍：不在 `subagent` 内部 fork 一份专属 bash 配置。理由：超时语义应当对所有调用者一致；多份配置会带来「为什么我的 bash 没事、subagent 的会出事」的认知成本。

**提示面（三面让默认值真正被认知）**。pi 内置 `bash` 工具的参数描述声称 `no default timeout`，与 bash-guard 实际注入的 300s 默认值矛盾——子 agent 照描述行事会以为长命令能无限跑。三面互补：

- **bash-guard · tool_result 追加**：仅当「该次调用注入过默认值（call id 在 `injectedDefaultTimeouts` 中）」**且** `isError === true` **且** 文本含 timeout 迹象（`timeout` / `timed out` / `timed-out`）时，向 `content` 追加一行事实说明——指出 300s 默认值已生效、如何显式传 `timeout` 解除。**只 patch `content`**（pi `tool_result` 事件的 partial-patch 契约），`isError` / `details` / `usage` 不动；call id 在每次 `tool_result` 后删除，map 不泄漏
- **subagent · 每子 agent 系统提示追加**：spawn 子 `pi` 时给每个子 agent 的 systemPrompt 追加一行 **Runtime note**，写明「默认值来自 `resolveDefaultTimeoutS()`，与 `BASH_GUARD_DEFAULT_TIMEOUT_S` env 覆写一致」。无 systemPrompt 的 agent 也生成只含该说明的 tmp 文件——保证零系统提示路径下默认行为依然被告知。两端共用 `resolveDefaultTimeoutS()`，env 覆写钩子对双方一致生效
- **subagent · `SUBAGENT_DESCRIPTION` 主 agent 侧补一句——委派长命令时应指示子 agent 显式传 `timeout`**，避免默认值把已知慢命令中途砍掉

**为什么不做 bash 工具全量覆盖**（即不通过 `getAllTools()` 全量枚举再 patch 每个 bash-like 工具）：`getAllTools()` 在 pi 当前 API 下不暴露具名 `execute` 句柄，无法在不破坏工具注册的前提下安全委托执行；partial-patch 契约也只覆盖 `tool_result` 事件。三面已能让默认值在「确实触发了超时」与「还没触发但即将跑」两个时机被感知，全量覆盖属过度工程。

### 2. subagent 空闲挂起裁决（`.pi/extensions/subagent/{index.ts,suspensions.ts}`）

**协议核心**：子进程 `detached: true` 进程组 spawn → 在主端以 stdout NDJSON 事件流驱动 idle 计时 → 连续 `SUBAGENT_IDLE_TIMEOUT_MS`（默认 600000ms / 600s，环境变量可覆写）**无事件** → **SIGSTOP 冻结整组** → 工具提前返回「纯事实快照」，把裁决权交回主 agent。

返回快照（**故意不设 `isError`、无任何建议性 hint**）：

| 字段 | 含义 |
|------|------|
| `status` | 固定为 `"idle_suspended"` |
| `suspensionId` | 唯一 id，供 `resume` / `kill` 引用 |
| `idleMs` | 当前已 idle 时长 |
| `runningCommand` | 触发挂起的那条工具调用（命令 + 参数） |
| `requestedTimeout` | 当时实际请求的超时（来自 bash-guard 注入或用户显式） |
| `tail` | 最近的 stdout / stderr 片段（事实，不评价） |

裁决动作（**互斥**，用 `suspensionId` 寻址）：

| 命令 | 语义 |
|------|------|
| `agent` / `task` / `tasks` `inspect` | thaw + 读取快照后再次冻结；**不改 idle 累计**；纯查询 |
| `... resume` | thaw 整组继续运行；累计 idle 重置 |
| `... kill` | thaw 整组后**同步**发组级 SIGKILL；之后不再跟踪 |

冻结 / 解冻用 SIGSTOP / SIGCONT，发到**进程组**（`kill(-pgid, sig)`）而非单 PID，确保子进程及其子孙被一致对待。

**深树信号覆盖（descendant walk）**：pgid 级信号只能命中与子 `pi` 同 pgid 的子进程。子 `pi` 的 bash 通过 `setsid` / `nohup` / `disown` 启动的孙进程**拥有独立 pgid + sid**，组级 SIGSTOP / SIGCONT / SIGKILL 永远到不了它们。孙命令会：（1）冻结时仍 Ss 运行（浪费 CPU、idle 检测永不收敛）、（2）kill 时被遗弃成 PPID=1 的孤儿（占着端口 / 文件锁不放）。修复方案：`suspensions.ts` 新增 `collectDescendantPids(rootPid)` 走 `/proc/<pid>/stat`（Linux）或 `ps -eo pid=,ppid=`（macOS）建 ppid 映射做 BFS 收集全部后代；`freezeProcessGroup` / `thawProcessGroup` / `killProcessGroup` 在组级信号之后按逆序（叶先根后）逐个信号。freeze / freeze 期间组本身已停止，孙进程不会再生长；thaw / kill 先解孙再根，避免根醒来还没轮到孙造成 race。所有解析错误容错、绝不抛出。`parentProcessCleanup` 同步路径同步换用 `killProcessGroup` 同步版本，避免父进程退出时遗留孙子进程。

### 3. 配套机制

- **AbortSignal 生命周期**：挂起时从「活动表」摘除（外部 abort 不再作用于已冻结进程）；`resume` 时按 `suspensionId` 重新挂回；挂起中**不响应**外部 abort（避免「已 freeze 还被 kill」的语义混乱）
- **父进程 exit / SIGINT / SIGTERM**：注册 best-effort 清扫钩子，遍历活动表（含挂起）thaw + 组级 SIGKILL；**父进程被 `kill -9` 不可覆盖**——杀进程组本身就依赖父进程存活
- **parallel 隔离**：每次挂起生成独立 `suspensionId`；多个挂起同时存在时按 `suspensionId` 一一对应 `resume` / `kill`，**不按下标**；不会因顺序错位误 resume 到错误槽位

### 4. 明确不做（用户拍板的取舍）

| 议题 | 决策 | 理由 |
|------|------|------|
| 挂起 TTL（挂起超时自动 kill） | 不做 | 裁决权交给主 agent；超时即杀反而剥夺了 `inspect` 排查机会 |
| 防乒乓球（resume 后立刻再挂起的减震） | 不做 | 现状已可由主 agent 自行 kill 终止；无需协议层减震 |
| 建议性 hint（"建议 kill" / "建议 resume"） | 不做 | 协议只返回事实，决策交还主 agent；任何 hint 都是协议越权 |
| 总时长 wall-clock（不管活动与否都限时） | 不做 | wall-clock 与 idle 语义冲突；活动期间挂起无意义 |
| 环境变量加固（`CI=1` 强制更短超时等） | 不做 | bash-guard / subagent 的 env 覆写已够用；再做叠加收益小、复杂度高 |
| Windows 支持 | 降级 | Windows 无 SIGSTOP / SIGCONT。看门狗路径直接杀整树，**不进裁决协议**；用户可感知的防护只剩 300s bash 超时 |

## 数字关系（默认路径保证）

```
SUBAGENT_IDLE_TIMEOUT_MS = 600_000  (600s)
BASH_GUARD_DEFAULT_TIMEOUT_S = 300  (300s)
```

保证：**600s > 300s**。即「bash 默认超时」必然先于「idle 挂起」触发。任何 bash 跑死也会在 idle 判定器介入之前被超时回收，**默认路径下 idle 挂起永不被误触发**。环境变量覆写若破坏这一关系，属用户主动行为，需自行承担语义后果。

## 测试现状

- **140 项测试全过**（107 协议/CLI 基线 + 14 并行组单位 + 1 e2e 场景 + 18 bash-guard 提示面：`test/subagent/bash-guard.test.ts` 覆盖「显式传 timeout 原样尊重 / 未传注入 300s / tool_result 含 timeout 迹象追加事实 / 不含 timeout 迹象不动 / 非 bash 工具不受影响 / env 覆写生效 / partial patch 不动 isError+details+usage / call id map 不泄漏」）
- **10 个协议 e2e 场景**（用 fake pi shim，无 LLM 依赖）：
  1. freeze → inspect → kill
  2. freeze → resume
  3. chain 中某步挂起 → kill 该步
  4. parallel：单挂起 → resume
  5. parallel：双挂起 → 逐个 resume（验证 `suspensionId` 寻址，无下标错位）
  6. 二次挂起（resume 后再次 idle 超时）→ 再 resume
  7. abort 在挂起中触发 → 不杀进程（验证 AbortSignal 生命周期）
  8. resume 与 kill 同 id 竞态 → 不死锁（验证 `cancelled` / `finalized` 双守卫）
  9. deep tree signal：frozen / resume / kill 都能跨 pgid 边界到达 `setsid` 的孙进程（孙 STAT=T / 非 T / 死透；无孤儿）
  10. **parallel：双挂起 → kill 1 + resume 1** → 验证宿主 pi **不崩溃**（崩溃点 `liteToSingle(undefined)` at `index.ts:450`），每个槽位都能正确定位（killed=aborted、resumed=end、quick=end），注册表清空（事件处理器安全网的回归纲领场景）

## 开发事故教训（沉淀）

开发期间 e2e 曾挂死一次：

- **症状**：`runDriver` 卡住，整套 e2e 假阳性「通过」
- **根因**：kill 触发的 `close` 事件被误当成「chain 续跑」信号，spawn 出孤儿步骤继续运行；同时测试本身无超时兜底，孤儿步骤持续 hang
- **修复**：建立三层防线
  1. Jest `testTimeout = 120_000`（保险丝，但不应是主防线）
  2. `runDriver` 内置 60s 强制超时，超时即**杀进程组**（与协议同源）
  3. `afterEach` 扫描 `pi-e2e` 进程残留，发现即 `fail`
- **进一步验证**：此事直接坐实了「挂起 vs 杀死」语义区分（`cancelled` / `finalized` 双守卫）是协议正确性的核心——任何一个守卫失守都会让 kill 后的 close 事件被错误解读为续跑

写在这里，是为了避免后续维护者在扩展 subagent 时无意中把 close 事件升级为续跑触发器。

- **事件处理器的异常安全网是宿主存活的前提**：`ChildProcess` 的 `close` / `error` 事件回调、以及 `setTimeout` 包装的 watchdog 回调中任意一个同步抛出，在 Node.js 事件循环里 **会让宿主 pi 进程崩溃**（错误从 ChildProcess 的 emitter 传上来后无人 catch）。任何回调体内部都必须包 `try/catch`：捕获后 resolve 工具 Promise 为 `isError` 结果 + `console.error` 完整堆栈到 stderr。这不是“可选防御”，是“代码加载到宿主”本身的存活前提。P1 的 `liteToSingle(undefined)` 崩溃本身被 P3 安全网接住：即使上游 invariant 进一步退化，最坏后果是工具调用返回错误结果，**而不是崩主进程**。

## 影响

### 用户接口

- `subagent` 工具的 4 个命令变体（`agent` / `task` / `tasks` / `chain`）共享挂起裁决动作（`inspect` / `resume` / `kill`），裁决动作**彼此互斥**，通过 `suspensionId` 寻址
- 挂起期间主 agent **仍然**消耗其上下文位置（快照是工具返回值的一部分）；`tail` 长度有界，不会 OOM

### 与既有扩展的协同

- `bash-guard` 与 `subagent` 的 idle 挂起互相独立：bash 跑死走 bash 超时（≤300s）；idle 是 bash 已正常返回但子进程无后续事件的场景。两层独立、覆盖不同故障模式
- `entire` 扩展不受影响；它的 `GIT_TERMINAL_PROMPT=0` 注入继续生效（防御交互卡死）

### 性能 / 资源

- idle 检测是 stdout `data` 事件驱动的「累计时间窗」实现，**非 setInterval 轮询**，无定时器开销
- 挂起态进程不占 CPU（SIGSTOP）；内存由 OS 回收前持续占用，依赖父进程清扫钩子

## 已知限制

- **Windows 下 SIGSTOP 不可用**：看门狗路径**退化**为杀整树（走 `taskkill /T /F`），主 agent 收到 `idle_suspended` 失败但拿到 bash 超时回报；功能等价性损失已记录在 §4「明确不做」
- **父进程被 `kill -9`**：清扫钩子来不及执行，已挂起的进程组继续占用资源直至子进程被 OS 回收或外部手动清理；进程重启后的孤儿清扫**当前未实现**，属后续改进项
- **`parallel` 模式 O(N) 挂起**：主 agent 上下文一次性吃下 N 个快照；目前 N 受 `parallel.maxConcurrency` 限制，无需额外限流

## 相关

- 系统总览：[[architecture/overview.md]]（Extensions / 关键决策）
- 索引：[[architecture/decisions/README.md]]
- 前置决策：ADR [[architecture/decisions/0001-pisquad-cli.md]]（subagent 隔离委派基础）、ADR [[architecture/decisions/0003-interactive-upgrade.md]]（决策层 deps 注入模式可被本协议的 inspector / resumer 复用）