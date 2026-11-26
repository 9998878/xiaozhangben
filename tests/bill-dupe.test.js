'use strict';
/*
 * tests/bill-dupe.test.js
 * 2.44.1「账单去重收紧」行为回归（验收报告 P2-4）。
 *
 * 运行：node tests/bill-dupe.test.js（scripts/test.js 自动收集）
 *
 * 做法：按仓库 liftFunction 范式从 js/screens/settings.js 提升 billDupeOf 真实实现
 * 进 vm 真跑（不复写实现）。锁住：无单号时「同日+同额+同方向+(同非空备注或同分类)」
 * 才判疑似；±3 天宽窗口已删；双时间不同不判重；单号路径不变。
 * 只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'settings.js'), 'utf8');

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

/* ============================== 提升真实实现 ============================== */

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

const lifted = liftFunction(SRC, 'billDupeOf');
if (!lifted) { throw new Error('settings.js 中提取不到 billDupeOf'); }
const sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(lifted + '\nglobalThis.__dupe = billDupeOf;', sandbox, { filename: 'lift:billDupeOf' });
const dupe = sandbox.__dupe;

/* ============================== fixture ============================== */

function row(over) {
  return Object.assign({
    date: '2026-11-20', time: '08:00', type: 'expense', amountCents: 200,
    note: '公交', category: '交通', refNo: ''
  }, over || {});
}

function ex(over) {
  return Object.assign({
    date: '2026-11-20', time: '08:00', type: 'expense', amountCents: 200,
    note: '公交', categoryId: 'ca_bus'
  }, over || {});
}

/* ============================== 用例 ============================== */

section('1 单号路径不变');

test('1.1 有单号只认单号：命中判重、未命中不判重', function () {
  checkEq(dupe(row({ refNo: 'R1' }), [ex({ note: '完全不同', date: '2026-11-01' })], { R1: true }, ''), true, '单号命中');
  checkEq(dupe(row({ refNo: 'R2' }), [ex()], {}, ''), false, '单号未命中即不判重');
});

section('2 无单号：收紧后的判重口径');

test('2.1 同日同额同方向同备注 → 判重', function () {
  checkEq(dupe(row(), [ex()], {}, ''), true, '真重复应判重');
});

test('2.2 同日同额不同备注、无分类归位 → 不判重（一天两笔 2 元公交）', function () {
  checkEq(dupe(row({ note: '公交去程' }), [ex({ note: '公交回程' })], {}, ''), false, '两笔真账不应误判');
  checkEq(dupe(row({ note: '' }), [ex({ note: '' })], {}, ''), false, '双空备注无分类不判重');
});

test('2.3 同日同额同分类（归位后）不同备注 → 判重', function () {
  checkEq(dupe(row({ note: '咖啡A' }), [ex({ note: '咖啡B', categoryId: 'ca_coffee' })], {}, 'ca_coffee'), true, '同分类口径');
  checkEq(dupe(row({ note: '咖啡A' }), [ex({ note: '咖啡B', categoryId: 'ca_other' })], {}, 'ca_coffee'), false, '分类不同不判重');
});

test('2.4 ±3 天宽窗口已删：隔日同额同备注不再判重（连续三天同价咖啡）', function () {
  checkEq(dupe(row(), [ex({ date: '2026-11-19' })], {}, ''), false, '前一天');
  checkEq(dupe(row(), [ex({ date: '2026-11-22' })], {}, ''), false, '后两天');
});

test('2.5 双方时间均非空且不同 → 不判重；一方缺时间仍按备注判', function () {
  checkEq(dupe(row({ time: '08:00' }), [ex({ time: '18:00' })], {}, ''), false, '早晚两笔同备注真账');
  checkEq(dupe(row({ time: '' }), [ex({ time: '18:00' })], {}, ''), true, '行缺时间仍按备注');
  checkEq(dupe(row({ time: '08:00' }), [ex({ time: '' })], {}, ''), true, '库缺时间仍按备注');
});

test('2.6 方向不同不判重；软删行不参与', function () {
  checkEq(dupe(row({ type: 'income' }), [ex({ type: 'expense' })], {}, ''), false, '收支不同');
  checkEq(dupe(row(), [ex({ deleted: true })], {}, ''), false, '软删行跳过');
});

test('2.7 金额不同不判重', function () {
  checkEq(dupe(row({ amountCents: 200 }), [ex({ amountCents: 300 })], {}, ''), false, '金额不同');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);