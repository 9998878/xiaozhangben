/* 小账本 2.0 · js/modules/ai-insights.js · owner: backend（AI 月度解读 · 第 1 轮：聚合层）
 * 契约锚点：AI 解读任务书第 1 轮（buildMonthlyMetrics 单月口径）。
 * 硬规则：纯函数、零网络、零 LLM、零 DOM、零存储读写；只接收 db 参数，不改传入对象；
 * 金额全程整数分（*Cents 字段原样输出分），比率/占比/月数在输出层才做除法取整，全程无 toFixed；
 * 口径与 core/stats.walk 完全一致（五道过滤：deleted / bookId / 合法 type / amount>0 / 合法日期）。
 *
 * 导出（XZB.core.aiInsights，共三个）：
 *   - buildMonthlyMetrics(db, month, bookId) -> metrics | null（第 1 轮：单月聚合，纯函数零网络）；
 *   - requestAiInsights(metrics, opts) -> Promise（第 2 轮：输出层，请求 LLM 生成解读，永不 reject）；
 *   - buildFallbackInsights(metrics) -> items（第 2 轮：输出层本地规则兜底，零网络）。
 *   - db：XZB.app.db() 内存真源（至少含 transactions 数组）；
 *   - month：'YYYY-MM'；bookId：当前账本 id；两者非法一律返回 null，不抛错。
 *   - 跨月信息（3 个月移动平均、连续超支月数、环比）在函数内部回溯 prev1/prev2，不靠外部传区间。
 *
 * 口径决策（与任务书字面的对应关系，验收时逐条可查）：
 * 1) cashflow.creditInflowCents：本月 credit 类账户上的「新增透支/借款额」＝记在 credit 账户上的
 *    expense 合计。理由：debt.monthlyRepaymentCents（流入 credit 的还款额）是独立字段，若
 *    creditInflow 也算流入则两字段恒等；且透支＝信用卡消费在余额公式里就是余额变负。
 * 2) debt.monthlyRepaymentCents：本月「流入 credit 账户」的金额合计（转入 credit ＋ 收入直接记在
 *    credit），即还款额；repaymentToIncomeRatio 以百分比输出，收入为 0 时给 null。
 * 3) structure/dataQuality 的 uncategorizedPct：ca_other_expense ＋「三桶都未映射的自定义分类」
 *    支出占比。自定义分类不映射时只能落回未分类，否则三桶占比＋uncategorizedPct 凑不齐 100%。
 *    settings.aiBuckets 可覆盖三桶（{necessary,development,enjoyment} 三个字符串数组），
 *    但 ca_other_expense 永远不进桶（未分类信号本身）。
 * 4) income.oneTime：分类 ∈ {ca_bonus, ca_redpacket, ca_other_income}，或该收入分类本月 ≥3 笔且
 *    单笔 > 该分类中位数 ×2（按分类各自求中位数，避免兼职小额拉低中位数误杀工资）。
 *    stableCents ＋ oneTimeCents 恒等于 incomeCents。
 * 5) trends.mom：支出分类环比（上月为 0 给 null），另附收入/支出/结余总量环比（除数取绝对值，
 *    与 stats.mom.deltaOf 同式）。
 * 6) trends.anomalies 的「日均支出」：已过去的天数（当月未过完按今天，整月按自然日数），
 *    而非整月天数，否则月中运行时阈值被低估。
 * 7) smallFrequent 关键词匹配：note 包含关键词，或「非 system 分类」的 aliases 包含关键词，或
 *    显式 pin 的分类（游戏充值→ca_game）。system 种子分类的 aliases 不参与匹配——种子把
 *    「外卖」挂在 ca_food、「打车」挂在 ca_transport、「奶茶」挂在 ca_snack 上，那些别名是给
 *    NL 解析做 note→分类用的，按字面匹配会把整个餐饮/交通/零食都误聚类。一笔只归第一组。
 * 8) buffer.availableCashCents：复用 XZB.core.stats.accountBalances（CONTRACT §6.2 冻结公式，
 *    跨账本全历史，账户维度本就不归属账本），只累计未归档的 cash/debit/savings。
 * 9) 所有 Rate/Ratio/Pct 字段统一为百分比数字（0-100，保留 1 位小数），分母 ≤0 时 null（占比类给 0）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  /* ------------------------------------------------------------------ *
   * 0. 常量（三桶映射照抄任务书，不自行增删）
   * ------------------------------------------------------------------ */

  var UNCAT_ID = 'ca_other_expense';

  /* 必要：断了会立刻影响生存/学习刚需 */
  var BUCKET_NECESSARY = [
    'ca_food',      // 餐饮
    'ca_home',      // 居住
    'ca_transport', // 交通
    'ca_health',    // 医疗
    'ca_comm',      // 通讯
    'ca_veggie',    // 蔬菜
    'ca_fruit',     // 水果
    'ca_daily',     // 日用
    'ca_repair',    // 维修
    'ca_elder',     // 长辈
    'ca_kids',      // 孩子
    'ca_auto',      // 汽车（通勤刚需）
    /* 2.26.9 扩充分类 */
    'ca_express',     // 快递
    'ca_laundry',     // 洗衣服
    'ca_bathing',     // 洗澡
    'ca_haircut',     // 理发
    'ca_electricity', // 电费
    'ca_settings'     // 设置
  ];

  /* 发展：服务长期目标 */
  var BUCKET_DEVELOPMENT = [
    'ca_study', 'ca_office', 'ca_sports', 'ca_tools',
    /* 2.26.9 扩充分类 */
    'ca_books',     // 书籍
    'ca_aifee',     // AI
    'ca_documents'  // 资料
  ];

  /* 享受：可压缩 */
  var BUCKET_ENJOYMENT = [
    'ca_fun', 'ca_game', 'ca_snack', 'ca_shopping', 'ca_clothes', 'ca_beauty',
    'ca_socialize', 'ca_social', 'ca_travel', 'ca_smoke', 'ca_lottery',
    'ca_pet', 'ca_digital', 'ca_appliance', 'ca_household', 'ca_family', 'ca_donate',
    /* 2.26.9 扩充分类 */
    'ca_gift_money', // 礼金
    'ca_gift',       // 礼物
    'ca_topup'       // 充值
  ];

  /* 一次性收入：分类命中即算 */
  var ONE_TIME_SET = { ca_bonus: 1, ca_redpacket: 1, ca_other_income: 1 };
  /* 常态收入分类：中位数显著离群检测的候选 */
  var STABLE_SET = { ca_salary: 1, ca_parttime: 1, ca_invest: 1 };
  var ONE_TIME_MEDIAN_MULT = 2;   /* 显著高于＝> 中位数 ×2 */
  var ONE_TIME_MEDIAN_MIN = 3;    /* 该分类本月 ≥3 笔才启用中位数规则 */
  var ONE_TIME_MAX = 5;           /* oneTimeItems 最多 5 条 */

  var BIG_TX_CENTS = 50000;       /* 异常大额兜底线：500 元 */
  var ANOMALY_DAILY_MULT = 3;     /* 异常：单笔 > 日均支出 ×3 */
  var ANOMALY_MAX = 5;

  var BUDGET_CHAIN_MONTHS = 2;    /* 除本月外再回溯的月数（共 3 个月窗口） */

  /* 小额高频关键词组：note 包含 / 非 system 分类别名包含 / pin 分类。
   * 数组顺序即优先级，一笔只归第一组。 */
  var SMALL_GROUPS = [
    { key: 'milkTea', label: '奶茶', patterns: ['奶茶'] },
    { key: 'takeout', label: '外卖', patterns: ['外卖'] },
    { key: 'taxi', label: '打车', patterns: ['打车'] },
    /* 2.28.2：删掉裸「游戏」——「买游戏光盘」会被误伤进充值聚类；ca_game 分类本身仍由
       pinCategoryId 兜底命中 */
    { key: 'gameTopup', label: '游戏充值', patterns: ['游戏充值'], pinCategoryId: 'ca_game' },
    { key: 'live', label: '直播', patterns: ['直播'] },
    { key: 'blindbox', label: '盲盒', patterns: ['盲盒'] }
  ];

  var TYPE_INCOME = 'income';
  var TYPE_EXPENSE = 'expense';
  var TYPE_TRANSFER = 'transfer';
  /* 可动用现金口径：含微信/支付宝（本项目默认账户就是这两个，学生现金基本都在里面），
     只排除 credit（负债）。漏掉 wechat/alipay 会让「应急缓冲」常年显示 0 个月并触发假红旗。 */
  var BUFFER_TYPES = { cash: 1, debit: 1, savings: 1, wechat: 1, alipay: 1 };

  /* ------------------------------------------------------------------ *
   * 1. 基础工具（ES5，无日期库依赖的月份算术；与 core/dates 同规则）
   * ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

  function daysInMonthOf(y, m) {
    if (m === 2) { return isLeapYear(y) ? 29 : 28; }
    if (m === 4 || m === 6 || m === 9 || m === 11) { return 30; }
    return 31;
  }

  function isValidMonthKey(mk) {
    if (typeof mk !== 'string' || !/^(\d{4})-(\d{2})$/.test(mk)) { return false; }
    var mm = Number(mk.slice(5, 7));
    return mm >= 1 && mm <= 12;
  }

  function isValidDateStr(s) {
    if (typeof s !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})$/.test(s)) { return false; }
    var y = Number(s.slice(0, 4));
    var mm = Number(s.slice(5, 7));
    var dd = Number(s.slice(8, 10));
    /* 年份下限 1000 与 core/dates.isValidDateParts 同口径，脏数据与统计屏行为一致 */
    return y >= 1000 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonthOf(y, mm);
  }

  /* 'YYYY-MM' 平移 N 个月（纯算术，月末不存在截断问题——月键不含日） */
  function shiftMonth(mk, delta) {
    var y = Number(mk.slice(0, 4));
    var mm = Number(mk.slice(5, 7));
    var t = y * 12 + (mm - 1) + delta;
    var ny = Math.floor(t / 12);
    return ny + '-' + pad2(t - ny * 12 + 1);
  }

  function intOf(value) {
    var n = Number(value);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  /* 占比（百分比、1 位小数）；分母 ≤0 给 0（与 stats.pctOf 同规则） */
  function pctOf(part, total) {
    return total > 0 ? round1(part / total * 100) : 0;
  }

  function medianOf(sortedAsc) {
    var n = sortedAsc.length;
    if (!n) { return null; }
    var mid = n >> 1;
    return (n % 2 === 1) ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
  }

  /* 本地今天：优先 core/dates.todayStr（本地时区手工解析），缺库退化到系统时钟 */
  function todayInfo() {
    var D = XZB.core && XZB.core.dates;
    if (D && typeof D.todayStr === 'function') {
      var s = D.todayStr();
      if (typeof s === 'string' && isValidDateStr(s)) {
        return { month: s.slice(0, 7), day: Number(s.slice(8, 10)) };
      }
    }
    var now = new Date();
    return { month: now.getFullYear() + '-' + pad2(now.getMonth() + 1), day: now.getDate() };
  }

  /* ------------------------------------------------------------------ *
   * 2. 索引构建（三桶映射 / 分类 / 账户）
   * ------------------------------------------------------------------ */

  function pickBucketList(raw, fallback) {
    if (!Array.isArray(raw)) { return fallback.slice(); }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (typeof raw[i] === 'string' && raw[i]) { out.push(raw[i]); }
    }
    return out.length ? out : fallback.slice();
  }

  /* settings.aiBuckets 覆盖点：{ necessary, development, enjoyment } 三个字符串数组 */
  function resolveBuckets(settings) {
    var override = (settings && typeof settings === 'object' && !Array.isArray(settings))
      ? settings.aiBuckets : null;
    return {
      necessary: pickBucketList(override && override.necessary, BUCKET_NECESSARY),
      development: pickBucketList(override && override.development, BUCKET_DEVELOPMENT),
      enjoyment: pickBucketList(override && override.enjoyment, BUCKET_ENJOYMENT)
    };
  }

  function buildBucketIndex(buckets) {
    var idx = Object.create(null);
    var keys = ['necessary', 'development', 'enjoyment'];
    for (var k = 0; k < keys.length; k++) {
      var list = buckets[keys[k]];
      for (var i = 0; i < list.length; i++) {
        var id = list[i];
        if (id === UNCAT_ID) { continue; } /* 未分类保留为信号，永不进桶 */
        if (!idx[id]) { idx[id] = keys[k]; }
      }
    }
    return idx;
  }

  function buildCategoryIndex(categories) {
    var idx = Object.create(null);
    var list = Array.isArray(categories) ? categories : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c && typeof c.id === 'string' && c.id) { idx[c.id] = c; }
    }
    return idx;
  }

  function categoryNameOf(catIndex, categoryId) {
    var c = catIndex[categoryId];
    return (c && typeof c.name === 'string' && c.name) ? c.name : '未分类';
  }

  function buildAccountIndex(accounts) {
    var idx = Object.create(null);
    var list = Array.isArray(accounts) ? accounts : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && typeof a.id === 'string' && a.id) {
        idx[a.id] = {
          type: typeof a.type === 'string' ? a.type : '',
          archived: a.archived === true
        };
      }
    }
    return idx;
  }

  /* ------------------------------------------------------------------ *
   * 3. 小额高频匹配（见头部注释第 7 条决策）
   * ------------------------------------------------------------------ */

  function matchSmallGroup(store, note, categoryId, amount, catIndex) {
    for (var g = 0; g < SMALL_GROUPS.length; g++) {
      var def = SMALL_GROUPS[g];
      var hit = false;
      if (note) {
        for (var p = 0; p < def.patterns.length; p++) {
          if (note.indexOf(def.patterns[p]) >= 0) { hit = true; break; }
        }
      }
      if (!hit && def.pinCategoryId && categoryId === def.pinCategoryId) { hit = true; }
      if (!hit) {
        /* 仅非 system 分类启用别名匹配：种子别名是 NL 词表，不代表整类语义 */
        var c = catIndex[categoryId];
        if (c && c.system !== true && Array.isArray(c.aliases)) {
          for (var a = 0; a < c.aliases.length && !hit; a++) {
            var alias = typeof c.aliases[a] === 'string' ? c.aliases[a] : '';
            for (var q = 0; q < def.patterns.length; q++) {
              if (alias && alias.indexOf(def.patterns[q]) >= 0) { hit = true; break; }
            }
          }
        }
      }
      if (hit) {
        var e = store[def.key];
        if (!e) { store[def.key] = e = { count: 0, cents: 0 }; }
        e.count += 1;
        e.cents += amount;
        return; /* 一笔只归第一组 */
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. 唯一导出：buildMonthlyMetrics(db, month, bookId)
   * ------------------------------------------------------------------ */

  function buildMonthlyMetrics(db, month, bookId) {
    /* 入参守卫：非法一律 null，不抛错 */
    if (!db || typeof db !== 'object' || !Array.isArray(db.transactions)) { return null; }
    var mKey = isValidMonthKey(month) ? month : '';
    if (!mKey) { return null; }
    var bid = (typeof bookId === 'string' && bookId) ? bookId : '';
    if (!bid) { return null; }

    var catIndex = buildCategoryIndex(db.categories);
    var accIndex = buildAccountIndex(db.accounts);
    var bucketOf = buildBucketIndex(resolveBuckets(db.settings));

    var prev1 = shiftMonth(mKey, -1);
    var prev2 = shiftMonth(mKey, -2);
    var today = todayInfo();

    /* ---- 月份桶：本月 / 上月 / 上上月，一次遍历分流 ---- */
    function newBucket() {
      return {
        incomeCents: 0,
        expenseCents: 0,
        creditSpendCents: 0,  /* 记在 credit 账户上的 expense（新增透支） */
        repaymentCents: 0,    /* 流入 credit 账户的金额（还款） */
        cats: Object.create(null)  /* categoryId -> { cents, count }（仅 expense） */
      };
    }
    var cur = newBucket();
    var p1 = newBucket();
    var p2 = newBucket();

    var incomeTxs = [];   /* 本月收入：{ categoryId, cents, date } */
    var expenseTxs = [];  /* 本月支出（异常候选）：{ date, cents, note, categoryId } */
    var smallCur = Object.create(null);
    var smallPrev = Object.create(null);
    var datesSeen = Object.create(null);  /* 本月有账的自然日 */
    var pendingReimburseCount = 0;
    var txCount = 0;
    var incomeRecordCount = 0;            /* 本月收入记录笔数（含「不计收支」，只判有没有记） */
    var earliestMonth = '';               /* 该账本最早有账月份（ma3 有效性判据） */

    /* ---- 唯一一次遍历流水：五道过滤与 core/stats.walk 完全同口径 ---- */
    var txs = db.transactions;
    for (var i = 0; i < txs.length; i++) {
      var tx = txs[i];
      if (!tx || tx.deleted === true) { continue; }                     /* 硬口径 1：过滤软删 */
      var type = tx.type;
      if (type !== TYPE_INCOME && type !== TYPE_EXPENSE && type !== TYPE_TRANSFER) { continue; }
      var amount = intOf(tx.amountCents);
      if (amount <= 0) { continue; }
      var date = typeof tx.date === 'string' ? tx.date : '';
      if (!isValidDateStr(date)) { continue; }
      if (tx.bookId !== bid) { continue; }                              /* 硬口径 3：按账本 */

      var mk = date.slice(0, 7);
      var bucket = (mk === mKey) ? cur : (mk === prev1 ? p1 : (mk === prev2 ? p2 : null));
      /* 2.28.2：txCount 不计 transfer——与屏级空账期门对齐。纯转账月 txCount=0，
         requestAiInsights 的 'empty' 守卫才能挡住，不会对没有收支的月份发 LLM 请求 */
      if (mk === mKey && type !== TYPE_TRANSFER) { txCount += 1; }
      /* 2.32.8：收入是否「记过」与收入金额无关。只记支出、不记收入的账本（学生记法常见），
         结余必然是负的；解读层据此关掉「入不敷出」类结论，避免每个月都报一次假红旗。
         放在 excludeStats 之前：标了「不计收支」的收入也算记过。 */
      if (mk === mKey && type === TYPE_INCOME) { incomeRecordCount += 1; }
      if (mk === mKey) { datesSeen[date] = 1; }

      if (earliestMonth === '' || mk < earliestMonth) { earliestMonth = mk; }

      var categoryId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
      var fromType = accIndex[typeof tx.accountId === 'string' ? tx.accountId : ''];
      var fromIsCredit = !!(fromType && fromType.type === 'credit');

      if (mk === mKey && tx.reimburse === 'pending') { pendingReimburseCount += 1; }

      /* 不计收支（2.28.10）：数值聚合跳过；txCount/报销计数/记账日已先行计入——
         「记了账但不进消费统计」，空账期判定与报销提醒不受影响 */
      if (tx.excludeStats === true) { continue; }

      if (!bucket) { continue; }

      if (type === TYPE_EXPENSE) {
        bucket.expenseCents += amount;
        var catRow = bucket.cats[categoryId];
        if (!catRow) { bucket.cats[categoryId] = catRow = { cents: 0, count: 0 }; }
        catRow.cents += amount;
        catRow.count += 1;
        if (fromIsCredit) { bucket.creditSpendCents += amount; }
        if (mk === mKey) {
          expenseTxs.push({
            date: date,
            cents: amount,
            note: typeof tx.note === 'string' ? tx.note : '',
            categoryId: categoryId
          });
          matchSmallGroup(smallCur, tx.note, categoryId, amount, catIndex);
        } else if (mk === prev1) {
          matchSmallGroup(smallPrev, tx.note, categoryId, amount, catIndex);
        }
      } else if (type === TYPE_INCOME) {
        bucket.incomeCents += amount;
        if (mk === mKey) {
          incomeTxs.push({ categoryId: categoryId, cents: amount, date: date });
        }
        if (fromIsCredit) { bucket.repaymentCents += amount; } /* 收入直记信用卡＝还款 */
      } else { /* transfer：硬口径 2，不计收支，只看还款流向 */
        var toAcc = typeof tx.toAccountId === 'string' ? tx.toAccountId : '';
        if (accIndex[toAcc] && accIndex[toAcc].type === 'credit') {
          bucket.repaymentCents += amount;
        } else if (fromIsCredit) {
          /* 2.28.2：信用卡取现（credit → 非 credit）是新增透支——「以贷养贷」的典型
             动作，旧版既不算借款也不算还款，恰好被放过 */
          bucket.creditSpendCents += amount;
        }
      }
    }

    /* ---- 收入稳定性分类（后处理，不再遍历流水） ---- */
    var stableByCat = Object.create(null);
    for (i = 0; i < incomeTxs.length; i++) {
      var cid = incomeTxs[i].categoryId;
      if (!ONE_TIME_SET[cid] && STABLE_SET[cid]) {
        if (!stableByCat[cid]) { stableByCat[cid] = []; }
        stableByCat[cid].push(incomeTxs[i].cents);
      }
    }
    /* 按分类各自求中位数：n≥3 才启用，阈值＝中位数×2 */
    var medianThreshold = Object.create(null);
    for (var sc in stableByCat) {
      if (!Object.prototype.hasOwnProperty.call(stableByCat, sc)) { continue; }
      var arr = stableByCat[sc].sort(function (a, b) { return a - b; });
      if (arr.length >= ONE_TIME_MEDIAN_MIN) {
        var med = medianOf(arr);
        medianThreshold[sc] = med * ONE_TIME_MEDIAN_MULT;
      }
    }
    var oneTimeCents = 0;
    var oneTimeAll = [];
    for (i = 0; i < incomeTxs.length; i++) {
      var it = incomeTxs[i];
      var flag = !!ONE_TIME_SET[it.categoryId] ||
        (medianThreshold[it.categoryId] !== undefined && it.cents > medianThreshold[it.categoryId]);
      if (flag) { oneTimeCents += it.cents; oneTimeAll.push(it); }
    }
    oneTimeAll.sort(function (a, b) { return b.cents - a.cents; });
    var oneTimeItems = [];
    for (i = 0; i < oneTimeAll.length && oneTimeItems.length < ONE_TIME_MAX; i++) {
      oneTimeItems.push({
        categoryId: oneTimeAll[i].categoryId,
        name: categoryNameOf(catIndex, oneTimeAll[i].categoryId),
        cents: oneTimeAll[i].cents,
        date: oneTimeAll[i].date
      });
    }
    var stableCents = cur.incomeCents - oneTimeCents;

    /* ---- 三桶结构（未分类＝ca_other_expense＋未映射自定义分类） ---- */
    var necessaryCents = 0;
    var developmentCents = 0;
    var enjoymentCents = 0;
    var uncatCents = 0;
    var necessaryByCat = [];
    for (var ckey in cur.cats) {
      if (!Object.prototype.hasOwnProperty.call(cur.cats, ckey)) { continue; }
      var row = cur.cats[ckey];
      var bucketName = bucketOf[ckey];
      if (ckey === UNCAT_ID || !bucketName) { uncatCents += row.cents; continue; }
      if (bucketName === 'necessary') {
        necessaryCents += row.cents;
        necessaryByCat.push({ categoryId: ckey, name: categoryNameOf(catIndex, ckey), cents: row.cents });
      } else if (bucketName === 'development') {
        developmentCents += row.cents;
      } else {
        enjoymentCents += row.cents;
      }
    }
    necessaryByCat.sort(function (a, b) { return b.cents - a.cents; });
    for (i = 0; i < necessaryByCat.length; i++) {
      necessaryByCat[i].pct = pctOf(necessaryByCat[i].cents, necessaryCents);
    }

    /* ---- 分类预算超支（含 3 个月窗口连续超支链） ---- */
    var cbs = Array.isArray(db.categoryBudgets) ? db.categoryBudgets : [];
    var cbLimit = Object.create(null); /* 'YYYY-MM|categoryId' -> limitCents（限本账本） */
    for (i = 0; i < cbs.length; i++) {
      var cb = cbs[i];
      if (!cb || cb.bookId !== bid || typeof cb.month !== 'string' || !isValidMonthKey(cb.month)) { continue; }
      var cbCat = typeof cb.categoryId === 'string' ? cb.categoryId : '';
      if (!cbCat) { continue; }
      var k = cb.month + '|' + cbCat;
      if (cbLimit[k] === undefined) { cbLimit[k] = intOf(cb.amountCents); }
    }
    function spentOf(bucketRef, catId) {
      var r = bucketRef.cats[catId];
      return r ? r.cents : 0;
    }
    var overCategories = [];
    for (i = 0; i < cbs.length; i++) {
      var cb2 = cbs[i];
      if (!cb2 || cb2.bookId !== bid || cb2.month !== mKey) { continue; }
      var overCatId = typeof cb2.categoryId === 'string' ? cb2.categoryId : '';
      if (!overCatId) { continue; }
      var limit = intOf(cb2.amountCents);
      if (limit <= 0) { continue; }
      var spent = spentOf(cur, overCatId);
      if (spent <= limit) { continue; }
      var chain = 1;
      var lim1 = cbLimit[prev1 + '|' + overCatId];
      if (lim1 !== undefined && lim1 > 0 && spentOf(p1, overCatId) > lim1) {
        chain += 1;
        var lim2 = cbLimit[prev2 + '|' + overCatId];
        if (lim2 !== undefined && lim2 > 0 && spentOf(p2, overCatId) > lim2) { chain += 1; }
      }
      overCategories.push({
        categoryId: overCatId,
        name: categoryNameOf(catIndex, overCatId),
        limitCents: limit,
        spentCents: spent,
        overCents: spent - limit,
        overPct: pctOf(spent - limit, limit),
        consecutiveMonths: chain
      });
    }
    overCategories.sort(function (a, b) { return b.overCents - a.overCents; });

    /* ---- 分类环比（mom）---- */
    var seenCats = Object.create(null);
    for (var ck in cur.cats) { if (Object.prototype.hasOwnProperty.call(cur.cats, ck)) { seenCats[ck] = 1; } }
    for (ck in p1.cats) { if (Object.prototype.hasOwnProperty.call(p1.cats, ck)) { seenCats[ck] = 1; } }
    var momItems = [];
    for (ck in seenCats) {
      if (!Object.prototype.hasOwnProperty.call(seenCats, ck)) { continue; }
      var cCur = spentOf(cur, ck);
      var cPrev = spentOf(p1, ck);
      momItems.push({
        categoryId: ck,
        name: categoryNameOf(catIndex, ck),
        currentCents: cCur,
        prevCents: cPrev,
        deltaCents: cCur - cPrev,
        deltaPct: cPrev > 0 ? round1((cCur - cPrev) / cPrev * 100) : null
      });
    }
    momItems.sort(function (a, b) {
      return (Math.abs(b.deltaCents) - Math.abs(a.deltaCents)) || (b.currentCents - a.currentCents);
    });
    function totalDelta(curCents, prevCents) {
      return {
        currentCents: curCents,
        prevCents: prevCents,
        deltaCents: curCents - prevCents,
        deltaPct: prevCents !== 0 ? round1((curCents - prevCents) / Math.abs(prevCents) * 100) : null
      };
    }

    /* ---- 3 个月移动平均（不足 3 个月数据给 null：以账本最早有账月为准） ---- */
    var ma3 = null;
    if (earliestMonth !== '' && earliestMonth <= prev2) {
      var inc3 = p2.incomeCents + p1.incomeCents + cur.incomeCents;
      var exp3 = p2.expenseCents + p1.expenseCents + cur.expenseCents;
      ma3 = {
        months: [prev2, prev1, mKey],
        incomeCents: Math.round(inc3 / 3),
        expenseCents: Math.round(exp3 / 3),
        netCents: Math.round((inc3 - exp3) / 3)
      };
    }

    /* ---- 异常大额（日均支出 ×3 或 500 元兜底，降序取 5） ---- */
    function elapsedDaysOf(mk2) {
      if (mk2 < today.month) { return daysInMonthOf(Number(mk2.slice(0, 4)), Number(mk2.slice(5, 7))); }
      if (mk2 === today.month) { return Math.max(1, today.day); }
      return 1; /* 未来月份无实绩，退化为只看大额兜底线 */
    }
    var dailyAvgCents = cur.expenseCents / elapsedDaysOf(mKey);
    var thrDaily = dailyAvgCents * ANOMALY_DAILY_MULT;
    var anomalyHits = [];
    for (i = 0; i < expenseTxs.length; i++) {
      if (expenseTxs[i].cents > thrDaily || expenseTxs[i].cents > BIG_TX_CENTS) {
        anomalyHits.push(expenseTxs[i]);
      }
    }
    anomalyHits.sort(function (a, b) { return b.cents - a.cents; });
    var anomalies = [];
    for (i = 0; i < anomalyHits.length && anomalies.length < ANOMALY_MAX; i++) {
      /* 2.28.2：不再带 note——全程无消费方（出站层 toInsightPayload 也只留
         date/amount/categoryName），聚合层多收一笔备注是多余的隐私面 */
      anomalies.push({
        date: anomalyHits[i].date,
        cents: anomalyHits[i].cents,
        categoryName: categoryNameOf(catIndex, anomalyHits[i].categoryId)
      });
    }

    /* ---- 小额高频（本月有、或上月有而本月归零也报，用于「戒掉」叙事） ---- */
    var smallFrequent = [];
    for (i = 0; i < SMALL_GROUPS.length; i++) {
      var def2 = SMALL_GROUPS[i];
      var curEntry = smallCur[def2.key];
      var prevEntry = smallPrev[def2.key];
      var curCents = curEntry ? curEntry.cents : 0;
      var prevCents = prevEntry ? prevEntry.cents : 0;
      if ((!curEntry || curEntry.count === 0) && prevCents === 0) { continue; }
      smallFrequent.push({
        key: def2.key,
        label: def2.label,
        count: curEntry ? curEntry.count : 0,
        totalCents: curCents,
        momPct: prevCents > 0 ? round1((curCents - prevCents) / prevCents * 100) : null
      });
    }
    smallFrequent.sort(function (a, b) { return b.totalCents - a.totalCents; });

    /* ---- 缓冲月数：复用 CONTRACT §6.2 冻结余额公式（账户维度跨账本） ---- */
    var availableCashCents = 0;
    var statsApi = XZB.core && XZB.core.stats;
    /* stats API 缺失（如 Node standalone 只 require 本模块）时 monthsCovered 给 null，
     * 不输出「0 个月缓冲」这种强假信号；cents 字段保持 0 以守住返回结构 */
    var statsMissing = !(statsApi && typeof statsApi.accountBalances === 'function');
    if (!statsMissing) {
      var balances = statsApi.accountBalances(db);
      var accList = Array.isArray(db.accounts) ? db.accounts : [];
      for (i = 0; i < accList.length; i++) {
        var acc = accList[i];
        if (!acc || typeof acc.id !== 'string' || !acc.id || acc.archived === true) { continue; }
        if (BUFFER_TYPES[acc.type]) {
          availableCashCents += typeof balances[acc.id] === 'number' ? balances[acc.id] : 0;
        }
      }
    }

    /* ---- dataQuality.missingDays：本月已过天数里没有任何交易的自然日 ---- */
    var dim = daysInMonthOf(Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)));
    var lastCheckedDay;
    if (mKey < today.month) { lastCheckedDay = dim; }
    else if (mKey === today.month) { lastCheckedDay = Math.min(dim, today.day); }
    else { lastCheckedDay = 0; }
    var missingDays = 0;
    for (var d = 1; d <= lastCheckedDay; d++) {
      if (!datesSeen[mKey + '-' + pad2(d)]) { missingDays += 1; }
    }

    var incomeCents = cur.incomeCents;
    var expenseCents = cur.expenseCents;
    var netCents = incomeCents - expenseCents;

    /* ---- 组装（键序与任务书返回结构一致） ---- */
    return {
      month: mKey,
      cashflow: {
        incomeCents: incomeCents,
        expenseCents: expenseCents,
        netCents: netCents,
        savingsRate: incomeCents > 0 ? round1(netCents / incomeCents * 100) : null,
        creditInflowCents: cur.creditSpendCents
      },
      income: {
        stableCents: stableCents,
        oneTimeCents: oneTimeCents,
        oneTimeItems: oneTimeItems
      },
      necessary: {
        totalCents: necessaryCents,
        covered: stableCents >= necessaryCents,
        byCategory: necessaryByCat
      },
      structure: {
        necessaryCents: necessaryCents,
        developmentCents: developmentCents,
        enjoymentCents: enjoymentCents,
        necessaryPct: pctOf(necessaryCents, expenseCents),
        developmentPct: pctOf(developmentCents, expenseCents),
        enjoymentPct: pctOf(enjoymentCents, expenseCents),
        uncategorizedPct: pctOf(uncatCents, expenseCents)
      },
      budget: {
        overCategories: overCategories
      },
      trends: {
        mom: {
          month: mKey,
          prevMonth: prev1,
          income: totalDelta(cur.incomeCents, p1.incomeCents),
          expense: totalDelta(cur.expenseCents, p1.expenseCents),
          net: totalDelta(netCents, p1.incomeCents - p1.expenseCents),
          items: momItems
        },
        ma3: ma3,
        anomalies: anomalies
      },
      smallFrequent: smallFrequent,
      debt: {
        monthlyRepaymentCents: cur.repaymentCents,
        repaymentToIncomeRatio: incomeCents > 0 ? round1(cur.repaymentCents / incomeCents * 100) : null,
        /* 以贷养贷 = 一边在还旧账、一边又在新增透支，且当月入不敷出。
           只看「有信用卡消费 + 结余为负」会把「用花呗付日常的穷月」误判成借贷风险，
           所以必须同时满足有还款（repaymentCents > 0）才置真。 */
        loanToLoanSuspect: cur.creditSpendCents > 0 && cur.repaymentCents > 0 && netCents < 0
      },
      buffer: {
        availableCashCents: availableCashCents,
        monthlyNecessaryCents: necessaryCents,
        monthsCovered: (necessaryCents > 0 && !statsMissing) ? round1(availableCashCents / necessaryCents) : null
      },
      dataQuality: {
        uncategorizedPct: pctOf(uncatCents, expenseCents),
        missingDays: missingDays,
        pendingReimburseCount: pendingReimburseCount,
        incomeRecorded: incomeRecordCount > 0,
        /* 2.32.8：收入覆盖支出的比例（%）。真实账单里收入常常只记了一部分，
           覆盖不足 50% 时结余为负多半是「没记全」而不是真赤字，解读层据此降级。 */
        incomeCoveragePct: pctOf(cur.incomeCents, expenseCents),
        txCount: txCount
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 4.5 输出层（第 2 轮）：AI 月度解读
   * 上游只喂本文件 buildMonthlyMetrics 的 metrics；本段负责：
   *   - toInsightPayload：整数分 metrics → 「元 + 2 位小数」可读请求体，
   *     剔除全部 *Id 字段与交易 note（隐私边界：请求体不含 id/note/照片）；
   *   - requestAiInsights：走 XZB.core.assistant.llm.chat 发请求，状态机重试，
   *     永不 throw / reject，结果恒为 {ok:true,items} | {ok:false,reason}；
   *   - buildFallbackInsights：本地规则兜底（零网络），条目与 AI 条目同构。
   * ------------------------------------------------------------------ */

  var INSIGHT_TIMEOUT_MS = 45000;  /* 实测 13s，留 3 倍余量 */
  var INSIGHT_MAX_TOKENS = 1500;
  var INSIGHT_MAX_ITEMS = 5;       /* 全月最多 5 条 */
  var INSIGHT_EVIDENCE_MAX = 6;
  var AI_LEVELS = { red: 1, orange: 1, yellow: 1, info: 1 };
  var AI_CATEGORIES = { '结余与负债':1, '必要支出':1, '支出结构':1, '连续超支':1, '高频小额':1, '负债红旗':1, '应急缓冲':1, '一次性收支':1, '数据质量':1 };
  var AI_MOM_TOP = 8;

  /* system prompt：2.32.8 重写——从「体检报告」改成「像朋友一样说明白」：
   * ① 先给一句 summary 总览（旧版只有问题清单，读起来像机器巡检）；
   * ② 收入没记过时不判「入不敷出」（学生账本普遍只记支出，旧版每月都报假红旗）；
   * ③ 条数收到 2-4 条、允许一条肯定，证据必须带对比，建议必须带数字。 */
  var AI_SYSTEM_LINES = [
    '你是「小账本」的月度账务顾问。说话像朋友，不摆财务架子，面向不懂术语的普通用户，全程简体中文。',
    '用户消息是一个月的聚合账单 JSON。只输出一个 JSON 对象，形如 {"summary":"…","items":[…]}；禁止 markdown 围栏，禁止任何解释文字。',
    'summary：1-2 句、60 字以内。先给这个月一句整体判断（比上月花得多还是少、主要花在哪、有没有异常高峰），用大白话，不要堆数字。',
    'items 每条形如 {"level":"red|orange|yellow|info","category":"九选一","title":"一句话说清是什么","evidence":["带数字的依据"],"suggestion":"下月做什么"}；category 只能取：结余与负债、必要支出、支出结构、连续超支、高频小额、负债红旗、应急缓冲、一次性收支、数据质量。',
    '条数只给 2-4 条：挑最值得说的，不要凑数，不要把一件事拆成两条；有做得好的地方可以给 1 条 info（如「外卖比上月少花 120 元」）。',
    'evidence 每条都要引用用户数据里已有的数字，且至少一条带对比（环比／占比／连续月数／与近 3 个月均值比）；禁止编造，禁止自己再算新数，禁止出现交易 id。',
    '能让数字更好懂时做生活化换算（如「相当于 24 杯奶茶」），但只能用数据里已有的小类金额，不能凭空估。',
    'suggestion 必须落到「下月一个动作 + 一个数字」（如「外卖每周限 3 次，一个月大约省 200 元」），禁止「注意节约」这类空话。',
    '重要：收入口径不完整时不要断言「入不敷出」。dataQuality.incomeRecorded 为 false（只记了支出没记收入）时，summary 先点明「本月只记了支出」，禁止说「支出超过收入／必要支出超过稳定收入」，也不要把结余为负当红旗；incomeRecorded 为 true 但 incomeCoveragePct < 50（收入只覆盖不到一半支出）时，指出「收入可能没记全」，同样不把结余为负当红旗。两种情况都把重点放在钱花到哪、比上月变化、哪类涨得多。',
    '数据不足降级：未分类占比 > 20 或缺记天数 > 5 时，最多再补 1 条数据质量提示，其余只保留高置信结论。',
    '金额单位是元（2 位小数）；字段值为 null 表示数据不足或该项不适用，不要当成 0，也不要臆造数值填充。',
    'level：red 当月必须处理；orange 需要调整；yellow 留意；info 一般说明或值得肯定。'
  ];

  /* 输出层专用：分 → 元字符串（任务书 §3 要求元 + 2 位小数）。
     聚合层的整数分约定不受影响——换算只发生在请求体与兜底文案里。 */
  function yuanText(cents) {
    return (Math.round(Number(cents) || 0) / 100).toFixed(2);
  }

  /* mom 总量环比 {currentCents,prevCents,deltaCents,deltaPct} → 元口径，整体 null 透传 */
  function momDeltaToYuan(d) {
    if (!d || typeof d !== 'object') { return null; }
    return {
      current: yuanText(d.currentCents),
      prev: yuanText(d.prevCents),
      delta: yuanText(d.deltaCents),
      deltaPct: typeof d.deltaPct === 'number' ? d.deltaPct : null
    };
  }

  /* metrics → 请求体：剔除全部 *Id 字段与交易 note（验收 #10），金额全走 yuanText */
  function toInsightPayload(m) {
    var cash = m.cashflow && typeof m.cashflow === 'object' ? m.cashflow : {};
    var income = m.income && typeof m.income === 'object' ? m.income : {};
    var necessary = m.necessary && typeof m.necessary === 'object' ? m.necessary : {};
    var structure = m.structure && typeof m.structure === 'object' ? m.structure : {};
    var budget = m.budget && typeof m.budget === 'object' ? m.budget : {};
    var trends = m.trends && typeof m.trends === 'object' ? m.trends : {};
    var mom = trends.mom && typeof trends.mom === 'object' ? trends.mom : {};
    var debt = m.debt && typeof m.debt === 'object' ? m.debt : {};
    var buffer = m.buffer && typeof m.buffer === 'object' ? m.buffer : {};
    var dq = m.dataQuality && typeof m.dataQuality === 'object' ? m.dataQuality : {};

    var oneTimeItems = [];
    var srcOneTime = Array.isArray(income.oneTimeItems) ? income.oneTimeItems : [];
    for (var i = 0; i < srcOneTime.length; i += 1) {
      oneTimeItems.push({ name: srcOneTime[i].name, amount: yuanText(srcOneTime[i].cents), date: srcOneTime[i].date });
    }

    var byCategory = [];
    var srcNecessary = Array.isArray(necessary.byCategory) ? necessary.byCategory : [];
    for (var j = 0; j < srcNecessary.length; j += 1) {
      byCategory.push({ name: srcNecessary[j].name, amount: yuanText(srcNecessary[j].cents), pct: srcNecessary[j].pct });
    }

    var overCategories = [];
    var srcOver = Array.isArray(budget.overCategories) ? budget.overCategories : [];
    for (var k = 0; k < srcOver.length; k += 1) {
      overCategories.push({
        name: srcOver[k].name,
        limit: yuanText(srcOver[k].limitCents),
        spent: yuanText(srcOver[k].spentCents),
        over: yuanText(srcOver[k].overCents),
        overPct: srcOver[k].overPct,
        consecutiveMonths: srcOver[k].consecutiveMonths
      });
    }

    var momItems = [];
    var srcMom = Array.isArray(mom.items) ? mom.items : [];
    for (var t = 0; t < srcMom.length && momItems.length < AI_MOM_TOP; t += 1) {
      momItems.push({
        name: srcMom[t].name,
        current: yuanText(srcMom[t].currentCents),
        prev: yuanText(srcMom[t].prevCents),
        delta: yuanText(srcMom[t].deltaCents),
        deltaPct: typeof srcMom[t].deltaPct === 'number' ? srcMom[t].deltaPct : null
      });
    }

    var ma3Src = trends.ma3 && typeof trends.ma3 === 'object' ? trends.ma3 : null;
    var ma3 = ma3Src ? {
      months: Array.isArray(ma3Src.months) ? ma3Src.months.slice(0, 3) : [],
      income: yuanText(ma3Src.incomeCents),
      expense: yuanText(ma3Src.expenseCents),
      net: yuanText(ma3Src.netCents)
    } : null;

    var anomalies = [];
    var srcAnom = Array.isArray(trends.anomalies) ? trends.anomalies : [];
    for (var a = 0; a < srcAnom.length && anomalies.length < 5; a += 1) {
      /* note 必须剥离：只留日期 / 金额 / 分类名 */
      anomalies.push({ date: srcAnom[a].date, amount: yuanText(srcAnom[a].cents), categoryName: srcAnom[a].categoryName });
    }

    var small = [];
    var srcSmall = Array.isArray(m.smallFrequent) ? m.smallFrequent : [];
    for (var s = 0; s < srcSmall.length; s += 1) {
      small.push({
        label: srcSmall[s].label,
        count: srcSmall[s].count,
        total: yuanText(srcSmall[s].totalCents),
        momPct: srcSmall[s].momPct
      });
    }

    return {
      month: m.month,
      unit: '元，保留2位小数',
      cashflow: {
        income: yuanText(cash.incomeCents),
        expense: yuanText(cash.expenseCents),
        net: yuanText(cash.netCents),
        savingsRatePct: cash.savingsRate,
        creditInflow: yuanText(cash.creditInflowCents)
      },
      income: {
        stable: yuanText(income.stableCents),
        oneTime: yuanText(income.oneTimeCents),
        oneTimeItems: oneTimeItems
      },
      necessary: {
        total: yuanText(necessary.totalCents),
        covered: necessary.covered === true,
        byCategory: byCategory
      },
      structure: {
        necessary: yuanText(structure.necessaryCents),
        development: yuanText(structure.developmentCents),
        enjoyment: yuanText(structure.enjoymentCents),
        necessaryPct: structure.necessaryPct,
        developmentPct: structure.developmentPct,
        enjoymentPct: structure.enjoymentPct,
        uncategorizedPct: structure.uncategorizedPct
      },
      budget: { overCategories: overCategories },
      trends: {
        prevMonth: mom.prevMonth,
        incomeMom: momDeltaToYuan(mom.income),
        expenseMom: momDeltaToYuan(mom.expense),
        netMom: momDeltaToYuan(mom.net),
        items: momItems,
        ma3: ma3,
        anomalies: anomalies
      },
      smallFrequent: small,
      debt: {
        monthlyRepayment: yuanText(debt.monthlyRepaymentCents),
        repaymentToIncomePct: debt.repaymentToIncomeRatio,
        loanToLoanSuspect: debt.loanToLoanSuspect === true
      },
      buffer: {
        availableCash: yuanText(buffer.availableCashCents),
        monthlyNecessary: yuanText(buffer.monthlyNecessaryCents),
        monthsCovered: buffer.monthsCovered
      },
      dataQuality: {
        uncategorizedPct: dq.uncategorizedPct,
        missingDays: dq.missingDays,
        pendingReimburseCount: dq.pendingReimburseCount,
        incomeRecorded: dq.incomeRecorded === true,
        incomeCoveragePct: dq.incomeCoveragePct,
        txCount: dq.txCount
      }
    };
  }

  /* OpenAI 兼容响应 → 文本：message.content（字符串或分段数组拼接），退化 choices[0].text */
  function choiceTextOf(json) {
    if (!json || typeof json !== 'object') { return ''; }
    var choices = Array.isArray(json.choices) ? json.choices : [];
    var first = choices.length ? choices[0] : null;
    if (!first) { return ''; }
    var message = first.message && typeof first.message === 'object' ? first.message : null;
    if (message) {
      if (typeof message.content === 'string') { return message.content; }
      if (Array.isArray(message.content)) {
        var parts = [];
        for (var i = 0; i < message.content.length; i += 1) {
          var seg = message.content[i];
          if (typeof seg === 'string') { parts.push(seg); }
          else if (seg && typeof seg === 'object' && typeof seg.text === 'string') { parts.push(seg.text); }
        }
        return parts.join('');
      }
    }
    return typeof first.text === 'string' ? first.text : '';
  }

  /* 解析结果 → {summary, items}：数组直接收；{items:[…]} 连 summary 一起收；其余 null。
     2.32.8 起模型可以多给一句 summary；老格式（纯数组）仍然兼容，summary 为空。 */
  function insightFromValue(v) {
    if (Array.isArray(v)) { return { summary: '', items: v }; }
    if (v && typeof v === 'object' && Array.isArray(v.items)) {
      return {
        summary: typeof v.summary === 'string' ? v.summary : '',
        items: v.items
      };
    }
    return null;
  }

  /* 宽容解析：剥 ```json 围栏 → 直接 JSON.parse → 失败再按 {...} / [...] 切片各试一次。
     切片顺序：先整体对象（新格式带 summary），对象切不出 items 时再试数组（老格式）。 */
  function parseInsightResult(text) {
    var raw = typeof text === 'string' ? text : '';
    if (!raw) { return null; }
    var stripped = raw.replace(/^\s*`{3,}\s*json\s*/i, '').replace(/`{3,}\s*$/, '');
    var direct = null;
    try { direct = JSON.parse(stripped); } catch (e) { direct = null; }
    var parsed = insightFromValue(direct);
    if (parsed) { return parsed; }
    var objStart = stripped.indexOf('{');
    var objEnd = stripped.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      var obj = null;
      try { obj = JSON.parse(stripped.slice(objStart, objEnd + 1)); } catch (e2) { obj = null; }
      parsed = insightFromValue(obj);
      if (parsed) { return parsed; }
    }
    var arrStart = stripped.indexOf('[');
    var arrEnd = stripped.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      var arr = null;
      try { arr = JSON.parse(stripped.slice(arrStart, arrEnd + 1)); } catch (e3) { arr = null; }
      parsed = insightFromValue(arr);
      if (parsed) { return parsed; }
    }
    return null;
  }

  function clipText(value, max) {
    return value.length > max ? value.slice(0, max) : value;
  }

  /* summary：压掉换行与多余空白，超长截断（模型偶尔会写成一段小作文） */
  function normalizeSummary(value) {
    var s = typeof value === 'string' ? value : '';
    s = s.replace(/\s+/g, ' ').trim();
    return s ? clipText(s, 90) : '';
  }

  /* schema 校验：脏数据直接丢弃，字段越界降级/截断，最多 INSIGHT_MAX_ITEMS 条 */
  function normalizeInsightItems(arr) {
    var out = [];
    var list = Array.isArray(arr) ? arr : [];
    for (var i = 0; i < list.length && out.length < INSIGHT_MAX_ITEMS; i += 1) {
      var it = list[i];
      if (!it || typeof it !== 'object' || Array.isArray(it)) { continue; }
      var title = typeof it.title === 'string' ? it.title : '';
      var suggestion = typeof it.suggestion === 'string' ? it.suggestion : '';
      if (!title.trim() || !suggestion.trim()) { continue; }
      var level = typeof it.level === 'string' && Object.prototype.hasOwnProperty.call(AI_LEVELS, it.level) ? it.level : 'info';
      var category = typeof it.category === 'string' && Object.prototype.hasOwnProperty.call(AI_CATEGORIES, it.category) ? it.category : '';
      var evidence = [];
      var srcEv = Array.isArray(it.evidence) ? it.evidence : [];
      for (var k = 0; k < srcEv.length && evidence.length < INSIGHT_EVIDENCE_MAX; k += 1) {
        if (typeof srcEv[k] === 'string' && srcEv[k].trim()) {
          evidence.push(clipText(srcEv[k].trim(), 120));
        }
      }
      out.push({
        level: level,
        category: category,
        title: clipText(title.trim(), 60),
        evidence: evidence,
        suggestion: clipText(suggestion.trim(), 200)
      });
    }
    return out;
  }

  /* 本地规则兜底（任务书 §6）：不联网，按红旗优先级产出 0-4 条，条目与 AI 条目同构。
     2.32.8：收入没记过的月份跳过结余/必要/缓冲三条（必为假红旗），改给一条「只记支出」提示。
     metrics 非法或缺 cashflow 返回 []；无命中也返回 []。 */
  function buildFallbackInsights(metrics) {
    var m = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : null;
    if (!m || !m.cashflow || typeof m.cashflow !== 'object') { return []; }
    var out = [];
    var cash = m.cashflow;
    var incomeCents = Number(cash.incomeCents) || 0;
    var expenseCents = Number(cash.expenseCents) || 0;
    var netCents = Number(cash.netCents) || 0;
    var incomeCents = Number(cash.incomeCents) || 0;
    /* 2.32.8：收入没记过的月份（只记支出的学生账本）不判结余、必要支出、应急金——
       这三项在「收入=0」时必然为负，旧版每月都报同一批红旗，解读会变成噪音。
       字段缺省按「记过」处理，保持旧指标对象的行为不变。 */
    var incomeRecorded = !(m.dataQuality && m.dataQuality.incomeRecorded === false);
    /* 收入记过但只覆盖不到一半支出（真实账单里很常见：生活费只记了零头）：
       结余为负同样不能当赤字断言，只提示「可能没记全」。字段缺省按完整处理，旧行为不变。 */
    var coverage = (m.dataQuality && typeof m.dataQuality.incomeCoveragePct === 'number')
      ? m.dataQuality.incomeCoveragePct : null;
    var incomeSolid = incomeRecorded && (coverage === null || coverage >= 50);

    /* 1. 结余为负（红旗） */
    if (netCents < 0 && incomeSolid) {
      var enjoyCents = m.structure && m.structure.enjoymentCents > 0 ? Number(m.structure.enjoymentCents) : 0;
      out.push({
        level: 'red',
        category: '结余与负债',
        title: '本月支出超过收入 ' + yuanText(-netCents) + ' 元',
        evidence: [
          '本月收入 ' + yuanText(incomeCents) + ' 元',
          '本月支出 ' + yuanText(expenseCents) + ' 元',
          '结余 ' + yuanText(netCents) + ' 元，为负'
        ],
        suggestion: enjoyCents > 0
          ? '本月享受型支出 ' + yuanText(enjoyCents) + ' 元，下月先砍掉其中一半（约 ' + yuanText(enjoyCents / 2) + ' 元），先试两周。'
          : '对照本月账单找出金额最大的一笔非必要支出，下月先取消或减半，先试两周。'
      });
    }

    /* 2. 疑似以贷养贷（红旗）——「当月结余为负」是判据之一，收入没记过时同样不成立 */
    if (incomeSolid && m.debt && typeof m.debt === 'object' && m.debt.loanToLoanSuspect === true) {
      out.push({
        level: 'red',
        category: '负债红旗',
        title: '疑似以贷养贷',
        evidence: [
          '本月还款 ' + yuanText(m.debt.monthlyRepaymentCents) + ' 元',
          '本月信用卡新增透支 ' + yuanText(cash.creditInflowCents) + ' 元',
          '当月结余为负（' + yuanText(netCents) + ' 元）'
        ],
        suggestion: '本月停止新增信用卡消费，日常改用储蓄卡支付；把透支额排进下月预算逐步还上。'
      });
    }

    /* 3. 必要支出未被稳定收入覆盖（红旗） */
    if (incomeSolid && m.necessary && typeof m.necessary === 'object' && m.necessary.covered === false) {
      var necessary = m.necessary;
      var byCat = Array.isArray(necessary.byCategory) ? necessary.byCategory : [];
      var topName = byCat.length && byCat[0] && typeof byCat[0].name === 'string' && byCat[0].name ? byCat[0].name : '';
      /* covered===false 的口径是稳定收入（income.stableCents）：不能拿含一次性收入的总营收冒充，否则缺口可为负（审查 P1-1） */
      var stableCents = m.income && typeof m.income === 'object' ? (Number(m.income.stableCents) || 0) : 0;
      out.push({
        level: 'red',
        category: '必要支出',
        title: '必要支出超过了稳定收入',
        evidence: [
          '必要支出合计 ' + yuanText(necessary.totalCents) + ' 元',
          '稳定收入 ' + yuanText(stableCents) + ' 元',
          '缺口 ' + yuanText((Number(necessary.totalCents) || 0) - stableCents) + ' 元'
        ],
        suggestion: topName
          ? '先保障「' + topName + '」等刚需，非必要支出等下月结余转正后再安排。'
          : '先保障必要开支，非必要支出等下月结余转正后再安排。'
      });
    }

    /* 4. 应急缓冲不足 1 个月（orange）——「可用现金」在只记支出时同样失真，跳过 */
    if (incomeSolid && m.buffer && typeof m.buffer === 'object' && typeof m.buffer.monthsCovered === 'number' && m.buffer.monthsCovered < 1) {
      out.push({
        level: 'orange',
        category: '应急缓冲',
        title: '应急金撑不到 1 个月必要支出',
        evidence: [
          '可用现金 ' + yuanText(m.buffer.availableCashCents) + ' 元',
          '本月必要支出 ' + yuanText(m.buffer.monthlyNecessaryCents) + ' 元',
          /* 现金透支时 monthsCovered 为负，按 0 显示（审查 P2-6） */
          '现金只够覆盖 ' + (m.buffer.monthsCovered < 0 ? '0.0' : m.buffer.monthsCovered.toFixed(1)) + ' 个月'
        ],
        suggestion: '先攒出 1 个月必要支出（约 ' + yuanText(m.buffer.monthlyNecessaryCents) + ' 元）作为应急金，结余优先存这笔。'
      });
    }

    /* 5. 收入口径不完整（info）：不吓人，只提醒补全口径，否则上面的结余/应急金永远算不准 */
    if (!incomeRecorded && expenseCents > 0) {
      out.push({
        level: 'info',
        category: '数据质量',
        title: '本月只记了支出，没有收入记录',
        evidence: [
          '本月支出 ' + yuanText(expenseCents) + ' 元',
          '本月收入记录 0 笔'
        ],
        suggestion: '把生活费、红包、兼职这类收入也记进来（记一笔时选「收入」），结余、能撑几个月才判断得准。'
      });
    } else if (!incomeSolid && coverage !== null && expenseCents > 0) {
      out.push({
        level: 'info',
        category: '数据质量',
        title: '收入可能没记全',
        evidence: [
          '本月收入 ' + yuanText(incomeCents) + ' 元，只覆盖支出 ' + coverage.toFixed(1) + '%',
          '本月支出 ' + yuanText(expenseCents) + ' 元'
        ],
        suggestion: '把本月剩下的生活费、红包也补记成收入，结余才算得准；只看支出结构的话，下面的分类结论仍然可用。'
      });
    }

    return out;
  }

  /* 请求 AI 解读（永不 throw、永不 reject）：
     守卫 → messages → 状态机（ok 出货 / 400 去字段重试一次 / 超时限流重试一次 / 其余按 code 映射）。
     currentOpts 承接 400 后的「去 enable_thinking」状态：后续超时重试不得把它加回来。 */
  function requestAiInsights(metrics, opts) {
    return Promise.resolve().then(function () {
      var o = opts && typeof opts === 'object' ? opts : {};
      var m = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : null;
      if (!m || !m.dataQuality || typeof m.dataQuality !== 'object' || typeof m.month !== 'string') {
        return { ok: false, reason: 'bad' };
      }
      if (!(Number(m.dataQuality.txCount) > 0)) { return { ok: false, reason: 'empty' }; } /* 空账期/脏 txCount（undefined→NaN）一律不发请求 */
      var assistant = XZB.core && XZB.core.assistant ? XZB.core.assistant : null;
      var llm = assistant && assistant.llm && typeof assistant.llm.chat === 'function' ? assistant.llm : null;
      var cfgView = null;
      if (llm && typeof llm.getConfig === 'function') {
        var got = llm.getConfig();
        if (got && got.ok === true && got.cfg && typeof got.cfg === 'object') { cfgView = got.cfg; }
      }
      if (!llm || !cfgView || cfgView.ready !== true) { return { ok: false, reason: 'config' }; }

      var messages = [
        { role: 'system', content: AI_SYSTEM_LINES.join('\n') },
        { role: 'user', content: JSON.stringify(toInsightPayload(m)) }
      ];
      var currentOpts = {
        timeoutMs: INSIGHT_TIMEOUT_MS,
        maxTokens: INSIGHT_MAX_TOKENS,
        extraBody: { enable_thinking: false }
      };
      var retried = false;
      var noThinkingTried = false;

      function step(res) {
        if (res && res.ok === true) {
          var parsed = parseInsightResult(choiceTextOf(res.json));
          if (!parsed) { return { ok: false, reason: 'bad' }; }
          return {
            ok: true,
            summary: normalizeSummary(parsed.summary),
            items: normalizeInsightItems(parsed.items)
          };
        }
        var code = res && typeof res.code === 'string' ? res.code : '';
        /* 端点不认 enable_thinking 的 400：去掉自定义字段重试一次 */
        if (res && res.status === 400 && !noThinkingTried) {
          noThinkingTried = true;
          currentOpts.extraBody = {};
          return llm.chat(messages, currentOpts).then(step);
        }
        /* 超时 / 限流：保留去字段状态重试一次 */
        if ((code === 'E_AS_NET_TIMEOUT' || code === 'E_AS_NET_RATE') && !retried) {
          retried = true;
          if (typeof o.onRetry === 'function') {
            try { o.onRetry(); } catch (error) { /* 回调失败不影响重试 */ }
          }
          return llm.chat(messages, currentOpts).then(step);
        }
        if (code === 'E_AS_NET_TIMEOUT') { return { ok: false, reason: 'timeout' }; }
        if (code === 'E_AS_NET_RATE') { return { ok: false, reason: 'rate' }; }
        /* E_AS_NOT_ACKED（已配置未告知）也归 config 兜底：insights 页有自己的隐私卡前置，不扩 UI。
           E_AS_NET_MIXED（https 页面配了 http://）同属配置问题，归 config 而非 bad（2.26.13） */
        /* E_AS_NOT_ACKED（已配置未告知）也归 config 兜底：insights 页有自己的隐私卡前置，不扩 UI。
           E_AS_NET_MIXED（https 页面配了 http://）同属配置问题，归 config 而非 bad（2.26.13）。
           E_AS_NET_CONFIG（401/403/404 等，mapStatus 归配置）与 E_AS_NET_OFFLINE（断网，2.28.1）
           同理归 config——落 bad 会让用户以为「返回内容无法识别」（2.28.1 修复） */
        if (code === 'E_AS_NOT_CONFIGURED' || code === 'E_AS_AI_DISABLED' || code === 'E_AS_NOT_ACKED'
          || code === 'E_AS_NET_MIXED' || code === 'E_AS_NET_CONFIG' || code === 'E_AS_NET_OFFLINE') { return { ok: false, reason: 'config' }; }
        return { ok: false, reason: 'bad' };
      }

      return llm.chat(messages, currentOpts).then(step);
    }).catch(function () {
      return { ok: false, reason: 'bad' };
    });
  }

  /* ------------------------------------------------------------------ *
   * 5. 导出（XZB.Core / XZB.core 双挂载，Node 下单测可 require）
   * ------------------------------------------------------------------ */

  var api = { buildMonthlyMetrics: buildMonthlyMetrics, requestAiInsights: requestAiInsights, buildFallbackInsights: buildFallbackInsights };
  Core.aiInsights = Object.freeze(api);
  if (XZB.core && XZB.core !== Core) { XZB.core.aiInsights = Core.aiInsights; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
