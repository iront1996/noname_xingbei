#!/usr/bin/env node
/** Read-only complete original published source/extension drift inventory. */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const manifest=JSON.parse(readFileSync("ops/v2-official-publication.json","utf8"));
const entries=manifest.publishedTextOverlays.map(path=>({path,required:true}));
for(const name of manifest.bundledExtensions){
 for(const file of ["extension.js","info.json","package.js"]){
  entries.push({path:"extension/"+name+"/"+file,required:file==="extension.js"});
 }
}
const sha=b=>createHash("sha256").update(b).digest("hex");
const out={checked:0,matched:[],changed:[],missingOptional:[],unavailable:[]};
let pos=0;
const jobs=Array.from({length:5},async()=>{
 while(pos<entries.length){
  const {path,required}=entries[pos++];
  const url=manifest.originalWebsite+path.split("/").map(encodeURIComponent).join("/")+"?audit="+Date.now();
  let body=null,reason=null;
  for(let attempt=0;attempt<2;attempt++){
   try{
    const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(15000)});
    if(!response.ok){reason="HTTP "+response.status;break;}
    body=Buffer.from(await response.arrayBuffer());
    if(!body.length||body.length>1024*1024)throw Error("invalid original source size "+path);
    break;
   }catch(error){reason=String(error).slice(0,160);}
  }
  out.checked++;
  if(!body){
    if(reason==="HTTP 404"&&!required)out.missingOptional.push(path);
    else out.unavailable.push({path,required,error:reason});
    continue;
  }
  const local=existsSync(path)?readFileSync(path):null;
  const info={path,sha256:sha(body),bytes:body.length,localSha256:local?sha(local):null};
  if(local&&sha(local)===info.sha256)out.matched.push(path);
  else out.changed.push(info);
 }
});
await Promise.all(jobs);
out.changed.sort((a,b)=>a.path.localeCompare(b.path));
out.unavailable.sort((a,b)=>a.path.localeCompare(b.path));
mkdirSync("/tmp/v2-release-audit",{recursive:true});
writeFileSync("/tmp/v2-release-audit/full-drift.json",JSON.stringify(out,null,2));
console.log("V2_OFFICIAL_PUBLISHED_COMPLETE_DRIFT_INVENTORY",JSON.stringify({
 checked:out.checked,matched:out.matched.length,
 changed:out.changed,unavailable:out.unavailable,missingOptional:out.missingOptional
}));
if(out.unavailable.some(x=>x.required))process.exitCode=2;
