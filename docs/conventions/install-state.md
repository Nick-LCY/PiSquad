# install-state 约定

> 本约定定义 `<target>/.pi/.pisquad/` 目录下的运行时产物格式与规则。配套见 PRD [[prds/pisquad-cli.md]] 与 ADR [[architecture/decisions/0001-pisquad-cli.md]]。

## 范围

`<target>/.pi/.pisquad/` 由 `pisquad install` 创建、由 `pisquad upgrade` 维护。它包含三类内容：

- `state.json` — 安装状态的唯一权威记录
- `backups/` — upgrade 覆盖前的备份归档
- `.gitignore` — 嵌套忽略规则（内容 `backups/`），作为根 `.gitignore` 之外的第二层防御

这三类都属于**运行时产物**，归 pisquad 自己管，不属于用户项目内容。

## state.json schema

文件路径：`<target>/.pi/.pisquad/state.json`

```ts
type InstallState = {
  /** assets 内容版本，来自包内 assets/.pi/assets-version.txt */
  version: string;
  /** pisquad CLI 自身版本，来自 package.json#version */
  cliVersion: string;
  /** 已启用的 channel（core 始终 true；可选 channel 看用户勾选） */
  channels: {
    core: true;
    codegraph: boolean;
    entire: boolean;
  };
  /** 首次 install 完成时间，ISO 8601 */
  installedAt: string;
  /** 最近一次 upgrade 完成时间，ISO 8601；首次 install 后为空 */
  lastUpgradedAt?: string;
};
```

### 字段语义

- `version`：assets 快照版本。每次 `assets/.pi/assets-version.txt` bump 时，`pisquad upgrade` 会写入新值
- `cliVersion`：CLI 工具版本。独立 bump 时（仅工具自身变、assets 不变）也写入
- `channels`：当前已安装的 channel 集合。core 永远 true，可选 channel 反映用户勾选
- `installedAt`：写一次后不再变动
- `lastUpgradedAt`：每次 upgrade 成功后刷新；首次 install 时缺省

### 写入规则

- `pisquad install` 成功时**整体覆盖**写入
- `pisquad upgrade` 成功时**整体覆盖**写入（version/cliVersion/channels 可变，installedAt 不变、lastUpgradedAt 刷新）
- 任何命令对 state.json 的写入都是「先拼好新对象、再原子重命名」，避免半写状态

## backups 目录

目录路径：`<target>/.pi/.pisquad/backups/`

### 触发条件

`pisquad upgrade` 检测到目标里有文件被用户改过（sha256 与包内不一致），且将被新版本覆盖时，**先备份再覆盖**。

### 文件格式

`<iso>-<label>.tar.gz`

- `<iso>`：触发备份的时间，ISO 8601，去掉 `:` 与 `.`（例 `2026-01-15T103045Z`）
- `<label>`：本次 backup 的语义标签，例如 `before-upgrade` 或 `before-prune`

例：`2026-01-15T103045Z-before-upgrade.tar.gz`

### 内容

tar.gz 内是被覆盖文件的**原始内容**（不是新版本内容），路径相对 `<target>`，例如：

```
docs/README.md
.pi/extensions/entire/index.ts
```

### 保留策略

- 本期**不自动清理**：每次 upgrade 都可能新增若干备份，由用户或后续 `pisquad restore` 子命令接管
- 备份文件本身**不纳入 git**（用户在 `<target>/.gitignore` 里忽略 `.pi/.pisquad/backups/`）

## 用户规则

- **不应手改 state.json**：手改后的内容 pisquad 不保证兼容；下次 install / upgrade 时会被整体覆盖
- state.json 与 backups/ 目录本身应纳入用户项目的 `.gitignore`（pisquad install 时应主动写一条 ignore 规则）
- 这两类内容**不算用户修改**：upgrader 做 sha256 diff 时，遇到它们不视为「用户改动」
- **升级 partial apply 语义**（0.1.1 之后，见 ADR [[architecture/decisions/0003-interactive-upgrade.md]]）：走决策层后，部分交互区文件可能被用户保留（keep / edit）。`state.version` 仍写新 assets 版本，**state 不反映逐文件一致性**；下次 upgrade 这些被保留的文件会以 modified 再次出现。warn 信息形如「kept N user modification(s) — they will reappear in next upgrade's diff」

## 与 git 协作

在 `<target>` 已初始化 git 仓库的情况下：

- `.gitignore` 应包含：
  ```
  .pi/.pisquad/
  ```
- 但**不**包含 `state.json` 之外的任何 pisquad 写入路径——pisquad 只往这一处写

> **嵌套 `.gitignore`（0.2.1）**：`writeState()` 会在 `.pi/.pisquad/.gitignore` 写入 `backups/`。该文件由 pisquad 自动管理，不存在时创建、已存在时不覆盖。根 `.gitignore` 仍使用 `.pi/.pisquad/` 忽略整个目录；嵌套规则作为防御深度，确保即便根规则被修改，backups 也不会被 git 追踪。

## 跨文档引用

- 决策依据：[[architecture/decisions/0001-pisquad-cli.md]]（升级基线）+ [[architecture/decisions/0003-interactive-upgrade.md]]（决策层叠加）
- 需求文档：[[prds/pisquad-cli.md]]
- 升级任务：`tasks/pisquad-cli/`（09 / 10 / 11 / 15）