# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 项目阶段

pi-squad 已基本成型、可用：多 Agent 协作、文档驱动、会话可追溯三件套均已就位，可经 `pisquad` CLI 安装或复制 `assets/` 直接落地。CLI 同时提供 install / upgrade / version / help 子命令，升级路径走 `pisquad upgrade`，文档修改走 tar.gz 备份保护。系统设计与组件职责见 [[architecture/overview.md]]。

## 已就绪能力

- **Agents（5）**：scout / planner / worker / reviewer / archivist，权限隔离、上下文独立
- **Skills（2）**：`project-docs`（文档库入口）、`workflow`（分工铁律）
- **Extensions（4）**：`subagent`（隔离委派）、`codegraph`（8 个代码图查询工具）、`entire`（会话事件桥接）、`wikilink-lint`（docs 链接硬约束）
- **docs 模板库**：结构即导航 + 渐进式披露的通用骨架
- **pisquad CLI**：npm 全局包，提供 `install` / `upgrade` / `version` / `help`；保留极简 bash bootstrap 兼容 `curl | bash` 入口
- **双语 README + MIT license**

## 活跃需求

- （无）

## 任务看板

### pisquad-cli（PRD [[prds/pisquad-cli.md]]，ADR [[architecture/decisions/0001-pisquad-cli.md]]）— ✅ 完成

**阶段 1 · MVP**（能装能用）

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/01-package-scaffold.md` | done | 包脚手架（package.json / tsconfig / tsup / npmignore） |
| `tasks/pisquad-cli/02-bash-bootstrap.md` | done | bash bootstrap（仓库根转发脚本） |
| `tasks/pisquad-cli/03-cli-lib-foundation.md` | done | CLI lib 基础（env / paths / ui / assets / copy / fs-safe） |
| `tasks/pisquad-cli/04-state-writer.md` | done | state.json 写入子集 |
| `tasks/pisquad-cli/05-command-dispatch.md` | done | 命令分发 + version / help / install 空壳 |
| `tasks/pisquad-cli/06-plugins-install.md` | done | plugins 模块（**修整个 bug**） |
| `tasks/pisquad-cli/07-install-command.md` | done | install 命令完整逻辑（**非交互不卡死**） |
| `tasks/pisquad-cli/08-readme-basics.md` | done | README 基础更新（Quick Start / Commands / Structure） |

**阶段 2 · upgrade 全套**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/09-diff-and-backup.md` | done | diff / backup lib（**docs 纳入 diff**） |
| `tasks/pisquad-cli/10-state-read-compare.md` | done | state 读取与比较（**不向后兼容**） |
| `tasks/pisquad-cli/11-upgrade-command.md` | done | upgrade 命令完整逻辑（安全机制） |
| `tasks/pisquad-cli/12-cli-self-update.md` | done | CLI 自更新（`npm i -g pisquad@latest`） |

**阶段 3 · 文档与发布**

| Task | 状态 | 备注 |
|------|------|------|
| `tasks/pisquad-cli/13-docs-sync.md` | done | 文档全面同步（overview / current-state / `assets/docs/` 镜像） |
| `tasks/pisquad-cli/14-e2e-and-publish.md` | done | e2e 验证 + `npm pack` 内容检查 + publish 演练 |

## TODO / 阻塞

- 暂无

## 最近变更

- pisquad CLI 化完成：14 个 task 全部 done，`npm i -g pisquad` 主路径 + `curl | bash` 兼容入口，`pisquad upgrade` 配 docs 备份恢复
- 文档全面同步：`docs/architecture/overview.md` 反映 CLI 化；`assets/docs/` 镜像关键文档（overview / decisions/0001 / conventions/install-state），消费者模板视角与仓库内开发进度解耦
- 全面 e2e 验证通过：self-install / install --all / upgrade 备份 docs/README.md / 无 tty exit 0 / `npm pack --dry-run` 内容清单符合预期
- `current-state.md` 改为通用模板，移除本仓库进度记录
- 将发布物移入 `assets/`，根目录退污染
- 支持 `curl | bash` 一键安装 `pisquad`