import test from "node:test";
import assert from "node:assert/strict";
import { classifyV3HostPeerTopology as map } from "../game/v3-peer-topology.mjs";

function roster() {
  const host={playerid:"H"}, human={playerid:"A"}, bot1={playerid:"B"}, bot2={playerid:"C"};
  const client={id:"A",ws:{wsid:"A"},inited:true,closed:false};
  human.ws=client;
  return {
    playerIds:["H","A","B","C"],playerOL:{H:host,A:human,B:bot1,C:bot2},
    clients:[client],observing:[],hostPlayerId:"H"
  };
}
test("one host, one remote human and two AI seats are valid",()=>{
  const f=roster(), result=map(f);
  assert.deepEqual(result,{ok:true,peerBindings:[{playerId:"A",socketId:"A"}],botPlayerIds:["B","C"]});
});
test("one host and three remote humans produce no AI seats",()=>{
  const f=roster();
  for(const id of ["B","C"]) {
    const c={id,ws:{wsid:id},inited:true,closed:false};
    f.clients.push(c); f.playerOL[id].ws=c;
  }
  assert.deepEqual(map(f).botPlayerIds,[]);
});
test("one host and only bots are not supported by paused-room broker",()=>{
  const f=roster();f.clients=[];delete f.playerOL.A.ws;
  assert.equal(map(f).code,"PEER_COUNT_UNSUPPORTED");
});
test("disconnected human is not silently reclassified as AI",()=>{
  const f=roster();f.clients=[];
  assert.equal(map(f).code,"PEER_COUNT_UNSUPPORTED");
  const g=roster();g.clients[0].closed=true;
  assert.equal(map(g).code,"PEER_CLIENT_CLOSED");
  const h=roster();h.clients=[];
  h.clients.push({id:"B",ws:{wsid:"B"},inited:true,closed:false});
  assert.equal(map(h).code,"PEER_PLAYER_SOCKET_MISMATCH");
});
test("socket owner must exactly match live player binding",()=>{
  const f=roster();
  f.playerOL.A.ws={id:"A"};
  assert.equal(map(f).code,"PEER_PLAYER_SOCKET_MISMATCH");
});
test("observers, unknowns, duplicate sockets and uninitialized guests fail closed",()=>{
  const f=roster();f.observing.push(f.clients[0]);
  assert.equal(map(f).code,"PEER_OBSERVER_PRESENT");
  const g=roster();g.clients[0].inited=false;
  assert.equal(map(g).code,"PEER_CLIENT_NOT_INITIALIZED");
  const h=roster();h.clients[0].ws.wsid="intruder";
  assert.equal(map(h).code,"PEER_SOCKET_REBOUND_UNVERIFIED");
  const i=roster();i.clients.push(i.clients[0]);
  assert.equal(map(i).code,"PEER_BINDING_INCOMPLETE");
});
test("extra player sets or host socket impersonation fail",()=>{
  const a=roster();a.playerOL.H.ws=a.clients[0];
  assert.equal(map(a).code,"HOST_PLAYER_MAPPING_INVALID");
  const b=roster();delete b.playerOL.B;
  assert.equal(map(b).code,"PLAYER_RUNTIME_MISSING");
  const c=roster();c.playerIds=["H","A","B","B"];
  assert.equal(map(c).code,"TOPOLOGY_INPUT_INVALID");
});
test("no input is mutated",()=>{
  const f=roster();const ids=[...f.playerIds];
  const before={clientCount:f.clients.length,seatCount:Object.keys(f.playerOL).length,ws:f.playerOL.A.ws};
  assert.equal(map(f).ok,true);
  assert.deepEqual(f.playerIds,ids);
  assert.equal(f.clients.length,before.clientCount);
  assert.equal(Object.keys(f.playerOL).length,before.seatCount);
  assert.equal(f.playerOL.A.ws,before.ws);
});

test("native reconnect changes broker wsid but retains playerid; reject without signed rebind proof",()=>{
  const f=roster(), client=f.clients[0];
  client.id="A";
  client.ws.wsid="NEW-BROKER-ID";
  f.playerOL.A.ws=client;
  assert.deepEqual(map(f),{ok:false,code:"PEER_SOCKET_REBOUND_UNVERIFIED",
    peerBindings:null,botPlayerIds:null});
  const forged=roster(),fake=forged.clients[0];
  fake.ws.wsid="attacker-wsid";
  assert.equal(map(forged).code,"PEER_SOCKET_REBOUND_UNVERIFIED");
});
test("spectators never become active-seat peers for cold-preflight roster",()=>{
  const f=roster();
  const spectator={id:"observer",ws:{wsid:"observer"},inited:true,closed:false};
  f.clients.push(spectator);f.observing.push(spectator);
  assert.equal(map(f).code,"PEER_OBSERVER_PRESENT");
  f.observing.push(f.clients[0]);
  assert.equal(map(f).code,"PEER_OBSERVER_PRESENT");
});
