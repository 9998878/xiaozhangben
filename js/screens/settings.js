/* ============================================================
   小账本 2.0 — 屏幕：设置（settings）
   owner: 前端#1（T13）
   依赖：XZB.core.{dates,schema,store,migrate,backup} / XZB.dom / XZB.ui.{icons,toast,sheet}
   读：XZB.app.db()（同时用 ctx.db 快照）；写：XZB.app.commit(mutator,{label})
   导出 / 导入 / 快照 / 恢复 / 清空 / 迁移：一律走 backup.js 与 store.js 的公开 API，
   不直接碰 IndexedDB，不读写 localStorage（迁移检测由 migrate.hasV1Data 负责）。
   ============================================================ */
(function (global) {
  'use strict';

  var XZB = global.XZB;
  if (!XZB || !XZB.screens) { return; }

  var dom = XZB.dom || (XZB.ui && XZB.ui.dom) || null;

  var KEY = 'settings';
  var MAX_ITEM_NAME = 8;
  var CONFIRM_CLEAR = '清空';
  var SNAP_PAGE = 10;
  var TONE_COUNT = 12;

  /* 惰性读取：settings.js 先于 app.js 执行，此刻 XZB.version 还没就位，
     必须等渲染时再取，否则「关于」页永远显示兜底旧版本 */
  function appVersion() {
    return XZB.version || '2.7.0';
  }

  var THEMES = [
    { value: 'auto', label: '自动' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' }
  ];

  var REASON_LABEL = {
    auto: '自动',
    manual: '手动',
    'pre-import': '导入前',
    'pre-restore': '恢复前',
    'pre-migrate': '迁移前',
    'pre-clear': '清空前'
  };

  var MESSAGES = {
    E_UNKNOWN: '操作失败，请重试',
    E_INVALID_INPUT: '输入不完整或格式不对',
    E_STORAGE_FALLBACK: '当前使用临时存储，关闭页面后数据会丢失',
    E_STORAGE_QUOTA: '存储空间不足，请先导出备份并清理旧快照',
    E_STORAGE_CORRUPT: '本地数据损坏，可从快照恢复',
    E_STORAGE_VERSION: '数据版本高于当前应用，请更新应用',
    E_STORAGE_WRITE: '保存失败，请重试',
    E_STORE_BUSY: '正在保存，请稍后',
    E_SNAPSHOT_NOT_FOUND: '快照不存在或已被清理',
    E_SNAPSHOT_TOO_LARGE: '数据太大，无法创建快照',
    E_EXPORT_FAILED: '导出失败，请重试',
    E_IMPORT_EMPTY: '文件是空的',
    E_IMPORT_TOO_LARGE: '文件超过 10MB，无法导入',
    E_IMPORT_INVALID: '不是小账本备份文件',
    E_IMPORT_FAILED: '导入失败，数据已回滚',
    E_CATEGORY_MISSING: '分类不存在',
    E_CATEGORY_KIND: '分类的收支类型不匹配',
    E_CATEGORY_DUP: '同类型下已有同名分类',
    E_CATEGORY_NAME: '系统分类不能改名',
    E_CATEGORY_NAME_EMPTY: '请输入分类名称',
    E_CATEGORY_NAME_LONG: '分类名称最多 8 个字',
    E_FILE_READ: '文件读取失败，请重试',
    E_COMMIT: '保存失败，请重试',
    E_MIGRATE_INVALID: '旧版数据格式不对，无法迁移'
  };

  /* 分类图标：2.2 换成一整套细线图标，按「吃穿住行 → 人 → 杂项 → 收入」排。
     key 与 icons.js 的 PATHS 一一对应；labels 只用于读屏与提示，不参与存储。 */
  var CAT_ICON_CHOICES = [
    'food', 'bag', 'daily', 'bus', 'carrot', 'fruit', 'snack', 'sport',
    'fun', 'phone', 'shirt', 'beauty', 'house', 'sofa', 'baby', 'elder',
    'chat', 'plane', 'glass', 'plug', 'car', 'kit', 'book', 'cap',
    'pet', 'envelope', 'gift', 'briefcase', 'hammer', 'heart', 'ticket', 'family',
    'gamepad', 'wrench', 'washer', 'box',
    'salary', 'bonus', 'invest', 'parttime', 'redpacket',
    'target', 'tag', 'piggy', 'wallet', 'ellipsis'
  ];

  var CAT_ICON_LABELS = {
    food: '餐饮', bag: '购物', daily: '日用', bus: '交通', carrot: '蔬菜',
    fruit: '水果', snack: '零食', sport: '运动', fun: '娱乐', phone: '通讯',
    shirt: '服饰', beauty: '美容', house: '住房', sofa: '居家', baby: '孩子',
    elder: '长辈', chat: '社交', plane: '旅行', glass: '烟酒', plug: '数码',
    car: '汽车', kit: '医疗', book: '书籍', cap: '学习', pet: '宠物',
    envelope: '礼金', gift: '礼物', briefcase: '办公', hammer: '维修',
    heart: '捐赠', ticket: '彩票', family: '亲友', gamepad: '游戏',
    wrench: '工具', washer: '电器', box: '其他',
    salary: '工资', bonus: '奖金', invest: '理财', parttime: '兼职',
    redpacket: '红包', target: '目标', tag: '标签', piggy: '存钱',
    wallet: '钱包', ellipsis: '更多'
  };

  /* 当前挂载的根与上下文，供文件选择器与异步回调使用 */
  var live = { root: null, ctx: null, busy: false };

  /* ---------------- 模块访问 ---------------- */

  function coreMod(name) {
    return (XZB.core && XZB.core[name]) || null;
  }

  function backupApi() { return coreMod('backup'); }
  function storeApi() { return coreMod('store'); }
  function migrateApi() { return coreMod('migrate'); }
  function schemaApi() { return coreMod('schema'); }
  function statsApi() { return coreMod('stats'); }

  /* ---------------- 基础工具 ---------------- */

  function h(tag, attrs, children) {
    if (dom && typeof dom.el === 'function') { return dom.el(tag, attrs, children); }
    var node = global.document.createElement(tag);
    if (attrs && attrs.className) { node.className = attrs.className; }
    if (attrs && attrs.text !== undefined && attrs.text !== null) { node.textContent = String(attrs.text); }
    if (children) { node.appendChild(children); }
    return node;
  }

  function t(tag, className, value) {
    return h(tag, {
      className: className,
      text: value === undefined || value === null ? '' : String(value)
    });
  }

  function iconNode(name, size) {
    var api = XZB.ui && XZB.ui.icons;
    if (api && typeof api.node === 'function') {
      try { return api.node(name, { size: size || 20 }); } catch (error) { return null; }
    }
    return null;
  }

  function iconEl(name, size, className) {
    var wrap = h('span', { className: className || 's-settings-glyph' });
    var api = XZB.ui && XZB.ui.icons;
    var px = size || 20;
    /* icons.icon() 返回常量 SVG 字符串，经 dom.el 的 html 通道按 HTML 文档解析，
       命名空间才是正确的 svg（icons.node 解析出的节点在部分环境里是 0 高度）。 */
    if (api && typeof api.icon === 'function') {
      try {
        var svg = api.icon(name, { size: px });
        if (svg) {
          wrap.appendChild(h('span', { className: 's-settings-glyph__holder', html: svg }));
          return wrap;
        }
      } catch (error) { /* 回退到 node */ }
    }
    var node = iconNode(name, px);
    if (node) { wrap.appendChild(node); }
    return wrap;
  }

  function toast(ctx, message, options) {
    var opts = options || {};
    if (ctx && typeof ctx.toast === 'function') {
      ctx.toast(message, opts);
      return;
    }
    if (XZB.ui && XZB.ui.toast) { XZB.ui.toast.show(message, opts); }
  }

  function messageOf(result) {
    if (!result) { return MESSAGES.E_UNKNOWN; }
    if (result.message) { return String(result.message); }
    if (result.code && MESSAGES[result.code]) { return MESSAGES[result.code]; }
    return MESSAGES.E_UNKNOWN;
  }

  function datesApi() { return coreMod('dates'); }

  function nowIso() {
    var d = datesApi();
    if (d && typeof d.nowIso === 'function') { return d.nowIso(); }
    return new Date().toISOString();
  }

  function todayStr() {
    var d = datesApi();
    if (d && typeof d.todayStr === 'function') { return d.todayStr(); }
    var now = new Date();
    return String(now.getFullYear()) + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function dbOf(ctx) {
    if (ctx && ctx.db) { return ctx.db; }
    if (XZB.app && typeof XZB.app.db === 'function') { return XZB.app.db(); }
    return {};
  }

  function listOf(db, key) {
    return db && Array.isArray(db[key]) ? db[key] : [];
  }

  function settingsOf(db) {
    return db && db.settings && typeof db.settings === 'object' ? db.settings : {};
  }

  function alive(node) {
    if (!node) { return false; }
    if (global.document && typeof global.document.contains === 'function') {
      return global.document.contains(node);
    }
    return node.isConnected !== false;
  }

  /* 清空容器后重绘（快照列表刷新用）；优先用 XZB.dom.clear */
  function clearNode(node) {
    if (!node) { return; }
    if (dom && typeof dom.clear === 'function') { dom.clear(node); return; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function go(ctx, hash) {
    if (ctx && typeof ctx.go === 'function') { ctx.go(hash); return; }
    if (XZB.router && typeof XZB.router.go === 'function') { XZB.router.go(hash); }
  }

  function replace(ctx, hash) {
    if (ctx && typeof ctx.replace === 'function') { ctx.replace(hash); return; }
    go(ctx, hash);
  }

  /* store 级写操作（导入/恢复/清空/迁移）之后必须让 app 重新 load 数据 */
  function refreshData(ctx) {
    if (XZB.app && typeof XZB.app.refresh === 'function') {
      try { return Promise.resolve(XZB.app.refresh()); } catch (error) { /* 走兜底 */ }
    }
    if (ctx && typeof ctx.refresh === 'function') {
      return Promise.resolve(ctx.refresh());
    }
    return Promise.resolve(null);
  }

  function prefsGet(ctx, key, fallback) {
    var prefs = (ctx && ctx.prefs) || (XZB.app && XZB.app.prefs);
    if (prefs && typeof prefs.get === 'function') {
      try { return prefs.get(key, fallback); } catch (error) { return fallback; }
    }
    return fallback;
  }

  function prefsSet(ctx, key, value) {
    var prefs = (ctx && ctx.prefs) || (XZB.app && XZB.app.prefs);
    if (prefs && typeof prefs.set === 'function') {
      try { prefs.set(key, value); return true; } catch (error) { return false; }
    }
    return false;
  }

  function buzz(ctx) {
    if (prefsGet(ctx, 'haptics', true) === false) { return; }
    try {
      if (global.navigator && typeof global.navigator.vibrate === 'function') {
        global.navigator.vibrate(8);
      }
    } catch (error) { /* iOS 不支持震动，静默 */ }
  }

  function cssVar(name) {
    try {
      var styles = global.getComputedStyle(global.document.documentElement);
      var value = styles ? styles.getPropertyValue(name) : '';
      return String(value || '').trim();
    } catch (error) {
      return '';
    }
  }

  function fmtBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) { return '0 B'; }
    if (n < 1024) { return n + ' B'; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function isoDateOf(at) {
    var text = String(at || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) { return text.slice(0, 10); }
    return '';
  }

  function fmtTime(at, withDate) {
    var text = String(at || '');
    var d = null;
    try { d = text ? new Date(text) : null; } catch (error) { d = null; }
    if (!d || isNaN(d.getTime())) {
      return text ? text.slice(0, 16).replace('T', ' ') : '—';
    }
    var dateKey = String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    var clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var today = todayStr();
    var yesterday = '';
    var dates = datesApi();
    if (dates && typeof dates.addDays === 'function') { yesterday = dates.addDays(today, -1); }
    if (!withDate) {
      if (dateKey === today) { return '今天 ' + clock; }
      if (dateKey === yesterday) { return '昨天 ' + clock; }
    }
    var md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    if (dateKey.slice(0, 4) === today.slice(0, 4)) { return md + ' ' + clock; }
    return dateKey.slice(0, 4) + '年' + md;
  }

  function countsOf(db) {
    var tx = 0;
    var txs = listOf(db, 'transactions');
    for (var i = 0; i < txs.length; i += 1) {
      if (txs[i] && txs[i].deleted !== true) { tx += 1; }
    }
    var accounts = 0;
    var accs = listOf(db, 'accounts');
    for (var a = 0; a < accs.length; a += 1) {
      if (accs[a] && accs[a].archived !== true) { accounts += 1; }
    }
    var books = 0;
    var bookList = listOf(db, 'books');
    for (var b = 0; b < bookList.length; b += 1) {
      if (bookList[b] && bookList[b].archived !== true) { books += 1; }
    }
    return {
      transactions: tx,
      accounts: accounts,
      books: books,
      categories: listOf(db, 'categories').length
    };
  }

  /* ---------------- 通用行 / 分组 ---------------- */

  function chevron() {
    return iconEl('chevron-right', 16, 'c-row__chevron');
  }

  function bindTap(node, handler) {
    if (!node || typeof handler !== 'function') { return node; }
    node.addEventListener('click', function (event) {
      if (event && event.defaultPrevented) { return; }
      handler(event);
    });
    node.addEventListener('keydown', function (event) {
      if (!event) { return; }
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        handler(event);
      }
    });
    return node;
  }

  function row(options) {
    var opts = options || {};
    var className = 'c-row';
    if (opts.icon) { className += ' c-row--icon'; }
    if (opts.sub) { className += ' c-row--two-line'; }
    if (opts.onClick) { className += ' c-row--tappable'; }
    if (opts.className) { className += ' ' + opts.className; }

    var node = h('div', { className: className });
    if (opts.onClick) {
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
    }
    if (opts.ariaLabel) { node.setAttribute('aria-label', opts.ariaLabel); }

    if (opts.icon) {
      node.appendChild(iconEl(opts.icon, opts.iconSize || 20, 'c-row__icon s-settings-row__icon'));
    }

    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title s-settings-row__title', opts.title));
    if (opts.sub) { main.appendChild(t('span', 'c-row__sub', opts.sub)); }
    node.appendChild(main);

    var trail = h('span', { className: 'c-row__trail' });
    if (opts.value !== undefined && opts.value !== null) {
      var valueClass = 'c-row__value';
      if (opts.valueClass) { valueClass += ' ' + opts.valueClass; }
      trail.appendChild(t('span', valueClass, opts.value));
    }
    if (opts.trail) { trail.appendChild(opts.trail); }
    if (opts.onClick && opts.chevron !== false) { trail.appendChild(chevron()); }
    node.appendChild(trail);

    if (opts.onClick) { bindTap(node, opts.onClick); }
    if (opts.pressed) { node.classList.add('is-pressed'); }
    return node;
  }

  function switchRow(ctx, options) {
    var opts = options || {};
    var checked = opts.checked === true;

    var button = h('button', {
      className: 'c-switch',
      type: 'button',
      role: 'switch',
      aria: { checked: checked ? 'true' : 'false', label: opts.title }
    });
    button.addEventListener('click', function (event) {
      if (event) { event.stopPropagation(); }
      flip(!checked);
    });

    var node = h('div', {
      className: 'c-row c-row--icon' + (opts.sub ? ' c-row--two-line' : '') + ' s-settings-switch-row'
    });
    node.appendChild(iconEl(opts.icon, 20, 'c-row__icon s-settings-row__icon'));
    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title s-settings-row__title', opts.title));
    if (opts.sub) { main.appendChild(t('span', 'c-row__sub', opts.sub)); }
    node.appendChild(main);
    var trail = h('span', { className: 'c-row__trail' });
    trail.appendChild(button);
    node.appendChild(trail);

    function flip(next) {
      if (live.busy) { return; }
      checked = next;
      button.setAttribute('aria-checked', checked ? 'true' : 'false');
      live.busy = true;
      buzz(ctx);
      var result = null;
      try { result = opts.onChange ? opts.onChange(checked) : null; } catch (error) { result = null; }
      Promise.resolve(result).then(function (ok) {
        live.busy = false;
        if (ok === false) {
          checked = !checked;
          button.setAttribute('aria-checked', checked ? 'true' : 'false');
        }
      }, function () {
        live.busy = false;
        checked = !checked;
        button.setAttribute('aria-checked', checked ? 'true' : 'false');
      });
    }

    node.addEventListener('click', function (event) {
      if (event && event.target === button) { return; }
      flip(!checked);
    });

    return node;
  }

  function group(titleText, rows, footerText, headAction) {
    var wrap = h('section', { className: 's-settings-group' });
    var head = h('div', { className: 's-settings-group__head' });
    head.appendChild(t('h2', 's-settings-group__title', titleText));
    if (headAction) { head.appendChild(headAction); }
    wrap.appendChild(head);

    var list = h('div', { className: 'c-list s-settings-list' });
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i]) { list.appendChild(rows[i]); }
    }
    wrap.appendChild(list);

    if (footerText) {
      wrap.appendChild(t('p', 's-settings-group__note', footerText));
    }
    return wrap;
  }

  function noteBlock(text, className) {
    return t('p', 's-settings-note' + (className ? ' ' + className : ''), text);
  }

  /* ---------------- 设置写入 ---------------- */

  function commitSetting(ctx, key, value, label) {
    var schema = schemaApi();
    var result = null;
    if (!ctx || typeof ctx.commit !== 'function') {
      toast(ctx, MESSAGES.E_COMMIT, { type: 'danger' });
      return Promise.resolve(false);
    }
    try {
      result = ctx.commit(function (db) {
        if (!db.settings || typeof db.settings !== 'object') { db.settings = {}; }
        db.settings[key] = value;
        db.settings.updatedAt = nowIso();
        if (schema && typeof schema.validateSettings === 'function') {
          var check = schema.validateSettings(db.settings);
          if (!check.ok) {
            return {
              abort: true,
              code: check.errors[0].code,
              message: MESSAGES[check.errors[0].code] || MESSAGES.E_INVALID_INPUT
            };
          }
        }
        return {};
      }, { label: label || '修改设置' });
    } catch (error) {
      result = null;
    }
    return Promise.resolve(result).then(function (res) {
      if (!res || !res.ok) {
        toast(ctx, messageOf(res), { type: 'danger' });
        return false;
      }
      return true;
    }, function () {
      toast(ctx, MESSAGES.E_COMMIT, { type: 'danger' });
      return false;
    });
  }

  /* ---------------- 外观 ---------------- */

  function themeRow(ctx) {
    var current = prefsGet(ctx, 'theme', 'auto');
    var node = h('div', { className: 'c-row s-settings-theme' });
    node.appendChild(t('span', 'c-row__title s-settings-theme__label', '外观'));

    var seg = h('div', {
      className: 'c-segmented s-settings-theme__seg',
      role: 'group',
      aria: { label: '外观' }
    });

    var buttons = [];
    function select(value, button) {
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].setAttribute('aria-selected', buttons[i] === button ? 'true' : 'false');
      }
      var ok = prefsSet(ctx, 'theme', value);
      if (!ok && XZB.app && typeof XZB.app.setTheme === 'function') {
        try { XZB.app.setTheme(value); ok = true; } catch (error) { ok = false; }
      }
      if (!ok) {
        toast(ctx, '主题切换失败，请重试', { type: 'danger' });
        var fallback = prefsGet(ctx, 'theme', 'auto');
        for (var j = 0; j < buttons.length; j += 1) {
          buttons[j].setAttribute('aria-selected', buttons[j].getAttribute('data-theme') === fallback ? 'true' : 'false');
        }
      }
    }

    for (var i = 0; i < THEMES.length; i += 1) {
      (function (item) {
        var button = h('button', {
          className: 'c-segmented__item',
          type: 'button',
          text: item.label,
          aria: { selected: current === item.value ? 'true' : 'false' },
          dataset: { theme: item.value }
        });
        button.addEventListener('click', function () { select(item.value, button); });
        buttons.push(button);
        seg.appendChild(button);
      }(THEMES[i]));
    }

    node.appendChild(seg);
    return node;
  }

  function sectionAppearance(ctx) {
    /* 2.1：删掉「震动」开关。iOS Safari 没有 navigator.vibrate，
       这个开关在 iPhone 上从来没有生效过——留着一个永远不震的开关，
       比没有更伤信任。按压反馈改由 ui/press.js 用视觉回弹表达。 */
    return group('显示', [themeRow(ctx)]);
  }

  /* ---------------- 记账管理（M12：按任务找入口，不按实现方式） ---------------- */

  function sectionManage(ctx, db) {
    var settings = settingsOf(db);
    var categories = listOf(db, 'categories').length;

    return group('记账管理', [
      row({
        icon: 'target',
        title: '预算与存钱目标',
        value: '计划',
        onClick: function () { go(ctx, '#/plan'); }
      }),
      row({
        icon: 'tag',
        title: '分类管理',
        sub: '常用分类会优先出现在记一笔宫格',
        value: categories + ' 个分类',
        onClick: function () { go(ctx, '#/settings/categories?kind=expense'); }
      }),
      row({
        icon: 'wallet',
        title: '账户管理',
        value: '余额与信用卡',
        onClick: function () { go(ctx, '#/accounts'); }
      }),
      row({
        icon: 'book',
        title: '账本管理',
        onClick: function () { go(ctx, '#/books'); }
      })
    ]);
  }

  /* ---------------- 自动化 ---------------- */

  function sectionAutomation(ctx, db) {
    var settings = settingsOf(db);
    return group('自动化', [
      switchRow(ctx, {
        icon: 'repeat',
        title: '定期账单自动入账',
        sub: '启动时自动补记，默认关闭',
        checked: settings.recurringAutoPost === true,
        onChange: function (next) {
          return commitSetting(ctx, 'recurringAutoPost', next, next ? '开启定期自动入账' : '关闭定期自动入账');
        }
      }),
      switchRow(ctx, {
        icon: 'clock',
        title: '自动快照',
        sub: '滚动保留最近 30 份',
        checked: settings.snapshotAuto !== false,
        onChange: function (next) {
          return commitSetting(ctx, 'snapshotAuto', next, next ? '开启自动快照' : '关闭自动快照');
        }
      })
    ], '自动入账与快照都只在本机完成。');
  }

  /* ---------------- 数据：导出 ---------------- */

  function exportOption(icon, title, sub, onClick) {
    return row({ icon: icon, title: title, sub: sub, onClick: onClick });
  }

  function openExportSheet(ctx) {
    var backup = backupApi();
    if (!backup || typeof backup.exportText !== 'function') {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
      return;
    }
    var handle = null;
    var counts = countsOf(dbOf(ctx));
    var body = h('div', { className: 's-settings-sheet' });
    body.appendChild(noteBlock('导出文件保存在本机，再通过系统分享或「下载」拿出去。', 's-settings-sheet__lead'));

    var list = h('div', { className: 'c-list s-settings-sheet__list' });
    list.appendChild(exportOption('download', '导出 JSON 备份', '包含全部 ' + counts.transactions + ' 笔流水与设置，可完整还原', function () {
      if (handle) { handle.close(); }
      startExport(ctx, 'json');
    }));
    list.appendChild(exportOption('list', '导出 CSV 表格', '给 Excel 或数字表格打开，不含设置', function () {
      if (handle) { handle.close(); }
      startExport(ctx, 'csv');
    }));
    body.appendChild(list);
    body.appendChild(noteBlock('导入时只认 JSON 备份。'));

    handle = XZB.ui.sheet.open({
      title: '导出备份',
      content: body,
      actions: [{ label: '取消', kind: 'text' }]
    });
  }

  function startExport(ctx, format) {
    var backup = backupApi();
    if (!backup) {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
      return;
    }
    var promise = format === 'csv' ? backup.exportCsv() : backup.exportJson();
    Promise.resolve(promise).then(function (result) {
      if (!result || !result.ok) {
        toast(ctx, messageOf(result), { type: 'danger' });
        return;
      }
      deliverExport(ctx, result, format);
    }, function () {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
    });
  }

  function deliverExport(ctx, result, format) {
    var nav = global.navigator;
    var canTryShare = nav && typeof nav.share === 'function' &&
      typeof global.File === 'function';
    if (canTryShare) {
      var file = null;
      try {
        file = new global.File([result.content], result.filename, { type: result.mime });
      } catch (error) {
        file = null;
      }
      if (file) {
        var shareable = false;
        if (typeof nav.canShare === 'function') {
          try { shareable = nav.canShare({ files: [file] }); } catch (error) { shareable = false; }
        }
        if (shareable) {
          var shared = null;
          try {
            shared = nav.share({ files: [file], title: '小账本备份', text: '小账本 2.0 备份' });
          } catch (error) {
            shared = null;
          }
          if (shared && typeof shared.then === 'function') {
            shared.then(function () {
              toast(ctx, '已打开系统分享', { type: 'success' });
            }, function (error) {
              if (error && error.name === 'AbortError') { return; }
              downloadFallback(ctx, format);
            });
            return;
          }
        }
      }
    }
    downloadFallback(ctx, format);
  }

  function downloadFallback(ctx, format) {
    var backup = backupApi();
    if (!backup || typeof backup.download !== 'function') {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
      return;
    }
    Promise.resolve(backup.download(format)).then(function (result) {
      if (!result || !result.ok) {
        toast(ctx, messageOf(result), { type: 'danger' });
        return;
      }
      toast(ctx, '已导出 ' + result.filename, { type: 'success' });
    }, function () {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
    });
  }

  /* ---------------- 数据：导入 ---------------- */

  function pickImportFile(ctx) {
    if (!live.root) { return; }
    var input = h('input', {
      className: 's-settings-fileinput',
      type: 'file',
      accept: '.json,application/json',
      tabindex: '-1',
      aria: { hidden: 'true' }
    });
    input.addEventListener('change', function () {
      var file = input.files && input.files.length ? input.files[0] : null;
      try { input.value = ''; } catch (error) { /* 忽略 */ }
      if (input.parentNode) { input.parentNode.removeChild(input); }
      if (file) { readImportFile(ctx, file); }
    });
    live.root.appendChild(input);
    input.click();
  }

  function readImportFile(ctx, file) {
    var backup = backupApi();
    var limit = backup && backup.MAX_IMPORT_BYTES ? backup.MAX_IMPORT_BYTES : 10 * 1024 * 1024;
    if (file.size > limit) {
      toast(ctx, MESSAGES.E_IMPORT_TOO_LARGE, { type: 'danger' });
      return;
    }
    if (typeof global.FileReader !== 'function') {
      toast(ctx, '当前浏览器不支持读取文件', { type: 'danger' });
      return;
    }
    var reader = new global.FileReader();
    reader.onerror = function () {
      toast(ctx, MESSAGES.E_FILE_READ, { type: 'danger' });
    };
    reader.onload = function () {
      var text = typeof reader.result === 'string' ? reader.result : '';
      previewImport(ctx, text, file.name, file.size);
    };
    reader.readAsText(file, 'utf-8');
  }

  function transactionsOfBackup(value, kind) {
    if (!value || typeof value !== 'object') { return []; }
    if (kind === 'v2') {
      var data = value.data;
      return data && Array.isArray(data.transactions) ? data.transactions : [];
    }
    return Array.isArray(value.transactions) ? value.transactions : [];
  }

  function dateRangeOf(value, kind) {
    var list = transactionsOfBackup(value, kind);
    var min = '';
    var max = '';
    for (var i = 0; i < list.length; i += 1) {
      var tx = list[i];
      if (!tx || typeof tx.date !== 'string') { continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) { continue; }
      if (!min || tx.date < min) { min = tx.date; }
      if (!max || tx.date > max) { max = tx.date; }
    }
    if (!min) { return ''; }
    if (min === max) { return min; }
    return min + ' 至 ' + max;
  }

  function previewImport(ctx, text, filename, bytes) {
    var backup = backupApi();
    if (!backup) {
      toast(ctx, MESSAGES.E_IMPORT_INVALID, { type: 'danger' });
      return;
    }
    var parsed = backup.parseInput(text);
    if (!parsed.ok) {
      toast(ctx, messageOf(parsed), { type: 'danger' });
      return;
    }
    var kind = backup.detectKind(parsed.value);
    if (!kind) {
      toast(ctx, MESSAGES.E_IMPORT_INVALID, { type: 'danger' });
      return;
    }
    var current = dbOf(ctx);
    var built = backup.buildImportDb(text, { mode: 'merge', currentDb: current });
    if (!built || !built.ok) {
      toast(ctx, messageOf(built), { type: 'danger' });
      return;
    }

    var report = built.report || {};
    var mode = 'merge';
    var handle = null;

    var body = h('div', { className: 's-settings-sheet' });
    if (filename) {
      body.appendChild(t('p', 's-settings-sheet__file', filename + ' · ' + fmtBytes(bytes)));
    }
    body.appendChild(noteBlock(kind === 'v2' ? '识别为 2.0 备份。' : '识别为 1.x 备份，将迁移到 2.0 结构。', 's-settings-sheet__lead'));

    var statList = h('div', { className: 'c-list s-settings-sheet__list' });
    statList.appendChild(row({ title: '来源', value: kind === 'v2' ? '2.0 备份' : '1.x 备份', chevron: false }));
    statList.appendChild(row({ title: '流水', value: (report.transactions || 0) + ' 笔', chevron: false }));
    statList.appendChild(row({ title: '账本 / 分类', value: (report.books || 0) + ' / ' + (report.categories || 0), chevron: false }));
    var range = dateRangeOf(parsed.value, kind);
    if (range) {
      statList.appendChild(row({ title: '时间范围', value: range, chevron: false }));
    }
    if (report.skipped > 0) {
      statList.appendChild(row({ title: '跳过', value: report.skipped + ' 行', valueClass: 'c-row__value--expense', chevron: false }));
    }
    body.appendChild(statList);

    body.appendChild(t('p', 's-settings-sheet__label', '导入方式'));
    var seg = h('div', {
      className: 'c-segmented s-settings-import__seg',
      role: 'group',
      aria: { label: '导入方式' }
    });
    var mergeBtn = h('button', {
      className: 'c-segmented__item', type: 'button', text: '合并',
      aria: { selected: 'true' }
    });
    var replaceBtn = h('button', {
      className: 'c-segmented__item', type: 'button', text: '整份替换',
      aria: { selected: 'false' }
    });
    var modeNote = t('p', 's-settings-sheet__note', '');

    function setMode(next) {
      mode = next;
      mergeBtn.setAttribute('aria-selected', next === 'merge' ? 'true' : 'false');
      replaceBtn.setAttribute('aria-selected', next === 'replace' ? 'true' : 'false');
      modeNote.textContent = next === 'replace'
        ? '整份替换：当前全部数据会被清空，只保留备份内容。导入前仍会自动保存一份快照。'
        : '合并：保留现有数据，相同 ID 的记录以备份为准。';
    }
    mergeBtn.addEventListener('click', function () { setMode('merge'); });
    replaceBtn.addEventListener('click', function () { setMode('replace'); });
    setMode('merge');
    seg.appendChild(mergeBtn);
    seg.appendChild(replaceBtn);
    body.appendChild(seg);
    body.appendChild(modeNote);
    body.appendChild(noteBlock('导入前会自动生成一份「导入前」快照，失败不会写入任何数据。'));

    handle = XZB.ui.sheet.open({
      title: '导入备份',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '确认导入',
          kind: 'primary',
          onClick: function () {
            runImport(ctx, backup, text, mode, handle);
            return false;
          }
        }
      ]
    });
  }

  function runImport(ctx, backup, text, mode, handle) {
    if (live.busy) { return; }
    live.busy = true;
    Promise.resolve(backup.import(text, { mode: mode })).then(function (result) {
      live.busy = false;
      if (!result || !result.ok) {
        toast(ctx, messageOf(result), { type: 'danger' });
        return;
      }
      if (handle) { handle.close(); }
      var report = result.report || {};
      var count = report.transactions || 0;
      var skipped = report.skipped || 0;
      var message;
      if (result.sourceVersion === 1) {
        message = '迁移 ' + count + ' 条，跳过 ' + skipped + ' 条';
      } else {
        message = '已导入 ' + count + ' 笔流水' + (skipped > 0 ? '，跳过 ' + skipped + ' 条' : '');
      }
      refreshData(ctx).then(function () {
        toast(ctx, message, { type: 'success' });
      });
    }, function () {
      live.busy = false;
      toast(ctx, MESSAGES.E_IMPORT_FAILED, { type: 'danger' });
    });
  }

  /* ---------------- 数据：迁移 v1 ---------------- */

  function openMigrateSheet(ctx) {
    var migrate = migrateApi();
    if (!migrate) {
      toast(ctx, '迁移组件未加载', { type: 'danger' });
      return;
    }
    var hasV1 = false;
    try { hasV1 = migrate.hasV1Data() === true; } catch (error) { hasV1 = false; }

    var body = h('div', { className: 's-settings-sheet' });
    var handle = null;
    var preview = null;

    if (!hasV1) {
      body.appendChild(noteBlock('本机没有检测到旧版小账本数据。', 's-settings-sheet__lead'));
      body.appendChild(noteBlock('如果手里有 1.x 导出的 JSON 文件，请用「导入备份」选择该文件，会自动识别并迁移。'));
      XZB.ui.sheet.open({
        title: '从旧版迁移',
        content: body,
        actions: [{ label: '知道了', kind: 'primary' }]
      });
      return;
    }

    body.appendChild(noteBlock('检测到本机旧版小账本数据。迁移会把它合并到当前数据，旧数据不会被删除。', 's-settings-sheet__lead'));
    var statList = h('div', { className: 'c-list s-settings-sheet__list' });
    var countRow = row({ title: '待迁移', value: '正在读取…', chevron: false });
    statList.appendChild(countRow);
    body.appendChild(statList);
    body.appendChild(noteBlock('迁移前会自动生成一份「迁移前」快照。'));

    handle = XZB.ui.sheet.open({
      title: '从旧版迁移',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '开始迁移',
          kind: 'primary',
          onClick: function () {
            runMigration(ctx, migrate, preview, handle);
            return false;
          }
        }
      ]
    });

    var result = null;
    try { result = migrate.fromLocalStorage({ mode: 'merge', currentDb: dbOf(ctx) }); } catch (error) { result = null; }
    if (!result || !result.ok) {
      countRow.querySelector('.c-row__value').textContent = '读取失败';
      return;
    }
    if (result.empty || !result.db) {
      countRow.querySelector('.c-row__value').textContent = '没有可迁移的数据';
      return;
    }
    preview = result;
    var report = result.report || {};
    countRow.querySelector('.c-row__value').textContent =
      (report.transactions || 0) + ' 笔 · ' + (report.categories || 0) + ' 个分类';
  }

  function runMigration(ctx, migrate, preview, handle) {
    if (live.busy) { return; }
    var result = preview;
    if (!result) {
      try { result = migrate.fromLocalStorage({ mode: 'merge', currentDb: dbOf(ctx) }); } catch (error) { result = null; }
    }
    if (!result || !result.ok) {
      toast(ctx, messageOf(result) === MESSAGES.E_UNKNOWN ? MESSAGES.E_MIGRATE_INVALID : messageOf(result), { type: 'danger' });
      return;
    }
    if (result.empty || !result.db) {
      toast(ctx, '没有可迁移的数据', { type: 'info' });
      return;
    }

    var store = storeApi();
    if (!store || typeof store.snapshot !== 'function') {
      toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
      return;
    }

    live.busy = true;
    Promise.resolve(store.snapshot('pre-migrate')).then(function (snap) {
      if (!snap || (!snap.ok && snap.code !== 'E_STORAGE_FALLBACK')) {
        live.busy = false;
        toast(ctx, messageOf(snap), { type: 'danger' });
        return;
      }
      var source = result.db;
      var tables = ['books', 'accounts', 'categories', 'transactions', 'budgets',
        'categoryBudgets', 'recurring', 'goals', 'goalDeposits'];
      var written = ctx.commit(function (db) {
        for (var i = 0; i < tables.length; i += 1) {
          if (Array.isArray(source[tables[i]])) { db[tables[i]] = source[tables[i]]; }
        }
        if (source.settings) { db.settings = source.settings; }
        db.updatedAt = source.updatedAt || nowIso();
        return {};
      }, { label: '迁移旧版数据' });

      return Promise.resolve(written).then(function (res) {
        live.busy = false;
        if (!res || !res.ok) {
          toast(ctx, messageOf(res), { type: 'danger' });
          return;
        }
        if (handle) { handle.close(); }
        var report = result.report || {};
        toast(ctx, '迁移 ' + (report.transactions || 0) + ' 条，跳过 ' + (report.skipped || 0) + ' 条', { type: 'success' });
      });
    }, function () {
      live.busy = false;
      toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
    });
  }

  /* ---------------- 数据：清空 ---------------- */

  function openClearSheet(ctx) {
    var handle = null;
    var body = h('div', { className: 's-settings-sheet s-settings-danger' });
    body.appendChild(t('p', 's-settings-danger__title', '这会删除全部账本、流水、分类、预算和存钱目标。'));
    body.appendChild(t('p', 's-settings-danger__text', '执行前会自动保存一份快照，之后可以在「自动快照」里恢复。'));

    var field = h('label', { className: 'c-field c-field--boxed s-settings-clear__field' });
    field.appendChild(t('span', 'c-field__label', '确认'));
    var input = h('input', {
      className: 'c-field__input s-settings-clear__input',
      type: 'text',
      placeholder: '输入「清空」两个字',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      maxlength: '8',
      aria: { label: '输入「清空」两个字确认' }
    });
    field.appendChild(input);
    body.appendChild(field);
    var error = t('p', 's-settings-danger__hint', '确认文字不一致时不会执行任何操作。');
    body.appendChild(error);

    function confirmClear() {
      if (live.busy) { return false; }
      var typed = String(input.value || '').replace(/\s+/g, '');
      if (typed !== CONFIRM_CLEAR) {
        error.textContent = '确认文字不一致，操作已取消';
        error.classList.add('is-error');
        toast(ctx, '确认文字不一致，操作已取消', { type: 'warning' });
        try { input.focus(); } catch (err) { /* 忽略 */ }
        return false;
      }
      var store = storeApi();
      if (!store || typeof store.reset !== 'function') {
        toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
        return false;
      }
      live.busy = true;
      Promise.resolve(store.reset()).then(function (result) {
        live.busy = false;
        if (!result || !result.ok) {
          toast(ctx, messageOf(result), { type: 'danger' });
          return;
        }
        if (handle) { handle.close(); }
        refreshData(ctx).then(function () {
          toast(ctx, '已清空全部数据，可从快照恢复', { type: 'success' });
          go(ctx, '#/home');
        });
      }, function () {
        live.busy = false;
        toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
      });
      return false;
    }

    input.addEventListener('keydown', function (event) {
      if (event && event.key === 'Enter') {
        event.preventDefault();
        confirmClear();
      }
    });
    input.addEventListener('input', function () {
      if (error.classList.contains('is-error')) {
        error.classList.remove('is-error');
        error.textContent = '确认文字不一致时不会执行任何操作。';
      }
    });

    handle = XZB.ui.sheet.open({
      title: '清空所有数据',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '清空全部数据',
          kind: 'danger',
          onClick: confirmClear
        }
      ]
    });
  }

  /* ---------------- 数据分组 ---------------- */

  function sectionData(ctx, db) {
    var migrate = migrateApi();
    var hasV1 = false;
    try { hasV1 = !!(migrate && migrate.hasV1Data && migrate.hasV1Data()); } catch (error) { hasV1 = false; }

    var snapRow = row({
      icon: 'list',
      title: '快照记录',
      sub: '导入前会自动存一份',
      value: '查看',
      onClick: function () { go(ctx, '#/settings/snapshots'); }
    });
    fillSnapshotValue(ctx, snapRow);

    var rows = [
      snapRow,
      row({
        icon: 'download',
        title: '导出备份',
        value: 'JSON / CSV',
        onClick: function () { openExportSheet(ctx); }
      }),
      row({
        icon: 'upload',
        title: '导入备份',
        sub: '从 JSON 备份恢复，导入前自动快照',
        onClick: function () { pickImportFile(ctx); }
      }),
      row({
        icon: 'import',
        title: '从旧版迁移',
        value: hasV1 ? '检测到旧数据' : null,
        onClick: function () { openMigrateSheet(ctx); }
      })
    ];

    return group('备份与恢复', rows, '导出、快照都只在本机完成，不会上传任何内容。');
  }

  /* 危险区独立分组（M12）：红色边界 + 只放清空，不与普通数据管理混排 */
  function sectionDanger(ctx) {
    var wrap = h('section', { className: 's-settings-group s-settings-group--danger' });
    var head = h('div', { className: 's-settings-group__head' });
    head.appendChild(t('h2', 's-settings-group__title', '危险区'));
    wrap.appendChild(head);

    var list = h('div', { className: 'c-list s-settings-list s-settings-list--danger' });
    list.appendChild(row({
      icon: 'trash',
      title: '清空所有数据',
      sub: '删除这台设备上的全部账本与流水',
      className: 's-settings-row--danger',
      chevron: false,
      onClick: function () { openClearSheet(ctx); }
    }));
    wrap.appendChild(list);
    wrap.appendChild(t('p', 's-settings-group__note', '清空前会自动生成一份快照，可在「快照记录」里恢复。'));
    return wrap;
  }

  function fillSnapshotValue(ctx, node) {
    var store = storeApi();
    if (!store || typeof store.listSnapshots !== 'function' || !node) { return; }
    Promise.resolve(store.listSnapshots()).then(function (result) {
      if (!result || !result.ok || !alive(node)) { return; }
      var items = Array.isArray(result.items) ? result.items : [];
      var value = node.querySelector('.c-row__value');
      if (!value) { return; }
      value.textContent = items.length ? fmtTime(items[0].at) : '暂无';
    }, function () { /* 静默 */ });
  }

  /* ---------------- 数据：快照列表 ---------------- */

  function renderSnapshots(root, ctx) {
    deferTitle(ctx, '快照');
    var page = h('div', { className: 's-settings-page' });
    page.appendChild(noteBlock('自动快照在每天首次打开、导入、恢复和清空前生成，最多保留 10 份。', 's-settings-page__lead'));

    var listWrap = h('div', { className: 's-settings-snaps' });
    page.appendChild(listWrap);

    var actions = h('div', { className: 's-settings-actions' });
    var saveBtn = h('button', {
      className: 'c-btn c-btn--secondary c-btn--block',
      type: 'button',
      text: '立即生成快照'
    });
    saveBtn.addEventListener('click', function () {
      var store = storeApi();
      if (!store || typeof store.snapshot !== 'function') {
        toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
        return;
      }
      if (live.busy) { return; }
      live.busy = true;
      Promise.resolve(store.snapshot('manual')).then(function (result) {
        live.busy = false;
        if (!result || !result.ok) {
          toast(ctx, messageOf(result), { type: 'danger' });
          return;
        }
        toast(ctx, '快照已保存', { type: 'success' });
        loadSnapshots(ctx, listWrap, 0);
      }, function () {
        live.busy = false;
        toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
      });
    });
    actions.appendChild(saveBtn);
    actions.appendChild(noteBlock('恢复会用快照覆盖当前全部数据，恢复前会自动保存当前数据。'));
    page.appendChild(actions);

    root.appendChild(page);
    loadSnapshots(ctx, listWrap, 0);
  }

  function loadSnapshots(ctx, container, shown) {
    var store = storeApi();
    if (!store || typeof store.listSnapshots !== 'function') {
      container.appendChild(noteBlock('存储层未加载，无法读取快照。', 's-settings-note--danger'));
      return;
    }
    Promise.resolve(store.listSnapshots()).then(function (result) {
      if (!alive(container)) { return; }
      clearNode(container);
      if (!result || !result.ok) {
        container.appendChild(noteBlock(messageOf(result), 's-settings-note--danger'));
        return;
      }
      var items = Array.isArray(result.items) ? result.items : [];
      if (!items.length) {
        var empty = h('div', { className: 'c-empty s-settings-empty' });
        empty.appendChild(iconEl('clock', 28, 's-settings-empty__icon'));
        empty.appendChild(t('p', 'c-empty__title', '还没有快照'));
        empty.appendChild(t('p', 'c-empty__desc', '打开小账本、导入或恢复时会自动生成。'));
        container.appendChild(empty);
        return;
      }
      var limit = shown > 0 ? shown : SNAP_PAGE;
      var list = h('div', { className: 'c-list s-settings-snap-list' });
      var count = Math.min(items.length, limit);
      for (var i = 0; i < count; i += 1) {
        list.appendChild(snapshotRow(ctx, items[i], container));
      }
      container.appendChild(list);

      if (items.length > count) {
        var more = h('div', { className: 's-settings-actions' });
        var moreBtn = h('button', {
          className: 'c-btn c-btn--text c-btn--block',
          type: 'button',
          text: '显示更多（还有 ' + (items.length - count) + ' 份）'
        });
        moreBtn.addEventListener('click', function () {
          loadSnapshots(ctx, container, count + SNAP_PAGE);
        });
        more.appendChild(moreBtn);
        container.appendChild(more);
      }
    }, function () {
      if (!alive(container)) { return; }
      clearNode(container);
      container.appendChild(noteBlock(MESSAGES.E_STORAGE_WRITE, 's-settings-note--danger'));
    });
  }

  function snapshotRow(ctx, snap, container) {
    var counts = snap.counts || {};
    var txCount = counts.transactions || 0;
    var label = REASON_LABEL[snap.reason] || '快照';
    var sub = label + ' · ' + txCount + ' 笔流水 · ' + fmtBytes(snap.bytes);
    return row({
      icon: 'clock',
      title: fmtTime(snap.at),
      sub: sub,
      onClick: function () { openSnapshotActions(ctx, snap, container); }
    });
  }

  function openSnapshotActions(ctx, snap, container) {
    var body = h('div', { className: 's-settings-sheet' });
    var list = h('div', { className: 'c-list s-settings-sheet__list' });
    list.appendChild(row({ title: '时间', value: fmtTime(snap.at, true), chevron: false }));
    list.appendChild(row({ title: '原因', value: REASON_LABEL[snap.reason] || '快照', chevron: false }));
    var counts = snap.counts || {};
    list.appendChild(row({ title: '流水', value: (counts.transactions || 0) + ' 笔', chevron: false }));
    list.appendChild(row({ title: '大小', value: fmtBytes(snap.bytes), chevron: false }));
    body.appendChild(list);
    body.appendChild(noteBlock('恢复会覆盖当前全部数据，并先自动保存一份当前数据。'));

    XZB.ui.sheet.open({
      title: '快照',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '删除',
          kind: 'danger',
          onClick: function () {
            openSnapshotDelete(ctx, snap, container);
            return false;
          }
        },
        {
          label: '恢复',
          kind: 'primary',
          onClick: function () {
            openSnapshotRestore(ctx, snap, container);
            return false;
          }
        }
      ]
    });
  }

  function openSnapshotDelete(ctx, snap, container) {
    var body = h('div', { className: 's-settings-sheet' });
    body.appendChild(noteBlock('删除这份快照后无法找回，当前数据不受影响。', 's-settings-sheet__lead'));
    XZB.ui.sheet.open({
      title: '删除快照',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '删除',
          kind: 'danger',
          onClick: function () {
            var store = storeApi();
            if (!store || typeof store.removeSnapshot !== 'function') { return true; }
            Promise.resolve(store.removeSnapshot(snap.id)).then(function (result) {
              if (!result || !result.ok) {
                toast(ctx, messageOf(result), { type: 'danger' });
                return;
              }
              toast(ctx, '快照已删除', { type: 'success' });
              loadSnapshots(ctx, container, 0);
            }, function () {
              toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
            });
            return true;
          }
        }
      ]
    });
  }

  function openSnapshotRestore(ctx, snap, container) {
    var body = h('div', { className: 's-settings-sheet s-settings-danger' });
    body.appendChild(t('p', 's-settings-danger__title', '恢复会覆盖当前全部数据。'));
    body.appendChild(t('p', 's-settings-danger__text', '快照里的账本、流水、分类、预算和设置会替换当前数据。恢复前会自动保存一份当前数据，仍可从快照回退。'));

    XZB.ui.sheet.open({
      title: '恢复到 ' + fmtTime(snap.at),
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '覆盖并恢复',
          kind: 'danger',
          onClick: function () {
            var store = storeApi();
            if (!store || typeof store.restore !== 'function') { return true; }
            live.busy = true;
            Promise.resolve(store.restore(snap.id)).then(function (result) {
              live.busy = false;
              if (!result || !result.ok) {
                toast(ctx, messageOf(result), { type: 'danger' });
                return;
              }
              refreshData(ctx).then(function () {
                toast(ctx, '已恢复到该快照', { type: 'success' });
              });
            }, function () {
              live.busy = false;
              toast(ctx, MESSAGES.E_STORAGE_CORRUPT, { type: 'danger' });
            });
            return true;
          }
        }
      ]
    });
  }

  /* ---------------- 分类管理 ---------------- */

  function parseHex(color) {
    var hex = String(color || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}$/.test(hex) && !/^[0-9a-fA-F]{6}$/.test(hex)) { return null; }
    if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  /* 分类色 → --cat-N 槽位：先精确匹配，再按 RGB 距离取最近槽位。
     系统默认分类的色值来自 schema 的旧调色板，和 tokens 的槽位不完全一致，
     只做精确匹配会让它们全部落到灰色，所以这里补一层最近色映射。 */
  function toneIndexOf(color) {
    var target = parseHex(color);
    if (!target) { return 0; }
    var best = 0;
    var bestDistance = Infinity;
    for (var i = 1; i <= TONE_COUNT; i += 1) {
      var slot = parseHex(cssVar('--cat-' + i));
      if (!slot) { continue; }
      if (slot.r === target.r && slot.g === target.g && slot.b === target.b) { return i; }
      var dr = slot.r - target.r;
      var dg = slot.g - target.g;
      var db = slot.b - target.b;
      var distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  }

  function toneClass(tone) {
    return tone > 0 ? 's-settings-tone-' + tone : 's-settings-tone-none';
  }

  function favoriteIdsOf(ctx) {
    var raw = prefsGet(ctx, 'favoriteCategoryIds', []);
    return Array.isArray(raw) ? raw.map(function (id) { return String(id); }) : [];
  }

  function toggleFavorite(ctx, categoryId) {
    var ids = favoriteIdsOf(ctx);
    var index = ids.indexOf(String(categoryId));
    if (index >= 0) { ids.splice(index, 1); } else { ids.push(String(categoryId)); }
    prefsSet(ctx, 'favoriteCategoryIds', ids);
    return index < 0;
  }

  function renderCategories(root, ctx, db) {
    deferTitle(ctx, '分类管理');
    var kind = ctx && ctx.query && ctx.query.kind === 'income' ? 'income' : 'expense';
    var all = listOf(db, 'categories');
    var items = [];
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].kind === kind && all[i].deleted !== true) { items.push(all[i]); }
    }
    items.sort(function (a, b) {
      var sa = Number(a.sort) || 0;
      var sb = Number(b.sort) || 0;
      if (sa !== sb) { return sa - sb; }
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    });

    var favs = favoriteIdsOf(ctx);
    /* 常用次数：给「常用」筛选与星标提示用（不改 schema） */
    var useCount = {};
    var txs = listOf(db, 'transactions');
    for (var u = 0; u < txs.length; u += 1) {
      var tx = txs[u];
      if (!tx || tx.deleted === true || !tx.categoryId) { continue; }
      useCount[tx.categoryId] = (useCount[tx.categoryId] || 0) + 1;
    }

    var page = h('div', { className: 's-settings-page' });

    /* 搜索：过滤当前类型的分类名（M9） */
    var searchWrap = h('div', { className: 's-settings-cats__search' });
    var searchInput = h('input', {
      className: 'c-field__input s-settings-cats__search-input',
      type: 'search',
      placeholder: '搜索分类名称',
      autocomplete: 'off',
      aria: { label: '搜索分类' }
    });
    searchWrap.appendChild(searchInput);
    page.appendChild(searchWrap);

    var seg = h('div', { className: 'c-segmented s-settings-cats__seg', role: 'group', aria: { label: '分类类型' } });
    var kinds = [
      { value: 'expense', label: '支出分类' },
      { value: 'income', label: '收入分类' }
    ];
    for (var k = 0; k < kinds.length; k += 1) {
      (function (item) {
        var btn = h('button', {
          className: 'c-segmented__item',
          type: 'button',
          text: item.label,
          aria: { selected: kind === item.value ? 'true' : 'false' }
        });
        btn.addEventListener('click', function () {
          if (kind === item.value) { return; }
          replace(ctx, '#/settings/categories?kind=' + item.value);
        });
        seg.appendChild(btn);
      }(kinds[k]));
    }
    page.appendChild(seg);

    /* 新增按钮固定在列表上方（M9：不再滚到底才能加） */
    var addWrap = h('div', { className: 's-settings-actions s-settings-actions--top' });
    var addBtn = h('button', {
      className: 'c-btn c-btn--primary c-btn--block',
      type: 'button'
    });
    addBtn.appendChild(iconEl('plus', 18, 's-settings-glyph s-settings-glyph--btn'));
    addBtn.appendChild(t('span', '', '新增' + (kind === 'expense' ? '支出' : '收入') + '分类'));
    addBtn.addEventListener('click', function () { openCategorySheet(ctx, kind, null); });
    addWrap.appendChild(addBtn);
    page.appendChild(addWrap);

    /* 筛选：全部 / 常用 / 已隐藏 */
    var view = { mode: 'all', keyword: '' };
    var filterRow = h('div', { className: 's-settings-cats__filters', role: 'group', aria: { label: '分类筛选' } });
    var FILTERS = [
      { key: 'all', label: '全部' },
      { key: 'fav', label: '常用' },
      { key: 'hidden', label: '已隐藏' }
    ];
    var filterBtns = {};
    FILTERS.forEach(function (item) {
      var chip = h('button', {
        className: 'c-chip' + (view.mode === item.key ? ' is-active' : ''),
        type: 'button',
        text: item.label,
        aria: { pressed: view.mode === item.key ? 'true' : 'false' }
      });
      chip.addEventListener('click', function () {
        view.mode = item.key;
        FILTERS.forEach(function (f) {
          filterBtns[f.key].classList.toggle('is-active', f.key === item.key);
          filterBtns[f.key].setAttribute('aria-pressed', f.key === item.key ? 'true' : 'false');
        });
        paintList();
      });
      filterBtns[item.key] = chip;
      filterRow.appendChild(chip);
    });
    page.appendChild(filterRow);

    var listBox = h('div', { className: 's-settings-cats__listbox' });
    page.appendChild(listBox);

    function paintList() {
      while (listBox.firstChild) { listBox.removeChild(listBox.firstChild); }
      var kw = view.keyword.trim();
      var shown = items.filter(function (cat) {
        if (kw && String(cat.name || '').indexOf(kw) < 0) { return false; }
        if (view.mode === 'fav') { return favs.indexOf(String(cat.id)) >= 0; }
        if (view.mode === 'hidden') { return cat.hidden === true; }
        return true;
      });

      if (!shown.length) {
        var empty = h('div', { className: 'c-empty s-settings-empty' });
        empty.appendChild(iconEl(view.mode === 'fav' ? 'star' : 'tag', 28, 's-settings-empty__icon'));
        var title = view.mode === 'hidden' ? '没有已隐藏的分类'
          : (view.mode === 'fav' ? '还没有常用分类' : (kw ? '没有匹配的分类' : '还没有' + (kind === 'expense' ? '支出' : '收入') + '分类'));
        var desc = view.mode === 'fav' ? '点分类行右侧的星标，把常用的收进来；记一笔的主宫格会优先显示它们。'
          : (kw ? '换个关键词试试。' : '新增一个分类，记账时就能选到它。');
        empty.appendChild(t('p', 'c-empty__title', title));
        empty.appendChild(t('p', 'c-empty__desc', desc));
        listBox.appendChild(empty);
        return;
      }

      var list = h('div', { className: 'c-list s-settings-cats' });
      for (var n = 0; n < shown.length; n += 1) {
        list.appendChild(categoryRow(ctx, shown[n], kind, favs, useCount, paintList));
      }
      listBox.appendChild(list);
      var countNote = h('p', { className: 's-settings-cats__count' });
      countNote.textContent = '共 ' + shown.length + ' 个分类（收藏 ' + favs.length + '）';
      listBox.appendChild(countNote);
    }

    searchInput.addEventListener('input', function () {
      view.keyword = String(searchInput.value || '');
      paintList();
    });

    paintList();
    page.appendChild(noteBlock('系统分类可以改图标和颜色，但不能改名或删除；星标只影响记一笔主宫格的常用排序，不改动数据。'));
    root.appendChild(page);
  }

  function categoryRow(ctx, cat, kind, favs, useCount, repaint) {
    var tone = toneIndexOf(cat.color);
    var isFav = favs.indexOf(String(cat.id)) >= 0;
    var node = h('div', {
      className: 'c-row c-row--icon c-row--two-line c-row--tappable s-settings-cat-row',
      role: 'button',
      tabindex: '0',
      dataset: { categoryId: cat.id }
    });
    node.appendChild(iconEl(cat.icon || 'tag', 20, 'c-row__icon s-settings-cat-icon ' + toneClass(tone)));

    var main = h('span', { className: 'c-row__main' });
    main.appendChild(t('span', 'c-row__title', cat.name || '未命名'));
    /* M9：重复的「系统 / 支出 / 收入」pill 全撤——sub 一行说清来源与状态 */
    var subParts = [cat.system === true ? '系统分类' : '自定义分类'];
    if (cat.hidden === true) { subParts.push('已隐藏'); }
    var uses = Number(useCount[cat.id]) || 0;
    if (uses > 0) { subParts.push('记过 ' + uses + ' 笔'); }
    main.appendChild(t('span', 'c-row__sub', subParts.join(' · ')));
    node.appendChild(main);

    var trail = h('span', { className: 'c-row__trail' });
    var star = h('button', {
      className: 's-settings-cat-star' + (isFav ? ' is-active' : ''),
      type: 'button',
      aria: { label: (isFav ? '取消常用：' : '设为常用：') + (cat.name || ''), pressed: isFav ? 'true' : 'false' }
    });
    star.appendChild(iconEl('star', 18, ''));
    star.addEventListener('click', function (event) {
      if (event) { event.stopPropagation(); }
      toggleFavorite(ctx, cat.id);
      if (typeof repaint === 'function') { repaint(); }
    });
    trail.appendChild(star);
    trail.appendChild(chevron());
    node.appendChild(trail);

    bindTap(node, function () { openCategorySheet(ctx, kind, cat); });
    return node;
  }

  function openCategorySheet(ctx, kind, existing) {
    var initialTone = existing ? toneIndexOf(existing.color) : (kind === 'income' ? 11 : 1);
    if (!initialTone) { initialTone = kind === 'income' ? 11 : 1; }
    var model = {
      icon: existing ? (existing.icon || 'tag') : (kind === 'income' ? 'salary' : 'food'),
      tone: initialTone,
      /* 没点过色板就保留原色，避免「只改图标」把系统分类的原始色值改掉 */
      originalTone: initialTone
    };

    var body = h('div', { className: 's-settings-sheet s-settings-edit' });

    var field = h('label', { className: 'c-field s-settings-sheet__field' });
    field.appendChild(t('span', 'c-field__label', '名称'));
    var input = h('input', {
      className: 'c-field__input s-settings-sheet__input',
      type: 'text',
      value: existing ? existing.name : '',
      placeholder: '例如：宠物',
      maxlength: String(MAX_ITEM_NAME),
      autocomplete: 'off',
      aria: { label: '分类名称' }
    });
    if (existing && existing.system === true) {
      input.setAttribute('disabled', 'disabled');
      field.classList.add('is-disabled');
    }
    field.appendChild(input);
    body.appendChild(field);

    body.appendChild(t('p', 's-settings-sheet__label', '图标'));
    var iconGrid = h('div', { className: 's-settings-icon-grid', role: 'group', aria: { label: '分类图标' } });
    var iconButtons = [];
    for (var i = 0; i < CAT_ICON_CHOICES.length; i += 1) {
      (function (name) {
        var btn = h('button', {
          className: 's-settings-icon-btn' + (model.icon === name ? ' is-active' : ''),
          type: 'button',
          aria: { label: CAT_ICON_LABELS[name] || name, pressed: model.icon === name ? 'true' : 'false' }
        });
        btn.appendChild(iconEl(name, 20));
        btn.addEventListener('click', function () {
          model.icon = name;
          for (var b = 0; b < iconButtons.length; b += 1) {
            var isActive = iconButtons[b].getAttribute('data-icon') === name;
            iconButtons[b].classList.toggle('is-active', isActive);
            iconButtons[b].setAttribute('aria-pressed', isActive ? 'true' : 'false');
          }
        });
        btn.setAttribute('data-icon', name);
        iconButtons.push(btn);
        iconGrid.appendChild(btn);
      }(CAT_ICON_CHOICES[i]));
    }
    body.appendChild(iconGrid);

    body.appendChild(t('p', 's-settings-sheet__label', '颜色'));
    var swatches = h('div', { className: 's-settings-swatches', role: 'group', aria: { label: '分类颜色' } });
    var swatchButtons = [];
    for (var c = 1; c <= TONE_COUNT; c += 1) {
      (function (tone) {
        var btn = h('button', {
          className: 's-settings-swatch s-settings-swatch-' + tone + (model.tone === tone ? ' is-active' : ''),
          type: 'button',
          aria: { label: '颜色 ' + tone, pressed: model.tone === tone ? 'true' : 'false' }
        });
        btn.addEventListener('click', function () {
          model.tone = tone;
          for (var s = 0; s < swatchButtons.length; s += 1) {
            var isActive = Number(swatchButtons[s].getAttribute('data-tone')) === tone;
            swatchButtons[s].classList.toggle('is-active', isActive);
            swatchButtons[s].setAttribute('aria-pressed', isActive ? 'true' : 'false');
          }
        });
        btn.setAttribute('data-tone', String(tone));
        swatchButtons.push(btn);
        swatches.appendChild(btn);
      }(c));
    }
    body.appendChild(swatches);

    var errorEl = t('p', 's-settings-sheet__error', '');
    body.appendChild(errorEl);

    if (existing && existing.system === true) {
      body.appendChild(noteBlock('系统分类的名称固定，可以改图标和颜色。'));
    }

    var actions = [{ label: '取消', kind: 'text' }];
    if (existing && existing.system !== true) {
      actions.push({
        label: '删除',
        kind: 'danger',
        onClick: function () {
          openCategoryDelete(ctx, existing);
          return false;
        }
      });
    }
    actions.push({
      label: existing ? '保存' : '新增',
      kind: 'primary',
      onClick: function () {
        return saveCategory(ctx, kind, existing, model, input, errorEl);
      }
    });

    XZB.ui.sheet.open({
      title: existing ? (existing.system === true ? existing.name : '编辑分类') : '新增分类',
      content: body,
      actions: actions
    });
  }

  function saveCategory(ctx, kind, existing, model, input, errorEl) {
    var schema = schemaApi();
    var name = String(input.value || '').replace(/^\s+|\s+$/g, '');
    if (!name) {
      errorEl.textContent = MESSAGES.E_CATEGORY_NAME_EMPTY;
      return false;
    }
    if (name.length > MAX_ITEM_NAME) {
      errorEl.textContent = MESSAGES.E_CATEGORY_NAME_LONG;
      return false;
    }
    if (!schema || typeof schema.createCategory !== 'function') {
      errorEl.textContent = MESSAGES.E_COMMIT;
      return false;
    }

    var hex = existing && model.tone === model.originalTone && existing.color
      ? existing.color
      : cssVar('--cat-' + model.tone);
    if (!hex && existing) { hex = existing.color; }
    if (!hex) {
      errorEl.textContent = MESSAGES.E_INVALID_INPUT;
      return false;
    }

    var now = nowIso();
    var result = ctx.commit(function (db) {
      var list = db.categories;
      if (!Array.isArray(list)) { return { abort: true, code: 'E_CATEGORY_MISSING' }; }

      if (existing) {
        var index = -1;
        for (var i = 0; i < list.length; i += 1) {
          if (list[i] && list[i].id === existing.id) { index = i; break; }
        }
        if (index < 0) { return { abort: true, code: 'E_CATEGORY_MISSING' }; }
        var next = {};
        for (var key in list[index]) {
          if (Object.prototype.hasOwnProperty.call(list[index], key)) { next[key] = list[index][key]; }
        }
        if (existing.system !== true) { next.name = name; }
        next.icon = model.icon;
        next.color = hex;
        next.updatedAt = now;
        var check = schema.validateCategory(next, {
          original: list[index],
          categories: list
        });
        if (!check.ok) {
          return {
            abort: true,
            code: check.errors[0].code,
            message: MESSAGES[check.errors[0].code] || MESSAGES.E_INVALID_INPUT
          };
        }
        list[index] = next;
        db.updatedAt = now;
        return {};
      }

      var maxSort = 0;
      for (var s = 0; s < list.length; s += 1) {
        if (list[s] && list[s].kind === kind) {
          var value = Number(list[s].sort);
          if (isFinite(value) && value > maxSort) { maxSort = value; }
        }
      }
      var created = schema.createCategory({
        kind: kind,
        name: name,
        icon: model.icon,
        color: hex,
        sort: maxSort + 10,
        hidden: false,
        system: false,
        aliases: []
      }, now);
      var checkNew = schema.validateCategory(created, { categories: list });
      if (!checkNew.ok) {
        return {
          abort: true,
          code: checkNew.errors[0].code,
          message: MESSAGES[checkNew.errors[0].code] || MESSAGES.E_INVALID_INPUT
        };
      }
      list.push(created);
      db.updatedAt = now;
      return {};
    }, { label: existing ? '修改分类' : '新增分类' });

    Promise.resolve(result).then(function (res) {
      if (!res || !res.ok) {
        var text = messageOf(res);
        errorEl.textContent = text;
        toast(ctx, text, { type: 'danger' });
        return;
      }
      if (XZB.ui.sheet && typeof XZB.ui.sheet.close === 'function') { XZB.ui.sheet.close('saved'); }
      toast(ctx, existing ? '分类已更新' : '分类已新增', { type: 'success' });
    }, function () {
      errorEl.textContent = MESSAGES.E_COMMIT;
      toast(ctx, MESSAGES.E_COMMIT, { type: 'danger' });
    });

    return false;
  }

  function openCategoryDelete(ctx, cat) {
    var schema = schemaApi();
    var db = dbOf(ctx);
    var txs = listOf(db, 'transactions');
    var affected = 0;
    for (var i = 0; i < txs.length; i += 1) {
      if (txs[i] && txs[i].deleted !== true && txs[i].categoryId === cat.id) { affected += 1; }
    }

    var body = h('div', { className: 's-settings-sheet s-settings-danger' });
    body.appendChild(t('p', 's-settings-danger__title', '删除「' + cat.name + '」？'));
    body.appendChild(t('p', 's-settings-danger__text', affected > 0
      ? '已有 ' + affected + ' 笔流水会归到「其他」分类，记录本身不会删除。'
      : '这个分类还没有被流水使用，可以放心删除。'));

    XZB.ui.sheet.open({
      title: '删除分类',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '删除',
          kind: 'danger',
          onClick: function () {
            if (!schema || typeof schema.applyCategoryDelete !== 'function') {
              toast(ctx, MESSAGES.E_CATEGORY_MISSING, { type: 'danger' });
              return true;
            }
            live.busy = true;
            var result = ctx.commit(function (working) {
              var applied = schema.applyCategoryDelete(working, cat.id);
              if (!applied || !applied.ok) {
                return { abort: true, code: (applied && applied.code) || 'E_CATEGORY_MISSING' };
              }
              var keys = ['categories', 'transactions', 'recurring', 'categoryBudgets'];
              for (var k = 0; k < keys.length; k += 1) {
                if (Array.isArray(applied.db[keys[k]])) { working[keys[k]] = applied.db[keys[k]]; }
              }
              working.updatedAt = applied.db.updatedAt || nowIso();
              return {};
            }, { label: '删除分类' });

            Promise.resolve(result).then(function (res) {
              live.busy = false;
              if (!res || !res.ok) {
                toast(ctx, messageOf(res), { type: 'danger' });
                return;
              }
              toast(ctx, appliedToast(affected), { type: 'success' });
            }, function () {
              live.busy = false;
              toast(ctx, MESSAGES.E_COMMIT, { type: 'danger' });
            });
            return true;
          }
        }
      ]
    });
  }

  function appliedToast(affected) {
    return affected > 0 ? '分类已删除，' + affected + ' 笔流水已归到「其他」' : '分类已删除';
  }

  /* ---------------- 关于 ---------------- */

  function isStandalone() {
    try {
      if (global.navigator && global.navigator.standalone === true) { return true; }
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) { return true; }
      if (global.matchMedia && global.matchMedia('(display-mode: fullscreen)').matches) { return true; }
    } catch (error) { return false; }
    return false;
  }

  function isIOS() {
    var nav = global.navigator || {};
    var ua = String(nav.userAgent || '');
    if (/iPad|iPhone|iPod/.test(ua)) { return true; }
    return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
  }

  function openInstallSheet(ctx) {
    var body = h('div', { className: 's-settings-sheet' });
    var handle = null;

    if (isStandalone()) {
      body.appendChild(noteBlock('已经从主屏幕启动，正在以全屏应用的方式运行。', 's-settings-sheet__lead'));
      body.appendChild(noteBlock('数据仍然只保存在这台设备上，删除应用会一并删除数据，记得定期导出备份。'));
      XZB.ui.sheet.open({
        title: '主屏幕',
        content: body,
        actions: [{ label: '知道了', kind: 'primary' }]
      });
      return;
    }

    body.appendChild(noteBlock(isIOS()
      ? '用 Safari 打开小账本，按下面三步添加，之后可以离线记账。'
      : '在浏览器菜单里找到「添加到主屏幕」或「安装应用」，就可以单独打开小账本。', 's-settings-sheet__lead'));

    var steps = h('ol', { className: 's-settings-steps' });
    var lines = isIOS()
      ? ['点 Safari 底部的「分享」按钮', '在菜单里选「添加到主屏幕」', '名称保持「小账本」，点右上角「添加」']
      : ['打开浏览器右上角菜单', '选择「添加到主屏幕 / 安装应用」', '确认后从桌面图标打开'];
    for (var i = 0; i < lines.length; i += 1) {
      steps.appendChild(t('li', 's-settings-steps__item', lines[i]));
    }
    body.appendChild(steps);
    body.appendChild(noteBlock('添加到主屏幕后，数据和 Safari 里是同一份，不会重复占用空间。'));

    handle = XZB.ui.sheet.open({
      title: '加入主屏幕',
      content: body,
      actions: [{ label: '知道了', kind: 'primary' }]
    });
    return handle;
  }

  function storageInfo() {
    var info = { mode: 'idb', bytes: 0, savedAt: '', schemaVersion: 0 };
    var store = storeApi();
    if (store && typeof store.getMeta === 'function') {
      try {
        var meta = store.getMeta() || {};
        info.mode = meta.mode || 'idb';
        info.bytes = Number(meta.bytes) || 0;
        info.savedAt = meta.savedAt || '';
        info.schemaVersion = meta.schemaVersion || 0;
      } catch (error) { /* 用默认值 */ }
    }
    return info;
  }

  function renderAbout(root, ctx, db) {
    deferTitle(ctx, '关于');
    var store = storeApi();
    var counts = countsOf(db);
    var info = storageInfo();
    var settings = settingsOf(db);
    var version = (db && db.appVersion) || appVersion();

    var page = h('div', { className: 's-settings-page' });

    var hero = h('section', { className: 'c-card s-settings-about__hero' });
    var heroBody = h('div', { className: 'c-card__body' });
    var mark = h('div', { className: 's-settings-about__mark' });
    mark.appendChild(iconEl('book-ledger', 24, 's-settings-glyph'));
    heroBody.appendChild(mark);
    heroBody.appendChild(t('h2', 's-settings-about__title', '小账本'));
    heroBody.appendChild(t('p', 's-settings-about__version', '版本 ' + version + ' · 本地优先'));
    heroBody.appendChild(t('p', 's-settings-about__p', 'iPhone 上的轻量记账。没有账号，没有服务器，打开就能记。'));
    hero.appendChild(heroBody);
    page.appendChild(hero);

    var privacy = h('section', { className: 'c-card s-settings-about__privacy' });
    var privacyBody = h('div', { className: 'c-card__body' });
    privacyBody.appendChild(t('h2', 'c-card__title', '隐私'));
    privacyBody.appendChild(t('p', 's-settings-about__p s-settings-about__p--strong', '数据只存在这台设备上，无账号、无服务器、不上传。'));
    var guarantees = h('ul', { className: 's-settings-about__list' });
    var items = [
      '没有网络请求，断网也能记账',
      '导出 JSON 就是完整备份，可在新设备还原',
      '卸载应用或清除网站数据会一并删除',
      '快照也只保存在本机，最多 10 份'
    ];
    for (var i = 0; i < items.length; i += 1) {
      var li = h('li', { className: 's-settings-about__item' });
      li.appendChild(iconEl('check-circle', 16, 's-settings-about__check'));
      li.appendChild(t('span', '', items[i]));
      guarantees.appendChild(li);
    }
    privacyBody.appendChild(guarantees);
    privacy.appendChild(privacyBody);
    page.appendChild(privacy);

    var statCard = h('section', { className: 'c-card s-settings-stats' });
    var statBody = h('div', { className: 'c-card__body' });
    statBody.appendChild(t('h2', 'c-card__title', '数据条数'));
    var grid = h('div', { className: 's-settings-stats__grid' });
    grid.appendChild(statItem('流水', counts.transactions + ' 笔'));
    grid.appendChild(statItem('分类', counts.categories + ' 个'));
    grid.appendChild(statItem('账户', counts.accounts + ' 个'));
    grid.appendChild(statItem('账本', counts.books + ' 个'));
    statBody.appendChild(grid);
    statCard.appendChild(statBody);
    page.appendChild(statCard);

    var storeRows = [];
    storeRows.push(row({
      icon: 'lock',
      title: '存储方式',
      value: info.mode === 'memory' ? '临时内存（降级）' : '本机 IndexedDB',
      valueClass: info.mode === 'memory' ? 'c-row__value--expense' : null,
      chevron: false
    }));
    storeRows.push(row({ icon: 'download', title: '已用空间', value: fmtBytes(info.bytes), chevron: false }));
    storeRows.push(row({
      icon: 'clock',
      title: '最近保存',
      value: info.savedAt ? fmtTime(info.savedAt) : '—',
      chevron: false
    }));
    storeRows.push(row({
      icon: 'info',
      title: '数据版本',
      value: 'v' + (info.schemaVersion || (db && db.schemaVersion) || 2),
      chevron: false
    }));
    var snapRow = row({ icon: 'clock', title: '快照数量', value: '…', chevron: false });
    storeRows.push(snapRow);
    storeRows.push(row({
      icon: 'phone',
      title: '加入主屏幕',
      value: isStandalone() ? '已添加' : (isIOS() ? 'Safari' : '浏览器'),
      onClick: function () { openInstallSheet(ctx); }
    }));

    page.appendChild(group('存储', storeRows,
      info.mode === 'memory'
        ? '当前是临时内存模式，关闭页面后数据会丢失，请尽快导出备份。'
        : '数据保存在这台设备的浏览器数据库里。'));

    var foot = h('div', { className: 's-settings-foot' });
    foot.appendChild(t('p', 's-settings-foot__line', '小账本 2.0 · 本地优先 · 无账号 · 无服务器'));
    foot.appendChild(t('p', 's-settings-foot__line s-settings-foot__line--quiet', '预算提醒阈值 ' + (settings.budgetAlertPct || 80) + '% · 快照最多 10 份'));
    page.appendChild(foot);

    if (store && typeof store.listSnapshots === 'function' && snapRow) {
      Promise.resolve(store.listSnapshots()).then(function (result) {
        if (!alive(snapRow)) { return; }
        var value = snapRow.querySelector('.c-row__value');
        if (!value) { return; }
        if (!result || !result.ok) { value.textContent = '—'; return; }
        var list = Array.isArray(result.items) ? result.items : [];
        value.textContent = list.length + ' 份';
      }, function () { /* 静默 */ });
    }

    root.appendChild(page);
  }

  function statItem(label, value) {
    var item = h('div', { className: 's-settings-stat' });
    item.appendChild(t('span', 's-settings-stat__value', value));
    item.appendChild(t('span', 's-settings-stat__label', label));
    return item;
  }

  function sectionAbout(ctx, db) {
    var stand = isStandalone();
    var rows = [
      row({
        icon: 'phone',
        title: '加入主屏幕',
        sub: '全屏打开，离线可用',
        value: stand ? '已添加' : '引导',
        onClick: function () { openInstallSheet(ctx); }
      }),
      row({
        icon: 'lock',
        title: '隐私与数据',
        value: '仅本机',
        onClick: function () { go(ctx, '#/settings/about'); }
      }),
      row({
        icon: 'info',
        title: '版本',
        value: appVersion(),
        chevron: false,
        className: 's-settings-version'
      })
    ];
    return group('关于', rows, '数据只存在这台设备上，无账号、无服务器、不上传。');
  }

  /* ---------------- 子页标题 ---------------- */

  function deferTitle(ctx, text) {
    if (!ctx || typeof ctx.setTitle !== 'function') { return; }
    var hash = ctx.route && ctx.route.hash ? String(ctx.route.hash) : '';
    function apply() {
      try {
        var current = XZB.router && typeof XZB.router.current === 'function' ? XZB.router.current() : null;
        if (hash && current && current.hash && current.hash !== hash) { return; }
        ctx.setTitle(text);
      } catch (error) { /* 忽略 */ }
    }
    apply();
    if (typeof global.setTimeout === 'function') {
      global.setTimeout(apply, 0);
      global.setTimeout(apply, 120);
    }
  }

  /* ---------------- 主渲染 ---------------- */

  function render(root, ctx) {
    live.root = root;
    live.ctx = ctx;
    var db = dbOf(ctx);

    if (ctx.sub === 'snapshots') {
      renderSnapshots(root, ctx);
      return;
    }
    if (ctx.sub === 'categories') {
      renderCategories(root, ctx, db);
      return;
    }
    if (ctx.sub === 'about') {
      renderAbout(root, ctx, db);
      return;
    }

    root.appendChild(sectionAppearance(ctx));
    root.appendChild(sectionManage(ctx, db));
    root.appendChild(sectionAutomation(ctx, db));
    root.appendChild(sectionData(ctx, db));
    root.appendChild(sectionDanger(ctx));
    root.appendChild(sectionAbout(ctx, db));
  }

  /* ---------------- 注册 ---------------- */

  XZB.screens.register(KEY, {
    title: '我的',
    subtitle: '偏好与数据',
    render: render
  });
}(window));
