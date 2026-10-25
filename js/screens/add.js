/* 小账本 2.0 · js/screens/add.js · owner: 前端#1（T11 记一笔）
 * 契约锚点：UI.md §6.4（:945-1001 线框与逐项规格）、SPEC A4/A5/A6/A7/A10/A12/A14/A15、
 *           INTERFACE-FREEZE §3（类名归属）§8（十二条红线）、DECISIONS D06/D08/D14/D16。
 *
 * 形状：路由二级页 #/add[?id=<txId>]；root 已是 .app-screen__body.s-add（已清空）。
 * 能力：
 *   1. 三态分段 支出/收入/转账（编辑模式锁定，改类型走 E_TX_TYPE 文案）。
 *   2. 金额区点击唤起 XZB.ui.keypad（复用组件：删/小数点/长按连删/完成全由组件负责），
 *      键盘固定底部 bottom:var(--kb)，页面高度用 --vvh 计算，键盘收起回落。
 *   3. 一句话：XZB.core.nl.parse → 最多 3 个候选 chip，点选回填；全对提示「已识别」，
 *      识别不了给「没听懂金额，手动填一下吧」。
 *   4. 分类宫格 4 列（按 type 过滤、12 色槽 data-tone），长按或末尾「管理」跳 #/settings。
 *   5. 账户横向 chip（默认上次账户，存 prefs.lastAccountId）；转账变「转出 → 转入」两行，
 *      选同一个给 store.MESSAGES.E_TRANSFER_SAME 中文。
 *   6. 日期：今天/昨天/前天 chip + 自绘月历浮层（不引日历库）。
 *   7. 备注 ≤80 字（LIMITS.txNote）；标签 ≤5 个、每个 ≤10 字（LIMITS.tags/tagLen），退格删。
 *   8. 保存：schema.createTransaction → schema.validateTransaction → XZB.app.commit，
 *      成功 toast「已记一笔」并 back()；?id= 为编辑模式（预填、标题「编辑」、删除按钮）。
 *
 * 硬约束：持久化只经 XZB.app.commit 与 XZB.app.prefs（屏幕层不自行落库）；不写 innerHTML
 * 拼用户数据（一律 textContent）；金额只用整数分；日期只用本地字符串。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB = global.XZB || {};

  /* ---------------- 常量 ---------------- */
  var TYPES = [
    { key: 'expense', label: '支出' },
    { key: 'income', label: '收入' },
    { key: 'transfer', label: '转账' }
  ];
  var TYPE_KEYS = ['expense', 'income', 'transfer'];
  var NOTE_MAX = 80;          /* schema.LIMITS.txNote 的兜底值 */
  var TAG_MAX = 5;            /* schema.LIMITS.tags */
  var TAG_LEN = 10;           /* schema.LIMITS.tagLen */
  var RECENT_MAX = 6;
  var WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
  var CAT_ICON = {
    ca_food: 'food', ca_transport: 'bus', ca_shopping: 'bag', ca_home: 'house',
    ca_fun: 'fun', ca_health: 'health', ca_study: 'book', ca_comm: 'phone',
    ca_social: 'gift', ca_other_expense: 'dots', ca_salary: 'salary',
    ca_bonus: 'bonus', ca_invest: 'invest', ca_parttime: 'briefcase',
    ca_redpacket: 'redpacket', ca_other_income: 'dots',
    /* 2.5 扩充分类（与 schema 种子一一对应；旧库分类 icon 字段优先于此表） */
    ca_daily: 'daily', ca_veggie: 'carrot', ca_fruit: 'fruit', ca_snack: 'snack',
    ca_sports: 'sport', ca_clothes: 'shirt', ca_beauty: 'beauty', ca_household: 'sofa',
    ca_kids: 'baby', ca_elder: 'elder', ca_socialize: 'chat', ca_travel: 'plane',
    ca_smoke: 'glass', ca_digital: 'plug', ca_auto: 'car', ca_pet: 'pet',
    ca_office: 'briefcase', ca_repair: 'hammer', ca_donate: 'heart', ca_lottery: 'ticket',
    ca_game: 'gamepad', ca_tools: 'wrench', ca_appliance: 'washer', ca_family: 'family'
  };
  var NL_FAIL_TEXT = '没听懂金额，手动填一下吧';
  var NL_OK_TEXT = '已识别';
  var HOLD_MS = 500;

  /* ---------------- 依赖取用（都做存在性判断，缺件不白屏） ---------------- */
  function core(name) {
    var group = XZB.core || XZB.Core || null;
    return group ? group[name] || null : null;
  }
  function ui(name) {
    var group = XZB.ui || XZB.UI || null;
    return group ? group[name] || null : null;
  }
  function appApi() {
    return XZB.app || XZB.App || null;
  }
  function showToast(message, options) {
    var toast = ui('toast');
    if (toast && typeof toast.show === 'function') {
      toast.show(String(message), options || {});
    } else if (global.console && global.console.warn) {
      global.console.warn('[小账本] ' + message);
    }
  }
  /* 错误码 → 中文：一律复用 store.js 的 MESSAGES，不自编一套 */
  function messageOf(code, fallback) {
    var store = core('store');
    var table = store && store.MESSAGES ? store.MESSAGES : null;
    if (table && code && table[code]) return table[code];
    if (fallback) return fallback;
    return '操作失败，请重试';
  }
  function noteLimit() {
    var schema = core('schema');
    var limits = schema && schema.LIMITS ? schema.LIMITS : null;
    return limits && limits.txNote ? limits.txNote : NOTE_MAX;
  }
  function tagLimit() {
    var schema = core('schema');
    var limits = schema && schema.LIMITS ? schema.LIMITS : null;
    return {
      count: limits && limits.tags ? limits.tags : TAG_MAX,
      len: limits && limits.tagLen ? limits.tagLen : TAG_LEN
    };
  }
  function arr(value) {
    return Object.prototype.toString.call(value) === '[object Array]' ? value : [];
  }
  function assign(target) {
    for (var i = 1; i < arguments.length; i += 1) {
      var source = arguments[i];
      if (!source) continue;
      var keys = Object.keys(source);
      for (var k = 0; k < keys.length; k += 1) target[keys[k]] = source[keys[k]];
    }
    return target;
  }

  /* ---------------- DOM 小工具 ---------------- */
  function make(tag, className, text) {
    var node = global.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function iconNode(name, size) {
    var icons = ui('icons');
    var px = size || 24;
    if (icons && typeof icons.node === 'function') {
      try {
        var node = icons.node(name, { size: px });
        /* XML 解析缺失 xmlns 的 svg 会落进 null 命名空间，尺寸为 0、描边丢失 */
        if (node && node.namespaceURI === 'http://www.w3.org/2000/svg') return node;
      } catch (error) { /* 图标缺失不阻断渲染 */ }
    }
    if (icons && typeof icons.icon === 'function' && global.DOMParser && global.document) {
      try {
        var markup = String(icons.icon(name, { size: px }) || '');
        markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        var doc = new global.DOMParser().parseFromString(markup, 'image/svg+xml');
        var svg = doc && doc.documentElement;
        if (svg && svg.namespaceURI === 'http://www.w3.org/2000/svg') {
          return global.document.importNode(svg, true);
        }
      } catch (error2) { /* 同上，回落到占位符 */ }
    }
    return make('span', 's-add-glyph', '');
  }
  function button(className, label, ariaLabel) {
    var node = make('button', className, label);
    node.type = 'button';
    if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
    return node;
  }
  function centsToText(cents) {
    var n = Number(cents);
    if (!isFinite(n) || n <= 0) return '';
    var abs = Math.abs(Math.round(n));
    var yuan = Math.floor(abs / 100);
    var fen = abs % 100;
    return String(yuan) + '.' + (fen < 10 ? '0' + fen : String(fen));
  }
  function amountOf(text) {
    var money = core('money');
    if (!money) return 0;
    var parsed = money.parseAmount(String(text === null || text === undefined ? '' : text), { allowNegative: false });
    return parsed && parsed.ok ? parsed.cents : 0;
  }
  function formatMoney(cents) {
    var money = core('money');
    if (money && typeof money.formatCents === 'function') {
      return money.formatCents(Number(cents) || 0, { symbol: false });
    }
    var n = Number(cents) || 0;
    return (n / 100).toFixed(2);
  }

  /* ============================================================
     渲染主体
     ============================================================ */
  function render(root, ctx) {
    var dates = core('dates');
    var money = core('money');
    var schema = core('schema');
    var nl = core('nl');
    var context = ctx || {};

    if (!dates || !money || !schema) {
      root.appendChild(buildUnavailable('数据模块还没就绪，请返回重进'));
      return;
    }

    var app = appApi();
    var db = context.db || (app && typeof app.db === 'function' ? app.db() : null);
    if (!db) {
      root.appendChild(buildUnavailable('本地数据还没载入，请稍候重试'));
      return;
    }

    /* ---------- 基础数据 ---------- */
    var books = arr(db.books);
    var allAccounts = arr(db.accounts);
    var allCategories = arr(db.categories);
    var settings = db.settings && typeof db.settings === 'object' ? db.settings : {};
    var today = dates.todayStr();
    var bookId = pickBookId(books, app);
    var editId = context.params && context.params.id ? String(context.params.id) : '';
    var editing = editId ? findTransaction(db, editId) : null;
    var limitedTags = tagLimit();
    var noteMax = noteLimit();

    /* ---------- 会话状态（每次渲染重建） ---------- */
    var state = {
      type: 'expense',
      amountText: '',
      accountId: '',
      toAccountId: '',
      categoryId: '',
      date: today,
      note: '',
      tags: [],
      keypadOpen: false,
      busy: false,
      reimburse: false,
      candidates: [],
      hint: ''
    };

    /* ---------- 可选集合 ---------- */
    var accounts = liveAccounts(allAccounts);
    var categoriesAll = liveCategories(allCategories);

    /* ---------- 初值：编辑模式预填，否则用默认/上次 ---------- */
    if (editing) {
      state.type = TYPE_KEYS.indexOf(editing.type) >= 0 ? editing.type : 'expense';
      state.amountText = centsToText(editing.amountCents);
      state.accountId = existsIn(accounts, editing.accountId) ? editing.accountId : '';
      state.toAccountId = editing.type === 'transfer' && existsIn(accounts, editing.toAccountId) ? editing.toAccountId : '';
      state.categoryId = editing.categoryId ? String(editing.categoryId) : '';
      state.date = dates.isValidDateStr(editing.date) ? editing.date : today;
      state.note = typeof editing.note === 'string' ? editing.note.slice(0, noteMax) : '';
      state.tags = arr(editing.tags).slice(0, limitedTags.count);
      state.reimburse = editing.reimburse === 'pending' || editing.reimburse === 'done';
    } else {
      state.type = 'expense';
      state.accountId = defaultAccountId(accounts, app, settings);
      state.categoryId = defaultCategoryId(state.type, categoriesAll, settings);
      state.date = today;
    }

    /* ---------- DOM 骨架 ---------- */
    var wrap = make('div', 's-add-inner');
    root.appendChild(wrap);

    /* 一句话 */
    var nlBlock = make('div', 's-add-nl');
    var nlHead = make('label', 's-add-nl__label', '一句话');
    var nlRow = make('div', 's-add-nl__row');
    var nlInput = make('input', 's-add-nl__input');
    nlInput.type = 'text';
    nlInput.placeholder = '试试「昨天午饭28微信」';
    nlInput.setAttribute('autocomplete', 'off');
    nlInput.setAttribute('autocapitalize', 'off');
    nlInput.setAttribute('autocorrect', 'off');
    nlInput.setAttribute('spellcheck', 'false');
    nlInput.setAttribute('enterkeyhint', 'done');
    nlInput.setAttribute('aria-label', '一句话记账');
    var nlBtn = button('s-add-nl__btn', '解析', '解析这句话');
    nlRow.appendChild(nlInput);
    nlRow.appendChild(nlBtn);
    nlBlock.appendChild(nlHead);
    nlBlock.appendChild(nlRow);
    var nlHint = make('p', 's-add-hint');
    nlHint.setAttribute('aria-live', 'polite');
    nlHint.setAttribute('aria-atomic', 'true');
    nlBlock.appendChild(nlHint);
    var chipsWrap = make('div', 's-add-chips');
    chipsWrap.setAttribute('role', 'group');
    chipsWrap.setAttribute('aria-label', '解析候选');
    chipsWrap.hidden = true;
    nlBlock.appendChild(chipsWrap);
    wrap.appendChild(nlBlock);

    /* 分段控件（组件 c-segmented，只包布局）；编辑模式右侧给「删除」 */
    var segWrap = make('div', 's-add-seg');
    var segRow = make('div', 's-add-seg-row');
    var seg = make('div', 'c-segmented');
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', '收支类型');
    var segButtons = TYPES.map(function (item) {
      var node = button('c-segmented__item', item.label);
      node.setAttribute('role', 'tab');
      node.setAttribute('data-type', item.key);
      node.setAttribute('aria-selected', 'false');
      seg.appendChild(node);
      return node;
    });
    segRow.appendChild(seg);
    var delBtn = button('s-add-del', '删除', '删除这条记录');
    delBtn.hidden = !editing;
    segRow.appendChild(delBtn);
    segWrap.appendChild(segRow);
    wrap.appendChild(segWrap);

    /* 摘要条：当前分类 + 金额大数字右对齐（键盘常驻，金额是页面主角） */
    var draftBar = make('div', 's-add-draft');
    var draftCat = button('s-add-draft__cat', '', '打开全部分类');
    var draftIcon = make('span', 's-add-draft__ico');
    draftIcon.appendChild(iconNode('tag', 16));
    var draftCatName = make('span', 's-add-draft__name', '选择分类');
    draftCat.appendChild(draftIcon);
    draftCat.appendChild(draftCatName);
    var draftAmt = button('s-add-draft__amt', '¥0.00', '金额，点按打开数字键盘');
    draftBar.appendChild(draftCat);
    draftBar.appendChild(draftAmt);
    wrap.appendChild(draftBar);

    /* 分类宫格 */
    var gridBlock = make('div', 's-add-grid-wrap');
    var grid = make('div', 's-add-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', '选择分类');
    gridBlock.appendChild(grid);
    wrap.appendChild(gridBlock);

    /* 报销标记：只对支出有意义。参照钱迹/一木的做法——记账时勾一下，
       后面在明细里按「待报销」筛出来；入账流水这一轮不生成。 */
    var reimburseBlock = make('div', 's-add-reimburse');
    var reimburseLabel = make('span', 's-add-reimburse__label', '报销');
    var reimburseHint = make('span', 's-add-reimburse__hint', '垫付的钱，之后要报回来');
    var reimburseSwitch = button('c-switch s-add-reimburse__switch', '');
    reimburseSwitch.setAttribute('role', 'switch');
    reimburseSwitch.setAttribute('aria-checked', 'false');
    reimburseSwitch.setAttribute('aria-label', '标记为可报销');
    reimburseBlock.appendChild(reimburseLabel);
    reimburseBlock.appendChild(reimburseHint);
    reimburseBlock.appendChild(reimburseSwitch);
    wrap.appendChild(reimburseBlock);

    /* 标签 */
    var tagBlock = make('div', 's-add-tags');
    var tagLabel = make('label', 's-add-tags__label', '标签');
    tagLabel.setAttribute('for', 's-add-tag-input');
    var tagWrap = make('div', 's-add-tags__items');
    var tagInput = make('input', 's-add-tags__input');
    tagInput.type = 'text';
    tagInput.id = 's-add-tag-input';
    tagInput.placeholder = '#标签 回车添加';
    tagInput.setAttribute('autocomplete', 'off');
    tagInput.setAttribute('autocapitalize', 'off');
    tagInput.setAttribute('enterkeyhint', 'done');
    tagInput.setAttribute('aria-label', '标签，最多 5 个');
    tagWrap.appendChild(tagInput);
    tagBlock.appendChild(tagLabel);
    tagBlock.appendChild(tagWrap);

    /* 补充信息：一句话 / 备注 / 报销 / 标签收进折叠区，不抢主流程 */
    var extrasBlock = make('div', 's-add-extras');
    extrasBlock.setAttribute('data-open', '0');
    var extrasHead = button('s-add-extras__head', '');
    extrasHead.setAttribute('aria-expanded', 'false');
    extrasHead.appendChild(make('span', 's-add-extras__title', '补充信息'));
    extrasHead.appendChild(make('span', 's-add-extras__sub', '备注 · 标签 · 报销 · 一句话'));
    var extrasChevron = make('span', 's-add-extras__chev');
    extrasChevron.appendChild(iconNode('chevron-down', 16));
    extrasHead.appendChild(extrasChevron);
    var extrasBody = make('div', 's-add-extras__body');
    extrasBlock.appendChild(extrasHead);
    extrasBlock.appendChild(extrasBody);

    /* 版式：分段 → 摘要条 → 宫格 → 补充信息。账户/日期/备注收进键盘上方属性横滑栏。
       appendChild 对已挂载节点是移动，不产生副本。 */
    wrap.appendChild(segWrap);
    wrap.appendChild(draftBar);
    wrap.appendChild(gridBlock);
    extrasBody.appendChild(nlBlock);
    extrasBody.appendChild(reimburseBlock);
    extrasBody.appendChild(tagBlock);
    wrap.appendChild(extrasBlock);

    /* 固定键盘区（常驻）：上下文行 → 属性横滑栏 → 数字键盘 */
    var dock = make('div', 's-add-dock');
    dock.setAttribute('data-open', '1');
    var keypadSlot = make('div', 's-add-keypad');
    /* 键盘上下文（M3）：告诉用户正在为哪个分类/账户记账，并提供收起入口 */
    var kctx = make('div', 's-add-dock__ctx');
    var kctxText = make('span', 's-add-dock__ctx-text', '');
    kctxText.setAttribute('aria-live', 'polite');
    var kctxCollapse = button('s-add-dock__collapse', '收起', '收起数字键盘');
    kctx.appendChild(kctxText);
    kctx.appendChild(kctxCollapse);
    dock.appendChild(kctx);

    /* 属性横滑栏：账户 / 转账双账户 / 日期 / 备注，各一个 chip，点击弹 sheet
       （原「常用模板 + 账户 chip 行 + 日期 4 控件」三行全部并入此栏） */
    var propsRow = make('div', 's-add-props');
    propsRow.setAttribute('role', 'toolbar');
    propsRow.setAttribute('aria-label', '账户、日期与备注');
    function propChip(className, ariaLabel) {
      var chip = button(className, '', ariaLabel);
      chip.appendChild(make('span', 's-add-props__label'));
      chip.appendChild(iconNode('chevron-down', 14));
      return chip;
    }
    var accChip = propChip('s-add-props__chip', '选择账户');
    var toAccChip = propChip('s-add-props__chip', '选择转入账户');
    toAccChip.hidden = true;
    var dateChip = propChip('s-add-props__chip', '选择日期');
    var noteChip = propChip('s-add-props__chip s-add-props__chip--note', '添加备注');
    propsRow.appendChild(accChip);
    propsRow.appendChild(toAccChip);
    propsRow.appendChild(dateChip);
    propsRow.appendChild(noteChip);
    dock.appendChild(propsRow);
    dock.appendChild(keypadSlot);
    root.appendChild(dock);

    /* ---------- 键盘 / 视口 ---------- */
    var keypadHandle = null;
    var syncingKeypad = false;
    var replaceOnType = false;
    var parseTimer = 0;
    var reasonTimer = 0;
    var holdTimer = 0;
    var holdFired = false;
    var disposed = false;
    var listeners = [];

    function listen(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, options);
      listeners.push({ target: target, type: type, handler: handler, options: options });
    }

    function teardown() {
      if (disposed) return;
      disposed = true;
      if (parseTimer) { global.clearTimeout(parseTimer); parseTimer = 0; }
      if (holdTimer) { global.clearTimeout(holdTimer); holdTimer = 0; }
      if (reasonTimer) { global.clearTimeout(reasonTimer); reasonTimer = 0; }
      for (var i = 0; i < listeners.length; i += 1) {
        var item = listeners[i];
        try {
          item.target.removeEventListener(item.type, item.handler, item.options);
        } catch (error) { /* 忽略 */ }
      }
      listeners.length = 0;
      if (keypadHandle && typeof keypadHandle.destroy === 'function') {
        try { keypadHandle.destroy(); } catch (error) { /* 忽略 */ }
      }
      keypadHandle = null;
    }

    function readVar(name) {
      try {
        var value = global.getComputedStyle(global.document.documentElement).getPropertyValue(name);
        var n = parseFloat(value);
        return isFinite(n) ? n : 0;
      } catch (error) {
        return 0;
      }
    }

    /* 已有金额（如一句话回填 28.00）时，第一次按数字/小数点直接覆盖：
       键盘组件在满 2 位小数后不再追加，这里拦在捕获阶段先清空。 */
    listen(keypadSlot, 'click', function (event) {
      if (!replaceOnType) return;
      var node = event.target;
      while (node && node !== keypadSlot && !(node.getAttribute && node.getAttribute('data-key'))) {
        node = node.parentNode;
      }
      var key = node && node !== keypadSlot && node.getAttribute ? node.getAttribute('data-key') : '';
      if (!key) return;
      if (key === 'confirm' || key === 'delete') {
        replaceOnType = false;
        return;
      }
      if (/^\d{1,2}$/.test(key) || key === 'dot') {
        replaceOnType = false;
        if (keypadHandle && typeof keypadHandle.setValue === 'function') {
          keypadHandle.setValue('');
        }
        state.amountText = '';
        syncAmount();
      }
    }, true);

    /* ⑩ 监听 --kb：系统键盘弹起收起时重算，页面跟着回落 */
    function onViewportChange() {
      if (!root.isConnected) { teardown(); return; }
      var kb = readVar('--kb');
      root.setAttribute('data-kb', kb > 0 ? '1' : '0');
      if (kb > 0 && state.keypadOpen) closeKeypad();
    }

    listen(global, 'resize', onViewportChange);
    listen(global, 'orientationchange', onViewportChange);
    if (global.visualViewport && typeof global.visualViewport.addEventListener === 'function') {
      listen(global.visualViewport, 'resize', onViewportChange);
      listen(global.visualViewport, 'scroll', onViewportChange);
    }

    /* ---------- 账户 / 分类取用 ---------- */
    function accountById(id) {
      for (var i = 0; i < accounts.length; i += 1) {
        if (accounts[i].id === id) return accounts[i];
      }
      return null;
    }
    function categoryById(id) {
      for (var i = 0; i < categoriesAll.length; i += 1) {
        if (categoriesAll[i].id === id) return categoriesAll[i];
      }
      return null;
    }
    function categoriesFor(type) {
      if (type === 'transfer') return [];
      var out = [];
      for (var i = 0; i < categoriesAll.length; i += 1) {
        /* 「其他」不进宫格与选择器：它是一句话识别/导入的兜底分类，避免什么都往里扔 */
        if (type === 'expense' && categoriesAll[i].id === 'ca_other_expense') { continue; }
        if (categoriesAll[i].kind === type) out.push(categoriesAll[i]);
      }
      return out;
    }

    /* ---------- 同步：草稿条 / 金额 ---------- */
    function draftTypeLabel() {
      for (var i = 0; i < TYPES.length; i += 1) {
        if (TYPES[i].key === state.type) return TYPES[i].label;
      }
      return '';
    }

    function syncDraft() {
      var cents = amountOf(state.amountText);
      draftAmt.textContent = '¥' + formatMoney(cents);
      draftAmt.classList.toggle('is-empty', !(cents > 0));
      var category = categoryById(state.categoryId);
      if (state.type === 'transfer') {
        draftCatName.textContent = '转账';
      } else {
        draftCatName.textContent = category ? category.name : '选择分类';
      }
      var iconName = state.type === 'transfer'
        ? 'transfer'
        : (category ? (category.icon || CAT_ICON[category.id] || 'tag') : 'tag');
      clear(draftIcon);
      draftIcon.appendChild(iconNode(iconName, 16));
      draftCat.classList.toggle('is-active', !!category || state.type === 'transfer');
    }

    /* 键盘上下文与完成键文案（M3） */
    function syncKeypadContext() {
      var parts = [];
      if (state.type === 'transfer') {
        var from = accountById(state.accountId);
        var to = accountById(state.toAccountId);
        parts.push('转账');
        parts.push((from ? from.name : '转出') + ' → ' + (to ? to.name : '转入'));
      } else {
        var category = categoryById(state.categoryId);
        parts.push(category ? category.name : '未选分类');
        parts.push(draftTypeLabel());
        var account = accountById(state.accountId);
        parts.push(account ? account.name : '未选账户');
      }
      kctxText.textContent = parts.join(' · ');
      var confirmKey = keypadSlot.querySelector('[data-key="confirm"]');
      if (confirmKey) {
        confirmKey.textContent = amountOf(state.amountText) > 0 ? '保存' : '完成';
      }
    }

    function syncAmount() {
      syncDraft();
      syncKeypadContext();
      syncSaveState();
    }

    /* ---------- 同步：保存条件（保存走键盘「完成」键，不再有底栏按钮） ---------- */
    function canSave() {
      var cents = amountOf(state.amountText);
      if (!(cents > 0)) return { ok: false, reason: '输入金额' };
      if (state.type === 'transfer') {
        if (!state.accountId) return { ok: false, reason: '选择转出账户' };
        if (!state.toAccountId) return { ok: false, reason: '选择转入账户' };
        if (state.accountId === state.toAccountId) {
          return { ok: false, reason: messageOf('E_TRANSFER_SAME', '转出和转入不能是同一个账户') };
        }
      } else {
        if (!state.categoryId) return { ok: false, reason: messageOf('E_TX_CATEGORY_REQUIRED', '请选择分类') };
        if (!state.accountId) return { ok: false, reason: '选择账户' };
      }
      if (!dates.isValidDateStr(state.date)) return { ok: false, reason: messageOf('E_TX_DATE', '日期无效') };
      return { ok: true, reason: '' };
    }

    function syncSaveState() {
      syncTitle();
    }

    /* 不满足保存条件时，在键盘上下文行临时提示原因，2.4s 后恢复上下文 */
    function showReason(text) {
      kctxText.textContent = String(text || '');
      kctxText.classList.add('is-warn');
      if (reasonTimer) { global.clearTimeout(reasonTimer); }
      reasonTimer = global.setTimeout(function () {
        reasonTimer = 0;
        if (disposed) return;
        kctxText.classList.remove('is-warn');
        syncKeypadContext();
      }, 2400);
    }

    /* 标题：编辑 / 记一笔 / 还款（信用卡为转入方，UI.md §6.4） */
    function baseTitle() {
      if (editing) return '编辑';
      var to = state.type === 'transfer' ? accountById(state.toAccountId) : null;
      return to && to.type === 'credit' ? '还款' : '记一笔';
    }

    function syncTitle() {
      if (!context || typeof context.setTitle !== 'function') return;
      /* 旧屏的延迟回调不能改到新屏的标题 */
      if (root && typeof root.isConnected === 'boolean' && !root.isConnected) return;
      if (global.document && global.document.activeElement === nlInput) return;
      context.setTitle(baseTitle());
    }

    function pulseAmount() {
      draftAmt.classList.remove('is-pulse');
      /* 强制重排后再加类，动画才会重播 */
      void draftAmt.offsetWidth;
      draftAmt.classList.add('is-pulse');
      global.setTimeout(function () {
        if (!disposed) draftAmt.classList.remove('is-pulse');
      }, 180);
    }

    /* ---------- 同步：类型 ---------- */
    function syncType() {
      for (var i = 0; i < segButtons.length; i += 1) {
        var active = segButtons[i].getAttribute('data-type') === state.type;
        segButtons[i].setAttribute('aria-selected', active ? 'true' : 'false');
        segButtons[i].classList.toggle('is-active', active);
        segButtons[i].classList.toggle('is-disabled', !!editing);
        if (editing) segButtons[i].setAttribute('aria-disabled', 'true');
      }
      var isTransfer = state.type === 'transfer';
      gridBlock.hidden = isTransfer;
      tagBlock.hidden = isTransfer;
      reimburseBlock.hidden = state.type !== 'expense';
      reimburseSwitch.setAttribute('aria-checked', state.reimburse ? 'true' : 'false');
      root.setAttribute('data-type', state.type);
      syncProps();
      renderGrid();
    }

    /* ---------- 类型切换 ---------- */
    function setType(next) {
      if (TYPE_KEYS.indexOf(next) < 0 || next === state.type) return;
      if (editing) {
        showToast(messageOf('E_TX_TYPE', '收支类型不能直接改，请删除后重记'), { type: 'warning' });
        return;
      }
      state.type = next;
      if (next === 'transfer') {
        if (state.accountId === state.toAccountId) state.toAccountId = '';
      } else {
        var current = categoryById(state.categoryId);
        if (!current || current.kind !== next) {
          state.categoryId = defaultCategoryId(next, categoriesAll, settings);
        }
      }
      syncType();
      syncAmount();
    }

    /* ---------- 账户（属性栏 chip + sheet 选择） ---------- */
    var ACC_ICON = {
      cash: 'cash', debit: 'bank-card', wechat: 'wechat', alipay: 'alipay',
      credit: 'credit-card', savings: 'savings-account'
    };

    function setChipLabel(chip, text) {
      var label = chip.querySelector('.s-add-props__label');
      if (label) { label.textContent = String(text); }
    }

    /* 属性栏同步：账户（转账时转出 + 转入两枚）· 日期 · 备注 */
    function syncProps() {
      var account = accountById(state.accountId);
      var isTransfer = state.type === 'transfer';
      setChipLabel(accChip, isTransfer
        ? '转出 ' + (account ? account.name : '选账户')
        : (account ? account.name : '选账户'));
      toAccChip.hidden = !isTransfer;
      if (isTransfer) {
        var to = accountById(state.toAccountId);
        setChipLabel(toAccChip, '转入 ' + (to ? to.name : '选账户'));
      }
      setChipLabel(dateChip, dates.formatHuman(state.date));
      var noteText = String(state.note || '');
      setChipLabel(noteChip, noteText
        ? '备注 ' + noteText.slice(0, 6) + (noteText.length > 6 ? '…' : '')
        : '备注…');
      noteChip.classList.toggle('is-set', !!noteText);
    }

    function setAccount(id) {
      if (!existsIn(accounts, id)) return;
      state.accountId = id;
      if (state.type === 'transfer' && state.toAccountId === id) state.toAccountId = '';
      syncProps();
      syncAmount();
    }

    function setToAccount(id) {
      if (!existsIn(accounts, id)) return;
      if (id === state.accountId) {
        showToast(messageOf('E_TRANSFER_SAME', '转出和转入不能是同一个账户'), { type: 'warning' });
        return;
      }
      state.toAccountId = id;
      syncProps();
      syncAmount();
    }

    function openAccountSheet(isTo) {
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        showToast('账户选择暂时不可用', { type: 'warning' });
        return;
      }
      var holder = make('div', 's-add-accsheet');
      if (!accounts.length) {
        holder.appendChild(make('p', 's-add-empty-inline', '还没有账户，去设置里加一个吧'));
      }
      var currentId = isTo ? state.toAccountId : state.accountId;
      accounts.forEach(function (account) {
        var row = button('c-row c-row--tappable s-add-accsheet__row');
        row.setAttribute('data-account', account.id);
        if (account.id === currentId) { row.classList.add('c-row--selected'); }
        var tileNode = make('span', 'c-tile c-tile--lg');
        tileNode.appendChild(iconNode(ACC_ICON[String(account.type || 'cash')] || 'cash', 22));
        row.appendChild(tileNode);
        var main = make('span', 'c-row__main');
        main.appendChild(make('span', 'c-row__title', account.name || '未命名账户'));
        row.appendChild(main);
        if (account.id === currentId) {
          var check = make('span', 's-add-accsheet__check');
          check.appendChild(iconNode('check', 18));
          row.appendChild(check);
        }
        row.addEventListener('click', function () {
          if (isTo) { setToAccount(account.id); } else { setAccount(account.id); }
          sheetHandle.close('pick');
        });
        holder.appendChild(row);
      });
      var sheetHandle = sheet.open({
        title: isTo ? '转入账户' : (state.type === 'transfer' ? '转出账户' : '账户'),
        content: holder
      });
    }

    /* ---------- 同步：分类宫格（两层） ----------
     * 主层只放常用（收藏 → 自定义 → 最近 → 高频 → 系统兜底，共 8 个）＋「全部」「自定义」；
     * 其余分类进「全部」底部面板。当前选中的分类永远挤进主层，保证看得见。 */
    var GRID_MAIN = 8;

    function favoriteIds() {
      var prefs = prefApi();
      if (!prefs || typeof prefs.get !== 'function') return [];
      return arr(prefs.get('favoriteCategoryIds', [])).map(function (id) {
        return String(id);
      });
    }

    function mainCategories(type) {
      var pool = categoriesFor(type);
      var byId = {};
      for (var p = 0; p < pool.length; p += 1) { byId[pool[p].id] = pool[p]; }
      var picked = [];
      var seen = {};
      function push(id) {
        if (!id || seen[id] || !byId[id]) return;
        seen[id] = true;
        picked.push(byId[id]);
      }
      var favs = favoriteIds();
      for (var f = 0; f < favs.length; f += 1) { push(favs[f]); }
      /* 用户自建的分类就是要常用，优先露脸 */
      for (var c = 0; c < pool.length && picked.length < GRID_MAIN; c += 1) {
        if (pool[c].system !== true) { push(pool[c].id); }
      }
      var recents = recentPairs();
      for (var r = 0; r < recents.length && picked.length < GRID_MAIN; r += 1) { push(recents[r].categoryId); }
      var hist = historyPairs(type);
      for (var h = 0; h < hist.length && picked.length < GRID_MAIN; h += 1) { push(hist[h].categoryId); }
      for (var s = 0; s < pool.length && picked.length < GRID_MAIN; s += 1) { push(pool[s].id); }
      /* 当前选中的分类不在主层就顶到最前（编辑/「全部」面板选来的） */
      if (state.categoryId && !seen[state.categoryId]) {
        picked.unshift(byId[state.categoryId]);
        picked = picked.slice(0, GRID_MAIN);
      }
      return picked;
    }

    function gridCell(category, index) {
      var cell = button('s-add-cat');
      cell.setAttribute('data-category', category.id);
      cell.setAttribute('data-tone', String(((index % 12) + 1)));
      cell.setAttribute('aria-pressed', 'false');
      var ico = make('span', 's-add-cat__ico');
      ico.appendChild(iconNode(category.icon || CAT_ICON[category.id] || 'tag', 24));
      var label = make('span', 's-add-cat__name', category.name || '未命名');
      cell.appendChild(ico);
      cell.appendChild(label);
      return cell;
    }

    function renderGrid() {
      clear(grid);
      if (state.type === 'transfer') return;
      var list = mainCategories(state.type);
      for (var i = 0; i < list.length; i += 1) {
        grid.appendChild(gridCell(list[i], i));
      }
      /* 「全部」格：打开全部分类面板 */
      var allCell = button('s-add-cat s-add-cat--all', '');
      allCell.setAttribute('data-action', 'all');
      allCell.setAttribute('aria-label', '全部分类');
      var allIco = make('span', 's-add-cat__ico');
      allIco.appendChild(iconNode('ellipsis', 24));
      allCell.appendChild(allIco);
      allCell.appendChild(make('span', 's-add-cat__name', '全部'));
      grid.appendChild(allCell);

      /* 「管理」格：灰底 + 号，与其余图标同规格（保留自定义分类功能，去视觉噪音） */
      var quickCell = button('s-add-cat s-add-cat--quick', '');
      quickCell.setAttribute('data-action', 'quick');
      quickCell.setAttribute('aria-label', '自定义分类');
      var quickIco = make('span', 's-add-cat__ico');
      quickIco.appendChild(iconNode('plus', 24));
      quickCell.appendChild(quickIco);
      quickCell.appendChild(make('span', 's-add-cat__name', '管理'));
      grid.appendChild(quickCell);
      syncGridActive();
    }

    function syncGridActive() {
      var cells = grid.querySelectorAll('[data-category]');
      for (var i = 0; i < cells.length; i += 1) {
        var active = cells[i].getAttribute('data-category') === state.categoryId;
        cells[i].classList.toggle('is-active', active);
        cells[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    function setCategory(id) {
      var category = categoryById(id);
      if (!category) return;
      if (category.kind !== state.type) return;
      state.categoryId = id;
      renderGrid();
      syncAmount();
    }

    /* ---------- 「全部」分类底部面板（N1） ----------
     * 搜索 + 支出/收入过滤 + 常用/系统/自定义分组；选中即关面板、更新草稿条并弹键盘。 */
    function openAllCategories() {
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        showToast('分类面板暂时不可用', { type: 'warning' });
        return;
      }
      var panelKind = state.type === 'income' ? 'income' : 'expense';
      if (state.type === 'transfer') return;
      var holder = make('div', 's-add-all');
      var keyword = '';

      var searchBar = make('div', 's-add-all__search');
      var searchInput = make('input', 's-add-all__input');
      searchInput.type = 'search';
      searchInput.placeholder = '搜索分类';
      searchInput.setAttribute('autocomplete', 'off');
      searchInput.setAttribute('aria-label', '搜索分类');
      searchBar.appendChild(searchInput);

      var kindRow = make('div', 's-add-all__kinds');
      function paintKind() {
        clear(kindRow);
        [['expense', '支出分类'], ['income', '收入分类']].forEach(function (pair) {
          var chip = button('c-chip' + (panelKind === pair[0] ? ' is-active' : ''), pair[1]);
          chip.addEventListener('click', function () {
            if (panelKind === pair[0]) return;
            panelKind = pair[0];
            paintKind();
            paintGroups();
          });
          kindRow.appendChild(chip);
        });
      }

      var listBox = make('div', 's-add-all__list');
      function paintGroups() {
        clear(listBox);
        var pool = categoriesFor(panelKind).filter(function (category) {
          if (!keyword) return true;
          return String(category.name || '').indexOf(keyword) >= 0;
        });
        var favs = favoriteIds();
        function isFav(category) { return favs.indexOf(category.id) >= 0; }

        function section(title, list) {
          if (!list.length) return;
          listBox.appendChild(make('p', 's-add-all__group', title));
          var gridNode = make('div', 's-add-all__grid');
          list.forEach(function (category, index) {
            gridNode.appendChild(allCell(category, index));
          });
          listBox.appendChild(gridNode);
        }
        section('常用', pool.filter(isFav));
        section('自定义分类', pool.filter(function (c) { return c.system !== true && !isFav(c); }));
        section('系统分类', pool.filter(function (c) { return c.system === true && !isFav(c); }));
        if (!listBox.childNodes.length) {
          listBox.appendChild(make('p', 's-add-all__empty',
            keyword ? '没有叫「' + keyword + '」的分类' : '还没有可选的分类'));
        }
      }

      function allCell(category, index) {
        var cell = button('s-add-cat s-add-cat--sm');
        cell.setAttribute('data-category', category.id);
        cell.setAttribute('data-tone', String((index % 12) + 1));
        cell.setAttribute('aria-label', '选择分类 ' + (category.name || ''));
        var ico = make('span', 's-add-cat__ico');
        ico.appendChild(iconNode(category.icon || CAT_ICON[category.id] || 'tag', 22));
        cell.appendChild(ico);
        cell.appendChild(make('span', 's-add-cat__name', category.name || '未命名'));
        cell.addEventListener('click', function () {
          var target = categoryById(category.id);
          if (!target) return;
          if (target.kind !== state.type) {
            if (editing) return; /* 编辑模式锁类型，跨类型分类不响应 */
            setType(target.kind);
          }
          setCategory(target.id);
          sheetHandle.close('pick');
          openKeypad();
        });
        return cell;
      }

      searchInput.addEventListener('input', function () {
        keyword = String(searchInput.value || '').trim();
        paintGroups();
      });

      holder.appendChild(searchBar);
      holder.appendChild(kindRow);
      holder.appendChild(listBox);
      var manageBtn = button('c-btn c-btn--secondary c-btn--block s-add-all__manage', '管理分类');
      manageBtn.addEventListener('click', function () {
        sheetHandle.close('manage');
        openCategoryManage();
      });
      holder.appendChild(manageBtn);
      paintKind();
      paintGroups();

      var sheetHandle = sheet.open({
        title: '选择分类',
        content: holder
      });
    }

    /* ---------- 同步：日期（属性栏 chip 承载，今天/昨天快捷项进日历 sheet） ---------- */
    function syncDate() {
      setChipLabel(dateChip, dates.formatHuman(state.date));
    }

    function setDate(next) {
      if (!dates.isValidDateStr(next)) return;
      state.date = next;
      syncDate();
      syncAmount();
    }

    function openCalendar() {
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        showToast('日期选择暂时不可用', { type: 'warning' });
        return;
      }
      var dow = Number(settings.firstDayOfWeek);
      if (!(dow >= 0 && dow <= 6)) dow = 1;
      var cursor = { year: Number(state.date.slice(0, 4)), month: Number(state.date.slice(5, 7)) };
      var holder = make('div', 's-add-cal');

      function monthFirst() {
        return cursor.year + '-' + (cursor.month < 10 ? '0' + cursor.month : String(cursor.month)) + '-01';
      }

      function paint() {
        clear(holder);
        var head = make('div', 'c-cal__header');
        var prev = button('c-cal__nav', '', '上个月');
        prev.setAttribute('data-nav', '-1');
        prev.appendChild(iconNode('chevron-left', 20));
        var title = make('span', 'c-cal__title', cursor.year + '年' + cursor.month + '月');
        var next = button('c-cal__nav', '', '下个月');
        next.setAttribute('data-nav', '1');
        next.appendChild(iconNode('chevron-right', 20));
        head.appendChild(prev);
        head.appendChild(title);
        head.appendChild(next);
        holder.appendChild(head);

        var weekdays = make('div', 'c-cal__weekdays');
        for (var w = 0; w < 7; w += 1) {
          weekdays.appendChild(make('span', 'c-cal__weekday', WEEKDAY_CN[(w + dow) % 7]));
        }
        holder.appendChild(weekdays);

        var gridNode = make('div', 'c-cal__grid');
        var firstStr = monthFirst();
        var firstDate = dates.parseLocalDate(firstStr);
        var lead = (firstDate.getDay() - dow + 7) % 7;
        var dayCount = new Date(cursor.year, cursor.month, 0).getDate();
        var total = Math.ceil((lead + dayCount) / 7) * 7;
        var maxDate = dates.addDays(today, 366);
        for (var d = 0; d < total; d += 1) {
          var dateStr = dates.addDays(firstStr, d - lead);
          var dayNum = Number(dateStr.slice(8, 10));
          var cell = button('c-cal__day', String(dayNum));
          cell.setAttribute('data-date', dateStr);
          if (d < lead || d >= lead + dayCount) cell.classList.add('is-outside');
          if (dateStr === today) cell.classList.add('is-today');
          if (dateStr === state.date) {
            cell.classList.add('is-selected');
            cell.setAttribute('aria-selected', 'true');
          } else {
            cell.setAttribute('aria-selected', 'false');
          }
          if (dateStr > maxDate) {
            cell.disabled = true;
            cell.classList.add('is-disabled');
          }
          cell.setAttribute('aria-label', dateStr);
          gridNode.appendChild(cell);
        }
        holder.appendChild(gridNode);
      }

      paint();

      holder.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        var nav = target.closest('.c-cal__nav');
        if (nav) {
          var dir = Number(nav.getAttribute('data-nav')) === 1 ? 1 : -1;
          cursor.month += dir;
          if (cursor.month < 1) { cursor.month = 12; cursor.year -= 1; }
          if (cursor.month > 12) { cursor.month = 1; cursor.year += 1; }
          paint();
          return;
        }
        var day = target.closest('.c-cal__day');
        if (day && !day.disabled) {
          var picked = day.getAttribute('data-date');
          setDate(picked);
          sheet.close('pick');
        }
      });

      sheet.open({
        title: '选择日期',
        content: holder,
        actions: [
          { label: '前天', kind: 'default', onClick: function () { setDate(dates.addDays(today, -2)); } },
          { label: '昨天', kind: 'default', onClick: function () { setDate(dates.addDays(today, -1)); } },
          { label: '今天', kind: 'default', onClick: function () { setDate(today); } }
        ]
      });
    }

    /* ---------- 自定义分类（宫格「自定义」格的面板） ----------
     * 在这里新建的分类永久挂在宫格末尾（maxSort+10），以后记账直接点它。
     * 删除沿用设置页的 applyCategoryDelete：存量流水自动归到「其他」。
     */
    var CAT_PALETTE = ['#C2410C', '#1D4ED8', '#BE185D', '#0F766E', '#7C3AED', '#B91C1C',
      '#0369A1', '#A16207', '#0E7490', '#15803D', '#4338CA', '#52525B'];
    var QUICK_ICONS = ['food', 'bag', 'daily', 'bus', 'carrot', 'fruit', 'snack', 'sport',
      'fun', 'phone', 'shirt', 'beauty', 'house', 'sofa', 'baby', 'elder', 'chat', 'plane',
      'glass', 'plug', 'car', 'book', 'cap', 'pet', 'envelope', 'gift', 'briefcase',
      'hammer', 'heart', 'ticket', 'family', 'gamepad', 'wrench', 'washer', 'salary',
      'bonus', 'invest', 'parttime', 'redpacket', 'ellipsis'];

    /* 屏幕层统一走 commit 兜底链（与 attemptSave 同款）：router ctx 可能不带 commit */
    function quickCommit(mutator, options) {
      var commit = context.commit || (app && app.commit ? app.commit : null);
      if (typeof commit !== 'function') {
        return Promise.resolve({ ok: false, code: 'E_NOT_READY', message: '保存通道未就绪' });
      }
      return commit(mutator, options);
    }

    function openQuickItems() {
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        showToast('自定义分类暂时不可用', { type: 'warning' });
        return;
      }
      var holder = make('div', 's-quick');

      function freshCategories() {
        var source = app && typeof app.db === 'function' ? app.db() : db;
        return source && Array.isArray(source.categories) ? source.categories : [];
      }

      function paintList() {
        clear(holder);
        var customs = [];
        var all = freshCategories();
        for (var i = 0; i < all.length; i += 1) {
          if (all[i] && all[i].system !== true) { customs.push(all[i]); }
        }
        if (!customs.length) {
          holder.appendChild(make('p', 's-quick__empty',
            '还没有自定义分类。建一个（比如「烟钱」「猫粮」），它会一直留在宫格最后，以后直接点它记账。'));
        } else {
          var list = make('div', 's-quick__list');
          for (var j = 0; j < customs.length; j += 1) {
            list.appendChild(customRow(customs[j]));
          }
          holder.appendChild(list);
        }
        var newBtn = button('c-btn c-btn--primary c-btn--block s-quick__new', '＋ 新建分类');
        newBtn.addEventListener('click', function () { paintForm(); });
        holder.appendChild(newBtn);
        holder.appendChild(make('p', 's-quick__hint', '新建的分类固定排在宫格最后，记账时直接点图标就行。'));
      }

      function customRow(category) {
        var row = make('div', 's-quick__row');
        var tile = make('span', 'c-tile c-tile--lg');
        tile.appendChild(iconNode(category.icon || 'tag', 22));
        row.appendChild(tile);
        var main = make('span', 's-quick__main');
        main.appendChild(make('span', 's-quick__name', category.name || '未命名'));
        main.appendChild(make('span', 's-quick__meta', category.kind === 'income' ? '收入分类' : '支出分类'));
        row.appendChild(main);
        var del = button('c-btn c-btn--sm c-btn--danger', '删除');
        del.addEventListener('click', function (event) {
          event.stopPropagation();
          deleteCustom(category);
        });
        row.appendChild(del);
        return row;
      }

      function deleteCustom(category) {
        if (typeof schema.applyCategoryDelete !== 'function') {
          showToast('删除暂时不可用，请到「我的 → 分类管理」操作', { type: 'warning' });
          return;
        }
        quickCommit(function (working) {
          var applied = schema.applyCategoryDelete(working, category.id);
          if (!applied || !applied.ok) {
            return { abort: true, code: (applied && applied.code) || 'E_CATEGORY_MISSING' };
          }
          var keys = ['categories', 'transactions', 'recurring', 'categoryBudgets'];
          for (var k = 0; k < keys.length; k += 1) {
            if (Array.isArray(applied.db[keys[k]])) { working[keys[k]] = applied.db[keys[k]]; }
          }
          working.updatedAt = applied.db.updatedAt || dates.nowIso();
          return {};
        }, { label: '删除自定义分类' }).then(function (res) {
          if (!res || !res.ok) {
            showToast(messageOf(res.code, '删除失败，请重试'), { type: 'danger' });
            return;
          }
          showToast('分类已删除，相关流水归到「其他」', { type: 'success' });
          paintList();
        });
      }

      function paintForm() {
        clear(holder);
        var draft = { name: '', icon: QUICK_ICONS[0], kind: state.type === 'income' ? 'income' : 'expense' };
        var KINDS = [['expense', '支出分类'], ['income', '收入分类']];

        var kindRow = make('div', 's-quick__chips');
        holder.appendChild(kindRow);
        function paintKindChips() {
          clear(kindRow);
          for (var k = 0; k < KINDS.length; k += 1) {
            (function (pair) {
              var chip = button('c-chip' + (draft.kind === pair[0] ? ' is-active' : ''), pair[1]);
              chip.addEventListener('click', function () {
                draft.kind = pair[0];
                paintKindChips();
              });
              kindRow.appendChild(chip);
            }(KINDS[k]));
          }
        }
        paintKindChips();

        holder.appendChild(make('span', 's-quick__label', '名称'));
        var nameInput = make('input', 's-quick__input');
        nameInput.type = 'text';
        nameInput.maxLength = 8;
        nameInput.placeholder = '例如：烟钱、猫粮、奶茶';
        nameInput.setAttribute('enterkeyhint', 'done');
        holder.appendChild(nameInput);

        holder.appendChild(make('span', 's-quick__label', '图标'));
        var iconRow = make('div', 's-quick__chips s-quick__icons');
        holder.appendChild(iconRow);
        function paintIconChips() {
          clear(iconRow);
          for (var i = 0; i < QUICK_ICONS.length; i += 1) {
            (function (name) {
              var chip = button('s-quick__icon' + (draft.icon === name ? ' is-active' : ''));
              chip.setAttribute('aria-label', '图标 ' + name);
              chip.appendChild(iconNode(name, 20));
              chip.addEventListener('click', function () {
                draft.icon = name;
                paintIconChips();
              });
              iconRow.appendChild(chip);
            }(QUICK_ICONS[i]));
          }
        }
        paintIconChips();

        var saveBtn = button('c-btn c-btn--primary c-btn--block s-quick__new', '创建分类');
        saveBtn.addEventListener('click', createCategory);
        holder.appendChild(saveBtn);

        function createCategory() {
          var name = String(nameInput.value || '').trim().slice(0, 8);
          if (!name) {
            showToast('先给分类起个名字', { type: 'warning' });
            return;
          }
          quickCommit(function (working) {
            var list = Array.isArray(working.categories) ? working.categories : [];
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] && list[i].kind === draft.kind && list[i].name === name) {
                return { abort: true, code: 'E_CATEGORY_DUP', message: '已经有叫「' + name + '」的分类了' };
              }
            }
            var maxSort = 0;
            for (var s = 0; s < list.length; s += 1) {
              if (list[s] && list[s].kind === draft.kind) {
                var value = Number(list[s].sort);
                if (isFinite(value) && value > maxSort) { maxSort = value; }
              }
            }
            var customCount = 0;
            for (var c = 0; c < list.length; c += 1) {
              if (list[c] && list[c].system !== true) { customCount += 1; }
            }
            var created = schema.createCategory({
              kind: draft.kind,
              name: name,
              icon: draft.icon,
              color: CAT_PALETTE[customCount % CAT_PALETTE.length],
              sort: maxSort + 10,
              hidden: false,
              system: false,
              aliases: []
            }, dates.nowIso());
            var check = schema.validateCategory(created, { categories: list });
            if (!check.ok) {
              return { abort: true, code: check.errors[0].code || 'E_INVALID_INPUT' };
            }
            list.push(created);
            working.updatedAt = dates.nowIso();
            return {};
          }, { label: '新增自定义分类' }).then(function (res) {
            if (!res || !res.ok) {
              showToast(messageOf(res.code, res.message || '保存失败，请重试'), { type: 'danger' });
              return;
            }
            showToast('分类已加到宫格最后', { type: 'success' });
            sheet.close('created');
          });
        }
      }

      paintList();
      sheet.open({
        title: '自定义分类',
        content: holder
      });
    }

    /* ---------- 同步：最近使用 ----------
     * 存「分类 + 账户」组合（A7：chip 显示「餐饮 · 微信」，点一下两者都回填）。
     * 旧版只存分类 id 的 recentCategories 仍兼容读取。
     */
    function prefApi() {
      return context.prefs || (app && app.prefs ? app.prefs : null);
    }

    function recentPairs() {
      var prefs = prefApi();
      if (!prefs || typeof prefs.get !== 'function') return [];
      var raw = prefs.get('recentPairs', null);
      var out = [];
      var i;
      if (arr(raw).length) {
        for (i = 0; i < raw.length; i += 1) {
          var item = raw[i];
          if (!item || !item.categoryId) continue;
          out.push({
            categoryId: String(item.categoryId),
            accountId: item.accountId ? String(item.accountId) : ''
          });
        }
        return out;
      }
      var legacy = prefs.get('recentCategories', []);
      for (i = 0; i < arr(legacy).length; i += 1) {
        if (legacy[i]) out.push({ categoryId: String(legacy[i]), accountId: '' });
      }
      return out;
    }

    /* 历史高频组合：prefs 还没有记录（新环境/换设备）时，「常用」行也有内容可点 */
    function historyPairs(type) {
      var list = arr(db.transactions);
      var map = {};
      for (var i = 0; i < list.length; i += 1) {
        var t = list[i];
        if (!t || t.deleted === true || t.type !== type) continue;
        if (!t.categoryId || !t.accountId) continue;
        if (t.bookId && bookId && t.bookId !== bookId) continue;
        var key = t.categoryId + '|' + t.accountId;
        var entry = map[key];
        if (!entry) { entry = map[key] = { categoryId: t.categoryId, accountId: t.accountId, count: 0, last: '' }; }
        entry.count += 1;
        var seen = (t.date || '') + 'T' + (t.time || '');
        if (seen > entry.last) entry.last = seen;
      }
      var out = [];
      for (var k in map) { out.push(map[k]); }
      out.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        return a.last < b.last ? 1 : a.last > b.last ? -1 : 0;
      });
      return out;
    }

    /* 模板金额：这个组合在当前账本里记得最多的一次金额（并列取最近一次） */
    function templateAmountCents(categoryId, accountId, type) {
      var list = arr(db.transactions);
      var counts = {};
      var lastSeen = {};
      for (var i = 0; i < list.length; i += 1) {
        var t = list[i];
        if (!t || t.deleted === true || t.type !== type) continue;
        if (t.categoryId !== categoryId) continue;
        if (t.bookId && bookId && t.bookId !== bookId) continue;
        if (accountId ? t.accountId !== accountId : !t.accountId) continue;
        var cents = Number(t.amountCents);
        if (!(cents > 0)) continue;
        counts[cents] = (counts[cents] || 0) + 1;
        var seen = (t.date || '') + 'T' + (t.time || '');
        if (lastSeen[cents] === undefined || seen > lastSeen[cents]) lastSeen[cents] = seen;
      }
      var best = 0;
      var bestCount = 0;
      var bestSeen = '';
      for (var centsKey in counts) {
        var count = counts[centsKey];
        if (count > bestCount || (count === bestCount && lastSeen[centsKey] > bestSeen)) {
          best = Number(centsKey);
          bestCount = count;
          bestSeen = lastSeen[centsKey];
        }
      }
      return best;
    }

    function chipAmountText(cents) {
      var m = core('money');
      var text = m && typeof m.formatCents === 'function'
        ? m.formatCents(cents, { symbol: false })
        : (cents / 100).toFixed(2);
      return '¥' + text.replace(/\.00$/, '');
    }

    /* 常用模板行已并入属性栏/宫格排序（mainCategories 用 recentPairs 优先露出常用分类） */

    /* ---------- 备注（属性栏 chip + sheet 编辑，页面不再常驻输入框） ---------- */
    function syncNote() {
      syncProps();
    }

    function openNoteSheet() {
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        showToast('备注编辑暂时不可用', { type: 'warning' });
        return;
      }
      var holder = make('div', 's-add-notesheet');
      var input = make('input', 's-add-notesheet__input');
      input.type = 'text';
      input.value = String(state.note || '');
      input.maxLength = noteMax;
      input.placeholder = '添加备注';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', '备注，最多 ' + noteMax + ' 字');
      var count = make('span', 's-add-notesheet__count', String(state.note || '').length + '/' + noteMax);
      input.addEventListener('input', function () {
        count.textContent = String(input.value || '').length + '/' + noteMax;
      });
      function commit() {
        state.note = String(input.value || '').slice(0, noteMax);
        syncNote();
      }
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          sheetHandle.close('done');
        }
      });
      holder.appendChild(input);
      holder.appendChild(count);
      var sheetHandle = sheet.open({
        title: '备注',
        content: holder,
        actions: [
          { label: '清除', kind: 'default', onClick: function () { input.value = ''; state.note = ''; syncNote(); count.textContent = '0/' + noteMax; } },
          { label: '完成', kind: 'primary', onClick: commit }
        ]
      });
    }

    /* ---------- 同步：标签 ---------- */
    function syncTags() {
      var chips = tagWrap.querySelectorAll('[data-tag]');
      for (var i = 0; i < chips.length; i += 1) tagWrap.removeChild(chips[i]);
      for (var t = 0; t < state.tags.length; t += 1) {
        var chip = make('span', 's-add-tag');
        chip.setAttribute('data-tag', state.tags[t]);
        chip.appendChild(make('span', 's-add-tag__text', '#' + state.tags[t]));
        var close = button('s-add-tag__x', '×', '删除标签 ' + state.tags[t]);
        close.setAttribute('data-remove', state.tags[t]);
        chip.appendChild(close);
        tagWrap.insertBefore(chip, tagInput);
      }
    }

    function commitTag(raw) {
      var limits = limitedTags;
      var text = String(raw === null || raw === undefined ? '' : raw).replace(/^[#\s]+/, '').replace(/[\s,，]+$/, '').trim();
      if (!text) { tagInput.value = ''; return; }
      if (state.tags.length >= limits.count) {
        showToast(messageOf('E_TX_TAG', '标签最多 5 个，每个最多 10 字'), { type: 'warning' });
        tagInput.value = '';
        return;
      }
      if (text.length > limits.len) {
        text = text.slice(0, limits.len);
        showToast(messageOf('E_TX_TAG', '标签最多 5 个，每个最多 10 字'), { type: 'warning' });
      }
      if (state.tags.indexOf(text) >= 0) { tagInput.value = ''; return; }
      state.tags.push(text);
      tagInput.value = '';
      syncTags();
    }

    function removeTag(name) {
      var index = state.tags.indexOf(name);
      if (index < 0) return;
      state.tags.splice(index, 1);
      syncTags();
    }

    /* ---------- 候选 chips ---------- */
    function candidateLabel(candidate) {
      if (!candidate) return '';
      var parts = [];
      var typeLabel = candidate.type === 'income' ? '收入' : (candidate.type === 'transfer' ? '转账' : '支出');
      parts.push(typeLabel);
      if (candidate.cents !== null && candidate.cents !== undefined && candidate.cents > 0) {
        parts.push('¥' + formatMoney(candidate.cents));
      }
      if (candidate.type === 'transfer') {
        var from = accountById(candidate.accountId);
        var to = accountById(candidate.toAccountId);
        parts.push((from ? from.name : '转出账户') + '→' + (to ? to.name : '转入'));
      } else {
        var category = categoryById(candidate.categoryId);
        if (category) parts.push(category.name);
        var account = accountById(candidate.accountId);
        if (account) parts.push(account.name);
      }
      if (candidate.date) parts.push(dates.formatHuman(candidate.date));
      return parts.join(' · ');
    }

    function setCandidates(list, hintText) {
      state.candidates = arr(list).slice(0, 3);
      state.hint = hintText || '';
      nlHint.textContent = state.hint;
      nlHint.classList.toggle('is-ok', state.hint === NL_OK_TEXT);
      nlHint.classList.toggle('is-fail', state.hint === NL_FAIL_TEXT);
      clear(chipsWrap);
      if (!state.candidates.length) {
        chipsWrap.hidden = true;
        return;
      }
      chipsWrap.hidden = false;
      for (var i = 0; i < state.candidates.length; i += 1) {
        (function (candidate, index) {
          var chip = button('s-add-chip');
          chip.setAttribute('data-index', String(index));
          chip.setAttribute('data-kind', String(candidate.type || 'expense'));
          chip.appendChild(make('span', 's-add-chip__text', candidateLabel(candidate)));
          chip.addEventListener('click', function () {
            applyCandidate(candidate);
            setCandidates(state.candidates, NL_OK_TEXT);
            showToast('已按候选回填', { type: 'info' });
          });
          chipsWrap.appendChild(chip);
        }(state.candidates[i], i));
      }
    }

    /* ---------- 回填 ---------- */
    function applyCandidate(candidate) {
      if (!candidate) return;
      var type = TYPE_KEYS.indexOf(candidate.type) >= 0 ? candidate.type : state.type;
      if (!editing) {
        state.type = type;
      }
      if (candidate.cents !== null && candidate.cents !== undefined && candidate.cents > 0) {
        state.amountText = centsToText(candidate.cents);
      }
      if (candidate.accountId && existsIn(accounts, candidate.accountId)) {
        state.accountId = candidate.accountId;
      }
      if (type === 'transfer') {
        if (candidate.toAccountId && existsIn(accounts, candidate.toAccountId) && candidate.toAccountId !== state.accountId) {
          state.toAccountId = candidate.toAccountId;
        } else if (state.toAccountId === state.accountId) {
          state.toAccountId = '';
        }
      } else if (candidate.categoryId) {
        var category = categoryById(candidate.categoryId);
        if (category && category.kind === type) state.categoryId = category.id;
      }
      if (candidate.date && dates.isValidDateStr(candidate.date)) state.date = candidate.date;
      if (typeof candidate.note === 'string' && candidate.note) {
        state.note = candidate.note.slice(0, noteMax);
      }
      if (arr(candidate.tags).length) {
        state.tags = arr(candidate.tags).slice(0, limitedTags.count);
      }
      applyStateToView();
      flashAmount();
    }

    function applyPartial(partial) {
      if (!partial) return;
      if (partial.accountId && existsIn(accounts, partial.accountId)) state.accountId = partial.accountId;
      if (partial.toAccountId && existsIn(accounts, partial.toAccountId) && partial.toAccountId !== state.accountId) {
        state.toAccountId = partial.toAccountId;
      }
      if (partial.categoryId) {
        var category = categoryById(partial.categoryId);
        if (category && category.kind === state.type) state.categoryId = category.id;
      }
      if (partial.date && dates.isValidDateStr(partial.date)) state.date = partial.date;
      if (typeof partial.note === 'string' && partial.note && !state.note) {
        state.note = partial.note.slice(0, noteMax);
      }
      applyStateToView();
    }

    function applyStateToView() {
      syncType();
      syncDate();
      syncNote();
      syncTags();
      syncKeypadValue();
      syncAmount();
      renderGrid();
    }

    function flashAmount() {
      draftAmt.classList.remove('is-flash');
      void draftAmt.offsetWidth;
      draftAmt.classList.add('is-flash');
      global.setTimeout(function () {
        if (!disposed) draftAmt.classList.remove('is-flash');
      }, 320);
    }

    /* ---------- 一句话解析 ----------
     * explicit=true 表示用户按了「解析」/回车：此时才把键盘弹出来（打字过程中不抢焦点）。
     */
    function parseSentence(explicit) {
      var text = String(nlInput.value || '').trim();
      if (!text) { setCandidates([], ''); return; }
      if (!nl || typeof nl.parse !== 'function') {
        setCandidates([], NL_FAIL_TEXT);
        return;
      }
      var result = null;
      try {
        result = nl.parse(text, {
          today: today,
          accounts: allAccounts,
          categories: allCategories,
          books: books,
          currentBookId: bookId
        });
      } catch (error) {
        result = null;
      }
      if (result && result.ok && result.best) {
        applyCandidate(result.best);
        var list = arr(result.candidates).slice(0, 3);
        setCandidates(list, NL_OK_TEXT);
        return;
      }
      if (result && result.partial) {
        applyPartial(result.partial);
        /* SPEC A6：解析失败保留原文到备注（用户不用重打） */
        if (!state.note) {
          state.note = text.slice(0, noteMax);
          syncNote();
        }
        setCandidates([], NL_FAIL_TEXT);
        if (explicit) focusAmount();
        return;
      }
      setCandidates([], NL_FAIL_TEXT);
      if (explicit) focusAmount();
    }

    /* 没听懂金额：把注意力放回金额，直接弹键盘（UI.md §6.4） */
    function focusAmount() {
      pulseAmount();
      openKeypad();
    }

    function scheduleParse() {
      if (parseTimer) global.clearTimeout(parseTimer);
      parseTimer = global.setTimeout(function () {
        parseTimer = 0;
        if (disposed) return;
        parseSentence(false);
      }, 300);
    }

    /* ---------- 键盘 ---------- */
    function ensureKeypad() {
      if (keypadHandle) return keypadHandle;
      var keypad = ui('keypad');
      if (!keypad || typeof keypad.mount !== 'function') return null;
      syncingKeypad = true;
      keypadHandle = keypad.mount(keypadSlot, {
        value: state.amountText,
        cents: amountOf(state.amountText),
        maxIntegerDigits: 9,
        maxDecimals: 2,
        vibrate: true,
        onChange: function (value) {
          if (syncingKeypad) return;
          state.amountText = String(value === null || value === undefined ? '' : value);
          syncAmount();
        },
        onConfirm: function (result) {
          if (result && result.ok) {
            if (keypadHandle && typeof keypadHandle.value === 'function') {
              state.amountText = String(keypadHandle.value() || '');
            }
            syncAmount();
            /* UI.md §6.4：键盘「完成」等同保存；条件不满足时留在键盘里给原因 */
            if (canSave().ok) {
              attemptSave();
            } else {
              showReason(canSave().reason);
              pulseAmount();
            }
            return;
          }
          var code = result && result.code ? result.code : 'E_AMOUNT_EMPTY';
          var text = code === 'E_AMOUNT_ZERO'
            ? messageOf('E_TX_AMOUNT', '金额必须大于 0')
            : (code === 'E_AMOUNT_EMPTY' ? '输入金额' : messageOf(code, '输入金额'));
          showReason(text);
          pulseAmount();
        }
      });
      syncingKeypad = false;
      return keypadHandle;
    }

    function syncKeypadValue() {
      if (!keypadHandle || typeof keypadHandle.setValue !== 'function') return;
      syncingKeypad = true;
      keypadHandle.setValue(state.amountText);
      syncingKeypad = false;
    }

    function openKeypad() {
      if (state.keypadOpen) return;
      var handle = ensureKeypad();
      if (!handle) {
        showToast('数字键盘暂时不可用，可用系统键盘输入', { type: 'warning' });
        return;
      }
      state.keypadOpen = true;
      dock.setAttribute('data-open', '1');
      root.setAttribute('data-keypad', '1');
      syncKeypadValue();
      syncKeypadContext();
      replaceOnType = true;
    }

    function closeKeypad() {
      replaceOnType = false;
      if (!state.keypadOpen) {
        dock.setAttribute('data-open', '0');
        root.setAttribute('data-keypad', '0');
        return;
      }
      state.keypadOpen = false;
      dock.setAttribute('data-open', '0');
      root.setAttribute('data-keypad', '0');
      if (typeof keypadSlot.blur === 'function') keypadSlot.blur();
    }

    /* ---------- 保存 ---------- */
    function buildEntity() {
      var amountCents = amountOf(state.amountText);
      var source = editing && editing.source ? editing.source : 'manual';
      var input = {
        id: editing ? editing.id : undefined,
        bookId: editing && editing.bookId ? editing.bookId : bookId,
        type: state.type,
        amountCents: amountCents,
        accountId: state.accountId,
        toAccountId: state.type === 'transfer' ? state.toAccountId : null,
        categoryId: state.type === 'transfer' ? null : (state.categoryId || null),
        date: state.date,
        time: editing && editing.time ? editing.time : dates.nowTime(),
        note: String(state.note || '').slice(0, noteMax),
        tags: state.tags.slice(0, limitedTags.count),
        source: source,
        reimburse: state.type === 'expense' && state.reimburse ? 'pending' : 'none',
        reimburseAt: state.type === 'expense' && state.reimburse
          ? (editing && editing.reimburseAt ? editing.reimburseAt : dates.nowIso())
          : null,
        recurringId: editing && editing.recurringId ? editing.recurringId : null,
        periodKey: editing && editing.periodKey ? editing.periodKey : null,
        deleted: false
      };
      if (editing && editing.createdAt) input.createdAt = editing.createdAt;
      var entity = schema.createTransaction(input);
      if (editing) {
        entity.id = editing.id;
        entity.createdAt = editing.createdAt;
      }
      var check = schema.validateTransaction(entity, {
        books: books,
        accounts: allAccounts,
        categories: allCategories,
        today: today,
        allowArchived: !!editing
      });
      if (!check || !check.ok) {
        var first = check && check.errors && check.errors.length ? check.errors[0] : null;
        return { ok: false, code: first ? first.code : 'E_SCHEMA_INVALID' };
      }
      return { ok: true, entity: entity };
    }

    function rememberPrefs(entity) {
      var prefs = prefApi();
      if (!prefs || typeof prefs.set !== 'function') return;
      try {
        prefs.set('lastAccountId', entity.accountId);
        if (!entity.categoryId) return;
        var pairs = recentPairs();
        var next = [{ categoryId: entity.categoryId, accountId: entity.accountId || '' }];
        for (var i = 0; i < pairs.length && next.length < RECENT_MAX; i += 1) {
          var same = pairs[i].categoryId === entity.categoryId
            && pairs[i].accountId === (entity.accountId || '');
          if (same) continue;
          next.push(pairs[i]);
        }
        prefs.set('recentPairs', next);
        /* 兼容旧读取方：同时维护只含分类 id 的列表 */
        var ids = [];
        for (var j = 0; j < next.length; j += 1) {
          if (ids.indexOf(next[j].categoryId) < 0) ids.push(next[j].categoryId);
        }
        prefs.set('recentCategories', ids);
      } catch (error) { /* 偏好写入失败不影响记账 */ }
    }

    function goBack() {
      if (typeof context.back === 'function') {
        context.back();
        return;
      }
      if (XZB.router && typeof XZB.router.back === 'function') XZB.router.back();
    }

    function attemptSave() {
      if (state.busy) return;
      var check = canSave();
      if (!check.ok) {
        showReason(check.reason);
        pulseAmount();
        return;
      }
      var built = buildEntity();
      if (!built.ok) {
        showToast(messageOf(built.code), { type: 'danger' });
        return;
      }
      var entity = built.entity;
      var commit = context.commit || (app && app.commit ? app.commit : null);
      var canCommit = typeof commit === 'function';
      if (!canCommit) {
        showToast('保存失败，请重试', { type: 'danger' });
        return;
      }
      state.busy = true;
      syncSaveState();
      commit(function (working) {
        var list = working && working.transactions ? working.transactions : null;
        if (!list) return { abort: true, code: 'E_STORE_TX', message: messageOf('E_STORE_TX') };
        var found = -1;
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].id === entity.id) { found = i; break; }
        }
        if (found >= 0) list[found] = entity;
        else list.push(entity);
        return { value: { id: entity.id } };
      }, { label: editing ? '编辑流水' : '记一笔' }).then(function (result) {
        state.busy = false;
        if (!result || !result.ok) {
          syncSaveState();
          showToast((result && result.message) || messageOf(result && result.code), { type: 'danger' });
          return;
        }
        rememberPrefs(entity);
        showToast('已记一笔', { type: 'success' });
        goBack();
      }, function () {
        state.busy = false;
        if (!disposed) syncSaveState();
        showToast('保存失败，请重试', { type: 'danger' });
      });
    }

    /* ---------- 删除（编辑模式） ---------- */
    function attemptDelete() {
      if (!editing || state.busy) return;
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        doDelete();
        return;
      }
      sheet.open({
        title: '删除这条记录？',
        content: make('p', 's-add-sheet-text', '删除后 5 秒内可以撤销。'),
        actions: [
          { label: '取消', kind: 'default' },
          { label: '删除', kind: 'danger', onClick: doDelete }
        ]
      });
    }

    function doDelete() {
      var commit = context.commit || (app && app.commit ? app.commit : null);
      var canCommit = typeof commit === 'function';
      if (!canCommit) return;
      var nowIso = dates.nowIso();
      var target = editing;
      state.busy = true;
      syncSaveState();
      commit(function (working) {
        var list = working && working.transactions ? working.transactions : null;
        if (!list) return { abort: true, code: 'E_STORE_TX', message: messageOf('E_STORE_TX') };
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].id === target.id) {
            list[i] = schema.normalizeTransaction(assign({}, list[i], {
              deleted: true,
              deletedAt: nowIso,
              updatedAt: nowIso
            }));
            break;
          }
        }
        return { value: { id: target.id } };
      }, { label: '删除流水' }).then(function (result) {
        state.busy = false;
        if (!result || !result.ok) {
          syncSaveState();
          showToast((result && result.message) || messageOf(result && result.code), { type: 'danger' });
          return;
        }
        showToast('已删除', {
          type: 'success',
          action: {
            label: '撤销',
            onClick: function () {
              if (app && typeof app.undo === 'function') app.undo();
            }
          }
        });
        goBack();
      }, function () {
        state.busy = false;
        if (!disposed) syncSaveState();
        showToast('删除失败，请重试', { type: 'danger' });
      });
    }

    /* ============================================================
       事件绑定
       ============================================================ */
    /* 一句话 */
    nlInput.addEventListener('input', scheduleParse);
    nlInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (parseTimer) { global.clearTimeout(parseTimer); parseTimer = 0; }
        parseSentence(true);
      }
    });
    nlInput.addEventListener('focus', function () {
      closeKeypad();
      if (typeof context.setTitle === 'function') context.setTitle('一句话');
    });
    nlInput.addEventListener('blur', function () {
      syncTitle();
    });
    nlBtn.addEventListener('click', function () {
      if (parseTimer) { global.clearTimeout(parseTimer); parseTimer = 0; }
      parseSentence(true);
    });

    /* 分段 */
    for (var s = 0; s < segButtons.length; s += 1) {
      (function (node) {
        node.addEventListener('click', function () {
          setType(node.getAttribute('data-type'));
        });
      }(segButtons[s]));
    }

    /* 摘要条：金额展开键盘、分类开「全部」 */
    draftAmt.addEventListener('click', function () {
      openKeypad();
    });
    draftCat.addEventListener('click', function () {
      openAllCategories();
    });
    kctxCollapse.addEventListener('click', function () {
      closeKeypad();
    });

    /* 属性横滑栏：各 chip 弹对应 sheet */
    accChip.addEventListener('click', function () { openAccountSheet(false); });
    toAccChip.addEventListener('click', function () { openAccountSheet(true); });
    dateChip.addEventListener('click', openCalendar);
    noteChip.addEventListener('click', openNoteSheet);

    /* 补充信息折叠 */
    function setExtrasOpen(open) {
      extrasBlock.setAttribute('data-open', open ? '1' : '0');
      extrasHead.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    extrasHead.addEventListener('click', function () {
      setExtrasOpen(extrasBlock.getAttribute('data-open') !== '1');
    });

    /* 分类宫格：点击选中，长按跳分类管理 */
    grid.addEventListener('pointerdown', function (event) {
      var cell = event.target && event.target.closest ? event.target.closest('[data-category]') : null;
      if (!cell) return;
      holdFired = false;
      if (holdTimer) global.clearTimeout(holdTimer);
      holdTimer = global.setTimeout(function () {
        holdTimer = 0;
        holdFired = true;
        openCategoryManage();
      }, HOLD_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (type) {
      grid.addEventListener(type, function () {
        if (holdTimer) { global.clearTimeout(holdTimer); holdTimer = 0; }
      });
    });
    grid.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (holdFired) { holdFired = false; return; }
      var allCellNode = target.closest('.s-add-cat--all');
      if (allCellNode) {
        openAllCategories();
        return;
      }
      var quickCell = target.closest('.s-add-cat--quick');
      if (quickCell) {
        openQuickItems();
        return;
      }
      var cell = target.closest('[data-category]');
      if (!cell) return;
      setCategory(cell.getAttribute('data-category'));
      openKeypad();
    });

    function openCategoryManage() {
      var kind = state.type === 'income' ? 'income' : 'expense';
      var hash = '#/settings/categories?kind=' + kind;
      if (typeof context.go === 'function') context.go(hash);
      else if (XZB.router && typeof XZB.router.go === 'function') XZB.router.go(hash);
    }

    reimburseSwitch.addEventListener('click', function () {
      state.reimburse = !state.reimburse;
      reimburseSwitch.setAttribute('aria-checked', state.reimburse ? 'true' : 'false');
    });

    /* 标签 */
    tagInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === ',' || event.key === '，') {
        event.preventDefault();
        commitTag(tagInput.value);
        return;
      }
      if (event.key === 'Backspace' && !tagInput.value && state.tags.length) {
        event.preventDefault();
        state.tags.pop();
        syncTags();
      }
    });
    tagInput.addEventListener('input', function () {
      var value = String(tagInput.value || '');
      if (/[\s,，]$/.test(value)) commitTag(value);
    });
    tagInput.addEventListener('blur', function () {
      if (tagInput.value) commitTag(tagInput.value);
    });
    tagWrap.addEventListener('click', function (event) {
      var close = event.target && event.target.closest ? event.target.closest('[data-remove]') : null;
      if (!close) return;
      removeTag(close.getAttribute('data-remove'));
    });

    /* 删除（编辑模式，段控行右侧）；保存由键盘「完成」键承担 */
    delBtn.addEventListener('click', attemptDelete);

    /* 硬件键盘：数字/小数点/退格（与自绘键盘同一份状态） */
    function onKeyDown(event) {
      if (!root.isConnected) { teardown(); return; }
      var target = event.target;
      var tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') return;
      if (!state.keypadOpen) return;
      var key = event.key;
      if (/^[0-9]$/.test(key)) {
        if (replaceOnType) { state.amountText = ''; replaceOnType = false; }
        state.amountText = (state.amountText || '') + key;
        event.preventDefault();
      } else if (key === '.') {
        if (replaceOnType) { state.amountText = ''; replaceOnType = false; }
        if (state.amountText.indexOf('.') < 0) state.amountText = (state.amountText || '0') + '.';
        event.preventDefault();
      } else if (key === 'Backspace') {
        replaceOnType = false;
        state.amountText = String(state.amountText || '').slice(0, -1);
        event.preventDefault();
      } else if (key === 'Escape') {
        closeKeypad();
        return;
      } else {
        return;
      }
      /* 交回组件做 sanitize，再读回真值，避免绕过组件规则 */
      if (keypadHandle && typeof keypadHandle.setValue === 'function') {
        syncingKeypad = true;
        keypadHandle.setValue(state.amountText);
        if (typeof keypadHandle.value === 'function') state.amountText = String(keypadHandle.value() || '');
        syncingKeypad = false;
      }
      syncAmount();
    }
    listen(global.document, 'keydown', onKeyDown);

    /* ============================================================
       首次同步
       ============================================================ */
    if (editing && typeof context.setTitle === 'function') context.setTitle('编辑');
    /* 路由在 callScreen 之后才把新导航栏挂进 DOM，同步设置会被旧的 h1 吃掉 */
    if (typeof global.setTimeout === 'function') {
      global.setTimeout(function () { syncTitle(); }, 0);
    }
    root.setAttribute('data-keypad', '0');
    root.setAttribute('data-kb', '0');
    /* 编辑已有内容（备注/标签/报销）时默认展开补充信息，新建默认折叠 */
    setExtrasOpen(!!(editing && (state.note || state.tags.length || state.reimburse === true)));
    syncType();
    syncDate();
    syncNote();
    syncTags();
    syncAmount();
    syncSaveState();
    /* 键盘常驻：进入页面即展开，键盘就是这个页面的主体 */
    openKeypad();

    listen(global.document, 'visibilitychange', onViewportChange);
  }

  /* ============================================================
     小工具
     ============================================================ */
  function buildUnavailable(text) {
    var box = make('div', 's-add-fallback');
    box.appendChild(iconNode('warning', 32));
    box.appendChild(make('p', 's-add-fallback__text', text || '页面暂时不可用'));
    return box;
  }

  function pickBookId(books, app) {
    var active = app && app.state && app.state.ui ? app.state.ui.activeBookId : null;
    var i;
    for (i = 0; i < books.length; i += 1) {
      if (books[i].id === active && books[i].archived !== true) return books[i].id;
    }
    for (i = 0; i < books.length; i += 1) {
      if (books[i].archived !== true) return books[i].id;
    }
    return books.length ? books[0].id : '';
  }

  function findTransaction(db, id) {
    var list = arr(db && db.transactions);
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id && list[i].deleted !== true) return list[i];
    }
    return null;
  }

  function liveAccounts(accounts) {
    var out = [];
    for (var i = 0; i < accounts.length; i += 1) {
      if (accounts[i] && accounts[i].archived !== true) out.push(accounts[i]);
    }
    return out;
  }

  function liveCategories(categories) {
    var out = [];
    for (var i = 0; i < categories.length; i += 1) {
      if (categories[i] && categories[i].hidden !== true) out.push(categories[i]);
    }
    return out;
  }

  function existsIn(list, id) {
    if (!id) return false;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return true;
    }
    return false;
  }

  function defaultAccountId(accounts, app, settings) {
    if (!accounts.length) return '';
    var last = app && app.state && app.state.ui ? app.state.ui.lastAccountId : null;
    if (last && existsIn(accounts, last)) return last;
    var prefs = app && app.prefs ? app.prefs : null;
    if (prefs && typeof prefs.get === 'function') {
      var stored = prefs.get('lastAccountId', null);
      if (stored && existsIn(accounts, stored)) return stored;
    }
    if (settings && settings.defaultAccountId && existsIn(accounts, settings.defaultAccountId)) {
      return settings.defaultAccountId;
    }
    return accounts[0].id;
  }

  function defaultCategoryId(type, categories, settings) {
    var want = type === 'income'
      ? (settings && settings.defaultIncomeCategoryId)
      : (settings && settings.defaultExpenseCategoryId);
    var i;
    if (want) {
      for (i = 0; i < categories.length; i += 1) {
        if (categories[i].id === want && categories[i].kind === type) return want;
      }
    }
    for (i = 0; i < categories.length; i += 1) {
      if (categories[i].kind === type) return categories[i].id;
    }
    return '';
  }

  /* ============================================================
     注册
     ============================================================ */
  function register() {
    if (!XZB.screens || typeof XZB.screens.register !== 'function') return false;
    return XZB.screens.register('add', {
      title: '记一笔',
      subtitle: '',
      render: render
    });
  }

  if (!register()) {
    /* 极端情况下 router.js 后加载：等 DOM 就绪再注册一次 */
    if (global.document && typeof global.document.addEventListener === 'function') {
      global.document.addEventListener('DOMContentLoaded', function () { register(); }, { once: true });
    }
  }

  XZB.screenAdd = Object.freeze({ render: render, register: register });
}(typeof window !== 'undefined' ? window : this));
