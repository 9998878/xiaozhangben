'use strict';
/*
 * tests/nl-alnum-amount.test.js
 * 2.38.1 回归：nl 解析器三个静默错误。
 *
 *  1) 数字后紧跟 ASCII 字母不是金额：旧版只挡了「字母在前」（iPhone15），
 *     「3D电影 / 2K显示器 / 5G流量 / 1w / 1e3」被记成 3 元 / 2 元 / 5 元 / 1 元。
 *     小助手「极速直记」默认开，说得清就直接入账——这是会记错账的静默错误。
 *  2) 阿拉伯数字接「亿」：旧版量级分支只有万/千/百，「1亿」被当成 1 元。
 *  3) 「大后天」：旧版日期词只认到「后天」，日期差一天且备注里残留一个「大」。
 *
 * 运行：node tests/nl-alnum-amount.test.js（scripts/test.js 自动收集）
 * 沙箱装配与 tests/nl-golden.test.js 同款，today 固定 '2026-11-23'（周一）。
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker });
}
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8'), sandbox, { filename: 'js/modules/nl.js' });

const nl = sandbox.XZB.Core.nl;
const schema = sandbox.XZB.Core.schema;
if (!nl || typeof nl.parse !== 'function') { throw new Error('沙箱内 nl 未就绪'); }

const TODAY = '2026-11-23'; /* 周一 */

function buildCtx() {
  return {
    today: TODAY,
    nowTime: '12:00',
    accounts: [{
      id: 'ac_cash', name: '现金', type: 'cash', icon: 'wallet', color: '#34C759',
      openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null,
      archived: false, sort: 10, note: ''
    }],
    categories: schema.seedData().categories,
    defaults: { type: 'expense' }
  };
}

function parse(text) {
  return nl.parse(text, buildCtx());
}

/* 没有「说得清」的金额：必须报「没听清金额」，绝不能 ok */
function expectNoAmount(text) {
  const r = parse(text);
  check(r && r.ok === false, '「' + text + '」不该解析成功，实际 ' + JSON.stringify(r && r.best && r.best.cents));
  checkEq(r.code, 'E_NL_NO_AMOUNT', '「' + text + '」错误码');
}

function expectCents(text, cents) {
  const r = parse(text);
  check(r && r.ok && r.best, '「' + text + '」应解析成功：' + JSON.stringify(r && r.code));
  checkEq(r.best.cents, cents, '「' + text + '」金额（分）');
  return r;
}

/* ============================== 用例 ============================== */

section('用例 1：数字后紧跟 ASCII 字母不是金额（2.38.1）');

test('1.1 型号/规格里的数字：3D / 2K / 4K / 5G / 2L / 2B 一律判没听清金额', function () {
  ['看3D电影', '买2K显示器', '买了5G流量', '买4K线', '买水2L', '买2B铅笔', '小米15W充电器'].forEach(expectNoAmount);
});

test('1.2 网络量级写法 1w / 1W / 1k / 1e3 不再当成 1 元', function () {
  ['打车1w', '打车1W', '打车1k', '打车1e3'].forEach(expectNoAmount);
});

test('1.3 同句里有真金额时只认真金额，备注保留完整原词', function () {
  const a = expectCents('打3D台球50', 5000);
  checkEq(a.candidates.length, 1, '候选只剩 50 一个');
  checkEq(a.best.note, '打3D台球', '备注保留 3D');
  const b = expectCents('昨天3D电影45', 4500);
  checkEq(b.best.date, '2026-11-22', '日期不受影响');
  checkEq(b.best.note, '3D电影', '备注保留 3D电影');
});

test('1.4 带小数也不放过：5.5G / 1.5T 不是金额', function () {
  ['买了5.5G流量包', '买1.5T硬盘'].forEach(expectNoAmount);
});

test('1.5 回归：字母在前的老口径不变', function () {
  const r = expectCents('iphone17八千', 800000);
  checkEq(r.best.note, 'iphone17', 'iphone17 留在备注');
});

section('用例 2：阿拉伯数字接「亿」（2.38.1）');

test('2.1 1亿 = 100000000 元，备注不残留「亿」', function () {
  const r = expectCents('打车1亿', 10000000000);
  checkEq(r.best.note, '打车', '备注');
});

test('2.2 口语尾数：2亿5 = 2.5 亿', function () {
  expectCents('打车2亿5', 25000000000);
});

test('2.3 1亿2千万 = 1.2 亿', function () {
  expectCents('打车1亿2千万', 12000000000);
});

test('2.4 回归：万/千/百 口径不变', function () {
  expectCents('打车1万5', 1500000);
  expectCents('打车3千5', 350000);
  expectCents('打车12万', 12000000);
  expectCents('打车3千', 300000);
});

section('用例 3：「大后天」整体识别（2.38.1）');

test('3.1 大后天 = 今天 +3，备注不残留「大」', function () {
  const r = expectCents('大后天午饭28', 2800);
  checkEq(r.best.date, '2026-11-26', '日期');
  checkEq(r.best.note, '午饭', '备注');
});

test('3.2 大后天属于明确的将来日期，不报「日期在今天之后」', function () {
  const r = parse('大后天午饭28');
  const warnings = (r.best && r.best.warnings) || [];
  check(warnings.indexOf('日期在今天之后') < 0, '不该有「日期在今天之后」，实际 ' + JSON.stringify(warnings));
});

test('3.3 回归：大前天 / 后天 / 明天 不变', function () {
  checkEq(expectCents('大前天午饭28', 2800).best.date, '2026-11-20', '大前天');
  checkEq(expectCents('后天午饭28', 2800).best.date, '2026-11-25', '后天');
  checkEq(expectCents('明天午饭28', 2800).best.date, '2026-11-24', '明天');
});

section('用例 4：常规记账回归（确认修复没有误伤）');

test('4.1 普通金额、中文数字、量词、尾数', function () {
  expectCents('午饭28', 2800);
  expectCents('咖啡9.9', 990);
  expectCents('12块5打车', 1250);
  expectCents('苹果13手机壳50', 5000);
  expectCents('买3杯奶茶39', 3900);
  expectCents('充话费100送20', 2000);
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
