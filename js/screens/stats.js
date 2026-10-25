/* 小账本 2.0 · js/screens/stats.js
 * 统计屏（2.8 收敛为四个核心模块）：合计（含环比/日均/笔数）→ 收支趋势 → 分类排行 → 每日热力图；
 *         本月小结并进合计下方，待报销只在存在时作为提醒条出现。
 * 契约：XZB.screens.register('stats', { title, subtitle, render })
 * 依赖：XZB.ui.{dom,icons,toast,charts}、XZB.core.{dates,money,stats}、XZB.app
 * 硬规则：不碰 IndexedDB / localStorage / TabBar；用户数据一律 textContent；
 *         金额一律整数分；统计一律过滤 deleted === true；类名 s-stats-*。
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

  var RANK_LIMIT = 8;
  var RANK_FOLDED = 5;   /* M6：排行默认只显示前 5，展开后再看全部 */
  var MONTH_MIN = '2000-01';

  var S = {
    month: '',
    kind: 'expense',
    range: '12',
    trend: 'line',
    rankOpen: false,
    root: null,
    ctx: null
  };

  /* ---------------- 依赖取用 ---------------- */

  function uiApi() { return XZB.ui || XZB.UI || {}; }
  function domApi() { return uiApi().dom || null; }
  function iconsApi() { return uiApi().icons || null; }
  function chartsApi() { return uiApi().charts || null; }
  function toastApi() { return uiApi().toast || null; }
  function appApi() { return XZB.app || XZB.App || null; }

  /* ---------------- 极简 DOM 构造 ---------------- */

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

  function iconNode(name, size) {
    var icons = iconsApi();
    var key = ICON_ALIAS[name] || name || 'ellipsis';
    if (icons && typeof icons.node === 'function') {
      var node = icons.node(key, { size: Number(size) || 20 });
      if (node) { return node; }
    }
    return el('span', { className: 's-stats-glyph', text: String(name || '·').slice(0, 1) });
  }

  function toast(message, options) {
    var t = toastApi();
    if (t && typeof t.show === 'function') { t.show(message, options || {}); }
  }

  /* ---------------- 数据取用 ---------------- */

  function readDb(ctx) {
    if (ctx && ctx.db) { return ctx.db; }
    var app = appApi();
    if (app && typeof app.db === 'function') { return app.db() || {}; }
    return {};
  }

  function rows(db, key) {
    if (!db) { return []; }
    return Array.isArray(db[key]) ? db[key] : [];
  }

  function liveRows(db, key) {
    var all = rows(db, key);
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      var item = all[i];
      if (!item || item.deleted === true) { continue; }
      out.push(item);
    }
    return out;
  }

  function activeBookId(db) {
    var app = appApi();
    var state = app && app.state;
    var id = '';
    if (state && state.ui && typeof state.ui.activeBookId === 'string') {
      id = state.ui.activeBookId;
    }
    var settings = db && db.settings ? db.settings : null;
    if (!id && settings) {
      id = settings.activeBookId || settings.currentBookId || '';
    }
    if (!id) {
      var books = rows(db, 'books');
      for (var i = 0; i < books.length; i += 1) {
        if (books[i] && books[i].archived !== true && typeof books[i].id === 'string') {
          id = books[i].id;
          break;
        }
      }
    }
    return typeof id === 'string' ? id : '';
  }

  function bookNameOf(db, bookId) {
    var books = rows(db, 'books');
    for (var i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].id === bookId) { return String(books[i].name || '当前账本'); }
    }
    return '全部账本';
  }

  /* 分类色槽：按 categories 顺序 1..12 循环，避免写死色值 */
  function categorySlots(categories) {
    var map = Object.create(null);
    for (var i = 0; i < categories.length; i += 1) {
      var category = categories[i];
      if (category && typeof category.id === 'string') { map[category.id] = (i % 12) + 1; }
    }
    return map;
  }

  /* ---------------- 格式化 ---------------- */

  function fmt(cents, options) {
    if (money && typeof money.formatCents === 'function') {
      return money.formatCents(cents, options);
    }
    return '¥' + (Number(cents || 0) / 100).toFixed(2);
  }

  function signed(cents) {
    var n = Number(cents) || 0;
    return fmt(Math.abs(n), { sign: n > 0 });
  }

  function todayStr() {
    if (dates && typeof dates.todayStr === 'function') { return dates.todayStr(); }
    return '';
  }

  function monthOf(dateText) {
    return String(dateText || '').slice(0, 7);
  }

  function monthLabel(month) {
    var parts = String(month || '').split('-');
    if (parts.length !== 2) { return month || ''; }
    return Number(parts[0]) + '年' + Number(parts[1]) + '月';
  }

  function monthShort(month) {
    var parts = String(month || '').split('-');
    if (parts.length !== 2) { return month || ''; }
    return Number(parts[1]) + '月';
  }

  function humanDate(dateText) {
    if (dates && typeof dates.formatHuman === 'function') {
      return dates.formatHuman(dateText);
    }
    return String(dateText || '');
  }

  function monthRange(month) {
    if (dates && typeof dates.monthRange === 'function') {
      return dates.monthRange(month);
    }
    return { start: month + '-01', end: month + '-28' };
  }

  function addMonths(month, delta) {
    var base = month + '-01';
    if (dates && typeof dates.addMonths === 'function') {
      var out = dates.addMonths(base, delta);
      return monthOf(out);
    }
    var parts = String(base).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1);
  }

  function addDays(dateText, delta) {
    if (dates && typeof dates.addDays === 'function') { return dates.addDays(dateText, delta); }
    var parts = String(dateText).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + delta);
    var mm = d.getMonth() + 1;
    var dd = d.getDate();
    return d.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  }

  function daysInMonth(month) {
    var range = monthRange(month);
    return Number(String(range.end).slice(8, 10)) || 30;
  }

  function axisText(cents) {
    var yuan = (Number(cents) || 0) / 100;
    var abs = Math.abs(yuan);
    if (abs >= 10000) { return (yuan / 10000).toFixed(1) + '万'; }
    if (abs >= 1000) { return Math.round(yuan / 1000) + '千'; }
    return String(Math.round(yuan));
  }

  /* 环比文案：除零一律「—」或「新增」，绝不出现 NaN / Infinity */
  function deltaInfo(delta, goodWhenUp) {
    var d = delta && typeof delta === 'object' ? delta : null;
    if (!d) { return { text: '—', tone: 'flat', arrow: '' }; }
    var current = Number(d.current) || 0;
    var prev = Number(d.prev) || 0;
    if (prev === 0 && current === 0) { return { text: '—', tone: 'flat', arrow: '' }; }
    if (prev === 0) { return { text: '新增', tone: goodWhenUp ? 'good' : 'bad', arrow: '↑' }; }
    var pct = d.deltaPct;
    if (pct === null || pct === undefined || !isFinite(Number(pct))) {
      return { text: '—', tone: 'flat', arrow: '' };
    }
    var value = Number(pct);
    var absText = Math.abs(value).toFixed(1) + '%';
    if (Math.abs(value) < 0.05 || Number(d.deltaCents) === 0) {
      return { text: '持平', tone: 'flat', arrow: '→' };
    }
    var up = value > 0;
    return {
      text: absText,
      tone: (up === !!goodWhenUp) ? 'good' : 'bad',
      arrow: up ? '↑' : '↓'
    };
  }

  /* ---------------- 月份切换 ---------------- */

  function syncTitle(ctx, bookName) {
    if (!ctx || typeof ctx.setTitle !== 'function') { return; }
    var sub = '账本 · ' + bookName;
    try { ctx.setTitle('统计', sub); } catch (error) { /* 忽略 */ }
    global.setTimeout(function () {
      var current = XZB.router && typeof XZB.router.current === 'function' ? XZB.router.current() : null;
      if (current && current.view === 'stats') {
        try { ctx.setTitle('统计', sub); } catch (error) { /* 忽略 */ }
      }
    }, 0);
  }

  function shiftMonth(delta) {
    var next = addMonths(S.month, delta);
    if (next < MONTH_MIN) { return; }
    var limit = monthOf(todayStr());
    if (limit && next > limit) { return; }
    S.month = next;
    paint();
  }

  function buildMonthBar(month, limitMonth) {
    var wrap = el('div', { className: 's-stats-month' });

    var prevBtn = el('button', {
      className: 's-stats-month__btn',
      type: 'button',
      'aria-label': '上一个月'
    }, [iconNode('chevron-left', 20)]);
    prevBtn.addEventListener('click', function () { shiftMonth(-1); });
    if (month <= MONTH_MIN) { prevBtn.disabled = true; }
    wrap.appendChild(prevBtn);

    wrap.appendChild(el('span', {
      className: 's-stats-month__label',
      text: monthLabel(month),
      aria: { live: 'polite' }
    }));

    var nextBtn = el('button', {
      className: 's-stats-month__btn',
      type: 'button',
      'aria-label': '下一个月'
    }, [iconNode('chevron-right', 20)]);
    nextBtn.addEventListener('click', function () { shiftMonth(1); });
    if (limitMonth && month >= limitMonth) {
      nextBtn.disabled = true;
      nextBtn.setAttribute('aria-disabled', 'true');
    }
    wrap.appendChild(nextBtn);
    return wrap;
  }

  /* ---------------- 顶部：类型分段 ---------------- */

  function buildKindSeg() {
    var seg = el('div', {
      className: 'c-segmented s-stats-seg',
      role: 'tablist',
      'aria-label': '统计口径'
    });
    var options = [
      { key: 'expense', label: '支出' },
      { key: 'income', label: '收入' }
    ];
    for (var i = 0; i < options.length; i += 1) {
      (function (option) {
        var btn = el('button', {
          className: 'c-segmented__item' + (S.kind === option.key ? ' is-active' : ''),
          type: 'button',
          role: 'tab',
          text: option.label
        });
        btn.setAttribute('aria-selected', S.kind === option.key ? 'true' : 'false');
        btn.addEventListener('click', function () {
          if (S.kind === option.key) { return; }
          S.kind = option.key;
          paint();
        });
        seg.appendChild(btn);
      }(options[i]));
    }
    return seg;
  }

  /* ---------------- 合计卡 + 环比 ---------------- */

  function buildSummary(summary, mom, kind, month, today) {
    var card = el('section', {
      className: 'c-card s-stats-summary',
      'aria-label': (kind === 'expense' ? '本月支出' : '本月收入') + '合计'
    });

    var total = kind === 'expense' ? Number(summary.expenseCents) || 0 : Number(summary.incomeCents) || 0;
    var current = month === monthOf(today);
    var elapsed = current ? (Number(String(today).slice(8, 10)) || 1) : daysInMonth(month);
    var dailyCents = elapsed > 0 ? Math.round(total / elapsed) : 0;
    var delta = deltaInfo(kind === 'expense' ? mom.expense : mom.income, kind === 'income');

    var head = el('div', { className: 's-stats-summary__head' });
    head.appendChild(el('span', {
      className: 's-stats-summary__label',
      text: (current ? '本月' : monthShort(month)) + (kind === 'expense' ? '支出' : '收入')
    }));
    /* 环比 pill：上涨/多花 = 黄底黑字（强提醒），下降 = 灰底 */
    var momLine = el('span', {
      className: 's-stats-summary__mom c-delta-pill' +
        (delta.arrow === '↑' ? '' : ' c-delta-pill--down')
    });
    momLine.appendChild(el('span', { className: 's-stats-summary__arrow', text: delta.arrow || '·' }));
    momLine.appendChild(el('span', { text: delta.text }));
    momLine.appendChild(el('span', {
      className: 's-stats-summary__mom-label',
      text: ' 较上月'
    }));
    head.appendChild(momLine);
    card.appendChild(head);

    card.appendChild(el('p', {
      className: 's-stats-summary__value u-tabular',
      text: fmt(total)
    }));

    var meta = el('div', { className: 's-stats-summary__meta' });
    meta.appendChild(el('span', { className: 's-stats-summary__meta-cell', text: '日均 ' + fmt(dailyCents) }));
    meta.appendChild(el('span', { className: 's-stats-summary__meta-cell', text: '共 ' + Number(summary.count || 0) + ' 笔' }));
    if (kind === 'expense') {
      /* D2：独立环比卡删除后，收入/结余的环比压缩进合计卡的辅助行 */
      meta.appendChild(el('span', { className: 's-stats-summary__meta-cell', text: '结余 ' + fmt(summary.netCents) }));
      var incomeDelta = deltaInfo(mom.income, true);
      if (incomeDelta.text !== '—') {
        meta.appendChild(el('span', {
          className: 's-stats-summary__meta-cell',
          text: '收入较上月 ' + incomeDelta.arrow + incomeDelta.text
        }));
      }
    } else {
      var expenseDelta = deltaInfo(mom.expense, false);
      if (expenseDelta.text !== '—') {
        meta.appendChild(el('span', {
          className: 's-stats-summary__meta-cell',
          text: '支出较上月 ' + expenseDelta.arrow + expenseDelta.text
        }));
      }
    }
    card.appendChild(meta);
    return card;
  }

  /* ---------------- 趋势 ---------------- */

  function trendData(db, month, bookId) {
    var range = monthRange(month);
    var opts = {
      from: range.start,
      to: range.end,
      granularity: 'month'
    };
    if (bookId) { opts.bookId = bookId; }
    if (S.range === 'mon') {
      opts.granularity = 'day';
    } else {
      opts.from = addMonths(month, -(12 - 1)) + '-01';
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

  function labelText(label, granularity) {
    if (granularity === 'month') { return monthShort(label); }
    var parts = String(label || '').split('-');
    if (parts.length === 3) { return Number(parts[2]) + '日'; }
    return String(label || '');
  }

  function buildTrendCard(db, month, bookId) {
    var card = el('section', { className: 'c-card s-stats-trend', 'aria-label': '收支趋势' });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '收支趋势' }));

    var modeWrap = el('div', { className: 'c-card__action s-stats-trend__modes' });
    var modes = [
      { key: 'line', label: '折线' },
      { key: 'bars', label: '柱状' }
    ];
    for (var m = 0; m < modes.length; m += 1) {
      (function (mode) {
        var btn = el('button', {
          className: 's-stats-trend__btn' + (S.trend === mode.key ? ' is-active' : ''),
          type: 'button',
          text: mode.label
        });
        btn.setAttribute('aria-pressed', S.trend === mode.key ? 'true' : 'false');
        btn.addEventListener('click', function () {
          if (S.trend === mode.key) { return; }
          S.trend = mode.key;
          paint();
        });
        modeWrap.appendChild(btn);
      }(modes[m]));
    }
    head.appendChild(modeWrap);
    card.appendChild(head);

    var rangeSeg = el('div', { className: 'c-segmented s-stats-trend__seg', role: 'tablist', 'aria-label': '趋势范围' });
    var ranges = [
      { key: '12', label: '近 12 月' },
      { key: 'mon', label: '本月按日' }
    ];
    for (var r = 0; r < ranges.length; r += 1) {
      (function (range) {
        var btn = el('button', {
          className: 'c-segmented__item' + (S.range === range.key ? ' is-active' : ''),
          type: 'button',
          role: 'tab',
          text: range.label
        });
        btn.setAttribute('aria-selected', S.range === range.key ? 'true' : 'false');
        btn.addEventListener('click', function () {
          if (S.range === range.key) { return; }
          S.range = range.key;
          paint();
        });
        rangeSeg.appendChild(btn);
      }(ranges[r]));
    }
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

    var charts = chartsApi();
    var kindName = S.kind === 'expense' ? '支出' : '收入';
    card.__paint = function () {
      if (!charts || typeof charts.line !== 'function') { return; }
      var width = box.clientWidth || 320;
      if (S.trend === 'bars') {
        var data = [];
        var source = S.kind === 'expense' ? expenseValues : incomeValues;
        for (var b = 0; b < labels.length; b += 1) {
          data.push({
            label: labelText(labels[b], trend.granularity),
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
          ariaLabel: monthLabel(month) + kindName + '柱状趋势，共 ' + data.length + ' 个时间点'
        });
        return;
      }
      var list = [
        { key: 'income', name: '收入', values: incomeValues, color: '--c-text-2' },
        { key: 'expense', name: '支出', values: expenseValues, color: '--c-tint' }
      ];
      var displayLabels = [];
      for (var t = 0; t < labels.length; t += 1) {
        displayLabels.push(labelText(labels[t], trend.granularity));
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
        /* M7：点按折线附近显示该时间点的收支 */
        onPick: function (index) {
          var label = labels[index] || '';
          var income = Number(incomeValues[index]) || 0;
          var expense = Number(expenseValues[index]) || 0;
          toast(labelText(label, trend.granularity) + ' · 支出 ' + fmt(expense) + ' · 收入 ' + fmt(income), { type: 'info' });
        }
      });
    };
    return card;
  }

  /* ---------------- 环比卡 ---------------- */

  /* 月度小结：默认折叠成一行结论（› 展开），不挡首屏图表。 */
  function buildMonthNote(summary, mom, rank) {
    var expense = Math.abs(Number(summary.expenseCents) || 0);
    if (expense <= 0) { return null; }

    var d = mom && mom.expense ? Number(mom.expense.deltaPct) : null;
    var brief = '本月支出 ' + fmt(expense);
    if (d !== null && isFinite(d)) {
      brief += Math.abs(d) < 0.05
        ? '，和上月基本持平'
        : ('，比上月' + (d > 0 ? '多花 ' : '少花 ') + Math.abs(d).toFixed(1) + '%');
    }

    var card = el('section', { className: 'c-card s-stats-note', 'aria-label': '本月小结' });
    card.setAttribute('data-open', '0');
    var head = el('button', { className: 's-stats-note__head', type: 'button' });
    head.setAttribute('aria-expanded', 'false');
    head.appendChild(el('span', { className: 's-stats-note__brief', text: brief + ' ›' }));
    card.appendChild(head);

    var body = el('div', { className: 's-stats-note__body' });
    var lines = [brief + '。'];

    var items = rank && Array.isArray(rank.items) ? rank.items : [];
    if (items.length) {
      var top = items[0];
      var share = Math.round(Math.abs(Number(top.amountCents) || 0) / expense * 100);
      lines.push('花得最多的是' + (top.name || '未分类') + '，占 ' + share + '%，一共 ' + fmt(top.amountCents) + '。');
    }

    var isCurrent = S.month === monthOf(todayStr());
    var elapsed = isCurrent ? (Number(String(todayStr()).slice(8, 10)) || 1) : daysInMonth(S.month);
    if (elapsed > 0) {
      lines.push('平均每天 ' + fmt(Math.round(expense / elapsed)) + '。');
    }

    for (var i = 0; i < lines.length; i += 1) {
      body.appendChild(el('p', { className: 's-stats-note__line', text: lines[i] }));
    }
    card.appendChild(body);

    head.addEventListener('click', function () {
      var open = card.getAttribute('data-open') === '1';
      card.setAttribute('data-open', open ? '0' : '1');
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    return card;
  }

  /* 待报销：只统计「垫付未报」的支出。入账流水这一轮不生成，所以这里只提示、不假装已收。 */
  function buildReimburseCard(db, month, bookId) {
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

    /* 黄色横幅一行（S1：待报销不再占独立卡片） */
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

  /* D2（2026-10-25）：独立的「环比」卡删除——合计卡里已有本口径环比，
     收入/结余的环比压缩为合计卡 meta 里的一行辅助信息（见 buildSummary）。 */

  /* ---------------- 分类排行 ---------------- */

  function rankMomText(amount, prevAmount) {
    var prev = Number(prevAmount) || 0;
    var cur = Number(amount) || 0;
    if (prev === 0 && cur === 0) { return { text: '—', tone: 'flat' }; }
    if (prev === 0) { return { text: '新增', tone: 'bad' }; }
    var pct = (cur - prev) / Math.abs(prev) * 100;
    if (!isFinite(pct)) { return { text: '—', tone: 'flat' }; }
    if (Math.abs(pct) < 0.05) { return { text: '持平', tone: 'flat' }; }
    return {
      text: (pct > 0 ? '↑' : '↓') + Math.abs(pct).toFixed(0) + '%',
      tone: pct > 0 ? 'bad' : 'good'
    };
  }

  function buildRankCard(rank, prevRank, kind) {
    var card = el('section', {
      className: 'c-card s-stats-rank',
      'aria-label': (kind === 'expense' ? '支出' : '收入') + '分类排行'
    });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '分类排行' }));
    head.appendChild(el('a', {
      className: 'c-card__action',
      href: '#/ledger',
      text: '看明细',
      'aria-label': '查看流水明细'
    }));
    card.appendChild(head);

    var prevMap = Object.create(null);
    var prevItems = prevRank && Array.isArray(prevRank.items) ? prevRank.items : [];
    for (var p = 0; p < prevItems.length; p += 1) {
      if (prevItems[p] && prevItems[p].categoryId) {
        prevMap[prevItems[p].categoryId] = Number(prevItems[p].amountCents) || 0;
      }
    }

    var items = rank && Array.isArray(rank.items) ? rank.items : [];
    var otherCents = rank ? Math.abs(Number(rank.otherCents) || 0) : 0;
    var body = el('div', { className: 'c-card__body s-stats-rank__list' });

    if (!items.length && otherCents <= 0) {
      body.appendChild(el('p', {
        className: 's-stats-empty',
        text: kind === 'expense' ? '这个月还没有支出' : '这个月还没有收入'
      }));
      card.appendChild(body);
      return card;
    }

    var maxAmount = 1;
    for (var m = 0; m < items.length; m += 1) {
      maxAmount = Math.max(maxAmount, Number(items[m].amountCents) || 0);
    }

    /* M6：默认只显示前 5，展开后再看全部 */
    var shown = S.rankOpen ? items : items.slice(0, RANK_FOLDED);
    for (var i = 0; i < shown.length; i += 1) {
      var item = shown[i] || {};
      var amount = Math.abs(Number(item.amountCents) || 0);
      var pct = Number(item.pct) || 0;
      var width = Math.max(0, Math.min(100, amount / maxAmount * 100));
      var momInfo = rankMomText(amount, prevMap[item.categoryId]);
      var slot = item.slot || (i % 12) + 1;

      var row = el('a', {
        className: 's-stats-rank__row',
        href: '#/ledger?ca=' + encodeURIComponent(String(item.categoryId || '')),
        'aria-label': (i + 1) + ' 名 ' + String(item.name || '未分类') + '，' +
          fmt(amount) + '，占 ' + pct.toFixed(1) + '%，较上月 ' + momInfo.text
      });
      row.appendChild(el('span', { className: 's-stats-rank__no u-tabular', text: String(i + 1) }));

      var iconBox = el('span', {
        className: 's-stats-rank__icon s-stats-rank--' + ((slot - 1) % 12 + 1)
      });
      iconBox.appendChild(iconNode(item.icon || 'tag', 18));
      row.appendChild(iconBox);

      var main = el('span', { className: 's-stats-rank__main' });
      var top = el('span', { className: 's-stats-rank__top' });
      top.appendChild(el('span', { className: 's-stats-rank__name u-ellipsis', text: String(item.name || '未分类') }));
      top.appendChild(el('span', { className: 's-stats-rank__amount u-tabular', text: fmt(amount) }));
      main.appendChild(top);

      var bar = el('span', { className: 's-stats-rank__bar' });
      var fill = el('span', {
        className: 's-stats-rank__fill s-stats-rank--' + ((slot - 1) % 12 + 1)
      });
      fill.style.width = width.toFixed(1) + '%';
      bar.appendChild(fill);
      main.appendChild(bar);

      var foot = el('span', { className: 's-stats-rank__foot' });
      foot.appendChild(el('span', { className: 's-stats-rank__pct u-tabular', text: pct.toFixed(1) + '%' }));
      foot.appendChild(el('span', {
        className: 's-stats-rank__mom s-stats-rank__mom--' + momInfo.tone,
        text: '较上月 ' + momInfo.text
      }));
      main.appendChild(foot);
      row.appendChild(main);
      body.appendChild(row);
    }

    if (otherCents > 0) {
      var otherRow = el('div', { className: 's-stats-rank__row s-stats-rank__row--other' });
      otherRow.appendChild(el('span', { className: 's-stats-rank__no', text: '·' }));
      var otherIcon = el('span', { className: 's-stats-rank__icon s-stats-rank--2' });
      otherIcon.appendChild(iconNode('ellipsis', 18));
      otherRow.appendChild(otherIcon);
      var otherMain = el('span', { className: 's-stats-rank__main' });
      var otherTop = el('span', { className: 's-stats-rank__top' });
      otherTop.appendChild(el('span', { className: 's-stats-rank__name', text: '其他' }));
      otherTop.appendChild(el('span', { className: 's-stats-rank__amount u-tabular', text: fmt(otherCents) }));
      otherMain.appendChild(otherTop);
      otherMain.appendChild(el('span', {
        className: 's-stats-rank__foot',
        text: '其余分类合计'
      }));
      otherRow.appendChild(otherMain);
      body.appendChild(otherRow);
    }

    if (items.length > RANK_FOLDED) {
      var toggleRow = el('div', { className: 's-stats-rank__toggle' });
      var toggleBtn = el('button', {
        className: 's-stats-rank__toggle-btn',
        type: 'button',
        text: S.rankOpen ? '收起排行' : '展开全部（' + items.length + ' 个分类）'
      });
      toggleBtn.setAttribute('aria-expanded', S.rankOpen ? 'true' : 'false');
      toggleBtn.addEventListener('click', function () {
        S.rankOpen = !S.rankOpen;
        paint();
      });
      toggleRow.appendChild(toggleBtn);
      body.appendChild(toggleRow);
    }

    card.appendChild(body);
    return card;
  }

  /* D3（2026-10-25）：统计页「账户构成」删除——净资产与账户列表归账户页，
     统计页聚焦本月收支分析（账户页要增强构成见 M11）。 */

  /* ---------------- 日历热图 ---------------- */

  function buildHeatCard(db, month, bookId, today) {
    var card = el('section', { className: 'c-card s-stats-heat', 'aria-label': '每日支出热力图' });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '每天花了多少' }));
    head.appendChild(el('span', { className: 'c-card__action', text: monthShort(month) }));
    card.appendChild(head);

    var box = el('div', { className: 's-stats-heat__box' });
    card.appendChild(box);

    /* M7：深浅图例，不用猜颜色含义 */
    var legend = el('div', { className: 's-stats-heat__legend', 'aria-hidden': 'true' });
    legend.appendChild(el('span', { className: 's-stats-heat__legend-text', text: '少' }));
    legend.appendChild(el('span', { className: 's-stats-heat__legend-bar' }));
    legend.appendChild(el('span', { className: 's-stats-heat__legend-text', text: '多' }));
    card.appendChild(legend);

    /* N4：点某天 → 当天合计 + 查看明细（带日期参数跳明细页） */
    var note = el('p', { className: 's-stats-heat__note', 'aria-live': 'polite' });
    note.appendChild(el('span', { className: 's-stats-heat__note-text', text: '点一格查看当天合计' }));
    card.appendChild(note);

    var heat = null;
    if (stats && typeof stats.calendarHeatmap === 'function') {
      var opts = {};
      if (bookId) { opts.bookId = bookId; }
      heat = stats.calendarHeatmap(db, month, opts);
    }
    if (!heat || !Array.isArray(heat.days)) { heat = { month: month, days: [] }; }

    var dayMap = Object.create(null);
    for (var i = 0; i < heat.days.length; i += 1) {
      var day = heat.days[i];
      if (day && day.date) { dayMap[day.date] = day; }
    }

    var charts = chartsApi();
    var cell = 40;
    card.__paint = function () {
      if (!charts || typeof charts.heatmap !== 'function') { return; }
      var handle = charts.heatmap(box, heat.days, {
        month: month,
        cell: cell,
        gap: 6,
        today: today,
        width: box.clientWidth || 320,
        emptyText: '这个月还没有支出',
        ariaLabel: monthLabel(month) + '每日支出热力图'
      });
      if (handle && handle.svg) {
        bindHeatClick(handle.svg, month, dayMap, cell, note);
      }
    };
    return card;
  }

  function bindHeatClick(svg, month, dayMap, cell, note) {
    if (!svg || !svg.addEventListener) { return; }
    svg.setAttribute('role', 'button');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', monthLabel(month) + '每日支出热力图，点击或回车查看某天合计');

    function pick(ev) {
      var rects = svg.querySelectorAll('rect');
      var cells = [];
      for (var i = 0; i < rects.length; i += 1) {
        var w = Number(rects[i].getAttribute('width'));
        if (w === cell) { cells.push(rects[i]); }
      }
      if (!cells.length) { return; }
      var box = svg.getBoundingClientRect();
      if (!box.width || !box.height) { return; }
      var vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
      var scaleX = vb && vb.width ? vb.width / box.width : 1;
      var scaleY = vb && vb.height ? vb.height / box.height : 1;
      var px = (ev.clientX - box.left) * scaleX;
      var py = (ev.clientY - box.top) * scaleY;
      for (var c = 0; c < cells.length; c += 1) {
        var x = Number(cells[c].getAttribute('x'));
        var y = Number(cells[c].getAttribute('y'));
        if (px >= x && px <= x + cell && py >= y && py <= y + cell) {
          var day = c + 1;
          showHeatDetail(month, day, dayMap, note);
          return;
        }
      }
    }

    svg.addEventListener('click', pick);
    svg.addEventListener('keydown', function (ev) {
      if (!ev || (ev.key !== 'Enter' && ev.key !== ' ')) { return; }
      var days = daysInMonth(month);
      var day = Number(svg.getAttribute('data-day') || '') || 1;
      var next = day >= days ? 1 : day + 1;
      svg.setAttribute('data-day', String(next));
      showHeatDetail(month, next, dayMap, note);
      ev.preventDefault();
    });
  }

  function showHeatDetail(month, day, dayMap, note) {
    var pad = day < 10 ? '0' + day : String(day);
    var date = month + '-' + pad;
    var info = dayMap[date] || { expenseCents: 0, incomeCents: 0, count: 0 };
    var expense = Math.max(0, Number(info.expenseCents) || 0);
    var income = Math.max(0, Number(info.incomeCents) || 0);
    var text = (Number(month.slice(5, 7))) + '月' + day + '日 · 支出 ' + fmt(expense) +
      ' · 收入 ' + fmt(income) + ' · ' + (Number(info.count) || 0) + ' 笔';
    if (!note) { return; }
    clearNode(note);
    note.appendChild(el('span', { className: 's-stats-heat__note-text', text: text }));
    var link = el('a', {
      className: 's-stats-heat__note-link',
      href: '#/ledger?date=' + date,
      text: '查看明细'
    });
    link.setAttribute('aria-label', '查看 ' + date + ' 的流水明细');
    note.appendChild(link);
  }

  /* D4（2026-10-25）：「什么时候花得多」时段分布删除——数据稀疏时结论不可靠
     （常出现单一时段 100%），页面长度还白白变长。 */

  /* ---------------- 空态 ---------------- */

  function buildGlobalEmpty() {
    var box = el('div', { className: 'c-empty s-stats-empty-block' });
    var iconBox = el('div', { className: 'c-empty__icon' });
    iconBox.appendChild(iconNode('chart-line', 44));
    box.appendChild(iconBox);
    box.appendChild(el('p', { className: 'c-empty__title', text: '还没有可以统计的数据' }));
    box.appendChild(el('p', {
      className: 'c-empty__desc',
      text: '记下第一笔以后，这里会按月展示收支趋势、分类排行和每日节奏。'
    }));
    var action = el('div', { className: 'c-empty__action' });
    action.appendChild(el('a', {
      className: 'c-btn c-btn--primary',
      href: '#/add',
      text: '记一笔'
    }));
    box.appendChild(action);
    return box;
  }

  /* ---------------- 渲染 ---------------- */

  function paint() {
    var root = S.root;
    var ctx = S.ctx;
    if (!root) { return; }
    var scrollHost = root.closest ? root.closest('.app-screen') : null;
    var scrollTop = scrollHost ? scrollHost.scrollTop : 0;

    var db = readDb(ctx);
    var today = todayStr();
    var currentMonth = monthOf(today);
    if (!/^\d{4}-\d{2}$/.test(S.month)) { S.month = currentMonth; }
    if (currentMonth && S.month > currentMonth) { S.month = currentMonth; }
    var month = S.month;
    var bookId = activeBookId(db);
    var bookName = bookNameOf(db, bookId);

    var categories = rows(db, 'categories');
    var slots = categorySlots(categories);

    var scope = bookId ? { bookId: bookId } : {};
    var summary = stats && typeof stats.monthSummary === 'function'
      ? stats.monthSummary(db, month, scope)
      : { month: month, incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 };
    var mom = stats && typeof stats.mom === 'function'
      ? stats.mom(db, month, scope)
      : { income: null, expense: null, net: null };
    var rank = stats && typeof stats.categoryRank === 'function'
      ? stats.categoryRank(db, month, { kind: S.kind, limit: RANK_LIMIT, bookId: bookId || undefined })
      : { items: [], otherCents: 0 };
    var prevRank = stats && typeof stats.categoryRank === 'function'
      ? stats.categoryRank(db, addMonths(month, -1), { kind: S.kind, limit: 200, bookId: bookId || undefined })
      : { items: [] };

    /* 分类色槽兜底：stats 返回的 hex 颜色不用，统一按分类顺序取 --cat-N */
    var rankItems = rank && Array.isArray(rank.items) ? rank.items : [];
    for (var ri = 0; ri < rankItems.length; ri += 1) {
      if (rankItems[ri] && slots[rankItems[ri].categoryId]) {
        rankItems[ri].slot = slots[rankItems[ri].categoryId];
      }
    }

    syncTitle(ctx, bookName);

    clearNode(root);
    var inner = el('div', { className: 's-stats-inner' });

    var topBar = el('div', { className: 's-stats-top' });
    topBar.appendChild(buildKindSeg());
    topBar.appendChild(buildMonthBar(month, currentMonth));
    inner.appendChild(topBar);

    /* M6：合计 → （小结紧随合计）→ 趋势 → 排行 → 热力图 */
    inner.appendChild(buildSummary(summary, mom, S.kind, month, today));

    var noteCard = buildMonthNote(summary, mom, rank);
    if (noteCard) { inner.appendChild(noteCard); }

    var reimburseCard = buildReimburseCard(db, month, bookId);
    if (reimburseCard) { inner.appendChild(reimburseCard); }

    var trendCard = buildTrendCard(db, month, bookId);
    inner.appendChild(trendCard);

    inner.appendChild(buildRankCard(rank, prevRank, S.kind));

    var heatCard = buildHeatCard(db, month, bookId, today);
    inner.appendChild(heatCard);

    if (!Number(summary.count)) {
      inner.appendChild(buildGlobalEmpty());
    }

    inner.appendChild(el('p', {
      className: 's-stats-hint',
      text: '数据按当前账本统计，点分类可跳到明细。'
    }));

    root.appendChild(inner);

    /* 图表必须等容器进入 DOM 且拿到宽度后再画 */
    var painters = [trendCard, heatCard];
    for (var p = 0; p < painters.length; p += 1) {
      if (painters[p] && typeof painters[p].__paint === 'function') {
        try { painters[p].__paint(); } catch (error) { /* 单图失败不影响整屏 */ }
      }
    }

    if (scrollHost && scrollTop > 0) { scrollHost.scrollTop = scrollTop; }
  }

  function render(root, ctx) {
    S.root = root || null;
    S.ctx = ctx || null;
    if (!S.root) { return; }
    var currentMonth = monthOf(todayStr());
    if (!/^\d{4}-\d{2}$/.test(S.month)) { S.month = currentMonth; }
    paint();
  }

  /* 数字键盘省下的重复：热图说明里保留一个 aria-live 节点即可 */
  var screen = {
    title: '统计',
    subtitle: '月度分析',
    render: render
  };

  XZB.screens.register('stats', screen);
}(window));
