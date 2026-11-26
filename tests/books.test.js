'use strict';
/*
 * tests/books.test.js
 * 账本（books）行为级回归——补 2.44.0/2.44.1 验收报告在案的高风险路径盲区（P2-5）。
 *
 * 运行：node tests/books.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 加载 index.html 的 money/dates/schema 内联块（真实实现），再把
 * js/screens/books.js 整文件载入同一沙箱（仅在 screens.register 前注入一行导出钩子，
 * 不改任何业务逻辑），用模拟 ctx.commit（clone→mutator→abort 丢弃/成功应用）真跑
 * saveBook / confirmArchive / restoreBook / switchBook 的提交闭包。
 * 另按 liftFunction 范式提升 index.html 的 reconcileActiveBook（当前账本失效兜底）真跑。
 * 只读业务代码，不修改任何业务文件；不锁源码字符串。
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

/* ============================== 沙箱装配 ============================== */

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const sandbox = { console: console };
vm.createContext(sandbox);
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const schema = sandbox.XZB.Core.schema;
const dates = sandbox.XZB.Core.dates;

/* books.js 以 window 收尾；ui/dom/sheet 用桩，core 走真实实现 */
sandbox.window = sandbox;
sandbox.XZB.screens = { register: function () {} };
const sheetCalls = { confirms: [], closed: 0 };
sandbox.XZB.ui = {
  dom: {},
  sheet: {
    open: function () { return { close: function () {} }; },
    confirm: function (opts) {
      sheetCalls.confirms.push(opts);
      opts.onConfirm(function () { sheetCalls.closed += 1; });
    }
  }
};

/* 注入导出钩子：只暴露内部函数引用，供测试驱动；业务逻辑一字不动 */
const HOOK = 'globalThis.__books = { saveBook: saveBook, confirmArchive: confirmArchive,' +
  ' restoreBook: restoreBook, switchBook: switchBook, currentBookId: currentBookId,' +
  ' allBooks: allBooks, aliveBooks: aliveBooks, archivedBooks: archivedBooks,' +
  ' countTx: countTx, nextSort: nextSort, BOOK_MSG: BOOK_MSG };\n  ';
const REGISTER_MARK = 'XZB.screens.register(KEY, {';
if (BOOKS_SRC.split(REGISTER_MARK).length !== 2) { throw new Error('books.js 注册锚点不唯一，无法注入导出钩子'); }
vm.runInContext(BOOKS_SRC.replace(REGISTER_MARK, HOOK + REGISTER_MARK), sandbox, { filename: 'js/screens/books.js' });
const books = sandbox.__books;
if (!books || typeof books.saveBook !== 'function') { throw new Error('books.js 导出钩子失败'); }

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

function txOf(bookId, over) {
  return schema.createTransaction(Object.assign({
    bookId: bookId, type: 'expense', amountCents: 1200,
    accountId: 'ac_wechat', categoryId: 'ca_food',
    date: '2026-11-20', time: '12:00', note: '午饭'
  }, over || {}), NOW);
}

/* 模拟 app.commit 的真实语义：clone 草稿 → mutator → abort 丢弃 / 成功应用 */
function makeCtx(db, activeBookId) {
  const prefsStore = {};
  if (activeBookId) { prefsStore.activeBookId = activeBookId; }
  const rec = { toasts: [], refreshes: 0, commits: [] };
  const ctx = {
    db: db,
    state: { ui: { activeBookId: activeBookId || '' } },
    prefs: {
      get: function (key, fallback) { return key in prefsStore ? prefsStore[key] : fallback; },
      set: function (key, value) { prefsStore[key] = value; }
    },
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

function findBook(db, id) {
  return db.books.find(function (b) { return b.id === id; }) || null;
}

/* ============================== 用例 ============================== */

section('1 当前账本读取与切换');

test('1.1 currentBookId：state.ui 优先，其次 prefs，都没有返回空串', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  h.ctx.state.ui.activeBookId = 'bk_trip01';
  checkEq(books.currentBookId(h.ctx), 'bk_trip01', 'state.ui 优先');
  h.ctx.state.ui.activeBookId = '';
  checkEq(books.currentBookId(h.ctx), 'bk_default', '回落 prefs');
  const empty = makeCtx(freshDb(), '');
  checkEq(books.currentBookId(empty.ctx), '', '双空返回空串');
});

test('1.2 switchBook：写 prefs + 触发刷新 + 成功提示', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  books.switchBook(h.ctx, findBook(h.ctx.db, 'bk_trip01'));
  checkEq(h.prefs.activeBookId, 'bk_trip01', 'prefs 已写入');
  checkEq(h.rec.refreshes, 1, '刷新一次');
  check(h.rec.toasts.some(function (t) { return t.msg.indexOf('旅行') >= 0 && t.type === 'success'; }), '成功提示带账本名');
});

test('1.3 switchBook：点当前账本不写 prefs、不刷新', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  books.switchBook(h.ctx, findBook(h.ctx.db, 'bk_default'));
  checkEq(h.rec.refreshes, 0, '不刷新');
  checkEq(h.rec.toasts[0].type, 'info', 'info 提示');
});

section('2 新建 / 重命名（saveBook 提交闭包）');

test('2.1 新建：落库、sort 排到末尾、schema 校验通过', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  let doneOk = null;
  books.saveBook(h.ctx, null, { name: '生意', kind: 'business', color: '#FF9500', icon: 'briefcase' },
    function (ok) { doneOk = ok; });
  checkEq(doneOk, true, 'done(true)');
  checkEq(h.ctx.db.books.length, 3, '账本 +1');
  const created = h.ctx.db.books[2];
  checkEq(created.name, '生意', '名称');
  checkEq(created.kind, 'business', '类型');
  checkEq(created.sort, 30, 'sort = max+10');
  check(schema.validateBook(created).ok, '新账本过 schema 校验');
});

test('2.2 新建同名：abort，库一个字节不动', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const before = clone(h.ctx.db);
  let msg = '';
  books.saveBook(h.ctx, null, { name: '旅行', kind: 'daily', color: '#007AFF', icon: 'book' },
    function (ok, m) { msg = ok ? '' : m; });
  check(msg.indexOf('同名') >= 0, '提示同名：' + msg);
  checkEq(JSON.stringify(h.ctx.db), JSON.stringify(before), 'abort 后库不变');
});

test('2.3 重命名：只改目标账本，id 不变', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const book = findBook(h.ctx.db, 'bk_trip01');
  let doneOk = null;
  books.saveBook(h.ctx, book, { name: '旅行 2027', kind: 'travel', color: '#34C759', icon: 'house' },
    function (ok) { doneOk = ok; });
  checkEq(doneOk, true, 'done(true)');
  checkEq(findBook(h.ctx.db, 'bk_trip01').name, '旅行 2027', '已改名');
  checkEq(h.ctx.db.books.length, 2, '不新增账本');
});

test('2.4 重命名撞已有名 / 目标不存在：都 abort 且库不变', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  const before = clone(h.ctx.db);
  let msg = '';
  books.saveBook(h.ctx, findBook(h.ctx.db, 'bk_trip01'),
    { name: '日常', kind: 'travel', color: '#34C759', icon: 'house' },
    function (ok, m) { msg = ok ? '' : m; });
  check(msg.indexOf('同名') >= 0, '撞名提示');
  books.saveBook(h.ctx, { id: 'bk_gone01', name: '幽灵', kind: 'daily' },
    { name: '幽灵改', kind: 'daily', color: '#007AFF', icon: 'book' },
    function (ok, m) { msg = ok ? '' : m; });
  checkEq(msg, books.BOOK_MSG.E_BOOK_MISSING, '目标不存在提示');
  checkEq(JSON.stringify(h.ctx.db), JSON.stringify(before), '库不变');
});

section('3 归档 / 恢复');

test('3.1 最后一个未归档账本：拒绝归档，不进确认浮层、不提交', function () {
  const db = freshDb();
  findBook(db, 'bk_trip01').archived = true;
  const h = makeCtx(db, 'bk_default');
  const confirmsBefore = sheetCalls.confirms.length;
  books.confirmArchive(h.ctx, h.ctx.db, findBook(db, 'bk_default'));
  checkEq(sheetCalls.confirms.length, confirmsBefore, '不弹确认');
  checkEq(h.rec.commits.length, 0, '不提交');
  check(h.rec.toasts.some(function (t) { return t.type === 'warning' && t.msg.indexOf('至少') >= 0; }), 'warning 提示');
  checkEq(findBook(h.ctx.db, 'bk_default').archived, false, '未被归档');
});

test('3.2 归档当前账本：archived=true，prefs 自动切到兜底账本', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  books.confirmArchive(h.ctx, h.ctx.db, findBook(h.ctx.db, 'bk_default'));
  checkEq(sheetCalls.confirms.length > 0, true, '走了确认浮层');
  checkEq(findBook(h.ctx.db, 'bk_default').archived, true, '已归档');
  checkEq(h.prefs.activeBookId, 'bk_trip01', 'prefs 切到兜底');
  check(h.rec.toasts.some(function (t) { return t.msg.indexOf('旅行') >= 0; }), '提示带兜底账本名');
});

test('3.3 归档非当前账本：prefs 不动', function () {
  const h = makeCtx(freshDb(), 'bk_default');
  books.confirmArchive(h.ctx, h.ctx.db, findBook(h.ctx.db, 'bk_trip01'));
  checkEq(findBook(h.ctx.db, 'bk_trip01').archived, true, '已归档');
  checkEq(h.prefs.activeBookId, 'bk_default', 'prefs 不动');
});

test('3.4 归档确认文案带真实流水笔数（软删不计）', function () {
  const db = freshDb();
  db.transactions.push(txOf('bk_trip01'), txOf('bk_trip01'), txOf('bk_trip01', { deleted: true, deletedAt: NOW }));
  const h = makeCtx(db, 'bk_default');
  const before = sheetCalls.confirms.length;
  books.confirmArchive(h.ctx, h.ctx.db, findBook(db, 'bk_trip01'));
  const opts = sheetCalls.confirms[before];
  check(opts && opts.message.indexOf('2 笔流水') >= 0, '文案应写 2 笔：' + (opts && opts.message));
});

test('3.5 恢复：archived=false；目标不存在给 danger 提示', function () {
  const db = freshDb();
  findBook(db, 'bk_trip01').archived = true;
  const h = makeCtx(db, 'bk_default');
  books.restoreBook(h.ctx, findBook(db, 'bk_trip01'));
  checkEq(findBook(h.ctx.db, 'bk_trip01').archived, false, '已恢复');
  books.restoreBook(h.ctx, { id: 'bk_gone01', name: '幽灵' });
  check(h.rec.toasts.some(function (t) { return t.type === 'danger' && t.msg === books.BOOK_MSG.E_BOOK_MISSING; }), 'danger 提示');
});

section('4 列表口径（allBooks / aliveBooks / countTx）');

test('4.1 deleted 剔除、sort 升序、归档分组、软删流水不计数', function () {
  const db = freshDb();
  db.books.push(schema.createBook({ id: 'bk_gone01', name: '已删', kind: 'daily', color: '#007AFF', icon: 'book', sort: 5 }, NOW));
  findBook(db, 'bk_gone01').deleted = true;
  findBook(db, 'bk_trip01').archived = true;
  db.transactions.push(txOf('bk_default'), txOf('bk_default', { deleted: true, deletedAt: NOW }));
  const all = books.allBooks(db);
  checkEq(all.length, 2, 'deleted 账本剔除');
  checkEq(all[0].id, 'bk_default', 'sort 小的在前');
  checkEq(books.aliveBooks(all).length, 1, '未归档 1 个');
  checkEq(books.archivedBooks(all)[0].id, 'bk_trip01', '归档分组');
  checkEq(books.countTx(db, 'bk_default'), 1, '软删流水不计数');
});

/* ============================== reconcileActiveBook（index.html 提升） ============================== */

function matchBracket(src, startIdx, openCh, closeCh) {
  let depth = 0;
  let i = startIdx;
  let state = '';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === '') {
      if (ch === "'" || ch === '"') { state = ch; }
      else if (ch === '/' && next === '/') { state = 'line'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'block'; i += 1; }
      else if (ch === openCh) { depth += 1; }
      else if (ch === closeCh) {
        depth -= 1;
        if (depth === 0) { return i; }
      }
    } else if (state === "'" || state === '"') {
      if (ch === '\\') { i += 1; }
      else if (ch === state) { state = ''; }
    } else if (state === 'line') {
      if (ch === '\n') { state = ''; }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = ''; i += 1; }
    }
    i += 1;
  }
  return -1;
}

function liftFunction(src, fnName) {
  const re = new RegExp('function\\s+' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) { return null; }
  const openIdx = src.indexOf('{', m.index);
  const closeIdx = matchBracket(src, openIdx, '{', '}');
  if (closeIdx < 0) { return null; }
  return src.slice(m.index, closeIdx + 1);
}

const reconcileSrc = liftFunction(INDEX_HTML, 'reconcileActiveBook');
if (!reconcileSrc) { throw new Error('index.html 中提取不到 reconcileActiveBook'); }

function runReconcile(booksList, wanted) {
  const box = { console: console };
  vm.createContext(box);
  box.state = { db: { books: booksList }, ui: {} };
  box.prefsCache = { activeBookId: wanted };
  box.writes = [];
  box.writePrefs = function (p) { box.writes.push(JSON.parse(JSON.stringify(p))); };
  vm.runInContext(reconcileSrc + '\nglobalThis.__reconcile = reconcileActiveBook;', box, { filename: 'lift:reconcileActiveBook' });
  box.__reconcile();
  return box;
}

section('5 当前账本失效兜底（reconcileActiveBook）');

test('5.1 wanted 仍有效：保持不动，不写 prefs', function () {
  const box = runReconcile([
    { id: 'bk_keep01', archived: false },
    { id: 'bk_other1', archived: false }
  ], 'bk_keep01');
  checkEq(box.state.ui.activeBookId, 'bk_keep01', '保持');
  checkEq(box.writes.length, 0, '不写 prefs');
});

test('5.2 wanted 已归档：优先 isDefault，其次第一个未归档，并写回 prefs', function () {
  const box = runReconcile([
    { id: 'bk_want01', archived: true },
    { id: 'bk_first1', archived: false },
    { id: 'bk_def001', archived: false, isDefault: true }
  ], 'bk_want01');
  checkEq(box.state.ui.activeBookId, 'bk_def001', 'isDefault 优先');
  checkEq(box.writes.length, 1, '写回一次');
  checkEq(box.writes[0].activeBookId, 'bk_def001', '写回值');

  const box2 = runReconcile([
    { id: 'bk_want01', archived: true },
    { id: 'bk_first1', archived: false },
    { id: 'bk_next01', archived: false }
  ], 'bk_want01');
  checkEq(box2.state.ui.activeBookId, 'bk_first1', '无 isDefault 取第一个未归档');
});

test('5.3 wanted 已被删 / 不存在：同样兜底；deleted 账本不参与', function () {
  const box = runReconcile([
    { id: 'bk_del001', deleted: true },
    { id: 'bk_live01', archived: false }
  ], 'bk_del001');
  checkEq(box.state.ui.activeBookId, 'bk_live01', 'deleted 不算有效，也不当兜底');
});

test('5.4 全部归档/删除：置 null 并写回，不抛错', function () {
  const box = runReconcile([
    { id: 'bk_a0001', archived: true },
    { id: 'bk_b0001', deleted: true }
  ], 'bk_a0001');
  checkEq(box.state.ui.activeBookId, null, '置 null');
  checkEq(box.prefsCache.activeBookId, null, 'prefs 同步 null');
  checkEq(box.writes.length, 1, '写回一次');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);