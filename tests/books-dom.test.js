'use strict';
/*
 * tests/books-dom.test.js
 * 账本（books）DOM 渲染路径行为级回归——闭合盲区批次验收报告⑦-1
 * （render / openBookForm / submitForm / 管理浮层此前零覆盖）。
 *
 * 运行：node tests/books-dom.test.js（scripts/test.js 自动收集）
 *
 * 做法：与 books.test.js 同范式——vm 加载 index.html 的 money/dates/schema 内联块
 * （真实实现），books.js 整文件载入（仅在 screens.register 前注入一行导出钩子）。
 * DOM 用极简桩（只实现 books.js 用到的面），dom.el/dom.on/sheet/icons 为桩，
 * 渲染与表单提交逻辑全部真跑源码，不复写实现、不锁源码字符串。
 * 只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const BOOKS_SRC = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'books.js'), 'utf8');

/* ============================== 极简测试骨架 ============================== */

let passCount = 0;
let failCount = 0;

function section(title) {
  console.log('\n===== ' + title + ' =====');
}

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failCount += 1;
    console.log('  [FAIL] ' + name);
    console.log('         -> ' + (e && e.message ? e.message : String(e)));
  }
}

function check(cond, label) {
  if (!cond) { throw new Error(label); }
}

function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ============================== DOM 桩 ============================== */

function makeNode(tag) {
  const node = {
    tag: tag, children: [], parentNode: null, listeners: {},
    className: '', value: '', textContent: '', hidden: false, disabled: false,
    focused: 0, attrs: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
    get childNodes() { return this.children; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((f) => f(ev || {})); },
    focus() { this.focused += 1; }
  };
  return node;
}

/* dom.el 桩：className/text/value 落属性，其余走 setAttribute，children 依次 append */
function domEl(tag, attrs, children) {
  const node = makeNode(tag);
  const a = attrs || {};
  Object.keys(a).forEach((k) => {
    if (k === 'className') { node.className = a[k]; }
    else if (k === 'text') { node.textContent = String(a[k]); }
    else if (k === 'value') { node.value = String(a[k]); }
    else { node.setAttribute(k, a[k]); }
  });
  (children || []).forEach((c) => { if (c) { node.appendChild(c); } });
  return node;
}

function domOn(node, type, fn) { node.addEventListener(type, fn); }

function walk(node, visit) {
  visit(node);
  (node.children || []).forEach((c) => walk(c, visit));
}

function findAll(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) { out.push(n); } });
  return out;
}

function byClass(root, cls) {
  return findAll(root, (n) => String(n.className || '').split(/\s+/).indexOf(cls) >= 0);
}

function textOf(root) {
  let out = '';
  walk(root, (n) => { out += String(n.textContent || ''); });
  return out;
}

function click(node) {
  node.dispatch('click', { stopPropagation() { this.stopped = true; } });
}

/* ============================== 沙箱装配 ============================== */

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const CSS_VARS = {
  '--acc-bank': '#007AFF',
  '--acc-cash': '#34C759',
  '--acc-savings': '#FF9500'
};

const sandbox = { console: console };
vm.createContext(sandbox);
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const schema = sandbox.XZB.Core.schema;

sandbox.window = sandbox;
sandbox.document = { documentElement: makeNode('html') };
sandbox.getComputedStyle = function () {
  return { getPropertyValue: (name) => CSS_VARS[name] || '' };
};

const sheetCalls = { opens: [], confirms: [] };
sandbox.XZB.screens = { register: function () {} };
sandbox.XZB.ui = {
  dom: { el: domEl, on: domOn },
  icons: { node: function () { return null; } },
  sheet: {
    open: function (opts) {
      const rec = { opts: opts, closed: 0 };
      rec.handle = { close: function () { rec.closed += 1; } };
      sheetCalls.opens.push(rec);
      return rec.handle;
    },
    confirm: function (opts) {
      sheetCalls.confirms.push(opts);
    }
  }
};

/* 注入导出钩子：只暴露内部函数引用；业务逻辑一字不动（锚点唯一性守卫同 books.test.js） */
const HOOK = 'globalThis.__booksDom = { render: render, openBookForm: openBookForm,' +
  ' openManage: openManage, BOOK_MSG: BOOK_MSG, MAX_BOOK_NAME: MAX_BOOK_NAME };\n  ';
const REGISTER_MARK = 'XZB.screens.register(KEY, {';
if (BOOKS_SRC.split(REGISTER_MARK).length !== 2) { throw new Error('books.js 注册锚点不唯一，无法注入导出钩子'); }
vm.runInContext(BOOKS_SRC.replace(REGISTER_MARK, HOOK + REGISTER_MARK), sandbox, { filename: 'js/screens/books.js' });
const booksDom = sandbox.__booksDom;
if (!booksDom || typeof booksDom.render !== 'function') { throw new Error('books.js 导出钩子失败'); }

/* ============================== fixture ============================== */

const NOW = '2026-11-26T09:00:00+08:00';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function freshDb() {
  const db = schema.createDb(NOW);
  db.books.push(schema.createBook({
    id: 'bk_trip01', name: '旅行', kind: 'travel', color: '#34C759', icon: 'house', sort: 20
  }, NOW));
  return db;
}

function makeCtx(db, activeBookId) {
  const prefsStore = {};
  if (activeBookId) { prefsStore.activeBookId = activeBookId; }
  const rec = { toasts: [], refreshes: 0, commits: [], titles: [] };
  const ctx = {
    db: db,
    state: { ui: { activeBookId: activeBookId || '' } },
    prefs: {
      get: function (key, fallback) { return key in prefsStore ? prefsStore[key] : fallback; },
      set: function (key, value) { prefsStore[key] = value; }
    },
    setTitle: function (t) { rec.titles.push(t); },
    toast: function (msg, opts) { rec.toasts.push({ msg: String(msg), type: opts && opts.type }); },
    refresh: function () { rec.refreshes += 1; },
    commit: function (mutator, opts) {
      rec.commits.push(opts && opts.label);
      const working = clone(ctx.db);
      const res = mutator(working);
      let out;
      if (res && res.abort) {
        out = { ok: false, code: res.code, message: res.message };
      } else {
        ctx.db = working;
        out = { ok: true, value: res && res.value };
      }
      return { then: function (fn) { fn(out); return this; } };
    }
  };
  return { ctx: ctx, rec: rec, prefs: prefsStore };
}

function renderInto(h) {
  const root = makeNode('div');
  booksDom.render(root, h.ctx);
  return root;
}

function findBook(db, id) {
  return db.books.find(function (b) { return b.id === id; }) || null;
}

/* ============================== 1 render ============================== */

section('1 render：分组 / 当前标记 / 空态');

test('1.1 正常渲染：标题、我的账本/已归档分组、当前标记、笔数、恢复按钮', function () {
  const db = freshDb();
  findBook(db, 'bk_trip01').archived = true;
  db.transactions.push(schema.createTransaction({
    bookId: 'bk_default', type: 'expense', amountCents: 1200,
    accountId: 'ac_wechat', categoryId: 'ca_food', date: '2026-11-20', time: '12:00', note: '午饭'
  }, NOW));
  const h = makeCtx(db, 'bk_default');
  const root = renderInto(h);
  checkEq(h.rec.titles[0], '账本', 'setTitle');
  const groupTitles = byClass(root, 's-books-group__title').map(textOf);
  check(groupTitles.indexOf('我的账本') >= 0 && groupTitles.indexOf('已归档') >= 0, '两个分组：' + groupTitles);
  const currentRows = byClass(root, 'is-current');
  checkEq(currentRows.length, 1, '当前账本行恰一个');
  check(textOf(currentRows[0]).indexOf('日常') >= 0, '当前行是日常');
  check(textOf(currentRows[0]).indexOf('当前') >= 0, '当前标记');
  check(textOf(currentRows[0]).indexOf('1 笔流水') >= 0, '笔数文案');
  checkEq(byClass(root, 's-books-restore').length, 1, '归档行有恢复按钮');
  check(byClass(root, 's-books-footnote').length === 1, '脚注');
});

test('1.2 空库：还没有账本 + 新建按钮点开表单', function () {
  const db = freshDb();
  db.books = [];
  const h = makeCtx(db, '');
  const root = renderInto(h);
  check(textOf(root).indexOf('还没有账本') >= 0, '空态文案');
  const btn = byClass(root, 'c-empty__action')[0];
  check(btn, '新建按钮');
  const before = sheetCalls.opens.length;
  click(btn);
  checkEq(sheetCalls.opens.length, before + 1, '点开表单');
  checkEq(sheetCalls.opens[before].opts.title, '新建账本', '表单标题');
});

test('1.3 全部归档：账本都归档了 + 已归档分组仍在', function () {
  const db = freshDb();
  db.books.forEach(function (b) { b.archived = true; });
  const h = makeCtx(db, '');
  const root = renderInto(h);
  check(textOf(root).indexOf('账本都归档了') >= 0, '全归档空态');
  const groupTitles = byClass(root, 's-books-group__title').map(textOf);
  check(groupTitles.indexOf('已归档') >= 0, '已归档分组');
  checkEq(byClass(root, 's-books-restore').length, 2, '两个恢复按钮');
});

test('1.4 ctx.db 缺失：账本还没准备好，不 setTitle', function () {
  const h = makeCtx(freshDb(), '');
  h.ctx.db = null;
  const root = renderInto(h);
  check(textOf(root).indexOf('账本还没准备好') >= 0, '未就绪文案');
  checkEq(h.rec.titles.length, 0, '不 setTitle');
});

/* ============================== 2 行交互 ============================== */

section('2 行交互：切换 / 归档行提示 / 恢复 / 管理浮层');

test('2.1 点非当前行主按钮：写 prefs + 刷新 + 成功提示', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const root = renderInto(h);
  const actions = byClass(root, 's-books-row__action');
  const trip = actions.find(function (n) { return textOf(n).indexOf('旅行') >= 0; });
  click(trip);
  checkEq(h.prefs.activeBookId, 'bk_trip01', 'prefs 已切换');
  checkEq(h.rec.refreshes, 1, '刷新一次');
});

test('2.2 点归档行主按钮：info 提示，不写 prefs 不刷新', function () {
  const db = freshDb();
  findBook(db, 'bk_trip01').archived = true;
  const h = makeCtx(db, 'bk_default');
  const root = renderInto(h);
  const trip = byClass(root, 's-books-row__action').find(function (n) { return textOf(n).indexOf('旅行') >= 0; });
  click(trip);
  checkEq(h.rec.refreshes, 0, '不刷新');
  checkEq(h.prefs.activeBookId, 'bk_default', 'prefs 不动');
  check(h.rec.toasts.some(function (t) { return t.type === 'info' && t.msg.indexOf('归档') >= 0; }), 'info 提示');
});

test('2.3 点恢复按钮：archived=false + 成功提示', function () {
  const db = freshDb();
  findBook(db, 'bk_trip01').archived = true;
  const h = makeCtx(db, 'bk_default');
  const root = renderInto(h);
  click(byClass(root, 's-books-restore')[0]);
  checkEq(findBook(h.ctx.db, 'bk_trip01').archived, false, '已恢复');
  check(h.rec.toasts.some(function (t) { return t.type === 'success' && t.msg.indexOf('恢复') >= 0; }), '成功提示');
});

test('2.4 点更多按钮：管理浮层含重命名/归档；点归档进确认浮层', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const root = renderInto(h);
  const more = byClass(root, 's-books-more')[0];
  const opensBefore = sheetCalls.opens.length;
  click(more);
  checkEq(sheetCalls.opens.length, opensBefore + 1, '管理浮层打开');
  const manage = sheetCalls.opens[opensBefore];
  const labels = byClass(manage.opts.content, 's-books-manage__label').map(textOf);
  check(labels.indexOf('重命名') >= 0 && labels.indexOf('归档账本') >= 0, '两个管理项：' + labels);
  const confirmsBefore = sheetCalls.confirms.length;
  const archiveRow = byClass(manage.opts.content, 's-books-manage__row--danger')[0];
  click(archiveRow);
  checkEq(manage.closed, 1, '管理浮层先关');
  checkEq(sheetCalls.confirms.length, confirmsBefore + 1, '归档确认浮层打开');
});

/* ============================== 3 表单 ============================== */

section('3 openBookForm / submitForm：校验 / 提交 / 失败路径');

function openForm(h, book) {
  const before = sheetCalls.opens.length;
  booksDom.openBookForm(h.ctx, book || null);
  const rec = sheetCalls.opens[before];
  if (!rec) { throw new Error('表单未打开'); }
  const body = rec.opts.content;
  return {
    rec: rec,
    input: byClass(body, 'c-field__input')[0],
    submit: byClass(body, 's-books-form__submit')[0],
    error: byClass(body, 's-books-form__error')[0],
    kinds: byClass(body, 's-books-kind')
  };
}

test('3.1 新建表单：默认 daily 选中，点 travel 切换 aria-pressed', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  checkEq(f.kinds.length, 3, '三种类型');
  const daily = f.kinds.find(function (n) { return n.getAttribute('data-kind') === 'daily'; });
  const travel = f.kinds.find(function (n) { return n.getAttribute('data-kind') === 'travel'; });
  checkEq(daily.getAttribute('aria-pressed'), 'true', 'daily 默认选中');
  click(travel);
  checkEq(travel.getAttribute('aria-pressed'), 'true', 'travel 选中');
  checkEq(daily.getAttribute('aria-pressed'), 'false', 'daily 取消');
  checkEq(f.input.getAttribute('maxlength'), '20', '名称上限 20');
});

test('3.2 空名称提交：报错 + focus，不提交不关浮层', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  click(f.submit);
  checkEq(f.error.textContent, '请填写账本名称', '错误文案');
  checkEq(f.error.hidden, false, '错误可见');
  check(f.input.focused >= 1, '输入框聚焦');
  checkEq(h.rec.commits.length, 0, '不提交');
  checkEq(f.rec.closed, 0, '浮层不关');
});

test('3.3 超长名称（>20 字）：报错不提交', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  f.input.value = '一二三四五六七八九十一二三四五六七八九二十一';
  click(f.submit);
  check(f.error.textContent.indexOf('最多 20') >= 0, '超长提示：' + f.error.textContent);
  checkEq(h.rec.commits.length, 0, '不提交');
});

test('3.4 同名：报错不提交，库不变', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const before = clone(h.ctx.db);
  const f = openForm(h);
  f.input.value = '旅行';
  click(f.submit);
  check(f.error.textContent.indexOf('同名') >= 0, '同名提示');
  checkEq(h.rec.commits.length, 0, '预检拦截，不提交');
  checkEq(JSON.stringify(h.ctx.db), JSON.stringify(before), '库不变');
});

test('3.5 合法新建：落库 + 关浮层 + 成功提示 + 按钮恢复可用', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  f.input.value = '生意';
  click(f.kinds.find(function (n) { return n.getAttribute('data-kind') === 'business'; }));
  click(f.submit);
  checkEq(h.ctx.db.books.length, 3, '账本 +1');
  const created = h.ctx.db.books[2];
  checkEq(created.name, '生意', '名称');
  checkEq(created.kind, 'business', '类型');
  checkEq(created.color, '#FF9500', '颜色取 --acc-savings');
  checkEq(f.rec.closed, 1, '浮层关闭');
  checkEq(f.submit.disabled, false, '按钮恢复可用');
  check(h.rec.toasts.some(function (t) { return t.type === 'success' && t.msg.indexOf('创建') >= 0; }), '成功提示');
});

test('3.6 重命名表单：预填旧名、按钮文案「保存」，改回自己的名字不算撞名', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h, findBook(h.ctx.db, 'bk_trip01'));
  checkEq(f.rec.opts.title, '重命名账本', '标题');
  checkEq(f.input.value, '旅行', '预填旧名');
  checkEq(f.submit.textContent, '保存', '按钮文案');
  click(f.submit);
  checkEq(h.ctx.db.books.length, 2, '不新增');
  checkEq(f.rec.closed, 1, '保存成功关浮层');
});

test('3.7 回车提交：与点按钮同路径', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  f.input.value = '回车账本';
  f.input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  checkEq(h.ctx.db.books.length, 3, '回车落库');
  checkEq(f.rec.closed, 1, '关浮层');
});

test('3.8 CSS 变量取不到颜色：报错不提交（失败路径闭合）', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  f.input.value = '无色账本';
  const saved = CSS_VARS['--acc-bank'];
  delete CSS_VARS['--acc-bank'];
  try { click(f.submit); } finally { CSS_VARS['--acc-bank'] = saved; }
  check(f.error.textContent.indexOf('颜色') >= 0, '颜色错误提示：' + f.error.textContent);
  checkEq(h.rec.commits.length, 0, '不提交');
  checkEq(f.rec.closed, 0, '浮层不关');
});

test('3.9 commit 失败：错误上屏、浮层不关、按钮恢复可用', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const f = openForm(h);
  f.input.value = '失败账本';
  h.ctx.commit = function () {
    return { then: function (fn) { fn({ ok: false, code: 'E_DUPLICATE_NAME', message: '已经有同名账本' }); return this; } };
  };
  click(f.submit);
  checkEq(f.error.textContent, '已经有同名账本', '错误上屏');
  checkEq(f.error.hidden, false, '错误可见');
  checkEq(f.rec.closed, 0, '浮层不关');
  checkEq(f.submit.disabled, false, '按钮恢复可用');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);