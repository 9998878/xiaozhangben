#!/usr/bin/env node
'use strict';

/* 浏览器离线冒烟（2.44.3，执行检验报告 P2-2）：把验收时手工跑通的 CDP 流程自动化。
   Node 测试测不到 DOM 渲染、路由、SW 生命周期和离线启动——这里补上最小真实闭环：
   静态服务 → 在线真实键盘记一笔 → 读 IndexedDB → 断网 reload → 离线再记一笔 →
   恢复联网 reload → 校验版本、缓存名、两笔数据、控制台错误 + 主路由冒烟。

   零运行时依赖：Node ≥ 22（内置 fetch/WebSocket）+ 本机 Chrome/Edge headless（CDP）。
   用法：node scripts/smoke.js；可用 CHROME_PATH 指定浏览器可执行文件。
   候选浏览器按序探测 DevTools，端口被安全软件拦截时自动换下一个。
   CI（.github/workflows/check.yml）在 test/check 之后跑同一条命令。
   本文件不在 tests/ 下，scripts/test.js 不会收集它。 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const VERSION = (/XZB\.version\s*=\s*'(\d+\.\d+\.\d+)'/.exec(INDEX_HTML) || [])[1];
if (!VERSION) { console.error('✗ index.html 找不到 XZB.version'); process.exit(1); }
const CACHE_NAME = 'xzb2-v' + VERSION;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function fail(msg) { throw new Error(msg); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServer(port) {
  const srv = http.createServer((req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/') { rel = '/index.html'; }
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end('server error');
    }
  });
  return new Promise((resolve, reject) => {
    srv.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });
}

/* 候选浏览器：按序尝试，DevTools 探测不通就换下一个。
   本机安全软件可能拦 Chrome 的调试端口（TCP 连接被丢包），Edge 同为 Chromium 可兜底；
   CI ubuntu-latest 自带 google-chrome。CHROME_PATH 可强制指定。 */
function browserCandidates() {
  const list = [];
  if (process.env.CHROME_PATH) { list.push(process.env.CHROME_PATH); }
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  }
  return list.filter((p, i) => p && fs.existsSync(p) && list.indexOf(p) === i);
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败：' + (e.message || url)));
  });
}

class Cdp {
  constructor(ws) {
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) { reject(new Error(msg.method + ' ' + JSON.stringify(msg.error))); }
        else { resolve(msg.result); }
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
      }
    };
    this.ws = ws;
  }
  send(method, params, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params: params || {} };
    if (sessionId) { payload.sessionId = sessionId; }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) { this.listeners.push(fn); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 看门狗兜底清理用的进程级引用 */
let chromeProc = null;
let httpSrv = null;
let tmpProfile = null;
function hardCleanup() {
  try {
    if (chromeProc && chromeProc.pid) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { windowsHide: true });
      } else { chromeProc.kill('SIGKILL'); }
    }
  } catch (e) { /* 已退出 */ }
  try { if (httpSrv) { httpSrv.close(); } } catch (e) { /* 已关闭 */ }
  try { if (tmpProfile) { fs.rmSync(tmpProfile, { recursive: true, force: true }); } } catch (e) { /* 占用时忽略 */ }
}

async function main() {
  const debugPort = await freePort();
  const appPort = await freePort();
  const base = 'http://127.0.0.1:' + appPort;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xzb-smoke-'));
  const server = await startServer(appPort);
  httpSrv = server;
  tmpProfile = profileDir;
  const candidates = browserCandidates();
  if (!candidates.length) { fail('找不到 Chrome/Edge/Chromium，可用 CHROME_PATH 指定'); }
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + debugPort,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=390,844',
    'about:blank',
  ];
  if (process.platform === 'linux') { args.unshift('--no-sandbox'); }
  let chrome = null;
  let cdp = null;

  const killProc = (proc) => {
    try {
      if (!proc || !proc.pid) { return; }
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else { proc.kill('SIGKILL'); }
    } catch (e) { /* 已退出 */ }
  };
  const cleanup = () => {
    killProc(chrome);
    try { server.close(); } catch (e) { /* 已关闭 */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* 占用时忽略 */ }
  };

  try {
    /* ---- 逐个候选浏览器启动并探测 DevTools（端口被安全软件拦截时换下一个） ---- */
    let browserWs = null;
    let usedBrowser = '';
    for (let ci = 0; ci < candidates.length; ci++) {
      const exe = candidates[ci];
      /* 每个候选用独立 profile 子目录，避免前一浏览器的锁/格式残留 */
      const launchArgs = ['--user-data-dir=' + path.join(profileDir, 'try' + ci)].concat(args);
      chrome = spawn(exe, launchArgs, { stdio: 'ignore' });
      chromeProc = chrome;
      for (let i = 0; i < 40 && !browserWs; i++) {
        await sleep(250);
        try {
          const res = await fetch('http://127.0.0.1:' + debugPort + '/json/version', { signal: AbortSignal.timeout(2000) });
          browserWs = (await res.json()).webSocketDebuggerUrl;
        } catch (e) { /* 还没起来或被拦截 */ }
      }
      if (browserWs) { usedBrowser = exe; break; }
      killProc(chrome);
      chrome = null;
      chromeProc = null;
    }
    if (!browserWs) { fail('所有候选浏览器的 DevTools 均未就绪（调试端口可能被安全软件拦截）'); }
    console.log('✓ 浏览器：' + usedBrowser);
    cdp = new Cdp(await openWebSocket(browserWs));

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);

    /* 控制台错误收集：网络层报错（断网模拟的预期产物）不算应用错误 */
    const consoleErrors = [];
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) { return; }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('exception: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && msg.params.entry.source !== 'network') {
        consoleErrors.push('log: ' + msg.params.entry.text.slice(0, 300));
      }
    });

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (res.exceptionDetails) { fail('页面求值抛错：' + JSON.stringify(res.exceptionDetails).slice(0, 300)); }
      return res.result ? res.result.value : undefined;
    };
    const waitFor = async (expression, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await evaluate(expression)) { return; }
        if (Date.now() > deadline) { fail('等待超时：' + label); }
        await sleep(250);
      }
    };
    const ready = () => waitFor(
      "document.readyState === 'complete' && !!(window.XZB && XZB.version) && " +
      "document.getElementById('app') && document.getElementById('app').getAttribute('aria-busy') === 'false'",
      30000, '应用就绪（boot 完成）');
    const navigate = async (url) => { await cdp.send('Page.navigate', { url }, sessionId); await ready(); };
    const reload = async () => { await cdp.send('Page.reload', {}, sessionId); await ready(); };
    const setOffline = (offline) => cdp.send('Network.emulateNetworkConditions', {
      offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1,
    }, sessionId);

    /* 真实输入管线点击（Input.dispatchMouseEvent）：带用户手势，
       避免 JS .click() 无 sticky activation 触发 vibrate 拦截类浏览器干预 */
    const clickAt = async (selector) => {
      const box = await evaluate("(function(){var el=document.querySelector('" + selector + "');" +
        "if(!el) return null; el.scrollIntoView({block:'center'});" +
        "var r=el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()");
      if (!box) { fail('找不到可点击元素：' + selector); }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
    };

    /* 真实键盘记一笔：#/add → 点金额区展开键盘 → 数字键 → confirm（保存）→ 回首页 */
    const recordBill = async (keys) => {
      await evaluate("location.hash = '#/add'");
      await waitFor("!!document.querySelector('.s-add-draft__amt')", 10000, '记一笔页就绪');
      await clickAt('.s-add-draft__amt');
      await waitFor("!!document.querySelector('.c-keypad__key[data-key=\"confirm\"]')", 10000, '记账键盘就绪');
      for (const k of keys) {
        await clickAt('.c-keypad__key[data-key="' + k + '"]');
      }
      await clickAt('.c-keypad__key[data-key="confirm"]');
      await waitFor("location.hash === '#/home' || location.hash === '' || location.hash === '#/'", 10000, '保存后回首页');
    };

    /* 读 IndexedDB：state['db'].value.transactions（与 store.js 持久化口径一致） */
    const readBills = () => evaluate(`new Promise((resolve, reject) => {
      const req = indexedDB.open('xzb2');
      req.onsuccess = () => {
        const db = req.result;
        const rq = db.transaction('state', 'readonly').objectStore('state').get('db');
        rq.onsuccess = () => {
          const rec = rq.result;
          const txs = rec && rec.value && Array.isArray(rec.value.transactions) ? rec.value.transactions : [];
          db.close();
          resolve(txs.filter((t) => !t.deleted).map((t) => ({ amountCents: t.amountCents, date: t.date, source: t.source })));
        };
        rq.onerror = () => { db.close(); reject(new Error('state.get 失败')); };
      };
      req.onerror = () => reject(new Error('indexedDB.open 失败'));
    })`);
    const hasBill = (bills, cents) => bills.some((b) => b.amountCents === cents);

    /* ---- 1 首次入口：版本 / SW 受控 / 缓存名 ---- */
    await navigate(base + '/index.html');
    const version = await evaluate('XZB.version');
    if (version !== VERSION) { fail('版本不符：期望 ' + VERSION + '，实际 ' + version); }
    try {
      await waitFor('!!(navigator.serviceWorker && navigator.serviceWorker.controller)', 15000, 'SW 受控');
    } catch (e) {
      await reload();
      await waitFor('!!(navigator.serviceWorker && navigator.serviceWorker.controller)', 15000, 'SW 受控（重载后）');
    }
    const cacheKeys = await evaluate('caches.keys()');
    if (!cacheKeys.includes(CACHE_NAME)) { fail('缓存名缺失：期望 ' + CACHE_NAME + '，实际 ' + JSON.stringify(cacheKeys)); }
    console.log('✓ 首次入口：版本 ' + VERSION + ' · SW 受控 · 缓存 ' + CACHE_NAME);

    /* ---- 2 在线记一笔（12.34）---- */
    await recordBill(['1', '2', 'dot', '3', '4']);
    let bills = await readBills();
    if (!hasBill(bills, 1234)) { fail('在线记账未落库：' + JSON.stringify(bills)); }
    console.log('✓ 在线记账：1234 分已落 IndexedDB');

    /* ---- 3 断网冷启动：版本/缓存/旧账可读 ---- */
    await setOffline(true);
    await reload();
    if ((await evaluate('XZB.version')) !== VERSION) { fail('断网重载后版本不符'); }
    if (!(await evaluate('!!navigator.serviceWorker.controller'))) { fail('断网重载后 SW 未受控'); }
    bills = await readBills();
    if (!hasBill(bills, 1234)) { fail('断网后旧账不可读：' + JSON.stringify(bills)); }
    console.log('✓ 断网冷启动：版本/缓存正确，旧账可读');

    /* ---- 4 离线再记一笔（5.00）---- */
    await recordBill(['5']);
    bills = await readBills();
    if (!hasBill(bills, 1234) || !hasBill(bills, 500)) { fail('离线记账未落库：' + JSON.stringify(bills)); }
    console.log('✓ 离线记账：两笔 1234 / 500 均在库');

    /* ---- 5 恢复联网重载：数据不丢 ---- */
    await setOffline(false);
    await reload();
    bills = await readBills();
    if (!hasBill(bills, 1234) || !hasBill(bills, 500)) { fail('恢复联网后数据丢失：' + JSON.stringify(bills)); }
    console.log('✓ 恢复联网：两笔数据保留');

    /* ---- 6 主路由冒烟：有真实内容 ---- */
    const routes = ['#/home', '#/stats', '#/calendar', '#/report', '#/books', '#/plan', '#/settings', '#/assistant', '#/add'];
    for (const hash of routes) {
      await evaluate("location.hash = '" + hash + "'");
      await waitFor("document.getElementById('app') && document.getElementById('app').textContent.trim().length > 20", 8000, '路由内容 ' + hash);
    }
    console.log('✓ 主路由冒烟：' + routes.length + ' 条路由均有内容');

    /* ---- 6b 切换行为（2.44.4）：Tab 根不走整页快照、二级页走；首页明细延后挂载落位 ----
       用 XZB.router.go（应用内链接点击的同款入口，onDocumentClick → go）；
       手改 location.hash 走 animate:false 的外部地址路径，测不到转场决策。 */
    await evaluate(`(function(){
      window.__vtCalls = 0;
      if (document.startViewTransition) {
        var orig = document.startViewTransition.bind(document);
        document.startViewTransition = function(cb){ window.__vtCalls += 1; return orig(cb); };
      }
      return true;
    })()`);
    await evaluate("XZB.router.go('#/home')");
    await waitFor("!!document.querySelector('#view-root .app-screen[data-view=\"home\"]')", 8000, '回到首页');
    await evaluate("XZB.router.go('#/stats')");
    await waitFor("!!document.querySelector('#view-root .app-screen[data-view=\"stats\"]')", 8000, '横切到统计');
    const vtAfterTab = await evaluate('window.__vtCalls');
    if (vtAfterTab !== 0) { fail('Tab 根横切不应走 View Transition 整页快照，实际调用 ' + vtAfterTab + ' 次'); }
    await evaluate("XZB.router.go('#/books')");
    await waitFor("!!document.querySelector('#view-root .app-screen[data-view=\"books\"]')", 8000, '进入账本子页');
    const vtAfterPush = await evaluate('window.__vtCalls');
    if (vtAfterPush < 1) { fail('二级页进入应走 View Transition 方向化推入，实际调用 ' + vtAfterPush + ' 次'); }
    await evaluate("XZB.router.go('#/home')");
    await waitFor("!!document.querySelector('#view-root .app-screen[data-view=\"home\"]')", 8000, '回到首页（明细延后挂载）');
    await waitFor("!!document.querySelector('[data-ledger-embed=\"1\"]')", 8000, '首页嵌入明细延后挂载落位');
    const vtAfterBackTab = await evaluate('window.__vtCalls');
    if (vtAfterBackTab !== vtAfterPush) { fail('子页回 Tab 根也不应新增整页快照，实际 ' + vtAfterBackTab + ' 次'); }
    console.log('✓ 切换行为：Tab 根无整页快照 · 二级页有推入 · 首页明细延后挂载落位');

    /* ---- 7 控制台错误 ---- */
    if (consoleErrors.length) { fail('控制台有错误：\n  ' + consoleErrors.join('\n  ')); }
    console.log('✓ 控制台错误：0');

    console.log('\n冒烟通过（' + VERSION + ' · ' + CACHE_NAME + '）');
    cleanup();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ 冒烟失败：' + (error && error.message ? error.message : String(error)));
    cleanup();
    process.exit(1);
  }
}

/* 总看门狗：任何环节卡死也不让 CI 挂住 */
setTimeout(() => {
  console.error('✗ 冒烟超时（180 秒看门狗）');
  hardCleanup();
  process.exit(1);
}, 180000).unref();

main();