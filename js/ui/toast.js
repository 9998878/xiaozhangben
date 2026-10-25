/* 小账本 2.0 · js/ui/toast.js · owner: 前端#1（T04）
 * 轻提示：同屏最多 1 条，新提示立即顶掉旧提示。
 * 公开：XZB.ui.toast（镜像 XZB.UI.toast）
 *   show(msg, { type: 'info'|'success'|'danger'|'warning',
 *               action: { label, onClick } })
 *   hide() / dismiss() / current()
 * 行为：普通 1.8s；带 action（撤销）5s；role="status" + aria-live="polite"。
 * 依赖：XZB.ui.dom（el/clear）；若未加载则使用本文件内的最小兜底。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.toast) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.toast 已注册，保留首个实现');
    }
    return;
  }

  var DURATION_PLAIN = 1800;
  var DURATION_ACTION = 5000;
  var EXIT_MS = 220;

  var root = null;
  var toastEl = null;
  var timer = 0;
  var exitTimer = 0;
  var token = 0;

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

  function iconHtml(name) {
    var icons = (XZB.ui && XZB.ui.icons) || (XZB.UI && XZB.UI.icons) || null;
    if (icons && typeof icons.icon === 'function') {
      return icons.icon(name, { size: 20 });
    }
    return '';
  }

  function ensureRoot() {
    if (root && root.parentNode) { return root; }
    if (typeof document === 'undefined' || !document.body) { return null; }

    root = document.createElement('div');
    root.className = 'c-toast-root';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');
    document.body.appendChild(root);
    return root;
  }

  function clearTimers() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = 0; }
  }

  function removeNow() {
    clearTimers();
    if (root) {
      /* 连同正在退场、已经脱离 toastEl 引用的旧节点一起清掉，避免孤儿。 */
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
      root.classList.remove('c-toast-root--action');
    }
    toastEl = null;
  }

  function normalizeType(type) {
    if (type === 'success' || type === 'danger' || type === 'warning' || type === 'info') {
      return type;
    }
    return 'info';
  }

  function typeIcon(type) {
    if (type === 'success') { return 'check-circle'; }
    if (type === 'danger') { return 'x-circle'; }
    if (type === 'warning') { return 'warning'; }
    return 'info';
  }

  function dismiss() {
    if (!toastEl) { return; }
    var el = toastEl;
    toastEl = null;
    clearTimers();
    token += 1;
    el.classList.remove('is-visible');
    el.classList.add('is-leaving');
    exitTimer = setTimeout(function () {
      exitTimer = 0;
      if (el.parentNode) { el.parentNode.removeChild(el); }
      if (root && !root.querySelector('.c-toast')) {
        root.classList.remove('c-toast-root--action');
      }
    }, EXIT_MS);
  }

  /**
   * show(msg, opts)
   * opts.action 存在时展示撤销条：5s 后消失，点击 action 先执行 onClick 再消失。
   */
  function show(msg, opts) {
    if (typeof document === 'undefined' || !document.body) { return null; }
    var options = opts && typeof opts === 'object' ? opts : {};
    var type = normalizeType(options.type);
    var action = options.action && typeof options.action === 'object' ? options.action : null;
    var actionLabel = action && action.label ? String(action.label) : '撤销';

    var host = ensureRoot();
    if (!host) { return null; }

    /* 新的顶掉旧的：旧提示不播退出动画，直接移除。 */
    removeNow();

    var current = ++token;
    var node = make('div', 'c-toast c-toast--' + type + (action ? ' c-toast--action' : ''));
    node.setAttribute('data-type', type);

    var icon = make('span', 'c-toast__icon');
    icon.innerHTML = iconHtml(typeIcon(type)); /* 常量 SVG，无用户数据 */
    node.appendChild(icon);

    var text = make('span', 'c-toast__text');
    text.textContent = String(msg === null || msg === undefined ? '' : msg);
    node.appendChild(text);

    if (action) {
      host.classList.add('c-toast-root--action');
      var actionBtn = make('button', 'c-toast__action');
      actionBtn.type = 'button';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', function () {
        if (token !== current) { return; }
        try {
          if (typeof action.onClick === 'function') { action.onClick(); }
        } catch (error) {
          if (global.console && global.console.error) {
            global.console.error('toast action 回调失败', error);
          }
        }
        dismiss();
      });
      node.appendChild(actionBtn);

      var progress = make('span', 'c-toast__progress');
      node.appendChild(progress);
    }

    host.appendChild(node);
    toastEl = node;

    /* 下一帧再加 is-visible，确保过渡从初始态开始。 */
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        if (token === current && toastEl === node) { node.classList.add('is-visible'); }
      });
    } else {
      node.classList.add('is-visible');
    }

    timer = setTimeout(function () {
      timer = 0;
      if (token === current && toastEl === node) { dismiss(); }
    }, action ? DURATION_ACTION : DURATION_PLAIN);

    return Object.freeze({
      dismiss: dismiss,
      element: node
    });
  }

  function hide() {
    dismiss();
  }

  function current() {
    return toastEl;
  }

  var api = Object.freeze({
    show: show,
    hide: hide,
    dismiss: dismiss,
    clear: removeNow,
    current: current,
    DURATION_PLAIN: DURATION_PLAIN,
    DURATION_ACTION: DURATION_ACTION
  });

  UI.toast = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.toast) { lower.toast = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
