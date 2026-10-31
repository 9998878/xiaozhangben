/* 小账本 2.0 · js/modules/quips.js（源：src/js/modules/quips.js）
 * 俏皮点评：记账成功后按「备注关键词 → 分类名 → 金额档 → 通用池」挑一条
 * 诙谐点评（≤40 字），善意调侃、绝不嘲讽收入与必要开支。
 * 公开：XZB.core.quips.for({type, amountCents, categoryId, categoryName, note}) → string
 *   返回 '' 表示这笔不适合点评（转账/数据不全/任何内部异常）——点评是锦上添花，
 *   任何情况下都不许影响记账主流程（本模块不抛错）。
 */
(function (global) {
  'use strict';

  var XZB = global.XZB || (global.XZB = {});
  var core = XZB.core || (XZB.core = {});
  if (core.quips) {
    if (global.console && global.console.error) {
      global.console.error('XZB.core.quips 已注册，保留首个实现');
    }
    return;
  }

  var MAX_LEN = 40;          /* 硬上限：超过即弃用该条，换兜底池 */
  var BIG_AMOUNT = 50000;    /* ≥500 元（分）触发大额调侃 */
  var lastIndex = -1;        /* 上一条在最终池里的序号，避免连着两条一样 */

  /* 关键词规则：keys 命中「备注 + 分类名」任一即取对应池（先声明先命中） */
  var RULES = [
    { keys: ['烟', '香烟', '电子烟'], pool: [
      '又抽烟？这钱买斤水果不香吗～',
      '烟钱一出，肺和钱包一起叹气',
      '这盒烟烧掉的不止钱，还有肺活量哦'
    ] },
    { keys: ['啤酒', '白酒', '红酒', '洋酒', '喝酒', '酒'], pool: [
      '小酌怡情，大酌伤钱包，悠着点～',
      '这杯下肚，钱包先醉了',
      '酒钱记下了，明天头疼别找我哭'
    ] },
    { keys: ['奶茶'], pool: [
      '奶茶一杯，快乐三秒，糖分管够一周',
      '这杯奶茶的钱，够买两斤苹果啦',
      '珍珠嚼着香，钱包瘦得快'
    ] },
    { keys: ['咖啡'], pool: [
      '咖啡因续命成功，钱包生命值 -1',
      '这杯咖啡，打工人今日份燃料到账',
      '咖啡提不提神不知道，花钱挺提神'
    ] },
    { keys: ['外卖'], pool: [
      '外卖虽香，楼下食堂表示不服',
      '这顿外卖的钱，够买一天的菜了',
      '外卖小哥都想劝你：学做饭吧'
    ] },
    { keys: ['火锅'], pool: [
      '火锅一涮，钱包减半，痛快！',
      '毛肚七上八下，余额跟着下滑'
    ] },
    { keys: ['烧烤', '烤串', '撸串'], pool: [
      '撸串一时爽，余额泪两行',
      '这顿烤的是肉，焦的是钱包'
    ] },
    { keys: ['零食', '薯片', '辣条'], pool: [
      '零食囤货 +1，减肥计划 -1',
      '嘴巴不寂寞了，钱包有点寂寞'
    ] },
    { keys: ['游戏', '氪金', '皮肤', '抽卡', '点券'], pool: [
      '氪金大佬，这单够吃三顿好的',
      '皮肤 +1，钱包 -1，战力 +0',
      '抽卡的手气，不如攒钱的手艺'
    ] },
    { keys: ['彩票', '刮刮乐'], pool: [
      '暴富梦 +1，理智 +0，祝好运～',
      '两块钱买希望挺值，别买多了哦'
    ] },
    { keys: ['打车', '滴滴', '出租车'], pool: [
      '打个车，腿舒服了，钱包有点瘸',
      '这趟车钱，够坐十次公交啦'
    ] },
    { keys: ['会员', '充值', '爱奇艺', '腾讯视频', '网易云', 'B站', '哔哩'], pool: [
      '又一个会员，自动续费关了吗？',
      '会员买到手，下月记得查续费'
    ] },
    { keys: ['水果'], pool: [
      '买水果，这钱花得健康，表扬一次！',
      '水果钱花得值，比奶茶强多了'
    ] },
    { keys: ['健身', '运动', '游泳', '瑜伽', '球'], pool: [
      '投资身体的钱，永远不算亏',
      '健身的钱到位了，人也要到位哦'
    ] },
    { keys: ['书', '课程', '培训', '学习'], pool: [
      '给大脑充值，这单必须点赞',
      '买书是最便宜的学费，值！'
    ] },
    { keys: ['医院', '看病', '药', '门诊'], pool: [
      '身体要紧，这钱不能省，祝早日康复',
      '看病的钱花得心疼但必要，保重'
    ] },
    { keys: ['电影', '演出', '演唱', 'KTV', '剧本杀'], pool: [
      '精神食粮到位，快乐无价（但也记账了）',
      '娱乐一下应该的，别连轴转就行'
    ] },
    { keys: ['房租', '租金'], pool: [
      '一月一度的「进贡」完成，抱抱',
      '房东笑了，钱包哭了，下个月再战'
    ] },
    { keys: ['工资', '薪水', '奖金'], income: true, pool: [
      '工资到账！先存后花，才是正道',
      '进账一笔，这个月也要好好规划哦'
    ] },
    { keys: ['红包', '退款', '报销'], income: true, pool: [
      '意外之喜，存起来比花掉更香',
      '回血成功，离小金库又近一步'
    ] }
  ];

  /* 大额支出（≥500 元）专用池，优先级低于关键词、高于通用池 */
  var BIG_POOL = [
    '大手笔！这单顶好几天饭钱了',
    '这一笔下去，预算都要抖三抖',
    '大额支出记下了，确定是必需品吗？'
  ];

  /* 收入通用池 */
  var INCOME_POOL = [
    '进账啦，恭喜！记得先存一笔',
    '钱进口袋的声音，真好听',
    '收入 +1，离小目标又近一步'
  ];

  /* 支出通用兜底池 */
  var GENERIC_POOL = [
    '记下了，每一分钱都有它的去向',
    '花钱容易记账难，坚持住！',
    '小钱也是钱，聚沙能成塔',
    '这笔支出已存档，下回花前想三秒',
    '账本已签收，钱包表示知道了'
  ];

  function pick(pool) {
    if (!pool.length) { return ''; }
    var index = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && index === lastIndex) {
      index = (index + 1) % pool.length;
    }
    lastIndex = index;
    return pool[index];
  }

  /* 分类名没传时，尝试从库快照按 categoryId 反查；查不到就静默跳过 */
  function resolveCategoryName(input) {
    if (input.categoryName) { return String(input.categoryName); }
    if (!input.categoryId) { return ''; }
    try {
      var app = XZB.app;
      var db = app && typeof app.db === 'function' ? app.db() : null;
      var list = db && db.categories ? db.categories : [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === input.categoryId) { return String(list[i].name || ''); }
      }
    } catch (error) { /* 查不到就用空名，点评降级到通用池 */ }
    return '';
  }

  /**
   * for(input) → 点评文案或 ''
   * input: { type, amountCents, categoryId, categoryName, note }
   */
  function quipFor(input) {
    try {
      if (!input || typeof input !== 'object') { return ''; }
      var type = input.type;
      if (type !== 'expense' && type !== 'income') { return ''; }
      var text = (String(input.note || '') + ' ' + resolveCategoryName(input)).toLowerCase();
      var cents = typeof input.amountCents === 'number' ? input.amountCents : 0;

      var pool = null;
      var i;
      for (i = 0; i < RULES.length; i += 1) {
        var rule = RULES[i];
        if ((type === 'income') !== !!rule.income) { continue; }
        for (var k = 0; k < rule.keys.length; k += 1) {
          if (text.indexOf(rule.keys[k].toLowerCase()) !== -1) { pool = rule.pool; break; }
        }
        if (pool) { break; }
      }
      if (!pool) {
        if (type === 'income') { pool = INCOME_POOL; }
        else if (cents >= BIG_AMOUNT) { pool = BIG_POOL; }
        else { pool = GENERIC_POOL; }
      }
      var text2 = pick(pool);
      /* 双保险：模板维护时超长的直接降级兜底，保证对外契约「≤40 字」 */
      if (!text2 || text2.length > MAX_LEN) { text2 = pick(GENERIC_POOL); }
      return text2.length <= MAX_LEN ? text2 : '';
    } catch (error) {
      return '';
    }
  }

  var api = Object.freeze({ for: quipFor, MAX_LEN: MAX_LEN });
  core.quips = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(window));
