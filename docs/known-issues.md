# 已知问题

只维护这一份。修好一条就删一条，并在 `CHANGELOG.md` 记一句。完整彻查报告留在 `D:\小账本\文档\AI增强彻查-问题与修改方案.md`（L3，只读，含约 25 条 P3 细节）。

> 行号会漂移：按文件 + 符号/关键词 grep 定位，不要照抄旧行号。

## 已修（存档）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| 1 | `js/modules/nl.js` 日期解析 | 「上个月28号」「本月5号」「下个月1号」丢日号，只剩相对月 | 已修于 2.27.1，回归见 `tests/nl-date.test.js` |
| 2 | `js/modules/nl.js` 日期解析 | 「明年1月5日」「去年12月25日」年份必错且无警告 | 已修于 2.27.1，回归见 `tests/nl-date.test.js` |
| 3 | `index.html` `runWipe`/`clearPrefs` | 清空本机数据不删 `xzb.ai.v1`，密钥与地址残留 | 已修于 2.27.1：接 `llmClearKey()`；回归见 `tests/ai-config.test.js` 用例 10 与 `tests/category-expansion.test.js` 用例 11 |
| 4 | `js/screens/settings.js` 测试连接 | 三条件合并，`apply()` 的具体报错被通用文案覆盖 | 已修于 2.27.1，回归见 `tests/ai-config.test.js` |
| 5 | `js/modules/core-assistant.js` 传输层 | DNS/拒连/CORS 误报「未启用在线模型」、5xx 误报「限流」、断网无独立码（`E_AS_NET_OFFLINE` 死键） | 已修于 2.28.1：`reason` 细分（net/server/offline）+ 独立断网码；回归见 `tests/ai-config.test.js` 用例 13 |
| 6 | `js/modules/core-assistant.js` 云端词表 | 分类清单不带收支方向；60 上限按数组序截断、先砍用户自建分类 | 已修于 2.28.1：`pairText` 标注 `[收入|支出]`、`categoryPairs` 系统保底 + sort 排序；回归见 `tests/category-expansion.test.js` 用例 12 |
| 7 | `index.html` 种子别名 | `ca_aifee` 8/8 双向陷阱：加词判坏整库 / 老库永远拿不到新别名 | 已修于 2.28.1：`mergeSeedCategories` 同 id 回填缺失别名（≤8、不复活摘除词）+ `catalogNeedsSync` 按缺别名判定；回归见 `tests/category-expansion.test.js` 用例 13 |
| 8 | `js/screens/assistant.js` | 「只用本地解析这一句」实际整会话静默本地 | 已修于 2.28.1：按句生效；回归见 `tests/ai-config.test.js` 用例 12 |

## 待办（P3 摘要，全文见报告）

- 传输层：非 2xx 读 body 的进一步细分（404/405 等仍归 config，仅 401/403 已点名密钥）；LLM 词表上限 60 升到 80 的评估（截断排序 2.28.1 已修，上限本身未动）。
- 解读口径：buffer 分子（跨账本全历史余额）与分母（单账本月必要支出）口径混合，需产品定口径。
- UI：`home.js` 情境入口开关只有读取、没有 UI（注释自称「我的里可关」未兑现）——补开关或删死码，需产品定。
- 解析边界：`午饭28打车15` 只记最后一笔，候选列表无 28 的备选（多候选需改解析器产出）；core-assistant `EXTRA_ALIASES` 与 nl.js 双词表仍有零星漂移（`ca_veg` 死键已于 2.28.2 改正为 `ca_veggie`）。
- 测试基建：20+ 条源码字符串断言易误红；harness 无共享 helper；CI 已补 GitHub Actions（跑 `scripts/test.js` + `scripts/check.js`）。

## 已修（2.28.2 批次 3 存档）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/modules/core-assistant.js` `httpOnce` | 端点不认 `response_format`/`enable_thinking` 时永久 400 | `tests/ai-config.test.js` 用例 14 |
| `js/modules/core-assistant.js` `endpointOf` | 粘贴完整端点 URL 双拼 `/chat/completions` → 404 | 用例 14.4 |
| `js/modules/core-assistant.js` `mapStatus` | 401/403 坍缩成「配置不合法」，不点名密钥 | 用例 14.3 |
| `js/modules/core-assistant.js` `aiLoopbackHost`/`aiNormalizeURL` | 回环豁免缺 `[::ffff:127.0.0.1]`/`localhost.`；最短 12 字符拒掉 `http://a.io` | 用例 14.5/14.6 |
| `js/modules/core-assistant.js` `EXTRA_ALIASES` | `ca_veg` 是 `ca_veggie` 改名残留，买菜/菜市场永远路由失败 | `tests/category-expansion.test.js` 用例 15.1 |
| `js/modules/ai-insights.js` | 信用卡取现不计新增透支（漏判以贷养贷）；`anomalies` 采集 note 无消费方；裸「游戏」误伤；prompt 无 null 语义；txCount 含转账（纯转账月仍发请求） | `tests/ai-insights.test.js` 用例 6 |
| `js/screens/insights.js` | `aiFp` 指纹不含预算/必要支出（改预算不提示过期）；加载文案「约 15 秒」实际最坏 90s | 源码级/文案 |
| `js/screens/assistant.js` | 20s 云端等待无取消出口；排队话语离屏被吞；深链混用 | 用例 12/14 + 源码级 |
| `js/screens/settings.js` | `configComplete` 只查非空（非法地址可开开关）；「显示密钥」名不副实 | 源码级 |
| `index.html` `iconOk` | 白名单守卫引用不存在的 `UI.icons.NAMES`，形同虚设 | `tests/category-expansion.test.js` 用例 15.2 |
| `js/modules/nl.js` | `1,2345` 坏千分位按 1234 元静默收下 | `tests/nl-date.test.js` 用例 5.10 |
| `tests/ai-config.test.js` 用例 7.3 | 真睡 6.2s 占套件 97% 耗时 | 已换等比缩时桩（100×） |