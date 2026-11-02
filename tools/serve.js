#!/usr/bin/env node
/* ============================================================================
   小账本 2.0 · tools/serve.js · owner: QA（T-QA01，开发期资产）
   用途：零依赖静态服务器，给 CDP 无头浏览器与 CDP 用例提供 http:// 源。
        - 仓库刻意无 package.json / node_modules，本文件只用 node:http / node:fs；
        - 不进 PRECACHE、不被任何 chunk 引用、不参与 checkSync（架构 §13.2）。

   为什么需要它（而不是 file://）：
     1. Service Worker 与 fetch 在 file:// 下行为被浏览器禁用，AC19 要用 file:// 但其余
        AC（AC1/AC2/AC4…）必须跑 http(s) 才能拿到与线上一致的加载链；
     2. 缓存头可控：默认 no-store，避免上一轮用例写进 SW / HTTP 缓存的旧 index.html
        污染下一轮（"改了代码但测出来还是旧版本"是最难查的假失败）。

   用法：
     node tools/serve.js                        # 8080，默认 no-store
     node tools/serve.js --port 8099            # 换端口
     node tools/serve.js --port 8099 --cache    # 允许缓存（验 SW 时用）
     node tools/serve.js --root . --verbose
   退出：Ctrl+C，或收到 SIGTERM（CDP 用例退出时会带 SIGTERM）。
   ============================================================================ */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

/* ---------------------------- 参数解析 ---------------------------- */

function argOf(name, fallback) {
  var argv = process.argv.slice(2);
  for (var i = 0; i < argv.length; i += 1) {
    var item = argv[i];
    if (item === '--' + name && argv[i + 1] && argv[i + 1].charAt(0) !== '-') { return argv[i + 1]; }
    if (item.indexOf('--' + name + '=') === 0) { return item.slice(name.length + 3); }
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).indexOf('--' + name) >= 0;
}

var PORT = Number(argOf('port', 8080)) || 8080;
var HOST = String(argOf('host', '127.0.0.1'));
var VERBOSE = hasFlag('verbose');
/* 默认禁缓存；--cache 才放行。用 --no-cache 显式写也无害（保持与任务书口径一致）。 */
var NO_CACHE = hasFlag('no-cache') || !hasFlag('cache');
var ROOT = path.resolve(argOf('root', path.join(__dirname, '..')));

/* ---------------------------- Content-Type ---------------------------- */

/* 只登记仓库真实会用到的类型；其余按 octet-stream 走。
   .js 必须是 text/javascript：SW 与 <script type="module"> 对 MIME 挑剔，
   给成 application/javascript 在部分 Chromium 版本会触发严格 MIME 检查告警。 */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.webapp': 'application/x-web-app-manifest+json',
  '.apk': 'application/vnd.android.package-archive'
};

function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/* ---------------------------- 安全：禁止路径穿越 ---------------------------- */

/* 判据：解析后的绝对路径必须仍在 ROOT 内。
   同时挡掉 %2e%2e / ..%2f 这类编码穿越——decodeURIComponent 之后再 resolve，
   否则 "..%2f" 会被当成普通字符而绕过 startsWith。 */
function resolveSafe(requestPath) {
  var decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch (error) {
    return { ok: false, reason: '非法 URL 编码' };
  }
  /* NUL 截断攻击：/index.html%00.png */
  if (decoded.indexOf('\u0000') >= 0) { return { ok: false, reason: '路径含 NUL' }; }
  /* 反斜杠在 Windows 上等价于分隔符，统一成正斜杠后再判 */
  var normalized = decoded.replace(/\\/g, '/');
  if (normalized.indexOf('\u0000') >= 0) { return { ok: false, reason: '路径含 NUL' }; }

  var abs = path.resolve(ROOT, '.' + (normalized.charAt(0) === '/' ? normalized : '/' + normalized));
  var rel = path.relative(ROOT, abs);
  if (rel === '') { return { ok: true, filePath: path.join(ROOT, 'index.html') }; }
  if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) {
    return { ok: false, reason: '越出站点根目录' };
  }
  return { ok: true, filePath: abs };
}

/* ---------------------------- 响应头 ---------------------------- */

function setHeaders(res, filePath, status) {
  res.setHeader('Content-Type', mimeOf(filePath));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (NO_CACHE) {
    /* 三件套一起上：no-store 管 HTTP 缓存，Pragma 兼容老逻辑，Expires 兜代理 */
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
  /* 本地测试服务，不做跨域限制：mock-ai-server 才是需要跨域的那个 */
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (status) { res.statusCode = status; }
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (NO_CACHE) { res.setHeader('Cache-Control', 'no-store'); }
  res.end(text + '\n');
}

/* ---------------------------- 请求处理 ---------------------------- */

function handle(req, res) {
  var startedAt = Date.now();
  var parsed = url.parse(req.url);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, '405 Method Not Allowed');
    return;
  }

  var safe = resolveSafe(parsed.pathname || '/');
  if (!safe.ok) {
    /* 穿越尝试按 403 处理并留痕：它不是正常 404，值得在测试日志里被看到 */
    sendText(res, 403, '403 Forbidden · ' + safe.reason);
    process.stderr.write('[serve] 403 ' + req.method + ' ' + parsed.pathname + ' (' + safe.reason + ')\n');
    return;
  }

  var filePath = safe.filePath;

  fs.stat(filePath, function (statError, stat) {
    if (!statError && stat.isDirectory()) {
      /* 目录 → 目录下的 index.html（站点根 / 与任何子目录都适用） */
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, function (readError, buffer) {
      if (readError) {
        var status = readError.code === 'ENOENT' || readError.code === 'ENOTDIR' ? 404 : 500;
        sendText(res, status, status + ' ' + (status === 404 ? 'Not Found' : 'Internal Server Error') + ' · ' + (parsed.pathname || '/'));
        if (VERBOSE) { process.stdout.write('[serve] ' + status + ' ' + req.method + ' ' + parsed.pathname + '\n'); }
        return;
      }
      setHeaders(res, filePath, 200);
      /* HEAD 只回头不回体，curl -sI 依赖这一点 */
      if (req.method === 'HEAD') { res.end(); } else { res.end(buffer); }
      if (VERBOSE) {
        process.stdout.write('[serve] 200 ' + req.method + ' ' + parsed.pathname + ' → ' + path.relative(ROOT, filePath) +
          ' (' + buffer.length + 'B, ' + (Date.now() - startedAt) + 'ms)\n');
      }
    });
  });
}

/* ---------------------------- 启动 ---------------------------- */

var server = http.createServer(handle);

server.on('error', function (error) {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write('[serve] 端口 ' + PORT + ' 已被占用。换端口：node tools/serve.js --port ' + (PORT + 1) + '\n');
  } else {
    process.stderr.write('[serve] 启动失败：' + error.message + '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  process.stdout.write('[serve] root=' + ROOT + '\n');
  process.stdout.write('[serve] http://' + HOST + ':' + PORT + '/index.html' + (NO_CACHE ? '  (no-store)' : '  (cache on)') + '\n');
  /* 这行是给 CDP 用例做就绪探测用的，改动请同步 tools/cdp-driver.js 的注释 */
  process.stdout.write('[serve] ready\n');
});

['SIGINT', 'SIGTERM'].forEach(function (signal) {
  process.on(signal, function () {
    server.close(function () {
      process.stdout.write('[serve] 已关闭\n');
      process.exit(0);
    });
    /* 有 keep-alive 连接挂着时 close 不会回调，2s 后强退 */
    setTimeout(function () { process.exit(0); }, 2000).unref();
  });
});

module.exports = { server: server, resolveSafe: resolveSafe, mimeOf: mimeOf, ROOT: ROOT };
