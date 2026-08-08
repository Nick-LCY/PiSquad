---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：13 · 文档全面同步

> 阶段 3 · 文档与发布

## 目标

完成 CLI 化对**文档库**的全面同步：更新 `architecture/overview.md` 的安装器段、更新 `current-state.md` 的看板（已在前置步骤完成一部分，本任务做最终态校验）、README 增补 Upgrade safety 段；并**把 `docs/` 镜像到 `assets/docs/`**（worker 跨 `assets/` 操作）。

## 完成标准

- [ ] `docs/architecture/overview.md`：
  - 「概述」段关于安装器的描述从「`pisquad` 安装器（推荐）：支持 `curl | bash` 一键安装」改为「`pisquad` CLI（推荐）：`npm i -g pisquad`；也兼容 `curl | bash`」
  - 关键决策段补一条：pisquad 已从 bash 安装器升级为 npm CLI（指向 [[architecture/decisions/0001-pisquad-cli.md]]）
- [ ] `README.md`：
  - 增补 Upgrade safety 段：解释 backup 机制、`state.json` 用途、误改 docs 的恢复方式（手工 `tar xzf`）
  - 链接到 [[conventions/install-state.md]]
- [ ] **`assets/docs/` 镜像**：
  - `assets/docs/architecture/overview.md` 同步仓库根 docs 的更新
  - `assets/docs/architecture/decisions/0001-pisquad-cli.md` 镜像
  - `assets/docs/conventions/install-state.md` 镜像
  - `assets/docs/current-state.md` 镜像（**注意**：`assets/docs/current-state.md` 是消费者那边的看板入口；保留本任务之前的看板内容即可，文档库的状态变更不传染给消费者）
  - 镜像时仅镜像**结构与文件存在**，不镜像消费者相关的私有内容；如有不一致，本任务统一为「消费者视角」
- [ ] **不**做 `assets/docs/` ↔ `docs/` 的自动同步脚本（PRD 非目标第 4 条；保持手工约定）
- [ ] 本任务结束后，跑 `pisquad install` 在一个临时目录应能把上述 `assets/docs/` 内容铺平

## 依赖

- 11 · upgrade 命令
- 12 · CLI 自更新