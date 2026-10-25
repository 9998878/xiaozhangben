/* 小账本 2.0 · js/ui/press.js
 * 全局按压反馈引擎。唯一职责：在指针按下/抬起的正确时机给元素加/去 .is-pressed。
 *
 * 为什么需要它（踩过的两个坑）：
 *   1) iOS Safari 只在文档存在 touchstart 监听时才激活 :active。旧实现把按压
 *      反馈全写在 :active 上，且只在 document 绑了 click，结果 iPhone 上按下
 *      完全没反馈，手指一抬页面直接跳走 —— 这是「塑料感」的第一来源。
 *   2) 列表滑动时 pointerdown 命中的行会一直保持按压态，滑完还留着压痕。
 *      因此位移超过 MOVE_TOLERANCE 立即撤销，视为滚动而非点击。
 *
 * 时长由 CSS 决定（--dur-press-in / --dur-press-out），本文件只负责状态与时机。
 * 公开：XZB.ui.press = { enable / disable / isEnabled / refresh }
 * 约束：不读业务数据、不 preventDefault、不使用 innerHTML。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.press) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.press 已注册，保留首个实现');
    }
    return;
  }

  var doc = typeof document !== 'undefined' ? document : null;

  /* 只有「会产生跳转或动作」的元素才配按压态；输入框、纯文本不配。 */
  var SELECTOR = 'a[href], button, [role="button"], [data-press]';
  var MOVE_TOLERANCE = 10;   /* px，超过即判定为滚动 */
  var MIN_VISIBLE = 70;      /* ms，极快的点按也保证看得见一次压下 */
  var RELEASE_CLASS_MS = 200;

  var enabled = true;
  var current = null;
  var bound = false;

  function now() {
    return Date.now();
  }

  function reducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  }

  function isBlocked(el) {
    if (!el || !el.getAttribute) { return true; }
    if (el.disabled === true) { return true; }
    if (el.getAttribute('aria-disabled') === 'true') { return true; }
    if (el.getAttribute('data-press') === 'none') { return true; }
    var tag = String(el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function findTarget(node) {
    var el = node;
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(SELECTOR)) { return isBlocked(el) ? null : el; }
      if (el === doc.body || el === doc.documentElement) { return null; }
      el = el.parentNode;
    }
    return null;
  }

  function cancelFrame() {
    if (current && current.frame && global.cancelAnimationFrame) {
      global.cancelAnimationFrame(current.frame);
    }
    if (current) { current.frame = 0; }
  }

  function press(el) {
    if (reducedMotion()) { return; }
    el.classList.add('is-pressed');
  }

  function release(cancelled) {
    var session = current;
    current = null;
    if (!session) { return; }
    cancelFrame();
    var el = session.el;
    var elapsed = now() - session.at;
    var wait = elapsed < MIN_VISIBLE ? (MIN_VISIBLE - elapsed) : 0;

    var finish = function () {
      el.classList.remove('is-pressed');
      if (cancelled) { return; }
      /* 松手后短暂挂 is-released：给「回弹」留一个可被 CSS 区分的时机 */
      el.classList.add('is-released');
      global.setTimeout(function () {
        el.classList.remove('is-released');
      }, RELEASE_CLASS_MS);
    };

    if (wait > 0) {
      global.setTimeout(finish, wait);
    } else {
      finish();
    }
  }

  function onDown(event) {
    if (!enabled) { return; }
    if (event.pointerType === 'mouse' && event.button !== 0) { return; }
    var el = findTarget(event.target);
    if (!el) { return; }
    if (current) { release(true); }

    current = {
      el: el,
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: now(),
      frame: 0
    };

    /* 下一帧再加类：滚动开始的第一个 pointerdown 不会留下压痕 */
    if (global.requestAnimationFrame) {
      current.frame = global.requestAnimationFrame(function () {
        if (current && current.el === el) { press(el); }
      });
    } else {
      press(el);
    }
  }

  function onMove(event) {
    if (!current || event.pointerId !== current.id) { return; }
    var dx = event.clientX - current.x;
    var dy = event.clientY - current.y;
    if (dx * dx + dy * dy > MOVE_TOLERANCE * MOVE_TOLERANCE) {
      release(true);
    }
  }

  function onUp(event) {
    if (!current || event.pointerId !== current.id) { return; }
    release(false);
  }

  function onCancel(event) {
    if (!current) { return; }
    if (event && event.pointerId !== undefined && event.pointerId !== current.id) { return; }
    release(true);
  }

  function bind() {
    if (bound || !doc) { return; }
    bound = true;

    /* iOS 的 :active 开关：没有这个空监听，Safari 不会给任何元素上 :active。
       老屏幕的 :active 规则靠它复活；新屏幕走 .is-pressed。 */
    doc.addEventListener('touchstart', function () {}, { passive: true });

    if (global.PointerEvent) {
      doc.addEventListener('pointerdown', onDown, { passive: true, capture: true });
      doc.addEventListener('pointermove', onMove, { passive: true, capture: true });
      doc.addEventListener('pointerup', onUp, { passive: true, capture: true });
      doc.addEventListener('pointercancel', onCancel, { passive: true, capture: true });
    } else {
      /* 老 WebView 兜底：只做「按下加类、抬起去类」，不做位移判定 */
      doc.addEventListener('touchstart', function (event) {
        if (!enabled) { return; }
        var touch = event.touches && event.touches[0];
        var el = findTarget(event.target);
        if (!el || !touch) { return; }
        if (current) { release(true); }
        current = { el: el, id: 0, x: touch.clientX, y: touch.clientY, at: now(), frame: 0 };
        press(el);
      }, { passive: true, capture: true });
      doc.addEventListener('touchend', function () { release(false); }, { passive: true, capture: true });
      doc.addEventListener('touchcancel', function () { release(true); }, { passive: true, capture: true });
    }

    /* 滚动一开始就撤掉压痕 */
    global.addEventListener('scroll', function () {
      if (current) { release(true); }
    }, { passive: true, capture: true });
  }

  function enable() {
    enabled = true;
  }

  function disable() {
    enabled = false;
    release(true);
  }

  var api = Object.freeze({
    enable: enable,
    disable: disable,
    isEnabled: function () { return enabled; },
    /* 兼容入口：屏幕重建后无需做什么，选择器是全局委托 */
    refresh: function () { bind(); }
  });

  UI.press = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.press) { lower.press = api; }

  bind();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
