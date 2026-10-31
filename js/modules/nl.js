/* 小账本 2.0 · js/core/nl.js · owner: backend（T08）
 * 契约锚点：CONTRACT §6.5（一句话解析）、§8（E_NL_* 错误码）、D14（多候选）。
 * 硬规则：纯函数、零网络、零第三方分词、零 eval；金额一律换算成「分」整数；
 * 日期一律本地字符串；不读 DOM / 不写存储；不修改传入的 ctx。
 *
 * 对外主 API（任务书第 2 波）：
 *   XZB.core.nl.parse(text, ctx) -> {
 *     ok:true, candidates:[...], best,
 *     draft, matches, confidence, warnings          // CONTRACT §6.5 兼容字段
 *   } | { ok:false, code, message, partial, warnings }
 *   XZB.core.nl.parseAmount(text) -> { ok:true, cents, raw } | { ok:false, code }
 *
 * 设计取舍（与文档字面不一致处见 T08 汇报）：
 * 1) 契约只列 expense/income，但 UI 6.4 明确「还款=转账」，这里候选允许 transfer，
 *    并附带 toAccountId；draft.type 同样可能是 transfer。
 * 2) 契约正文说备注删除分类词，但 §6.5 十条逐字验收与 UI 示例都保留分类词
 *    （「昨天午饭28微信」备注必须是「午饭」），这里以验收示例为准。
 * 3) ctx.today 缺省时读本机今天；ctx.nowTime 可注入，便于单测。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  XZB.version = XZB.version || '2.2.0';
  var Core = XZB.Core || (XZB.Core = {});
  if (!XZB.core) { XZB.core = Core; }

  /* ------------------------------------------------------------------ *
   * 0. 常量与错误码（CONTRACT §8 真实存在，不自造）
   * ------------------------------------------------------------------ */

  var MAX_CENTS = 999999999999;
  var E_NO_AMOUNT = 'E_NL_NO_AMOUNT';
  var E_AMOUNT = 'E_NL_AMOUNT';
  var E_PARSE = 'E_NL_PARSE';
  var NL_MESSAGE = {
    E_NL_NO_AMOUNT: '没听清金额，试试「午饭28微信」',
    E_NL_AMOUNT: '金额不对，请检查',
    E_NL_PARSE: '没听懂，试试手动填写'
  };

  var CN_DIGITS = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
  };
  var CN_UNITS = { '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000 };
  var CN_DIGIT_CHARS = '零〇一二两三四五六七八九';
  var CN_NUM_CHARS = CN_DIGIT_CHARS + '十百千万亿';

  /* 量词 / 日期单位：阿拉伯数字后面紧跟这些时，不当作金额 */
  /* 注意：不要把「本 / 支 / 晚」等常见词首字放进单字量词表，
   * 否则「28本月」「28支付宝」「28晚上」会被误判成「28 个量词」而丢掉金额。 */
  var QUANTIFIER_CHARS = '张个杯份次人斤克米岁天月日号点周楼层面件台瓶盒包袋只双套辆座间页节章门科名位颗粒片条根棵头匹';
  var QUANTIFIER_WORDS = ['公里', '公斤', '分钟', '小时', '星期', '礼拜', '毫升', '厘米', '毫米'];

  /* 分类别名：CONTRACT §6.5 内置表，作为 system 分类的权威词表。
   * 种子里的 aliases 也会合并，但过滤掉过于宽泛的单字「买」，
   * 否则「买书」会被判成购物（种子 shopping 的 sort 比 study 小）。 */
  var CATEGORY_ALIASES = {
    ca_food: ['吃饭', '早饭', '午饭', '晚饭', '夜宵', '外卖', '咖啡', '奶茶', '零食', '聚餐', '食堂'],
    ca_transport: ['打车', '地铁', '公交', '加油', '停车', '高铁', '机票', '共享单车'],
    ca_shopping: ['淘宝', '京东', '拼多多', '超市', '商场', '衣服', '鞋', '日用品'],
    ca_home: ['房租', '水电', '燃气', '物业', '宽带', '家具', '维修'],
    ca_fun: ['电影', '游戏', '演出', 'KTV', '会员', '旅游'],
    ca_health: ['医院', '看病', '买药', '体检', '牙科', '健身'],
    ca_study: ['书', '课程', '培训', '考试', '文具'],
    ca_comm: ['话费', '流量', '宽带费', '手机费'],
    ca_social: ['红包', '礼物', '随礼', '请客', '人情'],
    ca_other_expense: ['其他', '杂项'],
    ca_salary: ['工资', '薪水', '月薪', '发工资'],
    ca_bonus: ['奖金', '年终奖', '提成'],
    ca_invest: ['理财', '利息', '分红', '基金'],
    ca_parttime: ['兼职', '外快', '副业'],
    ca_redpacket: ['收红包', '红包收入'],
    ca_other_income: ['其他收入', '退款', '报销']
  };

  /* 类型词：只用于「显式类型」判定；分类别名本身也能反推类型 */
  var INCOME_WORDS = ['收入', '收到', '工资', '发工资', '退款', '报销', '奖金', '利息', '月薪', '薪水', '年终奖', '提成', '分红'];
  var EXPENSE_WORDS = ['支出', '花了', '花掉', '付了', '买了', '消费'];
  var TRANSFER_STRONG = ['转账', '转到', '转给', '还款'];
  var CONNECTIVE_TOKENS = ['在', '用', '花', '付', '买', '了', '的', '给', '一笔', '还', '从', '到'];
  var LEADING_FILLERS = ['买了', '付了', '花了', '用了', '给了', '一笔', '的', '了'];
  var TRAILING_FILLERS = ['了', '的', '一笔'];

  /* 账户类型词（最长匹配；中文不分词，大小写不敏感对拉丁字母无实际影响） */
  var ACCOUNT_TYPE_WORDS = [
    { word: '微信支付', types: ['wechat'] },
    { word: '支付宝', types: ['alipay'] },
    { word: '余额宝', types: ['alipay'] },
    { word: '储蓄卡', types: ['debit'] },
    { word: '借记卡', types: ['debit'] },
    { word: '工资卡', types: ['debit'] },
    { word: '银行卡', types: ['debit'] },
    { word: '信用卡', types: ['credit'] },
    { word: '贷记卡', types: ['credit'] },
    { word: '花呗', types: ['credit'] },
    { word: '微信', types: ['wechat'] },
    { word: '零钱', types: ['wechat'] },
    { word: '现金', types: ['cash'] },
    { word: '钱包', types: ['cash'] },
    { word: '现钞', types: ['cash'] },
    { word: '储蓄', types: ['savings'] },
    { word: '存款', types: ['savings'] },
    { word: '定期', types: ['savings'] }
  ];

  /* 银行简称：在账户 name 中找包含关系 */
  var BANK_WORDS = ['招商银行', '工商银行', '建设银行', '农业银行', '中国银行', '交通银行', '邮政储蓄',
    '招商', '招行', '工商', '工行', '建设', '建行', '农业', '农行', '中行', '交行', '邮储', '邮政'];

  /* ------------------------------------------------------------------ *
   * 1. 通用小工具（日期、空白、命名空间依赖）
   * ------------------------------------------------------------------ */

  function moneyApi() {
    return (Core && Core.money) || (XZB.core && XZB.core.money) || null;
  }

  function datesApi() {
    return (Core && Core.dates) || (XZB.core && XZB.core.dates) || null;
  }

  function schemaApi() {
    return (Core && Core.schema) || (XZB.core && XZB.core.schema) || null;
  }

  function isStr(v) { return typeof v === 'string'; }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObj(v) { return v !== null && typeof v === 'object' && !isArr(v); }
  function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  }

  function daysInMonth(y, m) {
    if (m === 2) { return isLeapYear(y) ? 29 : 28; }
    if (m === 4 || m === 6 || m === 9 || m === 11) { return 30; }
    return 31;
  }

  function isValidDateParts(y, m, d) {
    return y >= 1000 && y <= 9999 && m >= 1 && m <= 12 &&
      d >= 1 && d <= daysInMonth(y, m);
  }

  function formatYmd(y, m, d) {
    return String(y) + '-' + pad2(m) + '-' + pad2(d);
  }

  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) { return null; }
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10);
    var d = parseInt(m[3], 10);
    if (!isValidDateParts(y, mo, d)) { return null; }
    return { y: y, m: mo, d: d };
  }

  function isValidDateStr(s) {
    return isStr(s) && parseYmd(s) !== null;
  }

  function makeLocalDate(y, m, d) {
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  function addDaysStr(dateStr, delta) {
    var p = parseYmd(dateStr);
    if (!p) { return dateStr; }
    var dt = makeLocalDate(p.y, p.m, p.d);
    dt.setDate(dt.getDate() + delta);
    return formatYmd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }

  function addMonthsStr(dateStr, delta) {
    var p = parseYmd(dateStr);
    if (!p) { return dateStr; }
    var total = (p.y * 12) + (p.m - 1) + delta;
    var y = Math.floor(total / 12);
    var m = (total % 12 + 12) % 12 + 1;
    var d = Math.min(p.d, daysInMonth(y, m));
    return formatYmd(y, m, d);
  }

  function weekdayOf(dateStr) {
    var p = parseYmd(dateStr);
    if (!p) { return 0; }
    return makeLocalDate(p.y, p.m, p.d).getDay(); // 0=周日 … 6=周六（D16.3）
  }

  function localTodayStr() {
    var d = new Date();
    return formatYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function localNowTime() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function isValidTimeStr(s) {
    return isStr(s) && /^([01]\d|2[0-3]):([0-5]\d)$/.test(s);
  }

  function normalizeCtx(ctx) {
    var input = isObj(ctx) ? ctx : {};
    var dApi = datesApi();
    var today = input.today;
    if (!isValidDateStr(today)) {
      if (dApi && typeof dApi.todayStr === 'function') { today = dApi.todayStr(); }
      else { today = localTodayStr(); }
    }
    var defaults = isObj(input.defaults) ? input.defaults : {};
    return {
      today: today,
      nowTime: isValidTimeStr(input.nowTime) ? input.nowTime : null,
      accounts: isArr(input.accounts) ? input.accounts : [],
      categories: isArr(input.categories) ? input.categories : [],
      activeBookId: isStr(input.activeBookId) ? input.activeBookId : null,
      allowArchived: input.allowArchived === true,
      defaults: {
        type: defaults.type === 'income' ? 'income' : 'expense',
        accountId: isStr(defaults.accountId) ? defaults.accountId : null,
        categoryId: isStr(defaults.categoryId) ? defaults.categoryId : null
      }
    };
  }

  function nowTimeOf(ctx) {
    if (ctx && isValidTimeStr(ctx.nowTime)) { return ctx.nowTime; }
    var dApi = datesApi();
    if (dApi && typeof dApi.nowTime === 'function') {
      var t = dApi.nowTime();
      if (isValidTimeStr(t)) { return t; }
    }
    return localNowTime();
  }

  function pushWarning(list, msg) {
    if (isStr(msg) && msg && list.indexOf(msg) < 0) { list.push(msg); }
  }

  /* ------------------------------------------------------------------ *
   * 2. 预处理（CONTRACT §6.5 预处理 1–4）
   * ------------------------------------------------------------------ */

  function toHalfWidth(text) {
    var s = String(text);
    s = s.replace(/[０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/：/g, ':')
      .replace(/．/g, '.')
      .replace(/，/g, ',')
      .replace(/￥/g, '¥')
      .replace(/＃/g, '#')
      .replace(/－/g, '-')
      .replace(/　/g, ' ');
    return s;
  }

  function stripLeadingFixedWords(s) {
    var prefixes = ['帮我记一笔', '帮我记账', '帮我记', '记一笔', '记账', '花了'];
    var removed = [];
    var changed = true;
    var guard = 0;
    while (changed && guard < 6) {
      changed = false;
      guard += 1;
      for (var i = 0; i < prefixes.length; i++) {
        var p = prefixes[i];
        if (s.indexOf(p) === 0) {
          removed.push(p);
          s = s.slice(p.length).replace(/^[\s,，。.!！?？]+/, '');
          changed = true;
          break;
        }
      }
    }
    return { text: s, removed: removed, expenseSignal: removed.indexOf('花了') >= 0 };
  }

  function preprocess(text) {
    var warnings = [];
    var raw = isStr(text) ? text : '';
    var s = toHalfWidth(raw).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var stripped = stripLeadingFixedWords(s);
    s = stripped.text;
    var chars = Array.from(s);
    if (chars.length > 120) {
      s = chars.slice(0, 120).join('');
      pushWarning(warnings, '文本过长，只解析前 120 字');
    }
    return {
      original: raw,
      work: s,
      warnings: warnings,
      leadingExpense: stripped.expenseSignal,
      truncated: chars.length > 120
    };
  }

  /* ------------------------------------------------------------------ *
   * 3. 中文数字 → 整数（覆盖万/亿，支持「一百二」「一万二」口语省位）
   * ------------------------------------------------------------------ */

  function cnDigit(ch) {
    return hasOwn(CN_DIGITS, ch) ? CN_DIGITS[ch] : -1;
  }

  function cnUnit(ch) {
    return hasOwn(CN_UNITS, ch) ? CN_UNITS[ch] : 0;
  }

  /* 规则：
   * - 十/百/千：number * unit 累加到 section；
   * - 万/亿：先结算 section，再整体进到总位；
   * - 口语省位：末尾数字紧跟在 百/千/万/亿 后（如一百二、一千五、一万二），
   *   该数字代表 unit/10，而不是 unit；十 不适用（十二 就是 12）。 */
  function cnToInt(s) {
    if (!isStr(s) || s === '') { return 0; }
    var total = 0;
    var section = 0;
    var number = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var d = cnDigit(ch);
      if (d >= 0) { number = d; continue; }
      var u = cnUnit(ch);
      if (!u) { return NaN; }
      if (u === 10000 || u === 100000000) {
        section = (section + number) * u;
        total += section;
        section = 0;
        number = 0;
      } else {
        if (number === 0) { number = 1; }
        section += number * u;
        number = 0;
      }
    }
    var value = total + section + number;
    if (s.length >= 3) {
      var last = s.charAt(s.length - 1);
      var prev = s.charAt(s.length - 2);
      var lastD = cnDigit(last);
      if (lastD >= 0 && (prev === '百' || prev === '千' || prev === '万' || prev === '亿')) {
        var pu = cnUnit(prev);
        value = value - lastD + lastD * (pu / 10);
      }
    }
    return value;
  }

  function cnParts(s) {
    var dot = s.indexOf('点');
    var intStr = dot >= 0 ? s.slice(0, dot) : s;
    var fracStr = dot >= 0 ? s.slice(dot + 1) : '';
    var intVal = cnToInt(intStr);
    if (!isFinite(intVal)) { return null; }
    var frac = '';
    for (var i = 0; i < fracStr.length; i++) {
      var d = cnDigit(fracStr.charAt(i));
      if (d < 0) { return null; }
      frac += String(d);
    }
    return { int: intVal, frac: frac, hasPoint: dot >= 0 };
  }

  function fracToCents(frac) {
    if (!frac) { return 0; }
    if (frac.length === 1) { return parseInt(frac, 10) * 10; }
    if (frac.length === 2) { return parseInt(frac, 10); }
    return NaN;
  }

  /* ------------------------------------------------------------------ *
   * 4. 金额解析：阿拉伯数字、中文数字、元/块/毛/角/分与口语尾数
   * ------------------------------------------------------------------ */

  function isBlocked(mask, start, end) {
    for (var i = start; i < end; i++) {
      if (mask[i]) { return true; }
    }
    return false;
  }

  function markMask(mask, start, end) {
    for (var i = start; i < end; i++) { mask[i] = true; }
  }

  function isArabicDigit(ch) { return ch >= '0' && ch <= '9'; }

  function skipSpacesOne(work, p) {
    var n = 0;
    while (work.charAt(p) === ' ' && n < 2) { p += 1; n += 1; }
    return p;
  }

  /* 数字后是否是量词/日期单位，避免「2张」「3天」「5号」被当金额 */
  function isQuantifierAhead(work, pos) {
    var p = skipSpacesOne(work, pos);
    var ch = work.charAt(p);
    if (ch && QUANTIFIER_CHARS.indexOf(ch) >= 0) { return true; }
    var two = work.substr(p, 2);
    if (QUANTIFIER_WORDS.indexOf(two) >= 0) { return true; }
    if (ch === '%' || ch === '折') { return true; }
    return false;
  }

  function isDateLikeAhead(work, pos) {
    var p = skipSpacesOne(work, pos);
    var ch = work.charAt(p);
    if (ch === ':' || ch === '/' || ch === '-') {
      return isArabicDigit(work.charAt(p + 1));
    }
    return false;
  }

  /* 元/块 后面的口语尾数：12块5、三块五、三块五毛五、三块零五分 */
  function readTailDigit(work, p) {
    var ch = work.charAt(p);
    if (isArabicDigit(ch)) {
      var digits = '';
      while (isArabicDigit(work.charAt(p)) && digits.length < 2) {
        digits += work.charAt(p);
        p += 1;
      }
      return { value: parseInt(digits, 10), len: digits.length, raw: digits };
    }
    var d = cnDigit(ch);
    if (d >= 0) { return { value: d, len: 1, raw: ch }; }
    return null;
  }

  function readMoneyTail(work, p, baseCents) {
    var cents = baseCents;
    var end = p;
    if (work.charAt(end) === '钱') { end += 1; }
    if (work.charAt(end) === '整') { end += 1; }
    var zero = false;
    if (work.charAt(end) === '零') { zero = true; end += 1; }

    var d = readTailDigit(work, end);
    if (!d) { return { cents: cents, end: end }; }
    end += d.len;
    var unit = work.charAt(end);
    if (unit === '毛' || unit === '角') {
      cents += d.value * 10;
      end += 1;
      var f = readTailDigit(work, end);
      if (f) {
        end += f.len;
        if (work.charAt(end) === '分') { end += 1; }
        cents += f.value;
      }
      return { cents: cents, end: end };
    }
    if (unit === '分') {
      cents += d.value;
      end += 1;
      return { cents: cents, end: end };
    }
    if (zero || d.len === 2) {
      cents += d.value;
    } else {
      cents += d.value * 10;
    }
    return { cents: cents, end: end };
  }

  function arabicCents(core, frac) {
    var intPart = core.replace(/,/g, '');
    if (!/^\d+$/.test(intPart)) { return NaN; }
    if (intPart.length > 12) { return NaN; }
    var cents = parseInt(intPart, 10) * 100;
    if (frac) {
      var f = frac.replace(/^\./, '');
      if (f.length > 2) { return NaN; }
      if (f.length === 1) { cents += parseInt(f, 10) * 10; }
      else if (f.length === 2) { cents += parseInt(f, 10); }
    }
    return cents;
  }

  function pushAmountToken(tokens, token) {
    token.cents = typeof token.cents === 'number' && isFinite(token.cents) ? token.cents : null;
    if (token.cents !== null && token.cents > 0) {
      token.valid = true;
    } else {
      token.valid = false;
    }
    tokens.push(token);
  }

  function scanArabicAmounts(work, blocked, tokens) {
    var re = /(?:¥\s*)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;
    var m;
    while ((m = re.exec(work)) !== null) {
      var core = m[1];
      var frac = m[2] || '';
      var tokenStart = m.index;
      var coreStart = tokenStart + m[0].lastIndexOf(core);
      var coreEnd = re.lastIndex;
      if (isBlocked(blocked, tokenStart, coreEnd)) { continue; }

      var prev = tokenStart > 0 ? work.charAt(tokenStart - 1) : '';
      if (/[\dA-Za-z_]/.test(prev)) { continue; }
      if (prev === '.' || prev === ',' || prev === ':') { continue; }
      if (prev === '-' || prev === '−' || prev === '—') {
        pushAmountToken(tokens, {
          start: tokenStart, end: coreEnd, raw: work.slice(tokenStart, coreEnd),
          cents: null, hasUnit: false, unit: '', source: 'arabic', error: 'negative'
        });
        continue;
      }

      var p = skipSpacesOne(work, coreEnd);
      var unit = work.charAt(p);
      var cents = null;
      var end = coreEnd;
      var hasUnit = false;
      var unitName = '';
      var error = '';

      if (frac && frac.length > 3) {
        error = 'precision';
      }
      if (core.indexOf(',') >= 0 && !/^\d{1,3}(,\d{3})+$/.test(core)) {
        error = 'invalid';
      }

      if (unit === '元' || unit === '块' || unit === '圆') {
        hasUnit = true;
        unitName = unit;
        if (!error) {
          cents = arabicCents(core, frac);
          var yuanEnd = p + 1;
          var tail = readMoneyTail(work, yuanEnd, cents);
          cents = tail.cents;
          end = tail.end;
        } else {
          end = p + 1;
        }
      } else if (unit === '毛' || unit === '角') {
        hasUnit = true;
        unitName = unit;
        if (!error) {
          /* 毛/角是 1/10 元：先按元算成分，再除以 10；3毛5 = 35 分 */
          var yuanCents = arabicCents(core, frac);
          if (isFinite(yuanCents) && yuanCents % 10 === 0) {
            cents = yuanCents / 10;
            end = p + 1;
            var jf = readTailDigit(work, end);
            if (jf) {
              end += jf.len;
              if (work.charAt(end) === '分') { end += 1; }
              cents += jf.value;
            }
          } else {
            error = 'precision';
            end = p + 1;
          }
        } else {
          end = p + 1;
        }
      } else if (unit === '分') {
        var afterFen = work.charAt(p + 1);
        if (afterFen === '钟' || afterFen === '之' || afterFen === '享' ||
            afterFen === '手' || afterFen === '数' || afterFen === '开' || afterFen === '别') {
          continue;
        }
        hasUnit = true;
        unitName = unit;
        if (!error) {
          /* 分就是 1 分，不再乘 100；5分 = 5 分 */
          var fenYuan = arabicCents(core, frac);
          if (isFinite(fenYuan) && fenYuan % 100 === 0) {
            cents = fenYuan / 100;
            end = p + 1;
          } else {
            error = 'precision';
            end = p + 1;
          }
        } else {
          end = p + 1;
        }
      } else if (unit === '万' || unit === '千' || unit === '百') {
        /* 阿拉伯数字直接接中文量级：12万=120000 元，3千=3000 元；
         * 口语尾数 1万2=12000 元、3千5=3500 元。 */
        hasUnit = true;
        unitName = unit;
        if (!error) {
          var magBase = arabicCents(core, frac);
          if (isFinite(magBase)) {
            var mag = unit === '万' ? 10000 : (unit === '千' ? 1000 : 100);
            cents = magBase * mag;
            end = p + 1;
            if (work.charAt(end) === '元' || work.charAt(end) === '块' || work.charAt(end) === '圆') {
              end += 1;
            }
            if (!frac) {
              var magTail = readTailDigit(work, end);
              if (magTail) {
                var tailMag = unit === '万' ? 100000 : (unit === '千' ? 10000 : 1000);
                cents += magTail.value * tailMag;
                end += magTail.len;
              }
            }
          } else {
            error = 'invalid';
            end = p + 1;
          }
        } else {
          end = p + 1;
        }
      } else {
        if (isQuantifierAhead(work, coreEnd) || isDateLikeAhead(work, coreEnd)) { continue; }
        var next = work.charAt(coreEnd);
        if (next === ',' || next === '.') { error = 'invalid'; }
        if (!error) { cents = arabicCents(core, frac); }
        end = coreEnd;
      }

      if (error) { cents = null; }
      pushAmountToken(tokens, {
        start: tokenStart, end: end, raw: work.slice(tokenStart, end),
        cents: cents, hasUnit: hasUnit, unit: unitName,
        source: 'arabic', error: error
      });
      re.lastIndex = Math.max(re.lastIndex, end);
    }
  }

  function scanChineseAmounts(work, blocked, tokens) {
    var re = new RegExp('[' + CN_NUM_CHARS + ']+(?:点[' + CN_DIGIT_CHARS + ']+)?', 'g');
    var m;
    while ((m = re.exec(work)) !== null) {
      var rawNum = m[0];
      var start = m.index;
      var end = re.lastIndex;
      if (isBlocked(blocked, start, end)) { continue; }
      if (start > 0 && work.charAt(start - 1) === '第') { continue; }
      if (start > 0 && CN_NUM_CHARS.indexOf(work.charAt(start - 1)) >= 0) { continue; }

      var p = skipSpacesOne(work, end);
      var unit = work.charAt(p);
      var parts = cnParts(rawNum);
      if (!parts) { continue; }
      var cents = null;
      var hasUnit = false;
      var unitName = '';
      var tokenEnd = end;
      var error = '';

      if (unit === '元' || unit === '块' || unit === '圆') {
        hasUnit = true;
        unitName = unit;
        var fc = fracToCents(parts.frac);
        if (!isFinite(fc) || parts.frac.length > 2) {
          error = 'precision';
        } else {
          cents = parts.int * 100 + fc;
          var tail = readMoneyTail(work, p + 1, cents);
          cents = tail.cents;
          tokenEnd = tail.end;
        }
      } else if (unit === '毛' || unit === '角') {
        hasUnit = true;
        unitName = unit;
        cents = parts.int * 10 + (parts.frac ? parseInt(parts.frac.charAt(0), 10) : 0);
        tokenEnd = p + 1;
        var jf = readTailDigit(work, tokenEnd);
        if (jf) {
          tokenEnd += jf.len;
          if (work.charAt(tokenEnd) === '分') { tokenEnd += 1; }
          cents += jf.value;
        }
      } else if (unit === '分') {
        var afterFen = work.charAt(p + 1);
        if (afterFen === '钟' || afterFen === '之' || afterFen === '享' ||
            afterFen === '手' || afterFen === '数' || afterFen === '开' || afterFen === '别' ||
            afterFen === '好' || afterFen === '满' || afterFen === '重') {
          continue;
        }
        hasUnit = true;
        unitName = unit;
        cents = parts.int;
        tokenEnd = p + 1;
      } else {
        if (isQuantifierAhead(work, end) || isDateLikeAhead(work, end)) { continue; }
        if (!parts.hasPoint && (rawNum.length < 2 || parts.int < 10)) { continue; }
        if (parts.hasPoint && parts.frac.length > 2) { error = 'precision'; }
        if (!error) { cents = parts.int * 100 + fracToCents(parts.frac); }
      }

      if (error) { cents = null; }
      pushAmountToken(tokens, {
        start: start, end: tokenEnd, raw: work.slice(start, tokenEnd),
        cents: cents, hasUnit: hasUnit, unit: unitName,
        source: 'chinese', error: error
      });
      re.lastIndex = Math.max(re.lastIndex, tokenEnd);
    }
  }

  function collectAmounts(work, blocked) {
    var tokens = [];
    scanArabicAmounts(work, blocked, tokens);
    scanChineseAmounts(work, blocked, tokens);
    tokens.sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
    return tokens;
  }

  function chooseAmountToken(tokens, warnings) {
    var valid = [];
    var invalid = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.valid) { valid.push(t); }
      else { invalid.push(t); }
    }
    if (!valid.length) {
      if (invalid.length) {
        return { ok: false, code: E_AMOUNT, token: invalid[invalid.length - 1] };
      }
      return { ok: false, code: E_NO_AMOUNT, token: null };
    }
    var chosen = null;
    for (var j = 0; j < valid.length; j++) {
      if (valid[j].hasUnit) { chosen = valid[j]; }
    }
    if (!chosen) { chosen = valid[valid.length - 1]; }
    if (valid.length > 1) {
      pushWarning(warnings, chosen.hasUnit
        ? '识别到多个金额，已取最后一个带单位的金额'
        : '识别到多个金额，已取最后一个金额');
    }
    if (chosen.cents <= 0 || chosen.cents > MAX_CENTS) {
      return { ok: false, code: E_AMOUNT, token: chosen };
    }
    return { ok: true, token: chosen };
  }

  /* 独立的金额 API：只解析一段金额文本，供单元测试与手动输入兜底 */
  function parseAmount(text) {
    var pre = preprocess(text);
    if (!pre.work) {
      return { ok: false, code: E_NO_AMOUNT, message: NL_MESSAGE[E_NO_AMOUNT] };
    }
    var mask = new Array(pre.work.length);
    var ctx = normalizeCtx(null);
    var dp = planDate(pre.work, ctx, { mdAsDate: false });
    for (var i = 0; i < dp.spans.length; i++) {
      markMask(mask, dp.spans[i].start, dp.spans[i].end);
    }
    var tokens = collectAmounts(pre.work, mask);
    var pick = chooseAmountToken(tokens, []);
    if (!pick.ok) {
      return {
        ok: false,
        code: pick.code,
        message: NL_MESSAGE[pick.code] || NL_MESSAGE[E_AMOUNT]
      };
    }
    return { ok: true, cents: pick.token.cents, raw: pick.token.raw, unit: pick.token.unit };
  }

  /* ------------------------------------------------------------------ *
   * 5. 日期 / 时间解析（CONTRACT §6.5 时间词表）
   * ------------------------------------------------------------------ */

  function dateMatch(start, end, raw, date, time, valid, kind) {
    return {
      start: start, end: end, raw: raw, date: date || null,
      time: time || null, valid: valid !== false, kind: kind || 'date'
    };
  }

  function overlapsAny(list, start, end) {
    for (var i = 0; i < list.length; i++) {
      if (start < list[i].end && end > list[i].start) { return true; }
    }
    return false;
  }

  function addDateMatch(list, item) {
    if (overlapsAny(list, item.start, item.end)) { return false; }
    list.push(item);
    return true;
  }

  function eachMatch(work, re, fn) {
    var m;
    while ((m = re.exec(work)) !== null) {
      fn(m, m.index, re.lastIndex, function () { re.lastIndex = Math.max(re.lastIndex, m.index + 1); });
    }
  }

  function weekdayIndexFromChar(ch) {
    if (ch === '日' || ch === '天') { return 0; }
    var map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    return hasOwn(map, ch) ? map[ch] : -1;
  }

  function weekdayDate(today, target, mode) {
    var todayDow = weekdayOf(today);
    if (mode === 'last') {
      var delta = (todayDow - target + 7) % 7;
      return addDaysStr(today, -delta);
    }
    if (mode === 'lastweek') {
      var lastMonday = addDaysStr(today, -((todayDow + 6) % 7) - 7);
      var offset = target === 0 ? 6 : target - 1;
      return addDaysStr(lastMonday, offset);
    }
    if (mode === 'nextweek') {
      var nextMonday = addDaysStr(today, -((todayDow + 6) % 7) + 7);
      var noff = target === 0 ? 6 : target - 1;
      return addDaysStr(nextMonday, noff);
    }
    if (mode === 'thisweek') {
      var monday = addDaysStr(today, -((todayDow + 6) % 7));
      var toff = target === 0 ? 6 : target - 1;
      return addDaysStr(monday, toff);
    }
    return today;
  }

  function collectDateMatches(work, ctx, opts) {
    var list = [];
    var today = ctx.today;

    /* 组合词先跑，确保「昨晚」「今早」整体命中，不会被「晚上 / 今」拆开 */
    eachMatch(work, /(今天早上|今日早上|今早)/g, function (m, s, e) {
      addDateMatch(list, dateMatch(s, e, m[0], today, '08:00', true, 'combined'));
    });
    eachMatch(work, /(昨天早上|昨日早上|昨天上午|昨日上午)/g, function (m, s, e) {
      addDateMatch(list, dateMatch(s, e, m[0], addDaysStr(today, -1), '08:00', true, 'combined'));
    });
    eachMatch(work, /(昨晚|昨天晚上|昨日晚上)/g, function (m, s, e) {
      addDateMatch(list, dateMatch(s, e, m[0], addDaysStr(today, -1), '20:00', true, 'combined'));
    });
    eachMatch(work, /(今晚|今天晚上)/g, function (m, s, e) {
      addDateMatch(list, dateMatch(s, e, m[0], today, '20:00', true, 'combined'));
    });
    eachMatch(work, /(明早|明天早上|明日早上)/g, function (m, s, e) {
      addDateMatch(list, dateMatch(s, e, m[0], addDaysStr(today, 1), '08:00', true, 'combined'));
    });
    eachMatch(work, /(明晚|明天晚上|明日晚上)/g, function (m, s, e) {
      addDateMatch(list, dateMatch(s, e, m[0], addDaysStr(today, 1), '20:00', true, 'combined'));
    });

    /* 完整年月日：2026-03-05 / 2026/3/5 / 2026年3月5日 */
    eachMatch(work, /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g, function (m, s, e) {
      if (s > 0 && isArabicDigit(work.charAt(s - 1))) { return; }
      if (e < work.length && isArabicDigit(work.charAt(e))) { return; }
      var y = parseInt(m[1], 10);
      var mo = parseInt(m[2], 10);
      var d = parseInt(m[3], 10);
      var ok = isValidDateParts(y, mo, d);
      addDateMatch(list, dateMatch(s, e, m[0], ok ? formatYmd(y, mo, d) : null, null, ok, 'iso'));
    });
    eachMatch(work, /(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g, function (m, s, e) {
      if (s > 0 && isArabicDigit(work.charAt(s - 1))) { return; }
      var y = parseInt(m[1], 10);
      var mo = parseInt(m[2], 10);
      var d = parseInt(m[3], 10);
      var ok = isValidDateParts(y, mo, d);
      addDateMatch(list, dateMatch(s, e, m[0], ok ? formatYmd(y, mo, d) : null, null, ok, 'iso'));
    });

    /* 上周五 / 下周三 / 本周一 / 上周 / 下周 */
    eachMatch(work, /上(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g, function (m, s, e) {
      var target = weekdayIndexFromChar(m[1]);
      if (target < 0) { return; }
      addDateMatch(list, dateMatch(s, e, m[0], weekdayDate(today, target, 'lastweek'), null, true, 'weekday'));
    });
    eachMatch(work, /下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g, function (m, s, e) {
      var target = weekdayIndexFromChar(m[1]);
      if (target < 0) { return; }
      addDateMatch(list, dateMatch(s, e, m[0], weekdayDate(today, target, 'nextweek'), null, true, 'weekday'));
    });
    eachMatch(work, /本(?:周|星期|礼拜)([一二三四五六日天])|这(?:周|星期|礼拜)([一二三四五六日天])/g, function (m, s, e) {
      var ch = m[1] || m[2];
      var target = weekdayIndexFromChar(ch);
      if (target < 0) { return; }
      addDateMatch(list, dateMatch(s, e, m[0], weekdayDate(today, target, 'thisweek'), null, true, 'weekday'));
    });
    eachMatch(work, /(?:周|星期|礼拜)([一二三四五六日天])/g, function (m, s, e) {
      var target = weekdayIndexFromChar(m[1]);
      if (target < 0) { return; }
      addDateMatch(list, dateMatch(s, e, m[0], weekdayDate(today, target, 'last'), null, true, 'weekday'));
    });
    eachMatch(work, /上(?:个)?(?:周|星期|礼拜)/g, function (m, s, e) {
      if (overlapsAny(list, s, e)) { return; }
      var monday = weekdayDate(today, 1, 'lastweek');
      addDateMatch(list, dateMatch(s, e, m[0], monday, null, true, 'weekday'));
    });
    eachMatch(work, /下(?:个)?(?:周|星期|礼拜)/g, function (m, s, e) {
      if (overlapsAny(list, s, e)) { return; }
      var monday = weekdayDate(today, 1, 'nextweek');
      addDateMatch(list, dateMatch(s, e, m[0], monday, null, true, 'weekday'));
    });
    eachMatch(work, /本(?:周|星期|礼拜)|这(?:周|星期|礼拜)/g, function (m, s, e) {
      if (overlapsAny(list, s, e)) { return; }
      var monday = weekdayDate(today, 1, 'thisweek');
      addDateMatch(list, dateMatch(s, e, m[0], monday, null, true, 'weekday'));
    });

    /* 相对日期（长词优先用同一正则的靠前分支） */
    eachMatch(work, /大前天|前天|昨天|昨日|今天|今日|刚才|明天|明日|后天/g, function (m, s, e) {
      var offsets = {
        '大前天': -3, '前天': -2, '昨天': -1, '昨日': -1,
        '今天': 0, '今日': 0, '刚才': 0, '明天': 1, '明日': 1, '后天': 2
      };
      addDateMatch(list, dateMatch(s, e, m[0], addDaysStr(today, offsets[m[0]]), null, true, 'relative'));
    });

    /* 本月 / 上个月 / 上上个月 / 下个月（长词放前面，避免「上上个月」被「上个月」截走） */
    eachMatch(work, /本月|这个月|上上个月|上上月|上个月|上月|下个月|下月/g, function (m, s, e) {
      var d = today;
      var word = m[0];
      if (word === '上上个月' || word === '上上月') { d = addMonthsStr(today, -2); }
      else if (word === '上个月' || word === '上月') { d = addMonthsStr(today, -1); }
      else if (word === '下个月' || word === '下月') { d = addMonthsStr(today, 1); }
      addDateMatch(list, dateMatch(s, e, m[0], d, null, true, 'month'));
    });

    /* 3月5日 / 5号（当前年 / 当前月；非法日期不采纳但消耗区间） */
    eachMatch(work, /(\d{1,2})月(\d{1,2})[日号]/g, function (m, s, e) {
      if (s > 0 && isArabicDigit(work.charAt(s - 1))) { return; }
      var p = parseYmd(today);
      var mo = parseInt(m[1], 10);
      var d = parseInt(m[2], 10);
      var ok = isValidDateParts(p.y, mo, d);
      addDateMatch(list, dateMatch(s, e, m[0], ok ? formatYmd(p.y, mo, d) : null, null, ok, 'md'));
    });
    eachMatch(work, /(\d{1,2})[日号]/g, function (m, s, e) {
      if (s > 0 && (isArabicDigit(work.charAt(s - 1)) || work.charAt(s - 1) === '月')) { return; }
      var p = parseYmd(today);
      var d = parseInt(m[1], 10);
      var ok = isValidDateParts(p.y, p.m, d);
      addDateMatch(list, dateMatch(s, e, m[0], ok ? formatYmd(p.y, p.m, d) : null, null, ok, 'day'));
    });

    /* 3.5：只在「按日期解释」这一路候选里参与，避免抢走正常金额 */
    if (opts && opts.mdAsDate) {
      var hasExplicit = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].kind !== 'md') { hasExplicit = true; break; }
      }
      if (!hasExplicit) {
        eachMatch(work, /(\d{1,2})\.(\d{1,2})(?![\d.])/g, function (m, s, e) {
          if (s > 0 && (isArabicDigit(work.charAt(s - 1)) || work.charAt(s - 1) === '.' || work.charAt(s - 1) === ',')) { return; }
          var next = work.charAt(e);
          if (next === '元' || next === '块' || next === '圆' || next === '毛' || next === '角' || next === '分' || next === '¥') { return; }
          var p = parseYmd(today);
          var mo = parseInt(m[1], 10);
          var d = parseInt(m[2], 10);
          if (!isValidDateParts(p.y, mo, d)) { return; }
          addDateMatch(list, dateMatch(s, e, m[0], formatYmd(p.y, mo, d), null, true, 'md'));
        });
      }
    }

    list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return list;
  }

  function collectTimeMatches(work, dateMatches) {
    var list = [];

    function add(start, end, raw, time, valid) {
      if (overlapsAny(dateMatches, start, end)) { return; }
      if (overlapsAny(list, start, end)) { return; }
      list.push({ start: start, end: end, raw: raw, time: time, valid: valid !== false });
    }

    eachMatch(work, /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*:\s*(\d{1,2})/g, function (m, s, e) {
      var h = parseInt(m[2], 10);
      var mi = parseInt(m[3], 10);
      var prefix = m[1] || '';
      if (prefix === '下午' || prefix === '傍晚' || prefix === '晚上') { if (h < 12) { h += 12; } }
      if (prefix === '中午' && h < 11) { h += 12; }
      if (prefix === '凌晨' && h === 12) { h = 0; }
      var ok = h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
      add(s, e, m[0], ok ? pad2(h) + ':' + pad2(mi) : null, ok);
    });

    eachMatch(work, /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/g, function (m, s, e) {
      var h = parseInt(m[2], 10);
      var prefix = m[1] || '';
      var mi = 0;
      if (m[3] === '半') { mi = 30; }
      else if (m[4]) { mi = parseInt(m[4], 10); }
      if (prefix === '下午' || prefix === '傍晚' || prefix === '晚上') { if (h < 12) { h += 12; } }
      if (prefix === '中午' && h < 11) { h += 12; }
      if (prefix === '凌晨' && h === 12) { h = 0; }
      var ok = h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
      add(s, e, m[0], ok ? pad2(h) + ':' + pad2(mi) : null, ok);
    });

    eachMatch(work, /凌晨|早上|上午|中午|下午|傍晚|晚上/g, function (m, s, e) {
      var def = {
        '凌晨': '01:00', '早上': '08:00', '上午': '08:00', '中午': '12:00',
        '下午': '15:00', '傍晚': '18:00', '晚上': '20:00'
      };
      add(s, e, m[0], def[m[0]], true);
    });

    list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return list;
  }

  function planDate(work, ctx, opts) {
    var warnings = [];
    var matches = collectDateMatches(work, ctx, opts || {});
    var times = collectTimeMatches(work, matches);
    var spans = [];
    var validDates = [];
    var invalidDates = [];
    var i;

    for (i = 0; i < matches.length; i++) {
      spans.push({ start: matches[i].start, end: matches[i].end });
      if (matches[i].valid && matches[i].date) { validDates.push(matches[i]); }
      else { invalidDates.push(matches[i]); }
    }
    for (i = 0; i < times.length; i++) {
      spans.push({ start: times[i].start, end: times[i].end });
    }

    var chosen = validDates.length ? validDates[validDates.length - 1] : null;
    var date = chosen ? chosen.date : ctx.today;
    var dateRaw = chosen ? chosen.raw : '';
    var explicitDate = !!chosen;

    if (validDates.length > 1) {
      pushWarning(warnings, '识别到多个日期，已用最后一个');
    }
    if (invalidDates.length) {
      pushWarning(warnings, '日期不合法，已用今天');
    }

    var explicitTime = null;
    var invalidTime = false;
    for (i = 0; i < times.length; i++) {
      if (times[i].valid && times[i].time) { explicitTime = times[i]; }
      else if (!times[i].valid) { invalidTime = true; }
    }
    if (invalidTime && !explicitTime) {
      pushWarning(warnings, '时间不合法，已忽略');
    }
    var time = null;
    var timeRaw = '';
    if (explicitTime) {
      time = explicitTime.time;
      timeRaw = explicitTime.raw;
    } else if (chosen && chosen.time) {
      time = chosen.time;
      timeRaw = chosen.raw;
    }
    if (!time) {
      time = date === ctx.today ? nowTimeOf(ctx) : '12:00';
    }

    var futureAllowed = /(明天|明日|后天|下周|下个(?:周|星期|礼拜)|下个月|下月)/.test(work);
    if (date > ctx.today && !futureAllowed) {
      pushWarning(warnings, '日期在今天之后');
    }

    return {
      date: date,
      time: time,
      dateRaw: dateRaw,
      timeRaw: timeRaw,
      explicitDate: explicitDate,
      explicitTime: !!explicitTime,
      chosen: chosen,
      matches: matches,
      spans: spans,
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. 类型判定：显式前缀 > 分类类型 > 默认类型
   * ------------------------------------------------------------------ */

  /* 「工资卡」「现金账户」这类账户复合词里的类型/分类词不应抢账户 */
  function isAccountSuffixAt(work, end) {
    var ch = work.charAt(end);
    if (ch === '卡') { return true; }
    var two = work.substr(end, 2);
    return two === '账户' || two === '帐户';
  }

  function notAccountKeyword(work, pos, word) {
    return !isAccountSuffixAt(work, pos + word.length);
  }

  function findFirstKeyword(work, words, filter) {
    var best = null;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var from = 0;
      var pos;
      while ((pos = work.indexOf(w, from)) >= 0) {
        if (!filter || filter(work, pos, w)) {
          if (!best || pos < best.start || (pos === best.start && w.length > best.word.length)) {
            best = { start: pos, end: pos + w.length, word: w };
          }
          break;
        }
        from = pos + 1;
      }
    }
    return best;
  }

  function isWeakHai(work, pos) {
    var next = work.charAt(pos + 1);
    if (next === '有' || next === '是' || next === '要' || next === '会' ||
        next === '能' || next === '想' || next === '得' || next === '好' ||
        next === '在' || next === '没' || next === '不') {
      return false;
    }
    return next === '' || next === ' ' || isArabicDigit(next) || next === '给' || next === '了';
  }

  function detectType(work, ctx, opts) {
    var options = opts || {};
    if (options.forceType) {
      return { type: options.forceType, explicit: true, start: -1, consumeSpans: [] };
    }
    if (!options.disableTransfer) {
      /* 还款 + 信用卡/花呗：强转账（UI 6.4「还信用卡2000」） */
      var rep = /还\s*(信用卡|贷记卡|花呗|借呗)/.exec(work);
      if (rep) {
        return {
          type: 'transfer', explicit: true, strong: true, repayment: true,
          start: rep.index, end: rep.index + rep[0].length,
          consumeSpans: [{ start: rep.index, end: rep.index + 1 }],
          keyword: rep[0]
        };
      }
      var strong = findFirstKeyword(work, TRANSFER_STRONG);
      if (strong) {
        return {
          type: 'transfer', explicit: true, strong: true,
          repayment: strong.word === '还款',
          start: strong.start, end: strong.end,
          consumeSpans: [{ start: strong.start, end: strong.end }],
          keyword: strong.word
        };
      }
      /* 结构式转账（没有「转给/转到」也没有「转账」的情况）：
       * 「从微信转500到支付宝」「转500到支付宝」「微信转500到支付宝」。
       * 只认同时出现「到」的移动语义，避免把「转正」「转身」之类误判。 */
      var structFrom = /从[^，。；、\s]{0,8}转/.exec(work);
      var structMid = /转(账)?\s*[0-9零一二三四五六七八九十百千万两]{1,10}\s*[块元圆]?\s*到/.exec(work);
      var structMove = structFrom || structMid;
      if (structMove) {
        var structSpans = [];
        if (structFrom) { structSpans.push({ start: structFrom.index, end: structFrom.index + 1 }); }
        return {
          type: 'transfer', explicit: true, strong: true, repayment: false,
          start: structMove.index, end: structMove.index + structMove[0].length,
          consumeSpans: structSpans, keyword: structMove[0]
        };
      }
      var weak = findFirstKeyword(work, ['还给', '还了']);
      if (!weak) {
        var w = findFirstKeyword(work, ['还'], isWeakHai);
        if (w) { weak = w; }
      }
      if (weak) {
        return {
          type: 'transfer', explicit: false, strong: false, repayment: false,
          start: weak.start, end: weak.end,
          consumeSpans: [{ start: weak.start, end: weak.end }],
          keyword: weak.word
        };
      }
    }

    var inc = findFirstKeyword(work, INCOME_WORDS, notAccountKeyword);
    var exp = findFirstKeyword(work, EXPENSE_WORDS, notAccountKeyword);
    /* 预处理的「花了」被删掉了，但它是明确的支出信号，位置视为最前 */
    if (options.leadingExpense) {
      exp = { start: -1, end: 0, word: '花了' };
    }
    if (inc && exp) {
      if (inc.start <= exp.start) {
        return { type: 'income', explicit: true, start: inc.start, end: inc.end, keyword: inc.word, consumeSpans: [], conflict: true };
      }
      return { type: 'expense', explicit: true, start: exp.start, end: exp.end, keyword: exp.word, consumeSpans: [], conflict: true };
    }
    if (inc) {
      return { type: 'income', explicit: true, start: inc.start, end: inc.end, keyword: inc.word, consumeSpans: [] };
    }
    if (exp) {
      return { type: 'expense', explicit: true, start: exp.start, end: exp.end, keyword: exp.word, consumeSpans: [] };
    }
    return { type: null, explicit: false, start: -1, consumeSpans: [] };
  }

  /* ------------------------------------------------------------------ *
   * 7. 分类：内置别名 + 自定义 name/aliases；最长匹配、跨收支取更早
   * ------------------------------------------------------------------ */

  function buildCategoryDict(ctx) {
    var dict = [];
    var seen = Object.create(null);
    var blacklist = { '买': true };

    function add(keyword, cat) {
      if (!isStr(keyword)) { return; }
      var k = keyword.replace(/^\s+|\s+$/g, '');
      if (!k) { return; }
      var key = k + '|' + cat.id;
      if (seen[key]) { return; }
      seen[key] = true;
      dict.push({
        keyword: k,
        cat: cat,
        kind: cat.kind,
        sort: typeof cat.sort === 'number' ? cat.sort : 999,
        name: cat.name || ''
      });
    }

    for (var i = 0; i < ctx.categories.length; i++) {
      var cat = ctx.categories[i];
      if (!isObj(cat) || !isStr(cat.id)) { continue; }
      if (cat.kind !== 'expense' && cat.kind !== 'income') { continue; }
      var aliases = isArr(cat.aliases) ? cat.aliases : [];
      for (var j = 0; j < aliases.length; j++) {
        if (cat.system && blacklist[aliases[j]]) { continue; }
        add(aliases[j], cat);
      }
      if (cat.system && hasOwn(CATEGORY_ALIASES, cat.id)) {
        var builtin = CATEGORY_ALIASES[cat.id];
        for (var k = 0; k < builtin.length; k++) { add(builtin[k], cat); }
      }
      add(cat.name, cat);
    }
    return dict;
  }

  function findCategoryMatches(work, blocked, dict) {
    var list = [];
    for (var i = 0; i < dict.length; i++) {
      var entry = dict[i];
      var from = 0;
      var pos;
      while ((pos = work.indexOf(entry.keyword, from)) >= 0) {
        var end = pos + entry.keyword.length;
        if (!isBlocked(blocked, pos, end) && !isAccountSuffixAt(work, end)) {
          list.push({
            start: pos, end: end, keyword: entry.keyword,
            cat: entry.cat, kind: entry.kind, sort: entry.sort, name: entry.name
          });
        }
        from = pos + 1;
      }
    }
    list.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    return list;
  }

  function categoryCompare(a, b, defaultKind) {
    var la = a.end - a.start;
    var lb = b.end - b.start;
    if (la !== lb) { return lb - la; }
    if (a.kind !== b.kind && defaultKind) {
      if (a.kind === defaultKind) { return -1; }
      if (b.kind === defaultKind) { return 1; }
    }
    if (a.sort !== b.sort) { return a.sort - b.sort; }
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  }

  function otherCategory(ctx, kind) {
    var wantId = kind === 'income' ? 'ca_other_income' : 'ca_other_expense';
    var fallback = null;
    var firstKind = null;
    for (var i = 0; i < ctx.categories.length; i++) {
      var c = ctx.categories[i];
      if (!isObj(c) || c.kind !== kind) { continue; }
      if (!firstKind) { firstKind = c; }
      if (c.id === wantId) { return c; }
      if (!fallback && (c.name === '其他' || c.name === '其他收入' || c.name === '其他支出')) { fallback = c; }
    }
    return fallback || firstKind;
  }

  function planCategory(work, ctx, typeInfo, blocked) {
    var warnings = [];
    var result = {
      chosen: null, categoryId: null, categoryName: '', fallback: false,
      alternates: [], matches: [], warnings: warnings
    };
    if (typeInfo && typeInfo.type === 'transfer') { return result; }

    var dict = buildCategoryDict(ctx);
    var rawMatches = findCategoryMatches(work, blocked, dict);

    /* 账户复合词优先：如「工资卡」里的「工资」、「交通银行」里的「交通」，
     * 分类词被更长的账户词完整包含时不参与分类选择，否则账户会被整段屏蔽。
     * 注意单说「交通」时账户词并不更长，仍然按契约「分类优先」。 */
    var acctGroups = findAccountGroups(work, blocked, ctx);
    var matches = [];
    var mi;
    for (mi = 0; mi < rawMatches.length; mi++) {
      var rm = rawMatches[mi];
      var covered = false;
      for (var gi = 0; gi < acctGroups.length; gi++) {
        var g = acctGroups[gi];
        if (g.start <= rm.start && g.end >= rm.end &&
            (g.end - g.start) > (rm.end - rm.start)) {
          covered = true;
          break;
        }
      }
      if (!covered) { matches.push(rm); }
    }
    result.matches = matches;

    var explicit = typeInfo && (typeInfo.type === 'income' || typeInfo.type === 'expense')
      ? typeInfo.type : null;
    var pool = [];
    var i;
    for (i = 0; i < matches.length; i++) {
      if (!explicit || matches[i].kind === explicit) { pool.push(matches[i]); }
    }

    var chosen = null;
    if (pool.length) {
      if (!explicit) {
        var kinds = Object.create(null);
        for (i = 0; i < pool.length; i++) { kinds[pool[i].kind] = true; }
        var kindCount = 0;
        for (var kk in kinds) { if (hasOwn(kinds, kk)) { kindCount += 1; } }
        if (kindCount > 1) {
          /* 同时命中收支：取文本中更早出现的类别；同位置再比长度/默认类型 */
          pool.sort(function (a, b) {
            if (a.start !== b.start) { return a.start - b.start; }
            return categoryCompare(a, b, ctx.defaults.type);
          });
        } else {
          pool.sort(function (a, b) { return categoryCompare(a, b, null); });
        }
      } else {
        pool.sort(function (a, b) { return categoryCompare(a, b, null); });
      }
      chosen = pool[0];
    }

    if (chosen) {
      result.chosen = chosen.cat;
      result.categoryId = chosen.cat.id;
      result.categoryName = chosen.cat.name || '';
    } else {
      var kind = explicit || ctx.defaults.type || 'expense';
      var other = otherCategory(ctx, kind);
      if (other) {
        result.chosen = other;
        result.categoryId = other.id;
        result.categoryName = other.name || '';
      } else if (ctx.defaults.categoryId) {
        result.categoryId = ctx.defaults.categoryId;
        result.categoryName = '';
      }
      result.fallback = true;
      pushWarning(warnings, '未识别分类，已归入「其他」');
    }

    /* 其它命中项做候选；优先不同分类 id，最多 2 个 */
    var seen = Object.create(null);
    if (result.categoryId) { seen[result.categoryId] = true; }
    var alts = [];
    var altPool = explicit ? pool : matches;
    altPool.sort(function (a, b) { return categoryCompare(a, b, ctx.defaults.type); });
    for (i = 0; i < altPool.length; i++) {
      var m = altPool[i];
      if (seen[m.cat.id]) { continue; }
      seen[m.cat.id] = true;
      alts.push(m);
      if (alts.length >= 2) { break; }
    }
    result.alternates = alts;

    for (i = 0; i < matches.length; i++) {
      markMask(blocked, matches[i].start, matches[i].end);
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * 8. 账户：类型词 / 银行简称 / 自定义名称与别名；分类优先于账户
   * ------------------------------------------------------------------ */

  function activeAccounts(ctx) {
    var all = [];
    var active = [];
    for (var i = 0; i < ctx.accounts.length; i++) {
      var a = ctx.accounts[i];
      if (!isObj(a) || !isStr(a.id)) { continue; }
      all.push(a);
      if (a.archived !== true || ctx.allowArchived) { active.push(a); }
    }
    return active.length ? active : all;
  }

  function sortAccounts(list) {
    list.sort(function (a, b) {
      var sa = typeof a.sort === 'number' ? a.sort : 999;
      var sb = typeof b.sort === 'number' ? b.sort : 999;
      if (sa !== sb) { return sa - sb; }
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    });
    return list;
  }

  function buildAccountEntries(ctx) {
    var accounts = sortAccounts(activeAccounts(ctx));
    var entries = [];
    var i;
    for (i = 0; i < ACCOUNT_TYPE_WORDS.length; i++) {
      var def = ACCOUNT_TYPE_WORDS[i];
      var list = [];
      for (var j = 0; j < accounts.length; j++) {
        if (def.types.indexOf(accounts[j].type) >= 0) { list.push(accounts[j]); }
      }
      if (list.length) {
        entries.push({ word: def.word, accounts: list, builtin: true });
      }
    }
    for (i = 0; i < BANK_WORDS.length; i++) {
      var bw = BANK_WORDS[i];
      var blist = [];
      for (var b = 0; b < accounts.length; b++) {
        if (String(accounts[b].name || '').indexOf(bw) >= 0) { blist.push(accounts[b]); }
      }
      if (blist.length) {
        entries.push({ word: bw, accounts: blist, builtin: true, bank: true });
      }
    }
    for (i = 0; i < accounts.length; i++) {
      var acc = accounts[i];
      entries.push({ word: String(acc.name || ''), accounts: [acc], builtin: false });
      if (isArr(acc.aliases)) {
        for (var a = 0; a < acc.aliases.length; a++) {
          if (isStr(acc.aliases[a]) && acc.aliases[a]) {
            entries.push({ word: acc.aliases[a], accounts: [acc], builtin: false });
          }
        }
      }
    }
    return entries;
  }

  function findAccountGroups(work, blocked, ctx) {
    var entries = buildAccountEntries(ctx);
    var raw = [];
    var i;
    for (i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry.word) { continue; }
      var from = 0;
      var pos;
      while ((pos = work.indexOf(entry.word, from)) >= 0) {
        var end = pos + entry.word.length;
        if (!isBlocked(blocked, pos, end)) {
          raw.push({
            start: pos, end: end, word: entry.word, builtin: entry.builtin,
            accounts: entry.accounts.slice()
          });
        }
        from = pos + 1;
      }
    }

    /* 同一区间合并：自定义名称优先于内置类型词，避免两个词各选一个账户 */
    var groups = [];
    var map = Object.create(null);
    for (i = 0; i < raw.length; i++) {
      var r = raw[i];
      var key = r.start + ':' + r.end;
      if (!map[key]) {
        map[key] = {
          start: r.start, end: r.end, word: r.word, builtin: r.builtin,
          accounts: []
        };
        groups.push(map[key]);
      }
      var g = map[key];
      if (!r.builtin) { g.builtin = false; }
      if (r.word.length > g.word.length) { g.word = r.word; }
      for (var j = 0; j < r.accounts.length; j++) {
        var acc = r.accounts[j];
        var exists = false;
        for (var k = 0; k < g.accounts.length; k++) {
          if (g.accounts[k].id === acc.id) { exists = true; break; }
        }
        if (!exists) { g.accounts.push(acc); }
      }
    }

    /* 自定义账户排前面 */
    for (i = 0; i < groups.length; i++) {
      groups[i].accounts.sort(function (a, b) {
        var aa = a._nlCustom ? 0 : 1;
        var bb = b._nlCustom ? 0 : 1;
        return aa - bb;
      });
      sortAccounts(groups[i].accounts);
    }
    groups.sort(function (a, b) {
      var la = a.end - a.start;
      var lb = b.end - b.start;
      if (la !== lb) { return lb - la; }
      return a.start - b.start;
    });
    return groups;
  }

  function accountById(ctx, id) {
    if (!isStr(id)) { return null; }
    for (var i = 0; i < ctx.accounts.length; i++) {
      if (isObj(ctx.accounts[i]) && ctx.accounts[i].id === id) { return ctx.accounts[i]; }
    }
    return null;
  }

  function defaultAccount(ctx, excludeId) {
    var accounts = sortAccounts(activeAccounts(ctx));
    if (ctx.defaults.accountId && ctx.defaults.accountId !== excludeId) {
      var found = accountById(ctx, ctx.defaults.accountId);
      if (found) { return found; }
      return { id: ctx.defaults.accountId, name: ctx.defaults.accountId };
    }
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id !== excludeId) { return accounts[i]; }
    }
    return null;
  }

  function planAccount(work, ctx, typeInfo, categoryPlan, blocked) {
    var warnings = [];
    var groups = findAccountGroups(work, blocked, ctx);
    var result = {
      accountId: null, toAccountId: null, accountName: '', toAccountName: '',
      matched: false, alternatives: [], warnings: warnings, groups: groups
    };
    var i;

    for (i = 0; i < groups.length; i++) {
      markMask(blocked, groups[i].start, groups[i].end);
    }

    if (typeInfo && typeInfo.type === 'transfer') {
      var chosenTo = null;
      var chosenFrom = null;
      if (typeInfo.repayment) {
        for (i = 0; i < groups.length; i++) {
          if (groups[i].accounts.length) { chosenTo = groups[i].accounts[0]; break; }
        }
      } else {
        var prep = -1;
        var prepWord = '';
        var prepMatch = /转给|转到/.exec(work);
        if (prepMatch) { prep = prepMatch.index; prepWord = prepMatch[0]; }
        var fromMark = /从/.exec(work);
        var verb = -1;
        if (typeInfo.start >= 0) { verb = typeInfo.start; }
        /* findAccountGroups 会按「匹配到的词更长优先」排序（`src/js/core/nl.js:1513-1518`），
         * 所以 groups 的顺序不是文本顺序。这里复制一份按 start 排好的，用于方向判定。 */
        var byPos = groups.slice(0).sort(function (a, b) { return a.start - b.start; });
        var before = [];
        var after = [];
        for (i = 0; i < groups.length; i++) {
          if (prep >= 0 && groups[i].start >= prep + prepWord.length) { after.push(groups[i]); }
          else if (prep >= 0) { before.push(groups[i]); }
          else { after.push(groups[i]); }
        }
        if (fromMark) {
          /* 「从微信转 500 到支付宝」：从 + 最近的那个账户是转出，另一个是转入。 */
          var fromGroup = null;
          var tailGroup = null;
          for (i = 0; i < byPos.length; i++) {
            if (byPos[i].end > fromMark.index + 1) { fromGroup = byPos[i]; break; }
          }
          for (i = byPos.length - 1; i >= 0; i--) {
            if (byPos[i] !== fromGroup) { tailGroup = byPos[i]; break; }
          }
          if (fromGroup) { chosenFrom = fromGroup.accounts[0]; }
          if (tailGroup) { chosenTo = tailGroup.accounts[0]; }
        } else if (prep >= 0) {
          if (before.length) { chosenFrom = before[0].accounts[0]; }
          if (after.length) { chosenTo = after[0].accounts[0]; }
        } else if (byPos.length >= 2) {
          chosenFrom = byPos[0].accounts[0];
          chosenTo = byPos[1].accounts[0];
        } else if (byPos.length === 1) {
          if (verb >= 0 && byPos[0].start < verb) { chosenFrom = byPos[0].accounts[0]; }
          else { chosenTo = byPos[0].accounts[0]; }
        }
      }

      if (!chosenFrom) { chosenFrom = defaultAccount(ctx, chosenTo ? chosenTo.id : null); }
      if (chosenFrom && chosenTo && chosenFrom.id === chosenTo.id) {
        var other = defaultAccount(ctx, chosenFrom.id);
        if (other && other.id !== chosenTo.id) {
          chosenFrom = other;
          pushWarning(warnings, '转出与转入不能相同，已更换转出账户');
        } else {
          pushWarning(warnings, '转出与转入不能是同一账户');
        }
      }
      if (!chosenTo) {
        pushWarning(warnings, '未识别转入账户，请选择');
      }
      result.accountId = chosenFrom ? chosenFrom.id : null;
      result.toAccountId = chosenTo ? chosenTo.id : null;
      result.accountName = chosenFrom ? chosenFrom.name : '';
      result.toAccountName = chosenTo ? chosenTo.name : '';
      result.matched = !!(chosenFrom && chosenTo);
      if (!groups.length) { pushWarning(warnings, '未识别账户，已用默认账户'); }
      if (chosenTo) {
        for (i = 1; i < groups.length; i++) {
          if (groups[i].accounts[0] && groups[i].accounts[0].id !== chosenTo.id) {
            result.alternatives.push(groups[i].accounts[0]);
          }
        }
      }
      return result;
    }

    if (!groups.length) {
      var def = defaultAccount(ctx, null);
      result.accountId = def ? def.id : null;
      result.accountName = def ? def.name : '';
      result.matched = false;
      pushWarning(warnings, '未识别账户，已用默认账户');
      return result;
    }

    var best = null;
    for (i = 0; i < groups.length; i++) {
      if (!best) { best = groups[i]; continue; }
      var la = best.end - best.start;
      var lb = groups[i].end - groups[i].start;
      if (lb > la || (lb === la && groups[i].start < best.start)) { best = groups[i]; }
    }
    result.accountId = best.accounts[0].id;
    result.accountName = best.accounts[0].name;
    result.matched = true;
    for (i = 1; i < best.accounts.length; i++) {
      result.alternatives.push(best.accounts[i]);
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * 9. 标签与备注
   * ------------------------------------------------------------------ */

  function extractTags(work, warnings) {
    var tags = [];
    var spans = [];
    var seen = Object.create(null);

    function addTag(raw, start, end) {
      var t = raw.replace(/^[#\-－]+/, '').replace(/[，,。.!！?？;；:：、]+$/, '');
      if (!t) { return; }
      var chars = Array.from(t);
      if (chars.length > 10) {
        t = chars.slice(0, 10).join('');
        pushWarning(warnings, '标签过长，已截断到 10 字');
      }
      if (seen[t]) { return; }
      seen[t] = true;
      if (tags.length >= 5) {
        pushWarning(warnings, '标签最多 5 个，已忽略多余标签');
        return;
      }
      tags.push(t);
      spans.push({ start: start, end: end });
    }

    eachMatch(work, /#([^\s#]+)/g, function (m, s, e) {
      addTag(m[1], s, e);
    });
    eachMatch(work, /(^|\s)-([^\s#\-]{1,12})/g, function (m, s, e) {
      var label = m[2];
      if (/^\d/.test(label)) { return; }
      addTag(label, s + m[1].length, e);
    });

    return { tags: tags, spans: spans };
  }

  function trimEdgePunct(s) {
    return s.replace(/^[\s,，。.!！?？;；:：、~～\-—]+/, '')
      .replace(/[\s,，。.!！?？;；:：、~～\-—]+$/, '');
  }

  function stripFillers(s) {
    var changed = true;
    var guard = 0;
    while (changed && guard < 4) {
      changed = false;
      guard += 1;
      for (var i = 0; i < LEADING_FILLERS.length; i++) {
        var f = LEADING_FILLERS[i];
        if (s.indexOf(f) === 0) {
          s = s.slice(f.length).replace(/^[\s,，。.!！?？]+/, '');
          changed = true;
          break;
        }
      }
    }
    changed = true;
    guard = 0;
    while (changed && guard < 4) {
      changed = false;
      guard += 1;
      for (var j = 0; j < TRAILING_FILLERS.length; j++) {
        var t = TRAILING_FILLERS[j];
        if (s.length >= t.length && s.slice(s.length - t.length) === t) {
          s = s.slice(0, s.length - t.length).replace(/[\s,，。.!！?？]+$/, '');
          changed = true;
          break;
        }
      }
    }
    var pieces = s.split(' ');
    var kept = [];
    for (var k = 0; k < pieces.length; k++) {
      if (pieces[k] && CONNECTIVE_TOKENS.indexOf(pieces[k]) < 0) { kept.push(pieces[k]); }
    }
    return kept.join(' ').replace(/\s+/g, ' ');
  }

  function typeFallbackName(type) {
    if (type === 'income') { return '收入'; }
    if (type === 'transfer') { return '转账'; }
    return '支出';
  }

  function buildNote(work, noteMask, type, category, repayment, warnings) {
    var chars = work.split('');
    for (var i = 0; i < chars.length; i++) {
      if (noteMask[i]) { chars[i] = ' '; }
    }
    var s = chars.join('').replace(/\s+/g, ' ');
    s = trimEdgePunct(s);
    s = stripFillers(s);
    s = trimEdgePunct(s).replace(/\s+/g, ' ');

    var fallback = false;
    if (!s) {
      fallback = true;
      if (type === 'transfer') {
        s = repayment ? '还款' : '转账';
      } else if (category && category.name) {
        s = category.name;
      } else {
        s = typeFallbackName(type);
      }
    }
    var noteChars = Array.from(s);
    if (noteChars.length > 80) {
      s = noteChars.slice(0, 80).join('');
      pushWarning(warnings, '备注过长，已截断到 80 字');
    }
    return { note: s, fallback: fallback };
  }

  /* ------------------------------------------------------------------ *
   * 10. 单候选分析（一个完整解释）
   * ------------------------------------------------------------------ */

  function analyze(work, ctx, opts) {
    var options = opts || {};
    var warnings = [];
    var blocked = new Array(work.length);
    var noteMask = new Array(work.length);
    var spans = [];

    var dp = planDate(work, ctx, options);
    for (var i = 0; i < dp.warnings.length; i++) { pushWarning(warnings, dp.warnings[i]); }
    for (i = 0; i < dp.spans.length; i++) {
      markMask(blocked, dp.spans[i].start, dp.spans[i].end);
      markMask(noteMask, dp.spans[i].start, dp.spans[i].end);
      spans.push(dp.spans[i]);
    }

    var amountTokens = collectAmounts(work, blocked);
    var amountPick;
    if (typeof options.forcedAmountStart === 'number') {
      /* 歧义候选：明确把「3.5」这类 token 当金额，而不是日期 */
      for (i = 0; i < amountTokens.length; i++) {
        var ft = amountTokens[i];
        if (ft.valid && ft.start === options.forcedAmountStart &&
            (typeof options.forcedAmountEnd !== 'number' || ft.end >= options.forcedAmountEnd)) {
          amountPick = { ok: true, token: ft };
          break;
        }
      }
      if (amountPick) {
        pushWarning(warnings, '「' + amountPick.token.raw + '」按金额处理，其余金额未采用');
      }
    }
    if (!amountPick) { amountPick = chooseAmountToken(amountTokens, warnings); }
    for (i = 0; i < amountTokens.length; i++) {
      markMask(blocked, amountTokens[i].start, amountTokens[i].end);
      markMask(noteMask, amountTokens[i].start, amountTokens[i].end);
    }

    var typeInfo = detectType(work, ctx, options);
    if (typeInfo.conflict) {
      pushWarning(warnings, '同时出现收入与支出词，已按更早出现的判定');
    }
    var consumeSpans = typeInfo.consumeSpans || [];
    for (i = 0; i < consumeSpans.length; i++) {
      markMask(blocked, consumeSpans[i].start, consumeSpans[i].end);
      markMask(noteMask, consumeSpans[i].start, consumeSpans[i].end);
    }

    var catPlan = planCategory(work, ctx, typeInfo, blocked);
    for (i = 0; i < catPlan.warnings.length; i++) { pushWarning(warnings, catPlan.warnings[i]); }

    var acctPlan = planAccount(work, ctx, typeInfo, catPlan, blocked);
    for (i = 0; i < acctPlan.warnings.length; i++) { pushWarning(warnings, acctPlan.warnings[i]); }
    for (i = 0; i < acctPlan.groups.length; i++) {
      markMask(noteMask, acctPlan.groups[i].start, acctPlan.groups[i].end);
    }

    var tagPlan = extractTags(work, warnings);
    for (i = 0; i < tagPlan.spans.length; i++) {
      markMask(noteMask, tagPlan.spans[i].start, tagPlan.spans[i].end);
      markMask(blocked, tagPlan.spans[i].start, tagPlan.spans[i].end);
    }

    var type = typeInfo.type;
    if (!type) {
      type = catPlan.chosen ? catPlan.chosen.kind : (ctx.defaults.type || 'expense');
    }
    if (type === 'transfer') {
      catPlan.categoryId = null;
      catPlan.categoryName = '';
    }

    var noteInfo = buildNote(work, noteMask, type, catPlan.chosen, !!typeInfo.repayment, warnings);

    var cents = amountPick.ok ? amountPick.token.cents : null;
    var amountRaw = amountPick.token ? amountPick.token.raw : '';

    var explicitCat = !!catPlan.chosen && !catPlan.fallback;
    var explicitAcct = acctPlan.matched;
    var score = 0.55;
    if (cents !== null) { score += 0.12; }
    if (explicitCat) { score += 0.1; } else if (type !== 'transfer') { score -= 0.04; }
    if (explicitAcct) { score += 0.08; } else if (acctPlan.accountId) { score -= 0.03; }
    if (dp.explicitDate) { score += 0.04; }
    if (typeInfo.explicit) { score += 0.05; }
    if (type === 'transfer' && acctPlan.toAccountId) { score += 0.03; }
    if (typeInfo.repayment) { score += 0.03; }
    score = clamp(score, 0.3, 0.97);

    var reason = '';
    if (type === 'transfer') {
      reason = '转账' + (typeInfo.repayment ? '（还款）' : '') + '：' +
        (acctPlan.accountName || '默认账户') + ' → ' +
        (acctPlan.toAccountName || '待选择转入账户') + ' · ' + dp.date;
    } else {
      reason = (type === 'income' ? '收入' : '支出') + '：' +
        (catPlan.categoryName || '未分类') + ' · ' +
        (acctPlan.accountName || '默认账户') + ' · ' + dp.date;
    }
    if (options.mdAsDate && dp.chosen && dp.chosen.kind === 'md') {
      reason = '「' + dp.chosen.raw + '」按日期 ' + dp.date + ' 解析；' + reason;
    }

    var ok = amountPick.ok;
    var code = null;
    if (!ok) { code = amountPick.code; }

    if (ok && type !== 'transfer' && !catPlan.categoryId) { code = E_PARSE; }
    if (ok && type !== 'transfer' && !acctPlan.accountId) { code = E_PARSE; }
    if (ok && type === 'transfer' && !acctPlan.accountId) { code = E_PARSE; }

    return {
      ok: !code,
      code: code,
      type: type,
      cents: cents,
      amountRaw: amountRaw,
      date: dp.date,
      time: dp.time,
      accountId: acctPlan.accountId,
      toAccountId: type === 'transfer' ? acctPlan.toAccountId : null,
      accountName: acctPlan.accountName,
      toAccountName: acctPlan.toAccountName,
      categoryId: type === 'transfer' ? null : catPlan.categoryId,
      categoryName: type === 'transfer' ? '' : catPlan.categoryName,
      category: catPlan.chosen,
      note: noteInfo.note,
      noteFallback: noteInfo.fallback,
      tags: tagPlan.tags,
      confidence: round2(score),
      reason: reason,
      warnings: warnings,
      matches: {
        amount: amountRaw,
        date: dp.dateRaw,
        account: type === 'transfer'
          ? ((acctPlan.accountName || '') + (acctPlan.toAccountName ? ' → ' + acctPlan.toAccountName : ''))
          : acctPlan.accountName,
        category: catPlan.categoryName || '',
        note: noteInfo.note
      },
      meta: {
        mdAsDate: !!(options.mdAsDate && dp.chosen && dp.chosen.kind === 'md'),
        explicitType: typeInfo.explicit,
        repayment: !!typeInfo.repayment,
        transferWeak: typeInfo.type === 'transfer' && !typeInfo.strong,
        categoryAlternates: catPlan.alternates,
        accountAlternates: acctPlan.alternatives,
        dateRaw: dp.dateRaw,
        timeRaw: dp.timeRaw,
        work: work
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 11. 多候选（D14）：日期/金额歧义、转支歧义、分类歧义、账户歧义
   * ------------------------------------------------------------------ */

  function cloneCandidate(a, patch) {
    var c = {
      type: a.type,
      cents: a.cents,
      amountCents: a.cents,
      date: a.date,
      time: a.time,
      accountId: a.accountId,
      toAccountId: a.toAccountId,
      categoryId: a.categoryId,
      note: a.note,
      tags: a.tags.slice(),
      confidence: a.confidence,
      reason: a.reason,
      warnings: a.warnings.slice(),
      matches: {
        amount: a.matches.amount,
        date: a.matches.date,
        account: a.matches.account,
        category: a.matches.category,
        note: a.matches.note
      }
    };
    if (patch) {
      for (var k in patch) {
        if (hasOwn(patch, k)) { c[k] = patch[k]; }
      }
    }
    return c;
  }

  function candidateSignature(c) {
    return [c.type, c.cents, c.date, c.accountId, c.toAccountId, c.categoryId, c.note].join('|');
  }

  function findMdTokens(work, ctx) {
    var list = [];
    var re = /(\d{1,2})\.(\d{1,2})(?![\d.])/g;
    var m;
    var todayParts = parseYmd(ctx.today);
    while ((m = re.exec(work)) !== null) {
      var s = m.index;
      if (s > 0 && (isArabicDigit(work.charAt(s - 1)) || work.charAt(s - 1) === '.' || work.charAt(s - 1) === ',')) { continue; }
      var next = work.charAt(re.lastIndex);
      if (next === '元' || next === '块' || next === '圆' || next === '毛' || next === '角' || next === '分' || next === '¥') { continue; }
      var mo = parseInt(m[1], 10);
      var d = parseInt(m[2], 10);
      if (!isValidDateParts(todayParts.y, mo, d)) { continue; }
      list.push({ start: s, end: re.lastIndex, raw: m[0], date: formatYmd(todayParts.y, mo, d) });
    }
    return list;
  }

  function decideMdAsDate(work, ctx, mdTokens) {
    if (!mdTokens.length) { return false; }
    var explicitDateRe = /(今天|今日|昨天|昨日|前天|大前天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|上周|下周|本月|上月|下月|\d{4}[-/年]\d|\d{1,2}月\d{1,2}[日号])/;
    if (explicitDateRe.test(work)) { return false; }

    var mdSpan = mdTokens[0];
    var atStart = mdSpan.start === 0;
    var mask = new Array(work.length);
    var dp = planDate(work, ctx, { mdAsDate: false });
    for (var i = 0; i < dp.spans.length; i++) {
      markMask(mask, dp.spans[i].start, dp.spans[i].end);
    }
    var others = collectAmounts(work, mask).filter(function (t) {
      return !(t.start === mdSpan.start && t.end >= mdSpan.end) && t.valid;
    });
    return atStart && others.length > 0;
  }

  function candidateList(base, alt, mdInfo) {
    var list = [];
    var order = 0;

    function add(a, confidence, reasonPrefix) {
      var c = cloneCandidate(a);
      c.confidence = round2(confidence);
      if (reasonPrefix) { c.reason = reasonPrefix + '；' + c.reason; }
      c.order = order;
      order += 1;
      list.push(c);
    }

    if (base && base.ok) { add(base, base.confidence, ''); }

    if (alt && alt.ok) {
      var same = false;
      if (base && base.ok) {
        same = (base.type === alt.type && base.cents === alt.cents &&
          base.date === alt.date && base.accountId === alt.accountId &&
          base.categoryId === alt.categoryId && base.note === alt.note);
      }
      if (!same) {
        var cap = alt.meta && alt.meta.mdAsDate ? 0.66 : 0.6;
        var prefix = alt.meta && alt.meta.mdAsDate
          ? '也可按日期 ' + alt.date + ' 解析'
          : '也可按金额 ' + (alt.cents / 100).toFixed(2) + ' 元解析';
        add(alt, Math.min(alt.confidence, cap), prefix);
      }
    }

    /* 分类歧义：红包可能是人情支出，也可能是红包收入 */
    var baseForAlts = (base && base.ok) ? base : null;
    if (baseForAlts && baseForAlts.meta && baseForAlts.meta.categoryAlternates) {
      var alts = baseForAlts.meta.categoryAlternates;
      for (var i = 0; i < alts.length && i < 2; i++) {
        var m = alts[i];
        var c = cloneCandidate(baseForAlts);
        c.categoryId = m.cat.id;
        c.categoryName = m.cat.name;
        var type = baseForAlts.type;
        if (!baseForAlts.meta.explicitType) { type = m.kind; }
        c.type = type;
        if (type === 'transfer') { continue; }
        if (c.cents === null) { continue; }
        if (baseForAlts.noteFallback && m.cat.name) { c.note = m.cat.name; }
        c.confidence = round2(Math.min(baseForAlts.confidence - 0.18, 0.58));
        c.reason = '「' + m.keyword + '」也可归入「' + (m.cat.name || '其他') + '」；' + c.reason;
        c.order = order; order += 1;
        list.push(c);
      }
    }

    /* 账户歧义：同一关键词命中多个账户（如两张信用卡） */
    if (baseForAlts && baseForAlts.meta && baseForAlts.meta.accountAlternates) {
      var accs = baseForAlts.meta.accountAlternates;
      for (var j = 0; j < accs.length && j < 2; j++) {
        var acc = accs[j];
        if (!acc || !acc.id) { continue; }
        var ca = cloneCandidate(baseForAlts);
        if (baseForAlts.type === 'transfer') {
          /* 转入备选不能和转出是同一个账户（schema 会拒），也不该丢掉名字。 */
          if (acc.id === baseForAlts.accountId) { continue; }
          ca.toAccountId = acc.id;
          ca.toAccountName = acc.name || acc.id;
          ca.reason = '转入账户也可能是「' + (acc.name || acc.id) + '」；' + ca.reason;
        } else {
          ca.accountId = acc.id;
          ca.reason = '账户也可能是「' + (acc.name || acc.id) + '」；' + ca.reason;
        }
        ca.confidence = round2(Math.max(0.2, baseForAlts.confidence - 0.08));
        ca.order = order; order += 1;
        list.push(ca);
      }
    }

    /* 弱「还给/还了/还」的支出备选需要真实 ctx，在 parse 里补算，避免这里拿到空上下文 */

    list.sort(function (a, b) {
      if (b.confidence !== a.confidence) { return b.confidence - a.confidence; }
      return a.order - b.order;
    });
    var seen = Object.create(null);
    var out = [];
    for (var k = 0; k < list.length; k++) {
      var sig = candidateSignature(list[k]);
      if (seen[sig]) { continue; }
      seen[sig] = true;
      delete list[k].order;
      out.push(list[k]);
      if (out.length >= 3) { break; }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 12. 对外 parse
   * ------------------------------------------------------------------ */

  function failure(code, pre, analysis, extraWarnings) {
    var warnings = [];
    var i;
    if (pre) { for (i = 0; i < pre.warnings.length; i++) { pushWarning(warnings, pre.warnings[i]); } }
    if (analysis) {
      for (i = 0; i < analysis.warnings.length; i++) { pushWarning(warnings, analysis.warnings[i]); }
    }
    if (isArr(extraWarnings)) {
      for (i = 0; i < extraWarnings.length; i++) { pushWarning(warnings, extraWarnings[i]); }
    }
    var partial = null;
    if (analysis) {
      partial = {
        type: analysis.type,
        cents: null,
        amountCents: null,
        date: analysis.date,
        time: analysis.time,
        accountId: analysis.accountId,
        toAccountId: analysis.toAccountId,
        categoryId: analysis.categoryId,
        note: analysis.note,
        tags: analysis.tags.slice(),
        confidence: analysis.confidence,
        reason: analysis.reason,
        amountRaw: analysis.amountRaw
      };
    }
    return {
      ok: false,
      code: code,
      message: NL_MESSAGE[code] || NL_MESSAGE[E_PARSE],
      candidates: [],
      best: null,
      partial: partial,
      matches: analysis ? analysis.matches : { amount: '', date: '', account: '', category: '', note: '' },
      confidence: analysis ? analysis.confidence : 0,
      warnings: warnings,
      input: pre ? pre.original : ''
    };
  }

  function parse(text, ctxInput) {
    var pre = preprocess(text);
    var ctx = normalizeCtx(ctxInput);
    if (!pre.work) {
      return failure(E_NO_AMOUNT, pre, null, []);
    }

    var mdTokens = findMdTokens(pre.work, ctx);
    var primaryMdAsDate = decideMdAsDate(pre.work, ctx, mdTokens);

    var base = analyze(pre.work, ctx, {
      mdAsDate: primaryMdAsDate,
      leadingExpense: pre.leadingExpense
    });
    var alt = null;
    if (mdTokens.length) {
      var altOpts = {
        mdAsDate: !primaryMdAsDate,
        leadingExpense: pre.leadingExpense
      };
      /* 主解释把 3.5 当日期时，备解释要真的把 3.5 当金额，
       * 否则多金额规则会再次选中后面的 28，两个候选就只剩日期不同。 */
      if (primaryMdAsDate) {
        altOpts.forcedAmountStart = mdTokens[0].start;
        altOpts.forcedAmountEnd = mdTokens[0].end;
      }
      alt = analyze(pre.work, ctx, altOpts);
    }

    /* 主解释没金额、备解释有金额时，以备解释为主（3.5 被误判为日期的情况） */
    if (!base.ok && alt && alt.ok) {
      var tmp = base;
      base = alt;
      alt = tmp;
      pushWarning(base.warnings, '已按另一种解释识别金额');
    }

    if (!base.ok) {
      return failure(base.code || E_NO_AMOUNT, pre, base, []);
    }

    var list = candidateList(base, alt, { mdTokens: mdTokens });

    /* 弱转账的支出备选需要真实 ctx，这里补算并追加 */
    if (base.meta && base.meta.transferWeak) {
      var expenseAlt = analyze(pre.work, ctx, {
        disableTransfer: true,
        forceType: 'expense',
        leadingExpense: pre.leadingExpense
      });
      if (expenseAlt && expenseAlt.ok && expenseAlt.cents !== null) {
        var duplicate = false;
        for (var i = 0; i < list.length; i++) {
          if (list[i].type === expenseAlt.type && list[i].cents === expenseAlt.cents &&
              list[i].date === expenseAlt.date && list[i].categoryId === expenseAlt.categoryId) {
            duplicate = true;
            break;
          }
        }
        if (!duplicate) {
          list.push(cloneCandidate(expenseAlt, {
            confidence: round2(Math.min(expenseAlt.confidence, 0.5)),
            reason: '「还给/还」也可能是普通支出；' + expenseAlt.reason
          }));
        }
      }
    }

    list.sort(function (a, b) {
      if (b.confidence !== a.confidence) { return b.confidence - a.confidence; }
      return 0;
    });
    list = list.slice(0, 3);
    if (!list.length) {
      return failure(base.code || E_PARSE, pre, base, []);
    }

    var best = list[0];
    var warnings = best.warnings.slice();
    if (list.length > 1) {
      pushWarning(warnings, '识别到多种可能，请确认');
    }
    for (var w = 0; w < pre.warnings.length; w++) { pushWarning(warnings, pre.warnings[w]); }

    var draft = {
      type: best.type,
      amountCents: best.cents,
      accountId: best.accountId,
      categoryId: best.categoryId,
      date: best.date,
      time: best.time,
      note: best.note,
      tags: best.tags.slice(),
      source: 'nl'
    };
    if (best.type === 'transfer') { draft.toAccountId = best.toAccountId; }

    return {
      ok: true,
      candidates: list,
      best: best,
      draft: draft,
      matches: best.matches,
      confidence: best.confidence,
      warnings: warnings,
      input: pre.original
    };
  }

  /* ------------------------------------------------------------------ *
   * 13. 导出（XZB.Core / XZB.core 双挂载，Node 下单测可 require）
   * ------------------------------------------------------------------ */

  var api = {
    parse: parse,
    parseAmount: parseAmount,
    version: '2.0.0'
  };

  Core.nl = api;
  if (XZB.core && XZB.core !== Core) { XZB.core.nl = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
