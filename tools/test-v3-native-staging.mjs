// Offline regression tests: node --test tools/test-v3-native-staging.mjs
// All fixtures are synthetic; no real hands or private user data are logged.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHostRehydrationBlueprint } from "../game/v3-rehydration-blueprint.mjs";
import { stageDetachedHostRuntime } from "../game/v3-host-runtime-stager.mjs";

const c = id => "_noname_card:" + JSON.stringify([id, "feng", 1, "gongJi", null]);
function fixture() {
  const seat = (pos, name, handcards = []) => ({
    position:pos, name1:name, hp:4, maxHp:4, dead:false,
    handcards, equips:[], judges:[], expansions:[], specials:[],
  });
  const candidate = {
    schema:"xingbei-v3-candidate-1", observationKind:"turn_boundary",
    roomId:"ROOM", hostPlayerId:"H", capturedAt:100,
    config:{ mode:"xingBei" },
    arena:{mode:"2v2", players:{
      H:seat(0,"host",[c("h1")]),
      A:seat(1,"guestA",[c("h2")]),
      B:seat(2,"guestB"),
    }},
    peerBindings:[{playerId:"A",socketId:"A"},{playerId:"B",socketId:"B"}],
    nextTurnPlayerId:"A", phaseNumber:2, roundNumber:1,
    drawPile:[c("d1"),c("d2")], discardPile:[c("x1")],
    skills:{H:{},A:{},B:{}},
    playerExecution:{H:{},A:{},B:{}},
    eventObservation:{stackOutline:[{name:"phaseLoop"}]},
    restorable:false, safeCheckpointCertified:false,
    eventContinuationCaptured:false, playerHistoryCompletenessVerified:false,
  };
  const claim = {
    schema:"xingbei-v3-authority-preflight-1", roomId:"ROOM",
    state:"paused_owner_missing", roomStarted:true,
    guestSocketIds:["A","B"], bufferedGuestMessageCount:0,
  };
  return {candidate,claim};
}

function mockNative() {
  const stats = {players:0,cards:0,networkSends:0,cardInitCalls:0};
  class Player {
    constructor(root) { this.dataset={};root.appendChild(this); }
    buildProperty() { stats.players++; this.storage={}; }
    buildNode() { this.node={}; }
  }
  class Card {
    constructor(root) { root.appendChild(this); }
    build() { stats.cards++; this.node={}; }
    init() { stats.cardInitCalls++; }
  }
  class NodeWS { constructor(id) { this.wsid=id; } send() { stats.networkSends++; } }
  class Client {
    constructor(ws) { this.ws=ws;this.id=ws.wsid;this.closed=false; }
    send() { if (!this.closed) stats.networkSends++; }
  }
  const env={
    element:{ Player,Card,NodeWS,Client },
    createFragment:()=>({
      children:[],
      appendChild(child){this.children.push(child);},
      replaceChildren(){this.children.length=0;},
    }),
  };
  return {stats,env};
}

function stageFixture(candidate, claim, env) {
  const plan=buildHostRehydrationBlueprint(candidate,claim,101);
  assert.equal(plan.ok,true);
  return stageDetachedHostRuntime(plan.blueprint,env);
}

test("native player, card and dormant Client objects are private and not playable",()=>{
  const {candidate,claim}=fixture(),{stats,env}=mockNative();
  const before=JSON.stringify({candidate,claim});
  const staged=stageFixture(candidate,claim,env);
  assert.equal(staged.ok,true);
  assert.equal(staged.summary.nativePlayersStaged,3);
  assert.equal(staged.summary.nativeCardsStaged,5);
  assert.equal(staged.summary.dormantRemoteClientsStaged,2);
  assert.equal(staged.runtime.players.get("H").player.nextSeat.playerid,"A");
  assert.deepEqual([...staged.runtime.cards.keys()],["h1","h2","d1","d2","x1"]);
  assert.equal([...staged.runtime.dormantRemoteClients.values()].every(c=>c.closed),true);
  assert.equal(stats.networkSends,0);
  assert.equal(stats.cardInitCalls,0);
  assert.equal(staged.readyToResume,false);
  assert.equal(staged.authoritativeRuntimeRebuilt,false);
  assert.equal(JSON.stringify({candidate,claim}),before);
});

test("duplicate physical card IDs are rejected before any native construction",()=>{
  const {candidate,claim}=fixture(),{stats,env}=mockNative();
  candidate.arena.players.H.handcards=[c("d1")];
  const stage=stageFixture(candidate,claim,env);
  assert.equal(stage.ok,false);
  assert.equal(stage.code,"CARD_REPEATED_ACROSS_ZONES");
  assert.equal(stats.cards+stats.players,0);
});

test("specials alias may reference handcard without duplicating it",()=>{
  const {candidate,claim}=fixture(),{env}=mockNative();
  candidate.arena.players.H.specials=[c("h1")];
  const staged=stageFixture(candidate,claim,env);
  assert.equal(staged.ok,true);
  assert.equal(staged.runtime.cards.size,5);
  assert.deepEqual(staged.runtime.players.get("H").specialCardIds,["h1"]);
});

test("special alias absent from handcards fails closed",()=>{
  const {candidate,claim}=fixture(),{env}=mockNative();
  candidate.arena.players.H.specials=[c("not-in-hand")];
  assert.equal(stageFixture(candidate,claim,env).code,"SPECIAL_ALIAS_NOT_IN_HAND");
});

test("missing player card zone fails before any native objects are created",()=>{
  const {candidate,claim}=fixture(),{stats,env}=mockNative();
  delete candidate.arena.players.A.judges;
  assert.equal(stageFixture(candidate,claim,env).code,"PLAYER_ZONE_MISSING");
  assert.equal(stats.players+stats.cards,0);
});

test("native builder errors are isolated and do not resume the game",()=>{
  const {candidate,claim}=fixture(),{env}=mockNative();
  env.element.Card=class BrokenCard {
    constructor(root){root.appendChild(this)}
    build(){throw new Error("FAIL_NATIVE_CARD_CONSTRUCTION")}
  };
  const staged=stageFixture(candidate,claim,env);
  assert.equal(staged.ok,false);
  assert.equal(staged.code,"FAIL_NATIVE_CARD_CONSTRUCTION");
  assert.equal(staged.readyToResume,false);
});

test("a bot seat receives a native Player but NEVER a fake remote Client",()=>{
  const {candidate,claim}=fixture(),{env,stats}=mockNative();
  candidate.peerBindings=[{playerId:"A",socketId:"A"}];
  candidate.botPlayerIds=["B"];
  claim.guestSocketIds=["A"];
  const stage=stageFixture(candidate,claim,env);
  assert.equal(stage.ok,true);
  assert.equal(stage.runtime.players.size,3);
  assert.equal(stage.runtime.dormantRemoteClients.size,1);
  assert.deepEqual(stage.runtime.botPlayerIds,["B"]);
  assert.equal(stage.summary.botSeatsStaged,1);
  assert.equal(stats.networkSends,0);
  assert.equal(stage.readyToResume,false);
});
