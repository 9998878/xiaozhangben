#!/usr/bin/env node
'use strict';

/* 提交前自检：版本三处、AGENTS 长度、文档指针、旧文档残留、CHANGELOG。
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

console.log('');
if (problems.length) {
  console.error(`自检失败：${problems.length} 项`);
  process.exit(1);
}
console.log('自检通过');