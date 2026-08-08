# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 项目阶段

pi-squad 已基本成型、可用：多 Agent 协作、文档驱动、会话可追溯三件套均已就位，可经 `pisquad` 安装器或复制 `assets/` 直接落地。系统设计与组件职责见 [[architecture/overview.md]]。

## 已就绪能力

- **Agents（5）**：scout / planner / worker / reviewer / archivist，权限隔离、上下文独立
- **Skills（2）**：`project-docs`（文档库入口）、`workflow`（分工铁律）
- **Extensions（4）**：`subagent`（隔离委派）、`codegraph`（8 个代码图查询工具）、`entire`（会话事件桥接）、`wikilink-lint`（docs 链接硬约束）
- **docs 模板库**：结构即导航 + 渐进式披露的通用骨架
- **pisquad 安装器**：支持 `curl | bash` 一键安装
- **双语 README + MIT license**

## 活跃需求

- （无进行中的 PRD）

## 任务看板

| Task | 状态 | 备注 |
|------|------|------|
| 无进行中任务（工作树干净） | — | — |

## TODO / 阻塞

- 暂无

## 最近变更

- 搭建开发环境（`chore: setup development env`）
- `current-state.md` 改为通用模板，移除本仓库进度记录
- 将发布物移入 `assets/`，根目录退污染
- 支持 `curl | bash` 一键安装 `pisquad`
