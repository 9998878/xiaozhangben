'use strict';
/*
 * tests/habit.test.js
 * 自检脚本：2.28.10「习惯记账建议」——js/modules/habit.js 的 suggestHabits / dismiss。
 * 算法吸收自借章 jiezhang statement-suggestion.ts（竞品吸收批次二 B）。
 *
 * 运行：node tests/habit.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：habit.js 与 nl.js 同款 IIFE，Node 下走 global 分支直接挂 XZB.Core.habit，
 * 整文件读进 vm 沙箱真实执行（不是复写实现）。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'habit.js'), 'utf8');

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

const sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'js/modules/habit.js' });
const habit = sandbox.XZB.Core.habit;
if (!habit || typeof habit.suggestHabits !== 'function') {
  throw new Error('XZB.Core.habit.suggestHabits 不可用');
}

/* ============================== 固定数据 ============================== */

const NOW = new Date(2026, 10, 8, 14, 20, 0);   // 2026-11-08 14:20（周日）
const TODAY = '2026-11-08';
const CA_COFFEE = 'ca_coffee';
const AC_WECHAT = 'ac_wechat';

function fakePrefs(dismissed) {
  const store = { habitDismiss: dismissed || null };
  return {
    get(key, fallback) {
      if (Object.prototype.hasOwnProperty.call(store, key)) { return store[key]; }
      return fallback;
    },
    set(key, value) { store[key] = value; return value; }
  };
}

function tx(id, date, time, opts) {
  return Object.assign({
    id: id,
    bookId: 'bk1',
    type: 'expense',
    amountCents: 3200,
    accountId: AC_WECHAT,
    toAccountId: null,
    categoryId: CA_COFFEE,
    date: date,
    time: time,
    note: '生椰拿冰',
    tags: [],
    photoIds: [],
    source: 'manual',
    deleted: false
  }, opts || {});
}

function dbWith(list) { return { transactions: list }; }

/* 三个不同日的咖啡历史（默认都在 14 点档 → 与 NOW 命中） */
function coffeeHabit3Days() {
  return [
    tx('a', '2026-11-03', '14:05'),
    tx('b', '2026-11-05', '14:40'),
    tx('c', '2026-11-07', '13:50')
  ];
}

/* ============================== 用例 ============================== */

section('用例 1：命中与输出');
test('1.1 三天历史 + 时间窗内 → 返回 1 条，带最近一笔的金额/账户/备注', function () {
  const tip = habit.suggestHabits(dbWith(coffeeHabit3Days()), fakePrefs(), NOW);
  check(tip, '应命中');
  checkEq(tip.categoryId, CA_COFFEE, '分类');
  checkEq(tip.type, 'expense', '类型');
  checkEq(tip.amountCents, 3200, '金额=最近一笔');
  checkEq(tip.accountId, AC_WECHAT, '账户=最近一笔');
  checkEq(tip.note, '生椰拿冰', '备注=最近一笔');
  checkEq(tip.lastDate, '2026-11-07', 'lastDate=最近一笔日期');
  checkEq(tip.votes, 3, '票数=3 天');
});

test('1.2 输出的 bookId 来自最近一笔（预填用）', function () {
  const tip = habit.suggestHabits(dbWith(coffeeHabit3Days()), fakePrefs(), NOW);
  checkEq(tip.bookId, 'bk1', 'bookId');
});

section('用例 2：每天一票（防同日批量伪装习惯）');
test('2.1 同一天灌 5 笔只算 1 票：2 个有效日 → 不命中', function () {
  const list = [
    tx('d1a', '2026-11-06', '14:00'), tx('d1b', '2026-11-06', '14:10'),
    tx('d1c', '2026-11-06', '14:20'), tx('d1d', '2026-11-06', '14:30'),
    tx('d1e', '2026-11-06', '14:40'),
    tx('d2a', '2026-11-07', '14:00'), tx('d2b', '2026-11-07', '14:30')
  ];
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '有效日不足 3');
});

test('2.2 3 天里有一天灌多笔 → 票数仍是 3，命中', function () {
  const list = [
    tx('a', '2026-11-03', '14:05'),
    tx('m1', '2026-11-05', '14:10'), tx('m2', '2026-11-05', '14:20'), tx('m3', '2026-11-05', '14:30'),
    tx('c', '2026-11-07', '13:50')
  ];
  const tip = habit.suggestHabits(dbWith(list), fakePrefs(), NOW);
  check(tip, '应命中');
  checkEq(tip.votes, 3, '票数=天数=3');
});

section('用例 3：门槛与窗口');
test('3.1 不足 3 天 → null', function () {
  const list = [tx('a', '2026-11-06', '14:00'), tx('b', '2026-11-07', '14:00')];
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '只有 2 天');
});

test('3.2 28 天窗外的历史不计 → 有效日不足', function () {
  const list = [
    tx('old1', '2026-09-20', '14:00'),
    tx('old2', '2026-09-21', '14:00'),
    tx('new1', '2026-11-06', '14:00')
  ];
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '老账出窗');
});

section('用例 4：触发时间窗（环形 ±90 分钟）');
test('4.1 历史都在 08:00，现在 14:20（差 380 分钟）→ null', function () {
  const list = [
    tx('a', '2026-11-03', '08:00'),
    tx('b', '2026-11-05', '08:10'),
    tx('c', '2026-11-07', '08:20')
  ];
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '时间不匹配');
});

test('4.2 恰好 ±90 分钟 → 命中（边界含）', function () {
  const list = [
    tx('a', '2026-11-03', '12:50'),
    tx('b', '2026-11-05', '12:50'),
    tx('c', '2026-11-07', '12:50')
  ];  // 12:50 与 14:20 相差 90 分钟
  const tip = habit.suggestHabits(dbWith(list), fakePrefs(), NOW);
  check(tip, '边界 90 分钟应命中');
});

test('4.3 环形跨午夜：历史 23:50，现在 00:30 → 40 分钟命中', function () {
  const nowMid = new Date(2026, 10, 8, 0, 30, 0);
  const list = [
    tx('a', '2026-11-03', '23:50'),
    tx('b', '2026-11-05', '23:55'),
    tx('c', '2026-11-07', '23:45')
  ];
  const tip = habit.suggestHabits(dbWith(list), fakePrefs(), nowMid);
  check(tip, '跨午夜环形距离应命中');
});

section('用例 5：排除口径');
test('5.1 今天已记该分类 → null', function () {
  const list = coffeeHabit3Days().concat([tx('today', TODAY, '14:00')]);
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '今天已记');
});

test('5.2 deleted === true 不计', function () {
  const list = [
    tx('a', '2026-11-03', '14:05', { deleted: true }),
    tx('b', '2026-11-05', '14:40'),
    tx('c', '2026-11-07', '13:50')
  ];
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '只剩 2 天有效');
});

test('5.3 收入/转账/无分类不计', function () {
  const list = coffeeHabit3Days().concat([
    tx('i1', '2026-11-06', '14:00', { type: 'income', categoryId: 'ca_salary' }),
    tx('t1', '2026-11-06', '14:10', { type: 'transfer', categoryId: '' })
  ]);
  const tip = habit.suggestHabits(dbWith(list), fakePrefs(), NOW);
  check(tip, '咖啡习惯仍命中');
  checkEq(tip.categoryId, CA_COFFEE, '候选只来自支出分组');
});

test('5.4 excludeStats 的账不参与（与统计口径一致）', function () {
  const list = [
    tx('a', '2026-11-03', '14:05', { excludeStats: true }),
    tx('b', '2026-11-05', '14:40', { excludeStats: true }),
    tx('c', '2026-11-07', '13:50')
  ];
  checkEq(habit.suggestHabits(dbWith(list), fakePrefs(), NOW), null, '只剩 1 天有效');
});

section('用例 6：忽略表');
test('6.1 忽略期内 → null；过期后 → 命中', function () {
  const db = dbWith(coffeeHabit3Days());
  const key = 'expense:' + CA_COFFEE;
  const active = fakePrefs({ [key]: '2026-11-10' });      // 忽略至 11-10（含今天）
  checkEq(habit.suggestHabits(db, active, NOW), null, '忽略期内');
  const expired = fakePrefs({ [key]: '2026-11-07' });     // 已过期
  const tip = habit.suggestHabits(db, expired, NOW);
  check(tip, '忽略过期后恢复');
});

test('6.2 dismiss 写入忽略表 = 今天 + 7 天', function () {
  const prefs = fakePrefs();
  const tip = habit.suggestHabits(dbWith(coffeeHabit3Days()), prefs, NOW);
  habit.dismiss(prefs, tip, NOW);
  checkEq(prefs.get('habitDismiss')[key0()], '2026-11-15', '忽略至 +7 天');

  function key0() { return 'expense:' + CA_COFFEE; }
});

test('6.3 dismiss 后再建议 → null', function () {
  const prefs = fakePrefs();
  const db = dbWith(coffeeHabit3Days());
  const tip = habit.suggestHabits(db, prefs, NOW);
  habit.dismiss(prefs, tip, NOW);
  checkEq(habit.suggestHabits(db, prefs, NOW), null, '忽略生效');
});

test('6.4 异常兜底：db 为 null / prefs 为 null → null 不抛错', function () {
  checkEq(habit.suggestHabits(null, null, NOW), null, 'db null');
  const tip = habit.suggestHabits(dbWith(coffeeHabit3Days()), null, NOW);
  check(tip || tip === null, 'prefs null 不抛错');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) { process.exit(1); }
