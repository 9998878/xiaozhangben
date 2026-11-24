/* 小账本 2.0 · js/modules/audit.js —— 账单体检（2.39.0）
 * 从流水里自动找出七类问题，全部本机计算、不联网：
 *   1) 疑似重复      同日（或隔日）同分类同金额，且不属于周期账单
 *   2) 固定开销      同额同分类、按周/两周/月/季/年规律出现的支出（房租、订阅、会员）
 *   3) 久未记账      最后一笔距今 ≥ 14 天
 *   4) 断档月份      首尾之间几乎没记的整月
 *   5) 分类不清      近 3 个月支出里「其他」占比过高
 *   6) 异常大额      明显高于该分类平时水平的单笔（稳健 z 分数 + 倍数双重门槛）
 *   7) 月支出突增    上个完整月比再上一个月多花的部分，按分类拆开
 *
 * 公开（XZB.Core.audit）：
 *   run(input) → report
 *     input : { transactions, scope, today, categories }（都可选）
 *              scope 同统计口径 { bookId, hasBooks, archived }
 *     report: { ok, asOf, counts, score, grade, fixedMonthlyCents, recurring, findings }
 *     finding: { code, severity:'high'|'mid'|'low', title, text, facts:[string], rows:[item] }
 *     item   : { id, tx, date, time, month, type, amountCents, categoryId, categoryName,
 *                accountId, note }——tx 是原流水对象引用，界面拿它开详情
 *   RULES —— 阈值只读暴露，测试与文档引用同一份
 * 纯函数：不改入参、不读 DOM / 存储、不发请求；任何异常都收束成 { ok:false, code }。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var Core = XZB.Core || (XZB.Core = {});

  var DAY_MS = 86400000;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var SEVERITY_RANK = { high: 0, mid: 1, low: 2 };
  var SEVERITY_COST = { high: 20, mid: 10, low: 5 };

  /* 阈值集中在这里；金额单位一律「分」 */
  var RULES = {
    /* 固定开销 */
    MIN_FIXED_CENTS: 500,        /* 单笔低于 ¥5 不当周期账单（高频小额噪音） */
    BRIDGE_TOLERANCE: 0.2,       /* 周期允许的浮动比例（下限 3 天） */
    MAX_BRIDGE_RATIO: 1 / 3,     /* 一条周期里允许「跳过一期」的次数占比 */
    MONTHLY_DOM_SPREAD: 5,       /* 月度账单各期「几号」的最大离散 */
    MIN_CHAIN_EXCLUSIVITY: 0.6,  /* 不足 6 期的链：该「金额+分类」的日期里至少 60% 落在链上。
                                    三顿 ¥26 恰好隔一个月是巧合；房租不会每周都出现 */
    /* 疑似重复 */
    DUP_SPAN_DAYS: 1,            /* 同日算一组；相邻日也算候选但降级 */
    DUP_MAX_GROUPS: 6,
    DUP_HABIT_RATE: 0.4,         /* ↑ 习惯判定的「多笔日」占比 */
    DUP_SAME_MINUTE_GAP: 2,      /* 有记录时间时：组内相隔 ≤ 2 分钟才算重复候选（分钟） */
    HIGH_FREQ_PER_MONTH: 8,       /* 分类月均 ≥ 8 笔算高频（餐饮、交通） */
    HIGH_FREQ_MIN_COUNT: 5,       /* 高频分类里的周期账单至少 5 期：三顿 ¥26 恰好隔月只是巧合 */
    DUP_HABIT_MIN_DAYS: 5,       /* 同一「金额+分类」出现 ≥5 天，且 ≥40% 的那天本身就有 ≥2 笔 →
                                    这是消费习惯（一天两顿 ¥15），整组不报重复 */
    /* 异常大额 */
    OUTLIER_MIN_COUNT: 6,        /* 该分类除被检验那笔外，至少要有 6 笔作参照 */
    OUTLIER_RATIO: 4,            /* 至少是该分类中位数的 N 倍 */
    OUTLIER_MIN_DIFF: 2000,      /* 且比中位数至少多 ¥20 */
    OUTLIER_Z: 5,                /* 稳健 z = 0.6745·(x−中位数)/MAD */
    OUTLIER_MAX: 3,
    /* 断档 / 停记 */
    GAP_MIN_COUNT: 2,            /* 一个整月不超过 2 笔算几乎没记 */
    STALE_DAYS: 14,
    /* 分类不清 */
    OTHER_MIN_SHARE: 0.15,       /* 「其他」占近 3 个月支出 ≥ 15% */
    OTHER_MIN_CENTS: 3000,       /* 且金额 ≥ ¥30 */
    /* 月支出突增 */
    SURGE_MIN_COUNT: 3,          /* 参与对比的两个月各至少 3 笔 */
    SURGE_RATIO: 0.3,            /* 多花 ≥ 30% */
    SURGE_MIN_DIFF: 20000,       /* 且多花 ≥ ¥200 */
    SURGE_TOP: 3
  };

  /* 规律档：中位间隔落在 [min, max] 天内即归入；perYear 用于折算「每月」金额 */
  var CADENCES = [
    { key: 'weekly', label: '每周', min: 6, max: 8, perYear: 52, minCount: 4 },
    { key: 'biweekly', label: '每两周', min: 13, max: 15, perYear: 26, minCount: 4 },
    { key: 'monthly', label: '每月', min: 27, max: 33, perYear: 12, minCount: 3 },
    { key: 'quarterly', label: '每季度', min: 88, max: 96, perYear: 4, minCount: 3 },
    { key: 'yearly', label: '每年', min: 360, max: 371, perYear: 1, minCount: 2 }
  ];

  /* ---------------- 日期与数字工具（全部按 UTC 日历算，不受时区/夏令时影响） ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function dayNum(dateStr) {
    return Math.floor(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) / DAY_MS);
  }

  function fromDate(n) {
    var d = new Date(n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function validDate(value) {
    return typeof value === 'string' && DATE_RE.test(value) && fromDate(dayNum(value)) === value;
  }

  function addMonths(dateStr, delta) {
    var y = +dateStr.slice(0, 4);
    var m = +dateStr.slice(5, 7) - 1 + delta;
    var d = +dateStr.slice(8, 10);
    var ny = y + Math.floor(m / 12);
    var nm = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return ny + '-' + pad2(nm + 1) + '-' + pad2(Math.min(d, last));
  }

  function monthOf(dateStr) { return dateStr.slice(0, 7); }

  function median(values) {
    if (!values.length) { return 0; }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function fmtCents(cents) {
    var abs = Math.abs(Math.round(Number(cents) || 0));
    var yuan = String(Math.floor(abs / 100));
    var grouped = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '¥' + grouped + '.' + pad2(abs % 100);
  }

  function monthLabel(ym, today) {
    var sameYear = ym.slice(0, 4) === today.slice(0, 4);
    return (sameYear ? '' : ym.slice(0, 4) + '年') + (+ym.slice(5, 7)) + '月';
  }

  function dayLabel(dateStr, today) {
    var sameYear = dateStr.slice(0, 4) === today.slice(0, 4);
    return (sameYear ? '' : dateStr.slice(0, 4) + '年') + (+dateStr.slice(5, 7)) + '月' + (+dateStr.slice(8, 10)) + '日';
  }

  function categoryNameOf(categoryId, fallback, categories) {
    if (fallback) { return fallback; }
    for (var i = 0; categories && i < categories.length; i += 1) {
      if (categories[i] && String(categories[i].id) === categoryId) { return String(categories[i].name || ''); }
    }
    return categoryId ? '' : '未分类';
  }

  function isOther(item) {
    return item.categoryId === 'ca_other_expense' || (!item.categoryId && item.type === 'expense');
  }

  function makeFinding(code, severity, title, text, facts, rows) {
    return { code: code, severity: severity, title: title, text: text, facts: facts || [], rows: rows || [] };
  }

  /* ---------------- 取数：与统计口径同一套过滤，外加「不计收支」 ---------------- */

  function collect(transactions, scope, categories) {
    var items = [];
    var list = Array.isArray(transactions) ? transactions : [];
    var s = scope || {};
    var bookId = typeof s.bookId === 'string' ? s.bookId : '';
    var hasBooks = s.hasBooks === true;
    var archived = s.archived || {};
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || tx.deleted === true) { continue; }
      var txBook = typeof tx.bookId === 'string' ? tx.bookId : '';
      if (bookId) {
        if (txBook !== bookId) { continue; }
      } else if (hasBooks && archived[txBook] === true) {
        continue;
      }
      if (tx.type !== 'expense' && tx.type !== 'income') { continue; }
      var amount = Math.round(Number(tx.amountCents));
      if (!(amount > 0)) { continue; }
      if (tx.excludeStats === true) { continue; }
      if (!validDate(tx.date)) { continue; }
      var categoryId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
      items.push({
        id: String(tx.id == null ? 'i' + i : tx.id),
        tx: tx,
        date: tx.date,
        day: dayNum(tx.date),
        month: monthOf(tx.date),
        time: typeof tx.time === 'string' ? tx.time : '',
        type: tx.type,
        amountCents: amount,
        categoryId: categoryId,
        categoryName: categoryNameOf(categoryId, typeof tx.categoryName === 'string' ? tx.categoryName : '', categories),
        accountId: typeof tx.accountId === 'string' ? tx.accountId : '',
        note: typeof tx.note === 'string' ? tx.note.trim() : ''
      });
    }
    items.sort(function (a, b) { return a.day - b.day || String(a.id).localeCompare(String(b.id)); });
    return items;
  }

  /* ---------------- 固定开销：同额同分类 → 规律链 ---------------- */

  function cadenceOf(interval) {
    for (var i = 0; i < CADENCES.length; i += 1) {
      if (interval >= CADENCES[i].min && interval <= CADENCES[i].max) { return CADENCES[i]; }
    }
    return null;
  }

  /* gap 是否约等于 m 的整数倍（2~3）：允许「漏记一到两期」把链桥接过去；
     跨得再远就不接——半年没出现的同额账单，不该硬说成同一条周期 */
  function bridgeFactor(gap, m, tolerance) {
    for (var k = 2; k <= 3; k += 1) {
      if (Math.abs(gap - k * m) <= tolerance * k + 1) { return k; }
    }
    return 0;
  }

  function refineInterval(days) {
    /* 先用首尾估周期，再取「非桥接间隔」的中位数，迭代两轮即稳定 */
    var m = days.length > 1 ? days[1] - days[0] : 0;
    var gaps = [];
    var i;
    for (i = 1; i < days.length; i += 1) { gaps.push(days[i] - days[i - 1]); }
    for (var round = 0; round < 2; round += 1) {
      var tolerance = Math.max(3, Math.round(m * RULES.BRIDGE_TOLERANCE));
      var regular = [];
      for (i = 0; i < gaps.length; i += 1) {
        if (Math.abs(gaps[i] - m) <= tolerance) { regular.push(gaps[i]); }
      }
      if (regular.length) { m = Math.round(median(regular)); }
    }
    return { interval: m, gaps: gaps };
  }

  function buildChains(days) {
    var chains = [];
    var start = 0;
    while (start < days.length) {
      var m = days.length - start > 1 ? days[start + 1] - days[start] : 0;
      var bridges = 0;
      var end = start + 1;
      while (end < days.length) {
        var gap = days[end] - days[end - 1];
        var tolerance = Math.max(3, Math.round(m * RULES.BRIDGE_TOLERANCE));
        if (Math.abs(gap - m) <= tolerance) {
          /* 正常下一期 */
        } else if (bridgeFactor(gap, m, tolerance)) {
          bridges += 1;
        } else {
          break;
        }
        end += 1;
      }
      chains.push({ days: days.slice(start, end), bridges: bridges });
      start = end;
    }
    return chains;
  }

  /* 月度账单应落在相近的「几号」；周/双周账单应是同一个星期几 */
  function shapeMatches(chain, cadence) {
    var days = chain.days;
    if (cadence.key === 'monthly' || cadence.key === 'quarterly') {
      var doms = [];
      for (var i = 0; i < days.length; i += 1) { doms.push(+fromDate(days[i]).slice(8, 10)); }
      var mid = median(doms);
      for (var j = 0; j < doms.length; j += 1) {
        if (Math.abs(doms[j] - mid) > RULES.MONTHLY_DOM_SPREAD) { return false; }
      }
      return true;
    }
    if (cadence.key === 'weekly' || cadence.key === 'biweekly') {
      var weekday = days[0] % 7;
      for (var k = 1; k < days.length; k += 1) {
        if (Math.abs(days[k] % 7 - weekday) > 1) { return false; }
      }
      return true;
    }
    return true;
  }

  function nextDateOf(lastDate, cadence) {
    if (cadence.key === 'weekly') { return fromDate(dayNum(lastDate) + 7); }
    if (cadence.key === 'biweekly') { return fromDate(dayNum(lastDate) + 14); }
    if (cadence.key === 'quarterly') { return addMonths(lastDate, 3); }
    if (cadence.key === 'yearly') { return addMonths(lastDate, 12); }
    return addMonths(lastDate, 1);
  }

  /* 分类月均笔数 ≥ HIGH_FREQ_PER_MONTH：高频分类里同额同分类撞出规律太容易 */
  function categoryFrequency(items, today) {
    var counts = {};
    var total = 0;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].type !== 'expense') { continue; }
      counts[items[i].categoryId] = (counts[items[i].categoryId] || 0) + 1;
      total += 1;
    }
    var months = 1;
    if (total) {
      var from = +items[0].date.slice(0, 4) * 12 + (+items[0].date.slice(5, 7));
      var to = +today.slice(0, 4) * 12 + (+today.slice(5, 7));
      months = Math.max(1, to - from + 1);
    }
    var avg = {};
    Object.keys(counts).forEach(function (key) { avg[key] = counts[key] / months; });
    return avg;
  }

  function detectRecurring(items, today) {
    var freq = categoryFrequency(items, today);
    function isHighFrequencyCategory(categoryId) { return (freq[categoryId] || 0) >= RULES.HIGH_FREQ_PER_MONTH; }
    var groups = {};
    var order = [];
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      if (it.type !== 'expense' || it.amountCents < RULES.MIN_FIXED_CENTS) { continue; }
      var key = it.amountCents + '|' + it.categoryId;
      if (!groups[key]) { groups[key] = { amountCents: it.amountCents, categoryId: it.categoryId, byDay: {}, days: [], sample: it }; order.push(key); }
      var g = groups[key];
      if (!g.byDay[it.day]) { g.byDay[it.day] = it; g.days.push(it.day); }
    }
    var todayNum = dayNum(today);
    var out = [];
    for (var o = 0; o < order.length; o += 1) {
      var grp = groups[order[o]];
      var chains = buildChains(grp.days);
      for (var c = 0; c < chains.length; c += 1) {
        var chain = chains[c];
        if (chain.days.length < 3) { continue; }
        var refined = refineInterval(chain.days);
        var cadence = cadenceOf(refined.interval);
        if (!cadence || chain.days.length < cadence.minCount) { continue; }
        /* 高频分类（餐饮、交通）里同额撞出规律太容易：至少 5 期才算 */
        if (isHighFrequencyCategory(grp.sample.categoryId) && chain.days.length < RULES.HIGH_FREQ_MIN_COUNT) { continue; }
        if (chain.bridges > Math.floor(chain.days.length * RULES.MAX_BRIDGE_RATIO)) { continue; }
        if (!shapeMatches(chain, cadence)) { continue; }
        /* 链还短时，要求这个「金额+分类」本来就不常出现：链上天数 / 该组全部天数 ≥ 60% */
        if (chain.days.length < 6 && chain.days.length / grp.days.length < RULES.MIN_CHAIN_EXCLUSIVITY) { continue; }
        var first = grp.byDay[chain.days[0]];
        var last = grp.byDay[chain.days[chain.days.length - 1]];
        var next = nextDateOf(last.date, cadence);
        /* 预计日已过去一个完整周期还没记 → 视为停掉，不计入「每月固定开销」 */
        var stale = dayNum(next) < todayNum - refined.interval;
        var name = last.categoryName || first.categoryName;
        out.push({
          amountCents: grp.amountCents,
          categoryId: grp.categoryId,
          categoryName: name,
          note: last.note || first.note || '',
          cadence: cadence.key,
          cadenceLabel: cadence.label,
          count: chain.days.length,
          bridges: chain.bridges,
          firstDate: first.date,
          lastDate: last.date,
          nextDate: next,
          stale: stale,
          monthlyCents: Math.round(grp.amountCents * cadence.perYear / 12),
          rows: chain.days.map(function (d) { return grp.byDay[d]; })
        });
      }
    }
    out.sort(function (a, b) { return b.monthlyCents - a.monthlyCents || (a.firstDate < b.firstDate ? -1 : 1); });
    return out;
  }

  /* ---------------- 疑似重复 ---------------- */

  function detectDuplicates(items, recurringRows) {
    var groups = {};
    var order = [];
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      if (recurringRows[it.id]) { continue; }
      var key = it.type + '|' + it.amountCents + '|' + it.categoryId;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(it);
    }
    var found = [];
    for (var o = 0; o < order.length; o += 1) {
      var list = groups[order[o]];
      if (isHabitual(list)) { continue; }
      var i2 = 0;
      while (i2 < list.length) {
        var j = i2 + 1;
        while (j < list.length && list[j].day - list[i2].day <= RULES.DUP_SPAN_DAYS) { j += 1; }
        if (j - i2 >= 2) {
          var cluster = list.slice(i2, j);
          var level = gradeCluster(cluster);
          if (level) {
            found.push({ rows: cluster, level: level, extraCents: cluster[0].amountCents * (cluster.length - 1) });
          }
        }
        i2 = j - 1 > i2 ? j - 1 : i2 + 1;
      }
    }
    return found;
  }

  /* 「一天两顿 ¥15」是习惯不是重复：该「金额+分类」在 ≥5 天出现过，
     且 ≥40% 的那天本身就有 ≥2 笔 → 整组不报。宁可漏报，不拿日常消费刷屏。 */
  function isHabitual(list) {
    var perDay = {};
    var days = 0;
    var multiDays = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (!perDay[list[i].day]) { perDay[list[i].day] = 0; days += 1; }
      perDay[list[i].day] += 1;
      if (perDay[list[i].day] === 2) { multiDays += 1; }
    }
    return days >= RULES.DUP_HABIT_MIN_DAYS && multiDays / days >= RULES.DUP_HABIT_RATE;
  }

  function minutesOf(time) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time || ''));
    if (!m) { return NaN; }
    return (+m[1]) * 60 + (+m[2]) + (+m[3] || 0) / 60;
  }

  /* 一组同额同分类的候选，按证据定级；返回 '' 表示不算重复。
     有记录时间：相隔 ≤ DUP_SAME_MINUTE_GAP 分钟 → high（多半是记了两遍）；
                 隔了几小时 → 不算（午饭 10:11 和晚饭 17:06 不是重复）。
     没有记录时间（没填时间的老数据 / 账单导入）：备注相同且非空 → mid；
                 否则同日 → low；隔日且没有相同备注 → 不算。 */
  function gradeCluster(cluster) {
    var minutes = [];
    for (var i = 0; i < cluster.length; i += 1) {
      var value = minutesOf(cluster[i].time);
      if (isNaN(value)) { minutes = null; break; }
      minutes.push(value);
    }
    if (minutes) {
      var span = Math.max.apply(null, minutes) - Math.min.apply(null, minutes);
      return span <= RULES.DUP_SAME_MINUTE_GAP ? 'high' : '';
    }
    var sameNote = cluster[0].note !== '';
    for (var k = 1; sameNote && k < cluster.length; k += 1) {
      if (cluster[k].note !== cluster[0].note) { sameNote = false; }
    }
    if (sameNote) { return 'mid'; }
    return cluster[cluster.length - 1].day === cluster[0].day ? 'low' : '';
  }

  function dupFinding(found, today) {
    var rank = { high: 0, mid: 1, low: 2 };
    if (!found.length) { return null; }
    found.sort(function (a, b) { return rank[a.level] - rank[b.level] || a.rows[0].day - b.rows[0].day; });
    var groups = found.slice(0, RULES.DUP_MAX_GROUPS);
    var extra = 0;
    var rows = [];
    var facts = [];
    for (var i = 0; i < found.length; i += 1) { extra += found[i].extraCents; }
    for (var g = 0; g < groups.length; g += 1) {
      var head = groups[g].rows[0];
      facts.push(dayLabel(head.date, today) + ' ' + (head.categoryName || '未分类') + ' ' + fmtCents(head.amountCents) + ' ×' + groups[g].rows.length);
      rows = rows.concat(groups[g].rows);
    }
    if (found.length > groups.length) { facts.push('另有 ' + (found.length - groups.length) + ' 组未列出'); }
    var level = found[0].level;
    var text = level === 'high'
      ? '同一分钟出现了两笔，多半是记了两遍。'
      : (level === 'mid' ? '同一备注出现了两笔，可能是重复记录。' : '无法从时间判断，点开核对一下是不是记了两遍。');
    return makeFinding('DUP', level, '发现 ' + found.length + ' 组疑似重复',
      text + (found.length > 1 ? '多出约 ' + fmtCents(extra) + '。' : ''), facts, rows.slice(0, 12));
  }

  /* ---------------- 异常大额（稳健统计：中位数 + MAD） ---------------- */

  function detectOutliers(items, today) {
    var byCat = {};
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      if (it.type !== 'expense') { continue; }
      var key = it.categoryId || '';
      if (!byCat[key]) { byCat[key] = { name: it.categoryName || '未分类', rows: [] }; }
      byCat[key].rows.push(it);
    }
    var hits = [];
    Object.keys(byCat).forEach(function (key) {
      var cat = byCat[key];
      /* 除被检验的那笔外，至少要有 OUTLIER_MIN_COUNT 笔「平时水平」做参照 */
      if (cat.rows.length - 1 < RULES.OUTLIER_MIN_COUNT) { return; }
      var amounts = cat.rows.map(function (r) { return r.amountCents; });
      var med = median(amounts);
      var deviations = amounts.map(function (a) { return Math.abs(a - med); });
      var mad = median(deviations);
      for (var i = 0; i < cat.rows.length; i += 1) {
        var row = cat.rows[i];
        if (!(row.amountCents > med * RULES.OUTLIER_RATIO)) { continue; }
        if (!(row.amountCents - med >= RULES.OUTLIER_MIN_DIFF)) { continue; }
        var z = mad > 0 ? 0.6745 * (row.amountCents - med) / mad : Infinity;
        if (!(z >= RULES.OUTLIER_Z)) { continue; }
        hits.push({ row: row, medianCents: med, ratio: med > 0 ? row.amountCents / med : Infinity });
      }
    });
    hits.sort(function (a, b) { return b.row.amountCents - a.row.amountCents; });
    return hits.slice(0, RULES.OUTLIER_MAX);
  }

  function outlierFinding(hits, today) {
    if (!hits.length) { return null; }
    var facts = [];
    var rows = [];
    for (var i = 0; i < hits.length; i += 1) {
      var h = hits[i];
      facts.push(dayLabel(h.row.date, today) + ' ' + h.row.categoryName + ' ' + fmtCents(h.row.amountCents) +
        '（平时约 ' + fmtCents(h.medianCents) + '，' + Math.round(h.ratio) + ' 倍）');
      rows.push(h.row);
    }
    return makeFinding('OUTLIER', 'low', hits.length + ' 笔明显高于平时的水平',
      '不一定是错，但值得确认金额有没有多输一个零。', facts, rows);
  }

  /* ---------------- 断档月份 / 久未记账 ---------------- */

  function monthBuckets(items) {
    var buckets = {};
    for (var i = 0; i < items.length; i += 1) {
      var b = buckets[items[i].month];
      if (!b) { b = buckets[items[i].month] = { count: 0, expenseCents: 0, cats: {} }; }
      b.count += 1;
      if (items[i].type === 'expense') {
        b.expenseCents += items[i].amountCents;
        var c = items[i].categoryId || '';
        b.cats[c] = (b.cats[c] || 0) + items[i].amountCents;
      }
    }
    return buckets;
  }

  function eachMonth(fromMonth, toMonth, fn) {
    var cursor = fromMonth;
    var guard = 0;
    while (cursor <= toMonth && guard < 600) {
      if (fn(cursor) === false) { return; }
      cursor = addMonths(cursor + '-01', 1).slice(0, 7);
      guard += 1;
    }
  }

  function gapFinding(items, buckets, today) {
    if (!items.length) { return null; }
    var first = items[0].month;
    var lastFull = addMonths(today.slice(0, 7) + '-01', -1).slice(0, 7);
    if (lastFull <= first) { return null; }
    var gaps = [];
    eachMonth(addMonths(first + '-01', 1).slice(0, 7), lastFull, function (ym) {
      var b = buckets[ym];
      if (!b || b.count <= RULES.GAP_MIN_COUNT) { gaps.push(monthLabel(ym, today)); }
      return true;
    });
    if (!gaps.length) { return null; }
    return makeFinding('GAP', gaps.length >= 3 ? 'mid' : 'low',
      '有 ' + gaps.length + ' 个月几乎没记账',
      '这些月的统计会偏低。如果确实没花钱可以忽略。', gaps.slice(0, 8).concat(gaps.length > 8 ? ['…'] : []), []);
  }

  function staleFinding(items, today) {
    if (!items.length) { return null; }
    var silent = dayNum(today) - items[items.length - 1].day;
    if (silent < RULES.STALE_DAYS) { return null; }
    return makeFinding('STALE', silent >= 45 ? 'mid' : 'low', '已经 ' + silent + ' 天没记账',
      '最后一笔是 ' + dayLabel(items[items.length - 1].date, today) + '。', [], []);
  }

  /* ---------------- 分类不清 ---------------- */

  function otherFinding(items, today) {
    var from = addMonths(today.slice(0, 7) + '-01', -2);
    var total = 0;
    var other = 0;
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i];
      if (it.type !== 'expense' || it.date < from) { continue; }
      total += it.amountCents;
      if (isOther(it)) { other += it.amountCents; }
    }
    if (!(total > 0) || other < RULES.OTHER_MIN_CENTS) { return null; }
    var share = other / total;
    if (share < RULES.OTHER_MIN_SHARE) { return null; }
    return makeFinding('OTHER', share >= 0.3 ? 'mid' : 'low', '近 3 个月 ' + Math.round(share * 100) + '% 的支出记在「其他」',
      '共 ' + fmtCents(other) + '。分类不准，预算和解读都会跟着不准。', [], []);
  }

  /* ---------------- 月支出突增 ---------------- */

  function surgeFinding(buckets, today) {
    var lastFull = addMonths(today.slice(0, 7) + '-01', -1).slice(0, 7);
    var prev = addMonths(lastFull + '-01', -1).slice(0, 7);
    var a = buckets[prev];
    var b = buckets[lastFull];
    if (!a || !b) { return null; }
    if (a.count < RULES.SURGE_MIN_COUNT || b.count < RULES.SURGE_MIN_COUNT) { return null; }
    var diff = b.expenseCents - a.expenseCents;
    if (!(diff >= RULES.SURGE_MIN_DIFF) || !(diff >= a.expenseCents * RULES.SURGE_RATIO)) { return null; }
    var movers = [];
    Object.keys(b.cats).forEach(function (key) {
      var delta = b.cats[key] - (a.cats[key] || 0);
      if (delta > 0) { movers.push({ categoryId: key, delta: delta }); }
    });
    movers.sort(function (x, y) { return y.delta - x.delta; });
    return { prev: prev, last: lastFull, diff: diff, pct: diff / a.expenseCents, movers: movers.slice(0, RULES.SURGE_TOP) };
  }

  function nameOfCategory(items, categoryId) {
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].categoryId === categoryId && items[i].categoryName) { return items[i].categoryName; }
    }
    return categoryId ? '' : '未分类';
  }

  /* ---------------- 主流程 ---------------- */

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function run(input) {
    try {
      var o = input || {};
      var today = validDate(o.today) ? o.today : localToday();
      var items = collect(o.transactions, o.scope, o.categories);
      var buckets = monthBuckets(items);

      var recurring = detectRecurring(items, today);
      var recurringIds = {};
      for (var r = 0; r < recurring.length; r += 1) {
        for (var k = 0; k < recurring[r].rows.length; k += 1) { recurringIds[recurring[r].rows[k].id] = true; }
      }
      var dup = detectDuplicates(items, recurringIds);
      var surge = surgeFinding(buckets, today);

      var findings = [
        dupFinding(dup, today),
        staleFinding(items, today),
        gapFinding(items, buckets, today),
        otherFinding(items, today),
        surge ? makeFinding('SURGE', 'mid',
          monthLabel(surge.last, today) + ' 比 ' + monthLabel(surge.prev, today) + ' 多花了 ' + fmtCents(surge.diff),
          '支出增加 ' + Math.round(surge.pct * 100) + '%，主要来自：',
          surge.movers.map(function (m) { return nameOfCategory(items, m.categoryId) + ' +' + fmtCents(m.delta); }), []) : null,
        outlierFinding(detectOutliers(items, today), today)
      ].filter(Boolean);

      findings.sort(function (a, b) { return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; });

      var penalty = 0;
      for (var f = 0; f < findings.length; f += 1) { penalty += SEVERITY_COST[findings[f].severity]; }
      var score = Math.max(0, Math.min(100, 100 - penalty));
      var fixed = 0;
      for (var q = 0; q < recurring.length; q += 1) {
        if (!recurring[q].stale) { fixed += recurring[q].monthlyCents; }
      }
      var expense = 0;
      var income = 0;
      for (var n = 0; n < items.length; n += 1) {
        if (items[n].type === 'expense') { expense += 1; } else { income += 1; }
      }
      return {
        ok: true,
        asOf: today,
        window: items.length ? { from: items[0].date, to: items[items.length - 1].date } : null,
        counts: { expense: expense, income: income },
        score: score,
        grade: score >= 90 ? '很健康' : (score >= 70 ? '有几处可以看看' : '需要留意'),
        fixedMonthlyCents: fixed,
        recurring: recurring,
        findings: findings
      };
    } catch (error) {
      return { ok: false, code: 'E_AUDIT_RUN' };
    }
  }

  Core.audit = Object.freeze({ run: run, RULES: Object.freeze(RULES) });
}(typeof window !== 'undefined' ? window : this));
