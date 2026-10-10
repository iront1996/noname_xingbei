// Offline regression tests: node --test tools/test-v3-host-rehydration.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateColdOwnerPreflight as gate } from "../game/v3-host-authority-gate.mjs";
import { buildHostRehydrationBlueprint as build } from "../game/v3-rehydration-blueprint.mjs";

const card = id => "_noname_card:" + JSON.stringify([id,"shui",2,"gongJi",false]);
function fixture() {
  const candidate = {
    schema:"xingbei-v3-candidate-1",observationKind:"turn_boundary",
    roomId:"ROOM",hostPlayerId:"H",capturedAt:900,
    config:{mode:"xingBei"},arena:{mode:"2v2",players:{
      H:{position:0,name1:"heroH",hp:4,maxHp:4},
      A:{position:1,name1:"heroA",hp:3,maxHp:4},
      B:{position:2,name1:"heroB",hp:4,maxHp:4}
    }},
    peerBindings:[{playerId:"A",socketId:"A"},{playerId:"B",socketId:"B"}],
    nextTurnPlayerId:"A",phaseNumber:3,roundNumber:2,
    drawPile:[card("c1"),card("c2")],discardPile:[card("c3")],
    skills:{H:{},A:{},B:{}},playerExecution:{H:{},A:{},B:{}},
    eventObservation:{stackOutline:[{name:"phaseLoop"}]},
    restorable:false,safeCheckpointCertified:false,
    eventContinuationCaptured:false,playerHistoryCompletenessVerified:false
  };
  const claim = {
    schema:"xingbei-v3-authority-preflight-1",roomId:"ROOM",
    state:"paused_owner_missing",roomStarted:true,
    guestSocketIds:["B","A"],bufferedGuestMessageCount:0
  };
  return {candidate,claim};
}
test("correct mapping builds a private plan but cannot resume",()=>{
  const {candidate,claim}=fixture();
  const result=build(candidate,claim,1000);
  assert.equal(result.ok,true);
  assert.deepEqual(result.blueprint.playerSeats.map(p=>p.originalSeat),[0,1,2]);
  assert.deepEqual(result.blueprint.drawPile.map(c=>c.cardId),["c1","c2"]);
  assert.equal(result.readyToResume,false);
  assert.equal(result.authoritativeRuntimeRebuilt,false);
  assert.equal(JSON.stringify(result.summary).includes("heroH"),false);
});
test("swapped guest socket is rejected",()=>{
  const {candidate,claim}=fixture();claim.guestSocketIds=["A","intruder"];
  assert.equal(build(candidate,claim,1000).code,"ORIGINAL_PEER_SOCKET_MISMATCH");
});
test("duplicate server socket is rejected",()=>{
  const {candidate,claim}=fixture();claim.guestSocketIds=["A","A"];
  assert.equal(gate(candidate,claim,1000).code,"SERVER_ROSTER_INVALID");
});
test("expired or forged checkpoint fails closed",()=>{
  const {candidate,claim}=fixture();
  assert.equal(gate(candidate,claim,1_000_000).code,"CANDIDATE_AGE_INVALID");
  assert.equal(gate({...candidate,restorable:true},claim,1000).code,"CANDIDATE_FLAGS_UNTRUSTED");
});
test("seat collisions and duplicate card IDs fail closed",()=>{
  const {candidate,claim}=fixture();candidate.arena.players.B.position=1;
  assert.equal(build(candidate,claim,1000).code,"PLAYER_SEAT_OR_STATE_INVALID");
  candidate.arena.players.B.position=2;
  candidate.discardPile=[card("c2")];
  assert.equal(build(candidate,claim,1000).code,"DISCARD_PILE_CARD_INVALID_OR_DUPLICATE");
});
test("preflight does not mutate inputs",()=>{
  const {candidate,claim}=fixture(),before=JSON.stringify({candidate,claim});
  assert.equal(build(candidate,claim,1000).readyToResume,false);
  assert.equal(before,JSON.stringify({candidate,claim}));
});

test("four-seat match with one real guest and two AI seats passes only private preflight",()=>{
  const {candidate,claim}=fixture();
  candidate.arena.players.C={position:3,name1:"heroC",hp:4,maxHp:4};
  candidate.skills.C={};
  candidate.playerExecution.C={};
  candidate.peerBindings=[{playerId:"A",socketId:"A"}];
  candidate.botPlayerIds=["B","C"];
  claim.guestSocketIds=["A"];
  candidate.nextTurnPlayerId="B";
  const result=build(candidate,claim,1000);
  assert.equal(result.ok,true);
  assert.equal(result.summary.botSeatsMapped,2);
  assert.equal(result.summary.originalRemoteSocketsMapped,1);
  assert.deepEqual(result.blueprint.botPlayerIds,["B","C"]);
  assert.equal(result.readyToResume,false);
});
test("incomplete bot enumeration never impersonates missing human socket",()=>{
  const {candidate,claim}=fixture();
  candidate.peerBindings=[{playerId:"A",socketId:"A"}];
  claim.guestSocketIds=["A"];
  assert.equal(gate(candidate,claim,1000).code,"PLAYER_SET_INCONSISTENT");
  candidate.botPlayerIds=["B"];
  assert.equal(gate(candidate,claim,1000).ok,true);
  candidate.botPlayerIds=["B","B"];
  assert.equal(gate(candidate,claim,1000).code,"PLAYER_SET_INCONSISTENT");
  candidate.botPlayerIds=["H"];
  assert.equal(gate(candidate,claim,1000).code,"BOT_SEAT_INVALID");
});
test("forged bot/human overlap or changed broker roster is rejected",()=>{
  const {candidate,claim}=fixture();
  candidate.peerBindings=[{playerId:"A",socketId:"A"}];
  candidate.botPlayerIds=["B"];
  claim.guestSocketIds=["A"];
  candidate.botPlayerIds=["A"];
  assert.equal(gate(candidate,claim,1000).code,"GAME_STATE_SHAPE_INCOMPLETE");
  candidate.botPlayerIds=["B"];
  claim.guestSocketIds=["A","UNKNOWN"];
  assert.equal(gate(candidate,claim,1000).code,"PLAYER_SET_INCONSISTENT");
});
