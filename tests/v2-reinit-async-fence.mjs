/** V2-7: execute actual guest reinit method and delayed mode loader callback. */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateXingbeiSeatSnapshot} from "../noname/util/xingbei-reinit-snapshot.js";
import {normalizeXingbeiReinitCoverage} from "../noname/util/xingbei-reinit-coverage.js";

const code=readFileSync(new URL("../noname/library/index.js",import.meta.url),"utf8");
const start=code.indexOf("\t\t\treinit: function (config, state, state2, ip, observe, onreconnect, cardtag, postReconnect, xbCoverage) {");
const end=code.indexOf("\t\t\texec: function (func) {",start);
assert.ok(start>=0&&end>start,"real reinit function anchors");
const method=code.slice(start,end);

function snapshot(id="seat_A"){
 const player={position:0,handcards:[{name:"xingbei-card"}],gaintag:[[]],
  equips:[],judges:[],views:[],specials:[],expansions:[],expansion_gaintag:[],
  vcardsMap:{equips:[],judges:[]}};
 return {number:"1",players:{[id]:player},mode:"xingBei",roomId:"ROOM"};
}
function setup(){
 const changes=[],loadCallbacks=[],sentinel=Symbol("valid-mode-restoration");
 const socket={id:"socket-A"};
 const recovery={active:true,phase:"SYNCING"};
 const game={
  ws:socket,onlineID:"seat_A",roomId:"ROOM",
  _xingbeiRecovery:recovery,_xingbeiSeatReclaimed:true,
  saveConfig(){changes.push("save")},clearConnect(){changes.push("clearConnect")},
  loadModeAsync(_,callback){loadCallbacks.push(callback)},
  finishCards(){changes.push("finishCards")},clearArena(){changes.push("clearArena")}
 };
 const lib={configOL:{},playerOL:{older:"keep"},cardOL:{},vcardOL:{},
  translate:{},element:{Player:class {}},skill:{},card:{},characterPack:{},
  config:{}};
 const ui={auto:{show(){changes.push("auto")}},pause:{show(){changes.push("pause")}}};
 const _status={createNodeTimeout:null,ip:"ws://host",connectMode:false};
 const get={parsedResult(x){return x}};
 const ai={};
 const handler=new Function("game","lib","ui","_status","get","ai","clearTimeout",
  "validateXingbeiSeatSnapshot","normalizeXingbeiReinitCoverage",
  "return ({"+method+"})")(
  game,lib,ui,_status,get,ai,()=>{},validateXingbeiSeatSnapshot,
  normalizeXingbeiReinitCoverage).reinit;
 function invoke(snap=snapshot()){return handler({mode:"xingBei"},snap,{},"ws://host",null,null,null,null)}
 function mode(){return {
  ai:{recoveredAbility:"mode-restored"},get:{},translate:{},
  onreinit(){changes.push("onreinit");throw sentinel}
 }}
 return {changes,loadCallbacks,socket,recovery,game,lib,ai,sentinel,invoke,mode};
}
test("structural preflight catches missing seat and malformed card arrays",()=>{
 const good=snapshot();
 assert.equal(validateXingbeiSeatSnapshot(good,"seat_A"),true);
 assert.equal(validateXingbeiSeatSnapshot(good,"another"),false);
 const missing=structuredClone(good);delete missing.players.seat_A.gaintag;
 assert.equal(validateXingbeiSeatSnapshot(missing,"seat_A"),false);
 const mismatch=structuredClone(good);mismatch.players.seat_A.gaintag=[];
 assert.equal(validateXingbeiSeatSnapshot(mismatch,"seat_A"),false);
 const badJudge=structuredClone(good);
 badJudge.players.seat_A.judges=[{}];
 assert.equal(validateXingbeiSeatSnapshot(badJudge,"seat_A"),false);
 assert.equal(validateXingbeiSeatSnapshot({...good,number:"invalid"},"seat_A"),false);
 assert.equal(validateXingbeiSeatSnapshot({...good,players:[]},"seat_A"),false);
});
test("malformed B3 snapshot cannot clear player/card registry or start mode loading",()=>{
 const f=setup(),broken=snapshot();broken.players.seat_A.handcards=null;
 f.invoke(broken);
 assert.deepEqual(f.changes,[]);
 assert.equal(f.loadCallbacks.length,0);
 assert.deepEqual(f.lib.playerOL,{older:"keep"});
 assert.equal(f.game._xingbeiReinitGeneration,undefined);
});
test("new socket discards old asynchronous load before any skill mutation",()=>{
 const f=setup();f.invoke();assert.equal(f.loadCallbacks.length,1);
 f.game.ws={id:"socket-B"};
 f.loadCallbacks[0](f.mode());
 assert.equal(f.ai.recoveredAbility,undefined);
 assert.equal(f.changes.includes("onreinit"),false);
 assert.equal(f.changes.includes("clearArena"),false);
});
test("same-socket newer reinit invalidates older callback without adding seats",()=>{
 const f=setup();f.invoke();f.invoke();
 assert.equal(f.loadCallbacks.length,2);
 assert.equal(f.game._xingbeiReinitGeneration,2);
 f.loadCallbacks[0](f.mode());
 assert.equal(f.ai.recoveredAbility,undefined);
 assert.equal(f.changes.includes("onreinit"),false);
 assert.throws(()=>f.loadCallbacks[1](f.mode()),e=>e===f.sentinel);
 assert.equal(f.ai.recoveredAbility,"mode-restored");
});
test("recovery phase change and broker reclaim reset abort pending callback",()=>{
 const f=setup();f.invoke();
 f.recovery.phase="RECONNECTING";
 f.loadCallbacks[0](f.mode());
 assert.equal(f.ai.recoveredAbility,undefined);
 f.recovery.phase="SYNCING";
 f.game._xingbeiSeatReclaimed=false;
 f.loadCallbacks[0](f.mode());
 assert.equal(f.ai.recoveredAbility,undefined);
});
test("recovery controller replacement denies older onload even on same socket",()=>{
 const f=setup();f.invoke();
 f.game._xingbeiRecovery={active:true,phase:"SYNCING"};
 f.loadCallbacks[0](f.mode());
 assert.equal(f.ai.recoveredAbility,undefined);
});
test("valid callback is one-shot and does not replay a mode restoration twice",()=>{
 const f=setup();f.invoke();
 assert.throws(()=>f.loadCallbacks[0](f.mode()),e=>e===f.sentinel);
 const initial=f.changes.filter(x=>x==="onreinit").length;
 assert.equal(initial,1);
 assert.doesNotThrow(()=>f.loadCallbacks[0](f.mode()));
 assert.equal(f.changes.filter(x=>x==="onreinit").length,1);
});
test("non-recovery legacy reinit remains compatible with non-B3 snapshot",()=>{
 const f=setup();f.recovery.active=false;f.game._xingbeiSeatReclaimed=false;
 f.invoke({roomId:"ROOM",players:null});
 assert.equal(f.loadCallbacks.length,1);
 assert.ok(f.changes.includes("clearConnect"));
});
