/* 小账本 2.0 · js/screens/home.js
 * 首页（2.15 整合版）：本屏自绘黄色专属头部（品牌行 + 月度汇总三列）
 *   → 紧凑预算单卡（无预算时不渲染；点卡打开预算状态 Sheet）
 *   → 待入账（有数据才出现）
 *   → 嵌入式明细（ledger.render(host, ctx, { embedded:true, … }) 是唯一列表实现）
 *
 * 2.15 删除：独立「最近流水」区块、右下角 FAB、行/照片渲染管线（整体交给 ledger.js）。
 *
 * 契约：XZB.screens.register('home', { title, immersive, render })
 *   render(root, ctx) → { destroy }；路由换屏前调用一次 destroy（D2-11）。
 *   immersive=true ⇒ 路由壳层不再为首页渲染 .app-nav 与 .c-large-title，
 *   头部与 h1.app-title 由本屏负责（路由 focusTitle 仍命中本屏 h1）。
 * 硬规则：不碰 IndexedDB / localStorage / TabBar；用户数据一律 textContent；
 *         统计只走 XZB.core.stats，月汇总/预算按「月份」各只算一次。
 */
(function (global) {
  'use strict';

  var XZB = (global.XZB = global.XZB || {});
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] home 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var Core = XZB.core || XZB.Core || {};
  var dates = Core.dates || null;
  var stats = Core.stats || null;
  var recurrence = Core.recurrence || null;

  /* 只在本次会话第一次进首页时播错位入场，之后 rerender 不再抖 */
  var firstPaint = true;

  /* 下拉刷新：与既有首页能力清单保持一致（阈值 60px，到顶才触发）。
     指示器高度恒等于 --sp-11（64px），与 home.css 的 .s-home-pull 成对；
     拖动期间只写 transform，不写 height / text —— 每个 touchmove 改布局是卡顿主因。 */
  var PULL_HEIGHT = 64;
  var PULL_VISUAL_MAX = PULL_HEIGHT;
  var PULL_TRIGGER = 60;
  var PULL_READY = Math.round(PULL_TRIGGER * 0.7);

  var MONTH_RE = /^\d{4}-\d{2}$/;
  var PLAN_HASH = '#/plan';

  /* 超支态文案唯一真源（A9 单源化：全文件仅此一处字面量，其余引用该常量）。
     第四行标题、超支徽标与首页预算卡徽标共用，避免三处各写一遍。 */
  var TEXT_OVER = '已超支';

  /* ---------------- 依赖取用 ---------------- */

  function uiApi() { return XZB.ui || XZB.UI || {}; }
  function kit() { return uiApi().kit || null; }
  function sheetApi() { return uiApi().sheet || null; }
  function toastApi() { return uiApi().toast || null; }
  function appApi() { return XZB.app || XZB.App || null; }
  function routerApi() { return XZB.router || XZB.Router || null; }

  function appendKids(node, kids) {
    if (kids === undefined || kids === null || kids === false) { return; }
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i += 1) { appendKids(node, kids[i]); }
      return;
    }
    if (kids && typeof kids.nodeType === 'number') { node.appendChild(kids); return; }
    node.appendChild(document.createTextNode(String(kids)));
  }

  /* 建节点：正常路径走 XZB.UI.kit.el（浏览器里再由 XZB.ui.dom.el 落全部属性）。
     降级路径（无 kit）自己补 class/text；两种情况都在末尾补写一次其余属性，
     保证 data-* / href / type / role / aria-* 在任何环境都真的落在节点上。 */
  function el(tag, attrs, kids) {
    var k = kit();
    var options = attrs && typeof attrs === 'object' ? attrs : {};
    var node;
    if (k && typeof k.el === 'function') {
      node = k.el(tag, attrs, kids);
    } else {
      node = document.createElement(String(tag || 'div'));
      var className = options.className || options['class'];
      if (className) { node.className = String(className); }
      if (options.text !== undefined && options.text !== null) {
        node.textContent = String(options.text);
      }
      appendKids(node, kids !== undefined && kids !== null ? kids : options.children);
    }
    if (node && typeof node.setAttribute === 'function') {
      Object.keys(options).forEach(function (name) {
        if (name === 'className' || name === 'class' || name === 'text' || name === 'children' ||
          name === 'html' || name === 'style' || name === 'dataset' || name === 'aria' || name === 'role') {
          return;
        }
        var value = options[name];
        if (value === undefined || value === null || value === false) { return; }
        var next = value === true ? '' : String(value);
        if (typeof node.getAttribute === 'function' && node.getAttribute(name) === next) { return; }
        node.setAttribute(name, next);
      });
      if (options.role) { node.setAttribute('role', String(options.role)); }
    }
    return node;
  }

  function iconNode(name, size) {
    var k = kit();
    if (k) { return k.icon(name || 'ellipsis', size || 20); }
    var span = el('span', { className: 's-home-glyph' });
    span.textContent = String(name || '·').slice(0, 1);
    return span;
  }

  function moneyNode(cents, options) {
    var k = kit();
    if (k) { return k.money(cents, options); }
    return el('span', { text: String(cents) });
  }

  function btnNode(label, options) {
    var k = kit();
    if (k && typeof k.btn === 'function') { return k.btn(label, options); }
    var href = options && options.href;
    var node = el(href ? 'a' : 'button', { className: 'c-btn c-btn--secondary', text: label });
    if (href) { node.setAttribute('href', href); }
    return node;
  }

  function fmt(cents, options) {
    var money = Core.money || null;
    if (money && typeof money.formatCents === 'function') {
      return money.formatCents(cents, options);
    }
    return String(cents);
  }

  function toast(message, options) {
    var t = toastApi();
    if (t && typeof t.show === 'function') { t.show(message, options || {}); }
  }

  function reducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  }

  function warn(message, detail) {
    if (global.console && typeof global.console.warn === 'function') {
      if (detail === undefined) { global.console.warn(message); }
      else { global.console.warn(message, detail); }
    }
  }

  /* ---------------- 数据 ---------------- */

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

  function activeBookId(db) {
    var app = appApi();
    var state = app && app.state;
    var id = '';
    if (state && state.ui && typeof state.ui.activeBookId === 'string') {
      id = state.ui.activeBookId;
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

  function todayStr() {
    if (dates && typeof dates.todayStr === 'function') { return dates.todayStr(); }
    return '';
  }

  function monthOf(dateText) {
    return String(dateText || '').slice(0, 7);
  }

  function monthLabel(month) {
    var parts = String(month || '').split('-');
    if (parts.length !== 2) { return ''; }
    return Number(parts[0]) + ' 年 ' + Number(parts[1]) + ' 月';
  }

  function humanDate(dateText) {
    if (dates && typeof dates.formatHuman === 'function') {
      return dates.formatHuman(dateText);
    }
    return String(dateText || '');
  }

  function daysInMonth(month) {
    var parts = String(month || '').split('-');
    if (parts.length !== 2) { return 30; }
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    if (!y || !m) { return 30; }
    return new Date(y, m, 0).getDate();
  }

  /* `[D2-37]` 日均可用：floor(max(0, 剩余) / daysLeft)，daysLeft <= 0 时为 0（K-19 除零防护）。
     daysLeft = 月末日 − 今日日 + 1（含今日）。 */
  function dailyCents(remainingCents, daysLeft) {
    var left = Number(daysLeft) || 0;
    if (left <= 0) { return 0; }
    var rest = Math.max(0, Number(remainingCents) || 0);
    return Math.floor(rest / left);
  }

  function daysLeftOf(month, today) {
    var left = daysInMonth(month) - (Number(String(today || '').slice(8, 10)) || 1) + 1;
    return left > 0 ? left : 0;
  }

  /* `[D4-8]` baseHash：只提供路径 `#/home`。五个参与键（month/flag/ca/date/detail）
     由 ledger 自己的 live 状态在清参时重写（ledger.js 的 baseHashOf → liveParams），
     因此这里**不得**读 ctx.params 做 URL 快照（D4-8「禁止取 URL 快照」）；
     编码一律经 XZB.router.hash（D7-2：禁止字符串拼接注入 query）。 */
  function homeBaseHash() {
    var router = routerApi();
    if (router && typeof router.hash === 'function') {
      try { return router.hash({ view: 'home', sub: '', params: {} }); } catch (error) { /* 回退 */ }
    }
    return '#/home';
  }

  function readSummary(db, month, scope) {
    var out = stats && typeof stats.monthSummary === 'function'
      ? stats.monthSummary(db, month, scope)
      : { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 };
    if (!out || typeof out !== 'object') {
      out = { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 };
    }
    return out;
  }

  function readBudget(db, month, scope) {
    var out = stats && typeof stats.budgetProgress === 'function'
      ? stats.budgetProgress(db, month, scope)
      : { totalCents: 0, spentCents: 0, remainingCents: 0, pct: 0, state: 'none' };
    if (!out || typeof out !== 'object') {
      out = { totalCents: 0, spentCents: 0, remainingCents: 0, pct: 0, state: 'none' };
    }
    if (out.month === undefined) { out.month = month; }
    return out;
  }

  /* ---------------- 头部（品牌行 + 月度汇总三列） ---------------- */

  /* 大金额降档（任务书 §八 要求处理「大金额」；修的是「金额被省略号吃掉」）。
     三列等分时每列只有约 1/3 视口宽（390px 下约 111px），而 34px 字号每字符约 14.6px
     （tabular-nums 实测 0.43em/字符）⇒ 只能容下 7 个字符，「¥1,234.56」9 字符就会截断。
     这里按「已格式化文本的字符数」降档，保证金额完整可读：
       ≤ 7 字符（¥99,999.99 以内）  34px / 窄屏 28px
       8–9 字符（¥1,234.56 一级）    28px / 窄屏 17px
       ≥ 10 字符（¥10,000 以上）     17px / 窄屏 15px
     用字符数而非视口宽度：金额长度由用户数据决定，与视口无关。
     具体字号在 home.css 末尾（intentional 放最后，才能压过窄屏媒体查询）。 */
  function fitValueClass(node) {
    if (!node || !node.classList) { return; }
    node.classList.remove('s-home-head__value--tight');
    node.classList.remove('s-home-head__value--compact');
    var len = String(node.textContent || '').length;
    if (len >= 10) { node.classList.add('s-home-head__value--tight'); }
    else if (len >= 8) { node.classList.add('s-home-head__value--compact'); }
    return node;
  }

  /* 月份切换后复用同一个节点重绘金额（不重建头部，滚动位置与焦点不受影响） */
  function paintValue(node, cents) {
    if (!node) { return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
    node.appendChild(moneyNode(Math.abs(Number(cents) || 0)));
    fitValueClass(node);
  }

  /* 三列中的金额列：标签 12px + 金额（尺寸与 tabular-nums 交给 home.css） */
  function summaryColumn(label, cents, kind, refs) {
    var col = el('div', { className: 's-home-head__col s-home-head__col--' + kind });
    col.appendChild(el('span', { className: 's-home-head__label', text: label }));
    var value = el('span', { className: 's-home-head__value' });
    value.appendChild(moneyNode(Math.abs(Number(cents) || 0)));
    fitValueClass(value);
    col.appendChild(value);
    if (refs) { refs[kind] = value; }
    return col;
  }

  function buildHead(book, month, summary, view) {
    var bookName = book && book.name ? String(book.name) : '日常账本';
    var head = el('header', { className: 's-home-head' });
    head.setAttribute('data-home-head', '1');

    /* 第一行：左 = 账本入口（纯图标，靠 aria-label 说话），中 = 品牌，右 = 占位保持居中 */
    var top = el('div', { className: 's-home-head__top' });

    var entry = el('a', {
      className: 's-home-head__books c-pressable',
      href: '#/books',
      'aria-label': '账本 ' + bookName + '，切换到账本列表'
    });
    entry.appendChild(iconNode('book', 24));
    top.appendChild(entry);

    var brand = el('h1', { className: 's-home-head__brand', text: '小账本' });
    /* app-title 与 tabindex=-1 是路由聚焦与无障碍契约，逐字保留 */
    brand.classList.add('app-title');
    brand.setAttribute('tabindex', '-1');
    top.appendChild(brand);

    /* 右：小助手入口（2.17.0）；同尺寸 44px，与左侧账本入口对称，品牌仍居中 */
    var assistantEntry = el('a', {
      className: 's-home-head__spacer c-pressable',
      href: '#/assistant',
      'aria-label': '打开小助手，一句话记账'
    });
    assistantEntry.appendChild(iconNode('sparkles', 24));
    top.appendChild(assistantEntry);
    head.appendChild(top);

    /* 第二行：当前年月 / 收入 / 支出，三列等分 */
    var sum = el('div', { className: 's-home-head__summary' });
    sum.setAttribute('data-home-summary', '1');

    var monthCol = el('div', { className: 's-home-head__col s-home-head__col--month' });
    var monthText = el('span', {
      className: 's-home-head__label',
      text: monthLabel(month) || '本月'
    });
    monthCol.appendChild(monthText);
    monthCol.appendChild(el('span', { className: 's-home-head__book', text: bookName }));
    sum.appendChild(monthCol);

    var refs = { month: monthText };
    sum.appendChild(summaryColumn('收入', summary.incomeCents, 'income', refs));
    sum.appendChild(summaryColumn('支出', summary.expenseCents, 'expense', refs));
    head.appendChild(sum);
    if (view) { view.head = refs; }
    return head;
  }

  /* ---------------- 区块：预算（紧凑单卡；没预算就整块不渲染） ---------------- */

  function openBudgetStatus(view) {
    if (view && (view.dead || view.destroyed)) { return; }
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    sheet.open({ title: '本月预算', content: budgetSheetContent(view) });
  }

  function budgetSheetContent(view) {
    var list = [];
    var budget = (view && view.budget) || {};
    var totalCents = Number(budget.totalCents) || 0;
    var spentCents = Number(budget.spentCents) || 0;

    if (totalCents <= 0) {
      /* 未设预算：只两行，不以 0 值占位（§5.1） */
      list.push(sheetRow({
        title: '本月未设置预算',
        sub: '设置后这里显示已用、剩余与日均可用'
      }));
      list.push(btnNode('去设置月度预算', { variant: 'secondary', href: PLAN_HASH }));
      return list;
    }

    var remainingCents = totalCents - spentCents;
    var pct = Number(budget.pct) || 0;
    var overCents = spentCents - totalCents;
    var danger = budget.state === 'over' || overCents > 0;
    var month = String(budget.month || (view && view.month) || '');
    var left = daysLeftOf(month, view && view.today);

    /* 第 1 行：已用 / 预算总额 */
    list.push(sheetRow({
      title: '已用',
      sub: '预算 ' + fmt(totalCents),
      value: moneyNode(spentCents),
      strong: true
    }));

    /* 第 2 行：剩余（可为负，超支走 --expense + U+2212） */
    list.push(sheetRow({
      title: '剩余',
      sub: '占预算 ' + pctText(pct) + '%',
      value: moneyNode(remainingCents),
      expense: remainingCents < 0
    }));

    /* 第 3 行：日均可用 = floor(max(0, 剩余) / daysLeft) */
    list.push(sheetRow({
      title: '日均可用',
      sub: '本月还剩 ' + left + ' 天',
      value: moneyNode(dailyCents(remainingCents, left))
    }));

    /* 第 4 行：只按态二选一（warn → 「预警」，over → TEXT_OVER）；safe 恒 3 行，禁止第三种措辞 */
    if (danger || pct >= 80 || budget.state === 'warn') {
      list.push(budgetWarnRow(danger, pct));
    }

    /* P0-1：把预算上下文带进小助手（只预填问题，不自动改预算） */
    if (assistantEntryOn(view)) {
      list.push(btnNode('问问小助手怎么调整', {
        variant: 'secondary',
        href: budgetAskHash(month)
      }));
    }
    return list;
  }

  function pctText(pct) {
    return String(Math.round((Number(pct) || 0) * 10) / 10);
  }

  /* P0-1 情境入口开关：默认开，「我的」里可关（与解读页同一开关） */
  function assistantEntryOn(view) {
    var prefs = (view && view.ctx && view.ctx.prefs) || (appApi() && appApi().prefs);
    var v = null;
    if (prefs && typeof prefs.get === 'function') {
      try { v = prefs.get('assistant.contextualEntry'); } catch (error) { v = null; }
    }
    return v !== false;
  }

  function budgetAskHash(month) {
    var q = '本月预算还能用多少？照这样花月底会超吗？';
    return '#/assistant?from=home&m=' + encodeURIComponent(String(month || '')) + '&q=' + encodeURIComponent(q);
  }

  function sheetRow(options) {
    var o = options || {};
    /* 类名封闭集合（UI.md §5.1）：c-row / c-row__* / c-money / u-tabular / c-btn--secondary。
       不带 --two-line（行高由 min-height + 内容撑开，加修饰符会出集合）。 */
    var row = el('div', { className: 'c-row' });
    var main = el('div', { className: 'c-row__main' });
    main.appendChild(el('span', { className: 'c-row__title', text: o.title }));
    if (o.sub) { main.appendChild(el('span', { className: 'c-row__sub', text: o.sub })); }
    row.appendChild(main);
    if (o.value) {
      var className = 'c-row__value u-tabular';
      if (o.strong) { className += ' c-row__value--strong'; }
      if (o.expense) { className += ' c-row__value--expense'; }
      var slot = el('span', { className: className });
      slot.appendChild(o.value);
      row.appendChild(slot);
    }
    return row;
  }

  /* 第 4 行：c-tile--warn / --danger + 文案 + c-badge（行首 36px 底座） */
  function budgetWarnRow(danger, pct) {
    var k = kit();
    /* 与其它行同属 c-row 家族（§5.1 类名封闭集合），不使用 --with-tile 修饰符 */
    var row = el('div', { className: 'c-row' });
    var tile = k && typeof k.tile === 'function'
      ? k.tile('warning', { tone: danger ? 'danger' : 'warn' })
      : el('span', { className: 'c-tile c-tile--' + (danger ? 'danger' : 'warn') });
    tile.setAttribute('aria-hidden', 'true');
    row.appendChild(tile);

    var main = el('div', { className: 'c-row__main' });
    main.appendChild(el('span', { className: 'c-row__title', text: danger ? TEXT_OVER : '预警' }));
    row.appendChild(main);

    row.appendChild(el('span', {
      className: 'c-badge ' + (danger ? 'c-badge--danger' : 'c-badge--warn'),
      text: danger
        ? TEXT_OVER + ' ' + Math.max(0, Math.round((Number(pct) || 0) - 100)) + '%'
        : '已用 ' + Math.round(Number(pct) || 0) + '%'
    }));
    return row;
  }

  /* 未设预算：只留一个「设置本月预算」入口，不显示 0 元 / 0% 的假进度。
     入口直达 #/plan 预算页，与预算卡（已设置态）互斥，全首页只有一处预算入口。 */
  function buildBudgetBlank() {
    var card = el('a', {
      className: 's-home-budget s-home-budget--blank c-pressable',
      href: PLAN_HASH,
      'data-home-budget': '1',
      'aria-label': '本月未设置预算，去设置本月预算'
    });
    card.appendChild(el('span', { className: 's-home-budget__title', text: '本月预算' }));
    card.appendChild(el('span', { className: 's-home-budget__remain', text: '设置本月预算' }));
    return card;
  }

  function buildBudget(view) {
    var budget = (view && view.budget) || {};
    var totalCents = Number(budget.totalCents) || 0;
    if (totalCents <= 0) { return buildBudgetBlank(view); }

    var spentCents = Number(budget.spentCents) || 0;
    var remainingCents = totalCents - spentCents;
    var overCents = Math.max(0, spentCents - totalCents);
    var pct = Number(budget.pct) || 0;
    var danger = overCents > 0 || budget.state === 'over';
    var k = kit();

    /* 点击等价于四格「预算」：打开预算状态 Sheet，不是导航（不写 hash）。 */
    var card = el('div', {
      className: 's-home-budget c-pressable' + (danger ? ' s-home-budget--danger' : ''),
      role: 'button',
      tabindex: '0',
      'data-home-budget': '1',
      'aria-label': '本月预算已用百分之' + Math.round(pct) + '，打开预算状态'
    });
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    function activate() {
      if (view.dead || view.destroyed) { return; }
      openBudgetStatus(view);
    }
    card.addEventListener('click', activate);
    card.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') { return; }
      event.preventDefault();
      activate();
    });

    var head = el('div', { className: 's-home-budget__head' });
    head.appendChild(el('span', { className: 's-home-budget__title', text: '本月预算' }));
    if (danger) {
      head.appendChild(el('span', { className: 'c-badge c-badge--danger', text: TEXT_OVER }));
    } else {
      head.appendChild(el('span', {
        className: 's-home-budget__remain',
        text: '剩 ' + fmt(Math.max(0, remainingCents))
      }));
    }
    card.appendChild(head);

    var nums = el('p', { className: 's-home-budget__nums' });
    nums.appendChild(el('span', { className: 's-home-budget__nums-key', text: '已用 ' }));
    var spentNode = el('span', { className: 's-home-budget__nums-spent' });
    spentNode.appendChild(moneyNode(spentCents, { size: 'md' }));
    nums.appendChild(spentNode);
    nums.appendChild(el('span', {
      className: 's-home-budget__nums-total',
      text: ' / ' + fmt(totalCents)
    }));
    card.appendChild(nums);

    if (k) { card.appendChild(k.bar(pct, danger ? 'danger' : '')); }

    /* 当月才谈「每天可花」；超支后只报超出的金额 */
    var today = String((view && view.today) || '');
    var month = monthOf(today);
    if (danger) {
      card.appendChild(el('p', {
        className: 's-home-budget__daily-text',
        text: '已用 ' + pctText(pct) + '% · 超出 ' + fmt(overCents)
      }));
    } else if (remainingCents > 0 && String(budget.month || month) === month) {
      var left = daysLeftOf(month, today);
      card.appendChild(el('p', {
        className: 's-home-budget__daily-text',
        text: '每天可花 ' + fmt(dailyCents(remainingCents, left)) + ' · 还剩 ' + left + ' 天'
      }));
    }
    return card;
  }

  /* ---------------- 区块：待入账（只有存在到期实例时才出现） ---------------- */

  function buildDue(list) {
    if (!list.length) { return null; }
    var earliest = list[0];
    var sum = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (String(list[i].dueDate) < String(earliest.dueDate)) { earliest = list[i]; }
      sum += Math.abs(Number(list[i].amountCents) || 0);
    }

    var section = el('section', { className: 's-home-due', 'aria-label': '待入账定期账单' });
    var main = el('div', { className: 's-home-due__main' });

    var holder = el('span', { className: 's-home-due__icon' });
    holder.setAttribute('aria-hidden', 'true');
    holder.appendChild(iconNode('repeat', 24));
    main.appendChild(holder);

    var body = el('div', { className: 's-home-due__body' });
    body.appendChild(el('p', {
      className: 's-home-due__title',
      text: list.length + ' 笔定期账单待入账'
    }));
    body.appendChild(el('p', {
      className: 's-home-due__sub',
      text: '最早应付 ' + humanDate(earliest.dueDate) + (sum > 0 ? ' · 共 ' + fmt(sum) : '')
    }));
    main.appendChild(body);
    section.appendChild(main);

    section.appendChild(el('a', { className: 's-home-due__link', href: '#/plan', text: '去处理' }));
    return section;
  }

  /* ---------------- 嵌入式明细 ---------------- */

  function ledgerPlaceholder() {
    var k = kit();
    if (k && typeof k.empty === 'function') {
      return k.empty({
        icon: 'list',
        iconSize: 36,
        title: '明细暂时不可用',
        text: '刷新页面后再试'
      });
    }
    return el('div', { className: 'c-empty', text: '明细暂时不可用' });
  }

  /* `[D2-13]`/R22：render 时才取 ledger 实现；取不到只降级、不抛错、不白屏 */
  function mountLedger(host, ctx, view) {
    var ledger = null;
    if (registry && typeof registry.get === 'function') {
      try { ledger = registry.get('ledger'); } catch (error) { ledger = null; }
    }
    if (!ledger || typeof ledger.render !== 'function') {
      warn('[home] 明细模块缺失');
      host.appendChild(ledgerPlaceholder());
      return null;
    }
    var options = {
      embedded: true,
      baseHash: homeBaseHash(),
      stickyTop: 0,
      onMonthChange: function (month) { refreshMonth(view, month); },
      onBudgetStatus: function () { openBudgetStatus(view); }
    };
    try {
      return ledger.render(host, ctx, options) || null;
    } catch (error) {
      if (global.console && typeof global.console.error === 'function') {
        global.console.error('[home] 嵌入明细渲染失败', error);
      }
      while (host.firstChild) { host.removeChild(host.firstChild); }
      host.appendChild(ledgerPlaceholder());
      return null;
    }
  }

  /* `[D2-38]`：月份变化后头部月标签 / 收入 / 支出 / 预算卡（含日均可用）一起更新 */
  function refreshMonth(view, month) {
    if (!view || view.dead || view.destroyed) { return; }
    var next = String(month || '');
    if (!MONTH_RE.test(next) || next === view.month) { return; }
    view.month = next;

    if (view.head && view.head.month) {
      view.head.month.textContent = monthLabel(next) || '本月';
    }
    var summary = readSummary(view.db, next, view.scope);
    paintValue(view.head && view.head.income, summary.incomeCents);
    paintValue(view.head && view.head.expense, summary.expenseCents);

    view.budget = readBudget(view.db, next, view.scope);
    var prev = view.budgetCard;
    var nextCard = buildBudget(view);
    if (prev && prev.parentNode) {
      if (nextCard) { prev.parentNode.replaceChild(nextCard, prev); }
      else { prev.parentNode.removeChild(prev); }
    } else if (nextCard && view.inner) {
      var anchor = view.inner.firstChild;
      view.inner.insertBefore(nextCard, anchor);
    }
    view.budgetCard = nextCard || null;
  }

  /* ---------------- 下拉刷新 ---------------- */

  function bindPullRefresh(scroller, pull, contentEls, host, isDead) {
    var app = appApi();
    if (!scroller || !pull || !contentEls || !contentEls.length) { return null; }
    if (!app || typeof app.refresh !== 'function') { return null; }

    var startX = 0;
    var startY = 0;
    var tracking = false;
    var pulled = false;
    var ready = false;
    var busy = false;
    var raf = 0;
    var pending = null;
    var settleTimer = 0;
    var settleDone = null;
    var lastText = pull.textContent;
    var reduced = false;
    try {
      reduced = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) { reduced = false; }

    function dead() {
      return typeof isDead === 'function' && isDead() === true;
    }

    /* 只有三种状态文案会变；同一文案不重写 textContent（避免无谓的文本重排） */
    function setText(text) {
      if (text === lastText) { return; }
      lastText = text;
      pull.textContent = text;
    }

    /* 指示器底边恒贴内容顶边：拉出的空隙由指示器自身黄底补满，不露白。
       y 是内容的位移，指示器反方向上移一个自身高度。 */
    function paint(y) {
      var offset = y > 0 ? y : 0;
      pull.style.transform = 'translate3d(0,' + (offset - PULL_HEIGHT) + 'px,0)';
      for (var i = 0; i < contentEls.length; i += 1) {
        contentEls[i].style.transform = 'translate3d(0,' + offset + 'px,0)';
      }
    }

    function flush() {
      raf = 0;
      if (pending === null) { return; }
      var y = pending;
      pending = null;
      if (dead()) { return; }
      paint(y);
    }

    /* 一帧最多写一次 transform：touchmove 可能一帧来 2~3 次 */
    function queue(y) {
      pending = y;
      if (raf) { return; }
      if (typeof global.requestAnimationFrame === 'function') {
        raf = global.requestAnimationFrame(flush);
      } else {
        raf = global.setTimeout(flush, 16);
      }
    }

    function cancelFrame() {
      if (!raf) { return; }
      if (typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(raf); }
      else { global.clearTimeout(raf); }
      raf = 0;
      pending = null;
    }

    function flushNow() {
      if (pending === null) { return; }
      var y = pending;
      cancelFrame();
      paint(y);
    }

    function clearSettling() {
      if (settleTimer) { global.clearTimeout(settleTimer); settleTimer = 0; }
      if (settleDone && typeof pull.removeEventListener === 'function') {
        pull.removeEventListener('transitionend', settleDone);
      }
      settleDone = null;
      if (host && host.classList) { host.classList.remove('is-pull-settling'); }
    }

    /* 结算后清空内联 transform：常驻 transform 会给后代制造 containing block */
    function resetTransforms() {
      pull.style.transform = '';
      for (var i = 0; i < contentEls.length; i += 1) { contentEls[i].style.transform = ''; }
    }

    function settle() {
      cancelFrame();
      clearSettling();
      if (dead()) { return; }
      if (reduced) {
        resetTransforms();
        return;
      }
      /* 先把当前位移提交到样式再开过渡：同一帧里同时加 class 和改 transform
         会让浏览器拿不到起点而瞬移。读一次 offsetHeight 只发生在手势结束时。 */
      void pull.offsetHeight;
      if (host && host.classList) { host.classList.add('is-pull-settling'); }
      paint(0);
      /* 不依赖 transitionend（三个元素各自触发，先到的会提前撤掉过渡）；
         260ms 略长于 --dur-base 180ms，动画结束后清内联 transform 不产生视觉变化 */
      settleTimer = global.setTimeout(function () {
        settleTimer = 0;
        clearSettling();
        resetTransforms();
      }, 260);
    }

    function onStart(event) {
      if (busy || dead() || scroller.scrollTop > 0) { return; }
      var touch = event.touches && event.touches[0];
      if (!touch) { return; }
      clearSettling();
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
      pulled = false;
      ready = false;
    }

    function onMove(event) {
      if (!tracking || busy) { return; }
      var touch = event.touches && event.touches[0];
      if (!touch) { return; }
      if (scroller.scrollTop > 0) {
        tracking = false;
        pulled = false;
        ready = false;
        queue(0);
        setText('下拉刷新');
        return;
      }
      var dy = touch.clientY - startY;
      var dx = touch.clientX - startX;
      if (dy <= 0) {
        if (pulled) {
          pulled = false;
          ready = false;
          queue(0);
          setText('下拉刷新');
        }
        return;
      }
      if (!pulled) {
        /* 8px 内不抢手势；横向意图优先交还给系统（滚动 / 侧滑返回） */
        if (dy < 8 || Math.abs(dx) > dy) { return; }
        pulled = true;
        if (host && host.classList) { host.classList.add('is-pulling'); }
      }
      /* 只有确认「到顶 + 纵向向下」才拦默认行为，正常滚动一律不拦 */
      if (event.cancelable) {
        try { event.preventDefault(); } catch (error) { /* 忽略 */ }
      }
      var visual = Math.min(PULL_VISUAL_MAX, Math.round(dy * 0.7));
      ready = visual >= PULL_READY;
      queue(visual);
      setText(ready ? '松开刷新' : '下拉刷新');
    }

    function onEnd() {
      if (!tracking || busy) { return; }
      tracking = false;
      flushNow();
      if (host && host.classList) { host.classList.remove('is-pulling'); }
      if (!pulled || !ready) {
        setText('下拉刷新');
        settle();
        return;
      }
      busy = true;
      setText('正在刷新…');
      /* 停在触发位，等数据回来再回弹；刷新本身走 app.refresh() */
      cancelFrame();
      paint(PULL_READY);
      if (host) { host.setAttribute('aria-busy', 'true'); }
      var result = null;
      try { result = app.refresh(); } catch (error) { result = null; }
      var finish = function () {
        busy = false;
        if (host) { host.removeAttribute('aria-busy'); }
        /* 刷新会整屏重建时旧节点已销毁：不再写旧 DOM，但 toast 是全局的，不能吞掉 */
        if (!dead()) { settle(); }
        if (result && result.ok === false) {
          toast('刷新失败，请稍后重试', { type: 'danger' });
        } else {
          toast('已刷新', { type: 'success' });
        }
      };
      if (result && typeof result.then === 'function') { result.then(finish, finish); }
      else { global.setTimeout(finish, 360); }
    }

    function onCancel() {
      tracking = false;
      if (host && host.classList) { host.classList.remove('is-pulling'); }
      ready = false;
      if (!busy) { setText('下拉刷新'); settle(); }
    }

    scroller.addEventListener('touchstart', onStart, { passive: true });
    /* 非 passive：仅在「到顶 + 纵向向下」时 preventDefault，其余滚动不拦 */
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd, { passive: true });
    scroller.addEventListener('touchcancel', onCancel, { passive: true });

    return function unbind() {
      scroller.removeEventListener('touchstart', onStart, { passive: true });
      scroller.removeEventListener('touchmove', onMove, { passive: false });
      scroller.removeEventListener('touchend', onEnd, { passive: true });
      scroller.removeEventListener('touchcancel', onCancel, { passive: true });
      cancelFrame();
      clearSettling();
      if (host) {
        host.classList.remove('is-pulling');
        host.removeAttribute('aria-busy');
      }
    };
  }

  /* ---------------- 屏幕 ---------------- */

  function render(root, ctx) {
    root = root || document.createElement('div');
    var db = readDb(ctx);
    var today = todayStr();
    var month = monthOf(today);
    var bookId = activeBookId(db);

    var books = rows(db, 'books');
    var book = null;
    for (var i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].id === bookId) { book = books[i]; break; }
    }
    if (!book && books.length) { book = books[0] || null; }

    var scope = bookId ? { bookId: bookId } : undefined;

    var params = (ctx && ctx.params) || {};

    /* 月汇总/预算各算一次：头部、预算卡与预算 Sheet 共用同一份结果（D2-37 零二次读库） */
    var view = {
      dead: false,
      destroyed: false,
      db: db,
      ctx: ctx,
      scope: scope,
      today: today,
      month: month,
      budget: null,
      controller: null,
      head: null,
      inner: null,
      budgetCard: null
    };
    var summary = readSummary(db, month, scope);
    view.budget = readBudget(db, month, scope);

    var due = recurrence && typeof recurrence.dueInstances === 'function'
      ? recurrence.dueInstances(db, today) || []
      : [];
    if (bookId) {
      due = due.filter(function (item) { return !item.bookId || item.bookId === bookId; });
    }

    /* 树形（UI.md §4.1）：.app-screen__body.s-home > div[data-home-view="1"]
       >（.s-home-pull / header.s-home-head / .s-home-inner）。头部整块属于本屏（immersive），
       黄底通栏靠它吃满宽度；其余内容进 s-home-inner 吃页面左右留白。 */
    var viewBody = el('div', { className: 's-home-view' });
    viewBody.setAttribute('data-home-view', '1');
    root.appendChild(viewBody);

    /* 指示器与头部同底色：拖动时指示器底边恒贴内容顶边，拉出的空隙不会露白。
       位置/高度全在 home.css，JS 只写 transform（见 bindPullRefresh）。 */
    var pull = el('div', {
      className: 's-home-pull',
      text: '下拉刷新',
      role: 'status',
      'aria-live': 'polite'
    });
    viewBody.appendChild(pull);
    var head = buildHead(book, month, summary, view);
    viewBody.appendChild(head);

    var inner = el('div', { className: 's-home-inner' });
    view.inner = inner;

    var budgetCard = buildBudget(view);
    view.budgetCard = budgetCard;
    if (budgetCard) { inner.appendChild(budgetCard); }

    var dueCard = buildDue(due);
    if (dueCard) { inner.appendChild(dueCard); }

    /* 嵌入明细宿主：就是这个 div 本身（ledger.render 会加 s-ledger / --embedded /
       data-ledger-embed="1"）；不得包任何中间壳类（D2-14 / UI.md:310），
       也不得给它加 c-stagger（transform 会让 sticky 失效）。 */
    var ledgerHost = el('div');
    inner.appendChild(ledgerHost);

    viewBody.appendChild(inner);
    root.appendChild(viewBody);

    var unbindPull = bindPullRefresh(
      root.closest ? root.closest('.app-screen') : null,
      pull,
      [head, inner],
      viewBody,
      function () { return view.dead; }
    );

    view.controller = mountLedger(ledgerHost, ctx, view);

    /* 从解读页「调整预算」返回：#/home?focus=budget 把预算卡滚到视野并聚焦。
       延后一帧：router 在 render 返回后才把 root 挂进 .app-screen。 */
    if (String(params.focus || '') === 'budget' && view.budgetCard) {
      global.setTimeout(function () {
        if (view.dead || view.destroyed || !view.budgetCard) { return; }
        try { view.budgetCard.focus(); } catch (error) { warn('[home] 预算卡聚焦失败', error); }
        if (typeof view.budgetCard.scrollIntoView === 'function') {
          view.budgetCard.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      }, 0);
    }

    if (firstPaint && kit() && !reducedMotion()) {
      kit().stagger([budgetCard, dueCard], { step: 34 });
      firstPaint = false;
    }

    if (due.length > 0) {
      inner.setAttribute('data-due-count', String(due.length));
    }

    return {
      /* `[D2-17]` 销毁顺序：embeddedController.destroy() → 解绑 bindPullRefresh → 本轮 token 失效；
         重复调用恒为空操作（destroyed 守卫先于一切副作用）。 */
      destroy: function () {
        if (view.destroyed) { return; }
        view.destroyed = true;
        var controller = view.controller;
        view.controller = null;
        if (controller && typeof controller.destroy === 'function') {
          try { controller.destroy(); } catch (error) { warn('[home] 销毁嵌入明细失败', error); }
        }
        if (typeof unbindPull === 'function') { unbindPull(); }
        view.dead = true;
      }
    };
  }

  var screen = {
    title: '首页',
    immersive: true,
    subtitle: '',
    render: render
  };

  XZB.screens.register('home', screen);
}(window));