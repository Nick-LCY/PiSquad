# 当前状态

> 高频变更的工作看板。**开始任何任务前先读这里。** 由团队维护。保持轻量——它是看板，不是叙事。

## 活跃需求
- （无）

## 任务看板
| Task | 状态 | 备注 |
|------|------|------|
| 新增 `pisquad` 安装脚本及 `.pi/.gitignore` 忽略规则 | done | 交互式部署 pi-squad 种子，支持可选 codegraph / entire 组件 |
| `pisquad` 支持 `curl \| bash` 一行安装 | done | 交互 read stdin 重定向到 `/dev/tty`；开头加 bash 守卫，非 bash 友好退出 |

## TODO / 阻塞
- [ ] 

## 最近变更
- 新增根目录 `pisquad`：交互式部署 pi-squad 种子，支持 GitHub tarball 主路径及浅克隆回退。
- 已完成依赖检查、覆盖保护与静态/不触网冒烟验证；端到端 happy path 待发布到 `main` 后人工验证。
- `pisquad` 改造以支持 `curl -fsSL ... \| bash` 一行安装：交互 read 重定向到 `/dev/tty` 解决管道下 EOF；shebang 后加 POSIX 兼容 bash 守卫，遇非 bash 友好提示并退出 1。
- 已通过 `bash -n`、dash 友好退出、PTY 交互冒烟（`q` 退出 0）、无终端安全失败验证；同步补齐覆盖 read 的 `\|\| exit 1` 与守卫提示 URL。