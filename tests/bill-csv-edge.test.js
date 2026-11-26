'use strict';
/*
 * tests/bill-csv-edge.test.js
 * 2.44.2「CSV 引号内换行 + 金额白名单 + 斜杠日期」行为级回归
 * （2.44.1 验收报告 新 P2-1 / P3-1 / P3-4）。
 *
 * 运行：node tests/bill-csv-edge.test.js（scripts/test.js 自动收集）
 *
 * 做法：与 csv-export.test.js 同范式——vm 加载 index.html 的 core 内联块，
 * 真跑 XZB.Core.backup.toCsv 导出，再喂给 js/modules/bill-import.js 真解析；
 * 微信/通用 CSV 用 fixture 原文，不复写任何实现。只读业务代码。
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
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/store.js', 'js/core/backup.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const backup = sandbox.XZB.Core.backup;
if (!backup || typeof backup.toCsv !== 'function') { throw new Error('XZB.Core.backup.toCsv 不可用'); }

const BILL_SRC = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'bill-import.js'), 'utf8');
vm.runInContext(BILL_SRC, sandbox, { filename: 'js/modules/bill-import.js' });
const billImport = sandbox.XZB.Core.billImport;

/* ============================== fixture 工具 ============================== */

function tx(over) {
  return Object.assign({
    id: 't1', bookId: 'b1', accountId: 'a1', categoryId: 'c1', type: 'expense',
    amountCents: 1234, date: '2026-11-20', time: '12:00', createdAt: '2026-11-20T12:00:00',
    note: '', tags: [], source: 'manual'
  }, over);
}

function dbWith(transactions) {
  return {
    books: [{ id: 'b1', name: '日常' }],
    accounts: [{ id: 'a1', name: '微信' }],
    categories: [{ id: 'c1', name: '餐饮', kind: 'expense' }],
    transactions: transactions
  };
}

/* 通用 CSV：日期/类型/金额/分类 四列即可被 findGenericHeader 认出 */
function genericCsv(rows) {
  return '日期,类型,金额,分类\n' + rows.join('\n');
}

/* ============================== 1 多行字段 round-trip（P2-1） ============================== */

section('1 引号内换行：多行批注 self-round-trip / 微信多行商品（P2-1）');

test('1.1 多行批注导出再导入：一笔不丢、批注两行俱全、无残行误报', function () {
  const text = backup.toCsv(dbWith([tx({ note: '第一行\n第二行' })]), {});
  check(text.indexOf('"第一行\n第二行"') >= 0, '导出应把换行批注包成 quoted 字段：' + JSON.stringify(text));
  const parsed = billImport.parse(text, {});
  check(parsed.ok, 'parse 应成功：' + JSON.stringify(parsed));
  checkEq(parsed.rows.length, 1, '只有一笔，残行不得冒充第二笔');
  checkEq(parsed.skipped.length, 0, '不得出现「不计收支」误报：' + JSON.stringify(parsed.skipped));
  checkEq(parsed.rows[0].note, '第一行\n第二行', '批注两行俱全');
  checkEq(parsed.rows[0].amountCents, 1234, '金额');
  checkEq(parsed.rows[0].date, '2026-11-20', '日期');
});

test('1.2 多行批注在前、正常行在后：后续行金额/方向正确，行号按物理行计', function () {
  const text = backup.toCsv(dbWith([
    tx({ id: 't1', note: '甲\n乙\n丙' }),
    tx({ id: 't2', date: '2026-11-19', amountCents: 500, note: '正常行' })
  ]), {});
  const parsed = billImport.parse(text, {});
  check(parsed.ok, 'parse 应成功');
  checkEq(parsed.rows.length, 2, '两笔都在');
  checkEq(parsed.rows[0].note, '甲\n乙\n丙', '三行批注完整');
  checkEq(parsed.rows[1].amountCents, 500, '后续行金额不被残行污染');
  checkEq(parsed.rows[1].note, '正常行', '后续行批注');
  /* 表头占物理第 1 行；t1 批注两个换行占物理 2–4 行；t2 从物理第 5 行开始 */
  checkEq(parsed.headerLine, 1, '表头行号');
  checkEq(parsed.rows[0].line, 2, '首笔起始物理行');
  checkEq(parsed.rows[1].line, 5, '次笔起始物理行（跨行字段后不漂移）');
});

test('1.3 微信账单多行商品字段：整笔不漏记、无误报跳过', function () {
  const header = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,备注';
  const row = function (time, item, amount, ref) {
    return time + ',商户消费,某商家,' + item + ',支出,¥' + amount + ',零钱,支付成功,' + ref + ',/';
  };
  const csv = [
    '微信支付账单明细', '', header,
    row('2026-11-20 12:00:36', '"商品A\n含换行"', '12.34', 'wx1'),
    row('2026-11-19 09:00:00', '商品B', '5.00', 'wx2'),
    row('2026-11-18 08:00:00', '商品C', '6.00', 'wx3'),
    row('2026-11-17 08:00:00', '商品D', '7.00', 'wx4'),
    row('2026-11-16 08:00:00', '商品E', '8.00', 'wx5'),
    row('2026-11-15 08:00:00', '商品F', '9.00', 'wx6')
  ].join('\n');
  checkEq(billImport.detectSource(csv), 'wechat', '来源识别');
  const parsed = billImport.parse(csv, {});
  check(parsed.ok, 'parse 应成功：' + JSON.stringify(parsed));
  checkEq(parsed.rows.length, 6, '6 笔全在，多行商品那笔不得整行丢失');
  const first = parsed.rows.find(function (r) { return r.refNo === 'wx1'; });
  check(first, '多行商品笔应在 rows 里');
  checkEq(first.amountCents, 1234, '金额');
  check(first.note.indexOf('商品A\n含换行') >= 0, '商品说明含换行原样保留：' + JSON.stringify(first.note));
  checkEq(parsed.skipped.length, 0, '不得误报「不计收支」：' + JSON.stringify(parsed.skipped));
});

test('1.4 末尾引号未闭合：给出真实警告，末行宽容解析、不产生残行幽灵账', function () {
  const csv = genericCsv([
    '2026-11-20,支出,12.34,餐饮',
    '2026-11-19,支出,5.00,"未闭合批注'
  ]);
  const parsed = billImport.parse(csv, {});
  check(parsed.ok, 'parse 应成功');
  checkEq(parsed.rows.length, 2, '两笔宽容收下，不得多出残行幽灵账');
  checkEq(parsed.skipped.length, 0, '无跳过');
  check(parsed.warnings.some(function (w) { return w.indexOf('未闭合') >= 0; }),
    '应有未闭合引号警告：' + JSON.stringify(parsed.warnings));
});

test('1.5 既有单行批注 round-trip 不回归', function () {
  const text = backup.toCsv(dbWith([tx({ note: '午餐' })]), {});
  const parsed = billImport.parse(text, {});
  checkEq(parsed.rows.length, 1, '一笔');
  checkEq(parsed.rows[0].note, '午餐', '单行批注原样');
});

/* ============================== 2 金额白名单（P3-1） ============================== */

section('2 cleanAmount 数字白名单：科学计数法/十六进制/超两位小数拒绝（P3-1）');

test('2.1 1e3 / 0x10 / 1.005 一律跳过并给「金额无法解析」', function () {
  const csv = genericCsv([
    '2026-11-20,支出,1e3,餐饮',
    '2026-11-19,支出,0x10,餐饮',
    '2026-11-18,支出,1.005,餐饮'
  ]);
  const parsed = billImport.parse(csv, {});
  check(parsed.ok, 'parse 应成功');
  checkEq(parsed.rows.length, 0, '畸形金额一笔都不得收下');
  checkEq(parsed.skipped.length, 3, '三行都跳过');
  parsed.skipped.forEach(function (s) {
    checkEq(s.reason, '金额无法解析', '跳过原因');
  });
});

test('2.2 正常金额不回归：¥ 前缀、千分位、两位小数、整数', function () {
  const csv = genericCsv([
    '2026-11-20,支出,"¥1,234.56",餐饮',
    '2026-11-19,支出,12.34,餐饮',
    '2026-11-18,收入,500,餐饮',
    '2026-11-17,支出,0.05,餐饮'
  ]);
  const parsed = billImport.parse(csv, {});
  checkEq(parsed.rows.length, 4, '四笔全收');
  checkEq(parsed.rows[0].amountCents, 123456, '千分位');
  checkEq(parsed.rows[1].amountCents, 1234, '两位小数');
  checkEq(parsed.rows[2].amountCents, 50000, '整数');
  checkEq(parsed.rows[3].amountCents, 5, '分位');
});

test('2.3 负数/零仍按原口径跳过（保守，不改行为）', function () {
  const csv = genericCsv([
    '2026-11-20,支出,-5,餐饮',
    '2026-11-19,支出,0,餐饮'
  ]);
  const parsed = billImport.parse(csv, {});
  checkEq(parsed.rows.length, 0, '负数/零不收');
  checkEq(parsed.skipped.length, 2, '两行跳过');
});

/* ============================== 3 斜杠日期（P3-4） ============================== */

section('3 parseDateTime 兼容斜杠/单位数月日（P3-4）');

test('3.1 2026/11/20 12:00 与 2026/1/5 9:05 归一为补零格式', function () {
  const csv = genericCsv([
    '2026/11/20 12:00,支出,12.34,餐饮',
    '2026/1/5 9:05,支出,5.00,餐饮',
    '2026/1/5,收入,8.00,餐饮'
  ]);
  const parsed = billImport.parse(csv, {});
  checkEq(parsed.rows.length, 3, '三笔全收，不再整份跳过');
  checkEq(parsed.rows[0].date, '2026-11-20', '斜杠日期');
  checkEq(parsed.rows[0].time, '12:00', '时间');
  checkEq(parsed.rows[1].date, '2026-01-05', '单位数月日补零');
  checkEq(parsed.rows[1].time, '09:05', '单位数小时补零');
  checkEq(parsed.rows[2].date, '2026-01-05', '无时间');
  checkEq(parsed.rows[2].time, '', '时间为空');
});

test('3.2 既有横杠格式不回归（含秒、T 分隔）', function () {
  const csv = genericCsv([
    '2026-11-20 12:00:36,支出,12.34,餐饮',
    '2026-11-19T09:00,支出,5.00,餐饮'
  ]);
  const parsed = billImport.parse(csv, {});
  checkEq(parsed.rows.length, 2, '两笔');
  checkEq(parsed.rows[0].time, '12:00', '秒被截去');
  checkEq(parsed.rows[1].time, '09:00', 'T 分隔');
});

test('3.3 越界月日与乱串拒绝：13 月 / 32 日 / 纯文本', function () {
  const csv = genericCsv([
    '2026-13-01,支出,1.00,餐饮',
    '2026/11/32,支出,1.00,餐饮',
    '昨天,支出,1.00,餐饮'
  ]);
  const parsed = billImport.parse(csv, {});
  checkEq(parsed.rows.length, 0, '一笔不收');
  checkEq(parsed.skipped.length, 3, '三行跳过');
  parsed.skipped.forEach(function (s) {
    checkEq(s.reason, '日期无法解析', '跳过原因');
  });
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);