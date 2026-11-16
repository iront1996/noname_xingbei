#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("/tmp/v2-playwright/node_modules/playwright");
const address="http://127.0.0.1:8765";
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const context=await browser.newContext({serviceWorkers:"allow"});
const page=await context.newPage();
const errors=[],failedRequests=[];
page.on("pageerror", e=>errors.push(String(e)));
page.on("requestfailed", req=>{
 if(req.url().startsWith(address))failedRequests.push(req.url());
});
page.on("dialog", async dialog => {
 if(dialog.type()==="confirm" && /GPL|开源声明|開源聲明/.test(dialog.message()))await dialog.accept();
 else await dialog.dismiss();
});
try {
 const res=await page.goto(address+"/",{waitUntil:"domcontentloaded",timeout:60000});
 assert.equal(res?.status(),200);
 // Original first-run tutorial is intentional. Use its native Skip button (test-only browser context).
 const skipGuide=page.getByText("跳过向导",{exact:true});
 if(await skipGuide.count()) {
   await skipGuide.first().click({timeout:15000});
 }
 const splash=page.locator("#splash");
 await splash.waitFor({state:"visible",timeout:90000});
 for(const mode of ["xingBei","connect","tutorial","offlineChoose","illustration","leaderboard","boss"]) {
   assert.equal(await splash.locator('[link="'+mode+'"]').count(),1,"original mode missing: "+mode);
 }
 console.log("V2_ORIGINAL_SPLASH_PASS",JSON.stringify({modes:7}));
 await splash.locator('[link="connect"]').click();
 const wss="wss://v2-hall-direct.myxingbei.com:50000";
 const wssInput=page.locator('[contenteditable="true"]').filter({hasText:wss});
 await wssInput.waitFor({state:"visible",timeout:90000});
 await page.waitForFunction(()=>{
  const state=[...document.querySelectorAll(".menubutton")].some(n=>n.textContent?.includes("连接"));
  const label=document.body?.innerText||"";
  return state && (/输入联机地址|圖片預載/.test(label));
 },null,{timeout:90000});
 // Non-invasive: no button click and no live WSS connection.
 const state=await page.evaluate(async()=>{
  const manifest=await (await fetch("/game/preload-manifest.json",{cache:"no-store"})).json();
  const name="xingbei-image-assets-v1-"+manifest.version;
  const stateCache=await caches.open("xingbei-image-cache-state-v1");
  const row=await stateCache.match(new URL("/__xingbei-image-cache-state__",location.href).href);
  const state=row?await row.json():null;
  return {manifest,cacheName:name,cacheKeys:await caches.keys(),state,worker:navigator.serviceWorker.controller?.scriptURL};
 });
 await page.waitForFunction(async()=>{
  const keys=await caches.keys();
  const manifest=await (await fetch("/game/preload-manifest.json")).json();
  return keys.includes("xingbei-image-assets-v1-"+manifest.version);
 },null,{timeout:240000});
 const verified=await page.evaluate(async()=>{
  const manifest=await(await fetch("/game/preload-manifest.json",{cache:"no-store"})).json();
  const keys=await caches.keys();
  const cache=await caches.open("xingbei-image-cache-state-v1");
  const response=await cache.match(new URL("/__xingbei-image-cache-state__",location.href).href);
  return {count:manifest.count,version:manifest.version,cacheState:response?await response.json():null,
    active:keys.includes("xingbei-image-assets-v1-"+manifest.version),
    sw:navigator.serviceWorker.controller?.scriptURL};
 });
 assert.equal(verified.count,641);
 assert.equal(verified.cacheState?.version,verified.version);
 assert.equal(verified.cacheState?.count,641);
 assert.ok(verified.active);
 assert.ok(verified.sw?.endsWith("/xingbei-image-sw.js"));
 assert.equal(await page.locator('[aria-label="星杯傳說圖片資源準備"]').count(),0,"legacy V2 overlay appeared");
 assert.ok(errors.length===0,"browser exceptions: "+JSON.stringify(errors.slice(0,8)));
 assert.equal(failedRequests.length,0,"failed same-origin requests: "+JSON.stringify(failedRequests.slice(0,8)));
 console.log("V2_ORIGINAL_CONNECT_AND_PRELOAD_PASS",JSON.stringify({count:verified.count,defaultHall:wss,originalUI:true}));
} catch(error) {
 console.log("V2_ORIGINAL_UI_DIAGNOSTICS",JSON.stringify({
  errors:errors.slice(0,15),failedRequests:failedRequests.slice(0,15),
  body:await page.evaluate(()=>document.body?.innerText?.slice(0,1400)).catch(()=>null),
  url:page.url()
 }));
 throw error;
} finally {await context.close();await browser.close();}
