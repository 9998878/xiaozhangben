/* 小账本 2.0 · js/ui/dom.js · owner: 前端#1（T04）
 * DOM 原语 + 全站唯一的可视视口写入者。
 * 公开：XZB.ui.dom（镜像 XZB.UI.dom）
 *   el / frag / clear / mount / on / off / delegate / raf / rafThrottle
 *   escapeHtml / cls / isNode / closest
 *   viewport.sync() / viewport.state()
 * 硬规则：用户文本一律 textContent；innerHTML 只接受以 <svg 开头的常量图标；
 *         全仓只有本文件允许写 --vvh 与 --kb（INTERFACE-FREEZE §5）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.dom) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.dom 已注册，保留首个实现');
    }
    return;
  }

  var doc = typeof document !== 'undefined' ? document : null;
  var win = typeof window !== 'undefined' ? window : global;

  /* ---------- 基础判断 ---------- */
  function isNode(value) {
    return !!(value && typeof value === 'object' && typeof value.nodeType === 'number');
  }

  function isElement(value) {
    return !!(value && value.nodeType === 1);
  }

  function cls() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
      var item = arguments[i];
      if (!item) { continue; }
      if (Array.isArray(item)) {
        var nested = cls.apply(null, item);
        if (nested) { out.push(nested); }
      } else {
        out.push(String(item));
      }
    }
    return out.join(' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function closest(node, selector) {
    var current = node;
    while (current && current.nodeType === 1) {
      if (current.matches && current.matches(selector)) { return current; }
      current = current.parentNode;
    }
    return null;
  }

  /* ---------- 元素创建 ---------- */
  function appendOne(parent, child) {
    if (child === null || child === undefined || child === false || child === true) { return; }
    if (Array.isArray(child)) {
      for (var i = 0; i < child.length; i++) { appendOne(parent, child[i]); }
      return;
    }
    if (isNode(child)) {
      parent.appendChild(child);
      return;
    }
    parent.appendChild(doc.createTextNode(String(child)));
  }

  function applyAttrs(node, attrs) {
    if (!attrs || typeof attrs !== 'object') { return; }
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) { return; }
      if (key === 'className' || key === 'class') { return; }
      if (key === 'style' || key === 'dataset' || key === 'text' || key === 'html' ||
        key === 'children' || key === 'aria' || key === 'role') {
        return;
      }
      if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    });
  }

  function applyStyle(node, style) {
    if (!style || typeof style !== 'object') { return; }
    Object.keys(style).forEach(function (key) {
      var value = style[key];
      if (value === undefined || value === null) { return; }
      if (key.indexOf('--') === 0 || key.indexOf('-') >= 0) {
        node.style.setProperty(key, String(value));
      } else {
        node.style[key] = value;
      }
    });
  }

  /**
   * el(tag, attrs?, children?)
   * attrs 支持：class/className、text、html（仅 <svg）、style、dataset、aria、role、任意属性。
   */
  function el(tag, attrs, children) {
    if (!doc) { throw new Error('XZB.ui.dom.el 只能在浏览器中使用'); }

    var options = attrs;
    var kids = children;
    if (Array.isArray(attrs) || typeof attrs === 'string' || typeof attrs === 'number' || isNode(attrs)) {
      options = null;
      kids = attrs;
    }
    options = options && typeof options === 'object' ? options : {};

    var node = doc.createElement(String(tag || 'div'));

    var className = options.className || options['class'];
    if (className) { node.className = cls(className); }

    if (options.dataset && typeof options.dataset === 'object') {
      Object.keys(options.dataset).forEach(function (key) {
        var value = options.dataset[key];
        if (value !== undefined && value !== null) {
          node.setAttribute('data-' + key.replace(/[A-Z]/g, function (m) {
            return '-' + m.toLowerCase();
          }), String(value));
        }
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
    applyStyle(node, options.style);

    if (options.role) { node.setAttribute('role', String(options.role)); }

    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }

    if (options.html !== undefined && options.html !== null) {
      var html = String(options.html);
      if (/^\s*<svg[\s>]/i.test(html)) {
        node.innerHTML = html; /* 只允许本仓图标常量 */
      } else if (typeof console !== 'undefined' && console.warn) {
        console.warn('XZB.ui.dom.el 拒绝非 SVG 的 html 注入，请改用 text/textContent');
      }
    }

    var content = kids !== undefined && kids !== null ? kids : options.children;
    appendOne(node, content);

    return node;
  }

  function frag(children) {
    if (!doc) { throw new Error('XZB.ui.dom.frag 只能在浏览器中使用'); }
    var fragment = doc.createDocumentFragment();
    var items = arguments.length > 1 ? Array.prototype.slice.call(arguments) : children;
    appendOne(fragment, items);
    return fragment;
  }

  function clear(node) {
    if (!node) { return node; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
    return node;
  }

  function mount(root, child) {
    if (!root) { return child; }
    appendOne(root, child);
    return child;
  }

  /* ---------- 事件 ---------- */
  function on(target, type, handler, options) {
    if (!target || !type || typeof handler !== 'function') {
      return function () {};
    }
    target.addEventListener(type, handler, options);
    return function offOne() {
      target.removeEventListener(type, handler, options);
    };
  }

  function off(target, type, handler, options) {
    if (!target) { return; }
    target.removeEventListener(type, handler, options);
  }

  /**
   * delegate(root, selector, type, handler, options?)
   * handler(event, matchedElement)；只触发 root 内部、且匹配 selector 的元素。
   */
  function delegate(root, selector, type, handler, options) {
    if (!root || !selector || typeof handler !== 'function') {
      return function () {};
    }
    function listener(event) {
      var target = event.target;
      if (!target || target.nodeType !== 1) { return; }
      var matched = target.closest ? target.closest(selector) : closest(target, selector);
      if (matched && root.contains(matched)) {
        handler(event, matched);
      }
    }
    root.addEventListener(type, listener, options);
    return function offDelegate() {
      root.removeEventListener(type, listener, options);
    };
  }

  /* ---------- 帧调度 ---------- */
  function raf(fn) {
    if (typeof win.requestAnimationFrame !== 'function') {
      var timer = setTimeout(fn, 16);
      return function cancel() { clearTimeout(timer); };
    }
    var id = win.requestAnimationFrame(fn);
    return function cancel() { win.cancelAnimationFrame(id); };
  }

  /**
   * rafThrottle(fn)：同一帧内只执行最后一次调用。
   * 返回的函数带 .cancel()；另有 rafCancel 语义由返回值自身承担。
   */
  function rafThrottle(fn) {
    var frame = 0;
    var lastArgs = null;
    var lastThis = null;

    function run() {
      frame = 0;
      if (!lastArgs) { return; }
      var args = lastArgs;
      var context = lastThis;
      lastArgs = null;
      lastThis = null;
      fn.apply(context, args);
    }

    function wrapped() {
      lastArgs = arguments;
      lastThis = this;
      if (!frame) { frame = win.requestAnimationFrame(run); }
    }

    wrapped.cancel = function cancel() {
      if (frame) { win.cancelAnimationFrame(frame); }
      frame = 0;
      lastArgs = null;
      lastThis = null;
    };

    return wrapped;
  }

  /* ---------- 可视视口：--vvh / --kb 的唯一写入者 ---------- */
  var viewportState = { height: 0, offsetTop: 0, keyboard: 0 };

  function syncViewport() {
    if (!doc || !doc.documentElement) { return viewportState; }
    var vv = win.visualViewport;
    var layoutHeight = win.innerHeight || doc.documentElement.clientHeight || 0;
    var height = vv && vv.height ? vv.height : layoutHeight;
    var offsetTop = vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0;
    var keyboard = Math.max(0, layoutHeight - height);

    doc.documentElement.style.setProperty('--vvh', Math.round(height) + 'px');
    doc.documentElement.style.setProperty('--kb', Math.round(keyboard) + 'px');

    viewportState.height = Math.round(height);
    viewportState.offsetTop = Math.round(offsetTop);
    viewportState.keyboard = Math.round(keyboard);
    return viewportState;
  }

  var viewportBound = false;
  var syncTimer = 0;

  function scheduleViewport(delay) {
    if (syncTimer) { clearTimeout(syncTimer); }
    syncTimer = setTimeout(function () {
      syncTimer = 0;
      syncViewport();
    }, delay || 0);
  }

  function initViewport() {
    if (!doc || viewportBound) { return; }
    viewportBound = true;

    var vv = win.visualViewport;
    if (vv && vv.addEventListener) {
      vv.addEventListener('resize', function () { scheduleViewport(0); }, { passive: true });
      vv.addEventListener('scroll', function () { scheduleViewport(0); }, { passive: true });
    }

    win.addEventListener('resize', function () { scheduleViewport(0); }, { passive: true });
    win.addEventListener('orientationchange', function () { scheduleViewport(260); }, { passive: true });

    doc.addEventListener('focusin', function () { scheduleViewport(60); }, true);
    doc.addEventListener('focusout', function () { scheduleViewport(260); }, true);

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', function () {
        syncViewport();
        scheduleViewport(120);
      });
    } else {
      syncViewport();
    }
  }

  var viewport = Object.freeze({
    sync: function () { return syncViewport(); },
    state: function () {
      return {
        height: viewportState.height,
        offsetTop: viewportState.offsetTop,
        keyboard: viewportState.keyboard
      };
    }
  });

  var api = Object.freeze({
    el: el,
    frag: frag,
    clear: clear,
    mount: mount,
    on: on,
    off: off,
    delegate: delegate,
    raf: raf,
    rafThrottle: rafThrottle,
    escapeHtml: escapeHtml,
    cls: cls,
    isNode: isNode,
    isElement: isElement,
    closest: closest,
    viewport: viewport
  });

  UI.dom = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.dom) { lower.dom = api; }

  initViewport();
  if (doc) { scheduleViewport(0); }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
