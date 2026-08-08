# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 项目阶段

pi-squad 已基本成型、可用：多 Agent 协作、文档驱动、会话可追溯三件套均已就位，可经 `pisquad` 安装器或复制 `assets/` 直接落地。系统设计与组件职责见 [[architecture/overview.md]]。

> **变更中**：`pisquad` 安装器即将从 bash 单文件升级为 npm 全局 CLI（见活跃需求）。

## 已就绪能力

- **Agents（5）**：scout / planner / worker / reviewer / archivist，权限隔离、上下文独立
- **Skills（2）**：`project-docs`（文档库入口）、`workflow`（分工铁律）
- **Extensions（4）**：`subagent`（隔离委派）、`codegraph`（8 个代码图查询工具）、`entire`（会话事件桥接）、`wikilink-lint`（docs 链接硬约束）
- **docs 模板库**：结构即导航 + 渐进式披露的通用骨架
- **pisquad 安装器**：支持 `curl | bash` 一键安装（即将被 CLI 化取代，详见活跃需求）
- **双语 README + MIT license**

## 活跃需求

- [[prds/pisquad-cli.md]] — 把 `pisquad` 从 bash 安装器升级为 npm 全局 CLI；含 `upgrade` 安全机制、docs diff 备份、entire bug 修复。配套 ADR [[architecture/decisions/0001-pisquad-cli.md]] 与约定 [[conventions/install-state.md]]

## 任务看板

### pisquad-cli（PRD [[prds/pisquad-cli.md]]，ADR [[architecture/decisions/0001-pisquad-cli.md]]）

**阶段 1 · MVP**（能装能用）

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/01-package-scaffold.md` | todo | 包脚手架（package.json / tsconfig / tsup / npmignore） |
| `tasks/pisquad-cli/02-bash-bootstrap.md` | todo | bash bootstrap（仓库根转发脚本） |
| `tasks/pisquad-cli/03-cli-lib-foundation.md` | todo | CLI lib 基础（env / paths / ui / assets / copy / fs-safe） |
| `tasks/pisquad-cli/04-state-writer.md` | todo | state.json 写入子集 |
| `tasks/pisquad-cli/05-command-dispatch.md` | todo | 命令分发 + version / help / install 空壳 |
| `tasks/pisquad-cli/06-plugins-install.md` | todo | plugins 模块（**修整个 bug**） |
| `tasks/pisquad-cli/07-install-command.md` | todo | install 命令完整逻辑（**非交互不卡死**） |
| `tasks/pisquad-cli/08-readme-basics.md` | todo | README 基础更新（Quick Start / Commands / Structure） |

**阶段 2 · upgrade 全套**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/09-diff-and-backup.md` | todo | diff / backup lib（**docs 纳入 diff**） |
| `tasks/pisquad-cli/10-state-read-compare.md` | todo | state 读取与比较（**不向后兼容**） |
| `tasks/pisquad-cli/11-upgrade-command.md` | todo | upgrade 命令完整逻辑（安全机制） |
| `tasks/pisquad-cli/12-cli-self-update.md` | todo | CLI 自更新（`npm i -g pisquad@latest`） |

**阶段 3 · 文档与发布**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/13-docs-sync.md` | todo | 文档全面同步（overview / current-state / `assets/docs/` 镜像） |
| `tasks/pisquad-cli/14-e2e-and-publish.md` | todo | e2e 验证 + `npm pack` 内容检查 + publish 演练 |

## TODO / 阻塞

- 暂无

## 最近变更

- 规划 pisquad CLI 升级：新增 PRD `prds/pisquad-cli.md`、ADR `0001-pisquad-cli.md`、约定 `conventions/install-state.md`，并在 `tasks/pisquad-cli/` 下拆分 14 个任务（按阶段 1/2/3 分组，全 todo）
- 搭建开发环境（`chore: setup development env`）
- `current-state.md` 改为通用模板，移除本仓库进度记录
- 将发布物移入 `assets/`，根目录退污染
- 支持 `curl | bash` 一键安装 `pisquad`