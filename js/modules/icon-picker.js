/* 小账本 2.0 · js/ui/icon-picker.js · 分类图标选择器（2.6 新增）
 * ------------------------------------------------------------------
 * 自定义分类的图标从 40 个膨胀到 96 个（8 组 × 12 枚）之后，不能再一整片堆在
 * 面板里。这里做成一个可复用组件：搜索 + 分组横向标签 + 最近使用 + 当前图标，
 * 手机端 6 列，只渲染当前分组。
 *
 * 公开：XZB.ui.iconPicker
 *   mount(container, options) -> controller { value(), setValue(), destroy() }
 *
 * options：
 *   value     当前选中的 icon key（旧图标也能原样保留）
 *   kind      'expense' | 'income'，只影响「推荐」这一栏的排序，不限制选择范围
 *   recents   最近使用的 key 数组（调用方负责持久化）
 *   onPick    function(key, label) —— 选中即回调，由调用方同步 model
 *   onRecent  function(key) —— 想把「最近使用」落盘的调用方在这里收
 *   columns   列数，默认 6
 *
 * 约束：全部本地内联 SVG，无 Emoji、无图标 CDN、无网络请求。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  var doc = global.document;

  function iconsApi() {
    var group = XZB.ui || XZB.UI || null;
    return group ? group.icons : null;
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function clear(node) {
    if (!node) { return node; }
    while (node.firstChild) { node.removeChild(node.firstChild); }
    return node;
  }

  /* 推荐位：新建支出更常落到吃 / 行 / 家，收入更常落到财务与个性。
   * 只是排序建议，用户随时可以切到别的分组。 */
  var RECOMMEND = {
    expense: [
      'hotpot', 'latte', 'milktea', 'burger', 'noodles', 'sushi', 'cake', 'juice',
      'taxi', 'subway', 'bike', 'gas', 'parking',
      'key', 'lamp', 'fridge', 'detergent', 'bin',
      'clapper', 'dslr', 'music', 'football', 'tent',
      'cat', 'dog', 'bottle', 'school', 'birthday', 'spark', 'love'
    ],
    income: [
      'passbook', 'stock', 'fund', 'safe', 'cashier', 'invoice', 'refund', 'reimburse',
      'installment', 'exchange', 'tax',
      'tiara', 'gem', 'rocket', 'clover', 'spark', 'love', 'smiley',
      'clapper', 'dslr', 'football', 'cat', 'bike'
    ]
  };

  /* 分组配色：只用于「选择器里的预览」，让 96 枚图标一眼看出是彩色的；
   * 真正落到分类上的颜色，仍然由分类自己的色槽（categoryTone）决定。 */
  var GROUP_TONE = {
    food: 1, travel: 2, home: 4, fun: 5, pet: 8, family: 3, finance: 10, mood: 11
  };

  function mount(container, options) {
    var opt = options || {};
    var icons = iconsApi();
    if (!container || !icons || typeof icons.node !== 'function') {
      return { value: function () { return opt.value || ''; }, setValue: function () {}, destroy: function () {} };
    }

    var state = {
      value: String(opt.value || ''),
      group: 'recommend',
      keyword: '',
      recents: Array.isArray(opt.recents) ? opt.recents.slice(0, 12) : []
    };

    var root = el('div', 'c-icon-picker');
    var searchWrap = el('div', 'c-icon-picker__search');
    var input = el('input', 'c-icon-picker__input');
    input.type = 'search';
    input.placeholder = '搜索图标（拼音或中文）';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', '搜索分类图标');
    searchWrap.appendChild(input);
    root.appendChild(searchWrap);

    var tabs = el('div', 'c-icon-picker__tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '图标分组');
    root.appendChild(tabs);

    var grid = el('div', 'c-icon-picker__grid');
    if (opt.columns) { root.style.setProperty('--s-icon-cols', String(opt.columns)); }
    root.appendChild(grid);

    var hint = el('p', 'c-icon-picker__hint', '');
    root.appendChild(hint);
    container.appendChild(root);

    var groups = icons.groups();

    /* 当前图标不在专属库里（老数据 / 系统图标）时，单独给一个「当前」页，
     * 免得用户点开面板发现自己的图标"丢了"。 */
    function valueInLibrary() {
      if (!state.value) { return true; }
      return icons.customKeys().indexOf(state.value) >= 0;
    }

    function tabDefs() {
      var defs = [{ key: 'recommend', label: '推荐' }];
      if (state.recents.length) { defs.push({ key: 'recent', label: '最近' }); }
      if (!valueInLibrary()) { defs.push({ key: 'current', label: '当前' }); }
      for (var i = 0; i < groups.length; i += 1) {
        defs.push({ key: groups[i].key, label: groups[i].label });
      }
      return defs;
    }

    function keysOfGroup(groupKey) {
      if (groupKey === 'recent') {
        return state.recents.filter(function (key) { return icons.has(key); });
      }
      if (groupKey === 'current') {
        return state.value ? [state.value] : [];
      }
      if (groupKey === 'recommend') {
        var list = RECOMMEND[opt.kind === 'income' ? 'income' : 'expense'] || [];
        var out = [];
        for (var i = 0; i < list.length; i += 1) {
          if (icons.has(list[i])) { out.push(list[i]); }
        }
        return out;
      }
      var found = icons.search('', groupKey);
      return found;
    }

    function paintTabs() {
      clear(tabs);
      var defs = tabDefs();
      /* 当前分组被搜没了就回落到推荐，避免标签全部取消高亮 */
      var exists = false;
      for (var d = 0; d < defs.length; d += 1) {
        if (defs[d].key === state.group) { exists = true; }
      }
      if (!exists) { state.group = 'recommend'; }
      for (var i = 0; i < defs.length; i += 1) {
        (function (def) {
          var tab = el('button', 'c-icon-picker__tab' + (state.group === def.key ? ' is-active' : ''), def.label);
          tab.type = 'button';
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-selected', state.group === def.key ? 'true' : 'false');
          tab.addEventListener('click', function () {
            state.group = def.key;
            state.keyword = '';
            input.value = '';
            paintTabs();
            paintGrid();
          });
          tabs.appendChild(tab);
        }(defs[i]));
      }
    }

    function iconTile(key, size) {
      var tile = el('span', 'c-icon-picker__tile');
      var meta = typeof icons.meta === 'function' ? icons.meta(key) : null;
      var tone = meta && meta.group ? GROUP_TONE[meta.group] : 0;
      if (tone) {
        tile.style.setProperty('--ico-a', 'var(--cat-' + tone + '-accent)');
        tile.style.setProperty('--ico-a-o', '1');
        tile.style.color = 'var(--cat-' + tone + ')';
      }
      var svg = icons.node(key, { size: size || 22 });
      if (svg) { tile.appendChild(svg); }
      return tile;
    }

    function paintGrid() {
      clear(grid);
      var keys = state.keyword
        ? icons.search(state.keyword, null)
        : keysOfGroup(state.group);

      if (!keys.length) {
        grid.appendChild(el('p', 'c-icon-picker__empty',
          state.keyword ? '没有叫「' + state.keyword + '」的图标' : '这个分组还没有图标'));
        hint.textContent = '';
        return;
      }

      for (var i = 0; i < keys.length; i += 1) {
        (function (key) {
          var label = icons.labelOf(key);
          var item = el('button', 'c-icon-picker__item' + (state.value === key ? ' is-active' : ''));
          item.type = 'button';
          item.setAttribute('data-icon', key);
          item.setAttribute('aria-label', label);
          item.setAttribute('aria-pressed', state.value === key ? 'true' : 'false');
          item.appendChild(iconTile(key));
          item.appendChild(el('span', 'c-icon-picker__cap', label));
          item.addEventListener('click', function () { pick(key); });
          grid.appendChild(item);
        }(keys[i]));
      }

      hint.textContent = state.keyword
        ? '找到 ' + keys.length + ' 个图标'
        : (state.group === 'recent' ? '最近用过的 ' + keys.length + ' 个' :
          (state.group === 'recommend' ? '常用推荐，点分组标签还能看更多' : '共 ' + keys.length + ' 个'));
    }

    function pick(key) {
      state.value = key;
      if (state.recents.indexOf(key) >= 0) { state.recents.splice(state.recents.indexOf(key), 1); }
      state.recents.unshift(key);
      if (state.recents.length > 12) { state.recents.length = 12; }
      var items = grid.querySelectorAll('[data-icon]');
      for (var i = 0; i < items.length; i += 1) {
        var active = items[i].getAttribute('data-icon') === key;
        items[i].classList.toggle('is-active', active);
        items[i].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      if (typeof opt.onRecent === 'function') { opt.onRecent(key); }
      if (typeof opt.onPick === 'function') { opt.onPick(key, icons.labelOf(key)); }
    }

    input.addEventListener('input', function () {
      state.keyword = String(input.value || '').trim();
      paintGrid();
    });
    input.addEventListener('search', function () {
      state.keyword = String(input.value || '').trim();
      paintGrid();
    });

    paintTabs();
    paintGrid();

    return {
      value: function () { return state.value; },
      setValue: function (key) {
        state.value = String(key || '');
        paintTabs();
        paintGrid();
      },
      destroy: function () {
        if (root.parentNode) { root.parentNode.removeChild(root); }
      },
      root: root
    };
  }

  UI.iconPicker = { mount: mount, recommend: RECOMMEND };
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.iconPicker) { lower.iconPicker = UI.iconPicker; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UI.iconPicker;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
