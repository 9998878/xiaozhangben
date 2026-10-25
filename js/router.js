/* ============================================================
   小账本 2.0 · 路由（hash 路由 + 内存导航栈）
   形态：#/<view>[/<sub>][?k=v]
   职责：注册屏幕、解析地址、维护返回栈、渲染壳层、滚动恢复、
         TabBar 同步、无障碍焦点与切屏动画。
   约束：零网络；只操作 DOM；数据读写一律交给 XZB.app。
   ============================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB = global.XZB || {};

  /* 八个冻结视图；顺序仅用于诊断输出 */
  var VIEWS = ['home', 'add', 'ledger', 'stats', 'accounts', 'books', 'plan', 'settings'];
  /* 只有这四个是一级 Tab 根；plan 是二级页，不出现在 TabBar */
  var TAB_ROOTS = ['home', 'ledger', 'stats', 'settings'];

  var DEFAULT_TITLES = {
    home: '概览',
    add: '记一笔',
    ledger: '明细',
    stats: '统计',
    accounts: '账户',
    books: '账本',
    plan: '计划',
    settings: '我的'
  };

  /* 已注册屏幕：key -> {key,title,subtitle,render} */
  var screens = {};

  var started = false;
  var currentRoute = null;
  var stack = [];
  var index = -1;
  var scrollMemory = {};
  var rootEl = null;
  var appEl = null;
  var tabbarEl = null;
  var lastFocusAt = 0;
  var popTimer = null;

  /* ---------------- 基础工具 ---------------- */

  function reducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  }

  function clonePlain(value) {
    var out = {};
    if (!value || typeof value !== 'object') return out;
    Object.keys(value).forEach(function (key) {
      out[key] = value[key];
    });
    return out;
  }

  function safeDecode(text) {
    try {
      return decodeURIComponent(String(text));
    } catch (error) {
      return String(text);
    }
  }

  function toast(message, type) {
    if (XZB.ui && XZB.ui.toast && typeof XZB.ui.toast.show === 'function') {
      XZB.ui.toast.show(message, { type: type || 'warning' });
    } else if (global.console && console.warn) {
      console.warn('[小账本] ' + message);
    }
  }

  function isTabRoot(route) {
    return !!route && !route.sub && TAB_ROOTS.indexOf(route.view) >= 0;
  }

  function isKnownView(view) {
    return VIEWS.indexOf(view) >= 0;
  }

  /* ---------------- 地址解析 ---------------- */

  function buildHash(route) {
    var hash = '#/' + encodeURIComponent(route.view);
    if (route.sub) hash += '/' + encodeURIComponent(route.sub);
    var params = route.params || {};
    var keys = Object.keys(params).sort();
    var pairs = [];
    keys.forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '') return;
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    });
    if (pairs.length) hash += '?' + pairs.join('&');
    return hash;
  }

  function parseHash(input) {
    var raw = String(input === undefined || input === null ? '' : input).trim();
    if (!raw) return null;
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    if (!raw) return null;

    var qIndex = raw.indexOf('?');
    var pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
    var queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
    var parts = pathPart.split('/').filter(function (part) { return part !== ''; });
    if (!parts.length) return null;

    var view = safeDecode(parts[0]);
    /* 地址别名：#/mine 与「我的」Tab 指的是同一个屏。
       以前 #/mine 会被判成未知视图、回落到概览，检查脚本却以为通过了。
       VIEWS 数组保持 8 项不变（A5-4），别名只在这一层做。 */
    if (view === 'mine') { view = 'settings'; }
    var sub = parts.length > 1 ? safeDecode(parts[1]) : '';
    var params = {};

    if (queryPart) {
      queryPart.split('&').forEach(function (pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        var key = eq >= 0 ? pair.slice(0, eq) : pair;
        var value = eq >= 0 ? pair.slice(eq + 1) : '';
        key = safeDecode(key.replace(/\+/g, ' '));
        value = safeDecode(value.replace(/\+/g, ' '));
        if (key) params[key] = value;
      });
    }

    var route = { view: view, sub: sub, params: params };
    route.hash = buildHash(route);
    route.key = route.hash;
    return route;
  }

  function normalizeHash(input) {
    var text = String(input === undefined || input === null ? '' : input).trim();
    if (!text) return '#/home';
    if (text.charAt(0) === '#') return text;
    if (text.charAt(0) === '/') return '#' + text;
    return '#/' + text;
  }

  /* ---------------- 屏幕注册 ---------------- */

  function register(key, mod) {
    if (!isKnownView(key)) {
      if (global.console && console.warn) console.warn('[小账本] 未知屏幕 key：' + key);
      return false;
    }
    if (!mod || typeof mod.render !== 'function') {
      if (global.console && console.warn) console.warn('[小账本] 屏幕 ' + key + ' 缺少 render 函数');
      return false;
    }
    var meta = {
      key: key,
      title: mod.title ? String(mod.title) : DEFAULT_TITLES[key],
      subtitle: mod.subtitle ? String(mod.subtitle) : '',
      render: mod.render
    };
    screens[key] = Object.freeze(meta);
    /* 屏幕文件在 app 启动之后才注册时（理论上不发生），补渲染当前页 */
    if (started && currentRoute && currentRoute.view === key) {
      renderRoute(currentRoute, getCurrentScroll(), { animate: false });
    }
    return true;
  }

  function getScreen(key) {
    return screens[key] || null;
  }

  function listScreens() {
    return Object.keys(screens);
  }

  /* ---------------- 历史栈 ---------------- */

  function entryFor(route, scrollY) {
    return {
      key: route.key,
      hash: route.hash,
      view: route.view,
      sub: route.sub,
      params: clonePlain(route.params),
      scrollY: Number(scrollY) || 0
    };
  }

  function publishState() {
    if (!XZB.app || !XZB.app.state) return;
    XZB.app.state.route = {
      view: currentRoute ? currentRoute.view : 'home',
      sub: currentRoute ? currentRoute.sub : '',
      params: currentRoute ? clonePlain(currentRoute.params) : {}
    };
    XZB.app.state.nav = { stack: stack, index: index };
  }

  function getScreenEl() {
    return rootEl ? rootEl.firstElementChild : null;
  }

  function getCurrentScroll() {
    var el = getScreenEl();
    return el ? (el.scrollTop || 0) : 0;
  }

  function saveCurrentScroll() {
    if (!currentRoute) return;
    var y = getCurrentScroll();
    if (index >= 0 && stack[index]) stack[index].scrollY = y;
    scrollMemory[currentRoute.key] = y;
    scrollMemory[currentRoute.view] = y;
    publishState();
  }

  function memoryFor(route) {
    if (scrollMemory[route.key] !== undefined) return scrollMemory[route.key];
    if (scrollMemory[route.view] !== undefined) return scrollMemory[route.view];
    return 0;
  }

  function historyReplace(route, depth) {
    try {
      global.history.replaceState({ xzb: 1, depth: depth || 0 }, '', route.hash);
    } catch (error) {
      /* file:// 等环境下 History API 可能不可用；地址栏不更新也能继续使用 */
    }
  }

  function historyPush(route, depth) {
    try {
      global.history.pushState({ xzb: 1, depth: depth || 0 }, '', route.hash);
    } catch (error) {
      /* 同上，降级为纯内存导航 */
    }
  }

  /* 进入 Tab 根：历史栈重置为单条，浏览器后退不回到上一个 Tab */
  function replaceRoute(route, scrollY, animate) {
    saveCurrentScroll();
    stack = [entryFor(route, scrollY || 0)];
    index = 0;
    currentRoute = route;
    historyReplace(route, 0);
    publishState();
    renderRoute(route, scrollY || 0, { animate: animate !== false });
  }

  /* 进入二级页：从当前 Tab 根起压栈 */
  function pushRoute(route) {
    saveCurrentScroll();
    var base = stack.slice(0, index + 1);
    if (!base.length) base = [entryFor(route, 0)];
    base.push(entryFor(route, 0));
    stack = base;
    index = stack.length - 1;
    currentRoute = route;
    historyPush(route, index);
    publishState();
    renderRoute(route, 0, { animate: true });
  }

  function go(input) {
    var route = parseHash(normalizeHash(input));
    if (!route) return false;
    if (!isKnownView(route.view)) {
      toast('页面不存在，已回到概览');
      return false;
    }
    if (currentRoute && route.key === currentRoute.key) {
      var el = getScreenEl();
      if (el) el.scrollTop = 0;
      return true;
    }
    if (isTabRoot(route)) {
      replaceRoute(route, memoryFor(route), true);
    } else {
      pushRoute(route);
    }
    return true;
  }

  function replace(input) {
    var route = parseHash(normalizeHash(input));
    if (!route || !isKnownView(route.view)) return false;
    replaceRoute(route, 0, false);
    return true;
  }

  function back() {
    if (currentRoute && !isTabRoot(currentRoute) && stack.length > 1 && index > 0) {
      try {
        global.history.back();
        return true;
      } catch (error) {
        /* 继续走下面的兜底 */
      }
    }
    var home = parseHash('#/home');
    if (!currentRoute || currentRoute.view !== 'home') {
      replaceRoute(home, memoryFor(home), false);
    } else {
      var el = getScreenEl();
      if (el) el.scrollTop = 0;
    }
    return true;
  }

  function current() {
    if (!currentRoute) return null;
    return {
      view: currentRoute.view,
      sub: currentRoute.sub,
      params: clonePlain(currentRoute.params),
      query: clonePlain(currentRoute.params),
      hash: currentRoute.hash,
      key: currentRoute.key
    };
  }

  /* ---------------- 壳层渲染 ---------------- */

  function make(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function iconNode(name, size) {
    if (XZB.ui && XZB.ui.icons && typeof XZB.ui.icons.node === 'function') {
      try {
        return XZB.ui.icons.node(name, { size: size || 24 });
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function buildNav(route, title) {
    var nav = make('header', 'app-nav');
    if (!isTabRoot(route)) {
      nav.className = 'app-nav app-nav--title';
      var backBtn = make('button', 'app-nav__back');
      backBtn.type = 'button';
      backBtn.setAttribute('aria-label', '返回');
      var backIcon = iconNode('back', 24);
      if (backIcon) {
        backBtn.appendChild(backIcon);
      } else {
        backBtn.textContent = '‹';
      }
      backBtn.addEventListener('click', function (event) {
        event.preventDefault();
        back();
      });
      nav.appendChild(backBtn);

      var h1 = make('h1', 'app-nav__title', title);
      h1.setAttribute('tabindex', '-1');
      nav.appendChild(h1);

      var spacer = make('span', 'app-nav__spacer');
      spacer.setAttribute('aria-hidden', 'true');
      nav.appendChild(spacer);
    }
    return nav;
  }

  function buildLargeTitle(title, subtitle) {
    var wrap = make('header', 'app-large');
    var h1 = make('h1', 'c-large-title app-title', title);
    h1.setAttribute('tabindex', '-1');
    wrap.appendChild(h1);
    if (subtitle) {
      wrap.appendChild(make('p', 'c-large-title__sub', subtitle));
    }
    return wrap;
  }

  function buildPlaceholder(key, isMissing) {
    var box = make('div', 'c-empty');
    var title = isMissing ? '「' + (DEFAULT_TITLES[key] || key) + '」正在搭建中' : '这个页面暂时没能显示';
    var p = make('p', 'c-empty__title', title);
    box.appendChild(p);
    var hint = make('p', 'c-empty__text', isMissing ? '屏幕文件交付后会由同一套路由接口接管。' : '可以稍后重试，或返回上一页。');
    box.appendChild(hint);
    return box;
  }

  function showScreenError(body, error) {
    if (global.console && console.error) console.error('[小账本] 屏幕渲染失败', error);
    body.appendChild(buildPlaceholder(currentRoute ? currentRoute.view : 'home', false));
    var retry = make('button', 'c-btn c-btn--secondary', '重新加载');
    retry.type = 'button';
    retry.addEventListener('click', function () { rerender(); });
    body.appendChild(retry);
    toast('这个页面暂时没能显示', { type: 'danger' });
  }

  function callScreen(meta, body, ctx) {
    try {
      var result = meta.render(body, ctx);
      if (result && typeof result.then === 'function') {
        result.then(null, function (error) {
          showScreenError(body, error);
        });
      }
    } catch (error) {
      showScreenError(body, error);
    }
  }

  function buildContext(route) {
    var app = XZB.app || null;
    var ctx = {
      view: route.view,
      sub: route.sub,
      params: clonePlain(route.params),
      query: clonePlain(route.params),
      route: current(),
      go: go,
      back: back,
      replace: replace,
      refresh: rerender,
      setTitle: setTitle,
      toast: function (message, options) {
        if (XZB.ui && XZB.ui.toast) XZB.ui.toast.show(message, options);
      },
      icons: XZB.ui ? XZB.ui.icons : null,
      dom: XZB.dom || null,
      db: app ? app.db() : null,
      state: app ? app.state : null,
      prefs: app ? app.prefs : null,
      commit: app ? app.commit : null,
      sheet: XZB.ui ? XZB.ui.sheet : null
    };
    return ctx;
  }

  function syncChrome(route) {
    var showTab = isTabRoot(route);
    if (appEl) appEl.classList.toggle('is-subpage', !showTab);
    if (tabbarEl) {
      tabbarEl.hidden = !showTab;
      var items = tabbarEl.querySelectorAll('[data-tab]');
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        var active = showTab && item.getAttribute('data-tab') === route.view;
        item.classList.toggle('is-active', active);
        if (active) {
          item.setAttribute('aria-current', 'page');
        } else {
          item.removeAttribute('aria-current');
        }
      }
    }
    var title = document.title;
    if (screens[route.view]) {
      title = screens[route.view].title + ' · 小账本';
    } else {
      title = (DEFAULT_TITLES[route.view] || '小账本') + ' · 小账本';
    }
    document.title = title;
  }

  function focusTitle(screenEl) {
    var h1 = screenEl.querySelector('h1');
    if (!h1) return;
    var now = Date.now();
    if (now - lastFocusAt < 40) return;
    lastFocusAt = now;
    try {
      h1.focus({ preventScroll: true });
    } catch (error) {
      try { h1.focus(); } catch (ignore) { /* 忽略焦点失败 */ }
    }
  }

  function renderRoute(route, scrollTop, options) {
    if (!rootEl) return;
    var opts = options || {};
    currentRoute = route;
    publishState();

    var meta = screens[route.view] || null;
    var isMissing = !meta;
    var title = meta ? meta.title : (DEFAULT_TITLES[route.view] || route.view);
    var subtitle = meta ? meta.subtitle : '';

    var screenEl = make('section', 'app-screen');
    screenEl.setAttribute('data-view', route.view);
    screenEl.appendChild(buildNav(route, title));
    if (isTabRoot(route)) {
      screenEl.appendChild(buildLargeTitle(title, subtitle));
    }

    var body = make('div', 'app-screen__body s-' + route.view);
    body.setAttribute('data-screen', route.view);
    screenEl.appendChild(body);

    if (isMissing) {
      body.appendChild(buildPlaceholder(route.view, true));
    } else {
      callScreen(meta, body, buildContext(route));
    }

    var usedVT = false;
    var swapped = false;

    function swapDom() {
      if (swapped) return;
      swapped = true;
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
      rootEl.appendChild(screenEl);
      syncChrome(route);
      if (!usedVT && opts.animate !== false && !reducedMotion()) {
        screenEl.classList.add('app-screen--enter');
      }
      try {
        screenEl.scrollTop = Number(scrollTop) || 0;
      } catch (error) {
        /* 忽略 */
      }
      focusTitle(screenEl);
      if (typeof opts.after === 'function') opts.after();
    }

    if (document.startViewTransition && opts.animate !== false && !reducedMotion()) {
      try {
        usedVT = true;
        var vt = document.startViewTransition(swapDom);
        if (vt && vt.finished && typeof vt.finished.catch === 'function') {
          vt.finished.catch(function () { /* 过渡被中断不影响页面 */ });
        }
      } catch (error) {
        usedVT = false;
        swapDom();
      }
    } else {
      swapDom();
    }
  }

  function rerender() {
    if (!currentRoute) return;
    var y = getCurrentScroll();
    renderRoute(currentRoute, y, { animate: false });
  }

  function setTitle(title, subtitle) {
    if (!currentRoute || title === undefined || title === null) return;
    var text = String(title);
    var h1 = rootEl ? rootEl.querySelector('.app-title, .app-nav__title') : null;
    if (h1) h1.textContent = text;
    if (subtitle !== undefined && subtitle !== null) {
      var sub = rootEl ? rootEl.querySelector('.c-large-title__sub') : null;
      if (sub) sub.textContent = String(subtitle);
    }
    document.title = text + ' · 小账本';
  }

  /* ---------------- 地址同步 ---------------- */

  function handleLocationChange() {
    if (!started) return;
    var route = parseHash(global.location.hash);
    if (!route) {
      var home = parseHash('#/home');
      historyReplace(home, 0);
      replaceRoute(home, 0, false);
      return;
    }
    if (!isKnownView(route.view)) {
      toast('页面不存在，已回到概览');
      var fallback = parseHash('#/home');
      historyReplace(fallback, 0);
      replaceRoute(fallback, 0, false);
      return;
    }
    if (currentRoute && route.key === currentRoute.key) return;

    saveCurrentScroll();
    var targetIndex = -1;
    if (index > 0 && stack[index - 1] && stack[index - 1].key === route.key) {
      targetIndex = index - 1;
    } else if (stack[index + 1] && stack[index + 1].key === route.key) {
      targetIndex = index + 1;
    }

    if (targetIndex >= 0) {
      index = targetIndex;
      currentRoute = route;
      publishState();
      var entry = stack[index] || entryFor(route, 0);
      renderRoute(route, entry.scrollY || 0, { animate: true });
      return;
    }

    /* 用户手工改地址栏或外部 hash：重置为单条栈 */
    stack = [entryFor(route, memoryFor(route))];
    index = 0;
    currentRoute = route;
    historyReplace(route, 0);
    publishState();
    renderRoute(route, stack[0].scrollY || 0, { animate: false });
  }

  function scheduleLocationSync() {
    if (popTimer) return;
    popTimer = global.setTimeout(function () {
      popTimer = null;
      handleLocationChange();
    }, 0);
  }

  function onDocumentClick(event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var node = event.target;
    while (node && node !== document && node.nodeType === 1) {
      if (node.tagName === 'A' && node.getAttribute) {
        var href = node.getAttribute('href') || '';
        if (href.indexOf('#/') === 0) {
          event.preventDefault();
          go(href);
          return;
        }
      }
      node = node.parentNode;
    }
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    if (started) return api;

    rootEl = document.getElementById('view-root');
    appEl = document.getElementById('app');
    tabbarEl = document.getElementById('tabbar');
    if (!rootEl) {
      if (global.console && console.error) console.error('[小账本] 缺少 #view-root，无法启动路由');
      return api;
    }

    started = true;

    var route = parseHash(global.location.hash);
    var unknown = false;
    if (!route) {
      route = parseHash('#/home');
      historyReplace(route, 0);
    } else if (!isKnownView(route.view)) {
      unknown = true;
      route = parseHash('#/home');
      historyReplace(route, 0);
    }

    stack = [entryFor(route, 0)];
    index = 0;
    currentRoute = route;
    publishState();
    renderRoute(route, 0, { animate: false });

    /* 初次渲染时 startViewTransition 尚未绑定，这里补一次焦点 */
    var first = getScreenEl();
    if (first) focusTitle(first);

    if (unknown) toast('页面不存在，已回到概览');

    global.addEventListener('popstate', scheduleLocationSync);
    global.addEventListener('hashchange', scheduleLocationSync);
    document.addEventListener('click', onDocumentClick, false);

    return api;
  }

  var screensApi = Object.freeze({
    register: register,
    get: getScreen,
    has: function (key) { return !!screens[key]; },
    list: listScreens,
    keys: VIEWS.slice()
  });

  var api = Object.freeze({
    start: start,
    go: go,
    replace: replace,
    back: back,
    current: current,
    rerender: rerender,
    register: register,
    setTitle: setTitle,
    isTabRoot: isTabRoot,
    parse: parseHash,
    hash: function (route) { return buildHash(route); },
    views: VIEWS.slice()
  });

  XZB.screens = screensApi;
  XZB.Screens = screensApi;
  XZB.router = api;
  XZB.Router = api;
}(window));
