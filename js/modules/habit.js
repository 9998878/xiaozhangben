/* 小账本 2.0 · js/modules/habit.js —— 习惯记账建议（2.28.10）
 * 来源：竞品吸收批次二 B，算法吸收自开源借章 jiezhang 的 statement-suggestion.ts
 * （28 天历史 + 每天一票 + 环形分钟窗），纯本地计算、零网络、零 AI 成本。
 *
 * 公开（XZB.Core.habit）：
 *   suggestHabits(db, prefs, now) → 最多 1 条候选 | null
 *     - 窗口：now 前 28 天；按 type:categoryId 分组，只看 expense
 *     - 每天同组只投一票（防同日批量记录伪装习惯）；票数 ≥3 天才成候选
 *     - 触发窗：当前分钟与该组任一历史发生分钟的环形距离 ≤90（正确处理跨午夜）
 *     - 今天已记该分类不提示；不计收支（excludeStats）的账不参与
 *     - 输出带最近一笔的 amountCents/accountId/note/bookId（预填用）
 *   dismiss(prefs, suggestion, now) → 写忽略表 prefs.habitDismiss[key] = 忽略至日期（7 天）
 *
 * 纯函数：不写库、不改入参、不发请求；建议是锦上添花，任何内部异常都返回 null 不抛错。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var Core = XZB.Core || (XZB.Core = {});

  var WINDOW_DAYS = 28;      /* 习惯观察窗（天） */
  var MIN_DAYS = 3;          /* 至少多少个不同的天才算习惯 */
  var TRIGGER_MINUTES = 90;  /* 当前时刻与历史时刻的环形分钟距离阈值 */
  var DISMISS_DAYS = 7;      /* 「忽略」后多少天内不再提示 */
  var DISMISS_KEY = 'habitDismiss';

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDaysStr(dateStr, n) {
    var d = new Date(String(dateStr) + 'T00:00:00');
    if (isNaN(d.getTime())) { return ''; }
    d.setDate(d.getDate() + n);
    return dayKey(d);
  }

  function minutesOfTime(t) {
    var parts = String(t || '').split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (!isFinite(h) || !isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) { return -1; }
    return h * 60 + m;
  }

  /* 环形分钟距离：|a-b| 与绕过午夜的距离取小（23:50 vs 00:30 = 40 分钟） */
  function circularDiff(a, b) {
    var d = Math.abs(a - b) % 1440;
    return d > 720 ? 1440 - d : d;
  }

  function readDismissed(prefs) {
    var raw = prefs && typeof prefs.get === 'function' ? prefs.get(DISMISS_KEY, null) : null;
    return raw && typeof raw === 'object' ? raw : {};
  }

  /* 鸭子类型判定 Date（vm 跨 realm 的 instanceof 会失真，Node 自检依赖这一点） */
  function asDate(value) {
    if (value && typeof value.getTime === 'function') { return value; }
    return value == null ? new Date() : new Date(value);
  }

  function suggestHabits(db, prefs, now) {
    try {
      var txs = db && Array.isArray(db.transactions) ? db.transactions : [];
      var nowDate = asDate(now);
      var today = dayKey(nowDate);
      var cutoff = addDaysStr(today, -(WINDOW_DAYS - 1));
      var nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
      var dismissed = readDismissed(prefs);

      var groups = Object.create(null);
      for (var i = 0; i < txs.length; i++) {
        var tx = txs[i];
        if (!tx || tx.deleted === true) { continue; }
        if (tx.type !== 'expense') { continue; }
        if (tx.excludeStats === true) { continue; }   /* 不计收支的账不参与习惯统计 */
        var catId = typeof tx.categoryId === 'string' ? tx.categoryId : '';
        if (!catId) { continue; }
        var date = typeof tx.date === 'string' ? tx.date : '';
        if (!date || date < cutoff || date > today) { continue; }
        var mins = minutesOfTime(tx.time);
        if (mins < 0) { continue; }
        var key = 'expense:' + catId;
        var g = groups[key];
        if (!g) {
          g = groups[key] = { key: key, categoryId: catId, days: {}, minutes: [], latest: null };
        }
        if (!g.days[date]) {
          g.days[date] = true;    /* 每天只投一票：同日多笔不加权 */
          g.minutes.push(mins);
        }
        if (!g.latest || date > g.latest.date ||
            (date === g.latest.date && String(tx.time || '') > String(g.latest.time || ''))) {
          g.latest = tx;
        }
      }

      var candidates = [];
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        var votes = Object.keys(g.days).length;
        if (votes < MIN_DAYS) { return; }
        var hit = false;
        for (var j = 0; j < g.minutes.length; j++) {
          if (circularDiff(nowMinutes, g.minutes[j]) <= TRIGGER_MINUTES) { hit = true; break; }
        }
        if (!hit) { return; }
        var latest = g.latest || {};
        if (latest.date === today) { return; }            /* 今天已记，不提示 */
        var until = dismissed[g.key];
        if (typeof until === 'string' && until >= today) { return; }  /* 忽略期内 */
        candidates.push({
          key: g.key,
          type: 'expense',
          categoryId: g.categoryId,
          amountCents: Math.round(Number(latest.amountCents) || 0),
          accountId: typeof latest.accountId === 'string' ? latest.accountId : '',
          note: typeof latest.note === 'string' ? latest.note : '',
          bookId: typeof latest.bookId === 'string' ? latest.bookId : '',
          lastDate: latest.date,
          votes: votes
        });
      });

      if (!candidates.length) { return null; }
      candidates.sort(function (a, b) {
        if (a.lastDate !== b.lastDate) { return a.lastDate < b.lastDate ? 1 : -1; }
        return a.votes < b.votes ? 1 : (a.votes > b.votes ? -1 : 0);
      });
      return candidates[0];
    } catch (error) {
      return null;
    }
  }

  function dismiss(prefs, suggestion, now) {
    try {
      if (!prefs || typeof prefs.set !== 'function' || !suggestion || !suggestion.key) { return; }
      var nowDate = asDate(now);
      var all = readDismissed(prefs);
      all[suggestion.key] = addDaysStr(dayKey(nowDate), DISMISS_DAYS);
      prefs.set(DISMISS_KEY, all);
    } catch (error) {
      /* 忽略失败不影响页面 */
    }
  }

  Core.habit = Object.freeze({
    suggestHabits: suggestHabits,
    dismiss: dismiss,
    WINDOW_DAYS: WINDOW_DAYS,
    MIN_DAYS: MIN_DAYS,
    TRIGGER_MINUTES: TRIGGER_MINUTES,
    DISMISS_DAYS: DISMISS_DAYS
  });
}(typeof window !== 'undefined' ? window : this));
