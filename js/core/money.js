/* 小账本 2.0 · js/core/money.js · owner: dba（T01）
 * 契约锚点：CONTRACT §2.1（Cents）、§6.1、§8（金额错误码）。
 * 硬规则：所有金额以「分」为整数；不读 DOM / 存储 / 网络；不改传入参数。
 * 兼容说明：任务书写的是 XZB.core.money，契约写的是 XZB.Core.money，
 * 本文件把同一个冻结对象挂到两处（XZB.Core 与 XZB.core 指向同一命名空间）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  /* 契约 §2.1：Cents 范围 -999999999999..999999999999 */
  var MAX_CENTS = 999999999999;
  var MIN_CENTS = -MAX_CENTS;

  /* 契约 §8 金额错误码 */
  var E_EMPTY = 'E_AMOUNT_EMPTY';
  var E_RANGE = 'E_AMOUNT_RANGE';
  var E_PRECISION = 'E_AMOUNT_PRECISION';
  var E_NEGATIVE = 'E_AMOUNT_NEGATIVE';
  var E_INVALID = 'E_AMOUNT_INVALID';
  /* 任务书点名、但 §8 词表没有的溢出码（仅 add/sub 使用） */
  var E_TOO_LARGE = 'E_AMOUNT_TOO_LARGE';

  function fail(code) {
    return { ok: false, code: code };
  }

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /* 是否为合法 Cents：安全整数且在契约范围内 */
  function isCents(n) {
    return typeof n === 'number' &&
      isFinite(n) &&
      Math.floor(n) === n &&
      Number.isSafeInteger(n) &&
      n >= MIN_CENTS &&
      n <= MAX_CENTS;
  }

  /* 全角转半角并去掉货币符号 / 千分位 / 空白；不改变数字顺序 */
  function normalizeAmountText(text) {
    if (text === null || text === undefined) { return ''; }
    var s = String(text);
    s = s.replace(/[\uFF10-\uFF19]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/\uFF0E/g, '.').replace(/\u3002/g, '.');
    s = s.replace(/\uFF0C/g, ',');
    s = s.replace(/\uFF0D/g, '-').replace(/\u2212/g, '-').replace(/\uFF0B/g, '+');
    s = s.replace(/\u3000/g, ' ');
    s = s.replace(/[¥￥,\s]/g, '');
    return s;
  }

  /* 内部解析：字符串拆分，绝不使用 parseFloat(x) * 100 */
  function parseInternal(text) {
    var s = normalizeAmountText(text);
    if (s === '') { return fail(E_EMPTY); }

    /* 空串/仅符号 */
    if (s === '-' || s === '+' || s === '.' || s === '-.' || s === '+.') {
      return fail(E_EMPTY);
    }

    /* 超过两位小数（先于整数位数判断，保证 1.005 报精度而非格式） */
    if (/^-?\d+\.\d{3,}$/.test(s)) { return fail(E_PRECISION); }

    /* 超过 12 位整数 */
    if (/^-?\d{13,}(?:\.\d{1,2})?$/.test(s)) { return fail(E_RANGE); }

    if (!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(s)) { return fail(E_INVALID); }

    var negative = s.charAt(0) === '-';
    var body = negative ? s.slice(1) : s;
    var parts = body.split('.');
    var intPart = parts[0];
    var fracPart = parts.length > 1 ? parts[1] : '';
    if (fracPart.length === 0) { fracPart = '00'; }
    else if (fracPart.length === 1) { fracPart = fracPart + '0'; }

    var yuan = Number(intPart);
    var cents = yuan * 100 + Number(fracPart);
    if (!isFinite(cents) || cents > MAX_CENTS) { return fail(E_RANGE); }
    if (negative) { cents = -cents; }

    return { ok: true, cents: cents, negative: negative };
  }

  /* 契约 §6.1：默认拒绝负数；期初余额等场景显式 allowNegative:true */
  function parseToCents(text, opts) {
    var allowNegative = !!(opts && opts.allowNegative === true);
    var result = parseInternal(text);
    if (!result.ok) { return result; }
    if (result.negative && !allowNegative) {
      return fail(E_NEGATIVE);
    }
    return { ok: true, cents: result.cents, negative: result.negative };
  }

  /* 任务书 API：支持负号（返回带符号的分），其余规则同 parseToCents */
  function parseAmount(text, opts) {
    var allowNegative = !opts || opts.allowNegative !== false;
    return parseToCents(text, { allowNegative: allowNegative });
  }

  function groupThousands(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* 契约 §6.1：默认 ¥1,234.56；负号在最前；hidden 固定四个圆点 */
  function formatCents(cents, opts) {
    opts = opts || {};
    if (opts.hidden === true) { return '\u2022\u2022\u2022\u2022'; }

    var n = Number(cents);
    if (!isFinite(n)) { n = 0; }
    /* 仅用于展示兜底：非整数分四舍五入到分（业务层仍必须传整数） */
    n = n < 0 ? -Math.round(-n) : Math.round(n);

    var negative = n < 0;
    var abs = Math.abs(n);
    var yuan = Math.floor(abs / 100);
    var fen = abs % 100;
    var text = groupThousands(String(yuan)) + '.' + (fen < 10 ? '0' + fen : String(fen));
    var body = (opts.symbol === false ? '' : '¥') + text;

    if (negative) { return '-' + body; }
    if (opts.sign === true && n > 0) { return '+' + body; }
    return body;
  }

  function trimTrailingZero(text) {
    return text.replace(/\.0$/, '');
  }

  /* 契约 §6.1：>=1 亿元用亿，>=1 万元用万，否则同 formatCents */
  function formatCompact(cents) {
    var n = Number(cents);
    if (!isFinite(n)) { n = 0; }
    n = n < 0 ? -Math.round(-n) : Math.round(n);
    var abs = Math.abs(n);

    if (abs >= 10000000000) {
      var yi = Math.round(abs / 1000000000) / 10;
      return (n < 0 ? '-' : '') + '¥' + trimTrailingZero(String(yi)) + '亿';
    }
    if (abs >= 1000000) {
      var wan = Math.round(abs / 100000) / 10;
      return (n < 0 ? '-' : '') + '¥' + trimTrailingZero(String(wan)) + '万';
    }
    return formatCents(n);
  }

  /* 契约 §6.1：普通 number 累加，每步断言安全整数；失败返回 NaN */
  function sumCents(list) {
    if (!Array.isArray(list)) { return NaN; }
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (typeof n !== 'number' || !Number.isSafeInteger(n)) { return NaN; }
      total += n;
      if (!Number.isSafeInteger(total)) { return NaN; }
    }
    return total;
  }

  /* 安全加减：入参越界或结果越界统一 E_AMOUNT_TOO_LARGE */
  function checkOperand(n) {
    if (!isFiniteNumber(n)) { return E_INVALID; }
    if (Math.floor(n) !== n || !Number.isSafeInteger(n)) { return E_INVALID; }
    if (n > MAX_CENTS || n < MIN_CENTS) { return E_TOO_LARGE; }
    return null;
  }

  function addCents(a, b) {
    var ea = checkOperand(a);
    var eb = checkOperand(b);
    if (ea || eb) { return fail(ea || eb); }
    var result = a + b;
    if (!Number.isSafeInteger(result) || result > MAX_CENTS || result < MIN_CENTS) {
      return fail(E_TOO_LARGE);
    }
    return { ok: true, cents: result };
  }

  function subCents(a, b) {
    var ea = checkOperand(a);
    var eb = checkOperand(b);
    if (ea || eb) { return fail(ea || eb); }
    var result = a - b;
    if (!Number.isSafeInteger(result) || result > MAX_CENTS || result < MIN_CENTS) {
      return fail(E_TOO_LARGE);
    }
    return { ok: true, cents: result };
  }

  /* 四舍五入到整数，正负对称（-0.5 -> -1，0.5 -> 1） */
  function roundHalfAwayFromZero(value) {
    return value < 0 ? -Math.round(-value) : Math.round(value);
  }

  /* 预算百分比：rate 在 -1..1 之间按比例（0.8=80%），其余按百分数（80=80%）。
   * 舍入策略：四舍五入到分，正负对称；结果越界/非法返回 NaN。
   */
  function mulRate(cents, rate) {
    if (!isCents(cents)) { return NaN; }
    var r = Number(rate);
    if (!isFinite(r)) { return NaN; }
    if (r > 1 || r < -1) { r = r / 100; }
    var product = cents * r;
    if (!isFinite(product)) { return NaN; }
    var result = roundHalfAwayFromZero(product);
    if (!Number.isSafeInteger(result) || result > MAX_CENTS || result < MIN_CENTS) {
      return NaN;
    }
    return result;
  }

  /* 按权重拆分：先对正数取 floor，余数全部补到最后一笔；负数对称处理。
   * weights 非法 / 总权重 <=0 时返回 []（调用方应视为不可拆分）。
   */
  function splitCents(total, weights) {
    if (!isCents(total) || !Array.isArray(weights) || weights.length === 0) { return []; }
    var clean = [];
    var sum = 0;
    for (var i = 0; i < weights.length; i++) {
      var w = Number(weights[i]);
      if (!isFinite(w) || w < 0) { return []; }
      clean.push(w);
      sum += w;
    }
    if (!isFinite(sum) || sum <= 0) { return []; }

    var sign = total < 0 ? -1 : 1;
    var absTotal = Math.abs(total);
    var parts = [];
    var used = 0;
    for (var j = 0; j < clean.length - 1; j++) {
      var part = Math.floor(absTotal * clean[j] / sum);
      if (!Number.isSafeInteger(part)) { return []; }
      parts.push(part);
      used += part;
    }
    var last = absTotal - used;
    if (!Number.isSafeInteger(last) || last < 0) { return []; }
    parts.push(last);

    var out = [];
    for (var k = 0; k < parts.length; k++) {
      out.push(parts[k] * sign);
    }
    return out;
  }

  /* 供 UI / 迁移层做输入清洗；不负责校验，校验仍走 parseToCents */
  function sanitizeAmountInput(text) {
    return normalizeAmountText(text);
  }

  /* 元 -> 分（导入 v1 时用）；失败返回 null，避免浮点乘法 */
  function yuanToCents(yuan) {
    if (yuan === null || yuan === undefined) { return null; }
    var text = typeof yuan === 'number' ? String(yuan) : String(yuan);
    var result = parseToCents(text, { allowNegative: true });
    return result.ok ? result.cents : null;
  }

  /* 分 -> 元（仅展示/迁移，不用于运算） */
  function centsToYuan(cents) {
    if (!isCents(cents)) { return NaN; }
    return cents / 100;
  }

  var api = Object.freeze({
    MAX_CENTS: MAX_CENTS,
    MIN_CENTS: MIN_CENTS,
    isCents: isCents,

    /* 任务书 API */
    parseAmount: parseAmount,
    formatCents: formatCents,
    addCents: addCents,
    subCents: subCents,
    mulRate: mulRate,
    splitCents: splitCents,

    /* 契约 §6.1 与 SPEC 兼容 API */
    parseToCents: parseToCents,
    parseAmountToCents: parseToCents,
    formatCompact: formatCompact,
    sumCents: sumCents,
    sanitizeAmountInput: sanitizeAmountInput,
    yuanToCents: yuanToCents,
    centsToYuan: centsToYuan
  });

  Core.money = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.money = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
