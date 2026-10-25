/* 小账本 2.0 · js/ui/kit.js
 * 屏幕构建器的唯一入口：el / icon / tile / money / section / group / row / pill
 * / delta / bar / empty / btn / stagger。
 *
 * 存在理由：v2.0 的 8 个屏幕各自写了一份 el / make / clear / appendAll /
 * iconNode / centsText，约 600 行重复，且每画一个图标就 new 一次 DOMParser。
 * 这里把「组件长什么样」收敛成一份，屏幕只描述「这一屏有什么」。
 *
 * 公开：XZB.ui.kit（镜像 XZB.UI.kit）
 * 约束：不读业务数据、不写库、不用 innerHTML；用户文本一律 textContent。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.kit) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.kit 已注册，保留首个实现');
    }
    return;
  }

  var doc = typeof document !== 'undefined' ? document : null;

  function dom() { return UI.dom || null; }
  function iconsApi() { return UI.icons || null; }
  function coreMoney() {
    var core = XZB.Core || XZB.core || {};
    return core.money || null;
  }

  /* ---------------- 基础 ---------------- */

  function el(tag, attrs, kids) {
    var d = dom();
    if (d && typeof d.el === 'function') { return d.el(tag, attrs, kids); }
    var node = doc.createElement(String(tag || 'div'));
    var options = attrs && typeof attrs === 'object' ? attrs : {};
    var className = options.className || options['class'];
    if (className) { node.className = String(className); }
    if (options.text !== undefined && options.text !== null) {
      node.textContent = String(options.text);
    }
    append(node, kids !== undefined && kids !== null ? kids : options.children);
    return node;
  }

  function append(node, kids) {
    if (!node || kids === undefined || kids === null || kids === false) { return node; }
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i += 1) { append(node, kids[i]); }
      return node;
    }
    if (kids && typeof kids.nodeType === 'number') {
      node.appendChild(kids);
      return node;
    }
    node.appendChild(doc.createTextNode(String(kids)));
    return node;
  }

  function clear(node) {
    if (!node) { return node; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
    return node;
  }

  function text(value) {
    return doc.createTextNode(String(value === undefined || value === null ? '' : value));
  }

  function cls() {
    var d = dom();
    if (d && typeof d.cls === 'function') { return d.cls.apply(null, arguments); }
    var out = [];
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i]) { out.push(String(arguments[i])); }
    }
    return out.join(' ');
  }

  /* ---------------- 图标（带缓存） ---------------- */

  var iconCache = Object.create(null);

  function icon(name, size, className) {
    var icons = iconsApi();
    if (!icons) { return el('span', { className: 'c-icon' }); }
    var px = Number(size) || 20;
    var key = String(name || 'ellipsis') + '|' + px + '|' + (className || '');
    var proto = iconCache[key];
    if (!proto) {
      var built = null;
      if (typeof icons.node === 'function') {
        built = icons.node(name, { size: px, className: className || '' });
      }
      if (!built) { return el('span', { className: 'c-icon' }); }
      proto = built;
      iconCache[key] = proto;
    }
    return proto.cloneNode(true);
  }

  /* 图标底座：分类色 / 账户色 / 中性 / 主色 */
  function tile(name, options) {
    var o = options || {};
    var size = o.size === 'lg' ? 'lg' : 'md';
    var tone = o.tone ? ' c-tile--' + String(o.tone) : '';
    var node = el('span', { className: 'c-tile' + (size === 'lg' ? ' c-tile--lg' : '') + tone });
    node.appendChild(icon(name, o.iconSize || (size === 'lg' ? 22 : 19)));
    return node;
  }

  /* ---------------- 金额 ---------------- */

  var TONES = { expense: 1, income: 1, muted: 1, hero: 1, transfer: 1 };
  var SIZES = { hero: 1, xl: 1, lg: 1, md: 1, sm: 1 };

  function moneyParts(cents) {
    var money = coreMoney();
    var n = Math.round(Number(cents) || 0);
    var abs = Math.abs(n);
    var body;
    if (money && typeof money.formatCents === 'function') {
      body = money.formatCents(abs, { symbol: false });
    } else {
      var yuan = Math.floor(abs / 100);
      var fen = abs % 100;
      body = String(yuan) + '.' + (fen < 10 ? '0' + fen : String(fen));
    }
    var dot = body.lastIndexOf('.');
    return {
      negative: n < 0,
      int: dot >= 0 ? body.slice(0, dot) : body,
      frac: dot >= 0 ? body.slice(dot + 1) : ''
    };
  }

  /* 「贵」的数字排版：符号小一号、整数撑满、小数降一档且压暗。 */
  function money(cents, options) {
    var o = options || {};
    var wrap = el('span', { className: 'c-money' });
    if (SIZES[o.size]) { wrap.classList.add('c-money--' + o.size); }
    if (TONES[o.tone]) { wrap.classList.add('c-money--' + o.tone); }
    if (o.block) { wrap.classList.add('c-money--block'); }

    if (o.hidden) {
      wrap.appendChild(el('span', { className: 'c-money__int', text: '••••' }));
      return wrap;
    }

    var parts = moneyParts(cents);
    var sign = parts.negative ? '−' : (o.sign === true ? '+' : '');
    if (sign) {
      wrap.appendChild(el('span', { className: 'c-money__sign', text: sign }));
    }
    if (o.symbol !== false) {
      wrap.appendChild(el('span', { className: 'c-money__cur', text: '¥' }));
    }
    wrap.appendChild(el('span', { className: 'c-money__int', text: parts.int }));
    if (parts.frac && o.decimals !== false) {
      wrap.appendChild(el('span', { className: 'c-money__frac', text: '.' + parts.frac }));
    }
    return wrap;
  }

  function fmt(cents, options) {
    var moneyApi = coreMoney();
    if (moneyApi && typeof moneyApi.formatCents === 'function') {
      return moneyApi.formatCents(cents, options || {});
    }
    return String(cents);
  }

  /* ---------------- 区块 ---------------- */

  function section(options) {
    var o = options || {};
    var node = el('section', { className: cls('c-section', o.className) });
    if (o.title || o.action) {
      var head = el('div', { className: 'c-section__head' });
      if (o.title) {
        head.appendChild(el('h2', { className: 'c-section__title', text: o.title }));
      } else {
        head.appendChild(el('span', { className: 'c-section__title' }));
      }
      if (o.action && o.action.label) {
        var action;
        if (o.action.href) {
          action = el('a', { className: 'c-section__action', href: o.action.href, text: o.action.label });
        } else {
          action = el('button', {
            className: 'c-section__action',
            type: 'button',
            text: o.action.label
          });
          if (typeof o.action.onClick === 'function') {
            action.addEventListener('click', o.action.onClick);
          }
        }
        head.appendChild(action);
      }
      node.appendChild(head);
    }
    return node;
  }

  function group(options) {
    var o = options || {};
    return el('div', { className: cls('c-group', o.className) });
  }

  function card(options) {
    var o = options || {};
    return el('div', { className: cls('c-card', o.className) });
  }

  function pill(value, tone, iconName) {
    var node = el('span', { className: cls('c-pill', tone ? 'c-pill--' + tone : '') });
    if (iconName) { node.appendChild(icon(iconName, 12)); }
    node.appendChild(text(value));
    return node;
  }

  /* 环比：up 用支出语义（花得多=红），down=绿；goodWhen 反转收入场景 */
  function delta(pct, options) {
    var o = options || {};
    var node = el('span', { className: 'c-delta' });
    if (pct === null || pct === undefined || !isFinite(Number(pct))) {
      node.classList.add('c-delta--flat');
      node.appendChild(el('span', { text: '—' }));
      return node;
    }
    var value = Number(pct);
    var up = value > 0;
    if (Math.abs(value) < 0.05) {
      node.classList.add('c-delta--flat');
      node.appendChild(el('span', { text: '持平' }));
      return node;
    }
    node.appendChild(icon(up ? 'arrow-up' : 'arrow-down', 11));
    node.appendChild(el('span', { text: Math.abs(value).toFixed(1) + '%' }));
    var positiveTone = o.inverse === true ? 'c-delta--down' : 'c-delta--up';
    node.classList.add(up ? positiveTone : (positiveTone === 'c-delta--up' ? 'c-delta--down' : 'c-delta--up'));
    return node;
  }

  function bar(pct, tone) {
    var value = Math.max(0, Math.min(100, Number(pct) || 0));
    var wrap = el('div', {
      className: cls('c-progress', tone ? 'c-progress--' + tone : ''),
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(Math.round(value))
    });
    var fill = el('div', { className: 'c-progress__bar' });
    fill.style.transform = 'scaleX(' + value / 100 + ')';
    wrap.appendChild(fill);
    return wrap;
  }

  /* ---------------- 色槽：全应用唯一映射 ----------------
   * v2.0 的坑：首页按 categories 顺序 i%12 算色，记账页按 category.color 上色，
   * 同一个「餐饮」在不同屏颜色不一样。这里统一按分类在表里的顺序取槽，
   * 账户按类型取槽（debit 用 bank 的色）。屏幕只调这两个函数，不再自己算。
   */

  var ACCOUNT_TONE = {
    cash: 'acc-cash',
    debit: 'acc-bank',
    wechat: 'acc-wechat',
    alipay: 'acc-alipay',
    credit: 'acc-credit',
    savings: 'acc-savings'
  };

  function categoryTones(categories) {
    var map = Object.create(null);
    for (var i = 0; i < (categories || []).length; i += 1) {
      var category = categories[i];
      if (category && typeof category.id === 'string') {
        map[category.id] = 'cat-' + ((i % 12) + 1);
      }
    }
    return map;
  }

  function accountTone(type) {
    return ACCOUNT_TONE[String(type || '')] || 'tint';
  }

  /* ---------------- 行 ---------------- */

  function row(options) {
    var o = options || {};
    var tagName = o.href ? 'a' : (o.onClick ? 'button' : 'div');
    var node = doc.createElement(tagName);
    node.className = cls('c-row', o.compact ? 'c-row--compact' : '');
    if (o.href) {
      node.setAttribute('href', String(o.href));
    } else if (o.onClick) {
      node.setAttribute('type', 'button');
    }
    if (o.ariaLabel) { node.setAttribute('aria-label', String(o.ariaLabel)); }

    if (o.icon) {
      node.appendChild(o.tile === false
        ? icon(o.icon, 22)
        : tile(o.icon, { tone: o.tone, size: o.tileSize, iconSize: o.iconSize }));
      node.classList.add('c-row--with-tile');
    } else if (o.lead) {
      node.appendChild(o.lead);
    }

    var main = el('span', { className: 'c-row__main' });
    main.appendChild(el('span', { className: 'c-row__title', text: o.title === undefined ? '' : o.title }));
    if (o.sub) {
      main.appendChild(el('span', { className: 'c-row__sub', text: o.sub }));
    }
    node.appendChild(main);

    if (o.trailing) {
      node.appendChild(o.trailing);
    } else if (o.value !== undefined && o.value !== null) {
      var value = el('span', {
        className: cls('c-row__value', o.valueTone ? 'c-row__value--' + o.valueTone : '', o.valueStrong ? 'c-row__value--strong' : '')
      });
      if (typeof o.value === 'string' || typeof o.value === 'number') {
        value.textContent = String(o.value);
      } else {
        value.appendChild(o.value);
      }
      node.appendChild(value);
    }

    if (o.chevron) {
      node.appendChild(icon('chevron-right', 16, 'c-row__chevron'));
    } else if (o.href || o.onClick) {
      node.classList.add('c-row--tappable');
    }

    if (typeof o.onClick === 'function') {
      node.addEventListener('click', o.onClick);
    }
    return node;
  }

  /* ---------------- 空态 ---------------- */

  function empty(options) {
    var o = options || {};
    var box = el('div', { className: cls('c-empty', o.className) });
    if (o.icon) {
      var holder = el('span', { className: 'c-empty__icon' });
      holder.appendChild(icon(o.icon, o.iconSize || 40));
      box.appendChild(holder);
    }
    if (o.title) { box.appendChild(el('p', { className: 'c-empty__title', text: o.title })); }
    if (o.text) { box.appendChild(el('p', { className: 'c-empty__desc', text: o.text })); }
    if (o.action && o.action.label) {
      var cta = btn(o.action.label, {
        variant: o.action.variant || 'primary',
        href: o.action.href,
        onClick: o.action.onClick
      });
      cta.classList.add('c-empty__action');
      box.appendChild(cta);
    }
    return box;
  }

  /* ---------------- 按钮 ---------------- */

  function btn(label, options) {
    var o = options || {};
    var tagName = o.href ? 'a' : 'button';
    var node = doc.createElement(tagName);
    node.className = cls('c-btn', o.variant ? 'c-btn--' + o.variant : '', o.size ? 'c-btn--' + o.size : '',
      o.block ? 'c-btn--block' : '', o.className);
    if (o.href) {
      node.setAttribute('href', String(o.href));
    } else {
      node.setAttribute('type', 'button');
    }
    if (o.ariaLabel) { node.setAttribute('aria-label', String(o.ariaLabel)); }
    if (o.disabled) { node.disabled = true; }
    if (o.icon) { node.appendChild(icon(o.icon, o.iconSize || 18)); }
    if (label !== undefined && label !== null && label !== '') {
      node.appendChild(el('span', { text: label }));
    }
    if (typeof o.onClick === 'function') {
      node.addEventListener('click', o.onClick);
    }
    return node;
  }

  /* ---------------- 入场错位（只在首次进入时挂，避免 rerender 抖动） ---------------- */

  function stagger(nodes, options) {
    var o = options || {};
    var items = Array.isArray(nodes) ? nodes : [nodes];
    var step = o.step === undefined ? 26 : o.step;
    var cap = o.cap === undefined ? 6 : o.cap;
    for (var i = 0; i < items.length; i += 1) {
      var node = items[i];
      if (!node || !node.style) { continue; }
      node.classList.add('c-stagger');
      node.style.setProperty('--i', String(Math.min(i, cap)));
      node.style.setProperty('--stagger-step', step + 'ms');
    }
    return items;
  }

  var api = Object.freeze({
    el: el,
    append: append,
    clear: clear,
    text: text,
    cls: cls,
    icon: icon,
    tile: tile,
    money: money,
    moneyParts: moneyParts,
    fmt: fmt,
    section: section,
    group: group,
    card: card,
    pill: pill,
    delta: delta,
    bar: bar,
    categoryTones: categoryTones,
    accountTone: accountTone,
    row: row,
    empty: empty,
    btn: btn,
    stagger: stagger
  });

  UI.kit = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.kit) { lower.kit = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
