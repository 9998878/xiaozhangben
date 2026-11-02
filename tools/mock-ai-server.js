#!/usr/bin/env node
/* ============================================================================
   小账本 2.0 · tools/mock-ai-server.js · owner: 助手（T03，开发期资产）
   用途：在没有任何真实 API Key 的情况下，把 ai-client / ai-enhance 的 9 种故障路径跑通。

   约束（违反即破坏架构 §13.3 的 grep 口径）：
     - 只用 node:http，**不用 fetch**、不用 XMLHttpRequest；
     - 0 依赖；不进 PRECACHE；不被任何 chunk 引用；不参与 checkSync。
   启动：node tools/mock-ai-server.js --port 8787 --mode ok

   模式（--mode 指定默认值；也可用假 Key 前缀逐请求切换，便于同一实例跑多用例）：
     Authorization: Bearer sk-mode-401       → 401
     Authorization: Bearer mode:nonstream    → 非流式

   ok         合法 t:"answer" JSON，SSE 分 5 块吐出（默认）
   nonstream  非流式：200 + 整段 JSON
   401/403    认证失败
   402/429    额度/限流，带 Retry-After: 30
   500        供应商故障
   slow       首块延迟 9s（验 E_AI_TIMEOUT_FIRST）
   stall      首块秒出、之后每 3s 一块共 10 块（验停止与 25s 整轮超时）
   cors       所有响应（含 OPTIONS 预检）都不带 Access-Control-Allow-*（模拟未放行跨域）
   badjson    data 截断成半包 JSON
   huge       text 长 2000 字（验 E_SCHEMA_LEN 不截断）
   extra      合法答案 + 多一个 hint 字段（验 E_SCHEMA_EXTRA）
   halluc     text 里写「一共 ¥888.88」（验数字守卫）
   tool       先回 t:"tool" × 5（验第 4 轮强杀 E_AI_TOOL_ROUNDS）
   ============================================================================ */
'use strict';

var http = require('http');

/* ---------------------------- 参数解析 ---------------------------- */

function argOf(name, fallback) {
  var argv = process.argv.slice(2);
  for (var i = 0; i < argv.length; i += 1) {
    var item = argv[i];
    if (item === '--' + name && argv[i + 1]) { return argv[i + 1]; }
    if (item.indexOf('--' + name + '=') === 0) { return item.slice(name.length + 3); }
  }
  return fallback;
}

var DEFAULT_PORT = Number(argOf('port', 8787)) || 8787;
var DEFAULT_MODE = String(argOf('mode', 'ok')).toLowerCase();

/* ---------------------------- 模式内容 ---------------------------- */

/* 正文一律不含数字：这样 ok/extra/nonstream 在真实载荷下也能过数字守卫，
   要验守卫就显式用 halluc 模式。 */
var ANSWER_TEXT = '本月的账我看过了，支出结构和上个月接近，主要变化在你花得最多的那几类里。';
var TOOL_TEXT = '我需要先查一下明细再回答。';

function answerJson(extra, isExplain) {
  /* explain 契约（SPEC_EXPLAIN）只收 t/text/confidence 三字段；
     run 的 SPEC_ANSWER 要求 refs/evidence。按 system prompt 特征分流，
     探针必须复现运行时，不能让一个 mock 报文伺候两个 Schema。 */
  if (isExplain) { return JSON.stringify({ t: 'answer', text: ANSWER_TEXT, confidence: 'ok' }); }
  var obj = { t: 'answer', text: ANSWER_TEXT, refs: [], evidence: [], confidence: 'ok' };
  if (extra) { obj.hint = '多出来的字段'; }
  return JSON.stringify(obj);
}

function modeBody(mode, isExplain) {
  if (mode === 'huge') {
    var long = '';
    for (var i = 0; i < 200; i += 1) { long += '这一段是用来测试超长回答会不会被截断的说明文字'; }
    return JSON.stringify({ t: 'answer', text: long.slice(0, 2000), refs: [], confidence: 'ok' });
  }
  if (mode === 'halluc') {
    return JSON.stringify({ t: 'answer', text: '这次一共 ¥888.88，比上月多花了不少。', refs: [], confidence: 'ok' });
  }
  if (mode === 'extra') { return answerJson(true); }
  if (mode === 'tool') {
    return JSON.stringify({ t: 'tool', name: 'queryLedger', args: { month: '2026-11', type: 'expense' }, n: 1 });
  }
  return answerJson(false, isExplain);
}

/* 把一段文本切成 n 片，用于模拟 SSE 增量 */
function splitPieces(text, count) {
  var pieces = [];
  var size = Math.ceil(text.length / count);
  for (var i = 0; i < text.length; i += size) { pieces.push(text.slice(i, i + size)); }
  return pieces.length ? pieces : [''];
}

function sseChunk(content) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: content } }] }) + '\n\n';
}

/* ---------------------------- 响应头 ---------------------------- */

/* 除 cors 模式外，一律放行跨域，模拟「已放行 CORS 的供应商」 */
function corsHeaders(mode) {
  var headers = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' };
  if (mode === 'cors') { return headers; }
  headers['Access-Control-Allow-Origin'] = '*';
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'authorization, content-type';
  headers['Access-Control-Max-Age'] = '600';
  return headers;
}

function modeOf(req) {
  var auth = String(req.headers.authorization || '');
  var match = /mode[:\-]([a-z0-9]+)/i.exec(auth);
  return match ? match[1].toLowerCase() : DEFAULT_MODE;
}

/* ---------------------------- 处理器 ---------------------------- */

function sendJson(res, status, payload, mode, extraHeaders) {
  var headers = corsHeaders(mode);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  if (extraHeaders) {
    Object.keys(extraHeaders).forEach(function (key) { headers[key] = extraHeaders[key]; });
  }
  var body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, headers);
  res.end(body);
}

function handleChat(req, res, mode, bodyText) {
  var headers = corsHeaders(mode);
  headers['Content-Type'] = mode === 'nonstream' ? 'application/json; charset=utf-8' : 'text/event-stream; charset=utf-8';

  if (mode === '401' || mode === '402' || mode === '403' || mode === '429' || mode === '500') {
    var status = Number(mode);
    sendJson(res, status, { error: { message: 'mock ' + mode } }, mode, mode === '429' || mode === '402' ? { 'Retry-After': '30' } : null);
    return;
  }

  if (mode === 'nonstream') {
    sendJson(res, 200, { choices: [{ message: { content: modeBody('ok', false) } }], usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 } }, mode);
    return;
  }

  res.writeHead(200, headers);

  /* 请求体里带「换一种更自然的中文说法」= explain 契约（三字段应答）。
     探针按运行时分流，别让一份报文伺候两个 Schema。bodyText 由路由层传入
     （请求体在那里已读完，这里再挂 req 事件永远不会触发）。 */
  var isExplain = String(bodyText || '').indexOf('换一种更自然的中文说法') >= 0;

  if (mode === 'slow') {
    /* 9s 才吐第一块：浏览器侧 8s 首字节计时先触发 */
    setTimeout(function () {
      res.write(sseChunk(modeBody('ok', isExplain)));
      res.write('data: [DONE]\n\n');
      res.end();
    }, 9000);
    return;
  }

  if (mode === 'stall') {
    res.write(sseChunk(''));
    var sent = 0;
    var stallTimer = setInterval(function () {
      sent += 1;
      if (sent > 10) {
        clearInterval(stallTimer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(sseChunk('正在查看你这边的账目…'));
    }, 3000);
    /* 监听 res 而不是 req：请求体读完 req 就会 close，用它当断线信号会把定时器提前清掉 */
    res.on('close', function () { clearInterval(stallTimer); });
    return;
  }

  if (mode === 'badjson') {
    /* 半包 JSON：客户端应丢掉该块并最终判 E_AI_BAD_ENVELOPE */
    res.write('data: {"choices":[{"delta":{"content":"{\\"t\\":\\"answer\\",\\"text\\":"}}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (mode === 'tool') {
    /* 连续多轮都回 tool：客户端第 4 轮应强杀 E_AI_TOOL_ROUNDS */
    res.write(sseChunk(modeBody('tool')));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (mode === 'dirty') {
    /* 唯一能在本地复现全部「脏形态」的用例（架构 §13.2）：
       : keep-alive 注释行 / event: + id: 行 / 一行两个 data: / data: 后带空格 /
       畸形 JSON 行 / 多字节中文被按字节切半 / 末帧**不带**尾随换行（验残余 buffer）。
       预期客户端拼出的正文恰好是「本月支出稳定完成」，且整轮不报错。 */
    var dirtyParts = [
      ': keep-alive\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '本月' } }] }) + '\n\n',
      'event: ping\nid: 7\ndata:' + JSON.stringify({ choices: [{ delta: { content: '支出' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '稳定' } }] }) + '\n\n',
      'data: {"choices":[{"delta":{"content":"X"}}]} data: {"choices":[{"delta":{"content":"Y"}}]}\n\n',
      'data: {oops\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '完成' } }] })
    ];
    var dirtyBuf = Buffer.from(dirtyParts.join(''), 'utf8');
    var step = 7;
    (function writeFrom(offset) {
      if (res.writableEnded) { return; }
      if (offset >= dirtyBuf.length) { res.end(); return; }
      /* 每次只写 7 字节：必然把中文切在 UTF-8 字节中间，验 decoder.decode(..., {stream:true}) */
      res.write(dirtyBuf.slice(offset, offset + step));
      setTimeout(function () { writeFrom(offset + step); }, 5);
    })(0);
    return;
  }

  /* 常规 SSE：正文分 5 块吐出 */
  var pieces = splitPieces(modeBody(mode, isExplain), 5);
  var index = 0;
  var pump = setInterval(function () {
    if (index >= pieces.length) {
      clearInterval(pump);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(sseChunk(pieces[index]));
    index += 1;
  }, 40);
  /* 监听 res 而不是 req：请求体读完 req 就会 close，用它当断线信号会把定时器提前清掉 */
  res.on('close', function () { clearInterval(pump); });
}

var server = http.createServer(function (req, res) {
  var mode = modeOf(req);

  if (req.method === 'OPTIONS') {
    /* cors 模式故意不返回任何 Access-Control-Allow-*：预检被浏览器拦下 */
    res.writeHead(204, corsHeaders(mode));
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'only POST' } }, mode);
    return;
  }

  /* 读取请求体（供 explain 分流），读走避免连接挂住 */
  var bodyParts = [];
  req.on('data', function (c) { bodyParts.push(c); });
  req.on('end', function () {
    handleChat(req, res, mode, Buffer.concat(bodyParts).toString('utf8'));
  });
});

server.listen(DEFAULT_PORT, '127.0.0.1', function () {
  var addr = server.address();
  process.stdout.write('[mock-ai] listening http://127.0.0.1:' + addr.port + ' 默认模式=' + DEFAULT_MODE + '\n');
  process.stdout.write('[mock-ai] 切换模式：Authorization: Bearer sk-mode-<模式名>\n');
  process.stdout.write('[mock-ai] 可用模式：ok nonstream 401 402 403 429 500 slow stall cors badjson dirty huge extra halluc tool\n');
});
