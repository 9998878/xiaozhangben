'use strict';
/*
 * tests/bill-import.test.js
 * 自检脚本：2.29.0「微信/支付宝账单导入」——js/modules/bill-import.js 解析器。
 * 算法吸收自 BeeCount generic_parser（列数一致性找表头 + 列名归一），竞品吸收批次三 A。
 *
 * 运行：node tests/bill-import.test.js（scripts/test.js 自动收集）
 *
 * fixture：内嵌微信/支付宝真实导出格式的样例文本（微信含 16 行账单说明头）。
 * 编码（GBK 回退）在 settings.js 读取层，不在本解析器内，不做单测。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'bill-import.js'), 'utf8');

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

/* ============================== 沙箱 ============================== */

const sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'js/modules/bill-import.js' });
const billImport = sandbox.XZB.Core.billImport;
if (!billImport || typeof billImport.parse !== 'function') {
  throw new Error('XZB.Core.billImport 不可用');
}

/* ============================== fixtures ============================== */

const WECHAT_SAMPLE = [
  '微信支付账单明细',
  '——————微信支付账单明细——————',
  '账单起始时间:[2026-01-01 00:00:00] 账单结束时间:[2026-01-31 23:59:59]',
  '导出类型:[全部]',
  '导出时间:[2026-02-01 10:00:00]',
  '共 6 笔记录',
  '收入:20笔 500.00元',
  '——————微信支付账单明细——————',
  '----------------------微信支付账单明细----------------------',
  '',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-01-05 12:30:11,商户消费,某咖啡店,生椰拿铁,支出,¥32.00,零钱,支付成功,100001,200001,/',
  '2026-01-06 08:10:02,商户消费,某便利店,早餐,支出,"¥1,234.50",招商银行(1234),支付成功,100002,200002,/',
  '2026-01-07 20:00:00,微信红包,张三,红包,收入,¥88.00,零钱,已存入零钱,100003,200003,/',
  '2026-01-08 09:00:00,零钱提现,/,零钱提现-银行,/,¥100.00,/,已提现,100004,200004,/',
  '2026-01-09 10:00:00,商户消费,某店,退款商品,支出,¥50.00,零钱,已全额退款,100005,200005,/',
  '2026-01-10 11:00:00,商户消费,某店,被关单,支出,¥60.00,零钱,已冻结,100006,200006,/',
  ''
].join('\n');

const ALIPAY_SAMPLE = [
  '支付宝交易记录明细查询',
  '账号:[user@example.com]',
  '起始日期:[2026-01-01 00:00:00]终止日期:[2026-01-31 23:59:59]',
  '---------------------------------',
  '交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态',
  '202601150001,PO001,2026-01-15 12:00:00,2026-01-15 12:00:05,2026-01-15 12:00:05,中国,即时到账交易,某奶茶店,珍珠奶茶,18.50,支出,交易成功,0.00,0.00,,已支出',
  '202601160001,PO002,2026-01-16 09:00:00,2026-01-16 09:00:03,2026-01-16 09:00:03,中国,即时到账交易,某工资方,1月工资,8000.00,收入,交易成功,0.00,0.00,,已收入',
  '202601170001,PO003,2026-01-17 10:00:00,,2026-01-17 10:00:03,中国,转账,李四,转账,200.00,不计收支,交易成功,0.00,0.00,,其他',
  '202601180001,PO004,2026-01-18 10:00:00,,2026-01-18 10:00:03,中国,即时到账交易,某店,关闭订单,30.00,支出,交易关闭,0.00,0.00,,',
  ''
].join('\n');

const GARBAGE = '随便一些不是账单的文本\n没有逗号\n也没有表头\n';

/* ============================== 用例 ============================== */

section('用例 1：来源识别');
test('1.1 微信/支付宝/非账单', function () {
  checkEq(billImport.detectSource(WECHAT_SAMPLE), 'wechat', '微信');
  checkEq(billImport.detectSource(ALIPAY_SAMPLE), 'alipay', '支付宝');
  checkEq(billImport.detectSource(GARBAGE), null, '非账单');
});

section('用例 2：微信解析');
test('2.1 表头跳过 16 行说明头，解析 3 笔有效', function () {
  const r = billImport.parse(WECHAT_SAMPLE, {});
  check(r.ok, 'ok: ' + JSON.stringify(r).slice(0, 120));
  checkEq(r.source, 'wechat', '来源');
  checkEq(r.rows.length, 3, '支出2+收入1，中性/退款/冻结被跳过');
  checkEq(r.skipped.length, 3, '跳过 3 行');
});

test('2.2 金额清洗：¥ 前缀与千分位', function () {
  const r = billImport.parse(WECHAT_SAMPLE, {});
  checkEq(r.rows[0].amountCents, 3200, '¥32.00');
  checkEq(r.rows[1].amountCents, 123450, '¥1,234.50');
});

test('2.3 类型/日期/时间/refNo', function () {
  const r = billImport.parse(WECHAT_SAMPLE, {});
  checkEq(r.rows[0].type, 'expense', '支出');
  checkEq(r.rows[0].date, '2026-01-05', '日期');
  checkEq(r.rows[0].time, '12:30', '时间舍秒');
  checkEq(r.rows[0].refNo, '100001', '交易单号');
  checkEq(r.rows[2].type, 'income', '红包=收入');
});

test('2.4 note 拼接：交易类型 · 对方 · 商品，且不含备注列的 /', function () {
  const r = billImport.parse(WECHAT_SAMPLE, {});
  checkEq(r.rows[0].note, '商户消费 · 某咖啡店 · 生椰拿铁', 'note 组合');
  checkEq(r.rows[2].note, '微信红包 · 张三 · 红包', '红包 note');
});

test('2.5 跳过原因：中性 / 退款 / 非成功状态', function () {
  const r = billImport.parse(WECHAT_SAMPLE, {});
  const reasons = r.skipped.map((s) => s.reason).join('|');
  check(reasons.indexOf('不计收支') >= 0, '中性行');
  check(reasons.indexOf('退款') >= 0, '退款行');
  check(reasons.indexOf('状态非成功') >= 0, '冻结行');
  checkEq(r.rows[0].accountHint, '零钱', '支付方式列进 accountHint');
});

section('用例 3：支付宝解析');
test('3.1 全角括号列名（金额（元））也能映射', function () {
  const r = billImport.parse(ALIPAY_SAMPLE, {});
  check(r.ok, 'ok');
  checkEq(r.rows.length, 2, '不计收支/关闭被跳过');
  checkEq(r.rows[0].amountCents, 1850, '18.50');
  checkEq(r.rows[1].amountCents, 800000, '8000.00');
  checkEq(r.rows[1].type, 'income', '工资=收入');
  checkEq(r.rows[0].refNo, '202601150001', '交易号');
});

test('3.2 支付宝 note：对方 · 商品名称', function () {
  const r = billImport.parse(ALIPAY_SAMPLE, {});
  checkEq(r.rows[0].note, '某奶茶店 · 珍珠奶茶', 'note');
});

section('用例 4：异常输入');
test('4.1 非账单 → E_BILL_SOURCE；只有表头无数据行 → ok 但 rows 空', function () {
  checkEq(billImport.parse(GARBAGE, {}).ok, false, '来源识别失败');
  checkEq(billImport.parse(GARBAGE, {}).code, 'E_BILL_SOURCE', '错误码');
});

test('4.2 纯文本表头但无行 → E_BILL_EMPTY', function () {
  const headOnly = WECHAT_SAMPLE.split('\n').slice(0, 11).join('\n');
  const r = billImport.parse(headOnly, {});
  check(!r.ok, '无数据行应报空');
  checkEq(r.code, 'E_BILL_EMPTY', '错误码');
});

test('4.3 CSV 引号内逗号不切列', function () {
  const q = [
    '微信支付账单明细',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-01-05 12:30:11,商户消费,"某某店,分店","生椰,拿铁",支出,¥10.00,零钱,支付成功,100011,200011,/',
    ''
  ].join('\n');
  const r = billImport.parse(q, {});
  check(r.ok && r.rows.length === 1, '解析成功');
  checkEq(r.rows[0].amountCents, 1000, '列未错位（金额列还是金额）');
  checkEq(r.rows[0].note, '商户消费 · 某某店,分店 · 生椰,拿铁', '引号内逗号保留');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) { process.exit(1); }
