'use strict';
/*
 * tests/frontend-perf.test.js
 * 自检脚本：2.35.0「前端性能批次」——首屏 chunk 预载 + 明细滚动帧读写分批 + 照片异步解码。
 *
 * 运行：node tests/frontend-perf.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：
 *  - index.html 的 js/ui/preload-home.js 内联块进 vm 沙箱，注入假 document/location
 *    驱动真实实现，验证预载的路由门控、URL 形状与 file:// 省略 query；
 *  - 预载 URL 与 chunk-manifest.js（依赖/URL 唯一真源）的 url() 输出逐字比对；
 *  - ledger.js 的 syncStuck 按花括号配对提升进 vm，用记录读写顺序的假日头驱动，
 *    验证「先集中读、再集中写」与 is-stuck 判定口径不变；
 *  - 滚动帧顺序与照片 decoding 用源码断言兜底。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const LEDGER_JS = fs.readFileSync(path.join(ROOT, 'js/screens/ledger.js'), 'utf8');

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

/* ============================== 提取工具 ============================== */

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

/* 按花括号配对提升函数声明源码（ledger.js 的 syncStuck 是顶层 function 声明） */
function liftFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) { throw new Error('找不到函数 ' + name); }
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') { depth += 1; }
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { return src.slice(start, i + 1); }
    }
  }
  throw new Error('函数 ' + name + ' 花括号不配对');
}

const preloadBlock = findInlineBlock('js/ui/preload-home.js');
if (!preloadBlock) { throw new Error('index.html 中找不到 preload-home 内联块'); }
const manifestBlock = findInlineBlock('js/chunk-manifest.js');
if (!manifestBlock) { throw new Error('index.html 中找不到 chunk-manifest 内联块'); }

/* 当前版本 = index.html 唯一版本字面量 */
const versionLiterals = [...INDEX_HTML.matchAll(/XZB\.version\s*=\s*'(\d+\.\d+\.\d+)'/g)];
const VERSION = versionLiterals.length ? versionLiterals[versionLiterals.length - 1][1] : null;
if (!VERSION) { throw new Error('index.html 找不到版本字面量'); }

/* ============================== 用例 1：首屏预载行为 ============================== */

section('用例 1：preload-home 路由门控与 URL 形状');

function runPreload(hash, protocol) {
  const links = [];
  const sandbox = {
    console: console,
    document: {
      head: { appendChild: function (n) { links.push(n); } },
      createElement: function () { return {}; }
    },
    location: { hash: hash, protocol: protocol || 'https:' }
  };
  vm.createContext(sandbox);
  vm.runInContext(preloadBlock, sandbox, { filename: 'inline:preload-home.js' });
  return { links: links, XZB: sandbox.XZB };
}

test('1.1 空 hash（默认首屏）→ 预载 home/habit/ledger/inline-edit 四件套，rel=preload as=script', function () {
  const r = runPreload('');
  checkEq(r.links.length, 4, '预载链接数');
  for (const link of r.links) {
    checkEq(link.rel, 'preload', 'rel');
    checkEq(link.as, 'script', 'as');
  }
  checkEq(r.links[0].href, 'js/screens/home.js?v=' + VERSION, 'home URL');
  checkEq(r.links[1].href, 'js/modules/habit.js?v=' + VERSION, 'habit URL');
  checkEq(r.links[2].href, 'js/screens/ledger.js?v=' + VERSION, 'ledger URL');
  checkEq(r.links[3].href, 'js/modules/inline-edit.js?v=' + VERSION, 'inline-edit URL');
});

test('1.2 #/home 与 #/home?focus=budget 同样预载', function () {
  checkEq(runPreload('#/home').links.length, 4, '#/home');
  checkEq(runPreload('#/home?focus=budget').links.length, 4, '#/home?focus=budget');
});

test('1.3 非默认路由（#/add、#/settings/ai）不预载，保持原加载链', function () {
  checkEq(runPreload('#/add').links.length, 0, '#/add');
  checkEq(runPreload('#/settings/ai').links.length, 0, '#/settings/ai');
});

test('1.4 file:// 恒省略 query（与 chunk-manifest E2′ 一致）', function () {
  const r = runPreload('', 'file:');
  checkEq(r.links.length, 4, 'file:// 仍预载');
  checkEq(r.links[0].href, 'js/screens/home.js', 'file:// 无 ?v=');
});

test('1.5 预载 URL 与 chunk-manifest.url() 逐字一致（真源比对）', function () {
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(manifestBlock, sandbox, { filename: 'inline:chunk-manifest.js' });
  sandbox.XZB.version = VERSION;
  const r = runPreload('');
  checkEq(r.links[0].href, sandbox.XZB.chunks.url('home'), 'home 与 manifest 一致');
  checkEq(r.links[1].href, sandbox.XZB.chunks.url('habit'), 'habit 与 manifest 一致');
  checkEq(r.links[2].href, sandbox.XZB.chunks.url('ledger'), 'ledger 与 manifest 一致');
  checkEq(r.links[3].href, sandbox.XZB.chunks.url('inline-edit'), 'inline-edit 与 manifest 一致');
  /* habit 必须是 home 的声明依赖；ledger 依赖 inline-edit（2.42.0 行内编辑底座） */
  check(sandbox.XZB.chunks.deps.home.indexOf('habit') >= 0, 'home 依赖 habit');
  checkEq(sandbox.XZB.chunks.deps.ledger.length, 1, 'ledger 依赖数');
  check(sandbox.XZB.chunks.deps.ledger.indexOf('inline-edit') >= 0, 'ledger 依赖 inline-edit');
});

test('1.6 Node 环境（无 document/location）不抛错，版本仍定稿', function () {
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(preloadBlock, sandbox, { filename: 'inline:preload-home.js' });
  checkEq(sandbox.XZB.version, VERSION, 'Node 下版本定稿');
});

/* ============================== 用例 2：版本唯一字面量 ============================== */

section('用例 2：版本字面量唯一且位于 <head> 预载块');

test('2.1 index.html 版本字面量恰一处（app 块不再赋值）', function () {
  checkEq(versionLiterals.length, 1, '版本字面量个数');
  check(preloadBlock.indexOf("XZB.version = '" + VERSION + "'") >= 0, '字面量应在 preload-home 块内');
});

test('2.2 预载块位于第一个 <style> 之前（先于 323KB CSS 解析执行）', function () {
  const preloadAt = INDEX_HTML.indexOf('js/ui/preload-home.js');
  const styleAt = INDEX_HTML.indexOf('<style>');
  check(preloadAt >= 0 && styleAt >= 0 && preloadAt < styleAt, '预载块应先于首个 <style>');
});

test('2.3 core 模块的 || 兜底不会覆盖 head 定稿值', function () {
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(preloadBlock, sandbox, { filename: 'inline:preload-home.js' });
  vm.runInContext("XZB.version = XZB.version || '2.2.0';", sandbox, { filename: 'core-fallback-stub' });
  checkEq(sandbox.XZB.version, VERSION, '|| 兜底后版本不变');
});

/* ============================== 用例 3：syncStuck 读写分批 ============================== */

section('用例 3：syncStuck 先集中读再集中写，判定口径不变');

const syncStuckSrc = liftFunction(LEDGER_JS, 'syncStuck');
const stuckSandbox = { console: console };
vm.createContext(stuckSandbox);
vm.runInContext(syncStuckSrc, stuckSandbox, { filename: 'lift:syncStuck' });

function makeHead(top, rectTop, log) {
  return {
    style: { top: top },
    getBoundingClientRect: function () { log.push('read'); return { top: rectTop }; },
    classList: {
      toggle: function (name, force) { log.push('write'); this.last = { name: name, force: force }; }
    }
  };
}

function makeSt(heads) {
  return {
    dead: false,
    nodes: { days: { querySelectorAll: function () { return heads; } } }
  };
}

test('3.1 所有 getBoundingClientRect 读发生在任何 classList 写之前（消灭逐头强制重排）', function () {
  const log = [];
  const heads = [];
  for (let i = 0; i < 30; i += 1) { heads.push(makeHead('44px', i * 20, log)); }
  stuckSandbox.syncStuck(makeSt(heads));
  const lastRead = log.lastIndexOf('read');
  const firstWrite = log.indexOf('write');
  check(lastRead >= 0 && firstWrite >= 0, '应有读有写');
  check(lastRead < firstWrite, '读必须全部先于写：' + log.join(','));
  checkEq(log.filter(function (x) { return x === 'read'; }).length, 30, '读次数');
  checkEq(log.filter(function (x) { return x === 'write'; }).length, 30, '写次数');
});

test('3.2 is-stuck 判定口径不变：rect.top <= top + 1（含边界）', function () {
  const log = [];
  const stuck = makeHead('44px', 44, log);
  const boundary = makeHead('44px', 45, log);
  const free = makeHead('44px', 45.5, log);
  const far = makeHead('44px', 300, log);
  stuckSandbox.syncStuck(makeSt([stuck, boundary, free, far]));
  checkEq(stuck.classList.last.force, true, 'rect.top=44 应吸住');
  checkEq(boundary.classList.last.force, true, 'rect.top=45（top+1 边界）应吸住');
  checkEq(free.classList.last.force, false, 'rect.top=45.5 不吸住');
  checkEq(far.classList.last.force, false, 'rect.top=300 不吸住');
  checkEq(stuck.classList.last.name, 'is-stuck', '类名');
});

test('3.3 style.top 非有限值的日头跳过（不读不写）', function () {
  const log = [];
  const bad = makeHead('', 10, log);
  const good = makeHead('44px', 10, log);
  stuckSandbox.syncStuck(makeSt([bad, good]));
  checkEq(log.length, 2, '只有 good 的一读一写');
  check(!bad.classList.last, 'bad 不应被写');
});

test('3.4 dead / 缺 nodes 恒空操作', function () {
  const log = [];
  const st = makeSt([makeHead('44px', 10, log)]);
  st.dead = true;
  stuckSandbox.syncStuck(st);
  stuckSandbox.syncStuck({ dead: false, nodes: null });
  stuckSandbox.syncStuck(null);
  checkEq(log.length, 0, 'dead/缺件不读不写');
});

/* ============================== 用例 4：滚动帧顺序与照片解码 ============================== */

section('用例 4：滚动帧几何读取先行 + 照片异步解码');

test('4.1 onScroll：remain 读取先于 closeSwiped / syncStuck 的样式写', function () {
  const start = LEDGER_JS.indexOf('function onScroll()');
  const end = LEDGER_JS.indexOf("scroller.addEventListener('scroll'", start);
  check(start >= 0 && end > start, '找不到 onScroll 区域');
  const region = LEDGER_JS.slice(start, end);
  const remainAt = region.indexOf('var remain = scroller.scrollHeight');
  const closeAt = region.indexOf('closeSwiped(st)');
  const stuckAt = region.indexOf('syncStuck(st)');
  check(remainAt >= 0 && closeAt >= 0 && stuckAt >= 0, '三个锚点齐全');
  check(remainAt < closeAt && closeAt < stuckAt, '顺序应为 remain 读 → closeSwiped → syncStuck');
  check(region.indexOf('remain < LOAD_AHEAD && st.rendered < MAX_AUTO_ROWS') >= 0, '触底加载条件不变');
});

test('4.2 列表缩略图与详情照片两条路径都设 decoding=async', function () {
  const count = LEDGER_JS.split("img.decoding = 'async';").length - 1;
  checkEq(count, 2, 'decoding=async 赋值处数');
  const thumbAt = LEDGER_JS.indexOf('function renderThumbMedia');
  const detailAt = LEDGER_JS.indexOf('function buildDetailPhoto');
  check(LEDGER_JS.indexOf("img.decoding = 'async';", thumbAt) > thumbAt, '列表路径在 renderThumbMedia 内');
  check(LEDGER_JS.indexOf("img.decoding = 'async';", detailAt) > detailAt, '详情路径在 buildDetailPhoto 内');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }