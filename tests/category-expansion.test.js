'use strict';
/*
 * tests/category-expansion.test.js
 * 自检脚本：2.26.9 新增 12 个系统支出分类（feature/category-expansion-20261106）。
 *
 * 运行：node tests/category-expansion.test.js
 *
 * 加载方式：
 *  - index.html 是单文件应用，业务代码在内联 <script> 块里。本脚本按块头注释
 *    提取 money / dates / schema / store / icons 五个内联块，在 node vm 沙箱里
 *    真实执行（这些块不读 DOM / 存储 / 网络），XZB.version 手动置为 '2.26.9'
 *    （模拟 app.js 末环赋值后的最终状态）。
 *  - js/modules/nl.js、ai-insights.js、core-assistant.js 直接读源文件进同一沙箱
 *    （它们底部有 XZB.Core.* 挂载，Node 下走 global 分支）。
 *  - store 的 catalogNeedsSync 未导出，从 store 块源码里按花括号配对“提升”
 *    isObject + catalogNeedsSync 两个纯函数真实源码执行（不是复写实现）。
 *  - 图标表（CAT_ICON / FALLBACK_SYSTEM_ICONS / SYSTEM_CATEGORY_KEYS / BUCKET_*）
 *    按字面量配对提升后求值，跑的是仓库里的真实数据。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_JS = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/* ============================== 极简测试骨架 ============================== */

let passCount = 0;
let failCount = 0;
let noteCount = 0;

function section(title) {
  console.log('\n===== ' + title + ' =====');
}

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failCount += 1;
    console.log('  [FAIL] ' + name);
    console.log('         -> ' + (e && e.message ? e.message : String(e)));
  }
}

function note(msg) {
  noteCount += 1;
  console.log('  [NOTE] ' + msg);
}

function check(cond, label) {
  if (!cond) { throw new Error(label); }
}

function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ============================== 源码提取工具 ============================== */

/* 跳过字符串与注释的花括号/方括号配对扫描：返回与 start 同层配对的收尾下标（含）。 */
function matchBracket(src, start, openCh, closeCh) {
  let depth = 0;
  let i = start;
  let state = ''; // '' | "'" | '"' | 'line' | 'block'
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === '') {
      if (ch === "'" || ch === '"') { state = ch; }
      else if (ch === '/' && next === '/') { state = 'line'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'block'; i += 1; }
      else if (ch === openCh) { depth += 1; }
      else if (ch === closeCh) {
        depth -= 1;
        if (depth === 0) { return i; }
      }
    } else if (state === "'" || state === '"') {
      if (ch === '\\') { i += 1; }
      else if (ch === state) { state = ''; }
    } else if (state === 'line') {
      if (ch === '\n') { state = ''; }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = ''; i += 1; }
    }
    i += 1;
  }
  return -1;
}

/* 提取 `var NAME = [...]` / `var NAME = {...}` 字面量并求值（数据全是字符串/注释）。 */
function liftLiteral(src, varName) {
  const re = new RegExp('var\\s+' + varName + '\\s*=');
  const m = re.exec(src);
  if (!m) { return null; }
  let openIdx = m.index + m[0].length;
  while (openIdx < src.length && src[openIdx] !== '[' && src[openIdx] !== '{') { openIdx += 1; }
  if (openIdx >= src.length) { return null; }
  const openChar = src[openIdx];
  const closeChar = openChar === '[' ? ']' : '}';
  const closeIdx = matchBracket(src, openIdx, openChar, closeChar);
  if (closeIdx < 0) { return null; }
  const literal = src.slice(openIdx, closeIdx + 1);
  return new Function('return ' + literal)(); // 仅数据字面量，无执行体
}

/* 从块源码里提升一个具名 function 的完整源码（供 vm 里执行真实实现）。 */
function liftFunction(src, fnName) {
  const re = new RegExp('function\\s+' + fnName + '\\s*\\(');
  const m = re.exec(src);
  if (!m) { return null; }
  const openIdx = src.indexOf('{', m.index);
  const closeIdx = matchBracket(src, openIdx, '{', '}');
  if (closeIdx < 0) { return null; }
  return src.slice(m.index, closeIdx + 1);
}

/* 提取 index.html 的内联 <script> 块（按块头注释里的文件名锚点识别）。 */
function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

/* ============================== 沙箱装配 ============================== */

const CORE_MARKERS = ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js', 'js/core/store.js'];
const sandbox = { console: console };
vm.createContext(sandbox);

for (const marker of CORE_MARKERS) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker.replace('js/core/', 'inline:') });
}
const iconsBlock = findInlineBlock('var PATHS = {');
if (!iconsBlock) { throw new Error('index.html 中找不到 icons 模块内联块（var PATHS）'); }
vm.runInContext(iconsBlock, sandbox, { filename: 'inline:icons.js' });

/* 模拟 app.js（加载链最后一环）把版本置为当前发布版本之后的最终状态。 */
vm.runInContext("XZB.version = '2.26.13';", sandbox, { filename: 'inline:app-version-stub' });

const nlSrc = fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8');
vm.runInContext(nlSrc, sandbox, { filename: 'js/modules/nl.js' });
const aiSrc = fs.readFileSync(path.join(ROOT, 'js/modules/ai-insights.js'), 'utf8');
vm.runInContext(aiSrc, sandbox, { filename: 'js/modules/ai-insights.js' });
const caSrc = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');
vm.runInContext(caSrc, sandbox, { filename: 'js/modules/core-assistant.js' });

const schema = sandbox.XZB.Core.schema;
const store = sandbox.XZB.Core.store;
const nlApi = sandbox.XZB.Core.nl;
const aiInsights = sandbox.XZB.Core.aiInsights;
const iconsApi = sandbox.XZB.ui.icons;

/* store 未导出 catalogNeedsSync：从 store 块源码提升真实实现（含其依赖 isObject）。 */
const storeBlock = findInlineBlock('js/core/store.js');
vm.runInContext(
  liftFunction(storeBlock, 'isObject') + '\n' +
  liftFunction(storeBlock, 'catalogNeedsSync') + '\n' +
  'var schema = XZB.Core.schema;\n' +
  'globalThis.__catalogNeedsSync = catalogNeedsSync;',
  sandbox,
  { filename: 'inline:catalogNeedsSync.lifted' }
);
const catalogNeedsSync = sandbox.__catalogNeedsSync;

/* ============================== 固定数据 ============================== */

/* 12 个新分类：id -> 期望 sort（350..460） */
const NEW_CATS = {
  ca_books: 350, ca_gift_money: 360, ca_gift: 370, ca_express: 380,
  ca_topup: 390, ca_laundry: 400, ca_bathing: 410, ca_haircut: 420,
  ca_electricity: 430, ca_aifee: 440, ca_documents: 450, ca_settings: 460
};
const NEW_IDS = Object.keys(NEW_CATS);

/* 12 个新分类：id -> 期望 icon key */
const EXPECTED_ICONS = {
  ca_books: 'book', ca_gift_money: 'envelope', ca_gift: 'gift', ca_express: 'package',
  ca_topup: 'recharge', ca_laundry: 'washer', ca_bathing: 'shower', ca_haircut: 'scissors',
  ca_electricity: 'bolt', ca_aifee: 'ai', ca_documents: 'file', ca_settings: 'settings'
};
const NEW_ICON_KEYS = Object.keys(EXPECTED_ICONS).map(function (id) { return EXPECTED_ICONS[id]; });

/* 契约 §2.2 ID 正则（与 index.html schema 块逐字一致） */
const ID_RE = /^(bk|ac|ca|tx|bg|cb|rc|gl|gd|sn|qi|ph)_[a-z0-9_]{3,20}$/;

const FIXED_AT = '2026-01-01T00:00:00+08:00';

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function byId(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) { return list[i]; }
  }
  return null;
}

/* v4 老库模拟：40 个旧分类（34 支出 sort<=340 + 6 收入），旧别名是上一发布版
 * 种子落库后的存量状态（书/理发/礼物/随礼 挂在旧分类上），外加 1 条历史流水。 */
function buildLegacyDb() {
  const fresh = schema.createDb(FIXED_AT);
  const legacyCats = [];
  for (const cat of fresh.categories) {
    if (cat.kind === 'income') { legacyCats.push(cloneJson(cat)); continue; }
    if (cat.kind === 'expense' && cat.sort <= 340) { legacyCats.push(cloneJson(cat)); continue; }
  }
  /* 旧库存量别名（逐字取自上一发布版种子的存量状态） */
  byId(legacyCats, 'ca_study').aliases = ['书', '课程', '培训', '学费'];
  byId(legacyCats, 'ca_beauty').aliases = ['化妆品', '理发', '护肤', '美甲', '口红'];
  byId(legacyCats, 'ca_social').aliases = ['红包', '礼物', '随礼', '请客'];

  const legacyTx = schema.normalizeTransaction({
    id: 'tx_food0001',
    bookId: 'bk_default',
    type: 'expense',
    amountCents: 12500,
    accountId: 'ac_cash',
    toAccountId: null,
    categoryId: 'ca_food',
    date: '2026-10-15',
    time: '12:30',
    note: '历史午饭记录',
    tags: ['历史'],
    reimburse: 'none'
  }, '2026-10-15T12:30:00+08:00');

  return {
    schemaVersion: 4,
    appVersion: '2.26.0',
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    books: cloneJson(fresh.books),
    accounts: cloneJson(fresh.accounts),
    categories: legacyCats,
    transactions: [legacyTx],
    budgets: [],
    categoryBudgets: [],
    recurring: [],
    goals: [],
    goalDeposits: [],
    settings: cloneJson(fresh.settings)
  };
}

/* nl.parse 最小 ctx：52 个种子分类 + 1 个最小合法账户 + 固定 today/nowTime */
function buildNlCtx() {
  return {
    today: '2026-11-06',
    nowTime: '12:00',
    accounts: [{
      id: 'ac_cash', name: '现金', type: 'cash', icon: 'wallet', color: '#34C759',
      openingBalanceCents: 0, limitCents: 0, billDay: null, dueDay: null,
      archived: false, sort: 10, note: ''
    }],
    categories: schema.seedData().categories,
    defaults: { type: 'expense' }
  };
}

/* core-assistant resolveCategory 的最小 cx */
function buildAssistantCx() {
  const seeds = schema.seedData().categories;
  return { categories: seeds, liveCategories: seeds.filter(function (c) { return c.hidden !== true; }) };
}

/* ============================== 用例 1：新库种子与 createDb ============================== */

section('用例 1：新库 seedData / createDb（52 分类 + 12 新分类元数据 + ID_RE + 别名约束）');

test('1.1 seedData() 共 52 个分类：46 支出 + 6 收入', function () {
  const cats = schema.seedData().categories;
  checkEq(cats.length, 52, '分类总数');
  const expense = cats.filter(function (c) { return c.kind === 'expense'; }).length;
  const income = cats.filter(function (c) { return c.kind === 'income'; }).length;
  checkEq(expense, 46, '支出分类数');
  checkEq(income, 6, '收入分类数');
});

test('1.2 12 个新 id 全部存在，且 kind=expense、system=true、sort 恰为 350..460', function () {
  const cats = schema.seedData().categories;
  for (const id of NEW_IDS) {
    const cat = byId(cats, id);
    check(cat, '缺少新分类 ' + id);
    checkEq(cat.kind, 'expense', id + '.kind');
    checkEq(cat.system, true, id + '.system');
    checkEq(cat.sort, NEW_CATS[id], id + '.sort');
    check(cat.sort >= 350 && cat.sort <= 460, id + '.sort 不在 350..460');
  }
});

test('1.3 createDb() 通过 schema.validateDb（ok=true）', function () {
  const db = schema.createDb(FIXED_AT);
  const result = schema.validateDb(db);
  checkEq(result.ok, true, 'validateDb(createDb()) -> ' + JSON.stringify(result));
});

test('1.4 seedData 的 52 个 id 全部匹配契约 ID_RE', function () {
  const cats = schema.seedData().categories;
  const bad = cats.filter(function (c) { return !ID_RE.test(c.id); });
  checkEq(bad.length, 0, '不匹配 ID_RE 的 id：' + bad.map(function (c) { return c.id; }).join(','));
});

test('1.5 全部 52 类 aliases 数 <=8、单条 <=10 字、类内无重复', function () {
  const cats = schema.seedData().categories;
  const problems = [];
  for (const cat of cats) {
    const aliases = Array.isArray(cat.aliases) ? cat.aliases : [];
    if (aliases.length > 8) { problems.push(cat.id + ' 别名数 ' + aliases.length); }
    const seen = Object.create(null);
    for (const alias of aliases) {
      if (Array.from(alias).length > 10) { problems.push(cat.id + ' 别名超长 ' + alias); }
      if (seen[alias]) { problems.push(cat.id + ' 别名重复 ' + alias); }
      seen[alias] = true;
    }
  }
  checkEq(problems.length, 0, problems.join('；'));
});

/* ============================== 用例 2：v4 老库启动同步 ============================== */

section('用例 2：v4 老库（40 旧分类 + 历史流水）catalogNeedsSync / syncCategoryCatalog');

test('2.0 装置自检：老库恰为 40 个分类，且自身先通过 validateDb', function () {
  const db = buildLegacyDb();
  checkEq(db.categories.length, 40, '老库分类数');
  check(byId(db.categories, 'ca_books') === null, '装置不应已含 ca_books');
  checkEq(byId(db.categories, 'ca_study').aliases.indexOf('书') >= 0, true, '装置 ca_study 应带旧别名「书」');
  const result = schema.validateDb(db);
  checkEq(result.ok, true, '老库装置本身应通过 validateDb -> ' + JSON.stringify(result));
});

test('2.1 catalogNeedsSync(老库) 返回 true（真实 store 源码提升执行）', function () {
  checkEq(catalogNeedsSync(buildLegacyDb()), true, '老库缺 12 个种子分类，应判定需要同步');
});

test('2.2 catalogNeedsSync(createDb()) 返回 false（全量目录不误报）', function () {
  checkEq(catalogNeedsSync(schema.createDb(FIXED_AT)), false, '新库目录齐全，不应判定需要同步');
});

test('2.3 syncCategoryCatalog(老库) 后分类数补齐到 52', function () {
  const db = buildLegacyDb();
  schema.syncCategoryCatalog(db);
  checkEq(db.categories.length, 52, '同步后分类数');
  for (const id of NEW_IDS) {
    check(byId(db.categories, id), '同步后缺少 ' + id);
  }
});

test('2.4 三个旧分类的旧默认别名被摘除，其余别名原样保留', function () {
  const db = buildLegacyDb();
  schema.syncCategoryCatalog(db);
  const study = byId(db.categories, 'ca_study');
  const beauty = byId(db.categories, 'ca_beauty');
  const social = byId(db.categories, 'ca_social');
  checkEq(study.aliases.indexOf('书'), -1, 'ca_study 不应再含「书」');
  checkEq(beauty.aliases.indexOf('理发'), -1, 'ca_beauty 不应再含「理发」');
  checkEq(social.aliases.indexOf('礼物'), -1, 'ca_social 不应再含「礼物」');
  checkEq(social.aliases.indexOf('随礼'), -1, 'ca_social 不应再含「随礼」');
  checkEq(study.aliases.length, 3, 'ca_study 剩余别名数');
  check(deepEq(study.aliases, ['课程', '培训', '学费']), 'ca_study 剩余别名应为 [课程,培训,学费]，实际 ' + JSON.stringify(study.aliases));
  check(deepEq(beauty.aliases, ['化妆品', '护肤', '美甲', '口红']), 'ca_beauty 剩余别名应为 [化妆品,护肤,美甲,口红]，实际 ' + JSON.stringify(beauty.aliases));
  check(deepEq(social.aliases, ['红包', '请客']), 'ca_social 剩余别名应为 [红包,请客]，实际 ' + JSON.stringify(social.aliases));
});

test('2.5 历史 transaction 逐字段原样（同步不动流水）', function () {
  const db = buildLegacyDb();
  const before = cloneJson(db.transactions);
  schema.syncCategoryCatalog(db);
  checkEq(db.transactions.length, 1, '流水条数');
  check(deepEq(db.transactions, before),
    '流水被改动：before=' + JSON.stringify(before) + ' after=' + JSON.stringify(db.transactions));
  checkEq(db.transactions[0].categoryId, 'ca_food', '历史流水 categoryId');
  checkEq(db.transactions[0].amountCents, 12500, '历史流水金额（分）');
  checkEq(db.transactions[0].date, '2026-10-15', '历史流水日期');
  checkEq(db.transactions[0].note, '历史午饭记录', '历史流水备注');
});

test('2.6 同步后的老库通过 schema.validateDb', function () {
  const db = buildLegacyDb();
  schema.syncCategoryCatalog(db);
  const result = schema.validateDb(db);
  checkEq(result.ok, true, 'validateDb(同步后老库) -> ' + JSON.stringify(result));
});

test('2.7 幂等：再跑一次 syncCategoryCatalog 分类与别名均不变，其余表也不变', function () {
  const db = buildLegacyDb();
  schema.syncCategoryCatalog(db);
  const snapshot = cloneJson(db);
  schema.syncCategoryCatalog(db);
  checkEq(db.categories.length, 52, '二次同步后分类数');
  check(deepEq(db.categories, snapshot.categories), '二次同步改动了 categories');
  for (const key of ['books', 'accounts', 'transactions', 'budgets', 'categoryBudgets', 'recurring', 'goals', 'goalDeposits', 'settings']) {
    check(deepEq(db[key], snapshot[key]), '二次同步改动了 ' + key);
  }
  checkEq(catalogNeedsSync(db), false, '同步后的库 catalogNeedsSync 应为 false');
});

test('2.8 源码级：loadInternal 启动同步链 catalogNeedsSync -> syncCategoryCatalog -> validateDb -> writeStateRecord 按序存在', function () {
  const at = function (needle) {
    const idx = storeBlock.indexOf(needle);
    check(idx >= 0, 'store 块缺少启动同步关键步骤：' + needle);
    return idx;
  };
  const i1 = at('if (catalogNeedsSync(value))');
  const i2 = at('schema.syncCategoryCatalog(synced)');
  const i3 = at('schema.validateDb(synced).ok');
  const i4 = at('writeStateRecord({ key: STATE_KEY, value: clone(synced)');
  check(i1 < i2 && i2 < i3 && i3 < i4, '启动同步链调用顺序不对：' + [i1, i2, i3, i4].join(','));
});

/* ============================== 用例 3：同名自定义分类防冲突 ============================== */

section('用例 3：用户自建同名分类「书籍」时种子 ca_books 被跳过');

function buildLegacyDbWithUserBook() {
  const db = buildLegacyDb();
  db.categories.push({
    id: 'ca_user_book1',
    kind: 'expense',
    name: '书籍',
    icon: 'book',
    color: '#123456',
    sort: 999,
    hidden: false,
    system: false,
    aliases: [],
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    deleted: false
  });
  return db;
}

test('3.1 syncCategoryCatalog 后不出现 ca_books 种子（同 kind 同名跳过），用户分类保留', function () {
  const db = buildLegacyDbWithUserBook();
  schema.syncCategoryCatalog(db);
  checkEq(byId(db.categories, 'ca_books'), null, 'ca_books 不应被追加（用户已有同名「书籍」）');
  check(byId(db.categories, 'ca_user_book1') !== null, '用户自建分类不应被动');
  checkEq(db.categories.length, 52, '应为 40 旧分类 + 用户 1 + 补齐 11 个其余种子 = 52');
});

test('3.2 同名场景下 validateDb 通过（无 E_CATEGORY_DUP）', function () {
  const db = buildLegacyDbWithUserBook();
  schema.syncCategoryCatalog(db);
  const result = schema.validateDb(db);
  checkEq(result.ok, true, 'validateDb -> ' + JSON.stringify(result));
  if (!result.ok) { checkEq(result.code, 'E_CATEGORY_DUP', '失败码'); }
});

/* ============================== 用例 4：nl 解析路由 ============================== */

section('用例 4：nl.parse 一句话分类路由（52 种子分类 ctx，固定 today）');

function parseCategory(text) {
  const result = nlApi.parse(text, buildNlCtx());
  if (!result.ok) { throw new Error('parse(' + JSON.stringify(text) + ') 失败：' + result.code); }
  return result.best;
}

test('4.1 「礼物 200」-> ca_gift', function () {
  checkEq(parseCategory('礼物 200').categoryId, 'ca_gift');
});
test('4.2 「随礼 500」-> ca_gift_money', function () {
  checkEq(parseCategory('随礼 500').categoryId, 'ca_gift_money');
});
test('4.3 「理发 30」-> ca_haircut', function () {
  checkEq(parseCategory('理发 30').categoryId, 'ca_haircut');
});
test('4.4 「书籍 45」-> ca_books', function () {
  checkEq(parseCategory('书籍 45').categoryId, 'ca_books');
});
test('4.5 「电费 88」-> ca_electricity', function () {
  checkEq(parseCategory('电费 88').categoryId, 'ca_electricity');
});
test('4.6 「话费充值 50」-> ca_topup', function () {
  checkEq(parseCategory('话费充值 50').categoryId, 'ca_topup');
});
test('4.7 「游戏充值 68」-> ca_game（长词「游戏充值」赢过短词「充值」）', function () {
  checkEq(parseCategory('游戏充值 68').categoryId, 'ca_game');
});
test('4.8 「AI订阅 20」-> ca_aifee（验收必须命中）', function () {
  checkEq(parseCategory('AI订阅 20').categoryId, 'ca_aifee');
});
test('4.9 「礼物 200」金额换算为 20000 分', function () {
  checkEq(parseCategory('礼物 200').amountCents, 20000);
});
test('4.10 「ChatGPT 20」-> ca_aifee（别名表原文大小写）', function () {
  checkEq(parseCategory('ChatGPT 20').categoryId, 'ca_aifee');
});
test('4.11 「买 30」不因内置/种子别名黑名单之外的宽泛词误路由到新分类', function () {
  const best = parseCategory('买 30');
  check(NEW_IDS.indexOf(best.categoryId) < 0, '「买」不应路由到新分类，实际 ' + best.categoryId);
});

/* 大小写敏感性曾是既有行为（小写 chatgpt 命中不了 'ChatGPT' 别名）；
 * 迭代 2 起匹配大小写不敏感，路由断言移至用例 10.1，此处仅固化金额解析。 */
test('4.N 「chatgpt 20」（小写）解析成功，记录实际路由（观察项）', function () {
  const result = nlApi.parse('chatgpt 20', buildNlCtx());
  checkEq(result.ok, true, '小写 chatgpt 应能解析出金额');
  if (result.ok) {
    note('「chatgpt 20」实际路由 -> ' + result.best.categoryId +
      '（迭代2 起别名匹配大小写不敏感，路由已由用例 10.1 断言）');
  }
});

test('4.12 nl 内置黑名单源码断言：buildCategoryDict 的 system 别名黑名单只有「买」', function () {
  const m = /var blacklist = \{[^}]*\};/.exec(nlSrc);
  check(m, 'nl.js 中找不到 buildCategoryDict 的 blacklist 定义');
  checkEq(m[0], "var blacklist = { '买': true };", 'system 别名黑名单内容');
});

/* ============================== 用例 5：三桶归类 ============================== */

section('用例 5：ai-insights 三桶（必要/发展/享受）覆盖 12 个新分类');

const BUCKET_NECESSARY = liftLiteral(aiSrc, 'BUCKET_NECESSARY');
const BUCKET_DEVELOPMENT = liftLiteral(aiSrc, 'BUCKET_DEVELOPMENT');
const BUCKET_ENJOYMENT = liftLiteral(aiSrc, 'BUCKET_ENJOYMENT');

test('5.0 装置自检：三个桶字面量均可从 ai-insights.js 源码提升求值', function () {
  check(Array.isArray(BUCKET_NECESSARY), 'BUCKET_NECESSARY 提升失败');
  check(Array.isArray(BUCKET_DEVELOPMENT), 'BUCKET_DEVELOPMENT 提升失败');
  check(Array.isArray(BUCKET_ENJOYMENT), 'BUCKET_ENJOYMENT 提升失败');
});

test('5.1 necessary 桶含快递/洗衣服/洗澡/理发/电费/设置 6 个新分类', function () {
  for (const id of ['ca_express', 'ca_laundry', 'ca_bathing', 'ca_haircut', 'ca_electricity', 'ca_settings']) {
    check(BUCKET_NECESSARY.indexOf(id) >= 0, 'BUCKET_NECESSARY 缺少 ' + id);
  }
});

test('5.2 development 桶含书籍/ai/资料 3 个新分类', function () {
  for (const id of ['ca_books', 'ca_aifee', 'ca_documents']) {
    check(BUCKET_DEVELOPMENT.indexOf(id) >= 0, 'BUCKET_DEVELOPMENT 缺少 ' + id);
  }
});

test('5.3 enjoyment 桶含礼金/礼物/充值 3 个新分类', function () {
  for (const id of ['ca_gift_money', 'ca_gift', 'ca_topup']) {
    check(BUCKET_ENJOYMENT.indexOf(id) >= 0, 'BUCKET_ENJOYMENT 缺少 ' + id);
  }
});

test('5.4 12 个新 id 无跨桶重复（每个 id 在三桶合计恰出现 1 次）', function () {
  const all = BUCKET_NECESSARY.concat(BUCKET_DEVELOPMENT, BUCKET_ENJOYMENT);
  for (const id of NEW_IDS) {
    let count = 0;
    for (const bucket of [BUCKET_NECESSARY, BUCKET_DEVELOPMENT, BUCKET_ENJOYMENT]) {
      if (bucket.indexOf(id) >= 0) { count += 1; }
    }
    checkEq(count, 1, id + ' 在三桶中出现 ' + count + ' 次（应为 1）');
  }
  const seen = Object.create(null);
  for (const id of all) {
    if (seen[id]) { throw new Error('桶内重复 id：' + id); }
    seen[id] = true;
  }
});

test('5.5 ai-insights 模块在沙箱加载成功且导出 buildMonthlyMetrics/buildFallbackInsights', function () {
  checkEq(typeof aiInsights.buildMonthlyMetrics, 'function', 'buildMonthlyMetrics');
  checkEq(typeof aiInsights.buildFallbackInsights, 'function', 'buildFallbackInsights');
});

/* ============================== 用例 6：图标解析 ============================== */

section('用例 6：12 个新分类的 icon key 在 PATHS 注册表与三份图标表可解析');

test('6.1 icons.has(key) 为真：12 个 icon key 均在真实 PATHS 注册表（沙箱已执行 icons 块）', function () {
  for (const key of NEW_ICON_KEYS) {
    checkEq(iconsApi.has(key), true, 'PATHS 注册表缺少图标 key：' + key);
  }
});

test('6.2 icons.systemCategoryKeys()（真实代码）含全部 12 个新 icon key', function () {
  const keys = iconsApi.systemCategoryKeys();
  for (const key of NEW_ICON_KEYS) {
    check(keys.indexOf(key) >= 0, 'systemCategoryKeys() 缺少 ' + key);
  }
});

test('6.3 add.js CAT_ICON 对 12 个新 id 的映射逐项正确', function () {
  const catIcon = liftLiteral(fs.readFileSync(path.join(ROOT, 'js/screens/add.js'), 'utf8'), 'CAT_ICON');
  check(catIcon, 'add.js CAT_ICON 提取失败');
  for (const id of NEW_IDS) {
    checkEq(catIcon[id], EXPECTED_ICONS[id], 'CAT_ICON.' + id);
  }
});

test('6.4 settings.js FALLBACK_SYSTEM_ICONS 含全部 12 个新 icon key', function () {
  const fallback = liftLiteral(fs.readFileSync(path.join(ROOT, 'js/screens/settings.js'), 'utf8'), 'FALLBACK_SYSTEM_ICONS');
  check(Array.isArray(fallback), 'settings.js FALLBACK_SYSTEM_ICONS 提取失败');
  for (const key of NEW_ICON_KEYS) {
    check(fallback.indexOf(key) >= 0, 'FALLBACK_SYSTEM_ICONS 缺少 ' + key);
  }
});

test('6.5 index.html SYSTEM_CATEGORY_KEYS 字面量含 9 个新增 icon key', function () {
  const keys = liftLiteral(iconsBlock, 'SYSTEM_CATEGORY_KEYS');
  check(Array.isArray(keys), 'SYSTEM_CATEGORY_KEYS 提取失败');
  for (const key of ['envelope', 'package', 'recharge', 'shower', 'scissors', 'bolt', 'ai', 'file', 'settings']) {
    check(keys.indexOf(key) >= 0, 'SYSTEM_CATEGORY_KEYS 缺少 ' + key);
  }
});

/* ============================== 用例 7：版本一致性 ============================== */

section('用例 7：版本号 2.27.0 三处一致，无旧版本残留');

test('7.1 index.html 含 XZB.version = \'2.27.0\'', function () {
  check(/XZB\.version\s*=\s*'2\.27\.0'/.test(INDEX_HTML), 'index.html 未找到 XZB.version = \'2.27.0\'');
});

test('7.2 sw.js CACHE_NAME=\'xzb2-v2.27.0\' 且 CACHE_LABEL 含 2.27.0', function () {
  check(/CACHE_NAME\s*=\s*'xzb2-v2\.27\.0'/.test(SW_JS), 'sw.js CACHE_NAME 不是 xzb2-v2.27.0');
  const m = /CACHE_LABEL\s*=\s*'([^']*)'/.exec(SW_JS);
  check(m, 'sw.js 找不到 CACHE_LABEL');
  check(m[1].indexOf('2.27.0') >= 0, 'CACHE_LABEL 不含 2.27.0：' + m[1]);
});

test('7.3 业务代码（.html/.js，排除 node_modules/.git）无旧版本号残留', function () {
  const needle = '2.26.' + String.fromCharCode(56); // 旧版本号，避免本文件自匹配
  const offenders = [];
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') { continue; }
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); } else { files.push(p); }
    }
  })(ROOT);
  for (const file of files) {
    /* 只扫代码文件：交付说明等 .md 文档会合法提及基线版本号（升级前版本字符串） */
    if (!/\.(html|js)$/i.test(file)) { continue; }
    const buf = fs.readFileSync(file);
    if (buf.indexOf(needle) >= 0) { offenders.push(path.relative(ROOT, file)); }
  }
  checkEq(offenders.length, 0, '旧版本号残留于：' + offenders.join(', '));
});

/* ============================== 用例 8：备份回灌 ensureShape ============================== */

section('用例 8：schema.ensureShape 老库回灌（导入链路补齐新分类）');

test('8.1 ensureShape(老库模拟对象) 后 52 类齐全且 validateDb 通过', function () {
  const db = schema.ensureShape(buildLegacyDb());
  checkEq(db.categories.length, 52, 'ensureShape 后分类数');
  for (const id of NEW_IDS) {
    check(byId(db.categories, id), 'ensureShape 后缺少 ' + id);
  }
  const result = schema.validateDb(db);
  checkEq(result.ok, true, 'validateDb(ensureShape 后) -> ' + JSON.stringify(result));
});

test('8.2 ensureShape 同样摘除三个旧分类的旧默认别名', function () {
  const db = schema.ensureShape(buildLegacyDb());
  checkEq(byId(db.categories, 'ca_study').aliases.indexOf('书'), -1, 'ca_study 不应含「书」');
  checkEq(byId(db.categories, 'ca_beauty').aliases.indexOf('理发'), -1, 'ca_beauty 不应含「理发」');
  const social = byId(db.categories, 'ca_social');
  check(social.aliases.indexOf('礼物') < 0 && social.aliases.indexOf('随礼') < 0, 'ca_social 不应含「礼物」/「随礼」');
});

test('8.3 ensureShape 保留历史流水的关键业务字段', function () {
  const legacy = buildLegacyDb();
  const before = legacy.transactions[0];
  const db = schema.ensureShape(legacy);
  checkEq(db.transactions.length, 1, '流水条数');
  const after = db.transactions[0];
  for (const key of ['id', 'bookId', 'type', 'amountCents', 'accountId', 'categoryId', 'date', 'time', 'note', 'reimburse']) {
    checkEq(after[key], before[key], 'tx.' + key);
  }
  check(deepEq(after.tags, before.tags), 'tx.tags 被改动：' + JSON.stringify(after.tags));
});

/* ============================== 用例 9（补充）：core-assistant resolveCategory ============================== */

section('用例 9（补充）：core-assistant.resolveCategory / EXTRA_ALIASES');

test('9.1 resolveCategory 按最长 token 路由：礼物/随礼/理发/电费 -> 新分类', function () {
  const cx = buildAssistantCx();
  const resolve = sandbox.XZB.Core.assistant.resolveCategory;
  checkEq(typeof resolve, 'function', 'XZB.Core.assistant.resolveCategory 应为函数');
  checkEq(resolve('礼物', 'expense', cx).id, 'ca_gift', '礼物');
  checkEq(resolve('随礼', 'expense', cx).id, 'ca_gift_money', '随礼');
  checkEq(resolve('理发', 'expense', cx).id, 'ca_haircut', '理发');
  checkEq(resolve('电费', 'expense', cx).id, 'ca_electricity', '电费');
});

test('9.2 resolveCategory 最长 token 优先：「游戏充值」-> ca_game（旧分类，sort 更小）', function () {
  const cx = buildAssistantCx();
  const resolve = sandbox.XZB.Core.assistant.resolveCategory;
  checkEq(resolve('游戏充值', 'expense', cx).id, 'ca_game', '游戏充值应归旧分类 ca_game');
});

test('9.3 EXTRA_ALIASES 含全部 12 个新 id，且 ca_social 词表已不含 礼物/随礼', function () {
  const extra = liftLiteral(caSrc, 'EXTRA_ALIASES');
  check(extra, 'core-assistant.js EXTRA_ALIASES 提取失败');
  for (const id of NEW_IDS) {
    check(Array.isArray(extra[id]) && extra[id].length > 0, 'EXTRA_ALIASES 缺少 ' + id);
  }
  check(extra.ca_social.indexOf('礼物') < 0, 'EXTRA_ALIASES.ca_social 不应再含「礼物」');
  check(extra.ca_social.indexOf('随礼') < 0, 'EXTRA_ALIASES.ca_social 不应再含「随礼」');
});

/* ============================== 用例 10（迭代2）：别名匹配大小写不敏感 ============================== */

section('用例 10（迭代2）：别名匹配大小写不敏感（nl 与 resolveCategory 双路径）');

test('10.1 nl：小写拉丁别名命中 ca_aifee', function () {
  checkEq(parseCategory('chatgpt 20').categoryId, 'ca_aifee', 'chatgpt');
  checkEq(parseCategory('openai 30').categoryId, 'ca_aifee', 'openai');
  checkEq(parseCategory('claude 15').categoryId, 'ca_aifee', 'claude');
  checkEq(parseCategory('gemini 25').categoryId, 'ca_aifee', 'gemini');
  checkEq(parseCategory('ai 20').categoryId, 'ca_aifee', 'ai');
});

test('10.2 nl：纯 ASCII 词内子串不误中，CJK 毗邻正常命中', function () {
  const email = parseCategory('email 20');
  check(email.categoryId !== 'ca_aifee', 'email 不应误路由 ca_aifee，实际 ' + email.categoryId);
  checkEq(parseCategory('ai课 30').categoryId, 'ca_aifee', 'ai课');
});

test('10.3 resolveCategory：小写别名命中、email 不误中（与 nl 同语义）', function () {
  const cx = buildAssistantCx();
  const resolve = sandbox.XZB.Core.assistant.resolveCategory;
  checkEq(resolve('chatgpt 会员', 'expense', cx).id, 'ca_aifee', 'chatgpt');
  checkEq(resolve('openai api 费', 'expense', cx).id, 'ca_aifee', 'openai');
  check(resolve('email 费', 'expense', cx).id !== 'ca_aifee',
    'email 不应误中，实际 ' + (resolve('email 费', 'expense', cx).id || '无'));
});

/* ============================== 汇总 ============================== */

console.log('\n=========================================');
console.log('通过 ' + passCount + ' / 失败 ' + failCount + ' / 观察项 ' + noteCount);
if (failCount === 0) {
  console.log('总结论：全绿 PASS');
} else {
  console.log('总结论：存在 FAIL，见上方 [FAIL] 明细');
}
console.log('=========================================');
process.exit(failCount === 0 ? 0 : 1);
