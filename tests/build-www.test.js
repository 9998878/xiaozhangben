'use strict';
/*
 * tests/build-www.test.js
 * www 构建脚本（scripts/build-www.js）契约测试。
 *
 * 运行：node tests/build-www.test.js（scripts/test.js 自动收集）
 *
 * 覆盖：运行时文件齐全、桥接注入带版本 query、sw.js 不混入、Web 源码零改动、
 *       输出目录守卫（仓库根必须拒绝）。构建跑在系统临时目录，不碰仓库 www/。
 *
 * 本脚本只读业务代码，不修改任何业务文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { currentVersion } = require('../scripts/lib');

/* ============================== 极简测试骨架 ============================== */

let passCount = 0;
let failCount = 0;

function section(title) {
  console.log('\n===== ' + title + ' =====');
}

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

function checkEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/* ============================== 构建到临时目录 ============================== */

const version = currentVersion();
if (!version) { throw new Error('读不到当前版本'); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xzb-www-'));
let buildOutput = '';
try {
  buildOutput = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'build-www.js'), '--out', tmp],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  );

  section('用例 1：运行时文件齐全');
  test('1.1 入口与静态资源', function () {
    for (const rel of ['index.html', 'favicon.ico', 'manifest.webmanifest', 'icons/icon-512.png', 'js/screens/home.js', 'js/modules/nl.js']) {
      check(fs.existsSync(path.join(tmp, rel)), '缺少 ' + rel);
    }
  });
  test('1.2 splash 目录整体复制', function () {
    const src = fs.readdirSync(path.join(ROOT, 'splash')).sort();
    const out = fs.readdirSync(path.join(tmp, 'splash')).sort();
    checkEq(out.join(','), src.join(','), 'splash 文件一致');
  });

  section('用例 2：桥接注入');
  test('2.1 index.html 注入带版本 query 的桥接脚本', function () {
    const html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
    check(html.includes('<script src="js/native-bridge.js?v=' + version + '"></script>'), '注入标记');
    check(html.indexOf('native-bridge.js') < html.indexOf('</body>'), '注入在 </body> 前');
  });
  test('2.2 桥接文件就位且挂载 XZB.NativeBridge', function () {
    const code = fs.readFileSync(path.join(tmp, 'js', 'native-bridge.js'), 'utf8');
    check(code.includes('XZB.NativeBridge'), '挂载标记');
    checkEq(code, fs.readFileSync(path.join(ROOT, 'native', 'bridge.js'), 'utf8'), '与源码逐字一致');
  });

  section('用例 3：隔离与零改动');
  test('3.1 sw.js 不进 www（原生壳不需要 SW）', function () {
    check(!fs.existsSync(path.join(tmp, 'sw.js')), 'sw.js 混入');
  });
  test('3.2 开发文件不进 www', function () {
    for (const rel of ['tests', 'docs', 'scripts', 'node_modules', 'AGENTS.md', 'CHANGELOG.md', 'native']) {
      check(!fs.existsSync(path.join(tmp, rel)), rel + ' 混入');
    }
  });
  test('3.3 Web 源码 index.html 零改动', function () {
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check(!src.includes('native-bridge'), '源码不应含桥接注入');
  });
  test('3.4 构建汇总输出存在', function () {
    check(buildOutput.includes('www 产物'), '汇总行');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

section('用例 4：输出目录守卫');
test('4.1 --out 指向仓库根必须拒绝', function () {
  let rejected = false;
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'build-www.js'), '--out', '.'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', windowsHide: true }
    );
  } catch (e) {
    rejected = e.status !== 0;
  }
  check(rejected, '仓库根输出未被拒绝');
});

/* ============================== 汇总 ============================== */

console.log('\n===== 汇总 =====');
console.log('通过 ' + passCount + ' / 失败 ' + failCount);
if (failCount > 0) { process.exit(1); }