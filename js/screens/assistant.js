/* ============================================================================
   小账本 2.0 · js/screens/assistant.js · owner: 助手（T-AS）
   文件：src/js/screens/assistant.js
   路由：#/assistant（聊天屏） / #/assistant/history（撤销历史）
   契约锚点：
     - 写入只经 XZB.app.commit（assistant.execute 内部走它，本屏不碰 store / IndexedDB）；
     - 只读 XZB.app.db()；统计口径全部交给 XZB.core.assistant / XZB.core.stats；
     - 屏幕自带头部（immersive：屏幕自绘头部，路由壳层不再渲染 .app-nav）；
     - 语音是可选增强：浏览器有 SpeechRecognition 才显示麦克风，没有就只留键盘。
   本屏不做的事：不发网络请求、不调大模型、不存聊天记录（只存「待确认草稿」）。
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB;
  if (!XZB || !XZB.screens) { return; }

  var KEY = 'assistant';
  var core = XZB.core || {};
  var dom = (XZB.ui && XZB.ui.dom) || XZB.dom || {};
  var icons = (XZB.ui && XZB.ui.icons) || {};

  function assistant() { return core.assistant || null; }
  function historyApi() { return core.history || null; }
  function datesApi() { return core.dates || null; }
  function moneyApi() { return core.money || null; }

  var MAX_TURNS = 60;
  var QUICK_EXAMPLES = [
    '午饭 35 微信',
    '昨天打车 18 支付宝',
    '工资 8000 招行',
    '这个月餐饮花了多少'
  ];

  var TYPE_TEXT = { expense: '支出', income: '收入', transfer: '转账' };

  /* ============================== 情境上下文（P0-1） ==============================
   * 解读 / 首页预算 / 流水详情带账期、分类、单笔流水跳进来。
   * 账本永远以当前活动账本为准（cxNow 重取），URL 里的任何 book 参数一律不信；
   * 切换账本后 Chip 在下一次 submit 时自动失效。 */
  var contextChip = null;
  var lastPrefilled = '';   /* 上一次预填过的问题：同一深链反复进入不重复占用输入框 */
  var RANGE_LABELS = { month: '', prev: '上月', '3m': '近3个月', '6m': '近6个月' };

  /* ============================== 小工具 ============================== */

  /**
   * 创建节点。dom.el 会把 attrs 里的一切写进 HTML 属性，
   * 所以 on* 事件必须在这里剥掉、改用 addEventListener 绑定
   * （否则 onclick="function () {…}" 会变成非法内联脚本，点击直接抛 SyntaxError）。
   */
  function el(tag, attrs, kids) {
    if (dom.el) {
      var out = dom.el(tag, attrs || {}, kids);
      Object.keys(attrs || {}).forEach(function (key) {
        if (key.indexOf('on') === 0 && key.length > 2 && typeof attrs[key] === 'function') {
          out.removeAttribute(key);
          out.addEventListener(key.slice(2), attrs[key]);
        }
      });
      return out;
    }
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) { return; }
      if (key === 'className') { node.className = value; }
      else if (key === 'text') { node.textContent = value; }
      else if (key === 'html') { return; }
      else if (key.indexOf('on') === 0 && typeof value === 'function') { node.addEventListener(key.slice(2), value); }
      else if (key === 'dataset' && typeof value === 'object') {
        Object.keys(value).forEach(function (k) { node.setAttribute('data-' + k, value[k]); });
      } else { node.setAttribute(key, value === true ? '' : value); }
    });
    append(node, kids);
    return node;
  }

  function append(node, kids) {
    if (!node || !kids) { return node; }
    var list = Array.isArray(kids) ? kids : [kids];
    list.forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) { return; }
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function clear(node) {
    if (!node) { return; }
    if (dom.clear) { dom.clear(node); return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function icon(name, size) {
    if (icons.node) { return icons.node(name, { size: size || 22 }); }
    if (icons.icon) { return icons.icon(name, { size: size || 22 }); }
    var span = el('span', { className: 's-assistant__ico-fallback' });
    return span;
  }

  function money(cents) {
    var m = moneyApi();
    if (m && typeof m.formatCents === 'function') { return m.formatCents(cents); }
    return '¥' + (Number(cents || 0) / 100).toFixed(2);
  }

  function today() {
    var d = datesApi();
    return d && d.todayStr ? d.todayStr() : new Date().toISOString().slice(0, 10);
  }

  function nowTime() {
    var d = datesApi();
    return d && d.nowTime ? d.nowTime() : new Date().toTimeString().slice(0, 5);
  }

  function clockText(iso) {
    var raw = String(iso || '');
    var m = raw.match(/T(\d{2}:\d{2})/);
    if (m) { return m[1]; }
    var d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    return '';
  }

  function stampText(iso) {
    var h = historyApi();
    if (h && typeof h.stampText === 'function') { return h.stampText(iso); }
    return clockText(iso);
  }

  function storageReadonly() {
    var app = XZB.app;
    var st = app && app.state && app.state.storage;
    return !!(st && (st.mode === 'memory' || st.degraded === true && st.mode === 'memory'));
  }

  /* prefs 布尔开关：未设置 = 开（false 才算关） */
  function prefFlag(key) {
    var prefs = XZB.app && XZB.app.prefs;
    var v = null;
    if (prefs && typeof prefs.get === 'function') {
      try { v = prefs.get(key); } catch (error) { v = null; }
    }
    return v !== false;
  }

  /* P0-5 本地使用统计：只写 prefs，不上传；失败静默（绝不影响主流程） */
  function bumpMetric(key) {
    var prefs = XZB.app && XZB.app.prefs;
    if (!prefs || typeof prefs.get !== 'function' || typeof prefs.set !== 'function') { return; }
    var m = null;
    try { m = prefs.get('assistant.metrics'); } catch (error) { m = null; }
    if (!m || typeof m !== 'object') { m = {}; }
    m[key] = (Number(m[key]) || 0) + 1;
    try { prefs.set('assistant.metrics', m); } catch (error) { /* 统计失败不打扰 */ }
  }

  /* 助手上下文：账本 / 账户 / 分类 / 今天：一律从当前库现取，不缓存 */
  function cxNow() {
    var as = assistant();
    var app = XZB.app;
    var db = app && typeof app.db === 'function' ? app.db() : null;
    if (!as || !db) { return null; }
    var cx = as.contextOf({
      db: db,
      bookId: null,
      today: today(),
      nowTime: nowTime(),
      settings: db.settings,
      readonly: storageReadonly()
    });
    /* P0-2 开关随 cx 传入 core-assistant（contextOf 不透传额外字段，这里补上） */
    cx.insightsEnabled = prefFlag('assistant.localInsights');
    return cx;
  }

  /* ============================== 会话状态（内存，不持久化） ============================== */

  var session = {
    turns: [],
    state: null,
    busy: false
  };

  function resetSession() {
    var as = assistant();
    session.turns = [];
    session.state = as && as.initialState ? as.initialState() : null;
    session.busy = false;
  }

  function pushTurn(turn) {
    session.turns.push(turn);
    if (session.turns.length > MAX_TURNS) { session.turns.splice(0, session.turns.length - MAX_TURNS); }
  }

  /* ============================== 渲染：外壳 ============================== */

  var host = null;      /* {root, ctx, log, chipRow, input, send, banner, backBtn} */

  function render(root, ctx) {
    root.textContent = '';
    if (!assistant()) {
      root.appendChild(el('div', { className: 's-assistant s-assistant--broken' }, [
        el('p', { className: 's-assistant__broken-text', text: '助手模块没有加载成功，请重新打开应用。' })
      ]));
      return;
    }
    if (ctx && ctx.sub === 'history') {
      renderHistory(root, ctx);
      return;
    }
    renderChat(root, ctx);
  }

  function renderChat(root, ctx) {
    if (!session.state) { resetSession(); }

    var head = el('header', { className: 's-assistant__head' }, [
      el('button', {
        className: 's-assistant__icon-btn s-assistant__back',
        type: 'button',
        'aria-label': '返回',
        onclick: function () { if (ctx && ctx.back) { ctx.back(); } }
      }, [icon('back', 24)]),
      el('div', { className: 's-assistant__head-mid' }, [
        el('h1', { className: 's-assistant__title', text: '小助手', tabindex: '-1' }),
        el('p', { className: 's-assistant__subtitle', text: '离线运行 · 数据不出手机' })
      ]),
      el('button', {
        className: 's-assistant__icon-btn',
        type: 'button',
        'aria-label': '撤销历史',
        onclick: function () { if (ctx && ctx.go) { ctx.go('#/assistant/history'); } }
      }, [icon('undo', 22)])
    ]);

    var log = el('div', {
      className: 's-assistant__log',
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-label': '对话'
    });

    var banner = el('div', { className: 's-assistant__banner', hidden: true });

    var ctxRow = el('div', { className: 's-assistant__ctxrow', hidden: true, 'aria-label': '当前上下文' });

    var taskRow = el('div', { className: 's-assistant__tasks', hidden: true, 'aria-label': '快捷任务' });

    var chipRow = el('div', { className: 's-assistant__chips', 'aria-label': '快捷示例' });

    var input = el('textarea', {
      className: 's-assistant__input',
      rows: '1',
      placeholder: '说一句：午饭 35 微信',
      'aria-label': '对助手说一句',
      autocomplete: 'off',
      enterkeyhint: 'send'
    });

    var send = el('button', {
      className: 's-assistant__send',
      type: 'submit',
      'aria-label': '发送'
    }, [icon('arrow-up', 20)]);

    var mic = null;
    var voice = makeVoice({
      onText: function (text) {
        if (!text) { toast(ctx, '没听清，再说一次', 'warning'); return; }
        input.value = text;
        autoGrow(input);
        submit(text);
      },
      onUnsupported: function () { toast(ctx, '这台设备不支持语音输入，用键盘吧', 'info'); },
      onError: function () { toast(ctx, '语音识别没成功，用键盘吧', 'warning'); }
    });
    if (voice.available) {
      mic = el('button', {
        className: 's-assistant__mic',
        type: 'button',
        'aria-label': '语音输入',
        'aria-pressed': 'false',
        onclick: function () {
          startVoiceWithConsent(voice, function (on) {
            mic.setAttribute('aria-pressed', on ? 'true' : 'false');
            mic.classList.toggle('is-on', on);
          });
        }
      }, [icon('chat', 20)]);
    }

    var composer = el('form', { className: 's-assistant__composer' }, [
      el('div', { className: 's-assistant__field' }, [input]),
      mic,
      send
    ]);

    var foot = el('div', { className: 's-assistant__foot' }, [
      banner,
      ctxRow,
      taskRow,
      chipRow,
      composer,
      el('p', { className: 's-assistant__privacy', text: '文字解析与账目保存在本机；语音识别由你的浏览器服务处理' })
    ]);

    var shell = el('section', { className: 's-assistant', 'data-assistant-screen': '1' }, [head, log, foot]);
    root.appendChild(shell);

    host = { root: root, ctx: ctx, shell: shell, log: log, chipRow: chipRow, ctxRow: ctxRow, taskRow: taskRow, input: input, send: send, banner: banner, voice: voice };

    /* 情境上下文：每次按当前 hash 参数重建（无参进入 = 无 Chip，不留旧状态） */
    contextChip = readContextParams(ctx, cxNow());
    renderCtxRow();

    /* 空会话：先说一句欢迎 + 示例 */
    if (!session.turns.length) {
      pushTurn({
        who: 'bot',
        reply: {
          kind: 'hint',
          text: '我是小账本助手。说一句话就能记账，也能查账、改账、删账。试试下面这些：'
        }
      });
    }

    /* 「问这笔账」：有 tx 参数就补一张单条流水卡（同一笔只补一次） */
    if (contextChip && contextChip.txId && contextChip.tx) {
      var seenTx = session.turns.some(function (t) {
        return t.who === 'bot' && t.reply && t.reply.kind === 'tx' && t.reply.txId === contextChip.txId;
      });
      if (!seenTx) {
        pushTurn({
          who: 'bot',
          reply: {
            kind: 'tx',
            text: '帮你看这笔账：',
            txId: contextChip.txId,
            tx: contextChip.tx,
            categoryName: contextChip.categoryName
          }
        });
      }
    }

    /* 预填问题：只填空输入框，不自动发送（写操作永远要用户亲口确认）；
     * 同一深链反复进出只预填一次，不反复覆盖用户正在输入的内容 */
    if (contextChip && contextChip.question && !input.value.trim() && contextChip.question !== lastPrefilled) {
      input.value = contextChip.question;
      lastPrefilled = contextChip.question;
      autoGrow(input);
      try { input.focus({ preventScroll: true }); } catch (error) { /* 老浏览器不支持参数 */ }
    }

    paint();
    refreshBanner();
    renderChips();
    autoGrow(input);

    composer.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value;
      if (!text || !text.trim()) { return; }
      input.value = '';
      autoGrow(input);
      submit(text);
    });

    input.addEventListener('input', function () { autoGrow(input); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        var text = input.value;
        if (!text || !text.trim()) { return; }
        input.value = '';
        autoGrow(input);
        submit(text);
      }
    });

    /* 进入时滚到底：第一眼看到最新一条 */
    scrollToEnd(false);
  }

  /* ============================== 情境上下文：解析与渲染 ============================== */

  function monthLabelCN(m) {
    var parts = /^(\d{4})-(\d{2})$/.exec(String(m || ''));
    if (!parts) { return ''; }
    return Number(parts[1]) + '年' + Number(parts[2]) + '月';
  }

  /* 深链参数 → 上下文 Chip。只信账期 / 分类 / 流水 id；非法值一律静默丢弃。
   * 返回 null 表示没有可用上下文（含「只有 q」的情况：只预填，不出 Chip）。 */
  function readContextParams(ctx, cx) {
    var params = (ctx && ctx.params) || {};
    var keys = ['from', 'm', 'r', 'cat', 'tx', 'q'];
    var hasAny = false;
    for (var k = 0; k < keys.length; k += 1) {
      if (params[keys[k]] !== undefined && params[keys[k]] !== '') { hasAny = true; break; }
    }
    if (!hasAny) { return null; }

    var from = String(params.from || '');
    if (['insights', 'home', 'ledger', 'stats'].indexOf(from) < 0) { from = ''; }
    var month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(params.m || '')) ? String(params.m) : '';
    if (month && month > today().slice(0, 7)) { month = ''; } /* 未来账期不认 */
    var rangeKey = String(params.r || '');
    if (['month', 'prev', '3m', '6m'].indexOf(rangeKey) < 0) { rangeKey = 'month'; }

    var chip = {
      from: from,
      month: month,
      rangeKey: rangeKey,
      categoryId: '',
      categoryName: '',
      txId: '',
      tx: null,
      question: String(params.q || '').trim().slice(0, 60),
      bookId: ''
    };

    if (cx) {
      chip.bookId = cx.bookId || '';
      var catId = String(params.cat || '');
      if (catId) {
        var cat = null;
        for (var i = 0; i < (cx.categories || []).length; i += 1) {
          if (cx.categories[i] && cx.categories[i].id === catId) { cat = cx.categories[i]; break; }
        }
        if (cat && cat.hidden !== true) {
          chip.categoryId = cat.id;
          chip.categoryName = String(cat.name || '');
        }
      }
      var txId = String(params.tx || '');
      if (txId) {
        var tx = null;
        var list = (cx.db && cx.db.transactions) || [];
        for (var j = 0; j < list.length; j += 1) {
          if (list[j] && list[j].id === txId && list[j].deleted !== true) { tx = list[j]; break; }
        }
        if (tx && (!tx.bookId || tx.bookId === cx.bookId)) {
          chip.txId = tx.id;
          chip.tx = tx;
          if (!chip.categoryId && tx.categoryId && tx.type !== 'transfer') {
            var tcat = null;
            for (var n = 0; n < (cx.categories || []).length; n += 1) {
              if (cx.categories[n] && cx.categories[n].id === tx.categoryId) { tcat = cx.categories[n]; break; }
            }
            if (tcat) { chip.categoryId = tcat.id; chip.categoryName = String(tcat.name || ''); }
          }
        }
      }
    }

    if (!chip.month && !chip.categoryId && !chip.txId) { return null; }
    return chip;
  }

  function contextChipValid(cx) {
    if (!contextChip) { return false; }
    if (!cx || !cx.bookId) { return false; }
    /* 没有账本锚点的 Chip（数据未就绪时生成）不可信：直接失效重建 */
    if (!contextChip.bookId) { return false; }
    /* 账本换了：旧上下文立即失效，避免跨账本串数据 */
    return contextChip.bookId === cx.bookId;
  }

  function contextChipText(chip) {
    var bits = [];
    if (chip.txId) {
      bits.push('这笔账' + (chip.tx && chip.tx.date ? ' · ' + chip.tx.date : ''));
    } else if (chip.month) {
      var label = monthLabelCN(chip.month);
      if (RANGE_LABELS[chip.rangeKey]) { label += ' · ' + RANGE_LABELS[chip.rangeKey]; }
      bits.push(label);
    }
    if (chip.categoryName) { bits.push(chip.categoryName); }
    return bits.join(' · ');
  }

  function renderCtxRow() {
    if (!host || !host.ctxRow) { return; }
    var row = host.ctxRow;
    clear(row);
    var chip = contextChip;
    if (!chip) { row.hidden = true; return; }
    row.hidden = false;
    row.appendChild(el('span', { className: 's-assistant__ctxchip' }, [
      el('span', { className: 's-assistant__ctxchip-text', text: contextChipText(chip) }),
      el('button', {
        className: 's-assistant__ctxchip-close',
        type: 'button',
        'aria-label': '移除上下文',
        onclick: function () {
          contextChip = null;
          renderCtxRow();
        }
      }, ['\u00d7'])
    ]));
  }

  /* 「问这笔账」单条流水卡：只读展示 + 两个追问 Chip（都走现有查账解析，不新增写路径） */
  function keywordOfNote(note) {
    /* 去掉金额/数字片段后取前几个字做关键词，如「午饭35」→「午饭」 */
    var kw = String(note || '')
      .replace(/[0-9０-９一二两三四五六七八九十百千万.．]+[元块]?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6);
    return kw && kw.length >= 2 ? kw : '';
  }

  function txCard(reply) {
    var tx = reply.tx || {};
    var wrap = el('div', { className: 's-assistant__txcard' });
    wrap.appendChild(el('div', { className: 's-assistant__tr-main' }, [
      el('span', { className: 's-assistant__tr-cat', text: reply.categoryName || TYPE_TEXT[tx.type] || '—' }),
      el('span', {
        className: 's-assistant__tr-amount ' + (tx.type === 'income' ? 'is-income' : 'is-expense'),
        text: (tx.type === 'income' ? '+' : (tx.type === 'transfer' ? '' : '\u2212')) + money(tx.amountCents)
      })
    ]));
    var bits = [String(tx.date || '')];
    if (tx.note) { bits.push(String(tx.note)); }
    wrap.appendChild(el('div', { className: 's-assistant__tr-meta', text: bits.join(' · ') }));

    var opts = [];
    if (tx.type !== 'transfer' && reply.categoryName) {
      opts.push({ label: '这个月「' + reply.categoryName + '」花了多少', value: '这个月' + reply.categoryName + '花了多少' });
    }
    var kw = keywordOfNote(tx.note);
    if (kw) {
      opts.push({ label: '这个月「' + kw + '」相关支出', value: '这个月「' + kw + '」花了多少' });
    }
    if (opts.length) { wrap.appendChild(optionChips(opts)); }
    return wrap;
  }

  /* ============================== 快捷推荐 / 任务入口（P0-3） ============================== */

  var TASK_ENTRIES = [
    { label: '记一笔', kind: 'focus' },
    { label: '查账', kind: 'query' },
    { label: '看趋势', kind: 'trend' },
    { label: '调预算', kind: 'plan' }
  ];

  /* 动态推荐：按上下文/数据出 2-4 条；没有账目时只推记账示例，不出答不了的分析问题 */
  function suggestChips() {
    if (session.turns.length > 3) { return []; }
    var cx = cxNow();
    if (!cx) { return QUICK_EXAMPLES.slice(); }

    var hasData = false;
    var list = (cx.db && cx.db.transactions) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].deleted !== true && (!cx.bookId || list[i].bookId === cx.bookId)) { hasData = true; break; }
    }
    if (!hasData) {
      return [{ label: '记一笔：午饭 35 微信', value: '午饭 35 微信' }, { label: '记一笔：工资 8000 招行', value: '工资 8000 招行' }];
    }

    if (contextChip && contextChip.from === 'insights') {
      var chips = [];
      if (contextChip.rangeKey === '3m') { chips.push('近3个月支出趋势怎么样？'); }
      else if (contextChip.rangeKey === '6m') { chips.push('近6个月支出趋势怎么样？'); }
      else if (contextChip.month) { chips.push(monthLabelCN(contextChip.month) + '支出和上月比差在哪？'); }
      chips.push(contextChip.categoryName ? contextChip.categoryName + '多在哪？' : '这个月消费结构有什么变化？');
      chips.push('最大的三笔是哪些？');
      return chips.slice(0, 4);
    }
    if (contextChip && contextChip.from === 'home') {
      return [{ label: '记一笔', value: '午饭 35 微信' }, '今天花了多少？', '本月预算还能用多少？'];
    }
    return QUICK_EXAMPLES.slice();
  }

  function renderChips() {
    if (!host) { return; }
    var row = host.chipRow;
    clear(row);
    var chips = suggestChips();
    chips.forEach(function (chip) {
      var isObj = chip && typeof chip === 'object';
      var label = isObj ? chip.label : chip;
      var value = isObj ? chip.value : chip;
      row.appendChild(el('button', {
        className: 's-assistant__chip',
        type: 'button',
        onclick: function () {
          if (host && host.input) { host.input.value = ''; }
          submit(value);
        }
      }, [label]));
    });
  }

  /* 空会话的 4 个任务入口；说过一句话后整行收起 */
  function renderTasks() {
    if (!host || !host.taskRow) { return; }
    clear(host.taskRow);
    if (session.turns.length > 1) { host.taskRow.hidden = true; return; }
    host.taskRow.hidden = false;
    TASK_ENTRIES.forEach(function (task) {
      host.taskRow.appendChild(el('button', {
        className: 's-assistant__task',
        type: 'button',
        onclick: function () {
          if (!host || !host.input) { return; }
          if (task.kind === 'focus') {
            host.input.focus();
          } else if (task.kind === 'query') {
            host.input.value = '';
            submit('这个月花了多少？');
          } else if (task.kind === 'trend') {
            host.input.value = '';
            submit('近3个月支出趋势怎么样？');
          } else if (task.kind === 'plan') {
            location.hash = '#/plan';
          }
        }
      }, [task.label]));
    });
  }

  /* ============================== 话语气泡 ============================== */

  function paint() {
    if (!host) { return; }
    clear(host.log);
    session.turns.forEach(function (turn) {
      host.log.appendChild(turn.who === 'user' ? userBubble(turn.text) : botBubble(turn));
    });
    renderTasks();
  }

  function userBubble(text) {
    return el('div', { className: 's-assistant__row s-assistant__row--user' }, [
      el('div', { className: 's-assistant__bubble s-assistant__bubble--user', text: String(text) })
    ]);
  }

  function botBubble(turn) {
    var reply = turn.reply || {};
    var body = el('div', { className: 's-assistant__bubble s-assistant__bubble--bot' + (turn.tone === 'ok' ? ' is-ok' : '') + (turn.tone === 'err' ? ' is-err' : '') });

    if (turn.text) {
      body.appendChild(el('p', { className: 's-assistant__text', text: turn.text }));
    } else if (reply.text) {
      body.appendChild(el('p', { className: 's-assistant__text', text: reply.text }));
    }

    var kind = reply.kind;

    if (kind === 'preview') {
      body.appendChild(previewTable(reply, turn.consumed));
    } else if (kind === 'query') {
      body.appendChild(totalsBlock(reply.totals));
      if (reply.rows && reply.rows.length) { body.appendChild(queryRows(reply.rows)); }
      if (reply.link) { body.appendChild(linkButton(reply.link)); }
    } else if (kind === 'tx') {
      body.appendChild(txCard(reply));
    } else if (kind === 'insight') {
      body.appendChild(insightCard(reply));
    } else if (kind === 'targets') {
      body.appendChild(targetList(reply));
    } else if (kind === 'clarify') {
      body.appendChild(optionChips(reply.options));
    } else if (kind === 'conflict') {
      body.appendChild(optionChips(reply.options));
    } else if (kind === 'hint') {
      body.appendChild(replyOptions(reply));
    } else if (kind === 'confirm-undo') {
      /* 撤销确认：把「要撤销的那一条」摘要摆出来，按钮直接执行逆操作 */
      if (reply.entry) { body.appendChild(undoCard(reply.entry)); }
      if (reply.entry) {
        body.appendChild(el('div', { className: 's-assistant__actions' }, [
          el('button', {
            className: 's-assistant__primary',
            type: 'button',
            onclick: function () { undoEntry(reply.entry); }
          }, ['撤销这笔']),
          el('button', {
            className: 's-assistant__ghost',
            type: 'button',
            onclick: function () { submit('算了'); }
          }, ['算了'])
        ]));
      }
    }

    if (reply.warnings && reply.warnings.length) {
      body.appendChild(el('ul', { className: 's-assistant__warn' }, reply.warnings.map(function (w) {
        return el('li', { text: String(w) });
      })));
    }

    if (kind === 'preview' && reply.plan) {
      if (turn.consumed) {
        body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '已写入，上面的按钮不再重复执行' }));
      } else {
        body.appendChild(previewActions(reply));
      }
    }

    return el('div', { className: 's-assistant__row s-assistant__row--bot' }, [
      el('div', { className: 's-assistant__avatar', 'aria-hidden': 'true' }, [icon('sparkles', 16)]),
      body
    ]);
  }

  function replyOptions(reply) {
    if (!reply.options || !reply.options.length) { return document.createDocumentFragment(); }
    var wrap = el('div', { className: 's-assistant__opts' });
    reply.options.forEach(function (opt) {
      wrap.appendChild(el('button', {
        className: 's-assistant__opt',
        type: 'button',
        onclick: function () { submit(String(opt.value || opt.label)); }
      }, [String(opt.label || opt.value)]));
    });
    return wrap;
  }

  function optionChips(options) {
    if (!options || !options.length) { return document.createDocumentFragment(); }
    var wrap = el('div', { className: 's-assistant__opts' });
    options.forEach(function (opt) {
      var value = opt && typeof opt === 'object' ? String(opt.value) : String(opt);
      var label = opt && typeof opt === 'object' ? String(opt.label || opt.value) : String(opt);
      wrap.appendChild(el('button', {
        className: 's-assistant__opt',
        type: 'button',
        onclick: function () { submit(value); }
      }, [label]));
    });
    return wrap;
  }

  function previewTable(reply, consumed) {
    var rows = reply.rows || [];
    var editable = !!(reply.plan && reply.plan.kind === 'create' && !consumed);
    var wrap = el('div', { className: 's-assistant__table', role: 'table', 'aria-label': '待写入的账目' });
    rows.forEach(function (row, index) {
      var main = el('div', { className: 's-assistant__tr-main' }, [
        el('span', { className: 's-assistant__tr-cat', text: row.categoryText || TYPE_TEXT[row.type] || '—' }),
        el('span', { className: 's-assistant__tr-amount ' + (row.type === 'income' ? 'is-income' : 'is-expense'), text: (row.type === 'income' ? '+' : (row.type === 'transfer' ? '' : '−')) + money(row.amountCents) })
      ]);
      if (editable) {
        main.appendChild(el('button', {
          className: 's-assistant__tr-edit',
          type: 'button',
          'aria-label': '编辑第 ' + (index + 1) + ' 笔',
          onclick: function () { openItemEditor(reply, index, row); }
        }, ['编辑']));
      }
      var metaBits = [row.dateText, row.accountText];
      if (row.type === 'transfer' && row.toAccountText) { metaBits = [row.dateText, row.accountText + ' → ' + row.toAccountText]; }
      if (row.note) { metaBits.push(row.note); }
      var sub = el('div', { className: 's-assistant__tr-meta', text: metaBits.join(' · ') });
      var flags = el('div', { className: 's-assistant__tr-flags' });
      if (row.defaulted && (row.defaulted.account || row.defaulted.category)) {
        flags.appendChild(el('span', { className: 's-assistant__flag', text: '已按默认补全' }));
      }
      if (row.future) { flags.appendChild(el('span', { className: 's-assistant__flag is-warn', text: '未来日期' })); }
      if (row.dup) { flags.appendChild(el('span', { className: 's-assistant__flag is-warn', text: '和已有账目相似' })); }
      if (row.edited) { flags.appendChild(el('span', { className: 's-assistant__flag', text: '已手动修改' })); }
      if ((row.issues || []).length) {
        row.issues.forEach(function (issue) {
          flags.appendChild(el('span', { className: 's-assistant__flag is-warn', text: issue.message || '需要补充' }));
        });
      }
      wrap.appendChild(el('div', { className: 's-assistant__tr' + (row.dup || (row.issues || []).length ? ' is-warn' : '') }, [main, sub, flags.childNodes.length ? flags : null]));
    });
    if (reply.totals && reply.totals.count > 1) {
      var sum = '共 ' + reply.totals.count + ' 笔';
      if (reply.totals.expenseCents) { sum += ' · 支出 ' + money(reply.totals.expenseCents); }
      if (reply.totals.incomeCents) { sum += ' · 收入 ' + money(reply.totals.incomeCents); }
      if (reply.totals.transferCount) { sum += ' · 转账 ' + reply.totals.transferCount + ' 笔'; }
      wrap.appendChild(el('div', { className: 's-assistant__tr s-assistant__tr--sum', text: sum }));
    }
    return wrap;
  }

  function previewActions(reply) {
    var wrap = el('div', { className: 's-assistant__actions' });
    var plan = reply.plan;
    var canConfirm = reply.canConfirm === true;
    var needDup = reply.needDupConfirm === true;
    var count = (reply.rows || []).length;

    wrap.appendChild(el('button', {
      className: 's-assistant__primary',
      type: 'button',
      disabled: canConfirm ? null : 'disabled',
      onclick: function (event) {
        if (!canConfirm) { return; }
        var btn = event.currentTarget;
        if (needDup) {
          confirmSheet(host.ctx, {
            title: '和已有账目相似',
            text: '有 ' + (reply.rows || []).filter(function (r) { return r.dup; }).length + ' 笔看起来和最近记过的重复，仍要记吗？',
            okLabel: '仍要记',
            onOk: function () { doConfirm(plan, { forced: true }); }
          });
          return;
        }
        if (btn) { btn.disabled = true; }
        doConfirm(plan, {});
      }
    }, [reply.needDupConfirm ? '仍要写入' : (count > 1 ? '确认写入 ' + count + ' 笔' : '确认写入')]));

    wrap.appendChild(el('button', {
      className: 's-assistant__ghost',
      type: 'button',
      onclick: function () { submit('取消'); }
    }, ['不用了']));
    return wrap;
  }

  /* ============================== 草稿行内编辑（P0-4） ============================== */

  /* 编辑后重算预览（金额合计 / 重复标记 / 可确认性），并把草稿同步进 prefs */
  function refreshPreviewTurn(reply) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx || !reply || !reply.plan) { return; }
    var view = as.previewRows ? as.previewRows(reply.plan, cx) : null;
    if (!view) { return; }
    reply.rows = view.rows;
    reply.totals = view.totals;
    reply.warnings = view.warnings;
    reply.canConfirm = !view.blocked;
    reply.needDupConfirm = (view.rows || []).some(function (row) { return row.dup; });
    if (as.draft && as.draft.save) { as.draft.save(reply.plan, { note: 'waiting-confirm' }); }
    paint();
    scrollToEnd(false);
  }

  function formRow(label, control) {
    return el('div', { className: 's-assistant__form-row' }, [
      el('span', { className: 's-assistant__form-label', text: label }),
      control
    ]);
  }

  /* 选项列表（分类/账户）：单选，点中切换 is-active */
  function optionList(options, selectedId, onPick) {
    var wrap = el('div', { className: 's-assistant__optwrap', role: 'listbox', 'aria-label': '选项' });
    function paintActive() {
      var kids = wrap.childNodes;
      for (var i = 0; i < kids.length; i += 1) {
        if (kids[i].dataset && kids[i].dataset.id === selectedId) { kids[i].classList.add('is-active'); }
        else { kids[i].classList.remove('is-active'); }
      }
    }
    (options || []).forEach(function (option) {
      var btn = el('button', {
        className: 's-assistant__opt',
        type: 'button',
        role: 'option',
        dataset: { id: option.id },
        onclick: function () {
          selectedId = option.id;
          paintActive();
          if (typeof onPick === 'function') { onPick(option.id); }
        }
      }, [String(option.name || option.id)]);
      wrap.appendChild(btn);
    });
    paintActive();
    return wrap;
  }

  function openItemEditor(reply, index, row) {
    var plan = reply && reply.plan;
    var item = plan && plan.items && plan.items[index];
    var sheetApi = XZB.ui && XZB.ui.sheet;
    var cx = cxNow();
    if (!plan || !item || !sheetApi || typeof sheetApi.open !== 'function' || !cx) { return; }

    var picked = { categoryId: item.categoryId || '', accountId: item.accountId || '' };
    var isTransfer = item.type === 'transfer';

    var amountInput = el('input', {
      className: 's-assistant__form-input', type: 'number', inputmode: 'decimal',
      step: '0.01', min: '0', value: String((Number(item.amountCents) || 0) / 100), 'aria-label': '金额'
    });
    var dateInput = el('input', {
      className: 's-assistant__form-input', type: 'date',
      value: String(item.date || ''), 'aria-label': '日期'
    });
    var noteInput = el('input', {
      className: 's-assistant__form-input', type: 'text', maxlength: '80',
      value: String(item.note || ''), 'aria-label': '备注', placeholder: '可选'
    });

    var catOptions = isTransfer ? [] : (cx.liveCategories || []).filter(function (cat) {
      return cat && (cat.kind || 'expense') === item.type;
    });
    var catList = catOptions.length ? optionList(catOptions, picked.categoryId, function (id) { picked.categoryId = id; }) : null;
    var acctList = optionList(cx.liveAccounts || [], picked.accountId, function (id) { picked.accountId = id; });

    var content = el('div', { className: 's-assistant__form' }, [
      formRow('金额', amountInput),
      catList ? formRow('分类', catList) : null,
      formRow(isTransfer ? '转出账户' : '账户', acctList),
      formRow('日期', dateInput),
      formRow('备注', noteInput)
    ]);

    var actions = [{ label: '取消', kind: 'text' }];
    if ((plan.items || []).length > 1) {
      actions.push({
        label: '删除此笔',
        kind: 'danger',
        onClick: function () {
          var asX = assistant();
          var cxX = cxNow();
          if (!asX || !cxX) { return false; }
          var res = asX.removePlanItem(plan, index, cxX);
          if (!res || !res.ok) {
            toast(host && host.ctx, (res && res.message) || '删不掉这一笔', 'warning');
            return false;
          }
          refreshPreviewTurn(reply);
        }
      });
    }
    actions.push({
      label: '保存',
      kind: 'primary',
      onClick: function () {
        var asX = assistant();
        var cxX = cxNow();
        if (!asX || !cxX) { return false; }
        var patch = {};
        if (amountInput.value !== '') {
          var amt = Number(amountInput.value);
          if (!isFinite(amt) || Math.round(amt * 100) <= 0) {
            toast(host && host.ctx, '金额要大于 0', 'warning');
            return false;
          }
          patch.amountCents = Math.round(amt * 100);
        }
        if (picked.categoryId && picked.categoryId !== item.categoryId) { patch.categoryId = picked.categoryId; }
        if (picked.accountId && picked.accountId !== item.accountId) { patch.accountId = picked.accountId; }
        if (dateInput.value && dateInput.value !== item.date) { patch.date = dateInput.value; }
        if ((noteInput.value || '') !== (item.note || '')) { patch.note = noteInput.value; }
        if (!Object.keys(patch).length) { return; } /* 什么都没改：直接关 */
        var res = asX.updatePlanItem(plan, index, patch, cxX);
        if (!res || !res.ok) {
          toast(host && host.ctx, (res && res.message) || '没保存上', 'warning');
          return false;
        }
        refreshPreviewTurn(reply);
      }
    });

    sheetApi.open({
      title: '编辑第 ' + (index + 1) + ' 笔',
      content: content,
      actions: actions
    });
  }

  function totalsBlock(totals) {
    var wrap = el('div', { className: 's-assistant__totals' });
    if (!totals || !totals.count) {
      wrap.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '这个范围内没有账目' }));
      return wrap;
    }
    var bits = [];
    if (totals.incomeCents) { bits.push({ label: '收入', cents: totals.incomeCents, tone: 'income' }); }
    if (totals.expenseCents) { bits.push({ label: '支出', cents: totals.expenseCents, tone: 'expense' }); }
    if (totals.transferCents) { bits.push({ label: '转账', cents: totals.transferCents, tone: 'transfer' }); }
    bits.forEach(function (bit) {
      wrap.appendChild(el('div', { className: 's-assistant__total' }, [
        el('span', { className: 's-assistant__total-label', text: bit.label }),
        el('span', { className: 's-assistant__total-value is-' + bit.tone, text: money(bit.cents) })
      ]));
    });
    wrap.appendChild(el('div', { className: 's-assistant__total' }, [
      el('span', { className: 's-assistant__total-label', text: '笔数' }),
      el('span', { className: 's-assistant__total-value', text: String(totals.count) })
    ]));
    return wrap;
  }

  function queryRows(rows) {
    var wrap = el('div', { className: 's-assistant__rows' });
    rows.slice(0, 8).forEach(function (row) {
      wrap.appendChild(el('div', { className: 's-assistant__rowitem' }, [
        el('span', { className: 's-assistant__rowitem-date', text: row.dateText || row.date || '' }),
        el('span', { className: 's-assistant__rowitem-note', text: row.note || row.categoryText || '—' }),
        el('span', { className: 's-assistant__rowitem-amount ' + (row.type === 'income' ? 'is-income' : 'is-expense'), text: money(row.amountCents) })
      ]));
    });
    if (rows.length > 8) {
      wrap.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '还有 ' + (rows.length - 8) + ' 笔未列出' }));
    }
    return wrap;
  }

  function targetList(reply) {
    var wrap = el('div', { className: 's-assistant__targets' });
    (reply.matches || []).forEach(function (tx, index) {
      var label = tx.label || [tx.dateText, tx.categoryText || '', money(tx.amountCents)].join(' · ');
      wrap.appendChild(el('button', {
        className: 's-assistant__target',
        type: 'button',
        onclick: function () { submit(tx.id); }
      }, [
        el('span', { className: 's-assistant__target-idx', text: String(index + 1) }),
        el('span', { className: 's-assistant__target-main' }, [
          el('span', { className: 's-assistant__target-label', text: label }),
          el('span', { className: 's-assistant__target-meta', text: [tx.accountText, tx.note].filter(Boolean).join(' · ') })
        ])
      ]));
    });
    return wrap;
  }

  function undoCard(entry) {
    return el('div', { className: 's-assistant__undo-card' }, [
      el('p', { className: 's-assistant__undo-label', text: entry.label || '操作' }),
      el('p', { className: 's-assistant__undo-text', text: entry.summary || ('影响 ' + (entry.count || 0) + ' 笔') }),
      el('p', { className: 's-assistant__undo-time', text: stampText(entry.at) })
    ]);
  }

  function linkButton(hash) {
    return el('div', { className: 's-assistant__actions' }, [
      el('button', {
        className: 's-assistant__ghost',
        type: 'button',
        onclick: function () {
          if (hash) { location.hash = hash; }
        }
      }, ['看明细'])
    ]);
  }

  /* ============================== 洞察答案卡（P0-2） ==============================
   * 结构固定：口径 → 结论 → 指标 → 原因/证据 → 假设 → 操作/追问。
   * 所有数字都是 insight-qa 本地算好后传进来的，这里只渲染、不计算。 */

  function insightMetricsBlock(metrics) {
    if (!metrics || !metrics.length) { return null; }
    var wrap = el('div', { className: 's-assistant__totals' });
    metrics.forEach(function (metric) {
      wrap.appendChild(el('div', { className: 's-assistant__total' }, [
        el('span', { className: 's-assistant__total-label', text: metric.label }),
        el('span', {
          className: 's-assistant__total-value' + (metric.tone ? ' is-' + metric.tone : ''),
          text: metric.value || '—'
        })
      ]));
      if (metric.sub) {
        wrap.appendChild(el('div', { className: 's-assistant__metric-sub', text: metric.sub }));
      }
    });
    return wrap;
  }

  function insightCard(reply) {
    var wrap = el('div', { className: 's-assistant__insight' });

    if (reply.scope) {
      wrap.appendChild(el('p', { className: 's-assistant__insight-scope', text: '口径：' + reply.scope }));
    }

    if (reply.empty) {
      wrap.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: reply.text || '数据不足，没法下结论。' }));
      return wrap;
    }

    var metrics = insightMetricsBlock(reply.metrics);
    if (metrics) { wrap.appendChild(metrics); }

    /* 原因分类（环比卡）：每类一条，金额 + 对比 + 证据流水 */
    if (reply.causes && reply.causes.length) {
      var causeList = el('div', { className: 's-assistant__causes' });
      reply.causes.forEach(function (cause) {
        var head = el('div', { className: 's-assistant__cause-head' }, [
          el('span', { className: 's-assistant__cause-name', text: cause.name }),
          el('span', {
            className: 's-assistant__cause-delta ' + (cause.sign === '\u2212' ? 'is-income' : 'is-expense'),
            text: cause.sign + cause.amountText
          })
        ]);
        if (cause.countText) {
          head.appendChild(el('span', { className: 's-assistant__cause-count', text: cause.countText }));
        }
        causeList.appendChild(head);
        if (cause.evidence && cause.evidence.length) {
          causeList.appendChild(queryRows(cause.evidence));
        }
      });
      wrap.appendChild(causeList);
    }

    /* 证据流水（分类下钻 / 最大的三笔） */
    if (reply.rows && reply.rows.length) {
      wrap.appendChild(queryRows(reply.rows));
    }

    if (reply.assumption) {
      wrap.appendChild(el('p', { className: 's-assistant__assumption', text: reply.assumption }));
    }

    if (reply.links && reply.links.length) {
      var actions = el('div', { className: 's-assistant__actions' });
      reply.links.forEach(function (link) {
        actions.appendChild(el('button', {
          className: 's-assistant__ghost',
          type: 'button',
          onclick: function () { if (link && link.hash) { location.hash = link.hash; } }
        }, [String(link.label || '看明细')]));
      });
      wrap.appendChild(actions);
    }

    if (reply.followUps && reply.followUps.length) {
      wrap.appendChild(optionChips(reply.followUps.map(function (q) { return { label: q, value: q }; })));
    }
    return wrap;
  }

  /* ============================== 提交 / 回复 ============================== */

  function submit(text) {
    if (!host || !text || !String(text).trim()) { return; }
    var raw = String(text).trim();
    if (session.busy) { return; }

    pushTurn({ who: 'user', text: raw });
    paint();
    scrollToEnd(true);

    var cx = cxNow();
    var as = assistant();
    if (!cx) {
      pushTurn({ who: 'bot', text: '数据还没准备好，稍等一下再试', tone: 'err' });
      paint();
      return;
    }

    /* 上下文账本校验：进助手后换过账本，旧 Chip 立即失效（防跨账本串数据） */
    if (contextChip && !contextChipValid(cx)) {
      contextChip = null;
      renderCtxRow();
    }
    /* Chip 快照随对话状态传给 respond（洞察类问题继承账期/分类用） */
    if (session.state) { session.state.contextChip = contextChip || null; }

    var out;
    try {
      out = as.respond(raw, session.state, cx);
    } catch (error) {
      pushTurn({ who: 'bot', text: '我这边出问题了，再试一次或手动记一笔', tone: 'err' });
      paint();
      return;
    }
    session.state = out.state || session.state;
    var reply = out.reply || { kind: 'hint', text: '' };

    /* 本地使用统计（P0-5）：只计数，不记内容 */
    bumpMetric('ask');
    if (reply.kind === 'insight') { bumpMetric('insight'); }
    else if (reply.kind === 'query') { bumpMetric('query'); }
    else if (reply.kind === 'preview') { bumpMetric('draft'); }

    /* 草稿是否需要写进 prefs：只在「待确认」时留，确认/放弃后清掉 */
    if (reply.kind === 'preview' && reply.plan) {
      as.draft.save(reply.plan, { note: 'waiting-confirm' });
    }

    pushTurn({ who: 'bot', reply: reply });
    paint();
    refreshBanner();
    scrollToEnd(true);
    renderChips();
  }

  function markConsumed(plan) {
    var planId = plan && plan.id;
    for (var i = session.turns.length - 1; i >= 0; i -= 1) {
      var turn = session.turns[i];
      if (turn.who === 'bot' && turn.reply && turn.reply.kind === 'preview' && turn.reply.plan) {
        if (!planId || turn.reply.plan.id === planId) { turn.consumed = true; return; }
      }
    }
  }

  function doConfirm(plan, opts) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx) { return; }
    if (session.busy) { return; }
    session.busy = true;
    if (host && host.send) { host.send.disabled = true; }

    var confirmPlan = plan;
    if (opts && opts.forced) {
      confirmPlan = Object.assign({}, plan, { forced: true });
      if (as.fingerprint) {
        confirmPlan.id = as.fingerprint(String(plan.raw || '') + '|dup', cx, nowTime());
        confirmPlan.items = (plan.items || []).map(function (item, index) {
          return Object.assign({}, item, { id: as.idFor(confirmPlan.id, index) });
        });
      }
    }

    as.execute(confirmPlan, cx).then(function (res) {
      session.busy = false;
      if (host && host.send) { host.send.disabled = false; }
      if (!res || !res.ok) {
        pushTurn({ who: 'bot', text: (res && res.message) || '没写成功，请再试一次', tone: 'err' });
        paint();
        scrollToEnd(true);
        return;
      }
      var result = res.result || {};
      bumpMetric('confirm');
      /* 写入成功后：草稿作废、这一屏的确认按钮收掉，否则横幅会一直说「上次还有 N 笔没确认」 */
      if (session.state) { session.state.draft = null; session.state.pending = null; }
      if (as.draft && as.draft.clear) { as.draft.clear(); }
      markConsumed(plan);
      var created = (result.created || []).length;
      var updated = (result.updated || []).length;
      var deleted = (result.deleted || []).length;
      var parts = [];
      if (created) { parts.push('新增 ' + created + ' 笔'); }
      if (updated) { parts.push('修改 ' + updated + ' 笔'); }
      if (deleted) { parts.push('删除 ' + deleted + ' 笔'); }
      var doneText = res.already ? '这几笔之前已经记过了，没有重复入账' : ('搞定，' + (parts.join('、') || '已写入'));
      pushTurn({ who: 'bot', text: doneText, tone: 'ok' });
      /* 俏皮点评：新增入账时，挑第一笔支出/收入补一句 ≤40 字调侃；取不到就静默跳过 */
      if (created && !res.already && XZB.core && XZB.core.quips && plan && plan.items) {
        for (var qi = 0; qi < plan.items.length; qi += 1) {
          var quipText = XZB.core.quips.for(plan.items[qi]);
          if (quipText) { pushTurn({ who: 'bot', text: quipText }); break; }
        }
      }
      paint();
      refreshBanner();
      scrollToEnd(true);
      /* 不弹全局 toast：它固定在底部、会盖住输入框；撤销入口已经在顶部横幅里了。 */
    }, function () {
      session.busy = false;
      if (host && host.send) { host.send.disabled = false; }
      pushTurn({ who: 'bot', text: '写入失败，请再试一次', tone: 'err' });
      paint();
    });
  }

  function undoEntry(entry) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx || !entry) { return; }
    as.undoEntry(entry, cx).then(function (res) {
      var msg = res && res.ok ? '已撤销：' + (entry.summary || entry.label || '') : ((res && res.message) || '撤销失败');
      if (res && res.ok) { bumpMetric('undo'); }
      XZB.ui.toast.show(msg, { type: res && res.ok ? 'success' : 'danger' });
      if (host) { paint(); refreshBanner(); }
    }, function () {
      XZB.ui.toast.show('撤销失败', { type: 'danger' });
    });
  }

  /* ============================== 头部横幅 / 快捷示例 ============================== */

  function refreshBanner() {
    if (!host) { return; }
    var banner = host.banner;
    clear(banner);
    banner.hidden = true;

    if (storageReadonly()) {
      banner.hidden = false;
      append(banner, [
        icon('warning', 18),
        el('span', { className: 's-assistant__banner-text', text: '当前是临时存储模式，写入不会保留。先去「我的」检查存储。' })
      ]);
      return;
    }

    var as = assistant();
    var history = historyApi();
    var last = history && history.list ? (history.list()[0] || null) : null;
    var draft = as && as.draft && as.draft.load ? as.draft.load() : null;
    var onScreen = false;
    if (draft && draft.plan) {
      onScreen = session.turns.some(function (turn) {
        return turn.who === 'bot' && turn.reply && turn.reply.kind === 'preview' &&
          turn.reply.plan && turn.reply.plan.id === draft.plan.id && !turn.consumed;
      });
    }
    if (draft && draft.plan && draft.plan.kind === 'create' && (draft.plan.items || []).length && !onScreen) {
      banner.hidden = false;
      append(banner, [
        icon('clock', 18),
        el('span', { className: 's-assistant__banner-text', text: '上次还有 ' + (draft.plan.items || []).length + ' 笔没确认' }),
        el('button', {
          className: 's-assistant__banner-btn',
          type: 'button',
          onclick: function () {
            var asX = assistant();
            var cxX = cxNow();
            if (!asX || !cxX) { return; }
            var view = asX.previewRows ? asX.previewRows(draft.plan, cxX) : null;
            var rows = view ? view.rows : [];
            pushTurn({
              who: 'bot',
              reply: {
                kind: 'preview',
                text: '接着上次这批，确认后写入',
                rows: rows,
                totals: view ? view.totals : null,
                warnings: view ? view.warnings : [],
                plan: draft.plan,
                canConfirm: view ? !view.blocked : false,
                needDupConfirm: rows.some(function (row) { return row.dup; })
              }
            });
            paint();
            scrollToEnd(true);
          }
        }, ['继续'])
      ]);
      return;
    }

    if (last && !session.busy && session.turns.length > 1) {
      banner.hidden = false;
      append(banner, [
        icon('undo', 18),
        el('span', { className: 's-assistant__banner-text', text: '刚才：' + (last.summary || last.label || '') }),
        el('button', {
          className: 's-assistant__banner-btn',
          type: 'button',
          onclick: function () { undoEntry(last); }
        }, ['撤销'])
      ]);
    }
  }

  /* ============================== 语音（可选增强） ============================== */

  /* P0-5 首次点麦克风先讲清楚：语音识别走浏览器服务，文字与账目仍只存本机。
   * 同意一次后记 prefs，之后不再打扰。 */
  function startVoiceWithConsent(voice, onState) {
    if (prefFlag('assistant.voiceAgreed')) {
      voice.toggle(onState);
      return;
    }
    confirmSheet(host && host.ctx, {
      title: '语音输入说明',
      text: '语音识别由你的浏览器或系统服务处理，可能不是端上完成；识别出的文字和之后的账目数据都只保存在本机，不会上传给小账本。',
      okLabel: '知道了',
      onOk: function () {
        var prefs = XZB.app && XZB.app.prefs;
        if (prefs && typeof prefs.set === 'function') {
          try { prefs.set('assistant.voiceAgreed', true); } catch (error) { /* 存不上就下次再问 */ }
        }
        voice.toggle(onState);
      }
    });
  }

  function makeVoice(handlers) {
    var Ctor = global.SpeechRecognition || global.webkitSpeechRecognition;
    var available = typeof Ctor === 'function';
    var rec = null;
    var running = false;

    if (!available) {
      return {
        available: false,
        toggle: function () { handlers.onUnsupported(); }
      };
    }

    return {
      available: true,
      toggle: function (onState) {
        if (running) {
          try { rec && rec.stop(); } catch (error) { /* 忽略 */ }
          return;
        }
        try {
          rec = new Ctor();
          rec.lang = 'zh-CN';
          rec.interimResults = false;
          rec.maxAlternatives = 1;
          rec.continuous = false;
          rec.onresult = function (event) {
            var text = '';
            if (event.results && event.results[0] && event.results[0][0]) { text = event.results[0][0].transcript || ''; }
            handlers.onText(String(text || '').replace(/[。，,.\s]+$/g, ''));
          };
          rec.onerror = function () { handlers.onError(); };
          rec.onend = function () {
            running = false;
            if (onState) { onState(false); }
          };
          running = true;
          if (onState) { onState(true); }
          rec.start();
        } catch (error) {
          running = false;
          if (onState) { onState(false); }
          handlers.onError();
        }
      }
    };
  }

  /* ============================== 撤销历史屏 ============================== */

  var historyFilter = { range: 'all', source: 'all', amount: 'all' };

  function renderHistory(root, ctx) {
    if (!historyApi()) {
      root.appendChild(el('div', { className: 's-assistant s-assistant--broken' }, [
        el('p', { className: 's-assistant__broken-text', text: '历史模块没有加载成功。' })
      ]));
      return;
    }
    var head = el('header', { className: 's-assistant__head' }, [
      el('button', {
        className: 's-assistant__icon-btn',
        type: 'button',
        'aria-label': '返回助手',
        onclick: function () { if (ctx && ctx.go) { ctx.go('#/assistant'); } }
      }, [icon('back', 24)]),
      el('div', { className: 's-assistant__head-mid' }, [
        el('h1', { className: 's-assistant__title', text: '撤销历史', tabindex: '-1' }),
        el('p', { className: 's-assistant__subtitle', text: '最近 30 条写入 · 可逐条撤销' })
      ]),
      el('button', {
        className: 's-assistant__icon-btn',
        type: 'button',
        'aria-label': '清空历史',
        onclick: function () { clearHistory(ctx); }
      }, [icon('trash', 20)])
    ]);

    var filters = el('div', { className: 's-assistant__filters' });
    var listHost = el('div', { className: 's-assistant__history' });

    var body = el('div', { className: 's-assistant__history-wrap' }, [filters, listHost]);
    root.appendChild(el('section', { className: 's-assistant s-assistant--history', 'data-assistant-history': '1' }, [head, body]));

    paintFilters();
    paintList();

    function paintFilters() {
      clear(filters);
      [
        { key: 'range', label: '时间', values: [['today', '今天'], ['week', '近 7 天'], ['all', '全部']] },
        { key: 'source', label: '来源', values: [['all', '全部'], ['assistant', '助手'], ['manual', '手动']] },
        { key: 'amount', label: '金额', values: [['all', '不限'], ['small', '≤50'], ['mid', '50~500'], ['large', '≥500']] }
      ].forEach(function (group) {
        var row = el('div', { className: 's-assistant__filter-row', role: 'group', 'aria-label': group.label });
        group.values.forEach(function (pair) {
          var active = historyFilter[group.key] === pair[0];
          row.appendChild(el('button', {
            className: 's-assistant__filter' + (active ? ' is-active' : ''),
            type: 'button',
            'aria-pressed': active ? 'true' : 'false',
            onclick: function () {
              historyFilter[group.key] = pair[0];
              paintFilters();
              paintList();
            }
          }, [pair[1]]));
        });
        filters.appendChild(row);
      });
    }

    function currentEntries() {
      var history = historyApi();
      var entries = history.list ? history.list() : [];
      if (history.filter) { entries = history.filter(entries, historyFilter); }
      return entries;
    }

    function paintList() {
      clear(listHost);
      var entries = currentEntries();
      if (!entries.length) {
        listHost.appendChild(el('div', { className: 's-assistant__empty' }, [
          icon('clock', 28),
          el('p', { className: 's-assistant__empty-title', text: '还没有可撤销的记录' }),
          el('p', { className: 's-assistant__empty-text', text: '用助手或手动记一笔后，这里会出现可撤销的操作。' })
        ]));
        return;
      }
      entries.forEach(function (entry) {
        var card = el('div', { className: 's-assistant__hcard' }, [
          el('div', { className: 's-assistant__hcard-top' }, [
            el('span', { className: 's-assistant__hcard-label', text: entry.label || '操作' }),
            el('span', { className: 's-assistant__hcard-time', text: stampText(entry.at) })
          ]),
          el('p', { className: 's-assistant__hcard-summary', text: entry.summary || ('影响 ' + (entry.count || 0) + ' 笔') }),
          el('div', { className: 's-assistant__hcard-actions' }, [
            el('button', {
              className: 's-assistant__hcard-btn',
              type: 'button',
              onclick: function () { confirmUndo(entry); }
            }, ['撤销'])
          ])
        ]);
        listHost.appendChild(card);
      });
    }

    function confirmUndo(entry) {
      confirmSheet(ctx, {
        title: '撤销这次操作？',
        text: (entry.summary || entry.label || '') + '\n撤销会按记录逐条改回；改不回去的条目会被跳过并告诉你。',
        okLabel: '撤销',
        danger: true,
        onOk: function () {
          var as = assistant();
          var cx = cxNow();
          if (!as || !cx) { return; }
          as.undoEntry(entry, cx).then(function (res) {
            if (res && res.ok) {
              XZB.ui.toast.show('已撤销：' + (entry.summary || ''), { type: 'success' });
            } else {
              XZB.ui.toast.show((res && res.message) || '撤销失败', { type: 'danger' });
            }
            paintList();
          }, function () {
            XZB.ui.toast.show('撤销失败', { type: 'danger' });
          });
        }
      });
    }
  }

  function clearHistory(ctx) {
    var history = historyApi();
    if (!history) { return; }
    if (!history.list().length) { toast(ctx, '还没有记录', 'info'); return; }
    confirmSheet(ctx, {
      title: '清空撤销历史？',
      text: '只清空「可撤销的记录」，已经记好的账不受影响。',
      okLabel: '清空',
      danger: true,
      onOk: function () {
        history.clear();
        toast(ctx, '已清空', 'success');
        if (ctx && ctx.refresh) { ctx.refresh(); }
      }
    });
  }

  /* ============================== 通用确认浮层 ============================== */

  function confirmSheet(ctx, opts) {
    var sheet = XZB.ui && XZB.ui.sheet;
    if (!sheet || typeof sheet.open !== 'function') {
      if (global.confirm && global.confirm(opts.title + '\n' + (opts.text || ''))) {
        if (typeof opts.onOk === 'function') { opts.onOk(); }
      }
      return;
    }
    var content = el('div', { className: 's-assistant__confirm' }, [
      el('p', { className: 's-assistant__confirm-text', text: opts.text || '' })
    ]);
    sheet.open({
      title: opts.title || '确认',
      content: content,
      actions: [
        { label: '取消', kind: 'default' },
        {
          label: opts.okLabel || '确定',
          kind: opts.danger ? 'danger' : 'primary',
          closeOnClick: true,
          onClick: function () { if (typeof opts.onOk === 'function') { opts.onOk(); } }
        }
      ]
    });
  }

  function toast(ctx, msg, type) {
    if (XZB.ui && XZB.ui.toast) { XZB.ui.toast.show(msg, { type: type || 'info' }); }
  }

  /* ============================== 收尾 ============================== */

  function autoGrow(input) {
    if (!input || !input.style) { return; }
    input.style.height = 'auto';
    var max = 120;
    var next = Math.min(max, input.scrollHeight || 24);
    input.style.height = next + 'px';
  }

  function scrollToEnd(animated) {
    if (!host || !host.log) { return; }
    var log = host.log;
    try {
      if (log.scrollTo && animated) {
        log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
      } else {
        log.scrollTop = log.scrollHeight;
      }
    } catch (error) {
      try { log.scrollTop = log.scrollHeight; } catch (ignore) { /* 忽略 */ }
    }
  }

  function destroy() {
    if (host && host.voice) { /* 语音不额外收尾 */ }
    host = null;
  }

  XZB.screens.register(KEY, {
    title: '小助手',
    subtitle: '一句话记账',
    immersive: true,
    render: render,
    destroy: function () {
      destroy();
    }
  });

}(window));