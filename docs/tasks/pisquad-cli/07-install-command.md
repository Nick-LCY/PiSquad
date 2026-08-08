---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：07 · install 命令完整逻辑

> 阶段 1 · MVP

## 目标

把 install 命令从空壳（05）实现为完整逻辑：参数解析 → channel 决策 → 拷贝 → 写 state → 汇总。把 06 的 plugins 串起来。

## 完成标准

- [ ] `src/commands/install.ts`：
  - 用 `commander` 注册：`pisquad install [path] [--yes] [--with a,b] [--without a,b] [--all] [--dry-run]`
  - 读取环境变量 `PISQUAD_WITH` `PISQUAD_WITHOUT`（03 的 `env.ts` 应已封装）
- [ ] install 主流程：
  1. `resolveTarget` 解析目录
  2. `readState`（即便 04 没实现，这里临时读：文件存在则读，否则 undefined）
  3. **若 state 已存在 → 报错并退出非零**，打印「已安装，请用 `pisquad upgrade`」（旧项目无 state 不会触发；新版用户必须走 upgrade）
  4. `decideChannels` 决策 channels
  5. `installChannels(target, channels, opts)`
  6. `writeState` 落盘
  7. 汇总输出：哪些 channel 装了、目标位置、state.json 路径
- [ ] **非交互不卡死验收**：`< /dev/null pisquad install --yes --with codegraph,entire <dir>` 退出码 0
- [ ] **interactive 走 prompt**：有 tty 且无 flag 时调 `@inquirer/prompts` checkbox 选 codegraph/entire
- [ ] `--dry-run` 模式：所有拷贝打印而不真写；state.json 不写；最终打印「DRY RUN — no changes made」
- [ ] 写 `.gitignore` 规则（若 `<target>/.gitignore` 存在且不含 `.pi/.pisquad/`，则追加；不存在则不创建）

## 依赖

- 04 · state 写入
- 05 · 命令分发
- 06 · plugins 安装模块