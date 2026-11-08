/* ============================================================================
   小账本 2.0 · js/screens/assistant.js · owner: 助手（T-AS）
   文件：src/js/screens/assistant.js
   路由：#/assistant（聊天屏）；2.28.8 起翻旧账撤回机制移除，历史子页路由不再存在
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

  /* 首次联网告知（R-11）：两句事实，必须原样出现，不做营销化改写。
     2.28.1：与实际出域对齐——出站 payload 含分类清单（id+名称），必须写明分类名称；
     「统计口径」在 payload 中并无对应字段，删掉。 */
  var NOTICE_HEAD = '联网解析前先跟你说清楚：';
  var NOTICE_BODY = '会把你说的话、账户名称与分类名称发送给你配置的模型服务';
  var NOTICE_DETAIL = '每次只发送这一句话、账户名称、分类名，不发账目明细。';
  var NOTICE_TAIL = '可在「我的」里关闭（小助手与联网）';
  var NOTICE_ASK = '现在要联网解析这一句吗？';

  /* 2.28.8：撤销历史机制移除，UNDO_MS / 屏内撤销条一并删除。 */
  var TYPING_DELAY = 200;

  /* 2.29.2：鲨鱼式极速直记——看懂的账不再停在确认卡，直接入账，
     DIRECT_UNDO_MS 内可在气泡里一键撤销；缺金额/疑似重复/拿不准的仍走补问与确认。 */
  var DIRECT_PREF_KEY = 'assistant.direct';
  var DIRECT_UNDO_MS = 8000;

  function prefGet(key, fallback) {
    var prefs = (XZB.app && XZB.app.prefs) || null;
    if (!prefs || typeof prefs.get !== 'function') { return fallback; }
    try {
      var v = prefs.get(key, fallback);
      return (v === undefined || v === null) ? fallback : v;
    } catch (error) { return fallback; }
  }

  function prefSet(key, value) {
    var prefs = (XZB.app && XZB.app.prefs) || null;
    if (!prefs || typeof prefs.set !== 'function') { return false; }
    try { prefs.set(key, value); return true; } catch (error) { return false; }
  }

  function directOn() { return prefGet(DIRECT_PREF_KEY, true) !== false; }

  /* 回落原因 → 一行短说明（A27/D-08：不得静默切换） */
  var REASON_TEXT = {
    timeout: '网络超时，已改用本地解析',
    rate: '服务繁忙（限流），已改用本地解析',
    server: '模型服务出错，已改用本地解析',
    auth: '密钥或权限不对，已改用本地解析',
    net: '在线服务连不上，已改用本地解析',
    config: '未启用在线模型，当前用本地解析',
    disabled: '未启用在线模型，当前用本地解析',
    privacy: '已配置在线模型：先同意隐私告知再联网',
    mixed: '网站是 https，接口地址要换成 https:// 开头，已改用本地解析',
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

  /* 该不该在这一次提交前先弹告知卡：只有「用户真的填好了模型、并且打开了开关」才问。
     2.28.1：「只用本地」改回按句生效——旧版把拒绝记成会话级（noticeDeclined），
     之后每句既不询问也不说明，与按钮文案「只用本地解析这一句」自相矛盾。 */
  function shouldNotice(cfg) {
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
    pendingRaw: '',       /* 在途云端请求的原话：「取消等待」的作废目标（2.28.2） */
    timers: []
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
  }

  function pushTurn(turn) {
    session.turns.push(turn);
    if (session.turns.length > MAX_TURNS) { session.turns.splice(0, session.turns.length - MAX_TURNS); }
    if (window.__xzbTest) { try { window.__xzbTest(turn); } catch (error) { /* 测试钩子绝不影响应用 */ } }
  }

  /* ============================== 渲染：外壳 ============================== */

  var host = null;      /* {root, ctx, shell, log, chipRow, input, send, banner, voice, capsule, subText} */

  function render(root, ctx) {
    root.textContent = '';
    if (!assistant()) {
      root.appendChild(el('div', { className: 's-assistant s-assistant--broken' }, [
        el('p', { className: 's-assistant__broken-text', text: '助手模块没有加载成功，请重新打开应用。' })
      ]));
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
      ])
    ]);

    var log = el('div', {
      className: 's-assistant__log',
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-label': '对话'
    });

    var banner = el('div', { className: 's-assistant__banner', hidden: true });

    var chipRow = el('div', { className: 's-assistant__chips', 'aria-label': '快捷标签' });

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
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '模型响应较慢，继续等…' }));
    }
    /* 2.28.2：云端等待期（最长 20s）给一个「取消等待」出口——作废在途响应，当句立刻转本地 */
    if (session.pendingRaw) {
      body.appendChild(el('div', { className: 's-assistant__actions' }, [
        el('button', {
          className: 's-assistant__ghost', type: 'button',
          'aria-label': '取消等待，这一句改用本地解析',
          onclick: cancelRemoteWait
        }, ['取消等待'])
      ]));
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
    /* 2.29.2：直记成功气泡（自带撤销）优先于普通 reply 渲染 */
    if (turn.kind === 'recorded') { return recordedBubble(turn); }
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
          onclick: function () { gotoSettings('#/settings/ai'); }
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
          onclick: function () { gotoSettings('#/settings/ai'); }
        }, ['去设置'])
      ]));
    }

    return el('div', { className: 's-assistant__row s-assistant__row--bot' }, [
      el('div', { className: 's-assistant__avatar', 'aria-hidden': 'true' }, [icon('sparkles', 16)]),
      body
    ]);
  }

  /* 2.29.2：直记成功气泡——明细一行一笔 + 撤销按钮（DIRECT_UNDO_MS 后消失） */
  function recordedRowText(row) {
    return [row.typeText, row.amountText, row.categoryText, row.accountText, row.note]
      .filter(function (part) { return !!part; }).join(' · ');
  }

  function undoRecorded(turn) {
    if (!turn || turn.undoGone || turn.undoing || turn.undone) { return; }
    var as = assistant();
    var cx = cxNow();
    var ids = turn.ids || [];
    if (!as || !cx || !ids.length || typeof as.buildDeletePlan !== 'function' || typeof as.execute !== 'function') {
      turn.undoGone = true;
      paint();
      return;
    }
    turn.undoing = true;
    paint();
    var done = 0;
    var failed = 0;
    function settle(ok) {
      done += 1;
      if (!ok) { failed += 1; }
      if (done < ids.length) { return; }
      turn.undoing = false;
      turn.undone = failed === 0;
      turn.undoGone = true;
      paint();
      scrollToEnd(true);
    }
    ids.forEach(function (id) {
      var tx = null;
      ((cx.db && cx.db.transactions) || []).forEach(function (one) {
        if (one && one.id === id) { tx = one; }
      });
      if (!tx || tx.deleted === true) { settle(true); return; }
      var delPlan = null;
      try { delPlan = as.buildDeletePlan(tx, cx); } catch (error) { delPlan = null; }
      if (!delPlan) { settle(false); return; }
      as.execute(delPlan, cx).then(function (res) {
        settle(!!(res && res.ok));
      }, function () {
        settle(false);
      });
    });
  }

  function recordedBubble(turn) {
    var rows = turn.rows || [];
    var body = el('div', { className: 's-assistant__bubble s-assistant__bubble--bot is-ok' });
    body.appendChild(el('p', {
      className: 's-assistant__text',
      text: turn.undone ? '已撤销，这笔没有入账' : (rows.length > 1 ? '已记 ' + rows.length + ' 笔 ✓' : '已记 ✓')
    }));
    rows.forEach(function (row) {
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: recordedRowText(row) }));
    });
    if (turn.undone) {
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '想再记直接说一句就行' }));
    } else if (!turn.undoGone) {
      var acts = el('div', { className: 's-assistant__actions' });
      acts.appendChild(el('button', {
        className: 's-assistant__ghost',
        type: 'button',
        'aria-label': '撤销刚才直接入的账',
        onclick: function () { undoRecorded(turn); }
      }, [turn.undoing ? '正在撤销…' : '撤销']));
      body.appendChild(acts);
    } else {
      body.appendChild(el('p', { className: 's-assistant__text s-assistant__text--dim', text: '想改动去流水里操作就行' }));
    }
    return el('div', { className: 's-assistant__row s-assistant__row--bot', 'aria-live': 'polite' }, [
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
        onclick: function () { gotoSettings('#/settings/ai'); }
      }, ['去设置'])
    ]);
  }

  /* target 缺省一级设置页；privacy chip 深链 AI 子页（2.26.9 迭代6） */
  function gotoSettings(target) {
    var hash = target || '#/settings';
    if (host && host.ctx && typeof host.ctx.go === 'function') {
      host.ctx.go(hash);
      return;
    }
    try { global.location.hash = hash; } catch (error) { /* 忽略 */ }
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
    var saved = false;
    if (llm && typeof llm.setConfig === 'function') {
      try {
        var res = llm.setConfig({ noticeAt: Date.now() });
        saved = !!(res && res.ok === true);
      } catch (error) { saved = false; }
    }
    if (!saved) {
      /* 2.28.0：告知没落盘就不能发请求，否则 respondRemote 重读 noticeAt=0 又会按隐私回落 */
      turn.noticeAnswer = '隐私告知没有保存成功，这一句仍用本地解析；稍后可再试。';
      paint();
      sendLocal(String(turn.raw || ''), 'none');
      return;
    }
    turn.noticeAnswer = '已同意联网，这一句用在线解析。';
    paint();
    sendRemote(String(turn.raw || ''));
  }

  function declineNotice(turn) {
    if (!turn || turn.noticeAnswer) { return; }
    /* 2.28.1：只作用于这一句（turn.noticeAnswer 已挡住本句重复询问）。
       下一句若仍「已配置未告知」，告知卡照常再问——按句生效，不再会话级静默。 */
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
    session.pendingRaw = '';
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
    /* 2.28.2：离屏（host 已卸载）不再取队首——旧版先 shift 再 submit，host 为空时
       话语被静默吞掉，兑现不了「排在后面」。留在队列，回屏后由下一条回复带出。 */
    if (!host) { return; }
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
    session.pendingRaw = raw; /* 「取消等待」的作废目标（2.28.2） */
    beginBusy('正在解析…', 'parsing', true);
    paint();
    scrollToEnd(true);

    /* 200ms 后才把「正在解析…」画出来；8s 时追加「模型响应较慢，继续等…」（R-04 软提示）
       2.26.11：软提示从 5s 挪到 8s——解析硬超时已是 20s，5s 就喊「本地模式」会误导。 */
    later(function () {
      if (token !== session.token) { return; }
      session.typing = { label: '正在解析…', soft: false };
      paint();
      scrollToEnd(false);
    }, TYPING_DELAY);

    var softMs = Number(as.LLM_SOFT_MS) || 8000;
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
      /* 2.29.2：'local' 是本地快车道（鲨鱼式秒回），不是回落——不得套「回落」文案 */
      var mode = out && (out.mode === 'online' || out.mode === 'local') ? out.mode : 'fallback';
      var reason = (out && out.reason) || 'bad';
      setMode(mode, mode === 'online' ? '' : reason);
      afterReply(raw, reply, { mode: mode, reason: reason });
    }, function () {
      if (token !== session.token) { return; }
      endBusy();
      finishFallback(raw, 'bad');
    });
  }

  /* 2.28.2：「取消等待」——作废在途云端响应（token 机制），当句立刻转本地解析。
     不静默吞掉这一句：云端结果回来时已过期丢弃，本地结果马上顶上。 */
  function cancelRemoteWait() {
    var raw = session.pendingRaw || '';
    session.pendingRaw = '';
    session.token += 1;
    endBusy();
    if (raw) { sendLocal(raw, 'timeout'); return; }
    paint();
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

    /* 2.29.2：鲨鱼式直记——干净的 create 预览不停留，直接写入并给撤销气泡 */
    if (directReplyOk(reply, meta)) {
      doConfirm(reply.plan, { direct: true });
      return;
    }

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

  /* 直记闸门：只对「可直接确认的干净 create 预览」放行；
     疑似重复（needDupConfirm）、云端回落（fallback）、非 create 一律照旧走确认卡。 */
  function directReplyOk(reply, meta) {
    if (!directOn()) { return false; }
    if (!reply || reply.kind !== 'preview' || reply.canConfirm !== true) { return false; }
    if (reply.needDupConfirm === true) { return false; }
    if (!reply.plan || reply.plan.kind !== 'create') { return false; }
    if (meta && meta.mode === 'fallback') { return false; }
    return true;
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
      /* 2.29.2：鲨鱼式直记成功——明细气泡 + 8 秒撤销窗 + 成功音；普通确认仍走旧文案 */
      if (opts && opts.direct === true && created > 0) {
        var view = as.previewRows ? as.previewRows(plan, cx) : null;
        var rows = (view && view.rows ? view.rows : []).filter(function (row) {
          return (result.created || []).indexOf(row.id) >= 0;
        });
        var turn = {
          who: 'bot',
          kind: 'recorded',
          rows: rows,
          ids: (result.created || []).slice(),
          undoing: false,
          undone: false,
          undoGone: false,
          mode: 'local',
          reason: ''
        };
        pushTurn(turn);
        later(function () {
          if (turn.undone || turn.undoing) { return; }
          turn.undoGone = true;
          paint();
        }, DIRECT_UNDO_MS);
        setTimeout(function () {
          try {
            var sound = (XZB.ui && XZB.ui.sound) || (XZB.UI && XZB.UI.sound);
            if (sound && typeof sound.fire === 'function') { sound.fire('success'); }
          } catch (error) { /* 音效失败绝不影响记账 */ }
        }, 160);
      } else {
        pushTurn({ who: 'bot', text: doneText, tone: 'ok', mode: 'local' });
      }
      paint();
      scrollToEnd(true);
      /* 2.29.2：写入后必须刷新横幅——草稿已清，横幅若不刷会一直挂着
         「上次还有 N 笔没确认」，再点「继续→确认」就撞「这几笔之前已经记过了」（用户实测）。 */
      refreshBanner();
      /* 2.28.8：撤销历史机制移除，写入成功不再出屏内撤销条。 */
      queueNext();
    }, function () {
      endBusy();
      pushTurn({ who: 'bot', text: '写入失败，请再试一次', tone: 'err', mode: 'local' });
      paint();
      scrollToEnd(true);
      refreshBanner();
      queueNext();
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
    var draft = as && as.draft && as.draft.load ? as.draft.load() : null;
    /* 2.29.2：草稿自愈——计划里每一笔都已经在库里（未删）说明早写过了，
       这份草稿是残留，直接清掉不出横幅；否则「继续 → 确认」必撞
       「这几笔之前已经记过了，没有重复入账」。 */
    if (draft && draft.plan && draft.plan.kind === 'create' && (draft.plan.items || []).length) {
      var cxHeal = cxNow();
      var written = (cxHeal && cxHeal.db && cxHeal.db.transactions) || [];
      var allDone = true;
      for (var hi = 0; hi < draft.plan.items.length; hi += 1) {
        var hid = draft.plan.items[hi] && draft.plan.items[hi].id;
        var hitTx = null;
        for (var hj = 0; hj < written.length; hj += 1) {
          if (written[hj] && written[hj].id === hid) { hitTx = written[hj]; break; }
        }
        if (!hitTx || hitTx.deleted === true) { allDone = false; break; }
      }
      if (allDone) {
        if (as.draft.clear) { as.draft.clear(); }
        draft = null;
      }
    }
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
            /* 2.29.2：预览已上屏，横幅必须收掉——否则它一直挂着，
               再点一次「继续→确认」就会撞「这几笔之前已经记过了」（用户实测）。 */
            banner.hidden = true;
          }
        }, ['继续'])
      ]);
      return;
    }
  }

  /* 2.29.2：鲨鱼式快捷标签——近 60 天高频支出分类 top6 常驻；点一下填词，补个金额就发送 */
  function topChips() {
    var cx = cxNow();
    var out = [];
    if (cx && cx.db) {
      var cut = '';
      var d = datesApi();
      if (d && typeof d.addDays === 'function' && cx.today) {
        try { cut = d.addDays(cx.today, -60); } catch (error) { cut = ''; }
      }
      var counts = {};
      (cx.db.transactions || []).forEach(function (tx) {
        if (!tx || tx.deleted === true || tx.type !== 'expense') { return; }
        if (cut && tx.date && tx.date < cut) { return; }
        var id = tx.categoryId || '';
        if (!id) { return; }
        counts[id] = (counts[id] || 0) + 1;
      });
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (id) {
        if (out.length >= 6) { return; }
        var cat = null;
        (cx.liveCategories || []).forEach(function (c) { if (c && c.id === id) { cat = c; } });
        if (cat && cat.name && out.indexOf(String(cat.name)) < 0) { out.push(String(cat.name)); }
      });
    }
    ['午饭', '打车', '咖啡', '超市', '快递'].forEach(function (word) {
      if (out.length < 6 && out.indexOf(word) < 0) { out.push(word); }
    });
    return out.slice(0, 6);
  }

  function renderChips() {
    if (!host) { return; }
    var row = host.chipRow;
    clear(row);
    topChips().forEach(function (word) {
      row.appendChild(el('button', {
        className: 's-assistant__chip',
        type: 'button',
        'aria-label': '快记：' + word + '（点了填进输入框，补个金额就发送）',
        onclick: function () { fillInput(word + ' '); }
      }, [word]));
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

  /* 2.28.8：撤销历史屏与清空入口随机制整体移除。 */

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