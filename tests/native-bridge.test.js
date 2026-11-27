'use strict';
/*
 * tests/native-bridge.test.js
 * iOS 原生桥接（native/bridge.js）单测。
 *
 * 运行：node tests/native-bridge.test.js（scripts/test.js 自动收集）
 *
 * 加载方式：整文件进 vm 沙箱（独立文件，非内联块），注入假 Capacitor / Filesystem / Share /
 * store / backup 驱动真实实现。覆盖：非原生 no-op、还原判定、收缩保护、防抖单飞调度器、
 * 镜像写入/去重/轮转/照片降级、导出改道与分享取消、镜像读取容错、空库还原接受/拒绝。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'native', 'bridge.js'), 'utf8');

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

async function drain() {
  for (let i = 0; i < 40; i += 1) { await Promise.resolve(); }
}

/* ============================== 沙箱装配 ============================== */

function makeSandbox(extra) {
  const sandbox = Object.assign({
    console: console,
    Promise: Promise, JSON: JSON, Date: Date, Number: Number, String: String,
    Array: Array, Object: Object, Math: Math, isNaN: isNaN,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'native/bridge.js' });
  return sandbox;
}

/* 原生环境沙箱：假插件 + 假 store/backup；加载即自动 init（与真机同路径）。
 * opts 可在加载后动态改（savedAt/counts/exportResult…），fake 闭包实时读取。 */
function makeNativeSandbox(opts) {
  opts = opts || {};
  const calls = {
    write: [], del: [], copy: [], read: [], share: [], exportJson: [], exportText: [],
    import: [], subscribe: 0, reload: 0, originalDownload: 0,
  };
  const filesystem = {
    writeFile: function (a) { calls.write.push(a); return Promise.resolve({ uri: 'file:///doc/' + a.path }); },
    readFile: function (a) {
      calls.read.push(a);
      return opts.mirrorText ? Promise.resolve({ data: opts.mirrorText }) : Promise.reject(new Error('not found'));
    },
    delete: function (a) { calls.del.push(a); return Promise.resolve(); },
    copy: function (a) { calls.copy.push(a); return Promise.resolve(); },
  };
  const backup = {
    exportJson: function (o) {
      calls.exportJson.push(o || {});
      if (o && o.includePhotos === false && opts.fallbackResult) { return Promise.resolve(opts.fallbackResult); }
      return Promise.resolve(opts.exportResult || {
        ok: true, content: '{"data":{"transactions":[]}}', bytes: 10,
        counts: { transactions: opts.counts == null ? 0 : opts.counts },
      });
    },
    exportText: function (fmt, o) {
      calls.exportText.push({ format: fmt, opts: o || {} });
      return Promise.resolve(opts.exportTextResult || {
        ok: true, filename: 'b.json', mime: 'application/json', content: '{}', bytes: 2,
      });
    },
    download: function () { calls.originalDownload += 1; return Promise.resolve({ ok: true }); },
    import: function (text, o) { calls.import.push({ text: text, opts: o }); return Promise.resolve(opts.importResult || { ok: true }); },
  };
  const store = {
    getSavedAt: function () { return opts.savedAt || 'T1'; },
    subscribe: function () { calls.subscribe += 1; },
  };
  const sandbox = makeSandbox({
    XZB: {
      Core: { backup: backup, store: store },
      app: {
        ready: Promise.resolve({}),
        db: function () { return opts.liveDb || { transactions: [] }; },
      },
    },
    Capacitor: {
      isNativePlatform: function () { return true; },
      Plugins: {
        Filesystem: filesystem,
        Share: {
          share: function (a) {
            calls.share.push(a);
            return opts.shareReject ? Promise.reject(new Error('Share canceled')) : Promise.resolve();
          },
        },
      },
    },
    localStorage: {
      getItem: function () { return opts.prefRaw || null; },
      setItem: function (k, v) { calls.prefSet = { key: k, value: v }; },
    },
    confirm: function () { return opts.confirm === true; },
    alert: function (m) { calls.alert = m; },
    location: { reload: function () { calls.reload += 1; } },
    document: { addEventListener: function () {}, visibilityState: 'visible' },
    addEventListener: function () {},
  });
  return { sandbox: sandbox, calls: calls, opts: opts, backup: backup };
}

function mirrorPayload(count, exportedAt) {
  const tx = [];
  for (let i = 0; i < count; i += 1) { tx.push({ id: 'tx_' + i }); }
  return JSON.stringify({ app: '小账本', exportedAt: exportedAt, data: { transactions: tx } });
}

/* ============================== 用例 ============================== */

async function main() {
  section('用例 1：非原生环境一律 no-op');
  await test('1.1 无 Capacitor → isNative=false、init=false', function () {
    const sb = makeSandbox({});
    const NB = sb.XZB.NativeBridge;
    check(NB, 'XZB.NativeBridge 应挂载');
    checkEq(NB.isNative(), false, '非原生');
    checkEq(NB.init(), false, 'init 拒绝');
  });
  await test('1.2 非原生不碰 backup.download', function () {
    const orig = function () { return Promise.resolve({ ok: true }); };
    const sb = makeSandbox({ XZB: { Core: { backup: { download: orig } } } });
    sb.XZB.NativeBridge.init();
    checkEq(sb.XZB.Core.backup.download, orig, 'download 原样');
    check(!sb.XZB.Core.backup.__nativePatched, '无补丁标记');
  });

  const pure = makeSandbox({}).XZB.NativeBridge;

  section('用例 2：还原判定 decideRestore（纯函数）');
  await test('2.1 镜像无账 → 不提示', function () {
    checkEq(pure.decideRestore({ liveTransactions: 0, mirrorTransactions: 0 }).reason, 'no-mirror-data', '空镜像');
  });
  await test('2.2 本机有账 → 绝不自动覆盖', function () {
    checkEq(pure.decideRestore({ liveTransactions: 3, mirrorTransactions: 5 }).reason, 'live-not-empty', '非空库');
  });
  await test('2.3 已拒绝过同一份镜像 → 不再骚扰', function () {
    const r = pure.decideRestore({ liveTransactions: 0, mirrorTransactions: 5, mirrorExportedAt: 'A', dismissedFor: 'A' });
    checkEq(r.reason, 'dismissed', '拒绝记忆');
  });
  await test('2.4 空库 + 镜像有账 → 提示还原', function () {
    const r = pure.decideRestore({ liveTransactions: 0, mirrorTransactions: 5, mirrorExportedAt: 'A' });
    checkEq(r.prompt, true, '应提示');
  });
  await test('2.5 拒绝的是旧镜像，新镜像仍提示', function () {
    const r = pure.decideRestore({ liveTransactions: 0, mirrorTransactions: 5, mirrorExportedAt: 'B', dismissedFor: 'A' });
    checkEq(r.prompt, true, '新镜像应提示');
  });

  section('用例 3：收缩保护 shouldRotate（纯函数）');
  await test('3.1 笔数变少才轮转', function () {
    checkEq(pure.shouldRotate(10, 0), true, '清空');
    checkEq(pure.shouldRotate(3, 2), true, '删除');
    checkEq(pure.shouldRotate(0, 5), false, '从无到有');
    checkEq(pure.shouldRotate(5, 5), false, '持平');
    checkEq(pure.shouldRotate(5, 6), false, '增长');
  });

  section('用例 4：防抖 + 单飞调度器（注入假时钟）');
  await test('4.1 防抖合并、忙时单飞、pending 补跑', async function () {
    const queued = [];
    let writes = 0;
    let release = null;
    const write = function () { writes += 1; return new Promise(function (r) { release = r; }); };
    const s = pure.createMirrorScheduler({
      write: write, debounceMs: 50,
      setTimeout: function (fn) { queued.push(fn); return queued.length; },
      clearTimeout: function (id) { queued[id - 1] = null; },
    });
    const fire = function () {
      const pendingTimers = queued.filter(Boolean);
      queued.length = 0;
      const f = pendingTimers[pendingTimers.length - 1];
      if (f) { f(); }
    };
    s.notify(); s.notify();
    checkEq(queued.filter(Boolean).length, 1, '两次 notify 只留一个定时器');
    fire(); await drain();
    checkEq(writes, 1, '首次写入');
    s.notify(); fire(); await drain();
    checkEq(writes, 1, '忙时不并发第二写');
    release(); await drain();
    checkEq(writes, 2, '完成后 pending 补跑');
    release(); await drain();
  });
  await test('4.2 flush 取消定时器立即写', async function () {
    const queued = [];
    let writes = 0;
    let release = null;
    const write = function () { writes += 1; return new Promise(function (r) { release = r; }); };
    const s = pure.createMirrorScheduler({
      write: write, debounceMs: 50,
      setTimeout: function (fn) { queued.push(fn); return queued.length; },
      clearTimeout: function (id) { queued[id - 1] = null; },
    });
    s.notify();
    s.flush(); await drain();
    checkEq(writes, 1, 'flush 立即写');
    checkEq(queued.filter(Boolean).length, 0, '定时器已取消');
    release(); await drain();
  });

  section('用例 5：镜像写入（假 Filesystem / backup）');
  await test('5.1 首启基线镜像落 Documents，标准 JSON 原样写入', async function () {
    const h = makeNativeSandbox({ savedAt: 'T1', counts: 3 });
    await drain();
    checkEq(h.calls.write.length, 1, '基线恰一写');
    const w = h.calls.write[0];
    checkEq(w.path, '小账本-自动备份.json', '镜像文件名');
    checkEq(w.directory, 'DOCUMENTS', 'Documents 目录');
    checkEq(w.encoding, 'utf8', 'UTF-8');
    checkEq(w.data, '{"data":{"transactions":[]}}', 'exportJson 产物原样');
    checkEq(h.calls.subscribe, 1, '已订阅 store');
    checkEq(h.sandbox.XZB.NativeBridge.status().lastMirrorCount, 3, '状态笔数');
  });
  await test('5.2 同一 savedAt 不重复写（去重）', async function () {
    const h = makeNativeSandbox({ savedAt: 'T1' });
    await drain();
    h.calls.write.length = 0;
    const wrote = await h.sandbox.XZB.NativeBridge.__test.writeMirror('auto');
    checkEq(wrote, false, '去重跳过');
    checkEq(h.calls.write.length, 0, '无写入');
  });
  await test('5.3 新 savedAt 触发新镜像', async function () {
    const h = makeNativeSandbox({ savedAt: 'T1' });
    await drain();
    h.opts.savedAt = 'T2';
    h.calls.write.length = 0;
    const wrote = await h.sandbox.XZB.NativeBridge.__test.writeMirror('auto');
    checkEq(wrote, true, '写入成功');
    checkEq(h.calls.write.length, 1, '恰一写');
  });
  await test('5.4 笔数收缩先轮转旧镜像为「上一份」', async function () {
    const h = makeNativeSandbox({ savedAt: 'T1', counts: 5 });
    await drain();
    h.opts.savedAt = 'T2'; h.opts.counts = 1;
    await h.sandbox.XZB.NativeBridge.__test.writeMirror('auto');
    checkEq(h.calls.del.length, 1, '删旧「上一份」');
    checkEq(h.calls.del[0].path, '小账本-自动备份-上一份.json', '轮转目标名');
    checkEq(h.calls.copy.length, 1, '复制旧镜像');
    checkEq(h.calls.copy[0].from, '小账本-自动备份.json', '轮转来源');
    checkEq(h.calls.copy[0].to, '小账本-自动备份-上一份.json', '轮转去向');
  });
  await test('5.5 照片超守卫自动降级纯账目镜像', async function () {
    const h = makeNativeSandbox({
      savedAt: 'T1',
      exportResult: { ok: false, code: 'E_EXPORT_TOO_LARGE', canExportWithoutPhotos: true },
      fallbackResult: { ok: true, content: '{"pure":true}', bytes: 12, counts: { transactions: 1 } },
    });
    await drain();
    check(h.calls.exportJson.length >= 2, '有降级重试');
    checkEq(h.calls.exportJson[1].includePhotos, false, '重试不含照片');
    const last = h.calls.write[h.calls.write.length - 1];
    checkEq(last.data, '{"pure":true}', '降级产物写入');
  });
  await test('5.6 导出失败只记状态不抛错', async function () {
    const h = makeNativeSandbox({ savedAt: 'T1', exportResult: { ok: false, code: 'E_X' } });
    await drain();
    const st = h.sandbox.XZB.NativeBridge.status();
    check(st.lastError && st.lastError.indexOf('镜像导出失败') >= 0, 'lastError 记录');
    checkEq(h.calls.write.length, 0, '失败不写文件');
  });

  section('用例 6：导出改道（Documents + 分享面板）');
  await test('6.1 download 被接管：写 Documents/导出/ 并拉分享面板', async function () {
    const h = makeNativeSandbox({});
    await drain();
    const res = await h.sandbox.XZB.Core.backup.download('json', {});
    checkEq(res.ok, true, '成功');
    checkEq(res.downloaded, true, 'UI 成功口径');
    checkEq(res.nativeSaved, true, '原生落盘标记');
    const w = h.calls.write[h.calls.write.length - 1];
    checkEq(w.path, '导出/b.json', '导出子目录');
    checkEq(h.calls.share.length, 1, '分享面板');
    checkEq(h.calls.share[0].url, 'file:///doc/导出/b.json', '分享文件 URI');
    checkEq(h.calls.originalDownload, 0, '不再走 Blob 下载');
  });
  await test('6.2 用户取消分享仍算成功（文件已落盘）', async function () {
    const h = makeNativeSandbox({ shareReject: true });
    await drain();
    const res = await h.sandbox.XZB.Core.backup.download('json', {});
    checkEq(res.ok, true, '取消不失败');
  });
  await test('6.3 序列化失败原样透传', async function () {
    const h = makeNativeSandbox({ exportTextResult: { ok: false, code: 'E_INVALID_INPUT' } });
    await drain();
    const res = await h.sandbox.XZB.Core.backup.download('json', {});
    checkEq(res.ok, false, '失败透传');
    checkEq(res.code, 'E_INVALID_INPUT', '错误码保留');
  });
  await test('6.4 CSV 同通道改道', async function () {
    const h = makeNativeSandbox({});
    await drain();
    await h.sandbox.XZB.Core.backup.download('csv', {});
    checkEq(h.calls.exportText[h.calls.exportText.length - 1].format, 'csv', '格式透传');
    checkEq(h.calls.write[h.calls.write.length - 1].path, '导出/b.json', 'CSV 也落 Documents');
  });

  section('用例 7：镜像读取与空库还原');
  await test('7.1 readMirror 解析笔数与导出时间', async function () {
    const h = makeNativeSandbox({ mirrorText: mirrorPayload(2, '2026-11-27T10:00:00.000Z') });
    await drain();
    const m = await h.sandbox.XZB.NativeBridge.__test.readMirror();
    checkEq(m.count, 2, '笔数');
    checkEq(m.exportedAt, '2026-11-27T10:00:00.000Z', '时间');
  });
  await test('7.2 空库 + 镜像有账 + 用户确认 → replace 导入并重载', async function () {
    const h = makeNativeSandbox({ confirm: true, mirrorText: mirrorPayload(2, '2026-11-27T10:00:00.000Z') });
    await drain();
    checkEq(h.calls.import.length, 1, '走既有 import');
    checkEq(h.calls.import[0].opts.mode, 'replace', '整体替换');
    checkEq(h.calls.reload, 1, '导入后重载');
  });
  await test('7.3 用户拒绝 → 记住 exportedAt 不再提示', async function () {
    const h = makeNativeSandbox({ confirm: false, mirrorText: mirrorPayload(2, '2026-11-27T10:00:00.000Z') });
    await drain();
    checkEq(h.calls.import.length, 0, '不导入');
    checkEq(h.calls.prefSet.key, 'xzb.native.v1', '偏好键');
    check(h.calls.prefSet.value.indexOf('2026-11-27T10:00:00.000Z') >= 0, '记住镜像时间');
  });
  await test('7.4 本机有账 → 绝不自动还原', async function () {
    const h = makeNativeSandbox({
      confirm: true,
      liveDb: { transactions: [{ id: 'tx_live' }] },
      mirrorText: mirrorPayload(2, '2026-11-27T10:00:00.000Z'),
    });
    await drain();
    checkEq(h.calls.import.length, 0, '非空库不覆盖');
  });
  await test('7.5 镜像文件不存在 → readMirror 返回 null', async function () {
    const h = makeNativeSandbox({});
    await drain();
    const m = await h.sandbox.XZB.NativeBridge.__test.readMirror();
    checkEq(m, null, '容错');
  });

  /* ============================== 汇总 ============================== */
  console.log('\n===== 汇总 =====');
  console.log('通过 ' + passCount + ' / 失败 ' + failCount);
  if (failCount > 0) { process.exit(1); }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});