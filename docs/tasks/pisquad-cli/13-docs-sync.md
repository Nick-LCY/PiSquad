---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：13 · 文档全面同步

> 阶段 3 · 文档与发布

## 目标

完成 CLI 化对**文档库**的全面同步：更新 `architecture/overview.md` 的安装器段、更新 `current-state.md` 的看板（已在前置步骤完成一部分，本任务做最终态校验）、README 增补 Upgrade safety 段；并**将关键文档落到 `assets/docs/`**（worker 跨 `assets/` 操作）。

> 说明：`assets/docs/` 已重构为通用模板骨架（零项目绑定），与本项目 `docs/` 独立维护；本任务的落地动作不构成此后两者的相互同步关系。

## 完成标准

- [ ] `docs/architecture/overview.md`：
  - 「概述」段关于安装器的描述从「`pisquad` 安装器（推荐）：支持 `curl | bash` 一键安装」改为「`pisquad` CLI（推荐）：`npm i -g @nicklin/pisquad`；也兼容 `curl | bash`」
  - 关键决策段补一条：pisquad 已从 bash 安装器升级为 npm CLI（指向 [[architecture/decisions/0001-pisquad-cli.md]]）
- [ ] `README.md`：
  - 增补 Upgrade safety 段：解释 backup 机制、`state.json` 用途、误改 docs 的恢复方式（手工 `tar xzf`）
  - 链接到 [[conventions/install-state.md]]
- [ ] **`assets/docs/` 落地**：
  - `assets/docs/architecture/overview.md` 随仓库根 docs 的更新落到对应版本
  - `assets/docs/architecture/decisions/0001-pisquad-cli.md` 落到对应版本
  - `assets/docs/conventions/install-state.md` 落到对应版本
  - `assets/docs/current-state.md` 落到对应版本（**注意**：保留当时的看板内容作为占位，后续不随本项目进度更新）
  - 落地时只取**结构与文件骨架**，不带本项目私有内容；如有不一致，以通用骨架版本为准
- [ ] **不**做 `assets/docs/` ↔ `docs/` 的同步机制（PRD 非目标第 4 条：`assets/docs/` 与 `docs/` 保持独立）
- [ ] 本任务结束后，跑 `pisquad install` 在一个临时目录应能把上述 `assets/docs/` 内容铺平

## 依赖

- 11 · upgrade 命令
- 12 · CLI 自更新