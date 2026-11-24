'use strict';
/*
 * tests/ai-default-service.test.js
 * 自检脚本：内置默认服务零配置播种 + 思考型模型适配（2.41.0）。
 *
 * 背景：所有者要求把千问 MaaS 端点 + 密钥 + qwen4-max 直接做进公开仓库，手机首次
 * 打开即用（零配置）。两条硬约束：
 *   1) 该端点当前只有 qwen4-max / deepseek-v4.1-flash 有免费余量，且都「默认会思考」——
 *      测试探针只给 16 token，不关思考会被 reasoning 吃光返回空 content（finish_reason=length），
 *      旧版据此误报「返回内容看不懂」；记账解析同理静默回落本地。故测试探针/记账解析/
 *      通用对话一律带 enable_thinking:false（端点不认时 stripOptionalBody 在 400 后剥掉重试）。
 *   2) 播种必须幂等：本机已有 xzb.ai.v1（用户自定义/关闭/撤回告知）绝不覆盖；且不在模块
 *      顶层自动执行，保住既有「空配置=安全默认」单测语义。
 *
 * 运行：node tests/ai-default-service.test.js
 * 加载方式与 ai-preset.test.js 一致：node vm 沙箱执行 core-assistant.js，注入 localStorage
 * stub 与 fetch 桩，不依赖真实网络。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ============================== 极简测试骨架（支持异步） ============================== */

let passCount = 0;
let failCount = 0;
let currentSection = '';

function section(title) { currentSection = title; }

const CASES = [];
function regCase(name, fn) { CASES.push([currentSection, name, fn]); }

function check(cond, label) { if (!cond) { throw new Error(label); } }
function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ============================== 沙箱与桩 ============================== */

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
const CORE_JS = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AI_KEY_VALUE = 'xzb.ai.v1';

function chatEnvelope(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content: content }, finish_reason: 'stop' }] });
}

async function withNet(stub, fn) {
  const prevFetch = sandbox.fetch;
  const prevNav = sandbox.navigator;
  sandbox.fetch = stub;
  sandbox.navigator = { onLine: true };
  try { return await fn(); }
  finally {
    sandbox.fetch = prevFetch;
    if (prevNav === undefined) { delete sandbox.navigator; } else { sandbox.navigator = prevNav; }
  }
}

/* ============================== 用例 1：零配置播种 ============================== */

section('用例 1：首次运行播种内置默认服务（零配置即用）');

regCase('1.1 空配置播种后 ready=true，地址/模型/密钥/开关/告知齐全', function () {
  ls.removeItem(AI_KEY_VALUE);
  const r = llm.seedDefaultService();
  checkEq(r && r.ok, true, 'seed ok');
  checkEq(r && r.seeded, true, '首次应播种');
  const cfg = llm.getConfig().cfg;
  checkEq(cfg.enabled, true, '默认开启');
  checkEq(cfg.hasKey, true, '内置密钥');
  checkEq(cfg.baseURL, 'https://maas.qianwenaiapi.com/compatible-mode/v1', 'baseURL');
  checkEq(cfg.model, 'qwen4-max', 'model');
  check(Number(cfg.noticeAt) > 0, '默认同意隐私告知');
  checkEq(llm.ready(), true, 'ready 应为 true（手机打开即用）');
});

regCase('1.2 幂等：已有自定义配置不被覆盖', function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.setConfig({ baseURL: 'https://api.example.com/v1', model: 'gpt-4o-mini', key: 'sk-mine-123' });
  llm.setConfig({ enabled: true });
  llm.setConfig({ noticeAt: Date.now() });
  const r = llm.seedDefaultService();
  checkEq(r && r.seeded, false, '已有配置不得再播种');
  const cfg = llm.getConfig().cfg;
  checkEq(cfg.baseURL, 'https://api.example.com/v1', '自定义地址保留');
  checkEq(cfg.model, 'gpt-4o-mini', '自定义模型保留');
});

regCase('1.3 幂等：用户关闭/撤回告知的状态不被播种翻回', function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  llm.setConfig({ enabled: false });
  llm.setConfig({ noticeAt: 0 });
  const r = llm.seedDefaultService();
  checkEq(r && r.seeded, false, '已有键不得再播种');
  const cfg = llm.getConfig().cfg;
  checkEq(cfg.enabled, false, '关闭状态保留');
  checkEq(Number(cfg.noticeAt) > 0, false, '撤回告知保留');
  checkEq(llm.ready(), false, '不应被翻回 ready');
});

regCase('1.4 播种落盘形状：v/enabled/baseURL/model/key/redact/noticeAt 七字段', function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  const raw = JSON.parse(ls.getItem(AI_KEY_VALUE));
  checkEq(raw.v, 1, 'v');
  checkEq(raw.enabled, true, 'enabled');
  checkEq(raw.redact, 'names', 'redact');
  check(Number(raw.noticeAt) > 0, 'noticeAt');
  checkEq(typeof raw.key, 'string', 'key');
});

/* ============================== 用例 2：思考型模型适配 ============================== */

section('用例 2：测试探针/记账解析/通用对话都关思考（enable_thinking:false）');

regCase('2.1 测试探针请求体带 enable_thinking:false，200+非空内容判连通', async function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  let body = null;
  const res = await withNet(function (url, options) {
    body = JSON.parse(options.body);
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('{"ok":true}')); } });
  }, function () { return llm.test(); });
  checkEq(res && res.ok, true, '应判连通');
  checkEq(body.enable_thinking, false, '探针必须关思考（否则 16 token 被 reasoning 吃光）');
  checkEq(body.max_tokens, 16, '探针预算不变');
});

regCase('2.2 记账解析请求体带 enable_thinking:false', async function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  let body = null;
  const res = await withNet(function (url, options) {
    body = JSON.parse(options.body);
    return Promise.resolve({ status: 200, text: function () {
      return Promise.resolve(chatEnvelope(JSON.stringify({ intent: 'need_clarify', clarify: { question: '金额？', options: [] } })));
    } });
  }, function () {
    return llm.plan({ raw: '记一笔午饭', today: '2026-11-24', bookId: 'bk_main', accounts: [], categories: [] });
  });
  checkEq(res && res.ok, true, 'plan 应成功');
  checkEq(body.enable_thinking, false, '记账解析必须关思考');
});

regCase('2.3 通用对话请求体带 enable_thinking:false', async function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  let body = null;
  const res = await withNet(function (url, options) {
    body = JSON.parse(options.body);
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('{"ok":true}')); } });
  }, function () { return llm.chat([{ role: 'user', content: 'hi' }], {}); });
  checkEq(res && res.ok, true, 'chat 应成功');
  checkEq(body.enable_thinking, false, '通用对话必须关思考');
});

regCase('2.4 端点不认 enable_thinking：400 后剥掉重发一次成功', async function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  const bodies = [];
  const res = await withNet(function (url, options) {
    bodies.push(String(options.body));
    if (bodies.length === 1) { return Promise.resolve({ status: 400 }); }
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('{"ok":true}')); } });
  }, function () { return llm.chat([{ role: 'user', content: 'hi' }], { timeoutMs: 500 }); });
  checkEq(res && res.ok, true, '剥字段重试后应成功');
  checkEq(bodies.length, 2, '恰好重发一次');
  check(bodies[0].indexOf('enable_thinking') >= 0, '首次带 enable_thinking');
  check(bodies[1].indexOf('enable_thinking') < 0, '重发必须剥掉 enable_thinking');
});

regCase('2.5 内置密钥只走 Authorization 头，不进请求体/配置视图', async function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.seedDefaultService();
  const raw = JSON.parse(ls.getItem(AI_KEY_VALUE));
  let seen = null;
  await withNet(function (url, options) {
    seen = options;
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('{"ok":true}')); } });
  }, function () { return llm.test(); });
  checkEq(seen.headers.Authorization, 'Bearer ' + raw.key, '密钥照发 Bearer');
  check(seen.body.indexOf(raw.key) < 0, '请求体不得含明文密钥');
  check(JSON.stringify(llm.getConfig()).indexOf(raw.key) < 0, '配置视图不得含明文密钥');
});

/* ============================== 用例 3：源码与启动接线 ============================== */

section('用例 3：源码锚点与启动链播种接线');

regCase('3.1 核心导出 seedDefaultService，内置默认服务常量在位', function () {
  checkEq(typeof llm.seedDefaultService, 'function', 'seedDefaultService 应导出');
  check(CORE_JS.indexOf('var AI_DEFAULT_SERVICE = {') >= 0, '应有内置默认服务常量');
  check(CORE_JS.indexOf('seedDefaultService: seedDefaultService') >= 0, 'llm 命名空间应导出');
  check(CORE_JS.indexOf('maas.qianwenaiapi.com/compatible-mode/v1') >= 0, '端点应公开内置');
});

regCase('3.2 三条出站口都带 enable_thinking:false', function () {
  const hits = CORE_JS.match(/enable_thinking: false/g) || [];
  check(hits.length >= 3, 'buildBody/llmTest/llmChat 应各带一处，实际 ' + hits.length);
});

regCase('3.3 启动链确保 core-assistant 后调用播种（手机首次打开即用）', function () {
  check(INDEX_HTML.indexOf('function seedDefaultAiService()') >= 0, '应有启动播种辅助函数');
  check(INDEX_HTML.indexOf("XZB.chunks.ensure('core-assistant')") >= 0, '启动应确保 core-assistant 加载');
  check(INDEX_HTML.indexOf('a.llm.seedDefaultService()') >= 0, '加载后应调用播种');
  check(INDEX_HTML.indexOf('seedDefaultAiService();') >= 0, 'continueBoot 应调用播种');
});

/* ============================== 汇总 ============================== */

async function main() {
  for (const [sec, name, fn] of CASES) {
    if (currentSection !== sec) {
      currentSection = sec;
      console.log('\n' + sec);
    }
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
  console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
  if (failCount > 0) { process.exitCode = 1; }
}

main();