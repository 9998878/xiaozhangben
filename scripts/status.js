#!/usr/bin/env node
'use strict';

/* 接手第一件事：一条命令看清分支、版本、脏文件、测试、最近提交。 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, currentVersion, currentCache, git } = require('./lib');

function line(label, value) {
  console.log(`${label}：${value}`);
}

console.log('小账本 status');

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
let upstream = '';
try {
  upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
} catch {}

let ahead = 0;
let behind = 0;
if (upstream) {
  const [a, b] = git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    .split(/\s+/)
    .map(Number);
  ahead = a;
  behind = b;
}

line('分支', `${branch}${upstream ? ` → ${upstream}` : '（无上游）'}`);
if (upstream && (ahead || behind)) line('同步', `ahead ${ahead} / behind ${behind}`);

const version = currentVersion();
const cache = currentCache();
line('版本', version ? `index.html ${version} · sw ${cache.name || '?'}` : 'index.html 里找不到 XZB.version');
if (version && cache.name) {
  const consistent = cache.name.includes(version) && (!cache.label || cache.label.includes(version));
  line('缓存名', consistent ? '与版本一致' : '与版本不一致（跑 node scripts/check.js）');
}

const dirty = git(['status', '--porcelain']);
if (dirty) {
  const lines = dirty.split('\n');
  line('工作树', `${lines.length} 处未提交`);
  lines.slice(0, 12).forEach((l) => console.log(`  ${l}`));
} else {
  line('工作树', '干净');
}

console.log('最近提交：');
git(['log', '--oneline', '-5'])
  .split('\n')
  .forEach((l) => console.log(`  ${l}`));

const testRun = spawnSync(process.execPath, [path.join(__dirname, 'test.js'), '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
});
let tests = null;
try {
  tests = JSON.parse(testRun.stdout);
} catch {}

if (tests) {
  const bad = tests.results.filter((r) => !r.ok);
  line(
    '测试',
    bad.length
      ? `${bad.length} 个文件失败（node scripts/test.js 看明细）`
      : `${tests.total.pass} 通过 / ${tests.results.length} 文件全绿`
  );
} else {
  line('测试', '运行 node scripts/test.js 失败，检查 node 环境');
}

console.log('\n下一步：node scripts/test.js && node scripts/check.js');