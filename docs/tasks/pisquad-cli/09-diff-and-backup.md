---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：09 · diff 与 backup lib

> 阶段 2 · upgrade 全套

## 目标

实现 `src/lib/diff.ts` 与 `src/lib/backup.ts`：用 sha256 比较「包内新树」与「目标当前树」，生成「将被覆盖、被删除、保留不变」三类清单；备份工具把将被覆盖的文件打成 tar.gz。**本任务必须把 docs/ 子树纳入 diff**。

## 完成标准

- [ ] `src/lib/diff.ts`：
  - `sha256File(p)` / `sha256Dir(p)`：递归遍历目录，对每个文件算 sha256，返回 `{ relPath: hash }` 映射
  - `diffTree(pkgRoot, target, opts)`：比较 `assets/.pi/` ↔ `<target>/.pi/`、`assets/docs/` ↔ `<target>/docs/`（**路径映射必须显式，不漏 docs**）、`pisquad` bootstrap 脚本（若纳入升级范围）
  - 返回 `DiffPlan`：
    ```ts
    {
      modified: Array<{ relPath: string, fromHash: string, toHash: string }>,  // 改了 → 备份 + 覆盖
      added:   Array<{ relPath: string, toHash: string }>,                     // 新增 → 直接复制
      removed: Array<{ relPath: string, fromHash: string }>,                   // 包内移除 → 默认保留
      unchanged: Array<{ relPath: string }>,
    }
    ```
  - `opts.include: Array<{ pkgSubPath, targetSubPath }>` 显式声明要比较的子树对，确保 `docs/` 被声明
- [ ] `src/lib/backup.ts`：
  - `createBackup(target, files, label)`：
    1. 文件名 `<iso>-<label>.tar.gz`（去掉 `:` 与 `.`，参见 `conventions/install-state.md`）
    2. 写到 `<target>/.pi/.pisquad/backups/`
    3. tar 内路径相对 `<target>`（如 `docs/README.md`）
    4. 写完打印「Backed up N files → <path>」
  - `listBackups(target)`：列出已有备份，按时间排序
  - `pruneBackup(target, before)`：保留 `before` 之后的（本期不自动调用，仅供后续 `pisquad restore` 使用）
- [ ] **docs 子树验收**：手工在 `<target>/docs/README.md` 写一行；运行 diffTree → 该文件出现在 `modified` 列表

## 依赖

- 03 · CLI lib 基础