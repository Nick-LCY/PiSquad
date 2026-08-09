---
prd: ../prds/pisquad-cli.md
status: done
---
# 任务：15 · 交互式 upgrade

> 阶段 4 · 交互式 upgrade 增强

## 目标

把 `pisquad upgrade` 从「一刀切备份 + 覆盖」升级为「对用户可编辑区做交互式决策」：用户在 upgrade 时可以逐文件选择「采用新版本 / 保留本地 / 编辑合并」，管理区（TS 代码）保持自动覆盖 + 备份。配套 ADR [[architecture/decisions/0003-interactive-upgrade.md]]。

## 完成标准

- [x] **决策层（纯协调，deps 注入）**
  - [x] `src/upgrade/decision.ts` 新增 `resolveUpgradeActions(input, deps)`，不直接调 `@inquirer/prompts` / `spawn` / `fs`
  - [x] 复用 `SelfUpdateDeps` 桩模式，所有外部能力经 `DecisionDeps` 注入
  - [x] 返回 `{ actions, summary }`，纯函数可单测
- [x] **adapter（默认 DecisionDeps 拼装）**
  - [x] `src/upgrade/decision-defaults.ts` 新增 `buildDefaultDecisionDeps()`
  - [x] 接入 `@inquirer/prompts` 的 `expand`（策略选择 + 单文件 adopt/keep/edit + 批量快捷键）
  - [x] 接入 `editor`（`$EDITOR` → `$VISUAL` → `vi` 兜底）
  - [x] 接入 `diff -u` 展示差异；`which("diff") === null` 时 `readFileSync` fallback
- [x] **范围划分（按文件性质，目录白名单）**
  - [x] `PkgInclude.interactive?: boolean` 字段（向后兼容，未标注视为 false）
  - [x] 交互区：`docs/**`、`.pi/agents/**`、`.pi/skills/**`
  - [x] 管理区：`.pi/extensions/**`（保持自动覆盖 + 备份）
- [x] **交互入口三档（全局策略）**
  - [x] `[1] 全部采用新`（默认） / `[2] 全部保留旧` / `[3] 逐个决定`
  - [x] per-file 决策：modified = A/K/E；added = A/K；removed = 仅 `--prune` 时 A/K
  - [x] 批量快捷键「剩余全部采用 / 剩余全部保留」
- [x] **per-file diff 展示**
  - [x] 逐个决定时，先 `renderUnifiedDiff(旧, 新)` 再进入 prompt
  - [x] `diff -u` 不可用时 fallback 到 `readFileSync` 全文对照
- [x] **`$EDITOR` 方案 A（merge）**
  - [x] 打开目标旧文件 + 展示新版本参照
  - [x] 编辑返回空串 → keep 兜底
  - [x] 编辑后 hash == 新版本 hash → 标记 `matchesTheirs = merged`，按「采用新」处理
  - [x] **不**做三方合并（不拉 git merge base，不引入旧 npm merge 包）
- [x] **触发与非交互退化**
  - [x] 有 tty + 用户未指定 flag → 交互
  - [x] 无 tty / CI / `curl | bash` → 退化为「全部采用新 + 备份」（exit 0，**不卡死**）
  - [x] `--interactive` / `--no-interactive` 显式覆盖
  - [x] `--interactive` 在无 tty 时 warn 提示已退化
- [x] **命令表面**
  - [x] `src/main.ts`：`upgrade` 子命令加 `--interactive` / `--no-interactive`
  - [x] 区分 `interactive`（最终行为）与 `interactiveSetByUser`（用户是否显式指定）
- [x] **错误处理**
  - [x] `@inquirer/core` 的 `ExitPromptError` 区分「真取消」vs「真异常」
  - [x] 决策层 try/catch 与 apply 阶段 try/catch 相互独立
  - [x] 用户 Ctrl-C → 无 backup 残留，exitCode=1
  - [x] `createBackup` 失败 → 干净退出（exitCode=1），**不**进 copy
- [x] **dry-run**
  - [x] 不弹 prompt 但预算决策
  - [x] 打印「Would adopt:N / keep:M / edit:E / backup:B / remove:R」
  - [x] plan 整体为空时短路退出
  - [x] **绝不写 backup**
- [x] **state.json partial apply 语义**
  - [x] 部分文件被保留时，`state.version` 仍写新 assets 版本
  - [x] warn「kept N user modification(s) — they will reappear in next upgrade's diff」
  - [x] state 不反映逐文件一致性（下次 upgrade 这些文件会再次以 modified 出现）
- [x] **测试覆盖**
  - [x] 38 项测试全过（含决策层纯函数单测 + 端到端决策流）
  - [x] tsup 构建成功

## 主流程顺序（14 步）

`src/commands/upgrade.ts`：

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

**关键不变量**：`决策(7) → backup(8) → copy(9) → edit 写回(10) → prune(11)`。

## 依赖

- 09 · diff 与 backup lib
- 11 · upgrade 命令完整逻辑（安全机制）
