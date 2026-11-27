'use strict';
/*
 * tests/native-haptics.test.js
 * iOS 原生震动垫片（native/bridge.js · installVibrateShim / planVibration）单测。
 *
 * 运行：node tests/native-haptics.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：整文件进 vm 沙箱，注入假 Capacitor / Haptics 插件 / navigator / 假时钟，
 * 驱动真实实现。覆盖：非原生/缺插件/已有真 vibrate 时不安装、时长→力度映射、
 * 单击/多段节奏、vibrate(0) 与新调用取消旧节奏、插件抛错静默、状态口径。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'native', 'bridge.js'), 'utf8');

/* ============================== 极简测试骨架 ============================== */

let passCount = 0;
let failCount = 0;

function section(title) {
  console.log('\n===== ' + title + ' =====');
}

async function test(name, fn) {
  try {
    await fn();
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

/* ============================== 沙箱装配（假时钟） ============================== */

function makeSandbox(opts) {
  opts = opts || {};
  const impacts = [];
  /* 假时钟：queued[id-1] = {fn, at}；tick(ms) 推进虚拟时间并按到期顺序执行 */
  let clock = 0;
  const queued = [];
  const haptics = {
    impact: function (a) {
      impacts.push({ style: a && a.style, at: clock });
      if (opts.impactThrow) { throw new Error('plugin exploded'); }
      if (opts.impactReject) { return Promise.reject(new Error('rejected')); }
      return Promise.resolve();
    },
  };
  const plugins = {};
  if (!opts.noHaptics) { plugins.Haptics = haptics; }
  const sandbox = {
    console: console,
    Promise: Promise, JSON: JSON, Date: Date, Number: Number, String: String,
    Array: Array, Object: Object, Math: Math, isNaN: isNaN,
    setTimeout: function (fn, ms) { queued.push({ fn: fn, at: clock + (Number(ms) || 0) }); return queued.length; },
    clearTimeout: function (id) { queued[id - 1] = null; },
    setInterval: function () { return 0; },
    clearInterval: function () {},
    navigator: opts.navigator === undefined ? {} : opts.navigator,
    XZB: {},
  };
  if (!opts.notNative) {
    sandbox.Capacitor = { isNativePlatform: function () { return true; }, Plugins: plugins };
  }
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'native/bridge.js' });
  function tick(ms) {
    const target = clock + ms;
    for (;;) {
      let next = null;
      for (let i = 0; i < queued.length; i += 1) {
        const t = queued[i];
        if (t && t.at <= target && (!next || t.at < next.item.at)) { next = { idx: i, item: t }; }
      }
      if (!next) { break; }
      queued[next.idx] = null;
      clock = next.item.at;
      next.item.fn();
    }
    clock = target;
  }
  return { sandbox: sandbox, impacts: impacts, tick: tick, NB: sandbox.XZB.NativeBridge };
}

/* ============================== 用例 ============================== */

async function main() {
  section('用例 1：安装守卫（缺环即保持原样）');
  await test('1.1 非原生环境 → 不安装，navigator.vibrate 保持缺失', function () {
    const h = makeSandbox({ notNative: true });
    checkEq(h.NB.status().vibrateShim, false, '状态口径');
    checkEq(typeof h.sandbox.navigator.vibrate, 'undefined', '不注入');
  });
  await test('1.2 原生但无 Haptics 插件（旧壳）→ 不安装', function () {
    const h = makeSandbox({ noHaptics: true });
    checkEq(h.NB.status().vibrateShim, false, '状态口径');
    checkEq(typeof h.sandbox.navigator.vibrate, 'undefined', '不注入');
  });
  await test('1.3 已有真 navigator.vibrate → 绝不覆盖', function () {
    const real = function () { return true; };
    const h = makeSandbox({ navigator: { vibrate: real } });
    checkEq(h.sandbox.navigator.vibrate, real, '原实现保留');
    checkEq(h.NB.status().vibrateShim, false, '状态口径');
  });
  await test('1.4 原生 + 插件在位 → 安装成功，vibrate 可调用', function () {
    const h = makeSandbox({});
    checkEq(h.NB.status().vibrateShim, true, '状态口径');
    checkEq(typeof h.sandbox.navigator.vibrate, 'function', '已注入');
  });

  section('用例 2：planVibration 纯函数（时长 → 力度/节奏）');
  const pure = makeSandbox({ notNative: true }).NB;
  await test('2.1 力度映射：≤8 LIGHT，≤15 MEDIUM，>15 HEAVY', function () {
    checkEq(pure.planVibration(6)[0].style, 'LIGHT', 'key 6ms');
    checkEq(pure.planVibration(8)[0].style, 'LIGHT', 'tap 8ms');
    checkEq(pure.planVibration(12)[0].style, 'MEDIUM', 'select 12ms');
    checkEq(pure.planVibration(18)[0].style, 'HEAVY', 'warn 18ms');
    checkEq(pure.planVibration(26)[0].style, 'HEAVY', 'error 26ms');
  });
  await test('2.2 success 双段 [10,40,14] → 0ms 与 50ms 两击', function () {
    const steps = pure.planVibration([10, 40, 14]);
    checkEq(steps.length, 2, '两击');
    checkEq(steps[0].at, 0, '首击立即');
    checkEq(steps[1].at, 50, '次击 10+40');
    checkEq(steps[1].style, 'MEDIUM', '14ms → MEDIUM');
  });
  await test('2.3 error 三段 [26,60,26] → 0ms 与 86ms 两记重击', function () {
    const steps = pure.planVibration([26, 60, 26]);
    checkEq(steps.length, 2, '数组按震/停成对');
    checkEq(steps[1].at, 86, '26+60');
    checkEq(steps[0].style, 'HEAVY', '重击');
  });
  await test('2.4 0 / 空 / 非法输入 → 空计划（等价取消）', function () {
    checkEq(pure.planVibration(0).length, 0, 'vibrate(0)');
    checkEq(pure.planVibration([]).length, 0, '空数组');
    checkEq(pure.planVibration('abc').length, 0, '非法串');
    checkEq(pure.planVibration(undefined).length, 0, 'undefined');
    checkEq(pure.planVibration(-5).length, 0, '负数');
  });
  await test('2.5 超长数组步数封顶 8，防定时器风暴', function () {
    const long = [];
    for (let i = 0; i < 100; i += 1) { long.push(10, 10); }
    checkEq(pure.planVibration(long).length, 8, '封顶');
  });

  section('用例 3：垫片行为（假 Haptics + 假时钟）');
  await test('3.1 vibrate(8) → 立即一记 LIGHT，返回 true', function () {
    const h = makeSandbox({});
    checkEq(h.sandbox.navigator.vibrate(8), true, '返回值');
    checkEq(h.impacts.length, 1, '恰一击');
    checkEq(h.impacts[0].style, 'LIGHT', '力度');
    checkEq(h.impacts[0].at, 0, '立即');
  });
  await test('3.2 vibrate([10,40,14]) → 首击立即、次击 50ms 后', function () {
    const h = makeSandbox({});
    h.sandbox.navigator.vibrate([10, 40, 14]);
    checkEq(h.impacts.length, 1, '先一击');
    h.tick(49);
    checkEq(h.impacts.length, 1, '49ms 未到点');
    h.tick(1);
    checkEq(h.impacts.length, 2, '50ms 次击');
    checkEq(h.impacts[1].at, 50, '节奏偏移');
  });
  await test('3.3 vibrate(0) 取消未完成的旧节奏', function () {
    const h = makeSandbox({});
    h.sandbox.navigator.vibrate([10, 40, 14]);
    h.sandbox.navigator.vibrate(0);
    h.tick(200);
    checkEq(h.impacts.length, 1, '只剩首击，次击被取消');
  });
  await test('3.4 新调用替换旧节奏（原生 vibrate 语义）', function () {
    const h = makeSandbox({});
    h.sandbox.navigator.vibrate([26, 60, 26]);
    h.sandbox.navigator.vibrate(8);
    h.tick(200);
    checkEq(h.impacts.length, 2, '旧次击取消 + 新单击');
    checkEq(h.impacts[1].style, 'LIGHT', '新调用生效');
  });
  await test('3.5 插件同步抛错 → 垫片不抛、仍返回 true', function () {
    const h = makeSandbox({ impactThrow: true });
    checkEq(h.sandbox.navigator.vibrate(8), true, '静默');
  });
  await test('3.6 插件 Promise 拒绝 → 无未处理 rejection（吞掉）', async function () {
    const h = makeSandbox({ impactReject: true });
    h.sandbox.navigator.vibrate(8);
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); }
    check(true, '未抛未崩');
  });

  section('用例 4：与既有桥接职责互不干扰');
  await test('4.1 安装垫片后 init 幂等，status 同时报告镜像与震动口径', function () {
    const h = makeSandbox({});
    checkEq(h.NB.init(), false, '重复 init 拒绝');
    const st = h.NB.status();
    checkEq(st.native, true, '原生');
    checkEq(st.vibrateShim, true, '震动垫片在位');
    checkEq(st.mirrorFile, '小账本-自动备份.json', '镜像职责保留');
  });

  /* ============================== 汇总 ============================== */
  console.log('\n===== 汇总 =====');
  console.log('通过 ' + passCount + ' / 失败 ' + failCount);
  if (failCount > 0) { process.exit(1); }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});