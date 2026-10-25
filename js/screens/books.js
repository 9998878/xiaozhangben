/* ============================================================
   小账本 2.0 — 屏幕：账本（books）
   owner: 前端#1（T12）
   依赖：XZB.core.{money,dates,schema,stats} / XZB.dom / XZB.ui.{icons,toast,sheet}
   只读接口：XZB.app.db()；写入一律走 XZB.app.commit(mutator,{label})
   ============================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB;
  if (!XZB || !XZB.screens) { return; }

  var KEY = 'books';
  var MAX_BOOK_NAME = 20;

  var dom = (XZB.ui && XZB.ui.dom) || XZB.dom;

  /* 账本类型（schema.BOOK_KINDS 的中文呈现） */
  var KIND_ORDER = ['daily', 'travel', 'business'];

  var KIND_LABEL = {
    daily: '日常',
    travel: '旅行',
    business: '生意'
  };

  var KIND_ICON = {
    daily: 'book',
    travel: 'house',
    business: 'briefcase'
  };

  /* 类型 -> tokens.css 的 --acc-* 调色板键（JS 里不出现色值字面量） */
  var KIND_TONE = {
    daily: 'bank',
    travel: 'cash',
    business: 'savings'
  };

  var TONE_VARS = [
    { key: 'cash', varName: '--acc-cash' },
    { key: 'bank', varName: '--acc-bank' },
    { key: 'wechat', varName: '--acc-wechat' },
    { key: 'alipay', varName: '--acc-alipay' },
    { key: 'credit', varName: '--acc-credit' },
    { key: 'savings', varName: '--acc-savings' }
  ];

  var BOOK_MSG = {
    E_BOOK_LAST: '至少要保留一个未归档账本',
    E_BOOK_MISSING: '账本不存在',
    E_BOOK_ARCHIVED: '账本已归档，不能记账',
    E_DUPLICATE_NAME: '已经有同名账本',
    E_INVALID_INPUT: '名称或参数不合适'
  };

  /* ---------------- 模块访问 ---------------- */

  function coreMod(name) {
    return (XZB.core && XZB.core[name]) || null;
  }

  function moneyApi() { return coreMod('money'); }
  function datesApi() { return coreMod('dates'); }
  function statsApi() { return coreMod('stats'); }
  function schemaApi() { return coreMod('schema'); }
  function iconsApi() { return (XZB.ui && XZB.ui.icons) || null; }
  function sheetApi() { return (XZB.ui && XZB.ui.sheet) || null; }

  /* ---------------- DOM 小工具 ---------------- */

  function h(tag, attrs, children) {
    return dom.el(tag, attrs, children);
  }

  function t(tag, className, value) {
    return dom.el(tag, { className: className, text: value === undefined || value === null ? '' : String(value) });
  }

  function kids(list) {
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i]) { out.push(list[i]); }
    }
    return out;
  }

  /* icons.node() 走 DOMParser 的 image/svg+xml 分支时，图标字符串没有 xmlns，
     拿到的节点不属于 SVG 命名空间，浏览器按 HTML 未知元素处理（0×0 不渲染）。
     这里在 SVG 命名空间里重建一份，既不拼 HTML 字符串，也不依赖图标实现。 */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function rebuildSvg(src) {
    var el = document.createElementNS(SVG_NS, src.tagName);
    var attrs = src.attributes || [];
    for (var a = 0; a < attrs.length; a += 1) {
      el.setAttribute(attrs[a].name, attrs[a].value);
    }
    for (var c = 0; c < src.childNodes.length; c += 1) {
      var child = src.childNodes[c];
      if (child.nodeType === 1) { el.appendChild(rebuildSvg(child)); }
    }
    return el;
  }

  function iconEl(name, size, className) {
    var api = iconsApi();
    var node = api && typeof api.node === 'function' ? api.node(name, { size: size || 20 }) : null;
    var wrap = h('span', { className: className || 's-books-glyph' });
    if (node) {
      wrap.appendChild(node.namespaceURI === SVG_NS ? node : rebuildSvg(node));
    }
    return wrap;
  }

  function toast(ctx, message, options) {
    var opts = options || {};
    if (ctx && typeof ctx.toast === 'function') {
      ctx.toast(message, opts);
      return;
    }
    if (XZB.ui && XZB.ui.toast) { XZB.ui.toast.show(message, opts); }
  }

  function fmt(cents, opts) {
    var m = moneyApi();
    if (!m || typeof m.formatCents !== 'function') { return String(cents || 0); }
    return m.formatCents(cents || 0, opts || {});
  }

  function compact(cents) {
    var m = moneyApi();
    if (m && typeof m.formatCompact === 'function') { return m.formatCompact(cents || 0); }
    return fmt(cents || 0, { symbol: false });
  }

  function todayStr() {
    var d = datesApi();
    if (d && typeof d.todayStr === 'function') { return d.todayStr(); }
    return '1970-01-01';
  }

  function currentMonth() {
    return todayStr().slice(0, 7);
  }

  function nowIso() {
    var d = datesApi();
    if (d && typeof d.nowIso === 'function') { return d.nowIso(); }
    return new Date().toISOString();
  }

  function cssVar(name) {
    try {
      var styles = global.getComputedStyle(global.document.documentElement);
      var value = styles ? styles.getPropertyValue(name) : '';
      return String(value || '').trim();
    } catch (error) {
      return '';
    }
  }

  function toneForColor(color) {
    var hex = String(color || '').toUpperCase();
    if (!hex) { return ''; }
    for (var i = 0; i < TONE_VARS.length; i += 1) {
      if (cssVar(TONE_VARS[i].varName).toUpperCase() === hex) { return TONE_VARS[i].key; }
    }
    return '';
  }

  function toneOf(book) {
    var byColor = toneForColor(book && book.color);
    if (byColor) { return byColor; }
    var byKind = KIND_TONE[(book && book.kind) || 'daily'];
    return byKind || 'bank';
  }

  function findById(list, id) {
    if (!list || !id) { return null; }
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function sortOrder(book) {
    return book && typeof book.sort === 'number' ? book.sort : 10;
  }

  function allBooks(db) {
    var source = (db && db.books) || [];
    var out = [];
    for (var i = 0; i < source.length; i += 1) {
      var book = source[i];
      if (!book || book.deleted === true) { continue; }
      out.push(book);
    }
    out.sort(function (a, b) {
      if (sortOrder(a) !== sortOrder(b)) { return sortOrder(a) - sortOrder(b); }
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    });
    return out;
  }

  function aliveBooks(books) {
    var out = [];
    for (var i = 0; i < books.length; i += 1) {
      if (books[i].archived !== true) { out.push(books[i]); }
    }
    return out;
  }

  function archivedBooks(books) {
    var out = [];
    for (var i = 0; i < books.length; i += 1) {
      if (books[i].archived === true) { out.push(books[i]); }
    }
    return out;
  }

  /* 每个账本的流水条数（一次遍历，5000 条也只是 5000 次） */
  function countByBook(db) {
    var map = {};
    var list = (db && db.transactions) || [];
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true || !tx.bookId) { continue; }
      map[tx.bookId] = (map[tx.bookId] || 0) + 1;
    }
    return map;
  }

  function countTx(db, bookId) {
    var list = (db && db.transactions) || [];
    var n = 0;
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (tx.bookId === bookId) { n += 1; }
    }
    return n;
  }

  function currentBookId(ctx) {
    var ui = ctx && ctx.state && ctx.state.ui;
    if (ui && ui.activeBookId) { return String(ui.activeBookId); }
    if (ctx && ctx.prefs && typeof ctx.prefs.get === 'function') {
      var stored = ctx.prefs.get('activeBookId', '');
      if (stored) { return String(stored); }
    }
    return '';
  }

  function nextSort(list) {
    var max = 0;
    for (var i = 0; i < list.length; i += 1) {
      var value = list[i] && typeof list[i].sort === 'number' ? list[i].sort : 10;
      if (value > max) { max = value; }
    }
    return max + 10;
  }

  /* ---------------- 列表视图 ---------------- */

  function render(root, ctx) {
    if (!root || !ctx) { return; }
    var db = ctx.db;
    if (!db) {
      root.appendChild(emptyState('账本还没准备好', '稍等一下，或者刷新页面再试', null));
      return;
    }

    ctx.setTitle('账本');

    var books = allBooks(db);
    if (!books.length) {
      root.appendChild(emptyState('还没有账本', '新建一个账本，开始记录第一笔', function () {
        openBookForm(ctx, null);
      }));
      return;
    }

    var alive = aliveBooks(books);
    var archived = archivedBooks(books);
    var counts = countByBook(db);
    var month = currentMonth();
    var currentId = currentBookId(ctx);

    root.appendChild(toolbar(ctx));

    if (alive.length) {
      root.appendChild(group(ctx, db, '我的账本', alive, counts, month, currentId, false));
    } else {
      root.appendChild(emptyState('账本都归档了', '从下面恢复一个，或新建一个账本', function () {
        openBookForm(ctx, null);
      }));
    }

    if (archived.length) {
      root.appendChild(group(ctx, db, '已归档', archived, counts, month, currentId, true));
    }

    root.appendChild(t('p', 's-books-footnote', '账本之间彼此独立；切换后首页、流水与统计都会跟着变。归档的账本随时可以恢复。'));
  }

  function toolbar(ctx) {
    var bar = h('div', { className: 's-books-toolbar' });
    var btn = h('button', {
      className: 'c-btn c-btn--primary s-books-toolbar__btn',
      type: 'button'
    }, kids([iconEl('plus', 18, 's-books-toolbar__glyph'), t('span', 's-books-toolbar__text', '新建账本')]));
    dom.on(btn, 'click', function () {
      openBookForm(ctx, null);
    });
    bar.appendChild(btn);
    return bar;
  }

  function group(ctx, db, title, books, counts, month, currentId, isArchived) {
    var section = h('section', { className: 's-books-group' });
    var head = h('div', { className: 's-books-group__head' });
    head.appendChild(t('h2', 's-books-group__title', title));
    head.appendChild(t('span', 's-books-group__count', books.length + ' 个'));
    section.appendChild(head);

    var list = h('div', { className: 'c-list s-books-list' });
    for (var i = 0; i < books.length; i += 1) {
      list.appendChild(bookRow(ctx, db, books[i], {
        archived: isArchived,
        current: books[i].id === currentId,
        count: counts[books[i].id] || 0,
        month: month
      }));
    }
    section.appendChild(list);
    return section;
  }

  function avatar(book, size) {
    var wrap = h('span', {
      className: 'c-row__icon s-books-avatar s-books-tone--' + toneOf(book)
    });
    wrap.appendChild(iconEl(book.icon || 'book', size || 20, 's-books-glyph'));
    return wrap;
  }

  function rowSub(db, book, count, month) {
    var stats = statsApi();
    var summary = stats && typeof stats.monthSummary === 'function'
      ? stats.monthSummary(db, month, { bookId: book.id })
      : null;
    var income = summary ? summary.incomeCents : 0;
    var expense = summary ? summary.expenseCents : 0;
    var head = '本月收 ' + fmt(income) + ' · 支 ' + fmt(expense);
    return head;
  }

  function bookRow(ctx, db, book, opts) {
    var options = opts || {};
    var current = options.current === true;

    var row = h('div', {
      className: 'c-row c-row--icon c-row--two-line c-row--tappable s-books-row' + (current ? ' is-current' : ''),
      role: 'button',
      tabindex: '0',
      'aria-current': current ? 'true' : 'false'
    });

    row.appendChild(avatar(book, 20));

    var main = h('span', { className: 'c-row__main' });
    var title = h('span', { className: 'c-row__title s-books-row__title' });
    title.appendChild(t('span', 's-books-row__name', book.name || '账本'));
    title.appendChild(t('span', 's-books-row__count',
      (options.count || 0) > 0 ? (options.count || 0) + ' 笔流水' : '还没有流水'));
    main.appendChild(title);
    main.appendChild(t('span', 'c-row__sub s-books-row__sub', rowSub(db, book, options.count || 0, options.month)));
    row.appendChild(main);

    var trail = h('span', { className: 'c-row__trail s-books-row__trail' });
    if (current) {
      var mark = h('span', { className: 's-books-current' }, kids([
        iconEl('check', 14, 's-books-current__glyph'),
        t('span', 's-books-current__text', '当前')
      ]));
      trail.appendChild(mark);
    }
    if (options.archived) {
      var restore = h('button', {
        className: 'c-btn c-btn--text s-books-restore',
        type: 'button',
        'aria-label': '恢复账本「' + (book.name || '') + '」'
      }, kids([t('span', 's-books-restore__text', '恢复')]));
      dom.on(restore, 'click', function (event) {
        if (event && event.stopPropagation) { event.stopPropagation(); }
        restoreBook(ctx, book);
      });
      trail.appendChild(restore);
    } else {
      var more = h('button', {
        className: 's-books-more',
        type: 'button',
        'aria-label': '管理账本「' + (book.name || '') + '」'
      }, kids([iconEl('ellipsis', 20, 's-books-more__glyph')]));
      dom.on(more, 'click', function (event) {
        if (event && event.stopPropagation) { event.stopPropagation(); }
        openManage(ctx, db, book);
      });
      trail.appendChild(more);
    }
    row.appendChild(trail);

    dom.on(row, 'click', function () {
      if (options.archived) {
        toast(ctx, '这个账本已归档，可点「恢复」重新启用', { type: 'info' });
        return;
      }
      switchBook(ctx, book);
    });

    dom.on(row, 'keydown', function (event) {
      if (!event) { return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (options.archived) {
          toast(ctx, '这个账本已归档，可点「恢复」重新启用', { type: 'info' });
          return;
        }
        switchBook(ctx, book);
      }
    });

    return row;
  }

  function switchBook(ctx, book) {
    if (currentBookId(ctx) === book.id) {
      toast(ctx, '已经是当前账本了', { type: 'info' });
      return;
    }
    if (ctx.prefs && typeof ctx.prefs.set === 'function') {
      ctx.prefs.set('activeBookId', book.id);
    }
    toast(ctx, '已切换到 ' + (book.name || '新账本'), { type: 'success' });
    if (XZB.app && typeof XZB.app.refresh === 'function') {
      XZB.app.refresh();
    } else if (typeof ctx.refresh === 'function') {
      ctx.refresh();
    }
  }

  function emptyState(title, desc, onAction) {
    var box = h('div', { className: 'c-empty s-books-empty' });
    box.appendChild(h('div', { className: 'c-empty__icon' }, kids([iconEl('book', 32, 's-books-glyph')])));
    box.appendChild(t('p', 'c-empty__title', title));
    box.appendChild(t('p', 'c-empty__desc', desc));
    if (onAction) {
      var btn = h('button', {
        className: 'c-btn c-btn--primary c-btn--block c-empty__action',
        type: 'button',
        text: '新建账本'
      });
      dom.on(btn, 'click', onAction);
      box.appendChild(btn);
    }
    return box;
  }

  /* ---------------- 每行管理浮层 ---------------- */

  function openManage(ctx, db, book) {
    var body = h('div', { className: 's-books-manage' });
    var handle = null;

    function act(fn) {
      return function () {
        if (handle && typeof handle.close === 'function') { handle.close(); }
        fn();
      };
    }

    body.appendChild(manageRow('edit', '重命名', false, act(function () {
      openBookForm(ctx, book);
    })));
    body.appendChild(manageRow('lock', '归档账本', true, act(function () {
      confirmArchive(ctx, db, book);
    })));

    handle = sheetApi().open({
      title: book.name || '账本',
      content: body,
      actions: [{ label: '取消', kind: 'text' }]
    });
  }

  function manageRow(iconName, label, danger, onClick) {
    var row = h('div', {
      className: 'c-row c-row--icon c-row--tappable s-books-manage__row' + (danger ? ' s-books-manage__row--danger' : ''),
      role: 'button',
      tabindex: '0'
    });
    var icon = h('span', { className: 'c-row__icon s-books-manage__icon' });
    icon.appendChild(iconEl(iconName, 20, 's-books-glyph'));
    row.appendChild(icon);
    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title s-books-manage__label', label));
    row.appendChild(main);
    dom.on(row, 'click', onClick);
    dom.on(row, 'keydown', function (event) {
      if (!event) { return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick();
      }
    });
    return row;
  }

  /* ---------------- 新建 / 重命名 ---------------- */

  function inputNode(attrs) {
    var node = h('input', attrs);
    node.setAttribute('autocapitalize', 'off');
    node.setAttribute('autocorrect', 'off');
    node.setAttribute('spellcheck', 'false');
    return node;
  }

  function field(label, input) {
    var wrap = h('div', { className: 'c-field s-books-field' });
    wrap.appendChild(t('label', 'c-field__label', label));
    var control = h('div', { className: 'c-field__control' });
    control.appendChild(input);
    wrap.appendChild(control);
    return { wrap: wrap, input: input, control: control };
  }

  function openBookForm(ctx, book) {
    var editing = !!book;
    var db = XZB.app && typeof XZB.app.db === 'function' ? XZB.app.db() : ctx.db;
    var sheet = sheetApi();
    if (!sheet) { return; }

    var state = { kind: book ? book.kind : 'daily' };

    var body = h('div', { className: 's-books-form' });
    var errorBox = t('p', 's-books-form__error', '');
    errorBox.hidden = true;
    body.appendChild(errorBox);

    var nameField = field('账本名称', inputNode({
      type: 'text',
      className: 'c-field__input',
      placeholder: '例如 旅行账本',
      maxlength: String(MAX_BOOK_NAME),
      value: book ? book.name : ''
    }));
    body.appendChild(nameField.wrap);

    var kindBlock = h('div', { className: 's-books-block' });
    kindBlock.appendChild(t('span', 'c-field__label s-books-block__label', '账本类型'));
    var kinds = h('div', { className: 's-books-kinds' });

    function renderKinds() {
      var cells = kinds.childNodes;
      for (var i = 0; i < cells.length; i += 1) {
        var key = cells[i].getAttribute('data-kind');
        var active = key === state.kind;
        if (active) { cells[i].classList.add('is-active'); }
        else { cells[i].classList.remove('is-active'); }
        cells[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    for (var i = 0; i < KIND_ORDER.length; i += 1) {
      (function (kindKey) {
        var cell = h('button', {
          className: 's-books-kind',
          type: 'button',
          'data-kind': kindKey,
          'aria-pressed': 'false'
        });
        cell.appendChild(iconEl(KIND_ICON[kindKey], 20, 's-books-kind__icon'));
        cell.appendChild(t('span', 's-books-kind__label', KIND_LABEL[kindKey]));
        dom.on(cell, 'click', function () {
          state.kind = kindKey;
          renderKinds();
        });
        kinds.appendChild(cell);
      }(KIND_ORDER[i]));
    }
    renderKinds();
    kindBlock.appendChild(kinds);
    body.appendChild(kindBlock);

    body.appendChild(t('p', 's-books-form__hint', '最多 ' + MAX_BOOK_NAME + ' 个字。不同账本的流水、分类偏好与统计彼此独立。'));

    var submit = h('button', {
      className: 'c-btn c-btn--primary c-btn--block s-books-form__submit',
      type: 'button',
      text: editing ? '保存' : '创建账本'
    });
    body.appendChild(submit);

    var handle = sheet.open({
      title: editing ? '重命名账本' : '新建账本',
      content: body,
      actions: [{ label: '取消', kind: 'text' }]
    });

    function showError(message) {
      errorBox.textContent = String(message || '');
      errorBox.hidden = !message;
    }

    function submitForm() {
      var name = String(nameField.input.value || '').trim();
      if (!name) {
        showError('请填写账本名称');
        nameField.input.focus();
        return;
      }
      if (name.length > MAX_BOOK_NAME) {
        showError('账本名称最多 ' + MAX_BOOK_NAME + ' 个字');
        nameField.input.focus();
        return;
      }
      var source = (db && db.books) || [];
      for (var j = 0; j < source.length; j += 1) {
        var other = source[j];
        if (!other || other.deleted === true) { continue; }
        if (book && other.id === book.id) { continue; }
        if (String(other.name || '').trim() === name) {
          showError('已经有同名账本，换个名字吧');
          nameField.input.focus();
          return;
        }
      }

      var tone = KIND_TONE[state.kind] || 'bank';
      var color = cssVar('--acc-' + tone);
      if (!color && book && book.color) { color = String(book.color); }
      if (!color) {
        showError('暂时无法确定账本颜色，请稍后再试');
        return;
      }

      var icon = book && book.icon ? book.icon : KIND_ICON[state.kind];
      submit.disabled = true;
      showError('');
      saveBook(ctx, book, {
        name: name,
        kind: state.kind,
        color: color,
        icon: icon
      }, function (ok, message) {
        submit.disabled = false;
        if (!ok) {
          showError(message);
          return;
        }
        if (handle && typeof handle.close === 'function') { handle.close(); }
      });
    }

    dom.on(submit, 'click', submitForm);
    dom.on(nameField.input, 'keydown', function (event) {
      if (event && event.key === 'Enter') {
        event.preventDefault();
        submitForm();
      }
    });
  }

  function saveBook(ctx, book, payload, done) {
    var schema = schemaApi();
    if (!schema) {
      done(false, '数据模块还没准备好，请稍后再试');
      return;
    }
    var editing = !!book;

    ctx.commit(function (working) {
      var list = working.books || (working.books = []);
      var now = nowIso();
      var next;

      if (editing) {
        var target = findById(list, book.id);
        if (!target) {
          return { abort: true, code: 'E_BOOK_MISSING', message: BOOK_MSG.E_BOOK_MISSING };
        }
        target.name = payload.name;
        target.kind = payload.kind;
        if (payload.color) { target.color = payload.color; }
        if (payload.icon) { target.icon = payload.icon; }
        target.updatedAt = now;
        next = target;
      } else {
        next = schema.createBook({
          name: payload.name,
          kind: payload.kind,
          color: payload.color,
          icon: payload.icon
        }, now);
        next.sort = nextSort(list);
        list.push(next);
      }

      for (var i = 0; i < list.length; i += 1) {
        var other = list[i];
        if (!other || other.deleted === true || other.id === next.id) { continue; }
        if (String(other.name || '').trim() === String(next.name || '').trim()) {
          return { abort: true, code: 'E_DUPLICATE_NAME', message: BOOK_MSG.E_DUPLICATE_NAME };
        }
      }

      var verdict = schema.validateBook(next);
      if (!verdict || verdict.ok !== true) {
        var first = verdict && verdict.errors && verdict.errors.length ? verdict.errors[0] : null;
        var code = first ? first.code : 'E_INVALID_INPUT';
        return { abort: true, code: code, message: BOOK_MSG[code] || '账本名称或参数不合适' };
      }

      return { value: { id: next.id } };
    }, { label: editing ? '重命名账本' : '新建账本' }).then(function (result) {
      if (result && result.ok) {
        toast(ctx, editing ? '账本已改名' : '账本已创建', { type: 'success' });
        done(true);
        return;
      }
      var message = result && result.message
        ? result.message
        : (BOOK_MSG[result && result.code] || '保存失败，请重试');
      done(false, message);
    });
  }

  /* ---------------- 归档 / 恢复 ---------------- */

  function confirmArchive(ctx, db, book) {
    var alive = aliveBooks(allBooks(db));
    if (alive.length <= 1) {
      toast(ctx, BOOK_MSG.E_BOOK_LAST + '，不能归档「' + (book.name || '') + '」', { type: 'warning' });
      return;
    }

    var count = countTx(db, book.id);
    var message = count > 0
      ? '「' + book.name + '」有 ' + count + ' 笔流水。归档后流水全部保留、仍可查看，也可随时恢复；只是不会再出现在记账的账本选择里。'
      : '「' + book.name + '」还没有流水。归档后不会出现在记账的账本选择里，可随时恢复。';

    var wasCurrent = currentBookId(ctx) === book.id;
    var fallback = null;
    for (var i = 0; i < alive.length; i += 1) {
      if (alive[i].id !== book.id) { fallback = alive[i]; break; }
    }

    var sheet = sheetApi();
    if (!sheet) { return; }

    confirmSheet(ctx, {
      title: '归档账本',
      message: message,
      confirmLabel: '归档',
      danger: true,
      onConfirm: function (close) {
        ctx.commit(function (working) {
          var target = findById(working.books || [], book.id);
          if (!target) {
            return { abort: true, code: 'E_BOOK_MISSING', message: BOOK_MSG.E_BOOK_MISSING };
          }
          var active = 0;
          for (var j = 0; j < (working.books || []).length; j += 1) {
            var item = working.books[j];
            if (!item || item.deleted === true || item.archived === true) { continue; }
            active += 1;
          }
          if (active <= 1) {
            return { abort: true, code: 'E_BOOK_LAST', message: BOOK_MSG.E_BOOK_LAST };
          }
          target.archived = true;
          target.updatedAt = nowIso();
          return {
            value: {
              id: target.id,
              fallbackId: fallback ? fallback.id : '',
              fallbackName: fallback ? fallback.name : ''
            }
          };
        }, { label: '归档账本' }).then(function (result) {
          if (result && result.ok) {
            var value = result.value || {};
            if (wasCurrent && value.fallbackId && ctx.prefs && typeof ctx.prefs.set === 'function') {
              ctx.prefs.set('activeBookId', value.fallbackId);
            }
            toast(ctx, wasCurrent
              ? '账本已归档，已切换到「' + (value.fallbackName || '其他账本') + '」'
              : '账本已归档', { type: 'success' });
            close();
            return;
          }
          var message2 = result && result.message
            ? result.message
            : (BOOK_MSG[result && result.code] || '归档失败，请重试');
          toast(ctx, message2, { type: 'danger' });
          close();
        });
      }
    });
  }

  function restoreBook(ctx, book) {
    ctx.commit(function (working) {
      var target = findById(working.books || [], book.id);
      if (!target) {
        return { abort: true, code: 'E_BOOK_MISSING', message: BOOK_MSG.E_BOOK_MISSING };
      }
      target.archived = false;
      target.updatedAt = nowIso();
      return { value: { id: target.id } };
    }, { label: '恢复账本' }).then(function (result) {
      if (result && result.ok) {
        toast(ctx, '账本已恢复', { type: 'success' });
        return;
      }
      var message = result && result.message
        ? result.message
        : (BOOK_MSG[result && result.code] || '恢复失败，请重试');
      toast(ctx, message, { type: 'danger' });
    });
  }

  function confirmSheet(ctx, options) {
    var opts = options || {};
    var body = h('div', { className: 's-books-confirm' });
    body.appendChild(t('p', 's-books-confirm__text', opts.message || ''));

    var handle = sheetApi().open({
      title: opts.title || '确认',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: opts.confirmLabel || '确定',
          kind: opts.danger ? 'danger' : 'primary',
          onClick: function () {
            var closed = false;
            if (typeof opts.onConfirm === 'function') {
              opts.onConfirm(function () {
                if (closed) { return; }
                closed = true;
                if (handle && typeof handle.close === 'function') { handle.close(); }
              });
            }
            return false;
          }
        }
      ]
    });
  }

  XZB.screens.register(KEY, {
    title: '账本',
    subtitle: '分开记，一起看',
    render: render
  });
}(window));
