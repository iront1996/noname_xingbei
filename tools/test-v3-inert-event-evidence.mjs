import test from "node:test";
import assert from "node:assert/strict";
import {
  buildV3InertEvidenceCapsule as build,
  verifyV3InertEvidenceCapsule as verify
} from "../game/v3-inert-event-evidence.mjs";

const now=1760170000000;
function sample(){
  const slot={playerIndex:0,turnIndex:1,bucket:"useSkill",entryIndex:0,
    eventOrdinal:0,lifecycleOrdinal:7,referenceKind:"skill_log"};
  return {
    capturedAt:now,
    lifecycle:{
      status:"OBSERVATION_RING_TRUNCATED",seq:10,
      started:8,fulfilled:6,rejected:0,threw:0,pending:2,
      truncatedTransitions:2,droppedStarts:0,
      completeCoverage:false,eventContinuationCaptured:false,
      restorable:false,readyToResume:false,
      records:[{seq:8,eventOrdinal:7,transition:"started"},
        {seq:10,eventOrdinal:7,transition:"fulfilled"}]
    },
    history:{
      ok:true,code:"INERT_HISTORY_REFERENCE_INDEX_READY",
      ledger:{distinctEventCount:1,eventReferenceCount:2,
        duplicateReferenceCount:1,lifecycleEvidence:"OBSERVED_FULFILLMENT_ONLY",
        slots:[slot,{...slot,bucket:"useCard",entryIndex:1}]}
    },
    cut:{
      code:"CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED",ancestorNext:1,
      ancestorAfter:0,activeLineageNext:1,additionalAncestorNext:0,
      currentNext:0,currentAfter:0,finishedFrames:0,
      safeCheckpointCertified:false,eventContinuationCaptured:false,
      restorable:false,readyToResume:false
    }
  };
}
test("build anonymized bounded ledger with no executable game data",()=>{
 const a=sample();
 a.history.ledger.slots[0].secretSkill="secretSkill";
 a.lifecycle.records[0].playerId="PRIVATE PLAYER";
 a.cut.eventName="PRIVATE EVENT";
 const built=build(a);
 assert.equal(built.ok,true);
 assert.equal(built.capsule.restorable,false);
 assert.equal(built.capsule.safeCheckpointCertified,false);
 assert.equal(built.capsule.eventContinuationCaptured,false);
 assert.equal(built.capsule.readyToResume,false);
 const json=JSON.stringify(built.capsule);
 assert.doesNotMatch(json,/secretSkill|PRIVATE PLAYER|PRIVATE EVENT|token|socketId/);
 assert.equal(verify(JSON.parse(json)).ok,true);
 assert.equal(Object.isFrozen(built.capsule.history.slots),true);
});
test("report aborted history index without pretending a full ledger exists",()=>{
 const a=sample();
 a.history={ok:false,code:"HISTORY_EVENT_IN_ACTIVE_STACK",ledger:null};
 const built=build(a);
 assert.equal(built.ok,true);
 assert.equal(built.capsule.history.eventReferenceCount,0);
 assert.equal(built.capsule.history.code,"HISTORY_EVENT_IN_ACTIVE_STACK");
 assert.equal(verify(JSON.parse(JSON.stringify(built.capsule))).ok,true);
});
test("reject false continuity claims at construction and verification",()=>{
 for(const field of ["restorable","readyToResume","eventContinuationCaptured",
   "safeCheckpointCertified"]){
   const a=sample();
   if(field==="safeCheckpointCertified")a.cut[field]=true;
   else a.lifecycle[field]=true;
   assert.equal(build(a).ok,false);
 }
 const capsule=JSON.parse(JSON.stringify(build(sample()).capsule));
 capsule.restorable=true;
 assert.equal(verify(capsule).ok,false);
});
test("spoofed hidden keys and corrupted ordinals fail verification",()=>{
 const capsule=JSON.parse(JSON.stringify(build(sample()).capsule));
 capsule.hiddenHand="bad";
 assert.equal(verify(capsule).ok,false);
 delete capsule.hiddenHand;
 capsule.history.slots[1].lifecycleOrdinal="bad";
 assert.equal(verify(capsule).ok,false);
});
test("invalid history/cut counts, malformed records, fake bucket and extra fields refuse construction",()=>{
 const a=sample();a.cut.additionalAncestorNext=1;
 assert.equal(build(a).code,"EVIDENCE_CUT_SHAPE_INVALID");
 const b=sample();b.lifecycle.records[1].seq=4;
 assert.equal(build(b).code,"EVIDENCE_EVENT_RECORD_INVALID");
 const c=sample();c.history.ledger.slots[0].bucket="hiddenCards";
 assert.equal(build(c).code,"EVIDENCE_HISTORY_SLOT_INVALID");
 const d=sample();d.history.ledger.duplicateReferenceCount=0;
 assert.equal(build(d).code,"EVIDENCE_HISTORY_LEDGER_INVALID");
 const e=sample();e.lifecycle.records=[...new Array(513)].map((_,i)=>
   ({seq:i+1,eventOrdinal:i,transition:"started"}));
 assert.equal(build(e).code,"EVIDENCE_LIFECYCLE_UNCERTIFIED");
});
test("getter exceptions are never returned as private data",()=>{
 const a=sample();Object.defineProperty(a.history,"ok",{get(){throw Error("private data")}});
 const v=build(a);
 assert.equal(v.ok,false);
 assert.equal(v.code,"EVIDENCE_BUILD_FAILED");
 assert.doesNotMatch(JSON.stringify(v),/private data/);
});
