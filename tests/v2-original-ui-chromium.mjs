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
 const failed=[];
 page.on("pageerror",e=>errors.push("connect: "+e.message));
 page.on("requestfailed",r=>{if(r.url().startsWith(address))failed.push(r.url());});
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
 assert.equal(info.count,641);
 assert.ok(info.sw?.endsWith("/xingbei-image-sw.js"));
 assert.equal(info.state?.version,info.version);
 assert.equal(info.state?.count,info.count);
 assert.ok(info.hasImageCache);
 assert.ok(info.wss.includes(wss));
 assert.equal(await page.locator('[aria-label="星杯傳說圖片資源準備"]').count(),0);
 assert.equal(failed.length,0,JSON.stringify(failed.slice(0,10)));
 assert.equal(errors.length,0,JSON.stringify(errors.slice(0,10)));
 console.log("V2_ORIGINAL_CONNECT_AND_PRELOAD_PASS",JSON.stringify({images:info.count,defaultHall:wss}));
 await context2.close();
} catch(error) {
 console.log("V2_ORIGINAL_UI_DIAGNOSTICS",JSON.stringify({errors:errors.slice(0,15),error:String(error)}));
 throw error;
} finally {await browser.close();}
