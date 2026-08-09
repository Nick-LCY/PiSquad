# 架构决策记录（ADR）

每个重要架构决策一个文件，命名 `NNNN-短标题.md`（如 `0001-采用文档驱动开发.md`）。

## 模板

```
# NNNN. 标题

- 日期：
- 状态：提议 | 已接受 | 已废弃
- 背景：（为什么需要这个决策）
- 决策：（决定了什么）
- 影响：（带来的后果）
```

## 清单
- [[architecture/decisions/0001-pisquad-cli.md]] — pisquad 升级为 npm 全局 CLI（语言/包名/分发/仓库结构/技术栈/upgrade 安全机制/docs diff/不向后兼容）
- [[architecture/decisions/0002-self-update-version-check.md]] — self-update 前比较版本，避免重跑死循环（hotfix 0.1.0→0.1.1）
