import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {launchV3ChromiumAuthorityWorker as launch} from '../game/v3-chromium-authority-worker.mjs';
import {validateV3AuthoritySeatPreflight as checkSeats} from '../game/v3-authority-seat-preflight.mjs';

// Explicit opt-in: general V3 mock suites do not require Chromium.
const executable=process.env.V3_CHROMIUM;
const active=typeof executable==='string'&&executable.startsWith('/');
const here=dirname(fileURLToPath(import.meta.url));
const original=readFileSync(resolve(here,'../noname/game/index.js'),'utf8');
const start=original.indexOf('\n\trandomMapOL(type) {');
const end=original.indexOf('\n\tcloseMenu() {',start);
if(start<0||end<0)throw new Error('V3_NATIVE_RANDOM_MAP_SOURCE_CHANGED');
const method=original.slice(start+1,end).trim();

function experiment(seatCount){
 // Test-only injection into a dedicated blank Chromium page, not a rule engine.
 // The extracted randomMapOL body is the ORIGINAL project source, with real DOM
 // document.createElement used for the host and players.
 const source=`(()=>{
  Array.prototype.randomRemove=function(){return this.pop()};
  let n=0;
  const clients=Array.from({length:${seatCount}},(_,i)=>({id:'ws_'+i,nickname:'真人'+i}));
  const game={players:[],me:null,
   prepareArena(){this.players=Array.from({length:${seatCount}},(_,i)=>{
    const element=document.createElement('div');
    element.dataset.seat=''+i;
    element.setNickname=function(){this.dataset.nickname=this.nickname};
    return element;
   })},
   broadcast(f,map){this.map=map},chooseCharacterOL(){this.started=true}
  };
  const lib={node:{clients},playerOL:{},configOL:{mode:'xingBei',xingBei_mode:'2v2'}};
  const ui={arena:{classList:{add(){}}},create:{player(){return document.createElement('div')}}};
  const get={id(){return 'auto_'+(++n)},connectNickname(){return 'HOST'}};
  const _status={};
  const method=Function('game','lib','ui','get','_status','return ({'+${JSON.stringify(method)}+'}).randomMapOL')(game,lib,ui,get,_status);
  method();
  window.__v3_worker_seat_proof={seatCount:${seatCount},
   gameRulesLoaded:false,
   hostIsNotPlayer:!game.players.includes(game.me),
   hostHasNoPlayerId:!game.me.playerid,
   allSeatsPeerBound:game.players.every(p=>p.ws && p.ws.id===p.playerid),
   allPeerIds:game.map.map(x=>x[0]),
   started:game.started===true,
   nativePlayerNodes:game.players.every(p=>p instanceof HTMLDivElement)
  };
  return window.__v3_worker_seat_proof;
 })()`;
 return source;
}
const sessions=n=>Array.from({length:n},(_,seat)=>({seat,connected:true,connectionId:'ws_'+seat}));

for(const [mode,count] of [['2v2',4],['3v3',6],['4v4',8]]){
 test(`native off-board mapping executes in real Chromium for ${mode}`,{skip:!active},async()=>{
  assert.equal(checkSeats({mode,sessions:sessions(count),workerClientIds:sessions(count).map(s=>s.connectionId)}).ok,true);
  const worker=await launch({executable});
  try{
   assert.equal((await worker.inspect()).offboard,true);
   const result=await worker.evaluateSeatExperiment(experiment(count));
   assert.equal(result.hostIsNotPlayer,true);
   assert.equal(result.hostHasNoPlayerId,true);
   assert.equal(result.allSeatsPeerBound,true);
   assert.equal(result.nativePlayerNodes,true);
   assert.equal(result.started,true);
   assert.equal(result.allPeerIds.length,count);
   assert.deepEqual(new Set(result.allPeerIds),new Set(sessions(count).map(s=>s.connectionId)));
  }finally{await worker.stop()}
 });
}

test('creator disconnect cannot terminate an independently managed worker',{skip:!active},async()=>{
 const worker=await launch({executable});
 try{
  const initial=await worker.inspect();
  const result=await worker.evaluateSeatExperiment(experiment(4));
  assert.equal(result.allSeatsPeerBound,true);
  // Simulate a transport disconnect, NOT an actual WebSocket roundtrip.
  const roster=sessions(4);
  roster[0].connected=false;
  assert.equal(checkSeats({mode:'2v2',sessions:roster,workerClientIds:roster.map(s=>s.connectionId)}).code,'INVALID_SESSION_TOPOLOGY');
  const after=await worker.inspect();
  assert.equal(after.pid,initial.pid);
  assert.equal(after.offboard,true);
  assert.equal(after.gameRulesLoaded,false);
 }finally{await worker.stop()}
});

test('worker process death fails closed instead of claiming state restoration',{skip:!active},async()=>{
 const worker=await launch({executable});
 try{
  assert.equal((await worker.inspect()).alive,true);
  process.kill(worker.pid,'SIGKILL');
  await sleep(150);
  await assert.rejects(worker.inspect());
 }finally{await worker.stop()}
});

test('worker API never permits browser experimentation in normal deployment',{skip:!active},async()=>{
 const worker=await launch({executable});
 try{
  delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  await assert.rejects(worker.evaluateSeatExperiment('1+1'),{code:'WORKER_EXPERIMENT_DISABLED'});
  assert.equal((await worker.inspect()).statePersisted,false);
 }finally{await worker.stop()}
});
