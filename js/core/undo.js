/* ============================================================================
   小账本 2.0 · 撤销栈（T09）
   文件：src/js/core/undo.js
   加载：... → recurrence → undo → backup → ...
   挂载：window.XZB.core.undo
   依赖：XZB.core.dates（nowIso）、XZB.core.schema（可选，取 ID/校验时用）

   设计要点：
   1. 最多 50 步，超出丢最早的（任务书 T09；CONTRACT §6.6 写的是 30，已在汇报中标注）；
   2. 条目形如 {label, at, ops:[{kind, payload}], bookId, id}，
      kind ∈ create | update | delete | transfer | batch（任务书五种），
      另支持两个内部补充 kind：raw（直接改表）、settings（整体还原设置），
      以及 D16 口径的 remove / restore（硬删 / 恢复，对应 recurring.post、goal.deposit）；
   3. push(entry) 兼容 CONTRACT §6.6 的 `{kind:'tx.create', label, bookId, undo:{op,payload}}` 形状；
   4. undo(store, opts) 在 store.transaction 的 draft 上同步逆操作：
      - 先查跨账本（E_UNDO_CROSS_BOOK，条目保留）
      - 目标消失/已再次变化（E_UNDO_STALE，条目丢弃）
      - 存储失败（条目保留，可重试）
      - 成功后弹出该条；撤销动作绝不入栈（无限循环防护）
   5. 栈为空返回 E_UNDO_EMPTY（CONTRACT §8 真实存在，静默，不弹 toast）；
   6. 一切写库都走传入的 store（禁止 localStorage / 直接开 IndexedDB）。

   一次 push 的典型调用（供 app.js 对接）：
     XZB.core.undo.push({
       label: XZB.core.undo.describeAction('create', { type: 'expense', amountCents: 3200 }),
       bookId: tx.bookId,
       ops: [{ kind: 'create', payload: { entity: 'transaction', id: tx.id } }]
     });
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB = global.XZB || {};
  var core = XZB.core = XZB.core || (XZB.Core = XZB.Core || {});
  XZB.Core = core;
  XZB.version = XZB.version || '2.2.0';

  /* ============================== 常量 ============================== */

  var MAX_STEPS = 50;
  var MAX_BATCH_OPS = 500;
  var SOFT_DELETE_TABLES = ['transactions', 'goalDeposits'];
  var OP_KINDS = ['create', 'update', 'delete', 'transfer', 'batch', 'raw', 'remove', 'restore', 'settings'];

  var MESSAGES = {
    E_UNDO_EMPTY: '没有可撤销的操作',
    E_UNDO_CROSS_BOOK: '请先切换到「{账本名}」再撤销',
    E_UNDO_STALE: '这条记录已变化，无法撤销',
    E_INVALID_INPUT: '输入不完整或格式不对'
  };

  /* 实体名 → 库表名 */
  var TABLE_OF = {
    transaction: 'transactions',
    transactions: 'transactions',
    tx: 'transactions',
    book: 'books',
    books: 'books',
    account: 'accounts',
    accounts: 'accounts',
    category: 'categories',
    categories: 'categories',
    budget: 'budgets',
    budgets: 'budgets',
    categorybudget: 'categoryBudgets',
    categoryBudgets: 'categoryBudgets',
    recurring: 'recurring',
    goal: 'goals',
    goals: 'goals',
    goaldeposit: 'goalDeposits',
    goalDeposits: 'goalDeposits',
    settings: 'settings'
  };

  /* ============================== 基础工具 ============================== */

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function clone(value) {
    if (value === null || typeof value !== 'object') { return value; }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) { arr.push(clone(value[i])); }
      return arr;
    }
    var out = {};
    for (var key in value) {
      if (has(value, key)) { out[key] = clone(value[key]); }
    }
    return out;
  }

  function datesApi() {
    return (core && core.dates) || (XZB.Core && XZB.Core.dates) || null;
  }

  function schemaApi() {
    return (core && core.schema) || (XZB.Core && XZB.Core.schema) || null;
  }

  function nowIso() {
    var D = datesApi();
    if (D && typeof D.nowIso === 'function') { return D.nowIso(); }
    return new Date().toISOString();
  }

  function fail(code, message, extra) {
    var out = { ok: false, code: code, message: message || MESSAGES[code] || '操作失败' };
    if (extra) {
      for (var key in extra) {
        if (has(extra, key)) { out[key] = extra[key]; }
      }
    }
    return out;
  }

  function tableOf(name) {
    if (typeof name !== 'string' || name === '') { return null; }
    if (has(TABLE_OF, name)) { return TABLE_OF[name]; }
    var lower = name.toLowerCase();
    var keys = Object.keys(TABLE_OF);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lower) { return TABLE_OF[keys[i]]; }
    }
    return null;
  }

  function findItem(list, id) {
    if (!Array.isArray(list) || typeof id !== 'string' || id === '') { return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function removeItem(list, id) {
    if (!Array.isArray(list)) { return false; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) {
        list.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function assignValues(target, values) {
    if (!isObj(target) || !isObj(values)) { return; }
    for (var key in values) {
      if (!has(values, key)) { continue; }
      if (key === 'id') { continue; }
      target[key] = clone(values[key]);
    }
  }

  /* 金额文案：'3200' → '32.00'（与任务书示例「记一笔 32.00 支出」一致） */
  function plainAmount(cents) {
    var n = Number(cents);
    if (!isFinite(n)) { n = 0; }
    var sign = n < 0 ? '-' : '';
    return sign + (Math.round(Math.abs(n)) / 100).toFixed(2);
  }

  function typeText(type) {
    if (type === 'income') { return '收入'; }
    if (type === 'transfer') { return '转账'; }
    return '支出';
  }

  /* ============================== 中文文案 ============================== */

  /* 生成条目标签（不含「撤销：」前缀）：
     describeAction('create', {type:'expense', amountCents:3200}) → '记一笔 32.00 支出'
     describeAction('update') → '修改一笔记录'
     describeAction('delete') → '删除一笔记录'
     describeAction('transfer', {amountCents:5000}) → '转账 50.00'
     describeAction('batch', {count:3}) → '批量操作 3 项' */
  function describeAction(kind, payload) {
    var p = isObj(payload) ? payload : {};
    var amount = plainAmount(p.amountCents);
    var subject = typeof p.note === 'string' && p.note !== ''
      ? p.note
      : (typeof p.name === 'string' && p.name !== '' ? p.name : '');
    var tail = subject ? ' · ' + subject : '';

    if (kind === 'create') {
      if (p.type === 'transfer') {
        return '转账' + (p.amountCents === undefined ? '' : ' ' + amount) + tail;
      }
      return '记一笔' + (p.amountCents === undefined ? '' : ' ' + amount) + ' ' + typeText(p.type) + tail;
    }
    if (kind === 'transfer') {
      return '转账' + (p.amountCents === undefined ? '' : ' ' + amount) + tail;
    }
    if (kind === 'update') { return '修改一笔记录' + tail; }
    if (kind === 'delete') { return '删除一笔记录' + tail; }
    if (kind === 'batch') {
      var count = Number(p.count);
      return '批量操作 ' + (isFinite(count) && count > 0 ? count : 1) + ' 项';
    }
    if (kind === 'remove') { return '删除一项数据' + tail; }
    if (kind === 'restore') { return '恢复一项数据' + tail; }
    if (kind === 'raw' || kind === 'settings') { return '批量操作 1 项'; }
    return '一步操作';
  }

  /* 带前缀的 toast 文案：'撤销：记一笔 32.00 支出' */
  function labelFor(entry) {
    if (!isObj(entry)) { return '撤销：上一步操作'; }
    var label = typeof entry.label === 'string' && entry.label !== ''
      ? entry.label
      : describeAction(entry.kind, entry);
    if (label.indexOf('撤销：') === 0) { return label; }
    return '撤销：' + label;
  }

  /* ============================== 条目归一化 ============================== */

  /* 单个 op 归一化；无法识别返回 null */
  function normalizeOp(op) {
    if (!isObj(op)) { return null; }

    /* 兼容 CONTRACT §6.6 的单 op 形状：{op:'tx.create', payload:{...}} */
    if (typeof op.op === 'string' && !op.kind) {
      return fromContractOp(op.op, op.payload || op.values || {});
    }
    if (OP_KINDS.indexOf(op.kind) < 0) { return null; }
    if (op.kind === 'batch') {
      var inner = [];
      var list = Array.isArray(op.ops) ? op.ops : (Array.isArray(op.payload && op.payload.ops) ? op.payload.ops : []);
      for (var i = 0; i < list.length && inner.length < MAX_BATCH_OPS; i++) {
        var one = normalizeOp(list[i]);
        if (one) {
          if (one.kind === 'batch') {
            for (var j = 0; j < one.ops.length; j++) { inner.push(one.ops[j]); }
          } else {
            inner.push(one);
          }
        }
      }
      if (!inner.length) { return null; }
      return { kind: 'batch', ops: inner };
    }
    /* 任务书形状 {kind, payload:{entity, id, oldValues|values}}：把 payload 摊平到 op 上 */
    var flat = clone(op);
    var p = isObj(op.payload) ? op.payload : null;
    if (p) {
      for (var key in p) {
        if (has(p, key) && key !== 'payload' && key !== 'ops') { flat[key] = clone(p[key]); }
      }
      if (flat.oldValues === undefined && isObj(p.before)) { flat.oldValues = clone(p.before); }
      if (flat.values === undefined && isObj(p.after)) { flat.values = clone(p.after); }
      if (isObj(p.oldValues)) { flat.oldValues = clone(p.oldValues); }
      if (isObj(p.values)) { flat.values = clone(p.values); }
      delete flat.payload;
    }
    return flat;
  }

  /* CONTRACT §6.6 的 6 类 op → 内部 kind */
  function fromContractOp(name, payload) {
    var p = isObj(payload) ? payload : {};
    var entity = p.entity || p.kind || 'transaction';
    var id = p.id || p.entityId || p.transactionId || p.depositId || '';
    if (name === 'tx.create') {
      return { kind: 'create', entity: 'transaction', id: id };
    }
    if (name === 'tx.update') {
      return { kind: 'update', entity: 'transaction', id: id, oldValues: clone(p.before || p.oldValues || {}) };
    }
    if (name === 'tx.delete') {
      return { kind: 'delete', entity: 'transaction', id: id, values: clone(p.before || p.oldValues || p.after || {}) };
    }
    if (name === 'budget.save') {
      if (p.before === undefined && p.after === undefined) { return null; }
      var table = p.table === 'categoryBudgets' ? 'categoryBudgets' : 'budgets';
      var targetId = id || (p.after && p.after.id) || (p.before && p.before.id) || '';
      return {
        kind: 'raw',
        table: table,
        id: targetId,
        values: p.before === undefined ? null : clone(p.before)
      };
    }
    if (name === 'recurring.post') {
      return { kind: 'remove', table: 'transactions', id: p.transactionId || p.id || '' };
    }
    if (name === 'goal.deposit') {
      if (p.depositId || p.id) {
        return { kind: 'remove', table: 'goalDeposits', id: p.depositId || p.id };
      }
      return { kind: 'restore', table: 'goalDeposits', values: clone(p.before || p.values || {}) };
    }
    if (name === 'raw' && isObj(p)) {
      return { kind: 'raw', table: p.table, id: p.id, values: p.values === undefined ? null : clone(p.values) };
    }
    return null;
  }

  /* 条目归一化：{label, at, ops:[...], kind?, bookId?, id?} */
  function normalizeEntry(entry) {
    if (!isObj(entry)) { return null; }
    var raw = [];
    if (Array.isArray(entry.ops)) {
      raw = entry.ops;
    } else if (isObj(entry.undo) && typeof entry.undo.op === 'string') {
      raw = [{ op: entry.undo.op, payload: entry.undo.payload }];
    }
    var ops = [];
    for (var i = 0; i < raw.length && ops.length < MAX_BATCH_OPS; i++) {
      var one = normalizeOp(raw[i]);
      if (one && one.kind === 'batch') {
        for (var j = 0; j < one.ops.length; j++) { ops.push(one.ops[j]); }
      } else if (one) {
        ops.push(one);
      }
    }
    if (!ops.length) { return null; }

    var kind = typeof entry.kind === 'string' && entry.kind !== ''
      ? entry.kind
      : (ops.length > 1 ? 'batch' : ops[0].kind);
    var out = {
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : nextEntryId(),
      at: typeof entry.at === 'string' && entry.at !== '' ? entry.at : nowIso(),
      label: typeof entry.label === 'string' ? entry.label : '',
      kind: kind,
      ops: ops
    };
    if (typeof entry.bookId === 'string' && entry.bookId !== '') { out.bookId = entry.bookId; }
    return out;
  }

  var entrySeq = 0;
  function nextEntryId() {
    entrySeq += 1;
    return 'u' + entrySeq + '_' + String(Date.now()).slice(-6);
  }

  /* ============================== 栈 ============================== */

  var stack = [];
  var listeners = [];
  var pendingWrites = [];
  var lastWrite = null;
  var stackVersion = 0;

  function bump() {
    stackVersion += 1;
    notify();
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]({
          size: stack.length,
          top: peekTop(),
          version: stackVersion
        });
      } catch (error) {
        /* 订阅者异常不影响撤销流程 */
      }
    }
  }

  function peekTop() {
    if (!stack.length) { return null; }
    var entry = stack[stack.length - 1];
    return {
      id: entry.id,
      at: entry.at,
      label: entry.label,
      kind: entry.kind,
      bookId: entry.bookId || null,
      count: entry.ops.length
    };
  }

  function push(entry) {
    var item = normalizeEntry(entry);
    if (!item) {
      return fail('E_INVALID_INPUT', '撤销条目缺少可执行的 ops', undefined);
    }
    if (!item.label) {
      item.label = describeAction(item.kind, item);
    }
    stack.push(item);
    while (stack.length > MAX_STEPS) { stack.shift(); }
    bump();
    return { ok: true, id: item.id, label: item.label, size: stack.length };
  }

  function clear() {
    var count = stack.length;
    stack = [];
    bump();
    return { ok: true, cleared: count };
  }

  function size() {
    return stack.length;
  }

  function peek() {
    return peekTop();
  }

  function entries() {
    var out = [];
    for (var i = 0; i < stack.length; i++) {
      out.push(peekOf(stack[i]));
    }
    return out;
  }

  function peekOf(entry) {
    return {
      id: entry.id,
      at: entry.at,
      label: entry.label,
      kind: entry.kind,
      bookId: entry.bookId || null,
      count: entry.ops.length
    };
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') { return function () {}; }
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index >= 0) { listeners.splice(index, 1); }
    };
  }

  /* ============================== 逆操作 ============================== */

  function softDelete(item) {
    item.deleted = true;
    item.deletedAt = nowIso();
    item.updatedAt = item.deletedAt;
  }

  function restoreEntry(item) {
    item.deleted = false;
    item.deletedAt = null;
    item.updatedAt = nowIso();
  }

  function stale() {
    return { ok: false, code: 'E_UNDO_STALE' };
  }

  function runOp(draft, op) {
    var kind = op.kind;
    var table = op.table || tableOf(op.entity);
    var list = table && bucketOf(draft, table);

    if (kind === 'settings') {
      if (!isObj(op.values)) { return { ok: false, code: 'E_UNDO_STALE' }; }
      draft.settings = clone(op.values);
      return { ok: true };
    }
    if (!table || (!Array.isArray(list) && kind !== 'raw')) {
      return { ok: false, code: 'E_INVALID_INPUT' };
    }
    var id = typeof op.id === 'string' ? op.id : '';

    if (kind === 'create' || kind === 'transfer') {
      if (SOFT_DELETE_TABLES.indexOf(table) < 0) {
        /* 非软删实体：create 的逆操作就是硬移除 */
        if (!removeItem(list, id)) { return stale(); }
        return { ok: true };
      }
      var created = findItem(list, id);
      if (!created) { return stale(); }
      if (kind === 'transfer' && created.type !== 'transfer') { return stale(); }
      if (created.deleted === true) { return { ok: true }; }
      softDelete(created);
      return { ok: true };
    }

    if (kind === 'update') {
      var current = findItem(list, id);
      if (!current) { return stale(); }
      if (typeof op.expectUpdatedAt === 'string' && op.expectUpdatedAt !== '' &&
        typeof current.updatedAt === 'string' && current.updatedAt !== op.expectUpdatedAt) {
        return stale();
      }
      if (!isObj(op.oldValues)) { return { ok: false, code: 'E_INVALID_INPUT' }; }
      assignValues(current, op.oldValues);
      current.updatedAt = nowIso();
      return { ok: true };
    }

    if (kind === 'delete') {
      var removed = findItem(list, id);
      if (!removed) { return stale(); }
      if (isObj(op.values)) { assignValues(removed, op.values); }
      restoreEntry(removed);
      return { ok: true };
    }

    if (kind === 'remove') {
      if (id && !removeItem(list, id)) { return { ok: true }; }
      if (!id && isObj(op.values) && op.values.id) { removeItem(list, op.values.id); }
      return { ok: true };
    }

    if (kind === 'restore') {
      var values = isObj(op.values) ? clone(op.values) : null;
      if (!values || typeof values.id !== 'string') { return { ok: false, code: 'E_INVALID_INPUT' }; }
      var exist = findItem(list, values.id);
      if (exist) {
        assignValues(exist, values);
        if (has(exist, 'deleted')) { exist.deleted = false; exist.deletedAt = null; }
      } else {
        list.push(values);
      }
      return { ok: true };
    }

    if (kind === 'raw') {
      if (op.values === null || op.values === undefined) {
        if (id) { removeItem(list, id); }
        return { ok: true };
      }
      if (!isObj(op.values)) { return { ok: false, code: 'E_INVALID_INPUT' }; }
      var row = findItem(list, op.values.id || id);
      if (row) {
        assignValues(row, op.values);
      } else {
        list.push(clone(op.values));
      }
      return { ok: true };
    }

    return { ok: false, code: 'E_INVALID_INPUT' };
  }

  function bucketOf(draft, table) {
    if (!draft || typeof draft !== 'object') { return null; }
    if (table === 'settings') { return draft.settings; }
    return draft[table];
  }

  /* 逆序执行（batch 语义：后做的先撤） */
  function applyOps(draft, ops) {
    var result = { ok: true };
    for (var i = ops.length - 1; i >= 0; i--) {
      var one = runOp(draft, ops[i]);
      if (!one || one.ok !== true) {
        return one || { ok: false, code: 'E_INVALID_INPUT' };
      }
      result = one;
    }
    return result;
  }

  /* 备份 / 回滚（仅内存直写模式需要，store.transaction 自带事务） */
  function snapshotDraft(draft) {
    var snap = {};
    if (!draft || typeof draft !== 'object') { return snap; }
    for (var key in draft) {
      if (!has(draft, key)) { continue; }
      var value = draft[key];
      snap[key] = (value !== null && typeof value === 'object') ? clone(value) : value;
    }
    return snap;
  }

  function restoreDraft(draft, snap) {
    if (!draft || typeof draft !== 'object') { return; }
    for (var key in snap) {
      if (has(snap, key)) { draft[key] = snap[key]; }
    }
  }

  /* 找出一块可直接写的内存状态（无 store.transaction 时的降级路径） */
  function inlineState(store) {
    if (!store || typeof store !== 'object') { return null; }
    if (Array.isArray(store.transactions) && Array.isArray(store.recurring)) { return store; }
    var keys = ['state', 'db', 'data', 'draft'];
    for (var i = 0; i < keys.length; i++) {
      var candidate = store[keys[i]];
      if (candidate && typeof candidate === 'object' && Array.isArray(candidate.transactions)) {
        return candidate;
      }
    }
    return null;
  }

  /* 串行化：连续 undo 不会互相踩栈（每次都基于最新栈顶） */
  function enqueue(task) {
    var base = pendingWrites.length ? pendingWrites[pendingWrites.length - 1] : (lastWrite || Promise.resolve());
    var job = base.then(task, task);
    pendingWrites.push(job);
    var cleanup = function () {
      var index = pendingWrites.indexOf(job);
      if (index >= 0) { pendingWrites.splice(index, 1); }
      lastWrite = job;
    };
    job.then(cleanup, cleanup);
    return job;
  }

  function lookupBookName(store, bookId) {
    if (!store || typeof bookId !== 'string' || bookId === '') { return '该账本'; }
    try {
      if (typeof store.list === 'function') {
        var books = store.list('book', { includeArchived: true });
        for (var i = 0; i < books.length; i++) {
          if (books[i] && books[i].id === bookId && typeof books[i].name === 'string') {
            return books[i].name;
          }
        }
      }
    } catch (error) {
      /* 读不到名字就退回占位文案 */
    }
    return '该账本';
  }

  function currentBookId(store, opts) {
    var o = isObj(opts) ? opts : {};
    if (typeof o.bookId === 'string' && o.bookId !== '') { return o.bookId; }
    try {
      if (store && typeof store.getSettings === 'function') {
        var settings = store.getSettings();
        if (isObj(settings)) {
          if (typeof settings.activeBookId === 'string' && settings.activeBookId !== '') {
            return settings.activeBookId;
          }
          if (typeof settings.currentBookId === 'string' && settings.currentBookId !== '') {
            return settings.currentBookId;
          }
        }
      }
    } catch (error) {
      /* 取不到就不做跨账本限制 */
    }
    return null;
  }

  /* 执行一次撤销（不弹栈，由 undo 统一处理） */
  function execute(store, entry) {
    var ops = entry.ops;

    if (store && typeof store.transaction === 'function') {
      return Promise.resolve()
        .then(function () {
          return store.transaction(function (draft) {
            var result = applyOps(draft, ops);
            if (result.ok !== true) {
              return { abort: true, code: result.code, path: result.path };
            }
            return { value: { count: ops.length } };
          });
        })
        .then(function (response) {
          if (response && response.ok === true) {
            return { ok: true, count: ops.length };
          }
          return fail(
            (response && response.code) || 'E_INVALID_INPUT',
            (response && response.message) || MESSAGES[(response && response.code)] || '撤销失败',
            response && response.path ? { path: response.path } : undefined
          );
        }, function (error) {
          return fail('E_INVALID_INPUT', String((error && error.message) || error));
        });
    }

    /* 降级：没有 store.transaction 时直接改传入的内存状态（自检用，也兼容骨架） */
    var target = inlineState(store);
    if (!target) {
      return Promise.resolve(fail('E_INVALID_INPUT', '撤销需要一个可写的 store（store.transaction 或 state）'));
    }
    var backup = snapshotDraft(target);
    var result;
    try {
      result = applyOps(target, ops);
    } catch (error) {
      restoreDraft(target, backup);
      return Promise.resolve(fail('E_INVALID_INPUT', String((error && error.message) || error)));
    }
    if (!result || result.ok !== true) {
      restoreDraft(target, backup);
      return Promise.resolve(fail((result && result.code) || 'E_INVALID_INPUT'));
    }
    return Promise.resolve({ ok: true, count: ops.length });
  }

  /* 撤销：
     返回 Promise<{ok:true, label, count, kind, id}> 或 {ok:false, code, message}
     - 空栈：E_UNDO_EMPTY（静默）
     - 跨账本：E_UNDO_CROSS_BOOK（条目保留，opts.bookId 或 store.getSettings().activeBookId 判定）
     - 记录变化：E_UNDO_STALE（条目丢弃）
     - 存储失败：条目保留可重试 */
  function undo(store, opts) {
    var o = isObj(opts) ? opts : {};
    return enqueue(function () {
      if (!stack.length) {
        return fail('E_UNDO_EMPTY', MESSAGES.E_UNDO_EMPTY, { silent: true });
      }
      var entry = stack[stack.length - 1];
      var current = currentBookId(store, o);
      if (entry.bookId && current && entry.bookId !== current) {
        return fail('E_UNDO_CROSS_BOOK', '请先切换到「' + lookupBookName(store, entry.bookId) + '」再撤销');
      }
      return execute(store, entry).then(function (result) {
        if (result.ok === true) {
          if (stack[stack.length - 1] === entry) { stack.pop(); }
          bump();
          return {
            ok: true,
            label: labelFor(entry),
            count: result.count,
            kind: entry.kind,
            id: entry.id,
            entryId: entry.id
          };
        }
        var out = fail(result.code, result.message, { path: result.path });
        if (result.code === 'E_UNDO_STALE') {
          var index = stack.indexOf(entry);
          if (index >= 0) { stack.splice(index, 1); }
          bump();
        }
        return out;
      });
    });
  }

  /* ============================== 导出 ============================== */

  var api = Object.freeze({
    MAX_STEPS: MAX_STEPS,
    MESSAGES: MESSAGES,

    /* 栈操作 */
    push: push,
    undo: undo,
    clear: clear,
    size: size,
    peek: peek,
    entries: entries,
    canUndo: function () { return stack.length > 0; },
    subscribe: subscribe,

    /* 文案 */
    labelFor: labelFor,
    describeAction: describeAction
  });

  core.undo = api;
  XZB.Core.undo = api;

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
