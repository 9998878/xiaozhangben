#!/usr/bin/env node
'use strict';

/* 跑 tests/*.test.js，逐个打印结果并汇总。用法：node scripts/test.js [--json] */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const testsDir = path.join(ROOT, 'tests');
const json = process.argv.includes('--json');

const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('tests/ 下没有 *.test.js');
  process.exit(1);
}

const results = files.map((file) => {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(testsDir, file)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const m = output.match(/通过\s*(\d+)\s*\/\s*失败\s*(\d+)(?:\s*\/\s*观察项\s*(\d+))?/);
  return {
    file,
    ok: run.status === 0,
    pass: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
    note: m && m[3] ? Number(m[3]) : 0,
    ms: Date.now() - started,
    output,
  };
});

const total = results.reduce(
  (acc, r) => ({
    pass: acc.pass + (r.pass || 0),
    fail: acc.fail + (r.fail || 0),
    note: acc.note + r.note,
  }),
  { pass: 0, fail: 0, note: 0 }
);
const failed = results.filter((r) => !r.ok);

if (json) {
  const payload = {
    total,
    results: results.map(({ output, ...rest }) => rest),
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(failed.length ? 1 : 0);
}

for (const r of results) {
  const meta =
    r.pass == null
      ? ''
      : ` ${r.pass} 通过${r.fail ? ` / ${r.fail} 失败` : ''}${r.note ? ` / ${r.note} 观察` : ''}`;
  console.log(`${r.ok ? '✓' : '✗'} ${r.file}${meta} (${r.ms}ms)`);
  if (!r.ok) {
    const tail = r.output.trim().split('\n').slice(-25);
    console.log(tail.map((l) => `  ${l}`).join('\n'));
  }
}

console.log(
  `\n合计：${total.pass} 通过，${total.fail} 失败${total.note ? `，${total.note} 观察` : ''}，${files.length} 个文件`
);
process.exit(failed.length ? 1 : 0);