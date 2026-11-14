'use strict';
/*
 * tests/stats-mom.test.js
 * 自检脚本：2.33.0「上月同期」环比口径——核心统计层（index.html 内联 js/core/stats.js）。
 *
 * 口径契约：
 *   - mom()：查看当前月且未过完时（isPartial），基期 = 上月同日（夹到上月月末），
 *     不再拿本月已过天数对上月整月；过去月两侧都是整月，行为不变；
 *     月末当天视为整月；o.today 可显式传入便于测试。
 *   - categorySums/categoryRank：opts.endDay 可把区间截止日向前夹（stats 页拉上月同期榜用）。
 *   - rankByCategory（withMom）：opts.today 显式传入时，环比基期自动裁到上月同日；
 *     prev=0 时 deltaPct=null（「新增」语义，绝不出 Infinity/NaN）。
 *
 * 运行：node tests/stats-mom.test.js（scripts/test.js 自动收集）
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

/* ============================== 沙箱装配（同 exclude-stats 范式） ============================== */

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const BLOCKS = ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/stats.js'];
const sandbox = { console: console };
vm.createContext(sandbox);
for (const marker of BLOCKS) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker.replace('js/core/', 'inline:') });
}
const statsApi = sandbox.XZB.Core.stats;
if (!statsApi || typeof statsApi.mom !== 'function' || typeof statsApi.categoryRank !== 'function') {
  throw new Error('XZB.Core.stats 不可用');
}

/* ============================== 固定数据 ============================== */

const BK = 'bk1';

function baseModel() {
  return {
    books: [{ id: BK, name: '日常', kind: 'daily', archived: false }],
    accounts: [{ id: 'ac1', name: '微信', type: 'wechat' }],
    categories: [{ id: 'ca_food', kind: 'expense', name: '餐饮' }],
    transactions: [],
    budgets: [],
    categoryBudgets: []
  };
}

function tx(id, date, cents, opts) {
  return Object.assign({
    id: id,
    bookId: BK,
    type: 'expense',
    amountCents: cents,
    accountId: 'ac1',
    toAccountId: null,
    categoryId: 'ca_food',
    date: date,
    time: '12:00',
    note: '',
    tags: [],
    photoIds: [],
    source: 'manual',
    deleted: false,
    excludeStats: false
  }, opts || {});
}

/* 10 月上旬 1000 + 10 月下旬 500 + 11 月 300：月中基期只该看到 1000 */
function midMonthModel() {
  const model = baseModel();
  model.transactions.push(tx('a1', '2026-10-05', 100000));
  model.transactions.push(tx('a2', '2026-10-20', 50000));
  model.transactions.push(tx('b1', '2026-11-03', 30000));
  return model;
}

/* ============================== 用例 ============================== */

section('用例 1：月中 mom = 上月同期（11-14 看 11 月，基期 = 10 月 1-14 日）');

test('1.1 基期裁到上月同日，isPartial/periodDay 正确', function () {
  const r = statsApi.mom(midMonthModel(), '2026-11', { bookId: BK, today: '2026-11-14' });
  checkEq(r.expense.current, 30000, '本月侧金额（不裁剪）');
  checkEq(r.expense.prev, 100000, '基期只含 10 月 1-14 日（10-20 的 500 不计）');
  checkEq(r.expense.deltaPct, -70, '环比按同期算');
  checkEq(r.isPartial, true, 'isPartial');
  checkEq(r.periodDay, 14, 'periodDay = 上月截止日');
  checkEq(r.prevMonth, '2026-10', 'prevMonth');
});

section('用例 2：过去月 mom = 整月对整月（行为不变）');

test('2.1 10 月看 10 月，基期 = 9 月整月', function () {
  const model = midMonthModel();
  model.transactions.push(tx('c1', '2026-09-12', 200000));
  const r = statsApi.mom(model, '2026-10', { bookId: BK, today: '2026-11-14' });
  checkEq(r.expense.current, 150000, '10 月整月');
  checkEq(r.expense.prev, 200000, '9 月整月');
  checkEq(r.expense.deltaPct, -25, '整月环比');
  checkEq(r.isPartial, false, '过去月不标记 partial');
  checkEq(r.periodDay, 0, 'periodDay');
});

section('用例 3：上月更短时夹到上月月末');

test('3.1 3 月 30 日看 3 月，基期裁到 2-28', function () {
  const model = baseModel();
  model.transactions.push(tx('d1', '2026-02-28', 10000));
  model.transactions.push(tx('d2', '2026-03-05', 5000));
  model.transactions.push(tx('d3', '2026-03-30', 40000));
  const r = statsApi.mom(model, '2026-03', { bookId: BK, today: '2026-03-30' });
  checkEq(r.expense.current, 45000, '本月侧到今天');
  checkEq(r.expense.prev, 10000, '基期 = 2 月整月（同日 30 夹到月末 28）');
  checkEq(r.isPartial, true, 'isPartial');
  checkEq(r.periodDay, 28, 'periodDay 夹到上月月末');
});

test('3.2 月末当天视为整月，不标 partial', function () {
  const r = statsApi.mom(midMonthModel(), '2026-11', { bookId: BK, today: '2026-11-30' });
  checkEq(r.isPartial, false, '月末当天 = 整月口径');
  checkEq(r.expense.prev, 150000, '基期 = 10 月整月');
});

section('用例 4：categoryRank 的 endDay 裁剪');

test('4.1 endDay 截止后的排行只含截止前流水', function () {
  const rank = statsApi.categoryRank(midMonthModel(), '2026-10', {
    kind: 'expense', limit: 10, bookId: BK, endDay: '2026-10-14'
  });
  checkEq(rank.totalCents, 100000, '只含 10-05 的 1000');
  checkEq(rank.items.length, 1, '一个分类');
  checkEq(rank.items[0].amountCents, 100000, '金额');
});

test('4.2 无 endDay 保持整月；endDay 晚于月末不裁剪', function () {
  const full = statsApi.categoryRank(midMonthModel(), '2026-10', { kind: 'expense', limit: 10, bookId: BK });
  checkEq(full.totalCents, 150000, '整月口径不变');
  const loose = statsApi.categoryRank(midMonthModel(), '2026-10', {
    kind: 'expense', limit: 10, bookId: BK, endDay: '2026-10-31'
  });
  checkEq(loose.totalCents, 150000, 'endDay 超出月末时按整月');
});

section('用例 5：rankByCategory 显式 today → 环比基期自动同期');

test('5.1 月中查看：prevCents 只含上月同期', function () {
  const r = statsApi.rankByCategory(midMonthModel(), {
    month: '2026-11', type: 'expense', bookId: BK, today: '2026-11-14'
  });
  checkEq(r.items.length, 1, '一个分类');
  checkEq(r.items[0].amountCents, 30000, '本月金额');
  checkEq(r.items[0].prevCents, 100000, '基期 = 上月同期');
  checkEq(r.items[0].deltaPct, -70, '同期环比');
});

test('5.2 过去月查看：prevCents = 上月整月（行为不变）', function () {
  const model = midMonthModel();
  model.transactions.push(tx('c1', '2026-09-12', 200000));
  const r = statsApi.rankByCategory(model, {
    month: '2026-10', type: 'expense', bookId: BK, today: '2026-11-14'
  });
  checkEq(r.items[0].amountCents, 150000, '10 月整月');
  checkEq(r.items[0].prevCents, 200000, '9 月整月');
  checkEq(r.items[0].deltaPct, -25, '整月环比');
});

section('用例 6：prev=0 → deltaPct=null（新增语义，绝不出 NaN/Infinity）');

test('6.1 基期无流水', function () {
  const model = baseModel();
  model.transactions.push(tx('b1', '2026-11-03', 30000));
  const m = statsApi.mom(model, '2026-11', { bookId: BK, today: '2026-11-14' });
  checkEq(m.expense.prev, 0, '基期 0');
  checkEq(m.expense.deltaPct, null, 'deltaPct null');
  checkEq(m.expense.deltaCents, 30000, 'deltaCents 正常');
  const r = statsApi.rankByCategory(model, {
    month: '2026-11', type: 'expense', bookId: BK, today: '2026-11-14'
  });
  checkEq(r.items[0].prevCents, 0, 'prevCents 0');
  checkEq(r.items[0].deltaPct, null, '分类环比 deltaPct null');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
