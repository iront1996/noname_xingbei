import test from 'node:test';
import assert from 'node:assert/strict';
import {createV3AuthorityRuntimeCoordinator} from '../game/v3-authority-runtime-coordinator.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';

const executable=process.env.V3_CHROMIUM;
const active=typeof executable==='string'&&executable.startsWith('/');
test('real server-owned Chrome outlives creator and guest reattachments; no gameplay claim',{skip:!active},async()=>{
 let ownedWorker;
 const hub=createV3AuthorityRuntimeCoordinator({launchWorker:async()=>{
  ownedWorker=await launchV3ChromiumAuthorityWorker({executable});
  return ownedWorker;
 }});
 const connections=['real_a','real_b','real_c','real_d'];
 const first=hub.create({roomId:'REAL_POC',config:{mode:'xingBei',seatMode:'2v2'},connectionId:connections[0]});
 const all=[first,...connections.slice(1).map(connectionId=>hub.join({roomId:'REAL_POC',connectionId}))];
 assert.ok(all.every(s=>s.ok));
 try{
  const launched=await hub.launchRoomWorker({roomId:'REAL_POC',workerClientIds:connections});
  assert.equal(launched.code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  assert.equal(launched.statePersisted,false);
  const pid=launched.pid;
  assert.ok(Number.isInteger(pid));
  assert.equal(hub.disconnect({roomId:'REAL_POC',seat:0,connectionId:connections[0]}).ok,true);
  assert.equal(hub.disconnect({roomId:'REAL_POC',seat:2,connectionId:connections[2]}).ok,true);
  assert.equal((await hub.inspectWorker('REAL_POC')).code,'WORKER_PROOF_ALIVE');
  for(const seat of [0,2]){
   const next=hub.reconnect({roomId:'REAL_POC',seat,connectionId:'resumed_'+seat,reconnectToken:all[seat].reconnectToken});
   assert.equal(next.ok,true);
   assert.notEqual(next.reconnectToken,all[seat].reconnectToken);
   assert.equal(hub.reconnect({roomId:'REAL_POC',seat,connectionId:'hijack_'+seat,reconnectToken:all[seat].reconnectToken}).ok,false);
  }
  assert.equal((await ownedWorker.inspect()).pid,pid);
  const state=hub.roomView('REAL_POC');
  assert.equal(state.status,'waiting');
  assert.equal(state.roster.every(s=>s.connected),true);
  for(const session of all)assert.equal(JSON.stringify(state).includes(session.reconnectToken),false);
  assert.equal(hub.command({roomId:'REAL_POC',seat:0,connectionId:'resumed_0',action:'attack'}).code,'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{if(ownedWorker)await hub.stopRoomWorker('REAL_POC')}
});
