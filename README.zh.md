# pi-squad

> 基于 [pi](https://pi.dev/) 的多代理、文档驱动开发底座——拷贝即用。

[English README](./README.md)

## 简介

**pi-squad** 是一套可复用的开发底座 / 模板，基于 [pi](https://pi.dev/) coding agent 构建。它把主进程变成**纯编排者**，把所有真正读代码、写代码、维护文档的工作派给一支各司其职的 agent 小队（侦察 / 规划 / 执行 / 审查 / 归档），并附带代码图查询、会话回溯、文档链接校验等能力。

它要解决的是：在 pi 这类 coding agent 上做稍大一点的项目时，单进程上下文很快被无关噪音填满，文档散落在各处且互相断开，复杂改动缺乏可回溯的检查点。pi-squad 把"分工 + 文档 + 回溯"三件事打包成开箱即用的约定。

两种用法：通过 `pisquad` CLI 安装（推荐，见[快速开始](#快速开始)）；或手动把 `assets/.pi/` 与 `assets/docs/` 拷贝进现有项目，立刻获得编排与文档约束能力。

适合谁：
- 想用 pi 搭建多代理工作流、但不想从零设计的人
- 想要一份"拷贝即用"的项目骨架（自带文档库、任务看板、ADR 模板）的人

## 特性

- **多代理协作**：编排者 + 5 个专职 agent（scout / planner / worker / reviewer / archivist），各有限定的工具权限与隔离上下文
- **文档驱动开发**：PRD → 拆分任务 → 看板（`docs/current-state.md`）的完整生命周期
- **代码图查询**：`codegraph` 扩展注册 8 个符号 / 调用 / 影响分析工具，加速侦察与规划
- **会话可回溯**：`entire` 扩展把 pi 会话事件桥接到 Entire CLI，由 Entire 负责 checkpoint / rewind
- **文档链接硬约束**：`wikilink-lint` 自动阻断 `docs/` 中失效或越界的 wikilink
- **即用文档库**：`docs/` 提供一套结构化、渐进式披露的模板骨架

## 前置条件

| 类型 | 名称 | 安装 |
|---|---|---|
| 必需 | pi coding agent | `npm i -g @earendil-works/pi-coding-agent` |
| 可选 | Entire CLI | 见 [Entire 官网](https://entire.io)（用于会话 checkpoint / rewind） |
| 可选 | CodeGraph CLI | 见对应安装说明（首次使用需在项目根目录执行 `codegraph init` 建立索引） |

## 快速开始

推荐路径走 npm 分发的 CLI：

```bash
npm i -g @nicklin/pisquad
pisquad install .            # 安装到当前目录
```

交互流程会带你选择可选 channel（codegraph / entire）。CI / 管道场景可以用 `--yes`（只装 core）或显式指定：

```bash
pisquad install /path/to/project --yes
pisquad install /path/to/project --with codegraph,entire
pisquad install /path/to/project --all
```

安装完成后，在仓库目录里运行 `pi` —— agents / skills / extensions 会自动加载。需要代码图能力时在项目根目录跑一次 `codegraph init`。用自然语言描述你要做的事，主进程会自动编排并委派给合适的 agent。

## 命令

| 命令 | 说明 |
|---|---|
| `pisquad` | 等价于 `pisquad install`。 |
| `pisquad install [path]` | 把 pi-squad 安装到 `path`（默认 cwd）。 |
| `pisquad upgrade [path]` | 就地更新现有安装。 |
| `pisquad version` | 打印 CLI 与 assets 版本（`pisquad <cliVersion> (assets <version>)`）。 |
| `pisquad help [command]` | 显示总览或某个子命令的帮助。 |

### `pisquad install` 参数

| 参数 | 作用 |
|---|---|
| `-y, --yes` | 非交互；只装 core。 |
| `--with a,b` | 要安装的可选 channel（逗号分隔），core 始终安装。 |
| `--without a,b` | 跳过的可选 channel（逗号分隔）。 |
| `--all` | 装所有可选 channel。 |
| `--dry-run` | 预演变更，不实际写入。 |

环境变量 `PISQUAD_WITH` 和 `PISQUAD_WITHOUT` 提供同样的开关。当 stdin 不是 tty 且未传任何参数时，安装会自动退化为只装 core（退出码 0），不再因等待 prompt 而卡死。

## Upgrade safety

`pisquad upgrade` 会在覆盖文件前保护消费者的修改。检测到文件与已安装的 assets 不一致时，旧内容会以带时间戳的 `*-before-upgrade.tar.gz` 归档到 `.pi/.pisquad/backups/`，归档内路径相对于项目根目录，也包括 `docs/` 文件。

`.pi/.pisquad/state.json` 是安装状态记录，保存 assets 与 CLI 版本、启用的 channel 以及安装/升级时间。它由 pisquad 管理，不应手工修改。字段与备份规则见 [install-state](docs/conventions/install-state.md) 约定。

如果误改或误覆盖了文档，可从备份归档手工恢复，例如：

```bash
tar xzf .pi/.pisquad/backups/<timestamp>-before-upgrade.tar.gz -C /path/to/project
```

这是有意保留的手工恢复方式；pisquad 当前尚未提供 `restore` 子命令。


**核心铁律**（来自 `workflow` skill）：**主进程是编排者，不是执行者**。它只读取 `docs/` 获取上下文，只负责编排与汇报；所有读代码、写代码、写文档的工作都通过 `subagent` 委派给专职 agent，在**隔离上下文**中完成。

典型流程链（并非每次都走全链路，可按需裁剪）：

```
需求澄清 → scout 侦察 → planner 规划 → worker 执行 → reviewer 审查 → archivist 归档
```

协同关系：

| 能力 | 在哪一阶段用 | 起什么作用 |
|---|---|---|
| codegraph | 侦察 / 规划 | 提供符号、调用、影响分析 |
| entire | 全程 | 记录会话事件，支持 checkpoint / rewind |
| docs | 全程 | 沉淀上下文与结论 |
| wikilink-lint | 归档 / 改文档时 | 保证 wikilink 不越界、不悬空 |

> 注：`entire` 扩展本身只负责桥接事件，不实现 rewind；checkpoint / rewind 由外部 Entire CLI 提供。

## 组件

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
| project-docs | 文档库入口与"结构即导航 / 渐进式披露"约定 |
| workflow | 工作分工铁律：主进程只读 docs，其余一律委派 |

### Extensions

| 扩展 | 作用 |
|---|---|
| subagent | 把任务委派给隔离上下文的子 pi 进程（single / parallel / chain 三种模式）；空闲看门狗以 SIGSTOP 冻结静默子任务，裁决权交还主进程 |
| codegraph | 包装 codegraph CLI，注册 8 个代码图查询工具（explore / node / query / status / files / callers / callees / impact） |
| entire | 把 pi 会话事件桥接到外部 Entire CLI（由 Entire 负责 checkpoint / rewind），并给 `bash` 注入 `GIT_TERMINAL_PROMPT=0` 防止交互卡死 |
| wikilink-lint | 订阅 tool_call，对 `docs/**/*.md` 的 write / edit 做硬阻断：发现指向 docs 外或目标不存在的 `[[...]]` 即拒绝写入 |
| bash-guard | 在 `bash` 工具调用未显式传 timeout 时注入默认超时（300s）；默认值触发时通知 agent |

## 文档库

`docs/` 是一份**通用模板骨架**，采用结构即导航，按需下钻，不一次性加载。

约定：

- **结构即导航**：每层目录配一份 `README.md` 作为该层总地图
- **渐进式披露**：从 `current-state.md`（进度看板）出发，按链接进入详情
- **wikilink**：用 `[[path]]` 引用同目录树下其他文档（受 `wikilink-lint` 校验）

文档树：

```
docs/
├── README.md            # 总地图
├── current-state.md     # 进度看板（模板）
├── glossary.md          # 词汇表（模板）
├── architecture/        # 系统总览 + ADR（模板）
├── conventions/         # 约定（含文档链接约定）
├── prds/                # 需求设计（模板）
└── tasks/               # 任务（模板，frontmatter 含 status）
```

## 项目结构

> 可分发的 payload 放在 `assets/` 下，这样维护本种子仓库时不会被自身的 `.pi/` 自动加载所污染：根目录是普通仓库，消费者则把 `assets/` 的内容拷到各自根目录。同时根目录也是 npm 包根：CLI 以构建产物（`dist/`）+ 内联 payload（`assets/`）的形式发布。

```
.
├── assets/              # 可分发的 payload（拷给消费者的内容）
│   ├── .pi/             # pi 配置：agents / skills / extensions
│   │   ├── agents/      # scout / planner / worker / reviewer / archivist
│   │   ├── skills/      # project-docs / workflow
│   │   └── extensions/  # subagent / codegraph / entire / wikilink-lint / bash-guard
│   ├── docs/            # 文档库（模板骨架，详见上节）
│   └── codegraph.json   # codegraph 配置

├── src/                 # CLI 的 TypeScript 源码（`bin.ts`、`main.ts`、`commands/`、`lib/`）
├── dist/                # 构建产物（gitignored，打包进 npm tarball）
├── package.json         # npm 包元信息与依赖清单
├── tsconfig.json        # TypeScript 配置（strict，ESM，NodeNext）
├── tsup.config.ts       # 构建配置（单文件 ESM bundle）
├── .npmignore           # npm 打包排除规则
├── LICENSE              # 协议文件
├── README.md            # 英文 README
└── README.zh.md         # 本文件
```

## 许可证

[MIT](./LICENSE) — Copyright (c) 2026 Nick Lin。
