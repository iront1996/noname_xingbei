import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectV3CaptureReadiness as readiness,
  publicV3CaptureCode as safeCode,
  makeV3CaptureDiagnostic as diagnostic,
  parseV3CaptureDiagnostic as parse
} from "../game/v3-capture-observability.mjs";

function context() {
  return {
    game: { onlineroom:true, online:false, ws:{readyState:1},
      roomId:"ROOM", players:[{}], me:{playerid:"host"} },
    status: { connectMode:true, gameStarted:true },
    ui: { cardPile:{}, discardPile:{} },
    lib: { node:{clients:[]}, playerOL:{host:{}} },
    get: { arenaState(){}, skillState(){}, stringifiedResult(){},
      cardsInfoOL(){}, itemtype(){} }
  };
}
test("authoritative ready state is metadata-only, not a resumable checkpoint", () => {
  assert.deepEqual(readiness(context()), {ready:true,code:"CAPTURE_READY"});
});
test("non-owner and unstarted matches are not captured", () => {
  const a=context(); a.game.online=true;
  assert.equal(readiness(a).code,"NOT_AUTHORITATIVE_OWNER");
  const b=context(); b.status.gameStarted=false;
  assert.equal(readiness(b).code,"MATCH_NOT_STARTED");
});
test("disconnected socket and missing room/player/piles fail closed", () => {
  const tests=[
    [a=>{a.game.ws.readyState=3},"SOCKET_NOT_OPEN"],
    [a=>{a.game.roomId=""},"ROOM_ID_UNAVAILABLE"],
    [a=>{a.game.players=[]},"PLAYERS_NOT_READY"],
    [a=>{a.ui.discardPile=null},"PILE_NODES_NOT_READY"],
    [a=>{a.lib.node.clients=null},"PEER_ROSTER_UNAVAILABLE"],
    [a=>{a.game.me=null},"HOST_PLAYER_ID_UNAVAILABLE"],
    [a=>{a.lib.playerOL={}},"HOST_PLAYER_RUNTIME_UNAVAILABLE"],
    [a=>{a.get.itemtype=undefined},"ENGINE_GETTERS_UNAVAILABLE"],
  ];
  for(const [mutate,code] of tests) {
    const a=context(); mutate(a);
    assert.deepEqual(readiness(a),{ready:false,code});
  }
});
test("error string sanitizer cannot leak details or secret-shaped messages", () => {
  assert.equal(safeCode("CANDIDATE_STRUCTURE_LOSS"),"CANDIDATE_STRUCTURE_LOSS");
  for(const text of ["", "bearer abc", "key=private", "C:bad", "abcdefghijklmnopqrstuvwxyz", "A".repeat(65), null]) {
    assert.equal(safeCode(text),"UNCLASSIFIED_CAPTURE_ERROR");
  }
});
test("room-local diagnostic metadata survives JSON roundtrip, expires safely", () => {
  const data=diagnostic("CAPTURE_FAILED","PLAYER_SET_MISMATCH","periodic",1000);
  assert.deepEqual(parse(JSON.stringify(data),1100),data);
  assert.equal(parse(JSON.stringify(data),800000),null);
  assert.equal(parse(JSON.stringify({...data,code:"secret payload"}),1100),null);
  assert.equal(parse(JSON.stringify({...data,at:120000}),1100),null);
});
test("saved diagnostic has no error code; invalid status/fields rejected", () => {
  const ok=diagnostic("ENCRYPTED_CANDIDATE_SAVED","secret","turn_boundary",1000);
  assert.equal(ok.code,null);
  assert.deepEqual(parse(JSON.stringify(ok),1100),ok);
  assert.equal(parse(JSON.stringify({...ok,code:"SECRET"}),1100),null);
  assert.throws(()=>diagnostic("RESTORABLE",null,"periodic",1000),/INVALID_DIAGNOSTIC_STATUS/);
  assert.equal(parse("not-json",1100),null);
  assert.equal(parse("x".repeat(600),1100),null);
});
