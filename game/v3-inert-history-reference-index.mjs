/**
 * V3: inert reference identity ledger for historical GameEvent objects.
 *
 * The ledger records ONLY location, repeated-object identity, and an engine
 * finished FLAG; it never serializes GameEvents, card data, callbacks, player
 * IDs, Promise continuations or custom fields. It cannot restore history.
 *
 * This is intentionally separate from the encrypted checkpoint path.
 * No caller may use "ok" to send v3resume/v3ready or start a phase.
 */
const BUCKETS = Object.freeze([
  "useCard", "respond", "skipped", "lose", "gain",
  "sourceDamage", "damage", "custom", "useSkill"
]);
const BUCKET_SET = new Set(BUCKETS);
const META_KEYS = new Set(["isMe","isRound"]);
const MAX_PLAYERS = 8;
const MAX_TURNS = 256;
const MAX_REFERENCES = 4096;

function denied(code) {
  return Object.freeze({ok:false,code,ledger:null,restorable:false,readyToResume:false});
}
function ordinary(value) {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}
function dataProperty(object,key) {
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor,"value")) {
    throw Error("HISTORY_ACCESSOR_UNSUPPORTED");
  }
  return descriptor.value;
}
/**
 * Input is in player seat order. Never include Player or socket IDs.
 *
 * @returns an inert, bounded manifest of event occurrences for future
 * strict reconstruction design; not a replayable GameEvent graph.
 */
export function indexV3InertHistoryReferences(histories,itemtype,activeStack) {
  if (!Array.isArray(histories) || histories.length<1 ||
      histories.length>MAX_PLAYERS ||
      !Array.isArray(activeStack) || typeof itemtype!=="function") {
    return denied("HISTORY_INDEX_INPUT_INVALID");
  }
  const live=new Set(activeStack), ids=new WeakMap();
  const slots=[];
  let distinct=0, occurrences=0, duplicateReferences=0;
  try {
    for(let playerIndex=0;playerIndex<histories.length;playerIndex++){
      const turns=histories[playerIndex];
      if (!Array.isArray(turns) || turns.length>MAX_TURNS) {
        throw Error("HISTORY_INDEX_TURNS_UNSUPPORTED");
      }
      for(let turnIndex=0;turnIndex<turns.length;turnIndex++){
        const turn=turns[turnIndex];
        if(!ordinary(turn))throw Error("HISTORY_INDEX_SHAPE_UNSUPPORTED");
        for(const key of Object.keys(turn)){
          if(!BUCKET_SET.has(key) && !META_KEYS.has(key)) {
            throw Error("HISTORY_UNKNOWN_FIELD");
          }
        }
        for(const bucket of BUCKETS){
          if(!Object.prototype.hasOwnProperty.call(turn,bucket)) continue;
          const items=dataProperty(turn,bucket);
          if(!Array.isArray(items))throw Error("HISTORY_BUCKET_NOT_ARRAY");
          for(let entryIndex=0;entryIndex<items.length;entryIndex++){
            if(!Object.prototype.hasOwnProperty.call(items,entryIndex)){
              throw Error("HISTORY_ARRAY_HOLE");
            }
            const entry=dataProperty(items,String(entryIndex));
            if(bucket==="skipped" && typeof entry==="string") continue;
            // Native arrays may contain non-events; those require a separate
            // typed-data codec. No partial or lossy ledger is accepted.
            if(!entry || (typeof entry!=="object" && typeof entry!=="function") ||
               itemtype(entry)!=="event") {
              throw Error("HISTORY_ENTRY_NOT_EVENT");
            }
            if(live.has(entry))throw Error("HISTORY_EVENT_IN_ACTIVE_STACK");
            const finished=Object.getOwnPropertyDescriptor(entry,"finished");
            if(!finished || !Object.prototype.hasOwnProperty.call(finished,"value") ||
               finished.value!==true)throw Error("HISTORY_EVENT_NOT_SETTLED_PROVEN");
            occurrences++;
            if(occurrences>MAX_REFERENCES)throw Error("HISTORY_INDEX_LIMIT_EXCEEDED");
            let ordinal=ids.get(entry);
            if(ordinal===undefined){
              ordinal=distinct++;
              ids.set(entry,ordinal);
            }else{
              duplicateReferences++;
            }
            slots.push(Object.freeze({
              playerIndex,turnIndex,bucket,entryIndex,eventOrdinal:ordinal
            }));
          }
        }
      }
    }
    return Object.freeze({
      ok:true,
      code:"INERT_HISTORY_REFERENCE_INDEX_READY",
      ledger:Object.freeze({
        schema:"xingbei-v3-inert-history-index-1",
        distinctEventCount:distinct,
        eventReferenceCount:occurrences,
        duplicateReferenceCount:duplicateReferences,
        slots:Object.freeze(slots)
      }),
      // Finished flags, identity paths and an inactive stack are NOT enough
      // to recreate methods, pending triggers or Promise continuation.
      eventContinuationCaptured:false,
      restorable:false,readyToResume:false
    });
  }catch(error){
    const validCodes=new Set([
      "HISTORY_INDEX_TURNS_UNSUPPORTED","HISTORY_INDEX_SHAPE_UNSUPPORTED",
      "HISTORY_UNKNOWN_FIELD","HISTORY_ACCESSOR_UNSUPPORTED",
      "HISTORY_BUCKET_NOT_ARRAY","HISTORY_ARRAY_HOLE",
      "HISTORY_ENTRY_NOT_EVENT","HISTORY_EVENT_IN_ACTIVE_STACK",
      "HISTORY_EVENT_NOT_SETTLED_PROVEN","HISTORY_INDEX_LIMIT_EXCEEDED"
    ]);
    return denied(error instanceof Error && validCodes.has(error.message)
      ? error.message:"HISTORY_INDEX_UNAVAILABLE");
  }
}
