/* 小账本 2.0 · js/core/schema.js · owner: dba（T01）
 * 契约锚点：CONTRACT §2（实体字段表 / 默认值 / 种子）、§2.2（ID）、§2.14（不变量）、§8。
 * 硬规则：不新增字段名；分账金额仍是整数分；不读 DOM / 存储 / 网络。
 * 挂载：XZB.Core.schema（同时 XZB.core.schema），Node 下 module.exports 双挂载。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  var money = Core.money;
  var dates = Core.dates;
  if (!money || !dates) {
    throw new Error('schema.js 依赖 money.js 与 dates.js，请按 core 加载顺序引入');
  }

  var SCHEMA_VERSION = 3;
  var APP_VERSION = '2.2.0';

  var ID_PREFIXES = ['bk', 'ac', 'ca', 'tx', 'bg', 'cb', 'rc', 'gl', 'gd', 'sn', 'qi'];
  /* 后缀允许下划线：种子 ID 如 ca_other_expense 必须通过 */
  var ID_RE = /^(bk|ac|ca|tx|bg|cb|rc|gl|gd|sn|qi)_[a-z0-9_]{3,20}$/;
  var HEX_RE = /^#[0-9A-Fa-f]{6}$/;
  var PERIOD_KEY_RE = /^rc_[a-z0-9_]{3,20}@\d{4}-\d{2}-\d{2}$/;

  var BOOK_KINDS = ['daily', 'travel', 'business'];
  var ACCOUNT_TYPES = ['cash', 'debit', 'wechat', 'alipay', 'credit', 'savings'];
  var TX_TYPES = ['expense', 'income', 'transfer'];
  var FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
  var SOURCES = ['manual', 'nl', 'recurring', 'import'];
  /* 报销标记：none 不涉及；pending 垫付未报；done 已报下来（本轮只写 none/pending） */
  var REIMBURSE_STATES = ['none', 'pending', 'done'];
  var SNAPSHOT_REASONS = ['auto', 'manual', 'pre-import', 'pre-restore', 'pre-migrate'];

  var ACCOUNT_TYPE_META = Object.freeze({
    cash: Object.freeze({ label: '现金', sign: 1, icon: 'wallet', color: '#34C759' }),
    debit: Object.freeze({ label: '银行卡', sign: 1, icon: 'card', color: '#007AFF' }),
    wechat: Object.freeze({ label: '微信', sign: 1, icon: 'wechat', color: '#07C160' }),
    alipay: Object.freeze({ label: '支付宝', sign: 1, icon: 'alipay', color: '#1677FF' }),
    credit: Object.freeze({ label: '信用卡', sign: -1, icon: 'credit', color: '#FF3B30' }),
    savings: Object.freeze({ label: '储蓄', sign: 1, icon: 'piggy', color: '#FF9500' })
  });

  var LIMITS = Object.freeze({
    bookName: 20,
    accountName: 20,
    categoryName: 8,
    goalName: 20,
    recurringName: 20,
    bookNote: 60,
    accountNote: 60,
    txNote: 80,
    goalNote: 60,
    depositNote: 40,
    recurringNote: 80,
    aliases: 8,
    aliasLen: 10,
    tags: 5,
    tagLen: 10,
    quickItems: 24,
    quickItemName: 12,
    remindDays: 7,
    interval: 99,
    thresholdMin: 50,
    thresholdMax: 100
  });

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function str(value, fallback) {
    if (typeof value === 'string') { return value.trim(); }
    if (typeof value === 'number' && isFinite(value)) { return String(value); }
    return fallback;
  }

  function strOrNull(value) {
    var text = str(value, '');
    return text === '' ? null : text;
  }

  function toInt(value, fallback) {
    if (typeof value === 'number' && isFinite(value)) {
      var rounded = Math.round(value);
      return Number.isSafeInteger(rounded) ? rounded : fallback;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      var n = Number(value.trim());
      return Number.isSafeInteger(n) ? n : fallback;
    }
    return fallback;
  }

  function toIntOrNull(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var n = toInt(value, NaN);
    return isFinite(n) ? n : null;
  }

  /* 金额只接受「分」整数；带小数的一律不猜，交给 validate 拒绝 */
  function toAmount(value, fallback) {
    if (typeof value === 'number' && isFinite(value) &&
      Math.floor(value) === value && Number.isSafeInteger(value)) {
      return value;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      var n = Number(value.trim());
      if (Number.isSafeInteger(n)) { return n; }
    }
    return fallback;
  }

  function toBool(value, fallback) {
    if (value === true || value === false) { return value; }
    if (value === 1 || value === '1' || value === 'true' || value === 'yes') { return true; }
    if (value === 0 || value === '0' || value === 'false' || value === 'no') { return false; }
    return fallback;
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function charLen(value) {
    return typeof value === 'string' ? Array.from(value).length : 0;
  }

  function nameOk(value, max) {
    if (typeof value !== 'string') { return false; }
    var length = charLen(value);
    return length >= 1 && length <= max && value.indexOf('\n') < 0 && value.indexOf('\r') < 0;
  }

  function noteOk(value, max) {
    return typeof value === 'string' && charLen(value) <= max &&
      value.indexOf('\n') < 0 && value.indexOf('\r') < 0;
  }

  function idOk(value, prefix) {
    return typeof value === 'string' && ID_RE.test(value) &&
      (!prefix || value.indexOf(prefix + '_') === 0);
  }

  function hexOk(value) {
    return typeof value === 'string' && HEX_RE.test(value);
  }

  function iconOk(value) {
    if (typeof value !== 'string' || value === '') { return false; }
    var UI = XZB.UI;
    var names = UI && UI.icons && UI.icons.NAMES;
    if (Array.isArray(names) && names.length > 0) { return names.indexOf(value) >= 0; }
    return true;
  }

  function enumOr(value, allowed, fallback) {
    if (value === undefined || value === null || value === '') { return fallback; }
    return str(value, fallback);
  }

  function normalizeAliases(value) {
    if (!Array.isArray(value)) { return []; }
    var out = [];
    for (var i = 0; i < value.length; i++) {
      var alias = str(value[i], '');
      if (alias === '') { continue; }
      if (out.indexOf(alias) < 0) { out.push(alias); }
    }
    return out;
  }

  function normalizeTags(value) {
    var list = [];
    if (Array.isArray(value)) {
      list = value;
    } else if (typeof value === 'string') {
      list = value.split(/[,，\s]+/);
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tag = str(list[i], '');
      if (tag === '') { continue; }
      if (out.indexOf(tag) < 0) { out.push(tag); }
    }
    return out;
  }

  function currentIso(now) {
    return dates.isValidIsoStr(now) ? now : dates.nowIso(now);
  }

  function dateOfNow(now) {
    var text = typeof now === 'string' && dates.isValidIsoStr(now) ? now.slice(0, 10) : '';
    return dates.isValidDateStr(text) ? text : dates.todayStr();
  }

  function timeOfNow(now) {
    var text = typeof now === 'string' && dates.isValidIsoStr(now) ? now.slice(11, 16) : '';
    return dates.isValidTimeStr(text) ? text : dates.nowTime();
  }

  function stamp(input, now) {
    var createdAt = dates.isValidIsoStr(input.createdAt) ? input.createdAt : now;
    var updatedAt = dates.isValidIsoStr(input.updatedAt) ? input.updatedAt : createdAt;
    return { createdAt: createdAt, updatedAt: updatedAt };
  }

  /* ---------- ID 生成 ---------- */
  var generatedIds = Object.create(null);
  var lastMs = 0;
  var lastSuffix = 0;

  function randomSuffix() {
    var n;
    var cryptoObj = global.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      var buf = new Uint32Array(1);
      cryptoObj.getRandomValues(buf);
      n = buf[0] % 1679616;
    } else {
      n = Math.floor(Math.random() * 1679616);
    }
    var text = n.toString(36);
    while (text.length < 4) { text = '0' + text; }
    return text;
  }

  function existingIdSet(existing) {
    var set = Object.create(null);
    if (Array.isArray(existing)) {
      for (var i = 0; i < existing.length; i++) {
        if (typeof existing[i] === 'string') { set[existing[i]] = true; }
      }
    } else if (existing && typeof existing === 'object') {
      for (var key in existing) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) { set[key] = true; }
      }
    }
    return set;
  }

  /* 前缀 + base36 毫秒 + 4 位 base36 随机段；同毫秒内递增，保证唯一 */
  function newId(prefix, existing) {
    if (ID_PREFIXES.indexOf(prefix) < 0) { return null; }
    var used = existingIdSet(existing);
    for (var attempt = 0; attempt < 5; attempt++) {
      var ms = Date.now();
      var suffix;
      if (ms === lastMs) {
        lastSuffix = (lastSuffix + 1) % 1679616;
        suffix = lastSuffix.toString(36);
        while (suffix.length < 4) { suffix = '0' + suffix; }
      } else {
        lastMs = ms;
        suffix = randomSuffix();
        lastSuffix = parseInt(suffix, 36);
      }
      var id = prefix + '_' + ms.toString(36) + suffix;
      if (!generatedIds[id] && !used[id] && ID_RE.test(id)) {
        generatedIds[id] = true;
        return id;
      }
    }
    return null;
  }

  function idOf(input, prefix) {
    var provided = str(input.id, '');
    if (provided !== '') { return provided; }
    return newId(prefix);
  }

  /* ---------- 实体工厂 + 归一化 ---------- */
  function normalizeBook(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var meta = stamp(raw, now);
    return {
      id: str(raw.id, ''),
      name: str(raw.name, ''),
      kind: enumOr(raw.kind, BOOK_KINDS, 'daily'),
      color: hexOk(raw.color) ? str(raw.color, '#007AFF') : '#007AFF',
      icon: str(raw.icon, '') || 'book',
      sort: toInt(raw.sort, 10),
      archived: toBool(raw.archived, false),
      note: str(raw.note, ''),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    };
  }

  function normalizeAccount(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var type = enumOr(raw.type, ACCOUNT_TYPES, 'cash');
    var meta = ACCOUNT_TYPE_META[type] || ACCOUNT_TYPE_META.cash;
    var base = stamp(raw, now);
    return {
      id: str(raw.id, ''),
      name: str(raw.name, ''),
      type: type,
      icon: str(raw.icon, '') || meta.icon,
      color: hexOk(raw.color) ? str(raw.color, meta.color) : meta.color,
      openingBalanceCents: toAmount(raw.openingBalanceCents, 0),
      limitCents: toAmount(raw.limitCents, 0),
      billDay: toIntOrNull(raw.billDay),
      dueDay: toIntOrNull(raw.dueDay),
      archived: toBool(raw.archived, false),
      sort: toInt(raw.sort, 10),
      note: str(raw.note, ''),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeCategory(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    return {
      id: str(raw.id, ''),
      kind: enumOr(raw.kind, ['expense', 'income'], ''),
      name: str(raw.name, ''),
      icon: str(raw.icon, ''),
      color: hexOk(raw.color) ? str(raw.color, '') : '',
      sort: toInt(raw.sort, 10),
      hidden: toBool(raw.hidden, false),
      system: toBool(raw.system, false),
      aliases: normalizeAliases(raw.aliases),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeTransaction(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var type = enumOr(raw.type, TX_TYPES, 'expense');
    var base = stamp(raw, now);
    var deleted = toBool(raw.deleted, false);
    var toAccountId = strOrNull(raw.toAccountId);
    var categoryId = strOrNull(raw.categoryId);
    if (type !== 'transfer') { toAccountId = null; }
    if (type === 'transfer') { categoryId = null; }

    return {
      id: str(raw.id, ''),
      bookId: str(raw.bookId, ''),
      type: type,
      amountCents: toAmount(raw.amountCents, 0),
      accountId: str(raw.accountId, ''),
      toAccountId: toAccountId,
      categoryId: categoryId,
      date: dates.isValidDateStr(raw.date) ? raw.date : (raw.date === undefined || raw.date === null || raw.date === '' ? dateOfNow(now) : str(raw.date, '')),
      time: dates.isValidTimeStr(raw.time) ? raw.time : (raw.time === undefined || raw.time === null || raw.time === '' ? timeOfNow(now) : str(raw.time, '')),
      note: str(raw.note, ''),
      tags: normalizeTags(raw.tags),
      source: enumOr(raw.source, SOURCES, 'manual'),
      /* 只有支出才谈得上报销；收入/转账一律 none，避免脏数据 */
      reimburse: type === 'expense' ? enumOr(raw.reimburse, REIMBURSE_STATES, 'none') : 'none',
      reimburseAt: dates.isValidIsoStr(raw.reimburseAt) ? raw.reimburseAt : null,
      recurringId: strOrNull(raw.recurringId),
      periodKey: strOrNull(raw.periodKey),
      importRef: strOrNull(raw.importRef),
      deleted: deleted,
      deletedAt: deleted && dates.isValidIsoStr(raw.deletedAt) ? raw.deletedAt : null,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeBudget(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    var month = raw.month === undefined || raw.month === null || raw.month === '' ?
      dateOfNow(now).slice(0, 7) : str(raw.month, '');
    return {
      id: str(raw.id, ''),
      bookId: str(raw.bookId, ''),
      month: month,
      totalCents: toAmount(raw.totalCents, 0),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeCategoryBudget(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    var month = raw.month === undefined || raw.month === null || raw.month === '' ?
      dateOfNow(now).slice(0, 7) : str(raw.month, '');
    return {
      id: str(raw.id, ''),
      bookId: str(raw.bookId, ''),
      month: month,
      categoryId: str(raw.categoryId, ''),
      amountCents: toAmount(raw.amountCents, 0),
      thresholdPct: toInt(raw.thresholdPct, 80),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeRecurring(input, now, defaultAutoPost) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    var startDate = dates.isValidDateStr(raw.startDate) ? raw.startDate :
      (raw.startDate === undefined || raw.startDate === null || raw.startDate === '' ?
        dateOfNow(now) : str(raw.startDate, ''));
    var dayOfMonth = toIntOrNull(raw.dayOfMonth);
    /* §2.9：29–31 一律夹到 28 */
    if (dayOfMonth !== null && dayOfMonth > 28 && dayOfMonth <= 31) { dayOfMonth = 28; }
    return {
      id: str(raw.id, ''),
      bookId: str(raw.bookId, ''),
      name: str(raw.name, ''),
      type: enumOr(raw.type, TX_TYPES, 'expense'),
      amountCents: toAmount(raw.amountCents, 0),
      accountId: str(raw.accountId, ''),
      toAccountId: strOrNull(raw.toAccountId),
      categoryId: strOrNull(raw.categoryId),
      freq: enumOr(raw.freq, FREQS, 'monthly'),
      interval: toInt(raw.interval, 1),
      weekday: toIntOrNull(raw.weekday),
      dayOfMonth: dayOfMonth,
      monthOfYear: toIntOrNull(raw.monthOfYear),
      startDate: startDate,
      endDate: strOrNull(raw.endDate),
      nextDueDate: strOrNull(raw.nextDueDate) || startDate,
      lastPostedPeriod: strOrNull(raw.lastPostedPeriod),
      autoPost: toBool(raw.autoPost, defaultAutoPost === true),
      paused: toBool(raw.paused, false),
      archived: toBool(raw.archived, false),
      remindDays: toInt(raw.remindDays, 3),
      note: str(raw.note, ''),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeGoal(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    return {
      id: str(raw.id, ''),
      bookId: str(raw.bookId, ''),
      name: str(raw.name, ''),
      targetCents: toAmount(raw.targetCents, 0),
      deadline: strOrNull(raw.deadline),
      accountId: strOrNull(raw.accountId),
      icon: str(raw.icon, '') || 'piggy',
      color: hexOk(raw.color) ? str(raw.color, '#FF9500') : '#FF9500',
      sort: toInt(raw.sort, 10),
      archived: toBool(raw.archived, false),
      note: str(raw.note, ''),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeGoalDeposit(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    var deleted = toBool(raw.deleted, false);
    return {
      id: str(raw.id, ''),
      goalId: str(raw.goalId, ''),
      amountCents: toAmount(raw.amountCents, 0),
      date: dates.isValidDateStr(raw.date) ? raw.date :
        (raw.date === undefined || raw.date === null || raw.date === '' ? dateOfNow(now) : str(raw.date, '')),
      note: str(raw.note, ''),
      deleted: deleted,
      deletedAt: deleted && dates.isValidIsoStr(raw.deletedAt) ? raw.deletedAt : null,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function createBook(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'bk');
    return normalizeBook(merged, now);
  }

  function createAccount(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'ac');
    return normalizeAccount(merged, now);
  }

  function createCategory(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'ca');
    return normalizeCategory(merged, now);
  }

  function createTransaction(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'tx');
    return normalizeTransaction(merged, now);
  }

  function createBudget(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'bg');
    return normalizeBudget(merged, now);
  }

  function createCategoryBudget(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'cb');
    return normalizeCategoryBudget(merged, now);
  }

  function createRecurring(input, now, opts) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'rc');
    var autoPost = opts && opts.autoPost === true;
    return normalizeRecurring(merged, now, autoPost);
  }

  function createGoal(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'gl');
    return normalizeGoal(merged, now);
  }

  function createGoalDeposit(input, now) {
    var raw = isObj(input) ? input : {};
    var merged = {};
    for (var key in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) { merged[key] = raw[key]; }
    }
    merged.id = idOf(raw, 'gd');
    return normalizeGoalDeposit(merged, now);
  }

  /* ---------- 校验 ---------- */
  function result(errors) {
    return { ok: errors.length === 0, errors: errors };
  }

  function addError(errors, field, code) {
    errors.push({ field: field, code: code });
  }

  function validateBook(entity) {
    var x = isObj(entity) ? entity : {};
    var errors = [];
    if (!idOk(x.id, 'bk')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!nameOk(x.name, LIMITS.bookName)) { addError(errors, 'name', 'E_INVALID_INPUT'); }
    if (BOOK_KINDS.indexOf(x.kind) < 0) { addError(errors, 'kind', 'E_INVALID_INPUT'); }
    if (!hexOk(x.color)) { addError(errors, 'color', 'E_INVALID_INPUT'); }
    if (!iconOk(x.icon)) { addError(errors, 'icon', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.sort)) { addError(errors, 'sort', 'E_INVALID_INPUT'); }
    if (typeof x.archived !== 'boolean') { addError(errors, 'archived', 'E_INVALID_INPUT'); }
    if (!noteOk(x.note, LIMITS.bookNote)) { addError(errors, 'note', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function validateAccount(entity) {
    var x = isObj(entity) ? entity : {};
    var errors = [];
    if (!idOk(x.id, 'ac')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!nameOk(x.name, LIMITS.accountName)) { addError(errors, 'name', 'E_INVALID_INPUT'); }
    if (ACCOUNT_TYPES.indexOf(x.type) < 0) { addError(errors, 'type', 'E_ACCOUNT_TYPE'); }
    if (!iconOk(x.icon)) { addError(errors, 'icon', 'E_INVALID_INPUT'); }
    if (!hexOk(x.color)) { addError(errors, 'color', 'E_INVALID_INPUT'); }
    if (!money.isCents(x.openingBalanceCents)) { addError(errors, 'openingBalanceCents', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.limitCents) || x.limitCents < 0 || x.limitCents > money.MAX_CENTS) {
      addError(errors, 'limitCents', 'E_ACCOUNT_LIMIT');
    } else if (x.type !== 'credit' && x.limitCents > 0) {
      addError(errors, 'limitCents', 'E_ACCOUNT_LIMIT');
    }
    var billOk = x.billDay === null || (Number.isInteger(x.billDay) && x.billDay >= 1 && x.billDay <= 28);
    var dueOk = x.dueDay === null || (Number.isInteger(x.dueDay) && x.dueDay >= 1 && x.dueDay <= 28);
    if (!billOk || !dueOk) {
      addError(errors, 'billDay', 'E_ACCOUNT_BILLDAY');
    } else if (x.type !== 'credit' && (x.billDay !== null || x.dueDay !== null)) {
      addError(errors, 'billDay', 'E_ACCOUNT_BILLDAY');
    }
    if (typeof x.archived !== 'boolean') { addError(errors, 'archived', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.sort)) { addError(errors, 'sort', 'E_INVALID_INPUT'); }
    if (!noteOk(x.note, LIMITS.accountNote)) { addError(errors, 'note', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function validateCategory(entity, ctx) {
    var x = isObj(entity) ? entity : {};
    var context = isObj(ctx) ? ctx : {};
    var errors = [];
    if (!idOk(x.id, 'ca')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (x.kind !== 'expense' && x.kind !== 'income') { addError(errors, 'kind', 'E_INVALID_INPUT'); }
    if (!nameOk(x.name, LIMITS.categoryName)) { addError(errors, 'name', 'E_INVALID_INPUT'); }
    if (!iconOk(x.icon)) { addError(errors, 'icon', 'E_INVALID_INPUT'); }
    if (!hexOk(x.color)) { addError(errors, 'color', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.sort)) { addError(errors, 'sort', 'E_INVALID_INPUT'); }
    if (typeof x.hidden !== 'boolean') { addError(errors, 'hidden', 'E_INVALID_INPUT'); }
    if (typeof x.system !== 'boolean') { addError(errors, 'system', 'E_INVALID_INPUT'); }
    if (!Array.isArray(x.aliases) || x.aliases.length > LIMITS.aliases) {
      addError(errors, 'aliases', 'E_INVALID_INPUT');
    } else {
      var seen = Object.create(null);
      for (var i = 0; i < x.aliases.length; i++) {
        var alias = x.aliases[i];
        if (!nameOk(alias, LIMITS.aliasLen) || seen[alias]) {
          addError(errors, 'aliases', 'E_INVALID_INPUT');
          break;
        }
        seen[alias] = true;
      }
    }
    if (context.original && context.original.system === true &&
      context.original.name !== x.name) {
      addError(errors, 'name', 'E_CATEGORY_NAME');
    }
    if (Array.isArray(context.categories)) {
      for (var j = 0; j < context.categories.length; j++) {
        var other = context.categories[j];
        if (!isObj(other) || other.id === x.id) { continue; }
        if (other.kind === x.kind && other.name === x.name) {
          addError(errors, 'name', 'E_CATEGORY_DUP');
          break;
        }
      }
    }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function findById(list, id) {
    if (!Array.isArray(list) || typeof id !== 'string') { return null; }
    for (var i = 0; i < list.length; i++) {
      if (isObj(list[i]) && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function validateTransaction(entity, ctx) {
    var x = isObj(entity) ? entity : {};
    var context = isObj(ctx) ? ctx : {};
    var allowArchived = context.allowArchived === true;
    var errors = [];
    if (!idOk(x.id, 'tx')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!idOk(x.bookId, 'bk')) { addError(errors, 'bookId', 'E_BOOK_MISSING'); }
    if (TX_TYPES.indexOf(x.type) < 0) { addError(errors, 'type', 'E_TX_TYPE'); }
    if (!Number.isInteger(x.amountCents) || x.amountCents <= 0 ||
      x.amountCents > money.MAX_CENTS) {
      addError(errors, 'amountCents', 'E_TX_AMOUNT');
    }
    if (!idOk(x.accountId, 'ac')) { addError(errors, 'accountId', 'E_ACCOUNT_MISSING'); }
    if (x.type === 'transfer') {
      if (!idOk(x.toAccountId, 'ac')) {
        addError(errors, 'toAccountId', 'E_ACCOUNT_MISSING');
      } else if (x.toAccountId === x.accountId) {
        addError(errors, 'toAccountId', 'E_TRANSFER_SAME');
      }
      if (x.categoryId !== null) { addError(errors, 'categoryId', 'E_INVALID_INPUT'); }
    } else if (x.type === 'expense' || x.type === 'income') {
      if (x.toAccountId !== null) { addError(errors, 'toAccountId', 'E_INVALID_INPUT'); }
      if (!idOk(x.categoryId, 'ca')) {
        addError(errors, 'categoryId', 'E_TX_CATEGORY_REQUIRED');
      }
    }
    if (!dates.isValidDateStr(x.date)) {
      addError(errors, 'date', 'E_TX_DATE');
    } else {
      var today = dates.isValidDateStr(context.today) ? context.today : dates.todayStr();
      var upper = dates.addDays(today, 366);
      if (x.date < '2000-01-01' || (upper && x.date > upper)) {
        addError(errors, 'date', 'E_TX_DATE');
      }
    }
    if (!dates.isValidTimeStr(x.time)) { addError(errors, 'time', 'E_INVALID_INPUT'); }
    if (REIMBURSE_STATES.indexOf(x.reimburse) < 0) {
      addError(errors, 'reimburse', 'E_INVALID_INPUT');
    }
    if (x.reimburseAt !== null && x.reimburseAt !== undefined && !dates.isValidIsoStr(x.reimburseAt)) {
      addError(errors, 'reimburseAt', 'E_INVALID_INPUT');
    }
    if (!noteOk(x.note, LIMITS.txNote)) { addError(errors, 'note', 'E_TX_NOTE'); }
    if (!Array.isArray(x.tags) || x.tags.length > LIMITS.tags) {
      addError(errors, 'tags', 'E_TX_TAG');
    } else {
      var seen = Object.create(null);
      for (var i = 0; i < x.tags.length; i++) {
        var tag = x.tags[i];
        if (!nameOk(tag, LIMITS.tagLen) || seen[tag]) {
          addError(errors, 'tags', 'E_TX_TAG');
          break;
        }
        seen[tag] = true;
      }
    }
    if (SOURCES.indexOf(x.source) < 0) { addError(errors, 'source', 'E_INVALID_INPUT'); }
    if (x.recurringId !== null && !idOk(x.recurringId, 'rc')) {
      addError(errors, 'recurringId', 'E_INVALID_INPUT');
    }
    if (x.periodKey !== null) {
      var match = typeof x.periodKey === 'string' ? PERIOD_KEY_RE.exec(x.periodKey) : null;
      var keyDate = match ? x.periodKey.slice(x.periodKey.indexOf('@') + 1) : '';
      if (!match || !dates.isValidDateStr(keyDate)) {
        addError(errors, 'periodKey', 'E_INVALID_INPUT');
      }
      if (x.source === 'manual') { addError(errors, 'periodKey', 'E_INVALID_INPUT'); }
    }
    if (x.importRef !== null && (typeof x.importRef !== 'string' || x.importRef === '')) {
      addError(errors, 'importRef', 'E_INVALID_INPUT');
    }
    if (typeof x.deleted !== 'boolean') {
      addError(errors, 'deleted', 'E_INVALID_INPUT');
    } else if (x.deleted === true && !dates.isValidIsoStr(x.deletedAt)) {
      addError(errors, 'deletedAt', 'E_INVALID_INPUT');
    } else if (x.deleted === false && x.deletedAt !== null) {
      addError(errors, 'deletedAt', 'E_INVALID_INPUT');
    }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }

    if (Array.isArray(context.books) && idOk(x.bookId, 'bk')) {
      var book = findById(context.books, x.bookId);
      if (!book) {
        addError(errors, 'bookId', 'E_BOOK_MISSING');
      } else if (book.archived === true && !allowArchived) {
        addError(errors, 'bookId', 'E_BOOK_ARCHIVED');
      }
    }
    if (Array.isArray(context.accounts) && idOk(x.accountId, 'ac')) {
      var account = findById(context.accounts, x.accountId);
      if (!account) {
        addError(errors, 'accountId', 'E_ACCOUNT_MISSING');
      } else if (account.archived === true && !allowArchived) {
        addError(errors, 'accountId', 'E_ACCOUNT_ARCHIVED');
      }
    }
    if (x.type === 'transfer' && Array.isArray(context.accounts) && idOk(x.toAccountId, 'ac')) {
      var toAccount = findById(context.accounts, x.toAccountId);
      if (!toAccount) {
        addError(errors, 'toAccountId', 'E_ACCOUNT_MISSING');
      } else if (toAccount.archived === true && !allowArchived) {
        addError(errors, 'toAccountId', 'E_ACCOUNT_ARCHIVED');
      }
    }
    if (Array.isArray(context.categories) && x.categoryId !== null && idOk(x.categoryId, 'ca')) {
      var category = findById(context.categories, x.categoryId);
      if (!category) {
        addError(errors, 'categoryId', 'E_CATEGORY_MISSING');
      } else if (x.type !== 'transfer' && category.kind !== x.type) {
        addError(errors, 'categoryId', 'E_CATEGORY_KIND');
      }
    }
    return result(errors);
  }

  function validateTransfer(entity, ctx) {
    var x = isObj(entity) ? entity : {};
    if (x.type !== 'transfer') {
      return { ok: false, errors: [{ field: 'type', code: 'E_TX_TYPE' }] };
    }
    return validateTransaction(x, ctx);
  }

  function validateBudget(entity) {
    var x = isObj(entity) ? entity : {};
    var errors = [];
    if (!idOk(x.id, 'bg')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!idOk(x.bookId, 'bk')) { addError(errors, 'bookId', 'E_BOOK_MISSING'); }
    if (!dates.isValidMonthStr(x.month) || x.month < '2000-01') {
      addError(errors, 'month', 'E_BUDGET_MONTH');
    }
    if (!Number.isInteger(x.totalCents) || x.totalCents < 0 || x.totalCents > money.MAX_CENTS) {
      addError(errors, 'totalCents', 'E_BUDGET_AMOUNT');
    }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function validateCategoryBudget(entity, ctx) {
    var x = isObj(entity) ? entity : {};
    var context = isObj(ctx) ? ctx : {};
    var errors = [];
    if (!idOk(x.id, 'cb')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!idOk(x.bookId, 'bk')) { addError(errors, 'bookId', 'E_BOOK_MISSING'); }
    if (!dates.isValidMonthStr(x.month) || x.month < '2000-01') {
      addError(errors, 'month', 'E_BUDGET_MONTH');
    }
    if (!idOk(x.categoryId, 'ca')) { addError(errors, 'categoryId', 'E_CATEGORY_MISSING'); }
    if (!Number.isInteger(x.amountCents) || x.amountCents < 0 || x.amountCents > money.MAX_CENTS) {
      addError(errors, 'amountCents', 'E_BUDGET_AMOUNT');
    }
    if (!Number.isInteger(x.thresholdPct) || x.thresholdPct < LIMITS.thresholdMin ||
      x.thresholdPct > LIMITS.thresholdMax) {
      addError(errors, 'thresholdPct', 'E_BUDGET_AMOUNT');
    }
    if (Array.isArray(context.categories) && idOk(x.categoryId, 'ca')) {
      var category = findById(context.categories, x.categoryId);
      if (!category || category.kind !== 'expense') {
        addError(errors, 'categoryId', 'E_CATEGORY_KIND');
      }
    }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function validateRecurring(entity, ctx) {
    var x = isObj(entity) ? entity : {};
    var context = isObj(ctx) ? ctx : {};
    var errors = [];
    if (!idOk(x.id, 'rc')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!idOk(x.bookId, 'bk')) { addError(errors, 'bookId', 'E_BOOK_MISSING'); }
    if (!nameOk(x.name, LIMITS.recurringName)) { addError(errors, 'name', 'E_INVALID_INPUT'); }
    if (TX_TYPES.indexOf(x.type) < 0) { addError(errors, 'type', 'E_TX_TYPE'); }
    if (!Number.isInteger(x.amountCents) || x.amountCents <= 0 ||
      x.amountCents > money.MAX_CENTS) {
      addError(errors, 'amountCents', 'E_TX_AMOUNT');
    }
    if (!idOk(x.accountId, 'ac')) { addError(errors, 'accountId', 'E_ACCOUNT_MISSING'); }
    if (x.type === 'transfer') {
      if (!idOk(x.toAccountId, 'ac')) {
        addError(errors, 'toAccountId', 'E_ACCOUNT_MISSING');
      } else if (x.toAccountId === x.accountId) {
        addError(errors, 'toAccountId', 'E_TRANSFER_SAME');
      }
      if (x.categoryId !== null) { addError(errors, 'categoryId', 'E_INVALID_INPUT'); }
    } else if (x.type === 'expense' || x.type === 'income') {
      if (x.toAccountId !== null) { addError(errors, 'toAccountId', 'E_INVALID_INPUT'); }
      if (!idOk(x.categoryId, 'ca')) {
        addError(errors, 'categoryId', 'E_TX_CATEGORY_REQUIRED');
      }
    }
    if (FREQS.indexOf(x.freq) < 0) { addError(errors, 'freq', 'E_RECURRING_RULE'); }
    if (!Number.isInteger(x.interval) || x.interval < 1 || x.interval > LIMITS.interval) {
      addError(errors, 'interval', 'E_RECURRING_RULE');
    }
    if (x.weekday !== null && (!Number.isInteger(x.weekday) || x.weekday < 0 || x.weekday > 6)) {
      addError(errors, 'weekday', 'E_RECURRING_RULE');
    }
    if (x.dayOfMonth !== null && (!Number.isInteger(x.dayOfMonth) || x.dayOfMonth < 1 || x.dayOfMonth > 28)) {
      addError(errors, 'dayOfMonth', 'E_RECURRING_RULE');
    }
    if (x.monthOfYear !== null && (!Number.isInteger(x.monthOfYear) || x.monthOfYear < 1 || x.monthOfYear > 12)) {
      addError(errors, 'monthOfYear', 'E_RECURRING_RULE');
    }
    if (x.freq === 'weekly' && x.weekday === null) {
      addError(errors, 'weekday', 'E_RECURRING_RULE');
    }
    if ((x.freq === 'monthly' || x.freq === 'yearly') && x.dayOfMonth === null) {
      addError(errors, 'dayOfMonth', 'E_RECURRING_RULE');
    }
    if (x.freq === 'yearly' && x.monthOfYear === null) {
      addError(errors, 'monthOfYear', 'E_RECURRING_RULE');
    }
    if (x.freq === 'daily' && (x.weekday !== null || x.dayOfMonth !== null || x.monthOfYear !== null)) {
      addError(errors, 'freq', 'E_RECURRING_RULE');
    }
    if (!dates.isValidDateStr(x.startDate)) {
      addError(errors, 'startDate', 'E_RECURRING_RULE');
    }
    if (x.endDate !== null) {
      if (!dates.isValidDateStr(x.endDate)) {
        addError(errors, 'endDate', 'E_RECURRING_RULE');
      } else if (dates.isValidDateStr(x.startDate) && x.endDate < x.startDate) {
        addError(errors, 'endDate', 'E_RECURRING_RULE');
      }
    }
    if (x.nextDueDate !== null && !dates.isValidDateStr(x.nextDueDate)) {
      addError(errors, 'nextDueDate', 'E_RECURRING_RULE');
    }
    if (x.lastPostedPeriod !== null) {
      var match = typeof x.lastPostedPeriod === 'string' ? PERIOD_KEY_RE.exec(x.lastPostedPeriod) : null;
      var keyDate = match ? x.lastPostedPeriod.slice(x.lastPostedPeriod.indexOf('@') + 1) : '';
      if (!match || !dates.isValidDateStr(keyDate)) {
        addError(errors, 'lastPostedPeriod', 'E_RECURRING_RULE');
      }
    }
    if (typeof x.autoPost !== 'boolean') { addError(errors, 'autoPost', 'E_INVALID_INPUT'); }
    if (typeof x.paused !== 'boolean') { addError(errors, 'paused', 'E_INVALID_INPUT'); }
    if (typeof x.archived !== 'boolean') { addError(errors, 'archived', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.remindDays) || x.remindDays < 0 || x.remindDays > LIMITS.remindDays) {
      addError(errors, 'remindDays', 'E_INVALID_INPUT');
    }
    if (!noteOk(x.note, LIMITS.recurringNote)) { addError(errors, 'note', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }

    if (Array.isArray(context.books) && idOk(x.bookId, 'bk')) {
      var book = findById(context.books, x.bookId);
      if (!book) {
        addError(errors, 'bookId', 'E_BOOK_MISSING');
      } else if (book.archived === true && context.allowArchived !== true) {
        addError(errors, 'bookId', 'E_BOOK_ARCHIVED');
      }
    }
    if (Array.isArray(context.accounts) && idOk(x.accountId, 'ac')) {
      var account = findById(context.accounts, x.accountId);
      if (!account) {
        addError(errors, 'accountId', 'E_ACCOUNT_MISSING');
      } else if (account.archived === true && context.allowArchived !== true) {
        addError(errors, 'accountId', 'E_ACCOUNT_ARCHIVED');
      }
    }
    if (x.type === 'transfer' && Array.isArray(context.accounts) && idOk(x.toAccountId, 'ac')) {
      var toAccount = findById(context.accounts, x.toAccountId);
      if (!toAccount) {
        addError(errors, 'toAccountId', 'E_ACCOUNT_MISSING');
      } else if (toAccount.archived === true && context.allowArchived !== true) {
        addError(errors, 'toAccountId', 'E_ACCOUNT_ARCHIVED');
      }
    }
    if (Array.isArray(context.categories) && x.categoryId !== null && idOk(x.categoryId, 'ca')) {
      var category = findById(context.categories, x.categoryId);
      if (!category) {
        addError(errors, 'categoryId', 'E_CATEGORY_MISSING');
      } else if (x.type !== 'transfer' && category.kind !== x.type) {
        addError(errors, 'categoryId', 'E_CATEGORY_KIND');
      }
    }
    return result(errors);
  }

  function validateGoal(entity) {
    var x = isObj(entity) ? entity : {};
    var errors = [];
    if (!idOk(x.id, 'gl')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!idOk(x.bookId, 'bk')) { addError(errors, 'bookId', 'E_BOOK_MISSING'); }
    if (!nameOk(x.name, LIMITS.goalName)) { addError(errors, 'name', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.targetCents) || x.targetCents <= 0 ||
      x.targetCents > money.MAX_CENTS) {
      addError(errors, 'targetCents', 'E_GOAL_TARGET');
    }
    if (x.deadline !== null && !dates.isValidDateStr(x.deadline)) {
      addError(errors, 'deadline', 'E_INVALID_INPUT');
    }
    if (x.accountId !== null && !idOk(x.accountId, 'ac')) {
      addError(errors, 'accountId', 'E_ACCOUNT_MISSING');
    }
    if (!iconOk(x.icon)) { addError(errors, 'icon', 'E_INVALID_INPUT'); }
    if (!hexOk(x.color)) { addError(errors, 'color', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.sort)) { addError(errors, 'sort', 'E_INVALID_INPUT'); }
    if (typeof x.archived !== 'boolean') { addError(errors, 'archived', 'E_INVALID_INPUT'); }
    if (!noteOk(x.note, LIMITS.goalNote)) { addError(errors, 'note', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function validateGoalDeposit(entity, ctx) {
    var x = isObj(entity) ? entity : {};
    var context = isObj(ctx) ? ctx : {};
    var errors = [];
    if (!idOk(x.id, 'gd')) { addError(errors, 'id', 'E_INVALID_INPUT'); }
    if (!idOk(x.goalId, 'gl')) { addError(errors, 'goalId', 'E_GOAL_NOT_FOUND'); }
    if (!Number.isInteger(x.amountCents) || x.amountCents <= 0 ||
      x.amountCents > money.MAX_CENTS) {
      addError(errors, 'amountCents', 'E_GOAL_DEPOSIT_AMOUNT');
    }
    if (!dates.isValidDateStr(x.date)) {
      addError(errors, 'date', 'E_TX_DATE');
    } else {
      var today = dates.isValidDateStr(context.today) ? context.today : dates.todayStr();
      var upper = dates.addDays(today, 366);
      if (x.date < '2000-01-01' || (upper && x.date > upper)) {
        addError(errors, 'date', 'E_TX_DATE');
      }
    }
    if (!noteOk(x.note, LIMITS.depositNote)) { addError(errors, 'note', 'E_INVALID_INPUT'); }
    if (typeof x.deleted !== 'boolean') {
      addError(errors, 'deleted', 'E_INVALID_INPUT');
    } else if (x.deleted === true && !dates.isValidIsoStr(x.deletedAt)) {
      addError(errors, 'deletedAt', 'E_INVALID_INPUT');
    } else if (x.deleted === false && x.deletedAt !== null) {
      addError(errors, 'deletedAt', 'E_INVALID_INPUT');
    }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    if (Array.isArray(context.goals) && idOk(x.goalId, 'gl') && !findById(context.goals, x.goalId)) {
      addError(errors, 'goalId', 'E_GOAL_NOT_FOUND');
    }
    return result(errors);
  }

  /* ---------- 设置 / 种子 / 整库 ---------- */
  function defaultSettings(now) {
    now = currentIso(now);
    return {
      currency: 'CNY',
      locale: 'zh-CN',
      firstDayOfWeek: 1,
      monthStartDay: 1,
      defaultAccountId: 'ac_wechat',
      defaultExpenseCategoryId: 'ca_food',
      defaultIncomeCategoryId: 'ca_salary',
      budgetAlertPct: 80,
      recurringAutoPost: false,
      snapshotAuto: true,
      hideAmounts: false,
      quickItems: [],
      createdAt: now,
      updatedAt: now
    };
  }

  /* 快捷项目（旧版「自定义快捷项目」的遗留数据：现版本界面不读取，
     「常用」行由历史高频组合生成；保留 normalize 只为旧 JSON 备份能导入，随 settings 进备份） */
  function normalizeQuickItem(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    return {
      id: str(raw.id, '') || newId('qi'),
      name: str(raw.name, '').slice(0, LIMITS.quickItemName),
      amountCents: toAmount(raw.amountCents, 0),
      categoryId: str(raw.categoryId, ''),
      accountId: str(raw.accountId, ''),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function normalizeSettings(input, now) {
    var raw = isObj(input) ? input : {};
    now = currentIso(now);
    var base = stamp(raw, now);
    return {
      currency: str(raw.currency, 'CNY') || 'CNY',
      locale: str(raw.locale, 'zh-CN') || 'zh-CN',
      firstDayOfWeek: toInt(raw.firstDayOfWeek, 1),
      monthStartDay: toInt(raw.monthStartDay, 1),
      defaultAccountId: str(raw.defaultAccountId, 'ac_wechat') || 'ac_wechat',
      defaultExpenseCategoryId: str(raw.defaultExpenseCategoryId, 'ca_food') || 'ca_food',
      defaultIncomeCategoryId: str(raw.defaultIncomeCategoryId, 'ca_salary') || 'ca_salary',
      budgetAlertPct: toInt(raw.budgetAlertPct, 80),
      recurringAutoPost: toBool(raw.recurringAutoPost, false),
      snapshotAuto: toBool(raw.snapshotAuto, true),
      hideAmounts: toBool(raw.hideAmounts, false),
      quickItems: toArray(raw.quickItems).slice(0, LIMITS.quickItems).map(function (item) {
        return normalizeQuickItem(item, now);
      }),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }

  function validateSettings(settings) {
    var x = isObj(settings) ? settings : {};
    var errors = [];
    if (x.currency !== 'CNY') { addError(errors, 'currency', 'E_INVALID_INPUT'); }
    if (x.locale !== 'zh-CN') { addError(errors, 'locale', 'E_INVALID_INPUT'); }
    if (!Number.isInteger(x.firstDayOfWeek) || x.firstDayOfWeek < 0 || x.firstDayOfWeek > 6) {
      addError(errors, 'firstDayOfWeek', 'E_INVALID_INPUT');
    }
    if (!Number.isInteger(x.monthStartDay) || x.monthStartDay < 1 || x.monthStartDay > 28) {
      addError(errors, 'monthStartDay', 'E_INVALID_INPUT');
    }
    if (!idOk(x.defaultAccountId, 'ac')) {
      addError(errors, 'defaultAccountId', 'E_ACCOUNT_MISSING');
    }
    if (!idOk(x.defaultExpenseCategoryId, 'ca')) {
      addError(errors, 'defaultExpenseCategoryId', 'E_CATEGORY_MISSING');
    }
    if (!idOk(x.defaultIncomeCategoryId, 'ca')) {
      addError(errors, 'defaultIncomeCategoryId', 'E_CATEGORY_MISSING');
    }
    if (!Number.isInteger(x.budgetAlertPct) || x.budgetAlertPct < LIMITS.thresholdMin ||
      x.budgetAlertPct > LIMITS.thresholdMax) {
      addError(errors, 'budgetAlertPct', 'E_INVALID_INPUT');
    }
    if (typeof x.recurringAutoPost !== 'boolean') { addError(errors, 'recurringAutoPost', 'E_INVALID_INPUT'); }
    if (typeof x.snapshotAuto !== 'boolean') { addError(errors, 'snapshotAuto', 'E_INVALID_INPUT'); }
    if (typeof x.hideAmounts !== 'boolean') { addError(errors, 'hideAmounts', 'E_INVALID_INPUT'); }
    if (x.quickItems !== undefined && !Array.isArray(x.quickItems)) {
      addError(errors, 'quickItems', 'E_INVALID_INPUT');
    } else if (Array.isArray(x.quickItems)) {
      if (x.quickItems.length > LIMITS.quickItems) {
        addError(errors, 'quickItems', 'E_INVALID_INPUT');
      } else {
        for (var qi = 0; qi < x.quickItems.length; qi += 1) {
          var quickItem = x.quickItems[qi];
          if (!isObj(quickItem) || typeof quickItem.id !== 'string' || quickItem.id === '' ||
            !nameOk(quickItem.name, LIMITS.quickItemName) ||
            !Number.isInteger(quickItem.amountCents) || quickItem.amountCents <= 0 ||
            typeof quickItem.categoryId !== 'string' || quickItem.categoryId === '' ||
            typeof quickItem.accountId !== 'string' || quickItem.accountId === '') {
            addError(errors, 'quickItems[' + qi + ']', 'E_INVALID_INPUT');
            break;
          }
        }
      }
    }
    if (!dates.isValidIsoStr(x.createdAt)) { addError(errors, 'createdAt', 'E_INVALID_INPUT'); }
    if (!dates.isValidIsoStr(x.updatedAt)) { addError(errors, 'updatedAt', 'E_INVALID_INPUT'); }
    return result(errors);
  }

  function seedData(at) {
    at = at || dates.nowIso();
    var books = [
      createBook({
        id: 'bk_default',
        name: '日常',
        kind: 'daily',
        color: '#007AFF',
        icon: 'book',
        sort: 10,
        archived: false,
        note: ''
      }, at)
    ];

    var accounts = [
      createAccount({ id: 'ac_cash', name: '现金', type: 'cash', icon: 'wallet', color: '#34C759', openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 10, note: '' }, at),
      createAccount({ id: 'ac_wechat', name: '微信', type: 'wechat', icon: 'wechat', color: '#07C160', openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 20, note: '' }, at),
      createAccount({ id: 'ac_alipay', name: '支付宝', type: 'alipay', icon: 'alipay', color: '#1677FF', openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 30, note: '' }, at),
      createAccount({ id: 'ac_debit', name: '银行卡', type: 'debit', icon: 'card', color: '#007AFF', openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 40, note: '' }, at),
      createAccount({ id: 'ac_credit', name: '信用卡', type: 'credit', icon: 'credit', color: '#FF3B30', openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 50, note: '' }, at),
      createAccount({ id: 'ac_savings', name: '储蓄', type: 'savings', icon: 'piggy', color: '#FF9500', openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null, archived: false, sort: 60, note: '' }, at)
    ];

    var categories = [
      createCategory({ id: 'ca_food', kind: 'expense', name: '餐饮', icon: 'food', color: '#FF9500', sort: 10, hidden: false, system: true, aliases: ['吃饭', '午饭', '晚饭', '早饭', '外卖', '咖啡', '零食'] }, at),
      createCategory({ id: 'ca_transport', kind: 'expense', name: '交通', icon: 'bus', color: '#007AFF', sort: 20, hidden: false, system: true, aliases: ['打车', '地铁', '公交', '加油', '停车', '高铁'] }, at),
      createCategory({ id: 'ca_shopping', kind: 'expense', name: '购物', icon: 'bag', color: '#FF2D55', sort: 30, hidden: false, system: true, aliases: ['买', '购物', '衣服', '日用品', '网购'] }, at),
      createCategory({ id: 'ca_home', kind: 'expense', name: '居住', icon: 'home', color: '#8E8E93', sort: 40, hidden: false, system: true, aliases: ['房租', '水电', '物业', '燃气', '宽带'] }, at),
      createCategory({ id: 'ca_fun', kind: 'expense', name: '娱乐', icon: 'game', color: '#AF52DE', sort: 50, hidden: false, system: true, aliases: ['电影', '游戏', '演出', '会员', '旅游'] }, at),
      createCategory({ id: 'ca_health', kind: 'expense', name: '医疗', icon: 'health', color: '#FF3B30', sort: 60, hidden: false, system: true, aliases: ['看病', '买药', '体检', '牙医'] }, at),
      createCategory({ id: 'ca_study', kind: 'expense', name: '学习', icon: 'book', color: '#5856D6', sort: 70, hidden: false, system: true, aliases: ['书', '课程', '培训', '学费'] }, at),
      createCategory({ id: 'ca_comm', kind: 'expense', name: '通讯', icon: 'phone', color: '#34C759', sort: 80, hidden: false, system: true, aliases: ['话费', '流量', '手机费'] }, at),
      createCategory({ id: 'ca_social', kind: 'expense', name: '人情', icon: 'gift', color: '#FF9500', sort: 90, hidden: false, system: true, aliases: ['红包', '礼物', '随礼', '请客'] }, at),
      createCategory({ id: 'ca_other_expense', kind: 'expense', name: '其他', icon: 'ellipsis', color: '#8E8E93', sort: 100, hidden: false, system: true, aliases: ['其他', '杂项'] }, at),
      /* 2.5 扩充分类目录（2.2 已备好 36 个字形）：纯增量，老库经 ensureShape→mergeSeedById 补齐 */
      createCategory({ id: 'ca_daily', kind: 'expense', name: '日用', icon: 'daily', color: '#FF9500', sort: 110, hidden: false, system: true, aliases: ['日用品', '纸巾', '洗衣液', '超市', '洗手液'] }, at),
      createCategory({ id: 'ca_veggie', kind: 'expense', name: '蔬菜', icon: 'carrot', color: '#34C759', sort: 120, hidden: false, system: true, aliases: ['买菜', '菜市场', '青菜'] }, at),
      createCategory({ id: 'ca_fruit', kind: 'expense', name: '水果', icon: 'fruit', color: '#FF9500', sort: 130, hidden: false, system: true, aliases: ['买水果', '车厘子', '果切'] }, at),
      createCategory({ id: 'ca_snack', kind: 'expense', name: '零食', icon: 'snack', color: '#FF2D55', sort: 140, hidden: false, system: true, aliases: ['奶茶', '甜品', '蛋糕', '饼干', '薯片'] }, at),
      createCategory({ id: 'ca_sports', kind: 'expense', name: '运动', icon: 'sport', color: '#5856D6', sort: 150, hidden: false, system: true, aliases: ['健身', '游泳', '跑步', '瑜伽'] }, at),
      createCategory({ id: 'ca_clothes', kind: 'expense', name: '服饰', icon: 'shirt', color: '#007AFF', sort: 160, hidden: false, system: true, aliases: ['衣服', '买衣服', '鞋', '裤子', '帽子'] }, at),
      createCategory({ id: 'ca_beauty', kind: 'expense', name: '美容', icon: 'beauty', color: '#FF2D55', sort: 170, hidden: false, system: true, aliases: ['化妆品', '理发', '护肤', '美甲', '口红'] }, at),
      createCategory({ id: 'ca_household', kind: 'expense', name: '居家', icon: 'sofa', color: '#8E8E93', sort: 180, hidden: false, system: true, aliases: ['家具', '沙发', '床品', '窗帘'] }, at),
      createCategory({ id: 'ca_kids', kind: 'expense', name: '孩子', icon: 'baby', color: '#FF9500', sort: 190, hidden: false, system: true, aliases: ['奶粉', '玩具', '亲子', '儿童'] }, at),
      createCategory({ id: 'ca_elder', kind: 'expense', name: '长辈', icon: 'elder', color: '#5856D6', sort: 200, hidden: false, system: true, aliases: ['给爸妈', '给父母', '赡养费', '孝敬'] }, at),
      createCategory({ id: 'ca_socialize', kind: 'expense', name: '社交', icon: 'chat', color: '#34C759', sort: 210, hidden: false, system: true, aliases: ['聚会', '聚餐', 'ktv', '酒吧', '团建'] }, at),
      createCategory({ id: 'ca_travel', kind: 'expense', name: '旅行', icon: 'plane', color: '#007AFF', sort: 220, hidden: false, system: true, aliases: ['机票', '酒店', '签证', '度假', '门票'] }, at),
      createCategory({ id: 'ca_smoke', kind: 'expense', name: '烟酒', icon: 'glass', color: '#8E8E93', sort: 230, hidden: false, system: true, aliases: ['烟', '酒', '香烟', '白酒'] }, at),
      createCategory({ id: 'ca_digital', kind: 'expense', name: '数码', icon: 'plug', color: '#5856D6', sort: 240, hidden: false, system: true, aliases: ['手机', '电脑', '耳机', '充电器', '平板'] }, at),
      createCategory({ id: 'ca_auto', kind: 'expense', name: '汽车', icon: 'car', color: '#007AFF', sort: 250, hidden: false, system: true, aliases: ['加油', '保养', '洗车', '年检', '油费'] }, at),
      createCategory({ id: 'ca_pet', kind: 'expense', name: '宠物', icon: 'pet', color: '#FF9500', sort: 260, hidden: false, system: true, aliases: ['猫粮', '狗粮', '宠物', '猫砂'] }, at),
      createCategory({ id: 'ca_office', kind: 'expense', name: '办公', icon: 'briefcase', color: '#5856D6', sort: 270, hidden: false, system: true, aliases: ['办公用品', '打印', '文具'] }, at),
      createCategory({ id: 'ca_repair', kind: 'expense', name: '维修', icon: 'hammer', color: '#8E8E93', sort: 280, hidden: false, system: true, aliases: ['维修', '修车', '换锁'] }, at),
      createCategory({ id: 'ca_donate', kind: 'expense', name: '捐赠', icon: 'heart', color: '#FF3B30', sort: 290, hidden: false, system: true, aliases: ['捐款', '慈善', '捐赠'] }, at),
      createCategory({ id: 'ca_lottery', kind: 'expense', name: '彩票', icon: 'ticket', color: '#FF2D55', sort: 300, hidden: false, system: true, aliases: ['彩票', '刮刮乐', '双色球'] }, at),
      createCategory({ id: 'ca_game', kind: 'expense', name: '游戏', icon: 'gamepad', color: '#AF52DE', sort: 310, hidden: false, system: true, aliases: ['游戏充值', 'steam', '手游', '网游', '电玩'] }, at),
      createCategory({ id: 'ca_tools', kind: 'expense', name: '工具', icon: 'wrench', color: '#8E8E93', sort: 320, hidden: false, system: true, aliases: ['五金', '工具', '螺丝'] }, at),
      createCategory({ id: 'ca_appliance', kind: 'expense', name: '电器', icon: 'washer', color: '#007AFF', sort: 330, hidden: false, system: true, aliases: ['家电', '冰箱', '洗衣机', '空调'] }, at),
      createCategory({ id: 'ca_family', kind: 'expense', name: '亲友', icon: 'family', color: '#34C759', sort: 340, hidden: false, system: true, aliases: ['走亲戚', '亲戚', '看望'] }, at),
      createCategory({ id: 'ca_salary', kind: 'income', name: '工资', icon: 'salary', color: '#34C759', sort: 10, hidden: false, system: true, aliases: ['工资', '发薪', '月薪', '薪水'] }, at),
      createCategory({ id: 'ca_bonus', kind: 'income', name: '奖金', icon: 'bonus', color: '#FF9500', sort: 20, hidden: false, system: true, aliases: ['奖金', '年终奖', '提成'] }, at),
      createCategory({ id: 'ca_invest', kind: 'income', name: '理财', icon: 'invest', color: '#007AFF', sort: 30, hidden: false, system: true, aliases: ['利息', '基金', '股票', '分红'] }, at),
      createCategory({ id: 'ca_parttime', kind: 'income', name: '兼职', icon: 'parttime', color: '#5856D6', sort: 40, hidden: false, system: true, aliases: ['兼职', '外快', '稿费'] }, at),
      createCategory({ id: 'ca_redpacket', kind: 'income', name: '红包', icon: 'redpacket', color: '#FF2D55', sort: 50, hidden: false, system: true, aliases: ['红包', '收红包', '压岁钱'] }, at),
      createCategory({ id: 'ca_other_income', kind: 'income', name: '其他', icon: 'ellipsis', color: '#8E8E93', sort: 60, hidden: false, system: true, aliases: ['其他', '退款', '报销'] }, at)
    ];

    return { books: books, accounts: accounts, categories: categories };
  }

  function defaultBook(at) {
    return createBook({
      id: 'bk_default', name: '日常', kind: 'daily', color: '#007AFF',
      icon: 'book', sort: 10, archived: false, note: ''
    }, at);
  }

  function createDb(at) {
    at = at || dates.nowIso();
    var seeds = seedData(at);
    return {
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: at,
      updatedAt: at,
      books: seeds.books,
      accounts: seeds.accounts,
      categories: seeds.categories,
      transactions: [],
      budgets: [],
      categoryBudgets: [],
      recurring: [],
      goals: [],
      goalDeposits: [],
      settings: defaultSettings(at)
    };
  }

  function mergeSeedById(list, seeds) {
    var existing = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      if (isObj(list[i]) && typeof list[i].id === 'string') { existing[list[i].id] = true; }
    }
    for (var j = 0; j < seeds.length; j++) {
      if (!existing[seeds[j].id]) { list.push(seeds[j]); }
    }
    return list;
  }

  /* 修复导入/旧库：补齐设置与种子、归一化实体、丢弃未知字段。不负责校验。 */
  function ensureShape(input) {
    var raw = isObj(input) ? input : {};
    var at = dates.nowIso();
    var seeds = seedData(at);
    var db = {
      schemaVersion: SCHEMA_VERSION,
      appVersion: str(raw.appVersion, APP_VERSION) || APP_VERSION,
      createdAt: dates.isValidIsoStr(raw.createdAt) ? raw.createdAt : at,
      updatedAt: dates.isValidIsoStr(raw.updatedAt) ? raw.updatedAt : at,
      books: toArray(raw.books).map(function (book) { return normalizeBook(book, at); }),
      accounts: toArray(raw.accounts).map(function (account) { return normalizeAccount(account, at); }),
      categories: toArray(raw.categories).map(function (category) { return normalizeCategory(category, at); }),
      transactions: toArray(raw.transactions).map(function (tx) { return normalizeTransaction(tx, at); }),
      budgets: toArray(raw.budgets).map(function (budget) { return normalizeBudget(budget, at); }),
      categoryBudgets: toArray(raw.categoryBudgets).map(function (budget) { return normalizeCategoryBudget(budget, at); }),
      recurring: toArray(raw.recurring).map(function (rule) { return normalizeRecurring(rule, at); }),
      goals: toArray(raw.goals).map(function (goal) { return normalizeGoal(goal, at); }),
      goalDeposits: toArray(raw.goalDeposits).map(function (deposit) { return normalizeGoalDeposit(deposit, at); }),
      settings: normalizeSettings(raw.settings, at)
    };

    if (db.books.length === 0) { db.books.push(defaultBook(at)); }
    mergeSeedById(db.books, seeds.books);
    mergeSeedById(db.accounts, seeds.accounts);
    mergeSeedById(db.categories, seeds.categories);
    return db;
  }

  function dbFailure(path) {
    return {
      ok: false,
      code: 'E_SCHEMA_INVALID',
      message: '数据校验失败，未保存',
      path: path
    };
  }

  function entityFailure(table, index, validation) {
    var field = validation.errors.length > 0 ? validation.errors[0].field : '';
    return dbFailure(table + '[' + index + ']' + (field ? '.' + field : ''));
  }

  /* 契约 §2.14：整库引用完整性 + 唯一性。返回第一个错误。 */
  function validateDb(db, opts) {
    if (!isObj(db)) { return dbFailure('db'); }
    var options = isObj(opts) ? opts : {};
    if (db.schemaVersion !== SCHEMA_VERSION) { return dbFailure('schemaVersion'); }
    if (typeof db.appVersion !== 'string' || db.appVersion === '') { return dbFailure('appVersion'); }
    if (!dates.isValidIsoStr(db.createdAt)) { return dbFailure('createdAt'); }
    if (!dates.isValidIsoStr(db.updatedAt)) { return dbFailure('updatedAt'); }

    var tables = ['books', 'accounts', 'categories', 'transactions', 'budgets',
      'categoryBudgets', 'recurring', 'goals', 'goalDeposits'];
    for (var t = 0; t < tables.length; t++) {
      if (!Array.isArray(db[tables[t]])) { return dbFailure(tables[t]); }
    }
    if (db.books.length === 0) { return dbFailure('books'); }
    if (db.accounts.length === 0) { return dbFailure('accounts'); }

    var seenIds = Object.create(null);
    for (var a = 0; a < tables.length; a++) {
      var list = db[tables[a]];
      for (var b = 0; b < list.length; b++) {
        var entity = list[b];
        if (!isObj(entity) || typeof entity.id !== 'string' || entity.id === '') {
          return dbFailure(tables[a] + '[' + b + '].id');
        }
        if (seenIds[entity.id]) {
          return dbFailure(tables[a] + '[' + b + '].id');
        }
        seenIds[entity.id] = true;
      }
    }

    var i;
    for (i = 0; i < db.books.length; i++) {
      var vb = validateBook(db.books[i]);
      if (!vb.ok) { return entityFailure('books', i, vb); }
    }
    for (i = 0; i < db.accounts.length; i++) {
      var va = validateAccount(db.accounts[i]);
      if (!va.ok) { return entityFailure('accounts', i, va); }
    }
    for (i = 0; i < db.categories.length; i++) {
      var vc = validateCategory(db.categories[i], { categories: db.categories });
      if (!vc.ok) { return entityFailure('categories', i, vc); }
    }

    var txCtx = {
      books: db.books,
      accounts: db.accounts,
      categories: db.categories,
      allowArchived: true,
      today: options.today
    };
    for (i = 0; i < db.transactions.length; i++) {
      var vt = validateTransaction(db.transactions[i], txCtx);
      if (!vt.ok) { return entityFailure('transactions', i, vt); }
    }
    for (i = 0; i < db.budgets.length; i++) {
      var vbg = validateBudget(db.budgets[i]);
      if (!vbg.ok) { return entityFailure('budgets', i, vbg); }
      for (var j = 0; j < i; j++) {
        if (db.budgets[j].bookId === db.budgets[i].bookId &&
          db.budgets[j].month === db.budgets[i].month) {
          return dbFailure('budgets[' + i + '].month');
        }
      }
    }
    for (i = 0; i < db.categoryBudgets.length; i++) {
      var vcb = validateCategoryBudget(db.categoryBudgets[i], { categories: db.categories });
      if (!vcb.ok) { return entityFailure('categoryBudgets', i, vcb); }
      if (!findById(db.books, db.categoryBudgets[i].bookId)) {
        return dbFailure('categoryBudgets[' + i + '].bookId');
      }
      for (var k = 0; k < i; k++) {
        if (db.categoryBudgets[k].bookId === db.categoryBudgets[i].bookId &&
          db.categoryBudgets[k].month === db.categoryBudgets[i].month &&
          db.categoryBudgets[k].categoryId === db.categoryBudgets[i].categoryId) {
          return dbFailure('categoryBudgets[' + i + '].categoryId');
        }
      }
    }
    var ruleCtx = {
      books: db.books,
      accounts: db.accounts,
      categories: db.categories,
      allowArchived: true
    };
    for (i = 0; i < db.recurring.length; i++) {
      var vrc = validateRecurring(db.recurring[i], ruleCtx);
      if (!vrc.ok) { return entityFailure('recurring', i, vrc); }
    }
    for (i = 0; i < db.goals.length; i++) {
      var vgl = validateGoal(db.goals[i]);
      if (!vgl.ok) { return entityFailure('goals', i, vgl); }
      if (!findById(db.books, db.goals[i].bookId)) {
        return dbFailure('goals[' + i + '].bookId');
      }
      if (db.goals[i].accountId !== null && !findById(db.accounts, db.goals[i].accountId)) {
        return dbFailure('goals[' + i + '].accountId');
      }
    }
    for (i = 0; i < db.goalDeposits.length; i++) {
      var vgd = validateGoalDeposit(db.goalDeposits[i], { goals: db.goals });
      if (!vgd.ok) { return entityFailure('goalDeposits', i, vgd); }
    }

    var vs = validateSettings(db.settings);
    if (!vs.ok) { return entityFailure('settings', 0, vs); }

    /* 设置默认引用必须存在；默认账户按契约还要求未归档 */
    var defaultAccount = findById(db.accounts, db.settings.defaultAccountId);
    if (!defaultAccount || defaultAccount.archived === true) {
      return dbFailure('settings.defaultAccountId');
    }
    var defaultExpense = findById(db.categories, db.settings.defaultExpenseCategoryId);
    if (!defaultExpense || defaultExpense.kind !== 'expense') {
      return dbFailure('settings.defaultExpenseCategoryId');
    }
    var defaultIncome = findById(db.categories, db.settings.defaultIncomeCategoryId);
    if (!defaultIncome || defaultIncome.kind !== 'income') {
      return dbFailure('settings.defaultIncomeCategoryId');
    }

    /* 预算外键（分类预算、目标的外键已在各自循环内校验） */
    for (i = 0; i < db.budgets.length; i++) {
      if (!findById(db.books, db.budgets[i].bookId)) {
        return dbFailure('budgets[' + i + '].bookId');
      }
    }
    return { ok: true };
  }

  /* 删除分类：系统分类只隐藏；自定义分类硬删并迁移历史交易。
   * 返回 {ok:true, db, hidden:boolean, remapped:number}；分类不存在返回 E_CATEGORY_MISSING。
   * 备注：同时清掉该分类的分类预算、把周期规则改到同类兜底分类，
   * 避免硬删后整库校验留下悬空引用（这是对 §2.14 的必要补全，已写入汇报）。
   */
  function applyCategoryDelete(db, categoryId) {
    if (!isObj(db) || !Array.isArray(db.categories)) {
      return { ok: false, code: 'E_CATEGORY_MISSING' };
    }
    var category = findById(db.categories, categoryId);
    if (!category) { return { ok: false, code: 'E_CATEGORY_MISSING' }; }

    var now = dates.nowIso();
    var next = {};
    for (var key in db) {
      if (Object.prototype.hasOwnProperty.call(db, key)) { next[key] = db[key]; }
    }
    next.updatedAt = now;

    if (category.system === true) {
      next.categories = db.categories.map(function (item) {
        if (item.id !== categoryId) { return item; }
        var copy = {};
        for (var k in item) { if (Object.prototype.hasOwnProperty.call(item, k)) { copy[k] = item[k]; } }
        copy.hidden = true;
        copy.updatedAt = now;
        return copy;
      });
      return { ok: true, db: next, hidden: true, remapped: 0 };
    }

    var fallbackId = category.kind === 'income' ? 'ca_other_income' : 'ca_other_expense';
    var fallback = findById(db.categories, fallbackId);
    if (!fallback) { return { ok: false, code: 'E_CATEGORY_MISSING' }; }

    var remapped = 0;
    next.transactions = db.transactions.map(function (tx) {
      if (!isObj(tx) || tx.categoryId !== categoryId) { return tx; }
      remapped++;
      var copy = {};
      for (var k in tx) { if (Object.prototype.hasOwnProperty.call(tx, k)) { copy[k] = tx[k]; } }
      copy.categoryId = fallbackId;
      copy.updatedAt = now;
      return copy;
    });
    next.recurring = db.recurring.map(function (rule) {
      if (!isObj(rule) || rule.categoryId !== categoryId) { return rule; }
      var copy = {};
      for (var k in rule) { if (Object.prototype.hasOwnProperty.call(rule, k)) { copy[k] = rule[k]; } }
      copy.categoryId = fallbackId;
      copy.updatedAt = now;
      return copy;
    });
    next.categoryBudgets = db.categoryBudgets.filter(function (budget) {
      return !isObj(budget) || budget.categoryId !== categoryId;
    });
    next.categories = db.categories.filter(function (item) {
      return !isObj(item) || item.id !== categoryId;
    });
    return { ok: true, db: next, hidden: false, remapped: remapped };
  }

  /* ---------- 类型分发（给 store / backup 用，不是契约必需） ---------- */
  var NORMALIZERS = {
    book: normalizeBook,
    account: normalizeAccount,
    category: normalizeCategory,
    transaction: normalizeTransaction,
    budget: normalizeBudget,
    categorybudget: normalizeCategoryBudget,
    recurring: normalizeRecurring,
    goal: normalizeGoal,
    goaldeposit: normalizeGoalDeposit
  };

  var ALIASES = {
    books: 'book',
    accounts: 'account',
    categories: 'category',
    transactions: 'transaction',
    tx: 'transaction',
    budgets: 'budget',
    categorybudgets: 'categorybudget',
    recurrings: 'recurring',
    rules: 'recurring',
    goals: 'goal',
    goaldeposits: 'goaldeposit',
    deposits: 'goaldeposit'
  };

  var VALIDATORS = {
    book: validateBook,
    account: validateAccount,
    category: validateCategory,
    transaction: validateTransaction,
    transfer: validateTransfer,
    budget: validateBudget,
    categorybudget: validateCategoryBudget,
    recurring: validateRecurring,
    goal: validateGoal,
    goaldeposit: validateGoalDeposit
  };

  function kindKey(kind) {
    if (typeof kind !== 'string') { return ''; }
    /* 契约里的 kind 是 camelCase（categoryBudget / goalDeposit），
     * 这里不能一律小写化，否则这两个 kind 永远查不到。先精确、再小写、最后大小写无关兜底。 */
    if (ALIASES[kind]) { return ALIASES[kind]; }
    if (Object.prototype.hasOwnProperty.call(NORMALIZERS, kind)) { return kind; }
    var lower = kind.toLowerCase();
    if (ALIASES[lower]) { return ALIASES[lower]; }
    if (Object.prototype.hasOwnProperty.call(NORMALIZERS, lower)) { return lower; }
    for (var key in NORMALIZERS) {
      if (Object.prototype.hasOwnProperty.call(NORMALIZERS, key) && key.toLowerCase() === lower) {
        return key;
      }
    }
    return lower;
  }

  function normalize(kind, input, now, opts) {
    var key = kindKey(kind);
    var fn = NORMALIZERS[key];
    if (!fn) { return null; }
    return fn(input, now, opts && opts.autoPost);
  }

  function validate(kind, input, ctx) {
    var key = kindKey(kind);
    var fn = VALIDATORS[key];
    if (!fn) {
      return { ok: false, errors: [{ field: 'kind', code: 'E_INVALID_INPUT' }] };
    }
    return fn(input, ctx);
  }

  var api = Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    APP_VERSION: APP_VERSION,
    LIMITS: LIMITS,
    REIMBURSE_STATES: REIMBURSE_STATES,
    ID_PREFIXES: ID_PREFIXES,
    ACCOUNT_TYPE_META: ACCOUNT_TYPE_META,
    newId: newId,

    createBook: createBook,
    createAccount: createAccount,
    createCategory: createCategory,
    createTransaction: createTransaction,
    createBudget: createBudget,
    createCategoryBudget: createCategoryBudget,
    createRecurring: createRecurring,
    createGoal: createGoal,
    createGoalDeposit: createGoalDeposit,

    normalizeBook: normalizeBook,
    normalizeAccount: normalizeAccount,
    normalizeCategory: normalizeCategory,
    normalizeTransaction: normalizeTransaction,
    normalizeBudget: normalizeBudget,
    normalizeCategoryBudget: normalizeCategoryBudget,
    normalizeRecurring: normalizeRecurring,
    normalizeGoal: normalizeGoal,
    normalizeGoalDeposit: normalizeGoalDeposit,

    validateBook: validateBook,
    validateAccount: validateAccount,
    validateCategory: validateCategory,
    validateTransaction: validateTransaction,
    validateTransfer: validateTransfer,
    validateBudget: validateBudget,
    validateCategoryBudget: validateCategoryBudget,
    validateRecurring: validateRecurring,
    validateGoal: validateGoal,
    validateGoalDeposit: validateGoalDeposit,
    validateSettings: validateSettings,
    validateDb: validateDb,

    ensureShape: ensureShape,
    applyCategoryDelete: applyCategoryDelete,

    seedData: seedData,
    defaultSettings: defaultSettings,
    defaultBook: defaultBook,
    createDb: createDb,
    defaults: createDb,

    normalize: normalize,
    validate: validate,
    kindKey: kindKey,
    findById: findById
  });

  Core.schema = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.schema = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
