# 发布验证约定

> L4 发布物 e2e 验证门。本约定定义 `pisquad` 发布前、以及新增 / 调整任何 core extension 时必须过的端到端验证链，以及由此沉淀的反模式（测试 fixture 不得镜像生产硬编码清单）。

## 范围

- 每次 `npm publish`（含 hotfix）**之前**
- 每次新增 core extension（`assets/.pi/extensions/<new>/`）**合并之前**
- 每次调整任何 core extension 的 `pkgSubPath` / `targetSubPath` 路径映射

## 验证门（四步，必须全过）

### 1. 打包（`npm pack`）

```
npm pack
```

产出 `<pkg-name>-<version>.tgz`。**不允许**直接 publish——必须先看清单。

### 2. 解包（内容核对）

把 tarball 解到临时目录（**不要**用 `--dry-run` 跳过这一步——dry-run 列表与实际 tar 内容偶有出入）：

```
mkdir -p /tmp/pisquad-verify-XXXX
tar -xzf <tgz> -C /tmp/pisquad-verify-XXXX
```

**断言**：

- 临时根下存在 `package/`（npm tar 自带顶层目录），进入后可见 `dist/`、`assets/`、`README*.md`、`LICENSE`、`pisquad`（bash bootstrap 已在 0.2.1 移除，本条仅对 0.2.0 及之前相关）
- **不存在** `src/`、`node_modules/`、`.pi/`、仓库根 `docs/`（被 `.npmignore` 排除）
- `assets/.pi/extensions/` 下**每一个** core 扩展都有 `index.ts`

### 3. install（端到端落盘）

在另一个临时目录跑**真实** install：

```
mkdtemp /tmp/pisquad-install-XXXX
node dist/bin.js install --yes "$TMP"
```

**断言**（每条都是硬要求）：

- 退出码 = 0
- `<tmp>/.pi/extensions/<name>/index.ts` 对**每一个** core 扩展名存在
- `<tmp>/.pi/extensions/<name>/index.ts` 源文件含其关键标识常量（防止被空文件替换通过 assertion）

### 4. 入口加载（断言扩展能跑起来）

启动 pi host（或 fake pi shim）一次性 `import` 每个 core 扩展的 `index.ts`，断言：

- 无 import / parse 错误
- 关键 export（如 `bash-guard` 的 `resolveDefaultTimeoutS` / `DEFAULT_BASH_TIMEOUT_S`、`subagent` 的 `default`）存在且类型正确

> 当前实现：`test/install/core-extension-manifest.test.ts` 覆盖步骤 1–3 的 install 端到端；步骤 4 的「入口加载」由各自扩展的单元测试承担（`test/subagent/suspensions.test.ts`、`test/subagent/bash-guard.test.ts` 等）。**新增 core 扩展必须配套写步骤 4 的单元测试，否则不允许合并。**

## 新增 core 扩展的契约

新增 `assets/.pi/extensions/<new>/` 时，必须**一次性**改齐以下位置：

| # | 位置 | 改动 |
|---|------|------|
| 1 | `src/lib/plugins/core.ts` `EXTENSION_DIRS` | 加 `<new>`（**唯一清单 / install 端**；已 `export`，被 #2、测试、L4 manifest 测试共同 import） |
| 2 | `src/commands/upgrade.ts` `includes` 数组 | **无需手动维护**——已 `import { EXTENSION_DIRS } from "../lib/plugins/core.js"` 并在构造 `includes` 时 `...Array.from(EXTENSION_DIRS).map((sub) => ({ pkgSubPath: `.pi/${sub}`, targetSubPath: `.pi/${sub}` }))` 派生 |
| 3 | `test/install/core-extension-manifest.test.ts` | 断言循环**自动覆盖**（以 `EXTENSION_DIRS` 为源循环），并断言关键常量存在 |
| 4 | `test/upgrade/manifest.test.ts` | 断言循环**自动覆盖**（同源 `EXTENSION_DIRS`），端到端验证 upgrade 路径同样落盘 |
| 5 | `test/<新扩展>/` | 新增单元测试，覆盖入口加载（步骤 4） |
| 6 | `docs/architecture/overview.md` Extensions 表 | 加一行扩展说明 |
| 7 | `docs/architecture/decisions/`（必要时） | 重大架构决策新增 ADR |
| 8 | `docs/current-state.md` 最近变更 | 加变更条目 |

**单源派生（0.3.1 返工后）**：core 扩展集合在 `core.ts` 的 `EXTENSION_DIRS` 是**唯一事实来源**——`upgrade.ts` 的 `includes`、install 侧 L4 测试、upgrade 侧 L4 测试都从同一份 `EXTENSION_DIRS` 派生，因此「install 与 upgrade 漏一边」这个 0.3.1 bug 的根因结构上消失。**新增 core 扩展只需改 #1**，#2–#4 自动跟进。仍需人盯的：#5（新增扩展要写自己的单测）、#6/7/8（文档同步）。

**已废弃（0.2.1）**：bash bootstrap 脚本与 `curl | bash` 入口；本约定的 install 路径全部基于 `pisquad install`。

## 反模式：测试 fixture 镜像生产硬编码清单（0.3.1 教训记录）

### 历史现场（0.3.1 bug 出现时）

`test/upgrade/decision.test.ts` 当时有一段 fixture：

```
const MANAGED_INCLUDES: PkgInclude[] = [
  { pkgSubPath: ".pi/extensions/subagent", ... },
  { pkgSubPath: ".pi/extensions/wikilink-lint", ... },
  // <bash-guard 应在这里——fixture 过旧>
];
```

这是**反模式**，因为：

1. **fixture 与生产代码是两份独立的事实来源**——fixture 写死一次后，生产改 `upgrade.ts` 加 `bash-guard`，fixture 不会自动跟新
2. 单测照过：fixture 缺 `bash-guard` 不影响 decision 层测试用例的输入/输出契约，red/green 信号丢失
3. 单元测试通过 ≠ 发布物正确：端到端落盘这一层没有任何 fixture 镜像的兜底

0.3.1 bug 正是因此逃逸单测层——fixture 镜像生产清单的「写一次就过」形式让决策层测试在 `bash-guard` 缺失时仍 green，端到端层没有任何测试。

### 当前实现（0.3.1 返工后）

fixture 改为**从生产 import 派生**：

```ts
import { EXTENSION_DIRS } from "../../src/lib/plugins/core.js";

const MANAGED_INCLUDES: PkgInclude[] = Array.from(EXTENSION_DIRS).map((sub) => ({
  pkgSubPath: `.pi/${sub}`,
  targetSubPath: `.pi/${sub}`,
}));
```

`EXTENSION_DIRS` 已 `export`，fixture 与生产同源——生产侧漏加 / 错加 `bash-guard` 时，fixture 自动同步翻转，单测与端到端都看得到 red。**两套清单漂移的结构性风险**随之消失：不再有「一份生产清单、一份镜像清单」的概念，只有一份源 + 派生者。

### 原则（适用于后续任何测试 fixture）

测试 fixture 不得硬编码镜像生产清单。允许的三种形式：

| 形式 | 适用场景 | 例子（本仓实现） |
|------|---------|------------------|
| **从生产代码 export** | 生产侧本来就要 export 的清单 | `core.ts` 的 `EXTENSION_DIRS` 已 `export`；`test/upgrade/decision.test.ts` 的 `MANAGED_INCLUDES` = `Array.from(EXTENSION_DIRS).map(...)`，从生产 import；`test/install/core-extension-manifest.test.ts` 与 `test/upgrade/manifest.test.ts` 也以 `EXTENSION_DIRS` 为源循环断言 |
| **断言两端清单一致** | install 清单与 upgrade 清单各自封闭、需强制同步 | 返工后已不需要——install 与 upgrade 共用 `EXTENSION_DIRS`，不存在「两端」。仅当未来出现真独立的清单时才走此形式 |
| **端到端 e2e 断言** | 不能依赖中间 fixture | `test/install/core-extension-manifest.test.ts`（spawn `node dist/bin.js install --yes <tmp>` 后断言 `<tmp>/.pi/extensions/<name>/index.ts` 落盘 + `DEFAULT_BASH_TIMEOUT_S` 常量存活）+ `test/upgrade/manifest.test.ts`（in-process `upgradeCommand` + fake `DecisionDeps`，断言 `<target>/.pi/extensions/<name>/index.ts` 落盘） |

任一新增 core 扩展**不得**走「在测试 fixture 里硬编码一份镜像清单」这种形式——新增 core 扩展的 L4 覆盖由 #1（`EXTENSION_DIRS`）+ #3/#4（基于它的断言循环）自动跟进，不需要人手动同步。

## 跨文档引用

- 决策依据：ADR [[architecture/decisions/0001-pisquad-cli.md]] 第 7 条（CLI 版本 vs assets 版本独立，hotfix 最小颗粒）+ ADR [[architecture/decisions/0003-interactive-upgrade.md]]（管理区 `.pi/extensions/**` 始终覆盖，扩展是发布物一部分）
- 验证门落地：
  - `test/install/core-extension-manifest.test.ts`（spawn `node dist/bin.js install --yes <tmp>` 端到端断言三扩展落盘 + `DEFAULT_BASH_TIMEOUT_S` 常量存活；refuses-to-fallback-to-tsx 的「L4 必须 fresh build」守门）
  - `test/upgrade/manifest.test.ts`（0.3.1 返工新增；in-process `upgradeCommand` + fake `DecisionDeps`，断言 upgrade 路径同样落盘所有 core 扩展 + bash-guard 关键常量存活——与 install 侧镜像）
  - `test/subagent/`（bash-guard / subagent 各自的入口加载断言）
  - `package.json` `"pretest": "npm run build"` 钩子（0.3.1 返工新增；强制 fresh dist，保证 install 端 L4 测试看不到「旧 dist 过、新 src 不过」的伪绿）
- 触发本次约定的事件：`docs/current-state.md` 最近变更最新条目（0.3.1 `bash-guard` 同步清单修复；返工后改走「单源派生」路线，详见上文「反模式」章节）