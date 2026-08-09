# 0002. self-update 前比较版本，避免重跑死循环

- 日期：2026-08
- 状态：已接受

## 背景

0.1.0 版的 `selfUpdate` 在确认全局安装后无条件执行 `npm i -g @nicklin/pisquad@latest`。问题是：**当本地已是最新版时，`npm i -g @latest` 也是成功的**（exit 0，因为没有需要写入的新内容）——但 `selfUpdate` 并不检查 npm 是否实际写入了新版本，于是始终返回 `updated:true`。`upgrade` 据此判断"CLI 自更新完成，需要重跑以加载新代码"，提示用户重跑 `pisquad upgrade`。**重跑又触发 self-update，又再次提示重跑——陷入死循环**。

该 bug 只在包**真发布到 registry 后**（`npm i -g` 能成功）才暴露。发布前的 e2e 验证（含 `npm link`）因 registry 无此包，`npm i -g` 直接失败（exit 非 0），selfUpdate 报失败、`updated:false`，死循环路径根本走不到，无法复现。0.1.0 → 0.1.1 的 hotfix 周期因此才显式补上这一步。

印证 ADR [[architecture/decisions/0001-pisquad-cli.md]] 第 7 条决策"CLI 版本 vs assets 版本独立"的设计价值：CLI 与 assets 是两份独立的 manifest，本次 bug 只影响 CLI、不污染 assets，hotfix 可以最小颗粒（仅 bump `package.json` + 改 selfUpdate 一处，`assets-version.txt` 仍 0.1.0）发布。

## 决策

`selfUpdate` 在跑 `npm i -g` **之前**先 `npm view @nicklin/pisquad version` 取 registry 最新版，与 `readCliVersion()`（读 `package.json#version`）比较，按三分支返回：

1. **registry 版本 == 当前版本（已是最新）** → log `already up to date`，返回 `updated:false`；`upgrade` 据此判断"CLI 无需自更新"，**继续 project 同步**——死循环消除
2. **registry 版本 > 当前版本（registry 有新版）** → 跑 `npm i -g @nicklin/pisquad@latest`，返回 `updated:true`；`upgrade` 提示重跑（因当前进程内存仍是旧代码，project 同步必须在新代码下做）
3. **`npm view` 失败（网络 / 离线 / 临时错误）** → warn（不抛错），返回 `updated:false`，继续 project 同步——保守策略，宁可漏一次自更新，也不死循环

实现关键点：

- 版本比较前必须有 `readCliVersion()` 拿到的本地版本（已在 `src/lib/cli.ts` 提供）
- 三分支必须明确区分；不允许"不知道就不动"
- 日志必须明示走了哪条分支，便于用户与 e2e 诊断
- 三分支的退出 / 返回值契约必须在 e2e 里全部覆盖（之前漏掉的"已是最新"分支就是死循环的根源）

## 影响

### 用户层面

- 死循环消除：已是最新版本时 `upgrade` 不再提示"Re-run"，project 同步照常进行
- 网络失败场景下，CLI 不升级但项目同步照常进行——升级路径不会卡死
- 升级提示更精确：只有真正升了 CLI 才需要重跑

### 设计层面

- 印证 [[architecture/decisions/0001-pisquad-cli.md]] 第 7 条决策的价值：CLI 与 assets 版本独立，本次只修 CLI、不污染 assets
- 印证 [[architecture/decisions/0001-pisquad-cli.md]] 第 11 条决策"非交互友好"的价值：非交互默认（无 tty + `--yes`）也走同一三分支，不退化为死循环

### 维护层面

- 未来维护 `selfUpdate` 必须保留"先比版本"这一步；任何改写需重新审视三分支是否齐备
- e2e 测试必须覆盖"已是最新"分支（不能只测"有新版"分支）——这是 0.1.0 漏掉的核心
- registry 不可用应被视作正常降级路径，不是错误

### 与 ADR 0001 的关系

不修改 ADR 0001 的任何决策；本次是对 0001 第 12 项（CLI self-update 子任务）实现细节的补丁，补全其在真发布场景下的行为契约。
