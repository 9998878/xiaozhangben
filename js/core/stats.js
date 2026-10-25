/* 小账本 2.0 · js/core/stats.js · owner: 后端（T07）
 * 契约锚点：
 *  - CONTRACT §6.2 余额公式唯一实现：accountBalanceCents / accountBalanceAt / netWorthCents / bookMonthTotals；
 *  - CONTRACT §6.4 统计冻结签名与返回结构：monthSummary … bookOverview（字段逐字，不增不减）；
 *  - CONTRACT §9 B8：信用卡可用额度 creditAvailable（未设额度返回 hasLimit:false + label "未设额度"）。
 * 设计约束：
 *  - 纯函数：不写库、不改入参、不发请求；输入 db（或实体数组），输出普通对象，可直接喂 XZB.ui.charts。
 *  - 金额一律「分」整数；日期一律本地 YYYY-MM-DD 字符串，日期运算全部走 XZB.Core.dates，不自己解析。
 *  - 转账（type:'transfer'）不计收入/支出/排行/热力图，只在账户余额与账户构成里体现。
 *  - deleted === true 的交易与目标存入一律过滤；归档账户仍计入账户构成与净资产。
 *  - 不做缓存：5000 条流水单次遍历即可（CONTRACT §6.4 性能要求 <50ms），纯函数便于单测与撤销后即时刷新。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  /* ============================== 常量 ============================== */

  var TYPE_INCOME = 'income';
  var TYPE_EXPENSE = 'expense';
  var TYPE_TRANSFER = 'transfer';

  var RANK_LIMIT_DEFAULT = 8;    /* CONTRACT §6.4：分类排行默认 8 */
  var RANK_LIMIT_MAX = 20;       /* CONTRACT §6.4：分类排行最大 20 */
  var TREND_POINTS_MAX = 366;    /* CONTRACT §10 R2：图表点数上限 366 */
  var WARN_PCT = 80;             /* CONTRACT §6.4：预算预警阈值 80% */
  var NOTE_LIMIT_DEFAULT = 5;
  var NOTE_LIMIT_MAX = 20;

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var MONTH_RE = /^\d{4}-\d{2}$/;
  var YEAR_RE = /^\d{4}$/;

  /* 账户类型默认色（CONTRACT §2.2），只在数据缺 color 时兜底 */
  var ACCOUNT_COLOR = {
    cash: '#34C759',
    debit: '#007AFF',
    wechat: '#07C160',
    alipay: '#1677FF',
    credit: '#FF3B30',
    savings: '#FF9500'
  };

  /* 时段桶（CONTRACT §6.4，左闭右开；无 time 归 noon） */
  var TIME_BUCKETS = [
    { key: 'morning', label: '早上' },
    { key: 'noon', label: '中午' },
    { key: 'afternoon', label: '下午' },
    { key: 'evening', label: '晚上' },
    { key: 'night', label: '夜间' }
  ];
  var TIME_BUCKET_INDEX = {
    morning: 0,
    noon: 1,
    afternoon: 2,
    evening: 3,
    night: 4
  };

  /* ============================== 依赖 ============================== */

  var datesCache = null;

  /* 延迟解析日期依赖：浏览器按 INTERFACE-FREEZE 的加载顺序先加载 dates.js；
   * Node 单测由调用方先 require dates.js。这里不 require 任何文件（禁 require 跨文件依赖）。 */
  function datesApi() {
    if (datesCache) { return datesCache; }
    var api = (global.XZB && global.XZB.Core && global.XZB.Core.dates) ||
      (global.XZB && global.XZB.core && global.XZB.core.dates) || null;
    if (!api) {
      throw new Error('E_STATS_NO_DATES: stats.js 依赖 XZB.Core.dates，请先加载 dates.js');
    }
    datesCache = api;
    return api;
  }

  /* ============================== 通用工具 ============================== */

  function isObj(value) {
    return value !== null && typeof value === 'object';
  }

  function arr(value) {
    return Array.isArray(value) ? value : [];
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /* 任意数值 -> 分整数（非法/NaN 归 0；四舍五入只用于脏数据兜底） */
  function intOf(value) {
    if (!isNum(value)) { return 0; }
    return Math.round(value);
  }

  /* 比例保留 1 位小数（CONTRACT §6.4 round1） */
  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function pctOf(part, total) {
    if (!total) { return 0; }
    return round1(part / total * 100);
  }

  function clampInt(value, fallback, min, max) {
    var n = intOf(value);
    if (!isNum(value)) { return fallback; }
    if (n < min) { return min; }
    if (n > max) { return max; }
    return n;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function findById(list, id) {
    if (typeof id !== 'string' || !id) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function indexById(list) {
    var map = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].id === 'string') { map[list[i].id] = list[i]; }
    }
    return map;
  }

  function typeOf(tx) {
    var t = tx && tx.type;
    return (t === TYPE_INCOME || t === TYPE_EXPENSE || t === TYPE_TRANSFER) ? t : '';
  }

  function isDateStr(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) { return false; }
    return datesApi().isValidDateStr(value);
  }

  function dateOf(tx) {
    var value = tx && tx.date;
    return typeof value === 'string' && DATE_RE.test(value) ? value : '';
  }

  function monthOfDate(dateStr) {
    return dateStr.slice(0, 7);
  }

  function currentMonth() {
    var D = datesApi();
    var key = D.monthKey(D.todayStr());
    return key || '';
  }

  function normalizeMonth(value) {
    if (typeof value === 'string') {
      if (MONTH_RE.test(value) && datesApi().isValidMonthStr(value)) { return value; }
      if (isDateStr(value)) { return monthOfDate(value); }
      return '';
    }
    if (isObj(value) && typeof value.month === 'string') { return normalizeMonth(value.month); }
    return '';
  }

  function normalizeDay(value) {
    return isDateStr(value) ? value : '';
  }

  function normalizeYear(value) {
    if (isNum(value) && value >= 1000 && value <= 9999) { return String(Math.round(value)); }
    if (typeof value === 'string' && YEAR_RE.test(value)) { return value; }
    return '';
  }

  /* 「YYYY-MM」-> {start,end} 闭区间字符串；非法返回空区间 */
  function monthRangeOf(month) {
    var r = datesApi().monthRange(month);
    if (!r) { return { start: '', end: '' }; }
    return { start: r.start, end: r.end };
  }

  function prevMonthOf(month) {
    var D = datesApi();
    var key = D.monthKey(D.addMonths(month + '-01', -1));
    return key || '';
  }

  /* 环比/同比差值对象；除零返回 deltaPct:null（绝不出 Infinity/NaN） */
  function deltaOf(current, prev) {
    var deltaCents = current - prev;
    var deltaPct = prev === 0 ? null : round1(deltaCents / Math.abs(prev) * 100);
    return {
      current: current,
      prev: prev,
      deltaCents: deltaCents,
      deltaPct: deltaPct
    };
  }

  /* ============================== 数据模型 ============================== */

  function emptyModel() {
    return {
      transactions: [],
      accounts: [],
      categories: [],
      books: [],
      budgets: [],
      categoryBudgets: [],
      goals: [],
      goalDeposits: [],
      settings: null,
      activeBookId: '',
      bookArchived: Object.create(null),
      hasBooks: false
    };
  }

  /* 首参多态：db 对象（或 {transactions:[...]} 模型）→ 取各实体数组；
   * 数组 → 直接当作流水集合（任务书 T07 的数组形态调用）。 */
  function resolve(source) {
    var model = emptyModel();
    if (Array.isArray(source)) {
      model.transactions = source;
      return model;
    }
    if (!isObj(source)) { return model; }

    model.transactions = Array.isArray(source.transactions) ? source.transactions :
      (Array.isArray(source.txs) ? source.txs : []);
    model.accounts = arr(source.accounts);
    model.categories = arr(source.categories);
    model.books = arr(source.books);
    model.budgets = arr(source.budgets);
    model.categoryBudgets = arr(source.categoryBudgets);
    model.goals = arr(source.goals);
    model.goalDeposits = arr(source.goalDeposits);
    model.settings = isObj(source.settings) ? source.settings : null;

    if (typeof source.activeBookId === 'string') {
      model.activeBookId = source.activeBookId;
    } else if (isObj(source.state) && typeof source.state.activeBookId === 'string') {
      model.activeBookId = source.state.activeBookId;
    }

    model.hasBooks = model.books.length > 0;
    for (var i = 0; i < model.books.length; i++) {
      var book = model.books[i];
      if (book && typeof book.id === 'string') {
        model.bookArchived[book.id] = book.archived === true;
      }
    }
    return model;
  }

  /* 当前账本：db.activeBookId → store.state.activeBookId → 第一个未归档账本 → ''（数组形态） */
  function currentBookId(model) {
    if (model.activeBookId) { return model.activeBookId; }
    try {
      var store = global.XZB && global.XZB.store;
      var state = store && store.state;
      if (state && typeof state.activeBookId === 'string' && state.activeBookId) {
        return state.activeBookId;
      }
    } catch (e) {
      /* store 未加载或内存降级时忽略，走下面的兜底 */
    }
    for (var i = 0; i < model.books.length; i++) {
      var book = model.books[i];
      if (book && book.archived !== true && typeof book.id === 'string' && book.id) {
        return book.id;
      }
    }
    return '';
  }

  /* 账本作用域：
   *  - opts.bookId 为字符串 → 只统计该账本；
   *  - opts.bookId 显式为 null → 全部未归档账本合计（归档账本排除）；
   *  - 缺省 → 当前账本；无账本信息（数组形态）→ 不做账本过滤。 */
  function bookScope(model, opts) {
    var o = isObj(opts) ? opts : {};
    if (Object.prototype.hasOwnProperty.call(o, 'bookId')) {
      if (o.bookId === null) { return { mode: 'all', bookId: null }; }
      if (typeof o.bookId === 'string' && o.bookId) { return { mode: 'one', bookId: o.bookId }; }
    }
    var current = currentBookId(model);
    if (current) { return { mode: 'one', bookId: current }; }
    return { mode: 'all', bookId: null };
  }

  function isArchivedBook(model, bookId) {
    if (!model.hasBooks) { return false; }
    return model.bookArchived[bookId] === true;
  }

  /* 统一遍历：过滤软删、非法类型/金额/日期、账本作用域；transfer 也交给访客自行决定 */
  function walk(model, scope, visit) {
    var list = model.transactions;
    var one = scope.mode === 'one';
    var all = scope.mode === 'all';
    for (var i = 0; i < list.length; i++) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (one) {
        if (tx.bookId !== scope.bookId) { continue; }
      } else if (all && isArchivedBook(model, tx.bookId)) {
        continue;
      }
      var type = typeOf(tx);
      if (!type) { continue; }
      var amount = intOf(tx.amountCents);
      if (amount <= 0) { continue; }
      var date = dateOf(tx);
      if (!date || !isDateStr(date)) { continue; }
      visit(tx, type, amount, date);
    }
  }

  /* 区间聚合（闭区间）：income/expense/net/count 只算收支，transfer 单列 */
  function totalRange(model, scope, from, to) {
    var acc = {
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
      count: 0,
      transferCents: 0,
      transferCount: 0
    };
    walk(model, scope, function (tx, type, amount, date) {
      if (date < from || date > to) { return; }
      if (type === TYPE_INCOME) {
        acc.incomeCents += amount;
        acc.count += 1;
      } else if (type === TYPE_EXPENSE) {
        acc.expenseCents += amount;
        acc.count += 1;
      } else {
        acc.transferCents += amount;
        acc.transferCount += 1;
      }
    });
    acc.netCents = acc.incomeCents - acc.expenseCents;
    return acc;
  }

  /* ============================== 余额（§6.2 唯一实现） ============================== */

  /* 一次遍历聚合所有账户余额；不按账本过滤（CONTRACT §6.2）。
   * balance = openingBalanceCents + Σincome - Σexpense + ΣtransferIn - ΣtransferOut
   * 账户表里没有的 id 会按流水动态建键，便于数组形态调用。 */
  function balanceMap(model, untilDate) {
    var map = Object.create(null);
    var i;
    for (i = 0; i < model.accounts.length; i++) {
      var account = model.accounts[i];
      if (account && typeof account.id === 'string' && account.id) {
        map[account.id] = intOf(account.openingBalanceCents);
      }
    }
    var cutoff = typeof untilDate === 'string' && untilDate ? untilDate : '';
    var list = model.transactions;
    for (i = 0; i < list.length; i++) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      var amount = intOf(tx.amountCents);
      if (amount <= 0) { continue; }
      var date = dateOf(tx);
      if (!date || !isDateStr(date)) { continue; }
      if (cutoff && date > cutoff) { continue; }
      var type = typeOf(tx);
      var from = typeof tx.accountId === 'string' ? tx.accountId : '';
      if (!from) { continue; }
      if (map[from] === undefined) { map[from] = 0; }
      if (type === TYPE_EXPENSE) {
        map[from] -= amount;
      } else if (type === TYPE_INCOME) {
        map[from] += amount;
      } else if (type === TYPE_TRANSFER) {
        map[from] -= amount;
        var to = typeof tx.toAccountId === 'string' ? tx.toAccountId : '';
        if (to && to !== from) {
          if (map[to] === undefined) { map[to] = 0; }
          map[to] += amount;
        }
      }
    }
    return map;
  }

  /* 单账户余额（整段历史；CONTRACT §6.2 冻结名） */
  function accountBalanceCents(source, accountId) {
    var model = resolve(source);
    if (typeof accountId !== 'string' || !accountId) { return 0; }
    var map = balanceMap(model, '');
    return typeof map[accountId] === 'number' ? map[accountId] : 0;
  }

  /* 某日截止余额：只统计 tx.date <= dateStr；日期非法时退化为整段历史 */
  function accountBalanceAt(source, accountId, dateStr) {
    var model = resolve(source);
    if (typeof accountId !== 'string' || !accountId) { return 0; }
    var until = normalizeDay(dateStr);
    var map = balanceMap(model, until);
    return typeof map[accountId] === 'number' ? map[accountId] : 0;
  }

  /* 全部账户余额表（浅拷贝，调用方拿到的是快照） */
  function accountBalances(source, dateStr) {
    var model = resolve(source);
    var map = balanceMap(model, normalizeDay(dateStr));
    var out = {};
    for (var key in map) {
      if (Object.prototype.hasOwnProperty.call(map, key)) { out[key] = map[key]; }
    }
    return out;
  }

  /* 净资产：所有账户余额之和（含归档账户，CONTRACT §6.2） */
  function netWorthCents(source) {
    var model = resolve(source);
    var map = balanceMap(model, '');
    var total = 0;
    var i;
    if (model.accounts.length > 0) {
      for (i = 0; i < model.accounts.length; i++) {
        var account = model.accounts[i];
        if (account && typeof account.id === 'string' && typeof map[account.id] === 'number') {
          total += map[account.id];
        }
      }
    } else {
      for (var key in map) {
        if (Object.prototype.hasOwnProperty.call(map, key)) { total += map[key]; }
      }
    }
    return total;
  }

  /* 单账本单月收支合计（CONTRACT §6.2） */
  function bookMonthTotals(source, bookId, month) {
    var model = resolve(source);
    var m = normalizeMonth(month) || currentMonth();
    var r = monthRangeOf(m);
    var totals = totalRange(model, { mode: 'one', bookId: String(bookId || '') }, r.start, r.end);
    return {
      incomeCents: totals.incomeCents,
      expenseCents: totals.expenseCents,
      netCents: totals.netCents,
      count: totals.count
    };
  }

  /* 信用卡可用额度（CONTRACT §9 B8）：limitCents === 0 视为未设额度 */
  function creditAvailable(source, balanceOrId) {
    var account = null;
    var balance = 0;
    if (isObj(source) && Array.isArray(source.accounts) && typeof balanceOrId === 'string') {
      var model = resolve(source);
      account = findById(model.accounts, balanceOrId);
      if (account) { balance = accountBalanceCents(model, balanceOrId); }
      return creditAvailable(account || {}, balance);
    }
    account = isObj(source) ? source : {};
    if (isNum(balanceOrId)) {
      balance = Math.round(balanceOrId);
    } else {
      balance = intOf(account.openingBalanceCents);
    }
    var limit = intOf(account.limitCents);
    var hasLimit = limit > 0;
    return {
      accountId: typeof account.id === 'string' ? account.id : '',
      limitCents: limit,
      balanceCents: balance,
      hasLimit: hasLimit,
      availableCents: hasLimit ? Math.max(0, limit + balance) : null,
      debtCents: balance < 0 ? -balance : 0,
      label: hasLimit ? '' : '未设额度'
    };
  }

  /* ============================== §6.4 冻结函数 ============================== */

  /* 月度汇总：MonthSummary */
  function monthSummary(source, month, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    if (isObj(month) && opts === undefined) {
      o = month;
      month = o.month;
    }
    var m = normalizeMonth(month) || normalizeMonth(o.month) || currentMonth();
    var r = monthRangeOf(m);
    var scope = bookScope(model, o);
    var totals = totalRange(model, scope, r.start, r.end);
    return {
      month: m,
      bookId: scope.bookId || null,
      incomeCents: totals.incomeCents,
      expenseCents: totals.expenseCents,
      netCents: totals.netCents,
      count: totals.count,
      transferCents: totals.transferCents,
      transferCount: totals.transferCount
    };
  }

  /* 年度汇总：YearSummary（12 个月固定补 0） */
  function yearSummary(source, year, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    if (isObj(year) && opts === undefined) {
      o = year;
      year = o.year;
    }
    var y = normalizeYear(year);
    if (!y) {
      var D0 = datesApi();
      y = normalizeYear(D0.todayStr().slice(0, 4)) || '';
    }
    var months = [];
    var index = Object.create(null);
    for (var n = 1; n <= 12; n++) {
      var key = y + '-' + pad2(n);
      index[key] = months.length;
      months.push({ month: key, incomeCents: 0, expenseCents: 0, netCents: 0 });
    }
    var scope = bookScope(model, o);
    walk(model, scope, function (tx, type, amount, date) {
      if (!y || date.slice(0, 4) !== y) { return; }
      var slot = index[monthOfDate(date)];
      if (slot === undefined) { return; }
      if (type === TYPE_INCOME) {
        months[slot].incomeCents += amount;
      } else if (type === TYPE_EXPENSE) {
        months[slot].expenseCents += amount;
      }
    });
    var totals = { incomeCents: 0, expenseCents: 0, netCents: 0 };
    for (var i = 0; i < months.length; i++) {
      months[i].netCents = months[i].incomeCents - months[i].expenseCents;
      totals.incomeCents += months[i].incomeCents;
      totals.expenseCents += months[i].expenseCents;
      totals.netCents += months[i].netCents;
    }
    return {
      year: y,
      bookId: scope.bookId || null,
      months: months,
      totals: totals
    };
  }

  /* 时间序列：TrendResult；granularity = day | week | month，空桶补 0。
   * opts.withCumulative === true 时额外追加 {key:'cumulative'} 系列（任务书 T07 的累计线），
   * 默认输出保持 CONTRACT §6.4 冻结的三条收入/支出/结余系列。 */
  function trend(source, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    var D = datesApi();
    var gran = o.granularity === 'week' ? 'week' : (o.granularity === 'month' ? 'month' : 'day');

    var to = normalizeDay(o.to) || D.todayStr();
    var from = normalizeDay(o.from);
    if (!from) {
      from = D.addMonths(D.startOfMonth(to), -11);
      if (!from) { from = D.startOfMonth(to); }
    }
    if (!from || !to) {
      return {
        granularity: gran, from: '', to: '', bookId: null,
        labels: [], series: [], totals: { incomeCents: 0, expenseCents: 0, netCents: 0 }
      };
    }
    if (from > to) {
      var swap = from;
      from = to;
      to = swap;
    }

    /* 点数上限 366（CONTRACT §10 R2）：超限时向后收缩起点，保持末端完整 */
    var spanDays = D.daysBetween(from, to);
    if (isNum(spanDays) && spanDays + 1 > TREND_POINTS_MAX) {
      if (gran === 'day') {
        from = D.addDays(to, -(TREND_POINTS_MAX - 1)) || from;
      } else if (gran === 'week') {
        var weeks = Math.ceil((spanDays + 1) / 7);
        if (weeks > TREND_POINTS_MAX) {
          from = D.addDays(from, (weeks - TREND_POINTS_MAX) * 7) || from;
        }
      } else {
        var months = Math.ceil((spanDays + 1) / 30);
        if (months > TREND_POINTS_MAX) {
          from = D.addMonths(from, months - TREND_POINTS_MAX) || from;
        }
      }
    }

    var crossYear = from.slice(0, 4) !== to.slice(0, 4);
    var buckets = [];
    var cursor = '';
    var i;

    if (gran === 'day') {
      cursor = from;
      while (cursor && cursor <= to) {
        buckets.push({ key: cursor, label: crossYear ? cursor : cursor.slice(5), incomeCents: 0, expenseCents: 0 });
        cursor = D.addDays(cursor, 1);
      }
    } else if (gran === 'week') {
      cursor = D.startOfWeek(from);
      while (cursor && cursor <= to) {
        buckets.push({ key: cursor, label: crossYear ? cursor : cursor.slice(5), incomeCents: 0, expenseCents: 0 });
        cursor = D.addDays(cursor, 7);
      }
    } else {
      cursor = D.startOfMonth(from);
      var endMonth = monthOfDate(to);
      while (cursor && monthOfDate(cursor) <= endMonth) {
        var monthKey = monthOfDate(cursor);
        buckets.push({ key: monthKey, label: monthKey, incomeCents: 0, expenseCents: 0 });
        cursor = D.addMonths(cursor, 1);
      }
    }

    var bucketIndex = Object.create(null);
    for (i = 0; i < buckets.length; i++) { bucketIndex[buckets[i].key] = i; }

    var scope = bookScope(model, o);
    var totals = { incomeCents: 0, expenseCents: 0, netCents: 0 };
    walk(model, scope, function (tx, type, amount, date) {
      if (date < from || date > to) { return; }
      if (type === TYPE_TRANSFER) { return; }
      var key = gran === 'day' ? date : (gran === 'week' ? D.startOfWeek(date) : monthOfDate(date));
      var slot = bucketIndex[key];
      if (slot === undefined) { return; }
      if (type === TYPE_INCOME) {
        buckets[slot].incomeCents += amount;
        totals.incomeCents += amount;
      } else {
        buckets[slot].expenseCents += amount;
        totals.expenseCents += amount;
      }
    });
    totals.netCents = totals.incomeCents - totals.expenseCents;

    var labels = [];
    var incomeValues = [];
    var expenseValues = [];
    var netValues = [];
    for (i = 0; i < buckets.length; i++) {
      labels.push(buckets[i].label);
      incomeValues.push(buckets[i].incomeCents);
      expenseValues.push(buckets[i].expenseCents);
      netValues.push(buckets[i].incomeCents - buckets[i].expenseCents);
    }
    var series = [
      { key: 'income', name: '收入', values: incomeValues },
      { key: 'expense', name: '支出', values: expenseValues },
      { key: 'net', name: '结余', values: netValues }
    ];
    if (o.withCumulative === true) {
      var running = 0;
      var cumulative = [];
      for (i = 0; i < netValues.length; i++) {
        running += netValues[i];
        cumulative.push(running);
      }
      series.push({ key: 'cumulative', name: '累计结余', values: cumulative });
    }

    return {
      granularity: gran,
      from: from,
      to: to,
      bookId: scope.bookId || null,
      labels: labels,
      series: series,
      totals: totals
    };
  }

  /* 环比：MomResult（deltaPct 除零为 null） */
  function mom(source, month, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    if (isObj(month) && opts === undefined) {
      o = month;
      month = o.month;
    }
    var m = normalizeMonth(month) || normalizeMonth(o.month) || currentMonth();
    var prev = prevMonthOf(m);
    var scope = bookScope(model, o);
    var currentRange = monthRangeOf(m);
    var prevRange = monthRangeOf(prev);
    var current = totalRange(model, scope, currentRange.start, currentRange.end);
    var before = totalRange(model, scope, prevRange.start, prevRange.end);
    return {
      month: m,
      prevMonth: prev,
      bookId: scope.bookId || null,
      income: deltaOf(current.incomeCents, before.incomeCents),
      expense: deltaOf(current.expenseCents, before.expenseCents),
      net: deltaOf(current.netCents, before.netCents)
    };
  }

  /* 分类聚合（供排行/预算复用） */
  function categorySums(model, scope, month, kind) {
    var r = monthRangeOf(month);
    var map = Object.create(null);
    var total = 0;
    walk(model, scope, function (tx, type, amount, date) {
      if (type !== kind) { return; }
      if (date < r.start || date > r.end) { return; }
      var id = typeof tx.categoryId === 'string' ? tx.categoryId : '';
      if (!map[id]) { map[id] = { categoryId: id, amountCents: 0, count: 0 }; }
      map[id].amountCents += amount;
      map[id].count += 1;
      total += amount;
    });
    return { map: map, totalCents: total };
  }

  /* 排行核心：金额降序 → 分类 sort 升序 → name.localeCompare('zh-Hans-CN') */
  function rankCore(model, scope, month, kind, limit, withMom) {
    var D = datesApi();
    var current = categorySums(model, scope, month, kind);
    var prevMap = withMom ? categorySums(model, scope, D.monthKey(D.addMonths(month + '-01', -1)), kind).map : null;
    var categoryIndex = indexById(model.categories);
    var rows = [];
    for (var key in current.map) {
      if (Object.prototype.hasOwnProperty.call(current.map, key)) { rows.push(current.map[key]); }
    }
    rows.sort(function (a, b) {
      if (b.amountCents !== a.amountCents) { return b.amountCents - a.amountCents; }
      var catA = categoryIndex[a.categoryId];
      var catB = categoryIndex[b.categoryId];
      var sortA = catA ? intOf(catA.sort) : 999999;
      var sortB = catB ? intOf(catB.sort) : 999999;
      if (sortA !== sortB) { return sortA - sortB; }
      var nameA = catA && catA.name ? String(catA.name) : '';
      var nameB = catB && catB.name ? String(catB.name) : '';
      return nameA.localeCompare(nameB, 'zh-Hans-CN');
    });

    var total = current.totalCents;
    var shown = rows.slice(0, limit);
    var items = [];
    var used = 0;
    for (var i = 0; i < shown.length; i++) {
      var row = shown[i];
      var category = categoryIndex[row.categoryId];
      var item = {
        categoryId: row.categoryId,
        name: category && category.name ? String(category.name) : '未分类',
        icon: category && category.icon ? String(category.icon) : 'ellipsis',
        color: category && category.color ? String(category.color) : '#8E8E93',
        amountCents: row.amountCents,
        pct: pctOf(row.amountCents, total),
        count: row.count
      };
      if (withMom) {
        var prevRow = prevMap[row.categoryId];
        var prevCents = prevRow ? prevRow.amountCents : 0;
        item.prevCents = prevCents;
        item.deltaCents = row.amountCents - prevCents;
        item.deltaPct = prevCents === 0 ? null : round1((row.amountCents - prevCents) / Math.abs(prevCents) * 100);
      }
      used += row.amountCents;
      items.push(item);
    }
    var otherCents = total - used;
    if (otherCents < 0) { otherCents = 0; }
    return { totalCents: total, otherCents: otherCents, items: items };
  }

  function rankLimit(value) {
    if (value === undefined || value === null || value === '') { return RANK_LIMIT_DEFAULT; }
    return clampInt(value, RANK_LIMIT_DEFAULT, 1, RANK_LIMIT_MAX);
  }

  /* 分类排行：CategoryRank */
  function categoryRank(source, month, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    if (isObj(month) && opts === undefined) {
      o = month;
      month = o.month;
    }
    var m = normalizeMonth(month) || normalizeMonth(o.month) || currentMonth();
    var kind = o.kind === TYPE_INCOME ? TYPE_INCOME : TYPE_EXPENSE;
    var scope = bookScope(model, o);
    var core = rankCore(model, scope, m, kind, rankLimit(o.limit), false);
    return {
      kind: kind,
      month: m,
      bookId: scope.bookId || null,
      totalCents: core.totalCents,
      otherCents: core.otherCents,
      items: core.items
    };
  }

  /* 账户构成：AccountComposition；余额由流水聚合，不读任何余额缓存 */
  function accountComposition(source, second, third) {
    var model;
    var o = {};
    if (Array.isArray(source)) {
      if (Array.isArray(second)) {
        model = emptyModel();
        model.transactions = second;
        model.accounts = source;
        o = isObj(third) ? third : {};
      } else if (looksLikeAccounts(source)) {
        model = emptyModel();
        model.accounts = source;
        o = isObj(second) ? second : {};
      } else {
        model = emptyModel();
        model.transactions = source;
        o = isObj(second) ? second : {};
      }
    } else {
      model = resolve(source);
      o = isObj(second) ? second : {};
    }
    return compositionOf(model, o);
  }

  /* 判断数组是不是账户实体（任务书 accountComposition(accounts, txs) 调用约定） */
  function looksLikeAccounts(list) {
    if (!Array.isArray(list) || list.length === 0) { return true; }
    var first = list[0];
    if (!isObj(first)) { return false; }
    if (typeof first.amountCents === 'number' || typeof first.bookId === 'string' && typeof first.date === 'string') {
      return false;
    }
    return typeof first.openingBalanceCents === 'number' || typeof first.limitCents === 'number';
  }

  function compositionOf(model, opts) {
    var o = isObj(opts) ? opts : {};
    var includeArchived = o.includeArchived === false ? false : true;
    var map = balanceMap(model, '');
    var rows = [];
    var assetsCents = 0;
    var liabilitiesCents = 0;
    var totalAbsCents = 0;
    var netCents = 0;

    for (var i = 0; i < model.accounts.length; i++) {
      var account = model.accounts[i];
      if (!account || typeof account.id !== 'string' || !account.id) { continue; }
      var archived = account.archived === true;
      if (archived && !includeArchived) { continue; }
      var balance = typeof map[account.id] === 'number' ? map[account.id] : intOf(account.openingBalanceCents);
      var absCents = Math.abs(balance);
      rows.push({
        accountId: account.id,
        name: account.name ? String(account.name) : '',
        type: account.type ? String(account.type) : '',
        balanceCents: balance,
        absCents: absCents,
        pct: 0,
        color: account.color ? String(account.color) : (ACCOUNT_COLOR[account.type] || '#8E8E93'),
        archived: archived,
        sort: intOf(account.sort),
        createdAt: account.createdAt ? String(account.createdAt) : ''
      });
      if (balance > 0) { assetsCents += balance; }
      if (balance < 0) { liabilitiesCents += balance; }
      totalAbsCents += absCents;
      netCents += balance;
    }

    rows.sort(function (a, b) {
      if (b.absCents !== a.absCents) { return b.absCents - a.absCents; }
      if (a.sort !== b.sort) { return a.sort - b.sort; }
      var byName = a.name.localeCompare(b.name, 'zh-Hans-CN');
      if (byName !== 0) { return byName; }
      return a.createdAt < b.createdAt ? -1 : (a.createdAt > b.createdAt ? 1 : 0);
    });

    var items = [];
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      items.push({
        accountId: row.accountId,
        name: row.name,
        type: row.type,
        balanceCents: row.balanceCents,
        absCents: row.absCents,
        pct: pctOf(row.absCents, totalAbsCents),
        color: row.color,
        archived: row.archived
      });
    }

    return {
      items: items,
      assetsCents: assetsCents,
      liabilitiesCents: liabilitiesCents,
      netCents: netCents,
      totalAbsCents: totalAbsCents
    };
  }

  /* 日历热力图：HeatmapResult；覆盖整月每天（含 0 值） */
  function calendarHeatmap(source, month, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    if (isObj(month) && opts === undefined) {
      o = month;
      month = o.month;
    }
    var m = normalizeMonth(month) || normalizeMonth(o.month) || currentMonth();
    var r = monthRangeOf(m);
    var D = datesApi();
    var scope = bookScope(model, o);

    var days = [];
    var index = Object.create(null);
    var cursor = r.start;
    while (cursor && cursor <= r.end) {
      index[cursor] = days.length;
      days.push({ date: cursor, expenseCents: 0, incomeCents: 0, netCents: 0, count: 0 });
      cursor = D.addDays(cursor, 1);
    }

    walk(model, scope, function (tx, type, amount, date) {
      if (date < r.start || date > r.end) { return; }
      var slot = index[date];
      if (slot === undefined) { return; }
      if (type === TYPE_INCOME) {
        days[slot].incomeCents += amount;
        days[slot].count += 1;
      } else if (type === TYPE_EXPENSE) {
        days[slot].expenseCents += amount;
        days[slot].count += 1;
      }
    });

    var maxExpenseCents = 0;
    var maxIncomeCents = 0;
    for (var i = 0; i < days.length; i++) {
      days[i].netCents = days[i].incomeCents - days[i].expenseCents;
      if (days[i].expenseCents > maxExpenseCents) { maxExpenseCents = days[i].expenseCents; }
      if (days[i].incomeCents > maxIncomeCents) { maxIncomeCents = days[i].incomeCents; }
    }

    return {
      month: m,
      start: r.start,
      end: r.end,
      bookId: scope.bookId || null,
      days: days,
      maxExpenseCents: maxExpenseCents,
      maxIncomeCents: maxIncomeCents
    };
  }

  /* 时段分布：TimeDistribution；只统计支出，无 time 归 noon */
  function timeDistribution(source, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    var D = datesApi();
    var to = normalizeDay(o.to) || D.todayStr();
    var from = normalizeDay(o.from) || D.addDays(to, -29) || to;
    if (from > to) {
      var swap = from;
      from = to;
      to = swap;
    }
    var scope = bookScope(model, o);
    var buckets = [];
    for (var i = 0; i < TIME_BUCKETS.length; i++) {
      buckets.push({ key: TIME_BUCKETS[i].key, label: TIME_BUCKETS[i].label, amountCents: 0, count: 0 });
    }
    var total = 0;
    walk(model, scope, function (tx, type, amount, date) {
      if (type !== TYPE_EXPENSE) { return; }
      if (date < from || date > to) { return; }
      var slot = TIME_BUCKET_INDEX[timeBucketKey(tx.time)];
      buckets[slot].amountCents += amount;
      buckets[slot].count += 1;
      total += amount;
    });
    return {
      from: from,
      to: to,
      bookId: scope.bookId || null,
      totalCents: total,
      buckets: buckets
    };
  }

  function timeBucketKey(timeStr) {
    var D = datesApi();
    if (!D.isValidTimeStr(timeStr)) { return 'noon'; }
    var hour = Number(timeStr.slice(0, 2));
    if (hour >= 5 && hour <= 10) { return 'morning'; }
    if (hour >= 11 && hour <= 13) { return 'noon'; }
    if (hour >= 14 && hour <= 17) { return 'afternoon'; }
    if (hour >= 18 && hour <= 22) { return 'evening'; }
    return 'night';
  }

  /* 预算进度：BudgetProgress；spentCents 是该账本当月全部支出（含未设分类预算的部分） */
  function budgetProgress(source, month, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    if (isObj(month) && opts === undefined) {
      o = month;
      month = o.month;
    }
    var m = normalizeMonth(month) || normalizeMonth(o.month) || currentMonth();
    var scope = bookScope(model, o);
    var bookId = scope.mode === 'one' ? scope.bookId : (currentBookId(model) || '');
    var r = monthRangeOf(m);

    var totalCents = 0;
    for (var b = 0; b < model.budgets.length; b++) {
      var budget = model.budgets[b];
      if (!budget || budget.bookId !== bookId || budget.month !== m) { continue; }
      totalCents += intOf(budget.totalCents);
    }

    var spentCents = totalRange(model, { mode: 'one', bookId: bookId }, r.start, r.end).expenseCents;

    var byCategory = Object.create(null);
    walk(model, { mode: 'one', bookId: bookId }, function (tx, type, amount, date) {
      if (type !== TYPE_EXPENSE) { return; }
      if (date < r.start || date > r.end) { return; }
      var categoryId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
      byCategory[categoryId] = (byCategory[categoryId] || 0) + amount;
    });

    var categoryIndex = indexById(model.categories);
    var items = [];
    for (var c = 0; c < model.categoryBudgets.length; c++) {
      var cb = model.categoryBudgets[c];
      if (!cb || cb.bookId !== bookId || cb.month !== m) { continue; }
      var limitCents = intOf(cb.amountCents);
      var categoryId = typeof cb.categoryId === 'string' ? cb.categoryId : '';
      var spent = byCategory[categoryId] || 0;
      var threshold = intOf(cb.thresholdPct);
      if (threshold < 50 || threshold > 100) { threshold = WARN_PCT; }
      var rate = limitCents > 0 ? round1(spent / limitCents * 100) : 0;
      var category = categoryIndex[categoryId];
      items.push({
        categoryId: categoryId,
        name: category && category.name ? String(category.name) : '未分类',
        limitCents: limitCents,
        spentCents: spent,
        pct: rate,
        state: budgetState(limitCents, rate, threshold),
        /* 仅为排序使用的内部字段，输出前删除 */
        __sort: limitCents
      });
    }
    items.sort(function (a, b) {
      if (b.__sort !== a.__sort) { return b.__sort - a.__sort; }
      return a.categoryId < b.categoryId ? -1 : (a.categoryId > b.categoryId ? 1 : 0);
    });
    for (var d = 0; d < items.length; d++) { delete items[d].__sort; }

    var pct = totalCents > 0 ? round1(spentCents / totalCents * 100) : 0;
    var state = totalCents === 0 ? 'none' : (pct < WARN_PCT ? 'safe' : (pct <= 100 ? 'warn' : 'over'));
    return {
      bookId: bookId,
      month: m,
      totalCents: totalCents,
      spentCents: spentCents,
      remainingCents: totalCents - spentCents,
      pct: pct,
      state: state,
      items: items
    };
  }

  /* 预算三态：safe / warn / over（阈值上限闭区间归 warn，>100 才 over） */
  function budgetState(limitCents, rate, threshold) {
    if (!(limitCents > 0)) { return 'safe'; }
    if (rate > 100) { return 'over'; }
    if (rate >= (threshold || WARN_PCT)) { return 'warn'; }
    return 'safe';
  }

  /* 目标进度：GoalProgress；只吃 GoalDeposit，不联动账户余额（DECISIONS D09） */
  function goalProgress(source, second) {
    var goal = null;
    var goalId = '';
    var deposits = [];
    if (isObj(source) && typeof source.targetCents === 'number') {
      goal = source;
      goalId = typeof source.id === 'string' ? source.id : '';
      deposits = Array.isArray(second) ? second : [];
    } else {
      var model = resolve(source);
      goalId = typeof second === 'string' ? second : '';
      goal = findById(model.goals, goalId);
      deposits = model.goalDeposits;
    }

    var targetCents = goal ? intOf(goal.targetCents) : 0;
    var savedCents = 0;
    var depositCount = 0;
    var lastDepositDate = null;
    for (var i = 0; i < deposits.length; i++) {
      var deposit = deposits[i];
      if (!deposit || deposit.deleted === true) { continue; }
      if (goalId && typeof deposit.goalId === 'string' && deposit.goalId !== goalId) { continue; }
      var amount = intOf(deposit.amountCents);
      if (amount <= 0) { continue; }
      savedCents += amount;
      depositCount += 1;
      var date = isDateStr(deposit.date) ? deposit.date : '';
      if (date && (!lastDepositDate || date > lastDepositDate)) { lastDepositDate = date; }
    }

    var pct = targetCents === 0 ? 0 : round1(savedCents / targetCents * 100);
    var state = 'active';
    if (goal) {
      if (savedCents > targetCents) {
        state = 'over';
      } else if (savedCents === targetCents) {
        state = 'done';
      }
    }
    return {
      goalId: goalId,
      targetCents: targetCents,
      savedCents: savedCents,
      remainingCents: Math.max(0, targetCents - savedCents),
      pct: pct,
      depositCount: depositCount,
      lastDepositDate: lastDepositDate,
      state: state
    };
  }

  /* 账本概览：BookOverview；balanceCents 是该账本本月净流入，不是账户余额 */
  function bookOverview(source, bookId, month) {
    var model = resolve(source);
    var o = isObj(bookId) ? bookId : null;
    if (o) {
      month = o.month;
      bookId = o.bookId;
    }
    var bId = typeof bookId === 'string' ? bookId : '';
    var m = normalizeMonth(month) || currentMonth();
    var r = monthRangeOf(m);
    var totals = totalRange(model, { mode: 'one', bookId: bId }, r.start, r.end);
    var budgets = budgetProgress(model, { month: m, bookId: bId });
    return {
      bookId: bId,
      month: m,
      balanceCents: totals.netCents,
      incomeCents: totals.incomeCents,
      expenseCents: totals.expenseCents,
      netCents: totals.netCents,
      budgetPct: budgets.totalCents === 0 ? null : budgets.pct,
      budgetState: budgets.state
    };
  }

  /* ============================== 任务书 T07 数组形态 ============================== */

  /* 区间解析：opts.month 优先；否则 opts.from/opts.to；都没有 → 本月 */
  function rangeFromOptions(o) {
    var m = normalizeMonth(o.month);
    if (m) {
      var r = monthRangeOf(m);
      return { month: m, from: r.start, to: r.end };
    }
    var from = normalizeDay(o.from);
    var to = normalizeDay(o.to);
    if (!from && !to) {
      var current = currentMonth();
      var range = monthRangeOf(current);
      return { month: current, from: range.start, to: range.end };
    }
    return {
      month: '',
      from: from || '0000-01-01',
      to: to || '9999-12-31'
    };
  }

  /* 本期收支与结余：summary(txs, {month}) 或 summary(txs, {from,to}) */
  function summary(source, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    var range = rangeFromOptions(o);
    var scope = bookScope(model, o);
    var totals = totalRange(model, scope, range.from, range.to);
    return {
      month: range.month,
      from: range.from,
      to: range.to,
      bookId: scope.bookId || null,
      incomeCents: totals.incomeCents,
      expenseCents: totals.expenseCents,
      netCents: totals.netCents,
      count: totals.count,
      transferCents: totals.transferCents,
      transferCount: totals.transferCount
    };
  }

  /* 环比与同比：返回百分比（除零 null）与绝对差 */
  function compare(source, range) {
    var model = resolve(source);
    var o = isObj(range) ? range : {};
    var rangeCurrent = rangeFromOptions(o);
    var scope = bookScope(model, o);

    var current = totalRange(model, scope, rangeCurrent.from, rangeCurrent.to);
    var prevRange = chainRange(rangeCurrent, -1);
    var yearRange = chainRange(rangeCurrent, -12);
    var prev = prevRange ? totalRange(model, scope, prevRange.from, prevRange.to) : null;
    var year = yearRange ? totalRange(model, scope, yearRange.from, yearRange.to) : null;

    return {
      month: rangeCurrent.month,
      from: rangeCurrent.from,
      to: rangeCurrent.to,
      bookId: scope.bookId || null,
      current: {
        incomeCents: current.incomeCents,
        expenseCents: current.expenseCents,
        netCents: current.netCents,
        count: current.count
      },
      prev: prev ? {
        from: prevRange.from,
        to: prevRange.to,
        income: deltaOf(current.incomeCents, prev.incomeCents),
        expense: deltaOf(current.expenseCents, prev.expenseCents),
        net: deltaOf(current.netCents, prev.netCents)
      } : null,
      yoy: year ? {
        from: yearRange.from,
        to: yearRange.to,
        income: deltaOf(current.incomeCents, year.incomeCents),
        expense: deltaOf(current.expenseCents, year.expenseCents),
        net: deltaOf(current.netCents, year.netCents)
      } : null
    };
  }

  /* 环比区间的「上一期」：月粒度 → 上一月；自定义区间 → 紧邻的等长窗口 */
  function chainRange(range, months) {
    var D = datesApi();
    if (range.month) {
      var key = D.monthKey(D.addMonths(range.month + '-01', months));
      if (!key) { return null; }
      var r = monthRangeOf(key);
      return { month: key, from: r.start, to: r.end };
    }
    if (months === -1) {
      var length = D.daysBetween(range.from, range.to);
      if (!isNum(length) || length < 0) { return null; }
      var end = D.addDays(range.from, -1);
      if (!end) { return null; }
      var begin = D.addDays(end, -length) || end;
      return { month: '', from: begin, to: end };
    }
    var from = D.addMonths(range.from, months);
    var to = D.addMonths(range.to, months);
    if (!from || !to) { return null; }
    return { month: '', from: from, to: to };
  }

  /* 分类排行（含占比与环比）：rankByCategory(txs, {type, limit, month}) */
  function rankByCategory(source, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    var m = normalizeMonth(o.month) || currentMonth();
    var kind = (o.type === TYPE_INCOME || o.kind === TYPE_INCOME) ? TYPE_INCOME : TYPE_EXPENSE;
    var scope = bookScope(model, o);
    var core = rankCore(model, scope, m, kind, rankLimit(o.limit), true);
    return {
      kind: kind,
      month: m,
      bookId: scope.bookId || null,
      totalCents: core.totalCents,
      otherCents: core.otherCents,
      items: core.items
    };
  }

  /* 从 budget 数组里拆出 Budget 与 CategoryBudget（任务书三参调用约定） */
  function splitBudgets(list) {
    var budgets = [];
    var categoryBudgets = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!isObj(item)) { continue; }
      if (typeof item.categoryId === 'string' && isNum(item.amountCents)) {
        categoryBudgets.push(item);
      } else if (isNum(item.totalCents)) {
        budgets.push(item);
      }
    }
    return { budgets: budgets, categoryBudgets: categoryBudgets };
  }

  /* 预算使用率与超支预警：budgetUsage(budgets, txs, monthKey)
   * 输出每项 {id, limit, spent, rate, status}，status 三态 ok|warn|over（warn 阈值 80%）。 */
  function budgetUsage(budgetSource, txSource, monthArg) {
    var model;
    var month = '';
    var txList;
    if (Array.isArray(budgetSource)) {
      var split = splitBudgets(budgetSource);
      txList = Array.isArray(txSource) ? txSource : [];
      month = normalizeMonth(monthArg) || (typeof txSource === 'string' ? normalizeMonth(txSource) : '');
      model = emptyModel();
      model.transactions = txList;
      model.budgets = split.budgets;
      model.categoryBudgets = split.categoryBudgets;
    } else {
      model = resolve(budgetSource);
      if (typeof txSource === 'string') {
        txList = model.transactions;
        month = normalizeMonth(txSource);
      } else if (Array.isArray(txSource)) {
        txList = txSource;
        model.transactions = txSource;
      } else {
        txList = model.transactions;
      }
      if (!month) { month = normalizeMonth(monthArg); }
    }
    month = month || currentMonth();

    var bookId = '';
    if (model.budgets.length > 0 && typeof model.budgets[0].bookId === 'string') {
      bookId = model.budgets[0].bookId;
    } else if (model.categoryBudgets.length > 0 && typeof model.categoryBudgets[0].bookId === 'string') {
      bookId = model.categoryBudgets[0].bookId;
    } else {
      bookId = currentBookId(model) || '';
    }

    var r = monthRangeOf(month);
    var spentByCategory = Object.create(null);
    var spentTotal = 0;
    for (var i = 0; i < txList.length; i++) {
      var tx = txList[i];
      if (!tx || tx.deleted === true || typeOf(tx) !== TYPE_EXPENSE) { continue; }
      var date = dateOf(tx);
      if (!date || !isDateStr(date) || date < r.start || date > r.end) { continue; }
      if (bookId && typeof tx.bookId === 'string' && tx.bookId !== bookId) { continue; }
      var amount = intOf(tx.amountCents);
      if (amount <= 0) { continue; }
      var categoryId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
      spentByCategory[categoryId] = (spentByCategory[categoryId] || 0) + amount;
      spentTotal += amount;
    }

    var totalLimit = 0;
    var totalId = '';
    for (var b = 0; b < model.budgets.length; b++) {
      var budget = model.budgets[b];
      if (!budget || budget.month !== month) { continue; }
      totalLimit += intOf(budget.totalCents);
      if (!totalId) { totalId = typeof budget.id === 'string' ? budget.id : ''; }
    }

    var categoryIndex = indexById(model.categories);
    var items = [];
    for (var c = 0; c < model.categoryBudgets.length; c++) {
      var cb = model.categoryBudgets[c];
      if (!cb || cb.month !== month) { continue; }
      var limit = intOf(cb.amountCents);
      var categoryIdValue = typeof cb.categoryId === 'string' ? cb.categoryId : '';
      var spent = spentByCategory[categoryIdValue] || 0;
      var threshold = intOf(cb.thresholdPct);
      if (threshold < 50 || threshold > 100) { threshold = WARN_PCT; }
      var rate = limit > 0 ? round1(spent / limit * 100) : 0;
      var category = categoryIndex[categoryIdValue];
      items.push({
        id: typeof cb.id === 'string' ? cb.id : '',
        categoryId: categoryIdValue,
        name: category && category.name ? String(category.name) : categoryIdValue,
        limit: limit,
        spent: spent,
        rate: rate,
        status: usageStatus(limit, rate, threshold),
        overCents: spent > limit ? spent - limit : 0
      });
    }
    items.sort(function (a, b) {
      if (b.rate !== a.rate) { return b.rate - a.rate; }
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    var total = {
      id: totalId,
      limit: totalLimit,
      spent: spentTotal,
      rate: totalLimit > 0 ? round1(spentTotal / totalLimit * 100) : 0,
      status: usageStatus(totalLimit, totalLimit > 0 ? round1(spentTotal / totalLimit * 100) : 0, WARN_PCT),
      overCents: totalLimit > 0 && spentTotal > totalLimit ? spentTotal - totalLimit : 0
    };

    var alerts = [];
    if (total.limit > 0 && total.status !== 'ok') {
      alerts.push({ scope: 'total', id: total.id, name: '总预算', rate: total.rate, status: total.status, overCents: total.overCents });
    }
    for (var k = 0; k < items.length; k++) {
      if (items[k].status !== 'ok') {
        alerts.push({ scope: 'category', id: items[k].id, name: items[k].name, rate: items[k].rate, status: items[k].status, overCents: items[k].overCents });
      }
    }

    return {
      month: month,
      bookId: bookId || null,
      total: total,
      items: items,
      alerts: alerts
    };
  }

  /* 预算三态（任务书口径）：<80% ok、80%–100% warn、>100% over */
  function usageStatus(limit, rate, threshold) {
    if (!(limit > 0)) { return 'ok'; }
    if (rate > 100) { return 'over'; }
    if (rate >= (threshold || WARN_PCT)) { return 'warn'; }
    return 'ok';
  }

  /* 热力图别名：heatmapData(txs, monthKey) */
  function heatmapData(source, month, opts) {
    return calendarHeatmap(source, month, opts);
  }

  /* 备注排行（可选）：topNotes(txs, {limit, type, month}) */
  function topNotes(source, opts) {
    var model = resolve(source);
    var o = isObj(opts) ? opts : {};
    var scope = bookScope(model, o);
    var range = rangeFromOptions(o);
    var kind = o.type === TYPE_INCOME ? TYPE_INCOME : (o.type === TYPE_EXPENSE ? TYPE_EXPENSE : '');
    var map = Object.create(null);
    var rows = [];
    walk(model, scope, function (tx, type, amount, date) {
      if (type === TYPE_TRANSFER) { return; }
      if (kind && type !== kind) { return; }
      if (date < range.from || date > range.to) { return; }
      var note = typeof tx.note === 'string' ? tx.note.trim() : '';
      if (!note) { return; }
      if (!map[note]) {
        map[note] = { note: note, count: 0, amountCents: 0 };
        rows.push(map[note]);
      }
      map[note].count += 1;
      map[note].amountCents += amount;
    });
    rows.sort(function (a, b) {
      if (b.amountCents !== a.amountCents) { return b.amountCents - a.amountCents; }
      if (b.count !== a.count) { return b.count - a.count; }
      return a.note.localeCompare(b.note, 'zh-Hans-CN');
    });
    var limit = clampInt(o.limit, NOTE_LIMIT_DEFAULT, 1, NOTE_LIMIT_MAX);
    return {
      month: range.month,
      from: range.from,
      to: range.to,
      bookId: scope.bookId || null,
      items: rows.slice(0, limit)
    };
  }

  /* ============================== 导出 ============================== */

  var api = Object.freeze({
    /* CONTRACT §6.4 冻结签名 */
    monthSummary: monthSummary,
    yearSummary: yearSummary,
    trend: trend,
    mom: mom,
    categoryRank: categoryRank,
    accountComposition: accountComposition,
    calendarHeatmap: calendarHeatmap,
    timeDistribution: timeDistribution,
    budgetProgress: budgetProgress,
    goalProgress: goalProgress,
    bookOverview: bookOverview,

    /* CONTRACT §6.2 余额唯一实现 */
    accountBalanceCents: accountBalanceCents,
    accountBalanceAt: accountBalanceAt,
    accountBalances: accountBalances,
    netWorthCents: netWorthCents,
    bookMonthTotals: bookMonthTotals,

    /* CONTRACT §9 B8 */
    creditAvailable: creditAvailable,

    /* 任务书 T07 数组形态 API */
    summary: summary,
    compare: compare,
    rankByCategory: rankByCategory,
    budgetUsage: budgetUsage,
    heatmapData: heatmapData,
    topNotes: topNotes,

    /* 只读常量，便于界面统一阈值文案 */
    RANK_LIMIT_DEFAULT: RANK_LIMIT_DEFAULT,
    RANK_LIMIT_MAX: RANK_LIMIT_MAX,
    WARN_PCT: WARN_PCT,
    TREND_POINTS_MAX: TREND_POINTS_MAX
  });

  Core.stats = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.stats = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
