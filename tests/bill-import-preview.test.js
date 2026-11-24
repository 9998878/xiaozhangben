'use strict';
/*
 * tests/bill-import-preview.test.js —— 账单导入预览防御修复回归（2.39.1）
 *
 * previewBillImport 是 settings 屏里的界面代码，Node 里没有 DOM。
 * 做法：从 settings.js 源码切出 billSourceLabel / billDupeOf / previewBillImport，
 * 放进沙箱，用最小的 DOM 桩执行，验证 2.39.1 的防御口径：
 * 分类/账户自动归位（pickCategoryId / pickAccountId）抛错时退回手选，
 * 预览弹层照常打开，不再让整块导入崩掉；正常归位、缺函数兜底、单号判重不回退。
 * 运行：node tests/bill-import-preview.test.js（scripts/test.js 自动收集）。只读业务代码。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let passCount = 0;
let failCount = 0;

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
  if (actual !== expected) { throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); }
}

/* ---------------- 装配：从 settings.js 切出预览代码 ---------------- */

const SETTINGS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'settings.js'), 'utf8');
const START = SETTINGS.indexOf('  function billSourceLabel(');
const END = SETTINGS.indexOf('  function runBillImport(');
check(START > 0 && END > START && SETTINGS.indexOf('  function previewBillImport(') > START, 'settings.js 里找不到预览代码边界');

function fakeEl(tag, attrs) {
  return {
    tag,
    attrs: attrs || {},
    children: [],
    textContent: (attrs && attrs.text) || '',
    checked: false,
    appendChild(node) { this.children.push(node); return node; },
    addEventListener() {}
  };
}

function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
}

function findAll(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) { out.push(n); } });
  return out;
}

/* bill 模块桩：parse 恒成功；pick 行为按用例注入 */
function build(opts) {
  const opened = [];
  const toasts = [];
  const statRows = [];
  const bill = {
    parse() {
      return {
        ok: true,
        source: 'generic',
        rows: opts.rows,
        skipped: [],
        warnings: []
      };
    }
  };
  if (opts.pickCat !== undefined) { bill.pickCategoryId = opts.pickCat; }
  if (opts.pickAcc !== undefined) { bill.pickAccountId = opts.pickAcc; }
  const db = {
    accounts: opts.accounts === undefined ? [{ id: 'ac1', archived: false }] : opts.accounts,
    categories: [{ id: 'ca_food', kind: 'expense' }],
    transactions: opts.existing || []
  };
  const sandbox = {
    console,
    XZB: { ui: { sheet: { open(o) { opened.push(o); return {}; } } } },
    coreMod(name) { return name === 'billImport' ? bill : null; },
    dbOf() { return db; },
    listOf(d, key) { return d[key] || []; },
    prefsGet() { return null; },
    toast(ctx, msg, o) { toasts.push({ msg, type: o && o.type }); },
    h(tag, attrs) { return fakeEl(tag, attrs); },
    noteBlock(text, cls) { return fakeEl('p', { text, className: cls }); },
    fmtBytes() { return '1.0 KB'; },
    row(o) { statRows.push(o); return fakeEl('div', { rowTitle: o.title }); },
    runBillImport() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(SETTINGS.slice(START, END), sandbox, { filename: 'settings.js#billPreview' });
  return { sandbox, opened, toasts, statRows };
}

function row0(extra) {
  return Object.assign({
    date: '2026-11-20', type: 'expense', amountCents: 1500,
    category: '餐饮', accountName: '微信', note: '', refNo: ''
  }, extra || {});
}

const TWO_ROWS = [row0(), row0({ date: '2026-11-21', amountCents: 2800, refNo: 'R2' })];

function statOf(statRows, title) {
  const hit = statRows.filter((r) => r.title === title);
  return hit.length ? hit[0].value : null;
}

/* ============================== 用例 ============================== */

console.log('\n===== 用例 1：归位异常防御（2.39.1 修复点） =====');

test('1.1 归位抛错：预览照常打开，两笔退回手选、默认全勾选，不弹错误提示', function () {
  const b = build({
    rows: TWO_ROWS,
    pickCat() { throw new Error('分类表结构异常'); },
    pickAcc() { throw new Error('账户表结构异常'); }
  });
  b.sandbox.previewBillImport({}, 'csv 文本', 'bill.csv', 1024);
  checkEq(b.opened.length, 1, '预览弹层应照常打开');
  checkEq(b.opened[0].title, '从CSV 账单导入', '弹层标题');
  checkEq(statOf(b.statRows, '分类'), '0 / 2 笔', '归位失败应计 0');
  checkEq(b.toasts.filter((t) => t.type === 'danger').length, 0, '不应弹 danger 提示');
  const boxes = findAll(b.opened[0].content, (n) => n.tag === 'input');
  checkEq(boxes.length, 2, '两笔各一个勾选框');
  check(boxes.every((x) => x.checked === true), '退回手选后默认全勾选');
  const sum = findAll(b.opened[0].content, (n) => n.attrs.className === 's-settings-bill__sum');
  checkEq(sum.length, 1, '汇总行');
  checkEq(sum[0].textContent, '2 笔', '将导入 2 笔');
});

test('1.2 只有分类归位抛错：账户归位不受牵连（同一 try 内整体退回手选）', function () {
  const b = build({
    rows: TWO_ROWS,
    pickCat() { throw new Error('boom'); },
    pickAcc() { return 'ac1'; }
  });
  b.sandbox.previewBillImport({}, 'csv 文本', '', 0);
  checkEq(b.opened.length, 1, '预览弹层应照常打开');
  /* 口径：try 块整体兜底，分类抛错时账户也退回手选，保证预览行字段一致 */
  checkEq(statOf(b.statRows, '分类'), '0 / 2 笔', '分类计 0');
  checkEq(statOf(b.statRows, '账户'), null, '账户计 0 时不出账户行');
});

console.log('\n===== 用例 2：正常链路不回退 =====');

test('2.1 正常归位：分类/账户计数照旧，预览行勾选不受影响', function () {
  const b = build({
    rows: TWO_ROWS,
    pickCat() { return 'ca_food'; },
    pickAcc() { return 'ac1'; }
  });
  b.sandbox.previewBillImport({}, 'csv 文本', '', 0);
  checkEq(b.opened.length, 1, '预览弹层');
  checkEq(statOf(b.statRows, '分类'), '2 / 2 笔', '分类全认到');
  checkEq(statOf(b.statRows, '账户'), '2 笔按名称', '账户全认到');
  const boxes = findAll(b.opened[0].content, (n) => n.tag === 'input');
  check(boxes.every((x) => x.checked === true), '非重复默认勾选');
});

test('2.2 组件缺 pick 函数：兜底为空串，预览照常（旧版本组件兼容）', function () {
  const b = build({ rows: TWO_ROWS }); /* 不注入 pickCategoryId / pickAccountId */
  b.sandbox.previewBillImport({}, 'csv 文本', '', 0);
  checkEq(b.opened.length, 1, '预览弹层应照常打开');
  checkEq(statOf(b.statRows, '分类'), '0 / 2 笔', '缺函数计 0');
});

console.log('\n===== 用例 3：判重与前置守卫 =====');

test('3.1 单号判重：重复行标疑似重复、默认不勾选，汇总只算勾选笔数', function () {
  const b = build({
    rows: [row0({ refNo: 'R1' }), row0({ date: '2026-11-21', amountCents: 2800, refNo: 'R2' })],
    existing: [{ id: 't1', importRef: 'R1', amountCents: 1500, date: '2026-11-20', deleted: false }],
    pickCat() { return 'ca_food'; },
    pickAcc() { return 'ac1'; }
  });
  b.sandbox.previewBillImport({}, 'csv 文本', '', 0);
  checkEq(b.opened.length, 1, '预览弹层');
  check(String(statOf(b.statRows, '解析结果')).indexOf('疑似重复 1') >= 0, '解析结果应报疑似重复 1');
  const labels = findAll(b.opened[0].content, (n) => n.tag === 'label');
  checkEq(labels.length, 2, '两行');
  check(String(labels[0].attrs.className).indexOf('s-settings-bill__row--dupe') >= 0, '第一行标重复样式');
  const boxes = findAll(b.opened[0].content, (n) => n.tag === 'input');
  checkEq(boxes[0].checked, false, '重复行默认不勾选');
  checkEq(boxes[1].checked, true, '正常行默认勾选');
  const sum = findAll(b.opened[0].content, (n) => n.attrs.className === 's-settings-bill__sum');
  checkEq(sum[0].textContent, '1 笔', '将导入只算勾选的 1 笔');
});

test('3.2 没有账户：提示先去加账户，不打开预览弹层', function () {
  const b = build({ rows: TWO_ROWS, accounts: [], pickCat() { return 'ca_food'; } });
  b.sandbox.previewBillImport({}, 'csv 文本', '', 0);
  checkEq(b.opened.length, 0, '不应打开弹层');
  checkEq(b.toasts.length, 1, '一条提示');
  check(b.toasts[0].msg.indexOf('还没有账户') >= 0, '提示文案：' + b.toasts[0].msg);
});

/* ---------------- 汇总 ---------------- */

console.log('\n通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) { process.exit(1); }