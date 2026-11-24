'use strict';
/*
 * tests/audit-card.test.js —— 「账单体检」卡片接入冒烟测试（2.39.0）
 *
 * auditCard / openAuditRows 是 insights 屏里的界面代码，Node 里没有 DOM。
 * 做法：从 insights.js 源码切出这两个函数，放进沙箱，用最小的 DOM 桩执行，
 * 验证取数、行数、按钮与「看这 N 笔 → 开弹层 → 返回重开」的控制流与字段名。
 * 另含接线断言：清单标签、依赖图、预缓存、paintCards 调用点。
 * 运行：node tests/audit-card.test.js（scripts/test.js 自动收集）。只读业务代码。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let passCount = 0;
let failCount = 0;
let seq = 0;

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
  if (actual !== expected) { throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)); }
}

/* ---------------- 装配：算法 + 从 insights.js 切出的卡片代码 ---------------- */

const moduleSandbox = { console };
vm.createContext(moduleSandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'modules', 'audit.js'), 'utf8'), moduleSandbox, { filename: 'js/modules/audit.js' });
const auditApi = moduleSandbox.XZB.Core.audit;

const INSIGHTS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'insights.js'), 'utf8');
const START = INSIGHTS.indexOf('  var AUDIT_ICONS = '); /* 卡片代码从图标表开始，到「渲染主流程」注释前结束 */
const END = INSIGHTS.indexOf('  /* ---------------- 渲染主流程');
check(START > 0 && END > START && INSIGHTS.indexOf('  function openAuditRows(') > START, 'insights.js 里找不到卡片代码边界');

function fakeEl(tag, attrs) {
  return {
    tag,
    attrs: attrs || {},
    children: [],
    appendChild(node) { this.children.push(node); return node; },
    addEventListener() {}
  };
}

function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
}

function build(withAudit) {
  const opened = [];
  const sandbox = {
    console,
    Core: { audit: withAudit ? auditApi : undefined },
    el: fakeEl,
    moduleCard(title, sub) { const c = fakeEl('section'); c.cardTitle = title; c.cardSub = sub; return c; },
    iconNode(name) { return fakeEl('svg', { icon: name }); },
    buttonNode(label, options) { const b = fakeEl('button', { label }); b.onClick = options.onClick; return b; },
    fmt(cents) { return '¥' + (cents / 100).toFixed(2); },
    dateLabel(d) { return d; },
    todayStr() { return '2026-11-23'; },
    sheetApi() { return { open(o) { opened.push(o); } }; },
    sheetBodyShell() { return fakeEl('div'); },
    txList(report, rows, reopen) { const b = fakeEl('div', { rows }); b.reopen = reopen; return b; },
    buildReport() { return null; },
    S: { ctx: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(INSIGHTS.slice(START, END), sandbox, { filename: 'insights.js#auditCard' });
  return { sandbox, opened };
}

function tx(date, cents, extra) {
  seq += 1;
  return Object.assign({
    id: 'c' + seq, bookId: 'b1', type: 'expense', amountCents: cents, categoryId: 'ca_home',
    categoryName: '居住', date, time: '', note: '', accountId: 'ac_cash'
  }, extra || {});
}

const RENT = ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05'].map((d) => tx(d, 120000, { note: '房租' }));
const DUP_PAIR = [tx('2026-11-10', 1500, { categoryId: 'ca_food', categoryName: '餐饮', time: '12:30' }),
  tx('2026-11-10', 1500, { categoryId: 'ca_food', categoryName: '餐饮', time: '12:30' })];

function reportFor(transactions) {
  return { db: { transactions }, model: { scope: { bookId: 'b1', hasBooks: true, archived: {} } } };
}

/* li 行 → { title, text, facts, button } */
function rowsOf(card) {
  const list = card.children[0];
  check(list && list.tag === 'ul', '卡片第一个子节点应是列表');
  return list.children.map((li) => {
    const body = li.children[1];
    const out = { title: body.children[0].attrs.text, text: body.children[1].attrs.text, facts: [], button: null };
    body.children.slice(2).forEach((n) => {
      if (n.tag === 'ul') { out.facts = n.children.map((x) => x.attrs.text); }
      if (n.tag === 'button') { out.button = n; }
    });
    return out;
  });
}

/* ============================== 用例 ============================== */

console.log('\n===== 用例 1：卡片渲染控制流 =====');

test('1.1 算法模块缺失时返回 null，不拖垮整页', function () {
  checkEq(build(false).sandbox.auditCard(reportFor(RENT)), null, '应返回 null');
});

test('1.2 没有流水也能出卡片：体检分 + 「没有发现问题」', function () {
  const card = build(true).sandbox.auditCard(reportFor([]));
  const rows = rowsOf(card);
  checkEq(card.cardTitle, '账单体检', '标题');
  checkEq(rows.length, 2, '两行');
  checkEq(rows[0].title, '体检 100 分 · 很健康', rows[0].title);
  checkEq(rows[1].title, '没有发现问题', rows[1].title);
});

test('1.3 房租 + 同分钟重复：汇总行、固定开销行、断档行、重复行，文案与字段正确', function () {
  const card = build(true).sandbox.auditCard(reportFor(RENT.concat(DUP_PAIR)));
  const rows = rowsOf(card);
  checkEq(rows.length, 4, '四行：' + rows.map((r) => r.title).join(' | '));
  checkEq(rows[0].title, '体检 70 分 · 有几处可以看看', rows[0].title); /* 重复 −20，四个月断档 −10 */
  /* 房租最后一期 9 月、预计日 10 月初已过一个周期 → 判为停掉，不计入固定开销，文案要说清楚 */
  check(rows[0].text.indexOf('可能停了，未计入固定开销') >= 0, '汇总文案：' + rows[0].text);
  checkEq(rows[0].facts[0], '每月 · 居住 ¥1200.00 · 已记 4 次（可能已停）', rows[0].facts[0]);
  checkEq(rows[1].title, '每月 · 居住 ¥1200.00', rows[1].title);
  check(rows[1].text.indexOf('预计日已过还没记，可能已经停了') >= 0, '停掉说明：' + rows[1].text);
  checkEq(rows[1].button.attrs.label, '看这 4 笔', '固定开销按钮');
  checkEq(rows[2].title, '发现 1 组疑似重复', rows[2].title); /* 发现按严重度排：高在前 */
  checkEq(rows[3].title, '有 4 个月几乎没记账', rows[3].title); /* 每月只有一笔房租 → 正确判成断档 */
  checkEq(rows[2].button.attrs.label, '看这 2 笔', '重复按钮');
  checkEq(rows[3].button, null, '断档没有可点开的流水');
});

test('1.3b 固定开销仍在发生：计入每月合计，给出下次预计日', function () {
  const card = build(true).sandbox.auditCard(reportFor(['2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05'].map((d) => tx(d, 120000, { note: '房租' }))));
  const rows = rowsOf(card);
  check(rows[0].text.indexOf('每月固定开销约 ¥1200.00（1 项') >= 0, '汇总文案：' + rows[0].text);
  check(rows[1].text.indexOf('下次预计 2026-12-05') >= 0, '下次预计：' + rows[1].text);
  checkEq(rows[1].button.attrs.label, '看这 4 笔', '按钮');
});

test('1.4 点「看这 N 笔」→ 开弹层，标题带规则名，清单带返回重开；审计异常不抛', function () {
  const env = build(true);
  const card = env.sandbox.auditCard(reportFor(RENT.concat(DUP_PAIR)));
  const rows = rowsOf(card);
  rows[2].button.onClick();
  checkEq(env.opened.length, 1, '开了一次弹层');
  checkEq(env.opened[0].title, '账单体检 · 发现 1 组疑似重复', '弹层标题');
  const list = env.opened[0].content.children[0];
  checkEq(list.attrs.rows.length, 2, '清单两行');
  check(typeof list.reopen === 'function', '带返回重开');
  checkEq(list.reopen(), undefined, '重开不抛（buildReport 返回 null 时静默）');
});

test('1.5 db / model 缺失时不抛（旧形态兼容）', function () {
  const card = build(true).sandbox.auditCard({ db: {}, model: {} });
  check(card && card.tag === 'section', '仍返回卡片');
  check(card.cardSub.indexOf('最后一笔') < 0, '无流水时副标题不带最后一笔：' + card.cardSub);
});

test('1.6 所有展示文本都是字符串且非空（防字段名写错拼出 undefined）', function () {
  const env = build(true);
  const card = env.sandbox.auditCard(reportFor(RENT.concat(DUP_PAIR)));
  walk(card, (n) => {
    if (n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, 'text')) {
      check(typeof n.attrs.text === 'string' && n.attrs.text.length > 0 && n.attrs.text.indexOf('undefined') < 0, '坏文本：' + n.attrs.text);
    }
    if (n.tag === 'button') { check(typeof n.attrs.label === 'string', '坏按钮'); }
  });
  const icons = [];
  walk(card, (n) => { if (n.tag === 'svg') { icons.push(n.attrs.icon); } });
  ['shield', 'repeat', 'flag'].forEach((name) => check(icons.indexOf(name) >= 0, '缺图标 ' + name));
});

console.log('\n===== 用例 2：接线（清单 / 依赖图 / 预缓存 / 调用点） =====');

const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

test('2.1 index.html 有 audit chunk 声明标签，insights 依赖图含 audit', function () {
  check(/<script type="text\/xzb-module" data-xzb-chunk="audit" src="js\/modules\/audit\.js"><\/script>/.test(INDEX_HTML), '声明标签');
  check(INDEX_HTML.indexOf("['audit', 'modules/audit', 'modules/audit']") >= 0, 'ROWS 条目');
  check(INDEX_HTML.indexOf("insights: ['charts', 'ai-insights', 'audit']") >= 0, 'insights DEPS');
});

test('2.2 sw.js 预缓存含 audit.js', function () {
  check(SW_JS.indexOf("'./js/modules/audit.js'") >= 0, 'PRECACHE 缺 audit.js');
});

test('2.3 insights.js：paintCards 调用 auditCard，位置在「值得留意」之后、「行动建议」之前', function () {
  const fn = INSIGHTS.slice(INSIGHTS.indexOf('function paintCards('), INSIGHTS.indexOf('function paint('));
  const a = fn.indexOf('tipsCard(report)');
  const b = fn.indexOf('auditCard(report)');
  const c = fn.indexOf('actionsCard(report)');
  check(a >= 0 && b > a && c > b, '顺序：' + [a, b, c].join(','));
});

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
