/* 小账本 2.0 · js/core/migrate.js · owner: dba（T02）
 * 职责：
 *   1) v1 → 2.0 迁移（CONTRACT §13 / 边界表 B16）
 *   2) 2.0 JSON 备份的合并 / 整体替换（配合 CONTRACT §3.8）
 *   3) 库内版本升级（store.load 发现 schemaVersion<2 时调用）
 * 契约锚点：CONTRACT.md §3.3（load 的迁移分支）、§3.8（导入语义）、§13（v1 映射）
 * 铁律：
 *   - 零网络；不写任何 localStorage 键（§3.9）；只「读」v1 的 xiaozhangben.v1，绝不删改；
 *   - 迁移幂等：靠交易的 importRef('v1:'+旧id) 去重，重复执行只增加 skipped；
 *   - 失败不落库：本模块只返回新 Db，真正写入由 store.transaction 一次性完成；
 *   - 迁移进度标记只放内存（v1PendingMarker），全部成功才由调用方提交，崩溃后重跑即可。
 * 挂载：XZB.Core.migrate（同时 XZB.core.migrate），Node 下 module.exports 双挂载。
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
    throw new Error('migrate.js 依赖 dates.js / schema.js，请按 core 加载顺序引入');
  }

  var V1_KEY = 'xiaozhangben.v1';
  var APP_NAME = '小账本';
  var SCHEMA_VERSION = 3;

  /* §13 账户映射表：v1 的 account 字段只有四个标签 */
  var V1_ACCOUNT_MAP = {
    cash: { id: 'ac_cash', type: 'cash', name: '现金' },
    wechat: { id: 'ac_wechat', type: 'wechat', name: '微信' },
    alipay: { id: 'ac_alipay', type: 'alipay', name: '支付宝' },
    bank: { id: 'ac_debit', type: 'debit', name: '银行卡' }
  };
  var V1_ACCOUNT_FALLBACK = V1_ACCOUNT_MAP.cash;

  /* v1 内置分类 id → 2.0 种子分类 id（同为 ca_ 前缀；额外保留此表便于名称匹配） */
  var V1_CATEGORY_PREFIX = 'ca_';

  /* 内存中的迁移标记（不写任何持久化位置，遵守 §3.9；重入安全性由 importRef 保证） */
  var v1PendingMarker = null;

  function fail(code, path, message) {
    var MESSAGES = (Core.store && Core.store.MESSAGES) || {};
    return {
      ok: false,
      code: code,
      message: message || MESSAGES[code] || '操作失败，请重试',
      path: path
    };
  }

  function clone(value) {
    if (value === null || value === undefined) { return value; }
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function emptyReport(mode, sourceVersion) {
    return {
      mode: mode,
      sourceVersion: sourceVersion,
      books: 0,
      accounts: 0,
      categories: 0,
      transactions: 0,
      budgets: 0,
      categoryBudgets: 0,
      recurring: 0,
      goals: 0,
      goalDeposits: 0,
      skipped: 0,
      remapped: 0,
      warnings: []
    };
  }

  function warn(report, text) {
    if (report.warnings.indexOf(text) < 0) { report.warnings.push(text); }
  }

  /* 时间工具：v1 用毫秒时间戳，2.0 用本地 IsoStr */
  function isoFromEpoch(value, fallbackIso) {
    var ms = Number(value);
    if (isFinite(ms) && ms > 0) {
      return dates.nowIso(ms);
    }
    return fallbackIso || dates.nowIso();
  }

  function todayStr() {
    return dates.todayStr();
  }

  function currentMonth() {
    return todayStr().slice(0, 7);
  }

  /* ============================== 读取 v1 ============================== */

  /* 只读访问 localStorage['xiaozhangben.v1']；读取失败一律当没有，绝不抛错 */
  function readV1Raw() {
    try {
      var storage = global.localStorage;
      if (!storage || typeof storage.getItem !== 'function') { return null; }
      var text = storage.getItem(V1_KEY);
      if (!text) { return null; }
      var parsed = JSON.parse(text);
      return isObject(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  /* 不传参时自己读 localStorage，方便 app.js 启动时一句判断 */
  function hasV1Data(raw) {
    var input = (raw === undefined || raw === null) ? readV1Raw() : raw;
    if (!isObject(input)) { return false; }
    if (Array.isArray(input.transactions) && input.transactions.length > 0) { return true; }
    if (Number(input.budget) > 0) { return true; }
    return false;
  }

  /* ============================== 识别 ============================== */

  function detect(input) {
    if (Array.isArray(input)) { return 'v1'; }
    if (!isObject(input)) { return null; }
    if (input.kind === 'xzb-backup' && input.schemaVersion === SCHEMA_VERSION) { return 'v2'; }
    if (input.app === APP_NAME && Number(input.version) === 1) { return 'v1'; }
    if (Array.isArray(input.transactions) && !input.kind) { return 'v1'; }
    if (isObject(input.data) && Array.isArray(input.data.books)) { return 'v2'; }
    return null;
  }

  /* ============================== v1 分类 ============================== */

  /* 把 v1 的 categories 结构（{expense:[],income:[]} 或扁平数组）规整成 [{kind,item}] */
  function flattenV1Categories(input) {
    var out = [];
    var source = isObject(input && input.categories) ? input.categories : null;
    if (!source) { return out; }
    function pushList(list, kind) {
      if (!Array.isArray(list)) { return; }
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!isObject(item) || typeof item.name !== 'string' || item.name === '') { continue; }
        out.push({ kind: kind, item: item });
      }
    }
    if (Array.isArray(source)) {
      for (var i = 0; i < source.length; i++) {
        var flat = source[i];
        if (!isObject(flat)) { continue; }
        var kind = flat.type === 'income' || flat.kind === 'income' ? 'income' : 'expense';
        out.push({ kind: kind, item: flat });
      }
      return out;
    }
    pushList(source.expense, 'expense');
    pushList(source.income, 'income');
    return out;
  }

  function sanitizeIdPart(text) {
    var value = String(text === undefined || text === null ? '' : text)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '');
    return value;
  }

  /* 建一个「v1 分类 id / 名称 → 2.0 分类 id」的解析器 */
  function makeCategoryResolver(base, v1Categories, report) {
    var byId = Object.create(null);
    var byNameKind = Object.create(null);
    for (var i = 0; i < base.categories.length; i++) {
      var category = base.categories[i];
      byId[category.id] = category;
      byNameKind[category.kind + '|' + category.name] = category;
    }
    var v1Declared = Object.create(null);
    for (var j = 0; j < v1Categories.length; j++) {
      v1Declared[String(v1Categories[j].item.id)] = v1Categories[j];
    }
    var customCache = Object.create(null);
    var nextSort = 0;
    for (var k = 0; k < base.categories.length; k++) {
      var sortValue = Number(base.categories[k].sort);
      if (isFinite(sortValue) && sortValue > nextSort) { nextSort = sortValue; }
    }

    /* 生成 v1 自定义分类：ca_v1_<id>，保留名称/图标/颜色，排在系统分类之后 */
    function createCustom(v1Item, kind) {
      var rawId = sanitizeIdPart(v1Item.id) || sanitizeIdPart(v1Item.name) || 'custom';
      var wanted = (V1_CATEGORY_PREFIX + 'v1_' + rawId).slice(0, 24);
      if (byId[wanted]) { return byId[wanted]; }
      nextSort += 10;
      var created = schema.createCategory({
        id: wanted,
        kind: kind,
        name: String(v1Item.name).slice(0, 8),
        /* v1 存的是 emoji 图标，2.0 图标是全项目统一的 SVG 名；无法映射时用省略号占位 */
        icon: 'ellipsis',
        color: typeof v1Item.color === 'string' ? v1Item.color : '#8E8E93',
        sort: nextSort,
        hidden: false,
        system: false,
        aliases: []
      }, dates.nowIso());
      base.categories.push(created);
      byId[created.id] = created;
      byNameKind[created.kind + '|' + created.name] = created;
      return created;
    }

    /* 解析一条 v1 交易的分类；找不到就落「其他」并记 warning */
    return function resolve(v1CategoryId, kind) {
      var key = String(v1CategoryId === undefined || v1CategoryId === null ? '' : v1CategoryId);
      if (key === '') {
        return { id: kind === 'income' ? 'ca_other_income' : 'ca_other_expense', warned: true };
      }
      /* 1) 直接命中 2.0 id（含用户手工写的 ca_xxx） */
      if (byId[key]) {
        return { id: key, warned: byId[key].kind !== kind };
      }
      /* 2) v1 内置分类：food → ca_food */
      var prefixed = V1_CATEGORY_PREFIX + key;
      if (byId[prefixed]) {
        return { id: prefixed, warned: byId[prefixed].kind !== kind };
      }
      /* 3) v1 自定义分类：先按 id 找声明，再按名称匹配 */
      var declared = v1Declared[key];
      var displayName = declared ? String(declared.item.name) : key;
      var matched = byNameKind[kind + '|' + displayName];
      if (matched) {
        if (declared && declared.item.custom === true && matched.system !== false) {
          /* 同名但本地是系统分类：直接复用，不新建 */
          return { id: matched.id, warned: true };
        }
        return { id: matched.id, warned: false };
      }
      /* 4) 新自定义分类：只有 v1 明确声明为自定义或未知 id 才新建 */
      if (declared) {
        var created = createCustom(declared.item, kind);
        return { id: created.id, warned: false, created: true };
      }
      return { id: kind === 'income' ? 'ca_other_income' : 'ca_other_expense', warned: true };
    };
  }

  /* ============================== 账户补齐 ============================== */

  function ensureAccount(base, v1AccountId, report) {
    var mapped = V1_ACCOUNT_MAP[v1AccountId];
    if (!mapped) {
      warn(report, '第 ' + report._txIndex + ' 条账户无法识别，已归入「现金」');
      mapped = V1_ACCOUNT_FALLBACK;
    }
    for (var i = 0; i < base.accounts.length; i++) {
      if (base.accounts[i].id === mapped.id) { return mapped.id; }
    }
    base.accounts.push(schema.createAccount({
      id: mapped.id,
      name: mapped.name,
      type: mapped.type,
      openingBalanceCents: 0,
      limitCents: 0,
      billDay: null,
      dueDay: null,
      archived: false,
      sort: base.accounts.length * 10 + 10,
      note: ''
    }, dates.nowIso()));
    report.accounts += 1;
    return mapped.id;
  }

  /* ============================== v1 主体 ============================== */

  function normalizeV1Input(input) {
    if (Array.isArray(input)) { return { transactions: input }; }
    if (!isObject(input)) { return null; }
    var out = clone(input);
    out.transactions = Array.isArray(out.transactions) ? out.transactions : [];
    return out;
  }

  /* §13：v1 → 2.0。返回 {ok:true, db, report}，不落库、不改 input */
  function fromV1(input, opts) {
    var options = isObject(opts) ? opts : {};
    var mode = options.mode === 'replace' ? 'replace' : 'merge';
    var source = normalizeV1Input(input);
    if (!source) { return fail('E_IMPORT_INVALID', 'input'); }

    var at = dates.nowIso();
    var report = emptyReport(mode, 1);
    var base;
    var nowBookId;

    if (mode === 'replace') {
      /* replace：用种子库做底（含 ac_credit / ac_savings），不保留旧数据 */
      base = schema.createDb(at);
      nowBookId = 'bk_default';
      report.books = base.books.length;
      report.accounts = base.accounts.length;
    } else {
      var current = isObject(options.currentDb) ? options.currentDb : schema.createDb(at);
      base = clone(current);
      var wanted = options.targetBookId;
      var found = null;
      if (typeof wanted === 'string' && wanted !== '') {
        for (var b = 0; b < base.books.length; b++) {
          if (base.books[b].id === wanted && base.books[b].archived !== true) { found = base.books[b]; break; }
        }
        if (!found) { return fail('E_BOOK_MISSING', 'targetBookId'); }
      } else {
        for (var c = 0; c < base.books.length; c++) {
          if (base.books[c].archived !== true) { found = base.books[c]; break; }
        }
      }
      if (!found) { return fail('E_BOOK_MISSING', 'books'); }
      nowBookId = found.id;
    }

    var v1Categories = flattenV1Categories(source);
    var resolveCategory = makeCategoryResolver(base, v1Categories, report);

    /* 已存在的 importRef（幂等去重） */
    var seenRefs = Object.create(null);
    for (var t = 0; t < base.transactions.length; t++) {
      var existingRef = base.transactions[t] && base.transactions[t].importRef;
      if (typeof existingRef === 'string' && existingRef !== '') { seenRefs[existingRef] = true; }
    }

    var v1List = source.transactions;
    var invalidAmount = 0;
    var invalidDate = 0;
    for (var i = 0; i < v1List.length; i++) {
      report._txIndex = i + 1;
      var item = v1List[i];
      if (!isObject(item)) { report.skipped += 1; continue; }
      var amount = Math.round(Number(item.amount));
      if (!isFinite(amount) || amount <= 0) {
        report.skipped += 1;
        invalidAmount += 1;
        continue;
      }
      var type = item.type === 'income' ? 'income' : (item.type === 'transfer' ? 'transfer' : 'expense');
      var ref = 'v1:' + String(item.id === undefined || item.id === null ? '' : item.id);
      if (mode === 'merge' && seenRefs[ref]) { report.skipped += 1; continue; }
      seenRefs[ref] = true;

      var dateText = String(item.date === undefined || item.date === null ? '' : item.date);
      if (!dates.isValidDateStr(dateText)) {
        dateText = todayStr();
        invalidDate += 1;
      }
      var catResult = resolveCategory(item.category, type === 'income' ? 'income' : 'expense');
      if (catResult.warned) {
        warn(report, 'v1 分类「' + String(item.category || '') + '」无法匹配，已归入同类「其他」');
      }
      if (catResult.created) { report.categories += 1; }
      var accountId = ensureAccount(base, String(item.account || ''), report);

      var createdAt = isoFromEpoch(item.createdAt, at);
      var updatedAt = isoFromEpoch(item.updatedAt || item.createdAt, createdAt);
      var tx = schema.createTransaction({
        bookId: nowBookId,
        type: type,
        amountCents: amount,
        accountId: accountId,
        toAccountId: null,
        categoryId: type === 'transfer' ? null : catResult.id,
        date: dateText,
        time: '12:00',
        note: String(item.note === undefined || item.note === null ? '' : item.note).slice(0, 80),
        tags: [],
        source: 'import',
        recurringId: null,
        periodKey: null,
        importRef: ref,
        deleted: false,
        deletedAt: null,
        createdAt: createdAt,
        updatedAt: updatedAt
      }, createdAt);
      base.transactions.push(tx);
      report.transactions += 1;
    }
    if (invalidAmount > 0) { warn(report, invalidAmount + ' 条金额无效，已跳过'); }
    if (invalidDate > 0) { warn(report, invalidDate + ' 条日期无效，已改用今天'); }
    delete report._txIndex;

    /* v1 单值月预算 → 当前月预算（§13） */
    var v1Budget = Math.round(Number(source.budget));
    if (isFinite(v1Budget) && v1Budget > 0) {
      var month = currentMonth();
      var exists = false;
      for (var p = 0; p < base.budgets.length; p++) {
        if (base.budgets[p].bookId === nowBookId && base.budgets[p].month === month) { exists = true; break; }
      }
      if (exists) {
        warn(report, '当前月已有预算，v1 预算未导入');
      } else {
        base.budgets.push(schema.createBudget({
          bookId: nowBookId,
          month: month,
          totalCents: v1Budget
        }, at));
        report.budgets += 1;
        warn(report, 'v1 预算已归入当前月（' + month + '）');
      }
    }

    var db;
    if (mode === 'replace') {
      db = schema.ensureShape(base);
      db.schemaVersion = SCHEMA_VERSION;
      db.appVersion = XZB.version;
      report.books = db.books.length;
      report.accounts = db.accounts.length;
      report.categories = db.categories.length;
    } else {
      db = base;
      db.schemaVersion = SCHEMA_VERSION;
      db.appVersion = XZB.version;
      db.updatedAt = at;
      /* merge 只统计新增，不改已有 */
      report.books = 0;
      report.accounts = report.accounts;
    }
    if (mode === 'merge') {
      /* 新增分类/账户数已在循环中累加；books 不新增 */
      report.transactions = report.transactions;
    }
    return { ok: true, db: db, report: report, sourceVersion: 1 };
  }

  /* ============================== v2 合并 / 替换 ============================== */

  function collectImportRefs(db) {
    var refs = Object.create(null);
    for (var i = 0; i < db.transactions.length; i++) {
      var ref = db.transactions[i] && db.transactions[i].importRef;
      if (typeof ref === 'string' && ref !== '') { refs[ref] = true; }
    }
    return refs;
  }

  function importV2(input, opts) {
    var options = isObject(opts) ? opts : {};
    var mode = options.mode === 'replace' ? 'replace' : 'merge';
    var payload = isObject(input && input.data) ? input.data : input;
    if (!isObject(payload)) { return fail('E_IMPORT_INVALID', 'data'); }

    var report = emptyReport(mode, 2);
    var at = dates.nowIso();

    if (mode === 'replace') {
      /* replace：整体替换；缺省设置/种子用 ensureShape 补齐（§3.8） */
      var replaced = schema.ensureShape(payload);
      replaced.schemaVersion = SCHEMA_VERSION;
      replaced.appVersion = XZB.version;
      var checkReplace = schema.validateDb(replaced);
      if (!checkReplace.ok) {
        return fail(checkReplace.code || 'E_IMPORT_FAILED', checkReplace.path);
      }
      report.books = replaced.books.length;
      report.accounts = replaced.accounts.length;
      report.categories = replaced.categories.length;
      report.transactions = replaced.transactions.length;
      report.budgets = replaced.budgets.length;
      report.categoryBudgets = replaced.categoryBudgets.length;
      report.recurring = replaced.recurring.length;
      report.goals = replaced.goals.length;
      report.goalDeposits = replaced.goalDeposits.length;
      return { ok: true, db: replaced, report: report, sourceVersion: 2 };
    }

    var current = isObject(options.currentDb) ? options.currentDb : schema.createDb(at);
    var db = clone(current);

    /* ---- 账本：按 id 匹配，已存在跳过 ---- */
    var bookIdMap = Object.create(null);
    var bookById = Object.create(null);
    for (var b = 0; b < db.books.length; b++) { bookById[db.books[b].id] = db.books[b]; }
    var incomingBooks = Array.isArray(payload.books) ? payload.books : [];
    for (var i = 0; i < incomingBooks.length; i++) {
      var incomingBook = incomingBooks[i];
      if (!isObject(incomingBook) || typeof incomingBook.id !== 'string') { continue; }
      if (bookById[incomingBook.id]) {
        bookIdMap[incomingBook.id] = incomingBook.id;
        continue;
      }
      var bookCopy = clone(incomingBook);
      db.books.push(schema.normalizeBook(bookCopy, at));
      bookById[bookCopy.id] = bookCopy;
      report.books += 1;
    }
    /* 未映射的 bookId 一律落到本地第一个未归档账本，保证引用完整 */
    var fallbackBookId = null;
    for (var fb = 0; fb < db.books.length; fb++) {
      if (db.books[fb].archived !== true) { fallbackBookId = db.books[fb].id; break; }
    }

    /* ---- 账户：先 id，再 type+name；命中但 id 不同 ⇒ 复用本地 id ---- */
    var accountIdMap = Object.create(null);
    var accountById = Object.create(null);
    var accountByTypeName = Object.create(null);
    for (var a = 0; a < db.accounts.length; a++) {
      var localAccount = db.accounts[a];
      accountById[localAccount.id] = localAccount;
      accountByTypeName[localAccount.type + '|' + localAccount.name] = localAccount;
    }
    var incomingAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    for (var j = 0; j < incomingAccounts.length; j++) {
      var incomingAccount = incomingAccounts[j];
      if (!isObject(incomingAccount)) { continue; }
      if (typeof incomingAccount.id === 'string' && accountById[incomingAccount.id]) {
        accountIdMap[incomingAccount.id] = incomingAccount.id;
        continue;
      }
      var typeNameKey = incomingAccount.type + '|' + incomingAccount.name;
      var sameAccount = accountByTypeName[typeNameKey];
      if (sameAccount) {
        accountIdMap[incomingAccount.id] = sameAccount.id;
        report.remapped += 1;
        continue;
      }
      var accountCopy = clone(incomingAccount);
      db.accounts.push(schema.normalizeAccount(accountCopy, at));
      accountById[accountCopy.id] = accountCopy;
      accountByTypeName[accountCopy.type + '|' + accountCopy.name] = accountCopy;
      report.accounts += 1;
    }

    /* ---- 分类：先 id，再 kind+name；未匹配且 system:false 的新增 ---- */
    var categoryIdMap = Object.create(null);
    var categoryById = Object.create(null);
    var categoryByKindName = Object.create(null);
    for (var k = 0; k < db.categories.length; k++) {
      var localCategory = db.categories[k];
      categoryById[localCategory.id] = localCategory;
      categoryByKindName[localCategory.kind + '|' + localCategory.name] = localCategory;
    }
    var incomingCategories = Array.isArray(payload.categories) ? payload.categories : [];
    for (var m = 0; m < incomingCategories.length; m++) {
      var incomingCategory = incomingCategories[m];
      if (!isObject(incomingCategory)) { continue; }
      if (typeof incomingCategory.id === 'string' && categoryById[incomingCategory.id]) {
        categoryIdMap[incomingCategory.id] = incomingCategory.id;
        continue;
      }
      var categoryKey = incomingCategory.kind + '|' + incomingCategory.name;
      var sameCategory = categoryByKindName[categoryKey];
      if (sameCategory) {
        categoryIdMap[incomingCategory.id] = sameCategory.id;
        continue;
      }
      if (incomingCategory.system === true) { continue; }
      var categoryCopy = clone(incomingCategory);
      db.categories.push(schema.normalizeCategory(categoryCopy, at));
      categoryById[categoryCopy.id] = categoryCopy;
      categoryByKindName[categoryCopy.kind + '|' + categoryCopy.name] = categoryCopy;
      report.categories += 1;
    }

    /* ---- 交易：id 或 importRef 已存在 ⇒ 跳过；id 冲突 ⇒ 重新生成 ---- */
    var usedRefs = collectImportRefs(db);
    var usedTxIds = Object.create(null);
    for (var n = 0; n < db.transactions.length; n++) { usedTxIds[db.transactions[n].id] = true; }
    var incomingTxs = Array.isArray(payload.transactions) ? payload.transactions : [];
    for (var q = 0; q < incomingTxs.length; q++) {
      var incomingTx = incomingTxs[q];
      if (!isObject(incomingTx)) { report.skipped += 1; continue; }
      if (typeof incomingTx.id === 'string' && usedTxIds[incomingTx.id]) {
        report.skipped += 1;
        continue;
      }
      if (typeof incomingTx.importRef === 'string' && incomingTx.importRef !== '' &&
        usedRefs[incomingTx.importRef]) {
        report.skipped += 1;
        continue;
      }
      var txCopy = clone(incomingTx);
      txCopy.bookId = bookIdMap[txCopy.bookId] || fallbackBookId;
      txCopy.accountId = accountIdMap[txCopy.accountId] || txCopy.accountId;
      if (txCopy.toAccountId) {
        txCopy.toAccountId = accountIdMap[txCopy.toAccountId] || txCopy.toAccountId;
      }
      if (txCopy.categoryId && categoryIdMap[txCopy.categoryId]) {
        txCopy.categoryId = categoryIdMap[txCopy.categoryId];
      }
      var normalizedTx = schema.normalizeTransaction(txCopy, at);
      if (!normalizedTx.id || usedTxIds[normalizedTx.id]) {
        normalizedTx.id = schema.newId('tx');
        if (!normalizedTx.id) { return fail('E_SCHEMA_ID', 'transactions[' + q + '].id'); }
        report.remapped += 1;
      }
      var txCheck = schema.validateTransaction(normalizedTx, {
        books: db.books, accounts: db.accounts, categories: db.categories
      });
      if (!txCheck.ok) {
        var field = txCheck.errors && txCheck.errors.length ? txCheck.errors[0].field : '';
        return fail('E_IMPORT_FAILED', 'transactions[' + q + ']' + (field ? '.' + field : ''));
      }
      usedTxIds[normalizedTx.id] = true;
      if (normalizedTx.importRef) { usedRefs[normalizedTx.importRef] = true; }
      db.transactions.push(normalizedTx);
      report.transactions += 1;
    }

    /* ---- 预算：bookId + month 匹配，已存在跳过 ---- */
    var incomingBudgets = Array.isArray(payload.budgets) ? payload.budgets : [];
    for (var u = 0; u < incomingBudgets.length; u++) {
      var incomingBudget = incomingBudgets[u];
      if (!isObject(incomingBudget)) { continue; }
      var budgetBook = bookIdMap[incomingBudget.bookId] || incomingBudget.bookId;
      var existsBudget = false;
      for (var vb = 0; vb < db.budgets.length; vb++) {
        if (db.budgets[vb].bookId === budgetBook && db.budgets[vb].month === incomingBudget.month) {
          existsBudget = true;
          break;
        }
      }
      if (existsBudget) { continue; }
      var budgetCopy = clone(incomingBudget);
      budgetCopy.bookId = budgetBook;
      db.budgets.push(schema.normalizeBudget(budgetCopy, at));
      report.budgets += 1;
    }

    /* ---- 分类预算：未被替换的分类预算按 bookId+month+categoryId 去重后追加 ---- */
    var incomingCategoryBudgets = Array.isArray(payload.categoryBudgets) ? payload.categoryBudgets : [];
    for (var cb = 0; cb < incomingCategoryBudgets.length; cb++) {
      var incomingCb = incomingCategoryBudgets[cb];
      if (!isObject(incomingCb)) { continue; }
      var cbBook = bookIdMap[incomingCb.bookId] || incomingCb.bookId;
      var cbCategory = categoryIdMap[incomingCb.categoryId] || incomingCb.categoryId;
      var dup = false;
      for (var vc = 0; vc < db.categoryBudgets.length; vc++) {
        var localCb = db.categoryBudgets[vc];
        if (localCb.bookId === cbBook && localCb.month === incomingCb.month &&
          localCb.categoryId === cbCategory) {
          dup = true;
          break;
        }
      }
      if (dup) { continue; }
      var cbCopy = clone(incomingCb);
      cbCopy.bookId = cbBook;
      cbCopy.categoryId = cbCategory;
      db.categoryBudgets.push(schema.normalizeCategoryBudget(cbCopy, at));
      report.categoryBudgets += 1;
    }

    /* ---- 定期账单 / 目标 / 存入：按 id 匹配，已存在跳过 ---- */
    var recurringIds = Object.create(null);
    for (var r = 0; r < db.recurring.length; r++) { recurringIds[db.recurring[r].id] = true; }
    var incomingRecurring = Array.isArray(payload.recurring) ? payload.recurring : [];
    for (var s = 0; s < incomingRecurring.length; s++) {
      var rule = incomingRecurring[s];
      if (!isObject(rule) || recurringIds[rule.id]) { continue; }
      var ruleCopy = clone(rule);
      ruleCopy.bookId = bookIdMap[ruleCopy.bookId] || fallbackBookId;
      ruleCopy.accountId = accountIdMap[ruleCopy.accountId] || ruleCopy.accountId;
      if (ruleCopy.toAccountId) {
        ruleCopy.toAccountId = accountIdMap[ruleCopy.toAccountId] || ruleCopy.toAccountId;
      }
      if (ruleCopy.categoryId && categoryIdMap[ruleCopy.categoryId]) {
        ruleCopy.categoryId = categoryIdMap[ruleCopy.categoryId];
      }
      db.recurring.push(schema.normalizeRecurring(ruleCopy, at));
      recurringIds[ruleCopy.id] = true;
      report.recurring += 1;
    }

    var goalIds = Object.create(null);
    for (var g = 0; g < db.goals.length; g++) { goalIds[db.goals[g].id] = true; }
    var incomingGoals = Array.isArray(payload.goals) ? payload.goals : [];
    for (var h = 0; h < incomingGoals.length; h++) {
      var goal = incomingGoals[h];
      if (!isObject(goal) || goalIds[goal.id]) { continue; }
      var goalCopy = clone(goal);
      goalCopy.bookId = bookIdMap[goalCopy.bookId] || fallbackBookId;
      db.goals.push(schema.normalizeGoal(goalCopy, at));
      goalIds[goalCopy.id] = true;
      report.goals += 1;
    }

    var depositGoalIds = Object.create(null);
    for (var d = 0; d < db.goalDeposits.length; d++) { depositGoalIds[db.goalDeposits[d].id] = true; }
    var incomingDeposits = Array.isArray(payload.goalDeposits) ? payload.goalDeposits : [];
    for (var e = 0; e < incomingDeposits.length; e++) {
      var deposit = incomingDeposits[e];
      if (!isObject(deposit) || depositGoalIds[deposit.id]) { continue; }
      if (!goalIds[deposit.goalId]) { report.skipped += 1; continue; }
      db.goalDeposits.push(schema.normalizeGoalDeposit(clone(deposit), at));
      depositGoalIds[deposit.id] = true;
      report.goalDeposits += 1;
    }

    /* settings 不覆盖本地，只补齐缺失字段（§3.8） */
    if (isObject(payload.settings)) {
      /* schema 只导出 defaultSettings + validateSettings，没有 normalizeSettings */
      var seedSettings = typeof schema.defaultSettings === 'function' ? schema.defaultSettings(at) : {};
      var mergedSettings = Object.assign({}, seedSettings, payload.settings, db.settings,
        { createdAt: (db.settings && db.settings.createdAt) || at, updatedAt: at });
      db.settings = mergedSettings;
    }

    db.schemaVersion = SCHEMA_VERSION;
    db.appVersion = XZB.version;
    db.updatedAt = at;
    var finalCheck = schema.validateDb(db);
    if (!finalCheck.ok) {
      return fail(finalCheck.code || 'E_IMPORT_FAILED', finalCheck.path);
    }
    return { ok: true, db: db, report: report, sourceVersion: 2 };
  }

  /* ============================== 库内版本升级 ============================== */

  /* store.load 发现 schemaVersion<2 时调用；不写库、不 throw */
  function upgrade(db) {
    if (!isObject(db) || !Number.isInteger(db.schemaVersion)) {
      return fail('E_STORAGE_CORRUPT', 'db');
    }
    if (db.schemaVersion > SCHEMA_VERSION) {
      return fail('E_STORAGE_VERSION', 'schemaVersion');
    }
    if (db.schemaVersion === SCHEMA_VERSION) {
      var same = schema.validateDb(db);
      if (!same.ok) { return fail(same.code || 'E_SCHEMA_INVALID', same.path); }
      return { ok: true, db: clone(db), warnings: [], from: SCHEMA_VERSION };
    }
    var warnings = [];
    warnings.push('数据已从 v' + db.schemaVersion + ' 升级到 v' + SCHEMA_VERSION);
    var upgraded;
    try {
      upgraded = schema.ensureShape(db);
    } catch (error) {
      return fail('E_SCHEMA_INVALID', 'db', '数据校验失败，未保存');
    }
    upgraded.schemaVersion = SCHEMA_VERSION;
    upgraded.appVersion = XZB.version;
    upgraded.updatedAt = dates.nowIso();
    var checked = schema.validateDb(upgraded);
    if (!checked.ok) { return fail(checked.code || 'E_SCHEMA_INVALID', checked.path); }
    return { ok: true, db: upgraded, warnings: warnings, from: db.schemaVersion };
  }

  /* ============================== 统一入口 ============================== */

  /* 兼容 §3.3 的 migrate.run()：给 Db 就升级；给备份就导入 */
  function run(input, opts) {
    if (isObject(input) && Number.isInteger(input.schemaVersion) && Array.isArray(input.transactions) &&
      !input.kind && !input.data) {
      return upgrade(input);
    }
    var kind = detect(input);
    if (kind === 'v1') { return fromV1(input, opts); }
    if (kind === 'v2') { return importV2(input, opts); }
    return fail('E_IMPORT_INVALID', 'input');
  }

  /* 读本机 v1 数据并迁移（只读，不删 localStorage 原数据） */
  function fromLocalStorage(opts) {
    var raw = readV1Raw();
    if (!hasV1Data(raw)) {
      return { ok: true, db: null, report: emptyReport('merge', 1), empty: true };
    }
    var options = isObject(opts) ? opts : {};
    if (options.currentDb === undefined && Core.store && typeof Core.store.get === 'function') {
      options.currentDb = Core.store.get();
    }
    var result = fromV1(raw, options);
    if (!result.ok) { return result; }
    result.raw = raw;
    return result;
  }

  /* 迁移位标记：只在内存，成功提交后清空（外部可查询） */
  function beginPending(kind) {
    v1PendingMarker = { kind: kind, at: dates.nowIso() };
    return v1PendingMarker;
  }

  function clearPending() {
    v1PendingMarker = null;
  }

  function getPending() {
    return v1PendingMarker ? clone(v1PendingMarker) : null;
  }

  var api = {
    V1_KEY: V1_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    detect: detect,
    fromV1: fromV1,
    importV2: importV2,
    upgrade: upgrade,
    run: run,
    fromLocalStorage: fromLocalStorage,
    readV1Raw: readV1Raw,
    hasV1Data: hasV1Data,
    beginPending: beginPending,
    clearPending: clearPending,
    getPending: getPending,
    __test: {
      sanitizeIdPart: sanitizeIdPart,
      isoFromEpoch: isoFromEpoch,
      V1_ACCOUNT_MAP: V1_ACCOUNT_MAP
    }
  };

  Core.migrate = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.migrate = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
