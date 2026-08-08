---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：08 · README 基础更新

> 阶段 1 · MVP

## 目标

更新仓库根 `README.md`，把安装/使用从「`curl | bash` 单文件 bash 安装器」改成「npm CLI 主推 + curl|bash 兼容入口」。本任务只覆盖 13（文档全面同步）的「安装与命令」部分，docs 库的镜像留到 13。

## 完成标准

- [ ] Quick Start 段：
  - **主推**：`npm i -g pisquad` + `pisquad install .`
  - **兼容**：`curl -fsSL ... | bash` 一行仍可工作（链接指向 release tarball 或 git raw）
- [ ] Commands 段列出：
  - `pisquad`（默认 install）
  - `pisquad install [path]` + flags 表
  - `pisquad upgrade [path]`（**占位说明**：阶段 2 落地）
  - `pisquad version`
  - `pisquad help`
- [ ] Project Structure 段列出新增的 `src/` `dist/` `package.json` `tsconfig.json` `tsup.config.ts` `.npmignore`（其中 `dist/` 标 gitignored）
- [ ] 旧的「Installation」段里关于 bash 选择菜单、`< /dev/tty` 行为的描述全部移除或改为新流程的注脚
- [ ] 双语（中文 + 英文）保持现状风格，本任务不破坏既有结构

## 依赖

- 07 · install 命令