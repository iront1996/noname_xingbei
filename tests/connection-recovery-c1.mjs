import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {ChoiceLeaseRegistry} from "../noname/util/xingbei-choice-lease.js";

const registry=new ChoiceLeaseRegistry({now:()=>100});
const first=registry.open("seat",{timeoutMs:35000});
const second=registry.open("seat",{timeoutMs:35000});
assert.equal(first.state,"SUPERSEDED");
assert.equal(registry.isCurrent("seat",first),false);
assert.equal(registry.isCurrent("seat",second),true);
assert.equal(registry.settle("seat",first),false);
assert.equal(registry.settle("seat",second),true);
assert.equal(registry.settle("seat",second),false);
assert.equal(registry.current("seat"),null);
const cancelled=registry.open("seat");
assert.equal(registry.cancel("seat",cancelled),true);
assert.equal(registry.isCurrent("seat",cancelled),false);

const playerSource=readFileSync(new URL("../noname/library/element/player.js",import.meta.url),"utf8");
const start=playerSource.indexOf("\twait(callback) {");
const end=playerSource.indexOf("\ttempUnwait(result) {",start);
assert.ok(start>=0 && end>start,"actual Player.wait/unwait methods found");
const timers=new Map();
let timerSerial=0;
const clearTimeoutFake=id=>timers.delete(id);
const setTimeoutFake=(fn,ms)=>{const id=++timerSerial;timers.set(id,{fn,ms});return id;};
let resumed=0;
const lib={node:{torespond:{},torespondtimeout:{}},configOL:{choose_timeout:"10"}};
const status={event:{_global_timer:false,getParent:()=>({skillHidden:false})},noclearcountdown:null,paused:true};
const game={players:[],resume:()=>resumed++};
const get={event:()=>false};
const methods=runInNewContext("(class {"+playerSource.slice(start,end)+"})",
 {lib,_status:status,game,get,ChoiceLeaseRegistry,
  setTimeout:setTimeoutFake,clearTimeout:clearTimeoutFake}).prototype;
const makeSocket=()=>{
  const transport={closes:0,close(){this.closes++;}};
  return {closed:false,ws:transport};
};
const ws1=makeSocket(), ws2=makeSocket();
const player={playerid:"seat",ws:ws1,showTimer(){},hideTimer(){},
  wait:methods.wait,unwait:methods.unwait};
game.players=[player];

// Superseded timer callbacks remain inert even if a queued callback runs late.
player.wait();
const oldTimer=[...timers.values()][0].fn;
player.wait();
assert.equal(timers.size,1);
oldTimer();
assert.equal(lib.node.torespond.seat,"_noname_waiting");
assert.equal(ws1.ws.closes,0);
assert.equal(player.unwait({bool:true}),true);
assert.equal(player.unwait({bool:true}),false,"duplicate resolution rejected");
assert.equal(resumed,1);
assert.equal(timers.size,0);

// Reconnect before choice expiry: choice may expire, but only the ORIGINAL
// socket may be closed. Never close the reclaimed socket.
player.ws=ws1;
player.wait();
const pending=[...timers.values()][0];
assert.equal(pending.ms,15000);
player.ws=ws2;
pending.fn();
assert.equal(ws1.ws.closes,0);
assert.equal(ws2.ws.closes,0,"late choice timeout cannot close new connection");
assert.equal(resumed,2);
assert.equal(lib.node.xingbeiChoiceLeases.current("seat"),null);

// Legacy no-reply timeout still resolves AI and closes an unchanged socket.
player.wait();
const aiTimer=[...timers.values()][0];
aiTimer.fn();
assert.equal(ws2.ws.closes,1);
assert.equal(resumed,3);
assert.equal(player.unwait("ai"),false);

// When a callback immediately creates a new choice, old unwait must not
// overwrite the callback's new pending marker or resume the game.
let callbackCalls=0;
player.wait(function firstResult(){
 callbackCalls++;
 player.wait();
});
assert.equal(player.unwait({bool:true}),true);
assert.equal(callbackCalls,1);
assert.equal(lib.node.torespond.seat,"_noname_waiting");
assert.equal(resumed,3);
assert.equal(player.unwait("ai"),true);
assert.equal(resumed,4);

const library=readFileSync(new URL("../noname/library/index.js",import.meta.url),"utf8");
assert.match(library,/if \(!player \|\| player\.ws !== this \|\| this\.closed \|\| this\.inited !== true\) return;/);
const client=readFileSync(new URL("../noname/library/element/client.js",import.meta.url),"utf8");
assert.match(client,/active && timer != null/);
// Execute the actual Client.close method: when a player disconnects during a
// pending choice, AI must not fire before the original deadline.
const clientSourceForVm=readFileSync(new URL("../noname/library/element/client.js",import.meta.url),"utf8");
const closeStart=clientSourceForVm.indexOf("\tclose() {");
const closeEnd=clientSourceForVm.lastIndexOf("\n}");
assert.ok(closeStart>=0 && closeEnd>closeStart,"actual Client.close found");
lib.node.clients={remove(){}};
lib.node.observing={remove(){},length:0};
lib.playerOL={"seat":player};
game.broadcast=()=>{};
const currentClient={id:"seat",closed:false,nickname:"player",ws:ws2.ws};
player.ws=currentClient;
player.nickname="player";
player.setNickname=()=>{};
status.waitingForPlayer=false;
const closeMethod=runInNewContext("({"+clientSourceForVm.slice(closeStart,closeEnd)+"})",
 {lib,game,_status:status,ui:{},window:{isNonameServer:false}}).close;
player.wait();
const timeoutAfterDisconnect=[...timers.values()][0];
assert.ok(timeoutAfterDisconnect);
closeMethod.call(currentClient);
assert.equal(currentClient.closed,true);
assert.equal(lib.node.torespond.seat,"_noname_waiting","disconnect must not consume live choice");
assert.equal(resumed,4,"disconnect must not immediately trigger AI");
timeoutAfterDisconnect.fn();
assert.equal(resumed,5,"the original deadline eventually resolves the choice");

console.log("PASS C1: choice lease, stale timer, takeover, deferred AI and duplicate settlement");
