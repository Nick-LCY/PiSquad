# pisquad CLI 化

## 背景

pi-squad 的可执行文件 `pisquad` 目前是仓库根一个 152 行的单文件 bash 安装器，存在诸多缺陷：

- **没有子命令分发**：所有逻辑都堆在一个脚本里，`install` 与未来功能无法解耦
- **没有参数解析**：只接受位置参数，没有 flag、没有 `--help`、没有版本号输出
- **没有版本管理**：每次运行都从 GitHub `main` 分支 `curl` 一个 tarball，assets 内容随 HEAD 漂移，无法复现、无法回滚
- **交互界面简陋**：用 bash `select` 实现的菜单，无颜色、无方向键，必须输数字再回车
- **`</dev/tty` 在非 tty 环境下直接 EOF 退出**：在 CI、管道、子进程里运行安装器会直接死掉
- **entire 安装 bug**：勾选 entire 时只跑了 `entire enable --agent pi`，从未把 `extensions/entire/` 目录拷进目标，导致整个扩展处于半装半没状态

需求：把它重写为一个完整的命令行工具，提供更好的交互式引导界面，并增加 `pisquad upgrade` 全量升级能力。

## 目标

- 提供 `pisquad` / `pisquad install` / `pisquad upgrade` / `pisquad version` / `pisquad help` 五个入口
- 安装与升级走 npm 全局包分发；同时保留一个极简 bash bootstrap 维持 `curl | bash` 入口
- 交互式 checkbox + 方向键，非交互场景（CI / 无 tty / `--yes`）自动退化、退出码正确
- 版本可复现：assets 内嵌进 npm 包，CLI 版本与 assets 版本一一对应
- `pisquad upgrade` 必须安全：检测本地修改 → 备份 → 再覆盖
- 修掉 entire 安装 bug：勾选 entire 时既 cp 目录也 enable

## 非目标

- **不做向后兼容 / 迁移工具**：旧 bash 安装的项目无 state.json，升级路径不存在；用户需重新 `pisquad install`
- **不做 ink / blessed 全屏 TUI**：对一次性安装流程属于过度设计，本期只做命令行提示
- **本期不做 `pisquad restore` 子命令**：备份文件先支持手工 `tar xzf` 解压恢复；restore 子命令留待后续
- **`assets/docs/` 与仓库根 `docs/` 的自动同步脚本本期不做**：保持手工约定（人在改 `docs/` 时记得同步到 `assets/docs/`）
- **不在 npm 包里塞 README / Wiki / changelog 之外的额外文件**：包体只装构建产物 + assets + 必要的元信息

## 方案

### 1. 分发链路

**主路径**：`npm i -g pisquad` 后直接调用 `pisquad`（或 `npx pisquad@latest` 一次性使用）。

**兼容入口**：仓库根保留一个极简 bash 脚本 `pisquad`，检测到 node 后转发到 `pisquad`（已全局安装）或 `npx pisquad@latest`。这样 `curl ... | bash` 形式仍可用，且后续不再用 curl 拉 tarball。

### 2. 仓库结构

**根目录即 npm 包根**——`src/`（TS 源码）、`dist/`（构建产物，gitignored）、`package.json`、`tsconfig.json`、`tsup.config.ts`、`.npmignore` 都在根；`assets/` 保持原位。意味着仓库本身既是种子源，又是 npm 包源。

### 3. assets 内嵌

`assets/` 在打包时直接复制进 npm tarball（写入 `package.json` 的 `files` 字段）。安装与升级都从**包内资源**拷贝，不再运行时 curl GitHub。CLI 版本 = assets 版本，映射清晰。

### 4. 技术栈

- TypeScript（目标 Node ≥ 18）
- `commander` 做命令分发
- `@inquirer/prompts` 做交互式 checkbox / select
- `picocolors` 做彩色输出
- `tsup` 做打包（单文件 `dist/bin.js` + sourcemap）

### 5. CLI 版本 vs assets 版本分离

`state.json` 同时记录：

- `cliVersion`：工具自身版本（来自 `package.json#version`）
- `version`：assets 内容版本（来自包内 `assets/.pi/assets-version.txt`）

工具可以独立 bump，但 assets 升级要走 `pisquad upgrade`。

### 6. upgrade 安全机制

`<target>/.pi/.pisquad/state.json` 记录所有已安装 channel 与版本；upgrade 时：

1. 计算当前目标树 vs 包内新树的 sha256 diff
2. 用户改过的文件 → 覆盖前先 tar.gz 备份到 `<target>/.pi/.pisquad/backups/<iso>-<label>.tar.gz`
3. 包内有但目标里没有的 → 默认**保留**（保守），`--prune` 才删
4. **docs/ 子树**纳入同一套 diff 流程（`assets/docs/` ↔ `<target>/docs/`），docs 是消费者高频修改区，保护最重要

旧版已安装的项目（无 state.json）走 `pisquad install` 会被拒绝对覆盖式安装，提示走 `pisquad upgrade`——但旧版无 state.json，`upgrade` 又会因 state 缺失报错。因此**结论：旧项目必须重新 install**（见非目标第 1 条）。

### 7. 交互 vs 非交互

| 模式 | 触发条件 | 行为 |
|---|---|---|
| 交互 | 有 tty + 用户未指定 flag | `@inquirer/prompts` checkbox 选 codegraph / entire，core 锁死全装 |
| 非交互 | `--yes` / `--with a,b` / `--without a,b` / `--all` / 环境变量 `PISQUAD_WITH` `PISQUAD_WITHOUT` / 无 tty | 跳过 prompt，按既定规则决策 |
| 无 tty 默认 | 自动检测 | **只装 core**，退出码 0，**不再 EOF 卡死** |

`--yes` 与 `--with/--without/--all` 的优先级在 `src/lib/env.ts` 里定义一个决策表。

### 8. 子命令表面

```
pisquad            # 等价于 pisquad install（默认）
pisquad install [path]
pisquad upgrade [path]
pisquad version    # 打印 cliVersion + version
pisquad help
```

### 9. 分阶段交付

任务文件落在 `tasks/pisquad-cli/` 下，共 14 个，分三阶段：

- **阶段 1（MVP）**：01–08，能 `npm i -g pisquad` 并 install 成功
- **阶段 2（upgrade 全套）**：09–12，diff/backup/self-update
- **阶段 3（文档与发布）**：13–14，docs 全面同步 + e2e 验证 + npm publish 演练

## 验收标准

- [ ] `npm i -g pisquad` 后 `pisquad --version` / `pisquad --help` 正常输出
- [ ] `pisquad install` 交互式能用方向键勾选 codegraph / entire，core 全装
- [ ] `pisquad install --yes --with codegraph,entire <dir>` 在无 tty 子进程中退出码 0、**不卡死**
- [ ] entire 勾选后，目标 `.pi/extensions/entire/index.ts` 实际存在（bug 已修复）
- [ ] `pisquad upgrade` 在已安装项目：检测到本地修改 → 生成 tar.gz 备份 → 覆盖 → 打印提示；state.json 前进
- [ ] **`docs/` 的修改也被 diff + 备份保护**（修改 `<dir>/docs/README.md` 后 upgrade 触发备份）
- [ ] `npm pack --dry-run` 确认包内含 `dist/` `assets/` `README*.md` `LICENSE` `pisquad`，**不含** `src/` `node_modules/` `.pi/` `docs/`
- [ ] `curl | bash` bootstrap 在 node 就绪时正确转发到全局 `pisquad` 或 `npx pisquad@latest`
- [ ] 旧项目（无 state.json）执行 `pisquad upgrade` 报清晰错误并退出非零码，**不写迁移工具**

相关文档：[[architecture/overview.md]]，架构决策 [[architecture/decisions/0001-pisquad-cli.md]]，约定 [[conventions/install-state.md]]，任务列表 `tasks/pisquad-cli/`，看板 [[current-state.md]]。