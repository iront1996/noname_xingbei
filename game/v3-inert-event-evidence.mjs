/**
 * V3 local-only encrypted archival evidence contract.
 *
 * Only anonymous, inert diagnostics may enter this capsule. It is NOT an
 * authoritative checkpoint, an event replay stream, or a recovery token.
 * Every construction/validation path keeps continuation flags explicitly
 * false; no caller may interpret a valid capsule as permission to resume.
 */
export const V3_INERT_EVIDENCE_SCHEMA="xingbei-v3-inert-event-evidence-1";
const MAX_EVENT_RECORDS=512;
const MAX_HISTORY_SLOTS=4096;
const MAX_JSON_BYTES=256*1024;
const BUCKETS=new Set([
  "useCard","respond","skipped","lose","gain",
  "sourceDamage","damage","custom","useSkill"
]);
const TRANSITIONS=new Set(["started","fulfilled","rejected","threw"]);
const STATUS=/^[A-Z][A-Z0-9_]{0,63}$/;

const number=(value,max=1000000000)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const bad=code=>Object.freeze({ok:false,code,capsule:null});
function safeStatus(value) {
  return typeof value==="string"&&STATUS.test(value)?value:"NOT_VERIFIED";
}
function strictKeys(input,names) {
  return input && typeof input==="object" && !Array.isArray(input) &&
    Object.keys(input).sort().join("|")===names.slice().sort().join("|");
}
function immutableCapsule(capsule) {
  Object.freeze(capsule.lifecycle.records);
  Object.freeze(capsule.lifecycle);
  Object.freeze(capsule.history.slots);
  Object.freeze(capsule.history);
  Object.freeze(capsule.cut);
  return Object.freeze(capsule);
}

export function buildV3InertEvidenceCapsule({capturedAt,lifecycle,history,cut}={}) {
  try{
    if(!number(capturedAt,Number.MAX_SAFE_INTEGER) || !lifecycle ||
       !history || !cut)return bad("EVIDENCE_INPUT_UNAVAILABLE");
    const metrics=[
      "seq","started","fulfilled","rejected","threw",
      "pending","truncatedTransitions","droppedStarts"
    ];
    if(metrics.some(key=>!number(lifecycle[key])))return bad("EVIDENCE_LIFECYCLE_INVALID");
    if(lifecycle.completeCoverage!==false ||
       lifecycle.eventContinuationCaptured!==false ||
       lifecycle.restorable!==false || lifecycle.readyToResume!==false ||
       !Array.isArray(lifecycle.records) ||
       lifecycle.records.length>MAX_EVENT_RECORDS) {
      return bad("EVIDENCE_LIFECYCLE_UNCERTIFIED");
    }
    let previous=0;
    const records=[];
    for(const record of lifecycle.records){
      if(!number(record?.seq)||record.seq<=previous ||
         !number(record?.eventOrdinal)||record.eventOrdinal>=1000000||
         !TRANSITIONS.has(record?.transition))return bad("EVIDENCE_EVENT_RECORD_INVALID");
      previous=record.seq;
      records.push(Object.freeze({
        seq:record.seq,eventOrdinal:record.eventOrdinal,transition:record.transition
      }));
    }
    const historyStatus=safeStatus(history.code);
    if(historyStatus==="NOT_VERIFIED")return bad("EVIDENCE_HISTORY_STATUS_INVALID");
    const hasLedger=history.ok===true;
    if(hasLedger !== (historyStatus==="INERT_HISTORY_REFERENCE_INDEX_READY")){
      return bad("EVIDENCE_HISTORY_CONTRADICTORY");
    }
    const ledger=hasLedger?history.ledger:null;
    const slots=[];
    if(hasLedger){
      if(!ledger || !Array.isArray(ledger.slots) ||
         ledger.slots.length>MAX_HISTORY_SLOTS ||
         !number(ledger.distinctEventCount,MAX_HISTORY_SLOTS) ||
         !number(ledger.eventReferenceCount,MAX_HISTORY_SLOTS) ||
         !number(ledger.duplicateReferenceCount,MAX_HISTORY_SLOTS) ||
         ledger.eventReferenceCount!==ledger.slots.length ||
         ledger.distinctEventCount+ledger.duplicateReferenceCount!==ledger.slots.length ||
         ledger.lifecycleEvidence!=="OBSERVED_FULFILLMENT_ONLY") {
        return bad("EVIDENCE_HISTORY_LEDGER_INVALID");
      }
      const unique=new Set();
      for(const slot of ledger.slots){
        if(!number(slot?.playerIndex,7)||!number(slot?.turnIndex,255)||
           !BUCKETS.has(slot?.bucket)||!number(slot?.entryIndex,MAX_HISTORY_SLOTS)||
           !number(slot?.eventOrdinal,MAX_HISTORY_SLOTS)||
           !number(slot?.lifecycleOrdinal,999999)||
           (slot.referenceKind!==undefined && slot.referenceKind!=="skill_log")) {
          return bad("EVIDENCE_HISTORY_SLOT_INVALID");
        }
        unique.add(slot.eventOrdinal);
        slots.push(Object.freeze({
          playerIndex:slot.playerIndex,turnIndex:slot.turnIndex,
          bucket:slot.bucket,entryIndex:slot.entryIndex,
          eventOrdinal:slot.eventOrdinal,lifecycleOrdinal:slot.lifecycleOrdinal,
          ...(slot.referenceKind==="skill_log"?{referenceKind:"skill_log"}:{})
        }));
      }
      if(unique.size!==ledger.distinctEventCount ||
         [...unique].some((id,i)=>id!==i))return bad("EVIDENCE_HISTORY_ORDINAL_INVALID");
    }
    const cutCounters=[
      "ancestorNext","ancestorAfter","activeLineageNext",
      "additionalAncestorNext","currentNext","currentAfter"
    ];
    if(cutCounters.some(key=>!number(cut[key],20000)) ||
       !number(cut.finishedFrames,128)||
       cut.activeLineageNext+cut.additionalAncestorNext!==cut.ancestorNext) {
      return bad("EVIDENCE_CUT_SHAPE_INVALID");
    }
    const cutCode=safeStatus(cut.code);
    if(cutCode==="NOT_VERIFIED" || cut.safeCheckpointCertified!==false ||
       cut.eventContinuationCaptured!==false ||
       cut.restorable!==false || cut.readyToResume!==false) {
      return bad("EVIDENCE_CUT_UNCERTIFIED");
    }
    const capsule=immutableCapsule({
      schema:V3_INERT_EVIDENCE_SCHEMA,
      capturedAt,
      lifecycle:{
        code:safeStatus(lifecycle.status),
        ...Object.fromEntries(metrics.map(key=>[key,lifecycle[key]])),
        records,
        completeCoverage:false,eventContinuationCaptured:false,
        restorable:false,readyToResume:false
      },
      history:{
        code:historyStatus,
        hasLedger,
        eventReferenceCount:slots.length,
        duplicateReferenceCount:hasLedger?ledger.duplicateReferenceCount:0,
        slots
      },
      cut:{
        code:cutCode,
        ...Object.fromEntries(cutCounters.map(key=>[key,cut[key]])),
        finishedFrames:cut.finishedFrames,
        safeCheckpointCertified:false,eventContinuationCaptured:false,
        restorable:false,readyToResume:false
      },
      safeCheckpointCertified:false,
      eventContinuationCaptured:false,
      restorable:false,readyToResume:false
    });
    const text=JSON.stringify(capsule);
    if(new TextEncoder().encode(text).byteLength>MAX_JSON_BYTES){
      return bad("EVIDENCE_TOO_LARGE");
    }
    return Object.freeze({ok:true,code:"INERT_EVIDENCE_READY",capsule});
  }catch{
    return bad("EVIDENCE_BUILD_FAILED");
  }
}

export function verifyV3InertEvidenceCapsule(value) {
  try{
    if(!strictKeys(value,[
      "schema","capturedAt","lifecycle","history","cut",
      "safeCheckpointCertified","eventContinuationCaptured","restorable","readyToResume"
    ]) || value.schema!==V3_INERT_EVIDENCE_SCHEMA ||
      value.safeCheckpointCertified!==false ||
      value.eventContinuationCaptured!==false ||
      value.restorable!==false || value.readyToResume!==false) {
      return Object.freeze({ok:false,code:"EVIDENCE_SCHEMA_INVALID"});
    }
    if(!strictKeys(value.lifecycle,[
      "code","seq","started","fulfilled","rejected","threw","pending",
      "truncatedTransitions","droppedStarts","records","completeCoverage",
      "eventContinuationCaptured","restorable","readyToResume"
    ]) || !strictKeys(value.history,[
      "code","hasLedger","eventReferenceCount","duplicateReferenceCount","slots"
    ]) || !strictKeys(value.cut,[
      "code","ancestorNext","ancestorAfter","activeLineageNext","additionalAncestorNext",
      "currentNext","currentAfter","finishedFrames","safeCheckpointCertified",
      "eventContinuationCaptured","restorable","readyToResume"
    ]))return Object.freeze({ok:false,code:"EVIDENCE_SHAPE_INVALID"});
    if(!Array.isArray(value.history.slots) ||
       value.history.hasLedger!==(
         value.history.code==="INERT_HISTORY_REFERENCE_INDEX_READY"
       ) || !number(value.history.eventReferenceCount,MAX_HISTORY_SLOTS) ||
       value.history.eventReferenceCount!==value.history.slots.length) {
      return Object.freeze({ok:false,code:"EVIDENCE_HISTORY_INVALID"});
    }
    const result=buildV3InertEvidenceCapsule({
      capturedAt:value.capturedAt,
      lifecycle:{status:value.lifecycle.code,...value.lifecycle},
      history:value.history.hasLedger?
        {ok:true,code:value.history.code,ledger:{
          slots:value.history.slots,
          distinctEventCount:new Set(value.history.slots.map(x=>x.eventOrdinal)).size,
          eventReferenceCount:value.history.eventReferenceCount,
          duplicateReferenceCount:value.history.duplicateReferenceCount,
          lifecycleEvidence:"OBSERVED_FULFILLMENT_ONLY"
        }}:
        {ok:false,code:value.history.code},
      cut:value.cut
    });
    if(!result.ok || JSON.stringify(result.capsule)!==JSON.stringify(value)) {
      return Object.freeze({ok:false,code:"EVIDENCE_VERIFICATION_FAILED"});
    }
    return Object.freeze({
      ok:true,code:"INERT_EVIDENCE_VERIFIED",
      ageTimestamp:value.capturedAt,
      historyCode:value.history.code,
      eventReferenceCount:value.history.eventReferenceCount,
      lifecycleCode:value.lifecycle.code,
      restorable:false,readyToResume:false
    });
  }catch{
    return Object.freeze({ok:false,code:"EVIDENCE_VERIFICATION_FAILED"});
  }
}
