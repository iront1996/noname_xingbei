import test from "node:test";
import assert from "node:assert/strict";
import { inspectV3EncryptedRecord as inspect } from "../game/v3-candidate-inventory.mjs";

const metadata = {capturedAt:1000,playerCount:2,iv:"encoded-iv",ciphertext:"ciphertext"};
const payload = kind => ({
  schema:"xingbei-v3-candidate-1",roomId:"ROOM",observationKind:kind,capturedAt:1000,
  arena:{players:{HOST:{},GUEST:{}}},restorable:false,
  safeCheckpointCertified:false,eventContinuationCaptured:false,
  playerHistoryCompletenessVerified:false
});
const args = (kind,record=metadata) => ({
  kind,record,roomId:"ROOM",now:2500,decrypt:async()=>payload(kind)
});
test("periodic and turn-boundary candidates validate independently",async()=>{
  assert.deepEqual(await inspect(args("periodic")),
    {status:"ENCRYPTED_CANDIDATE_VERIFIED",ageSeconds:1,playerCount:2});
  assert.equal((await inspect(args("turn_boundary"))).status,"ENCRYPTED_CANDIDATE_VERIFIED");
  assert.equal((await inspect(args("periodic",null))).status,"NOT_FOUND");
  assert.equal((await inspect(args("turn_boundary",null))).status,"NOT_FOUND");
});
test("expired or future candidate is not verified",async()=>{
  assert.equal((await inspect({...args("periodic"),now:800000})).status,"EXPIRED");
  assert.equal((await inspect({...args("periodic"),now:-100000})).code,"RECORD_TIMESTAMP_INVALID");
});
test("tampering with schema, flags or player count is rejected",async()=>{
  const changes=[
    {roomId:"OTHER"}, {restorable:true}, {safeCheckpointCertified:true},
    {eventContinuationCaptured:true}, {playerHistoryCompletenessVerified:true},
    {capturedAt:999}, {arena:{players:{HOST:{}}}}, {observationKind:"turn_boundary"}
  ];
  for (const extra of changes) {
    const verdict=await inspect({...args("periodic"),decrypt:async()=>({...payload("periodic"),...extra})});
    assert.deepEqual(verdict,{status:"UNAVAILABLE",code:"CANDIDATE_SCHEMA_INVALID"});
  }
});
test("corrupt records and decryption errors disclose no plaintext",async()=>{
  assert.deepEqual(await inspect(args("periodic",{...metadata,ciphertext:null})),
    {status:"UNAVAILABLE",code:"RECORD_SHAPE_INVALID"});
  assert.deepEqual(await inspect({...args("periodic"),decrypt:async()=>{throw Error("private hands");}}),
    {status:"UNAVAILABLE",code:"DECRYPT_OR_PARSE_FAILED"});
});
