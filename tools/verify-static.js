#!/usr/bin/env node
/* ============================================================================
   小账本 2.0 · tools/verify-static.js · owner: QA（T-QA01，开发期资产）
   用途：把证据表里所有"可 grep 的 AC"做成一条命令，逐条输出 PASS/FAIL。
        零依赖，只读仓库，不改任何 js/**、index.html、sw.js。

   口径来源（冲突时以文档为准，不以此文件的作者记忆为准）：
     - 架构 §13.4「静态校验（可进 CI 的三个 grep）」 ← S1 / S3 / S8 的判据
     - 证据表 §1「开工前置校验 G1–G3」            ← S9（降级为 INFO，原因见下）
     - 证据表 §3.7「AC15 文案自检」                ← S7 的判据
     - 架构 §11「版本与缓存 2.24.0 同步清单」       ← S5
     - 契约 CONTRACT §2.5/B1′/B2（checkSync）      ← S6

   用法：
     node tools/verify-static.js              # 全量，有 FAIL 则 exit 1
     node tools/verify-static.js --soft       # 只报告，永 exit 0（实现收尾期用）
     node tools/verify-static.js --only S1,S7 # 只跑指定项
     node tools/verify-static.js --json       # 机器可读输出

   ── 四处"判据看起来合理但会错"的地方，已按文档修掉 ──────────────────────
   ① S1 不能只用 `fetch(`：ai-client 走 fetchOf()/doFetch() 间接调用，字面 0 命中，
      既证明不了"出口存在"也抓不到别人写 global.fetch（§13.4 原话）。故用宽模式，
      并另设 S2 证明"出口真的存在"——否则 S1 在"一个 fetch 都没有"时恒真通过（§13.3 第 2 问）。
   ② S7 不能把「已加密」一律判 FAIL：它就在 bannedCopy 黑名单里（'数据' + '已加密'）。
      §3.7 的真实判据是"旧串/禁用词命中 0 + bannedCopy 用拼接写法"。
      故命中按"是否落在 bannedCopy 数组内"分类，落在内部=允许，落在外=违规。
   ③ S1/S8 只在**代码区**命中才算违规。注释或字符串里出现 `global.fetch`、`app.commit`
      不构成真实调用，判 FAIL 会训练出"改注释过 CI"的坏习惯（§13.4 明确反对）。
      故本文件带一个注释/字符串遮罩，把命中分为 code / comment / string 三类。
   ④ S9（G2）的期望值已失真：文档写"仅 ai-client.js、ai-store.js 两个文件含 fetch"，
      实际 ai-enhance.js 也有 `probeInfo().fetch`（能力探测字段，非网络调用）。
      故 G2 降级为 INFO 并写明原因，不作为 FAIL 依据。
   ============================================================================ */

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var TARGET_VERSION = '2.24.0';

/* ---------------------------- 参数 ---------------------------- */

function hasFlag(name) { return process.argv.slice(2).indexOf('--' + name) >= 0; }
function argOf(name, fallback) {
  var argv = process.argv.slice(2);
  for (var i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--' + name && argv[i + 1]) { return argv[i + 1]; }
    if (argv[i].indexOf('--' + name + '=') === 0) { return argv[i].slice(name.length + 3); }
  }
  return fallback;
}

var SOFT = hasFlag('soft');
var JSON_OUT = hasFlag('json');
var ONLY = (argOf('only', '') || '').split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);

/* ---------------------------- 注释 / 字符串遮罩 ---------------------------- */

/* 返回 Uint8Array，逐字符标注：
     0 = 代码区   1 = 注释   2 = 字符串（含模板串）
   为什么需要它：直接 grep 会把注释、字符串、黑名单常量一起算进来，导致
   "改注释过 CI" 或 "黑名单自己把自己判死" 两类假信号。 */
function buildMask(src) {
  var mask = new Uint8Array(src.length);
  var i = 0;
  var n = src.length;
  var state = 'code'; // code | line | block | single | double | template
  while (i < n) {
    var c = src[i];
    var next = src[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; mask[i] = 1; mask[i + 1] = 1; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; mask[i] = 1; mask[i + 1] = 1; i += 2; continue; }
      if (c === '\'') { state = 'single'; mask[i] = 2; i += 1; continue; }
      if (c === '"') { state = 'double'; mask[i] = 2; i += 1; continue; }
      if (c === '`') { state = 'template'; mask[i] = 2; i += 1; continue; }
      i += 1;
      continue;
    }

    if (state === 'line') {
      mask[i] = 1;
      if (c === '\n') { state = 'code'; }
      i += 1;
      continue;
    }

    if (state === 'block') {
      mask[i] = 1;
      if (c === '*' && next === '/') { mask[i + 1] = 1; state = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }

    /* 字符串态：转义跳过两个字符，遇到同种引号收尾 */
    mask[i] = 2;
    if (c === '\\') { if (i + 1 < n) { mask[i + 1] = 2; } i += 2; continue; }
    if (state === 'single' && c === '\'') { state = 'code'; i += 1; continue; }
    if (state === 'double' && c === '"') { state = 'code'; i += 1; continue; }
    if (state === 'template' && c === '`') { state = 'code'; i += 1; continue; }
    i += 1;
  }
  return mask;
}

/* ---------------------------- 源码装载 ---------------------------- */

var CACHE = new Map();

function load(relPath) {
  if (CACHE.has(relPath)) { return CACHE.get(relPath); }
  var abs = path.join(ROOT, relPath);
  var text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    var miss = { rel: relPath, abs: abs, text: '', missing: true, lineStarts: [0], mask: new Uint8Array(0) };
    CACHE.set(relPath, miss);
    return miss;
  }
  var lineStarts = [0];
  for (var i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) { lineStarts.push(i + 1); }
  }
  var entry = { rel: relPath, abs: abs, text: text, missing: false, lineStarts: lineStarts, mask: buildMask(text) };
  CACHE.set(relPath, entry);
  return entry;
}

function lineOf(source, index) {
  var lo = 0;
  var hi = source.lineStarts.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (source.lineStarts[mid] <= index) { lo = mid; } else { hi = mid - 1; }
  }
  return lo + 1;
}

function snippet(source, index, radius) {
  var r = radius || 100;
  var line = lineOf(source, index);
  var start = source.lineStarts[line - 1];
  var end = line < source.lineStarts.length ? source.lineStarts[line] : source.text.length;
  var raw = source.text.slice(start, end).replace(/\r?\n$/, '').trim();
  return raw.length > r * 2 ? raw.slice(0, r * 2) + '…' : raw;
}

function kindOf(source, index) {
  if (!source.mask.length) { return 'code'; }
  return ['code', 'comment', 'string'][source.mask[index]] || 'code';
}

/* 逐文件扫描：把所有命中的位置、行号、代码/注释/字符串分类一次算清 */
function scan(relPaths, pattern, options) {
  var opts = options || {};
  var hits = [];
  relPaths.forEach(function (rel) {
    var source = load(rel);
    if (source.missing) { return; }
    var re = new RegExp(pattern.source, pattern.flags.indexOf('g') >= 0 ? pattern.flags : pattern.flags + 'g');
    var match;
    while ((match = re.exec(source.text)) !== null) {
      if (match[0] === '') { re.lastIndex += 1; continue; }
      hits.push({
        file: rel,
        line: lineOf(source, match.index),
        index: match.index,
        match: match[0],
        kind: kindOf(source, match.index),
        snippet: snippet(source, match.index, 90)
      });
      if (!opts.all && hits.length > 400) { return; }
    }
  });
  return hits;
}

/* ---------------------------- 文件清单 ---------------------------- */

function walk(dirRel) {
  var out = [];
  var abs = path.join(ROOT, dirRel);
  var entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (error) { return out; }
  entries.forEach(function (entry) {
    var childRel = dirRel + '/' + entry.name;
    if (entry.isDirectory()) {
      out = out.concat(walk(childRel));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  });
  return out;
}

/* 静态校验的作用域：index.html + js/**（tools/ 是开发期资产，不计入 §13.4 口径） */
function appScope() {
  var files = ['index.html'];
  return files.concat(walk('js').filter(function (f) { return /\.js$/.test(f); }));
}

/* ---------------------------- 检查项注册 ---------------------------- */

var CHECKS = [];

function check(id, title, fn, ref) {
  CHECKS.push({ id: id, title: title, run: fn, ref: ref || '' });
}

/* ============================================================================
   S1 · 网络唯一出口（架构 §13.4 ①）
   ============================================================================ */

check('S1', '网络唯一出口：index.html + js/** 中只有 js/modules/ai-client.js 可以发起网络', function () {
  /* 宽模式（§13.4 原文指定）：
       fetch(  global.fetch  fetchImpl  XMLHttpRequest  WebSocket
     单用 "fetch(" 会漏掉 ai-client 的 fetchOf()/doFetch() 间接调用。 */
  var hits = scan(appScope(), /fetch\(|global\.fetch|fetchImpl|XMLHttpRequest|WebSocket/g);
  var allowedFile = 'js/modules/ai-client.js';
  var violations = hits.filter(function (h) { return h.file !== allowedFile && h.kind === 'code'; });
  var foreignInComment = hits.filter(function (h) { return h.file !== allowedFile && h.kind !== 'code'; });
  var inAllowed = hits.filter(function (h) { return h.file === allowedFile; });

  var lines = [];
  lines.push('命中 ' + hits.length + ' 处（ai-client.js ' + inAllowed.length + '，其它文件 ' + (hits.length - inAllowed.length) + '）');
  if (foreignInComment.length) {
    lines.push('非代码区命中（不计违规，供人工确认）：');
    foreignInComment.slice(0, 8).forEach(function (h) {
      lines.push('  · ' + h.file + ':' + h.line + ' [' + h.kind + '] ' + h.snippet);
    });
  }
  violations.slice(0, 12).forEach(function (h) {
    lines.push('  违规 ' + h.file + ':' + h.line + ' → ' + h.snippet);
  });
  if (!inAllowed.length) {
    lines.push('⚠ ai-client.js 内 0 命中：说明"唯一出口"是个空命题，见 S2');
  }
  return {
    status: violations.length === 0 && inAllowed.length > 0 ? 'PASS' : 'FAIL',
    detail: lines
  };
}, '架构 §13.4 ① · 证据表 G1');

/* ============================================================================
   S2 · 出口存在性（防止 S1 恒真）
   ============================================================================ */

check('S2', '唯一出口确实存在：ai-client 经 fetchOf()/doFetch() 动态取 global.fetch', function () {
  var client = load('js/modules/ai-client.js');
  var lines = [];
  if (client.missing) { return { status: 'FAIL', detail: ['js/modules/ai-client.js 不存在'] }; }

  var hasFetchOf = /function\s+fetchOf\s*\(/.test(client.text);
  var readsGlobal = /global\.fetch/.test(client.text);
  var hasDoFetch = /var\s+doFetch\s*=\s*fetchOf\(\)/.test(client.text);
  var callsDoFetch = /doFetch\s*\(/.test(client.text);
  var injectable = /fetchImpl/.test(client.text);

  lines.push('fetchOf() 定义: ' + (hasFetchOf ? '有' : '无'));
  lines.push('动态读 global.fetch: ' + (readsGlobal ? '有（每次调用都重新读 → 页面层覆盖 window.fetch 可拦截）' : '无'));
  lines.push('doFetch = fetchOf(): ' + (hasDoFetch ? '有' : '无'));
  lines.push('doFetch(...) 调用点: ' + (callsDoFetch ? '有' : '无'));
  lines.push('fetchImpl 注入口: ' + (injectable ? '有（架构 §13.1）' : '无'));

  var pass = hasFetchOf && readsGlobal && hasDoFetch && callsDoFetch;
  if (!readsGlobal) {
    lines.push('⚠ 若改为缓存引用（const f = global.fetch），AC1 的"覆盖 window.fetch 计数"手法失效，需回归');
  }
  return { status: pass ? 'PASS' : 'FAIL', detail: lines };
}, '架构 §13.1 / §13.3 第 2 问（恒真判据）');

/* ============================================================================
   S3 · Key 命名空间（架构 §13.4 ③）
   ============================================================================ */

check('S3', "Key 命名空间：xzb.ai.v1 仅出现在 ai-store 与 index.html 的 clearPrefs", function () {
  var hits = scan(appScope(), /xzb\.ai\.v1/g);
  var lines = [];
  var violations = [];

  hits.forEach(function (h) {
    if (h.file === 'js/modules/ai-store.js') { return; } // 模块自己持有 KEY，全类型允许
    if (h.file === 'index.html') {
      /* index.html 只允许两处：clearPrefs 里的裸 removeItem 字面量 + 说明注释 */
      var isRemoveItem = /removeItem\s*\(\s*'xzb\.ai\.v1'/.test(h.snippet) || /removeItem\(AI_KEY\)/.test(h.snippet);
      if (h.kind === 'comment' || isRemoveItem) { return; }
    }
    violations.push(h);
  });

  var removeItemHits = scan(['index.html'], /removeItem\s*\(\s*'xzb\.ai\.v1'\s*\)/g).filter(function (h) { return h.kind === 'code'; });
  var aiKeyDefs = scan(['js/modules/ai-store.js'], /KEY\s*=\s*'xzb\.ai\.v1'/g).filter(function (h) { return h.kind === 'code'; });

  lines.push('全仓命中 ' + hits.length + ' 处');
  hits.forEach(function (h) {
    lines.push('  ' + (violations.indexOf(h) >= 0 ? '✗' : '·') + ' ' + h.file + ':' + h.line + ' [' + h.kind + '] ' + h.snippet);
  });
  lines.push("index.html removeItem('xzb.ai.v1') 代码命中: " + removeItemHits.length + '（§13.4 要求恰好 1）');
  lines.push("ai-store.js KEY = 'xzb.ai.v1' 代码命中: " + aiKeyDefs.length + '（§13.4 要求恰好 1）');

  var literalEqual = removeItemHits.length > 0 && aiKeyDefs.length > 0;
  if (literalEqual) {
    lines.push('两处字面量逐字相等: 是（同一条正则匹配同一个串）');
  } else {
    lines.push('⚠ 任一处缺失 → 「清空所有数据」会漏删 Key（架构 §4.2.1）');
  }

  var pass = violations.length === 0 && removeItemHits.length === 1 && aiKeyDefs.length === 1;
  return { status: pass ? 'PASS' : 'FAIL', detail: lines };
}, '架构 §13.4 ③ / §4.2.1 / 证据表 G3');

/* ============================================================================
   S4 · open.bigmodel.cn 仅出现在注释
   ============================================================================ */

check('S4', 'open.bigmodel.cn 只允许出现在注释行（非注释=把不可用域名写进代码）', function () {
  var hits = scan(appScope(), /open\.bigmodel\.cn/g);
  var violations = hits.filter(function (h) { return h.kind !== 'comment'; });
  var lines = ['命中 ' + hits.length + ' 处'];
  hits.forEach(function (h) {
    lines.push('  ' + (h.kind === 'comment' ? '·' : '✗') + ' ' + h.file + ':' + h.line + ' [' + h.kind + '] ' + h.snippet);
  });
  if (!hits.length) { lines.push('（0 命中：该域名连注释都没有，若 PRD 要求说明 CORS 实测结论，此处应补注释）'); }
  return { status: violations.length === 0 ? 'PASS' : 'FAIL', detail: lines };
}, '架构 §4.1.1（智谱国内站未放行 CORS，只能作为反面记录）');

/* ============================================================================
   S5 · 版本三处一致
   ============================================================================ */

check('S5', '版本一致：XZB.version / CACHE_LABEL / CACHE_NAME 均为 ' + TARGET_VERSION, function () {
  var html = load('index.html');
  var sw = load('sw.js');
  var lines = [];

  /* 无条件赋值才是唯一真源（加载链最后一环）；|| '2.2.0' 只是兜底 */
  var unconditional = [];
  var re = /XZB\.version\s*=\s*'([^']+)'\s*;/g;
  var match;
  while ((match = re.exec(html.text)) !== null) {
    unconditional.push({ value: match[1], line: lineOf(html, match.index), kind: kindOf(html, match.index) });
  }
  var fallbacks = [];
  var reFallback = /XZB\.version\s*=\s*XZB\.version\s*\|\|\s*'([^']+)'/g;
  while ((match = reFallback.exec(html.text)) !== null) {
    fallbacks.push({ value: match[1], line: lineOf(html, match.index) });
  }
  var inlineUses = [];
  var reUse = /XZB\.version\s*\|\|\s*'([^']+)'/g;
  while ((match = reUse.exec(html.text)) !== null) {
    inlineUses.push({ value: match[1], line: lineOf(html, match.index) });
  }

  lines.push('XZB.version 无条件赋值: ' + unconditional.length + ' 处');
  unconditional.forEach(function (item) { lines.push('  · index.html:' + item.line + " = '" + item.value + "'"); });
  var versionOk = unconditional.length === 1 && unconditional[0].value === TARGET_VERSION;
  if (unconditional.length > 1) { lines.push('⚠ 多于 1 处无条件赋值 → 真源不唯一'); }

  var label = /var\s+CACHE_LABEL\s*=\s*'([^']+)'/.exec(sw.text);
  var name = /var\s+CACHE_NAME\s*=\s*'([^']+)'/.exec(sw.text);
  var labelVer = label ? (/v(\d+\.\d+\.\d+)/.exec(label[1]) || [])[1] : null;
  var nameVer = name ? (/v(\d+\.\d+\.\d+)/.exec(name[1]) || [])[1] : null;
  lines.push('CACHE_LABEL: ' + (label ? "'" + label[1] + "' → v" + labelVer : '未找到'));
  lines.push('CACHE_NAME : ' + (name ? "'" + name[1] + "' → v" + nameVer : '未找到'));

  if (fallbacks.length) {
    var staleFallback = fallbacks.filter(function (f) { return f.value !== TARGET_VERSION; });
    lines.push('兜底写法 XZB.version || ...: ' + fallbacks.length + ' 处' +
      (staleFallback.length ? '（值 ' + staleFallback.map(function (f) { return f.value + '@' + f.line; }).join(', ') + '）' : ''));
    if (staleFallback.length) {
      lines.push('  说明：这些是各模块的兜底默认值，非真源；但版本号写死在 5 处，将来升级仍会漂移，建议统一');
    }
  }
  if (inlineUses.length) {
    lines.push('内联兜底 (XZB.version || ...): ' + inlineUses.length + ' 处 → ' +
      inlineUses.map(function (f) { return f.value + '@' + f.line; }).join(', '));
  }

  var pass = versionOk && labelVer === TARGET_VERSION && nameVer === TARGET_VERSION;
  return { status: pass ? 'PASS' : 'FAIL', detail: lines };
}, '架构 §11（2.24.0 同步清单）/ 证据表 §0');

/* ============================================================================
   S6 · chunk 注册表
   ============================================================================ */

function splitTopLevel(text, sep) {
  var parts = [];
  var current = '';
  var depth = 0;
  var quote = null;
  for (var i = 0; i < text.length; i += 1) {
    var c = text[i];
    if (quote) {
      current += c;
      if (c === '\\') { current += text[i + 1] || ''; i += 1; continue; }
      if (c === quote) { quote = null; }
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; current += c; continue; }
    if (c === '[' || c === '{' || c === '(') { depth += 1; current += c; continue; }
    if (c === ']' || c === '}' || c === ')') { depth -= 1; current += c; continue; }
    if (c === sep && depth === 0) { parts.push(current); current = ''; continue; }
    current += c;
  }
  if (current.trim()) { parts.push(current); }
  return parts;
}

/* 从 "var X = <open>" 起做括号配平，返回内容区间（先剥注释，避免注释里的括号干扰） */
function blockAfter(source, marker, open, close) {
  var start = source.text.indexOf(marker);
  if (start < 0) { return null; }
  var from = source.text.indexOf(open, start);
  if (from < 0) { return null; }
  var depth = 0;
  var i = from;
  while (i < source.text.length) {
    var c = source.text[i];
    if (source.mask[i] === 1) { i += 1; continue; }          // 注释整段跳过
    if (source.mask[i] === 2) { i += 1; continue; }          // 字符串内容也是照写，但括号在串里不影响配平
    if (c === open) { depth += 1; }
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        return { from: from, to: i + 1, text: source.text.slice(from, i + 1) };
      }
    }
    i += 1;
  }
  return null;
}

check('S6', 'chunk 注册：ROWS 键集 == DEPS 键集，每 chunk 恰 1 个 text/xzb-module 声明', function () {
  var html = load('index.html');
  var lines = [];

  var rowsBlock = blockAfter(html, 'var ROWS = ', '[', ']');
  var depsBlock = blockAfter(html, 'var DEPS = ', '{', '}');
  if (!rowsBlock) { return { status: 'FAIL', detail: ['index.html 内找不到 `var ROWS = [`（chunk 清单真源）'] }; }
  if (!depsBlock) { return { status: 'FAIL', detail: ['index.html 内找不到 `var DEPS = {`'] }; }

  var rows = [];
  var reRow = /\['([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\]/g;
  var m;
  while ((m = reRow.exec(rowsBlock.text)) !== null) {
    rows.push({ key: m[1], src: m[2], out: m[3] });
  }

  var deps = {};
  var depsBody = depsBlock.text.slice(1, -1);
  splitTopLevel(depsBody, ',').forEach(function (entry) {
    var match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*\[([\s\S]*)\]/.exec(entry);
    if (!match) { return; }
    var key = match[1] || match[2] || match[3];
    var inner = match[4] || '';
    var list = [];
    var reDep = /'([^']+)'|"([^"]+)"/g;
    var dm;
    while ((dm = reDep.exec(inner)) !== null) { list.push(dm[1] || dm[2]); }
    deps[key] = list;
  });

  lines.push('ROWS: ' + rows.length + ' 个 chunk；DEPS: ' + Object.keys(deps).length + ' 个键');

  /* ① 键集相等 */
  var rowKeys = rows.map(function (r) { return r.key; }).sort();
  var depKeys = Object.keys(deps).sort();
  var missingInDeps = rowKeys.filter(function (k) { return depKeys.indexOf(k) < 0; });
  var extraInDeps = depKeys.filter(function (k) { return rowKeys.indexOf(k) < 0; });
  var keySetOk = missingInDeps.length === 0 && extraInDeps.length === 0;
  lines.push('① 键集相等: ' + (keySetOk ? '是' : '否') +
    (missingInDeps.length ? '  缺 DEPS: ' + missingInDeps.join(',') : '') +
    (extraInDeps.length ? '  多 DEPS: ' + extraInDeps.join(',') : ''));

  /* ② deps 引用都存在 */
  var dangling = [];
  Object.keys(deps).forEach(function (key) {
    deps[key].forEach(function (dep) {
      if (rowKeys.indexOf(dep) < 0) { dangling.push(key + ' → ' + dep); }
    });
  });
  lines.push('② deps 引用存在: ' + (dangling.length === 0 ? '是' : '否 ' + dangling.join('; ')));

  /* ③ 每个 chunk 恰有 1 个 text/xzb-module 声明，且 src 与 ROWS.out 一致 */
  var declarations = {};
  var tagRe = /<script\b[^>]*>/g;
  var tagMatch;
  while ((tagMatch = tagRe.exec(html.text)) !== null) {
    var tag = tagMatch[0];
    if (tag.indexOf('text/xzb-module') < 0) { continue; }
    var chunkMatch = /data-xzb-chunk=["']([^"']+)["']/.exec(tag);
    var srcMatch = /src=["']([^"']+)["']/.exec(tag);
    if (!chunkMatch) { continue; }
    var key = chunkMatch[1];
    declarations[key] = declarations[key] || [];
    declarations[key].push({ src: srcMatch ? srcMatch[1] : null, line: lineOf(html, tagMatch.index) });
  }

  var declProblems = [];
  rows.forEach(function (row) {
    var found = declarations[row.key] || [];
    if (found.length !== 1) {
      declProblems.push(row.key + ' 声明数 ' + found.length + '（应恰 1）');
      return;
    }
    var expected = 'js/' + row.out + '.js';
    if (found[0].src !== expected) {
      declProblems.push(row.key + ' src=' + found[0].src + '，ROWS.out 推出应为 ' + expected);
    }
  });
  var unknownDecl = Object.keys(declarations).filter(function (k) { return rowKeys.indexOf(k) < 0; });
  if (unknownDecl.length) { declProblems.push('未在 ROWS 登记的声明: ' + unknownDecl.join(',')); }
  var totalDecl = 0;
  Object.keys(declarations).forEach(function (k) { totalDecl += declarations[k].length; });
  lines.push('③ 声明标签: ' + totalDecl + ' 个（ROWS ' + rows.length + ' 个）' +
    (declProblems.length ? '  问题: ' + declProblems.join('; ') : ''));

  /* ④ 产物文件真实存在 */
  var missingFiles = [];
  rows.forEach(function (row) {
    if (!fs.existsSync(path.join(ROOT, 'js', row.out + '.js'))) { missingFiles.push('js/' + row.out + '.js'); }
  });
  lines.push('④ 产物存在: ' + (missingFiles.length === 0 ? '是' : '缺 ' + missingFiles.join(', ')));

  /* ⑤ AI 三件套必须注册（PRD 阻断项） */
  var aiKeys = ['ai-store', 'ai-client', 'ai-enhance'];
  var aiMissing = aiKeys.filter(function (k) { return rowKeys.indexOf(k) < 0; });
  var aiNotDeclared = aiKeys.filter(function (k) { return !(declarations[k] && declarations[k].length === 1); });
  lines.push('⑤ AI 三件套注册: ' + (aiMissing.length === 0 && aiNotDeclared.length === 0 ? '是' : '否'));
  if (aiMissing.length) { lines.push('    缺 ROWS: ' + aiMissing.join(',')); }
  if (aiNotDeclared.length) { lines.push('    缺声明标签: ' + aiNotDeclared.join(',')); }

  var pass = keySetOk && dangling.length === 0 && declProblems.length === 0 && missingFiles.length === 0;
  return { status: pass ? 'PASS' : 'FAIL', detail: lines };
}, 'CONTRACT §2.5/B1′/B2 · 架构 §2.1');

/* ============================================================================
   S7 · 禁用文案（证据表 §3.7）
   ============================================================================ */

check('S7', '禁用文案：旧串/禁用词 0 命中；黑名单项只允许出现在 bannedCopy 内', function () {
  var html = load('index.html');
  var lines = [];

  /* bannedCopy 数组区间：落在区间内的命中是黑名单成员本身，合法 */
  var bannedRange = null;
  var bannedMatch = /var\s+bannedCopy\s*=\s*Object\.freeze\(\s*\[/.exec(html.text);
  if (bannedMatch) {
    var open = html.text.indexOf('[', bannedMatch.index);
    var depth = 0;
    for (var i = open; i < html.text.length; i += 1) {
      if (html.mask[i] === 1) { continue; }
      if (html.text[i] === '[') { depth += 1; }
      else if (html.text[i] === ']') {
        depth -= 1;
        if (depth === 0) { bannedRange = { from: open, to: i + 1, text: html.text.slice(open, i + 1) }; break; }
      }
    }
  }
  if (!bannedRange) { lines.push('⚠ 找不到 bannedCopy 数组（§3.7 要求其存在且长度 = 10 + 2）'); }

  /* §3.7「禁用词」与「旧串」——这两组出现在任何位置都是违规 */
  var HARD_BANNED = ['不消耗额度', 'Key 只在', '谁也拿不到'];
  var OLD_COPY = ['不上传任何内容', '数据不出手机', '文字解析与账目保存在本机'];

  /* 黑名单成员：允许出现在 bannedCopy 内，也允许出现在注释里（说明性引用），其它位置违规 */
  var BLACKLIST_MEMBERS = ['已加密', '完全安全', '绝对安全', '数据已加密', '隐私已保护', '银行级', '账本已锁定'];

  function classify(phrase) {
    var hits = scan(appScope(), new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    var out = { phrase: phrase, allowedInBlacklist: [], violations: [] };
    hits.forEach(function (h) {
      var insideBanned = !!(bannedRange && h.file === 'index.html' && h.index >= bannedRange.from && h.index < bannedRange.to);
      if (insideBanned || h.kind === 'comment') {
        out.allowedInBlacklist.push(h);
      } else {
        out.violations.push(h);
      }
    });
    return out;
  }

  var groups = [
    { name: '禁用词（§3.7，任何位置均违规）', phrases: HARD_BANNED, strict: true },
    { name: '旧串（§3.7 判定原文案已修订）', phrases: OLD_COPY, strict: true },
    { name: '黑名单成员（仅 bannedCopy 内合法）', phrases: BLACKLIST_MEMBERS, strict: false }
  ];

  var totalViolations = 0;
  groups.forEach(function (group) {
    var groupViolations = 0;
    var groupAllowed = 0;
    lines.push(group.name + ':');
    group.phrases.forEach(function (phrase) {
      var result = classify(phrase);
      groupViolations += result.violations.length;
      groupAllowed += result.allowedInBlacklist.length;
      var mark = result.violations.length ? '✗' : (result.allowedInBlacklist.length ? '·' : '✓');
      lines.push('  ' + mark + ' 「' + phrase + '」 违规 ' + result.violations.length + ' / 允许区 ' + result.allowedInBlacklist.length);
      result.violations.slice(0, 6).forEach(function (h) {
        lines.push('      ' + h.file + ':' + h.line + ' → ' + h.snippet);
      });
    });
    if (group.strict) { totalViolations += groupViolations; }
    else if (groupViolations) { totalViolations += groupViolations; }
  });

  /* bannedCopy 结构：长度与"拼接写法"（§3.7：源码中不得出现完整字面量） */
  if (bannedRange) {
    var items = splitTopLevel(bannedRange.text.slice(1, -1), ',');
    lines.push('bannedCopy: ' + items.length + ' 项（§3.7 期望 10 + 2 = 12）');
    var singleLiteral = items.filter(function (item) { return item.indexOf('+') < 0; });
    if (singleLiteral.length) {
      lines.push('  ⚠ 未用拼接写法的项（源码会留下完整字面量）: ' + singleLiteral.map(function (s) { return s.trim(); }).join(', '));
    } else {
      lines.push('  拼接写法: 全部满足（源码中无完整字面量）');
    }
    if (items.length !== 12) {
      lines.push('  ⚠ 当前 ' + items.length + ' 项，§3.7 要求 12 项（T06 待补 2 项）');
    }
  }

  return { status: totalViolations === 0 ? 'PASS' : 'FAIL', detail: lines };
}, '证据表 §3.7（AC15）');

/* ============================================================================
   S8 · app.commit / doConfirm 只允许在注释里（架构 §13.4 ②）
   ============================================================================ */

check('S8', 'ai 模块不得触碰 app.commit / doConfirm（§13.4 ②：只允许出现在注释）', function () {
  var aiFiles = ['js/modules/ai-store.js', 'js/modules/ai-client.js', 'js/modules/ai-enhance.js'];
  var hits = scan(aiFiles, /app\.commit|doConfirm\(/g);
  var violations = hits.filter(function (h) { return h.kind !== 'comment'; });
  var lines = ['作用域：js/modules/ai-*.js（3 个文件）', '命中 ' + hits.length + ' 处'];
  hits.forEach(function (h) {
    lines.push('  ' + (h.kind === 'comment' ? '·' : '✗') + ' ' + h.file + ':' + h.line + ' [' + h.kind + '] ' + h.snippet);
  });
  if (!hits.length) { lines.push('  0 命中 → ai 层完全没有写入能力，满足"AI 不直接写库"（架构 §6.3）'); }

  /* 附：全仓分布，仅供人工确认，不参与判定（§13.4 已把作用域收窄到 ai-*.js） */
  var repoHits = scan(appScope(), /app\.commit/g);
  var byFile = {};
  repoHits.forEach(function (h) { byFile[h.file] = (byFile[h.file] || 0) + 1; });
  lines.push('附·全仓 app.commit 分布（不判 FAIL）: ' + Object.keys(byFile).sort().map(function (f) {
    return f + '×' + byFile[f];
  }).join(', '));
  return { status: violations.length === 0 ? 'PASS' : 'FAIL', detail: lines };
}, '架构 §13.4 ② / §6.3');

/* ============================================================================
   S9 · 证据表 §1 的 G1–G3 前置校验（INFO）
   ============================================================================ */

check('S9', '证据表 G1–G3 前置校验（G2 期望值已失真，降级为 INFO）', function () {
  var scope = appScope();
  var lines = [];

  var g1 = scan(scope, /fetch\(/g);
  lines.push('G1 grep -rn "fetch(" → ' + g1.length + ' 处（期望 0）' + (g1.length === 0 ? '  ✓' : '  ✗'));
  g1.slice(0, 5).forEach(function (h) { lines.push('    ' + h.file + ':' + h.line + ' ' + h.snippet); });

  var g2Files = {};
  scope.forEach(function (rel) {
    var source = load(rel);
    if (source.missing) { return; }
    if (source.text.indexOf('fetch') >= 0) { g2Files[rel] = true; }
  });
  var g2List = Object.keys(g2Files).sort();
  var expectedG2 = ['js/modules/ai-client.js', 'js/modules/ai-store.js'];
  lines.push('G2 grep -rln "fetch" → ' + g2List.length + ' 个文件');
  g2List.forEach(function (f) {
    var flag = expectedG2.indexOf(f) >= 0 ? '（文档期望内）' : '（文档未列）';
    lines.push('    ' + f + ' ' + flag);
  });
  if (g2List.length !== expectedG2.length) {
    lines.push('    ⚠ 文档写"仅 ai-client.js、ai-store.js 两个文件"，实际多出：' +
      g2List.filter(function (f) { return expectedG2.indexOf(f) < 0; }).join(', '));
    lines.push('      原因：ai-enhance.js 的 `probeInfo().fetch` 是**能力探测字段名**，不是网络调用；');
    lines.push('      这正是只按字面 grep 会误判的例子 → 判定以 S1 的宽模式 + 代码区分类为准，G2 不建议进 CI。');
  }

  var g3 = scan(scope, /xzb\.ai\.v1/g).filter(function (h) { return h.kind === 'code'; });
  var g3Files = {};
  g3.forEach(function (h) { g3Files[h.file] = true; });
  lines.push('G3 xzb.ai.v1 代码区命中 ' + g3.length + ' 处，落在 ' + Object.keys(g3Files).join(', ') +
    '（期望仅 ai-store.js + index.html 的 clearPrefs；细判见 S3）');

  return { status: 'INFO', detail: lines };
}, '证据表 §1 开工前置校验');

/* ============================================================================
   执行与输出
   ============================================================================ */

function pad(text, width) {
  var str = String(text);
  var visual = 0;
  for (var i = 0; i < str.length; i += 1) { visual += str.charCodeAt(i) > 0x2E80 ? 2 : 1; }
  return str + new Array(Math.max(1, width - visual + 1)).join(' ');
}

async function main() {
  var selected = ONLY.length ? CHECKS.filter(function (c) { return ONLY.indexOf(c.id) >= 0; }) : CHECKS;
  var results = [];

  for (var i = 0; i < selected.length; i += 1) {
    var item = selected[i];
    var started = Date.now();
    var result;
    try {
      result = await item.run();
    } catch (error) {
      result = { status: 'FAIL', detail: ['检查自身抛错：' + (error && error.message), (error && error.stack || '').split('\n').slice(0, 4).join('\n')] };
    }
    results.push({
      id: item.id,
      title: item.title,
      ref: item.ref,
      status: result.status,
      detail: result.detail || [],
      ms: Date.now() - started
    });
  }

  var summary = { PASS: 0, FAIL: 0, INFO: 0 };
  results.forEach(function (r) { summary[r.status] = (summary[r.status] || 0) + 1; });

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ root: ROOT, targetVersion: TARGET_VERSION, summary: summary, results: results }, null, 2) + '\n');
  } else {
    process.stdout.write('# 静态校验 · 小账本 AI 助手升级 · root=' + ROOT + '\n');
    process.stdout.write('# 只读：不修改 js/**、index.html、sw.js\n\n');
    results.forEach(function (r) {
      var tag = r.status === 'PASS' ? '[PASS]' : (r.status === 'FAIL' ? '[FAIL]' : '[INFO]');
      process.stdout.write(tag + ' ' + pad(r.id, 4) + r.title + '\n');
      if (r.ref) { process.stdout.write('       ' + r.ref + '\n'); }
      r.detail.forEach(function (line) {
        process.stdout.write('       ' + line + '\n');
      });
      process.stdout.write('\n');
    });
    process.stdout.write('== 汇总 ==  ' + results.length + ' 项 · PASS ' + summary.PASS + ' / FAIL ' + summary.FAIL +
      ' / INFO ' + summary.INFO + '\n');
    if (summary.FAIL) {
      process.stdout.write('    FAIL: ' + results.filter(function (r) { return r.status === 'FAIL'; }).map(function (r) { return r.id; }).join(', ') + '\n');
      process.stdout.write('    提醒：实现收尾期（D1–D18 / T05-T06 未完成）出现 FAIL 属预期，本轮工具只负责把判据固化下来。\n');
    }
  }

  if (summary.FAIL && !SOFT) { process.exitCode = 1; }
}

main().catch(function (error) {
  process.stderr.write('[verify-static] 崩溃：' + (error && error.stack || error) + '\n');
  process.exitCode = 2;
});
