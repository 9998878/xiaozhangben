'use strict';
/*
 * tests/assistant-state-remote.test.js
 * 2.32.4：草稿冲突必须本地秒回；账户不重要，转账不得再问转入账户。
 * 用户真机截图：上一批没确认时发「烟14.09」，云端却反问「14.09 是什么意思」。
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

function findInlineBlock(marker) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(INDEX_HTML))) {
    if (m[1].indexOf(marker) >= 0) { return m[1]; }
  }
  return null;
}

const lsMap = Object.create(null);
const ls = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(lsMap, k) ? lsMap[k] : null; },
  setItem(k, v) { lsMap[k] = String(v); },
  removeItem(k) { delete lsMap[k]; }
};
let fetchCalls = 0;
const sandbox = {
  console: console, AbortController: AbortController, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Date: Date, JSON: JSON, Promise: Promise, Math: Math, Number: Number, String: String, Object: Object, Array: Array, isFinite: isFinite,
  localStorage: ls, navigator: { onLine: true },
  fetch: function () { fetchCalls += 1; return Promise.reject(new Error('草稿冲突不得出站')); }
};
sandbox.global = sandbox;
vm.createContext(sandbox);
for (const marker of ['js/core/money.js', 'js/core/dates.js', 'js/core/schema.js']) {
  vm.runInContext(findInlineBlock(marker), sandbox, { filename: marker });
}
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/nl.js'), 'utf8'), sandbox, { filename: 'nl.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/core-assistant.js'), 'utf8'), sandbox, { filename: 'core-assistant.js' });

const llm = sandbox.XZB.Core.assistant.llm;
const asst = sandbox.XZB.Core.assistant;
const p = llm.preset();
llm.setConfig({ baseURL: p.baseURL, model: p.model, key: '' });
llm.setConfig({ enabled: true });
llm.setConfig({ noticeAt: Date.now() });

const accounts = [
  { id: 'ac_cash', name: '现金', type: 'cash', archived: false },
  { id: 'ac_wechat', name: '微信', type: 'wechat', archived: false },
  { id: 'ac_alipay', name: '支付宝', type: 'alipay', archived: false }
];
const categories = sandbox.XZB.Core.schema.seedData().categories;
const ctx = {
  today: '2026-11-13', nowTime: '20:41', bookId: 'bk_main', accounts: accounts, categories: categories,
  defaults: { type: 'expense' }, db: { transactions: [], accounts: [], categories: [] },
  liveAccounts: accounts, liveCategories: categories
};

(async function () {
  console.log('\n===== 2.32.4 草稿冲突的联网路径 =====');

  /* 账户不重要：转账不再问转入账户，直接本地出预览，零网络请求 */
  const transfer = asst.respond('转账500', {}, ctx);
  check('转账应直接出预览', transfer.reply.kind === 'preview', 'kind=' + transfer.reply.kind);
  check('转账不应留下待选账户', !transfer.state.pending, JSON.stringify(transfer.state.pending));
  const transferRemote = await asst.respondRemote('转账500', {}, ctx);
  check('联网模式转账也不得问账户', transferRemote.reply.kind === 'preview' &&
    String(transferRemote.reply.text || '').indexOf('转到哪个账户') < 0, 'kind=' + transferRemote.reply.kind + ' text=' + transferRemote.reply.text);
  check('转账零网络请求', fetchCalls === 0, 'fetchCalls=' + fetchCalls);

  /* 草稿冲突：上一批是完整转账预览，用户又说「烟14.09」 */
  const draft = asst.respond('转账500', {}, ctx);
  const out = await asst.respondRemote('烟14.09', draft.state, ctx);
  check('草稿冲突应本地秒回（mode=local）', out.mode === 'local', 'mode=' + out.mode);
  check('冲突气泡应提示上一批，而不是反问 14.09', out.reply.kind === 'conflict', 'kind=' + out.reply.kind);
  check('冲突时不得发出任何网络请求', fetchCalls === 0, 'fetchCalls=' + fetchCalls);
  check('冲突文案应点名上一批「转账500」', String(out.reply.text || '').indexOf('转账500') >= 0, out.reply.text);

  /* 联网模式下按钮 value 也必须本地处理 */
  const dropped = await asst.respondRemote('drop', out.state, ctx);
  check('联网模式点「放弃并重新解析」应直接出预览', dropped.reply.kind === 'preview' && dropped.reply.plan && dropped.reply.plan.raw === '烟14.09',
    'kind=' + dropped.reply.kind + ' raw=' + (dropped.reply.plan && dropped.reply.plan.raw));
  check('drop 不得出站', fetchCalls === 0, 'fetchCalls=' + fetchCalls);

  const kept = await asst.respondRemote('keep', out.state, ctx);
  check('联网模式点「继续编辑上一批」应回旧预览', kept.reply.kind === 'preview' &&
    kept.reply.plan && kept.reply.plan.raw === '转账500', 'kind=' + kept.reply.kind);
  check('keep 不得出站', fetchCalls === 0, 'fetchCalls=' + fetchCalls);

  const firstCancel = asst.respond('转账500', {}, ctx);
  const cancelled = await asst.respondRemote('取消', firstCancel.state, ctx);
  check('联网模式「取消」应清空草稿', cancelled.reply.kind === 'hint' && !cancelled.state.pending && !cancelled.state.draft,
    'kind=' + cancelled.reply.kind + ' draft=' + JSON.stringify(cancelled.state.draft && cancelled.state.draft.raw));
  check('取消不得出站', fetchCalls === 0, 'fetchCalls=' + fetchCalls);

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
