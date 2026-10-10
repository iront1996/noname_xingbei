/**
 * V3-only anonymous transition chronology. The original diagnostic observer
 * exposes a 512-entry rotating window. This component retains consecutive
 * observed transitions between encrypted writes without claiming complete
 * event coverage or executable replay.
 *
 * No event names, cards, skills, player IDs, room IDs, or callback state.
 */
export const V3_INERT_TIMELINE_SCHEMA="xingbei-v3-inert-timeline-1";
const MAX_WINDOW=512;
const MAX_ENTRIES=4096;
const MAX_SEQ=1000000000;
const TRANSITIONS=new Set(["started","fulfilled","rejected","threw"]);
const OWN_KEYS=["schema","observerEpoch","firstSeq","lastSeq","records","missingTransitions",
  "evictedTransitions","droppedStarts","completeCoverage",
  "eventContinuationCaptured","safeCheckpointCertified","restorable","readyToResume"];
const RECORD_KEYS=["seq","eventOrdinal","transition"];
const num=(v,max=MAX_SEQ)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const validEpoch=value=>typeof value==="string"&&/^[a-f0-9]{32}$/.test(value);
const refuse=code=>Object.freeze({ok:false,code,timeline:null});
function exactKeys(obj,keys) {
  return obj && typeof obj==="object" && !Array.isArray(obj) &&
    Object.keys(obj).sort().join("|")===keys.slice().sort().join("|");
}
function recordsValid(records,limit) {
  if(!Array.isArray(records)||records.length>limit)return false;
  let seq=0;
  for(const rec of records){
    if(!exactKeys(rec,RECORD_KEYS)||!num(rec.seq)||rec.seq<=seq||
       !num(rec.eventOrdinal,999999)||!TRANSITIONS.has(rec.transition))return false;
    seq=rec.seq;
  }
  return true;
}
function validPrevious(previous) {
  if(!exactKeys(previous,OWN_KEYS) ||
     previous.schema!==V3_INERT_TIMELINE_SCHEMA ||
     !validEpoch(previous.observerEpoch) ||
     !recordsValid(previous.records,MAX_ENTRIES) ||
     !num(previous.firstSeq) || !num(previous.lastSeq) ||
     !num(previous.missingTransitions) ||
     !num(previous.evictedTransitions) ||
     !num(previous.droppedStarts) ||
     previous.completeCoverage!==false ||
     previous.eventContinuationCaptured!==false ||
     previous.safeCheckpointCertified!==false ||
     previous.restorable!==false ||previous.readyToResume!==false ||
     !previous.records.length ||
     previous.records[0].seq!==previous.firstSeq ||
     previous.records.at(-1).seq!==previous.lastSeq) return false;
  return true;
}
function freeze(observerEpoch,records,missingTransitions,evictedTransitions,droppedStarts) {
  const list=Object.freeze(records.map(x=>Object.freeze({
    seq:x.seq,eventOrdinal:x.eventOrdinal,transition:x.transition
  })));
  const result=Object.freeze({
    schema:V3_INERT_TIMELINE_SCHEMA,observerEpoch,
    firstSeq:list[0].seq,lastSeq:list.at(-1).seq,
    records:list,missingTransitions,evictedTransitions,droppedStarts,
    // Even an observed gap-free chronology cannot describe callbacks,
    // pre-observer transitions, network choices, or Promise continuations.
    completeCoverage:false,eventContinuationCaptured:false,
    safeCheckpointCertified:false,restorable:false,readyToResume:false
  });
  return Object.freeze({ok:true,code:
    missingTransitions>0||evictedTransitions>0||droppedStarts>0
      ?"INERT_TIMELINE_INCOMPLETE":"INERT_TIMELINE_OBSERVED_WINDOW",
    timeline:result});
}

/** Reconcile an observed ring-window snapshot with a prior verified archive. */
export function reconcileV3InertTimeline(previous,observation) {
  try {
    if(previous!==null && !validPrevious(previous))
      return refuse("TIMELINE_PREVIOUS_INVALID");
    if(!observation||!validEpoch(observation.observerEpoch)||
       !num(observation.seq) ||
       !num(observation.started)||observation.started===0 ||
       !num(observation.droppedStarts)||
       !recordsValid(observation.records,MAX_WINDOW)||
       observation.completeCoverage!==false ||
       observation.eventContinuationCaptured!==false||
       observation.restorable!==false||
       observation.readyToResume!==false ||
       !["OBSERVATION_PARTIAL","OBSERVATION_RING_TRUNCATED",
         "OBSERVATION_CAPACITY_EXCEEDED"].includes(observation.status) ||
       observation.records.length===0 ||
       observation.records.at(-1).seq!==observation.seq) {
      return refuse("TIMELINE_WINDOW_INVALID");
    }
    const current=observation.records;
    if(previous===null) {
      const missing=current[0].seq-1;
      return freeze(observation.observerEpoch,current,missing,0,
        observation.droppedStarts);
    }
    if(observation.observerEpoch!==previous.observerEpoch)
      return refuse("TIMELINE_OBSERVER_EPOCH_CHANGED");
    if(observation.droppedStarts<previous.droppedStarts ||
       observation.seq<previous.lastSeq)
      return refuse("TIMELINE_EPOCH_OR_COUNTER_RESET");

    // Overlapping transitions must have exactly the same ordinal/type; a
    // changed record cannot be silently rewritten as continuity.
    const previousRecords=new Map(previous.records.map(x=>[x.seq,x]));
    for(const rec of current) {
      const old=previousRecords.get(rec.seq);
      if(old && (old.eventOrdinal!==rec.eventOrdinal ||
                 old.transition!==rec.transition))
        return refuse("TIMELINE_OVERLAP_CONFLICT");
    }
    const newRecords=current.filter(x=>x.seq>previous.lastSeq);
    if(observation.seq>previous.lastSeq && !newRecords.length)
      return refuse("TIMELINE_NEW_WINDOW_UNAVAILABLE");
    let missing=previous.missingTransitions;
    if(newRecords.length) {
      missing+=Math.max(0,newRecords[0].seq-previous.lastSeq-1);
    }
    let records=[...previous.records,...newRecords];
    let evicted=previous.evictedTransitions;
    if(records.length>MAX_ENTRIES){
      const excess=records.length-MAX_ENTRIES;
      records=records.slice(excess);
      evicted+=excess;
    }
    return freeze(observation.observerEpoch,records,missing,evicted,
      observation.droppedStarts);
  }catch{
    return refuse("TIMELINE_RECONCILIATION_FAILED");
  }
}

/** Verify archive shape and invariants before trusting decrypted local data. */
export function verifyV3InertTimeline(value) {
  try {
    if(!validPrevious(value))return Object.freeze({ok:false,code:"TIMELINE_INVALID"});
    let gap=0;
    for(let i=1;i<value.records.length;i++)
      gap+=value.records[i].seq-value.records[i-1].seq-1;
    if(value.missingTransitions<gap ||
       value.missingTransitions+value.evictedTransitions>MAX_SEQ)
      return Object.freeze({ok:false,code:"TIMELINE_GAP_COUNTS_INVALID"});
    return Object.freeze({ok:true,code:"INERT_TIMELINE_VERIFIED",
      recordCount:value.records.length,
      missingTransitions:value.missingTransitions,
      evictedTransitions:value.evictedTransitions,
      droppedStarts:value.droppedStarts,
      restorable:false,readyToResume:false});
  }catch{
    return Object.freeze({ok:false,code:"TIMELINE_INVALID"});
  }
}
