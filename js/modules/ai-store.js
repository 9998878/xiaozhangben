/* ============================================================================
   小账本 2.0 · js/modules/ai-store.js · owner: 助手（T02）
   文件：js/modules/ai-store.js
   挂载：window.XZB.core.aiStore（Node 下可 require，便于无浏览器单测）
   依赖：XZB.core.dates（只取 todayStr；缺失时用本地兜底实现，不影响任何功能）

   契约锚点：
     - 唯一持有 localStorage['xzb.ai.v1']；不碰 xzb.ui.v2、不碰 IndexedDB、无网络（0 处 fetch）。
     - 对外只暴露「有/没有 Key」与「掩码」；明文只经 revealKey()/setKey() 两条明确命名的方法。
     - 所有读写失败静默回落默认值，绝不抛出（存储异常不得影响记账）。
     - 主键：providers.<id>；用量：全局 usage + 各 provider 独立 usage。

   结构（架构 §4.1）：
     { v, consent:{version,at,revokedAt}, active, prefs:{dailyLimit,sendNote,entryHintDismissed},
       usage:{day,dayFloor,count,ok,fail,firstByteMsSum,firstByteN},
       providers: { modelscope|zhipu|siliconflow|openrouter|dashscope|custom1 } }

   三处不可退让的细节：
     * 1) providers 是字典不是数组：setActive() 只改一个字符串，A→B→A 往返后各字段必然各自正确（AC6）。
     * 2) 跨日重置只用 core.dates.todayStr() 做单调比较：today > day 才重置，today < day 继续累加（AC9）。
     * 3) 智谱国内站 https://open.bigmodel.cn/api/paas/v4 预检响应里没有任何 Access-Control-Allow-*，
          浏览器直连必然失败，因此**不提供该预设**；本文件只在注释里提到它，
          不写进任何默认值（用户硬要用只能走 custom1 并自行解决跨域）。
   ============================================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var core = XZB.core || (XZB.core = XZB.Core = XZB.Core || XZB.core || {});

  /* ============================== 常量 ============================== */

  /* 唯一存储键：与 index.html clearPrefs() 里的字面量必须逐字一致（架构 §4.2.1 / §13.3） */
  var KEY = 'xzb.ai.v1';
  var SCHEMA_V = 1;
  /* 授权文案版本：改文案必须 +1，老授权自动失效（P0-2） */
  var CONSENT_VERSION = 1;

  var LIMIT_MIN = 20;
  var LIMIT_MAX = 200;
  var LIMIT_STEP = 20;
  var LIMIT_DEFAULT = 100;

  /* 掩码总长上限（含省略号），见架构 §3.1 */
  var MASK_MAX = 12;
  /* guard() 只对超过该长度的 Key 做子串扫描，避免短串误报 */
  var GUARD_MIN_LEN = 8;

  var E = {
    DENIED: 'E_AI_STORE_DENIED',
    CORRUPT: 'E_AI_STORE_CORRUPT',
    UNKNOWN: 'E_AI_STORE_UNKNOWN_PROVIDER',
    FILE_PROTOCOL: 'E_AI_FILE_PROTOCOL'
  };

  /* 固定 6 键，顺序即 UI 顺序（架构 §4.1.1） */
  var PROVIDER_ORDER = ['modelscope', 'zhipu', 'siliconflow', 'openrouter', 'dashscope', 'custom1'];

  /* 预设表：model / baseUrl 必须与架构 §4.1.1 逐字一致。
     label 只用于展示，不落盘；name 字段留给用户给自定义供应商起名。 */
  var PRESET = {
    modelscope: {
      label: '魔搭 ModelScope',
      model: 'Qwen/Qwen3-32B',
      baseUrl: 'https://api-inference.modelscope.cn/v1'
    },
    zhipu: {
      label: '智谱 GLM',
      model: 'glm-4-flash',
      baseUrl: 'https://api.z.ai/api/paas/v4'
    },
    siliconflow: {
      label: '硅基流动',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      baseUrl: 'https://api.siliconflow.cn/v1'
    },
    openrouter: {
      label: 'OpenRouter',
      model: 'deepseek/deepseek-r1:free',
      baseUrl: 'https://openrouter.ai/api/v1'
    },
    dashscope: {
      label: '阿里百炼',
      model: 'qwen-turbo',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    },
    custom1: {
      label: '自定义',
      model: '',
      baseUrl: ''
    }
  };

  /* ============================== 注入点（架构 §13.1） ============================== */

  var CONF = {
    /* storage 默认 localStorage；Node 单测传内存 Map 版 */
    storage: null,
    /* now 返回毫秒时间戳；跨日归一与授权时间都走它 */
    now: null
  };

  function configure(options) {
    var o = options || {};
    if (o.storage) { CONF.storage = o.storage; }
    if (typeof o.now === 'function') { CONF.now = o.now; }
    /* 注入变更后必须清空内存缓存，否则读到的是旧配置 */
    cache = null;
  }

  /* ============================== 基础工具 ============================== */

  function nowMs() {
    if (typeof CONF.now === 'function') {
      try { return Number(CONF.now()) || 0; } catch (error) { /* 注入的时钟坏了也不能崩 */ }
    }
    return Date.now();
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /* 只依赖 core.dates.todayStr()；在 Node 单测里 dates 可能尚未加载，本地兜底同构实现 */
  function todayStr() {
    try {
      var dates = XZB.core && XZB.core.dates;
      if (dates && typeof dates.todayStr === 'function') {
        var fromCore = dates.todayStr();
        if (fromCore) { return String(fromCore); }
      }
    } catch (error) { /* 落到本地实现 */ }
    var d = new Date(nowMs());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isoNow() {
    return new Date(nowMs()).toISOString();
  }

  function str(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function int(value) {
    var n = Math.round(Number(value));
    return isFinite(n) ? n : 0;
  }

  /* 深拷贝：只用于在内存里存取配置，绝不写日志 */
  function copy(value) {
    if (value === null || value === undefined) { return value; }
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return null; }
  }

  function storage() {
    if (CONF.storage) { return CONF.storage; }
    try {
      if (global && global.localStorage) { return global.localStorage; }
    } catch (error) { /* Safari 无痕模式下 getItem 都可能抛 */ }
    return null;
  }

  /* 平台闸门（架构 §3.1 / AC19）：file:// 下不许存 Key、不许授权。
     放在 store 而不是只在 UI：否则会出现「https 下授权过 → 本地文件打开时仍 granted」的跨 origin 边界。
     Node 单测没有 location，缺省视为可用，否则所有用例都会短路在闸门上。 */
  function platform() {
    try {
      var loc = global.location;
      if (loc && loc.protocol === 'file:') { return { ok: false, code: E.FILE_PROTOCOL }; }
    } catch (error) { /* 读不到 location 按可用处理 */ }
    return { ok: true, code: 'OK' };
  }

  /* ============================== 默认值 ============================== */

  function clampLimit(value) {
    /* 20–200 步进 20（架构 §4.1） */
    var n = Number(value);
    if (!isFinite(n)) { n = LIMIT_DEFAULT; }
    n = Math.round(n / LIMIT_STEP) * LIMIT_STEP;
    if (n < LIMIT_MIN) { n = LIMIT_MIN; }
    if (n > LIMIT_MAX) { n = LIMIT_MAX; }
    return n;
  }

  function emptyUsage(day) {
    return {
      day: day || '',
      dayFloor: day || '',
      count: 0,
      ok: 0,
      fail: 0,
      firstByteMsSum: 0,
      firstByteN: 0
    };
  }

  function defaultProvider(id) {
    var preset = PRESET[id] || PRESET.custom1;
    return {
      key: '',
      model: preset.model,
      baseUrl: preset.baseUrl,
      name: '',
      lastTest: null,
      usage: { day: '', count: 0 }
    };
  }

  function defaults() {
    var out = {
      v: SCHEMA_V,
      consent: { version: 0, at: '', revokedAt: null },
      active: PROVIDER_ORDER[0],
      prefs: { dailyLimit: LIMIT_DEFAULT, sendNote: false, entryHintDismissed: false },
      usage: emptyUsage(''),
      providers: {}
    };
    PROVIDER_ORDER.forEach(function (id) { out.providers[id] = defaultProvider(id); });
    return out;
  }

  /* ============================== 归一化 ============================== */

  /* 日期串合法性防御（D9）：脏值一律当作「没有日期」，走重置分支，避免 NaN 比较把计数卡死 */
  function isDayText(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(str(value));
  }

  /* 跨日归一（AC9）：单调比较，today > day 才重置；today < day 视为同一天继续累加 */
  function normalizeUsage(raw, today) {
    var u = raw && typeof raw === 'object' ? raw : {};
    var out = {
      day: isDayText(u.day) ? str(u.day) : '',
      dayFloor: isDayText(u.dayFloor) ? str(u.dayFloor) : '',
      count: Math.max(0, int(u.count)),
      ok: Math.max(0, int(u.ok)),
      fail: Math.max(0, int(u.fail)),
      firstByteMsSum: Math.max(0, int(u.firstByteMsSum)),
      firstByteN: Math.max(0, int(u.firstByteN))
    };
    if (!out.day) {
      /* 没有合法日期（首次使用 / 脏值）：当作新的一天，计数一并清零，避免把来路不明的计数带到今天 */
      out.day = today;
      out.dayFloor = today;
      out.count = 0;
      out.ok = 0;
      out.fail = 0;
      out.firstByteMsSum = 0;
      out.firstByteN = 0;
      return out;
    }
    if (today > out.day) {
      /* 新的一天：计数清零，dayFloor 保留见过的最早日期，便于排查 */
      var floor = out.dayFloor || out.day;
      out.day = today;
      out.dayFloor = floor < today ? floor : today;
      out.count = 0;
      out.ok = 0;
      out.fail = 0;
      out.firstByteMsSum = 0;
      out.firstByteN = 0;
      return out;
    }
    /* today <= day：不回退、不清零。today < day 是「用户把系统时间调早」，按同一天继续累加 */
    if (!out.dayFloor) { out.dayFloor = out.day; }
    return out;
  }

  function normalizeProviderUsage(raw, today) {
    var u = raw && typeof raw === 'object' ? raw : {};
    var out = { day: isDayText(u.day) ? str(u.day) : '', count: Math.max(0, int(u.count)) };
    if (!out.day) { out.day = today; return out; }
    if (today > out.day) { out.day = today; out.count = 0; }
    return out;
  }

  function normalizeLastTest(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    return {
      at: str(raw.at),
      ok: raw.ok === true,
      ms: Math.max(0, int(raw.ms)),
      code: str(raw.code) || (raw.ok === true ? 'OK' : 'E_AI_NET')
    };
  }

  function normalizeProvider(id, raw, today) {
    var out = defaultProvider(id);
    if (!raw || typeof raw !== 'object') { return out; }
    var preset = PRESET[id] || PRESET.custom1;
    out.key = str(raw.key);
    /* 预设的 model/baseUrl 为空时回落预设值；custom1 没有预设，保持用户填的空串 */
    out.model = str(raw.model) || preset.model;
    out.baseUrl = str(raw.baseUrl) || preset.baseUrl;
    out.name = str(raw.name);
    out.lastTest = normalizeLastTest(raw.lastTest);
    out.usage = normalizeProviderUsage(raw.usage, today);
    return out;
  }

  function normalizePrefs(raw) {
    var p = raw && typeof raw === 'object' ? raw : {};
    return {
      dailyLimit: clampLimit(p.dailyLimit),
      sendNote: p.sendNote === true,
      entryHintDismissed: p.entryHintDismissed === true
    };
  }

  function normalize(raw, today) {
    var out = defaults();
    if (!raw || typeof raw !== 'object') { return out; }

    var c = raw.consent && typeof raw.consent === 'object' ? raw.consent : {};
    out.consent = {
      version: int(c.version),
      at: str(c.at),
      revokedAt: str(c.revokedAt) || null
    };

    var active = str(raw.active);
    out.active = PROVIDER_ORDER.indexOf(active) >= 0 ? active : PROVIDER_ORDER[0];

    out.prefs = normalizePrefs(raw.prefs);
    out.usage = normalizeUsage(raw.usage, today);

    var src = raw.providers && typeof raw.providers === 'object' ? raw.providers : {};
    PROVIDER_ORDER.forEach(function (id) { out.providers[id] = normalizeProvider(id, src[id], today); });
    return out;
  }

  /* ============================== 读写 ============================== */

  var cache = null;
  /* 最近一次 load() 产生的非致命 code（E_AI_STORE_CORRUPT / E_AI_STORE_DENIED），供设置页提示 */
  var lastCode = 'OK';

  function readRaw() {
    var s = storage();
    if (!s) { return { ok: false, code: E.DENIED, raw: null }; }
    try {
      return { ok: true, code: 'OK', raw: s.getItem(KEY) };
    } catch (error) {
      return { ok: false, code: E.DENIED, raw: null };
    }
  }

  /* load() 首次读盘 + 迁移，之后只读内存缓存。恒返回可用 Config。 */
  function load() {
    if (cache) { return copy(cache); }

    var today = todayStr();
    var got = readRaw();
    var code = 'OK';
    var parsed = null;

    if (!got.ok) {
      code = got.code;
    } else if (got.raw !== null && got.raw !== undefined && got.raw !== '') {
      try {
        parsed = JSON.parse(got.raw);
      } catch (error) {
        parsed = null;
        code = E.CORRUPT;
      }
    }

    var body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    var version = body ? Number(body.v) : NaN;

    if (!body) {
      /* 键不存在：返回默认值且**不写入**，不产生空 blob 污染（架构 §4.2） */
      cache = normalize(defaults(), today);
    } else if (!isFinite(version) || version < SCHEMA_V) {
      /* JSON 坏 / 版本太旧：整块丢弃重建，只留一条 code，不打印内容 */
      cache = normalize(defaults(), today);
      code = E.CORRUPT;
    } else {
      /* v >= 1：尽力读，不认识的键由 normalize 忽略；v > 1（用户降级安装）也走这里 */
      cache = normalize(body, today);
    }

    lastCode = code;
    if (code !== 'OK') {
      /* 唯一日志点：只输出 code，绝不输出配置内容 */
      try { if (global.console && global.console.warn) { global.console.warn('[小账本] ai', code); } } catch (error) { /* 忽略 */ }
    }
    return copy(cache);
  }

  function save(config) {
    var next = normalize(config, todayStr());
    var s = storage();
    if (!s) { return { ok: false, code: E.DENIED }; }
    try {
      s.setItem(KEY, JSON.stringify(next));
    } catch (error) {
      /* 配额满 / 无痕模式：不抛出，交由 UI 提示 */
      return { ok: false, code: E.DENIED };
    }
    cache = next;
    lastCode = 'OK';
    return { ok: true, code: 'OK' };
  }

  /* ============================== 供应商 ============================== */

  function getActive() {
    var cfg = load();
    var id = cfg.active;
    var p = cfg.providers[id] || defaultProvider(id);
    var out = copy(p) || defaultProvider(id);
    out.id = id;
    return out;
  }

  function setActive(id) {
    var want = str(id);
    if (PROVIDER_ORDER.indexOf(want) < 0) { return { ok: false, code: E.UNKNOWN }; }
    var cfg = load();
    cfg.active = want;
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  function keyOf(id) {
    var cfg = load();
    var pid = str(id) || cfg.active;
    var p = cfg.providers[pid];
    return p ? str(p.key) : '';
  }

  function hasKey(id) {
    return keyOf(id).length > 0;
  }

  function maskedKey(id) {
    var k = keyOf(id);
    if (!k) { return ''; }
    if (k.length <= 4) { return '…'; }
    if (k.length <= 8) { return '…' + k.slice(-4); }
    /* 前 4 + 省略号 + 后 4 = 9 字符，恒 ≤ MASK_MAX */
    var masked = k.slice(0, 4) + '…' + k.slice(-4);
    return masked.length > MASK_MAX ? masked.slice(0, MASK_MAX) : masked;
  }

  /* 唯一的明文出口之一：只允许设置页「显示」按钮调用一次 */
  function revealKey(id) {
    return keyOf(id);
  }

  /* 清掉粘贴时常见的包装：首尾空白、Bearer 前缀、成对引号 */
  function sanitizeKey(raw) {
    var s = str(raw).trim();
    s = s.replace(/^Bearer\s+/i, '').trim();
    s = s.replace(/^["'\u201c\u201d\u2018\u2019\u300c\u300d]+/, '').replace(/["'\u201c\u201d\u2018\u2019\u300c\u300d]+$/, '').trim();
    return s;
  }

  function setKey(id, raw) {
    var cfg = load();
    var pid = str(id) || cfg.active;
    if (!cfg.providers[pid]) { return { ok: false, code: E.UNKNOWN }; }
    cfg.providers[pid].key = sanitizeKey(raw);
    /* 换 Key 必然让上次测试结论失效 */
    cfg.providers[pid].lastTest = null;
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  function clearKey(id) {
    var cfg = load();
    var pid = str(id) || cfg.active;
    if (!cfg.providers[pid]) { return { ok: false, code: E.UNKNOWN }; }
    cfg.providers[pid].key = '';
    cfg.providers[pid].lastTest = null;
    /* model / baseUrl 保留：用户换 Key 不该丢掉接口地址 */
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  function setProviderField(id, field, value) {
    var allow = { model: 1, baseUrl: 1, name: 1 };
    var cfg = load();
    var pid = str(id) || cfg.active;
    if (!cfg.providers[pid]) { return { ok: false, code: E.UNKNOWN }; }
    if (!allow[field]) { return { ok: false, code: E.UNKNOWN }; }
    cfg.providers[pid][field] = str(value);
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  function setLastTest(id, result) {
    var cfg = load();
    var pid = str(id) || cfg.active;
    if (!cfg.providers[pid]) { return { ok: false, code: E.UNKNOWN }; }
    var r0 = result || {};
    cfg.providers[pid].lastTest = {
      at: isoNow(),
      ok: r0.ok === true,
      ms: Math.max(0, int(r0.ms)),
      code: str(r0.code) || (r0.ok === true ? 'OK' : 'E_AI_NET')
    };
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  function clearAll() {
    var s = storage();
    cache = null;
    lastCode = 'OK';
    if (!s) { return { ok: false, code: E.DENIED }; }
    try {
      s.removeItem(KEY);
    } catch (error) {
      return { ok: false, code: E.DENIED };
    }
    return { ok: true, code: 'OK' };
  }

  /* wipe()：语义等同 clearAll()，命名对齐设置页「清除本机数据」的语境。
     **不承诺删除一定发生**：本模块是懒加载 chunk，用户从没打开过智能增强时
     XZB.core.aiStore 就是 undefined，调用方压根调不到这个方法。
     真正保证落盘删除的是 index.html clearPrefs() 里的裸 localStorage.removeItem('xzb.ai.v1')。 */
  function wipe() {
    return clearAll();
  }

  /* invalidate()：丢掉内存缓存，下次 load() 重新读盘。
     用于「清空数据后闸门可重试分支不一定 reload」时避免内存里留一份旧 Key。 */
  function invalidate() {
    cache = null;
    lastCode = 'OK';
    return { ok: true, code: 'OK' };
  }

  /* ============================== 授权 ============================== */

  function consent() {
    var c = load().consent;
    /* file:// 下恒未授权：挡住「https 授权过 → 本地文件打开仍 granted」的跨 origin 边界（AC19） */
    if (platform().ok !== true) { return { granted: false, version: c.version, at: c.at }; }
    /* 版本不匹配或已撤销都视为未授权（P0-2） */
    var granted = c.version === CONSENT_VERSION && !c.revokedAt;
    return { granted: granted, version: c.version, at: c.at };
  }

  function grantConsent(version) {
    var gate = platform();
    /* 平台不满足时**不写入**：不允许只在 UI 层禁用开关（AC19） */
    if (gate.ok !== true) { return { ok: false, code: gate.code }; }
    var cfg = load();
    var v = isFinite(Number(version)) ? int(version) : CONSENT_VERSION;
    cfg.consent = { version: v, at: isoNow(), revokedAt: null };
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  function revokeConsent() {
    var cfg = load();
    cfg.consent = {
      version: cfg.consent.version,
      at: cfg.consent.at,
      revokedAt: isoNow()
    };
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  /* ============================== 用量 ============================== */

  function usage() {
    var cfg = load();
    var u = normalizeUsage(cfg.usage, todayStr());
    /* 读取时归一：会更新内存缓存，但**不落盘**（usage() 无持久化副作用；下一次 bumpUsage 才写盘） */
    if (cache) { cache.usage = u; }
    return {
      day: u.day,
      count: u.count,
      limit: clampLimit(cfg.prefs.dailyLimit),
      ok: u.ok,
      fail: u.fail,
      firstByteMsSum: u.firstByteMsSum,
      firstByteN: u.firstByteN
    };
  }

  function bumpUsage(ev) {
    var e = ev || {};
    var today = todayStr();
    var cfg = load();
    var u = normalizeUsage(cfg.usage, today);
    var counted = e.counted !== false;

    if (counted) { u.count += 1; }
    if (e.ok === true) { u.ok += 1; } else { u.fail += 1; }
    var ms = Math.max(0, int(e.firstByteMs));
    if (e.ok === true && ms > 0) {
      u.firstByteMsSum += ms;
      u.firstByteN += 1;
    }
    cfg.usage = u;

    /* 分家用量：与全局同一次写入，不读对方的派生值（架构 §4.1） */
    var pid = str(e.providerId) || cfg.active;
    if (cfg.providers[pid]) {
      var pu = normalizeProviderUsage(cfg.providers[pid].usage, today);
      if (counted) { pu.count += 1; }
      cfg.providers[pid].usage = pu;
    }

    var saved = save(cfg);
    /* 落盘失败（配额满/无痕）：丢掉内存缓存，避免后续读到一份「不在盘上」的计数 */
    if (!saved.ok) { cache = null; }
    return { day: u.day, count: u.count };
  }

  function resetUsage() {
    var cfg = load();
    var today = todayStr();
    cfg.usage = emptyUsage(today);
    PROVIDER_ORDER.forEach(function (id) {
      if (cfg.providers[id]) { cfg.providers[id].usage = { day: today, count: 0 }; }
    });
    var r = save(cfg);
    return { ok: r.ok, code: r.code };
  }

  /* ============================== 偏好 ============================== */

  function prefs() {
    return copy(load().prefs) || normalizePrefs(null);
  }

  function setPref(name, value) {
    var allow = { dailyLimit: 1, sendNote: 1, entryHintDismissed: 1 };
    if (!allow[name]) { return { ok: false, code: E.UNKNOWN }; }
    var cfg = load();
    if (name === 'dailyLimit') { cfg.prefs.dailyLimit = clampLimit(value); }
    else { cfg.prefs[name] = value === true; }
    var r = save(cfg);
    return { ok: r.ok, code: r.code, value: cfg.prefs[name] };
  }

  /* ============================== 泄漏守卫 ============================== */

  /* 扫描任意字符串是否含任一 provider 的明文 Key；true = 干净。
     供导出 JSON / 日志 / URL 三处兜底（架构 §4.3 第 2/3/5 行） */
  function guard(text) {
    var s = typeof text === 'string' ? text : str(text);
    if (!s) { return true; }
    var cfg = load();
    for (var i = 0; i < PROVIDER_ORDER.length; i += 1) {
      var k = str(cfg.providers[PROVIDER_ORDER[i]] && cfg.providers[PROVIDER_ORDER[i]].key);
      if (k && k.length >= GUARD_MIN_LEN && s.indexOf(k) >= 0) { return false; }
    }
    return true;
  }

  /* ============================== 只读元信息 ============================== */

  function labelOf(id) {
    var pid = str(id);
    if (PROVIDER_ORDER.indexOf(pid) < 0) { return ''; }
    /* 用户给自定义供应商起的名字优先 */
    var cfg = load();
    var custom = cfg.providers[pid] ? str(cfg.providers[pid].name) : '';
    return custom || PRESET[pid].label;
  }

  function list() {
    var out = [];
    PROVIDER_ORDER.forEach(function (id) {
      out.push({
        id: id,
        label: PRESET[id].label,
        defaultModel: PRESET[id].model,
        defaultBaseUrl: PRESET[id].baseUrl
      });
    });
    return out;
  }

  function lastLoadCode() {
    return lastCode;
  }

  /* ============================== 导出 ============================== */

  var api = {
    /* 契约 API（架构 §3.1） */
    load: load,
    save: save,
    getActive: getActive,
    setActive: setActive,
    hasKey: hasKey,
    maskedKey: maskedKey,
    revealKey: revealKey,
    setKey: setKey,
    clearKey: clearKey,
    clearAll: clearAll,
    /* wipe() 只是 clearAll() 的同义命名；落盘删除的保证在 index.html clearPrefs() 的裸 removeItem 上 */
    wipe: wipe,
    invalidate: invalidate,
    platform: platform,
    consent: consent,
    grantConsent: grantConsent,
    revokeConsent: revokeConsent,
    usage: usage,
    bumpUsage: bumpUsage,
    resetUsage: resetUsage,
    guard: guard,

    /* 附加只读/便利方法（T05 设置页需要；不改变上面任何契约） */
    configure: configure,
    prefs: prefs,
    setPref: setPref,
    setProviderField: setProviderField,
    setLastTest: setLastTest,
    labelOf: labelOf,
    list: list,
    clampLimit: clampLimit,
    sanitizeKey: sanitizeKey,
    lastLoadCode: lastLoadCode,

    /* 常量外露：UI 与单测都以此为准，禁止各自硬编码 */
    KEY: KEY,
    CONSENT_VERSION: CONSENT_VERSION,
    PROVIDER_ORDER: PROVIDER_ORDER,
    LIMIT_MIN: LIMIT_MIN,
    LIMIT_MAX: LIMIT_MAX,
    LIMIT_STEP: LIMIT_STEP,
    E: E
  };

  core.aiStore = api;
  if (XZB.core && XZB.core !== core) { XZB.core.aiStore = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
