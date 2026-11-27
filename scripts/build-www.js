#!/usr/bin/env node
'use strict';

/* 生成 Capacitor 的 www/ 产物（iOS 壳专用；Web 发布仍是仓库根直推 Pages，不用它）。
 *
 * 做三件事：
 *  1. 复制 Web 运行时文件：index.html、js/、icons/、splash/、favicon.ico、manifest.webmanifest；
 *  2. 在 index.html 唯一的 </body> 前注入 <script src="js/native-bridge.js?v=版本">；
 *  3. 把 native/bridge.js 复制为 www/js/native-bridge.js。
 *
 * 铁律：Web 源码零改动。sw.js 不进 www——capacitor:// 协议下，源码 registerServiceWorker
 *       的协议守卫（只认 http/https）会直接跳过注册；原生壳里所有资源本就在包内，无需 SW。
 *       桥接自身也只在 Capacitor 环境生效，浏览器直接打开 www 不受影响。
 *
 * 用法：node scripts/build-www.js [--out 目录]（默认 www/；测试用临时目录）
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, currentVersion } = require('./lib');

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function parseOut() {
  const i = process.argv.indexOf('--out');
  if (i >= 0 && process.argv[i + 1]) { return path.resolve(ROOT, process.argv[i + 1]); }
  return path.join(ROOT, 'www');
}

const out = parseOut();
if (out === ROOT) { fail('输出目录不能是仓库根'); }

/* 保守递归复制：只用 readdirSync/mkdirSync/copyFileSync。
 * 不用 fs.cpSync——部分 Windows node 构建上它会原生崩溃（0xC0000409），
 * 云构建与本地必须走同一条稳定路径。 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
  }
}

const version = currentVersion();
if (!version) { fail('index.html 里找不到 XZB.version'); }

const bridgeSrc = path.join(ROOT, 'native', 'bridge.js');
if (!fs.existsSync(bridgeSrc)) { fail('缺少 native/bridge.js'); }
const bridgeCode = fs.readFileSync(bridgeSrc, 'utf8');
if (!bridgeCode.includes('XZB.NativeBridge')) { fail('native/bridge.js 缺少 XZB.NativeBridge 挂载标记'); }

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bodyTags = html.match(/<\/body>/g) || [];
if (bodyTags.length !== 1) { fail('index.html 应恰有 1 个 </body>，实际 ' + bodyTags.length); }

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const dir of ['js', 'icons', 'splash']) {
  const src = path.join(ROOT, dir);
  if (!fs.existsSync(src)) { fail('缺少运行时目录 ' + dir); }
  copyDir(src, path.join(out, dir));
}
for (const file of ['favicon.ico', 'manifest.webmanifest']) {
  fs.copyFileSync(path.join(ROOT, file), path.join(out, file));
}

const injected = html.replace(
  '</body>',
  '<script src="js/native-bridge.js?v=' + version + '"></script>\n</body>'
);
fs.writeFileSync(path.join(out, 'index.html'), injected);
fs.copyFileSync(bridgeSrc, path.join(out, 'js', 'native-bridge.js'));

/* 产物自检：注入必须带版本 query；sw.js 不得混入 */
const check = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
if (!check.includes('js/native-bridge.js?v=' + version)) { fail('注入校验失败'); }
if (fs.existsSync(path.join(out, 'sw.js'))) { fail('sw.js 不应进入 www'); }

let count = 0;
let bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); } else { count += 1; bytes += fs.statSync(p).size; }
  }
})(out);
console.log('✓ www 产物：' + count + ' 个文件，' + (bytes / 1048576).toFixed(2) + ' MB（版本 ' + version + '，含原生桥接）');