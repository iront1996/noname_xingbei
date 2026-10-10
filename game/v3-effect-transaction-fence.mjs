/**
 * V3 cold-host effect transaction safety core — NON-EXECUTING CONTRACT.
 *
 * An anonymous event transition is insufficient to deduce that HP changes,
 * card transfers or skill callbacks did/did not run. This module models the
 * exact crash barriers a future engine adapter MUST enforce before any
 * replay, without storing player/card/skill identity or running effects.
 *
 * ATTENTION: Marking a transaction "applied" after changing JS objects is
 * NOT crash-atomic. Even a fully valid dry-run log never grants resume.
 */
export const V3_EFFECT_FENCE_SCHEMA="xingbei-v3-effect-fence-1";
const MAX_RECORDS=4096;
const TYPES=new Set([
  "hp_change","card_transfer","draw_pile_change","skill_storage_change",
  "choice_resolution","phase_transition","other_side_effect"
]);
const STAGES=new Set(["intent","applied","state_sealed"]);
const SAFE_KEYS=new Set([
  "schema","epoch","records","completeCoverage","engineAdapterInstalled",
  "stateCheckpointAtomic","eventContinuationCaptured","restorable","readyToResume"
]);
const RECORD_KEYS=new Set(["seq","effectOrdinal","eventOrdinal","type","stage"]);
const num=(v,max=1000000000)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(obj,allowed)=>obj&&typeof obj==="object"&&!Array.isArray(obj)&&
  Object.keys(obj).length===allowed.size&&
  Object.keys(obj).every(k=>allowed.has(k));
const epochValid=v=>typeof v==="string"&&/^[a-f0-9]{32}$/.test(v);
const error=code=>Object.freeze({
  ok:false,code,summary:null,restorable:false,readyToResume:false
});
const summary=(code,counts)=>Object.freeze({
  ok:true,code,
  summary:Object.freeze({...counts,
    completeCoverage:false,
    stateCheckpointAtomic:false,
    eventContinuationCaptured:false,
    restorable:false,readyToResume:false
  }),
  restorable:false,readyToResume:false
});

/**
 * Strictly assess a dry-run phase ledger. Input MUST be inert structural
 * metadata, never original GameEvents, callbacks, skill names or cards.
 *
 * intent -> applied -> state_sealed is monotonic. Every missing stage is
 * treated as ambiguous rather than proof that an effect did not occur.
 *
 * Future production replay MUST additionally require an atomic durable
 * engine snapshot and a broker-authenticated writer epoch; neither exists.
 */
export function inspectV3EffectReplayFence(ledger) {
  try{
    if(!exact(ledger,SAFE_KEYS)||
       ledger.schema!==V3_EFFECT_FENCE_SCHEMA ||
       !epochValid(ledger.epoch) ||
       ledger.completeCoverage!==false ||
       ledger.engineAdapterInstalled!==false ||
       ledger.stateCheckpointAtomic!==false ||
       ledger.eventContinuationCaptured!==false ||
       ledger.restorable!==false||ledger.readyToResume!==false ||
       !Array.isArray(ledger.records) ||
       ledger.records.length>MAX_RECORDS){
      return error("EFFECT_FENCE_SCHEMA_UNTRUSTED");
    }
    let previousSeq=0;
    const effects=new Map();
    let lastEffectOrdinal=-1;
    for(const record of ledger.records){
      if(!exact(record,RECORD_KEYS)||!num(record.seq)||record.seq!==previousSeq+1||
         !num(record.effectOrdinal,MAX_RECORDS-1)||
         !num(record.eventOrdinal,999999)||
         !TYPES.has(record.type)||!STAGES.has(record.stage))
        return error("EFFECT_FENCE_RECORD_INVALID");
      previousSeq=record.seq;
      let state=effects.get(record.effectOrdinal);
      if(record.stage==="intent"){
        if(state || record.effectOrdinal!==lastEffectOrdinal+1)
          return error("EFFECT_FENCE_DUPLICATE_OR_UNORDERED_INTENT");
        lastEffectOrdinal=record.effectOrdinal;
        effects.set(record.effectOrdinal,{
          type:record.type,eventOrdinal:record.eventOrdinal,stage:"intent"
        });
        continue;
      }
      if(!state||state.type!==record.type||
         state.eventOrdinal!==record.eventOrdinal)
        return error("EFFECT_FENCE_ORPHAN_OR_MISMATCHED_STAGE");
      if(record.stage==="applied"){
        if(state.stage!=="intent")
          return error("EFFECT_FENCE_DUPLICATE_OR_REORDERED_APPLY");
        state.stage="applied";
      }else if(record.stage==="state_sealed"){
        if(state.stage!=="applied")
          return error("EFFECT_FENCE_UNSEALED_APPLY");
        state.stage="state_sealed";
      }
    }
    let intended=0,appliedNotSealed=0,sealed=0;
    for(const effect of effects.values()){
      if(effect.stage==="intent")intended++;
      else if(effect.stage==="applied")appliedNotSealed++;
      else sealed++;
    }
    const counts={
      effectCount:effects.size,intentsWithoutApply:intended,
      appliedWithoutSeal:appliedNotSealed,sealedCount:sealed
    };
    if(intended||appliedNotSealed)
      return summary("EFFECT_FENCE_AMBIGUOUS_CRASH_WINDOW",counts);
    if(sealed)
      return summary("EFFECT_FENCE_INERT_SEALS_ONLY",counts);
    return summary("EFFECT_FENCE_NO_EFFECTS_OBSERVED",counts);
  }catch{
    return error("EFFECT_FENCE_UNAVAILABLE");
  }
}

/**
 * Check a proposed synthetic, immutable replay request. No caller receives
 * permission to execute. A sealed effect is already accounted for; an intent
 * or applied-but-unsealed effect is ambiguous after a crash. Unknown effects
 * are equally unsafe: absence from this partial log is not proof of absence.
 */
export function classifyV3EffectReplayRequest(ledger,effectOrdinal) {
  const checked=inspectV3EffectReplayFence(ledger);
  if(!checked.ok)return Object.freeze({
    code:checked.code,executionAuthorized:false,readyToResume:false
  });
  if(!num(effectOrdinal,MAX_RECORDS-1))return Object.freeze({
    code:"EFFECT_REPLAY_KEY_INVALID",executionAuthorized:false,readyToResume:false
  });
  const records=ledger.records.filter(r=>r.effectOrdinal===effectOrdinal);
  const code=!records.length?"EFFECT_REPLAY_NOT_OBSERVED":
    records.at(-1).stage==="state_sealed"?"EFFECT_REPLAY_ALREADY_ACCOUNTED":
    "EFFECT_REPLAY_OUTCOME_UNKNOWN";
  return Object.freeze({code,executionAuthorized:false,readyToResume:false});
}

/** Create a locked, empty dry-run ledger for isolated engine adapter tests. */
export function emptyV3EffectFence(epoch) {
  if(!epochValid(epoch))return null;
  return Object.freeze({
    schema:V3_EFFECT_FENCE_SCHEMA,epoch,
    records:Object.freeze([]),completeCoverage:false,
    engineAdapterInstalled:false,stateCheckpointAtomic:false,
    eventContinuationCaptured:false,restorable:false,readyToResume:false
  });
}
