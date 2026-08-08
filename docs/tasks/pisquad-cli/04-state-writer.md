---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：04 · version/state 写入（install 必需子集）

> 阶段 1 · MVP

## 目标

实现 `src/lib/version.ts` 的写入子集：`writeState()` 用于 install 完成时落盘 state.json。**读与比较子集（readState / compareVersions）留给阶段 2 的 10**。

## 完成标准

- [ ] `src/lib/version.ts` 导出：
  - `writeState(target, partial)` — 合并已有 state（若存在）+ 传入 partial → 写 `<target>/.pi/.pisquad/state.json`；用 `atomicWriteFile`；写入前确保 `.pi/.pisquad/` 存在
  - 内部类型 `InstallState`（与 `conventions/install-state.md` 一致）
- [ ] 写入规则严格遵循 [[conventions/install-state.md]]：
  - `installedAt` 仅首次写，后续保留
  - `lastUpgradedAt` 本任务**不写**（留给 upgrade）
  - 字段 schema：`version` `cliVersion` `channels: { core: true, codegraph, entire }` `installedAt`
- [ ] 不在阶段 1 引入 readState / compareVersions
- [ ] 用例：手工构造旧 state（含 installedAt）→ writeState 只覆盖 version/cliVersion/channels → installedAt 保持不变

## 依赖

- 03 · CLI lib 基础