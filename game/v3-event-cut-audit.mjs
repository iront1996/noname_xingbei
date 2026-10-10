/**
 * V3-only negative-proof Event-cut audit.
 *
 * This is NOT a safe-checkpoint detector: a clean visible GameEvent stack
 * says nothing about unresolved JavaScript closures, async/await microtasks,
 * timers, in-flight WebSockets, or choice callbacks. It only explains which
 * *visible* engine queues currently forbid even attempting a checkpoint.
 *
 * Never returns event references, player identifiers, event names, or payloads.
 */
const MAX_STACK = 128;
const MAX_QUEUE = 20000;
const EMPTY = Object.freeze({
  ancestorNext:0, ancestorAfter:0,
  activeLineageNext:0, additionalAncestorNext:0,
  currentNext:0, currentAfter:0, finishedFrames:0
});
const base = (code, counts = EMPTY) => Object.freeze({
  code, ...counts,
  completeCoverage:false, safeCheckpointCertified:false,
  eventContinuationCaptured:false, restorable:false, readyToResume:false
});

function dataField(object, key) {
  const desc=Object.getOwnPropertyDescriptor(object,key);
  if(!desc || !Object.prototype.hasOwnProperty.call(desc,"value")) {
    throw Error("CUT_STACK_FIELD_UNAVAILABLE");
  }
  return desc.value;
}

export function inspectV3EventCutQueues(stack) {
  if(!Array.isArray(stack) || stack.length===0 || stack.length>MAX_STACK) {
    return base("CUT_STACK_UNAVAILABLE");
  }
  let ancestorNext=0, ancestorAfter=0, currentNext=0, currentAfter=0;
  let activeLineageNext=0, finishedFrames=0, currentPhaseLoop=false;
  try {
    for(let i=0;i<stack.length;i++){
      const event=stack[i];
      if(!event || typeof event!=="object") {
        throw Error("CUT_STACK_FRAME_INVALID");
      }
      const next=dataField(event,"next"), after=dataField(event,"after");
      const finished=dataField(event,"finished");
      if(!Array.isArray(next) || !Array.isArray(after) ||
         typeof finished!=="boolean" || next.length>MAX_QUEUE ||
         after.length>MAX_QUEUE) {
        throw Error("CUT_STACK_FRAME_INVALID");
      }
      if(finished)finishedFrames++;
      if(i===stack.length-1){
        currentPhaseLoop=dataField(event,"name")==="phaseLoop";
        currentNext=next.length;
        currentAfter=after.length;
      }else{
        ancestorNext+=next.length;
        ancestorAfter+=after.length;
        if(ancestorNext>MAX_QUEUE || ancestorAfter>MAX_QUEUE) {
          throw Error("CUT_QUEUE_LIMIT_EXCEEDED");
        }
        // GameEvent.waitNext() awaits next[0].start() and shifts next[0]
        // ONLY after the child completes. The currently executing next
        // stack frame can therefore remain queued in its own parent.
        // This reference is *in-flight*, not an additional scheduled child.
        // Read by own descriptor to avoid triggering a custom array getter.
        if(next.length>0 && dataField(next,"0")===stack[i+1]){
          activeLineageNext++;
        }
      }
    }
    const additionalAncestorNext=ancestorNext-activeLineageNext;
    const counts={
      ancestorNext,ancestorAfter,activeLineageNext,additionalAncestorNext,
      currentNext,currentAfter,finishedFrames
    };
    if(!currentPhaseLoop) return base("CUT_NOT_PHASE_LOOP",counts);
    if(additionalAncestorNext || ancestorAfter)
      return base("CUT_ANCESTOR_QUEUES_PENDING",counts);
    if(currentNext || currentAfter)
      return base("CUT_CURRENT_QUEUES_PENDING",counts);
    // A queued ancestor.next[0] equal to the *currently executing* child
    // is not additional queued work. It is also NOT a safe checkpoint:
    // the parent Promise is waiting for this exact child to finish.
    if(activeLineageNext)
      return base("CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED",counts);
    // A visible-empty queue is not sufficient for safe host refresh either.
    return base("CUT_VISIBLE_QUEUES_EMPTY_NOT_CERTIFIED",counts);
  }catch(err) {
    const allow=new Set([
      "CUT_STACK_FRAME_INVALID","CUT_QUEUE_LIMIT_EXCEEDED",
      "CUT_STACK_FIELD_UNAVAILABLE"
    ]);
    return base(err instanceof Error&&allow.has(err.message)
      ? err.message : "CUT_STACK_OBSERVATION_FAILED");
  }
}
