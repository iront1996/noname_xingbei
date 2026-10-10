// node --test tools/test-v3-registry-transaction.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareShadowHostRegistry as prepare,
  rehearseHostRegistrySwap as rehearse
} from "../game/v3-host-registry-transaction.mjs";

function fixture() {
  const owner={playerid:"H",dataset:{position:"0"}};
  const guest={playerid:"G",dataset:{position:"1"}};
  const client={id:"G",closed:true};
  const card={cardid:"c1"};
  const stage={ok:true,readyToResume:false,runtime:{
    players:new Map([["H",{player:owner}],["G",{player:guest}]]),
    cards:new Map([["c1",card]]),
    dormantRemoteClients:new Map([["G",client]]), botPlayerIds:[]
  }};
  const skills={ok:true,applied:true,readyToResume:false};
  const blueprint={schema:"xingbei-v3-host-runtime-blueprint-1",readyToResume:false,
    hostPlayerId:"H",phaseNumber:3,roundNumber:2,
    playerSeats:[{playerId:"H",originalSeat:0,state:{dead:false}},
      {playerId:"G",originalSeat:1,state:{dead:true}}],
    remoteRoutes:[{playerId:"G",socketId:"G"}], botPlayerIds:[]};
  return {stage,skills,blueprint,owner,guest,client,card};
}
test("shadow registry preserves original owner and dormant guest bindings",()=>{
  const f=fixture();
  const result=prepare(f.stage,f.skills,f.blueprint);
  assert.equal(result.ok,true);
  assert.equal(result.shadow.game.me,f.owner);
  assert.equal(result.shadow.lib.cardOL.c1,f.card);
  assert.equal(result.shadow.lib.clients[0],f.client);
  assert.equal(result.shadow.game.dead[0],f.guest);
  assert.equal(result.readyToResume,false);
});
test("reversible swap restores descriptors even after successful inspection",()=>{
  const f=fixture(),p=prepare(f.stage,f.skills,f.blueprint);
  const players=[];
  const target={game:{players},lib:{node:{clients:[]}}};
  const result=rehearse(p,target,x=>x.game.players[0]===f.owner &&
    x.lib.playerOL.G===f.guest && x.lib.node.clients[0]===f.client);
  assert.equal(result.ok,true);
  assert.equal(result.rolledBack,true);
  assert.equal(target.game.players,players);
  assert.equal(Object.hasOwn(target.lib,"playerOL"),false);
  assert.equal(Object.hasOwn(target.game,"me"),false);
});
test("inspection failure fully rolls back originals",()=>{
  const f=fixture(),p=prepare(f.stage,f.skills,f.blueprint);
  const before={magic:1},originalClients=[];
  const target={game:{players:before},lib:{cardOL:before,node:{clients:originalClients}}};
  const result=rehearse(p,target,()=>{throw Error("TEST_INSPECTION_ERROR")});
  assert.equal(result.ok,false);
  assert.equal(result.code,"TEST_INSPECTION_ERROR");
  assert.equal(target.game.players,before);
  assert.equal(target.lib.cardOL,before);
  assert.equal(target.lib.node.clients,originalClients);
});
test("missing peer or card identity fails before building a shadow",()=>{
  const f=fixture();f.stage.runtime.dormantRemoteClients.get("G").id="impostor";
  assert.equal(prepare(f.stage,f.skills,f.blueprint).code,"UNSAFE_OR_DUPLICATE_CLIENT");
  const g=fixture();g.stage.runtime.cards.get("c1").cardid="DIFFERENT";
  assert.equal(prepare(g.stage,g.skills,g.blueprint).code,"CARD_IDENTITY_CONFLICT");
});
test("no skill materialization means no registries",()=>{
  const f=fixture();
  assert.equal(prepare(f.stage,{ok:false},f.blueprint).code,"PRECONDITIONS_NOT_MET");
});

test("mixed remote human and AI seats map without manufacturing a client",()=>{
  const f=fixture(),bot={playerid:"BOT",dataset:{position:"2"}};
  f.stage.runtime.players.set("BOT",{player:bot});
  f.stage.runtime.botPlayerIds=["BOT"];
  f.blueprint.playerSeats.push({playerId:"BOT",originalSeat:2,state:{dead:false}});
  f.blueprint.botPlayerIds=["BOT"];
  const result=prepare(f.stage,f.skills,f.blueprint);
  assert.equal(result.ok,true);
  assert.equal(result.summary.mappedPlayers,3);
  assert.equal(result.summary.botSeats,1);
  assert.equal(result.shadow.lib.clients.length,1);
  assert.equal(result.shadow.lib.playerOL.BOT,bot);
  assert.equal(result.readyToResume,false);
});
test("shadow rejects forged AI labels or client masquerading as bot",()=>{
  const f=fixture();
  f.blueprint.botPlayerIds=["G"];
  assert.equal(prepare(f.stage,f.skills,f.blueprint).code,"HOST_OR_ROUTES_INVALID");
});
