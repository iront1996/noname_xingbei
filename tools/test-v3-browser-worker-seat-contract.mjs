/**
 * V3 server-owned browser experiment: execute the ORIGINAL randomMapOL
 * method against a deterministic fake transport/DOM adapter. This tests
 * seat allocation only; it is NOT a full Chromium or gameplay test.
 * No VPS or existing V3 transport is modified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import vm from 'node:vm';

const here=dirname(fileURLToPath(import.meta.url));
const source=readFileSync(resolve(here,'../noname/game/index.js'),'utf8');
const start=source.indexOf('\n\trandomMapOL(type) {');
const end=source.indexOf('\n\tcloseMenu() {',start);
if(start===-1||end===-1)throw new Error('NATIVE_RANDOM_MAP_METHOD_MISSING');
const method=source.slice(start+1,end).trim();

function exercise({dedicatedWorker,peerCount=4,seatCount=4}){
 const clients=Array.from({length:peerCount},(_,n)=>({id:`peer-${n+1}`,nickname:`真人${n+1}`}));
 let nextId=1000;
 let offboardHost=null, broadcastMap=null, started=false;
 const roster=()=>Array.from({length:seatCount},(_,n)=>({
  marker:`seat-${n}`,setNickname(){this.nicknameUpdated=true}
 }));
 const game={players:[],me:null,
  prepareArena(){this.players=roster();if(!dedicatedWorker)this.me=this.players[0]},
  broadcast(_call,map){broadcastMap=map},
  chooseCharacterOL(){started=true}
 };
 const ui={arena:{classList:{add(){}}},create:{
  player(){offboardHost={marker:'offboard-authority'};return offboardHost}
 }};
 const lib={node:{clients},playerOL:{},configOL:{mode:'xingBei',xingBei_mode:'2v2'}};
 const get={id:()=>`auto-${++nextId}`,connectNickname:()=>"房間建立者"};
 const context=vm.createContext({window:{isNonameServer:dedicatedWorker},
  ui,lib,game,get,_status:{}});
 vm.runInContext('Array.prototype.randomRemove=function(){return this.pop()}',context);
 const fn=vm.runInContext(`({${method}}).randomMapOL`,context);
 fn();
 return {clients,game,lib,offboardHost,broadcastMap,started};
}

test('dedicated non-player browser authority maps all four human connections to four seats',()=>{
 const {clients,game,lib,offboardHost,broadcastMap,started}=exercise({dedicatedWorker:true});
 assert.ok(started);
 assert.ok(offboardHost);
 assert.equal(game.me,offboardHost);
 assert.equal(game.players.includes(game.me),false,'worker must not consume a player seat');
 assert.equal(game.players.length,4);
 assert.deepEqual(new Set(game.players.map(p=>p.playerid)),new Set(clients.map(c=>c.id)));
 assert.equal(Object.keys(lib.playerOL).length,4);
 assert.deepEqual(new Set(broadcastMap.map(p=>p[0])),new Set(clients.map(c=>c.id)));
 for(const p of game.players){
  assert.ok(p.ws&&clients.includes(p.ws));
  assert.equal(p.nickname,p.ws.nickname);
 }
 assert.equal(game.me.playerid,undefined,'worker must not get a human player id');
});

test('legacy human-browser owner allocates itself a seat (the behavior to replace)',()=>{
 const {clients,game,offboardHost,broadcastMap,started}=exercise({
  dedicatedWorker:false,peerCount:3
 });
 assert.ok(started);
 assert.equal(offboardHost,null);
 assert.equal(game.players.includes(game.me),true);
 assert.equal(game.me.nickname,'房間建立者');
 assert.equal(game.players.filter(p=>p.ws).length,3);
 assert.equal(broadcastMap.length,4);
 assert.deepEqual(new Set(game.players.filter(p=>p.ws).map(p=>p.ws.id)),
  new Set(clients.map(c=>c.id)));
});

test('dedicated-worker preflight must supply one peer socket for EVERY human seat',()=>{
 // The existing native randomMapOL silently fills unbound seats with auto IDs.
 // Therefore a separate, fail-closed lobby gate is a deployment prerequisite.
 const {game,clients}=exercise({dedicatedWorker:true,peerCount:3});
 assert.equal(clients.length,3);
 assert.equal(game.players.filter(p=>p.ws).length,3);
 assert.equal(game.players.filter(p=>!p.ws).length,1);
});
