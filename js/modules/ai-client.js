/* ============================================================================
   小账本 2.0 · js/modules/ai-client.js · owner: 助手（T03）
   文件：js/modules/ai-client.js
   挂载：window.XZB.core.aiClient（Node 下可 require，便于无浏览器单测）
   依赖：无（不碰 DOM、不碰存储、不含业务判断）

   契约锚点：
     - **全仓唯一的网络出口**：本文件是 index.html + js/** 里唯一允许出现 fetch 的地方。
       不发请求给本域任何地址（无网关、无代理、无 telemetry）。
     - Key 只进 Authorization header；永不进 URL / body / query（自定义供应商也不支持 ?key=）。
     - 返回的错误对象只含 { code, status, retryAfterMs }；不含 headers、不含 request body、不含 Key。
     - 可注入 fetchImpl / now / timeoutScale / streamSupported / setTimeoutImpl（架构 §13.1），
       注入后完全不发真实网络请求，供 Node 单测覆盖 9 种故障模式。
     - 任何失败都以 resolve({ ok:false, code }) 返回，**绝不 reject**；
       调用方只需读 code，不需要包 try/catch。

   URL 规范化（架构 §4.1.1）：baseUrl 去尾斜杠后拼 /chat/completions；已含则不重复追加。
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var core = XZB.core || (XZB.core = XZB.Core = XZB.Core || XZB.core || {});

  /* ============================== 常量 ============================== */

  /* 首字节 8s（架构 §8.4）。连接测试 10s（§10.3）。整轮 25s 由 ai-enhance 计时。 */
  var T_FIRST_BYTE = 8000;
  var T_TEST = 10000;
  /* fetch reject 且耗时小于该值、且浏览器自称在线 → 判为 CORS/地址错（架构 §3.2） */
  var CORS_FAST_MS = 2000;
  /* 单次响应文本保护上限：超过即视为供应商返回了非预期内容 */
  var MAX_RAW = 2 * 1024 * 1024;

  var E = {
    NO_KEY: 'E_AI_NO_KEY',
    NO_CONSENT: 'E_AI_NO_CONSENT',
    FILE_PROTOCOL: 'E_AI_FILE_PROTOCOL',
    NET: 'E_AI_NET',
    CORS: 'E_AI_CORS',
    TIMEOUT_FIRST: 'E_AI_TIMEOUT_FIRST',
    TIMEOUT_TOTAL: 'E_AI_TIMEOUT_TOTAL',
    ABORTED: 'E_AI_ABORTED',
    E401: 'E_AI_401',
    E403: 'E_AI_403',
    E402: 'E_AI_402',
    E429: 'E_AI_429',
    /* 400/404 与 5xx 的处置完全不同：400 多是模型名错或没有免费额度，404 是 Base URL 路径错。
       若都归成 E_AI_BAD_ENVELOPE，用户永远改不好配置。 */
    BAD_REQUEST: 'E_AI_BAD_REQUEST',
    NOT_FOUND: 'E_AI_NOT_FOUND',
    E5XX: 'E_AI_5XX',
    BAD_ENVELOPE: 'E_AI_BAD_ENVELOPE',
    NO_STREAM: 'E_AI_NO_STREAM'
  };

  /* ============================== 注入点 ============================== */

  var CONF = {
    fetchImpl: null,
    now: null,
    timeoutScale: 1,
    /* null = 自动探测；true/false 显式覆盖（单测验 E_AI_NO_STREAM 分支） */
    streamSupported: null,
    setTimeoutImpl: null
  };

  var state = {
    ctl: null,
    meta: { status: 0, ms: 0, bytes: 0, model: '' }
  };

  function configure(options) {
    var o = options || {};
    if (o.fetchImpl !== undefined) { CONF.fetchImpl = o.fetchImpl; }
    if (typeof o.now === 'function') { CONF.now = o.now; }
    if (typeof o.timeoutScale === 'number' && o.timeoutScale > 0) { CONF.timeoutScale = o.timeoutScale; }
    if (o.streamSupported === true || o.streamSupported === false || o.streamSupported === null) {
      CONF.streamSupported = o.streamSupported;
    }
    if (o.setTimeoutImpl) { CONF.setTimeoutImpl = o.setTimeoutImpl; }
  }

  /* ============================== 基础工具 ============================== */

  function str(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function assign(target, source) {
    var t = target || {};
    if (!source) { return t; }
    Object.keys(source).forEach(function (key) { t[key] = source[key]; });
    return t;
  }

  function nowMs() {
    if (typeof CONF.now === 'function') {
      try { return Number(CONF.now()) || 0; } catch (error) { /* 注入时钟坏了不能崩 */ }
    }
    return Date.now();
  }

  function setTimer(fn, ms) {
    var impl = CONF.setTimeoutImpl || (typeof global.setTimeout === 'function' ? global.setTimeout : null);
    if (!impl) { return null; }
    return impl(fn, ms);
  }

  function clearTimer(handle) {
    var impl = global.clearTimeout;
    if (handle && typeof impl === 'function') { impl(handle); }
  }

  function scaled(ms) {
    var scale = Number(CONF.timeoutScale);
    if (!isFinite(scale) || scale <= 0) { scale = 1; }
    return Math.max(1, Math.round(ms * scale));
  }

  function fetchOf() {
    if (typeof CONF.fetchImpl === 'function') { return CONF.fetchImpl; }
    return typeof global.fetch === 'function' ? global.fetch : null;
  }

  function AbortControllerOf() {
    return typeof global.AbortController === 'function' ? global.AbortController : null;
  }

  function fileProtocol() {
    try {
      return typeof global.location !== 'undefined' && global.location && global.location.protocol === 'file:';
    } catch (error) {
      return false;
    }
  }

  function online() {
    try {
      if (global.navigator && global.navigator.onLine === false) { return false; }
    } catch (error) { /* 读不到按在线处理 */ }
    return true;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (error) { return null; }
  }

  /* 去掉模型爱加的 ```json 围栏与首尾空白（架构 §5 统一外层） */
  function stripFences(text) {
    var s = str(text).trim();
    s = s.replace(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/, '');
    s = s.replace(/```[ \t]*$/, '');
    return s.trim();
  }

  /* URL 规范化：去尾斜杠 → 补 /chat/completions；只接受 http(s) */
  function chatUrl(baseUrl) {
    var base = str(baseUrl).trim();
    if (!base) { return ''; }
    if (!/^https?:\/\//i.test(base)) { return ''; }
    base = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) { return base; }
    return base + '/chat/completions';
  }

  /* ============================== 能力探测 ============================== */

  /* 静态探测：stream 只是「大概率可用」，真正以响应对象上有没有 body.getReader 为准 */
  function probe() {
    var decoder = typeof global.TextDecoder === 'function';
    var stream = decoder && (typeof global.ReadableStream !== 'undefined' || typeof global.fetch === 'function');
    if (CONF.streamSupported === false) { stream = false; }
    if (CONF.streamSupported === true) { stream = true; }
    return {
      stream: !!stream,
      fetch: typeof fetchOf() === 'function',
      abort: !!AbortControllerOf()
    };
  }

  /* AbortController 缺失时（老 iOS / Node）回落到可轮询的假控制器（架构 §8.4） */
  function abortHandle() {
    var AC = AbortControllerOf();
    if (AC) {
      try { return new AC(); } catch (error) { /* 落到假控制器 */ }
    }
    return {
      aborted: false,
      signal: null,
      abort: function () { this.aborted = true; }
    };
  }

  function abort() {
    var ctl = state.ctl;
    if (!ctl) { return; }
    try { ctl.abort(); } catch (error) { /* 已经结束 */ }
  }

  function lastMeta() {
    /* 只含元信息：不含 header、不含 body、不含 Key */
    return {
      status: state.meta.status,
      ms: state.meta.ms,
      bytes: state.meta.bytes,
      model: state.meta.model
    };
  }

  /* ============================== 响应解析 ============================== */

  function contentOf(obj) {
    if (!obj || typeof obj !== 'object') { return ''; }
    var choices = obj.choices;
    if (!choices || !choices.length) { return ''; }
    var first = choices[0] || {};
    var msg = first.delta || first.message || null;
    if (!msg) { return ''; }
    var c = msg.content;
    if (typeof c === 'string') { return c; }
    /* 部分供应商返回分段数组 [{type:'text',text:'…'}] */
    if (Object.prototype.toString.call(c) === '[object Array]') {
      var out = '';
      for (var i = 0; i < c.length; i += 1) {
        var part = c[i];
        if (typeof part === 'string') { out += part; }
        else if (part && typeof part.text === 'string') { out += part.text; }
      }
      return out;
    }
    return '';
  }

  function readUsage(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    return {
      prompt: Math.max(0, Math.round(Number(raw.prompt_tokens) || 0)),
      completion: Math.max(0, Math.round(Number(raw.completion_tokens) || 0)),
      total: Math.max(0, Math.round(Number(raw.total_tokens) || 0))
    };
  }

  function retryAfterMs(res) {    var raw = '';
    try {
      raw = res && res.headers && typeof res.headers.get === 'function' ? str(res.headers.get('Retry-After')) : '';
    } catch (error) { raw = ''; }
    if (!raw) { return 0; }
    var seconds = Number(raw);
    if (isFinite(seconds) && seconds > 0) { return Math.round(seconds * 1000); }
    var at = Date.parse(raw);
    if (isFinite(at)) { return Math.max(0, at - nowMs()); }
    return 0;
  }

  function statusCode(code, status) {
    if (status === 400) { return E.BAD_REQUEST; }
    if (status === 404) { return E.NOT_FOUND; }
    if (status === 401) { return E.E401; }
    if (status === 403) { return E.E403; }
    if (status === 402) { return E.E402; }
    if (status === 429) { return E.E429; }
    if (status >= 500) { return E.E5XX; }
    return code;
  }

  /* ============================== 请求体 ============================== */

  function buildBody(req) {
    var body = {
      model: str(req.provider && req.provider.model),
      messages: Object.prototype.toString.call(req.messages) === '[object Array]' ? req.messages : [],
      stream: req.stream !== false,
      max_tokens: Math.max(1, Math.round(Number(req.maxTokens) || 512)),
      temperature: typeof req.temperature === 'number' ? req.temperature : 0.2
    };
    /* 只在调用方明确要求时才带 response_format：部分免费型号见到它会 400 */
    if (req.jsonMode === true) { body.response_format = { type: 'json_object' }; }
    return body;
  }

  /* SSE **按行**解析（架构 §8.5）。绝不能按 \n\n 切事件块 —— 那样心跳注释行、
     一行多个 data:、data: 后带空格 三种脏形态会分别表现为「答到一半停住」「只出前几个字」
     「整段空白」，且本地规整的 mock 测不出来。规则：
       · 空行、以 ':' 开头的注释/心跳行 → 丢弃
       · 只认以 'data:' 开头的行；event: / id: / retry: 一律忽略
       · payload = 该行 slice(5) 后只 trimStart（尾随空格是有效内容，不能 trim）
       · payload === '[DONE]' → 标记结束
       · 单行 JSON 解析失败 → 记录后跳过，**不中止整轮**（保留已经流出来的内容）
       · 一行里出现多个 'data:' → 按第一个 'data:' 之后整段当负载；解析失败即跳过该行
     结果写进 sink，由调用方决定何时收口。 */
  /* 只去左侧空白：尾随空格是有效内容（D4）。trimStart 有 ES5 兜底，老 Safari 也能跑 */
  function trimLeft(text) {
    var s = str(text);
    return typeof s.trimStart === 'function' ? s.trimStart() : s.replace(/^[\s\u00a0\u3000]+/, '');
  }

  function parseSseLines(lines, sink) {
    var out = sink || { done: false, content: '', usage: null, bad: 0 };
    var list = Object.prototype.toString.call(lines) === '[object Array]' ? lines : [];
    for (var i = 0; i < list.length; i += 1) {
      var line = str(list[i]).replace(/\r$/, '');
      var head = trimLeft(line);
      if (!head) { continue; }
      if (head.charAt(0) === ':') { continue; }
      if (head.indexOf('data:') !== 0) { continue; }
      var payload = trimLeft(head.slice(5));
      if (!payload) { continue; }
      if (payload === '[DONE]') { out.done = true; continue; }
      var obj = safeParse(payload);
      if (!obj) { out.bad += 1; continue; }
      if (obj.usage) { out.usage = readUsage(obj.usage); }
      out.content += contentOf(obj);
    }
    return out;
  }

  /* 整段文本按行解一遍（非流式 / 无 getReader 的退化路径共用） */
  function parseSseText(text, sink) {
    return parseSseLines(str(text).split(/\n/), sink);
  }

  /* ============================== 唯一网络调用 ============================== */

  function chat(req, handlers) {
    var h = handlers || {};
    var request = req || {};
    var provider = request.provider || {};
    var startedAt = nowMs();
    var url = chatUrl(provider.baseUrl);

    var settled = false;
    /* 调用方可以先建一个句柄（session.ai.ctl）再传进来，这样「停止」与「整轮超时」能共用同一次中止 */
    var ctl = request.ctl && typeof request.ctl.abort === 'function' ? request.ctl : abortHandle();
    var firstTimer = null;
    var firstByteGot = false;
    var bytes = 0;
    var usage = null;
    var collected = '';
    var status = 0;

    state.ctl = ctl;

    function snapshot(extra) {
      var m = {
        status: status,
        ms: Math.max(0, Math.round(nowMs() - startedAt)),
        bytes: bytes,
        model: str(provider.model)
      };
      state.meta = m;
      return extra ? assign(m, extra) : m;
    }

    return new Promise(function (resolve) {
      function cleanup() {
        if (firstTimer) { clearTimer(firstTimer); firstTimer = null; }
        state.ctl = null;
      }

      function settle(payload) {
        if (settled) { return; }
        settled = true;
        cleanup();
        snapshot();
        var out = {
          ok: payload.ok === true,
          code: str(payload.code) || (payload.ok === true ? 'OK' : E.NET),
          text: str(payload.text),
          usage: payload.usage || null,
          status: status,
          retryAfterMs: Math.max(0, Math.round(Number(payload.retryAfterMs) || 0))
        };
        resolve(out);
        try {
          if (out.ok) {
            if (typeof h.onDone === 'function') { h.onDone(out); }
          } else if (typeof h.onError === 'function') {
            h.onError(out);
          }
        } catch (error) { /* 回调不得反向影响结果 */ }
      }

      function fail(code, extra) {
        settle(assign({ ok: false, code: statusCode(code, status) }, extra));
      }

      function noteFirstByte() {
        if (firstByteGot) { return; }
        firstByteGot = true;
        if (firstTimer) { clearTimer(firstTimer); firstTimer = null; }
        try {
          if (typeof h.onFirstByte === 'function') { h.onFirstByte({ ms: Math.max(0, Math.round(nowMs() - startedAt)) }); }
        } catch (error) { /* 忽略 */ }
      }

      function emitDelta(delta) {
        if (!delta) { return; }
        collected += delta;
        try {
          if (typeof h.onDelta === 'function') { h.onDelta(delta, collected); }
        } catch (error) { /* 忽略 */ }
      }

      /* ---- 前置校验：都发生在发请求之前，绝不产生网络流量 ---- */
      if (!str(provider.key)) { fail(E.NO_KEY); return; }
      if (fileProtocol()) { fail(E.FILE_PROTOCOL); return; }
      if (!url) { fail(E.CORS); return; }  /* 地址空/非法：文案与 CORS 共用「地址填错了」 */
      var doFetch = fetchOf();
      if (typeof doFetch !== 'function') { fail(E.NET); return; }

      /* 首字节计时从「发起请求」就开始，DNS 卡住也能按时收口 */
      var firstBudget = Math.max(1, Math.round(Number(request.timeoutFirst) || T_FIRST_BYTE));
      firstTimer = setTimer(function () {
        if (settled) { return; }
        try { ctl.abort(); } catch (error) { /* 已结束 */ }
        fail(E.TIMEOUT_FIRST);
      }, scaled(firstBudget));

      var init = {
        method: 'POST',
        headers: {
          /* 恰好 3 个头，全是 CORS-safelisted 或在 Allow-Headers 白名单里的常见项。
             不要加 HTTP-Referer / X-Title（OpenRouter 可选标头）：每多一个非简单头
             就多一个预检变量，某家 Allow-Headers 没列它就整站失败。Key 只出现在这里（架构 §3.2）。 */
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: 'Bearer ' + str(provider.key)
        },
        body: JSON.stringify(buildBody(request))
      };
      if (ctl.signal) { init.signal = ctl.signal; }

      var promise;
      try {
        promise = doFetch(url, init);
      } catch (error) {
        fail(nowMs() - startedAt < CORS_FAST_MS ? E.CORS : E.NET);
        return;
      }

      Promise.resolve(promise).then(function (res) {
        if (settled) { return; }
        status = Math.max(0, Math.round(Number(res && res.status) || 0));
        /* 400/404 单独归因：一个是「模型名/额度」，一个是「路径」，文案与修法完全不同 */
        if (status === 400) { fail(E.BAD_REQUEST); return; }
        if (status === 404) { fail(E.NOT_FOUND); return; }
        if (status === 401 || status === 403 || status === 402 || status === 429 || status >= 500) {
          fail(E.NET, { retryAfterMs: retryAfterMs(res) });
          return;
        }
        if (res && res.ok === false) { fail(E.BAD_ENVELOPE); return; }
        readResponse(res);
      }, function () {
        if (settled) { return; }
        if (ctl.aborted) { fail(E.ABORTED); return; }
        /* 启发式：请求几乎立刻失败且浏览器自称在线 → 大概率是跨域被拦（架构 §3.2） */
        fail(online() && nowMs() - startedAt < CORS_FAST_MS ? E.CORS : E.NET);
      });

      function readResponse(res) {
        var reader = null;
        if (CONF.streamSupported !== false && typeof global.TextDecoder === 'function') {
          try {
            reader = res && res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
          } catch (error) { reader = null; }
        }
        if (!reader) { readWhole(res, true); return; }
        pumpStream(reader);
      }

      /* 无 body.getReader（老 iOS）/ 显式禁用流式：整段读完再一次性吐（架构 §3.2 E_AI_NO_STREAM） */
      function readWhole(res, wasStream) {
        var textPromise;
        try {
          textPromise = res && typeof res.text === 'function' ? res.text() : Promise.resolve('');
        } catch (error) {
          textPromise = Promise.resolve('');
        }
        Promise.resolve(textPromise).then(function (raw) {
          if (settled) { return; }
          var body = str(raw);
          bytes = body.length;
          if (body.length > MAX_RAW) { fail(E.BAD_ENVELOPE); return; }
          collected = '';
          if (body.indexOf('data:') >= 0) {
            /* 供应商无视 stream:false 仍返回 SSE：按行解一遍（与流式共用同一份规则） */
            var sink = parseSseText(body, null);
            if (sink.usage) { usage = sink.usage; }
            collected = sink.content;
          } else {
            var obj = safeParse(body);
            if (!obj) { fail(E.BAD_ENVELOPE); return; }
            if (obj.usage) { usage = readUsage(obj.usage); }
            collected = contentOf(obj);
          }
          if (!collected) { fail(E.BAD_ENVELOPE); return; }
          noteFirstByte();
          /* 整段模式只回调一次；这里不能走 emitDelta（那会再累加进 collected 造成重复正文） */
          try {
            if (typeof h.onDelta === 'function') { h.onDelta(collected, collected); }
          } catch (error) { /* 忽略 */ }
          settle({ ok: true, code: wasStream ? E.NO_STREAM : 'OK', text: stripFences(collected), usage: usage });
        }, function () {
          if (!settled) { fail(E.NET); }
        });
      }

      /* 流式读取：TextDecoder 整个请求复用一个（**不**每块 new），decode 必带 {stream:true}，
         否则多字节中文在 chunk 边界被切半，表现为「长回答里夹乱码」而短回答测不出来。 */
      function pumpStream(reader) {
        var decoder = new global.TextDecoder('utf-8');
        var buffer = '';
        var doneSeen = false;
        var badLines = 0;

        function cancelReader() {
          /* [DONE] 之后必须 cancel：有些网关不主动断连接，不 cancel 会一直挂到 25s 整轮超时 */
          try { if (reader && typeof reader.cancel === 'function') { reader.cancel(); } } catch (error) { /* 已关闭 */ }
        }

        /* 按 \n 切行；最后一段不完整的行留在 buffer 里跨 chunk 续行。final=true 时连残余一起消费 */
        function flushLines(final) {
          var lines = [];
          var index = buffer.indexOf('\n');
          while (index >= 0) {
            lines.push(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
          }
          if (final && buffer.length) { lines.push(buffer); buffer = ''; }
          if (!lines.length) { return; }
          var sink = parseSseLines(lines, null);
          if (sink.usage) { usage = sink.usage; }
          badLines += sink.bad;
          if (sink.done) { doneSeen = true; }
          if (sink.content) {
            noteFirstByte();
            emitDelta(sink.content);
          }
        }

        /* 收口：settle 自身幂等（第一次生效后直接 return），D2/D3 一起改时不会撞车 */
        function finish(code) {
          if (settled) { return; }
          if (!collected) { fail(E.BAD_ENVELOPE); return; }
          settle({ ok: true, code: code || 'OK', text: stripFences(collected), usage: usage });
        }

        function afterFlush() {
          if (settled) { return; }
          if (doneSeen) { cancelReader(); finish('OK'); return; }
          next();
        }

        function next() {
          if (settled) { return; }
          if (ctl.aborted) { fail(E.ABORTED); return; }
          var reading;
          try { reading = reader.read(); } catch (error) { fail(E.NET); return; }
          Promise.resolve(reading).then(function (chunk) {
            if (settled) { return; }
            if (!chunk || chunk.done) {
              /* 末帧常常不带尾随换行：残余 buffer 必须再解一次，否则最后一个字静默丢失 */
              flushLines(true);
              if (settled) { return; }
              cancelReader();
              /* [DONE] 缺失（有些网关直接断流）当正常完成，不报 E_AI_BAD_ENVELOPE */
              finish('OK');
              return;
            }
            var piece = chunk.value;
            if (piece && typeof piece.length === 'number') {
              bytes += piece.length;
              if (bytes > MAX_RAW) { fail(E.BAD_ENVELOPE); return; }
            }
            var decoded = '';
            try { decoded = decoder.decode(piece, { stream: true }); } catch (error) { decoded = ''; }
            buffer += decoded;
            flushLines(false);
            afterFlush();
          }, function () {
            if (settled) { return; }
            fail(ctl.aborted ? E.ABORTED : E.NET);
          });
        }

        next();
      }
    });
  }

  /* ============================== 连接测试 ============================== */

  /* 发 1 次真实极小请求（max_tokens:8）；10s 硬超时；不计入小账本每日额度（由调用方决定）
     opts.signal 支持外部 AbortSignal：被中止时本次测试按 E_AI_ABORTED 结束 */
  function test(provider, options) {
    var opts = options || {};
    var startedAt = nowMs();
    var p = provider || {};
    if (!str(p.key)) { return Promise.resolve({ ok: false, code: E.NO_KEY, ms: 0, status: 0 }); }
    if (fileProtocol()) { return Promise.resolve({ ok: false, code: E.FILE_PROTOCOL, ms: 0, status: 0 }); }

    var ctl = abortHandle();
    var external = opts.signal;
    if (external) {
      if (external.aborted === true) { return Promise.resolve({ ok: false, code: E.ABORTED, ms: 0, status: 0 }); }
      try {
        if (typeof external.addEventListener === 'function') {
          external.addEventListener('abort', function () { try { ctl.abort(); } catch (error) { /* 忽略 */ } });
        }
      } catch (error) { /* 老浏览器没有 addEventListener 就只靠超时收口 */ }
    }

    return chat({
      provider: p,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      stream: false,
      timeoutFirst: T_TEST,
      temperature: 0,
      ctl: ctl
    }, {}).then(function (res) {
      return {
        ok: res.ok === true,
        code: res.ok === true ? 'OK' : res.code,
        ms: Math.max(0, Math.round(nowMs() - startedAt)),
        status: res.status || 0
      };
    });
  }

  /* ============================== 导出 ============================== */

  var api = {
    configure: configure,
    probe: probe,
    test: test,
    chat: chat,
    abort: abort,
    abortHandle: abortHandle,
    lastMeta: lastMeta,

    /* 纯函数外露（供 ai-enhance 与单测复用，不产生副作用） */
    chatUrl: chatUrl,
    stripFences: stripFences,
    contentOf: contentOf,
    parseSseLines: parseSseLines,

    E: E,
    T_FIRST_BYTE: T_FIRST_BYTE,
    T_TEST: T_TEST
  };

  core.aiClient = api;
  if (XZB.core && XZB.core !== core) { XZB.core.aiClient = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
