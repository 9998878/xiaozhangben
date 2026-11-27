'use strict';
/*
 * tests/assistant-core-logic.test.js
 * 2.38.0 回归：AI 助手底层逻辑优化——
 *   1) 多笔无分隔（午饭28打车15）与无空格连接词（午饭28然后打车15）分句；
 *   2) 最近使用账户全量扫描（旧版 slice(0,400) 在插入序库上取的是最旧 400 笔）；
 *   3) 双词表统一（nl.categoryAliases 权威 + EXTRA 兜底并集，奖金归 ca_bonus）；
 *   4) 传输层非 2xx 读响应体细分归因（endpoint/model/auth），detail 掩码密钥；
 *   5) fitBody 精确裁剪（不再对半砍）+ categoryPairs 使用频度排序；
 *   6) 既有行为回归（烟14.09 / 转账500 / 查询路由）。
 *
 * 运行：node tests/assistant-core-logic.test.js
 * 加载方式与 assistant-state.test.js / ai-config.test.js 一致：
 * node vm 沙箱执行 index.html 内联核心块 + nl.js + core-assistant.js，
 * 注入 localStorage stub 与 fetch 桩，不依赖真实网络。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');
const NL_JS = fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8');
const ASSISTANT_JS = fs.readFileSync(path.join(ROOT, 'js/screens/assistant.js'), 'utf8');

/* ============================== 极简测试骨架（支持异步） ============================== */

let passCount = 0;
let failCount = 0;
let currentSection = '';
function section(title) { currentSection = title; }
const CASES = [];
function regCase(name, fn) { CASES.push([currentSection, name, fn]); }
function check(cond, label) { if (!cond) { throw new Error(label); } }
function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ============================== 沙箱与桩 ============================== */

function makeLS() {
  const m = Object.create(null);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; }
  };
}
const ls = makeLS();

const sandbox = {
  console,
  fetch() { return Promise.reject(new Error('sandbox: no network')); },
  AbortController,
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Promise,
  Math,
  Number,
  String,
  Object,
  Array,
  isFinite,
  localStorage: ls,
  navigator: { onLine: true }
};
sandbox.global = sandbox;
vm.createContext(sandbox);

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker });
}
vm.runInContext(NL_JS, sandbox, { filename: 'nl.js' });
vm.runInContext(CORE_JS, sandbox, { filename: 'core-assistant.js' });
/* 2.44.7 拆分：insight-qa 独立成 chunk，同沙箱随后加载，行为与拆分前一致 */
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/insight-qa.js'), 'utf8'), sandbox, { filename: 'insight-qa.js' });

const asst = sandbox.XZB.Core.assistant;
const nl = sandbox.XZB.Core.nl;
const schema = sandbox.XZB.Core.schema;
const llm = asst.llm;
if (!asst || !nl || !schema) { throw new Error('核心模块未就绪'); }

const ACCOUNTS = [
  { id: 'ac_cash', name: '现金', type: 'cash', archived: false },
  { id: 'ac_wechat', name: '微信', type: 'wechat', archived: false },
  { id: 'ac_alipay', name: '支付宝', type: 'alipay', archived: false }
];

function makeCtx(transactions, settings) {
  return {
    today: '2026-11-13', nowTime: '20:41', bookId: 'bk_main',
    accounts: ACCOUNTS,
    categories: schema.seedData().categories,
    defaults: { type: 'expense' },
    settings: settings || {},
    db: { transactions: transactions || [], accounts: [], categories: [] },
    liveAccounts: ACCOUNTS,
    liveCategories: schema.seedData().categories
  };
}

/* 换 fetch 桩（用后还原） */
async function withFetch(stub, fn) {
  const prev = sandbox.fetch;
  sandbox.fetch = stub;
  try { return await fn(); } finally { sandbox.fetch = prev; }
}

const AI_KEY_VALUE = 'xzb.ai.v1';
const KEY_SENTINEL = 'sk-test-1234567890';
function seedCompleteConfig() {
  ls.removeItem(AI_KEY_VALUE);
  const r1 = llm.setConfig({ baseURL: 'https://api.example.com/v1', model: 'gpt-4o-mini', key: KEY_SENTINEL });
  const r2 = llm.setConfig({ enabled: true });
  const r3 = llm.setConfig({ noticeAt: Date.now() });
  if (!(r1 && r1.ok) || !(r2 && r2.ok) || !(r3 && r3.ok)) { throw new Error('预置配置写入失败'); }
}

/* 花括号配对提升真实源码（与 category-expansion 同思路） */
function liftFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) { return null; }
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') { depth += 1; }
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { return src.slice(start, j + 1); } }
  }
  return null;
}
function liftLiteral(src, name) {
  const marker = 'var ' + name + ' = {';
  const start = src.indexOf(marker);
  if (start < 0) { return null; }
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') { depth += 1; }
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { return src.slice(open, j + 1); } }
  }
  return null;
}

/* ============================== 用例 1：多笔无分隔 / 连接词分句 ============================== */

section('用例 1：多笔无分隔与无空格连接词（2.38.0）');

regCase('1.1 「午饭28打车15」应拆成 2 笔（旧版只记最后一笔）', function () {
  const out = asst.respond('午饭28打车15', {}, makeCtx());
  checkEq(out.reply.kind, 'preview', '应出预览');
  const items = out.reply.plan.items;
  checkEq(items.length, 2, '笔数');
  checkEq(items[0].amountCents, 2800, '第 1 笔金额');
  checkEq(items[1].amountCents, 1500, '第 2 笔金额');
  checkEq(items[0].categoryId, 'ca_food', '第 1 笔分类');
  checkEq(items[1].categoryId, 'ca_transport', '第 2 笔分类');
});

regCase('1.2 「午饭28然后打车15」连接词前无空格也应拆 2 笔', function () {
  const out = asst.respond('午饭28然后打车15', {}, makeCtx());
  checkEq(out.reply.kind, 'preview', '应出预览');
  checkEq(out.reply.plan.items.length, 2, '笔数');
});

regCase('1.3 「午饭35还有地铁4」还有连接应拆 2 笔', function () {
  const out = asst.respond('午饭35还有地铁4', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 2, '笔数');
  checkEq(out.reply.plan.items[1].amountCents, 400, '地铁 4 元');
});

regCase('1.4 「工资8000奖金2000」应拆 2 笔收入，奖金归 ca_bonus', function () {
  const out = asst.respond('工资8000奖金2000', {}, makeCtx());
  const items = out.reply.plan.items;
  checkEq(items.length, 2, '笔数');
  checkEq(items[0].type, 'income', '第 1 笔收入');
  checkEq(items[1].type, 'income', '第 2 笔收入');
  checkEq(items[0].categoryId, 'ca_salary', '工资');
  checkEq(items[1].categoryId, 'ca_bonus', '奖金归额外收入');
});

regCase('1.5 「苹果13手机壳50」物品名带数字不得误拆（落不到分类）', function () {
  const out = asst.respond('苹果13手机壳50', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 1, '应保持 1 笔');
});

regCase('1.6 「充话费100送20」赠送不是账，不得误拆', function () {
  const out = asst.respond('充话费100送20', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 1, '应保持 1 笔');
});

regCase('1.7 「打车28.5元」小数守卫：1 笔 2850 分', function () {
  const out = asst.respond('打车28.5元', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 1, '笔数');
  checkEq(out.reply.plan.items[0].amountCents, 2850, '金额');
});

regCase('1.8 「8月1日午饭30」日期守卫：1 笔且日期正确', function () {
  const out = asst.respond('8月1日午饭30', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 1, '笔数');
  checkEq(out.reply.plan.items[0].date, '2026-08-01', '日期');
});

regCase('1.9 「从微信转到支付宝500」转账守卫：1 笔转账', function () {
  const out = asst.respond('从微信转到支付宝500', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 1, '笔数');
  checkEq(out.reply.plan.items[0].type, 'transfer', '类型');
});

regCase('1.10 「午饭28，打车15」标点分句回归', function () {
  const out = asst.respond('午饭28，打车15', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 2, '笔数');
});

regCase('1.11 splitSegments 无 cx 保持旧行为；带 cx 才做保守拆分', function () {
  checkEq(asst.splitSegments('午饭28打车15').length, 1, '无 cx 不拆');
  checkEq(asst.splitSegments('午饭28打车15', makeCtx()).length, 2, '带 cx 拆 2');
});

regCase('1.12 「午饭28打车15地铁4」三笔无分隔', function () {
  const out = asst.respond('午饭28打车15地铁4', {}, makeCtx());
  checkEq(out.reply.plan.items.length, 3, '笔数');
});

regCase('1.13 「买书50买笔10」两段都能落分类：拆 2 笔（书籍/购物）', function () {
  const out = asst.respond('买书50买笔10', {}, makeCtx());
  const items = out.reply.plan.items;
  checkEq(items.length, 2, '应拆 2 笔');
  checkEq(items[0].categoryId, 'ca_books', '买书归书籍');
  checkEq(items[0].amountCents, 5000, '买书金额');
  checkEq(items[1].amountCents, 1000, '买笔金额');
});

/* ============================== 用例 2：最近使用账户 ============================== */

section('用例 2：最近使用账户全量扫描 + cx 级缓存（2.38.0）');

function bulkTx(n, accountId, createdAt) {
  const list = [];
  for (let i = 0; i < n; i += 1) {
    list.push({
      id: 'tx_bulk_' + i, bookId: 'bk_main', type: 'expense', amountCents: 100,
      categoryId: 'ca_food', accountId: accountId, date: '2026-01-01',
      createdAt: createdAt, deleted: false, note: ''
    });
  }
  return list;
}

regCase('2.1 500 笔插入序库：最新一笔在尾部，默认账户应跟最新（旧版取最旧 400 笔）', function () {
  const txs = bulkTx(499, 'ac_cash', '2026-01-01T00:00:00');
  txs.push({
    id: 'tx_newest', bookId: 'bk_main', type: 'expense', amountCents: 100,
    categoryId: 'ca_food', accountId: 'ac_alipay', date: '2026-11-13',
    createdAt: '2026-11-13T10:00:00', deleted: false, note: ''
  });
  const out = asst.respond('午饭35', {}, makeCtx(txs));
  checkEq(out.reply.plan.items[0].accountId, 'ac_alipay', '默认账户应取全库最新');
});

regCase('2.2 settings.defaultAccountId 仍优先于最近使用', function () {
  const txs = bulkTx(10, 'ac_alipay', '2026-11-01T00:00:00');
  const out = asst.respond('午饭35', {}, makeCtx(txs, { defaultAccountId: 'ac_cash' }));
  checkEq(out.reply.plan.items[0].accountId, 'ac_cash', '显式默认优先');
});

regCase('2.3 同一 cx 写入新流水后缓存自动作废，默认账户跟随最新', function () {
  const ctx = makeCtx(bulkTx(10, 'ac_cash', '2026-01-01T00:00:00'));
  const first = asst.respond('午饭35', {}, ctx);
  checkEq(first.reply.plan.items[0].accountId, 'ac_cash', '首次默认');
  ctx.db.transactions.push({
    id: 'tx_after', bookId: 'bk_main', type: 'expense', amountCents: 100,
    categoryId: 'ca_food', accountId: 'ac_wechat', date: '2026-11-13',
    createdAt: '2026-11-13T12:00:00', deleted: false, note: ''
  });
  const second = asst.respond('晚饭30', {}, ctx);
  checkEq(second.reply.plan.items[0].accountId, 'ac_wechat', '写入后应跟最新账户');
});

regCase('2.4 空库回落第一个有效账户', function () {
  const out = asst.respond('午饭35', {}, makeCtx());
  checkEq(out.reply.plan.items[0].accountId, 'ac_cash', '空库默认');
});

/* ============================== 用例 3：双词表统一 ============================== */

section('用例 3：词表单一事实源（nl 权威 ∪ EXTRA 兜底，2.38.0）');

regCase('3.1 nl.categoryAliases 对外暴露，ca_transport 含「油费」', function () {
  check(nl.categoryAliases && typeof nl.categoryAliases === 'object', '应暴露词表');
  check(nl.categoryAliases.ca_transport.indexOf('油费') >= 0, '油费应在 nl 权威表');
});

regCase('3.2 「油费200」两条路径都归交通（此前 nl 主路径落其他）', function () {
  const out = asst.respond('油费200', {}, makeCtx());
  checkEq(out.reply.plan.items[0].categoryId, 'ca_transport', 'respond 路径');
  const r = nl.parse('油费200', makeCtx());
  check(r && r.ok && r.best, 'nl.parse 应成功');
  checkEq(r.best.categoryId, 'ca_transport', 'nl.parse 路径');
});

regCase('3.3 「购物50」归购物', function () {
  const out = asst.respond('购物50', {}, makeCtx());
  checkEq(out.reply.plan.items[0].categoryId, 'ca_shopping', '购物');
});

regCase('3.4 「奖金1000」归 ca_bonus（EXTRA 与 nl 的语义冲突已消除）', function () {
  const out = asst.respond('奖金1000', {}, makeCtx());
  checkEq(out.reply.plan.items[0].type, 'income', '收入');
  checkEq(out.reply.plan.items[0].categoryId, 'ca_bonus', '奖金归额外收入');
});

regCase('3.5 nl 独有词（机票/KTV）经并集在 resolveCategory 也能命中', function () {
  const ctx = makeCtx();
  checkEq(asst.resolveCategory('机票300', 'expense', ctx).id, 'ca_transport', '机票');
  checkEq(asst.resolveCategory('KTV消费100', 'expense', ctx).id, 'ca_fun', 'KTV');
});

regCase('3.6 漂移守卫：EXTRA 与 nl 同词不得指向不同分类', function () {
  const literal = liftLiteral(CORE_JS, 'EXTRA_ALIASES');
  check(literal, 'EXTRA_ALIASES 提取失败');
  const extra = vm.runInContext('(' + literal + ')', sandbox);
  const base = nl.categoryAliases;
  const conflicts = [];
  for (const id of Object.keys(extra)) {
    for (const word of extra[id]) {
      for (const otherId of Object.keys(base)) {
        if (otherId !== id && base[otherId].indexOf(word) >= 0) {
          conflicts.push(word + ': EXTRA→' + id + ' / nl→' + otherId);
        }
      }
    }
  }
  checkEq(conflicts.length, 0, '词表冲突：' + conflicts.join('；'));
});

/* ============================== 用例 4：传输层错误细分 ============================== */

section('用例 4：非 2xx 读响应体细分归因 + detail 掩码（2.38.0）');

const CHAT_MSGS = [{ role: 'user', content: 'hi' }];

regCase('4.1 404 + 错误体 → reason=endpoint，detail 带服务端原话', async function () {
  seedCompleteConfig();
  const res = await withFetch(function () {
    return Promise.resolve({ status: 404, text: function () { return Promise.resolve('{"error":{"message":"unknown path"}}'); } });
  }, function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(res.code, 'E_AS_NET_CONFIG', '码仍归配置桶');
  checkEq(res.reason, 'endpoint', 'reason 细分');
  check(String(res.detail || '').indexOf('unknown path') >= 0, 'detail 应含服务端消息');
});

regCase('4.2 404 无 text()（旧桩/端点）不崩溃，仍归 endpoint', async function () {
  seedCompleteConfig();
  const res = await withFetch(function () { return Promise.resolve({ status: 404 }); },
    function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(res.reason, 'endpoint', 'reason');
  checkEq(res.detail || '', '', '读不到体就没有 detail');
});

regCase('4.3 400 模型不存在 → 剥字段重试一次后归 reason=model', async function () {
  seedCompleteConfig();
  let calls = 0;
  const res = await withFetch(function () {
    calls += 1;
    return Promise.resolve({ status: 400, text: function () { return Promise.resolve('{"error":{"message":"The model `gpt-x` does not exist"}}'); } });
  }, function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(calls, 2, '恰好剥字段重试一次');
  checkEq(res.reason, 'model', 'reason 细分到模型名');
});

regCase('4.4 401 → auth 回归', async function () {
  seedCompleteConfig();
  const res = await withFetch(function () { return Promise.resolve({ status: 401 }); },
    function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(res.reason, 'auth', 'reason');
});

regCase('4.5 错误体回显密钥：detail 必须掩码（R-01）', async function () {
  seedCompleteConfig();
  const res = await withFetch(function () {
    return Promise.resolve({ status: 403, text: function () { return Promise.resolve('{"error":{"message":"bad key ' + KEY_SENTINEL + ' provided"}}'); } });
  }, function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(res.reason, 'auth', 'reason');
  check(String(res.detail || '').indexOf(KEY_SENTINEL) < 0, 'detail 不得含明文密钥');
  check(String(res.detail || '').indexOf('••••') >= 0, '应掩码');
});

regCase('4.6 detail 限长 120 字（+省略号）', async function () {
  seedCompleteConfig();
  const long = 'x'.repeat(300);
  const res = await withFetch(function () {
    return Promise.resolve({ status: 400, text: function () { return Promise.resolve('{"error":{"message":"' + long + '"}}'); } });
  }, function () { return llm.chat(CHAT_MSGS, {}); });
  check(String(res.detail || '').length <= 121, 'detail 应截断');
});

regCase('4.7 429 → rate 可重试回归', async function () {
  seedCompleteConfig();
  const res = await withFetch(function () { return Promise.resolve({ status: 429 }); },
    function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(res.reason, 'rate', 'reason');
  checkEq(res.retryable, true, '可重试');
});

regCase('4.8 200 非 JSON → E_AS_NET_BAD 回归', async function () {
  seedCompleteConfig();
  const res = await withFetch(function () {
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('这不是 JSON'); } });
  }, function () { return llm.chat(CHAT_MSGS, {}); });
  checkEq(res.code, 'E_AS_NET_BAD', '码');
});

/* ============================== 用例 5：词表裁剪与排序 ============================== */

section('用例 5：fitBody 精确裁剪 + categoryPairs 使用频度（2.38.0）');

regCase('5.1 categoryPairs 带 usage：用户分类按使用频度降序，system 仍全保底', function () {
  const mini = { Object, Array, Number, String, Math, JSON, console };
  vm.createContext(mini);
  const mMaxCat = /var LLM_MAX_CATEGORIES = (\d+)/.exec(CORE_JS);
  const mNameMax = /var LLM_NAME_MAX = (\d+)/.exec(CORE_JS);
  check(mMaxCat && mNameMax, '常量提取');
  vm.runInContext('var LLM_MAX_CATEGORIES = ' + mMaxCat[1] + '; var LLM_NAME_MAX = ' + mNameMax[1] + ';', mini);
  vm.runInContext(liftFunction(CORE_JS, 'short'), mini, { filename: 'lift:short' });
  vm.runInContext(liftFunction(CORE_JS, 'categoryPairs'), mini, { filename: 'lift:categoryPairs' });
  const cats = [];
  for (let i = 0; i < 55; i += 1) { cats.push({ id: 'ca_sys' + i, name: '系统' + i, kind: 'expense', system: true, sort: 10 + i * 10 }); }
  for (let u = 0; u < 10; u += 1) { cats.push({ id: 'ca_user' + u, name: '自定义' + u, kind: 'expense', system: false, sort: 900 + u * 10 }); }
  const usage = { ca_user9: 50, ca_user8: 40, ca_user7: 30 };
  const out = mini.categoryPairs(cats, usage);
  checkEq(out.length, mMaxCat[1] | 0, '受上限约束');
  const ids = out.map(function (x) { return x.id; });
  for (let i = 0; i < 55; i += 1) { check(ids.indexOf('ca_sys' + i) >= 0, 'system 保底 ca_sys' + i); }
  const users = ids.filter(function (id) { return id.indexOf('ca_user') === 0; });
  checkEq(users.length, 5, '用户分类补 5 个');
  checkEq(users[0], 'ca_user9', '使用最多的排最前');
  checkEq(users[1], 'ca_user8', '使用次多的第二');
  checkEq(users[2], 'ca_user7', '第三');
  /* 无 usage 时维持旧口径（sort 升序）——12.3 回归 */
  const plain = mini.categoryPairs(cats);
  const plainUsers = plain.map(function (x) { return x.id; }).filter(function (id) { return id.indexOf('ca_user') === 0; });
  checkEq(plainUsers[0], 'ca_user0', '无 usage 按 sort 升序');
});

regCase('5.2 fitBody 超 4KB 精确裁剪：只丢超出的尾部，不再对半砍到 30', async function () {
  seedCompleteConfig();
  let captured = '';
  const cats = [];
  for (let i = 0; i < 60; i += 1) {
    cats.push({ id: 'ca_x' + i, name: '自定义分类名称加长版' + i, kind: 'expense' });
  }
  const payload = {
    raw: '午饭35', today: '2026-11-13', bookId: 'bk_main',
    accounts: [{ id: 'ac_cash', name: '现金' }],
    categories: cats
  };
  await withFetch(function (url, options) {
    captured = String(options.body);
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"choices":[{"message":{"content":"{}"}}]}'); } });
  }, function () { return llm.plan(payload); });
  check(captured, '应发出请求');
  check(Buffer.byteLength(captured, 'utf8') <= 4096, '请求体 ≤4KB');
  const body = JSON.parse(captured);
  const sysText = body.messages[0].content;
  const lines = sysText.match(/^ca_x\d+ /gm) || [];
  check(lines.length > 30, '精确裁剪应保留远多于对半砍的 30 条，实际 ' + lines.length);
  check(lines.length <= 60, '不超上限');
  /* 被裁的应是尾部（低频）：保留的 id 序号连续从 0 开始 */
  check(sysText.indexOf('ca_x0 ') >= 0, '头部词表保留');
});

/* ============================== 用例 6：既有行为回归 ============================== */

section('用例 6：既有行为回归');

regCase('6.1 「烟14.09」本地解析回归', function () {
  const out = asst.respond('烟14.09', {}, makeCtx());
  checkEq(out.reply.kind, 'preview', '预览');
  checkEq(out.reply.plan.items[0].amountCents, 1409, '金额');
  checkEq(out.reply.plan.items[0].categoryId, 'ca_smoke', '分类');
});

regCase('6.2 「转账500」不问账户、自动补不同账户回归', function () {
  const out = asst.respond('转账500', {}, makeCtx());
  checkEq(out.reply.kind, 'preview', '预览');
  const item = out.reply.plan.items[0];
  checkEq(item.type, 'transfer', '类型');
  check(item.accountId && item.toAccountId && item.accountId !== item.toAccountId, '两个不同账户');
});

regCase('6.3 「这个月花了多少」查询路由回归（detectIntent 单遍解析）', function () {
  const out = asst.respond('这个月花了多少', {}, makeCtx());
  checkEq(out.reply.kind, 'query', '查询');
});

regCase('6.4 「午饭28打车15」批内重复检测仍生效（同句两笔不同分类不误报）', function () {
  const out = asst.respond('午饭28打车15', {}, makeCtx());
  const items = out.reply.plan.items;
  check(!items[0].dupOf && !items[1].dupOf, '空库不应有相似标记');
});

/* ============================== 用例 7：界面文案（源码级） ============================== */

section('用例 7：回落文案细分（assistant.js）');

regCase('7.1 REASON_TEXT 新增 endpoint/model，config 文案不再谎报「未启用」', function () {
  check(ASSISTANT_JS.indexOf("endpoint: '接口地址或路径不对，已改用本地解析'") >= 0, 'endpoint 文案');
  check(ASSISTANT_JS.indexOf("model: '模型名可能不对，已改用本地解析'") >= 0, 'model 文案');
  check(ASSISTANT_JS.indexOf("config: '联网配置不完整（地址/模型/密钥），当前用本地解析'") >= 0, 'config 文案');
});

regCase('7.2 回落气泡挂 detail（core 已掩码），超长截断', function () {
  check(ASSISTANT_JS.indexOf('turn.detail') >= 0, '应渲染 detail');
  check(ASSISTANT_JS.indexOf('detailText.slice(0, 60)') >= 0, 'detail 上屏限长');
});

/* ============================== 主流程 ============================== */

(async function main() {
  let lastSection = '';
  for (const [sec, name, fn] of CASES) {
    if (sec !== lastSection) { console.log('\n===== ' + sec + ' ====='); lastSection = sec; }
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
  console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
  process.exit(failCount ? 1 : 0);
}());