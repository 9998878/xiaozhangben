/* ============================================================
   小账本 2.44.5 · Service Worker（离线缓存键修复）
   缓存名：小账本2-v2.44.5（英文缓存键 xzb2-v2.44.5）
   策略：导航请求网络优先（8 秒超时）→ 缓存；其余静态资源缓存优先。
   约束：只处理 GET；只处理 http(s) 同源请求；不缓存 chrome-extension 等协议。
   ============================================================ */
(function (global) {
  'use strict';

  /* 人类可读的缓存版本标签，仅用于日志与排查 */
  var CACHE_LABEL = '小账本2-v2.44.5';
  /* 真正的 Cache Storage 键：换版本号即触发本应用旧缓存清除（activate 时 cleanupCaches） */
  var CACHE_NAME = 'xzb2-v2.44.5';
  /* 预缓存版本 query：由 CACHE_NAME 派生，绝不与缓存版本漂移。
     加载器请求恒带 ?v=<XZB.version>，预缓存按同一键写入才能命中（2.44.1 修 P1-1）。 */
  var VERSION = CACHE_NAME.slice('xzb2-v'.length);
  /* 预取失败清单的旁路缓存：名字同样带 xzb2- 前缀，清理时必须显式保留（见 cleanupCaches） */
  var META_CACHE = 'xzb2-meta';
  /* 预取失败清单在旁路缓存里的键；内容形如 { v: CACHE_NAME, list: [url, ...] } */
  var MISSING_KEY = '/precache-missing.json';
  /* 导航请求的网络等待上限：超过即回退缓存，避免弱网白屏 */
  var NAV_TIMEOUT_MS = 8000;
  /* install 预缓存清单：入口与壳资源；css/js 为外链，由运行时 cacheFirst 兜底 */
  var PRECACHE = [
    './',
    './index.html',
    './manifest.webmanifest',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './splash/splash-1170x2532.png',
    './splash/splash-1284x2778.png',
    './splash/splash-1179x2556.png',
    './splash/splash-1290x2796.png',
    './splash/splash-1125x2436.png',
    './splash/splash-828x1792.png',
    './splash/splash-1242x2688.png',
    './splash/splash-1242x2208.png',
    './js/screens/home.js',
    './js/screens/add.js',
    './js/screens/ledger.js',
    './js/screens/stats.js',
    './js/screens/calendar.js',
    './js/screens/report.js',
    './js/screens/accounts.js',
    './js/screens/books.js',
    './js/screens/plan.js',
    './js/screens/settings.js',
    './js/screens/assistant.js',
    './js/modules/keypad.js',
    './js/modules/icon-picker.js',
    './js/modules/charts.js',
    './js/modules/nl.js',
    './js/modules/core-assistant.js',
    './js/modules/ai-insights.js',
    './js/modules/habit.js',
    './js/modules/bill-import.js',
    './js/modules/audit.js',
    './js/modules/inline-edit.js'
  ];

  /* 判断是否为可接管的 http(s) 地址：chrome-extension:/file:/data: 一律放行给浏览器 */
  function isHttpUrl(url) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  /* 只接管同源 GET；跨源请求不缓存、不拦截 */
  function isSameOriginHttp(request) {
    var url;
    try {
      url = new URL(request.url);
    } catch (error) {
      return false;
    }
    if (!isHttpUrl(url)) return false;
    if (url.origin !== global.location.origin) return false;
    return true;
  }

  /* 带超时的 fetch：8 秒拿不到网络响应就 reject，交给缓存回退 */
  function fetchWithTimeout(request, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('NETWORK_TIMEOUT'));
      }, timeoutMs);
      fetch(request).then(function (response) {
        clearTimeout(timer);
        resolve(response);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /* 缓存键归一化：只剥重试参数 r，保留版本参数 v。
     预缓存的 js 分块按 ?v=<VERSION> 写入（见 precacheKey），与加载器运行时键一致；
     旧 index 带旧 ?v= 时由 cacheFirst 的 ignoreSearch 兜底命中同路径当前分块。 */
  function normalizeKey(request) {
    var url = new URL(request.url, global.location.href);
    /* 2.41.3：保留版本 query v 作为缓存键的一部分——旧版删掉 v 导致所有版本共用一条
       缓存，慢网下长期喂旧分块（手机停旧免费档根因之一）。保留 v 后新版本 ?v= 立即
       未命中走网络；旧缓存整体由 activate 的 cleanupCaches 按 CACHE_NAME 清除，不泄漏。 */
    url.searchParams.delete('r');
    return url.href;
  }

  /* 写缓存失败不能影响正常响应，所以统一吞掉异常 */
  function putInCache(key, response) {
    if (!response || !response.ok) return;
    var copy = response.clone();
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.put(key, copy);
    }).catch(function () {
      /* 配额满或响应不可缓存时静默跳过 */
    });
  }

  /* 把预取失败清单写进旁路缓存；全部成功则删除该键。
     ServiceWorkerGlobalScope 里没有 localStorage，清单只能放在 Cache Storage（见 CONTRACT §6 W2） */
  async function saveMissing(failed) {
    var meta = await caches.open(META_CACHE);
    if (!failed.length) {
      await meta.delete(MISSING_KEY);
      return;
    }
    var body = JSON.stringify({ v: CACHE_NAME, list: failed });
    await meta.put(MISSING_KEY, new Response(body, {
      headers: { 'content-type': 'application/json' }
    }));
  }

  /* cache.add 会命中 HTTP 缓存——iOS 会把旧响应直接塞进新版本缓存
     （2.28.5 手机端拿不到新键盘/新面板的根因）。这里强制 cache:'reload'
     绕过 HTTP 缓存再写 Cache Storage，预缓存的永远是服务器最新文件。 */
  async function addFresh(cache, url) {
    var request = new Request(url, { cache: 'reload' });
    var response = await fetch(request);
    if (!response || !response.ok) {
      throw new Error('E_PRECACHE_FAILED ' + url);
    }
    await cache.put(request, response);
  }

  /* 预缓存写入键：js 分块拼 ?v=（与加载器运行时键逐字一致）；
     入口/清单/图标/启动图运行时请求不带 query，保持原键。 */
  function precacheKey(url) {
    if (url.indexOf('./js/') === 0) { return url + '?v=' + VERSION; }
    return url;
  }

  /* 逐条预缓存：单条失败只记录、不中断其余条目；失败清单留给 activate 后空闲重试。
     清单里存的是带版本的写入键，重试与预缓存走同一个键。 */
  async function precache() {
    var cache = await caches.open(CACHE_NAME);
    var failed = [];
    for (var i = 0; i < PRECACHE.length; i += 1) {
      var key = precacheKey(PRECACHE[i]);
      try {
        await addFresh(cache, key);
      } catch (error) {
        failed.push(key);
      }
    }
    try {
      await saveMissing(failed);
    } catch (error) {
      /* 清单本身写不进去也不能让 install 整体失败：下次 install 会重新预取全部条目 */
    }
  }

  /* 删掉所有非当前版本的缓存，避免旧版本残留 */
  function cleanupCaches() {
    return caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key === CACHE_NAME) return Promise.resolve(false);
        /* 预取失败清单是跨版本旁路：被清掉就再也不会重试，必须显式排除 */
        if (key === META_CACHE) return Promise.resolve(false);
        /* Cache Storage 是按 origin 共享的：同一域名下可能还装着别的应用，
           只删本应用前缀的旧版本，绝不能把别人的离线缓存一起清掉。 */
        if (key.indexOf('xzb2-') !== 0) return Promise.resolve(false);
        return caches.delete(key);
      }));
    });
  }

  /* 读旁路缓存里的失败清单逐条重试：全部成功才删键，仍有失败则保持原清单 */
  async function retryMissing() {
    var meta = await caches.open(META_CACHE);
    var hit = await meta.match(MISSING_KEY);
    if (!hit) return;
    var record = await hit.json();
    /* 旧版本遗留的清单键不带当前版本，重试也命中不了运行时键：直接作废，下次 install 会全量重取 */
    if (!record || record.v !== CACHE_NAME) {
      await meta.delete(MISSING_KEY);
      return;
    }
    var list = record && Array.isArray(record.list) ? record.list : [];
    if (!list.length) {
      await meta.delete(MISSING_KEY);
      return;
    }
    var cache = await caches.open(CACHE_NAME);
    var failed = [];
    for (var i = 0; i < list.length; i += 1) {
      try {
        await addFresh(cache, list[i]);
      } catch (error) {
        failed.push(list[i]);
      }
    }
    if (!failed.length) {
      await meta.delete(MISSING_KEY);
    }
  }

  /* activate 完成后再重试：优先 requestIdleCallback，不支持的浏览器 2 秒后兜底 */
  function scheduleRetryMissing() {
    var run = function () {
      retryMissing().catch(function () {
        /* 重试失败保持原清单，下一次 activate 还会再来 */
      });
    };
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(run);
    } else {
      setTimeout(run, 2000);
    }
  }

  /* 导航回退链：请求本身 → index.html → 根路径 → 离线提示 */
  function matchNavigation(request) {
    return caches.match(request).then(function (hit) {
      if (hit) return hit;
      return caches.match('./index.html');
    }).then(function (hit) {
      if (hit) return hit;
      return caches.match('./');
    }).then(function (hit) {
      if (hit) return hit;
      return offlineResponse();
    });
  }

  /* 离线且缓存未就绪时的兜底页，不发起任何网络请求 */
  function offlineResponse() {
    /* 纯文本兜底页：不带任何内联样式，避免与「禁止内联 style」红线冲突 */
    var html = '<!doctype html><meta charset="utf-8">' +
      '<title>小账本</title><body><p>离线缓存尚未就绪，请联网打开一次后再试。</p></body>';
    return new Response(html, {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  /* 导航：网络优先，8 秒超时回退缓存 */
  function networkFirst(request) {
    return fetchWithTimeout(request, NAV_TIMEOUT_MS).then(function (response) {
      putInCache(request, response);
      return response;
    }).catch(function () {
      return matchNavigation(request);
    });
  }

  /* 静态资源：缓存优先，未命中再走网络并写入缓存 */
  function cacheFirst(request) {
    var key = normalizeKey(request);
    return caches.match(key).then(function (hit) {
      if (hit) return hit;
      /* 兜底：旧 index 引用上一版 ?v= 时精确键必 miss，忽略 query 命中同路径当前分块。
         旧版本缓存已由 activate 按 CACHE_NAME 清除，ignoreSearch 不会串到旧版本。 */
      return caches.match(key, { ignoreSearch: true });
    }).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
          putInCache(key, response);
        }
        return response;
      });
    });
  }

  global.addEventListener('install', function (event) {
    event.waitUntil(precache().then(function () {
      return global.skipWaiting();
    }));
  });

  global.addEventListener('activate', function (event) {
    event.waitUntil(cleanupCaches().then(function () {
      return global.clients.claim();
    }).then(function () {
      scheduleRetryMissing();
    }));
  });

  global.addEventListener('fetch', function (event) {
    var request = event.request;
    /* 非 GET 一律不接管（记账写操作走 IndexedDB，不发请求） */
    if (request.method !== 'GET') return;
    if (!isSameOriginHttp(request)) return;
    if (request.mode === 'navigate') {
      event.respondWith(networkFirst(request));
      return;
    }
    event.respondWith(cacheFirst(request));
  });
}(self));
