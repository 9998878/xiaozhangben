'use strict';
/*
 * tests/nl-golden.test.js
 * 自检脚本：nl 解析「golden cases」回归（2.29.2 竞品吸收批次的落地形态）。
 *
 * 形态借鉴自鲨鱼记账 SharkAiSdk 的 spec/golden_cases.json（「同一句 → 期望结构化
 * 结果」的回归用例形态），用例数据全部为小账本自有口径（分类/账户/金额单位），
 * 不复制对方任何数据文件。覆盖三块：
 *   1) 记账路径：nl.parse 对一句话产出 类型/分类/金额/日期/备注（含中文数字金额、
 *      品牌别名、相对日期）；
 *   2) 查询路径：core-assistant.resolveRange 对「大前天/上上周/上周末/上上个月/前年」
 *      等时间词给出正确区间（此前这些词会静默落回本月，答错而非答慢）；
 *   3) 金额单位：中文数字（三十五块/一百二）与 万/W 口径。
 *
 * 运行：node tests/nl-golden.test.js
 * 加载方式：与 nl-date.test.js 同款 node vm 沙箱（index.html 内联 money/dates/schema
 * + js/modules/nl.js + js/modules/core-assistant.js），today 固定 '2026-11-06'。
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

const CORE_MARKERS = ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js'];
const sandbox = { console: console };
vm.createContext(sandbox);

for (const marker of CORE_MARKERS) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker.replace('js/core/', 'inline:') });
}
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8'), sandbox, { filename: 'js/modules/nl.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8'), sandbox, { filename: 'js/modules/core-assistant.js' });

const nlApi = sandbox.XZB.Core.nl;
const asst = sandbox.XZB.Core.assistant;
const schema = sandbox.XZB.Core.schema;
if (!nlApi || !asst) { throw new Error('沙箱内 nl / core-assistant 未就绪'); }

const TODAY = '2026-11-06'; /* 周五 */

function buildCtx() {
  return {
    today: TODAY,
    nowTime: '12:00',
    accounts: [{
      id: 'ac_cash', name: '现金', type: 'cash', icon: 'wallet', color: '#34C759',
      openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null,
      archived: false, sort: 10, note: ''
    }, {
      id: 'ac_wechat', name: '微信', type: 'wechat', icon: 'wechat', color: '#07C160',
      openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null,
      archived: false, sort: 20, note: ''
    }],
    categories: schema.seedData().categories,
    defaults: { type: 'expense' }
  };
}

/* ============================== 用例 1：记账路径 golden cases ============================== */

section('用例 1：记账路径 golden cases（一句话 → 结构化草稿）');

/* 自有用例集（形态借鉴，数据自有）：{input, expect:{type, category, cents, date, noteHas}} */
const GOLDEN = [
  { input: '昨天打车花了35', expect: { type: 'expense', category: 'ca_transport', cents: 3500, date: '2026-11-05', noteHas: '打车' } },
  { input: '三十五块的奶茶', expect: { type: 'expense', category: 'ca_food', cents: 3500, date: TODAY, noteHas: '奶茶' } },
  { input: '中午吃饭花了28', expect: { type: 'expense', category: 'ca_food', cents: 2800, date: TODAY, noteHas: '吃饭' } },
  { input: '今天工资到账12000', expect: { type: 'income', category: 'ca_salary', cents: 1200000, date: TODAY } },
  { input: '收到红包88', expect: { type: 'income', category: 'ca_redpacket', cents: 8800, date: TODAY } },
  { input: '淘宝买了49', expect: { type: 'expense', category: 'ca_shopping', cents: 4900, date: TODAY, noteHas: '淘宝' } },
  { input: '大前天午饭 28 微信', expect: { type: 'expense', category: 'ca_food', cents: 2800, date: '2026-11-03', account: 'ac_wechat' } },
  { input: '瑞幸咖啡 15', expect: { type: 'expense', category: 'ca_food', cents: 1500, date: TODAY, noteHas: '瑞幸' } },
  { input: '滴滴打车 23 支付宝', expect: { type: 'expense', category: 'ca_transport', cents: 2300, account: null } },
  { input: '盒马买水果 56', expect: { type: 'expense', cents: 5600, date: TODAY } },
  { input: '1.2万房租', expect: { type: 'expense', category: 'ca_home', cents: 1200000, date: TODAY } }
];

for (const c of GOLDEN) {
  test('G:' + c.input, function () {
    const r = nlApi.parse(c.input, buildCtx());
    check(r && r.ok && r.best, 'parse 应成功：' + JSON.stringify(r && r.code));
    const b = r.best;
    if (c.expect.type) { checkEq(b.type, c.expect.type, '类型'); }
    if (c.expect.category) { checkEq(b.categoryId, c.expect.category, '分类'); }
    checkEq(b.cents, c.expect.cents, '金额（分）');
    if (c.expect.date) { checkEq(b.date, c.expect.date, '日期'); }
    if (c.expect.account) { checkEq(b.accountId, c.expect.account, '账户'); }
    if (c.expect.noteHas) { check(String(b.note || '').indexOf(c.expect.noteHas) >= 0, '备注应含「' + c.expect.noteHas + '」，实际「' + b.note + '」'); }
  });
}

/* ============================== 用例 2：查询路径时间词（resolveRange） ============================== */

section('用例 2：查询路径时间词——大前天/上上周/周末系/上上个月/前年');

function rangeOf(text) {
  const cx = asst.contextOf({ db: { accounts: [], categories: [] }, today: TODAY });
  return asst.resolveRange(text, cx);
}

test('Q:大前天花了多少', function () {
  const r = rangeOf('大前天花了多少');
  checkEq(r.from, '2026-11-03', '起点');
  checkEq(r.to, '2026-11-03', '终点');
});

test('Q:上上周餐饮花了多少', function () {
  const r = rangeOf('上上周餐饮花了多少');
  /* TODAY=周五 2026-11-06 → 本周周一 11-02，上上周为 10-19 ~ 10-25 */
  checkEq(r.from, '2026-10-19', '起点');
  checkEq(r.to, '2026-10-25', '终点');
});

test('Q:上周末花了多少（周六锚点）', function () {
  const r = rangeOf('上周末花了多少');
  checkEq(r.from, '2026-10-31', '上周六');
  checkEq(r.to, '2026-10-31', '终点');
});

test('Q:这周末花了多少', function () {
  const r = rangeOf('这周末花了多少');
  checkEq(r.from, '2026-11-07', '本周六');
});

test('Q:上上个月花了多少', function () {
  const r = rangeOf('上上个月花了多少');
  checkEq(r.from, '2026-09-01', '起点');
  checkEq(r.to, '2026-09-30', '终点');
});

test('Q:前年收入多少', function () {
  const r = rangeOf('前年收入多少');
  checkEq(r.from, '2024-01-01', '起点');
  checkEq(r.to, '2024-12-31', '终点');
});

test('Q:回归——旧口径不回归（昨天/上周/上个月/近7天）', function () {
  checkEq(rangeOf('昨天花了多少').from, '2026-11-05', '昨天');
  const wk = rangeOf('上周花了多少');
  checkEq(wk.from, '2026-10-26', '上周起点');
  checkEq(rangeOf('上个月花了多少').from, '2026-10-01', '上月起点');
  checkEq(rangeOf('近7天花了多少').from, '2026-10-31', '近7天起点');
});

/* ============================== 汇总 ============================== */

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exitCode = 1; }
