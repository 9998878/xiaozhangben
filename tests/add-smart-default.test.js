'use strict';
/*
 * tests/add-smart-default.test.js
 * 自检脚本：2.28.9「历史智能默认」——add.js 的 suggestCategoryByAccount。
 * 来源：MMEX「收款方记住上次分类」/一木「同商家沿用上次分类」（竞品吸收批次一 C）。
 *
 * 运行：node tests/add-smart-default.test.js（scripts/test.js 自动收集）
 *
 * 提取方式：suggestCategoryByAccount 是无外部依赖的纯函数，用与 catalogNeedsSync
 * 相同的 liftFunction 范式从 js/screens/add.js 源码提升真实实现执行（不复写实现）。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADD_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'add.js'), 'utf8');

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

/* ============================== 源码提升（同 category-expansion 范式） ============================== */

/* 跳过字符串与注释的花括号配对扫描：返回与 start 同层配对的收尾下标（含）。 */
function matchBracket(src, start, openCh, closeCh) {
  let depth = 0;
  let i = start;
  let state = ''; // '' | "'" | '"' | 'line' | 'block'
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === '') {
      if (ch === "'" || ch === '"') { state = ch; }
      else if (ch === '/' && next === '/') { state = 'line'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'block'; i += 1; }
      else if (ch === openCh) { depth += 1; }
      else if (ch === closeCh) {
        depth -= 1;
        if (depth === 0) { return i; }
      }
    } else if (state === "'" || state === '"') {
      if (ch === '\\') { i += 1; }
      else if (ch === state) { state = ''; }
    } else if (state === 'line') {
      if (ch === '\n') { state = ''; }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = ''; i += 1; }
    }
    i += 1;
  }
  return -1;
}

/* 从源码里提升一个具名 function 的完整源码。 */
function liftFunction(src, fnName) {
  const re = new RegExp('function\\s+' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) { return null; }
  const openIdx = src.indexOf('{', m.index);
  const closeIdx = matchBracket(src, openIdx, '{', '}');
  if (closeIdx < 0) { return null; }
  return src.slice(m.index, closeIdx + 1);
}

const lifted = liftFunction(ADD_JS, 'suggestCategoryByAccount');
if (!lifted) { throw new Error('add.js 里找不到 suggestCategoryByAccount（批次一 C 未落地？）'); }
const vm = require('vm');
const sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(lifted + '\nglobalThis.__suggest = suggestCategoryByAccount;', sandbox, { filename: 'lifted:add.js#suggestCategoryByAccount' });
const suggest = sandbox.__suggest;

/* ============================== 固定数据 ============================== */

const AC_WECHAT = 'ac_wechat';
const AC_ALIPAY = 'ac_alipay';
const CA_FOOD = 'ca_food';
const CA_TRANSPORT = 'ca_transport';

function tx(id, opts) {
  return Object.assign({
    id: id,
    bookId: 'bk_daily',
    type: 'expense',
    amountCents: 3200,
    accountId: AC_WECHAT,
    toAccountId: null,
    categoryId: CA_FOOD,
    date: '2026-11-01',
    time: '12:00',
    note: '',
    tags: [],
    photoIds: [],
    source: 'manual',
    deleted: false
  }, opts || {});
}

function dbWith(list) {
  return { transactions: list };
}

/* ============================== 用例 ============================== */

section('用例 1：最近 3 笔分类一致 → 命中（数组乱序也按 date+time 取最近）');
test('1.1 乱序数组里最近 3 笔全为餐饮 → ca_food', function () {
  const db = dbWith([
    tx('old1', { date: '2026-11-01', time: '09:00', categoryId: CA_TRANSPORT }),
    tx('mid', { date: '2026-11-02', time: '10:00' }),
    tx('new2', { date: '2026-11-05', time: '10:00' }),
    tx('new1', { date: '2026-11-06', time: '09:30' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), CA_FOOD, '命中最近 3 笔一致分类');
});

test('1.2 最近 3 笔一致但第 4 旧不一致 → 仍命中（窗口只看最近 3）', function () {
  const db = dbWith([
    tx('oldest', { date: '2026-10-01', time: '08:00', categoryId: CA_TRANSPORT }),
    tx('a', { date: '2026-11-03', time: '09:00' }),
    tx('b', { date: '2026-11-04', time: '09:00' }),
    tx('c', { date: '2026-11-05', time: '09:00' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), CA_FOOD, '第 4 旧不一致不影响');
});

section('用例 2：最近 3 笔不一致 / 不足 3 笔 → 空串');
test('2.1 最近 3 笔分类不一致 → ""', function () {
  const db = dbWith([
    tx('a', { date: '2026-11-03', time: '09:00', categoryId: CA_TRANSPORT }),
    tx('b', { date: '2026-11-04', time: '09:00' }),
    tx('c', { date: '2026-11-05', time: '09:00', categoryId: CA_TRANSPORT })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), '', '不一致回落默认');
});

test('2.2 只有 2 笔有效 → ""', function () {
  const db = dbWith([
    tx('a', { date: '2026-11-04', time: '09:00' }),
    tx('b', { date: '2026-11-05', time: '09:00' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), '', '不足 3 笔');
});

test('2.3 空账户 / 空流水 → ""', function () {
  checkEq(suggest(dbWith([tx('a', {})]), '', 'expense'), '', 'accountId 为空');
  checkEq(suggest(dbWith([]), AC_WECHAT, 'expense'), '', '无流水');
  checkEq(suggest(null, AC_WECHAT, 'expense'), '', 'db 为 null');
});

section('用例 3：过滤口径');
test('3.1 deleted === true 不计', function () {
  const db = dbWith([
    tx('del', { date: '2026-11-05', time: '09:00', deleted: true }),
    tx('a', { date: '2026-11-02', time: '09:00' }),
    tx('b', { date: '2026-11-03', time: '09:00' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), '', '删 1 笔后只剩 2 笔有效');
});

test('3.2 转账不计（转账天然无分类）', function () {
  const db = dbWith([
    tx('tr', { date: '2026-11-05', time: '09:00', type: 'transfer', categoryId: '' }),
    tx('a', { date: '2026-11-02', time: '09:00' }),
    tx('b', { date: '2026-11-03', time: '09:00' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), '', '转账不参与');
});

test('3.3 账户不匹配不计', function () {
  const db = dbWith([
    tx('other', { date: '2026-11-05', time: '09:00', accountId: AC_ALIPAY }),
    tx('a', { date: '2026-11-02', time: '09:00' }),
    tx('b', { date: '2026-11-03', time: '09:00' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), '', '他账户历史不参与');
});

test('3.4 跨账本可见（bookId 不同、账户相同 → 计入；决策点 5 默认口径）', function () {
  const db = dbWith([
    tx('t1', { date: '2026-11-03', time: '09:00', bookId: 'bk_travel' }),
    tx('t2', { date: '2026-11-04', time: '09:00', bookId: 'bk_travel' }),
    tx('t3', { date: '2026-11-05', time: '09:00', bookId: 'bk_daily' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'expense'), CA_FOOD, '跨账本历史参与');
});

test('3.5 收入类型独立窗口（type 匹配才计）', function () {
  const db = dbWith([
    tx('i1', { date: '2026-11-03', time: '09:00', type: 'income', categoryId: 'ca_salary' }),
    tx('i2', { date: '2026-11-04', time: '09:00', type: 'income', categoryId: 'ca_salary' }),
    tx('e1', { date: '2026-11-05', time: '09:00', type: 'income', categoryId: 'ca_other_income' })
  ]);
  checkEq(suggest(db, AC_WECHAT, 'income'), '', '收入 3 笔分类不一致');
  const db2 = dbWith([
    tx('i1', { date: '2026-11-03', time: '09:00', type: 'income', categoryId: 'ca_salary' }),
    tx('i2', { date: '2026-11-04', time: '09:00', type: 'income', categoryId: 'ca_salary' }),
    tx('i3', { date: '2026-11-05', time: '09:00', type: 'income', categoryId: 'ca_salary' })
  ]);
  checkEq(suggest(db2, AC_WECHAT, 'income'), 'ca_salary', '收入 3 笔一致命中');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('PASS ' + passCount + ' / FAIL ' + failCount);
if (failCount > 0) { process.exit(1); }
