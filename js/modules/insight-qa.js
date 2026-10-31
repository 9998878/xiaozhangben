/* ============================================================================
   小账本 2.0 · js/modules/insight-qa.js · 本地洞察问答（P0-2）
   文件：src/js/core/insight-qa.js
   路由：无（由 core-assistant 的 insight 意图调用）
   契约锚点：
     - 纯计算模块：只读 cx.db，绝不写库、不碰 DOM、不发网络请求；
     - 所有金额、比例、日期、笔数都由本文件计算后经模板拼装，
       不存在「模型自由生成数字」的路径（方案 §6.3 防幻觉）；
     - 预算口径复用 XZB.core.stats.budgetProgress（存在时），其余聚合本地实现，
       与解读页同口径：仅当前账本、支出不含转账、月窗口为自然月。
   本模块不做的事：不改账目、不改预算、不做任何 UI 决策（渲染在 assistant 屏）。
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var core = XZB.core = XZB.core || {};

  /* ============================== 基础工具 ============================== */

  function datesApi() { return core.dates || null; }
  function moneyApi() { return core.money || null; }

  function pad2(n) { return n < 10 ? '0' + String(n) : String(n); }

  function fmt(cents) {
    var m = moneyApi();
    if (m && typeof m.formatCents === 'function') {
      try { return String(m.formatCents(cents)); } catch (error) { /* 回落 */ }
    }
    return '\u00a5' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
  }

  function todayStr() {
    var d = datesApi();
    if (d && typeof d.todayStr === 'function') {
      try { return String(d.todayStr()); } catch (error) { /* 回落 */ }
    }
    var now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function currentMonth() { return todayStr().slice(0, 7); }

  function isMonth(v) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')); }

  function addMonth(key, delta) {
    if (!isMonth(key)) { return ''; }
    var year = Number(key.slice(0, 4));
    var month = Number(key.slice(5, 7)) - 1 + Number(delta || 0);
    var d = new Date(year, month, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function monthEnd(month) {
    if (!isMonth(month)) { return ''; }
    var last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    return month + '-' + pad2(last);
  }

  /* 月窗口：以 endMonth 结尾的 N 个自然月（含 endMonth） */
  function monthWindow(endMonth, months) {
    var n = Math.max(1, Number(months) || 1);
    var first = endMonth;
    for (var i = 1; i < n; i += 1) { first = addMonth(first, -1); }
    return { from: first + '-01', to: monthEnd(endMonth), endMonth: endMonth, months: n };
  }

  function monthLabel(m) {
    var parts = /^(\d{4})-(\d{2})$/.exec(String(m || ''));
    return parts ? Number(parts[1]) + '年' + Number(parts[2]) + '月' : String(m || '');
  }

  function daysInMonth(month) {
    if (!isMonth(month)) { return 30; }
    return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  }

  function medianOf(values) {
    if (!values.length) { return 0; }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function round1(v) { return Math.round(Number(v) * 10) / 10; }

  /* ============================== 聚合（单遍历，口径与解读页一致） ============================== */

  function txList(cx) {
    return (cx && cx.db && Array.isArray(cx.db.transactions)) ? cx.db.transactions : [];
  }

  /* 汇总一个日期窗口：支出按分类分桶 + 明细列表（证据用）。
   * opts.withItems === false 时不拷贝明细（预算/趋势等只要聚合值的场景省分配）。 */
  function sumWindow(cx, from, to, opts) {
    var withItems = !(opts && opts.withItems === false);
    var out = {
      expenseCents: 0, incomeCents: 0, count: 0, transferCount: 0,
      byCat: {},            /* catId → { amountCents, count } */
      items: []             /* 支出明细 {id,date,type,categoryId,note,amountCents,time} */
    };
    var list = txList(cx);
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      if (cx.bookId && tx.bookId !== cx.bookId) { continue; }
      var date = String(tx.date || '');
      if (date < from || date > to) { continue; }
      var cents = Math.round(Number(tx.amountCents) || 0);
      if (tx.type === 'transfer') { out.transferCount += 1; continue; }
      if (tx.type === 'income') { out.incomeCents += cents; continue; } /* count 只统计支出笔数：所有洞察卡都是支出口径 */
      if (tx.type !== 'expense') { continue; }
      out.expenseCents += cents;
      out.count += 1;
      var catId = String(tx.categoryId || '');
      if (!out.byCat[catId]) { out.byCat[catId] = { amountCents: 0, count: 0 }; }
      out.byCat[catId].amountCents += cents;
      out.byCat[catId].count += 1;
      if (withItems) {
        out.items.push({
          id: tx.id, date: date, time: tx.time || '', type: 'expense',
          categoryId: catId, note: String(tx.note || ''), amountCents: cents
        });
      }
    }
    return out;
  }

  function catNameOf(cx, id) {
    var cats = (cx && cx.categories) || [];
    for (var i = 0; i < cats.length; i += 1) {
      if (cats[i] && cats[i].id === id) { return String(cats[i].name || ''); }
    }
    return '';
  }

  function topOf(items, categoryId, n) {
    var picked = [];
    for (var i = 0; i < items.length; i += 1) {
      if (categoryId && items[i].categoryId !== categoryId) { continue; }
      picked.push(items[i]);
    }
    picked.sort(function (a, b) {
      if (b.amountCents !== a.amountCents) { return b.amountCents - a.amountCents; }
      return String(b.date + ' ' + String(b.time || '')).localeCompare(String(a.date + ' ' + String(a.time || '')));
    });
    return picked.slice(0, Math.max(1, Number(n) || 3));
  }

  /* 证据流水行：形状与 queryTotals 的 rows 一致，assistant 的 queryRows 可直接渲染 */
  function evidenceRow(cx, tx) {
    return {
      id: tx.id,
      date: tx.date,
      dateText: tx.date,
      type: tx.type || 'expense',
      amountCents: tx.amountCents,
      categoryText: catNameOf(cx, tx.categoryId) || '',
      note: String(tx.note || '')
    };
  }

  /* ============================== 问题解析 ============================== */

  var CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  function cnNumber(text) {
    if (/^[0-9]+$/.test(text)) { return Number(text); }
    if (text === '半') { return 0.5; }
    var total = 0;
    for (var i = 0; i < text.length; i += 1) {
      var v = CN_NUM[text[i]];
      if (!v) { return NaN; }
      total = total * 10 + v; /* 简化：只支持 1-99 的顺写（三=3、十二=12） */
    }
    return total;
  }

  /* 句中可能同时出现「这个月」和「上月」（比较句），以最早出现的为准：
   * 「这个月支出和上月比差在哪」问的是这个月，而不是上月。 */
  function parseMonthIn(s) {
    var candidates = [];
    var m = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(s);
    if (m) {
      var key = m[1] + '-' + pad2(Number(m[2]));
      if (isMonth(key) && key <= currentMonth()) { candidates.push({ at: m.index, month: key }); }
    }
    m = /(\d{1,2})\s*月/.exec(s);
    if (m) {
      var k2 = currentMonth().slice(0, 4) + '-' + pad2(Number(m[1]));
      if (k2 > currentMonth()) { k2 = String(Number(currentMonth().slice(0, 4)) - 1) + '-' + pad2(Number(m[1])); }
      if (isMonth(k2)) { candidates.push({ at: m.index, month: k2 }); }
    }
    m = /(上个月|上月)/.exec(s);
    if (m) {
      /* 「比上月/和上月/跟上月」里的上月是比较基期，不是问句主语——跳过当月份 */
      var prefix = s.slice(Math.max(0, m.index - 2), m.index);
      if (!/[比和与同较跟]$/.test(prefix)) {
        candidates.push({ at: m.index, month: addMonth(currentMonth(), -1) });
      }
    }
    m = /(这个月|本月|当月)/.exec(s);
    if (m) { candidates.push({ at: m.index, month: currentMonth() }); }
    if (!candidates.length) { return ''; }
    candidates.sort(function (a, b) { return a.at - b.at; });
    return candidates[0].month;
  }

  function parseMonthsIn(s) {
    var m = /(近|最近|过去)\s*([0-9一二两三四十]+|半)\s*(个)?月/.exec(s);
    if (!m) { return 0; }
    var n = cnNumber(m[2]);
    if (!n || n < 1) { return 0; }
    return Math.min(12, Math.round(n));
  }

  /* 每天少花 X 元 → 分；没有数字返回 0（上层出补问） */
  function parseDailySaveCents(s) {
    var m = /(每天|一天|每日)[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)\s*(?:元|块)?/.exec(s);
    if (!m) { m = /(少花|省下?)[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(?:元|块)/.exec(s); }
    if (!m) { return 0; }
    return Math.max(0, Math.round(Number(m[2]) * 100));
  }

  /* 分类匹配：取「文本里出现的最长分类名」，别名不做（预填问题带真实分类名） */
  function matchCategory(cx, s) {
    var cats = (cx && cx.liveCategories) || [];
    var best = null;
    for (var i = 0; i < cats.length; i += 1) {
      var name = String((cats[i] && cats[i].name) || '').trim();
      if (name.length < 2) { continue; }
      if (s.indexOf(name) >= 0 && (!best || name.length > best.name.length)) {
        best = { id: cats[i].id, name: name };
      }
    }
    return best;
  }

  var RE = {
    why: /(为什么|啥原因|什么原因|差在哪|差在哪儿|多在哪|多在哪里|变化|环比|贡献)/,
    budget: /(预算|超支|超不超|照这样|按这样|照这个花法|月底|还能用|还能花)/,
    save: /(每天|一天|每日).{0,6}(少花|省)|少花|能省|省下/,
    top: /(最大|最高|排行|最多|top).{0,6}(三笔|3笔|几笔|几条|哪些|一笔|一笔)|最大的三笔|最大三笔/,
    frequent: /(小钱|高频|容易忽略|零碎|零零碎碎|碎花)/,
    trend: /(趋势|走势|连续|一路)/,
    followUpCat: /(?:呢|怎么样|如何|怎样|情况|如何看|多在哪|差在哪|为什么|明细|哪些)[?？!！。～~]*$/
  };

  /* fromQuestion(text, cx, info) → 参数对象 | {type:'clarify-save'} | null
   * info: { last: state.lastInsight, chip: 上下文 Chip }；继承顺序：明说 > Chip > 上一轮 > 当前月 */
  function fromQuestion(text, cx, info) {
    var s = String(text || '').trim();
    if (!s) { return null; }
    info = info || {};

    var cat = matchCategory(cx, s);
    var month = parseMonthIn(s) ||
      (info.chip && info.chip.month) ||
      (info.last && info.last.month) ||
      currentMonth();
    var months = parseMonthsIn(s) ||
      (info.chip && info.chip.rangeKey === '3m' ? 3 : (info.chip && info.chip.rangeKey === '6m' ? 6 : 0)) ||
      (info.last && info.last.months) || 1;

    if (RE.save.test(s)) {
      var daily = parseDailySaveCents(s);
      if (!daily) { return { type: 'clarify-save' }; }
      return { type: 'save', month: month, dailySaveCents: daily };
    }
    if (RE.budget.test(s)) {
      return { type: 'budget', month: month };
    }
    if (RE.frequent.test(s)) {
      return { type: 'frequent', month: month };
    }
    if (RE.top.test(s)) {
      return { type: 'top', month: month, months: months };
    }
    if (cat && (RE.followUpCat.test(s) || RE.why.test(s))) {
      return { type: 'category', month: month, months: months, categoryId: cat.id, categoryName: cat.name };
    }
    if (RE.trend.test(s) || months > 1) {
      return { type: 'trend', month: month, months: Math.max(2, months) };
    }
    if (!cat && RE.why.test(s)) {
      return { type: 'mom', month: month };
    }
    return null;
  }

  /* ============================== 口径说明 ============================== */

  function scopeText(win) {
    return win.months > 1
      ? monthLabel(addMonth(win.endMonth, -(win.months - 1))) + ' 至 ' + monthLabel(win.endMonth)
      : monthLabel(win.endMonth);
  }

  /* ============================== 答案构建 ============================== */

  function insufficient(message, win) {
    return { ok: false, message: message, scope: win ? scopeText(win) : '' };
  }

  /* 环比原因：本期 vs 上期（或 N 月窗口 vs 前 N 月） */
  function buildMom(cx, p) {
    var win = monthWindow(p.month, 1);
    var prevKey = addMonth(p.month, -1);
    var prevWin = monthWindow(prevKey, 1);
    var cur = sumWindow(cx, win.from, win.to);
    var prv = sumWindow(cx, prevWin.from, prevWin.to);
    var label = monthLabel(p.month);
    var prevLabel = monthLabel(prevKey);

    if (!cur.expenseCents) {
      return insufficient(label + '没有支出记录，没法和' + prevLabel + '比较。', win);
    }
    if (!prv.expenseCents) {
      var firstCats = Object.keys(cur.byCat)
        .map(function (id) { return { id: id, amountCents: cur.byCat[id].amountCents, count: cur.byCat[id].count }; })
        .sort(function (a, b) { return b.amountCents - a.amountCents; })
        .slice(0, 3);
      var intro = label + '支出 ' + fmt(cur.expenseCents) + '（' + cur.count + ' 笔），' + prevLabel + '没有支出，没有可比基期。最大的几类：';
      return {
        ok: true,
        reply: {
          kind: 'insight',
          type: 'mom',
          text: intro,
          metrics: [
            { label: label + '支出', value: fmt(cur.expenseCents), sub: cur.count + ' 笔' },
            { label: prevLabel + '支出', value: fmt(0), sub: '无数据' }
          ],
          causes: firstCats.map(function (c) {
            var ev = topOf(cur.items, c.id, 3).map(function (tx) { return evidenceRow(cx, tx); });
            return { name: catNameOf(cx, c.id) || '未分类', sign: '+', amountText: fmt(c.amountCents), countText: c.count + ' 笔', categoryId: c.id, evidence: ev };
          }),
          assumption: '对比口径：' + label + ' vs ' + prevLabel + '，仅支出、不含转账。',
          links: [{ label: '看「' + (catNameOf(cx, firstCats[0] && firstCats[0].id) || '明细') + '」', hash: '#/ledger?ca=' + encodeURIComponent(firstCats[0] && firstCats[0].id || '') + '&month=' + p.month }],
          followUps: ['' + (catNameOf(cx, firstCats[0] && firstCats[0].id) || '最大一类') + '多在哪？', '最大的三笔是哪些？'],
          scope: scopeText(win) + '（对比 ' + prevLabel + '）'
        }
      };
    }

    var diffTotal = cur.expenseCents - prv.expenseCents;
    var deltas = [];
    var catIds = {};
    var id;
    for (id in cur.byCat) { if (Object.prototype.hasOwnProperty.call(cur.byCat, id)) { catIds[id] = true; } }
    for (id in prv.byCat) { if (Object.prototype.hasOwnProperty.call(prv.byCat, id)) { catIds[id] = true; } }
    Object.keys(catIds).forEach(function (cid) {
      var c = cur.byCat[cid] || { amountCents: 0, count: 0 };
      var b = prv.byCat[cid] || { amountCents: 0, count: 0 };
      var diff = c.amountCents - b.amountCents;
      if (diff === 0) { return; }
      deltas.push({ id: cid, diff: diff, count: c.count, curr: c.amountCents, prev: b.amountCents });
    });
    deltas.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
    var top = deltas.slice(0, 3);

    var pct = prv.expenseCents > 0 ? round1(Math.abs(diffTotal) / prv.expenseCents * 100) : null;
    var dir = diffTotal > 0 ? '多' : (diffTotal < 0 ? '少' : '持平');
    var causeText = top.map(function (d) {
      var name = catNameOf(cx, d.id) || '未分类';
      return name + '（' + (d.diff > 0 ? '+' : '\u2212') + fmt(Math.abs(d.diff)) + '）';
    }).join('、');
    var text = label + '支出 ' + fmt(cur.expenseCents) + '，比' + prevLabel +
      (pct === null ? dir + ' ' + fmt(Math.abs(diffTotal)) : dir + ' ' + pct + '%（' + fmt(Math.abs(diffTotal)) + '）') +
      '。' + (top.length ? '主要是' + causeText + '。' : '各分类基本持平。');

    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'mom',
        text: text,
        metrics: [
          { label: label + '支出', value: fmt(cur.expenseCents), sub: cur.count + ' 笔' },
          { label: prevLabel + '支出', value: fmt(prv.expenseCents), sub: prv.count + ' 笔' },
          { label: '差额', value: (diffTotal >= 0 ? '+' : '\u2212') + fmt(Math.abs(diffTotal)), tone: diffTotal > 0 ? 'expense' : 'income' }
        ],
        causes: top.map(function (d) {
          var ev = topOf(cur.items, d.id, 3).map(function (tx) { return evidenceRow(cx, tx); });
          return {
            name: catNameOf(cx, d.id) || '未分类',
            sign: d.diff > 0 ? '+' : '\u2212',
            amountText: fmt(Math.abs(d.diff)),
            countText: (d.prev ? '上月 ' + fmt(d.prev) + ' → ' : '') + '本期 ' + fmt(d.curr),
            categoryId: d.id,
            evidence: ev
          };
        }),
        assumption: '对比口径：' + label + ' vs ' + prevLabel + '，仅支出、不含转账；数字全部由本机计算。',
        links: top.length ? [{ label: '看「' + (catNameOf(cx, top[0].id) || '明细') + '」', hash: '#/ledger?ca=' + encodeURIComponent(top[0].id) + '&month=' + p.month }] : [],
        followUps: top.length ? ['' + (catNameOf(cx, top[0].id) || '最大一类') + '多在哪？', '最大的三笔是哪些？'] : [],
        scope: scopeText(win) + '（对比 ' + prevLabel + '）'
      }
    };
  }

  /* 分类下钻：金额 / 笔数 / 中位数 / 最大三笔 + 环比 */
  function buildCategory(cx, p) {
    var win = monthWindow(p.month, p.months);
    var prevWin = monthWindow(addMonth(p.month, -(p.months)), p.months);
    var cur = sumWindow(cx, win.from, win.to);
    var prv = sumWindow(cx, prevWin.from, prevWin.to);
    var curCat = cur.byCat[p.categoryId] || { amountCents: 0, count: 0 };
    var prevCat = prv.byCat[p.categoryId] || { amountCents: 0, count: 0 };
    var name = p.categoryName || catNameOf(cx, p.categoryId) || '该分类';

    if (!curCat.count && !prevCat.count) {
      return insufficient('当前账本里没有找到「' + name + '」在这个期间的支出记录。', win);
    }
    if (!curCat.count) {
      return insufficient('' + scopeText(win) + '没有「' + name + '」的支出；上一个同长窗口花了 ' + fmt(prevCat.amountCents) + '（' + prevCat.count + ' 笔）。', win);
    }

    var amounts = [];
    var items = topOf(cur.items, p.categoryId, 999);
    for (var i = 0; i < items.length; i += 1) { amounts.push(items[i].amountCents); }
    var diff = curCat.amountCents - prevCat.amountCents;
    var pct = prevCat.amountCents > 0 ? round1(Math.abs(diff) / prevCat.amountCents * 100) : null;
    var top3 = items.slice(0, 3);
    var topText = top3.map(function (tx, idx) { return (idx + 1) + '. ' + tx.date + ' ' + (tx.note || '—') + ' ' + fmt(tx.amountCents); });

    var text = name + ' ' + scopeText(win) + '支出 ' + fmt(curCat.amountCents) + '（' + curCat.count +
      ' 笔，单笔中位数 ' + fmt(medianOf(amounts)) + '）';
    if (prevCat.count) {
      text += '，比上一同长窗口' + (diff >= 0 ? '多 ' : '少 ') + fmt(Math.abs(diff)) +
        (pct === null ? '' : '（' + pct + '%）');
    }
    text += '。最大的三笔：' + topText.join('；') + '。';

    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'category',
        text: text,
        metrics: [
          { label: name + '支出', value: fmt(curCat.amountCents), sub: curCat.count + ' 笔' },
          { label: '单笔中位数', value: fmt(medianOf(amounts)) }
        ],
        causes: [],
        rows: top3.map(function (tx) { return evidenceRow(cx, tx); }),
        assumption: '口径：' + scopeText(win) + '，仅当前账本支出；对比基期 ' + scopeText(prevWin) + '。',
        links: [{ label: '看「' + name + '」全部流水', hash: '#/ledger?ca=' + encodeURIComponent(p.categoryId) + '&month=' + p.month }],
        followUps: ['这个月预算还超吗？', '最大的三笔是哪些？'],
        scope: scopeText(win)
      }
    };
  }

  /* 预算状态与月底预测（口径走 XZB.core.stats.budgetProgress） */
  function buildBudget(cx, p) {
    var win = monthWindow(p.month, 1);
    var sum = sumWindow(cx, win.from, win.to, { withItems: false });
    var label = monthLabel(p.month);
    if (!sum.count && !sum.expenseCents) {
      return insufficient(label + '还没有支出记录，暂做不了预测。', win);
    }

    var stats = core.stats;
    var bp = null;
    if (stats && typeof stats.budgetProgress === 'function') {
      try { bp = stats.budgetProgress(cx.db, p.month, { bookId: cx.bookId }); } catch (error) { bp = null; }
    }
    var totalCents = bp ? Math.max(0, Math.round(Number(bp.totalCents) || 0)) : 0;
    var spentCents = bp ? Math.max(0, Math.round(Number(bp.spentCents) || 0)) : sum.expenseCents;

    var isCurrent = p.month === currentMonth();
    var dim = daysInMonth(p.month);
    var todayDate = Number(todayStr().slice(8, 10));
    var daysElapsed = isCurrent ? Math.min(Math.max(1, todayDate), dim) : dim;
    var dailyAvg = Math.round(spentCents / daysElapsed);
    var projected = isCurrent ? dailyAvg * dim : spentCents;

    var metrics = [
      { label: isCurrent ? '已支出' : '支出', value: fmt(spentCents), sub: totalCents ? '预算 ' + fmt(totalCents) : sum.count + ' 笔' },
      { label: '日均支出', value: fmt(dailyAvg), sub: isCurrent ? '截至今天' : '全月' }
    ];
    if (isCurrent) { metrics.push({ label: '预计全月', value: fmt(projected), sub: '按日均 × ' + dim + ' 天' }); }

    var text;
    if (totalCents > 0) {
      var over = projected - totalCents;
      if (isCurrent && over > 0) {
        metrics.push({ label: '预计超支', value: fmt(over), tone: 'expense' });
        text = '照前 ' + daysElapsed + ' 天的日均花法，' + label + '预计支出 ' + fmt(projected) + '，会超预算 ' + fmt(over) + '。';
      } else if (isCurrent) {
        metrics.push({ label: '预计结余', value: fmt(totalCents - projected), tone: 'income' });
        text = '照前 ' + daysElapsed + ' 天的日均花法，' + label + '预计支出 ' + fmt(projected) + '，预算内还剩 ' + fmt(totalCents - projected) + '。';
      } else {
        var realOver = spentCents - totalCents;
        metrics.push({ label: realOver > 0 ? '超出预算' : '低于预算', value: fmt(Math.abs(realOver)), tone: realOver > 0 ? 'expense' : 'income' });
        text = label + '实际支出 ' + fmt(spentCents) + '，预算 ' + fmt(totalCents) + (realOver > 0 ? '，超出 ' + fmt(realOver) + '。' : '，还剩 ' + fmt(totalCents - spentCents) + '。');
      }
    } else {
      text = label + '还没设预算。' + (isCurrent
        ? '按目前日均 ' + fmt(dailyAvg) + '，月底预计支出 ' + fmt(projected) + '。'
        : '全月支出 ' + fmt(spentCents) + '。');
    }

    var links = [];
    if (totalCents > 0) { links.push({ label: '看预算', hash: '#/home?focus=budget' }); }
    else { links.push({ label: '去设置预算', hash: '#/plan' }); }

    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'budget',
        text: text,
        metrics: metrics,
        causes: [],
        assumption: isCurrent
          ? '按' + label + '截至今天的日均支出估算，不含未来大额收入或支出；预算口径与首页一致。'
          : '预算口径与首页一致（XZB.core.stats.budgetProgress）。',
        links: links,
        followUps: ['每天少花20元会怎样？', '这个月支出和上月比差在哪？'],
        scope: scopeText(win)
      }
    };
  }

  /* 节省模拟：纯计算，不改预算不改账 */
  function buildSave(cx, p) {
    var month = p.month || currentMonth();
    var win = monthWindow(month, 1);
    var sum = sumWindow(cx, win.from, win.to, { withItems: false });
    var isCurrent = month === currentMonth();
    var dim = daysInMonth(month);
    var todayDate = Number(todayStr().slice(8, 10));
    var daysLeft = isCurrent ? Math.max(0, dim - todayDate + 1) : 0; /* 含今天，与首页同口径 */
    var daysElapsed = isCurrent ? Math.min(Math.max(1, todayDate), dim) : dim;
    var dailyAvg = sum.expenseCents > 0 ? Math.round(sum.expenseCents / daysElapsed) : 0;
    var projected = isCurrent ? dailyAvg * dim : sum.expenseCents;
    var savings = p.dailySaveCents * (isCurrent ? daysLeft : dim);
    var newProjected = Math.max(0, projected - savings);

    var text;
    if (isCurrent) {
      text = '每天少花 ' + fmt(p.dailySaveCents) + '，这个月还剩 ' + daysLeft +
        ' 天，能省 ' + fmt(savings) + '；按当前日均，月底支出预计从 ' + fmt(projected) + ' 降到 ' + fmt(newProjected) + '。';
    } else {
      text = monthLabel(month) + '已经结束。按「每天少花 ' + fmt(p.dailySaveCents) + '」回算，全月能省 ' + fmt(savings) + '。';
    }

    var metrics = [
      { label: '每天少花', value: fmt(p.dailySaveCents) },
      { label: isCurrent ? '剩余天数' : '全月天数', value: (isCurrent ? daysLeft : dim) + ' 天' },
      { label: '能省', value: fmt(savings), tone: 'income' }
    ];
    if (isCurrent) { metrics.push({ label: '月底预计', value: fmt(newProjected), sub: '原预计 ' + fmt(projected) }); }

    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'save',
        text: text,
        metrics: metrics,
        causes: [],
        assumption: '纯计算模拟：按' + monthLabel(month) + '日均支出推算，不修改任何账目与预算。',
        links: [{ label: '去调整预算', hash: '#/plan' }],
        followUps: ['这个月预算还超吗？', '最大的三笔是哪些？'],
        scope: scopeText(win)
      }
    };
  }

  /* 趋势：近 N 月支出序列 + 连续走高分类 */
  function buildTrend(cx, p) {
    var n = Math.max(2, Math.min(12, p.months || 3));
    var endMonth = p.month || currentMonth();
    var months = [];
    for (var i = n - 1; i >= 0; i -= 1) { months.push(addMonth(endMonth, -i)); }
    var series = [];
    var monthly = [];
    for (var m = 0; m < months.length; m += 1) {
      var w = monthWindow(months[m], 1);
      var sum = sumWindow(cx, w.from, w.to, { withItems: false });
      monthly.push(sum);
      series.push({ month: months[m], expenseCents: sum.expenseCents, count: sum.count });
    }
    var lastWin = monthWindow(endMonth, 1);
    var totalCents = 0;
    var hasAny = false;
    for (var s = 0; s < series.length; s += 1) {
      totalCents += series[s].expenseCents;
      if (series[s].expenseCents > 0) { hasAny = true; }
    }
    if (!hasAny) {
      return insufficient('近 ' + n + ' 个月（' + monthLabel(months[0]) + ' 起）没有支出记录。', lastWin);
    }

    /* 连续走高：复用逐月聚合结果（不重复扫全表） */
    var byCat = {};
    for (var t = 0; t < months.length; t += 1) {
      var sum2 = monthly[t];
      var ids = Object.keys(sum2.byCat);
      for (var c = 0; c < ids.length; c += 1) {
        if (!byCat[ids[c]]) { byCat[ids[c]] = []; }
        byCat[ids[c]].push({ index: t, amountCents: sum2.byCat[ids[c]].amountCents });
      }
    }
    var risers = [];
    Object.keys(byCat).forEach(function (cid) {
      var arr = byCat[cid];
      if (arr.length < 2) { return; }
      var first = arr[0].amountCents;
      var last = arr[arr.length - 1].amountCents;
      if (last <= first || last - first < 1000) { return; }
      var strictly = true;
      for (var k = 1; k < arr.length; k += 1) {
        if (arr[k].amountCents < arr[k - 1].amountCents) { strictly = false; break; }
      }
      if (strictly) { risers.push({ id: cid, diff: last - first, first: first, last: last }); }
    });
    risers.sort(function (a, b) { return b.diff - a.diff; });
    risers = risers.slice(0, 2);

    var seq = series.map(function (item) {
      var sameYear = item.month.slice(0, 4) === String(series[0].month.slice(0, 4));
      return (sameYear ? Number(item.month.slice(5, 7)) + '月' : monthLabel(item.month)) + ' ' + fmt(item.expenseCents);
    }).join('，');
    var text = '近 ' + n + ' 个月支出依次：' + seq + '。' +
      (risers.length ? risers.map(function (r) { return (catNameOf(cx, r.id) || '未分类') + '连续走高（+' + fmt(r.diff) + '）'; }).join('；') + '。' : '整体没有连续上涨的分类。');

    var metrics = series.map(function (item) {
      return { label: monthLabel(item.month), value: fmt(item.expenseCents), sub: item.count + ' 笔' };
    });

    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'trend',
        text: text,
        metrics: metrics,
        causes: [],
        assumption: '口径：' + scopeText(monthWindow(endMonth, n)) + '，仅当前账本支出。',
        links: [{ label: '看解读', hash: '#/insights?m=' + endMonth + '&r=month' }],
        followUps: ['为什么' + monthLabel(endMonth) + '支出比上月多了？', '最大的三笔是哪些？'],
        scope: scopeText(monthWindow(endMonth, n))
      }
    };
  }

  /* 最大的三笔 */
  function buildTop(cx, p) {
    var win = monthWindow(p.month, p.months || 1);
    var sum = sumWindow(cx, win.from, win.to);
    if (!sum.items.length) {
      return insufficient(scopeText(win) + '没有支出记录。', win);
    }
    var top3 = topOf(sum.items, '', 3);
    var total = 0;
    for (var i = 0; i < top3.length; i += 1) { total += top3[i].amountCents; }
    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'top',
        text: scopeText(win) + '最大的三笔支出合计 ' + fmt(total) + '，占该期间支出 ' +
          (sum.expenseCents > 0 ? round1(total / sum.expenseCents * 100) : 0) + '%。',
        metrics: [{ label: '合计', value: fmt(total), sub: '占支出 ' + (sum.expenseCents > 0 ? round1(total / sum.expenseCents * 100) : 0) + '%' }],
        causes: [],
        rows: top3.map(function (tx) { return evidenceRow(cx, tx); }),
        assumption: '口径：' + scopeText(win) + '，仅当前账本支出，按单笔金额从高到低。',
        links: [{ label: '看明细', hash: '#/ledger?month=' + p.month }],
        followUps: ['这个月支出和上月比差在哪？', '这个月预算还超吗？'],
        scope: scopeText(win)
      }
    };
  }

  /* 高频小额：笔数多、单笔小、合计可观的分类（与解读页 frequent 规则同阈值思路） */
  function buildFrequent(cx, p) {
    var win = monthWindow(p.month, 1);
    var sum = sumWindow(cx, win.from, win.to);
    if (!sum.items.length) {
      return insufficient(monthLabel(p.month) + '没有支出记录，没有小钱可看。', win);
    }
    var byCat = {};
    for (var i = 0; i < sum.items.length; i += 1) {
      var it = sum.items[i];
      if (!byCat[it.categoryId]) { byCat[it.categoryId] = { count: 0, total: 0, amounts: [], items: [] }; }
      var bucket = byCat[it.categoryId];
      bucket.count += 1;
      bucket.total += it.amountCents;
      bucket.amounts.push(it.amountCents);
      bucket.items.push(it);
    }
    var candidates = Object.keys(byCat).map(function (cid) {
      var b = byCat[cid];
      var amounts = b.amounts.slice().sort(function (a, x) { return a - x; });
      var mid = amounts.length % 2 ? amounts[(amounts.length - 1) / 2] : (amounts[amounts.length / 2 - 1] + amounts[amounts.length / 2]) / 2;
      return { id: cid, count: b.count, total: b.total, median: Math.round(mid), items: b.items };
    }).filter(function (c) {
      return c.count >= 3 && c.median <= 10000; /* ≥3 笔且单笔中位数 ≤¥100；按合计排序取最值得看的 */
    }).sort(function (a, b) { return b.total - a.total; }).slice(0, 3);
    if (!candidates.length) {
      return insufficient(monthLabel(p.month) + '没有明显的高频小额类别（标准：≥3 笔且单笔中位数 ≤¥100）。', win);
    }
    var label = monthLabel(p.month);
    var head = candidates[0];
    var text = label + '最容易忽略的小钱是「' + (catNameOf(cx, head.id) || '未分类') + '」：' + head.count +
      ' 笔合计 ' + fmt(head.total) + '（单笔中位数 ' + fmt(head.median) + '）。' +
      (candidates.length > 1 ? '其次：' + candidates.slice(1).map(function (c) {
        return (catNameOf(cx, c.id) || '未分类') + ' ' + c.count + ' 笔 ' + fmt(c.total);
      }).join('、') + '。' : '');
    var evidence = head.items.slice().sort(function (a, b) {
      return String(b.date + ' ' + String(b.time || '')).localeCompare(String(a.date + ' ' + String(a.time || '')));
    }).slice(0, 5).map(function (tx) { return evidenceRow(cx, tx); });
    return {
      ok: true,
      reply: {
        kind: 'insight',
        type: 'frequent',
        text: text,
        metrics: candidates.map(function (c) {
          return { label: catNameOf(cx, c.id) || '未分类', value: fmt(c.total), sub: c.count + ' 笔 · 中位数 ' + fmt(c.median) };
        }),
        causes: [],
        rows: evidence,
        assumption: '口径：' + scopeText(win) + '，按「笔数 ≥3 且单笔中位数 ≤¥100」找小额高频分类，全部由本机计算。',
        links: [{ label: '看「' + (catNameOf(cx, head.id) || '明细') + '」流水', hash: '#/ledger?ca=' + encodeURIComponent(head.id) + '&month=' + p.month }],
        followUps: ['每天少花10元会怎样？', '这个月支出和上月比差在哪？'],
        scope: scopeText(win)
      }
    };
  }

  /* build(parsed, cx) → { ok:true, reply } | { ok:false, message, scope } */
  function build(parsed, cx) {
    if (!cx || !cx.db) { return insufficient('数据还没准备好，稍等一下再试。'); }
    if (!parsed || !parsed.type) { return insufficient('这个问题我还没学会，先试试「为什么这个月支出比上月多？」'); }
    switch (parsed.type) {
      case 'mom': return buildMom(cx, parsed);
      case 'category': return buildCategory(cx, parsed);
      case 'budget': return buildBudget(cx, parsed);
      case 'save': return buildSave(cx, parsed);
      case 'trend': return buildTrend(cx, parsed);
      case 'top': return buildTop(cx, parsed);
      case 'frequent': return buildFrequent(cx, parsed);
      default: return insufficient('这个问题我还没学会。');
    }
  }

  /* ============================== 导出 ============================== */

  var api = {
    fromQuestion: fromQuestion,
    build: build,
    monthLabel: monthLabel,
    currentMonth: currentMonth,
    matchCategory: matchCategory,
    sumWindow: sumWindow
  };

  core.insightqa = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

}(typeof window !== 'undefined' ? window : globalThis));
