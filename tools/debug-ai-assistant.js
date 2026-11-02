#!/usr/bin/env node
/* 端到端冒烟：助手屏 → mock 供应商 → 流式回答 → source=remote → 用量计数 */
'use strict';
var path = require('path');
var driver = require(path.join(__dirname, 'cdp-driver.js'));

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

driver.withPage({ headless: true, timeoutMs: 40000 }, async function (page) {
  var out = [];
  function log(t) { out.push(t); process.stdout.write(t + '\n'); }

  await page.goto('http://127.0.0.1:8099/index.html#/assistant', { timeout: 25000 });
  await sleep(1500);

  /* 1) 配置：自定义供应商指向 mock，填 Key、授权 */
  var cfg = await page.eval("(function(){var st=XZB.core.aiStore;st.setActive('custom1');st.setProviderField('custom1','baseUrl','http://127.0.0.1:8100/v1');st.setProviderField('custom1','model','mock-model');st.setKey('custom1','sk-test-1234567890abcdef');var g=st.grantConsent(st.CONSENT_VERSION);return JSON.stringify({granted:g.ok,active:st.getActive().id,hasKey:st.hasKey(),masked:st.maskedKey()});})()");
  log('配置: ' + cfg);

  /* 2) 真·重载（同 URL 的 goto 不会触发导航），让助手屏按已授权状态渲染 */
  await page.eval('location.reload()');
  await sleep(1800);
  var chrome = await page.eval("(function(){var sub=document.querySelector('.s-assistant__subtitle');var foot=document.querySelector('.s-assistant__privacy');var stop=document.querySelector('.s-assistant__stop');var o={sub:sub&&sub.textContent,foot:(foot&&foot.textContent||'').slice(0,30),stopHidden:stop?stop.hidden:'none'};try{o.enhStatus=XZB.chunks.status('ai-enhance');o.hasEnh=!!(XZB.core&&XZB.core.aiEnhance);o.ready=JSON.stringify(XZB.core.aiEnhance.ready(null));}catch(e){o.err=String(e&&e.message||e);}return JSON.stringify(o);})()");
  log('助手屏外观: ' + chrome);

  /* 3) 本地能懂的问法（不触云端）→ 放弃草稿 → 本地听不懂的问法（触云端） */
  await page.type('.s-assistant__input', '外卖 28 微信');
  await page.click('.s-assistant__send');
  await sleep(600);
  var local = await page.eval("(function(){var rows=document.querySelectorAll('.s-assistant__row');var last=rows[rows.length-1];return JSON.stringify({kind:'local',text:(last&&last.textContent||'').slice(0,40),srcnote:document.querySelectorAll('.s-assistant__srcnote').length});})()");
  log('本地记账: ' + local);

  await page.type('.s-assistant__input', '算了');
  await page.click('.s-assistant__send');
  await sleep(400);

  await page.type('.s-assistant__input', 'asdkjhzxc 这是什么');
  await page.click('.s-assistant__send');
  await sleep(800);
  var diag = await page.eval("(function(){var o={};try{o.ready=JSON.stringify(XZB.core.aiEnhance.ready(null));}catch(e){o.readyErr=String(e&&e.message||e);}var texts=document.querySelectorAll('.s-assistant__text');o.lastText=(texts[texts.length-1]&&texts[texts.length-1].textContent||'').slice(0,40);o.think=!!document.querySelector('.s-assistant__aithink');o.stopHidden=(document.querySelector('.s-assistant__stop')||{}).hidden;return JSON.stringify(o);})()");
  log('发送后诊断: ' + diag);
  var streaming = await page.eval("(function(){var stop=document.querySelector('.s-assistant__stop');var think=document.querySelector('.s-assistant__aithink');return JSON.stringify({stopHidden:stop?stop.hidden:'none',think:think?think.textContent:null});})()");
  log('生成中: ' + streaming);

  await page.waitFor("(function(){return document.querySelectorAll('.s-assistant__srcnote').length > 0 || document.querySelectorAll('.s-assistant__degrade').length > 0;})()", { timeout: 20000 });
  var final1 = await page.eval("(function(){var note=document.querySelector('.s-assistant__srcnote');var deg=document.querySelector('.s-assistant__degrade');var texts=document.querySelectorAll('.s-assistant__text');var last=texts[texts.length-1];return JSON.stringify({srcnote:note&&note.textContent,degrade:deg&&deg.textContent.slice(0,30),last:(last&&last.textContent||'').slice(0,50)});})()");
  log('云端结果: ' + final1);

  /* 4) 停止键路径：问一个会流式较久的问题再点停止 */
  await page.type('.s-assistant__input', '再解释一下上个 vívoj 支出');
  await page.click('.s-assistant__send');
  await sleep(250);
  var stopBtn = await page.eval("(function(){var s=document.querySelector('.s-assistant__stop');if(s&&s.hidden===false){s.click();return 'clicked';}return 'not-visible';})()");
  await sleep(1200);
  var afterStop = await page.eval("(function(){var texts=document.querySelectorAll('.s-assistant__text');var last=texts[texts.length-1];return JSON.stringify({last:(last&&last.textContent||'').slice(0,60),stopHidden:(document.querySelector('.s-assistant__stop')||{}).hidden});})()");
  log('停止(' + stopBtn + '): ' + afterStop);

  /* 5) 用量 */
  var usage = await page.eval("(function(){var u=XZB.core.aiStore.usage();return JSON.stringify({count:u.count,ok:u.ok,fail:u.fail});})()");
  log('用量: ' + usage);

  return out.join('\n');
}).then(function (r) { process.exit(0); }, function (e) { console.error('FAIL ' + (e && e.message || e)); process.exit(1); });
