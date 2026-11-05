# 交付说明：v2.26.9 分类目录扩充

| 项 | 值 |
| --- | --- |
| 分支 / 基线 | `feature/category-expansion-20261106`（基线 `main @ 5121c20`） |
| 版本 | 2.26.8 → 2.26.9 |
| 改动面 | 7 个业务文件 + 1 个新增测试；只增分类目录与解析词表，不改数据格式 |
| 回归复现 | 在仓库根执行 `node tests/category-expansion.test.js`，预期输出 `通过 49 / 失败 0 / 观察项 1` |
| 行号基准 | 本文所有 `file:line` 均为该分支工作树行号，revert 后不再适用 |

**一句话结论**：新增 12 个系统支出分类（种子、图标、AI 三桶映射、三处解析词表同步），老账本靠启动期「同 Schema 分类目录窄合并」无感补齐——不升 SCHEMA_VERSION、不升 IndexedDB DB_VERSION、不碰历史流水。回滚 `git revert` 单提交即可，已落盘的新分类元数据对 2.26.8 代码不可见但无害。

## 1. 改动总览

| 文件 | 目的 | 关键行号区间 |
| --- | --- | --- |
| `index.html` | 种子 +12 分类；启动期目录同步；防同名合并；存量别名清理；图标注册与色槽；版本号 | schema 块：种子 15843-15857、`mergeSeedCategories` 15908-15931、`syncCategoryCatalog` 15964-15973、`SEED_ALIAS_REMOVALS` 15995-16019；store 块：`catalogNeedsSync` 16977-16991、`loadInternal` 同步分支 17136-17171；icons 块：`CATEGORY_KEYS` 25801-25816、新 SVG 26765-26776、`SYSTEM_CATEGORY_KEYS`/`SYSTEM_LABELS` 26807-26833、`SEED_TONE` 28034-28037；`XZB.version = '2.26.9'` 32702 |
| `js/modules/nl.js` | 一句话解析词表：+12 类词表，摘除「书 / 礼物 / 随礼」旧归属 | `CATEGORY_ALIASES` 59-90（变更点 66、68、76-89） |
| `js/modules/core-assistant.js` | 小助手词表：+12 类词表，清 `ca_social` 的「礼物 / 随礼」 | `EXTRA_ALIASES` 393-418（变更点 400、405-417） |
| `js/modules/ai-insights.js` | AI 解读三桶映射补 12 个新分类 | 55-95（68-75、80-84、91-95） |
| `js/screens/add.js` | 记一笔页分类宫格图标映射 +12 | `CAT_ICON` 41-59（54-58） |
| `js/screens/settings.js` | 分类管理图标候选兜底 +9 | `FALLBACK_SYSTEM_ICONS` 72-82（79-81） |
| `sw.js` | 缓存版本号切到 2.26.9（触发旧缓存清除） | 头注释 2-3、`CACHE_LABEL` 11、`CACHE_NAME` 13 |
| `tests/category-expansion.test.js` | 新增自检脚本，49 用例 | 1-733 |

除上表外无其他文件改动；`sw.js` 仅版本字符串，预缓存清单未变。

## 2. 12 个新分类

种子定义在 `index.html:15846-15857`（支出 sort 从 350 续排，15843-15845 注释）。三个词表——种子 `aliases`、`nl.js CATEGORY_ALIASES`（78-89）、`core-assistant.js EXTRA_ALIASES`（406-417）——对这 12 类逐字一致，已逐一比对。

| id | 名称(name) | icon | 颜色 | sort | SEED_TONE | 别名数 | 别名 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ca_books` | 书籍 | `book` | `#5856D6` | 350 | 11 | 7 | 书籍 买书 图书 小说 漫画 纸质书 电子书 |
| `ca_gift_money` | 礼金 | `envelope` | `#FF3B30` | 360 | 6 | 5 | 礼金 随礼 份子钱 喜宴 红包支出 |
| `ca_gift` | 礼物 | `gift` | `#FF9500` | 370 | 3 | 5 | 礼物 礼品 生日礼物 节日礼物 伴手礼 |
| `ca_express` | 快递 | `package` | `#FF9500` | 380 | 8 | 6 | 快递 寄快递 运费 邮费 顺丰 菜鸟 |
| `ca_topup` | 充值 | `recharge` | `#AF52DE` | 390 | 5 | 7 | 充值 话费充值 手机充值 会员充值 账户充值 点卡 Q币 |
| `ca_laundry` | 洗衣服 | `washer` | `#007AFF` | 400 | 2 | 5 | 洗衣服 洗衣 干洗 衣物洗护 洗鞋 |
| `ca_bathing` | 洗澡 | `shower` | `#34C759` | 410 | 10 | 4 | 洗澡 洗浴 澡堂 浴资 |
| `ca_haircut` | 理发 | `scissors` | `#FF2D55` | 420 | 3 | 5 | 理发 剪发 美发 烫发 染发 |
| `ca_electricity` | 电费 | `bolt` | `#FF9500` | 430 | 1 | 5 | 电费 购电 充电费 电量 阶梯电价 |
| `ca_aifee` | ai | `ai` | `#5856D6` | 440 | 11 | 8 | AI 人工智能 AI订阅 大模型 ChatGPT OpenAI Claude Gemini |
| `ca_documents` | 资料 | `file` | `#8E8E93` | 450 | 12 | 7 | 资料 材料 文档 文件 资料费 文献 论文下载 |
| `ca_settings` | 设置 | `settings` | `#8E8E93` | 460 | 12 | 4 | 设置 系统设置 软件设置 配置服务 |

全部 `kind: 'expense'`、`system: true`；`SEED_TONE` 见 `index.html:28034-28037`（稳定色槽，用户改色后走取色兜底，28034 注释）。

**为什么 AI 的 id 是 `ca_aifee` 而不是 `ca_ai`**：分类 id 必须匹配 `ID_RE = /^(bk|ac|ca|tx|bg|cb|rc|gl|gd|sn|qi|ph)_[a-z0-9_]{3,20}$/`（`index.html:14625`）——前缀后至少 3 个字符。`ca_ai` 前缀后只有 `ai` 两个字符，过不了 `idOk`（`index.html:14747-14750`），会在 `validateCategory` 第一条就报 `E_INVALID_INPUT`（`index.html:15260`）。`ca_aifee`（aifee = AI fee 连写，5 字符）合法。测试 1.4 断言全部 52 个 id 匹配 `ID_RE`。

**两个命名细节**（后续改词表前先知道）：

- `ca_aifee` 的 `name` 字段是小写 `'ai'`（`index.html:15855`）。nl 把分类 `name` 也加入词表（`nl.js:1268`），匹配大小写敏感（`nl.js:1279` 起 `indexOf`）——小写输入「ai」经 name 命中，大写「AI」「AI订阅」「ChatGPT」经别名命中。此为可观察行为，代码注释未写明意图。
- `ca_aifee` 别名恰 8 条，打满 `LIMITS.aliases = 8`（`index.html:14659`）上限，影响见第 10 节。

## 3. 老账本生效方式：同 Schema 分类目录窄合并

新增分类不靠 schema 迁移，靠启动加载期的一次「窄合并」。链路在 `loadInternal` 同版本分支（`index.html:17136-17171`）：

1. **判定** `catalogNeedsSync(value)`（定义 `index.html:16980-16991`）：`seedData()` 里有、而库里没有的系统分类 id 即判 `true`。系统分类的「删除」是 `hidden=true` 软删（16978-16979 注释），实体仍在数组里，按 id 判存在不会复活用户删掉的分类。
2. **clone** 后操作（17141）：先在克隆上做，避免半成品落盘。
3. **窄合并** `schema.syncCategoryCatalog(synced)`（定义 `index.html:15968-15973`）：只做两件事——`mergeSeedCategories`（补缺失种子，15970）+ `upgradeSeedCategoryAliases`（清旧默认别名，15971）。刻意不用 `ensureShape`：全量 normalize 会连流水字段一起重建，超出「只动分类元数据」的承诺（15964-15967 注释）。
4. **校验** `schema.validateDb(synced).ok`（17145）：不过则放弃落盘、原库照常加载（落到 17172 的普通路径；注释标注理论不可达，测试 2.6 断言实际通过）。
5. **落盘** `writeStateRecord`（17147），失败则本次先给 App 用、下次启动再补（17156-17168）。

明确不变的东西（均有测试锁定）：

- `SCHEMA_VERSION` 仍为 4，四处同值未动（`index.html:14615 / 16421 / 19206 / 23753`）。
- IndexedDB `DB_VERSION` 仍为 2（`index.html:16414`）。
- 历史流水零改动：窄合并只写 `db.categories`，测试 2.5 对流水逐字段断言（id/金额/日期/备注/categoryId 全等）。
- **二次启动幂等**：同步完成后 `catalogNeedsSync` 返回 `false`（测试 2.7 末条断言），后续启动在 17140 直接跳过该分支；测试 2.7 同时断言再跑一次 `syncCategoryCatalog` 后 categories 与其余 9 张表逐字节不变。

## 4. 防同名保护：`mergeSeedCategories`

`validateCategory` 对「同 kind 同 name、不同 id」报 `E_CATEGORY_DUP`（`index.html:15285-15293`，文案 16473）。如果合并种子时直接 append，老库里用户自建的「书籍」会让追加进来的 `ca_books` 把整库判坏——`loadInternal` 在 17128-17135 校验失败直接走 `corruptFailure`，表现为启动即「数据损坏」。

因此 `mergeSeedCategories`（`index.html:15912-15931`，2.26.9 在按 id 去重的 `mergeSeedById` 之上改造，注释 15908-15911）先扫一遍现有分类建两张表——`existingIds` 和 `existingNames`（键为 `kind|name`），种子命中任一即跳过（15926-15927）。效果：**同名时保留用户自己的分类、跳过该种子**，测试 3.1（`ca_books` 被跳过、用户分类保留、总数仍补齐到 52）与 3.2（`validateDb` 通过）覆盖。

三条链路行为一致：

- **导入**：`ensureShape`（`index.html:15934-15962`）在 15958 调 `mergeSeedCategories`；v1 迁移（19640）、备份导入/覆盖（19684）、旧 schemaVersion 升级（19967）都走它。
- **启动同步**：`syncCategoryCatalog` 在 15970 调它（第 3 节）。
- **新库**：`createDb`（15876-15895）直接用 `seedData()`，库里还没有用户分类，天然无冲突。

一个已知副作用：用户已有同名分类时该种子被永久跳过，这个库不会再出现对应的系统分类（例如已有自建「书籍」的库永远不会有 `ca_books`）。此时「书籍」相关输入会路由到用户自己的分类——nl / assistant 的词表本来就包含用户分类的 name 与 aliases（`nl.js:1259-1268`、`core-assistant.js:435-441`），属期望行为。

## 5. 别名归属调整

新分类接管了一批原本挂在旧分类上的默认别名。不清理的话，旧分类会一直抢走这些词（原因见下），新分类永远收不到对应流水。

**去向**（`index.html:15995-15997` 注释）：

| 旧别名 | 原挂在 | 归入 |
| --- | --- | --- |
| 书 | `ca_study` 学习 | `ca_books` 书籍 |
| 理发 | `ca_beauty` 美容 | `ca_haircut` 理发 |
| 礼物 | `ca_social` 人情 | `ca_gift` 礼物 |
| 随礼 | `ca_social` 人情 | `ca_gift_money` 礼金 |

**两侧同时摘**：

- **种子侧直接摘除**：`seedData` 里 `ca_study` 现为 `['课程','培训','学费']`（`index.html:15814`）、`ca_social` 现为 `['红包','请客']`（15816）、`ca_beauty` 无「理发」（15825）。`createDb` 不走 `ensureShape`（15876-15886 直接展开种子），新装机必须生来干净，不能依赖升级逻辑兜底。
- **存量侧清老库**：`SEED_ALIAS_REMOVALS`（`index.html:16002-16006`）+ `upgradeSeedCategoryAliases`（16008-16019），只动 `system: true` 的分类（16012）、只删表里列出的别名，不碰用户自建分类与历史流水。`ensureShape`（15959）与 `syncCategoryCatalog`（15971）两条链都会执行它，测试 2.4 / 8.2 断言摘除后剩余别名逐字相等。

**为什么必须清——平手裁决规则**：nl 的 `categoryCompare`（`nl.js:1294-1304`）与 assistant 的 `resolveCategory`（`core-assistant.js:425-433`）都是「最长匹配优先，平手取 sort 小者」。旧分类 sort（学习 70、美容 170、人情 90）远小于新分类（350+），只要旧别名还在，『书』『理发』『礼物』『随礼』这些等长命中的平手全被旧分类拿走。测试 4.1-4.5、9.1 验证清理后的路由符合预期。

**词表三处同步**：种子 aliases（schema）之外，`nl.js CATEGORY_ALIASES`（`nl.js:76-89`，注释 76-77 记录了本次摘除）与 `core-assistant.js EXTRA_ALIASES`（`core-assistant.js:400` 清 `ca_social`、405-417 新增 12 类）同步更新。后续加词请三处一起改，漏一处会出现「手动记 / 一句话 / 小助手」三入口路由不一致。

## 6. 图标与配色

- **3 个新 SVG**：`recharge`（充值）/ `shower`（洗澡）/ `ai`，双色画法（A 局部填充 + S 描边，24×24），定义在 `index.html:26765-26776`。
- **复用既有字形**：`bolt` 为既有单色闪电（26762-26763）、`file` 为既有 UI 字形（26137）——与 `CATEGORY_KEYS` 注释「recharge/shower/ai 为新增双色，bolt/file 复用现有字形」一致（25812）。
- **`CATEGORY_KEYS` 新增 5 key**：`recharge/shower/ai/bolt/file`（`index.html:25815`）。该表决定分类图标用 1.75 描边（`CATEGORY_STROKE` 25799）而非 UI 图标的 1.8（`DEFAULT_STROKE` 25796）；描边在 `resolveName` 之后按 `CATEGORY_KEYS[key]` 取（26919）。
- **`settings` 有意不进 `CATEGORY_KEYS`**：`tab-settings` 别名解析到同一 key（`ALIASES` 26714），登记会把底部导航「我的」图标线宽从 1.8 改成 1.75（25812-25814 注释）。因此 `ca_settings` 的分类图标按 UI 图标 1.8 描边渲染。纯视觉差异，无功能影响。
- **`SYSTEM_CATEGORY_KEYS` 追加 9 key**（`index.html:26814-26815`）：`envelope/package/recharge/shower/scissors/bolt/ai/file/settings`——其中 envelope/package/scissors 字形早已存在，本次只是进设置页「系统分类图标」候选（`categoryIconKeys` 按 `PATHS` 存在性过滤，26866-26872）。
- **`SYSTEM_LABELS` 追加 9 条中文名**（`index.html:26830-26832`），供设置页 aria-label 与候选格标签。
- **`SEED_TONE` 追加 12 条稳定色槽**（`index.html:28034-28037`，见第 2 节表格）。
- **`add.js CAT_ICON` 追加 12 条**（`js/screens/add.js:54-58`；分类自身的 `icon` 字段优先于该表，注释 54）。
- **`settings.js FALLBACK_SYSTEM_ICONS` 追加 9 key**（`js/screens/settings.js:79-81`），仅图标注册表缺失时的兜底，正常路径走 `systemCategoryKeys()`（84-91）。
- 未知 icon key 的最终兜底是省略号字形（`icon()` 里 `PATHS[key] || PATHS.ellipsis`，`index.html:26914`）。

## 7. AI 解读三桶映射

`ai-insights.js` 三个桶各追加一组（注释均标「2.26.9 扩充分类」）：

- **必要**（`BUCKET_NECESSARY`，`js/modules/ai-insights.js:68-75`）：`ca_express` 快递、`ca_laundry` 洗衣服、`ca_bathing` 洗澡、`ca_haircut` 理发、`ca_electricity` 电费、`ca_settings` 设置。
- **发展**（`BUCKET_DEVELOPMENT`，80-84）：`ca_books` 书籍、`ca_aifee` AI、`ca_documents` 资料。
- **享受**（`BUCKET_ENJOYMENT`，91-95）：`ca_gift_money` 礼金、`ca_gift` 礼物、`ca_topup` 充值。

12 个新 id 三桶合计恰出现一次、无跨桶重复（测试 5.4）；桶表经 `pickBucketList` 用于月度报告归类（217-219）。三桶常量照抄任务书，未自行增删（49 行注释）。

## 8. 存量数据影响清单

不改的东西：

- 金额、日期、账户、账本、预算、存钱目标、照片、备份格式全部不变；`SCHEMA_VERSION=4`、`DB_VERSION=2` 未动（第 3 节）。
- 历史流水逐字段原样（测试 2.5、8.3）。
- 用户改过图标/颜色的分类不受影响——`SEED_TONE` 只服务「保持出厂色」的新分类（28034 注释），`SEED_ICON_UPGRADES` 沿用 2.6 的「只动出厂默认值」原则（15975-15982）。

会变的东西：

- **老账本升级后首次启动**：补 12 个分类元数据 + 摘 4 条旧别名，写一次盘（17147）。之后启动零开销（判定即 false）。
- **旧备份可导入**：2.26.8 导出的备份 `schemaVersion=4` 与当前相同，不触发 `E_STORAGE_VERSION`（`index.html:17783 / 17852` 只拦大于或小于当前版本的 payload）；导入走 `ensureShape` 链路（19684 / 19967），自动补齐 12 个新分类并清旧别名（测试 8.1-8.3）。注意 `ensureShape` 会丢弃未知字段（15933 注释），这是既有行为，非本次引入。
- **用户自建同名分类**：对应种子被跳过（第 4 节），其余 11 个种子照常补齐。
- 升级期间用户用新分类记的账，`categoryId` 指向新 id，回滚后数据仍在库里（第 11 节）。

## 9. 回归验证

命令：在仓库根执行

```bash
node tests/category-expansion.test.js
```

预期输出 `通过 49 / 失败 0 / 观察项 1`，退出码 0。脚本只读业务代码、不修改任何文件（`tests/category-expansion.test.js:20`）；装配方式是在 node `vm` 沙箱里真实执行 index.html 的 money/dates/schema/store/icons 五个内联块与三个模块源文件（8-21、143-164），`catalogNeedsSync` 与图标字面量按源码提升执行、不是复写实现（172-182）——测的就是仓库里的真实代码。

49 个用例的覆盖点：

- **用例 1（5）**：`seedData()` 共 52 类（46 支出 + 6 收入）；12 个新 id 存在且 kind/system/sort 恰为 350..460；`createDb()` 过 `validateDb`；52 个 id 全匹配 `ID_RE`；全部类别 aliases ≤8 条、单条 ≤10 字、类内无重复。
- **用例 2（9）**：v4 老库装置（40 旧分类 + 存量旧别名 + 1 条历史流水）自检；`catalogNeedsSync` 对老库 true、对新库 false；同步后补齐 52；四条旧别名摘除且其余别名原样；历史流水逐字段不动；同步后过 `validateDb`；二次同步幂等（含其余 9 张表不变 + 判定翻 false）；`loadInternal` 启动同步链四个关键步骤按序存在（源码级断言）。
- **用例 3（2）**：用户自建同名「书籍」时 `ca_books` 种子跳过、用户分类保留、总数 52；同步后过 `validateDb`（无 `E_CATEGORY_DUP`）。
- **用例 4（13）**：一句话路由 礼物→`ca_gift`、随礼→`ca_gift_money`、理发→`ca_haircut`、书籍→`ca_books`、电费→`ca_electricity`、话费充值→`ca_topup`；「游戏充值」长词赢过短词「充值」归 `ca_game`；「AI订阅」「ChatGPT」→`ca_aifee`；金额换算 200→20000 分；「买 30」不误路由到新分类；nl 内置黑名单源码断言（只有「买」）；观察项 4.N：小写「chatgpt 20」能解析金额、路由结果仅记录。
- **用例 5（6）**：三桶字面量可提升求值；必要 6 个 / 发展 3 个 / 享受 3 个新分类各就各位；12 个新 id 无跨桶重复；模块导出完整。
- **用例 6（5）**：12 个 icon key 在真实 `PATHS` 注册表 `has()` 为真；`systemCategoryKeys()` 含全部 12 key；`add.js CAT_ICON` 逐项映射正确；`settings.js FALLBACK_SYSTEM_ICONS` 含全部 9 个新增候选；`SYSTEM_CATEGORY_KEYS` 含 9 个新增 key。
- **用例 7（3）**：`index.html` 版本 2.26.9；`sw.js` `CACHE_NAME='xzb2-v2.26.9'` 且 `CACHE_LABEL` 含 2.26.9；全仓无旧版本号 `2.26.8` 残留。
- **用例 8（3）**：`ensureShape` 老库回灌后 52 类齐全且过 `validateDb`；同样摘除旧别名；历史流水关键业务字段逐字段保留。
- **用例 9（3）**：`resolveCategory` 按最长 token 路由 礼物/随礼/理发/电费→新分类；「游戏充值」仍归 `ca_game`；`EXTRA_ALIASES` 含 12 个新 id 且 `ca_social` 已不含「礼物/随礼」。

未覆盖部分（后续发版前建议手工过一遍）：

- **IndexedDB 端到端**：启动同步只用源码顺序断言（2.8）模拟，未在真实 IndexedDB 上跑「老库 → 升级 → 落盘 → 二次启动」全流程。
- **真机 PWA**：SW 换缓存名后的「重开两次切版」、iOS 主屏冷启动、离线场景未自动验证。
- **nl 大小写归一化**：属既有行为——匹配大小写敏感（`nl.js:1279`），小写「chatgpt」不命中别名 `ChatGPT`（而「AI订阅」命中）。测试仅以观察项 4.N 记录实际路由，未修也未断言目标分类。
- 同名跳过只测了「书籍」一例（用例 3），其余 11 个种子的同名场景走同一代码路径。

## 10. 已知边界与后续注意

**LLM 分类清单余量从 20 降到 8**。`LLM_MAX_CATEGORIES = 60`（`core-assistant.js:52`）未上调；`categoryPairs` 按**数组物理顺序**取前 60（`core-assistant.js:2614-2627`，实参是 `liveCategories` 即 `db.categories` 过滤 hidden 后的原顺序，`core-assistant.js:234 / 2697 / 3354`）。种子 40 → 52，余量 60 − 52 = 8。谁先被截取决于库的物理顺序，两种情况不同：

- **新装机库**（种子序 = 旧支出 34 → 新支出 12 → 收入 6，自建分类 push 到数组尾部 `settings.js:3107`、`add.js:1648`）：自建第 9 个起被截出 LLM 词表。
- **老库升级后**（旧支出 34 → 收入 6 → 升级前已有的自建分类 → 12 个新种子由 `mergeSeedCategories` 追加在**数组最尾** `index.html:15923-15928`）：升级前自建分类每多 1 个，就从尾部多截 1 个——先吃掉 `ca_settings`，再 `ca_documents`……自建达 20 个时 12 个新分类整体被截光。

两点澄清：收入种子位于数组中部（34-39 或 46-51），始终在截断线内，不会被截；被截只影响发给 LLM 的提示词分类清单，本地 `nl.parse` 与 `resolveCategory` 走全量 `ctx.categories`，不受 60 上限影响。另外 `fitBody` 还有第二道按字节数从尾部减半的兜底（`core-assistant.js:2650-2674`）。用户在分类管理里隐藏（hidden）旧分类可为 LLM 词表腾位（过滤发生在计数前，`core-assistant.js:234`）。本次按任务书约定未上调 60；若将来上调，注意与 `LLM_MAX_BODY` 的 4KB 体积兜底联动。

**`ca_aifee` 别名已打满 8 条上限**。`LIMITS.aliases = 8`（`index.html:14659`），`validateCategory` 对超限报 `E_INVALID_INPUT`（15268-15269）。后续给 AI 分类补词必须先挤掉现有低频词；若直接把种子加到 9 条，新装机 `createDb` 首次 `validateDb` 即失败、启动判坏。另注意：改种子的 `aliases` 对**存量老库不生效**——`mergeSeedCategories` 按 id 跳过已存在分类（15926），存量库要动别名必须走 `SEED_ALIAS_REMOVALS` 这类显式升级规则。

**`iconOk` 的 NAMES 白名单守卫处于休眠**。`iconOk`（`index.html:14756-14762`）在 `XZB.UI.icons.NAMES` 为数组时按白名单校验，但 icons api 从未导出 `NAMES`（26991-27009 只有 `names()` 函数），守卫恒真——任何非空字符串 icon 都能过 schema 校验。该状态在本次改动前已存在（本次未增删 api 导出），非本次引入；如要启用白名单，先核对存量库里是否已有超出白名单的 icon 值，否则会把老库判坏。

## 11. 回滚方式

**代码回滚**：本次改动收在单个提交，`git revert <commit>` 即可。回滚后 `sw.js` 的 `CACHE_NAME` 回到 `xzb2-v2.26.8`，SW activate 清掉 2.26.9 缓存（`sw.js:12` 注释的机制），用户需重开一两次页面切回旧版。

**数据层面**：升级过的库里已落盘 12 个新分类元数据（`system: true`），2.26.8 代码不认识这些 id，但**无害且无需处理**：

- `validateDb` 不校验分类数量上限（`index.html:16036-16094` 只有实体级校验，无 `categories.length` 检查），多出的 12 条系统分类能通过 2.26.8 的整库校验；
- 历史流水的 `categoryId` 不受影响；升级期间用新分类记的账，回滚后记录仍在，分类条目也仍在库里（列表来自 `db.categories`），只是旧版 `PATHS` 缺 `recharge/shower/ai` 字形、图标回落省略号（26914），旧版 `CAT_ICON` 也没有这些 id——显示降级，功能正常；
- 若之后重新应用本特性，`catalogNeedsSync` 发现 52 类齐全即 no-op，双向幂等。

如需彻底清理这 12 条元数据，只能手工改 IndexedDB（产品内删除是 `hidden=true` 软删，不会移除实体，见 16978-16979 注释）——一般不建议，收益仅是分类管理里少 12 个条目。回滚后新装的库按 2.26.8 种子生成（40 类），无同步逻辑，自然干净。
