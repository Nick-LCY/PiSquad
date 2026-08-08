---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：02 · bash bootstrap

> 阶段 1 · MVP

## 目标

把仓库根 `pisquad` 文件从「单文件 bash 安装器」改写为「极简 bash bootstrap」：检测 node → 转发到全局 `pisquad`（若已装）或 `npx pisquad@latest`。总行数控制在 30 行以内，逻辑只做转发，**不做任何安装逻辑**。

## 完成标准

- [ ] 仓库根 `pisquad` 文件存在且可执行（`chmod +x`）
- [ ] 脚本行为：
  - 检测 `node` 是否在 PATH；若不在，打印明确错误并以非零退出（不静默继续）
  - 若 `command -v pisquad` 命中 → 调用 `pisquad "$@"`
  - 否则调用 `npx -y pisquad@latest "$@"`
- [ ] 转发时透传所有参数（`"$@"`），包括 `--help` `--version` `--yes` `--with` `--without` `--all` `--prune` `--no-self` 等
- [ ] 脚本顶部含 shebang `#!/usr/bin/env bash` 与 `set -euo pipefail`
- [ ] `curl ... | bash` 形式能跑通（用 `set -x` 或显式 echo 验证转发链）

## 依赖

- 01 · 包脚手架