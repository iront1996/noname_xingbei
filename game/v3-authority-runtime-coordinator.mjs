/**
 * Experimental server-owned room/worker coordinator. NOT connected to live VPS.
 * Room creation/seat authentication remain with the existing room model;
 * launchWorker starts an isolated browser but DOES NOT make gameplay available.
 * A transport must construct workerClientIds from authenticated broker sockets,
 * never from a client's self-reported seat or ID.
 */
import {createV3AuthoritativeRoomModel} from './v3-authoritative-room-model.mjs';
import {validateV3AuthoritySeatPreflight} from './v3-authority-seat-preflight.mjs';

const no=(code)=>Object.freeze({ok:false,code});
const yes=(code,extra={})=>Object.freeze({ok:true,code,...extra});

export function createV3AuthorityRuntimeCoordinator({launchWorker}={}){
 if(typeof launchWorker!=='function')throw new TypeError('WORKER_FACTORY_REQUIRED');
 const rooms=createV3AuthoritativeRoomModel();
 const managed=new Map();
 const find=id=>managed.get(id);
 const changed=(roomId,revision)=>rooms.snapshot(roomId)?.revision!==revision;
 const cleanup=async worker=>{try{await worker?.stop?.()}catch{ /* fail closed: never treat worker as alive */ }};
 return Object.freeze({
  create(args){
   const result=rooms.create(args);
   if(result.ok)managed.set(args.roomId,{bindings:new Map([[result.seat,args.connectionId]]),worker:null,starting:false});
   return result;
  },
  join(args){
   const result=rooms.join(args);
   if(result.ok)find(args.roomId).bindings.set(result.seat,args.connectionId);
   return result;
  },
  configure(args){return rooms.configure(args)},
  disconnect(args){
   const result=rooms.disconnect(args);
   if(result.ok)find(args.roomId).bindings.set(args.seat,null);
   return result;
  },
  reconnect(args){
   const result=rooms.reconnect(args);
   if(result.ok)find(args.roomId).bindings.set(result.seat,args.connectionId);
   return result;
  },
  roomView(roomId){return rooms.snapshot(roomId)},
  command(args){return rooms.command(args)},
  async launchRoomWorker({roomId,workerClientIds}={}){
   const room=find(roomId),before=rooms.snapshot(roomId);
   if(!room||!before)return no('ROOM_NOT_FOUND');
   if(room.starting||room.worker)return no('WORKER_ALREADY_MANAGED');
   const preflight=validateV3AuthoritySeatPreflight({
    mode:before.config.seatMode,
    sessions:Array.from(room.bindings,([seat,connectionId])=>({seat,connectionId,connected:connectionId!==null})),
    workerClientIds
   });
   if(!preflight.ok)return preflight;
   if(before.status!=='waiting')return no('ROOM_NOT_IN_LOBBY');
   room.starting=true;
   let worker;
   try{
    worker=await launchWorker({roomId,mode:before.config.seatMode,seatCount:preflight.seatCount});
    if(!worker||typeof worker.inspect!=='function'||typeof worker.stop!=='function')
     throw new Error('WORKER_INTERFACE_INVALID');
    const health=await worker.inspect();
    if(health.alive!==true||health.offboard!==true||health.gameRulesLoaded!==false||health.statePersisted!==false)
     throw new Error('WORKER_HEALTH_INVALID');
    if(changed(roomId,before.revision)){
     await cleanup(worker);
     return no('WORKER_START_ABORTED_ROOM_CHANGED');
    }
    room.worker=worker;
    // Never start XingBei or switch room.status to playing here.
    return yes('WORKER_PROOF_RUNNING_NOT_PLAYABLE',{roomId,pid:health.pid,gameRulesLoaded:false,statePersisted:false});
   }catch{
    await cleanup(worker);
    return no('WORKER_START_FAILED');
   }finally{room.starting=false}
  },
  async inspectWorker(roomId){
   const worker=find(roomId)?.worker;
   if(!worker)return no('WORKER_NOT_STARTED');
   try{
    const health=await worker.inspect();
    if(!health||health.alive!==true||health.offboard!==true)return no('WORKER_UNAVAILABLE');
    return yes('WORKER_PROOF_ALIVE',{gameRulesLoaded:false,statePersisted:false});
   }catch{return no('WORKER_UNAVAILABLE')}
  },
  async stopRoomWorker(roomId){
   const room=find(roomId);
   if(!room)return no('ROOM_NOT_FOUND');
   if(room.starting)return no('WORKER_START_IN_PROGRESS');
   if(!room.worker)return no('WORKER_NOT_STARTED');
   const worker=room.worker;
   room.worker=null;
   try{await worker.stop();return yes('WORKER_STOPPED')}
   catch{room.worker=worker;return no('WORKER_STOP_FAILED')}
  }
 });
}
