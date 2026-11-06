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

- 传输层：`response_format` 硬编码、400 重试不剥它；`endpointOf` 盲拼 `/chat/completions`；非 2xx 不读 body；URL 最短 12 字符；`llmPlan` 死重试脚手架；LLM 词表上限 60 升到 80 的评估（截断排序 2.28.1 已修，上限本身未动）。
- 解读口径：信用卡取现既不算借款也不算还款；buffer 分子分母口径混合；`anomalies` 采集 note 无人消费；`aiFp` 指纹不含分类/预算；`gameTopup` 裸「游戏」误伤；加载文案「约 15 秒」实际最坏 90s。
- UI：20s 等待无取消；排队话语离屏被吞；深链 `#/settings/ai` 与 `#/settings` 混用；`configComplete` 只查非空；`iconOk` 白名单空转；`home.js` 情境开关无 UI；「显示密钥」名不副实。
- 解析边界：`午饭28打车15` 只记最后一笔；`1,2345` 坏千分位按 1234 收下；`EXTRA_ALIASES.ca_veg` 死条目，双词表已漂移。
- 测试基建：20+ 条源码字符串断言易误红；harness 无共享 helper；用例 7.3 真睡 6.2s；CI 已补 GitHub Actions（跑 `scripts/test.js` + `scripts/check.js`）。