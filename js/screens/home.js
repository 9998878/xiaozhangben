/* 小账本 2.0 · js/screens/home.js
 * 概览屏（2.8 精简）：英雄卡（本月结余 + 环比）、预算环与「今天还能花」、
 * 待入账定期账单、最近流水（5 条）、底部 TabBar 中央「+」。
 * 2.8 变更：迷你趋势线 / 下拉刷新 / 预算重复百分比 pill / 「当前账本」重复文案删除。
 *
 * 契约：XZB.screens.register('home', { title, subtitle, render })
 * 硬规则：不碰 IndexedDB / localStorage / TabBar；用户数据一律 textContent。
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

  var RECENT_LIMIT = 5;   /* M8：首页只露 5 条，更多走「查看全部」进明细 */

  /* 分类图标名与 icons.js 的差异（种子数据里的 game / housing 等） */
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

  /* 只在本次会话第一次进概览时播错位入场，之后 rerender 不再抖 */
  var firstPaint = true;

  /* ---------------- 依赖取用 ---------------- */

  function uiApi() { return XZB.ui || XZB.UI || {}; }
  function kit() { return uiApi().kit || null; }
  function toastApi() { return uiApi().toast || null; }
  function appApi() { return XZB.app || XZB.App || null; }

  function el(tag, attrs, kids) {
    var k = kit();
    if (k) { return k.el(tag, attrs, kids); }
    var node = document.createElement(String(tag || 'div'));
    var options = attrs && typeof attrs === 'object' ? attrs : {};
    var className = options.className || options['class'];
    if (className) { node.className = String(className); }
    if (options.text !== undefined) { node.textContent = String(options.text); }
    return node;
  }

  function iconNode(name, size) {
    var k = kit();
    var key = ICON_ALIAS[name] || name || 'ellipsis';
    if (k) { return k.icon(key, size || 20); }
    var span = el('span', { className: 's-home-glyph' });
    span.textContent = String(name || '·').slice(0, 1);
    return span;
  }

  function moneyNode(cents, options) {
    var k = kit();
    if (k) { return k.money(cents, options); }
    return el('span', { text: String(cents) });
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

  function indexById(items) {
    var map = Object.create(null);
    for (var i = 0; i < (items || []).length; i += 1) {
      var item = items[i];
      if (item && typeof item.id === 'string') { map[item.id] = item; }
    }
    return map;
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

  function weekdayLabel(dateText) {
    if (dates && typeof dates.weekdayCN === 'function') {
      return dates.weekdayCN(dateText);
    }
    return '';
  }

  function sortTransactions(items) {
    return items.slice().sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      var at = String(a.time || '');
      var bt = String(b.time || '');
      if (at !== bt) { return at < bt ? 1 : -1; }
      var ac = String(a.createdAt || '');
      var bc = String(b.createdAt || '');
      if (ac === bc) { return 0; }
      return ac < bc ? 1 : -1;
    });
  }

  function collect(db, bookId) {
    var all = rows(db, 'transactions');
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      var tx = all[i];
      if (!tx || tx.deleted === true) { continue; }
      if (bookId && tx.bookId !== bookId) { continue; }
      out.push(tx);
    }
    return sortTransactions(out);
  }

  function daysInMonth(month) {
    var parts = String(month || '').split('-');
    if (parts.length !== 2) { return 30; }
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    if (!y || !m) { return 30; }
    return new Date(y, m, 0).getDate();
  }

  /* ---------------- 标题同步 ---------------- */

  function syncTitle(ctx, title, subtitle) {
    if (!ctx || typeof ctx.setTitle !== 'function') { return; }
    try { ctx.setTitle(title, subtitle); } catch (error) { /* 忽略 */ }
    global.setTimeout(function () {
      var current = XZB.router && typeof XZB.router.current === 'function' ? XZB.router.current() : null;
      if (current && current.view === 'home') {
        try { ctx.setTitle(title, subtitle); } catch (error) { /* 忽略 */ }
      }
    }, 0);
  }

  /* ---------------- 区块：大标题（月份 + 账本，鲨鱼式首屏标题） ---------------- */

  function monthShort(month) {
    var parts = String(month || '').split('-');
    return parts.length === 2 ? Number(parts[1]) + '月' : '';
  }

  function buildTitle(book, month) {
    var bar = el('div', { className: 's-home-titlebar' });
    var link = el('a', {
      className: 's-home-title',
      href: '#/books',
      'aria-label': '账本 ' + (book ? book.name : '未选择') + '，切换到账本列表'
    });
    link.appendChild(el('span', {
      className: 's-home-title__text',
      text: (monthShort(month) || '本月') + ' · ' +
        (book ? String(book.name || '未命名账本') : '选择账本')
    }));
    link.appendChild(iconNode('chevron-down', 18));
    bar.appendChild(link);
    return bar;
  }

  /* ---------------- 区块：本月支出大卡（白底大卡取代深色英雄卡） ---------------- */

  function buildHero(summary, mom) {
    var card = el('section', { className: 's-home-hero', 'aria-label': '本月支出' });

    var head = el('div', { className: 's-home-hero__head' });
    head.appendChild(el('span', { className: 's-home-hero__label', text: '本月支出' }));

    var deltaPct = mom && mom.expense ? Number(mom.expense.deltaPct) : null;
    if (deltaPct !== null && isFinite(deltaPct) && Math.abs(deltaPct) >= 0.05) {
      var k = kit();
      var pill = k
        ? k.delta(deltaPct)
        : el('span', { text: (deltaPct > 0 ? '↑' : '↓') + Math.abs(deltaPct).toFixed(1) + '%' });
      /* 黄底黑字 = 比上月花得多（强提醒），灰底 = 花得少 */
      pill.classList.add(deltaPct > 0 ? 'c-delta--hero' : 'c-delta-pill--down');
      pill.setAttribute('aria-label', '本月支出比上月' +
        (deltaPct > 0 ? '增加' : '减少') + Math.abs(deltaPct).toFixed(1) + '%');
      head.appendChild(pill);
    }
    card.appendChild(head);

    var amount = el('p', { className: 's-home-hero__amount' });
    amount.appendChild(moneyNode(summary.expenseCents, { size: 'xl' }));
    card.appendChild(amount);

    /* 支出是首屏主角；收入/结余降为卡底一行灰字，不再对半两列 */
    var foot = el('p', { className: 's-home-hero__foot' });
    foot.appendChild(el('span', {
      className: 's-home-hero__foot-item',
      text: '收入 ' + fmt(summary.incomeCents)
    }));
    foot.appendChild(el('span', { className: 's-home-hero__foot-sep', text: '·' }));
    foot.appendChild(el('span', {
      className: 's-home-hero__foot-item',
      text: '结余 ' + fmt(summary.netCents)
    }));
    card.appendChild(foot);
    return card;
  }

  /* ---------------- 区块：预算（环形图 → 黄色进度条，一行读懂） ---------------- */

  function buildBudget(budget, today) {
    var totalCents = Number(budget.totalCents) || 0;
    var k = kit();

    if (totalCents <= 0) {
      var blank = el('a', {
        className: 's-home-budget s-home-budget--blank c-pressable',
        href: '#/plan',
        'aria-label': '还没有本月预算，去设置'
      });
      blank.appendChild(el('span', { className: 's-home-budget__title', text: '本月预算' }));
      blank.appendChild(el('span', { className: 's-home-budget__remain', text: '去设置' }));
      return blank;
    }

    var spentCents = Number(budget.spentCents) || 0;
    var remainingCents = Math.max(0, Number(budget.remainingCents) || 0);
    var overCents = Math.max(0, spentCents - totalCents);
    var pct = Number(budget.pct) || 0;
    var danger = overCents > 0 || budget.state === 'over';

    var card = el('a', {
      className: 's-home-budget c-pressable' + (danger ? ' s-home-budget--danger' : ''),
      href: '#/plan',
      'aria-label': '本月预算已用百分之' + Math.round(pct) + '，查看预算与目标'
    });

    var head = el('div', { className: 's-home-budget__head' });
    head.appendChild(el('span', { className: 's-home-budget__title', text: '本月预算' }));
    head.appendChild(el('span', {
      className: 's-home-budget__remain',
      text: danger ? '超支 ' + fmt(overCents) : '剩 ' + fmt(remainingCents)
    }));
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

    if (k) {
      card.appendChild(k.bar(pct, danger ? 'danger' : ''));
    }

    /* 当月才谈「每天可花」；超支后没有余额可分 */
    var month = String(today || '').slice(0, 7);
    if (!danger && remainingCents > 0 && String(budget.month || month) === month) {
      var day = Number(String(today).slice(8, 10)) || 1;
      var left = Math.max(1, daysInMonth(month) - day + 1);
      var daily = Math.floor(remainingCents / left);
      card.appendChild(el('p', {
        className: 's-home-budget__daily-text',
        text: '每天可花 ' + fmt(daily) + ' · 还剩 ' + left + ' 天'
      }));
    }
    return card;
  }

  /* ---------------- 区块：待入账 ---------------- */

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

    var k = kit();
    main.appendChild(k ? k.tile('repeat', { tone: 'warn', size: 'md' }) : iconNode('repeat', 20));

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

  /* ---------------- 区块：最近流水 ---------------- */

  function accountText(tx, accounts) {
    var from = accounts[tx.accountId];
    if (tx.type === 'transfer') {
      var to = accounts[tx.toAccountId];
      return '转出 ' + (from ? from.name : '账户') + ' → ' + (to ? to.name : '账户');
    }
    var text = from ? String(from.name || '') : '';
    var note = String(tx.note || '').trim();
    if (note) { text += (text ? ' · ' : '') + note; }
    return text || '未填写备注';
  }

  function buildRow(tx, maps) {
    var category = maps.categories[tx.categoryId] || null;
    var isTransfer = tx.type === 'transfer';
    var isIncome = tx.type === 'income';
    var title = isTransfer ? '转账' : (category ? String(category.name || '未分类') : '未分类');
    var iconName = isTransfer ? 'transfer' : (category && category.icon ? category.icon : 'ellipsis');
    var tone = isTransfer ? 'tint' : (maps.tones[tx.categoryId] || 'cat-12');
    var amountCents = Math.abs(Number(tx.amountCents) || 0);

    var side = el('span', { className: 's-home-row__side' });
    /* 金额黑粗：支出带 −、收入带 +、转账灰，不再用红绿区分首页流水 */
    side.appendChild(moneyNode(isTransfer ? amountCents : (isIncome ? amountCents : -amountCents), {
      size: 'md',
      tone: isTransfer ? 'transfer' : '',
      sign: isIncome
    }));
    side.appendChild(el('span', {
      className: 's-home-row__time',
      text: String(tx.time || '') || '全天'
    }));

    var k = kit();
    var row;
    if (k) {
      row = k.row({
        href: '#/add?id=' + encodeURIComponent(String(tx.id || '')),
        icon: ICON_ALIAS[iconName] || iconName,
        tone: tone,
        iconSize: 19,
        title: title,
        sub: accountText(tx, maps.accounts),
        trailing: side,
        ariaLabel: title + ' ' + (isTransfer ? '' : (isIncome ? '收入 ' : '支出 ')) +
          fmt(amountCents) + '，点击编辑'
      });
      row.classList.add('c-row--two-line');
    } else {
      row = el('a', { className: 'c-row', href: '#/add?id=' + encodeURIComponent(String(tx.id || '')) });
      row.appendChild(el('span', { className: 'c-row__title', text: title }));
    }
    return row;
  }

  function buildRecent(list, maps) {
    var k = kit();
    var section = k
      ? k.section({ title: '最近流水', action: { label: '查看全部', href: '#/ledger' } })
      : el('section', { className: 'c-section' });

    if (!list.length) {
      var emptyBox = el('div', { className: 's-home-empty' });
      emptyBox.appendChild(k
        ? k.empty({
          icon: 'wallet',
          iconSize: 38,
          title: '还没有一笔流水',
          text: '记下第一笔，月底就能看清钱都花在哪。',
          action: { label: '记下第一笔', variant: 'primary', href: '#/add' }
        })
        : el('p', { text: '还没有一笔流水' }));
      section.appendChild(emptyBox);
      return section;
    }

    var groups = [];
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      var last = groups[groups.length - 1];
      if (!last || last.date !== tx.date) {
        last = { date: tx.date, items: [], expenseCents: 0, incomeCents: 0 };
        groups.push(last);
      }
      if (tx.type === 'income') { last.incomeCents += Math.abs(Number(tx.amountCents) || 0); }
      else if (tx.type === 'expense') { last.expenseCents += Math.abs(Number(tx.amountCents) || 0); }
      last.items.push(tx);
    }

    for (var g = 0; g < groups.length; g += 1) {
      var day = groups[g];
      var dayBox = el('div', { className: 's-home-day' });
      var head = el('div', { className: 's-home-day__head' });
      head.appendChild(el('span', {
        className: 's-home-day__date',
        text: humanDate(day.date) + (weekdayLabel(day.date) ? ' · ' + weekdayLabel(day.date) : '')
      }));
      var parts = [];
      if (day.expenseCents > 0) { parts.push('支出 ' + fmt(day.expenseCents)); }
      if (day.incomeCents > 0) { parts.push('收入 ' + fmt(day.incomeCents)); }
      head.appendChild(el('span', {
        className: 's-home-day__sum',
        text: parts.length ? parts.join(' · ') : '无金额'
      }));
      dayBox.appendChild(head);

      var group = el('div', { className: 'c-group' });
      for (var r = 0; r < day.items.length; r += 1) {
        group.appendChild(buildRow(day.items[r], maps));
      }
      dayBox.appendChild(group);
      section.appendChild(dayBox);
    }
    return section;
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
    var bookName = book && book.name ? String(book.name) : '日常账本';

    var scope = bookId ? { bookId: bookId } : undefined;
    var summary = stats && typeof stats.monthSummary === 'function'
      ? stats.monthSummary(db, month, scope)
      : { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 };
    var budget = stats && typeof stats.budgetProgress === 'function'
      ? stats.budgetProgress(db, month, scope)
      : { totalCents: 0, spentCents: 0, remainingCents: 0, pct: 0, state: 'none' };
    if (budget && budget.month === undefined) { budget.month = month; }
    var mom = stats && typeof stats.mom === 'function'
      ? stats.mom(db, month, scope)
      : null;

    var due = recurrence && typeof recurrence.dueInstances === 'function'
      ? recurrence.dueInstances(db, today) || []
      : [];
    if (bookId) {
      due = due.filter(function (item) { return !item.bookId || item.bookId === bookId; });
    }

    var transactions = collect(db, bookId);
    var recent = transactions.slice(0, RECENT_LIMIT);

    var categories = rows(db, 'categories');
    var k = kit();
    var maps = {
      categories: indexById(categories),
      accounts: indexById(rows(db, 'accounts')),
      tones: k ? k.categoryTones(categories) : {}
    };

    /* M8：标题副标题只保留月份（账本名在账本条上） */
    syncTitle(ctx, '概览', monthLabel(month));

    var inner = el('div', { className: 's-home-inner' });

    var titleBar = buildTitle(book, month);
    inner.appendChild(titleBar);

    var heroCard = buildHero(summary, mom);
    inner.appendChild(heroCard);

    var budgetCard = buildBudget(budget, today);
    if (budgetCard) { inner.appendChild(budgetCard); }

    var dueCard = buildDue(due);
    if (dueCard) { inner.appendChild(dueCard); }

    var recentSection = buildRecent(recent, maps);
    inner.appendChild(recentSection);

    /* D8：纯本地应用无外部数据源，下拉刷新与「右下角 +」的错误提示删除；
       空态已由 buildRecent 的 c-empty 承担（含「记下第一笔」CTA）。 */
    root.appendChild(inner);

    if (firstPaint && k && !reducedMotion()) {
      k.stagger([titleBar, heroCard, budgetCard, recentSection], { step: 34 });
      firstPaint = false;
    }

    if (due.length > 0) {
      inner.setAttribute('data-due-count', String(due.length));
    }
  }

  var screen = {
    title: '概览',
    subtitle: '当前账本',
    render: render
  };

  XZB.screens.register('home', screen);
}(window));
