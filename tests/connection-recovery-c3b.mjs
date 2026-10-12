import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {XingbeiProgressTracker} from "../noname/util/xingbei-progress-tracker.js";
import {bindOriginChoice} from "../noname/util/xingbei-choice-context.js";

const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
function extract(source,beg,end) {
  const i=source.indexOf(beg),j=source.indexOf(end,i+beg.length);
  assert.ok(i>=0&&j>i,"missing code block: "+beg);
  return source.slice(i,j);
}
let now=100,seq=0;const intervals=new Map(),suspicions=[];
const tracker=new XingbeiProgressTracker({
 now:()=>now,setIntervalFn:(fn,interval)=>{const id=++seq;intervals.set(id,{fn,interval});return id;},
 clearIntervalFn:id=>intervals.delete(id),intervalMs:1000,staleMs:4000,
 onSuspect:x=>suspicions.push(x)
});
const transport={id:"seat",closed:false,inited:true};
tracker.bind("seat",transport,()=>{});
const status={currentPhase:{playerid:"turn-A"}};
let broadcastPacket=null;
const hostGame={
 phaseNumber:7,online:false,
 getState:()=>({kind:"public"}),
 broadcast(fn,...args){broadcastPacket={fn,args};},
 updateState(state){this.updatedState=state;},
 send(...args){this.clientAck=args;}
};
const lib={node:{xingbeiProgressTracker:tracker,observing:[]},playerOL:{seat:{ws:transport}}};
const gameMethods=new Function("lib","_status","game","return class{"+
 extract(read("noname/game/index.js"),"\tsyncState() {","\tupdateWaiting() {")+"}")(lib,status,hostGame);
new gameMethods().syncState();
assert.ok(broadcastPacket,"syncState broadcast sent");
const checkpoint=broadcastPacket.args.at(-1);
assert.deepEqual(checkpoint,{id:1,phase:7,currentSeatId:"turn-A"});
assert.equal(tracker.get("seat").pendingCheckpointId,1);

// Simulate the broadcast callback running in a browser after updateState.
hostGame.online=true;
hostGame.phaseNumber=0;
status.currentPhase=null;
broadcastPacket.fn(...broadcastPacket.args);
assert.deepEqual(hostGame.updatedState,{kind:"public"});
assert.equal(hostGame.phaseNumber,7);
assert.deepEqual(hostGame.clientAck,["xbStateCheckpointAck",1,7,"turn-A"]);
hostGame.online=false;

const libCode=read("noname/library/index.js");
const hostMethods=new Function("lib","return ({"+
 extract(libCode,"\t\t\txbStateCheckpointAck(id, phase, currentSeatId) {",
                    "\t\t\txbChoiceHello(protocolVersion) {")+"})")(lib);
hostMethods.xbStateCheckpointAck.call(transport,...hostGame.clientAck.slice(1));
assert.equal(tracker.get("seat").pendingCheckpointId,null);
assert.equal(tracker.acknowledgeCheckpoint("seat",transport,1,7,"turn-A"),false,"replay ignored");

const cp2=tracker.issueCheckpoint(8,"turn-B");
assert.equal(cp2.id,2);
assert.equal(tracker.acknowledgeCheckpoint("seat",transport,cp2.id,7,"turn-A"),false);
assert.equal(suspicions.at(-1).kind,"state_checkpoint_mismatch");
assert.equal(tracker.get("seat").pendingCheckpointId,cp2.id);
now+=4500;
tracker.probe();
assert.ok(suspicions.some(x=>x.kind==="state_checkpoint_unconfirmed"));
assert.equal(tracker.acknowledgeCheckpoint("seat",{id:"seat",closed:false,inited:true},2,8,"turn-B"),false);
assert.equal(tracker.acknowledgeCheckpoint("seat",transport,2,8,"turn-B"),true);
assert.equal(tracker.get("seat").checkpointSuspect,false);
const rebound={id:"seat",closed:false,inited:true};
tracker.bind("seat",rebound,()=>{});
assert.equal(tracker.forget("seat",transport),false);
assert.equal(tracker.acknowledgeCheckpoint("seat",transport,2,8,"turn-B"),false);

// C3b: bind a result to its originating operation, not latest mutable ticket.
const first={bool:true},second={bool:false};
bindOriginChoice(first,"c2:older");
bindOriginChoice(second,"c2:newer");
assert.equal(first._xingbeiChoiceWireId,"c2:older");
assert.equal(Object.keys(first).includes("_xingbeiChoiceWireId"),false);
assert.equal(JSON.stringify(first),'{"bool":true}');
assert.equal(bindOriginChoice(first,"c2:newer")._xingbeiChoiceWireId,"c2:older");
const init=read("noname/library/init/index.js");
const startOnline=new Function("game","event","result","return class{"+
 extract(init,"\tstartOnline() {","\tonfree() {")+"}").call;
let outgoing=[],latest="c2:newer";
const clientGame={_xingbeiChoiceTicket:latest,pause(){},send(...args){outgoing.push(args);}};
const clientEvent={goto(){},_resultid:null};
const StartClass=new Function("game","event","result","return class{"+
 extract(init,"\tstartOnline() {","\tonfree() {")+"}")(clientGame,clientEvent,first);
new StartClass().startOnline();
assert.equal(outgoing[0][2],"c2:older","old event does not borrow new ticket");
assert.equal(clientGame._xingbeiChoiceTicket,latest,"new ticket retained");
outgoing=[];
const InitClass2=new Function("game","event","result","return class{"+
 extract(init,"\tstartOnline() {","\tonfree() {")+"}")(clientGame,clientEvent,second);
new InitClass2().startOnline();
assert.equal(outgoing[0][2],"c2:newer");
assert.equal(clientGame._xingbeiChoiceTicket,null);

// Actual GameEvent.send: server must issue lease before sending action; client
// receives the immutable originating lease as a separate message argument.
const eventSrc=read("noname/library/element/gameEvent.js");
const sent=[],hostLease={wireId:"c2:origin"};
const remotePlayer={
 playerid:"seat",wait(){sent.push("lease");},
 send(...args){sent.push(["action",...args]);}
};
const eventGame={pause(){sent.push("pause")}};
const eventLib={node:{xingbeiChoiceLeases:{current:()=>hostLease}}};
const get={stringifiedResult:()=>null,skillState:()=>({})};
const EventClass=new Function("lib","game","get","return class{"+
 extract(eventSrc,"\tsend() {","\t/**\n\t * 在可await/异步情况下获取客机执行的结果")+"}")(eventLib,eventGame,get);
const remoteEvent=new EventClass();
Object.assign(remoteEvent,{player:remotePlayer,name:"chooseCard",_args:[],_set:[],parent:null});
remoteEvent.send();
assert.equal(sent[0],"lease");
assert.equal(sent[1][0],"action");
assert.equal(sent[1].at(-1),"c2:origin");
assert.equal(sent[2],"pause");
tracker.dispose();
assert.equal(intervals.size,0);
console.log("PASS C3b: real syncState checkpoint, authenticated ACK, late/mismatched checkpoint, immutable originating choice and ordered lease");
