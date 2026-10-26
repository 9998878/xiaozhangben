/* ============================================================
   小账本 2.9 · Service Worker（鲨鱼风改版）
   缓存名：小账本2-v2.9.2（英文缓存键 xzb2-v2.9.2）
   策略：导航请求网络优先（3 秒超时）→ 缓存；其余静态资源缓存优先。
   约束：只处理 GET；只处理 http(s) 同源请求；不缓存 chrome-extension 等协议。
   ============================================================ */
(function (global) {
  'use strict';

  /* 人类可读的缓存版本标签，仅用于日志与排查 */
  var CACHE_LABEL = '小账本2-v2.9.2';
  /* 真正的 Cache Storage 键：换版本号即触发旧缓存全量清除（activate 时 cleanupCaches） */
  var CACHE_NAME = 'xzb2-v2.9.2';
  /* 导航请求的网络等待上限：超过即回退缓存，避免弱网白屏 */
  var NAV_TIMEOUT_MS = 3000;
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
    './splash/splash-1242x2208.png'
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

  /* 带超时的 fetch：3 秒拿不到网络响应就 reject，交给缓存回退 */
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

  /* 写缓存失败不能影响正常响应，所以统一吞掉异常 */
  function putInCache(request, response) {
    if (!response || !response.ok) return;
    var copy = response.clone();
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.put(request, copy);
    }).catch(function () {
      /* 配额满或响应不可缓存时静默跳过 */
    });
  }

  function precache() {
    return caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE);
    });
  }

  /* 删掉所有非当前版本的缓存，避免旧版本残留 */
  function cleanupCaches() {
    return caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key === CACHE_NAME) return Promise.resolve(false);
        return caches.delete(key);
      }));
    });
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

  /* 导航：网络优先，3 秒超时回退缓存 */
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
    return caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.ok && response.type === 'basic') {
          putInCache(request, response);
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
