/* 小账本 2.0 · js/ui/sheet.js · owner: 前端#1（T04）
 * 底部浮层。公开：XZB.ui.sheet（镜像 XZB.UI.sheet）
 *   open({ title, content, actions, onClose, dismissible, className, ariaLabel })
 *   close(reason?) / isOpen()
 * 行为：backdrop 点击、下滑手势（阈值 80px 或速度 0.5px/ms）、Esc 关闭；
 *       打开时锁 body 滚动并记录 scrollY；关闭后焦点回到触发元素；
 *       高度由可视视口变量（dom.js 写入）计算，键盘弹出时上移，不遮输入；
 *       Tab 焦点陷阱；role="dialog" aria-modal="true"。
 * 依赖：XZB.ui.dom；内容节点由调用方创建，文本一律 textContent。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.sheet) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.sheet 已注册，保留首个实现');
    }
    return;
  }

  var CLOSE_MS = 220;
  var SWIPE_DISTANCE = 80;
  var SWIPE_VELOCITY = 0.5;

  var state = {
    open: false,
    closing: false,
    layer: null,
    sheet: null,
    backdrop: null,
    body: null,
    lastFocus: null,
    options: null,
    closeTimer: 0,
    locked: false,
    scrollY: 0,
    drag: null,
    suppressClick: false
  };

  function dom() {
    return (XZB.ui && XZB.ui.dom) || (XZB.UI && XZB.UI.dom) || null;
  }

  function make(tag, className) {
    var d = dom();
    if (d && d.el) {
      return d.el(tag, { className: className });
    }
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    return node;
  }

  function iconHtml(name, size) {
    var icons = (XZB.ui && XZB.ui.icons) || (XZB.UI && XZB.UI.icons) || null;
    return icons && typeof icons.icon === 'function' ? icons.icon(name, { size: size || 24 }) : '';
  }

  function prefersReducedMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------- 页面滚动锁 ---------- */
  function lockScroll() {
    if (state.locked || !document.body) { return; }
    var body = document.body;
    var y = global.pageYOffset || document.documentElement.scrollTop || 0;
    state.scrollY = y;
    state.body = body;
    body.style.position = 'fixed';
    body.style.top = -y + 'px';
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.classList.add('is-sheet-open');
    state.locked = true;
  }

  function unlockScroll() {
    if (!state.locked || !state.body) { return; }
    var body = state.body;
    var y = state.scrollY;
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    body.style.overflow = '';
    body.classList.remove('is-sheet-open');
    state.locked = false;
    state.body = null;
    if (global.scrollTo) { global.scrollTo(0, y); }
  }

  /* ---------- 焦点 ---------- */
  function focusableNodes() {
    if (!state.sheet) { return []; }
    var selector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    var all = state.sheet.querySelectorAll(selector);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (node.getClientRects && node.getClientRects().length === 0) { continue; }
      if (node.getAttribute('aria-hidden') === 'true') { continue; }
      out.push(node);
    }
    return out;
  }

  function focusFirst() {
    if (!state.sheet) { return; }
    var nodes = focusableNodes();
    if (nodes.length) {
      nodes[0].focus({ preventScroll: true });
    } else {
      state.sheet.focus({ preventScroll: true });
    }
  }

  function onDocumentKeydown(event) {
    if (!state.open || state.closing) { return; }
    if (event.key === 'Escape' || event.key === 'Esc') {
      if (state.options && state.options.dismissible === false) { return; }
      event.preventDefault();
      event.stopPropagation();
      close('esc');
      return;
    }
    if (event.key !== 'Tab') { return; }

    var nodes = focusableNodes();
    if (!nodes.length) {
      event.preventDefault();
      if (state.sheet) { state.sheet.focus({ preventScroll: true }); }
      return;
    }
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    var active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || active === state.sheet || !state.sheet.contains(active)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else if (active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function onDocumentFocusin(event) {
    if (!state.open || state.closing || !state.layer) { return; }
    if (!state.layer.contains(event.target)) {
      focusFirst();
    }
  }

  /* ---------- 下滑关闭 ---------- */
  function dragStart(event) {
    if (!state.open || state.closing || !state.sheet) { return; }
    if (state.options && state.options.dismissible === false) { return; }
    if (event.pointerType === 'mouse' && event.button !== 0) { return; }
    var target = event.target;
    if (target && target.closest && target.closest('button, a, input, textarea, select, [contenteditable="true"]')) {
      return;
    }

    state.drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startX: event.clientX,
      lastY: event.clientY,
      lastTime: event.timeStamp || Date.now(),
      velocity: 0,
      dy: 0,
      active: false,
      handle: event.currentTarget
    };
    if (event.currentTarget.setPointerCapture) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
    }
  }

  function dragMove(event) {
    var drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) { return; }
    var dy = Math.max(0, event.clientY - drag.startY);
    var now = event.timeStamp || Date.now();
    var dt = now - drag.lastTime;
    if (dt > 0) {
      var instant = (event.clientY - drag.lastY) / dt;
      drag.velocity = drag.velocity * 0.7 + instant * 0.3;
      drag.lastY = event.clientY;
      drag.lastTime = now;
    }
    drag.dy = dy;

    if (!drag.active && dy > 4) {
      drag.active = true;
      state.layer.classList.add('is-dragging');
      state.suppressClick = true;
    }
    if (!drag.active) { return; }

    if (event.cancelable) { event.preventDefault(); }
    var resistance = dy > 0 ? 1 : 0;
    state.sheet.style.transform = 'translateY(' + Math.round(dy * resistance) + 'px)';
  }

  function dragEnd(event) {
    var drag = state.drag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) { return; }
    state.drag = null;

    var current = state.sheet;
    if (!current) { return; }
    if (drag.handle && drag.handle.releasePointerCapture && drag.pointerId !== undefined) {
      try { drag.handle.releasePointerCapture(drag.pointerId); } catch (error) { /* 忽略 */ }
    }

    var shouldClose = drag.dy > SWIPE_DISTANCE ||
      (drag.dy > 12 && drag.velocity > SWIPE_VELOCITY);

    state.layer.classList.remove('is-dragging');
    current.style.transform = '';

    if (shouldClose) {
      close('swipe');
    } else {
      /* 回弹由 CSS 的 320ms ease-ios 过渡完成。 */
      state.suppressClick = false;
    }
  }

  /* ---------- 构建 ---------- */
  function buildActions(actions, onCloseRequest) {
    var wrap = make('div', 'c-sheet__actions');
    actions.forEach(function (item) {
      if (!item || !item.label) { return; }
      var kind = item.kind || item.type || 'default';
      var className = 'c-btn';
      if (kind === 'primary' || kind === 'confirm') {
        className += ' c-btn--primary';
      } else if (kind === 'danger' || kind === 'destructive') {
        className += ' c-btn--danger-solid';
      } else if (kind === 'text' || kind === 'ghost') {
        className += ' c-btn--text';
      } else {
        className += ' c-btn--secondary';
      }
      var button = make('button', className);
      button.type = 'button';
      button.textContent = String(item.label);
      if (item.disabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      }
      button.addEventListener('click', function () {
        var keepOpen = false;
        try {
          if (typeof item.onClick === 'function') {
            keepOpen = item.onClick() === false;
          }
        } catch (error) {
          if (global.console && global.console.error) {
            global.console.error('sheet action 回调失败', error);
          }
        }
        if (!keepOpen && item.closeOnClick !== false) {
          if (typeof onCloseRequest === 'function') { onCloseRequest(); }
        }
      });
      wrap.appendChild(button);
    });
    return wrap;
  }

  function appendContent(container, content) {
    if (content === null || content === undefined) { return; }
    if (typeof content === 'function') {
      appendContent(container, content());
      return;
    }
    if (content && typeof content.nodeType === 'number') {
      container.appendChild(content);
      return;
    }
    if (Array.isArray(content)) {
      content.forEach(function (item) { appendContent(container, item); });
      return;
    }
    var text = document.createElement('div');
    text.textContent = String(content);
    container.appendChild(text);
  }

  function clearCloseTimer() {
    if (state.closeTimer) {
      clearTimeout(state.closeTimer);
      state.closeTimer = 0;
    }
  }

  function removeListeners() {
    document.removeEventListener('keydown', onDocumentKeydown, true);
    document.removeEventListener('focusin', onDocumentFocusin, true);
  }

  function finalizeClose(reason) {
    clearCloseTimer();
    removeListeners();

    var options = state.options;
    var lastFocus = state.lastFocus;

    state.open = false;
    state.closing = false;
    state.drag = null;

    if (state.layer && state.layer.parentNode) {
      state.layer.parentNode.removeChild(state.layer);
    }

    state.layer = null;
    state.sheet = null;
    state.backdrop = null;
    state.lastFocus = null;
    state.options = null;

    unlockScroll();

    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) {
      try {
        lastFocus.focus({ preventScroll: true });
      } catch (error) {
        lastFocus.focus();
      }
    }

    if (options && typeof options.onClose === 'function') {
      try {
        options.onClose(reason || 'close');
      } catch (error) {
        if (global.console && global.console.error) {
          global.console.error('sheet onClose 回调失败', error);
        }
      }
    }
  }

  function close(reason) {
    if (!state.open || state.closing) { return false; }
    state.closing = true;
    clearCloseTimer();

    var layer = state.layer;
    if (layer) {
      layer.classList.remove('is-open');
      layer.classList.add('is-closing');
    }

    var delay = prefersReducedMotion() ? 0 : CLOSE_MS;
    state.closeTimer = setTimeout(function () {
      state.closeTimer = 0;
      finalizeClose(reason || 'api');
    }, delay);
    return true;
  }

  function destroyNow(reason) {
    clearCloseTimer();
    if (state.open || state.layer) {
      removeListeners();
      if (state.layer && state.layer.parentNode) {
        state.layer.parentNode.removeChild(state.layer);
      }
      state.layer = null;
      state.sheet = null;
      state.backdrop = null;
      state.open = false;
      state.closing = false;
      state.drag = null;
      unlockScroll();
      var options = state.options;
      state.options = null;
      state.lastFocus = null;
      if (options && typeof options.onClose === 'function') {
        try { options.onClose(reason || 'replaced'); } catch (error) { /* 忽略 */ }
      }
    }
  }

  /**
   * open(options)
   * options.content 支持 DOM 节点、字符串（按纯文本处理）或返回节点的函数。
   * options.actions: [{ label, kind: 'primary'|'danger'|'default', onClick, disabled, closeOnClick }]
   */
  function open(options) {
    if (typeof document === 'undefined' || !document.body) { return null; }
    if (state.open || state.layer) { destroyNow('replaced'); }

    var opts = options && typeof options === 'object' ? options : {};
    var dismissible = opts.dismissible !== false;

    state.options = opts;
    state.lastFocus = document.activeElement;
    state.open = true;
    state.closing = false;
    state.suppressClick = false;

    var layer = make('div', 'c-sheet-layer');
    layer.setAttribute('data-sheet-layer', '');
    state.layer = layer;

    var backdrop = make('div', 'c-sheet-backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', function () {
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      if (dismissible) { close('backdrop'); }
    });
    layer.appendChild(backdrop);
    state.backdrop = backdrop;

    var sheet = make('div', 'c-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('tabindex', '-1');
    if (opts.className) {
      sheet.className += ' ' + String(opts.className);
    }
    state.sheet = sheet;

    var titleId = 'xzb-sheet-title-' + Date.now().toString(36);
    var titleText = opts.title === null || opts.title === undefined ? '' : String(opts.title);
    if (titleText) {
      sheet.setAttribute('aria-labelledby', titleId);
    } else {
      sheet.setAttribute('aria-label', String(opts.ariaLabel || '浮层'));
    }

    /* 抓手 */
    var grabber = make('div', 'c-sheet__grabber');
    grabber.setAttribute('aria-hidden', 'true');
    sheet.appendChild(grabber);

    /* 头部：标题 + 关闭 */
    var header = make('div', 'c-sheet__header');
    var title = make('h2', 'c-sheet__title');
    title.id = titleId;
    title.textContent = titleText;
    header.appendChild(title);

    if (dismissible) {
      var closeBtn = make('button', 'c-sheet__close');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.innerHTML = iconHtml('close', 14); /* 常量 SVG */
      closeBtn.addEventListener('click', function () { close('button'); });
      header.appendChild(closeBtn);
    }
    sheet.appendChild(header);

    /* 内容 */
    var body = make('div', 'c-sheet__body');
    appendContent(body, opts.content);
    sheet.appendChild(body);

    /* 动作 */
    if (Array.isArray(opts.actions) && opts.actions.length) {
      var footer = make('div', 'c-sheet__footer');
      footer.appendChild(buildActions(opts.actions, function () { close('action'); }));
      sheet.appendChild(footer);
    }

    /* 下滑手势只绑定在抓手和头部，避免和内容滚动冲突。 */
    if (dismissible) {
      [grabber, header].forEach(function (handle) {
        handle.addEventListener('pointerdown', dragStart);
        handle.addEventListener('pointermove', dragMove);
        handle.addEventListener('pointerup', dragEnd);
        handle.addEventListener('pointercancel', dragEnd);
      });
    }

    layer.appendChild(sheet);

    var host = document.getElementById('sheet-root') || document.body;
    host.appendChild(layer);

    lockScroll();
    document.addEventListener('keydown', onDocumentKeydown, true);
    document.addEventListener('focusin', onDocumentFocusin, true);

    /* 下一帧加 is-open，触发 320ms 升起。 */
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        if (state.sheet === sheet) { layer.classList.add('is-open'); }
      });
    } else {
      layer.classList.add('is-open');
    }

    sheet.focus({ preventScroll: true });

    return Object.freeze({
      close: close,
      element: sheet,
      layer: layer
    });
  }

  function isOpen() {
    return !!state.open;
  }

  var api = Object.freeze({
    open: open,
    close: close,
    isOpen: isOpen,
    SWIPE_DISTANCE: SWIPE_DISTANCE,
    SWIPE_VELOCITY: SWIPE_VELOCITY
  });

  UI.sheet = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.sheet) { lower.sheet = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
