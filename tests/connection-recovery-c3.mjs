import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {XingbeiProgressTracker} from "../noname/util/xingbei-progress-tracker.js";

function source(path){return readFileSync(new URL("../"+path,import.meta.url),"utf8");}
function span(str,begin,end){
  const a=str.indexOf(begin),b=str.indexOf(end,a+begin.length);
  assert.ok(a>=0&&b>a,"missing code anchor "+begin);
  return str.slice(a,b);
}
function mockClock(){
  let ms=0,serial=0;const scheduled=new Map();
  return {
    now:()=>ms,forward:(delta)=>{ms+=delta;},
    setIntervalFn:(fn,interval)=>{const id=++serial;scheduled.set(id,{fn,interval});return id;},
    clearIntervalFn:id=>scheduled.delete(id),
    activeTimers:()=>scheduled.size
  };
}
const clock=mockClock(),issues=[],hostPackets=[];
let phase=5;
const tracker=new XingbeiProgressTracker({...clock,intervalMs:1000,staleMs:4000,
  minPending:3,phaseNow:()=>phase,onSuspect:info=>issues.push(info)});
const first={id:"seat1",closed:false,inited:true,sent:[],send(...packet){this.sent.push(packet);}};
const seat={playerid:"seat1",ws:first};
const lib={node:{clients:[first],observing:[],xingbeiProgressTracker:tracker},playerOL:{seat1:seat}};
const libCode=source("noname/library/index.js");
const hostHandlers=new Function("lib","return ({"+
  span(libCode,"\t\t\txbProgressHello(protocolVersion) {","\t\t\txbChoiceHello(protocolVersion) {")+"})")(lib);
const gameForClient={
  online:true,phaseNumber:5,_xingbeiProgressServerSeq:null,
  send(...args){hostPackets.push(args);}
};
const clientHandlers=new Function("game","return ({"+
  span(libCode,"\t\t\txbProgressProbe(probeId, sequence, hostPhase) {","\t\t\txbChoiceLease(wireId) {")+"})")(gameForClient);
hostHandlers.xbProgressHello.call(first,1);
assert.equal(tracker.clients.size,1);
tracker.probe();
const probe=first.sent.at(-1);
assert.equal(probe[0],"xbProgressProbe");
clientHandlers.xbProgressProbe(...probe.slice(1));
assert.deepEqual(hostPackets.at(-1),["xbProgressAck",probe[1],probe[2],5]);
hostHandlers.xbProgressAck.call(first,...hostPackets.at(-1).slice(1));
assert.equal(tracker.get("seat1").lastAckAgeMs,0);
assert.equal(tracker.acknowledge(first.id,first,probe[1],probe[2],5),false,"probe replay denied");

// A healthy but idle game never triggers stale diagnosis.
clock.forward(5000);
tracker.probe();
assert.equal(issues.length,0);
const latest=first.sent.at(-1);
hostHandlers.xbProgressAck.call(first,latest[1],latest[2],5);

// Progress events must be recorded by the actual host game.broadcast.
const gameCode=source("noname/game/index.js");
const gameForHost={online:false};
const broadClass=new Function("lib","game","return class{"+
  span(gameCode,"\tbroadcast(func, ...args) {","\t/**\n\t * @template { keyof typeof lib.message.client } T",)+"}")(lib,gameForHost);
const broadcaster=new broadClass();
for(let i=0;i<3;i++) broadcaster.broadcast("noop",i);
assert.equal(tracker.sequence,3);
clock.forward(5000);
tracker.probe();
assert.equal(issues.filter(x=>x.kind==="message_processing_stalled").length,1);
tracker.probe();
assert.equal(issues.filter(x=>x.kind==="message_processing_stalled").length,1,"stale signal once");
const currentProbe=first.sent.at(-1);
hostHandlers.xbProgressAck.call(first,currentProbe[1],currentProbe[2],5);
assert.equal(tracker.get(first.id).suspect,false);

// New socket invalidates the old socket's ACK/close; it starts a new window.
const second={id:"seat1",closed:false,inited:true,sent:[],send(...p){this.sent.push(p);}};
seat.ws=second;
hostHandlers.xbProgressHello.call(second,1);
assert.equal(tracker.forget("seat1",first),false);
tracker.probe();
const secondProbe=second.sent.at(-1);
hostHandlers.xbProgressAck.call(first,secondProbe[1],secondProbe[2],5);
assert.equal(tracker.get("seat1").acknowledgedSequence,3);
hostHandlers.xbProgressAck.call(second,...secondProbe.slice(1),0);
for(let i=0;i<2;i++){
  tracker.probe();
  const p=second.sent.at(-1);
  hostHandlers.xbProgressAck.call(second,p[1],p[2],0);
}
assert.equal(issues.filter(x=>x.kind==="game_phase_behind").length,1);
gameForClient.phaseNumber=phase;
tracker.probe();
const recoveredPhaseProbe=second.sent.at(-1);
hostHandlers.xbProgressAck.call(second,...recoveredPhaseProbe.slice(1),5);
assert.equal(tracker.get("seat1").phaseSuspect,false);

// A non-inited socket / unrelated room observer must not be able to register.
const intruder={id:"seat1",inited:false,closed:false};
hostHandlers.xbProgressHello.call(intruder,1);
hostHandlers.xbProgressAck.call(intruder,...secondProbe.slice(1),5);
assert.equal(tracker.clients.get("seat1").client,second);
tracker.dispose();
assert.equal(clock.activeTimers(),0);
console.log("PASS C3: host broadcast tracking, browser ACK, replay protection, stall and phase divergence, safe socket takeover");
