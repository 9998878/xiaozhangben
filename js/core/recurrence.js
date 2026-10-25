/* ============================================================================
   小账本 2.0 · 周期账单算法（T09）
   文件：src/js/core/recurrence.js
   加载：money → dates → schema → store → migrate → stats → nl → recurrence → ...
   挂载：window.XZB.core.recurrence
   依赖：XZB.core.dates（本地日期串工具）、XZB.core.schema（实体归一化 / 校验 / ID）

   约定（INTERFACE-FREEZE §8 + D16.3）：
   1. 日期一律为本地字符串 'YYYY-MM-DD'，禁止 new Date('YYYY-MM-DD')；
   2. 金额一律为分（整数）；
   3. weekly.weekday 存 0=周日…6=周六（D16.3），与 dates.weekdayIndex（周一=0）
      的换算恒等式：sun0 = (weekdayIndex + 1) % 7；
   4. 幂等键 periodKey = ruleId + '@' + dueDate（与 schema.PERIOD_KEY_RE 一致），
      同一期永远同一个键；已入账（含已被软删的流水）不再入账；
   5. endDate 含端点；nextDueDate > endDate ⇒ null。

   对外 API：
   - 纯算法：normalizeRule / validateRule / canSchedule / nextDueDate / nextDue
     / instancesBetween / dueBetween / isDue / freqText / weekdayText
   - 幂等键：makePeriodKey / periodKeyOf / parsePeriodKey / findByPeriodKey
   - 待入账：dueInstances
   - 落库：postInstance / catchUp（在 store.transaction 的 draft 上同步执行）
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB = global.XZB || {};
  var core = XZB.core = XZB.core || (XZB.Core = XZB.Core || {});
  XZB.Core = core;
  XZB.version = XZB.version || '2.2.0';

  /* ============================== 常量 ============================== */

  var FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
  var MAX_INTERVAL = 99;          /* §2.9 interval 1–99 */
  var MAX_DAY_OF_MONTH = 28;      /* D16.3：dayOfMonth 上限 28 */
  var MAX_CATCH_UP = 31;          /* catchUp 默认最多补 31 期 */
  var MAX_PER_RULE = 120;         /* §6.3 materialize：单条规则单次最多 120 条 */
  var MAX_SCAN_PER_RULE = 1000;   /* 单条规则扫描上限，防脏数据死循环 */
  var MAX_BETWEEN = 5000;         /* instancesBetween 结果上限，防误用 */
  var MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var FREQ_NAMES = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };

  var MESSAGES = {
    E_RECURRING_RULE: '周期规则不完整',
    E_RECURRING_NOT_FOUND: '定期账单不存在',
    E_INVALID_INPUT: '输入不完整或格式不对',
    E_SCHEMA_INVALID: '数据结构不合法',
    E_SCHEMA_ID: '无法生成唯一 ID'
  };

  /* ============================== 依赖（惰性取，兼容不同加载方式） ============================== */

  var datesRef = null;
  var schemaRef = null;

  function datesApi() {
    if (!datesRef) {
      datesRef = core.dates || (XZB.Core && XZB.Core.dates) || null;
    }
    return datesRef;
  }

  function schemaApi() {
    if (!schemaRef) {
      schemaRef = core.schema || (XZB.Core && XZB.Core.schema) || null;
    }
    return schemaRef;
  }

  /* ============================== 基础工具 ============================== */

  function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function toInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n) || Math.floor(n) !== n) { return fallback; }
    return n;
  }

  function clamp(value, lo, hi) {
    if (value < lo) { return lo; }
    if (value > hi) { return hi; }
    return value;
  }

  function daysInMonth(year, month) {
    if (month < 1 || month > 12) { return 0; }
    if (month === 2 && isLeapYear(year)) { return 29; }
    return MONTH_DAYS[month - 1];
  }

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  /* 'YYYY-MM-DD' → { y, m, d }；非法返回 null（纯字符串解析，不建 Date 对象） */
  function dateParts(value) {
    if (typeof value !== 'string' || value.length !== 10) { return null; }
    if (value.charAt(4) !== '-' || value.charAt(7) !== '-') { return null; }
    var y = toInt(value.slice(0, 4), -1);
    var m = toInt(value.slice(5, 7), -1);
    var d = toInt(value.slice(8, 10), -1);
    if (y < 1000 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) { return null; }
    return { y: y, m: m, d: d };
  }

  function isDate(value) {
    return dateParts(value) !== null;
  }

  function formatParts(parts) {
    return parts.y + '-' + pad2(parts.m) + '-' + pad2(parts.d);
  }

  /* ISO 日期串按字典序比较即为时间序 */
  function cmp(a, b) {
    if (a === b) { return 0; }
    return a < b ? -1 : 1;
  }

  function fail(code, message, path) {
    var out = {
      ok: false,
      code: code,
      message: message || MESSAGES[code] || '操作失败'
    };
    if (path) { out.path = path; }
    return out;
  }

  /* ============================== 规则归一化 ============================== */

  /* 规则归一化：
     opts.clampDay === false 时保留原始 dayOfMonth（1–31，供月末锚点算法使用）；
     默认按 D16.3 把 29–31 夹到 28（创建/落库口径）。
     非法字段置 null，不抛异常。 */
  function normalizeRule(rule, opts) {
    var src = isObj(rule) ? rule : {};
    var clampDay = !opts || opts.clampDay !== false;
    var out = {};
    var key;
    for (key in src) {
      if (has(src, key)) { out[key] = src[key]; }
    }

    out.freq = typeof src.freq === 'string' ? src.freq.toLowerCase() : '';
    out.interval = clamp(toInt(src.interval, 1), 1, MAX_INTERVAL);
    out.weekday = null;
    out.dayOfMonth = null;
    out.monthOfYear = null;

    if (out.freq === 'weekly') {
      var wd = toInt(src.weekday, -1);
      if (wd >= 0 && wd <= 6) { out.weekday = wd; }
    } else if (out.freq === 'monthly' || out.freq === 'yearly') {
      var dom = toInt(src.dayOfMonth, -1);
      if (dom >= 1 && dom <= 31) {
        out.dayOfMonth = clampDay ? Math.min(dom, MAX_DAY_OF_MONTH) : dom;
      }
      if (out.freq === 'yearly') {
        var mo = toInt(src.monthOfYear, -1);
        if (mo >= 1 && mo <= 12) { out.monthOfYear = mo; }
      }
    }

    out.startDate = isDate(src.startDate) ? src.startDate : null;
    out.endDate = isDate(src.endDate) ? src.endDate : null;
    out.nextDueDate = isDate(src.nextDueDate) ? src.nextDueDate : null;
    return out;
  }

  /* 调度字段是否齐全（能算出到期日） */
  function canSchedule(rule) {
    var r = normalizeRule(rule, { clampDay: false });
    if (FREQS.indexOf(r.freq) < 0 || !r.startDate) { return false; }
    if (r.freq === 'weekly' && r.weekday === null) { return false; }
    if ((r.freq === 'monthly' || r.freq === 'yearly') && r.dayOfMonth === null) { return false; }
    if (r.freq === 'yearly' && r.monthOfYear === null) { return false; }
    return true;
  }

  /* 严格校验（口径同 §2.9，dayOfMonth 只接受 1–28）：
     不完整返回 {ok:false, code:'E_RECURRING_RULE', path:'字段名'}。 */
  function validateRule(rule) {
    if (!isObj(rule)) { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'rule'); }
    var freq = typeof rule.freq === 'string' ? rule.freq.toLowerCase() : '';
    if (FREQS.indexOf(freq) < 0) { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'freq'); }

    var interval = toInt(rule.interval, 1);
    if (interval < 1 || interval > MAX_INTERVAL) {
      return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'interval');
    }
    if (!isDate(rule.startDate)) {
      return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'startDate');
    }
    var hasEnd = rule.endDate !== null && rule.endDate !== undefined && rule.endDate !== '';
    if (hasEnd) {
      if (!isDate(rule.endDate)) {
        return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'endDate');
      }
      if (cmp(rule.endDate, rule.startDate) < 0) {
        return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'endDate');
      }
    }
    if (freq === 'weekly') {
      var wd = toInt(rule.weekday, -1);
      if (wd < 0 || wd > 6) { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'weekday'); }
    }
    if (freq === 'monthly' || freq === 'yearly') {
      var dom = toInt(rule.dayOfMonth, -1);
      if (dom < 1 || dom > MAX_DAY_OF_MONTH) {
        return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'dayOfMonth');
      }
    }
    if (freq === 'yearly') {
      var mo = toInt(rule.monthOfYear, -1);
      if (mo < 1 || mo > 12) { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'monthOfYear'); }
    }
    return { ok: true, rule: normalizeRule(rule) };
  }

  /* ============================== 到期日计算 ============================== */

  /* 0=周日…6=周六（D16.3 口径）；非法日期返回 -1 */
  function sun0Of(dateStr) {
    var D = datesApi();
    if (!D || !isDate(dateStr)) { return -1; }
    var monday0 = D.weekdayIndex(dateStr);   /* 周一=0…周日=6 */
    if (monday0 < 0) { return -1; }
    return (monday0 + 1) % 7;
  }

  /* 按 endDate 截断；超出返回 null */
  function applyEnd(candidate, endDate) {
    if (!candidate) { return null; }
    if (endDate && cmp(candidate, endDate) > 0) { return null; }
    return candidate;
  }

  /* daily：首次 = startDate，之后每 interval 天 */
  function nextDaily(D, start, from, interval) {
    if (cmp(from, start) <= 0) { return start; }
    var gap = D.daysBetween(start, from);
    if (gap === null) { return null; }
    var steps = Math.ceil(gap / interval);
    if (steps < 1) { steps = 1; }
    return D.addDays(start, steps * interval);
  }

  /* weekly：首次 = startDate 起第一个 weekday（含当天），之后每 interval 周 */
  function nextWeekly(D, start, from, weekday, interval) {
    var startSun = sun0Of(start);
    if (startSun < 0) { return null; }
    var offset = ((weekday - startSun) % 7 + 7) % 7;
    var first = D.addDays(start, offset);
    if (!first) { return null; }
    if (cmp(from, first) <= 0) { return first; }
    var gap = D.daysBetween(first, from);
    if (gap === null) { return null; }
    var span = 7 * interval;
    var steps = Math.ceil(gap / span);
    if (steps < 1) { steps = 1; }
    return D.addDays(first, steps * span);
  }

  /* 月偏移：月份 1–12，允许负数 */
  function shiftMonth(year, month, delta) {
    var total = year * 12 + (month - 1) + delta;
    var y = Math.floor(total / 12);
    var m = total - y * 12 + 1;
    return { y: y, m: m };
  }

  /* 第 k 个周期（k 从 0 起）的日期：日取 min(dayOfMonth, 当月天数)，锚点不回退 */
  function monthlyInstance(start, dayOfMonth, interval, k) {
    var month = shiftMonth(start.y, start.m, k * interval);
    var d = Math.min(dayOfMonth, daysInMonth(month.y, month.m));
    return { y: month.y, m: month.m, d: d };
  }

  /* monthly：首次 = startDate 所在月第一个不早于 startDate 的 dayOfMonth，之后每 interval 月 */
  function nextMonthly(D, startStr, fromStr, dayOfMonth, interval) {
    var start = dateParts(startStr);
    var from = dateParts(fromStr);
    if (!start || !from) { return null; }
    var day = clamp(dayOfMonth, 1, 31);

    var k = 0;
    var candidate = formatParts(monthlyInstance(start, day, interval, 0));
    if (cmp(candidate, startStr) < 0) {
      k = 1;
      candidate = formatParts(monthlyInstance(start, day, interval, 1));
    }
    if (cmp(candidate, fromStr) < 0) {
      var monthDiff = (from.y - start.y) * 12 + (from.m - start.m);
      var guess = Math.floor(monthDiff / interval);
      if (guess > k) {
        k = guess;
        candidate = formatParts(monthlyInstance(start, day, interval, k));
      }
      var guard = 0;
      while (cmp(candidate, fromStr) < 0) {
        k += 1;
        candidate = formatParts(monthlyInstance(start, day, interval, k));
        guard += 1;
        if (guard > MAX_SCAN_PER_RULE) { return null; }
      }
    }
    return candidate;
  }

  /* 第 k 个周期的年份日期（yearly 用） */
  function yearlyInstance(start, monthOfYear, dayOfMonth, interval, k) {
    var y = start.y + k * interval;
    var d = Math.min(dayOfMonth, daysInMonth(y, monthOfYear));
    return { y: y, m: monthOfYear, d: d };
  }

  /* yearly：首次 = startDate 年起第一个不早于 startDate 的 monthOfYear/dayOfMonth */
  function nextYearly(D, startStr, fromStr, monthOfYear, dayOfMonth, interval) {
    var start = dateParts(startStr);
    var from = dateParts(fromStr);
    if (!start || !from) { return null; }
    var mo = clamp(monthOfYear, 1, 12);
    var day = clamp(dayOfMonth, 1, 31);

    var k = 0;
    var candidate = formatParts(yearlyInstance(start, mo, day, interval, 0));
    if (cmp(candidate, startStr) < 0) {
      k = 1;
      candidate = formatParts(yearlyInstance(start, mo, day, interval, 1));
    }
    if (cmp(candidate, fromStr) < 0) {
      var yearDiff = from.y - start.y;
      var guess = Math.floor(yearDiff / interval);
      if (guess > k) {
        k = guess;
        candidate = formatParts(yearlyInstance(start, mo, day, interval, k));
      }
      var guard = 0;
      while (cmp(candidate, fromStr) < 0) {
        k += 1;
        candidate = formatParts(yearlyInstance(start, mo, day, interval, k));
        guard += 1;
        if (guard > MAX_SCAN_PER_RULE) { return null; }
      }
    }
    return candidate;
  }

  /* 下一次到期日（含 fromDateStr 当天）：
     - 规则不完整 / 已过 endDate / 无到期日 ⇒ null
     - fromDateStr 非法 ⇒ 用今天 */
  function nextDueDate(rule, fromDateStr) {
    var D = datesApi();
    if (!D) { return null; }
    var r = normalizeRule(rule, { clampDay: false });
    if (!r.startDate) { return null; }
    var from = isDate(fromDateStr) ? fromDateStr : D.todayStr();
    if (cmp(from, r.startDate) < 0) { from = r.startDate; }

    var candidate;
    if (r.freq === 'daily') {
      candidate = nextDaily(D, r.startDate, from, r.interval);
    } else if (r.freq === 'weekly') {
      if (r.weekday === null) { return null; }
      candidate = nextWeekly(D, r.startDate, from, r.weekday, r.interval);
    } else if (r.freq === 'monthly') {
      if (r.dayOfMonth === null) { return null; }
      candidate = nextMonthly(D, r.startDate, from, r.dayOfMonth, r.interval);
    } else if (r.freq === 'yearly') {
      if (r.dayOfMonth === null || r.monthOfYear === null) { return null; }
      candidate = nextYearly(D, r.startDate, from, r.monthOfYear, r.dayOfMonth, r.interval);
    } else {
      return null;
    }
    return applyEnd(candidate, r.endDate);
  }

  /* 严格晚于 dateStr 的下一次到期日 */
  function nextDueDateAfter(rule, dateStr) {
    var D = datesApi();
    if (!D || !isDate(dateStr)) { return null; }
    return nextDueDate(rule, D.addDays(dateStr, 1));
  }

  /* 区间内全部到期日（含首尾）；按时间升序、去重；不连续重复 */
  function instancesBetween(rule, fromStr, toStr, opts) {
    var D = datesApi();
    if (!D) { return []; }
    var o = opts || {};
    if (!canSchedule(rule)) { return []; }
    var r = normalizeRule(rule, { clampDay: false });
    var from = isDate(fromStr) ? fromStr : r.startDate;
    var to = isDate(toStr) ? toStr : from;
    if (cmp(to, from) < 0) { return []; }

    var limit = clamp(toInt(o.max, MAX_BETWEEN), 1, MAX_BETWEEN);
    var out = [];
    var seen = Object.create(null);
    var cursor = nextDueDate(rule, from);
    var guard = 0;
    while (cursor && cmp(cursor, to) <= 0 && out.length < limit) {
      if (seen[cursor] !== true) {
        seen[cursor] = true;
        out.push(cursor);
      }
      var next = nextDueDate(rule, D.addDays(cursor, 1));
      if (!next || cmp(next, cursor) <= 0) { break; }
      cursor = next;
      guard += 1;
      if (guard > MAX_BETWEEN * 2) { break; }
    }
    return out;
  }

  /* 今天（或指定日）是否有一条「待入账」的到期：以规则游标 nextDueDate 为准 */
  function isDue(rule, todayStr) {
    var D = datesApi();
    if (!D) { return false; }
    if (!isObj(rule) || rule.archived === true || rule.paused === true) { return false; }
    var today = isDate(todayStr) ? todayStr : D.todayStr();
    var cursor = isDate(rule.nextDueDate) ? rule.nextDueDate : nextDueDate(rule, rule.startDate);
    if (!cursor) { return false; }
    if (isDate(rule.endDate) && cmp(cursor, rule.endDate) > 0) { return false; }
    return cmp(cursor, today) <= 0;
  }

  /* ============================== 幂等键 ============================== */

  /* periodKey = ruleId + '@' + dueDate（形如 rc_ab12@2026-10-22）
     与 schema.PERIOD_KEY_RE 完全一致；非法入参返回 '' */
  function makePeriodKey(rule, dueDateStr) {
    var id = typeof rule === 'string' ? rule : (isObj(rule) ? rule.id : '');
    if (typeof id !== 'string' || id === '') { return ''; }
    if (!isDate(dueDateStr)) { return ''; }
    return id + '@' + dueDateStr;
  }

  function parsePeriodKey(periodKey) {
    if (typeof periodKey !== 'string') { return null; }
    var index = periodKey.indexOf('@');
    if (index <= 0 || index === periodKey.length - 1) { return null; }
    var ruleId = periodKey.slice(0, index);
    var dueDate = periodKey.slice(index + 1);
    if (!isDate(dueDate)) { return null; }
    return { ruleId: ruleId, dueDate: dueDate };
  }

  /* 查这个 periodKey 是否已入账（按 §6.3：deleted:true 也算已存在，不复活） */
  function findByPeriodKey(list, periodKey) {
    if (!periodKey || !Array.isArray(list)) { return null; }
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item && item.periodKey === periodKey) { return item; }
    }
    return null;
  }

  /* ============================== 待入账清单 ============================== */

  /* 扫全部规则，返回应当入账的待办（默认跳过已入账的 periodKey）：
     [{ ruleId, dueDate, periodKey, bookId, name, type, amountCents, rule }]
     - archived === true 的规则永不返回（INTERFACE-FREEZE §8 / §6.3）
     - paused === true 默认跳过（CONTRACT：暂停不生成不提醒）
     - opts.autoPostOnly === true 时只要 autoPost === true 的规则
     - opts.skipPosted === false 时不查重（默认 true）
     - opts.maxPerRule 默认 120（§6.3 单规则上限） */
  function dueInstances(db, todayStr, opts) {
    var D = datesApi();
    if (!D) { return []; }
    var o = opts || {};
    var target = resolveDraft(db) || (isObj(db) ? db : null);
    var rules = target && Array.isArray(target.recurring) ? target.recurring : [];
    var transactions = target && Array.isArray(target.transactions) ? target.transactions : [];
    var today = isDate(todayStr) ? todayStr : D.todayStr();
    var maxPerRule = clamp(toInt(o.maxPerRule, MAX_PER_RULE), 1, MAX_PER_RULE);
    var skipPosted = o.skipPosted !== false;
    var out = [];

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || typeof rule !== 'object') { continue; }
      if (rule.archived === true) { continue; }
      if (rule.paused === true && o.includePaused !== true) { continue; }
      if (o.autoPostOnly === true && rule.autoPost !== true) { continue; }
      if (typeof o.ruleId === 'string' && rule.id !== o.ruleId) { continue; }

      var norm = normalizeRule(rule, { clampDay: false });
      if (!canSchedule(norm)) { continue; }

      /* 游标：规则上的 nextDueDate（§2.9 只读字段）与首期取较晚者 */
      var first = nextDueDate(rule, norm.startDate);
      var cursor = norm.nextDueDate;
      if (!cursor) { cursor = first; }
      else if (first && cmp(first, cursor) > 0) { cursor = first; }
      if (!isDate(cursor)) { continue; }
      if (norm.endDate && cmp(cursor, norm.endDate) > 0) { continue; }

      var scanned = 0;
      while (cursor && cmp(cursor, today) <= 0 && out.length < maxPerRule && scanned < MAX_SCAN_PER_RULE) {
        scanned += 1;
        var periodKey = makePeriodKey(rule, cursor);
        if (periodKey && (!skipPosted || !findByPeriodKey(transactions, periodKey))) {
          out.push({
            ruleId: rule.id,
            dueDate: cursor,
            periodKey: periodKey,
            bookId: rule.bookId,
            name: rule.name,
            type: rule.type,
            amountCents: rule.amountCents,
            accountId: rule.accountId,
            categoryId: rule.categoryId,
            autoPost: rule.autoPost === true,
            rule: rule
          });
        }
        var next = nextDueDateAfter(rule, cursor);
        if (!next || cmp(next, cursor) <= 0) { break; }
        cursor = next;
      }
    }

    out.sort(function (a, b) {
      var byDate = cmp(a.dueDate, b.dueDate);
      if (byDate !== 0) { return byDate; }
      if (a.ruleId === b.ruleId) { return 0; }
      return a.ruleId < b.ruleId ? -1 : 1;
    });
    return out;
  }

  /* ============================== 落库 ============================== */

  /* 取得可写草稿：store.transaction 的 draft，或 { db / draft / state / data } 包装 */
  function resolveDraft(value) {
    if (!value || typeof value !== 'object') { return null; }
    if (Array.isArray(value.transactions) && Array.isArray(value.recurring)) { return value; }
    var keys = ['db', 'draft', 'state', 'data', 'snapshot'];
    for (var i = 0; i < keys.length; i++) {
      var candidate = value[keys[i]];
      if (candidate && typeof candidate === 'object' &&
        Array.isArray(candidate.transactions) && Array.isArray(candidate.recurring)) {
        return candidate;
      }
    }
    return null;
  }

  function findRuleById(draft, ruleId) {
    if (!draft || !Array.isArray(draft.recurring) || typeof ruleId !== 'string') { return null; }
    for (var i = 0; i < draft.recurring.length; i++) {
      var item = draft.recurring[i];
      if (item && item.id === ruleId) { return item; }
    }
    return null;
  }

  function collectIds(list) {
    var out = [];
    if (!Array.isArray(list)) { return out; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].id === 'string') { out.push(list[i].id); }
    }
    return out;
  }

  /* 按 §2.9 / §6.3 把规则落成一条流水草稿（不写库、不校验引用） */
  function buildTransaction(draft, rule, dueDate, periodKey, opts) {
    var D = datesApi();
    var S = schemaApi();
    if (!D || !S) { return fail('E_SCHEMA_INVALID', '缺少 dates/schema 依赖', 'schema'); }
    var o = opts || {};
    var now = typeof o.now === 'string' && D.isValidIsoStr(o.now) ? o.now : D.nowIso();
    var type = rule.type === 'income' || rule.type === 'transfer' ? rule.type : 'expense';
    var note = typeof o.note === 'string' ? o.note
      : (typeof rule.note === 'string' && rule.note !== '' ? rule.note
        : (typeof rule.name === 'string' ? rule.name : ''));

    var id = '';
    if (typeof o.id === 'string' && o.id !== '') {
      id = o.id;
    } else {
      var ids = collectIds(draft.transactions);
      id = S.newId('tx', ids);
    }
    if (!id) { return fail('E_SCHEMA_ID', MESSAGES.E_SCHEMA_ID, 'id'); }

    var input = {
      id: id,
      bookId: rule.bookId,
      type: type,
      amountCents: rule.amountCents,
      accountId: rule.accountId,
      toAccountId: type === 'transfer' ? rule.toAccountId : null,
      categoryId: type === 'transfer' ? null : rule.categoryId,
      date: dueDate,
      time: typeof o.time === 'string' && D.isValidTimeStr(o.time) ? o.time : '09:00',
      note: note,
      tags: [],
      source: 'recurring',
      recurringId: rule.id,
      periodKey: periodKey,
      importRef: null,
      deleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    };

    var entity = null;
    if (typeof S.normalizeTransaction === 'function') {
      entity = S.normalizeTransaction(input, now);
    } else if (typeof S.normalize === 'function') {
      entity = S.normalize('transaction', input, now);
    }
    if (!entity) { return fail('E_INVALID_INPUT', '流水构造失败', 'transaction'); }
    return { ok: true, transaction: entity };
  }

  /* 用 schema 校验一条待写入流水，返回首个错误码 */
  function validateTransactionEntity(draft, entity, opts) {
    var S = schemaApi();
    var D = datesApi();
    if (!S) { return { ok: true }; }
    var o = opts || {};
    var ctx = { allowArchived: true, today: D ? D.todayStr() : undefined };
    if (Array.isArray(draft.books)) { ctx.books = draft.books; }
    if (Array.isArray(draft.accounts)) { ctx.accounts = draft.accounts; }
    if (Array.isArray(draft.categories)) { ctx.categories = draft.categories; }
    var checked;
    try {
      checked = typeof S.validateTransaction === 'function'
        ? S.validateTransaction(entity, ctx)
        : S.validate('transaction', entity, ctx);
    } catch (error) {
      return fail('E_SCHEMA_INVALID', String((error && error.message) || error), 'transaction');
    }
    if (checked && checked.ok === true) { return { ok: true }; }
    var first = checked && Array.isArray(checked.errors) ? checked.errors[0] : null;
    return fail(
      (first && first.code) || 'E_SCHEMA_INVALID',
      (first && first.message) || MESSAGES.E_SCHEMA_INVALID,
      (first && first.field) || 'transaction'
    );
  }

  /* 入账后推进规则游标：
     - nextDueDate 只在仍指向当期（<= dueDate）时前移，避免重复调用倒退；
     - lastPostedPeriod 记录最近一次成功入账的期；
     - 规则已过 endDate ⇒ nextDueDate = null。 */
  function advanceRule(draft, rule, dueDate, periodKey, opts) {
    var D = datesApi();
    var target = findRuleById(draft, rule.id) || rule;
    if (!target || typeof target !== 'object') { return null; }
    var next = nextDueDateAfter(target, dueDate);
    var current = isDate(target.nextDueDate) ? target.nextDueDate : null;
    if (current === null || cmp(current, dueDate) <= 0) {
      target.nextDueDate = next;
    }
    target.lastPostedPeriod = periodKey;
    if (D) { target.updatedAt = D.nowIso(); }
    return target;
  }

  /* 落一条周期账单：
     - store 为 store.transaction(fn) 的 draft（也兼容 {db:...} 包装）
     - item: { ruleId | rule, dueDate, periodKey? }
     - 返回 {ok:true, id, skipped:false, transaction, periodKey} 或 {ok:true, skipped:true, id}
     - 失败返回 {ok:false, code, message, path}，draft 保证不被改动（先校验后 push） */
  function postInstance(store, item, opts) {
    var o = opts || {};
    var draft = resolveDraft(store);
    if (!draft) { return fail('E_INVALID_INPUT', '需要一个可写的 store 草稿', 'store'); }
    if (!isObj(item)) { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'item'); }

    var rule = isObj(o.rule) ? o.rule
      : (isObj(item.rule) ? item.rule : findRuleById(draft, item.ruleId));
    if (!isObj(rule) || typeof rule.id !== 'string' || rule.id === '') {
      return fail('E_RECURRING_NOT_FOUND', MESSAGES.E_RECURRING_NOT_FOUND, 'ruleId');
    }
    var dueDate = isDate(item.dueDate) ? item.dueDate
      : (isDate(rule.nextDueDate) ? rule.nextDueDate : null);
    if (!dueDate) { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'dueDate'); }
    if (isDate(rule.endDate) && cmp(dueDate, rule.endDate) > 0) {
      return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'dueDate');
    }

    var periodKey = typeof item.periodKey === 'string' && item.periodKey !== ''
      ? item.periodKey
      : makePeriodKey(rule, dueDate);
    if (periodKey === '') { return fail('E_RECURRING_RULE', MESSAGES.E_RECURRING_RULE, 'periodKey'); }

    /* 幂等：先查 periodKey（含软删流水）；已存在直接返回 skipped，不报错 */
    var existing = findByPeriodKey(draft.transactions, periodKey);
    if (existing) {
      if (o.advanceRule !== false) { advanceRule(draft, rule, dueDate, periodKey, o); }
      return {
        ok: true,
        skipped: true,
        id: existing.id,
        transaction: existing,
        ruleId: rule.id,
        dueDate: dueDate,
        periodKey: periodKey
      };
    }

    var built = buildTransaction(draft, rule, dueDate, periodKey, o);
    if (!built.ok) { return built; }
    var checked = validateTransactionEntity(draft, built.transaction, o);
    if (!checked.ok) { return checked; }

    draft.transactions.push(built.transaction);
    if (o.advanceRule !== false) { advanceRule(draft, rule, dueDate, periodKey, o); }
    return {
      ok: true,
      skipped: false,
      id: built.transaction.id,
      transaction: built.transaction,
      ruleId: rule.id,
      dueDate: dueDate,
      periodKey: periodKey
    };
  }

  /* 批量补账：
     - 最多补 opts.max 期（默认 31）
     - 逐条入账；单条异常/失败只计入 failures，不影响其他条
     - 返回汇总：{ ok, posted, skipped, failed, processed, total, remaining, ids, failures, partial }
     - 默认只补 autoPost === true 的规则（opts.autoPostOnly === false 可放开） */
  function catchUp(db, store, todayStr, opts) {
    var D = datesApi();
    var o = opts || {};
    if (!D) { return fail('E_SCHEMA_INVALID', '缺少 dates 依赖', 'dates'); }
    var draft = resolveDraft(store) || resolveDraft(db);
    if (!draft) { return fail('E_INVALID_INPUT', 'catchUp 需要一个可写的 store 草稿', 'store'); }

    var today = isDate(todayStr) ? todayStr : D.todayStr();
    var list = dueInstances(draft, today, {
      ruleId: o.ruleId,
      includePaused: o.includePaused,
      autoPostOnly: o.autoPostOnly !== false,
      maxPerRule: o.maxPerRule
    });
    var max = clamp(toInt(o.max, MAX_CATCH_UP), 1, MAX_CATCH_UP);

    var summary = {
      ok: true,
      partial: false,
      today: today,
      posted: 0,
      skipped: 0,
      failed: 0,
      processed: 0,
      total: list.length,
      remaining: 0,
      ids: [],
      failures: []
    };

    for (var i = 0; i < list.length; i++) {
      if (summary.processed >= max) { break; }
      var current = list[i];
      var result;
      try {
        result = postInstance(draft, current, { now: o.now, advanceRule: o.advanceRule });
      } catch (error) {
        result = fail('E_RECURRING_RULE', String((error && error.message) || error), 'item');
      }
      summary.processed += 1;
      if (result.ok && result.skipped === true) {
        summary.skipped += 1;
      } else if (result.ok) {
        summary.posted += 1;
        if (result.id) { summary.ids.push(result.id); }
      } else {
        summary.failed += 1;
        summary.failures.push({
          ruleId: current.ruleId,
          dueDate: current.dueDate,
          periodKey: current.periodKey,
          code: result.code,
          path: result.path,
          message: result.message
        });
      }
    }

    summary.remaining = Math.max(0, list.length - summary.processed);
    summary.partial = summary.failed > 0;
    return summary;
  }

  /* ============================== 文案 ============================== */

  function weekdayText(sun0) {
    var index = toInt(sun0, -1);
    return WEEKDAY_NAMES[index] || '';
  }

  /* 规则的中文频率文案：每天 / 每 3 天 / 每周三 / 每月 8 日 / 每年 2 月 29 日 */
  function freqText(rule) {
    var r = normalizeRule(rule, { clampDay: false });
    if (FREQS.indexOf(r.freq) < 0) { return ''; }
    var interval = r.interval > 1 ? String(r.interval) : '';
    if (r.freq === 'daily') {
      return interval ? '每' + interval + '天' : '每天';
    }
    if (r.freq === 'weekly') {
      /* '每周' + '一' = '每周一'，避免出现「每周周一」；多周倍率加括号更清楚 */
      if (r.weekday === null) { return interval ? '每' + interval + '周' : '每周'; }
      var name = weekdayText(r.weekday);
      if (!interval) { return '每周' + name.slice(1); }
      return '每' + interval + '周（' + name + '）';
    }
    if (r.freq === 'monthly') {
      if (r.dayOfMonth === null) { return FREQ_NAMES.monthly; }
      return (interval ? '每' + interval + '个月' : '每月') + r.dayOfMonth + '日';
    }
    if (r.monthOfYear === null || r.dayOfMonth === null) { return FREQ_NAMES.yearly; }
    return (interval ? '每' + interval + '年' : '每年') + r.monthOfYear + '月' + r.dayOfMonth + '日';
  }

  /* ============================== 导出 ============================== */

  var api = Object.freeze({
    /* 常量 */
    MAX_INTERVAL: MAX_INTERVAL,
    MAX_CATCH_UP: MAX_CATCH_UP,
    MAX_PER_RULE: MAX_PER_RULE,
    FREQS: FREQS.slice(),
    MESSAGES: MESSAGES,

    /* 规则 */
    normalizeRule: normalizeRule,
    validateRule: validateRule,
    canSchedule: canSchedule,

    /* 日期 */
    nextDueDate: nextDueDate,
    nextDue: nextDueDate,
    nextDueDateAfter: nextDueDateAfter,
    instancesBetween: instancesBetween,
    dueBetween: instancesBetween,
    isDue: isDue,

    /* 幂等键 */
    makePeriodKey: makePeriodKey,
    periodKeyOf: makePeriodKey,
    parsePeriodKey: parsePeriodKey,
    findByPeriodKey: findByPeriodKey,

    /* 清单 / 落库 */
    dueInstances: dueInstances,
    postInstance: postInstance,
    catchUp: catchUp,
    buildTransaction: buildTransaction,
    /* 跳过本期（不落流水，只推进规则游标）供计划页使用 */
    advanceRule: advanceRule,

    /* 文案 */
    freqText: freqText,
    weekdayText: weekdayText
  });

  core.recurrence = api;
  XZB.Core.recurrence = api;

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
