'use strict';
/*
 * tests/ai-insights.test.js
 * 自检脚本：AI 月度解读核心逻辑行为测试（2.28.1，彻查报告测试缺口 #1/#2/#3/#6/#7）。
 *
 * 覆盖：
 *   - buildMonthlyMetrics 五道过滤（软删/非法type/amount<=0/坏日期/跨账本）
 *     与口径（transfer 只看还款流向、收入直记 credit 也是还款、null 语义、ma3 门）
 *   - toInsightPayload 隐私边界（经 requestAiInsights 假 chat 捕获请求体：
 *     无 *Id/note/photo、金额两位小数、oneTimeItems/anomalies 形状）
 *   - requestAiInsights 状态机（守卫三元组 / 400 剥 extraBody 重试 / 超时限流重试
 *     + onRetry 计次 / 永不 reject / E_AS_NET_CONFIG 归 config）
 *   - buildFallbackInsights 四规则（负结余/以贷养贷/必要未覆盖/缓冲不足 + 空入参）
 *   - 连续超支链 consecutiveMonths 1/2/3（含「上月无预算链断」）
 *
 * 运行：node tests/ai-insights.test.js
 *
 * 加载方式：node vm 沙箱——index.html 内联 money/dates/schema 三块 + js/modules/ai-insights.js
 * 整文件；XZB.core 别名后 stub dates.todayStr（固定 2026-11-06）与 stats.accountBalances
 * （确定性缓冲值）。全程不碰网络与真实时钟。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ============================== 极简测试骨架（支持异步，同 ai-config） ============================== */

let passCount = 0;
let failCount = 0;
let currentSection = '';

function section(title) { currentSection = title; }

async function test(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failCount += 1;
    console.log('  [FAIL] ' + name);
    console.log('         -> ' + (e && e.message ? e.message : String(e)));
  }
}

const CASES = [];
function regCase(name, fn) { CASES.push([currentSection, name, fn]); }

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

const CORE_MARKERS = ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js'];
const sandbox = { console, Date, JSON, Promise, Math, Number, String, Object, Array, isFinite };
sandbox.global = sandbox;
vm.createContext(sandbox);

for (const marker of CORE_MARKERS) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker.replace('js/core/', 'inline:') });
}
/* 模块文件挂载在 XZB.Core，业务代码统一走 XZB.core.* 懒取——沙箱里手工建立同一别名 */
vm.runInContext('XZB.core = XZB.Core;', sandbox, { filename: 'inline:core-alias' });

const aiSrc = fs.readFileSync(path.join(ROOT, 'js/modules/ai-insights.js'), 'utf8');
vm.runInContext(aiSrc, sandbox, { filename: 'js/modules/ai-insights.js' });

const schema = sandbox.XZB.Core.schema;
const aiInsights = sandbox.XZB.Core.aiInsights;
if (!aiInsights || typeof aiInsights.buildMonthlyMetrics !== 'function') {
  throw new Error('沙箱内 XZB.Core.aiInsights 未就绪');
}

/* 固定「今天」：missingDays / 异常大额日均分母 / ma3 判据全部依赖它。
 * dates 的 api 对象被冻结，整体替换槽位（ai-insights 只消费 todayStr）。 */
sandbox.XZB.Core.dates = { todayStr: function () { return '2026-11-06'; } };
/* 确定性缓冲：ac_cash 可动用 3000 分（stats 块不加载，用同形状桩替代 accountBalances(db)） */
sandbox.XZB.Core.stats = { accountBalances: function () { return { ac_cash: 3000 }; } };

/* ============================== 装置 ============================== */

const FIXED_AT = '2026-01-01T00:00:00+08:00';
const BOOK = 'bk_test';

function buildDb() {
  const db = schema.createDb(FIXED_AT);
  db.accounts = [
    { id: 'ac_cash', name: '现金', type: 'cash', icon: 'wallet', color: '#34C759',
      openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 10, note: '' },
    { id: 'ac_credit', name: '信用卡', type: 'credit', icon: 'wallet', color: '#FF9500',
      openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 20, note: '' }
  ];
  db.transactions = [];
  db.categoryBudgets = [];
  return db;
}

function tx(partial) {
  return Object.assign({
    id: 'tx_' + Math.random().toString(36).slice(2, 8),
    type: 'expense',
    amountCents: 1000,
    date: '2026-11-03',
    bookId: BOOK,
    accountId: 'ac_cash',
    categoryId: 'ca_haircut',
    note: ''
  }, partial);
}

/* 标准月：本月理发 3000 + 异常大额 60000（>3×日均）+ 奖金收入 100000（一次性） */
function buildRichDb() {
  const db = buildDb();
  db.transactions = [
    tx({ categoryId: 'ca_haircut', amountCents: 3000, date: '2026-11-02' }),
    tx({ categoryId: 'ca_digital', amountCents: 60000, date: '2026-11-05', note: '相机镜头' }),
    tx({ type: 'income', accountId: 'ac_cash', categoryId: 'ca_bonus', amountCents: 100000, date: '2026-11-01' })
  ];
  return db;
}

function buildMetrics(db) {
  const m = aiInsights.buildMonthlyMetrics(db, '2026-11', BOOK);
  if (!m) { throw new Error('buildMonthlyMetrics 返回 null（装置损坏）'); }
  return m;
}

/* 假 assistant：脚本化 llm.chat 序列，记录每次调用（messages/opts） */
function fakeAssistant(script) {
  const calls = [];
  let i = 0;
  return {
    calls: calls,
    assistant: {
      llm: {
        getConfig: function () { return { ok: true, cfg: { ready: true } }; },
        chat: function (messages, opts) {
          /* 快照：requestAiInsights 会在 400 后原地改写 currentOpts.extraBody，
             记录引用会看不到首次调用的真实形状 */
          calls.push({ messages: messages, opts: JSON.parse(JSON.stringify(opts || {})) });
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          return Promise.resolve(typeof step === 'function' ? step(calls.length) : step);
        }
      }
    }
  };
}

const AI_OK_JSON = {
  ok: true,
  json: { choices: [{ message: { content:
    '[{"level":"red","category":"测试","title":"标题","evidence":["证据"],"suggestion":"建议"}]' } }] }
};

async function withAssistant(fake, fn) {
  const prev = sandbox.XZB.core.assistant;
  sandbox.XZB.core.assistant = fake.assistant;
  try { return await fn(fake); }
  finally { sandbox.XZB.core.assistant = prev; }
}

/* ============================== 用例 1：buildMonthlyMetrics 五道过滤与口径 ============================== */

section('用例 1：buildMonthlyMetrics 五道过滤与口径');

regCase('1.1 软删（deleted===true）不进任何桶', function () {
  const db = buildDb();
  db.transactions = [
    tx({ amountCents: 5000, deleted: true }),
    tx({ amountCents: 2000 })
  ];
  const m = buildMetrics(db);
  checkEq(m.cashflow.expenseCents, 2000, '只有未删的一笔计入支出');
  checkEq(m.dataQuality.txCount, 1, 'txCount 只数本月有效笔数');
});

regCase('1.2 非法 type / amount<=0 / 坏日期 / 跨账本 四道过滤', function () {
  const db = buildDb();
  db.transactions = [
    tx({ type: 'weird', amountCents: 1000 }),            /* 非法 type */
    tx({ amountCents: 0 }),                              /* 0 */
    tx({ amountCents: -500 }),                           /* 负数 */
    tx({ date: '2026-13-40', amountCents: 1000 }),       /* 坏日期 */
    tx({ date: 'not-a-date', amountCents: 1000 }),       /* 非日期串 */
    tx({ bookId: 'bk_other', amountCents: 9000 }),       /* 跨账本 */
    tx({ amountCents: 1500 })                            /* 唯一有效 */
  ];
  const m = buildMetrics(db);
  checkEq(m.cashflow.expenseCents, 1500, '六笔脏数据全部过滤，只剩一笔');
  checkEq(m.dataQuality.txCount, 1, 'txCount=1');
});

regCase('1.3 transfer 不计收支；流入 credit 才记还款', function () {
  const db = buildDb();
  db.transactions = [
    tx({ type: 'transfer', amountCents: 8000, toAccountId: 'ac_credit' }),  /* 还信用卡 */
    tx({ type: 'transfer', amountCents: 5000, toAccountId: 'ac_cash' })     /* 转自己储蓄卡 */
  ];
  const m = buildMetrics(db);
  checkEq(m.cashflow.incomeCents, 0, 'transfer 不计收入');
  checkEq(m.cashflow.expenseCents, 0, 'transfer 不计支出');
  checkEq(m.debt.monthlyRepaymentCents, 8000, '只有流入 credit 的 transfer 记还款');
  checkEq(m.cashflow.creditInflowCents, 0, 'transfer 不算新增透支');
});

regCase('1.4 收入直记 credit 账户也算还款；credit 上的支出记新增透支', function () {
  const db = buildDb();
  db.transactions = [
    tx({ type: 'income', accountId: 'ac_credit', amountCents: 6000, categoryId: 'ca_other_income' }),
    tx({ accountId: 'ac_credit', amountCents: 4000, categoryId: 'ca_digital' })
  ];
  const m = buildMetrics(db);
  checkEq(m.cashflow.incomeCents, 6000, '收入照常计入');
  checkEq(m.debt.monthlyRepaymentCents, 6000, '收入直记 credit 记还款');
  checkEq(m.cashflow.creditInflowCents, 4000, 'credit 支出记新增透支');
});

regCase('1.5 null 语义：income=0 储蓄率 null；prev=0 环比 pct null；不足 3 个月 ma3 null', function () {
  const db = buildDb(); /* 本月仅一笔享受型支出：无收入、无上月、必要支出为 0 */
  db.transactions = [tx({ amountCents: 2000, categoryId: 'ca_game' })];
  const m = buildMetrics(db);
  checkEq(m.cashflow.savingsRate, null, 'income=0 → savingsRate null');
  checkEq(m.trends.mom.expense.deltaPct, null, 'prev=0 → deltaPct null');
  checkEq(m.trends.ma3, null, '最早有账月=本月 → ma3 null');
  checkEq(m.buffer.monthsCovered, null, 'necessary=0 → monthsCovered null');
});

regCase('1.6 ma3 门：最早有账月 ≤ 上上月才出 ma3', function () {
  const db = buildDb();
  db.transactions = [
    tx({ amountCents: 1000, date: '2026-09-02' }),
    tx({ amountCents: 2000, date: '2026-10-02' }),
    tx({ amountCents: 3000, date: '2026-11-02' })
  ];
  const m = buildMetrics(db);
  check(m.trends.ma3 !== null, '三个月有账应有 ma3');
  checkEq(m.trends.ma3.expenseCents, 2000, '三个月均值 (1000+2000+3000)/3');
});

/* ============================== 用例 2：toInsightPayload 隐私边界（经假 chat 捕获） ============================== */

section('用例 2：toInsightPayload 隐私边界（请求体不得含 id/note/照片）');

regCase('2.1 请求体 JSON 不含任何 *Id / note / photo 键（递归检查）', async function () {
  const m = buildMetrics(buildRichDb());
  const fake = fakeAssistant([AI_OK_JSON]);
  await withAssistant(fake, function () { return aiInsights.requestAiInsights(m, {}); });
  checkEq(fake.calls.length, 1, '恰好发出一次请求');
  const payload = JSON.parse(fake.calls[0].messages[1].content);
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        check(/Id$/.test(k) === false, '请求体不得含 *Id 键：' + k);
        check(k !== 'note' && k !== 'photo' && k !== 'photos', '请求体不得含 note/photo 键：' + k);
        walk(node[k]);
      }
    }
  })(payload);
});

regCase('2.2 oneTimeItems ≤5 且每项只含 name/amount/date；anomalies ≤5 且只含 date/amount/categoryName', async function () {
  const m = buildMetrics(buildRichDb());
  const fake = fakeAssistant([AI_OK_JSON]);
  await withAssistant(fake, function () { return aiInsights.requestAiInsights(m, {}); });
  const payload = JSON.parse(fake.calls[0].messages[1].content);
  const oti = payload.income.oneTimeItems;
  check(Array.isArray(oti) && oti.length <= 5, 'oneTimeItems ≤5');
  checkEq(oti.length, 1, '装置里恰一笔一次性收入（奖金）');
  checkEq(JSON.stringify(Object.keys(oti[0]).sort()), JSON.stringify(['amount', 'date', 'name']), 'oneTimeItems 只含 name/amount/date');
  const ano = payload.trends.anomalies;
  check(Array.isArray(ano) && ano.length <= 5, 'anomalies ≤5');
  checkEq(ano.length, 1, '装置里恰一笔异常大额（600 元 > 3×日均）');
  checkEq(JSON.stringify(Object.keys(ano[0]).sort()), JSON.stringify(['amount', 'categoryName', 'date']), 'anomalies 只含 date/amount/categoryName（note 必须剥离）');
});

regCase('2.3 金额全部换算为「元、保留 2 位小数」的字符串', async function () {
  const m = buildMetrics(buildRichDb());
  const fake = fakeAssistant([AI_OK_JSON]);
  await withAssistant(fake, function () { return aiInsights.requestAiInsights(m, {}); });
  const payload = JSON.parse(fake.calls[0].messages[1].content);
  checkEq(payload.unit, '元，保留2位小数', 'unit 声明');
  checkEq(payload.cashflow.income, '1000.00', '收入 100000 分 → "1000.00"');
  checkEq(payload.cashflow.expense, '630.00', '支出 63000 分 → "630.00"');
});

/* ============================== 用例 3：requestAiInsights 状态机 ============================== */

section('用例 3：requestAiInsights 状态机（守卫 / 重试 / 永不 reject）');

regCase('3.1 守卫三元组：坏形状 bad、空账期 empty、llm 缺失或未 ready config', async function () {
  checkEq((await aiInsights.requestAiInsights(null, {})).reason, 'bad', 'metrics=null');
  checkEq((await aiInsights.requestAiInsights({ month: '2026-11' }, {})).reason, 'bad', '缺 dataQuality');
  const empty = { month: '2026-11', dataQuality: { txCount: 0 } };
  checkEq((await aiInsights.requestAiInsights(empty, {})).reason, 'empty', 'txCount=0 不发请求');
  const rich = buildMetrics(buildRichDb());
  const prev = sandbox.XZB.core.assistant;
  sandbox.XZB.core.assistant = null;
  try {
    checkEq((await aiInsights.requestAiInsights(rich, {})).reason, 'config', 'assistant 缺失');
  } finally { sandbox.XZB.core.assistant = prev; }
  await withAssistant(fakeAssistant([AI_OK_JSON]), function () { /* 占位 */ });
  const notReady = { llm: { getConfig: function () { return { ok: true, cfg: { ready: false } }; }, chat: function () { throw new Error('不应出网'); } } };
  sandbox.XZB.core.assistant = notReady;
  try {
    checkEq((await aiInsights.requestAiInsights(rich, {})).reason, 'config', 'ready=false 不出网');
  } finally { sandbox.XZB.core.assistant = prev; }
});

regCase('3.2 400 → 剥 enable_thinking 重试一次，第二次成功即出货', async function () {
  const m = buildMetrics(buildRichDb());
  const fake = fakeAssistant([{ ok: false, status: 400, code: 'E_AS_NET_BAD' }, AI_OK_JSON]);
  const res = await withAssistant(fake, function () { return aiInsights.requestAiInsights(m, {}); });
  checkEq(fake.calls.length, 2, '恰好重试一次');
  checkEq(fake.calls[0].opts.extraBody.enable_thinking, false, '首次带 enable_thinking:false');
  check(fake.calls[1].opts.extraBody == null || fake.calls[1].opts.extraBody.enable_thinking === undefined,
    '重试必须剥掉 enable_thinking，实际 ' + JSON.stringify(fake.calls[1].opts.extraBody));
  checkEq(res.ok, true, '重试成功出货');
});

regCase('3.3 超时 → onRetry 计 1 次后重试；重试再超时则终态 timeout 且不再重试', async function () {
  const m = buildMetrics(buildRichDb());
  let retries = 0;
  const fake = fakeAssistant([{ ok: false, code: 'E_AS_NET_TIMEOUT' }, { ok: false, code: 'E_AS_NET_TIMEOUT' }]);
  const res = await withAssistant(fake, function () {
    return aiInsights.requestAiInsights(m, { onRetry: function () { retries += 1; } });
  });
  checkEq(fake.calls.length, 2, '超时重试恰一次');
  checkEq(retries, 1, 'onRetry 恰回调一次');
  checkEq(res.ok, false, '终态失败');
  checkEq(res.reason, 'timeout', '终态 reason=timeout');
});

regCase('3.4 限流重试一次后仍 rate → 终态 rate', async function () {
  const m = buildMetrics(buildRichDb());
  const fake = fakeAssistant([{ ok: false, code: 'E_AS_NET_RATE' }, { ok: false, code: 'E_AS_NET_RATE' }]);
  const res = await withAssistant(fake, function () { return aiInsights.requestAiInsights(m, {}); });
  checkEq(fake.calls.length, 2, '限流重试恰一次');
  checkEq(res.reason, 'rate', '终态 reason=rate');
});

regCase('3.5 E_AS_NET_CONFIG（401/403/404 等）应归 config 桶，不得落 bad（2.28.1 修复）', async function () {
  const m = buildMetrics(buildRichDb());
  const fake = fakeAssistant([{ ok: false, code: 'E_AS_NET_CONFIG' }]);
  const res = await withAssistant(fake, function () { return aiInsights.requestAiInsights(m, {}); });
  checkEq(res.reason, 'config', '配置类失败应归 config，当前 ' + JSON.stringify(res));
});

regCase('3.6 chat 抛异常 → 永不 reject，终态 bad', async function () {
  const m = buildMetrics(buildRichDb());
  const boom = { llm: { getConfig: function () { return { ok: true, cfg: { ready: true } }; }, chat: function () { throw new Error('sandbox boom'); } } };
  const res = await withAssistant({ assistant: boom }, function () { return aiInsights.requestAiInsights(m, {}); });
  checkEq(res.ok, false, '不抛出');
  checkEq(res.reason, 'bad', '终态 reason=bad');
});

/* ============================== 用例 4：buildFallbackInsights 四规则 ============================== */

section('用例 4：buildFallbackInsights 四规则');

regCase('4.1 非法入参一律 []', function () {
  checkEq(JSON.stringify(aiInsights.buildFallbackInsights(null)), '[]', 'null');
  checkEq(JSON.stringify(aiInsights.buildFallbackInsights('x')), '[]', '字符串');
  checkEq(JSON.stringify(aiInsights.buildFallbackInsights({})), '[]', '缺 cashflow');
  checkEq(JSON.stringify(aiInsights.buildFallbackInsights({ cashflow: 'x' })), '[]', 'cashflow 非对象');
});

regCase('4.2 结余为负 → 红旗 1 条（享受型建议分支）', function () {
  const out = aiInsights.buildFallbackInsights({
    cashflow: { incomeCents: 100000, expenseCents: 120000, netCents: -20000 },
    structure: { enjoymentCents: 8000 }
  });
  checkEq(out.length, 1, '恰一条');
  checkEq(out[0].level, 'red', '红旗');
  check(out[0].title.indexOf('支出超过收入') >= 0, '标题点名超支：' + out[0].title);
  check(out[0].suggestion.indexOf('享受型') >= 0, '有享受型支出时给砍半建议');
});

regCase('4.3 以贷养贷 → 红旗（loanToLoanSuspect===true 才触发）', function () {
  const out = aiInsights.buildFallbackInsights({
    cashflow: { incomeCents: 100000, expenseCents: 120000, netCents: -20000, creditInflowCents: 30000 },
    debt: { loanToLoanSuspect: true, monthlyRepaymentCents: 25000 }
  });
  check(out.some(function (x) { return x.category === '负债红旗' && x.level === 'red'; }), '应有以贷养贷红旗');
});

regCase('4.4 必要支出未覆盖 → 红旗，缺口按稳定收入口径', function () {
  const out = aiInsights.buildFallbackInsights({
    cashflow: { incomeCents: 50000, expenseCents: 80000, netCents: -30000 },
    necessary: { covered: false, totalCents: 60000, byCategory: [{ name: '房租', cents: 40000 }] },
    income: { stableCents: 40000 }
  });
  const hit = out.filter(function (x) { return x.category === '必要支出'; });
  checkEq(hit.length, 1, '恰一条必要支出红旗');
  check(hit[0].evidence.join('').indexOf('稳定收入 400.00 元') >= 0, '缺口口径必须是稳定收入（非总营收）：' + hit[0].evidence.join(' | '));
});

regCase('4.5 应急缓冲 <1 个月 → 橙色；负 monthsCovered 按 0 显示', function () {
  const out = aiInsights.buildFallbackInsights({
    cashflow: { incomeCents: 100000, expenseCents: 50000, netCents: 50000 },
    buffer: { availableCashCents: 3000, monthlyNecessaryCents: 30000, monthsCovered: 0.1 }
  });
  const hit = out.filter(function (x) { return x.category === '应急缓冲'; });
  checkEq(hit.length, 1, '恰一条');
  checkEq(hit[0].level, 'orange', '橙色');
  const neg = aiInsights.buildFallbackInsights({
    cashflow: { incomeCents: 100000, expenseCents: 50000, netCents: 50000 },
    buffer: { availableCashCents: -1000, monthlyNecessaryCents: 30000, monthsCovered: -0.03 }
  });
  check(neg[0] && neg[0].evidence.join('').indexOf('0.0 个月') >= 0, '负数按 0.0 显示：' + (neg[0] && neg[0].evidence.join(' | ')));
});

regCase('4.6 四规则全命中 → 3 红 1 橙，各恰一条', function () {
  const out = aiInsights.buildFallbackInsights({
    cashflow: { incomeCents: 100000, expenseCents: 120000, netCents: -20000, creditInflowCents: 30000 },
    structure: { enjoymentCents: 8000 },
    debt: { loanToLoanSuspect: true, monthlyRepaymentCents: 25000 },
    necessary: { covered: false, totalCents: 60000, byCategory: [{ name: '房租', cents: 40000 }] },
    income: { stableCents: 40000 },
    buffer: { availableCashCents: 3000, monthlyNecessaryCents: 30000, monthsCovered: 0.1 }
  });
  checkEq(out.length, 4, '恰 4 条');
  checkEq(out.filter(function (x) { return x.level === 'red'; }).length, 3, '3 红');
  checkEq(out.filter(function (x) { return x.level === 'orange'; }).length, 1, '1 橙');
});

/* ============================== 用例 5：连续超支链 ============================== */

section('用例 5：连续超支链 consecutiveMonths 1/2/3（含「上月无预算链断」）');

function budgetDb(curSpent, p1Spent, p2Spent, withP1Budget, withP2Budget) {
  const db = buildDb();
  db.transactions = [
    tx({ categoryId: 'ca_haircut', amountCents: curSpent, date: '2026-11-02' }),
    tx({ categoryId: 'ca_haircut', amountCents: p1Spent, date: '2026-10-02' }),
    tx({ categoryId: 'ca_haircut', amountCents: p2Spent, date: '2026-09-02' })
  ];
  db.categoryBudgets = [{ bookId: BOOK, month: '2026-11', categoryId: 'ca_haircut', amountCents: 5000 }];
  if (withP1Budget) { db.categoryBudgets.push({ bookId: BOOK, month: '2026-10', categoryId: 'ca_haircut', amountCents: 5000 }); }
  if (withP2Budget) { db.categoryBudgets.push({ bookId: BOOK, month: '2026-09', categoryId: 'ca_haircut', amountCents: 5000 }); }
  return db;
}

regCase('5.1 只本月超支 → 1', function () {
  const m = buildMetrics(budgetDb(6000, 1000, 1000, true, true));
  checkEq(m.budget.overCategories.length, 1, '恰一条超支');
  checkEq(m.budget.overCategories[0].consecutiveMonths, 1, '链=1');
});

regCase('5.2 本月+上月超支（都有预算）→ 2', function () {
  const m = buildMetrics(budgetDb(6000, 6000, 1000, true, true));
  checkEq(m.budget.overCategories[0].consecutiveMonths, 2, '链=2');
});

regCase('5.3 三个月连超（都有预算）→ 3', function () {
  const m = buildMetrics(budgetDb(6000, 6000, 6000, true, true));
  checkEq(m.budget.overCategories[0].consecutiveMonths, 3, '链=3');
});

regCase('5.4 上月超支但上月无预算 → 链断为 1', function () {
  const m = buildMetrics(budgetDb(6000, 6000, 6000, false, false));
  checkEq(m.budget.overCategories[0].consecutiveMonths, 1, '上月无预算记录，链=1');
});

/* ============================== 用例 6：口径收尾（2.28.2） ============================== */

section('用例 6：信用卡取现计透支、txCount 不计转账、anomalies 不带备注、裸「游戏」不误伤（2.28.2）');

regCase('6.1 信用卡取现（credit → 非 credit transfer）计入新增透支，参与以贷养贷判定', function () {
  const db = buildDb();
  db.transactions = [
    tx({ type: 'transfer', amountCents: 50000, accountId: 'ac_credit', toAccountId: 'ac_cash' }), /* 取现 */
    tx({ type: 'transfer', amountCents: 30000, accountId: 'ac_cash', toAccountId: 'ac_credit' }), /* 还款 */
    tx({ accountId: 'ac_credit', amountCents: 20000, categoryId: 'ca_digital' })                  /* 透支消费 */
  ];
  const m = buildMetrics(db);
  checkEq(m.cashflow.creditInflowCents, 70000, '取现 50000 + 透支 20000 都算新增透支');
  checkEq(m.debt.monthlyRepaymentCents, 30000, '还款照常');
  checkEq(m.debt.loanToLoanSuspect, true, '边取现边还款且入不敷出 → 以贷养贷红旗');
});

regCase('6.2 txCount 不计 transfer：纯转账月为 0，requestAiInsights 守卫挡在「空账期」', async function () {
  const db = buildDb();
  db.transactions = [
    tx({ type: 'transfer', amountCents: 5000, toAccountId: 'ac_credit' }),
    tx({ type: 'transfer', amountCents: 3000, toAccountId: 'ac_cash' })
  ];
  const m = buildMetrics(db);
  checkEq(m.dataQuality.txCount, 0, '纯转账月 txCount=0');
  check(typeof m.dataQuality.missingDays === 'number', 'missingDays 口径不受影响');
  const res = await aiInsights.requestAiInsights(m, {});
  checkEq(res.reason, 'empty', '守卫必须挡住，不发 LLM 请求');
});

regCase('6.3 anomalies 不再带 note 字段（写-only 敏感面，2.28.2 摘除）', function () {
  const m = buildMetrics(buildRichDb());
  const ano = m.trends.anomalies;
  checkEq(ano.length, 1, '装置恰一笔异常大额');
  check(!('note' in ano[0]), 'anomalies 条目不得含 note：' + JSON.stringify(ano[0]));
  checkEq(JSON.stringify(Object.keys(ano[0]).sort()), JSON.stringify(['categoryName', 'cents', 'date']), '只含 date/cents/categoryName');
});

regCase('6.4 裸「游戏」不再误伤：买游戏光盘不进游戏充值聚类，真充值仍命中', function () {
  const db = buildDb();
  db.transactions = [
    tx({ categoryId: 'ca_food', amountCents: 20000, note: '买游戏光盘' }),
    tx({ categoryId: 'ca_food', amountCents: 3000, note: '游戏充值' })
  ];
  const m = buildMetrics(db);
  const groups = {};
  m.smallFrequent.forEach(function (g) { groups[g.label] = g; });
  const g = groups['游戏充值'];
  check(g, '「游戏充值」仍应命中');
  checkEq(g.count, 1, '只有「游戏充值」一笔命中（裸「游戏」误伤会使 count=2）');
  checkEq(g.totalCents, 3000, '合计只含 3000（误伤会含 20000）');
});

regCase('6.5 系统提示词含 null 语义（规则 6.5，源码级）', function () {
  check(aiSrc.indexOf('规则 6.5：字段值为 null 表示数据不足或该项不适用') >= 0,
    'prompt 缺少 null 语义说明，模型可能把 null 当 0');
});

/* ============================== 汇总 ============================== */

(async function main() {
  let lastSection = '';
  for (let i = 0; i < CASES.length; i += 1) {
    if (CASES[i][0] !== lastSection) {
      lastSection = CASES[i][0];
      console.log('\n===== ' + lastSection + ' =====');
    }
    await test(CASES[i][1], CASES[i][2]);
  }
  console.log('\n=========================================');
  console.log('通过 ' + passCount + ' / 失败 ' + failCount);
  console.log(failCount === 0 ? '总结论：全绿 PASS' : '总结论：存在 FAIL，见上方 [FAIL] 明细');
  console.log('=========================================');
  process.exitCode = failCount === 0 ? 0 : 1;
})();
