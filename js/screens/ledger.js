/* 小账本 2.0 · js/screens/ledger.js · owner: 前端#2（T10 明细）
 * 契约锚点：UI.md §6.3（:840-905 线框与逐项规格）、SPEC A1/A2/A13/A17/A20/A22、
 *           INTERFACE-FREEZE §1（token）§3（类名 s-ledger-*）§8（十二条红线）、DECISIONS D06/D16。
 *
 * 形状：一级 Tab #/ledger（root 已是 .app-screen__body.s-ledger，已清空；
 *       .app-screen 是滚动容器，.app-nav 已 position:sticky 在顶部）。
 * 能力：
 *   1. 月份切换：左右箭头 ±1 月；点月份标签开「选择月份」浮层（年份 ±，12 宫格）。
 *   2. 账本切换入口 → #/books；标题展示当前账本名。
 *   3. 搜索：备注 / 分类名 / 账户名 / 金额（¥32.40、32.40、3240 都能命中），120ms 防抖，输入即筛。
 *   4. 筛选抽屉（XZB.ui.sheet）：类型 / 账户多选 / 分类多选 / 金额区间 / 清空。
 *   5. 月 → 日分组：日期头「今天 周三」+ 当日小结（支出/收入/转账）；日期头 sticky 在工具栏下方。
 *   6. 分页 50 条 + 触底自动加载，DocumentFragment 批量插入，不做全量重建。
 *   7. 左滑出「编辑 / 删除」（pointer 事件），长按同样出操作表；删除=软删 + 5 秒撤销 toast（XZB.app.undo）。
 *   8. 顶部汇总条：本期支出 / 收入 / 结余 / 笔数（随筛选实时变化）。
 *   9. 空状态与无结果文案分开；筛选条件回写 nav 标题（「餐饮 · 微信 · 本月」）。
 *
 * 硬约束：不碰 IndexedDB / localStorage / TabBar；用户数据一律 textContent；
 *        金额只用整数分；日期只用本地 YYYY-MM-DD 字符串；类名只 s-ledger-*。
 */
(function (global) {
  'use strict';

  var XZB = (global.XZB = global.XZB || {});
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] ledger 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var Core = XZB.core || XZB.Core || {};
  var dates = Core.dates || null;
  var money = Core.money || null;
  var schema = Core.schema || null;
  var storeCore = Core.store || null;

  /* ---------------- 常量 ---------------- */

  var PAGE_SIZE = 50;          /* 任务书：分页 50 条 + 触底加载 */
  var MAX_AUTO_ROWS = 400;     /* 触底自动加载上限：超过后只允许用户手动继续，避免 DOM 无限增长 */
  var SEARCH_DEBOUNCE = 120;   /* UI.md：输入 120ms 防抖 */
  var LONG_PRESS_MS = 520;
  var SWIPE_OPEN = -96;        /* 左滑露出的操作区宽度（两个 48px 按钮） */
  var SWIPE_SLOP = 8;
  var LOAD_AHEAD = 320;
  var TYPE_KEYS = ['all', 'expense', 'income', 'transfer'];
  var TYPE_LABEL = { all: '全部', expense: '支出', income: '收入', transfer: '转账' };
  var TITLE_MAX = 24;
  var ICON_ALIAS = {
    game: 'fun',
    housing: 'house',
    utilities: 'bolt',
    dining: 'food',
    entertainment: 'fun',
    education: 'book',
    medical: 'health',
    comm: 'phone'
  };

  /* ---------------- 依赖取用（缺件不白屏） ---------------- */

  function uiApi() { return XZB.ui || XZB.UI || {}; }
  function domApi() { return uiApi().dom || null; }
  function iconsApi() { return uiApi().icons || null; }
  function toastApi() { return uiApi().toast || null; }
  function sheetApi() { return uiApi().sheet || null; }
  function appApi() { return XZB.app || XZB.App || null; }

  function messageOf(code, fallback) {
    var table = storeCore && storeCore.MESSAGES ? storeCore.MESSAGES : null;
    if (table && code && table[code]) { return table[code]; }
    if (fallback) { return String(fallback); }
    return '操作失败，请重试';
  }

  /* ---------------- 极简 DOM 构造（复用 XZB.ui.dom） ---------------- */

  function appendAll(node, kids) {
    if (kids === undefined || kids === null || kids === false) { return node; }
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i += 1) { appendAll(node, kids[i]); }
      return node;
    }
    if (kids && typeof kids.nodeType === 'number') {
      node.appendChild(kids);
      return node;
    }
    node.appendChild(document.createTextNode(String(kids)));
    return node;
  }

  function el(tag, attrs, kids) {
    var d = domApi();
    if (d && typeof d.el === 'function') { return d.el(tag, attrs, kids); }

    var node = document.createElement(String(tag || 'div'));
    var options = attrs && typeof attrs === 'object' ? attrs : {};
    var className = options.className || options['class'];
    if (className) { node.className = String(className); }
    Object.keys(options).forEach(function (key) {
      if (key === 'className' || key === 'class' || key === 'text' || key === 'children') { return; }
      if (key === 'aria' && options.aria && typeof options.aria === 'object') {
        Object.keys(options.aria).forEach(function (name) {
          var value = options.aria[name];
          if (value === undefined || value === null || value === false) { return; }
          node.setAttribute('aria-' + name, value === true ? 'true' : String(value));
        });
        return;
      }
      if (key === 'dataset' && options.dataset && typeof options.dataset === 'object') {
        Object.keys(options.dataset).forEach(function (name) {
          var value = options.dataset[name];
          if (value === undefined || value === null) { return; }
          node.setAttribute('data-' + name, String(value));
        });
        return;
      }
      var value = options[key];
      if (value === undefined || value === null || value === false) { return; }
      node.setAttribute(key, value === true ? '' : String(value));
    });
    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }
    appendAll(node, kids !== undefined && kids !== null ? kids : options.children);
    return node;
  }

  function frag(kids) {
    var d = domApi();
    if (d && typeof d.frag === 'function') { return d.frag(kids); }
    var fragment = document.createDocumentFragment();
    appendAll(fragment, kids);
    return fragment;
  }

  function clearNode(node) {
    if (!node) { return; }
    var d = domApi();
    if (d && typeof d.clear === 'function') { d.clear(node); return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  /* icons.icon() 的标记缺 xmlns：DOMParser 以 image/svg+xml 解析会得到空命名空间
     元素，浏览器不描边（图标空白）。这里补 xmlns 后再解析并导入为真 SVG 节点。 */
  function svgFromMarkup(markup) {
    var text = String(markup || '');
    if (!text) { return null; }
    if (text.indexOf('xmlns=') < 0) {
      text = text.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    var DP = global.DOMParser;
    if (!DP || !document.importNode) { return null; }
    try {
      var doc = new DP().parseFromString(text, 'image/svg+xml');
      var root = doc && doc.documentElement;
      if (!root || String(root.nodeName).toLowerCase() !== 'svg') { return null; }
      if (!root.namespaceURI) { return null; }
      return document.importNode(root, true);
    } catch (error) {
      return null;
    }
  }

  function iconNode(name, size) {
    var icons = iconsApi();
    var key = ICON_ALIAS[name] || name || 'ellipsis';
    var px = Number(size) || 20;
    if (icons && typeof icons.icon === 'function') {
      var built = svgFromMarkup(icons.icon(key, { size: px }));
      if (built) { return built; }
    }
    if (icons && typeof icons.node === 'function') {
      var node = icons.node(key, { size: px });
      if (node) { return node; }
    }
    return el('span', { className: 's-ledger-glyph', text: String(name || '·').slice(0, 1) });
  }

  function toast(message, options) {
    var t = toastApi();
    if (t && typeof t.show === 'function') { t.show(String(message), options || {}); }
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i += 1) {
      var source = arguments[i];
      if (!source) { continue; }
      var keys = Object.keys(source);
      for (var k = 0; k < keys.length; k += 1) { target[keys[k]] = source[keys[k]]; }
    }
    return target;
  }

  /* ---------------- 日期 / 金额 ---------------- */

  function today() {
    if (dates && typeof dates.todayStr === 'function') { return dates.todayStr(); }
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function monthOf(dayStr) {
    var text = String(dayStr || '');
    return text.length >= 7 ? text.slice(0, 7) : today().slice(0, 7);
  }

  function isValidMonth(text) {
    if (dates && typeof dates.isValidMonthStr === 'function') { return dates.isValidMonthStr(text); }
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(text || ''));
  }

  function monthLabel(month) {
    var parts = String(month || '').split('-');
    if (parts.length !== 2) { return String(month || ''); }
    return parts[0] + '年' + Number(parts[1]) + '月';
  }

  function shiftMonth(month, delta) {
    var parts = String(month || '').split('-');
    var year = Number(parts[0]);
    var mon = Number(parts[1]);
    if (!isFinite(year) || !isFinite(mon)) { return monthOf(today()); }
    var total = year * 12 + (mon - 1) + Number(delta);
    var nextYear = Math.floor(total / 12);
    var nextMon = total - nextYear * 12 + 1;
    return nextYear + '-' + pad2(nextMon);
  }

  function dayLabel(dayStr) {
    var human = dates && typeof dates.formatHuman === 'function'
      ? dates.formatHuman(dayStr)
      : String(dayStr || '');
    var week = dates && typeof dates.weekdayCN === 'function' ? dates.weekdayCN(dayStr) : '';
    if (!human) { human = String(dayStr || ''); }
    return week ? human + ' ' + week : human;
  }

  function centsText(cents, withSymbol) {
    var n = Math.round(Number(cents) || 0);
    var neg = n < 0 ? '-' : '';
    n = Math.abs(n);
    var yuan = Math.floor(n / 100);
    var frac = n % 100;
    return neg + (withSymbol ? '¥' : '') + String(yuan) + '.' +
      (frac < 10 ? '0' : '') + String(frac);
  }

  function fmt(cents) {
    if (money && typeof money.formatCents === 'function') { return money.formatCents(cents); }
    return centsText(cents, true);
  }

  function parseYuan(text) {
    var raw = String(text === null || text === undefined ? '' : text).trim();
    if (!raw) { return null; }
    raw = raw.replace(/\u00a5/g, '').replace(/,/g, '').trim();
    if (!raw) { return null; }
    if (money && typeof money.parseToCents === 'function') {
      var result = money.parseToCents(raw, { allowNegative: false });
      if (result && result.ok) { return result.cents; }
      return null;
    }
    var num = Number(raw);
    return isFinite(num) ? Math.round(num * 100) : null;
  }

  /* ---------------- 数据 ---------------- */

  function readDb(ctx) {
    if (ctx && ctx.db) { return ctx.db; }
    var app = appApi();
    if (app && typeof app.db === 'function') {
      try {
        var result = app.db();
        if (result) { return result; }
      } catch (error) { /* 忽略 */ }
    }
    if (app && app.state && app.state.db) { return app.state.db; }
    return {};
  }

  function rows(db, key) {
    var value = db ? db[key] : null;
    return Array.isArray(value) ? value : [];
  }

  function indexById(list) {
    var map = {};
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (item && item.id) { map[item.id] = item; }
    }
    return map;
  }

  function activeBookId(db) {
    var app = appApi();
    var id = '';
    if (app && app.state && app.state.ui && app.state.ui.activeBookId) {
      id = String(app.state.ui.activeBookId);
    }
    if (!id) {
      var settings = db && db.settings ? db.settings : null;
      if (settings && settings.activeBookId) { id = String(settings.activeBookId); }
      else if (settings && settings.currentBookId) { id = String(settings.currentBookId); }
    }
    if (id) { return id; }
    var books = rows(db, 'books');
    for (var i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].archived !== true && !books[i].deleted) { return String(books[i].id); }
    }
    return books.length && books[0] && books[0].id ? String(books[0].id) : '';
  }

  function bookNameOf(db, bookId) {
    var books = rows(db, 'books');
    for (var i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].id === bookId) { return String(books[i].name || '当前账本'); }
    }
    return '当前账本';
  }

  function compareTx(a, b) {
    if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
    var at = String(a.time || '');
    var bt = String(b.time || '');
    if (at !== bt) { return at < bt ? 1 : -1; }
    var ac = String(a.createdAt || '');
    var bc = String(b.createdAt || '');
    if (ac !== bc) { return ac < bc ? 1 : -1; }
    return 0;
  }

  function collectAll(db, bookId) {
    var source = rows(db, 'transactions');
    var out = [];
    for (var i = 0; i < source.length; i += 1) {
      var tx = source[i];
      if (!tx || tx.deleted === true) { continue; }
      if (bookId && tx.bookId && tx.bookId !== bookId) { continue; }
      out.push(tx);
    }
    out.sort(compareTx);
    return out;
  }

  function categoryName(tx, maps) {
    if (!tx) { return '未分类'; }
    if (tx.type === 'transfer') { return '转账'; }
    var cat = maps.categories[tx.categoryId];
    return cat && cat.name ? String(cat.name) : '未分类';
  }

  function accountName(account) {
    return account && account.name ? String(account.name) : '账户';
  }

  function searchText(tx, maps) {
    var cents = Math.abs(Number(tx.amountCents) || 0);
    var catName = categoryName(tx, maps);
    var from = accountName(maps.accounts[tx.accountId]);
    var to = tx.toAccountId ? accountName(maps.accounts[tx.toAccountId]) : '';
    var parts = [
      catName,
      String(tx.note || ''),
      from,
      to,
      fmt(cents),
      centsText(cents, false),
      String(cents),
      String(tx.date || '')
    ];
    return parts.join(' ').toLowerCase().replace(/\s+/g, ' ');
  }

  function matchQuery(tx, query, maps) {
    if (!query) { return true; }
    var needle = String(query).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!needle) { return true; }
    var hay = searchText(tx, maps);
    if (hay.indexOf(needle) >= 0) { return true; }
    var bare = needle.replace(/^\u00a5/, '');
    return bare !== needle && hay.indexOf(bare) >= 0;
  }

  function applyFilters(st) {
    var out = [];
    var list = st.all;
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (st.month && String(tx.date || '').slice(0, 7) !== st.month) { continue; }
      if (st.type !== 'all' && tx.type !== st.type) { continue; }
      if (st.accountIds.length) {
        var accountHit = st.accountIds.indexOf(tx.accountId) >= 0 ||
          (tx.toAccountId && st.accountIds.indexOf(tx.toAccountId) >= 0);
        if (!accountHit) { continue; }
      }
      if (st.categoryIds.length && st.categoryIds.indexOf(tx.categoryId) < 0) { continue; }
      if (st.reimburseOnly && tx.reimburse !== 'pending') { continue; }
      if (st.day && tx.date !== st.day) { continue; }
      var cents = Math.abs(Number(tx.amountCents) || 0);
      if (st.minCents !== null && cents < st.minCents) { continue; }
      if (st.maxCents !== null && cents > st.maxCents) { continue; }
      if (!matchQuery(tx, st.query, st.maps)) { continue; }
      out.push(tx);
    }
    return out;
  }

  function totalsOf(list) {
    var expense = 0;
    var income = 0;
    var transfer = 0;
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      var cents = Math.abs(Number(tx.amountCents) || 0);
      if (tx.type === 'income') { income += cents; }
      else if (tx.type === 'transfer') { transfer += cents; }
      else { expense += cents; }
    }
    return {
      expense: expense,
      income: income,
      transfer: transfer,
      net: income - expense,
      count: list.length
    };
  }

  function dayTotalsOf(list) {
    var map = {};
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      var date = String(tx.date || '');
      if (!map[date]) { map[date] = { expense: 0, income: 0, transfer: 0 }; }
      var cents = Math.abs(Number(tx.amountCents) || 0);
      if (tx.type === 'income') { map[date].income += cents; }
      else if (tx.type === 'transfer') { map[date].transfer += cents; }
      else { map[date].expense += cents; }
    }
    return map;
  }

  function hasFilters(st) {
    return st.reimburseOnly === true || !!st.day || st.type !== 'all' ||
      st.accountIds.length > 0 ||
      st.categoryIds.length > 0 ||
      st.minCents !== null ||
      st.maxCents !== null ||
      !!st.query;
  }

  function filterCount(st) {
    var count = 0;
    if (st.reimburseOnly) { count += 1; }
    if (st.day) { count += 1; }
    if (st.type !== 'all') { count += 1; }
    if (st.accountIds.length) { count += 1; }
    if (st.categoryIds.length) { count += 1; }
    if (st.minCents !== null || st.maxCents !== null) { count += 1; }
    return count;
  }

  /* ---------------- 状态 ---------------- */

  var persisted = null;   /* 跨 rerender 保留月份与筛选（commit 后 app 会整屏重建） */
  var live = null;        /* 当前屏状态（用于清理上一屏监听） */
  var cleanups = [];

  function runCleanups() {
    while (cleanups.length) {
      var fn = cleanups.pop();
      try { fn(); } catch (error) { /* 忽略 */ }
    }
  }

  function savePersisted(st) {
    persisted = {
      bookId: st.bookId,
      month: st.month,
      query: st.query,
      type: st.type,
      accountIds: st.accountIds.slice(0),
      categoryIds: st.categoryIds.slice(0),
      minCents: st.minCents,
      maxCents: st.maxCents,
      reimburseOnly: st.reimburseOnly === true
    };
  }

  function createState(root, ctx) {
    var db = readDb(ctx);
    var bookId = activeBookId(db);
    var nowToday = today();
    var defaults = {
      month: monthOf(nowToday),
      query: '',
      type: 'all',
      accountIds: [],
      categoryIds: [],
      minCents: null,
      maxCents: null,
      reimburseOnly: false,
      day: ''
    };
    var seed = defaults;
    if (persisted && persisted.bookId === bookId) {
      seed = {
        month: isValidMonth(persisted.month) ? persisted.month : defaults.month,
        query: String(persisted.query || ''),
        type: TYPE_KEYS.indexOf(persisted.type) >= 0 ? persisted.type : 'all',
        accountIds: Array.isArray(persisted.accountIds) ? persisted.accountIds.slice(0) : [],
        categoryIds: Array.isArray(persisted.categoryIds) ? persisted.categoryIds.slice(0) : [],
        minCents: typeof persisted.minCents === 'number' ? persisted.minCents : null,
        maxCents: typeof persisted.maxCents === 'number' ? persisted.maxCents : null,
        reimburseOnly: persisted.reimburseOnly === true
      };
    }
    var urlMonth = ctx && ctx.query ? String(ctx.query.month || '') : '';
    if (!isValidMonth(urlMonth) && ctx && ctx.params) { urlMonth = String(ctx.params.month || ''); }
    /* 统计页的「待报销」卡直接带 flag 过来，落地就筛好 */
    var urlFlag = ctx && ctx.query ? String(ctx.query.flag || '') : '';
    if (!urlFlag && ctx && ctx.params) { urlFlag = String(ctx.params.flag || ''); }
    /* 统计热力图带日期过来：只看当天（N4） */
    var urlDate = ctx && ctx.query ? String(ctx.query.date || '') : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(urlDate) && ctx && ctx.params) {
      urlDate = String(ctx.params.date || '');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(urlDate)) { urlDate = ''; }
    /* 带日期进来时，月份跟着日期走（N4：热力图 → 明细） */
    if (urlDate && !isValidMonth(urlMonth)) { urlMonth = urlDate.slice(0, 7); }

    var st = {
      root: root,
      ctx: ctx || {},
      db: db,
      bookId: bookId,
      bookName: bookNameOf(db, bookId),
      month: isValidMonth(urlMonth) ? urlMonth : seed.month,
      query: seed.query,
      type: seed.type,
      accountIds: seed.accountIds,
      categoryIds: seed.categoryIds,
      minCents: seed.minCents,
      maxCents: seed.maxCents,
      reimburseOnly: seed.reimburseOnly === true || urlFlag === 'reimburse',
      day: urlDate,
      today: nowToday,
      all: [],
      filtered: [],
      maps: { categories: {}, accounts: {} },
      dayTotals: {},
      page: 1,
      rendered: 0,
      stickTop: 0,
      openItem: null,
      dead: false,
      nodes: {},
      cleanups: []
    };
    return st;
  }

  /* ---------------- 结构 ---------------- */

  function iconButton(className, iconName, label) {
    var btn = el('button', { className: className, type: 'button', 'aria-label': label }, [iconNode(iconName, 18)]);
    btn.title = label;
    return btn;
  }

  function buildHeader(st) {
    var bar = el('div', { className: 's-ledger-bar' });

    /* --- 第一行：月份 ⌄ + 右侧收支灰字（点击进统计页）--- */
    var sticky = el('div', { className: 's-ledger-sticky' });

    var row = el('div', { className: 's-ledger-monthrow' });
    var monthBtn = el('button', {
      className: 's-ledger-month',
      type: 'button',
      'aria-label': '选择月份'
    }, [
      el('span', { className: 's-ledger-month__text', text: monthLabel(st.month) }),
      iconNode('chevron-down', 12)
    ]);
    /* 收支结余从三列汇总卡收成一行灰字（鲨鱼式两层头部） */
    var statText = el('span', { className: 's-ledger-stats-link__text u-tabular', text: '' });
    var statsLink = el('a', {
      className: 's-ledger-stats-link',
      href: '#/stats',
      'aria-label': '查看本月统计'
    }, [statText]);
    row.appendChild(monthBtn);
    row.appendChild(statsLink);
    sticky.appendChild(row);
    bar.appendChild(sticky);

    /* --- 搜索：默认收起，点图标展开为搜索模式 --- */
    var search = el('div', { className: 's-ledger-search' });
    var searchBox = el('label', { className: 's-ledger-search__box' });
    searchBox.appendChild(iconNode('search', 16));
    var input = el('input', {
      className: 's-ledger-search__input',
      type: 'search',
      placeholder: '搜索备注、分类、金额',
      'aria-label': '搜索流水',
      autocomplete: 'off',
      spellcheck: 'false'
    });
    if (st.query) { input.value = st.query; }
    searchBox.appendChild(input);
    var cancel = el('button', { className: 's-ledger-search__cancel', type: 'button', text: '取消' });
    search.appendChild(searchBox);
    search.appendChild(cancel);
    bar.appendChild(search);

    /* --- 工具行：搜索入口 + 类型 chips + 待报销 + 筛选 --- */
    var chips = el('div', { className: 's-ledger-chips', 'aria-label': '快速筛选' });
    var searchBtn = iconButton('s-ledger-searchbtn', 'search', '搜索流水');
    var chipNodes = {};
    TYPE_KEYS.forEach(function (key) {
      var chip = el('button', {
        className: 's-ledger-chip',
        type: 'button',
        dataset: { type: key },
        'aria-pressed': 'false',
        text: TYPE_LABEL[key]
      });
      chips.appendChild(chip);
      chipNodes[key] = chip;
    });
    var reimburseChip = el('button', {
      className: 's-ledger-chip s-ledger-chip--flag',
      type: 'button',
      'aria-pressed': 'false',
      text: '待报销'
    });

    var filterBtn = el('button', {
      className: 's-ledger-filter',
      type: 'button',
      'aria-label': '更多筛选'
    }, [iconNode('filter', 14), el('span', { className: 's-ledger-filter__label', text: '筛选' })]);
    var badge = el('span', { className: 's-ledger-filter__badge u-tabular', text: '0' });
    filterBtn.appendChild(badge);
    /* 待报销贴着搜索图标（工具位相邻），类型 chips 排最前 */
    chips.appendChild(searchBtn);
    chips.appendChild(reimburseChip);
    chips.appendChild(filterBtn);
    bar.appendChild(chips);

    /* --- 已启用的高级筛选：可删除 chips（无筛选时不占高度） --- */
    var activeRow = el('div', { className: 's-ledger-activechips' });
    activeRow.hidden = true;
    bar.appendChild(activeRow);

    st.nodes.bar = bar;
    st.nodes.sticky = sticky;
    st.nodes.monthBtn = monthBtn;
    st.nodes.monthText = monthBtn.firstChild;
    st.nodes.statText = statText;
    st.nodes.input = input;
    st.nodes.cancel = cancel;
    st.nodes.search = search;
    st.nodes.searchBox = searchBox;
    st.nodes.searchBtn = searchBtn;
    st.nodes.chips = chips;
    st.nodes.chipNodes = chipNodes;
    st.nodes.filterBtn = filterBtn;
    st.nodes.badge = badge;
    st.nodes.reimburseChip = reimburseChip;
    st.nodes.activeRow = activeRow;

    monthBtn.addEventListener('click', function () { openMonthSheet(st); });
    chipNodes.all.addEventListener('click', function () { setType(st, 'all'); });
    chipNodes.expense.addEventListener('click', function () { setType(st, 'expense'); });
    chipNodes.income.addEventListener('click', function () { setType(st, 'income'); });
    chipNodes.transfer.addEventListener('click', function () { setType(st, 'transfer'); });
    reimburseChip.addEventListener('click', function () {
      if (st.dead) { return; }
      st.reimburseOnly = !st.reimburseOnly;
      paint(st);
    });
    searchBtn.addEventListener('click', function () {
      openSearch(st);
      input.focus();
    });
    filterBtn.addEventListener('click', function () { openFilterSheet(st); });

    return bar;
  }

  function buildDays(st) {
    var days = el('div', { className: 's-ledger-days' });
    st.nodes.days = days;
    return days;
  }

  function buildMore(st) {
    var more = el('div', { className: 's-ledger-more' });
    var btn = el('button', { className: 's-ledger-more__btn', type: 'button', text: '加载更多' });
    btn.addEventListener('click', function () {
      if (st.dead) { return; }
      loadMore(st);
    });
    more.appendChild(btn);
    st.nodes.more = more;
    st.nodes.moreBtn = btn;
    return more;
  }

  function buildEmpty(st, hasAny) {
    var box = el('div', { className: 's-ledger-empty' });
    var iconBox = el('span', { className: 's-ledger-empty__icon' });
    iconBox.appendChild(iconNode(hasAny ? 'search' : 'wallet', 40));
    box.appendChild(iconBox);
    box.appendChild(el('p', {
      className: 's-ledger-empty__title',
      text: hasAny ? '没有匹配的记录' : '这个月还没有流水'
    }));
    box.appendChild(el('p', {
      className: 's-ledger-empty__text',
      text: hasAny
        ? '换个关键词，或清除筛选看看全部流水。'
        : '换个账本或月份，也可以现在记一笔。'
    }));
    var cta = el('button', {
      className: 'c-btn c-btn--secondary s-ledger-empty__cta',
      type: 'button',
      text: hasAny ? '清除筛选' : '记一笔'
    });
    cta.addEventListener('click', function () {
      if (st.dead) { return; }
      if (hasAny) { clearFilters(st, true); return; }
      navigate(st, '#/add');
    });
    box.appendChild(cta);
    return box;
  }

  function categorySlot(st, categoryId) {
    var categories = rows(st.db, 'categories');
    for (var i = 0; i < categories.length; i += 1) {
      if (categories[i] && categories[i].id === categoryId) { return (i % 12) + 1; }
    }
    return 12;
  }

  function buildItem(st, tx) {
    var maps = st.maps;
    var isTransfer = tx.type === 'transfer';
    var isIncome = tx.type === 'income';
    var cents = Math.abs(Number(tx.amountCents) || 0);
    var cat = maps.categories[tx.categoryId] || null;
    var title = isTransfer ? '转账' : (cat && cat.name ? String(cat.name) : '未分类');
    var fromName = accountName(maps.accounts[tx.accountId]);
    var toName = tx.toAccountId ? accountName(maps.accounts[tx.toAccountId]) : '';
    var sub = isTransfer ? fromName + ' \u2192 ' + toName : fromName;
    if (!isTransfer && tx.note) { sub += ' \u00b7 ' + String(tx.note); }
    var iconName = isTransfer ? 'transfer' : (cat && cat.icon ? String(cat.icon) : 'ellipsis');
    var slot = isTransfer ? 2 : categorySlot(st, tx.categoryId);

    var wrap = el('div', {
      className: 's-ledger-item s-ledger-item--' + String(tx.type || 'expense'),
      dataset: { id: String(tx.id || '') }
    });

    var actions = el('div', { className: 's-ledger-item__actions' });
    var editBtn = el('button', {
      className: 's-ledger-item__act',
      type: 'button',
      'aria-label': '编辑这条流水'
    }, [iconNode('edit', 18), el('span', { className: 's-ledger-item__act-label', text: '编辑' })]);
    var delBtn = el('button', {
      className: 's-ledger-item__act s-ledger-item__act--danger',
      type: 'button',
      'aria-label': '删除这条流水'
    }, [iconNode('trash', 18), el('span', { className: 's-ledger-item__act-label', text: '删除' })]);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    wrap.appendChild(actions);

    var surface = el('div', { className: 's-ledger-item__surface' });
    var main = el('a', {
      className: 's-ledger-item__main',
      href: '#/add?id=' + encodeURIComponent(String(tx.id || '')),
      'aria-label': title + ' ' + (isTransfer ? fmt(cents) : (isIncome ? '收入 ' : '支出 ') + fmt(cents))
    });

    var iconBox = el('span', { className: 's-ledger-item__icon s-ledger-cat--' + slot });
    iconBox.appendChild(iconNode(iconName, 20));
    main.appendChild(iconBox);

    var mainText = el('span', { className: 's-ledger-item__text' });
    mainText.appendChild(el('span', { className: 's-ledger-item__title u-ellipsis', text: title }));
    var subLine = el('span', { className: 's-ledger-item__sub u-ellipsis' });
    if (tx.reimburse === 'pending') {
      subLine.appendChild(el('span', { className: 's-ledger-item__flag', text: '待报' }));
    }
    subLine.appendChild(document.createTextNode(sub));
    mainText.appendChild(subLine);
    main.appendChild(mainText);

    var trail = el('span', { className: 's-ledger-item__trail' });
    var amountClass = 's-ledger-item__amount u-tabular';
    if (isTransfer) { amountClass += ' s-ledger-item__amount--transfer'; }
    else if (isIncome) { amountClass += ' s-ledger-item__amount--income'; }
    else { amountClass += ' s-ledger-item__amount--expense'; }
    trail.appendChild(el('span', {
      className: amountClass,
      text: isTransfer ? fmt(cents) : (isIncome ? '+' : '-') + fmt(cents)
    }));
    if (tx.time) {
      trail.appendChild(el('span', { className: 's-ledger-item__time u-tabular', text: String(tx.time) }));
    }
    main.appendChild(trail);
    surface.appendChild(main);
    wrap.appendChild(surface);

    editBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      navigate(st, '#/add?id=' + encodeURIComponent(String(tx.id || '')));
    });
    delBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      deleteTx(st, tx);
    });
    /* N3：单击先看详情，编辑要明确的二次动作；href 保留给无 JS/新窗口场景 */
    main.addEventListener('click', function (event) {
      event.preventDefault();
      openDetailSheet(st, tx);
    });
    bindGesture(st, wrap, surface, tx);

    return wrap;
  }

  function buildDayGroup(st, date, totals) {
    var group = el('div', { className: 's-ledger-day', dataset: { day: date } });
    var head = el('div', { className: 's-ledger-day__head' });
    head.appendChild(el('span', { className: 's-ledger-day__date', text: dayLabel(date) }));
    var parts = [];
    if (totals && totals.expense > 0) { parts.push('支出 ' + fmt(totals.expense)); }
    if (totals && totals.income > 0) { parts.push('收入 ' + fmt(totals.income)); }
    if (totals && totals.transfer > 0) { parts.push('转账 ' + fmt(totals.transfer)); }
    head.appendChild(el('span', {
      className: 's-ledger-day__sum u-tabular',
      text: parts.length ? parts.join(' \u00b7 ') : '无金额'
    }));
    if (st.stickTop > 0) { head.style.top = String(st.stickTop) + 'px'; }
    group.appendChild(head);

    var rowsBox = el('div', { className: 's-ledger-day__rows' });
    group.appendChild(rowsBox);
    group.__rows = rowsBox;
    return group;
  }

  /* ---------------- 手势：左滑 / 长按 ---------------- */

  function closeSwiped(st) {
    if (!st.openItem) { return; }
    var wrap = st.openItem;
    st.openItem = null;
    wrap.classList.remove('is-active');
    var surface = wrap.querySelector('.s-ledger-item__surface');
    if (surface) { surface.style.transform = ''; }
  }

  function bindGesture(st, wrap, surface, tx) {
    var startX = 0;
    var startY = 0;
    var baseX = 0;
    var delta = 0;
    var active = false;
    var dragging = false;
    var moved = false;
    var longFired = false;
    var longTimer = 0;

    function clearLong() {
      if (longTimer) { global.clearTimeout(longTimer); longTimer = 0; }
    }

    function setX(px) {
      surface.style.transform = px ? 'translateX(' + Math.round(px) + 'px)' : '';
    }

    function open() {
      if (st.openItem && st.openItem !== wrap) { closeSwiped(st); }
      st.openItem = wrap;
      wrap.classList.add('is-active');
      setX(SWIPE_OPEN);
    }

    function close() {
      if (st.openItem === wrap) { st.openItem = null; }
      wrap.classList.remove('is-active');
      setX(0);
    }

    wrap.addEventListener('pointerdown', function (event) {
      if (st.dead) { return; }
      if (event.pointerType === 'mouse' && event.button !== 0) { return; }
      if (event.target && event.target.closest && event.target.closest('.s-ledger-item__actions')) { return; }
      active = true;
      dragging = false;
      moved = false;
      longFired = false;
      startX = event.clientX;
      startY = event.clientY;
      baseX = wrap.classList.contains('is-active') ? SWIPE_OPEN : 0;
      delta = baseX;
      clearLong();
      longTimer = global.setTimeout(function () {
        longTimer = 0;
        if (st.dead || dragging || !active) { return; }
        longFired = true;
        openActionSheet(st, tx);
      }, LONG_PRESS_MS);
    });

    wrap.addEventListener('pointermove', function (event) {
      if (!active || st.dead) { return; }
      var dx = event.clientX - startX;
      var dy = event.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          active = false;
          clearLong();
          return;
        }
        if (Math.abs(dx) < SWIPE_SLOP) { return; }
        dragging = true;
        clearLong();
        surface.style.transition = 'none';
        try { wrap.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      }
      var next = baseX + dx;
      if (next > 0) { next = 0; }
      if (next < SWIPE_OPEN) { next = SWIPE_OPEN; }
      delta = next;
      moved = true;
      setX(delta);
    });

    function finish() {
      if (!active) { return; }
      active = false;
      clearLong();
      surface.style.transition = '';
      if (dragging) {
        dragging = false;
        if (delta <= SWIPE_OPEN / 2) { open(); } else { close(); }
      }
      /* click 事件紧随 pointerup，下一拍再允许点击，避免一次拖动吃掉两次点击 */
      global.setTimeout(function () { moved = false; longFired = false; }, 0);
    }

    wrap.addEventListener('pointerup', finish);
    wrap.addEventListener('pointercancel', function () {
      clearLong();
      active = false;
      dragging = false;
      surface.style.transition = '';
      close();
    });

    wrap.addEventListener('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('.s-ledger-item__actions')) { return; }
      if (longFired || moved) {
        longFired = false;
        moved = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (wrap.classList.contains('is-active')) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }, true);

    st.cleanups.push(clearLong);
  }

  /* ---------------- 操作表 / 删除 ---------------- */

  function navigate(st, hash) {
    if (st.ctx && typeof st.ctx.go === 'function') {
      st.ctx.go(hash);
      return;
    }
    global.location.hash = hash;
  }

  /* ---------------- 流水详情面板（N3）/ 删除 / 复制 ---------------- */

  function openDetailSheet(st, tx) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var maps = st.maps;
    var cents = Math.abs(Number(tx.amountCents) || 0);
    var body = el('div', { className: 's-ledger-detail' });

    var amountLine = el('p', { className: 's-ledger-detail__amount u-tabular' });
    var sign = tx.type === 'income' ? '+' : (tx.type === 'transfer' ? '' : '-');
    amountLine.textContent = sign + fmt(cents);
    if (tx.type === 'income') { amountLine.classList.add('s-ledger-detail__amount--income'); }
    else if (tx.type === 'expense') { amountLine.classList.add('s-ledger-detail__amount--expense'); }
    body.appendChild(amountLine);

    var isTransfer = tx.type === 'transfer';
    var from = maps.accounts[tx.accountId];
    var to = tx.toAccountId ? maps.accounts[tx.toAccountId] : null;
    var lines = [
      ['分类', isTransfer ? '转账' : categoryName(tx, maps)],
      ['账户', isTransfer
        ? (from ? from.name : '—') + ' → ' + (to ? to.name : '—')
        : (from ? from.name : '—')],
      ['时间', String(tx.date || '') + (tx.time ? ' ' + String(tx.time) : '')]
    ];
    if (tx.note) { lines.push(['备注', String(tx.note)]); }
    if (Array.isArray(tx.tags) && tx.tags.length) { lines.push(['标签', '#' + tx.tags.join(' #')]); }
    if (tx.reimburse === 'pending') { lines.push(['报销', '待报销（垫付）']); }
    var list = el('div', { className: 's-ledger-detail__list' });
    lines.forEach(function (pair) {
      var row = el('div', { className: 's-ledger-detail__row' });
      row.appendChild(el('span', { className: 's-ledger-detail__key', text: pair[0] }));
      row.appendChild(el('span', { className: 's-ledger-detail__val', text: pair[1] }));
      list.appendChild(row);
    });
    body.appendChild(list);

    sheet.open({
      title: '这笔流水',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '复制为新记录',
          kind: 'default',
          onClick: function () { copyTx(st, tx); }
        },
        {
          label: '编辑',
          kind: 'default',
          onClick: function () {
            navigate(st, '#/add?id=' + encodeURIComponent(String(tx.id || '')));
          }
        },
        {
          label: '删除',
          kind: 'danger',
          onClick: function () { deleteTx(st, tx); }
        }
      ]
    });
  }

  /* 长按沿用同一张详情面板 */
  function openActionSheet(st, tx) {
    openDetailSheet(st, tx);
  }

  function copyTx(st, tx) {
    var app = appApi();
    var commit = st.ctx && typeof st.ctx.commit === 'function' ? st.ctx.commit : (app && app.commit);
    if (typeof commit !== 'function') {
      toast('复制失败，请重试', { type: 'danger' });
      return;
    }
    var today = todayStr();
    var source = assign({}, tx, {
      id: undefined,
      date: today,
      time: dates && typeof dates.nowTime === 'function' ? dates.nowTime() : '',
      deleted: false,
      deletedAt: null,
      reimburse: tx.type === 'expense' && tx.reimburse === 'pending' ? 'pending' : 'none'
    });
    var entity = null;
    if (schema && typeof schema.createTransaction === 'function') {
      entity = schema.createTransaction(source);
    }
    if (!entity) {
      toast('复制失败，请重试', { type: 'danger' });
      return;
    }
    commit(function (working) {
      var list = working && working.transactions ? working.transactions : null;
      if (!list) { return { abort: true, code: 'E_STORE_TX', message: messageOf('E_STORE_TX') }; }
      list.push(entity);
      return { value: { id: entity.id } };
    }, { label: '复制流水' }).then(function (result) {
      if (!result || !result.ok) {
        toast(messageOf(result && result.code, result && result.message), { type: 'danger' });
        return;
      }
      toast('已复制为新记录', {
        type: 'success',
        action: {
          label: '撤销',
          onClick: function () {
            if (app && typeof app.undo === 'function') { app.undo(); }
          }
        }
      });
    }, function () {
      toast('复制失败，请重试', { type: 'danger' });
    });
  }

  function deleteTx(st, tx) {
    var app = appApi();
    var commit = st.ctx && typeof st.ctx.commit === 'function' ? st.ctx.commit : (app && app.commit);
    if (typeof commit !== 'function') {
      toast('删除失败，请重试', { type: 'danger' });
      return;
    }
    var nowIso = dates && typeof dates.nowIso === 'function' ? dates.nowIso() : new Date().toISOString();
    var target = tx;
    commit(function (working) {
      var list = working && working.transactions ? working.transactions : null;
      if (!list) { return { abort: true, code: 'E_STORE_TX', message: messageOf('E_STORE_TX') }; }
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === target.id) {
          if (schema && typeof schema.normalizeTransaction === 'function') {
            var patch = {};
            var keys = Object.keys(list[i]);
            for (var k = 0; k < keys.length; k += 1) { patch[keys[k]] = list[i][keys[k]]; }
            patch.deleted = true;
            patch.deletedAt = nowIso;
            patch.updatedAt = nowIso;
            list[i] = schema.normalizeTransaction(patch, nowIso);
          } else {
            list[i].deleted = true;
            list[i].deletedAt = nowIso;
            list[i].updatedAt = nowIso;
          }
          break;
        }
      }
      return { value: { id: target.id } };
    }, { label: '删除流水' }).then(function (result) {
      if (!result || !result.ok) {
        toast(messageOf(result && result.code, result && result.message), { type: 'danger' });
        return;
      }
      toast('已删除', {
        type: 'success',
        action: {
          label: '撤销',
          onClick: function () {
            if (app && typeof app.undo === 'function') { app.undo(); }
          }
        }
      });
    }, function () {
      toast('删除失败，请重试', { type: 'danger' });
    });
  }

  /* ---------------- 月份 ---------------- */

  function setMonth(st, month, scrollTop) {
    if (!isValidMonth(month) || month === st.month) {
      if (isValidMonth(month) && scrollTop) { scrollToTop(st); }
      return;
    }
    st.month = month;
    if (st.nodes.monthText) { st.nodes.monthText.textContent = monthLabel(month); }
    paint(st);
    if (scrollTop) { scrollToTop(st); }
  }

  function scrollToTop(st) {
    var scroller = st.scroller || (st.root.closest ? st.root.closest('.app-screen') : null);
    if (scroller) { scroller.scrollTop = 0; }
  }

  function openMonthSheet(st) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var viewYear = Number(String(st.month).split('-')[0]);
    var content = el('div', { className: 's-ledger-monthgrid' });
    var head = el('div', { className: 's-ledger-monthgrid__head' });
    var prevY = iconButton('s-ledger-arrow', 'chevron-left', '上一年');
    var nextY = iconButton('s-ledger-arrow', 'chevron-right', '下一年');
    var yearLabel = el('span', { className: 's-ledger-monthgrid__year u-tabular', text: String(viewYear) + '年' });
    head.appendChild(prevY);
    head.appendChild(yearLabel);
    head.appendChild(nextY);
    content.appendChild(head);
    var grid = el('div', { className: 's-ledger-monthgrid__grid' });
    content.appendChild(grid);
    var handle = sheet.open({
      title: '选择月份',
      content: content,
      actions: [{ label: '取消', kind: 'text' }]
    });

    function draw() {
      yearLabel.textContent = String(viewYear) + '年';
      clearNode(grid);
      for (var m = 1; m <= 12; m += 1) {
        var value = viewYear + '-' + pad2(m);
        var cell = el('button', {
          className: 's-ledger-monthgrid__cell',
          type: 'button',
          dataset: { month: value },
          text: String(m) + '月'
        });
        if (value === st.month) { cell.classList.add('is-active'); }
        (function (target) {
          cell.addEventListener('click', function () {
            if (handle && typeof handle.close === 'function') { handle.close(); }
            setMonth(st, target, true);
          });
        })(value);
        grid.appendChild(cell);
      }
    }
    prevY.addEventListener('click', function () { viewYear -= 1; draw(); });
    nextY.addEventListener('click', function () { viewYear += 1; draw(); });
    draw();
  }

  /* ---------------- 筛选 ---------------- */

  function setType(st, type) {
    if (TYPE_KEYS.indexOf(type) < 0 || st.type === type) { return; }
    st.type = type;
    paint(st);
  }

  function clearFilters(st, includeQuery) {
    st.type = 'all';
    st.reimburseOnly = false;
    st.day = '';
    st.accountIds = [];
    st.categoryIds = [];
    st.minCents = null;
    st.maxCents = null;
    if (includeQuery) {
      st.query = '';
      if (st.nodes.input) { st.nodes.input.value = ''; }
      syncCancel(st);
    }
    paint(st);
  }

  function openFilterSheet(st) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var draft = {
      type: st.type,
      accountIds: st.accountIds.slice(0),
      categoryIds: st.categoryIds.slice(0),
      minCents: st.minCents,
      maxCents: st.maxCents
    };
    var content = el('div', { className: 's-ledger-filterpane' });

    /* 类型：顶部 segmented（沿用） */
    var typeGroup = el('section', { className: 's-ledger-fgroup' });
    typeGroup.appendChild(el('h3', { className: 's-ledger-fgroup__title', text: '类型' }));
    var seg = el('div', { className: 's-ledger-fseg', role: 'group', 'aria-label': '类型' });
    var segNodes = {};
    TYPE_KEYS.forEach(function (key) {
      var item = el('button', {
        className: 's-ledger-fseg__item',
        type: 'button',
        dataset: { type: key },
        'aria-pressed': key === draft.type ? 'true' : 'false',
        text: TYPE_LABEL[key]
      });
      if (key === draft.type) { item.classList.add('is-active'); }
      item.addEventListener('click', function () {
        draft.type = key;
        Object.keys(segNodes).forEach(function (name) {
          var active = name === key;
          segNodes[name].classList.toggle('is-active', active);
          segNodes[name].setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        paintCategories();
      });
      segNodes[key] = item;
      seg.appendChild(item);
    });
    typeGroup.appendChild(seg);
    content.appendChild(typeGroup);

    /* 账户：横向可换行 chips（M5） */
    var accounts = rows(st.db, 'accounts').filter(function (item) {
      return item && item.archived !== true && item.deleted !== true;
    });
    var accountGroup = el('section', { className: 's-ledger-fgroup' });
    accountGroup.appendChild(el('h3', { className: 's-ledger-fgroup__title', text: '账户' }));
    var accountBox = el('div', { className: 's-ledger-fchips' });
    accounts.forEach(function (account) {
      var on = draft.accountIds.indexOf(account.id) >= 0;
      var chip = el('button', {
        className: 's-ledger-fchip' + (on ? ' is-active' : ''),
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        text: accountName(account)
      });
      chip.addEventListener('click', function () {
        var nowOn = draft.accountIds.indexOf(account.id) >= 0;
        toggleId(draft.accountIds, account.id, !nowOn);
        chip.classList.toggle('is-active', !nowOn);
        chip.setAttribute('aria-pressed', !nowOn ? 'true' : 'false');
        syncApply();
      });
      accountBox.appendChild(chip);
    });
    if (!accounts.length) { accountBox.appendChild(el('p', { className: 's-ledger-fempty', text: '还没有账户' })); }
    accountGroup.appendChild(accountBox);
    content.appendChild(accountGroup);

    /* 分类：搜索 + 类型过滤 + 常用优先 + 展开分组 + 已选置顶（M5） */
    var categories = rows(st.db, 'categories').filter(function (item) {
      return item && item.hidden !== true && item.deleted !== true;
    });
    var catGroup = el('section', { className: 's-ledger-fgroup' });
    catGroup.appendChild(el('h3', { className: 's-ledger-fgroup__title', text: '分类' }));
    var searchBox = el('div', { className: 's-ledger-fsearch' });
    var catInput = el('input', {
      className: 's-ledger-fsearch__input',
      type: 'search',
      placeholder: '搜索分类',
      'aria-label': '搜索分类',
      autocomplete: 'off'
    });
    searchBox.appendChild(iconNode('search', 14));
    searchBox.appendChild(catInput);
    catGroup.appendChild(searchBox);
    var selectedBox = el('div', { className: 's-ledger-fchips s-ledger-fchips--selected' });
    catGroup.appendChild(selectedBox);
    var catBox = el('div', { className: 's-ledger-fchips s-ledger-fchips--cats' });
    catGroup.appendChild(catBox);
    var expandBtn = el('button', { className: 's-ledger-fexpand', type: 'button', text: '展开全部' });
    catGroup.appendChild(expandBtn);
    content.appendChild(catGroup);

    /* 常用分类：prefs 收藏 + 当前账本使用频次 */
    function frequentCategoryIds() {
      var ids = [];
      var seen = {};
      var app = appApi();
      var prefs = app && app.prefs ? app.prefs : null;
      if (prefs && typeof prefs.get === 'function') {
        var favs = prefs.get('favoriteCategoryIds', []);
        for (var f = 0; f < (favs || []).length; f += 1) {
          if (favs[f] && !seen[favs[f]]) { seen[favs[f]] = true; ids.push(String(favs[f])); }
        }
      }
      var counts = {};
      for (var i = 0; i < st.all.length; i += 1) {
        var tx = st.all[i];
        if (!tx || !tx.categoryId) { continue; }
        counts[tx.categoryId] = (counts[tx.categoryId] || 0) + 1;
      }
      var ranked = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
      for (var r = 0; r < ranked.length; r += 1) {
        if (!seen[ranked[r]]) { seen[ranked[r]] = true; ids.push(ranked[r]); }
      }
      return ids;
    }

    var expanded = false;
    var keyword = '';
    var FREQ_SHOW = 12;

    function poolOf() {
      return categories.filter(function (cat) {
        if (draft.type !== 'all' && cat.kind !== draft.type) { return false; }
        if (keyword && String(cat.name || '').indexOf(keyword) < 0) { return false; }
        return true;
      });
    }

    function catChip(cat) {
      var on = draft.categoryIds.indexOf(cat.id) >= 0;
      var chip = el('button', {
        className: 's-ledger-fchip' + (on ? ' is-active' : ''),
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        text: String(cat.name || '未命名')
      });
      chip.addEventListener('click', function () {
        var nowOn = draft.categoryIds.indexOf(cat.id) >= 0;
        toggleId(draft.categoryIds, cat.id, !nowOn);
        paintSelected();
        paintCategories();
        syncApply();
      });
      return chip;
    }

    function paintSelected() {
      clearNode(selectedBox);
      selectedBox.hidden = draft.categoryIds.length === 0;
      draft.categoryIds.forEach(function (id) {
        var cat = st.maps.categories[id];
        var chip = el('button', {
          className: 's-ledger-fchip is-active',
          type: 'button',
          'aria-label': '移除分类 ' + (cat && cat.name ? cat.name : id)
        }, [
          el('span', { text: cat && cat.name ? String(cat.name) : id }),
          el('span', { className: 's-ledger-fchip__x', text: '×' })
        ]);
        chip.addEventListener('click', function () {
          toggleId(draft.categoryIds, id, false);
          paintSelected();
          paintCategories();
          syncApply();
        });
        selectedBox.appendChild(chip);
      });
    }

    function paintCategories() {
      clearNode(catBox);
      var pool = poolOf();
      if (!pool.length) {
        catBox.appendChild(el('p', {
          className: 's-ledger-fempty',
          text: keyword ? '没有叫「' + keyword + '」的分类' : '这个类型还没有分类'
        }));
        expandBtn.hidden = true;
        return;
      }
      if (expanded || keyword) {
        [['自定义分类', false], ['系统分类', true]].forEach(function (pair) {
          var list = pool.filter(function (cat) { return (cat.system === true) === pair[1]; });
          if (!list.length) { return; }
          catBox.appendChild(el('p', { className: 's-ledger-fgrouplabel', text: pair[0] }));
          list.forEach(function (cat) { catBox.appendChild(catChip(cat)); });
        });
        expandBtn.hidden = true;
        return;
      }
      var freq = frequentCategoryIds();
      var ordered = [];
      var seenIds = {};
      freq.forEach(function (id) {
        for (var i = 0; i < pool.length; i += 1) {
          if (pool[i].id === id && !seenIds[id]) { seenIds[id] = true; ordered.push(pool[i]); }
        }
      });
      pool.forEach(function (cat) {
        if (!seenIds[cat.id]) { seenIds[cat.id] = true; ordered.push(cat); }
      });
      var shown = ordered.slice(0, FREQ_SHOW);
      shown.forEach(function (cat) { catBox.appendChild(catChip(cat)); });
      expandBtn.hidden = ordered.length <= FREQ_SHOW;
    }

    expandBtn.addEventListener('click', function () {
      expanded = true;
      paintCategories();
    });
    catInput.addEventListener('input', function () {
      keyword = String(catInput.value || '').trim();
      paintCategories();
    });

    /* 金额区间（沿用） */
    var rangeGroup = el('section', { className: 's-ledger-fgroup' });
    rangeGroup.appendChild(el('h3', { className: 's-ledger-fgroup__title', text: '金额区间（元）' }));
    var range = el('div', { className: 's-ledger-frange' });
    var minInput = el('input', {
      className: 's-ledger-frange__input',
      type: 'text',
      inputmode: 'decimal',
      placeholder: '最低',
      'aria-label': '最低金额',
      value: draft.minCents === null ? '' : String(draft.minCents / 100)
    });
    var maxInput = el('input', {
      className: 's-ledger-frange__input',
      type: 'text',
      inputmode: 'decimal',
      placeholder: '最高',
      'aria-label': '最高金额',
      value: draft.maxCents === null ? '' : String(draft.maxCents / 100)
    });
    range.appendChild(minInput);
    range.appendChild(el('span', { className: 's-ledger-frange__sep', text: '\u2013' }));
    range.appendChild(maxInput);
    rangeGroup.appendChild(range);
    content.appendChild(rangeGroup);

    var handle = sheet.open({
      title: '筛选',
      content: content,
      actions: [
        {
          label: '清空',
          kind: 'text',
          onClick: function () {
            if (handle && typeof handle.close === 'function') { handle.close(); }
            clearFilters(st, true);
          }
        },
        {
          label: '应用',
          kind: 'primary',
          onClick: function () {
            var min = parseYuan(minInput.value);
            var max = parseYuan(maxInput.value);
            if (min !== null && max !== null && min > max) {
              var swap = min;
              min = max;
              max = swap;
            }
            draft.minCents = min;
            draft.maxCents = max;
            st.type = draft.type;
            st.accountIds = draft.accountIds.slice(0);
            st.categoryIds = draft.categoryIds.slice(0);
            st.minCents = draft.minCents;
            st.maxCents = draft.maxCents;
            paint(st);
            scrollToTop(st);
          }
        }
      ]
    });

    /* 应用按钮带数量（M5）：选择变化时同步文案 */
    var applyBtn = null;
    if (handle && handle.element) {
      applyBtn = handle.element.querySelector('.c-sheet__footer .c-btn--primary');
    }
    function syncApply() {
      if (!applyBtn) { return; }
      var n = draft.categoryIds.length + draft.accountIds.length +
        (draft.type !== 'all' ? 1 : 0) +
        ((draft.minCents !== null || draft.maxCents !== null) ? 1 : 0);
      applyBtn.textContent = n > 0 ? '应用（' + n + '）' : '应用';
    }
    paintSelected();
    paintCategories();
    syncApply();
  }

  function toggleId(list, id, next) {
    var index = list.indexOf(id);
    if (next && index < 0) { list.push(id); }
    if (!next && index >= 0) { list.splice(index, 1); }
  }

  /* ---------------- 汇总 / 标题 / chip ---------------- */

  function renderSummary(st) {
    var totals = totalsOf(st.filtered);
    st.nodes.statText.textContent = '支 ' + fmt(totals.expense) + ' · 收 ' + fmt(totals.income);
  }

  function renderChips(st) {
    var nodes = st.nodes.chipNodes;
    var keys = Object.keys(nodes);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var active = st.type === key;
      nodes[key].classList.toggle('is-active', active);
      nodes[key].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (st.nodes.reimburseChip) {
      var flagOn = st.reimburseOnly === true;
      st.nodes.reimburseChip.classList.toggle('is-active', flagOn);
      st.nodes.reimburseChip.setAttribute('aria-pressed', flagOn ? 'true' : 'false');
    }
    var count = filterCount(st);
    st.nodes.filterBtn.classList.toggle('is-active', count > 0);
    st.nodes.badge.textContent = String(count);
    st.nodes.badge.classList.toggle('is-hidden', count === 0);
    renderActiveChips(st);
  }

  /* 已启用的高级筛选 → 可删除 chips（M4）：点 × 只撤这一个维度 */
  function renderActiveChips(st) {
    var row = st.nodes.activeRow;
    if (!row) { return; }
    clearNode(row);
    var defs = [];
    if (st.day) {
      defs.push({ key: 'day', label: dates && typeof dates.formatHuman === 'function' ? dates.formatHuman(st.day) : st.day });
    }
    if (st.reimburseOnly) {
      defs.push({ key: 'reimburse', label: '待报销' });
    }
    if (st.accountIds.length) {
      var acc = st.maps.accounts[st.accountIds[0]];
      defs.push({
        key: 'accounts',
        label: st.accountIds.length === 1
          ? (acc && acc.name ? String(acc.name) : '1 个账户')
          : st.accountIds.length + ' 个账户'
      });
    }
    if (st.categoryIds.length) {
      var cat = st.maps.categories[st.categoryIds[0]];
      defs.push({
        key: 'categories',
        label: st.categoryIds.length === 1
          ? (cat && cat.name ? String(cat.name) : '1 个分类')
          : st.categoryIds.length + ' 个分类'
      });
    }
    if (st.minCents !== null || st.maxCents !== null) {
      var minText = st.minCents === null ? '0' : String(st.minCents / 100);
      var maxText = st.maxCents === null ? '∞' : String(st.maxCents / 100);
      defs.push({ key: 'range', label: '¥' + minText + '–' + maxText });
    }
    if (!defs.length) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    defs.forEach(function (def) {
      var chip = el('button', {
        className: 's-ledger-achip',
        type: 'button',
        'aria-label': '移除筛选 ' + def.label
      }, [
        el('span', { className: 's-ledger-achip__text', text: def.label }),
        el('span', { className: 's-ledger-achip__x', text: '×' })
      ]);
      chip.addEventListener('click', function () {
        if (st.dead) { return; }
        removeFilterKey(st, def.key);
      });
      row.appendChild(chip);
    });
    var clear = el('button', {
      className: 's-ledger-achip s-ledger-achip--clear',
      type: 'button',
      text: '清除全部'
    });
    clear.addEventListener('click', function () {
      if (st.dead) { return; }
      clearFilters(st, true);
    });
    row.appendChild(clear);
  }

  function removeFilterKey(st, key) {
    if (key === 'day') { st.day = ''; }
    else if (key === 'reimburse') { st.reimburseOnly = false; }
    else if (key === 'accounts') { st.accountIds = []; }
    else if (key === 'categories') { st.categoryIds = []; }
    else if (key === 'range') { st.minCents = null; st.maxCents = null; }
    paint(st);
  }

  /* 搜索默认收起（M4）：有查询或聚焦时才占高度 */
  function openSearch(st) {
    if (st.dead || !st.nodes.search) { return; }
    st.nodes.search.classList.add('is-open');
  }

  function syncCancel(st) {
    if (!st.nodes.cancel) { return; }
    var focused = document.activeElement === st.nodes.input;
    var open = !!st.query || focused || (st.nodes.search && st.nodes.search.classList.contains('is-open'));
    st.nodes.cancel.classList.toggle('is-hidden', !open);
    st.nodes.search && st.nodes.search.classList.toggle('is-active', open);
    if (!open) {
      st.nodes.search && st.nodes.search.classList.remove('is-open');
    }
  }

  function titleParts(st) {
    var parts = [];
    if (st.query) { parts.push('\u201c' + st.query + '\u201d'); }
    if (st.type !== 'all') { parts.push(TYPE_LABEL[st.type]); }
    if (st.categoryIds.length === 1) {
      var cat = st.maps.categories[st.categoryIds[0]];
      parts.push(cat && cat.name ? String(cat.name) : '1 个分类');
    } else if (st.categoryIds.length > 1) {
      parts.push(st.categoryIds.length + ' 个分类');
    }
    if (st.accountIds.length === 1) {
      var acc = st.maps.accounts[st.accountIds[0]];
      parts.push(acc && acc.name ? String(acc.name) : '1 个账户');
    } else if (st.accountIds.length > 1) {
      parts.push(st.accountIds.length + ' 个账户');
    }
    if (st.minCents !== null || st.maxCents !== null) {
      var minText = st.minCents === null ? '0' : String(st.minCents / 100);
      var maxText = st.maxCents === null ? '\u221e' : String(st.maxCents / 100);
      parts.push('\u00a5' + minText + '\u2013' + maxText);
    }
    parts.push(st.month === monthOf(today()) ? '本月' : monthLabel(st.month));
    return parts;
  }

  function titleOf(st) {
    if (!hasFilters(st)) { return '明细'; }
    var text = titleParts(st).join(' \u00b7 ');
    if (text.length > TITLE_MAX) { text = text.slice(0, TITLE_MAX) + '\u2026'; }
    return text;
  }

  function applyTitle(st, text) {
    if (!st.ctx || typeof st.ctx.setTitle !== 'function') { return; }
    st.ctx.setTitle(text);
  }

  function syncTitle(st) {
    var text = titleOf(st);
    applyTitle(st, text);
    /* render 期间新屏尚未挂载，ctx.setTitle 会落到上一屏标题上；挂载后补一次。
     * 若此时已离开明细屏则放弃，避免误改别的屏标题。 */
    global.setTimeout(function () {
      if (st.dead) { return; }
      var route = XZB.router && XZB.router.current ? XZB.router.current() : null;
      if (!route || route.view !== 'ledger') { return; }
      applyTitle(st, text);
    }, 0);
  }

  /* ---------------- 渲染 / 分页 ---------------- */

  function measureSticky(st) {
    var scroller = st.scroller;
    var nav = null;
    if (scroller && scroller.querySelector) { nav = scroller.querySelector('.app-nav'); }
    var navHeight = nav ? nav.offsetHeight : 0;
    var stickyHeight = st.nodes.sticky ? st.nodes.sticky.offsetHeight : 0;
    st.stickTop = navHeight + stickyHeight;
    if (!st.nodes.days) { return; }
    var heads = st.nodes.days.querySelectorAll('.s-ledger-day__head');
    for (var i = 0; i < heads.length; i += 1) {
      heads[i].style.top = String(st.stickTop) + 'px';
    }
  }

  /* render 期间新屏还没挂载，offsetHeight 全是 0；挂载后再量，量不到就多试几帧。 */
  function scheduleMeasure(st) {
    var tries = 0;
    function tick() {
      if (st.dead) { return; }
      measureSticky(st);
      tries += 1;
      var ready = !!(st.nodes.sticky && st.nodes.sticky.offsetHeight > 0);
      if (!ready && tries < 10) { global.setTimeout(tick, 40); }
    }
    global.setTimeout(tick, 0);
  }

  function appendPage(st) {
    var days = st.nodes.days;
    if (!days) { return 0; }
    var end = Math.min(st.filtered.length, st.page * PAGE_SIZE);
    if (end <= st.rendered) { return 0; }
    var start = st.rendered;
    var fragment = frag();
    var currentRows = null;
    var currentDate = '';
    var lastGroup = days.lastElementChild;
    if (st.rendered > 0 && lastGroup && lastGroup.getAttribute('data-day') === st.filtered[start].date) {
      currentDate = st.filtered[start].date;
      currentRows = lastGroup.__rows || lastGroup.lastElementChild;
    }
    var added = 0;
    for (var i = start; i < end; i += 1) {
      var tx = st.filtered[i];
      var date = String(tx.date || '');
      if (date !== currentDate || !currentRows) {
        var group = buildDayGroup(st, date, st.dayTotals[date]);
        fragment.appendChild(group);
        currentDate = date;
        currentRows = group.__rows;
      }
      currentRows.appendChild(buildItem(st, tx));
      added += 1;
    }
    days.appendChild(fragment);
    st.rendered = end;
    return added;
  }

  function loadMore(st) {
    if (st.dead) { return; }
    if (st.rendered >= st.filtered.length) { updateMore(st); return; }
    st.page += 1;
    appendPage(st);
    updateMore(st);
  }

  function updateMore(st) {
    if (!st.nodes.more) { return; }
    if (!st.filtered.length) {
      st.nodes.more.classList.add('is-hidden');
      return;
    }
    st.nodes.more.classList.remove('is-hidden');
    var remain = st.filtered.length - st.rendered;
    if (remain > 0) {
      st.nodes.moreBtn.disabled = false;
      st.nodes.moreBtn.classList.remove('is-disabled');
      /* 触底自动加载有上限（红线：DOM 行不无限增长）；到顶后由用户手动点按钮继续 */
      if (st.rendered >= MAX_AUTO_ROWS) {
        st.nodes.moreBtn.textContent = '继续加载（还有 ' + remain + ' 笔）';
        if (st.nodes.moreHint) { st.nodes.moreHint.textContent = '已显示 ' + st.rendered + ' 笔，继续加载或缩小筛选范围'; }
      } else {
        st.nodes.moreBtn.textContent = '加载更多（还有 ' + remain + ' 笔）';
        if (st.nodes.moreHint) { st.nodes.moreHint.textContent = ''; }
      }
    } else {
      st.nodes.moreBtn.disabled = true;
      st.nodes.moreBtn.classList.add('is-disabled');
      st.nodes.moreBtn.textContent = '没有更多了';
    }
  }

  /* ---------------- 收支日历（D1 已删）：看每日节奏去统计页热力图 ---------------- */

  function paint(st) {
    if (st.dead) { return; }
    st.maps = {
      categories: indexById(rows(st.db, 'categories')),
      accounts: indexById(rows(st.db, 'accounts'))
    };
    st.filtered = applyFilters(st);
    st.dayTotals = dayTotalsOf(st.filtered);
    st.page = 1;
    st.rendered = 0;
    st.openItem = null;
    clearNode(st.nodes.days);
    renderSummary(st);
    renderChips(st);
    syncTitle(st);
    savePersisted(st);
    if (!st.filtered.length) {
      st.nodes.days.appendChild(buildEmpty(st, hasFilters(st)));
      updateMore(st);
      scheduleMeasure(st);
      return;
    }
    appendPage(st);
    updateMore(st);
    scheduleMeasure(st);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindSearch(st) {
    var input = st.nodes.input;
    var cancel = st.nodes.cancel;
    var timer = 0;

    input.addEventListener('input', function () {
      if (timer) { global.clearTimeout(timer); }
      timer = global.setTimeout(function () {
        timer = 0;
        if (st.dead) { return; }
        st.query = String(input.value || '').trim();
        syncCancel(st);
        paint(st);
      }, SEARCH_DEBOUNCE);
    });
    input.addEventListener('focus', function () {
      st.nodes.search && st.nodes.search.classList.add('is-active');
      cancel.classList.remove('is-hidden');
    });
    input.addEventListener('blur', function () { syncCancel(st); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        input.value = '';
        st.query = '';
        syncCancel(st);
        paint(st);
      }
    });
    cancel.addEventListener('click', function () {
      if (timer) { global.clearTimeout(timer); timer = 0; }
      input.value = '';
      st.query = '';
      syncCancel(st);
      paint(st);
      input.blur();
    });
    st.cleanups.push(function () {
      if (timer) { global.clearTimeout(timer); timer = 0; }
    });
    syncCancel(st);
  }

  function bindScroll(st) {
    var scroller = st.root.closest ? st.root.closest('.app-screen') : null;
    if (!scroller) { return; }
    st.scroller = scroller;
    var ticking = false;
    var request = global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); };

    function onScroll() {
      if (ticking) { return; }
      ticking = true;
      request(function () {
        ticking = false;
        if (st.dead) { return; }
        if (st.openItem) { closeSwiped(st); }
        var remain = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (remain < LOAD_AHEAD && st.rendered < MAX_AUTO_ROWS) { loadMore(st); }
      });
    }

    scroller.addEventListener('scroll', onScroll, { passive: true });
    st.cleanups.push(function () { scroller.removeEventListener('scroll', onScroll); });
  }

  function bindResize(st) {
    var timer = 0;
    function onResize() {
      if (timer) { global.clearTimeout(timer); }
      timer = global.setTimeout(function () {
        timer = 0;
        if (st.dead) { return; }
        measureSticky(st);
      }, 180);
    }
    global.addEventListener('resize', onResize);
    st.cleanups.push(function () {
      if (timer) { global.clearTimeout(timer); timer = 0; }
      global.removeEventListener('resize', onResize);
    });
  }

  /* ---------------- 屏幕 ---------------- */

  function render(root, ctx) {
    if (!root) { return; }
    if (live) { live.dead = true; }
    if (live && live.cleanups) {
      while (live.cleanups.length) {
        var fn = live.cleanups.pop();
        try { fn(); } catch (error) { /* 忽略 */ }
      }
    }
    runCleanups();

    var st = createState(root, ctx);
    live = st;
    st.all = collectAll(st.db, st.bookId);
    st.maps = {
      categories: indexById(rows(st.db, 'categories')),
      accounts: indexById(rows(st.db, 'accounts'))
    };

    var bar = buildHeader(st);
    var days = buildDays(st);
    var more = buildMore(st);

    root.appendChild(bar);
    root.appendChild(days);
    root.appendChild(more);

    bindSearch(st);
    paint(st);
    bindScroll(st);
    scheduleMeasure(st);
    bindResize(st);
    st.cleanups.push(function () { st.dead = true; });

    /* 一次性轻提示（N3）：左滑快捷操作不容易被发现 */
    var app = appApi();
    var prefs = app && app.prefs ? app.prefs : null;
    if (prefs && typeof prefs.get === 'function' && !prefs.get('ledgerHintShown', false)) {
      try { prefs.set('ledgerHintShown', true); } catch (error) { /* 提示失败无碍 */ }
      global.setTimeout(function () {
        if (!st.dead) { toast('点流水看详情 · 左滑可直接编辑 / 删除', { type: 'info' }); }
      }, 600);
    }
  }

  var screen = {
    title: '明细',
    subtitle: '全部流水',
    render: render
  };

  XZB.screens.register('ledger', screen);
}(window));
