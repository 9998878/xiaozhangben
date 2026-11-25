'use strict';
/*
 * tests/calendar-report.test.js —— 2.40.0 合并统计页 / 日历页 / 解读报告存档
 *
 * 覆盖：
 *   1. calendar.js 口径纯函数：净额分档（月预算÷当月天数，未设预算固定档）、
 *      日历专用 +/− 文案、当日流水五道过滤、月份工具。
 *   2. index.html 报告存档 store（内存模式）：校验、同日同月同账期覆盖、
 *      倒序、上限 100 淘汰最旧、删除；报告不进导出备份（源码锁）。
 *   3. stats.js reportCard 状态机：3m/6m 引导、加载、隐私告知、busy、
 *      有今日记录→查看报告（快照变动提示）、无记录→生成/重试/本地兜底/去设置、存档入口恒在。
 *   4. 路由 parseHash：#/insights 历史别名归一到 stats，m/r/regen 参数保留。
 *   5. add.js 日期预填：严格 YYYY-MM-DD＋isValidDateStr，仅新建生效（源码锁）。
 *   6. 合并接线：insights.js 已删、三屏注册、manifest 20 项、sw 预缓存 34 项、
 *      tabbar 首页/日历/＋/统计/我的、core-assistant 深链改 #/stats。
 *
 * 运行：node tests/calendar-report.test.js（scripts/test.js 自动收集）。只读业务代码。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const STATS_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'stats.js'), 'utf8');
const CAL_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'calendar.js'), 'utf8');
const ADD_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'add.js'), 'utf8');
const CA_JS = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'core-assistant.js'), 'utf8');

let passCount = 0;
let failCount = 0;

function section(title) { console.log('\n===== ' + title + ' ====='); }

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

function check(cond, label) { if (!cond) { throw new Error(label); } }
function checkEq(actual, expected, label) {
  if (actual !== expected) { throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); }
}
function lock(cond, label) { if (!cond) { throw new Error('源码锁失效：' + label); } }

function slice(src, startMark, endMark, label) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a + startMark.length);
  if (a < 0 || b <= a) { throw new Error('切块失败：' + label); }
  return src.slice(a, b);
}

/* ---------------- DOM 桩（reportCard 用） ---------------- */

function fakeEl(tag, attrs) {
  return {
    tag,
    attrs: attrs || {},
    children: [],
    listeners: {},
    appendChild(node) { this.children.push(node); return node; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach((f) => f()); }
  };
}

function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
}

function textsOf(node) {
  const out = [];
  walk(node, (n) => { if (n.attrs && typeof n.attrs.text === 'string') { out.push(n.attrs.text); } });
  return out;
}

function findByText(node, text) {
  let hit = null;
  walk(node, (n) => { if (!hit && n.attrs && n.attrs.text === text) { hit = n; } });
  return hit;
}

function findByLabel(node, label) {
  let hit = null;
  walk(node, (n) => { if (!hit && n.tag === 'button' && n.attrs && n.attrs.label === label) { hit = n; } });
  return hit;
}

(async function main() {

/* ============================== 用例 1：日历口径纯函数 ============================== */

section('用例 1：calendar.js 净额分档 / 文案 / 五道过滤');

const calSlice = slice(CAL_JS, '  var MONTH_RE = ', '  /* ---------------- 画面', 'calendar 纯函数');

function buildCal(db) {
  const sandbox = {
    console, Date, Math, Number, String, Object, Array, isFinite, Promise,
    XZB: { app: { state: { ui: { activeBookId: 'b1' } } }, ui: {} },
    dates: { todayStr() { return '2026-11-24'; } },
    money: null,
    icons: null,
    stats: {
      budgetProgress(d) { return { totalCents: d.__budget || 0, state: d.__budget ? 'ok' : 'none' }; },
      calendarHeatmap(d) { return { days: d.__days || [] }; },
      monthSummary(d) { return d.__summary || { incomeCents: 0, expenseCents: 0, netCents: 0, count: 0 }; }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(calSlice, sandbox, { filename: 'calendar.js#pure' });
  return sandbox;
}

await test('1.1 netTier 四档边界：r≤0.5 / ≤1 / ≤2 / >2，正负对称', function () {
  const cal = buildCal({});
  const base = 10000;
  checkEq(cal.netTier(0, base), 1, '0 → 1 档');
  checkEq(cal.netTier(5000, base), 1, 'r=0.5 → 1 档');
  checkEq(cal.netTier(5001, base), 2, 'r>0.5 → 2 档');
  checkEq(cal.netTier(10000, base), 2, 'r=1 → 2 档');
  checkEq(cal.netTier(10001, base), 3, 'r>1 → 3 档');
  checkEq(cal.netTier(20000, base), 3, 'r=2 → 3 档');
  checkEq(cal.netTier(20001, base), 4, 'r>2 → 4 档');
  checkEq(cal.netTier(-20001, base), 4, '负净额对称');
});

await test('1.2 netText：赚钱 +、亏钱 −（U+2212）、整数元、0 不带符号', function () {
  const cal = buildCal({});
  checkEq(cal.netText(0), '¥0', '零');
  checkEq(cal.netText(12345), '+¥123', '正净额四舍五入到元');
  checkEq(cal.netText(-12345), '−¥123', '负净额用 −');
  checkEq(cal.netText(99), '+¥1', '不足一元按四舍五入');
});

await test('1.3 dailyBase：月预算÷当月天数；未设预算退回 ¥100 固定档', function () {
  const withBudget = buildCal({ __budget: 310000 });
  const b = withBudget.dailyBase({ __budget: 310000 }, '2026-11');
  checkEq(b.hasBudget, true, '有预算标记');
  checkEq(b.baseCents, Math.round(310000 / 30), '11 月 30 天日基准');
  const noBudget = buildCal({});
  const f = noBudget.dailyBase({}, '2026-11');
  checkEq(f.hasBudget, false, '无预算标记');
  checkEq(f.baseCents, 10000, '固定档 ¥100');
});

await test('1.4 dayItems 五道过滤：deleted / 账本 / 类型 / 金额 / 日期，时间倒序', function () {
  const cal = buildCal({});
  const tx = (id, date, cents, extra) => Object.assign({
    id, bookId: 'b1', type: 'expense', amountCents: cents, date, time: '12:00',
    categoryId: 'ca_food', accountId: 'ac1'
  }, extra || {});
  const db = { transactions: [
    tx('ok1', '2026-11-10', 1000, { time: '09:00' }),
    tx('ok2', '2026-11-10', 2000, { type: 'income', time: '18:00' }),
    tx('del', '2026-11-10', 1000, { deleted: true }),
    tx('otherBook', '2026-11-10', 1000, { bookId: 'b2' }),
    tx('transfer', '2026-11-10', 1000, { type: 'transfer' }),
    tx('zero', '2026-11-10', 0),
    tx('otherDay', '2026-11-11', 1000)
  ] };
  const items = cal.dayItems(db, '2026-11-10', 'b1');
  checkEq(items.length, 2, '只剩两笔合法流水');
  checkEq(items[0].id, 'ok2', '时间倒序：18:00 在前');
  checkEq(items[1].id, 'ok1', '09:00 在后');
});

await test('1.5 月份工具：跨年加减、大小月与闰年天数', function () {
  const cal = buildCal({});
  checkEq(cal.addMonth('2026-01', -1), '2025-12', '跨年减月');
  checkEq(cal.addMonth('2026-12', 1), '2027-01', '跨年加月');
  checkEq(cal.daysInMonth('2026-02'), 28, '平年二月');
  checkEq(cal.daysInMonth('2028-02'), 29, '闰年二月');
  checkEq(cal.daysInMonth('2026-11'), 30, '十一月');
});

/* ============================== 用例 2：报告存档 store（内存模式） ============================== */

section('用例 2：报告存档 store —— 校验 / 覆盖 / 倒序 / 上限 / 删除');

const reportsSlice = slice(INDEX_HTML, '  var REPORTS_KEY = ', '/* ============================== API 组装', 'reports store');

function buildReports() {
  const sandbox = {
    console, Date, Math, Number, String, Object, Array, Promise, JSON,
    mode: 'memory',
    state: 'memory',
    rawDb: null,
    STORE_STATE: 'state',
    clone(x) { return JSON.parse(JSON.stringify(x)); },
    ensureDbOpen() { return Promise.resolve(true); }
  };
  vm.createContext(sandbox);
  vm.runInContext(reportsSlice, sandbox, { filename: 'index.html#reports' });
  return sandbox;
}

function entry(id, over) {
  return Object.assign({
    id,
    month: '2026-11',
    rangeKey: 'month',
    generatedOn: '2026-11-24',
    generatedAt: 1000,
    source: 'local',
    model: '',
    payload: { fp: 'fp1', core: [] }
  }, over || {});
}

await test('2.1 非法入参一律 E_INVALID_INPUT，不落档', async function () {
  const r = buildReports();
  const bad = [
    null,
    entry(''),                                   /* 缺 id */
    entry('x1', { month: '2026-13' }),           /* 非法月 */
    entry('x2', { rangeKey: 'year' }),           /* 非法账期 */
    entry('x3', { generatedOn: '2026/11/24' }),  /* 非法生成日 */
    entry('x4', { payload: null })               /* 缺 payload */
  ];
  for (const b of bad) {
    const res = await r.reportsSave(b);
    checkEq(res.ok, false, '应拒绝：' + JSON.stringify(b));
    checkEq(res.code, 'E_INVALID_INPUT', '错误码');
  }
  const list = await r.reportsList();
  checkEq(list.length, 0, '一条都不该落档');
});

await test('2.2 合法落档：list/get 可用，source 缺省归一为 local', async function () {
  const r = buildReports();
  const res = await r.reportsSave(entry('r1', { source: undefined }));
  checkEq(res.ok, true, '落档成功');
  checkEq(res.entry.source, 'local', 'source 归一');
  const list = await r.reportsList();
  checkEq(list.length, 1, '一条');
  const got = await r.reportsGet('r1');
  check(got && got.id === 'r1', 'get 命中');
  checkEq(await r.reportsGet('nope'), null, 'get 未命中返回 null');
  checkEq(await r.reportsGet(''), null, '空 id 返回 null');
});

await test('2.3 同日同月同账期覆盖：条数不变，id 换成新的', async function () {
  const r = buildReports();
  await r.reportsSave(entry('r1', { generatedAt: 1000 }));
  await r.reportsSave(entry('r2', { generatedAt: 2000 }));
  const list = await r.reportsList();
  checkEq(list.length, 1, '覆盖不新增');
  checkEq(list[0].id, 'r2', '保留新报告');
  checkEq(await r.reportsGet('r1'), null, '旧报告被覆盖');
});

await test('2.4 不同账期/不同日共存，按 generatedAt 倒序', async function () {
  const r = buildReports();
  await r.reportsSave(entry('a', { rangeKey: 'month', generatedAt: 1000 }));
  await r.reportsSave(entry('b', { rangeKey: 'prev', generatedAt: 3000 }));
  await r.reportsSave(entry('c', { generatedOn: '2026-11-23', generatedAt: 2000 }));
  const list = await r.reportsList();
  checkEq(list.length, 3, '三条共存');
  checkEq(list.map((x) => x.id).join(','), 'b,c,a', '倒序');
});

await test('2.5 上限 100：超量淘汰最旧', async function () {
  const r = buildReports();
  for (let i = 0; i < 105; i += 1) {
    const y = 2000 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    const month = y + '-' + (m < 10 ? '0' : '') + m;
    const res = await r.reportsSave(entry('r' + i, { month, generatedAt: 1000 + i }));
    checkEq(res.ok, true, '第 ' + i + ' 条落档');
  }
  const list = await r.reportsList();
  checkEq(list.length, 100, '上限 100');
  checkEq(list[0].id, 'r104', '最新在首');
  checkEq(await r.reportsGet('r0'), null, '最旧被淘汰');
  checkEq(await r.reportsGet('r4'), null, '次旧被淘汰');
  check((await r.reportsGet('r5')) !== null, '第 6 旧保留');
});

await test('2.6 删除：命中 removed=1，未命中 removed=0，空 id 拒绝', async function () {
  const r = buildReports();
  await r.reportsSave(entry('r1'));
  const res = await r.reportsRemove('r1');
  checkEq(res.ok, true, '删除成功');
  checkEq(res.removed, 1, '删了一条');
  const again = await r.reportsRemove('r1');
  checkEq(again.removed, 0, '重复删除 0');
  const bad = await r.reportsRemove('');
  checkEq(bad.ok, false, '空 id 拒绝');
  checkEq((await r.reportsList()).length, 0, '清空');
});

await test('2.7 报告不进导出备份：exportJson 只走 buildBackup(ready.db)，不碰 reports', function () {
  const start = INDEX_HTML.indexOf('  function exportJson(opts) {');
  check(start > 0, '找到 exportJson');
  const end = INDEX_HTML.indexOf('\n  function ', start + 10);
  const fn = INDEX_HTML.slice(start, end > start ? end : start + 8000);
  lock(fn.indexOf('buildBackup(ready.db') >= 0, 'exportJson 应只导出 ready.db');
  lock(fn.indexOf('reports') < 0, 'exportJson 不应引用 reports');
});

/* ============================== 用例 3：reportCard 状态机 ============================== */

section('用例 3：stats.js reportCard —— 生成→落档→查看报告 状态机');

const rcSlice = slice(STATS_JS, '  function reportCard(report) {', '  function startGeneration(report) {', 'reportCard');

function buildCard(over) {
  const calls = { setRange: [], begin: [], archiveLocal: [], start: [], notice: [] };
  const S = Object.assign({
    month: '2026-11',
    aiModuleLoading: false,
    privacyPending: false,
    aiBusy: false,
    aiBusyMonth: '',
    aiRetryHint: '',
    reportsCache: [],
    reportError: '',
    __rec: null,
    __cfg: { ok: false },
    __noLlm: false
  }, over || {});
  const llm = {
    getConfig() { return S.__cfg; },
    setConfig(patch) { calls.notice.push(patch); }
  };
  const sandbox = {
    console, Date, Math, Number, String, Object, Array, encodeURIComponent,
    S,
    el: fakeEl,
    moduleCard(title, sub) { const c = fakeEl('section'); c.cardTitle = title; c.cardSub = sub; return c; },
    buttonNode(label, opts) { const b = fakeEl('button', { label }); b.onClick = (opts || {}).onClick; return b; },
    monthLabel(m) { return m; },
    setRange(k) { calls.setRange.push(k); },
    aiLlm() { return S.__noLlm ? null : llm; },
    beginGeneration(r) { calls.begin.push(r); },
    archiveLocalReport(r) { calls.archiveLocal.push(r); },
    startGeneration(r) { calls.start.push(r); },
    reportCacheKey(r) { return r.endMonth + '|' + r.range.key; },
    ensureReportsLoaded() {},
    findTodayReport() { return S.__rec; },
    clockText() { return '09:00'; },
    localFp() { return 'fp-now'; }
  };
  vm.createContext(sandbox);
  vm.runInContext(rcSlice, sandbox, { filename: 'stats.js#reportCard' });
  return { sandbox, calls, S };
}

const REPORT = { endMonth: '2026-11', range: { key: 'month', label: '本月' }, isPartial: false };

await test('3.1 近 3/6 个月：只给引导，「切到本月」可点', function () {
  const env = buildCard();
  const card = env.sandbox.reportCard({ endMonth: '2026-11', range: { key: '3m', label: '近3个月' } });
  check(textsOf(card).some((t) => t.indexOf('切到「本月」或「上月」') >= 0), '引导文案');
  const btn = findByLabel(card, '切到本月');
  check(btn, '有切到本月按钮');
  btn.onClick();
  checkEq(env.calls.setRange.join(','), 'month', '点击切到本月');
});

await test('3.2 模块加载中 / 存档读取中：各有 loading 文案', function () {
  const loading = buildCard({ aiModuleLoading: true });
  check(textsOf(loading.sandbox.reportCard(REPORT)).some((t) => t.indexOf('正在加载模型连接模块') >= 0), '模块 loading');
  const reading = buildCard({ reportsCache: null });
  check(textsOf(reading.sandbox.reportCard(REPORT)).some((t) => t.indexOf('正在读取报告存档') >= 0), '存档 loading');
});

await test('3.3 隐私告知：确认写 noticeAt 并进入生成；也可先出本地报告', function () {
  const env = buildCard({ privacyPending: true });
  const card = env.sandbox.reportCard(REPORT);
  check(textsOf(card).some((t) => t.indexOf('发送到你配置的模型接口') >= 0), '隐私文案');
  const ack = findByText(card, '知道了，生成');
  check(ack && ack.tag === 'button', '确认按钮');
  ack.click();
  check(env.calls.notice.length === 1 && env.calls.notice[0].noticeAt > 0, '写入 noticeAt');
  checkEq(env.S.privacyPending, false, '告知态解除');
  checkEq(env.calls.begin.length, 1, '进入生成');
  const local = findByLabel(card, '先生成本地报告');
  check(local, '本地兜底按钮');
  local.onClick();
  checkEq(env.calls.archiveLocal.length, 1, '本地落档');
});

await test('3.4 busy：同账期生成中显示等待文案', function () {
  const env = buildCard({ aiBusy: true, aiBusyMonth: '2026-11|month', aiRetryHint: '第 2 次尝试…' });
  const ts = textsOf(env.sandbox.reportCard(REPORT));
  check(ts.some((t) => t.indexOf('AI 正在生成解读') >= 0), 'busy 文案');
  check(ts.some((t) => t.indexOf('第 2 次尝试') >= 0), '重试提示');
});

await test('3.5 有今日记录：按钮变「查看报告」，深链带 id；快照变动给重新生成', function () {
  const env = buildCard({ __rec: { id: 'r1', generatedAt: 1, source: 'ai', model: '模型A', payload: { fp: 'fp-old' } } });
  const card = env.sandbox.reportCard(REPORT);
  const ts = textsOf(card);
  check(ts.some((t) => t.indexOf('AI 解读') >= 0 && t.indexOf('模型A') >= 0), 'meta 带来源与模型');
  check(ts.some((t) => t.indexOf('生成后账单有变动') >= 0), '快照变动提示');
  const view = findByText(card, '查看报告');
  check(view && view.tag === 'a', '查看报告是链接');
  checkEq(view.attrs.href, '#/report?id=r1', '深链带 id');
  const regen = findByLabel(card, '重新生成');
  check(regen, '重新生成按钮');
  regen.onClick();
  checkEq(env.calls.start.length, 1, '触发重新生成');
});

await test('3.6 快照未变动：不出重新生成，仍可查看', function () {
  const env = buildCard({ __rec: { id: 'r2', generatedAt: 1, source: 'local', model: '', payload: { fp: 'fp-now' } } });
  const card = env.sandbox.reportCard(REPORT);
  check(!textsOf(card).some((t) => t.indexOf('生成后账单有变动') >= 0), '无变动提示');
  check(!findByLabel(card, '重新生成'), '无重新生成按钮');
  check(findByText(card, '查看报告'), '查看报告仍在');
  check(textsOf(card).some((t) => t.indexOf('本地解读') >= 0), '本地来源文案');
});

await test('3.7 无记录且未配置：生成解读＋去设置；点击触发生成', function () {
  const env = buildCard({ __cfg: { ok: false } });
  const card = env.sandbox.reportCard(REPORT);
  check(textsOf(card).some((t) => t.indexOf('未配置模型时生成纯本地报告') >= 0), '未配置文案');
  const gen = findByText(card, '生成解读');
  check(gen && gen.tag === 'button', '生成按钮');
  gen.click();
  checkEq(env.calls.start.length, 1, '触发生成');
  const settings = findByLabel(card, '去设置配置模型');
  check(settings, '去设置按钮');
});

await test('3.8 无记录已配置但上次失败：重试生成＋本地兜底＋错误文案', function () {
  const env = buildCard({ __cfg: { ok: true, cfg: { ready: true } }, reportError: '网络超时' });
  const card = env.sandbox.reportCard(REPORT);
  check(textsOf(card).some((t) => t === '网络超时'), '错误文案');
  const retry = findByText(card, '重试生成');
  check(retry, '重试按钮');
  const local = findByLabel(card, '先生成本地报告');
  check(local, '本地兜底');
  local.onClick();
  checkEq(env.calls.archiveLocal.length, 1, '本地落档');
  checkEq(env.S.reportError, '', '错误清空');
});

await test('3.9 存档入口恒在：任何状态都能进 #/report', function () {
  const states = [
    buildCard({ __rec: { id: 'r1', generatedAt: 1, source: 'local', payload: { fp: 'fp-now' } } }),
    buildCard({ __cfg: { ok: false } }),
    buildCard({ privacyPending: true })
  ];
  states.forEach((env, i) => {
    const card = env.sandbox.reportCard(REPORT);
    const archive = findByText(card, '报告存档 ›');
    check(archive && archive.tag === 'a' && archive.attrs.href === '#/report', '状态 ' + i + ' 存档入口');
  });
});

/* ============================== 用例 4：路由别名 ============================== */

section('用例 4：parseHash —— #/insights 归一到 stats，参数保留');

const routerSlice = slice(INDEX_HTML, '  function safeDecode(text) {', '  /* ---------------- 屏幕注册', 'router parseHash');
const routerSandbox = { console, Object, String, encodeURIComponent, decodeURIComponent };
vm.createContext(routerSandbox);
vm.runInContext(routerSlice, routerSandbox, { filename: 'index.html#parseHash' });

await test('4.1 #/insights?m=&r= → stats，参数原样保留', function () {
  const route = routerSandbox.parseHash('#/insights?m=2026-10&r=month');
  checkEq(route.view, 'stats', '视图归一');
  checkEq(route.params.m, '2026-10', 'm 保留');
  checkEq(route.params.r, 'month', 'r 保留');
  checkEq(route.hash, '#/stats?m=2026-10&r=month', '规范化 hash');
});

await test('4.2 regen 深链参数保留；裸 #/insights 也归一', function () {
  const route = routerSandbox.parseHash('#/insights?m=2026-11&r=month&regen=1');
  checkEq(route.view, 'stats', '视图归一');
  checkEq(route.params.regen, '1', 'regen 保留');
  checkEq(routerSandbox.parseHash('#/insights').view, 'stats', '裸别名');
});

await test('4.3 既有别名与新路由不受影响', function () {
  const ledger = routerSandbox.parseHash('#/ledger?x=1');
  checkEq(ledger.view, 'home', 'ledger 仍归一 home');
  checkEq(ledger.sub, '', 'ledger sub 丢弃');
  checkEq(ledger.params.x, '1', 'ledger 参数保留');
  checkEq(routerSandbox.parseHash('#/calendar?m=2026-11').view, 'calendar', 'calendar 直达');
  const report = routerSandbox.parseHash('#/report?id=abc');
  checkEq(report.view, 'report', 'report 直达');
  checkEq(report.params.id, 'abc', 'report id 保留');
  checkEq(routerSandbox.normalizeHash('stats'), '#/stats', 'normalizeHash');
});

await test('4.4 syncAliasBar 正则覆盖 insights 别名', function () {
  lock(INDEX_HTML.indexOf('/^#\\/(ledger|insights)(\\?|$|\\/)/') >= 0, 'syncAliasBar 应含 insights');
});

/* ============================== 用例 5：add 日期预填（源码锁） ============================== */

section('用例 5：add.js 日期预填 —— 严格校验、仅新建生效');

await test('5.1 dateParam 仅新建取；prefillDate 双重校验', function () {
  lock(ADD_JS.indexOf("var dateParam = !editing && context.params && context.params.date ? String(context.params.date) : '';") >= 0, 'dateParam 仅新建');
  lock(ADD_JS.indexOf("var prefillDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(dateParam) && dates.isValidDateStr(dateParam) ? dateParam : '';") >= 0, 'prefillDate 严格校验');
});

await test('5.2 新建分支用 prefillDate||today；编辑分支不受影响', function () {
  lock(ADD_JS.indexOf('date: prefillDate || today,') >= 0, '初始 state 预填');
  const hits = ADD_JS.split('state.date = prefillDate || today;').length - 1;
  check(hits >= 2, '两个新建分支都预填：' + hits);
  lock(ADD_JS.indexOf('state.date = dates.isValidDateStr(editing.date) ? editing.date : today;') >= 0, '编辑分支仍用原日期');
});

/* ============================== 用例 6：合并接线 ============================== */

section('用例 6：合并接线 —— 删 insights、三屏注册、清单 / 预缓存 / 底栏 / 深链');

await test('6.1 insights.js 已删除；stats/calendar/report 各自注册唯一 key', function () {
  check(!fs.existsSync(path.join(ROOT, 'js', 'screens', 'insights.js')), 'insights.js 应已删除');
  lock(STATS_JS.indexOf("XZB.screens.register('stats'") >= 0, 'stats 注册');
  lock(STATS_JS.indexOf("register('insights'") < 0, 'stats 不再注册 insights');
  lock(CAL_JS.indexOf("XZB.screens.register('calendar'") >= 0, 'calendar 注册');
  const REPORT_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'report.js'), 'utf8');
  lock(REPORT_JS.indexOf("XZB.screens.register('report'") >= 0, 'report 注册');
});

await test('6.2 chunk-manifest：20 项、无 insights、stats 依赖含 ai-insights/audit', function () {
  check(INDEX_HTML.indexOf('data-xzb-chunk="insights"') < 0, '无 insights 声明标签');
  lock(/data-xzb-chunk="calendar" src="js\/screens\/calendar\.js"/.test(INDEX_HTML), 'calendar 声明标签');
  lock(/data-xzb-chunk="report" src="js\/screens\/report\.js"/.test(INDEX_HTML), 'report 声明标签');
  const rows = slice(INDEX_HTML, '  var ROWS = [', '  ];', 'ROWS');
  const count = (rows.match(/\['/g) || []).length;
  checkEq(count, 20, 'ROWS 20 项');
  check(rows.indexOf("'insights'") < 0, 'ROWS 无 insights');
  lock(INDEX_HTML.indexOf("stats: ['charts', 'ai-insights', 'audit']") >= 0, 'stats DEPS');
  lock(INDEX_HTML.indexOf("calendar: ['charts']") >= 0, 'calendar DEPS');
  lock(INDEX_HTML.indexOf("report: ['charts']") >= 0, 'report DEPS');
});

await test('6.3 sw.js：预缓存 34 项，含 calendar/report，无 insights，版本 2.41.4', function () {
  const pre = slice(SW_JS, 'var PRECACHE = [', '];', 'PRECACHE');
  const count = (pre.match(/'\.\//g) || []).length;
  checkEq(count, 34, 'PRECACHE 34 项');
  lock(pre.indexOf("'./js/screens/calendar.js'") >= 0, '含 calendar.js');
  lock(pre.indexOf("'./js/screens/report.js'") >= 0, '含 report.js');
  check(pre.indexOf("'./js/screens/insights.js'") < 0, '无 insights.js');
  lock(/CACHE_NAME\s*=\s*'xzb2-v2\.41\.4'/.test(SW_JS), '缓存版本 2.41.4');
});

await test('6.4 底栏与路由：首页/日历/＋/统计/我的', function () {
  lock(INDEX_HTML.indexOf('data-tab="calendar"') >= 0, '日历槽位');
  check(INDEX_HTML.indexOf('data-tab="insights"') < 0, '无解读槽位');
  lock(INDEX_HTML.indexOf("var TAB_ROOTS = ['home', 'calendar', 'stats', 'settings'];") >= 0, 'TAB_ROOTS');
  lock(/var VIEWS = \['home', 'calendar', 'add', 'ledger', 'stats', 'report',/.test(INDEX_HTML), 'VIEWS 含 calendar/report');
  const tabbar = slice(INDEX_HTML, '<nav id="tabbar"', '</nav>', 'tabbar');
  ['首页', '日历', '统计', '我的'].forEach((label) => {
    check(tabbar.indexOf('>' + label + '</span>') >= 0, '底栏文案 ' + label);
  });
  check(tabbar.indexOf('解读') < 0, '底栏无解读');
});

await test('6.5 core-assistant 深链改 #/stats；全仓库 js 无 #/insights 残留', function () {
  lock(CA_JS.indexOf("links: [{ label: '看统计', hash: '#/stats?m=' + endMonth + '&r=month' }]") >= 0, '小助手深链');
  check(CA_JS.indexOf('#/insights') < 0, 'core-assistant 无旧深链');
  const screensDir = path.join(ROOT, 'js', 'screens');
  fs.readdirSync(screensDir).forEach((name) => {
    if (!/\.js$/.test(name)) { return; }
    const src = fs.readFileSync(path.join(screensDir, name), 'utf8');
    check(src.indexOf('#/insights') < 0, name + ' 不应再有 #/insights 深链');
  });
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });