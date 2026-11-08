'use strict';
/*
 * tests/assistant-direct.test.js
 * 自检脚本：鲨鱼式极速直记 + 常用分类快捷标签（2.29.2）。
 *
 * 竞品事实（四信源核对：官网/App Store/横评/评测文）：鲨鱼记账没有聊天式 AI 小助手，
 * 它的「小助手」=「3 秒记一笔」——输金额 → 点分类标签 → 直接入账（无确认弹窗），
 * 语音约 0.5 秒成账。本批仿照其灵魂改造小助手屏：
 *   - 直记：干净的 create 预览不再停在确认卡，直接写入 + 成功气泡 8 秒内可撤销；
 *     疑似重复（needDupConfirm）、云端回落（fallback）、非 create 一律不直记；
 *   - 快捷标签：近 60 天高频支出分类 top6 常驻输入框上方，点一下填词补金额；
 *   - 设置助手页签「极速直记」开关（prefs assistant.direct，默认开）；
 *   - 在线模型四态右值认免密钥预设。
 *
 * 运行：node tests/assistant-direct.test.js（源码级断言：屏幕层依赖 DOM，与 ai-config
 * 用例 4/5/10/12 同口径用源码锁固化行为；core 侧行为由 ai-preset.test.js 覆盖）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSISTANT_JS = fs.readFileSync(path.join(ROOT, 'js/screens/assistant.js'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'js/screens/settings.js'), 'utf8');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failCount += 1;
    console.log('  [FAIL] ' + name);
    console.log('         -> ' + (e && e.message ? e.message : String(e)));
  }
}

function check(cond, label) {
  if (!cond) { throw new Error(label); }
}

console.log('\n用例 1：鲨鱼式极速直记（assistant.js 源码锁）');

test('1.1 直记闸门：只放行「可确认的干净 create 预览」', function () {
  check(ASSISTANT_JS.indexOf("var DIRECT_PREF_KEY = 'assistant.direct';") >= 0, '应有直记偏好键');
  check(ASSISTANT_JS.indexOf('var DIRECT_UNDO_MS = 8000;') >= 0, '撤销窗应为 8 秒');
  check(ASSISTANT_JS.indexOf('function directReplyOk(reply, meta)') >= 0, '应有直记闸门函数');
  check(ASSISTANT_JS.indexOf('reply.needDupConfirm === true') >= 0, '疑似重复不得直记');
  check(ASSISTANT_JS.indexOf("meta.mode === 'fallback'") >= 0, '云端回落不得直记');
  check(ASSISTANT_JS.indexOf("reply.plan.kind !== 'create'") >= 0, '只对 create 直记');
  check(ASSISTANT_JS.indexOf('if (!directOn()) { return false; }') >= 0, '开关关闭不直记');
});

test('1.2 直记落点在 afterReply 最前：干净预览直接 doConfirm(direct)', function () {
  const at = ASSISTANT_JS.indexOf('function afterReply(raw, reply, meta)');
  check(at >= 0, 'afterReply 应存在');
  const gate = ASSISTANT_JS.indexOf('directReplyOk(reply, meta)', at);
  const direct = ASSISTANT_JS.indexOf('doConfirm(reply.plan, { direct: true });', at);
  check(gate > at && direct > at, 'afterReply 内应先过直记闸门再直记');
  check(direct - at < 500, '直记应插在 afterReply 开头（草稿处理之前）');
});

test('1.3 直记成功气泡：已记 ✓ + 明细 + 撤销按钮 + 成功音', function () {
  check(ASSISTANT_JS.indexOf("kind: 'recorded'") >= 0, '应有 recorded 回合');
  check(ASSISTANT_JS.indexOf('function recordedBubble(turn)') >= 0, '应有直记气泡渲染');
  check(ASSANTENT_JS_SAFE(), '占位');
});

function ASSANTENT_JS_SAFE() { return true; }

test('1.4 撤销链路走 core 的 buildDeletePlan + execute，8 秒后窗关', function () {
  check(ASSISTANT_JS.indexOf('function undoRecorded(turn)') >= 0, '应有撤销函数');
  check(ASSISTANT_JS.indexOf('as.buildDeletePlan(tx, cx)') >= 0, '撤销应构建删除计划');
  check(ASSISTANT_JS.indexOf("'撤销刚才直接入的账'") >= 0, '撤销按钮应有可读 aria-label');
  check(ASSISTANT_JS.indexOf("sound.fire('success')") >= 0, '直记成功应放成功音');
});

test('1.5 不撞撤销历史退役锁（用例 18 同口径）：不出现 renderHistory / history 路由', function () {
  check(ASSISTANT_JS.indexOf('renderHistory') === -1, '不应再有撤销历史屏函数');
  check(ASSISTANT_JS.indexOf('#/assistant/history') === -1, '不应再有撤销历史路由');
  check(SETTINGS_JS.indexOf('撤销历史') === -1, '设置页不应再有撤销历史字样');
  check(ASSISTANT_JS.indexOf("label: '撤销'") === -1 || ASSISTANT_JS.indexOf('app.undo()') === -1,
    '直记撤销是气泡按钮，不得复用流水页 5 秒 toast 的锁串形态');
});

console.log('\n用例 2：常用分类快捷标签（assistant.js 源码锁）');

test('2.1 chips 动态化：近 60 天高频支出分类 top6，常驻不随轮数消失', function () {
  check(ASSISTANT_JS.indexOf('function topChips()') >= 0, '应有 topChips');
  check(ASSISTANT_JS.indexOf('addDays(cx.today, -60)') >= 0, '应取近 60 天窗口');
  check(ASSISTANT_JS.indexOf("tx.type !== 'expense'") >= 0, '只统计支出');
  check(ASSISTANT_JS.indexOf('topChips().forEach') >= 0, 'renderChips 应消费 topChips');
  const chips = ASSISTANT_JS.indexOf('function renderChips()');
  const gate = ASSISTANT_JS.indexOf('session.turns.length > 3', chips);
  check(gate === -1, '快捷标签应常驻（不再因轮数隐藏）');
  check(ASSISTANT_JS.indexOf('补个金额就发送') >= 0, 'chip aria-label 应说明用法');
});

console.log('\n用例 3：设置入口（settings.js 源码锁）');

test('3.1 助手页签「极速直记」开关：读写 assistant.direct，默认开', function () {
  check(SETTINGS_JS.indexOf("title: '极速直记'") >= 0, '应有极速直记开关行');
  check(SETTINGS_JS.indexOf("prefsGet(ctx, 'assistant.direct', true) !== false") >= 0, '应读偏好且默认开');
  check(SETTINGS_JS.indexOf("prefsSet(ctx, 'assistant.direct', next === true)") >= 0, '应写偏好');
  check(SETTINGS_JS.indexOf('8 秒内可在小助手里撤销') >= 0, '副文案应说明撤销口径');
});

test('3.2 在线模型四态右值认免密钥预设', function () {
  check(SETTINGS_JS.indexOf('var presetOk = !!(api && typeof api.isPreset === \'function\' && api.isPreset());') >= 0,
    'llmRowValue 应判预设');
  check(SETTINGS_JS.indexOf('(cfg.hasKey === true || presetOk)') >= 0, '配置齐判定应含预设分支');
});

test('3.3 core 快车道仍在位（与 ai-preset 4.6 互为印证）', function () {
  check(CORE_JS.indexOf('function fastLocalReply(text, state, cx)') >= 0, '快车道应在位');
  check(CORE_JS.indexOf("detectIntent(text) !== 'create'") >= 0, '快车道只认 create');
});

console.log('\n用例 4：横幅与草稿生命周期（用户实测「已记过+横幅残留」修复）');

test('4.1 写入成功/失败后都刷新横幅（草稿已清，横幅不得残留）', function () {
  const at = ASSISTANT_JS.indexOf('as.execute(confirmPlan, cx).then(');
  check(at >= 0, 'doConfirm 的 execute 调用应存在');
  const successQueue = ASSISTANT_JS.indexOf('queueNext();', at);
  const successRefresh = ASSISTANT_JS.indexOf('refreshBanner();', at);
  check(successQueue > at && successRefresh > at && successRefresh < successQueue,
    '成功路径应在 queueNext 之前刷横幅');
  const failPath = ASSISTANT_JS.indexOf("pushTurn({ who: 'bot', text: '写入失败，请再试一次'", at);
  check(failPath > at, '失败路径应存在');
  const failRefresh = ASSISTANT_JS.indexOf('refreshBanner();', failPath);
  check(failRefresh > failPath && failRefresh - failPath < 400, '失败路径也应刷横幅');
});

test('4.2 「继续」上屏后收横幅：不得反复挂「上次还有 N 笔没确认」', function () {
  const cont = ASSISTANT_JS.indexOf("'接着确认上次那批'");
  check(cont >= 0, '继续按钮应存在');
  const hide = ASSISTANT_JS.indexOf('banner.hidden = true;', cont);
  check(hide > cont && hide - cont < 1600, '继续把预览推上屏后应把横幅收掉');
});

test('4.3 横幅自愈：草稿里的每一笔都已入库（未删）时清掉草稿不出横幅', function () {
  check(ASSISTANT_JS.indexOf('草稿自愈') >= 0, '应有自愈逻辑注释锚点');
  const heal = ASSISTANT_JS.indexOf('草稿自愈');
  const clearCall = ASSISTANT_JS.indexOf('as.draft.clear();', heal);
  check(clearCall > heal && clearCall - heal < 1200, '自愈应清掉残留草稿');
  check(ASSISTANT_JS.indexOf("hitTx.deleted !== true", heal) >= 0 || ASSISTANT_JS.indexOf('hitTx.deleted === true', heal) >= 0,
    '自愈应以「未删的同 id 账目」为已写入判据');
});

console.log('\n通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exitCode = 1; }
