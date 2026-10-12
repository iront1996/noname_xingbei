import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {XingbeiProgressTracker} from "../noname/util/xingbei-progress-tracker.js";
import {captureXingbeiPublicState, fingerprintXingbeiPublicState} from "../noname/util/xingbei-public-checkpoint.js";

const seat=(id,hp,side)=>({playerid:id,hp,maxHp:6,hujia:1,side,
  handcards:["private"],storage:{secret:"hidden"},identity:"private"});
const make=()=>({
  players:[seat("b",4,false),seat("a",3,true)],dead:[],
  hongShiQi:4,lanShiQi:6,hongXingBei:2,lanXingBei:1,
  hongZhanJi:[{private:"red"}],lanZhanJi:[],deck:["private deck"]
});
const original=make(),baseline=fingerprintXingbeiPublicState(original);
assert.match(baseline,/^xb-public-v1:[0-9a-f]{16}$/);
const reordered=make();reordered.players.reverse();
assert.equal(fingerprintXingbeiPublicState(reordered),baseline,"seat order canonicalized");
original.players[0].storage.secret="changed";
original.players[0].handcards.push("secret");
original.deck.push("hidden");
assert.equal(fingerprintXingbeiPublicState(original),baseline,"private data ignored");
assert.ok(!JSON.stringify(captureXingbeiPublicState(original)).includes("private"));
original.hongShiQi++;
assert.notEqual(fingerprintXingbeiPublicState(original),baseline,"visible resource divergence");
original.hongShiQi--;
original.players[1].hp--;
assert.notEqual(fingerprintXingbeiPublicState(original),baseline,"visible HP divergence");
assert.equal(fingerprintXingbeiPublicState({players:[]}),null);
const duplicate=make();duplicate.dead.push(seat("a",0,true));
assert.equal(fingerprintXingbeiPublicState(duplicate),null,"duplicate seat invalid");

let now=100;const signals=[],timers=new Map();
const tracker=new XingbeiProgressTracker({
  now:()=>now,setIntervalFn:(fn)=>{timers.set(1,fn);return 1;},
  clearIntervalFn:id=>timers.delete(id),intervalMs:1000,staleMs:4000,
  onSuspect:signal=>signals.push(signal)
});
const socket={id:"seat",closed:false,inited:true};
tracker.bind("seat",socket,()=>{});
const context={currentPhase:{playerid:"seat"}};
const host=make();
host.online=false;host.phaseNumber=7;
host.getState=()=>({hongShiQi:host.hongShiQi,players:host.players});
host.updateState=function(state){this.hongShiQi=state.hongShiQi;this.players=state.players;};
let broadcast,ack;
host.broadcast=(fn,...args)=>{broadcast={fn,args};};
host.send=(...args)=>{ack=args;};
host.xingbeiPublicCheckpointDigest=()=>fingerprintXingbeiPublicState(host);
const lib={node:{xingbeiProgressTracker:tracker,observing:[]},
  playerOL:{seat:{ws:socket}}};
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
function span(text,begin,end){
  const i=text.indexOf(begin),j=text.indexOf(end,i+begin.length);
  assert.ok(i>=0&&j>i,"missing source anchor: "+begin);
  return text.slice(i,j);
}
const GameClass=new Function("lib","_status","game","return class{"+
  span(read("noname/game/index.js"),"\tsyncState() {","\tupdateWaiting() {")+"}")(lib,context,host);
new GameClass().syncState();
assert.ok(broadcast);
const checkpoint=broadcast.args.at(-1);
assert.equal(checkpoint.publicDigest,baseline,"snapshot captured by host");
assert.equal(checkpoint.phase,7);
const authoritativeState=broadcast.args[0];
host.hongShiQi=0;host.players=[seat("wrong",1,true)];
host.phaseNumber=0;host.online=true;context.currentPhase=null;
broadcast.fn(...broadcast.args);
assert.equal(host.hongShiQi,authoritativeState.hongShiQi);
assert.equal(ack[0],"xbStateCheckpointAck");
assert.equal(ack[4],baseline,"ACK describes post-apply public state");
const handlers=new Function("lib","return ({"+
  span(read("noname/library/index.js"),
    "\t\t\txbStateCheckpointAck(id, phase, currentSeatId) {",
    "\t\t\txbChoiceHello(protocolVersion) {")+"})")(lib);
handlers.xbStateCheckpointAck.call(socket,...ack.slice(1));
assert.equal(tracker.get("seat").pendingCheckpointId,null);
assert.equal(tracker.get("seat").lastPublicFingerprintVerified,true);
assert.equal(tracker.acknowledgeCheckpoint("seat",socket,checkpoint.id,7,"seat",baseline),
  false,"duplicate rejected");
const next=tracker.issueCheckpoint(8,"seat",baseline);
assert.equal(tracker.acknowledgeCheckpoint("seat",socket,next.id,8,"seat",
  "xb-public-v1:0000000000000000"),false,"wrong digest rejected");
assert.equal(signals.at(-1).kind,"state_public_digest_mismatch");
assert.equal(tracker.get("seat").pendingCheckpointId,next.id);
assert.equal(tracker.get("seat").fingerprintMismatchCount,1);
assert.equal(tracker.acknowledgeCheckpoint("seat",{...socket},next.id,8,"seat",baseline),
  false,"superseded socket rejected");
// Legacy C3b clients omit the new digest; their checkpoint still works, but
// it MUST NOT be recorded as fingerprint-verified.
assert.equal(tracker.acknowledgeCheckpoint("seat",socket,next.id,8,"seat"),true);
assert.equal(tracker.get("seat").lastPublicFingerprintVerified,false);
tracker.dispose();
assert.equal(timers.size,0);
console.log("PASS C3c: deterministic public digest, post-apply ACK, diverged fingerprint, replay/socket fencing and legacy ACK");
