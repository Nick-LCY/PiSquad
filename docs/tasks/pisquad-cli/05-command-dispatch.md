---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：05 · 命令分发与基础命令

> 阶段 1 · MVP

## 目标

用 `commander` 搭好命令分发骨架，实现 `default` `version` `help` 三个命令。`install` 在本任务里只挂空壳（实际逻辑在 07 里实现）。`upgrade` 暂不注册。

## 完成标准

- [ ] `src/bin.ts`：
  - shebang `#!/usr/bin/env node`
  - 加载 `src/main.ts`
- [ ] `src/main.ts`：
  - `program` 用 `commander` 创建
  - 配置 `name` `description` `version`（来自 `package.json#version`）
  - 注册子命令：`install` `version` `help`
  - 无参时等价于 `install`：通过 `program.action(...)` 钩到 `defaultCmd`
- [ ] `src/commands/default.ts`：
  - 当用户跑 `pisquad`（无参）时调用，等价于转发到 `install` 命令
- [ ] `src/commands/version.ts`：
  - `pisquad version` 打印 `cliVersion`（来自 `package.json#version`）+ `version`（来自 `assets/.pi/assets-version.txt`），格式：`pisquad <cliVersion> (assets <version>)`
- [ ] `src/commands/help.ts`：
  - `pisquad help [cmd]` 打印全局或子命令 help
  - 兜底：`pisquad --help` 走 commander 内置
- [ ] `install` 命令文件 `src/commands/install.ts` 存在但本任务只挂占位实现（打印「stub」后退出 0）；07 替换为完整逻辑
- [ ] `npm run build` 跑通；`./dist/bin.js --version` 输出正确版本号；`./dist/bin.js --help` 显示所有子命令

## 依赖

- 03 · CLI lib 基础