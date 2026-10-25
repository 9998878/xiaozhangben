/* 小账本 2.0 · js/core/backup.js · owner: dba（T02）
 * 职责：
 *   1) §3.7 导出：JSON 全量备份 / CSV（13 列 + BOM），纯字符串返回，另提供 Blob 下载附件 API；
 *   2) §3.8 导入：字符串 / 对象 / 裸数组三形态识别 → 先 snapshot('pre-import') → 单事务写入；
 *   3) §3.6 自动快照调度：按「写操作计数 + 时间阈值」触发 snapshot('auto')，滚动保留交给 store。
 * 铁律：零网络；不写 localStorage（`xzb.backupAt` 由 App.prefs 负责，§3.9）；
 *       浏览器 API（Blob / URL / document / TextEncoder）全部在调用点做能力检测，Node 下可跑。
 * 挂载：XZB.Core.backup，Node 下 module.exports 双挂载。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  var schema = Core.schema;
  var dates = Core.dates;
  if (!schema || !dates) {
    throw new Error('backup.js 依赖 dates.js / schema.js，请按 core 加载顺序引入');
  }

  var APP_NAME = '小账本';
  var BACKUP_KIND = 'xzb-backup';
  var FILE_PREFIX = '小账本-2.2-';
  var SCHEMA_VERSION = 3;
  var MAX_IMPORT_BYTES = 10 * 1024 * 1024;
  var MIME_JSON = 'application/json;charset=utf-8';
  var MIME_CSV = 'text/csv;charset=utf-8';

  /* §3.7 冻结的列顺序（13 列，不得增删或换序） */
  var CSV_COLUMNS = [
    '日期', '时间', '类型', '账本', '账户', '转入账户', '分类',
    '金额（元）', '备注', '标签', '来源', '关联定期账单', '已删除'
  ];
  var TYPE_TEXT = { expense: '支出', income: '收入', transfer: '转账' };
  var SOURCE_TEXT = { manual: '手动', nl: '一句话', recurring: '定期', import: '导入' };
  var REASON_TEXT = {
    auto: '自动', manual: '手动', 'pre-import': '导入前',
    'pre-restore': '恢复前', 'pre-migrate': '迁移前'
  };

  /* 自动快照阈值：20 次写入 或 距上次自动快照 10 分钟（§3.6 滚动保留 auto 最多 12 份） */
  var AUTO_WRITE_THRESHOLD = 20;
  var AUTO_INTERVAL_MS = 10 * 60 * 1000;

  function storeRef() {
    return Core.store || null;
  }

  function fail(code, extra) {
    var MESSAGES = (storeRef() && storeRef().MESSAGES) || {};
    var out = {
      ok: false,
      code: code,
      message: MESSAGES[code] || '操作失败，请重试'
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key) && extra[key] !== undefined) {
          out[key] = extra[key];
        }
      }
    }
    return out;
  }

  function clone(value) {
    if (value === null || value === undefined) { return value; }
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function pad2(value) {
    var text = String(value);
    return text.length < 2 ? '0' + text : text;
  }

  /* UTF-8 字节数：优先 TextEncoder，Node/老浏览器退回手算 */
  function utf8Bytes(text) {
    var source = String(text === undefined || text === null ? '' : text);
    if (typeof TextEncoder !== 'undefined') {
      try { return new TextEncoder().encode(source).length; } catch (error) { /* 退回手算 */ }
    }
    var total = 0;
    for (var i = 0; i < source.length; i++) {
      var code = source.charCodeAt(i);
      if (code < 0x80) { total += 1; }
      else if (code < 0x800) { total += 2; }
      else if (code >= 0xd800 && code <= 0xdbff) { total += 4; i += 1; }
      else { total += 3; }
    }
    return total;
  }

  /* 兼容 LocalDate：支持 IsoStr / Date / 毫秒时间戳 */
  function toDate(value) {
    if (value instanceof Date && !isNaN(value.getTime())) { return value; }
    if (typeof value === 'number' && isFinite(value)) { return new Date(value); }
    if (typeof value === 'string' && value !== '') {
      var parsed = new Date(value);
      if (!isNaN(parsed.getTime())) { return parsed; }
    }
    return new Date();
  }

  /* 文件名时间取本地时间，冒号换成短横（§3.7） */
  function filenameFor(format, at) {
    var date = toDate(at);
    var stamp = String(date.getFullYear()) + pad2(date.getMonth() + 1) + pad2(date.getDate()) +
      '-' + pad2(date.getHours()) + pad2(date.getMinutes());
    return FILE_PREFIX + stamp + '.' + (format === 'csv' ? 'csv' : 'json');
  }

  /* ============================== 取当前库 ============================== */

  function currentDb() {
    var store = storeRef();
    if (!store || typeof store.get !== 'function') { return null; }
    return store.get();
  }

  /* 直接调用 backup.export 时也能拿到库（store 已加载则零成本） */
  function ensureDb() {
    var db = currentDb();
    if (db) { return Promise.resolve({ ok: true, db: db }); }
    var store = storeRef();
    if (!store || typeof store.load !== 'function') {
      return Promise.resolve(fail('E_EXPORT_FAILED', { cause: 'store 未加载' }));
    }
    return store.load().then(function (loaded) {
      if (!loaded || !loaded.ok) { return loaded || fail('E_STORAGE_WRITE'); }
      return { ok: true, db: loaded.data };
    });
  }

  /* ============================== JSON 备份 ============================== */

  /* 纯函数：把 Db 组装成备份对象（自检可直接调用） */
  function buildBackup(db, opts) {
    var options = isObject(opts) ? opts : {};
    var includeDeleted = options.includeDeleted !== false;
    var at = options.now === undefined ? dates.nowIso() : dates.nowIso(
      typeof options.now === 'string' && !isNaN(new Date(options.now).getTime())
        ? new Date(options.now).getTime()
        : options.now
    );
    var data = clone(db);
    if (!includeDeleted && Array.isArray(data.transactions)) {
      data.transactions = data.transactions.filter(function (tx) {
        return !(tx && tx.deleted === true);
      });
    }
    if (!includeDeleted && Array.isArray(data.goalDeposits)) {
      data.goalDeposits = data.goalDeposits.filter(function (deposit) {
        return !(deposit && deposit.deleted === true);
      });
    }
    return {
      app: APP_NAME,
      kind: BACKUP_KIND,
      appVersion: XZB.version,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: at,
      includesDeleted: includeDeleted,
      data: data
    };
  }

  function exportJson(opts) {
    return ensureDb().then(function (ready) {
      if (!ready.ok) { return ready; }
      var options = isObject(opts) ? opts : {};
      var payload;
      try {
        payload = buildBackup(ready.db, options);
      } catch (error) {
        return fail('E_EXPORT_FAILED', { cause: error && error.message });
      }
      var content;
      try {
        content = JSON.stringify(payload, null, 2);
      } catch (error) {
        return fail('E_EXPORT_FAILED', { cause: error && error.message });
      }
      return {
        ok: true,
        filename: filenameFor('json', payload.exportedAt),
        mime: MIME_JSON,
        content: content,
        bytes: utf8Bytes(content),
        exportedAt: payload.exportedAt,
        counts: countOf(payload.data)
      };
    });
  }

  function countOf(db) {
    var out = {};
    var keys = ['books', 'accounts', 'categories', 'transactions', 'budgets',
      'categoryBudgets', 'recurring', 'goals', 'goalDeposits'];
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = db && Array.isArray(db[keys[i]]) ? db[keys[i]].length : 0;
    }
    return out;
  }

  /* ============================== CSV ============================== */

  /* CSV 字段转义：含逗号/引号/换行 ⇒ 双引号包裹并把 " 变 ""（§3.7） */
  function escapeCsv(value) {
    var text = value === undefined || value === null ? '' : String(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function indexByName(list) {
    var out = Object.create(null);
    if (!Array.isArray(list)) { return out; }
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item && typeof item.id === 'string') { out[item.id] = item.name || item.id; }
    }
    return out;
  }

  /* 与 §2.13 一致的交易排序：日期↓ 时间↓ 创建时间↓ id↑ */
  function compareTx(a, b) {
    function cmpStr(x, y) {
      var left = x === undefined || x === null ? '' : String(x);
      var right = y === undefined || y === null ? '' : String(y);
      if (left < right) { return -1; }
      if (left > right) { return 1; }
      return 0;
    }
    return cmpStr(b.date, a.date) || cmpStr(b.time, a.time) ||
      cmpStr(b.createdAt, a.createdAt) || cmpStr(a.id, b.id);
  }

  /* 纯函数：Db → CSV 文本（含 BOM，CRLF 行尾） */
  function toCsv(db, opts) {
    var options = isObject(opts) ? opts : {};
    var includeDeleted = options.includeDeleted !== false;
    var bookNames = indexByName(db && db.books);
    var accountNames = indexByName(db && db.accounts);
    var categoryNames = indexByName(db && db.categories);
    var rows = [CSV_COLUMNS.map(escapeCsv).join(',')];
    var list = db && Array.isArray(db.transactions) ? db.transactions.slice() : [];
    list.sort(compareTx);
    for (var i = 0; i < list.length; i++) {
      var tx = list[i];
      if (!tx) { continue; }
      if (!includeDeleted && tx.deleted === true) { continue; }
      var amount = Number(tx.amountCents);
      if (!isFinite(amount)) { amount = 0; }
      var row = [
        tx.date || '',
        tx.time || '',
        TYPE_TEXT[tx.type] || tx.type || '',
        bookNames[tx.bookId] || tx.bookId || '',
        accountNames[tx.accountId] || tx.accountId || '',
        tx.toAccountId ? (accountNames[tx.toAccountId] || tx.toAccountId) : '',
        tx.categoryId ? (categoryNames[tx.categoryId] || tx.categoryId) : '',
        (amount / 100).toFixed(2),
        tx.note || '',
        Array.isArray(tx.tags) ? tx.tags.join('|') : '',
        SOURCE_TEXT[tx.source] || tx.source || '',
        tx.recurringId || '',
        tx.deleted === true ? '是' : '否'
      ];
      rows.push(row.map(escapeCsv).join(','));
    }
    return '\uFEFF' + rows.join('\r\n');
  }

  function exportCsv(opts) {
    return ensureDb().then(function (ready) {
      if (!ready.ok) { return ready; }
      var options = isObject(opts) ? opts : {};
      var content;
      try {
        content = toCsv(ready.db, options);
      } catch (error) {
        return fail('E_EXPORT_FAILED', { cause: error && error.message });
      }
      var at = options.now === undefined ? dates.nowIso() : options.now;
      return {
        ok: true,
        filename: filenameFor('csv', at),
        mime: MIME_CSV,
        content: content,
        bytes: utf8Bytes(content),
        rows: content.split('\r\n').length - 1,
        exportedAt: at
      };
    });
  }

  /* ============================== 导出附件 API ============================== */

  function hasBlob() {
    return typeof Blob !== 'undefined';
  }

  function hasObjectUrl() {
    var urlApi = global.URL;
    return !!urlApi && typeof urlApi.createObjectURL === 'function';
  }

  function exportText(format, opts) {
    if (format === 'csv') { return exportCsv(opts); }
    if (format === 'json' || format === undefined || format === null) { return exportJson(opts); }
    return Promise.resolve(fail('E_INVALID_INPUT', { path: 'format' }));
  }

  /* §3.7 契约入口：返回 {filename,mime,content:string}（不直接下载） */
  function exportData(format, opts) {
    return exportText(format, opts);
  }

  /* prompt 要求的 Blob 通道：不联网，URL.createObjectURL 在本机内存中生成 */
  function exportBlob(format, opts) {
    return exportText(format, opts).then(function (result) {
      if (!result.ok) { return result; }
      if (!hasBlob()) {
        return fail('E_EXPORT_FAILED', { cause: '当前环境不支持 Blob' });
      }
      var blob = new Blob([result.content], { type: result.mime });
      var out = {
        ok: true,
        blob: blob,
        filename: result.filename,
        mime: result.mime,
        content: result.content,
        bytes: result.bytes
      };
      if (hasObjectUrl()) {
        try { out.url = global.URL.createObjectURL(blob); } catch (error) { out.url = null; }
      }
      return out;
    });
  }

  /* 触发浏览器下载；Node 下返回 E_EXPORT_FAILED（自检不依赖此函数） */
  function download(format, opts) {
    return exportBlob(format, opts).then(function (result) {
      if (!result.ok) { return result; }
      var doc = global.document;
      if (!doc || typeof doc.createElement !== 'function' || !result.url) {
        if (result.url && typeof global.URL.revokeObjectURL === 'function') {
          global.URL.revokeObjectURL(result.url);
        }
        return fail('E_EXPORT_FAILED', { cause: '当前环境不支持下载' });
      }
      var link = doc.createElement('a');
      link.href = result.url;
      link.download = result.filename;
      link.rel = 'noopener';
      if (doc.body && typeof doc.body.appendChild === 'function') { doc.body.appendChild(link); }
      link.click();
      var delay = typeof global.setTimeout === 'function' ? global.setTimeout : null;
      if (delay) {
        delay(function () {
          try { global.URL.revokeObjectURL(result.url); } catch (error) { /* 忽略 */ }
          if (link.parentNode) { link.parentNode.removeChild(link); }
        }, 4000);
      }
      return {
        ok: true,
        filename: result.filename,
        mime: result.mime,
        bytes: result.bytes,
        downloaded: true
      };
    });
  }

  /* ============================== 导入 ============================== */

  /* 解析输入：字符串 trim + 大小限制 + JSON.parse；裸数组视为 v1 */
  function parseInput(input) {
    if (typeof input === 'string') {
      var text = input.replace(/^\uFEFF/, '').trim();
      if (text === '') { return fail('E_IMPORT_EMPTY'); }
      if (utf8Bytes(text) > MAX_IMPORT_BYTES) { return fail('E_IMPORT_TOO_LARGE'); }
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return fail('E_IMPORT_INVALID', { cause: error && error.message });
      }
      return { ok: true, value: parsed, from: 'string' };
    }
    if (Array.isArray(input)) { return { ok: true, value: input, from: 'array' }; }
    if (isObject(input)) { return { ok: true, value: input, from: 'object' }; }
    return fail('E_IMPORT_INVALID');
  }

  function detectKind(input) {
    if (Array.isArray(input)) { return 'v1'; }
    if (!isObject(input)) { return null; }
    if (input.kind === BACKUP_KIND && input.schemaVersion === SCHEMA_VERSION) { return 'v2'; }
    if (input.app === APP_NAME && Number(input.version) === 1) { return 'v1'; }
    var payload = isObject(input.data) ? input.data : input;
    /* 版本比当前高：单独识别，交给上层报 E_STORAGE_VERSION，而不是笼统的「文件损坏」。 */
    var payloadVersion = Number(payload.schemaVersion);
    if (isFinite(payloadVersion) && payloadVersion > SCHEMA_VERSION) { return 'tooNew'; }
    if (Number(payload.schemaVersion) === SCHEMA_VERSION && Array.isArray(payload.books)) {
      return 'v2';
    }
    if (Array.isArray(input.transactions)) { return 'v1'; }
    return null;
  }

  /* 抽取 v2 的 Db 主体并做版本闸门 */
  function extractV2(input) {
    var payload = isObject(input.data) ? input.data : input;
    if (!isObject(payload)) { return fail('E_IMPORT_INVALID', 'data'); }
    var version = Number(payload.schemaVersion);
    if (isFinite(version) && version > SCHEMA_VERSION) {
      return fail('E_STORAGE_VERSION', 'schemaVersion');
    }
    /* 九张表必须齐全：缺一张就拒绝，否则 replace 导入会把缺失的集合当成空集合，
     * 等于「用自己的手把流水清空」。 */
    var tables = ['books', 'accounts', 'categories', 'transactions', 'budgets',
      'categoryBudgets', 'recurring', 'goals', 'goalDeposits'];
    for (var i = 0; i < tables.length; i++) {
      if (!Array.isArray(payload[tables[i]])) {
        return fail('E_IMPORT_INVALID', 'data.' + tables[i]);
      }
    }
    return { ok: true, data: payload };
  }

  function migrateRef() {
    return Core.migrate || null;
  }

  /* 计算新的 Db（不写库）：返回 {ok, db, report, sourceVersion} */
  function buildImportDb(input, opts) {
    var options = isObject(opts) ? opts : {};
    var mode = options.mode === 'replace' ? 'replace' : 'merge';
    var migrate = migrateRef();
    var parsed = parseInput(input);
    if (!parsed.ok) { return parsed; }
    var kind = detectKind(parsed.value);
    if (!kind) { return fail('E_IMPORT_INVALID'); }
    if (kind === 'tooNew') { return fail('E_STORAGE_VERSION', 'schemaVersion'); }

    if (kind === 'v2') {
      var extracted = extractV2(parsed.value);
      if (!extracted.ok) { return extracted; }
      if (!migrate || typeof migrate.importV2 !== 'function') {
        return fail('E_IMPORT_INVALID', { cause: 'migrate.js 未加载' });
      }
      var v2Result = migrate.importV2(extracted.data, {
        mode: mode,
        currentDb: options.currentDb,
        targetBookId: options.targetBookId
      });
      if (!v2Result.ok) { return v2Result; }
      return {
        ok: true,
        db: v2Result.db,
        report: v2Result.report,
        sourceVersion: 2
      };
    }

    if (!migrate || typeof migrate.fromV1 !== 'function') {
      return fail('E_IMPORT_INVALID', { cause: 'migrate.js 未加载' });
    }
    var v1Result = migrate.fromV1(parsed.value, {
      mode: mode,
      currentDb: options.currentDb,
      targetBookId: options.targetBookId
    });
    if (!v1Result.ok) { return v1Result; }
    return {
      ok: true,
      db: v1Result.db,
      report: v1Result.report,
      sourceVersion: 1
    };
  }

  /* §3.8 导入：先快照（失败则中止）→ 单事务整体写入 */
  function importData(input, opts) {
    var options = isObject(opts) ? opts : {};
    var mode = options.mode === 'replace' ? 'replace' : 'merge';
    var store = storeRef();
    if (!store || typeof store.transaction !== 'function') {
      return Promise.resolve(fail('E_IMPORT_INVALID', { cause: 'store 未加载' }));
    }
    /* 预解析一次，尽早暴露 E_IMPORT_* 系列错误，避免无谓快照 */
    var precheck = parseInput(input);
    if (!precheck.ok) { return Promise.resolve(precheck); }
    if (!detectKind(precheck.value)) { return Promise.resolve(fail('E_IMPORT_INVALID')); }

    var report = null;
    var sourceVersion = null;
    var snapshotId = null;

    var takeSnapshot = typeof store.snapshot === 'function'
      ? store.snapshot('pre-import')
      : Promise.resolve({ ok: true, snapshot: null });

    return takeSnapshot.then(function (snap) {
      if (!snap || !snap.ok) {
        /* §3.10：内存降级没有持久快照，导入仍允许（只进内存） */
        if (snap && snap.code === 'E_STORAGE_FALLBACK') { return null; }
        return snap || fail('E_STORAGE_WRITE');
      }
      if (snap.snapshot && snap.snapshot.id) { snapshotId = snap.snapshot.id; }
      return null;
    }).then(function (abort) {
      if (abort) { return abort; }
      return store.transaction(function (draft) {
        var built = buildImportDb(input, {
          mode: mode,
          currentDb: draft,
          targetBookId: options.targetBookId
        });
        if (!built.ok) {
          return { abort: true, code: built.code, path: built.path, message: built.message };
        }
        report = built.report;
        report.mode = mode;
        report.importedAt = dates.nowIso();
        if (snapshotId) { report.snapshotId = snapshotId; }
        sourceVersion = built.sourceVersion;
        /* 用新库覆盖 draft 的全部数据键（transaction 内部只许改 draft） */
        var keys = store.TABLES || Object.keys(built.db);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (Array.isArray(built.db[key])) { draft[key] = clone(built.db[key]); }
        }
        if (built.db.settings) { draft.settings = clone(built.db.settings); }
        draft.schemaVersion = SCHEMA_VERSION;
        draft.appVersion = XZB.version;
        return { value: { report: report, sourceVersion: sourceVersion } };
      });
    }).then(function (written) {
      if (!written || !written.ok) {
        var failure = written || fail('E_IMPORT_FAILED');
        /* 事务内校验失败统一收敛成 E_IMPORT_FAILED + path（§3.8） */
        if (failure.code === 'E_SCHEMA_INVALID') {
          return fail('E_IMPORT_FAILED', { path: failure.path });
        }
        return failure;
      }
      return {
        ok: true,
        report: report,
        savedAt: written.savedAt,
        sourceVersion: sourceVersion
      };
    });
  }

  /* ============================== 自动快照调度 ============================== */

  var scheduler = {
    writes: 0,
    lastAutoAt: 0,
    busy: false,
    pending: false,
    autoCount: 0,
    failures: 0,
    thresholdWrites: AUTO_WRITE_THRESHOLD,
    intervalMs: AUTO_INTERVAL_MS
  };

  function nowMs() {
    return typeof Date.now === 'function' ? Date.now() : new Date().getTime();
  }

  function defer(fn) {
    if (typeof global.setTimeout === 'function') {
      return global.setTimeout(fn, 0);
    }
    return Promise.resolve().then(fn);
  }

  function shouldSnapshot() {
    if (scheduler.writes >= scheduler.thresholdWrites) { return true; }
    if (scheduler.writes > 0 && scheduler.lastAutoAt > 0 &&
      nowMs() - scheduler.lastAutoAt >= scheduler.intervalMs) {
      return true;
    }
    return false;
  }

  function runAuto() {
    var store = storeRef();
    if (!store || typeof store.snapshot !== 'function') {
      scheduler.busy = false;
      return Promise.resolve(null);
    }
    return store.snapshot('auto').then(function (result) {
      scheduler.busy = false;
      if (result && result.ok) {
        scheduler.writes = 0;
        scheduler.lastAutoAt = nowMs();
        if (result.snapshot) { scheduler.autoCount += 1; }
        scheduler.failures = 0;
      } else if (result && result.code === 'E_STORAGE_FALLBACK') {
        /* 内存降级：没有持久快照，清零计数避免每次写入都空转 */
        scheduler.writes = 0;
        scheduler.lastAutoAt = nowMs();
      } else {
        /* 失败保留计数，下次写入再试；连续失败过多则退避 */
        scheduler.failures += 1;
        if (scheduler.failures >= 3) {
          scheduler.writes = 0;
          scheduler.lastAutoAt = nowMs();
          scheduler.failures = 0;
        }
      }
      if (scheduler.pending) {
        scheduler.pending = false;
        if (shouldSnapshot()) { return noteWrite(0); }
      }
      return result;
    }, function () {
      scheduler.busy = false;
      return null;
    });
  }

  /* store.commit 每次成功写入后调用（跨文件钩子） */
  function noteWrite(count) {
    var amount = isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 1;
    scheduler.writes += amount;
    if (scheduler.busy) { scheduler.pending = true; return Promise.resolve(null); }
    if (!shouldSnapshot()) { return Promise.resolve(null); }
    scheduler.busy = true;
    return new Promise(function (resolve) {
      defer(function () { resolve(runAuto()); });
    });
  }

  /* 立即结算一次（App 切后台 / 自检用），不受阈值限制 */
  function flushAuto() {
    if (scheduler.busy) { scheduler.pending = true; return Promise.resolve(null); }
    scheduler.busy = true;
    return runAuto();
  }

  function getScheduler() {
    return {
      writes: scheduler.writes,
      lastAutoAt: scheduler.lastAutoAt,
      busy: scheduler.busy,
      pending: scheduler.pending,
      autoCount: scheduler.autoCount,
      failures: scheduler.failures,
      thresholdWrites: scheduler.thresholdWrites,
      intervalMs: scheduler.intervalMs
    };
  }

  function setThresholds(opts) {
    var options = isObject(opts) ? opts : {};
    if (isFinite(Number(options.writes)) && Number(options.writes) > 0) {
      scheduler.thresholdWrites = Math.floor(Number(options.writes));
    }
    if (isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0) {
      scheduler.intervalMs = Math.floor(Number(options.intervalMs));
    }
    return getScheduler();
  }

  function resetScheduler() {
    scheduler.writes = 0;
    scheduler.lastAutoAt = 0;
    scheduler.busy = false;
    scheduler.pending = false;
    scheduler.autoCount = 0;
    scheduler.failures = 0;
    scheduler.thresholdWrites = AUTO_WRITE_THRESHOLD;
    scheduler.intervalMs = AUTO_INTERVAL_MS;
    return getScheduler();
  }

  /* ============================== 快照备注表 ============================== */

  function reasonText(reason) {
    return REASON_TEXT[reason] || reason || '';
  }

  /* 快照列表 → 展示用行（时间倒序，附带可读备注） */
  function describeSnapshots(items) {
    var list = Array.isArray(items) ? items.slice() : [];
    list.sort(function (a, b) {
      var left = a && a.at ? String(a.at) : '';
      var right = b && b.at ? String(b.at) : '';
      return left < right ? 1 : (left > right ? -1 : 0);
    });
    return list.map(function (item) {
      return {
        id: item.id,
        at: item.at,
        reason: item.reason,
        label: reasonText(item.reason),
        bytes: item.bytes,
        schemaVersion: item.schemaVersion,
        counts: item.counts || {}
      };
    });
  }

  var api = {
    APP_NAME: APP_NAME,
    KIND: BACKUP_KIND,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    CSV_COLUMNS: CSV_COLUMNS.slice(),
    MIME_JSON: MIME_JSON,
    MIME_CSV: MIME_CSV,
    AUTO_WRITE_THRESHOLD: AUTO_WRITE_THRESHOLD,
    AUTO_INTERVAL_MS: AUTO_INTERVAL_MS,

    /* 导出 */
    export: exportData,
    exportJson: exportJson,
    exportCsv: exportCsv,
    exportText: exportText,
    exportBlob: exportBlob,
    download: download,

    /* 导入 */
    import: importData,
    importData: importData,
    parseInput: parseInput,
    detectKind: detectKind,
    buildImportDb: buildImportDb,

    /* 自动快照 */
    noteWrite: noteWrite,
    flushAuto: flushAuto,
    getScheduler: getScheduler,
    setThresholds: setThresholds,
    resetScheduler: resetScheduler,

    /* 纯函数 / 工具 */
    buildBackup: buildBackup,
    toCsv: toCsv,
    escapeCsv: escapeCsv,
    filenameFor: filenameFor,
    utf8Bytes: utf8Bytes,
    reasonText: reasonText,
    describeSnapshots: describeSnapshots,
    supportsBlob: hasBlob,
    supportsDownload: function () {
      return hasBlob() && hasObjectUrl() && !!global.document;
    }
  };

  Core.backup = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.backup = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
