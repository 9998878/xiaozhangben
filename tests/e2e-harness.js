'use strict';

/* E2E 探针钩子：浏览器端用法说明（本文件不被 scripts/test.js 执行——它只挑 *.test.js）。
 *
 * 产品侧唯一依赖：js/screens/assistant.js pushTurn() 末尾的
 *   if (window.__xzbTest) { try { window.__xzbTest(turn); } catch (error) { ... } }
 * 探针全部走 window.__xzbEvents 拿权威回合流，不再数 .s-assistant__log 行数——
 * 行数快照拍在 send 之后会撞「本地快车道 <120ms、回复已渲染、行数永不涨」的竞态，
 * 整屏重绘（paint 从 session.turns 重建 DOM）还会让行数虚涨，这两类毛病就此根除。
 */

/* ① 发送前装钩子（任意时机可装，pushTurn 每次调用时才读 window.__xzbTest）：
 *
 * await page.evaluate(() => {
 *   window.__xzbEvents = [];
 *   window.__xzbTest = (turn) => window.__xzbEvents.push({
 *     t: performance.now(),
 *     turn: JSON.parse(JSON.stringify(turn)), // 冻结快照：直记回合 8 秒后会被原地置 undoGone
 *   });
 * });
 *
 * ② 记游标——必须在点击发送之前（根治「回复太快等不到新行」的关键）：
 *
 * const cursor = await page.evaluate(() => window.__xzbEvents.length);
 *
 * ③ 点击发送（现逻辑不变），等游标之后第一条 bot 回合：
 *
 * await page.waitForFunction(
 *   (c) => window.__xzbEvents.slice(c).some((e) => e.turn.who === 'bot' && !e.turn.notice),
 *   cursor,
 *   { timeout: 30000 }
 * );
 * const turns = await page.evaluate((c) => window.__xzbEvents.slice(c).map((e) => e.turn), cursor);
 *
 * 匹配口径（源自 assistant.js，改回合结构时同步这里）：
 * - kind 有两个位置：普通回复在 turn.reply.kind；直记气泡在顶层 turn.kind === 'recorded'
 * - 过滤 who === 'user' 的回显与 turn.notice（隐私告知）；排队 hint 只在连发时出现
 * - 事件流独立于 session.turns：不受 MAX_TURNS 裁剪和 resetSession 影响
 * - 超时 = 真没回复；用 turn.mode / turn.reason / turn.tone 直接定位回落原因
 */
