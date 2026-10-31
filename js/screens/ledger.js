/* 小账本 2.0 · js/screens/ledger.js · owner: 前端#2（T10 明细 / F31 照片角标·详情照片区·大图入口）
 * 契约锚点：UI.md §6.3（:840-905 线框与逐项规格）、SPEC A1/A2/A13/A17/A20/A22、
 *           INTERFACE-FREEZE §1（token）§3（类名 s-ledger-*）§8（十二条红线）、DECISIONS D06/D16；
 *           F31 追加：UI.md §2.4（角标）/§2.5.1（详情照片区）/§2.5.3（复制不共享照片）、
 *           SPEC A14/A15/A17/A18/C-2、PLAN §2（XZB.app.photos / XZB.UI.bloburl / XZB.UI.photoViewer 冻结签名）、
 *           PLAN §3 步骤 11–13、§9.4 / §9.4.1（URL 生命周期）、§10 R-6（null 位降级）。
 *
 * 形状：2.15.0 起同一份实现支持两态（DESIGN D2-* / D4-*，T05）：
 *   ① 嵌入态 embedded === true：root 是首页 .s-home-inner 里的容器 div，本屏在它身上加
 *      s-ledger + s-ledger--embedded + data-ledger-embed="1"，不渲染独立外壳 / 吸顶容器；
 *   ② 独立态 embedded === false（回滚保险，2.15.0 路由不可达）：root 是 .app-screen__body.s-ledger。
 *   两态都返回 controller（destroy/embedded/focusSearch/month/openBudgetStatus/
 *   openCategoryFilter/root/scrollToList/toggleReimburse，恰好 9 键，见 D2-11）；
 *   .app-screen 是全页唯一滚动容器，.app-nav 在独立态下 position:sticky 在顶部。
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
 *  10. 照片（F31）：有图的明细行出「📷[N]」角标（只读 photoIds 长度，零异步 IO）→ 点角标开大图；
 *      详情面板出「照片」文本行 + 缩略图行 → 点缩略图开大图（XZB.UI.photoViewer）；
 *      照片记录为 null 位（跨标签页被删 / 导入缺图）时按「无图」降级，不抛错、不白屏。
 *
 * 硬约束：不碰 IndexedDB / localStorage / TabBar；用户数据一律 textContent；
 *        金额只用整数分；日期只用本地 YYYY-MM-DD 字符串；类名只 s-ledger-*。
 *        照片（F31）：屏幕层不直连 store，一律经 XZB.app.photos.*；
 *        blob URL 一律经 XZB.UI.bloburl（同 id 恒同 URL），本屏只 release 自己创建的键，
 *        路由级 releaseAll 归 app.js（PLAN §9.4）。
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
  /* F31 照片：张数上限真源 = schema.LIMITS.txPhotos（2.13.0 起「不限张数」⇒ 999，只是校验安全上界）。
     本屏**不再**按 3 截断：超过 3 张也要全部渲染、全部进查看器。
     2.14 起列表行直接展示 64px 缩略图（角标只负责 N>1 的数字），不再是「camera 小图标代表有照片」。 */
  var PHOTO_MAX_FALLBACK = 999;
  function photoMaxPerTx() {
    var Core = XZB && XZB.Core ? XZB.Core : null;
    var limits = Core && Core.schema ? Core.schema.LIMITS : null;
    var value = limits ? limits.txPhotos : null;
    return Number.isInteger(value) && value > 0 ? value : PHOTO_MAX_FALLBACK;
  }
  var PHOTO_ID_MAX = 64;
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

  /* F31：照片链路的三处依赖，缺件一律降级（并行任务未落地时本屏不得抛错、不得白屏） */
  function photosApi() {
    var app = appApi();
    var photos = app && app.photos ? app.photos : null;
    if (!photos || typeof photos.get !== 'function') { return null; }
    return photos;
  }

  function blobUrlApi() {
    var ui = uiApi();
    return ui.bloburl || ui.blobUrl || null;
  }

  function photoViewerApi() {
    var ui = uiApi();
    return ui.photoViewer || ui.photo_viewer || null;
  }

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

  /* ---------------- 照片（F31：角标 / 详情照片区 / 大图入口 / URL 生命周期） ----------------
   * 契约：PLAN §2（XZB.app.photos / XZB.UI.bloburl / XZB.UI.photoViewer 冻结签名）、PLAN §3 步骤 11–13、
   *       §9.4 + §9.4.1（blob URL 生命周期）、§10 R-6（null 位降级）、UI.md §2.4/§2.5.1/§2.5.3、SPEC A14/A15/A18/C-2。
   * 三条边界：
   *   ① 屏幕层不直连 store/IndexedDB：读经 XZB.app.photos.get（= photoGetMany 直通），写经 removeWithUndo（PLAN:249 冻结不变量）；
   *   ② 逐图 null 位（跨标签页被删 / 导入缺图）一律降级成「无图」，不抛错、不白屏、不阻塞其它行；
   *   ③ releaseAll 归路由销毁（app.js 的 F22），本屏只 release 自己经 urlOf 创建、且确定已无人持有的键。
   */

  /* --- 纯函数（无 DOM、无 IO；tools/_t20_selfcheck.cjs 经 screen.photoTestKit 取用） --- */

  function kitApi() {
    return global.XZB && XZB.ui && XZB.ui.kit ? XZB.ui.kit : null;
  }

  /* 归一化 tx.photoIds：非数组 → []；去重、保首现顺序、丢弃非字符串/空串/超长项。
   * 唯一的纯函数实现已落在 XZB.ui.kit（CONTRACT §缩略图选择规则）；本屏只做薄委托，
   * 老包缺 kit 时退回本地同语义实现，保证不白屏。 */
  function photoIdList(tx) {
    var kit = kitApi();
    if (kit && typeof kit.photoIdList === 'function') {
      try { return kit.photoIdList(tx); } catch (error) { /* 坏入参：走本地兜底 */ }
    }
    var raw = tx && tx.photoIds;
    if (!Array.isArray(raw) || !raw.length) { return []; }
    var max = photoMaxPerTx();
    var out = [];
    for (var i = 0; i < raw.length && out.length < max; i += 1) {
      var id = raw[i];
      if (typeof id !== 'string') { continue; }
      id = id.trim();
      if (!id || id.length > PHOTO_ID_MAX) { continue; }
      if (out.indexOf(id) < 0) { out.push(id); }
    }
    return out;
  }

  /* 角标决策（UI.md §2.4 / CONTRACT §数量角标规则）：N=0 → null；N>1 才出数字（数字＝总数）。
   * 纯函数来自 kit（含 99+ 与真实张数的 aria-label），老包缺件时退回本地版本。 */
  function badgePlan(tx) {
    var kit = kitApi();
    if (kit && typeof kit.badgePlan === 'function') {
      try {
        var plan = kit.badgePlan(tx);
        if (plan) { return plan; }
        return null;
      } catch (error) { /* 走本地兜底 */ }
    }
    var count = photoIdList(tx).length;
    if (!count) { return null; }
    return { count: count, showCount: count > 1, text: count > 99 ? '99+' : String(count), label: '含 ' + count + ' 张照片' };
  }

  /* 记录按位对齐：photoGetMany 的 records 与入参同序同长、缺失元素是 null（CONTRACT）。
   * kit.photoSlots 返回**同序同长**的槽位数组（不可读位是 null，绝不 filter 洗位）；
   * 老包缺件时本地实现也保持同长，调用方必须逐位判空。 */
  function photoSlots(ids, records) {
    /* 兼容 CONTRACT 的对象式调用 photoSlots({ ids, records }) 与位置式 (ids, records)；
     * 对象式不能先被归一成 []，否则 kit 拿到空 ids 直接返回空数组。 */
    var pack = ids && !Array.isArray(ids) && typeof ids === 'object' ? ids : null;
    var list = pack ? (Array.isArray(pack.ids) ? pack.ids : []) : (Array.isArray(ids) ? ids : []);
    var recs = pack ? pack.records : records;
    var kit = kitApi();
    if (kit && typeof kit.photoSlots === 'function') {
      try { return kit.photoSlots(list, recs); } catch (error) { /* 走本地兜底 */ }
    }
    var out = [];
    var max = photoMaxPerTx();
    for (var i = 0; i < list.length && i < max; i += 1) {
      var rec = recs && recs[i];
      if (!rec || typeof rec !== 'object') { out.push(null); continue; }
      var thumb = rec.thumb && typeof rec.thumb === 'object' ? rec.thumb : null;
      var full = rec.blob && typeof rec.blob === 'object' ? rec.blob : null;
      var blob = thumb || full;
      if (!blob) { out.push(null); continue; }
      out.push({
        id: String(list[i]),
        blob: blob,
        thumb: thumb,
        full: full || thumb,
        compressed: rec.compressed !== false,
        bytes: typeof rec.bytes === 'number' ? rec.bytes : undefined,
        index: i
      });
    }
    return out;
  }

  /* 可读槽（跳 null）——只给查看器/详情这类「按可读张数顺序」的场景用；
   * 列表选择第一张可读时必须用上面的同长数组，靠索引找。 */
  function readableSlots(slots) {
    var out = [];
    if (!Array.isArray(slots)) { return out; }
    for (var i = 0; i < slots.length; i += 1) {
      if (slots[i]) { out.push(slots[i]); }
    }
    return out;
  }

  /* URL 归属判定：只有「调用 urlOf 之前该键还不存在」时，这个 URL 才是本屏创建的、才由本屏 release。
   * 别人已建键 ⇒ 本屏不重复持有（否则越权 revoke 会把别人正在显示的图变成白图，PLAN §9.4）。 */
  function ownsUrl(hadBefore, url) {
    return hadBefore !== true && !!url;
  }

  /* --- blob URL 生命周期（PLAN §9.4：同一 id 恒同一 URL；releaseAll 只在路由销毁） --- */

  var photoKeys = [];           /* 本屏经 urlOf 创建、尚未 release 的键（模块级：跨 paint / render 存活） */
  var photoDetailOpen = false;  /* 详情面板是否仍持有缩略图 */
  var photoViewerOpen = false;  /* 大图查看器是否仍持有同一批 URL */

  function notePhotoKey(key) {
    if (key && photoKeys.indexOf(key) < 0) { photoKeys.push(key); }
  }

  /* 键词表唯一入口：${photoId}:thumb / ${photoId}:full（CONTRACT §Blob URL key 词表）。
   * 全部经 XZB.UI.bloburl 纯字符串函数构造；老包缺函数时返回 ''（空图，不抛错）。 */
  function photoKeyOf(photoId, variant) {
    var id = photoId === undefined || photoId === null ? '' : String(photoId);
    if (!id) { return ''; }
    var bloburl = blobUrlApi();
    if (bloburl && typeof bloburl.key === 'function') {
      try {
        var made = bloburl.key(id, variant);
        return made ? String(made) : '';
      } catch (error) { return ''; }
    }
    return '';
  }

  function thumbKeyOf(photoId) {
    var bloburl = blobUrlApi();
    if (bloburl && typeof bloburl.thumbKey === 'function') {
      try {
        var key = bloburl.thumbKey(photoId);
        return key ? String(key) : '';
      } catch (error) { /* 缺件：空图 */ }
    }
    return photoKeyOf(photoId, 'thumb');
  }

  function fullKeyOf(photoId) {
    var bloburl = blobUrlApi();
    if (bloburl && typeof bloburl.fullKey === 'function') {
      try {
        var key = bloburl.fullKey(photoId);
        return key ? String(key) : '';
      } catch (error) { /* 缺件：空图 */ }
    }
    return photoKeyOf(photoId, 'full');
  }

  /* 当前文档里仍被引用的键（列表行媒体区 + 详情缩略图都写了 data-photo-key）。
   * flush 只扫描**已上屏**的 DOM，因此必须等 swapDom 之后调用，避免把新页面的键误判成孤儿。 */
  function livePhotoKeySet() {
    var set = Object.create(null);
    var doc = global.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') { return set; }
    var nodes = doc.querySelectorAll('[data-photo-key]');
    for (var i = 0; i < nodes.length; i += 1) {
      var key = nodes[i] && typeof nodes[i].getAttribute === 'function'
        ? nodes[i].getAttribute('data-photo-key')
        : '';
      if (key) { set[key] = true; }
    }
    return set;
  }

  /* 释放时机：列表重绘后（DOM 已上屏）/ 详情关闭 / 查看器关闭。
   * 只释放「本屏创建 + 当前 DOM 已无人引用」的键；详情或查看器打开时一律推迟。
   * 禁止组件卸载 release、禁止引用计数归零 revoke、禁止 releaseAll（路由 teardown 除外）。 */
  function flushPhotoUrls() {
    if (!photoKeys.length) { return 0; }
    if (photoDetailOpen || photoViewerOpen) { return 0; }
    var live = livePhotoKeySet();
    var bloburl = blobUrlApi();
    var kept = [];
    var released = 0;
    for (var i = 0; i < photoKeys.length; i += 1) {
      var key = photoKeys[i];
      if (live[key]) { kept.push(key); continue; }
      if (bloburl && typeof bloburl.release === 'function') {
        try { bloburl.release(key); } catch (error) { /* 释放失败不阻塞界面 */ }
      }
      released += 1;
    }
    photoKeys = kept;
    return released;
  }

  /* 取 URL：一律经 XZB.UI.bloburl.urlOf(key, blob)，key 必须是本屏词表内的 :thumb/:full。
   * 缺件 / 非法键 / 抛错 → 返回 ''（调用方按无图渲染，不抛错、不自造第二套键）。 */
  function photoUrlOf(key, blob) {
    var bloburl = blobUrlApi();
    if (!bloburl || typeof bloburl.urlOf !== 'function' || !key) { return ''; }
    if (!/(:thumb|:full)$/.test(String(key))) { return ''; }
    var hadBefore = typeof bloburl.has === 'function' ? bloburl.has(key) === true : false;
    var url = '';
    try {
      url = bloburl.urlOf(String(key), blob);
    } catch (error) { url = ''; }
    url = url ? String(url) : '';
    if (ownsUrl(hadBefore, url)) { notePhotoKey(String(key)); }
    return url;
  }

  /* --- 大图查看器入口（PLAN §2 photoViewer.open / §3 步骤 13；UI.md §2.5.2） --- */

  function photoErrorText() {
    return messageOf('E_PHOTO_NOT_FOUND', '照片不存在或已被清理');
  }

  /* 编辑态「移除这一张」：物理删除 + commit 剔除引用，一律经 app 门面（PLAN §2 removeWithUndo） */
  function removePhotoFromTx(st, tx, photoId) {
    var photos = photosApi();
    if (!photos || typeof photos.removeWithUndo !== 'function') { return; }
    try {
      photos.removeWithUndo({ txId: tx && tx.id, ids: [String(photoId || '')] });
    } catch (error) { /* 失败由 app 层提示，本屏不额外弹错、不中断查看器 */ }
  }

  function openViewerFor(st, tx, ids, index) {
    /* 不限张数（2.13.0）：ids 全量进查看器，只受 schema 校验上界保护，绝不再 slice(0, 3) */
    var max = photoMaxPerTx();
    var list = Array.isArray(ids) && ids.length ? ids.slice(0, max) : photoIdList(tx);
    var viewer = photoViewerApi();
    var photos = photosApi();
    if (!viewer || typeof viewer.open !== 'function' || !photos || !list.length) {
      toast(photoErrorText(), { type: 'danger' });     /* 打开失败 → 用 E_PHOTO_NOT_FOUND 文案，不白屏 */
      return;
    }
    photos.get(list).then(function (result) {
      if (st && st.dead) { return; }
      var records = result && Array.isArray(result.records) ? result.records : [];
      var slots = photoSlots(list, records);
      var items = [];
      for (var i = 0; i < slots.length; i += 1) {
        /* 同序同长数组：缺失位是 null，逐位跳过，绝不把 null 当记录用 */
        if (!slots[i]) { continue; }
        /* 大图查看器**自己**持有 URL（photo-viewer.js 的 PhotoRef 形态：item.blob ⇒ urlOf 并记入 owned）。
           这里只传 blob、**不传 url**：否则本屏先 urlOf 注册 ⇒ 查看器判定 existed=true 不接管所有权
           ⇒ 本屏 flushPhotoUrls 一跑就把查看器正在显示的 URL 回收 ⇒ 图变白（真机实测 ERR_FILE_NOT_FOUND）。
           大图取 full（原尺寸压缩件），不能用 slots[i].blob（缩略图优先）放大冒充。 */
        var big = slots[i].full || slots[i].blob;
        if (!big) { continue; }                        /* 拿不到图：该位不进查看器（降级，不抛错） */
        items.push({ id: slots[i].id, blob: big, compressed: slots[i].compressed, bytes: slots[i].bytes });
      }
      if (!items.length) {
        toast(photoErrorText(), { type: 'danger' });
        return;
      }
      /* 从被点的那张开始：二次读取若有缺失位，下标会压缩，必须按 photoId 重新定位 */
      var wantedIndex = Math.max(0, Number(index) || 0);
      var wantedId = list[wantedIndex] !== undefined ? String(list[wantedIndex]) : '';
      var start = 0;
      if (wantedId) {
        for (var s = 0; s < items.length; s += 1) {
          if (String(items[s].id) === wantedId) { start = s; break; }
        }
      }
      if (start < 0 || start >= items.length) { start = 0; }
      photoViewerOpen = true;
      try {
        viewer.open({
          items: items,
          index: start,
          source: 'ledger',
          onDelete: function (photoId) { removePhotoFromTx(st, tx, photoId); },
          onClose: function () { photoViewerOpen = false; flushPhotoUrls(); }
        });
      } catch (error) {
        photoViewerOpen = false;
        toast(photoErrorText(), { type: 'danger' });
      }
    }, function () {
      if (st && st.dead) { return; }
      toast(photoErrorText(), { type: 'danger' });
    });
  }

  /* --- 详情面板照片区（UI.md §2.5.1 / CONTRACT §三态状态机） --- */

  function dropDetailPhotoArea(row, grid) {
    if (grid && grid.parentNode) { grid.parentNode.removeChild(grid); }
    if (row && row.parentNode) { row.parentNode.removeChild(row); }
  }

  /* 详情缩略图与列表共用同一个 :thumb 键（CONTRACT §Blob URL key 词表）；
   * thumb 缺失时退 rec.blob，此时必须走 :full，不能把原图挂到 :thumb 名下。 */
  function buildDetailPhoto(st, tx, ids, slot, index, total) {
    var variant = slot.thumb ? 'thumb' : 'full';
    var key = variant === 'thumb' ? thumbKeyOf(slot.id) : fullKeyOf(slot.id);
    var url = key ? photoUrlOf(key, slot.blob) : '';
    var btn = el('button', {
      className: 's-ledger-detail__photo',
      type: 'button',
      'aria-label': '查看照片 ' + (index + 1) + '，共 ' + total + ' 张'
    });
    if (key) { btn.setAttribute('data-photo-key', key); }
    if (key) { btn.setAttribute('data-photo-id', String(slot.id)); }
    if (url) {
      /* alt="" 由 aria-label 承载信息（UI.md §7 第 12 条）；src 只来自 blob 注册表，不拼任何用户数据 */
      var img = el('img', { alt: '', src: url, draggable: 'false' });
      img.addEventListener('error', function () {
        /* 单张破图：移除 img，保留按钮其余语义；不重排、不自动重试、不拖垮其它照片 */
        if (img.parentNode === btn) { btn.removeChild(img); }
        btn.setAttribute('data-photo-error', '1');
        btn.setAttribute('aria-label', '照片不可用');
      });
      btn.appendChild(img);
    } else {
      btn.setAttribute('data-photo-error', '1');
      btn.setAttribute('aria-label', '照片不可用');
    }
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openViewerFor(st, tx, ids, index);
    });
    return btn;
  }

  /* 返回照片区句柄（无图 → null；有图时初始 loading，失败只在用户点「重试」时重读，自动重试 = 0） */
  function attachDetailPhotos(st, tx, list, body) {
    var ids = photoIdList(tx);

    var row = el('div', { className: 's-ledger-detail__row s-ledger-detail__row--photos' });
    row.appendChild(el('span', { className: 's-ledger-detail__key', text: '照片' }));
    var val = el('span', { className: 's-ledger-detail__val' });
    val.setAttribute('aria-live', 'polite');
    var retryBtn = el('button', {
      className: 's-ledger-detail__retry c-btn c-btn--text',
      type: 'button',
      text: '重试',
      'aria-label': '重试读取照片'
    });
    retryBtn.hidden = true;
    row.appendChild(val);
    row.appendChild(retryBtn);
    list.appendChild(row);

    if (!ids.length) {
      /* 无图：只显示「未添加」，不渲染空网格（CONTRACT §三态状态机） */
      val.textContent = '未添加';
      retryBtn.hidden = true;
      return null;
    }

    var grid = el('div', { className: 's-ledger-detail__photos' });
    body.appendChild(grid);

    var photos = photosApi();
    var seq = 0;
    var busy = false;

    function fail() {
      retryBtn.hidden = false;
      clearNode(grid);
      grid.setAttribute('aria-busy', 'false');
      val.textContent = '照片加载失败';
    }

    function applyResult(result, mine) {
      if (!st || st.dead || mine !== seq) { return; }
      var records = result && Array.isArray(result.records) ? result.records : null;
      if (!result || result.ok !== true || !records || records.length !== ids.length) {
        fail();                                  /* 防御：返回长度不符/非数组也按失败，不炸 */
        return;
      }
      var slots = photoSlots(ids, records);      /* 同序同长，缺失位 null */
      if (!slots || slots.length !== ids.length) { fail(); return; }
      var readable = readableSlots(slots);
      if (!readable.length) { fail(); return; }  /* 整批都读不出：失败态 + 重试，不当成「未添加」 */
      clearNode(grid);
      grid.setAttribute('aria-busy', 'false');
      retryBtn.hidden = true;
      var originals = 0;
      var readableIds = [];
      for (var i = 0; i < readable.length; i += 1) {
        readableIds.push(readable[i].id);
        if (readable[i].compressed === false) { originals += 1; }
      }
      for (var j = 0; j < readable.length; j += 1) {
        grid.appendChild(buildDetailPhoto(st, tx, readableIds, readable[j], j, readable.length));
      }
      var missing = ids.length - readable.length;
      val.textContent = ids.length + ' 张'
        + (missing > 0 ? '，缺失 ' + missing + ' 张' : '')
        + (originals > 0 ? '（含 ' + originals + ' 张原件）' : '');
    }

    function load() {
      if (!st || st.dead) { return; }
      if (!photos || typeof photos.get !== 'function') { fail(); return; }
      busy = true;
      seq += 1;                                /* 每次显式触发 +1（连点重试也逐次计数），旧回包按 seq 丢弃 */
      var mine = seq;
      retryBtn.hidden = true;
      clearNode(grid);
      grid.setAttribute('aria-busy', 'true');
      val.textContent = '照片加载中';
      var skeletonCount = Math.min(ids.length, 3);
      for (var i = 0; i < skeletonCount; i += 1) {
        var skel = el('span', { className: 's-ledger-detail__photo-skel c-skeleton' });
        skel.setAttribute('aria-hidden', 'true');
        grid.appendChild(skel);
      }
      var pending;
      try { pending = photos.get(ids.slice()); } catch (error) { pending = null; }
      Promise.resolve(pending).then(function (result) {
        busy = false;
        applyResult(result, mine);
      }, function () {
        busy = false;
        if (!st || st.dead || mine !== seq) { return; }
        fail();
      });
    }

    retryBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      /* 只由用户点击触发，每次点击 +1 次读取；不做自动重试（CONTRACT D-11 / N7.4） */
      load();
    });

    /* 打开详情时自动读一次（这是首次加载，不是自动重试；失败后只有用户点「重试」才会再读） */
    load();
    return { row: row, grid: grid, val: val, ids: ids, retry: retryBtn };
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

  function fmt(cents, options) {
    if (money && typeof money.formatCents === 'function') { return money.formatCents(cents, options); }
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

  var persisted = null;   /* 跨 rerender 保留月份与筛选（commit 后 app 会整屏重建）；[D4-11] URL 派生值不回写 */
  var live = null;        /* 当前屏状态（用于清理上一屏监听） */
  var cleanups = [];

  /* ---------------- 2.15.0 嵌入契约（T05：DESIGN §2 §4） ---------------- */

  /* [D4-1] 五键白名单：URL 上只有这五个键参与状态构造，其余键一律忽略 */
  var URL_KEYS = ['detail', 'month', 'flag', 'date', 'ca'];
  var EMBED_CLASS = 's-ledger--embedded';
  var EMBED_ATTR = 'data-ledger-embed';
  /* [D4-10] 上一次渲染实例的生效态 + 已消费的五键指纹：指纹不变的重绘不得再被 URL 覆盖 */
  var lastState = null;
  var lastUrlKey = '';

  function runCleanups() {
    while (cleanups.length) {
      var fn = cleanups.pop();
      try { fn(); } catch (error) { /* 忽略 */ }
    }
  }

  /* [D2-5] options 缺省值：字段名与语义冻结，只可增补可选字段 */
  function normalizeOptions(options) {
    var source = options && typeof options === 'object' ? options : {};
    return {
      embedded: source.embedded === true,
      baseHash: typeof source.baseHash === 'string' && source.baseHash ? source.baseHash : null,
      stickyTop: typeof source.stickyTop === 'number' && isFinite(source.stickyTop) ? source.stickyTop : null,
      onMonthChange: typeof source.onMonthChange === 'function' ? source.onMonthChange : null,
      onBudgetStatus: typeof source.onBudgetStatus === 'function' ? source.onBudgetStatus : null
    };
  }

  /* [D2-6]/[D2-7] 宿主节点就是根节点本身：s-ledger 三件套一律打在传入的 root 上，不建中间壳。
   * embedded === false 是回滚路径，恒不带 --embedded / data 属性（供 CSS 与断言区分两态）。 */
  function mountRoot(root, options) {
    if (!root || !root.classList) { return; }
    root.classList.add('s-ledger');
    if (options && options.embedded === true) {
      root.classList.add(EMBED_CLASS);
      if (typeof root.setAttribute === 'function') { root.setAttribute(EMBED_ATTR, '1'); }
      return;
    }
    root.classList.remove(EMBED_CLASS);
    if (typeof root.removeAttribute === 'function') { root.removeAttribute(EMBED_ATTR); }
  }

  /* 五键取值：ctx.query 与 ctx.params 是同一份解析结果（router 的 query 恒为 params 克隆），
   * [D4-3] 同名键「后者覆盖」已由 parseHash 完成，这里只做缺省回落。 */
  function readUrlParams(ctx) {
    var query = ctx && ctx.query && typeof ctx.query === 'object' ? ctx.query : {};
    var params = ctx && ctx.params && typeof ctx.params === 'object' ? ctx.params : {};
    var raw = {};
    URL_KEYS.forEach(function (key) {
      var value = query[key];
      if (value === undefined || value === null) { value = params[key]; }
      raw[key] = value === undefined || value === null ? '' : String(value);
    });
    return raw;
  }

  function urlKeyOf(raw) {
    return URL_KEYS.map(function (key) {
      return String(raw && raw[key] !== undefined && raw[key] !== null ? raw[key] : '');
    }).join('\u0001');
  }

  /* [D4-5] month：接受 YYYY-MM-DD（取前 7 位）或合法 YYYY-MM */
  function urlMonthOf(text) {
    var value = String(text || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { return value.slice(0, 7); }
    return isValidMonth(value) ? value : '';
  }

  function sameIdList(a, b) {
    if (!a || !b || a.length !== b.length) { return false; }
    for (var i = 0; i < a.length; i += 1) {
      if (String(a[i]) !== String(b[i])) { return false; }
    }
    return true;
  }

  /* 从 persisted / lastState 这类快照还原筛选态（两处形状一致，缺的字段回默认值） */
  function stateFromSaved(saved, defaults) {
    var src = saved && typeof saved === 'object' ? saved : {};
    return {
      month: isValidMonth(src.month) ? src.month : defaults.month,
      query: String(src.query || ''),
      type: TYPE_KEYS.indexOf(src.type) >= 0 ? src.type : 'all',
      accountIds: Array.isArray(src.accountIds) ? src.accountIds.slice(0) : [],
      categoryIds: Array.isArray(src.categoryIds) ? src.categoryIds.slice(0) : [],
      minCents: typeof src.minCents === 'number' ? src.minCents : null,
      maxCents: typeof src.maxCents === 'number' ? src.maxCents : null,
      reimburseOnly: src.reimburseOnly === true,
      day: typeof src.day === 'string' ? src.day : ''
    };
  }

  function savePersisted(st) {
    var prev = persisted && persisted.bookId === st.bookId ? persisted : null;
    var derived = st.urlDerived || {};
    var month = st.month;
    var categoryIds = st.categoryIds.slice(0);
    var reimburseOnly = st.reimburseOnly === true;
    /* [D4-11] URL 派生值不得写回 persisted：值仍等于落地时由 URL 派生出来的值 ⇒ 视为用户未改动，
     * persisted 保持「访问前」的那份值（否则 #/home?month=2020-01 会污染后续无参访问）。 */
    if (derived.month && derived.month === st.month) {
      month = prev && isValidMonth(prev.month) ? prev.month : monthOf(today());
    }
    if (derived.categoryIds && sameIdList(derived.categoryIds, st.categoryIds)) {
      categoryIds = prev && Array.isArray(prev.categoryIds) ? prev.categoryIds.slice(0) : [];
    }
    if (derived.reimburseOnly === true && reimburseOnly === true) {
      reimburseOnly = prev ? prev.reimburseOnly === true : false;
    }
    persisted = {
      bookId: st.bookId,
      month: month,
      query: st.query,
      type: st.type,
      accountIds: st.accountIds.slice(0),
      categoryIds: categoryIds,
      minCents: st.minCents,
      maxCents: st.maxCents,
      reimburseOnly: reimburseOnly
    };
  }

  /* [D4-10] 记下本实例的生效态：同一五键指纹的 ctx.rerender() / 路由重建据此还原 */
  function rememberState(st) {
    lastState = {
      bookId: st.bookId,
      month: st.month,
      query: st.query,
      type: st.type,
      accountIds: st.accountIds.slice(0),
      categoryIds: st.categoryIds.slice(0),
      minCents: st.minCents,
      maxCents: st.maxCents,
      reimburseOnly: st.reimburseOnly === true,
      day: st.day || ''
    };
    lastUrlKey = st.urlKey || '';
  }

  /* [D2-16] 嵌入态月份变化回调：首页据此同步头部三列（同一个 month 只报一次） */
  function notifyMonth(st) {
    if (!st || st.dead || st.embedded !== true) { return; }
    var handler = st.opts && st.opts.onMonthChange;
    if (typeof handler !== 'function') { return; }
    if (st.notifiedMonth === st.month) { return; }
    st.notifiedMonth = st.month;
    try { handler.call(null, st.month); } catch (error) { /* 回调异常不得影响明细渲染 */ }
  }

  function createState(root, ctx, options) {
    var opts = options && typeof options === 'object' ? options : normalizeOptions(null);
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
    /* [D4-1]~[D4-7] 五键白名单解析（其余 query 一律忽略） */
    var raw = readUrlParams(ctx);
    var urlKey = urlKeyOf(raw);
    var urlMonth = urlMonthOf(raw.month);
    /* [D4-7] date 严格 YYYY-MM-DD；带日期进来时月份跟着日期走（N4：热力图 → 明细） */
    var urlDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : '';
    if (urlDate && !urlMonth) { urlMonth = urlDate.slice(0, 7); }
    var urlFlag = raw.flag === 'reimburse';      /* [D4-6] 只能打开，不能关闭 */
    var urlCa = raw.ca && raw.ca !== '' ? raw.ca : '';   /* [D4-4] 空串视为未提供 */

    /* [D4-10] 同一五键指纹的重绘（ctx.rerender / 路由重建）恒以 persisted 为准，URL 不再二次覆盖 */
    var seed = defaults;
    var reuse = !!(lastState && lastState.bookId === bookId && lastUrlKey === urlKey);
    if (reuse) {
      seed = stateFromSaved(lastState, defaults);
    } else if (persisted && persisted.bookId === bookId) {
      seed = stateFromSaved(persisted, defaults);
    }

    /* [D4-9] 首次进入优先级：URL 五键 > persisted > 默认值 */
    var month = seed.month;
    var day = seed.day;
    var reimburseOnly = seed.reimburseOnly === true;
    var categoryIds = seed.categoryIds;
    var urlDerived = {};
    if (!reuse) {
      if (urlMonth) { month = urlMonth; urlDerived.month = urlMonth; }
      if (urlDate) { day = urlDate; urlDerived.day = urlDate; }
      if (urlFlag) { reimburseOnly = true; urlDerived.reimburseOnly = true; }
      if (urlCa) { categoryIds = [urlCa]; urlDerived.categoryIds = [urlCa]; }   /* [D4-2] ca ⇒ categoryIds=[ca] */
    }

    var st = {
      root: root,
      ctx: ctx || {},
      opts: opts,
      db: db,
      bookId: bookId,
      bookName: bookNameOf(db, bookId),
      /* [D2-10] controller 的只读字段来源 */
      embedded: opts.embedded === true,
      baseHash: opts.baseHash,
      urlKey: urlKey,
      urlDerived: urlDerived,
      notifiedMonth: '',
      month: isValidMonth(month) ? month : defaults.month,
      query: seed.query,
      type: seed.type,
      accountIds: seed.accountIds,
      categoryIds: categoryIds,
      minCents: seed.minCents,
      maxCents: seed.maxCents,
      reimburseOnly: reimburseOnly,
      day: day,
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
      destroyed: false,   /* [D2-18] destroy 幂等标记 */
      nodes: {},
      cleanups: [],
      /* M4 照片批量读取：本页待读行 + render token（旧请求回包必须丢弃） */
      photoRows: [],
      renderToken: 0,
      /* M5 深链：同一 paint 生命周期只消费一次 detail；detailAction 防止删除/编辑动作被 onClose 当成普通关闭 */
      detailConsumed: false,
      detailParam: '',
      detailAction: false
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
    /* 账本切换入口：明细屏必须保留进入 #/books 的落点（任务书第二节） */
    var bookLink = el('a', {
      className: 's-ledger-book c-pressable',
      href: '#/books',
      'aria-label': '切换账本，当前 ' + st.bookName
    }, [
      iconNode('book', 16),
      el('span', { className: 's-ledger-book__name u-ellipsis', text: st.bookName })
    ]);
    row.appendChild(bookLink);
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
    /* [D2-6] ④ 嵌入态不渲染 <a href="#/stats">（R26）：同 class 的 span，无 href、无 aria-label */
    var statsLink = st.embedded
      ? el('span', { className: 's-ledger-stats-link s-ledger-summary' }, [statText])
      : el('a', {
        className: 's-ledger-stats-link s-ledger-summary',
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

    /* --- P3 筛选状态条：坐在 chips 行下方，有筛选才挂进 DOM（无筛选时不占高、querySelector 为 null） --- */
    var activebar = buildActivebar(st);
    /* 紧跟 chips 行之后挂载。注释一直写着「挂进 DOM」，但缺的正是这一步：
       只把节点存进 st.nodes 而不 append，DOM 里永远查不到 .s-ledger-activebar
       （A11b/A12/A13/A14 全查不到）。sticky 重叠时后绘制者在上，
       紧跟 chips 之后才能压在月份/汇总那一层正下方。 */
    if (activebar) { bar.appendChild(activebar); }

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

    if (activebar) {
      st.nodes.activebar = activebar;
      st.nodes.activebarText = activebar.querySelector('.s-ledger-activebar__text');
      st.nodes.activebarClear = activebar.querySelector('.s-ledger-activebar__clear');
      /* R12：一次性撤掉「类型 / 待报销 / 搜索词」三个维度，月份与日期是导航维度，保留 */
      bindActivebarClear(st, activebar);
    }

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

  /* ---------------- P3 筛选状态条（常驻可见 + 一键撤销） ---------------- */

  /* R10：只有这三个维度触达「可见筛选」；账户 / 分类 / 金额区 / 单日 仍由
   * .s-ledger-activechips 那行负责（不重复进状态条，避免同一条件说两遍）。 */
  function activebarVisible(st) {
    return st.type !== 'all' || st.reimburseOnly === true || String(st.query || '').trim() !== '';
  }

  /* R11：固定顺序 筛选： + 类型 + 仅待报销 + <N>月 + 搜索「<q>」，用 · 连接 */
  function activebarParts(st) {
    var parts = [];
    if (st.type !== 'all' && TYPE_LABEL[st.type]) { parts.push(TYPE_LABEL[st.type]); }
    if (st.reimburseOnly === true) { parts.push('仅待报销'); }
    var monthNo = Number(String(st.month || '').split('-')[1]);
    if (isFinite(monthNo) && monthNo > 0) { parts.push(monthNo + ' 月'); }
    var query = String(st.query || '').trim();
    if (query) { parts.push('搜索「' + query + '」'); }
    return parts;
  }

  /* R12：一次撤销类型 / 待报销 / 搜索词三个维度；月份与日期属导航维度，保留。
     抽成函数是因为状态条被摘除后还要能重建，重建时必须重绑同一个撤销行为。 */
  function bindActivebarClear(st, barNode) {
    if (!barNode) { return; }
    barNode.addEventListener('click', function () {
      if (st.dead) { return; }
      st.type = 'all';
      st.reimburseOnly = false;
      st.query = '';
      if (st.nodes.input) { st.nodes.input.value = ''; }
      syncCancel(st);
      paint(st);
    });
  }

  /* 状态条与 chips 行同属列表页顶栏，取 chips 的父节点即可；
     chips 尚未挂载时退回 st.nodes.bar，避免重建时抛错。 */
  function listBarOf(st) {
    var chips = st.nodes.chips;
    return (chips && chips.parentNode) || st.nodes.bar;
  }

  function buildActivebar(st) {
    if (!activebarVisible(st)) { return null; }
    var bar = el('div', {
      className: 's-ledger-activebar',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    }, [
      el('span', { className: 's-ledger-activebar__text' }),
      el('button', {
        className: 's-ledger-activebar__clear',
        type: 'button',
        'aria-label': '清除筛选',
        text: '清除'
      })
    ]);
    return bar;
  }

  /* 文案跟随筛选态；出现 / 消失则整条挂载或摘除（无筛选时 querySelector 必须为 null） */
  function syncActivebar(st) {
    var bar = st.nodes.activebar;
    if (!bar) {
      /* 曾被一键清除摘除（activebar 置 null）后又命中筛选：
         必须在这里重建，否则 paint 每次都在 !bar 处提前 return，
         状态条再也回不来（点「支出」后无反应）。 */
      if (!activebarVisible(st)) { return; }
      var fresh = buildActivebar(st);
      if (!fresh) { return; }
      st.nodes.activebar = fresh;
      st.nodes.activebarText = fresh.querySelector('.s-ledger-activebar__text');
      st.nodes.activebarClear = fresh.querySelector('.s-ledger-activebar__clear');
      bindActivebarClear(st, fresh);
      listBarOf(st).appendChild(fresh);
      bar = fresh;
      scheduleMeasure(st);   /* [D2-28] ② 状态条挂入 DOM 后吸顶条变高 */
    }
    if (!activebarVisible(st)) {
      var hadBar = !!bar.parentNode;
      if (bar.parentNode) { bar.parentNode.removeChild(bar); }
      st.nodes.activebar = null;
      st.nodes.activebarText = null;
      st.nodes.activebarClear = null;
      if (hadBar) { scheduleMeasure(st); }   /* [D2-28] ② 状态条移出 DOM 后吸顶条变矮 */
      return;
    }
    if (!bar.parentNode && st.nodes.chips && st.nodes.chips.parentNode) {
      st.nodes.chips.parentNode.insertBefore(bar, st.nodes.chips.nextSibling);
      scheduleMeasure(st);   /* [D2-28] ② 状态条重新挂载 */
    }
    if (st.nodes.activebarText) {
      st.nodes.activebarText.textContent = '筛选：' + activebarParts(st).join(' · ');
    }
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
    /* [D2-6] ⑤ 嵌入态 hasAny === false 时不渲染跳 #/add 的 CTA（R27）：底栏已有「记一笔」 */
    box.appendChild(el('p', {
      className: 's-ledger-empty__text',
      text: hasAny
        ? '换个关键词，或清除筛选看看全部流水。'
        : (st.embedded ? '使用底部『记一笔』新增流水' : '换个账本或月份，也可以现在记一笔。')
    }));
    /* 「清除筛选」是纯筛选动作，两态都保留；只有跳 #/add 的 CTA 在嵌入态消失 */
    if (hasAny || !st.embedded) {
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
    }
    return box;
  }

  function categorySlot(st, categoryId) {
    var categories = rows(st.db, 'categories');
    for (var i = 0; i < categories.length; i += 1) {
      if (categories[i] && categories[i].id === categoryId) { return (i % 12) + 1; }
    }
    return 12;
  }

  /* ---------------- M4：媒体列三态（列表行） ---------------- */

  /* 唯一的媒体 DOM 入口：优先用 XZB.ui.kit.mediaCell（c-photo-cell 家族）；
   * 老包缺件时退回同 class 的最小结构，保证三态在运行时都有可渲染的节点。 */
  function mediaCellNode(spec) {
    var kit = kitApi();
    if (kit && typeof kit.mediaCell === 'function') {
      try { return kit.mediaCell(spec); } catch (error) { /* 走本地兜底 */ }
    }
    var s = spec || {};
    var kind = s.media === 'thumb' || s.media === 'skeleton' || s.media === 'icon' || s.media === 'placeholder'
      ? s.media
      : (s.url ? 'thumb' : (s.icon ? 'icon' : 'placeholder'));
    var cell = el('span', { className: 'c-photo-cell c-photo-cell--' + kind });
    if (kind === 'thumb' && s.url) {
      var img = el('img', { className: 'c-photo-cell__img', alt: '', src: String(s.url) });
      cell.appendChild(img);
      if (Number(s.count) > 1) {
        var badge = el('span', { className: 'c-photo-badge', text: Number(s.count) > 99 ? '99+' : String(s.count) });
        badge.setAttribute('aria-hidden', 'true');
        cell.appendChild(badge);
      }
      return cell;
    }
    if (kind === 'skeleton') {
      cell.appendChild(el('span', { className: 'c-photo-skel' }));
      cell.appendChild(el('span', { className: 'u-sr-only', text: '照片加载中' }));
      return cell;
    }
    if (kind === 'icon') {
      var tile = el('span', { className: 'c-tile c-tile--lg' + (s.tone ? ' c-tile--' + s.tone : '') });
      tile.appendChild(iconNode(s.icon || 'ellipsis', 32));
      cell.appendChild(tile);
      return cell;
    }
    cell.appendChild(el('span', { className: 'c-photo-empty', text: '照片不可用' }));
    return cell;
  }

  /* 无照片：44px 分类色圆底 + 32px 分类图标，居中放在同一个 64px 媒体列（UI.md §6.3） */
  function renderIconMedia(cell, iconName, slot) {
    clearNode(cell);
    cell.removeAttribute('data-photo-key');
    cell.setAttribute('data-photo-state', 'idle');
    var kit = kitApi();
    if (kit && typeof kit.mediaCell === 'function') {
      try {
        /* kit 的 icon 分支是 19/22px；这里要 32px，于是保留它的 c-photo-cell 外壳、内部自建 tile */
        var shell = el('span', { className: 'c-photo-cell c-photo-cell--icon' });
        var tile = el('span', { className: 's-ledger-item__cat c-tile c-tile--lg c-tile--cat-' + slot });
        tile.appendChild(iconNode(iconName, 32));
        shell.appendChild(tile);
        cell.appendChild(shell);
        return;
      } catch (error) { /* 走本地兜底 */ }
    }
    cell.appendChild(mediaCellNode({ media: 'icon', icon: iconName, tone: 'cat-' + slot }));
  }

  function renderSkeletonMedia(cell) {
    clearNode(cell);
    cell.removeAttribute('data-photo-key');
    cell.setAttribute('data-photo-state', 'loading');
    cell.appendChild(mediaCellNode({ media: 'skeleton' }));
  }

  function renderUnavailableMedia(cell) {
    clearNode(cell);
    cell.removeAttribute('data-photo-key');
    cell.setAttribute('data-photo-state', 'failed');
    cell.appendChild(mediaCellNode({ media: 'placeholder' }));
    /* 可见文案由占位块承载；再补一个无障碍标签，读屏也能听到失败语义 */
    cell.setAttribute('aria-label', '照片不可用');
  }

  function renderThumbMedia(cell, ref, slot) {
    var variant = slot.thumb ? 'thumb' : 'full';
    var key = variant === 'thumb' ? thumbKeyOf(slot.id) : fullKeyOf(slot.id);
    var url = key ? photoUrlOf(key, slot.blob) : '';
    if (!url) { renderUnavailableMedia(cell); return; }
    clearNode(cell);
    cell.removeAttribute('aria-label');
    cell.setAttribute('data-photo-key', key);
    cell.setAttribute('data-photo-state', 'ready');
    var node = mediaCellNode({
      media: 'thumb',
      url: url,
      photoId: slot.id,
      variant: variant,
      count: ref.photoIds.length,
      alt: ''
    });
    var img = node.querySelector ? node.querySelector('img') : null;
    if (img) {
      img.addEventListener('error', function () {
        /* 破图：只替换这一个媒体区，行仍可点开详情；不自动重试、不影响其它行 */
        if (!cell.isConnected) { return; }
        clearNode(cell);
        cell.removeAttribute('data-photo-key');
        renderUnavailableMedia(cell);
      });
    }
    cell.appendChild(node);
  }

  function failPhotoRows(refs) {
    for (var i = 0; i < refs.length; i += 1) {
      var ref = refs[i];
      if (!ref || !ref.cell || !ref.cell.isConnected) { continue; }
      /* 没有照片的行在 buildItem 已经渲染成分类图标，不该被批量读取的失败连带标成「照片不可用」 */
      if (!ref.photoIds || !ref.photoIds.length) { continue; }
      renderUnavailableMedia(ref.cell);
    }
  }

  /* 当前页一次性批量读取（CONTRACT §照片批量读取契约）：
   *   · 只调一次 XZB.app.photos.get(ids)，绝不逐行 N+1；
   *   · 回包必须校验 st.dead + renderToken，旧请求不得写进新页面；
   *   · 返回长度不符 / 非数组 / ok:false 一律按失败态，坏包不炸。 */
  function loadPhotosForRows(st, refs) {
    if (!st || st.dead || !refs || !refs.length) { return; }
    var ids = [];
    var seen = Object.create(null);
    var byId = Object.create(null);
    for (var i = 0; i < refs.length; i += 1) {
      var ref = refs[i];
      if (!ref || !ref.photoIds || !ref.photoIds.length) { continue; }
      for (var j = 0; j < ref.photoIds.length; j += 1) {
        var id = String(ref.photoIds[j]);
        if (seen[id]) { continue; }
        seen[id] = true;
        byId[id] = ids.length;
        ids.push(id);
      }
    }
    if (!ids.length) { return; }

    var token = st.renderToken;
    var photos = photosApi();
    if (!photos || typeof photos.get !== 'function') {
      failPhotoRows(refs);
      return;
    }
    var pending;
    try { pending = photos.get(ids.slice()); } catch (error) { pending = null; }
    Promise.resolve(pending).then(function (result) {
      /* A6：过期请求（换页 / 换筛选 / 离开路由）不写 DOM，也不释放当前屏的键 */
      if (!st || st.dead || st.renderToken !== token) { return; }
      var records = result && Array.isArray(result.records) ? result.records : null;
      if (!result || result.ok !== true || !records || records.length !== ids.length) {
        failPhotoRows(refs);
        return;
      }
      var slots = photoSlots(ids, records);
      if (!slots || slots.length !== ids.length) { failPhotoRows(refs); return; }
      for (var k = 0; k < refs.length; k += 1) {
        var rowRef = refs[k];
        if (!rowRef || !rowRef.cell || !rowRef.cell.isConnected) { continue; }
        /* 无照片行已渲染为分类图标，不参与本轮回写：否则 chosen 恒为 null 会被误判成失败态 */
        if (!rowRef.photoIds || !rowRef.photoIds.length) { continue; }
        var chosen = null;
        var missingInRow = 0;
        for (var m = 0; m < rowRef.photoIds.length; m += 1) {
          var pos = byId[String(rowRef.photoIds[m])];
          if (pos !== undefined && slots[pos]) {
            if (!chosen) { chosen = slots[pos]; }
          } else {
            missingInRow += 1;
          }
        }
        if (chosen) {
          renderThumbMedia(rowRef.cell, rowRef, chosen);
          if (missingInRow > 0) {
            rowRef.cell.setAttribute('data-photo-state', 'partial');
            /* 读屏要知道缺了几张：可见区只有缩略图与总数徽标，缺数量只能走 u-sr-only */
            rowRef.cell.appendChild(el('span', { className: 'u-sr-only', text: '缺失 ' + missingInRow + ' 张' }));
          }
        } else {
          renderUnavailableMedia(rowRef.cell);
        }
      }
    }, function () {
      if (!st || st.dead || st.renderToken !== token) { return; }
      failPhotoRows(refs);
    });
  }

  function buildItem(st, tx) {
    var maps = st.maps;
    var isTransfer = tx.type === 'transfer';
    var isIncome = tx.type === 'income';
    var cents = Math.abs(Number(tx.amountCents) || 0);
    var cat = maps.categories[tx.categoryId] || null;
    var title = isTransfer ? '转账' : (cat && cat.name ? String(cat.name) : '未分类');
    /* P1 副标题拆行（SPEC R1–R4 / R8–R9）：
       sub1 = 账户（转账为 from → to），sub2 = 备注；原 __sub 保留为视觉高度 0 的完整语义串。
       账户查不到（不存在 / 已软删）⇒ sub1 显示「未指定账户」并挂 --muted（R3）。 */
    var fromAcc = tx.accountId ? (maps.accounts[tx.accountId] || null) : null;
    var fromName = fromAcc ? accountName(fromAcc) : '未指定账户';
    var fromMuted = !fromAcc;
    var toName = '';
    var toMuted = false;
    if (isTransfer) {
      var toAcc = tx.toAccountId ? (maps.accounts[tx.toAccountId] || null) : null;
      toName = toAcc ? accountName(toAcc) : '未指定账户';
      toMuted = !toAcc;
    }
    var noteText = tx.note === undefined || tx.note === null ? '' : String(tx.note).trim();
    var sub1 = isTransfer ? fromName + ' \u2192 ' + toName : fromName;
    var sub = noteText ? sub1 + ' \u00b7 ' + noteText : sub1;
    var iconName = isTransfer ? 'transfer' : (cat && cat.icon ? String(cat.icon) : 'ellipsis');
    var slot = isTransfer ? 2 : categorySlot(st, tx.categoryId);
    var photoIds = photoIdList(tx);

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
    var amountText = isTransfer ? fmt(cents) : (isIncome ? '+' : '-') + fmt(cents);
    var mainLabel = title + ' ' + (isTransfer ? fmt(cents) : (isIncome ? '收入 ' : '支出 ') + fmt(cents));
    var kit = kitApi();
    if (photoIds.length) {
      mainLabel = kit && typeof kit.photoAriaLabel === 'function'
        ? kit.photoAriaLabel(mainLabel, photoIds.length)
        : mainLabel + '，含 ' + photoIds.length + ' 张照片';
    }
    /* 词表唯一：行容器与部件一律 s-ledger-item*（ledger.css 已有整套规则）。
       外层 wrap 已是 s-ledger-item，这里不再重复挂；s-ledger-row 已作废。 */
    var main = el('a', {
      className: 's-ledger-item__main',
      href: '#/ledger?detail=' + encodeURIComponent(String(tx.id || '')),
      'aria-label': mainLabel
    });
    /* 链接原生支持 Enter；Space 在部分浏览器不触发 click，这里补齐
       （与首页 a.s-home-row 的无障碍口径一致，见 home.js 的同一段注释） */
    main.addEventListener('keydown', function (event) {
      if (event.key !== ' ' && event.key !== 'Spacebar') { return; }
      event.preventDefault();
      if (typeof main.click === 'function') { main.click(); }
    });

    /* 第一列：64px 媒体区。无照片 = 分类图标；有照片 = 骨架 → 缩略图 / 占位（一行只放一张） */
    var media = el('span', {
      className: 's-ledger-item__media c-row__media',
      dataset: { id: String(tx.id || '') }
    });
    if (photoIds.length) { renderSkeletonMedia(media); }
    else { renderIconMedia(media, iconName, slot); }
    main.appendChild(media);

    /* 第二列：文字区；min-width:0 + 省略全部交给 CSS 类，不写内联样式 */
    var mainText = el('span', { className: 's-ledger-item__text c-row__main' });
    mainText.appendChild(el('span', {
      className: 's-ledger-item__title c-row__title u-ellipsis',
      text: title
    }));
    var subLine = el('span', { className: 's-ledger-item__sub c-row__sub u-ellipsis' });
    /* sub1：账户行（转账 from → to）。muted = 账户缺失/已软删（R3）。
       垫付待报销的行保留「待报」标记：原挂在旧副标题行 __sub 上、位于文本之前；
       P1 拆行后 __sub 已退化为视觉高度 0，标记若留在其中就成了不可见，
       故前移到第 1 行行首（第 2 行无备注时整体 hidden，标记会跟着消失，不能用）。 */
    var sub1Node = el('span', {
      className: 's-ledger-item__sub1' + (fromMuted || toMuted ? ' s-ledger-item__sub1--muted' : '')
    });
    if (tx.reimburse === 'pending') {
      sub1Node.appendChild(el('span', { className: 's-ledger-item__flag', text: '待报' }));
    }
    sub1Node.appendChild(document.createTextNode(sub1));
    /* sub2：备注行。为空整行不渲染（hidden ⇒ 高度 0，R2） */
    var sub2Node = el('span', { className: 's-ledger-item__sub2', text: noteText });
    if (!noteText) { sub2Node.hidden = true; }
    /* 原 __sub 节点保留：仍是完整「账户 · 备注」串，但视觉高度为 0（R9 / A9）。
       里面放纯文本，不加 role 以免与行级 aria-label 重复播报。 */
    subLine.appendChild(document.createTextNode(sub));
    mainText.appendChild(sub1Node);
    mainText.appendChild(sub2Node);
    mainText.appendChild(subLine);
    main.appendChild(mainText);

    /* 第三列：金额区。正负号承担收支语义，文字恒深色（不再用红绿） */
    var trail = el('span', { className: 's-ledger-item__trail s-ledger-item__value c-row__value' });
    trail.appendChild(el('span', {
      className: 's-ledger-item__amount u-tabular',
      text: amountText
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
      attemptDelete(st, tx, 'swipe');
    });
    /* N3：单击先看详情；href 同时保留深链形态（home.js 产生的 #/ledger?detail= 同构） */
    main.addEventListener('click', function (event) {
      event.preventDefault();
      openDetailSheet(st, tx);
    });
    bindGesture(st, wrap, surface, tx);

    /* 本页待批量读取的引用；appendPage 统一取走，避免跨页累积（单测/旧调用无 photoRows 时静默跳过） */
    if (st && Array.isArray(st.photoRows)) {
      st.photoRows.push({ tx: tx, cell: media, photoIds: photoIds });
    }
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

    /* 2.17.1 方向仲裁：触摸设备上先由 touchmove 决定这次手势归谁。
       浏览器一旦开始滚动，指针流会被 pointercancel 掐断、行再也拖不动，
       所以第一帧必须先 preventDefault 把滚动压住，再判断是横滑还是滚动。
       在完成「判断」之前绝不放手，宁可晚一帧再交还给系统滚动。 */
    var touchAxis = '';       /* '' 未定 | 'x' 横滑（整段压住滚动） | 'y' 交还滚动 */
    var touchX = 0;
    var touchY = 0;
    var touchBlocked = false;

    function onTouchStart(event) {
      touchAxis = '';
      touchBlocked = false;
      if (st.dead || !event.touches || event.touches.length !== 1) { return; }
      if (event.target && event.target.closest && event.target.closest('.s-ledger-item__actions')) {
        touchAxis = 'y';
        return;
      }
      touchX = event.touches[0].clientX;
      touchY = event.touches[0].clientY;
    }

    function onTouchMove(event) {
      if (st.dead || touchAxis === 'y') { return; }
      if (!event.touches || event.touches.length !== 1) { return; }
      var ax = Math.abs(event.touches[0].clientX - touchX);
      var ay = Math.abs(event.touches[0].clientY - touchY);
      if (touchAxis === 'x') {
        if (event.cancelable) { event.preventDefault(); }
        return;
      }
      /* 还没定方向：这一帧先吃掉，避免浏览器抢先开滚 */
      if (event.cancelable) { event.preventDefault(); }
      touchBlocked = true;
      if (ax >= 4 && ax * 1.25 >= ay) {
        touchAxis = 'x';
        return;
      }
      if (ay >= 6 && ay > ax * 1.25) {
        /* 明确纵向：从下一帧起不再 preventDefault，滚动照常 */
        touchAxis = 'y';
      }
    }

    function onTouchEnd() {
      touchAxis = '';
      touchBlocked = false;
    }

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
        if (touchAxis !== 'x' && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
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
      var wasDragging = dragging;
      var wasDelta = delta;
      active = false;
      dragging = false;
      surface.style.transition = '';
      /* 横滑已经锁定时被 cancel，不该把行弹回去（用户的手势意图是滑动，不是取消） */
      if (wasDragging && touchAxis === 'x') {
        if (wasDelta <= SWIPE_OPEN / 2) { open(); } else { close(); }
      } else {
        close();
      }
      onTouchEnd();
    });

    wrap.addEventListener('touchstart', onTouchStart, { passive: false });
    wrap.addEventListener('touchmove', onTouchMove, { passive: false });
    wrap.addEventListener('touchend', onTouchEnd, { passive: true });
    wrap.addEventListener('touchcancel', onTouchEnd, { passive: true });

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

  /* [D4-8] 清参用的 baseHash：五键参数一律取 live 状态（不取 URL 快照），detail 恒删。
   * 路径优先取宿主给的 options.baseHash（首页传 '#/home…'），否则按当前视图拼；
   * 编码一律经 XZB.router.hash（D7-2：禁止字符串拼接注入 query）。 */
  function liveParams(st) {
    var params = {};
    if (isValidMonth(st.month)) { params.month = st.month; }
    if (st.reimburseOnly === true) { params.flag = 'reimburse'; }
    if (st.categoryIds.length === 1) { params.ca = st.categoryIds[0]; }
    if (st.day && String(st.day).slice(0, 7) === st.month) { params.date = st.day; }
    return params;
  }

  function baseHashOf(st) {
    if (!st) { return '#/home'; }
    var routerApi = XZB.router || XZB.Router || null;
    var view = st.embedded === true ? 'home' : 'ledger';
    var sub = '';
    var extra = {};
    var base = typeof st.baseHash === 'string' ? st.baseHash : '';
    var route = null;
    if (base && routerApi && typeof routerApi.parse === 'function') {
      try { route = routerApi.parse(base); } catch (error) { route = null; }
    }
    if (route && route.view) {
      /* 嵌入态视图恒为 home（D4-8）；其余模式沿用 baseHash 自己的路径 */
      if (st.embedded !== true) { view = String(route.view); }
      sub = String(route.sub || '');
      extra = route.params && typeof route.params === 'object' ? route.params : {};
    }
    /* R6「其余 query 原值保留」：非五键、非 detail 的键原样带过去 */
    var params = {};
    Object.keys(extra).forEach(function (key) {
      if (key === 'detail' || URL_KEYS.indexOf(key) >= 0) { return; }
      params[key] = extra[key];
    });
    var liveQuery = liveParams(st);
    Object.keys(liveQuery).forEach(function (key) { params[key] = liveQuery[key]; });
    if (routerApi && typeof routerApi.hash === 'function') {
      try { return routerApi.hash({ view: view, sub: sub, params: params }); } catch (error) { /* 退回静态路径 */ }
    }
    return '#/' + view;
  }

  /* [R6]/[D4-13] 关闭详情只删 detail：经 ctx.replace 走 router（屏内不直写 history） */
  function clearDetailParam(st) {
    if (!st || !st.detailParam) { return; }
    var ctx = st.ctx;
    st.detailParam = '';
    if (!ctx || typeof ctx.replace !== 'function') { return; }
    var target = baseHashOf(st);
    if (!target) { return; }
    try { ctx.replace(target); } catch (error) { /* 清参失败不影响已关闭的面板 */ }
  }

  /* P0-1 情境入口开关：默认开，「我的」里可关（与解读页/首页同一开关） */
  function assistantEntryOn(st) {
    var prefs = (st && st.ctx && st.ctx.prefs) || (XZB.app && XZB.app.prefs);
    var v = null;
    if (prefs && typeof prefs.get === 'function') {
      try { v = prefs.get('assistant.contextualEntry'); } catch (error) { v = null; }
    }
    return v !== false;
  }

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
    /* 备注必须是完整文本（SPEC N4.8 / N5.x）：不截断、不折成摘要，换行由 __val 的 word-break 承担 */
    if (tx.note) { lines.push(['备注', String(tx.note)]); }
    if (Array.isArray(tx.tags) && tx.tags.length) { lines.push(['标签', '#' + tx.tags.join(' #')]); }
    if (tx.reimburse === 'pending') { lines.push(['报销', '待报销（垫付）']); }
    var list = el('div', { className: 's-ledger-detail__list' });
    lines.forEach(function (pair) {
      var row = el('div', { className: 's-ledger-detail__row' });
      row.appendChild(el('span', { className: 's-ledger-detail__key', text: pair[0] }));
      var value = el('span', {
        className: 's-ledger-detail__val' + (pair[0] === '备注' ? ' s-ledger-detail__val--note' : ''),
        text: pair[1]
      });
      row.appendChild(value);
      list.appendChild(row);
    });
    body.appendChild(list);

    /* 照片区：无图 → 「未添加」文本行（不渲染空网格）；有图 → loading → ready/partial/failed */
    var photoArea = attachDetailPhotos(st, tx, list, body);

    /* P0-1 情境入口：把这笔账带进小助手（只读摘要卡 + 追问 Chip，不写任何数据） */
    if (assistantEntryOn(st)) {
      var askBtn = el('button', { className: 'c-btn c-btn--secondary s-ledger-detail__ask', type: 'button', text: '问问小助手这笔账' });
      askBtn.setAttribute('aria-label', '带这笔账的上下文打开小助手');
      askBtn.addEventListener('click', function () {
        navigate(st, '#/assistant?from=ledger&tx=' + encodeURIComponent(String(tx.id || '')));
      });
      body.appendChild(askBtn);
    }

    photoDetailOpen = false;   /* 先落白：旧 sheet 的 onClose 可能在 sheet.open() 内部先触发 */
    sheet.open({
      title: '这笔流水',
      content: body,
      onClose: function (reason) {
        photoDetailOpen = false;
        flushPhotoUrls();      /* 面板已关，其缩略图 URL 若无人再持有则此刻释放 */
        if (reason === 'replaced' || reason === 'route') { st.detailAction = false; return; }
        if (st.detailAction) { st.detailAction = false; return; } /* 删除/编辑动作：由动作自己收尾 */
        clearDetailParam(st);  /* 深链消费后关闭：replace 清参，不新增历史 */
      },
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
            st.detailAction = true;
            navigate(st, '#/add?id=' + encodeURIComponent(String(tx.id || '')));
          }
        },
        {
          label: '删除',
          kind: 'danger',
          onClick: function () {
            st.detailAction = true;
            attemptDelete(st, tx, 'detail');
          }
        }
      ]
    });
    photoDetailOpen = !!photoArea && photoIdList(tx).length > 0;   /* 无照片时句柄为 null；再按张数兜底，绝不长期占住 flush */
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
    /* 修既有缺陷：原先是裸调 todayStr()，但本文件作用域内没有该函数（只有 dates.todayStr），
     * 运行到这里会抛 ReferenceError ⇒「复制为新记录」整条链路不可用，C-2 也就无从谈。
     * 改用本屏自己的 today()（内部已按 dates.todayStr → 本地日期兜底）；变量名不能再叫 today，否则 var 提升会遮蔽同名函数。 */
    var todayValue = today();
    var source = assign({}, tx, {
      id: undefined,
      date: todayValue,
      time: dates && typeof dates.nowTime === 'function' ? dates.nowTime() : '',
      deleted: false,
      deletedAt: null,
      reimburse: tx.type === 'expense' && tx.reimburse === 'pending' ? 'pending' : 'none'
    });
    /* SPEC C-2 / PLAN §1.5 裁决 7 / UI.md §2.5.3 方案 A：复制品不得共享原流水的照片引用。
     * photos 表无引用计数（PLAN §10-5），若复制品沿用 src.photoIds，删掉其中一条会把照片物理删掉，
     * 另一条立刻变悬空引用 ⇒ 复制出的新流水 photoIds 恒为 []（照片不跟着复制）。 */
    source.photoIds = [];
    var entity = null;
    if (schema && typeof schema.createTransaction === 'function') {
      entity = schema.createTransaction(source);
    }
    if (!entity) {
      toast('复制失败，请重试', { type: 'danger' });
      return;
    }
    /* 兜底：若 createTransaction 的白名单漏掉 photoIds，也不允许旧引用被带进新流水 */
    try { entity.photoIds = []; } catch (error) { /* 冻结对象：source 已置空，忽略 */ }
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

  /* ---------------- M6：删除两段式（先确认，再软删） ---------------- */

  function deleteAmountText(tx) {
    var cents = Math.abs(Number(tx && tx.amountCents) || 0);
    if (tx && tx.type === 'income') { return '+' + fmt(cents); }
    if (tx && tx.type === 'transfer') { return fmt(cents); }
    return '-' + fmt(cents);
  }

  /* 第一段：只弹既有 sheet，不碰任何数据。取消/返回 = 零副作用。 */
  function attemptDelete(st, tx, source) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function' || !tx) { return; }
    var category = tx.type === 'transfer' ? '转账' : categoryName(tx, st.maps);
    var body = el('div', { className: 's-ledger-delete' });
    body.appendChild(el('p', {
      className: 's-ledger-delete__target',
      text: category + ' ' + deleteAmountText(tx)
    }));
    body.appendChild(el('p', {
      className: 's-ledger-delete__hint',
      text: '删除后 5 秒内可以撤销'
    }));

    var busy = false;
    var settled = false;
    var reopenDetail = false;
    var handle = null;

    function setBusy(on) {
      busy = on;
      if (!handle || !handle.element || typeof handle.element.querySelectorAll !== 'function') { return; }
      var buttons = handle.element.querySelectorAll('.c-btn');
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].disabled = on === true;
        if (on) { buttons[i].setAttribute('aria-disabled', 'true'); }
        else { buttons[i].removeAttribute('aria-disabled'); }
      }
    }

    handle = sheet.open({
      title: '删除这条记录？',
      content: body,
      className: 's-ledger-delete-sheet',
      onClose: function (reason) {
        if (settled || busy) { return; }
        if (st) { st.detailAction = false; }
        if (reopenDetail) {
          /* 删除失败且来自详情：等确认层真正移除后再恢复详情，避免两层互相 replace */
          reopenDetail = false;
          if (st && !st.dead) { openDetailSheet(st, tx); }
          return;
        }
        if (reason === 'replaced' || reason === 'route') { return; }
        /* 取消/点背景/返回：只清深链参数，不修改数据 */
        clearDetailParam(st);
      },
      actions: [
        {
          label: '取消',
          kind: 'text',
          onClick: function () { return busy ? false : true; }
        },
        {
          label: '删除',
          kind: 'danger',
          onClick: function () {
            if (busy) { return false; }              /* 确认期间防重复提交：连点只发一次 commit */
            setBusy(true);
            doDelete({ txId: tx.id, st: st, source: source }).then(function (result) {
              if (result && result.ok) {
                settled = true;
                if (st) { st.detailAction = false; }
                if (handle && typeof handle.close === 'function') { handle.close('deleted'); }
                return;
              }
              /* 失败：原行、详情、存储都保持；恢复按钮；详情来源则回到详情（不弹空面板） */
              setBusy(false);
              if (source === 'detail' && st && !st.dead) {
                reopenDetail = true;
                if (handle && typeof handle.close === 'function') { handle.close('failed'); }
              }
            });
            return false;                          /* 结果回来前不自动关层 */
          }
        }
      ]
    });
    setBusy(false);
  }

  /* 第二段：唯一删除 commit 路径。只软删（deleted/deletedAt/updatedAt），
   * 保留 photoIds 与 photos store —— 撤销后照片必须还能显示（SPEC A17/A19）。 */
  function doDelete(options) {
    var opts = options || {};
    var txId = String(opts.txId || '');
    var st = opts.st || live;
    var app = appApi();
    var commit = st && st.ctx && typeof st.ctx.commit === 'function' ? st.ctx.commit : (app && app.commit);
    if (typeof commit !== 'function') {
      toast('删除失败，请重试', { type: 'danger' });
      return Promise.resolve({ ok: false, code: 'E_COMMIT' });
    }
    var nowIso = dates && typeof dates.nowIso === 'function' ? dates.nowIso() : new Date().toISOString();
    var hadDetail = !!(st && st.detailParam);

    var pending;
    try {
      pending = commit(function (working) {
        var list = working && working.transactions ? working.transactions : null;
        if (!list) { return { abort: true, code: 'E_STORE_TX', message: messageOf('E_STORE_TX') }; }
        var target = null;
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].id === txId) { target = list[i]; break; }
        }
        if (!target || target.deleted === true) {
          return { abort: true, code: 'E_TX_NOT_FOUND', message: '记录已删除或不存在' };
        }
        if (schema && typeof schema.normalizeTransaction === 'function') {
          var patch = {};
          var keys = Object.keys(target);
          for (var k = 0; k < keys.length; k += 1) { patch[keys[k]] = target[keys[k]]; }
          patch.deleted = true;
          patch.deletedAt = nowIso;
          patch.updatedAt = nowIso;
          /* photoIds 原样保留：这里绝不 delete/清空，也不触碰 photos store */
          list[i] = schema.normalizeTransaction(patch, nowIso);
        } else {
          target.deleted = true;
          target.deletedAt = nowIso;
          target.updatedAt = nowIso;
        }
        return { value: { id: txId } };
      }, { label: '删除流水' });
    } catch (error) {
      toast('删除失败，请重试', { type: 'danger' });
      return Promise.resolve({ ok: false, code: 'E_COMMIT' });
    }

    return Promise.resolve(pending).then(function (result) {
      if (!result || !result.ok) {
        var text = result && result.code === 'E_TX_NOT_FOUND'
          ? '记录已删除或不存在'
          : messageOf(result && result.code, result && result.message);
        toast(text, { type: 'danger' });
        return { ok: false, code: result && result.code };
      }
      toast('已删除', {
        type: 'success',
        action: {
          label: '撤销',
          onClick: function () {
            if (app && typeof app.undo === 'function') {
              var undone = app.undo();
              /* 真机 manifest 的 undo 会 commit + 整屏重绘；若被测试桩替换成同步函数，这里补一次本地重绘 */
              if (undone && typeof undone.then === 'function') {
                undone.then(function () { if (st && !st.dead) { paint(st); } }, function () { /* undo 自己会提示 */ });
              } else if (st && !st.dead) {
                paint(st);
              }
            }
          }
        }
      });
      /* 成功重绘由 ctx.commit 的 refresh→router.rerender 完成（日期组为空自然没有组头）。
       * 深链来源还要清掉 ?detail，避免下一次进入又消费一次。 */
      if (hadDetail) { clearDetailParam(st); }
      else if (st && !st.dead) { paint(st); }
      return { ok: true };
    }, function () {
      toast('删除失败，请重试', { type: 'danger' });
      return { ok: false, code: 'E_COMMIT' };
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

  function openFilterSheet(st, options) {
    var opts = options && typeof options === 'object' ? options : {};
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

    /* [D2-9] openCategoryFilter()：打开既有筛选 sheet 并定位分类区（不新建第二套筛选 UI） */
    if (opts.focusCategory) {
      global.setTimeout(function () {
        if (st.dead) { return; }
        try {
          if (typeof catGroup.scrollIntoView === 'function') { catGroup.scrollIntoView({ block: 'center' }); }
        } catch (error) { /* 老 WebView 不支持带参 scrollIntoView */ }
        if (typeof catInput.focus === 'function') { catInput.focus(); }
      }, 0);
    }
    return handle;
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
    var wasOpen = st.nodes.search.classList.contains('is-open');
    st.nodes.search.classList.add('is-open');
    /* [D2-28] ① 搜索框展开改变了吸顶条高度 → 重算日期头偏移 */
    if (!wasOpen) { scheduleMeasure(st); }
  }

  function syncCancel(st) {
    if (!st.nodes.cancel) { return; }
    var focused = document.activeElement === st.nodes.input;
    var open = !!st.query || focused || (st.nodes.search && st.nodes.search.classList.contains('is-open'));
    st.nodes.cancel.classList.toggle('is-hidden', !open);
    st.nodes.search && st.nodes.search.classList.toggle('is-active', open);
    if (!open) {
      var wasOpen = !!(st.nodes.search && st.nodes.search.classList.contains('is-open'));
      st.nodes.search && st.nodes.search.classList.remove('is-open');
      /* [D2-28] ① 收起后吸顶条变矮，同样要重算 */
      if (wasOpen) { scheduleMeasure(st); }
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
    /* [D2-6] ① 嵌入态不打 syncTitle：document.title 恒为「首页 · 小账本」（R25/A13） */
    if (st && st.embedded === true) { return; }
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

  /* [D2-25] 吸顶偏移一律读实际计算值：首页没有 .app-nav，用常量 44 会多顶一段（A16）。
   * 只有 getComputedStyle 不可用（测试桩）时才退回 options.stickyTop → .app-nav 高度兜底。
   * 本函数内不得出现 embedded 分支：两态共用同一套算法。 */
  function measureSticky(st) {
    if (!st || !st.nodes) { return; }
    var stickyTop = 0;
    if (st.nodes.sticky && typeof global.getComputedStyle === 'function') {
      try { stickyTop = parseFloat(global.getComputedStyle(st.nodes.sticky).top) || 0; } catch (error) { stickyTop = 0; }
    } else if (st.opts && typeof st.opts.stickyTop === 'number' && isFinite(st.opts.stickyTop)) {
      stickyTop = st.opts.stickyTop;
    } else {
      var scroller = st.scroller;
      var nav = scroller && scroller.querySelector ? scroller.querySelector('.app-nav') : null;
      stickyTop = nav ? nav.offsetHeight : 0;
    }
    var stickyHeight = st.nodes.sticky ? st.nodes.sticky.offsetHeight : 0;
    st.stickTop = stickyTop + stickyHeight;
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
    /* 本页所有 photoIds 已由 buildItem 收集到 st.photoRows；这里只发起一次批量读取。
     * 先上屏再读：文字/金额立即可用，照片区停在 64px 骨架，不阻塞整页（CONTRACT §三态）。 */
    var refs = st.photoRows.splice(0);
    loadPhotosForRows(st, refs);
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

  /* ---------------- M5：深链 ?detail= 消费（render → 上屏 → paint 之后） ---------------- */

  function raf(fn) {
    if (global.requestAnimationFrame) { return global.requestAnimationFrame(fn); }
    return global.setTimeout(fn, 16);
  }

  function consumeDetailParam(st) {
    if (!st || st.dead || st.detailConsumed) { return; }
    var params = st.ctx && st.ctx.params ? st.ctx.params : null;
    var raw = params ? params.detail : '';
    if (raw === undefined || raw === null || raw === '') { return; }
    st.detailConsumed = true;                    /* 同一 paint 生命周期只消费一次，连点/重绘不重复打开 */
    var txId = String(raw);
    try { txId = decodeURIComponent(txId); } catch (error) { /* 已是明文就保持原样 */ }
    var db = readDb(st.ctx);
    var list = rows(db, 'transactions');
    var target = null;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && String(list[i].id) === txId && list[i].deleted !== true) { target = list[i]; break; }
    }
    if (!target) {
      /* 软删/不存在：提示恰一次，不弹空详情，并清参（replace，不新增历史） */
      st.detailParam = txId;
      toast('记录已删除或不存在', { type: 'danger' });
      clearDetailParam(st);
      return;
    }
    st.detailParam = txId;
    openDetailSheet(st, target);
  }

  /* paint 完成且 DOM 真正上屏后：先做一次 URL 回收，再消费深链。
   * 必须等 swapDom，否则 flush 会把「旧屏 DOM 仍引用」的键误放、深链也会在 render 阶段抢跑。 */
  function scheduleAfterPaint(st) {
    var token = st.renderToken;
    var attempts = 0;
    function tick() {
      if (!st || st.dead || st.renderToken !== token) { return; }
      if (!st.root || st.root.isConnected !== true) {
        attempts += 1;
        if (attempts < 30) { raf(tick); }
        return;
      }
      flushPhotoUrls();
      consumeDetailParam(st);
    }
    raf(tick);
  }

  function paint(st) {
    if (st.dead) { return; }
    /* P3 筛选状态条：文案随 type / reimburseOnly / query 变化，每次重绘前同步一次 */
    syncActivebar(st);
    /* render token：本页异步照片回包只认最新一次 paint，旧请求一律丢弃（A6） */
    st.renderToken += 1;
    st.photoRows.length = 0;
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
    flushPhotoUrls();   /* 列表被清空重绘，上一轮行内缩略图 URL 若已无人持有则此刻释放（详情/查看器打开时自动推迟） */
    renderSummary(st);
    renderChips(st);
    syncTitle(st);
    savePersisted(st);
    rememberState(st);   /* [D4-10] 同一五键指纹的重绘据此还原（含用户改过的月份/筛选） */
    if (!st.filtered.length) {
      st.nodes.days.appendChild(buildEmpty(st, hasFilters(st)));
      updateMore(st);
      notifyMonth(st);   /* [D2-16] 嵌入态首页头部三列跟随月份 */
      scheduleMeasure(st);
      scheduleAfterPaint(st);
      return;
    }
    appendPage(st);
    updateMore(st);
    notifyMonth(st);
    scheduleMeasure(st);
    scheduleAfterPaint(st);
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

  /* 滚动容器只认 .app-screen（[D2-30]：首页不得出现第二个滚动容器）。
   * 首页可能先 render 再把宿主挂进文档，找不到时按帧重试（最多 30 帧，不新增全局监听）。 */
  function bindScroll(st) {
    var tries = 0;
    function pick() {
      if (st.dead) { return null; }
      return st.root && st.root.closest ? st.root.closest('.app-screen') : null;
    }
    function attach(scroller) {
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
    function retry() {
      if (st.dead) { return; }
      var scroller = pick();
      if (scroller) { attach(scroller); return; }
      tries += 1;
      if (tries < 30) { raf(retry); }
    }
    retry();
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
    /* [D2-28] ④ 地址栏 / 键盘引起的 --vvh 变化（visualViewport 与 window.resize 不同源） */
    function onViewport() {
      if (st.dead) { return; }
      measureSticky(st);
    }
    global.addEventListener('resize', onResize);
    var vv = global.visualViewport || null;
    var vvBound = !!(vv && typeof vv.addEventListener === 'function');
    if (vvBound) { vv.addEventListener('resize', onViewport); }

    /* [D2-28] ④ 滚动容器自身尺寸变化（首页头部三列换行）；宿主可能稍后才挂进文档 */
    var observer = null;
    var tries = 0;
    function watchScroller() {
      if (st.dead || observer) { return; }
      var Ctor = global.ResizeObserver;
      if (!Ctor) { return; }
      var scroller = st.scroller || (st.root && st.root.closest ? st.root.closest('.app-screen') : null);
      if (!scroller) {
        tries += 1;
        if (tries < 30) { raf(watchScroller); }
        return;
      }
      try {
        observer = new Ctor(function () { if (!st.dead) { measureSticky(st); } });
        observer.observe(scroller);
      } catch (error) { observer = null; }
    }
    watchScroller();

    st.cleanups.push(function () {
      if (timer) { global.clearTimeout(timer); timer = 0; }
      global.removeEventListener('resize', onResize);
      if (vvBound) { try { vv.removeEventListener('resize', onViewport); } catch (error) { /* 忽略 */ } }
      if (observer) { try { observer.disconnect(); } catch (error) { /* 忽略 */ } }
    });
  }

  /* [D2-28] ③ 吸顶条自身高度变化（搜索展开 / 状态条挂入 / 月份行换行）→ 立刻重算日期头偏移 */
  function bindStickyObserver(st) {
    var Ctor = global.ResizeObserver;
    if (!Ctor || !st.nodes.sticky) { return; }
    var observer = null;
    try {
      observer = new Ctor(function () { if (!st.dead) { measureSticky(st); } });
      observer.observe(st.nodes.sticky);
    } catch (error) { observer = null; }
    if (!observer) { return; }
    st.cleanups.push(function () { try { observer.disconnect(); } catch (error) { /* 忽略 */ } });
  }

  /* ---------------- 销毁 / controller（2.15.0 嵌入契约） ---------------- */

  function teardownState(st) {
    if (!st) { return; }
    st.dead = true;
    var list = st.cleanups || [];
    st.cleanups = [];
    while (list.length) {
      var fn = list.pop();
      try { fn(); } catch (error) { /* 忽略 */ }
    }
  }

  /* [D2-18] destroy：① dead ② 跑完 cleanups ③ flushPhotoUrls ④ live 摘指针；② 起幂等（重复调用为空操作）。
   * [D2-19] 不调 bloburl.releaseAll（路由级职责）；[D2-20] 不关任何 Sheet。 */
  function destroyScreen(st) {
    if (!st || st.destroyed === true) { return; }
    st.destroyed = true;
    teardownState(st);
    try { flushPhotoUrls(); } catch (error) { /* 释放失败不影响销毁 */ }
    if (live === st) { live = null; }
  }

  /* [D2-9] scrollToList：把明细区滚入视口。以滚动容器（.app-screen）为基准，不假设 window 滚动 */
  function scrollToList(st) {
    if (!st || st.dead) { return; }
    var node = st.root;
    if (!node || typeof node.getBoundingClientRect !== 'function') { return; }
    var scroller = st.scroller || (node.closest ? node.closest('.app-screen') : null);
    if (scroller && typeof scroller.getBoundingClientRect === 'function') {
      var delta = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (delta > 0) {
        var max = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
        scroller.scrollTop = Math.min(max, (scroller.scrollTop || 0) + delta);
        return;
      }
    }
    if (typeof node.scrollIntoView === 'function') {
      try { node.scrollIntoView({ block: 'start' }); } catch (error) { /* 老 WebView 忽略参数 */ }
    }
  }

  /* [D2-9] A6：展开搜索框 + input.focus({preventScroll:false}) + scrollToList() */
  function focusSearch(st) {
    if (!st || st.dead) { return; }
    openSearch(st);
    var input = st.nodes.input;
    if (input && typeof input.focus === 'function') {
      try { input.focus({ preventScroll: false }); } catch (error) { input.focus(); }
    }
    scrollToList(st);
  }

  /* [D2-9] 待报销快捷入口：取反 → 重绘 → scrollToList → 同步 aria-pressed */
  function toggleReimburse(st) {
    if (!st || st.dead) { return; }
    st.reimburseOnly = st.reimburseOnly !== true;
    if (st.nodes.reimburseChip) {
      st.nodes.reimburseChip.setAttribute('aria-pressed', st.reimburseOnly ? 'true' : 'false');
      st.nodes.reimburseChip.classList.toggle('is-active', st.reimburseOnly);
    }
    paint(st);
    scrollToList(st);
  }

  /* [D2-11] controller 恰好 9 键：Object.keys(controller).sort() 与契约数组逐项相等 */
  function buildController(st, opts) {
    var controller = {
      destroy: function () { destroyScreen(st); },
      embedded: st.embedded === true,
      focusSearch: function () { focusSearch(st); },
      openBudgetStatus: function () {
        /* [D2-35] 语义恒为「调用 options.onBudgetStatus()」；缺省 null 时恒空操作（不抛错 / 不 toast / 不开 Sheet） */
        var handler = opts.onBudgetStatus;
        if (typeof handler !== 'function') { return; }
        handler.call(opts);
      },
      openCategoryFilter: function () {
        /* [D2-9] 打开既有筛选 sheet 并定位分类区（不自建第二套筛选 UI） */
        if (!st || st.dead) { return; }
        openFilterSheet(st, { focusCategory: true });
      },
      root: st.root,
      scrollToList: function () { scrollToList(st); },
      toggleReimburse: function () { toggleReimburse(st); }
    };
    /* [D2-10] 只读字段 month（/^\d{4}-\d{2}$/，恒为当前渲染月份） */
    if (typeof Object.defineProperty === 'function') {
      Object.defineProperty(controller, 'month', {
        enumerable: true,
        configurable: true,
        get: function () { return String(st.month || ''); }
      });
    } else {
      controller.month = String(st.month || '');
    }
    return controller;
  }

  /* ---------------- 屏幕 ---------------- */

  /**
   * 2.15.0 明细屏：既独立成屏，也可被首页嵌入（DESIGN D2-* / D4-*）。
   * @param {HTMLElement} root 宿主节点：嵌入态是首页里的容器 div，独立态是 .app-screen__body
   * @param {object} ctx 路由上下文
   * @param {object} [options] {embedded, baseHash, stickyTop, onMonthChange, onBudgetStatus}（缺省见 D2-5）
   * @returns {object} controller（9 键，见 D2-11）
   */
  function render(root, ctx, options) {
    if (!root) { return null; }
    var opts = normalizeOptions(options);
    /* [D2-8] 单实例：第二次 render 必须先把旧实例置 dead 并跑完 cleanups */
    if (live) { teardownState(live); }
    runCleanups();
    /* F31：整屏重建（路由切换 / commit 后 app 重建本屏）前释放本屏上一轮创建的 blob URL；
     * 详情或查看器仍打开时自动推迟（它们可能正显示同一批 URL），本屏不做 releaseAll —— 路由级 releaseAll 归 app.js（PLAN §9.4）。 */
    flushPhotoUrls();

    /* [D2-6]/[D2-7] 类名与标记一律打在宿主节点本身，不建中间壳（禁止 s-home-* 这类包裹层） */
    mountRoot(root, opts);

    var st = createState(root, ctx, opts);
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
    bindStickyObserver(st);
    st.cleanups.push(function () { st.dead = true; });

    var controller = buildController(st, opts);
    st.controller = controller;

    /* 一次性轻提示（N3）：左滑快捷操作不容易被发现。只给独立态——嵌入态首页已有自己的引导层，
       UI.md:327 把这条留给前端定（非视觉阻塞）。 */
    if (!st.embedded) {
      var app = appApi();
      var prefs = app && app.prefs ? app.prefs : null;
      if (prefs && typeof prefs.get === 'function' && !prefs.get('ledgerHintShown', false)) {
        try { prefs.set('ledgerHintShown', true); } catch (error) { /* 提示失败无碍 */ }
        global.setTimeout(function () {
          if (!st.dead) { toast('点流水看详情 · 左滑可直接编辑 / 删除', { type: 'info' }); }
        }, 600);
      }
    }
    return controller;
  }

  var screen = {
    title: '明细',
    subtitle: '全部流水',
    render: render,
    /* F31 工具测试缝（只给 tools/_t20_selfcheck.cjs 用：纯函数单测 + 行渲染探针）。
     * 不参与运行时逻辑，不被 app/router 读取；这里挂的是纯函数与纯构造函数，无状态、无 IO。 */
    photoTestKit: {
      photoIdList: photoIdList,
      badgePlan: badgePlan,
      photoSlots: photoSlots,
      ownsUrl: ownsUrl,
      photoUrlOf: photoUrlOf,
      flushPhotoUrls: flushPhotoUrls,
      openViewerFor: openViewerFor,
      attachDetailPhotos: attachDetailPhotos,
      buildItem: buildItem,
      buildDetailPhoto: buildDetailPhoto,
      removePhotoFromTx: removePhotoFromTx,
      photoErrorText: photoErrorText
    }
  };

  XZB.screens.register('ledger', screen);
}(window));
