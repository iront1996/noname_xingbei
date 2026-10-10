/**
 * V3-only event-continuation investigation. No raw history, event names,
 * player IDs, cards, tokens, stack frames, callbacks or Promise objects
 * leave this module. These observations NEVER make a checkpoint restorable.
 */
const MAX_HISTORY_NODES = 12000;
const MAX_HISTORY_DEPTH = 24;

function failure(code) {
  return Object.freeze({ok:false,code,restorable:false});
}
function pass(code) {
  return Object.freeze({ok:true,code,restorable:false});
}

/**
 * A phaseLoop step-1 hook may run while an ancestor event has queued child
 * work. Those children cannot be recreated after a cold reload, even though
 * the next player's turn has not been scheduled yet.
 */
export function inspectV3TurnBoundaryStack(stack) {
  if (!Array.isArray(stack) || stack.length === 0 || stack.length > 128) {
    return failure("BOUNDARY_STACK_UNAVAILABLE");
  }
  const current=stack[stack.length-1];
  if (current?.name !== "phaseLoop" ||
      typeof current?.player?.playerid !== "string" ||
      !current.player.playerid) {
    return failure("BOUNDARY_PHASE_LOOP_NOT_ACTIVE");
  }
  for (const frame of stack) {
    if (!frame || !Array.isArray(frame.next) || !Array.isArray(frame.after)) {
      return failure("BOUNDARY_QUEUE_SHAPE_INVALID");
    }
    if (frame!==current && (frame.next.length>0 || frame.after.length>0)) {
      return failure("BOUNDARY_ANCESTOR_WORK_PENDING");
    }
  }
  // Structural observation only. A clean visible stack does not prove
  // continuation of microtasks, closure locals, timers or Promise waits.
  return pass("BOUNDARY_STACK_OBSERVABLE");
}

/**
 * Examines event references that appear inside player.actionHistory.
 * Repeated identity is deduplicated, and scanning stops at event objects.
 * 'finished' is an engine flag, NOT proof of settled async continuation.
 */
export function inspectV3HistoryEventReferences(history, itemtype, liveStack) {
  if (!Array.isArray(history) || typeof itemtype!=="function" ||
      !Array.isArray(liveStack)) return failure("HISTORY_PROBE_UNAVAILABLE");
  const seen=new WeakSet();
  const events=new WeakSet();
  const active=new Set(liveStack);
  let markedFinished=0, outstanding=0, onStack=0, nodes=0;
  try {
    const visit=(value,depth)=>{
      nodes++;
      if (nodes>MAX_HISTORY_NODES || depth>MAX_HISTORY_DEPTH) {
        throw Error("HISTORY_OBSERVATION_LIMIT");
      }
      if(value===null || typeof value!=="object")return;
      if(seen.has(value))return;
      seen.add(value);
      const type=itemtype(value);
      if(type==="event") {
        if(!events.has(value)) {
          events.add(value);
          if(active.has(value))onStack++;
          if(value.finished===true)markedFinished++;
          else outstanding++;
        }
        return;
      }
      if(!Array.isArray(value) &&
         Object.prototype.toString.call(value)!=="[object Object]") {
        throw Error("HISTORY_OBSERVATION_UNSUPPORTED_OBJECT");
      }
      for(const key of Object.keys(value)) {
        // Never log key or value; property access can still throw.
        visit(value[key],depth+1);
      }
    };
    visit(history,0);
  }catch(error) {
    const code=error instanceof Error &&
      ["HISTORY_OBSERVATION_LIMIT","HISTORY_OBSERVATION_UNSUPPORTED_OBJECT"].includes(error.message)
      ? error.message : "HISTORY_OBSERVATION_UNAVAILABLE";
    return failure(code);
  }
  if(onStack>0)return failure("HISTORY_EVENT_IN_ACTIVE_STACK");
  if(outstanding>0)return failure("HISTORY_EVENT_NOT_MARKED_FINISHED");
  if(markedFinished>0)return failure("HISTORY_EVENT_FINISHED_FLAG_ONLY");
  return pass("HISTORY_EVENT_REFERENCES_ABSENT");
}
