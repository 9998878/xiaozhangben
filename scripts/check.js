#!/usr/bin/env node
'use strict';

/* 提交前自检：版本四处、AGENTS 长度、文档指针、旧文档残留、CHANGELOG。
   只做机械校验，不跑测试（测试交给 scripts/test.js）。 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readDoc, currentVersion, currentCache } = require('./lib');

const problems = [];

function ok(name) {
  console.log(`✓ ${name}`);
}

function bad(name, detail) {
  problems.push(`${name}：${detail}`);
  console.log(`✗ ${name}：${detail}`);
}

function exists(rel) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    ok(rel);
    return true;
  }
  bad(rel, '不存在');
  return false;
}

const version = currentVersion();
if (version) ok(`版本读取：${version}`);
else bad('版本读取', 'index.html 里找不到 XZB.version');

const cache = currentCache();
if (version) {
  if (cache.name && cache.name.includes(version)) ok(`sw.js CACHE_NAME 含 ${version}`);
  else bad('sw.js CACHE_NAME', `不含版本 ${version}`);

  if (cache.label && cache.label.includes(version)) ok(`sw.js CACHE_LABEL 含 ${version}`);
  else bad('sw.js CACHE_LABEL', `不含版本 ${version}`);
}

const testFile = 'tests/category-expansion.test.js';
if (fs.existsSync(path.join(ROOT, testFile)) && version) {
  const escaped = version.replace(/\./g, '\\.');
  if (readDoc(testFile).includes(escaped)) ok(`测试版本串：${escaped}`);
  else bad(testFile, `缺少转义版本串 ${escaped}（用例 7.1/7.2）`);
}

/* 2.44.6 复验新发现：第 4 处版本字面量——calendar-report 6.3 也锁 CACHE_NAME。
   漏改虽会被 test.js 拦红，但发版人应在自检阶段就拿到明确指引，而不是去
   38 条用例里找一条「源码锁失效」。 */
const calFile = 'tests/calendar-report.test.js';
if (fs.existsSync(path.join(ROOT, calFile)) && version) {
  const escaped = version.replace(/\./g, '\\.');
  if (readDoc(calFile).includes('xzb2-v' + escaped)) ok(`calendar-report 版本串：xzb2-v${escaped}`);
  else bad(calFile, `缺少转义版本串 xzb2-v${escaped}（用例 6.3）`);
}

const agentsPath = path.join(ROOT, 'AGENTS.md');
if (fs.existsSync(agentsPath)) {
  const agents = fs.readFileSync(agentsPath, 'utf8');
  const lines = agents.split('\n').length;
  if (lines <= 60) ok(`AGENTS.md ${lines} 行`);
  else bad('AGENTS.md', `${lines} 行，上限 60 行`);

  const count = agents.match(/\d+\s*(?:条|个|项|份)?\s*(?:测试|用例|全绿)/);
  if (count) bad('AGENTS.md 硬编码测试数', count[0]);
  else ok('AGENTS.md 无硬编码测试数');

  const ver = agents.match(/\b\d+\.\d+\.\d+\b/);
  if (ver) bad('AGENTS.md 硬编码版本', ver[0]);
  else ok('AGENTS.md 无硬编码版本');
} else {
  bad('AGENTS.md', '不存在');
}

for (const rel of [
  'README.md',
  'CHANGELOG.md',
  'docs/architecture.md',
  'docs/known-issues.md',
  'docs/release.md',
  'scripts/test.js',
  'scripts/status.js',
  'scripts/check.js',
]) {
  exists(rel);
}

for (const rel of ['HANDOFF.md', 'agent.md']) {
  if (fs.existsSync(path.join(ROOT, rel))) bad('旧文档残留', rel);
  else ok(`无旧文档：${rel}`);
}
for (const f of fs.readdirSync(ROOT).filter((f) => /^DELIVERY-.*\.md$/.test(f))) {
  bad('旧文档残留', f);
}

if (fs.existsSync(path.join(ROOT, 'CHANGELOG.md')) && version) {
  const heading = new RegExp(`^##\\s*\\[?${version.replace(/\./g, '\\.')}\\]?`, 'm');
  if (heading.test(readDoc('CHANGELOG.md'))) ok(`CHANGELOG 含 ${version}`);
  else bad('CHANGELOG.md', `缺少 ${version} 条目`);
}

if (fs.existsSync(path.join(ROOT, 'README.md'))) {
  const readme = readDoc('README.md');
  if (/HANDOFF\.md|agent\.md/.test(readme)) bad('README.md', '仍指向 HANDOFF.md / agent.md');
  else ok('README 未指向旧文档');
}

const kiPath = path.join(ROOT, 'docs/known-issues.md');
if (fs.existsSync(kiPath)) {
  if (/^##\s/m.test(fs.readFileSync(kiPath, 'utf8'))) ok('known-issues 有内容');
  else bad('docs/known-issues.md', '没有二级标题');
}

/* ---- README / AGENTS 与真实产物对账（2.38.1）----
   README 曾停在 2.18.0 落后 20 版：文件数、隐私说明、仓库定位全失真，
   而这些数字人肉维护必漂。这里全部从磁盘上数出来再和文档比。 */
function jsFilesIn(rel) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) { return []; }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

const chunks = [...jsFilesIn('js/screens'), ...jsFilesIn('js/modules')];
const screens = jsFilesIn('js/screens').length;
const modules = jsFilesIn('js/modules').length;
const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? readDoc('README.md') : '';

if (version && readme) {
  const heading = new RegExp(`^##\\s*${version.replace(/\./g, '\\.')}\\s*更新了什么`, 'm');
  if (heading.test(readme)) ok(`README 顶部「更新了什么」是当前版本 ${version}`);
  else bad('README.md', `没有「## ${version} 更新了什么」——版本说明落后于代码`);
}

if (chunks.length && readme) {
  if (readme.includes(`${chunks.length} 个页面/模块文件`)) {
    ok(`README 页面/模块文件数 = ${chunks.length}（页面 ${screens} + 模块 ${modules}）`);
  } else {
    bad('README.md', `没有写「${chunks.length} 个页面/模块文件」——磁盘上实际 ${chunks.length} 个（页面 ${screens} + 模块 ${modules}）`);
  }
}

if (fs.existsSync(path.join(ROOT, 'sw.js')) && readme) {
  const block = /var PRECACHE = \[([\s\S]*?)\];/.exec(readDoc('sw.js'));
  const precacheCount = block ? block[1].split('\n').filter((l) => l.includes("'./")).length : 0;
  if (precacheCount && readme.includes(`${precacheCount} 项`)) {
    ok(`README 预缓存项数 = ${precacheCount}`);
  } else {
    bad('README.md', `没有写「${precacheCount} 项」——sw.js PRECACHE 实际 ${precacheCount} 项`);
  }
}

if (fs.existsSync(agentsPath) && chunks.length) {
  const agents = fs.readFileSync(agentsPath, 'utf8');
  const missing = chunks.filter((f) => agents.indexOf(f.replace(/\.js$/, '')) < 0);
  if (!missing.length) ok(`AGENTS.md 地图覆盖全部 ${chunks.length} 个页面/模块文件`);
  else bad('AGENTS.md', `地图漏了 ${missing.join('、')}`);
}

/* ---- 2.44.1：architecture 数字与 README 超时口径对账（验收报告 P3-1 防再漂移）---- */
const archPath = path.join(ROOT, 'docs/architecture.md');
if (fs.existsSync(archPath) && chunks.length) {
  const arch = fs.readFileSync(archPath, 'utf8');
  const am = /chunk-manifest\s*(\d+)\s*项、sw 预缓存\s*(\d+)\s*项/.exec(arch);
  if (am && Number(am[1]) === chunks.length) ok(`architecture chunk 数 = ${chunks.length}`);
  else bad('docs/architecture.md', `chunk-manifest 项数应写 ${chunks.length}（实际 ${am ? am[1] : '未找到'}）`);
  const pcBlock = /var PRECACHE = \[([\s\S]*?)\];/.exec(readDoc('sw.js'));
  const pcCount = pcBlock ? pcBlock[1].split('\n').filter((l) => l.includes("'./")).length : 0;
  if (am && Number(am[2]) === pcCount) ok(`architecture 预缓存数 = ${pcCount}`);
  else bad('docs/architecture.md', `sw 预缓存项数应写 ${pcCount}（实际 ${am ? am[2] : '未找到'}）`);
}
if (readme) {
  const nav = /NAV_TIMEOUT_MS\s*=\s*(\d+)/.exec(readDoc('sw.js'));
  const secs = nav ? String(Number(nav[1]) / 1000) : '';
  if (secs && readme.includes(`${secs} 秒超时`)) ok(`README 导航超时口径 = ${secs} 秒`);
  else bad('README.md', `导航超时应写「${secs} 秒超时」（sw.js NAV_TIMEOUT_MS）`);
}

console.log('');
if (problems.length) {
  console.error(`自检失败：${problems.length} 项`);
  process.exit(1);
}
console.log('自检通过');