'use strict';
/*
 * tests/budget-carryover.test.js
 * 自检脚本：2.28.9「分类预算结转」——normalizeCategoryBudget + budgetProgress 的
 * carryover / availableCents 口径（只滚结余；总预算不结转）。
 * 来源：Actual Budget envelope leftover 公式 / Firefly III ROLLOVER（竞品吸收批次一 D）。
 *
 * 运行：node tests/budget-carryover.test.js（scripts/test.js 自动收集）
 *
 * 提取方式：与 category-expansion.test.js 同款——index.html 内联块（money/dates/schema/stats）
 * 按"块头注释里的文件名锚点"提取进 vm 沙箱真实执行，从 XZB.Core.* 取 API。
 *
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

/* ============================== 沙箱装配 ============================== */

/* 从块头注释里的文件名锚点识别内联块。 */
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
const schema = sandbox.XZB.Core.schema;
if (!statsApi || typeof statsApi.budgetProgress !== 'function') {
  throw new Error('XZB.Core.stats.budgetProgress 不可用（stats 块加载失败？）');
}
if (!schema || typeof schema.normalizeCategoryBudget !== 'function') {
  throw new Error('XZB.Core.schema.normalizeCategoryBudget 不可用（schema 块加载失败？）');
}

/* ============================== 固定数据 ============================== */

const BK = 'bk1';
const M = '2026-11';       // 本月
const PREV = '2026-10';    // 上月
const CA_FOOD = 'ca_food';
const CA_BUS = 'ca_bus';

function emptyModel() {
  return {
    books: [{ id: BK, name: '日常', kind: 'daily', archived: false }],
    accounts: [{ id: 'ac1', name: '微信', type: 'wechat' }],
    categories: [
      { id: CA_FOOD, kind: 'expense', name: '餐饮' },
      { id: CA_BUS, kind: 'expense', name: '交通' }
    ],
    transactions: [],
    budgets: [],
    categoryBudgets: []
  };
}

function tx(id, month, day, categoryId, cents) {
  return {
    id: id,
    bookId: BK,
    type: 'expense',
    amountCents: cents,
    accountId: 'ac1',
    toAccountId: null,
    categoryId: categoryId,
    date: month + '-' + day,
    time: '12:00',
    note: '',
    tags: [],
    photoIds: [],
    source: 'manual',
    deleted: false
  };
}

function cb(categoryId, month, cents, carryover) {
  return {
    id: 'cb_' + categoryId + '_' + month,
    bookId: BK,
    month: month,
    categoryId: categoryId,
    amountCents: cents,
    thresholdPct: 80,
    carryover: carryover === undefined ? false : !!carryover
  };
}

/* ============================== 用例 ============================== */

section('用例 1：结转生效（只滚结余）');
test('1.1 上月剩 20 → available = limit + 20，pct 按可用额度', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 80000));   // 上月支出 80，剩 20
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 90000));      // 本月支出 90
  const p = statsApi.budgetProgress(model, M, { bookId: BK });
  const item = p.items.find((it) => it.categoryId === CA_FOOD);
  check(item, 'items 里应有 ca_food');
  checkEq(item.limitCents, 100000, 'limitCents=本月分配');
  checkEq(item.carryoverCents, 20000, 'carryoverCents=上月剩余');
  checkEq(item.availableCents, 120000, 'availableCents=分配+结转');
  checkEq(item.pct, 75, 'pct=spent/available');
  checkEq(item.state, 'safe', '90/100 的旧口径会 warn，新口径 75% 为 safe');
});

test('1.2 上月超支 → 负数不滚（carryover 0）', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 120000));  // 上月超支
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 50000));
  const item = statsApi.budgetProgress(model, M, { bookId: BK }).items.find((it) => it.categoryId === CA_FOOD);
  checkEq(item.carryoverCents, 0, '超支不追');
  checkEq(item.availableCents, 100000, 'available=分配');
});

test('1.3 上月无该分类预算行 → 不结转', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 50000));
  const item = statsApi.budgetProgress(model, M, { bookId: BK }).items.find((it) => it.categoryId === CA_FOOD);
  checkEq(item.carryoverCents, 0, '上月无预算行');
  checkEq(item.availableCents, 100000, 'available=分配');
});

section('用例 2：开关关闭 → 一切如旧');
test('2.1 carryover=false（缺省）时上月有剩余也不结转', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, false));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, false));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 80000));
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 90000));
  const item = statsApi.budgetProgress(model, M, { bookId: BK }).items.find((it) => it.categoryId === CA_FOOD);
  checkEq(item.carryoverCents, 0, '关闭不结转');
  checkEq(item.availableCents, 100000, 'available=分配');
  checkEq(item.pct, 90, 'pct 回到旧口径（spent/limit）');
});

section('用例 3：状态判定按可用额度');
test('3.1 spent 超 limit 但未超 available → warn 不是 over', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 80000));
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 110000));     // 超 limit 10，未超 available
  const item = statsApi.budgetProgress(model, M, { bookId: BK }).items.find((it) => it.categoryId === CA_FOOD);
  checkEq(item.availableCents, 120000, 'available=120');
  checkEq(item.state, 'warn', '92% → warn');
});

test('3.2 spent 超 available → over', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 80000));
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 130000));
  const item = statsApi.budgetProgress(model, M, { bookId: BK }).items.find((it) => it.categoryId === CA_FOOD);
  checkEq(item.state, 'over', '108% → over');
});

section('用例 4：总预算不结转');
test('4.1 totalCents/spentCents 不受分类结转影响', function () {
  const model = emptyModel();
  model.budgets.push({ id: 'b1', bookId: BK, month: M, totalCents: 200000 });
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 80000));
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 90000));
  const p = statsApi.budgetProgress(model, M, { bookId: BK });
  checkEq(p.totalCents, 200000, '总预算不滚');
  checkEq(p.spentCents, 90000, '总支出只算本月');
});

section('用例 5：schema 白名单（toBool 全局宽容语义：true/false/1/0/"1"/"0"/"yes"/"no"）');
test('5.1 normalizeCategoryBudget：缺省 false / 真值语义 / 假值语义', function () {
  const now = '2026-11-08T00:00:00.000Z';
  const base = { id: 'cb_x', bookId: BK, month: M, categoryId: CA_FOOD, amountCents: 100000 };
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base), now).carryover, false, '缺省 → false');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: true }), now).carryover, true, 'true → true');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: false }), now).carryover, false, 'false → false');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: 'yes' }), now).carryover, true, '"yes" → true（toBool 语义）');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: 'no' }), now).carryover, false, '"no" → false');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: 1 }), now).carryover, true, '1 → true');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: 0 }), now).carryover, false, '0 → false');
  checkEq(schema.normalizeCategoryBudget(Object.assign({}, base, { carryover: 'abc' }), now).carryover, false, '未知串 → fallback false');
});

section('用例 6：跨年结转');
test('6.1 2026-01 的上月 = 2025-12', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, '2025-12', 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, '2026-01', 100000, true));
  model.transactions.push(tx('p1', '2025-12', '05', CA_FOOD, 70000));  // 上月剩 30
  model.transactions.push(tx('c1', '2026-01', '05', CA_FOOD, 50000));
  const item = statsApi.budgetProgress(model, '2026-01', { bookId: BK }).items.find((it) => it.categoryId === CA_FOOD);
  checkEq(item.carryoverCents, 30000, '跨年取到 2025-12');
  checkEq(item.availableCents, 130000, 'available=130');
});

section('用例 7：不影响他分类');
test('7.1 未开结转的分类不吸收上月剩余（同月两分类对照）', function () {
  const model = emptyModel();
  model.categoryBudgets.push(cb(CA_FOOD, PREV, 100000, true));
  model.categoryBudgets.push(cb(CA_FOOD, M, 100000, true));
  model.categoryBudgets.push(cb(CA_BUS, M, 50000, false));
  model.transactions.push(tx('p1', PREV, '05', CA_FOOD, 80000));
  model.transactions.push(tx('c1', M, '05', CA_FOOD, 90000));
  const p = statsApi.budgetProgress(model, M, { bookId: BK });
  const food = p.items.find((it) => it.categoryId === CA_FOOD);
  const bus = p.items.find((it) => it.categoryId === CA_BUS);
  checkEq(food.availableCents, 120000, '餐饮含结转');
  checkEq(bus.availableCents, 50000, '交通不含');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) { process.exit(1); }
