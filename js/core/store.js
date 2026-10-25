/* 小账本 2.0 · js/core/store.js · owner: dba（T02）
 * 契约锚点：CONTRACT.md
 *   §3.1 统一返回形状 / 存储方法签名
 *   §3.2 IndexedDB 结构（库名 xzb2、结构版本 1、仓库 state + snapshots）
 *   §3.3 load() 的精确分支   §3.4 save(patch)   §3.5 transaction(fn)
 *   §3.6 快照与保留策略       §3.7 导出格式（实现在 backup.js，这里转发）
 *   §3.8 导入语义（实现在 backup.js，这里转发）
 *   §3.10 内存降级模式        §8 错误码词表        §2.13 规范排序
 *   §13 v1 迁移（实现在 migrate.js）
 * 硬规则：
 *   1) 本文件是整个应用唯一允许打开 IndexedDB 的模块；
 *   2) 余额不落库，一律由流水实时聚合（这里不存任何余额冗余字段）；
 *   3) 所有写操作经同一个 Promise 队列串行化，并发写不会互相覆盖；
 *   4) 所有公开异步方法只 resolve、不 reject，统一 {ok:true,...} / {ok:false,code,message}；
 *   5) 错误码只取 CONTRACT §8 中真实存在的值，文案逐字一致。
 * 挂载：XZB.Core.store（同时 XZB.core.store），Node 下 module.exports 双挂载。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  var schema = Core.schema;
  var dates = Core.dates;
  var money = Core.money;
  if (!schema || !dates) {
    throw new Error('store.js 依赖 money.js / dates.js / schema.js，请按 core 加载顺序引入');
  }

  /* ============================== 常量 ============================== */

  var DB_NAME = 'xzb2';
  var DB_VERSION = 1;                 // IndexedDB 的结构版本，与 schemaVersion 无关
  var STORE_STATE = 'state';          // keyPath: key，记录 { key:'db', value:Db, savedAt:IsoStr }
  var STORE_SNAPSHOTS = 'snapshots';  // keyPath: id，索引 by_at / by_reason
  var STATE_KEY = 'db';
  var OPEN_TIMEOUT_MS = 5000;
  var SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;
  var SCHEMA_VERSION = 3;

  var TABLES = [
    'books', 'accounts', 'categories', 'transactions', 'budgets',
    'categoryBudgets', 'recurring', 'goals', 'goalDeposits'
  ];
  var WRITABLE_KEYS = TABLES.concat(['settings']);
  var SNAPSHOT_REASONS = ['auto', 'manual', 'pre-import', 'pre-restore', 'pre-migrate'];
  /* §3.6 保留策略：auto 12 / manual 8 / pre-* 合计 10 / 合计 30 */
  var RETENTION = { auto: 12, manual: 8, pre: 10, total: 30 };

  /* §8 文案逐字拷贝，禁止在调用点另写 */
  var MESSAGES = {
    E_UNKNOWN: '操作失败，请重试',
    E_INVALID_INPUT: '输入不完整或格式不对',
    E_SCHEMA_INVALID: '数据校验失败，未保存',
    E_SCHEMA_ID: '无法生成唯一 ID，请重试',
    E_STORAGE_BLOCKED: '本地存储被占用，请关闭其他标签页后重试',
    E_STORAGE_VERSION: '数据版本高于当前应用，请更新应用',
    E_STORAGE_CORRUPT: '本地数据损坏，可从快照恢复',
    E_STORAGE_WRITE: '保存失败，请重试',
    E_STORAGE_QUOTA: '存储空间不足，请先导出备份并清理旧快照',
    E_STORAGE_FALLBACK: '当前使用临时存储，关闭页面后数据会丢失',
    E_STORE_BUSY: '正在保存，请稍后',
    E_STORE_TX: '操作失败，请重试',
    E_STORE_TX_ASYNC: '内部错误：事务不能异步',
    E_STORE_ABORT: '操作已取消',
    E_SNAPSHOT_TOO_LARGE: '数据太大，无法创建快照',
    E_SNAPSHOT_NOT_FOUND: '快照不存在或已被清理',
    E_IMPORT_EMPTY: '文件是空的',
    E_IMPORT_TOO_LARGE: '文件超过 10MB，无法导入',
    E_IMPORT_INVALID: '不是小账本备份文件',
    E_IMPORT_FAILED: '导入失败，数据已回滚',
    E_EXPORT_FAILED: '导出失败，请重试',
    E_TX_NOT_FOUND: '记录不存在或已删除',
    E_TX_DELETED: '记录已删除',
    E_TX_TYPE: '收支类型不能直接改，请删除后重记',
    E_BOOK_MISSING: '账本不存在',
    E_BOOK_LAST: '至少要保留一个未归档账本',
    E_ACCOUNT_MISSING: '账户不存在',
    E_CATEGORY_MISSING: '分类不存在',
    E_RECURRING_NOT_FOUND: '定期账单不存在',
    E_GOAL_NOT_FOUND: '存钱目标不存在',
    E_GOAL_DEPOSIT_NOT_FOUND: '存入记录不存在',
    /* 以下为 schema.js 校验会透传的错误码，同样逐字取自 §8 */
    E_ACCOUNT_ARCHIVED: '账户已归档，不能记账',
    E_ACCOUNT_TYPE: '账户类型不对',
    E_ACCOUNT_LIMIT: '额度必须是非负整数',
    E_ACCOUNT_BILLDAY: '账单日必须是 1–28',
    E_BOOK_ARCHIVED: '账本已归档，不能记账',
    E_CATEGORY_KIND: '分类的收支类型不匹配',
    E_CATEGORY_DUP: '同类型下已有同名分类',
    E_CATEGORY_NAME: '系统分类不能改名',
    E_TX_AMOUNT: '金额必须大于 0',
    E_TX_DATE: '日期无效',
    E_TX_NOTE: '备注最多 80 个字',
    E_TX_TAG: '标签最多 5 个，每个最多 10 字',
    E_TX_CATEGORY_REQUIRED: '请选择分类',
    E_TRANSFER_SAME: '转出和转入不能是同一个账户',
    E_BUDGET_MONTH: '预算月份格式不对',
    E_BUDGET_AMOUNT: '预算必须是非负整数',
    E_RECURRING_RULE: '周期规则不完整',
    E_GOAL_TARGET: '目标金额必须大于 0',
    E_GOAL_DEPOSIT_AMOUNT: '存入金额必须大于 0'
  };

  /* ============================== 运行时状态 ============================== */

  var state = 'closed';        // closed | opening | ready | memory
  var rawDb = null;            // IDBDatabase
  var cache = null;            // 内存中的 Db 真源
  var savedAt = null;          // 最近一次成功写入时间（IsoStr）
  var bytes = 0;               // 最近一次写入的 UTF-8 字节数
  var rev = 0;                 // 每次成功写入 +1，供 UI 判断是否需要重渲染
  var mode = 'idb';            // idb | memory（§3.10）
  var degraded = false;
  var lastOpenCode = null;
  var openPromise = null;
  var loadPromise = null;
  var queueTail = Promise.resolve();
  var inTx = false;            // 事务 fn 执行期间为 true，用于拦截嵌套事务/保存
  var listeners = [];
  var memRecord = null;        // 内存模式下的 { key, value, savedAt }
  var memSnapshots = [];
  var lastWriteMs = 0;
  var dbName = DB_NAME;        // 测试钩子：允许换库名跑隔离用例
  var openTimeout = OPEN_TIMEOUT_MS;
  var persistedOnce = false;

  /* ============================== 基础工具 ============================== */

  function messageOf(code) {
    return MESSAGES[code] || MESSAGES.E_UNKNOWN;
  }

  /* 统一失败形状（§3.1） */
  function fail(code, extra) {
    var out = { ok: false, code: code, message: messageOf(code) };
    if (extra) {
      if (extra.path) { out.path = extra.path; }
      if (extra.cause) { out.cause = String(extra.cause); }
      if (extra.warnings) { out.warnings = extra.warnings; }
      if (extra.recoverable) { out.recoverable = true; }
      if (extra.snapshotId) { out.snapshotId = extra.snapshotId; }
    }
    return out;
  }

  /* 深拷贝：Db 是纯 JSON 数据，避免引用泄漏（§3.2） */
  function clone(value) {
    if (value === null || value === undefined) { return value; }
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function cmpStr(a, b) {
    var left = a === null || a === undefined ? '' : String(a);
    var right = b === null || b === undefined ? '' : String(b);
    if (left < right) { return -1; }
    if (left > right) { return 1; }
    return 0;
  }

  function nowIso() {
    return dates.nowIso();
  }

  /* updatedAt 语义：等于最近一次成功写入时间，并保证同一秒内多次写入也严格递增，
   * 这样「合并导入时 updatedAt 新者胜」在连点时不会判错。 */
  function touchIso(prevIso) {
    var ms = Date.now();
    if (ms < lastWriteMs) { ms = lastWriteMs; }
    var iso = dates.nowIso(ms);
    if (typeof prevIso === 'string' && prevIso !== '' && iso <= prevIso) {
      var parsed = Date.parse(prevIso);
      if (!isFinite(parsed) || isNaN(parsed)) { parsed = ms; }
      ms = parsed + 1000;
      iso = dates.nowIso(ms);
    }
    lastWriteMs = ms;
    return iso;
  }

  function idbFactory() {
    var g = global;
    var factory = g.indexedDB || g.webkitIndexedDB || g.mozIndexedDB || null;
    if (!factory || typeof factory.open !== 'function') { return null; }
    return factory;
  }

  function requestDone(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB request failed')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction error')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
    });
  }

  function readAllWithCursor(store) {
    return new Promise(function (resolve, reject) {
      var items = [];
      var req = store.openCursor();
      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) { resolve(items); return; }
        items.push(cursor.value);
        cursor.continue();
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB cursor failed')); };
    });
  }

  /* ============================== 内存降级（§3.10） ============================== */

  function enterMemoryMode(code, cause) {
    state = 'memory';
    mode = 'memory';
    degraded = true;
    lastOpenCode = code || 'E_STORAGE_FALLBACK';
    rawDb = null;
    if (!memRecord) { memRecord = null; }
    return {
      ok: true,
      mode: 'memory',
      degraded: true,
      code: lastOpenCode,
      message: messageOf(lastOpenCode),
      cause: cause ? String(cause) : undefined
    };
  }

  /* ============================== open / close ============================== */

  function openRawDatabase() {
    return new Promise(function (resolve, reject) {
      var factory = idbFactory();
      if (!factory) { reject(new Error('indexedDB 不存在')); return; }
      var settled = false;
      var req;
      try {
        req = factory.open(dbName, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        var timeoutError = new Error('IndexedDB 打开超时');
        timeoutError.idbReason = 'timeout';
        reject(timeoutError);
      }, openTimeout);

      function finish(fn, value) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      req.onupgradeneeded = function () {
        var database = req.result;
        try {
          if (!database.objectStoreNames.contains(STORE_STATE)) {
            database.createObjectStore(STORE_STATE, { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains(STORE_SNAPSHOTS)) {
            var snapshots = database.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
            snapshots.createIndex('by_at', 'at', { unique: false });
            snapshots.createIndex('by_reason', 'reason', { unique: false });
          }
        } catch (error) {
          /* 升级回调里抛错会让事务回滚，交给 onerror 处理 */
        }
      };
      req.onblocked = function () {
        var blockedError = new Error('IndexedDB 被其他标签页占用');
        blockedError.idbReason = 'blocked';
        finish(reject, blockedError);
      };
      req.onsuccess = function () {
        var database = req.result;
        database.onversionchange = function () {
          try { database.close(); } catch (error) { /* 忽略 */ }
          rawDb = null;
          state = 'closed';
        };
        finish(resolve, database);
      };
      req.onerror = function () {
        finish(reject, req.error || new Error('IndexedDB 打开失败'));
      };
    });
  }

  /* open(): 永远 resolve；失败自动降级为内存模式（§3.3 首分支 / §3.10） */
  function open() {
    if (state === 'ready' || state === 'memory') {
      return Promise.resolve({
        ok: true,
        mode: mode,
        degraded: degraded,
        code: state === 'memory' ? lastOpenCode : undefined,
        message: state === 'memory' ? messageOf(lastOpenCode) : undefined
      });
    }
    if (openPromise) { return openPromise; }
    state = 'opening';
    openPromise = openRawDatabase().then(function (database) {
      rawDb = database;
      state = 'ready';
      mode = 'idb';
      degraded = false;
      lastOpenCode = null;
      return { ok: true, mode: 'idb', degraded: false };
    }, function (error) {
      var reason = error && error.idbReason;
      var code = reason === 'blocked' ? 'E_STORAGE_BLOCKED' : 'E_STORAGE_FALLBACK';
      return enterMemoryMode(code, error && error.message);
    });
    return openPromise;
  }

  function close() {
    if (rawDb) {
      try { rawDb.close(); } catch (error) { /* 忽略 */ }
    }
    rawDb = null;
    state = 'closed';
    openPromise = null;
    loadPromise = null;
  }

  /* ============================== 底层读写 ============================== */

  function readStateRecord() {
    if (mode === 'memory' || state === 'memory') {
      return Promise.resolve(memRecord ? clone(memRecord) : null);
    }
    if (!rawDb) { return Promise.reject(new Error('数据库未打开')); }
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = rawDb.transaction([STORE_STATE], 'readonly');
      } catch (error) { reject(error); return; }
      var request;
      try {
        request = tx.objectStore(STORE_STATE).get(STATE_KEY);
      } catch (error) { reject(error); return; }
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error || new Error('读取失败')); };
      tx.onerror = function () { reject(tx.error || new Error('读取失败')); };
      tx.onabort = function () { reject(tx.error || new Error('读取中止')); };
    });
  }

  /* 写入 state 记录；成功返回 { ok:true, savedAt }，配额失败抛 idbReason:'quota' */
  function writeStateRecord(record) {
    if (mode === 'memory' || state === 'memory') {
      memRecord = clone(record);
      return Promise.resolve({ ok: true, savedAt: record.savedAt });
    }
    if (!rawDb) { return Promise.reject(new Error('数据库未打开')); }
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = rawDb.transaction([STORE_STATE], 'readwrite');
      } catch (error) { reject(error); return; }
      var done = txDone(tx);
      try {
        tx.objectStore(STORE_STATE).put(clone(record));
      } catch (error) { reject(error); return; }
      done.then(function () {
        resolve({ ok: true, savedAt: record.savedAt });
      }, function (error) {
        if (error && error.name === 'QuotaExceededError') { error.idbReason = 'quota'; }
        reject(error);
      });
    });
  }

  function readSnapshotRecords() {
    if (mode === 'memory' || state === 'memory') {
      return Promise.resolve(clone(memSnapshots));
    }
    if (!rawDb) {
      return Promise.reject(new Error('数据库未打开'));
    }
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = rawDb.transaction([STORE_SNAPSHOTS], 'readonly');
      } catch (error) { reject(error); return; }
      var store;
      try { store = tx.objectStore(STORE_SNAPSHOTS); } catch (error) { reject(error); return; }
      var collected = [];
      var settled = false;
      function finish(items) {
        if (settled) { return; }
        settled = true;
        resolve(items);
      }
      function abort(error) {
        if (settled) { return; }
        settled = true;
        reject(error);
      }
      if (typeof store.getAll === 'function') {
        var allRequest = store.getAll();
        allRequest.onsuccess = function () { collected = allRequest.result || []; };
        allRequest.onerror = function () { abort(allRequest.error || new Error('读取快照失败')); };
        tx.oncomplete = function () { finish(collected); };
      } else {
        var cursorRequest = store.openCursor();
        cursorRequest.onsuccess = function () {
          var cursor = cursorRequest.result;
          if (cursor) {
            collected.push(cursor.value);
            cursor.continue();
          } else {
            finish(collected);
          }
        };
        cursorRequest.onerror = function () { abort(cursorRequest.error || new Error('读取快照失败')); };
      }
      tx.onerror = function () { abort(tx.error || new Error('读取快照失败')); };
      tx.onabort = function () { abort(tx.error || new Error('读取快照中止')); };
    });
  }

  function putSnapshotRecord(record) {
    if (mode === 'memory' || state === 'memory') {
      memSnapshots.push(clone(record));
      return Promise.resolve(true);
    }
    if (!rawDb) { return Promise.reject(new Error('数据库未打开')); }
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = rawDb.transaction([STORE_SNAPSHOTS], 'readwrite');
      } catch (error) { reject(error); return; }
      var done = txDone(tx);
      try {
        tx.objectStore(STORE_SNAPSHOTS).put(clone(record));
      } catch (error) { reject(error); return; }
      done.then(function () { resolve(true); }, function (error) {
        if (error && error.name === 'QuotaExceededError') { error.idbReason = 'quota'; }
        reject(error);
      });
    });
  }

  function deleteSnapshotRecords(ids) {
    if (!ids || ids.length === 0) { return Promise.resolve(0); }
    if (mode === 'memory' || state === 'memory') {
      memSnapshots = memSnapshots.filter(function (item) { return ids.indexOf(item.id) < 0; });
      return Promise.resolve(ids.length);
    }
    if (!rawDb) { return Promise.reject(new Error('数据库未打开')); }
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = rawDb.transaction([STORE_SNAPSHOTS], 'readwrite');
      } catch (error) { reject(error); return; }
      var done = txDone(tx);
      var store;
      try { store = tx.objectStore(STORE_SNAPSHOTS); } catch (error) { reject(error); return; }
      for (var i = 0; i < ids.length; i++) {
        store.delete(ids[i]);
      }
      done.then(function () { resolve(ids.length); }, reject);
    });
  }

  /* ============================== 订阅 ============================== */

  function notify(type) {
    var event = { type: type, savedAt: savedAt, rev: rev };
    var snapshot = listeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](event); } catch (error) { /* 单个订阅者出错不影响其他 */ }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') { return function () {}; }
    listeners.push(listener);
    return function () {
      var index = listeners.indexOf(listener);
      if (index >= 0) { listeners.splice(index, 1); }
    };
  }

  /* ============================== 串行队列（§3.5） ============================== */

  function enqueue(task) {
    var run = queueTail.then(function () { return task(); }, function () { return task(); });
    queueTail = run.then(function () {}, function () {});
    return run;
  }

  /* 自动快照计数（计时/计数阈值在 backup.js） */
  function noteWriteForBackup() {
    var backup = Core.backup;
    if (backup && typeof backup.noteWrite === 'function') {
      try { backup.noteWrite(); } catch (error) { /* 快照调度失败不影响主流程 */ }
    }
  }

  /* ============================== load（§3.3） ============================== */

  function persistStorageOnce() {
    if (persistedOnce) { return; }
    persistedOnce = true;
    try {
      var navigatorObj = global.navigator;
      if (navigatorObj && navigatorObj.storage && typeof navigatorObj.storage.persist === 'function') {
        var result = navigatorObj.storage.persist();
        if (result && typeof result.catch === 'function') { result.catch(function () {}); }
      }
    } catch (error) { /* 静默 */ }
  }

  function latestSnapshotId(records) {
    var best = null;
    for (var i = 0; i < records.length; i++) {
      var item = records[i];
      if (!item || !isObject(item.payload)) { continue; }
      if (!best || cmpStr(item.at, best.at) > 0) { best = item; }
    }
    return best ? best.id : null;
  }

  function corruptFailure(snapshotId) {
    return fail('E_STORAGE_CORRUPT', {
      recoverable: true,
      snapshotId: snapshotId || undefined
    });
  }

  function installCache(db, savedAtValue) {
    cache = clone(db);
    savedAt = savedAtValue || null;
    rev += 1;
    bytes = utf8Bytes(JSON.stringify(cache));
    state = mode === 'memory' ? 'memory' : 'ready';
  }

  function loadInternal() {
    return open().then(function () {
      if (state === 'memory') {
        var seed = schema.createDb();
        installCache(seed, null);
        return {
          ok: true,
          data: clone(cache),
          meta: {
            source: 'memory',
            degraded: true,
            savedAt: null,
            code: lastOpenCode || 'E_STORAGE_FALLBACK',
            warnings: [messageOf('E_STORAGE_FALLBACK')]
          }
        };
      }
      return readStateRecord().then(function (record) {
        var recordSavedAt = record && dates.isValidIsoStr(record.savedAt) ? record.savedAt : null;
        if (!record || !record.value) {
          /* 首次启动：生成种子库并落盘 */
          var seeded = schema.createDb();
          var stamp = nowIso();
          seeded.updatedAt = stamp;
          return writeStateRecord({ key: STATE_KEY, value: clone(seeded), savedAt: stamp }).then(function () {
            installCache(seeded, stamp);
            persistStorageOnce();
            return {
              ok: true,
              data: clone(cache),
              meta: { source: 'seed', degraded: false, savedAt: stamp }
            };
          }, function () {
            /* 首次落盘失败：仍然把种子给到 App，避免白屏 */
            installCache(seeded, null);
            return {
              ok: true,
              data: clone(cache),
              meta: {
                source: 'seed',
                degraded: false,
                savedAt: null,
                warnings: [messageOf('E_STORAGE_WRITE')]
              }
            };
          });
        }

        var value = record.value;
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch (error) { value = null; }
        }
        if (!isObject(value) || !Number.isInteger(value.schemaVersion)) {
          return readSnapshotRecords().then(function (records) {
            return corruptFailure(latestSnapshotId(records));
          }, function () {
            return corruptFailure(null);
          });
        }
        if (value.schemaVersion > SCHEMA_VERSION) {
          return fail('E_STORAGE_VERSION');
        }
        if (value.schemaVersion < SCHEMA_VERSION) {
          /* 旧版本库：先做迁移前快照，再迁移写回（§3.3）。
             这里不能走 snapshotInternal——它第一步 ensureLoaded() 会等本次 load
             完成，而 load 又在等快照，互相等死（2.5 库内升级首次被触发时发现）。
             改为直接用旧值写保护性快照：写失败不阻断迁移，只进 meta.warnings。 */
          var runUpgrade = function () {
            var migrate = Core.migrate;
            var upgraded;
            try {
              upgraded = migrate && typeof migrate.upgrade === 'function'
                ? migrate.upgrade(value)
                : { ok: false, code: 'E_SCHEMA_INVALID' };
            } catch (error) {
              upgraded = { ok: false, code: 'E_SCHEMA_INVALID' };
            }
            if (!upgraded || !upgraded.ok) { return fail('E_SCHEMA_INVALID'); }
            var checked = schema.validateDb(upgraded.db);
            if (!checked.ok) { return fail('E_SCHEMA_INVALID', { path: checked.path }); }
            var iso = touchIso(upgraded.db.updatedAt);
            upgraded.db.updatedAt = iso;
            upgraded.db.schemaVersion = SCHEMA_VERSION;
            upgraded.db.appVersion = XZB.version;
            return writeStateRecord({
              key: STATE_KEY,
              value: clone(upgraded.db),
              savedAt: iso
            }).then(function () {
              installCache(upgraded.db, iso);
              persistStorageOnce();
              return {
                ok: true,
                data: clone(cache),
                meta: {
                  source: 'migrated',
                  degraded: false,
                  savedAt: iso,
                  migratedFrom: value.schemaVersion,
                  warnings: upgraded.warnings || []
                }
              };
            }, function () {
              return fail('E_STORAGE_WRITE');
            });
          };
          var preWarnings = [];
          var preText = '';
          try { preText = JSON.stringify(value); } catch (preError) { preText = ''; }
          var preRecord = {
            id: schema.newId('sn') || ('sn_' + Date.now().toString(36)),
            at: nowIso(),
            reason: 'pre-migrate',
            schemaVersion: SCHEMA_VERSION,
            appVersion: XZB.version,
            bytes: utf8Bytes(preText),
            counts: snapshotCounts(value),
            payload: clone(value)
          };
          return putSnapshotRecord(preRecord).then(function () {
            return pruneSnapshots().catch(function () { return 0; });
          }, function () {
            preWarnings.push('迁移前快照失败，已跳过');
            return 0;
          }).then(function () {
            var result = runUpgrade();
            if (result && result.ok && preWarnings.length) {
              result.meta = clone(result.meta) || {};
              result.meta.warnings = (result.meta.warnings || []).concat(preWarnings);
            }
            return result;
          });
        }

        var validated = schema.validateDb(value);
        if (!validated.ok) {
          return readSnapshotRecords().then(function (records) {
            return corruptFailure(latestSnapshotId(records));
          }, function () {
            return corruptFailure(null);
          });
        }
        installCache(value, recordSavedAt);
        persistStorageOnce();
        return {
          ok: true,
          data: clone(cache),
          meta: { source: 'idb', degraded: false, savedAt: recordSavedAt }
        };
      }, function (error) {
        /* IDB 读失败：降级内存模式，仍然给种子，不阻断启动 */
        var reason = error && error.idbReason;
        if (reason === 'quota') { return fail('E_STORAGE_QUOTA'); }
        enterMemoryMode('E_STORAGE_FALLBACK', error && error.message);
        var seedFallback = schema.createDb();
        installCache(seedFallback, null);
        return {
          ok: true,
          data: clone(cache),
          meta: {
            source: 'memory',
            degraded: true,
            savedAt: null,
            code: lastOpenCode,
            warnings: [messageOf('E_STORAGE_FALLBACK')]
          }
        };
      });
    });
  }

  function load() {
    if (loadPromise) { return loadPromise; }
    loadPromise = loadInternal();
    /* 失败后允许重试（例如用户恢复快照后再 load） */
    loadPromise.then(function (result) {
      if (!result || !result.ok) { loadPromise = null; }
    }, function () { loadPromise = null; });
    return loadPromise;
  }

  /* 需要 Db 的写操作：未加载时先 load */
  function ensureLoaded() {
    if (cache) { return Promise.resolve({ ok: true }); }
    return load().then(function (result) {
      if (!result.ok) { return result; }
      return { ok: true };
    });
  }

  /* ============================== 提交管线（§3.4 / §3.5） ============================== */

  function dropOldestAutoSnapshot() {
    return readSnapshotRecords().then(function (records) {
      var autos = records.filter(function (item) { return item.reason === 'auto'; });
      if (autos.length === 0) { return false; }
      autos.sort(function (a, b) { return cmpStr(a.at, b.at); });
      return deleteSnapshotRecords([autos[0].id]).then(function () { return true; });
    }, function () { return false; });
  }

  function writeWithQuotaRetry(record) {
    return writeStateRecord(record).then(function (result) {
      return result;
    }, function (error) {
      if (!error || error.idbReason !== 'quota') {
        return fail('E_STORAGE_WRITE', { cause: error && error.message });
      }
      /* §3.4：配额失败允许删最旧 1 条 auto 快照后重试一次 */
      return dropOldestAutoSnapshot().then(function (removed) {
        if (!removed) { return fail('E_STORAGE_QUOTA'); }
        return writeStateRecord(record).then(function (result) {
          return result;
        }, function () {
          return fail('E_STORAGE_QUOTA');
        });
      }, function () {
        return fail('E_STORAGE_QUOTA');
      });
    });
  }

  function commit(draft, type) {
    var iso = touchIso(draft && draft.updatedAt);
    draft.updatedAt = iso;
    draft.schemaVersion = SCHEMA_VERSION;
    draft.appVersion = XZB.version;
    var validated = schema.validateDb(draft);
    if (!validated.ok) {
      return Promise.resolve(fail(validated.code || 'E_SCHEMA_INVALID', { path: validated.path }));
    }
    var text = JSON.stringify(draft);
    var size = utf8Bytes(text);
    var record = { key: STATE_KEY, value: clone(draft), savedAt: iso };
    return writeWithQuotaRetry(record).then(function (result) {
      if (!result.ok) { return result; }
      cache = draft;
      savedAt = iso;
      bytes = size;
      rev += 1;
      notify(type || 'save');
      noteWriteForBackup();
      return { ok: true, savedAt: iso, bytes: size };
    });
  }

  /* save(patch)：只允许顶层数据键（§3.4） */
  function saveInternal(patch) {
    if (!isObject(patch)) {
      return Promise.resolve(fail('E_INVALID_INPUT', { path: 'patch' }));
    }
    return ensureLoaded().then(function (ready) {
      if (!ready.ok) { return ready; }
      var candidate = clone(cache);
      for (var i = 0; i < WRITABLE_KEYS.length; i++) {
        var key = WRITABLE_KEYS[i];
        if (!Object.prototype.hasOwnProperty.call(patch, key)) { continue; }
        if (key === 'settings') {
          if (!isObject(patch.settings)) {
            return fail('E_INVALID_INPUT', { path: 'settings' });
          }
          candidate.settings = Object.assign({}, candidate.settings, patch.settings);
        } else {
          /* 数组键整体替换；类型不对交给 validateDb 判 E_SCHEMA_INVALID（§3.4） */
          candidate[key] = clone(patch[key]);
        }
      }
      return commit(candidate, 'save').then(function (result) {
        if (!result.ok) { return result; }
        return { ok: true, savedAt: result.savedAt, bytes: result.bytes };
      });
    });
  }

  function save(patch) {
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return enqueue(function () { return saveInternal(patch); });
  }

  function transactionInternal(fn) {
    return ensureLoaded().then(function (ready) {
      if (!ready.ok) { return ready; }
      var draft = clone(cache);
      var result;
      inTx = true;
      try {
        result = fn(draft);
      } catch (error) {
        inTx = false;
        return fail('E_STORE_TX', { cause: error && error.message });
      }
      inTx = false;
      if (result && typeof result.then === 'function') {
        /* §3.5：fn 必须同步；异步 fn 直接判错，避免半写入 */
        if (typeof result.catch === 'function') { result.catch(function () {}); }
        return fail('E_STORE_TX_ASYNC');
      }
      if (isObject(result) && result.abort === true) {
        /* §3.5：code 透传（由动作决定），未给出时用 E_STORE_ABORT */
        var abortCode = typeof result.code === 'string' && result.code !== ''
          ? result.code
          : 'E_STORE_ABORT';
        var abortFailure = {
          ok: false,
          code: abortCode,
          message: typeof result.message === 'string' && result.message !== ''
            ? result.message
            : messageOf(abortCode)
        };
        if (result.path) { abortFailure.path = result.path; }
        if (result.cause) { abortFailure.cause = String(result.cause); }
        return abortFailure;
      }
      return commit(draft, 'save').then(function (written) {
        if (!written.ok) { return written; }
        return {
          ok: true,
          value: result && typeof result === 'object' ? result.value : undefined,
          savedAt: written.savedAt,
          bytes: written.bytes
        };
      });
    });
  }

  function transaction(fn) {
    if (typeof fn !== 'function') {
      return Promise.resolve(fail('E_STORE_TX'));
    }
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return enqueue(function () { return transactionInternal(fn); });
  }

  function flush() {
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return enqueue(function () {
      return ensureLoaded().then(function (ready) {
        if (!ready.ok) { return ready; }
        var iso = nowIso();
        return writeStateRecord({
          key: STATE_KEY,
          value: clone(cache),
          savedAt: savedAt || iso
        }).then(function (result) {
          if (!result.ok) { return fail('E_STORAGE_WRITE'); }
          return { ok: true, savedAt: savedAt || iso };
        }, function (error) {
          return fail('E_STORAGE_WRITE', { cause: error && error.message });
        });
      });
    });
  }

  /* ============================== 快照（§3.6） ============================== */

  function snapshotCounts(db) {
    var counts = {};
    for (var i = 0; i < TABLES.length; i++) {
      counts[TABLES[i]] = Array.isArray(db[TABLES[i]]) ? db[TABLES[i]].length : 0;
    }
    return counts;
  }

  function snapshotMetaOf(record) {
    return {
      id: record.id,
      at: record.at,
      reason: record.reason,
      schemaVersion: record.schemaVersion,
      appVersion: record.appVersion,
      bytes: record.bytes,
      counts: record.counts || {}
    };
  }

  function pruneSnapshots() {
    return readSnapshotRecords().then(function (records) {
      var sorted = records.slice().sort(function (a, b) { return cmpStr(a.at, b.at); });
      var groups = { auto: [], manual: [], pre: [] };
      for (var i = 0; i < sorted.length; i++) {
        var item = sorted[i];
        if (item.reason === 'auto') { groups.auto.push(item); }
        else if (item.reason === 'manual') { groups.manual.push(item); }
        else { groups.pre.push(item); }
      }
      var doomed = [];
      function trimGroup(list, limit) {
        if (list.length <= limit) { return; }
        var overflow = list.length - limit;
        for (var index = 0; index < overflow; index++) { doomed.push(list[index].id); }
        list.splice(0, overflow);
      }
      trimGroup(groups.auto, RETENTION.auto);
      trimGroup(groups.pre, RETENTION.pre);
      trimGroup(groups.manual, RETENTION.manual);
      var remaining = groups.auto.concat(groups.pre, groups.manual);
      remaining.sort(function (a, b) { return cmpStr(a.at, b.at); });
      /* §3.6：合计超限先删最旧 auto，再删最旧 pre-*，最后删最旧 manual */
      var order = groups.auto.concat(groups.pre, groups.manual);
      while (remaining.length > RETENTION.total && order.length > 0) {
        var victim = order.shift();
        if (doomed.indexOf(victim.id) >= 0) { continue; }
        doomed.push(victim.id);
        var position = remaining.indexOf(victim);
        if (position >= 0) { remaining.splice(position, 1); }
      }
      if (doomed.length === 0) { return 0; }
      return deleteSnapshotRecords(doomed).then(function () { return doomed.length; });
    }, function () { return 0; });
  }

  /* 内部快照：不排队（调用方已在队列内或启动期） */
  function snapshotInternal(reason) {
    var why = SNAPSHOT_REASONS.indexOf(reason) >= 0 ? reason : 'manual';
    return ensureLoaded().then(function (ready) {
      if (!ready.ok) { return ready; }
      if (why === 'auto' && cache.settings && cache.settings.snapshotAuto === false) {
        return { ok: true, snapshot: null, skipped: true };
      }
      if (mode === 'memory' || state === 'memory') {
        /* §3.10：内存模式没有持久化快照 */
        return fail('E_STORAGE_FALLBACK');
      }
      var payload = clone(cache);
      var text = JSON.stringify(payload);
      var size = utf8Bytes(text);
      if (size > SNAPSHOT_MAX_BYTES) {
        return fail('E_SNAPSHOT_TOO_LARGE');
      }
      var id = schema.newId('sn') || ('sn_' + Date.now().toString(36));
      var record = {
        id: id,
        at: nowIso(),
        reason: why,
        schemaVersion: SCHEMA_VERSION,
        appVersion: XZB.version,
        bytes: size,
        counts: snapshotCounts(payload),
        payload: payload
      };
      return putSnapshotRecord(record).then(function () {
        return pruneSnapshots().then(function () {
          return { ok: true, snapshot: snapshotMetaOf(record) };
        }, function () {
          return { ok: true, snapshot: snapshotMetaOf(record) };
        });
      }, function (error) {
        if (error && error.idbReason === 'quota') { return fail('E_STORAGE_QUOTA'); }
        return fail('E_STORAGE_WRITE', { cause: error && error.message });
      });
    });
  }

  function snapshot(reason) {
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    var why = reason === undefined || reason === null ? 'manual' : reason;
    return enqueue(function () { return snapshotInternal(why); });
  }

  function listSnapshots() {
    var task = function () {
      return readSnapshotRecords().then(function (records) {
        var items = records.map(snapshotMetaOf);
        items.sort(function (a, b) { return cmpStr(b.at, a.at); });
        return { ok: true, items: items };
      }, function (error) {
        return fail('E_STORAGE_WRITE', { cause: error && error.message });
      });
    };
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return enqueue(task);
  }

  function restoreInternal(snapshotId) {
    return ensureLoaded().then(function (ready) {
      if (!ready.ok) { return ready; }
      return snapshotInternal('pre-restore').then(function (prepared) {
        if (!prepared.ok) { return prepared; }
        return readSnapshotRecords().then(function (records) {
          var found = null;
          for (var i = 0; i < records.length; i++) {
            if (records[i].id === snapshotId) { found = records[i]; break; }
          }
          if (!found) { return fail('E_SNAPSHOT_NOT_FOUND'); }
          var payload = found.payload;
          if (!isObject(payload) || !Number.isInteger(payload.schemaVersion)) {
            return fail('E_STORAGE_CORRUPT');
          }
          if (payload.schemaVersion > SCHEMA_VERSION) { return fail('E_STORAGE_VERSION'); }
          var restored = payload;
          if (payload.schemaVersion < SCHEMA_VERSION) {
            var migrate = Core.migrate;
            var upgraded = migrate && typeof migrate.upgrade === 'function'
              ? migrate.upgrade(payload)
              : { ok: false };
            if (!upgraded.ok) { return fail('E_STORAGE_CORRUPT'); }
            restored = upgraded.db;
          }
          var validated = schema.validateDb(restored);
          if (!validated.ok) { return fail('E_STORAGE_CORRUPT'); }
          var draft = clone(restored);
          return commit(draft, 'restore').then(function (written) {
            if (!written.ok) { return written; }
            return { ok: true, data: clone(cache), savedAt: written.savedAt };
          });
        }, function () {
          return fail('E_STORAGE_WRITE');
        });
      });
    });
  }

  function restore(snapshotId) {
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    if (typeof snapshotId !== 'string' || snapshotId === '') {
      return Promise.resolve(fail('E_SNAPSHOT_NOT_FOUND'));
    }
    return enqueue(function () { return restoreInternal(snapshotId); });
  }

  function removeSnapshot(snapshotId) {
    var task = function () {
      return readSnapshotRecords().then(function (records) {
        var exists = records.some(function (item) { return item.id === snapshotId; });
        if (!exists) { return { ok: true, removed: false }; }
        return deleteSnapshotRecords([snapshotId]).then(function () {
          return { ok: true, removed: true };
        }, function (error) {
          return fail('E_STORAGE_WRITE', { cause: error && error.message });
        });
      }, function (error) {
        return fail('E_STORAGE_WRITE', { cause: error && error.message });
      });
    };
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return enqueue(task);
  }

  /* ============================== reset ============================== */

  function reset() {
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return enqueue(function () {
      return ensureLoaded().then(function (ready) {
        if (!ready.ok) { return ready; }
        var prepare = mode === 'memory' || state === 'memory'
          ? Promise.resolve({ ok: true })
          : snapshotInternal('manual');
        return prepare.then(function (prepared) {
          if (!prepared.ok) { return prepared; }
          var fresh = schema.createDb();
          return commit(fresh, 'reset').then(function (written) {
            if (!written.ok) { return written; }
            return { ok: true, data: clone(cache), savedAt: written.savedAt };
          });
        });
      });
    });
  }

  /* ============================== 导出 / 导入（委托 backup.js） ============================== */

  function delegateExport(format, opts) {
    var backup = Core.backup;
    if (!backup || typeof backup.export !== 'function') {
      return Promise.resolve(fail('E_EXPORT_FAILED', { cause: 'backup.js 未加载' }));
    }
    return ensureLoaded().then(function (ready) {
      if (!ready.ok) { return ready; }
      return backup.export(format, opts);
    });
  }

  function exportData(format, opts) {
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    return delegateExport(format, opts);
  }

  function importData(input, opts) {
    var backup = Core.backup;
    if (inTx) { return Promise.resolve(fail('E_STORE_BUSY')); }
    if (!backup || typeof backup.import !== 'function') {
      return Promise.resolve(fail('E_IMPORT_INVALID', { cause: 'backup.js 未加载' }));
    }
    return ensureLoaded().then(function (ready) {
      if (!ready.ok) { return ready; }
      return backup.import(input, opts);
    });
  }

  /* ============================== 规范排序（§2.13） ============================== */

  function kindRank(category) {
    return category && category.kind === 'income' ? 1 : 0;
  }

  var SORTERS = {
    book: function (a, b) {
      return (a.archived ? 1 : 0) - (b.archived ? 1 : 0) ||
        (a.sort || 0) - (b.sort || 0) || cmpStr(a.createdAt, b.createdAt);
    },
    account: function (a, b) {
      return (a.archived ? 1 : 0) - (b.archived ? 1 : 0) ||
        (a.sort || 0) - (b.sort || 0) || cmpStr(a.createdAt, b.createdAt);
    },
    category: function (a, b) {
      return kindRank(a) - kindRank(b) || (a.sort || 0) - (b.sort || 0) ||
        cmpStr(a.createdAt, b.createdAt);
    },
    transaction: function (a, b) {
      return cmpStr(b.date, a.date) || cmpStr(b.time, a.time) ||
        cmpStr(b.createdAt, a.createdAt) || cmpStr(b.id, a.id);
    },
    budget: function (a, b) {
      return cmpStr(b.month, a.month) || cmpStr(a.id, b.id);
    },
    categoryBudget: function (a, b) {
      return (b.amountCents || 0) - (a.amountCents || 0) || cmpStr(a.categoryId, b.categoryId);
    },
    recurring: function (a, b) {
      return (a.archived ? 1 : 0) - (b.archived ? 1 : 0) ||
        (a.paused ? 1 : 0) - (b.paused ? 1 : 0) ||
        cmpStr(a.nextDueDate || '9999-12-31', b.nextDueDate || '9999-12-31') ||
        cmpStr(a.id, b.id);
    },
    goal: function (a, b) {
      return (a.archived ? 1 : 0) - (b.archived ? 1 : 0) ||
        (a.sort || 0) - (b.sort || 0) || cmpStr(a.createdAt, b.createdAt);
    },
    goalDeposit: function (a, b) {
      return cmpStr(b.date, a.date) || cmpStr(b.createdAt, a.createdAt) || cmpStr(b.id, a.id);
    }
  };

  var KIND_META = {
    book: { table: 'books', prefix: 'bk', label: 'Book', plural: 'Books', singularKey: 'book', archivable: true, hasDeleted: false },
    account: { table: 'accounts', prefix: 'ac', label: 'Account', plural: 'Accounts', singularKey: 'account', archivable: true, hasDeleted: false },
    category: { table: 'categories', prefix: 'ca', label: 'Category', plural: 'Categories', singularKey: 'category', archivable: false, hasDeleted: false },
    transaction: { table: 'transactions', prefix: 'tx', label: 'Transaction', plural: 'Transactions', singularKey: 'tx', archivable: false, hasDeleted: true },
    budget: { table: 'budgets', prefix: 'bg', label: 'Budget', plural: 'Budgets', singularKey: 'budget', archivable: false, hasDeleted: false },
    categoryBudget: { table: 'categoryBudgets', prefix: 'cb', label: 'CategoryBudget', plural: 'CategoryBudgets', singularKey: 'categoryBudget', archivable: false, hasDeleted: false },
    recurring: { table: 'recurring', prefix: 'rc', label: 'Recurring', plural: 'Recurring', singularKey: 'recurring', archivable: true, hasDeleted: false },
    goal: { table: 'goals', prefix: 'gl', label: 'Goal', plural: 'Goals', singularKey: 'goal', archivable: true, hasDeleted: false },
    goalDeposit: { table: 'goalDeposits', prefix: 'gd', label: 'GoalDeposit', plural: 'GoalDeposits', singularKey: 'deposit', archivable: false, hasDeleted: true }
  };

  function metaOf(kind) {
    var key = schema.kindKey(kind);
    return KIND_META[key] || null;
  }

  function sortList(kind, items) {
    var meta = metaOf(kind);
    if (!meta || !Array.isArray(items)) { return []; }
    var list = items.slice();
    list.sort(SORTERS[schema.kindKey(kind)]);
    return list;
  }

  /* ============================== 筛选 ============================== */

  function matchTransaction(item, filter) {
    if (!filter.includeDeleted && item.deleted === true) { return false; }
    if (filter.bookId && item.bookId !== filter.bookId) { return false; }
    if (filter.type && filter.type !== 'all' && item.type !== filter.type) { return false; }
    if (filter.categoryId && item.categoryId !== filter.categoryId) { return false; }
    if (filter.accountId && item.accountId !== filter.accountId && item.toAccountId !== filter.accountId) {
      return false;
    }
    if (filter.month && String(item.date || '').slice(0, 7) !== filter.month) { return false; }
    if (filter.from && cmpStr(item.date, filter.from) < 0) { return false; }
    if (filter.to && cmpStr(item.date, filter.to) > 0) { return false; }
    if (filter.recurringId && item.recurringId !== filter.recurringId) { return false; }
    var keyword = filter.q || filter.query || '';
    if (keyword) {
      var needle = String(keyword).toLowerCase();
      var note = String(item.note || '').toLowerCase();
      var tagText = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : '';
      if (note.indexOf(needle) < 0 && tagText.indexOf(needle) < 0) { return false; }
    }
    return true;
  }

  function matchEntity(kind, item, filter) {
    var key = schema.kindKey(kind);
    if (key === 'transaction') { return matchTransaction(item, filter); }
    if (key === 'book' || key === 'account' || key === 'goal') {
      if (!filter.includeArchived && item.archived === true) { return false; }
      return true;
    }
    if (key === 'recurring') {
      if (!filter.includeArchived && item.archived === true) { return false; }
      if (filter.includePaused === false && item.paused === true) { return false; }
      return true;
    }
    if (key === 'category') {
      if (!filter.includeHidden && item.hidden === true) { return false; }
      if (filter.kind && item.kind !== filter.kind) { return false; }
      return true;
    }
    if (key === 'budget' || key === 'categoryBudget') {
      if (filter.bookId && item.bookId !== filter.bookId) { return false; }
      if (filter.month && item.month !== filter.month) { return false; }
      if (key === 'categoryBudget' && filter.categoryId && item.categoryId !== filter.categoryId) {
        return false;
      }
      return true;
    }
    if (key === 'goalDeposit') {
      if (!filter.includeDeleted && item.deleted === true) { return false; }
      if (filter.goalId && item.goalId !== filter.goalId) { return false; }
      return true;
    }
    return true;
  }

  function list(kind, filter) {
    var meta = metaOf(kind);
    if (!meta || !cache) { return []; }
    var source = Array.isArray(cache[meta.table]) ? cache[meta.table] : [];
    var options = isObject(filter) ? filter : {};
    var items = source.filter(function (item) { return matchEntity(kind, item, options); });
    var sorted = sortList(kind, items);
    var offset = Number(options.offset) || 0;
    var limit = Number(options.limit) || 0;
    if (offset > 0) { sorted = sorted.slice(offset); }
    if (limit > 0) { sorted = sorted.slice(0, limit); }
    return sorted;
  }

  function query(kind, filter) {
    var meta = metaOf(kind);
    if (!meta) { return { ok: false, code: 'E_INVALID_INPUT', message: messageOf('E_INVALID_INPUT'), path: 'kind' }; }
    var items = list(kind, filter);
    return { ok: true, kind: schema.kindKey(kind), items: items, total: items.length, savedAt: savedAt };
  }

  function getOne(kind, id) {
    var meta = metaOf(kind);
    if (!meta || !cache || typeof id !== 'string') { return null; }
    var source = Array.isArray(cache[meta.table]) ? cache[meta.table] : [];
    for (var i = 0; i < source.length; i++) {
      if (source[i] && source[i].id === id) { return source[i]; }
    }
    return null;
  }

  /* ============================== 实体写入（在 draft 上操作） ============================== */

  function notFoundCode(kind) {
    var key = schema.kindKey(kind);
    if (key === 'transaction') { return 'E_TX_NOT_FOUND'; }
    if (key === 'goal') { return 'E_GOAL_NOT_FOUND'; }
    if (key === 'goalDeposit') { return 'E_GOAL_DEPOSIT_NOT_FOUND'; }
    if (key === 'recurring') { return 'E_RECURRING_NOT_FOUND'; }
    if (key === 'book') { return 'E_BOOK_MISSING'; }
    if (key === 'account') { return 'E_ACCOUNT_MISSING'; }
    if (key === 'category') { return 'E_CATEGORY_MISSING'; }
    return 'E_INVALID_INPUT';
  }

  function abortWith(code, path) {
    return { abort: true, code: code, path: path };
  }

  function findIndexById(listValue, id) {
    if (!Array.isArray(listValue)) { return -1; }
    for (var i = 0; i < listValue.length; i++) {
      if (listValue[i] && listValue[i].id === id) { return i; }
    }
    return -1;
  }

  function normalizeEntity(kind, input, now) {
    var key = schema.kindKey(kind);
    if (typeof schema.normalize === 'function') {
      return schema.normalize(key, input, now);
    }
    var factoryName = 'normalize' + KIND_META[key].label;
    return schema[factoryName](input, now);
  }

  function createWithFactory(kind, input, now) {
    var key = schema.kindKey(kind);
    var factoryName = 'create' + KIND_META[key].label;
    if (typeof schema[factoryName] === 'function') {
      return schema[factoryName](input, now);
    }
    var entity = normalizeEntity(kind, input, now);
    if (!entity.id) { entity.id = schema.newId(KIND_META[key].prefix); }
    return entity;
  }

  /* 逐实体校验：拿到 §8 里最具体的错误码，而不是笼统的 E_SCHEMA_INVALID。
     allowArchived 与 schema.validateDb 保持一致（D16.6：归档账户/账本的历史引用放行）。 */
  function validateForWrite(kind, entity, draft, previous) {
    var key = schema.kindKey(kind);
    var ctx = { allowArchived: true };
    if (Array.isArray(draft.categories)) { ctx.categories = draft.categories; }
    if (Array.isArray(draft.books)) { ctx.books = draft.books; }
    if (Array.isArray(draft.accounts)) { ctx.accounts = draft.accounts; }
    if (Array.isArray(draft.goals)) { ctx.goals = draft.goals; }
    if (previous) { ctx.original = previous; }
    var checked;
    try {
      checked = schema.validate(key, entity, ctx);
    } catch (error) {
      return { ok: false, code: 'E_SCHEMA_INVALID' };
    }
    if (!checked || checked.ok === true) { return { ok: true }; }
    var first = Array.isArray(checked.errors) ? checked.errors[0] : null;
    return {
      ok: false,
      code: (first && first.code) || 'E_SCHEMA_INVALID',
      path: (first && first.field) || undefined
    };
  }

  function insertEntity(draft, kind, input) {
    var meta = metaOf(kind);
    if (!meta) { return { ok: false, code: 'E_INVALID_INPUT', path: 'kind' }; }
    var now = nowIso();
    var entity = createWithFactory(kind, isObject(input) ? input : {}, now);
    if (!entity || typeof entity.id !== 'string' || entity.id === '') {
      return { ok: false, code: 'E_SCHEMA_ID' };
    }
    if (findIndexById(draft[meta.table], entity.id) >= 0) {
      return { ok: false, code: 'E_INVALID_INPUT', path: 'id' };
    }
    /* 唯一键：预算 bookId+month、分类预算 bookId+month+categoryId */
    if (schema.kindKey(kind) === 'budget') {
      var sameBudget = draft.budgets.some(function (item) {
        return item.bookId === entity.bookId && item.month === entity.month;
      });
      if (sameBudget) { return { ok: false, code: 'E_INVALID_INPUT', path: 'month' }; }
    }
    if (schema.kindKey(kind) === 'categoryBudget') {
      var sameCategoryBudget = draft.categoryBudgets.some(function (item) {
        return item.bookId === entity.bookId && item.month === entity.month &&
          item.categoryId === entity.categoryId;
      });
      if (sameCategoryBudget) { return { ok: false, code: 'E_INVALID_INPUT', path: 'categoryId' }; }
    }
    var checked = validateForWrite(kind, entity, draft, null);
    if (!checked.ok) { return checked; }
    entity.createdAt = entity.createdAt || now;
    entity.updatedAt = entity.updatedAt || now;
    draft[meta.table].push(entity);
    return { ok: true, entity: entity };
  }

  var IMMUTABLE_PATCH_KEYS = { id: true, createdAt: true, deleted: true, deletedAt: true };

  function updateEntity(draft, kind, id, patch) {
    var meta = metaOf(kind);
    if (!meta) { return { ok: false, code: 'E_INVALID_INPUT', path: 'kind' }; }
    var key = schema.kindKey(kind);
    if (!isObject(patch)) { return { ok: false, code: 'E_INVALID_INPUT', path: 'patch' }; }
    var index = findIndexById(draft[meta.table], id);
    if (index < 0) { return { ok: false, code: notFoundCode(kind) }; }
    var previous = draft[meta.table][index];
    if (previous.deleted === true && key === 'transaction') {
      return { ok: false, code: 'E_TX_DELETED' };
    }
    if (previous.deleted === true && key === 'goalDeposit') {
      return { ok: false, code: 'E_GOAL_DEPOSIT_NOT_FOUND' };
    }
    var merged = {};
    for (var field in previous) {
      if (Object.prototype.hasOwnProperty.call(previous, field)) { merged[field] = previous[field]; }
    }
    for (var patchKey in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, patchKey)) { continue; }
      if (IMMUTABLE_PATCH_KEYS[patchKey] === true) { continue; }
      merged[patchKey] = patch[patchKey];
    }
    if (key === 'transaction') {
      if (patch.type !== undefined && patch.type !== previous.type) {
        return { ok: false, code: 'E_TX_TYPE', path: 'type' };
      }
      if (patch.bookId !== undefined && patch.bookId !== previous.bookId) {
        return { ok: false, code: 'E_INVALID_INPUT', path: 'bookId' };
      }
      merged.type = previous.type;
      merged.bookId = previous.bookId;
    }
    var now = nowIso();
    var normalized = normalizeEntity(kind, merged, now);
    if (!normalized) { return { ok: false, code: 'E_INVALID_INPUT', path: 'entity' }; }
    normalized.id = previous.id;
    normalized.createdAt = previous.createdAt || now;
    normalized.updatedAt = touchIso(previous.updatedAt);
    var checked = validateForWrite(kind, normalized, draft, previous);
    if (!checked.ok) { return checked; }
    draft[meta.table][index] = normalized;
    return { ok: true, entity: normalized };
  }

  function removeEntity(draft, kind, id, options) {
    var meta = metaOf(kind);
    if (!meta) { return { ok: false, code: 'E_INVALID_INPUT', path: 'kind' }; }
    var key = schema.kindKey(kind);
    var index = findIndexById(draft[meta.table], id);
    if (index < 0) { return { ok: false, code: notFoundCode(kind) }; }
    var target = draft[meta.table][index];
    var now = nowIso();

    if (meta.hasDeleted) {
      if (target.deleted === true) {
        return { ok: true, entity: target, alreadyDeleted: true };
      }
      target.deleted = true;
      target.deletedAt = now;
      target.updatedAt = touchIso(target.updatedAt);
      return { ok: true, entity: target, alreadyDeleted: false };
    }

    if (key === 'category') {
      var applied = schema.applyCategoryDelete(draft, id);
      if (!applied.ok) { return { ok: false, code: applied.code }; }
      for (var i = 0; i < TABLES.length; i++) {
        if (Array.isArray(applied.db[TABLES[i]])) { draft[TABLES[i]] = applied.db[TABLES[i]]; }
      }
      draft.updatedAt = applied.db.updatedAt || now;
      return { ok: true, hidden: applied.hidden === true, remapped: applied.remapped || 0, entity: null };
    }

    if (meta.archivable) {
      /* 账本/账户/定期账单/目标：删除动作即归档（§2.13） */
      if (key === 'book' && target.archived !== true) {
        var active = draft.books.filter(function (item) { return item.archived !== true; });
        if (active.length <= 1) { return { ok: false, code: 'E_BOOK_LAST' }; }
      }
      target.archived = true;
      target.updatedAt = touchIso(target.updatedAt);
      return { ok: true, entity: target };
    }

    draft[meta.table].splice(index, 1);
    return { ok: true, removed: true, entity: target, hard: options && options.hard === true };
  }

  function archiveEntity(draft, kind, id, archived) {
    var meta = metaOf(kind);
    if (!meta) { return { ok: false, code: 'E_INVALID_INPUT', path: 'kind' }; }
    if (!meta.archivable) { return { ok: false, code: 'E_INVALID_INPUT', path: 'archived' }; }
    var key = schema.kindKey(kind);
    var index = findIndexById(draft[meta.table], id);
    if (index < 0) { return { ok: false, code: notFoundCode(kind) }; }
    var target = draft[meta.table][index];
    var next = archived !== false;
    if (key === 'book' && next === true && target.archived !== true) {
      var active = draft.books.filter(function (item) { return item.archived !== true; });
      if (active.length <= 1) { return { ok: false, code: 'E_BOOK_LAST' }; }
    }
    target.archived = next;
    target.updatedAt = touchIso(target.updatedAt);
    return { ok: true, entity: target };
  }

  function shapeResult(action, result, kind) {
    var meta = metaOf(kind);
    var out = { ok: true, kind: schema.kindKey(kind), savedAt: action.savedAt, id: null };
    if (result.entity) {
      out.id = result.entity.id;
      out.entity = result.entity;
      out[meta.singularKey] = result.entity;
    }
    if (result.hidden !== undefined) { out.hidden = result.hidden; }
    if (result.remapped !== undefined) { out.remapped = result.remapped; }
    if (result.removed !== undefined) { out.removed = result.removed; }
    if (result.alreadyDeleted !== undefined) { out.alreadyDeleted = result.alreadyDeleted; }
    return out;
  }

  function runMutation(kind, worker) {
    var meta = metaOf(kind);
    if (!meta) { return Promise.resolve(fail('E_INVALID_INPUT', { path: 'kind' })); }
    return transaction(function (draft) {
      var result = worker(draft);
      if (!result.ok) {
        return { abort: true, code: result.code || 'E_INVALID_INPUT', path: result.path };
      }
      return { value: result };
    }).then(function (response) {
      if (!response.ok) { return response; }
      return shapeResult(response, response.value, kind);
    });
  }

  function create(kind, input) {
    return runMutation(kind, function (draft) { return insertEntity(draft, kind, input); });
  }

  function updateEntityPublic(kind, id, patch) {
    return runMutation(kind, function (draft) { return updateEntity(draft, kind, id, patch); });
  }

  function removePublic(kind, id, options) {
    return runMutation(kind, function (draft) { return removeEntity(draft, kind, id, options); });
  }

  function archivePublic(kind, id, archived) {
    return runMutation(kind, function (draft) { return archiveEntity(draft, kind, id, archived); });
  }

  /* 转账：一条记录完成，type=transfer 同时带 accountId + toAccountId（§6.2） */
  function transfer(input) {
    var raw = isObject(input) ? input : {};
    var payload = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { payload[key] = raw[key]; }
    }
    payload.type = 'transfer';
    payload.categoryId = null;
    return create('transaction', payload);
  }

  /* 设置归一化：schema 未导出 normalizeSettings，这里用 defaultSettings + validateSettings 组合 */
  function normalizeSettingsForWrite(base, patch, now) {
    var seed = typeof schema.defaultSettings === 'function' ? schema.defaultSettings(now) : {};
    var merged = Object.assign({}, seed, isObject(base) ? base : {}, isObject(patch) ? patch : {});
    merged.createdAt = (isObject(base) && dates.isValidIsoStr(base.createdAt))
      ? base.createdAt : (seed.createdAt || now);
    merged.updatedAt = now;
    if (typeof schema.validateSettings === 'function') {
      var checked = schema.validateSettings(merged);
      if (!checked || checked.ok !== true) {
        var first = checked && Array.isArray(checked.errors) ? checked.errors[0] : null;
        return {
          ok: false,
          code: (first && first.code) || 'E_INVALID_INPUT',
          path: (first && first.field) || undefined
        };
      }
    }
    return { ok: true, settings: merged };
  }

  function updateSettings(patch) {
    if (!isObject(patch)) {
      return Promise.resolve(fail('E_INVALID_INPUT', { path: 'patch' }));
    }
    return transaction(function (draft) {
      var next = normalizeSettingsForWrite(draft.settings, patch, nowIso());
      if (!next.ok) { return { abort: true, code: next.code, path: next.path }; }
      draft.settings = next.settings;
      return { value: next.settings };
    }).then(function (response) {
      if (!response.ok) { return response; }
      return { ok: true, settings: response.value, savedAt: response.savedAt };
    });
  }

  /* ============================== 元信息读取 ============================== */

  function counts() {
    var out = {};
    for (var i = 0; i < TABLES.length; i++) {
      out[TABLES[i]] = cache && Array.isArray(cache[TABLES[i]]) ? cache[TABLES[i]].length : 0;
    }
    return out;
  }

  function isReady() {
    return state === 'ready' || state === 'memory';
  }

  /* 设置快照：只读副本，调用方改不到缓存（余额不落库，设置也没有余额字段） */
  function getSettings() {
    if (cache && isObject(cache.settings)) { return clone(cache.settings); }
    if (typeof schema.defaultSettings === 'function') { return schema.defaultSettings(nowIso()); }
    return {};
  }

  /* 存储层元信息：页面顶栏/调试面板用，不参与业务计算 */
  function getMeta() {
    return {
      dbName: dbName,
      dbVersion: DB_VERSION,
      mode: mode,
      state: state,
      degraded: mode === 'memory',
      savedAt: savedAt,
      rev: rev,
      bytes: bytes,
      loaded: cache !== null,
      schemaVersion: cache ? cache.schemaVersion : SCHEMA_VERSION,
      appVersion: cache ? cache.appVersion : (XZB.version || '2.2.0'),
      counts: counts()
    };
  }

  /* ============================== API 组装 ============================== */

  var api = {
    /* 常量（供其他模块引用，避免各写一份） */
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_STATE: STORE_STATE,
    STORE_SNAPSHOTS: STORE_SNAPSHOTS,
    TABLES: TABLES.slice(),
    RETENTION: RETENTION,
    MESSAGES: MESSAGES,

    /* 生命周期 */
    open: open,
    close: close,
    load: load,
    isReady: isReady,
    isMemory: function () { return state === 'memory'; },
    getMode: function () { return mode; },
    getSavedAt: function () { return savedAt; },
    getRev: function () { return rev; },
    getBytes: function () { return bytes; },
    getCounts: counts,
    counts: counts,

    /* 读 */
    get: function () { return cache; },
    getDB: function () { return cache; },
    getSettings: getSettings,
    getMeta: getMeta,
    subscribe: subscribe,

    /* 写 */
    save: save,
    transaction: transaction,
    flush: flush,
    reset: reset,
    updateSettings: updateSettings,

    /* 列表 / 查询 */
    list: list,
    query: query,
    sortList: sortList,
    getOne: getOne,

    /* 快照 */
    snapshot: snapshot,
    listSnapshots: listSnapshots,
    restore: restore,
    removeSnapshot: removeSnapshot,

    /* 导入导出（实现见 backup.js） */
    export: exportData,
    'import': importData,

    /* 泛型 CRUD */
    create: create,
    update: updateEntityPublic,
    remove: removePublic,
    archive: archivePublic,
    transfer: transfer,

    /* 测试钩子（仅自检脚本使用） */
    __test: {
      setDbName: function (name) { dbName = typeof name === 'string' && name !== '' ? name : DB_NAME; },
      getDbName: function () { return dbName; },
      setOpenTimeout: function (ms) { openTimeout = Number(ms) > 0 ? Number(ms) : OPEN_TIMEOUT_MS; },
      resetRuntime: function () {
        close();
        cache = null;
        savedAt = null;
        bytes = 0;
        rev = 0;
        mode = 'idb';
        degraded = false;
        lastOpenCode = null;
        memRecord = null;
        memSnapshots = [];
        listeners = [];
        queueTail = Promise.resolve();
        inTx = false;
        persistOnceReset();
      }
    }
  };

  function persistOnceReset() {
    persistedOnce = false;
  }

  /* 每个实体生成具名别名：listXxx / getXxx / createXxx / updateXxx / removeXxx / archiveXxx */
  (function attachNamedAliases() {
    var KEYS = Object.keys(KIND_META);
    for (var i = 0; i < KEYS.length; i++) {
      (function (kind) {
        var meta = KIND_META[kind];
        var plural = meta.plural;
        var cap = function (text) { return text.charAt(0).toUpperCase() + text.slice(1); };
        api['list' + plural] = function (filter) { return list(kind, filter); };
        api['get' + meta.label] = function (id) { return getOne(kind, id); };
        api['create' + meta.label] = function (input) { return create(kind, input); };
        api['update' + meta.label] = function (id, patch) { return updateEntityPublic(kind, id, patch); };
        api['remove' + meta.label] = function (id, options) { return removePublic(kind, id, options); };
        if (meta.archivable) {
          api['archive' + meta.label] = function (id, archived) {
            return archivePublic(kind, id, archived);
          };
        }
      })(KEYS[i]);
    }
  })();

  api.__test.persistOnce = persistOnceReset;
  function persistOnce() { return persistedOnce; } // 保留给调试

  Core.store = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.store = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
