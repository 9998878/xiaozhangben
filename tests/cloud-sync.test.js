#!/usr/bin/env node
'use strict';

/* tests/cloud-sync.test.js · 2.34.0 云备份专项
 * 范式：money-mask 的 vm 沙箱 + 源码锁。核心块从 index.html 按标记抽出，
 * mock fetch / localStorage / store / backup / 假时钟，直接驱动公开 API 与 testKit。
 * 覆盖：parseCloud、覆盖保护、payload 照片阈值与降级、enable 发现/新建/验活、
 *       防抖单飞与 savedAt 去重、restore 防回声与 truncated→raw_url、wipe 清键、零网络默认关。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'js', 'screens', 'settings.js'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log('\n== ' + name + ' ==');
}
function check(cond, msg) {
  if (cond) { pass += 1; console.log('  ✓ ' + msg); }
  else { fail += 1; failures.push(currentSection + ' · ' + msg); console.log('  ✗ ' + msg); }
}
function checkEq(actual, expected, msg) {
  check(actual === expected, msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------- 抽块 ---------------- */

function findInlineBlock(name) {
  const marker = '/* 小账本 2.0 · ' + name;
  const start = INDEX_HTML.indexOf(marker);
  if (start < 0) { throw new Error('找不到内联块标记：' + name); }
  const end = INDEX_HTML.indexOf('</script>', start);
  return INDEX_HTML.slice(start, end);
}

/* ---------------- 沙箱工厂 ---------------- */

function makeSandbox() {
  const calls = { fetch: [], export: [], import: [], refresh: 0 };
  const lsMap = new Map();
  let timers = [];
  let nextTimerId = 1;

  const state = {
    savedAt: '2026-11-22T10:00:00.000Z',
    photoBytes: 0,
    exportBytes: null,        // 覆盖 export 返回的 bytes
    exportFailWithPhotos: false,
    db: { transactions: [{ id: 'tx1', deleted: false }] },
    fetchHandler: null
  };

  const sandbox = {
    console,
    Date, Promise, JSON, Math, isFinite, isNaN, String, Number, Object, Array, RegExp, Error,
    setTimeout(fn, delay) { const id = nextTimerId++; timers.push({ id, fn, delay }); return id; },
    clearTimeout(id) { timers = timers.filter((t) => t.id !== id); },
    localStorage: {
      getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => { lsMap.set(k, String(v)); },
      removeItem: (k) => { lsMap.delete(k); }
    },
    addEventListener() {},
    removeEventListener() {},
    AbortController: function () { this.signal = {}; this.abort = function () {}; },
    fetch(url, init) {
      calls.fetch.push({ url, init });
      if (!state.fetchHandler) { return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve('') }); }
      return Promise.resolve(state.fetchHandler(url, init));
    },
    module: { exports: {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const XZB = {};
  sandbox.XZB = XZB;
  vm.runInContext(findInlineBlock('js/core/cloud-sync.js'), sandbox, { filename: 'cloud-sync.js' });
  const api = sandbox.module.exports;
  const Core = XZB.Core;

  Core.store = {
    get: () => state.db,
    getMeta: () => ({ savedAt: state.savedAt }),
    subscribe(fn) { state.subscriber = fn; return () => { state.subscriber = null; }; },
    photoStats: () => Promise.resolve({ ok: true, bytes: state.photoBytes }),
    import(text, opts) {
      calls.import.push({ text, opts });
      state.savedAt = '2026-11-22T11:00:00.000Z';
      return Promise.resolve({ ok: true });
    }
  };
  Core.backup = {
    export(format, opts) {
      calls.export.push(opts || {});
      if (state.exportFailWithPhotos && opts && opts.photos !== false) {
        return Promise.resolve({ ok: false, code: 'E_PHOTO_EXPORT_TOO_LARGE' });
      }
      const content = JSON.stringify({
        app: 'xiaozhangben', kind: 'backup', exportedAt: '2026-11-22T10:00:00.000Z',
        data: { updatedAt: state.savedAt, transactions: state.db.transactions }
      });
      return Promise.resolve({
        ok: true,
        content,
        bytes: state.exportBytes === null ? content.length : state.exportBytes,
        photos: { included: !!(opts && opts.photos !== false), count: opts && opts.photos !== false ? 1 : 0 }
      });
    }
  };
  XZB.app = { refresh() { calls.refresh += 1; return Promise.resolve({ ok: true }); } };

  function resp(status, data) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data))
    };
  }
  function runTimers() {
    const list = timers.slice();
    timers = [];
    list.forEach((t) => t.fn());
  }
  async function settle() {
    for (let i = 0; i < 12; i += 1) { await new Promise((r) => setImmediate(r)); }
  }

  return { api, Core, XZB, sandbox, state, calls, lsMap, resp, runTimers, settle, timers: () => timers };
}

const BACKUP_TEXT = JSON.stringify({
  app: 'xiaozhangben', kind: 'backup', exportedAt: '2026-11-22T09:00:00.000Z',
  data: {
    updatedAt: '2026-11-22T09:00:00.000Z',
    transactions: [
      { id: 'a', deleted: false },
      { id: 'b', deleted: true },
      { id: 'c', deleted: false }
    ]
  }
});

/* ============================== 用例 1：parseCloud ============================== */

section('用例 1：parseCloud 纯函数');

test('1.1 正常备份 → 笔数剔除软删', async () => {
  const { api } = makeSandbox();
  const res = api.testKit.parseCloud(BACKUP_TEXT);
  checkEq(res.ok, true, 'ok');
  checkEq(res.count, 2, '未删除笔数');
  checkEq(res.savedAt, '2026-11-22T09:00:00.000Z', 'savedAt 取 data.updatedAt');
});

test('1.2 坏 JSON / 缺 transactions → E_CLOUD_EMPTY', async () => {
  const { api } = makeSandbox();
  checkEq(api.testKit.parseCloud('{bad').code, 'E_CLOUD_EMPTY', '坏 JSON');
  checkEq(api.testKit.parseCloud('{"data":{}}').code, 'E_CLOUD_EMPTY', '缺 transactions');
  checkEq(api.testKit.parseCloud('null').code, 'E_CLOUD_EMPTY', 'null');
});

/* ============================== 用例 2：覆盖保护 ============================== */

section('用例 2：overwriteAllowed 覆盖保护');

test('2.1 新配置（lastSyncAt 空）绝不自动覆盖', async () => {
  const { api } = makeSandbox();
  api.testKit.setConfigForTest({ token: 't', gistId: 'g', enabled: true, lastSyncAt: null, lastSyncedSavedAt: null });
  checkEq(api.testKit.overwriteAllowed('2026-11-22T09:00:00.000Z'), false, '重装后禁止自动上传');
});

test('2.2 云端较新 → 禁；相等/较旧/1s 容差内 → 允', async () => {
  const { api } = makeSandbox();
  api.testKit.setConfigForTest({ token: 't', gistId: 'g', enabled: true, lastSyncAt: '2026-11-22T10:00:00.000Z', lastSyncedSavedAt: null });
  checkEq(api.testKit.overwriteAllowed('2026-11-22T10:00:02.000Z'), false, '云端晚 2s → 禁');
  checkEq(api.testKit.overwriteAllowed('2026-11-22T10:00:00.500Z'), true, '0.5s 容差内 → 允');
  checkEq(api.testKit.overwriteAllowed('2026-11-22T09:00:00.000Z'), true, '云端较旧 → 允');
  checkEq(api.testKit.overwriteAllowed(''), true, '云端无时间戳 → 允');
});

/* ============================== 用例 3：payload ============================== */

section('用例 3：buildPayload 照片阈值 / 降级 / 体积闸门');

test('3.1 照片 ≤2MB 带照片；>2MB 降级纯账目', async () => {
  const env = makeSandbox();
  env.state.photoBytes = 1024;
  let res = await env.api.testKit.buildPayload();
  checkEq(res.ok, true, '小照片 ok');
  checkEq(res.photosIncluded, true, '带上照片');
  checkEq(env.calls.export[0].photos, true, 'export photos:true');
  env.state.photoBytes = 3 * 1024 * 1024;
  res = await env.api.testKit.buildPayload();
  checkEq(res.ok, true, '大照片 ok');
  checkEq(res.photosIncluded, false, '不带照片');
  checkEq(env.calls.export[1].photos, false, 'export photos:false');
});

test('3.2 照片段导出失败 → 自动降级纯账目', async () => {
  const env = makeSandbox();
  env.state.photoBytes = 1024;
  env.state.exportFailWithPhotos = true;
  const res = await env.api.testKit.buildPayload();
  checkEq(res.ok, true, '降级后 ok');
  checkEq(res.photosIncluded, false, '降级不含照片');
  checkEq(env.calls.export.length, 2, '先带图失败再纯账目');
});

test('3.3 整份 >9MB → E_CLOUD_TOO_LARGE', async () => {
  const env = makeSandbox();
  env.state.exportBytes = 10 * 1024 * 1024;
  const res = await env.api.testKit.buildPayload();
  checkEq(res.code, 'E_CLOUD_TOO_LARGE', '拒传');
});

test('3.4 savedAt 取自 store.getMeta', async () => {
  const env = makeSandbox();
  const res = await env.api.testKit.buildPayload();
  checkEq(res.savedAt, '2026-11-22T10:00:00.000Z', 'savedAt');
});

/* ============================== 用例 4：enable ============================== */

section('用例 4：enable 验活 / 发现 / 新建');

test('4.1 空密钥 → E_CLOUD_NO_TOKEN，零请求', async () => {
  const env = makeSandbox();
  const res = await env.api.enable('  ');
  checkEq(res.code, 'E_CLOUD_NO_TOKEN', '拒空');
  checkEq(env.calls.fetch.length, 0, '零网络');
});

test('4.2 401 → E_CLOUD_AUTH，不开启', async () => {
  const env = makeSandbox();
  env.state.fetchHandler = () => env.resp(401, { message: 'Bad credentials' });
  const res = await env.api.enable('bad-token');
  checkEq(res.code, 'E_CLOUD_AUTH', '点名密钥');
  checkEq(env.api.status().enabled, false, '未开启');
});

test('4.3 无已有 gist → 建私有 gist，配置落盘，订阅启动', async () => {
  const env = makeSandbox();
  env.state.fetchHandler = (url, init) => {
    if (url.endsWith('/gists?per_page=100') && init.method === 'GET') { return env.resp(200, []); }
    if (url.endsWith('/gists') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      checkEq(body.public, false, 'POST public:false（私有）');
      check(!!body.files['xiaozhangben-backup.json'].content, 'POST 带当前账本内容');
      return env.resp(201, { id: 'gist-new', updated_at: '2026-11-22T10:00:01.000Z' });
    }
    throw new Error('意外请求 ' + url);
  };
  const res = await env.api.enable('good-token');
  checkEq(res.ok, true, '开启成功');
  checkEq(res.created, true, '新建');
  const st = env.api.status();
  checkEq(st.enabled, true, 'enabled');
  checkEq(st.gistId, 'gist-new', 'gistId');
  checkEq(st.lastSyncAt, '2026-11-22T10:00:01.000Z', 'lastSyncAt 取服务端时间');
  check(!!env.state.subscriber, '已订阅 store');
  const saved = JSON.parse(env.lsMap.get('xzb.cloud.v1'));
  checkEq(saved.token, 'good-token', '密钥落盘');
});

test('4.4 已有 gist（重装）→ 不新建、不自动上传，lastSyncAt 保持空', async () => {
  const env = makeSandbox();
  env.state.fetchHandler = (url, init) => {
    if (url.endsWith('/gists?per_page=100')) {
      return env.resp(200, [{ id: 'gist-old', files: { 'xiaozhangben-backup.json': {} } }]);
    }
    if (url.endsWith('/gists/gist-old') && init.method === 'GET') {
      return env.resp(200, {
        id: 'gist-old', updated_at: '2026-11-22T09:00:00.000Z',
        files: { 'xiaozhangben-backup.json': { content: BACKUP_TEXT, truncated: false } }
      });
    }
    throw new Error('意外请求 ' + url);
  };
  const res = await env.api.enable('good-token');
  checkEq(res.ok, true, '开启成功');
  checkEq(res.discovered, true, '发现已有');
  checkEq(res.cloud.count, 2, '云端笔数');
  const st = env.api.status();
  checkEq(st.gistId, 'gist-old', 'gistId 复用');
  checkEq(st.lastSyncAt, null, '重装后 lastSyncAt 为空（覆盖保护）');
  checkEq(env.calls.fetch.filter((c) => c.init.method === 'POST').length, 0, '没有新建');
  checkEq(env.calls.fetch.filter((c) => c.init.method === 'PATCH').length, 0, '没有自动上传');
});

test('4.5 同机重新开启（同 token 同 gist）保留同步基准', async () => {
  const env = makeSandbox();
  env.lsMap.set('xzb.cloud.v1', JSON.stringify({
    token: 'good-token', gistId: 'gist-old', enabled: false,
    lastSyncAt: '2026-11-22T10:00:00.000Z', lastSyncedSavedAt: '2026-11-22T10:00:00.000Z'
  }));
  env.state.fetchHandler = (url) => {
    if (url.endsWith('/gists?per_page=100')) {
      return env.resp(200, [{ id: 'gist-old', files: { 'xiaozhangben-backup.json': {} } }]);
    }
    return env.resp(200, {
      id: 'gist-old', updated_at: '2026-11-22T10:00:00.000Z',
      files: { 'xiaozhangben-backup.json': { content: BACKUP_TEXT, truncated: false } }
    });
  };
  const res = await env.api.enable('good-token');
  checkEq(res.ok, true, '开启成功');
  checkEq(env.api.status().lastSyncAt, '2026-11-22T10:00:00.000Z', '基准保留');
});

/* ============================== 用例 5：syncNow ============================== */

section('用例 5：syncNow 单飞 / 去重 / 覆盖保护 / 重建');

function enabledEnv(lastSyncAt, lastSyncedSavedAt) {
  const env = makeSandbox();
  env.api.testKit.setConfigForTest({
    token: 't', gistId: 'g1', enabled: true,
    lastSyncAt: lastSyncAt === undefined ? '2026-11-22T10:00:00.000Z' : lastSyncAt,
    lastSyncedSavedAt: lastSyncedSavedAt === undefined ? null : lastSyncedSavedAt
  });
  return env;
}

test('5.1 未开启 → E_CLOUD_DISABLED', async () => {
  const env = makeSandbox();
  const res = await env.api.syncNow();
  checkEq(res.code, 'E_CLOUD_DISABLED', '拒');
});

test('5.2 正常上传：PATCH 内容 + 基准更新', async () => {
  const env = enabledEnv();
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET') {
      return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:00:00.000Z', files: {} });
    }
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      check(!!body.files['xiaozhangben-backup.json'].content, 'PATCH 带备份文本');
      return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:05:00.000Z' });
    }
    throw new Error('意外请求');
  };
  const res = await env.api.syncNow();
  checkEq(res.ok, true, 'ok');
  const st = env.api.status();
  checkEq(st.lastSyncAt, '2026-11-22T10:05:00.000Z', 'lastSyncAt 更新为服务端时间');
  checkEq(st.lastError, null, '无错误');
  const saved = JSON.parse(env.lsMap.get('xzb.cloud.v1'));
  checkEq(saved.lastSyncedSavedAt, '2026-11-22T10:00:00.000Z', 'savedAt 基准落盘');
});

test('5.3 savedAt 未变 → skipped，不发 PATCH', async () => {
  const env = enabledEnv('2026-11-22T10:00:00.000Z', '2026-11-22T10:00:00.000Z');
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET') { return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:00:00.000Z', files: {} }); }
    throw new Error('不应 PATCH');
  };
  const res = await env.api.syncNow();
  checkEq(res.skipped, true, '跳过');
  checkEq(env.calls.fetch.filter((c) => c.init.method === 'PATCH').length, 0, '零 PATCH');
});

test('5.4 云端较新 → E_CLOUD_NEWER 不 PATCH；force 绕过', async () => {
  const env = enabledEnv();
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET') { return env.resp(200, { id: 'g1', updated_at: '2026-11-22T12:00:00.000Z', files: {} }); }
    if (init.method === 'PATCH') { return env.resp(200, { id: 'g1', updated_at: '2026-11-22T12:01:00.000Z' }); }
    throw new Error('意外请求');
  };
  let res = await env.api.syncNow();
  checkEq(res.code, 'E_CLOUD_NEWER', '暂停自动覆盖');
  checkEq(env.calls.fetch.filter((c) => c.init.method === 'PATCH').length, 0, '未 PATCH');
  res = await env.api.syncNow({ force: true });
  checkEq(res.ok, true, 'force 成功');
  checkEq(env.calls.fetch.filter((c) => c.init.method === 'PATCH').length, 1, 'force 才 PATCH');
});

test('5.5 单飞：在途时再调用 → queued，完成后补跑', async () => {
  const env = enabledEnv();
  let releaseGet;
  const gate = new Promise((r) => { releaseGet = r; });
  let getCount = 0;
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET') {
      getCount += 1;
      if (getCount === 1) { return gate.then(() => env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:00:00.000Z', files: {} })); }
      return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:05:00.000Z', files: {} });
    }
    if (init.method === 'PATCH') { return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:06:00.000Z' }); }
    throw new Error('意外请求');
  };
  const first = env.api.syncNow();
  const second = await env.api.syncNow();
  checkEq(second.queued, true, '在途 → queued');
  releaseGet();
  await first;
  await env.settle();
  env.runTimers();           // schedule(0) 的补跑
  await env.settle();
  check(getCount >= 2, '补跑发生（GET ≥2 次）');
});

test('5.6 gist 404 → 清 gistId，下次重建', async () => {
  const env = enabledEnv();
  let phase = 'gone';
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET' && phase === 'gone') { return env.resp(404, {}); }
    if (init.method === 'POST') { return env.resp(201, { id: 'g2', updated_at: '2026-11-22T10:10:00.000Z' }); }
    if (init.method === 'GET') { return env.resp(200, { id: 'g2', updated_at: '2026-11-22T10:10:00.000Z', files: {} }); }
    if (init.method === 'PATCH') { return env.resp(200, { id: 'g2', updated_at: '2026-11-22T10:11:00.000Z' }); }
    throw new Error('意外请求');
  };
  let res = await env.api.syncNow();
  checkEq(res.code, 'E_CLOUD_NOT_FOUND', '404 归一');
  checkEq(env.api.status().gistId, '', 'gistId 清空');
  phase = 'rebuild';
  res = await env.api.syncNow();
  checkEq(res.ok, true, '重建成功');
  checkEq(res.created, true, '走新建');
  checkEq(env.api.status().gistId, 'g2', '新 gistId');
});

/* ============================== 用例 6：restore ============================== */

section('用例 6：restore 防回声 / truncated / 空备份');

test('6.1 恢复走 store.import(replace)，基准对齐防回声', async () => {
  const env = enabledEnv(null, null);
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET') {
      return env.resp(200, {
        id: 'g1', updated_at: '2026-11-22T09:00:00.000Z',
        files: { 'xiaozhangben-backup.json': { content: BACKUP_TEXT, truncated: false } }
      });
    }
    throw new Error('意外请求');
  };
  const res = await env.api.restore();
  checkEq(res.ok, true, 'ok');
  checkEq(res.count, 2, '恢复笔数');
  checkEq(env.calls.import.length, 1, 'import 一次');
  checkEq(env.calls.import[0].opts.mode, 'replace', 'replace 模式');
  checkEq(env.calls.refresh, 1, 'app.refresh 调用');
  const st = env.api.status();
  checkEq(st.lastSyncedSavedAt, '2026-11-22T11:00:00.000Z', 'savedAt 基准 = 恢复后');
  checkEq(st.lastSyncAt, '2026-11-22T09:00:00.000Z', 'lastSyncAt = 云端时间戳');
  /* 回声检查：恢复触发 store 事件后不应再上传 */
  env.state.subscriber = env.api.testKit.onStoreEvent;
  env.state.subscriber({ type: 'save', savedAt: '2026-11-22T11:00:00.000Z' });
  checkEq(env.timers().length, 0, '同 savedAt 不排程（防回声）');
});

test('6.2 truncated → raw_url 取全文', async () => {
  const env = enabledEnv(null, null);
  env.state.fetchHandler = (url, init) => {
    if (url === 'https://api.github.com/gists/g1') {
      return env.resp(200, {
        id: 'g1', updated_at: '2026-11-22T09:00:00.000Z',
        files: { 'xiaozhangben-backup.json': { content: '{"partial":', truncated: true, raw_url: 'https://gist.githubusercontent.com/raw/full.json' } }
      });
    }
    if (url === 'https://gist.githubusercontent.com/raw/full.json') {
      return env.resp(200, BACKUP_TEXT);
    }
    throw new Error('意外请求 ' + url);
  };
  const res = await env.api.restore();
  checkEq(res.ok, true, 'ok');
  checkEq(env.calls.import[0].text, BACKUP_TEXT, 'import 拿到全文');
});

test('6.3 空/坏备份 → E_CLOUD_EMPTY，不 import', async () => {
  const env = enabledEnv(null, null);
  env.state.fetchHandler = () => env.resp(200, {
    id: 'g1', updated_at: '2026-11-22T09:00:00.000Z',
    files: { 'xiaozhangben-backup.json': { content: 'not json', truncated: false } }
  });
  const res = await env.api.restore();
  checkEq(res.code, 'E_CLOUD_EMPTY', '拒空');
  checkEq(env.calls.import.length, 0, '未 import');
});

/* ============================== 用例 7：调度 ============================== */

section('用例 7：防抖调度 / flush / 零网络默认关');

test('7.1 store save 事件 → 防抖排程；重复 savedAt 不排程；external 忽略', async () => {
  const env = enabledEnv('2026-11-22T10:00:00.000Z', '2026-11-22T10:00:00.000Z');
  env.api.testKit.onStoreEvent({ type: 'save', savedAt: '2026-11-22T10:30:00.000Z' });
  checkEq(env.timers().length, 1, '新 savedAt 排程');
  checkEq(env.timers()[0].delay, 3000, '3s 防抖');
  env.api.testKit.onStoreEvent({ type: 'save', savedAt: '2026-11-22T10:30:00.000Z' });
  checkEq(env.timers().length, 1, '重复事件合并（仍 1 个定时器）');
  env.api.testKit.onStoreEvent({ type: 'external', savedAt: '2026-11-22T10:40:00.000Z' });
  checkEq(env.timers().length, 1, 'external 不触发');
});

test('7.2 flush：needsSync 时立即同步，小 payload 走 keepalive', async () => {
  const env = enabledEnv('2026-11-22T10:00:00.000Z', null);
  env.state.fetchHandler = (url, init) => {
    if (init.method === 'GET') { return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:00:00.000Z', files: {} }); }
    if (init.method === 'PATCH') {
      checkEq(init.keepalive, true, '小 payload keepalive');
      return env.resp(200, { id: 'g1', updated_at: '2026-11-22T10:20:00.000Z' });
    }
    throw new Error('意外请求');
  };
  env.api.flush();
  await env.settle();
  checkEq(env.calls.fetch.filter((c) => c.init.method === 'PATCH').length, 1, 'flush 触发 PATCH');
});

test('7.3 未开启 init → 零网络、不订阅', async () => {
  const env = makeSandbox();
  const res = env.api.init();
  checkEq(res.enabled, false, '未开启');
  checkEq(env.calls.fetch.length, 0, '零请求');
  check(!env.state.subscriber, '未订阅');
});

test('7.4 disable 停订阅；clearConfig 删键（wipe 语义）', async () => {
  const env = makeSandbox();
  env.state.fetchHandler = (url, init) => {
    if (url.endsWith('/gists?per_page=100')) { return env.resp(200, []); }
    return env.resp(201, { id: 'g1', updated_at: '2026-11-22T10:00:00.000Z' });
  };
  await env.api.enable('t');
  check(!!env.state.subscriber, '开启后订阅');
  env.api.disable();
  check(!env.state.subscriber, '关闭后退订');
  checkEq(env.api.status().enabled, false, 'enabled=false');
  check(env.lsMap.has('xzb.cloud.v1'), '关闭仍留配置（便于重开）');
  env.api.clearConfig();
  check(!env.lsMap.has('xzb.cloud.v1'), 'wipe 删键');
});

test('7.5 readConfig 容错：坏 JSON / 缺 token → null', async () => {
  const env = makeSandbox();
  env.lsMap.set('xzb.cloud.v1', '{bad');
  checkEq(env.api.testKit.readConfig(), null, '坏 JSON');
  env.lsMap.set('xzb.cloud.v1', JSON.stringify({ enabled: true }));
  checkEq(env.api.testKit.readConfig(), null, '缺 token');
});

/* ============================== 用例 8：源码锁 ============================== */

section('用例 8：源码锁（接线 / UI / 清理）');

test('8.1 settings.js 云备份入口与最小 sheet 在位', async () => {
  check(SETTINGS_JS.indexOf("title: '云备份'") >= 0, '数据页签有云备份行');
  check(SETTINGS_JS.indexOf('function openCloudSheet') >= 0, 'openCloudSheet 存在');
  check(SETTINGS_JS.indexOf("label: '保存并开启', kind: 'primary'") >= 0, '保存并开启主按钮');
  check(SETTINGS_JS.indexOf("label: '从云端恢复'") >= 0, '从云端恢复按钮');
  check(SETTINGS_JS.indexOf("label: '关闭', kind: 'ghost'") >= 0, '关闭按钮');
  check(SETTINGS_JS.indexOf('api.TOKEN_PAGE') >= 0, '获取密钥链接走模块常量');
});

test('8.2 index.html 启动接线与 wipe 清理在位', async () => {
  check(INDEX_HTML.indexOf('initCloudSync();') >= 0, '启动调用 initCloudSync');
  check(INDEX_HTML.indexOf('function initCloudSync') >= 0, 'initCloudSync 定义');
  check(INDEX_HTML.indexOf('clearCloudKey: function') >= 0, 'lock.configure 注入 clearCloudKey');
  check(INDEX_HTML.indexOf("opts.clearCloudKey === 'function'") >= 0, 'runWipe 调 clearCloudKey');
  check(INDEX_HTML.indexOf("global.localStorage.removeItem('xzb.cloud.v1')") >= 0, '兜底直删配置键');
});

test('8.3 核心块挂载与零网络默认关', async () => {
  check(INDEX_HTML.indexOf('Core.cloudSync = api;') >= 0, '三挂载之一');
  const block = findInlineBlock('js/core/cloud-sync.js');
  check(block.indexOf('https://api.github.com') >= 0, '只出站 GitHub API');
  check(block.indexOf("CONFIG_KEY = 'xzb.cloud.v1'") >= 0, '配置键单一真源');
  check(block.indexOf('public: false') >= 0, 'gist 恒私有');
});

/* ---------------- 运行 ---------------- */

(async function run() {
  for (const t of tests) {
    try {
      await t.fn();
    } catch (error) {
      fail += 1;
      failures.push(t.name + ' · 抛异常：' + (error && error.message));
      console.log('  ✗ ' + t.name + ' 抛异常：' + (error && error.stack || error));
    }
  }
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length) {
    console.log('失败明细：\n- ' + failures.join('\n- '));
    process.exit(1);
  }
})();