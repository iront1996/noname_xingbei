/**
 * V3-only manual, read-only event safety diagnostic.
 *
 * This probe examines a single, non-atomic moment in the authoritative
 * browser's event manager. It never hooks an event, pauses/resumes a game,
 * captures private card data, writes state, or sends a network message.
 *
 * CRITICAL: A quiet event stack does NOT certify a recoverable checkpoint.
 * Untracked Promises, remote replies, and in-flight side effects remain.
 */
import { game, lib, _status } from "../noname.js";

const PROBE_SCHEMA = "xingbei-v3-event-probe-1";

function reject(code) {
  return {
    ok: false,
    code,
    schema: PROBE_SCHEMA,
    verdict: "NOT_ASSESSED",
    safeCheckpointCertified: false,
    eventContinuationCaptured: false,
    restorable: false,
    storedOnServer: false,
  };
}

/**
 * Return aggregate counters only: no event names, player IDs, cards, or
 * event objects leave this function.
 *
 * This is opt-in. Nothing calls it automatically.
 */
export function inspectHostEventSafety() {
  if (!game.onlineroom || game.online || !_status.connectMode) {
    return reject("NOT_ROOM_HOST");
  }
  if (!_status.gameStarted || !game.players?.length ||
      !game.ws || game.ws.readyState !== WebSocket.OPEN) {
    return reject("MATCH_NOT_READY");
  }

  try {
    const manager = _status.eventManager;
    const pauses = _status.pauseManager;
    if (!manager || !Array.isArray(manager.eventStack) || !pauses) {
      return reject("EVENT_RUNTIME_NOT_READY");
    }

    // Direct queues on currently stacked events. Descendant queues and
    // off-stack asynchronous tasks are NOT exhaustively enumerated.
    const stack = manager.eventStack.slice();
    const queueDepth = event => Array.isArray(event?.next) ? event.next.length : 0;
    const afterDepth = event => Array.isArray(event?.after) ? event.after.length : 0;
    const root = manager.rootEvent;
    const rootOutsideStack = root && !stack.includes(root) ? root : null;
    const activeEvents = rootOutsideStack && !rootOutsideStack.finished
      ? [...stack, rootOutsideStack]
      : stack;

    const pendingNextEventCount = activeEvents.reduce((n, event) => n + queueDepth(event), 0);
    const pendingAfterEventCount = activeEvents.reduce((n, event) => n + afterDepth(event), 0);
    const unfinishedObservedEventCount = activeEvents.reduce((n, event) => n + Number(!event?.finished), 0);

    const pauseFlags = {
      pause: Boolean(pauses.pause?.isStarted),
      pause2: Boolean(pauses.pause2?.isStarted),
      pause3: Boolean(pauses.pause3?.isStarted),
      over: Boolean(pauses.over?.isStarted),
      delay: Boolean(pauses.delay?.isStarted),
    };

    // This covers only explicitly tracked sendAsync callbacks. Legacy
    // player.wait(), response callbacks and other Promises may not be here.
    const remoteSlots = lib.node?.waitForResult;
    const knownRemoteWaitSlotCount =
      remoteSlots && typeof remoteSlots === "object"
        ? Object.values(remoteSlots).reduce(
            (n, value) => n + Number(Array.isArray(value) && value.length > 0),
            0,
          )
        : 0;

    const riskIndicators = [];
    if (stack.length > 0) riskIndicators.push("EVENT_STACK_ACTIVE");
    if (unfinishedObservedEventCount > 0) riskIndicators.push("EVENT_UNFINISHED");
    if (pendingNextEventCount > 0 || pendingAfterEventCount > 0) {
      riskIndicators.push("QUEUED_EVENT_WORK");
    }
    if (Object.values(pauseFlags).some(Boolean)) riskIndicators.push("PAUSE_OR_DELAY_ACTIVE");
    if (_status.imchoosing) riskIndicators.push("LOCAL_CHOICE_IN_PROGRESS");
    if (knownRemoteWaitSlotCount > 0) riskIndicators.push("KNOWN_REMOTE_REPLY_PENDING");
    if (manager.tempEvent) riskIndicators.push("TEMPORARY_EVENT_CONTEXT");
    if (_status.waitingForTransition) riskIndicators.push("TRANSITION_PENDING");

    return {
      ok: true,
      schema: PROBE_SCHEMA,
      eventStackDepth: stack.length,
      unfinishedObservedEventCount,
      pendingNextEventCount,
      pendingAfterEventCount,
      rootOutsideStackObserved: Boolean(rootOutsideStack),
      pauseFlags,
      localChoiceInProgress: Boolean(_status.imchoosing),
      knownRemoteWaitSlotCount,
      temporaryEventContextPresent: Boolean(manager.tempEvent),
      transitionPending: Boolean(_status.waitingForTransition),
      riskIndicators,
      observationCoverage: "partial_direct_queues_and_known_wait_slots_only",
      verdict: "OBSERVATION_ONLY_NOT_CERTIFIED",
      safeCheckpointCertified: false,
      eventContinuationCaptured: false,
      restorable: false,
      storedOnServer: false,
    };
  } catch (error) {
    return {
      ...reject("INSPECTION_FAILED"),
      errorType: error instanceof Error ? error.name : "UnknownError",
    };
  }
}
