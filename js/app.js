/* ============================================================
   小账本 2.0 · 应用启动与全局状态
   启动顺序：开库 → 载入快照 → 迁移 v1（如有）→ 应用主题 →
             启动路由 → 注册 Service Worker。
   唯一写者：dataset.theme / dataset.themePref（本文件）；
             localStorage['xzb.ui.v2']（本文件的 XZB.app.prefs）；
             IndexedDB（store.js）。
   数据约定：屏幕只读 XZB.app.db()，只写 XZB.app.commit()。
   ============================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB = global.XZB || {};
  /* 无条件赋值：core 各模块为了 Node standalone 会先写 XZB.version || '2.2.0'，
     原来的 || 守卫永远输给它们，运行时版本停在 2.2.0。app.js 是加载链最后一环，
     由它定稿版本（与 pwa/sw.js 的 CACHE_NAME 成对维护）。 */
  XZB.version = '2.8.0';

  var Core = XZB.Core || XZB.core || {};
  var UI = XZB.UI || XZB.ui || {};
  var store = Core.store || null;
  var migrate = Core.migrate || null;

  var PREFS_KEY = 'xzb.ui.v2';
  var TABLES = [
    'books', 'accounts', 'categories', 'transactions', 'budgets',
    'categoryBudgets', 'recurring', 'goals', 'goalDeposits'
  ];
  var UNDO_LIMIT = 30;
  var THEME_LIGHT = '#F2F2F7';
  var THEME_DARK = '#000000';

  var PREF_DEFAULTS = {
    theme: 'auto',
    activeBookId: null,
    lastCategory: { expense: null, income: null },
    lastAccountId: null,
    statsTab: 'trend',
    ledgerFilter: 'all',
    onboarded: false,
    installDismissed: false
  };
  var THEMES = ['auto', 'light', 'dark'];

  function pad2(number) {
    return number < 10 ? '0' + number : String(number);
  }

  function currentMonth() {
    var now = new Date();
    return now.getFullYear() + '-' + pad2(now.getMonth() + 1);
  }

  function clone(value) {
    if (value === null || value === undefined) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /* ---------------- UI 偏好（localStorage 唯一写者） ---------------- */

  function readPrefs() {
    var out = {};
    Object.keys(PREF_DEFAULTS).forEach(function (key) {
      out[key] = clone(PREF_DEFAULTS[key]);
    });
    try {
      var raw = global.localStorage ? global.localStorage.getItem(PREFS_KEY) : null;
      if (raw) {
        var parsed = JSON.parse(raw);
        if (isObject(parsed)) {
          Object.keys(parsed).forEach(function (key) {
            out[key] = parsed[key];
          });
        }
      }
    } catch (error) {
      /* 隐私模式 / 配额 / JSON 损坏：用默认值继续，不阻断启动 */
    }
    if (THEMES.indexOf(out.theme) < 0) out.theme = 'auto';
    if (!isObject(out.lastCategory)) out.lastCategory = { expense: null, income: null };
    if (out.lastCategory.expense === undefined) out.lastCategory.expense = null;
    if (out.lastCategory.income === undefined) out.lastCategory.income = null;
    out.onboarded = !!out.onboarded;
    out.installDismissed = !!out.installDismissed;
    return out;
  }

  function writePrefs(prefs) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      }
    } catch (error) {
      /* 写不进去也不能影响记账；主题等偏好退化为本次会话有效 */
    }
  }

  var prefsCache = readPrefs();

  /* ---------------- 全局状态（CONTRACT §4.1 形状） ---------------- */

  var state = {
    ready: false,
    bootError: null,
    storage: {
      mode: 'idb',
      degraded: false,
      saving: false,
      lastSavedAt: null,
      saveError: null
    },
    db: null,
    rev: 0,
    route: { view: 'home', sub: '', params: {} },
    nav: { stack: [], index: -1 },
    ui: {
      activeBookId: prefsCache.activeBookId || null,
      month: currentMonth(),
      statsTab: prefsCache.statsTab || 'trend',
      ledgerFilter: prefsCache.ledgerFilter || 'all',
      planTab: 'plans',
      sheet: null,
      keypadOpen: false,
      hideAmounts: false,
      theme: 'light',
      lastCategory: clone(prefsCache.lastCategory),
      lastAccountId: prefsCache.lastAccountId || null,
      onboarded: !!prefsCache.onboarded,
      toastCount: 0
    },
    session: {
      undoStack: [],
      redoStack: [],
      lastActionAt: 0,
      busy: false,
      pendingConfirm: null
    }
  };

  var readyResolve = null;
  var readyPromise = new Promise(function (resolve) {
    readyResolve = resolve;
  });
  var bootStarted = false;
  var bootNotice = null;
  var migrationError = null;
  var themeMedia = null;
  var lastErrorToastAt = 0;
  var opQueue = Promise.resolve();

  function syncUiFlag(key, value) {
    switch (key) {
      case 'theme':
        state.ui.theme = value;
        break;
      case 'activeBookId':
        state.ui.activeBookId = value;
        break;
      case 'hideAmounts':
        state.ui.hideAmounts = !!value;
        break;
      case 'statsTab':
        state.ui.statsTab = value;
        break;
      case 'ledgerFilter':
        state.ui.ledgerFilter = value;
        break;
      case 'lastCategory':
        state.ui.lastCategory = clone(value);
        break;
      case 'lastAccountId':
        state.ui.lastAccountId = value;
        break;
      case 'onboarded':
        state.ui.onboarded = !!value;
        break;
      default:
        break;
    }
  }

  var prefsApi = {
    get: function (key, fallback) {
      if (arguments.length === 0) return clone(prefsCache);
      if (Object.prototype.hasOwnProperty.call(prefsCache, key)) {
        return clone(prefsCache[key]);
      }
      return fallback;
    },
    set: function (key, value) {
      var patch = {};
      if (isObject(key)) {
        patch = key;
      } else if (typeof key === 'string') {
        patch[key] = value;
      } else {
        return value;
      }
      Object.keys(patch).forEach(function (name) {
        var next = patch[name];
        if (name === 'theme' && THEMES.indexOf(next) < 0) next = 'auto';
        prefsCache[name] = next;
        syncUiFlag(name, next);
      });
      writePrefs(prefsCache);
      if (Object.prototype.hasOwnProperty.call(patch, 'theme')) applyTheme();
      return value;
    },
    patch: function (patch) {
      return prefsApi.set(patch);
    },
    all: function () {
      return clone(prefsCache);
    }
  };

  /* ---------------- 主题 ---------------- */

  function prefersDark() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (error) {
      return false;
    }
  }

  function applyTheme() {
    var pref = prefsCache.theme;
    if (THEMES.indexOf(pref) < 0) pref = 'auto';
    var effective = pref === 'auto' ? (prefersDark() ? 'dark' : 'light') : pref;
    var root = document.documentElement;

    root.dataset.theme = effective;
    root.dataset.themePref = pref;
    try {
      root.style.colorScheme = effective;
    } catch (error) {
      /* 忽略 */
    }
    state.ui.theme = effective;
    updateThemeColor(effective, pref);
  }

  function updateThemeColor(effective, pref) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) {
      var meta = metas[i];
      var media = meta.getAttribute('media') || '';
      var color;
      if (pref === 'auto') {
        color = /dark/i.test(media) ? THEME_DARK : THEME_LIGHT;
      } else {
        color = effective === 'dark' ? THEME_DARK : THEME_LIGHT;
      }
      meta.setAttribute('content', color);
    }
  }

  function watchThemeMedia() {
    if (themeMedia || !global.matchMedia) return;
    try {
      themeMedia = global.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (prefsCache.theme === 'auto') applyTheme();
      };
      if (typeof themeMedia.addEventListener === 'function') {
        themeMedia.addEventListener('change', onChange);
      } else if (typeof themeMedia.addListener === 'function') {
        themeMedia.addListener(onChange);
      }
    } catch (error) {
      themeMedia = null;
    }
  }

  /* ---------------- 存储状态 ---------------- */

  function syncStorage() {
    state.rev = store && typeof store.getRev === 'function' ? store.getRev() : 0;
    state.storage.mode = store && typeof store.getMode === 'function' ? store.getMode() : 'idb';
    state.storage.degraded = state.storage.mode !== 'idb';
    state.storage.lastSavedAt = store && typeof store.getSavedAt === 'function' ? store.getSavedAt() : null;
    if (store && typeof store.get === 'function') {
      var snapshot = store.get();
      if (snapshot) state.db = snapshot;
    }
  }

  function reconcileActiveBook() {
    var books = (state.db && state.db.books) || [];
    var wanted = prefsCache.activeBookId;
    var found = null;
    var i;
    for (i = 0; i < books.length; i += 1) {
      var book = books[i];
      if (book && book.id === wanted && book.deleted !== true && book.archived !== true) {
        found = book;
        break;
      }
    }
    if (!found) {
      for (i = 0; i < books.length; i += 1) {
        if (books[i] && books[i].deleted !== true && books[i].archived !== true) {
          if (books[i].isDefault === true) {
            found = books[i];
            break;
          }
          if (!found) found = books[i];
        }
      }
    }
    var nextId = found ? found.id : null;
    state.ui.activeBookId = nextId;
    if (prefsCache.activeBookId !== nextId) {
      prefsCache.activeBookId = nextId;
      writePrefs(prefsCache);
    }
    if (state.db && state.db.settings) {
      state.ui.hideAmounts = !!state.db.settings.hideAmounts;
    }
  }

  /* ---------------- v1 迁移 ---------------- */

  function migrateIfNeeded() {
    if (!migrate || typeof migrate.hasV1Data !== 'function') return Promise.resolve();
    var hasV1 = false;
    try {
      hasV1 = !!migrate.hasV1Data();
    } catch (error) {
      return Promise.resolve();
    }
    if (!hasV1) return Promise.resolve();

    /* v2 已有流水视为迁移完成，避免每次启动重复合并 */
    if (state.db && state.db.transactions && state.db.transactions.length > 0) {
      return Promise.resolve();
    }

    var result;
    try {
      result = migrate.fromLocalStorage({ mode: 'merge', currentDb: state.db });
    } catch (error) {
      migrationError = error;
      return Promise.resolve();
    }
    if (!result || !result.ok || !result.db) {
      migrationError = result || { code: 'E_MIGRATE' };
      return Promise.resolve();
    }

    var migrated = result.db;
    return store.transaction(function (draft) {
      TABLES.forEach(function (name) {
        draft[name] = clone(migrated[name] || []);
      });
      if (migrated.settings) draft.settings = clone(migrated.settings);
      return { value: true };
    }).then(function (written) {
      if (!written || !written.ok) {
        migrationError = written || { code: 'E_MIGRATE_WRITE' };
        return;
      }
      state.db = store.get();
      syncStorage();
      var report = result.report || {};
      bootNotice = {
        type: 'success',
        message: '旧版数据已并入账本' + (report.transactions ? '（' + report.transactions + ' 笔流水）' : '')
      };
    }, function (error) {
      migrationError = error;
    });
  }

  /* ---------------- 写事务 ---------------- */

  function copyDb(target, source) {
    if (!target || !source) return;
    TABLES.forEach(function (name) {
      target[name] = clone(source[name] || []);
    });
    if (source.settings) target.settings = clone(source.settings);
  }

  function newUndoEntry(before, after, label, kind) {
    var stamp = Date.now();
    return {
      id: 'undo_' + stamp.toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      at: stamp,
      kind: kind || 'snapshot',
      label: label,
      bookId: state.ui.activeBookId,
      before: before,
      after: after
    };
  }

  /* T09 的 core/undo.js 尚未交付、API 未冻结；有同名入口时同步镜像一份，
     真正的撤销仍由本文件的全库快照栈兜底，避免两套栈互相污染。 */
  function mirrorUndoToCore(entry) {
    var undo = Core.undo;
    if (!undo) return;
    var fn = typeof undo.record === 'function' ? undo.record : (typeof undo.push === 'function' ? undo.push : null);
    if (!fn) return;
    try {
      fn({
        id: entry.id,
        at: entry.at,
        kind: 'tx.update',
        label: entry.label,
        bookId: entry.bookId,
        undo: { op: 'snapshot', payload: { db: entry.before } },
        redo: { op: 'snapshot', payload: { db: entry.after } }
      });
    } catch (error) {
      /* core/undo 不可用不应阻断保存 */
    }
  }

  /* D02（REVIEW-CODE）：撤销栈里每条都存 before/after 两份整库快照。
     流水越多单条越重（5000 条时约 1.2MB/份），iOS 上有 jetsam 风险，
     因此按当前流水量自适应降低可撤销步数：少流水时保持 30 步，多流水时收紧。 */
  function undoLimit() {
    var n = state.db && state.db.transactions ? state.db.transactions.length : 0;
    if (n > 1500) { return 6; }
    if (n > 800) { return 12; }
    return UNDO_LIMIT;
  }

  function pushUndo(entry) {
    state.session.undoStack.push(entry);
    if (state.session.undoStack.length > undoLimit()) state.session.undoStack.shift();
    state.session.redoStack = [];
    mirrorUndoToCore(entry);
  }

  function commit(mutator, options) {
    var opts = options || {};
    var label = opts.label ? String(opts.label) : '保存';

    if (typeof mutator !== 'function') {
      return Promise.resolve({ ok: false, code: 'E_INVALID_INPUT', message: '缺少写入函数' });
    }
    if (!state.db) {
      return Promise.resolve({ ok: false, code: 'E_NOT_READY', message: '数据尚未就绪' });
    }

    function run() {
      state.session.busy = true;
      state.storage.saving = true;
      state.storage.saveError = null;

      var before;
      var working;
      var returned;
      try {
        before = clone(state.db);
        working = clone(state.db);
        returned = mutator(working);
      } catch (error) {
        state.session.busy = false;
        state.storage.saving = false;
        state.storage.saveError = error && error.message ? error.message : '写入失败';
        return Promise.resolve({ ok: false, code: 'E_COMMIT', message: '保存失败，请重试' });
      }

      return Promise.resolve(returned).then(function (result) {
        if (result && result.abort) {
          return {
            ok: false,
            code: result.code || 'E_ABORTED',
            message: result.message || '已取消'
          };
        }
        var value = result && typeof result === 'object' ? result.value : result;
        return store.transaction(function (draft) {
          copyDb(draft, working);
          return { value: value };
        });
      }).then(function (written) {
        if (!written || !written.ok) {
          return {
            ok: false,
            code: (written && written.code) || 'E_STORAGE_WRITE',
            message: (written && written.message) || '保存失败，请重试'
          };
        }
        state.db = store.get();
        syncStorage();
        if (opts.undo !== false) {
          var entry = newUndoEntry(before, clone(state.db), label, opts.kind);
          pushUndo(entry);
        } else if (opts.clearRedo !== false) {
          state.session.redoStack = [];
        }
        state.session.lastActionAt = Date.now();
        return { ok: true, value: written.value, label: label };
      }).then(function (result) {
        state.session.busy = false;
        state.storage.saving = false;
        if (!result.ok) {
          state.storage.saveError = result.message;
          return result;
        }
        return refresh().then(function () {
          return result;
        });
      }, function (error) {
        state.session.busy = false;
        state.storage.saving = false;
        state.storage.saveError = error && error.message ? error.message : '保存失败';
        return { ok: false, code: 'E_COMMIT', message: '保存失败，请重试' };
      });
    }

    var task = opQueue.then(run, run);
    opQueue = task.then(function () {}, function () {});
    return task;
  }

  function refresh() {
    if (!state.db || !store) return Promise.resolve({ ok: true });
    return store.load().then(function (loaded) {
      if (loaded && loaded.ok) {
        state.db = store.get();
        syncStorage();
        reconcileActiveBook();
        if (XZB.router && typeof XZB.router.rerender === 'function') {
          XZB.router.rerender();
        }
      }
      return loaded || { ok: false, code: 'E_STORAGE_READ' };
    }, function (error) {
      return { ok: false, code: 'E_STORAGE_READ', message: error && error.message };
    });
  }

  function undo() {
    if (state.session.busy) {
      return Promise.resolve({ ok: false, code: 'E_BUSY', message: '正在保存，请稍后' });
    }
    var entry = state.session.undoStack[state.session.undoStack.length - 1];
    if (!entry) {
      return Promise.resolve({ ok: false, code: 'E_UNDO_EMPTY', message: '没有可撤销的操作' });
    }
    state.session.undoStack.pop();
    return commit(function (working) {
      copyDb(working, entry.before);
    }, { label: '撤销', undo: false, clearRedo: false }).then(function (result) {
      if (result && result.ok) {
        state.session.redoStack.push(entry);
        if (UI.toast && typeof UI.toast.show === 'function') {
          UI.toast.show('已撤销', {
            type: 'info',
            action: { label: '重做', onClick: redo }
          });
        }
      } else {
        state.session.undoStack.push(entry);
        if (UI.toast && typeof UI.toast.show === 'function') {
          UI.toast.show((result && result.message) || '撤销失败', { type: 'danger' });
        }
      }
      return result;
    });
  }

  function redo() {
    if (state.session.busy) {
      return Promise.resolve({ ok: false, code: 'E_BUSY', message: '正在保存，请稍后' });
    }
    var entry = state.session.redoStack[state.session.redoStack.length - 1];
    if (!entry) {
      return Promise.resolve({ ok: false, code: 'E_REDO_EMPTY', message: '没有可重做的操作' });
    }
    state.session.redoStack.pop();
    return commit(function (working) {
      copyDb(working, entry.after);
    }, { label: '重做', undo: false, clearRedo: false }).then(function (result) {
      if (result && result.ok) {
        state.session.undoStack.push(entry);
        if (state.session.undoStack.length > undoLimit()) state.session.undoStack.shift();
        if (UI.toast && typeof UI.toast.show === 'function') {
          UI.toast.show('已重做', { type: 'success' });
        }
      } else {
        state.session.redoStack.push(entry);
        if (UI.toast && typeof UI.toast.show === 'function') {
          UI.toast.show((result && result.message) || '重做失败', { type: 'danger' });
        }
      }
      return result;
    });
  }

  /* ---------------- 启动 ---------------- */

  function injectTabIcons() {
    var nodes = document.querySelectorAll('[data-tab-icon]');
    if (!nodes.length) return;
    for (var i = 0; i < nodes.length; i += 1) {
      var holder = nodes[i];
      if (!holder || holder.childNodes.length) continue;
      var name = holder.getAttribute('data-tab-icon');
      var svg = UI.icons && typeof UI.icons.node === 'function' ? UI.icons.node(name, { size: 28 }) : null;
      if (svg) {
        holder.setAttribute('aria-hidden', 'true');
        holder.appendChild(svg);
      }
    }
  }

  function isStandalone() {
    try {
      if (global.navigator && global.navigator.standalone === true) return true;
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
      if (global.matchMedia && global.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (error) {
      return false;
    }
    return false;
  }

  function isIOS() {
    var nav = global.navigator || {};
    var ua = String(nav.userAgent || '');
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
  }

  function setupInstallGuide() {
    if (!isIOS() || isStandalone() || prefsCache.installDismissed) return;

    var card = document.createElement('aside');
    card.className = 'app-install';
    card.setAttribute('role', 'note');
    card.setAttribute('aria-label', '添加到主屏幕提示');

    var main = document.createElement('div');
    main.className = 'app-install__main';
    var title = document.createElement('p');
    title.className = 'app-install__title';
    title.textContent = '把小账本添加到主屏幕';
    var text = document.createElement('p');
    text.className = 'app-install__text';
    text.textContent = '点 Safari 底部的「分享」，再选「添加到主屏幕」，离线也能记账。';
    main.appendChild(title);
    main.appendChild(text);

    var close = document.createElement('button');
    close.className = 'app-install__close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭安装提示');
    var closeIcon = UI.icons && typeof UI.icons.node === 'function' ? UI.icons.node('close', { size: 20 }) : null;
    if (closeIcon) {
      close.appendChild(closeIcon);
    } else {
      close.textContent = '关闭';
    }
    close.addEventListener('click', function () {
      prefsApi.set('installDismissed', true);
      card.classList.remove('is-visible');
      global.setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
      }, 260);
    });

    card.appendChild(main);
    card.appendChild(close);
    document.body.appendChild(card);
    global.setTimeout(function () {
      card.classList.add('is-visible');
    }, 30);
  }

  function registerServiceWorker() {
    if (!global.navigator || !('serviceWorker' in global.navigator)) return;
    var protocol = global.location ? global.location.protocol : '';
    if (protocol !== 'http:' && protocol !== 'https:') return;
    try {
      var registration = global.navigator.serviceWorker.register('pwa/sw.js');
      if (registration && typeof registration.catch === 'function') {
        registration.catch(function () { /* 注册失败静默，不影响使用 */ });
      }
    } catch (error) {
      /* 静默 */
    }
  }

  function dismissBoot() {
    var boot = document.getElementById('boot');
    var app = document.getElementById('app');
    if (app) app.setAttribute('aria-busy', 'false');
    if (!boot) return;
    boot.classList.add('is-done');
    var delay = 0;
    try {
      if (!global.matchMedia || !global.matchMedia('(prefers-reduced-motion: reduce)').matches) delay = 200;
    } catch (error) {
      delay = 200;
    }
    global.setTimeout(function () {
      if (boot.parentNode) boot.parentNode.removeChild(boot);
    }, delay);
  }

  function renderFatal(error) {
    var root = document.getElementById('view-root');
    var tabbar = document.getElementById('tabbar');
    var app = document.getElementById('app');
    if (tabbar) tabbar.hidden = true;
    if (app) app.classList.add('is-subpage');
    if (!root) return;

    while (root.firstChild) root.removeChild(root.firstChild);
    var box = document.createElement('div');
    box.className = 'app-fatal';

    var title = document.createElement('h1');
    title.className = 'app-fatal__title';
    title.textContent = '本地数据暂时打不开';
    var text = document.createElement('p');
    text.className = 'app-fatal__text';
    text.textContent = '可以重新加载试试。如果同时开着多个小账本页面，请先关闭其他页面。';
    var retry = document.createElement('button');
    retry.className = 'app-fatal__btn';
    retry.type = 'button';
    retry.textContent = '重新加载';
    retry.addEventListener('click', function () {
      try { global.location.reload(); } catch (error2) { /* 忽略 */ }
    });

    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(retry);

    if (error && (error.code || error.message)) {
      var detail = document.createElement('p');
      detail.className = 'app-fatal__text';
      detail.textContent = '错误：' + String(error.code || error.message);
      box.appendChild(detail);
    }

    root.appendChild(box);
    if (UI.toast && typeof UI.toast.show === 'function') {
      UI.toast.show('本地数据加载失败，请重试', { type: 'danger' });
    }
  }

  function reportGlobalError(error, source) {
    if (global.console && console.error) {
      console.error('[小账本] ' + (source || '错误'), error);
    }
    if (!UI.toast || typeof UI.toast.show !== 'function') return;
    var now = Date.now();
    if (now - lastErrorToastAt < 4000) return;
    lastErrorToastAt = now;
    UI.toast.show('出了点小问题，请重试', { type: 'danger' });
  }

  function flushPending() {
    if (!store || typeof store.flush !== 'function') return;
    try {
      var result = store.flush();
      if (result && typeof result.catch === 'function') {
        result.catch(function () { /* 页面隐藏时的兜底写入失败不弹错 */ });
      }
    } catch (error) {
      /* 忽略 */
    }
  }

  function boot() {
    if (bootStarted) return readyPromise;
    bootStarted = true;

    if (!store || typeof store.open !== 'function') {
      state.bootError = { code: 'E_BOOT', message: '核心存储模块未加载' };
      renderFatal(state.bootError);
      state.ready = true;
      readyResolve(state);
      dismissBoot();
      return readyPromise;
    }

    applyTheme();
    watchThemeMedia();

    Promise.resolve().then(function () {
      return store.open();
    }).then(function () {
      return store.load();
    }).then(function (loaded) {
      if (!loaded || !loaded.ok) {
        throw loaded || { code: 'E_STORAGE_READ', message: '读取失败' };
      }
      state.db = store.get();
      syncStorage();
      if (loaded.meta && loaded.meta.degraded) state.storage.degraded = true;
      if (loaded.meta && loaded.meta.source === 'memory' && state.storage.mode !== 'memory') {
        state.storage.degraded = true;
      }
      return migrateIfNeeded();
    }).then(function () {
      if (!state.db) throw { code: 'E_STORAGE_READ', message: '数据为空' };

      reconcileActiveBook();

      if (typeof store.subscribe === 'function') {
        store.subscribe(function () {
          state.rev = typeof store.getRev === 'function' ? store.getRev() : state.rev;
          state.storage.lastSavedAt = typeof store.getSavedAt === 'function' ? store.getSavedAt() : state.storage.lastSavedAt;
        });
      }

      applyTheme();
      injectTabIcons();

      state.ready = true;
      readyResolve(state);

      if (XZB.router && typeof XZB.router.start === 'function') {
        XZB.router.start();
      }

      /* 定期账单自动入账：设置里的开关是唯一入口，打开后每次启动补记到期实例。
       * 与「计划」页的「一键补账」共用同一段逻辑（core/recurrence.catchUp），
       * 只是不打断启动、不记撤销点。 */
      autoPostDueRecurring().then(function (posted) {
        if (posted > 0 && XZB.router && typeof XZB.router.rerender === 'function') {
          try { XZB.router.rerender(); } catch (error) { /* 渲染失败不影响已入账的数据 */ }
        }
      });

      setupInstallGuide();
      registerServiceWorker();
      dismissBoot();

      if (migrationError) {
        if (UI.toast && typeof UI.toast.show === 'function') {
          UI.toast.show('旧数据迁移失败，已进入空账本', { type: 'danger' });
        }
      } else if (bootNotice && UI.toast && typeof UI.toast.show === 'function') {
        UI.toast.show(bootNotice.message, { type: bootNotice.type || 'success' });
      } else if (state.storage.degraded && state.storage.mode === 'memory') {
        if (UI.toast && typeof UI.toast.show === 'function') {
          UI.toast.show('当前浏览器无法持久化，数据仅在本次会话有效', { type: 'warning' });
        }
      }
    }).catch(function (error) {
      state.bootError = error || { code: 'E_BOOT', message: '启动失败' };
      state.ready = true;
      readyResolve(state);
      renderFatal(state.bootError);
      dismissBoot();
    });

    return readyPromise;
  }

  function loadedNotice() {
    return !!bootNotice;
  }

  /* 到期定期账单自动补记。只在设置开关打开时生效；最多一次补 31 条，避免启动卡顿。 */
  function autoPostDueRecurring() {
    var db = state.db;
    if (!db || !db.settings || db.settings.recurringAutoPost !== true) { return Promise.resolve(0); }
    var core = XZB.core || {};
    var rec = core.recurrence;
    var dates = core.dates;
    if (!rec || typeof rec.catchUp !== 'function' ||
        !dates || typeof dates.todayStr !== 'function') {
      return Promise.resolve(0);
    }
    var today = dates.todayStr();
    var due = [];
    try {
      due = typeof rec.dueInstances === 'function' ? rec.dueInstances(db, today, {}) : [];
    } catch (error) {
      due = [];
    }
    if (!due || !due.length) { return Promise.resolve(0); }
    return commit(function (draft) {
      var summary = rec.catchUp(draft, draft, today, { autoPostOnly: false, max: 31 });
      return { value: summary };
    }, { label: '定期账单自动入账', undo: false }).then(function (res) {
      var posted = (res && res.value && Number(res.value.posted)) || 0;
      if (posted > 0 && UI.toast && typeof UI.toast.show === 'function') {
        UI.toast.show('已自动记入 ' + posted + ' 笔到期账单', { type: 'success' });
      }
      return posted;
    }).catch(function () {
      return 0;
    });
  }

  /* ---------------- 生命周期 ---------------- */

  function onDOMReady() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushPending();
  });
  global.addEventListener('pagehide', flushPending);

  global.addEventListener('error', function (event) {
    if (event && event.target && event.target !== global) return;
    reportGlobalError((event && event.error) || (event && event.message), '未捕获异常');
  });

  global.addEventListener('unhandledrejection', function (event) {
    reportGlobalError(event && event.reason, '未处理的 Promise');
  });

  var api = {
    db: function () { return state.db; },
    refresh: refresh,
    commit: commit,
    prefs: Object.freeze(prefsApi),
    ready: readyPromise,
    boot: boot,
    undo: undo,
    redo: redo,
    canUndo: function () { return state.session.undoStack.length > 0; },
    canRedo: function () { return state.session.redoStack.length > 0; },
    setTheme: function (theme) { prefsApi.set('theme', theme); },
    getState: function () { return state; }
  };
  Object.defineProperty(api, 'state', {
    enumerable: true,
    configurable: false,
    get: function () { return state; }
  });
  Object.freeze(api);

  XZB.app = api;
  XZB.App = api;

  onDOMReady();
}(window));
