'use strict';
/*
 * tests/store-load-wiring.test.js
 * store.load 的 IndexedDB 升级接线行为级回归——闭合盲区批次验收报告⑦-2
 * （此前只测 migrate.upgrade 纯函数，load 发现低版本后的真实分支零覆盖）。
 *
 * 运行：node tests/store-load-wiring.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 加载 index.html 的 money/dates/schema/store/migrate 内联块（全部真实实现），
 * 向沙箱注入支持 get/put/delete/getAll 事务的假 indexedDB（内存 Map），
 * 真跑 XZB.Core.store.load() 的 §3.3 精确分支：种子 / 同版本 / 低版本迁移写回 /
 * 未来版本拒绝 / 损坏库 / 迁移失败不落库。不复写实现、不锁源码字符串。
 * 只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

/* ============================== 沙箱装配 ============================== */

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
vm.createContext(sandbox);
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/store.js', 'js/core/migrate.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const store = sandbox.XZB.Core.store;
const schema = sandbox.XZB.Core.schema;
const migrate = sandbox.XZB.Core.migrate;
if (!store || typeof store.load !== 'function' || !store.__test) { throw new Error('store.load / __test 不可用'); }
if (!migrate || typeof migrate.upgrade !== 'function') { throw new Error('migrate.upgrade 不可用'); }
const SCHEMA_VERSION = schema.createDb().schemaVersion;

/* ============================== 假 indexedDB（内存 Map + 事务语义） ============================== */

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function makeFakeIdb(seedStateRecord) {
  const data = { state: new Map(), snapshots: new Map(), photos: new Map() };
  const stats = { stateReads: 0, statePuts: 0, snapshotPuts: 0 };
  if (seedStateRecord !== undefined) { data.state.set('db', clone(seedStateRecord)); }

  function makeReq(exec) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    setTimeout(function () {
      try {
        req.result = exec();
        if (req.onsuccess) { req.onsuccess(); }
      } catch (e) {
        req.error = e;
        if (req.onerror) { req.onerror(); }
      }
    }, 0);
    return req;
  }

  const factory = {
    open: function () {
      const req = { result: null, error: null, transaction: null,
        onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const upTx = { aborted: false, abort: function () { this.aborted = true; } };
      const db = {
        objectStoreNames: { contains: function (n) { return n in data; } },
        createObjectStore: function (n) { data[n] = data[n] || new Map(); return { createIndex: function () {} }; },
        close: function () {},
        transaction: function () {
          const tx = { oncomplete: null, onerror: null, onabort: null, error: null,
            objectStore: function (n) {
              const m = data[n];
              return {
                get: function (key) {
                  if (n === 'state') { stats.stateReads += 1; }
                  return makeReq(function () { return m.has(key) ? clone(m.get(key)) : undefined; });
                },
                put: function (rec) {
                  if (n === 'state') { stats.statePuts += 1; }
                  if (n === 'snapshots') { stats.snapshotPuts += 1; }
                  return makeReq(function () {
                    const key = rec.key !== undefined ? rec.key : rec.id;
                    m.set(key, clone(rec));
                    return key;
                  });
                },
                delete: function (key) { return makeReq(function () { m.delete(key); }); },
                getAll: function () { return makeReq(function () { return Array.from(m.values()).map(clone); }); }
              };
            }
          };
          /* 请求先落（第一拍），事务完成在后（第二拍），对齐浏览器时序 */
          setTimeout(function () {
            setTimeout(function () { if (tx.oncomplete) { tx.oncomplete(); } }, 0);
          }, 0);
          return tx;
        }
      };
      setTimeout(function () {
        req.result = db;
        req.transaction = upTx;
        try {
          if (req.onupgradeneeded) { req.onupgradeneeded(); }
        } catch (e) { upTx.abort(); }
        if (upTx.aborted) {
          req.error = new Error('升级事务已中止');
          if (req.onerror) { req.onerror(); }
        } else if (req.onsuccess) { req.onsuccess(); }
      }, 0);
      return req;
    }
  };
  return { factory: factory, data: data, stats: stats };
}

function reset(fake) {
  store.__test.resetRuntime();
  store.__test.setDbName('xzb2-load-wiring-test');
  store.__test.setOpenTimeout(1000);
  sandbox.indexedDB = fake.factory;
}

/* ============================== fixture ============================== */

const NOW = '2026-11-26T09:00:00+08:00';

function v4Db() {
  const db = schema.createDb(NOW);
  db.transactions.push(schema.createTransaction({
    bookId: 'bk_default', type: 'expense', amountCents: 1200,
    accountId: 'ac_wechat', categoryId: 'ca_food', date: '2026-11-20', time: '12:00', note: '午饭'
  }, NOW));
  return db;
}

/* v2 老库模拟：当前形状降版本号、剥掉 v3+ 才有的 photoIds（migrate 2→4 应补回 []） */
function v2Db() {
  const db = v4Db();
  db.schemaVersion = 2;
  db.transactions.forEach(function (tx) { delete tx.photoIds; });
  return db;
}

function stateRecord(value, savedAt) {
  return { key: 'db', value: clone(value), savedAt: savedAt || NOW };
}

/* ============================== 用例 ============================== */

(async function () {

section('1 首次启动与同版本加载');

await test('1.1 无记录：种子库落盘，meta.source=seed', async function () {
  const fake = makeFakeIdb();
  reset(fake);
  const out = await store.load();
  checkEq(out.ok, true, 'load ok');
  checkEq(out.meta.source, 'seed', 'seed 分支');
  checkEq(fake.stats.statePuts, 1, '种子写盘一次');
  const written = fake.data.state.get('db');
  checkEq(written.value.schemaVersion, SCHEMA_VERSION, '落盘版本为当前');
  check(schema.validateDb(out.data).ok, '种子库过校验');
});

await test('1.2 同版本正常库：meta.source=idb，零写盘', async function () {
  const fake = makeFakeIdb(stateRecord(v4Db()));
  reset(fake);
  const out = await store.load();
  checkEq(out.ok, true, 'load ok');
  checkEq(out.meta.source, 'idb', 'idb 分支');
  checkEq(fake.stats.statePuts, 0, '不写 state');
  checkEq(fake.stats.snapshotPuts, 0, '不写快照');
  checkEq(out.data.transactions.length, 1, '流水原样');
});

section('2 低版本库：真实走 migrate.upgrade 并写回（核心接线）');

await test('2.1 v2 库：pre-migrate 快照 + 升级写回 + photoIds 补齐 + migratedFrom=2', async function () {
  const fake = makeFakeIdb(stateRecord(v2Db()));
  reset(fake);
  const out = await store.load();
  checkEq(out.ok, true, 'load ok：' + JSON.stringify(out));
  checkEq(out.meta.source, 'migrated', 'migrated 分支');
  checkEq(out.meta.migratedFrom, 2, 'migratedFrom');
  checkEq(fake.stats.snapshotPuts, 1, '迁移前快照写盘');
  const snaps = Array.from(fake.data.snapshots.values());
  checkEq(snaps[0].reason, 'pre-migrate', '快照原因');
  checkEq(snaps[0].payload.schemaVersion, 2, '快照存的是旧值');
  checkEq(fake.stats.statePuts, 1, '升级结果写回一次');
  const written = fake.data.state.get('db').value;
  checkEq(written.schemaVersion, SCHEMA_VERSION, '写回版本为当前');
  check(Array.isArray(written.transactions[0].photoIds), 'photoIds 已补齐');
  check(schema.validateDb(out.data).ok, '升级后过整库校验');
  checkEq(out.data.transactions[0].note, '午饭', '流水内容不丢');
});

await test('2.2 升级幂等：同一 v2 库第二次 load 走 idb 分支，不再迁移', async function () {
  const fake = makeFakeIdb(stateRecord(v2Db()));
  reset(fake);
  await store.load();
  store.__test.resetRuntime();
  sandbox.indexedDB = fake.factory;
  const out2 = await store.load();
  checkEq(out2.meta.source, 'idb', '第二次不再迁移');
  checkEq(fake.stats.snapshotPuts, 1, '快照不重复写');
  checkEq(fake.stats.statePuts, 1, 'state 不重复写');
});

section('3 拒绝与损坏路径');

await test('3.1 未来版本：E_STORAGE_VERSION，原记录一个字节不动', async function () {
  const future = v4Db();
  future.schemaVersion = SCHEMA_VERSION + 1;
  const fake = makeFakeIdb(stateRecord(future));
  reset(fake);
  const out = await store.load();
  checkEq(out.ok, false, '拒绝');
  checkEq(out.code, 'E_STORAGE_VERSION', '错误码');
  checkEq(fake.stats.statePuts, 0, '不写盘');
  checkEq(fake.data.state.get('db').value.schemaVersion, SCHEMA_VERSION + 1, '原记录不动');
});

await test('3.2 损坏记录（非 JSON 字符串）：E_STORAGE_CORRUPT 可恢复，失败后允许重试', async function () {
  const fake = makeFakeIdb({ key: 'db', value: '{bad json', savedAt: NOW });
  reset(fake);
  const out = await store.load();
  checkEq(out.ok, false, '拒绝');
  checkEq(out.code, 'E_STORAGE_CORRUPT', '错误码');
  checkEq(out.recoverable, true, '可恢复标记');
  checkEq(fake.stats.statePuts, 0, '不写盘');
  const readsBefore = fake.stats.stateReads;
  await store.load();
  check(fake.stats.stateReads > readsBefore, '失败后 loadPromise 已重置，可重试');
});

await test('3.3 低版本但内容损坏：E_SCHEMA_INVALID，迁移失败不落库（快照仍写）', async function () {
  /* 坏目标（targetCents=0）能过 ensureShape 但过不了 validateDb → upgrade 真实拒绝 */
  const broken = v2Db();
  broken.goals.push({ id: 'gl_bad001', bookId: 'bk_default', name: '坏目标', targetCents: 0 });
  const fake = makeFakeIdb(stateRecord(broken));
  reset(fake);
  const out = await store.load();
  checkEq(out.ok, false, '拒绝');
  checkEq(out.code, 'E_SCHEMA_INVALID', '错误码');
  checkEq(fake.stats.statePuts, 0, '升级失败不得写回 state');
  checkEq(fake.stats.snapshotPuts, 1, '迁移前保护快照仍写');
  checkEq(fake.data.state.get('db').value.schemaVersion, 2, '原记录保持旧值');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);

})();