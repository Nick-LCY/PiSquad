# 0003. upgrade 引入交互式决策层（管理区 / 交互区拆分）

- 日期：2026-02
- 状态：已接受

## 背景

ADR [[architecture/decisions/0001-pisquad-cli.md]] 第 8 / 9 条确立了「upgrade 安全机制」与「docs 纳入 diff」：

- 升级时用 sha256 diff 检测用户改过的文件，**覆盖前先 tar.gz 备份**到 `<target>/.pi/.pisquad/backups/`
- `docs/` 走「改了→备份+覆盖」流程
- 旧项目必须重新 install（不向后兼容）

但「一刀切备份 + 覆盖」对用户高频修改区过于粗暴：用户写了一夜的 README.md 被无声覆盖；新模板提供的小改进也无法被本地采纳。PRD [[prds/pisquad-cli.md]] §6 明确要求把 upgrade 升级为「对用户可编辑区做交互式决策」。

本次需求落地的核心是：给 upgrade 增加一个**独立的决策层**，让「用户怎么对待每条 diff」成为可控选择，同时不破坏 0.1.1 已经稳下来的「非交互不卡死 + 备份保护」契约。

## 决策

### 1. 范围划分（按文件性质，目录白名单判定）

- **交互区**（用户语义内容，走决策层）：`docs/**`、`.pi/agents/**`、`.pi/skills/**`（全部 .md）
- **管理区**（TS 代码，保持自动覆盖 + 备份）：`.pi/extensions/**`
- **落地方式**：给 `src/lib/diff.ts` 的 `PkgInclude` 列表每项加 `interactive?: boolean` 标签（向后兼容，未显式标注视为 `false`）。`src/commands/upgrade.ts` 按此标签分流：`interactive=true` 走决策层，`false` 走原 backup + overwrite 流程。

> 为什么不用扩展名自动判：扩展名 `md` 既出现在交互区，也可能出现在框架内部扩展（如未来 `extensions/foo/README.md`）。显式目录白名单可控、可审、可测。

### 2. 决策层独立、纯协调、deps 注入

- 新增 `src/upgrade/decision.ts`：`resolveUpgradeActions(input, deps) -> { actions, summary }`
  - **不直接调** `@inquirer/prompts` / `spawn` / `fs`；所有外部能力（prompt / editor / diff）通过 `DecisionDeps` 注入
  - 复用 [[architecture/decisions/0002-self-update-version-check.md]] 的「`SelfUpdateDeps` 桩模式」做可测性
- 新增 `src/upgrade/decision-defaults.ts`：`buildDefaultDecisionDeps()`
  - 接入 `@inquirer/prompts` 的 `select`（策略选择 + 单文件 adopt/keep/edit + 批量分组，通过 Separator 与基础选项分隔）
  - 接入 `editor`（编辑旧文件，`$EDITOR` → `$VISUAL` → `vi` 兜底）
  - 接入 `diff -u` 展示新旧差异；`which("diff") === null` 时回退到 `readFileSync` 全文对照
- 决策层与执行（backup / copy / prune）解耦：执行阶段按 decision 行动，而非按 diff 全量

### 3. 交互入口三档（全局策略）

- **`Adopt new (default)`**（默认）：所有交互区文件按新版本覆盖；管理区照旧
- **`Keep mine`**：所有交互区文件保留本地版本；管理区照旧
- **`Per-file`**：每个交互区文件**先展示 unified diff 再选择**

每文件选项：

| 文件类型 | 选项 |
|---|---|
| modified | `Adopt`（采用新） / `Keep`（保留旧，默认） / `Edit`（编辑旧文件并展示新版本参照） |
| added | `Adopt` / `Keep`（不要） |
| removed | 仅 `--prune` 时进 prompt：`Adopt`（删除） / `Keep`（保留）；非 prune 时**自动 keep，不打扰** |

> modified 单文件默认高亮 keep（保守保护用户本地修改）。`select` 通过将 `default` 与 `choice.value` 匹配（`@inquirer/select` 的 `findIndex((item) => item.value === config.default)`）定位高亮项，因此决策层传 `defaultValue`（即某个 choice 的 `value`）而非索引；renderer 据此渲染，无需在 choice name 末尾追加 `(default)` 后缀。

逐个模式下支持**批量分组**：在 select 选项列表中以 `Separator` 分隔，cursor 可直接跳到批量组（`Adopt all remaining (N)` / `Keep all remaining (N)`），无需通过单字符快捷键命中。

### 4. merge 走 `$EDITOR` 方案 A

用户选 `Edit`（choice value `"edit"`）→ 用 `$EDITOR`（fallback `$VISUAL` → `vi`）打开目标旧文件并展示新版本参照：

- 编辑返回空串 → keep 兜底（保护用户不会因误清空文件丢失内容）
- 编辑后内容 hash 与新版本一致 → 标记 `matchesTheirs = merged`，下游按「采用新」处理（避免再次重复 prompt）
- **不做真正的三方合并**：不拉 git merge base，不引入旧 npm merge 包。理由：成本高、对一次性安装流程过度设计；`$EDITOR` 已给用户保留「自己合并」的入口

### 5. 触发条件与非交互退化

- 有 tty **且**用户未指定 `--interactive` / `--no-interactive` → 走交互
- 无 tty / `CI=true` / `curl | bash` → **退化为「全部采用新 + 备份」**（即 0.1.1 现状，`exit 0`，**绝不卡死**）
- `--interactive` / `--no-interactive` 显式覆盖；**`--interactive` 在无 tty 时会 warn 提示已退化**（不静默失败）

## 影响

### 命令表面

- `pisquad upgrade` 新增 `--interactive` / `--no-interactive` flag
- 区分 `interactive`（最终行为）与 `interactiveSetByUser`（用户是否显式指定）；前者由后者与 tty 推导

### state.json 语义（partial apply）

部分文件被用户保留时：

- `state.version` **仍然写新 assets 版本**（不是「只升级采纳的部分」）
- 不引入「逐文件一致性」字段——state 是版本快照，不是审计日志
- **warn** 输出：「kept N user modification(s) — they will reappear in next upgrade's diff」
- 下次 upgrade 这些被保留的文件会再次以 modified 出现

详见 [[conventions/install-state.md]] 「用户规则」段。

### dry-run 行为

`--dry-run` 不弹 prompt，**但仍预算决策**：

- 打印「Would adopt:N / keep:M / edit:E / backup:B / remove:R」
- plan 整体为空时短路退出
- **绝不写 backup**（dry-run 不污染 backups/）

### 错误处理边界

用 `@inquirer/core` 的 `ExitPromptError` 区分两类失败：

- **真取消**（用户 Ctrl-C / 主动退出决策）：**无 backup 残留**（决策层先于 backup，抛错时 backup 尚未触发），`exitCode=1`
- **真异常**（decision / apply 任一阶段抛错）：`exitCode=1`，已备份归档保留（不删）

### 主流程顺序（14 步）

`src/commands/upgrade.ts` 演进为：

1. `resolveTarget`
2. `selfUpdate`
3. `readState`
4. `readAssetsVersion` / `readCliVersion`
5. `diffTree`
6. 拆分交互区 / 管理区子集（按 `PkgInclude.interactive`）
7. **决策层 `resolveUpgradeActions`**（交互区子集；非交互 / `--no-interactive` 时返回 all-adopt）
8. **backup**（决策中标记会覆盖的 + 管理区 modified）
9. **copy**（按 decision 写盘）
10. **edit 写回**（decision 中 edit 的文件用编辑器结果覆盖）
11. **prune**（`--prune` 才走）
12. `writeState`
13. `codegraph npm install`（若变更）
14. 打印汇总

**关键不变量**：`决策(7) → backup(8) → copy(9) → edit 写回(10) → prune(11)`。决策层 try/catch 与 apply 阶段 try/catch 相互独立，确保用户 Ctrl-C 时无半成品 backup 残留；`createBackup` 失败也干净退出（`exitCode=1`，不进 copy）。

## 已知限制

- **dry-run 不跳 selfUpdate**：pre-existing，非本次引入。`selfUpdate` 已有「已是最新则跳过」保护（见 ADR [[architecture/decisions/0002-self-update-version-check.md]]），dry-run 测试用 `--no-self` 规避。e2e 层面无影响。
- **`keptInteractive` 统计在 2 个边角略偏低估**：
  - per-file 空 editor 结果（用户清空文件 → keep 兜底）
  - batch adopt 命中 removed + !prune 的情形
  - 语义无害（仅影响 summary 数字，不影响实际行为）
- **`renderUnifiedDiff` 在 `which("diff") === null` 时回退为 readFileSync 全文并列**：纯 fallback，保证行为不退化；视觉上不如 `diff -u`，仅极端环境触发
- **首次实现 vs 设计意图的偏差（已纠偏）**：原 `shouldPrompt` 用 `interactive === false` 判断 opt-out，但 `upgradeCommand` 把 `--interactive / --no-interactive` 的 `undefined` 收窄为 `false` 后再传入决策层，导致「未传 flag」和「显式 `--no-interactive`」在该字段上无法区分，落到前者被误判为 opt-out，从而让 §5 「有 tty 且未传 flag → 走交互」的路径在 absent flag 场景下被绕过、`isInteractive()` 成死代码。修复：决策层改用 `interactiveSetByUser` 区分「显式 `--no-interactive`」与「未传 flag」，未传 flag 时回退到 `isInteractiveEnv`（tty）判定；`upgradeCommand` 的 `=== true` 收窄保留并加承重墙注释。语义与 §5 完全对齐。
- **实现层 UI 迁移：`expand` → `select`**：UX 改进把决策层以外仅 `src/upgrade/decision-defaults.ts` 受影响；adapter 从 `@inquirer/prompts` 的 `expand`（字母编码 `[1]/[2]/[3]`、`[A]/[K]/[E]`、批量快捷键 `r`/`t`）迁移到 `select`（箭头键 + Enter），与 `install` 的箭头式 UX 对齐。批量功能从单字符快捷键改为 `Separator` 分组的列表选项（`Adopt all remaining (N)` / `Keep all remaining (N)`）；哨兵值 `__adopt-all` / `__keep-all` 与决策层契约（`src/upgrade/decision.ts`）不变。`select` 通过 `default` 与 `choice.value` 匹配定位高亮项（见 §3），`decision-defaults.ts` 的 `defaultValue` 三元已对齐每个 `kind` 的 `baseChoices`；未来若新增 `FileKind` 或调整 choice 形状需同步 `defaultValue`，否则会静默 fallback 到首项。测试零改动（决策层 contract 不变），42 测试全过、`tsup` 构建成功。

## 任务

- 实现：[[tasks/pisquad-cli/15-interactive-upgrade.md]]
