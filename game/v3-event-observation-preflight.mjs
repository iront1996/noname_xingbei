/**
 * V3-only event-continuation investigation. No raw history, event names,
 * player IDs, cards, tokens, stack frames, callbacks or Promise objects
 * leave this module. These observations NEVER make a checkpoint restorable.
 */
import { inspectV3EventCutQueues } from "./v3-event-cut-audit.mjs";

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
  const current = stack[stack.length - 1];
  if (current?.name !== "phaseLoop" ||
      typeof current?.player?.playerid !== "string" ||
      !current.player.playerid) {
    return failure("BOUNDARY_PHASE_LOOP_NOT_ACTIVE");
  }
  // Share the *same* queue identity inspection as the health dialog.
  // The parent.next[0] may still be the currently running child:
  // GameEvent.waitNext() shifts that slot only AFTER next.start() settles.
  // Never interpret this waiting Promise as a cold-resumable checkpoint.
  const cut = inspectV3EventCutQueues(stack);
  const states = {
    CUT_STACK_UNAVAILABLE: "BOUNDARY_STACK_UNAVAILABLE",
    CUT_STACK_FRAME_INVALID: "BOUNDARY_QUEUE_SHAPE_INVALID",
    CUT_STACK_FIELD_UNAVAILABLE: "BOUNDARY_QUEUE_SHAPE_INVALID",
    CUT_STACK_OBSERVATION_FAILED: "BOUNDARY_QUEUE_OBSERVATION_FAILED",
    CUT_QUEUE_LIMIT_EXCEEDED: "BOUNDARY_QUEUE_LIMIT_EXCEEDED",
    CUT_ANCESTOR_QUEUES_PENDING: "BOUNDARY_ANCESTOR_WORK_PENDING",
    CUT_CURRENT_QUEUES_PENDING: "BOUNDARY_CURRENT_WORK_PENDING",
    CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED: "BOUNDARY_ACTIVE_LINEAGE_AWAITING_COMPLETION",
  };
  if (cut.code in states) return failure(states[cut.code]);
  if (cut.code !== "CUT_VISIBLE_QUEUES_EMPTY_NOT_CERTIFIED") {
    return failure("BOUNDARY_STACK_UNCERTAIN");
  }
  // Only this narrow visible shape proceeds to the STRICT snapshot audits.
  // This is not a correctness certificate: hidden async continuations and
  // any historical GameEvent references will still fail closed.
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
      // Player/Card/VCard and their engine-typed collections are already
      // authoritative runtime references, not history event containers.
      // Never inspect their internal fields, DOM nodes or hidden card data.
      if(["player","card","vcard","players","cards","vcards"].includes(type))return;
      if(!Array.isArray(value) &&
         Object.getPrototypeOf(value)!==Object.prototype &&
         Object.getPrototypeOf(value)!==null) {
        throw Error("HISTORY_OBSERVATION_UNSUPPORTED_OBJECT");
      }
      for(const key of Object.keys(value)) {
        // Avoid invoking custom getters while observing sensitive history;
        // an accessor cannot be safely replayed or certified.
        const field=Object.getOwnPropertyDescriptor(value,key);
        if(!field || !Object.prototype.hasOwnProperty.call(field,"value")) {
          throw Error("HISTORY_OBSERVATION_ACCESSOR_UNSAFE");
        }
        visit(field.value,depth+1);
      }
    };
    visit(history,0);
  }catch(error) {
    const code=error instanceof Error &&
      ["HISTORY_OBSERVATION_LIMIT","HISTORY_OBSERVATION_UNSUPPORTED_OBJECT",
       "HISTORY_OBSERVATION_ACCESSOR_UNSAFE"].includes(error.message)
      ? error.message : "HISTORY_OBSERVATION_UNAVAILABLE";
    return failure(code);
  }
  if(onStack>0)return failure("HISTORY_EVENT_IN_ACTIVE_STACK");
  if(outstanding>0)return failure("HISTORY_EVENT_NOT_MARKED_FINISHED");
  if(markedFinished>0)return failure("HISTORY_EVENT_FINISHED_FLAG_ONLY");
  return pass("HISTORY_EVENT_REFERENCES_ABSENT");
}
