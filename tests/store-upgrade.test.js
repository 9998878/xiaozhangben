'use strict';
/*
 * tests/store-upgrade.test.js
 * 2.44.2「IndexedDB 升级失败必须中止事务」行为级回归（2.44.1 验收报告 新 P3-2）。
 *
 * 运行：node tests/store-upgrade.test.js（scripts/test.js 自动收集）
 *
 * 做法：vm 加载 index.html 的 core 内联块（money/dates/schema/store），向沙箱注入
 * 假 indexedDB 工厂（浏览器语义：升级事务 abort → 请求 onerror；正常 → onsuccess），
 * 真跑 XZB.Core.store.open() 的 openRawDatabase/onupgradeneeded 路径，不复写实现。
 * 锁住：建 store 中途抛错时必须 abort 升级事务并降级内存模式，
 * 不得带着半套 schema resolve 成 idb 模式（后续读写 NotFoundError、用户看「空账」）。
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

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
vm.createContext(sandbox);
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/store.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: 'inline:' + marker });
}
const store = sandbox.XZB.Core.store;
if (!store || typeof store.open !== 'function' || !store.__test) {
  throw new Error('XZB.Core.store.open / __test 不可用');
}

/* ============================== 假 indexedDB（浏览器升级语义） ============================== */

/* opts.failOnStore：哪个 store 的 createObjectStore 抛错（模拟 ConstraintError 等）。
   语义对齐浏览器：升级回调里未捕获的异常或显式 transaction.abort() → 请求 onerror；
   否则升级事务提交 → onsuccess。半套 schema 不允许静默提交。 */
function makeFakeIdb(opts) {
  const calls = { upgrade: 0, abort: 0, success: 0, error: 0 };
  const stores = {};
  const factory = {
    open: function () {
      const req = { result: null, error: null, transaction: null };
      const tx = {
        aborted: false,
        abort: function () {
          if (!this.aborted) { this.aborted = true; calls.abort += 1; }
        }
      };
      const db = {
        objectStoreNames: {
          contains: function (n) { return Object.prototype.hasOwnProperty.call(stores, n); }
        },
        createObjectStore: function (n) {
          if (opts && opts.failOnStore === n) {
            const err = new Error('ConstraintError（模拟）：' + n);
            err.name = 'ConstraintError';
            throw err;
          }
          stores[n] = true;
          return { createIndex: function () { return {}; } };
        },
        close: function () {}
      };
      setTimeout(function () {
        req.result = db;
        req.transaction = tx;
        calls.upgrade += 1;
        try {
          if (typeof req.onupgradeneeded === 'function') { req.onupgradeneeded(); }
        } catch (e) {
          tx.abort(); /* 浏览器语义：未捕获异常同样中止升级事务 */
        }
        if (tx.aborted) {
          req.error = new Error('升级事务已中止');
          calls.error += 1;
          if (typeof req.onerror === 'function') { req.onerror(); }
        } else {
          calls.success += 1;
          if (typeof req.onsuccess === 'function') { req.onsuccess(); }
        }
      }, 0);
      return req;
    }
  };
  return { factory: factory, calls: calls, stores: stores };
}

function reset(fake) {
  store.__test.resetRuntime();
  store.__test.setDbName('xzb2-upgrade-test');
  store.__test.setOpenTimeout(500);
  sandbox.indexedDB = fake.factory;
}

/* ============================== 用例 ============================== */

(async function () {

section('1 正常升级：三仓齐全，idb 模式，零 abort');

await test('1.1 state/snapshots/photos 全建，open 返回 idb 非降级', async function () {
  const fake = makeFakeIdb({});
  reset(fake);
  const out = await store.open();
  checkEq(out.ok, true, 'open ok');
  checkEq(out.mode, 'idb', 'idb 模式');
  checkEq(out.degraded, false, '不降级');
  checkEq(fake.calls.abort, 0, '零 abort');
  checkEq(fake.calls.success, 1, 'onsuccess 恰好一次');
  ['state', 'snapshots', 'photos'].forEach(function (n) {
    check(fake.stores[n] === true, 'store ' + n + ' 已建');
  });
});

section('2 升级中途抛错：必须 abort 事务并降级内存（P3-2 核心回归）');

await test('2.1 snapshots 建失败 → abort 升级事务，不得 resolve 半套 schema', async function () {
  const fake = makeFakeIdb({ failOnStore: 'snapshots' });
  reset(fake);
  const out = await store.open();
  checkEq(fake.calls.abort, 1, 'catch 内必须显式 abort 升级事务');
  checkEq(fake.calls.success, 0, '半套 schema 不得走 onsuccess');
  checkEq(fake.calls.error, 1, '走 onerror');
  checkEq(out.ok, true, 'open 永远 resolve');
  checkEq(out.mode, 'memory', '降级内存模式');
  checkEq(out.degraded, true, 'degraded');
  checkEq(out.code, 'E_STORAGE_FALLBACK', '降级错误码');
});

await test('2.2 photos 建失败（老库升级路径）同样 abort + 降级', async function () {
  const fake = makeFakeIdb({ failOnStore: 'photos' });
  reset(fake);
  const out = await store.open();
  checkEq(fake.calls.abort, 1, 'abort');
  checkEq(fake.calls.success, 0, '不得提交半套 schema');
  checkEq(out.mode, 'memory', '内存降级');
  checkEq(out.code, 'E_STORAGE_FALLBACK', '错误码');
});

await test('2.3 首个 store 就失败：同样闭合，不残留 opening 状态', async function () {
  const fake = makeFakeIdb({ failOnStore: 'state' });
  reset(fake);
  const out = await store.open();
  checkEq(fake.calls.abort, 1, 'abort');
  checkEq(out.mode, 'memory', '内存降级');
  const again = await store.open();
  checkEq(again.mode, 'memory', '二次 open 幂等返回内存态');
  checkEq(fake.calls.upgrade, 1, '不得重复开库');
});

section('3 失败后环境恢复：reset 后能重新走 idb，不被内存态卡死');

await test('3.1 升级失败 → 换正常工厂 + resetRuntime → idb 恢复', async function () {
  const bad = makeFakeIdb({ failOnStore: 'snapshots' });
  reset(bad);
  const out1 = await store.open();
  checkEq(out1.mode, 'memory', '先降级');
  const good = makeFakeIdb({});
  reset(good);
  const out2 = await store.open();
  checkEq(out2.mode, 'idb', '环境恢复后回到 idb');
  checkEq(out2.degraded, false, '不降级');
  checkEq(good.calls.abort, 0, '正常路径零 abort');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
process.exit(failCount ? 1 : 0);

})();