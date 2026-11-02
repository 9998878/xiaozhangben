#!/usr/bin/env node
/* 调试：设置页的 ai-store 懒加载为什么没重绘 */
'use strict';
var path = require('path');
var driver = require(path.join(__dirname, 'cdp-driver.js'));

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

driver.withPage({ headless: true, timeoutMs: 30000 }, async function (page) {
  var url = process.argv[2] || 'http://127.0.0.1:8099/index.html#/settings';
  await page.goto(url, { timeout: 25000 });
  await sleep(2500);

  var state1 = await page.eval("(function(){var o={};o.hasChunks=!!(window.XZB&&XZB.chunks);try{o.status=XZB.chunks.status('ai-store');}catch(e){o.status='ERR:'+e.message;}o.hasAiStore=!!(window.XZB&&XZB.core&&XZB.core.aiStore);o.groups=Array.prototype.map.call(document.querySelectorAll('.s-settings-group__title'),function(n){return n.textContent;});return JSON.stringify(o);})()");
  console.log('加载后状态: ' + state1);

  var ensured = await page.eval("XZB.chunks.ensure('ai-store').then(function(){return 'OK aiStore='+!!(XZB.core&&XZB.core.aiStore);},function(e){return 'ERR code='+(e&&e.code||e)+' key='+(e&&e.key);})");
  console.log('手动 ensure: ' + ensured);

  var state2 = await page.eval("(function(){var o={};o.groups=Array.prototype.map.call(document.querySelectorAll('.s-settings-group__title'),function(n){return n.textContent;});o.hasTestRow=document.body.textContent.indexOf('测试连接')>=0;o.dbg=(window.window__aiDbg||[]);return JSON.stringify(o);})()");
  console.log('ensure 后状态: ' + state2);

  var consoles = await page.eval("(function(){return JSON.stringify((window.__xzbErrors||[]).slice(0,5));})()");
  console.log('页面错误: ' + consoles);
  return 'done';
}).then(function (r) { console.log(r); process.exit(0); }, function (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); });
