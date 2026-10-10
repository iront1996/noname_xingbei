import test from 'node:test';
import assert from 'node:assert/strict';
import {validateV3AuthoritySeatPreflight as preflight} from '../game/v3-authority-seat-preflight.mjs';
const sample=(n)=>Array.from({length:n},(_,seat)=>({seat,connectionId:`ws_${seat}`,connected:true}));
const req=(mode,n)=>({mode,sessions:sample(n),workerClientIds:sample(n).map(s=>s.connectionId)});
test('server-owned worker accepts complete 2v2, 3v3 and 4v4 peer rosters',()=>{
 for(const [mode,n] of [['2v2',4],['3v3',6],['4v4',8]]){
  assert.deepEqual(preflight(req(mode,n)),{ok:true,code:'TOPOLOGY_READY',seatCount:n});
 }
});
test('missing peers and phantom extra clients cannot initiate a game',()=>{
 assert.equal(preflight(req('2v2',3)).code,'INCOMPLETE_ROSTER');
 assert.equal(preflight({...req('2v2',4),workerClientIds:['ws_0','ws_1','ws_2']}).code,'INCOMPLETE_ROSTER');
 assert.equal(preflight({...req('2v2',4),workerClientIds:['ws_0','ws_1','ws_2','phantom']}).code,'WORKER_SOCKET_MISMATCH');
});
test('disconnect, duplicate seats and duplicate connected sockets are rejected',()=>{
 const a=req('2v2',4);a.sessions[0].connected=false;
 assert.equal(preflight(a).code,'INVALID_SESSION_TOPOLOGY');
 const b=req('2v2',4);b.sessions[1].seat=0;
 assert.equal(preflight(b).code,'INVALID_SESSION_TOPOLOGY');
 const c=req('2v2',4);c.sessions[1].connectionId='ws_0';
 assert.equal(preflight(c).code,'INVALID_SESSION_TOPOLOGY');
 const d=req('2v2',4);d.workerClientIds[1]='ws_0';
 assert.equal(preflight(d).code,'WORKER_SOCKET_MISMATCH');
});
test('unrecognized mode and malformed identities fail closed',()=>{
 assert.equal(preflight(req('1v1',2)).code,'INVALID_MODE');
 assert.equal(preflight({mode:'2v2',sessions:[],workerClientIds:[]}).code,'INCOMPLETE_ROSTER');
 const a=req('2v2',4);a.sessions[0].connectionId='';
 assert.equal(preflight(a).code,'INVALID_SESSION_TOPOLOGY');
 const b=req('2v2',4);b.workerClientIds[0]='unexpected identity with spaces';
 assert.equal(preflight(b).code,'WORKER_SOCKET_MISMATCH');
});
