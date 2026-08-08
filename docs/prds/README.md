# 需求设计（PRD）

每个需求一个文件，放在本目录下，命名 `<feature>.md`。PRD 是任务拆分的输入。

## PRD 格式

```
# <需求名>

## 背景
为什么做这个。

## 目标
- 要达成什么

## 非目标
- 明确不做什么

## 方案
设计思路、关键决策。

## 验收标准
- [ ] ...
```

## 清单
- [[prds/pisquad-cli.md]] — 把 `pisquad` 从 bash 安装器升级为 npm 全局 CLI（含 upgrade 安全机制、docs diff 备份、entire bug 修复）
