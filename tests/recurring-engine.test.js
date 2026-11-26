'use strict';
/*
 * tests/recurring-engine.test.js
 * 定期账单引擎行为级回归——补 2.44.0/2.44.1 验收报告在案的高风险路径盲区（P2-5）。
 *
 * 运行：node tests/recurring-engine.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 加载 index.html 的 money/dates/schema + 周期账单算法（recurrence）内联块，
 * 真跑 dueInstances / postInstance / advanceRule / catchUp（不复写实现）。
 * 锁住：periodKey 幂等（含软删流水不复活）、入账失败草稿零改动、游标只前进不后退、
 * autoPost/paused/archived 过滤、月末锚点不回退、weekly 周日=0 口径、endDate 含端点。
 * 到期日全部用固定历史日期 + 显式 todayStr，测试不随真实时钟漂移。
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

function checkDeep(actual, expected, label) {
  checkEq(JSON.stringify(actual), JSON.stringify(expected), label);
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
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', '周期账单算法（T09）']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const R = sandbox.XZB.Core.recurrence;
const S = sandbox.XZB.Core.schema;
if (!R || typeof R.postInstance !== 'function') { throw new Error('XZB.Core.recurrence 不可用'); }

/* ============================== fixture ============================== */

const NOW = '2026-11-26T09:00:00+08:00';
const TODAY = '2026-11-26';

function freshDb() { return S.createDb(NOW); }

function rentRule(over) {
  return S.createRecurring(Object.assign({
    id: 'rc_rent01', bookId: 'bk_default', name: '房租', type: 'expense',
    amountCents: 100000, accountId: 'ac_wechat', categoryId: 'ca_food',
    freq: 'monthly', interval: 1, dayOfMonth: 8, startDate: '2026-09-08', autoPost: true
  }, over || {}), NOW, {});
}

function postedTx(periodKey, over) {
  return S.createTransaction(Object.assign({
    bookId: 'bk_default', type: 'expense', amountCents: 100000,
    accountId: 'ac_wechat', categoryId: 'ca_food',
    date: periodKey.slice(periodKey.indexOf('@') + 1), time: '09:00',
    note: '房租', source: 'recurring', recurringId: 'rc_rent01', periodKey: periodKey
  }, over || {}), NOW);
}

/* ============================== 用例 ============================== */

section('1 幂等键与待入账清单');

test('1.1 makePeriodKey / parsePeriodKey 往返；非法日期返回空', function () {
  checkEq(R.makePeriodKey('rc_rent01', '2026-09-08'), 'rc_rent01@2026-09-08', '拼键');
  checkDeep(R.parsePeriodKey('rc_rent01@2026-09-08'), { ruleId: 'rc_rent01', dueDate: '2026-09-08' }, '拆键');
  checkEq(R.makePeriodKey('rc_rent01', '2026-13-01'), '', '非法日期');
  checkEq(R.parsePeriodKey('rc_rent01@'), null, '缺日期');
});

test('1.2 dueInstances：月规则列出全部已到期未入账的期', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  const list = R.dueInstances(db, TODAY, {});
  checkDeep(list.map(function (i) { return i.dueDate; }),
    ['2026-09-08', '2026-10-08', '2026-11-08'], '三期到期');
  checkEq(list[0].periodKey, 'rc_rent01@2026-09-08', 'periodKey');
  checkEq(list[0].amountCents, 100000, '金额透传');
});

test('1.3 archived 永不返回；paused 默认跳过；autoPostOnly 只要自动规则', function () {
  const db = freshDb();
  db.recurring.push(rentRule({ id: 'rc_arch01', archived: true }));
  db.recurring.push(rentRule({ id: 'rc_pause1', paused: true }));
  db.recurring.push(rentRule({ id: 'rc_manual', autoPost: false }));
  checkEq(R.dueInstances(db, TODAY, {}).length, 3, '默认只剩手动规则 3 期');
  checkEq(R.dueInstances(db, TODAY, { includePaused: true }).length, 6, '含暂停 6 期');
  const auto = R.dueInstances(db, TODAY, { autoPostOnly: true });
  checkEq(auto.length, 0, '无自动规则时为 0');
});

test('1.4 已入账的 periodKey 跳过——软删流水也算已存在，不复活', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  db.transactions.push(postedTx('rc_rent01@2026-09-08', { deleted: true, deletedAt: NOW }));
  const list = R.dueInstances(db, TODAY, {});
  checkDeep(list.map(function (i) { return i.dueDate; }), ['2026-10-08', '2026-11-08'], '软删期不复活');
  checkEq(R.dueInstances(db, TODAY, { skipPosted: false }).length, 3, 'skipPosted:false 不查重');
});

section('2 入账（postInstance）与游标（advanceRule）');

test('2.1 入账：流水字段齐全，游标前移，lastPostedPeriod 记录', function () {
  const db = freshDb();
  const rule = rentRule();
  db.recurring.push(rule);
  const res = R.postInstance(db, { ruleId: 'rc_rent01', dueDate: '2026-09-08' }, { now: NOW });
  checkEq(res.ok, true, 'ok');
  checkEq(res.skipped, false, '非跳过');
  checkEq(db.transactions.length, 1, '落一条');
  const tx = db.transactions[0];
  checkEq(tx.source, 'recurring', 'source');
  checkEq(tx.recurringId, 'rc_rent01', 'recurringId');
  checkEq(tx.periodKey, 'rc_rent01@2026-09-08', 'periodKey');
  checkEq(tx.date, '2026-09-08', 'date=到期日');
  checkEq(tx.amountCents, 100000, '金额');
  checkEq(rule.nextDueDate, '2026-10-08', '游标前移一期');
  checkEq(rule.lastPostedPeriod, 'rc_rent01@2026-09-08', '最近入账期');
});

test('2.2 幂等：同一期重复入账返回 skipped，不重复落账', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  const first = R.postInstance(db, { ruleId: 'rc_rent01', dueDate: '2026-09-08' }, { now: NOW });
  const again = R.postInstance(db, { ruleId: 'rc_rent01', dueDate: '2026-09-08' }, { now: NOW });
  checkEq(again.ok, true, 'ok');
  checkEq(again.skipped, true, 'skipped');
  checkEq(again.id, first.id, '返回既有流水 id');
  checkEq(db.transactions.length, 1, '仍只有一条');
});

test('2.3 软删流水挡住房期：不复活、不新增', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  db.transactions.push(postedTx('rc_rent01@2026-09-08', { deleted: true, deletedAt: NOW }));
  const res = R.postInstance(db, { ruleId: 'rc_rent01', dueDate: '2026-09-08' }, { now: NOW });
  checkEq(res.skipped, true, 'skipped');
  checkEq(db.transactions.length, 1, '不新增');
  checkEq(db.transactions[0].deleted, true, '软删状态不被改动');
});

test('2.4 advanceRule 只前进不后退：游标已超前时重复调用不回拨', function () {
  const db = freshDb();
  const rule = rentRule();
  db.recurring.push(rule);
  R.postInstance(db, { ruleId: 'rc_rent01', dueDate: '2026-09-08' }, { now: NOW });
  checkEq(rule.nextDueDate, '2026-10-08', '先推进到 10 月');
  R.advanceRule(db, rule, '2026-09-08', 'rc_rent01@2026-09-08', {});
  checkEq(rule.nextDueDate, '2026-10-08', '重复推进不回拨');
});

test('2.5 失败路径草稿零改动：超 endDate / 规则不存在', function () {
  const db = freshDb();
  db.recurring.push(rentRule({ endDate: '2026-10-31' }));
  const before = JSON.stringify(db);
  const late = R.postInstance(db, { ruleId: 'rc_rent01', dueDate: '2026-11-08' }, { now: NOW });
  checkEq(late.ok, false, '超 endDate 失败');
  checkEq(late.code, 'E_RECURRING_RULE', '错误码');
  const missing = R.postInstance(db, { ruleId: 'rc_nope01', dueDate: '2026-09-08' }, { now: NOW });
  checkEq(missing.code, 'E_RECURRING_NOT_FOUND', '规则不存在');
  checkEq(JSON.stringify(db), before, '草稿一个字节不动');
});

section('3 批量补账（catchUp）');

test('3.1 默认只补 autoPost 规则，汇总计数正确', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  db.recurring.push(rentRule({ id: 'rc_manual', autoPost: false }));
  const sum = R.catchUp(db, db, TODAY, {});
  checkEq(sum.ok, true, 'ok');
  checkEq(sum.posted, 3, '补 3 期');
  checkEq(sum.failed, 0, '零失败');
  checkEq(sum.total, 3, '清单只含自动规则');
  checkEq(db.transactions.length, 3, '落 3 条');
  const manual = db.recurring.find(function (r) { return r.id === 'rc_manual'; });
  checkEq(manual.lastPostedPeriod, null, '手动规则未被补账');
});

test('3.2 补完再跑：零到期、零入账（幂等）', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  R.catchUp(db, db, TODAY, {});
  const again = R.catchUp(db, db, TODAY, {});
  checkEq(again.total, 0, '无待补');
  checkEq(again.posted, 0, '零入账');
  checkEq(db.transactions.length, 3, '仍 3 条');
});

test('3.3 max 上限：单次最多补 max 期，剩余留到下次', function () {
  const db = freshDb();
  db.recurring.push(rentRule());
  const sum = R.catchUp(db, db, TODAY, { max: 2 });
  checkEq(sum.posted, 2, '只补 2 期');
  checkEq(sum.remaining, 1, '剩 1 期');
  checkEq(sum.partial, false, '无失败不算 partial');
  const rest = R.catchUp(db, db, TODAY, {});
  checkEq(rest.posted, 1, '下次补完');
});

section('4 到期日算法口径');

test('4.1 月末锚点不回退：31 日规则在 2 月落 28，3 月仍回 31', function () {
  const rule = { freq: 'monthly', interval: 1, dayOfMonth: 31, startDate: '2027-01-31' };
  checkDeep(R.instancesBetween(rule, '2027-01-01', '2027-04-30'),
    ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'], '锚点保持 31');
});

test('4.2 weekly 周日=0 口径：周一起始的规则首个周日正确', function () {
  /* 2026-11-23 是周一 */
  const sun = { freq: 'weekly', interval: 1, weekday: 0, startDate: '2026-11-23' };
  checkEq(R.nextDueDate(sun, '2026-11-23'), '2026-11-29', '首个周日');
  const thu = { freq: 'weekly', interval: 1, weekday: 4, startDate: '2026-11-23' };
  checkEq(R.nextDueDate(thu, '2026-11-23'), '2026-11-26', '周四=4');
});

test('4.3 endDate 含端点：当天仍到期，次日起为 null', function () {
  const rule = { freq: 'daily', interval: 1, startDate: '2026-11-20', endDate: '2026-11-22' };
  checkDeep(R.instancesBetween(rule, '2026-11-20', '2026-11-30'),
    ['2026-11-20', '2026-11-21', '2026-11-22'], '含端点');
  checkEq(R.nextDueDate(rule, '2026-11-22'), '2026-11-22', '端点当天');
  checkEq(R.nextDueDateAfter(rule, '2026-11-22'), null, '过了端点');
});

test('4.4 dayOfMonth 29–31：创建口径夹到 28，算法口径保留原值', function () {
  checkEq(S.createRecurring({ freq: 'monthly', dayOfMonth: 31, startDate: '2027-01-31' }, NOW, {}).dayOfMonth, 28, 'schema 夹 28');
  checkEq(R.normalizeRule({ freq: 'monthly', dayOfMonth: 31 }).dayOfMonth, 28, '默认夹 28');
  checkEq(R.normalizeRule({ freq: 'monthly', dayOfMonth: 31 }, { clampDay: false }).dayOfMonth, 31, '算法保留 31');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);