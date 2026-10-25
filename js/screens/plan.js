/* 小账本 2.0 —— 计划屏：预算 / 存钱目标 / 定期账单
 * 三区纵向排列（iOS 原生观感）。金额一律按整数分处理，展示交给 money.formatCents。
 * 依赖：XZB.screens、XZB.core.{stats,recurrence,schema,money,dates}、XZB.ui.{sheet,toast,icons,charts,dom}、XZB.app.commit。
 * 硬约束：不直连 IndexedDB、不写 localStorage、不拼 innerHTML、不改 TabBar。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB;
  if (!XZB) {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] plan 屏：XZB 未就绪，跳过注册');
    }
    return;
  }
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] plan 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var MONTH_MIN = '2000-01';
  var WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var FREQ_OPTIONS = [
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每周' },
    { value: 'monthly', label: '每月' },
    { value: 'yearly', label: '每年' }
  ];
  var TYPE_OPTIONS = [
    { value: 'expense', label: '支出' },
    { value: 'income', label: '收入' },
    { value: 'transfer', label: '转账' }
  ];
  var MONTH_NAMES = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

  var P = { month: '', root: null, ctx: null };

  /* ============================== API 取用 ============================== */

  function coreApi() {
    return XZB.core || {};
  }

  function uiApi() {
    return XZB.ui || XZB.UI || {};
  }

  function domApi() {
    var ui = uiApi();
    return ui.dom || XZB.dom || null;
  }

  function iconsApi() {
    var ui = uiApi();
    return ui.icons || null;
  }

  function chartsApi() {
    var ui = uiApi();
    return ui.charts || (XZB.UI && XZB.UI.charts) || null;
  }

  function toastApi() {
    var ui = uiApi();
    return ui.toast || null;
  }

  function sheetApi() {
    var ui = uiApi();
    return ui.sheet || null;
  }

  function appApi() {
    return XZB.app || null;
  }

  function statsApi() {
    return coreApi().stats || null;
  }

  function recurrenceApi() {
    return coreApi().recurrence || null;
  }

  function schemaApi() {
    return coreApi().schema || null;
  }

  function moneyApi() {
    var core = coreApi();
    return core.money || XZB.money || null;
  }

  function datesApi() {
    var core = coreApi();
    return core.dates || XZB.dates || null;
  }

  /* ============================== DOM 工具 ============================== */

  function isNodeLike(value) {
    return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
  }

  function applyAttrs(node, attrs) {
    if (!node || !attrs) { return; }
    Object.keys(attrs).forEach(function (key) {
      if (key === 'className' || key === 'class' || key === 'text' || key === 'children' ||
          key === 'dataset' || key === 'aria' || key === 'role' || key === 'style' || key === 'html') {
        return;
      }
      var value = attrs[key];
      if (value === undefined || value === null || value === false) { return; }
      try {
        node.setAttribute(key, value === true ? '' : String(value));
      } catch (error) {
        /* 非法属性名直接跳过 */
      }
    });
  }

  function el(tag, attrs, kids) {
    var d = domApi();
    if (d && typeof d.el === 'function') {
      try {
        return d.el(tag, attrs || {}, kids);
      } catch (error) {
        /* 退化到自建节点 */
      }
    }
    var node = document.createElement(String(tag || 'div'));
    var options = attrs || {};
    if (options.className || options['class']) {
      node.className = String(options.className || options['class']);
    }
    if (options.role) { node.setAttribute('role', String(options.role)); }
    if (options.dataset && typeof options.dataset === 'object') {
      Object.keys(options.dataset).forEach(function (key) {
        node.setAttribute('data-' + key.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }), String(options.dataset[key]));
      });
    }
    if (options.aria && typeof options.aria === 'object') {
      Object.keys(options.aria).forEach(function (key) {
        var value = options.aria[key];
        if (value === undefined || value === null || value === false) { return; }
        node.setAttribute('aria-' + key, value === true ? 'true' : String(value));
      });
    }
    applyAttrs(node, options);
    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }
    appendAll(node, kids !== undefined && kids !== null ? kids : options.children);
    return node;
  }

  function frag(kids) {
    var d = domApi();
    if (d && typeof d.frag === 'function') {
      try { return d.frag(kids); } catch (error) { /* fall through */ }
    }
    var fragment = document.createDocumentFragment();
    appendAll(fragment, kids);
    return fragment;
  }

  function appendAll(node, kids) {
    if (!node || kids === undefined || kids === null || kids === false) { return node; }
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i++) { appendAll(node, kids[i]); }
      return node;
    }
    if (isNodeLike(kids)) {
      node.appendChild(kids);
      return node;
    }
    node.appendChild(document.createTextNode(String(kids)));
    return node;
  }

  function clearNode(node) {
    if (!node) { return; }
    var d = domApi();
    if (d && typeof d.clear === 'function') {
      try { d.clear(node); return; } catch (error) { /* fall through */ }
    }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function iconNode(name, size) {
    var api = iconsApi();
    var key = String(name || 'tag');
    if (api && typeof api.node === 'function') {
      try { return api.node(key, { size: size || 20 }); } catch (error) { /* fall through */ }
    }
    var span = el('span', { className: 's-plan-icon', 'aria-hidden': 'true' });
    span.style.width = (size || 20) + 'px';
    span.style.height = (size || 20) + 'px';
    return span;
  }

  function toast(message, options) {
    var api = toastApi();
    if (api && typeof api.show === 'function') {
      try { api.show(String(message), options || {}); return; } catch (error) { /* fall through */ }
    }
    if (P.ctx && typeof P.ctx.toast === 'function') {
      try { P.ctx.toast(String(message), options || {}); } catch (error2) { /* noop */ }
    }
  }

  function undoToast(message) {
    var app = appApi();
    toast(message, {
      type: 'success',
      action: {
        label: '撤销',
        onClick: function () {
          if (app && typeof app.undo === 'function') {
            try { app.undo(); } catch (error) { toast('撤销失败，请重试', { type: 'danger' }); }
          }
        }
      }
    });
  }

  /* ============================== 数据读取 ============================== */

  function readDb(ctx) {
    if (ctx && ctx.db) { return ctx.db; }
    var app = appApi();
    if (app && typeof app.db === 'function') {
      try { return app.db() || {}; } catch (error) { return {}; }
    }
    return {};
  }

  function rows(db, key) {
    if (!db || !Array.isArray(db[key])) { return []; }
    return db[key].filter(function (row) { return !!row; });
  }

  function listOf(working, key) {
    if (!working[key] || !Array.isArray(working[key])) { working[key] = []; }
    return working[key];
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === String(id)) { return i; }
    }
    return -1;
  }

  function indexById(list) {
    var map = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id) { map[String(list[i].id)] = list[i]; }
    }
    return map;
  }

  function activeBookId(db) {
    var app = appApi();
    if (app && app.state && app.state.ui && app.state.ui.activeBookId) {
      return String(app.state.ui.activeBookId);
    }
    var settings = (db && db.settings) || {};
    if (settings.activeBookId) { return String(settings.activeBookId); }
    if (settings.currentBookId) { return String(settings.currentBookId); }
    var books = rows(db, 'books');
    for (var i = 0; i < books.length; i++) {
      if (books[i].archived !== true && books[i].id) { return String(books[i].id); }
    }
    return '';
  }

  function bookNameOf(db) {
    var id = activeBookId(db);
    var books = rows(db, 'books');
    for (var i = 0; i < books.length; i++) {
      if (String(books[i].id) === id) { return String(books[i].name || '账本'); }
    }
    return '账本';
  }

  /* ============================== 金额 / 日期 ============================== */

  function fmt(cents) {
    var m = moneyApi();
    if (m && typeof m.formatCents === 'function') {
      try { return m.formatCents(cents); } catch (error) { /* fall through */ }
    }
    var n = Math.round(Number(cents) || 0);
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n) / 100;
    return sign + '¥' + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function yuanInt(cents) {
    var n = Math.round((Number(cents) || 0) / 100);
    var sign = n < 0 ? '-' : '';
    return sign + '¥' + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function yuanText(cents) {
    var n = Number(cents) || 0;
    if (!n) { return ''; }
    return (n / 100).toFixed(2);
  }

  /* 只用整数与字符串算分，禁止 parseFloat(x)*100（红线 3：金额不得浮点乘除）。
     第三位小数起四舍五入进位，避免 12.345 被静默截断成 12.34。 */
  function parseCents(text) {
    var raw = String(text === undefined || text === null ? '' : text);
    var cleaned = raw.replace(/[^0-9.]/g, '');
    if (!cleaned) { return NaN; }
    var dot = cleaned.indexOf('.');
    var intPart = dot >= 0 ? cleaned.slice(0, dot) : cleaned;
    var decPart = dot >= 0 ? cleaned.slice(dot + 1).replace(/\./g, '') : '';
    if (intPart === '') { intPart = '0'; }
    if (intPart.length > 9) { return NaN; }
    var cents = parseInt(intPart, 10) * 100;
    if (!isFinite(cents)) { return NaN; }
    if (decPart.length === 0) { return cents; }
    var d1 = parseInt(decPart.charAt(0) || '0', 10) || 0;
    var d2 = parseInt(decPart.charAt(1) || '0', 10) || 0;
    var d3 = parseInt(decPart.charAt(2) || '0', 10) || 0;
    cents += d1 * 10 + d2;
    if (d3 >= 5) { cents += 1; }
    return cents < 0 ? NaN : cents;
  }

  function pctText(used, total) {
    var t = Number(total) || 0;
    if (!(t > 0)) { return '0%'; }
    var pct = Math.round(((Number(used) || 0) / t) * 100);
    if (!isFinite(pct)) { return '0%'; }
    return (pct > 999 ? 999 : pct) + '%';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + String(n); }

  function pad4(n) { return String(n); }

  function todayStr() {
    var d = datesApi();
    if (d && typeof d.todayStr === 'function') {
      try { return d.todayStr(); } catch (error) { /* fall through */ }
    }
    var now = new Date();
    return pad4(now.getFullYear()) + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function currentMonth() {
    return String(todayStr()).slice(0, 7);
  }

  function monthOf(value) {
    return String(value || '').slice(0, 7);
  }

  function monthLabel(month) {
    var parts = String(month || '').split('-');
    if (parts.length < 2) { return ''; }
    return parts[0] + '年' + Number(parts[1]) + '月';
  }

  function shiftMonthKey(month, delta) {
    var d = datesApi();
    if (d && typeof d.addMonths === 'function') {
      try { return String(d.addMonths(month + '-01', delta)).slice(0, 7); } catch (error) { /* fall through */ }
    }
    var parts = String(month || currentMonth()).split('-');
    var year = Number(parts[0]) || 2026;
    var mon = Number(parts[1]) || 1;
    var total = year * 12 + (mon - 1) + delta;
    var nextYear = Math.floor(total / 12);
    var nextMon = total - nextYear * 12 + 1;
    return pad4(nextYear) + '-' + pad2(nextMon);
  }

  function parseISO(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    if (!match) { return null; }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function addDays(dateStr, days) {
    var base = parseISO(dateStr);
    if (!base) { return dateStr; }
    var next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Number(days || 0));
    return String(next.getFullYear()) + '-' + pad2(next.getMonth() + 1) + '-' + pad2(next.getDate());
  }

  function dayDiff(fromStr, toStr) {
    var from = parseISO(fromStr);
    var to = parseISO(toStr);
    if (!from || !to) { return 0; }
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  function humanDate(dateStr) {
    var d = datesApi();
    if (d && typeof d.formatHuman === 'function') {
      try { return d.formatHuman(dateStr); } catch (error) { /* fall through */ }
    }
    return String(dateStr || '');
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (error) { return todayStr(); }
  }

  /* ============================== 写入 ============================== */

  function commitRun(mutator, label) {
    var app = appApi();
    var ctx = P.ctx || {};
    var commitFn = typeof ctx.commit === 'function' ? ctx.commit : (app && app.commit);
    if (typeof commitFn !== 'function') {
      toast('存储还没准备好，请稍后再试', { type: 'danger' });
      return Promise.resolve(null);
    }
    var pending;
    try {
      pending = commitFn.call(ctx, mutator, { label: label });
    } catch (error) {
      pending = Promise.reject(error);
    }
    return Promise.resolve(pending).then(function (result) {
      if (!result || result.ok !== true) {
        var message = (result && result.message) || '保存失败，请重试';
        toast(message, { type: 'danger' });
        return null;
      }
      return result;
    }, function () {
      toast('保存失败，请重试', { type: 'danger' });
      return null;
    });
  }

  /* ============================== 表单零件 ============================== */

  function fieldRow(labelText, control, unitText) {
    var row = el('div', { className: 'c-field s-plan-field' });
    row.appendChild(el('span', { className: 'c-field__label', text: labelText }));
    var controlBox = el('span', { className: 'c-field__control' });
    if (unitText) { controlBox.appendChild(el('span', { className: 'c-field__unit', text: unitText })); }
    if (control) { controlBox.appendChild(control); }
    row.appendChild(controlBox);
    return row;
  }

  function fieldStack(labelText, control) {
    var row = el('div', { className: 'c-field c-field--stack s-plan-field' });
    row.appendChild(el('span', { className: 'c-field__label', text: labelText }));
    var controlBox = el('span', { className: 'c-field__control' });
    if (control) { controlBox.appendChild(control); }
    row.appendChild(controlBox);
    return row;
  }

  function hintNode(text) {
    return el('p', { className: 's-plan-hint', text: text });
  }

  /* 区块说明 ⓘ：不占版面的常驻文字，点击弹 sheet（P1：删大段说明） */
  function infoButton(text) {
    var btn = el('button', {
      className: 's-plan-info',
      type: 'button',
      'aria-label': '说明'
    });
    btn.appendChild(iconNode('info', 16));
    btn.addEventListener('click', function () {
      openSheet('说明', el('p', { className: 's-plan-note', text: text }));
    });
    return btn;
  }

  function errorNode() {
    var node = el('p', { className: 's-plan-error', role: 'alert' });
    node.hidden = true;
    return node;
  }

  function showError(node, message) {
    if (!node) { return; }
    if (!message) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = String(message);
  }

  function amountInput(cents) {
    return el('input', {
      className: 'c-field__input s-plan-amount',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      placeholder: '0.00',
      value: yuanText(cents),
      'aria-label': '金额'
    });
  }

  function textInput(value, placeholder, ariaLabel) {
    var attrs = {
      className: 'c-field__input',
      type: 'text',
      autocomplete: 'off',
      value: value === undefined || value === null ? '' : String(value)
    };
    if (placeholder) { attrs.placeholder = placeholder; }
    if (ariaLabel) { attrs['aria-label'] = ariaLabel; }
    return el('input', attrs);
  }

  function dateInput(value) {
    return el('input', {
      className: 'c-field__input s-plan-date',
      type: 'date',
      value: value || todayStr(),
      'aria-label': '日期'
    });
  }

  function numberInput(value, min, max) {
    return el('input', {
      className: 'c-field__input s-plan-number',
      type: 'number',
      inputmode: 'numeric',
      min: String(min),
      max: String(max),
      step: '1',
      value: String(value)
    });
  }

  function selectInput(options, value, ariaLabel) {
    var select = el('select', { className: 'c-field__input s-plan-select' });
    if (ariaLabel) { select.setAttribute('aria-label', ariaLabel); }
    options.forEach(function (option) {
      var node = el('option', { value: String(option.value), text: String(option.label) });
      select.appendChild(node);
    });
    select.value = String(value);
    return select;
  }

  function segmentedControl(items, active, onPick) {
    var wrap = el('div', { className: 'c-segmented s-plan-segmented', role: 'tablist' });
    items.forEach(function (item) {
      var isActive = String(item.value) === String(active);
      var button = el('button', {
        className: 'c-segmented__item' + (isActive ? ' is-active' : ''),
        type: 'button',
        role: 'tab',
        text: item.label,
        'aria-selected': isActive ? 'true' : 'false'
      });
      button.addEventListener('click', function () {
        var buttons = wrap.querySelectorAll('.c-segmented__item');
        for (var i = 0; i < buttons.length; i++) {
          buttons[i].classList.remove('is-active');
          buttons[i].setAttribute('aria-selected', 'false');
        }
        button.classList.add('is-active');
        button.setAttribute('aria-selected', 'true');
        if (typeof onPick === 'function') { onPick(item.value); }
      });
      wrap.appendChild(button);
    });
    return wrap;
  }

  function switchControl(checked, ariaLabel, onChange) {
    var button = el('button', {
      className: 'c-switch',
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': ariaLabel || '开关'
    });
    button.addEventListener('click', function (event) {
      if (event && typeof event.preventDefault === 'function') { event.preventDefault(); }
      if (event && typeof event.stopPropagation === 'function') { event.stopPropagation(); }
      var next = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', next ? 'true' : 'false');
      if (typeof onChange === 'function') { onChange(next); }
    });
    return button;
  }

  function primaryButton(label, onClick, extraClass) {
    var button = el('button', {
      className: 'c-btn c-btn--primary c-btn--block s-plan-submit' + (extraClass ? ' ' + extraClass : ''),
      type: 'button',
      text: label
    });
    button.addEventListener('click', function () { if (typeof onClick === 'function') { onClick(); } });
    return button;
  }

  function ghostButton(label, onClick, extraClass) {
    var button = el('button', {
      className: 'c-btn c-btn--text s-plan-ghost' + (extraClass ? ' ' + extraClass : ''),
      type: 'button',
      text: label
    });
    button.addEventListener('click', function () { if (typeof onClick === 'function') { onClick(); } });
    return button;
  }

  function iconButton(iconName, ariaLabel, onClick) {
    var button = el('button', { className: 's-plan-iconbtn', type: 'button', 'aria-label': ariaLabel });
    button.appendChild(iconNode(iconName, 22));
    button.addEventListener('click', function () { if (typeof onClick === 'function') { onClick(); } });
    return button;
  }

  function formWrap(kids) {
    var wrap = el('div', { className: 's-plan-form' });
    appendAll(wrap, kids);
    return wrap;
  }

  function openSheet(title, content) {
    var api = sheetApi();
    if (!api || typeof api.open !== 'function') {
      toast('弹层组件还没准备好', { type: 'danger' });
      return null;
    }
    return api.open({
      title: title,
      content: content,
      actions: [{ label: '取消', kind: 'text' }]
    });
  }

  function closeSheet(handle) {
    if (handle && typeof handle.close === 'function') {
      try { handle.close('done'); return; } catch (error) { /* noop */ }
    }
    var api = sheetApi();
    if (api && typeof api.close === 'function') {
      try { api.close(); } catch (error2) { /* noop */ }
    }
  }

  /* ============================== 标题 ============================== */

  function syncTitle(ctx, db) {
    if (!ctx || typeof ctx.setTitle !== 'function') { return; }
    var subtitle = bookNameOf(db);
    try { ctx.setTitle('计划', subtitle); } catch (error) { /* noop */ }
    global.setTimeout(function () {
      var router = XZB.router;
      if (!router || typeof router.current !== 'function') { return; }
      var current = router.current();
      if (current && current.view === 'plan' && typeof ctx.setTitle === 'function') {
        try { ctx.setTitle('计划', subtitle); } catch (error2) { /* noop */ }
      }
    }, 0);
  }

  /* ============================== 月份切换 ============================== */

  function shiftMonth(delta) {
    var next = shiftMonthKey(P.month, delta);
    if (next < MONTH_MIN) { next = MONTH_MIN; }
    if (next > currentMonth()) { next = currentMonth(); }
    if (next === P.month) { return; }
    P.month = next;
    paint();
  }

  function buildMonthBar() {
    var bar = el('div', { className: 's-plan-monthbar' });
    bar.appendChild(iconButton('chevron-left', '上一月', function () { shiftMonth(-1); }));
    bar.appendChild(el('span', { className: 's-plan-monthbar__label', text: monthLabel(P.month), 'aria-live': 'polite' }));
    var nextDisabled = P.month >= currentMonth();
    var next = iconButton('chevron-right', '下一月', function () { shiftMonth(1); });
    if (nextDisabled) {
      next.disabled = true;
      next.setAttribute('aria-disabled', 'true');
    }
    bar.appendChild(next);
    return bar;
  }

  /* ============================== 预算 ============================== */

  function findBudget(db, month, bookId) {
    var list = rows(db, 'budgets');
    for (var i = 0; i < list.length; i++) {
      if (monthOf(list[i].month) === month && String(list[i].bookId) === String(bookId)) { return list[i]; }
    }
    return null;
  }

  function findCategoryBudgets(db, month, bookId) {
    return rows(db, 'categoryBudgets').filter(function (row) {
      return monthOf(row.month) === month && String(row.bookId) === String(bookId);
    });
  }

  function budgetOfSource(db, month, bookId) {
    var api = statsApi();
    var progress = null;
    if (api && typeof api.budgetProgress === 'function') {
      try { progress = api.budgetProgress(db, month, { bookId: bookId }); } catch (error) { progress = null; }
    }
    if (!progress) {
      progress = { month: month, bookId: bookId, totalCents: 0, spentCents: 0, remainingCents: 0, pct: 0, state: 'none', items: [] };
    }
    if (!Array.isArray(progress.items)) { progress.items = []; }
    return progress;
  }

  function buildBudgetCard(ctx, progress) {
    var total = Math.max(0, Number(progress.totalCents) || 0);
    var spent = Math.max(0, Number(progress.spentCents) || 0);
    var remain = Math.max(0, total - spent);
    var over = spent > total;
    var state = String(progress.state || (over ? 'over' : 'safe'));
    var tone = over || state === 'over' ? '--c-danger' : (state === 'warn' ? '--c-warn' : '--c-tint');
    var card = el('div', { className: 'c-card s-plan-budget' + (over ? ' s-plan-budget--over' : '') });

    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '本月预算' }));
    var edit = el('button', { className: 'c-card__action s-plan-edit', type: 'button', text: '编辑' });
    edit.addEventListener('click', function () { openBudgetForm(ctx); });
    head.appendChild(edit);
    card.appendChild(head);

    var body = el('div', { className: 's-plan-budget__body' });
    var ring = el('div', { className: 's-plan-ring s-plan-ring--budget' });
    ring.setAttribute('data-plan-ring', '1');
    ring.setAttribute('data-value', String(spent));
    ring.setAttribute('data-total', String(total));
    ring.setAttribute('data-size', '120');
    ring.setAttribute('data-tone', tone);
    ring.setAttribute('data-sub', '已用');
    ring.setAttribute('data-pct', pctText(spent, total));
    ring.setAttribute('data-aria', '预算进度环：已用 ' + fmt(spent) + '，预算 ' + fmt(total) + (over ? '，已超支' : ''));
    body.appendChild(ring);

    var nums = el('div', { className: 's-plan-budget__nums' });
    nums.appendChild(el('span', { className: 's-plan-budget__spent', text: yuanInt(spent) }));
    nums.appendChild(el('span', { className: 's-plan-budget__meta', text: '已用 / 共 ' + yuanInt(total) }));
    nums.appendChild(el('span', { className: 's-plan-budget__remain', text: over ? '剩余 ' + yuanInt(0) : '剩余 ' + yuanInt(remain) }));
    if (over) {
      nums.appendChild(el('span', {
        className: 's-plan-badge-over',
        text: '已超支 ' + fmt(spent - total),
        role: 'status'
      }));
    }
    body.appendChild(nums);
    card.appendChild(body);

    if (over) {
      card.appendChild(el('p', { className: 's-plan-budget__over', text: '这个月已经超过总预算，看看哪些分类还能收一收。' }));
    }
    return card;
  }

  function buildBudgetEmpty(ctx, db, bookId, month) {
    var prevMonth = shiftMonthKey(month, -1);
    var prevBudget = findBudget(db, prevMonth, bookId);
    var prevCats = findCategoryBudgets(db, prevMonth, bookId);
    var card = el('div', { className: 'c-card s-plan-budget s-plan-budget--empty' });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '本月预算' }));
    card.appendChild(head);
    card.appendChild(hintNode('还没有设置这个月的总预算。'));
    card.appendChild(primaryButton('设置月度预算', function () { openBudgetForm(ctx); }));
    if (prevBudget && Number(prevBudget.totalCents) > 0) {
      var carry = ghostButton('沿用上月（' + yuanInt(prevBudget.totalCents) + '）', function () {
        carryOverBudget(ctx, bookId, month, prevBudget, prevCats);
      });
      carry.classList.add('s-plan-carry');
      card.appendChild(carry);
      card.appendChild(hintNode('会把上月的总预算与 ' + prevCats.length + ' 条分类预算复制到本月。'));
    }
    return card;
  }

  function carryOverBudget(ctx, bookId, month, prevBudget, prevCats) {
    var schema = schemaApi();
    if (!schema || typeof schema.createBudget !== 'function') {
      toast('数据层还没准备好', { type: 'danger' });
      return;
    }
    var total = Math.max(0, Number(prevBudget.totalCents) || 0);
    var carryCats = prevCats.filter(function (row) { return Number(row.amountCents) > 0; });
    var created = commitRun(function (working) {
      var budgets = listOf(working, 'budgets');
      if (findBudget({ budgets: budgets }, month, bookId)) {
        return { abort: true, code: 'E_BUDGET_EXISTS', message: '这个月已经有预算了' };
      }
      budgets.push(schema.createBudget({ bookId: bookId, month: month, totalCents: total }));
      var catList = listOf(working, 'categoryBudgets');
      carryCats.forEach(function (row) {
        var exists = findCategoryBudgets({ categoryBudgets: catList }, month, bookId).some(function (item) {
          return String(item.categoryId) === String(row.categoryId);
        });
        if (exists) { return; }
        catList.push(schema.createCategoryBudget({
          bookId: bookId,
          month: month,
          categoryId: row.categoryId,
          amountCents: Math.max(0, Number(row.amountCents) || 0),
          thresholdPct: Number(row.thresholdPct) || 80
        }));
      });
      return { value: { total: total, cats: carryCats.length } };
    }, '沿用上月预算').then(function (result) {
      if (!result) { return; }
      toast('已沿用上月预算', { type: 'success' });
    });
    return created;
  }

  function buildCategoryList(ctx, db, bookId, progress, categoryBudgets) {
    var list = el('div', { className: 'c-list s-plan-cats' });
    list.appendChild(el('div', { className: 'c-list__header', text: '分类预算' }));
    var entityByCategory = {};
    categoryBudgets.forEach(function (entity) {
      entityByCategory[String(entity.categoryId)] = entity;
    });
    var items = (progress.items || []).filter(function (item) { return !!item && !!item.categoryId; });
    items.forEach(function (item) {
      list.appendChild(buildCategoryRow(ctx, bookId, item, entityByCategory[String(item.categoryId)] || null));
    });
    var add = el('button', { className: 'c-row c-row--tappable c-row--compact s-plan-cats__add', type: 'button' });
    var addMain = el('span', { className: 'c-row__main' });
    addMain.appendChild(el('span', { className: 'c-row__title', text: '添加分类预算' }));
    add.appendChild(addMain);
    add.addEventListener('click', function () { openCategoryBudgetForm(ctx, bookId, progress.month, null); });
    list.appendChild(add);
    if (!items.length) {
      list.appendChild(el('p', { className: 's-plan-cats__hint', text: '给餐饮、交通这些大头各设一个上限，超了会标红提醒。' }));
    }
    return list;
  }

  function findCategoryById(ctx, categoryId) {
    var db = ctx && ctx.db ? ctx.db : null;
    var list = db && db.categories ? db.categories : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === categoryId) { return list[i]; }
    }
    return null;
  }

  function buildCategoryRow(ctx, bookId, item, entity) {
    var limit = Math.max(0, Number(item.limitCents) || 0);
    var spent = Math.max(0, Number(item.spentCents) || 0);
    var pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    var over = limit > 0 && spent > limit;
    var state = String(item.state || (over ? 'over' : (pct >= 80 ? 'warn' : 'safe')));
    var row = el('button', {
      className: 'c-row c-row--two-line c-row--tappable s-plan-cat' + (over ? ' s-plan-cat--over' : ''),
      type: 'button'
    });
    var iconBox = el('span', { className: 'c-row__icon s-plan-cat__icon' });
    var cat = findCategoryById(ctx, item.categoryId);
    if (cat && cat.color) { iconBox.style.color = cat.color; }
    iconBox.appendChild(iconNode(cat && cat.icon ? cat.icon : 'tag', 20));
    row.appendChild(iconBox);

    var main = el('span', { className: 'c-row__main' });
    main.appendChild(el('span', { className: 'c-row__title', text: String(item.name || '未分类') }));
    var barWrap = el('span', { className: 's-plan-cat__bar' });
    var barClass = 'c-progress s-plan-cat__progress';
    if (over || state === 'over') { barClass += ' c-progress--danger'; }
    else if (state === 'warn') { barClass += ' c-progress--warn'; }
    var bar = el('span', { className: barClass });
    var fill = el('span', { className: 'c-progress__bar' });
    fill.style.transform = 'scaleX(' + (pct > 100 ? 100 : (pct < 0 ? 0 : pct)) / 100 + ')';
    bar.appendChild(fill);
    barWrap.appendChild(bar);
    main.appendChild(barWrap);
    /* M10：不只给百分比——直接给「剩余 / 日均还可花」的可行动读数 */
    main.appendChild(el('span', { className: 's-plan-cat__pace', text: categoryPaceText(limit, spent, over) }));
    if (over) {
      main.appendChild(el('span', { className: 's-plan-cat__over', text: '超支 ' + yuanInt(spent - limit).replace('¥', '') + ' 元' }));
    }
    row.appendChild(main);

    var trail = el('span', { className: 's-plan-cat__trail' });
    trail.appendChild(el('span', { className: 's-plan-cat__amount', text: yuanInt(spent) + ' / ' + yuanInt(limit) }));
    trail.appendChild(el('span', { className: 's-plan-cat__pct' + (over ? ' s-plan-cat__pct--over' : '') + (state === 'warn' && !over ? ' s-plan-cat__pct--warn' : ''), text: pct + '%' }));
    row.appendChild(trail);

    row.addEventListener('click', function () {
      openCategoryBudgetForm(ctx, bookId, progressMonthOf(item) || P.month, entity || {
        categoryId: item.categoryId,
        amountCents: limit,
        month: P.month
      });
    });
    return row;
  }

  /* 剩余 X · 日均还可花 Y（只在当月有预算且未超支时给日均；日均按本月剩余天数摊） */
  function categoryPaceText(limit, spent, over) {
    if (!(limit > 0)) { return ''; }
    if (over) { return ''; }
    var left = limit - spent;
    var today = todayStr();
    var monthKey = monthOf(today);
    var isCurrent = String(P.month) === String(monthKey);
    var dayNum = isCurrent ? (Number(String(today).slice(8, 10)) || 1) : 30;
    var daysTotal = 0;
    if (isCurrent) {
      daysTotal = new Date(Number(String(monthKey).slice(0, 4)), Number(String(monthKey).slice(5, 7)), 0).getDate();
    } else {
      daysTotal = new Date(Number(String(P.month).slice(0, 4)), Number(String(P.month).slice(5, 7)), 0).getDate();
    }
    var daysLeft = Math.max(1, daysTotal - dayNum + 1);
    var daily = Math.floor(left / daysLeft);
    var pace = '剩余 ' + yuanInt(left).replace('¥', '') + ' 元';
    if (isCurrent && daily >= 0) {
      pace += ' · 日均还可花 ' + yuanInt(daily).replace('¥', '') + ' 元';
    }
    return pace;
  }

  function progressMonthOf() {
    return P.month;
  }

  function openBudgetForm(ctx) {
    var db = readDb(ctx);
    var bookId = activeBookId(db);
    var month = P.month;
    var budget = findBudget(db, month, bookId);
    var input = amountInput(budget ? budget.totalCents : 0);
    var error = errorNode();
    var body = formWrap([
      hintNode(monthLabel(month) + ' 的总预算'),
      fieldRow('月度总预算', input, '¥'),
      hintNode('只影响预算进度，不会产生流水。'),
      error,
      primaryButton(budget ? '保存预算' : '设置预算', function () { save(); })
    ]);
    var handle = openSheet(budget ? '编辑月度预算' : '设置月度预算', body);

    function save() {
      var schema = schemaApi();
      var cents = parseCents(input.value);
      if (!isFinite(cents) || cents <= 0) {
        showError(error, '请输入大于 0 的预算金额');
        return;
      }
      if (!schema || typeof schema.createBudget !== 'function') {
        showError(error, '数据层还没准备好');
        return;
      }
      showError(error, '');
      commitRun(function (working) {
        var budgets = listOf(working, 'budgets');
        var found = findBudget({ budgets: budgets }, month, bookId);
        if (found) {
          found.totalCents = cents;
          found.updatedAt = nowIso();
          return { value: found.id };
        }
        var created = schema.createBudget({ bookId: bookId, month: month, totalCents: cents });
        budgets.push(created);
        return { value: created.id };
      }, budget ? '修改月度预算' : '设置月度预算').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        toast(budget ? '预算已更新' : '预算已设置', { type: 'success' });
      });
    }
  }

  function openCategoryBudgetForm(ctx, bookId, month, entity) {
    var db = readDb(ctx);
    var categories = rows(db, 'categories').filter(function (row) {
      return row && row.hidden !== true && row.kind === 'expense';
    });
    if (!categories.length) {
      toast('还没有支出分类，先去设置里加一个', { type: 'warning' });
      return;
    }
    var current = entity && entity.categoryId ? String(entity.categoryId) : String(categories[0].id);
    var options = categories.map(function (row) {
      return { value: String(row.id), label: String(row.name || '未命名分类') };
    });
    var categorySelect = selectInput(options, current, '分类');
    var amountBox = amountInput(entity ? entity.amountCents : 0);
    var error = errorNode();
    var editing = !!(entity && entity.id);
    var nodes = [
      hintNode(monthLabel(month) + ' 的分类上限'),
      fieldRow('分类', categorySelect),
      fieldRow('预算金额', amountBox, '¥'),
      hintNode(entity && entity.thresholdPct ? '达到 ' + entity.thresholdPct + '% 时提醒' : '达到 80% 时提醒'),
      error
    ];
    if (editing) {
      nodes.push(el('div', { className: 's-plan-form__row' }, [
        ghostButton('删除这条分类预算', function () { remove(); }, 's-plan-danger-text')
      ]));
    }
    nodes.push(primaryButton(editing ? '保存' : '添加分类预算', function () { save(); }));
    var body = formWrap(nodes);
    var handle = openSheet(editing ? '编辑分类预算' : '添加分类预算', body);

    function save() {
      var schema = schemaApi();
      var cents = parseCents(amountBox.value);
      if (!isFinite(cents) || cents <= 0) {
        showError(error, '请输入大于 0 的预算金额');
        return;
      }
      if (!schema || typeof schema.createCategoryBudget !== 'function') {
        showError(error, '数据层还没准备好');
        return;
      }
      showError(error, '');
      var categoryId = String(categorySelect.value);
      commitRun(function (working) {
        var list = listOf(working, 'categoryBudgets');
        var found = null;
        for (var i = 0; i < list.length; i++) {
          if (monthOf(list[i].month) === month && String(list[i].bookId) === String(bookId) &&
              String(list[i].categoryId) === categoryId) { found = list[i]; break; }
        }
        if (found) {
          found.amountCents = cents;
          found.updatedAt = nowIso();
          return { value: found.id };
        }
        var created = schema.createCategoryBudget({
          bookId: bookId,
          month: month,
          categoryId: categoryId,
          amountCents: cents
        });
        list.push(created);
        return { value: created.id };
      }, editing ? '修改分类预算' : '添加分类预算').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        toast(editing ? '分类预算已更新' : '分类预算已添加', { type: 'success' });
      });
    }

    function remove() {
      commitRun(function (working) {
        var list = listOf(working, 'categoryBudgets');
        var idx = -1;
        for (var i = 0; i < list.length; i++) {
          if (monthOf(list[i].month) === month && String(list[i].bookId) === String(bookId) &&
              String(list[i].categoryId) === String(entity.categoryId)) { idx = i; break; }
        }
        if (idx < 0) { return { abort: true, code: 'E_NOT_FOUND', message: '这条分类预算已经不在了' }; }
        list.splice(idx, 1);
        return { value: true };
      }, '删除分类预算').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        undoToast('已删除分类预算');
      });
    }
  }

  /* ============================== 存钱目标 ============================== */

  function buildGoals(ctx, db, bookId) {
    var section = el('section', { className: 's-plan-section s-plan-section--goal' });
    var goalHead = el('div', { className: 's-plan-heading-row' });
    goalHead.appendChild(el('h2', { className: 's-plan-heading s-plan-heading--inline', text: '存钱目标' }));
    goalHead.appendChild(infoButton('仅记录目标进度，不联动账户余额。存入目标只更新这里的进度，账户余额保持不变。'));
    section.appendChild(goalHead);

    var goals = rows(db, 'goals').filter(function (row) {
      return row && row.archived !== true && String(row.bookId) === String(bookId);
    }).sort(function (a, b) {
      var sa = Number(a.sort) || 10;
      var sb = Number(b.sort) || 10;
      if (sa !== sb) { return sa - sb; }
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
    var deposits = rows(db, 'goalDeposits').filter(function (row) { return row.deleted !== true; });

    if (!goals.length) {
      var empty = el('div', { className: 'c-card s-plan-goal-empty' });
      empty.appendChild(el('p', { className: 's-plan-goal-empty__title', text: '还没有存钱目标' }));
      empty.appendChild(hintNode('设一个目标，每次存钱记一笔，进度会留在这里。'));
      section.appendChild(empty);
    } else {
      goals.forEach(function (goal) {
        section.appendChild(buildGoalCard(ctx, goal, deposits));
      });
    }
    section.appendChild(primaryButton(goals.length ? '新建存钱目标' : '新建目标', function () {
      openGoalForm(ctx, bookId, null);
    }));
    return section;
  }

  function goalStats(goal, deposits) {
    var api = statsApi();
    var mine = deposits.filter(function (row) { return String(row.goalId) === String(goal.id); });
    var progress = null;
    if (api && typeof api.goalProgress === 'function') {
      try { progress = api.goalProgress(goal, mine); } catch (error) { progress = null; }
    }
    if (!progress) {
      var saved = 0;
      mine.forEach(function (row) { saved += Math.max(0, Number(row.amountCents) || 0); });
      progress = {
        goalId: goal.id,
        targetCents: Math.max(0, Number(goal.targetCents) || 0),
        savedCents: saved,
        remainingCents: Math.max(0, (Number(goal.targetCents) || 0) - saved),
        pct: goal.targetCents > 0 ? Math.round((saved / goal.targetCents) * 100) : 0,
        depositCount: mine.length,
        lastDepositDate: null,
        state: saved >= (Number(goal.targetCents) || 0) && goal.targetCents > 0 ? 'done' : 'active'
      };
    }
    return { progress: progress, mine: mine };
  }

  function goalEta(deposits, target, saved) {
    if (target > 0 && saved >= target) { return '已达成'; }
    if (!(saved > 0) || !deposits.length) { return '—'; }
    var first = '';
    deposits.forEach(function (row) {
      var text = String(row.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) { return; }
      if (!first || text < first) { first = text; }
    });
    if (!first) { return '—'; }
    var days = dayDiff(first, todayStr()) + 1;
    if (!(days > 0)) { return '—'; }
    var rate = saved / days;
    if (!(rate > 0)) { return '—'; }
    var need = Math.ceil((target - saved) / rate);
    if (!isFinite(need) || need < 0 || need > 7300) { return '—'; }
    return humanDate(addDays(todayStr(), need));
  }

  function buildGoalCard(ctx, goal, deposits) {
    var info = goalStats(goal, deposits);
    var progress = info.progress;
    var target = Math.max(0, Number(progress.targetCents) || 0);
    var saved = Math.max(0, Number(progress.savedCents) || 0);
    var pct = target > 0 ? Math.round((saved / target) * 100) : 0;
    var done = target > 0 && saved >= target;

    var card = el('div', { className: 'c-card s-plan-goal' + (done ? ' s-plan-goal--done' : '') });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title s-plan-goal__name', text: String(goal.name || '存钱目标') }));
    var detail = el('button', { className: 'c-card__action s-plan-goal__detail', type: 'button', text: '详情' });
    detail.addEventListener('click', function () { openGoalDetail(ctx, goal); });
    head.appendChild(detail);
    card.appendChild(head);

    var body = el('div', { className: 's-plan-goal__body' });
    var ring = el('div', { className: 's-plan-ring s-plan-ring--goal' });
    ring.setAttribute('data-plan-ring', '1');
    ring.setAttribute('data-value', String(saved));
    ring.setAttribute('data-total', String(target));
    ring.setAttribute('data-size', '88');
    ring.setAttribute('data-tone', done ? '--c-success' : '--c-tint');
    ring.setAttribute('data-sub', '已存');
    ring.setAttribute('data-pct', pct + '%');
    ring.setAttribute('data-aria', '目标进度环：' + String(goal.name || '存钱目标') + ' 已存 ' + fmt(saved) + '，目标 ' + fmt(target));
    body.appendChild(ring);

    var stats = el('div', { className: 's-plan-goal__stats' });
    stats.appendChild(goalStatRow('目标', fmt(target)));
    stats.appendChild(goalStatRow('已存', fmt(saved), 's-plan-goal__value--strong'));
    stats.appendChild(goalStatRow('进度', pct + '%'));
    stats.appendChild(goalStatRow('预计达成', goalEta(info.mine, target, saved)));
    body.appendChild(stats);
    card.appendChild(body);

    var foot = el('div', { className: 'c-card__foot s-plan-goal__foot' });
    var saveBtn = el('button', { className: 'c-btn c-btn--primary c-btn--sm s-plan-goal__save', type: 'button', text: '存入一笔' });
    saveBtn.addEventListener('click', function () { openDepositForm(ctx, goal); });
    foot.appendChild(saveBtn);
    foot.appendChild(ghostButton('编辑目标', function () { openGoalForm(ctx, goal.bookId, goal); }, 's-plan-goal__edit'));
    card.appendChild(foot);
    return card;
  }

  function goalStatRow(label, value, extraClass) {
    var row = el('div', { className: 's-plan-goal__row' });
    row.appendChild(el('span', { className: 's-plan-goal__label', text: label }));
    row.appendChild(el('span', { className: 's-plan-goal__stat' + (extraClass ? ' ' + extraClass : ''), text: value }));
    return row;
  }

  function openGoalForm(ctx, bookId, goal) {
    var schema = schemaApi();
    var nameInput = textInput(goal ? goal.name : '', '例如：换新电脑', '目标名称');
    var amountBox = amountInput(goal ? goal.targetCents : 0);
    var deadline = dateInput(goal && goal.deadline ? goal.deadline : '');
    if (!goal || !goal.deadline) { deadline.value = ''; }
    var error = errorNode();
    var nodes = [
      fieldRow('名称', nameInput),
      fieldRow('目标金额', amountBox, '¥'),
      fieldRow('截止日期（可选）', deadline),
      hintNode('到期日只用于提醒，不会自动记账。'),
      error,
      primaryButton(goal ? '保存目标' : '创建目标', function () { save(); })
    ];
    if (goal) {
      nodes.splice(nodes.length - 1, 0, ghostButton('删除目标', function () { remove(); }, 's-plan-danger-text'));
    }
    var body = formWrap(nodes);
    var handle = openSheet(goal ? '编辑存钱目标' : '新建存钱目标', body);

    function save() {
      var name = String(nameInput.value || '').trim();
      var cents = parseCents(amountBox.value);
      if (!name) { showError(error, '请填写目标名称'); return; }
      if (!isFinite(cents) || cents <= 0) { showError(error, '请输入大于 0 的目标金额'); return; }
      if (!schema || typeof schema.createGoal !== 'function') { showError(error, '数据层还没准备好'); return; }
      var deadlineValue = String(deadline.value || '').trim();
      if (deadlineValue && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineValue)) { deadlineValue = ''; }
      showError(error, '');
      commitRun(function (working) {
        var list = listOf(working, 'goals');
        if (goal) {
          var idx = indexOfId(list, goal.id);
          if (idx < 0) { return { abort: true, code: 'E_NOT_FOUND', message: '这个目标已经不在了' }; }
          list[idx].name = name;
          list[idx].targetCents = cents;
          list[idx].deadline = deadlineValue || null;
          list[idx].updatedAt = nowIso();
          return { value: list[idx].id };
        }
        var created = schema.createGoal({
          bookId: bookId,
          name: name,
          targetCents: cents,
          deadline: deadlineValue || null,
          accountId: null
        });
        list.push(created);
        return { value: created.id };
      }, goal ? '编辑存钱目标' : '新建存钱目标').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        toast(goal ? '目标已更新' : '目标已创建', { type: 'success' });
      });
    }

    function remove() {
      commitRun(function (working) {
        var list = listOf(working, 'goals');
        var idx = indexOfId(list, goal.id);
        if (idx < 0) { return { abort: true, code: 'E_NOT_FOUND', message: '这个目标已经不在了' }; }
        list[idx].archived = true;
        list[idx].updatedAt = nowIso();
        return { value: true };
      }, '删除存钱目标').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        undoToast('已删除目标');
      });
    }
  }

  function openDepositForm(ctx, goal) {
    var schema = schemaApi();
    var amountBox = amountInput(0);
    var dateBox = dateInput(todayStr());
    var noteInput = textInput('', '可选，例如：发工资存一笔', '备注');
    var error = errorNode();
    var body = formWrap([
      hintNode('存入「' + String(goal.name || '存钱目标') + '」'),
      fieldRow('金额', amountBox, '¥'),
      fieldRow('日期', dateBox),
      fieldRow('备注', noteInput),
      el('p', { className: 's-plan-hint s-plan-hint--strong', text: '仅记录目标进度，不联动账户余额。' }),
      error,
      primaryButton('确认存入', function () { save(); })
    ]);
    var handle = openSheet('存入一笔', body);

    function save() {
      var cents = parseCents(amountBox.value);
      var dateValue = String(dateBox.value || '').trim();
      if (!isFinite(cents) || cents <= 0) { showError(error, '请输入大于 0 的金额'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) { showError(error, '请选择存入日期'); return; }
      if (!schema || typeof schema.createGoalDeposit !== 'function') { showError(error, '数据层还没准备好'); return; }
      showError(error, '');
      commitRun(function (working) {
        var list = listOf(working, 'goalDeposits');
        var created = schema.createGoalDeposit({
          goalId: goal.id,
          amountCents: cents,
          date: dateValue,
          note: String(noteInput.value || '').trim()
        });
        list.push(created);
        return { value: created.id };
      }, '存入存钱目标').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        toast('已存入 ' + fmt(cents), { type: 'success' });
      });
    }
  }

  function openGoalDetail(ctx, goal) {
    var db = readDb(ctx);
    var mine = rows(db, 'goalDeposits').filter(function (row) {
      return row.deleted !== true && String(row.goalId) === String(goal.id);
    }).sort(function (a, b) {
      var da = String(a.date || '');
      var dbb = String(b.date || '');
      if (da !== dbb) { return da < dbb ? 1 : -1; }
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    var info = goalStats(goal, rows(db, 'goalDeposits').filter(function (row) { return row.deleted !== true; }));
    var target = Math.max(0, Number(info.progress.targetCents) || 0);
    var saved = Math.max(0, Number(info.progress.savedCents) || 0);
    var pct = target > 0 ? Math.round((saved / target) * 100) : 0;

    var ring = el('div', { className: 's-plan-ring s-plan-ring--detail' });
    ring.setAttribute('data-plan-ring', '1');
    ring.setAttribute('data-value', String(saved));
    ring.setAttribute('data-total', String(target));
    ring.setAttribute('data-size', '140');
    ring.setAttribute('data-tone', saved >= target && target > 0 ? '--c-success' : '--c-tint');
    ring.setAttribute('data-sub', '已存');
    ring.setAttribute('data-pct', pct + '%');
    ring.setAttribute('data-aria', '目标进度环：已存 ' + fmt(saved) + '，目标 ' + fmt(target));

    var headBlock = el('div', { className: 's-plan-detail__head' });
    headBlock.appendChild(ring);
    var headNums = el('div', { className: 's-plan-detail__nums' });
    headNums.appendChild(el('span', { className: 's-plan-detail__saved', text: fmt(saved) }));
    headNums.appendChild(el('span', { className: 's-plan-detail__meta', text: '已存 / 目标 ' + fmt(target) }));
    headNums.appendChild(el('span', { className: 's-plan-detail__eta', text: '预计达成 ' + goalEta(mine, target, saved) }));
    headNums.appendChild(el('span', { className: 's-plan-detail__count', text: '共 ' + mine.length + ' 笔存入' }));
    headBlock.appendChild(headNums);

    var actions = el('div', { className: 's-plan-detail__actions' });
    var addBtn = el('button', { className: 'c-btn c-btn--primary c-btn--block', type: 'button', text: '存入一笔' });
    addBtn.addEventListener('click', function () { closeSheet(handle); openDepositForm(ctx, goal); });
    actions.appendChild(addBtn);
    actions.appendChild(el('p', { className: 's-plan-hint s-plan-hint--strong', text: '仅记录目标进度，不联动账户余额。' }));

    var nodes = [headBlock, actions];
    var list = el('div', { className: 'c-list s-plan-deposits' });
    list.appendChild(el('div', { className: 'c-list__header', text: '存入记录' }));
    if (!mine.length) {
      list.appendChild(el('p', { className: 's-plan-deposits__empty', text: '还没有存入记录。' }));
    }
    mine.forEach(function (deposit) {
      list.appendChild(buildDepositRow(ctx, goal, deposit, function () {
        closeSheet(handle);
        global.setTimeout(function () { openGoalDetail(ctx, goal); }, 80);
      }));
    });
    nodes.push(list);
    var body = formWrap(nodes);
    var handle = openSheet(String(goal.name || '存钱目标'), body);
  }

  function buildDepositRow(ctx, goal, deposit, onChanged) {
    var row = el('div', { className: 'c-row c-row--two-line s-plan-deposit' });
    var main = el('div', { className: 'c-row__main' });
    main.appendChild(el('span', { className: 'c-row__title', text: humanDate(deposit.date) }));
    main.appendChild(el('span', { className: 'c-row__sub', text: String(deposit.note || '存入') }));
    row.appendChild(main);
    var trail = el('div', { className: 'c-row__trail s-plan-deposit__trail' });
    trail.appendChild(el('span', { className: 'c-row__value c-row__value--income s-plan-deposit__amount', text: '+' + fmt(deposit.amountCents) }));
    var remove = el('button', { className: 's-plan-deposit__delete', type: 'button', 'aria-label': '删除这条存入记录' });
    remove.appendChild(iconNode('trash', 18));
    remove.addEventListener('click', function () {
      deleteDeposit(ctx, goal, deposit, onChanged);
    });
    trail.appendChild(remove);
    row.appendChild(trail);
    return row;
  }

  function deleteDeposit(ctx, goal, deposit, onChanged) {
    commitRun(function (working) {
      var list = listOf(working, 'goalDeposits');
      var idx = indexOfId(list, deposit.id);
      if (idx < 0) { return { abort: true, code: 'E_NOT_FOUND', message: '这条记录已经不在了' }; }
      if (list[idx].deleted === true) { return { value: true }; }
      list[idx].deleted = true;
      list[idx].deletedAt = nowIso();
      list[idx].updatedAt = nowIso();
      return { value: list[idx].id };
    }, '删除存入记录').then(function (result) {
      if (!result) { return; }
      undoToast('已删除这条存入记录');
      if (typeof onChanged === 'function') { onChanged(); }
    });
  }

  /* ============================== 定期账单 ============================== */

  function recurringRules(db, bookId) {
    return rows(db, 'recurring').filter(function (row) {
      return row && row.archived !== true && String(row.bookId) === String(bookId);
    }).sort(function (a, b) {
      var da = String(a.nextDueDate || '9999-99-99');
      var dbb = String(b.nextDueDate || '9999-99-99');
      if (da !== dbb) { return da < dbb ? -1 : 1; }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function dueRules(db) {
    var api = recurrenceApi();
    if (!api || typeof api.dueInstances !== 'function') { return []; }
    try {
      var list = api.dueInstances(db, todayStr(), {});
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  function buildRecurring(ctx, db, bookId) {
    var section = el('section', { className: 's-plan-section s-plan-section--recurring' });
    var head = el('div', { className: 's-plan-heading-row' });
    head.appendChild(el('h2', { className: 's-plan-heading s-plan-heading--inline', text: '定期账单' }));
    var add = el('button', { className: 'c-btn c-btn--text c-btn--sm s-plan-heading__action', type: 'button', text: '新建' });
    add.addEventListener('click', function () { openRuleForm(ctx, null); });
    head.appendChild(add);
    head.appendChild(infoButton('房租、会员这类固定支出，到日子提醒你入账，也可以自动记。到期待处理的见页面顶部「待处理」。'));
    section.appendChild(head);

    var rules = recurringRules(db, bookId);
    var accounts = indexById(rows(db, 'accounts'));
    var list = el('div', { className: 'c-list s-plan-rules' });
    if (!rules.length) {
      list.appendChild(el('p', { className: 's-plan-rules__empty', text: '还没有定期账单。' }));
    }
    rules.forEach(function (rule) {
      list.appendChild(buildRuleRow(ctx, rule, accounts));
    });
    var addRow = el('button', { className: 'c-row c-row--tappable c-row--compact s-plan-rules__add', type: 'button' });
    var addMain = el('span', { className: 'c-row__main' });
    addMain.appendChild(el('span', { className: 'c-row__title', text: '新建定期账单' }));
    addRow.appendChild(addMain);
    addRow.addEventListener('click', function () { openRuleForm(ctx, null); });
    list.appendChild(addRow);
    section.appendChild(list);
    return section;
  }

  /* ---------------- 待处理区（N5）：逾期 + 7 天内到期，前置到页面顶部 ---------------- */

  function pendingInstances(db, bookId) {
    var today = todayStr();
    return dueRules(db).filter(function (item) {
      if (String(item.bookId) !== String(bookId)) { return false; }
      var diff = dayDiff(item.dueDate, today);
      return diff <= 7;   /* dayDiff>0 = 已到期；负数 = 未来 7 天内 */
    });
  }

  function buildPendingSection(ctx, db, bookId) {
    var due = pendingInstances(db, bookId);
    if (!due.length) { return null; }
    var today = todayStr();
    var section = el('section', { className: 's-plan-section s-plan-section--pending' });

    var card = el('div', { className: 'c-card s-plan-pending' });
    var head = el('div', { className: 'c-card__head' });
    head.appendChild(el('h2', { className: 'c-card__title', text: '待处理 ' + due.length + ' 笔' }));
    var all = el('button', { className: 'c-card__action s-plan-pending__all', type: 'button', text: '一键补账' });
    all.addEventListener('click', function () { catchUpAll(ctx); });
    head.appendChild(all);
    card.appendChild(head);

    var items = el('ul', { className: 's-plan-pending__list' });
    due.slice(0, 5).forEach(function (item) {
      var overdue = dayDiff(item.dueDate, today) > 0;
      var row = el('li', { className: 's-plan-pending__item' + (overdue ? ' s-plan-pending__item--over' : '') });
      var main = el('span', { className: 's-plan-pending__main' });
      main.appendChild(el('span', { className: 's-plan-pending__name', text: String(item.name || '账单') }));
      main.appendChild(el('span', {
        className: 's-plan-pending__meta',
        text: humanDate(item.dueDate) + ' · ' + fmt(item.amountCents) + (overdue ? ' · 已到期' : '')
      }));
      row.appendChild(main);

      var post = el('button', { className: 'c-btn c-btn--primary c-btn--sm s-plan-pending__post', type: 'button', text: '入账' });
      post.setAttribute('aria-label', '入账：' + String(item.name || '账单'));
      post.addEventListener('click', function () { postDue(ctx, item); });
      row.appendChild(post);

      var skip = el('button', { className: 'c-btn c-btn--secondary c-btn--sm s-plan-pending__skip', type: 'button', text: '跳过' });
      skip.setAttribute('aria-label', '跳过本期：' + String(item.name || '账单'));
      skip.addEventListener('click', function () { skipDue(ctx, item); });
      row.appendChild(skip);
      items.appendChild(row);
    });
    card.appendChild(items);

    if (due.length > 5) {
      card.appendChild(el('p', { className: 's-plan-pending__more', text: '还有 ' + (due.length - 5) + ' 笔，点「一键补账」一起记。' }));
    }
    section.appendChild(card);
    return section;
  }

  /* 跳过本期：不落流水，只把规则游标推进到下一期 */
  function skipDue(ctx, item) {
    var rec = recurrenceApi();
    if (!rec || typeof rec.advanceRule !== 'function') {
      toast('周期账单模块还没准备好', { type: 'danger' });
      return;
    }
    commitRun(function (working) {
      var rule = null;
      var list = listOf(working, 'recurring');
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].id) === String(item.ruleId)) { rule = list[i]; break; }
      }
      if (!rule) { return { abort: true, code: 'E_RECURRING_NOT_FOUND', message: '这条账单已经不在了' }; }
      rec.advanceRule(working, rule, item.dueDate, item.periodKey || undefined, {});
      return { value: rule.id };
    }, '跳过本期账单').then(function (result) {
      if (!result) { return; }
      toast('已跳过这一期，下期照常提醒', { type: 'success' });
    });
  }

  /* buildDueCard（2.7 及以前在定期账单区展示待入账）已由页面顶部的
     「待处理」区接管（N5），到期实例不再重复出现。 */

  function buildRuleRow(ctx, rule, accounts) {
    var accountName = accounts[String(rule.accountId)] ? String(accounts[String(rule.accountId)].name) : '未选账户';
    var sub = '';
    var rec = recurrenceApi();
    if (rec && typeof rec.freqText === 'function') {
      try { sub = rec.freqText(rule); } catch (error) { sub = ''; }
    }
    if (!sub) { sub = String(rule.freq || ''); }
    sub = sub + ' · ' + accountName;

    var info = dueInfo(rule);
    var row = el('div', {
      className: 'c-row c-row--two-line c-row--tappable s-plan-rule' + (rule.paused === true ? ' c-row--disabled' : ''),
      role: 'button',
      tabindex: '0',
      'aria-label': String(rule.name || '定期账单') + '，' + sub
    });
    var iconBox = el('span', { className: 'c-row__icon c-row__icon--lg s-plan-rule__icon' });
    iconBox.appendChild(iconNode(rule.type === 'income' ? 'income' : (rule.type === 'transfer' ? 'transfer' : 'repeat'), 22));
    row.appendChild(iconBox);

    var main = el('span', { className: 'c-row__main' });
    main.appendChild(el('span', { className: 'c-row__title s-plan-rule__title', text: String(rule.name || '定期账单') }));
    main.appendChild(el('span', { className: 'c-row__sub s-plan-rule__sub', text: sub }));
    main.appendChild(el('span', {
      className: 's-plan-rule__due s-plan-rule__due--' + info.tone,
      text: info.text
    }));
    row.appendChild(main);

    var trail = el('span', { className: 'c-row__trail s-plan-rule__trail' });
    var valueClass = 'c-row__value s-plan-rule__amount';
    var prefix = '';
    if (rule.type === 'expense') { valueClass += ' c-row__value--expense'; prefix = '-'; }
    else if (rule.type === 'income') { valueClass += ' c-row__value--income'; prefix = '+'; }
    trail.appendChild(el('span', { className: valueClass, text: prefix + fmt(rule.amountCents) }));
    trail.appendChild(switchControl(rule.paused !== true, '启用「' + String(rule.name || '定期账单') + '」', function (on) {
      toggleRule(ctx, rule, on);
    }));
    row.appendChild(trail);

    row.addEventListener('click', function () { openRuleForm(ctx, rule); });
    row.addEventListener('keydown', function (event) {
      if (!event) { return; }
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        openRuleForm(ctx, rule);
      }
    });
    return row;
  }

  function dueInfo(rule) {
    var next = String(rule.nextDueDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) { return { text: '未排期', tone: 'flat' }; }
    var diff = dayDiff(todayStr(), next);
    if (diff < 0) { return { text: '逾期 ' + (-diff) + ' 天', tone: 'over' }; }
    if (diff === 0) { return { text: '今天到期', tone: 'warn' }; }
    if (diff <= 7) { return { text: diff + ' 天后到期', tone: 'warn' }; }
    return { text: '下次 ' + humanDate(next), tone: 'flat' };
  }

  function toggleRule(ctx, rule, enabled) {
    commitRun(function (working) {
      var list = listOf(working, 'recurring');
      var idx = indexOfId(list, rule.id);
      if (idx < 0) { return { abort: true, code: 'E_RECURRING_NOT_FOUND', message: '这条账单已经不在了' }; }
      list[idx].paused = !enabled;
      list[idx].updatedAt = nowIso();
      return { value: enabled };
    }, enabled ? '启用定期账单' : '暂停定期账单').then(function (result) {
      if (!result) { return; }
      toast(enabled ? '已启用' : '已暂停', { type: 'success' });
    });
  }

  function postDue(ctx, item) {
    var rec = recurrenceApi();
    if (!rec || typeof rec.postInstance !== 'function') {
      toast('周期账单模块还没准备好', { type: 'danger' });
      return;
    }
    commitRun(function (working) {
      var result = rec.postInstance(working, { ruleId: item.ruleId, dueDate: item.dueDate }, { advanceRule: true });
      if (!result || result.ok !== true) {
        return {
          abort: true,
          code: (result && result.code) || 'E_RECURRING_RULE',
          message: '入账失败，请检查这条账单的账户与分类'
        };
      }
      if (result.skipped === true) { return { value: { skipped: true } }; }
      return { value: { skipped: false, id: result.id } };
    }, '定期账单入账').then(function (result) {
      if (!result) { return; }
      var value = result.value || {};
      toast(value.skipped === true ? '这笔之前已经记过了' : '已入账', { type: 'success' });
    });
  }

  function catchUpAll(ctx) {
    var rec = recurrenceApi();
    if (!rec || typeof rec.catchUp !== 'function') {
      toast('周期账单模块还没准备好', { type: 'danger' });
      return;
    }
    commitRun(function (working) {
      var summary = rec.catchUp(working, working, todayStr(), { autoPostOnly: false, max: 31 });
      if (!summary || summary.ok !== true) {
        return { abort: true, code: 'E_RECURRING_RULE', message: '补账失败，请稍后再试' };
      }
      return {
        value: {
          posted: Number(summary.posted) || 0,
          skipped: Number(summary.skipped) || 0,
          failed: Number(summary.failed) || 0,
          remaining: Number(summary.remaining) || 0
        }
      };
    }, '补记到期账单').then(function (result) {
      if (!result) { return; }
      var value = result.value || {};
      if (value.posted > 0) {
        toast('已补记 ' + value.posted + ' 笔' + (value.failed > 0 ? '，' + value.failed + ' 笔失败' : ''), { type: value.failed > 0 ? 'warning' : 'success' });
        return;
      }
      if (value.skipped > 0) { toast('这些账单之前已经记过了', { type: 'info' }); return; }
      if (value.failed > 0) { toast('有 ' + value.failed + ' 笔补记失败，请检查账户与分类', { type: 'danger' }); return; }
      toast('暂时没有需要补记的账单', { type: 'info' });
    });
  }

  function openRuleForm(ctx, rule) {
    var db = readDb(ctx);
    var bookId = activeBookId(db);
    var schema = schemaApi();
    var accounts = rows(db, 'accounts').filter(function (row) { return row && row.archived !== true; });
    if (!accounts.length) {
      toast('还没有账户，先去账户页建一个', { type: 'warning' });
      return;
    }
    var allCategories = rows(db, 'categories').filter(function (row) { return row && row.hidden !== true; });

    var state = {
      type: rule ? String(rule.type) : 'expense',
      freq: rule ? String(rule.freq) : 'monthly',
      autoPost: rule ? rule.autoPost === true : true,
      accountId: rule ? String(rule.accountId) : String(accounts[0].id),
      toAccountId: rule && rule.toAccountId ? String(rule.toAccountId) : '',
      categoryId: rule && rule.categoryId ? String(rule.categoryId) : ''
    };

    var nameInput = textInput(rule ? rule.name : '', '例如：房租', '名称');
    var amountBox = amountInput(rule ? rule.amountCents : 0);
    var accountOptions = accounts.map(function (row) {
      return { value: String(row.id), label: String(row.name || '账户') };
    });
    var accountSelect = selectInput(accountOptions, state.accountId, '账户');
    var toAccountSelect = selectInput(accountOptions, state.toAccountId || state.accountId, '转入账户');
    var categorySelect = el('select', { className: 'c-field__input s-plan-select' });
    categorySelect.setAttribute('aria-label', '分类');
    var intervalBox = numberInput(rule ? (Number(rule.interval) || 1) : 1, 1, 99);
    var weekdaySelect = selectInput(WEEKDAY_NAMES.map(function (label, index) {
      return { value: String(index), label: label };
    }), rule && rule.weekday !== null && rule.weekday !== undefined ? String(rule.weekday) : '1', '周几');
    var dayBox = numberInput(rule && rule.dayOfMonth ? Number(rule.dayOfMonth) : 1, 1, 28);
    var monthSelect = selectInput(MONTH_NAMES.map(function (label, index) {
      return { value: String(index + 1), label: label };
    }), rule && rule.monthOfYear ? String(rule.monthOfYear) : '1', '月份');
    var startBox = dateInput(rule ? rule.startDate : todayStr());
    var error = errorNode();

    var toAccountRow = fieldRow('转入账户', toAccountSelect);
    var categoryRow = fieldRow('分类', categorySelect);
    var weekdayRow = fieldRow('周期日', weekdaySelect);
    var dayRow = fieldRow('每月几号', dayBox);
    var monthRow = fieldRow('每年几月', monthSelect);
    var intervalRow = fieldRow('间隔', intervalBox, '期');

    var typeSeg = segmentedControl(TYPE_OPTIONS, state.type, function (value) {
      state.type = value;
      syncRows();
    });
    var freqSeg = segmentedControl(FREQ_OPTIONS, state.freq, function (value) {
      state.freq = value;
      syncRows();
    });
    var autoSwitch = switchControl(state.autoPost, '自动入账', function (on) { state.autoPost = on; });

    var typeRow = el('div', { className: 'c-field s-plan-field s-plan-field--inline' });
    typeRow.appendChild(el('span', { className: 'c-field__label', text: '类型' }));
    typeRow.appendChild(el('span', { className: 'c-field__control s-plan-field__seg' }, [typeSeg]));

    var freqRow = el('div', { className: 'c-field s-plan-field s-plan-field--inline' });
    freqRow.appendChild(el('span', { className: 'c-field__label', text: '周期' }));
    freqRow.appendChild(el('span', { className: 'c-field__control s-plan-field__seg' }, [freqSeg]));

    var autoRow = el('div', { className: 'c-field s-plan-field s-plan-field--inline' });
    autoRow.appendChild(el('span', { className: 'c-field__label', text: '自动入账' }));
    autoRow.appendChild(el('span', { className: 'c-field__control s-plan-field__switch' }, [autoSwitch]));

    var nodes = [
      fieldRow('名称', nameInput),
      fieldRow('金额', amountBox, '¥'),
      typeRow,
      fieldRow('账户', accountSelect),
      toAccountRow,
      categoryRow,
      freqRow,
      intervalRow,
      weekdayRow,
      dayRow,
      monthRow,
      fieldRow('开始日期', startBox),
      autoRow,
      hintNode('自动入账会在打开应用时把到期账单补记成流水。'),
      error
    ];

    function fillCategories() {
      var kind = state.type === 'income' ? 'income' : 'expense';
      var usable = allCategories.filter(function (row) { return String(row.kind) === kind; });
      clearNode(categorySelect);
      usable.forEach(function (row) {
        categorySelect.appendChild(el('option', { value: String(row.id), text: String(row.name || '未命名分类') }));
      });
      var hasCurrent = false;
      for (var i = 0; i < usable.length; i++) {
        if (String(usable[i].id) === String(state.categoryId)) { hasCurrent = true; break; }
      }
      if (!hasCurrent) { state.categoryId = usable.length ? String(usable[0].id) : ''; }
      categorySelect.value = state.categoryId;
    }

    function syncRows() {
      var isTransfer = state.type === 'transfer';
      toAccountRow.hidden = !isTransfer;
      categoryRow.hidden = isTransfer;
      weekdayRow.hidden = state.freq !== 'weekly';
      dayRow.hidden = !(state.freq === 'monthly' || state.freq === 'yearly');
      monthRow.hidden = state.freq !== 'yearly';
      intervalRow.hidden = false;
      if (!isTransfer) { fillCategories(); }
      if (isTransfer && !state.toAccountId) { state.toAccountId = accounts.length > 1 ? String(accounts[1].id) : state.accountId; toAccountSelect.value = state.toAccountId; }
    }

    typeSeg.addEventListener('click', function () { syncRows(); });
    freqSeg.addEventListener('click', function () { syncRows(); });
    categorySelect.addEventListener('change', function () { state.categoryId = String(categorySelect.value); });
    accountSelect.addEventListener('change', function () { state.accountId = String(accountSelect.value); });
    toAccountSelect.addEventListener('change', function () { state.toAccountId = String(toAccountSelect.value); });

    syncRows();

    if (rule) {
      nodes.push(ghostButton('立即入账一笔', function () {
        var due = rule.nextDueDate || rule.startDate;
        postDue(ctx, { ruleId: rule.id, dueDate: due });
      }, 's-plan-rule__postnow'));
      nodes.push(ghostButton('删除这条定期账单', function () { remove(); }, 's-plan-danger-text'));
    }
    nodes.push(primaryButton(rule ? '保存' : '创建定期账单', function () { save(); }));

    var body = formWrap(nodes);
    var handle = openSheet(rule ? '编辑定期账单' : '新建定期账单', body);

    function save() {
      var name = String(nameInput.value || '').trim();
      var cents = parseCents(amountBox.value);
      if (!name) { showError(error, '请填写账单名称'); return; }
      if (!isFinite(cents) || cents <= 0) { showError(error, '请输入大于 0 的金额'); return; }
      if (!state.accountId) { showError(error, '请选择账户'); return; }
      if (state.type === 'transfer' && (!state.toAccountId || state.toAccountId === state.accountId)) {
        showError(error, '转入账户不能和转出账户相同');
        return;
      }
      if (state.type !== 'transfer' && !state.categoryId) { showError(error, '请选择分类'); return; }
      if (!schema || typeof schema.createRecurring !== 'function') { showError(error, '数据层还没准备好'); return; }

      var interval = parseInt(intervalBox.value, 10);
      if (!(interval >= 1 && interval <= 99)) { showError(error, '间隔请填 1 到 99 之间的整数'); return; }
      var startDate = String(startBox.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { showError(error, '请选择开始日期'); return; }
      var weekday = parseInt(weekdaySelect.value, 10);
      var dayOfMonth = parseInt(dayBox.value, 10);
      var monthOfYear = parseInt(monthSelect.value, 10);
      if (state.freq === 'weekly' && !(weekday >= 0 && weekday <= 6)) { showError(error, '请选择周几'); return; }
      if ((state.freq === 'monthly' || state.freq === 'yearly') && !(dayOfMonth >= 1 && dayOfMonth <= 28)) {
        showError(error, '每月几号请填 1 到 28');
        return;
      }
      if (state.freq === 'yearly' && !(monthOfYear >= 1 && monthOfYear <= 12)) { showError(error, '请选择月份'); return; }

      showError(error, '');
      var input = {
        bookId: bookId,
        name: name,
        type: state.type,
        amountCents: cents,
        accountId: state.accountId,
        toAccountId: state.type === 'transfer' ? state.toAccountId : null,
        categoryId: state.type === 'transfer' ? null : state.categoryId,
        freq: state.freq,
        interval: interval,
        weekday: state.freq === 'weekly' ? weekday : null,
        dayOfMonth: (state.freq === 'monthly' || state.freq === 'yearly') ? dayOfMonth : null,
        monthOfYear: state.freq === 'yearly' ? monthOfYear : null,
        startDate: startDate,
        endDate: rule ? rule.endDate : null,
        autoPost: state.autoPost === true,
        paused: rule ? rule.paused === true : false,
        note: ''
      };

      commitRun(function (working) {
        var list = listOf(working, 'recurring');
        var entity = schema.createRecurring(input, null, { autoPost: input.autoPost });
        if (rule) {
          var idx = indexOfId(list, rule.id);
          if (idx < 0) { return { abort: true, code: 'E_RECURRING_NOT_FOUND', message: '这条账单已经不在了' }; }
          entity.id = rule.id;
          entity.createdAt = rule.createdAt || entity.createdAt;
          entity.lastPostedPeriod = rule.lastPostedPeriod || null;
          entity.nextDueDate = input.startDate === rule.startDate && rule.nextDueDate
            ? rule.nextDueDate
            : (nextDueOrStart(entity, input.startDate));
          var checked = safeValidate(entity);
          if (checked && checked.ok === false) {
            return { abort: true, code: checked.code || 'E_RECURRING_RULE', message: '请检查金额、账户与分类' };
          }
          list[idx] = entity;
          return { value: entity.id };
        }
        entity.nextDueDate = nextDueOrStart(entity, input.startDate);
        var checkedNew = safeValidate(entity);
        if (checkedNew && checkedNew.ok === false) {
          return { abort: true, code: checkedNew.code || 'E_RECURRING_RULE', message: '请检查金额、账户与分类' };
        }
        list.push(entity);
        return { value: entity.id };
      }, rule ? '编辑定期账单' : '新建定期账单').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        toast(rule ? '定期账单已更新' : '定期账单已创建', { type: 'success' });
      });
    }

    function nextDueOrStart(entity, startDate) {
      var rec = recurrenceApi();
      if (rec && typeof rec.nextDueDate === 'function') {
        try {
          var next = rec.nextDueDate(entity, startDate);
          if (next && /^\d{4}-\d{2}-\d{2}$/.test(String(next))) { return String(next); }
        } catch (error2) { /* fall through */ }
      }
      return startDate;
    }

    function safeValidate(entity) {
      if (!schema || typeof schema.validateRecurring !== 'function') { return null; }
      try { return schema.validateRecurring(entity); } catch (error2) { return null; }
    }

    function remove() {
      commitRun(function (working) {
        var list = listOf(working, 'recurring');
        var idx = indexOfId(list, rule.id);
        if (idx < 0) { return { abort: true, code: 'E_RECURRING_NOT_FOUND', message: '这条账单已经不在了' }; }
        list[idx].archived = true;
        list[idx].updatedAt = nowIso();
        return { value: true };
      }, '删除定期账单').then(function (result) {
        if (!result) { return; }
        closeSheet(handle);
        undoToast('已删除定期账单');
      });
    }
  }

  /* ============================== 图表 ============================== */

  function paintRing(node) {
    var charts = chartsApi();
    if (!charts || typeof charts.donut !== 'function') { return; }
    var value = Number(node.getAttribute('data-value')) || 0;
    var total = Number(node.getAttribute('data-total')) || 0;
    var size = Number(node.getAttribute('data-size')) || 120;
    var tone = node.getAttribute('data-tone') || '--c-tint';
    var sub = node.getAttribute('data-sub') || '已用';
    var pct = node.getAttribute('data-pct') || (total > 0 ? Math.round((value / total) * 100) + '%' : '0%');
    var aria = node.getAttribute('data-aria') || '进度环';
    try {
      charts.donut(node, [{ label: sub, value: Math.max(0, value), color: tone }], {
        total: Math.max(0, total),
        centerLabel: pct,
        centerSub: sub,
        width: size,
        height: size,
        thickness: size >= 120 ? 12 : 10,
        ariaLabel: aria,
        emptyText: '还没有数据'
      });
    } catch (error) {
      /* 图表失败不阻塞整屏 */
    }
  }

  /* ============================== 主流程 ============================== */

  function paint() {
    var root = P.root;
    if (!root) { return; }
    var ctx = P.ctx || {};
    var host = null;
    try { host = root.closest ? root.closest('.app-screen') : null; } catch (error) { host = null; }
    var scrollTop = host ? host.scrollTop : 0;

    var db = readDb(ctx);
    var bookId = activeBookId(db);
    var progress = budgetOfSource(db, P.month, bookId);
    var categoryBudgets = findCategoryBudgets(db, P.month, bookId);
    var monthBudget = findBudget(db, P.month, bookId);
    var hasBudget = (Number(progress.totalCents) || 0) > 0 ||
      (monthBudget && Number(monthBudget.totalCents) > 0);

    clearNode(root);
    syncTitle(ctx, db);

    var screen = el('div', { className: 's-plan-screen' });

    /* N5：待处理（逾期 + 7 天内到期）在最前——先处理再规划 */
    var pendingSection = buildPendingSection(ctx, db, bookId);
    if (pendingSection) { screen.appendChild(pendingSection); }

    var budgetSection = el('section', { className: 's-plan-section s-plan-section--budget' });
    budgetSection.appendChild(el('h2', { className: 's-plan-heading', text: '预算' }));
    budgetSection.appendChild(buildMonthBar());
    if (hasBudget) {
      budgetSection.appendChild(buildBudgetCard(ctx, progress));
    } else {
      budgetSection.appendChild(buildBudgetEmpty(ctx, db, bookId, P.month));
    }
    budgetSection.appendChild(buildCategoryList(ctx, db, bookId, progress, categoryBudgets));
    screen.appendChild(budgetSection);

    screen.appendChild(buildGoals(ctx, db, bookId));
    screen.appendChild(buildRecurring(ctx, db, bookId));
    screen.appendChild(el('p', { className: 's-plan-foot', text: '预算与目标只保存在本机，不联网、不上传。' }));

    root.appendChild(screen);

    var rings = screen.querySelectorAll('[data-plan-ring]');
    for (var i = 0; i < rings.length; i++) { paintRing(rings[i]); }
    if (host) { host.scrollTop = scrollTop; }
  }

  function render(root, ctx) {
    P.root = root;
    P.ctx = ctx || {};
    var max = currentMonth();
    if (!P.month || P.month < MONTH_MIN || P.month > max) { P.month = max; }
    paint();
  }

  var screen = {
    title: '计划',
    subtitle: '预算 · 目标 · 定期账单',
    render: render
  };

  registry.register('plan', screen);
}(window));
