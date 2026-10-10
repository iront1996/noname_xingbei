import test from "node:test";
import assert from "node:assert/strict";
import {createV3AuthoritativeRoomModel as create} from "../game/v3-authoritative-room-model.mjs";

const req=(roomId="MATCH")=>({roomId,connectionId:"socket-creator",
 config:{mode:"xingBei",seatMode:"2v2"}});
const join=(m,socket)=>m.join({roomId:"MATCH",connectionId:socket});
const disconnect=(m,seat,socket)=>m.disconnect({
 roomId:"MATCH",seat,connectionId:socket
});
const reconnect=(m,seat,token,socket)=>m.reconnect({
 roomId:"MATCH",seat,reconnectToken:token,connectionId:socket
});
test("server creates room; creator owns setup privilege, not game processing",()=>{
 const m=create(),a=m.create(req());
 assert.equal(a.ok,true);
 assert.equal(a.code,"ROOM_CREATED");
 assert.equal(a.seat,0);
 assert.equal(a.view.config.seatCount,4);
 assert.equal(a.view.gameRulesLoaded,false);
 assert.equal(a.view.statePersisted,false);
 assert.equal(a.view.status,"waiting");
 assert.equal(m.create(req()).code,"ROOM_EXISTS");
 assert.equal(join(m,"socket-b").seat,1);
 assert.equal(m.configure({roomId:"MATCH",seat:1,connectionId:"socket-b",
   config:{mode:"xingBei",seatMode:"3v3"}}).code,"SETUP_PRIVILEGE_REQUIRED");
 assert.equal(m.configure({roomId:"MATCH",seat:0,connectionId:"socket-creator",
   config:{mode:"xingBei",seatMode:"3v3"}}).code,"CONFIG_LOCKED");
});
test("all players, including creator, share exactly the same reconnect process",()=>{
 const m=create(),a=m.create(req()),b=join(m,"socket-b"),c=join(m,"socket-c");
 assert.equal(disconnect(m,0,"socket-creator").code,"SESSION_DISCONNECTED");
 assert.equal(disconnect(m,2,"socket-c").code,"SESSION_DISCONNECTED");
 let v=m.snapshot("MATCH");
 assert.equal(v.roster.filter(p=>p.connected).length,1);
 assert.equal(v.roster.length,3);
 assert.equal(v.status,"waiting");
 assert.ok(reconnect(m,2,c.reconnectToken,"socket-c-again").ok);
 assert.ok(reconnect(m,0,a.reconnectToken,"socket-creator-again").ok);
 v=m.snapshot("MATCH");
 assert.equal(v.roster.filter(p=>p.connected).length,3);
 assert.equal(v.roster[1].connected,true);
 assert.equal(v.roster[0].seat,0);
 assert.equal(v.roster[2].seat,2);
 assert.equal(b.seat,1);
});
test("reconnection token must match seat; rotates and revokes old credential",()=>{
 const m=create(),a=m.create(req()),b=join(m,"socket-b");
 assert.equal(reconnect(m,1,a.reconnectToken,"intruder").code,"RECONNECT_DENIED");
 assert.equal(reconnect(m,0,b.reconnectToken,"intruder").code,"RECONNECT_DENIED");
 assert.equal(reconnect(m,0,"0".repeat(64),"intruder").code,"RECONNECT_DENIED");
 assert.equal(reconnect(m,0,"INVALID","intruder").code,"RECONNECT_DENIED");
 const resumed=reconnect(m,0,a.reconnectToken,"new-creator");
 assert.equal(resumed.ok,true);
 assert.notEqual(resumed.reconnectToken,a.reconnectToken);
 assert.equal(reconnect(m,0,a.reconnectToken,"thief").code,"RECONNECT_DENIED");
 assert.equal(disconnect(m,0,"socket-creator").code,"SESSION_NOT_CONNECTED");
 assert.equal(disconnect(m,0,"new-creator").ok,true);
 assert.equal(reconnect(m,0,resumed.reconnectToken,"another-device").ok,true);
});
test("room snapshot never reveals credentials, owner pointer or socket identity",()=>{
 const m=create(),a=m.create(req()),b=join(m,"socket-b");
 const json=JSON.stringify(m.snapshot("MATCH"));
 assert.doesNotMatch(json,/socket|token|secret|owner|HOST|PRIVATE/i);
 assert.ok(!json.includes(a.reconnectToken));
 assert.ok(!json.includes(b.reconnectToken));
 assert.equal(m.snapshot("MATCH").roster.length,2);
 assert.equal(m.snapshot("ABSENT"),null);
});
test("room state and settings survive a client disconnect; no owner timer expires it",()=>{
 const m=create(),a=m.create(req());
 assert.equal(m.configure({roomId:"MATCH",seat:0,connectionId:"socket-creator",
   config:{mode:"xingBei",seatMode:"3v3"}}).ok,true);
 const b=join(m,"socket-b"),c=join(m,"socket-c");
 const revision=m.snapshot("MATCH").revision;
 disconnect(m,0,"socket-creator");
 disconnect(m,1,"socket-b");
 disconnect(m,2,"socket-c");
 assert.equal(m.snapshot("MATCH").config.seatMode,"3v3");
 assert.equal(m.snapshot("MATCH").roster.length,3);
 assert.equal(m.snapshot("MATCH").revision,revision+3);
 assert.ok(reconnect(m,0,a.reconnectToken,"socket-a2").ok);
 assert.ok(reconnect(m,1,b.reconnectToken,"socket-b2").ok);
 assert.ok(reconnect(m,2,c.reconnectToken,"socket-c2").ok);
 assert.equal(m.snapshot("MATCH").roster.every(x=>x.connected),true);
});
test("a lobby prototype never claims that card/skill/gameplay intents can be applied",()=>{
 const m=create(),a=m.create(req());
 for(const action of ["attack","choose_card","buy_stone","phase_end","draw","damage",
   "useSkill","star_cup_win"]){
   const outcome=m.command({roomId:"MATCH",seat:0,
     connectionId:"socket-creator",action});
   assert.equal(outcome.ok,false);
   assert.equal(outcome.code,"RULES_ENGINE_NOT_IMPLEMENTED");
 }
 assert.equal(m.command({roomId:"MATCH",seat:0,connectionId:"impostor",
   action:"attack"}).code,"SESSION_NOT_CONNECTED");
 assert.equal(m.snapshot("MATCH").revision,a.view.revision);
});
test("game modes are strict and never execute config getters",()=>{
 const m=create();
 for(const mode of ["1v1","other","custom",null]){
  assert.equal(m.create({...req("m"+String(mode)),config:{mode:"xingBei",seatMode:mode}}).code,
   "CONFIG_INVALID");
 }
 let called=0;const malicious={mode:"xingBei"};
 Object.defineProperty(malicious,"seatMode",{enumerable:true,get(){called++;return "2v2"}});
 assert.equal(m.create({...req("bad"),config:malicious}).code,"CONFIG_INVALID");
 assert.equal(called,0);
 assert.equal(m.create({...req("unknown"),config:{
   mode:"xingBei",seatMode:"2v2",password:"SECRET"}}).code,"CONFIG_INVALID");
});
test("server assigns finite seats; disconnected reservation cannot be hijacked by joining",()=>{
 const m=create(),a=m.create(req());
 join(m,"s1");join(m,"s2");join(m,"s3");
 assert.equal(join(m,"s4").code,"SEAT_UNAVAILABLE");
 disconnect(m,0,"socket-creator");
 assert.equal(join(m,"intruder").code,"SEAT_UNAVAILABLE");
 assert.equal(reconnect(m,0,a.reconnectToken,"new-owner-socket").ok,true);
 assert.equal(m.snapshot("MATCH").roster.length,4);
});
