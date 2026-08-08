---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：01 · 包脚手架

> 阶段 1 · MVP

## 目标

把仓库根初始化为合法的 npm 包：建 `package.json` `tsconfig.json` `tsup.config.ts` `.npmignore`，并把 `dist/` 加入 `.gitignore`。本任务**不写任何业务代码**，只搭骨架，让后续 02–08 任务有地方落脚。

## 完成标准

- [ ] `package.json` 含：
  - `name: "@nicklin/pisquad"`
  - `version: "0.1.0"`（占位，后续发布时 bump）
  - `bin: { "pisquad": "dist/bin.js" }`
  - `files: ["dist", "assets", "README*.md", "LICENSE", "pisquad"]`
  - `engines: { "node": ">=18" }`
  - `dependencies`: `commander` `@inquirer/prompts` `picocolors`
  - `devDependencies`: `typescript` `tsup` `@types/node`
  - `scripts`: `build` `dev` `prepublishOnly`
- [ ] `tsconfig.json` 含 `target: ES2022`、`module: ESNext`、`moduleResolution: bundler`、`strict: true`、`outDir: dist`
- [ ] `tsup.config.ts` 输出单文件 `dist/bin.js`（bundle，shebang 注入），生成 sourcemap
- [ ] `.npmignore` 显式排除 `src/` `node_modules/` `.pi/` `docs/` `tsconfig.json` `tsup.config.ts`
- [ ] `.gitignore` 追加 `dist/`
- [ ] `npm install` 在根目录跑通，锁文件提交
- [ ] `npm run build` 跑通并产出 `dist/bin.js`（内容是 hello-world 占位也可，本任务不验证业务）

## 依赖

- 无