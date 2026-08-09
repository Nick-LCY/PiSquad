# 0001. pisquad 升级为 npm 全局 CLI

- 日期：2026-01
- 状态：已接受

## 背景

仓库根的 `pisquad` 脚本是 152 行的单文件 bash 安装器。它随项目一起迭代至今，承担以下职责：

- 一键安装：`curl ... | bash`
- 选择可选 channel（codegraph / entire）
- 把 `assets/.pi/` 与 `assets/docs/` 拷到目标目录

但它的形态已经触到天花板：

1. **无法分版本**：每次运行都从 GitHub `main` 拉 tarball，assets 内容随 HEAD 漂移；不能固定版本、不能回滚
2. **没有子命令概念**：`install` 之外还想做 `upgrade`、`version`、`help` 等，全部堆在一个脚本里会失控
3. **交互粗糙**：bash `select` 无颜色、无方向键，必须手敲数字 + 回车
4. **管道 / CI 直接死**：`</dev/tty` 在无 tty 环境直接 EOF 退出
5. **没有升级路径**：用户装了一次后没法无痛升级到新版本，只能再跑一次 install（也可能踩到整个安装 bug）
6. **整个 bug**：勾选 entire 时只跑了 `entire enable --agent pi`，从未把 `extensions/entire/` 目录拷进目标

详见 PRD [[prds/pisquad-cli.md]]。本 ADR 只记录决策本身，背景中的细节不再重复。

## 决策

1. **语言选 TypeScript**：现有 `.pi/extensions/` 已是 TS，统一到 TS 减少工具链分裂；可读性、生态成熟度都合适
2. **包名定为 `@nicklin/pisquad`**（scoped npm 包）：原计划使用 unscoped `pisquad`，但 `npm publish` 触发 npm 包名相似性规则（与已存在的 `pi-squad` 太相似）被拒，故改用 scoped 包 `@nicklin/pisquad`，并加 `publishConfig.access = "public"` 让发布默认公开。**bin 命令名保持 `pisquad`**——命令名与 npm 包名解耦，用户安装后仍敲 `pisquad install`。
3. **分发型式**：以 **npm 全局包**（`npm i -g @nicklin/pisquad`）为主入口；保留一个**极简 bash bootstrap**（仓库根 `pisquad` 文件）维持 `curl | bash` 入口——它只做两件事：检测 node，然后转发到 `pisquad`（已全局）或 `npx @nicklin/pisquad@latest`
4. **仓库结构**：**根目录即 npm 包根**——`src/` `dist/` `package.json` `tsconfig.json` `tsup.config.ts` `.npmignore` 都在根；`assets/` 保持原位（在根）
5. **assets 内嵌**：`assets/` 打包进 npm 包本体，install / upgrade 都从**包内资源**拷贝，**不再运行时 curl GitHub tarball**；CLI 版本 = assets 版本
6. **技术栈**：`commander`（命令分发）+ `@inquirer/prompts`（交互 checkbox / select）+ `picocolors`（彩色）+ `tsup`（打包）；Node ≥ 18
7. **CLI 版本 vs assets 版本分离**：`state.json` 同时记录 `cliVersion`（工具版本，来自 `package.json#version`）和 `version`（assets 内容版本，来自包内 `assets/.pi/assets-version.txt`）
8. **upgrade 安全机制**：项目里记 `<target>/.pi/.pisquad/state.json`；upgrade 时用 sha256 diff 检测用户改过的文件；**覆盖前先 tar.gz 备份到 `<target>/.pi/.pisquad/backups/`**；旧版已安装时 install 拒绝覆盖式安装、强制走 upgrade
9. **docs 纳入 diff**：`docs/` 属于 core channel，作为**独立的 diff 子树**，明确路径映射 `assets/docs/` ↔ `<target>/docs/`；和 agents / skills 走同一套「改了→备份+覆盖、用户新增的→保留不删」
10. **不向后兼容**：旧 bash 安装的项目无 state.json，upgrade 会报错提示「未安装，请先 install」；**不写迁移工具**
11. **交互 / 非交互**：交互用 `@inquirer/prompts` checkbox 选 codegraph / entire（core 锁死全装）；非交互用 `--yes` / `--with` / `--without` / `--all` + 环境变量 `PISQUAD_WITH` / `PISQUAD_WITHOUT`；无 tty 自动退化为非交互默认（只装 core），**不再 EOF 卡死**
12. **修整个安装 bug**：勾选 entire 时既 cp `extensions/entire/` 目录到目标，也执行 `entire enable --agent pi`
13. **子命令表面**：`pisquad`（无参 = install）/ `install [path]` / `upgrade [path]` / `version` / `help`
14. **分阶段交付**：MVP（能装能用）→ upgrade 全套 → 文档与发布，共 14 个任务，详见 `tasks/pisquad-cli/`
15. **升级决策层（管理区 / 交互区拆分 + `$EDITOR` 编辑旧文件）**：在 0.1.1 之后追加，见 ADR [[architecture/decisions/0003-interactive-upgrade.md]]。按目录白名单把 upgrade 范围拆成交互区（`docs/**`、`.pi/agents/**`、`.pi/skills/**`，走决策层逐文件询问 adopt/keep/edit）和管理区（`.pi/extensions/**`，保持自动覆盖+备份）；merge 走 `$EDITOR` 方案 A（不拉三方 merge base）；决策层独立、纯协调、deps 注入，与 backup/copy/prune 解耦；非交互/无 tty 退化为「全部采用新+备份」。本次不对前 14 条决策做任何修改，只是叠加增强。

## 影响

### 仓库层面

- 根目录新增：`src/`、`dist/`、`tsconfig.json`、`tsup.config.ts`、`.npmignore`
- `.gitignore` 追加 `dist/`
- `package.json` 成为根目录的关键文件，包含 `bin`、`files`、`engines`、依赖列表
- 仓库根 `pisquad` 文件改写为极简 bash bootstrap（仍可执行）

### 发布层面

- 组件更新不再走「commit main → 用户重跑 install」；改走「bump 版本 → `npm publish` → 用户跑 `pisquad upgrade`」
- 发布物包括构建产物 `dist/`、内嵌 `assets/`、README、LICENSE、`pisquad` 脚本
- `npm pack --dry-run` 必须显式排除 `src/` `node_modules/` `.pi/` `docs/`（根仓库的 docs 不进包；进包的是 `assets/docs/`）

### 用户层面

- **旧项目（用 bash 安装器装过的）无 state.json**：必须重新 `pisquad install`（非目标第 1 条，明确不写迁移工具）
- 新项目走 `npm i -g @nicklin/pisquad` 或 `curl | bash` 均可

### 运行时产物约定

- `<target>/.pi/.pisquad/state.json` 成为事实标准（详见 [[conventions/install-state.md]]）
- `<target>/.pi/.pisquad/backups/` 成为事实标准
- 这两个路径**应纳入 `.gitignore`**（用户项目里），不是用户手改的内容

### 文档库层面

- 本 ADR 与 [[conventions/install-state.md]] 同步落地
- PRD [[prds/pisquad-cli.md]] 是拆任务的依据
- 14 个任务文件落地在 `tasks/pisquad-cli/`，分阶段映射
- 看板 [[current-state.md]] 新增 `pisquad-cli` 分组