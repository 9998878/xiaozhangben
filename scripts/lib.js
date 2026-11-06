'use strict';

/* 小账本开发脚本共享工具：版本读取、仓库路径、git 调用。 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function readDoc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** index.html 里最后一条 XZB.version = 'x.y.z' 赋值 */
function currentVersion() {
  const html = readDoc('index.html');
  const all = [...html.matchAll(/XZB\.version\s*=\s*'([^']+)'/g)];
  return all.length ? all[all.length - 1][1] : null;
}

function currentCache() {
  const sw = readDoc('sw.js');
  const name = sw.match(/CACHE_NAME\s*=\s*'([^']+)'/);
  const label = sw.match(/CACHE_LABEL\s*=\s*'([^']+)'/);
  return { name: name && name[1], label: label && label[1] };
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

module.exports = { ROOT, readDoc, currentVersion, currentCache, git };