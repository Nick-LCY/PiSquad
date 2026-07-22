# 系统总览：Pi 开发基础

本项目是一个可复用的、基于 pi 的开发基础底座。目标是拷贝到任意新项目即获得一套完整的多代理开发工作流。

## 四层架构

| 层 | 组件 | 职责 |
|----|------|------|
| 记录层 | entire | 对话 ↔ commit 关联追踪，可回溯 / rewind |
| 代码层 | codegraph | 代码符号索引，快速定位 + 影响分析 |
| 工作流层 | agents | scout → planner → worker → reviewer → archivist 多代理协作 |
| 知识层 | docs（本目录）+ skills | 结构化文档，渐进式披露 |

层与层协同：archivist 把开发结论沉淀进文档时，entire 保证它可追溯到那次对话与 commit。

## 开发流（文档驱动）

```
prds/<feature>.md        需求设计
    │  planner 读取并拆分
    ▼
tasks/<feature>/*.md     拆出的任务 [todo]
    │  worker 各自领取
    ▼  doing → done
    │  archivist 同步
    ▼
current-state.md         进度看板
```

## Agent 角色分工

| 角色 | 职责 | 工具 |
|------|------|------|
| scout | 侦察代码，返回压缩上下文 | read, bash, grep, find, ls |
| planner | 读 PRD，拆分任务，只读规划 | read, grep, find, ls |
| worker | 执行单个 task | 全部 |
| reviewer | 审查产出 | read, grep, find, ls, bash(只读) |
| archivist | 维护 current-state，流转状态，沉淀决策 | read, write, edit, ls, grep, find |

## 设计原则

- **结构即导航**：不引入检索，靠目录树表达语义，agent 用 ls/read 下钻。
- **渐进式披露**：每层只暴露摘要 + 入口，避免一次性灌满上下文。
- **文档即代码**：所有知识随仓库走，可追溯。
