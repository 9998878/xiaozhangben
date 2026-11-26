'use strict';
/*
 * tests/sw-cache.test.js
 * 2.44.1「SW 预缓存键 = 运行时查找键」行为级回归（验收报告 P1-1）。
 *
 * 运行：node tests/sw-cache.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 沙箱 + 内存 CacheStorage/Request/Response/fetch 桩，真跑 sw.js 的
 * install 预缓存 → 断网 → fetch 事件，断言：
 *   1. 预缓存写入键 === cacheFirst 查找键（js 分块带 ?v=<版本>，r 被剥掉）；
 *   2. 断网冷启动 21 个分块 ?v= 请求全部命中缓存，零网络请求；
 *   3. 旧 index 的上一版 ?v= 经 ignoreSearch 兜底命中同路径当前分块；
 *   4. 图标/入口等无 query 资源照常命中；导航断网回退 index.html；
 *   5. MISSING 清单带版本重试同键；旧版本清单作废。
 * 不锁源码字符串，锁的是真实缓存行为。只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/* ============================== 极简测试骨架 ============================== */

let passCount = 0;
let failCount = 0;

function section(title) {
  console.log('\n===== ' + title + ' =====');
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

function check(cond, label) {
  if (!cond) { throw new Error(label); }
}

function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ============================== 内存桩 ============================== */

const BASE = 'https://xzb.test/app/';
const m = /CACHE_NAME\s*=\s*'xzb2-v([^']+)'/.exec(SRC);
if (!m) { throw new Error('sw.js 找不到 CACHE_NAME'); }
const VERSION = m[1];
const CACHE_NAME = 'xzb2-v' + VERSION;

function abs(url) { return new URL(url, BASE + 'sw.js').href; }
function noSearch(url) { const u = new URL(url); u.search = ''; return u.href; }

class ResponseStub {
  constructor(body, opts) {
    const o = opts || {};
    this._body = body == null ? '' : String(body);
    this.status = o.status || 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = o.type || 'basic';
    this.headers = o.headers || {};
  }
  clone() { return new ResponseStub(this._body, { status: this.status, type: this.type, headers: this.headers }); }
  json() { return Promise.resolve(JSON.parse(this._body)); }
  text() { return Promise.resolve(this._body); }
}

class RequestStub {
  constructor(url, opts) {
    this.url = abs(typeof url === 'string' ? url : url.url);
    this.cache = opts && opts.cache;
  }
}

class CacheStub {
  constructor() { this.map = new Map(); }
  put(key, response) {
    const k = abs(typeof key === 'string' ? key : key.url);
    this.map.set(k, response.clone ? response.clone() : response);
    return Promise.resolve();
  }
  match(key, opts) {
    const k = abs(typeof key === 'string' ? key : key.url);
    if (this.map.has(k)) { return Promise.resolve(this.map.get(k)); }
    if (opts && opts.ignoreSearch) {
      const want = noSearch(k);
      for (const [ck, cv] of this.map) {
        if (noSearch(ck) === want) { return Promise.resolve(cv); }
      }
    }
    return Promise.resolve(undefined);
  }
  delete(key) {
    const k = abs(typeof key === 'string' ? key : key.url);
    return Promise.resolve(this.map.delete(k));
  }
  keys() { return Promise.resolve([...this.map.keys()].map((k) => new RequestStub(k))); }
}

const stores = new Map();
const cachesStub = {
  open(name) {
    if (!stores.has(name)) { stores.set(name, new CacheStub()); }
    return Promise.resolve(stores.get(name));
  },
  match(key, opts) {
    const chain = [...stores.values()];
    const next = (i) => {
      if (i >= chain.length) { return Promise.resolve(undefined); }
      return chain[i].match(key, opts).then((hit) => hit || next(i + 1));
    };
    return next(0);
  },
  keys() { return Promise.resolve([...stores.keys()]); },
  delete(name) { return Promise.resolve(stores.delete(name)); }
};

let networkOnline = true;
let fetchCalls = 0;
function fetchStub(request) {
  fetchCalls += 1;
  if (!networkOnline) { return Promise.reject(new Error('E_NETWORK_OFFLINE')); }
  const url = typeof request === 'string' ? request : request.url;
  return Promise.resolve(new ResponseStub('/* served: ' + url + ' */'));
}

const handlers = {};
const idleCallbacks = [];
const sandbox = {
  console,
  URL,
  Request: RequestStub,
  Response: ResponseStub,
  caches: cachesStub,
  fetch: fetchStub,
  setTimeout: () => 0,          /* 超时定时器不触发：fetch 桩即时决议 */
  clearTimeout: () => {},
  self: {
    location: { origin: 'https://xzb.test', href: BASE + 'sw.js' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    requestIdleCallback: (fn) => { idleCallbacks.push(fn); return idleCallbacks.length; }
  }
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'sw.js' });

function fire(type, request) {
  let responded = null;
  const event = {
    request,
    waitUntil: (p) => { responded = p; },
    respondWith: (p) => { responded = p; }
  };
  handlers[type](event);
  return responded;
}

function getReq(url, mode) {
  return { method: 'GET', url: abs(url), mode: mode || 'cors' };
}

const JS_CHUNKS = [
  'js/screens/home.js', 'js/screens/add.js', 'js/screens/ledger.js', 'js/screens/stats.js',
  'js/screens/calendar.js', 'js/screens/report.js', 'js/screens/accounts.js', 'js/screens/books.js',
  'js/screens/plan.js', 'js/screens/settings.js', 'js/screens/assistant.js',
  'js/modules/keypad.js', 'js/modules/icon-picker.js', 'js/modules/charts.js', 'js/modules/nl.js',
  'js/modules/core-assistant.js', 'js/modules/ai-insights.js', 'js/modules/habit.js',
  'js/modules/bill-import.js', 'js/modules/audit.js', 'js/modules/inline-edit.js'
];

/* ============================== 用例 ============================== */

(async function main() {
  section('1 install 预缓存：写入键带当前版本');

  await test('1.1 install 真跑完成，35 项全部入缓存', async () => {
    const p = fire('install', {});
    check(p && typeof p.then === 'function', 'install 应 waitUntil');
    await p;
    const cache = stores.get(CACHE_NAME);
    check(cache, '当前版本缓存应存在');
    checkEq(cache.map.size, 35, '预缓存条目数');
  });

  await test('1.2 21 个 js 分块写入键 === 运行时查找键（?v= 当前版本，r 被剥）', async () => {
    const cache = stores.get(CACHE_NAME);
    for (const chunk of JS_CHUNKS) {
      const writeKey = abs(chunk + '?v=' + VERSION);
      check(cache.map.has(writeKey), chunk + ' 应按 ?v=' + VERSION + ' 写入');
      /* 运行时请求带重试参数 r，归一化后应与写入键逐字相等 */
      const runtime = new URL(abs(chunk + '?v=' + VERSION + '&r=2'));
      runtime.searchParams.delete('r');
      checkEq(runtime.href, writeKey, chunk + ' 写入键=查找键');
    }
  });

  await test('1.3 入口/图标/启动图保持无 query 键（运行时这些请求不带 query）', async () => {
    const cache = stores.get(CACHE_NAME);
    ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './splash/splash-1170x2532.png'].forEach((u) => {
      check(cache.map.has(abs(u)), u + ' 应保持原键');
    });
  });

  section('2 断网冷启动：零网络请求全部命中');

  await test('2.1 断网后 21 个分块 ?v= 请求全部命中缓存，fetch 零调用', async () => {
    networkOnline = false;
    fetchCalls = 0;
    for (const chunk of JS_CHUNKS) {
      const p = fire('fetch', getReq(chunk + '?v=' + VERSION));
      check(p, chunk + ' 应被接管');
      const res = await p;
      check(res && res.ok, chunk + ' 断网应命中缓存');
      check(String(res._body).indexOf(chunk) >= 0, chunk + ' 命中的应是同路径分块');
    }
    checkEq(fetchCalls, 0, '断网命中不应发起任何网络请求');
  });

  await test('2.2 带重试参数 r=2 的请求同样命中', async () => {
    const res = await fire('fetch', getReq('js/screens/home.js?v=' + VERSION + '&r=2'));
    check(res && res.ok, 'r=2 重试应命中');
  });

  await test('2.3 旧 index 的上一版 ?v= 经 ignoreSearch 兜底命中当前分块', async () => {
    const res = await fire('fetch', getReq('js/screens/ledger.js?v=2.43.0'));
    check(res && res.ok, '旧 ?v= 应兜底命中');
    check(String(res._body).indexOf('js/screens/ledger.js') >= 0, '兜底应命中同路径当前分块');
  });

  await test('2.4 图标/清单无 query 请求断网命中', async () => {
    const res = await fire('fetch', getReq('icons/icon-512.png'));
    check(res && res.ok, '图标应命中');
    const res2 = await fire('fetch', getReq('manifest.webmanifest'));
    check(res2 && res2.ok, '清单应命中');
  });

  await test('2.5 导航断网回退缓存 index.html', async () => {
    const res = await fire('fetch', getReq('index.html', 'navigate'));
    check(res && res.ok, '导航断网应回退缓存');
  });

  await test('2.6 非 GET / 跨源请求不接管', async () => {
    const p1 = fire('fetch', { method: 'POST', url: abs('index.html'), mode: 'cors' });
    checkEq(p1, null, 'POST 不接管');
    const p2 = fire('fetch', { method: 'GET', url: 'https://other.test/x.js', mode: 'cors' });
    checkEq(p2, null, '跨源不接管');
  });

  section('3 activate 与 MISSING 重试');

  await test('3.1 activate 清旧版本缓存、保留 meta 旁路', async () => {
    stores.set('xzb2-v0.0.1', new CacheStub());
    stores.set('other-app-cache', new CacheStub());
    await fire('activate', {});
    check(!stores.has('xzb2-v0.0.1'), '旧版本缓存应被清');
    check(stores.has('other-app-cache'), '别家缓存不能动');
    check(stores.has(CACHE_NAME), '当前版本保留');
  });

  await test('3.2 当前版本 MISSING 清单按带版本键重试成功', async () => {
    const cache = stores.get(CACHE_NAME);
    const key = abs('js/modules/nl.js?v=' + VERSION);
    cache.map.delete(key);
    const meta = await cachesStub.open('xzb2-meta');
    await meta.put('/precache-missing.json', new ResponseStub(JSON.stringify({ v: CACHE_NAME, list: ['js/modules/nl.js?v=' + VERSION] })));
    networkOnline = true;
    check(idleCallbacks.length > 0, 'activate 应排入空闲重试');
    idleCallbacks[idleCallbacks.length - 1]();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check(cache.map.has(key), '重试应按原带版本键写回');
    const hit = await meta.match('/precache-missing.json');
    checkEq(hit, undefined, '全部成功应删除清单键');
    networkOnline = false;
  });

  await test('3.3 旧版本遗留清单直接作废，不写无版本键', async () => {
    const meta = await cachesStub.open('xzb2-meta');
    await meta.put('/precache-missing.json', new ResponseStub(JSON.stringify({ v: 'xzb2-v0.0.0', list: ['js/modules/nl.js'] })));
    idleCallbacks[idleCallbacks.length - 1]();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const hit = await meta.match('/precache-missing.json');
    checkEq(hit, undefined, '旧版本清单应被作废');
    const cache = stores.get(CACHE_NAME);
    check(!cache.map.has(abs('js/modules/nl.js')), '不应写入无版本键');
  });

  console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
  process.exit(failCount ? 1 : 0);
}());