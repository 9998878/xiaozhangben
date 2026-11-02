#!/usr/bin/env node
/* P1-3 冒烟：本地 query → 「换个说法解释」按钮 → mock 重写 → rewritten 来源标记 */
'use strict';
var path = require('path');
var driver = require(path.join(__dirname, 'cdp-driver.js'));

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

driver.withPage({ headless: true, timeoutMs: 40000 }, async function (page) {
  await page.goto('http://127.0.0.1:8099/index.html#/assistant', { timeout: 25000 });
  await sleep(1200);
  await page.eval("(function(){var st=XZB.core.aiStore;st.setActive('custom1');st.setProviderField('custom1','baseUrl','http://127.0.0.1:8100/v1');st.setProviderField('custom1','model','mock-model');st.setKey('custom1','sk-test-1234567890abcdef');st.grantConsent(st.CONSENT_VERSION);})()");
  await page.eval('location.reload()');
  await sleep(1500);

  /* 先种一笔本地能解析的账，保证 query 有 rows；'算了' 放弃草稿 */
  await page.type('.s-assistant__input', '外卖 28 微信');
  await page.click('.s-assistant__send');
  await sleep(500);
  await page.type('.s-assistant__input', '算了');
  await page.click('.s-assistant__send');
  await sleep(300);

  await page.type('.s-assistant__input', '这个月外卖花了多少');
  await page.click('.s-assistant__send');
  await sleep(700);
  var hasBtn = await page.eval("!!document.querySelector('.s-assistant__explain')");
  process.stdout.write('解释按钮出现: ' + hasBtn + '\n');
  if (!hasBtn) { return 'no-button'; }

  await page.click('.s-assistant__explain');
  await page.waitFor("(function(){return document.querySelectorAll('.s-assistant__srcnote').length > 0 || document.querySelectorAll('.s-assistant__degrade').length > 0;})()", { timeout: 20000 });
  var r = await page.eval("(function(){var note=document.querySelector('.s-assistant__srcnote');var deg=document.querySelector('.s-assistant__degrade');var texts=document.querySelectorAll('.s-assistant__text');var last=texts[texts.length-1];return JSON.stringify({srcnote:note&&note.textContent,degrade:deg&&deg.textContent.slice(0,44),last:(last&&last.textContent||'').slice(0,40)});})()");
  process.stdout.write('重写结果: ' + r + '\n');
  return 'ok';
}).then(function () { process.exit(0); }, function (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); });
