'use strict';
/*
 * tests/accountless-ui.test.js
 * 2.32.7：手动记账 / 计划 / 账单导入 / 流水筛选不再让用户选账户；
 * 账户管理页与账户余额保留。源码锁，防止账户选择入口回归。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADD_JS = fs.readFileSync(path.join(ROOT, 'js/screens/add.js'), 'utf8');
const PLAN_JS = fs.readFileSync(path.join(ROOT, 'js/screens/plan.js'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/settings.js'), 'utf8');
const LEDGER_JS = fs.readFileSync(path.join(ROOT, 'js/screens/ledger.js'), 'utf8');
const NL_JS = fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8');
const ACCOUNTS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/accounts.js'), 'utf8');

let passCount = 0;
let failCount = 0;

function check(cond, message) {
  if (cond) { return; }
  throw new Error(message);
}

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failCount += 1;
    console.log('  [FAIL] ' + name);
    console.log('         -> ' + (e && e.message ? e.message : e));
  }
}

console.log('用例 1：手动记账不再有账户选择');

test('1.1 add.js 没有账户 chip / 账户 sheet / 转账交换按钮', function () {
  check(ADD_JS.indexOf('选择账户') < 0, '不应再出现「选择账户」');
  check(ADD_JS.indexOf('选择转入账户') < 0, '不应再出现「选择转入账户」');
  check(ADD_JS.indexOf('accChip') < 0, '不应再有 accChip');
  check(ADD_JS.indexOf('toAccChip') < 0, '不应再有 toAccChip');
  check(ADD_JS.indexOf('openAccountSheet') < 0, '不应再有账户选择 sheet');
  check(ADD_JS.indexOf('swapAccounts') < 0, '不应再有转账账户交换');
});

test('1.2 add.js 仍有内部默认账户兜底，保存不要求用户选账户', function () {
  check(ADD_JS.indexOf('defaultAccountId') >= 0, '应保留默认账户兜底');
  check(ADD_JS.indexOf('defaultToAccountId') >= 0, '转账应自动补一个不同的默认账户');
  check(ADD_JS.indexOf("reason: '选择账户'") < 0, '保存条件不应再要求选择账户');
  check(ADD_JS.indexOf("reason: '选择转出账户'") < 0, '保存条件不应再要求选择转出账户');
  check(ADD_JS.indexOf("reason: '选择转入账户'") < 0, '保存条件不应再要求选择转入账户');
});

console.log('用例 2：计划 / 导入 / 流水筛选不再有账户选择');

test('2.1 plan.js 没有账户下拉与转入账户字段', function () {
  check(PLAN_JS.indexOf('accountSelect') < 0, '计划不应再有 accountSelect');
  check(PLAN_JS.indexOf('toAccountSelect') < 0, '计划不应再有 toAccountSelect');
  check(PLAN_JS.indexOf("fieldRow('账户'") < 0, '计划不应再渲染账户字段');
  check(PLAN_JS.indexOf('请选择账户') < 0, '计划保存不应再要求选择账户');
  check(PLAN_JS.indexOf('defaultToAccountId') >= 0, '计划转账应自动补默认账户');
});

test('2.2 settings.js 账单导入没有「记入账户」下拉', function () {
  check(SETTINGS_JS.indexOf('记入账户') < 0, '导入不应再出现记入账户');
  check(SETTINGS_JS.indexOf('accSelect') < 0, '导入不应再出现账户下拉');
  check(SETTINGS_JS.indexOf('runBillImport(ctx, items, defaultAccountId') >= 0, '导入应落默认账户');
});

test('2.3 nl.js 转账缺转入账户时不再提示「请选择」', function () {
  check(NL_JS.indexOf('未识别转入账户，请选择') < 0, '本地解析不应再让用户选择转入账户');
  check(NL_JS.indexOf('未识别转入账户，已用默认账户') >= 0, '缺转入账户应回落默认账户');
});

test('2.4 ledger.js 筛选 sheet 没有账户 group / 账户 chip', function () {
  check(LEDGER_JS.indexOf('accountGroup') < 0, '流水筛选不应再有 accountGroup');
  check(LEDGER_JS.indexOf("text: '账户'") < 0, '流水筛选不应再有账户标题');
  check(LEDGER_JS.indexOf('draft.accountIds.slice(0)') >= 0, '内部筛选状态可保留，但不再有账户入口');
});

console.log('用例 3：账户管理页保留');

test('3.1 accounts.js 仍在，账户页与余额没有被删', function () {
  check(ACCOUNTS_JS.length > 1000, 'accounts.js 不应被删');
  check(ACCOUNTS_JS.indexOf('s-accounts') >= 0, '账户页样式/结构仍应在位');
  check(ACCOUNTS_JS.indexOf('净资产') >= 0, '账户页净资产仍应在位');
});

console.log('');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
