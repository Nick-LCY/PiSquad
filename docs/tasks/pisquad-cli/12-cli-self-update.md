---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：12 · CLI 自更新

> 阶段 2 · upgrade 全套

## 目标

实现 `pisquad upgrade` 的 CLI 自更新阶段：先更新 CLI 工具自身（全局 npm 包），再继续 project 同步。若自更新失败则中止，不继续 project 部分。

## 完成标准

- [ ] `src/upgrade/self.ts`：
  - `selfUpdate({ logger })`：检测当前 `pisquad` 是否来自全局 npm（`which pisquad` 命中且路径在 npm 全局目录下）；若是 → 跑 `npm i -g pisquad@latest`
  - 失败处理：`npm i` 退出非零 → 抛错，**不调用 project 同步**
  - 跳过条件：`--no-self` flag 或环境变量 `PISQUAD_NO_SELF=1`
  - 检测来源：若 `pisquad` 不在 npm 全局目录（如 npx 临时安装或本地开发模式）→ 打印「CLI not from global npm, skipping self-update」并直接返回
- [ ] `commands/upgrade.ts` 接入：在 `readState` 之前先调 `selfUpdate`；自更新成功后再继续 project 同步
- [ ] 退出码：自更新失败 → 退出非零且不写 state、不拷贝任何文件
- [ ] `--no-self` 验证：传 `--no-self` 时跳过自更新
- [ ] 不引入 npm 锁文件污染用户全局（`npm i -g pisquad@latest` 不写本仓库锁文件）

## 依赖

- 11 · upgrade 命令