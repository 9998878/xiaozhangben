#!/usr/bin/env node
/* ============================================================================
   小账本 2.0 · tools/ai-selftest.js · owner: 助手（T02–T04，开发期资产）
   用途：在没有浏览器、没有真实 API Key 的情况下，把三个 AI 模块的纯函数路径与
        9 种故障路径全部跑一遍。0 依赖，`node tools/ai-selftest.js` 直接运行。

   覆盖范围：
     ① ai-store：默认结构 / 6 个 provider 与默认 model+baseUrl / 空库不写盘 /
        迁移（坏 JSON）/ 跨日单调归一（调早不重置、调晚重置）/ 掩码 / guard /
        setActive 6 个合法 + 未知拒绝 / A→B→A 不串配置 / dailyLimit 夹紧 / 清零
     ② ai-client：6 家 /chat/completions 拼接与 URL 规范化 / 9 种 mock 模式归一 /
        Key 不出现在任何返回对象里 / 无流式退化 E_AI_NO_STREAM / lastMeta 只含元信息
     ③ ai-enhance：Schema 手写校验（含未知键/超长/枚举/引用）/ 数字守卫 /
        工具白名单与 4 轮上限 / run 全链路（成功、幻觉降级、多字段降级、轮数强杀）

   注意：所有异步用例都放进队列**串行**执行。注入的 configure 是全局状态，
   并行跑会互相踩（例如无流式开关会污染后面的正常流式用例）。
   本脚本不联网、不写仓库文件，注入的全部是内存假对象（架构 §13.1）。
   ============================================================================ */
'use strict';

var path = require('path');

var ROOT = path.join(__dirname, '..');
var pass = 0;
var fail = 0;
var failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  failures.push(name + (detail === undefined ? '' : ' → ' + detail));
}

function eq(name, actual, expected) {
  check(name, actual === expected, '实际 ' + JSON.stringify(actual) + ' ≠ 期望 ' + JSON.stringify(expected));
}

function section(title) {
  process.stdout.write('\n== ' + title + ' ==\n');
}

/* 串行队列：注入是全局状态，异步用例必须一条一条来 */
var queue = [];
function add(label, fn) {
  queue.push({ label: label, fn: fn });
}

function runQueue() {
  return queue.reduce(function (chain, item) {
    return chain.then(function () { return item.fn(); }).then(null, function (error) {
      check(item.label + ' 正常返回（未抛异常）', false, error && error.message ? error.message : String(error));
    });
  }, Promise.resolve());
}

/* ============================== 假环境 ============================== */

function MemoryStorage() {
  this.map = {};
}

MemoryStorage.prototype.getItem = function (key) {
  return Object.prototype.hasOwnProperty.call(this.map, key) ? this.map[key] : null;
};
MemoryStorage.prototype.setItem = function (key, value) {
  this.map[key] = String(value);
};
MemoryStorage.prototype.removeItem = function (key) {
  delete this.map[key];
};
MemoryStorage.prototype.keys = function () {
  return Object.keys(this.map);
};

function at(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

global.XZB = global.XZB || {};

var store = require(path.join(ROOT, 'js/modules/ai-store.js'));
var client = require(path.join(ROOT, 'js/modules/ai-client.js'));
var enhance = require(path.join(ROOT, 'js/modules/ai-enhance.js'));
/* insight-qa 只为 sumWindow 进载荷统计；纯计算，无 IO */
require(path.join(ROOT, 'js/modules/insight-qa.js'));

/* ============================== ① ai-store（同步） ============================== */

section('① ai-store 存储层');

var mem = new MemoryStorage();
var clock = at(2026, 11, 2);
store.configure({ storage: mem, now: function () { return clock; } });

var cfg0 = store.load();
eq('providers 键数恰为 6', Object.keys(cfg0.providers).length, 6);
eq('默认 active = modelscope', cfg0.active, 'modelscope');
eq('空库不写盘', mem.getItem(store.KEY), null);
eq('默认 dailyLimit', cfg0.prefs.dailyLimit, 100);
eq('consent 默认未授权', store.consent().granted, false);

/* 与架构 §4.1.1 逐字一致 */
var expectedPreset = {
  modelscope: ['Qwen/Qwen3-32B', 'https://api-inference.modelscope.cn/v1'],
  zhipu: ['glm-4-flash', 'https://api.z.ai/api/paas/v4'],
  siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'https://api.siliconflow.cn/v1'],
  openrouter: ['deepseek/deepseek-r1:free', 'https://openrouter.ai/api/v1'],
  dashscope: ['qwen-turbo', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  custom1: ['', '']
};

Object.keys(expectedPreset).forEach(function (id) {
  var item = expectedPreset[id];
  eq(id + ' model', cfg0.providers[id].model, item[0]);
  eq(id + ' baseUrl', cfg0.providers[id].baseUrl, item[1]);
});

check('默认值里不含智谱国内站', JSON.stringify(cfg0).indexOf('bigmodel.cn') < 0);
/* enabled 字段已删（D8）：providers 每项固定 6 个字段 */
eq('provider 字段固定 6 个', Object.keys(cfg0.providers.modelscope).length, 6);
check('provider 不带 enabled 字段', cfg0.providers.modelscope.enabled === undefined);

/* setKey / 掩码 / guard */
var setResult = store.setKey('modelscope', '  Bearer "sk-abcdefgh12345"  ');
eq('setKey 成功', setResult.ok, true);
eq('setKey 剥掉 Bearer 与引号', store.revealKey('modelscope'), 'sk-abcdefgh12345');
eq('hasKey 为真', store.hasKey('modelscope'), true);
eq('maskedKey 前 4 后 4', store.maskedKey('modelscope'), 'sk-a…2345');
check('maskedKey 总长 ≤12', store.maskedKey('modelscope').length <= 12);
check('guard 命中明文 Key 时返回 false', store.guard('前缀 sk-abcdefgh12345 后缀') === false);
check('guard 干净文本返回 true', store.guard('这是一段普通文本') === true);
eq('掩码不含完整 Key', store.maskedKey('modelscope').indexOf('sk-abcdefgh12345'), -1);

/* setActive：6 个全部接受，未知拒绝 */
['modelscope', 'zhipu', 'siliconflow', 'openrouter', 'dashscope', 'custom1'].forEach(function (id) {
  eq('setActive 接受 ' + id, store.setActive(id).ok, true);
});
eq('setActive 拒绝未知 id', store.setActive('openai').ok, false);

/* A→B→A 不串配置（AC6） */
store.setKey('modelscope', 'sk-modelscope-key-0001');
store.setKey('zhipu', 'sk-zhipu-key-0000002');
store.setActive('zhipu');
var cfgB = store.getActive();
eq('切到 zhipu 后 active', cfgB.id, 'zhipu');
eq('zhipu 用自己的 Key', cfgB.key, 'sk-zhipu-key-0000002');
eq('zhipu 用自己的 model', cfgB.model, 'glm-4-flash');
store.setActive('modelscope');
var cfgA = store.getActive();
eq('切回 A 的 Key 未被污染', cfgA.key, 'sk-modelscope-key-0001');
eq('切回 A 的 model 未被污染', cfgA.model, 'Qwen/Qwen3-32B');

/* clearKey 保留 model/baseUrl */
store.clearKey('modelscope');
eq('clearKey 清掉 Key', store.hasKey('modelscope'), false);
eq('clearKey 保留 model', store.getActive().model, 'Qwen/Qwen3-32B');

/* 迁移：坏 JSON → E_AI_STORE_CORRUPT + 回落默认 */
mem.setItem(store.KEY, '{"v":1,"active":');
store.configure({ storage: mem, now: function () { return clock; } });
var recovered = store.load();
eq('坏 JSON 回落默认 active', recovered.active, 'modelscope');
eq('坏 JSON 上报 E_AI_STORE_CORRUPT', store.lastLoadCode(), 'E_AI_STORE_CORRUPT');

/* 跨日单调归一（AC9） */
store.clearAll();
clock = at(2026, 11, 2);
store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 100, counted: true });
store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 200, counted: true });
store.bumpUsage({ providerId: 'modelscope', ok: false, firstByteMs: 0, counted: true });
eq('同一天累加到 3', store.usage().count, 3);
eq('成功计数 2', store.usage().ok, 2);
eq('失败计数 1', store.usage().fail, 1);

clock = at(2026, 10, 1);  /* 把系统时间调早 */
store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 300, counted: true });
eq('时间调早不重置（继续累加）', store.usage().count, 4);

clock = at(2026, 11, 3);  /* 再把时间调晚 */
store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 400, counted: true });
eq('时间调晚后重置为 1', store.usage().count, 1);

/* 不计次的调用只加 ok/fail，不加 count（重试与连接测试用） */
store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 10, counted: false });
eq('counted:false 不加 count', store.usage().count, 1);
eq('counted:false 仍加 ok', store.usage().ok, 2);

/* dailyLimit 夹紧到 20–200、步进 20 */
eq('dailyLimit 7 → 20', store.setPref('dailyLimit', 7).value, 20);
eq('dailyLimit 31 → 40', store.setPref('dailyLimit', 31).value, 40);
eq('dailyLimit 233 → 200', store.setPref('dailyLimit', 233).value, 200);
eq('dailyLimit 夹紧后 usage().limit', store.usage().limit, 200);

/* 分家用量与全局同源（此刻只有 modelscope 一家被计数） */
eq('分家 count 与全局一致', store.getActive().usage.count, store.usage().count);

store.resetUsage();
eq('resetUsage 清零', store.usage().count, 0);

/* 授权 */
store.grantConsent(store.CONSENT_VERSION);
eq('授权后 granted', store.consent().granted, true);
store.revokeConsent();
eq('撤销后未授权', store.consent().granted, false);
store.grantConsent(store.CONSENT_VERSION);
eq('重新授权 granted', store.consent().granted, true);

store.setKey('openrouter', 'sk-or-v1-abcdefgh9999');
check('guard 命中第二家 Key', store.guard('token=sk-or-v1-abcdefgh9999') === false);

/* ---- D1 / AC19：平台闸门 ---- */
store.revokeConsent();
global.location = { protocol: 'file:' };
eq('file:// 下 platform().ok 为假', store.platform().ok, false);
eq('file:// 下 platform().code', store.platform().code, 'E_AI_FILE_PROTOCOL');
eq('file:// 下 consent 恒未授权', store.consent().granted, false);
var fileGrant = store.grantConsent(store.CONSENT_VERSION);
eq('file:// 下 grantConsent 被拒', fileGrant.ok, false);
eq('file:// 下 grantConsent 错误码', fileGrant.code, 'E_AI_FILE_PROTOCOL');
delete global.location;
eq('恢复非 file:// 后 platform 可用', store.platform().ok, true);
eq('被拒的授权没有落盘（恢复后仍未授权）', store.consent().granted, false);
store.grantConsent(store.CONSENT_VERSION);
eq('恢复后可正常授权', store.consent().granted, true);

/* ---- D7：wipe() / invalidate() ---- */
eq('wipe 是函数', typeof store.wipe, 'function');
eq('invalidate 是函数', typeof store.invalidate, 'function');
store.setKey('custom1', 'sk-wipe-me-000001');
eq('wipe 返回 ok', store.wipe().ok, true);
eq('wipe 清掉 Key', store.hasKey('custom1'), false);
eq('wipe 清掉授权', store.consent().granted, false);
store.invalidate();
eq('invalidate 后仍能读默认值', store.load().active, 'modelscope');
store.grantConsent(store.CONSENT_VERSION);

/* ---- D9：usage.day 脏值防御 ---- */
mem.setItem(store.KEY, JSON.stringify({
  v: 1,
  active: 'modelscope',
  usage: { day: 'not-a-date', dayFloor: 'x', count: 99 },
  providers: {}
}));
store.configure({ storage: mem, now: function () { return at(2026, 11, 2); } });
eq('脏日期视为当天', store.usage().day, '2026-11-02');
eq('脏日期计数归零', store.usage().count, 0);

/* ---- 跨日：用「存储造态 + 重载」验（不伪造今天，最接近真实用户次日状态） ---- */
function dayShift(delta) {
  var d = new Date(Date.now() + delta * 86400000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function seedUsage(day, count) {
  mem.setItem(store.KEY, JSON.stringify({
    v: 1,
    consent: { version: 1, at: '2026-01-01T00:00:00.000Z', revokedAt: null },
    active: 'modelscope',
    prefs: { dailyLimit: 100, sendNote: false, entryHintDismissed: false },
    usage: { day: day, dayFloor: day, count: count, ok: count, fail: 0, firstByteMsSum: 0, firstByteN: 0 },
    providers: {}
  }));
  store.configure({ storage: mem, now: function () { return Date.now(); } });
}

seedUsage(dayShift(-1), 5);
eq('造「昨天」的存储态 → 重载后 count 归零', store.usage().count, 0);
eq('造「昨天」的存储态 → day 变成今天', store.usage().day, dayShift(0));

seedUsage('2099-01-01', 7);
eq('造「未来日期」的存储态 → 不归零（防系统时间被调早）', store.usage().count, 7);

/* ---- D11：落盘失败不抛异常，且丢掉内存缓存 ---- */
var brokenStorage = new MemoryStorage();
brokenStorage.setItem = function () { throw new Error('QuotaExceededError'); };
store.configure({ storage: brokenStorage, now: function () { return at(2026, 11, 2); } });
var bumpThrew = false;
try {
  store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 5, counted: true });
} catch (error) { bumpThrew = true; }
eq('写盘失败时 bumpUsage 不抛异常', bumpThrew, false);
eq('写盘失败后缓存已丢弃（重新读盘仍是 0）', store.usage().count, 0);
store.configure({ storage: mem, now: function () { return clock; } });

/* ============================== ② ai-client ============================== */

section('② ai-client 传输层');

var expectedUrl = {
  modelscope: 'https://api-inference.modelscope.cn/v1/chat/completions',
  zhipu: 'https://api.z.ai/api/paas/v4/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
};

Object.keys(expectedUrl).forEach(function (id) {
  eq('URL 拼接 ' + id, client.chatUrl(cfg0.providers[id].baseUrl), expectedUrl[id]);
});
eq('尾斜杠归一', client.chatUrl('https://api.z.ai/api/paas/v4///'), 'https://api.z.ai/api/paas/v4/chat/completions');
eq('已含 /chat/completions 不重复拼', client.chatUrl('https://x.example/v1/chat/completions'), 'https://x.example/v1/chat/completions');
eq('非 http(s) 地址拒绝', client.chatUrl('ftp://x.example/v1'), '');

var ANSWER_TEXT = '本月的账我看过了，支出结构和上个月接近，主要变化在你花得最多的那几类里。';

function sseLine(content) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: content } }] }) + '\n\n';
}

function readerOf(chunks) {
  var cursor = 0;
  return {
    getReader: function () {
      return {
        read: function () {
          if (cursor >= chunks.length) { return Promise.resolve({ done: true }); }
          var bytes = Buffer.from(chunks[cursor], 'utf8');
          cursor += 1;
          return Promise.resolve({ done: false, value: new Uint8Array(bytes) });
        }
      };
    }
  };
}

function respStream(pieces) {
  var chunks = [];
  var i;
  for (i = 0; i < pieces.length; i += 1) { chunks.push(sseLine(pieces[i])); }
  chunks.push('data: [DONE]\n\n');
  return {
    ok: true,
    status: 200,
    headers: { get: function () { return null; } },
    body: readerOf(chunks),
    text: function () { return Promise.resolve(chunks.join('')); }
  };
}

function respRawStream(rawLines) {
  return {
    ok: true,
    status: 200,
    headers: { get: function () { return null; } },
    body: readerOf(rawLines),
    text: function () { return Promise.resolve(rawLines.join('')); }
  };
}

function respText(text, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: function () { return null; } },
    text: function () { return Promise.resolve(text); }
  };
}

function respStatus(status, retryAfter) {
  return {
    ok: false,
    status: status,
    headers: { get: function (name) { return name === 'Retry-After' ? (retryAfter || null) : null; } },
    text: function () { return Promise.resolve('{}'); }
  };
}

/* 「脏形态」响应：与 tools/mock-ai-server.js 的 dirty 档逐字一致。
   注释行 / event+id / data: 后带空格 / 一行两个 data: / 畸形 JSON / 中文按字节切半 / 末帧不带换行。 */
function respDirty() {
  var parts = [
    ': keep-alive\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '本月' } }] }) + '\n\n',
    'event: ping\nid: 7\ndata:' + JSON.stringify({ choices: [{ delta: { content: '支出' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '稳定' } }] }) + '\n\n',
    'data: {"choices":[{"delta":{"content":"X"}}]} data: {"choices":[{"delta":{"content":"Y"}}]}\n\n',
    'data: {oops\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '完成' } }] })
  ];
  var buf = Buffer.from(parts.join(''), 'utf8');
  var slices = [];
  for (var i = 0; i < buf.length; i += 7) { slices.push(new Uint8Array(buf.slice(i, i + 7))); }
  var cursor = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: function () { return null; } },
    body: {
      getReader: function () {
        return {
          read: function () {
            if (cursor >= slices.length) { return Promise.resolve({ done: true }); }
            var value = slices[cursor];
            cursor += 1;
            return Promise.resolve({ done: false, value: value });
          },
          cancel: function () { return Promise.resolve(); }
        };
      }
    },
    text: function () { return Promise.resolve(''); }
  };
}

/* [DONE] 之后连接不关：用来验证 client 收到 [DONE] 就 cancel + settle，而不是挂到整轮超时 */
function respDoneThenHang(text) {
  var queue = [sseLine(text), 'data: [DONE]\n\n'];
  var cursor = 0;
  var cancelled = false;
  var resp = {
    ok: true,
    status: 200,
    headers: { get: function () { return null; } },
    body: {
      getReader: function () {
        return {
          read: function () {
            if (cancelled) { return new Promise(function () { /* 永不结算 */ }); }
            if (cursor >= queue.length) { return new Promise(function () { /* 永不结算 */ }); }
            var bytes = Buffer.from(queue[cursor], 'utf8');
            cursor += 1;
            return Promise.resolve({ done: false, value: new Uint8Array(bytes) });
          },
          cancel: function () { cancelled = true; return Promise.resolve(); }
        };
      }
    },
    text: function () { return Promise.resolve(''); }
  };
  resp.wasCancelled = function () { return cancelled; };
  return resp;
}

/* 防止「本该收口却没收口」时整个自检挂死：到点返回一个哨兵对象，由断言判失败 */
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise(function (resolve) {
    setTimeout(function () { resolve({ __timeout: true, label: label }); }, ms);
  })]);
}

/* 9 种故障模式的「假 fetch」：与 tools/mock-ai-server.js 的模式语义一一对应 */
function fetchFor(mode) {
  return function () {
    if (mode === 'cors') { return Promise.reject(new Error('Failed to fetch')); }
    if (mode === 'timeout') { return new Promise(function () { /* 永不结算 */ }); }
    if (mode === '401') { return Promise.resolve(respStatus(401)); }
    if (mode === '400') { return Promise.resolve(respStatus(400)); }
    if (mode === '404') { return Promise.resolve(respStatus(404)); }
    if (mode === '402') { return Promise.resolve(respStatus(402, '30')); }
    if (mode === '429') { return Promise.resolve(respStatus(429, '30')); }
    if (mode === '500') { return Promise.resolve(respStatus(500)); }
    if (mode === 'words') { return Promise.resolve(respStream(['hello ', 'world'])); }
    if (mode === 'hugechunk') {
      /* 单个 chunk 就超过 MAX_RAW(2MB)：应在解析前直接判 E_AI_BAD_ENVELOPE（D12） */
      var big = new Uint8Array(2 * 1024 * 1024 + 16);
      var cursorBig = 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: function () { return null; } },
        body: {
          getReader: function () {
            return {
              read: function () {
                if (cursorBig) { return Promise.resolve({ done: true }); }
                cursorBig = 1;
                return Promise.resolve({ done: false, value: big });
              },
              cancel: function () { return Promise.resolve(); }
            };
          }
        },
        text: function () { return Promise.resolve(''); }
      });
    }
    if (mode === 'badjson') { return Promise.resolve(respRawStream(['data: {"choices":[{"delta":{"content":\n\n', 'data: [DONE]\n\n'])); }
    if (mode === 'nonstream') {
      return Promise.resolve(respText(JSON.stringify({
        choices: [{ message: { content: ANSWER_TEXT } }],
        usage: { total_tokens: 9 }
      })));
    }
    if (mode === 'huge') {
      var long = '';
      for (var i = 0; i < 200; i += 1) { long += '这一段用来测试超长回答'; }
      return Promise.resolve(respStream([JSON.stringify({ t: 'answer', text: long.slice(0, 2000), refs: [], confidence: 'ok' })]));
    }
    if (mode === 'extra') {
      return Promise.resolve(respStream([JSON.stringify({ t: 'answer', text: ANSWER_TEXT, refs: [], confidence: 'ok', hint: '多余字段' })]));
    }
    if (mode === 'halluc') {
      return Promise.resolve(respStream([JSON.stringify({ t: 'answer', text: '这次一共 ¥888.88。', refs: [], confidence: 'ok' })]));
    }
    if (mode === 'tool') {
      return Promise.resolve(respStream([JSON.stringify({ t: 'tool', name: 'queryLedger', args: { month: '2026-11' }, n: 1 })]));
    }
    if (mode === 'answer') {
      return Promise.resolve(respStream([JSON.stringify({ t: 'answer', text: ANSWER_TEXT, refs: [], evidence: [], confidence: 'ok' })]));
    }
    return Promise.resolve(respStream([ANSWER_TEXT.slice(0, 10), ANSWER_TEXT.slice(10)]));
  };
}

var provider = {
  id: 'modelscope',
  key: 'sk-test-key-0000000001',
  model: 'Qwen/Qwen3-32B',
  baseUrl: 'https://api-inference.modelscope.cn/v1'
};

function chatOnce(mode, options) {
  var opts = options || {};
  client.configure({ fetchImpl: fetchFor(mode), timeoutScale: opts.timeoutScale || 1, streamSupported: null });
  return client.chat({
    provider: opts.provider || provider,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
    stream: true
  }, {});
}

add('正常 SSE', function () {
  return chatOnce('ok').then(function (res) {
    eq('正常 SSE → ok', res.ok, true);
    eq('正常 SSE → code OK', res.code, 'OK');
    eq('正常 SSE → 拼出完整正文', res.text, ANSWER_TEXT);
    var meta = client.lastMeta();
    eq('lastMeta 只有 4 个字段', Object.keys(meta).length, 4);
    check('lastMeta 不含 Key', JSON.stringify(meta).indexOf(provider.key) < 0);
    check('返回对象不含 Key', JSON.stringify(res).indexOf(provider.key) < 0);
  });
});

add('非流式', function () {
  return chatOnce('nonstream').then(function (res) {
    eq('非流式 → ok', res.ok, true);
    eq('非流式 → 正文一致', res.text, ANSWER_TEXT);
  });
});

add('非 JSON', function () {
  return chatOnce('badjson').then(function (res) {
    eq('非 JSON 半包 → E_AI_BAD_ENVELOPE', res.code, 'E_AI_BAD_ENVELOPE');
    eq('非 JSON 半包 → ok 为假', res.ok, false);
  });
});

add('401', function () {
  return chatOnce('401').then(function (res) { eq('401 → E_AI_401', res.code, 'E_AI_401'); });
});

add('429', function () {
  return chatOnce('429').then(function (res) {
    eq('429 → E_AI_429', res.code, 'E_AI_429');
    eq('429 读取 Retry-After', res.retryAfterMs, 30000);
  });
});

add('402', function () {
  return chatOnce('402').then(function (res) { eq('402 → E_AI_402', res.code, 'E_AI_402'); });
});

add('500', function () {
  return chatOnce('500').then(function (res) { eq('500 → E_AI_5XX', res.code, 'E_AI_5XX'); });
});

add('CORS 被拦', function () {
  return chatOnce('cors').then(function (res) { eq('CORS 被拦 → E_AI_CORS', res.code, 'E_AI_CORS'); });
});

add('首字节超时', function () {
  return chatOnce('timeout', { timeoutScale: 0.005 }).then(function (res) {
    eq('首字节超时 → E_AI_TIMEOUT_FIRST', res.code, 'E_AI_TIMEOUT_FIRST');
  });
});

add('无 Key', function () {
  return chatOnce('ok', { provider: { id: 'x', model: 'm', baseUrl: provider.baseUrl, key: '' } }).then(function (res) {
    eq('无 Key → E_AI_NO_KEY', res.code, 'E_AI_NO_KEY');
  });
});

add('无流式能力', function () {
  client.configure({ fetchImpl: fetchFor('ok'), streamSupported: false });
  return client.chat({ provider: provider, messages: [{ role: 'user', content: 'ping' }], stream: true }, {}).then(function (res) {
    eq('无流式 → 仍算成功', res.ok, true);
    eq('无流式 → code E_AI_NO_STREAM', res.code, 'E_AI_NO_STREAM');
    eq('无流式 → 正文完整且不重复', res.text, ANSWER_TEXT);
    client.configure({ streamSupported: null });
  });
});

add('file:// 协议', function () {
  global.location = { protocol: 'file:' };
  client.configure({ fetchImpl: fetchFor('ok'), streamSupported: null });
  /* chat 在发起时同步判协议，所以设完立刻还原，避免污染后续用例 */
  var pending = client.chat({ provider: provider, messages: [{ role: 'user', content: 'ping' }] }, {});
  delete global.location;
  return pending.then(function (res) { eq('file:// → E_AI_FILE_PROTOCOL', res.code, 'E_AI_FILE_PROTOCOL'); });
});

add('连接测试', function () {
  client.configure({ fetchImpl: fetchFor('nonstream'), streamSupported: null });
  return client.test(provider).then(function (res) {
    eq('连接测试 ok', res.ok, true);
    eq('连接测试 code OK', res.code, 'OK');
    check('连接测试返回毫秒数', typeof res.ms === 'number' && res.ms >= 0);
  });
});

/* ---- D5：请求头恰好 3 个，Key 只进 Authorization ---- */
add('请求头恰好 3 个', function () {
  var captured = null;
  client.configure({
    streamSupported: null,
    fetchImpl: function (url, init) {
      captured = { url: url, init: init };
      return Promise.resolve(respStream([ANSWER_TEXT]));
    }
  });
  return client.chat({ provider: provider, messages: [{ role: 'user', content: 'ping' }], stream: true }, {}).then(function (res) {
    var headers = captured.init.headers || {};
    var keys = Object.keys(headers);
    eq('请求头恰好 3 个', keys.length, 3);
    eq('有 Content-Type', headers['Content-Type'], 'application/json');
    eq('有 Accept: text/event-stream', headers.Accept, 'text/event-stream');
    check('Authorization 带 Bearer', headers.Authorization === 'Bearer ' + provider.key);
    check('Key 不进 URL', captured.url.indexOf(provider.key) < 0);
    check('Key 不进 body', String(captured.init.body).indexOf(provider.key) < 0);
    eq('正常 SSE 仍成功', res.ok, true);
  });
});

/* ---- D2：末帧不带尾随换行 + 三种脏形态，一个都不能丢 ---- */
add('dirty 档（D2）', function () {
  client.configure({ fetchImpl: function () { return Promise.resolve(respDirty()); }, streamSupported: null });
  var deltas = 0;
  return withTimeout(client.chat({
    provider: provider,
    messages: [{ role: 'user', content: 'ping' }],
    stream: true
  }, { onDelta: function () { deltas += 1; } }), 4000, 'dirty').then(function (res) {
    eq('dirty 未超时（说明残余 buffer 被消费且能收口）', res.__timeout === undefined, true);
    eq('dirty → ok', res.ok, true);
    eq('dirty → code OK', res.code, 'OK');
    eq('dirty → 中文跨字节切分后不乱码', res.text, '本月支出稳定完成');
    check('dirty → onDelta 多次回调', deltas >= 2);
    check('dirty → 正文里没有替换符', res.text.indexOf('\ufffd') < 0);
  });
});

/* ---- D3：[DONE] 之后必须 cancel + settle，不能挂到整轮超时 ---- */
add('[DONE] 后立刻收口（D3）', function () {
  var resp = respDoneThenHang(ANSWER_TEXT);
  client.configure({ fetchImpl: function () { return Promise.resolve(resp); }, streamSupported: null });
  return withTimeout(client.chat({
    provider: provider,
    messages: [{ role: 'user', content: 'ping' }],
    stream: true
  }, {}), 4000, 'done').then(function (res) {
    eq('[DONE] 后没有悬挂', res.__timeout === undefined, true);
    eq('[DONE] 后 ok', res.ok, true);
    eq('[DONE] 后正文完整', res.text, ANSWER_TEXT);
    eq('[DONE] 后调用了 reader.cancel()', resp.wasCancelled(), true);
  });
});

/* ---- D4：英文词间空格不能被吃掉 ---- */
add('英文双词不黏连（D4）', function () {
  return chatOnce('words').then(function (res) {
    eq('两段英文拼接保留空格', res.text, 'hello world');
  });
});

/* ---- D6：400 / 404 单独归因 ---- */
add('400 / 404 归因（D6）', function () {
  return chatOnce('400').then(function (res) {
    eq('400 → E_AI_BAD_REQUEST', res.code, 'E_AI_BAD_REQUEST');
    return chatOnce('404');
  }).then(function (res) {
    eq('404 → E_AI_NOT_FOUND', res.code, 'E_AI_NOT_FOUND');
  });
});

/* ---- D12：单块超过 MAX_RAW 直接判失败 ---- */
add('单块超限（D12）', function () {
  return chatOnce('hugechunk').then(function (res) {
    eq('单块超 2MB → E_AI_BAD_ENVELOPE', res.code, 'E_AI_BAD_ENVELOPE');
  });
});

/* ---- SSE 行规则单测（注释行/event/id/一行两个 data:/data: 后无空格） ---- */
add('SSE 行规则', function () {
  var sink = client.parseSseLines([
    ': keep-alive',
    '',
    'event: ping',
    'id: 7',
    'retry: 3000',
    'data:{"choices":[{"delta":{"content":"甲"}}]}',
    'data: {"choices":[{"delta":{"content":"乙"}}]}',
    'data: {"choices":[{"delta":{"content":"丙"}}]} data: {"x":1}',
    'data: not-json',
    'data: {"choices":[{"delta":{"content":"丁"}}]}'
  ], null);
  eq('行规则 → 只拼合法块', sink.content, '甲乙丁');
  eq('行规则 → 脏块计数', sink.bad >= 2, true);
  eq('行规则 → 未误判 DONE', sink.done, false);
});

/* ============================== ③ ai-enhance ============================== */

section('③ ai-enhance 编排层');

add('Schema 校验器', function () {
  var v1 = enhance.validate({ t: 'answer', text: ANSWER_TEXT, refs: ['m1'], confidence: 'ok' }, enhance.SPEC_ANSWER, { metrics: { m1: true }, evidence: {} });
  eq('Schema answer 通过', v1.ok, true);
  eq('Schema 未知键 → E_SCHEMA_EXTRA',
    enhance.validate({ t: 'answer', text: 'x', refs: [], confidence: 'ok', hint: 'y' }, enhance.SPEC_ANSWER, { metrics: {}, evidence: {} }).code,
    'E_SCHEMA_EXTRA');
  eq('Schema 缺必填 → E_SCHEMA_MISSING',
    enhance.validate({ t: 'answer', text: 'x' }, enhance.SPEC_ANSWER, { metrics: {}, evidence: {} }).code,
    'E_SCHEMA_MISSING');
  eq('Schema 枚举越界 → E_SCHEMA_ENUM',
    enhance.validate({ t: 'answer', text: 'x', refs: [], confidence: 'high' }, enhance.SPEC_ANSWER, { metrics: {}, evidence: {} }).code,
    'E_SCHEMA_ENUM');
  eq('Schema 引用不存在 → E_SCHEMA_REF',
    enhance.validate({ t: 'answer', text: 'x', refs: ['m9'], confidence: 'ok' }, enhance.SPEC_ANSWER, { metrics: { m1: true }, evidence: {} }).code,
    'E_SCHEMA_REF');
  eq('Schema 非对象 → E_SCHEMA_TYPE', enhance.validate('text', enhance.SPEC_ANSWER, {}).code, 'E_SCHEMA_TYPE');

  var longText = '';
  for (var i = 0; i < 401; i += 1) { longText += '字'; }
  eq('text 超过 400 字 → E_SCHEMA_LEN',
    enhance.validate({ t: 'answer', text: longText, refs: [], confidence: 'ok' }, enhance.SPEC_ANSWER, { metrics: {}, evidence: {} }).code,
    'E_SCHEMA_LEN');
  eq('超长不截断（校验器不改原文）', longText.length, 401);

  eq('slots 规格已留好（P0 不接线，T11 才用）',
    enhance.validate({ t: 'slots', segment: '昨天打车', amountFragment: '18', type: 'expense' }, enhance.SPEC_SLOTS, { question: '昨天打车 18' }).ok,
    true);
  eq('slots 锚点不匹配 → E_SCHEMA_ANCHOR',
    enhance.validate({ t: 'slots', segment: '前天打车', amountFragment: '18', type: 'expense' }, enhance.SPEC_SLOTS, { question: '昨天打车 18' }).code,
    'E_SCHEMA_ANCHOR');
});

add('数字守卫', function () {
  var allowed = enhance.buildAllowed([
    { kind: 'cents', value: 2800 },
    { kind: 'cents', value: 40000 },
    { kind: 'count', value: 3 },
    { kind: 'pct', value: 12 },
    { kind: 'day', value: '2026-11-01' },
    { kind: 'month', value: '2026-11' }
  ]);
  eq('纯文字建议（无数字）放行', enhance.guardNumbers('这段时间可以少点外卖。', allowed).ok, true);
  eq('与载荷一致的数字放行', enhance.guardNumbers('本月花了 ¥28.00，共 3 笔。', allowed).ok, true);
  eq('百分比一致放行', enhance.guardNumbers('比上月多了 12%。', allowed).ok, true);
  eq('日期一致放行', enhance.guardNumbers('11月1日 那天的记录', allowed).ok, true);
  eq('中文笔数放行', enhance.guardNumbers('一共三笔。', allowed).ok, true);
  eq('不存在的金额 → E_NUM_HALLUCINATION', enhance.guardNumbers('一共 ¥888.88。', allowed).code, 'E_NUM_HALLUCINATION');
  eq('不存在的日期 → E_NUM_DATE', enhance.guardNumbers('9月9日 那天', allowed).code, 'E_NUM_DATE');
  check('守卫返回命中的原始片段', enhance.guardNumbers('一共 ¥888.88。', allowed).hits.length > 0);
});

add('工具白名单', function () {
  eq('白名单外的工具被拒', enhance.runTool('deleteTransaction', {}, null).code, 'E_AI_TOOL_DENIED');
  eq('写入类工具被拒', enhance.runTool('app.commit', {}, null).code, 'E_AI_TOOL_DENIED');
  eq('拼写错误的工具被拒', enhance.runTool('queryledger', {}, null).code, 'E_AI_TOOL_DENIED');
  eq('白名单恰好 4 个', enhance.TOOL_WHITELIST.length, 4);
  eq('执行类黑名单非空', enhance.TOOL_FORBIDDEN.length > 0, true);
});

var fakeCx = {
  bookId: 'b1',
  today: '2026-11-02',
  db: {
    books: [{ id: 'b1', name: '日常' }],
    accounts: [
      { id: 'a1', name: '微信零钱', archived: false },
      { id: 'a2', name: '工资卡', archived: false }
    ],
    categories: [
      { id: 'ca_food', name: '餐饮', hidden: false },
      { id: 'ca_traffic', name: '交通', hidden: false }
    ],
    transactions: [
      { id: 't1', bookId: 'b1', date: '2026-11-01', type: 'expense', amountCents: 2800, categoryId: 'ca_food', accountId: 'a1', note: '午饭' },
      { id: 't2', bookId: 'b1', date: '2026-10-15', type: 'expense', amountCents: 4000, categoryId: 'ca_food', accountId: 'a2', note: '聚餐' }
    ],
    settings: { activeBookId: 'b1' }
  }
};
fakeCx.accounts = fakeCx.db.accounts;
fakeCx.categories = fakeCx.db.categories;
fakeCx.liveAccounts = fakeCx.db.accounts;
fakeCx.liveCategories = fakeCx.db.categories;
fakeCx.settings = fakeCx.db.settings;

/* Node 下用真实 core-assistant 验 D17（queryTotals 的 exclude 口径）；
   加载失败时相关用例会显式判失败，不静默跳过 */
var coreAssistant = null;
try { coreAssistant = require(path.join(ROOT, 'js/modules/core-assistant.js')); } catch (error) { coreAssistant = null; }

/* Node 下没有可用的 cx.db 写入链，run 链路用最小 stub 顶掉依赖（只测编排逻辑）。
   两行分别属于两个账户，用来验 D14 的账户代号映射。 */
global.XZB.core.assistant = {
  queryTotals: function () {
    return {
      count: 2,
      expenseCents: 6800,
      incomeCents: 0,
      rows: [
        { id: 't1', date: '2026-11-01', amountCents: 2800, categoryText: '餐饮', accountId: 'a1', note: '午饭' },
        { id: 't2', date: '2026-11-02', amountCents: 4000, categoryText: '交通', accountId: 'a2', note: '打车' }
      ],
      truncated: false
    };
  }
};

add('只读工具执行', function () {
  var simulate = enhance.runTool('simulateBudget', { month: '2026-11', dailySaveCents: 1000 }, fakeCx);
  check('simulateBudget 可执行', simulate.ok === true);
  eq('simulateBudget 返回数字型预测值', typeof simulate.data.projectedCents, 'number');

  var q = enhance.runTool('queryLedger', { month: '2026-11', type: 'expense' }, fakeCx);
  eq('queryLedger 可执行', q.ok, true);
  eq('queryLedger 明细 ≤8 行', q.data.rows.length <= 8, true);

  var ctx = enhance.runTool('getInsightContext', { month: '2026-11' }, fakeCx);
  eq('getInsightContext 可执行', ctx.ok, true);
  eq('getInsightContext 给出当月合计', ctx.data.totalCents, 2800);
});

add('载荷最小化', function () {
  var built = enhance.buildPayload('这个月餐饮花了多少', { kind: 'hint', text: '本机没完全看懂' }, null, fakeCx, { active: 'modelscope' });
  check('载荷不含账户真名', JSON.stringify(built.payload).indexOf('微信零钱') < 0);
  check('载荷用「账户1」代号', JSON.stringify(built.payload).indexOf('账户1') >= 0);
  eq('未开 sendNote 时不带 rows', built.payload.rows.length, 0);
  check('载荷带分类名', JSON.stringify(built.payload).indexOf('餐饮') >= 0);
  eq('本月支出取到 2800 分', built.payload.thisMonth.expenseCents, 2800);
  check('meta 带 allowed 集合', !!built.meta.allowed && !!built.meta.allowed.cents);
  eq('messages 有 system + user 两条', built.messages.length, 2);
});

/* ---- D14：sendNote=true 时账户代号必须逐行正确（默认关闭，必须显式打开才测得到） ----
   关键：这里必须走**真实** core-assistant.queryTotals。上面 stub 的假行自带 accountId，
   而真实行结构曾经没有这个字段——用 stub 测等于「期望值和实际值同源」，怎么写都绿，
   生产却恒为「账户1」（同源恒真的第三个实例）。 */
add('账户代号映射（D14，走真实 queryTotals）', function () {
  if (!coreAssistant || typeof coreAssistant.queryTotals !== 'function') {
    check('真实 core-assistant 可加载（D14）', false, 'coreAssistant 为空，无法验证真实行结构');
    return;
  }
  var stubQt = global.XZB.core.assistant.queryTotals;
  var realQt = coreAssistant.queryTotals;
  /* 两笔必须都落在本月，真实 queryTotals 才会各出一行（t2 原是 10 月，会被月窗口滤掉） */
  var cx2 = JSON.parse(JSON.stringify(fakeCx));
  cx2.db.transactions[1].date = '2026-11-02';
  var built = null;
  try {
    global.XZB.core.assistant.queryTotals = realQt;
    store.setPref('sendNote', true);
    built = enhance.buildPayload('这个月餐饮花了多少', { kind: 'hint', text: '本机没完全看懂' }, null, cx2, { active: 'modelscope' });
  } finally {
    store.setPref('sendNote', false);
    global.XZB.core.assistant.queryTotals = stubQt;
  }
  eq('真实行数 = 2（两笔都在本月）', built.payload.rows.length, 2);
  /* queryTotals 按日期倒序：11-02（a2）在前、11-01（a1）在后 */
  eq('第一行是账户2（11-02 那笔）', built.payload.rows[0].accountLabel, '账户2');
  eq('第二行是账户1（11-01 那笔）', built.payload.rows[1].accountLabel, '账户1');
  check('载荷里两种账户代号都在', JSON.stringify(built.payload).indexOf('账户2') >= 0);
  /* accountId 只在本地查映射用，绝不能发给模型 */
  check('载荷不携带 accountId 字段', JSON.stringify(built.payload).indexOf('accountId') < 0);
  /* 连带项：模型老实写「账户2」不能被数字守卫当成金额 2 元 → 误杀整段回答 */
  eq('「账户2」不被判幻觉', enhance.guardNumbers('账户2 那笔打车', built.meta.allowed).ok, true);
  eq('不存在的代号「账户9」仍被抓', enhance.guardNumbers('账户9 那笔打车', built.meta.allowed).ok, false);
});

/* ---- D15：数组长度也要进 allowed，否则「你有 7 个分类」会被误判幻觉 ---- */add('数组长度进 allowed（D15）', function () {
  var nums = enhance.collectNumbers({ categories: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  var counts = nums.filter(function (n) { return n.kind === 'count'; }).map(function (n) { return n.value; });
  check('数组长度 7 进入 count 集合', counts.indexOf(7) >= 0, counts.join(','));
  var allowedList = enhance.buildAllowed(nums);
  eq('「你有 7 个分类」不再被判幻觉', enhance.guardNumbers('你有 7 个分类', allowedList).ok, true);
});

/* ---- D16：千分位不能被当成小数点 ---- */
add('千分位金额（D16）', function () {
  var allowedList = enhance.buildAllowed([{ kind: 'cents', value: 123400 }]);
  eq('1,234.00 元 → 123400 分', enhance.guardNumbers('一共 1,234.00 元', allowedList).ok, true);
  eq('¥1,234 无小数 → 123400 分', enhance.guardNumbers('合计 ¥1,234', allowedList).ok, true);
  eq('真幻觉仍被抓（1,234.56）', enhance.guardNumbers('合计 ¥1,234.56', allowedList).ok, false);
});

/* ---- D17：排除词必须进合计，不只是过滤展示行 ---- */
add('排除词进合计（D17）', function () {
  var usable = !!coreAssistant && typeof coreAssistant.queryTotals === 'function';
  check('core-assistant 可在 Node 加载', usable);
  if (!usable) { return; }
  var db = {
    books: [{ id: 'b1', name: '日常' }],
    accounts: [{ id: 'a1', name: '微信', archived: false }],
    categories: [{ id: 'ca_food', name: '餐饮', hidden: false }],
    transactions: [
      { id: 't1', bookId: 'b1', date: '2026-10-05', type: 'expense', amountCents: 2800, categoryId: 'ca_food', accountId: 'a1', note: '外卖' },
      { id: 't2', bookId: 'b1', date: '2026-10-06', type: 'expense', amountCents: 4000, categoryId: 'ca_food', accountId: 'a1', note: '外卖 退款' },
      { id: 't3', bookId: 'b1', date: '2026-10-07', type: 'expense', amountCents: 1200, categoryId: 'ca_food', accountId: 'a1', note: '打车' }
    ],
    settings: { activeBookId: 'b1' }
  };
  var qx = coreAssistant.contextOf({ db: db, bookId: 'b1', today: '2026-11-02' });
  var base = { bookId: 'b1', from: '2026-10-01', to: '2026-10-31', type: 'expense' };
  var withRefund = coreAssistant.queryTotals(qx, base);
  var excluded = coreAssistant.queryTotals(qx, { bookId: 'b1', from: '2026-10-01', to: '2026-10-31', type: 'expense', exclude: '退款' });
  eq('不排除时合计 8000 分', withRefund.expenseCents, 8000);
  eq('排除后退款不进合计', excluded.expenseCents, 4000);
  eq('排除后笔数同步 -1', excluded.count, 2);
  eq('排除后展示行也不含退款那笔', excluded.rows.length, 2);
});

add('exclude 透传到 queryTotals', function () {
  var seen = null;
  var prev = global.XZB.core.assistant;
  global.XZB.core.assistant = {
    queryTotals: function (cx, filter) {
      seen = filter;
      return { count: 0, expenseCents: 0, incomeCents: 0, rows: [], truncated: false };
    }
  };
  enhance.runTool('queryLedger', { month: '2026-11', exclude: '退款' }, fakeCx);
  global.XZB.core.assistant = prev;
  eq('exclude 作为 filter 入参下发', seen && seen.exclude, '退款');
});

/* ---- D18：file:// 下 ready 必须给平台码，而不是 NO_CONSENT ---- */
add('ready 的平台归因（D18）', function () {
  store.grantConsent(store.CONSENT_VERSION);
  store.setKey('modelscope', 'sk-test-key-0000000001');
  global.location = { protocol: 'file:' };
  var gate = enhance.ready(fakeCx);
  delete global.location;
  eq('file:// 下 ready 给 E_AI_FILE_PROTOCOL（而非 E_AI_NO_CONSENT）', gate.code, 'E_AI_FILE_PROTOCOL');
});

add('shouldEnhance 判定', function () {
  eq('clarify 恒不增强', enhance.shouldEnhance({ kind: 'clarify', text: '?' }), false);
  eq('preview 不增强', enhance.shouldEnhance({ kind: 'preview' }), false);
  eq('query 不增强', enhance.shouldEnhance({ kind: 'query' }), false);
  /* 显式退回「未授权」态再验，避免受前面授权用例的残留状态影响 */
  store.revokeConsent();
  eq('hint 但未授权 → 不增强', enhance.shouldEnhance({ kind: 'hint', text: '?' }), false);
  store.grantConsent(store.CONSENT_VERSION);
  eq('hint 且已授权且已配 Key → 增强', enhance.shouldEnhance({ kind: 'hint', text: '?' }), true);
});

add('run 正常路径', function () {
  store.clearAll();
  store.grantConsent(store.CONSENT_VERSION);
  store.setActive('modelscope');
  store.setKey('modelscope', 'sk-test-key-0000000001');
  store.resetUsage();
  client.configure({ fetchImpl: fetchFor('answer'), timeoutScale: 1, streamSupported: null });

  eq('ready 通过', enhance.ready(fakeCx).ok, true);
  eq('hint 且已配置 → 应增强', enhance.shouldEnhance({ kind: 'hint', text: '?' }), true);

  return enhance.run({
    question: '这个月餐饮花了多少',
    localReply: { kind: 'hint', text: '本机没完全看懂' },
    cx: fakeCx
  }).then(function (reply) {
    eq('run 成功 → kind insight', reply.kind, 'insight');
    eq('run 成功 → source remote', reply.source, 'remote');
    eq('run 成功 → 带上供应商名', reply.provider, '魔搭 ModelScope');
    eq('run 成功 → 正文来自模型', reply.text, ANSWER_TEXT);
    eq('run 成功 → 无降级', reply.degrade, null);
    eq('run 成功 → 计一次用量', store.usage().count, 1);
  });
});

add('run 多字段降级', function () {
  client.configure({ fetchImpl: fetchFor('extra'), streamSupported: null });
  return enhance.run({
    question: '这个月餐饮花了多少',
    localReply: { kind: 'hint', text: '本机没完全看懂' },
    cx: fakeCx
  }).then(function (reply) {
    eq('多字段 → 降级码 E_SCHEMA_EXTRA', reply.degrade.code, 'E_SCHEMA_EXTRA');
    eq('多字段 → 保留本地文本', reply.text, '本机没完全看懂');
    eq('多字段 → source 回到 local', reply.source, 'local');
  });
});

add('run 数字幻觉降级', function () {
  client.configure({ fetchImpl: fetchFor('halluc'), streamSupported: null });
  return enhance.run({
    question: '这个月餐饮花了多少',
    localReply: { kind: 'hint', text: '本机没完全看懂' },
    cx: fakeCx
  }).then(function (reply) {
    eq('幻觉 → 降级码 E_NUM_HALLUCINATION', reply.degrade.code, 'E_NUM_HALLUCINATION');
    eq('幻觉 → 不展示模型文本', reply.text, '本机没完全看懂');
    check('幻觉 → 记下命中片段', Object.prototype.toString.call(reply.guardHits) === '[object Array]');
  });
});

add('run 超长降级', function () {
  client.configure({ fetchImpl: fetchFor('huge'), streamSupported: null });
  return enhance.run({
    question: '这个月餐饮花了多少',
    localReply: { kind: 'hint', text: '本机没完全看懂' },
    cx: fakeCx
  }).then(function (reply) {
    eq('超长 → 降级码 E_SCHEMA_LEN', reply.degrade.code, 'E_SCHEMA_LEN');
    eq('超长 → 不展示模型文本', reply.text, '本机没完全看懂');
  });
});

add('工具轮数强杀', function () {
  client.configure({ fetchImpl: fetchFor('tool'), streamSupported: null });
  return enhance.run({
    question: '这个月餐饮花了多少',
    localReply: { kind: 'hint', text: '本机没完全看懂' },
    cx: fakeCx
  }).then(function (reply) {
    eq('工具轮数 → 第 4 轮强杀', reply.degrade.code, 'E_AI_TOOL_ROUNDS');
    eq('工具轮数 → 本地结果不动', reply.text, '本机没完全看懂');
  });
});

add('额度耗尽', function () {
  store.resetUsage();
  var limit = store.usage().limit;
  for (var i = 0; i < limit; i += 1) {
    store.bumpUsage({ providerId: 'modelscope', ok: true, firstByteMs: 1, counted: true });
  }
  eq('额度耗尽后 ready 为假', enhance.ready(fakeCx).ok, false);
  eq('额度耗尽 → E_AI_QUOTA', enhance.ready(fakeCx).code, 'E_AI_QUOTA');
  return enhance.run({
    question: '这个月餐饮花了多少',
    localReply: { kind: 'hint', text: '本机没完全看懂' },
    cx: fakeCx
  }).then(function (reply) {
    eq('额度耗尽 → 直接降级不发请求', reply.degrade.code, 'E_AI_QUOTA');
  });
});

/* ============================== 收尾 ============================== */

runQueue().then(function () {
  section('结果');
  process.stdout.write('通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  if (fail) {
    failures.forEach(function (item) { process.stdout.write('  ✗ ' + item + '\n'); });
    process.exitCode = 1;
    return;
  }
  process.stdout.write('全部通过。\n');
}, function (error) {
  process.stdout.write('自检异常中断：' + (error && error.message ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
