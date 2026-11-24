/* 小账本 2.40.0 · js/screens/calendar.js
 * 日历记账页：每日净额＝收入−支出（赚钱 + 标红、亏钱 − 标绿，股市惯例，仅本页如此）；
 * 红绿深浅按「月预算 ÷ 当月天数」的日基准分四档；未设预算退回固定档 ¥50/100/200。
 * 点日期展开当日流水（与明细页同一条打开单笔的路径），并可按所选日期补记一笔。
 * 契约：XZB.screens.register('calendar', { title, subtitle, render, destroy })
 * 依赖：XZB.core.{dates,money,stats}、XZB.ui.{icons,sheet}、XZB.app
 * 硬规则：不碰 IndexedDB / localStorage；只读 ctx.db；金额一律整数分；
 *         口径五道过滤（deleted / 账本 / 类型 / 金额 / 日期），转账不计净额。
 */
(function (global) {
  'use strict';

  var XZB = (global.XZB = global.XZB || {});
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] calendar 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var Core = XZB.core || XZB.Core || {};
  var dates = Core.dates || null;
  var money = Core.money || null;
  var stats = Core.stats || null;
  var icons = XZB.ui && XZB.ui.icons ? XZB.ui.icons : null;

  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var MONTH_MIN = '2000-01';
  /* 未设预算时的固定日基准档：¥50 / ¥100 / ¥200 对应 r≤0.5 / ≤1 / ≤2 / >2 */
  var FALLBACK_BASE_CENTS = 10000;
  var WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

  var S = {
    root: null,
    ctx: null,
    dead: false,
    month: '',
    selectedDate: '',
    lastSig: ''
  };

  /* ---------------- 小工具 ---------------- */

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    var options = attrs || {};
    Object.keys(options).forEach(function (key) {
      var value = options[key];
      if (value === null || value === undefined) { return; }
      if (key === 'text') { node.textContent = String(value); }
      else if (key === 'className') { node.className = String(value); }
      else if (key === 'dataset') {
        Object.keys(value).forEach(function (name) { node.dataset[name] = String(value[name]); });
      } else { node.setAttribute(key, String(value)); }
    });
    (kids || []).forEach(function (kid) { if (kid) { node.appendChild(kid); } });
    return node;
  }

  function clearNode(node) {
    if (!node) { return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function iconNode(name, size) {
    if (icons && typeof icons.create === 'function') {
      try { return icons.create(name, { size: size || 16 }); } catch (error) { /* 回落 */ }
    }
    return el('span', { className: 's-cal-glyph', text: String(name || '').slice(0, 1) });
  }

  function fmt(cents) {
    if (money && typeof money.formatCents === 'function') {
      try { return String(money.formatCents(cents, {})); } catch (error) { /* 回落 */ }
    }
    return '¥' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
  }

  function todayStr() {
    if (dates && typeof dates.todayStr === 'function') { return dates.todayStr(); }
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function currentMonth() { return todayStr().slice(0, 7); }
  function isMonth(value) { return MONTH_RE.test(String(value || '')); }

  function addMonth(month, delta) {
    if (!isMonth(month)) { return ''; }
    var y = Number(month.slice(0, 4));
    var m = Number(month.slice(5, 7)) - 1 + delta;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + '-' + (m + 1 < 10 ? '0' : '') + (m + 1);
  }

  function daysInMonth(month) {
    if (!isMonth(month)) { return 30; }
    return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  }

  function monthLabel(month) {
    return isMonth(month) ? Number(month.slice(0, 4)) + '年' + Number(month.slice(5, 7)) + '月' : String(month || '');
  }

  function dateLabel(dateStr) {
    if (!DATE_RE.test(String(dateStr || ''))) { return String(dateStr || ''); }
    var prefix = dateStr.slice(0, 4) === todayStr().slice(0, 4) ? '' : dateStr.slice(0, 4) + '年';
    return prefix + Number(dateStr.slice(5, 7)) + '月' + Number(dateStr.slice(8, 10)) + '日';
  }

  function scopeOf(db) {
    var books = db && Array.isArray(db.books) ? db.books : [];
    var active = '';
    if (db && typeof db.activeBookId === 'string') { active = db.activeBookId; }
    var state = XZB.app && XZB.app.state;
    if (!active && state && state.ui && typeof state.ui.activeBookId === 'string') { active = state.ui.activeBookId; }
    if (!active && state && typeof state.activeBookId === 'string') { active = state.activeBookId; }
    if (!active) {
      for (var i = 0; i < books.length; i += 1) {
        if (books[i] && books[i].archived !== true) { active = String(books[i].id || ''); break; }
      }
    }
    return { bookId: active || '' };
  }

  function sheetApi() {
    return XZB.ui && XZB.ui.sheet ? XZB.ui.sheet : null;
  }

  /* ---------------- 口径与色档 ---------------- */

  /* 日基准＝月预算÷当月天数；未设预算退回固定档。r=|净额|÷日基准，四档 0.5/1/2 */
  function dailyBase(db, month) {
    var budget = stats && typeof stats.budgetProgress === 'function'
      ? stats.budgetProgress(db, month, scopeOf(db))
      : null;
    var total = budget ? Number(budget.totalCents) || 0 : 0;
    if (total > 0) {
      return { baseCents: Math.max(1, Math.round(total / daysInMonth(month))), hasBudget: true };
    }
    return { baseCents: FALLBACK_BASE_CENTS, hasBudget: false };
  }

  function netTier(netCents, baseCents) {
    var r = Math.abs(netCents) / Math.max(1, baseCents);
    if (r <= 0.5) { return 1; }
    if (r <= 1) { return 2; }
    if (r <= 2) { return 3; }
    return 4;
  }

  /* 日历页专用符号：赚钱 +、亏钱 −（与全应用「支出红/收入绿」相反，仅本页） */
  function netText(netCents) {
    if (netCents === 0) { return '¥0'; }
    var yuan = Math.round(Math.abs(netCents) / 100);
    return (netCents > 0 ? '+' : '−') + '¥' + yuan;
  }

  function monthData(db, month) {
    var scope = scopeOf(db);
    var heat = stats && typeof stats.calendarHeatmap === 'function'
      ? stats.calendarHeatmap(db, month, { bookId: scope.bookId })
      : null;
    var days = heat && Array.isArray(heat.days) ? heat.days : [];
    var summary = stats && typeof stats.monthSummary === 'function'
      ? stats.monthSummary(db, month, { bookId: scope.bookId })
      : { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 };
    return { days: days, summary: summary || { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 }, bookId: scope.bookId };
  }

  /* 当日流水：五道过滤，与日历格同源 */
  function dayItems(db, date, bookId) {
    var list = db && Array.isArray(db.transactions) ? db.transactions : [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (bookId && tx.bookId !== bookId) { continue; }
      if (tx.type !== 'income' && tx.type !== 'expense') { continue; }
      var amount = Number(tx.amountCents);
      if (!isFinite(amount) || amount <= 0) { continue; }
      if (String(tx.date || '') !== date) { continue; }
      out.push(tx);
    }
    out.sort(function (a, b) {
      var ta = String(a.time || a.createdAt || '');
      var tb = String(b.time || b.createdAt || '');
      return ta < tb ? 1 : (ta > tb ? -1 : 0);
    });
    return out;
  }

  function categoryMeta(db, id) {
    var list = db && Array.isArray(db.categories) ? db.categories : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function accountName(db, id) {
    var list = db && Array.isArray(db.accounts) ? db.accounts : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) { return String(list[i].name || ''); }
    }
    return '';
  }

  /* ---------------- 画面 ---------------- */

  function summaryStrip(data, base) {
    var strip = el('div', { className: 's-cal-strip' });
    var s = data.summary;
    [
      { label: '支出', cents: s.expenseCents, cls: 'expense' },
      { label: '收入', cents: s.incomeCents, cls: 'income' },
      { label: '结余', cents: s.netCents, cls: s.netCents < 0 ? 'neg' : 'net' }
    ].forEach(function (cell) {
      var box = el('div', { className: 's-cal-strip__cell' });
      box.appendChild(el('span', { className: 's-cal-strip__label', text: cell.label }));
      box.appendChild(el('strong', { className: 's-cal-strip__value u-tabular s-cal-strip__value--' + cell.cls, text: fmt(cell.cents) }));
      strip.appendChild(box);
    });
    var budgetCell = el('div', { className: 's-cal-strip__cell' });
    budgetCell.appendChild(el('span', { className: 's-cal-strip__label', text: '日基准' }));
    if (base.hasBudget) {
      budgetCell.appendChild(el('strong', { className: 's-cal-strip__value u-tabular', text: fmt(base.baseCents) }));
    } else {
      budgetCell.appendChild(el('a', { className: 's-cal-strip__link', href: '#/plan', text: '设预算 ›' }));
    }
    strip.appendChild(budgetCell);
    return strip;
  }

  function buildGrid(data, base) {
    var card = el('section', { className: 'c-card s-cal-gridcard', 'aria-label': monthLabel(S.month) + '收支日历' });
    var week = el('div', { className: 's-cal-week', 'aria-hidden': 'true' });
    WEEKDAYS.forEach(function (w) { week.appendChild(el('span', { text: w })); });
    card.appendChild(week);

    var grid = el('div', { className: 's-cal-grid', role: 'grid', 'aria-label': '每日净额' });
    var days = data.days;
    if (!days.length) { return card; }
    var first = days[0].date;
    var y = Number(first.slice(0, 4));
    var m = Number(first.slice(5, 7));
    var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    var prevMonth = addMonth(S.month, -1);
    var prevDays = daysInMonth(prevMonth);
    var today = todayStr();

    function cell(date, dayNum, inMonth, day) {
      var net = day ? day.netCents : 0;
      var has = day && day.count > 0;
      var tone = !has || net === 0 ? 'neutral' : (net > 0 ? 'r' : 'g') + netTier(net, base.baseCents);
      var btn = el('button', {
        type: 'button',
        className: 's-cal-cell s-cal-cell--' + tone +
          (inMonth ? '' : ' s-cal-cell--out') +
          (date === today ? ' is-today' : '') +
          (date === S.selectedDate ? ' is-selected' : ''),
        disabled: inMonth ? null : 'disabled',
        'aria-label': inMonth ? dateLabel(date) + '，净额 ' + netText(net) + '，' + (day ? day.count : 0) + ' 笔' : null,
        'aria-pressed': date === S.selectedDate ? 'true' : 'false',
        dataset: { date: date }
      });
      btn.appendChild(el('span', { className: 's-cal-cell__day', text: String(dayNum) }));
      if (inMonth) {
        btn.appendChild(el('span', { className: 's-cal-cell__net u-tabular', text: has ? netText(net) : '' }));
        btn.addEventListener('click', function () {
          S.selectedDate = S.selectedDate === date ? '' : date;
          paint();
        });
      }
      return btn;
    }

    for (var l = lead; l > 0; l -= 1) {
      var pd = prevDays - l + 1;
      var pDate = prevMonth + '-' + (pd < 10 ? '0' : '') + pd;
      grid.appendChild(cell(pDate, pd, false, null));
    }
    for (var i = 0; i < days.length; i += 1) {
      grid.appendChild(cell(days[i].date, Number(days[i].date.slice(8, 10)), true, days[i]));
    }
    var tail = (7 - ((lead + days.length) % 7)) % 7;
    var nextMonth = addMonth(S.month, 1);
    for (var t = 1; t <= tail; t += 1) {
      var nDate = nextMonth + '-' + (t < 10 ? '0' : '') + t;
      grid.appendChild(cell(nDate, t, false, null));
    }
    card.appendChild(grid);
    return card;
  }

  function dayPanel(db, data) {
    var date = S.selectedDate;
    var items = dayItems(db, date, data.bookId);
    var card = el('section', { className: 'c-card s-cal-day', 'aria-label': dateLabel(date) + '流水' });
    var day = null;
    for (var i = 0; i < data.days.length; i += 1) {
      if (data.days[i].date === date) { day = data.days[i]; break; }
    }
    var head = el('div', { className: 'c-card__head' });
    var titles = el('div', { className: 's-insights-mod__titles' });
    titles.appendChild(el('h2', { className: 'c-card__title', text: dateLabel(date) }));
    titles.appendChild(el('p', {
      className: 's-insights-mod__sub',
      text: items.length + ' 笔 · 净额 ' + netText(day ? day.netCents : 0)
    }));
    head.appendChild(titles);
    head.appendChild(el('a', {
      className: 's-cal-day__add',
      href: '#/add?date=' + encodeURIComponent(date),
      text: '补一笔'
    }));
    card.appendChild(head);

    if (!items.length) {
      card.appendChild(el('p', { className: 's-insights-muted', text: '这一天还没有收支记录。' }));
      return card;
    }
    var list = el('div', { className: 's-cal-day__list' });
    var meta = {};
    (db.categories || []).forEach(function (c) { if (c && c.id) { meta[c.id] = c; } });
    items.forEach(function (tx) {
      var cat = meta[tx.categoryId];
      var income = tx.type === 'income';
      var row = el('button', { className: 's-cal-tx c-pressable', type: 'button' });
      var chip = el('span', { className: 's-cal-tx__icon' });
      chip.appendChild(iconNode(cat && cat.icon ? cat.icon : (income ? 'coins' : 'tag'), 18));
      row.appendChild(chip);
      var main = el('span', { className: 's-cal-tx__main' });
      main.appendChild(el('span', {
        className: 's-cal-tx__note',
        text: tx.note ? String(tx.note) : (cat ? String(cat.name || '未分类') : '未分类')
      }));
      main.appendChild(el('span', {
        className: 's-cal-tx__meta',
        text: (cat ? String(cat.name || '') : '') + (accountName(db, tx.accountId) ? ' · ' + accountName(db, tx.accountId) : '')
      }));
      row.appendChild(main);
      row.appendChild(el('span', {
        className: 's-cal-tx__amt u-tabular ' + (income ? 's-cal-tx__amt--pos' : 's-cal-tx__amt--neg'),
        text: (income ? '+' : '−') + fmt(tx.amountCents)
      }));
      row.addEventListener('click', function () { openTxSheet(db, tx); });
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
  }

  /* 单笔详情：与明细页同一条编辑路径（#/add?id=） */
  function openTxSheet(db, tx) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var cat = categoryMeta(db, tx.categoryId);
    var income = tx.type === 'income';
    var body = el('div', { className: 's-insights-sheet' });
    body.appendChild(el('p', {
      className: 's-insights-sheet__sum u-tabular',
      text: (income ? '+' : '−') + fmt(tx.amountCents)
    }));
    var rows = el('div', { className: 's-cal-detail' });
    [
      ['日期', dateLabel(tx.date)],
      ['分类', cat ? String(cat.name || '未分类') : '未分类'],
      ['账户', accountName(db, tx.accountId) || '—'],
      ['备注', tx.note ? String(tx.note) : '—']
    ].forEach(function (pair) {
      var row = el('div', { className: 's-cal-detail__row' });
      row.appendChild(el('span', { className: 's-cal-detail__label', text: pair[0] }));
      row.appendChild(el('span', { className: 's-cal-detail__value', text: pair[1] }));
      rows.appendChild(row);
    });
    body.appendChild(rows);
    body.appendChild(el('a', {
      className: 'c-btn c-btn--primary s-cal-detail__edit',
      href: '#/add?id=' + encodeURIComponent(tx.id),
      text: '编辑这笔'
    }));
    sheet.open({
      title: tx.note ? String(tx.note) : (cat ? String(cat.name || '流水') : '流水'),
      content: body,
      ariaLabel: '单笔详情',
      actions: [{ label: '关闭', kind: 'text' }]
    });
  }

  function emptyMonth() {
    var card = el('div', { className: 'c-card s-insights-empty' });
    card.appendChild(el('p', { className: 's-insights-empty__title', text: '这个月还没有记录' }));
    card.appendChild(el('p', { className: 's-insights-empty__text', text: '记一笔之后，日历会按净额标出红绿深浅。' }));
    card.appendChild(el('a', { className: 'c-btn c-btn--primary', href: '#/add', text: '记一笔' }));
    return card;
  }

  /* ---------------- 渲染 ---------------- */

  function paint() {
    if (S.dead || !S.root) { return; }
    var db = (S.ctx && S.ctx.db) || (XZB.app && XZB.app.db && XZB.app.db()) || {};
    clearNode(S.root);
    var wrap = el('div', { className: 's-cal' });

    var head = el('div', { className: 's-cal-head' });
    var prev = el('button', { className: 's-cal-nav', type: 'button', 'aria-label': '上一个月' }, [iconNode('chevron-left', 18)]);
    prev.disabled = addMonth(S.month, -1) < MONTH_MIN;
    prev.addEventListener('click', function () { setMonth(addMonth(S.month, -1)); });
    head.appendChild(prev);
    head.appendChild(el('p', { className: 's-cal-title', text: monthLabel(S.month) }));
    var next = el('button', { className: 's-cal-nav', type: 'button', 'aria-label': '下一个月' }, [iconNode('chevron-right', 18)]);
    next.disabled = S.month >= currentMonth();
    next.addEventListener('click', function () { setMonth(addMonth(S.month, 1)); });
    head.appendChild(next);
    if (S.month !== currentMonth()) {
      var reset = el('button', { className: 's-cal-reset', type: 'button', text: '回本月' });
      reset.addEventListener('click', function () { setMonth(currentMonth()); });
      head.appendChild(reset);
    }
    wrap.appendChild(head);

    var data = monthData(db, S.month);
    var base = dailyBase(db, S.month);
    wrap.appendChild(summaryStrip(data, base));

    var totalCount = 0;
    for (var i = 0; i < data.days.length; i += 1) { totalCount += data.days[i].count; }
    if (!totalCount) {
      wrap.appendChild(emptyMonth());
      S.root.appendChild(wrap);
      return;
    }

    wrap.appendChild(buildGrid(data, base));
    if (S.selectedDate && DATE_RE.test(S.selectedDate) && S.selectedDate.slice(0, 7) === S.month) {
      wrap.appendChild(dayPanel(db, data));
    } else {
      wrap.appendChild(el('p', { className: 's-cal-hint', text: '点日期看当日流水' }));
    }
    S.root.appendChild(wrap);
  }

  function syncHash() {
    if (!S.month) { return; }
    var hash = '#/calendar?m=' + S.month;
    if (global.location.hash !== hash) {
      var router = XZB.router;
      if (router && typeof router.setHash === 'function') {
        if (!router.setHash(hash)) { return; }
      } else {
        try { global.history.replaceState(global.history.state, '', hash); } catch (error) { return; }
      }
    }
    if (S.ctx && S.ctx.route) {
      S.ctx.route.hash = hash;
      S.ctx.route.query = { m: S.month };
      S.ctx.route.params = S.ctx.route.query;
    }
    S.lastSig = S.month;
  }

  function setMonth(month) {
    if (!isMonth(month) || month < MONTH_MIN || month > currentMonth()) { return; }
    if (month === S.month) { return; }
    S.month = month;
    S.selectedDate = '';
    syncHash();
    paint();
  }

  function render(root, ctx) {
    if (!root) { return; }
    S.root = root;
    S.ctx = ctx || null;
    S.dead = false;
    var query = (ctx && ctx.query) || {};
    var sig = String(query.m || '');
    if (sig !== S.lastSig) {
      S.lastSig = sig;
      if (isMonth(query.m) && query.m <= currentMonth()) { S.month = query.m; }
    }
    if (!isMonth(S.month) || S.month > currentMonth()) { S.month = currentMonth(); }
    if (S.selectedDate && S.selectedDate.slice(0, 7) !== S.month) { S.selectedDate = ''; }
    syncHash();
    paint();
    return { destroy: destroy };
  }

  function destroy() {
    S.dead = true;
    S.root = null;
    S.ctx = null;
  }

  var screen = {
    title: '日历',
    subtitle: '每日净额',
    render: render,
    destroy: destroy
  };

  XZB.screens.register('calendar', screen);
}(window));