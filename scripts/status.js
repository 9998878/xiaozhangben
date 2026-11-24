#!/usr/bin/env node
'use strict';

/* 接手第一件事：一条命令看清分支、版本、脏文件、测试、最近提交。 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, currentVersion, currentCache, git } = require('./lib');

function line(label, value) {
  console.log(`${label}：${value}`);
}

/* git 三态：已安装且在仓库内 / 已安装但不在仓库 / 没装。
   旧版没装 git 时第一条命令就抛 spawnSync git ENOENT 整个脚本崩掉，
   连后面的测试汇总都出不来（2.38.1）。 */
function probeGit() {
  try {
    git(['--version']);
  } catch (error) {
    return { ok: false, text: '未安装——分支、同步、工作树、最近提交跳过（装好 Git 并重开终端后可用）' };
  }
  try {
    git(['rev-parse', '--git-dir']);
  } catch (error) {
    return { ok: false, text: '当前目录不是 git 仓库——分支、同步、工作树、最近提交跳过' };
  }
  return { ok: true, text: '' };
}

function printGitState() {
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
}

console.log('小账本 status');

const gitInfo = probeGit();
if (gitInfo.ok) {
  printGitState();
} else {
  line('git', gitInfo.text);
}

const version = currentVersion();
const cache = currentCache();
line('版本', version ? `index.html ${version} · sw ${cache.name || '?'}` : 'index.html 里找不到 XZB.version');
if (version && cache.name) {
  const consistent = cache.name.includes(version) && (!cache.label || cache.label.includes(version));
  line('缓存名', consistent ? '与版本一致' : '与版本不一致（跑 node scripts/check.js）');
}

/* 带上标记：tests/scripts-status.test.js 看到它就直接退出——
   否则 status → test.js → 该测试 → 再起 status，无限套娃（2.38.1） */
const testRun = spawnSync(process.execPath, [path.join(__dirname, 'test.js'), '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, XZB_STATUS_RUN: '1' },
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
