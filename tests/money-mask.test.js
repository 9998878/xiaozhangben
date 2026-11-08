'use strict';
/*
 * tests/money-mask.test.js
 * 自检脚本：2.30.0「金额眼罩」——Core.money.formatCents 的全局 hideAmounts 掩码。
 * 收尾半成品：schema/state 管道 2.29.x 前已存在，本版补 UI 与渲染消费。
 *
 * 运行：node tests/money-mask.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：money 内联块进 vm 沙箱，掩码读取 XZB.app.state.ui.hideAmounts
 * （防御式 try 读取），直接给沙箱注入 mock app 驱动真实实现。
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
const moneyBlock = findInlineBlock('js/core/money.js');
if (!moneyBlock) { throw new Error('找不到 money 内联块'); }
vm.runInContext(moneyBlock, sandbox, { filename: 'inline:js/core/money.js' });

function setHideAmounts(value) {
  sandbox.XZB.app = value === undefined
    ? undefined
    : { state: { ui: { hideAmounts: value } } };
}

const money = sandbox.XZB.Core.money;
if (!money || typeof money.formatCents !== 'function') {
  throw new Error('XZB.Core.money.formatCents 不可用');
}

/* ============================== 用例 ============================== */

section('用例 1：眼罩关闭（缺省）');
test('1.1 未设置 hideAmounts → 正常显示', function () {
  setHideAmounts(undefined);
  checkEq(money.formatCents(123456), '¥1,234.56', '正常金额');
});

test('1.2 hideAmounts=false → 正常显示', function () {
  setHideAmounts(false);
  checkEq(money.formatCents(123456), '¥1,234.56', 'false 不掩码');
});

section('用例 2：眼罩开启');
test('2.1 hideAmounts=true → 全部金额 ••••', function () {
  setHideAmounts(true);
  checkEq(money.formatCents(123456), '••••', '正数掩码');
  checkEq(money.formatCents(-50000), '••••', '负数掩码');
  checkEq(money.formatCents(0), '••••', '零掩码');
});

test('2.2 opts.hidden 直传仍然优先（原语义保留）', function () {
  setHideAmounts(false);
  checkEq(money.formatCents(123456, { hidden: true }), '••••', '直传 hidden');
});

test('2.3 掩码不影响非展示能力（解析/取整仍在）', function () {
  setHideAmounts(true);
  checkEq(money.parseAmount ? 'has-parse' : 'no-parse', 'has-parse', 'money 其余能力不受掩码影响');
  setHideAmounts(undefined);
});

section('用例 3：异常兜底');
test('3.1 XZB.app 异常形态（抛错）→ 不阻断显示', function () {
  sandbox.XZB.app = { get state() { throw new Error('boom'); } };
  checkEq(money.formatCents(123456), '¥1,234.56', 'state 读取抛错时正常显示');
  setHideAmounts(undefined);
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) { process.exit(1); }
