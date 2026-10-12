import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {handleSeatRecoveryControl} from "../noname/util/xingbei-recovery-protocol.js";
import {saveSeatCredentials,loadSeatCredentials} from "../noname/util/xingbei-seat-credentials.js";
import {validateXingbeiSeatSnapshot} from "../noname/util/xingbei-reinit-snapshot.js";

const roomId="ROOM_V2",seatId="GUEST_A",endpoint="wss://hall.example:443";
const token="ab".repeat(32);
class MemoryStorage{
 constructor(){this.items=new Map()}
 getItem(k){return this.items.get(k)??null}
 setItem(k,v){this.items.set(k,String(v))}
 removeItem(k){this.items.delete(k)}
}
function fixture(){
 const storage=new MemoryStorage();
 assert.equal(saveSeatCredentials(storage,endpoint,roomId,seatId,token),true);
 const messages=[];
 const recovery={active:true,phase:"SYNCING",reason:null,
   reject(reason){this.reason=reason;this.active=false},connectionLost(){}};
 const state={roomId,onlineID:seatId,_xingbeiRecovery:recovery,
   _xingbeiReclaimRequested:false,_xingbeiSeatReclaimed:false};
 const opts={state,storage,endpoint,onlineKey:"PUBLIC_KEY",version:"TEST",
   send:(...args)=>messages.push(args)};
 return {state,recovery,storage,opts,messages};
}
const packet=["xbSeatReclaimed",roomId,seatId];
test("unsolicited reclaim success cannot mark a V2 seat restored",()=>{
 const f=fixture();
 assert.equal(handleSeatRecoveryControl(packet,f.opts),true);
 assert.equal(f.state._xingbeiSeatReclaimed,false);
 assert.equal(f.recovery.reason,null);
 assert.equal(f.messages.length,0);
});
test("roomlist only triggers an ordered single broker reclaim request",()=>{
 const f=fixture();
 assert.equal(handleSeatRecoveryControl(["roomlist",[],[],[],seatId],f.opts),true);
 assert.deepEqual(f.messages.map(x=>x.slice(0,2)),[
   ["server","key"],["server","xbResumeSeat"]
 ]);
 assert.equal(f.state._xingbeiReclaimRequested,true);
 assert.equal(handleSeatRecoveryControl(["roomlist"],f.opts),true);
 assert.equal(f.messages.length,2);
 assert.equal(handleSeatRecoveryControl(packet,f.opts),true);
 assert.equal(f.state._xingbeiSeatReclaimed,true);
});
test("stale-phase reclaim ACK and rejection have no effect",()=>{
 const f=fixture();
 handleSeatRecoveryControl(["roomlist"],f.opts);
 f.recovery.phase="CONNECTING";
 assert.equal(handleSeatRecoveryControl(packet,f.opts),true);
 assert.equal(f.state._xingbeiSeatReclaimed,false);
 assert.equal(handleSeatRecoveryControl(["xbSeatResumeRejected"],f.opts),true);
 assert.equal(f.recovery.active,true);
 assert.ok(loadSeatCredentials(f.storage,endpoint));
});
test("unsolicited rejection cannot erase tab credentials",()=>{
 const f=fixture();
 handleSeatRecoveryControl(["xbSeatResumeRejected"],f.opts);
 assert.equal(f.recovery.active,true);
 assert.equal(f.recovery.reason,null);
 assert.equal(loadSeatCredentials(f.storage,endpoint)?.token,token);
});
test("valid broker denial rejects and clears credentials; wrong seat rejects",()=>{
 const f=fixture();
 handleSeatRecoveryControl(["roomlist"],f.opts);
 handleSeatRecoveryControl(["xbSeatResumeRejected"],f.opts);
 assert.equal(f.recovery.active,false);
 assert.equal(f.recovery.reason,"seat_rejected");
 assert.equal(loadSeatCredentials(f.storage,endpoint),null);
 const g=fixture();
 handleSeatRecoveryControl(["roomlist"],g.opts);
 handleSeatRecoveryControl(["xbSeatReclaimed",roomId,"OTHER"],g.opts);
 assert.equal(g.recovery.reason,"seat_mismatch");
 assert.equal(g.state._xingbeiSeatReclaimed,false);
});
test("actual V2 game reinit cannot clear arena before broker claim and SYNCING",()=>{
 const source=readFileSync(new URL("../noname/library/index.js",import.meta.url),"utf8");
 const begin="\t\t\treinit: function (config, state, state2, ip, observe, onreconnect, cardtag, postReconnect) {";
 const end="\t\t\texec: function (func) {";
 const first=source.indexOf(begin),last=source.indexOf(end,first+begin.length);
 assert.ok(first>=0&&last>first);
 let touched=0;
 const sentinel=Symbol("reinit_guard_passed");
 const ui={auto:{show(){touched++;throw sentinel}},pause:{show(){throw sentinel}}};
 const game={ws:{id:"new-transport"},onlineID:seatId,
  _xingbeiRecovery:{active:true,phase:"SYNCING"},
  _xingbeiSeatReclaimed:false};
 const roster={
  number:"1",
  players:{[seatId]:{position:0,handcards:[],gaintag:[],
    equips:[],judges:[],views:[],specials:[],expansions:[],expansion_gaintag:[]}}
 };
 const client=new Function("game","ui","validateXingbeiSeatSnapshot",
   "return ({"+source.slice(first,last)+"})")(game,ui,validateXingbeiSeatSnapshot);
 // No guest seat proof: neither UI nor state initialization may run.
 assert.equal(client.reinit({mode:"xingBei"},roster),undefined);
 assert.equal(touched,0);
 game._xingbeiSeatReclaimed=true;
 game._xingbeiRecovery.phase="CONNECTING";
 assert.equal(client.reinit({mode:"xingBei"},roster),undefined);
 assert.equal(touched,0);
 game._xingbeiRecovery.phase="SYNCING";
 assert.throws(()=>client.reinit({mode:"xingBei"},roster),e=>e===sentinel);
 assert.equal(touched,1,"only confirmed active takeover gets to state application");
 game._xingbeiRecovery.active=false;
 game._xingbeiSeatReclaimed=false;
 assert.throws(()=>client.reinit({mode:"xingBei"},roster),e=>e===sentinel);
 assert.equal(touched,2,"non-recovery legacy reinit remains functional");
 assert.throws(()=>client.reinit({mode:"xingBei"},{}),e=>e===sentinel);
 assert.equal(touched,3,"legacy reinit can still receive a non-B3 payload");
});
