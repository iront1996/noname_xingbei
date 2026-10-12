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
