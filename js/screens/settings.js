/* 小账本 2.0 — 屏幕：设置（settings）。读写只经 XZB.app.* 门面；照片只经 XZB.app.photos.*；体积格式化唯一实现 = XZB.Core.photos.fmtBytes；导入上限唯一来源 = XZB.Core.backup.MAX_IMPORT_BYTES。 */
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
  /* 分类色写库必须落固定色值（--cat-raw-N 主题恒定），本文件不留第二份色值表。 */
  var CAT_RAW_TOKENS = ['--cat-raw-1', '--cat-raw-2', '--cat-raw-3', '--cat-raw-4',
    '--cat-raw-5', '--cat-raw-6', '--cat-raw-7', '--cat-raw-8', '--cat-raw-9',
    '--cat-raw-10', '--cat-raw-11', '--cat-raw-12'];

  /* 版本号只在 app.js 定义一处，渲染时惰性取（settings.js 先于 app.js 执行）。 */
  function appVersion() {
    return XZB.version || '';
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
    E_STORAGE_CORRUPT: '本地数据损坏，可尝试用本机快照重建',
    E_STORAGE_VERSION: '数据版本高于当前应用，请更新应用',
    E_STORAGE_WRITE: '保存失败，请重试',
    E_STORE_BUSY: '正在保存，请稍后',
    E_SNAPSHOT_NOT_FOUND: '快照不存在或已被清理',
    E_SNAPSHOT_TOO_LARGE: '数据太大，无法创建快照',
    E_EXPORT_FAILED: '导出失败，请重试',
    E_IMPORT_EMPTY: '文件是空的',
    /* E_IMPORT_TOO_LARGE 的文案现场用 fmtBytes(上限) 拼，不写死 MB 数值。 */
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

  /* 分类图标候选从 XZB.ui.icons 注册表读，本文件不留第二份 key 列表。 */
  function iconRegistry() {
    return XZB.ui && XZB.ui.icons ? XZB.ui.icons : null;
  }

  var FALLBACK_SYSTEM_ICONS = [
    'food', 'bus', 'bag', 'house', 'fun', 'health', 'book', 'phone', 'gift',
    'daily', 'carrot', 'fruit', 'snack', 'sport', 'shirt', 'beauty', 'sofa',
    'baby', 'elder', 'chat', 'plane', 'glass', 'plug', 'car', 'pet',
    'briefcase', 'hammer', 'heart', 'ticket', 'gamepad', 'wrench', 'washer',
    'family', 'salary', 'bonus', 'invest', 'parttime', 'redpacket',
    'coins', 'dots', 'ellipsis',
    /* 2.26.9 分类扩充：仅注册表缺失时的兜底，正常路径走 systemCategoryKeys() */
    'envelope', 'package', 'recharge', 'shower', 'scissors', 'bolt', 'ai',
    'file', 'settings'
  ];

  function systemIconChoices() {
    var api = iconRegistry();
    if (api && typeof api.systemCategoryKeys === 'function') {
      var list = api.systemCategoryKeys();
      if (list && list.length) { return list; }
    }
    return FALLBACK_SYSTEM_ICONS;
  }

  function CAT_ICON_CHOICES() {
    return systemIconChoices();
  }

  function CAT_COLOR_CHOICES() {
    return CAT_RAW_TOKENS;
  }

  function iconLabelOf(name) {
    var api = iconRegistry();
    if (api && typeof api.labelOf === 'function') {
      var label = api.labelOf(name);
      if (label && label !== name) { return label; }
    }
    return String(name || '');
  }

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
    /* icons.icon() 经 html 通道解析才拿到正确的 svg 命名空间。 */
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

  /* 文案优先级：result.message → store.MESSAGES → 本文件兜底表 → 通用失败。 */
  function frozenMessages() {
    var store = storeApi();
    return (store && store.MESSAGES) || {};
  }

  function messageOf(result) {
    if (!result) { return MESSAGES.E_UNKNOWN; }
    if (result.message) { return String(result.message); }
    var code = result.code ? String(result.code) : '';
    if (code === 'E_IMPORT_TOO_LARGE') { return importTooLargeText(); }
    if (code) {
      var frozen = frozenMessages()[code];
      if (frozen) { return String(frozen); }
      if (MESSAGES[code]) { return MESSAGES[code]; }
    }
    return MESSAGES.E_UNKNOWN;
  }

  /* ---------------- 上限与体积（T12 同步点 / F40） ---------------- */

  function importLimitBytes() {
    var backup = backupApi();
    var limit = backup ? backup.MAX_IMPORT_BYTES : null;
    if (typeof limit !== 'number' || !isFinite(limit) || limit <= 0) { return 0; }
    return limit;
  }

  function importTooLargeText() {
    var limit = importLimitBytes();
    if (limit > 0) { return '文件超过 ' + fmtBytes(limit) + '，无法导入'; }
    return '文件太大，无法导入';
  }

  /* 导出侧软警戒阈值：与导入闸门同一个数（backup.js 单真源），UI 同样不自带副本 */
  function exportWarnBytes() {
    var backup = backupApi();
    var limit = backup ? backup.EXPORT_SOFT_WARN_BYTES : null;
    if (typeof limit !== 'number' || !isFinite(limit) || limit <= 0) { return importLimitBytes(); }
    return limit;
  }

  /* ---------------- 照片门面（PLAN §2 XZB.app.photos，F22 提供） ---------------- */

  /* 门面或方法缺失一律降级「不可用 + 提示」，不把整屏打不开。 */
  function photosApi() {
    return (XZB.app && XZB.app.photos) ? XZB.app.photos : null;
  }

  function photoStatsReady() {
    var api = photosApi();
    return !!(api && typeof api.stats === 'function');
  }

  var PHOTO_OFFLINE_TEXT = '照片功能暂不可用，请更新应用后重试';

  function photoStatsOf() {
    var api = photosApi();
    if (!api || typeof api.stats !== 'function') { return Promise.resolve(null); }
    return Promise.resolve().then(function () {
      return api.stats();
    }).then(function (result) {
      return result && result.ok === true ? result : null;
    }, function () {
      return null;
    });
  }

  function photoCountText(stats) {
    var count = stats ? Math.floor(Number(stats.count) || 0) : 0;
    if (count <= 0) { return '暂无照片'; }
    return String(count) + ' 张 · ' + fmtBytes(Number(stats.bytes) || 0);
  }

  /* 未引用照片的可操作文案（UI.md §2.6 ③）：'清理未引用的照片（2 张 · 0.6 MB）' */
  function photoOrphanText(stats) {
    var count = stats ? Math.floor(Number(stats.orphanCount) || 0) : 0;
    var bytes = stats ? Number(stats.orphanBytes) || 0 : 0;
    return '清理未引用的照片（' + count + ' 张 · ' + fmtBytes(bytes) + '）';
  }

  function photoHintText(stats) {
    var count = stats ? Math.floor(Number(stats.count) || 0) : 0;
    if (count <= 0) {
      return '记一笔时点「照片」即可添加。照片只存在这台手机上，导出备份会一起带走。';
    }
    return '照片只存在这台手机上，导出备份会一起带走；清理后无法恢复，流水与金额不受影响。';
  }

  /* ---------------- A31 / A32：本机数据保护与首启说明（PH-PERF-6） ---------------- */

  /* A31：结果落 settings.storagePersistent，只走 store 通道，不写浏览器键值存储。 */
  var STORAGE_PERSISTENT_KEY = 'storagePersistent';
  /* A32 一次性标记：同样落 db.settings（走 store），不用浏览器键值存储。 */
  var FIRST_RUN_BANNER_KEY = 'firstRunBannerDone';
  var bannerShownThisSession = false;

  function storageProtectText(persisted) {
    if (persisted === true) { return '已开启'; }
    return '未开启（系统可能在空间紧张时清理，建议定期导出备份）';
  }

  /* 右值只留两态短句；长风险说明挪到副标题，320px 下不会被右值 58% 的宽度截掉。 */
  function storageProtectValue(persisted) {
    return persisted === true ? '已开启' : '未开启';
  }

  function storageProtectSub(persisted) {
    if (persisted === true) { return '浏览器已允许本机持久化存储'; }
    return '系统可能清理数据，请定期导出备份';
  }

  /* 读库里的持久化结果：只有逐字 true 才算已开启（缺席 / 非布尔一律按未开启显示）。 */
  function storagePersistedFlag(db) {
    return settingsOf(db)[STORAGE_PERSISTENT_KEY] === true;
  }

  /* A31 设置页可见行（存储组）：右值「已开启 / 未开启」，风险说明放副标题。 */
  function storageProtectRow(db) {
    var persisted = storagePersistedFlag(db);
    return row({
      icon: 'lock',
      title: '本机数据保护',
      sub: storageProtectSub(persisted),
      value: storageProtectValue(persisted),
      valueClass: persisted === true ? null : 's-settings-row__value--warn',
      chevron: false
    });
  }

  /* ---------------- 应用锁 ---------------- */

  /* 应用锁与「本机数据保护」是两件事：PIN 校验、冷却、抹除全在 lock.js。 */

  var LOCK_PIN_LEN = 4;
  var LOCK_PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '删除'];
  var lockSheetHandle = null;

  /* 行的值域只有「已开启 / 未开启」两态，判据只认 enabled()（不读其它标记）。 */
  function isLockEnabled() {
    return !!(XZB.lock && typeof XZB.lock.enabled === 'function' && XZB.lock.enabled());
  }

  function lockUnsupported(ctx) {
    toast(ctx, '当前浏览器不支持应用锁', { type: 'warning' });
  }

  /* 恒在「本机数据保护」下方（调用点在 renderAbout 的 storeRows，见 §7.4）。 */
  function lockRow(db) {
    var ctx = live.ctx;
    return row({
      icon: 'lock',
      title: '应用锁',
      sub: '离开 5 分钟后重新打开需要输入 PIN。只锁界面，不加密本机数据。',
      value: isLockEnabled() ? '已开启' : '未开启',
      onClick: function () { openLockSheet(ctx); }
    });
  }

  function openLockSheet(ctx) {
    if (isLockEnabled()) { openManage(ctx); return; }
    openIntro(ctx);
  }

  function closeSheet() {
    var handle = lockSheetHandle;
    lockSheetHandle = null;
    if (handle && typeof handle.close === 'function') { handle.close(); }
  }

  function lockSheetOpen(options) {
    var sheet = XZB.ui && XZB.ui.sheet;
    if (!sheet || typeof sheet.open !== 'function') {
      lockUnsupported(live.ctx);
      return null;
    }
    lockSheetHandle = sheet.open(options);
    return lockSheetHandle;
  }

  /* 与 lock.js 的启用前置条件同一判据：没有 WebCrypto 就没法用 PIN 派生校验值。 */
  function lockCryptoReady() {
    return !!(global.crypto && global.crypto.subtle &&
      typeof global.crypto.subtle.importKey === 'function');
  }

  /* 未开启：先讲清楚代价，再由用户主动开始设置。 */
  function openIntro(ctx) {
    var supported = lockCryptoReady();
    var body = h('div', { className: 's-settings-sheet' });
    body.appendChild(t('p', 's-settings-sheet__lead',
      '先设置一个 4 位 PIN，之后每次应用到前台超过 5 分钟，都要输入它才能继续。'));
    body.appendChild(t('p', 's-settings-sheet__lead',
      '只锁界面，不加密本机数据。开发者工具、截图录屏、手机丢失等情况不在保护范围内。'));
    if (!supported) {
      body.appendChild(h('div', {
        className: 'lock-error',
        role: 'alert',
        text: '当前浏览器不支持应用锁'
      }));
    }
    lockSheetOpen({
      title: '应用锁',
      content: body,
      actions: [{
        label: '开启应用锁',
        kind: 'primary',
        disabled: !supported,
        closeOnClick: false,
        onClick: function () {
          if (!supported) { return; }
          closeSheet();
          startSetup(ctx, 1, '');
        }
      }]
    });
  }

  function buildPinBody(hintText, onSubmit) {
    var state = { pin: '', busy: false };
    var body = h('div', { className: 'lock-gate__body' });
    body.appendChild(t('p', 'lock-gate__hint', hintText));

    var dots = h('div', {
      className: 'lock-dots',
      role: 'spinbutton',
      tabindex: '0',
      aria: { label: 'PIN 输入', valuemin: '0', valuemax: String(LOCK_PIN_LEN), valuenow: '0' }
    });
    var i;
    for (i = 0; i < LOCK_PIN_LEN; i += 1) {
      dots.appendChild(h('span', { className: 'lock-dot' }));
    }
    body.appendChild(dots);

    var errEl = h('div', { className: 'lock-error', role: 'alert' });
    body.appendChild(errEl);

    var pad = h('div', { className: 'lock-pad', role: 'group', aria: { label: '数字键盘' } });
    for (i = 0; i < LOCK_PIN_KEYS.length; i += 1) {
      var label = LOCK_PIN_KEYS[i];
      if (!label) {
        pad.appendChild(h('span', { className: 'lock-key lock-key--blank' }));
        continue;
      }
      var isDel = label === '删除';
      var key = h('button', {
        className: isDel ? 'lock-key lock-key--del' : 'lock-key',
        type: 'button',
        text: isDel ? '⌫' : label,
        dataset: { key: label }
      });
      key.setAttribute('aria-label', isDel ? '删除' : '数字 ' + label);
      pad.appendChild(key);
    }
    body.appendChild(pad);

    function paint() {
      dots.setAttribute('aria-valuenow', String(state.pin.length));
      dots.setAttribute('aria-valuetext', '已输入 ' + state.pin.length + ' 位，共 ' + LOCK_PIN_LEN + ' 位');
      var dotNodes = dots.querySelectorAll('.lock-dot');
      for (var d = 0; d < dotNodes.length; d += 1) {
        dotNodes[d].className = d < state.pin.length ? 'lock-dot is-filled' : 'lock-dot';
      }
    }

    function clear() {
      state.pin = '';
      state.busy = false;
      paint();
    }

    function fail(message) {
      clear();
      errEl.textContent = message || '';
    }

    function submit() {
      if (state.busy || state.pin.length !== LOCK_PIN_LEN) { return; }
      state.busy = true;
      onSubmit(state.pin, { clear: clear, fail: fail });
    }

    pad.addEventListener('click', function (event) {
      var node = event && event.target;
      while (node && node !== pad && !(node.getAttribute && node.getAttribute('data-key'))) {
        node = node.parentNode;
      }
      if (!node || node === pad || !node.getAttribute) { return; }
      var keyValue = node.getAttribute('data-key');
      if (!keyValue || state.busy) { return; }
      if (keyValue === '删除') {
        if (state.pin.length > 0) {
          state.pin = state.pin.slice(0, -1);
          paint();
        }
        return;
      }
      if (state.pin.length >= LOCK_PIN_LEN) { return; }
      errEl.textContent = '';
      state.pin += keyValue;
      paint();
      if (state.pin.length === LOCK_PIN_LEN) {
        setTimeout(submit, 60);
      }
    });

    paint();
    return body;
  }

  /* 开启：两步输入（设置 → 再输一次确认），两次一致才交给 lock.setup。 */
  function startSetup(ctx, step, firstPin) {
    var confirmStep = step === 2;
    var body = buildPinBody(confirmStep ? '再输一次确认' : '输入 4 位数字 PIN',
      function (pin, controls) {
        if (!confirmStep) {
          closeSheet();
          startSetup(ctx, 2, pin);
          return;
        }
        if (pin !== firstPin) {
          toast(ctx, '两次输入不一致，请重新设置', { type: 'warning' });
          closeSheet();
          startSetup(ctx, 1, '');
          return;
        }
        if (!XZB.lock || typeof XZB.lock.setup !== 'function') {
          lockUnsupported(ctx);
          controls.fail('当前浏览器不支持应用锁');
          return;
        }
        var task;
        try {
          task = XZB.lock.setup(pin);
        } catch (error) {
          controls.fail('设置失败，请重试');
          return;
        }
        Promise.resolve(task).then(function (res) {
          if (res && res.ok) {
            toast(ctx, '应用锁已开启', { type: 'success' });
            closeSheet();
            refreshData(ctx);
            return;
          }
          controls.fail((res && res.message) || '设置失败，请重试');
        }, function () {
          controls.fail('设置失败，请重试');
        });
      });
    lockSheetOpen({
      title: confirmStep ? '再次输入 PIN' : '设置应用锁 PIN',
      content: body,
      actions: []
    });
  }

  /* 已开启：状态 + 关闭入口 + 忘记 PIN 的去处。 */
  function openManage(ctx) {
    var body = h('div', { className: 's-settings-sheet' });
    body.appendChild(t('p', 's-settings-sheet__lead',
      '应用锁已开启。离开 5 分钟后重新打开需要输入 PIN。'));
    var linkWrap = h('div', { className: 'lock-actions' });
    var forgot = h('button', { className: 'lock-link', type: 'button', text: '忘记 PIN？' });
    forgot.addEventListener('click', function () {
      closeSheet();
      openForgot(ctx);
    });
    linkWrap.appendChild(forgot);
    body.appendChild(linkWrap);
    lockSheetOpen({
      title: '应用锁',
      content: body,
      actions: [{
        label: '关闭应用锁',
        kind: 'danger',
        closeOnClick: false,
        onClick: function () {
          closeSheet();
          startVerify(ctx);
        }
      }]
    });
  }

  /* 关闭：先验当前 PIN，失败留在本步可重试（冷却/损坏的文案由 lock.js 给）。 */
  function startVerify(ctx) {
    var body = buildPinBody('输入当前 PIN', function (pin, controls) {
      if (!XZB.lock || typeof XZB.lock.disable !== 'function') {
        lockUnsupported(ctx);
        controls.fail('当前浏览器不支持应用锁');
        return;
      }
      var task;
      try {
        task = XZB.lock.disable(pin);
      } catch (error) {
        controls.fail('PIN 不正确');
        return;
      }
      Promise.resolve(task).then(function (res) {
        if (res && res.ok) {
          toast(ctx, '应用锁已关闭', { type: 'success' });
          closeSheet();
          refreshData(ctx);
          return;
        }
        controls.fail((res && res.message) || 'PIN 不正确');
      }, function () {
        controls.fail('PIN 不正确');
      });
    });
    lockSheetOpen({ title: '关闭应用锁', content: body, actions: [] });
  }

  /* 忘记 PIN：只能走 lock.js 的抹除流（快照一并删除），文案不许给假希望。 */
  function openForgot(ctx) {
    var body = h('div', { className: 's-settings-sheet' });
    body.appendChild(t('p', 's-settings-sheet__lead',
      '忘记 PIN 后无法找回，只能用「清除本机数据」重开。'));
    body.appendChild(t('p', 's-settings-sheet__lead',
      '本机自动快照也会被一起删除，无法恢复。'));
    lockSheetOpen({
      title: '忘记 PIN',
      content: body,
      actions: [{
        label: '打开应用锁界面',
        kind: 'primary',
        closeOnClick: false,
        onClick: function () {
          if (!XZB.lock || typeof XZB.lock.showGate !== 'function') {
            lockUnsupported(ctx);
            return;
          }
          closeSheet();
          XZB.lock.showGate('relock');
        }
      }]
    });
  }

  /* A32 判定（纯函数）：返回 {show, mark, reason}；mark=true 表示这次要落一次性标记。 */
  function firstRunBannerStep(input) {
    var source = input || {};
    if (source.empty !== true) { return { show: false, mark: false, reason: 'not-empty' }; }
    if (source.prior === true) { return { show: true, mark: false, reason: 'same-session' }; }
    if (source.done === true) { return { show: false, mark: false, reason: 'marked' }; }
    return { show: true, mark: true, reason: 'first' };
  }

  var FIRST_RUN_BANNER_TITLE = '照片与备份';
  var FIRST_RUN_BANNER_LINES = [
    '若你以前用过，本机数据可能已被系统清理，请导入上次备份。',
    '照片随流水保存，导出备份可带走。'
  ];

  /* 横幅只用既有类名，不新增 s-settings-* 类。 */
  function firstRunBannerNode() {
    var card = h('section', { className: 'c-card' });
    var body = h('div', { className: 'c-card__body' });
    body.appendChild(t('h2', 'c-card__title', FIRST_RUN_BANNER_TITLE));
    for (var i = 0; i < FIRST_RUN_BANNER_LINES.length; i += 1) {
      body.appendChild(noteBlock(FIRST_RUN_BANNER_LINES[i]));
    }
    card.appendChild(body);
    return card;
  }

  function firstRunBannerMaybe(root, ctx, db) {
    if (listOf(db, 'transactions').length > 0) { return; }
    photoStatsOf().then(function (stats) {
      if (!alive(root)) { return; }
      var count = stats ? Math.floor(Number(stats.count) || 0) : 0;
      if (count > 0) { return; }
      var step = firstRunBannerStep({
        empty: true,
        done: settingsOf(db)[FIRST_RUN_BANNER_KEY] === true,
        prior: bannerShownThisSession
      });
      if (!step.show) { return; }
      bannerShownThisSession = true;
      var strip = h('div', { className: 's-settings-notice' });
      strip.appendChild(firstRunBannerNode());
      root.insertBefore(strip, root.firstChild);
      if (step.mark) { commitSetting(ctx, FIRST_RUN_BANNER_KEY, true, '照片说明'); }
    });
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

  /* 开关拨动的手感：统一走 ui/haptics，别在屏幕层各写一份 vibrate */
  function buzz(ctx) {
    var api = XZB.ui && XZB.ui.haptics;
    if (api && typeof api.fire === 'function') {
      api.fire('select');
      return;
    }
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

  /* 体积格式化唯一实现 = XZB.Core.photos.fmtBytes，本文件只转发。 */
  var coreFmtBytes = (XZB.Core && XZB.Core.photos) ? XZB.Core.photos.fmtBytes : null;

  function fmtBytes(bytes) {
    if (typeof coreFmtBytes === 'function') { return coreFmtBytes(bytes); }
    var Core = XZB.Core || XZB.core || null;
    var photos = Core ? Core.photos : null;
    if (photos && typeof photos.fmtBytes === 'function') { return photos.fmtBytes(bytes); }
    return '';
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
    var pending = false;

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

    function setPending(on) {
      pending = on;
      button.setAttribute('aria-busy', on ? 'true' : 'false');
      node.classList.toggle('is-busy', on);
      if (on) { button.setAttribute('disabled', 'disabled'); }
      else { button.removeAttribute('disabled'); }
    }

    function flip(next) {
      if (pending) { return; }
      if (live.busy) { return; }
      checked = next;
      button.setAttribute('aria-checked', checked ? 'true' : 'false');
      setPending(true);
      buzz(ctx);
      var result = null;
      try { result = opts.onChange ? opts.onChange(checked) : null; } catch (error) { result = null; }
      Promise.resolve(result).then(function (ok) {
        setPending(false);
        if (ok === false) {
          checked = !checked;
          button.setAttribute('aria-checked', checked ? 'true' : 'false');
        }
      }, function () {
        setPending(false);
        checked = !checked;
        button.setAttribute('aria-checked', checked ? 'true' : 'false');
        toast(ctx, '设置没保存上，请重试', { type: 'danger' });
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
    function paint(activeValue) {
      for (var i = 0; i < buttons.length; i += 1) {
        var on = buttons[i].getAttribute('data-theme') === activeValue;
        buttons[i].classList.toggle('is-active', on);
        buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    function select(value) {
      paint(value);
      var ok = prefsSet(ctx, 'theme', value);
      if (!ok && XZB.app && typeof XZB.app.setTheme === 'function') {
        try { XZB.app.setTheme(value); ok = true; } catch (error) { ok = false; }
      }
      if (!ok) {
        toast(ctx, '主题切换失败，请重试', { type: 'danger' });
        paint(prefsGet(ctx, 'theme', 'auto'));
      }
    }

    for (var i = 0; i < THEMES.length; i += 1) {
      (function (item) {
        var button = h('button', {
          className: 'c-segmented__item' + (current === item.value ? ' is-active' : ''),
          type: 'button',
          text: item.label,
          aria: { pressed: current === item.value ? 'true' : 'false' },
          dataset: { theme: item.value }
        });
        button.addEventListener('click', function () { select(item.value); });
        buttons.push(button);
        seg.appendChild(button);
      }(THEMES[i]));
    }

    node.appendChild(seg);
    return node;
  }

  function sectionAppearance(ctx) {
    /* 震动开关按平台出现（iOS Safari 无 navigator.vibrate）；2.11.1 起点按即震。 */
    var rows = [themeRow(ctx)];
    var haptics = XZB.ui && XZB.ui.haptics;
    if (haptics && typeof haptics.supported === 'function' && haptics.supported()) {
      rows.push(switchRow(ctx, {
        icon: 'sparkles',
        title: '点按震动',
        sub: '每次点击给一下轻微反馈',
        checked: prefsGet(ctx, 'haptics', true) !== false,
        onChange: function (next) {
          var saved = prefsSet(ctx, 'haptics', next);
          try { haptics.setEnabled(next); } catch (error) { /* 忽略 */ }
          return saved;
        }
      }));
    }
    return group('显示与手感', rows);
  }

  /* ---------------- B 安全（主屏可见；原在 about 子页「存储」组，IA-3 上移） ---------------- */

  /* 存储/应用锁两行已上移主屏「安全」组（IA-3），about 子页不留重复入口。 */
  function sectionSecurity(ctx, db) {
    var storeRows = [];
    storeRows.push(storageProtectRow(db));
    storeRows.push(lockRow(db));
    return group('安全', storeRows, '应用锁只锁界面，不加密本机数据；本机数据保护是浏览器授予的持久化状态。');
  }

  /* ---------------- 小助手（2.17.0） ---------------- */

  function historyApi() { return coreMod('history'); }

  function historyCount() {
    var api = historyApi();
    if (!api || typeof api.list !== 'function') { return 0; }
    try {
      var entries = api.list();
      return entries && entries.length ? entries.length : 0;
    } catch (error) { return 0; }
  }

  /* 配置读写一律经 XZB.core.assistant.llm；本屏 DEPS 只含 icon-picker，先惰性 ensure。 */
  function llmApi() {
    var core = coreMod('assistant');
    if (core && core.llm) { return core.llm; }
    var top = XZB.assistant;
    if (top && top.llm) { return top.llm; }
    return null;
  }

  function ensureAssistantCore() {
    if (llmApi()) { return Promise.resolve(true); }
    var chunks = XZB.chunks;
    if (!chunks || typeof chunks.ensure !== 'function') { return Promise.resolve(false); }
    var pending = null;
    try { pending = chunks.ensure('core-assistant'); } catch (error) { pending = null; }
    if (!pending || typeof pending.then !== 'function') { return Promise.resolve(!!llmApi()); }
    return pending.then(function () { return !!llmApi(); }, function () { return false; });
  }

  function llmCfg() {
    var api = llmApi();
    if (!api || typeof api.getConfig !== 'function') { return null; }
    try {
      var res = api.getConfig();
      if (!res || res.ok !== true || !res.cfg) { return null; }
      return res.cfg;
    } catch (error) { return null; }
  }

  /* 四态右值（设计 §4.5）：未配置 / 已关闭·纯本地 / 未就绪·纯本地 / 已开启。主页面不放模型名。
     2.26.9 修复：getConfig 从未返回过 status 字段，旧判定恒走「未就绪」；
     改用 llmConfigView 实际提供的 ready（=已开启且已同意隐私告知）。 */
  function llmRowValue() {
    var cfg = llmCfg();
    if (!cfg) { return '未配置 · 纯本地'; }
    var configured = cfg.hasKey === true && cfg.baseURL && cfg.model;
    if (!configured) { return '未配置 · 纯本地'; }
    if (cfg.enabled !== true) { return '已关闭 · 纯本地'; }
    if (cfg.ready !== true) { return '未就绪 · 纯本地'; }
    return '已开启';
  }

  function sectionAssistant(ctx) {
    var count = historyCount();
    var rows = [
      row({
        icon: 'sparkles',
        title: '小助手',
        sub: '说一句「午饭 28 微信」就记好，也能改、删、查',
        onClick: function () { go(ctx, '#/assistant'); }
      }),
      row({
        icon: 'cloud',
        title: '在线模型',
        sub: '自己填接口地址与密钥；不填就纯本地解析',
        value: llmRowValue(),
        onClick: function () { go(ctx, '#/settings/ai'); }
      }),
      row({
        icon: 'undo',
        title: '撤销历史',
        sub: count ? '最近 ' + count + ' 次写入可以撤' : '还没有可撤销的记录',
        value: count ? count + ' 条' : '暂无',
        onClick: function () { go(ctx, '#/assistant/history'); }
      })
    ];
    /* A30 / D-05：清空撤销历史只在 #/assistant/history 子页留一个入口。 */
    return group('小助手与联网', rows,
      '默认在本机解析；开启在线模型后，你说的话会与账户名称一起发送给你配置的模型服务。撤销历史只记录小助手与手动记账的差异，最多 30 条。');
  }

  /* ---------------- 记账管理（M12：按任务找入口，不按实现方式） ---------------- */

  /* ---------------- 本机数据总览（2.26.0：首屏先交代数据在哪、有多少） ---------------- */

  function sectionOverview(ctx, db) {
    var counts = countsOf(db);
    var info = storageInfo();

    var wrap = h('section', { className: 'c-card s-settings-overview' });
    var body = h('div', { className: 'c-card__body' });
    body.appendChild(t('h2', 'c-card__title', '我的账本'));
    body.appendChild(t('p', 's-settings-overview__lead', '数据仅保存在此设备，不需要账号'));

    var grid = h('div', { className: 's-settings-overview__grid' });
    grid.appendChild(statItem('流水', counts.transactions + ' 笔'));
    grid.appendChild(statItem('账户', counts.accounts + ' 个'));
    grid.appendChild(statItem('账本', counts.books + ' 个'));
    body.appendChild(grid);

    var mode = h('p', { className: 's-settings-overview__mode' });
    mode.appendChild(t('span', 's-settings-overview__mode-label', '存储'));
    mode.appendChild(t('span', 's-settings-overview__mode-value' + (info.mode === 'memory' ? ' is-warn' : ''),
      info.mode === 'memory' ? '临时内存 · 关闭页面即丢失' : '本机 IndexedDB'));
    body.appendChild(mode);

    if (info.mode === 'memory') {
      body.appendChild(noteBlock('当前是临时内存模式，关闭页面后数据会丢失，请先导出备份。', 's-settings-overview__warn'));
    }

    var empty = counts.transactions === 0;
    var btn = h('button', {
      className: 'c-btn c-btn--primary s-settings-overview__export', type: 'button',
      text: empty ? '导入备份' : '导出备份'
    });
    btn.addEventListener('click', function () {
      if (empty) { pickImportFile(ctx); return; }
      openExportSheet(ctx);
    });
    body.appendChild(btn);

    wrap.appendChild(body);
    return wrap;
  }

  function sectionManage(ctx, db) {
    var settings = settingsOf(db);
    var categories = listOf(db, 'categories').length;

    return group('记账与分类', [
      row({
        icon: 'target',
        title: '预算与存钱目标',
        value: listOf(db, 'budgets').length > 0 ? '已设置' : '未设置',
        onClick: function () { go(ctx, '#/plan'); }
      }),
      row({
        icon: 'tag',
        title: '分类管理',
        sub: '常用的会排在前面',
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
      }),
      /* 2.26.0：自动入账并入记账管理（原来单独占一个「自动化」组）。 */
      switchRow(ctx, {
        icon: 'repeat',
        title: '定期账单自动入账',
        sub: '打开应用时自动补记，默认关闭',
        checked: settings.recurringAutoPost === true,
        onChange: function (next) {
          return commitSetting(ctx, 'recurringAutoPost', next, next ? '开启定期自动入账' : '关闭定期自动入账');
        }
      })
    ], '定期账单只在打开应用时补记，不会在后台运行。');
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
    /* A33 导出前明文/隐私告知：备份是明文，照片可能带位置信息（EXIF 保留口径见 photos.js） */
    body.appendChild(noteBlock('备份文件是未加密的明文集合，照片可能含位置信息，请妥善保管。', 's-settings-sheet__note'));

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

  /* 导出提示的照片附注：included=false 或无照片时一个字都不加。 */
  function photoExportSummary(result) {
    var photos = result ? result.photos : null;
    if (!photos || photos.included !== true) { return ''; }
    var count = Math.floor(Number(photos.count) || 0);
    if (count <= 0) { return ''; }
    var bytes = Number(photos.bytes);
    return '（' + count + ' 张照片' + (isFinite(bytes) && bytes > 0 ? ' · 约 ' + fmtBytes(bytes) : '') + '）';
  }

  /* A24 导出体积护栏：硬守卫与软警戒共用一套结构；文案取自 MESSAGES，数值现场 fmtBytes。 */
  function openExportTooLargeSheet(ctx, result, format, opts) {
    var warn = (result && result.softWarning) ? result.softWarning : (result || {});
    var blocked = !result || result.ok !== true;
    var count = Math.floor(Number(warn.count !== undefined ? warn.count : warn.photos) || 0);
    var photoBytes = Math.floor(Number(warn.photoBytes) || 0);
    var fileBytes = Math.floor(Number(warn.bytes) || 0);
    var limit = Math.floor(Number(warn.maxBytes) || 0);
    if (!(limit > 0)) { limit = exportWarnBytes(); }
    var canSkipPhotos = warn.canExportWithoutPhotos === true
      || (result && result.canExportWithoutPhotos === true);

    var body = h('div', { className: 's-settings-sheet' });
    body.appendChild(noteBlock(messageOf(warn), 's-settings-sheet__lead'));

    var list = h('div', { className: 'c-list s-settings-sheet__list' });
    list.appendChild(row({ title: '照片', value: count + ' 张', chevron: false }));
    if (photoBytes > 0) {
      list.appendChild(row({ title: '照片体积', value: fmtBytes(photoBytes), chevron: false }));
    }
    if (fileBytes > 0) {
      list.appendChild(row({ title: '导出文件', value: '约 ' + fmtBytes(fileBytes), chevron: false }));
    }
    if (limit > 0) {
      list.appendChild(row({ title: '上限', value: fmtBytes(limit), chevron: false }));
    }
    body.appendChild(list);
    body.appendChild(noteBlock('照片仍留在本机；也可以先清理照片，再导出带图的备份。'));

    var handle = null;
    var actions = [];
    if (canSkipPhotos) {
      actions.push({
        label: '不含图片导出',
        kind: 'primary',
        onClick: function () {
          if (handle) { handle.close(); }
          startExport(ctx, 'json', { includePhotos: false });
          return false;
        }
      });
    }
    if (!blocked) {
      actions.push({
        label: '仍然导出',
        kind: 'secondary',
        onClick: function () {
          if (handle) { handle.close(); }
          deliverExport(ctx, result, format, opts);
          return false;
        }
      });
    }
    actions.push({ label: '取消', kind: 'text' });

    handle = XZB.ui.sheet.open({
      title: blocked ? '照片太多，导出被拦下' : '导出文件偏大',
      content: body,
      actions: actions
    });
  }

  function startExport(ctx, format, options) {
    var backup = backupApi();
    if (!backup) {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
      return;
    }
    var opts = options || {};
    var promise = format === 'csv' ? backup.exportCsv() : backup.exportJson(opts);
    Promise.resolve(promise).then(function (result) {
      if (!result || !result.ok) {
        /* 导出侧体积守卫命中：必须给出张数/体积 +「不含图片导出」，不能只甩一句失败 */
        if (result && result.code === 'E_PHOTO_EXPORT_TOO_LARGE') {
          openExportTooLargeSheet(ctx, result, format, opts);
          return;
        }
        toast(ctx, messageOf(result), { type: 'danger' });
        return;
      }
      /* 软警戒：整份文件超过软阈值（不阻断），先让用户选「不含图片导出」还是「仍然导出」 */
      if (format === 'json' && result.softWarning && opts.includePhotos !== false) {
        openExportTooLargeSheet(ctx, result, format, opts);
        return;
      }
      deliverExport(ctx, result, format, opts);
    }, function () {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
    });
  }

  function deliverExport(ctx, result, format, options) {
    var opts = options || {};
    var photoNote = photoExportSummary(result);
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
              toast(ctx, '已打开系统分享' + photoNote, { type: 'success' });
            }, function (error) {
              if (error && error.name === 'AbortError') { return; }
              downloadFallback(ctx, format, opts, photoNote);
            });
            return;
          }
        }
      }
    }
    downloadFallback(ctx, format, opts, photoNote);
  }

  function downloadFallback(ctx, format, options, photoNote) {
    var backup = backupApi();
    if (!backup || typeof backup.download !== 'function') {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
      return;
    }
    Promise.resolve(backup.download(format, options || {})).then(function (result) {
      if (!result || !result.ok) {
        toast(ctx, messageOf(result), { type: 'danger' });
        return;
      }
      var note = typeof photoNote === 'string' ? photoNote : photoExportSummary(result);
      toast(ctx, '已导出 ' + result.filename + note, { type: 'success' });
    }, function () {
      toast(ctx, MESSAGES.E_EXPORT_FAILED, { type: 'danger' });
    });
  }

  /* ---------------- 数据：导入 ---------------- */

  /* 临时 <input type=file>：change / cancel / 焦点回来 300ms 都移除，连点不叠加。 */
  var importInput = null;
  var importTimer = 0;

  function removeImportInput() {
    if (importTimer) { global.clearTimeout(importTimer); importTimer = 0; }
    if (!importInput) { return; }
    var node = importInput;
    importInput = null;
    try { node.value = ''; } catch (error) { /* 忽略 */ }
    if (node.parentNode) { node.parentNode.removeChild(node); }
  }

  function onWindowFocusForImport() {
    if (!importInput) { return; }
    if (importTimer) { global.clearTimeout(importTimer); }
    importTimer = global.setTimeout(removeImportInput, 300);
  }

  function pickImportFile(ctx) {
    if (!live.root) { return; }
    removeImportInput();
    var input = h('input', {
      className: 's-settings-fileinput',
      type: 'file',
      accept: '.json,application/json',
      tabindex: '-1',
      aria: { hidden: 'true' }
    });
    importInput = input;
    input.addEventListener('change', function () {
      var file = input.files && input.files.length ? input.files[0] : null;
      removeImportInput();
      if (file) {
        toast(ctx, '正在读取备份…', { type: 'info' });
        readImportFile(ctx, file);
      }
    });
    input.addEventListener('cancel', removeImportInput);
    live.root.appendChild(input);
    try {
      input.click();
    } catch (error) {
      removeImportInput();
      toast(ctx, '系统不允许打开文件选择，请检查浏览器权限后再试', { type: 'danger' });
      return;
    }
    toast(ctx, '请选择要导入的备份文件', { type: 'info' });
  }

  function readImportFile(ctx, file) {
    var limit = importLimitBytes();
    if (limit > 0 && file.size > limit) {
      toast(ctx, importTooLargeText(), { type: 'danger' });
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

  function photoSectionInBackup(value) {
    if (!value || typeof value !== 'object') { return null; }
    if (value.photos && typeof value.photos === 'object') { return value.photos; }
    var data = value.data;
    if (data && typeof data === 'object' && data.photos && typeof data.photos === 'object') {
      return data.photos;
    }
    return null;
  }

  function photoSectionCount(section) {
    if (!section) { return 0; }
    if (Array.isArray(section.items)) { return section.items.length; }
    var count = Number(section.count);
    return isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function photoSectionBytes(section) {
    if (!section) { return 0; }
    var declared = Number(section.bytes);
    if (isFinite(declared) && declared > 0) { return Math.floor(declared); }
    var items = Array.isArray(section.items) ? section.items : [];
    var sum = 0;
    for (var i = 0; i < items.length; i += 1) {
      var one = items[i] ? Number(items[i].bytes) : 0;
      if (isFinite(one) && one > 0) { sum += Math.floor(one); }
    }
    return sum;
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
      /* 上限现场读 XZB.Core.backup.MAX_IMPORT_BYTES 并用 fmtBytes 展示 —— 界面里没有 MB 字面量 */
      var limit = importLimitBytes();
      var fileLine = filename + ' · ' + fmtBytes(bytes);
      if (limit > 0) { fileLine += '（上限 ' + fmtBytes(limit) + '）'; }
      body.appendChild(t('p', 's-settings-sheet__file', fileLine));
    }
    body.appendChild(noteBlock(kind === 'v2' ? '识别为 2.0 备份。' : '识别为 1.x 备份，将迁移到 2.0 结构。', 's-settings-sheet__lead'));

    var statList = h('div', { className: 'c-list s-settings-sheet__list' });
    statList.appendChild(row({ title: '来源', value: kind === 'v2' ? '2.0 备份' : '1.x 备份', chevron: false }));
    statList.appendChild(row({ title: '流水', value: (report.transactions || 0) + ' 笔', chevron: false }));
    statList.appendChild(row({ title: '账本 / 分类', value: (report.books || 0) + ' / ' + (report.categories || 0), chevron: false }));
    /* 含图备份：先把照片张数与体积摆出来，导入后还能对着核对（体积一律 fmtBytes） */
    var backupPhotos = photoSectionInBackup(parsed.value);
    var backupPhotoCount = photoSectionCount(backupPhotos);
    if (backupPhotoCount > 0) {
      var backupPhotoBytes = photoSectionBytes(backupPhotos);
      statList.appendChild(row({
        title: '照片',
        value: backupPhotoCount + ' 张' + (backupPhotoBytes > 0 ? ' · 约 ' + fmtBytes(backupPhotoBytes) : ''),
        chevron: false
      }));
    }
    var range = dateRangeOf(parsed.value, kind);
    if (range) {
      statList.appendChild(row({ title: '时间范围', value: range, chevron: false }));
    }
    if (report.skipped > 0) {
      statList.appendChild(row({
        title: '跳过',
        sub: '与已有记录重复，或数据缺少唯一标识',
        value: report.skipped + ' 行',
        valueClass: 'c-row__value--expense',
        chevron: false
      }));
    }
    body.appendChild(statList);

    body.appendChild(t('p', 's-settings-sheet__label', '导入方式'));
    var seg = h('div', {
      className: 'c-segmented s-settings-import__seg',
      role: 'group',
      aria: { label: '导入方式' }
    });
    var mergeBtn = h('button', {
      className: 'c-segmented__item is-active', type: 'button', text: '合并',
      aria: { pressed: 'true' }
    });
    var replaceBtn = h('button', {
      className: 'c-segmented__item', type: 'button', text: '整份替换',
      aria: { pressed: 'false' }
    });
    var modeNote = t('p', 's-settings-sheet__note', '');

    function setMode(next) {
      mode = next;
      var isMerge = next === 'merge';
      mergeBtn.setAttribute('aria-pressed', isMerge ? 'true' : 'false');
      replaceBtn.setAttribute('aria-pressed', isMerge ? 'false' : 'true');
      mergeBtn.classList.toggle('is-active', isMerge);
      replaceBtn.classList.toggle('is-active', !isMerge);
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

  /* 导入结果的照片段如实回报张数与体积；老备份无该段不加一字、不当失败。 */
  function photoRestoredText(report) {
    var photos = report ? report.photos : null;
    if (!photos || photos.present !== true) { return ''; }
    var count = Math.floor(Number(photos.count) || 0);
    if (count <= 0) { return ''; }
    var bytes = Number(photos.bytes);
    return '，已还原 ' + count + ' 张照片'
      + (isFinite(bytes) && bytes > 0 ? '（约 ' + fmtBytes(bytes) + '）' : '');
  }

  function photoMissingCount(report) {
    var photos = report ? report.photos : null;
    if (!photos || !Array.isArray(photos.missingRefs)) { return 0; }
    return photos.missingRefs.length;
  }

  /* 「跳过 N 条」的唯一措辞（v1 迁移与 2.x 导入共用一句，避免两处文案各自漂移）。 */
  function skippedText(skipped) {
    return '跳过 ' + skipped + ' 条（与已有记录重复，或数据缺少唯一标识，未导入）';
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
      var missed = skippedText(skipped);
      /* 含图备份：还原张数并进同一句提示（体积用 fmtBytes）；缺图的引用（A13）单独说明 */
      var restored = photoRestoredText(report);
      var missingPhotos = photoMissingCount(report);
      var photoMissed = missingPhotos > 0 ? '，有 ' + missingPhotos + ' 张照片未能还原' : '';
      var message;
      var warn = skipped > 0 || missingPhotos > 0;
      if (result.sourceVersion === 1) {
        message = '迁移 ' + count + ' 条' + restored + (skipped > 0 ? '，' + missed : '');
      } else {
        message = '已导入 ' + count + ' 笔流水' + restored + (skipped > 0 ? '，' + missed : '');
      }
      message += photoMissed;
      refreshData(ctx).then(function () {
        toast(ctx, message, { type: warn ? 'warning' : 'success' });
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
        var migrated = report.transactions || 0;
        var dropped = report.skipped || 0;
        toast(ctx, '迁移 ' + migrated + ' 条' + (dropped > 0
          ? '，' + skippedText(dropped)
          : ''), { type: dropped > 0 ? 'warning' : 'success' });
      });
    }, function () {
      live.busy = false;
      toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
    });
  }

  /* ---------------- 数据：清空 ---------------- */

  function openClearSheet(ctx) {
    var sheet = XZB.ui && XZB.ui.sheet;
    if (!sheet || typeof sheet.confirm !== 'function') { return; }
    /* 清空可恢复（store.reset 先落 manual 快照）；照片不动、不列张数；toast 固定「已清空全部数据」。 */
    sheet.confirm({
      title: '清空全部账单',
      message: '这会删除全部账本、流水、分类、预算和存钱目标。执行前会自动保存一份快照，之后可以在「快照记录」里恢复。照片不会被删除，但会失去对应流水。',
      confirmLabel: '清空全部账单',
      kind: 'danger',
      requireText: CONFIRM_CLEAR,
      inputLabel: '输入「清空」两个字',
      mismatchText: '确认文字不一致，操作已取消',
      onConfirm: function (close) {
        if (live.busy) { return; }
        var store = storeApi();
        if (!store || typeof store.reset !== 'function') {
          toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
          return;
        }
        live.busy = true;
        Promise.resolve(store.reset()).then(function (result) {
          live.busy = false;
          if (!result || !result.ok) {
            toast(ctx, messageOf(result), { type: 'danger' });
            return;
          }
          close();
          refreshData(ctx).then(function () {
            toast(ctx, '已清空全部数据', { type: 'success' });
            go(ctx, '#/home');
          });
        }, function () {
          live.busy = false;
          toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
        });
      }
    });
  }

  /* ---------------- 数据：照片占用与清理（F40） ---------------- */

  /* 设置页「照片」行的右值节点（单屏单实例；设置页重渲染时被新节点替换） */
  var photoRowValueNode = null;

  /* 2.26.1：fill 发生在分组尚未挂到文档时，不能先判 alive 再订阅（会把刷新整段跳过，
     右值永远停在「…」）。与快照行一致：先订阅，回包里再判存活。 */
  function refreshPhotoRow() {
    var node = photoRowValueNode;
    if (!node) { return; }
    if (!photoStatsReady()) {
      node.textContent = '不可用';
      return;
    }
    photoStatsOf().then(function (stats) {
      if (!node || !alive(node)) { return; }
      node.textContent = stats ? photoCountText(stats) : '—';
    });
  }

  function fillPhotosValue(ctx, node) {
    if (!node) { return; }
    photoRowValueNode = node.querySelector('.c-row__value');
    refreshPhotoRow();
  }

  /* 5 秒撤销：优先门面 undoToken，否则用删除前读回的 records + 门面 put（只做编排）。 */
  function offerPhotoUndo(ctx, message, undoToken, records, after) {
    var api = photosApi();
    var canToken = !!(undoToken && api && typeof api.restoreUndo === 'function');
    var canRecords = !!(records && records.length && api && typeof api.put === 'function');
    if (!canToken && !canRecords) {
      toast(ctx, message, { type: 'success' });
      return;
    }
    toast(ctx, message, {
      type: 'success',
      action: {
        label: '撤销',
        onClick: function () {
          var pending = canToken ? api.restoreUndo(undoToken) : api.put(records);
          Promise.resolve(pending).then(function (result) {
            if (!result || !result.ok) {
              toast(ctx, messageOf(result), { type: 'danger' });
              return;
            }
            if (typeof after === 'function') { after(); }
            toast(ctx, '已恢复', { type: 'success' });
          }, function () {
            toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
          });
        }
      }
    });
  }

  function cleanOrphanPhotos(ctx, stats, after) {
    var api = photosApi();
    if (!api || typeof api.purge !== 'function') {
      toast(ctx, PHOTO_OFFLINE_TEXT, { type: 'danger' });
      return;
    }
    var ids = stats && Array.isArray(stats.orphanRefs) ? stats.orphanRefs.slice() : [];
    if (!ids.length) {
      toast(ctx, '没有可清理的照片', { type: 'warning' });
      if (typeof after === 'function') { after(); }
      return;
    }
    if (live.busy) { return; }
    live.busy = true;
    /* 撤销的料：删除前把整条 record 读回内存（不是重造一份，回填时同 id 原样写回） */
    Promise.resolve(typeof api.get === 'function' ? api.get(ids) : []).then(function (read) {
      var records = [];
      var list = read && Array.isArray(read.records) ? read.records : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id) { records.push(list[i]); }
      }
      return Promise.resolve(api.purge(ids)).then(function (result) {
        live.busy = false;
        if (!result || !result.ok) {
          toast(ctx, messageOf(result), { type: 'danger' });
          return;
        }
        var removed = Math.floor(Number(result.purged) || 0) || records.length;
        if (typeof after === 'function') { after(); }
        offerPhotoUndo(ctx, '已清理 ' + removed + ' 张未使用的照片', result.undoToken, records, after);
      });
    }).then(null, function () {
      live.busy = false;
      toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
    });
  }

  /* 清空所有照片：purgeAll 先建 pre 快照，但照片不随快照保留，如实说明、不假装可撤销。 */
  function purgeAllPhotos(ctx, after) {
    var api = photosApi();
    if (!api || typeof api.purgeAll !== 'function') {
      toast(ctx, PHOTO_OFFLINE_TEXT, { type: 'danger' });
      return;
    }
    if (live.busy) { return; }
    live.busy = true;
    Promise.resolve(api.purgeAll()).then(function (result) {
      live.busy = false;
      if (!result || !result.ok) {
        toast(ctx, messageOf(result), { type: 'danger' });
        return;
      }
      var removed = Math.floor(Number(result.purged) || 0);
      var freed = Math.floor(Number(result.bytes) || 0);
      if (typeof after === 'function') { after(); }
      var message = '已清空 ' + removed + ' 张照片' + (freed > 0 ? '，释放 ' + fmtBytes(freed) : '');
      if (result.undoToken) {
        offerPhotoUndo(ctx, message, result.undoToken, null, after);
        return;
      }
      toast(ctx, removed > 0 ? message + '（照片不随快照保留）' : message, { type: 'success' });
    }, function () {
      live.busy = false;
      toast(ctx, MESSAGES.E_STORAGE_WRITE, { type: 'danger' });
    });
  }

  /* 危险确认浮层（UI.md §2.6：标题「清空所有照片？」+ 张数/体积 + 影响面 + 取消/清空） */
  function openPurgeAllSheet(ctx, stats, after) {
    var count = stats ? Math.floor(Number(stats.count) || 0) : 0;
    var bytes = stats ? Number(stats.bytes) || 0 : 0;
    var handle = null;
    var body = h('div', { className: 's-settings-sheet s-settings-danger' });
    body.appendChild(t('p', 's-settings-danger__title',
      '将删除 ' + count + ' 张照片，释放 ' + fmtBytes(bytes) + '。流水、金额与账本不会被删除。'));
    body.appendChild(t('p', 's-settings-danger__text',
      '清空前会自动保存一份快照，但照片本身不随快照保留，清理后无法恢复。'));
    body.appendChild(noteBlock('照片只存在这台手机上，不会被带出这台设备。', 's-settings-danger__hint'));

    handle = XZB.ui.sheet.open({
      title: '清空所有照片？',
      content: body,
      actions: [
        { label: '取消', kind: 'text' },
        {
          label: '清空',
          kind: 'danger',
          onClick: function () {
            if (handle) { handle.close(); }
            purgeAllPhotos(ctx, after);
            return false;
          }
        }
      ]
    });
  }

  /* 照片占用/清理浮层（UI.md §2.6：s-settings-photos + 大字 + 说明 + 动作行 + 底注） */
  function openPhotosSheet(ctx) {
    var body = h('div', { className: 's-settings-sheet' });
    var state = { stats: null, loading: true, failed: false };

    function render() {
      clearNode(body);
      var stats = state.stats;
      body.appendChild(t('p', 's-settings-photos__big u-tabular',
        state.loading ? '…' : photoCountText(stats)));
      body.appendChild(t('p', 's-settings-photos__hint', photoHintText(stats)));

      if (state.failed) {
        /* 门面缺席：禁掉两个动作行，只留说明 —— 不硬依赖，也不给假按钮 */
        body.appendChild(noteBlock(PHOTO_OFFLINE_TEXT, 's-settings-note--danger'));
        body.appendChild(t('p', 's-settings-photos__foot', '备份文件包含照片；导入时会按需还原。'));
        return;
      }

      /* 三个数分开摆，都取自 photoStats()：张数 / 占用体积 / 缩略图体积（体积一律 fmtBytes） */
      var count = stats ? Math.floor(Number(stats.count) || 0) : 0;
      var list = h('div', { className: 'c-list s-settings-sheet__list' });
      list.appendChild(row({ title: '照片张数', value: count + ' 张', chevron: false }));
      list.appendChild(row({
        title: '占用体积',
        value: fmtBytes(stats ? Number(stats.bytes) || 0 : 0),
        chevron: false
      }));
      list.appendChild(row({
        title: '缩略图体积',
        value: fmtBytes(stats ? Number(stats.thumbBytes) || 0 : 0),
        chevron: false
      }));
      body.appendChild(list);

      var orphans = stats ? Math.floor(Number(stats.orphanCount) || 0) : 0;
      if (orphans > 0) {
        var clean = h('button', {
          className: 's-settings-photos__row',
          type: 'button',
          text: photoOrphanText(stats)
        });
        bindTap(clean, function () { cleanOrphanPhotos(ctx, state.stats, afterChange); });
        body.appendChild(clean);
      }

      var clearAll = h('button', {
        className: 's-settings-photos__row s-settings-photos__row--danger',
        type: 'button',
        text: '清空所有照片…'
      });
      if (count <= 0) {
        clearAll.setAttribute('disabled', 'disabled');
        clearAll.setAttribute('aria-disabled', 'true');
      } else {
        bindTap(clearAll, function () { openPurgeAllSheet(ctx, state.stats, afterChange); });
      }
      body.appendChild(clearAll);

      body.appendChild(t('p', 's-settings-photos__foot', '备份文件包含照片；导入时会按需还原。'));
      body.appendChild(t('p', 's-settings-photos__foot',
        'iPhone 会在连续 7 天没打开过本应用时清理本地数据。导出备份可随时恢复。'));

      var store = storeApi();
      if (store && typeof store.isMemory === 'function' && store.isMemory()) {
        /* 临时存储模式下丢的不只是流水，照片也一样 ⇒ 必须说出来，不能静默丢图 */
        body.appendChild(noteBlock(MESSAGES.E_STORAGE_FALLBACK + '照片同样不会保留。', 's-settings-note--danger'));
      }
    }

    function load() {
      if (!photoStatsReady()) {
        state.loading = false;
        state.failed = true;
        render();
        return;
      }
      state.loading = true;
      render();
      photoStatsOf().then(function (stats) {
        state.loading = false;
        state.failed = !stats;
        state.stats = stats;
        render();
      });
    }

    function afterChange() {
      refreshPhotoRow();
      load();
    }

    XZB.ui.sheet.open({
      title: '照片',
      content: body,
      className: 's-settings-photos',
      actions: [{ label: '关闭', kind: 'text' }]
    });
    load();
  }

  /* ---------------- 数据分组 ---------------- */

  function sectionData(ctx, db) {
    var migrate = migrateApi();
    var settings = settingsOf(db);
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

    var photosRow = row({
      icon: 'photo',
      title: '照片',
      value: '…',
      onClick: function () { openPhotosSheet(ctx); }
    });
    fillPhotosValue(ctx, photosRow);

    var rows = [
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
      snapRow,
      /* 2.26.0：自动快照从「自动化」并入数据与备份，紧挨快照记录。 */
      switchRow(ctx, {
        icon: 'clock',
        title: '自动快照',
        sub: '滚动保留最近 30 份',
        checked: settings.snapshotAuto !== false,
        onChange: function (next) {
          return commitSetting(ctx, 'snapshotAuto', next, next ? '开启自动快照' : '关闭自动快照');
        }
      }),
      photosRow,
      row({
        icon: 'import',
        title: '从旧版迁移',
        value: hasV1 ? '检测到旧数据' : null,
        onClick: function () { openMigrateSheet(ctx); }
      })
    ];

    return group('数据与备份', rows, '导出、快照都只在本机完成，不经过服务器。');
  }

  /* 危险区独立分组（M12 / D-04）：清空需手输确认；不进胶囊。
     2.26.0：归档/新建入口统一由「账本管理」（#/books）承担，这里只保留清空一行。 */
  function sectionDanger(ctx, db) {
    var wrap = h('section', { className: 's-settings-group s-settings-group--danger' });
    var head = h('div', { className: 's-settings-group__head' });
    head.appendChild(t('h2', 's-settings-group__title', '危险区'));
    wrap.appendChild(head);

    var list = h('div', { className: 'c-list s-settings-list s-settings-list--danger' });
    list.appendChild(row({
      icon: 'trash',
      title: '清空全部账单',
      sub: '删除这台设备上的全部账本与流水，执行前自动快照',
      className: 's-settings-row--danger',
      chevron: false,
      onClick: function () { openClearSheet(ctx); }
    }));
    wrap.appendChild(list);
    wrap.appendChild(t('p', 's-settings-group__note', '清空前会自动生成一份快照，可在「快照记录」里恢复。'));
    return wrap;
  }

  /* 2.26.0：归档 / 新建入口统一由「账本管理」（#/books）承担；此浮层保留，暂不挂到设置页。 */
  function openFreshStartSheet(ctx, db) {
    var sheet = XZB.ui && XZB.ui.sheet;
    var schema = schemaApi();
    if (!sheet || typeof sheet.confirm !== 'function' || !schema || typeof schema.createBook !== 'function') {
      toast(ctx, '暂时无法新建账本，请稍后重试', { type: 'danger' });
      return;
    }
    var current = currentBookSnapshot(ctx, db);
    if (!current) {
      toast(ctx, '还没有可归档的账本', { type: 'warning' });
      return;
    }
    var counts = countsOf(db);
    sheet.confirm({
      title: '归档当前账本并新建',
      message: '「' + String(current.name || '当前账本') + '」的 ' + counts.transactions + ' 笔流水会全部保留，随时可以切回；新账本从空开始。这不会删除任何数据。',
      confirmLabel: '归档并新建',
      kind: 'primary',
      onConfirm: function (close) {
        if (live.busy) { return; }
        live.busy = true;
        var now = nowIso();
        var nextName = nextBookName(db);
        var book = null;
        try {
          book = schema.createBook({ name: nextName, sort: 10 }, now);
        } catch (error) {
          book = null;
        }
        if (!book) {
          live.busy = false;
          toast(ctx, '新建账本失败，请稍后重试', { type: 'danger' });
          return;
        }
        var result = null;
        try {
          result = ctx.commit(function (draft) {
            var books = draft.books || [];
            for (var i = 0; i < books.length; i += 1) {
              if (books[i] && books[i].id === current.id) {
                books[i].archived = true;
                books[i].updatedAt = now;
              }
            }
            books.push(book);
            return { value: { bookId: book.id, bookName: book.name } };
          }, { label: '归档账本并新建' });
        } catch (error) {
          result = null;
        }
        Promise.resolve(result).then(function (res) {
          live.busy = false;
          if (!res || !res.ok) {
            toast(ctx, messageOf(res), { type: 'danger' });
            return;
          }
          var value = res.value || {};
          var prefs = ctx && ctx.prefs;
          if (value.bookId && prefs && typeof prefs.set === 'function') {
            prefs.set('activeBookId', value.bookId);
          }
          close();
          refreshData(ctx).then(function () {
            toast(ctx, '已归档「' + String(current.name || '原账本') + '」并新建「' + (value.bookName || nextName) + '」', { type: 'success' });
            go(ctx, '#/books');
          });
        }, function () {
          live.busy = false;
          toast(ctx, MESSAGES.E_COMMIT, { type: 'danger' });
        });
      }
    });
  }

  /* 当前账本：ui.activeBookId → settings.activeBookId → 第一本未归档的 */
  function currentBookSnapshot(ctx, db) {
    var books = listOf(db, 'books');
    var want = '';
    var ui = ctx && ctx.state && ctx.state.ui;
    if (ui && ui.activeBookId) { want = String(ui.activeBookId); }
    if (!want) {
      var prefs = ctx && ctx.prefs;
      if (prefs && typeof prefs.get === 'function') {
        var stored = prefs.get('activeBookId', '');
        if (stored) { want = String(stored); }
      }
    }
    var i;
    if (want) {
      for (i = 0; i < books.length; i += 1) {
        if (books[i] && String(books[i].id) === want && books[i].deleted !== true) { return books[i]; }
      }
    }
    for (i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].deleted !== true && books[i].archived !== true) { return books[i]; }
    }
    return null;
  }

  /* 新账本名：先试「新账本」，重名就追加序号（不覆盖、不静默改名） */
  function nextBookName(db) {
    var books = listOf(db, 'books');
    var base = '新账本';
    var taken = {};
    for (var i = 0; i < books.length; i += 1) {
      if (books[i] && books[i].deleted !== true) { taken[String(books[i].name || '')] = true; }
    }
    if (!taken[base]) { return base; }
    for (var n = 2; n < 100; n += 1) {
      if (!taken[base + ' ' + n]) { return base + ' ' + n; }
    }
    return base;
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
    page.appendChild(noteBlock('每天首次打开时生成自动快照，导入、恢复、清空前也会先存一份。最多保留 30 份：自动 12 份、手动 8 份、导入/恢复前 10 份；超出后先删最旧的自动快照。', 's-settings-page__lead'));

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

  function toneIndexOf(color, category) {
    var kitApi = XZB.ui && XZB.ui.kit ? XZB.ui.kit : null;
    if (kitApi && typeof kitApi.categoryTone === 'function' && category) {
      return kitApi.categoryTone(category);
    }
    if (kitApi && typeof kitApi.nearestTone === 'function') {
      var slot = kitApi.nearestTone(color);
      if (slot) { return slot; }
    }
    var target = parseHex(color);
    if (!target) { return 0; }
    var best = 0;
    var bestDistance = Infinity;
    for (var i = 1; i <= TONE_COUNT; i += 1) {
      var slot2 = parseHex(cssVar('--cat-' + i));
      if (!slot2) { continue; }
      if (slot2.r === target.r && slot2.g === target.g && slot2.b === target.b) { return i; }
      var dr = slot2.r - target.r;
      var dg = slot2.g - target.g;
      var db = slot2.b - target.b;
      var distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  }

  function toneClass(tone) {
    return tone > 0 ? 's-settings-tone-' + tone : 's-settings-tone-none';
  }

  /* 图标选择器的「最近使用」：与记账页共用同一个偏好键，两边看到的是同一份记录 */
  function recentIconsOf(ctx) {
    var raw = prefsGet(ctx, 'recentCategoryIcons', []);
    return Array.isArray(raw) ? raw.map(function (key) { return String(key); }).slice(0, 12) : [];
  }

  function pushRecentIcon(ctx, key) {
    var list = recentIconsOf(ctx).filter(function (item) { return item !== String(key); });
    list.unshift(String(key));
    prefsSet(ctx, 'recentCategoryIcons', list.slice(0, 12));
  }

  function favoriteIdsOf(ctx) {    var raw = prefsGet(ctx, 'favoriteCategoryIds', []);
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
          className: 'c-segmented__item' + (kind === item.value ? ' is-active' : ''),
          type: 'button',
          text: item.label,
          aria: { pressed: kind === item.value ? 'true' : 'false' }
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
    var tone = toneIndexOf(cat.color, cat);
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
    var initialTone = existing ? toneIndexOf(existing.color, existing) : (kind === 'income' ? 10 : 1);
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

    var isSystem = !!(existing && existing.system === true);
    body.appendChild(t('p', 's-settings-sheet__label', '图标'));
    if (isSystem) {
      /* 系统分类：只在系统那套双色图标里换，别让它挂上"火锅""猫爪"这种专属造型 */
      body.appendChild(t('p', 's-settings-sheet__hint',
        '系统分类用系统这套图标，这样它和记账宫格、首页流水里的样子一致。'));
      var iconGrid = h('div', { className: 's-settings-icon-grid', role: 'group', aria: { label: '分类图标' } });
      var iconButtons = [];
      var choices = CAT_ICON_CHOICES();
      for (var i = 0; i < choices.length; i += 1) {
        (function (name) {
          var btn = h('button', {
            className: 's-settings-icon-btn' + (model.icon === name ? ' is-active' : ''),
            type: 'button',
            aria: { label: iconLabelOf(name), pressed: model.icon === name ? 'true' : 'false' }
          });
          btn.appendChild(iconEl(name, 22));
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
        }(choices[i]));
      }
      body.appendChild(iconGrid);
    } else {
      /* 自定义分类 / 新增：专属图标库（搜索 + 分组 + 最近使用），与记账面板同一个组件 */
      body.appendChild(t('p', 's-settings-sheet__hint',
        '这 96 枚是给自定义分类留的专属图标，系统分类里不会出现，所以不会跟系统图标撞脸。'));
      var pickerHost = h('div', { className: 's-settings-picker' });
      body.appendChild(pickerHost);
      var pickerApi = XZB.ui && XZB.ui.iconPicker;
      if (pickerApi && typeof pickerApi.mount === 'function') {
        pickerApi.mount(pickerHost, {
          value: model.icon,
          kind: kind === 'income' ? 'income' : 'expense',
          recents: recentIconsOf(ctx),
          onPick: function (key) { model.icon = key; },
          onRecent: function (key) { pushRecentIcon(ctx, key); }
        });
      }
    }

    body.appendChild(t('p', 's-settings-sheet__label', '颜色'));
    var swatches = h('div', { className: 's-settings-swatches', role: 'group', aria: { label: '分类颜色' } });
    var swatchButtons = [];
    /* 色槽数量与顺序只由 CAT_COLOR_CHOICES()（--cat-raw-N）决定，本文件不写死 12 */
    var toneSlots = CAT_COLOR_CHOICES();
    for (var c = 1; c <= toneSlots.length; c += 1) {
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
      : (cssVar(CAT_RAW_TOKENS[model.tone - 1]) || cssVar('--cat-' + model.tone));
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
    var info = storageInfo();
    var settings = settingsOf(db);
    /* 版本号唯一来源是 app.js 的 XZB.version；db.appVersion 只在旧库里兜底 */
    var version = appVersion() || (db && db.appVersion) || '';

    var page = h('div', { className: 's-settings-page' });

    var hero = h('section', { className: 'c-card s-settings-about__hero' });
    var heroBody = h('div', { className: 'c-card__body' });
    var mark = h('div', { className: 's-settings-about__mark' });
    mark.appendChild(iconEl('book-ledger', 24, 's-settings-glyph'));
    heroBody.appendChild(mark);
    heroBody.appendChild(t('h2', 's-settings-about__title', '小账本'));
    heroBody.appendChild(t('p', 's-settings-about__version',
      version ? '版本 ' + version + ' · 本地优先' : '本地优先'));
    heroBody.appendChild(t('p', 's-settings-about__p', 'iPhone 上的轻量记账。没有账号，没有服务器，打开就能记。'));
    hero.appendChild(heroBody);
    page.appendChild(hero);

    var privacy = h('section', { className: 'c-card s-settings-about__privacy' });
    var privacyBody = h('div', { className: 'c-card__body' });
    privacyBody.appendChild(t('h2', 'c-card__title', '隐私'));
    privacyBody.appendChild(t('p', 's-settings-about__p s-settings-about__p--strong',
      '账目默认只存在这台设备上，无账号、无服务器；开启在线模型后只把当轮原话与账户名称发给你配置的模型服务。'));
    var guarantees = h('ul', { className: 's-settings-about__list' });
    var items = [
      '不主动上传任何账目；仅在开启在线模型时发送当轮原话',
      '导出 JSON 就是完整备份，可在新设备还原',
      '卸载应用或清除网站数据会一并删除',
      '快照也只保存在本机，最多 30 份'
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

    /* 2.26.0：数据统计上移到「我的」总览卡；存储状态也在总览卡；安全两行在「安全」组。
       关于页只保留介绍、隐私说明与版本信息，不再重复安装入口。 */
    var foot = h('div', { className: 's-settings-foot' });
    foot.appendChild(t('p', 's-settings-foot__line', '小账本 2.0 · 本地优先 · 无账号 · 无服务器'));
    foot.appendChild(t('p', 's-settings-foot__line s-settings-foot__line--quiet',
      '数据版本 v' + (info.schemaVersion || (db && db.schemaVersion) || 2) +
      ' · 预算提醒阈值 ' + (settings.budgetAlertPct || 80) + '% · 快照最多 30 份'));
    page.appendChild(foot);

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
        title: '隐私与存储',
        value: '仅本机',
        onClick: function () { go(ctx, '#/settings/about'); }
      }),
      row({
        icon: 'info',
        title: '版本',
        value: appVersion() || '—',
        chevron: false,
        className: 's-settings-version'
      })
    ];
    /* R-11 / D-05：原句在「可选联网」后为假，已改为如实口径（与 renderAbout 隐私卡同源）。 */
    return group('支持与关于', rows, '账目默认只存在这台设备上，无账号、无服务器；开启在线模型后只把当轮原话与账户名称发给你配置的模型服务。');
  }

  /* ---------------- 索引胶囊（SPEC P2-1 / DESIGN §4.2） ---------------- */

  /* A–F 六项（2.26.0 收拢：自动化并入记账/数据，安全上移主屏）；危险区 H 按 IA-4 视觉隔离，不进胶囊。 */
  var TOC_GROUPS = [
    ['manage', '记账'], ['data', '数据'], ['security', '安全'],
    ['assistant', '助手'], ['appearance', '显示'], ['about', '关于']
  ];

  function tocTarget(key) {
    var doc = global.document;
    return doc && typeof doc.getElementById === 'function' ? doc.getElementById('settings-group-' + key) : null;
  }

  function tocActive(nav, key) {
    if (nav.getAttribute('data-active') === key) { return; }
    nav.setAttribute('data-active', key);
    var items = nav.querySelectorAll('.s-settings-toc__item');
    var active = null;
    for (var i = 0; i < items.length; i += 1) {
      var on = items[i].getAttribute('data-group') === key;
      items[i].classList.toggle('is-active', on);
      items[i].setAttribute('aria-current', on ? 'true' : 'false');
      if (on) { active = items[i]; }
    }
    revealTocItem(nav, active);
  }

  /* 高亮换人时把胶囊横向滚进可视区：只动胶囊条自身的 scrollLeft，不碰页面滚动。 */
  function revealTocItem(nav, item) {
    if (!item || typeof nav.getBoundingClientRect !== 'function') { return; }
    if (!nav.clientWidth || !item.offsetWidth) { return; }
    var nr = nav.getBoundingClientRect();
    var ir = item.getBoundingClientRect();
    var left = nav.scrollLeft + (ir.left - nr.left) - (nr.width - ir.width) / 2;
    if (left < 0) { left = 0; }
    var reduce = false;
    try {
      reduce = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) { reduce = false; }
    try { nav.scrollTo({ left: left, behavior: reduce ? 'auto' : 'smooth' }); }
    catch (error) { nav.scrollLeft = left; }
  }

  /* 滚动容器是路由挂载的 SECTION.app-screen，不是 window、不是 #app。 */
  function tocHost(node) {
    var cur = node ? node.parentNode : null;
    while (cur && cur.nodeType === 1) {
      if (cur.classList && cur.classList.contains('app-screen')) { return cur; }
      cur = cur.parentNode;
    }
    return null;
  }

  /* 落点让给 CSS 的 scroll-margin-top（顶栏 + 胶囊高度）；失败才退回容器 scrollTop。 */
  function tocGoTo(nav, key) {
    var target = tocTarget(key);
    if (!target) { return; }
    tocActive(nav, key);
    if (typeof target.scrollIntoView === 'function') {
      try { target.scrollIntoView({ block: 'start' }); return; } catch (error) { /* 走兜底 */ }
    }
    var host = tocHost(nav);
    if (host) { host.scrollTop = target.offsetTop; }
  }

  function buildToc(ctx) {
    var nav = h('nav', { className: 's-settings-toc', role: 'navigation', aria: { label: '分组索引' } });
    function add(key, label, first) {
      var item = h('button', {
        className: 's-settings-toc__item' + (first ? ' is-active' : ''),
        type: 'button', text: label, dataset: { group: key },
        aria: { current: first ? 'true' : 'false' }
      });
      item.addEventListener('click', function () { buzz(ctx); tocGoTo(nav, key); });
      nav.appendChild(item);
    }
    for (var i = 0; i < TOC_GROUPS.length; i += 1) { add(TOC_GROUPS[i][0], TOC_GROUPS[i][1], i === 0); }
    var shell = h('div', { className: 's-settings-toc-shell' });
    shell.appendChild(nav);
    return shell;
  }

  /* 高亮只在滚动容器上算（120ms 合帧），不监听 window。 */
  function bindTocScroll(nav, root) {
    var host = tocHost(root);
    if (!host || typeof host.addEventListener !== 'function') { return; }
    var ticking = false;
    function sync() {
      ticking = false;
      if (!alive(nav)) { return; }
      /* 2.26.1：线随视口比例走（固定 120px 在长卡片下会让高亮落后一整组）；
         滚到底时强制收到最后一组，否则「关于」永远点不亮（页面已滚不动仍停在上一条）。 */
      var best = TOC_GROUPS[0][0];
      var atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 4;
      if (atBottom) {
        best = TOC_GROUPS[TOC_GROUPS.length - 1][0];
      } else {
        var line = host.scrollTop + Math.round(host.clientHeight * 0.35);
        for (var i = 0; i < TOC_GROUPS.length; i += 1) {
          var node = tocTarget(TOC_GROUPS[i][0]);
          if (node && node.offsetTop <= line) { best = TOC_GROUPS[i][0]; }
        }
      }
      tocActive(nav, best);
    }
    host.addEventListener('scroll', function () {
      if (ticking) { return; }
      ticking = true;
      if (typeof global.setTimeout === 'function') { global.setTimeout(sync, 120); }
    }, { passive: true });
  }

  /* ---------------- C 组子页 #/settings/ai：在线模型 ---------------- */

  var AI_ERR_TEXT = {
    E_AS_NOT_CONFIGURED: '地址、模型、密钥要填齐', E_AS_NOT_ACKED: '已配置：先同意隐私告知，再测试连接',
    E_AS_NET_CONFIG: '配置不合法，检查地址与模型名',
    E_AS_NET_TIMEOUT: '连接超时，检查网络或地址', E_AS_NET_BAD: '返回内容看不懂，换一个模型试试',
    E_AS_NET_OFFLINE: '当前没有网络'
  };

  function aiStatusText(result) {
    if (!result) { return '还没测试过'; }
    if (result.ok === true) {
      var ms = Math.floor(Number(result.ms) || 0);
      return ms > 0 ? '连接正常 · ' + ms + ' 毫秒' : '连接正常';
    }
    var code = result.code ? String(result.code) : '';
    return AI_ERR_TEXT[code] || '测试没通过，检查配置后再试';
  }

  /* 配置读写一律经 XZB.core.assistant.llm；先惰性 ensure('core-assistant') 再取 API。 */
  function renderAiSettings(root, ctx) {
    deferTitle(ctx, '在线模型');
    var page = h('div', { className: 's-settings-page' });
    var note = h('p', { className: 's-settings-note', text: '正在加载联网配置…' });
    page.appendChild(note);
    root.appendChild(page);
    function fail() {
      if (alive(note)) { note.textContent = '联网模块没加载起来，稍后重新进入本页再试。'; }
    }
    ensureAssistantCore().then(function (ready) {
      if (!alive(page)) { return; }
      if (!ready || !llmApi()) { fail(); return; }
      if (note.parentNode) { note.parentNode.removeChild(note); }
      page.appendChild(buildAiForm(ctx));
    }, fail);
  }

  function buildAiForm(ctx) {
    var cfg = llmCfg() || {};
    var wrap = h('section', { className: 's-settings-group' });
    var head = h('div', { className: 's-settings-group__head' });
    head.appendChild(t('h2', 's-settings-group__title', '接口与密钥'));
    wrap.appendChild(head);

    var status = h('p', { className: 's-settings-note', text: '还没测试过', aria: { live: 'polite' } });
    var inputs = {};
    var fields = h('div', { className: 's-settings-sheet' });
    var SPEC = [
      /* 2.26.9：占位符对齐 aiNormalizeURL 的协议要求（必须 http(s):// 开头），
         照示范输入不再必然归一化失败。 */
      ['baseURL', 'url', '接口地址', 'https://api.example.com/v1'],
      ['model', 'text', '模型名', '如 gpt-4o-mini'],
      ['key', 'password', '密钥', '粘到这里，只存这台手机']
    ];
    for (var i = 0; i < SPEC.length; i += 1) {
      (function (name, inputType, label, placeholder) {
        var field = h('div', { className: 's-settings-sheet__field' });
        field.appendChild(t('span', 's-settings-sheet__label', label));
        var input = h('input', {
          className: 's-settings-sheet__input', type: inputType, placeholder: placeholder,
          autocomplete: 'off', spellcheck: 'false', aria: { label: label }
        });
        if (name !== 'key') { input.value = cfg[name] || ''; }
        input.addEventListener('change', function () { apply(); });
        inputs[name] = input;
        field.appendChild(input);
        fields.appendChild(field);
      }(SPEC[i][0], SPEC[i][1], SPEC[i][2], SPEC[i][3]));
    }
    wrap.appendChild(fields);

    /* getConfig 只回掩码 ••••尾4：用户不回改就不覆盖真 key。 */
    function markKey() {
      var saved = llmCfg() || {};
      inputs.key.value = '';
      inputs.key.placeholder = saved.hasKey === true
        ? '已保存 ' + (saved.keyMasked || '••••')
        : '粘到这里，只存这台手机';
    }
    markKey();

    function apply() {
      var api = llmApi();
      if (!api || typeof api.setConfig !== 'function') { return false; }
      var patch = { baseURL: String(inputs.baseURL.value || ''), model: String(inputs.model.value || '') };
      var typed = String(inputs.key.value || '');
      if (typed && typed.indexOf('••••') !== 0) { patch.key = typed; }
      var res = null;
      try { res = api.setConfig(patch); } catch (error) { res = null; }
      if (!res || res.ok !== true) {
        /* 缺协议是最常见的失败因（2.26.9）：直接点明原因，其余失败保持原提示。 */
        var addr = String(inputs.baseURL.value || '').trim();
        status.textContent = addr && addr.indexOf('://') === -1
          ? '没保存：接口地址需以 http:// 或 https:// 开头'
          : '没保存：检查接口地址与模型名';
        return false;
      }
      markKey();
      status.textContent = '已保存';
      return true;
    }

    /* 开启在线模型的前提：三样都齐（已保存过密钥也算），否则明确提示并聚焦第一个缺口。 */
    function configComplete(map) {
      var saved = llmCfg() || {};
      var typed = String(map.key.value || '');
      var hasKey = saved.hasKey === true || (typed !== '' && typed.indexOf('••••') !== 0);
      return String(map.baseURL.value || '').trim() !== ''
        && String(map.model.value || '').trim() !== ''
        && hasKey;
    }

    function focusFirstMissing(map) {
      var saved = llmCfg() || {};
      var typed = String(map.key.value || '');
      var missing = String(map.baseURL.value || '').trim() === '' ? 'baseURL'
        : (String(map.model.value || '').trim() === '' ? 'model'
          : ((saved.hasKey === true || (typed !== '' && typed.indexOf('••••') !== 0)) ? '' : 'key'));
      if (missing && map[missing] && typeof map[missing].focus === 'function') { map[missing].focus(); }
    }

    var list = h('div', { className: 'c-list s-settings-list' });
    list.appendChild(switchRow(ctx, {
      icon: 'cloud', title: '开启在线模型', sub: '关闭时小助手只在本机解析',
      checked: cfg.enabled === true,
      onChange: function (next) {
        var api = llmApi();
        if (!api || typeof api.setConfig !== 'function') { return false; }
        if (next === true && !configComplete(inputs)) {
          status.textContent = '先把接口地址、模型名和密钥填齐，再开启';
          focusFirstMissing(inputs);
          return false;
        }
        var res = null;
        try { res = api.setConfig({ enabled: next }); } catch (error) { res = null; }
        if (!res || res.ok !== true) { toast(ctx, '保存失败，请重试', { type: 'danger' }); return false; }
        status.textContent = next ? '已开启：会把当轮原话发给你配置的模型服务' : '已关闭：全部在本机解析';
        return true;
      }
    }));
    /* 2.26.9 修复：noticeAt（隐私告知时间戳）此前只能在小助手/AI 解读页的弹卡里
       写入，设置页没有任何入口——用户在本文填齐三项后「测试连接」会被
       core-assistant 的出站前置门（A28，noticeAt=0 不发请求）拦下，且错误文案
       误报成「地址、模型、密钥要填齐」。这里补一个与弹卡同语义的告知开关，
       同意即写 noticeAt，与 assistant.js acceptNotice / insights.js 的口径一致。 */
    list.appendChild(switchRow(ctx, {
      icon: 'shield', title: '同意隐私告知',
      sub: '知悉并同意：开启后，当轮原话与账户名称会发送给你配置的模型服务；密钥只存在本机',
      checked: Number(cfg.noticeAt) > 0,
      onChange: function (next) {
        var api = llmApi();
        if (!api || typeof api.setConfig !== 'function') { return false; }
        var res = null;
        try { res = api.setConfig({ noticeAt: next ? Date.now() : 0 }); } catch (error) { res = null; }
        if (!res || res.ok !== true) { toast(ctx, '保存失败，请重试', { type: 'danger' }); return false; }
        status.textContent = next
          ? '已同意：可以测试连接；小助手联网不再重复询问'
          : '已撤回：联网功能停用，可随时再次同意';
        return true;
      }
    }));
    list.appendChild(switchRow(ctx, {
      icon: 'eye', title: '显示密钥', sub: '只在本次打开时明文显示', checked: false,
      onChange: function (next) { inputs.key.type = next ? 'text' : 'password'; return true; }
    }));
    wrap.appendChild(list);

    var actions = h('div', { className: 's-settings-actions' });
    var saveBtn = h('button', { className: 'c-btn c-btn--primary', type: 'button', text: '保存配置' });
    saveBtn.addEventListener('click', function () { apply(); });
    var testBtn = h('button', { className: 'c-btn c-btn--secondary', type: 'button', text: '测试连接' });
    var busy = false;
    testBtn.addEventListener('click', function () {
      if (busy) { return; }
      var api = llmApi();
      if (!api || typeof api.test !== 'function' || !apply()) {
        status.textContent = '地址、模型、密钥要填齐';
        return;
      }
      /* A28：测试连接是出站请求，未同意隐私告知（noticeAt=0）不发。
         提前说明真实缺口，不再沿用「要填齐」的误导文案（2.26.9 修复）。 */
      if (Number((llmCfg() || {}).noticeAt) <= 0) {
        status.textContent = '三项已填齐。先在上方同意隐私告知，再测试连接';
        return;
      }
      busy = true;
      testBtn.setAttribute('disabled', 'disabled');
      saveBtn.setAttribute('disabled', 'disabled');
      testBtn.textContent = '正在测试…';
      status.textContent = '正在测试连接…';
      var pending = null;
      try { pending = api.test(); } catch (error) { pending = null; }
      function done() {
        busy = false;
        testBtn.removeAttribute('disabled');
        saveBtn.removeAttribute('disabled');
        testBtn.textContent = '测试连接';
      }
      Promise.resolve(pending).then(function (res) {
        done();
        if (alive(status)) { status.textContent = aiStatusText(res); }
      }, function () {
        done();
        if (alive(status)) { status.textContent = '测试失败，请重试'; }
      });
    });
    actions.appendChild(saveBtn);
    actions.appendChild(testBtn);
    wrap.appendChild(actions);
    wrap.appendChild(status);

    /* R-11 / D-05：只写事实，不暗示加密或绝对安全。 */
    wrap.appendChild(h('p', {
      className: 's-settings-group__note',
      text: '密钥只存在本机；只有开启在线模型时，才会把当轮原话与账户名称发给你的模型服务。'
    }));
    return wrap;
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
    if (ctx.sub === 'ai') {
      renderAiSettings(root, ctx);
      return;
    }

    /* A32：空库首启一次性横幅（置位后不再出现；样式沿用既有 c-* / s-settings-note） */
    firstRunBannerMaybe(root, ctx, db);

    /* 2.26.0：总览卡在首启横幅之后、吸顶索引之前，首屏先交代数据规模与存储方式。 */
    root.appendChild(sectionOverview(ctx, db));

    /* SPEC P2-1 / DESIGN §4.2：吸顶索引胶囊（A–F），危险区 H 不进胶囊。 */
    var toc = buildToc(ctx);
    root.appendChild(toc);

    /* A→F 六段（2.26.0 重排）：高频记账管理前置，AI 与自动化技术配置退出主屏。 */
    var sections = [
      ['manage', sectionManage(ctx, db)],
      ['data', sectionData(ctx, db)],
      ['security', sectionSecurity(ctx, db)],
      ['assistant', sectionAssistant(ctx)],
      ['appearance', sectionAppearance(ctx)],
      ['about', sectionAbout(ctx, db)]
    ];
    for (var i = 0; i < sections.length; i += 1) {
      sections[i][1].id = 'settings-group-' + sections[i][0];
      root.appendChild(sections[i][1]);
    }
    root.appendChild(sectionDanger(ctx, db));
    bindTocScroll(toc, root);
  }

  /* ---------------- 注册 ---------------- */

  XZB.screens.register(KEY, {
    title: '我的',
    subtitle: '偏好与数据',
    render: render,
    /* 纯函数测试缝（无 DOM / 无 IO），tools/_t21_selfcheck.cjs 经 screen.photosTestKit 取用。 */
    photosTestKit: {
      photoCountText: photoCountText,
      photoOrphanText: photoOrphanText,
      photoHintText: photoHintText,
      importLimitBytes: importLimitBytes,
      importTooLargeText: importTooLargeText,
      exportWarnBytes: exportWarnBytes,
      photoExportSummary: photoExportSummary,
      photoRestoredText: photoRestoredText,
      photoMissingCount: photoMissingCount,
      photoSectionCount: photoSectionCount,
      photoSectionBytes: photoSectionBytes,
      storageProtectText: storageProtectText,
      storagePersistedFlag: storagePersistedFlag,
      firstRunBannerStep: firstRunBannerStep,
      firstRunBannerLines: function () { return FIRST_RUN_BANNER_LINES.slice(); }
    }
  });

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('focus', onWindowFocusForImport);
  }
}(window));
