'use strict';
/*
 * tests/csv-export.test.js
 * 2.44.1「CSV 公式转义 + 自身导出可回导」回归（验收报告 P2-2 / P2-3）。
 *
 * 运行：node tests/csv-export.test.js（scripts/test.js 自动收集）
 *
 * 做法：按仓库惯例加载 index.html 的 core 内联块，真跑 XZB.Core.backup.toCsv /
 * escapeCsv（不复写实现），再把导出的 CSV 原文喂给 js/modules/bill-import.js
 * 真解析，锁住 self-export → parse 的 round-trip。
 * 只读业务代码，不修改任何业务文件。
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

/* ============================== fixture ============================== */

const DB = {
  books: [{ id: 'b1', name: '日常' }],
  accounts: [{ id: 'a1', name: '微信' }],
  categories: [{ id: 'c1', name: '餐饮', kind: 'expense' }],
  transactions: [
    { id: 't1', bookId: 'b1', accountId: 'a1', categoryId: 'c1', type: 'expense',
      amountCents: 1234, date: '2026-11-20', time: '12:00', createdAt: '2026-11-20T12:00:00',
      note: '=HYPERLINK("http://evil.test","点我")', tags: ['=cmd'], source: 'manual' },
    { id: 't2', bookId: 'b1', accountId: 'a1', type: 'income',
      amountCents: 500000, date: '2026-11-19', time: '09:00', createdAt: '2026-11-19T09:00:00',
      note: '工资', tags: [], source: 'manual' },
    { id: 't3', bookId: 'b1', accountId: 'a1', toAccountId: 'a1', type: 'transfer',
      amountCents: 10000, date: '2026-11-18', time: '08:00', createdAt: '2026-11-18T08:00:00',
      note: '互转', tags: [], source: 'manual' }
  ]
};

/* ============================== 用例 ============================== */

section('1 escapeCsv 公式注入守卫（P2-2 / CWE-1236）');

test('1.1 = + - @ Tab CR 开头一律前置 \'', function () {
  ['=HYPERLINK("http://x")', '+cmd|', '-2+3', '@SUM(A1)', '\tfoo', '\rbar'].forEach(function (s) {
    const out = backup.escapeCsv(s);
    check(out.indexOf("'") === 0 || out.indexOf('"\'') === 0, JSON.stringify(s) + ' 应前置 \'，实际 ' + out);
  });
});

test('1.2 常规文本/数字不受影响，引号逗号换行转义不回归', function () {
  checkEq(backup.escapeCsv('午餐'), '午餐', '中文原样');
  checkEq(backup.escapeCsv('12.34'), '12.34', '金额原样');
  checkEq(backup.escapeCsv('0.00'), '0.00', '零额原样');
  checkEq(backup.escapeCsv('2026-11-20'), '2026-11-20', '日期原样');
  checkEq(backup.escapeCsv('a,b'), '"a,b"', '逗号包裹');
  checkEq(backup.escapeCsv('say "hi"'), '"say ""hi"""', '引号 doubling');
  checkEq(backup.escapeCsv(null), '', 'null');
});

section('2 toCsv 导出级：恶意单元格被转义，金额/表头不变');

const csvText = backup.toCsv(DB, {});
const csvLines = csvText.replace(/^\uFEFF/, '').split('\r\n');

test('2.1 表头仍是冻结 13 列', function () {
  checkEq(csvLines[0], backup.CSV_COLUMNS.join(','), '表头');
});

test('2.2 备注/标签/分类/账户列的公式串被前置 \'', function () {
  const row = csvLines[1]; /* 日期↓排序：t1 在第一行 */
  check(row.indexOf("'=HYPERLINK") >= 0, '备注公式串应被转义：' + row);
  check(row.indexOf("'=cmd") >= 0, '标签公式串应被转义：' + row);
  check(row.indexOf('12.34') >= 0, '金额列不受影响');
});

test('2.3 分类名/账户名以公式字符开头也被转义', function () {
  const db2 = JSON.parse(JSON.stringify(DB));
  db2.categories[0].name = '+EVIL';
  db2.accounts[0].name = '@acct';
  const text = backup.toCsv(db2, {});
  check(text.indexOf("'+EVIL") >= 0, '分类名应转义');
  check(text.indexOf("'@acct") >= 0, '账户名应转义');
});

section('3 self-export → parse round-trip（P2-3）');

test('3.1 自身导出 CSV 能被识别为 generic 并解析成功', function () {
  checkEq(billImport.detectSource(csvText), 'generic', 'detectSource');
  const parsed = billImport.parse(csvText, {});
  check(parsed.ok, 'parse 应成功：' + JSON.stringify(parsed));
  checkEq(parsed.source, 'generic', 'source');
});

test('3.2 收支行金额/方向/分类/账户正确回导', function () {
  const parsed = billImport.parse(csvText, {});
  checkEq(parsed.rows.length, 2, '收支行数（转账跳过）');
  const expense = parsed.rows.find(function (r) { return r.type === 'expense'; });
  const income = parsed.rows.find(function (r) { return r.type === 'income'; });
  check(expense && income, '收支各一笔');
  checkEq(expense.amountCents, 1234, '支出金额');
  checkEq(expense.date, '2026-11-20', '支出日期');
  checkEq(expense.category, '餐饮', '分类名');
  checkEq(expense.accountName, '微信', '账户名');
  checkEq(income.amountCents, 500000, '收入金额');
  checkEq(income.note, '工资', '普通备注原样');
});

test('3.3 转账行进 skipped，不冒充收支', function () {
  const parsed = billImport.parse(csvText, {});
  check(parsed.skipped.some(function (s) { return s.reason.indexOf('不计收支') >= 0; }), '转账应跳过：' + JSON.stringify(parsed.skipped));
});

test('3.4 公式转义后的备注回导带 \' 前缀（已知取舍，不丢行）', function () {
  const parsed = billImport.parse(csvText, {});
  const expense = parsed.rows.find(function (r) { return r.type === 'expense'; });
  check(expense.note.indexOf("'=") === 0, '转义前缀保留：' + expense.note);
});

test('3.5 includeDeleted:false 不导出软删行', function () {
  const db3 = JSON.parse(JSON.stringify(DB));
  db3.transactions[1].deleted = true;
  const text = backup.toCsv(db3, { includeDeleted: false });
  const parsed = billImport.parse(text, {});
  checkEq(parsed.rows.length, 1, '软删收入行不应出现');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);