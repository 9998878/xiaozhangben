'use strict';
/*
 * tests/inline-edit.test.js
 * 自检脚本：2.42.0「流水行行内编辑」——js/modules/inline-edit.js 的纯函数与接线断言。
 *
 * 运行：node tests/inline-edit.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：inline-edit.js 为 IIFE，Node 下走 global 分支挂 XZB.Core.inlineEdit /
 * XZB.ui.inlineEdit，整文件读进 vm 沙箱真实执行（不是复写实现）。沙箱无 document，
 * 顺带验证 DOM 件在无浏览器环境恒返回 null、不抛错。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'inline-edit.js'), 'utf8');
const LEDGER_SRC = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'ledger.js'), 'utf8');
const ADD_SRC = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'add.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

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

/* ============================== 沙箱 ============================== */

const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'js/modules/inline-edit.js' });
const IE = sandbox.XZB.Core.inlineEdit;
if (!IE || typeof IE.parseAmountText !== 'function') {
  throw new Error('XZB.Core.inlineEdit 不可用');
}

/* ============================== 1 金额解析 ============================== */

section('1 金额解析（整数分）');

test('1.1 常规两位小数', () => {
  checkEq(IE.parseAmountText('13.90').cents, 1390, '13.90');
  checkEq(IE.parseAmountText('0.32').cents, 32, '0.32');
  checkEq(IE.parseAmountText('20').cents, 2000, '20');
});

test('1.2 首尾空白容忍', () => {
  checkEq(IE.parseAmountText(' 3.32 ').cents, 332, 'trim');
});

test('1.3 一位小数补零', () => {
  checkEq(IE.parseAmountText('128.5').cents, 12850, '128.5');
});

test('1.4 上界：9 位整数元 + 2 位小数', () => {
  checkEq(IE.parseAmountText('999999999.99').cents, 99999999999, '上界');
  checkEq(IE.parseAmountText('1000000000').ok, false, '超上界拒绝');
  checkEq(IE.parseAmountText('1234567890').ok, false, '10 位整数拒绝');
});

test('1.5 非法输入一律拒绝', () => {
  ['', '0', '0.00', '-5', 'abc', '12.345', '1,000', '12.', '.5', '1e3'].forEach((bad) => {
    checkEq(IE.parseAmountText(bad).ok, false, '拒绝 ' + JSON.stringify(bad));
    checkEq(IE.parseAmountText(bad).code, 'E_AMOUNT_INVALID', '错误码 ' + JSON.stringify(bad));
  });
});

/* ============================== 2 日期 / 时间 / 批注 ============================== */

section('2 日期 / 时间 / 批注校验');

test('2.1 合法日期', () => {
  check(IE.isValidDateStr('2026-11-25'), '2026-11-25');
  check(IE.isValidDateStr('2024-02-29'), '闰年 2024-02-29');
});

test('2.2 非法日期', () => {
  ['2026-02-30', '2026-13-01', '2026-1-01', '2026-02-29', '20261125', '', '2026-00-10'].forEach((bad) => {
    check(!IE.isValidDateStr(bad), '拒绝 ' + JSON.stringify(bad));
  });
});

test('2.3 时间 HH:MM 24 小时制', () => {
  check(IE.isValidTimeStr('11:37'), '11:37');
  check(IE.isValidTimeStr('23:34'), '23:34');
  check(IE.isValidTimeStr('00:00'), '00:00');
  ['24:00', '9:00', '12:60', '12:5', '', '12:00:00'].forEach((bad) => {
    check(!IE.isValidTimeStr(bad), '拒绝 ' + JSON.stringify(bad));
  });
});

test('2.4 批注 trim + 30 字截断', () => {
  checkEq(IE.normalizeNote('  午餐·牛肉面  '), '午餐·牛肉面', 'trim');
  checkEq(IE.normalizeNote(null), '', 'null');
  checkEq(IE.normalizeNote(undefined), '', 'undefined');
  checkEq(IE.normalizeNote('x'.repeat(40)).length, 30, '截断 30');
});

/* ============================== 3 validatePatch ============================== */

section('3 validatePatch 只收目标字段');

test('3.1 批注归一化进 patch', () => {
  const r = IE.validatePatch({ note: ' 资料 ' });
  check(r.ok, 'ok');
  checkEq(r.patch.note, '资料', 'note');
  checkEq(Object.keys(r.patch).length, 1, '只一个键');
});

test('3.2 amountText 与 amountCents 二选一', () => {
  checkEq(IE.validatePatch({ amountText: '20' }).patch.amountCents, 2000, 'text');
  checkEq(IE.validatePatch({ amountCents: 32 }).patch.amountCents, 32, 'cents');
  checkEq(IE.validatePatch({ amountCents: 0 }).ok, false, '0 拒绝');
  checkEq(IE.validatePatch({ amountCents: 1.5 }).ok, false, '非整数拒绝');
});

test('3.3 日期/时间非法给对应错误码', () => {
  checkEq(IE.validatePatch({ date: '2026-02-30' }).code, 'E_TX_DATE', 'date');
  checkEq(IE.validatePatch({ time: '24:00' }).code, 'E_TX_TIME', 'time');
});

test('3.4 空 patch / 空 categoryId 拒绝', () => {
  checkEq(IE.validatePatch({}).code, 'E_PATCH_EMPTY', '空');
  checkEq(IE.validatePatch({ categoryId: '' }).ok, false, '空 categoryId');
});

test('3.5 多键组合只保留出现的键', () => {
  const r = IE.validatePatch({ date: '2026-11-24', time: '09:12' });
  check(r.ok, 'ok');
  checkEq(Object.keys(r.patch).sort().join(), 'date,time', '键集合');
});

/* ============================== 4 commit mutator ============================== */

section('4 buildTxPatchMutator（与 doDelete 同款形态）');

function fakeDb() {
  return {
    transactions: [
      { id: 't1', type: 'expense', categoryId: 'c1', amountCents: 1390, note: '', date: '2026-11-25', time: '11:37', photoIds: ['p1'] },
      { id: 't2', type: 'expense', categoryId: 'c2', amountCents: 30, note: '资料', date: '2026-11-25', time: '10:24' }
    ]
  };
}

test('4.1 只改目标字段，其余原样保留', () => {
  const db = fakeDb();
  const mutator = IE.buildTxPatchMutator('t1', { amountCents: 2000 }, 'NOW');
  const r = mutator(db);
  checkEq(r.value.id, 't1', 'value.id');
  checkEq(db.transactions[0].amountCents, 2000, '金额');
  checkEq(db.transactions[0].note, '', '批注不动');
  checkEq(db.transactions[0].categoryId, 'c1', '分类不动');
  checkEq(db.transactions[0].photoIds.join(), 'p1', '照片引用不动');
  checkEq(db.transactions[0].updatedAt, 'NOW', 'updatedAt');
  checkEq(db.transactions[1].amountCents, 30, '别行不动');
});

test('4.2 多键 patch 一次落齐', () => {
  const db = fakeDb();
  IE.buildTxPatchMutator('t1', { date: '2026-11-24', time: '09:12', note: 'x' }, 'NOW')(db);
  checkEq(db.transactions[0].date, '2026-11-24', 'date');
  checkEq(db.transactions[0].time, '09:12', 'time');
  checkEq(db.transactions[0].note, 'x', 'note');
});

test('4.3 找不到 / 已软删 / 无表恒 abort', () => {
  checkEq(IE.buildTxPatchMutator('nope', { note: 'x' }, 'NOW')(fakeDb()).code, 'E_TX_NOT_FOUND', '缺失');
  const db = fakeDb();
  db.transactions[0].deleted = true;
  checkEq(IE.buildTxPatchMutator('t1', { note: 'x' }, 'NOW')(db).code, 'E_TX_NOT_FOUND', '软删');
  checkEq(IE.buildTxPatchMutator('t1', { note: 'x' }, 'NOW')({}).code, 'E_STORE_TX', '无表');
});

test('4.4 normalize 钩子被调用且接管写回', () => {
  const db = fakeDb();
  let seen = null;
  const normalize = (next, nowIso) => { seen = { next: next, nowIso: nowIso }; return Object.assign({ normalized: true }, next); };
  IE.buildTxPatchMutator('t1', { note: 'y' }, 'NOW', normalize)(db);
  check(seen && seen.nowIso === 'NOW', 'normalize 收到 nowIso');
  checkEq(seen.next.note, 'y', 'normalize 收到 patch 后字段');
  checkEq(db.transactions[0].normalized, true, '写回 normalize 结果');
});

/* ============================== 5 分类过滤 ============================== */

section('5 categoriesForKind');

test('5.1 同 kind 且未软删', () => {
  const list = [
    { id: 'a', kind: 'expense', name: '餐饮' },
    { id: 'b', kind: 'income', name: '工资' },
    { id: 'c', kind: 'expense', name: '已删', deleted: true },
    null
  ];
  const ex = IE.categoriesForKind(list, 'expense');
  checkEq(ex.length, 1, '支出只剩 a');
  checkEq(ex[0].id, 'a', 'a');
  checkEq(IE.categoriesForKind(list, 'income')[0].id, 'b', '收入 b');
  checkEq(IE.categoriesForKind(null, 'expense').length, 0, 'null 安全');
});

/* ============================== 6 Node 无 DOM 安全 ============================== */

section('6 无 document 环境 DOM 件恒 null');

test('6.1 浮层/输入件不抛错', () => {
  const DOM = sandbox.XZB.ui.inlineEdit;
  checkEq(DOM.openPopover({}, 320, () => {}), null, 'openPopover');
  checkEq(DOM.mountNoteInput({}, '', {}), null, 'mountNoteInput');
  checkEq(DOM.mountAmountInput({}, 0, '-¥', {}), null, 'mountAmountInput');
  DOM.closePopover();
  DOM.flashRow(null);
});

/* ============================== 7 接线断言 ============================== */

section('7 接线：ledger / manifest / sw / 声明标签');

test('7.1 ledger 四热区与唯一写通道', () => {
  ['s-ledger-item__zone--media', 's-ledger-item__zone--text', 's-ledger-item__zone--amount', 's-ledger-item__zone--time'].forEach((cls) => {
    check(LEDGER_SRC.indexOf(cls) >= 0, 'ledger 缺 ' + cls);
  });
  check(LEDGER_SRC.indexOf('IE.buildTxPatchMutator') >= 0, 'mutator 接线');
  check(LEDGER_SRC.indexOf("commit(mutator, { label: '行内编辑' })") >= 0, 'commit 通道');
  check(LEDGER_SRC.indexOf('function openCatZone') >= 0, 'openCatZone');
  check(/function openCatZone\(st, tx\) \{\s*navigate\(st, '#\/add\?id=' \+ encodeURIComponent\(String\(tx\.id \|\| ''\)\) \+ '&pick=cat'/.test(LEDGER_SRC), '图标热区跳记一笔页 pick=cat');
  check(LEDGER_SRC.indexOf('IE.openPopover(anchor, 320') < 0, '种类宫格浮层已移除');
  check(ADD_SRC.indexOf("String(context.params.pick || '') === 'cat'") >= 0, 'add 识别 pick=cat');
  check(ADD_SRC.indexOf('if (pickCat) {') >= 0 && ADD_SRC.indexOf('pickSaveName = String(category.name') >= 0, '选分类即保存');
  check(ADD_SRC.indexOf("showToast('种类已改为「' + pickSaveName + '」'") >= 0, '直选成功文案');
  check(LEDGER_SRC.indexOf('function openTimeZone') >= 0, 'openTimeZone');
});

test('7.2 manifest / deps / 声明标签 / sw 预缓存', () => {
  check(INDEX_HTML.indexOf("['inline-edit', 'modules/inline-edit', 'modules/inline-edit']") >= 0, 'manifest ROWS');
  check(INDEX_HTML.indexOf("ledger: ['inline-edit']") >= 0, 'deps ledger');
  check(INDEX_HTML.indexOf('<script type="text/xzb-module" data-xzb-chunk="inline-edit" src="js/modules/inline-edit.js"></script>') >= 0, '声明标签');
  check(SW_JS.indexOf("'./js/modules/inline-edit.js'") >= 0, 'sw PRECACHE');
});

test('7.3 CSS 封闭集合新增类都在 index.html', () => {
  ['.s-ledger-item__zone', '.s-ledger-item__note-input', '.s-ledger-item__amount-wrap', '.s-ledger-pop', '.s-ledger-item.is-flash'].forEach((sel) => {
    check(INDEX_HTML.indexOf(sel) >= 0, 'CSS 缺 ' + sel);
  });
});

/* ============================== 汇总 ============================== */

console.log('\n通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) { process.exit(1); }