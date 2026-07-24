# pi-squad

> A drop-in pi base for multi-agent, doc-driven development.

[中文 README](./README.zh.md)

## Introduction

**pi-squad** is a reusable development base / template, built on the [pi](https://pi.dev/) coding agent. It turns the main process into a **pure orchestrator**, delegating all actual code reading, code writing, and document maintenance work to a team of specialized agents (scout / planner / worker / reviewer / archivist), along with code-graph querying, session rewind, and document link validation capabilities.

It solves this: when working on somewhat larger projects with a coding agent like pi, a single-process context quickly fills with irrelevant noise, documents are scattered everywhere and disconnected from each other, and complex changes lack traceable checkpoints. pi-squad packages the three things — "division of labor + documentation + traceability" — into out-of-the-box conventions.

Two ways to use it: clone this repository as a new project starting point; or copy only `.pi/` and `docs/` into an existing project to immediately gain orchestration and document-constraint capabilities.

For whom:

- People who want to build multi-agent workflows with pi, but don't want to design from scratch
- People who want a "copy-and-use" project skeleton (with a built-in document library, task board, and ADR template)

## Features

- **Multi-agent collaboration**: Orchestrator + 5 specialized agents (scout / planner / worker / reviewer / archivist), each with restricted tool permissions and isolated context
- **Document-driven development**: Full lifecycle of PRD → break down tasks → board (`docs/current-state.md`)
- **Code graph queries**: The `codegraph` extension registers 8 symbol / call / impact analysis tools to accelerate recon and planning
- **Session traceability**: The `entire` extension bridges pi session events to the Entire CLI, which handles checkpoint / rewind
- **Document link hard constraints**: `wikilink-lint` automatically blocks broken or out-of-bounds wikilinks in `docs/`
- **Ready-to-use document library**: `docs/` provides a structured, progressively-disclosed template skeleton

## Prerequisites

| Type | Name | Install |
|---|---|---|
| Required | pi coding agent | `npm i -g @earendil-works/pi-coding-agent` |
| Optional | Entire CLI | See [Entire website](https://entire.io) (for session checkpoint / rewind) |
| Optional | CodeGraph CLI | See corresponding install instructions (first-time use requires running `codegraph init` in the project root to build the index) |

## Quick Start

1. Clone this repository as a new project starting point, or copy the `.pi/` and `docs/` directories into an existing project.
2. (Optional) For code graph capabilities: run `codegraph init` in the project root.
3. Run `pi` inside the repository directory — agents / skills / extensions will load automatically.
4. Describe what you want to do in natural language, and the main process will automatically orchestrate and delegate to the appropriate agent.

## How It Works

**Core iron rule** (from the `workflow` skill): **The main process is an orchestrator, not an executor**. It only reads `docs/` to acquire context, and only handles orchestration and reporting; all code reading, code writing, and document writing work is delegated via `subagent` to specialized agents, completed in **isolated contexts**.

Typical flow chain (not every run walks the full chain; trim as needed):

```
Requirement → scout recon → planner plans → worker executes → reviewer reviews → archivist archives
```

Collaboration:

| Capability | Phase | Role |
|---|---|---|
| codegraph | recon / planning | Provides symbol, call, and impact analysis |
| entire | throughout | Records session events, supports checkpoint / rewind |
| docs | throughout | Accumulates context and conclusions |
| wikilink-lint | archiving / editing docs | Ensures wikilinks don't go out of bounds or dangle |

> Note: The `entire` extension itself only handles event bridging, it does not implement rewind; checkpoint / rewind is provided by the external Entire CLI.

## Components

### Agents

| Agent | Responsibility | Tools |
|---|---|---|
| scout | Code recon, returns compressed structured context | read, bash, grep, find, ls |
| planner | Read-only planning, produces executable implementation plans | read, grep, find, ls |
| worker | All-around executor, isolated context, actually modifies code | all |
| reviewer | Code review (quality / security / maintainability), bash strictly read-only | read, grep, find, ls, bash |
| archivist | Document admin, only modifies `docs/`, transitions task status, accumulates ADR / conventions | read, write, edit, ls, grep, find |

### Skills

| Skill | Role |
|---|---|
| project-docs | Document library entry and the "structure as navigation / progressive disclosure" conventions |
| workflow | Division-of-labor iron rule: main process only reads docs, everything else is delegated |

### Extensions

| Extension | Role |
|---|---|
| subagent | Delegates tasks to child pi processes with isolated context (three modes: single / parallel / chain) |
| codegraph | Wraps the codegraph CLI, registers 8 code-graph query tools (explore / node / query / status / files / callers / callees / impact) |
| entire | Bridges pi session events to the external Entire CLI (Entire handles checkpoint / rewind), and injects `GIT_TERMINAL_PROMPT=0` into `bash` to prevent interactive hangs |
| wikilink-lint | Subscribes to tool_call, hard-blocks write / edit on `docs/**/*.md`: rejects the write if a `[[...]]` points outside `docs/` or to a non-existent target |

## Documentation Library

`docs/` is a **generic template skeleton** that uses structure as navigation, drilling down on demand rather than loading everything at once.

Conventions:

- **Structure as navigation**: Each directory level is paired with a `README.md` as that level's overall map
- **Progressive disclosure**: Start from `current-state.md` (progress board), follow links into details
- **wikilink**: Use `[[path]]` to reference other documents in the same directory tree (validated by `wikilink-lint`)

Document tree:

```
docs/
├── README.md            # overall map
├── current-state.md     # progress board (template)
├── glossary.md          # glossary (template)
├── architecture/        # system overview + ADR (templates)
├── conventions/         # conventions (incl. document link conventions)
├── prds/                # requirements design (templates)
└── tasks/               # tasks (templates, frontmatter includes status)
```

## Project Structure

```
.
├── .pi/                 # pi config: agents / skills / extensions auto-loaded
│   ├── agents/          # scout / planner / worker / reviewer / archivist
│   ├── skills/          # project-docs / workflow
│   └── extensions/      # subagent / codegraph / entire / wikilink-lint
├── docs/                # document library (template skeleton, see section above)
├── LICENSE              # license file
├── README.md            # this file
└── README.zh.md         # Chinese README
```

## License

[MIT](./LICENSE) — Copyright (c) 2026 Nick Lin.
