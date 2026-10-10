/**
 * V3 dedicated-authority worker: pure, fail-closed seat mapping preflight.
 * The broker MUST authenticate sessions before passing them here. Neither
 * browser-supplied player IDs nor self-reported isNonameServer are proof of
 * session ownership. This module alone does not start an authoritative game.
 */
const SIZES=Object.freeze({'2v2':4,'3v3':6,'4v4':8});
const goodId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
const reject=code=>Object.freeze({ok:false,code});

export function validateV3AuthoritySeatPreflight({mode,sessions,workerClientIds}={}){
 if(typeof mode!=='string'||!Object.hasOwn(SIZES,mode))return reject('INVALID_MODE');
 const count=SIZES[mode];
 if(!Array.isArray(sessions)||!Array.isArray(workerClientIds)||
    sessions.length!==count||workerClientIds.length!==count)
   return reject('INCOMPLETE_ROSTER');
 const seats=new Set(),connections=new Set();
 for(const session of sessions){
  if(!session||typeof session!=='object'||Array.isArray(session)||
     !Number.isInteger(session.seat)||session.seat<0||session.seat>=count||
     !goodId(session.connectionId)||session.connected!==true||
     seats.has(session.seat)||connections.has(session.connectionId))
   return reject('INVALID_SESSION_TOPOLOGY');
  seats.add(session.seat);connections.add(session.connectionId);
 }
 const workerSeen=new Set();
 for(const id of workerClientIds){
  if(!goodId(id)||workerSeen.has(id)||!connections.has(id))
   return reject('WORKER_SOCKET_MISMATCH');
  workerSeen.add(id);
 }
 return Object.freeze({ok:true,code:'TOPOLOGY_READY',seatCount:count});
}
