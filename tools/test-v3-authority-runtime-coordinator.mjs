import test from 'node:test';
import assert from 'node:assert/strict';
import {createV3AuthorityRuntimeCoordinator as coordinator} from '../game/v3-authority-runtime-coordinator.mjs';
const setting={mode:'xingBei',seatMode:'2v2'};
const roster=()=>Array.from({length:4},(_,n)=>'socket_'+n);
const setup=m=>{
 const ids=roster();const creator=m.create({roomId:'R',connectionId:ids[0],config:setting});
 const all=[creator,...ids.slice(1).map(connectionId=>m.join({roomId:'R',connectionId}))];
 assert.ok(all.every(s=>s.ok));
 return {ids,all};
};
const fake=()=>{
 let alive=true,stopped=false;
 return {pid:100,async inspect(){if(!alive)throw Error('CRASHED');return {alive,offboard:true,pid:100,gameRulesLoaded:false,statePersisted:false}},async stop(){stopped=true;alive=false},crash(){alive=false},get stopped(){return stopped}};
};

test('server owns one worker, not creator socket; all seats use same reconnect',async()=>{
 let launches=0;const w=fake();const m=coordinator({launchWorker:async()=>{launches++;return w}});
 const {ids,all}=setup(m);
 const started=await m.launchRoomWorker({roomId:'R',workerClientIds:ids});
 assert.equal(started.code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
 assert.equal(started.gameRulesLoaded,false);
 assert.equal(m.roomView('R').status,'waiting');
 assert.equal(m.disconnect({roomId:'R',seat:0,connectionId:ids[0]}).ok,true);
 assert.equal((await m.inspectWorker('R')).code,'WORKER_PROOF_ALIVE');
 assert.equal(m.roomView('R').roster[0].connected,false);
 assert.equal(m.reconnect({roomId:'R',seat:0,reconnectToken:all[0].reconnectToken,connectionId:'socket_0_back'}).ok,true);
 assert.equal(m.disconnect({roomId:'R',seat:2,connectionId:ids[2]}).ok,true);
 assert.equal(m.reconnect({roomId:'R',seat:2,reconnectToken:all[2].reconnectToken,connectionId:'socket_2_back'}).ok,true);
 assert.equal(launches,1);
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:ids})).code,'WORKER_ALREADY_MANAGED');
 assert.equal((await m.stopRoomWorker('R')).code,'WORKER_STOPPED');
 assert.equal(w.stopped,true);
});

test('incomplete or forged roster cannot start any worker',async()=>{
 let launched=0;const m=coordinator({launchWorker:async()=>{launched++;return fake()}});
 const a=m.create({roomId:'R',connectionId:'socket_0',config:setting});
 assert.equal(a.ok,true);
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:['socket_0']})).code,'INCOMPLETE_ROSTER');
 m.join({roomId:'R',connectionId:'socket_1'});m.join({roomId:'R',connectionId:'socket_2'});m.join({roomId:'R',connectionId:'socket_3'});
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:['socket_0','socket_1','socket_2','forged']})).code,'WORKER_SOCKET_MISMATCH');
 m.disconnect({roomId:'R',seat:0,connectionId:'socket_0'});
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:roster()})).code,'INVALID_SESSION_TOPOLOGY');
 assert.equal(launched,0);
});

test('changing the room during asynchronous worker launch aborts and disposes it',async()=>{
 let release;
 const hold=new Promise(resolve=>{release=resolve});
 const w=fake();const m=coordinator({launchWorker:async()=>{await hold;return w}});
 const {ids}=setup(m);
 const pending=m.launchRoomWorker({roomId:'R',workerClientIds:ids});
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:ids})).code,'WORKER_ALREADY_MANAGED');
 m.disconnect({roomId:'R',seat:0,connectionId:ids[0]});
 release();
 assert.equal((await pending).code,'WORKER_START_ABORTED_ROOM_CHANGED');
 assert.equal(w.stopped,true);
 assert.equal((await m.inspectWorker('R')).code,'WORKER_NOT_STARTED');
});

test('a worker crash fails closed; commands remain rejected without rules',async()=>{
 const w=fake();const m=coordinator({launchWorker:async()=>w});const {ids}=setup(m);
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:ids})).ok,true);
 w.crash();
 assert.equal((await m.inspectWorker('R')).code,'WORKER_UNAVAILABLE');
 assert.equal(m.command({roomId:'R',seat:0,connectionId:ids[0],action:'attack'}).code,'RULES_ENGINE_NOT_IMPLEMENTED');
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:ids})).code,'WORKER_ALREADY_MANAGED');
});

test('invalid worker health or failed launch does not claim a playable game',async()=>{
 const m=coordinator({launchWorker:async()=>({inspect:async()=>({alive:true,offboard:true,gameRulesLoaded:true,statePersisted:false}),stop:async()=>{}})});
 const {ids}=setup(m);
 assert.equal((await m.launchRoomWorker({roomId:'R',workerClientIds:ids})).code,'WORKER_START_FAILED');
 assert.equal(m.roomView('R').status,'waiting');
 assert.equal((await m.inspectWorker('R')).code,'WORKER_NOT_STARTED');
});
