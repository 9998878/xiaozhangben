'use strict';
/*
 * tests/audit.test.js —— 账单体检（XZB.Core.audit）单元测试（2.39.0）
 *
 * 覆盖：取数口径、固定开销（周/双周/月/桥接漏记/形状校验/停掉）、
 *       疑似重复（强/中/弱/与周期账单互斥）、异常大额、断档月份、久未记账、
 *       分类不清、月支出突增（分类拆解）、体检分、纯净性与容错。
 * 运行：node tests/audit.test.js（scripts/test.js 自动收集）
 * 只读业务代码；沙箱装配与 tests/bill-import.test.js 同款。本脚本不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let passCount = 0;
let failCount = 0;
let seq = 0;

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

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'modules', 'audit.js'), 'utf8'), sandbox, { filename: 'js/modules/audit.js' });
const audit = sandbox.XZB.Core.audit;
if (!audit || typeof audit.run !== 'function') { throw new Error('沙箱内 XZB.Core.audit 未就绪'); }

const TODAY = '2026-11-23'; /* 周一 */

const SCOPE = { bookId: 'b1', hasBooks: true, archived: {} };

/* 造一笔流水：默认支出、账本 b1 */
function tx(date, cents, categoryId, extra) {
  seq += 1;
  const base = {
    id: 't' + String(seq).padStart(3, '0'),
    bookId: 'b1',
    type: 'expense',
    amountCents: cents,
    categoryId: categoryId || 'ca_food',
    categoryName: '餐饮',
    date,
    time: '',
    note: '',
    accountId: 'ac_cash'
  };
  return Object.assign(base, extra || {});
}

function run(txs, extra) {
  return audit.run(Object.assign({ transactions: txs, scope: SCOPE, today: TODAY }, extra || {}));
}

function byCode(report, code) {
  return report.findings.filter((f) => f.code === code);
}

function hasCode(report, code) {
  return report.findings.some((f) => f.code === code);
}

/* 造互不重复的日常流水，避免落进别的规则 */
function daily(fromDate, count, cents) {
  const out = [];
  const start = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  for (let i = 0; i < count; i += 1) {
    const d = new Date(start + i * 86400000);
    const date = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    out.push(tx(date, cents + i * 7)); /* 每笔金额都不同 → 不会成组 */
  }
  return out;
}

/* ============================== 用例 ============================== */

section('用例 1：取数口径与统计一致');

test('1.1 六道过滤：删除、他账本、转账、不计收支、非正金额、非法日期', function () {
  const txs = [
    tx('2026-11-01', 1000),
    tx('2026-11-02', 1000, 'ca_food', { deleted: true }),
    tx('2026-11-03', 1000, 'ca_food', { bookId: 'b2' }),
    tx('2026-11-04', 1000, 'ca_food', { type: 'transfer' }),
    tx('2026-11-05', 1000, 'ca_food', { excludeStats: true }),
    tx('2026-11-06', 0),
    tx('2026-11-07', -500),
    tx('2026-02-30', 1000),
    tx('2026-11-09', 1000, 'ca_salary', { type: 'income' })
  ];
  const r = run(txs);
  check(r.ok, 'ok');
  checkEq(r.counts.expense, 1, '有效支出');
  checkEq(r.counts.income, 1, '有效收入');
  checkEq(r.window.from, '2026-11-01', '窗口起点');
});

test('1.2 没指定账本时，归档账本不计入', function () {
  const txs = [
    tx('2026-11-01', 1000, 'ca_food', { bookId: 'live' }),
    tx('2026-11-02', 1000, 'ca_food', { bookId: 'old' })
  ];
  const r = audit.run({ transactions: txs, today: TODAY, scope: { bookId: '', hasBooks: true, archived: { old: true } } });
  checkEq(r.counts.expense, 1, '只计未归档账本');
});

test('1.3 分类名：优先流水自带 categoryName，其次 categories 入参，都没有则留空', function () {
  const txs = ['2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx(d, 120000, 'ca_home', { categoryName: '' }));
  const fromInput = audit.run({ transactions: txs, today: TODAY, scope: SCOPE, categories: [{ id: 'ca_home', name: '宠物' }] });
  checkEq(fromInput.recurring[0].categoryName, '宠物', '取 categories 入参');
  const bare = txs.map((t) => Object.assign({}, t, { categoryName: '' }));
  const none = audit.run({ transactions: bare, today: TODAY, scope: SCOPE });
  checkEq(none.recurring[0].categoryName, '', '无来源留空');
});

/* ============================== 固定开销 ============================== */

section('用例 2：固定开销（周期账单识别）');

function rentDates() {
  return ['2026-03-05', '2026-04-05', '2026-05-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05'];
}

test('2.1 月度账单：每月 5 号房租，漏记一个月也能桥接', function () {
  const r = run(rentDates().map((d) => tx(d, 120000, 'ca_home', { categoryName: '居住', note: '房租' })));
  checkEq(r.recurring.length, 1, '识别出 1 条');
  const s = r.recurring[0];
  checkEq(s.cadence, 'monthly', '周期');
  checkEq(s.count, 8, '期数');
  checkEq(s.bridges, 1, '桥接一次');
  checkEq(s.monthlyCents, 120000, '每月金额');
  checkEq(s.nextDate, '2026-12-05', '下次预计');
  checkEq(s.stale, false, '仍在发生');
  checkEq(s.categoryName, '居住', '分类名');
  checkEq(s.rows.length, 8, '明细行');
  checkEq(r.fixedMonthlyCents, 120000, '每月固定开销');
});

test('2.2 每周 / 每两周', function () {
  const weekly = run(['2026-10-31', '2026-11-07', '2026-11-14', '2026-11-21'].map((d) => tx(d, 2500, 'ca_fun', { categoryName: '娱乐' })));
  checkEq(weekly.recurring.length, 1, '每周');
  checkEq(weekly.recurring[0].cadence, 'weekly', 'cadence');
  checkEq(weekly.recurring[0].nextDate, '2026-11-28', '周六之后还是周六');
  checkEq(weekly.recurring[0].monthlyCents, Math.round(2500 * 52 / 12), '折算每月');

  const biweekly = run(['2026-10-03', '2026-10-17', '2026-10-31', '2026-11-14'].map((d) => tx(d, 6000, 'ca_sport', { categoryName: '运动' })));
  checkEq(biweekly.recurring.length, 1, '每两周');
  checkEq(biweekly.recurring[0].cadence, 'biweekly', 'cadence');
});

test('2.3 不规律的同额同分类不算周期', function () {
  const r = run(['2026-09-01', '2026-09-12', '2026-10-20'].map((d) => tx(d, 2500, 'ca_fun', { categoryName: '娱乐' })));
  checkEq(r.recurring.length, 0, '间隔 11 / 38 天');
});

test('2.4 形状校验：间隔接近 30 天但「几号」乱跳，不算月度账单', function () {
  /* 7/2 → 8/1 → 9/4 → 10/3：间隔 30/34/29，但几号 2/1/4/3 都在范围内——构造必须离散更大的 */
  const r = run(['2026-07-02', '2026-08-01', '2026-09-28', '2026-10-27'].map((d) => tx(d, 2500, 'ca_fun', { categoryName: '娱乐' })));
  checkEq(r.recurring.length, 0, '几号 2/1/28/27 离散过大');
});

test('2.5 每周账单：晚一天仍算；星期几对不上不算', function () {
  const late = run(['2026-11-02', '2026-11-09', '2026-11-17', '2026-11-23'].map((d) => tx(d, 2500, 'ca_fun', { categoryName: '娱乐' })));
  checkEq(late.recurring.length, 1, '周一、周一、周二、周一：其中一期晚了一天');
  const mixed = run(['2026-11-02', '2026-11-09', '2026-11-14', '2026-11-21'].map((d) => tx(d, 2500, 'ca_fun', { categoryName: '娱乐' })));
  checkEq(mixed.recurring.length, 0, '周一两次、周六两次：间隔 7/5/7 但星期几差 5 天');
});

test('2.6 预计日已过去一个周期还没记 → 标记停掉，不计入固定开销', function () {
  const r = run(['2026-05-05', '2026-06-05', '2026-07-05'].map((d) => tx(d, 9900, 'ca_tool', { categoryName: '工具' })));
  checkEq(r.recurring.length, 1, '仍识别为周期');
  checkEq(r.recurring[0].stale, true, '停掉');
  checkEq(r.fixedMonthlyCents, 0, '不计入');
});

test('2.7 低于 ¥5 的高频小额不当周期', function () {
  const tiny = run(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'].map((d) => tx(d, 300, 'ca_fun', { categoryName: '娱乐' })));
  checkEq(tiny.recurring.length, 0, '¥3');
});

test('2.8 桥接最多跨两期：跳两个月能接上，跳五个月断成两截（后半截自成一条）', function () {
  const two = run(['2026-03-05', '2026-04-05', '2026-05-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx(d, 120000, 'ca_home', { categoryName: '居住' })));
  checkEq(two.recurring.length, 1, '跳过 6、7 月仍是一条');
  checkEq(two.recurring[0].count, 6, '6 期');
  checkEq(two.recurring[0].bridges, 1, '桥接一次');

  const five = run(['2026-01-05', '2026-02-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx(d, 120000, 'ca_home', { categoryName: '居住' })));
  checkEq(five.recurring.length, 1, '只剩后半截');
  checkEq(five.recurring[0].firstDate, '2026-08-05', '从 8 月起算');
  checkEq(five.recurring[0].count, 3, '3 期');
});

test('2.9 固定开销按每月金额降序，多条并存时合计', function () {  const txs = rentDates().map((d) => tx(d, 120000, 'ca_home', { categoryName: '居住' }))
    .concat(['2026-10-03', '2026-10-17', '2026-10-31', '2026-11-14'].map((d) => tx(d, 6000, 'ca_sport', { categoryName: '运动' })));
  const r = run(txs);
  checkEq(r.recurring.length, 2, '两条');
  checkEq(r.recurring[0].cadence, 'monthly', '房租在前');
  checkEq(r.fixedMonthlyCents, 120000 + Math.round(6000 * 26 / 12), '合计每月');
});

test('2.10 高频分类里三顿恰好隔月不算周期；低频分类同样形状可以算', function () {
  /* 餐饮：三个月里 36 笔（月均 12 ≥ 8），其中三笔 ¥26 恰好 15 日 */
  const txs = daily('2026-08-02', 36, 900).map((t) => Object.assign(t, { amountCents: 900 + (seq % 5) * 101 }));
  ['2026-08-15', '2026-09-15', '2026-10-15'].forEach((d) => { txs.push(tx(d, 2600, 'ca_food', { categoryName: '餐饮' })); });
  checkEq(run(txs).recurring.length, 0, '高频分类不足 5 期');

  const low = run(['2026-08-15', '2026-09-15', '2026-10-15'].map((d) => tx(d, 2600, 'ca_video', { categoryName: '视频会员' })));
  checkEq(low.recurring.length, 1, '低频分类 3 期即可');
  checkEq(low.recurring[0].cadence, 'monthly', 'cadence');
});

/* ============================== 疑似重复 ============================== */

section('用例 3：疑似重复');

test('3.1 同一天同一分钟 → 高', function () {
  const r = run([
    tx('2026-11-10', 1500, 'ca_food', { time: '12:30', note: '午饭' }),
    tx('2026-11-10', 1500, 'ca_food', { time: '12:30', note: '午饭' })
  ]);
  const d = byCode(r, 'DUP');
  checkEq(d.length, 1, '一条');
  checkEq(d[0].severity, 'high', '高');
  checkEq(d[0].rows.length, 2, '两笔');
  check(d[0].facts[0].indexOf('¥15.00 ×2') >= 0, '事实行：' + d[0].facts[0]);
});

test('3.2 同日同额但隔了几个小时 → 不算重复（午饭和晚饭）', function () {
  const r = run([
    tx('2026-11-10', 1500, 'ca_food', { time: '10:11', note: '' }),
    tx('2026-11-10', 1500, 'ca_food', { time: '17:06', note: '' })
  ]);
  check(!hasCode(r, 'DUP'), '相隔近 7 小时');
});

test('3.3 有时间：相隔 2 分钟内算重复，4 分钟不算', function () {
  const near = run([tx('2026-11-10', 1500, 'ca_food', { time: '12:30' }), tx('2026-11-10', 1500, 'ca_food', { time: '12:32' })]);
  checkEq(byCode(near, 'DUP')[0].severity, 'high', '2 分钟');
  const far = run([tx('2026-11-10', 1500, 'ca_food', { time: '12:30' }), tx('2026-11-10', 1500, 'ca_food', { time: '12:34' })]);
  check(!hasCode(far, 'DUP'), '4 分钟');
});

test('3.3b 没有记录时间：同备注 → 中；同日无备注 → 弱；隔日无备注 → 不算', function () {
  const sameNote = run([tx('2026-11-10', 1500, 'ca_food', { note: '火车票' }), tx('2026-11-11', 1500, 'ca_food', { note: '火车票' })]);
  checkEq(byCode(sameNote, 'DUP')[0].severity, 'mid', '同备注隔日也算');
  const sameDay = run([tx('2026-11-10', 1500, 'ca_food', { note: '午饭' }), tx('2026-11-10', 1500, 'ca_food', { note: '晚饭' })]);
  checkEq(byCode(sameDay, 'DUP')[0].severity, 'low', '同日无时间');
  const adjacent = run([tx('2026-11-10', 1500, 'ca_food', { note: '午饭' }), tx('2026-11-11', 1500, 'ca_food', { note: '晚饭' })]);
  check(!hasCode(adjacent, 'DUP'), '隔日无时间无同备注');
});

test('3.3c 「一天两顿同价」是习惯：没有时间的数据里，≥40% 的日子成对出现 → 整组不报', function () {
  const txs = [];
  for (let d = 1; d <= 12; d += 1) {
    txs.push(tx('2026-09-' + String(d).padStart(2, '0'), 1500, 'ca_food', { note: '午饭' }));
    if (d % 2 === 0 || d <= 2) { txs.push(tx('2026-09-' + String(d).padStart(2, '0'), 1500, 'ca_food', { note: '晚饭' })); }
  }
  /* 12 天里 7 天成对（58%）——但前两天的备注不同才算？这里备注都不同，只是用来触发习惯规则 */
  check(!hasCode(run(txs), 'DUP'), '习惯组');
});

test('3.4 周期账单不是重复', function () {
  const r = run(['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05'].map((d) => tx(d, 120000, 'ca_home', { note: '房租' })));
  checkEq(r.recurring.length, 1, '是周期');
  check(!hasCode(r, 'DUP'), '不该报重复');
});

test('3.5 收入与支出同额不算重复；金额不同不算', function () {
  const r = run([
    tx('2026-11-10', 1500, 'ca_food', { note: '午饭' }),
    tx('2026-11-10', 1500, 'ca_salary', { type: 'income', note: '兼职' }),
    tx('2026-11-10', 1501, 'ca_food', { note: '晚饭' })
  ]);
  check(!hasCode(r, 'DUP'), '无重复');
});

/* ============================== 异常大额 ============================== */

section('用例 4：异常大额');

function flatDays(count, cents, categoryId) {
  const out = [];
  for (let i = 0; i < count; i += 1) { out.push(tx('2026-' + String(6 + Math.floor(i / 28)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0'), cents, categoryId)); }
  return out;
}

test('4.1 明显高于该分类平时水平的一笔被点出，¥45 的 3 倍不点', function () {
  const txs = flatDays(12, 1500, 'ca_food').concat([
    tx('2026-10-20', 90000, 'ca_food', { note: '请客' }),
    tx('2026-10-21', 4500, 'ca_food', { note: '外卖' })
  ]);
  const r = run(txs);
  const o = byCode(r, 'OUTLIER');
  checkEq(o.length, 1, '一条');
  checkEq(o[0].rows.length, 1, '只点一笔');
  checkEq(o[0].rows[0].amountCents, 90000, '点的是大额那笔');
  check(o[0].facts[0].indexOf('60 倍') >= 0, '事实行：' + o[0].facts[0]);
});

test('4.2 该分类「平时水平」不足 6 笔不判', function () {
  const r = run(flatDays(5, 1500, 'ca_pet').concat([tx('2026-10-20', 90000, 'ca_pet')]));
  check(!hasCode(r, 'OUTLIER'), '参照只有 5 笔');
  const enough = run(flatDays(6, 1500, 'ca_pet').concat([tx('2026-10-20', 90000, 'ca_pet')]));
  checkEq(byCode(enough, 'OUTLIER').length, 1, '参照 6 笔即判');
});

test('4.3 最多点 3 笔', function () {
  const txs = flatDays(20, 1500, 'ca_food').concat([tx('2026-11-10', 80000, 'ca_food'), tx('2026-11-12', 70000, 'ca_food'), tx('2026-11-14', 60000, 'ca_food'), tx('2026-11-16', 50000, 'ca_food')]);
  checkEq(byCode(run(txs), 'OUTLIER')[0].rows.length, 3, '上限');
});

/* ============================== 断档 / 停记 / 分类 ============================== */

section('用例 5：断档月份、久未记账、分类不清');

function monthFill(ym, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) { out.push(tx(ym + '-' + String(1 + i * 2).padStart(2, '0'), 1000 + i * 13, 'ca_food')); }
  return out;
}

test('5.1 首尾之间几乎没记的整月被点出，首月与当前月不算', function () {
  const r = run([].concat(monthFill('2026-07', 6), monthFill('2026-09', 6), monthFill('2026-10', 6), monthFill('2026-11', 6)));
  const g = byCode(r, 'GAP');
  checkEq(g.length, 1, '一条');
  checkEq(g[0].facts.join(','), '8月', '只点 8月');
  checkEq(g[0].severity, 'low', '一个月是弱');
});

test('5.2 断档 ≥ 3 个月升为中', function () {
  const r = run([].concat(monthFill('2026-05', 6), monthFill('2026-10', 6)));
  const g = byCode(r, 'GAP');
  checkEq(g[0].severity, 'mid', '中');
  checkEq(g[0].facts.length, 4, '6、7、8、9 月');
});

test('5.3 久未记账：22 天弱、64 天中、3 天不报', function () {
  checkEq(byCode(run([tx('2026-11-01', 1000)]), 'STALE')[0].severity, 'low', '22 天');
  checkEq(byCode(run([tx('2026-09-20', 1000)]), 'STALE')[0].severity, 'mid', '64 天');
  check(!hasCode(run([tx('2026-11-20', 1000)]), 'STALE'), '3 天');
});

test('5.4 近 3 个月「其他」占比过高中，金额太小不报', function () {
  const base = monthFill('2026-10', 5).concat(monthFill('2026-11', 5)); /* 10 笔 ¥10~¥13 */
  const messy = base.concat([tx('2026-10-20', 2000, 'ca_other_expense', { categoryName: '其他' }), tx('2026-11-20', 2000, 'ca_other_expense', { categoryName: '其他' })]);
  const o = byCode(run(messy), 'OTHER');
  checkEq(o.length, 1, '一条');
  check(o[0].title.indexOf('%') >= 0, '标题带占比：' + o[0].title);
  const tiny = base.concat([tx('2026-10-20', 500, 'ca_other_expense', { categoryName: '其他' }), tx('2026-11-20', 500, 'ca_other_expense', { categoryName: '其他' })]);
  check(!hasCode(run(tiny), 'OTHER'), '金额不足 ¥30');
});

/* ============================== 月支出突增 ============================== */

section('用例 6：月支出突增');

function surgeTx(octExtraCents) {
  const sept = [];
  for (let i = 0; i < 5; i += 1) { sept.push(tx('2026-09-' + String(2 + i * 5).padStart(2, '0'), 4000 + i, 'ca_food')); }
  const oct = [];
  for (let i = 0; i < 4; i += 1) { oct.push(tx('2026-10-' + String(2 + i * 7).padStart(2, '0'), 4000 + i, 'ca_food')); }
  for (let i = 0; i < 3; i += 1) { oct.push(tx('2026-10-' + String(4 + i * 9).padStart(2, '0'), octExtraCents, 'ca_fun', { categoryName: '娱乐' })); }
  return sept.concat(oct);
}

test('6.1 上个完整月多花 ≥30% 且 ≥¥200 → 点出，并按分类拆解', function () {
  const r = run(surgeTx(12000));
  const s = byCode(r, 'SURGE');
  checkEq(s.length, 1, '一条');
  check(s[0].title.indexOf('10月 比 9月 多花了') >= 0, '标题：' + s[0].title);
  checkEq(s[0].facts[0], '娱乐 +¥360.00', '拆解第一位');
  checkEq(s[0].severity, 'mid', '中');
});

test('6.2 当月未过完不参与对比；多花不到 30% 不报', function () {
  const r = run(surgeTx(5000));
  check(!hasCode(r, 'SURGE'), '娱乐只多 ¥150');
});

/* ============================== 体检分 / 纯净性 / 容错 ============================== */

section('用例 7：体检分、纯净性、容错');

test('7.1 干净的账本：无发现、100 分、很健康', function () {
  const r = run(daily('2026-11-01', 12, 800));
  checkEq(r.findings.length, 0, '无发现');
  checkEq(r.score, 100, '分数');
  checkEq(r.grade, '很健康', '评级');
  checkEq(r.recurring.length, 0, '无周期');
  checkEq(r.asOf, TODAY, 'asOf');
});

test('7.2 扣分规则：高 20 / 中 10 / 低 5，下限 0', function () {
  const r = run([].concat(
    daily('2026-11-01', 12, 800),
    [tx('2026-11-15', 1111, 'ca_food', { time: '12:00' }), tx('2026-11-15', 1111, 'ca_food', { time: '12:00' })]
  ));
  checkEq(byCode(r, 'DUP')[0].severity, 'high', '高');
  checkEq(r.score, 80, '100 − 20');
  const many = run([].concat(
    monthFill('2026-03', 6), monthFill('2026-10', 6), /* 6 个月断档 → mid */
    [tx('2026-10-20', 1000, 'ca_food', { time: '12:00' }), tx('2026-10-20', 1000, 'ca_food', { time: '12:00' })],
    [tx('2026-10-21', 500, 'ca_other_expense', { categoryName: '其他' })],
    [tx('2026-03-10', 1000, 'ca_fun', { categoryName: '娱乐' }), tx('2026-03-13', 1000, 'ca_fun', { categoryName: '娱乐' })]
  ));
  check(many.score >= 0 && many.score < 100, '分数在范围内且被扣：' + many.score);
});

test('7.3 不改入参、两次结果完全一致', function () {
  const txs = [].concat(rentDates().map((d) => tx(d, 120000, 'ca_home')), [tx('2026-11-10', 1500, 'ca_food', { time: '12:00' }), tx('2026-11-10', 1500, 'ca_food', { time: '12:00' })]);
  const before = JSON.stringify(txs);
  const a = run(txs);
  const b = run(txs);
  checkEq(JSON.stringify(txs), before, '入参被改');
  checkEq(JSON.stringify(a), JSON.stringify(b), '结果不稳定');
});

test('7.4 坏输入不抛错', function () {
  const bad = [null, undefined, {}, { transactions: 'x' }, { transactions: [null, {}, { date: 5 }, { date: 'nope', amountCents: 'abc' }], today: '2026-13-40' }];
  bad.forEach((input) => {
    let r = null;
    try { r = audit.run(input); } catch (e) { throw new Error('抛错了：' + e.message); }
    check(r && r.ok === true, '应 ok：' + JSON.stringify(input));
    checkEq(r.findings.length, 0, '无发现');
  });
});

test('7.5 RULES 只读暴露且冻结', function () {
  check(Object.isFrozen(audit.RULES), 'RULES 冻结');
  check(Object.isFrozen(audit), 'audit 冻结');
  check(audit.RULES.OUTLIER_MIN_COUNT >= 1, '阈值可见');
});

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
