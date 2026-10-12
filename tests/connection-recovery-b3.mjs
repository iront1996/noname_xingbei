import assert from "node:assert/strict";
import {saveSeatCredentials,loadSeatCredentials,clearSeatCredentials} from "../noname/util/xingbei-seat-credentials.js";
import {handleSeatRecoveryControl} from "../noname/util/xingbei-recovery-protocol.js";
import {ConnectionRecovery} from "../noname/util/xingbei-connection-recovery.js";

class MemoryStorage {
  constructor(){this.map=new Map();}
  setItem(k,v){this.map.set(k,String(v));}
  getItem(k){return this.map.get(k)??null;}
  removeItem(k){this.map.delete(k);}
}
const storage=new MemoryStorage();
const endpoint="wss://hall.example:8080";
const seat={roomId:"roomA",seatId:"guest1",token:"ab".repeat(32)};
const sent=[];
let rejected=null;
const recovery={active:true,reject(reason){rejected=reason;this.active=false;},connectionLost(){}};
const state={roomId:seat.roomId,onlineID:seat.seatId,_xingbeiRecovery:recovery};
const args={state,storage,endpoint,onlineKey:"public-key",version:"v",send:(...packet)=>sent.push(packet)};
assert.equal(handleSeatRecoveryControl(["xbSeatCredentials",seat.roomId,seat.seatId,seat.token],args),true);
assert.deepEqual(loadSeatCredentials(storage,endpoint),seat);
assert.equal(loadSeatCredentials(storage,"other-server"),null,"endpoint isolated");
assert.equal(handleSeatRecoveryControl(["roomlist",[]],args),true,"lobby reset consumed");
assert.deepEqual(sent,[
  ["server","key",["public-key","v"]],
  ["server","xbResumeSeat",seat.roomId,seat.seatId,seat.token]
]);
handleSeatRecoveryControl(["roomlist",[]],args);
assert.equal(sent.length,2,"duplicate roomlist cannot duplicate claim");
assert.equal(handleSeatRecoveryControl(["xbSeatReclaimed",seat.roomId,seat.seatId],args),true);
assert.equal(state._xingbeiSeatReclaimed,true);
assert.equal(handleSeatRecoveryControl(["other",1],args),false);
recovery.active=false;
assert.equal(handleSeatRecoveryControl(["roomlist",[]],args),false,"normal lobby allowed");
recovery.active=true;
assert.equal(handleSeatRecoveryControl(["xbSeatResumeRejected"],args),true);
assert.equal(rejected,"seat_rejected");
assert.equal(loadSeatCredentials(storage,endpoint),null,"rejected token forgotten");
assert.equal(state._xingbeiSuppressRecovery,true);
assert.equal(saveSeatCredentials(storage,endpoint,seat.roomId,seat.seatId,"NOT-A-TOKEN"),false);
assert.equal(saveSeatCredentials(storage,endpoint,seat.roomId,seat.seatId,seat.token),true);
const other={...args,state:{roomId:"wrong",onlineID:seat.seatId,_xingbeiRecovery:{active:true,reject(r){this.reason=r;},connectionLost(){}}}};
assert.equal(handleSeatRecoveryControl(["roomlist"],other),true);
assert.equal(other.state._xingbeiRecovery.reason,"missing_seat_credentials");
assert.equal(other.state._xingbeiSuppressRecovery,true);
assert.equal(handleSeatRecoveryControl(["xbSeatCredentials",seat.roomId,seat.seatId,seat.token],{...args,storage:{setItem(){throw Error('blocked')}}}),true);
clearSeatCredentials(storage,endpoint);
assert.equal(loadSeatCredentials(storage,endpoint),null);

let time=0, timerId=0;
const scheduled=new Map();
const sockets=[];
const manager=new ConnectionRecovery({
 connect(_endpoint,cb){sockets.push(cb);},
 now:()=>time,setTimer:(fn,ms)=>{const id=++timerId;scheduled.set(id,{fn,at:time+ms});return id;},
 clearTimer:id=>scheduled.delete(id)
});
function advance(ms){
 const until=time+ms;
 while(true){
  const due=[...scheduled].filter(([,task])=>task.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
  if(!due)break;
  time=due[1].at;scheduled.delete(due[0]);due[1].fn();
 }
 time=until;
}
assert.equal(manager.start(endpoint),true);
advance(0);assert.equal(sockets.length,1);
sockets[0](true);
assert.equal(manager.phase,"SYNCING");
assert.equal(manager.synchronized("roomlist"),false,"transport connection != restored game");
assert.equal(manager.synchronized("reinit"),true);
assert.equal(manager.phase,"RECOVERED");
console.log("PASS B3 browser credential and handshake contract");
