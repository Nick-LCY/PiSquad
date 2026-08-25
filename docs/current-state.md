# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 项目阶段

pi-squad 已基本成型、可用：多 Agent 协作、文档驱动、会话可追溯三件套均已就位，可经 `pisquad` CLI 安装或复制 `assets/` 直接落地。CLI 同时提供 install / upgrade / version / help 子命令，升级路径走 `pisquad upgrade`，文档修改走 tar.gz 备份保护。系统设计与组件职责见 [[architecture/overview.md]]。

0.3.1 修复（返工后）：`bash-guard` 同步清单遗漏导致走 `upgrade` 路径的消费者拿不到该扩展（详见「最近变更」最新条目）。**返工不再走「单点补丁」**，而是改用**单源派生**——`src/lib/plugins/core.ts` 的 `EXTENSION_DIRS` `export` 后被 `upgrade.ts` 的 `includes` 构造、`test/install/core-extension-manifest.test.ts`、`test/upgrade/manifest.test.ts` 同时 import，新增 core 扩展只需改一处。同时新增 L4 发布验证门（[[conventions/release-verification.md]]）：新增 / 修改 core 扩展必须过 `npm pack → 解包 → install → 全扩展落盘 + 入口加载断言` 全链；install + upgrade 两侧端到端断言镜像覆盖；测试 fixture **不得**硬编码镜像生产清单——只能从生产 import、断言两端一致、或走 e2e。`package.json` 加 `pretest` 钩子强制 fresh build，保证 install 端 L4 不会看到「旧 dist 过 / 新 src 不过」的伪绿。

## 已就绪能力

- **Agents（5）**：scout / planner / worker / reviewer / archivist，权限隔离、上下文独立
- **Skills（2）**：`project-docs`（文档库入口）、`workflow`（分工铁律）
- **Extensions（5）**：`subagent`（隔离委派 single / parallel / chain + **idle 挂起裁决协议**：SIGSTOP 冻结整组 + inspect/resume/kill 互斥裁决 + **usage surfacing 双通道**——①文本行 `[subagent usage] <agent> · <model> · ↑<in> ↓<out> · ctx <ctx>/<window> (<pct>%) · $<cost>` 追加在每次结果末尾进 LLM 上下文，②结构化 `AgentToolResult.usage` 填聚合后的 `Usage`（`input`/`output`/`cacheRead`/`cacheWrite` 累加 + `cost.total` = 子 agent 成本之和）进 host session stats / footer；**计费口径**：父与子是各自独立的 API 调用，session 统计为累计口径，两者相加即全链路成本，无重复计算）+ **transcript 事后回看**（参数模式 `transcript`：流式读取 host `PI_SESSION_FILE` jsonl，按 `only=interrupted`（默认）/`agent`/`index` 过滤，挑最近一次匹配的 subagent toolResult 渲染 `[transcript] <agent> · ...` 头部 + 最后 N 步，`lines` 默认 10、clamp 到 `[1, MAX_TRANSCRIPT_LINES=50]`；**纯只读**——不触碰任何进程、不修改挂起注册表，与 `resume`/`kill`/`inspect` 互斥，同一调用只能走一种模式））、`bash-guard`（`bash` 兜底 300s 默认超时，env `BASH_GUARD_DEFAULT_TIMEOUT_S` 可覆写，主/子 agent 同等生效）、`codegraph`（8 个代码图查询工具）、`entire`（会话事件桥接）、`wikilink-lint`（docs 链接硬约束）。两层时间防御：bash 超时（≤300s）与 idle 挂起（默认 600s）覆盖不同故障模式；详见 ADR [[architecture/decisions/0004-subagent-suspension-arbitration.md]]
- **docs 模板库**：结构即导航 + 渐进式披露的通用骨架
- **pisquad CLI**（已发布 `@nicklin/pisquad@0.3.2`）：npm 全局包，提供 `install` / `upgrade` / `version` / `help`；upgrade 含 docs 在内的 sha256 diff + tar.gz 备份；self-update 前比较 registry 版本，已是最新则跳过
- **pisquad upgrade 交互式决策**（0.1.1 之后）：按目录白名单拆分交互区（`docs/**`、`.pi/agents/**`、`.pi/skills/**`，走决策层逐文件询问 adopt/keep/edit）与管理区（`.pi/extensions/**`，保持自动覆盖+备份）；无 tty / CI 退化为 all-adopt+备份；详见 ADR [[architecture/decisions/0003-interactive-upgrade.md]]
- **双语 README + MIT license**

## 活跃需求

- （无）

## 任务看板

### pisquad-cli（PRD [[prds/pisquad-cli.md]]，ADR [[architecture/decisions/0001-pisquad-cli.md]]）— ✅ 完成

**阶段 1 · MVP**（能装能用）

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/01-package-scaffold.md` | done | 包脚手架（package.json / tsconfig / tsup / npmignore） |
| `tasks/pisquad-cli/02-bash-bootstrap.md` | done | bash bootstrap（仓库根转发脚本） |
| `tasks/pisquad-cli/03-cli-lib-foundation.md` | done | CLI lib 基础（env / paths / ui / assets / copy / fs-safe） |
| `tasks/pisquad-cli/04-state-writer.md` | done | state.json 写入子集 |
| `tasks/pisquad-cli/05-command-dispatch.md` | done | 命令分发 + version / help / install 空壳 |
| `tasks/pisquad-cli/06-plugins-install.md` | done | plugins 模块（**修整个 bug**） |
| `tasks/pisquad-cli/07-install-command.md` | done | install 命令完整逻辑（**非交互不卡死**） |
| `tasks/pisquad-cli/08-readme-basics.md` | done | README 基础更新（Quick Start / Commands / Structure） |

**阶段 2 · upgrade 全套**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/09-diff-and-backup.md` | done | diff / backup lib（**docs 纳入 diff**） |
| `tasks/pisquad-cli/10-state-read-compare.md` | done | state 读取与比较（**不向后兼容**） |
| `tasks/pisquad-cli/11-upgrade-command.md` | done | upgrade 命令完整逻辑（安全机制） |
| `tasks/pisquad-cli/12-cli-self-update.md` | done | CLI 自更新（`npm i -g @nicklin/pisquad@latest`） |

**阶段 3 · 文档与发布**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/13-docs-sync.md` | done | 文档全面同步（overview / current-state 反映 CLI 化） |
| `tasks/pisquad-cli/14-e2e-and-publish.md` | done | e2e 验证 + `npm pack` 内容检查 + publish 演练 |

**阶段 4 · 交互式 upgrade 增强**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/15-interactive-upgrade.md` | done | 决策层（`src/upgrade/decision.ts`） + adapter（`decision-defaults.ts`） + 管理区/交互区拆分 + `$EDITOR` 方案 A + `--interactive` / `--no-interactive`；38 项测试全过、tsup 构建成功 |

## TODO / 阻塞

- 可选：端到端 integration 测试覆盖 `absent flag + tty → per-file` 路径（S2 留 TODO，决策层单测已覆盖同等矩阵）

## 最近变更

- 发布 `@nicklin/pisquad@0.3.2`：subagent 扩展新增 usage surfacing + transcript 事后回看。**背景**：父 agent 之前看不到子 agent 实际花了多少 token / 钱，只能凭经验估；事后被中断（Esc / kill / 挂起失败）的子 agent 只能拿到一行 summary，看不到它在死前具体在调什么工具、看什么文件——两类体验都缺。**改动面**（全部在 `assets/.pi/extensions/subagent/index.ts`，未触碰其它 core 扩展）：①**usage surfacing 双通道**——每次 tool result 末尾追加一行 `[subagent usage] <agent> · <model> · <n> turn[s] · ↑<in> ↓<out> · ctx <ctx>/<window> (<pct>%) · $<cost>` 进 LLM 上下文（`appendUsageLines`）；同时填 `AgentToolResult.usage` 的结构化 `Usage` 进 host session 的 stats / footer（`aggregateUsageToUsage`：每子结果累加 input / output / cacheRead / cacheWrite，`cost.total` = 子 agent 成本之和，`totalTokens` = 各子 `contextTokens` 之和；`UsageStats` 无 per-component cost 字段故 per-component 全部置 0）。**计费口径**：父与子 agent 是各自独立的 API 调用，session 统计为累计口径——`cost.total` 等于两端相加即全链路成本，**不是**去重或重复计算。②**transcript 事后回看**（新增 `transcript` 参数模式）：从 host `PI_SESSION_FILE` 流式 jsonl 里按 `only=interrupted`（默认）/ `agent` / `index=0`（最近匹配）过滤，挑一次匹配的 subagent toolResult 条目渲染 `[transcript] <agent> · <provider>/<model> · stopReason=<x> exit=<n> · <m> msgs · task: <preview>` 头部 + 最后 N 步（默认 10、clamp 到 `[1, 50]`），尾部再拼一行 `[subagent usage] ...`；**纯只读**——不 spawn、不触碰进程、不修改挂起注册表，与 `resume` / `kill` / `inspect` 互斥（同一调用只能走一种模式，违反时 dispatch 直接返回错误）。上下文窗口通过 `getBuiltinModel(provider, bareId)` 查 pi-ai builtin catalog，prefix 形式 `provider/model` 先剥前缀；miss 时降级为 `(window unknown)`，不阻塞渲染。**TUI 修法**——保留原有英文 TUI 约定（inquirer / logger / spinner / help 全英文；详见 [[conventions/tui-language.md]]）；transcript 的失败路径文案是 LLM 上下文而非终端用户 TUI，**不**受 TUI 英文约束，使用与工具 description 同语种的中文（`无法读取会话持久化文件`、`在当前会话里没有找到匹配的 subagent 调用`、`索引越界`、`省略前面 M 步` 等）——LLM 读得懂即可，不为终端用户展示。**测试**：新增 `test/subagent/transcript.test.ts`（52 项单测，覆盖 `getContextWindowFor` / `parseSubagentEntries` / `pickSubagentEntry` / `renderTranscript` / `handleTranscript` / `appendUsageLines` / `aggregateUsageToUsage` / `usageLine` / `formatTokens` / `previewToolCallArgs` / `previewTextBlock` / `isInterruptedEntry` + 一个「export surface audit-trail」grep 测试，所有新 export 钉死）；L4 manifest 测试在已有 it() 块内新增 8 个语义 token 断言（install + upgrade 各 4 个：锚定 `aggregateUsageToUsage` / `appendUsageLines` / `renderTranscript` 三个 export + `cost.total` 路径必须触达）——这是 [[conventions/release-verification.md]]「功能语义锚定」正面的**第四种形式**（锚定 LLM 面向的能力契约，而非清单 / 模块结构 / 字节布局，未来重构友好）。`test/install/core-extension-manifest.test.ts` 与 `test/upgrade/manifest.test.ts` 的覆盖从此是「字节级落盘 + 关键常量存活 + 语义 token」三层叠加，单测与 L4 分工互补——单测锁字节布局，L4 锁语义。**测试数**：143 → 195（+52 单测），L4 新增 8 个语义 token 断言不计入 it() 计数。**发布同步**：`package.json` 与 `assets/.pi/assets-version.txt` 同步从 `0.3.1` 升到 `0.3.2`——本次**真实 bump** `assets-version.txt` 是因为 `assets/.pi/extensions/subagent/index.ts` 内容改了（新增 usage surfacing 与 transcript 两块），与 ADR [[architecture/decisions/0001-pisquad-cli.md]] 第 7 条「CLI 版本 vs assets 版本独立」一致；不新开 ADR——纯增量功能挂在 ADR [[architecture/decisions/0004-subagent-suspension-arbitration.md]] 的 subagent 裁决协议同主题下。**没有修改** ADR 0004 文案——usage surfacing 与 transcript 是「裁决协议执行后的可观测性增强」，不是裁决协议本身的变化，混进 ADR 会把「判定 idle 与否」的语义冲淡；保留 ADR 文案稳定，仅在「已就绪能力」与本条目披露。
- 0.3.1 修复（返工）— bash-guard 同步清单遗漏 + L4 发布验证门：0.3.0 引入 `bash-guard` 为 core 扩展，但 `src/commands/upgrade.ts` 的 `includes` 数组（upgrade diff 清单）漏加 `.pi/extensions/bash-guard`，**`src/lib/plugins/core.ts` 的 `EXTENSION_DIRS`（install 清单）已加**。结果：走 `pisquad install --yes` 的消费者拿到 `bash-guard`、走 `pisquad upgrade` 的消费者拿不到——子 agent 系统提示丢失默认值 Runtime note + bash `tool_result` 不再追加 timeout 提示面，silent degradation。**返工后的修复**（从「单点补丁」升级到「单源派生」，根本消除两份清单漂移风险）：①`src/lib/plugins/core.ts` 的 `EXTENSION_DIRS` 从内部常量改为 **`export const`**；②`src/commands/upgrade.ts` 直接 `import { EXTENSION_DIRS }` 并在构造 `includes` 时 `...Array.from(EXTENSION_DIRS).map((sub) => ({ pkgSubPath: `.pi/${sub}`, targetSubPath: `.pi/${sub}` }))` 派生 upgrade 清单——install / upgrade 两路从同一份源派生，新加 core 扩展只需改一处。**测试侧**：①`test/upgrade/decision.test.ts` 的 `MANAGED_INCLUDES` 同步改成 `Array.from(EXTENSION_DIRS).map(...)`，**从生产 import**（不再是镜像硬编码）；②新增 `test/upgrade/manifest.test.ts`：端到端断言 upgrade 命令后所有 core 扩展（derived from `EXTENSION_DIRS`）落盘 + `bash-guard` 关键常量存活，与 install 侧测试镜像——regression：把 `bash-guard` 从 `EXTENSION_DIRS` 摘掉，install + upgrade 两侧断言同步翻红。**L4 fresh-build 守门**：`package.json` 加 `"pretest": "npm run build"` 钩子，确保 `dist/bin.js` 是 fresh build，`test/install/core-extension-manifest.test.ts` 的「refuse-to-fallback-to-tsx」检查才有意义——改 src 不 build 就跑测试立刻踩雷。**L4 验证门**全过：install + upgrade 两侧端到端断言三扩展落盘 + `DEFAULT_BASH_TIMEOUT_S` 常量存活；`npm pack --dry-run` 内容清单仍符合预期（`dist/`、`assets/`、`README*.md`、`LICENSE`、`pisquad`；不含 `src/`、`node_modules/`、`.pi/`、根 `docs/`）；测试 143/143（0.3.0 基线 140 + install L4 +1 + upgrade L4 +2）。**教训**：测试 fixture 不得硬编码镜像生产清单——必须从生产 export / 断言两端一致 / 走 e2e 任一形式，fixture 过旧即丢失 red/green 信号，本 bug 正是因此逃逸单测层；详见 [[conventions/release-verification.md]] 反模式章节。0.3.0 → 0.3.1 为最小颗粒 hotfix：bump `package.json` + `core.ts`（加 `export`）+ `upgrade.ts`（从 #1 派生）+ `decision.test.ts`（fixture import）+ 新增 `test/upgrade/manifest.test.ts` + `pretest` 钩子，`assets-version.txt` 不动，印证 ADR [[architecture/decisions/0001-pisquad-cli.md]] 第 7 条「CLI 版本 vs assets 版本独立」的价值。
- 发布 `@nicklin/pisquad@0.3.0`：新增 `bash-guard` 扩展（`bash` 兜底 300s 默认超时 + 提示面三件套：`tool_result` 事实追加 / 子 agent systemPrompt Runtime note / `SUBAGENT_DESCRIPTION` 委派提示），`subagent` 新增 idle 挂起裁决协议（SIGSTOP 冻结整组 + `inspect` / `resume` / `kill` 互斥裁决 + 深树信号覆盖 `setsid` 孙进程）；测试 140/140（10 个协议 e2e 场景 + 18 个 bash-guard 提示面），详见 ADR [[architecture/decisions/0004-subagent-suspension-arbitration.md]]
- bash 超时提示三件套：补齐「默认值被认知」——背景是 pi 内置 `bash` 参数描述声称 `no default timeout` 与 bash-guard 实际注入的 300s 默认值矛盾。修复三面：①bash-guard `tool_result` 仅当「注入过默认值 && isError && 文本含 timeout 迹象」时向 `content` 追加一行事实说明（指出默认值已生效、如何显式传 `timeout`），partial patch 只动 `content`，`isError`/`details`/`usage` 不动，call id 立即清出 map 不泄漏；②subagent 给每个子 agent 的 systemPrompt 追加 Runtime note（默认值来自 `resolveDefaultTimeoutS()`，与 `BASH_GUARD_DEFAULT_TIMEOUT_S` env 覆写一致），无 systemPrompt 的 agent 也生成只含说明的 tmp 文件；③`SUBAGENT_DESCRIPTION` 补一句——委派长命令时主 agent 应指示子 agent 显式传 `timeout`。**不做** bash 工具全量覆盖：`getAllTools()` 无 `execute` 句柄、无法安全委托执行，partial-patch 契约只覆盖 `tool_result`，三面已足以让默认值得以被感知。测试 +18（新增 `test/subagent/bash-guard.test.ts`），总数 122 → 140。详见 ADR [[architecture/decisions/0004-subagent-suspension-arbitration.md]] §1「提示面」
- subagent 挂起裁决协议 + bash 默认超时：新增 `bash-guard` 扩展（兜底 300s 默认超时，env `BASH_GUARD_DEFAULT_TIMEOUT_S` 覆写，显式传值原样尊重）；`subagent` 新增 idle 挂起裁决（`SUBAGENT_IDLE_TIMEOUT_MS=600s`，默认路径下 600>300 保证 idle 永不被误触发）——stdout 无 NDJSON 事件 → SIGSTOP 冻结进程组 → 工具提前返回纯事实快照（`status:idle_suspended` + `suspensionId` + `idleMs` + `runningCommand` + `requestedTimeout` + `tail`，故意不设 `isError`、无 hint），由主 agent 用 `inspect` / `resume` / `kill`（互斥、`suspensionId` 寻址）裁决；AbortSignal 挂起中不响应、父进程 exit/SIGINT/SIGTERM best-effort 清扫、parallel 多挂起按 id 寻址不按下标；**深树信号覆盖**：孙进程跨 pgid（`setsid` / `nohup` / `disown`）的冻结 / 解冻 / kill 补全（`collectDescendantPids` 走 `/proc/<pid>/stat` ppid 映射 BFS 收集下游，组级信号后按叶→ 根顺序逐个信号；live E2E 验证孙 STAT=T 冻结 / 解冻 / 死透，孤儿归零）；107 项测试全过（9 个协议 e2e 场景），fake pi shim 无 LLM 依赖；Windows 降级（无 SIGSTOP → 看门狗直接杀整树不进裁决）；开发事故沉淀：kill 后 close 事件曾被误读为 chain 续跑信号，修复建立三层防线（Jest 120s + runDriver 60s 杀进程组 + afterEach 扫描残留）。详见 ADR [[architecture/decisions/0004-subagent-suspension-arbitration.md]]
- 发布 `@nicklin/pisquad@0.2.1`：取消 edit 二次确认（`waitForUserInput: false`），editor 默认内容改为 git-merge conflict marker 格式（`<<<<<<< current` / `=======` / `>>>>>>> incoming`）并增加 validate 拦截未清除标记，postfix 动态化（扩展名/dotfile/.txt 回退）；`writeState()` 自动创建 `.pi/.pisquad/.gitignore` 排除 `backups/`；移除 bash bootstrap 脚本及 `curl | bash` 安装入口
- 发布 `@nicklin/pisquad@0.2.0`：subagent 扩展新增 `tools_deny` 黑名单模式（agent 不写 `tools:` 白名单时默认获得全部工具，只排除 `tools_deny` 列出的）和 `tools:` 前缀通配符支持（如 `codegraph_*`）；scout / planner / reviewer 改用 `tools_deny: write, edit` 自动获得所有 codegraph 工具；`subagent` 工具默认禁止递归委派；修复空集回退全工具提权漏洞；planner 回归修复（旧配置无 bash，新 deny 补上）。升级路径：`pisquad upgrade` 交互式逐文件 adopt/keep/edit
- TUI 统一英文（新增 [[conventions/tui-language.md]] 约定）+ per-file diff 着色（`+` 绿 / `-` 红 / hunk `@@` 青 / 文件头 `+++`/`---` 灰，header 仍走 `logger.info` cyan 与原行为对齐）
- 交互式 upgrade 选 UI 从 `expand` 迁移到 `select`（箭头键 + Enter）：与 `install` 的箭头式 UX 对齐；批量功能从 r/t 快捷键改为 `Separator` 分组的列表选项（`Adopt all remaining (N)` / `Keep all remaining (N)`）；哨兵值 `__adopt-all` / `__keep-all` 与决策层契约不变；仅影响 `src/upgrade/decision-defaults.ts`，测试零改动、42 测试全过、tsup 构建成功。背景与契约见 ADR [[architecture/decisions/0003-interactive-upgrade.md]]
- 修复 upgrade 交互式判定 bug：`shouldPrompt` 此前用 `interactive === false` 判断 opt-out，与 `upgradeCommand` 把 `options.interactive === true` 收窄传入后，未传 flag（absent）会被误判为 opt-out，导致 absent flag + tty 走 all-adopt 而非 per-file，违背 ADR [[architecture/decisions/0003-interactive-upgrade.md]] §5「有 tty 且未传 flag → 走交互」。修复后 `shouldPrompt` 复用 `interactiveSetByUser` 区分「显式 `--no-interactive`」与「未传 flag」，未传 flag 时回退到 `isInteractiveEnv`（tty）判定；42 测试全过、新增 4 个覆盖 §5 矩阵，dist 重建
- 交互式 upgrade 实现完成（task 15）：管理区/交互区按目录白名单拆分（`docs/**` + `.pi/agents/**` + `.pi/skills/**` vs `.pi/extensions/**`）；决策层独立、纯协调、deps 注入；`$EDITOR` 方案 A 合并（不做三方 merge base）；无 tty / CI / `curl | bash` 退化为 all-adopt+备份；38 项测试全过、tsup 构建成功。决策与影响见 ADR [[architecture/decisions/0003-interactive-upgrade.md]]
- 发布 `@nicklin/pisquad@0.1.1`：修复 upgrade 的 self-update 死循环（0.1.0 在全局已是最新时无限 `npm i -g` 并提示重跑）；改为 self-update 前 `npm view` 比版本，已是最新则跳过、继续 project 同步
- 包名改 scoped `@nicklin/pisquad`：unscoped `pisquad` 因 npm 包名相似性规则（与现有 `pi-squad` 冲突）被拒，改 scoped；bin 命令名保持 `pisquad` 不变
- pisquad CLI 化完成：14 个 task 全部 done，`npm i -g @nicklin/pisquad` 主路径，`pisquad upgrade` 配 docs 备份恢复
- 文档全面同步：`docs/architecture/overview.md` 反映 CLI 化；ADR `0001-pisquad-cli.md`、`conventions/install-state.md` 配套落地；`assets/docs/` 作为通用模板骨架与项目 `docs/` 独立维护
- 全面 e2e 验证通过：self-install / install --all / upgrade 备份 docs/README.md / 无 tty exit 0 / `npm pack --dry-run` 内容清单符合预期
- `current-state.md` 改为通用模板，移除本仓库进度记录
- 将发布物移入 `assets/`，根目录退污染