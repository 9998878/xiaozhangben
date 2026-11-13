'use strict';
/*
 * tests/assistant-state.test.js
 * 2.32.4 回归：补问/草稿不能把用户锁死，冲突按钮必须真的能用；
 * 账户不重要——转账不再追问转入账户，缺省自动补不同账户。
 *
 * 背景（用户真机截图）：本地解析明明能认「烟14.09」，但上一批还在补问时，
 * 这句话被当成「转到哪个账户」的回答，反复追问；冲突气泡的
 * 「继续编辑上一批 / 放弃并重新解析」按钮传 keep/drop，核心只认中文，点了没反应。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? ' -> ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）', actual === expected);
}

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const sandbox = { console: console };
vm.createContext(sandbox);
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js']) {
  const code = findInlineBlock(marker);
  if (!code) { throw new Error('index.html 中找不到内联块：' + marker); }
  vm.runInContext(code, sandbox, { filename: marker });
}
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8'), sandbox, { filename: 'nl.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8'), sandbox, { filename: 'core-assistant.js' });

const asst = sandbox.XZB.Core.assistant;
const schema = sandbox.XZB.Core.schema;
if (!asst) { throw new Error('core-assistant 未就绪'); }

const accounts = [
  { id: 'ac_cash', name: '现金', type: 'cash', archived: false },
  { id: 'ac_wechat', name: '微信', type: 'wechat', archived: false },
  { id: 'ac_alipay', name: '支付宝', type: 'alipay', archived: false }
];
const ctx = {
  today: '2026-11-13', nowTime: '20:41', bookId: 'bk_main',
  accounts: accounts,
  categories: schema.seedData().categories,
  defaults: { type: 'expense' },
  db: { transactions: [], accounts: [], categories: [] },
  liveAccounts: accounts,
  liveCategories: schema.seedData().categories
};

console.log('\n===== 2.32.4 补问 / 草稿状态机 =====');

/* 1) 新会话：明确一句直接出预览 */
let out = asst.respond('烟14.09', {}, ctx);
eq('新会话「烟14.09」应出预览', out.reply.kind, 'preview');
eq('金额应识别为 14.09', out.reply.plan && out.reply.plan.items[0].amountCents, 1409);
eq('分类应识别为烟酒', out.reply.plan && out.reply.plan.items[0].categoryId, 'ca_smoke');

/* 2) 账户不重要：转账不再问转入账户，自动补一个不同的默认账户 */
out = asst.respond('转账500', {}, ctx);
eq('「转账500」应直接出预览，不再问账户', out.reply.kind, 'preview');
eq('转账类型应保留', out.reply.plan && out.reply.plan.items[0].type, 'transfer');
check('转出与转入应是两个不同账户',
  out.reply.plan && out.reply.plan.items[0].accountId && out.reply.plan.items[0].toAccountId &&
  out.reply.plan.items[0].accountId !== out.reply.plan.items[0].toAccountId,
  JSON.stringify(out.reply.plan && out.reply.plan.items[0]));
check('转账不应留下待选账户', !out.state.pending, JSON.stringify(out.state.pending));
eq('转账不应有阻塞项', out.reply.plan && out.reply.plan.items[0].issues.length, 0);

/* 3) 草稿冲突按钮 keep：回旧草稿的预览 */
out = asst.respond('转账500', {}, ctx);
out = asst.respond('烟14.09', out.state, ctx);
eq('草稿未确认时输入新账应转冲突', out.reply.kind, 'conflict');
out = asst.respond('keep', out.state, ctx);
eq('keep 应恢复旧草稿的预览', out.reply.kind, 'preview');
eq('keep 的草稿应是转账', out.state.draft && out.state.draft.raw, '转账500');

/* 4) 冲突按钮 drop：放弃旧批，按新句子重解析 */
out = asst.respond('转账500', {}, ctx);
out = asst.respond('烟14.09', out.state, ctx);
eq('草稿冲突应可放弃', out.reply.kind, 'conflict');
out = asst.respond('drop', out.state, ctx);
eq('drop 应按新句子重新解析', out.reply.kind, 'preview');
eq('重新解析的应正是「烟14.09」', out.reply.plan && out.reply.plan.raw, '烟14.09');
check('drop 应说清已放弃上一批', String(out.reply.text || '').indexOf('已放弃上一批') === 0, out.reply.text);

/* 4b) drop 后的新句子若是在查账，也必须走查询路由，不能硬当记账 */
out = asst.respond('午饭35', {}, ctx);
eq('先建立一份待确认草稿', out.reply.kind, 'preview');
out = asst.respond('这个月花了多少', out.state, ctx);
eq('草稿时发查询应转冲突', out.reply.kind, 'conflict');
out = asst.respond('drop', out.state, ctx);
eq('drop 后发查询应走查询路由', out.reply.kind, 'query');

/* 5) 补问/草稿的通用取消 */
out = asst.respond('买洗衣液', {}, ctx);
out = asst.respond('取消', out.state, ctx);
check('补问时「取消」应清空 pending 与 draft', out.reply.kind === 'hint' && !out.state.pending && !out.state.draft, 'kind=' + out.reply.kind);
out = asst.respond('午饭35', {}, ctx);
out = asst.respond('算了', out.state, ctx);
check('草稿时「算了」应清空草稿', out.reply.kind === 'hint' && !out.state.draft && !out.state.pending, 'kind=' + out.reply.kind);

/* 6) 明确说账户时仍要听懂，不是一律瞎补 */
out = asst.respond('从微信转500到支付宝', {}, ctx);
eq('显式转账应完成预览', out.reply.kind, 'preview');
eq('显式转出账户应识别微信', out.reply.plan && out.reply.plan.items[0].accountId, 'ac_wechat');
eq('显式转入账户应识别支付宝', out.reply.plan && out.reply.plan.items[0].toAccountId, 'ac_alipay');

/* 7) 提示词护栏：明确数字不得再问「什么意思 / 是多少钱」 */
const CORE_JS = fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8');
check('提示词含「9.1」物品名+数字规则', CORE_JS.indexOf('9.1 「物品名+数字」就是金额') >= 0);
check('提示词禁止追问「这个数字是什么意思」', CORE_JS.indexOf('禁止追问「这个数字是什么意思/是多少钱/请确认金额」') >= 0);
check('补问遇到完整新账应直接让路', CORE_JS.indexOf('function switchToNewEntry') >= 0 &&
  CORE_JS.indexOf('return switchToNewEntry(input, next, cx)') >= 0);
check('转账缺转入账户应自动补默认账户', CORE_JS.indexOf('function defaultToAccountId') >= 0);
check('提示词禁止让用户选账户', CORE_JS.indexOf('禁止追问账户或让用户选账户') >= 0);

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
