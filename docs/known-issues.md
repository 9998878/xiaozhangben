# 已知问题

只维护这一份。修好一条就删一条，并在 `CHANGELOG.md` 记一句。完整彻查报告留在 `D:\小账本\文档\AI增强彻查-问题与修改方案.md`（L3，只读，含约 25 条 P3 细节）。

> 行号会漂移：按文件 + 符号/关键词 grep 定位，不要照抄旧行号。

## 内置默认 AI 服务（2.41.0，有意为之，不是 bug）

- **密钥公开**：按所有者要求，千问 MaaS 端点 + `qwen4-max` + 密钥直接内置在公开仓库（`js/modules/core-assistant.js` `AI_DEFAULT_SERVICE`），任何打开页面的人都能在源码里看到并调用这把密钥，免费余量可能被陌生人刷掉。这是「手机零配置即用」的固有代价；介意者在「我的→助手→在线模型」换自己的密钥即可（自定义配置不会被播种覆盖）。
- **默认开启 + 默认同意隐私告知**：首次运行由启动链 `seedDefaultAiService()` 调 `llm.seedDefaultService()` 播种，默认 `enabled:true` 且 `noticeAt>0`，等于替首次打开的人默认同意把当轮原话/账户名/分类名发给该服务。所有者明确选择此口径。2.41.1 起旧内置免费档（OVH 免密钥）随启动升级到新默认服务并保留开关/告知；自定义配置幂等不覆盖。
- **余量受限**：该密钥当前仅 `qwen4-max` / `deepseek-v4.1-flash` 有免费余量，其余模型 403（额度用完/未开通）。两者默认会思考，故三条出站口均带 `enable_thinking:false`；端点不认时 400 剥字段重试。余量耗尽后在线请求归 `E_AS_NET_CONFIG`，小助手/解读回落本地。
- **README 已同步（2.44.1）**：隐私段已改为「默认开启 + 首启视为同意 + 密钥公开 + 第三方端点 + 可关闭」的真实口径，不再声称默认关闭。端点域名 `maas.qianwenaiapi.com` 非阿里官方 dashscope 域名，归属仍需所有者核实。

## 已修（2.38.1 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/modules/nl.js` `scanArabicAmounts` | 数字后紧跟 ASCII 字母被当成金额：「3D电影」记 3 元、「2K显示器」记 2 元、「1w」记 1 元；小助手极速直记默认开，说得清就直接入账。旧版只挡了字母在前的（`iPhone15`） | `tests/nl-alnum-amount.test.js` 用例 1 |
| `js/modules/nl.js` 阿拉伯量级分支 | 只有万/千/百，漏「亿」：「1亿」记 1 元，「2亿5」记 5 元 | 同文件用例 2 |
| `js/modules/nl.js` 相对日期词 | 「大后天」只匹配到「后天」：日期差一天，备注残留一个「大」 | 同文件用例 3 |
| `scripts/status.js` | 没装 git 时第一条命令抛 `spawnSync git ENOENT`，接手命令整个崩掉，测试汇总也出不来 | `tests/scripts-status.test.js` |
| `README.md` | 停在 2.18.0：文件数、隐私说明（「没有请求外发」与 2.34 云备份 / 在线模型不符）、仓库定位（说源码不在本仓库）全失真；`AGENTS.md` 模块地图漏 `habit.js`、`bill-import.js` | `scripts/check.js` 新增对账（版本标题、页面/模块文件数、预缓存项数、地图覆盖） |

## 剩余解析边界（有意不做，不是 bug）

- `打车1w` / `打车1k` 不换算成万/千：`15W充电器`（瓦）、`2K显示器`（分辨率）比「花 1w」常见得多，一律判「没听清金额」让用户重说。
- `1兆`、中文数字接 `亿` 以外的口语量级不扩展。

## 云备份边界（2.34.0，有意为之，不是 bug）

- **强杀最后一笔**：记完立刻强杀应用，3s 防抖内的最后一笔可能没传走；pagehide 的 keepalive 补传只覆盖 ≤64KB 的 payload，更大的等下次启动/回前台自动补。
- **照片 >2MB 不含**：照片总字节超过 2MB 时自动降级为纯账目备份（base64 放大 + Gist 单文件 REST 取回上限 10MB）；状态行不单独报，设置 sheet 的云端笔数照常。恢复纯账目备份到已有照片的设备时，replace 导入会以备份照片段为准（本机照片有 pre-import 快照兜底）。
- **重装要重填密钥**：iOS 删主屏幕应用连 localStorage 一起清，密钥随之消失；恢复前必须重填同一把密钥（建议用户存备忘录/密码管理器）。这是无后端方案的固有代价。
- **单设备口径**：覆盖保护只比 gist.updated_at 与本机上次成功备份时间，不做多设备合并；两台设备交替写会触发「云端较新」暂停，需用户手动裁决。
- **GitHub 网络波动**：国内访问 api.github.com 偶发超时/失败，统一归 E_CLOUD_NETWORK，下次写入或回前台自动重试，不弹错误。

## 已修（2.32.7 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/screens/add.js` 属性栏 | 手动记账仍有「选择账户 / 选择转入账户」chip 和账户 sheet，转账还要选转入账户 | `tests/accountless-ui.test.js` 1.1/1.2 |
| `js/screens/plan.js` 定期计划表单 | 仍有账户 / 转入账户下拉，保存时提示「请选择账户」 | `tests/accountless-ui.test.js` 2.1 |
| `js/screens/settings.js` 账单导入预览 | 仍有「记入账户」下拉，导入前要手动选账户 | `tests/accountless-ui.test.js` 2.2 |
| `js/screens/ledger.js` 筛选 sheet | 仍有账户分组和账户 chips，已启用筛选里也有账户项 | `tests/accountless-ui.test.js` 2.3 |

## 已修（2.32.6 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `core-assistant.js` 空态/取消提示、`nl.js` 缺金额错误、`chatSystemText` | 还在举例「午饭 35 微信」，用户能看到账户名 | `tests/assistant-direct.test.js` 用例 1.8 |
| `core-assistant.js` `previewRows`/查询/`previewEdit` | 仍产出 `accountText / toAccountText` 显示字段，界面虽不读但源码仍带账户名 | `tests/ai-preset.test.js` 4.6、`tests/assistant-direct.test.js` 1.7 |

## 已修（2.32.5 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/screens/assistant.js` `recordedRowText`/`previewTable`/`targetList`/`QUICK_EXAMPLES` | 账户选择删掉后，成功气泡和预览仍显示默认账户「微信」，用户以为账户选择还在 | `tests/assistant-direct.test.js` 用例 1.7 |

## 已修（2.32.4 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/modules/core-assistant.js` `buildItem`/`normalizeLlmItem`/`buildPending`/`answerClarify` | 助手会为「转账500」追问转入账户并弹账户选项；用户明确说账户不重要 | `tests/assistant-state.test.js` 用例 2、`assistant-state-remote.test.js` |
| `js/modules/core-assistant.js` `respond`/`switchToNewEntry` | 补问没答完时来了一句完整新账，仍弹「继续编辑/放弃」二选一，显得瞻前顾后 | 同文件 `switchToNewEntry` 源码锁 |

## 已修（2.32.3 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/screens/assistant.js` `submit`/`replyOptions`/`optionChips`/`targetList` | 点「继续编辑上一批 / 放弃并重新解析」后，聊天记录把内部值 `keep`/`drop` 原样上屏；账户 id、交易 id 同理 | `tests/assistant-direct.test.js` 用例 1.6 |

## 已修（2.32.2 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/modules/core-assistant.js` `respond`/`answerClarify`/`tryResume` | 补问或草稿未完成时，任何新句子都被当成旧问题的回答；「烟14.09」会被反复追问「转到哪个账户」，冲突气泡的 keep/drop 按钮点了没反应，无法退出 | `tests/assistant-state.test.js` |
| `js/modules/core-assistant.js` `sysPromptLines` | 云端对「烟14.09」这类「物品名+数字」过度追问「14.09 是什么意思/是多少钱」（实测 Llama 8.6s 返回 need_clarify） | 同文件提示词断言 + 真机复验 |

## 已修（2.32.1 批次）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `js/modules/core-assistant.js` `AI_PRESET`/`modelChainOf` | 备用 Qwen3.5-9B 已变推理模型，12s 解析上限内拿不到内容；主模型 429 切过去会空等 12s，再误报「网络超时」 | `tests/ai-preset.test.js` 用例 1.1c/1.1d |
| `js/modules/core-assistant.js` `llmTest` | HTTP 200 但 content 空 / `finish_reason=length` 也报「连接正常」（假阳性） | 用例 5.7 |
| `js/modules/core-assistant.js` `llmPlan` | 失败路径丢 `res.reason`，429 被下游按 `NET_TIMEOUT` 误报成超时 | 用例 1.1c/1.1d |

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

- 传输层：LLM 词表上限 60 升到 80 的评估（上限本身未动；2.38.0 已把 `fitBody` 改精确裁剪 + 使用频度排序，截断丢词表的伤害已缓解）；重试次数维持 R-04 决定的 0 次。
- 解读口径：buffer 分子（跨账本全历史余额）与分母（单账本月必要支出）口径混合，需产品定口径。
- UI：`home.js` 情境入口开关只有读取、没有 UI（注释自称「我的里可关」未兑现）——补开关或删死码，需产品定。
- 解析边界：多笔无分隔已于 2.38.0 保守拆分（每段都落已知分类才拆）；剩余歧义——物品名+数字（如 `ChatGPT25`）按 ASCII 边界语义不拆（与 nl 同口径），单段多候选金额仍取「最后一个候选」口径。
- 测试基建：580+ 处源码字符串断言易误红（2.44.1 起新增回归优先行为级：sw-cache / csv-export / bill-dupe；2.44.1 后补 books / recurring-engine / migrate-upgrade / goals 四组盲区行为测试，验收报告 P2-5 的 books/定期/migrate/goals 零覆盖已闭合；2.44.2 再补 bill-csv-edge / store-upgrade 两组，store.load 的 IndexedDB 升级接线仍待浏览器/桩覆盖，e2e-harness 仍孤立）；harness 无共享 helper；CI 已补 GitHub Actions（跑 `scripts/test.js` + `scripts/check.js`）。
- CSV 回导边界（2.44.1）：自身导出 CSV 已可回导，但「已删除=是」的行会被重新导入为有效账——导入侧不认「已删除」列，待后续扩展。引号内换行字段已于 2.44.2 支持（多行批注/微信多行商品不再丢账，回归 `tests/bill-csv-edge.test.js`）；末尾引号未闭合的畸形文件宽容解析并给警告，可能吞并后续行，属已知取舍。
- **iconOk 白名单**（2.28.3 已回退 2.28.2 的启用）：重新启用前必须先做「未知图标 → 默认图标」的**加载期兼容迁移**——老库图标键可能来自已下线的注册表条目，加载期严格校验会 `E_STORAGE_CORRUPT` 把用户挡在数据门外（数据与快照仍在，但打不开）。教训：加载路径上的校验收紧，必须有迁移或降级方案。

## 已修（2.38.0 存档）

| 位置 | 问题 | 回归 |
| --- | --- | --- |
| `core-assistant.js` `splitSegments`/`BRIDGE_RE` | `午饭28打车15` 只记最后一笔；连接词（然后/还有）前无空格不分句 | `tests/assistant-core-logic.test.js` 用例 1（含防误拆：苹果13手机壳50/充话费100送20） |
| `core-assistant.js` `recentAccountId`/`defaultAccountId` | `slice(0,400)` 在插入序库上取的是最旧 400 笔，>400 笔库默认账户补错；每笔重复扫描 | 用例 2；cx 级索引缓存（不可枚举属性，流水条数变化自动作废） |
| `core-assistant.js` `EXTRA_ALIASES` + `nl.js` | 双词表漂移：油费/机票/KTV 各只有一边有；奖金 两表各指一个分类；奶茶 跨表冲突 | 用例 3（含漂移守卫）；nl 导出 `categoryAliases` 为权威，EXTRA 降为兜底，运行时取并集 |
| `core-assistant.js` `mapStatus`/`httpOnce` | 非 2xx 不读响应体，404/405/模型名错一律归「配置不合法」 | 用例 4：endpoint/model/auth 细分 + detail 掩码密钥、限长 120 |
| `core-assistant.js` `fitBody` | 对半砍截断：超 3 行也丢 30 行词表 | 用例 5.2：按行字节精确裁剪（分类保底 6、账户保底 2） |
| `core-assistant.js` `categoryPairs` | 用户分类只按 sort 排，与使用频度无关 | 用例 5.1：带 usage 时按使用频度降序，system 保底不变 |
| `core-assistant.js` `handleRemoteResult` | 云端 intent=query 但本地装配失败，回落被误报「返回的内容看不懂」 | 改本地继续处理（mode local，不套回落文案） |
| `assistant.js` `REASON_TEXT` | config 文案谎报「未启用」；endpoint/model 无文案；回落不挂服务端细节 | 用例 7 |

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