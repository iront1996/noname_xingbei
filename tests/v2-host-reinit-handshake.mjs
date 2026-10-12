import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const s=readFileSync(new URL("../noname/library/index.js",import.meta.url),"utf8");
const start=s.indexOf("\t\t\tinit(version, config, banned_info) {");
const end=s.indexOf("\t\t\txbChoiceHello(protocolVersion) {",start);
assert.ok(start>=0&&end>start);
const src=s.slice(start,end);
function setup(){
 const sent=[],broadcasts=[],diagnostics=[],marks=[];
 const old={id:"seat_01",closed:false};
 const seat={playerid:"seat_01",nickname:"Guest",ws:old,isAuto:true,setNickname(){marks.push("nickname")}};
 const clients=[old];clients.remove=function(x){const i=this.indexOf(x);if(i>=0)this.splice(i,1)};
 const observing=[];observing.remove=function(x){const i=this.indexOf(x);if(i>=0)this.splice(i,1)};
 const lib={
  versionOL:"VERSION",version:"VERSION",config:{banBlacklist:[]},
  configOL:{mode:"xingBei",number:4},playerOL:{seat_01:seat},
  node:{banned:[],clients,observing,
   xingbeiProgressTracker:{bind(...args){diagnostics.push(args);return true}}}
 };
 const game={
  ip:"127.0.0.1",players:[{marks:{poison:1},markSkill(k){marks.push("mark:"+k)}}],
  getState(){return {phase:2}},broadcast(...args){broadcasts.push(args)}
 };
 const get={arenaState(){return {players:{seat_01:{hp:3}}}},config(){return false}};
 const _status={waitingForPlayer:false,onreconnect:null,cardtag:null,postReconnect:null};
 const window={isNonameServer:false};
 const host=new Function("lib","game","get","_status","window","return ({"+src+"})")(lib,game,get,_status,window);
 const current={id:"seat_01",inited:false,closed:false,send(...args){sent.push(args)}};
 const cfg={id:"seat_01",onlineKey:"PUBLIC_KEY"};
 return {host,lib,game,_status,current,old,seat,cfg,sent,broadcasts,diagnostics,marks,
  reconnect(){host.init.call(current,"VERSION",cfg,"remote")}};
}
test("V2 broker-bound seat is not ready before host reinit ACK",()=>{
 const f=setup();f.reconnect();
 assert.equal(f.seat.ws,f.current);
 assert.equal(f.old.closed,true);
 assert.equal(f.current.inited,false);
 assert.deepEqual(f.current._xingbeiReinitPending,{seatId:"seat_01"});
 assert.equal(f.sent[0][0],"reinit");
 assert.equal(f.seat.isAuto,true);
 assert.equal(f.broadcasts.length,0);
 f.host.xbProgressHello.call(f.current,1);
 assert.equal(f.diagnostics.length,0);
});
test("inited, unsolicited and wrong-seat ACKs cannot skip reinit",()=>{
 const f=setup();f.reconnect();
 f.host.inited.call(f.current);
 assert.equal(f.current.inited,false);
 const impostor={id:"wrong",inited:false,closed:false,_xingbeiReinitPending:{seatId:"seat_01"}};
 f.host.reinited.call(impostor);
 assert.equal(impostor.inited,false);
 f.host.reinited.call(f.old);
 assert.equal(f.seat.isAuto,true);
 assert.equal(f.broadcasts.length,0);
});
test("current ACK enables seat and C3 monitoring exactly once",()=>{
 const f=setup();f.reconnect();
 f.host.reinited.call(f.current);
 assert.equal(f.current.inited,true);
 assert.equal(f.current._xingbeiReinitPending,null);
 assert.equal(f.seat.isAuto,false);
 assert.deepEqual(f.marks,["nickname","mark:poison"]);
 assert.equal(f.broadcasts.length,1);
 f.host.xbProgressHello.call(f.current,1);
 assert.equal(f.diagnostics.length,1);
 assert.equal(f.diagnostics[0][0],"seat_01");
 assert.equal(f.diagnostics[0][1],f.current);
 f.host.reinited.call(f.current);
 assert.equal(f.broadcasts.length,1);
});
test("superseded socket ACK cannot mark player ready",()=>{
 const f=setup();f.reconnect();
 f.seat.ws={id:"seat_01"};f.current.closed=true;
 f.host.reinited.call(f.current);
 assert.equal(f.current.inited,false);
 assert.equal(f.seat.isAuto,true);
});
test("legacy lobby inited remains available while unsolicited reinited fails",()=>{
 const f=setup();f._status.waitingForPlayer=true;
 let updateCount=0;f.game.updateWaiting=()=>updateCount++;
 const join={id:"new",closed:false,inited:false};
 f.host.inited.call(join);
 assert.equal(join.inited,true);
 assert.equal(updateCount,1);
 const ghost={id:"ghost",closed:false,inited:false};
 f.host.reinited.call(ghost);
 assert.equal(ghost.inited,false);
});
test("public config ID cannot rebind a different broker socket",()=>{
 const f=setup();const wrong={id:"wrong",closed:false,inited:false,send(){}};
 f.host.init.call(wrong,"VERSION",f.cfg,"remote");
 assert.equal(f.seat.ws,f.old);
 assert.equal(f.seat.isAuto,true);
 assert.equal(wrong._xingbeiReinitPending,undefined);
});


test("pending choice survives authenticated reinit without lending its ticket to an old socket",async()=>{
 const {ChoiceLeaseRegistry}=await import("../noname/util/xingbei-choice-lease.js");
 const f=setup();
 const leases=new ChoiceLeaseRegistry({now:()=>1000});
 f.lib.node.xingbeiChoiceLeases=leases;
 const issued=leases.open("seat_01",{socket:f.old,timeoutMs:40000});
 const originalDeadline=issued.deadlineAt;
 f.seat._xingbeiChoiceRequired=true; // strict C2 mode stays mandatory after takeover
 let settled=0;
 f.seat.unwait=(answer)=>{
  settled++;
  leases.settle("seat_01");
 };
 const first=s.indexOf("\t\t\txbChoiceHello(protocolVersion) {");
 const last=s.indexOf("\t\t\tstartGame() {",first);
 assert.ok(first>=0&&last>first);
 const c2=new Function("lib","return ({"+s.slice(first,last)+"})")(f.lib);
 // Old transport is bound to the pending choice before reinit.
 f.reconnect();
 assert.equal(f.current.inited,false);
 assert.equal(f.seat.ws,f.current);
 c2.xbChoiceHello.call(f.current,1);
 assert.equal(f.sent.filter(x=>x[0]==="xbChoiceLease").length,0,
  "no choice may be offered before host reinit confirmation");
 c2.result.call(f.old,{bool:true},issued.wireId);
 c2.result.call(f.current,{bool:true},issued.wireId);
 assert.equal(settled,0);
 f.host.reinited.call(f.current);
 assert.equal(f.current.inited,true);
 c2.xbChoiceHello.call(f.current,1);
 const leasePackets=f.sent.filter(x=>x[0]==="xbChoiceLease");
 assert.deepEqual(leasePackets,[["xbChoiceLease",issued.wireId]]);
 assert.equal(issued.deadlineAt,originalDeadline,
  "reconnecting must not silently extend an existing choice timer");
 assert.equal(f.seat._xingbeiChoiceRequired,true);
 assert.equal(f.current._xingbeiChoiceV2,true);
 // The actual guest ticket handler receives the current original wire ID.
 const cStart=s.indexOf("\t\t\txbChoiceLease(wireId) {");
 const cEnd=s.indexOf("\t\t\tlog: function",cStart);
 assert.ok(cStart>=0&&cEnd>cStart);
 const guest={_xingbeiChoiceTicket:null};
 const clientHandlers=new Function("game","return ({"+s.slice(cStart,cEnd)+"})")(guest);
 clientHandlers.xbChoiceLease(issued.wireId);
 assert.equal(guest._xingbeiChoiceTicket,issued.wireId);
 // Missing, forged and replayed/obsolete results remain rejected.
 c2.result.call(f.current,{bool:true},null);
 c2.result.call(f.current,{bool:true},"c2:dead");
 c2.result.call(f.old,{bool:true},issued.wireId);
 assert.equal(settled,0);
 c2.result.call(f.current,{bool:true},guest._xingbeiChoiceTicket);
 assert.equal(settled,1);
 assert.equal(leases.current("seat_01"),null);
 c2.result.call(f.current,{bool:true},guest._xingbeiChoiceTicket);
 assert.equal(settled,1,"a duplicate answer cannot complete a settled lease");
 clientHandlers.xbChoiceSettled(issued.wireId);
 assert.equal(guest._xingbeiChoiceTicket,null);
});
test("newer choice lease cannot be cleared by old client's settled message",()=>{
 const start=s.indexOf("\t\t\txbChoiceLease(wireId) {");
 const end=s.indexOf("\t\t\tlog: function",start);
 assert.ok(start>=0&&end>start);
 const guest={_xingbeiChoiceTicket:null};
 const handlers=new Function("game","return ({"+s.slice(start,end)+"})")(guest);
 handlers.xbChoiceLease("c2:1");
 handlers.xbChoiceLease("c2:2");
 handlers.xbChoiceSettled("c2:1");
 assert.equal(guest._xingbeiChoiceTicket,"c2:2");
 handlers.xbChoiceSettled("c2:2");
 assert.equal(guest._xingbeiChoiceTicket,null);
});
