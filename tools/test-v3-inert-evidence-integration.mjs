import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  buildV3InertEvidenceCapsule,verifyV3InertEvidenceCapsule,
  V3_INERT_EVIDENCE_SCHEMA
} from "../game/v3-inert-event-evidence.mjs";

const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(base,path),"utf8");
const vault=read("game/v3-recovery-vault.mjs");
const owner=read("game/v3-owner-connection.mjs");
const entry=read("mode/connect.js");

test("separate evidence save never bypasses strict gameplay snapshot validation",()=>{
  assert.match(vault,/void saveCandidate\(\);\s*void saveInertEventEvidence\(\);/);
  assert.match(vault,/async function saveInertEventEvidence\(/);
  assert.match(vault,/buildV3InertEvidenceCapsule\(/);
  assert.match(vault,/auditV3PlayerHistory\(/);
  assert.match(vault,/safeCheckpointCertified: false/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/restorable: false/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
test("inert evidence is encrypted separately, bound to room, and removed on abandon",()=>{
  assert.match(vault,/const INERT_EVIDENCE_SUFFIX = "::inert-event-evidence-v1"/);
  assert.match(vault,/roomId:roomId\+INERT_EVIDENCE_SUFFIX/);
  assert.match(vault,/crypto\.subtle\.encrypt\(\s*\{name:"AES-GCM",iv,additionalData:aad\}/);
  assert.match(vault,/crypto\.subtle\.decrypt\(\s*\{name:"AES-GCM",iv,additionalData:aad\}/);
  assert.match(vault,/V3_INERT_EVIDENCE_SCHEMA\+":"\+roomId/);
  assert.match(vault,/store\.delete\(roomId \+ INERT_EVIDENCE_SUFFIX\)/);
  assert.match(vault,/evidenceGeneration/);
  assert.match(vault,/activeOwner\(\)/);
});
test("encrypted event evidence is explicitly distinct from game candidate and UI claims",()=>{
  assert.match(owner,/inspectLocalInertEventEvidence\(/);
  assert.match(owner,/本機加密事件證據/);
  assert.match(owner,/證據中的歷史引用/);
  assert.match(owner,/觀測涵蓋完整性：無法認證/);
  assert.match(owner,/前端版本：v3-owner-bootstrap-15/);
  assert.match(vault,/ENCRYPTED_INERT_EVIDENCE_VERIFIED/);
  const version=owner.match(/from "\.\/v3-recovery-vault\.mjs\?v=([^"]+)";/);
  assert.equal(version?.[1],"v3-owner-bootstrap-15");
  assert.ok(owner.includes("installV3RecoveryVault();"));
  assert.ok(entry.includes('/game/v3-owner-connection.mjs?v='+version[1]+'"'));
});
test("AES-GCM rejects wrong room-associated data or tampering with an inert capsule",async()=>{
  // Verifies the exact WebCrypto AEAD shape consumed by the V3 vault.
  const {webcrypto}=await import("node:crypto");
  const key=await webcrypto.subtle.generateKey(
    {name:"AES-GCM",length:256},false,["encrypt","decrypt"]
  );
  const iv=webcrypto.getRandomValues(new Uint8Array(12));
  const input={
    capturedAt:1760170000000,
    lifecycle:{
      status:"OBSERVATION_PARTIAL",seq:1,started:1,fulfilled:0,
      rejected:0,threw:0,pending:1,truncatedTransitions:0,droppedStarts:0,
      completeCoverage:false,eventContinuationCaptured:false,
      restorable:false,readyToResume:false,
      records:[{seq:1,eventOrdinal:0,transition:"started"}]
    },
    history:{ok:false,code:"HISTORY_EVENT_IN_ACTIVE_STACK"},
    cut:{
      code:"CUT_NOT_PHASE_LOOP",ancestorNext:1,ancestorAfter:0,
      activeLineageNext:1,additionalAncestorNext:0,
      currentNext:0,currentAfter:0,finishedFrames:0,
      safeCheckpointCertified:false,eventContinuationCaptured:false,
      restorable:false,readyToResume:false
    }
  };
  const capsule=buildV3InertEvidenceCapsule(input);
  assert.equal(capsule.ok,true);
  const data=new TextEncoder().encode(JSON.stringify(capsule.capsule));
  const aad=new TextEncoder().encode(V3_INERT_EVIDENCE_SCHEMA+":ROOM-A");
  const ciphertext=await webcrypto.subtle.encrypt(
    {name:"AES-GCM",iv,additionalData:aad},key,data
  );
  const decrypted=await webcrypto.subtle.decrypt(
    {name:"AES-GCM",iv,additionalData:aad},key,ciphertext
  );
  assert.equal(verifyV3InertEvidenceCapsule(
    JSON.parse(new TextDecoder().decode(decrypted))
  ).ok,true);
  const wrong=new TextEncoder().encode(V3_INERT_EVIDENCE_SCHEMA+":ROOM-B");
  await assert.rejects(
    webcrypto.subtle.decrypt({name:"AES-GCM",iv,additionalData:wrong},key,ciphertext)
  );
  const modified=new Uint8Array(ciphertext); modified[0]^=1;
  await assert.rejects(
    webcrypto.subtle.decrypt({name:"AES-GCM",iv,additionalData:aad},key,modified)
  );
});
