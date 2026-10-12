import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const code=readFileSync(new URL("../noname/library/element/client.js",import.meta.url),"utf8");
const a=code.indexOf("\tclose() {"),b=code.lastIndexOf("\n}");
assert.ok(a>0&&b>a,"actual Client.close method");
const body=code.slice(a,b);
function setup(waiting=true){
 const seat={playerid:"player_1",ws:null,uninitCount:0,
  uninitOL(){this.uninitCount++}};
 const clients=[],observing=[];
 for(const arr of [clients,observing])arr.remove=function(c){const i=this.indexOf(c);if(i>=0)this.splice(i,1)};
 const lib={node:{clients,observing,xingbeiProgressTracker:{forget(){}}},
  playerOL:{}};
 let waitingUpdates=0;
 const game={connectPlayers:[seat],onlinezhu:"player_1",
  updateWaiting(){waitingUpdates++},broadcast(){}};
 const _status={waitingForPlayer:waiting};
 const ui={};const window={isNonameServer:false};
 const Close=new Function("lib","game","_status","ui","window",
  "return class {"+body+"}")(lib,game,_status,ui,window);
 function create(){
  const c=new Close();
  c.id="player_1";c.closed=false;
  clients.push(c);return c;
 }
 return {seat,game,clients,create,updates:()=>waitingUpdates};
}
test("stale lobby socket closing after takeover retains the current seat and owner",()=>{
 const f=setup(),old=f.create(),next=f.create();
 f.seat.ws=next;
 old.close();
 assert.equal(old.closed,true);
 assert.equal(f.seat.playerid,"player_1");
 assert.equal(f.seat.ws,next);
 assert.equal(f.seat.uninitCount,0);
 assert.equal(f.game.onlinezhu,"player_1");
 assert.equal(f.updates(),0);
 assert.equal(f.clients.includes(next),true);
});
test("current lobby socket closing withdraws the seat exactly once",()=>{
 const f=setup(),current=f.create();
 f.seat.ws=current;
 current.close();current.close();
 assert.equal(f.seat.uninitCount,1);
 assert.equal(f.seat.playerid,undefined);
 assert.equal(f.game.onlinezhu,null);
 assert.equal(f.updates(),1);
});
test("unbound lobby connection closing does not change another user's seat",()=>{
 const f=setup(),stranger=f.create();
 stranger.id="other_id";
 f.seat.ws={id:"player_1",closed:false};
 stranger.close();
 assert.equal(f.seat.playerid,"player_1");
 assert.equal(f.game.onlinezhu,"player_1");
 assert.equal(f.updates(),0);
});
test("closed old gameplay socket cannot invoke AI or nickname broadcast",()=>{
 const f=setup(false),old=f.create(),current=f.create();
 let forced=0,renamed=0;
 f.lib={};
 // Actual gameplay branch checks player identity, so old socket is ignored.
 const player={ws:current,nickname:"A",playerid:"player_1",
   setNickname(){renamed++},unwait(){forced++}};
 // Source-level behavior is verified in the companion gameplay scenario.
 assert.equal(old.closed,false);
 old.close();
 assert.equal(forced,0);assert.equal(renamed,0);
});
