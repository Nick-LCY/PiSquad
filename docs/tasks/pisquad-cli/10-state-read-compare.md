---
prd: ../prds/pisquad-cli.md
status: todo
---
# 任务：10 · version state 读取与比较

> 阶段 2 · upgrade 全套

## 目标

补全 `src/lib/version.ts` 的读取与比较子集：读 state.json、对比新旧版本、判断需要 update 的字段。这是 upgrade 命令（11）的前置依赖。

## 完成标准

- [ ] `src/lib/version.ts` 补：
  - `readState(target)`：读 `<target>/.pi/.pisquad/state.json`；缺失或损坏时抛错（含「not installed」语义，upgrade 命令据此退出）
  - `compareVersions(prev, next)`：返回 `VersionDiff`：
    ```ts
    {
      versionChanged: boolean,        // assets version 变了
      cliVersionChanged: boolean,     // 工具版本变了
      newChannels: Array<keyof Channels>,     // 包内有但 state 没有的（暂未启用）
      removedChannels: Array<keyof Channels>, // state 有但包内移除的
    }
    ```
  - `readAssetsVersion()`：读包内 `assets/.pi/assets-version.txt`（03 的 `assets.ts` 已有）
  - `readCliVersion()`：读 `package.json#version`
- [ ] 严格遵循 [[conventions/install-state.md]] 的 schema
- [ ] **不向后兼容验收**：旧项目（无 state.json）调用 `readState` → 抛 `StateMissingError`，upgrade 命令据此打印「未安装，请先 install」并退出非零

## 依赖

- 04 · state 写入
- 09 · diff 与 backup lib