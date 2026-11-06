# 已知问题

只维护这一份。修好一条就删一条，并在 `CHANGELOG.md` 记一句。完整彻查报告留在 `D:\小账本\文档\AI增强彻查-问题与修改方案.md`（L3，只读，含约 25 条 P3 细节）。

> 行号会漂移：按文件 + 符号/关键词 grep 定位，不要照抄旧行号。

## P1（已修）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| 1 | `js/modules/nl.js` 日期解析 | 「上个月28号」「本月5号」「下个月1号」丢日号，只剩相对月 | 已修于 2.27.1，回归见 `tests/nl-date.test.js` |
| 2 | `js/modules/nl.js` 日期解析 | 「明年1月5日」「去年12月25日」年份必错且无警告 | 已修于 2.27.1，回归见 `tests/nl-date.test.js` |
| 3 | `index.html` `runWipe`/`clearPrefs` | 清空本机数据不删 `xzb.ai.v1`，密钥与地址残留 | 已修于 2.27.1：接 `llmClearKey()`；回归见 `tests/ai-config.test.js` 用例 10 与 `tests/category-expansion.test.js` 用例 11 |
| 4 | `js/screens/settings.js` 测试连接 | 三条件合并，`apply()` 的具体报错被通用文案覆盖 | 已修于 2.27.1，回归见 `tests/ai-config.test.js` |

## P2（未修，按主题）

### A. 隐私口径

- `js/screens/insights.js` 告知文案称「不包含逐笔明细」，实际请求体含最多 10 条单笔记录（5 条大额异常支出 + 5 条一次性收入，各带日期、金额、分类名）。
- `js/screens/insights.js` 屏底 footNote 写死「不联网」，与同屏联网 AI 卡矛盾；应按是否渲染 AI 卡分流文案。
- 隐私文案三处互相矛盾：设置页说「只发当轮原话与账户名称」，实际还发分类清单；小助手告知卡又写「账户名称、分类名和统计口径」。
- `js/screens/assistant.js` `acceptNotice` 忽略 `llm.setConfig` 返回值：落盘失败仍显示「已同意」并发请求。

### B. 云端解析质量

- `js/modules/core-assistant.js` `LLM_MAX_TOKENS` 为 800，撑不住系统提示允许的 20 笔批次；超过约 15 笔确定性失败并整批回落本地。
- `js/modules/core-assistant.js` `mapNetError`：DNS 失败、拒连、CORS 全部映射 `E_NET_CONFIG`，配置正确的用户被误导去改配置。
- `js/modules/core-assistant.js` 分类清单只发「id 名称」不发 kind，模型只能猜收支方向；收入类目（工资/奖金/理财）云端分类收益被吃掉。

### C. 错误码与文案

- `js/screens/settings.js` `AI_ERR_TEXT` 缺 `E_AS_NET_RATE`；`E_AS_NET_OFFLINE` 是死键，断网实际显示「配置不合法，检查地址与模型名」。
- `js/modules/core-assistant.js` 5xx 映射成 `E_NET_RATE`（「服务繁忙/限流」），方向错误。

### D. 词表与解析边界

- `js/modules/core-assistant.js` LLM 分类词表 60 上限静默截断，按种子序取前 60；用户新建分类从第 61 类起进不了云端提示词。
- `index.html` `ca_aifee` 别名 8/8 已满：种子加到 9 条会让整库 `E_SCHEMA_INVALID` 加载失败；控制在 8 内则老库永远拿不到新别名。下次加词必须先做迁移。
- `js/modules/nl.js`「打车十分快」「充电十分方便」被解析成 0.10 元支出：`rawNum === '十'` 的「十分」应直接跳过。

### E. 助手交互

- `js/screens/assistant.js`「只用本地解析这一句」实际让整个会话静默本地（`noticeDeclined` 置位后 `shouldNotice` 恒 false），与按钮文案不符。

## P3（摘要，全文见报告）

- 传输层：`response_format` 硬编码、400 重试不剥它；`endpointOf` 盲拼 `/chat/completions`；非 2xx 不读 body；URL 最短 12 字符；`llmPlan` 死重试脚手架。
- 解读口径：信用卡取现既不算借款也不算还款；buffer 分子分母口径混合；`anomalies` 采集 note 无人消费；`aiFp` 指纹不含分类/预算；`gameTopup` 裸「游戏」误伤；加载文案「约 15 秒」实际最坏 90s。
- UI：20s 等待无取消；排队话语离屏被吞；深链 `#/settings/ai` 与 `#/settings` 混用；`configComplete` 只查非空；`iconOk` 白名单空转；`home.js` 情境开关无 UI；「显示密钥」名不副实。
- 解析边界：`午饭28打车15` 只记最后一笔；`1,2345` 坏千分位按 1234 收下；`EXTRA_ALIASES.ca_veg` 死条目，双词表已漂移。
- 测试基建：20+ 条源码字符串断言易误红；三套 harness 无共享 helper；用例 7.3 真睡 6.2s；CI 已补 GitHub Actions（跑 `scripts/test.js` + `scripts/check.js`）。