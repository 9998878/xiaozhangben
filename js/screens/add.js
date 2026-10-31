/* 小账本 2.0 · js/screens/add.js · owner: 前端#1（T11 记一笔）
 * 契约锚点：UI.md §6.4（:945-1001 线框与逐项规格）、SPEC A4/A5/A6/A7/A10/A12/A14/A15、
 *           INTERFACE-FREEZE §3（类名归属）§8（十二条红线）、DECISIONS D06/D08/D14/D16。
 *
 * 形状：路由二级页 #/add[?id=<txId>]；root 已是 .app-screen__body.s-add（已清空）。
 * 能力：
 *   1. 三态分段 支出/收入/转账（编辑模式锁定，改类型走 E_TX_TYPE 文案）。
 *   2. 金额区点击唤起 XZB.ui.keypad（复用组件：删/小数点/长按连删/完成全由组件负责），
 *      键盘固定底部 bottom:var(--kb)，页面高度用 --vvh 计算，键盘收起回落。
 *   3. 分类宫格 4 列（按 type 过滤、12 色槽 data-tone），长按或末尾「管理」跳 #/settings。
 *   4. 账户横向 chip（默认上次账户，存 prefs.lastAccountId）；转账变「转出 → 转入」两行，
 *      选同一个给 store.MESSAGES.E_TRANSFER_SAME 中文。
 *   5. 日期：今天/昨天/前天 chip + 自绘月历浮层（不引日历库）。
 *   6. 备注 ≤80 字（LIMITS.txNote）；标签 ≤5 个、每个 ≤10 字（LIMITS.tags/tagLen），退格删。
 *   7. 保存：schema.createTransaction → schema.validateTransaction → XZB.app.commit，
 *      成功 toast「已记一笔」并 back()；?id= 为编辑模式（预填、标题「编辑」、删除按钮）。
 *
 * 2.17.0：原来的「一句话」输入区已移除——它整块搬进了独立的小助手屏（#/assistant），
 * 一句话解析、改账、删账、查账都在那里；本屏只保留手动记账与编辑。
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
    ca_redpacket: 'redpacket', ca_other_income: 'coins',
    /* 2.5 扩充分类（与 schema 种子一一对应；旧库分类 icon 字段优先于此表） */
    ca_daily: 'daily', ca_veggie: 'carrot', ca_fruit: 'fruit', ca_snack: 'snack',
    ca_sports: 'sport', ca_clothes: 'shirt', ca_beauty: 'beauty', ca_household: 'sofa',
    ca_kids: 'baby', ca_elder: 'elder', ca_socialize: 'chat', ca_travel: 'plane',
    ca_smoke: 'glass', ca_digital: 'plug', ca_auto: 'car', ca_pet: 'pet',
    ca_office: 'briefcase', ca_repair: 'hammer', ca_donate: 'heart', ca_lottery: 'ticket',
    ca_game: 'gamepad', ca_tools: 'wrench', ca_appliance: 'washer', ca_family: 'family'
  };
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
  /* -------------- 照片待重试（PLAN §5 quota.enforcement / PLAN §9.4-10）纯函数 --------------
     文案真源唯一 = store.js 的 MESSAGES；表里没有「N 张待重试」的码，按契约不新写文案，
     复用 E_PHOTO_WRITE 并把 pending 张数作为数字拼在前面（不产生任何孤立数字）。
     pendingRetryOutcome 只读 app.js:1530 photosRetryPending 的真实返回结构：
       全部成功 → {ok:true, ids:[…]}；任一失败（含部分成功）→ photoFail 的
       {ok:false, code, message, retryable:true}（没有 partial 字段，剩余张数只能靠
       photosPendingCount 的 {ok:true, count} 复核）。 */
  function pendingRetryText(count) {
    var n = typeof count === 'number' && count > 0 ? Math.round(count) : 0;
    var base = messageOf('E_PHOTO_WRITE');
    return n > 0 ? String(n) + ' 张 · ' + base : base;
  }
  function pendingRetryOutcome(result) {
    if (result && result.ok === true && arr(result.ids).length > 0) return 'done';
    return 'retry';
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

  /* ---------------- 照片：纯函数接缝 ----------------
   * PLAN §1.5 裁决 14（编辑态合并）+ §3 数据流 7/9/10/14（保存顺序与补偿决策）。
   * 无 DOM、无存储、无副作用：Node 自检（tools/_t19_selfcheck.cjs）经 XZB.screenAdd.__test 直调，
   * 与 XZB.Core.photos.__test 同一范式。 */
  var PHOTO_LIMIT = 999;                  /* schema.LIMITS.txPhotos 的兜底值（2.13.0 起不限张数） */
  var PHOTO_ID_RE = /^ph_[a-z0-9_]{3,20}$/;  /* schema.js:29 前缀表 + PLAN §2 pattern 同值 */
  var PHOTO_UA_WECHAT = /MicroMessenger/i;

  function photoLimit() {
    var schema = core('schema');
    var limits = schema && schema.LIMITS ? schema.LIMITS : null;
    return limits && limits.txPhotos ? limits.txPhotos : PHOTO_LIMIT;
  }
  function isPhotoId(value) {
    return typeof value === 'string' && PHOTO_ID_RE.test(value);
  }
  /* 非法项剔除、去重、保持原序 */
  function cleanPhotoIds(list) {
    var out = [];
    if (!list || typeof list.length !== 'number') return out;
    for (var i = 0; i < list.length; i += 1) {
      var id = list[i];
      if (!isPhotoId(id) || out.indexOf(id) >= 0) continue;
      out.push(id);
    }
    return out;
  }
  /* 裁决 14：最终 photoIds = 既有未移除项（原序在前）∪ 新增项（选择顺序在后），去重、截断到 3。
   * 新建场景 existingIds/removedIds 均为空 ⇒ 结果即新增项原序。 */
  function mergePhotoIds(input) {
    var o = input || {};
    var limit = typeof o.limit === 'number' && o.limit > 0 ? o.limit : photoLimit();
    var removed = cleanPhotoIds(o.removedIds);
    var seen = {};
    var out = [];
    var i;
    var kept = cleanPhotoIds(o.existingIds);
    for (i = 0; i < kept.length; i += 1) {
      if (removed.indexOf(kept[i]) >= 0 || seen[kept[i]]) continue;
      seen[kept[i]] = true;
      out.push(kept[i]);
    }
    var added = cleanPhotoIds(o.pendingIds);
    for (i = 0; i < added.length; i += 1) {
      if (removed.indexOf(added[i]) >= 0 || seen[added[i]]) continue;
      seen[added[i]] = true;
      out.push(added[i]);
    }
    return out.slice(0, limit);
  }
  /* 被移除的既有项 = 既有引用 −（仍在草稿里的既有项），保持既有原序 */
  function removedExistingIds(existingIds, keptExistingIds) {
    var kept = cleanPhotoIds(keptExistingIds);
    var all = cleanPhotoIds(existingIds);
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      if (kept.indexOf(all[i]) < 0) out.push(all[i]);
    }
    return out;
  }
  /* 补偿决策（数据流 10）：commit 未成功 ⇒ 二进制写在其后、一张都没写（本次写入集合恒为空）
   * ⇒ 需要清理的孤儿集合 = 实际写入集合；commit 成功 ⇒ 无孤儿可清。 */
  function orphanPurgeOfSave(input) {
    var o = input || {};
    if (o.commitOk) return [];
    return cleanPhotoIds(o.writtenIds);
  }
  /* 保存三段决策（顺序不可颠倒：数据流 7 写引用 → 8 写二进制 → 9 失败补偿 → 14 commit 成功后才物理删被移除项） */
  function photoSavePlan(input) {
    var o = input || {};
    var prev = cleanPhotoIds(o.prevIds);
    if (!o.commitOk) {
      return {
        phase: 'commit-failed', writeBinaries: false, restoreIds: null, purgeIds: [], keepPending: false
      };
    }
    if (!o.attachOk) {
      return {
        phase: 'attach-failed', writeBinaries: true, restoreIds: prev, purgeIds: [], keepPending: true
      };
    }
    return {
      phase: 'ok', writeBinaries: true, restoreIds: null, purgeIds: cleanPhotoIds(o.removedIds), keepPending: false
    };
  }
  /* 安卓微信里带 capture 的 input 会退化成文件系统入口（连相机都进不去）⇒ 引导「从相册选择」 */
  function isCameraRisky(input) {
    var o = input || {};
    var ua = typeof o.ua === 'string' ? o.ua : '';
    if (!PHOTO_UA_WECHAT.test(ua)) return false;
    return /Android/i.test(ua);
  }

  /* 载荷里的既有引用（原序、去重、截断到上限）—— 纯函数，屏内与 Node 自检共用 */
  function payloadPhotoIds(tx) {
    if (!tx) return [];
    return cleanPhotoIds(arr(tx.photoIds)).slice(0, photoLimit());
  }
  /* 确认悬空的既有引用（photoGetMany 的 null 位、已落定）：SPEC A30 要求保存侧自愈剔除。
     注意「读取整体失败」不算悬空 —— 那时无法断定记录是否存在，照旧保留引用。 */
  function danglingExistingIds(items) {
    var list = items || [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var it = list[i];
      if (it && it.existing && !it.removed && it.missing === true && isPhotoId(it.id)) out.push(it.id);
    }
    return cleanPhotoIds(out);
  }
  /* 原序引用里剔除悬空项（自愈），供 commit / attach 两处取同一口径 */
  function selfHealedExistingIds(tx, items) {
    var dangling = danglingExistingIds(items);
    var src = payloadPhotoIds(tx);
    var out = [];
    for (var i = 0; i < src.length; i += 1) {
      if (dangling.indexOf(src[i]) < 0) out.push(src[i]);
    }
    return out;
  }

  /* 只读测试接缝（纯函数、无副作用）：Node 自检 tools/_t19_selfcheck.cjs 经 XZB.screenAdd.__test 直调
     （与 XZB.Core.photos.__test 同一范式）。业务代码不得依赖。 */
  var __test = Object.freeze({
    photoLimit: photoLimit,
    isPhotoId: isPhotoId,
    cleanPhotoIds: cleanPhotoIds,
    mergePhotoIds: mergePhotoIds,
    removedExistingIds: removedExistingIds,
    orphanPurgeOfSave: orphanPurgeOfSave,
    photoSavePlan: photoSavePlan,
    isCameraRisky: isCameraRisky,
    payloadPhotoIds: payloadPhotoIds,
    danglingExistingIds: danglingExistingIds,
    selfHealedExistingIds: selfHealedExistingIds,
    pendingRetryText: pendingRetryText,
    pendingRetryOutcome: pendingRetryOutcome
  });

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
  /* 分类着色：与首页、明细、统计共用 kit.categoryTone —— 同一分类在哪都是同一个色槽。
   * kit 缺失时退化成「按 id 稳定哈希」，绝不再用列表下标。 */
  function toneOf(category) {
    var kit = ui('kit');
    if (kit && typeof kit.categoryTone === 'function') {
      return kit.categoryTone(category);
    }
    var text = String((category && category.id) || '');
    var hash = 0;
    for (var i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 100000007;
    }
    return (hash % 12) + 1;
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
      /* 照片：屏内草稿（数据流 5）。既有项与新增项同放这里，既有在前、新增在后（裁决 14）。
         唯一实现名 pendingPhotos（PLAN 裁决 11/13；UI.md 旧文的 state.photos 是笔误）。 */
      pendingPhotos: []
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

    /* ---------- 照片预载（数据流 5b：重入编辑页先重置为空，再按 tx.photoIds 原序预载） ---------- */
    preloadExistingPhotos();

    /* ---------- DOM 骨架 ---------- */
    var wrap = make('div', 's-add-inner');
    root.appendChild(wrap);

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

    /* ---------- 照片块（数据流 1：两个入口 + 预览条） ----------
       两个取照 input 都必须常驻 DOM：①带 capture 的拍照入口 ②同形状但无 capture 的相册入口
       （安卓微信里带 capture 会退化成文件系统、连相机都进不去，相册入口是兼容性必需）。
       一律 <input type="file">，禁用 getUserMedia（阶段 4 才做）。 */
    var photoBlock = make('div', 's-add-photos');
    photoBlock.setAttribute('data-count', '0');
    var photoHead = button('s-add-photos__head', '', '添加照片');
    photoHead.setAttribute('data-act', 'sheet');
    photoHead.appendChild(make('span', 's-add-photos__label', '照片'));
    photoHead.appendChild(make('span', 's-add-photos__hint', '拍照或从相册选择'));
    photoBlock.appendChild(photoHead);

    var photoCameraInput = make('input', 's-add-photos__file');
    photoCameraInput.type = 'file';
    photoCameraInput.setAttribute('accept', 'image/*');
    photoCameraInput.setAttribute('capture', 'environment');   /* 拍照入口：capture="environment" */
    photoCameraInput.id = 'xzb-photo-camera';
    /* iOS/WebKit 实测：带 hidden / display:none 的 file input 用 .click() 打不开系统相机。
       必须留在渲染树里（1px、opacity:0），由 <label for> 原生激活。 */
    photoCameraInput.setAttribute('aria-hidden', 'true');
    photoCameraInput.setAttribute('tabindex', '-1');
    /* label 是隐藏 input 的受支持触发面（§3 数据流 1 的形状），js 触发放同一入口上 */
    var photoCameraLabel = make('label', 's-add-photos__pick');
    photoCameraLabel.appendChild(photoCameraInput);
    photoBlock.appendChild(photoCameraLabel);

    var photoAlbumInput = make('input', 's-add-photos__file');
    photoAlbumInput.type = 'file';
    photoAlbumInput.setAttribute('accept', 'image/*');
    photoAlbumInput.setAttribute('multiple', 'multiple');
    photoAlbumInput.id = 'xzb-photo-album';
    photoAlbumInput.setAttribute('aria-hidden', 'true');
    photoAlbumInput.setAttribute('tabindex', '-1');
    /* 无 capture 的相册入口：与上面同形状，但绝不带 capture */
    var photoAlbumLabel = make('label', 's-add-photos__pick');
    photoAlbumLabel.appendChild(photoAlbumInput);
    photoBlock.appendChild(photoAlbumLabel);

    var photoEmptyRow = button('s-add-photos__empty', '', '添加照片');
    photoEmptyRow.setAttribute('data-act', 'sheet');
    photoEmptyRow.setAttribute('data-role', 'empty');
    photoEmptyRow.appendChild(iconNode('camera', 24));
    photoEmptyRow.appendChild(make('span', 's-add-photos__empty-main', '添加照片'));
    photoEmptyRow.appendChild(make('span', 's-add-photos__empty-sub', '拍照或从相册选择，张数不限'));
    photoBlock.appendChild(photoEmptyRow);

    var photoGroupEl = make('div', 's-add-photos__group');
    photoGroupEl.setAttribute('role', 'group');
    photoGroupEl.setAttribute('aria-label', '照片，张数不限');
    var photoGridEl = make('div', 's-add-photos__grid');
    photoGroupEl.appendChild(photoGridEl);
    photoBlock.appendChild(photoGroupEl);
    photoGroupEl.hidden = true;

    /* 照片写失败（PLAN §5 quota.enforcement）时的「重试」入口：整行可点（命中≥44 由既有样式保证），
       样式全部复用既有类名（s-add-photos__empty / __empty-main / __empty-sub + 既有 warning 图标），
       不新增任何 CSS 类。默认隐藏，只有本屏 attach 失败或内存里还留着 pending 时由
       paintPendingRetryRow() 显示；不带 .s-add-photos__cell / .s-add-photos__del，故不干扰格子交互。 */
    var photoRetryRow = button('s-add-photos__empty', '', '重试保存照片');
    photoRetryRow.setAttribute('data-act', 'retry-pending');
    photoRetryRow.setAttribute('data-role', 'photo-retry');
    photoRetryRow.appendChild(iconNode('warning', 20));
    photoRetryRow.appendChild(make('span', 's-add-photos__empty-main', '重试'));
    var photoRetrySub = make('span', 's-add-photos__empty-sub', '');
    photoRetryRow.appendChild(photoRetrySub);
    photoBlock.appendChild(photoRetryRow);
    photoRetryRow.hidden = true;

    var photoAddCell = button('s-add-photos__add', '', '添加照片');
    photoAddCell.setAttribute('data-act', 'add');
    photoAddCell.appendChild(iconNode('camera', 24));
    photoAddCell.appendChild(make('span', '', '添加'));
    /* 第 4 格由 paintPhotoStrip 追加进宫格（clear 后重挂，不产生副本） */

    var photoMetaEl = make('div', 's-add-photos__meta');
    photoMetaEl.setAttribute('aria-live', 'polite');
    photoBlock.appendChild(photoMetaEl);

    /* 补充信息：备注 / 报销 / 标签收进折叠区，不抢主流程 */
    var extrasBlock = make('div', 's-add-extras');
    extrasBlock.setAttribute('data-open', '0');
    var extrasHead = button('s-add-extras__head', '');
    extrasHead.setAttribute('aria-expanded', 'false');
    extrasHead.appendChild(make('span', 's-add-extras__title', '补充信息'));
    extrasHead.appendChild(make('span', 's-add-extras__sub', '备注 · 标签 · 报销'));
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
    /* 照片入口并入「备注」弹层（2026-10-27 用户要求：把拍照放进备注里面）。
       photoBlock 只在构建期创建一次，打开备注时 appendChild 移动进去（移动不产生副本），
       关闭后节点仍留在弹层 DOM 里，下次打开被重新移动复用。 */
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
    /* 转账方向纠错：把转出/转入一键交换（仅转账时出现） */
    var swapBtn = button('s-add-swap', '', '交换转出与转入账户');
    swapBtn.appendChild(iconNode('transfer', 20));
    swapBtn.hidden = true;
    var toAccChip = propChip('s-add-props__chip', '选择转入账户');
    toAccChip.hidden = true;
    var dateChip = propChip('s-add-props__chip', '选择日期');
    var noteChip = propChip('s-add-props__chip s-add-props__chip--note', '添加备注');
    propsRow.appendChild(accChip);
    propsRow.appendChild(swapBtn);
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
      if (holdTimer) { global.clearTimeout(holdTimer); holdTimer = 0; }
      if (reasonTimer) { global.clearTimeout(reasonTimer); reasonTimer = 0; }
      if (photoMetaTimer) { global.clearTimeout(photoMetaTimer); photoMetaTimer = 0; }
      /* 屏内草稿随屏销毁；二进制已落库的留给 photos store（未落库的随引用一起被 GC）。
         blob URL 一律不在这里 revoke：唯一 revoke 时机是路由销毁 XZB.UI.bloburl.releaseAll（数据流 19）。 */
      photoQueue.length = 0;
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

    /* 读主题恒定 token 的字符串值（分类色要写回 DB，必须是固定色值） */
    function readTokenText(name) {
      try {
        return String(global.getComputedStyle(global.document.documentElement).getPropertyValue(name) || '').trim();
      } catch (error) {
        return '';
      }
    }

    /* 已有金额（如从编辑页带入 28.00）时，第一次按数字/小数点直接覆盖：
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
      paintPhotoConfirm();
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
      swapBtn.hidden = !isTransfer;
      if (isTransfer) {
        var to = accountById(state.toAccountId);
        setChipLabel(toAccChip, '转入 ' + (to ? to.name : '选账户'));
      }
      setChipLabel(dateChip, dates.formatHuman(state.date));
      var noteText = String(state.note || '');
      var photoCount = livePhotoItems().length;
      var chipText;
      if (noteText) {
        chipText = '备注 ' + noteText.slice(0, 6) + (noteText.length > 6 ? '…' : '');
      } else if (photoCount > 0) {
        chipText = '照片 ' + photoCount + ' 张';
      } else {
        chipText = '备注…';
      }
      if (noteText && photoCount > 0) { chipText += ' ·' + photoCount + '图'; }
      setChipLabel(noteChip, chipText);
      noteChip.classList.toggle('is-set', !!noteText || photoCount > 0);
      noteChip.setAttribute('aria-label', photoCount > 0
        ? '备注与照片，已选 ' + photoCount + ' 张'
        : '添加备注');
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

    /* 交换转出/转入：用户一键纠正方向（README 记为用户可见纠错路径） */
    function swapAccounts() {
      if (state.type !== 'transfer') return;
      var temp = state.accountId;
      state.accountId = state.toAccountId;
      state.toAccountId = temp;
      swapBtn.classList.remove('is-swap');
      void swapBtn.offsetWidth;
      swapBtn.classList.add('is-swap');
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
      /* 颜色跟分类走，不跟位置走：同屏顺序变了也不会串色 */
      cell.setAttribute('data-tone', String(toneOf(category)));
      /* 选分类是这一屏最重的动作，震动比普通按钮重一档 */
      cell.setAttribute('data-haptic', 'select');
      cell.setAttribute('aria-pressed', 'false');
      var ico = make('span', 's-add-cat__ico');
      ico.appendChild(iconNode(category.icon || CAT_ICON[category.id] || 'tag', 26));
      var badge = make('span', 's-add-cat__badge');
      badge.setAttribute('aria-hidden', 'true');
      badge.appendChild(iconNode('check', 12));
      ico.appendChild(badge);
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
        cell.setAttribute('data-tone', String(toneOf(category)));
        cell.setAttribute('data-haptic', 'select');
        cell.setAttribute('aria-label', '选择分类 ' + (category.name || ''));
        var ico = make('span', 's-add-cat__ico');
        ico.appendChild(iconNode(category.icon || CAT_ICON[category.id] || 'tag', 24));
        var badge = make('span', 's-add-cat__badge');
        badge.setAttribute('aria-hidden', 'true');
        badge.appendChild(iconNode('check', 11));
        ico.appendChild(badge);
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

      /* 日期快捷档位：今天/昨天/前天。sheet 页脚不再重复同样三个按钮，快捷入口只有一个 */
      var QUICK_DATES = [['今天', 0], ['昨天', -1], ['前天', -2]];

      function paint() {
        clear(holder);
        var quick = make('div', 's-add-date__chips');
        quick.setAttribute('role', 'group');
        quick.setAttribute('aria-label', '日期快捷');
        for (var qi = 0; qi < QUICK_DATES.length; qi += 1) {
          var quickDate = dates.addDays(today, QUICK_DATES[qi][1]);
          var quickChip = button('s-add-date__chip', QUICK_DATES[qi][0]);
          quickChip.setAttribute('data-offset', String(QUICK_DATES[qi][1]));
          if (quickDate === state.date) {
            quickChip.classList.add('is-active');
            quickChip.setAttribute('aria-pressed', 'true');
          } else {
            quickChip.setAttribute('aria-pressed', 'false');
          }
          quick.appendChild(quickChip);
        }
        holder.appendChild(quick);
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
        var quickChip = target.closest('.s-add-date__chip');
        if (quickChip) {
          setDate(dates.addDays(today, Number(quickChip.getAttribute('data-offset')) || 0));
          sheet.close('pick');
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
          { label: '取消', kind: 'default' }
        ]
      });
    }

    /* ---------- 自定义分类（宫格「自定义」格的面板） ----------
     * 在这里新建的分类永久挂在宫格末尾（maxSort+10），以后记账直接点它。
     * 删除沿用设置页的 applyCategoryDelete：存量流水自动归到「其他」。
     */
    /* ---------- 自定义分类（宫格「管理」格的面板） ----------
     * 在这里新建的分类永久挂在宫格末尾（maxSort+10），以后记账直接点它。
     * 删除沿用设置页的 applyCategoryDelete：存量流水自动归到「其他」。
     *
     * 2.6：图标候选换成专属库（8 组 × 12 枚，与系统分类零交集），
     * 选择器与设置页共用 XZB.ui.iconPicker；颜色也给用户自己选，不再自动轮换。
     */
    /* 分类色写回 DB 必须是固定值（读 --cat-N 会随主题翻转，深色下保存一次就漂色），
       所以这里只列主题恒定 token 名，色值的单一真源在 tokens.css 的 --cat-raw-1..12 */
    var CAT_PALETTE = ['--cat-raw-1', '--cat-raw-2', '--cat-raw-3', '--cat-raw-4', '--cat-raw-5', '--cat-raw-6',
      '--cat-raw-7', '--cat-raw-8', '--cat-raw-9', '--cat-raw-10', '--cat-raw-11', '--cat-raw-12'];
    /* 色板档位类名：与 add.css 的 .s-add-quick__swatch--N 一一对应，逐字列出，
       便于「JS 用到的类都在 CSS 里定义」这条静态自检逐名核对 */
    var TONE_CLASSES = ['s-add-quick__swatch--1', 's-add-quick__swatch--2', 's-add-quick__swatch--3',
      's-add-quick__swatch--4', 's-add-quick__swatch--5', 's-add-quick__swatch--6',
      's-add-quick__swatch--7', 's-add-quick__swatch--8', 's-add-quick__swatch--9',
      's-add-quick__swatch--10', 's-add-quick__swatch--11', 's-add-quick__swatch--12'];
    var TONE_LABELS = ['橙', '蓝', '粉', '青', '紫', '红', '蓝绿', '金', '湖蓝', '绿', '靛', '灰'];
    var RECENT_ICON_PREF = 'recentCategoryIcons';

    function iconPickerApi() {
      return ui('iconPicker');
    }

    function recentIcons() {
      var prefs = prefApi();
      if (!prefs || typeof prefs.get !== 'function') return [];
      return arr(prefs.get(RECENT_ICON_PREF, [])).map(function (key) {
        return String(key);
      });
    }

    function rememberIcon(key) {
      var prefs = prefApi();
      if (!prefs || typeof prefs.set !== 'function') return;
      var list = recentIcons().filter(function (item) { return item !== key; });
      list.unshift(String(key));
      prefs.set(RECENT_ICON_PREF, list.slice(0, 12));
    }

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
      var holder = make('div', 's-add-quick');

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
          holder.appendChild(make('p', 's-add-quick__empty',
            '还没有自定义分类。建一个（比如「烟钱」「猫粮」），它会一直留在宫格最后，以后直接点它记账。'));
        } else {
          var list = make('div', 's-add-quick__list');
          for (var j = 0; j < customs.length; j += 1) {
            list.appendChild(customRow(customs[j]));
          }
          holder.appendChild(list);
        }
        var newBtn = button('c-btn c-btn--primary c-btn--block s-add-quick__new', '＋ 新建分类');
        newBtn.addEventListener('click', function () { paintForm(); });
        holder.appendChild(newBtn);
        holder.appendChild(make('p', 's-add-quick__hint', '新建的分类固定排在宫格最后，记账时直接点图标就行。'));
      }

      function customRow(category) {
        var row = make('div', 's-add-quick__row');
        var tile = make('span', 'c-tile c-tile--lg');
        tile.classList.add('c-tile--cat-' + toneOf(category));
        tile.appendChild(iconNode(category.icon || 'tag', 22));
        row.appendChild(tile);
        var main = make('span', 's-add-quick__main');
        main.appendChild(make('span', 's-add-quick__name', category.name || '未命名'));
        main.appendChild(make('span', 's-add-quick__meta', category.kind === 'income' ? '收入分类' : '支出分类'));
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
        var picker = iconPickerApi();
        var draft = {
          name: '',
          icon: '',
          kind: state.type === 'income' ? 'income' : 'expense',
          tone: state.type === 'income' ? 10 : 1
        };
        var KINDS = [['expense', '支出分类'], ['income', '收入分类']];

        function defaultIcon(kind) {
          var group = picker && picker.recommend ? picker.recommend[kind] : [];
          return (group && group[0]) || 'food';
        }
        draft.icon = defaultIcon(draft.kind);

        var kindRow = make('div', 's-add-quick__chips');
        holder.appendChild(kindRow);
        function paintKindChips() {
          clear(kindRow);
          for (var k = 0; k < KINDS.length; k += 1) {
            (function (pair) {
              var chip = button('c-chip' + (draft.kind === pair[0] ? ' is-active' : ''), pair[1]);
              chip.addEventListener('click', function () {
                if (draft.kind === pair[0]) return;
                draft.kind = pair[0];
                paintKindChips();
                remountPicker();
              });
              kindRow.appendChild(chip);
            }(KINDS[k]));
          }
        }
        paintKindChips();

        holder.appendChild(make('span', 's-add-quick__label', '名称'));
        var nameInput = make('input', 's-add-quick__input');
        nameInput.type = 'text';
        nameInput.maxLength = 8;
        nameInput.placeholder = '例如：烟钱、猫粮、奶茶';
        nameInput.setAttribute('enterkeyhint', 'done');
        holder.appendChild(nameInput);

        holder.appendChild(make('span', 's-add-quick__label', '图标'));
        var pickerHost = make('div', 's-add-quick__picker');
        holder.appendChild(pickerHost);
        var pickerCtl = null;
        function remountPicker() {
          clear(pickerHost);
          pickerCtl = null;
          if (!picker) { return; }
          pickerCtl = picker.mount(pickerHost, {
            value: draft.icon,
            kind: draft.kind,
            recents: recentIcons(),
            onPick: function (key) { draft.icon = key; },
            onRecent: function (key) { rememberIcon(key); }
          });
        }
        remountPicker();

        holder.appendChild(make('span', 's-add-quick__label', '颜色'));
        var swatchRow = make('div', 's-add-quick__swatches');
        holder.appendChild(swatchRow);
        function paintSwatches() {
          clear(swatchRow);
          for (var i = 0; i < CAT_PALETTE.length; i += 1) {
            (function (index) {
              var tone = index + 1;
              var dot = button('s-add-quick__swatch' + (draft.tone === tone ? ' is-active' : ''));
              if (TONE_CLASSES[index]) dot.classList.add(TONE_CLASSES[index]);
              dot.setAttribute('aria-label', '颜色 ' + (TONE_LABELS[index] || tone));
              dot.setAttribute('aria-pressed', draft.tone === tone ? 'true' : 'false');
              dot.addEventListener('click', function () {
                draft.tone = tone;
                paintSwatches();
              });
              swatchRow.appendChild(dot);
            }(i));
          }
        }
        paintSwatches();

        var saveBtn = button('c-btn c-btn--primary c-btn--block s-add-quick__new', '创建分类');
        saveBtn.addEventListener('click', createCategory);
        holder.appendChild(saveBtn);

        function createCategory() {
          var name = String(nameInput.value || '').trim().slice(0, 8);
          if (!name) {
            showToast('先给分类起个名字', { type: 'warning' });
            return;
          }
          var icon = (pickerCtl && pickerCtl.value && pickerCtl.value()) || draft.icon;
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
            var created = schema.createCategory({
              kind: draft.kind,
              name: name,
              icon: icon,
              color: readTokenText(CAT_PALETTE[draft.tone - 1]) || readTokenText(CAT_PALETTE[0]),
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
            rememberIcon(icon);
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
      /* 照片并入备注弹层：同一个 sheet 里既写备注也加图（用户 2026-10-27 要求）。
         photoBlock 是构建期就建好的活节点，这里 appendChild 是移动，监听器与状态全部沿用。 */
      var photoSection = make('div', 's-add-notesheet__photos');
      photoSection.appendChild(make('span', 's-add-notesheet__photos-title', '照片 · 张数不限'));
      /* 取照入口直接常驻在备注弹层里：只有 label[for] 才能真正触发 iOS 的系统选择器；
         不再用「添加照片」二次浮层（第二个 sheet 会把当前备注弹层顶掉，真机上等于点不动）。 */
      photoBlock.classList.add('s-add-photos--embedded');
      var picks = make('div', 's-add-notesheet__picks');
      var camPick = make('label', 's-add-notesheet__pick');
      camPick.setAttribute('for', 'xzb-photo-camera');
      camPick.appendChild(iconNode('camera', 20));
      camPick.appendChild(make('span', 's-add-notesheet__pick-text', '拍照'));
      var albPick = make('label', 's-add-notesheet__pick');
      albPick.setAttribute('for', 'xzb-photo-album');
      albPick.appendChild(iconNode('image', 20));
      albPick.appendChild(make('span', 's-add-notesheet__pick-text', '从相册选择'));
      picks.appendChild(camPick);
      picks.appendChild(albPick);
      photoSection.appendChild(picks);
      photoSection.appendChild(photoBlock);
      holder.appendChild(photoSection);
      paintPhotoStrip();
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

    function applyStateToView() {
      syncType();
      syncDate();
      syncNote();
      syncTags();
      syncKeypadValue();
      syncAmount();
      renderGrid();
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

    /* ============================================================
       照片块接线（PLAN §3 数据流 1/2/4/5/5b/6/7/8/9/10/14；UI.md §2.1–§2.3）
       - 屏内暂存 state.pendingPhotos（既有项在前、新增项在后）；二进制只进 photos objectStore，
         且只经 XZB.app.photos 门面读写（屏幕层不碰 XZB.Core.store.*，也不碰 indexedDB）。
       - 保存顺序不可颠倒（§1.5 裁决 3）：commit 写引用 → attach 写二进制并追加引用 →
         任一步失败由门面补偿（还原 photoIds / 物理回滚二进制），整笔记账照常成功。
       - blob URL 只在 XZB.UI.bloburl 注册表创建；revoke 的唯一时机是路由销毁 releaseAll（数据流 19），
         屏幕层不自行 revoke —— 组件卸载即 revoke 会让来回切页白图（§2.6 已否决）。
       ============================================================ */
    var photoSeq;                /* 只声明不赋值：:420 的 preloadExistingPhotos() 早于本行执行，在此赋 0 会重置已用序号；初始化见 nativePhotoId()（D-1417） */
    var photoQueue = [];        /* 串行压缩队列：同刻只跑一张（PH-PERF-4） */
    var photoWorking = false;
    var photoMetaTimer = 0;
    /* 照片待重试入口的状态：都是本屏闭包内的临时标记，不落库、不跨页（pending 本身只活在
       XZB.app.photos 的内存里，见 app.js:1098） */
    var pendingRetryCount = 0;      /* 文案里的数字：本屏失败批次张数，或 pendingCount() 的读数 */
    var pendingRetryBusy = false;   /* 重试在途：连点不重复触发 */
    var committedId = '';           /* 本屏已提交成功的流水 id（非编辑模式防重复建账的护栏） */

    function photoStore() {
      return core('photos');
    }
    function photoFacade() {
      /* PLAN §9.4-3：屏幕层只经 XZB.app.photos 门面读写（不碰 XZB.Core.store.*、不碰 indexedDB） */
      var app = appApi();
      var api = app && app.photos ? app.photos : null;
      return api && typeof api.attach === 'function' ? api : null;
    }
    function livePhotoItems() {
      var out = [];
      for (var i = 0; i < state.pendingPhotos.length; i += 1) {
        if (!state.pendingPhotos[i].removed) out.push(state.pendingPhotos[i]);
      }
      return out;
    }
    function photoItemByKey(key) {
      for (var i = 0; i < state.pendingPhotos.length; i += 1) {
        if (state.pendingPhotos[i].key === key) return state.pendingPhotos[i];
      }
      return null;
    }
    function photoItemById(id) {
      for (var i = 0; i < state.pendingPhotos.length; i += 1) {
        if (state.pendingPhotos[i].id === id) return state.pendingPhotos[i];
      }
      return null;
    }
    /* 等待/处理中的格子不算可保存：commit 前必须让引用集合稳定（UI.md §2.3 面 2） */
    function photoBusy() {
      var list = livePhotoItems();
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].phase === 'wait' || list[i].phase === 'busy') return true;
      }
      return false;
    }
    function keptExistingIds() {
      var out = [];
      for (var i = 0; i < state.pendingPhotos.length; i += 1) {
        var it = state.pendingPhotos[i];
        if (it.existing && !it.removed && isPhotoId(it.id)) out.push(it.id);
      }
      return cleanPhotoIds(out);
    }
    function pendingItemIds() {
      var out = [];
      for (var i = 0; i < state.pendingPhotos.length; i += 1) {
        var it = state.pendingPhotos[i];
        if (!it.existing && !it.removed && isPhotoId(it.id)) out.push(it.id);
      }
      return cleanPhotoIds(out);
    }
    function removedPhotoIds() {
      return removedExistingIds(payloadPhotoIds(editing), keptExistingIds());
    }
    /* 写进交易的引用（裁决 14 前半段：既有未移除项，原序、去重、截断到上限；
       SPEC A30：已确认悬空的引用在写入侧自愈剔除，不写回） */
    function mergedExistingIds() {
      return mergePhotoIds({
        existingIds: selfHealedExistingIds(editing, state.pendingPhotos),
        removedIds: removedPhotoIds(),
        pendingIds: [],
        limit: photoLimit()
      });
    }
    /* 本次保存后的最终引用（含新增项；attach 会把它们按序追加，同一口径可自检） */
    function finalPhotoIds() {
      return mergePhotoIds({
        existingIds: selfHealedExistingIds(editing, state.pendingPhotos),
        removedIds: removedPhotoIds(),
        pendingIds: pendingItemIds(),
        limit: photoLimit()
      });
    }
    /* 预览条用**缩略图** URL。键必须是 `${photoId}:thumb`：同一张照片的「缩略图」与「原图」
       是两个不同的 blob URL 键。若两者共用 item.id，bloburl 的「同一 id 恒返回同一 URL」
       会让查看器拿到预览条先注册的那张 320px 缩略图 —— 点开大图就是糊的小图（真机实测的
       「点击照片不是全屏打开 / 画质太低」根因）。add.js 从不单独 revoke，路由销毁 releaseAll 全清。 */
    /* 键只由 ui/blob-url.js 的 thumbKey / fullKey 构造（本文件不定义后缀表，也不拿裸 id 当键）。 */
    function photoUrlOf(item) {
      var bloburl = ui('bloburl');
      if (!item || !isPhotoId(item.id)) return '';
      if (!bloburl || typeof bloburl.urlOf !== 'function') return '';
      if (typeof bloburl.thumbKey !== 'function') return '';
      var blob = item.thumbBlob || item.fullBlob;
      return blob ? bloburl.urlOf(bloburl.thumbKey(item.id), blob) : '';
    }
    /* 全屏查看器用**原图** URL（`${photoId}:full`）：keepOriginal 下 fullBlob === 手机相册原始文件，
       零重编码 ⇒ 放到全屏也是相册原画质，绝不用缩略图放大冒充。 */
    function photoFullUrlOf(item) {
      var bloburl = ui('bloburl');
      if (!item || !isPhotoId(item.id)) return '';
      if (!bloburl || typeof bloburl.urlOf !== 'function') return '';
      if (typeof bloburl.fullKey !== 'function') return '';
      var blob = item.fullBlob || item.thumbBlob;
      return blob ? bloburl.urlOf(bloburl.fullKey(item.id), blob) : '';
    }
    function fmtPhotoBytes(bytes) {
      var photos = photoStore();
      if (photos && typeof photos.fmtBytes === 'function') return photos.fmtBytes(bytes);
      var n = typeof bytes === 'number' && isFinite(bytes) && bytes > 0 ? bytes : 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function nativePhotoId() {
      if (typeof photoSeq !== 'number' || !isFinite(photoSeq) || photoSeq < 0) photoSeq = 0;  /* 自初始化，见 DECISIONS D-1417 */
      photoSeq += 1;
      return 'p' + photoSeq;
    }
    function newPhotoItem(file) {
      return {
        key: nativePhotoId(),
        id: null,
        existing: false,
        removed: false,
        phase: 'wait',
        file: file,
        record: null,
        missing: false,
        thumbBlob: null,
        fullBlob: null,
        bytes: 0,
        compressed: true,
        oversize: false,
        error: ''
      };
    }

    /* 数据流 5b：重入编辑页先重置为空，再按 tx.photoIds 原序预载（读回失败按 MESSAGES 文案提示） */
    function preloadExistingPhotos() {
      state.pendingPhotos = [];
      var ids = payloadPhotoIds(editing);
      if (!ids.length) return;
      var items = [];
      for (var i = 0; i < ids.length; i += 1) {
        var item = newPhotoItem(null);
        item.id = ids[i];
        item.existing = true;
        item.phase = 'done';
        items.push(item);
        state.pendingPhotos.push(item);
      }
      var facade = photoFacade();
      if (!facade || typeof facade.get !== 'function') return;
      facade.get(ids).then(function (read) {
        if (disposed) return;
        if (!read || read.ok !== true) {
          var text = messageOf(read && read.code, '照片读取失败，请重试');
          for (var k = 0; k < items.length; k += 1) {
            var node = photoItemByKey(items[k].key);
            if (!node) continue;
            node.phase = 'error';
            node.error = text;
          }
          showToast(text, { type: 'warning' });
          paintPhotoStrip();
          return;
        }
        var records = arr(read.records);
        for (var j = 0; j < items.length; j += 1) {
          var target = photoItemByKey(items[j].key);
          var rec = records[j] || null;
          if (!target) continue;
          if (!rec) {
            /* 确认悬空的引用（快照/回滚后记录已被物理删除）：读取侧按「无图」降级渲染；
               写入侧由 danglingExistingIds() 在保存时自愈剔除（SPEC A30），不写回引用、不报错 */
            target.phase = 'error';
            target.missing = true;
            target.error = '照片读取失败，请重试';
            continue;
          }
          target.record = rec;
          target.fullBlob = rec.blob || null;
          target.thumbBlob = rec.thumb || rec.blob || null;
          target.bytes = typeof rec.bytes === 'number' ? rec.bytes : 0;
          target.compressed = rec.compressed !== false;
          target.oversize = rec.oversizeTarget === true;
        }
        paintPhotoStrip();
      }, function () {
        if (disposed) return;
        showToast(messageOf('E_PHOTO_READ', '照片读取失败，请重试'), { type: 'warning' });
      });
    }

    /* 串行压缩：一次一张（PH-PERF-4） */
    function enqueuePhotos(items) {
      var i;
      for (i = 0; i < items.length; i += 1) {
        items[i].phase = 'wait';
        photoQueue.push(items[i]);
      }
      paintPhotoStrip();
      pumpPhotoQueue();
    }
    function pumpPhotoQueue() {
      if (photoWorking || disposed) return;
      var next = null;
      while (photoQueue.length && !next) {
        var candidate = photoQueue.shift();
        if (candidate && !candidate.removed && candidate.file) next = candidate;
      }
      if (!next) {
        paintPhotoStrip();
        return;
      }
      compressPhotoItem(next);
    }
    function compressPhotoItem(item) {
      var photos = photoStore();
      if (!photos || typeof photos.compress !== 'function') {
        item.phase = 'error';
        item.error = messageOf('E_PHOTO_COMPRESS', '压缩失败，点按重试');
        paintPhotoStrip();
        pumpPhotoQueue();
        return;
      }
      photoWorking = true;
      item.phase = 'busy';
      paintPhotoStrip();
      photos.compress({ file: item.file }).then(function (result) {
        photoWorking = false;
        if (disposed) return;
        if (!result || result.ok !== true) {
          item.phase = 'error';
          item.error = messageOf(result && result.code, '压缩失败，点按重试');
        } else {
          var created = photos.newRecord(result, { txId: null, bookId: bookId });
          if (!created || created.ok !== true) {
            item.phase = 'error';
            item.error = messageOf(created && created.code, '压缩失败，点按重试');
          } else {
            item.record = created.record;
            item.id = created.record.id;
            item.fullBlob = created.record.blob || null;
            item.thumbBlob = created.record.thumb || created.record.blob || null;
            item.bytes = typeof created.record.bytes === 'number' ? created.record.bytes : 0;
            item.compressed = created.record.compressed !== false;
            item.oversize = result.oversizeTarget === true;
            item.phase = 'done';
            if (item.removed) { item.record = null; item.fullBlob = null; item.thumbBlob = null; }
          }
        }
        paintPhotoStrip();
        pumpPhotoQueue();
      }, function () {
        photoWorking = false;
        if (disposed) return;
        item.phase = 'error';
        item.error = messageOf('E_PHOTO_COMPRESS', '压缩失败，点按重试');
        paintPhotoStrip();
        pumpPhotoQueue();
      });
    }
    function retryPhotoItem(item) {
      if (!item) return;
      if (item.existing) {
        /* 既有项没有二进制在手：重走读回（数据流 5b） */
        var facade = photoFacade();
        if (!facade || typeof facade.get !== 'function') return;
        item.phase = 'wait';
        paintPhotoStrip();
        facade.get([item.id]).then(function (read) {
          if (disposed) return;
          var rec = read && read.ok === true ? arr(read.records)[0] : null;
          if (!rec) {
            item.phase = 'error';
            item.error = messageOf(read && read.code, '照片读取失败，请重试');
          } else {
            item.record = rec;
            item.fullBlob = rec.blob || null;
            item.thumbBlob = rec.thumb || rec.blob || null;
            item.bytes = typeof rec.bytes === 'number' ? rec.bytes : 0;
            item.compressed = rec.compressed !== false;
            item.oversize = rec.oversizeTarget === true;
            item.phase = 'done';
          }
          paintPhotoStrip();
        }, function () {
          if (disposed) return;
          item.phase = 'error';
          item.error = messageOf('E_PHOTO_READ', '照片读取失败，请重试');
          paintPhotoStrip();
        });
        return;
      }
      if (!item.file) return;
      item.phase = 'wait';
      enqueuePhotos([item]);
    }
    function removePhotoItem(item) {
      if (!item) return;
      if (item.existing) {
        item.removed = true;      /* 只在屏内标记；commit 成功后才物理删（数据流 14） */
      } else {
        item.removed = true;
        var at = photoQueue.indexOf(item);
        if (at >= 0) photoQueue.splice(at, 1);
      }
      paintPhotoStrip();
      pumpPhotoQueue();
    }

    /* 数据流 1：两个入口（拍照带 capture / 相册不带）共用一次选择处理 */
    function pickPhotoFiles(files) {
      var list = [];
      var i;
      for (i = 0; i < files.length; i += 1) {
        var file = files[i];
        if (!file || typeof file.size !== 'number') continue;
        list.push(file);
      }
      if (!list.length) return;            /* 取消选图：不产生任何提示（UI.md §6-11） */
      var room = photoLimit() - livePhotoItems().length;
      if (room <= 0) {
        showToast(messageOf('E_TX_PHOTO'), { type: 'warning' });
        return;
      }
      var accepted = list.slice(0, room);
      if (list.length > room) showToast(messageOf('E_TX_PHOTO'), { type: 'warning' });
      var items = [];
      for (i = 0; i < accepted.length; i += 1) items.push(newPhotoItem(accepted[i]));
      for (i = 0; i < items.length; i += 1) state.pendingPhotos.push(items[i]);
      setExtrasOpen(true);                 /* 刚加入的格子要看得见 */
      enqueuePhotos(items);
    }
    function openPhotoPicker(input) {
      if (!input || typeof input.click !== 'function') return;
      try {
        input.click();
      } catch (error) { /* 用户代理拒绝程序化打开时静默（不弹二次入口） */ }
    }
    function openPhotoInput(input) {
      closeKeypad();          /* 系统文件选择器与自绘键盘会双占下半屏（UI.md §2.1.4） */
      openPhotoPicker(input);
    }
    var activePhotoSheet = null;
    function closeActivePhotoSheet() {
      if (activePhotoSheet && typeof activePhotoSheet.close === 'function') {
        activePhotoSheet.close('pick');
      }
      activePhotoSheet = null;
    }
    function openAddPhotoSheet() {
      var sheet = ui('sheet');
      if (!sheet || typeof sheet.open !== 'function') {
        showToast('当前环境不支持选择照片', { type: 'warning' });
        return;
      }
      /* 行内不加图标：U30 的 .s-add-photos-sheet__row 是「主文案 + 副文案」两行版式，
         塞图标会破坏既定视觉（UI.md §2.1.3 的图标列由 U30 决定），故只做文案与命中区。 */
      var holder = make('div', 's-add-photos-sheet');
      var cameraRow = make('label', 's-add-photos-sheet__row');
      cameraRow.setAttribute('for', 'xzb-photo-camera');
      cameraRow.setAttribute('role', 'button');
      cameraRow.setAttribute('tabindex', '0');
      cameraRow.setAttribute('aria-label', '拍照');
      cameraRow.appendChild(make('span', 's-add-photos-sheet__row-main', '拍照'));
      cameraRow.appendChild(make('span', 's-add-photos-sheet__row-sub', '用后置摄像头拍'));
      var albumRow = make('label', 's-add-photos-sheet__row');
      albumRow.setAttribute('for', 'xzb-photo-album');
      albumRow.setAttribute('role', 'button');
      albumRow.setAttribute('tabindex', '0');
      albumRow.setAttribute('aria-label', '从相册选择');
      albumRow.appendChild(make('span', 's-add-photos-sheet__row-main', '从相册选择'));
      albumRow.appendChild(make('span', 's-add-photos-sheet__row-sub', '可一次多选，张数不限'));
      holder.appendChild(cameraRow);
      holder.appendChild(albumRow);
      holder.appendChild(make('p', 's-add-photos-sheet__foot', '照片只存在这台手机上，不会上传到任何服务器。'));
      var handle = sheet.open({
        title: '添加照片',
        className: 's-add-photos-sheet',
        content: holder,
        dismissible: true
      });
      /* 不在这里 close：label 的默认行为是「激活关联 input」，同步移除 label 节点
         在 iOS 上会把这次激活一起打断。改由文件选择结束后（change）再关 sheet。 */
      handle = handle || null;
      activePhotoSheet = handle;
    }
    function onPhotoAddTap() {
      if (livePhotoItems().length >= photoLimit()) {
        showToast(messageOf('E_TX_PHOTO'), { type: 'warning' });
        return;
      }
      openAddPhotoSheet();
    }

    /* ---------- 预览条渲染 ---------- */
    function photoCellNode(item, index, total) {
      var stateName = item.phase === 'done' || item.phase === 'busy' || item.phase === 'error'
        ? item.phase
        : 'wait';
      var cell = button('s-add-photos__cell', '', '查看照片 ' + index + '，共 ' + total + ' 张');
      cell.setAttribute('data-state', stateName);
      cell.setAttribute('data-key', item.key);
      if (stateName === 'done') {
        var img = make('img', 's-add-photos__img');
        img.alt = '';
        img.setAttribute('draggable', 'false');
        /* 张数不限 ⇒ 预览条可能一次挂几十上百张缩略图：懒解码 + 异步解码，
           只给视口内的格子分配位图，滚动时按需再解，避免一次选 100 张就白屏/OOM。 */
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        var url = photoUrlOf(item);
        if (url) img.src = url;
        cell.appendChild(img);
      } else if (stateName === 'busy') {
        var spinner = make('span', 's-add-photos__spinner');
        spinner.setAttribute('aria-hidden', 'true');
        cell.appendChild(spinner);
      } else if (stateName === 'error') {
        cell.appendChild(iconNode('warning', 20));
      }
      var text = stateName === 'wait' ? '等待' : (stateName === 'busy' ? '处理中' : (stateName === 'error' ? '点按重试' : ''));
      if (text) {
        var stateEl = make('span', 's-add-photos__state', text);
        stateEl.setAttribute('aria-live', 'polite');
        /* 圆环在正中，文案落在它正下方，不与圆环重叠（UI.md §2.8） */
        if (stateName === 'busy') stateEl.style.top = 'calc(50% + 16px)';
        cell.appendChild(stateEl);
      }
      if (stateName === 'done' && item.compressed === false) {
        var badge = make('span', 's-add-photos__badge', '原件');
        badge.setAttribute('aria-hidden', 'true');
        cell.appendChild(badge);
      }
      var del = button('s-add-photos__del', '', '删除照片 ' + index);
      del.setAttribute('data-act', 'del');
      del.setAttribute('data-key', item.key);
      del.appendChild(iconNode('close', 12));
      cell.appendChild(del);
      return cell;
    }
    function renderPhotoMeta() {
      var list = livePhotoItems();
      var text = '';
      var i;
      if (photoBusy()) {
        var doneCount = 0;
        for (i = 0; i < list.length; i += 1) {
          if (list[i].phase === 'done') doneCount += 1;
        }
        text = '处理中 ' + doneCount + '/' + list.length;
      } else if (list.length) {
        var bytes = 0;
        var originals = 0;
        var oversizeCount = 0;
        var oversizeMax = 0;
        for (i = 0; i < list.length; i += 1) {
          var it = list[i];
          if (it.phase !== 'done') continue;
          bytes += it.bytes || 0;
          if (it.compressed === false) originals += 1;
          if (it.oversize === true) {
            oversizeCount += 1;
            if ((it.bytes || 0) > oversizeMax) oversizeMax = it.bytes || 0;
          }
        }
        text = list.length + ' 张 · 共 ' + fmtPhotoBytes(bytes);
        if (oversizeCount) {
          text += ' · ' + oversizeCount + ' 张较大（' + fmtPhotoBytes(oversizeMax) + '），可正常保存';
        }
        if (originals) text += ' · ' + originals + ' 张为原件（未压缩）';
      }
      photoMetaEl.textContent = text;
    }
    /* 保存键的「照片未就绪」禁用态：canSave() 判定逻辑一字不动（裁决 13），
       只在渲染层表达「现在按不了」，并在按下时给原因 */
    function paintPhotoConfirm() {
      var confirmKey = keypadSlot.querySelector('[data-key="confirm"]');
      if (!confirmKey) return;
      if (photoBusy()) {
        confirmKey.setAttribute('aria-disabled', 'true');
        confirmKey.style.opacity = '0.4';
      } else {
        confirmKey.removeAttribute('aria-disabled');
        confirmKey.style.opacity = '';
      }
    }
    function paintPhotoStrip() {
      var list = livePhotoItems();
      var limit = photoLimit();
      var i;
      photoBlock.setAttribute('data-count', String(list.length));
      photoEmptyRow.hidden = list.length > 0;
      photoGroupEl.hidden = list.length === 0;
      clear(photoGridEl);
      for (i = 0; i < list.length; i += 1) {
        photoGridEl.appendChild(photoCellNode(list[i], i + 1, list.length));
      }
      var full = list.length >= limit;
      /* 用 aria-disabled 而非 disabled：满了还要能接住点击并提示（UI.md §2.3） */
      photoAddCell.setAttribute('aria-disabled', full ? 'true' : 'false');
      photoGridEl.appendChild(photoAddCell);
      renderPhotoMeta();
      paintPhotoConfirm();
    }

    /* ---------- 照片写失败后的「重试」入口（PLAN §5 quota.enforcement / PLAN §9.4-10） ----------
       契约：photoPut 失败不改动 state；若流水已提交（照片写在其后），界面走「照片未能保存，
       这笔记账已保存」+ 预览条保留 + XZB.app.photos.retryPending()。这里只做界面侧接线：
       1) 失败批次张数只用于文案里的数字，不参与任何写入决策；
       2) pending 的保留/清除永远由门面（rememberPending/forgetPending）说了算；
       3) 入口绝不 goBack，预览条（state.pendingPhotos 的实体）一个字不动。 */

    /* 失败批次张数：与 finishPhotoWrites 交给 attach 的口径一致（新增项、未移除、有二进制、
       且落在最终引用里） */
    function pendingBatchCount() {
      var wanted = finalPhotoIds();
      var n = 0;
      var i;
      var item;
      for (i = 0; i < state.pendingPhotos.length; i += 1) {
        item = state.pendingPhotos[i];
        if (!item || item.existing || item.removed || !item.record || !isPhotoId(item.id)) continue;
        if (wanted.indexOf(item.id) < 0) continue;
        n += 1;
      }
      return n;
    }

    function paintPendingRetryRow() {
      if (!photoRetryRow) return;
      if (pendingRetryCount > 0) {
        photoRetryRow.hidden = false;
        photoRetryRow.removeAttribute('aria-hidden');
        photoRetrySub.textContent = pendingRetryText(pendingRetryCount);
      } else {
        photoRetryRow.hidden = true;
        photoRetryRow.setAttribute('aria-hidden', 'true');
        photoRetrySub.textContent = '';
      }
    }

    /* pendingCount() → {ok:true, count}（app.js:1524/1691）。collapsed=false 时只在 count>0
       才摆出入口；collapsed=true 时 count=0 会收起入口（重试成功/待重试已清空的收敛态）。 */
    function refreshPendingRetryRow(collapseWhenZero) {
      var app = appApi();
      var photos = app && app.photos ? app.photos : null;
      if (!photos || typeof photos.pendingCount !== 'function') return;
      Promise.resolve(photos.pendingCount()).then(function (res) {
        if (disposed) return;
        var n = res && res.ok === true && typeof res.count === 'number' ? res.count : 0;
        if (n > 0) {
          pendingRetryCount = n;
          paintPendingRetryRow();
          return;
        }
        if (collapseWhenZero) {
          pendingRetryCount = 0;
          paintPendingRetryRow();
        }
      }, function () {
        /* 计数拿不到就不摆入口：绝不因为一个只读查询影响记账主流程 */
      });
    }

    /* 「重试」→ XZB.app.photos.retryPending()（PLAN §9.4-10 的唯一接线点）。
       返回结构见 app.js:1530-1578：全部成功 {ok:true, ids:[…]}；任一失败（含部分成功，成功组
       的 pending 已被 forgetPending 就地清掉）⇒ {ok:false, code, message, retryable:true}。
       成功：清 pending 标记、预览条恢复正常态，这一笔（记账+照片）已全部落库 ⇒ 回列表；
       失败/部分失败：预览条与入口保留，数字按 pendingCount() 复核后的剩余张数刷新。 */
    function retryPendingPhotos() {
      if (pendingRetryBusy || disposed) return;
      var app = appApi();
      var photos = app && app.photos ? app.photos : null;
      if (!photos || typeof photos.retryPending !== 'function') {
        showToast(pendingRetryText(pendingRetryCount), { type: 'danger' });
        return;
      }
      pendingRetryBusy = true;
      Promise.resolve(photos.retryPending()).then(function (res) {
        pendingRetryBusy = false;
        if (disposed) return;
        if (pendingRetryOutcome(res) === 'done') {
          pendingRetryCount = 0;
          paintPendingRetryRow();
          showToast('已记一笔', { type: 'success' });
          goBack();
          return;
        }
        showToast(messageOf(res && res.code, messageOf('E_PHOTO_WRITE')), { type: 'danger' });
        refreshPendingRetryRow(true);
      }, function () {
        pendingRetryBusy = false;
        if (disposed) return;
        showToast(messageOf('E_PHOTO_WRITE'), { type: 'danger' });
        refreshPendingRetryRow(true);
      });
    }

    /* ---------- 预览条交互 ---------- */
    listen(photoBlock, 'click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var del = target.closest('.s-add-photos__del');
      if (del) {
        var delItem = photoItemByKey(del.getAttribute('data-key'));
        if (delItem) removePhotoItem(delItem);
        return;
      }
      var cell = target.closest('.s-add-photos__cell');
      if (cell) {
        var item = photoItemByKey(cell.getAttribute('data-key'));
        if (!item) return;
        if (item.phase === 'error') {
          retryPhotoItem(item);
          return;
        }
        if (item.phase === 'done') openPhotoViewerAt(item);
        return;
      }
      var act = target.closest('[data-act]');
      if (!act) return;
      var kind = act.getAttribute('data-act');
      if (kind === 'retry-pending') retryPendingPhotos();
      else if (kind === 'sheet') openAddPhotoSheet();
      else if (kind === 'add') onPhotoAddTap();
    });

    /* 数据流 6：查看器里的删除只改 state.pendingPhotos（不落库、不给撤销条；
       移除的既有项在 commit 成功后才由 finishPhotoWrites 物理删） */
    function onViewerDelete(photoId) {
      var item = photoItemById(photoId);
      if (!item) {
        return { ok: false, code: 'E_PHOTO_NOT_FOUND', message: messageOf('E_PHOTO_NOT_FOUND', '照片不存在') };
      }
      removePhotoItem(item);
      return undefined;
    }
    function openPhotoViewerAt(item) {
      var viewer = ui('photoViewer');
      if (!viewer || typeof viewer.open !== 'function') return;
      var list = livePhotoItems();
      var items = [];
      var index = 0;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].phase !== 'done') continue;
        if (list[i].key === item.key) index = items.length;
        items.push({
          id: list[i].id,
          url: photoFullUrlOf(list[i]),          /* 全屏看原图（不是 320px 缩略图） */
          compressed: list[i].compressed !== false,
          bytes: list[i].bytes || 0
        });
      }
      if (!items.length) return;
      viewer.open({
        items: items,
        index: index,
        source: 'add',
        onDelete: onViewerDelete
      });
    }

    /* 数据流 8/9/10：二进制写在其后（attach = 写二进制 + 按序追加引用，任一步失败由门面补偿）；
       照片失败不回滚记账（SPEC A13）。数据流 14：被移除的既有项在 commit 成功后才物理删。 */
    function finishPhotoWrites(entity) {
      var facade = photoFacade();
      var removedIds = removedPhotoIds();
      if (!facade) return { ok: true };
      var wanted = finalPhotoIds();
      var records = [];
      var i;
      for (i = 0; i < state.pendingPhotos.length; i += 1) {
        var it = state.pendingPhotos[i];
        if (it.existing || it.removed || !it.record || !isPhotoId(it.id)) continue;
        if (wanted.indexOf(it.id) < 0) continue;
        records.push(assign({}, it.record, { txId: entity.id, bookId: entity.bookId }));
      }
      if (!records.length) {
        if (removedIds.length && typeof facade.purge === 'function') {
          facade.purge(removedIds).then(function () { return null; }, function () { return null; });
        }
        return { ok: true };
      }
      return facade.attach({ txId: entity.id, records: records }).then(function (result) {
        if (!result || result.ok !== true) {
          /* 数据流 9（PLAN §1.5 裁决 3）：attach 内部已把该 tx 的 photoIds 补偿回写为写前值
             （app.js photosAttach 的 withoutIds 回退分支）⇒ 不产生悬空引用；这里只把失败态
             结构化交给保存流程，由它给用户错误码文案，记账本身照常成功（SPEC A13 / A23）。 */
          return {
            ok: false,
            phase: 'attach-failed',
            code: (result && result.code) || 'E_PHOTO_WRITE',
            message: result && result.message ? result.message : messageOf('E_PHOTO_WRITE'),
            retryable: true
          };
        }
        if (removedIds.length && typeof facade.purge === 'function') {
          facade.purge(removedIds).then(function () { return null; }, function () { return null; });
        }
        return result;
      });
    }

    /* 预载已在 DOM 之前发起（数据流 5b，见「照片预载」）；这里只补首帧渲染与入口接线 */
    listen(photoCameraInput, 'change', function () {
      closeActivePhotoSheet();
      var picked = photoCameraInput.files ? Array.prototype.slice.call(photoCameraInput.files) : [];
      photoCameraInput.value = '';        /* 先清空：同一张重选也能触发 change */
      pickPhotoFiles(picked);
    });
    listen(photoAlbumInput, 'change', function () {
      closeActivePhotoSheet();
      var picked = photoAlbumInput.files ? Array.prototype.slice.call(photoAlbumInput.files) : [];
      photoAlbumInput.value = '';
      pickPhotoFiles(picked);
    });
    paintPhotoStrip();
    /* 数据流 10 / PLAN §9.4-10：本屏不是 attach 失败现场，但内存里可能还留着上次失败的 pending
       （pending 只在 app.js 内存里、不落库）⇒ 按 pendingCount() 的数量把「重试」入口摆出来 */
    refreshPendingRetryRow(false);

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
        /* 数据流 7：先提交引用（既有未移除项，原序）；新增项由 attach 在二进制写成功后按序追加 */
        photoIds: mergedExistingIds(),
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
      /* 本屏这一笔已经提交成功（照片写失败后留在本页的现场）：非编辑模式再走一次保存会用新 id
         建出第二条一模一样的流水（buildEntity 的 create 分支）⇒ 挡住，唯一出口是「重试」或返回。
         文案仍取 MESSAGES.E_PHOTO_WRITE（这笔记账确实已保存），数字即待重试张数。 */
      if (committedId && !editing) {
        showToast(pendingRetryCount > 0 ? pendingRetryText(pendingRetryCount) : '已记一笔',
          { type: pendingRetryCount > 0 ? 'danger' : 'success' });
        return;
      }
      if (photoBusy()) {
        /* 引用集合未稳定（还在压缩/排队）：不 commit（UI.md §2.3 面 2 / 数据流 7） */
        showReason('照片处理中，稍候可保存');
        photoMetaEl.textContent = '照片处理中，稍候可保存';
        if (photoMetaTimer) global.clearTimeout(photoMetaTimer);
        photoMetaTimer = global.setTimeout(function () {
          photoMetaTimer = 0;
          if (disposed) return;
          renderPhotoMeta();
        }, 2400);
        return;
      }
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
        /* 记账已落库；照片二进制写在其后，失败不回滚记账（SPEC A13 / 数据流 8-10/14）。
           同时记下「本屏这一笔已提交」：非编辑模式下 buildEntity 的 create 分支会用新 id 再建
           一条，所以照片失败留在本页时必须靠它挡住重复提交。 */
        if (!editing) committedId = entity.id;
        Promise.resolve(finishPhotoWrites(entity)).then(function (photoDone) {
          if (disposed) return;
          if (!photoDone || photoDone.ok !== true) {
            /* 数据流 9（§1.5 裁决 3）：attach 失败 ⇒ 引用侧由 attach 内部补偿回写为写前值，
               记账照常成功、不产生悬空引用；失败批次留在 pending 可重试 */
            var retryable = !!(photoDone && (photoDone.phase === 'attach-failed'
              || photoDone.retryable === true));
            var failText = messageOf(photoDone && photoDone.code, messageOf('E_PHOTO_WRITE'));
            if (retryable) {
              /* PLAN §5 quota.enforcement（PLAN.md:383）：流水已提交而照片写失败 ⇒
                 留在记账页、不 goBack；屏内草稿 state.pendingPhotos 原样保留（预览条缩略图
                 不消失、进 pending 的入口随之可见），只多一条「重试」入口；
                 点它走 XZB.app.photos.retryPending()（PLAN §9.4-10 验收项 10）。 */
              pendingRetryCount = pendingBatchCount() || 1;
              paintPendingRetryRow();
              showToast(failText, { type: 'danger' });
              return;
            }
            showToast(failText, { type: 'danger' });
            goBack();
            return;
          }
          showToast('已记一笔', { type: 'success' });
          goBack();
        }, function () {
          /* 门面自身不 reject（app.js 的 callPhotoStore 已兜底），这里是最后一道兜底：
             同样按照片写失败处理 —— 留在页面、保留预览条与「重试」入口，草稿一个字不丢 */
          if (disposed) return;
          pendingRetryCount = pendingBatchCount() || 1;
          paintPendingRetryRow();
          showToast(messageOf('E_PHOTO_WRITE'), { type: 'danger' });
        });
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
    swapBtn.addEventListener('click', swapAccounts);
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
    /* 编辑已有内容（备注/标签/报销/照片）时默认展开补充信息，新建默认折叠 */
    setExtrasOpen(!!(editing && (state.note || state.tags.length || state.reimburse === true))
      || state.pendingPhotos.length > 0);
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

  XZB.screenAdd = Object.freeze({ render: render, register: register, __test: __test });
}(typeof window !== 'undefined' ? window : this));
