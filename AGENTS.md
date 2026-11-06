# AGENTS.md

小账本：本地优先记账 PWA。无构建、无后端，数据存在浏览器 IndexedDB，`main` 分支直接发布到 GitHub Pages。源文件全在仓库根，没有 `src/`。

## 命令

- `node scripts/status.js` — 接手先跑：版本、分支、脏文件、测试、最近提交
- `node scripts/test.js` — 跑 `tests/*.test.js`，必须全绿
- `node scripts/check.js` — 提交前自检：版本三处、AGENTS 长度、文档指针、旧文档残留
- 发布：push `main` 后 Pages 自动更新（约 1 分钟），清单见 `docs/release.md`

## 地图

- `index.html` — 整个应用：启动、hash 路由、账户/设置、IndexedDB schema；内嵌 chunk-manifest，首屏按需加载
- `js/screens/` — 页面：home、ledger、stats、accounts、plan、add、settings、assistant、insights、books
- `js/modules/` — 共用逻辑：core-assistant（LLM 传输与错误码）、ai-insights（月度指标与提示词）、nl（中文解析）、charts、keypad、icon-picker
- `sw.js` — Service Worker，按 chunk-manifest 预缓存
- `tests/` — 纯 node 断言，无框架；`scripts/` — 开发脚本
- `docs/` — 按需查：`architecture.md`、`known-issues.md`、`release.md`
- `CHANGELOG.md` — 版本历史；`README.md` — 用户视角

## 不变量（`scripts/check.js` 会红）

1. 版本三处同步：`index.html` 的 `XZB.version`、`sw.js` 的 `CACHE_LABEL`/`CACHE_NAME`、`tests/category-expansion.test.js` 用例 7.1/7.2 的转义正则。换缓存名才会清旧缓存。
2. 改应用行为，同批加/改测试并全绿；只改文档可跳过。
3. 发布只从 `main` push；feature 分支合并后删除。

## 多 agent 并行

- 开工先 `git status`：别人未提交的改动不碰、不提交、不回滚。
- 各自开 `agent/<名字>-<任务>` 分支；收尾只 `git add` 自己的文件。
- 状态不明或冲突就停下报告，不要猜。

## 记录（不建过程文档）

- commit message 用 `fix:`/`feat:`/`docs:`/`release:`，正文写「为什么」；末尾署名 `Agent: <名字>`。
- 行为或版本变化写 `CHANGELOG.md`；设计取舍写 `docs/architecture.md`；已知问题只维护 `docs/known-issues.md`。
- 状态以 `scripts/status.js` 和 git 为准，不另建进度文件。