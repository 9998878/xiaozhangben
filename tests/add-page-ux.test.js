'use strict';
/*
 * tests/add-page-ux.test.js
 * 自检脚本：2.36.0「记一笔页专项」——按键热路径去重 + 硬件键盘补全 + 备注聚焦 + 再记一笔。
 *
 * 运行：node tests/add-page-ux.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：
 *  - keypad.js 用假 DOM（记录 textContent 写入次数）+ 真实 money 内联块驱动 mount/setValue/confirm，
 *    验证算式求值正确、重复 setValue 不再产生 DOM 写入、零值禁用态口径不变；
 *  - add.js 的缓存/聚焦/动作接线用源码区域断言兜底（与 accountless-ui 同范式）。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ADD_JS = fs.readFileSync(path.join(ROOT, 'js/screens/add.js'), 'utf8');
const KEYPAD_JS = fs.readFileSync(path.join(ROOT, 'js/modules/keypad.js'), 'utf8');

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

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

/* ============================== 用例 1：keypad 渲染热路径（行为） ============================== */

section('用例 1：keypad 算式求值与重复 setValue 零写入');

/* 假 DOM：textContent 用 defineProperty 计次，其余按 keypad 实际用到的面补齐 */
function fakeEl(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    attrs: {},
    style: {},
    _text: '',
    writes: 0,
    parentNode: null,
    disabled: false,
    hidden: false,
    type: '',
    className: '',
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    removeAttribute: function (k) { delete this.attrs[k]; },
    getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild: function (c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); }
      c.parentNode = null;
      return c;
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function () { return null; },
    setPointerCapture: function () {}
  };
  Object.defineProperty(node, 'firstChild', { get: function () { return this.children[0] || null; } });
  Object.defineProperty(node, 'textContent', {
    get: function () { return this._text; },
    set: function (v) { this._text = String(v); this.writes += 1; }
  });
  Object.defineProperty(node, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = String(v); }
  });
  return node;
}

function mountKeypad() {
  const sandbox = {
    console: console,
    document: { createElement: function (tag) { return fakeEl(tag); } },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  vm.createContext(sandbox);
  const moneyBlock = findInlineBlock('js/core/money.js');
  if (!moneyBlock) { throw new Error('找不到 money 内联块'); }
  vm.runInContext(moneyBlock, sandbox, { filename: 'inline:money.js' });
  vm.runInContext(KEYPAD_JS, sandbox, { filename: 'keypad.js' });
  const host = fakeEl('div');
  const handle = sandbox.XZB.UI.keypad.mount(host, {});
  /* root(c-keypad) → display → [currency, amount, totalHint] */
  const root = host.children[0];
  const display = root.children[0];
  const amount = display.children[1];
  const totalHint = display.children[2];
  const grid = root.children[1];
  const confirmBtn = grid.children[grid.children.length - 1];
  return { sandbox: sandbox, handle: handle, amount: amount, totalHint: totalHint, confirmBtn: confirmBtn, display: display };
}

test('1.1 算式 12+3 → 显示原式、合计 = ¥15.00，confirm 得 1500 分', function () {
  const k = mountKeypad();
  k.handle.setValue('12+3');
  checkEq(k.amount.textContent, '12+3', '显示保留算式');
  checkEq(k.totalHint.textContent, '= ¥15.00', '合计提示');
  const r = k.handle.confirm();
  checkEq(r.ok, true, 'confirm ok');
  checkEq(r.cents, 1500, 'confirm 分值');
});

test('1.2 重复 setValue 同值 → 金额/合计/aria-label 零新增写入', function () {
  const k = mountKeypad();
  k.handle.setValue('12+3');
  const before = k.amount.writes + k.totalHint.writes;
  k.handle.setValue('12+3');
  k.handle.setValue('12+3');
  checkEq(k.amount.writes + k.totalHint.writes, before, '重复同值不再写 DOM');
});

test('1.3 换值仍正常刷新（缓存不吞真实变化）', function () {
  const k = mountKeypad();
  k.handle.setValue('12+3');
  k.handle.setValue('8-2.5');
  checkEq(k.amount.textContent, '8-2.5', '新算式上屏');
  checkEq(k.totalHint.textContent, '= ¥5.50', '新合计');
  k.handle.setValue('');
  checkEq(k.amount.textContent, '0.00', '空值回落 0.00');
  checkEq(k.totalHint.textContent, '', '无算式无合计');
});

test('1.4 零值/空值确认键 aria-disabled=true，有值移除（口径不变）', function () {
  const k = mountKeypad();
  checkEq(k.confirmBtn.getAttribute('aria-disabled'), 'true', '初始零值禁用');
  k.handle.setValue('5');
  checkEq(k.confirmBtn.getAttribute('aria-disabled'), null, '有值移除禁用');
  k.handle.setValue('0');
  checkEq(k.confirmBtn.getAttribute('aria-disabled'), 'true', '0 禁用');
  k.handle.setValue('3-3');
  checkEq(k.confirmBtn.getAttribute('aria-disabled'), 'true', '算式结果为 0 也禁用');
});

test('1.5 悬挂运算符按已输入部分求值（现行 parseCurrent 口径），空值 confirm 失败', function () {
  const k = mountKeypad();
  k.handle.setValue('12+');
  checkEq(k.amount.textContent, '12+', '原式上屏');
  checkEq(k.totalHint.textContent, '= ¥12.00', '悬挂 + 按前缀 12 求值');
  const r = k.handle.confirm();
  checkEq(r.ok, true, 'confirm 取前缀合计');
  checkEq(r.cents, 1200, '合计分值');
  const k2 = mountKeypad();
  const empty = k2.handle.confirm();
  checkEq(empty.ok, false, '空值 confirm 失败');
  checkEq(empty.code, 'E_AMOUNT_EMPTY', '空值错误码');
});

/* ============================== 用例 2：add.js 按键热路径缓存（源码区域断言） ============================== */

section('用例 2：add.js 同步热路径「变化才写」');

function region(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) { throw new Error('找不到区域起点 ' + startMarker); }
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : -1;
  return src.slice(start, end > start ? end : undefined);
}

test('2.1 syncDraft：图标缓存 lastDraftIcon，仅换图标时重建 SVG', function () {
  const body = region(ADD_JS, 'function syncDraft()', 'function syncKeypadContext()');
  check(body.indexOf('lastDraftIcon') >= 0, '应有图标缓存');
  check(body.indexOf('if (iconName !== lastDraftIcon)') >= 0, '图标变化才重建');
  check(body.indexOf('if (amtText !== lastDraftAmtText)') >= 0, '金额文本变化才写');
  check(body.indexOf('if (catName !== lastDraftCatName)') >= 0, '分类名变化才写');
});

test('2.2 syncKeypadContext：确认键节点走缓存，文案变化才写', function () {
  const body = region(ADD_JS, 'function syncKeypadContext()', 'function showReason(');
  check(body.indexOf('confirmKeyNode()') >= 0, '确认键走缓存节点');
  check(body.indexOf('if (ctxText !== lastCtxText)') >= 0, '上下文变化才写');
  check(body.indexOf('if (label !== lastConfirmLabel)') >= 0, '确认键文案变化才写');
});

test('2.3 showReason 顶掉上下文后缓存作废，定时恢复必然重写', function () {
  const body = region(ADD_JS, 'function showReason(', 'function pulseAmount(');
  check(body.indexOf('lastCtxText = null') >= 0, '原因文案写入后缓存应作废');
});

test('2.4 paintPhotoConfirm：复用缓存节点，忙态没变不写属性', function () {
  const body = region(ADD_JS, 'function paintPhotoConfirm()', 'function paintPhotoStrip()');
  check(body.indexOf('confirmKeyNode()') >= 0, '应复用缓存节点');
  check(body.indexOf('if (busy === lastPhotoBusy) return') >= 0, '忙态未变应提前返回');
});

test('2.5 syncTitle / onViewportChange：标题与键盘标记变化才写', function () {
  const title = region(ADD_JS, 'function syncTitle()', 'function syncSaveState()');
  check(title.indexOf('if (title === lastTitle) return') >= 0, '标题未变应跳过');
  const vp = region(ADD_JS, 'function onViewportChange()', '/* ---------- 同步：草稿条');
  check(vp.indexOf('if (flag === lastKbFlag) return') >= 0, '键盘标记未变应跳过');
});

test('2.6 死代码 applyStateToView 已移除', function () {
  check(ADD_JS.indexOf('applyStateToView') < 0, '不应再有无调用方的 applyStateToView');
});

/* ============================== 用例 3：硬件键盘补全（源码区域断言） ============================== */

section('用例 3：硬件键盘 Enter=保存、加减算式');

test('3.1 onKeyDown 处理 Enter：可交互元素放行原生 click，其余走 keypad.confirm', function () {
  const body = region(ADD_JS, 'function onKeyDown(', 'listen(global.document, \'keydown\', onKeyDown)');
  check(body.indexOf("key === 'Enter'") >= 0, '应处理 Enter');
  check(body.indexOf("tag === 'button' || tag === 'a' || tag === 'select'") >= 0, '可交互元素应放行');
  check(body.indexOf('keypadHandle.confirm()') >= 0, 'Enter 应走组件 confirm');
});

test('3.2 onKeyDown 处理 +/-：与 appendOperator 同规则（空值不打头、连按换符号、收悬挂小数点）', function () {
  const body = region(ADD_JS, 'function onKeyDown(', 'listen(global.document, \'keydown\', onKeyDown)');
  check(body.indexOf("key === '+' || key === '-'") >= 0, '应处理加减号');
  check(body.indexOf("if (!base) return") >= 0, '空值不应打头');
  check(body.indexOf("lastCh === '+' || lastCh === '-' || lastCh === '.'") >= 0, '尾部符号/小数点应先收掉');
  check(body.indexOf('keypadHandle.setValue(state.amountText)') >= 0, '仍交组件 sanitize');
});

/* ============================== 用例 4：备注聚焦与再记一笔 ============================== */

section('用例 4：备注弹层自动聚焦 + 成功提示「再记一笔」');

test('4.1 openNoteSheet：挂载后同步聚焦输入框，光标置文末', function () {
  const body = region(ADD_JS, 'function openNoteSheet()', '/* ---------- 同步：标签');
  check(body.indexOf('input.focus({ preventScroll: true })') >= 0, '应同步聚焦（iOS 手势内）');
  check(body.indexOf('input.setSelectionRange(caret, caret)') >= 0, '光标应置文末');
});

test('4.2 成功提示带「再记一笔」动作，点击进新的记一笔；默认仍 goBack', function () {
  const body = region(ADD_JS, 'function attemptSave()', '/* ---------- 删除（编辑模式）');
  check(body.indexOf("label: '再记一笔'") >= 0, '应有再记一笔动作');
  check(body.indexOf("XZB.router.go('#/add')") >= 0, '动作应路由到记一笔');
  check(body.indexOf('goBack();') >= 0, '默认返回流程保留');
  check(body.indexOf('successOpts.action') >= 0, '动作挂在成功提示上');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }