#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('/tmp/v2-playwright/node_modules/playwright');
const host='http://127.0.0.1:8765';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({serviceWorkers:'allow'});
const page=await context.newPage();
page.on('dialog', async dialog => { await dialog.accept(); });
const errors=[],badRequests=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('requestfailed',r=>{if(r.url().startsWith(host))badRequests.push(r.url());});
try {
  const response=await page.goto(host+'/',{waitUntil:'domcontentloaded',timeout:45000});
  assert.equal(response?.status(),200);
  await page.waitForFunction(()=>window.noname_update?.version==='1.7.1');
  try {
    await page.waitForFunction(()=>[...document.querySelectorAll('[contenteditable="true"]')].some(n=>n.textContent?.includes('wss://v2-hall-direct.myxingbei.com:50000')),null,{timeout:90000});
    await page.waitForFunction(()=>document.body?.innerText?.includes('圖片準備完成，請按「連接」'),null,{timeout:180000});
  } catch(error) {
    console.log('CHROMIUM_UI_DIAGNOSTIC',JSON.stringify(await page.evaluate(()=>({body:document.body?.innerText?.slice(0,2500),documentState:document.readyState,contentEditable:[...document.querySelectorAll('[contenteditable]')].map(x=>x.textContent?.slice(0,150))}))));
    console.log('CHROMIUM_INIT_ERRORS',JSON.stringify(errors.slice(0,30)),JSON.stringify(badRequests.slice(0,15)));
    throw error;
  }
  const m=await page.evaluate(async()=>{
    const r=await fetch('/game/preload-manifest.json',{cache:'no-store'});
    if(!r.ok)throw new Error('manifest missing');
    return {manifest:await r.json(),version:window.noname_update.version,assetCount:window.noname_asset_list?.length??null};
  });
  assert.equal(m.version,'1.7.1'); assert.equal(m.manifest.count,641);
  for(const name of ['image/character/daZuiSiJiao.jpg','image/character/guShenJiSi.jpg','image/card/zhuanShu/jiLeMengJing.png']){
    const record=m.manifest.assets.find(x=>x.path===name);assert.ok(record);
    const result=await page.evaluate(async name=>{
      const r=await fetch('/'+name,{cache:'no-store'});
      const buffer=await r.arrayBuffer();
      const img=await createImageBitmap(new Blob([buffer],{type:r.headers.get('content-type')||'image/png'}));
      return {status:r.status,bytes:buffer.byteLength,width:img.width,height:img.height};
    },name);
    assert.equal(result.status,200);assert.equal(result.bytes,record.bytes);assert.ok(result.width>0&&result.height>0);
  }
  console.log('CHROMIUM_BOOT_AND_NEW_ASSETS_PASS',JSON.stringify({version:m.version,assets:m.manifest.count,assetList:m.assetCount}));
  await page.evaluate(async version=>{
    // Recreate an old-only browser cache, without changing any real player's storage.
    await caches.delete('xingbei-image-assets-v1-'+version);
    await caches.delete('xingbei-image-cache-state-v1');
    const old=await caches.open('xingbei-image-assets-v1-'+ '0'.repeat(40)+'-'+ '0'.repeat(40));
    const url=new URL('/image/character/daZuiSiJiao.jpg',location.href).href;
    await old.put(url,await fetch(url,{cache:'no-store'}));
  },m.manifest.version);
  const up=await page.evaluate(async()=>{
    const {prepareImageAssets,ensureImageCacheWorker}=await import('/game/preload-images.mjs');
    const summary=await prepareImageAssets();
    await ensureImageCacheWorker(summary.version);
    const cache=await caches.open('xingbei-image-cache-state-v1');
    const row=await cache.match(new URL('/__xingbei-image-cache-state__',location.href).href);
    const state=row?await row.json():null;
    return {summary,state,keys:await caches.keys(),sw:navigator.serviceWorker.controller?.scriptURL};
  });
  assert.equal(up.summary.total,641);assert.ok(up.summary.cached>=1);
  assert.equal(up.summary.cached+up.summary.downloaded,641);
  assert.equal(up.state?.version,m.manifest.version);
  assert.ok(up.keys.includes('xingbei-image-assets-v1-'+m.manifest.version));
  assert.ok(!up.keys.some(x=>x.startsWith('xingbei-image-assets-v1-'+'0'.repeat(40))));
  assert.ok(up.sw?.endsWith('/xingbei-image-sw.js'));
  assert.equal(badRequests.length,0,JSON.stringify(badRequests.slice(0,5)));
  console.log('CHROMIUM_FULL_CACHE_UPGRADE_PASS',JSON.stringify({cached:up.summary.cached,downloaded:up.summary.downloaded}));
  console.log('CHROMIUM_PAGE_ERRORS_OBSERVED',JSON.stringify(errors.slice(0,12)));
} finally {await context.close();await browser.close();}
