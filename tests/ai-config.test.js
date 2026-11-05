'use strict';
/*
 * tests/ai-config.test.js
 * 自检脚本：在线模型（AI 增强）配置链路修复（2.26.9，同一分支内的独立修复提交）。
 *
 * 用户主诉：设置页把密钥/接口地址/模型名都填了，却提示「地址、模型、密钥要填齐」。
 * 根因（本脚本逐条固化）：
 *   1) core-assistant 的出站前置门 llmNotReadyCode/llmTest 要求 noticeAt>0（隐私告知
 *      时间戳，A28：未告知不发请求），而 noticeAt 只能在小助手聊天页 / AI 解读页的
 *      弹卡里写入，设置页没有任何入口——填齐三项后「测试连接」必然被拦。
 *   2) 该失败返回 E_AS_NOT_CONFIGURED，设置页把它映射成「地址、模型、密钥要填齐」，
 *      与真实缺口（未同意隐私告知）无关，误导用户。
 *   3) 设置主页 llmRowValue 读取 getConfig 从未返回过的 cfg.status 字段，
 *      四态右值永远到不了「已开启」。
 *
 * 修复（js/screens/settings.js，不碰 core-assistant 的门与既有弹卡）：
 *   - AI 子页新增「同意隐私告知」开关（写/清 noticeAt，与 assistant.js acceptNotice
 *     及 insights.js 的口径一致）；
 *   - 「测试连接」在 noticeAt=0 时提前说明真实缺口，不再误报「要填齐」；
 *   - llmRowValue 改用 getConfig 实际提供的 ready 字段判定四态。
 *
 * 运行：node tests/ai-config.test.js
 *
 * 加载方式：core-assistant.js 头部无加载时依赖（全懒取），node vm 沙箱直接执行，
 * 注入 localStorage stub（真实读写路径）与 fetch/AbortController stub（出站层）。
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ============================== 极简测试骨架（支持异步） ============================== */

let passCount = 0;
let failCount = 0;

let currentSection = '';

function section(title) {
  currentSection = title;
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

/* 用例先登记（带所属分组）、main 里顺序 await 执行：避免异步用例与汇总输出乱序 */
const CASES = [];
function regCase(name, fn) { CASES.push([currentSection, name, fn]); }

function check(cond, label) {
  if (!cond) { throw new Error(label); }
}

function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ============================== 沙箱与桩 ============================== */

/* 内存 localStorage：aiRead/aiWrite 的真实读写路径 */
function makeLS() {
  const m = Object.create(null);
  return {
    _m: m,
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; }
  };
}

const ls = makeLS();

const sandbox = {
  console,
  /* 出站层桩：拒绝连接——test() 走到网络层时返回 NET_* 系错误码（而非 NOT_CONFIGURED），
     用「错误码家族变化」证明 noticeAt 门已通过；不依赖真实网络。 */
  fetch() { return Promise.reject(new Error('sandbox: no network')); },
  AbortController,
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Promise,
  Math,
  Number,
  String,
  Object,
  Array,
  isFinite,
  localStorage: ls
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8'),
  sandbox,
  { filename: 'js/modules/core-assistant.js' }
);

const llm = sandbox.XZB.Core.assistant.llm;
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/settings.js'), 'utf8');
const AI_KEY_VALUE = 'xzb.ai.v1';

/* 预置「用户已填齐三项并打开开关」的状态（设置页 apply() + toggle 的真实 patch 口径） */
function seedCompleteConfig() {
  ls.removeItem(AI_KEY_VALUE);
  const r1 = llm.setConfig({ baseURL: 'https://api.example.com/v1', model: 'gpt-4o-mini', key: 'sk-test-1234567890' });
  const r2 = llm.setConfig({ enabled: true });
  if (!(r1 && r1.ok === true) || !(r2 && r2.ok === true)) {
    throw new Error('预置配置写入失败');
  }
}

/* ============================== 用例 1：主诉复现（修复前行为固化） ============================== */

section('用例 1：主诉复现——三项填齐仍被拦（noticeAt=0 门）');

regCase('1.1 三项填齐 + 开关打开：hasKey/baseURL/model 全真，但 noticeAt=0', function () {
  seedCompleteConfig();
  const cfg = llm.getConfig().cfg;
  checkEq(cfg.hasKey, true, 'hasKey');
  checkEq(!!cfg.baseURL, true, 'baseURL');
  checkEq(!!cfg.model, true, 'model');
  checkEq(Number(cfg.noticeAt) > 0, false, 'noticeAt 应仍为 0（设置页旧版无入口）');
});

regCase('1.2 ready()=false：设置主页四态判定落「未就绪」', function () {
  checkEq(llm.ready(), false, 'ready()');
});

regCase('1.3 test() 返回 E_AS_NOT_CONFIGURED——UI 映射成「地址、模型、密钥要填齐」（误导源头）', async function () {
  const res = await llm.test();
  checkEq(res && res.code, 'E_AS_NOT_CONFIGURED', 'test().code');
  checkEq(res && res.ok, false, 'test().ok');
});

/* ============================== 用例 2：修复验证——设置页告知开关语义 ============================== */

section('用例 2：noticeAt 写入/撤回（新增开关的后端语义）');

regCase('2.1 setConfig({noticeAt}) 同意后 ready()=true，test() 不再返回 NOT_CONFIGURED', async function () {
  seedCompleteConfig();
  const ack = llm.setConfig({ noticeAt: Date.now() });
  checkEq(ack && ack.ok, true, 'setConfig noticeAt');
  checkEq(llm.ready(), true, 'ready()');
  const res = await llm.test();
  check(res && res.code !== 'E_AS_NOT_CONFIGURED', 'test() 不应再报 NOT_CONFIGURED，实际 ' + JSON.stringify(res));
  checkEq(res && res.ok, false, '沙箱无网络，ok 应为 false（NET_* 系）');
});

regCase('2.2 setConfig({noticeAt:0}) 撤回后 ready()=false，test() 重新被拦', async function () {
  llm.setConfig({ noticeAt: 0 });
  checkEq(llm.ready(), false, 'ready()');
  const res = await llm.test();
  checkEq(res && res.code, 'E_AS_NOT_CONFIGURED', 'test().code');
});

regCase('2.3 noticeAt 只认正数：负数/NaN/字符串数字之外的值回落 0', function () {
  llm.setConfig({ noticeAt: -5 });
  checkEq(Number(llm.getConfig().cfg.noticeAt) > 0, false, '负数');
  llm.setConfig({ noticeAt: 'abc' });
  checkEq(Number(llm.getConfig().cfg.noticeAt) > 0, false, '非数字');
  const at = Date.now();
  llm.setConfig({ noticeAt: String(at) });
  checkEq(Number(llm.getConfig().cfg.noticeAt) > 0, true, '数字字符串应被 Number() 接受');
});

/* ============================== 用例 3：配置边界（与主诉相邻的坑） ============================== */

section('用例 3：配置读写边界（掩码不覆盖、URL 规整、持久形状）');

regCase('3.1 掩码回传不覆盖真密钥（T06）：•••• 开头的输入视为「不改」', function () {
  seedCompleteConfig();
  const r = llm.setConfig({ key: '••••7890' });
  checkEq(r && r.ok, true, 'setConfig');
  const raw = JSON.parse(ls.getItem(AI_KEY_VALUE));
  checkEq(raw.key, 'sk-test-1234567890', '密钥原文不应被掩码覆盖');
});

regCase('3.2 URL 规整：尾斜杠剥离；非法 scheme / 过短地址拒绝且不落盘', function () {
  seedCompleteConfig();
  const okUrl = llm.setConfig({ baseURL: 'https://api.example.com/v1/' });
  checkEq(okUrl && okUrl.ok, true, '合法 URL 应通过');
  const saved = llm.getConfig().cfg.baseURL;
  checkEq(saved.charAt(saved.length - 1) !== '/', true, '尾斜杠应被剥离：' + saved);
  const bad1 = llm.setConfig({ baseURL: 'ftp://api.example.com/v1' });
  checkEq(bad1 && bad1.ok, false, '非 http(s) 应拒绝');
  const bad2 = llm.setConfig({ baseURL: 'https:///x' });
  checkEq(bad2 && bad2.ok, false, '三斜杠应拒绝');
  const bad3 = llm.setConfig({ baseURL: 'https://a' });
  checkEq(bad3 && bad3.ok, false, '过短地址应拒绝');
});

regCase('3.3 localStorage 持久形状：v/enabled/baseURL/model/key/redact/noticeAt 七字段', function () {
  seedCompleteConfig();
  llm.setConfig({ noticeAt: Date.now() });
  const raw = JSON.parse(ls.getItem(AI_KEY_VALUE));
  checkEq(raw.v, 1, 'v');
  checkEq(raw.enabled, true, 'enabled');
  checkEq(typeof raw.baseURL, 'string', 'baseURL');
  checkEq(typeof raw.model, 'string', 'model');
  checkEq(typeof raw.key, 'string', 'key');
  check(['names', 'none'].indexOf(raw.redact) >= 0, 'redact 枚举: ' + raw.redact);
  check(Number(raw.noticeAt) > 0, 'noticeAt>0');
});

regCase('3.4 空配置读回：缺键/损坏 JSON 一律回落安全默认值且不抛', function () {
  ls.removeItem(AI_KEY_VALUE);
  const cfg = llm.getConfig().cfg;
  checkEq(cfg.hasKey, false, 'hasKey');
  checkEq(cfg.enabled, false, 'enabled');
  ls.setItem(AI_KEY_VALUE, '{broken json');
  const cfg2 = llm.getConfig().cfg;
  checkEq(cfg2.hasKey, false, '损坏 JSON 回落默认');
  checkEq(Number(cfg2.noticeAt) > 0, false, 'noticeAt 回落 0');
});

/* ============================== 用例 4：设置页修复的源码级断言 ============================== */

section('用例 4：settings.js 修复点（源码级）');

regCase('4.1 llmRowValue 用 cfg.ready 判定四态，不再读不存在的 cfg.status', function () {
  check(SETTINGS_JS.indexOf("cfg.status !== 'ok'") < 0, '不应再引用 cfg.status');
  check(SETTINGS_JS.indexOf('cfg.ready !== true') >= 0, '应改用 cfg.ready');
});

regCase('4.2 AI 子页含「同意隐私告知」开关且写入/撤回 noticeAt', function () {
  check(SETTINGS_JS.indexOf('同意隐私告知') >= 0, '应有告知开关行');
  check(/setConfig\(\{ noticeAt: next \? Date\.now\(\) : 0 \}\)/.test(SETTINGS_JS), 'onChange 应写 noticeAt');
  check(SETTINGS_JS.indexOf("icon: 'shield', title: '同意隐私告知'") >= 0, '开关应使用 shield 图标');
});

regCase('4.3 测试连接预检 noticeAt=0：提示真实缺口而非「要填齐」', function () {
  check(SETTINGS_JS.indexOf('先在上方同意隐私告知，再测试连接') >= 0, '应有预检提示');
  const gate = SETTINGS_JS.indexOf('Number((llmCfg() || {}).noticeAt) <= 0');
  const testBtn = SETTINGS_JS.indexOf("text: '测试连接' }");
  check(gate > testBtn, '预检应在测试按钮定义之后（同一 handler 内）');
});

/* ============================== 汇总 ============================== */

(async function main() {
  let lastSection = '';
  for (let i = 0; i < CASES.length; i += 1) {
    if (CASES[i][0] !== lastSection) {
      lastSection = CASES[i][0];
      console.log('\n===== ' + lastSection + ' =====');
    }
    await test(CASES[i][1], CASES[i][2]);
  }
  console.log('\n=========================================');
  console.log('通过 ' + passCount + ' / 失败 ' + failCount);
  console.log(failCount === 0 ? '总结论：全绿 PASS' : '总结论：存在 FAIL，见上方 [FAIL] 明细');
  console.log('=========================================');
  process.exitCode = failCount === 0 ? 0 : 1;
})();
