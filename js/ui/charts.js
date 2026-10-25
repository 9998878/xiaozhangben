/* ============================================================
   小账本 2.0 · 图表引擎（纯 SVG，零依赖）
   ------------------------------------------------------------
   对外 API（挂在 window.XZB.UI.charts，同时镜像到 XZB.ui.charts）：
     donut(el, data, opts)      分类构成环图 / 进度环
     line(el, series, opts)     趋势折线（面积渐变 + 数据点）
     bars(el, data, opts)       柱状图（横向排行 / 纵向趋势）
     heatmap(el, data, opts)    日历热力图（整月日期网格，5 级强度）
     sparkline(el, values, opts) 迷你折线
     stackbar(el, segments, opts) 账户构成堆叠条

   设计约束：
   1. 颜色一律通过 CSS 变量（var(--c-*) / var(--cat-*) / var(--heat-*)）
      或 currentColor 表达，JS 里不出现任何写死色值，深色模式自动跟随；
   2. 使用 viewBox + preserveAspectRatio 自适应，容器宽度变化无需重算；
   3. 每张图根节点 role="img"、中文 aria-label、内部 <title>，
      并在容器内输出一份 class="u-visually-hidden" 的数据表供读屏；
   4. 不拼 innerHTML：全部用 createElementNS 建树，数字先 Number 收敛，
      文本一律经 text() 白名单清洗后走 textContent；
   5. 空数据、全 0、单点、负值都有明确文案，不抛异常。
   ============================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});

  /* 同一命名空间只允许注册一次，保留首个实现 */
  if (UI.charts) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.charts 已注册，保留首个实现');
    }
    return;
  }

  var NS = 'http://www.w3.org/2000/svg';
  var UID = 0;

  /* 分类色 12 槽（UI.md §9：--cat-1..12）；只存变量名，不存色值 */
  var PALETTE = [
    '--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6',
    '--cat-7', '--cat-8', '--cat-9', '--cat-10', '--cat-11', '--cat-12'
  ];

  /* 读屏回退表：视觉隐藏但保留在可访问树中 */
  var HIDDEN_STYLE = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;' +
    'overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';

  var FONT_FAMILY = 'var(--font-sans,-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif)';
  var FS_11 = 'var(--fs-caption,0.6875rem)';
  var FS_13 = 'var(--fs-footnote,0.8125rem)';
  var FS_15 = 'var(--fs-subhead,0.9375rem)';
  var FS_17 = 'var(--fs-body,1.0625rem)';
  var FS_20 = 'var(--fs-title-3,1.25rem)';

  var EMPTY_TEXT = '暂无数据';

  /* ---------- 基础工具 ---------- */

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function finite(v) {
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  /* 金额统一收敛为整数分；非法值归 0 */
  function cents(v) {
    var n = finite(v);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function clamp(n, lo, hi) {
    if (!isFinite(n)) return lo;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* 文本白名单：去控制字符、压空白、按字符数截断（防溢出） */
  function text(v, max) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
    if (max && s.length > max) {
      s = s.slice(0, Math.max(1, max - 1)) + '…';
    }
    return s;
  }

  /* 颜色白名单：只接受 CSS 变量名、token 简写或 currentColor，其余回落 */
  function tokenColor(value, fallback) {
    if (typeof value === 'string') {
      var v = value.replace(/^\s+|\s+$/g, '');
      if (v === 'currentColor') return v;
      var m = /^var\(\s*(--(?:c|cat|acc|heat)-[a-z0-9-]{1,40})\s*\)$/.exec(v);
      if (m) return 'var(' + m[1] + ')';
      m = /^--((?:c|cat|acc|heat)-[a-z0-9-]{1,40})$/.exec(v);
      if (m) return 'var(--' + m[1] + ')';
      m = /^((?:c|cat|acc|heat)-[a-z0-9-]{1,40})$/.exec(v);
      if (m) return 'var(--' + m[1] + ')';
    }
    /* 回落值也要过一遍白名单：否则会把 "--cat-1" 这样的裸变量名写进 style */
    if (typeof fallback === 'string' && fallback && fallback !== value) {
      var safe = tokenColor(fallback, null);
      if (safe !== 'currentColor') return safe;
    }
    return 'currentColor';
  }

  function styleOf(map) {
    var out = [];
    for (var k in map) {
      if (has(map, k) && map[k] !== null && map[k] !== undefined) {
        out.push(k + ':' + map[k]);
      }
    }
    return out.join(';');
  }

  function mk(doc, tag, attrs, style) {
    var node = doc.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (has(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    if (style) node.setAttribute('style', styleOf(style));
    return node;
  }

  function addText(doc, parent, content, attrs, style) {
    var node = mk(doc, 'text', attrs, style);
    node.textContent = content;
    parent.appendChild(node);
    return node;
  }

  function docOf(el) {
    if (el && el.ownerDocument) return el.ownerDocument;
    return global.document || null;
  }

  function clearEl(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  /* 容器测量：优先显式 opts.width/height，其次 clientWidth/Height，最后兜底 */
  function boxOf(el, opts, defHeight) {
    opts = opts || {};
    var w = opts.width !== undefined ? finite(opts.width) : NaN;
    if (!(w > 0) && el) w = finite(el.clientWidth);
    if (!(w > 0)) w = 320;
    var h = opts.height !== undefined ? finite(opts.height) : NaN;
    if (!(h > 0) && el) h = finite(el.clientHeight);
    if (!(h > 0)) h = defHeight;
    return {
      w: Math.max(160, Math.round(w)),
      h: Math.max(24, Math.round(h))
    };
  }

  /* 金额格式：优先走 Core.money，未加载时用等价字符串实现 */
  function coreMoney() {
    return XZB.Core && XZB.Core.money && typeof XZB.Core.money === 'object' ? XZB.Core.money : null;
  }

  function fmtCents(value) {
    var n = cents(value);
    var money = coreMoney();
    if (money && typeof money.formatCents === 'function') {
      try {
        return String(money.formatCents(n));
      } catch (e) { /* 回落 */ }
    }
    var neg = n < 0;
    var abs = Math.abs(n);
    var yuan = Math.floor(abs / 100);
    var frac = abs % 100;
    var s = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + (frac < 10 ? '0' : '') + frac;
    return (neg ? '-' : '') + '¥' + s;
  }

  function trim1(n) {
    var r = Math.round(n * 10) / 10;
    return String(r).replace(/\.0$/, '');
  }

  function fmtCompact(value) {
    var n = cents(value);
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    var money = coreMoney();
    if (money && typeof money.formatCompact === 'function') {
      try {
        return String(money.formatCompact(n));
      } catch (e) { /* 回落 */ }
    }
    if (abs >= 10000000000) return sign + '¥' + trim1(abs / 10000000000) + '亿';
    if (abs >= 1000000) return sign + '¥' + trim1(abs / 1000000) + '万';
    return fmtCents(n);
  }

  function pct1(part, total) {
    if (!(total > 0)) return 0;
    return Math.round(part / total * 1000) / 10;
  }

  function pctText(part, total) {
    var p = pct1(part, total);
    return (p % 1 === 0 ? String(p) : p.toFixed(1)) + '%';
  }

  function fmtPct(p) {
    var n = Math.round(finite(p) * 10) / 10;
    if (!isFinite(n)) n = 0;
    return (n % 1 === 0 ? String(n) : n.toFixed(1)) + '%';
  }

  function n2(v) {
    var n = finite(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  function byCaller(fn, value, fallback) {
    if (typeof fn === 'function') {
      try {
        return text(fn(value), 12);
      } catch (e) { /* 回落 */ }
    }
    return fallback;
  }

  /* ---------- 根节点与读屏数据表 ---------- */

  function rootSvg(doc, w, h, label) {
    var svg = mk(doc, 'svg', {
      xmlns: NS,
      viewBox: '0 0 ' + w + ' ' + h,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': label,
      focusable: 'false',
      class: 'xzb-chart'
    });
    /* 宽度 100% + 高度 auto：viewBox 自带长宽比，容器变窄时整图等比缩放，无需重算；
       文字用 rem 变量，200% 字号下靠 overflow:visible 兜底不被裁切 */
    svg.setAttribute('style', 'display:block;width:100%;height:auto;overflow:visible;font-family:' + FONT_FAMILY);
    var title = mk(doc, 'title');
    title.textContent = label;
    svg.appendChild(title);
    return svg;
  }

  function buildTable(doc, caption, headers, rows) {
    var table = doc.createElement('table');
    table.setAttribute('class', 'u-visually-hidden u-sr-only');
    table.setAttribute('style', HIDDEN_STYLE);

    var cap = doc.createElement('caption');
    cap.textContent = caption;
    table.appendChild(cap);

    var thead = doc.createElement('thead');
    var tr = doc.createElement('tr');
    for (var i = 0; i < headers.length; i++) {
      var th = doc.createElement('th');
      th.setAttribute('scope', 'col');
      th.textContent = String(headers[i]);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);

    var tbody = doc.createElement('tbody');
    for (var r = 0; r < rows.length; r++) {
      var row = doc.createElement('tr');
      var cells = rows[r] || [];
      for (var c = 0; c < cells.length; c++) {
        var td = doc.createElement('td');
        td.textContent = cells[c] === null || cells[c] === undefined ? '—' : String(cells[c]);
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    return table;
  }

  function paintEmpty(el, opts, defHeight, message, aria, detail) {
    clearEl(el);
    var doc = docOf(el);
    var b = boxOf(el, opts, defHeight);
    var label = aria || message;
    var svg = rootSvg(doc, b.w, b.h, label);
    addText(doc, svg, message, {
      x: b.w / 2,
      y: b.h / 2,
      'text-anchor': 'middle',
      dy: '0.35em'
    }, {
      fill: 'var(--c-text-3)',
      'font-size': FS_13
    });
    var table = buildTable(doc, label, ['状态'], [[text(detail || message, 60)]]);
    el.appendChild(svg);
    el.appendChild(table);
    return { svg: svg, table: table };
  }

  function serializeNode(node) {
    if (!node) return '';
    try {
      if (typeof global.XMLSerializer === 'function') {
        return new global.XMLSerializer().serializeToString(node);
      }
    } catch (e) { /* 回落 outerHTML */ }
    return typeof node.outerHTML === 'string' ? node.outerHTML : '';
  }

  function noopHandle() {
    return {
      el: null,
      svg: null,
      table: null,
      redraw: function () {},
      destroy: function () {},
      toHTML: function () { return ''; }
    };
  }

  function chartHandle(el, painter) {
    var handle = {
      el: el,
      svg: null,
      table: null,
      redraw: function () {
        var out = painter();
        if (out) {
          handle.svg = out.svg || null;
          handle.table = out.table || null;
        }
      },
      destroy: function () {
        clearEl(el);
        handle.svg = null;
        handle.table = null;
      },
      toHTML: function () {
        return serializeNode(handle.svg) + serializeNode(handle.table);
      }
    };
    handle.redraw();
    return handle;
  }

  function padded(opts, def) {
    var p = (opts && opts.padding) || {};
    return {
      top: p.top !== undefined ? Math.max(0, finite(p.top) || 0) : def.top,
      right: p.right !== undefined ? Math.max(0, finite(p.right) || 0) : def.right,
      bottom: p.bottom !== undefined ? Math.max(0, finite(p.bottom) || 0) : def.bottom,
      left: p.left !== undefined ? Math.max(0, finite(p.left) || 0) : def.left
    };
  }

  /* ============================================================
     1. 环图：分类构成 / 进度环
     data: [{ label, value(分), color? }] 或 { items:[...] }
     opts: { total, centerLabel, centerSub, thickness, emptyText }
     ============================================================ */
  function paintDonut(el, data, opts) {
    clearEl(el);
    opts = opts || {};
    var doc = docOf(el);
    var b = boxOf(el, opts, 180);

    var rows = isArray(data) ? data : (data && isArray(data.items) ? data.items : []);
    var items = [];
    var sum = 0;
    var negs = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var raw = row.value !== undefined ? row.value : row.amountCents;
      var v = cents(raw);
      if (v < 0) {
        negs++;
        continue;
      }
      if (v === 0) continue;
      items.push({
        label: text(row.label !== undefined ? row.label : row.name, 14) || '未命名',
        value: v,
        color: tokenColor(row.color, PALETTE[items.length % PALETTE.length])
      });
      sum += v;
    }

    var total = opts.total !== undefined && opts.total !== null ? Math.abs(cents(opts.total)) : 0;
    var top = items[0];
    for (var t = 1; t < items.length; t++) {
      if (items[t].value > top.value) top = items[t];
    }

    if (!items.length && total <= 0) {
      var emptyMsg = opts.emptyText || EMPTY_TEXT;
      return paintEmpty(el, opts, 180, emptyMsg, '环图，' + emptyMsg);
    }

    var aria = opts.ariaLabel ? text(opts.ariaLabel, 100) : '';
    if (!aria) {
      if (total > 0) {
        aria = '进度环：已完成 ' + pctText(sum, total) + '，' + fmtCents(sum) + ' / ' + fmtCents(total);
        if (sum > total) aria += '，已超出目标';
      } else {
        aria = '分类构成环图：共 ' + items.length + ' 类，合计 ' + fmtCents(sum) +
          '，占比最高的是' + top.label + '，' + pctText(top.value, sum);
      }
      if (negs > 0) aria += '；已忽略 ' + negs + ' 项负数金额';
    }

    var w = b.w;
    var h = b.h;
    var svg = rootSvg(doc, w, h, aria);
    var cx = w / 2;
    var cy = h / 2;
    var outer = Math.min(w, h) / 2 - 2;
    var thickness = opts.thickness !== undefined
      ? clamp(finite(opts.thickness), 4, outer * 0.6)
      : clamp(Math.round(outer * 0.24), 8, 40);
    var r = outer - thickness / 2;
    var circumference = 2 * Math.PI * r;

    var track = mk(doc, 'circle', {
      cx: n2(cx),
      cy: n2(cy),
      r: n2(r),
      fill: 'none'
    }, {
      stroke: 'var(--c-fill)',
      'stroke-width': n2(thickness)
    });
    svg.appendChild(track);

    var denom = total > 0 ? Math.max(total, sum) : sum;
    if (denom > 0) {
      var gap = items.length > 1 ? circumference * 0.008 : 0;
      var offset = 0;
      for (var s = 0; s < items.length; s++) {
        var len = (items[s].value / denom) * circumference - gap;
        if (len < 0.5) len = 0.5;
        var seg = mk(doc, 'circle', {
          cx: n2(cx),
          cy: n2(cy),
          r: n2(r),
          fill: 'none',
          transform: 'rotate(-90 ' + n2(cx) + ' ' + n2(cy) + ')'
        }, {
          stroke: items[s].color,
          'stroke-width': n2(thickness),
          'stroke-dasharray': n2(len) + ' ' + n2(Math.max(circumference - len, 0)),
          'stroke-dashoffset': n2(-offset)
        });
        svg.appendChild(seg);
        offset += len + gap;
      }
    }

    var big;
    var sub;
    if (total > 0) {
      big = opts.centerLabel !== undefined && opts.centerLabel !== null
        ? text(opts.centerLabel, 10) : pctText(sum, total);
      sub = opts.centerSub !== undefined && opts.centerSub !== null
        ? text(opts.centerSub, 18) : (fmtCompact(sum) + ' / ' + fmtCompact(total));
    } else {
      if (opts.centerLabel !== undefined && opts.centerLabel !== null) {
        big = text(opts.centerLabel, 12);
      } else {
        big = fmtCents(sum);
        if (big.length > 11) big = fmtCompact(sum);
      }
      sub = opts.centerSub !== undefined && opts.centerSub !== null
        ? text(opts.centerSub, 14) : '合计';
    }

    var bigSize = big.length > 7 ? FS_17 : FS_20;
    addText(doc, svg, big, {
      x: n2(cx),
      y: n2(cy - 2),
      'text-anchor': 'middle',
      dy: '0.32em'
    }, {
      fill: 'var(--c-text)',
      'font-size': bigSize,
      'font-weight': '700',
      'font-variant-numeric': 'tabular-nums'
    });

    if (sub) {
      addText(doc, svg, sub, {
        x: n2(cx),
        y: n2(cy + Math.max(16, thickness * 0.9)),
        'text-anchor': 'middle',
        dy: '0.32em'
      }, {
        fill: 'var(--c-text-2)',
        'font-size': FS_11,
        'font-variant-numeric': 'tabular-nums'
      });
    }

    var tableRows = [];
    for (var q = 0; q < items.length; q++) {
      tableRows.push([items[q].label, fmtCents(items[q].value), pctText(items[q].value, sum)]);
    }
    if (!tableRows.length) tableRows.push(['暂无进度', fmtCents(0), '0%']);

    el.appendChild(svg);
    var table = buildTable(doc, aria, ['分类', '金额', '占比'], tableRows);
    el.appendChild(table);
    return { svg: svg, table: table };
  }

  function donut(el, data, opts) {
    var doc = docOf(el);
    if (!el || !doc) {
      if (global.console && global.console.warn) global.console.warn('charts.donut 需要有效容器');
      return noopHandle();
    }
    opts = opts || {};
    return chartHandle(el, function () {
      return paintDonut(el, data, opts);
    });
  }

  /* ============================================================
     1.5 触控数值提示（S3）：按住图表显示最近数据点的数值。
     points: [{ x, y, label, value }]，坐标为 SVG 坐标（与容器 1:1）。
     事件只绑一次；重绘时再次调用只替换数据与浮层节点。
     ============================================================ */
  function attachTip(host, points, doc) {
    if (!host || !doc || !points || !points.length) { return; }
    var old = host.querySelector('.c-chart-tip');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }

    var tip = doc.createElement('div');
    tip.className = 'c-chart-tip';
    tip.setAttribute('aria-hidden', 'true');
    tip.style.display = 'none';
    host.appendChild(tip);
    host.__xzbChartPoints = points;

    if (host.__xzbChartTipped) { return; }
    host.__xzbChartTipped = true;
    try {
      if (getComputedStyle(host).position === 'static') { host.style.position = 'relative'; }
    } catch (eStatic) { /* noop */ }

    var hostBox = null;
    var shown = false;

    function nearest(localX) {
      var pts = host.__xzbChartPoints || [];
      if (!pts.length) { return null; }
      var best = pts[0];
      var bestD = Math.abs(pts[0].x - localX);
      for (var i = 1; i < pts.length; i += 1) {
        var d = Math.abs(pts[i].x - localX);
        if (d < bestD) { bestD = d; best = pts[i]; }
      }
      return best;
    }

    function show(clientX, clientY) {
      if (!hostBox) { hostBox = host.getBoundingClientRect(); }
      var point = nearest(clientX - hostBox.left);
      if (!point) { hide(); return; }
      while (tip.firstChild) { tip.removeChild(tip.firstChild); }
      tip.appendChild(doc.createTextNode(point.label + ' · ' + point.value));
      var localY = clientY - hostBox.top;
      tip.style.left = Math.round(Math.max(0, Math.min(hostBox.width, point.x))) + 'px';
      tip.style.top = Math.round(Math.max(0, localY - 44)) + 'px';
      tip.style.display = 'block';
      shown = true;
    }

    function hide() {
      tip.style.display = 'none';
      shown = false;
    }

    host.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      show(event.clientX, event.clientY);
    });
    host.addEventListener('pointermove', function (event) {
      if (shown) { show(event.clientX, event.clientY); }
    });
    host.addEventListener('pointerup', hide);
    host.addEventListener('pointercancel', hide);
    host.addEventListener('pointerleave', hide);
  }

  /* ============================================================
     2. 折线：趋势默认形态
     line(el, series, opts)
     series: [{ key, name, values:[分|null], color?, fill? }]
             或 { labels:[], series:[...] }
     opts: { labels, yMin, yMax, showDots, showGrid, formatY, emptyText }
     ============================================================ */
  function normalizeSeries(series, opts) {
    var labels = isArray(opts.labels) ? opts.labels.slice() : [];
    var list = series;
    if (list && !isArray(list) && isArray(list.series)) {
      if (!labels.length && isArray(list.labels)) labels = list.labels.slice();
      list = list.series;
    }
    if (list && !isArray(list) && isArray(list.values)) list = [list];
    if (!isArray(list)) list = [];

    var out = [];
    var maxLen = labels.length;
    for (var i = 0; i < list.length; i++) {
      var src = list[i] || {};
      var values = isArray(src.values) ? src.values : [];
      if (values.length > maxLen) maxLen = values.length;
      var normalized = [];
      for (var v = 0; v < values.length; v++) {
        var raw = values[v];
        normalized.push(raw === null || raw === undefined || raw === '' ? null : cents(raw));
      }
      out.push({
        name: text(src.name || src.key || ('系列 ' + (i + 1)), 8),
        key: text(src.key, 12),
        values: normalized,
        color: tokenColor(src.color, i === 0 ? '--c-tint' : PALETTE[(i * 2) % PALETTE.length]),
        fill: src.fill === true || (src.fill === undefined && list.length === 1)
      });
    }

    var cleanLabels = [];
    for (var l = 0; l < maxLen; l++) {
      cleanLabels.push(text(labels[l] !== undefined ? labels[l] : String(l + 1), 12));
    }
    for (var p = 0; p < out.length; p++) {
      while (out[p].values.length < maxLen) out[p].values.push(null);
    }
    return { labels: cleanLabels, series: out };
  }

  function paintLine(el, series, opts) {
    clearEl(el);
    opts = opts || {};
    var doc = docOf(el);
    var b = boxOf(el, opts, 180);
    var norm = normalizeSeries(series, opts);
    var labels = norm.labels;
    var list = norm.series;

    var all = [];
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < list[i].values.length; j++) {
        if (list[i].values[j] !== null) all.push(list[i].values[j]);
      }
    }

    if (!list.length || !all.length) {
      var emptyMsg = opts.emptyText || EMPTY_TEXT;
      return paintEmpty(el, opts, 180, emptyMsg, '趋势折线图，' + emptyMsg);
    }

    var maxVal = Math.max.apply(null, all);
    var minVal = Math.min.apply(null, all);

    if (maxVal === 0 && minVal === 0) {
      var zeroMsg = opts.zeroText || '金额均为 0';
      return paintEmpty(el, opts, 180, zeroMsg, '趋势折线图，' + zeroMsg);
    }

    var yMax = opts.yMax !== undefined ? finite(opts.yMax)
      : (maxVal > 0 ? maxVal * 1.15 : 0);
    var yMin = opts.yMin !== undefined ? finite(opts.yMin)
      : (minVal < 0 ? minVal * 1.1 : 0);
    if (!isFinite(yMax)) yMax = maxVal > 0 ? maxVal * 1.15 : 1;
    if (!isFinite(yMin)) yMin = minVal < 0 ? minVal * 1.1 : 0;
    if (!(yMax > yMin)) yMax = yMin + 1;

    var pad = padded(opts, { top: 22, right: 8, bottom: 18, left: 8 });
    var plotX = pad.left;
    var plotY = pad.top;
    var plotW = Math.max(10, b.w - pad.left - pad.right);
    var plotH = Math.max(10, b.h - pad.top - pad.bottom);
    var zeroY = clamp(plotY + ((yMax - 0) / (yMax - yMin)) * plotH, plotY, plotY + plotH);

    var aria = opts.ariaLabel ? text(opts.ariaLabel, 100) : '';
    if (!aria) {
      aria = '趋势折线图：' + labels.length + ' 个时间点';
      if (list.length === 1) {
        aria += '，' + list[0].name + '最高 ' + fmtCents(maxVal) + '，最低 ' + fmtCents(minVal);
      }
      var totalOf = 0;
      if (list.length === 1) {
        for (var s0 = 0; s0 < list[0].values.length; s0++) {
          if (list[0].values[s0] !== null) totalOf += list[0].values[s0];
        }
        aria += '，合计 ' + fmtCents(totalOf);
      }
    }

    var svg = rootSvg(doc, b.w, b.h, aria);

    var defs = mk(doc, 'defs');
    svg.appendChild(defs);

    function xAt(index) {
      if (labels.length <= 1) return plotX + plotW / 2;
      return plotX + (index / (labels.length - 1)) * plotW;
    }

    function yAt(value) {
      return plotY + ((yMax - value) / (yMax - yMin)) * plotH;
    }

    var pointsShown = labels.length <= 12;

    for (var k = 0; k < list.length; k++) {
      var seriesItem = list[k];
      var gradientId = 'xzb-lg-' + (++UID);
      if (seriesItem.fill) {
        var grad = mk(doc, 'linearGradient', {
          id: gradientId,
          x1: '0', y1: '0', x2: '0', y2: '1'
        });
        var stop1 = mk(doc, 'stop', { offset: '0' }, {
          'stop-color': seriesItem.color,
          'stop-opacity': '0.16'
        });
        var stop2 = mk(doc, 'stop', { offset: '1' }, {
          'stop-color': seriesItem.color,
          'stop-opacity': '0'
        });
        grad.appendChild(stop1);
        grad.appendChild(stop2);
        defs.appendChild(grad);
      }

      var lineD = '';
      var areaD = '';
      var run = [];
      var flush = function () {
        if (!run.length) return;
        var first = run[0];
        var last = run[run.length - 1];
        var d = 'M' + n2(first.x) + ' ' + n2(first.y);
        for (var q = 1; q < run.length; q++) {
          d += 'L' + n2(run[q].x) + ' ' + n2(run[q].y);
        }
        lineD += d;
        if (seriesItem.fill && run.length > 1) {
          areaD += 'M' + n2(first.x) + ' ' + n2(zeroY) +
            d.replace(/^M/, 'L') +
            'L' + n2(last.x) + ' ' + n2(zeroY) + 'Z';
        }
        run = [];
      };

      for (var v = 0; v < seriesItem.values.length; v++) {
        if (seriesItem.values[v] === null) {
          flush();
          continue;
        }
        run.push({ x: xAt(v), y: yAt(seriesItem.values[v]) });
      }
      flush();

      if (areaD) {
        var areaPath = mk(doc, 'path', { d: areaD, fill: 'url(#' + gradientId + ')' });
        svg.appendChild(areaPath);
      }
      if (lineD) {
        var linePath = mk(doc, 'path', { d: lineD, fill: 'none' }, {
          stroke: seriesItem.color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round'
        });
        svg.appendChild(linePath);
      }

      var lastIndex = -1;
      for (var li = seriesItem.values.length - 1; li >= 0; li--) {
        if (seriesItem.values[li] !== null) {
          lastIndex = li;
          break;
        }
      }
      for (var p = 0; p < seriesItem.values.length; p++) {
        if (seriesItem.values[p] === null) continue;
        var isLast = p === lastIndex;
        if (!pointsShown && !isLast) continue;
        var dot = mk(doc, 'circle', {
          cx: n2(xAt(p)),
          cy: n2(yAt(seriesItem.values[p])),
          r: isLast ? 3 : 2.2
        }, {
          fill: seriesItem.color
        });
        svg.appendChild(dot);
      }
    }

    /* M7：每个序列的最高 / 最低 / 当前点标记；全局最高点带数值 */
    var globalMax = -Infinity;
    for (var gm = 0; gm < list.length; gm++) {
      for (var gv = 0; gv < list[gm].values.length; gv++) {
        var gvv = list[gm].values[gv];
        if (gvv !== null && gvv > globalMax) { globalMax = gvv; }
      }
    }
    for (var mkS = 0; mkS < list.length; mkS++) {
      var sItem = list[mkS];
      var peak = -1;
      var peakV = -Infinity;
      var floorIdx = -1;
      var floorV = Infinity;
      var lastIdx = -1;
      for (var vi = 0; vi < sItem.values.length; vi++) {
        var vv = sItem.values[vi];
        if (vv === null) { continue; }
        if (vv > peakV) { peakV = vv; peak = vi; }
        if (vv < floorV) { floorV = vv; floorIdx = vi; }
        lastIdx = vi;
      }
      if (peak >= 0) {
        svg.appendChild(mk(doc, 'circle', {
          cx: n2(xAt(peak)), cy: n2(yAt(peakV)), r: 5.5
        }, { fill: 'none', stroke: sItem.color, 'stroke-width': 1.5 }));
        if (peakV === globalMax) {
          addText(doc, svg, byCaller(opts.formatY, peakV, fmtCompact(peakV)), {
            x: n2(Math.min(xAt(peak) + 8, plotX + plotW)),
            y: n2(Math.max(plotY + 10, yAt(peakV) - 8))
          }, {
            fill: sItem.color,
            'font-size': FS_11,
            'font-variant-numeric': 'tabular-nums'
          });
        }
      }
      if (floorIdx >= 0 && floorIdx !== peak) {
        svg.appendChild(mk(doc, 'circle', {
          cx: n2(xAt(floorIdx)), cy: n2(yAt(floorV)), r: 5.5
        }, { fill: 'none', stroke: sItem.color, 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }));
      }
      if (lastIdx >= 0 && sItem.values.length > 1) {
        svg.appendChild(mk(doc, 'circle', {
          cx: n2(xAt(lastIdx)), cy: n2(yAt(sItem.values[lastIdx])), r: 5.5
        }, { fill: 'var(--c-bg-elev)', stroke: sItem.color, 'stroke-width': 2 }));
      }
    }

    /* M7：点按折线附近取该时间点的数值（交给调用方展示） */
    if (typeof opts.onPick === 'function') {
      var pickRect = mk(doc, 'rect', {
        x: n2(plotX), y: n2(plotY), width: n2(plotW), height: n2(plotH), fill: 'transparent'
      }, { cursor: 'pointer' });
      svg.appendChild(pickRect);
      pickRect.addEventListener('click', function (ev) {
        var box = svg.getBoundingClientRect();
        if (!box.width) { return; }
        var vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
        var scaleX = vb && vb.width ? vb.width / box.width : 1;
        var px = (ev.clientX - box.left) * scaleX;
        var near = 0;
        var best = Infinity;
        for (var pi = 0; pi < labels.length; pi++) {
          var dist = Math.abs(xAt(pi) - px);
          if (dist < best) { best = dist; near = pi; }
        }
        opts.onPick(near);
      });
    }

    if (opts.showGrid === true) {
      for (var g = 1; g <= 3; g++) {
        var gy = plotY + (plotH / 4) * g;
        svg.appendChild(mk(doc, 'line', {
          x1: n2(plotX), y1: n2(gy), x2: n2(plotX + plotW), y2: n2(gy)
        }, {
          stroke: 'var(--c-chart-grid)',
          'stroke-width': 1
        }));
      }
    }

    addText(doc, svg, byCaller(opts.formatY, maxVal, fmtCompact(maxVal)), {
      x: n2(plotX + plotW),
      y: n2(Math.max(8, plotY - 5)),
      'text-anchor': 'end'
    }, {
      fill: 'var(--c-text-3)',
      'font-size': FS_11
    });

    if (list.length > 1) {
      var lx = plotX;
      for (var lg = 0; lg < list.length && lx < plotX + plotW * 0.6; lg++) {
        svg.appendChild(mk(doc, 'circle', {
          cx: n2(lx + 3), cy: n2(Math.max(8, plotY - 8)), r: 3
        }, { fill: list[lg].color }));
        addText(doc, svg, list[lg].name, {
          x: n2(lx + 10),
          y: n2(Math.max(8, plotY - 5))
        }, {
          fill: 'var(--c-text-3)',
          'font-size': FS_11
        });
        /* 每个字按 11px 估宽（-apple-system 11px 汉字约 11px 宽），
           再留 22px 的「圆点到文字 + 字后空隙」，否则两字标签会压到下一个圆点上 */
        lx += 22 + text(list[lg].name, 8).length * 11;
      }
    }

    var idx = [];
    if (labels.length === 1) {
      idx.push(0);
    } else {
      idx.push(0);
      idx.push(Math.floor((labels.length - 1) / 2));
      idx.push(labels.length - 1);
    }
    var seen = {};
    for (var x = 0; x < idx.length; x++) {
      if (seen[idx[x]]) continue;
      seen[idx[x]] = true;
      var anchor = labels.length === 1 ? 'middle' : (x === 0 ? 'start' : (x === idx.length - 1 ? 'end' : 'middle'));
      addText(doc, svg, text(labels[idx[x]], 8), {
        x: n2(xAt(idx[x])),
        y: n2(b.h - 2),
        'text-anchor': anchor
      }, {
        fill: 'var(--c-text-3)',
        'font-size': FS_11
      });
    }

    el.appendChild(svg);

    /* S3 触控数值：按住图表，显示离手指最近时间点的各系列数值 */
    var tipPoints = [];
    for (var tp = 0; tp < labels.length; tp += 1) {
      var parts = [];
      var firstY = 0;
      var anyY = false;
      for (var ts = 0; ts < list.length; ts += 1) {
        var tv = list[ts].values[tp];
        if (tv === null || tv === undefined) { continue; }
        if (!anyY) { firstY = yAt(tv); anyY = true; }
        parts.push(list[ts].name + ' ' + fmtCents(tv));
      }
      if (!anyY) { continue; }
      tipPoints.push({
        x: xAt(tp),
        y: firstY,
        label: labels[tp],
        value: parts.join(' · ')
      });
    }
    attachTip(el, tipPoints, doc);

    var headers = ['时间'];
    if (list.length === 1) {
      headers.push('金额');
      var singleRows = [];
      for (var sr = 0; sr < labels.length; sr++) {
        singleRows.push([labels[sr], list[0].values[sr] === null ? '—' : fmtCents(list[0].values[sr])]);
      }
      var singleTable = buildTable(doc, aria, headers, singleRows);
      el.appendChild(singleTable);
      return { svg: svg, table: singleTable };
    }

    for (var hn = 0; hn < list.length; hn++) headers.push(list[hn].name);
    var multiRows = [];
    for (var mr = 0; mr < labels.length; mr++) {
      var cells = [labels[mr]];
      for (var mc = 0; mc < list.length; mc++) {
        cells.push(list[mc].values[mr] === null ? '—' : fmtCents(list[mc].values[mr]));
      }
      multiRows.push(cells);
    }
    var multiTable = buildTable(doc, aria, headers, multiRows);
    el.appendChild(multiTable);
    return { svg: svg, table: multiTable };
  }

  function line(el, series, opts) {
    var doc = docOf(el);
    if (!el || !doc) {
      if (global.console && global.console.warn) global.console.warn('charts.line 需要有效容器');
      return noopHandle();
    }
    opts = opts || {};
    return chartHandle(el, function () {
      return paintLine(el, series, opts);
    });
  }

  /* ============================================================
     3. 柱状：横向排行（默认）/ 纵向趋势
     bars(el, data, opts)
     data: [{ label, value(分), color? }] 或 { items:[...] }
     opts: { horizontal=true, max, showValue, formatValue }
     ============================================================ */
  function shortLabel(label) {
    var s = text(label, 10);
    if (/^\d{4}-\d{2}$/.test(s)) return Number(s.slice(5, 7)) + '月';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
    return text(s, 5);
  }

  function paintBars(el, data, opts) {
    clearEl(el);
    opts = opts || {};
    var doc = docOf(el);
    var b = boxOf(el, opts, 180);

    var rows = isArray(data) ? data : (data && isArray(data.items) ? data.items : []);
    var items = [];
    var negs = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var raw = row.value !== undefined ? row.value : row.amountCents;
      var v = cents(raw);
      if (v < 0) {
        negs++;
        continue;
      }
      items.push({
        label: text(row.label !== undefined ? row.label : row.name, 14) || '未命名',
        value: v,
        color: tokenColor(row.color, PALETTE[items.length % PALETTE.length])
      });
    }

    if (!items.length) {
      var emptyMsg = opts.emptyText || EMPTY_TEXT;
      return paintEmpty(el, opts, 180, emptyMsg, '柱状图，' + emptyMsg);
    }

    var maxValue = 0;
    var highest = items[0];
    var sum = 0;
    for (var m = 0; m < items.length; m++) {
      sum += items[m].value;
      if (items[m].value > maxValue) {
        maxValue = items[m].value;
        highest = items[m];
      }
    }

    if (maxValue <= 0) {
      var zeroMsg = opts.zeroText || '金额均为 0';
      return paintEmpty(el, opts, 180, zeroMsg, '柱状图，' + zeroMsg);
    }

    var aria = opts.ariaLabel ? text(opts.ariaLabel, 100) : '';
    if (!aria) {
      aria = '柱状图：共 ' + items.length + ' 项，合计 ' + fmtCents(sum) +
        '，最高为' + highest.label + ' ' + fmtCents(highest.value);
      if (negs > 0) aria += '；已忽略 ' + negs + ' 项负数金额';
    }

    var max = opts.max !== undefined && finite(opts.max) > 0
      ? finite(opts.max) : maxValue * 1.1;

    var svg = rootSvg(doc, b.w, b.h, aria);
    var horizontal = opts.horizontal !== false;
    var showValue = opts.showValue !== false;

    var tableRows = [];
    for (var tr = 0; tr < items.length; tr++) {
      tableRows.push([items[tr].label, fmtCents(items[tr].value), pctText(items[tr].value, sum)]);
    }
    var table = buildTable(doc, aria, ['项目', '金额', '占比'], tableRows);

    if (horizontal) {
      var pad = padded(opts, { top: 8, right: 8, bottom: 8, left: 8 });
      var maxLabelLen = 2;
      for (var ml = 0; ml < items.length; ml++) {
        maxLabelLen = Math.max(maxLabelLen, text(items[ml].label, 6).length);
      }
      var labelW = clamp(maxLabelLen * 11, 48, b.w * 0.34);
      var valueW = 62;
      var plotX = pad.left + labelW;
      var plotW = Math.max(20, b.w - plotX - pad.right - valueW);
      var rowH = (b.h - pad.top - pad.bottom) / items.length;
      var barH = clamp(rowH * 0.34, 8, 16);
      var radius = Math.min(3, barH / 2);

      for (var hI = 0; hI < items.length; hI++) {
        var cy = pad.top + rowH * hI + rowH / 2;
        var y = cy - barH / 2;
        svg.appendChild(mk(doc, 'rect', {
          x: n2(plotX), y: n2(y), width: n2(plotW), height: n2(barH), rx: n2(radius)
        }, {
          fill: 'var(--c-fill)'
        }));

        var ratio = items[hI].value / max;
        var over = ratio > 1;
        var barW = clamp(ratio, 0, 1) * plotW;
        if (barW > 0) {
          svg.appendChild(mk(doc, 'rect', {
            x: n2(plotX), y: n2(y), width: n2(barW), height: n2(barH), rx: n2(radius)
          }, {
            fill: over ? 'var(--c-danger)' : items[hI].color
          }));
        }

        addText(doc, svg, text(items[hI].label, 6), {
          x: n2(plotX - 8),
          y: n2(cy),
          'text-anchor': 'end',
          dy: '0.35em'
        }, {
          fill: 'var(--c-text)',
          'font-size': FS_13
        });

        if (showValue) {
          var valueText = byCaller(opts.formatValue, items[hI].value, fmtCompact(items[hI].value));
          addText(doc, svg, valueText, {
            x: n2(b.w - pad.right),
            y: n2(cy),
            'text-anchor': 'end',
            dy: '0.35em'
          }, {
            fill: 'var(--c-text-2)',
            'font-size': FS_11,
            'font-variant-numeric': 'tabular-nums'
          });
        }
      }
    } else {
      var vp = padded(opts, { top: 22, right: 8, bottom: 20, left: 8 });
      var vPlotW = Math.max(10, b.w - vp.left - vp.right);
      var vPlotH = Math.max(10, b.h - vp.top - vp.bottom);
      var bandW = vPlotW / items.length;
      var vBarW = Math.min(bandW * 0.62, 28);
      var vRadius = Math.min(3, vBarW / 2);

      for (var vI = 0; vI < items.length; vI++) {
        var bandX = vp.left + bandW * vI;
        var barX = bandX + (bandW - vBarW) / 2;
        var frac = clamp(items[vI].value / max, 0, 1);
        var barH2 = Math.max(2, frac * vPlotH);
        var barY = vp.top + vPlotH - barH2;

        svg.appendChild(mk(doc, 'rect', {
          x: n2(barX), y: n2(barY), width: n2(vBarW), height: n2(barH2), rx: n2(vRadius)
        }, {
          fill: frac >= 1 ? 'var(--c-danger)' : items[vI].color
        }));

        if (showValue && items.length <= 8) {
          addText(doc, svg, byCaller(opts.formatValue, items[vI].value, fmtCompact(items[vI].value)), {
            x: n2(barX + vBarW / 2),
            y: n2(Math.max(10, barY - 5)),
            'text-anchor': 'middle'
          }, {
            fill: 'var(--c-text-2)',
            'font-size': FS_11,
            'font-variant-numeric': 'tabular-nums'
          });
        }

        var showLabel = items.length <= 6 || vI === 0 || vI === items.length - 1 ||
          vI === Math.floor((items.length - 1) / 2);
        if (showLabel) {
          addText(doc, svg, shortLabel(items[vI].label), {
            x: n2(barX + vBarW / 2),
            y: n2(b.h - 4),
            'text-anchor': 'middle'
          }, {
            fill: 'var(--c-text-3)',
            'font-size': FS_11
          });
        }
      }

      svg.appendChild(mk(doc, 'line', {
        x1: n2(vp.left), y1: n2(vp.top + vPlotH), x2: n2(vp.left + vPlotW), y2: n2(vp.top + vPlotH)
      }, {
        stroke: 'var(--c-separator)',
        'stroke-width': 1
      }));

      addText(doc, svg, byCaller(opts.formatValue, maxValue, fmtCompact(maxValue)), {
        x: n2(vp.left),
        y: n2(Math.max(10, vp.top - 6))
      }, {
        fill: 'var(--c-text-3)',
        'font-size': FS_11
      });
    }

    el.appendChild(svg);
    el.appendChild(table);
    return { svg: svg, table: table };
  }

  function bars(el, data, opts) {
    var doc = docOf(el);
    if (!el || !doc) {
      if (global.console && global.console.warn) global.console.warn('charts.bars 需要有效容器');
      return noopHandle();
    }
    opts = opts || {};
    return chartHandle(el, function () {
      return paintBars(el, data, opts);
    });
  }

  /* ============================================================
     4. 日历热力图
     heatmap(el, data, opts)
     data: { month:'YYYY-MM', days:[{date, expenseCents, count?}] }
           或 [{date, value}] 或 { month, values:{date:分} }
     opts: { cell=40, gap=6, max, today }
     ============================================================ */
  function daysInMonth(year, month) {
    var list = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return list[month - 1] || 30;
  }

  /* 0=周一 … 6=周日，纯算术，不解析日期字符串 */
  function weekdayMon(year, month, day) {
    var t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    var y = year;
    var m = month;
    if (m < 3) y -= 1;
    var dow = (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + day) % 7;
    if (dow < 0) dow += 7;
    return (dow + 6) % 7;
  }

  function currentMonth() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function paintHeatmap(el, data, opts) {
    clearEl(el);
    opts = opts || {};
    var doc = docOf(el);
    var b = boxOf(el, opts, 300);

    var month = '';
    var rows = [];
    if (isArray(data)) {
      rows = data;
    } else if (data && typeof data === 'object') {
      month = text(data.month, 7);
      if (isArray(data.days)) {
        rows = data.days;
      } else if (data.values && typeof data.values === 'object') {
        for (var key in data.values) {
          if (has(data.values, key)) rows.push({ date: key, expenseCents: data.values[key] });
        }
      }
    }

    var map = {};
    var total = 0;
    var max = 0;
    var daysWith = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var date = text(row.date, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      var v = cents(row.expenseCents !== undefined ? row.expenseCents : row.value);
      if (v < 0) v = 0;
      var count = Math.max(0, cents(row.count));
      map[date] = { value: v, count: count };
      if (!month) month = date.slice(0, 7);
      total += v;
      if (v > 0) daysWith++;
      if (v > max) max = v;
    }

    var year;
    var mon;
    var mm = /^(\d{4})-(\d{2})$/.exec(month);
    if (mm) {
      year = Number(mm[1]);
      mon = Number(mm[2]);
    }
    if (!(year > 1900 && mon >= 1 && mon <= 12)) {
      month = currentMonth();
      mm = /^(\d{4})-(\d{2})$/.exec(month);
      year = Number(mm[1]);
      mon = Number(mm[2]);
    }

    var dim = daysInMonth(year, mon);
    var offset = weekdayMon(year, mon, 1);
    var cell = opts.cell !== undefined ? clamp(finite(opts.cell), 18, 64) : 40;
    var gap = opts.gap !== undefined ? clamp(finite(opts.gap), 0, 20) : 6;
    var gridW = cell * 7 + gap * 6;
    var gridH = cell * 6 + gap * 5;
    var headerH = Math.round(cell * 0.42);
    var gridBottom = headerH + gridH;
    var emptyHint = total === 0 ? 20 : 0;
    var legendH = 26;
    var h = gridBottom + emptyHint + legendH;
    var w = Math.max(b.w, gridW + 8);

    var maxValue = opts.max !== undefined && finite(opts.max) > 0 ? finite(opts.max) : max;
    var today = opts.today ? text(opts.today, 10) : todayStr();

    var aria = opts.ariaLabel ? text(opts.ariaLabel, 100) : '';
    if (!aria) {
      aria = year + '年' + mon + '月日历热图：全月支出 ' + fmtCents(total);
      if (total > 0) {
        aria += '，共 ' + daysWith + ' 天有支出，单日最高 ' + fmtCents(max);
      } else {
        aria += '，本月还没有支出记录';
      }
    }

    var svg = rootSvg(doc, w, h, aria);
    var x0 = (w - gridW) / 2;

    var weekNames = ['一', '二', '三', '四', '五', '六', '日'];
    for (var c = 0; c < 7; c++) {
      addText(doc, svg, weekNames[c], {
        x: n2(x0 + c * (cell + gap) + cell / 2),
        y: n2(headerH - 6),
        'text-anchor': 'middle'
      }, {
        fill: 'var(--c-text-3)',
        'font-size': FS_11
      });
    }

    function levelOf(value) {
      if (!(value > 0) || !(maxValue > 0)) return 0;
      var ratio = value / maxValue;
      if (ratio <= 0.25) return 1;
      if (ratio <= 0.5) return 2;
      if (ratio <= 0.75) return 3;
      return 4;
    }

    for (var d = 1; d <= dim; d++) {
      var idx = offset + d - 1;
      var col = idx % 7;
      var rowIdx = Math.floor(idx / 7);
      var x = x0 + col * (cell + gap);
      var y = headerH + rowIdx * (cell + gap);
      var dateStr = year + '-' + pad2(mon) + '-' + pad2(d);
      var info = map[dateStr] || { value: 0, count: 0 };
      var future = dateStr > today;
      var isToday = dateStr === today;
      var level = levelOf(info.value);

      var cellStyle;
      if (future) {
        cellStyle = {
          fill: 'none',
          stroke: 'var(--c-fill)',
          'stroke-width': 1
        };
      } else {
        cellStyle = {
          fill: 'var(--heat-' + level + ')'
        };
        if (isToday) {
          cellStyle.stroke = 'var(--c-tint)';
          cellStyle['stroke-width'] = 2;
        }
      }

      svg.appendChild(mk(doc, 'rect', {
        x: n2(x), y: n2(y), width: n2(cell), height: n2(cell), rx: 8
      }, cellStyle));

      addText(doc, svg, String(d), {
        x: n2(x + cell * 0.17),
        y: n2(y + cell * 0.36)
      }, {
        fill: future ? 'var(--c-text-4)' : 'var(--heat-fg-' + level + ')',
        'font-size': FS_11,
        'font-variant-numeric': 'tabular-nums'
      });
    }

    if (total === 0) {
      addText(doc, svg, opts.emptyText || '本月还没有数据', {
        x: n2(w / 2),
        y: n2(gridBottom + 14),
        'text-anchor': 'middle'
      }, {
        fill: 'var(--c-text-3)',
        'font-size': FS_11
      });
    }

    var legendY = gridBottom + emptyHint + 12;
    var lx = x0;
    addText(doc, svg, '少', {
      x: n2(lx),
      y: n2(legendY + 10)
    }, {
      fill: 'var(--c-text-3)',
      'font-size': FS_11
    });
    lx += 20;
    for (var lv = 0; lv < 5; lv++) {
      svg.appendChild(mk(doc, 'rect', {
        x: n2(lx + lv * 16), y: n2(legendY), width: 12, height: 12, rx: 3
      }, {
        fill: 'var(--heat-' + lv + ')'
      }));
    }
    addText(doc, svg, '多', {
      x: n2(lx + 5 * 16 + 2),
      y: n2(legendY + 10)
    }, {
      fill: 'var(--c-text-3)',
      'font-size': FS_11
    });

    var tableRows = [];
    for (var dt = 1; dt <= dim; dt++) {
      var dstr = year + '-' + pad2(mon) + '-' + pad2(dt);
      var dinfo = map[dstr] || { value: 0, count: 0 };
      tableRows.push([mon + '月' + dt + '日', fmtCents(dinfo.value), String(dinfo.count)]);
    }

    el.appendChild(svg);
    var table = buildTable(doc, aria, ['日期', '支出', '笔数'], tableRows);
    el.appendChild(table);
    return { svg: svg, table: table };
  }

  function heatmap(el, data, opts) {
    var doc = docOf(el);
    if (!el || !doc) {
      if (global.console && global.console.warn) global.console.warn('charts.heatmap 需要有效容器');
      return noopHandle();
    }
    opts = opts || {};
    return chartHandle(el, function () {
      return paintHeatmap(el, data, opts);
    });
  }

  /* ============================================================
     5. 迷你折线
     sparkline(el, values, opts)
     values: [分|null] 或 { values:[], labels?:[] }
     ============================================================ */
  function paintSparkline(el, values, opts) {
    clearEl(el);
    opts = opts || {};
    var doc = docOf(el);
    var b = boxOf(el, opts, 36);

    var raw = isArray(values) ? values : (values && isArray(values.values) ? values.values : []);
    var labels = values && !isArray(values) && isArray(values.labels) ? values.labels : [];
    var vals = [];
    var nums = [];
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i] === null || raw[i] === undefined || raw[i] === '' ? null : cents(raw[i]);
      vals.push(v);
      if (v !== null) nums.push(v);
    }

    if (!nums.length) {
      var emptyMsg = opts.emptyText || EMPTY_TEXT;
      return paintEmpty(el, opts, 36, emptyMsg, '迷你趋势图，' + emptyMsg);
    }

    if (nums.length === 1 && !opts.allowSingle) {
      /* 单点仍然画一个点，不抛错；摘要明确说明只有一个数据点 */
    }

    var allZero = true;
    for (var z = 0; z < nums.length; z++) {
      if (nums[z] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      return paintEmpty(el, opts, 36, opts.zeroText || '金额均为 0', '迷你趋势图，金额均为 0');
    }

    var max = Math.max.apply(null, nums);
    var min = Math.min.apply(null, nums);
    var flat = max === min;

    var aria = opts.ariaLabel ? text(opts.ariaLabel, 100) : '';
    if (!aria) {
      var sum = 0;
      for (var sm = 0; sm < nums.length; sm++) sum += nums[sm];
      aria = '迷你趋势折线：' + nums.length + ' 个数据点，合计 ' + fmtCents(sum) +
        '，最高 ' + fmtCents(max) + '，最低 ' + fmtCents(min);
    }

    var svg = rootSvg(doc, b.w, b.h, aria);
    var pad = 3;
    var plotW = Math.max(2, b.w - pad * 2);
    var plotH = Math.max(2, b.h - pad * 2);

    function xAt(index) {
      if (vals.length <= 1) return b.w / 2;
      return pad + (index / (vals.length - 1)) * plotW;
    }

    function yAt(value) {
      if (flat) return b.h / 2;
      return pad + ((max - value) / (max - min)) * plotH;
    }

    var lineD = '';
    var run = [];
    var flush = function () {
      if (!run.length) return;
      var d = 'M' + n2(run[0].x) + ' ' + n2(run[0].y);
      for (var q = 1; q < run.length; q++) {
        d += 'L' + n2(run[q].x) + ' ' + n2(run[q].y);
      }
      lineD += d;
      run = [];
    };

    for (var p = 0; p < vals.length; p++) {
      if (vals[p] === null) {
        flush();
        continue;
      }
      run.push({ x: xAt(p), y: yAt(vals[p]) });
    }
    flush();

    if (lineD) {
      svg.appendChild(mk(doc, 'path', { d: lineD, fill: 'none' }, {
        stroke: tokenColor(opts.color, '--c-tint'),
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
      }));
    }

    var lastIndex = -1;
    for (var li = vals.length - 1; li >= 0; li--) {
      if (vals[li] !== null) {
        lastIndex = li;
        break;
      }
    }
    if (lastIndex >= 0) {
      svg.appendChild(mk(doc, 'circle', {
        cx: n2(xAt(lastIndex)),
        cy: n2(yAt(vals[lastIndex])),
        r: 2.4
      }, {
        fill: tokenColor(opts.color, '--c-tint')
      }));
    }

    el.appendChild(svg);

    var headers = labels.length ? ['时间', '金额'] : ['序号', '金额'];
    var tableRows = [];
    for (var r = 0; r < vals.length; r++) {
      tableRows.push([labels.length ? text(labels[r], 12) : String(r + 1),
        vals[r] === null ? '—' : fmtCents(vals[r])]);
    }
    var table = buildTable(doc, aria, headers, tableRows);
    el.appendChild(table);
    return { svg: svg, table: table };
  }

  function sparkline(el, values, opts) {
    var doc = docOf(el);
    if (!el || !doc) {
      if (global.console && global.console.warn) global.console.warn('charts.sparkline 需要有效容器');
      return noopHandle();
    }
    opts = opts || {};
    return chartHandle(el, function () {
      return paintSparkline(el, values, opts);
    });
  }

  /* ============================================================
     6. 堆叠条：账户构成
     stackbar(el, segments, opts)
     segments: [{ label, value(分), color? }]
     ============================================================ */
  function paintStackbar(el, segments, opts) {
    clearEl(el);
    opts = opts || {};
    var doc = docOf(el);
    var b = boxOf(el, opts, 80);

    var rows = isArray(segments) ? segments
      : (segments && isArray(segments.segments) ? segments.segments : []);
    var items = [];
    var sum = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var v = Math.abs(cents(row.value !== undefined ? row.value : row.amountCents));
      if (v === 0) continue;
      items.push({
        label: text(row.label !== undefined ? row.label : row.name, 14) || '未命名',
        value: v,
        color: tokenColor(row.color, PALETTE[i % PALETTE.length])
      });
      sum += v;
    }

    if (!items.length) {
      var emptyMsg = opts.emptyText || EMPTY_TEXT;
      return paintEmpty(el, opts, 80, emptyMsg, '构成堆叠条，' + emptyMsg);
    }

    var total = opts.total !== undefined && opts.total !== null
      ? Math.max(sum, Math.abs(cents(opts.total))) : sum;
    var aria = opts.ariaLabel ? text(opts.ariaLabel, 100) : '';
    if (!aria) {
      aria = '构成堆叠条：共 ' + items.length + ' 项，合计 ' + fmtCents(sum) + '，' +
        items[0].label + '占 ' + pctText(items[0].value, sum);
    }

    var barH = opts.barHeight !== undefined ? clamp(finite(opts.barHeight), 4, 24) : 8;
    var legend = opts.showLegend !== false;
    var rowH = 22;
    var h = barH + 10 + (legend ? items.length * rowH : 0);
    var w = b.w;
    var svg = rootSvg(doc, w, h, aria);
    var x0 = 2;
    var barW = Math.max(10, w - 4);
    var radius = Math.min(barH / 2, barW / 2);

    svg.appendChild(mk(doc, 'rect', {
      x: n2(x0), y: 4, width: n2(barW), height: n2(barH), rx: n2(radius)
    }, {
      fill: 'var(--c-fill)'
    }));

    var gap = items.length > 1 ? 2 : 0;
    var offset = 0;
    for (var s = 0; s < items.length; s++) {
      var segW = (items[s].value / total) * barW;
      if (segW > gap && s < items.length - 1) segW -= gap;
      if (segW < 1) segW = 1;
      var maxX = x0 + barW;
      var drawW = Math.min(segW, maxX - (x0 + offset));
      if (drawW > 0) {
        svg.appendChild(mk(doc, 'rect', {
          x: n2(x0 + offset), y: 4, width: n2(drawW), height: n2(barH),
          rx: s === 0 || s === items.length - 1 ? n2(radius) : 2
        }, {
          fill: items[s].color
        }));
      }
      offset += segW + gap;
    }

    if (legend) {
      for (var l = 0; l < items.length; l++) {
        var ly = barH + 10 + l * rowH + rowH / 2;
        svg.appendChild(mk(doc, 'circle', {
          cx: 7, cy: n2(ly), r: 4
        }, {
          fill: items[l].color
        }));
        addText(doc, svg, text(items[l].label, 8), {
          x: 18,
          y: n2(ly),
          dy: '0.35em'
        }, {
          fill: 'var(--c-text)',
          'font-size': FS_13
        });
        addText(doc, svg, pctText(items[l].value, sum), {
          x: n2(w - 82),
          y: n2(ly),
          'text-anchor': 'end',
          dy: '0.35em'
        }, {
          fill: 'var(--c-text-2)',
          'font-size': FS_11,
          'font-variant-numeric': 'tabular-nums'
        });
        addText(doc, svg, fmtCompact(items[l].value), {
          x: n2(w - 2),
          y: n2(ly),
          'text-anchor': 'end',
          dy: '0.35em'
        }, {
          fill: 'var(--c-text-2)',
          'font-size': FS_11,
          'font-variant-numeric': 'tabular-nums'
        });
      }
    }

    var tableRows = [];
    for (var r = 0; r < items.length; r++) {
      tableRows.push([items[r].label, fmtCents(items[r].value), pctText(items[r].value, sum)]);
    }

    el.appendChild(svg);
    var table = buildTable(doc, aria, ['项目', '金额', '占比'], tableRows);
    el.appendChild(table);
    return { svg: svg, table: table };
  }

  function stackbar(el, segments, opts) {
    var doc = docOf(el);
    if (!el || !doc) {
      if (global.console && global.console.warn) global.console.warn('charts.stackbar 需要有效容器');
      return noopHandle();
    }
    opts = opts || {};
    return chartHandle(el, function () {
      return paintStackbar(el, segments, opts);
    });
  }

  /* ============================================================
     7. CONTRACT §5.6 兼容层（旧签名 drawXxx(canvas, opts)）
        新代码请直接用上面的 donut/line/bars/heatmap/sparkline。
     ============================================================ */
  function compatHost(el) {
    if (!el) return null;
    var tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (tag !== 'canvas') return { host: el, wrapper: null, canvas: null };
    var doc = docOf(el);
    if (!doc || !el.parentNode) return null;
    var wrap = doc.createElement('div');
    wrap.setAttribute('data-chart-host', 'canvas');
    el.parentNode.insertBefore(wrap, el);
    try {
      el.setAttribute('style', 'display:none');
    } catch (e) { /* 忽略 */ }
    return { host: wrap, wrapper: wrap, canvas: el };
  }

  function wrapCompat(entry, handle) {
    return {
      redraw: function () {
        if (handle) handle.redraw();
      },
      destroy: function () {
        if (handle) handle.destroy();
        if (entry && entry.wrapper && entry.wrapper.parentNode) {
          entry.wrapper.parentNode.removeChild(entry.wrapper);
        }
        if (entry && entry.canvas) {
          try { entry.canvas.removeAttribute('style'); } catch (e) { /* 忽略 */ }
        }
      }
    };
  }

  function drawRing(el, opts) {
    opts = opts || {};
    var entry = compatHost(el);
    if (!entry) return { redraw: function () {}, destroy: function () {} };
    var max = Math.abs(cents(opts.max)) || 1;
    var handle = donut(entry.host, [{
      label: opts.label || '进度',
      value: Math.abs(cents(opts.value)),
      color: tokenColor(opts.color, '--c-tint')
    }], {
      total: max,
      height: opts.height || 120,
      width: opts.width,
      thickness: opts.thickness,
      centerLabel: opts.label,
      centerSub: opts.sublabel,
      emptyText: '暂无进度'
    });
    return wrapCompat(entry, handle);
  }

  function drawLine(el, opts) {
    opts = opts || {};
    var entry = compatHost(el);
    if (!entry) return { redraw: function () {}, destroy: function () {} };
    var handle = line(entry.host, opts.series, {
      labels: opts.labels,
      yMin: opts.yMin,
      yMax: opts.yMax,
      showDots: opts.showDots,
      showGrid: opts.showGrid,
      formatY: opts.formatY,
      padding: opts.padding,
      width: opts.width,
      height: opts.height,
      emptyText: opts.emptyText,
      ariaLabel: opts.ariaLabel
    });
    return wrapCompat(entry, handle);
  }

  function drawBars(el, opts) {
    opts = opts || {};
    var entry = compatHost(el);
    if (!entry) return { redraw: function () {}, destroy: function () {} };
    var handle = bars(entry.host, opts.items, {
      horizontal: opts.horizontal,
      max: opts.max,
      showValue: opts.showValue,
      formatValue: opts.formatValue,
      width: opts.width,
      height: opts.height,
      emptyText: opts.emptyText,
      ariaLabel: opts.ariaLabel
    });
    return wrapCompat(entry, handle);
  }

  function drawHeatmap(el, opts) {
    opts = opts || {};
    var entry = compatHost(el);
    if (!entry) return { redraw: function () {}, destroy: function () {} };
    var start = text(opts.start, 10);
    var month = /^\d{4}-\d{2}/.test(start) ? start.slice(0, 7) : '';
    var values = opts.values || {};
    var days = [];
    for (var key in values) {
      if (has(values, key) && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
        days.push({ date: key, expenseCents: values[key] });
      }
    }
    var handle = heatmap(entry.host, { month: month, days: days }, {
      cell: opts.cell,
      gap: opts.gap,
      max: opts.max,
      width: opts.width,
      ariaLabel: opts.ariaLabel
    });
    return wrapCompat(entry, handle);
  }

  function drawStackBar(el, opts) {
    opts = opts || {};
    var entry = compatHost(el);
    if (!entry) return { redraw: function () {}, destroy: function () {} };
    var handle = stackbar(entry.host, opts.segments, {
      total: opts.total,
      barHeight: opts.height,
      showLegend: opts.showLegend,
      formatValue: opts.formatValue,
      width: opts.width,
      emptyText: opts.emptyText,
      ariaLabel: opts.ariaLabel
    });
    return wrapCompat(entry, handle);
  }

  /* ---------- 注册 ---------- */

  var API = Object.freeze({
    version: '2.2.0',
    donut: donut,
    line: line,
    bars: bars,
    heatmap: heatmap,
    sparkline: sparkline,
    stackbar: stackbar,
    drawRing: drawRing,
    drawLine: drawLine,
    drawBars: drawBars,
    drawHeatmap: drawHeatmap,
    drawStackBar: drawStackBar
  });

  UI.charts = API;

  /* 派工要求挂到小写 XZB.ui.charts；大小写同时提供，屏幕两个名字都能用 */
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.charts) lower.charts = API;

})(window);
