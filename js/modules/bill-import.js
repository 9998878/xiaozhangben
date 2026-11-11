/* 小账本 2.0 · js/modules/bill-import.js —— 微信/支付宝/通用 CSV 账单解析（2.29.0 起，2.32.0 加通用 CSV）
 * 来源：竞品吸收批次三 A。表头探测与列名归一算法吸收自 BeeCount generic_parser
 * （列数一致性找表头 + 中英同义词映射），金额定点与去重思路对齐 Actual/Firefly III。
 * 2.32.0：表头含「分类」列的 CSV 也认（source='generic'），分类/账户按名称归位，
 *          供「从 CSV 账单导入」把别家记账应用的账单带着分类搬进来。
 *
 * 公开（XZB.Core.billImport）：
 *   detectSource(text) → 'wechat' | 'alipay' | 'generic' | null
 *   parse(text, opts)  → { ok:true, source, rows, skipped, warnings }
 *                      | { ok:false, code }
 *     row:    { line, date, time, type:'expense'|'income', amountCents, note,
 *               accountHint, refNo, status, category, accountName }
 *     skipped:{ line, reason }
 *   pickCategoryId(name, kind, categories) → 分类 id 或 ''（2.32.0：通用 CSV 按名称/别名归分类）
 *   pickAccountId(name, accounts)          → 账户 id 或 ''
 *   仅解析，不落库、不发请求（隐私红线：全程本机）；编码（UTF-8/GBK）由调用方处理。
 * 纯函数：不改入参；解析失败/异常都返回结构化结果，不抛错。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var Core = XZB.Core || (XZB.Core = {});

  var HEADER_WINDOW = 40;      /* 表头只在前 40 行里找 */
  var HEADER_CONFIRM_ROWS = 5; /* 表头后连续 N 行列数一致才算确认 */
  var MIN_COLS = 6;            /* 表头最少列数 */
  var MAX_ROWS = 2000;         /* 单文件解析行数上限（超出截断并警告） */
  var MAX_WARNINGS = 20;       /* 警告条数上限，超出合并 */
  var NOTE_MAX = 80;           /* 与 schema LIMITS.txNote 一致 */

  /* ---------------- 基础工具 ---------------- */

  function stripBom(text) {
    return String(text == null ? '' : text).replace(/^\uFEFF/, '');
  }

  /* 引号内逗号不分割的 CSV 单行切分；"" 转义为字面引号 */
  function splitCsvLine(line) {
    var out = [];
    var cur = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inQuote) {
        if (ch === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
          else { inQuote = false; }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function cellCount(line) {
    return splitCsvLine(line).length;
  }

  function trimCell(v) {
    return String(v == null ? '' : v).replace(/\u3000/g, ' ').trim();
  }

  function normHeader(v) {
    return trimCell(v).replace(/（/g, '(').replace(/）/g, ')');
  }

  /* ¥1,234.56 → 123456（整数分）；非法/零以下返回 NaN */
  function cleanAmount(raw) {
    var s = trimCell(raw).replace(/[¥￥\s,]/g, '');
    if (!s || s === '/') { return NaN; }
    var v = Number(s);
    if (!isFinite(v)) { return NaN; }
    return Math.round(v * 100);
  }

  /* '2023-01-01 12:00:36' → {date, time:'HH:MM'}；不合法返回 null */
  function parseDateTime(raw) {
    var s = trimCell(raw);
    var m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/.exec(s);
    if (!m) { return null; }
    return { date: m[1], time: m[2] ? m[2] + ':' + m[3] : '' };
  }

  function uniqParts(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = trimCell(parts[i]);
      if (!p || out.indexOf(p) >= 0) { continue; }
      out.push(p);
      if (out.join(' · ').length > NOTE_MAX) { out.pop(); break; }
    }
    return out.join(' · ').slice(0, NOTE_MAX);
  }

  /* ---------------- 来源识别 ---------------- */

  function splitLines(text) {
    return stripBom(text).replace(/\r\n?/g, '\n').split('\n');
  }

  function detectSource(text) {
    var t = String(text == null ? '' : text);
    if (t.indexOf('商家订单号') >= 0 || t.indexOf('交易创建时间') >= 0) { return 'alipay'; }
    if (t.indexOf('交易类型') >= 0 && t.indexOf('当前状态') >= 0 && t.indexOf('交易单号') >= 0) { return 'wechat'; }
    /* 2.32.0：带「分类」列、表头能凑齐日期/金额/收支的通用 CSV（小账本自己导的、别家记账应用导的） */
    if (findGenericHeader(splitLines(t)) >= 0) { return 'generic'; }
    return null;
  }

  /* 通用 CSV 表头：除必填三列外还必须能映射出「分类」，避免把随便一个 CSV 当账单 */
  function findGenericHeader(lines) {
    var end = Math.min(lines.length, HEADER_WINDOW + HEADER_CONFIRM_ROWS);
    for (var i = 0; i < end; i++) {
      var cells = splitCsvLine(lines[i]);
      if (cells.length < 4) { continue; }
      var mapped = mapColumns(cells);
      if (mapped.ok && mapped.map.category !== undefined) { return i; }
    }
    return -1;
  }

  /* ---------------- 表头定位与列映射 ---------------- */

  function findHeaderRow(lines) {
    var limit = Math.min(HEADER_WINDOW, lines.length - HEADER_CONFIRM_ROWS - 1);
    for (var i = 0; i <= limit; i++) {
      var c0 = cellCount(lines[i]);
      if (c0 < MIN_COLS) { continue; }
      var confirmed = true;
      for (var j = 1; j <= HEADER_CONFIRM_ROWS; j++) {
        if (cellCount(lines[i + j]) !== c0) { confirmed = false; break; }
      }
      if (confirmed) { return i; }
    }
    /* 退化：直接找含已知表头词的行 */
    for (var k = 0; k < Math.min(HEADER_WINDOW, lines.length); k++) {
      var cells = splitCsvLine(lines[k]);
      for (var c = 0; c < cells.length; c++) {
        var h = normHeader(cells[c]);
        if (h === '交易时间' || h === '交易创建时间' || h === '交易号') { return k; }
      }
    }
    return -1;
  }

  var SYNONYMS = {
    date: ['交易时间', '交易创建时间', '付款时间', '日期'],
    amount: ['金额(元)', '金额'],
    direction: ['收/支', '收支'],
    item: ['商品', '商品名称', '商品说明'],
    counterparty: ['交易对方'],
    txType: ['交易类型'],
    status: ['当前状态', '交易状态', '状态'],
    payWay: ['支付方式', '付款方式'],
    refNo: ['交易单号', '交易号'],
    note: ['备注'],
    category: ['分类', '类别', '账单分类'],
    account: ['账户', '账号', '付款账户']
  };
  var REQUIRED = ['date', 'amount', 'direction'];

  function mapColumns(headerCells) {
    var map = {};
    for (var c = 0; c < headerCells.length; c++) {
      var name = normHeader(headerCells[c]);
      if (!name) { continue; }
      Object.keys(SYNONYMS).forEach(function (field) {
        if (map[field] !== undefined) { return; }
        if (SYNONYMS[field].indexOf(name) >= 0) { map[field] = c; }
      });
    }
    for (var r = 0; r < REQUIRED.length; r++) {
      if (map[REQUIRED[r]] === undefined) { return { ok: false, missing: REQUIRED[r] }; }
    }
    return { ok: true, map: map };
  }

  /* ---------------- 分类/账户按名称归位（2.32.0） ---------------- */

  /* 账单里的分类只有名字：先认正名，再认别名；只认同收支方向的分类，认不到返回 '' */
  function pickCategoryId(name, kind, categories) {
    var want = trimCell(name);
    if (!want || !Array.isArray(categories)) { return ''; }
    var i;
    var j;
    var c;
    for (i = 0; i < categories.length; i++) {
      c = categories[i];
      if (!c || (kind && c.kind !== kind)) { continue; }
      if (trimCell(c.name) === want) { return String(c.id); }
    }
    for (i = 0; i < categories.length; i++) {
      c = categories[i];
      if (!c || (kind && c.kind !== kind)) { continue; }
      var aliases = Array.isArray(c.aliases) ? c.aliases : [];
      for (j = 0; j < aliases.length; j++) {
        if (trimCell(aliases[j]) === want) { return String(c.id); }
      }
    }
    return '';
  }

  /* 账单里的账户只有名字：按名称精确匹配现有账户，认不到返回 ''（调用方退回手选账户） */
  function pickAccountId(name, accounts) {
    var want = trimCell(name);
    if (!want || !Array.isArray(accounts)) { return ''; }
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      if (!a || a.archived === true) { continue; }
      if (trimCell(a.name) === want) { return String(a.id); }
    }
    return '';
  }

  /* ---------------- 状态闸门 ---------------- */

  /* 返回 null=通过；字符串=跳过原因 */
  function statusGate(source, status) {
    var s = trimCell(status);
    if (!s || s === '/') { return null; }          /* 微信中性状态视作可用 */
    if (s.indexOf('退款') >= 0) { return '退款相关账单未导入'; }
    if (s.indexOf('关闭') >= 0) { return '交易关闭未导入'; }
    if (s.indexOf('成功') >= 0 || s.indexOf('已存入') >= 0 ||
        s.indexOf('已收钱') >= 0 || s.indexOf('已转账') >= 0) { return null; }
    return '状态非成功：' + s;
  }

  function directionOf(raw) {
    var s = trimCell(raw);
    if (s === '收入') { return 'income'; }
    if (s === '支出') { return 'expense'; }
    return null;   /* '/'、'不计收支'、空 → 中性行 */
  }

  /* ---------------- 主解析 ---------------- */

  function parse(text, opts) {
    try {
      var lines = splitLines(text);
      var src = detectSource(text);
      if (!src) { return { ok: false, code: 'E_BILL_SOURCE' }; }
      if (opts && opts.source && opts.source !== src) { src = String(opts.source); }

      var headerIdx = src === 'generic' ? findGenericHeader(lines) : findHeaderRow(lines);
      if (headerIdx < 0) { return { ok: false, code: 'E_BILL_HEADER' }; }
      var mapped = mapColumns(splitCsvLine(lines[headerIdx]));
      if (!mapped.ok) { return { ok: false, code: 'E_BILL_HEADER' }; }
      var map = mapped.map;

      var rows = [];
      var skipped = [];
      var warnings = [];
      var truncated = false;

      for (var i = headerIdx + 1; i < lines.length; i++) {
        var lineNo = i + 1;
        var line = lines[i];
        if (!trimCell(line)) { continue; }
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        var cells = splitCsvLine(line);
        var get = function (field) {
          var idx = map[field];
          return idx === undefined ? '' : (cells[idx] || '');
        };

        var dir = directionOf(get('direction'));
        if (!dir) {
          skipped.push({ line: lineNo, reason: '不计收支行（转账/理财等）' });
          continue;
        }
        var amountCents = cleanAmount(get('amount'));
        if (!isFinite(amountCents) || amountCents <= 0) {
          skipped.push({ line: lineNo, reason: '金额无法解析' });
          continue;
        }
        var when = parseDateTime(get('date'));
        if (!when) {
          skipped.push({ line: lineNo, reason: '日期无法解析' });
          continue;
        }
        var status = get('status');
        var gate = statusGate(src, status);
        if (gate) {
          skipped.push({ line: lineNo, reason: gate });
          continue;
        }

        var parts;
        if (src === 'wechat') { parts = [get('txType'), get('counterparty'), get('item')]; }
        else if (src === 'alipay') { parts = [get('counterparty'), get('item')]; }
        else { parts = [get('note'), get('counterparty'), get('item')]; }

        rows.push({
          line: lineNo,
          date: when.date,
          time: when.time,
          type: dir,
          amountCents: amountCents,
          note: uniqParts(parts),
          accountHint: trimCell(get('payWay')),
          refNo: trimCell(get('refNo')),
          status: trimCell(status),
          category: trimCell(get('category')),
          accountName: trimCell(get('account'))
        });
      }

      if (truncated) {
        warnings.push('账单行数超过 ' + MAX_ROWS + ' 行，已截断；请分段时间导出后再导入');
      }
      if (skipped.length > MAX_WARNINGS) {
        warnings.push('另有 ' + (skipped.length - MAX_WARNINGS) + ' 行跳过，未逐条列出');
      }
      if (!rows.length && !skipped.length) {
        return { ok: false, code: 'E_BILL_EMPTY' };
      }
      return {
        ok: true,
        source: src,
        rows: rows,
        skipped: skipped,
        warnings: warnings,
        headerLine: headerIdx + 1
      };
    } catch (error) {
      return { ok: false, code: 'E_BILL_PARSE' };
    }
  }

  Core.billImport = Object.freeze({
    detectSource: detectSource,
    parse: parse,
    pickCategoryId: pickCategoryId,
    pickAccountId: pickAccountId,
    MAX_ROWS: MAX_ROWS
  });
}(typeof window !== 'undefined' ? window : this));
