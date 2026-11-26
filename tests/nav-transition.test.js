'use strict';
/*
 * tests/nav-transition.test.js
 * 2.44.4「切页卡顿修复」契约回归（用户反馈：页面切换有卡顿感）。
 *
 * 运行：node tests/nav-transition.test.js（scripts/test.js 自动收集）
 *
 * 真实行为断言在 scripts/smoke.js §6b（CI 浏览器里跑：Tab 根横切不调
 * startViewTransition、二级页进入调用、首页嵌入明细延后挂载落位）。
 * 路由渲染器深耦合应用启动，Node 沙箱无法独立真跑，本文件按 frontend-perf
 * 范式做源码契约检查，锁住三处改动的关键结构，防后续重构静默回退：
 *   1) Tab 根排除 VT 快照（renderRoute 闸门含 nav !== 'tab'）
 *   2) 转场专用时长令牌（--dur-nav-push/--dur-nav-tab，reduce 归零）
 *   3) 首页嵌入明细延后挂载 + 过期守卫 + 滚动恢复（home.js / ctx.scrollTop）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const HOME_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'home.js'), 'utf8');

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

section('1 路由：Tab 根横切不走 View Transition 整页快照');

test('1.1 renderRoute 的 VT 闸门排除 tab 导航', function () {
  check(/document\.startViewTransition && opts\.animate !== false && !reducedMotion\(\) && nav !== 'tab'/.test(INDEX_HTML),
    'renderRoute 应在 VT 条件里排除 nav === tab（低端机快照捕获+帧对齐是切页卡顿主因之一）');
});

test('1.2 降级淡入路径仍在（Tab 根靠它做短淡入）', function () {
  check(INDEX_HTML.indexOf('.app-screen--enter[data-nav="tab"]') >= 0, '缺少 tab 降级淡入规则');
  check(INDEX_HTML.indexOf('app-screen-enter-tab') >= 0, '缺少 tab 淡入关键帧');
});

test('1.3 路由目标滚动位传给屏幕（延后挂载恢复滚动用）', function () {
  check(INDEX_HTML.indexOf('screenCtx.scrollTop = Number(scrollTop) || 0') >= 0,
    'renderRoute 应把 scrollTop 写进屏幕 ctx');
});

section('2 转场专用时长令牌');

test('2.1 --dur-nav-push / --dur-nav-tab 定义且短于原通用时长', function () {
  const push = /--dur-nav-push:\s*(\d+)ms/.exec(INDEX_HTML);
  const tab = /--dur-nav-tab:\s*(\d+)ms/.exec(INDEX_HTML);
  check(push && Number(push[1]) <= 180, '--dur-nav-push 应 ≤180ms');
  check(tab && Number(tab[1]) <= 120, '--dur-nav-tab 应 ≤120ms');
});

test('2.2 reduced-motion 下两个令牌归零', function () {
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(INDEX_HTML);
  check(reduce, '找不到 reduced-motion 块');
  check(/--dur-nav-push:\s*0\.01ms/.test(reduce[0]), 'reduce 块未归零 --dur-nav-push');
  check(/--dur-nav-tab:\s*0\.01ms/.test(reduce[0]), 'reduce 块未归零 --dur-nav-tab');
});

test('2.3 屏幕入场与 VT 方向化规则改用专用令牌', function () {
  check(/\.app-screen--enter \{\s*animation: app-screen-enter var\(--dur-nav-push\)/.test(INDEX_HTML),
    '.app-screen--enter 应使用 --dur-nav-push');
  check(/html\[data-nav="forward"\]::view-transition-new\(app-view\) \{\s*animation: vt-in-right var\(--dur-nav-push\)/.test(INDEX_HTML),
    'forward 推入应使用 --dur-nav-push');
  check(INDEX_HTML.indexOf('animation-duration: var(--dur-nav-tab);') >= 0,
    'tab 淡入应使用 --dur-nav-tab');
});

section('3 首页：嵌入明细延后挂载');

test('3.1 mountLedger 调用在 setTimeout 内且有过期守卫', function () {
  const at = HOME_JS.indexOf('view.controller = mountLedger(ledgerHost, ctx, view);');
  check(at >= 0, '找不到嵌入明细挂载调用');
  const before = HOME_JS.slice(Math.max(0, at - 700), at);
  check(before.indexOf('global.setTimeout(function () {') >= 0, '挂载应延后到宏任务（换屏先落轻量内容）');
  check(before.indexOf('view.dead || view.destroyed') >= 0, '缺少 destroy/dead 过期守卫');
  check(before.indexOf('ledgerHost.isConnected === false') >= 0, '缺少宿主脱离文档守卫');
});

test('3.2 挂载后按路由目标滚动位恢复', function () {
  check(HOME_JS.indexOf('var targetScroll = Number(ctx && ctx.scrollTop) || 0;') >= 0,
    '应读取 ctx.scrollTop 作为恢复目标');
  const at = HOME_JS.indexOf('view.controller = mountLedger(ledgerHost, ctx, view);');
  const after = HOME_JS.slice(at, at + 500);
  check(after.indexOf('screenEl.scrollTop = targetScroll') >= 0, '挂载后应恢复目标滚动位');
});

test('3.3 同步阶段仍先渲染头部/预算/待入账（轻量内容不等明细）', function () {
  const renderAt = HOME_JS.indexOf('function render(root, ctx)');
  const mountAt = HOME_JS.indexOf('view.controller = mountLedger(ledgerHost, ctx, view);');
  const headAt = HOME_JS.indexOf('var head = buildHead(book, month, summary, view);');
  const budgetAt = HOME_JS.indexOf('var budgetCard = buildBudget(view);');
  check(renderAt >= 0 && headAt > renderAt && headAt < mountAt, '头部应先于明细挂载构建');
  check(budgetAt > renderAt && budgetAt < mountAt, '预算卡应先于明细挂载构建');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);