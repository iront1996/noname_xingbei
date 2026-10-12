/** V2-5 independent broker observer: fake-clock behavior plus generated HALL wire. */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import vm from "node:vm";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);
const {createHallProgressWatch}=require("../tools/connection-recovery/xingbei-hall-progress-watch.js");
function clockFixture(){
 let ms=0;const alerts=[];
 const room={key:"room-alpha",config:{gameStarted:true}};
 const owner={room,readyState:1};room.owner=owner;
 const watch=createHallProgressWatch({
  now:()=>ms,missingMs:30000,quietMs:60000,onAdvisory:a=>alerts.push(a)});
 function report({sequence=1,phase=2,pending=0,paused=false,active=true}={}){
  return watch.report(room,owner,1,sequence,phase,pending,paused,active);
 }
 return {watch,room,owner,alerts,report,step:n=>{ms+=n},time:()=>ms};
}
test("broker timer detects missing host app reports despite open WebSocket",()=>{
 const f=clockFixture();assert.equal(f.report(),true);
 f.step(29999);f.watch.check();assert.equal(f.alerts.length,0);
 f.step(1);f.watch.check();
 assert.deepEqual(f.alerts,[{kind:"host_app_report_missing_socket_open",roomId:"room-alpha",
   silentMs:30000,transportOpen:true}]);
 f.watch.check();assert.equal(f.alerts.length,1,"one alert per silence");
 f.report();f.step(30000);f.watch.check();
 assert.equal(f.alerts.filter(x=>x.kind==="host_app_report_missing_socket_open").length,2,
   "fresh observation after reports resume");
 assert.equal(f.owner.readyState,1,"watch may not disconnect the host");
});
test("legitimate human choice and pause suppress quiet progress classification",()=>{
 const f=clockFixture();f.report({pending:1});
 for(let i=0;i<7;i++){f.step(15000);f.report({pending:1});f.watch.check()}
 assert.equal(f.alerts.length,0);
 for(let i=0;i<7;i++){f.step(15000);f.report({paused:true});f.watch.check()}
 assert.equal(f.alerts.length,0);
 f.report({active:false});
 assert.equal(f.watch.snapshot(f.room),null,"finished game ceases monitoring");
 f.step(600000);f.watch.check();assert.equal(f.alerts.length,0);
});
test("repeated responsive host reports but zero progress produce advisory, no action",()=>{
 const f=clockFixture();f.report();
 for(let i=0;i<5;i++){f.step(15000);f.report();f.watch.check()}
 assert.equal(f.alerts.length,1);
 assert.equal(f.alerts[0].kind,"host_progress_quiet_unverified");
 assert.equal(f.alerts[0].quietMs,60000);
 f.step(15000);f.report();f.watch.check();assert.equal(f.alerts.length,1);
 f.step(15000);f.report({sequence:2});f.watch.check();
 for(let i=0;i<4;i++){f.step(15000);f.report({sequence:2});f.watch.check()}
 assert.equal(f.alerts.length,2,"new broadcast gives a fresh window with live reports");
});
test("host owner close, stale credentials and guest injection are distinct",()=>{
 const f=clockFixture();f.report();
 const guest={room:f.room,readyState:1};
 assert.equal(f.watch.report(f.room,guest,1,5,10,0,false,true),false);
 assert.equal(f.watch.report(f.room,f.owner,1,"not a number",10,0,false,true),false);
 assert.equal(f.watch.report(f.room,f.owner,1,1,2,999,false,true),false);
 assert.equal(f.watch.report(f.room,f.owner,1,0,2,0,false,true),false,
  "regressed host sequence rejected");
 assert.equal(f.watch.snapshot(f.room).sequence,1);
 assert.equal(f.watch.ownerClosed(f.room,guest),false);
 assert.equal(f.watch.ownerClosed(f.room,f.owner),true);
 assert.equal(f.alerts.at(-1).kind,"host_socket_closed");
 assert.equal(f.watch.snapshot(f.room),null);
});
test("broker catches owner close even if close callback is delayed",()=>{
 const f=clockFixture();f.report();f.owner.readyState=3;
 f.watch.check();
 assert.equal(f.alerts.length,1);
 assert.equal(f.alerts[0].kind,"host_socket_closed");
 f.watch.check();assert.equal(f.alerts.length,1);
});
test("observer callback exceptions cannot interrupt HALL timers",()=>{
 const f=clockFixture();
 const w=createHallProgressWatch({now:f.time,missingMs:30000,quietMs:60000,
  onAdvisory(){throw Error("diagnostic logging failed")}});
 assert.equal(w.report(f.room,f.owner,1,1,2,0,false,true),true);
 f.step(30000);assert.doesNotThrow(()=>w.check());
 assert.equal(f.owner.readyState,1);
});
test("generated HALL only accepts current owner telemetry; independent timer still runs",()=>{
 const dir=mkdtempSync(join(tmpdir(),"xingbei-v2-watch-"));
 try {
  const base=readFileSync(join(root,"game/server.js"),"utf8");
  const input=join(dir,"base.js"),out=join(dir,"patched.js");
  writeFileSync(input,"// XINGBEI-CONNECTION-HEALTH A1\n"+
    "// XINGBEI-MONITOR DISCONNECT V2.3\n"+base);
  const p=spawnSync("python3",[
    join(root,"tools/connection-recovery/patch_server_b2.py"),
    "--source",input,"--output",out
  ],{encoding:"utf8",timeout:10000});
  assert.equal(p.status,0,p.stderr);
  let now=0,watchLoop=null,server=null;
  const received=[];
  class MockSocket {
   constructor(){
    this.room=null;this.readyState=1;this.closed=false;
    this.handlers=new Map();this.packets=[];
    this._socket={remoteAddress:"127.0.0.1"};
   }
   send(data){this.packets.push(data)}
   on(type,fn){this.handlers.set(type,fn)}
   receive(...p){this.handlers.get("message")?.call(this,JSON.stringify(p))}
   close(){
    if(this.closed)return;
    this.closed=true;this.readyState=3;
    this.handlers.get("close")?.call(this);
   }
   terminate(){this.close()}
  }
  class MockWSS {
   constructor(){server=this}
   on(kind,fn){if(kind==="connection")this.accept=fn}
   connect(){const ws=new MockSocket();this.accept(ws);return ws}
  }
  vm.runInNewContext(readFileSync(out,"utf8"),{
   require(spec){
    if(spec==="ws")return {Server:MockWSS};
    if(spec==="./xingbei-seat-registry.js")
      return require("../tools/connection-recovery/seat-registry.js");
    if(spec==="./xingbei-hall-progress-watch.js")
      return {createHallProgressWatch(options){
        return createHallProgressWatch({...options,now:()=>now,
          missingMs:30000,quietMs:60000,onAdvisory:entry=>{
           received.push(entry);options.onAdvisory?.(entry);
          }});
      }};
    if(spec==="./server-room-lifecycle.js")
      return require("../game/server-room-lifecycle.js");
    throw Error("unknown require "+spec);
   },
   setTimeout:()=>1,clearTimeout:()=>{},
   setInterval(fn,ms){if(ms===15000)watchLoop=fn;return 2},
   clearInterval:()=>{},console:{log(){},warn(){},error(){}}
  },{timeout:1000});
  assert.equal(typeof watchLoop,"function");
  const host=server.connect();host.receive("server","key",["r1","version"]);
  host.receive("server","create","r1","Host","avatar");
  host.receive("server","config",{gameStarted:true,observe:false});
  const guest=server.connect();guest.receive("server","key",["guest","version"]);
  guest.receive("server","enter","r1","Guest","avatar");
  guest.receive("server","xbHostProgressV2",1,999,5,0,false,true);
  now=75000;watchLoop();
  assert.deepEqual(received,[],"guest cannot plant false owner telemetry");
  now=90000;host.receive("server","xbHostProgressV2",1,1,2,0,false,true);
  now=119999;watchLoop();assert.equal(received.length,0);
  now=120000;watchLoop();
  assert.equal(received.at(-1)?.kind,"host_app_report_missing_socket_open");
  assert.equal(received.at(-1)?.transportOpen,true);
  host.close();
  assert.equal(received.at(-1)?.kind,"host_socket_closed");
  assert.equal(received.length,2,"room owner close produces one separate diagnosis");
 }finally{rmSync(dir,{recursive:true,force:true})}
});


test("real human-host createServer emits minimal broker telemetry, retires prior timer",async()=>{
 const {XingbeiProgressTracker}=await import("../noname/util/xingbei-progress-tracker.js");
 const {V2ProgressAudit}=await import("../noname/util/xingbei-v2-progress-audit.js");
 const gameSource=readFileSync(join(root,"noname/game/index.js"),"utf8");
 const start=gameSource.indexOf("\tcreateServer() {");
 const end=gameSource.indexOf("\t/**",start+1);
 assert.ok(start>=0&&end>start,"actual createServer anchors");
 const body=gameSource.slice(start,end);
 const reports=[],timers=new Map(),cleared=[];
 let id=0;
 const lib={node:{},configOL:{mode:"xingBei"},playerOL:{},wsOL:{}};
 const game={onlineroom:true,onlinehall:true,phaseNumber:8,
  ws:{readyState:1},send(...args){reports.push(args)}};
 const _status={over:false,paused:false};
 const ui={create:{roomInfo(){},chat(){}}};
 const schedule=(fn,ms)=>{
  assert.equal(ms,15000);
  const handle={id:++id,unref(){}};
  timers.set(handle,fn);
  return handle;
 };
 const cancel=handle=>{cleared.push(handle);timers.delete(handle)};
 const C=new Function("lib","game","_status","ui","XingbeiProgressTracker",
  "V2ProgressAudit","console","setInterval","clearInterval",
  "return class {"+body+"}")(lib,game,_status,ui,
  XingbeiProgressTracker,V2ProgressAudit,{warn(){}},schedule,cancel);
 const human=new C();human.createServer();
 const first=lib.node.xingbeiV2HallWatchTimer;
 assert.equal(timers.size,1);
 lib.node.torespond.seatA="_noname_waiting";
 timers.get(first)();
 assert.deepEqual(reports[0],["server","xbHostProgressV2",1,0,8,1,false,true]);
 assert.equal(reports[0].length,8,"wire is strictly minimal, no room token or state");
 _status.paused=true;
 lib.node.torespond={};
 timers.get(first)();
 assert.deepEqual(reports[1],["server","xbHostProgressV2",1,0,8,0,true,true]);
 _status.over=true;
 timers.get(first)();
 assert.equal(reports[2].at(-1),false,"finished game clears HALL observation");
 game.ws.readyState=3;timers.get(first)();
 assert.equal(reports.length,3,"closed socket cannot emit stale telemetry");
 game.ws.readyState=1;_status.over=false;
 human.createServer();
 assert.ok(cleared.includes(first),"old host report interval must be cleared");
 assert.equal(timers.size,1,"only one telemetry interval can remain");
 lib.node.xingbeiV2HallWatchTimer&&cancel(lib.node.xingbeiV2HallWatchTimer);
 lib.node.xingbeiProgressTracker?.dispose();
 lib.node.xingbeiV2ProgressAudit?.dispose();
});
