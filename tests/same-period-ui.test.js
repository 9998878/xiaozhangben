'use strict';
/*
 * tests/same-period-ui.test.js
 * 自检脚本：2.33.0「上月同期」环比口径——小助手洞察问答（行为）+ 统计页/解读页（源码锁）。
 *
 * 口径契约：
 *   - core-assistant buildMom：本月未过完时基期窗口裁到上月同日，文案写「上月同期」、
 *     assumption 注明「截至 N 日」；过去月保持整月对整月、不出现「同期」字样。
 *   - core-assistant buildCategory：多月窗口的对比基期裁到前窗末月同日。
 *   - stats.js：prevRank 传 endDay；排行 chip / 合计卡 / 本月小结在 isPartial 时写「同期」。
 *   - insights.js：collect 收入项带 type；summarize 支持窗口末月 cutDate；
 *     buildReport 传 cutDate；摘要 label「支出较上月同期」。
 *   - ai-insights.js 已是同期口径（2.32.9），由 tests/ai-insights.test.js 覆盖，此处不重复。
 *
 * 运行：node tests/same-period-ui.test.js（scripts/test.js 自动收集）
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CA_JS = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'core-assistant.js'), 'utf8');
const STATS_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'stats.js'), 'utf8');
const INSIGHTS_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'insights.js'), 'utf8');

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

function lock(cond, label) {
  if (!cond) { throw new Error('源码锁失效：' + label); }
}

/* ============================== 沙箱（同 ai-preset 范式） ============================== */

function makeLS() {
  const m = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; }
  };
}

const sandbox = {
  console,
  fetch() { return Promise.reject(new Error('sandbox: no network')); },
  AbortController,
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Promise,
  Math,
  Number,
  String,
  Object,
  Array,
  isFinite,
  localStorage: makeLS()
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(CA_JS, sandbox, { filename: 'js/modules/core-assistant.js' });

const qa = (sandbox.XZB.core && sandbox.XZB.core.insightqa) ||
  (sandbox.XZB.Core && sandbox.XZB.Core.insightqa);
if (!qa || typeof qa.build !== 'function') {
  throw new Error('core.insightqa 不可用');
}

/* ============================== 固定数据 ============================== */

const BK = 'bk1';

function baseModel() {
  return {
    books: [{ id: BK, name: '日常', kind: 'daily', archived: false }],
    accounts: [{ id: 'ac1', name: '微信', type: 'wechat' }],
    categories: [
      { id: 'ca_food', kind: 'expense', name: '餐饮' },
      { id: 'ca_transport', kind: 'expense', name: '交通' }
    ],
    transactions: [],
    budgets: [],
    categoryBudgets: []
  };
}

function tx(id, date, cents, categoryId) {
  return {
    id: id,
    bookId: BK,
    type: 'expense',
    amountCents: cents,
    accountId: 'ac1',
    toAccountId: null,
    categoryId: categoryId || 'ca_food',
    date: date,
    time: '12:00',
    note: '',
    tags: [],
    photoIds: [],
    source: 'manual',
    deleted: false,
    excludeStats: false
  };
}

/* 10 月上旬 1000 + 10 月下旬 500 + 11 月 300：月中基期只该看到 1000 */
function midMonthModel() {
  const model = baseModel();
  model.transactions.push(tx('a1', '2026-10-05', 100000));
  model.transactions.push(tx('a2', '2026-10-20', 50000, 'ca_transport'));
  model.transactions.push(tx('b1', '2026-11-03', 30000));
  return model;
}

function makeCx(model, today) {
  return {
    db: model,
    bookId: BK,
    today: today,
    settings: {},
    readonly: true,
    accounts: model.accounts,
    categories: model.categories
  };
}

/* ============================== 用例 ============================== */

section('用例 1：小助手 buildMom 月中 = 上月同期');

test('1.1 基期裁到上月同日，文案写「上月同期」并注明截止日', function () {
  const cx = makeCx(midMonthModel(), '2026-11-14');
  const r = qa.build({ type: 'mom', month: '2026-11' }, cx);
  checkEq(r.ok, true, '应答成功');
  check(r.reply.text.indexOf('2026年10月同期') >= 0, '正文基期写「上月同期」：' + r.reply.text);
  check(r.reply.text.indexOf('少') >= 0, '同期对比方向为「少」（300 对 1000）');
  checkEq(r.reply.metrics[1].label, '2026年10月同期支出', 'metrics 基期 label');
  check(r.reply.assumption.indexOf('截至 14 日') >= 0, 'assumption 注明同期截止日：' + r.reply.assumption);
  check(r.reply.assumption.indexOf('同期') >= 0, 'assumption 写明同期口径');
  check(r.reply.scope.indexOf('2026年10月同期') >= 0, 'scope 写明同期基期');
});

test('1.2 基期金额只含上月同期（不上月整月）', function () {
  const cx = makeCx(midMonthModel(), '2026-11-14');
  const r = qa.build({ type: 'mom', month: '2026-11' }, cx);
  /* 300 对 1500（整月）是 -80%，对 1000（同期）是 -70%：正文按同期应报 70% */
  check(r.reply.text.indexOf('70%') >= 0, '百分比按同期口径（70%）而非整月（80%）：' + r.reply.text);
});

section('用例 2：小助手 buildMom 过去月 = 整月对整月（行为不变）');

test('2.1 10 月看 10 月，基期 9 月整月，不出现「同期」', function () {
  const model = midMonthModel();
  model.transactions.push(tx('c1', '2026-09-12', 200000));
  const cx = makeCx(model, '2026-11-14');
  const r = qa.build({ type: 'mom', month: '2026-10' }, cx);
  checkEq(r.ok, true, '应答成功');
  check(r.reply.text.indexOf('比2026年9月少') >= 0, '基期写上月月份本身：' + r.reply.text);
  check(r.reply.text.indexOf('同期') < 0, '过去月正文不出现「同期」');
  check(r.reply.assumption.indexOf('截至') < 0, '过去月 assumption 不注截止日');
  check(r.reply.assumption.indexOf('2026年10月 vs 2026年9月') >= 0, 'assumption 保持整月口径：' + r.reply.assumption);
});

section('用例 3：小助手 buildCategory 多月窗口基期裁末月同日');

test('3.1 本月未过完：前一同长窗口末月裁到同日', function () {
  /* 餐饮：10月5日 1000 + 10月20日 400 + 11月3日 300；交通仅 11月2日 80 */
  const model = baseModel();
  model.transactions.push(tx('a1', '2026-10-05', 100000, 'ca_food'));
  model.transactions.push(tx('a2', '2026-10-20', 40000, 'ca_food'));
  model.transactions.push(tx('b1', '2026-11-03', 30000, 'ca_food'));
  model.transactions.push(tx('b2', '2026-11-02', 8000, 'ca_transport'));
  const cx = makeCx(model, '2026-11-14');
  const r = qa.build({ type: 'category', month: '2026-11', months: 1, categoryId: 'ca_food', categoryName: '餐饮' }, cx);
  checkEq(r.ok, true, '餐饮应答成功：' + (r && r.message || ''));
  check(r.reply.text.indexOf('（截至 14 日）') >= 0, '正文注明同日截止：' + r.reply.text);
  check(r.reply.assumption.indexOf('截至 14 日') >= 0, 'assumption 注明：' + r.reply.assumption);
  /* 同期基期 = 1000（10-20 的 400 不计）：少 700（70%）；若整月口径会是少 1100（78.6%） */
  check(r.reply.text.indexOf('少 ¥700.00（70%）') >= 0, '餐饮同期对比金额：' + r.reply.text);
  /* 交通基期同期 = 0：按既有防除零设计不输出对比句 */
  const r2 = qa.build({ type: 'category', month: '2026-11', months: 1, categoryId: 'ca_transport', categoryName: '交通' }, cx);
  checkEq(r2.ok, true, '交通应答成功：' + (r2 && r2.message || ''));
  check(r2.reply.text.indexOf('比上一同长窗口') < 0, '基期无流水时不输出对比句：' + r2.reply.text);
});

section('用例 4：统计页 stats.js 源码锁');

test('4.1 prevRank 传 endDay，chip/合计/小结写「同期」', function () {
  lock(STATS_JS.indexOf('endDay: prevEndDay') >= 0, 'prevRank 应传 endDay');
  lock(STATS_JS.indexOf("var samePeriod = mom.isPartial === true && mom.periodDay > 0;") >= 0, 'samePeriod 取自核心 mom');
  lock(STATS_JS.indexOf("'较上月' + (samePeriod ? '同期' : '')") >= 0, '排行 chip/aria 基期措辞');
  lock(STATS_JS.indexOf("mom && mom.isPartial === true ? '同期' : ''") >= 0, '合计卡 pill 基期措辞');
  lock(STATS_JS.indexOf("'收入较上月' + (mom.isPartial === true ? '同期' : '')") >= 0, '收入 meta 措辞');
  lock(STATS_JS.indexOf("'支出较上月' + (mom.isPartial === true ? '同期' : '')") >= 0, '支出 meta 措辞');
  lock(STATS_JS.indexOf("? '上月同期' : '上月'") >= 0, '本月小结基期措辞');
  lock(STATS_JS.indexOf('raw === null || raw === undefined ? null : Number(raw)') >= 0, '小结基期 0 时不误报「持平」（Number(null) 陷阱）');
});

section('用例 5：解读页 insights.js 源码锁');

test('5.1 collect 收入项、summarize cutDate、buildReport 同期接线', function () {
  lock(INSIGHTS_JS.indexOf("type: 'income'") >= 0, 'collect 应推送带 type 的收入项');
  lock(INSIGHTS_JS.indexOf("type: 'expense'") >= 0, '支出项应带 type 标记');
  lock(INSIGHTS_JS.indexOf('var income = item.type === \'income\';') >= 0, 'summarize 按 type 分流');
  lock(INSIGHTS_JS.indexOf('clampLast') >= 0, 'summarize 窗口末月裁剪标记');
  lock(INSIGHTS_JS.indexOf('meta, cutDate') >= 0, 'prev summarize 传入 cutDate');
  lock(INSIGHTS_JS.indexOf('var same = samePeriodOf(anchor);') >= 0, 'buildReport 推导同期状态');
  lock(INSIGHTS_JS.indexOf('isPartial: same.isPartial') >= 0, 'report 暴露 isPartial');
  lock(INSIGHTS_JS.indexOf("report.isPartial ? '支出较上月同期' : '支出环比'") >= 0, '摘要 label 同期措辞');
  lock(INSIGHTS_JS.indexOf("'上月同期' : '上月'") >= 0, '追问标题基期措辞');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
