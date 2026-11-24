'use strict';
/*
 * tests/scripts-status.test.js
 * 2.38.1 回归：scripts/status.js 在没装 git 的机器上不能崩。
 *
 * 旧版第一条命令就是 git rev-parse，没装 git 时抛 spawnSync git ENOENT，
 * 接手第一命令直接红屏，连后面的测试汇总都出不来。
 * 做法：起子进程跑 status.js，把 PATH 砍到只剩 node 自己的目录，模拟「找不到 git」。
 *
 * 运行：node tests/scripts-status.test.js（scripts/test.js 自动收集）
 * 只读：不改任何业务文件，status.js 本身也只读。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* 防套娃：本测试在 status.js 拉起的测试进程里运行时直接退出，
   否则 status → test.js → 本测试 → 再起 status，无限递归。 */
if (process.env.XZB_STATUS_RUN === '1') {
  console.log('\n===== 汇总 =====');
  console.log('通过 0 / 失败 0');
  process.exit(0);
}

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

/* 去掉所有大小写形式的 PATH，再只放 node 所在目录 */
function envWithoutGit() {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (!/^path$/i.test(key)) { env[key] = process.env[key]; }
  }
  env.PATH = path.dirname(process.execPath);
  return env;
}

function runStatus(env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'status.js')], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true
  });
}

console.log('\n===== 用例 1：没装 git 时 status.js 不崩，测试汇总照常 =====');

test('1.1 PATH 里没有 git：退出码 0，不出现 ENOENT', function () {
  const run = runStatus(envWithoutGit());
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  check(run.status === 0, '退出码应为 0，实际 ' + run.status + '\n' + output.slice(-600));
  check(output.indexOf('ENOENT') < 0, '不该出现 ENOENT：' + output.slice(-300));
  check(output.indexOf('git：未安装') >= 0, '应提示 git 未安装，实际输出：\n' + output);
});

test('1.2 跳过 git 后仍打印版本、缓存名、测试合计和下一步', function () {
  const output = runStatus(envWithoutGit()).stdout || '';
  check(/^版本：index\.html \d+\.\d+\.\d+ · sw xzb2-v\d+\.\d+\.\d+/m.test(output), '缺版本行：\n' + output);
  check(output.indexOf('缓存名：与版本一致') >= 0, '缓存名应与版本一致：\n' + output);
  check(/^测试：\d+ 通过 \/ \d+ 文件全绿/m.test(output), '缺测试合计行：\n' + output);
  check(output.indexOf('node scripts/test.js && node scripts/check.js') >= 0, '缺下一步提示');
});

/* 机器上真有 git 时，顺带确认正常路径没被改坏；没有 git 就不计数 */
const probe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
if (probe.error && probe.error.code === 'ENOENT') {
  console.log('  [跳过] 2.1 本机没装 git，正常路径用例不运行');
} else {
  console.log('\n===== 用例 2：装了 git 时正常路径不变 =====');
  test('2.1 输出分支与最近提交', function () {
    const output = runStatus(process.env).stdout || '';
    check(/^分支：/m.test(output), '缺分支行：\n' + output);
    check(output.indexOf('最近提交：') >= 0, '缺最近提交');
  });
}

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }
