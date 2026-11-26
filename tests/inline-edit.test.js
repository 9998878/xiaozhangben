'use strict';
/*
 * tests/inline-edit.test.js
 * 自检脚本：2.42.0「流水行行内编辑」——js/modules/inline-edit.js 的纯函数与接线断言。
 *
 * 运行：node tests/inline-edit.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：inline-edit.js 为 IIFE，Node 下走 global 分支挂 XZB.Core.inlineEdit /
 * XZB.ui.inlineEdit，整文件读进 vm 沙箱真实执行（不是复写实现）。沙箱无 document，
 * 顺带验证 DOM 件在无浏览器环境恒返回 null、不抛错。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'inline-edit.js'), 'utf8');
const LEDGER_SRC = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'ledger.js'), 'utf8');
const ADD_SRC = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'add.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

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

const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'js/modules/inline-edit.js' });
const IE = sandbox.XZB.Core.inlineEdit;
if (!IE || typeof IE.parseAmountText !== 'function') {
  throw new Error('XZB.Core.inlineEdit 不可用');
}

/* ============================== 1 金额解析 ============================== */

section('1 金额解析（整数分）');

test('1.1 常规两位小数', () => {
  checkEq(IE.parseAmountText('13.90').cents, 1390, '13.90');
  checkEq(IE.parseAmountText('0.32').cents, 32, '0.32');
  checkEq(IE.parseAmountText('20').cents, 2000, '20');
});

test('1.2 首尾空白容忍', () => {
  checkEq(IE.parseAmountText(' 3.32 ').cents, 332, 'trim');
});

test('1.3 一位小数补零', () => {
  checkEq(IE.parseAmountText('128.5').cents, 12850, '128.5');
});

test('1.4 上界：9 位整数元 + 2 位小数', () => {
  checkEq(IE.parseAmountText('999999999.99').cents, 99999999999, '上界');
  checkEq(IE.parseAmountText('1000000000').ok, false, '超上界拒绝');
  checkEq(IE.parseAmountText('1234567890').ok, false, '10 位整数拒绝');
});

test('1.5 非法输入一律拒绝', () => {
  ['', '0', '0.00', '-5', 'abc', '12.345', '1,000', '12.', '.5', '1e3'].forEach((bad) => {
    checkEq(IE.parseAmountText(bad).ok, false, '拒绝 ' + JSON.stringify(bad));
    checkEq(IE.parseAmountText(bad).code, 'E_AMOUNT_INVALID', '错误码 ' + JSON.stringify(bad));
  });
});

/* ============================== 2 日期 / 时间 / 批注 ============================== */

section('2 日期 / 时间 / 批注校验');

test('2.1 合法日期', () => {
  check(IE.isValidDateStr('2026-11-25'), '2026-11-25');
  check(IE.isValidDateStr('2024-02-29'), '闰年 2024-02-29');
});

test('2.2 非法日期', () => {
  ['2026-02-30', '2026-13-01', '2026-1-01', '2026-02-29', '20261125', '', '2026-00-10'].forEach((bad) => {
    check(!IE.isValidDateStr(bad), '拒绝 ' + JSON.stringify(bad));
  });
});

test('2.3 时间 HH:MM 24 小时制', () => {
  check(IE.isValidTimeStr('11:37'), '11:37');
  check(IE.isValidTimeStr('23:34'), '23:34');
  check(IE.isValidTimeStr('00:00'), '00:00');
  ['24:00', '9:00', '12:60', '12:5', '', '12:00:00'].forEach((bad) => {
    check(!IE.isValidTimeStr(bad), '拒绝 ' + JSON.stringify(bad));
  });
});

test('2.4 批注 trim + 80 字截断（与 schema txNote 一致）', () => {
  checkEq(IE.normalizeNote('  午餐·牛肉面  '), '午餐·牛肉面', 'trim');
  checkEq(IE.normalizeNote(null), '', 'null');
  checkEq(IE.normalizeNote(undefined), '', 'undefined');
  checkEq(IE.normalizeNote('x'.repeat(100)).length, 80, '截断 80');
  checkEq(IE.NOTE_MAX, 80, 'NOTE_MAX 与 schema LIMITS.txNote 一致');
});

test('2.5 既有 80 字批注行内编辑不丢字（2.44.1 P2-1 回归）', () => {
  const long = '字'.repeat(80);
  const r = IE.validatePatch({ note: long });
  check(r.ok, 'ok');
  checkEq(r.patch.note, long, '80 字原样保留');
  const r2 = IE.validatePatch({ note: long + '溢' });
  check(r2.ok, 'ok');
  checkEq(r2.patch.note.length, 80, '超 80 才截断');
});

/* ============================== 3 validatePatch ============================== */

section('3 validatePatch 只收目标字段');

test('3.1 批注归一化进 patch', () => {
  const r = IE.validatePatch({ note: ' 资料 ' });
  check(r.ok, 'ok');
  checkEq(r.patch.note, '资料', 'note');
  checkEq(Object.keys(r.patch).length, 1, '只一个键');
});

test('3.2 amountText 与 amountCents 二选一', () => {
  checkEq(IE.validatePatch({ amountText: '20' }).patch.amountCents, 2000, 'text');
  checkEq(IE.validatePatch({ amountCents: 32 }).patch.amountCents, 32, 'cents');
  checkEq(IE.validatePatch({ amountCents: 0 }).ok, false, '0 拒绝');
  checkEq(IE.validatePatch({ amountCents: 1.5 }).ok, false, '非整数拒绝');
});

test('3.3 日期/时间非法给对应错误码', () => {
  checkEq(IE.validatePatch({ date: '2026-02-30' }).code, 'E_TX_DATE', 'date');
  checkEq(IE.validatePatch({ time: '24:00' }).code, 'E_TX_TIME', 'time');
});

test('3.4 空 patch / 空 categoryId 拒绝', () => {
  checkEq(IE.validatePatch({}).code, 'E_PATCH_EMPTY', '空');
  checkEq(IE.validatePatch({ categoryId: '' }).ok, false, '空 categoryId');
});

test('3.5 多键组合只保留出现的键', () => {
  const r = IE.validatePatch({ date: '2026-11-24', time: '09:12' });
  check(r.ok, 'ok');
  checkEq(Object.keys(r.patch).sort().join(), 'date,time', '键集合');
});

/* ============================== 4 commit mutator ============================== */

section('4 buildTxPatchMutator（与 doDelete 同款形态）');

function fakeDb() {
  return {
    transactions: [
      { id: 't1', type: 'expense', categoryId: 'c1', amountCents: 1390, note: '', date: '2026-11-25', time: '11:37', photoIds: ['p1'] },
      { id: 't2', type: 'expense', categoryId: 'c2', amountCents: 30, note: '资料', date: '2026-11-25', time: '10:24' }
    ]
  };
}

test('4.1 只改目标字段，其余原样保留', () => {
  const db = fakeDb();
  const mutator = IE.buildTxPatchMutator('t1', { amountCents: 2000 }, 'NOW');
  const r = mutator(db);
  checkEq(r.value.id, 't1', 'value.id');
  checkEq(db.transactions[0].amountCents, 2000, '金额');
  checkEq(db.transactions[0].note, '', '批注不动');
  checkEq(db.transactions[0].categoryId, 'c1', '分类不动');
  checkEq(db.transactions[0].photoIds.join(), 'p1', '照片引用不动');
  checkEq(db.transactions[0].updatedAt, 'NOW', 'updatedAt');
  checkEq(db.transactions[1].amountCents, 30, '别行不动');
});

test('4.2 多键 patch 一次落齐', () => {
  const db = fakeDb();
  IE.buildTxPatchMutator('t1', { date: '2026-11-24', time: '09:12', note: 'x' }, 'NOW')(db);
  checkEq(db.transactions[0].date, '2026-11-24', 'date');
  checkEq(db.transactions[0].time, '09:12', 'time');
  checkEq(db.transactions[0].note, 'x', 'note');
});

test('4.3 找不到 / 已软删 / 无表恒 abort', () => {
  checkEq(IE.buildTxPatchMutator('nope', { note: 'x' }, 'NOW')(fakeDb()).code, 'E_TX_NOT_FOUND', '缺失');
  const db = fakeDb();
  db.transactions[0].deleted = true;
  checkEq(IE.buildTxPatchMutator('t1', { note: 'x' }, 'NOW')(db).code, 'E_TX_NOT_FOUND', '软删');
  checkEq(IE.buildTxPatchMutator('t1', { note: 'x' }, 'NOW')({}).code, 'E_STORE_TX', '无表');
});

test('4.4 normalize 钩子被调用且接管写回', () => {
  const db = fakeDb();
  let seen = null;
  const normalize = (next, nowIso) => { seen = { next: next, nowIso: nowIso }; return Object.assign({ normalized: true }, next); };
  IE.buildTxPatchMutator('t1', { note: 'y' }, 'NOW', normalize)(db);
  check(seen && seen.nowIso === 'NOW', 'normalize 收到 nowIso');
  checkEq(seen.next.note, 'y', 'normalize 收到 patch 后字段');
  checkEq(db.transactions[0].normalized, true, '写回 normalize 结果');
});

/* ============================== 5 分类过滤 ============================== */

section('5 categoriesForKind');

test('5.1 同 kind 且未软删', () => {
  const list = [
    { id: 'a', kind: 'expense', name: '餐饮' },
    { id: 'b', kind: 'income', name: '工资' },
    { id: 'c', kind: 'expense', name: '已删', deleted: true },
    null
  ];
  const ex = IE.categoriesForKind(list, 'expense');
  checkEq(ex.length, 1, '支出只剩 a');
  checkEq(ex[0].id, 'a', 'a');
  checkEq(IE.categoriesForKind(list, 'income')[0].id, 'b', '收入 b');
  checkEq(IE.categoriesForKind(null, 'expense').length, 0, 'null 安全');
});

/* ============================== 6 Node 无 DOM 安全 ============================== */

section('6 无 document 环境 DOM 件恒 null');

test('6.1 浮层/输入件不抛错', () => {
  const DOM = sandbox.XZB.ui.inlineEdit;
  checkEq(DOM.openPopover({}, 320, () => {}), null, 'openPopover');
  checkEq(DOM.mountNoteInput({}, '', {}), null, 'mountNoteInput');
  checkEq(DOM.mountAmountInput({}, 0, '-¥', {}), null, 'mountAmountInput');
  DOM.closePopover();
  DOM.flashRow(null);
});

/* ============================== 7 接线断言 ============================== */

section('7 接线：ledger / manifest / sw / 声明标签');

test('7.1 ledger 四热区与唯一写通道', () => {
  ['s-ledger-item__zone--media', 's-ledger-item__zone--text', 's-ledger-item__zone--amount', 's-ledger-item__zone--time'].forEach((cls) => {
    check(LEDGER_SRC.indexOf(cls) >= 0, 'ledger 缺 ' + cls);
  });
  check(LEDGER_SRC.indexOf('IE.buildTxPatchMutator') >= 0, 'mutator 接线');
  check(LEDGER_SRC.indexOf("commit(mutator, { label: '行内编辑' })") >= 0, 'commit 通道');
  check(LEDGER_SRC.indexOf('function openCatZone') >= 0, 'openCatZone');
  /* 2.43.0：换种类改本页底部 sheet 直选；sheet 缺失才退回记一笔页 pick=cat（深链兜底仍在） */
  check(LEDGER_SRC.indexOf("className: 's-ledger-catpick-sheet'") >= 0, '换种类本页 sheet');
  check(LEDGER_SRC.indexOf('commitInlinePatch(st, tx, { categoryId: cat.id }') >= 0, '点新分类即 commit');
  check(LEDGER_SRC.indexOf("navigate(st, '#/add?id=' + encodeURIComponent(String(tx.id || '')) + '&pick=cat')") >= 0, 'sheet 缺失退回 pick=cat');
  check(LEDGER_SRC.indexOf("'更换种类：' + title") >= 0, '图标热区无障碍标签');
  check(LEDGER_SRC.indexOf('IE.openPopover(anchor, 320') < 0, '种类宫格锚定浮层已移除');
  check(ADD_SRC.indexOf("String(context.params.pick || '') === 'cat'") >= 0, 'add 识别 pick=cat');
  check(ADD_SRC.indexOf('if (pickCat) {') >= 0 && ADD_SRC.indexOf('pickSaveName = String(category.name') >= 0, '选分类即保存');
  check(ADD_SRC.indexOf("showToast('种类已改为「' + pickSaveName + '」'") >= 0, '直选成功文案');
  check(LEDGER_SRC.indexOf('function openTimeZone') >= 0, 'openTimeZone');
  /* 2.43.0：日期时间手机底部弹层 / 桌面浮层双形态 */
  check(LEDGER_SRC.indexOf('function buildTimeFields') >= 0, '日期时间字段共用件');
  check(LEDGER_SRC.indexOf("className: 's-ledger-timesheet'") >= 0, '日期时间手机 sheet');
  check(LEDGER_SRC.indexOf("(pointer: coarse)") >= 0, '触屏判定');
  /* 2.43.0：保存后滚动恢复改 rAF 轮询新行（旧行打 pre-edit 标） */
  check(LEDGER_SRC.indexOf("setAttribute('data-pre-edit', '1')") >= 0, '旧行打标');
  check(LEDGER_SRC.indexOf(":not([data-pre-edit])") >= 0, '只认重建后的新行');
  check(LEDGER_SRC.indexOf('requestAnimationFrame') >= 0, 'rAF 轮询');
});

test('7.2 manifest / deps / 声明标签 / sw 预缓存', () => {
  check(INDEX_HTML.indexOf("['inline-edit', 'modules/inline-edit']") >= 0, 'manifest ROWS');
  check(INDEX_HTML.indexOf("ledger: ['inline-edit']") >= 0, 'deps ledger');
  check(INDEX_HTML.indexOf('<script type="text/xzb-module" data-xzb-chunk="inline-edit" src="js/modules/inline-edit.js"></script>') >= 0, '声明标签');
  check(SW_JS.indexOf("'./js/modules/inline-edit.js'") >= 0, 'sw PRECACHE');
});

test('7.3 CSS 封闭集合新增类都在 index.html', () => {
  ['.s-ledger-item__zone', '.s-ledger-item__note-input', '.s-ledger-item__amount-wrap', '.s-ledger-pop', '.s-ledger-item.is-flash',
    /* 2.43.0 新增 */
    '.s-ledger-item__amount-wrap.is-invalid', '.s-ledger-item__amount-hint', '.s-ledger-timesheet',
    '.s-ledger-catpick__grid', '.s-ledger-catpick__cell', '.s-ledger-catpick__manage', '--c-flash:'].forEach((sel) => {
    check(INDEX_HTML.indexOf(sel) >= 0, 'CSS 缺 ' + sel);
  });
  check(INDEX_HTML.indexOf('background: #fff6c2') < 0, 'flash 硬编码亮黄已改令牌');
  /* 2.43.0：--c-card/--c-line/--c-brand 是从未定义的幽灵令牌（深色下白底白字），不得回潮 */
  check(!/var\(--c-(card|line|brand)[,)]/.test(INDEX_HTML), '幽灵令牌回潮');
});

/* ============================== 8 DOM 桩行为（2.43.0） ============================== */

section('8 DOM 桩：金额无效保留 / 提示语分设备 / 浮层滚动即关');

/* 极简 DOM 桩：只实现 inline-edit DOM 件用到的面，真实执行源码而非复写实现。 */
function makeNode(tag) {
  const node = {
    tag, children: [], parentNode: null, listeners: {}, style: {}, dataset: {},
    className: '', value: '', textContent: '', hidden: false,
    offsetWidth: 0, offsetHeight: 40, focused: 0, selected: 0,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { if (on) { this._set.add(c); } else { this._set.delete(c); } }
    },
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
    insertBefore(n, ref) {
      n.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) { this.children.push(n); } else { this.children.splice(i, 0, n); }
      return n;
    },
    removeChild(n) {
      const i = this.children.indexOf(n);
      if (i >= 0) { this.children.splice(i, 1); }
      n.parentNode = null;
      return n;
    },
    contains(n) { let cur = n; while (cur) { if (cur === this) { return true; } cur = cur.parentNode; } return false; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((f) => f(ev || {})); },
    focus() { this.focused += 1; },
    select() { this.selected += 1; },
    getBoundingClientRect() { return { left: 10, top: 100, bottom: 140, right: 90 }; },
    get nextSibling() {
      const p = this.parentNode;
      if (!p) { return null; }
      return p.children[p.children.indexOf(this) + 1] || null;
    }
  };
  return node;
}

function domSandbox(opts) {
  const body = makeNode('body');
  const docEl = makeNode('html');
  docEl.clientWidth = 390;
  docEl.clientHeight = 844;
  const document = {
    createElement: makeNode,
    body,
    documentElement: docEl,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((f) => f(ev)); }
  };
  const sandbox = {
    console, setTimeout, clearTimeout, document,
    windowListeners: {},
    addEventListener(t, fn) { (this.windowListeners[t] = this.windowListeners[t] || []).push(fn); }
  };
  if (opts && opts.coarse !== undefined) {
    sandbox.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' ? opts.coarse : false });
  }
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'js/modules/inline-edit.js#dom' });
  return sandbox;
}

const KEY = (key) => ({ key, preventDefault() {}, stopPropagation() {} });

test('8.1 金额回车无效：编辑器保留 + 标红提示 + 重新全选，改对后仍能提交', () => {
  const sb = domSandbox();
  const IE = sb.XZB.ui.inlineEdit;
  const host = makeNode('span');
  const events = [];
  const handle = IE.mountAmountInput(host, 1390, '-¥', {
    onCommit: (cents) => events.push(['commit', cents]),
    onCancel: () => events.push(['cancel']),
    onInvalid: (info) => events.push(['invalid', info.via])
  });
  check(handle, 'mount 成功');
  const wrap = host.children[0];
  const input = wrap.children[1];
  input.value = 'abc';
  input.dispatch('keydown', KEY('Enter'));
  checkEq(events.length, 1, '只发一次 invalid');
  checkEq(events[0][1], 'enter', 'via=enter');
  check(wrap.classList.contains('is-invalid'), '标红');
  check(host.children.some((n) => n.textContent === '请输入大于 0 的数字'), '行内提示');
  checkEq(input.selected, 2, '重新全选（mount 一次 + 无效一次）');
  check(wrap.parentNode === host, '编辑器保留');
  /* 重新输入即清错，改对后回车正常提交 */
  input.value = '12.5';
  input.dispatch('input');
  check(!wrap.classList.contains('is-invalid'), '输入即清错');
  check(!host.children.some((n) => n.textContent === '请输入大于 0 的数字'), '提示移除');
  input.dispatch('keydown', KEY('Enter'));
  checkEq(events[events.length - 1].join(':'), 'commit:1250', '改对后提交');
  handle.destroy();
  check(wrap.parentNode === null, 'destroy 移除');
});

test('8.2 金额失焦无效：关闭并回调 via=blur，后续按键不再触发', () => {
  const sb = domSandbox();
  const IE = sb.XZB.ui.inlineEdit;
  const host = makeNode('span');
  const events = [];
  IE.mountAmountInput(host, 1390, '-¥', {
    onCommit: (cents) => events.push(['commit', cents]),
    onInvalid: (info) => events.push(['invalid', info.via])
  });
  const input = host.children[0].children[1];
  input.value = '0';
  input.dispatch('blur');
  checkEq(events.length, 1, '只发一次');
  checkEq(events[0].join(':'), 'invalid:blur', 'via=blur');
  input.dispatch('keydown', KEY('Enter'));
  checkEq(events.length, 1, 'done 后不再触发');
});

test('8.3 批注提示语分设备：触屏「点空白处保存」，桌面「回车保存 · Esc 取消」', () => {
  const coarse = domSandbox({ coarse: true });
  const hostA = makeNode('span');
  coarse.XZB.ui.inlineEdit.mountNoteInput(hostA, '', {});
  checkEq(hostA.children[1].textContent, '点空白处保存', '触屏提示');
  const fine = domSandbox({ coarse: false });
  const hostB = makeNode('span');
  fine.XZB.ui.inlineEdit.mountNoteInput(hostB, '', {});
  checkEq(hostB.children[1].textContent, '回车保存 · Esc 取消', '桌面提示');
});

test('8.4 浮层滚动即关：外部 scroll 关闭，浮层内部 scroll 不误关，resize 关闭', () => {
  const sb = domSandbox();
  const IE = sb.XZB.ui.inlineEdit;
  const anchor = makeNode('button');
  const handle = IE.openPopover(anchor, 252, (pop) => { pop.appendChild(makeNode('div')); });
  check(handle && handle.element.parentNode === sb.document.body, '浮层已挂 body');
  /* 内部滚动：目标在浮层内 → 不关 */
  sb.document.dispatch('scroll', { target: handle.element.children[0] });
  check(handle.element.parentNode === sb.document.body, '内部滚动不关');
  /* 外部滚动 → 关 */
  sb.document.dispatch('scroll', { target: makeNode('div') });
  check(handle.element.parentNode === null, '外部滚动即关');
  /* 再开一个，resize → 关 */
  const h2 = IE.openPopover(anchor, 252, () => {});
  (sb.windowListeners.resize || []).forEach((f) => f());
  check(h2.element.parentNode === null, 'resize 即关');
});

/* ============================== 汇总 ============================== */

console.log('\n通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) { process.exit(1); }