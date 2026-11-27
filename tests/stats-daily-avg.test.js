'use strict';
/*
 * tests/stats-daily-avg.test.js
 * 自检脚本：统计页「日均支出」已过天数口径（2.44.5 回归）。
 *
 * 背景：2.40.0 合并时 summaryCard / buildReportPayload 的日均分母循环调用了
 * 不存在的 daysInMonth(mKey)（本文件助手函数名为 daysInMonthOf）。只要窗口里
 * 含非当前月（上月/历史月/近3/6个月），paintCards 即抛 ReferenceError，
 * 整页落成「解读暂时没有生成」错误卡。本月视图因 mKey === now 短路而幸免。
 *
 * 口径契约：
 *   - stats.js 全文不得出现裸 daysInMonth( 调用（助手名恒为 daysInMonthOf）。
 *   - 两处 elapsed 循环（收支摘要卡 + AI 报告 payload）行为：
 *     当前月计已过天数（todayStr 的日），历史月计整月天数；跨月窗口逐月累加。
 *   - 行为测试直接抽取源码中的真实循环与 daysInMonthOf 执行，
 *     回退成错误函数名会在 vm 里抛 ReferenceError 而红。
 *
 * 运行：node tests/stats-daily-avg.test.js（scripts/test.js 自动收集）
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const STATS_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'stats.js'), 'utf8');

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

/* ============================== 源码抽取 ============================== */

function sliceFn(src, header) {
  const start = src.indexOf(header);
  if (start < 0) { throw new Error('找不到函数：' + header); }
  const end = src.indexOf('\n  }', start);
  if (end < 0) { throw new Error('找不到函数结尾：' + header); }
  return src.slice(start, end + '\n  }'.length);
}

/* 两处 elapsed 循环：从 var elapsed = 0; 到 for 的闭合括号 */
function elapsedLoops(src) {
  const loops = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf('var elapsed = 0;', from);
    if (start < 0) { break; }
    const add = src.indexOf('elapsed +=', start);
    const end = src.indexOf('}', add);
    if (add < 0 || end < 0) { throw new Error('elapsed 循环结构不符合预期'); }
    loops.push(src.slice(start, end + 1));
    from = end + 1;
  }
  return loops;
}

const MONTH_RE_LINE = (/var MONTH_RE = [^\n]+/.exec(STATS_JS) || [])[0];
if (!MONTH_RE_LINE) { throw new Error('找不到 MONTH_RE 定义'); }
const HELPERS = [
  MONTH_RE_LINE,
  sliceFn(STATS_JS, 'function isMonth(value) {'),
  sliceFn(STATS_JS, 'function daysInMonthOf(month) {'),
].join('\n');
const LOOPS = elapsedLoops(STATS_JS);

/* 在沙箱里跑真实循环：months 为窗口月份，today 固定 2026-11-27 */
function runElapsed(loopSrc, months, today) {
  const sandbox = {
    report: { win: { months: months } },
    now: today.slice(0, 7),
    todayStr: function () { return today; },
    Date: Date,
    Number: Number,
    String: String,
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + loopSrc, sandbox, { filename: 'inline:stats-elapsed' });
  return sandbox.elapsed;
}

/* ============================== 用例 ============================== */

section('用例 1：源码锁——助手函数名一致');

test('1.1 全文无裸 daysInMonth( 调用（2.44.5 回归点）', function () {
  check(STATS_JS.indexOf('daysInMonth(') < 0, 'stats.js 出现未定义的 daysInMonth( 调用');
  check(STATS_JS.indexOf('function daysInMonthOf(month) {') >= 0, 'daysInMonthOf 助手缺失');
});

test('1.2 摘要卡与 AI payload 两处循环都在且用 daysInMonthOf', function () {
  checkEq(LOOPS.length, 2, 'elapsed 循环数量（summaryCard + buildReportPayload）');
  LOOPS.forEach(function (loop, i) {
    check(loop.indexOf('daysInMonthOf(mKey)') >= 0, '第 ' + (i + 1) + ' 处循环未用 daysInMonthOf');
  });
});

section('用例 2：行为——历史月按整月天数（抛错即红）');

test('2.1 上月窗口（2026-10）elapsed = 31', function () {
  LOOPS.forEach(function (loop, i) {
    checkEq(runElapsed(loop, ['2026-10'], '2026-11-27'), 31, '循环 ' + (i + 1) + ' 十月整月');
  });
});

test('2.2 当前月窗口（2026-11，今天 27 日）elapsed = 27', function () {
  LOOPS.forEach(function (loop, i) {
    checkEq(runElapsed(loop, ['2026-11'], '2026-11-27'), 27, '循环 ' + (i + 1) + ' 当月已过天数');
  });
});

test('2.3 近3个月（9/10/11 月）elapsed = 30+31+27 = 88', function () {
  LOOPS.forEach(function (loop, i) {
    checkEq(runElapsed(loop, ['2026-09', '2026-10', '2026-11'], '2026-11-27'), 88, '循环 ' + (i + 1) + ' 近3个月');
  });
});

test('2.4 近6个月（6–11 月）elapsed = 180', function () {
  LOOPS.forEach(function (loop, i) {
    checkEq(runElapsed(loop, ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'], '2026-11-27'), 180, '循环 ' + (i + 1) + ' 近6个月');
  });
});

test('2.5 闰年二月整月 = 29（2028-02）', function () {
  LOOPS.forEach(function (loop, i) {
    checkEq(runElapsed(loop, ['2028-02'], '2028-03-15'), 29, '循环 ' + (i + 1) + ' 闰年二月');
  });
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }