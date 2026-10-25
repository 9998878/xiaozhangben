/* 小账本 2.0 · js/ui/icons.js · owner: 前端#1（T04）
 * 内联 SVG 图标集，全部 24×24 viewBox、currentColor、统一线宽。
 * 公开：XZB.ui.icons（镜像 XZB.UI.icons）
 *   icon(name, opts) -> SVG 字符串；node(name, opts) -> SVGElement；
 *   has(name) / names() / count。
 * opts 可传数字（尺寸）或 {size, className, strokeWidth, title, ariaHidden}。
 * 约束：零网络、无外链、无位图；用户数据不进 innerHTML（本文件只拼常量路径）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var UI = XZB.UI || (XZB.UI = {});
  if (UI.icons) {
    if (global.console && global.console.error) {
      global.console.error('XZB.UI.icons 已注册，保留首个实现');
    }
    return;
  }

  var DEFAULT_SIZE = 24;
  var DEFAULT_STROKE = 1.8;
  /* 分类图标单独一档线宽：1.5px 在 20px 尺寸下更接近系统图标的重量，
     UI 图标（导航、动作）仍用 1.8，保证小尺寸下不糊。 */
  var CATEGORY_STROKE = 1.5;
  var CATEGORY_KEYS = {
    food: 1, bag: 1, daily: 1, bus: 1, carrot: 1, fruit: 1, snack: 1, sport: 1,
    fun: 1, phone: 1, shirt: 1, beauty: 1, house: 1, sofa: 1, baby: 1, elder: 1,
    chat: 1, plane: 1, glass: 1, plug: 1, kit: 1, book: 1, cap: 1, pet: 1,
    envelope: 1, gift: 1, briefcase: 1, hammer: 1, heart: 1, ticket: 1,
    family: 1, box: 1, gamepad: 1, wrench: 1, washer: 1,
    car: 1, health: 1, salary: 1, bonus: 1, invest: 1, parttime: 1, redpacket: 1
  };

  /* 全部路径都是本文件常量，不接受外部字符串。 */
  var PATHS = {
    /* ----- 导航 / 标签栏 ----- */
    'home': '<path d="M3.5 10.6 12 3.8l8.5 6.8"/><path d="M5.4 9.3V20h13.2V9.3"/><path d="M9.6 20v-5.4h4.8V20"/>',
    'list': '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".9"/><circle cx="4" cy="12" r=".9"/><circle cx="4" cy="18" r=".9"/>',
    'chart': '<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>',
    'chart-line': '<path d="M3.5 19.5h17"/><path d="m4.5 15 4-4.5 3 2.5 5-6 3 3"/>',
    'pie': '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12V3.5Z"/><path d="M14.5 2.8A8.5 8.5 0 0 1 21.2 9.5h-6.7V2.8Z"/>',
    'settings': '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    'user': '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.6-4 3.3-6.3 7.5-6.3s6.9 2.3 7.5 6.3"/>',

    /* ----- 动作 ----- */
    'plus': '<path d="M12 5v14M5 12h14"/>',
    'camera': '<path d="M4 7.5h3.2L9 5.2h6l1.8 2.3H20a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z"/><circle cx="12" cy="13" r="3.4"/>',
    'trash': '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 13h9.2l.9-13"/><path d="M10 10.5v6M14 10.5v6"/>',
    'back': '<path d="m14.5 5-7 7 7 7"/>',
    'close': '<path d="M6 6l12 12M18 6 6 18"/>',
    'backspace': '<path d="M9 5h10.5A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H9L3 12l6-7Z"/><path d="m11.5 9 5 6M16.5 9l-5 6"/>',
    'search': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
    'filter': '<path d="M3.5 5h17l-6.5 8.1V19l-4 2v-7.9L3.5 5Z"/>',
    'check': '<path d="m4.5 12.5 5 5 10-11"/>',
    'star': '<path d="m12 3.6 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 3.6Z"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m7.5 12.2 3 3 6-6.4"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 8.5 7 7M15.5 8.5l-7 7"/>',
    'info': '<circle cx="12" cy="12" r="9"/><path d="M12 10.8v6M12 7.2h.01"/>',
    'warning': '<path d="M12 3.2 21.5 20H2.5L12 3.2Z"/><path d="M12 9v5M12 17.2h.01"/>',
    'help-circle': '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1-1.3 2.1M12 17h.01"/>',
    'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.4 2"/>',
    'repeat': '<path d="M4 11V9a4 4 0 0 1 4-4h12M17 2.5 20 5l-3 2.5M20 13v2a4 4 0 0 1-4 4H4M7 21.5 4 19l3-2.5"/>',
    'bell': '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M9.7 19a2.5 2.5 0 0 0 4.6 0"/>',
    'sparkles': '<path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4L12 3Z"/><path d="m5 14 .8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14ZM19 12l.7 1.8 1.8.7-1.8.7L19 17l-.7-1.8-1.8-.7 1.8-.7L19 12Z"/>',
    'text-cursor': '<path d="M8 4.5h8M12 4.5v15M8 19.5h8"/>',
    'undo': '<path d="M8 6.5 3.5 11 8 15.5"/><path d="M3.5 11H14a6 6 0 0 1 0 12h-2"/>',
    'edit': '<path d="m4.5 19.5 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10-1.2 4Z"/><path d="m13.8 7.2 3 3"/>',
    'copy': '<rect x="8.5" y="8.5" width="12" height="12" rx="2.2"/><path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"/>',
    'lock': '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/><path d="M12 14v3"/>',
    'cloud-off': '<path d="M4 4l16 16"/><path d="M7.5 7.8A5.5 5.5 0 0 0 6 18h9.5M10.5 5.2A6 6 0 0 1 18 10a3.7 3.7 0 0 1 1.6 6.5"/>',

    /* ----- 账户 ----- */
    'wallet': '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12.5v3"/><rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M15.5 12.3h5v3.2h-5a1.6 1.6 0 0 1 0-3.2Z"/>',
    'card': '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
    'credit': '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 15h3.5"/><path d="M15.5 13.5h3"/>',
    'bank': '<path d="m3 9 9-5 9 5"/><path d="M4.8 9.5v8M9.6 9.5v8M14.4 9.5v8M19.2 9.5v8M2.5 20h19"/>',
    'cash': '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5h.01M18 14.5h.01"/>',
    'wechat': '<path d="M4 5.5h9.5a3 3 0 0 1 3 3v2.5a3 3 0 0 1-3 3H9l-4 2.2V14A3 3 0 0 1 3 11.5V8.5a3 3 0 0 1 1-3Z"/><path d="M14.5 10H18a3 3 0 0 1 3 3v2a3 3 0 0 1-2 2.8V20l-3-2h-1.5a3 3 0 0 1-3-3"/>',
    'alipay': '<path d="M6 8.5h9.5M11 4.5v4"/><path d="M4.5 13.5h15"/><path d="M8 19c4.5 0 8.5-3 10-7"/><path d="M13 12c2.5 3 5 5.5 7 6.5"/>',
    'piggy': '<path d="M4.5 11.5A6.5 6.5 0 0 1 11 5h2.5a5.5 5.5 0 0 1 5.5 5.5V12h1.5v3H18l-1 3h-3l-.5-1.5h-3L10 19H7l-.5-2.2a6.5 6.5 0 0 1-2-5.3Z"/><path d="M8.2 9.3h.01M5.5 10H3"/><path d="M16 5.5 17.5 3"/>',
    'savings': '<path d="M4.5 11.5A6.5 6.5 0 0 1 11 5h2.5a5.5 5.5 0 0 1 5.5 5.5V12h1.5v3H18l-1 3h-3l-.5-1.5h-3L10 19H7l-.5-2.2a6.5 6.5 0 0 1-2-5.3Z"/><path d="M8.2 9.3h.01M5.5 10H3"/>',

    /* ----- 分类（2.2 重绘：参照鲨鱼记账的细线圆头风格，24×24、1.5px、单色） -----
     * 这一组是「同一套笔」画出来的：统一的 1.5 描边、圆头圆角、留 2px 内边距。
     * 原有键名（food/bag/car/house/fun/health/book/phone/gift/ellipsis）保持不变，
     * 只重画字形——老数据里存的 icon 名不用迁移就能换上新图标。
     */
    'food': '<path d="M7.6 3.4v6.2a2.3 2.3 0 0 0 4.6 0V3.4"/><path d="M9.9 11.9v8.7"/><path d="M17.6 3.4c1.7 2.1 2.2 4.3 1.4 6.4-.4 1.1-1.1 1.9-2.2 2.3v8.5"/>',
    'bag': '<path d="M5.7 8h12.6l.9 10.9a1.7 1.7 0 0 1-1.7 1.8H6.5a1.7 1.7 0 0 1-1.7-1.8L5.7 8Z"/><path d="M9.3 8V6.5a2.7 2.7 0 0 1 5.4 0V8"/>',
    'daily': '<rect x="5.8" y="5.2" width="7.6" height="13.6" rx="3.8"/><path d="M13.4 8.6c2.6.2 4.6 1.7 5 3.6.4 1.7-.7 3.2-2.7 3.9"/>',
    'bus': '<rect x="4.2" y="3.8" width="15.6" height="14.4" rx="2.6"/><path d="M4.2 10.2h15.6"/><path d="M7.6 18.2v2.2M16.4 18.2v2.2"/><path d="M7.8 14.2h.01M16.2 14.2h.01"/>',
    'carrot': '<path d="M19.8 4.2c-7.6 0-13.4 4.2-13.4 9.6a5.9 5.9 0 0 0 5.9 5.9c5.4 0 7.5-5.9 7.5-15.5Z"/><path d="M5.6 18.6c3.4-3.6 7.4-6.4 11.8-8.4"/>',
    'fruit': '<path d="M12 8.3c-1.2-1-2.6-1.5-4-1.5-2.6 0-4 2.2-4 4.8 0 3.8 3 7.9 5.2 7.9.9 0 1.6-.4 2.8-.4s1.9.4 2.8.4c2.2 0 5.2-4.1 5.2-7.9 0-2.6-1.4-4.8-4-4.8-1.4 0-2.8.5-4 1.5Z"/><path d="M12 8.3V5.5a2.5 2.5 0 0 1 2.5-2.5"/>',
    'snack': '<path d="M7 12h10l-1 6.6a2 2 0 0 1-2 1.7h-4a2 2 0 0 1-2-1.7L7 12Z"/><path d="M7 12a5 5 0 0 1 10 0"/><circle cx="12" cy="5.4" r="1.1"/>',
    'sport': '<path d="M6.6 9.4v5.2M4.2 10.4v3.2M17.4 9.4v5.2M19.8 10.4v3.2M6.6 12h10.8"/>',
    'fun': '<rect x="9.2" y="3.4" width="5.6" height="10.2" rx="2.8"/><path d="M6.6 11.4a5.4 5.4 0 0 0 10.8 0"/><path d="M12 16.8v3.4M9.2 20.2h5.6"/>',
    'phone': '<path d="M8.3 3.9 10 7.6c.2.5.1 1-.3 1.4l-1 1a10.6 10.6 0 0 0 4.3 4.3l1-1c.4-.4.9-.5 1.4-.3l3.7 1.7c.5.2.8.7.8 1.2v2c0 .9-.8 1.7-1.7 1.6C10.3 19 5 13.7 4.5 5.5c-.1-.9.7-1.6 1.6-1.6h1.4c.4 0 .8.3.8.7Z"/>',
    'shirt': '<path d="m9.1 4.3-4.2 2-1 4.2 3.1.9v8.3h10v-8.3l3.1-.9-1-4.2-4.2-2-1.2 1.5a2.4 2.4 0 0 1-3.4 0L9.1 4.3Z"/>',
    'beauty': '<circle cx="12" cy="8.4" r="4.6"/><path d="M12 13v2.2l3.2 5.2"/><path d="M9.2 6.8a3.2 3.2 0 0 1 2.2-1.4"/>',
    'house': '<path d="M3.6 10.4 12 3.8l8.4 6.6"/><path d="M5.4 9.2v11h13.2v-11"/><path d="M9.6 20.2v-5.4h4.8v5.4"/>',
    'sofa': '<rect x="4" y="11.4" width="16" height="6.4" rx="2"/><path d="M6.8 11.4V8.8a2.2 2.2 0 0 1 2.2-2.2h6a2.2 2.2 0 0 1 2.2 2.2v2.6"/><path d="M8 11.4v6.4M16 11.4v6.4"/><path d="M6.4 17.8v1.6M17.6 17.8v1.6"/>',
    'baby': '<circle cx="12" cy="12" r="8"/><circle cx="9.2" cy="10.4" r=".55"/><circle cx="14.8" cy="10.4" r=".55"/><path d="M9.6 14.2c.8.9 1.6 1.3 2.4 1.3s1.6-.4 2.4-1.3"/><path d="M12 4c1.4 0 2.3.8 2.3 1.9"/>',
    'elder': '<circle cx="12" cy="8.6" r="3.6"/><path d="M5.8 20.4c.6-3.7 2.9-5.7 6.2-5.7s5.6 2 6.2 5.7"/><path d="M8.8 5.6h6.4"/>',
    'chat': '<rect x="3.6" y="6.6" width="16.8" height="8.4" rx="2.8"/><path d="M7.6 15v2.6l2.8-2.6"/><circle cx="8.6" cy="10.8" r=".55"/><circle cx="12" cy="10.8" r=".55"/><circle cx="15.4" cy="10.8" r=".55"/>',
    'plane': '<path d="M10.4 3.7a1.6 1.6 0 0 1 3.2 0v4.9l6.7 4v2l-6.7-2v4.1l2.4 1.8v1.6L12 20l-4 1.1v-1.6l2.4-1.8v-4.1l-6.7 2v-2l6.7-4V3.7Z"/>',
    'glass': '<path d="M7.6 3.6h8.8l-1 6.5a3.4 3.4 0 0 1-6.8 0l-1-6.5Z"/><path d="M12 13.6v6.8M8.4 20.4h7.2"/>',
    'plug': '<rect x="8.2" y="3.6" width="7.6" height="8" rx="2"/><path d="M10.2 3.6V2.1M13.8 3.6V2.1"/><path d="M12 11.6v4.6a3.6 3.6 0 0 0 3.6 3.6h1.6"/>',
    'kit': '<rect x="3.4" y="7.8" width="17.2" height="11.6" rx="2.2"/><path d="M9 7.8V6.2a1.7 1.7 0 0 1 1.7-1.7h2.6A1.7 1.7 0 0 1 15 6.2v1.6"/><path d="M12 11.2v4.8M9.6 13.6h4.8"/>',
    'book': '<path d="M6.6 4.4h10.8a1.6 1.6 0 0 1 1.6 1.6v13.6H8.2a2.6 2.6 0 0 1-2.6-2.6V6a1.6 1.6 0 0 1 1-1.6Z"/><path d="M5.6 16.4h13.4"/><path d="M9.4 4.4v6.8l1.9-1.4 1.9 1.4V4.4"/>',
    'cap': '<path d="m3 9.2 9-4 9 4-9 4-9-4Z"/><path d="M7.2 11v4.1c0 1.6 2.1 2.8 4.8 2.8s4.8-1.2 4.8-2.8V11"/><path d="M21 9.2v5.2"/>',
    'pet': '<path d="m5 9.4 2-3.4 2.6 2h4.8l2.6-2 2 3.4v4.6a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5V9.4Z"/><circle cx="9.6" cy="12.2" r=".55"/><circle cx="14.4" cy="12.2" r=".55"/><path d="M10.8 15.4h2.4"/>',
    'envelope': '<rect x="3.2" y="5.8" width="17.6" height="12.4" rx="2"/><path d="m3.8 7 8.2 5.8L20.2 7"/><path d="M10.4 13.4 12 15l1.6-1.6M12 15v2.2"/>',
    'gift': '<rect x="4" y="9.4" width="16" height="10.6" rx="1.8"/><path d="M3 9.4h18v4H3z"/><path d="M12 9.4V20"/><path d="M12 9.4C10.6 5.9 9 4.5 7.4 4.5a2.4 2.4 0 0 0 0 4.9H12ZM12 9.4c1.4-3.5 3-4.9 4.6-4.9a2.4 2.4 0 0 1 0 4.9H12Z"/>',
    'briefcase': '<rect x="3.4" y="7.4" width="17.2" height="11.8" rx="2"/><path d="M9 7.4V6a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 6v1.4"/><path d="M3.4 12.6h17.2"/>',
    'hammer': '<path d="M8.4 3.6h7.2a1.4 1.4 0 0 1 1.4 1.4v2.6H7V5a1.4 1.4 0 0 1 1.4-1.4Z"/><path d="M12 7.6v12.8"/><path d="M9.8 20.4h4.4"/>',
    'heart': '<path d="M12 20.2s-7.6-4.6-7.6-9.7A4.5 4.5 0 0 1 12 7.2a4.5 4.5 0 0 1 7.6 3.3c0 5.1-7.6 9.7-7.6 9.7Z"/>',
    'ticket': '<path d="M3.4 8.4h17.2v3a2 2 0 0 0 0 4v3H3.4v-3a2 2 0 0 0 0-4v-3Z"/><path d="M14.4 9.4v1.4M14.4 12.2v1.6M14.4 15.4v1.2"/>',
    'family': '<path d="M3.8 11.4 12 4.3l8.2 7.1"/><path d="M6 9.9v10.3h12V9.9"/><circle cx="9.4" cy="13.6" r="1.7"/><circle cx="14.6" cy="13.6" r="1.7"/><path d="M7.4 20.2c0-1.7.9-2.8 2-2.8s2 1.1 2 2.8M12.6 20.2c0-1.7.9-2.8 2-2.8s2 1.1 2 2.8"/>',
    'box': '<path d="m12 3.4 8.2 4.3v8.6L12 20.6 3.8 16.3V7.7L12 3.4Z"/><path d="m3.8 7.7 8.2 4.4 8.2-4.4M12 12.1v8.5"/>',
    'gamepad': '<path d="M8.6 7.8h6.8a4.6 4.6 0 0 1 4.5 5.7l-.6 2.9a2.7 2.7 0 0 1-4.5 1.3l-1.9-1.8h-1.8l-1.9 1.8a2.7 2.7 0 0 1-4.5-1.3l-.6-2.9a4.6 4.6 0 0 1 4.5-5.7Z"/><path d="M8 10.6v2.6M6.7 11.9h2.6"/><path d="M15.4 11h.01M17 12.6h.01"/>',
    'wrench': '<path d="M14.9 4.1a4.7 4.7 0 0 0-5.7 6.1l-5.6 5.6a1.9 1.9 0 0 0 2.7 2.7l5.6-5.6a4.7 4.7 0 0 0 6.1-5.7l-2.7 2.7-2.4-2.4 2-3.4Z"/>',
    'washer': '<rect x="4.2" y="3.4" width="15.6" height="17.2" rx="2.4"/><circle cx="12" cy="13.6" r="4.3"/><path d="M7.7 6.9h.01M11.1 6.9h.01"/>',
    'salary': '<rect x="2.6" y="6" width="18.8" height="12" rx="2"/><path d="M12 9v6M9.6 11.5 12 9l2.4 2.5"/>',
    'bonus': '<circle cx="12" cy="9" r="5.4"/><path d="m8.6 13.4-1.4 7 4.8-2.4 4.8 2.4-1.4-7"/><path d="m12 6.6.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8.8-1.7Z"/>',
    'invest': '<path d="M3.6 19.6h16.8"/><path d="m4.6 15 4-4.5 3 2.5 5-6 3 3"/><path d="M16.6 6.5h3v3"/>',
    'parttime': '<rect x="3.4" y="7.4" width="17.2" height="11.8" rx="2"/><path d="M8.6 7.4V5.8a1.4 1.4 0 0 1 1.4-1.4h4a1.4 1.4 0 0 1 1.4 1.4v1.6M3.4 12.2h17.2"/>',
    'redpacket': '<rect x="4" y="3.4" width="16" height="17.2" rx="2.4"/><path d="M4 3.4c2.7 2.5 5.3 3.8 8 3.8s5.3-1.3 8-3.8"/><circle cx="12" cy="13" r="2.5"/><path d="M12 11.6v2.8"/>',
    /* 仍在用的旧键：种子分类（交通/医疗/其他）与别名（more/tag/target）指到这里 */
    'car': '<path d="M4 14.6 5.8 8.2A2 2 0 0 1 7.7 6.7h8.6a2 2 0 0 1 1.9 1.5L20 14.6"/><rect x="3.5" y="13.6" width="17" height="5.6" rx="1.7"/><path d="M6.6 19.2v1.5M17.4 19.2v1.5"/><path d="M6.6 16.4h.01M17.4 16.4h.01"/>',
    'health': '<path d="M12 20.2s-7.6-4.6-7.6-9.7A4.5 4.5 0 0 1 12 7.2a4.5 4.5 0 0 1 7.6 3.3c0 5.1-7.6 9.7-7.6 9.7Z"/><path d="M8.2 12.4h2l1.2-2.2 1.6 4.2 1.2-2h1.8"/>',
    'ellipsis': '<circle cx="5" cy="12" r="1.15"/><circle cx="12" cy="12" r="1.15"/><circle cx="19" cy="12" r="1.15"/>',
    'dots': '<circle cx="5" cy="12" r="1.15"/><circle cx="12" cy="12" r="1.15"/><circle cx="19" cy="12" r="1.15"/>',
    'target': '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1"/>',
    'tag': '<path d="M3.6 4.6h7.1l9.2 9.2-6.6 6.6-9.3-9.2V4.6Z"/><circle cx="7.6" cy="8.6" r="1.2"/>',
    'award': '<circle cx="12" cy="9" r="5.4"/><path d="m8.6 13.4-1.4 7 4.8-2.4 4.8 2.4-1.4-7"/>',

    /* ----- 文件 / 系统 ----- */
    'download': '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-2.5"/>',
    'upload': '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-2.5"/>',
    'eye': '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3.2"/>',
    'eye-off': '<path d="M4 4l16 16"/><path d="M9.5 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.2 7.8A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5c1.3 0 2.5-.3 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    'chevron-left': '<path d="m14.5 5-7 7 7 7"/>',
    'chevron-right': '<path d="m9.5 5 7 7-7 7"/>',
    'chevron-down': '<path d="m5 9.5 7 7 7-7"/>',
    'chevron-up': '<path d="m5 14.5 7-7 7 7"/>',
    'arrow-left': '<path d="M20 12H4M9 7l-5 5 5 5"/>',
    'arrow-right': '<path d="M4 12h16M15 7l5 5-5 5"/>',
    'arrow-up': '<path d="M12 20V4M7 9l5-5 5 5"/>',
    'arrow-down': '<path d="M12 4v16M7 15l5 5 5-5"/>',
    'arrow-up-right': '<path d="M7 17 17 7M8 7h9v9"/>',
    'arrow-down-left': '<path d="M17 7 7 17M16 17H7V8"/>',
    'transfer': '<path d="M4 8h15M16 5l3 3-3 3"/><path d="M20 16H5M8 13l-3 3 3 3"/>',
    'calendar': '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01"/>',
    'clock-alt': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.4 2"/>'
  };

  /* 兼容命名：旧契约、分类种子、任务书里的近义词都指向同一份路径。 */
  var ALIASES = {
    'tab-overview': 'home',
    'tab-home': 'home',
    'tab-list': 'list',
    'tab-ledger': 'list',
    'tab-chart': 'chart',
    'tab-stats': 'chart',
    'tab-settings': 'settings',
    'tab-plan': 'target',
    'tab-mine': 'user',
    'mine': 'user',
    'ledger': 'list',
    'statistics': 'chart',
    'stats': 'chart',
    'back': 'chevron-left',
    'more': 'dots',
    'menu': 'dots',
    'bank-card': 'card',
    'credit-card': 'credit',
    'wallet-card': 'wallet',
    'cash-pay': 'cash',
    'shopping': 'bag',
    'dining': 'food',
    'transport': 'car',
    'entertainment': 'fun',
    'game': 'fun',
    'medical': 'health',
    'education': 'book',
    'housing': 'home',
    'communication': 'phone',
    'utilities': 'bolt',
    'salary-income': 'salary',
    'bonus-income': 'bonus',
    'investment': 'invest',
    'invest-line': 'chart-line',
    'budget': 'pie',
    'goal': 'target',
    'export': 'download',
    'import': 'upload',
    'book-ledger': 'book',
    'tag-label': 'tag',
    'success': 'check-circle',
    'error': 'x-circle',
    'danger': 'warning',
    'search-glass': 'search',
    'filter-funnel': 'filter',
    'photo': 'camera',
    'delete': 'trash',
    'add': 'plus',
    'income': 'arrow-down',
    'expense': 'arrow-up',
    'savings-account': 'savings',
    'creditcard': 'credit'
  };

  /* 单色几何图标：闪电（水电） */
  PATHS['bolt'] = '<path d="M13.5 2.5 5 13.2h5.3L10.5 21.5 19 10.8h-5.3l-.2-8.3Z"/>';

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function normalizeOptions(opts) {
    if (typeof opts === 'number') { return { size: opts }; }
    return opts && typeof opts === 'object' ? opts : {};
  }

  function resolveName(name) {
    var key = String(name || '');
    return ALIASES[key] || key;
  }

  function icon(name, opts) {
    var o = normalizeOptions(opts);
    var rawName = String(name || '');
    var key = resolveName(rawName);
    var body = PATHS[key] || PATHS.ellipsis;

    var size = Number(o.size) || DEFAULT_SIZE;
    if (size < 12) { size = 12; }
    if (size > 96) { size = 96; }
    var fallbackStroke = CATEGORY_KEYS[key] ? CATEGORY_STROKE : DEFAULT_STROKE;
    var stroke = o.strokeWidth === undefined ? fallbackStroke : Number(o.strokeWidth);
    if (!isFinite(stroke) || stroke <= 0) { stroke = DEFAULT_STROKE; }

    var cls = 'c-icon';
    if (o.className) { cls += ' ' + String(o.className); }
    var title = o.title ? String(o.title) : '';
    var labelled = !!title || o.ariaHidden === false;
    var aria = labelled ? '' : ' aria-hidden="true" focusable="false"';
    var role = labelled ? ' role="img"' : '';
    var titleNode = title ? '<title>' + escapeAttr(title) + '</title>' : '';

    return '<svg xmlns="http://www.w3.org/2000/svg" class="' + escapeAttr(cls) + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + stroke +
      '" stroke-linecap="round" stroke-linejoin="round" data-icon="' + escapeAttr(rawName) +
      '"' + role + aria + '>' + titleNode + body + '</svg>';
  }

  function svg(name, opts) {
    return icon(name, opts);
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* 兜底：DOMParser 按 XML 解析时若根节点不在 SVG 命名空间，浏览器会把它当未知
     HTML 元素（0×0、无描边）。这里在 SVG 命名空间里重建，保证图标一定画得出来。 */
  function toSvgNamespace(src) {
    if (!src || src.nodeType !== 1) { return src; }
    if (src.namespaceURI === SVG_NS) { return src; }
    var out = document.createElementNS(SVG_NS, src.tagName);
    var i;
    for (i = 0; i < src.attributes.length; i++) {
      var attr = src.attributes[i];
      try { out.setAttribute(attr.name, attr.value); } catch (e) { /* 忽略非法属性名 */ }
    }
    for (i = 0; i < src.childNodes.length; i++) {
      var child = src.childNodes[i];
      if (child.nodeType === 1) {
        out.appendChild(toSvgNamespace(child));
      } else {
        out.appendChild(child.cloneNode(true));
      }
    }
    return out;
  }

  function node(name, opts) {
    if (typeof document === 'undefined' || !document.createElement) { return null; }
    var html = icon(name, opts);
    if (document.createElementNS && global.DOMParser) {
      try {
        var doc = new global.DOMParser().parseFromString(html, 'image/svg+xml');
        var parsed = doc && doc.documentElement;
        if (parsed && parsed.nodeName && parsed.nodeName.toLowerCase() === 'svg') {
          return toSvgNamespace(document.importNode(parsed, true));
        }
      } catch (e) { /* 回退到 HTML 解析 */ }
    }
    var holder = document.createElement('span');
    holder.innerHTML = html; /* 常量字符串，无用户数据 */
    return toSvgNamespace(holder.firstChild);
  }

  function has(name) {
    var key = resolveName(name);
    return Object.prototype.hasOwnProperty.call(PATHS, key);
  }

  function names() {
    return Object.keys(PATHS);
  }

  var api = Object.freeze({
    icon: icon,
    svg: svg,
    node: node,
    has: has,
    names: names,
    count: Object.keys(PATHS).length,
    defaultSize: DEFAULT_SIZE,
    defaultStroke: DEFAULT_STROKE
  });

  UI.icons = api;
  var lower = XZB.ui || (XZB.ui = {});
  if (!lower.icons) { lower.icons = api; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)
);
