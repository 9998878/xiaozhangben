#!/usr/bin/env node
/* 降级路径冒烟：401 → 消息位降级卡 + 重试按钮；连续失败 → banner */
'use strict';
var path = require('path');
var driver = require(path.join(__dirname, 'cdp-driver.js'));

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

driver.withPage({ headless: true, timeoutMs: 40000 }, async function (page) {
  await page.goto('http://127.0.0.1:8099/index.html#/assistant', { timeout: 25000 });
  await sleep(1200);

  await page.eval("(function(){var st=XZB.core.aiStore;st.setActive('custom1');st.setProviderField('custom1','baseUrl','http://127.0.0.1:8100/v1');st.setProviderField('custom1','model','mock-model');st.setKey('custom1','sk-mode-401-abcdef123456');var g=st.grantConsent(st.CONSENT_VERSION);return g.ok;})()");
  await page.eval('location.reload()');
  await sleep(1500);

  for (var i = 1; i <= 2; i++) {
    await page.type('.s-assistant__input', 'qweixiugbz 的糊涂账');
    await page.click('.s-assistant__send');
    await page.waitFor("(function(){return document.querySelectorAll('.s-assistant__degrade').length >= " + i + ";})()", { timeout: 20000 });
  }

  var r = await page.eval("(function(){var d=document.querySelector('.s-assistant__degrade');var btn=d&&d.querySelector('.s-assistant__degrade-btn');var banner=document.querySelector('.s-assistant__banner');return JSON.stringify({degrade:(d&&d.textContent||'').slice(0,50),hasRetry:!!btn,bannerShown:banner?banner.hidden===false:false,bannerText:banner&&banner.hidden===false?(banner.textContent||'').slice(0,40):''});})()");
  process.stdout.write('降级路径: ' + r + '\n');
  return 'ok';
}).then(function () { process.exit(0); }, function (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); });
