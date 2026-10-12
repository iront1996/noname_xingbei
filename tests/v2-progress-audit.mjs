import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {V2ProgressAudit} from "../noname/util/xingbei-v2-progress-audit.js";
import {XingbeiProgressTracker} from "../noname/util/xingbei-progress-tracker.js";
import {ChoiceLeaseRegistry} from "../noname/util/xingbei-choice-lease.js";
function fixture(){
 let t=0;const emitted=[];const client={id:"A",closed:false,inited:true};
 const observer=new V2ProgressAudit({now:()=>t,quietMs:30000,
   choiceGraceMs:10000,onSignal:x=>emitted.push(x)});
 const args={seatId:"A",client,hostSequence:1,phase:3,lastAckAgeMs:0,
   gameStarted:true,hostPaused:false,pendingChoiceCount:0};
 return {observer,emitted,client,args,clock(ms){t+=ms},time(){return t}};
}
test("fresh C3 ACK cannot disguise an overrun host choice lease",()=>{
 const f=fixture();
 const registry=new ChoiceLeaseRegistry({now:()=>f.time()});
 const lease=registry.open("A",{socket:f.client,timeoutMs:30000});
 const args={...f.args,waitingChoice:true,pendingChoiceCount:1,choiceLease:lease};
 f.observer.observe(args);f.clock(29999);f.observer.observe(args);
 assert.equal(f.emitted.length,0,"valid human decision period");
 f.clock(10002);f.observer.observe(args);
 assert.deepEqual(f.emitted.map(e=>e.kind),["choice_deadline_overrun_advisory"]);
 assert.equal(f.emitted[0].transportAckFresh,true);
 assert.ok(f.emitted[0].overdueMs>=10000);
 assert.equal("socket" in f.emitted[0],false);
 assert.equal("token" in f.emitted[0],false);
 f.observer.observe(args);assert.equal(f.emitted.length,1,"deduplicate current choice");
 registry.settle("A");f.observer.observe({...args,waitingChoice:false,pendingChoiceCount:0,choiceLease:null});
 const next=registry.open("A",{socket:f.client,timeoutMs:0});f.clock(10000);
 f.observer.observe({...args,choiceLease:next});
 assert.equal(f.emitted.filter(e=>e.kind==="choice_deadline_overrun_advisory").length,2,
   "new choice generation is independently diagnosed");
});
test("ordinary long player wait and deliberate host pause suppress quiet-host warning",()=>{
 const f=fixture();f.observer.observe(f.args);
 f.clock(25000);f.observer.observe({...f.args,pendingChoiceCount:1,waitingChoice:true});
 f.clock(500000);f.observer.observe({...f.args,pendingChoiceCount:1,waitingChoice:true});
 assert.equal(f.emitted.length,0);
 f.clock(500000);f.observer.observe({...f.args,hostPaused:true});
 assert.equal(f.emitted.length,0);
});
test("room idle without known choice is an unverified one-shot advisory only",()=>{
 const f=fixture();f.observer.observe(f.args);
 f.clock(30000);f.observer.observe(f.args);
 assert.equal(f.emitted.length,1);
 assert.deepEqual(f.emitted[0],{kind:"host_progress_quiet_unverified",
   phase:3,hostSequence:1,quietMs:30000,transportAckFresh:true,ackAgeMs:0});
 f.clock(200000);f.observer.observe(f.args);
 assert.equal(f.emitted.length,1);
 assert.equal(f.client.closed,false,"must not disconnect");
});
test("new host phase or broadcast resets quiet window; no game start no signal",()=>{
 const f=fixture();
 f.observer.observe({...f.args,gameStarted:false});f.clock(30001);
 f.observer.observe({...f.args,gameStarted:false});
 assert.equal(f.emitted.length,0);
 f.observer.observe(f.args);f.clock(29000);
 f.observer.observe({...f.args,phase:4});f.clock(29000);
 f.observer.observe({...f.args,phase:4,hostSequence:2});
 assert.equal(f.emitted.length,0);
 f.clock(30000);f.observer.observe({...f.args,phase:4,hostSequence:2});
 assert.equal(f.emitted.length,1);
});
test("closed/uninitialized clients cannot update audit and disposal resets it",()=>{
 const f=fixture();f.client.inited=false;
 assert.equal(f.observer.observe(f.args),false);
 f.client.inited=true;f.observer.observe(f.args);f.clock(30000);
 f.observer.dispose();f.observer.observe(f.args);
 assert.equal(f.emitted.length,0);
});
test("C3 onSample is additive and cannot break host probes when diagnostics throw",()=>{
 let t=0;const signals=[],out=[];
 const tracker=new XingbeiProgressTracker({now:()=>t,
  setIntervalFn:()=>1,clearIntervalFn:()=>{},
  intervalMs:1000,staleMs:4000,onSample:s=>{signals.push(s);throw Error("observer")}}
 );
 const client={closed:false,inited:true};
 tracker.bind("seat",client,(...args)=>out.push(args));
 tracker.probe();
 assert.equal(out.length,1);
 assert.deepEqual(signals.map(s=>s.seatId),["seat"]);
 assert.equal(signals[0].hostSequence,0);
 assert.equal(tracker.acknowledge("seat",client,out[0][0],out[0][1],0),true);
 t+=1500;tracker.probe();
 assert.equal(out.length,2);
 assert.equal(signals[1].lastAckAgeMs,1500);
 tracker.dispose();
});
test("real human-host createServer connects V2 observer to C3 authenticated probes",()=>{
 const source=readFileSync(new URL("../noname/game/index.js",import.meta.url),"utf8");
 const begin=source.indexOf("\tcreateServer() {");
 const end=source.indexOf("\t/**",begin+1);
 assert.ok(begin>=0&&end>begin);
 const src=source.slice(begin,end);
 const warns=[];
 let t=0;
 class MockAudit extends V2ProgressAudit {
  constructor(opts){super({...opts,now:()=>t,quietMs:30000,choiceGraceMs:10000})}
 }
 const lib={node:{},configOL:{mode:"xingBei"},playerOL:{}};
 const game={onlineroom:true,phaseNumber:2};
 const _status={over:false,paused:false};
 const ui={create:{roomInfo(){},chat(){}}};
 const actual=new Function("lib","game","_status","ui","XingbeiProgressTracker",
    "V2ProgressAudit","console","return class {"+src+"}")(lib,game,_status,ui,
      XingbeiProgressTracker,MockAudit,{warn(...args){warns.push(args)}});
 new actual().createServer();
 assert.ok(lib.node.xingbeiProgressTracker instanceof XingbeiProgressTracker);
 assert.ok(lib.node.xingbeiV2ProgressAudit instanceof V2ProgressAudit);
 const socket={closed:false,inited:true,id:"seat",send(){}};
 lib.playerOL.seat={ws:socket};
 lib.node.torespond={};
 lib.node.xingbeiProgressTracker.bind("seat",socket,()=>{});
 lib.node.xingbeiProgressTracker.probe();
 t+=30000;lib.node.xingbeiProgressTracker.probe();
 assert.equal(warns.some(x=>x.includes("host_progress_quiet_unverified")),true);
 const before=warns.length;
 lib.node.torespond.seat="_noname_waiting";
 t+=30000;lib.node.xingbeiProgressTracker.probe();
 assert.equal(warns.length,before,"no repeated alert during normal waiting");
 // Invalid old binding must not be sampled into the observer.
 lib.playerOL.seat.ws={id:"replacement",inited:false};
 t+=30000;lib.node.xingbeiProgressTracker.probe();
 assert.equal(warns.length,before);
 lib.node.xingbeiProgressTracker.dispose();
 lib.node.xingbeiV2ProgressAudit.dispose();
});
