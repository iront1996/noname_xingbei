#!/usr/bin/env node
/**
 * Original Git v1.7.2 is the rule source; original *published site* is the
 * authority for its image-asset references. Fail on every non-image edit.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const upstream="27ad858dbeea5da35fc434cc226b0302792d2ba3";
const sourceFiles={
  "character/shenZiChuangLin.js":{git:"1d8db94dcf225b5e3450f3d4dca928f2c7cb3c29",published:"ec1d2c2b107276065fce5f751d1b09ad22b5b0af",changes:6},
  "character/teDian.js":{git:"d8ff657bc899450209da7e305bbee28eac0f59ad",published:"9d3f8ad83e7f202c7016b52b6a181bf2481b6c76",changes:8},
  "noname/library/element/player.js":{git:"fcab1f0e6ade49175eac2ca607deac9bfce6ec64",published:"1b7962019114832cd508aafaf8156b1e8c2f887c",changes:9}
};
const allowedMarks=new Set([
  "image/card/zhiShiWu/hong",
  "image/card/zhuanShu/yuanChu_shengHuangHuiGuangPao",
  "image/card/zhuanShu/yuanChu_shengHuangYuHui",
  "image/card/zhuanShu/tianPing_zuo",
  "image/card/zhuanShu/tianPing_you",
  "image/card/zhuanShu/luBiao"
]);
function git(...args) {return execFileSync("git",args,{encoding:"utf8",maxBuffer:16*1024*1024}).trim();}
function blob(path,ref) {return git("rev-parse",ref+":"+path);}
function show(path,ref) {return execFileSync("git",["show",ref+":"+path],{encoding:"utf8",maxBuffer:16*1024*1024});}
let overall=0;
for(const [path,expected] of Object.entries(sourceFiles)){
  assert.equal(blob(path,upstream),expected.git,"Untrusted original source "+path);
  assert.equal(blob(path,"HEAD"),expected.published,"Candidate not equal original published release "+path);
  const original=show(path,upstream);
  let n=0,candidate=original;
  if(path==="character/shenZiChuangLin.js") {
    candidate=candidate.replace(/(markimage\s*:\s*['"]image\/card\/[^'"]+)\.png(['"])/g,
      (_,start,end)=>{n++;return start+".webp"+end});
  } else if(path==="character/teDian.js") {
    candidate=candidate.replace(/(markimage\s*:\s*['"])(image\/card\/[^'"]+)\.png(['"])/g,
      (whole,start,p,end)=>{if(!allowedMarks.has(p))return whole;n++;return start+p+".webp"+end});
  } else {
    for(const [from,to,num] of [
      ["image/card/tiesuo_mark.png","image/card/tiesuo_mark.webp",1],
      ['1.png">','1.webp">',1],['2.png">','2.webp">',1],
      ["image/card/zhiShiWu/hong.png","image/card/zhiShiWu/hong.webp",3],
      ["image/card/zhiShiWu/lan.png","image/card/zhiShiWu/lan.webp",3]
    ]) {
      const matches=candidate.split(from).length-1;
      assert.equal(matches,num,"Unexpected original player image occurrences "+from);
      candidate=candidate.split(from).join(to);n+=matches;
    }
  }
  assert.equal(n,expected.changes,"Unexpected image-only overlay count "+path);
  const tracked=readFileSync(path,"utf8");
  assert.equal(tracked,candidate,"Candidate changed original character/engine logic "+path);
  overall+=n;
}
assert.equal(overall,23);
assert.equal(blob("game/update.js","HEAD"),blob("game/update.js",upstream),"Version metadata not original");
const state=JSON.parse(readFileSync("ops/v2-sync-state.json","utf8"));
assert.equal(state.upstream.sha,upstream);
console.log("V2_172_ORIGINAL_PUBLISHED_WEBP_ONLY_AND_GAMEPLAY_SOURCE_PARITY_PASS",JSON.stringify({
  files:Object.keys(sourceFiles).length,webpReferences:overall,sourceCommit:upstream,liveVersion:"1.7.2"
}));
