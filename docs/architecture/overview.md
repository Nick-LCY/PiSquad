# 系统总览

> 记录 pi-squad 的系统架构（稳定层，很少变更）。高频变化的工作看板见 [[current-state.md]]。

## 概述

pi-squad 是一套基于 pi coding agent 的可复用多 Agent、文档驱动开发底座 / 模板。它把主进程变成**纯编排者**，把所有真正读代码、写代码、维护文档的工作委派给一支各司其职的 agent 小队（scout / planner / worker / reviewer / archivist），并附带代码图查询、会话回溯、文档链接校验等能力。

它要解决的是：在 pi 这类 coding agent 上做稍大一点的项目时，单进程上下文很快被无关噪音填满，文档散落且互相断开，复杂改动缺乏可回溯的检查点。pi-squad 把「分工 + 文档 + 回溯」三件事打包成开箱即用的约定。

两种使用方式：

- **`pisquad` CLI**（推荐）：`npm i -g @nicklin/pisquad`；也兼容 `curl | bash` 一键安装
- **手动复制**：把 `assets/.pi/` 与 `assets/docs/` 拷贝进现有项目，立刻获得编排与文档约束能力

## 架构

四层结构（自下而上）：

| 层 | 角色 | 所在目录 |
|---|---|---|
| Extensions | 能力扩展：subagent / codegraph / entire / wikilink-lint | `assets/.pi/extensions/` |
| Skills | 约定注入：project-docs / workflow | `assets/.pi/skills/` |
| Agents | 专职分工：scout / planner / worker / reviewer / archivist | `assets/.pi/agents/` |
| Docs | 文档驱动：结构即导航 + 渐进式披露的模板骨架 | `assets/docs/` |

**协作链**（并非每次都走全链路，可按需裁剪）：

```
需求澄清 → scout 侦察 → planner 规划 → worker 执行 → reviewer 审查 → archivist 归档
```

**分工铁律**（来自 `workflow` skill）：主进程是编排者，不是执行者。它只读取 `docs/` 获取上下文，只负责编排与汇报；所有读代码、写代码、写文档的工作都通过 `subagent` 委派给专职 agent，在**隔离上下文**中完成。

协同关系：

| 能力 | 在哪一阶段用 | 起什么作用 |
|---|---|---|
| codegraph | 侦察 / 规划 | 提供符号、调用、影响分析 |
| entire | 全程 | 记录会话事件，支持 checkpoint / rewind |
| docs | 全程 | 沉淀上下文与结论 |
| wikilink-lint | 归档 / 改文档时 | 保证 wikilink 不越界、不悬空 |

> 注：`entire` 扩展本身只负责桥接事件，不实现 rewind；checkpoint / rewind 由外部 Entire CLI 提供。

## 核心模块

### Agents

| Agent | 职责 | 工具 |
|---|---|---|
| scout | 代码侦察，返回压缩的结构化上下文 | read, bash, grep, find, ls |
| planner | 只读规划，产出可执行实施计划 | read, grep, find, ls |
| worker | 全能执行者，隔离上下文，实际改代码 | 全部 |
| reviewer | 代码审查（质量 / 安全 / 可维护性），bash 严格只读 | read, grep, find, ls, bash |
| archivist | 文档管理员，只改 `docs/`，流转任务状态、沉淀 ADR / 约定 | read, write, edit, ls, grep, find |

### Skills

| Skill | 作用 |
|---|---|
| project-docs | 文档库入口与「结构即导航 / 渐进式披露」约定 |
| workflow | 工作分工铁律：主进程只读 docs，其余一律委派 |

### Extensions

| 扩展 | 作用 |
|---|---|
| subagent | 把任务委派给隔离上下文的子 pi 进程（single / parallel / chain 三种模式） |
| codegraph | 包装 codegraph CLI，注册 8 个代码图查询工具（explore / node / query / status / files / callers / callees / impact） |
| entire | 把 pi 会话事件桥接到外部 Entire CLI（由 Entire 负责 checkpoint / rewind），并给 `bash` 注入 `GIT_TERMINAL_PROMPT=0` 防止交互卡死 |
| wikilink-lint | 订阅 tool_call，对 `docs/**/*.md` 的 write / edit 做硬阻断：发现指向 docs 外或目标不存在的 wikilink 即拒绝写入 |

## 关键决策

- **主进程即编排者**：主进程只读 `docs/` 获取上下文，只负责编排与汇报；所有读代码、写代码、写文档的工作经 `subagent` 委派，在隔离上下文中完成
- **可分发包集中在 `assets/`**：维护种子仓库时不被自身的 `.pi/` 自动加载污染，根目录保持普通仓库；消费者把 `assets/` 内容拷到各自根目录
- **结构即导航 + 渐进式披露**：每层目录配一份 README 作为该层总地图；从进度看板出发，按链接下钻详情，不一次性加载
- **wikilink 硬约束**：docs 内文档互引一律用 wikilink，且仅指向 docs/ 内真实存在的文件，由 `wikilink-lint` 自动校验（越界或失效即拒绝写入）
- **pisquad 已从 bash 安装器升级为 npm CLI**：见 [[architecture/decisions/0001-pisquad-cli.md]]；分发、版本管理与升级路径都迁移到 npm 包形式，但保留极简 bash bootstrap 兼容 `curl | bash` 入口
- **upgrade 引入交互式决策层**：见 [[architecture/decisions/0003-interactive-upgrade.md]]；按目录白名单拆交互区（`docs/**` + `.pi/agents/**` + `.pi/skills/**`）与管理区（`.pi/extensions/**`），交互区走决策层逐文件询问 adopt/keep/edit，merge 走 `$EDITOR` 方案 A（不做三方 merge base）；非交互 / 无 tty 退化为 all-adopt+备份

---

相关文档：文档库总地图 [[README.md]]，架构目录 [[architecture/README.md]]，架构决策记录 [[architecture/decisions/README.md]]，约定 [[conventions/README.md]]，需求 [[prds/README.md]]，任务 [[tasks/README.md]]，词汇表 [[glossary.md]]。
