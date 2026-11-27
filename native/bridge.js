/* 小账本 · native/bridge.js · iOS 原生壳桥接（仅 Capacitor 环境生效）
 *
 * 职责（全部只经既有接缝，不另造备份格式、不改 Web 源码）：
 *  ① 导出改道：WKWebView 不支持 a[download] 的 Blob 下载，原 backup.download 会静默失败。
 *     原生环境下替换为「写入 App 沙盒 Documents/导出/ + 系统分享面板」，
 *     序列化仍走 backup.exportText（JSON/CSV 与 Web 完全同格式）。
 *  ② 自动镜像：账目每次落库（Core.store.subscribe）后防抖 5s，把一份标准 JSON 备份
 *     （backup.exportJson 产物）写到 Documents/小账本-自动备份.json；退后台/关页尽力补写。
 *     Info.plist 开了 UIFileSharingEnabled，该文件在「文件」App 可见可取——App 打不开也能救数据。
 *  ③ 空库还原：冷启动若本机库 0 笔流水而镜像有账，询问是否一键还原；
 *     还原走 backup.import(text,{mode:'replace'})（自带 pre-import 快照 + 校验 + 回滚 + 照片回填）。
 *     用户拒绝后按镜像 exportedAt 记住，不再反复骚扰（localStorage xzb.native.v1，仅原生容器存在）。
 *  ④ 收缩保护：新镜像笔数少于上一份时（删除/清空），先把旧镜像轮转为
 *     Documents/小账本-自动备份-上一份.json，误清空后还有一次反悔机会。
 *  ⑤ 原生震动：WKWebView 没有 navigator.vibrate，网页震动/键盘手感在 iPhone 上全哑。
 *     原生环境下用 Capacitor Haptics 插件补一个 navigator.vibrate 垫片（按时长映射
 *     Taptic 力度），Web 侧 ui/haptics、keypad、toast 的既有调用一行不改即可真震；
 *     ui/haptics.supported() 随之为 true → 设置页出震动开关、点按音效自动闭嘴（与 Android 同口径）。
 *
 * 铁律：非 Capacitor 环境一律 no-op（浏览器直接打开 www 也不受影响）；
 *       插件调用全部经 window.Capacitor.Plugins（原生桥自动注入，不依赖打包器）；
 *       镜像失败只记 status，不弹错不阻断记账——IndexedDB 仍是主存储。
 * 挂载：XZB.NativeBridge（status() 供验收；__test 供单测注入假插件）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});

  var MIRROR_FILE = '小账本-自动备份.json';
  var MIRROR_PREV = '小账本-自动备份-上一份.json';
  var EXPORT_DIR = '导出';
  var PREF_KEY = 'xzb.native.v1';
  var DEBOUNCE_MS = 5000;

  var state = {
    initialized: false,
    lastMirrorAt: null,
    lastMirrorBytes: 0,
    lastMirrorCount: 0,
    lastMirroredSavedAt: null,
    lastExportAt: null,
    exports: 0,
    vibrateShim: false,
    lastError: null
  };

  /* ---------------- 环境探测 ---------------- */

  function isNative() {
    var cap = global.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  function plugins() {
    var cap = global.Capacitor;
    return cap && cap.Plugins ? cap.Plugins : null;
  }

  function fsPlugin() {
    var p = plugins();
    return p && p.Filesystem ? p.Filesystem : null;
  }

  function hapticsPlugin() {
    var p = plugins();
    return p && p.Haptics ? p.Haptics : null;
  }

  function backupApi() {
    return XZB.Core && XZB.Core.backup ? XZB.Core.backup : null;
  }

  /* ---------------- 纯函数：还原判定 ---------------- */

  function decideRestore(input) {
    var src = input || {};
    var live = Number(src.liveTransactions) || 0;
    var mirror = Number(src.mirrorTransactions) || 0;
    var at = src.mirrorExportedAt ? String(src.mirrorExportedAt) : '';
    var dismissed = src.dismissedFor ? String(src.dismissedFor) : '';
    if (mirror <= 0) { return { prompt: false, reason: 'no-mirror-data' }; }
    if (live > 0) { return { prompt: false, reason: 'live-not-empty' }; }
    if (at && dismissed === at) { return { prompt: false, reason: 'dismissed' }; }
    return { prompt: true, reason: 'empty-live-with-mirror' };
  }

  /* ---------------- 纯函数：镜像收缩保护 ---------------- */

  function shouldRotate(prevCount, nextCount) {
    var prev = Number(prevCount) || 0;
    var next = Number(nextCount) || 0;
    return prev > 0 && next < prev;
  }

  /* ---------------- 防抖 + 单飞调度器（可注入时钟，便于单测） ---------------- */

  function createMirrorScheduler(opts) {
    var write = opts.write;
    var delay = typeof opts.debounceMs === 'number' ? opts.debounceMs : DEBOUNCE_MS;
    var setT = opts.setTimeout || global.setTimeout;
    var clearT = opts.clearTimeout || global.clearTimeout;
    var timer = null;
    var busy = false;
    var pending = false;

    function run() {
      if (busy) { pending = true; return; }
      busy = true;
      Promise.resolve().then(write).then(done, done);
    }
    function done() {
      busy = false;
      if (pending) { pending = false; run(); }
    }

    return {
      notify: function () {
        if (timer) { clearT(timer); }
        timer = setT(function () { timer = null; run(); }, delay);
      },
      flush: function () {
        if (timer) { clearT(timer); timer = null; }
        run();
      },
      isBusy: function () { return busy; }
    };
  }

  var scheduler = createMirrorScheduler({
    write: function () { return writeMirror('auto'); }
  });

  /* ---------------- 偏好（拒绝还原的记忆） ---------------- */

  function readDismissed() {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(PREF_KEY) : null;
      var obj = raw ? JSON.parse(raw) : null;
      return obj && obj.restoreDismissedFor ? String(obj.restoreDismissedFor) : '';
    } catch (error) { return ''; }
  }

  function saveDismissed(exportedAt) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(PREF_KEY, JSON.stringify({ restoreDismissedFor: String(exportedAt || '') }));
      }
    } catch (error) { /* 忽略 */ }
  }

  /* ---------------- 镜像读写 ---------------- */

  function currentSavedAt() {
    var store = XZB.Core && XZB.Core.store;
    try {
      return store && typeof store.getSavedAt === 'function' ? store.getSavedAt() : null;
    } catch (error) { return null; }
  }

  function liveCount() {
    try {
      var db = XZB.app && typeof XZB.app.db === 'function' ? XZB.app.db() : null;
      return db && Array.isArray(db.transactions) ? db.transactions.length : 0;
    } catch (error) { return 0; }
  }

  function rotateMirror(fs) {
    /* copy 在目标已存在时会失败，先删旧「上一份」；删除失败（不存在）忽略 */
    return Promise.resolve(fs.delete({ path: MIRROR_PREV, directory: 'DOCUMENTS' }))
      .catch(function () { /* 不存在 */ })
      .then(function () {
        return fs.copy({ from: MIRROR_FILE, to: MIRROR_PREV, directory: 'DOCUMENTS', toDirectory: 'DOCUMENTS' });
      })
      .catch(function (error) {
        state.lastError = '轮转旧镜像失败：' + String(error && error.message || error);
      });
  }

  function writeMirror(reason) {
    var fs = fsPlugin();
    var backup = backupApi();
    if (!fs || !backup || typeof backup.exportJson !== 'function') { return Promise.resolve(false); }
    var savedAt = currentSavedAt();
    if (reason !== 'force' && savedAt && savedAt === state.lastMirroredSavedAt) {
      return Promise.resolve(false); /* 与上次镜像同一落库时刻，不重复写 */
    }
    return Promise.resolve(backup.exportJson()).then(function (res) {
      if (res && !res.ok && res.canExportWithoutPhotos) {
        return backup.exportJson({ includePhotos: false });
      }
      return res;
    }).then(function (res) {
      if (!res || !res.ok) {
        state.lastError = '镜像导出失败：' + String(res && (res.message || res.code) || '未知');
        return false;
      }
      var count = res.counts && typeof res.counts.transactions === 'number' ? res.counts.transactions : 0;
      var pre = shouldRotate(state.lastMirrorCount, count) ? rotateMirror(fs) : Promise.resolve();
      return pre.then(function () {
        return fs.writeFile({
          path: MIRROR_FILE,
          data: res.content,
          directory: 'DOCUMENTS',
          encoding: 'utf8',
          recursive: true
        });
      }).then(function () {
        state.lastMirrorAt = new Date().toISOString();
        state.lastMirrorBytes = res.bytes || 0;
        state.lastMirrorCount = count;
        state.lastMirroredSavedAt = savedAt;
        state.lastError = null;
        return true;
      });
    }).catch(function (error) {
      state.lastError = '镜像写入失败：' + String(error && error.message || error);
      return false;
    });
  }

  function readMirror() {
    var fs = fsPlugin();
    if (!fs) { return Promise.resolve(null); }
    return Promise.resolve(fs.readFile({ path: MIRROR_FILE, directory: 'DOCUMENTS', encoding: 'utf8' }))
      .then(function (r) {
        var text = r && typeof r.data === 'string' ? r.data : '';
        var payload = JSON.parse(text);
        var tx = payload && payload.data && Array.isArray(payload.data.transactions)
          ? payload.data.transactions.length : 0;
        return {
          count: tx,
          exportedAt: payload && payload.exportedAt ? String(payload.exportedAt) : '',
          text: text
        };
      })
      .catch(function () { return null; });
  }

  /* ---------------- 空库还原 ---------------- */

  function promptRestore(mirror) {
    var when = mirror.exportedAt ? mirror.exportedAt.replace('T', ' ').slice(0, 16) : '未知时间';
    var ok = false;
    try {
      ok = global.confirm(
        '发现本机自动备份：' + mirror.count + ' 笔流水（' + when + '）。\n' +
        '当前 App 是空账本，要还原这份备份吗？\n（还原会整体替换当前的空数据）'
      );
    } catch (error) { ok = false; }
    if (!ok) { saveDismissed(mirror.exportedAt); return Promise.resolve(false); }
    var backup = backupApi();
    if (!backup || typeof backup.import !== 'function') { return Promise.resolve(false); }
    return Promise.resolve(backup.import(mirror.text, { mode: 'replace' })).then(function (res) {
      if (res && res.ok) {
        try { global.location.reload(); } catch (error) { /* 忽略 */ }
        return true;
      }
      try {
        global.alert('还原失败：' + String(res && (res.message || res.code) || '未知错误') +
          '\n可在「我的 → 导入备份」手动选择该文件重试。');
      } catch (error) { /* 忽略 */ }
      return false;
    }).catch(function (error) {
      try { global.alert('还原失败：' + String(error && error.message || error)); } catch (e2) { /* 忽略 */ }
      return false;
    });
  }

  /* ---------------- 导出改道（Documents + 分享面板） ---------------- */

  function patchDownload() {
    var backup = backupApi();
    if (!backup || backup.__nativePatched || typeof backup.download !== 'function') { return false; }
    var original = backup.download;
    backup.download = function (format, opts) {
      return Promise.resolve(backup.exportText(format, opts)).then(function (res) {
        if (!res || !res.ok) { return res; }
        var fs = fsPlugin();
        if (!fs) { return original.call(backup, format, opts); }
        return Promise.resolve(fs.writeFile({
          path: EXPORT_DIR + '/' + res.filename,
          data: res.content,
          directory: 'DOCUMENTS',
          encoding: 'utf8',
          recursive: true
        })).then(function (written) {
          state.exports += 1;
          state.lastExportAt = new Date().toISOString();
          var p = plugins();
          var shared = p && p.Share && typeof p.Share.share === 'function'
            ? Promise.resolve(p.Share.share({
              title: res.filename,
              text: '小账本备份文件',
              url: written && written.uri ? written.uri : undefined,
              dialogTitle: '保存或发送备份文件'
            })).catch(function () { /* 用户取消分享：文件已落盘，仍算成功 */ })
            : Promise.resolve();
          return shared.then(function () {
            return {
              ok: true,
              filename: res.filename,
              mime: res.mime,
              bytes: res.bytes,
              downloaded: true,
              nativeSaved: true
            };
          });
        });
      }).catch(function (error) {
        return { ok: false, code: 'E_EXPORT_FAILED', message: String(error && error.message || error) };
      });
    };
    backup.__nativePatched = true;
    return true;
  }

  /* ---------------- 原生震动垫片（navigator.vibrate → Taptic Engine） ---------------- */

  /* 时长 → Taptic 力度：与 Web 侧 ui/haptics 的毫秒口径对齐
   * （tap 8ms / key 6ms → LIGHT；select 12ms → MEDIUM；warn 18ms / error 26ms → HEAVY） */
  function impactStyle(ms) {
    var n = Number(ms) || 0;
    if (n <= 8) { return 'LIGHT'; }
    if (n <= 15) { return 'MEDIUM'; }
    return 'HEAVY';
  }

  /* 纯函数：把 vibrate(pattern) 翻译成敲击计划 [{at, style}]。
   * number → 单击；[震,停,震,…] → 按累计偏移排多击（success/error 的双段/三段节奏）；
   * 0 / 空 / 非法 → 空计划（等价取消）。步数设上限，防异常输入排出一长串定时器。 */
  function planVibration(pattern) {
    var segs = Array.isArray(pattern) ? pattern : [pattern];
    var steps = [];
    var at = 0;
    for (var i = 0; i < segs.length && steps.length < 8; i += 2) {
      var ms = Math.max(0, Number(segs[i]) || 0);
      if (ms > 0) { steps.push({ at: at, style: impactStyle(ms) }); }
      at += ms + Math.max(0, Number(segs[i + 1]) || 0);
    }
    return steps;
  }

  /* 只在「原生容器 + Haptics 插件在位 + 本机没有真 vibrate」时安装；
   * 任何一环缺失都保持原样（浏览器/旧壳零影响）。新调用取消未完成的旧节奏，
   * 与 navigator.vibrate 的原生语义一致；插件失败静默——震动绝不能影响记账。 */
  function installVibrateShim() {
    if (!isNative()) { return false; }
    var h = hapticsPlugin();
    if (!h || typeof h.impact !== 'function') { return false; }
    var nav = global.navigator;
    if (!nav || typeof nav.vibrate === 'function') { return false; }
    var timers = [];

    function cancelPending() {
      for (var i = 0; i < timers.length; i += 1) { global.clearTimeout(timers[i]); }
      timers = [];
    }

    function strike(style) {
      try {
        var r = h.impact({ style: style });
        if (r && typeof r.catch === 'function') { r.catch(function () { /* 静默 */ }); }
      } catch (error) { /* 静默 */ }
    }

    function shim(pattern) {
      cancelPending();
      var steps = planVibration(pattern);
      for (var i = 0; i < steps.length; i += 1) {
        if (steps[i].at <= 0) { strike(steps[i].style); }
        else { timers.push(global.setTimeout(strike.bind(null, steps[i].style), steps[i].at)); }
      }
      return true;
    }

    try {
      nav.vibrate = shim;
    } catch (error) {
      try {
        Object.defineProperty(nav, 'vibrate', { value: shim, writable: true, configurable: true });
      } catch (error2) { return false; }
    }
    return typeof nav.vibrate === 'function';
  }

  /* ---------------- 启动接线 ---------------- */

  function wireFlush() {
    var doc = global.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'hidden') { scheduler.flush(); }
      });
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('pagehide', function () { scheduler.flush(); });
    }
    var p = plugins();
    if (p && p.App && typeof p.App.addListener === 'function') {
      try {
        p.App.addListener('appStateChange', function (st) {
          if (st && st.isActive === false) { scheduler.flush(); }
        });
      } catch (error) { /* 忽略 */ }
    }
  }

  function subscribeStore() {
    var store = XZB.Core && XZB.Core.store;
    if (store && typeof store.subscribe === 'function') {
      try {
        store.subscribe(function () { scheduler.notify(); });
      } catch (error) { /* 忽略 */ }
    }
  }

  function whenReady(cb) {
    var app = XZB.app;
    if (app && app.ready && typeof app.ready.then === 'function') {
      app.ready.then(cb);
      return;
    }
    var tries = 0;
    var timer = global.setInterval(function () {
      tries += 1;
      if (XZB.app && XZB.app.ready && typeof XZB.app.ready.then === 'function') {
        global.clearInterval(timer);
        XZB.app.ready.then(cb);
      } else if (tries > 100) {
        global.clearInterval(timer);
      }
    }, 100);
  }

  function init() {
    if (!isNative() || state.initialized) { return false; }
    state.initialized = true;
    state.vibrateShim = installVibrateShim();
    patchDownload();
    whenReady(function (bootState) {
      if (bootState && bootState.bootError) { return; }
      patchDownload();
      wireFlush();
      readMirror().then(function (mirror) {
        if (mirror) { state.lastMirrorCount = mirror.count; }
        var decision = decideRestore({
          liveTransactions: liveCount(),
          mirrorTransactions: mirror ? mirror.count : 0,
          mirrorExportedAt: mirror ? mirror.exportedAt : '',
          dismissedFor: readDismissed()
        });
        var restoring = decision.prompt && mirror ? promptRestore(mirror) : Promise.resolve(false);
        return restoring.then(function () {
          subscribeStore();
          scheduler.flush(); /* 基线镜像：首启也有文件可取 */
        });
      });
    });
    return true;
  }

  function status() {
    return {
      native: isNative(),
      initialized: state.initialized,
      lastMirrorAt: state.lastMirrorAt,
      lastMirrorBytes: state.lastMirrorBytes,
      lastMirrorCount: state.lastMirrorCount,
      lastExportAt: state.lastExportAt,
      exports: state.exports,
      vibrateShim: state.vibrateShim,
      lastError: state.lastError,
      mirrorFile: MIRROR_FILE,
      mirrorPrevFile: MIRROR_PREV,
      exportDir: EXPORT_DIR
    };
  }

  XZB.NativeBridge = {
    init: init,
    isNative: isNative,
    status: status,
    decideRestore: decideRestore,
    shouldRotate: shouldRotate,
    planVibration: planVibration,
    createMirrorScheduler: createMirrorScheduler,
    MIRROR_FILE: MIRROR_FILE,
    MIRROR_PREV: MIRROR_PREV,
    EXPORT_DIR: EXPORT_DIR,
    PREF_KEY: PREF_KEY,
    __test: {
      state: function () { return state; },
      writeMirror: writeMirror,
      readMirror: readMirror,
      patchDownload: patchDownload,
      promptRestore: promptRestore,
      installVibrateShim: installVibrateShim
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = XZB.NativeBridge;
  }

  if (isNative()) { init(); }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));