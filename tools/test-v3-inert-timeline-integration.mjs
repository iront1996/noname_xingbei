import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
 V3_INERT_TIMELINE_SCHEMA,
 reconcileV3InertTimeline,verifyV3InertTimeline
} from "../game/v3-inert-transition-timeline.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const get=path=>readFileSync(resolve(root,path),"utf8");
const vault=get("game/v3-recovery-vault.mjs");
const owner=get("game/v3-owner-connection.mjs");
const entry=get("mode/connect.js");
const observed={
 observerEpoch:"0123456789abcdef0123456789abcdef",
 seq:4,started:2,droppedStarts:0,status:"OBSERVATION_PARTIAL",
 completeCoverage:false,eventContinuationCaptured:false,
 restorable:false,readyToResume:false,
 records:[
 {seq:1,eventOrdinal:0,transition:"started"},
 {seq:2,eventOrdinal:0,transition:"fulfilled"},
 {seq:3,eventOrdinal:1,transition:"started"},
 {seq:4,eventOrdinal:1,transition:"fulfilled"}
 ]
};
test("strict V3-only timeline archives anonymous data, not snapshots or executable events",()=>{
 assert.match(vault,/reconcileV3InertTimeline\(/);
 assert.match(vault,/verifyV3InertTimeline\(/);
 assert.match(vault,/const INERT_TIMELINE_SUFFIX = "::inert-transition-timeline-v1";/);
 assert.match(vault,/async function saveLocalInertTimeline\(/);
 assert.match(vault,/export async function inspectLocalInertTransitionTimeline\(/);
 assert.match(vault,/await saveLocalInertTimeline\(/);
 assert.match(vault,/store\.delete\(roomId \+ INERT_TIMELINE_SUFFIX\)/);
 assert.match(vault,/safeCheckpointCertified: false/);
 assert.match(vault,/eventContinuationCaptured: false/);
 assert.match(vault,/restorable: false/);
 assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
test("timeline and source evidence remain separately encrypted and bound to the room",()=>{
 assert.match(vault,/V3_INERT_TIMELINE_SCHEMA\+":"\+roomId/);
 assert.match(vault,/crypto\.subtle\.encrypt\(\s*\{name:"AES-GCM",iv,additionalData:aad\}/);
 assert.match(vault,/crypto\.subtle\.decrypt\(\s*\{name:"AES-GCM",iv,additionalData:aad\}/);
 assert.match(owner,/事件序列保存/);
 assert.match(owner,/missingTransitions/);
 assert.match(owner,/evictedTransitions/);
 assert.ok(entry.includes("/game/v3-owner-connection.mjs?v=v3-inert-timeline-16"));
 assert.ok(owner.includes('from "./v3-recovery-vault.mjs?v=v3-inert-timeline-16"'));
 assert.doesNotMatch(entry,/import\("\/game\/v3-recovery-vault\.mjs/);
});
test("WebCrypto AEAD room binding rejects different room ID and modified ciphertext",async()=>{
 const {webcrypto}=await import("node:crypto");
 const key=await webcrypto.subtle.generateKey(
   {name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
 const iv=webcrypto.getRandomValues(new Uint8Array(12));
 const timeline=reconcileV3InertTimeline(null,observed).timeline;
 assert.equal(verifyV3InertTimeline(timeline).ok,true);
 const data=new TextEncoder().encode(JSON.stringify(timeline));
 const capturedAt=1760170000000;
 const aad=new TextEncoder().encode(V3_INERT_TIMELINE_SCHEMA+":ROOM-ONE:"+capturedAt);
 const ciphertext=await webcrypto.subtle.encrypt(
   {name:"AES-GCM",iv,additionalData:aad},key,data);
 const decoded=await webcrypto.subtle.decrypt(
   {name:"AES-GCM",iv,additionalData:aad},key,ciphertext);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(decoded)),timeline);
 await assert.rejects(webcrypto.subtle.decrypt({
   name:"AES-GCM",iv,additionalData:new TextEncoder().encode(
      V3_INERT_TIMELINE_SCHEMA+":ROOM-TWO:"+capturedAt)
 },key,ciphertext));
 await assert.rejects(webcrypto.subtle.decrypt({
   name:"AES-GCM",iv,additionalData:new TextEncoder().encode(
     V3_INERT_TIMELINE_SCHEMA+":ROOM-ONE:"+(capturedAt+1000))
 },key,ciphertext));
 const corrupt=new Uint8Array(ciphertext); corrupt[0]^=1;
 await assert.rejects(webcrypto.subtle.decrypt({
   name:"AES-GCM",iv,additionalData:aad},key,corrupt));
});
