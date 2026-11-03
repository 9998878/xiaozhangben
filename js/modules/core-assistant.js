/* ============================================================================
   小账本 2.0 · js/core/assistant.js · owner: 助手（T-AS）
   文件：src/js/core/assistant.js
   挂载：window.XZB.core.assistant（Node 下可 require，便于无浏览器单测）
   依赖（全部懒取，缺失即降级）：XZB.core.nl / dates / money / schema / stats

   职责：本地记账助手的「大脑」——意图识别、多笔分句、字段解析、补问、
         预览、目标定位（改/删）、只读查询、未提交草稿。**不碰 DOM、不碰存储**。

   硬规则（来自实施规格，逐条可测）：
   1. 全离线：不发起任何网络请求；意图不确定时追问，不猜着执行。
   2. 解析失败不得跳到写入；确认前调用方不得改库（本文件只产出 plan）。
   3. 金额一律正整数分；不做算术表达式求值。
   4. 单批最多 20 笔，超限报 E_AS_BATCH_TOO_LARGE，**不静默截断**。
   5. 分类未识别 → 支出 ca_other_expense / 收入 ca_other_income，并在预览标「默认」。
   6. 转账必须两个不同有效账户、categoryId=null、不计收支；缺转入账户必须追问。
   7. 日期只用 core.dates；缺省今天；月日缺年取当前年；非法日期追问，不静默改成今天。
   8. 预分配 id（tx_…），重试复用；写入前按 id 对账。
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var core = XZB.core || (XZB.core = XZB.Core = XZB.Core || XZB.core || {});

  /* ============================== 常量 ============================== */

  var MAX_BATCH = 20;
  var MAX_NOTE = 80;
  var MAX_TARGETS = 5;
  var MAX_ROWS = 20;
  var DRAFT_KEY = 'assistant.draft.v1';
  var DRAFT_TTL_MS = 24 * 3600 * 1000;

  /* 联网：DECISIONS R-04 —— 软 5s（界面提示）/ 硬 6s（AbortController 兜底）/ 总预算 8s / 重试 0 次 */
  var AI_KEY = 'xzb.ai.v1';
  var AI_VERSION = 1;
  var AI_MAX_BYTES = 4096;
  var AI_MAX_URL = 300;
  var AI_MAX_MODEL = 100;
  var AI_MAX_KEY = 300;
  var LLM_TIMEOUT_MS = 6000;
  var LLM_SOFT_MS = 5000;
  var LLM_BUDGET_MS = 8000;
  var LLM_RETRY = 0;
  var LLM_BACKOFF_MS = 600;
  var LLM_RETRY_AFTER_CAP = 1500;
  var LLM_MAX_RAW = 512;
  var LLM_MAX_BODY = 4096;
  var LLM_MAX_TOKENS = 800;
  var LLM_MAX_ACCOUNTS = 12;
  var LLM_MAX_CATEGORIES = 60;
  var LLM_NAME_MAX = 24;
  var LLM_MAX_CENTS = 999999999999;

  var E = {
    NO_AMOUNT: 'E_AS_NO_AMOUNT',
    AMBIGUOUS_ACCOUNT: 'E_AS_AMBIGUOUS_ACCOUNT',
    AMBIGUOUS_CATEGORY: 'E_AS_AMBIGUOUS_CATEGORY',
    TRANSFER_NEED_TO: 'E_AS_TRANSFER_NEED_TO',
    BATCH_TOO_LARGE: 'E_AS_BATCH_TOO_LARGE',
    DUP: 'E_AS_DUP',
    STALE: 'E_AS_STALE',
    TARGET_MISSING: 'E_AS_TARGET_MISSING',
    TARGET_MULTI: 'E_AS_TARGET_MULTI',
    CONFLICT_ID: 'E_AS_CONFLICT_ID',
    READONLY_STORAGE: 'E_AS_READONLY_STORAGE',
    INVALID: 'E_AS_INVALID',
    DATE_INVALID: 'E_AS_DATE',
    UNKNOWN: 'E_AS_UNKNOWN',
    /* 联网（DESIGN §0.8 / §2.3）：新增码只增不改，既有 15 个码名与文案保持原样 */
    NOT_CONFIGURED: 'E_AS_NOT_CONFIGURED',
    AI_DISABLED: 'E_AS_AI_DISABLED',
    NET_CONFIG: 'E_AS_NET_CONFIG',
    NET_TIMEOUT: 'E_AS_NET_TIMEOUT',
    NET_RATE: 'E_AS_NET_RATE',
    NET_BAD: 'E_AS_NET_BAD'
  };

  var M = {
    E_AS_NO_AMOUNT: '没听清金额，补一个数字就行（例如「午饭 35」）',
    E_AS_AMBIGUOUS_ACCOUNT: '有多个账户对得上，选一个',
    E_AS_AMBIGUOUS_CATEGORY: '有多个分类对得上，选一个',
    E_AS_TRANSFER_NEED_TO: '转账要说明转到哪个账户（例如「从微信转 500 到支付宝」）',
    E_AS_BATCH_TOO_LARGE: '一次最多记 20 笔，请分两次发给我',
    E_AS_DUP: '发现相似的账，确认还要记吗',
    E_AS_STALE: '这笔账刚刚被改过，请重新发起这次操作',
    E_AS_TARGET_MISSING: '没找到对应的账目，说清楚一点（日期/金额/分类）',
    E_AS_TARGET_MULTI: '有多笔都对得上，选一笔',
    E_AS_CONFLICT_ID: '这笔账已经存在且内容不同，已停止写入',
    E_AS_READONLY_STORAGE: '当前是临时存储模式，助手暂不写入，可先导出备份',
    E_AS_INVALID: '有字段不通过校验，已整批中止',
    E_AS_DATE: '日期对不上，说清楚是哪天',
    E_AS_UNKNOWN: '这句我还听不懂，换个说法或点下面的快捷入口',
    E_AS_NOT_CONFIGURED: '还没配置联网模型，当前是本地模式',
    E_AS_AI_DISABLED: '联网已关闭，当前是本地模式',
    E_AS_NET_CONFIG: '联网配置不完整或不合法（检查地址/模型/密钥）',
    E_AS_NET_TIMEOUT: '联网超时，已用本地模式继续',
    E_AS_NET_RATE: '模型太忙（限流），已用本地模式继续',
    E_AS_NET_BAD: '模型返回的内容看不懂，已用本地模式继续'
  };

  var TYPE_TEXT = { expense: '支出', income: '收入', transfer: '转账' };
  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  var SPLIT_RE = /[，,；;、\n]+/;
  var BRIDGE_RE = /(?:^|\s)(?:然后|还有|另外|再记一笔|再加上|以及)\s*/;

  /* ============================== 依赖 ============================== */

  function dep(name) {
    return core[name] || null;
  }

  function datesApi() { return dep('dates'); }
  function moneyApi() { return dep('money'); }
  function nlApi() { return dep('nl'); }
  function schemaApi() { return dep('schema'); }

  function nowIso() {
    var api = datesApi();
    if (api && typeof api.nowIso === 'function') { return api.nowIso(); }
    return new Date().toISOString();
  }

  function todayStr() {
    var api = datesApi();
    if (api && typeof api.todayStr === 'function') { return api.todayStr(); }
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function nowTime() {
    var api = datesApi();
    if (api && typeof api.nowTime === 'function') { return api.nowTime(); }
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function addDays(dateStr, delta) {
    var api = datesApi();
    if (api && typeof api.addDays === 'function') { return api.addDays(dateStr, delta); }
    var parts = String(dateStr).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    d.setDate(d.getDate() + delta);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isValidDate(value) {
    var api = datesApi();
    if (api && typeof api.isValidDateStr === 'function') { return api.isValidDateStr(value); }
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function formatCents(cents) {
    var api = moneyApi();
    if (api && typeof api.formatCents === 'function') { return api.formatCents(cents, { sign: false }); }
    return '¥' + ((Number(cents) || 0) / 100).toFixed(2);
  }

  function parseCents(text) {
    var nl = nlApi();
    var raw = String(text || '');
    if (nl && typeof nl.parseAmount === 'function') {
      var res = nl.parseAmount(raw);
      if (res && res.ok) { return res.cents; }
    }
    var money = moneyApi();
    if (money && typeof money.parseAmount === 'function') {
      var out = money.parseAmount(raw);
      if (out && out.ok) { return out.cents; }
      if (typeof out === 'number' && Number.isInteger(out)) { return out; }
    }
    var m = raw.replace(/[^\d.]/g, '');
    if (!m) { return null; }
    var yuan = Number(m);
    if (!isFinite(yuan) || yuan <= 0) { return null; }
    return Math.round(yuan * 100);
  }

  /* ============================== 文本 ============================== */

  function norm(text) {
    var s = String(text === undefined || text === null ? '' : text);
    if (s.normalize) { s = s.normalize('NFKC'); }
    return s.replace(/\s+/g, ' ').trim();
  }

  function short(str, limit) {
    var s = String(str || '');
    var cap = limit || MAX_NOTE;
    return s.length > cap ? s.slice(0, cap) : s;
  }

  function hash32(str) {
    var h = 0x811c9dc5;
    var s = String(str);
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /* ============================== 上下文 ============================== */

  /* 内部上下文：把屏幕传入的 {db, bookId, today, nowTime, settings, readonly} 整理成可用形状 */
  function contextOf(input) {
    var raw = input || {};
    var db = raw.db || {};
    var settings = raw.settings || db.settings || {};
    var books = Array.isArray(db.books) ? db.books : [];
    var bookId = raw.bookId || settings.activeBookId || '';
    var book = null;
    for (var i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].id === bookId) { book = books[i]; break; }
    }
    if (!book && books.length) { book = books[0]; bookId = book.id; }
    var accounts = Array.isArray(db.accounts) ? db.accounts : [];
    var categories = Array.isArray(db.categories) ? db.categories : [];
    return {
      db: db,
      bookId: bookId,
      book: book,
      today: isValidDate(raw.today) ? raw.today : todayStr(),
      nowTime: /^\d{2}:\d{2}$/.test(String(raw.nowTime || '')) ? raw.nowTime : nowTime(),
      settings: settings,
      readonly: raw.readonly === true,
      accounts: accounts,
      categories: categories,
      liveAccounts: accounts.filter(function (a) { return a && a.archived !== true; }),
      liveCategories: categories.filter(function (c) { return c && c.hidden !== true; })
    };
  }

  function accountById(cx, id) { return findIn(cx.accounts, id); }
  function categoryById(cx, id) { return findIn(cx.categories, id); }

  function findIn(list, id) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function accountName(cx, id) {
    var acct = accountById(cx, id);
    return acct ? String(acct.name || '账户') : '';
  }

  function categoryName(cx, id) {
    var cat = categoryById(cx, id);
    return cat ? String(cat.name || '分类') : '';
  }

  /* 最近使用账户：取最近 40 笔（按 createdAt 倒序）里出现过的第一个有效账户 */
  function recentAccountId(cx) {
    var list = (cx.db.transactions || []).slice(0, 400);
    var best = null;
    var bestAt = '';
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true || !tx.accountId) { continue; }
      if (!findIn(cx.liveAccounts, tx.accountId)) { continue; }
      var at = String(tx.createdAt || tx.updatedAt || tx.date || '');
      if (!best || at > bestAt) { best = tx.accountId; bestAt = at; }
    }
    return best;
  }

  function defaultAccountId(cx) {
    var fromSettings = cx.settings && cx.settings.defaultAccountId;
    if (fromSettings && findIn(cx.liveAccounts, fromSettings)) { return fromSettings; }
    var recent = recentAccountId(cx);
    if (recent) { return recent; }
    return cx.liveAccounts.length ? cx.liveAccounts[0].id : '';
  }

  function fallbackCategoryId(cx, type) {
    if (type === 'income') { return 'ca_other_income'; }
    return 'ca_other_expense';
  }

  /* ============================== 意图 ============================== */

  var INTENT_RULES = [
    { intent: 'undo', re: /^(撤销|撤回|回退|反悔|undo)/i },
    { intent: 'undo', re: /(把|将)?(刚才|刚刚|上一笔|上次|最后)(那|这)?笔?(的)?(账)?(撤销|撤回|删掉|恢复)/ },
    { intent: 'update', re: /(改成|改为|改到|修改|调成|换成|更正|改一下)/ },
    { intent: 'delete', re: /(删除|删掉|去掉|移除)(这|那|刚才|上一)?笔?/ },
    { intent: 'query', re: /(多少|几笔|几笔账|统计|汇总|合计|平均|查询|查一下|查一查|看看.*(账|花|支出|收入)|排行|占比)/ }
  ];

  function detectIntent(text) {
    var s = norm(text);
    if (!s) { return 'unknown'; }
    for (var i = 0; i < INTENT_RULES.length; i += 1) {
      if (INTENT_RULES[i].re.test(s)) { return INTENT_RULES[i].intent; }
    }
    var cents = parseCents(s);
    if (cents) { return 'create'; }
    return 'unknown';
  }

  /* ============================== 分句 ============================== */

  /* 只在该分句能独立表达一笔时才拆；小数、日期、时间、「从…转到…」内部的分隔符要保护 */
  function splitSegments(text) {
    var s = norm(text);
    if (!s) { return []; }

    var guards = [];
    function guard(pattern, label) {
      s = s.replace(pattern, function (match) {
        guards.push(match);
        return '\u0001' + (guards.length - 1) + '\u0002';
      });
    }
    /* 1) 小数 / 金额：12.5、12.50 元 */
    guard(/\d+\.\d+/g, 'decimal');
    /* 2) 日期与时间：8月1日、2026-08-01、12:30 */
    guard(/\d{4}-\d{2}-\d{2}/g, 'date');
    guard(/\d{1,2}月\d{1,2}[日号]/g, 'date');
    guard(/\d{1,2}[:：]\d{2}/g, 'time');
    /* 3) 从 A 转/转到 B：整段视为一笔 */
    guard(/从[^，。；;\n]{0,12}?(?:转|转到|转到账)[^，。；;\n]{0,16}/g, 'transfer');

    var parts = s.split(SPLIT_RE);
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var chunk = parts[i];
      var bridges = chunk.split(BRIDGE_RE);
      for (var b = 0; b < bridges.length; b += 1) {
        var piece = restore(bridges[b], guards).trim();
        if (!piece) { continue; }
        if (!/\d/.test(piece) && out.length) {
          /* 没有数字的碎片并入前一句（「午饭 35，地铁」→ 地铁没有金额，留在前句待补问） */
          out[out.length - 1] = out[out.length - 1] + '，' + piece;
        } else {
          out.push(piece);
        }
      }
    }
    return out;
  }

  function restore(text, guards) {
    return String(text).replace(/\u0001(\d+)\u0002/g, function (all, idx) {
      var v = guards[Number(idx)];
      return v === undefined ? all : v;
    });
  }

  /* ============================== 字段解析 ============================== */

  var TYPE_HINTS = {
    income: /(收入|工资|奖金|红包收|进账|到账|退款|报销到账|利息|分红|卖出|收到)/,
    expense: /(支出|花了|花费|消费|付了|买了|交|缴|充值)/,
    transfer: /(转账|转给|转到|还款|还信用卡|提现|转入|转出)/
  };

  function typeFromText(text) {
    var s = String(text || '');
    var hit = null;
    var order = ['transfer', 'income', 'expense'];
    for (var i = 0; i < order.length; i += 1) {
      if (TYPE_HINTS[order[i]].test(s)) {
        if (hit && hit !== order[i]) { return { type: hit, conflict: order[i] }; }
        hit = order[i];
      }
    }
    return { type: hit, conflict: null };
  }

  /* 分类：最长匹配（分类名 + aliases），再看 nl 的别名表（借 nl.parse 拿不到别名表，这里自带一份最小集合） */
  var EXTRA_ALIASES = {
    ca_food: ['吃饭', '午饭', '晚饭', '早饭', '外卖', '咖啡', '奶茶', '零食'],
    ca_transport: ['打车', '地铁', '公交', '高铁', '油费', '停车', '加油'],
    ca_shopping: ['购物', '网购', '买衣服', '超市'],
    ca_home: ['房租', '水电', '物业', '燃气', '宽带'],
    ca_fun: ['电影', '游戏', '演出', '会员', '旅游'],
    ca_health: ['看病', '买药', '体检'],
    ca_social: ['红包', '礼物', '随礼', '请客'],
    ca_salary: ['工资', '薪水', '奖金'],
    ca_daily: ['日用', '纸巾', '洗衣液'],
    ca_snack: ['奶茶', '甜品', '蛋糕'],
    ca_veg: ['买菜', '菜市场']
  };

  function resolveCategory(text, kind, cx) {
    var s = String(text || '');
    var best = null;
    var bestLen = 0;
    var i;
    function consider(cat, token) {
      var t = String(token || '').trim();
      if (!t) { return; }
      if (kind && cat.kind && cat.kind !== kind) { return; }
      if (s.indexOf(t) < 0) { return; }
      if (t.length > bestLen || (t.length === bestLen && best && cat.sort < best.sort)) {
        best = cat;
        bestLen = t.length;
      }
    }
    var cats = cx.liveCategories;
    for (i = 0; i < cats.length; i += 1) {
      var cat = cats[i];
      consider(cat, cat.name);
      var aliases = Array.isArray(cat.aliases) ? cat.aliases : [];
      for (var a = 0; a < aliases.length; a += 1) { consider(cat, aliases[a]); }
    }
    for (var key in EXTRA_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(EXTRA_ALIASES, key)) { continue; }
      var target = findIn(cx.categories, key);
      if (!target) { continue; }
      var list = EXTRA_ALIASES[key];
      for (i = 0; i < list.length; i += 1) { consider(target, list[i]); }
    }
    if (best) { return { ok: true, id: best.id, name: best.name, matched: bestLen }; }
    return { ok: false };
  }

  function resolveAccount(text, cx) {
    var s = String(text || '');
    var best = null;
    var bestLen = 0;
    for (var i = 0; i < cx.liveAccounts.length; i += 1) {
      var acct = cx.liveAccounts[i];
      var name = String(acct.name || '');
      if (!name) { continue; }
      if (s.indexOf(name) < 0) { continue; }
      if (name.length > bestLen) { best = acct; bestLen = name.length; }
    }
    if (best) { return { ok: true, id: best.id, name: best.name }; }
    var typeHints = [
      { re: /微信/, type: 'wechat' },
      { re: /支付宝/, type: 'alipay' },
      { re: /信用卡/, type: 'credit' },
      { re: /现金/, type: 'cash' },
      { re: /银行卡|借记卡/, type: 'debit' },
      { re: /储蓄/, type: 'savings' }
    ];
    for (var h = 0; h < typeHints.length; h += 1) {
      if (typeHints[h].re.test(s)) {
        var hits = cx.liveAccounts.filter(function (a) { return a.type === typeHints[h].type; });
        if (hits.length === 1) { return { ok: true, id: hits[0].id, name: hits[0].name }; }
        if (hits.length > 1) { return { ok: false, code: E.AMBIGUOUS_ACCOUNT, options: hits }; }
      }
    }
    return { ok: false };
  }

  function resolveBook(text, cx) {
    var s = String(text || '');
    var books = Array.isArray(cx.db.books) ? cx.db.books : [];
    for (var i = 0; i < books.length; i += 1) {
      var book = books[i];
      if (book && book.name && s.indexOf(String(book.name)) >= 0) {
        return { ok: true, id: book.id, name: book.name };
      }
    }
    return { ok: false, id: cx.bookId };
  }

  /* 查询用日期范围 */
  function resolveRange(text, cx) {
    var s = String(text || '');
    var today = cx.today;
    if (/今天|今日/.test(s)) { return { key: 'today', from: today, to: today, label: '今天' }; }
    if (/昨天|昨日/.test(s)) { var y = addDays(today, -1); return { key: 'yesterday', from: y, to: y, label: '昨天' }; }
    if (/前天/.test(s)) { var q = addDays(today, -2); return { key: 'before', from: q, to: q, label: '前天' }; }
    if (/本周|这周|这星期/.test(s)) { return weekRange(cx, 0); }
    if (/上周|上个星期|上星期/.test(s)) { return weekRange(cx, -1); }
    if (/上个月|上月/.test(s)) { return monthRangeOf(cx, -1); }
    if (/这个月|本月|这月/.test(s)) { return monthRangeOf(cx, 0); }
    if (/今年|本年/.test(s)) {
      var y0 = today.slice(0, 4);
      return { key: 'year', from: y0 + '-01-01', to: today.slice(0, 4) + '-12-31', label: y0 + ' 年' };
    }
    if (/去年/.test(s)) {
      var y1 = String(Number(today.slice(0, 4)) - 1);
      return { key: 'lyear', from: y1 + '-01-01', to: y1 + '-12-31', label: y1 + ' 年' };
    }
    if (/近\s*7\s*天|最近一周|近一周/.test(s)) { return { key: '7d', from: addDays(today, -6), to: today, label: '近 7 天' }; }
    if (/近\s*30\s*天|最近一个月|近一月/.test(s)) { return { key: '30d', from: addDays(today, -29), to: today, label: '近 30 天' }; }

    /* 2026年8月 / 2026-08 / 8月 */
    var ymd = s.match(/(\d{4})[-年/](\d{1,2})(?:[-月/](\d{1,2})[日号]?)?/);
    if (ymd) {
      var y = Number(ymd[1]);
      var m = Number(ymd[2]);
      if (ymd[3]) {
        var day = Number(ymd[3]);
        var str = y + '-' + pad(m) + '-' + pad(day);
        return { key: 'day', from: str, to: str, label: str.slice(5).replace('-', '月') + '日' };
      }
      return monthBlock(y, m);
    }
    var md = s.match(/(\d{1,2})月(?:份)?(?:\s*(\d{1,2})[日号])?/);
    if (md) {
      var mm = Number(md[1]);
      if (mm >= 1 && mm <= 12) {
        if (md[2]) {
          var dd = Number(md[2]);
          var full = today.slice(0, 4) + '-' + pad(mm) + '-' + pad(dd);
          return { key: 'day', from: full, to: full, label: pad(mm) + '月' + pad(dd) + '日' };
        }
        return monthBlock(Number(today.slice(0, 4)), mm);
      }
    }
    return monthRangeOf(cx, 0);
  }

  function monthBlock(year, month) {
    var from = year + '-' + pad(month) + '-01';
    var end = new Date(year, month, 0);
    var to = year + '-' + pad(month) + '-' + pad(end.getDate());
    return { key: 'month', from: from, to: to, label: year + ' 年 ' + month + ' 月', month: year + '-' + pad(month) };
  }

  function monthRangeOf(cx, offset) {
    var base = cx.today.slice(0, 7).split('-');
    var d = new Date(Number(base[0]), Number(base[1]) - 1 + offset, 1);
    var year = d.getFullYear();
    var month = d.getMonth() + 1;
    var block = monthBlock(year, month);
    block.label = (offset === 0 ? '本月' : '上月') + '（' + year + ' 年 ' + month + ' 月）';
    block.key = offset === 0 ? 'thisMonth' : 'lastMonth';
    return block;
  }

  function weekRange(cx, offset) {
    var api = datesApi();
    var start;
    if (api && typeof api.startOfWeek === 'function') {
      start = api.startOfWeek(cx.today);
    } else {
      var parts = cx.today.split('-');
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      var dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      start = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    var from = offset === 0 ? start : addDays(start, 7 * offset);
    var to = addDays(from, 6);
    return { key: offset === 0 ? 'week' : 'lweek', from: from, to: to, label: (offset === 0 ? '本周' : '上周') + '（' + from.slice(5) + '–' + to.slice(5) + '）' };
  }

  /* ============================== 记账计划 ============================== */

  function fingerprint(text, cx, salt) {
    return 'ap_' + hash32(norm(text) + '|' + cx.today + '|' + cx.bookId + '|' + String(salt || ''));
  }

  function idFor(planId, index) {
    return 'tx_' + hash32(planId + '#' + index) + '_' + index.toString(36);
  }

  function dateLabel(cx, date) {
    if (!date) { return ''; }
    if (date === cx.today) { return '今天'; }
    if (date === addDays(cx.today, -1)) { return '昨天'; }
    if (date === addDays(cx.today, -2)) { return '前天'; }
    var parts = date.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var base = cx.today.split('-');
    var b = new Date(Number(base[0]), Number(base[1]) - 1, Number(base[2]));
    var diff = Math.round((d - b) / 86400000);
    if (diff > 0) { return parts[1] + '月' + parts[2] + '日（' + diff + ' 天后）'; }
    return parts[1] + '月' + parts[2] + '日（周' + WEEK_CN[d.getDay()] + '）';
  }

  function nlContext(cx, type) {
    return {
      today: cx.today,
      nowTime: cx.nowTime,
      accounts: cx.liveAccounts,
      categories: cx.liveCategories,
      activeBookId: cx.bookId,
      defaults: {
        type: type === 'income' ? 'income' : 'expense',
        accountId: defaultAccountId(cx),
        categoryId: cx.settings && type === 'income' ? cx.settings.defaultIncomeCategoryId : cx.settings && cx.settings.defaultExpenseCategoryId
      }
    };
  }

  /* 单句 → 一条 item（尽量复用 core.nl，失败时保留已识别字段） */
  function buildItem(segText, cx, planId, index) {
    var nl = nlApi();
    var hint = typeFromText(segText);
    var baseType = hint.type || 'expense';
    var item = {
      id: idFor(planId, index),
      index: index,
      raw: segText,
      type: baseType,
      amountCents: 0,
      accountId: '',
      toAccountId: '',
      categoryId: '',
      date: cx.today,
      time: cx.nowTime,
      note: '',
      tags: [],
      source: 'nl',
      defaulted: {},
      issues: [],
      matches: null,
      confidence: 0
    };

    var parsed = null;
    if (nl && typeof nl.parse === 'function') {
      try {
        parsed = nl.parse(segText, nlContext(cx, baseType));
      } catch (error) {
        parsed = null;
      }
    }

    if (parsed && parsed.ok && parsed.best) {
      var best = parsed.best;
      item.type = best.type || baseType;
      item.amountCents = Number(best.cents) || 0;
      item.date = best.date || cx.today;
      item.time = best.time || cx.nowTime;
      item.note = short(best.note || stripKnown(segText), MAX_NOTE);
      item.tags = Array.isArray(best.tags) ? best.tags.slice() : [];
      item.accountId = best.accountId || '';
      item.categoryId = best.categoryId || '';
      item.toAccountId = best.toAccountId || '';
      item.matches = best.matches || null;
      item.confidence = Number(best.confidence) || 0;
    } else {
      var partial = parsed && parsed.partial ? parsed.partial : null;
      if (partial) {
        item.type = partial.type || baseType;
        item.amountCents = Number(partial.cents || partial.amountCents) || 0;
        item.date = partial.date || cx.today;
        item.time = partial.time || cx.nowTime;
        item.note = short(partial.note || stripKnown(segText), MAX_NOTE);
        item.accountId = partial.accountId || '';
        item.categoryId = partial.categoryId || '';
      } else {
        item.amountCents = parseCents(segText) || 0;
        item.note = short(stripKnown(segText), MAX_NOTE);
      }
    }

    /* --- 金额 --- */
    if (!item.amountCents) {
      item.issues.push({ field: 'amount', code: E.NO_AMOUNT, message: M.E_AS_NO_AMOUNT });
    }

    /* --- 类型冲突 --- */
    if (hint.conflict) {
      item.issues.push({ field: 'type', code: E.UNKNOWN, message: '收支类型有冲突，选一个', options: ['expense', 'income'] });
    }

    /* --- 转账：转入账户必填、账户必须不同 --- */
    if (item.type === 'transfer') {
      item.categoryId = '';
      if (!item.toAccountId) {
        var toGuess = guessToAccount(segText, cx, item.accountId);
        if (toGuess) { item.toAccountId = toGuess; item.defaulted.toAccount = false; }
        else {
          item.issues.push({
            field: 'toAccountId', code: E.TRANSFER_NEED_TO, message: M.E_AS_TRANSFER_NEED_TO,
            options: cx.liveAccounts.filter(function (a) { return a.id !== item.accountId; }).map(function (a) { return { label: a.name, value: a.id }; }).slice(0, 5)
          });
        }
      }
      if (item.toAccountId && item.toAccountId === item.accountId) {
        item.issues.push({ field: 'toAccountId', code: E.TRANSFER_NEED_TO, message: '转出和转入是同一个账户，换一个' });
      }
    }

    /* --- 账户兜底 --- */
    if (!item.accountId) {
      item.accountId = defaultAccountId(cx);
      item.defaulted.account = true;
    }
    if (!findIn(cx.liveAccounts, item.accountId)) {
      item.issues.push({ field: 'accountId', code: E.AMBIGUOUS_ACCOUNT, message: '账户不可用（可能已归档），选一个' });
    }

    /* --- 分类兜底 / 类型对齐 --- */
    if (item.type !== 'transfer') {
      var kind = item.type === 'income' ? 'income' : 'expense';
      var cat = item.categoryId ? categoryById(cx, item.categoryId) : null;
      if (!cat || cat.kind !== kind) {
        var guessed = resolveCategory(segText, kind, cx);
        if (guessed.ok) {
          item.categoryId = guessed.id;
        } else {
          item.categoryId = fallbackCategoryId(cx, item.type);
          item.defaulted.category = true;
        }
      }
    }

    /* --- 日期 --- */
    if (!isValidDate(item.date)) {
      item.date = cx.today;
      item.issues.push({ field: 'date', code: E.DATE_INVALID, message: M.E_AS_DATE });
    }
    if (item.date > addDays(cx.today, 366) || item.date < '2000-01-01') {
      item.issues.push({ field: 'date', code: E.DATE_INVALID, message: '日期超出可记账范围' });
    }
    if (item.date > cx.today) {
      item.future = true;
    }

    /* --- 备注清理 --- */
    item.note = short(item.note, MAX_NOTE);
    if (!item.note) { item.note = short(stripKnown(segText), MAX_NOTE); }
    return item;
  }

  function guessToAccount(text, cx, fromId) {
    var m = String(text).match(/(?:到|至|给|进|转入)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})$/);
    var tail = m ? m[1] : '';
    if (tail) {
      var hit = null;
      for (var i = 0; i < cx.liveAccounts.length; i += 1) {
        var name = String(cx.liveAccounts[i].name || '');
        if (name && (tail.indexOf(name) >= 0 || name.indexOf(tail) >= 0) && cx.liveAccounts[i].id !== fromId) {
          hit = cx.liveAccounts[i].id;
          break;
        }
      }
      if (hit) { return hit; }
    }
    return '';
  }

  /* 去掉命令词/金额/账户连接词后的备注；保留原始消费语义（「午饭」而不是空） */
  function stripKnown(text) {
    var s = norm(text);
    s = s.replace(/^(请|帮我|帮忙|记一笔|记账|记一下|记录|添加|新增)\s*/g, '');
    s = s.replace(/(花了|花费|消费|付了|买了|收入|收到|支出|转账)/g, '');
    s = s.replace(/[¥￥]\s*\d+(?:\.\d+)?\s*(?:元|块|块钱|毛|角|分)?/g, '');
    s = s.replace(/\d+(?:\.\d+)?\s*(?:元|块钱|块|人民币|rmb)/gi, '');
    s = s.replace(/(从|用|在)\s*[\u4e00-\u9fa5]{2,6}(微信|支付宝|信用卡|现金|银行卡)/g, '');
    s = s.replace(/(今天|昨天|前天|上午|中午|下午|晚上|早上|上周[一二三四五六日天]?|本周[一二三四五六日天]?)/g, '');
    s = s.replace(/[,，。；;、\s]+/g, ' ').trim();
    return s;
  }

  /* ============================== 预览 ============================== */

  function previewRows(plan, cx) {
    var rows = [];
    var expense = 0;
    var income = 0;
    var transfer = 0;
    var warnings = [];
    var items = plan && plan.items ? plan.items : [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (!item.issues.length) {
        if (item.type === 'expense') { expense += item.amountCents; }
        if (item.type === 'income') { income += item.amountCents; }
      }
      if (item.type === 'transfer') { transfer += 1; }
      rows.push({
        index: i + 1,
        id: item.id,
        type: item.type,
        typeText: TYPE_TEXT[item.type] || '支出',
        amountCents: item.amountCents,
        amountText: formatCents(item.amountCents),
        categoryId: item.categoryId,
        categoryText: item.type === 'transfer' ? '—' : categoryName(cx, item.categoryId),
        accountText: accountName(cx, item.accountId) || '账户不可用',
        toAccountText: item.type === 'transfer' ? (accountName(cx, item.toAccountId) || '待选择') : '',
        dateText: dateLabel(cx, item.date),
        time: item.time,
        note: item.note,
        defaulted: item.defaulted,
        future: !!item.future,
        issues: item.issues.slice(),
        dup: !!item.dupOf
      });
      var j;
      for (j = 0; j < item.issues.length; j += 1) { warnings.push('第 ' + (i + 1) + ' 笔：' + item.issues[j].message); }
      if (item.dupOf) { warnings.push('第 ' + (i + 1) + ' 笔和已有账目很像，确认后再保存'); }
      if (item.future) { warnings.push('第 ' + (i + 1) + ' 笔是未来日期，请确认'); }
    }
    return {
      rows: rows,
      totals: {
        count: items.length,
        expenseCents: expense,
        incomeCents: income,
        netCents: income - expense,
        transferCount: transfer
      },
      warnings: dedupe(warnings),
      blocked: items.some(function (it) { return it.issues.length > 0; })
    };
  }

  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && out.indexOf(list[i]) < 0) { out.push(list[i]); }
    }
    return out;
  }

  /* ============================== 解析入口 ============================== */

  function parseCreate(text, cx) {
    var segments = splitSegments(text);
    if (!segments.length) {
      return { ok: false, code: E.UNKNOWN, message: M.E_AS_UNKNOWN };
    }
    if (segments.length > MAX_BATCH) {
      return { ok: false, code: E.BATCH_TOO_LARGE, message: M.E_AS_BATCH_TOO_LARGE };
    }
    var planId = fingerprint(text, cx, '');
    var plan = {
      id: planId,
      kind: 'create',
      bookId: cx.bookId,
      raw: norm(text),
      createdAt: nowIso(),
      forced: false,
      items: []
    };
    for (var i = 0; i < segments.length; i += 1) {
      plan.items.push(buildItem(segments[i], cx, planId, i));
    }
    markDuplicates(plan, cx);
    return { ok: true, plan: plan, segments: segments };
  }

  /* 相似账：同账本 + 同日期 + 同类型 + 同金额 + 同分类（严格口径，用户已确认） */
  function markDuplicates(plan, cx) {
    var list = (cx.db.transactions || []).filter(function (tx) { return tx && tx.deleted !== true; });
    for (var i = 0; i < plan.items.length; i += 1) {
      var item = plan.items[i];
      if (item.issues.length || !item.amountCents) { continue; }
      for (var j = 0; j < list.length; j += 1) {
        var tx = list[j];
        if (tx.bookId !== plan.bookId) { continue; }
        if (tx.type !== item.type) { continue; }
        if (tx.date !== item.date) { continue; }
        if (Number(tx.amountCents) !== item.amountCents) { continue; }
        if ((tx.categoryId || '') !== (item.categoryId || '')) { continue; }
        item.dupOf = tx.id;
        break;
      }
    }
  }

  /* ============================== 目标定位（改 / 删） ============================== */

  function findTargets(text, cx, state) {
    var s = norm(text);
    var recent = state && Array.isArray(state.recentIds) ? state.recentIds.slice() : [];
    var list = [];
    var i;
    var ids = [];

    /* 1) 明确点名的 id（内部使用：候选点选后回传 id） */
    var explicit = s.match(/tx_[a-z0-9_]+/i);
    if (explicit) {
      var one = findIn(cx.db.transactions || [], explicit[0]);
      if (one) { return { ok: true, matches: [one], exact: true }; }
    }
    /* 2) 最近引用的账目 */
    for (i = 0; i < recent.length; i += 1) {
      var hitRecent = findIn(cx.db.transactions || [], recent[i]);
      if (hitRecent && hitRecent.deleted !== true) { ids.push(hitRecent); }
    }
    /* 3) 条件筛选；「把 28 那笔改成 30」里改成后面的金额是新值，不是筛选条件 */
    var directive = String(s).replace(/(改成|改为|调成|换成|更正为|变成)\s*[^，,；;、\s]*$/, '');
    var cents = parseCents(directive === s ? s : directive);
    var kind = typeFromText(s).type;
    var range = /(今天|昨天|前天|本周|上周|本月|上个月|上月|今年|去年|\d+月)/.test(s) ? resolveRange(s, cx) : null;
    var cat = resolveCategory(s, kind || null, cx);
    var pool = (cx.db.transactions || []).filter(function (tx) {
      if (!tx || tx.deleted === true) { return false; }
      if (tx.bookId !== cx.bookId) { return false; }
      if (cents && Number(tx.amountCents) !== cents) { return false; }
      if (kind && tx.type !== kind) { return false; }
      if (range && (tx.date < range.from || tx.date > range.to)) { return false; }
      if (cat.ok && (tx.categoryId || '') !== cat.id) { return false; }
      return true;
    });

    if (!cents && !kind && !range && !cat.ok && ids.length) {
      return { ok: true, matches: ids.slice(0, MAX_TARGETS), exact: ids.length === 1 };
    }
    if (!cents && !kind && !range && !cat.ok) {
      /* 只有「刚才那笔」时直接用最近引用；没有引用就取今天最后一笔 */
      var todayList = (cx.db.transactions || []).filter(function (tx) {
        return tx && tx.deleted !== true && tx.bookId === cx.bookId && tx.date === cx.today;
      }).sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
      if (todayList.length) { return { ok: true, matches: [todayList[0]], exact: true }; }
      return { ok: false, code: E.TARGET_MISSING, message: M.E_AS_TARGET_MISSING };
    }
    pool.sort(function (a, b) {
      var da = String(a.date) + ' ' + String(a.time || '');
      var db2 = String(b.date) + ' ' + String(b.time || '');
      return db2.localeCompare(da);
    });
    if (!pool.length) { return { ok: false, code: E.TARGET_MISSING, message: M.E_AS_TARGET_MISSING }; }
    return { ok: true, matches: pool.slice(0, MAX_TARGETS), exact: pool.length === 1, more: pool.length > MAX_TARGETS };
  }

  function buildUpdatePlan(text, target, cx) {
    var s = norm(text);
    var planId = fingerprint('upd|' + target.id + '|' + s, cx, target.updatedAt || '');
    var replaceText = (String(s).match(/(?:改成|改为|调成|换成|更正为|变成)\s*([^，,；;、\s]+)/) || [])[1] || '';
    var cents = parseCents(replaceText) || parseCents(s);
    var cat = resolveCategory(s, target.type, cx);
    var acct = resolveAccount(s, cx);
    var range = /(今天|昨天|前天|本周|上周|本月|上个月|上月|今年|去年|\d+月|\d+日)/.test(s) ? resolveRange(s, cx) : null;
    var newType = typeFromText(s).type;
    var patch = {};
    var issues = [];
    if (cents && cents !== Number(target.amountCents)) { patch.amountCents = cents; }
    if (cat.ok && cat.id !== target.categoryId) { patch.categoryId = cat.id; }
    if (acct.ok && acct.id !== target.accountId) { patch.accountId = acct.id; }
    if (range && range.from === range.to && range.from !== target.date) { patch.date = range.from; }
    if (!patch.amountCents && !patch.categoryId && !patch.accountId && !patch.date) {
      /* 「把刚才那笔改成收入」：类型替换 */
      if (newType && newType !== target.type) {
        return {
          ok: true,
          plan: {
            id: planId,
            kind: 'update',
            bookId: target.bookId,
            raw: s,
            createdAt: nowIso(),
            forced: false,
            items: [],
            edit: { ids: [target.id], patch: {}, replaceType: newType, base: snapshotOf(target) }
          }
        };
      }
      issues.push({ field: 'patch', code: E.UNKNOWN, message: '没听出要改哪个字段（金额/分类/账户/日期）' });
    }
    var values = Object.assign({}, target, patch, { updatedAt: nowIso() });
    if (issues.length) {
      return { ok: false, code: E.UNKNOWN, message: issues[0].message, target: target };
    }
    return {
      ok: true,
      plan: {
        id: planId,
        kind: 'update',
        bookId: target.bookId,
        raw: s,
        createdAt: nowIso(),
        forced: false,
        items: [],
        edit: {
          ids: [target.id],
          patch: patch,
          base: snapshotOf(target),
          values: values,
          replaceType: (newType && newType !== target.type) ? newType : null
        }
      }
    };
  }

  function snapshotOf(tx) {
    return {
      id: tx.id, updatedAt: tx.updatedAt || '', amountCents: tx.amountCents,
      type: tx.type, categoryId: tx.categoryId, accountId: tx.accountId,
      toAccountId: tx.toAccountId, date: tx.date, time: tx.time, note: tx.note
    };
  }

  function buildDeletePlan(target, cx) {
    return {
      id: fingerprint('del|' + target.id, cx, target.updatedAt || ''),
      kind: 'delete',
      bookId: target.bookId,
      raw: target.id,
      createdAt: nowIso(),
      forced: false,
      items: [],
      edit: { ids: [target.id], base: snapshotOf(target) }
    };
  }

  /* ============================== 校验与写入 ============================== */

  function txOfItem(item, plan, cx) {
    var schema = schemaApi();
    var input = {
      id: item.id,
      bookId: plan.bookId,
      type: item.type,
      amountCents: item.amountCents,
      accountId: item.accountId,
      toAccountId: item.type === 'transfer' ? item.toAccountId : null,
      categoryId: item.type === 'transfer' ? null : item.categoryId,
      date: item.date,
      time: item.time,
      note: short(item.note, MAX_NOTE),
      tags: item.tags || [],
      photoIds: [],
      source: 'nl',
      reimburse: 'none'
    };
    if (schema && typeof schema.createTransaction === 'function') {
      return schema.createTransaction(input, nowIso());
    }
    return input;
  }

  function preflight(plan, cx) {
    var schema = schemaApi();
    var errors = [];
    var warnings = [];
    var items = plan && plan.items ? plan.items : [];
    var existing = [];
    var i;

    for (i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item.issues.length) {
        errors.push({ index: i, field: item.issues[0].field, code: item.issues[0].code, message: item.issues[0].message });
      }
    }
    if (plan.kind === 'update') {
      var target = findIn(cx.db.transactions || [], plan.edit.ids[0]);
      if (!target) { errors.push({ index: 0, field: 'id', code: E.STALE, message: M.E_AS_STALE }); }
      else if (plan.edit.base && plan.edit.base.updatedAt && target.updatedAt !== plan.edit.base.updatedAt) {
        errors.push({ index: 0, field: 'updatedAt', code: E.STALE, message: M.E_AS_STALE });
      }
    }
    if (plan.kind === 'update' && plan.edit && !errors.length) {
      var nextBase = findIn(cx.db.transactions || [], plan.edit.ids[0]);
      if (nextBase) {
        var next = Object.assign({}, nextBase, plan.edit.patch || {});
        var rt = plan.edit.replaceType;
        if (rt && rt !== nextBase.type) {
          next.type = rt;
          next.id = idFor(plan.id, 0);
          next.deleted = false;
          next.deletedAt = null;
          if (rt === 'transfer') { next.categoryId = null; }
          else {
            next.toAccountId = null;
            if (!next.categoryId) { next.categoryId = fallbackCategoryId(cx, rt); }
          }
        }
        if (schema && typeof schema.validateTransaction === 'function') {
          var vres = schema.validateTransaction(next, { today: cx.today });
          if (!vres.ok) {
            var vfirst = vres.errors && vres.errors[0];
            errors.push({
              index: 0,
              field: vfirst ? vfirst.field : 'id',
              code: (vfirst && vfirst.code) || E.INVALID,
              message: '修改后不合法：' + fieldText(vfirst && vfirst.field)
            });
          }
        }
      }
    }
    if (plan.kind === 'delete') {
      var del = findIn(cx.db.transactions || [], plan.edit.ids[0]);
      if (!del || del.deleted === true) { errors.push({ index: 0, field: 'id', code: E.TARGET_MISSING, message: M.E_AS_TARGET_MISSING }); }
      else if (plan.edit.base && plan.edit.base.updatedAt && del.updatedAt !== plan.edit.base.updatedAt) {
        errors.push({ index: 0, field: 'updatedAt', code: E.STALE, message: M.E_AS_STALE });
      }
    }

    if (plan.kind === 'create') {
      for (i = 0; i < items.length; i += 1) {
        if (items[i].issues.length) { continue; }
        var tx = txOfItem(items[i], plan, cx);
        if (schema && typeof schema.validateTransaction === 'function') {
          var check = schema.validateTransaction(tx, { today: cx.today });
          if (!check.ok) {
            var first = check.errors && check.errors[0];
            errors.push({
              index: i,
              field: first ? first.field : 'id',
              code: (first && first.code) || E.INVALID,
              message: '第 ' + (i + 1) + ' 笔：' + fieldText(first && first.field) + '不合法'
            });
            continue;
          }
        }
        var exist = findIn(cx.db.transactions || [], tx.id);
        if (exist) {
          if (sameTx(exist, tx)) { existing.push({ index: i, id: tx.id, same: true }); }
          else { errors.push({ index: i, field: 'id', code: E.CONFLICT_ID, message: M.E_AS_CONFLICT_ID }); }
        }
      }
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, existing: existing };
  }

  function fieldText(field) {
    var map = {
      id: '编号', bookId: '账本', type: '类型', amountCents: '金额', accountId: '账户',
      toAccountId: '转入账户', categoryId: '分类', date: '日期', time: '时间', note: '备注'
    };
    return map[field] || String(field || '字段');
  }

  function sameTx(a, b) {
    var keys = ['bookId', 'type', 'amountCents', 'accountId', 'toAccountId', 'categoryId', 'date', 'time', 'note'];
    for (var i = 0; i < keys.length; i += 1) {
      if (String(a[keys[i]] === null || a[keys[i]] === undefined ? '' : a[keys[i]]) !==
          String(b[keys[i]] === null || b[keys[i]] === undefined ? '' : b[keys[i]])) { return false; }
    }
    return a.deleted !== true;
  }

  /* applyPlan：在 app.commit 的整库克隆上同步执行；只改 transactions */
  function applyPlan(plan, working, cx) {
    var result = { ok: true, created: [], updated: [], deleted: [], skipped: [] };
    if (!working || !Array.isArray(working.transactions)) {
      return { ok: false, code: E.UNKNOWN, message: '数据结构不完整' };
    }
    if (plan.kind === 'create') {
      for (var i = 0; i < plan.items.length; i += 1) {
        var item = plan.items[i];
        if (item.issues.length) { continue; }
        var tx = txOfItem(item, plan, cx);
        var exist = findIn(working.transactions, tx.id);
        if (exist && sameTx(exist, tx)) { result.skipped.push(tx.id); continue; }
        working.transactions.push(tx);
        result.created.push(tx.id);
      }
      return result;
    }
    if (plan.kind === 'update') {
      var target = findIn(working.transactions, plan.edit.ids[0]);
      if (!target) { return { ok: false, code: E.STALE, message: M.E_AS_STALE }; }
      if (plan.edit.replaceType && plan.edit.replaceType !== target.type) {
        /* 类型替换：同一事务里软删旧账 + 新建账目 */
        var stamp = nowIso();
        target.deleted = true;
        target.deletedAt = stamp;
        target.updatedAt = stamp;
        result.deleted.push(target.id);
        var replaced = Object.assign({}, target, plan.edit.patch || {}, {
          id: idFor(plan.id, 0),
          type: plan.edit.replaceType,
          deleted: false,
          deletedAt: null,
          createdAt: stamp,
          updatedAt: stamp
        });
        if (replaced.type === 'transfer') {
          replaced.categoryId = null;
        } else {
          replaced.toAccountId = null;
          if (!replaced.categoryId) { replaced.categoryId = fallbackCategoryId(cx, replaced.type); }
        }
        working.transactions.push(replaced);
        result.created.push(replaced.id);
        return result;
      }
      var patch = plan.edit.patch || {};
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) { target[key] = patch[key]; }
      }
      target.updatedAt = nowIso();
      result.updated.push(target.id);
      return result;
    }
    if (plan.kind === 'delete') {
      var victim = findIn(working.transactions, plan.edit.ids[0]);
      if (!victim) { return { ok: false, code: E.STALE, message: M.E_AS_STALE }; }
      var at = nowIso();
      victim.deleted = true;
      victim.deletedAt = at;
      victim.updatedAt = at;
      result.deleted.push(victim.id);
      return result;
    }
    return { ok: false, code: E.UNKNOWN, message: '未知操作' };
  }

  /* ============================== 查询 ============================== */

  function parseQuery(text, cx, prev) {
    var s = norm(text);
    var filter = {
      bookId: cx.bookId,
      from: '',
      to: '',
      label: '',
      type: null,
      categoryId: '',
      accountId: '',
      keyword: '',
      minCents: 0,
      maxCents: 0
    };
    var range = resolveRange(s, cx);
    filter.from = range.from;
    filter.to = range.to;
    filter.label = range.label;
    filter.month = range.month || '';

    var kind = typeFromText(s).type;
    if (kind) { filter.type = kind; }

    var cat = resolveCategory(s, null, cx);
    if (cat.ok) { filter.categoryId = cat.id; }
    var acct = resolveAccount(s, cx);
    if (acct.ok) { filter.accountId = acct.id; }

    var quoted = s.match(/[「“"『]([^」”"』]{1,20})[」”"』]/);
    if (quoted) { filter.keyword = quoted[1]; }

    var ge = s.match(/(?:超过|大于|高于|至少|不少于|>=?)\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/);
    if (ge) { filter.minCents = Math.round(Number(ge[1]) * 100); }
    var le = s.match(/(?:不到|低于|少于|不超过|至多|<=?)\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/);
    if (le) { filter.maxCents = Math.round(Number(le[1]) * 100); }
    var between = s.match(/(\d+(?:\.\d+)?)\s*(?:元|块)?\s*(?:到|至|-|~)\s*(\d+(?:\.\d+)?)\s*(?:元|块)/);
    if (between) {
      filter.minCents = Math.round(Number(between[1]) * 100);
      filter.maxCents = Math.round(Number(between[2]) * 100);
    }

    /* 多轮：这句没说的维度沿用上一轮 */
    if (prev && prev.filter) {
      var prevFilter = prev.filter;
      if (!kind && !/(支出|收入|转账)/.test(s)) { filter.type = prevFilter.type || null; }
      if (!cat.ok) { filter.categoryId = prevFilter.categoryId || ''; }
      if (!acct.ok) { filter.accountId = prevFilter.accountId || ''; }
      if (!quoted) { filter.keyword = prevFilter.keyword || ''; }
      if (!ge && !le && !between) {
        filter.minCents = prevFilter.minCents || 0;
        filter.maxCents = prevFilter.maxCents || 0;
      }
      if (!/(今天|昨天|前天|本周|上周|本月|上个月|上月|今年|去年|近|月|年|日)/.test(s)) {
        filter.from = prevFilter.from;
        filter.to = prevFilter.to;
        filter.label = prevFilter.label;
        filter.month = prevFilter.month || '';
        filter.inheritedRange = true;
      }
    }

    return { ok: true, filter: filter };
  }

  function queryTotals(cx, filter) {
    var list = cx.db.transactions || [];
    var matched = [];
    var income = 0;
    var expense = 0;
    var transferCents = 0;
    var transferCount = 0;
    var i;
    for (i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (filter.bookId && tx.bookId !== filter.bookId) { continue; }
      if (tx.date < filter.from || tx.date > filter.to) { continue; }
      if (filter.type && tx.type !== filter.type) { continue; }
      if (filter.categoryId && (tx.categoryId || '') !== filter.categoryId) { continue; }
      if (filter.accountId && tx.accountId !== filter.accountId) { continue; }
      if (filter.minCents && Number(tx.amountCents) < filter.minCents) { continue; }
      if (filter.maxCents && Number(tx.amountCents) > filter.maxCents) { continue; }
      if (filter.keyword) {
        var hay = String(tx.note || '');
        if (hay.indexOf(filter.keyword) < 0) { continue; }
      }
      if (tx.type === 'transfer') {
        transferCount += 1;
        transferCents += Number(tx.amountCents) || 0;
        if (filter.type !== 'transfer') { continue; }
      }
      if (tx.type === 'income') { income += Number(tx.amountCents) || 0; }
      if (tx.type === 'expense') { expense += Number(tx.amountCents) || 0; }
      matched.push(tx);
    }
    matched.sort(function (a, b) {
      var da = String(a.date) + ' ' + String(a.time || '');
      var db2 = String(b.date) + ' ' + String(b.time || '');
      return db2.localeCompare(da);
    });
    var rows = matched.slice(0, MAX_ROWS).map(function (tx) {
      return {
        id: tx.id,
        date: tx.date,
        dateText: dateLabel(cx, tx.date),
        type: tx.type,
        typeText: TYPE_TEXT[tx.type] || '支出',
        amountCents: tx.amountCents,
        amountText: formatCents(tx.amountCents),
        categoryText: tx.type === 'transfer' ? '转账' : categoryName(cx, tx.categoryId),
        accountText: accountName(cx, tx.accountId),
        note: tx.note || ''
      };
    });
    return {
      filter: filter,
      incomeCents: income,
      expenseCents: expense,
      netCents: income - expense,
      transferCents: transferCents,
      transferCount: transferCount,
      count: matched.length,
      rows: rows,
      truncated: matched.length > rows.length
    };
  }

  function describeFilter(filter) {
    var parts = [filter.label || '本月'];
    if (filter.categoryId) { parts.push('分类 ' + filter.categoryId); }
    if (filter.type === 'transfer') { parts.push(TYPE_TEXT[filter.type]); }
    if (filter.accountId) { parts.push('账户 ' + filter.accountId); }
    if (filter.keyword) { parts.push('备注含「' + filter.keyword + '」'); }
    if (filter.minCents || filter.maxCents) {
      parts.push('金额 ' + (filter.minCents ? '≥' + formatCents(filter.minCents) : '') +
        (filter.maxCents ? (filter.minCents ? ' 且 ' : '') + '≤' + formatCents(filter.maxCents) : ''));
    }
    return parts.join(' · ');
  }

  /* 深链：只有明细屏能完整表达同一口径时才给（month / 单日 / 单分类） */
  function deepLink(filter) {
    if (!filter || !filter.from || !filter.to) { return null; }
    if (filter.accountId || filter.keyword || filter.minCents || filter.maxCents) { return null; }
    if (filter.type && filter.type !== 'expense') { return null; }
    if (filter.from.slice(0, 7) !== filter.to.slice(0, 7)) { return null; }
    var month = filter.from.slice(0, 7);
    var hash = '#/home?month=' + month;
    if (filter.from === filter.to) { hash += '&date=' + filter.from; }
    if (filter.categoryId) { hash += '&ca=' + encodeURIComponent(filter.categoryId); }
    return hash;
  }

  /* ============================== 草稿 ============================== */

  function prefsOf() {
    var app = XZB.app;
    return app && app.prefs ? app.prefs : null;
  }

  function draftLoad() {
    var prefs = prefsOf();
    if (!prefs || typeof prefs.get !== 'function') { return null; }
    var raw;
    try { raw = prefs.get(DRAFT_KEY, null); } catch (error) { return null; }
    if (!raw || typeof raw !== 'object' || !raw.plan) { return null; }
    if (Number(raw.at) && Date.now() - Number(raw.at) > DRAFT_TTL_MS) {
      draftClear();
      return null;
    }
    return raw;
  }

  function draftSave(plan, extra) {
    var prefs = prefsOf();
    if (!prefs || typeof prefs.set !== 'function' || !plan) { return { ok: false }; }
    try {
      prefs.set(DRAFT_KEY, {
        version: 1,
        at: Date.now(),
        raw: plan.raw,
        plan: plan,
        note: (extra && extra.note) || ''
      });
      return { ok: true };
    } catch (error) {
      return { ok: false };
    }
  }

  function draftClear() {
    var prefs = prefsOf();
    if (!prefs || typeof prefs.set !== 'function') { return { ok: false }; }
    try {
      prefs.set(DRAFT_KEY, null);
      return { ok: true };
    } catch (error) {
      return { ok: false };
    }
  }

  /* ============================== 对话控制器 ============================== */

  function initialPlanState() {
    return {
      draft: null,
      pending: null,
      lastQuery: null,
      recentIds: [],
      lastBoard: null
    };
  }

  function cloneState(state) {
    return Object.assign(initialPlanState(), state || {});
  }

  /* respond(text, state, cx) → { state, reply }；纯计算，不写库、不写 DOM。 */
  function respond(text, state, cx) {
    var next = cloneState(state);
    var input = norm(text);
    if (!input) {
      return { state: next, reply: { kind: 'hint', text: '说说这笔账，比如「午饭 35 微信」或「这个月餐饮花了多少」' } };
    }

    /* 1a) 「选一笔」待答（修改/删除的候选） */
    if (next.pending && next.pending.field === 'target') {
      var pickedTarget = answerTarget(input, next, cx);
      if (pickedTarget) { return pickedTarget; }
    }

    /* 1) 补问回答 */
    if (next.pending) {
      var answered = answerClarify(input, next, cx);
      if (answered) { return answered; }
    }

    var intent = detectIntent(input);

    /* 2) 待确认草稿 + 新指令 → 先问「继续编辑 / 放弃草稿」 */
    if (next.draft && intent !== 'undo') {
      var resumed = tryResume(input, next, cx);
      if (resumed) { return resumed; }
      return {
        state: next,
        reply: {
          kind: 'conflict',
          text: '上一批还没确认，要接着改，还是丢掉重新来？',
          options: [
            { label: '继续编辑上一批', value: 'keep' },
            { label: '放弃并重新解析', value: 'drop' }
          ]
        }
      };
    }

    if (intent === 'undo') { return handleUndo(input, next, cx); }
    if (intent === 'query') { return handleQuery(input, next, cx); }
    if (intent === 'update') { return handleUpdate(input, next, cx); }
    if (intent === 'delete') { return handleDelete(input, next, cx); }
    if (intent === 'create') { return handleCreate(input, next, cx); }

    /* 口语式放弃：「算了 / 不用了 / 不了 / 不要了」在没有草稿时也要有个像样的回应，
     * 否则会掉进「没听懂」的兜底提示里，显得助手很笨。 */
    if (/^(算了|不用了|不了|不要了|不记了|先不)/.test(input)) {
      next.draft = null;
      next.pending = null;
      draftClear();
      return {
        state: next,
        reply: { kind: 'hint', text: '好，这次先不记。想记账直接说「午饭 28 微信」就行。', options: [] }
      };
    }

    return {
      state: next,
      reply: {
        kind: 'hint',
        text: M.E_AS_UNKNOWN,
        options: [
          { label: '记一笔：午饭 35', value: 'create 午饭 35' },
          { label: '查一查：这个月餐饮花了多少', value: 'query 这个月餐饮花了多少' },
          { label: '撤销上一笔', value: 'undo' }
        ]
      }
    };
  }

  function tryResume(input, state, cx) {
    if (/^(继续|接着|再改|保留|不放弃)/.test(input)) {
      return {
        state: state,
        reply: previewReply(state.draft, cx, '接着改这一批')
      };
    }
    if (/^(放弃|丢掉|取消|重新|算了|不用了|不了|不要了)/.test(input)) {
      state.draft = null;
      state.pending = null;
      draftClear();
      return {
        state: state,
        reply: { kind: 'hint', text: '好，这批不记了。要记直接说一句就行。', options: [] }
      };
    }
    return null;
  }

  function handleCreate(input, state, cx) {
    var res = parseCreate(input, cx);
    if (!res.ok) {
      return {
        state: state,
        reply: { kind: 'clarify', text: res.message, code: res.code, options: [] }
      };
    }
    var plan = res.plan;
    var blocked = plan.items.filter(function (it) { return it.issues.length > 0; });
    if (blocked.length) {
      var pending = buildPending(plan, blocked[0], cx);
      state.draft = plan;
      state.pending = pending;
      draftSave(plan, { note: 'waiting-clarify' });
      return {
        state: state,
        reply: {
          kind: 'clarify',
          text: pending.question,
          code: pending.code,
          options: pending.options,
          preview: previewRows(plan, cx),
          planId: plan.id
        }
      };
    }
    state.draft = plan;
    state.pending = null;
    draftSave(plan, { note: 'waiting-confirm' });
    return { state: state, reply: previewReply(plan, cx, '') };
  }

  function previewReply(plan, cx, headline) {
    var view = previewRows(plan, cx);
    var dup = view.rows.some(function (row) { return row.dup; });
    var text = headline || (view.rows.length > 1 ? '我理解成 ' + view.rows.length + ' 笔，确认后一起写入' : '确认这笔就写入');
    if (view.blocked) { text = '还有信息没补齐，先看下面的提示'; }
    return {
      kind: 'preview',
      text: text,
      planId: plan.id,
      plan: plan,
      rows: view.rows,
      totals: view.totals,
      warnings: view.warnings,
      needDupConfirm: dup && !plan.forced,
      canConfirm: !view.blocked
    };
  }

  function buildPending(plan, item, cx) {
    var issue = item.issues[0];
    var options = issue.options || [];
    if (!options.length && issue.field === 'accountId') {
      options = cx.liveAccounts.slice(0, 5).map(function (a) { return { label: a.name, value: a.id }; });
    }
    if (!options.length && issue.field === 'categoryId') {
      var kind = item.type === 'income' ? 'income' : 'expense';
      options = cx.liveCategories.filter(function (c) { return c.kind === kind; })
        .slice(0, 5).map(function (c) { return { label: c.name, value: c.id }; });
    }
    return {
      code: issue.code,
      field: issue.field,
      itemIndex: item.index,
      planId: plan.id,
      question: issue.message,
      options: options
    };
  }

  function withTargetPending(state, matches, raw, intent) {
    state.pending = {
      code: E.TARGET_MULTI,
      field: 'target',
      intent: intent,
      raw: raw,
      question: intent === 'delete' ? '要删哪一笔？' : '要改哪一笔？',
      options: matches.map(function (tx) { return { label: briefTx(tx).label || tx.id, value: tx.id }; })
    };
    return state;
  }

  /* 用户从候选里挑了一笔：把原句（含「改成 30」这类新值）重新套到这笔账上 */
  function answerTarget(input, state, cx) {
    var pending = state.pending;
    var chosen = null;
    var i;
    for (i = 0; i < (pending.options || []).length; i += 1) {
      var opt = pending.options[i];
      if (opt && (input === String(opt.value) || input === String(opt.label))) { chosen = opt; break; }
    }
    var id = chosen ? chosen.value : ((String(input).match(/tx_[a-z0-9_]+/i) || [])[0] || '');
    if (!id && /^[1-9]$/.test(input)) {
      var nth = (pending.options || [])[Number(input) - 1];
      if (nth) { id = nth.value; }
    }
    if (!id) {
      /* 没点选：当作换了个说法，交回正常流程重解析 */
      state.pending = null;
      return null;
    }
    var target = findIn(cx.db.transactions || [], id);
    if (!target || target.deleted === true) {
      state.pending = null;
      return null;
    }
    state.pending = null;
    if (pending.intent === 'delete') {
      var delPlan = buildDeletePlan(target, cx);
      state.draft = delPlan;
      draftSave(delPlan, { note: 'waiting-confirm' });
      return { state: state, reply: previewEdit(delPlan, target, cx) };
    }
    var res = buildUpdatePlan(pending.raw || input, target, cx);
    if (!res.ok) {
      return { state: state, reply: { kind: 'clarify', text: res.message, code: res.code } };
    }
    state.draft = res.plan;
    draftSave(res.plan, { note: 'waiting-confirm' });
    return { state: state, reply: previewEdit(res.plan, target, cx) };
  }

  function answerClarify(input, state, cx) {
    var pending = state.pending;
    var plan = state.draft;
    if (!pending || !plan) { state.pending = null; return null; }
    var item = plan.items[pending.itemIndex];
    if (!item) { state.pending = null; return null; }

    /* 点选候选 */
    var chosen = null;
    for (var o = 0; o < pending.options.length; o += 1) {
      var opt = pending.options[o];
      if (opt && (input === String(opt.label) || input === String(opt.value))) { chosen = opt; break; }
    }

    if (pending.field === 'amount' || /^(金额|钱)/.test(input)) {
      var cents = parseCents(input);
      if (!cents) {
        return { state: state, reply: { kind: 'clarify', text: M.E_AS_NO_AMOUNT, code: E.NO_AMOUNT } };
      }
      item.amountCents = cents;
      item.issues = item.issues.filter(function (x) { return x.field !== 'amount'; });
      /* 「午饭 35」这种补答顺带把分类也认了；纯数字就只改金额 */
      var withCat = resolveCategory(input, item.type === 'income' ? 'income' : 'expense', cx);
      if (withCat.ok && !item.categoryId) { item.categoryId = withCat.id; item.defaulted.category = false; }
      if (!item.note) { item.note = short(stripKnown(input), MAX_NOTE); }
    } else if (pending.field === 'toAccountId') {
      var toId = chosen ? chosen.value : '';
      if (!toId) {
        var guessed = resolveAccount(input, cx);
        if (guessed.ok) { toId = guessed.id; }
      }
      if (!toId || toId === item.accountId) {
        return { state: state, reply: { kind: 'clarify', text: M.E_AS_TRANSFER_NEED_TO, code: E.TRANSFER_NEED_TO, options: pending.options } };
      }
      item.toAccountId = toId;
      item.issues = item.issues.filter(function (x) { return x.field !== 'toAccountId'; });
    } else if (pending.field === 'accountId' || pending.field === 'account') {
      var acct = chosen ? { ok: true, id: chosen.value } : resolveAccount(input, cx);
      if (!acct.ok) {
        return { state: state, reply: { kind: 'clarify', text: '没找到这个账户，选一个', code: E.AMBIGUOUS_ACCOUNT, options: pending.options } };
      }
      item.accountId = acct.id;
      item.defaulted.account = false;
      item.issues = item.issues.filter(function (x) { return x.field !== 'accountId'; });
    } else if (pending.field === 'categoryId' || pending.field === 'category') {
      var cat = chosen ? { ok: true, id: chosen.value } : resolveCategory(input, item.type === 'income' ? 'income' : 'expense', cx);
      if (!cat.ok) {
        return { state: state, reply: { kind: 'clarify', text: '没找到这个分类，选一个', code: E.AMBIGUOUS_CATEGORY, options: pending.options } };
      }
      item.categoryId = cat.id;
      item.defaulted.category = false;
      item.issues = item.issues.filter(function (x) { return x.field !== 'categoryId'; });
    } else if (pending.field === 'date') {
      var range = resolveRange(input, cx);
      if (range.from !== range.to) {
        return { state: state, reply: { kind: 'clarify', text: '说具体是哪天（例如「前天」）', code: E.DATE_INVALID } };
      }
      item.date = range.from;
      item.issues = item.issues.filter(function (x) { return x.field !== 'date'; });
    } else if (pending.field === 'type') {
      var type = /收入/.test(input) ? 'income' : (/转账/.test(input) ? 'transfer' : 'expense');
      item.type = type;
      item.issues = item.issues.filter(function (x) { return x.field !== 'type'; });
      item.categoryId = type === 'transfer' ? '' : fallbackCategoryId(cx, type);
    } else {
      /* 字段不吃这个回答：把它当成补充信息整体重解析 */
      state.pending = null;
      return handleCreate(plan.raw + '，' + input, state, cx);
    }

    var still = plan.items.filter(function (it) { return it.issues.length > 0; });
    if (still.length) {
      state.pending = buildPending(plan, still[0], cx);
      draftSave(plan, { note: 'waiting-clarify' });
      return {
        state: state,
        reply: { kind: 'clarify', text: state.pending.question, code: state.pending.code, options: state.pending.options, preview: previewRows(plan, cx) }
      };
    }
    markDuplicates(plan, cx);
    state.pending = null;
    draftSave(plan, { note: 'waiting-confirm' });
    return { state: state, reply: previewReply(plan, cx, '') };
  }

  function handleQuery(input, state, cx) {
    var res = parseQuery(input, cx, state.lastQuery);
    var totals = queryTotals(cx, res.filter);
    state.lastQuery = { filter: res.filter, text: input };
    state.recentIds = totals.rows.slice(0, 5).map(function (row) { return row.id; });
    var answer = buildQueryAnswer(totals, cx);
    return {
      state: state,
      reply: {
        kind: 'query',
        text: answer.text,
        filter: res.filter,
        filterText: analyzeFilterText(res.filter, cx),
        totals: totals,
        rows: totals.rows,
        link: deepLink(res.filter)
      }
    };
  }

  function analyzeFilterText(filter, cx) {
    var parts = [filter.label || '本月'];
    if (filter.categoryId) { parts.push(categoryName(cx, filter.categoryId)); }
    if (filter.type === 'transfer') { parts.push(TYPE_TEXT[filter.type]); }
    if (filter.accountId) { parts.push(accountName(cx, filter.accountId)); }
    if (filter.keyword) { parts.push('备注含「' + filter.keyword + '」'); }
    return parts.join(' · ');
  }

  function buildQueryAnswer(totals, cx) {
    var head = analyzeFilterText(totals.filter, cx);
    if (!totals.count) {
      return { text: head + '：没有匹配的账目。' };
    }
    var lines = [];
    if (totals.filter.type === 'transfer') {
      lines.push('转账 ' + totals.transferCount + ' 笔，共 ' + formatCents(totals.transferCents) + '（不计收支）');
    } else {
      if (totals.incomeCents) { lines.push('收入 ' + formatCents(totals.incomeCents)); }
      if (totals.expenseCents) { lines.push('支出 ' + formatCents(totals.expenseCents)); }
      if (!totals.filter.type && (totals.incomeCents || totals.expenseCents)) {
        lines.push('结余 ' + formatCents(Math.abs(totals.netCents)) + (totals.netCents < 0 ? '（超支）' : ''));
      }
      lines.push('共 ' + totals.count + ' 笔');
      if (totals.transferCount) { lines.push('另有转账 ' + totals.transferCount + ' 笔 ' + formatCents(totals.transferCents) + '，未计入收支'); }
    }
    return { text: head + '：' + lines.join('，') + '。' };
  }

  function handleUpdate(input, state, cx) {
    var found = findTargets(input, cx, state);
    if (!found.ok) {
      return { state: state, reply: { kind: 'clarify', text: found.message, code: found.code } };
    }
    if (!found.exact) {
      return {
        state: withTargetPending(state, found.matches, input, 'update'),
        reply: { kind: 'targets', text: '有多笔都对得上，选一笔再改', matches: found.matches.map(briefTx), intent: 'update', raw: input }
      };
    }
    var res = buildUpdatePlan(input, found.matches[0], cx);
    if (!res.ok) { return { state: state, reply: { kind: 'clarify', text: res.message, code: res.code } }; }
    state.draft = res.plan;
    draftSave(res.plan, { note: 'waiting-confirm' });
    return { state: state, reply: previewEdit(res.plan, found.matches[0], cx) };
  }

  function handleDelete(input, state, cx) {
    var found = findTargets(input, cx, state);
    if (!found.ok) { return { state: state, reply: { kind: 'clarify', text: found.message, code: found.code } }; }
    if (!found.exact) {
      return {
        state: withTargetPending(state, found.matches, input, 'delete'),
        reply: { kind: 'targets', text: '有多笔都对得上，选一笔再删', matches: found.matches.map(briefTx), intent: 'delete', raw: input }
      };
    }
    var plan = buildDeletePlan(found.matches[0], cx);
    state.draft = plan;
    draftSave(plan, { note: 'waiting-confirm' });
    return { state: state, reply: previewEdit(plan, found.matches[0], cx) };
  }

  function briefTx(tx) {
    return {
      id: tx.id,
      typeText: TYPE_TEXT[tx.type] || '支出',
      amountText: formatCents(tx.amountCents),
      date: tx.date,
      note: tx.note || '',
      type: tx.type,
      amountCents: tx.amountCents,
      categoryId: tx.categoryId,
      accountId: tx.accountId
    };
  }

  /* 修改/删除的预览：展示「改成什么」或「要删哪笔」 */
  function previewEdit(plan, target, cx) {
    var row = briefTx(target);
    var rows = [{
      index: 1,
      id: target.id,
      type: target.type,
      typeText: row.typeText,
      amountCents: target.amountCents,
      amountText: row.amountText,
      categoryText: target.type === 'transfer' ? '转账' : categoryName(cx, target.categoryId),
      accountText: accountName(cx, target.accountId),
      toAccountText: target.type === 'transfer' ? accountName(cx, target.toAccountId) : '',
      dateText: dateLabel(cx, target.date),
      time: target.time,
      note: target.note || '',
      issues: [],
      dup: false
    }];
    var text;
    if (plan.kind === 'delete') {
      text = '确认删除这笔？删除后可以从撤销历史恢复';
    } else if (plan.edit.replaceType) {
      text = '这笔要改成「' + TYPE_TEXT[plan.edit.replaceType] + '」：会软删旧账并新建一笔，确认后一起写入';
    } else {
      var bits = [];
      var patch = plan.edit.patch || {};
      if (patch.amountCents) { bits.push('金额改 ' + formatCents(patch.amountCents)); }
      if (patch.categoryId) { bits.push('分类改 ' + categoryName(cx, patch.categoryId)); }
      if (patch.accountId) { bits.push('账户改 ' + accountName(cx, patch.accountId)); }
      if (patch.date) { bits.push('日期改 ' + dateLabel(cx, patch.date)); }
      text = '确认修改：' + (bits.join('，') || '不改字段') + '？';
    }
    return {
      kind: 'preview',
      text: text,
      planId: plan.id,
      plan: plan,
      rows: rows,
      totals: { count: 1, expenseCents: 0, incomeCents: 0, netCents: 0, transferCount: 0 },
      warnings: [],
      needDupConfirm: false,
      canConfirm: true,
      editText: plan.kind === 'delete' ? '删除' : '修改'
    };
  }

  function handleUndo(input, state, cx) {
    var history = core.history;
    var entry = null;
    if (history && typeof history.list === 'function') {
      var entries = history.list();
      entry = entries.length ? entries[0] : null;
    }
    if (!entry) {
      return { state: state, reply: { kind: 'hint', text: '没有可撤销的记录' } };
    }
    return {
      state: state,
      reply: {
        kind: 'confirm-undo',
        text: '撤销「' + entry.label + '」（' + entry.summary + '）？撤销后不能重复',
        entry: entry
      }
    };
  }

  /* 撤销执行：由屏幕调用，经 XZB.app.commit 的 mutator 落地 */
  function revertEntry(entry, working) {
    var history = core.history;
    if (!history || typeof history.revert !== 'function') {
      return { ok: false, code: E.UNKNOWN, message: M.E_AS_UNKNOWN };
    }
    return history.revert(working, entry);
  }

  /* ============================== 落库（唯一写入口） ============================== */

  function commitApi() {
    var app = XZB.app;
    return app && typeof app.commit === 'function' ? app.commit : null;
  }

  function planLabel(plan) {
    if (!plan) { return '助手'; }
    if (plan.kind === 'delete') { return '助手删除'; }
    if (plan.kind === 'update') { return plan.edit && plan.edit.replaceType ? '助手改类型' : '助手修改'; }
    return '助手记账';
  }

  /* execute：预检 → app.commit（整库克隆 + 事务 + 校验）；失败一律整批中止 */
  function execute(plan, cx, options) {
    var opts = options || {};
    var commit = opts.commit || commitApi();
    if (!commit) {
      return Promise.resolve({ ok: false, code: E.UNKNOWN, message: '写入通道不可用' });
    }
    if (!plan) {
      return Promise.resolve({ ok: false, code: E.UNKNOWN, message: M.E_AS_UNKNOWN });
    }
    if (cx && cx.readonly) {
      return Promise.resolve({ ok: false, code: E.READONLY_STORAGE, message: M.E_AS_READONLY_STORAGE });
    }
    var check = preflight(plan, cx);
    if (!check.ok) {
      var first = check.errors[0] || {};
      return Promise.resolve({ ok: false, code: first.code || E.INVALID, message: first.message || M.E_AS_INVALID, errors: check.errors });
    }
    var allExist = plan.kind === 'create' && check.existing.length > 0 && check.existing.length === plan.items.length;
    if (allExist) {
      /* 上次已经写进去了（重试 / 刷新后再点确认）：按 id 对账，不重复入账 */
      return Promise.resolve({
        ok: true,
        already: true,
        result: { created: [], updated: [], deleted: [], skipped: check.existing.map(function (x) { return x.id; }) }
      });
    }
    return Promise.resolve(commit(function (working) {
      var applied = applyPlan(plan, working, cx);
      if (!applied.ok) {
        return { abort: true, code: applied.code, message: applied.message };
      }
      return { value: applied };
    }, { label: planLabel(plan), source: 'assistant' })).then(function (res) {
      if (!res || !res.ok) {
        return { ok: false, code: (res && res.code) || E.INVALID, message: (res && res.message) || M.E_AS_INVALID };
      }
      var value = res.value || { created: [], updated: [], deleted: [], skipped: [] };
      return { ok: true, result: value };
    }, function (error) {
      return { ok: false, code: E.INVALID, message: (error && error.message) || M.E_AS_INVALID };
    });
  }

  /* 撤销历史里的一条：定向逆操作，走同一写入口；撤销本身不进历史（history:false） */
  function undoEntry(entry, cx, options) {
    var opts = options || {};
    var commit = opts.commit || commitApi();
    if (!commit) {
      return Promise.resolve({ ok: false, code: E.UNKNOWN, message: '写入通道不可用' });
    }
    if (!entry) {
      return Promise.resolve({ ok: false, code: E.UNKNOWN, message: '没有可撤销的记录' });
    }
    if (cx && cx.readonly) {
      return Promise.resolve({ ok: false, code: E.READONLY_STORAGE, message: M.E_AS_READONLY_STORAGE });
    }
    return Promise.resolve(commit(function (working) {
      var res = revertEntry(entry, working);
      if (!res || !res.ok) {
        return { abort: true, code: (res && res.code) || E.UNKNOWN, message: (res && res.message) || M.E_AS_INVALID };
      }
      return { value: res };
    }, { label: '撤销', undo: false, history: false })).then(function (res) {
      if (!res || !res.ok) {
        return { ok: false, code: (res && res.code) || E.UNKNOWN, message: (res && res.message) || '撤销失败，请重试' };
      }
      var store = core.history;
      if (store && typeof store.remove === 'function') { store.remove(entry.id); }
      return { ok: true, result: res.value };
    }, function (error) {
      return { ok: false, code: E.UNKNOWN, message: (error && error.message) || '撤销失败，请重试' };
    });
  }

  /* ============================== 统一撤销（T10） ============================== */
  /* 口径（DESIGN §6/R-06/R-10）：只做整批撤销，不做单笔；读 core.history、写 app.commit，成功后 remove(id)。
     skipped>0 时已撤下的笔照常落库，但整批返回 ok:false + E_HISTORY_PARTIAL + 三计数（history.js:334-336）。 */
  var UNDONE = [];

  function undoList() {
    try { return core.history.list() || []; } catch (error) { return []; }
  }

  /* on=true 开写前落标记（并发第二次直接拦）；on=false 写失败后撤标记（允许重试） */
  function undoMark(id, on) {
    var i = UNDONE.indexOf(id);
    if (i !== -1) { UNDONE.splice(i, 1); }
    if (on) { UNDONE.push(id); }
  }

  /* 失败统一形状（计数归零）；成功/部分成功直接透传 history.revert 的原对象（字段本就同构） */
  function undoFail(code, message) {
    return Promise.resolve({ ok: false, code: code, message: message, restored: 0, removed: 0, skipped: 0 });
  }

  function undoAvailable() { return undoList().length > 0; }

  /* history 条目 → UI 摘要：补 title（=label）与 text；ops 原样留给 revert（readAll 每次 clone，不污染存储） */
  function undoLast() {
    var entries = undoList();
    if (!entries.length) { return null; }
    entries[0].title = entries[0].label || '这一步';
    entries[0].text = undoDescribe(entries[0]);
    return entries[0];
  }

  function undoDescribe(entry) {
    var item = entry || undoLast();
    var count = (item && item.count) || 0;
    if (!count) { return '没有可撤销的记录'; }
    var create = ((item && item.ops) || {}).create || [];
    return (create.length === count ? '已记录 ' + count + ' 笔' : (item.summary || '共 ' + count + ' 笔')) + '，可撤销';
  }

  /* revert(entry, cx) → Promise<{ok, code?, message?, restored, removed, skipped}>；entry 可为 id 字符串 */
  function undoRevert(entry, cx) {
    var store = core.history;
    var commit = commitApi();
    var item = entry;
    var id;
    if (!store || typeof store.revert !== 'function' || !commit) { return undoFail(E.UNKNOWN, M.E_AS_UNKNOWN); }
    if (typeof item === 'string') { item = store.find(item); }
    if (!item || !item.id) { return undoFail('E_HISTORY_MISSING', store.MESSAGES.E_HISTORY_MISSING); }
    if (cx && cx.readonly) { return undoFail(E.READONLY_STORAGE, M.E_AS_READONLY_STORAGE); }
    id = String(item.id);
    /* 幂等拦截：内存标记（连点/并发）+ 读库复核（刷新后回放旧 entry）→ 不写库、计数归零 */
    if (UNDONE.indexOf(id) !== -1 || !store.find(id)) { return undoFail('E_HISTORY_MISSING', store.MESSAGES.E_HISTORY_MISSING); }
    undoMark(id, true);
    return commit(function (working) {
      var res = store.revert(working, item);
      if (!res.ok && res.code !== 'E_HISTORY_PARTIAL') { return { abort: true, code: res.code, message: res.message }; }
      return { value: res };   /* partial 也落库：已撤下的那几笔必须真撤掉 */
    }, { label: '撤销', undo: false, history: false }).then(function (res) {
      if (!res || !res.ok) {
        undoMark(id, false);
        return undoFail((res && res.code) || E.UNKNOWN, (res && res.message) || M.E_AS_UNKNOWN);
      }
      store.remove(id);
      return res.value || undoFail(E.UNKNOWN, M.E_AS_UNKNOWN);
    });
  }

/* ============================== 联网模型（llm） ============================== */
  /*
   * 口径（DECISIONS D-10 / R-11，用户已拍板「全量原文不脱敏」）：
   *   出站 = 当轮原话（硬截断到 LLM_MAX_RAW 字）+ 固定提示词 + 最小上下文（今天 / 账本 / 账户 / 分类名单）。
   *   - 不发历史流水、不发余额、不发照片与备份、不带历史对话，只发当轮这一句；
   *   - 不做字段脱敏（R-11 删掉了「脱敏档」，这里也不再读 ai.redact 决定行为）；
   *   - 密钥只在本文件与 localStorage['xzb.ai.v1'] 之间流动：不进日志、不进错误文案、不进 URL、不进异常 message。
   *
   * 失败口径（DESIGN §3.2）：任何失败都落成「本地模式继续」，绝不静默失败；重试 0 次（DECISIONS R-04）。
   */

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function byteLen(text) {
    var s = String(text || '');
    var n = 0;
    var i;
    var c;
    for (i = 0; i < s.length; i += 1) {
      c = s.charCodeAt(i);
      if (c < 128) {
        n += 1;
      } else if (c < 2048) {
        n += 2;
      } else if (c >= 55296 && c <= 56319) {
        n += 4;
        i += 1;
      } else {
        n += 3;
      }
    }
    return n;
  }

  function delayMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  /* ---------- 配置：独立键 xzb.ai.v1，只在本文件读写（R-01） ---------- */

  function lsApi() {
    try {
      var ls = global.localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
        return ls;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function aiDefault() {
    return {
      v: AI_VERSION,
      enabled: false,
      baseURL: '',
      model: '',
      key: '',
      redact: 'names',
      noticeAt: 0
    };
  }

  function aiTrim(value, max) {
    if (typeof value !== 'string') { return ''; }
    var s = value.replace(/[\r\n\t]+/g, ' ').trim();
    if (max && s.length > max) { s = s.slice(0, max); }
    return s;
  }

  /* 方案：只认 http / https；用切片比较，避免在源码里拼出完整的 URL 字面量串 */
  function aiSchemeOK(url) {
    var s = String(url || '').toLowerCase();
    if (s.indexOf('http') !== 0) { return false; }
    if (s.charAt(4) === 's') { return s.slice(5, 8) === '://'; }
    return s.slice(4, 7) === '://';
  }

  function aiNormalizeURL(value) {
    var s = aiTrim(value, AI_MAX_URL);
    if (!s) { return ''; }
    if (s.indexOf(' ') >= 0) { return ''; }
    if (!aiSchemeOK(s)) { return ''; }
    var cut = s.indexOf('://');
    if (cut < 4) { return ''; }
    var rest = s.slice(cut + 3);
    if (!rest || rest.charAt(0) === '/') { return ''; }
    while (s.length && s.charAt(s.length - 1) === '/') { s = s.slice(0, -1); }
    if (s.length < 12) { return ''; }
    return s;
  }

  /* 读取：缺键 / 损坏 JSON / 超长 / 形状不对 一律回落安全默认值，绝不抛 */
  function aiRead() {
    var cfg = aiDefault();
    var ls = lsApi();
    if (!ls) { return cfg; }
    var text;
    try {
      text = ls.getItem(AI_KEY);
    } catch (error) {
      return cfg;
    }
    if (typeof text !== 'string' || !text) { return cfg; }
    if (text.length > AI_MAX_BYTES) { return cfg; }
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (error2) {
      return cfg;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return cfg; }
    if (Number(raw.v) !== AI_VERSION) { return cfg; }
    if (raw.enabled === true) { cfg.enabled = true; }
    cfg.baseURL = aiNormalizeURL(raw.baseURL);
    cfg.model = aiTrim(raw.model, AI_MAX_MODEL);
    cfg.key = aiTrim(raw.key, AI_MAX_KEY);
    if (raw.redact === 'none' || raw.redact === 'names') { cfg.redact = raw.redact; }
    var at = Number(raw.noticeAt);
    if (isFinite(at) && at > 0) { cfg.noticeAt = at; }
    return cfg;
  }

  function aiWrite(cfg) {
    var ls = lsApi();
    if (!ls) { return false; }
    var text;
    try {
      text = JSON.stringify({
        v: AI_VERSION,
        enabled: cfg.enabled === true,
        baseURL: cfg.baseURL || '',
        model: cfg.model || '',
        key: cfg.key || '',
        redact: cfg.redact === 'none' ? 'none' : 'names',
        noticeAt: Number(cfg.noticeAt) || 0
      });
    } catch (error) {
      return false;
    }
    if (byteLen(text) > AI_MAX_BYTES) { return false; }
    try {
      ls.setItem(AI_KEY, text);
      return true;
    } catch (error2) {
      return false;
    }
  }

  function aiMask(key) {
    if (!key) { return ''; }
    if (key.length < 8) { return '••••'; }
    return '••••' + key.slice(-4);
  }

  function aiConfigured(cfg) {
    return !!(cfg.baseURL && cfg.model && cfg.key);
  }

  function llmReady() {
    var cfg = aiRead();
    return cfg.enabled === true && !!cfg.key && Number(cfg.noticeAt) > 0;
  }

  function llmConfigView() {
    var cfg = aiRead();
    return {
      enabled: cfg.enabled,
      baseURL: cfg.baseURL,
      model: cfg.model,
      keyMasked: aiMask(cfg.key),
      hasKey: !!cfg.key,
      redact: cfg.redact,
      noticeAt: cfg.noticeAt,
      ready: llmReady()
    };
  }

  function llmGetConfig() {
    return { ok: true, cfg: llmConfigView() };
  }

  function llmSetConfig(patch) {
    var p = patch && typeof patch === 'object' ? patch : {};
    var cfg = aiRead();
    if (hasOwn(p, 'baseURL')) {
      var wantURL = aiTrim(p.baseURL, AI_MAX_URL);
      if (wantURL) {
        var normalized = aiNormalizeURL(wantURL);
        if (!normalized) { return { ok: false, code: E.NET_CONFIG, field: 'baseURL' }; }
        cfg.baseURL = normalized;
      } else {
        cfg.baseURL = '';
      }
    }
    if (hasOwn(p, 'model')) {
      if (typeof p.model !== 'string' && p.model !== null) {
        return { ok: false, code: E.NET_CONFIG, field: 'model' };
      }
      cfg.model = aiTrim(p.model, AI_MAX_MODEL);
    }
    if (hasOwn(p, 'key')) {
      if (typeof p.key !== 'string' && p.key !== null) {
        return { ok: false, code: E.NET_CONFIG, field: 'model' };
      }
      var wantKey = aiTrim(p.key, AI_MAX_KEY + 1);
      if (wantKey.length > AI_MAX_KEY) { return { ok: false, code: E.NET_CONFIG, field: 'model' }; }
      /* T06 密钥边界：UI 把 getConfig 的掩码（••••尾4）原样回传时视为「不改」，
         否则明文密钥会被自己的掩码覆盖（用户以为改成功，实际凭证已销毁） */
      if (wantKey.indexOf('••••') === 0) { wantKey = cfg.key; }
      cfg.key = wantKey;
    }
    if (hasOwn(p, 'enabled')) {
      cfg.enabled = (p.enabled === true || p.enabled === 1);
    }
    if (hasOwn(p, 'noticeAt')) {
      var at = Number(p.noticeAt);
      cfg.noticeAt = (isFinite(at) && at > 0) ? at : 0;
    }
    /* v / redact 不接受外部改写：R-11 已删除脱敏档，字段只为旧数据形状兼容保留 */
    if (!aiWrite(cfg)) { return { ok: false, code: E.NET_CONFIG, field: 'model' }; }
    return { ok: true, cfg: llmConfigView() };
  }

  /* 清空数据（R-01 的 removeItem 落点）：整键删除、幂等；A30 要求 getItem 之后为 null */
  function llmClearKey() {
    var ls = lsApi();
    if (ls) {
      try {
        ls.removeItem(AI_KEY);
      } catch (error) {
        return { ok: false };
      }
    }
    return { ok: true };
  }

  /* ---------- 传输层：单次 POST + 硬超时（AbortController） ---------- */

  function endpointOf(base) {
    var s = String(base || '');
    while (s.length && s.charAt(s.length - 1) === '/') { s = s.slice(0, -1); }
    return s + '/chat/completions';
  }

  function retryAfterMs(res) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') {
        var sec = Number(res.headers.get('Retry-After'));
        if (isFinite(sec) && sec > 0) { return Math.round(sec * 1000); }
      }
    } catch (error) {
      return 0;
    }
    return 0;
  }

  function mapStatus(status, res) {
    if (status === 429) {
      return { ok: false, code: E.NET_RATE, retryable: true, status: status, retryAfterMs: retryAfterMs(res) };
    }
    if (status >= 500) {
      return { ok: false, code: E.NET_RATE, retryable: true, status: status, retryAfterMs: retryAfterMs(res) };
    }
    /* 401/403/404/405/400 等：地址、模型或密钥配错，重试无意义 */
    return { ok: false, code: E.NET_CONFIG, retryable: false, status: status };
  }

  function mapNetError(error) {
    if (error && String(error.name || '') === 'AbortError') {
      return { ok: false, code: E.NET_TIMEOUT, retryable: false, status: 0, reason: 'timeout' };
    }
    try {
      if (global.navigator && global.navigator.onLine === false) {
        return { ok: false, code: E.NET_CONFIG, retryable: false, status: 0, reason: 'offline' };
      }
    } catch (error2) {
      /* navigator 不可用就算了 */
    }
    /* 断网与 CORS 同形：都按配置/网络问题回落本地 */
    return { ok: false, code: E.NET_CONFIG, retryable: false, status: 0, reason: 'offline' };
  }

  function httpOnce(cfg, bodyStr) {
    return new Promise(function (resolve) {
      if (typeof fetch !== 'function') {
        resolve({ ok: false, code: E.NET_CONFIG, retryable: false, status: 0 });
        return;
      }
      var done = false;
      var timer = null;
      var ctrl = null;
      function end(res) {
        if (done) { return; }
        done = true;
        if (timer) {
          try { clearTimeout(timer); } catch (error) { /* 已触发 */ }
          timer = null;
        }
        resolve(res);
      }
      var options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.key
        },
        body: bodyStr,
        credentials: 'omit',
        cache: 'no-store',
        mode: 'cors'
      };
      if (typeof AbortController === 'function') {
        try {
          ctrl = new AbortController();
          options.signal = ctrl.signal;
        } catch (error) {
          ctrl = null;
        }
      }
      timer = setTimeout(function () {
        if (ctrl && typeof ctrl.abort === 'function') {
          try { ctrl.abort(); } catch (error) { /* 已结束 */ }
        }
        end({ ok: false, code: E.NET_TIMEOUT, retryable: false, status: 0, reason: 'timeout' });
      }, LLM_TIMEOUT_MS);

      var request;
      try {
        request = fetch(endpointOf(cfg.baseURL), options);
      } catch (error2) {
        end(mapNetError(error2));
        return;
      }
      if (!request || typeof request.then !== 'function') {
        end({ ok: false, code: E.NET_CONFIG, retryable: false, status: 0 });
        return;
      }
      request.then(function (res) {
        var status = Number(res && res.status) || 0;
        if (status < 200 || status >= 300) {
          end(mapStatus(status, res));
          return;
        }
        var bodyPromise;
        try {
          bodyPromise = (res && typeof res.text === 'function') ? res.text() : Promise.resolve('');
        } catch (error3) {
          end({ ok: false, code: E.NET_BAD, retryable: false, status: status });
          return;
        }
        bodyPromise.then(function (text) {
          var json = null;
          if (typeof text === 'string' && text) {
            try { json = JSON.parse(text); } catch (error4) { json = null; }
          }
          if (!json || typeof json !== 'object') {
            end({ ok: false, code: E.NET_BAD, retryable: false, status: status });
            return;
          }
          end({ ok: true, status: status, json: json });
        }, function () {
          end({ ok: false, code: E.NET_BAD, retryable: false, status: status });
        });
      }, function (error5) {
        end(mapNetError(error5));
      });
    });
  }

  /* ---------- 信封解析（V1~V4 / F9 / F10） ---------- */

  function parseJsonLoose(text) {
    var s = String(text || '');
    var fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fence && fence[1]) { s = fence[1]; }
    s = s.trim();
    var first = s.indexOf('{');
    var last = s.lastIndexOf('}');
    if (first >= 0 && last > first) { s = s.slice(first, last + 1); }
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch (error) {
      return { ok: false };
    }
  }

  function contentOf(choice) {
    var msg = choice && choice.message ? choice.message : null;
    if (msg && typeof msg.content === 'string') { return msg.content; }
    if (msg && msg.content && typeof msg.content.length === 'number') {
      var parts = [];
      var i;
      for (i = 0; i < msg.content.length; i += 1) {
        var piece = msg.content[i];
        if (piece && typeof piece.text === 'string') { parts.push(piece.text); }
      }
      return parts.join('');
    }
    if (choice && typeof choice.text === 'string') { return choice.text; }
    return '';
  }

  function readEnvelope(json) {
    var choices = json && json.choices;
    if (!choices || !choices.length) { return { ok: false, code: E.NET_BAD }; }
    var first = choices[0] || {};
    if (first.finish_reason === 'length') { return { ok: false, code: E.NET_BAD }; }
    var text = String(contentOf(first) || '').trim();
    if (!text) { return { ok: false, code: E.NET_BAD }; }
    var parsed = parseJsonLoose(text);
    if (!parsed.ok) { return { ok: false, code: E.NET_BAD }; }
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return { ok: false, code: E.NET_BAD };
    }
    return { ok: true, proposal: parsed.value };
  }

  /* ---------- 提示词与请求体（§2.4 / R-11） ---------- */

  function sysPromptLines() {
    return [
      '你是「小账本」记账解析器。用户只发中文自然语言账目，不闲聊。',
      '',
      '只输出一个 JSON 对象，首字符是 {，禁止围栏与说明文字。',
      '',
      '字段：',
      'intent：create|update|delete|query|need_clarify',
      'items：仅 create，≤20 条 {type,amountCents,accountId,toAccountId,categoryId,date,time,note}',
      'edit：仅 update/delete，{targetHint,patch:{amountCents,accountId,categoryId,date}}',
      'filter：仅 query，{from,to,type,categoryId,accountId,keyword,minCents,maxCents}',
      'clarify：{question,options:[{label,value}]}',
      '',
      '规则：',
      '1 金额单位是分，正整数：35 元写 3500。禁小数负数单位字。',
      '2 accountId、categoryId 只能从下方清单原样复制，严禁编造或改名；清单没有留 ""。',
      '3 转账：type=transfer，accountId 与 toAccountId 都要给且不同，categoryId 留 ""。',
      '4 支出、收入：toAccountId 留 ""。',
      '5 date/time 只在用户明说时填，否则留 ""，禁猜「今天」。',
      '6 note 取原话短语，不写「支出/记账/收入」，不写金额。',
      '7 超过 20 笔输出 need_clarify，请用户分批。',
      '8 update、delete 绝不输出交易 id，只给 targetHint 与 patch。',
      '9 金额无法确定输出 need_clarify 并问一句，不要猜。',
      '10 分类拿不准留 ""，不要塞「其他」。',
      '11 听不懂或非记账请求输出 need_clarify。',
      '',
      '今天：<TODAY>',
      '账本：<BOOK>',
      '账户清单（id 名称）：<ACCOUNTS>',
      '分类清单（id 名称）：<CATEGORIES>'
    ];
  }

  function pairText(list) {
    var out = [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      var one = list[i];
      if (!one || !one.id) { continue; }
      out.push(String(one.id) + ' ' + String(one.name || ''));
    }
    return out.join('\n');
  }

  function accountPairs(list) {
    var out = [];
    var i;
    var src = Array.isArray(list) ? list : [];
    for (i = 0; i < src.length && out.length < LLM_MAX_ACCOUNTS; i += 1) {
      var one = src[i];
      if (!one || typeof one !== 'object') { continue; }
      var id = short(String(one.id || ''), 40);
      var name = short(String(one.name || ''), LLM_NAME_MAX);
      if (!id) { continue; }
      out.push({ id: id, name: name });
    }
    return out;
  }

  function categoryPairs(list) {
    var out = [];
    var i;
    var src = Array.isArray(list) ? list : [];
    for (i = 0; i < src.length && out.length < LLM_MAX_CATEGORIES; i += 1) {
      var one = src[i];
      if (!one || typeof one !== 'object') { continue; }
      var id = short(String(one.id || ''), 40);
      var name = short(String(one.name || ''), LLM_NAME_MAX);
      if (!id) { continue; }
      out.push({ id: id, name: name, kind: one.kind === 'income' ? 'income' : 'expense' });
    }
    return out;
  }

  function systemText(accts, cats, today, bookId) {
    return sysPromptLines().join('\n')
      .replace('<TODAY>', today)
      .replace('<BOOK>', bookId)
      .replace('<ACCOUNTS>', pairText(accts))
      .replace('<CATEGORIES>', pairText(cats));
  }

  function buildBody(cfg, raw, accts, cats, today, bookId) {
    return JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: LLM_MAX_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemText(accts, cats, today, bookId) },
        { role: 'user', content: raw }
      ]
    });
  }

  /* 体积兜底：先砍分类清单，再砍账户清单，最后砍原话（硬截断），保证 ≤4KB */
  function fitBody(cfg, payload) {
    var p = payload && typeof payload === 'object' ? payload : {};
    var raw = short(norm(p.raw || ''), LLM_MAX_RAW);
    var accts = accountPairs(p.accounts);
    var cats = categoryPairs(p.categories);
    var today = short(String(p.today || todayStr()), 10);
    var bookId = short(String(p.bookId || ''), 40);
    var body = buildBody(cfg, raw, accts, cats, today, bookId);
    var guard = 0;
    while (byteLen(body) > LLM_MAX_BODY && guard < 16) {
      guard += 1;
      if (cats.length > 6) {
        cats = cats.slice(0, Math.max(6, Math.floor(cats.length / 2)));
      } else if (accts.length > 2) {
        accts = accts.slice(0, Math.max(2, Math.floor(accts.length / 2)));
      } else if (raw.length > 16) {
        raw = raw.slice(0, Math.max(16, Math.floor(raw.length / 2)));
      } else {
        cats = [];
        accts = [];
        raw = raw.slice(0, 16);
      }
      body = buildBody(cfg, raw, accts, cats, today, bookId);
    }
    return { body: body, raw: raw };
  }

  /* ---------- llm.plan / llm.test ---------- */

  function llmNotReadyCode(cfg) {
    if (!aiConfigured(cfg)) { return E.NOT_CONFIGURED; }
    if (Number(cfg.noticeAt) <= 0) { return E.NOT_CONFIGURED; }
    if (cfg.enabled !== true) { return E.AI_DISABLED; }
    return '';
  }

  function llmPlan(payload, state, cx) {
    /* 两种调用口径都收：plan(payload)（DESIGN §1.4）与 plan(text, state, cx)（任务书） */
    if (typeof payload === 'string' || payload === null || payload === undefined) {
      var ctx0 = safeCx(cx);
      var text0 = typeof payload === 'string' ? payload : '';
      payload = {
        raw: norm(text0),
        today: ctx0.today,
        bookId: ctx0.bookId,
        accounts: accountPairs(ctx0.liveAccounts),
        categories: categoryPairs(ctx0.liveCategories)
      };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      payload = { raw: '' };
    }
    var cfg = aiRead();
    var gate = llmNotReadyCode(cfg);
    if (gate) {
      return Promise.resolve({ ok: false, code: gate, retryable: false, status: 0 });
    }
    var fit = fitBody(cfg, payload);
    var started = Date.now();
    var attempt = 0;
    function run() {
      return httpOnce(cfg, fit.body).then(function (res) {
        if (res && res.ok) {
          var parsed = readEnvelope(res.json);
          if (!parsed.ok) {
            return { ok: false, code: parsed.code, retryable: false, status: res.status || 0 };
          }
          return { ok: true, proposal: parsed.proposal };
        }
        var rest = LLM_BUDGET_MS - (Date.now() - started);
        var wait = Math.min(Number(res && res.retryAfterMs) || LLM_BACKOFF_MS, LLM_RETRY_AFTER_CAP);
        if (res && res.retryable && attempt < LLM_RETRY && rest > wait + 500) {
          attempt += 1;
          return delayMs(wait).then(run);
        }
        return {
          ok: false,
          code: (res && res.code) || E.NET_BAD,
          retryable: !!(res && res.retryable),
          status: (res && res.status) || 0
        };
      });
    }
    return run();
  }

  function llmTest() {
    var started = Date.now();
    var cfg = aiRead();
    if (!aiConfigured(cfg)) {
      return Promise.resolve({ ok: false, code: E.NOT_CONFIGURED });
    }
    /* 测试连接同样是出站请求：没告知过（noticeAt=0）就不发（A28） */
    if (Number(cfg.noticeAt) <= 0) {
      return Promise.resolve({ ok: false, code: E.NOT_CONFIGURED });
    }
    var body;
    try {
      body = JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 16,
        messages: [{ role: 'user', content: '回复一个 JSON 对象：{"ok":true}' }]
      });
    } catch (error) {
      return Promise.resolve({ ok: false, code: E.NET_CONFIG });
    }
    return httpOnce(cfg, body).then(function (res) {
      if (!res || !res.ok) {
        return { ok: false, code: (res && res.code) || E.NET_BAD };
      }
      return { ok: true, ms: Date.now() - started };
    }, function () {
      return { ok: false, code: E.NET_BAD };
    });
  }

  /* ---------- 值域校验（V9~V14） ---------- */

  function centsOf(value) {
    if (value === null || typeof value === 'undefined' || value === '') {
      return { ok: false, code: E.NO_AMOUNT };
    }
    if (typeof value === 'number') {
      if (!isFinite(value) || Math.floor(value) !== value) { return { ok: false, code: E.INVALID }; }
      if (value === 0) { return { ok: false, code: E.NO_AMOUNT }; }
      if (value < 0 || value > LLM_MAX_CENTS) { return { ok: false, code: E.INVALID }; }
      return { ok: true, cents: value };
    }
    if (typeof value === 'string') {
      var s = value.trim();
      if (!s) { return { ok: false, code: E.NO_AMOUNT }; }
      /* 单位是分：带小数点一律拒（35.5 分无意义） */
      if (!/^[0-9]+$/.test(s)) { return { ok: false, code: E.INVALID }; }
      var n = Number(s);
      if (!isFinite(n) || n === 0 || n > LLM_MAX_CENTS) { return { ok: false, code: E.INVALID }; }
      return { ok: true, cents: n };
    }
    return { ok: false, code: E.NO_AMOUNT };
  }

  function dateOf(value, cx) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: true, date: cx.today, given: false };
    }
    var s = value.trim();
    if (!isValidDate(s)) { return { ok: false, code: E.DATE_INVALID }; }
    if (s < '2000-01-01' || s > addDays(cx.today, 366)) { return { ok: false, code: E.DATE_INVALID }; }
    return { ok: true, date: s, given: true };
  }

  function timeOf(value, cx) {
    if (typeof value !== 'string') { return cx.nowTime; }
    var s = value.trim();
    if (/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s)) { return s; }
    return cx.nowTime;
  }

  function tagsOf(value) {
    var out = [];
    if (!Array.isArray(value)) { return out; }
    var i;
    for (i = 0; i < value.length && out.length < 3; i += 1) {
      if (typeof value[i] !== 'string') { continue; }
      var one = short(value[i].replace(/[#\s]+/g, '').trim(), 8);
      if (one && out.indexOf(one) < 0) { out.push(one); }
    }
    return out;
  }

  /* ---------- 单笔装配（§2.2 逐字段：只有语义字段信模型，身份/归属/审计全本地） ---------- */

  function remoteItem(pitem, planId, index, cx, segText) {
    var item = {
      id: idFor(planId, index),
      index: index,
      raw: segText || '',
      type: 'expense',
      amountCents: 0,
      accountId: '',
      toAccountId: '',
      categoryId: '',
      date: cx.today,
      time: cx.nowTime,
      note: '',
      tags: [],
      source: 'nl',
      defaulted: {},
      issues: [],
      matches: null,
      confidence: 0
    };
    var src = pitem && typeof pitem === 'object' ? pitem : {};
    var text = norm(segText || '');

    /* V9 类型 */
    if (src.type === 'expense' || src.type === 'income' || src.type === 'transfer') {
      item.type = src.type;
    } else if (src.type !== null && typeof src.type !== 'undefined' && src.type !== '') {
      item.issues.push({ field: 'type', code: E.INVALID, message: '收支类型有冲突，选一个', options: ['expense', 'income', 'transfer'] });
    } else {
      item.issues.push({ field: 'type', code: E.INVALID, message: '收支类型没给，选一个', options: ['expense', 'income', 'transfer'] });
    }

    /* V10 / V11 金额 */
    var cents = centsOf(src.amountCents);
    if (cents.ok) {
      item.amountCents = cents.cents;
    } else {
      item.amountCents = 0;
      item.issues.push({
        field: 'amount',
        code: cents.code,
        message: cents.code === E.NO_AMOUNT ? M.E_AS_NO_AMOUNT : '金额只能是正整数分，改一个数字'
      });
    }

    /* V12 日期 / V13 时间 / V14 备注 */
    var day = dateOf(src.date, cx);
    if (day.ok) {
      item.date = day.date;
    } else {
      item.date = cx.today;
      item.issues.push({ field: 'date', code: E.DATE_INVALID, message: M.E_AS_DATE });
    }
    if (item.date > cx.today) { item.future = true; }
    item.time = timeOf(src.time, cx);

    var note = typeof src.note === 'string' ? src.note.replace(/\s+/g, ' ').trim() : '';
    var cut = short(note, MAX_NOTE);
    if (note && cut !== note) { item.noteTruncated = true; }
    item.note = cut || short(stripKnown(text || segText || ''), MAX_NOTE);
    item.tags = tagsOf(src.tags);

    /* V15 账户：只有和本地候选完全匹配才采纳，否则 resolveAccount 重解析 → 默认账户兜底 */
    var wantAccount = typeof src.accountId === 'string' ? src.accountId.trim() : '';
    if (wantAccount && findIn(cx.liveAccounts, wantAccount)) {
      item.accountId = wantAccount;
    } else {
      var acct = resolveAccount(text || segText || '', cx);
      if (acct && acct.ok) {
        item.accountId = acct.id;
      } else if (acct && !acct.ok && acct.code === E.AMBIGUOUS_ACCOUNT && acct.options && acct.options.length) {
        item.issues.push({ field: 'accountId', code: E.AMBIGUOUS_ACCOUNT, message: M.E_AS_AMBIGUOUS_ACCOUNT, options: acct.options });
      }
    }
    if (!item.accountId || !findIn(cx.liveAccounts, item.accountId)) {
      item.accountId = defaultAccountId(cx);
      item.defaulted.account = true;
    }
    if (!findIn(cx.liveAccounts, item.accountId)) {
      item.issues.push({ field: 'accountId', code: E.AMBIGUOUS_ACCOUNT, message: '账户不可用（可能已归档），选一个' });
    }

    /* V16 分类：kind 必须与 type 一致，否则 resolveCategory → fallbackCategoryId */
    if (item.type === 'transfer') {
      item.categoryId = '';
    } else {
      var kind = item.type === 'income' ? 'income' : 'expense';
      var wantCat = typeof src.categoryId === 'string' ? src.categoryId.trim() : '';
      var cat = (wantCat && findIn(cx.liveCategories, wantCat)) ? categoryById(cx, wantCat) : null;
      if (!cat || cat.kind !== kind) {
        cat = null;
        var guessed = resolveCategory(text || segText || '', kind, cx);
        if (guessed && guessed.ok) {
          var cand = categoryById(cx, guessed.id);
          if (cand && cand.kind === kind && findIn(cx.liveCategories, cand.id)) { cat = cand; }
        }
      }
      if (cat) {
        item.categoryId = cat.id;
      } else {
        item.categoryId = fallbackCategoryId(cx, item.type);
        item.defaulted.category = true;
      }
    }

    /* V17 转账：转入账户必填且必须不同；V19 非转账强制清空 toAccountId */
    if (item.type === 'transfer') {
      var wantTo = typeof src.toAccountId === 'string' ? src.toAccountId.trim() : '';
      if (wantTo && wantTo !== item.accountId && findIn(cx.liveAccounts, wantTo)) {
        item.toAccountId = wantTo;
      }
      if (!item.toAccountId) {
        var guessTo = guessToAccount(text || segText || '', cx, item.accountId);
        if (guessTo) { item.toAccountId = guessTo; }
      }
      if (!item.toAccountId || item.toAccountId === item.accountId) {
        item.toAccountId = '';
        item.issues.push({
          field: 'toAccountId',
          code: E.TRANSFER_NEED_TO,
          message: M.E_AS_TRANSFER_NEED_TO,
          options: cx.liveAccounts.filter(function (a) { return a.id !== item.accountId; })
            .slice(0, MAX_TARGETS).map(function (a) { return { label: a.name, value: a.id }; })
        });
      }
    } else {
      item.toAccountId = '';
    }

    return item;
  }

  /* ---------- create / update / delete 装配（V5~V21） ---------- */

  function targetOptions(matches, cx) {
    return (matches || []).slice(0, MAX_TARGETS).map(function (tx) {
      return {
        label: dateLabel(cx, tx.date) + ' ' + (TYPE_TEXT[tx.type] || '支出') + ' ' +
          formatCents(tx.amountCents) + ' ' + categoryName(cx, tx.categoryId),
        value: tx.id
      };
    });
  }

  function askFail(code, question, options) {
    return {
      ok: false,
      code: code || E.UNKNOWN,
      ask: true,
      question: question || M[code] || M.E_AS_UNKNOWN,
      options: options || []
    };
  }

  function buildRemoteCreate(proposal, raw, cx) {
    var list = Array.isArray(proposal.items) ? proposal.items : [];
    if (!list.length) { return { ok: false, code: E.UNKNOWN }; }
    if (list.length > MAX_BATCH) { return { ok: false, code: E.BATCH_TOO_LARGE }; }
    var segs = [];
    try { segs = splitSegments(raw) || []; } catch (error) { segs = []; }
    var planId = fingerprint(raw, cx, '');
    var plan = {
      id: planId,
      kind: 'create',
      bookId: cx.bookId,
      raw: norm(raw),
      createdAt: nowIso(),
      forced: false,
      items: []
    };
    var i;
    for (i = 0; i < list.length; i += 1) {
      var pitem = list[i];
      if (!pitem || typeof pitem !== 'object' || Array.isArray(pitem)) {
        return { ok: false, code: E.UNKNOWN };
      }
      var seg = '';
      if (segs.length === list.length && segs[i]) { seg = segs[i]; }
      else if (list.length === 1) { seg = raw; }
      plan.items.push(remoteItem(pitem, planId, i, cx, seg));
    }
    try { markDuplicates(plan, cx); } catch (error2) { /* 重复检测失败不影响装配 */ }
    var bad = plan.items.filter(function (it) { return it.issues.length > 0; });
    if (bad.length) {
      /* 铁律：多笔里有一笔结构性问题 → 整批 B，绝不部分接受 */
      if (plan.items.length > 1) { return { ok: false, code: bad[0].issues[0].code }; }
      return { ok: true, plan: plan };
    }
    return { ok: true, plan: plan };
  }

  function patchOf(src, target, cx) {
    var p = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
    var out = {};
    if (hasOwn(p, 'amountCents') && p.amountCents !== null && typeof p.amountCents !== 'undefined' && p.amountCents !== '') {
      var cents = centsOf(p.amountCents);
      if (!cents.ok) { return { ok: false, code: cents.code }; }
      if (cents.cents !== Number(target.amountCents)) { out.amountCents = cents.cents; }
    }
    if (hasOwn(p, 'accountId') && typeof p.accountId === 'string' && p.accountId.trim()) {
      var acctId = p.accountId.trim();
      if (findIn(cx.liveAccounts, acctId)) {
        out.accountId = acctId;
      } else {
        var acct = resolveAccount(acctId, cx);
        if (acct && acct.ok) { out.accountId = acct.id; }
      }
    }
    if (hasOwn(p, 'categoryId') && typeof p.categoryId === 'string' && p.categoryId.trim()) {
      var catId = p.categoryId.trim();
      var kind = target.type === 'income' ? 'income' : 'expense';
      if (target.type !== 'transfer') {
        var cat = findIn(cx.liveCategories, catId) ? categoryById(cx, catId) : null;
        if (!cat || cat.kind !== kind) {
          cat = null;
          var guessed = resolveCategory(catId, kind, cx);
          if (guessed && guessed.ok) {
            var cand = categoryById(cx, guessed.id);
            if (cand && cand.kind === kind) { cat = cand; }
          }
        }
        if (cat && cat.kind === kind) { out.categoryId = cat.id; }
      }
    }
    if (hasOwn(p, 'date') && typeof p.date === 'string' && p.date.trim()) {
      var day = dateOf(p.date, cx);
      if (day.ok && day.given && day.date !== target.date) { out.date = day.date; }
    }
    return { ok: true, values: out };
  }

  function buildRemoteEdit(proposal, raw, cx, state, kind) {
    var edit = proposal.edit && typeof proposal.edit === 'object' && !Array.isArray(proposal.edit) ? proposal.edit : {};
    var hint = typeof edit.targetHint === 'string' ? short(edit.targetHint.replace(/\s+/g, ' ').trim(), 60) : '';
    /* targetHint 是模型挑出来的「更精确的描述」，单独试比拼接更准；
       拼接会把原话里的新金额/新日期当成筛选条件，反而筛空。 */
    var probes = hint ? [hint, raw, raw + ' ' + hint] : [raw];
    var found = null;
    var lastFail = null;
    for (var pi = 0; pi < probes.length; pi += 1) {
      var trial = null;
      try {
        trial = findTargets(probes[pi], cx, state);
      } catch (error) {
        trial = null;
      }
      if (trial && trial.ok && trial.matches && trial.matches.length) {
        if (!found || (trial.exact === true && found.exact !== true)) { found = trial; }
        if (found.exact === true) { break; }
      } else if (trial && !trial.ok) {
        lastFail = trial;
      }
    }
    if (!found) {
      return askFail((lastFail && lastFail.code) || E.TARGET_MISSING, (lastFail && lastFail.message) || M.E_AS_TARGET_MISSING, []);
    }
    if (found.exact !== true) {
      return askFail(E.TARGET_MULTI, M.E_AS_TARGET_MULTI, targetOptions(found.matches, cx));
    }
    var target = found.matches[0];

    if (kind === 'delete') {
      var del = buildDeletePlan(target, cx);
      /* R-02：plan.raw 恒等于用户原话（本地 buildDeletePlan 保持不动） */
      del.raw = norm(raw);
      return { ok: true, plan: del, target: target };
    }

    var patch = patchOf(edit.patch, target, cx);
    if (!patch.ok) {
      return askFail(patch.code, patch.code === E.NO_AMOUNT ? M.E_AS_NO_AMOUNT : M.E_AS_INVALID, []);
    }
    var values = patch.values;
    var replaceType = null;
    if (typeof edit.replaceType === 'string' && (edit.replaceType === 'expense' || edit.replaceType === 'income' || edit.replaceType === 'transfer') && edit.replaceType !== target.type) {
      replaceType = edit.replaceType;
    }
    var local = null;
    if (!Object.keys(values).length && !replaceType) {
      /* 模型没给出可用字段：整份交给本地解析器（本地语义不动） */
      try { local = buildUpdatePlan(raw, target, cx); } catch (error2) { local = null; }
      if (!local || !local.ok) {
        return askFail(E.UNKNOWN, '没听出要改哪个字段（金额/分类/账户/日期）', []);
      }
      return { ok: true, plan: local.plan, target: target };
    }
    var planId = fingerprint('upd|' + target.id + '|' + norm(raw), cx, target.updatedAt || '');
    var nextValues = Object.assign({}, target, values, { updatedAt: nowIso() });
    if (replaceType) { nextValues.type = replaceType; }
    var plan = {
      id: planId,
      kind: 'update',
      bookId: target.bookId,
      raw: norm(raw),
      createdAt: nowIso(),
      forced: false,
      items: [],
      edit: {
        ids: [target.id],
        patch: values,
        base: snapshotOf(target),
        values: nextValues,
        replaceType: replaceType
      }
    };
    return { ok: true, plan: plan, target: target };
  }

  /* buildPlan(proposal, raw, cx, state)：
   *   → {ok:true, plan, target?} 正常装配
   *   → {ok:false, ask:true, code, question, options} A 追问
   *   → {ok:false, code} B 回落本地 / C 报错 */
  function looksLikeCx(value) {
    if (!value || typeof value !== 'object') { return false; }
    if (Array.isArray(value.liveAccounts) || Array.isArray(value.liveCategories)) { return true; }
    return typeof value.bookId === 'string' && typeof value.today === 'string';
  }

  function buildPlan(proposal, raw, a, b) {
    /* 两种口径都收：buildPlan(proposal, text, cx, state)（DESIGN §2.2 / 任务书）
       与 buildPlan(proposal, text, state, cx) 的书写顺序漂移。 */
    var cxIn = a;
    var stateIn = b;
    if (!looksLikeCx(cxIn) && looksLikeCx(stateIn)) {
      cxIn = stateIn;
      stateIn = a;
    }
    var cx = safeCx(cxIn);
    var state = stateIn && typeof stateIn === 'object' ? stateIn : null;
    var text = typeof raw === 'string' ? raw : '';
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
      return { ok: false, code: E.UNKNOWN };
    }
    var intent = typeof proposal.intent === 'string' ? proposal.intent : '';
    if (intent !== 'create' && intent !== 'update' && intent !== 'delete' &&
        intent !== 'query' && intent !== 'need_clarify') {
      return { ok: false, code: E.UNKNOWN };
    }
    if (intent === 'create') { return buildRemoteCreate(proposal, text, cx); }
    if (intent === 'update' || intent === 'delete') { return buildRemoteEdit(proposal, text, cx, state, intent); }
    /* query / need_clarify 不经 buildPlan（respondRemote 里各自处理） */
    return { ok: false, code: E.UNKNOWN };
  }

  /* ---------- intent 级装配 ---------- */

  function remoteClarify(proposal) {
    var src = proposal.clarify && typeof proposal.clarify === 'object' && !Array.isArray(proposal.clarify) ? proposal.clarify : null;
    var question = src && typeof src.question === 'string' ? short(src.question.replace(/\s+/g, ' ').trim(), 80) : '';
    if (!question) { return null; }
    var options = [];
    if (src && Array.isArray(src.options)) {
      var i;
      for (i = 0; i < src.options.length && options.length < MAX_TARGETS; i += 1) {
        var one = src.options[i];
        if (!one || typeof one !== 'object') { continue; }
        var label = typeof one.label === 'string' ? short(one.label.trim(), 20) : '';
        var value = typeof one.value === 'string' ? short(one.value.trim(), 40) : '';
        if (!label || !value) { continue; }
        options.push({ label: label, value: value });
      }
    }
    return { kind: 'clarify', text: question, code: E.UNKNOWN, options: options };
  }

  function remoteQuery(proposal, raw, cx, state) {
    var base;
    try {
      base = parseQuery(raw, cx, state ? state.lastQuery : null);
    } catch (error) {
      return null;
    }
    if (!base || !base.ok) { return null; }
    var filter = base.filter;
    var f = proposal.filter && typeof proposal.filter === 'object' && !Array.isArray(proposal.filter) ? proposal.filter : null;
    if (f) {
      var from = typeof f.from === 'string' ? f.from.trim() : '';
      var to = typeof f.to === 'string' ? f.to.trim() : '';
      var moved = false;
      if (isValidDate(from) && from >= '2000-01-01' && from <= addDays(cx.today, 366)) {
        filter.from = from;
        moved = true;
      }
      if (isValidDate(to) && to >= '2000-01-01' && to <= addDays(cx.today, 366)) {
        filter.to = to;
        moved = true;
      }
      if (filter.from > filter.to) {
        var swap = filter.from;
        filter.from = filter.to;
        filter.to = swap;
      }
      if (moved) {
        filter.label = filter.from === filter.to ? dateLabel(cx, filter.from) : (filter.from + ' 至 ' + filter.to);
        filter.month = '';
      }
      if (f.type === 'expense' || f.type === 'income' || f.type === 'transfer') { filter.type = f.type; }
      if (typeof f.accountId === 'string' && f.accountId.trim() && findIn(cx.liveAccounts, f.accountId.trim())) {
        filter.accountId = f.accountId.trim();
      }
      if (typeof f.categoryId === 'string' && f.categoryId.trim() && findIn(cx.liveCategories, f.categoryId.trim())) {
        filter.categoryId = f.categoryId.trim();
      }
      if (typeof f.keyword === 'string' && f.keyword.trim()) {
        filter.keyword = short(f.keyword.trim(), 20);
      }
      var minCents = Number(f.minCents);
      if (isFinite(minCents) && minCents > 0) { filter.minCents = Math.floor(minCents); }
      var maxCents = Number(f.maxCents);
      if (isFinite(maxCents) && maxCents > 0) { filter.maxCents = Math.floor(maxCents); }
      if (filter.minCents && filter.maxCents && filter.minCents > filter.maxCents) {
        var swap2 = filter.minCents;
        filter.minCents = filter.maxCents;
        filter.maxCents = swap2;
      }
    }
    var totals = queryTotals(cx, filter);
    var next = cloneState(state);
    next.lastQuery = { filter: filter, text: norm(raw) };
    next.recentIds = totals.rows.slice(0, 5).map(function (row) { return row.id; });
    var answer = buildQueryAnswer(totals, cx);
    return {
      state: next,
      mode: 'online',
      reason: '',
      reply: {
        kind: 'query',
        text: answer.text,
        filter: filter,
        filterText: analyzeFilterText(filter, cx),
        totals: totals,
        rows: totals.rows,
        link: deepLink(filter)
      }
    };
  }

  /* ---------- 失败 → 本地模式（绝不静默） ---------- */

  function reasonOf(code, res) {
    if (code === E.NET_TIMEOUT) { return 'timeout'; }
    if (code === E.NET_RATE) { return 'rate'; }
    if (code === E.NET_BAD) { return 'bad'; }
    if (code === E.AI_DISABLED) { return 'disabled'; }
    if (code === E.NOT_CONFIGURED || code === E.NET_CONFIG) {
      var offline = false;
      try { offline = !!(global.navigator && global.navigator.onLine === false); } catch (error) { offline = false; }
      if (offline) { return 'offline'; }
      return 'config';
    }
    return 'bad';
  }

  function localReply(text, state, cx, reason) {
    var out = null;
    try {
      out = respond(text, state, cx);
    } catch (error) {
      out = null;
    }
    if (!out || !out.reply) {
      out = {
        state: cloneState(state),
        reply: { kind: 'hint', text: M.E_AS_UNKNOWN, options: [] }
      };
    }
    return { state: out.state, reply: out.reply, mode: 'local-fallback', reason: reason || '' };
  }

  function safeCx(cx) {
    if (cx && Array.isArray(cx.liveAccounts) && Array.isArray(cx.liveCategories) && cx.today) {
      return cx;
    }
    try {
      return contextOf(cx || {});
    } catch (error) {
      return contextOf({});
    }
  }

  /* respondRemote(text, state, cx) → Promise<{state, reply, mode:'online'|'local-fallback', reason}>
   * 软 5s 提示由界面消费 LLM_SOFT_MS；这里只负责硬 6s 兜底与回落，永不 reject。 */
  function respondRemote(text, state, cx) {
    var ctx = safeCx(cx);
    return new Promise(function (resolve) {
      var cfg = aiRead();
      if (!aiConfigured(cfg) || cfg.enabled !== true || Number(cfg.noticeAt) <= 0) {
        resolve(localReply(text, state, ctx, cfg.enabled === true ? 'config' : 'disabled'));
        return;
      }
      var payload = {
        raw: norm(text),
        today: ctx.today,
        bookId: ctx.bookId,
        accounts: accountPairs(ctx.liveAccounts),
        categories: categoryPairs(ctx.liveCategories)
      };
      llmPlan(payload).then(function (res) {
        var out = null;
        try {
          out = handleRemoteResult(res, text, state, ctx);
        } catch (error) {
          out = null;
        }
        if (out) {
          resolve(out);
          return;
        }
        resolve(localReply(text, state, ctx, reasonOf(res && res.code, res)));
      }, function () {
        resolve(localReply(text, state, ctx, 'bad'));
      });
    });
  }

  function handleRemoteResult(res, text, state, ctx) {
    if (!res || res.ok !== true || !res.proposal) { return null; }
    var proposal = res.proposal;
    var intent = typeof proposal.intent === 'string' ? proposal.intent : '';
    if (intent === 'need_clarify') {
      var ask = remoteClarify(proposal);
      if (!ask) { return null; }
      return { state: cloneState(state), reply: ask, mode: 'online', reason: '' };
    }
    if (intent === 'query') {
      return remoteQuery(proposal, text, ctx, state);
    }
    var built = buildPlan(proposal, text, ctx, state);
    if (!built || built.ok !== true) {
      if (built && built.ask) {
        return {
          state: cloneState(state),
          reply: { kind: 'clarify', text: built.question, code: built.code, options: built.options || [] },
          mode: 'online',
          reason: ''
        };
      }
      return null;
    }
    var plan = built.plan;
    var next = cloneState(state);
    if (plan.kind === 'create') {
      var blocked = plan.items.filter(function (it) { return it.issues.length > 0; });
      if (blocked.length) {
        var pending = buildPending(plan, blocked[0], ctx);
        next.draft = plan;
        next.pending = pending;
        draftSave(plan, { note: 'waiting-clarify' });
        return {
          state: next,
          reply: {
            kind: 'clarify',
            text: pending.question,
            code: pending.code,
            options: pending.options,
            preview: previewRows(plan, ctx),
            planId: plan.id
          },
          mode: 'online',
          reason: ''
        };
      }
      next.draft = plan;
      next.pending = null;
      draftSave(plan, { note: 'waiting-confirm' });
      return { state: next, reply: previewReply(plan, ctx, ''), mode: 'online', reason: '' };
    }
    next.draft = plan;
    next.pending = null;
    draftSave(plan, { note: 'waiting-confirm' });
    return { state: next, reply: previewEdit(plan, built.target, ctx), mode: 'online', reason: '' };
  }

  /* ============================== 导出 ============================== */

  var api = {
    version: '1.0.0',
    MAX_BATCH: MAX_BATCH,
    MAX_NOTE: MAX_NOTE,
    MAX_TARGETS: MAX_TARGETS,
    MAX_ROWS: MAX_ROWS,
    DRAFT_KEY: DRAFT_KEY,
    AI_KEY: AI_KEY,
    LLM_TIMEOUT_MS: LLM_TIMEOUT_MS,
    LLM_SOFT_MS: LLM_SOFT_MS,
    LLM_BUDGET_MS: LLM_BUDGET_MS,
    LLM_RETRY: LLM_RETRY,
    E: E,
    M: M,
    TYPE_TEXT: TYPE_TEXT,
    norm: norm,
    short: short,
    fingerprint: fingerprint,
    idFor: idFor,
    contextOf: contextOf,
    detectIntent: detectIntent,
    splitSegments: splitSegments,
    stripKnown: stripKnown,
    resolveCategory: resolveCategory,
    resolveAccount: resolveAccount,
    resolveBook: resolveBook,
    resolveRange: resolveRange,
    dateLabel: dateLabel,
    parseCreate: parseCreate,
    previewRows: previewRows,
    preflight: preflight,
    applyPlan: applyPlan,
    txOfItem: txOfItem,
    findTargets: findTargets,
    buildUpdatePlan: buildUpdatePlan,
    buildDeletePlan: buildDeletePlan,
    parseQuery: parseQuery,
    queryTotals: queryTotals,
    describeFilter: describeFilter,
    analyzeFilterText: analyzeFilterText,
    deepLink: deepLink,
    respond: respond,
    initialState: initialPlanState,
    draft: {
      load: draftLoad,
      save: draftSave,
      clear: draftClear
    },
    revertEntry: revertEntry,
    briefTx: briefTx,
    previewEdit: previewEdit,
    planLabel: planLabel,
    execute: execute,
    undoEntry: undoEntry,
    /* 整批撤销的单一入口（T10） */
    undo: {
      available: undoAvailable,
      last: undoLast,
      revert: undoRevert,
      describe: undoDescribe
    },
    /* 联网段：配置读写 + 两条出站入口（传输层只在本文件，NET_ALLOW 只放这一个文件） */
    llm: {
      getConfig: llmGetConfig,
      setConfig: llmSetConfig,
      clearKey: llmClearKey,
      ready: llmReady,
      test: llmTest,
      plan: llmPlan,
      buildPlan: buildPlan,
      respondRemote: respondRemote
    },
    respondRemote: respondRemote
  };

  core.assistant = api;
  if (XZB.core && XZB.core !== core) { XZB.core.assistant = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);