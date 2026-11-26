/* 小账本 2.43.0 · js/modules/inline-edit.js · 首页/明细行内编辑（2.42.0 新增）
 * ------------------------------------------------------------------
 * 流水行四个热区（图标→种类 / 文字→批注 / 金额→金额 / 时间→日期时间）的
 * 共享底座：校验与 commit mutator 是纯函数（Node 可测），浮层与行内输入是
 * 通用 DOM 件；接线在 ledger.js buildItem，写通道仍唯一走 ctx.commit。
 *
 * 公开：XZB.Core.inlineEdit（纯函数）与 XZB.ui.inlineEdit / XZB.UI.inlineEdit（DOM 件 + 纯函数转口）
 *   纯函数：
 *     parseAmountText(text) -> { ok:true, cents } | { ok:false, code:'E_AMOUNT_INVALID' }
 *     isValidDateStr(s) / isValidTimeStr(s) -> boolean
 *     normalizeNote(raw) -> trim 后截断 30 字的字符串
 *     validatePatch(input) -> { ok:true, patch } | { ok:false, code }
 *     buildTxPatchMutator(txId, patch, nowIso, normalize) -> commit mutator
 *     categoriesForKind(list, kind) -> 同收支 kind 的未删分类数组
 *   DOM 件（无 document 时恒返回 null，Node 沙箱安全）：
 *     openPopover(anchor, width, build) -> { element, close }；全局单实例，点外部/Esc/滚动/resize 关闭
 *     closePopover()
 *     mountNoteInput(host, value, { onCommit, onCancel }) -> { destroy }
 *     mountAmountInput(host, cents, sign, { onCommit, onCancel, onInvalid }, beforeNode) -> { destroy }
 *       2.43.0：回车提交且金额无效 → 编辑器保留（红下划线+轻晃+行内提示）并重新全选；
 *       失焦提交且无效 → 关闭并回调 onInvalid({ via:'blur' })。onInvalid 收到 { via:'enter'|'blur' }。
 *     flashRow(node)
 *
 * 约束：金额只用整数分；日期只用本地字符串；用户数据一律 textContent；
 *       不碰 IndexedDB / localStorage；类名走 s-ledger-* 封闭集合。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var Core = XZB.Core || (XZB.Core = {});
  var UI = XZB.UI || (XZB.UI = {});

  var NOTE_MAX = 30;
  var CENTS_MAX = 99999999999;   /* 9 位整数元 + 2 位小数，与 keypad 口径一致 */

  /* ---------------- 纯函数 ---------------- */

  function parseAmountText(text) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) { return { ok: false, code: 'E_AMOUNT_INVALID' }; }
    var cents = Math.round(parseFloat(raw) * 100);
    if (!(cents > 0) || cents > CENTS_MAX) { return { ok: false, code: 'E_AMOUNT_INVALID' }; }
    return { ok: true, cents: cents };
  }

  function isValidDateStr(s) {
    var raw = String(s || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) { return false; }
    var p = raw.split('-');
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    if (m < 1 || m > 12 || d < 1) { return false; }
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function isValidTimeStr(s) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
  }

  function normalizeNote(raw) {
    return String(raw === undefined || raw === null ? '' : raw).trim().slice(0, NOTE_MAX);
  }

  /* input 只认五个键：categoryId / note / amountText / amountCents / date / time；
     未出现的键不进 patch（mutator 只改目标字段，其余原样保留）。 */
  function validatePatch(input) {
    var o = input || {};
    var patch = {};
    if (o.categoryId !== undefined) {
      if (typeof o.categoryId !== 'string' || !o.categoryId) { return { ok: false, code: 'E_PATCH_CATEGORY' }; }
      patch.categoryId = o.categoryId;
    }
    if (o.note !== undefined) { patch.note = normalizeNote(o.note); }
    if (o.amountText !== undefined) {
      var parsed = parseAmountText(o.amountText);
      if (!parsed.ok) { return { ok: false, code: parsed.code }; }
      patch.amountCents = parsed.cents;
    } else if (o.amountCents !== undefined) {
      var cents = Number(o.amountCents);
      if (!Number.isInteger(cents) || cents <= 0 || cents > CENTS_MAX) { return { ok: false, code: 'E_AMOUNT_INVALID' }; }
      patch.amountCents = cents;
    }
    if (o.date !== undefined) {
      if (!isValidDateStr(o.date)) { return { ok: false, code: 'E_TX_DATE' }; }
      patch.date = String(o.date);
    }
    if (o.time !== undefined) {
      if (!isValidTimeStr(o.time)) { return { ok: false, code: 'E_TX_TIME' }; }
      patch.time = String(o.time);
    }
    if (!Object.keys(patch).length) { return { ok: false, code: 'E_PATCH_EMPTY' }; }
    return { ok: true, patch: patch };
  }

  /* 与 doDelete 同款 mutator 形态：定位 → 软删守卫 → 全字段拷贝 → 只覆写 patch →
     updatedAt → 可选 schema.normalizeTransaction。找不到 / 已软删恒 abort。 */
  function buildTxPatchMutator(txId, patch, nowIso, normalize) {
    var id = String(txId || '');
    var fields = patch || {};
    return function (working) {
      var list = working && working.transactions ? working.transactions : null;
      if (!list) { return { abort: true, code: 'E_STORE_TX', message: '存储不可用' }; }
      var found = -1;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === id) { found = i; break; }
      }
      if (found < 0 || list[found].deleted === true) {
        return { abort: true, code: 'E_TX_NOT_FOUND', message: '记录已删除或不存在' };
      }
      var target = list[found];
      var next = {};
      var keys = Object.keys(target);
      for (var k = 0; k < keys.length; k += 1) { next[keys[k]] = target[keys[k]]; }
      var pk = Object.keys(fields);
      for (var j = 0; j < pk.length; j += 1) { next[pk[j]] = fields[pk[j]]; }
      next.updatedAt = nowIso;
      list[found] = typeof normalize === 'function' ? normalize(next, nowIso) : next;
      return { value: { id: id } };
    };
  }

  function categoriesForKind(list, kind) {
    var items = Array.isArray(list) ? list : [];
    var want = kind === 'income' ? 'income' : 'expense';
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var c = items[i];
      if (c && c.kind === want && c.deleted !== true) { out.push(c); }
    }
    return out;
  }

  var pure = {
    parseAmountText: parseAmountText,
    isValidDateStr: isValidDateStr,
    isValidTimeStr: isValidTimeStr,
    normalizeNote: normalizeNote,
    validatePatch: validatePatch,
    buildTxPatchMutator: buildTxPatchMutator,
    categoriesForKind: categoriesForKind,
    NOTE_MAX: NOTE_MAX
  };
  Core.inlineEdit = pure;

  /* ---------------- DOM 件（浏览器专属） ---------------- */

  function doc() {
    return typeof global.document !== 'undefined' ? global.document : null;
  }

  /* 2.43.0：提示语分设备——触屏没有回车/Esc 键，恒显示「点空白处保存」。 */
  function isCoarsePointer() {
    try {
      return !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
    } catch (error) { return false; }
  }

  function saveHintText() {
    return isCoarsePointer() ? '点空白处保存' : '回车保存 · Esc 取消';
  }

  var popHandle = null;
  var globalBound = false;

  function closePopover() {
    if (popHandle && popHandle.element && popHandle.element.parentNode) {
      popHandle.element.parentNode.removeChild(popHandle.element);
    }
    popHandle = null;
  }

  function bindGlobal() {
    var d = doc();
    if (!d || globalBound) { return; }
    globalBound = true;
    d.addEventListener('mousedown', function (event) {
      if (!popHandle) { return; }
      var t = event.target;
      if (popHandle.element.contains(t)) { return; }
      if (popHandle.anchor && popHandle.anchor.contains && popHandle.anchor.contains(t)) { return; }
      closePopover();
    }, true);
    d.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && popHandle) { closePopover(); }
    }, true);
    /* 2.43.0：浮层 position:fixed 只定位一次，列表一滚就脱离锚点行——滚动/resize 即关。
       浮层内部自身的滚动（事件目标在浮层内）不算，避免误关。 */
    d.addEventListener('scroll', function (event) {
      if (!popHandle) { return; }
      var t = event.target;
      if (t && popHandle.element.contains && popHandle.element.contains(t)) { return; }
      closePopover();
    }, true);
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('resize', function () {
        if (popHandle) { closePopover(); }
      });
    }
  }

  /* 锚定浮层：视口内 clamp（下方放不下翻到上方），全局单实例。 */
  function openPopover(anchor, width, build) {
    var d = doc();
    if (!d || !anchor || typeof build !== 'function') { return null; }
    closePopover();
    var element = d.createElement('div');
    element.className = 's-ledger-pop';
    element.style.width = width + 'px';
    build(element);
    d.body.appendChild(element);
    var vw = d.documentElement.clientWidth;
    var vh = d.documentElement.clientHeight;
    var rect = anchor.getBoundingClientRect();
    var h = element.offsetHeight;
    var left = Math.min(Math.max(rect.left, 8), Math.max(8, vw - width - 8));
    var top = rect.bottom + 6;
    if (top + h > vh - 8) { top = rect.top - h - 6; }
    if (top < 8) { top = 8; }
    element.style.left = left + 'px';
    element.style.top = top + 'px';
    bindGlobal();
    popHandle = { element: element, anchor: anchor, close: closePopover };
    return popHandle;
  }

  function stop(event) {
    event.stopPropagation();
  }

  /* 行内批注输入：回车/失焦保存，Esc 取消；点击不冒泡到行热区。 */
  function mountNoteInput(host, value, handlers) {
    var d = doc();
    if (!d || !host) { return null; }
    var hs = handlers || {};
    var input = d.createElement('input');
    input.className = 's-ledger-item__note-input';
    input.type = 'text';
    input.maxLength = NOTE_MAX;
    input.placeholder = '添加批注…';
    input.value = String(value === undefined || value === null ? '' : value);
    var hint = d.createElement('span');
    hint.className = 's-ledger-item__edit-hint';
    hint.textContent = saveHintText();
    host.appendChild(input);
    host.appendChild(hint);
    var done = false;
    function finish(commit) {
      if (done) { return; }
      done = true;
      if (commit && typeof hs.onCommit === 'function') { hs.onCommit(input.value); }
      else if (typeof hs.onCancel === 'function') { hs.onCancel(); }
    }
    input.addEventListener('keydown', function (event) {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('click', stop);
    input.focus();
    return {
      destroy: function () {
        done = true;
        if (input.parentNode) { input.parentNode.removeChild(input); }
        if (hint.parentNode) { hint.parentNode.removeChild(hint); }
      }
    };
  }

  /* 行内金额输入：sign 由调用方给（'-¥' / '+¥' / '¥'）。
     2.43.0：回车提交且无效 → 不丢输入，红下划线+轻晃+行内提示，重新全选待改；
     失焦提交且无效 → 关闭并走 onInvalid({ via:'blur' })（调用方还原+提示）。 */
  function mountAmountInput(host, cents, sign, handlers, beforeNode) {
    var d = doc();
    if (!d || !host) { return null; }
    var hs = handlers || {};
    var wrap = d.createElement('span');
    wrap.className = 's-ledger-item__amount-wrap';
    var signNode = d.createElement('span');
    signNode.className = 's-ledger-item__amount-sign';
    signNode.textContent = String(sign || '');
    var input = d.createElement('input');
    input.className = 's-ledger-item__amount-input';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = (Math.abs(Number(cents) || 0) / 100).toFixed(2);
    wrap.appendChild(signNode);
    wrap.appendChild(input);
    host.insertBefore(wrap, beforeNode || null);
    var errHint = null;
    function clearInvalid() {
      wrap.classList.remove('is-invalid');
      if (errHint && errHint.parentNode) { errHint.parentNode.removeChild(errHint); }
      errHint = null;
    }
    function markInvalid() {
      /* 重触发晃动动画：先摘类、强制回流、再挂回 */
      wrap.classList.remove('is-invalid');
      void wrap.offsetWidth;
      wrap.classList.add('is-invalid');
      if (!errHint) {
        errHint = d.createElement('span');
        errHint.className = 's-ledger-item__amount-hint';
        errHint.textContent = '请输入大于 0 的数字';
        host.insertBefore(errHint, wrap.nextSibling);
      }
    }
    var done = false;
    function finish(commit, via) {
      if (done) { return; }
      if (!commit) {
        done = true;
        if (typeof hs.onCancel === 'function') { hs.onCancel(); }
        return;
      }
      var parsed = parseAmountText(input.value);
      if (parsed.ok) {
        done = true;
        if (typeof hs.onCommit === 'function') { hs.onCommit(parsed.cents); }
        return;
      }
      if (via === 'enter') {
        /* 编辑器保留：标红提示并重新全选，用户刚打的字不丢 */
        markInvalid();
        if (typeof hs.onInvalid === 'function') { hs.onInvalid({ via: 'enter', value: input.value }); }
        input.focus();
        if (typeof input.select === 'function') { input.select(); }
        return;
      }
      done = true;
      if (typeof hs.onInvalid === 'function') { hs.onInvalid({ via: 'blur', value: input.value }); }
      else if (typeof hs.onCancel === 'function') { hs.onCancel(); }
    }
    input.addEventListener('input', clearInvalid);
    input.addEventListener('keydown', function (event) {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true, 'enter'); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true, 'blur'); });
    input.addEventListener('click', stop);
    input.focus();
    if (typeof input.select === 'function') { input.select(); }
    return {
      destroy: function () {
        done = true;
        clearInvalid();
        if (wrap.parentNode) { wrap.parentNode.removeChild(wrap); }
      }
    };
  }

  function flashRow(node) {
    if (!node || !node.classList) { return; }
    node.classList.add('is-flash');
    global.setTimeout(function () {
      if (node.classList) { node.classList.remove('is-flash'); }
    }, 1200);
  }

  var dom = {
    openPopover: openPopover,
    closePopover: closePopover,
    mountNoteInput: mountNoteInput,
    mountAmountInput: mountAmountInput,
    flashRow: flashRow
  };

  var api = {};
  var pk = Object.keys(pure);
  for (var i = 0; i < pk.length; i += 1) { api[pk[i]] = pure[pk[i]]; }
  var dk = Object.keys(dom);
  for (var j = 0; j < dk.length; j += 1) { api[dk[j]] = dom[dk[j]]; }

  UI.inlineEdit = api;
  XZB.ui = XZB.ui || {};
  XZB.ui.inlineEdit = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this)));