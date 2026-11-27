/* 小账本 2.40.0 · js/screens/stats.js
 * 统计（合并屏）：2.40.0 起「统计」与「账单解读」合并为一页，登记 key 仍为 stats。
 * 以原 insights.js 为基干（AI 复盘 / 体检 / 本地规则 / 钻取 Sheet 体量大），
 * 移植原 stats.js 的收/支类型切换与折线/柱状 12 月趋势；环图图例与分类排行合并为一份清单；
 * 每日热力图迁往独立日历页（#/calendar），本页不再渲染。
 * 结构：月份/账期/类型筛选 → 核心结论 → 收支摘要 → 消费结构（环图＋排行合一）
 *       → 收支趋势（折线/柱状）→ 解读报告（生成→查看→存档，每日 0 点刷新）
 *       → 值得留意（本地规则）→ 账单体检 → 行动建议 → 口径脚注。
 * 契约：XZB.screens.register('stats', { title, subtitle, render, destroy })
 * 依赖：XZB.core.{dates,money,stats}、XZB.core.aiInsights、XZB.core.audit（账单体检，2.39.0）；
 *       按需加载：XZB.core.assistant.llm（不在本屏 DEPS，首次点「生成解读」时 ensure）
 *       XZB.ui.{icons,kit,charts,sheet,toast}、XZB.app（含 reports 存档门面）
 * 硬规则：不碰 IndexedDB / localStorage；只读 ctx.db；金额一律整数分；
 *         统计口径五道过滤（deleted / 账本 / 类型 / 金额 / 日期）；
 *         规则集中在本文件 RULES 常量里，结论只陈述事实，不做道德评判。
 */
(function (global) {
  'use strict';

  var XZB = (global.XZB = global.XZB || {});
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] stats 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var Core = XZB.core || XZB.Core || {};
  var dates = Core.dates || null;
  var money = Core.money || null;
  var stats = Core.stats || null;
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
    RANK_FOLDED: 5,           /* 结构清单默认前 5，展开看全部（原统计页排行口径） */
    COLLECT_MONTHS: 12,       /* 一次遍历的月份窗口（含历史与趋势） */
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
  var MONTH_MIN = '2000-01';

  var S = {
    root: null,
    ctx: null,
    contentEl: null,
    periodEl: null,
    resetEl: null,
    month: '',
    range: 'month',
    /* 2.40.0 合并：原统计页的类型切换与趋势形态（会话内保留，不进地址栏） */
    kind: 'expense',
    trend: 'line',
    trendRange: '12',
    rankOpen: false,
    seq: 0,
    timer: 0,
    timers: [],
    dead: false,
    lastSig: null,
    suppressRestore: false,
    sheetRestore: null,
    /* 解读报告（2.40.0）：存档列表缓存＋在途态；报告落 IndexedDB 独立 key，跨 destroy 保留 */
    reportsCache: null,
    reportsLoading: false,
    reportError: '',
    privacyPending: false,
    regenPending: false,
    todayCache: '',
    aiBusy: false,
    aiBusyMonth: '',
    aiRetryHint: '',
    /* core-assistant 按需加载态（不在本屏 DEPS 里） */
    aiModuleLoading: false,
    aiModuleError: false
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

  function toast(message, options) {
    var t = XZB.ui && XZB.ui.toast ? XZB.ui.toast : null;
    if (t && typeof t.show === 'function') { t.show(message, options || {}); }
  }

  /* 报告存档门面（2.40.0）：屏幕层不直连 IndexedDB，一律经 XZB.app.reports */
  function reportsApi() {
    var app = XZB.app;
    return app && app.reports && typeof app.reports.list === 'function' ? app.reports : null;
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

  function daysInMonthOf(month) {
    if (!isMonth(month)) { return 30; }
    return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  }

  /* 2.33.0：「上月同期」口径（同 ai-insights / 统计页）。month 为今天所在月且未过完时，
   * 返回 { isPartial:true, day:已过天数 }；过去月/月末当天返回 isPartial:false（整月口径）。
   * 基期截止日由调用方按各自窗口的末月自行夹取（本月窗=上月同日，多月窗=前窗末月同日）。 */
  function samePeriodOf(month, today) {
    var t = String(today || todayStr());
    var day = Number(t.slice(8, 10)) || 1;
    var dim = daysInMonthOf(month);
    if (!isMonth(month) || month !== t.slice(0, 7) || day >= dim) {
      return { isPartial: false, day: 0 };
    }
    return { isPartial: true, day: day };
  }

  function monthLabel(key) {
    if (!isMonth(key)) { return String(key || ''); }
    return key.slice(0, 4) + '年' + Number(key.slice(5, 7)) + '月';
  }

  function shortMonth(key) {
    return isMonth(key) ? String(Number(key.slice(5, 7))) + '月' : String(key || '');
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

  /* 一次遍历完成：合计、分类（收/支两桶）、异常计数、下钻流水，全在 COLLECT_MONTHS 窗口内。 */
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
      index[months[i]] = { month: months[i], incomeCents: 0, expenseCents: 0, count: 0, transferCents: 0, transferCount: 0, cats: {}, incomeCats: {} };
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
        /* 2.40.0 合并：收入分类桶（收/支类型切换的收入结构用），与支出 cats 同口径 */
        var incomeCatId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
        var incomeCat = bucket.incomeCats[incomeCatId];
        if (!incomeCat) { incomeCat = bucket.incomeCats[incomeCatId] = { categoryId: incomeCatId, amountCents: 0, count: 0 }; }
        incomeCat.amountCents += amount;
        incomeCat.count += 1;
        /* 2.33.0：item 增收收入项（带 type），供「上月同期」在窗口末月做 item 级裁剪；
           无 type 字段的历史形态一律视为支出（向后兼容）。 */
        model.items.push({
          tx: tx,
          date: date,
          month: month,
          type: 'income',
          categoryId: typeof tx.categoryId === 'string' ? tx.categoryId : '',
          categoryName: typeof tx.categoryName === 'string' ? tx.categoryName : '',
          accountId: typeof tx.accountId === 'string' ? tx.accountId : '',
          note: typeof tx.note === 'string' ? tx.note : '',
          amountCents: amount
        });
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
        type: 'expense',
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

  function summarize(model, endMonth, count, meta, cutDate) {
    var months = monthRange(endMonth, count);
    /* 2.33.0「上月同期」：cutDate 落在窗口末月时，该月不再用整月桶，
       改由 item 级流水按日期重算（收入/支出/笔数/分类）；其余月照旧。 */
    var cut = typeof cutDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cutDate) ? cutDate : '';
    var cutMonth = cut ? cut.slice(0, 7) : '';
    var clampLast = !!cut && months[months.length - 1] === cutMonth;
    var inSet = {};
    var totals = { incomeCents: 0, expenseCents: 0, transferCents: 0, count: 0 };
    for (var i = 0; i < months.length; i += 1) {
      inSet[months[i]] = true;
      if (clampLast && months[i] === cutMonth) { continue; }
      var bucket = model.byMonth[months[i]];
      if (!bucket) { continue; }
      totals.incomeCents += bucket.incomeCents;
      totals.expenseCents += bucket.expenseCents;
      totals.transferCents += bucket.transferCents;
      totals.count += bucket.count;
    }
    var cats = {};
    var incomeCats = {};
    var items = [];
    var incomeItems = [];
    for (var k = 0; k < model.items.length; k += 1) {
      var item = model.items[k];
      if (!inSet[item.month]) { continue; }
      if (clampLast && item.month === cutMonth && String(item.date) > cut) { continue; }
      var income = item.type === 'income';
      if (clampLast && item.month === cutMonth) {
        /* 被裁剪月的贡献（转账数无从 item 级拆分，前窗转账数无消费方，记 0） */
        if (income) { totals.incomeCents += item.amountCents; } else { totals.expenseCents += item.amountCents; }
        totals.count += 1;
      }
      if (income) {
        /* 2.40.0 合并：收入侧同样聚分类与流水，供类型切换的结构卡与钻取 */
        incomeItems.push(item);
        var icat = incomeCats[item.categoryId];
        if (!icat) {
          var imetaRow = meta[item.categoryId];
          icat = incomeCats[item.categoryId] = {
            id: item.categoryId,
            name: imetaRow ? imetaRow.name : (item.categoryName || '未分类'),
            icon: imetaRow ? imetaRow.icon : 'box',
            amountCents: 0,
            count: 0
          };
        }
        icat.amountCents += item.amountCents;
        icat.count += 1;
        continue;
      }
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
    function catListOf(map, total) {
      var list = [];
      Object.keys(map).forEach(function (id) {
        var row = map[id];
        row.pct = pctOf(row.amountCents, total);
        row.colorVar = toneVar(id, meta);
        list.push(row);
      });
      list.sort(function (a, b) { return b.amountCents - a.amountCents || a.name.localeCompare(b.name); });
      return list;
    }
    var catList = catListOf(cats, totals.expenseCents);
    var incomeCatList = catListOf(incomeCats, totals.incomeCents);
    var netCents = totals.incomeCents - totals.expenseCents;
    return {
      months: months,
      totals: totals,
      netCents: netCents,
      cats: catList,
      items: items,
      incomeCats: incomeCatList,
      incomeItems: incomeItems
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
    /* 2.33.0「上月同期」：锚点是当前月且未过完时，前窗末月裁到同日，两侧同期可比 */
    var same = samePeriodOf(anchor);
    var cutDate = '';
    if (same.isPartial) {
      var prevEndMonth = addMonth(win.months[0], -1);
      cutDate = prevEndMonth + '-' + pad2(Math.min(same.day, daysInMonthOf(prevEndMonth)));
    }
    var prev = summarize(model, addMonth(win.months[0], -1), range.months, meta, cutDate);
    var report = {
      db: db,
      meta: meta,
      accounts: accountMeta(db),
      model: model,
      win: win,
      prev: prev,
      range: range,
      endMonth: win.months[win.months.length - 1],
      isPartial: same.isPartial,
      periodDay: same.isPartial ? same.day : 0,
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
    if (assistantEntryOn()) {
      actions.push({
        icon: 'sparkles',
        label: '让助手继续分析',
        href: assistantHash(report, { q: report.range.months > 1
          ? '近' + report.range.months + '个月支出趋势怎么样？'
          : monthLabel(report.endMonth) + '支出和上月' + (report.isPartial ? '同期' : '') + '比差在哪？' })
      });
      return actions.slice(0, RULES.ACTION_MAX + 1);
    }
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

  /* ---------------- 画面骨架 ---------------- */

  function periodText(report) {
    var range = (report && report.range) || RANGE_BY_KEY[S.range] || RANGES[0];
    /* 2.44.6（P3-2）：深链/趋势点月进入历史月时，「本月」后缀与事实冲突——
       单月且非当前月改显「单月」；prev 档恒以当前月锚定上月，不受影响。 */
    var month = report ? report.endMonth : S.month;
    var label = range.key === 'month' && isMonth(month) && month !== currentMonth()
      ? '单月' : range.label;
    if (!report) {
      return monthLabel(S.month) + ' \u00b7 ' + label;
    }
    if (range.key === 'month' || range.key === 'prev') {
      return monthLabel(report.endMonth) + ' \u00b7 ' + label;
    }
    var start = report.win.months[0];
    return monthLabel(start) + ' 至 ' + monthLabel(report.endMonth) + ' \u00b7 ' + label;
  }

  function buildShell() {
    clearNode(S.root);
    var wrap = el('div', { className: 's-insights' });
    var head = el('div', { className: 's-insights-head' });
    var top = el('div', { className: 's-insights-head__top' });
    /* 2.40.0 合并：月份切换从原统计页移植（柱图删掉后这是唯一的翻月入口） */
    var prevBtn = el('button', {
      className: 's-insights-monthbtn',
      type: 'button',
      'data-monthnav': '-1',
      'aria-label': '上一个月'
    }, [iconNode('chevron-left', 18)]);
    prevBtn.addEventListener('click', function () { shiftMonth(-1); });
    top.appendChild(prevBtn);
    S.periodEl = el('p', { className: 's-insights-period', text: periodText(null) });
    top.appendChild(S.periodEl);
    var nextBtn = el('button', {
      className: 's-insights-monthbtn',
      type: 'button',
      'data-monthnav': '1',
      'aria-label': '下一个月'
    }, [iconNode('chevron-right', 18)]);
    nextBtn.addEventListener('click', function () { shiftMonth(1); });
    top.appendChild(nextBtn);
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

    /* 2.40.0 合并：收/支类型切换（原统计页移植）——只作用于结构卡与趋势柱状；
       摘要卡收支并列，核心结论/留意/体检/报告恒为支出口径，不受切换影响 */
    var kindSeg = el('div', {
      className: 'c-segmented s-insights-kind',
      role: 'group',
      'aria-label': '收支类型'
    });
    [['expense', '支出'], ['income', '收入']].forEach(function (item) {
      var btn = el('button', {
        className: 'c-segmented__item' + (item[0] === S.kind ? ' is-active' : ''),
        type: 'button',
        'aria-pressed': item[0] === S.kind ? 'true' : 'false',
        text: item[1],
        dataset: { kind: item[0] }
      });
      btn.addEventListener('click', function () {
        if (S.kind === item[0]) { return; }
        S.kind = item[0];
        S.rankOpen = false;
        updatePeriod(null);
        repaint(false);
      });
      kindSeg.appendChild(btn);
    });
    head.appendChild(kindSeg);
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
    var kindSeg = S.root ? S.root.querySelector('.s-insights-kind') : null;
    if (kindSeg) {
      var kindItems = kindSeg.querySelectorAll('.c-segmented__item');
      for (var k = 0; k < kindItems.length; k += 1) {
        var kindActive = kindItems[k].getAttribute('data-kind') === S.kind;
        kindItems[k].classList.toggle('is-active', kindActive);
        kindItems[k].setAttribute('aria-pressed', kindActive ? 'true' : 'false');
      }
    }
    var navButtons = S.root ? S.root.querySelectorAll('[data-monthnav]') : [];
    for (var n = 0; n < navButtons.length; n += 1) {
      var delta = Number(navButtons[n].getAttribute('data-monthnav'));
      navButtons[n].disabled = delta < 0 ? !hasPrevMonth() : !hasNextMonth();
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

  /* ---------------- 结构画布（2.40.0 合并：环图＋排行一份清单） ---------------- */

  /* 收/支类型切换只作用于结构卡与趋势；其余模块恒为支出口径 */
  function kindCats(report) { return S.kind === 'income' ? report.win.incomeCats : report.win.cats; }
  function kindItems(report) { return S.kind === 'income' ? report.win.incomeItems : report.win.items; }
  function kindTotal(report) { return S.kind === 'income' ? report.win.totals.incomeCents : report.win.totals.expenseCents; }
  function kindName() { return S.kind === 'income' ? '收入' : '支出'; }

  /* 排行环比措辞（原统计页移植）：基期 0 记「新增」，±0.05% 内记「持平」 */
  function rankMomText(amount, prevAmount, goodWhenUp) {
    var prev = Number(prevAmount) || 0;
    var cur = Number(amount) || 0;
    if (prev === 0 && cur === 0) { return { text: '—', tone: 'flat' }; }
    if (prev === 0) { return { text: '新增', tone: goodWhenUp ? 'good' : 'bad' }; }
    var pct = (cur - prev) / Math.abs(prev) * 100;
    if (!isFinite(pct)) { return { text: '—', tone: 'flat' }; }
    if (Math.abs(pct) < 0.05) { return { text: '持平', tone: 'flat' }; }
    var up = pct > 0;
    return {
      text: (up ? '↑' : '↓') + Math.abs(pct).toFixed(0) + '%',
      tone: (up === !!goodWhenUp) ? 'good' : 'bad'
    };
  }

  function structureCard(report) {
    var isIncome = S.kind === 'income';
    var cats = kindCats(report);
    var total = kindTotal(report);
    var card = moduleCard(kindName() + '结构', null, 's-insights-structure');
    if (!(total > 0)) {
      card.appendChild(el('p', { className: 's-insights-muted', text: '本期没有' + kindName() + '记录，暂时没有可拆分的结构。' }));
      return card;
    }
    var folded = foldCats(report, cats, RULES.DONUT_TOP, total);
    var topShare = 0;
    for (var i = 0; i < Math.min(folded.length, RULES.DONUT_TOP); i += 1) { topShare += folded[i].amountCents; }
    card.querySelector('.s-insights-mod__head').appendChild(el('span', {
      className: 's-insights-mod__tag u-tabular',
      text: '前五类 ' + pctOf(topShare, total).toFixed(1) + '%'
    }));

    var body = el('div', { className: 's-insights-structure__body' });
    var chartBox = el('div', { className: 's-insights-donut' });
    var chartHost = el('div', { className: 's-insights-donut__chart' });
    chartBox.appendChild(chartHost);
    body.appendChild(chartBox);

    /* 图例与排行合并为同一份清单：默认前 5 ＋「其他」，展开看全部（含环比） */
    var legendRows = foldCats(report, cats, RULES.LEGEND_TOP, total);
    var prevCats = isIncome ? report.prev.incomeCats : report.prev.cats;
    var prevById = {};
    for (var p = 0; p < prevCats.length; p += 1) { prevById[prevCats[p].id] = prevCats[p].amountCents; }
    var baseLabel = '较上月' + (report.isPartial ? '同期' : '');
    var visible = S.rankOpen ? legendRows : legendRows.filter(function (row) { return row.folded; }).concat(legendRows.filter(function (row) { return !row.folded; }).slice(0, RULES.RANK_FOLDED));
    /* 折叠态顺序：前 5 在前，「其他」收尾 */
    if (!S.rankOpen) {
      visible = legendRows.filter(function (row) { return !row.folded; }).slice(0, RULES.RANK_FOLDED)
        .concat(legendRows.filter(function (row) { return row.folded; }));
    }
    var legend = el('div', { className: 's-insights-legend', role: 'group', 'aria-label': kindName() + '分类排行' });
    for (var j = 0; j < visible.length; j += 1) {
      (function (row) {
        var item = el('button', {
          className: 's-insights-legend__row',
          type: 'button',
          'aria-label': row.name + '，' + fmt(row.amountCents) + '，占 ' + row.pct.toFixed(1) + '%',
          dataset: { cat: row.id }
        });
        var dot = el('span', { className: 's-insights-legend__dot', 'aria-hidden': 'true' });
        dot.style.background = 'var(' + row.colorVar + ')';
        item.appendChild(dot);
        var main = el('span', { className: 's-insights-legend__main' });
        main.appendChild(el('span', { className: 's-insights-legend__name', text: row.name }));
        main.appendChild(el('span', { className: 's-insights-legend__meta u-tabular', text: fmt(row.amountCents) + ' · ' + row.pct.toFixed(1) + '%' }));
        if (!row.folded) {
          var mom = rankMomText(row.amountCents, prevById[row.id], isIncome);
          main.appendChild(el('span', {
            className: 's-insights-legend__mom s-stats-rank__mom--' + mom.tone,
            text: baseLabel + ' ' + mom.text
          }));
        }
        item.appendChild(main);
        item.appendChild(el('span', { className: 's-insights-legend__count', text: String(row.count) + ' 笔' }));
        item.addEventListener('click', function () {
          var all = legend.querySelectorAll('.s-insights-legend__row');
          for (var q = 0; q < all.length; q += 1) { all[q].classList.toggle('is-selected', all[q] === item); }
          openFoldedSheet(report, row);
        });
        legend.appendChild(item);
      }(visible[j]));
    }
    body.appendChild(legend);
    card.appendChild(body);

    if (cats.length > RULES.RANK_FOLDED) {
      var toggle = buttonNode(S.rankOpen ? '收起' : '展开全部（' + cats.length + ' 个分类）', {
        className: 's-insights-legend__toggle',
        icon: S.rankOpen ? 'chevron-up' : 'chevron-down',
        onClick: function () { S.rankOpen = !S.rankOpen; repaint(false); }
      });
      card.appendChild(toggle);
    }

    var summary = el('p', { className: 's-insights-note' });
    if (folded.length >= 2) {
      summary.textContent = folded[0].name + '与' + folded[1].name + '合计占' + kindName() + '的 ' +
        pctOf(folded[0].amountCents + folded[1].amountCents, total).toFixed(1) + '%，是本期' + kindName() + '的主体。';
    } else {
      summary.textContent = kindName() + '集中在' + folded[0].name + '，占 ' + folded[0].pct.toFixed(1) + '%。';
    }
    card.appendChild(summary);

    try {
      if (!charts || typeof charts.donut !== 'function') { throw new Error('charts unavailable'); }
      charts.donut(chartHost, folded.map(function (row) {
        return { label: row.name, amountCents: row.amountCents, color: row.colorVar };
      }), {
        height: 196,
        thickness: 22,
        centerSub: '总' + kindName(),
        ariaLabel: kindName() + '分类构成，共 ' + folded.length + ' 类'
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
      chartHost.appendChild(chartFail(kindName() + '结构', folded.map(function (row) {
        return row.name + ' ' + fmt(row.amountCents) + '（' + row.pct.toFixed(1) + '%）';
      }), function () { repaint(false); }));
    }
    return card;
  }

  function foldCats(report, cats, limit, total) {
    var rows = [];
    var sum = typeof total === 'number' ? total : report.win.totals.expenseCents;
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
      rest.pct = pctOf(rest.amountCents, sum);
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

  /* ---------------- 收支趋势（2.40.0 从原统计页移植：折线/柱状 · 12 月窗口） ---------------- */

  function axisText(cents) {
    var yuan = cents / 100;
    if (yuan >= 10000) { return (Math.round(yuan / 1000) / 10) + '万'; }
    if (yuan >= 1000) { return (Math.round(yuan / 100) / 10) + 'k'; }
    return String(Math.round(yuan));
  }

  function trendData(db, month, bookId) {
    var range = monthRange(month);
    var opts = { from: range.start, to: range.end, granularity: 'month' };
    if (bookId) { opts.bookId = bookId; }
    if (S.trendRange === 'mon') {
      opts.granularity = 'day';
    } else {
      opts.from = addMonth(month, -(12 - 1)) + '-01';
    }
    if (stats && typeof stats.trend === 'function') {
      var out = stats.trend(db, opts);
      if (out && Array.isArray(out.labels)) { return trimEmptyHead(out); }
    }
    return { labels: [], series: [], granularity: opts.granularity, from: opts.from, to: opts.to };
  }

  /* 账本刚用两三个月时，「近 12 月」前面九个月全是 0，折线会在底部拉一条长直线，
     看起来像图坏了。这里砍掉开头连续为空的月份，只画有数据的区间。 */
  function monthIsEmpty(out, index) {
    for (var i = 0; i < out.series.length; i += 1) {
      if (Number(out.series[i].values[index]) !== 0) { return false; }
    }
    return true;
  }

  function trimEmptyHead(out) {
    if (out.granularity !== 'month' || out.labels.length < 3 || !Array.isArray(out.series)) {
      return out;
    }
    var first = 0;
    while (first < out.labels.length && monthIsEmpty(out, first)) { first += 1; }
    /* 至少保留 6 个月的上下文：只留两三个月会让「近 12 月」看起来像没数据 */
    var start = Math.min(first, Math.max(0, out.labels.length - 6));
    if (start === 0 || start >= out.labels.length) { return out; }
    var trimmed = {
      granularity: out.granularity,
      from: out.from,
      to: out.to,
      bookId: out.bookId,
      labels: out.labels.slice(start),
      series: [],
      totals: out.totals
    };
    for (var s = 0; s < out.series.length; s += 1) {
      trimmed.series.push({
        key: out.series[s].key,
        name: out.series[s].name,
        values: out.series[s].values.slice(start)
      });
    }
    return trimmed;
  }

  function trendLabelText(label, granularity) {
    if (granularity === 'month') { return shortMonth(label); }
    var parts = String(label || '').split('-');
    if (parts.length === 3) { return Number(parts[2]) + '日'; }
    return String(label || '');
  }

  function buildTrendCard(report) {
    var db = report.db;
    var month = S.month;
    var bookId = scopeOf(db).bookId;
    var card = el('section', { className: 'c-card s-stats-trend', 'aria-label': '收支趋势' });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '收支趋势' }));

    var modeWrap = el('div', { className: 'c-card__action s-stats-trend__modes' });
    [{ key: 'line', label: '折线' }, { key: 'bars', label: '柱状' }].forEach(function (mode) {
      var btn = el('button', {
        className: 's-stats-trend__btn' + (S.trend === mode.key ? ' is-active' : ''),
        type: 'button',
        text: mode.label,
        'aria-pressed': S.trend === mode.key ? 'true' : 'false'
      });
      btn.addEventListener('click', function () {
        if (S.trend === mode.key) { return; }
        S.trend = mode.key;
        repaint(false);
      });
      modeWrap.appendChild(btn);
    });
    head.appendChild(modeWrap);
    card.appendChild(head);

    var rangeSeg = el('div', { className: 'c-segmented s-stats-trend__seg', role: 'tablist', 'aria-label': '趋势范围' });
    [{ key: '12', label: '近 12 月' }, { key: 'mon', label: '本月按日' }].forEach(function (range) {
      var btn = el('button', {
        className: 'c-segmented__item' + (S.trendRange === range.key ? ' is-active' : ''),
        type: 'button',
        role: 'tab',
        text: range.label,
        'aria-selected': S.trendRange === range.key ? 'true' : 'false'
      });
      btn.addEventListener('click', function () {
        if (S.trendRange === range.key) { return; }
        S.trendRange = range.key;
        repaint(false);
      });
      rangeSeg.appendChild(btn);
    });
    card.appendChild(rangeSeg);

    var box = el('div', { className: 's-stats-trend__box' });
    box.setAttribute('aria-hidden', 'false');
    card.appendChild(box);

    var trend = trendData(db, month, bookId);
    var labels = trend.labels || [];
    var series = trend.series || [];
    var incomeValues = [];
    var expenseValues = [];
    for (var i = 0; i < series.length; i += 1) {
      var s = series[i] || {};
      if (s.key === 'income') { incomeValues = s.values || []; }
      if (s.key === 'expense') { expenseValues = s.values || []; }
    }

    var kindLabel = kindName();
    /* 图表要等 DOM 有宽度才画：paintCards  append 之后调 __paint */
    card.__paint = function () {
      if (!charts || typeof charts.line !== 'function') { return; }
      var width = box.clientWidth || 320;
      if (S.trend === 'bars') {
        var data = [];
        var source = S.kind === 'expense' ? expenseValues : incomeValues;
        for (var b = 0; b < labels.length; b += 1) {
          data.push({
            label: trendLabelText(labels[b], trend.granularity),
            value: Number(source[b]) || 0,
            color: S.kind === 'expense' ? '--c-tint' : '--c-text-2'
          });
        }
        charts.bars(box, data, {
          horizontal: false,
          width: width,
          height: 180,
          showValue: data.length <= 12,
          formatValue: function (cents) { return axisText(cents); },
          emptyText: '这段时间还没有数据',
          ariaLabel: monthLabel(month) + kindLabel + '柱状趋势，共 ' + data.length + ' 个时间点'
        });
        return;
      }
      var list = [
        { key: 'income', name: '收入', values: incomeValues, color: '--c-text-2' },
        { key: 'expense', name: '支出', values: expenseValues, color: '--c-tint' }
      ];
      var displayLabels = [];
      for (var t = 0; t < labels.length; t += 1) {
        displayLabels.push(trendLabelText(labels[t], trend.granularity));
      }
      charts.line(box, list, {
        labels: displayLabels,
        width: width,
        height: 180,
        showGrid: false,
        showDots: labels.length <= 12,
        formatY: function (cents) { return axisText(cents); },
        emptyText: '这段时间还没有数据',
        ariaLabel: monthLabel(month) + '收支折线趋势，共 ' + labels.length + ' 个时间点',
        /* 2.40.0：点某月＝切换统计月份（原柱图交互的延续）；按日粒度仍弹当日收支 */
        onPick: function (index) {
          var label = labels[index] || '';
          if (trend.granularity === 'month' && MONTH_RE.test(label)) {
            setMonth(label);
            return;
          }
          var income = Number(incomeValues[index]) || 0;
          var expense = Number(expenseValues[index]) || 0;
          toast(trendLabelText(label, trend.granularity) + ' · 支出 ' + fmt(expense) + ' · 收入 ' + fmt(income), { type: 'info' });
        }
      });
    };
    return card;
  }

  /* ---------------- 待报销横幅（原统计页移植） ---------------- */

  function buildReimburseCard(report) {
    var db = report.db;
    var month = S.month;
    var bookId = scopeOf(db).bookId;
    var list = Array.isArray(db.transactions) ? db.transactions : [];
    var totalCents = 0;
    var count = 0;
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (tx.reimburse !== 'pending') { continue; }
      if (bookId && tx.bookId !== bookId) { continue; }
      if (String(tx.date || '').slice(0, 7) !== month) { continue; }
      totalCents += Math.abs(Number(tx.amountCents) || 0);
      count += 1;
    }
    if (!count) { return null; }
    var card = el('a', {
      className: 's-stats-reimburse c-pressable',
      href: '#/ledger?flag=reimburse',
      'aria-label': '待报销 ' + count + ' 笔，共 ' + fmt(totalCents) + '，去明细处理'
    });
    card.appendChild(el('span', {
      className: 's-stats-reimburse__text u-tabular',
      text: '待报销 ' + count + ' 笔 · ' + fmt(totalCents)
    }));
    card.appendChild(el('span', { className: 's-stats-reimburse__go', text: '去处理 ›' }));
    return card;
  }
  /* ---------------- 结论 / 提示 / 建议 ---------------- */

  /* 2.25.0（合并 2.24.3 P0-1）情境入口：带着账期/分类跳进小助手。
   * 只预填问题，不自动执行；涉及写入的仍要走助手自己的预览确认。 */
  function assistantEntryOn() {
    var prefs = (S.ctx && S.ctx.prefs) || (XZB.app && XZB.app.prefs);
    var v = null;
    if (prefs && typeof prefs.get === 'function') {
      try { v = prefs.get('assistant.contextualEntry'); } catch (error) { v = null; }
    }
    return v !== false; /* 未设置 = 开 */
  }

  function assistantHash(report, opts) {
    var o = opts || {};
    var params = { from: 'stats', m: report.endMonth, r: report.range.key };
    if (o.cat) { params.cat = o.cat; }
    if (o.q) { params.q = String(o.q).slice(0, 60); }
    var bits = [];
    Object.keys(params).forEach(function (key) { bits.push(key + '=' + encodeURIComponent(params[key])); });
    return '#/assistant?' + bits.join('&');
  }

  function coreAskQuestion(report) {
    if (report.range.months > 1) {
      return '近' + report.range.months + '个月支出为什么变化？';
    }
    var delta = expenseDelta(report);
    if (!delta.hasPrev) { return monthLabel(report.endMonth) + '的支出结构是什么样的？'; }
    var base = report.isPartial ? '上月同期' : '上月';
    if (delta.diff < 0) { return '为什么' + monthLabel(report.endMonth) + '支出比' + base + '减少了？'; }
    return '为什么' + monthLabel(report.endMonth) + '支出比' + base + '增加了？';
  }

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
    if (assistantEntryOn()) {
      card.appendChild(el('div', { className: 's-insights-core__ask' }, [
        buttonNode('问为什么', {
          className: 's-insights-core__more',
          icon: 'sparkles',
          ariaLabel: '带当前账期问小助手为什么',
          href: assistantHash(report, { q: coreAskQuestion(report) })
        })
      ]));
    }
    return card;
  }

  function summaryCard(report) {
    var card = moduleCard('收支摘要', null, 's-insights-summary');
    var delta = expenseDelta(report);
    var net = report.win.netCents;
    var totals = report.win.totals;
    /* 2.32.8：收入只记了零头（覆盖支出 < 50%）时，结余为负和负储蓄率都是口径失真，
       不当作「支出高于收入」下结论，只说明“可能没记全”。 */
    var coveragePct = totals.expenseCents > 0 ? totals.incomeCents / totals.expenseCents * 100 : null;
    var incomePartial = totals.incomeCents > 0 && coveragePct !== null && coveragePct < 50;
    var hero = el('div', { className: 's-insights-sum__hero' });
    hero.appendChild(el('span', { className: 's-insights-sum__hero-label', text: '结余' }));
    hero.appendChild(el('strong', {
      className: 's-insights-sum__hero-value u-tabular' + (net < 0 ? ' is-neg' : ''),
      text: fmt(net)
    }));
    hero.appendChild(el('span', {
      className: 's-insights-sum__hero-sub',
      text: incomePartial ? '收入可能没记全' : (net < 0 ? '支出高于收入' : '收入减去支出')
    }));
    card.appendChild(hero);
    var grid = el('div', { className: 's-insights-sum__grid' });
    grid.appendChild(sumCell('收入', report.win.totals.incomeCents, 'income'));
    grid.appendChild(sumCell('支出', report.win.totals.expenseCents, 'expense'));
    var mom = el('div', { className: 's-insights-sum__cell' });
    mom.appendChild(el('span', {
      className: 's-insights-sum__label',
      text: report.range.months === 1
        ? (report.isPartial ? '支出较上月同期' : '支出环比')
        : '支出较上期'
    }));
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
    /* 2.40.0 合并：日均支出（原统计页摘要移植）；当月按已过天数，历史月按整月 */
    var now = currentMonth();
    var elapsed = 0;
    for (var dm = 0; dm < report.win.months.length; dm += 1) {
      var mKey = report.win.months[dm];
      elapsed += mKey === now ? Number(todayStr().slice(8, 10)) : daysInMonthOf(mKey);
    }
    var dailyAvg = elapsed > 0 ? Math.round(totals.expenseCents / elapsed) : 0;
    var avgCell = el('div', { className: 's-insights-sum__cell' });
    avgCell.appendChild(el('span', { className: 's-insights-sum__label', text: '日均支出' }));
    var avgValue = el('span', { className: 's-insights-sum__value u-tabular' });
    avgValue.appendChild(el('span', { className: 's-insights-sum__money', text: fmt(dailyAvg) }));
    avgCell.appendChild(avgValue);
    grid.appendChild(avgCell);
    card.appendChild(grid);

    if (totals.incomeCents > 0 && incomePartial) {
      card.appendChild(el('p', {
        className: 's-insights-muted',
        text: '收入只记到 ' + fmt(totals.incomeCents) + '\uff0c仅覆盖支出的 ' + coveragePct.toFixed(1) + '%，结余和储蓄率会失真。'
      }));
    } else if (totals.incomeCents > 0) {
      var rate = round1((totals.incomeCents - totals.expenseCents) / totals.incomeCents * 100);
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

  /* 每条提示的「继续分析」问题：模板固定，数字由助手按本地数据现算 */
  function tipAskQuestion(report, tip) {
    var catName = '';
    if (tip.categoryId && report.meta && report.meta[tip.categoryId]) {
      catName = String(report.meta[tip.categoryId].name || '');
    }
    if (tip.key === 'large') { return '这个期间最大的三笔支出是哪些？'; }
    if (tip.key === 'trend') { return '近' + RULES.HISTORY_MONTHS + '个月支出趋势怎么样？'; }
    if (!catName) { return ''; }
    if (tip.key.indexOf('anomaly:') === 0) { return catName + '为什么这么多？比前几个月多在哪？'; }
    if (tip.key.indexOf('growth:') === 0) { return catName + '是不是一直在涨？涨在哪？'; }
    if (tip.key.indexOf('struct:') === 0) { return catName + '比上期多在哪？'; }
    if (tip.key.indexOf('frequent:') === 0) { return catName + '的小额支出都花在哪了？'; }
    return '';
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
        if (assistantEntryOn()) {
          var q = tipAskQuestion(report, tip);
          if (q) {
            body.appendChild(buttonNode('继续分析', {
              className: 's-insights-tip__action',
              icon: 'sparkles',
              ariaLabel: '带上下文问小助手：' + q,
              href: assistantHash(report, { cat: tip.categoryId || '', q: q })
            }));
          }
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
    box.textContent = '解读由本地规则或你开启的在线模型生成，不修改原始账单；' +
      '统计范围为 ' + monthLabel(report.win.months[0]) + ' 至 ' + monthLabel(report.endMonth) + '。';
    return box;
  }

  /* ---------------- AI 月度解读（第 2 轮） ----------------
   * 聚合与请求都封装在 XZB.core.aiInsights（buildMonthlyMetrics / requestAiInsights /
   * buildFallbackInsights），本屏只负责：出卡片、防连点、缓存结果。
   * 缓存键 = 账本 id + '|' + 月份，跨 destroy 保留（防重复计费）；请求在途态跨重渲染保持。
   */

  function aiModule() {
    var core = XZB.core || null;
    return core && core.aiInsights && typeof core.aiInsights.buildMonthlyMetrics === 'function'
      ? core.aiInsights
      : null;
  }

  function aiLlm() {
    var core = XZB.core || null;
    return core && core.assistant && core.assistant.llm && typeof core.assistant.llm.getConfig === 'function'
      ? core.assistant.llm
      : null;
  }

  /* core-assistant 不在本屏 DEPS 里：首次用到时按需拉取，成功/失败都重渲染一次，
     让 aiCard 的常规分支（去设置 / 隐私告知 / 生成）接管。失败静默重渲染＝按钮回到可点态。 */
  function aiEnsureAssistant() {
    if (S.aiModuleLoading) { return; }
    var chunks = XZB.chunks || null;
    if (!chunks || typeof chunks.ensure !== 'function') { return; }
    S.aiModuleLoading = true;
    repaint(false);
    chunks.ensure('core-assistant').then(function () {
      S.aiModuleLoading = false;
      if (!S.dead) { repaint(false); }
    }, function () {
      S.aiModuleLoading = false;
      S.aiModuleError = true;
      if (!S.dead) { repaint(false); }
    });
  }

  /* ---------------- 解读报告（2.40.0） ----------------
   * 生命周期：生成解读 → 报告落档（XZB.app.reports，独立 key，不进备份）→ 按钮变「查看报告」
   * → 点按进入 #/report?id= 详情；「报告存档 ›」进 #/report 列表。
   * 每天本地 0 点刷新：render 时比对日期 + 一次性定时器到下个 0 点 + visibilitychange/focus 复核。
   * 同一天同月同账期唯一（覆盖）；AI 失败不落档、可重试；未配置模型＝纯本地报告。
   * 聚合与请求仍封装在 XZB.core.aiInsights；core-assistant 按需 ensure（不在本屏 DEPS）。
   */

  /* 账单变动指纹：笔数＋收支＋分类金额，任一变动即提示「生成后账单有变动」 */
  function localFp(report) {
    var t = report.win.totals;
    var parts = [String(t.count), String(t.incomeCents), String(t.expenseCents)];
    for (var i = 0; i < report.win.cats.length; i += 1) {
      parts.push(report.win.cats[i].id + ':' + report.win.cats[i].amountCents);
    }
    return parts.join('|');
  }

  function clockText(ms) {
    var d = new Date(Number(ms) || 0);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function ensureReportsLoaded() {
    if (S.reportsCache !== null || S.reportsLoading) { return; }
    var api = reportsApi();
    if (!api) { S.reportsCache = []; return; }
    S.reportsLoading = true;
    api.list().then(function (list) {
      S.reportsLoading = false;
      if (S.dead) { return; }
      S.reportsCache = Array.isArray(list) ? list : [];
      repaint(false);
    }, function () {
      S.reportsLoading = false;
      if (!S.dead) { S.reportsCache = []; repaint(false); }
    });
  }

  function findTodayReport() {
    var list = S.reportsCache || [];
    var today = todayStr();
    var hit = null;
    for (var i = 0; i < list.length; i += 1) {
      var r = list[i];
      if (r && r.generatedOn === today && r.month === S.month && r.rangeKey === S.range) {
        if (!hit || Number(r.generatedAt) > Number(hit.generatedAt)) { hit = r; }
      }
    }
    return hit;
  }

  function reportCacheKey(report) {
    return (scopeOf(report.db).bookId || '') + '|' + S.month + '|' + S.range;
  }

  function aiFailureText(reason) {
    if (reason === 'config') { return '模型配置或连接未就绪，本次未生成报告；可在设置中检查接口、模型和密钥，或先生成本地报告。'; }
    if (reason === 'timeout') { return '模型响应超时，本次未生成报告；可稍后重试。'; }
    if (reason === 'rate') { return '模型请求被限流，本次未生成报告；请稍后再试。'; }
    if (reason === 'empty') { return '本期没有可分析的收支记录。'; }
    return '模型请求或返回内容异常，本次未生成报告；可稍后重试。';
  }

  function reportCard(report) {
    if (!report) { return null; }
    var card = moduleCard('解读报告', monthLabel(S.month) + ' · ' + report.range.label, 's-insights-ai s-insights-report');
    var body = el('div', { className: 's-insights-ai__body' });

    /* 存档入口恒在：任何状态（含引导/加载/隐私告知）都能调取历史报告 */
    function archiveLink() {
      return el('a', {
        className: 's-insights-report__archive',
        href: '#/report',
        text: '报告存档 ›'
      });
    }

    /* 近 3/6 个月没有单月口径：只给引导，不生成 */
    if (report.range.key === '3m' || report.range.key === '6m') {
      body.appendChild(el('p', {
        className: 's-insights-ai__hint',
        text: '解读报告针对单月诊断，切到「本月」或「上月」生成。'
      }));
      body.appendChild(buttonNode('切到本月', {
        className: 's-insights-tip__action',
        icon: 'arrow-up',
        onClick: function () { setRange('month'); }
      }));
      card.appendChild(body);
      card.appendChild(archiveLink());
      return card;
    }

    if (S.aiModuleLoading) {
      body.appendChild(el('p', { className: 's-insights-ai__hint', 'aria-live': 'polite', text: '正在加载模型连接模块…' }));
      card.appendChild(body);
      card.appendChild(archiveLink());
      return card;
    }

    /* 隐私告知（首次 AI 生成前）：账单摘要会上传到用户自配接口 */
    if (S.privacyPending) {
      body.appendChild(el('p', {
        className: 's-insights-ai__hint',
        text: 'AI 解读会把本月收支摘要（总额、分类合计、预算概况）发送到你配置的模型接口，不含备注、商户与照片。'
      }));
      var ackBtn = el('button', { className: 'c-btn c-btn--primary s-insights-report__go', type: 'button', text: '知道了，生成' });
      ackBtn.addEventListener('click', function () {
        var llm = aiLlm();
        if (llm) { try { llm.setConfig({ noticeAt: Date.now() }); } catch (error) { /* 记不下也继续 */ } }
        S.privacyPending = false;
        beginGeneration(report);
      });
      body.appendChild(ackBtn);
      body.appendChild(buttonNode('先生成本地报告', {
        className: 's-insights-tip__action',
        icon: 'chart-line',
        onClick: function () { S.privacyPending = false; archiveLocalReport(report, null); }
      }));
      card.appendChild(body);
      card.appendChild(archiveLink());
      return card;
    }

    var busyKey = reportCacheKey(report);
    if (S.aiBusy && S.aiBusyMonth === busyKey) {
      body.appendChild(el('p', {
        className: 's-insights-ai__hint',
        'aria-live': 'polite',
        text: 'AI 正在生成解读，通常需要 10–30 秒，可先浏览其他卡片。'
      }));
      if (S.aiRetryHint) {
        body.appendChild(el('p', { className: 's-insights-ai__hint', 'aria-live': 'polite', text: S.aiRetryHint }));
      }
      card.appendChild(body);
      card.appendChild(archiveLink());
      return card;
    }

    ensureReportsLoaded();
    if (S.reportsCache === null) {
      body.appendChild(el('p', { className: 's-insights-ai__hint', 'aria-live': 'polite', text: '正在读取报告存档…' }));
      card.appendChild(body);
      card.appendChild(archiveLink());
      return card;
    }

    var rec = findTodayReport();
    if (rec) {
      var meta = '生成于 ' + clockText(rec.generatedAt) + ' · ' + (rec.source === 'ai' ? 'AI 解读' : '本地解读');
      if (rec.source === 'ai' && rec.model) { meta += ' · ' + rec.model; }
      body.appendChild(el('p', { className: 's-insights-ai__hint', text: meta }));
      if (rec.payload && rec.payload.fp && rec.payload.fp !== localFp(report)) {
        body.appendChild(el('p', { className: 's-insights-ai__hint', text: '生成后账单有变动，报告是生成时的快照，可重新生成。' }));
        body.appendChild(buttonNode('重新生成', {
          className: 's-insights-tip__action',
          icon: 'refresh',
          onClick: function () { startGeneration(report); }
        }));
      }
      var viewBtn = el('a', {
        className: 'c-btn c-btn--primary s-insights-report__go',
        href: '#/report?id=' + encodeURIComponent(rec.id),
        text: '查看报告'
      });
      body.appendChild(viewBtn);
    } else {
      var llm = aiLlm();
      var cfg = llm ? llm.getConfig() : null;
      var ready = !!(cfg && cfg.ok && cfg.cfg && cfg.cfg.ready);
      body.appendChild(el('p', {
        className: 's-insights-ai__hint',
        text: ready
          ? '生成完整解读报告并存档；当天再次点击直接查看，不重复请求模型。'
          : '未配置模型时生成纯本地报告，不调用网络、不上传账单；配置后可由 AI 润色。'
      }));
      if (S.reportError) {
        body.appendChild(el('p', { className: 's-insights-ai__hint is-red', 'aria-live': 'polite', text: S.reportError }));
      }
      var genBtn = el('button', {
        className: 'c-btn c-btn--primary s-insights-report__go',
        type: 'button',
        text: S.reportError ? '重试生成' : '生成解读'
      });
      genBtn.addEventListener('click', function () { startGeneration(report); });
      body.appendChild(genBtn);
      if (S.reportError && ready) {
        body.appendChild(buttonNode('先生成本地报告', {
          className: 's-insights-tip__action',
          icon: 'chart-line',
          onClick: function () { S.reportError = ''; archiveLocalReport(report, null); }
        }));
      }
      if (!ready) {
        body.appendChild(buttonNode('去设置配置模型', {
          className: 's-insights-tip__action',
          icon: 'settings',
          href: '#/settings/ai'
        }));
      }
    }
    card.appendChild(body);

    /* 存档入口：列表可调取历史报告 */
    card.appendChild(archiveLink());
    return card;
  }

  function startGeneration(report) {
    if (S.aiBusy || S.aiModuleLoading || S.privacyPending) { return; }
    S.reportError = '';
    var llm = aiLlm();
    if (!llm && !S.aiModuleError) {
      /* core-assistant 按需加载；失败也继续（走本地报告） */
      var chunks = XZB.chunks || null;
      if (chunks && typeof chunks.ensure === 'function') {
        S.aiModuleLoading = true;
        repaint(false);
        chunks.ensure('core-assistant').then(function () {
          S.aiModuleLoading = false;
          if (!S.dead) { beginGeneration(report); }
        }, function () {
          S.aiModuleLoading = false;
          S.aiModuleError = true;
          if (!S.dead) { beginGeneration(report); }
        });
        return;
      }
    }
    beginGeneration(report);
  }

  function beginGeneration(report) {
    if (S.dead || S.aiBusy) { return; }
    var ai = aiModule();
    var llm = aiLlm();
    var cfg = llm ? llm.getConfig() : null;
    cfg = cfg && cfg.ok ? cfg.cfg : null;
    var scope = scopeOf(report.db);
    var metrics = ai ? ai.buildMonthlyMetrics(report.db, S.month, scope.bookId) : null;
    var hasData = metrics && Number(metrics.dataQuality && metrics.dataQuality.txCount) > 0;
    if (!hasData) {
      S.reportError = '本期没有可分析的收支记录。';
      repaint(false);
      return;
    }
    var useAi = !!(cfg && cfg.ready);
    if (useAi && Number(cfg.noticeAt) <= 0) {
      S.privacyPending = true;
      repaint(false);
      return;
    }
    if (useAi) { requestAiForReport(report, metrics, cfg); return; }
    archiveLocalReport(report, metrics);
  }

  function requestAiForReport(report, metrics, cfg) {
    var ai = aiModule();
    S.aiBusy = true;
    S.aiBusyMonth = reportCacheKey(report);
    S.aiRetryHint = '';
    S.reportError = '';
    repaint(false);
    ai.requestAiInsights(metrics, {
      onRetry: function (info) {
        S.aiRetryHint = '模型接口波动，正在重试（' + info.attempt + '/' + info.maxRetry + '）…';
        if (!S.dead) { repaint(false); }
      }
    }).then(function (res) {
      settleReport(report, cfg, res);
    }, function () {
      settleReport(report, cfg, null);
    });
  }

  function settleReport(report, cfg, res) {
    S.aiBusy = false;
    S.aiBusyMonth = '';
    S.aiRetryHint = '';
    if (res && res.ok) {
      /* 即使已离屏也落档：请求已计费，报告不能丢；重绘由存档回调按 dead 跳过 */
      var payload = buildReportPayload(report);
      payload.ai = {
        summary: res.summary,
        items: res.items,
        source: 'ai',
        model: res.model || (cfg && cfg.model) || ''
      };
      archiveReport(report, payload, 'ai', payload.ai.model);
      return;
    }
    if (S.dead) { return; }
    var reason = res && res.reason ? res.reason : 'bad';
    /* 2.40.0：AI 失败不落档，可重试；本地报告随时可另生成 */
    S.reportError = aiFailureText(reason);
    repaint(false);
  }

  function archiveLocalReport(report, metrics) {
    var ai = aiModule();
    var m = metrics || (ai ? ai.buildMonthlyMetrics(report.db, S.month, scopeOf(report.db).bookId) : null);
    var payload = buildReportPayload(report);
    payload.ai = {
      summary: ai && m ? ai.buildLocalSummary(m) : '',
      items: ai && m ? ai.buildFallbackInsights(m) : [],
      source: 'local',
      model: ''
    };
    archiveReport(report, payload, 'local', '');
  }

  function archiveReport(report, payload, source, model) {
    var api = reportsApi();
    if (!api) {
      S.reportError = '报告存档不可用（存储未就绪）。';
      repaint(false);
      return;
    }
    var entry = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      month: S.month,
      rangeKey: S.range,
      generatedOn: todayStr(),
      generatedAt: Date.now(),
      source: source,
      model: model || '',
      payload: payload
    };
    api.save(entry).then(function (res) {
      if (S.dead) { return; }
      if (res && res.ok) {
        S.reportsCache = null;
        S.reportError = '';
        repaint(false);
      } else {
        S.reportError = '报告保存失败，可重试。';
        repaint(false);
      }
    }, function () {
      if (S.dead) { return; }
      S.reportError = '报告保存失败，可重试。';
      repaint(false);
    });
  }

  /* ---------------- 报告快照（纯数据，供详情页只读渲染） ---------------- */

  function trendSnapshot(report) {
    var trend = trendData(report.db, S.month, scopeOf(report.db).bookId);
    return {
      labels: trend.labels || [],
      granularity: trend.granularity,
      series: (trend.series || []).map(function (s) {
        return { key: s.key, name: s.name, values: s.values || [] };
      })
    };
  }

  function auditSnapshot(report) {
    var audit = Core.audit || null;
    if (!audit || typeof audit.run !== 'function') { return null; }
    var scope = scopeOf(report.db);
    var res = audit.run(report.db, { bookId: scope.bookId, today: todayStr() });
    if (!res || !res.ok) { return null; }
    return {
      score: res.score,
      grade: res.grade,
      fixedMonthlyCents: res.fixedMonthlyCents,
      recurring: (res.recurring || []).map(function (r) {
        return { name: r.name, amountCents: r.amountCents, count: r.count, cadenceLabel: r.cadenceLabel, stale: r.stale === true, nextDate: r.nextDate || '' };
      }),
      findings: (res.findings || []).map(function (f) {
        return { severity: f.severity, title: f.title, text: f.text, facts: f.facts || [] };
      })
    };
  }

  /* 行动建议序列化：onClick 类转成可深链的 href（分类钻取 / 账期切换），快照里不放函数 */
  function actionsPayload(report) {
    var out = [];
    for (var i = 0; i < report.actions.length; i += 1) {
      var a = report.actions[i];
      var href = a.href || '';
      if (!href && a.categoryId) {
        href = '#/stats?m=' + S.month + '&r=' + S.range + '&cat=' + encodeURIComponent(a.categoryId);
      } else if (!href && a.range) {
        href = '#/stats?r=' + a.range;
      }
      if (!href) { continue; }
      out.push({ icon: a.icon, label: a.label, href: href });
    }
    return out;
  }

  function buildReportPayload(report) {
    var totals = report.win.totals;
    var delta = expenseDelta(report);
    var now = currentMonth();
    var elapsed = 0;
    for (var dm = 0; dm < report.win.months.length; dm += 1) {
      var mKey = report.win.months[dm];
      elapsed += mKey === now ? Number(todayStr().slice(8, 10)) : daysInMonthOf(mKey);
    }
    var cats = report.win.cats.slice(0, RULES.LEGEND_TOP).map(function (c) {
      return { id: c.id, name: c.name, icon: c.icon, amountCents: c.amountCents, count: c.count, pct: c.pct, colorVar: c.colorVar };
    });
    if (report.win.cats.length > RULES.LEGEND_TOP) {
      var rest = { id: '__other', name: '其他', icon: 'box', amountCents: 0, count: 0, pct: 0, colorVar: '--c-text-3' };
      for (var rc = RULES.LEGEND_TOP; rc < report.win.cats.length; rc += 1) {
        rest.amountCents += report.win.cats[rc].amountCents;
        rest.count += report.win.cats[rc].count;
      }
      rest.pct = pctOf(rest.amountCents, totals.expenseCents);
      cats.push(rest);
    }
    return {
      month: S.month,
      rangeKey: S.range,
      rangeLabel: report.range.label,
      startMonth: report.win.months[0],
      endMonth: report.endMonth,
      isPartial: report.isPartial === true,
      periodDay: report.periodDay || 0,
      totals: { incomeCents: totals.incomeCents, expenseCents: totals.expenseCents, count: totals.count },
      netCents: report.win.netCents,
      dailyAvgCents: elapsed > 0 ? Math.round(totals.expenseCents / elapsed) : 0,
      mom: { hasPrev: delta.hasPrev, isNew: delta.isNew, pct: delta.pct, diff: delta.diff },
      core: report.core.map(function (c) { return { icon: c.icon, text: c.text, categoryId: c.categoryId || '' }; }),
      cats: cats,
      trend: trendSnapshot(report),
      tips: report.tips.map(function (t) {
        return {
          icon: t.icon, title: t.title, text: t.text, tone: t.tone || 'info', categoryId: t.categoryId || '',
          items: (t.items || []).map(function (it) {
            return { id: it.id, date: it.date, note: it.note, categoryName: it.categoryName, amountCents: it.amountCents, type: it.type || 'expense' };
          })
        };
      }),
      actions: actionsPayload(report),
      audit: auditSnapshot(report),
      fp: localFp(report)
    };
  }
  function emptyAll() {
    var card = el('div', { className: 'c-card s-insights-empty' });
    var empty = el('div', { className: 'c-empty' });
    var holder = el('span', { className: 'c-empty__icon' });
    holder.appendChild(iconNode('chart-line', 40));
    empty.appendChild(holder);
    empty.appendChild(el('p', { className: 'c-empty__title', text: '还没有账单' }));
    empty.appendChild(el('p', { className: 'c-empty__desc', text: '记几笔后，这里会自动生成收支结构、变化解读和 AI 建议。' }));
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
      text: monthLabel(S.month) + ' 没有任何收支。可以换一个账期，或先记一笔；有账单后这里会自动生成收支结构、变化解读和 AI 建议。'
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
    /* 2.40.0：类型切换后深链钻取按当前口径找分类（收入/支出各一份） */
    var list = kindCats(report);
    var cat = null;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === categoryId) { cat = list[i]; break; }
    }
    if (!cat) { return; }
    openCategorySheet(report, {
      id: cat.id,
      name: cat.name,
      icon: cat.icon,
      amountCents: cat.amountCents,
      count: cat.count,
      pct: pctOf(cat.amountCents, kindTotal(report)),
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
    var source = kindItems(report);
    for (var i = 0; i < source.length; i += 1) {
      if (source[i].categoryId === cat.id) { items.push(source[i]); }
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
        /* 2.40.0：收入项带 + 号与收入色（结构卡切到收入口径时钻取可见） */
        var isIncome = item.type === 'income';
        row.appendChild(el('span', {
          className: 's-insights-tx__amt u-tabular' + (isIncome ? ' s-insights-tx__amt--income' : ''),
          text: (isIncome ? '+' : '\u2212') + fmt(item.amountCents)
        }));
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

  /* ---------------- 账单体检（2.39.0） ----------------
   * 算法全在 XZB.core.audit（已进本屏 DEPS，渲染时必已加载）；这里只做取数与展示。
   * 范围是整个账本、全部历史，不随上方账期 chip 变化；结论只陈述事实，不做评判。
   * 复用「值得留意」的行样式与流水清单，不新增 CSS。 */
  var AUDIT_ICONS = { high: 'flag', mid: 'info', low: 'search' };

  function openAuditRows(report, title, rows) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var body = sheetBodyShell();
    body.appendChild(txList(report, rows, function () {
      /* 从流水详情返回时重开本清单（与分类明细同一约定） */
      var next = buildReport(S.ctx);
      if (next && !next.failed) { openAuditRows(next, title, rows); }
    }));
    sheet.open({ title: title, content: body, actions: [{ label: '关闭', kind: 'text' }] });
  }

  function auditCard(report) {
    try {
      var mod = Core.audit;
      if (!mod || typeof mod.run !== 'function') { return null; }
      var audit = mod.run({
        transactions: report.db && Array.isArray(report.db.transactions) ? report.db.transactions : [],
        scope: report.model ? report.model.scope : {},
        today: todayStr()
      });
      if (!audit || audit.ok !== true) { return null; }

      var card = moduleCard('账单体检',
        '整个账本 · 全部历史' + (audit.window ? '，最后一笔 ' + dateLabel(audit.window.to) : '') + ' · 只在本机计算',
        's-insights-audit');
      var list = el('ul', { className: 's-insights-tip__list' });

      function row(options) {
        var item = el('li', { className: 's-insights-tip' + (options.warn ? ' is-warn' : '') });
        var chip = el('span', { className: 's-insights-tip__icon', 'aria-hidden': 'true' });
        chip.appendChild(iconNode(options.icon, 18));
        item.appendChild(chip);
        var body = el('div', { className: 's-insights-tip__body' });
        body.appendChild(el('p', { className: 's-insights-tip__title', text: options.title }));
        body.appendChild(el('p', { className: 's-insights-tip__text', text: options.text }));
        if (options.facts && options.facts.length) {
          var facts = el('ul', { className: 's-insights-tip__facts' });
          for (var i = 0; i < options.facts.length; i += 1) { facts.appendChild(el('li', { text: options.facts[i] })); }
          body.appendChild(facts);
        }
        if (options.rows && options.rows.length) {
          var title = options.sheetTitle || ('账单体检 · ' + options.title);
          var rows = options.rows;
          body.appendChild(buttonNode('看这 ' + rows.length + ' 笔', {
            className: 's-insights-tip__action',
            icon: 'list',
            onClick: function () { openAuditRows(report, title, rows); }
          }));
        }
        item.appendChild(body);
        list.appendChild(item);
      }

      /* 1) 体检分 + 每月固定开销 */
      var active = 0;
      var i;
      for (i = 0; i < audit.recurring.length; i += 1) { if (!audit.recurring[i].stale) { active += 1; } }
      var fixed = audit.fixedMonthlyCents > 0;
      var summaryFacts = [];
      for (i = 0; i < audit.recurring.length && i < 4; i += 1) {
        var s = audit.recurring[i];
        summaryFacts.push(s.cadenceLabel + ' · ' + (s.categoryName || s.note || '未分类') + ' ' + fmt(s.amountCents) + ' · 已记 ' + s.count + ' 次' + (s.stale ? '（可能已停）' : ''));
      }
      if (audit.recurring.length > 4) { summaryFacts.push('另有 ' + (audit.recurring.length - 4) + ' 项'); }
      row({
        icon: 'shield',
        warn: audit.score < 70,
        title: '体检 ' + audit.score + ' 分 · ' + audit.grade,
        text: '共 ' + (audit.counts.expense + audit.counts.income) + ' 笔记录。' + (fixed
          ? '每月固定开销约 ' + fmt(audit.fixedMonthlyCents) + '（' + active + ' 项，按周/年出现的已折算成每月）。'
          : (audit.recurring.length ? '识别到的规律开销预计日都已过，可能停了，未计入固定开销。' : '暂时没有识别到按规律出现的固定开销。')),
        facts: summaryFacts
      });

      /* 2) 每条固定开销：可点开看全部期数 */
      for (i = 0; i < audit.recurring.length && i < 3; i += 1) {
        (function (series) {
          row({
            icon: 'repeat',
            title: series.cadenceLabel + ' · ' + (series.categoryName || series.note || '未分类') + ' ' + fmt(series.amountCents),
            text: '已记 ' + series.count + ' 次，' + dateLabel(series.firstDate) + ' ~ ' + dateLabel(series.lastDate) + '。' +
              (series.stale ? '预计日已过还没记，可能已经停了。' : '下次预计 ' + dateLabel(series.nextDate) + '。'),
            sheetTitle: '固定开销明细',
            rows: series.rows
          });
        }(audit.recurring[i]));
      }

      /* 3) 发现：高 → 中 → 弱 */
      for (i = 0; i < audit.findings.length && i < 5; i += 1) {
        (function (finding) {
          row({
            icon: AUDIT_ICONS[finding.severity] || 'info',
            warn: finding.severity === 'high',
            title: finding.title,
            text: finding.text,
            facts: finding.facts,
            rows: finding.rows
          });
        }(audit.findings[i]));
      }

      if (!audit.findings.length && !audit.recurring.length) {
        row({ icon: 'check-circle', title: '没有发现问题', text: '没发现重复、断档或明显异常的记录。' });
      }

      card.appendChild(list);
      return card;
    } catch (error) {
      return null; /* 体检只是附加信息，任何异常都不该拖垮整页 */
    }
  }

  /* ---------------- 渲染主流程 ---------------- */

  function paintCards(report) {
    S.contentEl.appendChild(coreCard(report));
    S.contentEl.appendChild(summaryCard(report));
    var reimburse = buildReimburseCard(report);
    if (reimburse) { S.contentEl.appendChild(reimburse); }
    S.contentEl.appendChild(structureCard(report));
    var trendNode = buildTrendCard(report);
    S.contentEl.appendChild(trendNode);
    var reportNode = reportCard(report);
    if (reportNode) { S.contentEl.appendChild(reportNode); }
    if (report.tips.length) { S.contentEl.appendChild(tipsCard(report)); }
    var auditNode = auditCard(report);
    if (auditNode) { S.contentEl.appendChild(auditNode); }
    if (report.actions.length) { S.contentEl.appendChild(actionsCard(report)); }
    S.contentEl.appendChild(footNote(report));
    /* 折线/柱状要等 DOM 有宽度才画：append 之后补一次延迟绘制 */
    if (trendNode && typeof trendNode.__paint === 'function') { trendNode.__paint(); }
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
    var hash = '#/stats?m=' + S.month + '&r=' + S.range;
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
    if (month < MONTH_MIN || month > currentMonth()) { return; }
    if (month === S.month && S.range === 'month') { return; }
    S.month = month;
    S.range = 'month';
    syncHash();
    updatePeriod(null);
    repaint(false);
  }

  /* 2.40.0 合并：月份箭头（原统计页移植；柱图删除后这是翻月入口之一） */
  function hasPrevMonth() { return isMonth(S.month) && addMonth(S.month, -1) >= MONTH_MIN; }
  function hasNextMonth() { return isMonth(S.month) && S.month < currentMonth(); }
  function shiftMonth(delta) {
    if (!isMonth(S.month)) { return; }
    var next = addMonth(S.month, delta);
    if (next < MONTH_MIN || next > currentMonth()) { return; }
    setMonth(next);
  }

  function applyParams(ctx) {
    var query = (ctx && ctx.query) || {};
    /* cat/regen 也参与签名：否则同账期再点分类深链 / 报告详情「重新生成」会被旧 lastSig 吞掉 */
    var sig = String(query.m || '') + '|' + String(query.r || '') + '|' + String(query.cat || '') + '|' + String(query.regen || '');
    if (sig !== S.lastSig) {
      S.lastSig = sig;
      if (isMonth(query.m) && query.m <= currentMonth()) { S.month = query.m; }
      if (RANGE_BY_KEY[query.r]) { S.range = query.r; }
      if (query.cat) { S.pendingCat = String(query.cat); }
      if (query.regen === '1') { S.regenPending = true; }
    }
    if (!isMonth(S.month) || S.month > currentMonth()) { S.month = currentMonth(); }
    if (!RANGE_BY_KEY[S.range]) { S.range = 'month'; }
    /* 上月/近 3/6 个月恒以当前月为锚点，地址里的 m 只是写回用的快照；本月才认 m（供趋势点月与深链） */
    if (S.range === 'prev') { S.month = addMonth(currentMonth(), -1); }
    else if (S.range !== 'month') { S.month = currentMonth(); }
  }

  /* 每日 0 点刷新（2.40.0）：日期比对＋一次性定时器到下个本地 0 点＋回前台复核 */
  function onWake() {
    if (S.dead) { return; }
    var t = todayStr();
    if (t !== S.todayCache) {
      S.todayCache = t;
      S.reportsCache = null;
      repaint(false);
    }
  }

  function scheduleMidnight() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 500);
    var ms = Math.max(1000, next.getTime() - now.getTime());
    later(function () {
      if (S.dead) { return; }
      S.todayCache = todayStr();
      S.reportsCache = null;
      repaint(false);
      scheduleMidnight();
    }, ms);
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

    S.todayCache = todayStr();
    scheduleMidnight();
    document.addEventListener('visibilitychange', onWake);
    global.addEventListener('focus', onWake);

    if (S.pendingCat) {
      var categoryId = S.pendingCat;
      S.pendingCat = '';
      later(function () {
        var report = buildReport(S.ctx);
        if (report && !report.failed) { openCategoryById(report, categoryId); }
      }, 120);
    }
    /* 报告详情「重新生成」深链：落页后自动走一次生成（覆盖当天同账期记录） */
    if (S.regenPending) {
      S.regenPending = false;
      later(function () {
        var report = buildReport(S.ctx);
        if (report && !report.failed && report.win.totals.count > 0) { startGeneration(report); }
      }, 200);
    }
    /* 路由只采纳 render 返回对象上的 destroy；屏幕对象上的 destroy 不会被调用。 */
    return { destroy: destroy };
  }

  function destroy() {
    S.dead = true;
    if (S.timer) { global.clearTimeout(S.timer); S.timer = 0; }
    clearLater();
    document.removeEventListener('visibilitychange', onWake);
    global.removeEventListener('focus', onWake);
    S.root = null;
    S.ctx = null;
    S.contentEl = null;
    S.periodEl = null;
    S.resetEl = null;
    S.sheetRestore = null;
    S.privacyPending = false;
  }

  var screen = {
    title: '统计',
    subtitle: '月度分析',
    render: render,
    destroy: destroy
  };

  XZB.screens.register('stats', screen);
}(window));