/* ============================================================================
   小账本 2.0 · js/screens/assistant.js · owner: 助手（T-AS）
   文件：src/js/screens/assistant.js
   路由：#/assistant（聊天屏） / #/assistant/history（撤销历史）
   契约锚点：
     - 写入只经 XZB.app.commit（assistant.execute 内部走它，本屏不碰 store / IndexedDB）；
     - 只读 XZB.app.db()；统计口径全部交给 XZB.core.assistant / XZB.core.stats；
     - 联网解析只经 XZB.core.assistant.respondRemote（本屏不发 fetch、不碰密钥）；
       默认仍是本地规则引擎，联网要用户在「我的 › 小助手与联网」里打开并先看到告知；
     - 屏幕自带头部（immersive：屏幕自绘头部，路由壳层不再渲染 .app-nav）；
     - 语音是可选增强：浏览器有 SpeechRecognition 才显示麦克风，没有就只留键盘。
   本屏不存聊天记录（只存「待确认草稿」）。
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

  /* 顶栏副标题：不写「数据不出手机」这类做不到的承诺，只写事实 */
  var SUBTITLE_IDLE = '离线可用 · 联网时由你配置的模型解析';
  var SUBTITLE_LOCAL = '本地模式';

  /* 首次联网告知（R-11）：两句事实，必须原样出现，不做营销化改写 */
  var NOTICE_HEAD = '联网解析前先跟你说清楚：';
  var NOTICE_BODY = '会把你说的话与账户名称发给你配置的模型服务';
  var NOTICE_DETAIL = '每次只发送这一句话、账户名称、分类名和统计口径，不发账目明细。';
  var NOTICE_TAIL = '可在「我的」里关闭（小助手与联网）';
  var NOTICE_ASK = '现在要联网解析这一句吗？';

  var UNDO_MS = 8000;
  var TYPING_DELAY = 200;

  /* 回落原因 → 一行短说明（A27/D-08：不得静默切换） */
  var REASON_TEXT = {
    timeout: '网络超时，已改用本地解析',
    rate: '服务繁忙（限流），已改用本地解析',
    config: '未启用在线模型，当前用本地解析',
    disabled: '未启用在线模型，当前用本地解析',
    privacy: '已配置在线模型：先同意隐私告知再联网',
    bad: '返回内容无法识别，已改用本地解析',
    offline: '当前没有网络，已改用本地解析',
    none: ''
  };

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

  /* ============================== 联网配置（只读消费，不写配置） ============================== */

  function configNow() {
    var as = assistant();
    var llm = as && as.llm;
    if (!llm || typeof llm.getConfig !== 'function') { return null; }
    var out = null;
    try { out = llm.getConfig(); } catch (error) { return null; }
    if (!out) { return null; }
    var cfg = out.cfg || out;
    return cfg && typeof cfg === 'object' ? cfg : null;
  }

  function hasCredentials(cfg) {
    return !!(cfg && cfg.baseURL && cfg.model && (cfg.hasKey === true || !!cfg.key));
  }

  function readyNow() {
    var as = assistant();
    var llm = as && as.llm;
    if (!llm || typeof llm.ready !== 'function') { return false; }
    try { return llm.ready() === true; } catch (error) { return false; }
  }

  function noticeGiven(cfg) {
    return !!(cfg && Number(cfg.noticeAt) > 0);
  }

  /* 该不该在这一次提交前先弹告知卡：只有「用户真的填好了模型、并且打开了开关」才问 */
  function shouldNotice(cfg) {
    if (session.noticeDeclined) { return false; }
    if (!cfg) { return false; }
    if (cfg.enabled !== true) { return false; }
    if (!hasCredentials(cfg)) { return false; }
    return !noticeGiven(cfg);
  }

  /* 本地解析的原因：填好了但没开 / 填好了没同意 → 需要一行说明，否则安静本地 */
  function localReason(cfg) {
    if (!cfg) { return 'none'; }
    if (!hasCredentials(cfg)) { return 'none'; }
    if (cfg.enabled !== true) { return 'disabled'; }
    return 'none';
  }

  /* ============================== 会话状态（内存，不持久化） ============================== */

  var session = {
    turns: [],
    state: 'idle',        /* idle | parsing | writing —— 屏内相位 */
    core: null,           /* core.assistant 的解析态（原 session.state） */
    busy: false,
    mode: 'local',        /* local | online | fallback */
    reason: '',
    token: 0,
    queue: [],
    typing: null,
    timers: [],
    noticeDeclined: false,
    undoEntry: null,
    undoUntil: 0
  };

  function clearTimers() {
    (session.timers || []).forEach(function (id) { clearTimeout(id); });
    session.timers = [];
  }

  function later(fn, ms) {
    var id = setTimeout(fn, ms);
    session.timers.push(id);
    return id;
  }

  function resetSession() {
    var as = assistant();
    clearTimers();
    session.turns = [];
    session.core = as && as.initialState ? as.initialState() : null;
    session.busy = false;
    session.state = 'idle';
    session.typing = null;
    session.queue = [];
    session.token += 1;
    hideUndoBar();
  }

  function pushTurn(turn) {
    session.turns.push(turn);
    if (session.turns.length > MAX_TURNS) { session.turns.splice(0, session.turns.length - MAX_TURNS); }
  }

  /* ============================== 渲染：外壳 ============================== */

  var host = null;      /* {root, ctx, shell, log, chipRow, input, send, banner, voice, capsule, subText, undoBar} */

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
    if (!session.core) { resetSession(); }

    var capsule = el('span', { className: 's-assistant__flag s-assistant__capsule s-assistant__capsule--local', text: '本地' });
    var subText = document.createTextNode(' ' + SUBTITLE_IDLE);

    var head = el('header', { className: 's-assistant__head' }, [
      el('button', {
        className: 's-assistant__icon-btn s-assistant__back',
        type: 'button',
        'aria-label': '返回',
        onclick: function () { if (ctx && ctx.back) { ctx.back(); } }
      }, [icon('back', 24)]),
      el('div', { className: 's-assistant__head-mid' }, [
        el('h1', { className: 's-assistant__title', text: '小助手', tabindex: '-1' }),
        el('p', { className: 's-assistant__subtitle' }, [capsule, subText])
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

    var undoBar = el('div', { className: 's-assistant__undo-bar', hidden: true, role: 'status', 'aria-label': '刚才的写入可撤销' });

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
      undoBar,
      banner,
      chipRow,
      composer,
      el('p', { className: 's-assistant__privacy', text: '本地解析优先 · 联网需你在设置里开启' })
    ]);

    var shell = el('section', { className: 's-assistant', 'data-assistant-screen': '1' }, [head, log, foot]);
    root.appendChild(shell);

    host = {
      root: root,
      ctx: ctx,
      shell: shell,
      log: log,
      chipRow: chipRow,
      input: input,
      send: send,
      banner: banner,
      undoBar: undoBar,
      capsule: capsule,
      subText: subText,
      voice: voice
    };

    /* 空会话：先说一句欢迎 + 2 条可点示例（点了只填进输入框，不替用户发） */
    if (!session.turns.length) {
      pushTurn({
        who: 'bot',
        reply: {
          kind: 'hint',
          text: '我是小账本助手。说一句话就能记账，也能查账、改账、删账。试试下面这些：',
          examples: QUICK_EXAMPLES.slice(0, 3)
        }
      });
    }
    setMode(session.mode, session.reason);
    paint();
    refreshBanner();
    renderChips();
    autoGrow(input);

    /* 情境入口（2.25.0 合并 2.24.3）：从首页/解读页带 ?q= 进来时预填问题，不替用户发 */
    if (ctx && ctx.params && ctx.params.q && !input.value.trim()) {
      input.value = String(ctx.params.q).slice(0, 60);
      autoGrow(input);
    }

    composer.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = input.value;
      if (!text || !text.trim()) { return; }
      submit(text);
    });

    input.addEventListener('input', function () { autoGrow(input); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        var text = input.value;
        if (!text || !text.trim()) { return; }
        submit(text);
      }
    });

    /* 进入时滚到底：第一眼看到最新一条 */
    scrollToEnd(false);
  }

  /* ============================== 模式胶囊 / 副标题（A27：不得静默） ============================== */

  function setMode(mode, reason) {
    session.mode = mode || 'local';
    session.reason = reason || '';
    if (!host) { return; }
    var cls = 's-assistant__flag s-assistant__capsule ';
    var label = '本地';
    if (mode === 'online') {
      cls += 's-assistant__capsule--remote';
      label = '在线';
    } else if (mode === 'fallback') {
      cls += 's-assistant__capsule--fallback';
      label = '本地（已回落）';
    } else {
      cls += 's-assistant__capsule--local';
      label = '本地';
    }
    if (host.capsule) {
      host.capsule.className = cls;
      host.capsule.textContent = label;
    }
    if (host.subText) {
      host.subText.nodeValue = ' ' + (mode === 'fallback' ? SUBTITLE_LOCAL : SUBTITLE_IDLE);
    }
  }

  /* ============================== 话语气泡 ============================== */

  function paint() {
    if (!host) { return; }
    clear(host.log);
    session.turns.forEach(function (turn) {
      host.log.appendChild(turn.who === 'user' ? userBubble(turn.text) : botBubble(turn));
    });
    if (session.typing) { host.log.appendChild(typingRow()); }
  }

  function typingRow() {
    var typing = session.typing || {};
    var body = el('div', { className: 's-assistant__bubble s-assistant__bubble--bot' }, [
      el('p', { className: 's-assistant__text s-assistant__text--dim', text: typing.label || '正在解析…' })
    ]);
    if (typing.soft) {
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '正在用本地模式…' }));
    }
    return el('div', { className: 's-assistant__row s-assistant__row--bot', 'aria-live': 'polite' }, [
      el('div', { className: 's-assistant__avatar', 'aria-hidden': 'true' }, [icon('sparkles', 16)]),
      body
    ]);
  }

  function userBubble(text) {
    return el('div', { className: 's-assistant__row s-assistant__row--user' }, [
      el('div', { className: 's-assistant__bubble s-assistant__bubble--user', text: String(text) })
    ]);
  }

  function botBubble(turn) {
    var reply = turn.reply || {};
    var body = el('div', { className: 's-assistant__bubble s-assistant__bubble--bot' + (turn.tone === 'ok' ? ' is-ok' : '') + (turn.tone === 'err' ? ' is-err' : '') });

    /* 首次联网告知卡（A28/R-11）：就地展开，不跳页、不弹全局层 */
    if (turn.notice) {
      return el('div', { className: 's-assistant__row s-assistant__row--bot' }, [
        el('div', { className: 's-assistant__avatar', 'aria-hidden': 'true' }, [icon('sparkles', 16)]),
        noticeCard(turn)
      ]);
    }

    var kind = reply.kind;

    if (turn.text) {
      body.appendChild(el('p', { className: 's-assistant__text', text: turn.text }));
    } else if (reply.text && kind !== 'preview') {
      body.appendChild(el('p', { className: 's-assistant__text', text: reply.text }));
    }

    if (kind === 'preview') {
      body.appendChild(previewHeadline(reply));
      body.appendChild(previewTable(reply));
    } else if (kind === 'query') {
      body.appendChild(totalsBlock(reply.totals));
      if (reply.rows && reply.rows.length) { body.appendChild(queryRows(reply.rows)); }
      if (reply.link) { body.appendChild(linkButton(reply.link)); }
    } else if (kind === 'insight') {
      /* 2.25.0（合并 2.24.3）：本地洞察答案卡 —— 口径/结论/指标/原因/证据/假设/操作 */
      body.appendChild(insightCard(reply));
    } else if (kind === 'targets') {
      body.appendChild(targetList(reply));
    } else if (kind === 'clarify') {
      body.appendChild(optionChips(reply.options));
    } else if (kind === 'conflict') {
      body.appendChild(optionChips(reply.options));
    } else if (kind === 'hint') {
      body.appendChild(replyOptions(reply));
      if (reply.examples && reply.examples.length) { body.appendChild(exampleList(reply.examples)); }
    } else if (kind === 'confirm-undo') {
      /* 撤销确认：把「要撤销的那一条」摘要摆出来，按钮直接执行逆操作 */
      if (reply.entry) { body.appendChild(undoCard(reply.entry)); }
      if (reply.entry) {
        body.appendChild(el('div', { className: 's-assistant__actions' }, [
          el('button', {
            className: 's-assistant__primary',
            type: 'button',
            'aria-label': '撤销这一笔',
            onclick: function () { undoEntry(reply.entry); }
          }, ['撤销这笔']),
          el('button', {
            className: 's-assistant__ghost',
            type: 'button',
            'aria-label': '不撤销了',
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
      } else if (turn.dismissed) {
        body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '已放弃这次预览，改好后再发。' }));
      } else {
        body.appendChild(previewActions(reply, turn));
      }
    }

    /* 模式说明：回落必须说清原因（A27），纯本地与在线都不打扰 */
    var reasonLine = '';
    if (turn.mode === 'fallback') {
      reasonLine = REASON_TEXT[turn.reason] || '在线解析没有成功，已改用本地解析';
    } else if (turn.mode === 'local' && (turn.reason === 'disabled' || turn.reason === 'config' || turn.reason === 'privacy')) {
      reasonLine = REASON_TEXT[turn.reason] || '未启用在线模型，当前用本地解析';
    }
    if (reasonLine) {
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: reasonLine }));
      /* privacy（已配置未告知）：一行说明 + 一键去设置，闭环迭代3 的分码（2.26.9 迭代4） */
      if (turn.reason === 'privacy') {
        var privacyJump = el('div', { className: 's-assistant__opts' });
        privacyJump.appendChild(el('button', {
          className: 's-assistant__opt', type: 'button',
          'aria-label': '去设置：同意隐私告知',
          onclick: function () { gotoSettings(); }
        }, ['去设置']));
        body.appendChild(privacyJump);
      }
    }

    if (turn.mode === 'fallback') {
      body.appendChild(failureActions(turn));
    } else if (reasonLine) {
      body.appendChild(el('div', { className: 's-assistant__actions' }, [
        el('button', {
          className: 's-assistant__ghost',
          type: 'button',
          'aria-label': '去设置里开启联网解析',
          onclick: function () { gotoSettings(); }
        }, ['去设置'])
      ]));
    }

    return el('div', { className: 's-assistant__row s-assistant__row--bot' }, [
      el('div', { className: 's-assistant__avatar', 'aria-hidden': 'true' }, [icon('sparkles', 16)]),
      body
    ]);
  }

  /* 失败按因分流 + 保留原文：三个出口都留着（AS-4） */
  function failureActions(turn) {
    var raw = String(turn.raw || '');
    return el('div', { className: 's-assistant__actions' }, [
      el('button', {
        className: 's-assistant__ghost',
        type: 'button',
        'aria-label': '重试联网解析',
        onclick: function () { if (raw) { submit(raw); } }
      }, ['重试']),
      el('button', {
        className: 's-assistant__ghost',
        type: 'button',
        'aria-label': '改用本地解析这一句',
        onclick: function () { if (raw) { submitLocalOnly(raw); } }
      }, ['改用本地解析']),
      el('button', {
        className: 's-assistant__ghost',
        type: 'button',
        'aria-label': '去设置里检查联网配置',
        onclick: function () { gotoSettings(); }
      }, ['去设置'])
    ]);
  }

  function gotoSettings() {
    if (host && host.ctx && typeof host.ctx.go === 'function') {
      host.ctx.go('#/settings');
      return;
    }
    try { global.location.hash = '#/settings'; } catch (error) { /* 忽略 */ }
  }

  function noticeCard(turn) {
    var body = el('div', { className: 's-assistant__bubble s-assistant__bubble--bot' });
    body.appendChild(el('p', { className: 's-assistant__text', text: NOTICE_HEAD }));
    body.appendChild(el('p', { className: 's-assistant__text', text: NOTICE_BODY }));
    body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: NOTICE_DETAIL }));
    body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: NOTICE_TAIL }));
    body.appendChild(el('p', { className: 's-assistant__text', text: NOTICE_ASK }));
    if (turn.noticeAnswer) {
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: turn.noticeAnswer }));
      return body;
    }
    body.appendChild(el('div', { className: 's-assistant__actions' }, [
      el('button', {
        className: 's-assistant__primary',
        type: 'button',
        'aria-label': '同意联网并继续解析',
        onclick: function () { acceptNotice(turn); }
      }, ['同意并继续']),
      el('button', {
        className: 's-assistant__ghost',
        type: 'button',
        'aria-label': '只用本地解析这一句',
        onclick: function () { declineNotice(turn); }
      }, ['只用本地'])
    ]));
    return body;
  }

  function acceptNotice(turn) {
    if (!turn || turn.noticeAnswer) { return; }
    var as = assistant();
    var llm = as && as.llm;
    if (llm && typeof llm.setConfig === 'function') {
      try { llm.setConfig({ noticeAt: Date.now() }); } catch (error) { /* 写不进去就按未同意处理 */ }
    }
    turn.noticeAnswer = '已同意联网，这一句用在线解析。';
    paint();
    sendRemote(String(turn.raw || ''));
  }

  function declineNotice(turn) {
    if (!turn || turn.noticeAnswer) { return; }
    session.noticeDeclined = true;
    turn.noticeAnswer = '这次只用本地解析；想开联网随时去「我的 › 小助手与联网」。';
    paint();
    sendLocal(String(turn.raw || ''), 'none');
  }

  function replyOptions(reply) {
    if (!reply.options || !reply.options.length) { return document.createDocumentFragment(); }
    var wrap = el('div', { className: 's-assistant__opts' });
    reply.options.forEach(function (opt) {
      var value = opt && typeof opt === 'object' ? String(opt.value || opt.label) : String(opt);
      var label = opt && typeof opt === 'object' ? String(opt.label || opt.value) : String(opt);
      wrap.appendChild(el('button', {
        className: 's-assistant__opt',
        type: 'button',
        'aria-label': '回复：' + label,
        onclick: function () { submit(value); }
      }, [label]));
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
        'aria-label': '选择：' + label,
        onclick: function () { submit(value); }
      }, [label]));
    });
    return wrap;
  }

  /* 空态示例句（AS-8）：点了只填进输入框，不替用户发出去 */
  function exampleList(list) {
    var wrap = el('div', { className: 's-assistant__opts' });
    list.forEach(function (text) {
      wrap.appendChild(el('button', {
        className: 's-assistant__opt',
        type: 'button',
        'aria-label': '示例：' + text + '（点了只填进输入框）',
        onclick: function () { fillInput(text); }
      }, [String(text)]));
    });
    return wrap;
  }

  function fillInput(text) {
    if (!host || !host.input) { return; }
    host.input.value = String(text);
    autoGrow(host.input);
    try {
      host.input.focus();
      if (host.input.setSelectionRange) { host.input.setSelectionRange(host.input.value.length, host.input.value.length); }
    } catch (error) { /* 忽略 */ }
    scrollToEnd(false);
  }

  /* 结果卡片标题（AS-2）：条数 + 合计 */
  function previewHeadline(reply) {
    var rows = reply.rows || [];
    var count = rows.length || (reply.totals && reply.totals.count) || 0;
    var total = 0;
    rows.forEach(function (row) { total += Math.abs(Number(row.amountCents || 0)); });
    return el('p', { className: 's-assistant__text', text: '识别到 ' + count + ' 笔，合计 ' + money(total) });
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

  /* 对称二选一（AS-2）：[再改改] [确认记 N 笔]；主按钮不自动抢焦点 */
  function previewActions(reply, turn) {
    var wrap = el('div', { className: 's-assistant__actions' });
    var plan = reply.plan;
    var canConfirm = reply.canConfirm === true;
    var needDup = reply.needDupConfirm === true;
    var rows = reply.rows || [];
    var count = rows.length || (reply.totals && reply.totals.count) || 0;
    var primaryLabel = count > 0 ? (needDup ? '仍要记 ' + count + ' 笔' : '确认记 ' + count + ' 笔') : '确认记这笔';

    wrap.appendChild(el('button', {
      className: 's-assistant__primary',
      type: 'button',
      disabled: canConfirm ? null : 'disabled',
      'aria-label': primaryLabel,
      onclick: function (event) {
        if (!canConfirm) { return; }
        var btn = event.currentTarget;
        if (needDup) {
          XZB.ui.sheet.confirm({
            title: '和已有账目相似',
            message: '有 ' + rows.filter(function (r) { return r.dup; }).length + ' 笔看起来和最近记过的重复，仍要记吗？',
            confirmLabel: '仍要记',
            onConfirm: function (close) { close(); doConfirm(plan, { forced: true }); }
          });
          return;
        }
        if (btn) { btn.disabled = true; }
        doConfirm(plan, {});
      }
    }, [primaryLabel]));

    wrap.appendChild(el('button', {
      className: 's-assistant__ghost',
      type: 'button',
      'aria-label': '再改改这一句',
      onclick: function () { dismissPreview(turn, plan); }
    }, ['再改改']));
    return wrap;
  }

  /* 「再改改」：把原话放回输入框，用户接着改，不替他再发一次 */
  function dismissPreview(turn, plan) {
    var raw = String((plan && plan.raw) || (turn && turn.raw) || '');
    if (turn) { turn.dismissed = true; }
    var as = assistant();
    if (plan && as && as.draft && as.draft.clear) { as.draft.clear(); }
    if (raw) { fillInput(raw); }
    paint();
    refreshBanner();
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
        'aria-label': '第 ' + (index + 1) + ' 笔：' + label,
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
        'aria-label': '看这笔的明细',
        onclick: function () {
          if (hash) { location.hash = hash; }
        }
      }, ['看明细'])
    ]);
  }

  /* ============================== 忙碌态（异步边界） ============================== */

  function beginBusy(label, phase, delayTyping) {
    session.busy = true;
    session.state = phase === 'writing' ? 'writing' : 'parsing';
    if (host && host.input) { host.input.disabled = true; }
    if (host && host.send) {
      host.send.disabled = true;
      host.send.setAttribute('aria-busy', 'true');
    }
    /* ≥200ms 才出「正在解析…」，避免本地/快速返回时闪一下（DESIGN §3.1） */
    session.typing = delayTyping ? null : { label: label || '正在解析…', soft: false };
  }

  function endBusy() {
    session.busy = false;
    session.state = 'idle';
    session.typing = null;
    clearTimers();
    if (host && host.input) { host.input.disabled = false; }
    if (host && host.send) {
      host.send.disabled = false;
      host.send.setAttribute('aria-busy', 'false');
    }
  }

  /* ============================== 提交 / 回复 ============================== */

  function submit(text, opts) {
    if (!host || !text || !String(text).trim()) { return; }
    var raw = String(text).trim();

    /* 忙的时候不静默吞掉：排进队列，并明确告诉用户（A1） */
    if (session.busy) {
      session.queue.push(raw);
      pushTurn({ who: 'bot', reply: { kind: 'hint', text: '上一条还在处理，这条先排在后面，等它完我接着记。' } });
      paint();
      scrollToEnd(true);
      return;
    }

    pushTurn({ who: 'user', text: raw });
    if (host.input) {
      host.input.value = '';
      autoGrow(host.input);
    }
    paint();
    scrollToEnd(true);
    dispatch(raw, opts || {});
  }

  function queueNext() {
    if (!session.queue.length) { return; }
    var next = session.queue.shift();
    later(function () { submit(next); }, 0);
  }

  function dispatch(raw, opts) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx) {
      pushTurn({ who: 'bot', text: '数据还没准备好，稍等一下再试', tone: 'err' });
      restoreInput(raw);
      paint();
      scrollToEnd(true);
      return;
    }

    var cfg = configNow();
    if (!opts.local && shouldNotice(cfg)) {
      pushTurn({ who: 'bot', notice: true, raw: raw });
      paint();
      scrollToEnd(true);
      return;
    }

    if (!opts.local && readyNow()) {
      sendRemote(raw);
      return;
    }
    sendLocal(raw, opts.reason || localReason(cfg));
  }

  /* 异步边界：远端解析 + 5s 软提示 + 令牌防过期（硬 6s/总 8s 由 core 保证） */
  function sendRemote(raw) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx || typeof as.respondRemote !== 'function') {
      sendLocal(raw, 'none');
      return;
    }

    session.token += 1;
    var token = session.token;
    beginBusy('正在解析…', 'parsing', true);
    paint();
    scrollToEnd(true);

    /* 200ms 后才把「正在解析…」画出来；5s 时追加「正在用本地模式…」（R-04 软提示） */
    later(function () {
      if (token !== session.token) { return; }
      session.typing = { label: '正在解析…', soft: false };
      paint();
      scrollToEnd(false);
    }, TYPING_DELAY);

    var softMs = Number(as.LLM_SOFT_MS) || 5000;
    later(function () {
      if (token !== session.token || !session.typing) { return; }
      session.typing.soft = true;
      paint();
      scrollToEnd(false);
    }, softMs);

    var pending;
    try {
      pending = as.respondRemote(raw, session.core, cx);
    } catch (error) {
      endBusy();
      finishFallback(raw, 'bad');
      return;
    }

    Promise.resolve(pending).then(function (out) {
      /* 过期响应一律丢弃（用户已经发了新的一句） */
      if (token !== session.token) { return; }
      endBusy();
      var reply = (out && out.reply) || { kind: 'hint', text: '我这边没有拿到结果，再说一次试试。' };
      session.core = (out && out.state) || session.core;
      var mode = out && out.mode === 'online' ? 'online' : 'fallback';
      var reason = (out && out.reason) || 'bad';
      setMode(mode, mode === 'online' ? '' : reason);
      afterReply(raw, reply, { mode: mode, reason: reason });
    }, function () {
      if (token !== session.token) { return; }
      endBusy();
      finishFallback(raw, 'bad');
    });
  }

  /* 远端彻底失败（正常不会走到：respondRemote 自带回落，这里只是兜底） */
  function finishFallback(raw, reason) {
    var as = assistant();
    var out = null;
    try { out = as.respond(raw, session.core, cxNow()); } catch (error) { out = null; }
    var reply = (out && out.reply) || { kind: 'hint', text: '我这边没有拿到结果，再说一次试试。' };
    session.core = (out && out.state) || session.core;
    setMode('fallback', reason);
    afterReply(raw, reply, { mode: 'fallback', reason: reason });
  }

  /* 本地解析：不经网络，同步返回 */
  function sendLocal(raw, reason) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx) { return; }
    var out;
    try {
      out = as.respond(raw, session.core, cx);
    } catch (error) {
      pushTurn({ who: 'bot', text: '我这边出问题了，再试一次或手动记一笔', tone: 'err', mode: 'local', raw: raw });
      restoreInput(raw);
      paint();
      scrollToEnd(true);
      return;
    }
    session.core = out.state || session.core;
    var reply = out.reply || { kind: 'hint', text: '' };
    setMode('local', reason || 'none');
    afterReply(raw, reply, { mode: 'local', reason: reason || 'none' });
  }

  /* 「改用本地解析」按钮：跳过联网，直接跑规则引擎 */
  function submitLocalOnly(raw) {
    var cfg = configNow();
    sendLocal(raw, localReason(cfg));
  }

  function needsInputBack(reply, meta) {
    if (meta && meta.mode === 'fallback') { return true; }
    if (reply && reply.tone === 'err') { return true; }
    if (reply && reply.code && String(reply.code).indexOf('E_') === 0) { return true; }
    return false;
  }

  function restoreInput(raw) {
    if (!host || !host.input || !raw) { return; }
    if (host.input.value) { return; }
    host.input.value = String(raw);
    autoGrow(host.input);
  }

  function afterReply(raw, reply, meta) {
    var as = assistant();

    /* 草稿是否需要写进 prefs：只在「待确认」时留，确认/放弃后清掉 */
    if (reply && reply.kind === 'preview' && reply.plan && as && as.draft && as.draft.save) {
      as.draft.save(reply.plan, { note: 'waiting-confirm' });
    }

    var turn = {
      who: 'bot',
      reply: reply,
      raw: raw,
      mode: meta ? meta.mode : 'local',
      reason: meta ? meta.reason : ''
    };
    if (needsInputBack(reply, meta)) { restoreInput(raw); }

    pushTurn(turn);
    paint();
    refreshBanner();
    scrollToEnd(true);
    renderChips();
    queueNext();
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
    beginBusy('正在写入…', 'writing');
    paint();
    scrollToEnd(true);

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
      endBusy();
      if (!res || !res.ok) {
        pushTurn({ who: 'bot', text: (res && res.message) || '没写成功，请再试一次', tone: 'err', mode: 'local' });
        paint();
        scrollToEnd(true);
        return;
      }
      var result = res.result || {};
      /* 写入成功后：草稿作废、这一屏的确认按钮收掉，否则横幅会一直说「上次还有 N 笔没确认」 */
      if (session.core) { session.core.draft = null; session.core.pending = null; }
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
      pushTurn({ who: 'bot', text: doneText, tone: 'ok', mode: 'local' });
      paint();
      scrollToEnd(true);
      /* 成功后的撤销条不依赖 toast 的 5s：屏内自绘，8s 常驻（C3=A）。
       * 只有真动过账目才出条：already（幂等重放）指向的是上一笔无关记录，不能给撤销。 */
      var touched = created + updated + deleted;
      if (touched) { showUndoBar(touched); }
      refreshBanner();
      queueNext();
    }, function () {
      endBusy();
      pushTurn({ who: 'bot', text: '写入失败，请再试一次', tone: 'err', mode: 'local' });
      paint();
      scrollToEnd(true);
      queueNext();
    });
  }

  /* ============================== 撤销条（8s 常驻） ============================== */

  function latestEntry() {
    var history = historyApi();
    return history && history.list ? (history.list()[0] || null) : null;
  }

  function showUndoBar(count) {
    if (!host || !host.undoBar) { return; }
    var entry = latestEntry();
    if (!entry) { return; }
    session.undoEntry = entry;
    session.undoUntil = Date.now() + UNDO_MS;
    var bar = host.undoBar;
    clear(bar);
    bar.hidden = false;
    bar.appendChild(el('span', {
      className: 's-assistant__banner-text',
      text: '已记 ' + (count || 1) + ' 笔（助手记账）'
    }));
    bar.appendChild(el('button', {
      className: 's-assistant__undo-bar-btn',
      type: 'button',
      'aria-label': '撤销刚才写入的 ' + (count || 1) + ' 笔',
      onclick: function () { confirmUndo(session.undoEntry); }
    }, ['撤销']));
    if (session.undoTimer) { clearTimeout(session.undoTimer); }
    session.undoTimer = setTimeout(function () {
      session.undoTimer = null;
      hideUndoBar();
      if (host) { refreshBanner(); }
    }, UNDO_MS);
  }

  function hideUndoBar() {
    if (session.undoTimer) { clearTimeout(session.undoTimer); session.undoTimer = null; }
    session.undoEntry = null;
    session.undoUntil = 0;
    if (host && host.undoBar) {
      host.undoBar.hidden = true;
      clear(host.undoBar);
    }
  }

  function undoBarActive() {
    return !!(session.undoUntil && session.undoUntil > Date.now());
  }

  function undoEntry(entry) {
    var as = assistant();
    var cx = cxNow();
    if (!as || !cx || !entry) { return; }
    as.undoEntry(entry, cx).then(function (res) {
      var msg = res && res.ok ? '已撤销：' + (entry.summary || entry.label || '') : ((res && res.message) || '撤销失败');
      XZB.ui.toast.show(msg, { type: res && res.ok ? 'success' : 'danger' });
      hideUndoBar();
      if (host) { paint(); refreshBanner(); }
    }, function () {
      XZB.ui.toast.show('撤销失败', { type: 'danger' });
    });
  }

  /* 统一的撤销确认：撤销条与撤销历史屏共用同一套语义 */
  function confirmUndo(entry, after) {
    if (!entry) { return; }
    XZB.ui.sheet.confirm({
      title: '撤销这次操作？',
      message: (entry.summary || entry.label || '') + '\n撤销会按记录逐条改回；改不回去的条目会被跳过并告诉你。',
      confirmLabel: '撤销',
      kind: 'danger',
      onConfirm: function (close) {
        close();
        var as = assistant();
        var cx = cxNow();
        if (!as || !cx) { return; }
        as.undoEntry(entry, cx).then(function (res) {
          if (res && res.ok) {
            XZB.ui.toast.show('已撤销：' + (entry.summary || ''), { type: 'success' });
          } else {
            XZB.ui.toast.show((res && res.message) || '撤销失败', { type: 'danger' });
          }
          if (typeof after === 'function') { after(); }
        }, function () {
          XZB.ui.toast.show('撤销失败', { type: 'danger' });
        });
      }
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
          turn.reply.plan && turn.reply.plan.id === draft.plan.id && !turn.consumed && !turn.dismissed;
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
          'aria-label': '接着确认上次那批',
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
              },
              mode: 'local',
              reason: 'none'
            });
            paint();
            scrollToEnd(true);
          }
        }, ['继续'])
      ]);
      return;
    }

    /* 撤销条在的这 8 秒里，横幅让位，避免两处撤销入口同时出现 */
    if (last && !session.busy && session.turns.length > 1 && !undoBarActive()) {
      banner.hidden = false;
      append(banner, [
        icon('undo', 18),
        el('span', { className: 's-assistant__banner-text', text: '刚才：' + (last.summary || last.label || '') }),
        el('button', {
          className: 's-assistant__banner-btn',
          type: 'button',
          'aria-label': '撤销刚才的操作',
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
        'aria-label': '示例：' + text + '（点了只填进输入框）',
        onclick: function () { fillInput(text); }
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
            'aria-label': group.label + '：' + pair[1],
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
              'aria-label': '撤销：' + (entry.summary || entry.label || '这条记录'),
              onclick: function () { confirmUndo(entry, paintList); }
            }, ['撤销'])
          ])
        ]);
        listHost.appendChild(card);
      });
    }
  }

  function clearHistory(ctx) {
    var history = historyApi();
    if (!history) { return; }
    if (!history.list().length) { toast(ctx, '还没有记录', 'info'); return; }
    XZB.ui.sheet.confirm({
      title: '清空撤销历史？',
      message: '只清空「可撤销的记录」，已经记好的账不受影响。',
      confirmLabel: '清空',
      kind: 'danger',
      onConfirm: function (close) {
        close();
        history.clear();
        toast(ctx, '已清空', 'success');
        if (ctx && ctx.refresh) { ctx.refresh(); }
      }
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
    clearTimers();
    hideUndoBar();
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