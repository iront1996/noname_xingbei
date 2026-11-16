#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const { chromium }=createRequire(import.meta.url)("/tmp/v2-playwright/node_modules/playwright");
const servers=[{name:"official-source",origin:"http://127.0.0.1:8766"},{name:"v2",origin:"http://127.0.0.1:8765"}];
const MODES=["xingBei","boss","connect","offlineChoose","illustration","leaderboard","tutorial"];
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
fs.mkdirSync("artifacts/v2-splash",{recursive:true});
async function capture(origin,name,style){
 const ctx=await browser.newContext({viewport:{width:1650,height:820},deviceScaleFactor:1,serviceWorkers:"block",reducedMotion:"reduce"});
 const page=await ctx.newPage();
 const errors=[];
 page.on("pageerror",e=>errors.push(e.message));
 page.on("dialog",async d=>d.accept());
 await page.route("**/game/config.js",async route=>{
   const resp=await route.fetch();
   let src=await resp.text();
   const marker='mode: "tutorial"';
   assert.equal(src.split(marker).length,2,"native config anchor changed");
   src=src.replace(marker,'mode: "connect",\n show_splash: "always",\n splash_style: "'+style+'"');
   await route.fulfill({response:resp,body:src});
 });
 const opened=await page.goto(origin+"/",{waitUntil:"domcontentloaded",timeout:45000});
 assert.equal(opened?.status(),200);
 const splash=page.locator("#splash");
 await splash.waitFor({state:"visible",timeout:65000});
 await page.waitForFunction(modes=>{
  const el=document.querySelector("#splash");
  return !!el && modes.every(mode=>el.querySelector('[link="'+mode+'"] .avatar')?.style.backgroundImage?.includes("image/splash"));
 },MODES,{timeout:60000});
 // Native mode cards reveal with original staggered transitions; compare only settled geometry.
 await page.waitForTimeout(2500);
 const snap=await page.evaluate(modes=>{
  const root=document.querySelector("#splash");
  return {style:root.dataset.splash_style,classes:root.className,cards:modes.map(mode=>{
    const el=root.querySelector('[link="'+mode+'"]');
    const rect=el.getBoundingClientRect();
    return {mode,background:el.querySelector(".avatar").style.backgroundImage,
      rect:{width:Math.round(rect.width),height:Math.round(rect.height),x:Math.round(rect.x),y:Math.round(rect.y)}};
  })};
 },MODES);
 assert.equal(snap.style,style);
 for(const card of snap.cards){
  assert.ok(card.background.includes("/image/splash/"+style+"/"),JSON.stringify(card));
  assert.ok(card.rect.width>=45 && card.rect.height>80,JSON.stringify(card));
 }
 assert.deepEqual(errors,[]);
 await splash.screenshot({path:"artifacts/v2-splash/"+name+"-"+style+".png",animations:"disabled"});
 await ctx.close();
 return snap;
}
try{
 for(const style of ["style1","style2"]){
  const original=await capture(servers[0].origin,servers[0].name,style);
  const v2=await capture(servers[1].origin,servers[1].name,style);
  const norm=x=>x.cards.map(c=>({mode:c.mode,image:c.background.split("/image/splash/").at(-1).split('"')[0],...c.rect}));
  assert.deepEqual(norm(v2),norm(original),"V2/"+style+" native splash differs from upstream");
  console.log("V2_ORIGINAL_SPLASH_PARITY_PASS",style,JSON.stringify({cards:v2.cards.length}));
 }
}finally{await browser.close();}
