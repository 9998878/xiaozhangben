'use strict';
/*
 * tests/nl-date.test.js
 * 自检脚本：nl.js 日期解析回归（2.27.1 修复两个 P1：
 *   ① 「上个月28号 / 本月5号 / 下个月1号」相对月后的日号被丢弃，静默记成同日上月/今天/同日下月；
 *   ② 「明年1月5日 / 去年12月25日」年份固定当前年，静默记错年份。）
 *
 * 运行：node tests/nl-date.test.js
 *
 * 加载方式：与 category-expansion.test.js 同款 node vm 沙箱——index.html 内联
 * money / dates / schema 三块 + js/modules/nl.js 整文件，全部真实源码执行。
 * 日期断言统一 today = '2026-11-06'（固定值，不读机器时钟）。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ============================== 极简测试骨架（与 category-expansion 同款） ============================== */

let passCount = 0;
let failCount = 0;
let noteCount = 0;

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

function note(msg) {
  noteCount += 1;
  console.log('  [NOTE] ' + msg);
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

/* 提取 index.html 的内联 <script> 块（按块头注释里的文件名锚点识别）。 */
function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const CORE_MARKERS = ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js'];
const sandbox = { console: console };
vm.createContext(sandbox);

for (const marker of CORE_MARKERS) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker.replace('js/core/', 'inline:') });
}

const nlSrc = fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8');
vm.runInContext(nlSrc, sandbox, { filename: 'js/modules/nl.js' });

const schema = sandbox.XZB.Core.schema;
const nlApi = sandbox.XZB.Core.nl;
if (!nlApi || typeof nlApi.parse !== 'function') {
  throw new Error('沙箱内 XZB.Core.nl 未就绪');
}

/* nl.parse 最小 ctx（模板同 category-expansion.test.js buildNlCtx，today 固定为 2026-11-06） */
function buildCtx() {
  return {
    today: '2026-11-06',
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

function parseDate(text) {
  const result = nlApi.parse(text, buildCtx());
  if (!result.ok) { throw new Error('parse(' + JSON.stringify(text) + ') 失败：' + result.code); }
  return result;
}

function assertDate(text, expected, label) {
  const r = parseDate(text);
  checkEq(r.draft.date, expected, label + '（' + text + '）');
  return r;
}

/* ============================== 用例 1：相对月 + 日号（2.27.1 P1 回归） ============================== */

section('用例 1：相对月 + 日号组合（「上个月28号」类输入，修复前红）');

test('1.1 「上个月28号午饭30」-> 2026-10-28，日号不残留备注、无日期警告', function () {
  const r = assertDate('上个月28号午饭30', '2026-10-28', '相对月+日号应取上月28日');
  check(r.warnings.indexOf('日期在今天之后') < 0, '不应有日期警告：' + JSON.stringify(r.warnings));
  check(r.draft.note.indexOf('28号') < 0, '日号不应残留在备注：' + JSON.stringify(r.draft.note));
});

test('1.2 「本月5号早饭12」-> 2026-11-05', function () {
  assertDate('本月5号早饭12', '2026-11-05', '本月+日号应取本月5日');
});

test('1.3 「下个月1号房租3500」-> 2026-12-01，且无「日期在今天之后」警告', function () {
  const r = assertDate('下个月1号房租3500', '2026-12-01', '下个月+日号应取下月1日');
  check(r.warnings.indexOf('日期在今天之后') < 0, '「下个月」不应触发未来警告：' + JSON.stringify(r.warnings));
});

test('1.4 「上个月的28号买水果40」-> 2026-10-28（「的」字变体）', function () {
  assertDate('上个月的28号买水果40', '2026-10-28', '「上个月的28号」应取上月28日');
});

test('1.5 「上月30号加油260」-> 2026-10-30（两字「上月」变体）', function () {
  assertDate('上月30号加油260', '2026-10-30', '「上月30号」应取上月30日');
});

test('1.6 「上个月31号还卡债2000」-> 2026-10-31（10月有31日，合法钳制边界）', function () {
  assertDate('上个月31号还卡债2000', '2026-10-31', '上月31日应合法采纳');
});

/* ============================== 用例 2：明年 / 去年（2.27.1 P1 回归） ============================== */

section('用例 2：明年 / 去年 + 月日（「明年1月5日」类输入，修复前红）');

test('2.1 「明年1月5日交学费3000」-> 2027-01-05，无未来警告', function () {
  const r = assertDate('明年1月5日交学费3000', '2027-01-05', '明年应取次年，非当前年');
  check(r.warnings.indexOf('日期在今天之后') < 0, '「明年」不应触发未来警告：' + JSON.stringify(r.warnings));
});

test('2.2 「去年12月25日买礼物180」-> 2025-12-25，无警告', function () {
  const r = assertDate('去年12月25日买礼物180', '2025-12-25', '去年应取上一年');
  check(r.warnings.indexOf('日期在今天之后') < 0, '去年日期为过去，不应有警告：' + JSON.stringify(r.warnings));
});

test('2.3 「明年的3月1日还房贷4200」-> 2027-03-01（「的」字变体）', function () {
  assertDate('明年的3月1日还房贷4200', '2027-03-01', '「明年的3月1日」应取次年3月1日');
});

test('2.4 「去年2月30日午饭20」非法日期不采纳，回落 ctx.today（与 md 现行为一致）', function () {
  assertDate('去年2月30日午饭20', '2026-11-06', '2月30日非法，不应被采纳');
});

/* ============================== 用例 3：既有行为守护（修复不得破坏） ============================== */

section('用例 3：既有日期行为守护');

test('3.1 「12月28日聚餐200」-> 2026-12-28（md 防双计不回归）', function () {
  assertDate('12月28日聚餐200', '2026-12-28', '绝对月日应保持原解析');
});

test('3.2 「3月5日午饭20」-> 2026-03-05（md 当前年）', function () {
  assertDate('3月5日午饭20', '2026-03-05', 'md 应取当前年');
});

test('3.3 「28号买菜45」-> 2026-11-28（裸日号当前月）', function () {
  assertDate('28号买菜45', '2026-11-28', '裸日号应取当前月');
});

test('3.4 「上个月买菜45」-> 2026-10-06（相对月单独出现，同日上月）', function () {
  assertDate('上个月买菜45', '2026-10-06', '「上个月」单独出现保持同日上月');
});

test('3.5 「2026年10月28日出差180」-> 2026-10-28（完整年月日优先）', function () {
  assertDate('2026年10月28日出差180', '2026-10-28', '完整年月日不受影响');
});

test('3.6 「2026-11-01 买书45」-> 2026-11-01（ISO 日期）', function () {
  assertDate('2026-11-01 买书45', '2026-11-01', 'ISO 日期不受影响');
});

test('3.7 「明天买咖啡25」-> 2026-11-07（相对日）', function () {
  assertDate('明天买咖啡25', '2026-11-07', '「明天」不受影响');
});

test('3.8 「下个月旅游预算800」-> 2026-12-06（相对月单独出现，同日下月）', function () {
  assertDate('下个月旅游预算800', '2026-12-06', '「下个月」单独出现保持同日下月');
});

/* ============================== 用例 4：「十分」不是金额（2.28.0） ============================== */

section('用例 4：「十分快 / 十分方便」不再被当成 0.10 元（2.28.0）');

test('4.1 「打车十分快」不产生金额', function () {
  const r = nlApi.parse('打车十分快', buildCtx());
  checkEq(r.ok, false, '应解析失败（没有金额）');
  checkEq(r.code, 'E_NL_NO_AMOUNT', '错误码应为 E_NL_NO_AMOUNT');
});

test('4.2 「充电十分方便」不产生金额', function () {
  const r = nlApi.parse('充电十分方便', buildCtx());
  checkEq(r.ok, false, '应解析失败（没有金额）');
  checkEq(r.code, 'E_NL_NO_AMOUNT', '错误码应为 E_NL_NO_AMOUNT');
});

/* ============================== 用例 5：parseAmount 单位矩阵（2.28.1，测试缺口 #8） ============================== */

section('用例 5：parseAmount 单位边界（元/块/毛/角/分/万/千/百/两/千分位/¥/负号）');

function amountOf(text) {
  const r = nlApi.parseAmount(text);
  if (!r || r.ok !== true) { throw new Error('parseAmount(' + JSON.stringify(text) + ') 失败：' + JSON.stringify(r)); }
  return r;
}

function amountFail(text) {
  const r = nlApi.parseAmount(text);
  check(r && r.ok === false, 'parseAmount(' + JSON.stringify(text) + ') 应失败，实际 ' + JSON.stringify(r));
}

test('5.1 裸数字与元/块/圆：12=1200 分，12.5元=1250，¥35=3500', function () {
  checkEq(amountOf('12').cents, 1200, '裸数字按元');
  checkEq(amountOf('12.5元').cents, 1250, '小数元');
  checkEq(amountOf('¥35').cents, 3500, '¥ 前缀');
});

test('5.2 块尾数：12块5=1250 分（12.5 元）', function () {
  checkEq(amountOf('12块5').cents, 1250, '「块+尾数」口语');
});

test('5.3 毛/角：5毛=50，3角=30，3毛5=35', function () {
  checkEq(amountOf('5毛').cents, 50, '毛=1/10 元');
  checkEq(amountOf('3角').cents, 30, '角=1/10 元');
  checkEq(amountOf('3毛5').cents, 35, '毛+尾分');
});

test('5.4 分：5分=5，50分=50（不乘 100）', function () {
  checkEq(amountOf('5分').cents, 5, '5 分就是 5 分');
  checkEq(amountOf('50分').cents, 50, '50 分就是 50 分');
});

test('5.5 万/千/百：12万=12000000，1万2=1200000，3千5=350000，5百=50000', function () {
  checkEq(amountOf('12万').cents, 12000000, '12 万元');
  checkEq(amountOf('1万2').cents, 1200000, '口语省位 1万2');
  checkEq(amountOf('3千5').cents, 350000, '口语省位 3千5');
  checkEq(amountOf('5百').cents, 50000, '5 百元');
});

test('5.6 中文数字与「两」：三十五=3500，两块=200', function () {
  checkEq(amountOf('三十五').cents, 3500, '中文数字');
  checkEq(amountOf('两块').cents, 200, '两=2');
});

test('5.7 千分位：1,234=123400（好千分位照常收）', function () {
  checkEq(amountOf('1,234').cents, 123400, '严格千分位');
});

test('5.8 负号与超上限必须失败：-5 → 拒收；11 位整数 → 超过 MAX_CENTS 拒收', function () {
  amountFail('-5');
  amountFail('99999999999');
});

test('5.9 「十分」豁免回归：打车十分快 无金额（2.28.0 修复在 parseAmount 层仍成立）', function () {
  amountFail('打车十分快');
});

test('5.10 坏千分位必须失败：1,2345 不再被按 1234 元静默收下（2.28.2）', function () {
  amountFail('1,2345');
  amountFail('12,3456');
});

/* ============================== 汇总 ============================== */

console.log('\n=========================================');
console.log('通过 ' + passCount + ' / 失败 ' + failCount + ' / 观察项 ' + noteCount);
if (failCount === 0) {
  console.log('总结论：全绿 PASS');
} else {
  console.log('总结论：存在 FAIL，见上方 [FAIL] 明细');
}
console.log('=========================================');
process.exit(failCount === 0 ? 0 : 1);
