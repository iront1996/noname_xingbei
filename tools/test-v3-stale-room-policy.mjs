import test from "node:test";
import assert from "node:assert/strict";
import { evaluateV3BlockedRoomStatus as decide } from "../game/v3-stale-room-policy.mjs";

test("authenticated paused room can offer confirmation, not immediate deletion", () => {
  assert.deepEqual(decide("owner_disconnected", true),
    {action:"CONFIRM_ABANDON",canAbandon:true});
});
test("missing or invalid owner token cannot abandon even on a claimed paused status", () => {
  for (const value of [null,false,undefined,"true",1,{}]) {
    assert.deepEqual(decide("owner_disconnected", value),
      {action:"RECHECK_ONLY",canAbandon:false});
  }
});
test("absent room releases the blocked UI but never sends abandon", () => {
  for(const hasToken of [true,false]) {
    assert.deepEqual(decide("room_absent",hasToken),
      {action:"RELOAD_HALL",canAbandon:false});
  }
});
test("unknown, active and forged statuses stay read-only", () => {
  for (const status of [null,"not_available","owner_active","invalid_token",
       "ROOM_UNAVAILABLE","resuming",""]) {
    assert.deepEqual(decide(status,true),{action:"RECHECK_ONLY",canAbandon:false});
  }
});
