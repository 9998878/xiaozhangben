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
- localStorage：`xzb.ui.v2` 存 UI 状态；`xzb.ai.v1` 存 AI 配置（地址、模型、密钥、隐私告知状态）。清空本机数据必须两者都清。

## AI 链路

- UI：`js/screens/assistant.js`（说话记账）、`js/screens/insights.js`（月度解读卡）、`js/screens/settings.js`（AI 配置页）。
- 传输与错误码：`js/modules/core-assistant.js`。密钥只出现在 `Authorization` 头；错误码统一 `E_AS_*`。
- 指标与提示词：`js/modules/ai-insights.js`（`buildMonthlyMetrics`、`requestAiInsights`、`toInsightPayload`）。
- 本地解析：`js/modules/nl.js`（金额、日期、分类别名）；没有模型时全靠它。

## 发布与不变量

- 版本三处：`index.html` 的 `XZB.version`、`sw.js` 的 `CACHE_NAME`/`CACHE_LABEL`、`tests/category-expansion.test.js` 7.1/7.2 的转义正则。
- 缓存名必须随版本变，否则用户永远停在旧 SW。
- `tests/` 是唯一回归防线：改行为必须同批改测试；`scripts/check.js` 只守机械一致性。

## 有意为之的取舍

- 单文件巨型 `index.html`：历史原因，换来零构建和直接 Pages 发布；新逻辑尽量放 `js/modules/`。
- 无第三方依赖：测试用纯 node 断言，脚本用 node 内置模块。
- 本地优先：任何要出网的能力都必须先过隐私告知，默认关闭。