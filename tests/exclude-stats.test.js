'use strict';
/*
 * tests/exclude-stats.test.js
 * 自检脚本：2.28.10「不计收支」——transactions.excludeStats 的口径隔离。
 * 吸收自 BeeCount excludeFromStats / excludeFromBudget（竞品吸收批次二 E）。
 *
 * 口径契约：
 *   - 统计侧（budgetProgress / monthSummary / 分类排行 / 日历热力 / 趋势，全部经
 *     core/stats.walk）不含 excludeStats 账目；
 *   - 余额侧（accountBalanceCents 等 balanceMap 路径）照常计入；
 *   - schema：normalizeTransaction 缺省 false，转账强转 false；
 *   - 问答（core-assistant sumWindow）与月度解读（ai-insights）为本文件源码级断言
 *     （其依赖链不适合 vm 内联装配，与 ai-config 的源码断言同范式）。
 *
 * 运行：node tests/exclude-stats.test.js（scripts/test.js 自动收集）
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CA_JS = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'core-assistant.js'), 'utf8');
const AI_JS = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'ai-insights.js'), 'utf8');

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

/* 跳过字符串与注释的花括号配对扫描（同 category-expansion 范式）。 */
function matchBracket(src, start, openCh, closeCh) {
  let depth = 0;
  let i = start;
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

/* ============================== 沙箱装配 ============================== */

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
  throw new Error('XZB.Core.stats 不可用');
}

/* ============================== 固定数据 ============================== */

const BK = 'bk1';
const M = '2026-11';

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

function tx(id, day, cents, opts) {
  return Object.assign({
    id: id,
    bookId: BK,
    type: 'expense',
    amountCents: cents,
    accountId: 'ac1',
    toAccountId: null,
    categoryId: 'ca_food',
    date: M + '-' + day,
    time: '12:00',
    note: '',
    tags: [],
    photoIds: [],
    source: 'manual',
    deleted: false,
    excludeStats: false
  }, opts || {});
}

/* 一笔普通支出 80 + 一笔不计收支 50 */
function modelBoth() {
  const model = baseModel();
  model.transactions.push(tx('n1', '05', 80000));
  model.transactions.push(tx('x1', '06', 50000, { excludeStats: true }));
  return model;
}

/* ============================== 用例 ============================== */

section('用例 1：统计侧不含 excludeStats');
test('1.1 budgetProgress.spentCents 只算普通支出', function () {
  const model = baseModel();
  model.budgets.push({ id: 'b1', bookId: BK, month: M, totalCents: 200000 });
  model.transactions.push(tx('n1', '05', 80000));
  model.transactions.push(tx('x1', '06', 50000, { excludeStats: true }));
  const p = statsApi.budgetProgress(model, M, { bookId: BK });
  checkEq(p.spentCents, 80000, 'spentCents 不含不计收支');
  checkEq(p.pct, 40, 'pct 按 80/200');
});

test('1.2 分类聚合同样不含（items.spentCents）', function () {
  const model = baseModel();
  model.categoryBudgets.push({ id: 'cb1', bookId: BK, month: M, categoryId: 'ca_food', amountCents: 100000 });
  model.transactions.push(tx('n1', '05', 80000));
  model.transactions.push(tx('x1', '06', 50000, { excludeStats: true }));
  const item = statsApi.budgetProgress(model, M, { bookId: BK }).items.find((it) => it.categoryId === 'ca_food');
  checkEq(item.spentCents, 80000, '分类 spent 不含不计收支');
});

test('1.3 monthSummary 的 expenseCents 不含', function () {
  const s = statsApi.monthSummary(modelBoth(), M, { bookId: BK });
  checkEq(s.expenseCents, 80000, '月支出不含不计收支');
  checkEq(s.count, 1, '笔数不含不计收支');
});

test('1.4 日历热力图不含（walk 统一口径抽查）', function () {
  const heat = statsApi.calendarHeatmap(modelBoth(), { bookId: BK });
  const day = (heat.days || []).find((d) => d && d.date === M + '-06');
  check(!day || !day.expenseCents || day.expenseCents === 0, '06 当日热力为 0/不存在');
  const day5 = (heat.days || []).find((d) => d && d.date === M + '-05');
  check(day5 && day5.expenseCents === 80000, '05 当日照常 80');
});

section('用例 2：余额侧照常计入');
test('2.1 accountBalanceCents 包含 excludeStats 支出（余额照扣）', function () {
  const balance = statsApi.accountBalanceCents(modelBoth(), 'ac1');
  const withFlag = balance;
  const model = baseModel();
  model.transactions.push(tx('n1', '05', 80000));
  const withoutFlag = statsApi.accountBalanceCents(model, 'ac1');
  checkEq(withFlag, withoutFlag - 50000, '余额多扣了那笔不计收支的 50');
});

section('用例 3：schema 白名单');
test('3.1 normalizeTransaction：缺省 false / true 保留 / 转账强转 false', function () {
  const now = '2026-11-08T00:00:00.000Z';
  const base = {
    id: 'tx_x', bookId: BK, type: 'expense', amountCents: 1000,
    accountId: 'ac1', date: M + '-05', time: '12:00'
  };
  checkEq(schema.createTransaction(Object.assign({}, base), now).excludeStats, false, '缺省 → false');
  checkEq(schema.createTransaction(Object.assign({}, base, { excludeStats: true }), now).excludeStats, true, 'true → true');
  const tr = schema.createTransaction(Object.assign({}, base, {
    type: 'transfer', toAccountId: 'ac2', excludeStats: true
  }), now);
  checkEq(tr.excludeStats, false, '转账强转 false');
});

section('用例 4：问答与月度解读的源码级断言（同 ai-config 范式）');
test('4.1 core-assistant sumWindow 含 excludeStats 过滤', function () {
  const body = liftFunction(CA_JS, 'sumWindow');
  check(body, 'sumWindow 可提升');
  check(body.indexOf('tx.excludeStats === true') >= 0, 'sumWindow 缺少不计收支过滤');
});

test('4.2 ai-insights buildMonthlyMetrics 含 excludeStats 过滤', function () {
  check(AI_JS.indexOf("if (tx.excludeStats === true) { continue; }") >= 0,
    'buildMonthlyMetrics 缺少不计收支过滤');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) { process.exit(1); }
