# 架构

## 形态

单页 PWA：无构建、无依赖、无后端。`main` push 即发布（GitHub Pages）；所有源文件在仓库根，没有 `src/`、没有打包产物。

数据只在本机：IndexedDB + localStorage。没有账号，没有服务端存储。

## 启动链

1. `index.html` 解析内嵌的 chunk-manifest（搜 `js/chunk-manifest.js`），决定首屏需要哪些 chunk。
2. 按需注入 `js/screens/*.js` 与 `js/modules/*.js`，统一挂到 `XZB` 命名空间。
3. hash 路由切屏（`#/home`、`#/bills`、`#/settings` 等）；屏幕模块自己渲染、绑定事件。
4. `sw.js` 按 manifest 预缓存；`CACHE_NAME` 一变，旧缓存被清。

## 数据

- IndexedDB 库名 `xzb2`（`index.html` 搜 `DB_NAME`），三个 store：`STORE_STATE`（键值状态：账目、账户、分类、预算等）、`STORE_SNAPSHOTS`（自动快照）、`STORE_PHOTOS`（票据照片）。
- schema 校验 `validateDb`、分类目录补齐 `mergeSeedCategories` 都在 `index.html`；改 schema 时两处一起看。
- localStorage：`xzb.ui.v2` 存 UI 状态；`xzb.ai.v1` 存 AI 配置（地址、模型、密钥、隐私告知状态）；`xzb.cloud.v1` 存云备份配置（GitHub 密钥、gistId、同步基准）。清空本机数据必须三者都清。

## AI 链路

- UI：`js/screens/assistant.js`（说话记账）、`js/screens/insights.js`（月度解读卡）、`js/screens/settings.js`（AI 配置页）。
- 传输与错误码：`js/modules/core-assistant.js`。密钥只出现在 `Authorization` 头；错误码统一 `E_AS_*`。
- 指标与提示词：`js/modules/ai-insights.js`（`buildMonthlyMetrics`、`requestAiInsights`、`toInsightPayload`、`buildFallbackInsights`、`buildLocalSummary`）。月中总量与分类都使用上月同期；免模型月报与 AI 请求共用同一聚合结果，不各算一套。
- 本地解析：`js/modules/nl.js`（金额、日期、分类别名）；没有模型时全靠它。

## 云备份（2.34.0）

- 威胁模型：iOS 主屏幕 Web 应用存储独立于 Safari，删图标即清数据（WebKit 隔离机制）——本地快照/软删都挡不住「删应用」，唯一可靠出路是手机外副本。
- 选型：用户自己的 GitHub 私有 Gist。GitHub REST API 官方支持任意源 CORS，零后端；账号复用（应用本就发布在 GitHub Pages）。否决过：每笔整库快照（`pruneSnapshots` 用 getAll 一次读入 ≤30 份完整 payload，每笔触发瞬时内存约 30× 库大小）、WebDAV（坚果云无 CORS）、自动下载（iOS 每次下载都要用户手势）。
- 代码：`index.html` 内联块 `js/core/cloud-sync.js`（挂 `XZB.Core.cloudSync`），UI 在 `js/screens/settings.js` 的 `openCloudSheet`。配置键 `xzb.cloud.v1`。
- 不另造格式：payload = `backup.export('json')`，恢复 = `store.import(text, {mode:'replace'})`（自带 pre-import 快照 + 校验 + 回滚 + 照片回填）。
- 调度：`store.subscribe` → 3s 防抖合并 + busy/pending 单飞（仿 backup.js 快照调度器）；`savedAt === lastSyncedSavedAt` 去重防恢复回声；pagehide/visibilitychange  best-effort keepalive flush（≤64KB）。
- 覆盖保护：`gist.updated_at` 晚于本机 `lastSyncAt`（+1s 时钟容差）⇒ 暂停自动覆盖；新配置（重装后 lastSyncAt 为空）绝不自动上传；手动「立即备份」force 绕过。
- 照片阈值：`photoStats().bytes ≤ 2MB` 才随备份带照片，超限或照片段失败自动降级纯账目；整份 >9MB 拒传（Gist >10MB REST 取不回）。
- 截断规则：Gist GET 单文件 >1MB 截断，`truncated:true` 时走 `raw_url` 取全文。
- 默认关闭、零网络：未填密钥不开启则无任何出站；开启后数据只进用户自己的私有 Gist，符合「本地优先 + 出站先过隐私告知」铁律。

## 发布与不变量

- 版本三处：`index.html` 的 `XZB.version`、`sw.js` 的 `CACHE_NAME`/`CACHE_LABEL`、`tests/category-expansion.test.js` 7.1/7.2 的转义正则。
- 缓存名必须随版本变，否则用户永远停在旧 SW。
- `tests/` 是唯一回归防线：改行为必须同批改测试；`scripts/check.js` 只守机械一致性。

## 有意为之的取舍

- 单文件巨型 `index.html`：历史原因，换来零构建和直接 Pages 发布；新逻辑尽量放 `js/modules/`。
- 无第三方依赖：测试用纯 node 断言，脚本用 node 内置模块。
- 本地优先：任何要出网的能力都必须先过隐私告知，默认关闭。