---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：03 · CLI lib 基础（install 必需子集）

> 阶段 1 · MVP

## 目标

建立 `src/lib/` 下的基础库集合，install 命令（07）必需的所有工具函数。这一批不含 diff/backup（那是阶段 2 的 09）。

## 完成标准

- [ ] `src/lib/env.ts`：
  - `isInteractive()` — 检测 stdin/stdout 是否都是 tty；任一不是 tty 即返回 false
  - `which(cmd)` — 包装 `command -v`，跨平台
  - `execCapture(cmd, args)` — 执行子进程，捕获 stdout/stderr/exitCode，封装为 `{ stdout, stderr, exitCode }`
- [ ] `src/lib/paths.ts`：
  - `resolvePackageRoot()` — 返回当前 npm 包根路径（用 `import.meta.url` + `fileURLToPath` 推 `dist/` 上溯一级）；开发态（tsup 跑）也正确解析
  - `resolveAsset(rel)` — 拼接包内资源绝对路径
  - `resolveTarget(input?, cwd?)` — 解析用户传入的目标目录，默认 `process.cwd()`；展开 `~`、规范化为绝对路径
  - `stateFile(target)` — 返回 `<target>/.pi/.pisquad/state.json`
- [ ] `src/lib/logger.ts`：
  - 包装 `picocolors`，提供 `info` / `warn` / `error` / `success` / `step`
  - 支持 `logger.setVerbose(boolean)`，默认 false；verbose 时打印详细步骤
- [ ] `src/lib/ui.ts`：
  - `promptChannels(target)` — 调 `@inquirer/prompts` 的 `checkbox`，选项 `[codegraph, entire]`，**core 不在选项里**（锁死全装）
  - `decideChannels(opts)` — 实现优先级决策表（从高到低）：
    1. `--all` → 三个全开（含 codegraph、entire）
    2. `--with a,b` → 与默认（只 core）取并集
    3. `--without a,b` → 从默认（只 core）中剔除（注：core 不能被 without 移除）
    4. `--yes` → 默认（只 core）
    5. `PISQUAD_WITH` 环境变量 → 解析逗号分隔，加到默认
    6. `PISQUAD_WITHOUT` 环境变量 → 解析逗号分隔，从默认剔除
    7. 交互模式 → 调 `promptChannels`
    8. 无 tty 默认 → **只装 core**，返回 `{ core: true, codegraph: false, entire: false }`，**不抛错、不退出非零**
- [ ] `src/lib/assets.ts`：
  - `listAssets()` — 返回包内 `assets/` 下需要安装的根条目（`.pi/` `docs/` `pisquad` bootstrap 脚本视情况）
  - `readAssetsVersion()` — 读 `assets/.pi/assets-version.txt`，trim 后返回；缺失时抛错
- [ ] `src/lib/copy.ts`：
  - `copyDir(src, dest, opts?)` — 递归拷贝目录；`opts.filter` 可选；`opts.dryRun` 打印而不真写
- [ ] `src/lib/fs-safe.ts`：
  - `ensureDir(p)`、`pathExists(p)`、`atomicWriteFile(p, content)`（写 tmp 后 rename）、`removeIfEmpty(p)`
- [ ] 所有公共函数含最小单测或手工 `node --import tsx` 验证脚本（不强求框架）

## 依赖

- 01 · 包脚手架