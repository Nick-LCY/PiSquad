---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：06 · plugins 安装模块（含 entire bug 修复）

> 阶段 1 · MVP

## 目标

把 `assets/.pi/` 下的 channel-specific 安装逻辑拆到 `src/lib/plugins/`，使 install 命令（07）按 channel 列表串起来。**本任务的关键是修 entire bug**。

## 完成标准

- [ ] `src/lib/plugins/core.ts`：
  - 导出 `installCore(target, opts)`：拷贝 `assets/.pi/agents/` `assets/.pi/skills/` `assets/.pi/extensions/subagent/` `assets/.pi/extensions/wikilink-lint/` 到 `<target>/.pi/...`
  - 拷贝 `assets/.pi/extensions/codegraph/`（**即便 codegraph channel 没勾，也保留目录，但 enable 跳过**——确保 `codegraph` 命令工具可被 pi 解析）
  - 实际策略：core 包含 **所有** extension 的**目录拷贝**，enable 钩子由各自 channel 决定；这样后续升级不会因目录缺失出问题
- [ ] `src/lib/plugins/codegraph.ts`：
  - 导出 `installCodegraph(target, opts)`：在 `<target>` 跑 `npm install` 安装本地 `codegraph` 包的依赖；记录到 state 的 `channels.codegraph = true`
- [ ] `src/lib/plugins/entire.ts`：
  - 导出 `installEntire(target, opts)`：
    1. **拷贝 `assets/.pi/extensions/entire/` 到 `<target>/.pi/extensions/entire/`**（修 bug）
    2. 在 `<target>` 跑 `entire enable --agent pi`（幂等）
    3. 记录到 state 的 `channels.entire = true`
  - 校验：勾选 entire 后 `<target>/.pi/extensions/entire/index.ts` 实际存在（**bug 修复验收**）
- [ ] `src/lib/plugins/index.ts`：
  - 导出 `installChannels(target, channels, opts)`：按 `[core, codegraph?, entire?]` 顺序串起来；任一失败抛错并退出非零
- [ ] 每个 plugin 函数接收 `opts: { dryRun?: boolean; logger: Logger }`，便于上层组合

## 依赖

- 03 · CLI lib 基础