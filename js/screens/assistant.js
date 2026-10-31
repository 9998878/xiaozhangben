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

  /* 助手上下文：账本 / 账户 / 分类 / 今天：一律从当前库现取，不缓存 */
  function cxNow() {
    var as = assistant();
    var app = XZB.app;
    var db = app && typeof app.db === 'function' ? app.db() : null;
    if (!as || !db) { return null; }
    return as.contextOf({
      db: db,
      bookId: null,
      today: today(),
      nowTime: nowTime(),
      settings: db.settings,
      readonly: storageReadonly()
    });
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
          voice.toggle(function (on) { mic.setAttribute('aria-pressed', on ? 'true' : 'false'); mic.classList.toggle('is-on', on); });
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
      chipRow,
      composer,
      el('p', { className: 's-assistant__privacy', text: '全部在本地解析与保存，不上传任何内容' })
    ]);

    var shell = el('section', { className: 's-assistant', 'data-assistant-screen': '1' }, [head, log, foot]);
    root.appendChild(shell);

    host = { root: root, ctx: ctx, shell: shell, log: log, chipRow: chipRow, input: input, send: send, banner: banner, voice: voice };

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

  /* ============================== 话语气泡 ============================== */

  function paint() {
    if (!host) { return; }
    clear(host.log);
    session.turns.forEach(function (turn) {
      host.log.appendChild(turn.who === 'user' ? userBubble(turn.text) : botBubble(turn));
    });
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
      body.appendChild(previewTable(reply));
    } else if (kind === 'query') {
      body.appendChild(totalsBlock(reply.totals));
      if (reply.rows && reply.rows.length) { body.appendChild(queryRows(reply.rows)); }
      if (reply.link) { body.appendChild(linkButton(reply.link)); }
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

  function previewTable(reply) {
    var rows = reply.rows || [];
    var wrap = el('div', { className: 's-assistant__table', role: 'table', 'aria-label': '待写入的账目' });
    rows.forEach(function (row) {
      var main = el('div', { className: 's-assistant__tr-main' }, [
        el('span', { className: 's-assistant__tr-cat', text: row.categoryText || TYPE_TEXT[row.type] || '—' }),
        el('span', { className: 's-assistant__tr-amount ' + (row.type === 'income' ? 'is-income' : 'is-expense'), text: (row.type === 'income' ? '+' : (row.type === 'transfer' ? '' : '−')) + money(row.amountCents) })
      ]);
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

  function renderChips() {
    if (!host) { return; }
    var row = host.chipRow;
    clear(row);
    if (session.turns.length > 3) { return; }
    QUICK_EXAMPLES.forEach(function (text) {
      row.appendChild(el('button', {
        className: 's-assistant__chip',
        type: 'button',
        onclick: function () {
          if (host && host.input) { host.input.value = ''; }
          submit(text);
        }
      }, [text]));
    });
  }

  /* ============================== 语音（可选增强） ============================== */

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