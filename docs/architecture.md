# 架构

## 形态

单页 PWA：无构建、无依赖、无后端。`main` push 即发布（GitHub Pages）；所有源文件在仓库根，没有 `src/`、没有打包产物。

数据只在本机：IndexedDB + localStorage。没有账号，没有服务端存储。

## 启动链

1. `<head>` 最前部的内联块 `js/ui/preload-home.js` 先定稿 `XZB.version`（全文件唯一版本字面量），默认路由（空 hash / `#/home`）时再为首屏三件套（home + habit + 嵌入 ledger）注入 `<link rel="preload" as="script">`，chunk 下载与后续约 1MB 内联 CSS/JS 的解析并行；其它路由不预载。预载只是性能提示，URL 与 `XZB.chunks.url()` 逐字一致（`?v=` 版本，file:// 省略 query），加载链本身不变。
2. `index.html` 解析内嵌的 chunk-manifest（搜 `js/chunk-manifest.js`），决定首屏需要哪些 chunk。
3. 按需注入 `js/screens/*.js` 与 `js/modules/*.js`，统一挂到 `XZB` 命名空间。
4. hash 路由切屏（`#/home`、`#/bills`、`#/settings` 等）；屏幕模块自己渲染、绑定事件。
5. `sw.js` 按 manifest 预缓存；`CACHE_NAME` 一变，旧缓存被清。

## 数据

- IndexedDB 库名 `xzb2`（`index.html` 搜 `DB_NAME`），三个 store：`STORE_STATE`（键值状态：账目、账户、分类、预算等）、`STORE_SNAPSHOTS`（自动快照）、`STORE_PHOTOS`（票据照片）。
- schema 校验 `validateDb`、分类目录补齐 `mergeSeedCategories` 都在 `index.html`；改 schema 时两处一起看。
- localStorage：`xzb.ui.v2` 存 UI 状态；`xzb.ai.v1` 存 AI 配置（地址、模型、密钥、隐私告知状态）；`xzb.cloud.v1` 存云备份配置（GitHub 密钥、gistId、同步基准）。清空本机数据必须三者都清。

## AI 链路

- UI：`js/screens/assistant.js`（说话记账）、`js/screens/stats.js`（月度解读卡，2.40.0 起与原 insights 合并）、`js/screens/report.js`（报告存档/详情）、`js/screens/settings.js`（AI 配置页）。
- 传输与错误码：`js/modules/core-assistant.js`。密钥只出现在 `Authorization` 头；错误码统一 `E_AS_*`。
- 指标与提示词：`js/modules/ai-insights.js`（`buildMonthlyMetrics`、`requestAiInsights`、`toInsightPayload`、`buildFallbackInsights`、`buildLocalSummary`）。月中总量与分类都使用上月同期；免模型月报与 AI 请求共用同一聚合结果，不各算一套。
- 本地解析：`js/modules/nl.js`（金额、日期、分类别名）；没有模型时全靠它。
- 金额扫描边界（2.38.1）：阿拉伯数字后紧跟 ASCII 字母（`3D` / `2K` / `5G` / `1w` / `1e3`）一律不是金额，宁可报 `E_NL_NO_AMOUNT` 也不静默记错——「极速直记」默认开，解析器放过的错会直接变成错账。字母在前（`iPhone15`）本就跳过。回归 `tests/nl-alnum-amount.test.js`。
- 账单体检（2.39.0）：`js/modules/audit.js`，纯函数 `XZB.Core.audit.run({ transactions, scope, today })`，与统计同一套过滤（外加 `excludeStats`）。阈值集中在 `RULES`；判重靠「记录时间差 ≤ 2 分钟」，周期识别靠「同额同分类 → 规律链（允许桥接 1~2 期）→ 几号/星期几形状校验 → 高频分类至少 5 期」。insights 屏只做取数与展示（2.40.0 起并入 stats 屏）。回归 `tests/audit.test.js`。
- 词表单一事实源（2.38.0）：system 分类别名以 `nl.js` `CATEGORY_ALIASES` 为权威（经 `nl.categoryAliases` 只读暴露）；core-assistant 的 `EXTRA_ALIASES` 降为兜底+补充，运行时取并集（`mergedAliases`），漂移由 `tests/assistant-core-logic.test.js` 用例 3.6 守卫。改 system 别名只改 nl 一处。
- 分句（2.38.0）：`splitSegments(text, cx)` 先标点/连接词分段（连接词不要求前导空格），再做保守的「词+金额」多笔拆分（`splitAmountPairs`：每段都能解析出金额且落已知分类才拆；小数/日期/时间/转账先守卫）。无 cx 时保持旧行为。
- 上下文索引（2.38.0）：`cxIndex` 在 cx 上挂不可枚举索引（账户/分类 id 映射、默认账户、最近账户、别名 token 表），一条消息只建一次；流水条数变化自动作废账户类缓存。`recentAccountId` 全量扫描取 createdAt 最大（流水按插入序存放，旧版 slice(0,400) 取的是最旧 400 笔）。
- 云端词表预算（2.38.0）：`categoryPairs(list, usage)` system 保底 + 用户分类按使用频度降序（`categoryUsage` 单遍统计）；`fitBody` 超 4KB 按行字节精确裁剪尾部（分类保底 6、账户保底 2），不再对半砍。
- 错误归因（2.38.0）：非 2xx 读响应体（≤2KB），`mapStatus` 细分 endpoint（404/405）/model（400 点名模型不存在）/auth（401/403）；`detail` 为服务端原话（密钥掩码、限长 120），经 `localReply` 透传到回落气泡。

## 内置默认 AI 服务（2.41.0）

- 零配置即用：`core-assistant.js` 内置 `AI_DEFAULT_SERVICE`（千问 MaaS 端点 + `qwen4-max` + 密钥，按所有者要求公开）。启动链 `continueBoot` 调 `seedDefaultAiService()`：`XZB.chunks.ensure('core-assistant')` 后执行幂等 `llm.seedDefaultService()`——本机无 `xzb.ai.v1` 才播种（默认 `enabled:true` + `noticeAt>0`）；2.41.1 起若已存配置是旧内置免费档（`aiIsPreset` 命中 OVH 免密钥，含读入时已从 Pollinations 迁移来的）则升级到新默认服务并保留开关/告知，自定义配置绝不覆盖。播种函数不在模块顶层自动执行，保住「空配置=安全默认」的单测语义。2.41.2 起播种/升级另有一份**内联在 `index.html` 启动链**的同口径实现（`seedDefaultAiService` 直写 localStorage，不依赖分块）：旧 SW 对静态资源缓存优先会喂旧分块，分块内的升级逻辑加载不到（2.41.1 手机仍停旧档根因）；index.html 导航网络优先每次拉新，内联版保证启动即升级，旧分块读到的已是新配置。
- 思考型模型适配：该端点仅 `qwen4-max`/`deepseek-v4.1-flash` 有余量且默认会思考。`buildBody`（记账解析）、`llmTest`（16 token 探针）、`llmChat`（通用对话）统一带 `enable_thinking:false`；`ai-insights` 经 `extraBody` 同样关思考。端点不认时 `stripOptionalBody` 在 400 后剥 `response_format`/`enable_thinking` 重发一次。
- 取舍：密钥公开可被任何人调用（余量可能被刷），默认开启+默认同意隐私告知是所有者明确选择的「手机打开即用」口径，是「本地优先、出站先过告知、默认关闭」铁律的一处显式例外（仅限内置服务；用户自定义配置仍走原告知门）。详见 `docs/known-issues.md`。回归 `tests/ai-default-service.test.js`。

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

## 统计合并 / 日历 / 报告存档（2.40.0）

- 合并方向：以原 insights 为基干重写 `stats.js`（独有模块体量大），旧 stats 的趋势/排行移植进来；`insights.js` 删除。`#/insights` 降为历史别名：只在 `parseHash` 层归一到 `stats`（m/r/regen 参数原样保留），地址栏字面改写由 `syncAliasBar` 负责，与 `#/ledger`、`#/mine` 同一套路。底栏四根 `home / calendar / stats / settings`；chunk-manifest 22 项、sw 预缓存 35 项。
- 收入结构：collect 增 `incomeCats` 桶、summarize 增 `incomeItems`，结构卡/钻取按 `S.kind` 分流；核心结论、值得留意、体检、报告恒支出口径。结构卡＝环图（top5+其他）＋排行合一清单（默认前 5＋其他行，展开看 8＋其他），行带环比，收入口径 tone 反转。
- 日历页 `calendar.js`：DOM 7 列网格（周一起始），不用 canvas 热力。净额＝收入−支出，`+` 红 / `−` 绿（股市惯例，**仅本页**，其余页面仍是支出红/收入绿）；深浅四档 r=|净额|÷日基准 ≤0.5/1/2/>2，日基准＝`stats.budgetProgress().totalCents ÷ 当月天数`，未设预算退回固定档 ¥100（`FALLBACK_BASE_CENTS`）并给「设预算 ›」入口。当日流水与日历格同源五道过滤（deleted/账本/类型/金额/日期），转账不计；点日开当日清单 → 单笔弹层 → `#/add?id=` 编辑，「补一笔」走 `#/add?date=`。
- 热力令牌取舍：`charts.heatmap` 未扩展双色阶，改为把原红档重映射到 `--heat-r1..r4`（语义仍是「花得多」），保持统计页支出热力自洽；日历另用 `--heat-g1..g4` / `--heat-r1..r4` 令牌渲染净额格，浅深两套主题各一份。
- 报告存档：store 层独立 key `'reports'` 与账本主记录平行存放（keyPath:key，**不升 DB 版本**）；报告是派生内容，不进 `schema.validateDb` / `TABLES` / 导出备份 / 云备份（`exportJson` 只走 `buildBackup(ready.db)`）。同日同月同账期覆盖、按 `generatedAt` 倒序、上限 100 淘汰最旧。门面 `XZB.app.reports` 冻结透传 list/get/save/remove。
- 报告生命周期：统计页 `reportCard` 状态机 3m/6m 引导 → 模块加载 → 隐私告知（`noticeAt`）→ busy → 有今日记录（查看报告＋快照变动提示 `localFp`）→ 无记录（生成解读/重试＋本地兜底＋去设置）；存档入口恒在。AI 失败不落档可重试；`settleReport` ok 分支即使 `S.dead` 也落档（已计费不能丢）。0 点刷新＝`todayCache` 比对＋`scheduleMidnight`（到下个本地 0 点+500ms 自续）＋visibilitychange/focus 唤醒。`report.js` 列表＋详情只读渲染生成时快照，删除走确认弹层；重新生成仅 `generatedOn===today` 可用，深链 `#/stats?m=&r=&regen=1`。
- 记一笔日期预填：`add.js` 仅新建分支消费 `?date=`，严格 `YYYY-MM-DD`＋`dates.isValidDateStr` 双重校验，编辑分支不受影响。
- 回归：`tests/calendar-report.test.js` 38 项（日历纯函数、报告 store 内存模式、reportCard 状态机、路由别名、日期预填、合并接线）；`audit-card` / `same-period-ui` 改读合并后的 `stats.js`。

## 验收修复（2.44.1）

- SW 缓存键（修 2.41.3 回归）：`normalizeKey` 保留 `?v=` 后预缓存仍写无 query 键，离线 `?v=` 请求恒 miss。现 `VERSION` 由 `CACHE_NAME` 派生，预缓存 22 个 js 分块按 `?v=VERSION` 写入（入口/图标/启动图保持原键），MISSING 清单存带版本键并校验 `record.v`；`cacheFirst` 精确 miss 后 `ignoreSearch` 兜底，旧 index 的旧 `?v=` 也能命中同路径当前分块。回归 `tests/sw-cache.test.js`（vm + 内存 CacheStorage 真跑 install→断网→fetch，锁写入键=查找键）。
- CSV 两端：`escapeCsv` 首字符 `= + - @ \t \r` 前置 `'` 防公式注入（CWE-1236）；bill-import 仅在没有「收/支」「收支」时兜底认「类型」列（支付宝「类型」列装交易类型，不能误映射），自身导出 CSV 可回导；转账行进 skipped，「已删除=是」行回导会复活（已知边界见 known-issues）。回归 `tests/csv-export.test.js`。
- 行内批注上限统一 80（与 schema txNote 一致），修长批注静默截断；账单去重无单号时收紧为「同日+同额+同方向+(同非空备注或同分类)」，双时间非空且不同不判重，删 ±3 天宽窗口。回归 `tests/inline-edit.test.js` 2.4/2.5、`tests/bill-dupe.test.js`。
- 隐私口径：README 改真实口径（内置 AI 默认开启、首启视为同意、密钥公开、第三方端点、可关闭）；行为不变，仍是所有者有意选择（见 known-issues）。

## 验收修复（2.44.2）

- CSV 引号感知断行（修 2.44.1 验收 新 P2-1）：`bill-import.splitLogicalLines` 跨物理行追踪 inQuote，引号内换行并入当前逻辑行（`""` 转义与 `splitCsvLine` 同口径），返回逻辑行 + 起始物理行号，skipped/rows/headerLine 仍指真实行。末尾引号未闭合：残段整体保留、宽容解析并给警告（可能吞并后续行，已知取舍见 known-issues）。回归 `tests/bill-csv-edge.test.js` 1.x（多行批注 self-round-trip、微信多行商品 fixture）。
- 金额白名单（新 P3-1）：`cleanAmount` 剥 ¥/千分位后只认 `/^-?\d+(\.\d{1,2})?$/`，科学计数法/十六进制/超两位小数拒绝；负数/零仍走下游 `<=0` 跳过口径不变。回归同文件 2.x。
- 斜杠日期（新 P3-4）：`parseDateTime` 兼容 `[-/]` 分隔与单位数月/日/时，补零归一；月 1–12、日 1–31 越界拒绝（原横杠路径不校验月日，此处顺带收紧）。回归同文件 3.x。
- IndexedDB 升级失败闭合（新 P3-2）：`openRawDatabase` 的 `onupgradeneeded` catch 内显式 `req.transaction.abort()`，升级事务不得带半套 schema 提交；失败走 onerror → 内存降级。回归 `tests/store-upgrade.test.js`（沙箱注入假 indexedDB，浏览器升级语义，真跑 store.open）。
- inline-edit 头注释 30 字 → 80（2.44.1 改值漏改注释，新 P3-3）。

## 验收修复（2.44.3）

- CSV 日期时间解析闭合（执行检验报告 P2-1）：`bill-import.parseDateTime` 原只限月 1–12、日 1–31，`2026/2/31`、`25:99`、`12:60` 能进预览，commit 被 schema 拒绝后整批回滚且坏行不可定位。现按真实月历（`daysInMonth` 与 core/dates 同口径，含闰年规则）+ 时间边界（时 0–23、分/秒 0–59、年 ≥1000）在解析阶段拒收进 skipped（「日期无法解析」+ 物理行号），同批正常行照常导入。回归 `tests/bill-csv-edge.test.js` §4（含同批混合行 + 真 schema.validateTransaction 探针）。schema 的 2000-01-01 下界/今天+366 上界属业务界限，不在解析期处理（见 known-issues）。
- CI 浏览器离线冒烟（P2-2）：新增 `scripts/smoke.js`（零运行时依赖，Node ≥22 内置 fetch/WebSocket + 本机 Chrome/Edge headless CDP；候选浏览器逐个探测 DevTools，端口被安全软件拦截时自动换下一个），流程＝静态服务→在线真实键盘记一笔→读 IndexedDB→断网 reload→离线再记→恢复 reload，断言版本/缓存名/两笔数据/控制台错误，另冒烟 9 条主路由。`.github/workflows/check.yml` 在 tests/docs 后增加 browser-smoke step（5 分钟上限）。点击走 Input.dispatchMouseEvent 真实输入管线（带用户手势，避免 vibrate 拦截类干预）。
- 发布指引纠偏（P3-1）：`docs/release.md` 版本步骤改指 head 预载块唯一 `XZB.version` 字面量，明示各 core 的 `||` 兜底不是发布真源。
- 测试统计口径（P3-2）：`scripts/test.js` 合计明示为「已报告断言数」，并标注未报告断言数的文件个数；红绿仍按进程退出码，--json 协议不变。

## 切页性能修复（2.44.4）

- 用户反馈「页面切换有卡顿感」。CDP 探针 + Performance 指标分解（800 笔数据、CPU 节流 x4/x6）定位：切页耗时＝同步渲染脚本＋大 CSS 样式重算＋View Transition 整页快照捕获与帧对齐；桌面 x1 换屏 20–46ms 不卡，x6 时 187–563ms（最慢 settings→home），再叠加 180–260ms 转场动画，体感近 0.8s。CPU 采样显示 JS 热函数本身不大（stats __paint 17ms、audit.run 6ms），瓶颈在渲染管线与快照，不在某个可缓存的计算。
- 三处改动：① Tab 根横切排除 VT（renderRoute 闸门 `nav !== 'tab'`），走既有 `.app-screen--enter[data-nav="tab"]` 短淡入——快照捕获+帧对齐从最高频操作中移除；二级页进入/返回保留 VT 方向化推入。② 转场专用时长令牌 `--dur-nav-push: 180ms` / `--dur-nav-tab: 120ms`（不动全局 `--dur-base/--dur-2`，reduce 块同步归零）。③ 首页嵌入明细（最重 DOM）延后到换屏后下一个宏任务挂载，过期守卫（dead/destroyed/宿主脱离文档），挂载后按 `ctx.scrollTop`（renderRoute 新增传递）恢复路由目标滚动位。
- 复测（同探针同数据）：x6 全部 Tab 切换 37–100ms（settings→home 563→37ms），x4 23–35ms，x1 4–28ms。统计页 JS 本就轻，未拆其渲染（延后图表只会把成本挪到首帧后并引入布局跳动，收益为负）。
- 回归：`tests/nav-transition.test.js`（源码契约，路由渲染器深耦合启动无法 Node 真跑）+ `scripts/smoke.js` §6b 真实行为断言（`XZB.router.go` 入口：Tab 横切 0 次 VT 调用、二级页 ≥1 次、首页 `data-ledger-embed` 延后落位）。手改 location.hash 走 animate:false 外部地址路径，测不到转场决策，冒烟必须走 go()。

## 首屏体积与压缩核验（2.44.2 后）

- 实测构成（字符数）：index.html 约 1.20M，其中 CSS 约 355K、内联 JS 约 838K（store 118K / icons 83K / schema 82K / backup 58K / stats 57K / photo-viewer 49K / migrate 34K / recurrence 33K 等）。磁盘 UTF-8 约 1.28 MB。
- 线上压缩：GitHub Pages 对 `Accept-Encoding: gzip` 回 `Content-Encoding: gzip`，入口传输 329,023 B（约 321 KB，压掉约 74%）；只发 `br` 时不压缩（Pages 未启用 brotli）。home.js 14 KB、core-assistant.js 67 KB（gzip）。**「首屏 1.28 MB」是解析/缓存口径，不是网络传输口径。**
- 拆分决策：为网络传输而拆的收益已被 gzip 消除；剩余成本是低端机 boot 解析约 840KB 内联 JS。核心块内联是零构建 + 离线首启的有意取舍，且测试基建（40+ 文件）按内联块 marker 加载真实实现，外置核心会整体破坏该范式。结论：暂不拆，维持单文件 + frontend-perf 用例 5 体积棘轮。低端机解析若成实测瓶颈，另立架构批次（构建期压缩 + 核心外置 + 加载器重写 + 测试加载器同步），不在验收修复批次里盲改。
- 浏览器等效抽查（localhost 隔离源，非线上域名）：2.44.2 加载、SW 接管、缓存名 xzb2-v2.44.2、记账/行内改批注/日期弹层/删除（带撤销）全通过；停服后整页导航与离线记一笔均成功（SW 缓存兜底，P1-1 修复真机级验证）。iPhone 真机冷启动/飞行模式仍按 release.md 清单由所有者执行。

## 验收 P3 清理（2.44.7）

- core-assistant 拆块（P3-3）：单块 223,988 B 已达 240KB 预算的 93.3%。文件里本就是两个独立 IIFE——助手内核（含 LLM 传输）与 insight-qa 本地洞察问答（纯计算、零网络、只读 cx.db）。按现成接缝把后者拆回 `js/modules/insight-qa.js`（2.25.0 曾并入），主块降到约 182KB（76%）。不选报告建议的 llm-transport 切法：传输层与错误码表/配置读写/提示词装配互相交织，强拆风险高收益同；insight-qa 接缝零改写。加载顺序由 manifest 保证：`core-assistant` 声明依赖 `insight-qa`；`handleInsight` 原有的「模块缺失降级 handleQuery」兜底保留。
- SW 预缓存去重（P3-4）：`'./'` 与 `'./index.html'` 同源同内容，install 抓两遍 1.28MB 入口、缓存两份。PRECACHE 只留 `'./'`，`matchNavigation` 回退链（请求本身 → index.html → 根路径）天然兜底；预缓存总数不变（35 = 22 分块 + 13 壳资源）。
- IDB 晚到连接（P3-5）：`openRawDatabase` 超时 reject 后，晚到的 `onsuccess` 连接原先既不赋值也不 close，极端慢盘下泄漏。现 `settled` 时显式 `database.close()`。回归 `tests/store-upgrade.test.js` 用例 4（假 IDB 延迟 success 真跑）。

## 发布与不变量

- 版本四处：`index.html` 的 `XZB.version`（2.35.0 起唯一字面量在 `<head>` 的 `js/ui/preload-home.js` 块，app 块不再赋值）、`sw.js` 的 `CACHE_NAME`/`CACHE_LABEL`、`tests/category-expansion.test.js` 7.1/7.2 与 `tests/calendar-report.test.js` 6.3 的转义正则（第 4 处于 2.44.6 发版踩到后纳入 check.js）。
- 缓存名必须随版本变，否则用户永远停在旧 SW。
- `tests/` 是唯一回归防线：改行为必须同批改测试；`scripts/check.js` 只守机械一致性。

## 有意为之的取舍

- 单文件巨型 `index.html`：历史原因，换来零构建和直接 Pages 发布；新逻辑尽量放 `js/modules/`。
- 无第三方依赖：测试用纯 node 断言，脚本用 node 内置模块。
- 本地优先：任何要出网的能力都必须先过隐私告知，默认关闭。例外（2.41.0）：内置默认 AI 服务按所有者要求零配置默认开启并默认同意告知，密钥公开内置；用户自定义配置仍守原告知门。
- 行内编辑图标热区跳页（2.42.1）：种类宫格浮层在手机端有触控/视口缺陷，且浮层与记一笔页是两套种类选择 UI，维护不值；图标热区复用记一笔编辑页（`#/add?id=`），其余三热区留本页。`inline-edit.categoriesForKind` 保留为模块 API 供测试与后续复用。
- 换种类直选（2.42.2，`#/add?id=…&pick=cat`）：学鲨鱼记账「选分类即完成」——编辑页加 pick 模式，setCategory 里直接 attemptSave 并 goBack，成功文案报新种类名；pick 模式禁开键盘、标题改「更换种类」。普通编辑路径零改动，避免两套保存逻辑。
- 换种类回本页（2.43.0）：2.42.1 撤的是「锚定宫格浮层」（定位/触控缺陷），不是「本页直选」本身；底部 sheet 无锚定问题且详情/删除确认同款已验证稳定，故图标热区改开 `s-ledger-catpick-sheet` 宫格，点新分类走 `commitInlinePatch({categoryId})`，少两次整页转场、滚动位置不丢。「其他」分类与记一笔宫格同口径不进宫格（当前种类除外）；sheet 缺失退回 pick=cat 跳页，add 页直选逻辑与深链原样保留为兜底。
- 行内编辑体验打磨（2.43.0）：金额无效区分提交途径——回车保留编辑器（`mountAmountInput` 内建标红/轻晃/提示并重新全选），失焦才还原（不把焦点困在输入框）；提示语按 `(pointer: coarse)` 分设备；日期时间热区触屏/窄屏（<480px）走 `s-ledger-timesheet` 底部弹层、桌面保留浮层且 `openPopover` 全局监听 scroll(capture)/resize 即关（浮层内部滚动除外）；保存后滚动恢复由 `setTimeout(60)` 改 rAF 轮询「不带 `data-pre-edit` 标的新行」（上限 500ms），旧行提交前打标以区分重建前后 DOM；flash 底色改 `--c-flash` 令牌适配深色。
- 日历交互（2.43.0）：进当前月默认选中今天（render/setMonth 收口）；选日期走 `refreshSelection` 局部重绘（只切格子选中态＋重建 `s-cal-dayhost` 日卡），日卡在视口外才 `scrollIntoView`（reduced-motion 降级 auto）；横滑切月复用明细页方向仲裁口径（`swipeAxisOf`/`swipeMonth` 纯函数，纵向滚动优先、未定方向不拦截），邻月灰格在 2000-01～本月范围内可点跳月并选中该日；`netText` 三档格式（<¥10 一位小数 / 中间整数元 / ≥1万 紧凑「万」）消除「−¥0 却标色」与小格截断；空月份保留中性网格（`calendarHeatmap` 恒返回全月日数组），点日期仍可补记。
- 统计控制区吸顶（2.43.0）：`.s-insights-head` sticky，top 接 `.app-nav` 高度（`--h-nav + --safe-top`）、z=40 低于导航 50；只动 CSS，卡片渲染逻辑零改动。
- 日历月份直选（2.44.0）：月份标题升级为按钮（`s-cal-title--pick`，带 chevron-down），点开 `s-cal-monthpick` 底部 sheet——年份切换头 + 12 月宫格，交互语言与明细页 `openMonthSheet` 一致但按日历口径收紧：`monthCellState` 纯函数把 2000-01 之前与未来月置灰（明细页只靠 setMonth 兜底不置灰），年份箭头到边界禁用；点月关弹层走既有 `setMonth`（回当前月自动选中今天），同月点击只关不重绘。左右箭头保留作 ±1 快捷，横滑/灰格跳月/「回本月」不变。