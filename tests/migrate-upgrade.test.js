'use strict';
/*
 * tests/migrate-upgrade.test.js
 * 迁移 / schemaVersion 升级行为级回归——补 2.44.0/2.44.1 验收报告在案的高风险路径盲区（P2-5）。
 *
 * 运行：node tests/migrate-upgrade.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 加载 index.html 的 money/dates/schema/store/migrate 内联块，真跑
 * upgrade / fromV1 / importV2 / detect / run（不复写实现）。
 * 锁住：低版本一把升到现在（2→4 与 3→4 同分支，photoIds 缺失补 []、已有保留）、
 * 升级失败不落库不改入参、v1 importRef 幂等（含缺 id 内容指纹+序号不吞数据）、
 * v2 合并 id/importRef 去重与账户 remap、孤儿 goalDeposit 跳过。
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
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/store.js', 'js/core/migrate.js · owner']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const M = sandbox.XZB.Core.migrate;
const S = sandbox.XZB.Core.schema;
const D = sandbox.XZB.Core.dates;
if (!M || typeof M.upgrade !== 'function') { throw new Error('XZB.Core.migrate 不可用'); }

/* ============================== fixture ============================== */

const NOW = '2026-11-26T09:00:00+08:00';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function freshDb() { return S.createDb(NOW); }

function txOf(over) {
  return S.createTransaction(Object.assign({
    bookId: 'bk_default', type: 'expense', amountCents: 1200,
    accountId: 'ac_wechat', categoryId: 'ca_food',
    date: '2026-10-01', time: '12:00', note: '午饭'
  }, over || {}), NOW);
}

function v1Tx(over) {
  return Object.assign({
    id: 'old1', amount: 1200, type: 'expense', account: 'wechat',
    category: 'food', date: '2026-10-01', note: '午饭', createdAt: 1760000000000
  }, over || {});
}

/* ============================== 用例 ============================== */

section('1 识别（detect）');

test('1.1 v1 数组 / v1 对象 / v2 备份 / 未知输入', function () {
  checkEq(M.detect([v1Tx()]), 'v1', '数组是 v1');
  checkEq(M.detect({ app: '小账本', version: 1, transactions: [] }), 'v1', 'v1 包装');
  checkEq(M.detect({ kind: 'xzb-backup', schemaVersion: M.SCHEMA_VERSION, data: { books: [] } }), 'v2', 'v2 备份');
  checkEq(M.detect({ data: { books: [] } }), 'v2', 'data.books 形态');
  checkEq(M.detect({ foo: 1 }), null, '未知');
});

section('2 库内版本升级（upgrade）');

test('2.1 v3→4：photoIds 缺失补 []，已有照片引用原样保留', function () {
  const db = freshDb();
  const old = txOf({ id: 'tx_old001' });
  delete old.photoIds;
  const withPhoto = txOf({ id: 'tx_pic001', photoIds: ['ph_pic001'] });
  db.transactions.push(old, withPhoto);
  db.schemaVersion = 3;
  const res = M.upgrade(db);
  checkEq(res.ok, true, 'ok：' + JSON.stringify(res));
  checkEq(res.from, 3, 'from=3');
  checkEq(res.db.schemaVersion, M.SCHEMA_VERSION, '升到当前');
  checkDeep(res.db.transactions[0].photoIds, [], '缺失补 []');
  checkDeep(res.db.transactions[1].photoIds, ['ph_pic001'], '已有保留');
  check(res.warnings.length === 1 && res.warnings[0].indexOf('v3') >= 0, '升级警告');
  checkEq(db.schemaVersion, 3, '入参不被改动');
});

test('2.2 v2→4 与 3→4 同一分支：都能一把升到现在', function () {
  const db = freshDb();
  const old = txOf({ id: 'tx_old002' });
  delete old.photoIds;
  db.transactions.push(old);
  db.schemaVersion = 2;
  const res = M.upgrade(db);
  checkEq(res.ok, true, 'ok');
  checkEq(res.from, 2, 'from=2');
  checkEq(res.db.schemaVersion, M.SCHEMA_VERSION, '升到当前');
  checkDeep(res.db.transactions[0].photoIds, [], '补 []');
});

test('2.3 同版本：原样通过（深拷贝），零警告', function () {
  const db = freshDb();
  db.transactions.push(txOf({ id: 'tx_same01' }));
  const res = M.upgrade(db);
  checkEq(res.ok, true, 'ok');
  checkEq(res.warnings.length, 0, '零警告');
  check(res.db !== db, '返回克隆');
  checkDeep(res.db, db, '内容一致');
});

test('2.4 未来版本拒绝；schemaVersion 非整数判损坏', function () {
  const tooNew = freshDb();
  tooNew.schemaVersion = M.SCHEMA_VERSION + 1;
  checkEq(M.upgrade(tooNew).code, 'E_STORAGE_VERSION', '未来版本');
  const corrupt = freshDb();
  corrupt.schemaVersion = '4';
  checkEq(M.upgrade(corrupt).code, 'E_STORAGE_CORRUPT', '非整数');
});

test('2.5 升级中校验失败：不落库、入参一个字节不动', function () {
  const db = freshDb();
  db.goals.push({ id: 'gl_bad001', bookId: 'bk_default', name: '坏目标', targetCents: 0 });
  db.schemaVersion = 3;
  const before = clone(db);
  const res = M.upgrade(db);
  checkEq(res.ok, false, '失败');
  check(!res.db, '不返回半成品库');
  checkDeep(db, before, '入参不变');
});

section('3 v1 迁移（fromV1）');

test('3.1 merge 幂等：importRef 去重，重跑只增 skipped', function () {
  const v1 = { app: '小账本', version: 1, transactions: [v1Tx(), v1Tx({ id: 'old2', amount: 5000, type: 'income', account: 'bank', category: 'salary', date: '2026-10-05', note: '工资' })] };
  const first = M.fromV1(v1, { mode: 'merge', currentDb: freshDb() });
  checkEq(first.ok, true, 'ok');
  checkEq(first.report.transactions, 2, '导入 2 条');
  check(first.db.transactions.some(function (t) { return t.importRef === 'v1:old1'; }), 'importRef 打标');
  const again = M.fromV1(v1, { mode: 'merge', currentDb: first.db });
  checkEq(again.report.transactions, 0, '重跑零导入');
  checkEq(again.report.skipped, 2, '重跑 2 跳过');
  checkEq(again.db.transactions.length, first.db.transactions.length, '条数不变');
});

test('3.2 缺 id 老数据：内容指纹+序号，5 条相同账全导入且不吞数据', function () {
  const same = { amount: 100, type: 'expense', account: 'cash', category: 'food', date: '2026-10-01', note: '相同' };
  const v1 = { transactions: [clone(same), clone(same), clone(same), clone(same), clone(same)] };
  const first = M.fromV1(v1, { mode: 'merge', currentDb: freshDb() });
  checkEq(first.report.transactions, 5, '5 条全进');
  const again = M.fromV1(v1, { mode: 'merge', currentDb: first.db });
  checkEq(again.report.transactions, 0, '重跑零导入');
  checkEq(again.report.skipped, 5, '5 条全跳过');
});

test('3.3 账户映射：bank→银行卡；未知账户归现金并给警告', function () {
  const v1 = { transactions: [v1Tx({ id: 'a1', account: 'bank' }), v1Tx({ id: 'a2', account: 'paypal' })] };
  const res = M.fromV1(v1, { mode: 'merge', currentDb: freshDb() });
  checkEq(res.ok, true, 'ok');
  checkEq(res.db.transactions[0].accountId, 'ac_debit', 'bank 映射');
  checkEq(res.db.transactions[1].accountId, 'ac_cash', '未知归现金');
  check(res.report.warnings.some(function (w) { return w.indexOf('现金') >= 0; }), '警告点名现金');
});

test('3.4 v1 月预算归当前月；已有预算不覆盖只警告', function () {
  const month = D.todayStr().slice(0, 7);
  const v1 = { transactions: [v1Tx()], budget: 50000 };
  const first = M.fromV1(v1, { mode: 'merge', currentDb: freshDb() });
  checkEq(first.report.budgets, 1, '预算 +1');
  checkEq(first.db.budgets[0].month, month, '归当前月');
  checkEq(first.db.budgets[0].totalCents, 50000, '金额');
  const again = M.fromV1(v1, { mode: 'merge', currentDb: first.db });
  checkEq(again.report.budgets, 0, '不重复导入');
  check(again.report.warnings.some(function (w) { return w.indexOf('已有预算') >= 0; }), '警告');
});

section('4 v2 合并 / 替换（importV2）');

test('4.1 merge：id 与 importRef 双重去重', function () {
  const db = freshDb();
  db.transactions.push(txOf({ id: 'tx_keep01' }));
  const payload = {
    transactions: [
      { id: 'tx_keep01', bookId: 'bk_default', type: 'expense', amountCents: 100, accountId: 'ac_wechat', categoryId: 'ca_food', date: '2026-10-02' },
      { id: 'tx_new001', bookId: 'bk_default', type: 'expense', amountCents: 900, accountId: 'ac_wechat', categoryId: 'ca_food', date: '2026-10-02', importRef: 'ref-1' },
      { id: 'tx_new002', bookId: 'bk_default', type: 'expense', amountCents: 900, accountId: 'ac_wechat', categoryId: 'ca_food', date: '2026-10-02', importRef: 'ref-1' }
    ]
  };
  const res = M.importV2(payload, { mode: 'merge', currentDb: db });
  checkEq(res.ok, true, 'ok：' + JSON.stringify(res));
  checkEq(res.report.transactions, 1, '只进 1 条');
  checkEq(res.report.skipped, 2, '跳过 2 条');
  checkEq(res.db.transactions.length, 2, '库中共 2 条');
});

test('4.2 账户按 type+name remap；孤儿 bookId 落回本地账本', function () {
  const payload = {
    accounts: [{ id: 'ac_dup001', type: 'wechat', name: '微信' }],
    transactions: [{ id: 'tx_new003', bookId: 'bk_ghost01', type: 'expense', amountCents: 900, accountId: 'ac_dup001', categoryId: 'ca_food', date: '2026-10-02' }]
  };
  const res = M.importV2(payload, { mode: 'merge', currentDb: freshDb() });
  checkEq(res.ok, true, 'ok');
  check(res.report.remapped >= 1, 'remap 计数');
  checkEq(res.db.transactions[0].accountId, 'ac_wechat', '账户复用本地 id');
  checkEq(res.db.transactions[0].bookId, 'bk_default', '孤儿账本兜底');
  check(!res.db.accounts.some(function (a) { return a.id === 'ac_dup001'; }), '不新增重复账户');
});

test('4.3 goals 按 id 合并；孤儿 goalDeposit 跳过不进库', function () {
  const payload = {
    goals: [{ id: 'gl_trip01', bookId: 'bk_default', name: '旅行基金', targetCents: 100000 }],
    goalDeposits: [
      { id: 'gd_dep001', goalId: 'gl_trip01', amountCents: 5000, date: '2026-10-01' },
      { id: 'gd_orphan1', goalId: 'gl_nope01', amountCents: 100, date: '2026-10-01' }
    ]
  };
  const res = M.importV2(payload, { mode: 'merge', currentDb: freshDb() });
  checkEq(res.ok, true, 'ok');
  checkEq(res.report.goals, 1, '目标 +1');
  checkEq(res.report.goalDeposits, 1, '存入 +1');
  checkEq(res.db.goalDeposits.length, 1, '孤儿不进库');
  checkEq(res.db.goalDeposits[0].goalId, 'gl_trip01', '引用完整');
});

test('4.4 replace：整体替换并过整库校验', function () {
  const source = freshDb();
  source.transactions.push(txOf({ id: 'tx_rep001' }));
  const res = M.importV2(clone(source), { mode: 'replace' });
  checkEq(res.ok, true, 'ok：' + JSON.stringify(res));
  checkEq(res.report.transactions, 1, '流水计数');
  checkEq(res.db.schemaVersion, M.SCHEMA_VERSION, '版本');
  checkEq(S.validateDb(res.db).ok, true, '整库校验通过');
});

section('5 统一入口（run）');

test('5.1 给库走升级、给 v1 走迁移、给 v2 备份走导入', function () {
  const db = freshDb();
  const up = M.run(db);
  checkEq(up.ok, true, '库 ok');
  checkEq(up.from, M.SCHEMA_VERSION, '走 upgrade');
  const v1 = M.run([v1Tx()]);
  checkEq(v1.sourceVersion, 1, '走 fromV1');
  const backup = { kind: 'xzb-backup', schemaVersion: M.SCHEMA_VERSION, data: clone(freshDb()) };
  const v2 = M.run(backup, { mode: 'replace' });
  checkEq(v2.sourceVersion, 2, '走 importV2');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);