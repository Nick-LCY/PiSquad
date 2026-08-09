# tui-language 约定

> 本约定定义 pisquad CLI **面向终端用户**输出的语言规范：默认英文。配套见 PRD [[prds/pisquad-cli.md]] 与 ADR [[architecture/decisions/0003-interactive-upgrade.md]]。

## 范围

pisquad CLI 所有**面向终端用户**的输出文本，包括但不限于：

- `@inquirer/prompts` 的 `select` / `input` / `editor` 等：
  - `message`（顶部问题）
  - `name`（选项主标）
  - `description`（选项副标，`select` focus 时显示）
  - `short`（已选选项的回显）
- `logger.info` / `logger.warn` / `logger.error`（用户可见的提示语）
- `console.log` / `console.error`（用户可见的裸输出）
- spinner 文本（`@clack/prompts` 的 `spinner` message）
- help 文本（`pisquad help`、`--help` 输出）
- warn / error / summary 横幅文案
- 决策层选项（adopt / keep / edit、batch `Adopt all remaining (N)` / `Keep all remaining (N)`）

## 规则

1. **一律英文**。上述范围内的字符串字面量、模板字符串拼接的文本片段（含 `${remaining}` 这类动态部分），以及面向用户的运行时文案，全部使用英文。
2. **代码注释可中文**。`.ts` 文件顶部的 JSDoc、行内注释、变量命名上下文说明使用中文不影响终端用户，可保持中文以利于团队 review；但**不得**让中文出现在运行时输出的字符串拼接里。
3. **commit message / 文档 / ADR**：不在本约定范围，继续按既有规则（中文 / 英文视场景而定）。
4. **测试断言**：不在本约定范围；Vitest 测试用例的 `expect(...).toBe("...")` 走代码侧约定。

## 理由

- **国际化基础**：CLI 用户可能在任何 locale 的终端运行；英文是无意外默认
- **终端字体兼容**：等宽字体（尤其 PowerShell / Windows Terminal / SSH 远程主机）渲染中文常常字宽异常或缺失 glyph；英文无此问题
- **与既有英文 TUI 一致**：`pisquad install` 的 inquirer 文案（`Choose channels to install` / `Where to install?`）、logger warn / summary、`pisquad --help` 等已是英文；本次决策层 select 选英文只是把这条隐式约定显式化

## 例外

- 无（hard rule）。如确有本地化需求，由后续 ADR 引入 i18n 子系统后再放宽；当前**不**为单条文案单独开口子。

## 跨文档引用

- 决策依据：[[architecture/decisions/0003-interactive-upgrade.md]] §3（决策层 select 选项文案）+ ADR `0001` 的命令表面（`pisquad help` 等）
- 需求文档：[[prds/pisquad-cli.md]]
- 升级任务：`tasks/pisquad-cli/15-interactive-upgrade.md`