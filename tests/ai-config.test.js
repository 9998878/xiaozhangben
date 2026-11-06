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
 * 迭代3（2.26.9）：「已配置但未告知」分码 E_AS_NOT_ACKED（只增不改），
 * reasonOf → privacy → assistant 文案「已配置在线模型：先同意隐私告知再联网」，
 * 不再说「未启用在线模型」；ai-insights/settings 映射同步。用例 6 固化。
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
const CORE_JS = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/settings.js'), 'utf8');
const ASSISTANT_JS = fs.readFileSync(path.join(ROOT, 'js/screens/assistant.js'), 'utf8');
const AI_INSIGHTS_JS = fs.readFileSync(path.join(ROOT, 'js/modules/ai-insights.js'), 'utf8');
const ACCOUNTS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/accounts.js'), 'utf8');
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

/* 迭代3 起「已配置但未告知」分码 E_AS_NOT_ACKED，不再与「没配置」混用误导。 */
regCase('1.3 test() 在已配置+未告知时返回 E_AS_NOT_ACKED（分码后如实点名缺口）', async function () {
  const res = await llm.test();
  checkEq(res && res.code, 'E_AS_NOT_ACKED', 'test().code');
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
  checkEq(res && res.code, 'E_AS_NOT_ACKED', 'test().code');
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

/* ============================== 用例 5：接口地址占位符与失败提示对齐协议要求 ============================== */

section('用例 5：占位符与保存失败提示（2.26.9 迭代 1）');

regCase('5.1 占位符示范带协议，与 aiNormalizeURL 的 http(s):// 要求一致', function () {
  check(SETTINGS_JS.indexOf("'接口地址', 'https://api.example.com/v1'") >= 0, '占位符应以 https:// 开头');
  check(SETTINGS_JS.indexOf("'接口地址', 'api.example.com/v1'") < 0, '不应再保留无协议示范');
});

regCase('5.2 保存失败时，缺协议输入点明原因，其余保持原提示', function () {
  check(SETTINGS_JS.indexOf("addr.indexOf('://') === -1") >= 0, '应存在缺协议判定分支');
  check(SETTINGS_JS.indexOf('接口地址需以 http:// 或 https:// 开头') >= 0, '应有协议提示文案');
  check(SETTINGS_JS.indexOf('没保存：检查接口地址与模型名') >= 0, '其余失败应保持原提示');
});

/* ============================== 用例 6：迭代3 分码（E_AS_NOT_ACKED） ============================== */

section('用例 6：E_AS_NOT_ACKED 分码与消费方映射（2.26.9 迭代3）');

regCase('6.1 分码矩阵：未配置/已配置未告知/关开关 各归各码，chat 门同语义', async function () {
  ls.removeItem(AI_KEY_VALUE);
  let res = await llm.test();
  checkEq(res && res.code, 'E_AS_NOT_CONFIGURED', '未配置 → NOT_CONFIGURED');
  seedCompleteConfig();
  res = await llm.test();
  checkEq(res && res.code, 'E_AS_NOT_ACKED', '已配置+未告知 → NOT_ACKED');
  const chatGate = await llm.chat([{ role: 'user', content: 'hi' }]);
  checkEq(chatGate && chatGate.code, 'E_AS_NOT_ACKED', 'chat 门同码且不出网');
  llm.setConfig({ noticeAt: Date.now() });
  llm.setConfig({ enabled: false });
  const chatGate2 = await llm.chat([{ role: 'user', content: 'hi' }]);
  checkEq(chatGate2 && chatGate2.code, 'E_AS_AI_DISABLED', '配置齐+已告知+关开关 → AI_DISABLED');
});

regCase('6.2 消费方映射源码断言：reasonOf/assistant 渲染/ai-insights/settings', function () {
  check(CORE_JS.indexOf("if (code === E.NOT_ACKED) { return 'privacy'; }") >= 0, 'reasonOf 应把 NOT_ACKED 映射 privacy');
  check(CORE_JS.indexOf("gateReason = cfg.enabled !== true ? 'disabled'") >= 0, 'respondRemote 回落原因应三分');
  check(ASSISTANT_JS.indexOf("privacy: '已配置在线模型：先同意隐私告知再联网'") >= 0, 'REASON_TEXT 应有 privacy 文案');
  check(ASSISTANT_JS.indexOf("turn.reason === 'privacy'") >= 0, '渲染条件应包含 privacy');
  check(AI_INSIGHTS_JS.indexOf("code === 'E_AS_NOT_ACKED'") >= 0, 'ai-insights 映射应含 NOT_ACKED');
  check(SETTINGS_JS.indexOf("E_AS_NOT_ACKED: '已配置：先同意隐私告知，再测试连接'") >= 0, 'settings AI_ERR_TEXT 应含 NOT_ACKED');
  check(CORE_JS.indexOf("NOT_CONFIGURED: 'E_AS_NOT_CONFIGURED'") >= 0 && CORE_JS.indexOf("E_AS_NOT_CONFIGURED: '还没配置联网模型，当前是本地模式'") >= 0, '既有码与文案应原样保留（只增不改）');
});

regCase('6.3 privacy 回落附「去设置」chip（迭代4）', function () {
  check(ASSISTANT_JS.indexOf("if (turn.reason === 'privacy') {") >= 0, '渲染应有 privacy 分支');
  check(/privacyJump[\s\S]{0,300}gotoSettings\('/.test(ASSISTANT_JS), 'privacy 分支应调用 gotoSettings');
  check(ASSISTANT_JS.indexOf("'aria-label': '去设置：同意隐私告知'") >= 0, 'chip 应有无障碍标签');
  check(ASSISTANT_JS.indexOf("'去设置'"), 'chip 文案应为「去设置」');
});

regCase('6.4 密钥超长/类型错归因 field:key，settings 提示细分（迭代5）', function () {
  seedCompleteConfig();
  let res = llm.setConfig({ key: new Array(302).join('x') });
  checkEq(res && res.code, 'E_AS_NET_CONFIG', '超长 code');
  checkEq(res && res.field, 'key', '超长 field 应为 key');
  res = llm.setConfig({ key: 123 });
  checkEq(res && res.field, 'key', '类型错 field 应为 key');
  check(CORE_JS.indexOf('if (!aiWrite(cfg)) { return { ok: false, code: E.NET_CONFIG }; }') >= 0,
    '写盘失败不应误标 field');
  check(SETTINGS_JS.indexOf('密钥太长（上限 300 字符）') >= 0, 'settings 应有密钥超长提示');
  check(CORE_JS.indexOf('AI_MAX_KEY = 300') >= 0 && SETTINGS_JS.indexOf('> 300') >= 0,
    '300 常量应与 AI_MAX_KEY 同值（同步锚点）');
});

regCase('6.5 privacy chip 深链 #/settings/ai（迭代6）', function () {
  check(ASSISTANT_JS.indexOf('function gotoSettings(target)') >= 0, 'gotoSettings 应支持目标参数');
  check(ASSISTANT_JS.indexOf("gotoSettings('#/settings/ai')") >= 0, 'privacy chip 应深链 AI 子页');
  check(SETTINGS_JS.indexOf("'#/settings/ai'") >= 0, 'settings 子页路由应存在');
  check(ASSISTANT_JS.indexOf("gotoSettings('#/settings');") < 0, '不应有调用点仍传一级页字面量');
});

regCase('6.6 账户页净资产含归档账户（迭代9，CONTRACT §6.2 口径）', function () {
  check(ACCOUNTS_JS.indexOf('function heroCard(db, alive, archived, balances)') >= 0,
    'heroCard 应接收 archived 列表');
  check(ACCOUNTS_JS.indexOf('var all = alive.concat(archived);') >= 0,
    '求和应覆盖 alive+archived');
  check(ACCOUNTS_JS.indexOf("all.length + ' 个账户'") >= 0, '徽标账户数应含归档');
  check(ACCOUNTS_JS.indexOf('heroCard(db, alive, archived, balances)') >= 0,
    'renderList 调用点应同步传 archived');
  check(ACCOUNTS_JS.indexOf('root.appendChild(heroCard(db, alive, balances))') < 0,
    '不应残留旧签名调用');
});

/* ============================== 用例 7：解析超时预算（2.26.11） ============================== */

section('用例 7：记账解析超时预算——6s 门误杀云端慢响应（2.26.11）');

regCase('7.1 常量分层：测试连接仍 6s，记账解析 20s', function () {
  const AS = sandbox.XZB.Core.assistant;
  checkEq(AS.LLM_TIMEOUT_MS, 6000, 'LLM_TIMEOUT_MS（测试连接等短探测）');
  check(Number(AS.LLM_PLAN_TIMEOUT_MS) >= 15000,
    'LLM_PLAN_TIMEOUT_MS 应 >= 15000，实际 ' + AS.LLM_PLAN_TIMEOUT_MS);
});

regCase('7.2 源码：llmPlan 把 LLM_PLAN_TIMEOUT_MS 显式传给 httpOnce（防回退到默认 6s）', function () {
  check(CORE_JS.indexOf('httpOnce(cfg, fit.body, LLM_PLAN_TIMEOUT_MS)') >= 0,
    'llmPlan 未显式传解析超时，仍会吃默认 6s');
});

regCase('7.3 行为：响应在 6.2s 才回来（超过旧 6s 门）时 llmPlan 仍成功', async function () {
  seedCompleteConfig();
  llm.setConfig({ noticeAt: Date.now() });
  const originalFetch = sandbox.fetch;
  const payload = {
    choices: [{
      finish_reason: 'stop',
      message: { content: '{"intent":"need_clarify","clarify":{"question":"记多少？","options":[]}}' }
    }]
  };
  sandbox.fetch = function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ status: 200, text: function () { return Promise.resolve(JSON.stringify(payload)); } });
      }, 6200);
    });
  };
  try {
    const res = await llm.plan({ raw: '午饭', today: '2026-11-06', bookId: 'b1', accounts: [], categories: [] });
    checkEq(res && res.ok, true, 'plan().ok（旧 6s 门会在此超时并被回落本地）');
  } finally {
    sandbox.fetch = originalFetch;
  }
});

regCase('7.4 软提示不再谎称「本地模式」：8s 起提示且文案换掉', function () {
  check(ASSISTANT_JS.indexOf('正在用本地模式…') < 0, '仍残留「正在用本地模式…」软提示');
  check(ASSISTANT_JS.indexOf('模型响应较慢') >= 0, '缺少「模型响应较慢」软提示');
  check(Number(sandbox.XZB.Core.assistant.LLM_SOFT_MS) >= 8000, 'LLM_SOFT_MS 应 >= 8000（20s 硬超时下 5s 就喊回落会误导）');
});

/* ============================== 用例 8：在线模型子页二次进入（2.26.12） ============================== */

section('用例 8：在线模型子页二次进入不再白屏（2.26.12）');

regCase('8.1 渲染不再拿 document.contains 判存活：热路径同步构建 + 冷路径只判 parentNode', function () {
  check(SETTINGS_JS.indexOf('if (!alive(page)) { return; }') < 0,
    '仍残留 alive(page) 存活门：chunk 已热时回调早于 DOM 挂载，二次进入必白屏');
  check(SETTINGS_JS.indexOf('if (!page.parentNode) { return; }') >= 0,
    '冷路径缺少 parentNode 存活判定');
  check(SETTINGS_JS.indexOf('var readyNow = llmApi();') >= 0,
    '缺少「已加载则同步构建」的热路径');
  check(/var readyNow = llmApi\(\);\s*\n\s*if \(readyNow\) \{\s*\n\s*page\.appendChild\(buildAiForm\(ctx\)\);/.test(SETTINGS_JS),
    '热路径未直接构建表单（仍会走异步，存在误判窗口）');
});

/* ============================== 用例 9：https 页面里的 http:// 接口地址（2.26.13） ============================== */

section('用例 9：混合内容预检——https 页面不许填 http://（2.26.13）');

/* 切换页面协议：aiMixedBlock 读 global.location.protocol，沙箱 global 就是 sandbox 本身。
   用例跑完恢复原状，避免污染其它用例（默认沙箱没有 location，等价于「协议未知」）。 */
async function withPageProtocol(protocol, fn) {
  const had = Object.prototype.hasOwnProperty.call(sandbox, 'location');
  const prev = sandbox.location;
  sandbox.location = { protocol: protocol };
  try {
    return await fn();
  } finally {
    if (had) { sandbox.location = prev; } else { delete sandbox.location; }
  }
}

regCase('9.1 https 页面保存 http:// 地址：回 E_AS_NET_MIXED 且原配置不被覆盖', async function () {
  await withPageProtocol('https:', function () {
    seedCompleteConfig();
    const before = llm.getConfig().cfg.baseURL;
    const r = llm.setConfig({ baseURL: 'http://api.example.com/v1' });
    checkEq(r && r.ok, false, 'setConfig().ok');
    checkEq(r && r.code, 'E_AS_NET_MIXED', 'setConfig().code');
    checkEq(r && r.field, 'baseURL', 'setConfig().field');
    checkEq(llm.getConfig().cfg.baseURL, before, '被拒的地址不应写进存储');
  });
});

regCase('9.2 回环地址豁免：https 页面填 http://127.0.0.1 / http://localhost 仍可保存', async function () {
  await withPageProtocol('https:', function () {
    seedCompleteConfig();
    const r1 = llm.setConfig({ baseURL: 'http://127.0.0.1:11434/v1' });
    checkEq(r1 && r1.ok, true, '127.0.0.1 应放行（本地模型反代）');
    checkEq(llm.getConfig().cfg.baseURL, 'http://127.0.0.1:11434/v1', '127.0.0.1 地址应落盘');
    const r2 = llm.setConfig({ baseURL: 'http://localhost:8080/v1' });
    checkEq(r2 && r2.ok, true, 'localhost 应放行');
  });
});

regCase('9.3 旧配置里的 http:// 地址：test()/plan() 直接回 E_AS_NET_MIXED 且不出网', async function () {
  await withPageProtocol('https:', async function () {
    seedCompleteConfig();
    llm.setConfig({ noticeAt: Date.now() });
    /* 绕过 setConfig 的门直接写盘：模拟旧版本遗留或别处同步来的配置 */
    const raw = JSON.parse(ls.getItem(AI_KEY_VALUE));
    raw.baseURL = 'http://api.example.com/v1';
    ls.setItem(AI_KEY_VALUE, JSON.stringify(raw));
    checkEq(llm.getConfig().cfg.baseURL, 'http://api.example.com/v1', '前置：http 地址已在配置里');
    let calls = 0;
    const originalFetch = sandbox.fetch;
    sandbox.fetch = function () { calls += 1; return Promise.reject(new Error('mixed: should not fetch')); };
    try {
      const res = await llm.test();
      checkEq(res && res.ok, false, 'test().ok');
      checkEq(res && res.code, 'E_AS_NET_MIXED', 'test().code');
      const plan = await llm.plan({ raw: '午饭 35', today: '2026-11-06', bookId: 'b1', accounts: [], categories: [] });
      checkEq(plan && plan.code, 'E_AS_NET_MIXED', 'plan().code');
      checkEq(calls, 0, '混合内容必须在出网前拦下，实际 fetch 被调 ' + calls + ' 次');
    } finally {
      sandbox.fetch = originalFetch;
    }
  });
});

regCase('9.4 本地 http 页面（dev server）照旧可填 http://：只在 https 页面拦', async function () {
  await withPageProtocol('http:', function () {
    seedCompleteConfig();
    const r = llm.setConfig({ baseURL: 'http://api.example.com/v1' });
    checkEq(r && r.ok, true, 'http 页面应放行');
    checkEq(llm.getConfig().cfg.baseURL, 'http://api.example.com/v1', '应正常落盘');
  });
});

regCase('9.5 分码的消费方：reasonOf/assistant/ai-insights/settings 都认得 E_AS_NET_MIXED', function () {
  check(CORE_JS.indexOf("MIXED: 'E_AS_NET_MIXED'") >= 0, 'core E 表缺少 MIXED');
  check(CORE_JS.indexOf("if (code === E.MIXED) { return 'mixed'; }") >= 0, 'reasonOf 未把 MIXED 归 mixed');
  check(ASSISTANT_JS.indexOf('mixed: ') >= 0, 'assistant REASON_TEXT 缺少 mixed 文案');
  check(AI_INSIGHTS_JS.indexOf("code === 'E_AS_NET_MIXED'") >= 0, 'ai-insights 未把 MIXED 归 config');
  check(SETTINGS_JS.indexOf('E_AS_NET_MIXED: ') >= 0, 'settings AI_ERR_TEXT 缺少 E_AS_NET_MIXED');
  check(SETTINGS_JS.indexOf("res.code === 'E_AS_NET_MIXED'") >= 0, 'settings apply() 缺少混合内容失败归因');
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
