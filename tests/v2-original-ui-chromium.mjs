#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("/tmp/v2-playwright/node_modules/playwright");
const address = "http://127.0.0.1:8765";
const browser = await chromium.launch({headless:true,args:["--no-sandbox"]});
const errors=[];
try {
 const context1=await browser.newContext({serviceWorkers:"allow"});
 const original=await context1.newPage();
 original.on("dialog", d => /GPL|开源声明/.test(d.message())?d.accept():d.dismiss());
 original.on("pageerror",e=>errors.push("original: "+e.message));
 const response=await original.goto(address+"/",{waitUntil:"domcontentloaded",timeout:60000});
 assert.equal(response?.status(),200);
 await original.waitForFunction(()=>{
  const text=document.body?.innerText||"";
  return ["星杯传说","BOSS","联机","线下选角","图鉴","排行榜","新手向导"].every(label=>text.includes(label));
 },null,{timeout:90000});
 assert.equal(await original.locator('[aria-label="星杯傳說圖片資源準備"]').count(),0);
 console.log("V2_NATIVE_MODE_OPTIONS_PASS");
 await context1.close();

 // The second isolated context serves a test-only config variant selecting
 // native Connect mode, avoiding original tutorial and synthetic eventStack.
 // All actual JS, host URL, image cache and service worker files are untouched.
 const context2=await browser.newContext({serviceWorkers:"allow"});
 const page=await context2.newPage();
 const failed=[],mediaEvents=[],httpErrors=[];
 page.on("pageerror",e=>errors.push("connect: "+e.message));
 const isBgm=url=>url.includes("/audio/background/music_default.mp3");
 page.on("request",r=>{if(isBgm(r.url()))mediaEvents.push({event:"request",url:r.url(),type:r.resourceType(),method:r.method()});});
 page.on("response",r=>{
  if(isBgm(r.url()))mediaEvents.push({event:"response",url:r.url(),status:r.status(),type:r.request().resourceType(),headers:r.headers()});
  if(r.url().startsWith(address)&&r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});
 });
 page.on("requestfinished",r=>{if(isBgm(r.url()))mediaEvents.push({event:"finished",url:r.url(),type:r.resourceType()});});
 page.on("requestfailed",r=>{
  if(r.url().startsWith(address)){
   const entry={url:r.url(),type:r.resourceType(),method:r.method(),failure:r.failure()?.errorText??null};
   failed.push(entry);
   if(isBgm(r.url()))mediaEvents.push({event:"failed",...entry});
  }
 });
 page.on("dialog",d=>/GPL|开源声明/.test(d.message())?d.accept():d.dismiss());
 await page.route("**/game/config.js",async route=>{
  const source=await route.fetch();
  const body=await source.text();
  assert.ok(body.includes('mode: "tutorial"'),"unknown upstream game config anchor");
  await route.fulfill({response:source,body:body.replace('mode: "tutorial"','mode: "connect",\n\tshow_splash: "off"')});
 });
 const opened=await page.goto(address+"/",{waitUntil:"domcontentloaded",timeout:60000});
 assert.equal(opened?.status(),200);
 const wss="wss://v2-hall-direct.myxingbei.com:50000";
 await page.waitForFunction(async expected=>{const {lib}=await import("/noname.js");return lib.hallURL===expected;},wss,{timeout:10000});
 console.log("V2_ORIGINAL_HALL_SETTINGS_DEFAULT_PASS");
 await page.waitForFunction(wss=>[...document.querySelectorAll('[contenteditable="true"]')].some(n=>n.textContent?.trim()===wss),wss,{timeout:90000});
 console.log("V2_NATIVE_CONNECT_DEFAULT_HALL_PASS");
 await page.waitForFunction(
   () => navigator.serviceWorker.controller?.scriptURL?.endsWith("/xingbei-image-sw.js") === true,
   null,{timeout:240000}
 );
 const info=await page.evaluate(async()=>{
  const manifest=await(await fetch("/game/preload-manifest.json",{cache:"no-store"})).json();
  const names=await caches.keys();
  const statusCache=await caches.open("xingbei-image-cache-state-v1");
  const result=await statusCache.match(new URL("/__xingbei-image-cache-state__",location.href).href);
  return {count:manifest.count,version:manifest.version,sw:navigator.serviceWorker.controller?.scriptURL,
     state:result?await result.json():null,hasImageCache:names.includes("xingbei-image-assets-v1-"+manifest.version),
     wss:[...document.querySelectorAll('[contenteditable="true"]')].map(x=>x.textContent?.trim())};
 });
 console.log("V2_BROWSER_CACHE_STATUS",JSON.stringify(info));
 assert.ok(info.count > 0 && Number.isInteger(info.count));
 assert.ok(info.sw?.endsWith("/xingbei-image-sw.js"));
 assert.equal(info.state?.version,info.version);
 assert.equal(info.state?.count,info.count);
 assert.ok(info.hasImageCache);
 assert.ok(info.wss.includes(wss));
 assert.equal(await page.locator('[aria-label="星杯傳說圖片資源準備"]').count(),0);
 // Probe the exact audio bytes and MIME from the same local server before
 // deciding if a media request failure indicates a missing or broken asset.
 const bgm=await page.evaluate(async()=>{
  const res=await fetch("/audio/background/music_default.mp3",{cache:"no-store"});
  const bytes=await res.arrayBuffer();
  const audio=document.createElement("audio");
  return {status:res.status,size:bytes.byteLength,contentType:res.headers.get("content-type"),
   acceptRanges:res.headers.get("accept-ranges"),canPlayMp3:audio.canPlayType("audio/mpeg"),
   elements:[...document.querySelectorAll("audio")].map(e=>({src:e.currentSrc||e.src,readyState:e.readyState,
     networkState:e.networkState,paused:e.paused,error:e.error?.code??null}))};
 });
 console.log("V2_BGM_NETWORK_DIAGNOSTICS",JSON.stringify({bgm,mediaEvents,failed,httpErrors}));
 assert.equal(bgm.status,200,"local original background music must be served by HTTP");
 assert.ok(bgm.size>1024,"original background music must have nonempty MP3 bytes");
 assert.ok(bgm.canPlayMp3,"Chromium must support the original MP3 codec");
 assert.equal(failed.length,0,JSON.stringify(failed.slice(0,10)));
 assert.equal(errors.length,0,JSON.stringify(errors.slice(0,10)));
 console.log("V2_ORIGINAL_CONNECT_AND_PRELOAD_PASS",JSON.stringify({images:info.count,defaultHall:wss}));
 await context2.close();
} catch(error) {
 console.log("V2_ORIGINAL_UI_DIAGNOSTICS",JSON.stringify({errors:errors.slice(0,15),error:String(error)}));
 throw error;
} finally {await browser.close();}
