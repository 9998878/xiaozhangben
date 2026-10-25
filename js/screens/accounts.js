/* ============================================================
   小账本 2.0 — 屏幕：账户（accounts）
   owner: 前端#1（T12）
   依赖：XZB.core.{money,dates,schema,stats} / XZB.dom / XZB.ui.{icons,toast,sheet}
   只读接口：XZB.app.db()；写入一律走 XZB.app.commit(mutator,{label})
   ============================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB;
  if (!XZB || !XZB.screens) { return; }

  var KEY = 'accounts';
  var PAGE_SIZE = 50;
  var MAX_ACCOUNT_NAME = 20;
  var MAX_ACCOUNT_NOTE = 60;
  var MAX_TX_NOTE = 80;

  var dom = (XZB.ui && XZB.ui.dom) || XZB.dom;

  /* 资金账户分组顺序（schema.ACCOUNT_TYPES 去掉 credit） */
  var FUND_TYPES = ['cash', 'debit', 'wechat', 'alipay', 'savings'];
  var TYPE_ORDER = ['cash', 'debit', 'wechat', 'alipay', 'savings', 'credit'];

  var TYPE_LABEL = {
    cash: '现金',
    debit: '银行卡',
    wechat: '微信',
    alipay: '支付宝',
    credit: '信用卡',
    savings: '储蓄'
  };

  var TYPE_ICON = {
    cash: 'wallet',
    debit: 'card',
    wechat: 'wechat',
    alipay: 'alipay',
    credit: 'credit',
    savings: 'piggy'
  };

  /* 颜色调色板：只引用 tokens.css 里的 --acc-* 变量，JS 里不出现色值字面量 */
  var TONES = [
    { key: 'cash', varName: '--acc-cash', label: '现金黄' },
    { key: 'bank', varName: '--acc-bank', label: '银行蓝' },
    { key: 'wechat', varName: '--acc-wechat', label: '微信绿' },
    { key: 'alipay', varName: '--acc-alipay', label: '支付青' },
    { key: 'credit', varName: '--acc-credit', label: '信用橙' },
    { key: 'savings', varName: '--acc-savings', label: '储蓄紫' }
  ];

  /* 账户类型 -> 调色板色板键 */
  var TYPE_TONE = {
    cash: 'cash',
    debit: 'bank',
    wechat: 'wechat',
    alipay: 'alipay',
    credit: 'credit',
    savings: 'savings'
  };

  var ICON_CHOICES = [
    'wallet', 'card', 'bank', 'cash',
    'wechat', 'alipay', 'credit', 'piggy',
    'savings', 'briefcase', 'house', 'target',
    'invest', 'gift', 'phone', 'book'
  ];

  var AMOUNT_MSG = {
    E_AMOUNT_EMPTY: '请输入金额',
    E_AMOUNT_INVALID: '金额格式不对',
    E_AMOUNT_PRECISION: '金额最多两位小数',
    E_AMOUNT_RANGE: '金额超出可记录范围',
    E_AMOUNT_NEGATIVE: '金额不能为负数',
    E_AMOUNT_TOO_LARGE: '金额太大'
  };

  var ACCOUNT_MSG = {
    E_ACCOUNT_LIMIT: '额度必须是非负整数',
    E_ACCOUNT_BILLDAY: '账单日必须是 1–28',
    E_ACCOUNT_TYPE: '账户类型不对',
    E_ACCOUNT_MISSING: '账户不存在',
    E_ACCOUNT_ARCHIVED: '账户已归档，不能记账',
    E_TRANSFER_SAME: '不能转给同一个账户',
    E_BOOK_LAST: '至少要保留一个未归档账本'
  };

  /* ---------------- 模块访问 ---------------- */

  function coreMod(name) {
    return (XZB.core && XZB.core[name]) || null;
  }

  function moneyApi() { return coreMod('money'); }
  function datesApi() { return coreMod('dates'); }
  function statsApi() { return coreMod('stats'); }
  function schemaApi() { return coreMod('schema'); }
  function iconsApi() { return (XZB.ui && XZB.ui.icons) || null; }

  /* ---------------- DOM 小工具 ---------------- */

  function h(tag, attrs, children) {
    return dom.el(tag, attrs, children);
  }

  function t(tag, className, value) {
    return dom.el(tag, { className: className, text: value === undefined || value === null ? '' : String(value) });
  }

  function kids(list) {
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i]) { out.push(list[i]); }
    }
    return out;
  }

  /* icons.node() 的 SVG 可能缺少命名空间（DOMParser 按 XML 解析图标字符串时
     没有 xmlns），浏览器会把这种节点当 HTML 未知元素，尺寸塌成 0。
     在 SVG 命名空间里重建，保证图标能画出来。 */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function rebuildSvg(src) {
    var el = document.createElementNS(SVG_NS, src.tagName);
    var attrs = src.attributes || [];
    for (var a = 0; a < attrs.length; a += 1) {
      el.setAttribute(attrs[a].name, attrs[a].value);
    }
    for (var c = 0; c < src.childNodes.length; c += 1) {
      var child = src.childNodes[c];
      if (child.nodeType === 1) { el.appendChild(rebuildSvg(child)); }
    }
    return el;
  }

  function iconEl(name, size, className) {
    var api = iconsApi();
    var node = api && typeof api.node === 'function' ? api.node(name, { size: size || 20 }) : null;
    var wrap = h('span', { className: className || 's-accounts-glyph' });
    if (node) {
      wrap.appendChild(node.namespaceURI === SVG_NS ? node : rebuildSvg(node));
    } else {
      wrap.textContent = '';
    }
    return wrap;
  }

  function toast(ctx, message, options) {
    var opts = options || {};
    if (ctx && typeof ctx.toast === 'function') {
      ctx.toast(message, opts);
      return;
    }
    if (XZB.ui && XZB.ui.toast) { XZB.ui.toast.show(message, opts); }
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmt(cents, opts) {
    var m = moneyApi();
    if (!m || typeof m.formatCents !== 'function') { return String(cents || 0); }
    return m.formatCents(cents || 0, opts || {});
  }

  function parseCents(text, allowNegative) {
    var m = moneyApi();
    if (!m || typeof m.parseAmount !== 'function') { return { ok: false, code: 'E_AMOUNT_INVALID' }; }
    var raw = text === null || text === undefined ? '' : String(text).trim();
    if (raw === '') { return { ok: false, code: 'E_AMOUNT_EMPTY' }; }
    return m.parseAmount(raw, { allowNegative: allowNegative !== false });
  }

  function todayStr() {
    var d = datesApi();
    if (d && typeof d.todayStr === 'function') { return d.todayStr(); }
    return '1970-01-01';
  }

  function nowIso() {
    var d = datesApi();
    if (d && typeof d.nowIso === 'function') { return d.nowIso(); }
    return new Date().toISOString();
  }

  function nowTime() {
    var d = datesApi();
    if (d && typeof d.nowTime === 'function') { return d.nowTime(); }
    return '00:00';
  }

  function isValidDate(value) {
    var d = datesApi();
    if (d && typeof d.isValidDateStr === 'function') { return d.isValidDateStr(value); }
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function cssVar(name) {
    try {
      var styles = global.getComputedStyle(global.document.documentElement);
      var value = styles ? styles.getPropertyValue(name) : '';
      return String(value || '').trim();
    } catch (error) {
      return '';
    }
  }

  function toneForColor(color) {
    var hex = String(color || '').toUpperCase();
    if (!hex) { return ''; }
    for (var i = 0; i < TONES.length; i += 1) {
      if (cssVar(TONES[i].varName).toUpperCase() === hex) { return TONES[i].key; }
    }
    return '';
  }

  function toneOf(account) {
    var byColor = toneForColor(account && account.color);
    if (byColor) { return byColor; }
    return TYPE_TONE[(account && account.type) || 'cash'] || 'cash';
  }

  function avatarClass(tone, extra) {
    return 'c-row__icon s-accounts-avatar s-accounts-avatar--' + tone + (extra ? ' ' + extra : '');
  }

  function scrollScreen(root, top) {
    var scroller = root && root.parentNode;
    if (scroller && typeof scroller.scrollTop === 'number') {
      scroller.scrollTop = top === undefined ? 0 : top;
    }
  }

  /* ---------------- 数据查询 ---------------- */

  function findById(list, id) {
    if (!Array.isArray(list)) { return null; }
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function aliveAccounts(db) {
    var out = [];
    var list = (db && db.accounts) || [];
    for (var i = 0; i < list.length; i += 1) {
      var acc = list[i];
      if (!acc || acc.deleted === true) { continue; }
      if (acc.archived === true) { continue; }
      out.push(acc);
    }
    out.sort(function (a, b) {
      var ai = TYPE_ORDER.indexOf(a.type);
      var bi = TYPE_ORDER.indexOf(b.type);
      if (ai !== bi) { return ai - bi; }
      var as = typeof a.sort === 'number' ? a.sort : 10;
      var bs = typeof b.sort === 'number' ? b.sort : 10;
      if (as !== bs) { return as - bs; }
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
    return out;
  }

  function archivedAccounts(db) {
    var out = [];
    var list = (db && db.accounts) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].deleted !== true && list[i].archived === true) { out.push(list[i]); }
    }
    return out;
  }

  function accountTxns(db, accountId) {
    var out = [];
    var list = (db && db.transactions) || [];
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (tx.accountId === accountId || tx.toAccountId === accountId) { out.push(tx); }
    }
    out.sort(function (a, b) {
      if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
      if (a.time !== b.time) { return a.time < b.time ? 1 : -1; }
      if (a.createdAt !== b.createdAt) { return a.createdAt < b.createdAt ? 1 : -1; }
      return 0;
    });
    return out;
  }

  function deltaFor(tx, accountId) {
    var amount = typeof tx.amountCents === 'number' ? tx.amountCents : 0;
    if (tx.type === 'income') { return tx.accountId === accountId ? amount : 0; }
    if (tx.type === 'expense') { return tx.accountId === accountId ? -amount : 0; }
    if (tx.type === 'transfer') {
      if (tx.toAccountId === accountId) { return amount; }
      if (tx.accountId === accountId) { return -amount; }
    }
    return 0;
  }

  function txTitle(db, tx) {
    if (tx.type === 'transfer') {
      var to = findById((db && db.accounts) || [], tx.toAccountId);
      if (to && to.type === 'credit') { return '还款给' + to.name; }
      return tx.note || '转账';
    }
    if (tx.note) { return tx.note; }
    var category = findById((db && db.categories) || [], tx.categoryId);
    return category ? category.name : (tx.type === 'income' ? '收入' : '支出');
  }

  function txIcon(db, tx) {
    if (tx.type === 'transfer') { return 'transfer'; }
    var category = findById((db && db.categories) || [], tx.categoryId);
    var name = category && category.icon ? String(category.icon) : '';
    var api = iconsApi();
    if (name && api && typeof api.has === 'function' && api.has(name)) { return name; }
    return tx.type === 'income' ? 'arrow-up-right' : 'tag';
  }

  /* ---------------- 屏幕入口 ---------------- */

  function render(root, ctx) {
    if (!root || !ctx) { return; }
    if (!dom) { return; }
    var db = ctx.db;
    if (!db) {
      root.appendChild(emptyState('数据还没准备好', '请稍候再进入账户页', null));
      return;
    }
    var params = ctx.params || {};
    var accountId = params.ac ? String(params.ac) : '';
    if (accountId) {
      renderDetail(root, ctx, db, accountId);
      return;
    }
    if (detailState.offScroll) {
      try { detailState.offScroll(); } catch (error) { /* 忽略 */ }
      detailState.offScroll = null;
    }
    detailState.acId = null;
    renderList(root, ctx, db);
  }

  /* ---------------- 列表视图 ---------------- */

  function renderList(root, ctx, db) {
    ctx.setTitle('账户');
    var alive = aliveAccounts(db);
    var archived = archivedAccounts(db);
    var balances = null;
    var stats = statsApi();
    if (stats && typeof stats.accountBalances === 'function') {
      balances = stats.accountBalances(db) || {};
    }
    if (!balances) { balances = {}; }

    if (!alive.length && !archived.length) {
      root.appendChild(emptyState('还没有账户', '建一个现金或银行卡账户就能开始记账', function () {
        openAccountForm(ctx, null);
      }));
      return;
    }

    root.appendChild(heroCard(db, alive, balances));
    root.appendChild(toolbar(ctx));

    var funds = alive.filter(function (acc) { return acc.type !== 'credit'; });
    var credits = alive.filter(function (acc) { return acc.type === 'credit'; });

    if (funds.length) {
      root.appendChild(groupSection(ctx, db, '资金账户', funds, balances, funds.length));
    }
    if (credits.length) {
      root.appendChild(groupSection(ctx, db, '信用账户', credits, balances, credits.length));
    }
    if (!funds.length && !credits.length) {
      root.appendChild(emptyState('账户都归档了', '恢复一个账户或新建一个', function () {
        openAccountForm(ctx, null);
      }));
    }

    if (archived.length) {
      root.appendChild(archivedSection(ctx, db, archived, balances));
    }

    /* N2：新建账户降级为列表底部的纯文字入口 */
    var addLink = h('button', {
      className: 's-accounts-add',
      type: 'button',
      'aria-label': '新建账户'
    }, kids([
      iconEl('plus', 16, 's-accounts-add__icon'),
      t('span', '', '新建账户')
    ]));
    dom.on(addLink, 'click', function () { openAccountForm(ctx, null); });
    root.appendChild(addLink);

    root.appendChild(t('p', 's-accounts-footnote',
      '归档的账户不会出现在记账选择器里，历史流水仍然保留、仍可查看。'));
  }

  function heroCard(db, alive, balances) {
    var netCents = 0;
    var fundCents = 0;
    var debtCents = 0;
    var i;
    for (i = 0; i < alive.length; i += 1) {
      var value = balances[alive[i].id];
      var cents = typeof value === 'number' ? value : 0;
      netCents += cents;
      if (alive[i].type === 'credit') {
        if (cents < 0) { debtCents += -cents; }
        else { fundCents += cents; }
      } else {
        fundCents += cents;
      }
    }

    var card = h('div', { className: 'c-card s-accounts-hero' });
    var head = h('div', { className: 's-accounts-hero__head' });
    head.appendChild(t('span', 's-accounts-hero__label', '净资产'));
    head.appendChild(t('span', 'c-badge c-badge--soft s-accounts-hero__count', alive.length + ' 个账户'));
    card.appendChild(head);
    card.appendChild(t('div', 's-accounts-hero__value u-tabular', fmt(netCents)));
    /* M11：资产 / 负债对比直接给出，不用心算 */
    var sub = h('div', { className: 's-accounts-hero__sub' });
    sub.appendChild(t('span', 's-accounts-hero__sub-item', '资产合计 ' + fmt(fundCents)));
    sub.appendChild(t('span', 's-accounts-hero__sub-item', '负债合计 ' + fmt(debtCents)));
    card.appendChild(sub);
    return card;
  }

  function toolbar(ctx) {
    /* N2：转账是唯一主动作（黄底黑字）；「新建账户」降为列表底部文字链接 */
    var bar = h('div', { className: 's-accounts-toolbar' });

    var transferBtn = h('button', {
      className: 'c-btn c-btn--primary s-accounts-toolbar__btn',
      type: 'button'
    }, kids([
      iconEl('transfer', 20, 's-accounts-toolbar__icon'),
      t('span', 's-accounts-toolbar__text', '转账')
    ]));
    dom.on(transferBtn, 'click', function () { openTransferSheet(ctx, {}); });

    bar.appendChild(transferBtn);
    return bar;
  }

  function groupSection(ctx, db, title, accounts, balances, count) {
    var wrap = h('section', { className: 's-accounts-group' });
    var head = h('div', { className: 's-accounts-group__head' });
    head.appendChild(t('h2', 's-accounts-group__title', title));
    head.appendChild(t('span', 's-accounts-group__count', count + ' 个'));
    wrap.appendChild(head);

    var list = h('div', { className: 'c-list s-accounts-list' });
    for (var i = 0; i < accounts.length; i += 1) {
      list.appendChild(accountRow(ctx, db, accounts[i], balances));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function accountRow(ctx, db, account, balances) {
    var stats = statsApi();
    var cents = 0;
    if (stats && typeof stats.accountBalanceCents === 'function') {
      cents = stats.accountBalanceCents(db, account.id);
    } else if (balances && typeof balances[account.id] === 'number') {
      cents = balances[account.id];
    }

    var isCredit = account.type === 'credit';
    var tone = toneOf(account);
    var rowClass = 'c-row c-row--icon c-row--two-line c-row--tappable';
    if (isCredit) { rowClass += ' s-accounts-row--credit'; }
    var row = h('div', {
      className: rowClass,
      role: 'button',
      tabindex: '0',
      dataset: { accountId: account.id }
    });

    var avatar = h('span', { className: avatarClass(tone) });
    avatar.appendChild(iconEl(account.icon || TYPE_ICON[account.type] || 'wallet', 20, 's-accounts-glyph'));
    row.appendChild(avatar);

    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title', account.name));
    main.appendChild(t('span', 'c-row__sub', accountSubtitle(account)));
    row.appendChild(main);

    var valueText = fmt(cents);
    var valueClass = 'c-row__value';
    /* 负余额一律标红（N1：现金 -¥1,129 灰黑不刺眼） */
    if (cents < 0) { valueClass += ' c-row__value--expense'; }
    else if (cents > 0) { valueClass += ' c-row__value--strong'; }
    row.appendChild(t('span', valueClass, valueText));

    row.appendChild(h('span', { className: 'c-row__chevron' }, kids([
      iconEl('chevron-right', 16, 'c-row__chevron-glyph')
    ])));

    if (isCredit) {
      row.appendChild(t('span', 's-accounts-credit-meta', creditMetaText(db, account)));
    }

    function open() { ctx.go('#/accounts?ac=' + encodeURIComponent(account.id)); }
    dom.on(row, 'click', open);
    dom.on(row, 'keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    return row;
  }

  // 副标题用「本月支出 / 收入」，避免和账户名重复（现金 · 现金）这种无用信息。
  function accountSubtitle(account) {
    var db = XZB.app.db();
    var txAll = (db && db.transactions) || [];
    var now = new Date();
    var monthKey = now.getFullYear() + '-' + pad2(now.getMonth() + 1);
    var spent = 0;
    var earned = 0;
    for (var i = 0; i < txAll.length; i++) {
      var tx = txAll[i];
      if (!tx || tx.deleted === true) { continue; }
      if (tx.accountId !== account.id) { continue; }
      if (String(tx.date || '').slice(0, 7) !== monthKey) { continue; }
      if (tx.type === 'expense') { spent += Number(tx.amountCents) || 0; }
      else if (tx.type === 'income') { earned += Number(tx.amountCents) || 0; }
    }
    if (spent === 0 && earned === 0) { return '本月还没有流水'; }
    // 单行只展示一个主指标，避免长金额把副标题撑出省略号；收入只在没有支出时展示。
    if (spent > 0) { return '本月支出 ' + fmt(spent); }
    return '本月收入 ' + fmt(earned);
  }

  // 信用卡行第二行（全宽）：已用 / 额度 / 可用，三者都读 stats 实时算。
  function creditMetaText(db, account) {
    var stats = statsApi();
    var credit = stats && typeof stats.creditAvailable === 'function'
      ? stats.creditAvailable(db, account.id) : null;
    var used = credit && typeof credit.debtCents === 'number'
      ? credit.debtCents : Math.max(0, -(stats ? stats.accountBalanceCents(db, account.id) : 0));
    /* M11：信用行优先给「本期应还 / 还款日」，余额信息不埋进编辑页 */
    var parts = ['本期应还 ' + fmt(used)];
    if (Number(account.dueDay) >= 1 && Number(account.dueDay) <= 28) {
      parts.push('每月 ' + Number(account.dueDay) + ' 日还款');
    }
    if (credit && credit.hasLimit) {
      parts.push('可用 ' + fmt(credit.availableCents));
    }
    return parts.join(' · ');
  }

  function archivedSection(ctx, db, accounts, balances) {
    var wrap = h('section', { className: 's-accounts-group s-accounts-group--archived' });
    var head = h('div', { className: 's-accounts-group__head' });
    head.appendChild(t('h2', 's-accounts-group__title', '已归档'));
    head.appendChild(t('span', 's-accounts-group__count', accounts.length + ' 个'));
    wrap.appendChild(head);

    var list = h('div', { className: 'c-list s-accounts-list' });
    for (var i = 0; i < accounts.length; i += 1) {
      list.appendChild(archivedRow(ctx, db, accounts[i], balances));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function archivedRow(ctx, db, account, balances) {
    var stats = statsApi();
    var cents = stats && typeof stats.accountBalanceCents === 'function'
      ? stats.accountBalanceCents(db, account.id) : 0;
    var row = h('div', { className: 'c-row c-row--icon c-row--two-line s-accounts-row--archived' });

    var avatar = h('span', { className: avatarClass(toneOf(account), 's-accounts-avatar--muted') });
    avatar.appendChild(iconEl(account.icon || TYPE_ICON[account.type] || 'wallet', 20, 's-accounts-glyph'));
    row.appendChild(avatar);

    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title', account.name));
    main.appendChild(t('span', 'c-row__sub', (TYPE_LABEL[account.type] || '账户') + ' · 已归档'));
    row.appendChild(main);

    row.appendChild(t('span', 'c-row__value', fmt(cents)));

    var restoreBtn = h('button', {
      className: 'c-btn c-btn--text s-accounts-restore',
      type: 'button',
      text: '恢复'
    });
    dom.on(restoreBtn, 'click', function (event) {
      event.stopPropagation();
      restoreAccount(ctx, account);
    });
    var trail = h('span', { className: 'c-row__trail' });
    trail.appendChild(restoreBtn);
    row.appendChild(trail);
    return row;
  }

  function emptyState(title, desc, onAction, actionLabel) {
    var box = h('div', { className: 'c-empty s-accounts-empty' });
    box.appendChild(h('div', { className: 'c-empty__icon' }, kids([iconEl('wallet', 32, 's-accounts-glyph')])));
    box.appendChild(t('p', 'c-empty__title', title));
    box.appendChild(t('p', 'c-empty__desc', desc));
    if (onAction) {
      var btn = h('button', {
        className: 'c-btn c-btn--primary c-btn--block c-empty__action',
        type: 'button',
        text: actionLabel || '新建账户'
      });
      dom.on(btn, 'click', onAction);
      box.appendChild(btn);
    }
    return box;
  }

  /* ---------------- 详情视图 ---------------- */

  var detailState = { acId: null, limit: PAGE_SIZE, offScroll: null };

  function renderDetail(root, ctx, db, accountId) {
    var account = findById(db.accounts || [], accountId);
    if (!account) {
      ctx.setTitle('账户');
      root.appendChild(emptyState('账户不存在', '它可能已经被删除了', null));
      return;
    }

    if (detailState.acId !== accountId) {
      detailState.acId = accountId;
      detailState.limit = PAGE_SIZE;
    }
    if (detailState.limit < PAGE_SIZE) { detailState.limit = PAGE_SIZE; }

    ctx.setTitle(account.name);

    var stats = statsApi();
    var cents = stats && typeof stats.accountBalanceCents === 'function'
      ? stats.accountBalanceCents(db, accountId) : 0;
    var credit = stats && typeof stats.creditAvailable === 'function'
      ? stats.creditAvailable(db, accountId) : null;

    root.appendChild(detailHead(ctx, db, account, cents, credit));
    root.appendChild(detailActions(ctx, db, account));

    var all = accountTxns(db, accountId);
    if (!all.length) {
      root.appendChild(emptyState('这个账户还没有流水', '去记一笔，或者做一次转账', function () {
        ctx.go('#/add');
      }, '去记一笔'));
      return;
    }

    var shown = all.slice(0, detailState.limit);
    var section = h('section', { className: 's-accounts-group' });
    var head = h('div', { className: 's-accounts-group__head' });
    head.appendChild(t('h2', 's-accounts-group__title', '流水'));
    head.appendChild(t('span', 's-accounts-group__count', all.length + ' 笔'));
    section.appendChild(head);

    var list = h('div', { className: 'c-list s-accounts-txns' });
    var running = cents;
    for (var i = 0; i < shown.length; i += 1) {
      var tx = shown[i];
      var delta = deltaFor(tx, accountId);
      var after = running;
      running -= delta;
      list.appendChild(txnRow(ctx, db, tx, delta, after));
    }
    section.appendChild(list);
    root.appendChild(section);

    if (all.length > shown.length) {
      var moreBtn = h('button', {
        className: 'c-btn c-btn--secondary c-btn--block s-accounts-more',
        type: 'button',
        text: '加载更多（还有 ' + (all.length - shown.length) + ' 笔）'
      });
      dom.on(moreBtn, 'click', function () {
        detailState.limit += PAGE_SIZE;
        ctx.refresh();
      });
      root.appendChild(moreBtn);
    }

    root.appendChild(totalBar(all, accountId));
    bindBottomLoad(root, ctx, all.length);
  }

  function bindBottomLoad(root, ctx, total) {
    if (detailState.offScroll) {
      try { detailState.offScroll(); } catch (error) { /* 忽略 */ }
      detailState.offScroll = null;
    }
    var scroller = root && root.parentNode;
    if (!scroller || total <= detailState.limit) { return; }
    detailState.offScroll = dom.on(scroller, 'scroll', function () {
      if (detailState.limit >= total) { return; }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 160) {
        detailState.limit += PAGE_SIZE;
        ctx.refresh();
      }
    }, { passive: true });
  }

  function detailHead(ctx, db, account, cents, credit) {
    var card = h('div', { className: 'c-card s-accounts-detail' });
    var top = h('div', { className: 's-accounts-detail__top' });
    var avatar = h('span', { className: avatarClass(toneOf(account), 's-accounts-avatar--lg') });
    avatar.appendChild(iconEl(account.icon || TYPE_ICON[account.type] || 'wallet', 24, 's-accounts-glyph'));
    top.appendChild(avatar);

    var head = h('div', { className: 's-accounts-detail__head' });
    head.appendChild(t('h1', 's-accounts-detail__name', account.name));
    head.appendChild(t('p', 's-accounts-detail__type',
      (TYPE_LABEL[account.type] || '账户') + (account.archived === true ? ' · 已归档' : '')));
    top.appendChild(head);
    card.appendChild(top);

    if (account.type === 'credit') {
      var debt = cents < 0 ? -cents : 0;
      card.appendChild(t('p', 's-accounts-detail__balance s-accounts-detail__balance--debt u-tabular', fmt(debt)));
      card.appendChild(t('p', 's-accounts-detail__balance-label', '欠款'));
      var meta = h('div', { className: 's-accounts-detail__meta' });
      meta.appendChild(metaItem('可用额度',
        credit && credit.hasLimit ? fmt(credit.availableCents) : '未设额度'));
      meta.appendChild(metaItem('额度',
        credit && credit.hasLimit ? fmt(credit.limitCents) : '未设额度'));
      if (account.billDay) { meta.appendChild(metaItem('账单日', '每月 ' + account.billDay + ' 日')); }
      card.appendChild(meta);
    } else {
      card.appendChild(t('p', 's-accounts-detail__balance u-tabular', fmt(cents)));
      card.appendChild(t('p', 's-accounts-detail__balance-label', '当前余额'));
      var metaCash = h('div', { className: 's-accounts-detail__meta' });
      metaCash.appendChild(metaItem('初始余额', fmt(account.openingBalanceCents || 0)));
      metaCash.appendChild(metaItem('类型', TYPE_LABEL[account.type] || '账户'));
      card.appendChild(metaCash);
    }

    if (account.note) {
      card.appendChild(t('p', 's-accounts-detail__note', account.note));
    }
    return card;
  }

  function metaItem(label, value) {
    var item = h('span', { className: 's-accounts-meta-item' });
    item.appendChild(t('span', 's-accounts-meta-item__label', label));
    item.appendChild(t('span', 's-accounts-meta-item__value', value));
    return item;
  }

  function detailActions(ctx, db, account) {
    var bar = h('div', { className: 's-accounts-actions' });
    var isCredit = account.type === 'credit';
    var archived = account.archived === true;

    bar.appendChild(actionButton('transfer', '转账', function () {
      openTransferSheet(ctx, { fromId: archived ? '' : account.id });
    }));

    if (isCredit && !archived) {
      bar.appendChild(actionButton('credit', '还款', function () {
        openTransferSheet(ctx, { toId: account.id, repay: true });
      }));
    } else if (!archived) {
      bar.appendChild(actionButton('arrow-right', '转入', function () {
        openTransferSheet(ctx, { toId: account.id });
      }));
    } else {
      bar.appendChild(actionButton('undo', '恢复', function () {
        restoreAccount(ctx, account);
      }));
    }

    bar.appendChild(actionButton('edit', '编辑', function () {
      openAccountForm(ctx, account);
    }));

    if (archived) {
      bar.appendChild(actionButton('lock', '已归档', function () {
        toast(ctx, '这个账户已归档，可点「恢复」重新启用', { type: 'info' });
      }));
    } else {
      bar.appendChild(actionButton('lock', '归档', function () {
        archiveAccount(ctx, db, account);
      }));
    }
    return bar;
  }

  function actionButton(iconName, label, onClick) {
    var btn = h('button', { className: 'c-btn c-btn--light s-accounts-action', type: 'button' }, kids([
      iconEl(iconName, 20, 's-accounts-action__icon'),
      t('span', 's-accounts-action__label', label)
    ]));
    dom.on(btn, 'click', onClick);
    return btn;
  }

  function txnRow(ctx, db, tx, delta, after) {
    var row = h('div', { className: 'c-row c-row--icon c-row--two-line s-accounts-txn' });
    var avatar = h('span', { className: 'c-row__icon s-accounts-txn__icon' });
    avatar.appendChild(iconEl(txIcon(db, tx), 18, 's-accounts-glyph'));
    row.appendChild(avatar);

    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title', txTitle(db, tx)));
    main.appendChild(t('span', 'c-row__sub',
      tx.date + (tx.time ? ' ' + tx.time : '') + ' · 余额 ' + fmt(after)));
    row.appendChild(main);

    var amountText = (delta > 0 ? '+' : '') + fmt(delta);
    var cls = 'c-row__value';
    if (delta > 0) { cls += ' c-row__value--income'; }
    else if (delta < 0) { cls += ' c-row__value--expense'; }
    row.appendChild(t('span', cls, amountText));
    return row;
  }

  function totalBar(all, accountId) {
    var income = 0;
    var expense = 0;
    var net = 0;
    for (var i = 0; i < all.length; i += 1) {
      var delta = deltaFor(all[i], accountId);
      net += delta;
      if (all[i].type === 'income' && all[i].accountId === accountId) { income += all[i].amountCents; }
      if (all[i].type === 'expense' && all[i].accountId === accountId) { expense += all[i].amountCents; }
    }
    var bar = h('div', { className: 's-accounts-totalbar' });
    bar.appendChild(totalItem('收入', fmt(income)));
    bar.appendChild(totalItem('支出', fmt(expense)));
    bar.appendChild(totalItem('净变化', (net > 0 ? '+' : '') + fmt(net)));
    return bar;
  }

  function totalItem(label, value) {
    var item = h('span', { className: 's-accounts-totalbar__item' });
    item.appendChild(t('span', 's-accounts-totalbar__label', label));
    item.appendChild(t('span', 's-accounts-totalbar__value u-tabular', value));
    return item;
  }

  /* ---------------- 转账 / 还款 ---------------- */

  function openTransferSheet(ctx, options) {
    var opts = options || {};
    var db = XZB.app && typeof XZB.app.db === 'function' ? XZB.app.db() : ctx.db;
    var accounts = aliveAccounts(db);
    if (accounts.length < 2) {
      toast(ctx, '至少需要两个账户才能转账', { type: 'warning' });
      return;
    }

    var state = {
      fromId: opts.fromId || '',
      toId: opts.toId || '',
      error: ''
    };
    if (!state.fromId) {
      var preferred = ctx.prefs && typeof ctx.prefs.get === 'function' ? ctx.prefs.get('lastAccountId', '') : '';
      state.fromId = findById(accounts, preferred) ? preferred : accounts[0].id;
    }
    if (!state.toId) {
      for (var i = 0; i < accounts.length; i += 1) {
        if (accounts[i].id !== state.fromId) { state.toId = accounts[i].id; break; }
      }
    }
    if (state.fromId === state.toId) {
      for (var j = 0; j < accounts.length; j += 1) {
        if (accounts[j].id !== state.fromId) { state.toId = accounts[j].id; break; }
      }
    }
    if (opts.repay && opts.toId) { state.toId = opts.toId; }

    var body = h('div', { className: 's-accounts-form' });
    var errorBox = t('p', 's-accounts-error', '');
    errorBox.hidden = true;
    body.appendChild(errorBox);

    var fromPicker = pickerBlock(ctx, body, accounts, state, 'from');
    var toPicker = pickerBlock(ctx, body, accounts, state, 'to');

    var amountField = field('金额', inputNode({
      type: 'text',
      inputmode: 'decimal',
      className: 'c-field__input s-accounts-amount',
      placeholder: '0.00'
    }), '¥');

    var dateField = field('日期', inputNode({
      type: 'date',
      className: 'c-field__input',
      value: todayStr()
    }), '');

    var noteField = field('备注', inputNode({
      type: 'text',
      className: 'c-field__input',
      placeholder: '可选',
      maxlength: String(MAX_TX_NOTE)
    }), '');

    body.appendChild(amountField.wrap);
    body.appendChild(dateField.wrap);
    body.appendChild(noteField.wrap);

    var summary = t('p', 's-accounts-summary', '');
    body.appendChild(summary);

    var submit = h('button', {
      className: 'c-btn c-btn--primary c-btn--block s-accounts-submit',
      type: 'button'
    });
    body.appendChild(submit);

    function toAccount() { return findById(accounts, state.toId); }
    function isRepay() {
      var to = toAccount();
      return !!(to && to.type === 'credit');
    }

    function refreshLabels() {
      var from = findById(accounts, state.fromId);
      var to = toAccount();
      var repay = isRepay();
      summary.textContent = (from ? from.name : '—') + (repay ? ' 还款到 ' : ' → ') + (to ? to.name : '—');
      submit.textContent = repay ? '确认还款' : '确认转账';
      if (handle && handle.element) {
        var titleEl = handle.element.querySelector('.c-sheet__title');
        if (titleEl) { titleEl.textContent = repay ? '还款' : '转账'; }
      }
      updatePickerStates(body, state);
    }

    fromPicker.onChange = refreshLabels;
    toPicker.onChange = refreshLabels;

    var handle = XZB.ui.sheet.open({
      title: '转账',
      content: body,
      actions: [{ label: '取消', kind: 'text' }],
      onClose: function () { /* 关闭后不再处理 */ }
    });

    dom.on(submit, 'click', function () {
      errorBox.hidden = true;
      var amount = parseCents(amountField.input.value, false);
      if (!amount.ok) {
        showError(amount.code);
        return;
      }
      if (amount.cents <= 0) {
        showError('E_AMOUNT_EMPTY');
        return;
      }
      var dateValue = String(dateField.input.value || '').trim();
      if (!isValidDate(dateValue)) {
        showError('E_DATE');
        return;
      }
      if (state.fromId === state.toId) {
        showError('E_TRANSFER_SAME');
        return;
      }
      submit.disabled = true;
      submitBurn(ctx, {
        fromId: state.fromId,
        toId: state.toId,
        amountCents: amount.cents,
        date: dateValue,
        note: String(noteField.input.value || '').trim()
      }, function (ok, result) {
        submit.disabled = false;
        if (ok) {
          if (handle && typeof handle.close === 'function') { handle.close(); }
          return;
        }
        showError(result.code || 'E_COMMIT', result.message);
      });
    });

    refreshLabels();

    function showError(code, message) {
      var text = message || ACCOUNT_MSG[code] || AMOUNT_MSG[code] || '';
      if (code === 'E_DATE') { text = '日期不对，请重新选择'; }
      if (!text) { text = '这笔操作没能完成，请稍后再试'; }
      errorBox.textContent = text;
      errorBox.hidden = false;
      toast(ctx, text, { type: 'danger' });
    }
  }

  function pickerBlock(ctx, body, accounts, state, side) {
    var block = h('div', { className: 's-accounts-picker' });
    block.dataset.side = side;
    var label = t('span', 's-accounts-picker__label', side === 'from' ? '转出账户' : '转入账户');
    block.appendChild(label);
    var row = h('div', { className: 's-accounts-chips' });
    block.appendChild(row);

    var api = { onChange: null };

    for (var i = 0; i < accounts.length; i += 1) {
      (function (account) {
        var chip = h('button', {
          className: 's-accounts-chip',
          type: 'button',
          dataset: { accountId: account.id },
          'aria-pressed': 'false'
        }, kids([
          h('span', { className: 's-accounts-chip__dot s-accounts-chip__dot--' + toneOf(account) }),
          t('span', 's-accounts-chip__name', account.name)
        ]));
        dom.on(chip, 'click', function () {
          if (side === 'from') { state.fromId = account.id; }
          else { state.toId = account.id; }
          if (state.fromId === state.toId) {
            toast(ctx, '不能转给同一个账户', { type: 'warning' });
          }
          if (typeof api.onChange === 'function') { api.onChange(); }
        });
        row.appendChild(chip);
      }(accounts[i]));
    }

    body.appendChild(block);
    return api;
  }

  function updatePickerStates(body, state) {
    var blocks = body.querySelectorAll('.s-accounts-picker');
    for (var i = 0; i < blocks.length; i += 1) {
      var side = blocks[i].getAttribute('data-side');
      var chips = blocks[i].querySelectorAll('.s-accounts-chip');
      for (var j = 0; j < chips.length; j += 1) {
        var id = chips[j].getAttribute('data-account-id');
        var active = side === 'from' ? state.fromId === id : state.toId === id;
        chips[j].setAttribute('aria-pressed', active ? 'true' : 'false');
        if (active) { chips[j].classList.add('is-active'); }
        else { chips[j].classList.remove('is-active'); }
      }
    }
  }

  function submitBurn(ctx, payload, done) {
    var schema = schemaApi();
    var bookId = ctx.state && ctx.state.ui ? ctx.state.ui.activeBookId : null;
    if (!schema || typeof schema.createTransaction !== 'function') {
      done(false, { code: 'E_COMMIT', message: '数据模块没准备好' });
      return;
    }
    ctx.commit(function (working) {
      var book = findById(working.books || [], bookId);
      if (!book || book.archived === true) {
        var fallback = null;
        for (var i = 0; i < (working.books || []).length; i += 1) {
          if (working.books[i] && working.books[i].archived !== true) { fallback = working.books[i]; break; }
        }
        if (!fallback) {
          return { abort: true, code: 'E_BOOK_MISSING', message: '没有可用的账本' };
        }
        bookId = fallback.id;
      }
      if (payload.fromId === payload.toId) {
        return { abort: true, code: 'E_TRANSFER_SAME', message: ACCOUNT_MSG.E_TRANSFER_SAME };
      }
      var tx = schema.createTransaction({
        bookId: bookId,
        type: 'transfer',
        amountCents: payload.amountCents,
        accountId: payload.fromId,
        toAccountId: payload.toId,
        date: payload.date,
        time: nowTime(),
        note: payload.note,
        source: 'manual'
      });
      var checked = schema.validateTransaction(tx, {
        books: working.books,
        accounts: working.accounts,
        categories: working.categories,
        today: todayStr()
      });
      if (!checked || checked.ok !== true) {
        var first = checked && checked.errors && checked.errors[0];
        var code = first && first.code ? first.code : 'E_INVALID_INPUT';
        return { abort: true, code: code, message: ACCOUNT_MSG[code] || '' };
      }
      working.transactions.push(tx);
      return { value: { id: tx.id } };
    }, { label: '转账' }).then(function (result) {
      if (result && result.ok) {
        toast(ctx, '转账成功', { type: 'success' });
        done(true, result);
        return;
      }
      done(false, result || { code: 'E_COMMIT' });
    }, function (error) {
      done(false, { code: 'E_COMMIT', message: error && error.message });
    });
  }

  /* ---------------- 表单：新建 / 编辑 ---------------- */

  function inputNode(attrs) {
    var node = h('input', attrs);
    node.setAttribute('autocapitalize', 'off');
    node.setAttribute('autocorrect', 'off');
    node.setAttribute('spellcheck', 'false');
    return node;
  }

  function field(label, input, unit) {
    var wrap = h('div', { className: 'c-field s-accounts-field' });
    wrap.appendChild(t('label', 'c-field__label', label));
    var control = h('div', { className: 'c-field__control' });
    if (unit) { control.appendChild(t('span', 'c-field__unit', unit)); }
    control.appendChild(input);
    wrap.appendChild(control);
    return { wrap: wrap, input: input, control: control };
  }

  function openAccountForm(ctx, account) {
    var editing = !!account;
    var db = XZB.app && typeof XZB.app.db === 'function' ? XZB.app.db() : ctx.db;
    var state = {
      type: account ? account.type : 'cash',
      icon: account ? account.icon : TYPE_ICON.cash,
      color: account ? account.color : '',
      iconTouched: editing
    };

    var body = h('div', { className: 's-accounts-form' });
    var errorBox = t('p', 's-accounts-error', '');
    errorBox.hidden = true;
    body.appendChild(errorBox);

    var nameField = field('名称', inputNode({
      type: 'text',
      className: 'c-field__input',
      placeholder: '例如 招商银行',
      maxlength: String(MAX_ACCOUNT_NAME),
      value: account ? account.name : ''
    }), '');

    var typeBlock = h('div', { className: 's-accounts-block' });
    typeBlock.appendChild(t('span', 's-accounts-block__label', '类型'));
    var typeGrid = h('div', { className: 's-accounts-typegrid' });
    for (var i = 0; i < TYPE_ORDER.length; i += 1) {
      typeGrid.appendChild(typeCell(TYPE_ORDER[i]));
    }
    typeBlock.appendChild(typeGrid);

    var balanceField = field('初始余额', inputNode({
      type: 'text',
      inputmode: 'decimal',
      className: 'c-field__input',
      placeholder: '0.00',
      value: centsToInput(account ? account.openingBalanceCents : 0)
    }), '¥');

    var creditBlock = h('div', { className: 's-accounts-block s-accounts-credit' });
    var limitField = field('额度', inputNode({
      type: 'text',
      inputmode: 'decimal',
      className: 'c-field__input',
      placeholder: '0.00',
      value: account && account.limitCents ? centsToInput(account.limitCents) : ''
    }), '¥');
    var billField = field('账单日', inputNode({
      type: 'number',
      inputmode: 'numeric',
      min: '1',
      max: '28',
      className: 'c-field__input',
      placeholder: '1–28',
      value: account && account.billDay ? String(account.billDay) : ''
    }), '日');
    creditBlock.appendChild(limitField.wrap);
    creditBlock.appendChild(billField.wrap);

    var iconBlock = h('div', { className: 's-accounts-block' });
    iconBlock.appendChild(t('span', 's-accounts-block__label', '图标'));
    var iconGrid = h('div', { className: 's-accounts-icon-grid' });
    iconBlock.appendChild(iconGrid);

    var colorBlock = h('div', { className: 's-accounts-block' });
    colorBlock.appendChild(t('span', 's-accounts-block__label', '颜色'));
    var colorRow = h('div', { className: 's-accounts-colors' });
    colorBlock.appendChild(colorRow);

    var noteField = field('备注', inputNode({
      type: 'text',
      className: 'c-field__input',
      placeholder: '可选',
      maxlength: String(MAX_ACCOUNT_NOTE),
      value: account && account.note ? account.note : ''
    }), '');

    body.appendChild(nameField.wrap);
    body.appendChild(typeBlock);
    body.appendChild(balanceField.wrap);
    body.appendChild(creditBlock);
    body.appendChild(iconBlock);
    body.appendChild(colorBlock);
    body.appendChild(noteField.wrap);

    var submit = h('button', {
      className: 'c-btn c-btn--primary c-btn--block s-accounts-submit',
      type: 'button',
      text: editing ? '保存' : '新建账户'
    });
    body.appendChild(submit);

    if (editing && account.archived !== true) {
      var usedCount = accountTxns(db, account.id).length;
      if (usedCount === 0) {
        var deleteBtn = h('button', {
          className: 'c-btn c-btn--text s-accounts-danger',
          type: 'button',
          text: '删除账户（无流水）'
        });
        dom.on(deleteBtn, 'click', function () {
          if (handle && typeof handle.close === 'function') { handle.close(); }
          confirmSheet(ctx, {
            title: '删除账户',
            message: '「' + account.name + '」还没有任何流水，删除后不可恢复。确定删除？',
            confirmLabel: '删除',
            danger: true,
            onConfirm: function (close) {
              deleteAccount(ctx, account, close);
            }
          });
        });
        body.appendChild(deleteBtn);
      } else {
        body.appendChild(t('p', 's-accounts-hint',
          '这个账户有 ' + usedCount + ' 笔流水，只能归档，不能删除。'));
      }

      var archiveBtn = h('button', {
        className: 'c-btn c-btn--text s-accounts-danger',
        type: 'button',
        text: '归档这个账户'
      });
      dom.on(archiveBtn, 'click', function () {
        if (handle && typeof handle.close === 'function') { handle.close(); }
        archiveAccount(ctx, db, account);
      });
      body.appendChild(archiveBtn);
    }

    var handle = XZB.ui.sheet.open({
      title: editing ? '编辑账户' : '新建账户',
      content: body,
      actions: [{ label: '取消', kind: 'text' }]
    });

    function typeCell(type) {
      var cell = h('button', {
        className: 's-accounts-type',
        type: 'button',
        dataset: { type: type },
        'aria-pressed': 'false'
      }, kids([
        h('span', { className: 's-accounts-type__icon s-accounts-type__icon--' + (TYPE_TONE[type] || 'cash') },
          kids([iconEl(TYPE_ICON[type] || 'wallet', 20, 's-accounts-glyph')])),
        t('span', 's-accounts-type__label', TYPE_LABEL[type] || type)
      ]));
      dom.on(cell, 'click', function () {
        state.type = type;
        if (!state.iconTouched) {
          state.icon = TYPE_ICON[type] || 'wallet';
          renderIcons();
        }
        renderTypes();
        syncCreditBlock();
      });
      return cell;
    }

    function renderTypes() {
      var cells = typeGrid.querySelectorAll('.s-accounts-type');
      for (var k = 0; k < cells.length; k += 1) {
        var value = cells[k].getAttribute('data-type');
        var on = value === state.type;
        cells[k].setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) { cells[k].classList.add('is-active'); }
        else { cells[k].classList.remove('is-active'); }
      }
    }

    function renderIcons() {
      dom.clear(iconGrid);
      for (var k = 0; k < ICON_CHOICES.length; k += 1) {
        (function (iconName) {
          var cell = h('button', {
            className: 's-accounts-icon-cell',
            type: 'button',
            dataset: { icon: iconName },
            'aria-label': '图标 ' + iconName,
            'aria-pressed': iconName === state.icon ? 'true' : 'false'
          }, kids([iconEl(iconName, 22, 's-accounts-glyph')]));
          dom.on(cell, 'click', function () {
            state.icon = iconName;
            state.iconTouched = true;
            renderIcons();
          });
          iconGrid.appendChild(cell);
        }(ICON_CHOICES[k]));
      }
    }

    function renderColors() {
      dom.clear(colorRow);
      for (var k = 0; k < TONES.length; k += 1) {
        (function (tone) {
          var cell = h('button', {
            className: 's-accounts-color s-accounts-color--' + tone.key,
            type: 'button',
            'aria-label': tone.label,
            'aria-pressed': 'false',
            dataset: { tone: tone.key }
          });
          dom.on(cell, 'click', function () {
            var hex = cssVar(tone.varName);
            if (hex) { state.color = hex; }
            renderColors();
          });
          colorRow.appendChild(cell);
        }(TONES[k]));
      }
      var current = String(state.color || '').toUpperCase();
      var cells = colorRow.querySelectorAll('.s-accounts-color');
      for (var m = 0; m < cells.length; m += 1) {
        var key = cells[m].getAttribute('data-tone');
        var varName = '';
        for (var n = 0; n < TONES.length; n += 1) {
          if (TONES[n].key === key) { varName = TONES[n].varName; }
        }
        var on = varName && cssVar(varName).toUpperCase() === current;
        cells[m].setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) { cells[m].classList.add('is-active'); }
        else { cells[m].classList.remove('is-active'); }
      }
    }

    function syncCreditBlock() {
      creditBlock.hidden = state.type !== 'credit';
    }

    renderTypes();
    renderIcons();
    renderColors();
    syncCreditBlock();

    function fail(code, message) {
      var text = message || ACCOUNT_MSG[code] || AMOUNT_MSG[code] || '';
      if (!text) { text = '没能保存，请稍后再试'; }
      errorBox.textContent = text;
      errorBox.hidden = false;
      toast(ctx, text, { type: 'danger' });
    }

    dom.on(submit, 'click', function () {
      errorBox.hidden = true;
      var schema = schemaApi();
      if (!schema) {
        fail('E_COMMIT', '数据模块没准备好');
        return;
      }
      var name = String(nameField.input.value || '').trim();
      if (!name) {
        fail('E_NAME', '请填写账户名称');
        return;
      }
      if (name.length > MAX_ACCOUNT_NAME) {
        fail('E_NAME', '名称最多 ' + MAX_ACCOUNT_NAME + ' 个字');
        return;
      }
      var balance = { ok: true, cents: 0 };
      if (String(balanceField.input.value || '').trim() !== '') {
        balance = parseCents(balanceField.input.value, true);
        if (!balance.ok) {
          fail(balance.code);
          return;
        }
      }
      var limitCents = 0;
      if (state.type === 'credit' && String(limitField.input.value || '').trim() !== '') {
        var limit = parseCents(limitField.input.value, false);
        if (!limit.ok) {
          fail(limit.code);
          return;
        }
        limitCents = limit.cents;
      }
      var billDay = null;
      if (state.type === 'credit' && String(billField.input.value || '').trim() !== '') {
        var billNumber = Number(billField.input.value);
        if (!isFinite(billNumber) || Math.floor(billNumber) !== billNumber || billNumber < 1 || billNumber > 28) {
          fail('E_ACCOUNT_BILLDAY', '账单日必须是 1–28');
          return;
        }
        billDay = billNumber;
      }
      var color = state.color || cssVar('--acc-' + (TYPE_TONE[state.type] || 'cash'));
      var note = String(noteField.input.value || '').trim();

      var payload = {
        name: name,
        type: state.type,
        icon: state.icon || TYPE_ICON[state.type],
        color: color,
        openingBalanceCents: balance.cents,
        limitCents: limitCents,
        billDay: billDay,
        dueDay: billDay,
        note: note
      };

      submit.disabled = true;
      saveAccount(ctx, editing ? account : null, payload, function (ok, result) {
        submit.disabled = false;
        if (ok) {
          if (handle && typeof handle.close === 'function') { handle.close(); }
          toast(ctx, editing ? '账户已保存' : '账户已创建', { type: 'success' });
          return;
        }
        fail(result.code || 'E_COMMIT', result.message);
      });
    });
  }

  function centsToInput(cents) {
    var n = typeof cents === 'number' && isFinite(cents) ? cents : 0;
    var negative = n < 0;
    var abs = Math.abs(n);
    var yuan = Math.floor(abs / 100);
    var fen = abs % 100;
    var text = String(yuan) + '.' + (fen < 10 ? '0' + fen : String(fen));
    return negative ? '-' + text : text;
  }

  /* ---------------- 写库 ---------------- */

  function saveAccount(ctx, account, payload, done) {
    var schema = schemaApi();
    ctx.commit(function (working) {
      var list = working.accounts || (working.accounts = []);
      var target = account ? findById(list, account.id) : null;
      if (account && !target) {
        return { abort: true, code: 'E_ACCOUNT_MISSING', message: ACCOUNT_MSG.E_ACCOUNT_MISSING };
      }
      var next;
      if (target) {
        next = {
          id: target.id,
          name: payload.name,
          type: payload.type,
          icon: payload.icon,
          color: payload.color,
          openingBalanceCents: payload.openingBalanceCents,
          limitCents: payload.limitCents,
          billDay: payload.billDay,
          dueDay: payload.dueDay,
          archived: target.archived === true,
          sort: typeof target.sort === 'number' ? target.sort : 10,
          note: payload.note,
          createdAt: target.createdAt,
          updatedAt: nowIso()
        };
      } else {
        next = schema.createAccount(payload);
        next.sort = nextSort(list);
      }
      var checked = schema.validateAccount(next);
      if (!checked || checked.ok !== true) {
        var first = checked && checked.errors && checked.errors[0];
        var code = first && first.code ? first.code : 'E_INVALID_INPUT';
        return { abort: true, code: code, message: ACCOUNT_MSG[code] || '' };
      }
      if (target) {
        for (var key in next) {
          if (Object.prototype.hasOwnProperty.call(next, key)) { target[key] = next[key]; }
        }
      } else {
        list.push(next);
      }
      return { value: { id: next.id } };
    }, { label: account ? '编辑账户' : '新建账户' }).then(function (result) {
      done(!!(result && result.ok), result || { code: 'E_COMMIT' });
    }, function (error) {
      done(false, { code: 'E_COMMIT', message: error && error.message });
    });
  }

  function nextSort(list) {
    var max = 0;
    for (var i = 0; i < list.length; i += 1) {
      var value = list[i] && typeof list[i].sort === 'number' ? list[i].sort : 10;
      if (value > max) { max = value; }
    }
    return max + 10;
  }

  function archiveAccount(ctx, db, account) {
    var count = accountTxns(db, account.id).length;
    var message = count > 0
      ? '「' + account.name + '」有 ' + count + ' 笔流水，归档后历史保留、仍可查看，可随时恢复。'
      : '归档后「' + account.name + '」不会出现在记账选择器里，可随时恢复。';
    confirmSheet(ctx, {
      title: '归档账户',
      message: message,
      confirmLabel: '归档',
      danger: true,
      onConfirm: function (close) {
        ctx.commit(function (working) {
          var target = findById(working.accounts || [], account.id);
          if (!target) {
            return { abort: true, code: 'E_ACCOUNT_MISSING', message: ACCOUNT_MSG.E_ACCOUNT_MISSING };
          }
          var others = [];
          for (var i = 0; i < (working.accounts || []).length; i += 1) {
            var acc = working.accounts[i];
            if (acc.id !== account.id && acc.archived !== true) { others.push(acc); }
          }
          if (!others.length) {
            return { abort: true, code: 'E_ACCOUNT_LAST', message: '至少要保留一个未归档账户' };
          }
          target.archived = true;
          target.updatedAt = nowIso();
          if (working.settings && working.settings.defaultAccountId === account.id) {
            working.settings.defaultAccountId = others[0].id;
          }
          return { value: { id: account.id } };
        }, { label: '归档账户' }).then(function (result) {
          if (result && result.ok) {
            toast(ctx, '账户已归档', { type: 'success' });
            close();
            return;
          }
          var code = result && result.code;
          toast(ctx, (result && result.message) || ACCOUNT_MSG[code] || '归档失败', { type: 'danger' });
          close();
        });
      }
    });
  }

  function restoreAccount(ctx, account) {
    ctx.commit(function (working) {
      var target = findById(working.accounts || [], account.id);
      if (!target) {
        return { abort: true, code: 'E_ACCOUNT_MISSING', message: ACCOUNT_MSG.E_ACCOUNT_MISSING };
      }
      target.archived = false;
      target.updatedAt = nowIso();
      return { value: { id: account.id } };
    }, { label: '恢复账户' }).then(function (result) {
      if (result && result.ok) {
        toast(ctx, '账户已恢复', { type: 'success' });
        return;
      }
      toast(ctx, (result && result.message) || '恢复失败', { type: 'danger' });
    });
  }

  function deleteAccount(ctx, account, close) {
    ctx.commit(function (working) {
      var list = working.accounts || [];
      var index = -1;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].id === account.id) { index = i; break; }
      }
      if (index < 0) {
        return { abort: true, code: 'E_ACCOUNT_MISSING', message: ACCOUNT_MSG.E_ACCOUNT_MISSING };
      }
      var used = false;
      for (var j = 0; j < (working.transactions || []).length; j += 1) {
        var tx = working.transactions[j];
        if (!tx || tx.deleted === true) { continue; }
        if (tx.accountId === account.id || tx.toAccountId === account.id) { used = true; break; }
      }
      if (used) {
        return { abort: true, code: 'E_ACCOUNT_IN_USE', message: '这个账户有流水，只能归档' };
      }
      if (list.length <= 1) {
        return { abort: true, code: 'E_ACCOUNT_LAST', message: '至少要保留一个账户' };
      }
      list.splice(index, 1);
      if (working.settings && working.settings.defaultAccountId === account.id) {
        var replacement = '';
        for (var k = 0; k < list.length; k += 1) {
          if (list[k].archived !== true) { replacement = list[k].id; break; }
        }
        if (!replacement && list[0]) { replacement = list[0].id; }
        if (replacement) { working.settings.defaultAccountId = replacement; }
      }
      return { value: { id: account.id } };
    }, { label: '删除账户' }).then(function (result) {
      if (result && result.ok) {
        toast(ctx, '账户已删除', { type: 'success' });
        if (typeof close === 'function') { close(); }
        ctx.go('#/accounts');
        return;
      }
      toast(ctx, (result && result.message) || '删除失败', { type: 'danger' });
      if (typeof close === 'function') { close(); }
    });
  }

  /* ---------------- 确认浮层 ---------------- */

  function confirmSheet(ctx, options) {
    var opts = options || {};
    var body = h('div', { className: 's-accounts-confirm' });
    body.appendChild(t('p', 's-accounts-confirm__text', opts.message || ''));

    var handle = XZB.ui.sheet.open({
      title: opts.title || '确认',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: opts.confirmLabel || '确定',
          kind: opts.danger ? 'danger' : 'primary',
          onClick: function () {
            var closed = false;
            if (typeof opts.onConfirm === 'function') {
              opts.onConfirm(function () {
                if (closed) { return; }
                closed = true;
                if (handle && typeof handle.close === 'function') { handle.close(); }
              });
            }
            return false;
          }
        }
      ]
    });
  }

  /* ---------------- 注册 ---------------- */

  XZB.screens.register(KEY, {
    title: '账户',
    subtitle: '资金与信用账户',
    render: render
  });
}(window));
