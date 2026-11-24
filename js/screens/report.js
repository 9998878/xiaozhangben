/* 小账本 2.40.0 · js/screens/report.js
 * 解读报告：存档列表（#/report）与报告详情（#/report?id=）。
 * 报告是生成时的只读快照（纯数据 payload），详情按快照渲染，不随账单变动；
 * 「重新生成」深链回统计页覆盖当天同账期记录；「删除」只删快照，不动账单。
 * 契约：XZB.screens.register('report', { title, subtitle, render, destroy })
 * 依赖：XZB.core.{dates,money}、XZB.ui.{icons,charts,sheet}、XZB.app.reports
 * 硬规则：不碰 IndexedDB / localStorage；金额一律整数分；存档读写只经 XZB.app.reports。
 */
(function (global) {
  'use strict';

  var XZB = (global.XZB = global.XZB || {});
  var registry = XZB.screens;
  if (!registry || typeof registry.register !== 'function') {
    if (global.console && global.console.warn) {
      global.console.warn('[小账本] report 屏：屏幕注册表未就绪，跳过注册');
    }
    return;
  }

  var Core = XZB.core || XZB.Core || {};
  var dates = Core.dates || null;
  var money = Core.money || null;
  var charts = XZB.ui && XZB.ui.charts ? XZB.ui.charts : null;
  var icons = XZB.ui && XZB.ui.icons ? XZB.ui.icons : null;

  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var RANGE_LABEL = { month: '单月', prev: '单月', '3m': '近 3 个月', '6m': '近 6 个月' };

  var S = {
    root: null,
    ctx: null,
    dead: false,
    id: '',
    record: null,
    list: null,
    loading: false,
    error: ''
  };

  /* ---------------- 小工具 ---------------- */

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    var options = attrs || {};
    Object.keys(options).forEach(function (key) {
      var value = options[key];
      if (value === null || value === undefined) { return; }
      if (key === 'text') { node.textContent = String(value); }
      else if (key === 'className') { node.className = String(value); }
      else if (key === 'dataset') {
        Object.keys(value).forEach(function (name) { node.dataset[name] = String(value[name]); });
      } else { node.setAttribute(key, String(value)); }
    });
    (kids || []).forEach(function (kid) { if (kid) { node.appendChild(kid); } });
    return node;
  }

  function clearNode(node) {
    if (!node) { return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function iconNode(name, size) {
    if (icons && typeof icons.create === 'function') {
      try { return icons.create(name, { size: size || 16 }); } catch (error) { /* 回落 */ }
    }
    return el('span', { className: 's-report-glyph', text: String(name || '').slice(0, 1) });
  }

  function fmt(cents) {
    if (money && typeof money.formatCents === 'function') {
      try { return String(money.formatCents(cents, {})); } catch (error) { /* 回落 */ }
    }
    return '¥' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
  }

  function todayStr() {
    if (dates && typeof dates.todayStr === 'function') { return dates.todayStr(); }
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function monthLabel(month) {
    return MONTH_RE.test(String(month || '')) ? Number(month.slice(0, 4)) + '年' + Number(month.slice(5, 7)) + '月' : String(month || '');
  }

  function rangeLabel(key) { return RANGE_LABEL[key] || '单月'; }

  function shortMonth(key) {
    return MONTH_RE.test(String(key || '')) ? Number(key.slice(5, 7)) + '月' : String(key || '');
  }

  function trendLabel(label, granularity) {
    if (granularity === 'month') { return shortMonth(label); }
    var parts = String(label || '').split('-');
    return parts.length === 3 ? Number(parts[2]) + '日' : String(label || '');
  }

  function clockText(ms) {
    var d = new Date(Number(ms) || 0);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function reportsApi() {
    var app = XZB.app;
    return app && app.reports && typeof app.reports.list === 'function' ? app.reports : null;
  }

  function sheetApi() {
    return XZB.ui && XZB.ui.sheet ? XZB.ui.sheet : null;
  }

  function goHash(hash) {
    var router = XZB.router;
    if (router && typeof router.setHash === 'function') { router.setHash(hash); return; }
    global.location.hash = hash;
  }

  function moduleCard(title, sub, className) {
    var card = el('section', { className: 'c-card s-insights-mod' + (className ? ' ' + className : '') });
    var head = el('div', { className: 'c-card__head s-insights-mod__head' });
    var titles = el('div', { className: 's-insights-mod__titles' });
    titles.appendChild(el('h2', { className: 'c-card__title s-insights-mod__title', text: title }));
    if (sub) { titles.appendChild(el('p', { className: 's-insights-mod__sub', text: sub })); }
    head.appendChild(titles);
    card.appendChild(head);
    return card;
  }

  /* ---------------- 存档列表 ---------------- */

  function listView() {
    var wrap = el('div', { className: 's-report' });
    var card = moduleCard('报告存档', '每日解读快照 · 点按查看', 's-report-listcard');
    if (S.loading) {
      card.appendChild(el('p', { className: 's-insights-ai__hint', 'aria-live': 'polite', text: '正在读取报告存档…' }));
      wrap.appendChild(card);
      return wrap;
    }
    var list = S.list || [];
    if (!list.length) {
      card.appendChild(el('p', { className: 's-insights-muted', text: '还没有报告。到统计页点「生成解读」，报告会自动存档在这里。' }));
      card.appendChild(el('a', { className: 'c-btn c-btn--primary s-report__go', href: '#/stats', text: '去统计页生成' }));
      wrap.appendChild(card);
      return wrap;
    }
    var box = el('div', { className: 's-report-list', role: 'list' });
    for (var i = 0; i < list.length; i += 1) {
      (function (rec) {
        var p = rec.payload || {};
        var row = el('a', {
          className: 's-report-row c-pressable',
          href: '#/report?id=' + encodeURIComponent(rec.id),
          role: 'listitem',
          'aria-label': monthLabel(rec.month) + rangeLabel(rec.rangeKey) + '报告，' + rec.generatedOn + '生成'
        });
        var main = el('span', { className: 's-report-row__main' });
        main.appendChild(el('span', { className: 's-report-row__title', text: monthLabel(rec.month) + ' · ' + rangeLabel(rec.rangeKey) }));
        var meta = rec.generatedOn + ' · ' + (rec.source === 'ai' ? 'AI 解读' : '本地解读');
        if (rec.source === 'ai' && rec.model) { meta += ' · ' + rec.model; }
        main.appendChild(el('span', { className: 's-report-row__meta', text: meta }));
        row.appendChild(main);
        row.appendChild(el('span', { className: 's-report-row__amt u-tabular', text: fmt(p.totals ? p.totals.expenseCents : 0) }));
        row.appendChild(iconNode('chevron-right', 16));
        box.appendChild(row);
      }(list[i]));
    }
    card.appendChild(box);
    wrap.appendChild(card);
    wrap.appendChild(el('p', { className: 's-insights-foot', text: '报告是生成时的快照，不随账单变动；最多保留 100 份，超出自动淘汰最旧。' }));
    return wrap;
  }

  /* ---------------- 报告详情 ---------------- */

  function sumCell(label, cents, tone) {
    var cell = el('div', { className: 's-insights-sum__cell' });
    cell.appendChild(el('span', { className: 's-insights-sum__label', text: label }));
    var value = el('span', { className: 's-insights-sum__value u-tabular' });
    value.appendChild(el('span', { className: 's-insights-sum__money' + (tone ? ' s-insights-sum__money--' + tone : ''), text: fmt(cents) }));
    cell.appendChild(value);
    return cell;
  }

  function aiLevelClass(level) {
    if (level === 'red') { return ' is-red'; }
    if (level === 'orange' || level === 'yellow') { return ' is-warn'; }
    return '';
  }

  function detailView(rec) {
    var p = rec.payload || {};
    var wrap = el('div', { className: 's-report' });

    var head = moduleCard(monthLabel(p.month || rec.month) + '解读报告', rangeLabel(p.rangeKey || rec.rangeKey), 's-report-head');
    var meta = '生成于 ' + rec.generatedOn + ' ' + clockText(rec.generatedAt) + ' · ' + (rec.source === 'ai' ? 'AI 解读' : '本地解读');
    if (rec.source === 'ai' && rec.model) { meta += ' · ' + rec.model; }
    head.appendChild(el('p', { className: 's-insights-ai__hint', text: meta }));
    wrap.appendChild(head);

    /* 核心结论 */
    if (Array.isArray(p.core) && p.core.length) {
      var core = el('section', { className: 'c-card s-insights-core' });
      var coreList = el('ul', { className: 's-insights-core__list' });
      p.core.forEach(function (c) {
        var li = el('li', { className: 's-insights-core__item' });
        li.appendChild(iconNode(c.icon || 'sparkles', 18));
        li.appendChild(el('span', { text: c.text }));
        coreList.appendChild(li);
      });
      core.appendChild(coreList);
      wrap.appendChild(core);
    }

    /* 收支摘要 */
    if (p.totals) {
      var sum = moduleCard('收支摘要', null, 's-insights-summary');
      var net = Number(p.netCents) || 0;
      var hero = el('div', { className: 's-insights-sum__hero' });
      hero.appendChild(el('span', { className: 's-insights-sum__hero-label', text: '结余' }));
      hero.appendChild(el('strong', { className: 's-insights-sum__hero-value u-tabular' + (net < 0 ? ' is-neg' : ''), text: fmt(net) }));
      hero.appendChild(el('span', { className: 's-insights-sum__hero-sub', text: net < 0 ? '支出高于收入' : '收入减去支出' }));
      sum.appendChild(hero);
      var grid = el('div', { className: 's-insights-sum__grid' });
      grid.appendChild(sumCell('收入', p.totals.incomeCents, 'income'));
      grid.appendChild(sumCell('支出', p.totals.expenseCents, 'expense'));
      var mom = el('div', { className: 's-insights-sum__cell' });
      mom.appendChild(el('span', { className: 's-insights-sum__label', text: p.isPartial ? '支出较上月同期' : '支出环比' }));
      var momValue = el('span', { className: 's-insights-sum__value' });
      var m = p.mom || {};
      if (!m.hasPrev) {
        momValue.appendChild(el('span', { className: 's-insights-muted', text: '暂无上期数据' }));
      } else if (m.isNew) {
        momValue.appendChild(el('span', { className: 's-insights-sum__new', text: '新增支出' }));
      } else if (m.pct === null || m.pct === undefined) {
        momValue.appendChild(el('span', { className: 's-insights-muted', text: '—' }));
      } else {
        var pct = Number(m.pct) || 0;
        momValue.appendChild(el('span', {
          className: 's-insights-sum__delta' + (m.diff > 0 ? ' is-up' : (m.diff < 0 ? ' is-down' : '')),
          text: (pct > 0 ? '+' : '') + pct.toFixed(1) + '%'
        }));
      }
      mom.appendChild(momValue);
      grid.appendChild(mom);
      grid.appendChild(sumCell('日均支出', p.dailyAvgCents));
      sum.appendChild(grid);
      sum.appendChild(el('p', { className: 's-insights-note', text: '笔数 ' + (p.totals.count || 0) + ' 条，仅统计当前账本；转账不计入收支。' }));
      wrap.appendChild(sum);
    }

    /* 消费结构（环图＋清单，清单可跳回统计页钻取） */
    if (Array.isArray(p.cats) && p.cats.length) {
      var structure = moduleCard('消费结构', null, 's-insights-structure');
      var body = el('div', { className: 's-insights-structure__body' });
      var chartHost = el('div', { className: 's-insights-donut__chart' });
      var chartBox = el('div', { className: 's-insights-donut' });
      chartBox.appendChild(chartHost);
      body.appendChild(chartBox);
      var legend = el('div', { className: 's-insights-legend', role: 'group', 'aria-label': '支出分类构成' });
      p.cats.forEach(function (c) {
        var row = el(c.id === '__other' ? 'span' : 'a', {
          className: 's-insights-legend__row',
          href: c.id === '__other' ? null : '#/stats?m=' + encodeURIComponent(p.month || rec.month) + '&r=month&cat=' + encodeURIComponent(c.id)
        });
        var dot = el('span', { className: 's-insights-legend__dot', 'aria-hidden': 'true' });
        dot.style.background = 'var(' + (c.colorVar || '--c-text-3') + ')';
        row.appendChild(dot);
        var main = el('span', { className: 's-insights-legend__main' });
        main.appendChild(el('span', { className: 's-insights-legend__name', text: c.name }));
        main.appendChild(el('span', { className: 's-insights-legend__meta u-tabular', text: fmt(c.amountCents) + ' · ' + (Number(c.pct) || 0).toFixed(1) + '%' }));
        row.appendChild(main);
        row.appendChild(el('span', { className: 's-insights-legend__count', text: String(c.count || 0) + ' 笔' }));
        legend.appendChild(row);
      });
      body.appendChild(legend);
      structure.appendChild(body);
      wrap.appendChild(structure);
      try {
        if (charts && typeof charts.donut === 'function') {
          charts.donut(chartHost, p.cats.map(function (c) {
            return { label: c.name, amountCents: c.amountCents, color: c.colorVar || '--c-text-3' };
          }), { height: 196, thickness: 22, centerSub: '总支出', ariaLabel: '支出分类构成快照' });
        }
      } catch (error) { /* 图失败不影响其余快照内容 */ }
    }

    /* 收支趋势（快照折线） */
    if (p.trend && Array.isArray(p.trend.labels) && p.trend.labels.length) {
      var trendCard = moduleCard('收支趋势', '生成时的近 12 月窗口', 's-report-trend');
      var box = el('div', { className: 's-stats-trend__box' });
      trendCard.appendChild(box);
      wrap.appendChild(trendCard);
      try {
        if (charts && typeof charts.line === 'function') {
          var labels = p.trend.labels.map(function (l) { return trendLabel(l, p.trend.granularity); });
          var series = (p.trend.series || []).map(function (s) {
            return { key: s.key, name: s.name, values: s.values || [], color: s.key === 'income' ? '--c-text-2' : '--c-tint' };
          });
          charts.line(box, series, {
            labels: labels,
            width: box.clientWidth || 320,
            height: 180,
            showGrid: false,
            showDots: labels.length <= 12,
            emptyText: '这段时间还没有数据',
            ariaLabel: '收支趋势快照'
          });
        }
      } catch (error) { /* 同上 */ }
    }

    /* AI / 本地解读 */
    if (p.ai && (p.ai.summary || (Array.isArray(p.ai.items) && p.ai.items.length))) {
      var aiCard = moduleCard(p.ai.source === 'ai' ? 'AI 解读' : '本地解读', null, 's-insights-ai');
      var aiBody = el('div', { className: 's-insights-ai__body' });
      if (p.ai.summary) {
        aiBody.appendChild(el('p', { className: 's-insights-ai__summary', text: p.ai.summary }));
      }
      if (Array.isArray(p.ai.items) && p.ai.items.length) {
        var list = el('ul', { className: 's-insights-ai__list' });
        p.ai.items.forEach(function (item) {
          var li = el('li', { className: 's-insights-ai__item' + aiLevelClass(item.level) });
          li.appendChild(el('p', {
            className: 's-insights-ai__title',
            text: item.category ? '【' + item.category + '】' + item.title : item.title
          }));
          var ev = Array.isArray(item.evidence) ? item.evidence : [];
          if (ev.length) {
            var facts = el('ul', { className: 's-insights-ai__facts' });
            ev.forEach(function (f) { facts.appendChild(el('li', { text: f })); });
            li.appendChild(facts);
          }
          if (item.suggestion) {
            li.appendChild(el('p', { className: 's-insights-ai__suggestion', text: item.suggestion }));
          }
          list.appendChild(li);
        });
        aiBody.appendChild(list);
      }
      aiCard.appendChild(aiBody);
      wrap.appendChild(aiCard);
    }

    /* 值得留意 */
    if (Array.isArray(p.tips) && p.tips.length) {
      var tips = moduleCard('值得留意', null, 's-insights-tips');
      var tipList = el('div', { className: 's-insights-tips__list' });
      p.tips.forEach(function (t) {
        var item = el('div', { className: 's-insights-tip' + (t.tone === 'warn' ? ' s-insights-tip--warn' : '') });
        item.appendChild(iconNode(t.icon || 'flag', 18));
        var main = el('div', { className: 's-insights-tip__main' });
        main.appendChild(el('p', { className: 's-insights-tip__title', text: t.title }));
        main.appendChild(el('p', { className: 's-insights-tip__text', text: t.text }));
        item.appendChild(main);
        tipList.appendChild(item);
      });
      tips.appendChild(tipList);
      wrap.appendChild(tips);
    }

    /* 账单体检 */
    if (p.audit) {
      var audit = moduleCard('账单体检', '评分 ' + p.audit.score + ' · ' + p.audit.grade, 's-report-audit');
      if (p.audit.fixedMonthlyCents > 0) {
        audit.appendChild(el('p', { className: 's-insights-note', text: '每月固定开销约 ' + fmt(p.audit.fixedMonthlyCents) }));
      }
      (p.audit.findings || []).forEach(function (f) {
        audit.appendChild(el('p', { className: 's-insights-tip__text', text: f.title + '：' + f.text }));
      });
      wrap.appendChild(audit);
    }

    /* 行动建议（快照里的深链） */
    if (Array.isArray(p.actions) && p.actions.length) {
      var actions = moduleCard('行动建议', null, 's-insights-actions');
      var actList = el('div', { className: 's-insights-actions__list' });
      p.actions.forEach(function (a) {
        actList.appendChild(el('a', { className: 's-insights-action c-pressable', href: a.href }, [
          iconNode(a.icon || 'arrow-right', 16),
          el('span', { text: a.label })
        ]));
      });
      actions.appendChild(actList);
      wrap.appendChild(actions);
    }

    wrap.appendChild(el('p', {
      className: 's-insights-foot',
      text: '报告是 ' + rec.generatedOn + ' 生成时的快照，不随账单变动；如需最新结论，请重新生成。'
    }));

    /* 底部操作：重新生成（仅今天的报告）＋删除 */
    var ops = el('div', { className: 's-report-ops' });
    if (rec.generatedOn === todayStr()) {
      ops.appendChild(el('a', {
        className: 'c-btn c-btn--primary s-report__go',
        href: '#/stats?m=' + encodeURIComponent(rec.month) + '&r=' + encodeURIComponent(rec.rangeKey) + '&regen=1',
        text: '重新生成'
      }));
    }
    var delBtn = el('button', { className: 'c-btn s-report__del', type: 'button', text: '删除此报告' });
    delBtn.addEventListener('click', function () { confirmDelete(rec); });
    ops.appendChild(delBtn);
    wrap.appendChild(ops);
    return wrap;
  }

  function confirmDelete(rec) {
    var sheet = sheetApi();
    if (!sheet || typeof sheet.open !== 'function') { return; }
    var body = el('div', { className: 's-insights-sheet' });
    body.appendChild(el('p', {
      className: 's-insights-sheet__sum',
      text: '删除 ' + monthLabel(rec.month) + ' 的这份报告快照？账单数据不受影响，之后仍可重新生成。'
    }));
    var handle = sheet.open({
      title: '删除报告',
      content: body,
      ariaLabel: '确认删除报告',
      actions: [{ label: '取消', kind: 'text' }]
    });
    var row = el('div', { className: 's-report-delrow' });
    var cancel = el('button', { className: 'c-btn', type: 'button', text: '取消' });
    cancel.addEventListener('click', function () { if (handle && handle.close) { handle.close(); } });
    var ok = el('button', { className: 'c-btn s-report__del', type: 'button', text: '删除' });
    ok.addEventListener('click', function () {
      var api = reportsApi();
      if (!api) { return; }
      api.remove(rec.id).then(function () {
        if (handle && handle.close) { handle.close(); }
        if (!S.dead) { goHash('#/report'); }
      });
    });
    row.appendChild(cancel);
    row.appendChild(ok);
    body.appendChild(row);
  }

  /* ---------------- 渲染 ---------------- */

  function paint() {
    if (S.dead || !S.root) { return; }
    clearNode(S.root);
    if (S.id) {
      if (S.loading) {
        S.root.appendChild(el('p', { className: 's-insights-ai__hint', 'aria-live': 'polite', text: '正在读取报告…' }));
        return;
      }
      if (!S.record) {
        var miss = moduleCard('报告不存在', null, 's-report-miss');
        miss.appendChild(el('p', { className: 's-insights-muted', text: '这份报告可能已被删除，或存档已淘汰最旧记录。' }));
        miss.appendChild(el('a', { className: 'c-btn c-btn--primary s-report__go', href: '#/report', text: '返回报告存档' }));
        S.root.appendChild(miss);
        return;
      }
      S.root.appendChild(detailView(S.record));
      return;
    }
    S.root.appendChild(listView());
  }

  function load() {
    var api = reportsApi();
    if (!api) {
      S.loading = false;
      S.list = [];
      S.record = null;
      paint();
      return;
    }
    S.loading = true;
    paint();
    if (S.id) {
      api.get(S.id).then(function (rec) {
        S.loading = false;
        if (S.dead) { return; }
        S.record = rec || null;
        paint();
      }, function () {
        S.loading = false;
        if (!S.dead) { S.record = null; paint(); }
      });
      return;
    }
    api.list().then(function (list) {
      S.loading = false;
      if (S.dead) { return; }
      S.list = Array.isArray(list) ? list.slice().sort(function (a, b) {
        return Number(b.generatedAt) - Number(a.generatedAt);
      }) : [];
      paint();
    }, function () {
      S.loading = false;
      if (!S.dead) { S.list = []; paint(); }
    });
  }

  function render(root, ctx) {
    if (!root) { return; }
    S.root = root;
    S.ctx = ctx || null;
    S.dead = false;
    S.record = null;
    S.list = null;
    S.error = '';
    var query = (ctx && ctx.query) || {};
    S.id = query.id ? String(query.id) : '';
    load();
    return { destroy: destroy };
  }

  function destroy() {
    S.dead = true;
    S.root = null;
    S.ctx = null;
    S.record = null;
    S.list = null;
  }

  var screen = {
    title: '报告',
    subtitle: '解读存档',
    render: render,
    destroy: destroy
  };

  XZB.screens.register('report', screen);
}(window));