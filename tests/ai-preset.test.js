'use strict';
/*
 * tests/ai-preset.test.js
 * 自检脚本：内置免费模型预设 + 免密钥通道 + 自由对话兜底（2.29.2）。
 *
 * 背景：小助手此前必须手填 地址/模型/密钥 三项才能联网（aiConfigured 三样齐），
 * 用户主诉「帮我去找免费 key，不用我自己填」。实测内置免费档（text.pollinations.ai
 * 免密钥、OpenAI 兼容 /openai/chat/completions）有两条硬约束：
 *   1) 免密钥档绝不接受 Authorization 头——发「Bearer 空」或假 key 直接 401，
 *      只有整个省掉头才放行（真 key 反而可用）；
 *   2) 限流约 45 秒一条（HTTP 402 FREE_LIMIT），忙时必须回落本地，不能阻塞记账。
 *
 * 固化行为：
 *   - 预设（地址+模型命中且无密钥）视同配置齐全：aiConfigured/llmReady 放宽，
 *     自定义服务仍要求密钥（旧口径不变）；
 *   - 传输层无密钥时整个省掉 Authorization 头；有密钥时照发（回归）；
 *   - respondRemote 对本地听不懂的句子（intent=unknown）走自由对话出口：
 *     只发当轮原话（不发账户/分类名单），成功回 kind:'chat'，失败照常回落本地；
 *   - 设置页「一键应用免费模型」只写地址/模型并清空密钥；升级指引文案在位。
 *
 * 运行：node tests/ai-preset.test.js
 * 加载方式与 ai-config.test.js 一致：node vm 沙箱执行 core-assistant.js，
 * 注入 localStorage stub 与 fetch 桩，不依赖真实网络。
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
const asst = sandbox.XZB.Core.assistant;
const CORE_JS = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/settings.js'), 'utf8');
const AI_KEY_VALUE = 'xzb.ai.v1';

/* 预置「已应用免费预设 + 开关开 + 已告知」状态（设置页一键应用的真实 patch 口径） */
function seedPresetConfig() {
  ls.removeItem(AI_KEY_VALUE);
  const p = llm.preset();
  const r1 = llm.setConfig({ baseURL: p.baseURL, model: p.model, key: '' });
  const r2 = llm.setConfig({ enabled: true });
  const r3 = llm.setConfig({ noticeAt: Date.now() });
  if (!(r1 && r1.ok === true) || !(r2 && r2.ok === true) || !(r3 && r3.ok === true)) {
    throw new Error('预置免费配置写入失败');
  }
}

/* 换 fetch 桩与 onLine 状态（用后还原） */
async function withNet(stub, navigatorOnLine, fn) {
  const prevFetch = sandbox.fetch;
  const prevNav = sandbox.navigator;
  sandbox.fetch = stub;
  if (navigatorOnLine === true || navigatorOnLine === false) {
    sandbox.navigator = { onLine: navigatorOnLine };
  }
  try { return await fn(); }
  finally {
    sandbox.fetch = prevFetch;
    if (prevNav === undefined) { delete sandbox.navigator; } else { sandbox.navigator = prevNav; }
  }
}

/* OpenAI 信封桩：content 为文本 */
function chatEnvelope(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content: content } }] });
}

/* ============================== 用例 1：免密钥预设门 ============================== */

section('用例 1：免密钥预设视同配置齐全，自定义服务仍要密钥');

regCase('1.1 preset() 视图：地址/模型/免密钥标记齐全，id 稳定', function () {
  const p = llm.preset();
  checkEq(p.id, 'pollinations-free', 'id');
  check(p.baseURL.indexOf('https://') === 0, 'baseURL 应为 https');
  check(p.baseURL.indexOf('chat/completions') < 0, 'baseURL 不含端点后缀（由 endpointOf 兜底）');
  check(!!p.model, 'model 非空');
  checkEq(p.keyless, true, 'keyless 标记');
});

regCase('1.2 预设 + 开关 + 已告知：ready()=true（免密钥也算配置齐）', function () {
  seedPresetConfig();
  checkEq(llm.getConfig().cfg.hasKey, false, '无密钥');
  checkEq(llm.isPreset(), true, '命中预设');
  checkEq(llm.ready(), true, 'ready 应为 true');
});

regCase('1.3 自定义地址无密钥：ready()=false，test() 回 E_AS_NOT_CONFIGURED（旧口径不变）', async function () {
  ls.removeItem(AI_KEY_VALUE);
  llm.setConfig({ baseURL: 'https://api.example.com/v1', model: 'gpt-4o-mini', key: '' });
  llm.setConfig({ enabled: true });
  llm.setConfig({ noticeAt: Date.now() });
  checkEq(llm.isPreset(), false, '不命中预设');
  checkEq(llm.ready(), false, '无密钥不应 ready');
  const res = await withNet(function () {
    return Promise.reject(new Error('不应出网'));
  }, true, function () {
    return llm.test();
  });
  checkEq(res && res.code, 'E_AS_NOT_CONFIGURED', '应被 NOT_CONFIGURED 拦下');
});

regCase('1.4 预设 + 贴密钥：不再算免密钥档（isPreset=false），hasKey=true', function () {
  seedPresetConfig();
  llm.setConfig({ key: 'sk-real-key-123456' });
  checkEq(llm.isPreset(), false, '贴了 key 不算免密钥档');
  checkEq(llm.getConfig().cfg.hasKey, true, 'hasKey');
});

regCase('1.5 预设地址改模型：失去免密钥资格', function () {
  seedPresetConfig();
  llm.setConfig({ model: 'mistral' });
  checkEq(llm.isPreset(), false, '改模型不算预设');
  checkEq(llm.ready(), false, '无密钥不应 ready');
});

/* ============================== 用例 2：传输层 Authorization 头 ============================== */

section('用例 2：无密钥整个省掉 Authorization；有密钥照发');

regCase('2.1 免密钥预设：请求头不含 Authorization（发空/假 Bearer 会被免费档 401）', async function () {
  seedPresetConfig();
  let seen = null;
  const res = await withNet(function (url, options) {
    seen = { url: url, options: options };
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"ok":true}'); } });
  }, true, function () {
    return llm.test();
  });
  checkEq(res && res.ok, true, '请求应成功');
  checkEq(seen.url, llm.preset().baseURL + '/chat/completions', 'URL = 预设地址 + /chat/completions');
  checkEq(seen.options.headers.Authorization, undefined, '无密钥不得出现 Authorization 头');
});

regCase('2.2 有密钥：Authorization = Bearer <key>（回归，密钥不出域）', async function () {
  seedPresetConfig();
  llm.setConfig({ key: 'sk-test-1234567890' });
  let seen = null;
  await withNet(function (url, options) {
    seen = { url: url, options: options };
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"ok":true}'); } });
  }, true, function () {
    return llm.test();
  });
  checkEq(seen.options.headers.Authorization, 'Bearer sk-test-1234567890', '有密钥应照发 Bearer');
  check(seen.options.body.indexOf('sk-test-1234567890') < 0, '密钥不得进请求体');
});

/* ============================== 用例 3：记账解析经免密钥走通 ============================== */

section('用例 3：llmPlan 免密钥走通（gate 全过 + 信封解析）');

regCase('3.1 预设配置下 plan() 正常返回模型提案', async function () {
  seedPresetConfig();
  const res = await withNet(function () {
    return Promise.resolve({
      status: 200,
      text: function () {
        return Promise.resolve(chatEnvelope(JSON.stringify({
          intent: 'need_clarify',
          clarify: { question: '金额是多少？', options: [] }
        })));
      }
    });
  }, true, function () {
    return llm.plan({ raw: '记一笔午饭', today: '2026-11-08', bookId: 'bk_main', accounts: [], categories: [] });
  });
  checkEq(res && res.ok, true, 'plan 应成功');
  checkEq(res.proposal && res.proposal.intent, 'need_clarify', '应解析出 intent');
});

/* ============================== 用例 4：自由对话兜底 ============================== */

section('用例 4：intent=unknown 走聊天出口；记账句仍走解析；失败回落本地');

regCase('4.1 「你好呀」→ kind:chat 自然回复（不再硬回没听懂）', async function () {
  seedPresetConfig();
  const res = await withNet(function () {
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('你好呀！我可以帮你记账，比如直接说「午饭 35 微信」。')); } });
  }, true, function () {
    return llm.respondRemote('你好呀', {}, {});
  });
  checkEq(res && res.mode, 'online', '应走在线');
  checkEq(res.reply && res.reply.kind, 'chat', 'kind 应为 chat');
  check((res.reply.text || '').indexOf('你好') >= 0, '应含模型回复');
  check((res.reply.text || '').indexOf('听不懂') < 0, '不应是「没听懂」兜底');
});

regCase('4.2 聊天出口失败（限流）→ 回落本地「没听懂」，绝不静默', async function () {
  seedPresetConfig();
  const res = await withNet(function () {
    return Promise.resolve({ status: 429, text: function () { return Promise.resolve('{}'); } });
  }, true, function () {
    return llm.respondRemote('今天天气怎么样', {}, {});
  });
  checkEq(res && res.mode, 'local-fallback', '应回落本地');
  checkEq(res.reply && res.reply.kind, 'hint', '本地兜底应为 hint');
  check((res.reply.text || '').indexOf('听不懂') >= 0, '应为本地的「没听懂」文案');
});

regCase('4.3 难句（转账缺转入账户）不走快车道：仍发解析请求（system 含「记账解析器」）', async function () {
  seedPresetConfig();
  let bodies = [];
  const res = await withNet(function (url, options) {
    bodies.push(String((options && options.body) || ''));
    return Promise.resolve({
      status: 200,
      text: function () {
        return Promise.resolve(chatEnvelope(JSON.stringify({
          intent: 'need_clarify',
          clarify: { question: '转到哪个账户？', options: [] }
        })));
      }
    });
  }, true, function () {
    return llm.respondRemote('转账 500', {}, { db: { accounts: [{ id: 'acc_wechat', name: '微信', type: 'wechat' }, { id: 'acc_alipay', name: '支付宝', type: 'alipay' }], categories: [] }, today: '2026-11-08' });
  });
  checkEq(bodies.length, 1, '应恰好一次出站请求');
  check(bodies[0].indexOf('记账解析器') >= 0, '应走解析提示词而非聊天');
  check((res.reply || {}).kind !== 'chat', '难句不得落入聊天出口');
});

regCase('4.6 本地快车道：干净记账句秒回预览（零出站、mode=local）', async function () {
  seedPresetConfig();
  let calls = 0;
  const res = await withNet(function () {
    calls += 1;
    return Promise.reject(new Error('快车道不得出站'));
  }, true, function () {
    return llm.respondRemote('午饭 35 微信', {}, {
      db: {
        accounts: [{ id: 'acc_wechat', name: '微信', type: 'wechat' }],
        categories: [{ id: 'ca_food', name: '吃饭', kind: 'expense' }]
      },
      today: '2026-11-08'
    });
  });
  checkEq(calls, 0, '干净记账句不得出站');
  checkEq(res && res.mode, 'local', '快车道应为 local 模式');
  checkEq(res.reply && res.reply.kind, 'preview', '应直接出预览卡');
  checkEq(res.reply && res.reply.canConfirm, true, '预览应可直接确认');
  checkEq(res.reply.rows && res.reply.rows[0] && res.reply.rows[0].categoryText, '吃饭', '分类应本地命中');
  checkEq(res.reply.rows && res.reply.rows[0] && res.reply.rows[0].accountText, '微信', '账户应本地命中');
});

regCase('4.7 缺金额的句子不上快车道：照旧走解析补问', async function () {
  seedPresetConfig();
  let calls = 0;
  await withNet(function () {
    calls += 1;
    return Promise.resolve({
      status: 200,
      text: function () {
        return Promise.resolve(chatEnvelope(JSON.stringify({
          intent: 'need_clarify',
          clarify: { question: '花了多少？', options: [] }
        })));
      }
    });
  }, true, function () {
    return llm.respondRemote('午饭 35，打车', {}, { db: { accounts: [], categories: [] }, today: '2026-11-08' });
  });
  checkEq(calls, 1, '难句应出站解析');
});

regCase('4.4 聊天回复清洗：围栏与包裹引号剥掉，超长截断', async function () {
  seedPresetConfig();
  const res = await withNet(function () {
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('```\n好的，随时说一句就行。\n```')); } });
  }, true, function () {
    return llm.respondRemote('在吗', {}, {});
  });
  checkEq(res.reply && res.reply.text, '好的，随时说一句就行。', '围栏应剥掉');
});

regCase('4.5 隐私边界：聊天请求只带当轮原话，不带账户/分类名单', async function () {
  seedPresetConfig();
  let body = '';
  await withNet(function (url, options) {
    body = String((options && options.body) || '');
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(chatEnvelope('好的')); } });
  }, true, function () {
    return llm.respondRemote('你好呀', {}, {
      db: {
        accounts: [{ id: 'acc_wechat', name: '微信', type: 'wechat' }],
        categories: [{ id: 'ca_food', name: '吃饭', kind: 'expense' }]
      },
      today: '2026-11-08'
    });
  });
  check(body.indexOf('ca_food') < 0, '不得带分类 id');
  check(body.indexOf('账户清单') < 0, '不得带账户清单');
  check(body.indexOf('分类清单') < 0, '不得带分类清单');
  check(body.indexOf('你好呀') >= 0, '应带当轮原话');
});

/* ============================== 用例 5：设置页与核心源码断言 ============================== */

section('用例 5：设置页一键应用与指引（源码级）');

regCase('5.1 「一键应用免费模型」只写地址/模型并清空密钥', function () {
  check(SETTINGS_JS.indexOf('一键应用免费模型（免密钥）') >= 0, '应有预设按钮');
  check(SETTINGS_JS.indexOf('api.setConfig({ baseURL: p.baseURL, model: p.model, key: \'\' })') >= 0,
    '应用预设应清空密钥（残留旧密钥会被免费档按无效 key 401）');
});

regCase('5.2 开关门与占位符认得免密钥预设', function () {
  check(SETTINGS_JS.indexOf('api.isPreset') >= 0, 'configComplete/focusFirstMissing 应认预设');
  check(SETTINGS_JS.indexOf('免密钥 · 内置免费档') >= 0, '密钥占位符应说明免密钥');
});

regCase('5.3 免费档限流与升级指引文案在位（siliconflow）', function () {
  check(SETTINGS_JS.indexOf('45 秒一条') >= 0, '应说明限流');
  check(SETTINGS_JS.indexOf('siliconflow.cn') >= 0, '应有升级指引');
  check(SETTINGS_JS.indexOf('https://api.siliconflow.cn/v1') >= 0, '应给出硅基流动地址');
});

regCase('5.4 隐私告知预检锁句保持（「先在上方同意隐私告知，再测试连接」）', function () {
  check(SETTINGS_JS.indexOf('先在上方同意隐私告知，再测试连接') >= 0, '12.2/4.3 同源锁句不得丢');
  check(SETTINGS_JS.indexOf('你说的话会与账户名称、分类名称一起发送') >= 0,
    '12.2 锁定的主页隐私口径句不得丢');
});

regCase('5.5 核心导出：preset/isPreset 挂在 llm 命名空间', function () {
  check(CORE_JS.indexOf('preset: function ()') >= 0, 'llm.preset 应导出');
  check(CORE_JS.indexOf('isPreset: function ()') >= 0, 'llm.isPreset 应导出');
  checkEq(typeof llm.preset, 'function', 'preset 可调');
  checkEq(typeof llm.isPreset, 'function', 'isPreset 可调');
});

regCase('5.6 测试连接对免费预设放宽到 20s（推理模型探针 6s 门误杀，实测抓到）', function () {
  check(CORE_JS.indexOf('aiIsPreset(cfg) ? LLM_PLAN_TIMEOUT_MS : LLM_TIMEOUT_MS') >= 0,
    'llmTest 应对预设端点传 LLM_PLAN_TIMEOUT_MS');
});

regCase('4.8 查询快车道：带显式时间词的查询本地秒答（零出站）', async function () {
  seedPresetConfig();
  let calls = 0;
  const res = await withNet(function () {
    calls += 1;
    return Promise.reject(new Error('带时间词的查询不得出站'));
  }, true, function () {
    return llm.respondRemote('大前天花了多少', {}, { db: { accounts: [], categories: [], transactions: [] }, today: '2026-11-08' });
  });
  checkEq(calls, 0, '显式时间词查询不得出站');
  checkEq(res && res.mode, 'local', '应为 local 快车道');
  checkEq(res.reply && res.reply.kind, 'query', '应直接出查询结果卡');
});

regCase('4.9 无时间词的模糊查询不上快车道：照旧云端解析', async function () {
  seedPresetConfig();
  let calls = 0;
  await withNet(function () {
    calls += 1;
    return Promise.resolve({
      status: 200,
      text: function () {
        return Promise.resolve(chatEnvelope(JSON.stringify({ intent: 'need_clarify', clarify: { question: '哪个时间段？', options: [] } })));
      }
    });
  }, true, function () {
    return llm.respondRemote('餐饮花了多少', {}, { db: { accounts: [], categories: [] }, today: '2026-11-08' });
  });
  checkEq(calls, 1, '无时间词应出站（本月兜底是猜测，不本地猜）');
});

/* ============================== 用例 6：同句再记不撞已撤销的软删 id ============================== */

section('用例 6：create 计划 id 每次提交带 nonce（记→撤→再记不得撞 E_AS_CONFLICT_ID）');

regCase('6.1 同一句两次 parseCreate：plan id 与 tx id 都不同（直记+撤销后的高频路径）', function () {
  const cx = asst.contextOf({
    db: {
      accounts: [{ id: 'acc_cash', name: '现金', type: 'cash' }],
      categories: [{ id: 'ca_food', name: '吃饭', kind: 'expense' }],
      transactions: []
    },
    today: '2026-11-08'
  });
  const r1 = asst.parseCreate('奶茶 12 现金', cx);
  const r2 = asst.parseCreate('奶茶 12 现金', cx);
  checkEq(r1.ok, true, '第一次应解析成功');
  checkEq(r2.ok, true, '第二次应解析成功');
  check(r1.plan.id !== r2.plan.id, '两次提交 plan id 不得相同');
  check(r1.plan.items[0].id !== r2.plan.items[0].id, 'tx id 不得相同（否则撞软删记录）');
});

regCase('6.2 模型问「用哪个账户」一律不问：回落本地（默认账户口径，用户实测主诉）', async function () {
  seedPresetConfig();
  const res = await withNet(function () {
    return Promise.resolve({
      status: 200,
      text: function () {
        return Promise.resolve(chatEnvelope(JSON.stringify({
          intent: 'need_clarify',
          clarify: {
            question: '请问使用哪个账户？',
            options: [
              { label: '现金', value: 'ac_cash' },
              { label: '微信', value: 'ac_wechat' },
              { label: '支付宝', value: 'ac_alipay' }
            ]
          }
        })));
      }
    });
  }, true, function () {
    return llm.respondRemote('转账 500', {}, {
      db: {
        accounts: [
          { id: 'ac_cash', name: '现金', type: 'cash' },
          { id: 'ac_wechat', name: '微信', type: 'wechat' },
          { id: 'ac_alipay', name: '支付宝', type: 'alipay' }
        ],
        categories: []
      },
      today: '2026-11-08'
    });
  });
  checkEq(res && res.mode, 'local', '账户类补问应回落本地（不得把模型的补问原样抛给用户）');
  checkEq(res.reply && res.reply.kind, 'clarify', '转账缺转入账户应由本地补问');
  check((res.reply.text || '').indexOf('转账') >= 0, '本地补问文案应到位');
  const opt0 = res.reply.options && res.reply.options[0];
  check(!!opt0 && String(opt0.value).indexOf('ac_') === 0, '本地补问选项应是本机账户 id（点回去能被 pending 正确接管）');
});

regCase('6.3 源码锁：提示词禁止问账户 + isAccountClarify 兜底在位', function () {
  check(CORE_JS.indexOf('禁止追问「用哪个账户」') >= 0, '系统提示词应禁止账户补问（规则 12）');
  check(CORE_JS.indexOf('function isAccountClarify(proposal, ctx)') >= 0, '应有账户补问判定');
  check(CORE_JS.indexOf('if (isAccountClarify(proposal, ctx))') >= 0, 'need_clarify 分支应先过账户判定');
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
