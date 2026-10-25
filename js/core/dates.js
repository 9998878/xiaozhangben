/* 小账本 2.0 · js/core/dates.js · owner: dba（T01）
 * 契约锚点：CONTRACT §2.1（DateStr）、§2.5（时间）、§6.3（周期）。
 * 硬规则：日期一律按本地时区分量手工解析，禁止 new Date("YYYY-MM-DD")；
 * 除 nowIso/todayLocal/todayStr 允许读取当前时间外，全部是纯函数。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var MONTH_RE = /^(\d{4})-(\d{2})$/;
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;
  var WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  }

  function daysInMonth(year, month) {
    if (month === 2) { return isLeapYear(year) ? 29 : 28; }
    if (month === 4 || month === 6 || month === 9 || month === 11) { return 30; }
    return 31;
  }

  function makeDate(year, month, day) {
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  function isValidDateParts(year, month, day) {
    return year >= 1000 && year <= 9999 &&
      month >= 1 && month <= 12 &&
      day >= 1 && day <= daysInMonth(year, month);
  }

  function isValidDateStr(value) {
    if (typeof value !== 'string') { return false; }
    var match = DATE_RE.exec(value);
    if (!match) { return false; }
    return isValidDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  function isValidMonthStr(value) {
    if (typeof value !== 'string') { return false; }
    var match = MONTH_RE.exec(value);
    if (!match) { return false; }
    var month = Number(match[2]);
    return month >= 1 && month <= 12;
  }

  function isValidTimeStr(value) {
    return typeof value === 'string' && TIME_RE.test(value);
  }

  function isValidIsoStr(value) {
    if (typeof value !== 'string') { return false; }
    var match = ISO_RE.exec(value);
    if (!match) { return false; }
    if (!isValidDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) { return false; }
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = Number(match[6]);
    var offsetHour = Number(match[8]);
    var offsetMinute = Number(match[9]);
    return hour <= 23 && minute <= 59 && second <= 59 &&
      offsetHour <= 23 && offsetMinute <= 59;
  }

  /* 手工拆字符串 → 本地零点 Date；非法返回 null */
  function parseLocalDate(value) {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) { return null; }
      return makeDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    if (typeof value !== 'string') { return null; }
    var match = DATE_RE.exec(value);
    if (!match) { return null; }
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (!isValidDateParts(year, month, day)) { return null; }
    return makeDate(year, month, day);
  }

  /* Date → 本地 YYYY-MM-DD；非法返回 null */
  function formatDate(value) {
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return null; }
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function nowDate(now) {
    if (now === undefined || now === null) { return new Date(); }
    if (now instanceof Date) { return now; }
    if (typeof now === 'number') { return new Date(now); }
    return new Date();
  }

  /* 本地日期串（今天） */
  function todayStr(now) {
    return formatDate(nowDate(now));
  }

  function today(now) {
    return todayStr(now);
  }

  /* 本地零点 Date（今天） */
  function todayLocal(now) {
    var date = nowDate(now);
    return makeDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  /* 契约 §2.1：本地时间带时区偏移，如 2026-10-22T19:20:11+08:00 */
  function nowIso(now) {
    var date = nowDate(now);
    if (isNaN(date.getTime())) { date = new Date(); }
    var offset = -date.getTimezoneOffset();
    var sign = offset >= 0 ? '+' : '-';
    var abs = Math.abs(offset);
    var offsetText = sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) +
      offsetText;
  }

  function nowTime(now) {
    var date = nowDate(now);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function addDaysDate(date, days) {
    var result = makeDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
    result.setDate(result.getDate() + days);
    return result;
  }

  /* 字符串进字符串出、Date 进 Date 出；非法返回 null */
  function addDays(value, days) {
    var amount = Number(days);
    if (!isFinite(amount) || Math.floor(amount) !== amount) { return null; }
    if (typeof value === 'string') {
      var date = parseLocalDate(value);
      if (!date) { return null; }
      return formatDate(addDaysDate(date, amount));
    }
    if (value instanceof Date) {
      if (isNaN(value.getTime())) { return null; }
      return addDaysDate(value, amount);
    }
    return null;
  }

  /* 月末夹取：1-31 加一月 → 2-28/29；Date 进 Date 出、串进串出 */
  function addMonths(value, months) {
    var amount = Number(months);
    if (!isFinite(amount) || Math.floor(amount) !== amount) { return null; }
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return null; }

    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var day = date.getDate();
    var total = year * 12 + (month - 1) + amount;
    var targetYear = Math.floor(total / 12);
    var targetMonth = total - targetYear * 12 + 1;
    var targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    var result = makeDate(targetYear, targetMonth, targetDay);
    return value instanceof Date ? result : formatDate(result);
  }

  /* 周一为首日 */
  function startOfWeek(value) {
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return null; }
    var offset = (date.getDay() + 6) % 7;
    var result = makeDate(date.getFullYear(), date.getMonth() + 1, date.getDate() - offset);
    return value instanceof Date ? result : formatDate(result);
  }

  function startOfMonth(value) {
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return null; }
    var result = makeDate(date.getFullYear(), date.getMonth() + 1, 1);
    return value instanceof Date ? result : formatDate(result);
  }

  function endOfMonth(value) {
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return null; }
    var result = makeDate(date.getFullYear(), date.getMonth() + 1, daysInMonth(date.getFullYear(), date.getMonth() + 1));
    return value instanceof Date ? result : formatDate(result);
  }

  /* "YYYY-MM" / Date / DateStr -> "YYYY-MM"；非法返回 '' */
  function monthKey(value) {
    if (typeof value === 'string' && isValidMonthStr(value)) { return value; }
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return ''; }
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
  }

  function monthRange(value) {
    var key = monthKey(value);
    if (!key) { return null; }
    var start = key + '-01';
    var end = endOfMonth(start);
    if (!end) { return null; }
    return { start: start, end: end };
  }

  /* 周一=0 … 周日=6 */
  function weekdayIndex(value) {
    var date = value instanceof Date ? value : parseLocalDate(value);
    if (!date || isNaN(date.getTime())) { return -1; }
    return (date.getDay() + 6) % 7;
  }

  /* to - from（天）。用 UTC 分量计算，规避夏令时 23/25 小时偏差 */
  function daysBetween(from, to) {
    var a = from instanceof Date ? from : parseLocalDate(from);
    var b = to instanceof Date ? to : parseLocalDate(to);
    if (!a || !b || isNaN(a.getTime()) || isNaN(b.getTime())) { return null; }
    var utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((utcB - utcA) / 86400000);
  }

  /* CONTRACT §6.3 周期语义的日期桶（完整幂等键由 recurrence 拼 recurringId@dueDate）：
   * daily -> 当天；weekly -> 周一；monthly -> YYYY-MM；yearly -> YYYY。 */
  function periodKeyFor(dateStr, freq) {
    if (!isValidDateStr(dateStr)) { return ''; }
    var f = typeof freq === 'string' ? freq.toLowerCase() : '';
    if (f === 'daily') { return dateStr; }
    if (f === 'weekly') { return startOfWeek(dateStr); }
    if (f === 'monthly') { return dateStr.slice(0, 7); }
    if (f === 'yearly') { return dateStr.slice(0, 4); }
    return '';
  }

  function formatHuman(dateStr, anchor) {
    if (!isValidDateStr(dateStr)) { return ''; }
    var base = isValidDateStr(anchor) ? anchor : todayStr();
    var diff = daysBetween(base, dateStr);
    if (diff === 0) { return '今天'; }
    if (diff === -1) { return '昨天'; }
    if (diff === -2) { return '前天'; }
    if (diff === 1) { return '明天'; }
    if (diff === 2) { return '后天'; }
    var date = parseLocalDate(dateStr);
    var baseDate = parseLocalDate(base);
    if (date.getFullYear() === baseDate.getFullYear()) {
      return (date.getMonth() + 1) + '月' + date.getDate() + '日';
    }
    return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  function weekdayCN(value) {
    var index = weekdayIndex(value);
    return index < 0 ? '' : WEEKDAY_CN[index];
  }

  var api = Object.freeze({
    /* 任务书 API */
    parseLocalDate: parseLocalDate,
    formatDate: formatDate,
    todayLocal: todayLocal,
    addDays: addDays,
    addMonths: addMonths,
    startOfWeek: startOfWeek,
    startOfMonth: startOfMonth,
    endOfMonth: endOfMonth,
    monthKey: monthKey,
    weekdayIndex: weekdayIndex,
    isValidDateStr: isValidDateStr,
    daysBetween: daysBetween,
    periodKeyFor: periodKeyFor,

    /* 契约 / SPEC 兼容 API */
    today: today,
    todayStr: todayStr,
    todayKey: todayStr,
    nowIso: nowIso,
    nowTime: nowTime,
    isValidTimeStr: isValidTimeStr,
    isValidIsoStr: isValidIsoStr,
    isValidMonthStr: isValidMonthStr,
    isDate: isValidDateStr,
    monthRange: monthRange,
    weekStartKey: startOfWeek,
    addMonthsClamped: addMonths,
    diffDays: daysBetween,
    formatHuman: formatHuman,
    weekdayCN: weekdayCN
  });

  Core.dates = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.dates = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
