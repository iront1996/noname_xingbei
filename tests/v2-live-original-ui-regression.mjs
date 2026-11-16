#!/usr/bin/env node
/** Original-site vs V2 candidate Chromium UI, extension and cache parity. Read-only. */
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import fs from "node:fs";
import {createHash} from "node:crypto";
const {chromium}=createRequire(import.meta.url)("/tmp/v2-playwright/node_modules/playwright");
const sites=[
 {name:"official",base:"https://rancherjie.github.io/noname_xingbei/"},
 {name:"v2-candidate",base:"http://127.0.0.1:8765/"}
];
const names=["无名杯UI优化包","百年战争·序章","十周年-噩梦人机","十周年-AI优化版","宿命挽歌","创世纪","电啸龙吟","轮回遗梦","十周年语音包","峡谷幻音","永夜残响"];
const sha=x=>createHash("sha256").update(x).digest("hex");
fs.mkdirSync("artifacts/v2-live-ui",{recursive:true});
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
async function open(s){
 const ctx=await browser.newContext({viewport:{width:1650,height:850},deviceScaleFactor:1,serviceWorkers:"allow"});
 const page=await ctx.newPage();
 const errors=[],failed=[],httpErrors=[];
 page.on("pageerror",e=>errors.push(String(e)));
 page.on("requestfailed",r=>{if(r.url().startsWith(s.base))failed.push({url:r.url(),resourceType:r.resourceType(),failure:r.failure()?.errorText??null})});
 page.on("response",r=>{if(r.status()>=400&&r.url().startsWith(s.base))httpErrors.push({url:r.url(),status:r.status()})});
 page.on("dialog",d=>d.accept());
 await page.route("**/game/config.js",async route=>{
  const response=await route.fetch();
  let source=await response.text();
  assert.equal(source.split('mode: "tutorial"').length,2,"original mode startup anchor changed");
  source=source.replace('mode: "tutorial"','mode: "connect",\n show_splash: "off",\n splash_style: "style2"');
  await route.fulfill({response,body:source});
 });
 const response=await page.goto(s.base,{waitUntil:"domcontentloaded",timeout:70000});
 assert.equal(response?.status(),200,s.name+" initial HTTP");
 await page.waitForFunction(()=>[...document.querySelectorAll('[contenteditable="true"]')].some(el=>el.textContent?.length>7),null,{timeout:90000});
 await page.waitForTimeout(2200);
 const state=await page.evaluate(async names=>{
  const noname=await import(new URL("noname.js",location.href).href);
  const lib=noname.lib;
  const system=document.querySelector("#system .menubutton")??document.querySelector(".menubutton");
  const css=system?getComputedStyle(system):null;
  return {
   extensions:lib.config?.extensions??[],
   enabled:names.map(name=>({name,enabled:lib.config?.["extension_"+name+"_enable"]})),
   theme:lib.config?.theme,
   layout:lib.config?.layout,
   hasNativeMenu:!!document.querySelector(".menubutton"),
   input:[...document.querySelectorAll('[contenteditable="true"]')].map(x=>x.textContent?.trim()).filter(Boolean),
   design:css?{color:css.color,background:css.backgroundImage,border:css.borderColor,font:css.fontFamily,textShadow:css.textShadow}:null,
   splashOptions:lib.onloadSplashes?.map(x=>x.id)
  };
 },names);
 assert.ok(state.hasNativeMenu,s.name+" native menu missing");
 assert.ok(names.every(name=>state.extensions.includes(name)),s.name+" missing published extensions: "+JSON.stringify(state.extensions));
 assert.equal(state.enabled.find(x=>x.name==="无名杯UI优化包")?.enabled,true,s.name+" official UI optimization not enabled");
 assert.equal(state.enabled.find(x=>x.name==="十周年-AI优化版")?.enabled,true,s.name+" official AI extension not enabled");
 assert.ok(state.input.length>=1);
 console.log("V2_PUBLISHED_UI_STATE_"+s.name.toUpperCase().replace("-","_"),JSON.stringify(state));
 await page.screenshot({path:"artifacts/v2-live-ui/"+s.name+".png",animations:"disabled"});
 return {ctx,page,state,errors,failed,httpErrors};
}
try{
 for(const name of names){
  const path="extension/"+name+"/extension.js";
  const results=await Promise.all(sites.map(async s=>{
   const r=await fetch(s.base+path.split("/").map(encodeURIComponent).join("/"),{signal:AbortSignal.timeout(45000)});
   assert.equal(r.status,200,s.name+" missing "+path);
   return Buffer.from(await r.arrayBuffer());
  }));
  assert.equal(sha(results[0]),sha(results[1]),"official extension differs from candidate "+name);
 }
 console.log("V2_OFFICIAL_BUNDLED_EXTENSION_BYTES_PASS",names.length);
 const original=await open(sites[0]);
 const candidate=await open(sites[1]);
 const normalize=x=>({
   extensions:x.extensions.slice().sort(),
   enabled:x.enabled,
   theme:x.theme,
   layout:x.layout,
   design:x.design,
   splashOptions:x.splashOptions
 });
 assert.deepEqual(normalize(candidate.state),normalize(original.state),"native extension state or theme mismatches");
 assert.ok(candidate.state.input.some(v=>v.includes("v2-hall-direct.myxingbei.com:50000")),"V2 Hall lost");
 assert.ok(!original.state.input.some(v=>v.includes("v2-hall-direct.myxingbei.com:50000")),"original unexpectedly using V2 Hall");
 // Wait for native V2 image cache completion, without sending a HALL message.
 await candidate.page.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL?.endsWith("/xingbei-image-sw.js")===true,null,{timeout:180000});
 const cache=await candidate.page.evaluate(async()=>{
  const r=await fetch("/game/preload-manifest.json",{cache:"no-store"}),manifest=await r.json();
  const status=await caches.open("xingbei-image-cache-state-v1");
  const entry=await status.match(new URL("/__xingbei-image-cache-state__",location.href).href);
  return {count:manifest.count,version:manifest.version,keys:await caches.keys(),state:entry?await entry.json():null};
 });
 assert.equal(cache.count,875);
 assert.equal(cache.state?.count,cache.count);
 assert.equal(cache.state?.version,cache.version);
 assert.ok(cache.keys.includes("xingbei-image-assets-v1-"+cache.version));
 console.log("V2_OFFICIAL_UI_AND_PRELOAD_PARITY_PASS",JSON.stringify({extensions:names.length,images:cache.count,originalHall:original.state.input[0],v2Hall:candidate.state.input[0]}));
 console.log("V2_UI_PAGEERRORS",JSON.stringify({official:original.errors.slice(0,15),candidate:candidate.errors.slice(0,15)}));
 console.log("V2_NETWORK_DIAGNOSTICS",JSON.stringify({candidateFailed:candidate.failed.slice(0,30),candidateHTTP:candidate.httpErrors.slice(0,30),originalFailed:original.failed.slice(0,30),originalHTTP:original.httpErrors.slice(0,30)}));
 assert.equal(candidate.errors.length,0,"candidate browser errors");
 const path=url=>{const u=new URL(url);return u.pathname.replace(/^\/noname_xingbei\//,"/")+u.search};
 const sharedHttp=new Set(original.httpErrors.map(x=>path(x.url)));
 const sharedAborted=new Set(original.failed.map(x=>path(x.url)+"|"+x.resourceType+"|"+x.failure));
 const unmatchedHttp=candidate.httpErrors.filter(x=>!sharedHttp.has(path(x.url)));
 const unmatchedFailed=candidate.failed.filter(x=>!sharedAborted.has(path(x.url)+"|"+x.resourceType+"|"+x.failure));
 assert.deepEqual(unmatchedHttp,[],"candidate HTTP errors absent from official site");
 assert.deepEqual(unmatchedFailed,[],"candidate request failures absent from official site");
 await original.ctx.close();await candidate.ctx.close();
}finally{await browser.close()}
