#!/usr/bin/env node
/**
 * Read-only parity audit: original deployed GitHub Pages vs original GitHub
 * master vs currently deployed V2 Cloudflare Pages.
 *
 * Catches runtime build drift hidden by identical Git tree hashes. This script
 * never fetches browser user data and never alters any website or Git ref.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
const official="https://rancherjie.github.io/noname_xingbei/";
const v2=process.env.V2_AUDIT_BASE_URL||"https://feature-image-preload-cache.xingbei-play.pages.dev/";
const pinned=JSON.parse(readFileSync("ops/v2-sync-state.json","utf8")).upstream.sha;
const upstream="/tmp/v2-original-source";
const allow=new Set([".js",".mjs",".css",".html",".json",".vue",".ts"]);
const sha=x=>createHash("sha256").update(x).digest("hex");
const tree=execFileSync("git",["-C",upstream,"ls-tree","-r","--name-only","HEAD"],{encoding:"utf8"}).trim().split("\n");
const paths=tree.filter(x=>allow.has(extname(x)) && !x.startsWith(".github/"));
const sourceSha=execFileSync("git",["-C",upstream,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
if(sourceSha!==pinned)throw new Error("unapproved source revision "+sourceSha);
const sentinel=Math.floor(Date.now()/1000);
async function get(origin,path){
 let err;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const signal=AbortSignal.timeout(25000);
   const response=await fetch(origin+path+"?v2_original_parity="+sentinel,{cache:"no-store",signal,headers:{"accept":"*/*"}});
   if(response.status!==200)return {status:response.status,hash:null,bytes:0};
   const bytes=Buffer.from(await response.arrayBuffer());
   return {status:200,hash:sha(bytes),bytes:bytes.length,source:bytes};
  }catch(e){err=e;}
 }
 return {status:"error",error:String(err),hash:null,bytes:0};
}
let pos=0;
const result=new Array(paths.length);
const concurrency=10;
const jobs=Array.from({length:concurrency},async()=>{
 while(pos<paths.length){
  const index=pos++,path=paths[index];
  const local=readFileSync(join(upstream,path));
  const [pub,v2Pub]=await Promise.all([get(official,path),get(v2,path)]);
  const localHash=sha(local);
  const localV2=(()=>{try{const bytes=readFileSync(path);return sha(bytes)}catch{return null}})();
  result[index]={
   path,
   sizes:{upstream:local.length,official:pub.bytes,v2:v2Pub.bytes},
   statuses:{official:pub.status,v2:v2Pub.status},
   same:{officialV2:pub.hash!==null&&pub.hash===v2Pub.hash,
      officialOriginal:pub.hash!==null&&pub.hash===localHash,
      v2Original:v2Pub.hash!==null&&v2Pub.hash===localHash,
      v2Local:v2Pub.hash!==null&&v2Pub.hash===localV2},
   hashes:{official:pub.hash,v2:v2Pub.hash,upstream:localHash},
   fetchError:[pub.error,v2Pub.error].filter(Boolean),
   sampleDifference:pub.status===200&&v2Pub.status===200&&pub.hash!==v2Pub.hash?
      (()=>{const a=pub.source.toString("utf8").split("\n"),b=v2Pub.source.toString("utf8").split("\n");let n=0;while(n<a.length&&n<b.length&&a[n]===b[n])n++;return {line:n+1,official:(a[n]??"").slice(0,160),v2:(b[n]??"").slice(0,160)}})():null
  };
  if(index%20===0)console.log("AUDIT_PROGRESS",index,paths.length,path);
 }
});
await Promise.all(jobs);
const groups={
 officialV2:result.filter(x=>!x.same.officialV2).map(x=>x.path),
 officialOriginal:result.filter(x=>!x.same.officialOriginal).map(x=>x.path),
 v2Original:result.filter(x=>!x.same.v2Original).map(x=>x.path),
 localMismatch:result.filter(x=>!x.same.v2Local).map(x=>x.path),
 inaccessible:result.filter(x=>x.statuses.official!==200||x.statuses.v2!==200).map(x=>x.path)
};
const summary={
 date:new Date().toISOString(),sourceSha,pages:{official,v2},
 inspected:result.length,groups,
 sample:result.filter(x=>!x.same.officialV2).map(x=>({path:x.path,status:x.statuses,explanation:x.sampleDifference}))
};
mkdirSync("artifacts/v2-runtime-parity",{recursive:true});
writeFileSync("artifacts/v2-runtime-parity/report.json",JSON.stringify({summary,result},null,2));
let md="# V2 deployed public-site parity audit\n\n";
md+="Original published site: "+official+"\n\nV2 published: "+v2+"\n\nOriginal source: "+sourceSha+"\n\n";
md+="Inspected source files: "+result.length+"\n\n";
for(const [k,value]of Object.entries(groups))md+="- "+k+": "+value.length+"\n";
md+="\n## Public official <> V2 differences\n\n";
for(const x of summary.sample)md+="- \`"+x.path+"\` "+JSON.stringify(x.explanation)+"\n";
writeFileSync("artifacts/v2-runtime-parity/report.md",md);
console.log("PUBLIC_SITE_PARITY_SUMMARY",JSON.stringify({total:result.length,counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),sample:summary.sample.slice(0,70)}));
if(groups.inaccessible.length>1 || groups.inaccessible.some(p=>p!==".eslintrc.json"))throw new Error("inaccessible official runtime files: "+groups.inaccessible.join(", "));
const unexpected=groups.officialV2.filter(path=>path!=="mode/connect.js"&&path!==".eslintrc.json");
if(unexpected.length)throw new Error("published original runtime mismatch: "+unexpected.join(", "));
console.log("V2_PUBLIC_RELEASE_SOURCE_PARITY_PASS",JSON.stringify({inspected:result.length,expectedExceptions:groups.officialV2}));
