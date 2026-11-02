/* ============================================================================
   小账本 2.0 · js/modules/ai-enhance.js · owner: 助手（T04）
   文件：js/modules/ai-enhance.js
   挂载：window.XZB.core.aiEnhance（Node 下可 require，便于无浏览器单测）
   依赖（全部懒取，缺失即降级）：XZB.core.aiStore / aiClient / assistant / insightqa / stats

   契约锚点：
     - 只读 cx.db（经既有 core.assistant / core.insightqa / core.stats）；不写库、不碰任何提交入口
       （写路径只有助手屏的确认按钮一处，本文件与它没有任何连线）。
     - 只产出「本地已有 kind」的 reply 片段；不新增 kind、不产生任何可确认按钮。
     - 任何本地解析失败 → 转 clarify 或原样返回本地 hint；绝不把决定权交给模型。
     - 全部数字来自本地 cents；模型文字只作为独立文本节点。
     - 本文件 0 处 fetch、0 处 localStorage 直读写（全经 ai-store）、0 处 DOM。

   流程（架构 §8.3）：ready → buildPayload（载荷最小化 + allowed 数字集）→ 工具轮（≤4）
                    → 手写 Schema 校验 → 数字守卫 → 收敛为 insight|hint|query|clarify。
   任何一步失败都走 degrade()：本地结果不动、不新增卡片、不清输入框、不写库。
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var core = XZB.core || (XZB.core = XZB.Core = XZB.Core || XZB.core || {});

  /* ============================== 常量 ============================== */

  /* 工具轮数硬上限（含首次），第 4 轮强制 answer（架构 §6.3） */
  var MAX_ROUNDS = 4;
  /* 单轮载荷里工具结果的总字符上限 */
  var MAX_TOOL_CHARS = 2000;
  /* 工具返回明细行硬上限 */
  var MAX_TOOL_ROWS = 8;
  /* 整轮 25s（架构 §8.4） */
  var T_TOTAL = 25000;
  /* 模型输出的正文长度上限：超出直接判失败，**不截断**（架构 §5.1） */
  var MAX_ANSWER = 400;
  var MAX_PAYLOAD_ROWS = 8;
  var MAX_PAYLOAD_CATEGORIES = 12;
  var MAX_NOTE = 20;

  /* 只读工具白名单：写死在常量里，任何配置都放不开 */
  var TOOL_WHITELIST = ['queryLedger', 'getInsightContext', 'getBudgetStatus', 'simulateBudget'];
  /* 永不进白名单：执行/写入/删除语义（架构 §6.2）。
     注意：这里**不写**「助手屏那个提交入口」的完整名字，因为架构 §13.3 要求
     本文件的提交入口关键字 grep 必须 0 命中；它同样被拒绝——白名单外一律 E_AI_TOOL_DENIED，
     下面的 'commit' 条目也覆盖了同名工具。 */
  var TOOL_FORBIDDEN = [
    'executeTransactionPlan', 'execute', 'undoEntry', 'applyPlan',
    'deleteTransaction', 'clearAll', 'commit', 'wipe', 'write', 'save'
  ];

  var UNKNOWN_TEXT = '这个问题我还没学会，换个说法试试？比如「这个月餐饮花了多少」。';

  /* 降级文案（架构 §9）：全部中文、全部固定键，不含变量拼接、不含绝对化承诺 */
  var DEGRADE_TEXT = {
    'E_AI_FILE_PROTOCOL': '用本地文件方式打开时不能连网，增强功能已关闭；从网址打开就能用',
    'E_AI_NO_KEY': '还没填 API Key，这次是本机在答',
    'E_AI_NO_CONSENT': '还没有开启智能增强，这次是本机在答',
    'E_AI_QUOTA': '今天额度用完了，本机助手照常可用',
    'E_AI_NET': '现在没网，这次是本机在答',
    'E_AI_CORS': '连不上这个地址，可能没放行浏览器跨域，或地址填错了',
    'E_AI_401': 'Key 不对或已失效，去设置里重新粘贴',
    'E_AI_403': '这个 Key 没有访问该模型的权限',
    'E_AI_BAD_REQUEST': '模型名可能填错了，或这个 Key 没有该模型的免费额度',
    'E_AI_NOT_FOUND': '接口地址路径不对，Base URL 一般填到 /v1 就够了',
    'E_AI_402': '这家今天额度用完了，可以继续用本机助手，或换一家',
    'E_AI_429': '这家今天额度用完了，可以继续用本机助手，或换一家',
    'E_AI_5XX': '供应商那边出问题了，稍后重试',
    'E_AI_TIMEOUT_FIRST': '等了 8 秒没回应，已切回本机',
    'E_AI_TIMEOUT_TOTAL': '这次太久了，已切回本机',
    'E_AI_TOOL_ROUNDS': '这次查得太绕了，已用本机结果代替',
    'E_AI_TOOL_DENIED': '这次回答受限，已用本机结果代替',
    'E_NUM_HALLUCINATION': '这次回答的数字和你账本对不上，我没有展示它',
    'E_NUM_DATE': '这次回答的日期和你账本对不上，我没有展示它'
  };
  var DEGRADE_DEFAULT = '这次回答没通过校验，已用本机结果代替';

  /* ============================== 注入点 ============================== */

  var CONF = { now: null };
  var probeCache = null;

  function configure(options) {
    var o = options || {};
    if (typeof o.now === 'function') { CONF.now = o.now; }
    probeCache = null;
  }

  /* ============================== 基础工具 ============================== */

  function str(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function intOr(value, fallback) {
    var n = Math.round(Number(value));
    return isFinite(n) ? n : fallback;
  }

  function nowMs() {
    if (typeof CONF.now === 'function') {
      try { return Number(CONF.now()) || 0; } catch (error) { /* 忽略 */ }
    }
    return Date.now();
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function todayLocal() {
    try {
      var dates = XZB.core && XZB.core.dates;
      if (dates && typeof dates.todayStr === 'function') {
        var fromCore = dates.todayStr();
        if (fromCore) { return String(fromCore); }
      }
    } catch (error) { /* 落到本地实现 */ }
    var d = new Date(nowMs());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayOf(cx) {
    var t = cx && cx.today ? str(cx.today) : '';
    return isDay(t) ? t : todayLocal();
  }

  function isDay(text) {
    return /^\d{4}-\d{2}-\d{2}$/.test(str(text));
  }

  function isMonth(text) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(str(text));
  }

  function fileProtocol() {
    try {
      return typeof global.location !== 'undefined' && global.location && global.location.protocol === 'file:';
    } catch (error) {
      return false;
    }
  }

  function storeOf() { return XZB.core && XZB.core.aiStore ? XZB.core.aiStore : null; }
  function clientOf() { return XZB.core && XZB.core.aiClient ? XZB.core.aiClient : null; }
  function asOf() { return XZB.core && XZB.core.assistant ? XZB.core.assistant : null; }
  function insightOf() { return XZB.core && XZB.core.insightqa ? XZB.core.insightqa : null; }
  function statsOf() { return XZB.core && XZB.core.stats ? XZB.core.stats : null; }

  function monthWindowOf(month) {
    var m = isMonth(month) ? String(month) : todayLocal().slice(0, 7);
    var year = Number(m.slice(0, 4));
    var mo = Number(m.slice(5, 7));
    var lastDay = new Date(year, mo, 0).getDate();
    return { month: m, from: m + '-01', to: m + '-' + pad2(lastDay) };
  }

  function addMonth(month, delta) {
    var m = isMonth(month) ? month : todayLocal().slice(0, 7);
    var year = Number(m.slice(0, 4));
    var mo = Number(m.slice(5, 7)) + delta;
    while (mo < 1) { mo += 12; year -= 1; }
    while (mo > 12) { mo -= 12; year += 1; }
    return year + '-' + pad2(mo);
  }

  function monthText(month) {
    var m = isMonth(month) ? month : todayLocal().slice(0, 7);
    return Number(m.slice(0, 4)) + '年' + Number(m.slice(5, 7)) + '月';
  }

  function clipText(text, max) {
    var s = str(text);
    return s.length > max ? s.slice(0, max) : s;
  }

  /* 本地金额文案：只用本地 cents 渲染，模型文字里不允许出现金额 */
  function fmtCents(cents) {
    var n = Math.round(Number(cents) || 0);
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    var yuan = Math.floor(abs / 100);
    var rest = abs % 100;
    var head = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + '¥' + head + '.' + pad2(rest);
  }

  function daysInMonth(month) {
    var m = isMonth(month) ? month : todayLocal().slice(0, 7);
    return new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  }

  /* ============================== 中文数字（0–100） ============================== */

  var CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function intToCn(value) {
    var v = Math.round(Number(value));
    if (!isFinite(v) || v < 0 || v > 100) { return String(value); }
    if (v <= 9) { return CN_DIGIT[v]; }
    if (v === 10) { return '十'; }
    if (v < 20) { return '十' + CN_DIGIT[v - 10]; }
    if (v < 100) {
      var tens = Math.floor(v / 10);
      var rest = v % 10;
      return CN_DIGIT[tens] + '十' + (rest ? CN_DIGIT[rest] : '');
    }
    return '一百';
  }

  function cnToInt(text) {
    var s = str(text).replace(/两/g, '二').trim();
    if (!s) { return NaN; }
    if (/^\d+$/.test(s)) { return Number(s); }
    if (s === '一百' || s === '百') { return 100; }
    if (s === '零') { return 0; }
    var tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
    if (tens) {
      var high = tens[1] ? CN_DIGIT.indexOf(tens[1]) : 1;
      var low = tens[2] ? CN_DIGIT.indexOf(tens[2]) : 0;
      return high * 10 + low;
    }
    var single = /^[一二三四五六七八九]$/.exec(s);
    if (single) { return CN_DIGIT.indexOf(s); }
    return NaN;
  }

  /* ============================== 数字守卫（架构 §7） ============================== */

  /* 全角 → 半角、去空白；比较前统一（不做任何语义换算） */
  function normalizeNumericText(text) {
    var s = str(text);
    s = s.replace(/[\uff10-\uff19]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
    s = s.replace(/\uff05/g, '%').replace(/\uff0e/g, '.').replace(/\uff0c/g, ',');
    s = s.replace(/\uffe5/g, '\u00a5').replace(/\uff04/g, '\u00a5');
    s = s.replace(/[ \t\u00a0\u3000]/g, '');
    return s;
  }

  /* 把载荷里所有 *Cents / *pct / count / date / month 收成类型化数值清单 */
  function collectNumbers(node, out, depth) {
    var acc = out || [];
    var level = depth || 0;
    if (!node || level > 6) { return acc; }
    if (Object.prototype.toString.call(node) === '[object Array]') {
      /* 数组长度本身也是模型会数的数（「你有 7 个分类」），必须进 allowed，否则会误判成幻觉（D15）。
         副作用是 allowed 变宽，但只会少误杀，不会让真幻觉通过。 */
      acc.push({ kind: 'count', value: node.length });
      for (var i = 0; i < node.length; i += 1) { collectNumbers(node[i], acc, level + 1); }
      return acc;
    }
    if (typeof node !== 'object') { return acc; }

    Object.keys(node).forEach(function (key) {
      var value = node[key];
      if (typeof value === 'number' && isFinite(value)) {
        if (/cents$/i.test(key)) { acc.push({ kind: 'cents', value: Math.round(value) }); }
        else if (/pct$/i.test(key) || /ratio$/i.test(key)) { acc.push({ kind: 'pct', value: Math.round(value * 10) / 10 }); }
        else if (/^(count|n|limit|rounds)$/i.test(key)) { acc.push({ kind: 'count', value: Math.round(value) }); }
        return;
      }
      if (typeof value === 'string') {
        if (/month$/i.test(key) && isMonth(value)) { acc.push({ kind: 'month', value: value }); return; }
        if (/^(date|day|today|from|to)$/i.test(key) && isDay(value)) { acc.push({ kind: 'day', value: value }); return; }
        return;
      }
      if (value && typeof value === 'object') { collectNumbers(value, acc, level + 1); }
    });
    return acc;
  }

  /* 由类型化数值清单构建 allowed 集合（等价类，全部是字符串键，便于完全相等比对） */
  function buildAllowed(numbers) {
    var out = { cents: {}, pct: {}, count: {}, day: {}, month: {} };
    var list = Object.prototype.toString.call(numbers) === '[object Array]' ? numbers : [];
    list.forEach(function (item) {
      if (!item) { return; }
      if (item.kind === 'cents') {
        var cents = Math.abs(Math.round(Number(item.value) || 0));
        out.cents[String(cents)] = true;
      } else if (item.kind === 'pct') {
        out.pct[String(Math.round(Number(item.value) * 10) / 10)] = true;
      } else if (item.kind === 'count') {
        out.count[String(Math.round(Number(item.value) || 0))] = true;
      } else if (item.kind === 'day' && isDay(item.value)) {
        out.day[String(item.value)] = true;
        out.month[String(item.value).slice(0, 7)] = true;
      } else if (item.kind === 'month' && isMonth(item.value)) {
        out.month[String(item.value)] = true;
      }
    });
    return out;
  }

  function anyDay(allowed, predicate) {
    var days = Object.keys(allowed.day || {});
    for (var i = 0; i < days.length; i += 1) {
      if (predicate(days[i])) { return true; }
    }
    return false;
  }

  function anyMonth(allowed, predicate) {
    var months = Object.keys(allowed.month || {});
    for (var i = 0; i < months.length; i += 1) {
      if (predicate(months[i])) { return true; }
    }
    return false;
  }

  /* 四组提取正则（架构 §7.2）。执行顺序按「特异性从高到低」，每命中一段立即遮蔽，
     避免金额正则把「12%」「10月1日」「3 笔」里的数字先吞掉（架构原文的三组顺序在此实现为遮蔽式） */
  var RE_PCT = /\d{1,3}(?:\.\d)?\s*%|百分之[一二三四五六七八九十百零]+/g;
  var RE_DATE = /\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月(?:\d{1,2}[日号])?|\d{1,2}月(?:\d{1,2}[日号])?/g;
  var RE_COUNT = /(\d{1,3}|[一二三四五六七八九十]{1,3})\s*笔/g;
  /* 金额：千分位分支放在前面，否则 `1,234.00` 会被 `[.,]\d{1,2}` 切成 `1,23` + `4`（D16） */
  var RE_AMOUNT = /[\u00a5\uffe5]?\s*-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\s*(?:万元|万|元|块)?|[\u00a5\uffe5]?\s*-?\d{1,9}(?:[.,]\d{1,2})?\s*(?:万元|万|元|块)?/g;

  function maskSpan(text, start, end) {
    var filler = '';
    for (var i = start; i < end; i += 1) { filler += '\u0001'; }
    return text.slice(0, start) + filler + text.slice(end);
  }

  function scanCandidates(source) {
    var work = source;
    var found = [];

    function scan(re, kind) {
      re.lastIndex = 0;
      var match = re.exec(work);
      var guard = 0;
      while (match && guard < 200) {
        guard += 1;
        var raw = match[0];
        if (raw && raw.replace(/\s/g, '')) {
          found.push({ kind: kind, raw: raw });
          work = maskSpan(work, match.index, match.index + raw.length);
          re.lastIndex = match.index;
        } else {
          re.lastIndex = match.index + Math.max(1, raw.length);
        }
        match = re.exec(work);
      }
    }

    scan(RE_PCT, 'pct');
    scan(RE_DATE, 'date');
    scan(RE_COUNT, 'count');
    scan(RE_AMOUNT, 'amount');
    return found;
  }

  function judgePct(raw, allowed) {
    var body = str(raw).replace(/[\s%]/g, '');
    var value;
    if (body.indexOf('百分之') === 0) { value = cnToInt(body.slice(3)); }
    else { value = Number(body); }
    if (!isFinite(value)) { return true; }
    return !!allowed.pct[String(Math.round(value * 10) / 10)];
  }

  function judgeCount(raw, allowed) {
    var body = str(raw).replace(/[\s笔]/g, '');
    var value = /^\d+$/.test(body) ? Number(body) : cnToInt(body);
    if (!isFinite(value)) { return true; }
    return !!allowed.count[String(Math.round(value))];
  }

  function judgeDate(raw, allowed) {
    var body = str(raw).replace(/\s/g, '');
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(body);
    if (m) {
      var full = m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
      return !!allowed.day[full];
    }
    m = /^(\d{4})年(\d{1,2})月(?:(\d{1,2})[日号])?$/.exec(body);
    if (m) {
      var mon = m[1] + '-' + pad2(Number(m[2]));
      if (!m[3]) { return !!allowed.month[mon] || anyDay(allowed, function (d) { return d.indexOf(mon) === 0; }); }
      return !!allowed.day[mon + '-' + pad2(Number(m[3]))];
    }
    m = /^(\d{1,2})月(?:(\d{1,2})[日号])?$/.exec(body);
    if (m) {
      var mm = pad2(Number(m[1]));
      if (!m[2]) {
        return anyMonth(allowed, function (key) { return key.slice(5, 7) === mm; }) ||
          anyDay(allowed, function (d) { return d.slice(5, 7) === mm; });
      }
      var dd = pad2(Number(m[2]));
      return anyDay(allowed, function (d) { return d.slice(5, 7) === mm && d.slice(8, 10) === dd; });
    }
    return true;
  }

  function judgeAmount(raw, allowed) {
    var body = str(raw).replace(/\s/g, '').replace(/^[\u00a5\uffe5-]/, '');
    var hasUnit = false;
    var times = 1;
    if (/万元$|万$/.test(body)) { hasUnit = true; times = 10000; body = body.replace(/万元$|万$/, ''); }
    else if (/元$|块$/.test(body)) { hasUnit = true; body = body.replace(/元$|块$/, ''); }
    /* 千分位先判：形如 1,234 / 1,234.56 的写法去逗号；其余情况逗号仍按小数点处理 */
    if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(body)) { body = body.replace(/,/g, ''); }
    else { body = body.replace(/,/g, '.'); }
    var value = parseFloat(body);
    if (!isFinite(value)) { return true; }
    var cents = Math.abs(Math.round(value * times * 100));
    if (allowed.cents[String(cents)]) { return true; }
    /* 无单位整数再按「笔数」比一次：「共 3 次」「第 2 名」这类不算幻觉 */
    if (!hasUnit && /^\d{1,3}$/.test(body) && allowed.count[String(Number(body))]) { return true; }
    return false;
  }

  /* guardNumbers(text, allowed) → { ok, code, hits }
     allowed 由 buildAllowed(collectNumbers(payload)) 得到；也可直接传 meta.allowed */
  function guardNumbers(text, allowed) {
    /* 容错：调用方可能只传部分集合，缺的按「空集」处理（宁可变严，不可抛异常） */
    var al = {
      cents: (allowed && allowed.cents) || {},
      pct: (allowed && allowed.pct) || {},
      count: (allowed && allowed.count) || {},
      day: (allowed && allowed.day) || {},
      month: (allowed && allowed.month) || {}
    };
    var source = normalizeNumericText(text);
    var candidates = scanCandidates(source);
    var hits = [];
    var badDate = 0;
    var badNumber = 0;

    candidates.forEach(function (item) {
      var pass = true;
      if (item.kind === 'pct') { pass = judgePct(item.raw, al); }
      else if (item.kind === 'count') { pass = judgeCount(item.raw, al); }
      else if (item.kind === 'date') { pass = judgeDate(item.raw, al); }
      else { pass = judgeAmount(item.raw, al); }
      if (!pass) {
        hits.push(str(item.raw).replace(/\s/g, ''));
        if (item.kind === 'date') { badDate += 1; } else { badNumber += 1; }
      }
    });

    if (!hits.length) { return { ok: true, code: 'OK', hits: [] }; }
    /* 只有日期不匹配 → 单独归因（架构 §7.4） */
    var code = badNumber === 0 && badDate > 0 ? 'E_NUM_DATE' : 'E_NUM_HALLUCINATION';
    return { ok: false, code: code, hits: hits };
  }

  /* ============================== 手写 Schema 校验器（架构 §5.4） ============================== */

  function fail(code, path) {
    return { ok: false, code: code, path: path || '' };
  }

  function joinPath(base, key) {
    if (!base) { return key; }
    return base + '.' + key;
  }

  function walkSchema(value, spec, path, ctx) {
    var s = spec || {};
    var p = path || '';

    if (s.type === 'object') {
      if (!value || typeof value !== 'object' || Object.prototype.toString.call(value) === '[object Array]') {
        return fail('E_SCHEMA_TYPE', p);
      }
      var keys = s.keys || {};
      var names = Object.keys(value);
      var i;
      /* 未知键直接判失败（不是忽略）：多字段是「模型跑偏」的最强信号（AC7） */
      for (i = 0; i < names.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(keys, names[i])) { return fail('E_SCHEMA_EXTRA', joinPath(p, names[i])); }
      }
      var required = s.required || [];
      for (i = 0; i < required.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, required[i])) { return fail('E_SCHEMA_MISSING', joinPath(p, required[i])); }
      }
      for (i = 0; i < names.length; i += 1) {
        var sub = walkSchema(value[names[i]], keys[names[i]], joinPath(p, names[i]), ctx);
        if (!sub.ok) { return sub; }
      }
      if (typeof s.check === 'function') {
        var code = s.check(value, ctx || {});
        if (code) { return fail(code, p); }
      }
      return { ok: true, code: 'OK', path: p };
    }

    if (s.type === 'string') {
      if (typeof value !== 'string') { return fail('E_SCHEMA_TYPE', p); }
      if (s.maxLen && value.length > s.maxLen) { return fail('E_SCHEMA_LEN', p); }
      if (s.minLen && value.length < s.minLen) { return fail('E_SCHEMA_LEN', p); }
      if (typeof s.check === 'function') {
        var textCode = s.check(value, ctx || {});
        if (textCode) { return fail(textCode, p); }
      }
      return { ok: true, code: 'OK', path: p };
    }

    if (s.type === 'string[]') {
      if (Object.prototype.toString.call(value) !== '[object Array]') { return fail('E_SCHEMA_TYPE', p); }
      if (s.maxItems && value.length > s.maxItems) { return fail('E_SCHEMA_LEN', p); }
      for (var j = 0; j < value.length; j += 1) {
        var item = value[j];
        if (typeof item !== 'string') { return fail('E_SCHEMA_TYPE', p + '[' + j + ']'); }
        if (s.maxLen && item.length > s.maxLen) { return fail('E_SCHEMA_LEN', p + '[' + j + ']'); }
        if (s.ref && ctx && ctx[s.ref] && !ctx[s.ref][item]) { return fail('E_SCHEMA_REF', p + '[' + j + ']'); }
      }
      return { ok: true, code: 'OK', path: p };
    }

    if (s.type === 'integer') {
      if (typeof value !== 'number' || !isFinite(value) || Math.round(value) !== value) { return fail('E_SCHEMA_TYPE', p); }
      /* 值域越界统一归 E_SCHEMA_LEN，避免引入新枚举 */
      if (typeof s.min === 'number' && value < s.min) { return fail('E_SCHEMA_LEN', p); }
      if (typeof s.max === 'number' && value > s.max) { return fail('E_SCHEMA_LEN', p); }
      return { ok: true, code: 'OK', path: p };
    }

    if (s.type === 'enum') {
      var values = s.values || [];
      if (values.indexOf(value) < 0) { return fail('E_SCHEMA_ENUM', p); }
      return { ok: true, code: 'OK', path: p };
    }

    /* 未知规格：宁可判失败，也不要静默放行 */
    return fail('E_SCHEMA_TYPE', p);
  }

  /* validate(value, spec, ctx) → { ok, code, path }；顺序：类型 → 未知键 → 缺必填 → 类型 → 长度 → 项数 → 枚举 → 引用 */
  function validate(value, spec, ctx) {
    try {
      return walkSchema(value, spec, '', ctx || {});
    } catch (error) {
      return fail('E_SCHEMA_TYPE', '');
    }
  }

  function checkPlainKeyword(value) {
    /* 关键词按字面量匹配，出现正则元字符即判失败（架构 §5.2） */
    if (/[.*+?^${}()|[\]\\]/.test(str(value))) { return 'E_SCHEMA_ENUM'; }
    return '';
  }

  function checkMonthValue(value, ctx) {
    if (!isMonth(value)) { return 'E_SCHEMA_ENUM'; }
    var today = ctx && isDay(ctx.today) ? ctx.today : todayLocal();
    if (String(value) > today.slice(0, 7)) { return 'E_SCHEMA_ENUM'; }
    return '';
  }

  function checkDayValue(value, ctx) {
    if (!isDay(value)) { return 'E_SCHEMA_ENUM'; }
    var today = ctx && isDay(ctx.today) ? ctx.today : todayLocal();
    if (String(value) > today) { return 'E_SCHEMA_ENUM'; }
    return '';
  }

  function checkRangeShape(value, ctx) {
    var v = value || {};
    var hasMonth = str(v.month).length > 0;
    var hasFrom = str(v.from).length > 0;
    var hasTo = str(v.to).length > 0;
    if (hasMonth && (hasFrom || hasTo)) { return 'E_SCHEMA_ENUM'; }  /* 与 month 互斥 */
    if (!hasMonth && !(hasFrom && hasTo)) { return 'E_SCHEMA_MISSING'; }
    if (hasFrom && hasTo && String(v.from) > String(v.to)) { return 'E_SCHEMA_ENUM'; }
    return '';
  }

  function anchorCheck(field) {
    return function (value, ctx) {
      var question = str(ctx && ctx.question);
      if (!question) { return ''; }
      if (question.indexOf(str(value)) < 0) { return 'E_SCHEMA_ANCHOR'; }
      return '';
    };
  }

  /* §5.1 纯文本回答 */
  var SPEC_ANSWER = {
    type: 'object',
    required: ['t', 'text', 'refs', 'confidence'],
    keys: {
      t: { type: 'enum', values: ['answer'] },
      text: { type: 'string', minLen: 1, maxLen: MAX_ANSWER },
      refs: { type: 'string[]', maxItems: 6, ref: 'metrics' },
      evidence: { type: 'string[]', maxItems: 8, ref: 'evidence' },
      confidence: { type: 'enum', values: ['ok', 'low'] }
    }
  };

  /* §5.2 查询意图 */
  var SPEC_QUERY = {
    type: 'object',
    required: ['t', 'range', 'type'],
    keys: {
      t: { type: 'enum', values: ['query'] },
      range: {
        type: 'object',
        required: [],
        keys: {
          month: { type: 'string', maxLen: 7, check: checkMonthValue },
          from: { type: 'string', maxLen: 10, check: checkDayValue },
          to: { type: 'string', maxLen: 10, check: checkDayValue }
        },
        check: checkRangeShape
      },
      type: { type: 'enum', values: ['expense', 'income', 'transfer', 'all'] },
      categoryIds: { type: 'string[]', maxItems: 3, ref: 'categories' },
      accountIds: { type: 'string[]', maxItems: 3, ref: 'accounts' },
      keyword: { type: 'string', maxLen: 12, check: checkPlainKeyword },
      excludeKeyword: { type: 'string', maxLen: 12, check: checkPlainKeyword },
      limit: { type: 'integer', min: 1, max: 20 }
    }
  };

  /* §5.3 记账候选槽位（P0 阶段 prompt 不提供该分支；T11 才接线，这里先把规格与校验器留好） */
  var SPEC_SLOTS = {
    type: 'object',
    required: ['t', 'segment', 'amountFragment', 'type'],
    keys: {
      t: { type: 'enum', values: ['slots'] },
      segment: { type: 'string', minLen: 1, maxLen: 60, check: anchorCheck('segment') },
      amountFragment: { type: 'string', minLen: 1, maxLen: 12, check: anchorCheck('amountFragment') },
      dateFragment: { type: 'string', maxLen: 8 },
      categoryHint: { type: 'string', maxLen: 8 },
      accountHint: { type: 'string', maxLen: 8 },
      type: { type: 'enum', values: ['expense', 'income', 'transfer'] }
    }
  };

  /* P1-3 表达增强：只允许改文字，不许新增字段 */
  var SPEC_EXPLAIN = {
    type: 'object',
    required: ['t', 'text', 'confidence'],
    keys: {
      t: { type: 'enum', values: ['answer'] },
      text: { type: 'string', minLen: 1, maxLen: MAX_ANSWER },
      confidence: { type: 'enum', values: ['ok', 'low'] }
    }
  };

  /* ============================== 载荷最小化 ============================== */

  function idSet(list) {
    var out = {};
    var arr = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    for (var i = 0; i < arr.length; i += 1) {
      if (arr[i] && arr[i].id) { out[String(arr[i].id)] = true; }
    }
    return out;
  }

  /* 账户真名一律替换为「账户1/账户2」，映射表不进载荷（架构 §6.3） */
  function accountLabels(cx) {
    var map = {};
    var labels = [];
    var list = Object.prototype.toString.call(cx && cx.liveAccounts) === '[object Array]' ? cx.liveAccounts : [];
    for (var i = 0; i < list.length; i += 1) {
      var id = str(list[i] && list[i].id);
      if (!id) { continue; }
      var label = '账户' + (i + 1);
      map[id] = label;
      labels.push(label);
    }
    return { map: map, labels: labels };
  }

  function categoryNames(cx) {
    var out = [];
    var list = Object.prototype.toString.call(cx && cx.liveCategories) === '[object Array]' ? cx.liveCategories : [];
    for (var i = 0; i < list.length && out.length < MAX_PAYLOAD_CATEGORIES; i += 1) {
      var name = str(list[i] && list[i].name);
      if (name) { out.push({ id: str(list[i].id), name: name }); }
    }
    return out;
  }

  function scopeTextOf(win) {
    return monthText(win.month) + '（' + win.from + ' 至 ' + win.to + '）';
  }

  function buildSystemPrompt(meta) {
    var lines = [
      '你是「小账本」APP 里的记账助手。只能依据【载荷】里给出的数据回答，不许引入外部知识，也不许推测载荷里没有的事实。',
      '【输出格式】只输出一个 JSON 对象，不要 markdown 围栏，不要任何前后解释。三种之一：',
      '1) {"t":"answer","text":"不超过400字的回答","refs":["m1"],"evidence":[],"confidence":"ok"}',
      '2) {"t":"query","range":{"month":"' + meta.month + '"},"type":"expense","categoryIds":[],"accountIds":[],"keyword":"","excludeKeyword":"","limit":8}',
      '3) {"t":"tool","name":"queryLedger|getInsightContext|getBudgetStatus|simulateBudget","args":{},"n":1}',
      '【铁律】',
      'a. 载荷里没有的数字一个都不许写。金额、百分比、日期、笔数只能用载荷里的原值，不许四舍五入、不许换算。',
      'b. 不许使用倍数、分数或「三成」「翻一倍」「三分之一」这类说法，只能用载荷里的具体数字。',
      'c. refs 只能引用载荷 metrics 里的 id；evidence 只能引用 rows 里的 id；可以给空数组。',
      'd. 账户只用载荷里的「账户1/账户2」这类代号，绝不写真实账户名。',
      'e. 最多 4 轮；第 4 轮必须直接给 answer，不许再调用工具。',
      'f. 信息不足就输出 {"t":"answer","text":"我没有足够信息回答这个问题","refs":[],"confidence":"low"}，不要编。'
    ];
    return lines.join('\n');
  }

  /* buildPayload(question, localReply, state, cx, cfg) → { messages, meta }（纯函数，可直接单测） */
  function buildPayload(question, localReply, state, cx, cfg) {
    var context = cx || {};
    var today = todayOf(context);
    var month = isMonth(localReply && localReply.range && localReply.range.month)
      ? str(localReply.range.month)
      : today.slice(0, 7);
    var win = monthWindowOf(month);
    var prevWin = monthWindowOf(addMonth(month, -1));
    var iq = insightOf();

    var payload = {
      question: clipText(question, 200),
      today: today,
      month: month,
      scope: scopeTextOf(win),
      prevMonth: prevWin.month,
      categories: [],
      accounts: [],
      thisMonth: null,
      prevMonthSummary: null,
      budget: null,
      metrics: [],
      rows: []
    };

    payload.categories = categoryNames(context);
    payload.accounts = accountLabels(context).labels;

    /* 口径一律走既有模块，禁止在本文件手写聚合（架构 §6.3） */
    if (iq && typeof iq.sumWindow === 'function' && context && context.db) {
      try {
        var cur = iq.sumWindow(context, win.from, win.to, { withItems: false });
        var old = iq.sumWindow(context, prevWin.from, prevWin.to, { withItems: false });
        payload.thisMonth = {
          count: intOr(cur.count, 0),
          expenseCents: intOr(cur.expenseCents, 0),
          incomeCents: intOr(cur.incomeCents, 0)
        };
        payload.prevMonthSummary = {
          count: intOr(old.count, 0),
          expenseCents: intOr(old.expenseCents, 0),
          incomeCents: intOr(old.incomeCents, 0)
        };
        payload.metrics.push({ id: 'm1', label: monthText(month) + '支出', cents: payload.thisMonth.expenseCents });
        payload.metrics.push({ id: 'm2', label: monthText(prevWin.month) + '支出', cents: payload.prevMonthSummary.expenseCents });
        payload.metrics.push({ id: 'm3', label: monthText(month) + '支出笔数', count: payload.thisMonth.count });
        payload.metrics.push({ id: 'm4', label: monthText(month) + '收入', cents: payload.thisMonth.incomeCents });
        if (payload.prevMonthSummary.expenseCents > 0) {
          var delta = payload.thisMonth.expenseCents - payload.prevMonthSummary.expenseCents;
          var pct = Math.round(Math.abs(delta) / payload.prevMonthSummary.expenseCents * 100);
          payload.metrics.push({ id: 'm5', label: '与上月差额', cents: Math.abs(delta) });
          payload.metrics.push({ id: 'm6', label: '与上月变动百分比', pct: pct });
        }
      } catch (error) { /* 聚合失败：载荷里就不带汇总，模型只能说不确定 */ }
    }

    /* 预算：有才发；走既有 budgetProgress 口径 */
    var stats = statsOf();
    if (stats && typeof stats.budgetProgress === 'function' && context && context.db) {
      try {
        var bp = stats.budgetProgress(context.db, month, { bookId: context.bookId });
        if (bp) {
          payload.budget = {
            budgetCents: Math.max(0, intOr(bp.totalCents, 0)),
            usedCents: Math.max(0, intOr(bp.spentCents, 0))
          };
          payload.metrics.push({ id: 'm7', label: '本月预算', cents: payload.budget.budgetCents });
          payload.metrics.push({ id: 'm8', label: '本月已用', cents: payload.budget.usedCents });
        }
      } catch (error) { /* 同上 */ }
    }

    /* 明细摘要：备注默认不发；开启 sendNote 也只取前 8 条、每条截到 20 字（P1-1） */
    var store = storeOf();
    var prefs = store && typeof store.prefs === 'function' ? store.prefs() : { sendNote: false };
    var as = asOf();
    if (prefs && prefs.sendNote === true && as && typeof as.queryTotals === 'function' && context && context.db) {
      try {
        var out = as.queryTotals(context, {
          bookId: context.bookId,
          from: win.from,
          to: win.to,
          type: 'expense',
          label: monthText(month)
        });
        var rowLabels = accountLabels(context);
        var rows = Object.prototype.toString.call(out && out.rows) === '[object Array]' ? out.rows : [];
        payload.rows = rows.slice(0, MAX_PAYLOAD_ROWS).map(function (row, index) {
          return {
            id: 'e' + (index + 1),
            txId: str(row.id),
            date: str(row.date),
            cents: intOr(row.amountCents, 0),
            categoryName: str(row.categoryText),
            /* rowLabels.map 是「账户 id → 账户N」的映射表；写成 labels.map[...] 会命中 Array.prototype.map
               函数本身，结果恒为 undefined，所有行都退化成「账户1」——那会连带触发数字守卫误杀（D14） */
            accountLabel: rowLabels.map[String(row.accountId)] || '账户1',
            note: clipText(str(row.note), MAX_NOTE)
          };
        });
      } catch (error) { payload.rows = []; }
    }

    /* refs 白名单：只允许引用 metrics 的 id / rows 的 id */
    var metricSet = {};
    payload.metrics.forEach(function (item) { metricSet[item.id] = true; });
    var evidenceSet = {};
    payload.rows.forEach(function (item) { evidenceSet[item.id] = true; });

    var numbers = collectNumbers(payload);
    /* 「账户1/账户2」里的数字是代号，不是金额。若不让它进 allowed，模型越老实越被误杀：
       数字守卫会把「账户2」里的 2 当金额候选 → E_NUM_HALLUCINATION → 整段回答被丢弃。
       只注册 1..N（N = 账户数），「账户9」这种不存在的代号仍然会被抓。 */
    for (var accIndex = 1; accIndex <= payload.accounts.length; accIndex += 1) {
      numbers.push({ kind: 'count', value: accIndex });
    }
    var meta = {
      month: month,
      today: today,
      scope: payload.scope,
      metrics: payload.metrics,
      idSet: metricSet,
      evidenceSet: evidenceSet,
      numbers: numbers,
      allowed: buildAllowed(numbers),
      truncated: payload.rows.length >= MAX_PAYLOAD_ROWS,
      toolRounds: 0,
      state: state || null,
      cfgActive: str(cfg && cfg.active)
    };

    var messages = [
      { role: 'system', content: buildSystemPrompt(meta) },
      {
        role: 'user',
        content: '【载荷】\n' + JSON.stringify(payload) + '\n【用户问题】\n' + clipText(question, 200)
      }
    ];

    return { messages: messages, meta: meta, payload: payload };
  }

  /* ============================== 只读工具（白名单） ============================== */

  function toolUnavailable() { return { ok: false, code: 'E_AI_TOOL_UNAVAILABLE' }; }
  function toolBadArgs() { return { ok: false, code: 'E_AI_TOOL_ARGS' }; }

  function pickId(list, pool) {
    var arr = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    var set = idSet(pool);
    for (var i = 0; i < arr.length; i += 1) {
      if (set[str(arr[i])]) { return str(arr[i]); }
    }
    return '';
  }

  function toolQueryLedger(args, cx, meta) {
    var as = asOf();
    if (!as || typeof as.queryTotals !== 'function' || !cx || !cx.db) { return toolUnavailable(); }

    var today = todayOf(cx);
    var from = str(args.from);
    var to = str(args.to);
    var month = str(args.month);
    if (isMonth(month) && !from && !to) {
      var win = monthWindowOf(month);
      from = win.from;
      to = win.to;
    }
    if (!isDay(from) || !isDay(to)) {
      var base = monthWindowOf(today.slice(0, 7));
      from = base.from;
      to = base.to;
    }
    /* 整月查询时 to 可能晚于今天：夹到今天，未来日期不参与查询 */
    if (to > today) { to = today; }
    if (from > to) { return toolBadArgs(); }

    var type = ['expense', 'income', 'transfer', 'all'].indexOf(str(args.type)) >= 0 ? str(args.type) : 'expense';
    var limit = Math.min(MAX_TOOL_ROWS, Math.max(1, intOr(args.limit, MAX_TOOL_ROWS)));
    var keyword = clipText(str(args.keyword), 12);
    var exclude = clipText(str(args.exclude), 12);
    var categoryId = pickId(args.categoryIds, cx.liveCategories);

    var out = as.queryTotals(cx, {
      bookId: cx.bookId,
      from: from,
      to: to,
      type: type === 'all' ? '' : type,
      categoryId: categoryId,
      keyword: keyword,
      /* 排除词交给 queryTotals 在**合计阶段**剔除，不在这里事后过滤行（否则合计仍含被排除那笔，D17） */
      exclude: exclude,
      label: monthText(from.slice(0, 7))
    });

    var all = Object.prototype.toString.call(out && out.rows) === '[object Array]' ? out.rows : [];
    var rows = [];
    for (var i = 0; i < all.length && rows.length < limit; i += 1) {
      rows.push({
        id: str(all[i].id),
        date: str(all[i].date),
        cents: intOr(all[i].amountCents, 0),
        categoryName: str(all[i].categoryText)
      });
    }

    return {
      ok: true,
      data: {
        summary: {
          count: intOr(out.count, 0),
          expenseCents: intOr(out.expenseCents, 0),
          incomeCents: intOr(out.incomeCents, 0)
        },
        rows: rows,
        truncated: out.truncated === true || rows.length < all.length
      }
    };
  }

  function toolInsightContext(args, cx) {
    var iq = insightOf();
    if (!iq || typeof iq.sumWindow !== 'function' || !cx || !cx.db) { return toolUnavailable(); }
    var today = todayOf(cx);
    var month = isMonth(args.month) ? str(args.month) : today.slice(0, 7);
    var win = monthWindowOf(month);
    var prevWin = monthWindowOf(addMonth(month, -1));
    var categoryId = str(args.categoryId);

    var cur = iq.sumWindow(cx, win.from, win.to, { withItems: false });
    var old = iq.sumWindow(cx, prevWin.from, prevWin.to, { withItems: false });

    var totalCents = categoryId && cur.byCat && cur.byCat[categoryId]
      ? intOr(cur.byCat[categoryId].amountCents, 0)
      : intOr(cur.expenseCents, 0);
    var baseCents = categoryId && old.byCat && old.byCat[categoryId]
      ? intOr(old.byCat[categoryId].amountCents, 0)
      : intOr(old.expenseCents, 0);

    var names = {};
    var cats = Object.prototype.toString.call(cx.liveCategories) === '[object Array]' ? cx.liveCategories : [];
    for (var i = 0; i < cats.length; i += 1) { names[str(cats[i].id)] = str(cats[i].name); }

    var changes = [];
    var ids = {};
    var key;
    for (key in cur.byCat) { if (Object.prototype.hasOwnProperty.call(cur.byCat, key)) { ids[key] = true; } }
    for (key in old.byCat) { if (Object.prototype.hasOwnProperty.call(old.byCat, key)) { ids[key] = true; } }
    Object.keys(ids).forEach(function (id) {
      var now = cur.byCat[id] ? intOr(cur.byCat[id].amountCents, 0) : 0;
      var before = old.byCat[id] ? intOr(old.byCat[id].amountCents, 0) : 0;
      var diff = now - before;
      if (!diff) { return; }
      changes.push({
        categoryName: names[id] || '未分类',
        deltaCents: diff,
        count: cur.byCat[id] ? intOr(cur.byCat[id].count, 0) : 0
      });
    });
    changes.sort(function (a, b) { return Math.abs(b.deltaCents) - Math.abs(a.deltaCents); });

    return {
      ok: true,
      data: {
        month: month,
        baseMonth: prevWin.month,
        totalCents: totalCents,
        momDeltaCents: totalCents - baseCents,
        topChanges: changes.slice(0, 5),
        scopeText: scopeTextOf(win)
      }
    };
  }

  function toolBudgetStatus(args, cx) {
    var stats = statsOf();
    if (!stats || typeof stats.budgetProgress !== 'function' || !cx || !cx.db) { return toolUnavailable(); }
    var today = todayOf(cx);
    var month = isMonth(args.month) ? str(args.month) : today.slice(0, 7);
    var bp = null;
    try { bp = stats.budgetProgress(cx.db, month, { bookId: cx.bookId }); } catch (error) { bp = null; }
    if (!bp) { return toolUnavailable(); }

    var budgetCents = Math.max(0, intOr(bp.totalCents, 0));
    var usedCents = Math.max(0, intOr(bp.spentCents, 0));
    var isCurrent = month === today.slice(0, 7);
    var dim = daysInMonth(month);
    var elapsed = isCurrent ? Math.max(1, Number(today.slice(8, 10))) : dim;
    var dailyAvgCents = Math.round(usedCents / elapsed);

    return {
      ok: true,
      data: {
        budgetCents: budgetCents,
        usedCents: usedCents,
        remainCents: Math.max(0, budgetCents - usedCents),
        dailyAvgCents: dailyAvgCents,
        forecastCents: dailyAvgCents * dim,
        assumption: '按本月已过天数的日均线性推算，非承诺值'
      }
    };
  }

  function toolSimulateBudget(args, cx) {
    var today = todayOf(cx);
    var month = isMonth(args.month) ? str(args.month) : today.slice(0, 7);
    var dim = daysInMonth(month);
    var isCurrent = month === today.slice(0, 7);
    var elapsed = isCurrent ? Math.max(1, Number(today.slice(8, 10))) : dim;
    var left = Math.max(0, dim - elapsed);

    var hasDaily = args.dailySaveCents !== undefined && args.dailySaveCents !== null;
    var hasTarget = args.targetBudgetCents !== undefined && args.targetBudgetCents !== null;
    if (!hasDaily && !hasTarget) { return toolBadArgs(); }

    var status = toolBudgetStatus({ month: month }, cx);
    var usedCents = status.ok ? status.data.usedCents : 0;
    var dailyAvgCents = status.ok ? status.data.dailyAvgCents : 0;
    var dailySaveCents = hasDaily ? Math.min(50000, Math.max(0, intOr(args.dailySaveCents, 0))) : 0;

    var projectedCents = usedCents + dailyAvgCents * left - dailySaveCents * left;
    if (projectedCents < 0) { projectedCents = 0; }

    var verdict;
    if (hasTarget) {
      var target = Math.max(0, intOr(args.targetBudgetCents, 0));
      verdict = projectedCents <= target ? '按当前节奏能落在目标以内' : '按当前节奏会超出目标';
    } else {
      verdict = dailySaveCents > 0 ? '按这个节奏省，月底可少花一部分' : '没有设置每天要省的钱';
    }

    return {
      ok: true,
      data: {
        savedCents: dailySaveCents * left,
        projectedCents: projectedCents,
        verdict: verdict
      }
    };
  }

  /* runTool(name, args, cx) → { ok, data } 或 { ok:false, code }；name 必须命中白名单 */
  function runTool(name, args, cx) {
    var tool = str(name);
    if (TOOL_FORBIDDEN.indexOf(tool) >= 0) { return { ok: false, code: 'E_AI_TOOL_DENIED' }; }
    if (TOOL_WHITELIST.indexOf(tool) < 0) { return { ok: false, code: 'E_AI_TOOL_DENIED' }; }
    var a = args && typeof args === 'object' && Object.prototype.toString.call(args) !== '[object Array]' ? args : {};
    try {
      if (tool === 'queryLedger') { return toolQueryLedger(a, cx); }
      if (tool === 'getInsightContext') { return toolInsightContext(a, cx); }
      if (tool === 'getBudgetStatus') { return toolBudgetStatus(a, cx); }
      if (tool === 'simulateBudget') { return toolSimulateBudget(a, cx); }
    } catch (error) {
      return { ok: false, code: 'E_AI_TOOL_FAILED' };
    }
    return { ok: false, code: 'E_AI_TOOL_DENIED' };
  }

  /* ============================== 就绪判定 ============================== */

  function probeInfo() {
    if (probeCache) { return probeCache; }
    var cl = clientOf();
    probeCache = cl && typeof cl.probe === 'function' ? cl.probe() : { stream: false, fetch: false, abort: false };
    return probeCache;
  }

  /* ready(cx) → { ok, code }；纯内存同步判定，不读 localStorage（store 内部已缓存）、不遍历 db */
  function ready(cx) {
    var st = storeOf();
    if (!st) { return { ok: false, code: 'E_CHUNK_UNLOADED' }; }
    /* 平台判据必须排在 consent 之前：D1 之后 store 在 file:// 下恒授予 granted:false，
       若先判 consent 就会一律返回 E_AI_NO_CONSENT，用户跑去设置页只看到一个禁用开关，
       永远看不到「本地文件方式不能联网」这句真正的解释（D18）。 */
    if (fileProtocol()) { return { ok: false, code: 'E_AI_FILE_PROTOCOL' }; }
    if (st.consent().granted !== true) { return { ok: false, code: 'E_AI_NO_CONSENT' }; }
    if (!st.hasKey()) { return { ok: false, code: 'E_AI_NO_KEY' }; }
    var u = st.usage();
    if (u.count >= u.limit) { return { ok: false, code: 'E_AI_QUOTA' }; }
    if (!probeInfo().fetch) { return { ok: false, code: 'E_AI_NET' }; }
    return { ok: true, code: 'OK' };
  }

  /* shouldEnhance(reply) → boolean；只有 hint 才可能为真，clarify 恒假（P0-3） */
  function shouldEnhance(reply) {
    if (!reply || reply.kind !== 'hint') { return false; }
    return ready(null).ok === true;
  }

  function invalidate() {
    probeCache = null;
  }

  /* ============================== 结果收敛 ============================== */

  function copyReply(reply) {
    var out = {};
    if (!reply || typeof reply !== 'object') { return out; }
    Object.keys(reply).forEach(function (key) { out[key] = reply[key]; });
    return out;
  }

  function degradeReason(code) {
    var key = str(code);
    if (DEGRADE_TEXT[key] !== undefined) { return DEGRADE_TEXT[key]; }
    if (key.indexOf('E_NUM_') === 0) { return DEGRADE_TEXT['E_NUM_HALLUCINATION']; }
    if (key.indexOf('E_SCHEMA_') === 0) { return DEGRADE_DEFAULT; }
    return DEGRADE_DEFAULT;
  }

  /* 降级：本地结果一字不动，只挂一行说明 */
  function degrade(localReply, code) {
    var out = copyReply(localReply);
    if (!out.text) { out.text = UNKNOWN_TEXT; }
    if (!out.kind) { out.kind = 'hint'; }
    out.source = 'local';
    out.provider = '';
    out.degrade = { code: str(code), text: degradeReason(code) };
    return out;
  }

  function bump(store, providerId, ok, firstByteMs, counted) {
    if (!store || typeof store.bumpUsage !== 'function') { return; }
    try {
      store.bumpUsage({ providerId: providerId, ok: ok === true, firstByteMs: firstByteMs || 0, counted: counted !== false });
    } catch (error) { /* 计数失败不得影响结果 */ }
  }

  function convergeKind(localReply) {
    var kind = localReply && localReply.kind ? str(localReply.kind) : '';
    if (kind === 'query' || kind === 'clarify' || kind === 'insight' || kind === 'hint') { return kind; }
    return 'insight';
  }

  function convergeAnswer(localReply, obj) {
    var out = copyReply(localReply);
    out.kind = localReply && localReply.kind === 'query' ? 'query' : 'insight';
    out.text = str(obj.text);
    out.source = 'remote';
    out.degrade = null;
    out.confidence = str(obj.confidence) || 'ok';
    out.refs = Object.prototype.toString.call(obj.refs) === '[object Array]' ? obj.refs.slice(0) : [];
    /* rows / totals / metrics 一律来自本地，模型产物概不采纳 */
    if (!out.rows && localReply && localReply.rows) { out.rows = localReply.rows; }
    return out;
  }

  function parseModelJson(text) {
    var cl = clientOf();
    var raw = cl && typeof cl.stripFences === 'function' ? cl.stripFences(text) : str(text).trim();
    var direct = null;
    try { direct = JSON.parse(raw); } catch (error) { direct = null; }
    if (direct && typeof direct === 'object' && Object.prototype.toString.call(direct) !== '[object Array]') { return direct; }
    /* 兜底：抓第一对配平的 {} */
    var start = raw.indexOf('{');
    if (start < 0) { return null; }
    var depth = 0;
    for (var i = start; i < raw.length; i += 1) {
      var ch = raw.charAt(i);
      if (ch === '{') { depth += 1; }
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch (error) { return null; }
        }
      }
    }
    return null;
  }

  function previewOf(rawText) {
    /* 流式阶段只做「尽力预览」：抓到 "text":"…" 的前半截就吐出来，抓不到就返回空串。
       真正的展示以最终校验通过的 text 为准（T06 只 patch 文本节点）。 */
    var s = str(rawText);
    var m = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s);
    if (!m) { return ''; }
    var body = m[1];
    try { return JSON.parse('"' + body + '"'); } catch (error) { return body.replace(/\\n/g, '\n'); }
  }

  function queryFromRange(range, today) {
    var r = range || {};
    if (isMonth(r.month)) {
      var win = monthWindowOf(r.month);
      return { from: win.from, to: win.to, month: win.month };
    }
    var from = isDay(r.from) ? str(r.from) : today;
    var to = isDay(r.to) ? str(r.to) : today;
    return { from: from, to: to, month: from.slice(0, 7) };
  }

  function finishQuery(obj, localReply, cx, meta, provider) {
    var context = cx || {};
    var today = todayOf(context);
    var verdict = validate(obj, SPEC_QUERY, {
      today: today,
      categories: idSet(context.liveCategories),
      accounts: idSet(context.liveAccounts)
    });
    if (!verdict.ok) { return { reply: degrade(localReply, verdict.code), code: verdict.code }; }

    var as = asOf();
    if (!as || typeof as.queryTotals !== 'function') {
      return { reply: degrade(localReply, 'E_AI_TOOL_UNAVAILABLE'), code: 'E_AI_TOOL_UNAVAILABLE' };
    }

    var win = queryFromRange(obj.range, today);
    var type = str(obj.type);
    var keyword = clipText(str(obj.keyword), 12);
    var exclude = clipText(str(obj.excludeKeyword), 12);
    var limit = Math.min(20, Math.max(1, intOr(obj.limit, 8)));
    var cats = Object.prototype.toString.call(obj.categoryIds) === '[object Array]' ? obj.categoryIds : [];
    var accs = Object.prototype.toString.call(obj.accountIds) === '[object Array]' ? obj.accountIds : [];

    function runOnce(categoryId, accountId) {
      return as.queryTotals(context, {
        bookId: context.bookId,
        from: win.from,
        to: win.to,
        type: type === 'all' ? '' : type,
        categoryId: categoryId,
        accountId: accountId,
        keyword: keyword,
        /* 同 toolQueryLedger：排除词在合计阶段生效，不在展示层事后过滤（D17） */
        exclude: exclude,
        label: monthText(win.month)
      });
    }

    var result = null;
    try {
      if (cats.length <= 1 && accs.length <= 1) {
        result = runOnce(cats[0] || '', accs[0] || '');
      } else {
        /* 多分类/多账户：逐个跑既有口径再合并，绝不在本文件手写聚合 */
        var merged = { count: 0, expenseCents: 0, incomeCents: 0, rows: [], truncated: false };
        var combos = [];
        var i;
        var j;
        for (i = 0; i < Math.max(1, cats.length); i += 1) {
          for (j = 0; j < Math.max(1, accs.length); j += 1) {
            combos.push([cats[i] || '', accs[j] || '']);
          }
        }
        for (i = 0; i < combos.length; i += 1) {
          var part = runOnce(combos[i][0], combos[i][1]);
          merged.count += intOr(part.count, 0);
          merged.expenseCents += intOr(part.expenseCents, 0);
          merged.incomeCents += intOr(part.incomeCents, 0);
          merged.truncated = merged.truncated || part.truncated === true;
          merged.rows = merged.rows.concat(part.rows || []);
        }
        result = merged;
      }
    } catch (error) {
      return { reply: degrade(localReply, 'E_AI_TOOL_FAILED'), code: 'E_AI_TOOL_FAILED' };
    }

    /* 合计已在 queryTotals 里排除过；这里只做展示用的行数截断，不再二次过滤 */
    var rows = (result.rows || []).slice(0, limit);

    var parts = [];
    parts.push('按你的描述查了一下：' + scopeTextOf(monthWindowOf(win.month)));
    parts.push('共 ' + intOr(result.count, 0) + ' 笔');
    if (type !== 'income') { parts.push('支出 ' + fmtCents(result.expenseCents)); }
    if (type !== 'expense') { parts.push('收入 ' + fmtCents(result.incomeCents)); }

    var out = copyReply(localReply);
    out.kind = 'query';
    out.text = parts.join('，') + '。';
    out.source = 'remote';
    out.provider = provider && (provider.name || provider.id) ? (provider.name || provider.id) : '';
    out.degrade = null;
    out.rows = rows;
    out.totals = {
      count: intOr(result.count, 0),
      expenseCents: intOr(result.expenseCents, 0),
      incomeCents: intOr(result.incomeCents, 0)
    };
    out.filter = { from: win.from, to: win.to, type: type, month: win.month };
    return { reply: out, code: 'OK' };
  }

  /* ============================== 主流程 ============================== */

  /* run({question, localReply, state, cx, signal, ctl, onDelta, onPhase, retry}) → Promise<Reply> */
  function run(opts) {
    var o = opts || {};
    var localReply = o.localReply || null;
    var question = str(o.question);
    var context = o.cx || {};
    var store = storeOf();
    var cl = clientOf();

    var gate = ready(context);
    if (!gate.ok) { return Promise.resolve(degrade(localReply, gate.code)); }
    if (!store || !cl) { return Promise.resolve(degrade(localReply, 'E_AI_NET')); }

    var active = store.getActive();
    var built = buildPayload(question, localReply, o.state, context, store.load());
    var meta = built.meta;
    var messages = built.messages.slice(0);
    var provider = {
      id: active.id,
      key: store.revealKey(active.id),
      model: active.model,
      baseUrl: active.baseUrl,
      name: active.name || store.labelOf(active.id)
    };
    var counted = o.retry === true ? false : true;

    var ctl = o.ctl && typeof o.ctl.abort === 'function' ? o.ctl : cl.abortHandle();
    var round = 0;
    var timedOut = false;
    var firstByteMs = 0;
    var startedAt = nowMs();
    var timer = null;

    function phase(name) {
      try { if (typeof o.onPhase === 'function') { o.onPhase(name); } } catch (error) { /* 忽略 */ }
    }

    function stopTimer() {
      if (timer && typeof global.clearTimeout === 'function') { global.clearTimeout(timer); timer = null; }
    }

    function stoppedReply(text) {
      var out = convergeAnswerSkeleton(localReply);
      out.kind = convergeKind(localReply);
      out.text = (text || (localReply && localReply.text) || '') + '（已停止）';
      out.source = 'local';
      out.provider = '';
      out.degrade = null;
      return out;
    }

    /* 整轮 25s（架构 §8.4） */
    if (typeof global.setTimeout === 'function') {
      timer = global.setTimeout(function () {
        timedOut = true;
        try { ctl.abort(); } catch (error) { /* 已结束 */ }
      }, T_TOTAL);
    }

    function attempt() {
      round += 1;
      meta.toolRounds = round;
      phase(round === 1 ? 'thinking' : 'thinking');

      return cl.chat({
        provider: provider,
        messages: messages,
        maxTokens: 700,
        stream: true,
        ctl: ctl
      }, {
        onFirstByte: function (info) {
          firstByteMs = info && info.ms ? intOr(info.ms, 0) : Math.max(0, nowMs() - startedAt);
          phase('streaming');
        },
        onDelta: function (delta, all) {
          try {
            if (typeof o.onDelta === 'function') { o.onDelta(delta, all, previewOf(all)); }
          } catch (error) { /* 忽略 */ }
        }
      }).then(function (res) {
        if (timedOut) {
          stopTimer();
          bump(store, provider.id, false, 0, counted);
          return degrade(localReply, 'E_AI_TIMEOUT_TOTAL');
        }
        if (!res.ok) {
          if (res.code === 'E_AI_ABORTED' || ctl.aborted) {
            stopTimer();
            /* 用户主动停止：确实消耗了供应商额度，计一次 */
            bump(store, provider.id, true, firstByteMs, counted);
            phase('stopped');
            return stoppedReply('');
          }
          stopTimer();
          bump(store, provider.id, false, 0, counted);
          return degrade(localReply, res.code);
        }
        return dispatch(res);
      }, function () {
        stopTimer();
        bump(store, provider.id, false, 0, counted);
        return degrade(localReply, 'E_AI_NET');
      });
    }

    function dispatch(res) {
      var obj = parseModelJson(res.text);
      if (!obj) {
        stopTimer();
        bump(store, provider.id, false, 0, counted);
        return degrade(localReply, 'E_SCHEMA_JSON');
      }

      var t = str(obj.t);

      if (t === 'tool') {
        /* 第 4 轮必须 answer，收到 tool 直接判失败（架构 §6.1） */
        var toolResult = round >= MAX_ROUNDS ? { ok: false, code: 'E_AI_TOOL_ROUNDS' } : runTool(obj.name, obj.args, context);
        if (!toolResult.ok) {
          stopTimer();
          bump(store, provider.id, false, 0, counted);
          return degrade(localReply, toolResult.code);
        }
        messages.push({ role: 'assistant', content: clipText(JSON.stringify(obj), MAX_TOOL_CHARS) });
        messages.push({
          role: 'user',
          content: 'TOOL_RESULT n=' + round + ' ' + clipText(JSON.stringify(toolResult.data || {}), MAX_TOOL_CHARS)
        });
        /* 工具结果里的数字也进 allowed 集合：后续 answer 可以引用它们 */
        var extra = collectNumbers(toolResult.data);
        extra.forEach(function (item) { meta.numbers.push(item); });
        meta.allowed = buildAllowed(meta.numbers);
        return attempt();
      }

      if (t === 'slots') {
        /* P0 阶段 prompt 不提供该分支；本批只保留 Schema（T11 才接线） */
        stopTimer();
        bump(store, provider.id, false, 0, counted);
        return degrade(localReply, 'E_SCHEMA_ENUM');
      }

      if (t === 'query') {
        var q = finishQuery(obj, localReply, context, meta, provider);
        stopTimer();
        bump(store, provider.id, q.code === 'OK', firstByteMs, counted);
        return q.reply;
      }

      if (t === 'answer') {
        var verdict = validate(obj, SPEC_ANSWER, {
          metrics: meta.idSet,
          evidence: meta.evidenceSet,
          today: meta.today
        });
        if (!verdict.ok) {
          stopTimer();
          bump(store, provider.id, false, 0, counted);
          return degrade(localReply, verdict.code);
        }
        var guardResult = guardNumbers(obj.text, meta.allowed);
        if (!guardResult.ok) {
          stopTimer();
          bump(store, provider.id, false, 0, counted);
          var fallback = degrade(localReply, guardResult.code);
          fallback.guardHits = guardResult.hits.slice(0, 5);
          return fallback;
        }
        stopTimer();
        bump(store, provider.id, true, firstByteMs, counted);
        var answer = convergeAnswer(localReply, obj);
        answer.provider = provider.name || provider.id;
        answer.truncated = meta.truncated === true;
        return answer;
      }

      stopTimer();
      bump(store, provider.id, false, 0, counted);
      return degrade(localReply, 'E_SCHEMA_ENUM');
    }

    return attempt();
  }

  function convergeAnswerSkeleton(localReply) {
    var out = copyReply(localReply);
    if (!out.kind) { out.kind = 'hint'; }
    return out;
  }

  /* explain({reply, cx, signal, ctl, onDelta}) → Promise<Reply>：只重写文字，rows/totals/metrics 原样带回 */
  function explain(opts) {
    var o = opts || {};
    var reply = o.reply || {};
    var context = o.cx || {};
    var store = storeOf();
    var cl = clientOf();

    var gate = ready(context);
    if (!gate.ok) { return Promise.resolve(degrade(reply, gate.code)); }
    if (!store || !cl) { return Promise.resolve(degrade(reply, 'E_AI_NET')); }

    var active = store.getActive();
    var provider = {
      id: active.id,
      key: store.revealKey(active.id),
      model: active.model,
      baseUrl: active.baseUrl,
      name: active.name || store.labelOf(active.id)
    };

    var sourceText = clipText(str(reply.text), MAX_ANSWER);
    var numbers = collectNumbers({
      text: '',
      metrics: reply.metrics || [],
      totals: reply.totals || null,
      rows: reply.rows || [],
      today: todayOf(context),
      month: todayOf(context).slice(0, 7)
    });
    var allowed = buildAllowed(numbers);

    var messages = [
      {
        role: 'system',
        content: [
          '你负责把一段已有的记账结论换一种更自然的中文说法。',
          '只输出一个 JSON 对象：{"t":"answer","text":"不超过400字","confidence":"ok"}',
          '铁律：数字一个都不许改、不许新增、不许换算；不许用倍数/分数表达；不许加入原文没有的事实。'
        ].join('\n')
      },
      { role: 'user', content: '【原文】\n' + sourceText }
    ];

    var ctl = o.ctl && typeof o.ctl.abort === 'function' ? o.ctl : cl.abortHandle();
    var startedAt = nowMs();
    var firstByteMs = 0;

    return cl.chat({ provider: provider, messages: messages, maxTokens: 700, stream: true, ctl: ctl }, {
      onFirstByte: function (info) { firstByteMs = info && info.ms ? intOr(info.ms, 0) : 0; },
      onDelta: function (delta, all) {
        try { if (typeof o.onDelta === 'function') { o.onDelta(delta, all, previewOf(all)); } } catch (error) { /* 忽略 */ }
      }
    }).then(function (res) {
      if (!res.ok) {
        bump(store, provider.id, false, 0, true);
        return degrade(reply, res.code);
      }
      bump(store, provider.id, true, firstByteMs, true);
      var obj = parseModelJson(res.text);
      if (!obj) { return degrade(reply, 'E_SCHEMA_JSON'); }
      var verdict = validate(obj, SPEC_EXPLAIN, { today: todayOf(context) });
      if (!verdict.ok) { return degrade(reply, verdict.code); }
      var guardResult = guardNumbers(obj.text, allowed);
      if (!guardResult.ok) { return degrade(reply, guardResult.code); }

      var out = copyReply(reply);
      out.text = str(obj.text);
      out.source = 'remote';
      out.provider = provider.name || provider.id;
      out.degrade = null;
      out.rewritten = true;
      /* rows / totals / metrics 原样带回：解释动作不碰任何数字结构 */
      out.rows = reply.rows;
      out.totals = reply.totals;
      out.metrics = reply.metrics;
      return out;
    }, function () {
      bump(store, provider.id, false, 0, true);
      return degrade(reply, 'E_AI_NET');
    });
  }

  /* ============================== 导出 ============================== */

  var api = {
    /* 契约 API（架构 §3.3） */
    ready: ready,
    shouldEnhance: shouldEnhance,
    run: run,
    explain: explain,
    buildPayload: buildPayload,
    runTool: runTool,
    validate: validate,
    guardNumbers: guardNumbers,
    invalidate: invalidate,

    /* 测试与 UI 需要的外露（不改变上面任何契约） */
    configure: configure,
    collectNumbers: collectNumbers,
    buildAllowed: buildAllowed,
    degradeReason: degradeReason,
    monthWindow: monthWindowOf,
    intToCn: intToCn,
    cnToInt: cnToInt,

    /* 规格与常量：T11 接线 t:"slots" 时直接复用，禁止另写一套 */
    SPEC_ANSWER: SPEC_ANSWER,
    SPEC_QUERY: SPEC_QUERY,
    SPEC_SLOTS: SPEC_SLOTS,
    SPEC_EXPLAIN: SPEC_EXPLAIN,
    TOOL_WHITELIST: TOOL_WHITELIST,
    TOOL_FORBIDDEN: TOOL_FORBIDDEN,
    MAX_ROUNDS: MAX_ROUNDS,
    MAX_ANSWER: MAX_ANSWER,
    DEGRADE_TEXT: DEGRADE_TEXT
  };

  core.aiEnhance = api;
  if (XZB.core && XZB.core !== core) { XZB.core.aiEnhance = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
