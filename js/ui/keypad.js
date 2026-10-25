/* 小账本 2.0 · js/ui/keypad.js · owner: 前端#1（T04）
 * 金额数字键盘。公开：XZB.ui.keypad（镜像 XZB.UI.keypad）
 *   mount(el, {
 *     value, cents, onConfirm, onChange,
 *     vibrate, disabled, maxIntegerDigits, maxDecimals
 *   })
 * 返回句柄：{ el, root, value(), setValue(), cents(), clear(), confirm(),
 *            disable(), enable(), setVibrate(), destroy() }
 * 规则：1–9/0/小数点/删除/完成；金额最多 9 位整数 + 2 位小数；
 *       长按删除连删；确认结果 {ok:true,cents} 或 {ok:false,code}；
 *       数字键用 CSS Grid 4 列，键高 ≥44px；中文 aria-label。
 * 依赖：XZB.core.money.parseAmount（UI 层必须先加载 core/money.js）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.keypad) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.keypad 已注册，保留首个实现');
    }
    return;
  }

  var HOLD_DELAY = 500;
  var HOLD_REPEAT = 80;

  function dom() {
    return (XZB.ui && XZB.ui.dom) || (XZB.UI && XZB.UI.dom) || null;
  }

  function icons() {
    return (XZB.ui && XZB.ui.icons) || (XZB.UI && XZB.UI.icons) || null;
  }

  function money() {
    return (XZB.core && XZB.core.money) || (XZB.Core && XZB.Core.money) || null;
  }

  function make(tag, className, text) {
    var d = dom();
    var node;
    if (d && d.el) {
      node = d.el(tag, { className: className });
    } else {
      node = document.createElement(tag);
      if (className) { node.className = className; }
    }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function readHapticsPreference() {
    try {
      if (!global.localStorage) { return true; }
      var raw = global.localStorage.getItem('xzb.ui.v2');
      if (!raw) { return true; }
      var prefs = JSON.parse(raw);
      if (prefs && (prefs.haptics === false || prefs.vibrate === false)) { return false; }
      if (prefs && (prefs.haptics === true || prefs.vibrate === true)) { return true; }
    } catch (error) { /* 隐私模式/损坏数据：按默认开启 */ }
    return true;
  }

  function sanitize(value, maxInteger, maxDecimals) {
    var text = String(value === null || value === undefined ? '' : value);
    text = text.replace(/[^\d.]/g, '');
    var dot = text.indexOf('.');
    if (dot >= 0) {
      var intPart = text.slice(0, dot).replace(/^0+(?=\d)/, '').slice(0, maxInteger);
      var decPart = text.slice(dot + 1).replace(/\./g, '').slice(0, maxDecimals);
      if (!intPart) { intPart = '0'; }
      return intPart + '.' + decPart;
    }
    text = text.replace(/^0+(?=\d)/, '').slice(0, maxInteger);
    return text;
  }

  function mount(el, options) {
    var host = typeof el === 'string' ? document.querySelector(el) : el;
    if (!host) {
      throw new Error('XZB.ui.keypad.mount 需要一个容器元素');
    }

    var opts = options && typeof options === 'object' ? options : {};
    var maxInteger = Math.max(1, Number(opts.maxIntegerDigits) || 9);
    var maxDecimals = opts.maxDecimals === undefined
      ? 2
      : Math.max(0, Number(opts.maxDecimals) || 0);
    if (maxDecimals > 2) { maxDecimals = 2; }

    var hapticsEnabled = opts.vibrate === false || opts.haptics === false
      ? false
      : (opts.vibrate === true || opts.haptics === true ? true : readHapticsPreference());

    var value = sanitize(opts.value === undefined ? '' : opts.value, maxInteger, maxDecimals);
    if (!value && opts.cents !== undefined && opts.cents !== null) {
      var m0 = money();
      if (m0 && typeof m0.formatCents === 'function') {
        value = sanitize(String(m0.formatCents(Number(opts.cents))).replace(/[^\d.]/g, ''), maxInteger, maxDecimals);
      }
    }

    var disabled = !!opts.disabled;
    var destroyed = false;

    /* ---------- 结构 ---------- */
    var root = make('div', 'c-keypad');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', '金额键盘');

    var display = make('div', 'c-keypad__display');
    display.setAttribute('aria-live', 'polite');
    display.setAttribute('aria-atomic', 'true');

    var currency = make('span', 'c-keypad__currency', '¥');
    currency.setAttribute('aria-hidden', 'true');
    display.appendChild(currency);

    var amount = make('span', 'c-keypad__amount is-empty', '0.00');
    display.appendChild(amount);
    root.appendChild(display);

    var grid = make('div', 'c-keypad__grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', '数字键');
    root.appendChild(grid);

    var buttons = {};
    var confirmBtn = null;

    function vibrate() {
      if (!hapticsEnabled || disabled) { return; }
      try {
        if (global.navigator && typeof global.navigator.vibrate === 'function') {
          global.navigator.vibrate(8);
        }
      } catch (error) { /* iOS 无震动，静默降级 */ }
    }

    function parseCurrent() {
      var m = money();
      if (!m || typeof m.parseAmount !== 'function') {
        return { ok: false, code: 'E_MONEY_MISSING' };
      }
      return m.parseAmount(value, { allowNegative: false });
    }

    function render() {
      var text = value || '0.00';
      amount.textContent = text;
      var zero = false;
      if (!value) {
        zero = true;
      } else {
        var parsed = parseCurrent();
        zero = parsed.ok && parsed.cents === 0;
      }
      amount.classList.toggle('is-empty', zero);
      display.setAttribute('aria-label', '金额 ' + text + ' 元');

      if (confirmBtn) {
        if (disabled || zero) {
          confirmBtn.setAttribute('aria-disabled', 'true');
        } else {
          confirmBtn.removeAttribute('aria-disabled');
        }
      }
    }

    function notifyChange() {
      if (typeof opts.onChange === 'function') {
        try { opts.onChange(value); } catch (error) {
          if (global.console && global.console.error) {
            global.console.error('keypad onChange 回调失败', error);
          }
        }
      }
    }

    function appendDigit(digit) {
      if (disabled || destroyed) { return; }
      var next = value;
      var dot = next.indexOf('.');

      if (dot >= 0) {
        var decimals = next.slice(dot + 1);
        if (decimals.length >= maxDecimals) { return; }
        next += digit;
      } else {
        if (next.length >= maxInteger && next !== '0') { return; }
        if (next === '0') {
          next = digit === '0' ? '0' : digit;
        } else {
          next += digit;
        }
      }
      value = next;
      render();
      notifyChange();
      vibrate();
    }

    function appendDot() {
      if (disabled || destroyed || maxDecimals === 0) { return; }
      if (value.indexOf('.') >= 0) { return; }
      value = value ? value + '.' : '0.';
      render();
      notifyChange();
      vibrate();
    }

    function deleteOne() {
      if (disabled || destroyed) { return; }
      if (!value) { return; }
      value = value.slice(0, -1);
      render();
      notifyChange();
      vibrate();
    }

    function makeKey(key, label, ariaLabel, extraClass) {
      var button = make('button', 'c-keypad__key' + (extraClass ? ' ' + extraClass : ''), label);
      button.type = 'button';
      button.setAttribute('data-key', key);
      button.setAttribute('aria-label', ariaLabel);
      if (disabled) { button.disabled = true; }
      buttons[key] = button;
      return button;
    }

    function addDigitKey(key, label, column, row) {
      var button = makeKey(key, label, '数字 ' + label);
      if (column) { button.style.gridColumn = column; }
      if (row) { button.style.gridRow = row; }
      button.addEventListener('click', function () { appendDigit(key); });
      grid.appendChild(button);
      return button;
    }

    /* 第 1 行：1 2 3 删除 */
    addDigitKey('1', '1');
    addDigitKey('2', '2');
    addDigitKey('3', '3');

    var deleteBtn = makeKey('delete', '', '删除');
    deleteBtn.classList.add('c-keypad__key--delete');
    var delIcon = icons();
    if (delIcon && typeof delIcon.icon === 'function') {
      deleteBtn.innerHTML = delIcon.icon('backspace', { size: 24 }); /* 常量 SVG */
    } else {
      deleteBtn.textContent = '⌫';
    }
    grid.appendChild(deleteBtn);

    /* 第 2 行：4 5 6 + 跨 3 行的完成键 */
    addDigitKey('4', '4');
    addDigitKey('5', '5');
    addDigitKey('6', '6');

    confirmBtn = makeKey('confirm', '完成', '确认金额，完成记账', 'c-keypad__key--confirm');
    confirmBtn.addEventListener('click', function () {
      if (disabled) { return; }
      confirm();
    });
    grid.appendChild(confirmBtn);

    /* 第 3 行：7 8 9 */
    addDigitKey('7', '7');
    addDigitKey('8', '8');
    addDigitKey('9', '9');

    /* 第 4 行：. 0 00（第 4 列由完成键跨行占据） */
    var dotBtn = makeKey('dot', '.', '小数点', 'c-keypad__key--dot');
    dotBtn.addEventListener('click', appendDot);
    grid.appendChild(dotBtn);

    addDigitKey('0', '0');

    var doubleZero = makeKey('00', '00', '两个零', 'c-keypad__key--zero');
    doubleZero.addEventListener('click', function () {
      appendDigit('0');
      appendDigit('0');
    });
    grid.appendChild(doubleZero);

    /* ---------- 长按删除连删 ---------- */
    var holdTimer = 0;
    var repeatTimer = 0;
    var holdActive = false;
    var suppressClick = false;

    function stopHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
      if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = 0; }
      holdActive = false;
    }

    function startHold(event) {
      if (disabled || event.button === 2) { return; }
      suppressClick = false;
      stopHold();
      holdActive = true;
      if (event.pointerId !== undefined && deleteBtn.setPointerCapture) {
        try { deleteBtn.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      }
      holdTimer = setTimeout(function () {
        holdTimer = 0;
        suppressClick = true;
        deleteOne();
        repeatTimer = setInterval(deleteOne, HOLD_REPEAT);
      }, HOLD_DELAY);
    }

    function endHold() {
      stopHold();
      /* click 在 pointerup 之后同步触发；用 0ms 定时器在 click 之后再复位。 */
      setTimeout(function () { suppressClick = false; }, 0);
    }

    deleteBtn.addEventListener('pointerdown', startHold);
    deleteBtn.addEventListener('pointerup', endHold);
    deleteBtn.addEventListener('pointercancel', endHold);
    deleteBtn.addEventListener('pointerleave', function () {
      if (holdActive) { endHold(); }
    });
    deleteBtn.addEventListener('click', function (event) {
      if (suppressClick) {
        event.preventDefault();
        suppressClick = false;
        return;
      }
      deleteOne();
    });

    /* ---------- 对外行为 ---------- */
    function setValue(next) {
      value = sanitize(next, maxInteger, maxDecimals);
      render();
      notifyChange();
      return value;
    }

    function clear() {
      value = '';
      render();
      notifyChange();
    }

    function cents() {
      if (!value) { return null; }
      var parsed = parseCurrent();
      return parsed.ok ? parsed.cents : null;
    }

    function confirm() {
      if (disabled) {
        return { ok: false, code: 'E_KEYPAD_DISABLED' };
      }
      if (!value) {
        var empty = { ok: false, code: 'E_AMOUNT_EMPTY' };
        if (typeof opts.onConfirm === 'function') {
          try { opts.onConfirm(empty); } catch (error) { /* 由调用方处理 */ }
        }
        return empty;
      }
      var parsed = parseCurrent();
      var result;
      if (!parsed.ok) {
        result = { ok: false, code: parsed.code };
      } else if (parsed.cents <= 0) {
        result = { ok: false, code: 'E_AMOUNT_ZERO' };
      } else {
        result = { ok: true, cents: parsed.cents };
      }
      if (typeof opts.onConfirm === 'function') {
        try { opts.onConfirm(result); } catch (error) {
          if (global.console && global.console.error) {
            global.console.error('keypad onConfirm 回调失败', error);
          }
        }
      }
      return result;
    }

    function setDisabled(next) {
      disabled = !!next;
      Object.keys(buttons).forEach(function (key) {
        buttons[key].disabled = disabled;
      });
      render();
    }

    function setVibrate(next) {
      hapticsEnabled = !!next;
    }

    function destroy() {
      if (destroyed) { return; }
      destroyed = true;
      stopHold();
      if (root.parentNode) { root.parentNode.removeChild(root); }
    }

    /* 初值、首次渲染 */
    render();
    host.appendChild(root);

    var handle = Object.freeze({
      el: host,
      root: root,
      value: function () { return value; },
      setValue: setValue,
      cents: cents,
      clear: clear,
      confirm: confirm,
      disable: function () { setDisabled(true); },
      enable: function () { setDisabled(false); },
      setVibrate: setVibrate,
      destroy: destroy
    });

    return handle;
  }

  var api = Object.freeze({
    mount: mount,
    create: mount
  });

  UI.keypad = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.keypad) { lower.keypad = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
