'use strict';
/*
 * tests/goals.test.js
 * 目标 / 存入（goals / goalDeposits）行为级回归——补 2.44.0/2.44.1 验收报告在案的盲区（P2-5）。
 *
 * 运行：node tests/goals.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 加载 index.html 的 money/dates/schema/stats 内联块，真跑
 * createGoal / normalizeGoal / validateGoal / createGoalDeposit / normalizeGoalDeposit /
 * validateGoalDeposit / stats.goalProgress（不复写实现）。
 * 锁住：目标金额/引用校验、存入日期边界（2000 下限与 today+366 上限）、软删一致性、
 * 进度只吃未软删的正额存入、done/over 状态与 round1 百分比、不联动账户余额（D09）。
 * 只读业务代码，不修改任何业务文件；不锁源码字符串。
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
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/stats.js · owner']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const S = sandbox.XZB.Core.schema;
const ST = sandbox.XZB.Core.stats;
const MONEY = sandbox.XZB.Core.money;
if (!S || typeof S.createGoal !== 'function' || !ST || typeof ST.goalProgress !== 'function') {
  throw new Error('schema.createGoal / stats.goalProgress 不可用');
}

/* ============================== fixture ============================== */

const NOW = '2026-11-26T09:00:00+08:00';
const TODAY = '2026-11-26';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function goalOf(over) {
  return S.createGoal(Object.assign({
    bookId: 'bk_default', name: '旅行基金', targetCents: 100000
  }, over || {}), NOW);
}

function depositOf(goalId, over) {
  return S.createGoalDeposit(Object.assign({
    goalId: goalId, amountCents: 5000, date: '2026-11-20'
  }, over || {}), NOW);
}

function firstError(res) {
  return res && res.errors && res.errors.length ? res.errors[0] : null;
}

/* ============================== 用例 ============================== */

section('1 目标实体（createGoal / normalizeGoal / validateGoal）');

test('1.1 创建默认值齐全且过校验：piggy 图标、默认色、未归档', function () {
  const g = goalOf();
  check(g.id.indexOf('gl_') === 0, 'gl_ 前缀 id');
  checkEq(g.icon, 'piggy', '默认图标');
  checkEq(g.color, '#FF9500', '默认色');
  checkEq(g.archived, false, '未归档');
  checkEq(S.validateGoal(g).ok, true, '过校验');
});

test('1.2 targetCents：0 / 负数 / 非整数 / 超上限都报 E_GOAL_TARGET', function () {
  [0, -100, 1.5, MONEY.MAX_CENTS + 1].forEach(function (bad) {
    const g = goalOf();
    g.targetCents = bad;
    const err = firstError(S.validateGoal(g));
    check(err && err.code === 'E_GOAL_TARGET', JSON.stringify(bad) + ' 应报 E_GOAL_TARGET，实际 ' + JSON.stringify(err));
  });
});

test('1.3 引用与日期：bookId 缺失 / deadline 非法 / accountId 非法各自点名', function () {
  const noBook = goalOf();
  noBook.bookId = '';
  checkEq(firstError(S.validateGoal(noBook)).code, 'E_BOOK_MISSING', 'bookId');
  const badDeadline = goalOf({ deadline: '2027-13-01' });
  const dErr = S.validateGoal(badDeadline).errors.find(function (e) { return e.field === 'deadline'; });
  check(dErr && dErr.code === 'E_INVALID_INPUT', 'deadline');
  const badAccount = goalOf();
  badAccount.accountId = 'xx';
  const aErr = S.validateGoal(badAccount).errors.find(function (e) { return e.field === 'accountId'; });
  check(aErr && aErr.code === 'E_ACCOUNT_MISSING', 'accountId');
});

test('1.4 normalizeGoal：非法颜色回落默认色，不抛错', function () {
  const g = S.normalizeGoal({ bookId: 'bk_default', name: 'x', targetCents: 100, color: 'red' }, NOW);
  checkEq(g.color, '#FF9500', '颜色兜底');
});

section('2 存入实体（createGoalDeposit / normalizeGoalDeposit / validateGoalDeposit）');

test('2.1 创建过校验；缺 date 用 now 的日期兜底', function () {
  const g = goalOf();
  const d = depositOf(g.id);
  checkEq(S.validateGoalDeposit(d, { goals: [g], today: TODAY }).ok, true, '过校验');
  const noDate = S.createGoalDeposit({ goalId: g.id, amountCents: 5000 }, NOW);
  checkEq(noDate.date, '2026-11-26', 'date 兜底到 now 当天');
});

test('2.2 金额：0 / 负数报 E_GOAL_DEPOSIT_AMOUNT', function () {
  const g = goalOf();
  [0, -5].forEach(function (bad) {
    const d = depositOf(g.id);
    d.amountCents = bad;
    const err = firstError(S.validateGoalDeposit(d, { goals: [g], today: TODAY }));
    check(err && err.code === 'E_GOAL_DEPOSIT_AMOUNT', JSON.stringify(bad) + ' 应报金额错');
  });
});

test('2.3 goalId 不在 ctx.goals：E_GOAL_NOT_FOUND', function () {
  const g = goalOf();
  const d = depositOf('gl_nope01');
  const res = S.validateGoalDeposit(d, { goals: [g], today: TODAY });
  check(res.errors.some(function (e) { return e.code === 'E_GOAL_NOT_FOUND'; }), '孤儿存入被点名');
});

test('2.4 日期边界：早于 2000 / 晚于 today+366 都报 E_TX_DATE', function () {
  const g = goalOf();
  ['1999-12-31', '2028-01-01'].forEach(function (bad) {
    const d = depositOf(g.id, { date: bad });
    const res = S.validateGoalDeposit(d, { goals: [g], today: TODAY });
    check(res.errors.some(function (e) { return e.field === 'date' && e.code === 'E_TX_DATE'; }), bad + ' 应报日期错');
  });
  const edge = depositOf(g.id, { date: '2027-11-27' });
  checkEq(S.validateGoalDeposit(edge, { goals: [g], today: TODAY }).ok, true, 'today+366 当天仍合法');
});

test('2.5 软删一致性：deleted=true 缺 deletedAt 报错；deleted=false 时 normalize 清掉 deletedAt', function () {
  const g = goalOf();
  const broken = depositOf(g.id);
  broken.deleted = true;
  broken.deletedAt = null;
  const res = S.validateGoalDeposit(broken, { goals: [g], today: TODAY });
  check(res.errors.some(function (e) { return e.field === 'deletedAt'; }), '缺 deletedAt 报错');
  const cleaned = S.normalizeGoalDeposit({ goalId: g.id, amountCents: 100, date: '2026-11-20', deleted: false, deletedAt: NOW }, NOW);
  checkEq(cleaned.deletedAt, null, '未软删不留 deletedAt');
});

section('3 进度（stats.goalProgress，只吃 GoalDeposit，不联动账户余额）');

function progressFixture() {
  const g = goalOf();
  const deposits = [
    depositOf(g.id, { amountCents: 5000, date: '2026-11-20' }),
    depositOf(g.id, { amountCents: 3000, date: '2026-11-25' }),
    depositOf(g.id, { amountCents: 9999, date: '2026-11-25', deleted: true, deletedAt: NOW }),
    depositOf('gl_other1', { amountCents: 7000, date: '2026-11-25' }),
    depositOf(g.id, { amountCents: 0, date: '2026-11-25' })
  ];
  return { g: g, deposits: deposits };
}

test('3.1 只累计本目标未软删的正额存入；lastDepositDate 取最大', function () {
  const f = progressFixture();
  const p = ST.goalProgress(f.g, f.deposits);
  checkEq(p.savedCents, 8000, '5000+3000，软删/他目标/零额不计');
  checkEq(p.depositCount, 2, '笔数');
  checkEq(p.lastDepositDate, '2026-11-25', '最近存入日');
  checkEq(p.remainingCents, 92000, '剩余');
  checkEq(p.pct, 8, '百分比');
  checkEq(p.state, 'active', '进行中');
});

test('3.2 状态机：存满 done、超存 over 且剩余不为负', function () {
  const f = progressFixture();
  const gDone = clone(f.g);
  gDone.targetCents = 8000;
  const done = ST.goalProgress(gDone, f.deposits);
  checkEq(done.state, 'done', '刚好存满');
  checkEq(done.pct, 100, '100%');
  const gOver = clone(f.g);
  gOver.targetCents = 7000;
  const over = ST.goalProgress(gOver, f.deposits);
  checkEq(over.state, 'over', '超存');
  checkEq(over.remainingCents, 0, '剩余钳到 0');
  checkEq(over.pct, 114.3, 'round1 百分比');
});

test('3.3 round1：1/3 进度显示 33.3 而不是长浮点', function () {
  const g = goalOf({ targetCents: 30000 });
  const p = ST.goalProgress(g, [depositOf(g.id, { amountCents: 10000 })]);
  checkEq(p.pct, 33.3, '保留一位小数');
});

test('3.4 整库形态：goalProgress(db, goalId) 与直传形态一致；未知目标返回空进度', function () {
  const f = progressFixture();
  const db = { goals: [f.g], goalDeposits: f.deposits };
  const p = ST.goalProgress(db, f.g.id);
  checkEq(p.savedCents, 8000, '整库形态同口径');
  checkEq(p.goalId, f.g.id, 'goalId 透传');
  const unknown = ST.goalProgress(db, 'gl_nope01');
  checkEq(unknown.targetCents, 0, '未知目标目标额 0');
  checkEq(unknown.savedCents, 0, '未知目标不累计');
  checkEq(unknown.state, 'active', '缺省状态');
});

test('3.5 零存入：savedCents=0、pct=0、lastDepositDate=null', function () {
  const p = ST.goalProgress(goalOf(), []);
  checkEq(p.savedCents, 0, '零');
  checkEq(p.pct, 0, '零百分比');
  checkEq(p.depositCount, 0, '零笔数');
  checkEq(p.lastDepositDate, null, '无日期');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);