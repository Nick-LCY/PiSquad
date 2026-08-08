---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：11 · upgrade 命令完整逻辑（安全机制）

> 阶段 2 · upgrade 全套

## 目标

实现 `pisquad upgrade`：读 state → 算 diff → 备份将被覆盖的文件 → 覆盖/新增 → 处理移除 → 重跑 codegraph 的 `npm install`（若 codegraph 变更） → 写新 state。

## 完成标准

- [ ] `src/commands/upgrade.ts`：
  - `pisquad upgrade [path] [--prune] [--dry-run]`
  - 主流程：
    1. `resolveTarget`
    2. `readState` —— **缺失则报「未安装，请先 `pisquad install`」并退出非零**（不写迁移工具）
    3. `readAssetsVersion` + `readCliVersion` + `compareVersions`
    4. `diffTree(pkgRoot, target)` —— **必须包含 docs 子树**（`assets/docs/` ↔ `<target>/docs/`）
    5. 对 `modified` 列表 → `createBackup(target, files, "before-upgrade")`
    6. 对 `modified` + `added` → 覆盖/拷贝
    7. 对 `removed` → **默认保留**（不删）；`--prune` 才删（删前再 backup 一次，label `before-prune`）
    8. 若 `codegraph` 在 newChannels 或 channels 变更 → 在 `<target>` 跑 `npm install`
    9. `writeState` 更新 `version` `cliVersion` `channels`，刷新 `lastUpgradedAt`
    10. 打印汇总：升级了哪些 channel、备份了哪些文件、state 路径
- [ ] **docs 纳入 diff 验收**：手动改 `<target>/docs/README.md` → upgrade 触发 backup；backup tar 里含 `docs/README.md`（旧内容）
- [ ] **不向后兼容验收**：在空目录（旧项目）跑 `pisquad upgrade` → 退出非零，错误信息包含「not installed」
- [ ] `--dry-run`：打印 diff 计划 + 将要备份哪些 + 不真写；最终打印「DRY RUN — no changes made」
- [ ] upgrade 过程任何抛错 → 已备份的归档保留（不删），退出非零

## 依赖

- 09 · diff 与 backup lib
- 10 · state 读取与比较