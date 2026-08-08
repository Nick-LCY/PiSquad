---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：14 · e2e 验证与发布演练

> 阶段 3 · 文档与发布

## 目标

在所有代码与文档完成后，做一次 e2e 验证 + 发布演练：覆盖 install / upgrade / docs 备份 / 无 tty 退化 / `npm pack` 内容 / publish 流程。

## 完成标准

- [ ] **本地 self-install**：
  - 在仓库根跑 `npm run build` + `npm i -g .`（或 `npm link`）→ `pisquad --version` 输出包版本
- [ ] **临时目录 install + upgrade 模拟**：
  - 在 `/tmp/pisquad-e2e-XXXX/` 下：
    1. 第一次 `pisquad install --yes --all` → state.json 写入、三个 channel 都装上
    2. 修改 `<tmp>/docs/README.md`（模拟消费者改动）
    3. bump 本地包的 assets-version（改 `assets/.pi/assets-version.txt`）+ rebuild + reinstall
    4. 跑 `pisquad upgrade` → 验证：
       - 出现 backup `<iso>-before-upgrade.tar.gz` 在 `<tmp>/.pi/.pisquad/backups/`
       - tar 内含 `docs/README.md`（旧内容）
       - 升级后 `<tmp>/docs/README.md` 是新版内容
       - state.json 的 `lastUpgradedAt` 已刷新
- [ ] **CI 无 tty 路径**：
  - 在子 shell `bash -c 'pisquad install --yes --with codegraph,entire <dir> < /dev/null'` → 退出码 0，不卡死
- [ ] **`npm pack --dry-run` 内容检查**：
  - 列表里**必须含**：`dist/` `assets/` `README*.md` `LICENSE` `pisquad`
  - 列表里**必须不含**：`src/` `node_modules/` `.pi/` `docs/`（仓库根 docs）
- [ ] **`npm publish` 演练**：
  - 用 `--dry-run` 跑一次 publish，确认 tag、access、registry 正确
  - 不真发版；记录发版 checklist 留作真实发版用
- [ ] e2e 完成后，更新 [[current-state.md]] 把任务看板标记 done

## 依赖

- 13 · 文档全面同步