#!/usr/bin/env node
/* ============================================================================
   小账本 2.0 · tools/cdp-driver.js · owner: QA（T-QA01，开发期资产）
   用途：零依赖 CDP 驱动。Node ≥22 自带全局 WebSocket 与 fetch，故**不需要 npm install**
        ——仓库刻意没有 package.json，一旦出现 node_modules，后来者会顺手往 js/ 里
        import 第三方包，而 sw.js 的 PRECACHE 不认识 node_modules，线上直接 404。

   能力（证据表 §1「H 类驱动口径」的 6 项 + 4 项便于断言的小工具）：
     ① spawnChrome + 就绪探测      ② WebSocket 连 target
     ③ Page.navigate + load 等待   ④ Runtime.evaluate（含 Promise 展开、错误抛出）
     ⑤ Input.insertText（聚焦+清空）⑥ Network.requestWillBeSent 累计与按 origin 过滤
     ⑦ 元素 click（el.click()）    ⑧ console / exception 全量收集
     ⑨ waitFor 轮询                ⑩ 截图 / 离线模拟 / 关闭清理

   ── 设计要点（改之前先读）────────────────────────────────────────────────
   A. **一条 WS 里混着两类帧**：带 id 的是命令响应，不带的（有 method）是事件。
      本文件用 pending Map 关联 id，未匹配到 id 的一律走事件总线，绝不丢帧。
   B. **所有等待必有超时**。没有超时的等待在无头浏览器里等于脚本永久挂死，
      而挂死的表现是"测试跑了 40 分钟没输出"，比断言失败难查得多。
   C. **失败必须带上下文**：哪一步、哪个 selector、当前 URL、最后观测值。
      只有 "timeout 30000ms" 的错误信息等于把排查工作推给下一个人。
   D. **清理三连**：关 target → 杀进程树（Windows 用 taskkill /T）→ 删临时 profile。
      Windows 上 Chrome 会派生子进程，只 kill 父进程会残留，第二次跑就发现端口被占。
      profile 目录删不掉通常是被子进程占用，故带重试；删不掉不阻塞退出。
   E. 不做**完整 Input 事件模拟**（pointerdown/mousedown/up 序列）。本仓库的屏幕层
      绑的是 click 与 input，el.click() 够用；做全套只会引入更多不可解释的时序差异。
   ============================================================================ */

'use strict';

var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http = require('http');
var { spawn, spawnSync } = require('child_process');

var IS_WIN = process.platform === 'win32';

/* Chrome/Edge 候选路径：按顺序取第一个存在的 */
var CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

var DEFAULT_TIMEOUT = 30000;

/* ---------------------------- 小工具 ---------------------------- */

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function pickChromePath(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) { throw new Error('chromePath 不存在：' + explicit); }
    return explicit;
  }
  for (var i = 0; i < CHROME_CANDIDATES.length; i += 1) {
    if (fs.existsSync(CHROME_CANDIDATES[i])) { return CHROME_CANDIDATES[i]; }
  }
  throw new Error('找不到 Chrome/Edge。用 launch({chromePath:"…"}) 显式指定，或设环境变量 CHROME_PATH。\n候选：\n  ' + CHROME_CANDIDATES.join('\n  '));
}

function findFreePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', function () {
      var port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
  });
}

/* 行缓冲：Chrome 的 stderr 可能把多行塞进一个 chunk，也可能一行分两个 chunk */
function lineBuffers() {
  var chunks = [];
  var partial = '';
  return {
    push: function (buf) {
      partial += buf.toString();
      var lines = partial.split(/\r?\n/);
      partial = lines.pop();
      lines.forEach(function (line) { if (line) { chunks.push(line); } });
      if (chunks.length > 400) { chunks = chunks.slice(-400); }
    },
    last: function (n) { return chunks.slice(-(n || 20)).join('\n'); },
    all: function () { return chunks.join('\n'); }
  };
}

/* ---------------------------- 进程清理 ---------------------------- */

var LIVE = []; // 未关闭的 session，进程退出时兜底清理，防止无头 Chrome 变成孤儿

function killTree(pid) {
  if (!pid) { return; }
  try {
    if (IS_WIN) {
      /* /T 连子进程一起杀；Chrome 会派生 renderer/gpu 子进程，只杀父进程会残留 */
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (error) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 已经死了 */ }
  }
}

function rmDirWithRetry(dir, attempts) {
  var left = attempts === undefined ? 6 : attempts;
  for (var i = 0; i < left; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 0 });
      return true;
    } catch (error) {
      /* Windows 上子树进程还没完全退出时目录是锁的，睡一下再试 */
      if (i === left - 1) { return false; }
      try {
        spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2', '>nul'], { stdio: 'ignore' });
      } catch (e) { /* ignore */ }
    }
  }
  return false;
}

process.on('exit', function () {
  LIVE.forEach(function (session) {
    if (session && session._proc && session._proc.pid && session._proc.exitCode === null) {
      killTree(session._proc.pid);
    }
  });
});

/* ============================================================================
   CDPConnection：一条 WS 上的命令/事件复用
   ============================================================================ */

function CDPConnection(wsUrl, label) {
  this.wsUrl = wsUrl;
  this.label = label || 'cdp';
  this.nextId = 1;
  this.pending = new Map();   // id -> {resolve, reject, method, timer}
  this.handlers = new Map();  // method -> [fn]
  this.ws = null;
  this.closed = false;
  this.closeInfo = null;
}

CDPConnection.prototype.connect = function (timeoutMs) {
  var self = this;
  var timeout = timeoutMs || 10000;
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) { return; }
      settled = true;
      reject(new Error('[' + self.label + '] 连 WS 超时 ' + timeout + 'ms：' + self.wsUrl));
    }, timeout);

    var ws;
    try {
      ws = new WebSocket(self.wsUrl);
    } catch (error) {
      clearTimeout(timer);
      reject(new Error('[' + self.label + '] 无法创建 WebSocket：' + error.message + '（URL ' + self.wsUrl + '）'));
      return;
    }
    self.ws = ws;

    ws.onopen = function () {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(self);
    };

    ws.onerror = function (event) {
      var detail = (event && (event.message || event.error && event.error.message)) || '未知错误';
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('[' + self.label + '] WS 连接失败：' + detail + '（URL ' + self.wsUrl + '）'));
      }
    };

    ws.onclose = function (event) {
      self.closed = true;
      self.closeInfo = { code: event && event.code, reason: event && event.reason };
      var err = new Error('[' + self.label + '] WS 已关闭 code=' + (event && event.code) + ' ' + (event && event.reason || ''));
      self.pending.forEach(function (entry) {
        clearTimeout(entry.timer);
        entry.reject(err);
      });
      self.pending.clear();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    };

    /* 关键：命令响应与事件混在同一流里。有 id → 命令响应；有 method → 事件。 */
    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (error) {
        return; // 非 JSON 帧直接丢，不冒泡成未捕获异常
      }
      if (msg.id !== undefined && msg.id !== null) {
        var entry = self.pending.get(msg.id);
        if (!entry) { return; }
        self.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error('[' + self.label + '] CDP ' + entry.method + ' 失败：' + (msg.error.message || JSON.stringify(msg.error)) +
            (msg.error.data ? ' · ' + msg.error.data : '')));
        } else {
          entry.resolve(msg.result || {});
        }
        return;
      }
      if (!msg.method) { return; }
      var list = self.handlers.get(msg.method);
      if (list && list.length) {
        list.slice().forEach(function (fn) {
          try { fn(msg.params || {}); } catch (error) { /* 单个监听器出错不影响其他 */ }
        });
      }
    };
  });
};

CDPConnection.prototype.send = function (method, params, timeoutMs) {
  var self = this;
  if (this.closed) {
    return Promise.reject(new Error('[' + this.label + '] 连接已关闭，无法发送 ' + method));
  }
  var id = this.nextId;
  this.nextId += 1;
  var timeout = timeoutMs || DEFAULT_TIMEOUT;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      self.pending.delete(id);
      reject(new Error('[' + self.label + '] CDP ' + method + ' 超时 ' + timeout + 'ms'));
    }, timeout);
    self.pending.set(id, { resolve: resolve, reject: reject, method: method, timer: timer });
    try {
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    } catch (error) {
      clearTimeout(timer);
      self.pending.delete(id);
      reject(new Error('[' + this.label + '] 发送 ' + method + ' 失败：' + error.message));
    }
  });
};

CDPConnection.prototype.on = function (method, fn) {
  var list = this.handlers.get(method) || [];
  list.push(fn);
  this.handlers.set(method, list);
  return function () {
    var current = this.handlers.get(method) || [];
    var index = current.indexOf(fn);
    if (index >= 0) { current.splice(index, 1); }
  }.bind(this);
};

CDPConnection.prototype.waitEvent = function (method, timeoutMs, filter) {
  var self = this;
  var timeout = timeoutMs || DEFAULT_TIMEOUT;
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) { return; }
      done = true;
      off();
      reject(new Error('[' + self.label + '] 等待事件 ' + method + ' 超时 ' + timeout + 'ms'));
    }, timeout);
    var off = self.on(method, function (params) {
      if (done) { return; }
      if (filter && !filter(params)) { return; }
      done = true;
      clearTimeout(timer);
      off();
      resolve(params);
    });
  });
};

CDPConnection.prototype.close = function () {
  this.closed = true;
  try { if (this.ws && this.ws.readyState === 1) { this.ws.close(); } } catch (error) { /* ignore */ }
};

/* ============================================================================
   Page：一个 target 上的操作面
   ============================================================================ */

function Page(browser, target, conn, options) {
  this.browser = browser;
  this.targetId = target.id;
  this.conn = conn;
  this.options = options || {};
  this.timeout = this.options.timeoutMs || DEFAULT_TIMEOUT;
  this.closed = false;

  this._requests = [];      // Network.requestWillBeSent 累计
  this._consoles = [];      // Runtime.consoleAPICalled
  this._exceptions = [];    // Runtime.exceptionThrown
  this._logEntries = [];    // Log.entryAdded（资源 404 / CSP 等）
  this._wireCollectors();
}

/* 域启用放在 connect 之后、goto 之前，才能收全首屏请求与 console */
Page.prototype.enableDomains = function () {
  var self = this;
  return Promise.all([
    this.conn.send('Runtime.enable').catch(function () { /* 有些 target 类型不支持 */ }),
    this.conn.send('Page.enable'),
    this.conn.send('Network.enable', { maxTotalBufferSize: 0, maxPostDataSize: 0 }).catch(function () {}),
    this.conn.send('Log.enable').catch(function () {})
  ]).then(function () { return self; });
};

/* goto 依赖 waitEvent（Page.loadEventFired），补一个到 conn 的代理——
   QA 驱动原稿漏了这条代理，第二次 goto 必挂 this.waitEvent is not a function */
Page.prototype.waitEvent = function (method, timeoutMs, filter) {
  return this.conn.waitEvent(method, timeoutMs, filter);
};

Page.prototype._wireCollectors = function () {
  var self = this;

  this.conn.on('Network.requestWillBeSent', function (params) {
    var request = params.request || {};
    self._requests.push({
      url: request.url || '',
      method: request.method || 'GET',
      type: params.type || 'Other',
      ts: Date.now()
    });
  });

  this.conn.on('Runtime.consoleAPICalled', function (params) {
    var text = (params.args || []).map(function (arg) {
      if (arg.value !== undefined) { return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value); }
      if (arg.unserializableValue !== undefined) { return String(arg.unserializableValue); }
      return arg.description || arg.type || '?';
    }).join(' ');
    self._consoles.push({ type: params.type || 'log', text: text, ts: Date.now() });
  });

  this.conn.on('Runtime.exceptionThrown', function (params) {
    var details = params.exceptionDetails || {};
    var exception = details.exception || {};
    var text = exception.description || details.text || '未知异常';
    self._exceptions.push({
      type: 'Uncaught',
      text: text,
      url: details.url || '',
      line: details.lineNumber,
      column: details.columnNumber,
      stack: details.stackTrace ? (details.stackTrace.callFrames || []).map(function (f) {
        return '  at ' + (f.functionName || '<anonymous>') + ' (' + f.url + ':' + (f.lineNumber + 1) + ':' + (f.columnNumber + 1) + ')';
      }).join('\n') : '',
      ts: Date.now()
    });
  });

  this.conn.on('Log.entryAdded', function (params) {
    var entry = params.entry || {};
    self._logEntries.push({ level: entry.level || 'info', text: entry.text || '', source: entry.source || '', url: entry.url || '', ts: Date.now() });
  });
};

/* 统一的错误上下文包装：错误信息里必须能看出"当时在哪"。
   _failing 是必要的：_fail 里要读 location.href，而读 href 走 eval，eval 失败时又会进 _fail
   → 连接已死的情况下会无限递归。第二次进入直接用占位符，绝不再发命令。 */
Page.prototype._fail = async function (step, detail) {
  if (this._failing) {
    return new Error('[page:' + this.targetId + '] ' + step + ' 失败：' + detail + '\n  当前 URL: (连接已断开，取不到)');
  }
  this._failing = true;
  var href = '?';
  try { href = await this.eval('location.href'); } catch (error) { href = '(取不到：' + error.message.split('\n')[0] + ')'; }
  this._failing = false;
  return new Error('[page:' + this.targetId + '] ' + step + ' 失败：' + detail + '\n  当前 URL: ' + href);
};

/* ---------------------------- 求值 ---------------------------- */

/* page.eval(fn | 'expr', ...args)
   - 传函数时序列化为 ($fn)(args...) 调用：函数里可以用 await；
   - awaitPromise 让 async 函数的结果自动展开；
   - 页面抛错时附上表达式片段与当前 URL，而不是只给 "exceptionDetails"。 */
Page.prototype.eval = async function (fnOrExpr, ...args) {
  var expression;
  if (typeof fnOrExpr === 'function') {
    var src = fnOrExpr.toString();
    var serialized = args.map(function (arg) { return JSON.stringify(arg === undefined ? null : arg); }).join(', ');
    expression = '(' + src + ')(' + serialized + ')';
  } else {
    expression = String(fnOrExpr);
  }

  var result;
  try {
    result = await this.conn.send('Runtime.evaluate', {
      expression: expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: false
    });
  } catch (error) {
    throw await this._fail('Runtime.evaluate', error.message + '\n  表达式: ' + truncate(expression, 200));
  }

  if (result.exceptionDetails) {
    var details = result.exceptionDetails;
    var description = (details.exception && details.exception.description) || details.text || '页面抛出异常';
    throw await this._fail('页面内执行抛错', description + '\n  表达式: ' + truncate(expression, 300));
  }

  var remote = result.result || {};
  if (remote.unserializableValue !== undefined) { return remote.unserializableValue; }
  return remote.value;
};

function truncate(text, max) {
  var str = String(text);
  return str.length > max ? str.slice(0, max) + '…(' + str.length + ' 字符)' : str;
}

/* ---------------------------- 导航 ---------------------------- */

function stripHash(url) { var i = url.indexOf('#'); return i < 0 ? url : url.slice(0, i); }

Page.prototype.goto = async function (url, options) {
  var opts = options || {};
  var timeout = opts.timeout || this.timeout;

  var before = '';
  try { before = await this.eval('location.href'); } catch (error) { before = ''; }

  var nav;
  try {
    nav = await this.conn.send('Page.navigate', { url: url }, timeout);
  } catch (error) {
    throw await this._fail('Page.navigate', error.message + '（目标 ' + url + '）');
  }
  if (nav.errorText) {
    throw await this._fail('Page.navigate', nav.errorText + '（目标 ' + url + '）');
  }

  /* 三种情形分开处理，混在一起就会出现"要么白等满超时，要么拿到旧页面"：
     ① 同文档 hash 跳转：不会有 load 事件 → 只等 location.href 变成目标；
     ② 同一 URL 重载：location.href 立刻就等于目标，轮询会瞬间假成功 → 等 load 事件；
     ③ 普通导航：轮询 readyState==='complete' && href 已切换（等价于 load 事件，
        且在极快的 replaceState 场景下比事件更可靠）。 */
  var isHashOnly = before && stripHash(before) === stripHash(url) && before !== url;
  var isReload = before === url;

  if (isHashOnly) {
    var hashDeadline = Date.now() + timeout;
    while (Date.now() < hashDeadline) {
      var currentHash = await this.eval('location.href').catch(function () { return ''; });
      if (currentHash === url) { this._lastHref = currentHash; return currentHash; }
      await sleep(30);
    }
    throw await this._fail('goto(hash)', 'hash 未生效，期望 ' + url);
  }

  if (isReload) {
    var fired = await this.waitEvent('Page.loadEventFired', timeout).then(function () { return true; }).catch(function () { return false; });
    if (!fired) {
      var readyNow = await this.eval('document.readyState').catch(function () { return '?'; });
      if (readyNow !== 'complete') {
        throw await this._fail('goto(重载)', '等待 load 超时 ' + timeout + 'ms，readyState=' + readyNow + '（目标 ' + url + '）');
      }
    }
    var afterReload = await this.eval('location.href').catch(function () { return url; });
    this._lastHref = afterReload;
    return afterReload;
  }

  var deadline = Date.now() + timeout;
  var normalizedTarget = stripHash(url);
  var lastState = null;
  while (Date.now() < deadline) {
    var state = await this.eval('({ready: document.readyState, href: location.href})').catch(function () { return null; });
    if (state) {
      lastState = state;
      if (state.ready === 'complete' && stripHash(state.href) === normalizedTarget) {
        this._lastHref = state.href;
        return state.href;
      }
    }
    await sleep(50);
  }
  throw await this._fail('goto', '等待加载完成超时 ' + timeout + 'ms（目标 ' + url + '）\n  最后观测: ' +
    truncate(JSON.stringify(lastState), 200));
};

Page.prototype.reload = async function (options) {
  var timeout = (options && options.timeout) || this.timeout;
  var loadFired = this.waitEvent('Page.loadEventFired', timeout).then(function () { return true; }).catch(function () { return false; });
  await this.conn.send('Page.reload', { ignoreCache: !!(options && options.ignoreCache) }, timeout);
  var ok = await loadFired;
  if (!ok) {
    var ready = await this.eval('document.readyState').catch(function () { return '?'; });
    if (ready !== 'complete') { throw await this._fail('reload', '超时 ' + timeout + 'ms，readyState=' + ready); }
  }
  return this.eval('location.href');
};

/* ---------------------------- 交互 ---------------------------- */

/* 先聚焦并清空，再 Input.insertText 走真实输入通道。
   为什么不用 el.value = text：屏幕层绑的是 input 事件，直接赋值不会触发，
   而 useTyping 会触发——两者在键盘/联想场景下行为不同，测试必须贴近真人。 */
Page.prototype.type = async function (selector, text, options) {
  var opts = options || {};
  var clear = opts.clear !== false;

  var focusResult = await this.eval(function (sel, shouldClear) {
    var el = document.querySelector(sel);
    if (!el) { return { ok: false, reason: 'not-found' }; }
    if (el.scrollIntoView) { el.scrollIntoView({ block: 'center' }); }
    if (typeof el.focus === 'function') { el.focus(); }
    var tag = (el.tagName || '').toLowerCase();
    var editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
    if (!editable) { return { ok: false, reason: 'not-editable', tag: tag }; }
    if (shouldClear) {
      if (el.isContentEditable) {
        el.textContent = '';
      } else {
        el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true, tag: tag, focused: document.activeElement === el };
  }, selector, clear);

  if (!focusResult || !focusResult.ok) {
    var reason = !focusResult ? '求值失败' : focusResult.reason === 'not-found'
      ? 'selector 未命中任何元素'
      : '元素不可输入（tag=' + focusResult.tag + '）';
    throw await this._fail('type("' + selector + '")', reason + '\n  selector: ' + selector);
  }

  if (text && String(text).length) {
    await this.conn.send('Input.insertText', { text: String(text) });
  }

  /* 回读，确认文字真的进去了（中文输入法/不可编辑状态下 insertText 会静默无效） */
  if (opts.verify !== false) {
    var actual = await this.eval(function (sel) {
      var el = document.querySelector(sel);
      if (!el) { return null; }
      return el.isContentEditable ? el.textContent : el.value;
    }, selector);
    var expected = String(text || '');
    if (actual !== expected) {
      throw await this._fail('type("' + selector + '") 回读不一致',
        '写入后读到 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected) + '\n  selector: ' + selector);
    }
  }
  return this;
};

/* el.click()：本仓库屏幕层绑 click，够用；不做完整 pointer 序列（见文件头 E 条） */
Page.prototype.click = async function (selector, options) {
  var opts = options || {};
  var result = await this.eval(function (sel) {
    var el = document.querySelector(sel);
    if (!el) { return { ok: false, reason: 'not-found' }; }
    if (el.scrollIntoView) { el.scrollIntoView({ block: 'center' }); }
    if (typeof el.focus === 'function') { el.focus(); }
    var disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    el.click();
    return { ok: true, disabled: disabled, tag: (el.tagName || '').toLowerCase() };
  }, selector);

  if (!result || !result.ok) {
    throw await this._fail('click("' + selector + '")', 'selector 未命中任何元素\n  selector: ' + selector);
  }
  if (result.disabled && opts.allowDisabled !== true) {
    throw await this._fail('click("' + selector + '")', '元素处于 disabled 状态，真实用户点不动\n  selector: ' + selector);
  }
  if (opts.settle) { await sleep(opts.settle); }
  return this;
};

Page.prototype.text = function (selector) {
  return this.eval(function (sel) {
    var el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim() : null;
  }, selector);
};

Page.prototype.attr = function (selector, name) {
  return this.eval(function (sel, attrName) {
    var el = document.querySelector(sel);
    return el ? el.getAttribute(attrName) : null;
  }, selector, name);
};

Page.prototype.exists = function (selector) {
  return this.eval(function (sel) { return !!document.querySelector(sel); }, selector);
};

/* ---------------------------- 等待 ---------------------------- */

/* predicate 可以是函数或字符串表达式；真值即返回。
   "Execution context was destroyed"（导航中）不算失败，继续轮询——
   否则任何跨导航的等待都会假失败。 */
Page.prototype.waitFor = async function (predicate, options) {
  var opts = options || {};
  var timeout = opts.timeout || this.timeout;
  var interval = opts.interval || 80;
  var label = opts.label || (typeof predicate === 'function' ? truncate(predicate.toString(), 120) : truncate(String(predicate), 120));
  var deadline = Date.now() + timeout;
  var lastValue;
  var lastError = null;

  while (Date.now() < deadline) {
    try {
      lastValue = await this.eval(predicate);
      if (lastValue) { return lastValue; }
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(error.message)) {
        /* 真正的求值错误（比如 predicate 本身写错）应立刻暴露，不要静默重试 */
        if (!/页面内执行抛错/.test(error.message)) { throw error; }
      }
    }
    await sleep(interval);
  }

  var detail = '等待超时 ' + timeout + 'ms\n  条件: ' + label + '\n  最后一次观测值: ' + truncate(JSON.stringify(lastValue), 300);
  if (lastError) { detail += '\n  最后一次错误: ' + truncate(lastError.message, 300); }
  if (opts.selector) { detail += '\n  selector: ' + opts.selector; }
  throw await this._fail('waitFor', detail);
};

Page.prototype.waitForSelector = function (selector, options) {
  var opts = options || {};
  return this.waitFor(function (sel) { return !!document.querySelector(sel); }, {
    timeout: opts.timeout,
    selector: selector,
    label: '出现元素 ' + selector
  });
};

Page.prototype.waitForGone = function (selector, options) {
  var opts = options || {};
  return this.waitFor(function (sel) { return !document.querySelector(sel); }, {
    timeout: opts.timeout,
    selector: selector,
    label: '元素消失 ' + selector
  });
};

/* ---------------------------- 网络 ---------------------------- */

/* page.network() 返回一个"实时视图"：
     requests()           全部请求副本
     urls()               仅 URL 字符串
     origins()            origin → 次数
     count(origin)        指定 origin（或子串）的请求数，省略=全部
     matching(origin)     命中该 origin 的请求对象
     external()           非本机 origin 的请求（AC1「外发 0 次」的主要观测面）
     clear()              清空计数（用例分段统计用）
   注意：Chrome 自身的后台请求不在本 target 的 Network 域里，不会污染计数。 */
Page.prototype.network = function () {
  var self = this;
  function sameOrigin(url, needle) {
    if (!needle) { return true; }
    if (url.indexOf(needle) >= 0) { return true; }
    try {
      var parsed = new URL(url);
      var target = needle.indexOf('://') < 0 ? 'http://' + needle.replace(/^\/\//, '') : needle;
      return parsed.origin === new URL(target).origin;
    } catch (error) {
      return false;
    }
  }
  return {
    requests: function () { return self._requests.slice(); },
    urls: function () { return self._requests.map(function (r) { return r.url; }); },
    origins: function () {
      var map = {};
      self._requests.forEach(function (r) {
        var origin;
        try { origin = new URL(r.url).origin; } catch (error) { origin = '(invalid)'; }
        map[origin] = (map[origin] || 0) + 1;
      });
      return map;
    },
    count: function (needle) {
      return self._requests.filter(function (r) { return sameOrigin(r.url, needle); }).length;
    },
    matching: function (needle) {
      return self._requests.filter(function (r) { return sameOrigin(r.url, needle); });
    },
    external: function () {
      var selfOrigin = '';
      try { selfOrigin = new URL(self._lastHref || '').origin; } catch (error) { selfOrigin = ''; }
      return self._requests.filter(function (r) {
        try {
          var origin = new URL(r.url).origin;
          return origin !== selfOrigin && !/^(data|blob|about|file):/.test(r.url);
        } catch (error) { return false; }
      });
    },
    clear: function () { self._requests.length = 0; }
  };
};

/* AC2 需要：Network.emulateNetworkConditions offline:true */
Page.prototype.offline = async function (enabled) {
  await this.conn.send('Network.emulateNetworkConditions', {
    offline: !!enabled,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  return !!enabled;
};

/* ---------------------------- 控制台 ---------------------------- */

Page.prototype.console = function () {
  var self = this;
  return {
    all: function () { return self._consoles.slice(); },
    logs: function () { return self._consoles.filter(function (c) { return c.type === 'log'; }); },
    errors: function () {
      return self._consoles.filter(function (c) { return c.type === 'error' || c.type === 'assert'; })
        .concat(self._exceptions);
    },
    /* 未捕获异常 + 资源加载失败（Log 域的 error）。判"无 Uncaught"就看这个 */
    exceptions: function () { return self._exceptions.slice(); },
    logEntries: function () { return self._logEntries.slice(); },
    text: function () {
      return self._consoles.map(function (c) { return '[' + c.type + '] ' + c.text; }).join('\n');
    },
    clear: function () { self._consoles.length = 0; self._exceptions.length = 0; self._logEntries.length = 0; }
  };
};

/* ---------------------------- 其他 ---------------------------- */

Page.prototype.screenshot = async function (filePath, options) {
  var opts = options || {};
  var shot = await this.conn.send('Page.captureScreenshot', {
    format: opts.format || 'png',
    captureBeyondViewport: opts.fullPage !== false,
    fromSurface: true
  });
  var buffer = Buffer.from(shot.data, 'base64');
  if (filePath) {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }
  return buffer;
};

Page.prototype.url = function () { return this.eval('location.href'); };
Page.prototype.title = function () { return this.eval('document.title'); };

Page.prototype.close = async function () {
  if (this.closed) { return; }
  this.closed = true;
  this.conn.close();
  try {
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }, 5000);
  } catch (error) { /* target 已经不在了，正常 */ }
};

/* ============================================================================
   Browser：进程 + 浏览器级 WS + newPage
   ============================================================================ */

function Browser(proc, conn, userDataDir, info) {
  this._proc = proc;
  this.conn = conn;
  this.userDataDir = userDataDir;
  this.info = info;
  this.port = info.port;
  this.pages = [];
  this.closed = false;
  LIVE.push(this);
}

Browser.prototype.send = function (method, params, timeoutMs) {
  return this.conn.send(method, params, timeoutMs);
};

Browser.prototype.version = function () {
  return this.info;
};

/* PUT /json/new?url=…（Chrome 111+ 只认 PUT，GET 会 405；老的认 GET） */
function httpJson(port, urlPath, method) {
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: '127.0.0.1',
      port: port,
      path: urlPath,
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + urlPath + ' → ' + body.slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) {
          reject(new Error('非 JSON 响应 ' + urlPath + ' → ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, function () { req.destroy(new Error('HTTP 超时 ' + urlPath)); });
    req.end();
  });
}

Browser.prototype.newPage = async function (url) {
  var targetUrl = url || 'about:blank';
  var target;
  try {
    target = await httpJson(this.port, '/json/new?' + encodeURI(targetUrl), 'PUT');
  } catch (error) {
    /* 老版本 Chrome 只认 GET；PUT 405 时降级 */
    if (/HTTP 405|HTTP 404/.test(error.message)) {
      target = await httpJson(this.port, '/json/new?' + encodeURI(targetUrl), 'GET');
    } else {
      throw error;
    }
  }
  if (!target.webSocketDebuggerUrl) {
    throw new Error('target 没有 webSocketDebuggerUrl：' + JSON.stringify(target).slice(0, 300));
  }

  var conn = new CDPConnection(target.webSocketDebuggerUrl, 'page:' + (target.id || ''));
  await conn.connect(this.info.connectTimeout || 10000);
  var page = new Page(this, target, conn, { timeoutMs: this.info.timeoutMs });
  page._lastHref = targetUrl;
  await page.enableDomains();
  this.pages.push(page);
  return page;
};

Browser.prototype.close = async function () {
  if (this.closed) { return { killed: false, profileRemoved: false }; }
  this.closed = true;

  for (var i = 0; i < this.pages.length; i += 1) {
    try { await this.pages[i].close(); } catch (error) { /* 已关 */ }
  }
  this.pages = [];

  this.conn.close();

  var pid = this._proc && this._proc.pid;
  var killed = false;
  if (this._proc && this._proc.exitCode === null) {
    killTree(pid);
    killed = true;
    /* 给 taskkill 一点时间把子进程收掉，再删 profile */
    await sleep(300);
    try { this._proc.kill('SIGKILL'); } catch (error) { /* ignore */ }
  }

  var profileRemoved = false;
  if (this.userDataDir) {
    profileRemoved = rmDirWithRetry(this.userDataDir, 6);
  }

  var index = LIVE.indexOf(this);
  if (index >= 0) { LIVE.splice(index, 1); }

  return { killed: killed, profileRemoved: profileRemoved, userDataDir: this.userDataDir, pid: pid };
};

Browser.prototype.isAlive = function () {
  return !!(this._proc && this._proc.exitCode === null);
};

/* ============================================================================
   launch()
   ============================================================================ */

async function launch(options) {
  var opts = options || {};
  var chromePath = pickChromePath(opts.chromePath);
  var headless = opts.headless !== false;
  var timeoutMs = opts.timeoutMs || 20000;
  var explicitPort = opts.port ? Number(opts.port) : 0;
  var userDataDir = opts.userDataDir || path.join(os.tmpdir(), 'xzb-cdp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(userDataDir, { recursive: true });

  /* Chrome 132+ 已把 new headless 变成默认，--headless=new 在个别版本会被忽略/报错。
     故按候选顺序尝试，第一个能起来就用。 */
  var headlessVariants = headless ? (opts.headlessFlag ? [[opts.headlessFlag]] : [['--headless=new'], ['--headless']]) : [[]];

  var lastError = null;
  for (var v = 0; v < headlessVariants.length; v += 1) {
    try {
      return await spawnAndConnect({
        chromePath: chromePath,
        headlessFlags: headlessVariants[v],
        userDataDir: userDataDir,
        explicitPort: explicitPort,
        timeoutMs: timeoutMs,
        extraArgs: opts.args || []
      });
    } catch (error) {
      lastError = error;
      /* 换下一组参数重试前，先把可能的残留进程清掉 */
      rmDirWithRetry(userDataDir, 2);
      fs.mkdirSync(userDataDir, { recursive: true });
    }
  }
  throw lastError || new Error('launch 失败（未知原因）');
}

async function spawnAndConnect(cfg) {
  var port = cfg.explicitPort || await findFreePort();
  var stderr = lineBuffers();
  var stdout = lineBuffers();

  var args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + cfg.userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-client-side-phishing-detection',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    '--mute-audio',
    '--metrics-recording-only',
    /* Chrome 111+ 对来自其他 Origin 的 WS 连接做校验；Node 侧不带 Origin，
       但加上这行可避免部分版本/代理环境下的 403，代价为零 */
    '--remote-allow-origins=*'
  ].concat(cfg.headlessFlags).concat(cfg.extraArgs).concat(['about:blank']);

  var proc = spawn(cfg.chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', function (chunk) { stdout.push(chunk); });
  proc.stderr.on('data', function (chunk) { stderr.push(chunk); });

  var exited = false;
  proc.on('exit', function () { exited = true; });

  /* 就绪探测：DevTools listening 行最可靠；同时轮询 /json/version 兜底。
     用 httpJson 而不是全局 fetch，与本仓库 tools/ 的既有约定一致
     （mock-ai-server 的注释：只用 node:http，不用 fetch）。 */
  var deadline = Date.now() + cfg.timeoutMs;
  var versionInfo = null;
  var sawListening = false;

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error('Chrome 启动后立即退出（code=' + proc.exitCode + '）\n参数: ' + cfg.headlessFlags.join(' ') +
        '\nstderr:\n' + truncate(stderr.last(25), 2000));
    }
    if (!sawListening && /DevTools listening on ws:\/\//.test(stderr.all())) { sawListening = true; }
    if (sawListening) {
      try {
        versionInfo = await httpJson(port, '/json/version', 'GET');
        break;
      } catch (error) { /* 端口刚开，再等一轮 */ }
    }
    await sleep(100);
  }

  if (!versionInfo) {
    killTree(proc.pid);
    throw new Error('等 /json/version 就绪超时 ' + cfg.timeoutMs + 'ms（端口 ' + port + '，headless=' + (cfg.headlessFlags[0] || 'false') + '）' +
      '\nstderr:\n' + truncate(stderr.last(25), 2000));
  }

  var browserWs = versionInfo.webSocketDebuggerUrl ||
    (/DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr.all()) || [])[1];
  if (!browserWs) {
    killTree(proc.pid);
    throw new Error('/json/version 里没有 webSocketDebuggerUrl：' + JSON.stringify(versionInfo).slice(0, 300));
  }

  var conn = new CDPConnection(browserWs, 'browser');
  try {
    await conn.connect(10000);
  } catch (error) {
    killTree(proc.pid);
    throw error;
  }

  var info = {
    port: port,
    browserWs: browserWs,
    browser: versionInfo.Browser || 'unknown',
    protocolVersion: versionInfo['Protocol-Version'] || '',
    userAgent: versionInfo['User-Agent'] || '',
    headlessFlags: cfg.headlessFlags,
    chromePath: cfg.chromePath,
    timeoutMs: cfg.timeoutMs,
    connectTimeout: 10000
  };

  return new Browser(proc, conn, cfg.userDataDir, info);
}

/* ============================================================================
   便捷入口：起浏览器 + 起页面 + 收尾，供一次性用例用
   ============================================================================ */

async function withPage(options, fn) {
  var browser = await launch(options);
  try {
    var page = await browser.newPage();
    return await fn(page, browser);
  } finally {
    await browser.close();
  }
}

/* ============================================================================
   CLI 自检：node tools/cdp-driver.js --smoke --url http://127.0.0.1:8099/index.html
   ============================================================================ */

function argOf(name, fallback) {
  var argv = process.argv.slice(2);
  for (var i = 0; i < argv.length; i += 1) {
    var item = argv[i];
    if (item === '--' + name && argv[i + 1] && argv[i + 1].charAt(0) !== '-') { return argv[i + 1]; }
    if (item.indexOf('--' + name + '=') === 0) { return item.slice(name.length + 3); }
  }
  return fallback;
}

async function smoke() {
  var url = argOf('url', 'http://127.0.0.1:8099/index.html');
  var lines = [];
  function log(text) { lines.push(text); process.stdout.write(text + '\n'); }

  log('# cdp-driver smoke');
  var browser = await launch({ headless: true, timeoutMs: 25000 });
  log('version      : ' + browser.info.browser);
  log('headlessFlag : ' + browser.info.headlessFlags.join(' ') + '  port=' + browser.info.port);
  log('profile      : ' + browser.userDataDir);

  var page;
  try {
    page = await browser.newPage();
    var href = await page.goto(url, { timeout: 25000 });
    log('goto         : ' + href);

    var title = await page.title();
    log('title        : ' + JSON.stringify(title));
    log('title ok     : ' + (title.indexOf('小账本') >= 0 ? 'PASS' : 'FAIL'));

    var version = await page.eval('window.XZB && XZB.version');
    log('XZB.version  : ' + JSON.stringify(version));
    log('version ok   : ' + (version === '2.24.0' ? 'PASS' : 'FAIL'));

    /* 给启动期异步（chunk ensure / SW 注册）一点时间，再判异常 */
    await sleep(1200);
    var exceptions = page.console().exceptions();
    var uncaught = exceptions.filter(function (e) { return /Uncaught/.test(e.text) || e.type === 'Uncaught'; });
    log('exceptions   : ' + exceptions.length + '（Uncaught ' + uncaught.length + '）');
    uncaught.slice(0, 5).forEach(function (e) { log('   ! ' + e.text.split('\n')[0] + ' @ ' + e.url); });
    log('no uncaught  : ' + (uncaught.length === 0 ? 'PASS' : 'FAIL'));

    var net = page.network();
    log('requests     : ' + net.urls().length);
    var origins = net.origins();
    Object.keys(origins).forEach(function (origin) { log('   ' + origin + ' → ' + origins[origin]); });
    var external = net.external();
    log('external     : ' + external.length);
    external.slice(0, 5).forEach(function (r) { log('   > ' + r.method + ' ' + truncate(r.url, 110)); });

    var shotPath = path.join(os.tmpdir(), 'xzb-cdp-smoke-' + Date.now() + '.png');
    await page.screenshot(shotPath);
    log('screenshot   : ' + shotPath + ' (' + fs.statSync(shotPath).size + 'B)');
    fs.rmSync(shotPath, { force: true });
  } finally {
    var cleanup = await browser.close();
    log('close        : killed=' + cleanup.killed + ' profileRemoved=' + cleanup.profileRemoved + ' pid=' + cleanup.pid);
    var alive = browser.isAlive();
    log('proc alive   : ' + alive + (alive ? ' (FAIL 仍有残留)' : ' (PASS 已退出)'));
  }

  var failed = lines.filter(function (l) { return /: FAIL/.test(l) || /\(FAIL/.test(l); });
  process.stdout.write('\n# 结果：' + (failed.length ? 'FAIL × ' + failed.length : 'ALL PASS') + '\n');
  if (failed.length) { process.exitCode = 1; }
}

if (require.main === module) {
  if (process.argv.indexOf('--smoke') >= 0) {
    smoke().catch(function (error) {
      process.stderr.write('[smoke] 失败：' + (error && error.stack || error) + '\n');
      process.exitCode = 1;
    });
  } else {
    process.stdout.write([
      'tools/cdp-driver.js · 作为库使用：',
      '  const { launch, withPage } = require("./tools/cdp-driver.js");',
      '  const browser = await launch({ headless: true });',
      '  const page = await browser.newPage();',
      '  await page.goto("http://127.0.0.1:8080/index.html");',
      '  await page.waitFor(() => !!window.XZB);',
      '  console.log(await page.eval(() => XZB.version));',
      '  await browser.close();',
      '',
      '自检：node tools/cdp-driver.js --smoke --url http://127.0.0.1:8099/index.html',
      ''
    ].join('\n'));
  }
}

module.exports = {
  launch: launch,
  withPage: withPage,
  CDPConnection: CDPConnection,
  Page: Page,
  Browser: Browser,
  findFreePort: findFreePort,
  pickChromePath: pickChromePath
};
