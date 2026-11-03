/* 小账本 2.0 · js/screens/insights.js
 * 账单解读（2.16.0）：把「看数据」升级为「理解数据」。
 * 结构：账期筛选 → 核心结论 → 收支摘要 → 消费结构（环图）→ 收支变化（六个月柱图）
 *       → 值得留意（本地规则）→ 行动建议。
 * 契约：XZB.screens.register('insights', { title, subtitle, render, destroy })
 * 依赖：XZB.core.{dates,money,stats}、XZB.ui.{icons,kit,charts,sheet}、XZB.app
 * 硬规则：不碰 IndexedDB / localStorage；只读 ctx.db；金额一律整数分；
 *         统计口径与统计屏一致（deleted / 账本 / 类型 / 金额 / 日期 五道过滤）；
 *         规则集中在本文件 RULES 常量里，结论只陈述事实，不做道德评判。
 */
(function (global) {
  'use strict';

  var XZB = (global.XZB = global.XZB || {});
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] insights 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var Core = XZB.core || XZB.Core || {};
  var dates = Core.dates || null;
  var money = Core.money || null;
  var kit = XZB.ui && XZB.ui.kit ? XZB.ui.kit : null;
  var charts = XZB.ui && XZB.ui.charts ? XZB.ui.charts : null;
  var icons = XZB.ui && XZB.ui.icons ? XZB.ui.icons : null;
  var domApi = XZB.ui && XZB.ui.dom ? XZB.ui.dom : null;

  /* ---------------- 可配置规则 ----------------
   * 全部是产品启发式阈值，集中放这里，不散落在结论函数里；
   * 金额单位一律「分」，时间为自然月。
   */
  var RULES = {
    HISTORY_MONTHS: 3,        /* 「近三个月均值」需要的历史月数 */
    ANOMALY_RATIO: 1.5,       /* 分类异常：当前值 / 历史均值 */
    ANOMALY_MIN_CENTS: 10000, /* 分类异常：月均差额下限 ¥100 */
    GROWTH_MONTHS: 3,         /* 连续增长：连续账期数 */
    GROWTH_MIN_CENTS: 5000,   /* 连续增长：累计差额下限 ¥50 */
    FREQUENT_MIN_COUNT: 5,    /* 高频小额：笔数下限 */
    FREQUENT_MEDIAN_CENTS: 5000, /* 高频小额：单笔中位数上限 ¥50 */
    FREQUENT_TOTAL_CENTS: 20000, /* 高频小额：累计金额下限 ¥200 */
    LARGE_COUNT: 3,           /* 大额支出清单条数 */
    CORE_MAX: 3,              /* 核心结论最多三行 */
    TIP_MAX: 3,               /* 值得留意最多三条 */
    ACTION_MAX: 3,            /* 行动建议最多三条 */
    BAR_MONTHS: 6,            /* 柱图自然月数 */
    COLLECT_MONTHS: 12,       /* 一次遍历的月份窗口（含历史与柱图） */
    DONUT_TOP: 5,             /* 环图前五类，其余合并「其他」 */
    LEGEND_TOP: 8,            /* 清单最多列出前八类，其余再合并「其他」 */
    LIST_LIMIT: 50,           /* 分类明细 Sheet 最多列出笔数 */
    SKELETON_DELAY_MS: 150    /* 超过这个时间才让骨架屏可见（CSS 控制） */
  };

  var RANGES = [
    { key: 'month', label: '本月', months: 1 },
    { key: 'prev', label: '上月', months: 1 },
    { key: '3m', label: '近3个月', months: 3 },
    { key: '6m', label: '近6个月', months: 6 }
  ];

  var RANGE_BY_KEY = (function () {
    var map = {};
    for (var i = 0; i < RANGES.length; i += 1) { map[RANGES[i].key] = RANGES[i]; }
    return map;
  }());

  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var S = {
    root: null,
    ctx: null,
    contentEl: null,
    periodEl: null,
    resetEl: null,
    month: '',
    range: 'month',
    seq: 0,
    timer: 0,
    timers: [],
    dead: false,
    lastSig: null,
    suppressRestore: false,
    sheetRestore: null
  };

  /* ---------------- 基础工具 ---------------- */

  function el(tag, attrs, kids) {
    if (domApi && typeof domApi.el === 'function') { return domApi.el(tag, attrs, kids); }
    var node = document.createElement(String(tag || 'div'));
    var options = attrs && typeof attrs === 'object' ? attrs : {};
    if (options.className) { node.className = String(options.className); }
    if (options.text !== undefined && options.text !== null) { node.textContent = String(options.text); }
    Object.keys(options).forEach(function (key) {
      if (key === 'className' || key === 'text' || key === 'children') { return; }
      if (key === 'dataset') {
        Object.keys(options.dataset).forEach(function (name) {
          node.setAttribute('data-' + name, String(options.dataset[name]));
        });
        return;
      }
      var value = options[key];
      if (value === undefined || value === null || value === false) { return; }
      node.setAttribute(key, value === true ? '' : String(value));
    });
    append(node, kids !== undefined && kids !== null ? kids : options.children);
    return node;
  }

  function append(node, kids) {
    if (kids === undefined || kids === null || kids === false) { return node; }
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i += 1) { append(node, kids[i]); }
      return node;
    }
    if (kids && typeof kids.nodeType === 'number') {
      node.appendChild(kids);
      return node;
    }
    node.appendChild(document.createTextNode(String(kids)));
    return node;
  }

  function clearNode(node) {
    if (!node) { return; }
    if (domApi && typeof domApi.clear === 'function') { domApi.clear(node); return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  /* 屏幕内所有延时回调统一登记，destroy 时一次清空：离开页面后不再画报告、不再重开 Sheet。 */
  function later(fn, ms) {
    var id = global.setTimeout(function () {
      var at = S.timers.indexOf(id);
      if (at >= 0) { S.timers.splice(at, 1); }
      if (!S.dead) { fn(); }
    }, ms);
    S.timers.push(id);
    return id;
  }

  function clearLater() {
    for (var i = 0; i < S.timers.length; i += 1) { global.clearTimeout(S.timers[i]); }
    S.timers.length = 0;
  }

  function iconNode(name, size) {
    var key = String(name || 'box');
    if (icons && typeof icons.node === 'function') {
      try {
        var node = icons.node(key, { size: Number(size) || 18 });
        if (node) { return node; }
      } catch (error) { /* 图标缺失时用文字占位 */ }
    }
    return el('span', { className: 's-insights-glyph', text: key.slice(0, 1) });
  }

  function sheetApi() {
    return XZB.ui && XZB.ui.sheet ? XZB.ui.sheet : null;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function todayStr() {
    if (dates && typeof dates.todayStr === 'function') {
      try { return String(dates.todayStr()); } catch (error) { /* 回落 */ }
    }
    var now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function currentMonth() {
    return todayStr().slice(0, 7);
  }

  function isMonth(value) {
    return typeof value === 'string' && MONTH_RE.test(value);
  }

  function addMonth(key, delta) {
    if (!isMonth(key)) { return ''; }
    var year = Number(key.slice(0, 4));
    var month = Number(key.slice(5, 7)) - 1 + Number(delta || 0);
    var d = new Date(year, month, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function monthRange(endMonth, count) {
    var list = [];
    var n = Math.max(1, Number(count) || 1);
    for (var i = n - 1; i >= 0; i -= 1) { list.push(addMonth(endMonth, -i)); }
    return list;
  }

  function monthLabel(key) {
    if (!isMonth(key)) { return String(key || ''); }
    return key.slice(0, 4) + '年' + Number(key.slice(5, 7)) + '月';
  }

  function shortMonth(key) {
    return isMonth(key) ? String(Number(key.slice(5, 7))) + '月' : String(key || '');
  }

  function barMonthLabel(key) {
    return isMonth(key) ? key.slice(2, 4) + '/' + String(Number(key.slice(5, 7))) : String(key || '');
  }

  function dateLabel(dateStr) {
    if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) { return String(dateStr || ''); }
    var nowYear = todayStr().slice(0, 4);
    var prefix = dateStr.slice(0, 4) === nowYear ? '' : dateStr.slice(0, 4) + '年';
    return prefix + Number(dateStr.slice(5, 7)) + '月' + Number(dateStr.slice(8, 10)) + '日';
  }

  function fmt(cents, options) {
    if (money && typeof money.formatCents === 'function') {
      try { return String(money.formatCents(cents, options || {})); } catch (error) { /* 回落 */ }
    }
    return '\u00a5' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
  }

  function fmtCompact(cents) {
    if (money && typeof money.formatCompact === 'function') {
      try { return String(money.formatCompact(cents)); } catch (error) { /* 回落 */ }
    }
    return fmt(cents);
  }

  function round1(value) {
    return Math.round(Number(value) * 10) / 10;
  }

  function pctOf(part, total) {
    return total > 0 ? round1(part / total * 100) : 0;
  }

  function deltaOf(current, base) {
    if (!(base > 0)) { return null; }
    return round1((current - base) / base * 100);
  }

  function signedMoney(diff) {
    if (diff === 0) { return fmt(0); }
    return (diff > 0 ? '+' : '\u2212') + fmt(Math.abs(diff));
  }

  function signedPct(value) {
    if (value === 0) { return '0.0%'; }
    return (value > 0 ? '+' : '\u2212') + Math.abs(value).toFixed(1) + '%';
  }

  function intCents(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value) : 0;
  }

  function safeDate(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) { return ''; }
    if (dates && typeof dates.isValidDateStr === 'function') {
      try { return dates.isValidDateStr(value) ? value : ''; } catch (error) { return ''; }
    }
    return value;
  }

  /* ---------------- 数据读取与作用域（与 core/stats.walk 同口径） ---------------- */

  function readDb(ctx) {
    if (ctx && ctx.db) { return ctx.db; }
    var app = XZB.app;
    if (app && typeof app.db === 'function') { return app.db() || {}; }
    return {};
  }

  function scopeOf(db) {
    var books = db && Array.isArray(db.books) ? db.books : [];
    var archived = {};
    var active = '';
    if (db && typeof db.activeBookId === 'string') { active = db.activeBookId; }
    var state = XZB.app && XZB.app.state;
    /* 当前账本唯一权威在 state.ui.activeBookId（与首页/统计一致）；旧形态兼容 state.activeBookId */
    if (!active && state && state.ui && typeof state.ui.activeBookId === 'string') { active = state.ui.activeBookId; }
    if (!active && state && typeof state.activeBookId === 'string') { active = state.activeBookId; }
    if (!active) {
      for (var i = 0; i < books.length; i += 1) {
        if (books[i] && books[i].archived !== true) { active = String(books[i].id || ''); break; }
      }
    }
    for (var j = 0; j < books.length; j += 1) {
      var book = books[j];
      if (book && typeof book.id === 'string') { archived[book.id] = book.archived === true; }
    }
    return { bookId: active, archived: archived, hasBooks: books.length > 0 };
  }

  /* 一次遍历完成：合计、分类、柱图、异常计数、下钻流水，全在 COLLECT_MONTHS 窗口内。 */
  function collect(db, endMonth) {
    var months = monthRange(endMonth, RULES.COLLECT_MONTHS);
    var model = {
      endMonth: endMonth,
      months: months,
      byMonth: {},
      items: [],
      anomalies: 0,
      scope: scopeOf(db)
    };
    var index = {};
    for (var i = 0; i < months.length; i += 1) {
      index[months[i]] = { month: months[i], incomeCents: 0, expenseCents: 0, count: 0, transferCents: 0, transferCount: 0, cats: {} };
      model.byMonth[months[i]] = index[months[i]];
    }
    var list = db && Array.isArray(db.transactions) ? db.transactions : null;
    if (!list) { return null; }
    var scope = model.scope;
    for (var t = 0; t < list.length; t += 1) {
      var tx = list[t];
      if (!tx || tx.deleted === true) { continue; }
      var bookId = typeof tx.bookId === 'string' ? tx.bookId : '';
      if (scope.bookId) {
        if (bookId !== scope.bookId) { continue; }
      } else if (scope.hasBooks && scope.archived[bookId] === true) {
        continue;
      }
      var type = tx.type;
      if (type !== 'income' && type !== 'expense' && type !== 'transfer') { model.anomalies += 1; continue; }
      var amount = intCents(tx.amountCents);
      if (!(amount > 0)) { model.anomalies += 1; continue; }
      var date = safeDate(tx.date);
      if (!date) { model.anomalies += 1; continue; }
      var month = date.slice(0, 7);
      var bucket = index[month];
      if (!bucket) { continue; }
      if (type === 'transfer') {
        bucket.transferCents += amount;
        bucket.transferCount += 1;
        continue;
      }
      /* 与统计页 totalRange 同口径：总笔数只计收入/支出，转账单独计数 */
      bucket.count += 1;
      if (type === 'income') {
        bucket.incomeCents += amount;
        continue;
      }
      bucket.expenseCents += amount;
      var categoryId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
      var cat = bucket.cats[categoryId];
      if (!cat) { cat = bucket.cats[categoryId] = { categoryId: categoryId, amountCents: 0, count: 0 }; }
      cat.amountCents += amount;
      cat.count += 1;
      model.items.push({
        tx: tx,
        date: date,
        month: month,
        categoryId: categoryId,
        categoryName: typeof tx.categoryName === 'string' ? tx.categoryName : '',
        accountId: typeof tx.accountId === 'string' ? tx.accountId : '',
        note: typeof tx.note === 'string' ? tx.note : '',
        amountCents: amount
      });
    }
    return model;
  }

  function categoryMeta(db) {
    var map = {};
    var list = db && Array.isArray(db.categories) ? db.categories : [];
    for (var i = 0; i < list.length; i += 1) {
      var c = list[i];
      if (c && typeof c.id === 'string') {
        map[c.id] = {
          id: c.id,
          name: typeof c.name === 'string' && c.name ? c.name : '分类',
          icon: typeof c.icon === 'string' && c.icon ? c.icon : 'box',
          color: typeof c.color === 'string' ? c.color : ''
        };
      }
    }
    return map;
  }

  function accountMeta(db) {
    var map = {};
    var list = db && Array.isArray(db.accounts) ? db.accounts : [];
    for (var i = 0; i < list.length; i += 1) {
      var a = list[i];
      if (a && typeof a.id === 'string') { map[a.id] = typeof a.name === 'string' ? a.name : '账户'; }
    }
    return map;
  }

  function toneVar(categoryId, meta) {
    var category = meta[categoryId] || categoryId;
    if (kit && typeof kit.categoryTone === 'function') {
      try { return '--cat-' + kit.categoryTone(category); } catch (error) { /* 回落 */ }
    }
    return '--cat-12';
  }

  function summarize(model, endMonth, count, meta) {
    var months = monthRange(endMonth, count);
    var inSet = {};
    var totals = { incomeCents: 0, expenseCents: 0, transferCents: 0, count: 0 };
    for (var i = 0; i < months.length; i += 1) {
      inSet[months[i]] = true;
      var bucket = model.byMonth[months[i]];
      if (!bucket) { continue; }
      totals.incomeCents += bucket.incomeCents;
      totals.expenseCents += bucket.expenseCents;
      totals.transferCents += bucket.transferCents;
      totals.count += bucket.count;
    }
    var cats = {};
    var items = [];
    for (var k = 0; k < model.items.length; k += 1) {
      var item = model.items[k];
      if (!inSet[item.month]) { continue; }
      items.push(item);
      var cat = cats[item.categoryId];
      if (!cat) {
        var metaRow = meta[item.categoryId];
        cat = cats[item.categoryId] = {
          id: item.categoryId,
          name: metaRow ? metaRow.name : (item.categoryName || '未分类'),
          icon: metaRow ? metaRow.icon : 'box',
          amountCents: 0,
          count: 0
        };
      }
      cat.amountCents += item.amountCents;
      cat.count += 1;
    }
    var catList = [];
    Object.keys(cats).forEach(function (id) {
      var row = cats[id];
      row.pct = pctOf(row.amountCents, totals.expenseCents);
      row.colorVar = toneVar(id, meta);
      catList.push(row);
    });
    catList.sort(function (a, b) { return b.amountCents - a.amountCents || a.name.localeCompare(b.name); });
    var netCents = totals.incomeCents - totals.expenseCents;
    return {
      months: months,
      totals: totals,
      netCents: netCents,
      cats: catList,
      items: items
    };
  }

  function hasAnyRecord(db) {
    var list = db && Array.isArray(db.transactions) ? db.transactions : [];
    var scope = scopeOf(db);
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      var bookId = typeof tx.bookId === 'string' ? tx.bookId : '';
      if (scope.bookId) {
        if (bookId !== scope.bookId) { continue; }
      } else if (scope.hasBooks && scope.archived[bookId] === true) {
        continue;
      }
      /* 与 collect 同口径：只有能进统计的记录才算「有账可看」，避免只剩脏数据时误判 */
      if (tx.type !== 'income' && tx.type !== 'expense' && tx.type !== 'transfer') { continue; }
      if (!(intCents(tx.amountCents) > 0)) { continue; }
      if (!safeDate(tx.date)) { continue; }
      return true;
    }
    return false;
  }

  /* ---------------- 报告装配 ---------------- */

  function buildReport(ctx) {
    var db = readDb(ctx);
    if (!db || !Array.isArray(db.transactions)) { return { failed: true, db: db }; }
    var range = RANGE_BY_KEY[S.range] || RANGES[0];
    var meta = categoryMeta(db);
    var model = collect(db, S.month);
    if (!model) { return { failed: true, db: db }; }
    /* S.month 就是本次报告账期的锚点（上月 chip 已把锚点定为上月），这里不再叠加偏移 */
    var anchor = S.month;
    var win = summarize(model, anchor, range.months, meta);
    var prev = summarize(model, addMonth(win.months[0], -1), range.months, meta);
    var bars = [];
    var barMonths = monthRange(win.months[win.months.length - 1], RULES.BAR_MONTHS);
    for (var i = 0; i < barMonths.length; i += 1) {
      var bucket = model.byMonth[barMonths[i]];
      bars.push({
        month: barMonths[i],
        incomeCents: bucket ? bucket.incomeCents : 0,
        expenseCents: bucket ? bucket.expenseCents : 0,
        count: bucket ? bucket.count : 0
      });
    }
    var report = {
      db: db,
      meta: meta,
      accounts: accountMeta(db),
      model: model,
      win: win,
      prev: prev,
      bars: bars,
      range: range,
      endMonth: win.months[win.months.length - 1],
      hasAny: hasAnyRecord(db)
    };
    report.core = buildCore(report);
    report.tips = buildTips(report);
    report.actions = buildActions(report);
    return report;
  }

  function expenseDelta(report) {
    var current = report.win.totals.expenseCents;
    var prev = report.prev.totals.expenseCents;
    if (prev > 0) { return { pct: deltaOf(current, prev), diff: current - prev, hasPrev: true }; }
    if (report.prev.totals.count > 0 && current > 0) {
      return { pct: null, diff: current, hasPrev: true, isNew: true };
    }
    return { pct: null, diff: 0, hasPrev: false };
  }

  function topMover(report) {
    if (!(report.prev.totals.expenseCents > 0)) { return null; }
    var prevBy = {};
    for (var i = 0; i < report.prev.cats.length; i += 1) { prevBy[report.prev.cats[i].id] = report.prev.cats[i].amountCents; }
    var best = null;
    for (var j = 0; j < report.win.cats.length; j += 1) {
      var cat = report.win.cats[j];
      var diff = cat.amountCents - (prevBy[cat.id] || 0);
      if (!best || diff > best.diff) { best = { cat: cat, diff: diff }; }
    }
    return best && best.diff > 0 ? best : null;
  }

  function buildCore(report) {
    var lines = [];
    var win = report.win;
    var expense = win.totals.expenseCents;
    if (!(expense > 0)) { return lines; }
    var first = report.range.months === 1
      ? monthLabel(report.endMonth) + '支出 ' + fmt(expense)
      : '近' + report.range.months + '个月支出 ' + fmt(expense);
    var delta = expenseDelta(report);
    if (delta.hasPrev && delta.pct !== null) {
      first += '\uff0c较上期' + (delta.diff >= 0 ? '多花 ' : '少花 ') + fmt(Math.abs(delta.diff)) +
        '\uff08' + signedPct(delta.pct) + '\uff09';
    } else if (delta.isNew) {
      first += '\uff0c上期没有支出';
    }
    lines.push({ icon: 'wallet', text: first });

    var top = win.cats[0];
    if (top) {
      lines.push({
        icon: top.icon || 'pie',
        text: top.name + '最多\uff0c占 ' + top.pct.toFixed(1) + '%\uff08' + fmt(top.amountCents) + '\uff09',
        categoryId: top.id
      });
    }

    var mover = topMover(report);
    if (mover && mover.diff >= 1000 && lines.length < RULES.CORE_MAX) {
      lines.push({
        icon: 'arrow-up',
        text: mover.cat.name + '较上期多支出 ' + fmt(mover.diff),
        categoryId: mover.cat.id
      });
    }
    return lines;
  }

  function historyAverage(report, months, categoryId) {
    var sum = 0;
    for (var i = 0; i < months.length; i += 1) {
      var bucket = report.model.byMonth[months[i]];
      /* 月份桶缺失 = 超出一次遍历窗口，不能当作 0；桶在但分类缺记录才是 0 支出 */
      if (!bucket) { return null; }
      var cat = bucket.cats[categoryId];
      sum += cat ? cat.amountCents : 0;
    }
    return sum / months.length;
  }

  function monthsHaveData(report, months) {
    for (var i = 0; i < months.length; i += 1) {
      var bucket = report.model.byMonth[months[i]];
      if (!bucket || bucket.count <= 0) { return false; }
    }
    return true;
  }

  function medianOf(values) {
    if (!values.length) { return 0; }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function buildTips(report) {
    var candidates = [];
    var win = report.win;
    var n = report.range.months;
    var firstMonth = win.months[0];
    var history = monthRange(addMonth(firstMonth, -1), RULES.HISTORY_MONTHS);

    if (report.model.anomalies > 0) {
      candidates.push({
        weight: 0,
        key: 'quality',
        icon: 'warning',
        title: '数据质量',
        text: '有 ' + report.model.anomalies + ' 条记录格式异常\uff0c已跳过统计\uff0c原始账单未改动。',
        tone: 'warn'
      });
    }

    if (monthsHaveData(report, history) && win.totals.expenseCents > 0) {
      var currentAvg = win.totals.expenseCents / n;
      var bestAnomaly = null;
      for (var i = 0; i < win.cats.length; i += 1) {
        var cat = win.cats[i];
        var avg = historyAverage(report, history, cat.id);
        if (!(avg > 0)) { continue; }
        var current = cat.amountCents / n;
        if (current < avg * RULES.ANOMALY_RATIO) { continue; }
        var diff = current - avg;
        if (diff < RULES.ANOMALY_MIN_CENTS) { continue; }
        var ratio = current / avg;
        if (!bestAnomaly || diff > bestAnomaly.diff) {
          bestAnomaly = { cat: cat, diff: diff, ratio: ratio, current: current, avg: avg };
        }
      }
      if (bestAnomaly) {
        candidates.push({
          weight: 1,
          key: 'anomaly:' + bestAnomaly.cat.id,
          icon: bestAnomaly.cat.icon || 'warning',
          title: bestAnomaly.cat.name + '明显高于以往',
          text: (n === 1 ? (report.range.key === 'month' ? '本月' : monthLabel(report.endMonth)) : '本阶段月均') + ' ' + fmt(bestAnomaly.current) +
            '\uff0c是前 ' + RULES.HISTORY_MONTHS + ' 个月均值（' + fmt(bestAnomaly.avg) + '\uff09的 ' +
            bestAnomaly.ratio.toFixed(1) + ' 倍\uff0c多 ' + fmt(bestAnomaly.diff) + '。',
          tone: 'warn',
          categoryId: bestAnomaly.cat.id
        });
      }
    }

    if (win.totals.expenseCents > 0) {
      var growthMonths = monthRange(report.endMonth, RULES.GROWTH_MONTHS);
      var growthBest = null;
      for (var g = 0; g < win.cats.length; g += 1) {
        var gcat = win.cats[g];
        var v = [];
        var ok = true;
        for (var m = 0; m < growthMonths.length; m += 1) {
          var b = report.model.byMonth[growthMonths[m]];
          var c = b ? b.cats[gcat.id] : null;
          var value = c ? c.amountCents : 0;
          if (!(value > 0)) { ok = false; break; }
          v.push(value);
        }
        if (!ok) { continue; }
        var rising = true;
        for (var q = 1; q < v.length; q += 1) { if (!(v[q] > v[q - 1])) { rising = false; break; } }
        if (!rising) { continue; }
        var growthDiff = v[v.length - 1] - v[0];
        if (growthDiff < RULES.GROWTH_MIN_CENTS) { continue; }
        if (!growthBest || growthDiff > growthBest.diff) {
          growthBest = { cat: gcat, diff: growthDiff };
        }
      }
      if (growthBest) {
        candidates.push({
          weight: 2,
          key: 'growth:' + growthBest.cat.id,
          icon: 'arrow-up',
          title: growthBest.cat.name + '连续 ' + RULES.GROWTH_MONTHS + ' 个月增长',
          text: '累计多花 ' + fmt(growthBest.diff) + '\uff0c可以点开看看具体是哪几笔。',
          tone: 'warn',
          categoryId: growthBest.cat.id
        });
      }
    }

    if (win.totals.expenseCents > 0) {
      var mover = topMover(report);
      if (mover && mover.diff >= 1000) {
        candidates.push({
          weight: 3,
          key: 'struct:' + mover.cat.id,
          icon: mover.cat.icon || 'chart-line',
          title: '结构变化',
          text: mover.cat.name + '较上期多 ' + fmt(mover.diff) + '\uff0c是本期变化最大的一类。',
          categoryId: mover.cat.id
        });
      }
    }

    if (win.totals.expenseCents > 0) {
      var frequent = null;
      for (var f = 0; f < win.cats.length; f += 1) {
        var fcat = win.cats[f];
        if (fcat.count < RULES.FREQUENT_MIN_COUNT) { continue; }
        if (fcat.amountCents < RULES.FREQUENT_TOTAL_CENTS) { continue; }
        var amounts = [];
        for (var it = 0; it < win.items.length; it += 1) {
          if (win.items[it].categoryId === fcat.id) { amounts.push(win.items[it].amountCents); }
        }
        var median = medianOf(amounts);
        if (median > RULES.FREQUENT_MEDIAN_CENTS) { continue; }
        if (!frequent || fcat.amountCents > frequent.cat.amountCents) {
          frequent = { cat: fcat, median: median };
        }
      }
      if (frequent) {
        candidates.push({
          weight: 4,
          key: 'frequent:' + frequent.cat.id,
          icon: frequent.cat.icon || 'list',
          title: frequent.cat.name + '笔数偏多',
          text: frequent.cat.count + ' 笔小额支出合计 ' + fmt(frequent.cat.amountCents) +
            '\uff0c单笔中位数 ' + fmt(frequent.median) + '。',
          categoryId: frequent.cat.id
        });
      }
    }

    var large = win.items.slice().sort(function (a, b) {
      return b.amountCents - a.amountCents;
    }).slice(0, RULES.LARGE_COUNT);
    if (large.length) {
      var lines = [];
      for (var l = 0; l < large.length; l += 1) {
        lines.push(dateLabel(large[l].date) + ' ' + noteOf(report, large[l]) + ' ' + fmt(large[l].amountCents));
      }
      candidates.push({
        weight: 5,
        key: 'large',
        icon: 'wallet',
        title: '本期最大三笔',
        text: '按金额从高到低：',
        items: lines,
        action: {
          label: '逐笔查看',
          onClick: function () { openLargeSheet(report); }
        }
      });
    }

    if (monthsHaveData(report, history) && win.totals.expenseCents > 0) {
      var histSum = 0;
      for (var h = 0; h < history.length; h += 1) {
        var hb = report.model.byMonth[history[h]];
        if (hb) { histSum += hb.expenseCents; }
      }
      var histAvg = histSum / history.length;
      var curAvg = win.totals.expenseCents / n;
      if (histAvg > 0 && curAvg > histAvg * 1.2 && curAvg - histAvg >= RULES.ANOMALY_MIN_CENTS) {
        candidates.push({
          weight: 6,
          key: 'trend',
          icon: 'chart-line',
          title: '整体支出走高',
          text: (n === 1 ? (report.range.key === 'month' ? '本月' : monthLabel(report.endMonth)) : '本阶段月均') + '比前 ' + RULES.HISTORY_MONTHS + ' 个月均值高 ' +
            signedPct(deltaOf(curAvg, histAvg)) + '\uff0c多 ' + fmt(curAvg - histAvg) + '。'
        });
      }
    }

    candidates.sort(function (a, b) { return a.weight - b.weight; });
    var picked = [];
    var usedCat = {};
    for (var p = 0; p < candidates.length && picked.length < RULES.TIP_MAX; p += 1) {
      var row = candidates[p];
      if (row.categoryId && usedCat[row.categoryId]) { continue; }
      if (row.categoryId) { usedCat[row.categoryId] = true; }
      picked.push(row);
    }
    return picked;
  }

  function buildActions(report) {
    var actions = [];
    var top = report.win.cats[0];
    if (top) {
      actions.push({
        icon: 'list',
        label: '查看「' + top.name + '」的 ' + top.count + ' 笔明细',
        onClick: (function (categoryId) {
          return function () { openCategoryById(report, categoryId); };
        }(top.id))
      });
    }
    if (report.prev.totals.count > 0) {
      actions.push({
        icon: 'chart-line',
        label: '对比上一个月',
        onClick: function () { setRange('prev'); }
      });
    }
    actions.push({
      icon: 'wallet',
      label: '返回首页调整预算',
      href: '#/home?focus=budget'
    });
    return actions.slice(0, RULES.ACTION_MAX);
  }

  function noteOf(report, item) {
    if (item.note) { return item.note.length > 18 ? item.note.slice(0, 18) + '\u2026' : item.note; }
    var meta = report.meta[item.categoryId];
    if (meta && meta.name) { return meta.name; }
    return item.categoryName || '支出';
  }

  function accountNameOf(report, accountId) {
    return report.accounts[accountId] || '—';
  }

  function categoryOf(report, categoryId) {
    for (var i = 0; i < report.win.cats.length; i += 1) {
      if (report.win.cats[i].id === categoryId) { return report.win.cats[i]; }
    }
    var meta = report.meta[categoryId];
    return meta ? { id: meta.id, name: meta.name, icon: meta.icon, amountCents: 0, count: 0 } : null;
  }

  /* ---------------- 画面骨架 ---------------- */

  function periodText(report) {
    var range = (report && report.range) || RANGE_BY_KEY[S.range] || RANGES[0];
    if (!report) {
      return monthLabel(S.month) + ' \u00b7 ' + range.label;
    }
    if (range.key === 'month' || range.key === 'prev') {
      return monthLabel(report.endMonth) + ' \u00b7 ' + range.label;
    }
    var start = report.win.months[0];
    return monthLabel(start) + ' 至 ' + monthLabel(report.endMonth) + ' \u00b7 ' + range.label;
  }

  function buildShell() {
    clearNode(S.root);
    var wrap = el('div', { className: 's-insights' });
    var head = el('div', { className: 's-insights-head' });
    var top = el('div', { className: 's-insights-head__top' });
    S.periodEl = el('p', { className: 's-insights-period', text: periodText(null) });
    top.appendChild(S.periodEl);
    S.resetEl = el('button', {
      className: 's-insights-reset',
      type: 'button',
      text: '回到本月',
      'aria-label': '回到本月报告'
    });
    S.resetEl.addEventListener('click', function () {
      var now = currentMonth();
      if (S.month === now && S.range === 'month') { return; }
      S.month = now;
      S.range = 'month';
      syncHash();
      updatePeriod(null);
      repaint(true);
      scrollToTop();
    });
    top.appendChild(S.resetEl);
    head.appendChild(top);

    var seg = el('div', {
      className: 'c-segmented s-insights-range',
      role: 'tablist',
      'aria-label': '账期范围'
    });
    RANGES.forEach(function (range) {
      var button = el('button', {
        className: 'c-segmented__item' + (range.key === S.range ? ' is-active' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': range.key === S.range ? 'true' : 'false',
        text: range.label,
        dataset: { range: range.key }
      });
      button.addEventListener('click', function () { setRange(range.key); });
      seg.appendChild(button);
    });
    seg.addEventListener('keydown', function (event) {
      var key = event.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight') { return; }
      event.preventDefault();
      var current = 0;
      for (var i = 0; i < RANGES.length; i += 1) { if (RANGES[i].key === S.range) { current = i; } }
      var next = key === 'ArrowRight' ? (current + 1) % RANGES.length : (current + RANGES.length - 1) % RANGES.length;
      setRange(RANGES[next].key);
      var buttons = seg.querySelectorAll('.c-segmented__item');
      if (buttons[next]) { buttons[next].focus(); }
    });
    head.appendChild(seg);
    wrap.appendChild(head);

    S.contentEl = el('div', { className: 's-insights-content' });
    wrap.appendChild(S.contentEl);
    S.root.appendChild(wrap);
    updatePeriod(null);
  }

  function updatePeriod(report) {
    if (S.periodEl) { S.periodEl.textContent = periodText(report); }
    if (S.resetEl) {
      var atDefault = S.month === currentMonth() && S.range === 'month';
      S.resetEl.hidden = atDefault;
    }
    var seg = S.root ? S.root.querySelector('.s-insights-range') : null;
    if (seg) {
      var items = seg.querySelectorAll('.c-segmented__item');
      for (var i = 0; i < items.length; i += 1) {
        var active = items[i].getAttribute('data-range') === S.range;
        items[i].classList.toggle('is-active', active);
        items[i].setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
  }

  function scrollToTop() {
    try {
      var scroller = S.root && S.root.closest ? S.root.closest('.app-screen__body') : null;
      if (scroller) { scroller.scrollTop = 0; }
      if (global.scrollY > 0) { global.scrollTo(0, 0); }
    } catch (error) { /* 滚动恢复失败不影响内容 */ }
  }

  function skeleton() {
    var box = el('div', { className: 's-insights-skel', 'aria-hidden': 'true' });
    for (var i = 0; i < 4; i += 1) {
      box.appendChild(el('div', { className: 's-insights-skel__card s-insights-skel__card--' + i }));
    }
    return box;
  }

  function moduleCard(title, sub, className) {
    var card = el('section', { className: 'c-card s-insights-mod' + (className ? ' ' + className : '') });
    var head = el('div', { className: 'c-card__head s-insights-mod__head' });
    var titles = el('div', { className: 's-insights-mod__titles' });
    titles.appendChild(el('h2', { className: 'c-card__title s-insights-mod__title', text: title }));
    if (sub) { titles.appendChild(el('p', { className: 's-insights-mod__sub', text: sub })); }
    head.appendChild(titles);
    card.appendChild(head);
    return card;
  }

  function buttonNode(label, options) {
    var o = options || {};
    var node = el(o.href ? 'a' : 'button', {
      className: 's-insights-btn' + (o.className ? ' ' + o.className : ''),
      type: o.href ? null : 'button',
      href: o.href || null,
      text: label,
      'aria-label': o.ariaLabel || null
    });
    if (o.icon) { node.insertBefore(iconNode(o.icon, 16), node.firstChild); }
    if (typeof o.onClick === 'function' && !o.href) {
      node.addEventListener('click', function (event) { event.preventDefault(); o.onClick(event); });
    }
    return node;
  }

  /* ---------------- 结构画布 ---------------- */

  function structureCard(report) {
    var card = moduleCard('消费结构', null, 's-insights-structure');
    var expense = report.win.totals.expenseCents;
    if (!(expense > 0)) {
      card.appendChild(el('p', { className: 's-insights-muted', text: '本期没有支出记录，暂时没有可拆分的结构。' }));
      return card;
    }
    var folded = foldCats(report, report.win.cats);
    var topShare = 0;
    for (var i = 0; i < Math.min(folded.length, RULES.DONUT_TOP); i += 1) { topShare += folded[i].amountCents; }
    card.querySelector('.s-insights-mod__head').appendChild(el('span', {
      className: 's-insights-mod__tag u-tabular',
      text: '前五类 ' + pctOf(topShare, expense).toFixed(1) + '%'
    }));

    var body = el('div', { className: 's-insights-structure__body' });
    var chartBox = el('div', { className: 's-insights-donut' });
    var chartHost = el('div', { className: 's-insights-donut__chart' });
    chartBox.appendChild(chartHost);
    body.appendChild(chartBox);

    var legendRows = foldCats(report, report.win.cats, RULES.LEGEND_TOP);
    var legend = el('div', { className: 's-insights-legend', role: 'group', 'aria-label': '支出分类图例' });
    for (var j = 0; j < legendRows.length; j += 1) {
      (function (row, index) {
        var item = el('button', {
          className: 's-insights-legend__row',
          type: 'button',
          'aria-label': row.name + '，' + fmt(row.amountCents) + '，占 ' + row.pct.toFixed(1) + '%',
          'data-cat': row.id
        });
        var dot = el('span', { className: 's-insights-legend__dot', 'aria-hidden': 'true' });
        dot.style.background = 'var(' + row.colorVar + ')';
        item.appendChild(dot);
        var main = el('span', { className: 's-insights-legend__main' });
        main.appendChild(el('span', { className: 's-insights-legend__name', text: row.name }));
        main.appendChild(el('span', { className: 's-insights-legend__meta u-tabular', text: fmt(row.amountCents) + ' \u00b7 ' + row.pct.toFixed(1) + '%' }));
        item.appendChild(main);
        item.appendChild(el('span', { className: 's-insights-legend__count', text: String(row.count) + ' 笔' }));
        item.addEventListener('click', function () {
          var all = legend.querySelectorAll('.s-insights-legend__row');
          for (var q = 0; q < all.length; q += 1) { all[q].classList.toggle('is-selected', all[q] === item); }
          openFoldedSheet(report, row);
        });
        legend.appendChild(item);
      }(legendRows[j], j));
    }
    body.appendChild(legend);
    card.appendChild(body);

    var summary = el('p', { className: 's-insights-note' });
    if (folded.length >= 2) {
      summary.textContent = folded[0].name + '与' + folded[1].name + '合计占支出的 ' +
        pctOf(folded[0].amountCents + folded[1].amountCents, expense).toFixed(1) + '%\uff0c是本期支出的主体。';
    } else {
      summary.textContent = '支出集中在' + folded[0].name + '\uff0c占 ' + folded[0].pct.toFixed(1) + '%。';
    }
    card.appendChild(summary);

    try {
      if (!charts || typeof charts.donut !== 'function') { throw new Error('charts unavailable'); }
      charts.donut(chartHost, folded.map(function (row) {
        return { label: row.name, amountCents: row.amountCents, color: row.colorVar };
      }), {
        height: 196,
        thickness: 22,
        centerSub: '总支出',
        ariaLabel: '支出分类构成，共 ' + folded.length + ' 类'
      });
      chartBox.addEventListener('click', function (event) {
        var index = donutHit(chartBox, folded, event);
        if (index < 0) { return; }
        var row = folded[index];
        var buttons = legend.querySelectorAll('.s-insights-legend__row');
        for (var q = 0; q < buttons.length; q += 1) { buttons[q].classList.toggle('is-selected', buttons[q].getAttribute('data-cat') === row.id); }
        openFoldedSheet(report, row);
      });
    } catch (error) {
      clearNode(chartHost);
      chartHost.appendChild(chartFail('消费结构', folded.map(function (row) {
        return row.name + ' ' + fmt(row.amountCents) + '（' + row.pct.toFixed(1) + '%）';
      }), function () { repaint(false); }));
    }
    return card;
  }

  function foldCats(report, cats, limit) {
    var rows = [];
    var total = report.win.totals.expenseCents;
    var top = limit || RULES.DONUT_TOP;
    for (var i = 0; i < cats.length && i < top; i += 1) {
      var cat = cats[i];
      rows.push({
        id: cat.id,
        name: cat.name,
        icon: cat.icon,
        amountCents: cat.amountCents,
        count: cat.count,
        pct: cat.pct,
        colorVar: cat.colorVar,
        folded: false
      });
    }
    if (cats.length > top) {
      var rest = { id: '__other', name: '其他', icon: 'box', amountCents: 0, count: 0, pct: 0, colorVar: '--c-text-3', folded: true, children: [] };
      for (var j = top; j < cats.length; j += 1) {
        rest.amountCents += cats[j].amountCents;
        rest.count += cats[j].count;
        rest.children.push(cats[j]);
      }
      rest.pct = pctOf(rest.amountCents, total);
      rows.push(rest);
    }
    return rows;
  }

  function donutHit(box, rows, event) {
    var svg = box.querySelector('svg');
    if (!svg) { return -1; }
    var rect = svg.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) { return -1; }
    var view = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
    var vw = view && view.width ? view.width : rect.width;
    var vh = view && view.height ? view.height : rect.height;
    var scale = rect.width / vw;
    var x = (event.clientX - rect.left) / scale - vw / 2;
    var y = (event.clientY - rect.top) / scale - vh / 2;
    var radius = Math.sqrt(x * x + y * y);
    var outer = Math.min(vw, vh) / 2 - 2;
    var thickness = 22;
    var inner = Math.max(0, outer - thickness - 2);
    if (radius < inner || radius > outer + 4) { return -1; }
    var angle = Math.atan2(y, x) + Math.PI / 2;
    if (angle < 0) { angle += Math.PI * 2; }
    var sum = 0;
    for (var i = 0; i < rows.length; i += 1) { sum += rows[i].amountCents; }
    if (!(sum > 0)) { return -1; }
    var cursor = 0;
    for (var j = 0; j < rows.length; j += 1) {
      var fraction = rows[j].amountCents / sum;
      var start = cursor * Math.PI * 2;
      var end = (cursor + fraction) * Math.PI * 2;
      if (angle >= start && angle < end) { return j; }
      cursor += fraction;
    }
    return -1;
  }

  function chartFail(title, lines, retry) {
    var box = el('div', { className: 's-insights-chartfail' });
    box.appendChild(el('p', { className: 's-insights-chartfail__title', text: title + '图暂时没有画出来' }));
    var list = el('ul', { className: 's-insights-chartfail__list' });
    for (var i = 0; i < lines.length; i += 1) {
      list.appendChild(el('li', { text: lines[i] }));
    }
    box.appendChild(list);
    box.appendChild(buttonNode('重试', { icon: 'refresh', onClick: retry }));
    return box;
  }

  function barsCard(report) {
    var card = moduleCard('收支变化', '最近 6 个自然月 \u00b7 点柱子切换报告', 's-insights-bars');
    var hasIncome = false;
    for (var i = 0; i < report.bars.length; i += 1) {
      if (report.bars[i].incomeCents > 0) { hasIncome = true; }
    }
    var chartBox = el('div', { className: 's-insights-bars__chart' });
    var tip = el('div', { className: 'c-chart-tip s-insights-bars__tip', 'aria-hidden': 'true' });
    chartBox.appendChild(tip);
    try {
      chartBox.appendChild(buildBarSvg(report, hasIncome, tip, chartBox));
    } catch (error) {
      clearNode(chartBox);
      chartBox.appendChild(chartFail('收支变化', report.bars.map(function (row) {
        return monthLabel(row.month) + ' 收入 ' + fmt(row.incomeCents) + ' / 支出 ' + fmt(row.expenseCents);
      }), function () { repaint(false); }));
    }
    card.appendChild(chartBox);

    var list = el('div', { className: 's-insights-bars__list' });
    for (var j = 0; j < report.bars.length; j += 1) {
      (function (row) {
        var current = row.month === report.endMonth;
        var item = el('button', {
          className: 's-insights-bars__row' + (current ? ' is-current' : ''),
          type: 'button',
          'aria-pressed': current ? 'true' : 'false',
          'aria-label': monthLabel(row.month) + '，收入 ' + fmt(row.incomeCents) + '，支出 ' + fmt(row.expenseCents) + '，切换报告'
        });
        item.appendChild(el('span', { className: 's-insights-bars__month', text: barMonthLabel(row.month) }));
        var vals = el('span', { className: 's-insights-bars__vals u-tabular' });
        if (hasIncome) {
          vals.appendChild(el('span', { className: 's-insights-bars__val s-insights-bars__val--income', text: '+' + fmtCompact(row.incomeCents) }));
        }
        vals.appendChild(el('span', { className: 's-insights-bars__val s-insights-bars__val--expense', text: '\u2212' + fmtCompact(row.expenseCents) }));
        item.appendChild(vals);
        item.addEventListener('click', function () { setMonth(row.month); });
        list.appendChild(item);
      }(report.bars[j]));
    }
    card.appendChild(list);

    var legend = el('p', { className: 's-insights-bars__legend' });
    if (hasIncome) {
      legend.appendChild(el('span', { className: 's-insights-bars__dot s-insights-bars__dot--income', 'aria-hidden': 'true' }));
      legend.appendChild(el('span', { text: '收入 ' }));
      legend.appendChild(el('span', { className: 's-insights-bars__dot s-insights-bars__dot--expense', 'aria-hidden': 'true' }));
      legend.appendChild(el('span', { text: '支出' }));
    } else {
      legend.appendChild(el('span', { className: 's-insights-bars__dot s-insights-bars__dot--expense', 'aria-hidden': 'true' }));
      legend.appendChild(el('span', { text: '支出（本期没有收入记录）' }));
    }
    card.appendChild(legend);
    return card;
  }

  function buildBarSvg(report, hasIncome, tip, chartBox) {
    var W = 360;
    var H = 200;
    var PL = 42;
    var PR = 10;
    var PT = 16;
    var PB = 26;
    var plotW = W - PL - PR;
    var plotH = H - PT - PB;
    var series = report.bars;
    var max = 0;
    for (var i = 0; i < series.length; i += 1) {
      if (series[i].incomeCents > max) { max = series[i].incomeCents; }
      if (series[i].expenseCents > max) { max = series[i].expenseCents; }
    }
    var scale = niceMax(max);
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '最近六个月收支柱图，可点月份切换报告');
    svg.setAttribute('class', 's-insights-bars__svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    var slots = plotW / series.length;
    var barW = hasIncome ? 9 : 14;
    var gap = 3;

    function yOf(value) {
      return PT + plotH - (value / scale) * plotH;
    }

    for (var g = 0; g <= 2; g += 1) {
      var value = scale * g / 2;
      var y = yOf(value);
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(PL));
      line.setAttribute('x2', String(W - PR));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      line.setAttribute('class', 's-insights-bars__grid');
      svg.appendChild(line);
      var label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(PL - 6));
      label.setAttribute('y', String(y + 3));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('class', 's-insights-bars__axis');
      label.textContent = axisLabel(value);
      svg.appendChild(label);
    }

    for (var s = 0; s < series.length; s += 1) {
      (function (row, index) {
        var x0 = PL + index * slots;
        var cx = x0 + slots / 2;
        var current = row.month === report.endMonth;
        if (current) {
          var sel = document.createElementNS(SVG_NS, 'rect');
          sel.setAttribute('x', String(x0 + 3));
          sel.setAttribute('y', String(PT - 4));
          sel.setAttribute('width', String(slots - 6));
          sel.setAttribute('height', String(plotH + 10));
          sel.setAttribute('rx', '8');
          sel.setAttribute('class', 's-insights-bars__sel');
          svg.appendChild(sel);
        }
        if (hasIncome) {
          svg.appendChild(barNode(cx - barW / 2 - gap / 2 - 0.5, row.incomeCents, scale, yOf, barW, plotH, 'income'));
          svg.appendChild(barNode(cx + gap / 2 + 0.5 - barW / 2, row.expenseCents, scale, yOf, barW, plotH, 'expense'));
        } else {
          svg.appendChild(barNode(cx - barW / 2, row.expenseCents, scale, yOf, barW, plotH, 'expense'));
        }
        var labelText = document.createElementNS(SVG_NS, 'text');
        labelText.setAttribute('x', String(cx));
        labelText.setAttribute('y', String(H - 8));
        labelText.setAttribute('text-anchor', 'middle');
        labelText.setAttribute('class', 's-insights-bars__monthlabel' + (current ? ' is-current' : ''));
        labelText.textContent = shortMonth(row.month);
        svg.appendChild(labelText);

        var hit = document.createElementNS(SVG_NS, 'g');
        hit.setAttribute('class', 's-insights-bars__hit');
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('role', 'button');
        hit.setAttribute('aria-label', monthLabel(row.month) + '，收入 ' + fmt(row.incomeCents) + '，支出 ' + fmt(row.expenseCents) + '，切换报告');
        var rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x0));
        rect.setAttribute('y', String(PT));
        rect.setAttribute('width', String(slots));
        rect.setAttribute('height', String(plotH + PB));
        rect.setAttribute('fill', 'transparent');
        hit.appendChild(rect);
        var text = monthLabel(row.month);
        function show() { showBarTip(tip, chartBox, cx, W, text + '\uff1a收入 ' + fmt(row.incomeCents) + '\uff0c支出 ' + fmt(row.expenseCents)); }
        hit.addEventListener('click', function () { setMonth(row.month); });
        hit.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setMonth(row.month);
          }
        });
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('pointerleave', hideBarTip(tip));
        hit.addEventListener('focus', show);
        hit.addEventListener('blur', hideBarTip(tip));
        svg.appendChild(hit);
      }(series[s], s));
    }
    return svg;
  }

  function barNode(x, value, scale, yOf, width, plotH, tone) {
    var rect = document.createElementNS(SVG_NS, 'rect');
    var h = value > 0 ? Math.max(2, (value / scale) * plotH) : 0;
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(yOf(value)));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '3');
    rect.setAttribute('class', 's-insights-bars__bar s-insights-bars__bar--' + tone);
    return rect;
  }

  function showBarTip(tip, box, cx, width, label) {
    tip.textContent = label;
    var pct = Math.max(10, Math.min(90, cx / width * 100));
    tip.style.left = pct.toFixed(1) + '%';
    tip.classList.add('is-visible');
  }

  function hideBarTip(tip) {
    return function () { tip.classList.remove('is-visible'); };
  }

  function axisLabel(cents) {
    var yuan = cents / 100;
    if (yuan >= 10000) { return (Math.round(yuan / 1000) / 10) + '万'; }
    if (yuan >= 1000) { return (Math.round(yuan / 100) / 10) + 'k'; }
    return String(Math.round(yuan));
  }

  function niceMax(value) {
    if (!(value > 0)) { return 100; }
    var mag = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    var norm = value / mag;
    var step = norm <= 1 ? 1 : (norm <= 2 ? 2 : (norm <= 5 ? 5 : 10));
    return step * mag;
  }

  /* ---------------- 结论 / 提示 / 建议 ---------------- */

  function coreCard(report) {
    var card = el('section', { className: 'c-card s-insights-core' });
    if (!report.core.length) {
      card.appendChild(el('p', { className: 's-insights-muted', text: '本期暂无支出，先看看收支摘要吧。' }));
      return card;
    }
    var list = el('ul', { className: 's-insights-core__list' });
    for (var i = 0; i < report.core.length; i += 1) {
      (function (line) {
        var item = el('li', { className: 's-insights-core__item' });
        var chip = el('span', { className: 's-insights-core__icon', 'aria-hidden': 'true' });
        chip.appendChild(iconNode(line.icon || 'info', 18));
        item.appendChild(chip);
        item.appendChild(el('span', { className: 's-insights-core__text', text: line.text }));
        if (line.categoryId) {
          item.appendChild(buttonNode('明细', {
            className: 's-insights-core__more',
            ariaLabel: '查看该分类明细',
            onClick: function () { openCategoryById(report, line.categoryId); }
          }));
        }
        list.appendChild(item);
      }(report.core[i]));
    }
    card.appendChild(list);
    return card;
  }

  function summaryCard(report) {
    var card = moduleCard('收支摘要', null, 's-insights-summary');
    var delta = expenseDelta(report);
    var net = report.win.netCents;
    var hero = el('div', { className: 's-insights-sum__hero' });
    hero.appendChild(el('span', { className: 's-insights-sum__hero-label', text: '结余' }));
    hero.appendChild(el('strong', {
      className: 's-insights-sum__hero-value u-tabular' + (net < 0 ? ' is-neg' : ''),
      text: fmt(net)
    }));
    hero.appendChild(el('span', {
      className: 's-insights-sum__hero-sub',
      text: net < 0 ? '支出高于收入' : '收入减去支出'
    }));
    card.appendChild(hero);
    var grid = el('div', { className: 's-insights-sum__grid' });
    grid.appendChild(sumCell('收入', report.win.totals.incomeCents, 'income'));
    grid.appendChild(sumCell('支出', report.win.totals.expenseCents, 'expense'));
    var mom = el('div', { className: 's-insights-sum__cell' });
    mom.appendChild(el('span', { className: 's-insights-sum__label', text: report.range.months === 1 ? '支出环比' : '支出较上期' }));
    var momValue = el('span', { className: 's-insights-sum__value' });
    if (!delta.hasPrev) {
      momValue.appendChild(el('span', { className: 's-insights-muted', text: '暂无上期数据' }));
    } else if (delta.isNew) {
      momValue.appendChild(el('span', { className: 's-insights-sum__new', text: '新增支出' }));
    } else if (delta.pct === null) {
      momValue.appendChild(el('span', { className: 's-insights-muted', text: '—' }));
    } else {
      var chip = el('span', {
        className: 's-insights-sum__delta' + (delta.diff > 0 ? ' is-up' : (delta.diff < 0 ? ' is-down' : '')),
        text: signedPct(delta.pct)
      });
      momValue.appendChild(chip);
      momValue.appendChild(el('span', { className: 's-insights-sum__sub', text: (delta.diff > 0 ? '多 ' : '少 ') + fmt(Math.abs(delta.diff)) }));
    }
    mom.appendChild(momValue);
    grid.appendChild(mom);
    card.appendChild(grid);

    if (report.win.totals.incomeCents > 0) {
      var rate = round1((report.win.totals.incomeCents - report.win.totals.expenseCents) / report.win.totals.incomeCents * 100);
      var line = el('p', { className: 's-insights-sum__saving' });
      line.appendChild(el('span', { className: 's-insights-sum__label', text: '储蓄率' }));
      line.appendChild(el('strong', {
        className: 's-insights-sum__saving-value u-tabular' + (rate < 0 ? ' is-neg' : ''),
        text: (rate < 0 ? '\u2212' : '') + Math.abs(rate).toFixed(1) + '%'
      }));
      line.appendChild(el('span', { className: 's-insights-muted', text: rate < 0 ? '支出高于收入' : '结余占收入的比例' }));
      card.appendChild(line);
    }
    card.appendChild(el('p', {
      className: 's-insights-note',
      text: '笔数 ' + report.win.totals.count + ' 条\uff0c仅统计当前账本；转账不计入收支。'
    }));
    return card;
  }

  function sumCell(label, cents, tone) {
    var cell = el('div', { className: 's-insights-sum__cell' });
    cell.appendChild(el('span', { className: 's-insights-sum__label', text: label }));
    var value = el('span', { className: 's-insights-sum__value u-tabular' });
    var text = el('span', { className: 's-insights-sum__money' + (tone ? ' s-insights-sum__money--' + tone : ''), text: fmt(cents) });
    value.appendChild(text);
    cell.appendChild(value);
    return cell;
  }

  function tipsCard(report) {
    var card = moduleCard('值得留意', '按数据质量、异常、结构与趋势排序', 's-insights-tips');
    var list = el('ul', { className: 's-insights-tip__list' });
    for (var i = 0; i < report.tips.length; i += 1) {
      (function (tip) {
        var item = el('li', { className: 's-insights-tip' + (tip.tone === 'warn' ? ' is-warn' : '') });
        var chip = el('span', { className: 's-insights-tip__icon', 'aria-hidden': 'true' });
        chip.appendChild(iconNode(tip.icon || 'info', 18));
        item.appendChild(chip);
        var body = el('div', { className: 's-insights-tip__body' });
        body.appendChild(el('p', { className: 's-insights-tip__title', text: tip.title }));
        body.appendChild(el('p', { className: 's-insights-tip__text', text: tip.text }));
        if (tip.items && tip.items.length) {
          var sub = el('ul', { className: 's-insights-tip__facts' });
          for (var k = 0; k < tip.items.length; k += 1) {
            sub.appendChild(el('li', { text: tip.items[k] }));
          }
          body.appendChild(sub);
        }
        if (tip.action) {
          body.appendChild(buttonNode(tip.action.label, {
            className: 's-insights-tip__action',
            icon: 'arrow-up-right',
            onClick: tip.action.onClick
          }));
        }
        item.appendChild(body);
        list.appendChild(item);
      }(report.tips[i]));
    }
    card.appendChild(list);
    return card;
  }

  function actionsCard(report) {
    var card = moduleCard('行动建议', null, 's-insights-actions');
    var list = el('div', { className: 's-insights-actions__list' });
    for (var i = 0; i < report.actions.length; i += 1) {
      (function (action) {
        var node = el(action.href ? 'a' : 'button', {
          className: 's-insights-act',
          type: action.href ? null : 'button',
          href: action.href || null
        });
        var chip = el('span', { className: 's-insights-act__icon', 'aria-hidden': 'true' });
        chip.appendChild(iconNode(action.icon || 'sparkles', 18));
        node.appendChild(chip);
        node.appendChild(el('span', { className: 's-insights-act__label', text: action.label }));
        var arrow = el('span', { className: 's-insights-act__arrow', 'aria-hidden': 'true' });
        arrow.appendChild(iconNode('arrow-up-right', 14));
        node.appendChild(arrow);
        if (typeof action.onClick === 'function' && !action.href) {
          node.addEventListener('click', function () { action.onClick(); });
        }
        list.appendChild(node);
      }(report.actions[i]));
    }
    card.appendChild(list);
    return card;
  }

  function footNote(report) {
    var box = el('p', { className: 's-insights-foot' });
    box.textContent = '解读由本地规则根据当前账本生成，不联网、不修改原始账单；' +
      '统计范围为 ' + monthLabel(report.win.months[0]) + ' 至 ' + monthLabel(report.endMonth) + '。';
    return box;
  }

  /* ---------------- 空 / 错误状态 ---------------- */

  function emptyAll() {
    var card = el('div', { className: 'c-card s-insights-empty' });
    var empty = el('div', { className: 'c-empty' });
    var holder = el('span', { className: 'c-empty__icon' });
    holder.appendChild(iconNode('chart-line', 40));
    empty.appendChild(holder);
    empty.appendChild(el('p', { className: 'c-empty__title', text: '还没有账单' }));
    empty.appendChild(el('p', { className: 'c-empty__desc', text: '记几笔后，这里会自动生成收支结构与变化解读。' }));
    /* 必须是真链接：button 上补 href 不会导航 */
    var cta = buttonNode('记一笔', { href: '#/add', className: 'c-btn c-btn--primary c-empty__action', icon: 'plus' });
    empty.appendChild(cta);
    card.appendChild(empty);
    return card;
  }

  function emptyPeriod() {
    var card = el('div', { className: 'c-card s-insights-empty' });
    card.appendChild(el('p', { className: 's-insights-empty__title', text: '该账期暂无记录' }));
    card.appendChild(el('p', {
      className: 's-insights-empty__text',
      text: monthLabel(S.month) + ' 没有任何收支。可以换一个账期，或先记一笔。'
    }));
    var row = el('div', { className: 's-insights-empty__actions' });
    if (S.month !== currentMonth() || S.range !== 'month') {
      row.appendChild(buttonNode('回到本月', {
        icon: 'arrow-up',
        onClick: function () {
          S.month = currentMonth();
          S.range = 'month';
          syncHash();
          updatePeriod(null);
          repaint(true);
        }
      }));
    }
    row.appendChild(buttonNode('记一笔', { className: 'c-btn c-btn--primary', href: '#/add', icon: 'plus' }));
    card.appendChild(row);
    return card;
  }

  function errorCard() {
    var card = el('div', { className: 'c-card s-insights-error', role: 'alert' });
    var holder = el('span', { className: 's-insights-error__icon', 'aria-hidden': 'true' });
    holder.appendChild(iconNode('warning', 28));
    card.appendChild(holder);
    card.appendChild(el('p', { className: 's-insights-error__title', text: '解读暂时没有生成' }));
    card.appendChild(el('p', {
      className: 's-insights-error__text',
      text: '读取本地账单时出了点问题，原始账单没有受影响。请重试一次。'
    }));
    card.appendChild(buttonNode('重试', { className: 'c-btn c-btn--primary', icon: 'refresh', onClick: function () { repaint(true); } }));
    return card;
  }

  /* ---------------- 下钻 Sheet ---------------- */

  function openCategoryById(report, categoryId) {
    var cat = categoryOf(report, categoryId);
    if (!cat) { return; }
    openCategorySheet(report, {
      id: cat.id,
      name: cat.name,
      icon: cat.icon,
      amountCents: cat.amountCents,
      count: cat.count,
      pct: pctOf(cat.amountCents, report.win.totals.expenseCents),
      colorVar: toneVar(cat.id, report.meta)
    });
  }

  function openFoldedSheet(report, row) {
    if (row.folded) {
      openOtherSheet(report, row);
      return;
    }
    openCategorySheet(report, row);
  }

  function sheetBodyShell() {
    return el('div', { className: 's-insights-sheet' });
  }

  function openCategorySheet(report, cat) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var body = sheetBodyShell();
    var head = el('div', { className: 's-insights-sheet__head' });
    var chip = el('span', { className: 's-insights-sheet__icon' });
    chip.appendChild(iconNode(cat.icon || 'box', 20));
    head.appendChild(chip);
    head.appendChild(el('span', { className: 's-insights-sheet__pct u-tabular', text: cat.pct.toFixed(1) + '%' }));
    body.appendChild(head);
    body.appendChild(el('p', {
      className: 's-insights-sheet__sum u-tabular',
      text: fmt(cat.amountCents) + ' \u00b7 ' + cat.count + ' 笔'
    }));

    var items = [];
    for (var i = 0; i < report.win.items.length; i += 1) {
      if (report.win.items[i].categoryId === cat.id) { items.push(report.win.items[i]); }
    }
    items.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
    body.appendChild(txList(report, items, function () {
      var fresh = buildReport(S.ctx);
      if (!fresh || fresh.failed) { return; }
      openCategoryById(fresh, cat.id);
    }));
    sheet.open({
      title: cat.name,
      content: body,
      ariaLabel: cat.name + '明细',
      actions: [{ label: '关闭', kind: 'text' }]
    });
  }

  function openOtherSheet(report, row) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var body = sheetBodyShell();
    body.appendChild(el('p', {
      className: 's-insights-sheet__sum u-tabular',
      text: '其他 ' + row.pct.toFixed(1) + '% \u00b7 ' + fmt(row.amountCents) + ' \u00b7 ' + row.count + ' 笔'
    }));
    var list = el('div', { className: 's-insights-sheet__cats' });
    for (var i = 0; i < row.children.length; i += 1) {
      (function (cat) {
        var button = el('button', { className: 's-insights-sheet__cat', type: 'button' });
        var dot = el('span', { className: 's-insights-legend__dot', 'aria-hidden': 'true' });
        dot.style.background = 'var(' + cat.colorVar + ')';
        button.appendChild(dot);
        button.appendChild(el('span', { className: 's-insights-sheet__catname', text: cat.name }));
        button.appendChild(el('span', { className: 's-insights-sheet__catval u-tabular', text: fmt(cat.amountCents) + ' \u00b7 ' + cat.pct.toFixed(1) + '%' }));
        button.addEventListener('click', function () {
          openCategorySheet(report, {
            id: cat.id,
            name: cat.name,
            icon: cat.icon,
            amountCents: cat.amountCents,
            count: cat.count,
            pct: cat.pct,
            colorVar: cat.colorVar
          });
        });
        list.appendChild(button);
      }(row.children[i]));
    }
    body.appendChild(list);
    sheet.open({
      title: '其他分类',
      content: body,
      actions: [{ label: '关闭', kind: 'text' }]
    });
  }

  function txList(report, items, reopen) {
    var box = el('div', { className: 's-insights-txlist' });
    var limit = Math.min(items.length, RULES.LIST_LIMIT);
    for (var i = 0; i < limit; i += 1) {
      (function (item) {
        var row = el('button', { className: 's-insights-tx', type: 'button' });
        row.appendChild(el('span', { className: 's-insights-tx__date', text: dateLabel(item.date) }));
        var main = el('span', { className: 's-insights-tx__main' });
        main.appendChild(el('span', { className: 's-insights-tx__note', text: noteOf(report, item) }));
        main.appendChild(el('span', {
          className: 's-insights-tx__meta',
          text: accountNameOf(report, item.accountId) + ' \u00b7 ' + (report.meta[item.categoryId] ? report.meta[item.categoryId].name : '未分类')
        }));
        row.appendChild(main);
        row.appendChild(el('span', { className: 's-insights-tx__amt u-tabular', text: '\u2212' + fmt(item.amountCents) }));
        row.addEventListener('click', function () { openTxSheet(report, item, reopen); });
        box.appendChild(row);
      }(items[i]));
    }
    if (!items.length) {
      box.appendChild(el('p', { className: 's-insights-muted', text: '这个分类在当前账期没有记录。' }));
    } else if (items.length > limit) {
      box.appendChild(el('p', {
        className: 's-insights-muted',
        text: '仅显示最近 ' + limit + ' 笔，共 ' + items.length + ' 笔。'
      }));
    }
    return box;
  }

  function openLargeSheet(report) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var items = report.win.items.slice().sort(function (a, b) { return b.amountCents - a.amountCents; });
    var body = sheetBodyShell();
    body.appendChild(el('p', { className: 's-insights-sheet__sum', text: '按金额从高到低，最多 ' + RULES.LARGE_COUNT + ' 笔。' }));
    body.appendChild(txList(report, items.slice(0, RULES.LARGE_COUNT), function () {
      var fresh = buildReport(S.ctx);
      if (fresh && !fresh.failed) { openLargeSheet(fresh); }
    }));
    sheet.open({
      title: '本期最大支出',
      content: body,
      actions: [{ label: '关闭', kind: 'text' }]
    });
  }

  function openTxSheet(report, item, reopen) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var tx = item.tx || {};
    var body = el('div', { className: 's-ledger-detail' });
    body.appendChild(el('p', {
      className: 's-ledger-detail__amount s-ledger-detail__amount--expense u-tabular',
      text: '\u2212' + fmt(item.amountCents)
    }));
    var lines = [
      ['分类', report.meta[item.categoryId] ? report.meta[item.categoryId].name : (item.categoryName || '未分类')],
      ['账户', accountNameOf(report, item.accountId)],
      ['时间', item.date + (tx.time ? ' ' + String(tx.time) : '')]
    ];
    if (item.note) { lines.push(['备注', item.note]); }
    if (Array.isArray(tx.tags) && tx.tags.length) { lines.push(['标签', '#' + tx.tags.join(' #')]); }
    var list = el('div', { className: 's-ledger-detail__list' });
    for (var i = 0; i < lines.length; i += 1) {
      var row = el('div', { className: 's-ledger-detail__row' });
      row.appendChild(el('span', { className: 's-ledger-detail__key', text: lines[i][0] }));
      row.appendChild(el('span', {
        className: 's-ledger-detail__val' + (lines[i][0] === '备注' ? ' s-ledger-detail__val--note' : ''),
        text: lines[i][1]
      }));
      list.appendChild(row);
    }
    body.appendChild(list);

    S.sheetRestore = typeof reopen === 'function' ? reopen : null;
    S.suppressRestore = false;
    sheet.open({
      title: '这笔流水',
      content: body,
      onClose: function (reason) {
        if (reason === 'replaced') { return; }
        if (S.suppressRestore) { S.suppressRestore = false; S.sheetRestore = null; return; }
        var restore = S.sheetRestore;
        S.sheetRestore = null;
        if (restore && !S.dead) {
          later(restore, 60);
        }
      },
      actions: [
        { label: '关闭', kind: 'text' },
        {
          label: '编辑',
          kind: 'default',
          onClick: function () {
            S.suppressRestore = true;
            var id = tx.id ? encodeURIComponent(String(tx.id)) : '';
            if (S.ctx && typeof S.ctx.go === 'function') { S.ctx.go('#/add?id=' + id); }
          }
        }
      ]
    });
  }

  /* ---------------- 渲染主流程 ---------------- */

  function paintCards(report) {
    S.contentEl.appendChild(coreCard(report));
    S.contentEl.appendChild(summaryCard(report));
    S.contentEl.appendChild(structureCard(report));
    S.contentEl.appendChild(barsCard(report));
    if (report.tips.length) { S.contentEl.appendChild(tipsCard(report)); }
    if (report.actions.length) { S.contentEl.appendChild(actionsCard(report)); }
    S.contentEl.appendChild(footNote(report));
  }

  function paint(first) {
    if (S.dead || !S.contentEl) { return; }
    var token = S.seq;
    var host = S.contentEl;
    var report = null;
    try {
      report = buildReport(S.ctx);
    } catch (error) {
      report = { failed: true };
    }
    if (token !== S.seq || S.dead) { return; }
    clearNode(host);
    host.setAttribute('aria-busy', 'false');
    if (!report || report.failed) {
      host.appendChild(errorCard());
      updatePeriod(null);
      return;
    }
    if (!report.hasAny) {
      host.appendChild(emptyAll());
      updatePeriod(null);
      return;
    }
    if (report.win.totals.count === 0) {
      host.appendChild(emptyPeriod());
      updatePeriod(report);
      return;
    }
    try {
      paintCards(report);
      updatePeriod(report);
    } catch (error) {
      clearNode(host);
      host.appendChild(errorCard());
      updatePeriod(null);
    }
    if (first) {
      var items = host.querySelectorAll('.c-card, .s-insights-foot');
      for (var i = 0; i < items.length; i += 1) {
        items[i].classList.add('s-insights-in');
        items[i].style.setProperty('--i', String(Math.min(i, 5)));
      }
    }
  }

  function schedule(first) {
    if (!S.contentEl) { return; }
    if (S.timer) { global.clearTimeout(S.timer); S.timer = 0; }
    S.seq += 1;
    var token = S.seq;
    if (first) {
      clearNode(S.contentEl);
      S.contentEl.setAttribute('aria-busy', 'true');
      var skel = skeleton();
      /* 骨架延迟 RULES.SKELETON_DELAY_MS 才淡入：本地读取通常 16ms 内完成，快路径不会闪一下骨架 */
      skel.style.opacity = '0';
      skel.style.transition = 'opacity 120ms linear ' + RULES.SKELETON_DELAY_MS + 'ms';
      S.contentEl.appendChild(skel);
      var reveal = global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); };
      reveal(function () { if (skel.parentNode) { skel.style.opacity = '1'; } });
      S.timer = global.setTimeout(function () {
        S.timer = 0;
        if (token !== S.seq) { return; }
        paint(true);
      }, 16);
      return;
    }
    paint(false);
  }

  function repaint(first) {
    if (!S.contentEl) { return; }
    schedule(first === true);
  }

  /* 账期/区间写回地址栏但不重渲染：刷新、前进后退、深链都能得到同一份报告。
   replaceState 不触发 hashchange，因此不会打断当前滚动位置。 */
  function syncHash() {
    if (!S.month) { return; }
    var hash = '#/insights?m=' + S.month + '&r=' + S.range;
    var changed = global.location.hash !== hash;
    if (changed) {
      var router = XZB.router;
      if (router && typeof router.setHash === 'function') {
        /* 同步 router.current()/history.state，前进后退与外部 rerender 才不会拿到旧 query */
        if (!router.setHash(hash)) { return; }
      } else {
        try { global.history.replaceState(global.history.state, '', hash); } catch (error) { return; }
      }
    }
    if (S.ctx && S.ctx.route) {
      S.ctx.route.hash = hash;
      S.ctx.route.query = { m: S.month, r: S.range };
      S.ctx.route.params = S.ctx.route.query;
    }
    S.lastSig = S.month + '|' + S.range;
  }

  function setRange(key) {
    if (!RANGE_BY_KEY[key]) { return; }
    /* 本月恒回当前月；上月恒取当前月上一月；近 3/6 个月恒以当前月为终点。
       同一 chip 再点一次也重新锚定（例如从柱状图切到 5 月后点「本月」）。 */
    var now = currentMonth();
    var nextMonth = key === 'prev' ? addMonth(now, -1) : now;
    if (key === S.range && nextMonth === S.month) { return; }
    S.range = key;
    S.month = nextMonth;
    S.lastSig = '';
    syncHash();
    updatePeriod(null);
    repaint(false);
  }

  function setMonth(month) {
    if (!isMonth(month)) { return; }
    if (month === S.month && S.range === 'month') { return; }
    S.month = month;
    S.range = 'month';
    syncHash();
    updatePeriod(null);
    repaint(false);
  }

  function applyParams(ctx) {
    var query = (ctx && ctx.query) || {};
    /* cat 也参与签名：否则从同一账期再点某个分类的「明细」深链会被旧 lastSig 吞掉 */
    var sig = String(query.m || '') + '|' + String(query.r || '') + '|' + String(query.cat || '');
    if (sig !== S.lastSig) {
      S.lastSig = sig;
      if (isMonth(query.m) && query.m <= currentMonth()) { S.month = query.m; }
      if (RANGE_BY_KEY[query.r]) { S.range = query.r; }
      if (query.cat) { S.pendingCat = String(query.cat); }
    }
    if (!isMonth(S.month) || S.month > currentMonth()) { S.month = currentMonth(); }
    if (!RANGE_BY_KEY[S.range]) { S.range = 'month'; }
    /* 上月/近 3/6 个月恒以当前月为锚点，地址里的 m 只是写回用的快照；本月才认 m（供柱状图切月与深链） */
    if (S.range === 'prev') { S.month = addMonth(currentMonth(), -1); }
    else if (S.range !== 'month') { S.month = currentMonth(); }
  }

  function render(root, ctx) {
    if (!root) { return; }
    S.root = root;
    S.ctx = ctx || null;
    S.dead = false;
    if (S.timer) { global.clearTimeout(S.timer); S.timer = 0; }
    clearLater();
    applyParams(S.ctx);
    /* 会话内保留上次账期/区间：从别的 Tab 回来时把地址栏补齐，刷新仍落在同一份报告 */
    syncHash();
    buildShell();
    schedule(true);

    if (S.pendingCat) {
      var categoryId = S.pendingCat;
      S.pendingCat = '';
      later(function () {
        var report = buildReport(S.ctx);
        if (report && !report.failed) { openCategoryById(report, categoryId); }
      }, 120);
    }
    /* 路由只采纳 render 返回对象上的 destroy；屏幕对象上的 destroy 不会被调用。 */
    return { destroy: destroy };
  }

  function destroy() {
    S.dead = true;
    if (S.timer) { global.clearTimeout(S.timer); S.timer = 0; }
    clearLater();
    S.root = null;
    S.ctx = null;
    S.contentEl = null;
    S.periodEl = null;
    S.resetEl = null;
    S.sheetRestore = null;
  }

  var screen = {
    title: '账单解读',
    subtitle: '本月收支洞察',
    render: render,
    destroy: destroy
  };

  XZB.screens.register('insights', screen);
}(window));