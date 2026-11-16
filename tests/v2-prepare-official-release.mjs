#!/usr/bin/env node
// Build the *published* original site layer over the pinned original Git source.
// This operates in an isolated V2-only CI worktree. It does not deploy or push.
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync,existsSync,mkdirSync} from "node:fs";
import {dirname,extname,join} from "node:path";
import {createHash} from "node:crypto";
const official="https://rancherjie.github.io/noname_xingbei/";
const pinned="abd687ff7237c24a1fcd05b6524309c73b9cb818";
const extensionPinned="b13809ceced561a5249d9d4256c1e78af1998add";
const bundleNames=["无名杯UI优化包","百年战争·序章","十周年-噩梦人机","十周年-AI优化版","宿命挽歌","创世纪","电啸龙吟","轮回遗梦","十周年语音包","峡谷幻音","永夜残响"];
const allowed=new Set([
"character/boss.js","character/sanBan.js","character/shenZiChuangLin.js","character/shiZhouNian.js","character/teDian.js","character/yiDuanYeHuo.js","character/zhongMoDaoZhu.js",
"game/asset.js","game/directory.js","game/source.js","game/updateAsset.js","game/updateAsset.ts",
"layout/default/layout.css","layout/default/menu.css","layout/mode/stone.css","layout/others/skill.css",
"noname/game/index.js","noname/init/index.js","noname/library/element/card.js","noname/library/element/player.js","noname/library/index.js",
"noname/ui/click/index.js","noname/ui/create/index.js","noname/ui/create/menu/pages/exetensionMenu.js","noname/ui/create/menu/pages/optionsMenu.js","noname/ui/index.js",
"theme/music/style.css","theme/style/card/music.css","theme/style/card/ol.css","theme/style/card/simple.css","theme/style/cardback/music.css","theme/style/cardback/xingBei.css","theme/style/hp/custom.css","theme/style/hp/xingBei.css","theme/woodden/style.css"
]);
const git=(args,opts={})=>execFileSync("git",args,{encoding:"utf8",maxBuffer:12*1024*1024,...opts}).trim();
const originSource="/tmp/v2-original-source";
const extSource="/tmp/v2-extension-source";
if(git(["-C",originSource,"rev-parse","HEAD"])!==pinned)throw new Error("unapproved original source revision");
if(git(["-C",extSource,"rev-parse","HEAD"])!==extensionPinned)throw new Error("unapproved original extension revision");
if(!/^integration\/v2-public-runtime-parity-20261117$/.test(git(["branch","--show-current"])))throw new Error("wrong worktree");
if(git(["status","--porcelain"])!=="")throw new Error("dirty worktree");
const sha=b=>createHash("sha256").update(b).digest("hex");
const snap=String(Date.now());
async function retrieve(path,max=25*1024*1024){
 const url=official+path.split("/").map(encodeURIComponent).join("/")+"?build="+snap;
 let cause;
 for(let i=0;i<2;i++)try{
  const res=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(30000)});
  if(res.status===404)return null;
  if(!res.ok)throw new Error("HTTP "+res.status+" "+url);
  const bytes=Buffer.from(await res.arrayBuffer());
  if(bytes.length>max)throw new Error("oversized file "+path);
  return bytes;
 }catch(e){cause=e;}
 throw new Error("cannot retrieve "+path+": "+cause);
}
const list=git(["-C",originSource,"ls-tree","-r","--name-only","HEAD"]).split("\n").filter(Boolean);
const paths=list.filter(x=>/\.(?:js|mjs|ts|css|html|json|vue)$/.test(x));
const diffs=[];
let next=0;
await Promise.all(Array.from({length:12},async()=>{
 while(next<paths.length){
  const path=paths[next++];
  const content=await retrieve(path);
  if(!content){if(path===".eslintrc.json")continue;throw new Error("missing published original source "+path);}
  const old=readFileSync(path);
  if(sha(old)===sha(content))continue;
  if(path==="mode/connect.js")continue; // V2-only WSS and image preload patch.
  if(!allowed.has(path))throw new Error("unreviewed original site drift: "+path);
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,content);
  diffs.push({path,sha256:sha(content),bytes:content.length});
 }
}));
diffs.sort((a,b)=>a.path.localeCompare(b.path));
if(diffs.length!==35||allowed.size!==35)throw new Error("published original site overlay unexpected file set "+JSON.stringify(diffs.map(x=>x.path)));
for(const path of allowed)if(!diffs.some(x=>x.path===path))throw new Error("original published file drift vanished: "+path);
// The official published release bundles these eleven optional extensions;
// upstream source deliberately does NOT contain extension/ at all.
// The public official extension release is the authority: its deployed files
// may differ from the separate GitHub extension catalog without version tags.
// Reconcile every known catalog file with the actual public release; preserve
// license/docs and inactive packages from the catalog when not published.
const extTree=git(["-C",extSource,"ls-tree","-r","--name-only","HEAD"]).split("\n").filter(Boolean);
const extFiles=extTree.filter(p=>bundleNames.some(n=>p.startsWith(n+"/")));
const extDrift=[],missingPublished=[];
let ei=0;
await Promise.all(Array.from({length:10},async()=>{
 while(ei<extFiles.length){
  const file=extFiles[ei++];
  const officialBytes=await retrieve("extension/"+file);
  const localPath=join(extSource,file);
  if(!officialBytes){
   if(file.endsWith("/extension.js"))throw new Error("official extension unavailable "+file);
   missingPublished.push(file);
   continue;
  }
  const old=readFileSync(localPath);
  if(sha(old)!==sha(officialBytes)){
   writeFileSync(localPath,officialBytes);
   extDrift.push({path:file,sha256:sha(officialBytes),bytes:officialBytes.length});
  }
 }
}));
console.log("OFFICIAL_EXTENSION_RELEASE_VERIFIED",JSON.stringify({sourceFiles:extFiles.length,changedFromCatalog:extDrift.length,notPublished:missingPublished.length,sample:extDrift.slice(0,25)}));
const originalImages=list.filter(p=>(p.startsWith("image/")||p.startsWith("theme/"))&&p.endsWith(".png"));
const gathered=[];
let imageIndex=0;
await Promise.all(Array.from({length:12},async()=>{
 while(imageIndex<originalImages.length){
  const orig=originalImages[imageIndex++];
  const webp=orig.slice(0,-4)+".webp";
  if(existsSync(webp))continue;
  const content=await retrieve(webp);
  if(!content)continue;
  if(content.length<12||content.toString("ascii",0,4)!=="RIFF"||content.toString("ascii",8,12)!=="WEBP")throw new Error("invalid WebP "+webp);
  mkdirSync(dirname(webp),{recursive:true});
  writeFileSync(webp,content);
  gathered.push({path:webp,sha256:sha(content),bytes:content.length});
 }
}));
console.log("OFFICIAL_PUBLIC_LAYER_READY",JSON.stringify({sourceFiles:diffs.length,webpConverted:gathered.length,webpBytes:gathered.reduce((v,x)=>v+x.bytes,0),extensionPackages:bundleNames.length,sourceSha:pinned,extensionSha:extensionPinned}));
mkdirSync("artifacts/v2-deploy-layer",{recursive:true});
writeFileSync("artifacts/v2-deploy-layer/snapshot.json",JSON.stringify({
 source:pinned,extensions:extensionPinned,published:official,date:new Date().toISOString(),
 sourceFiles:diffs,webpFiles:gathered.sort((a,b)=>a.path.localeCompare(b.path)),extensionSourceDrift:extDrift,extensionNotPublished:missingPublished,extensionsIncluded:bundleNames
},null,2));
