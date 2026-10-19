"use strict";

const crypto = require("node:crypto");

const DIGEST = /^[a-f0-9]{64}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^native_event_[a-f0-9]{32}$/;
const ROOT_ID = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const OPAQUE_OPTION = /^native_option_[a-f0-9]{32}$/;
const CHOICE_ID = /^choice_[a-f0-9]{32}$/;
const DELIVERY_ID = /^delivery_choice_[a-f0-9]{32}$/;

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("EVENT5_CANONICAL_STATE_INVALID");
}

function sha256(value) {
	return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

function exactObject(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

/**
 * Validate only the bounded Event #5 successor-card transition contract.
 * `evidence` must be assembled from current HostSession-private records, never
 * copied from the submitted proof. This verifier is intentionally not enabled
 * by default and does not provide a general schema-v2 validator.
 */
function validateExperimentalEvent5(proof, evidence, { enabled = false } = {}) {
	const reject = code => Object.freeze({ ok: false, code });
	if (enabled !== true) return reject("EVENT5_EXPERIMENTAL_OPT_IN_REQUIRED");
	if (!proof || !evidence || !exactObject(proof, ["kind", "checkpoint", "eventSequence", "stateRevisionBefore", "stateRevisionAfter",
		"beforeDigest", "afterDigest", "beforeSummary", "afterSummary", "event"])) return reject("EVENT5_PROOF_SCHEMA_REJECTED");
	const { predecessor, successorCandidate, successorCapture, postCapture, seatBinding, actionDelivery, rootInstanceId, seatIds } = evidence;
	if (!predecessor || predecessor.eventSequence !== 4 || predecessor.revision !== 4 || !DIGEST.test(predecessor.digest || "") ||
		!predecessor.summary || !Array.isArray(seatIds) || seatIds.length !== 4 || new Set(seatIds).size !== 4 ||
		seatIds.some(seatId => !SEAT_ID.test(seatId || "")) || !ROOT_ID.test(rootInstanceId || "")) return reject("EVENT5_PREDECESSOR_EVIDENCE_UNAVAILABLE");
	if (proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null || proof.eventSequence !== 5 ||
		proof.stateRevisionBefore !== 4 || proof.stateRevisionAfter !== 5 || proof.beforeDigest !== predecessor.digest ||
		!DIGEST.test(proof.afterDigest || "") || proof.afterDigest === proof.beforeDigest ||
		sha256(predecessor.summary) !== predecessor.digest || canonicalize(proof.beforeSummary) !== canonicalize(predecessor.summary)) {
		return reject("EVENT5_PREDECESSOR_CHAIN_REJECTED");
	}
	const eventKeys = ["kind", "name", "nativeEventName", "nativeEventId", "rootInstanceId", "seatId", "optionId", "cardName", "cardKind",
		"targetSeatId", "nativeEventCompleted", "useResultCount", "useCardChildName", "useCardChildCompleted", "usedCardPosition", "nativeChildWaitCompleted",
		"nativeEventInstanceMatches", "nativeCompletionOrdinal", "actionEventInstanceId", "actionParentEventInstanceId",
		"connectionGeneration", "choiceId", "deliveryId", "resolutionKind", "gameMeNull", "connectedTransports"];
	const event = proof.event;
	const eventExtraKey = event && Object.keys(event).find(key => !eventKeys.includes(key));
	const eventMissingKey = event && eventKeys.find(key => !Object.hasOwn(event, key));
	const nativeActionFailure = !exactObject(event, eventKeys) ? eventExtraKey ? `SCHEMA_EXTRA_${eventExtraKey}` : eventMissingKey ? `SCHEMA_MISSING_${eventMissingKey}` : "SCHEMA" :
		event.kind !== "xingbei_native_successor_card_action_v1" ? "KIND" :
		event.name !== "gongJiOrFaShu" || event.nativeEventName !== event.name ? "EVENT_NAME" :
		!EVENT_ID.test(event.nativeEventId || "") ? "EVENT_ID" :
		event.rootInstanceId !== rootInstanceId ? "ROOT" :
		!seatIds.includes(event.seatId) || event.seatId === predecessor.actorSeatId ? "ACTOR_SEAT" :
		!OPAQUE_OPTION.test(event.optionId || "") ? "OPTION_ID" :
		typeof event.cardName !== "string" || event.cardName.length < 1 || event.cardName.length > 128 ? "CARD_NAME" :
		!new Set(["gongJi", "faShu"]).has(event.cardKind) ? "CARD_KIND" :
		!seatIds.includes(event.targetSeatId) || event.targetSeatId === event.seatId ? "TARGET" :
		event.nativeEventCompleted !== true ? "EVENT_INCOMPLETE" :
		event.useResultCount !== 1 ? "USE_RESULT_COUNT" :
		event.useCardChildName !== "useCard" || event.useCardChildCompleted !== true ? "USE_CARD_CHILD" :
		!new Set(["d", "x"]).has(event.usedCardPosition) ? "CARD_POSITION" :
		event.nativeChildWaitCompleted !== true ? "PARENT_WAIT" :
		event.nativeEventInstanceMatches !== true ? "EVENT_INSTANCE" :
		!Number.isSafeInteger(event.nativeCompletionOrdinal) || event.nativeCompletionOrdinal < 1 ? "COMPLETION_ORDINAL" :
		!/^event_[1-9][0-9]{0,6}$/.test(event.actionEventInstanceId || "") ? "ACTION_INSTANCE" :
		!/^event_[1-9][0-9]{0,6}$/.test(event.actionParentEventInstanceId || "") ? "PARENT_INSTANCE" :
		!Number.isSafeInteger(event.connectionGeneration) || event.connectionGeneration < 1 ? "CONNECTION_GENERATION" :
		!CHOICE_ID.test(event.choiceId || "") ? "CHOICE_ID" :
		!DELIVERY_ID.test(event.deliveryId || "") ? "DELIVERY_ID" :
		!new Set(["player", "trustee"]).has(event.resolutionKind) ? "RESOLUTION_KIND" :
		event.gameMeNull !== true || event.connectedTransports !== 0 ? "HOST_BOUNDARY" : null;
	if (nativeActionFailure) return reject(`EVENT5_NATIVE_ACTION_EVIDENCE_REJECTED_${nativeActionFailure}`);
	if (!successorCandidate || successorCandidate.roomId !== evidence.roomId || successorCandidate.hostSessionId !== evidence.hostSessionId ||
		successorCandidate.rootInstanceId !== rootInstanceId || successorCandidate.nativeEventId !== event.nativeEventId ||
		successorCandidate.eventSequence !== 5 ||
		successorCandidate.eventInstanceId !== event.actionEventInstanceId ||
		successorCandidate.parentEventInstanceId !== event.actionParentEventInstanceId ||
		!Number.isSafeInteger(successorCandidate.waitingCompletionOrdinal) || successorCandidate.waitingCompletionOrdinal < 1 ||
		successorCandidate.seatId !== event.seatId || successorCandidate.eventName !== event.name ||
		successorCandidate.previousActorSeatId !== predecessor.actorSeatId ||
		!Array.isArray(successorCandidate.options) || !successorCandidate.options.includes(event.optionId) ||
		!successorCandidate.optionKinds || successorCandidate.optionKinds[event.optionId] === undefined ||
		successorCandidate.optionKinds[event.optionId] !== event.cardKind ||
		!successorCandidate.optionCardNames || successorCandidate.optionCardNames[event.optionId] !== event.cardName ||
		!successorCandidate.optionTargetSeatIds || successorCandidate.optionTargetSeatIds[event.optionId] !== event.targetSeatId ||
		!successorCapture || successorCapture.roomId !== evidence.roomId || successorCapture.hostSessionId !== evidence.hostSessionId ||
		successorCapture.rootInstanceId !== rootInstanceId || successorCapture.nativeEventId !== event.nativeEventId ||
		successorCapture.eventInstanceId !== event.actionEventInstanceId ||
		successorCapture.parentEventInstanceId !== event.actionParentEventInstanceId ||
		successorCapture.seatId !== event.seatId || !Number.isSafeInteger(successorCapture.nativeCompletionOrdinal) ||
		successorCapture.nativeCompletionOrdinal !== successorCandidate.waitingCompletionOrdinal ||
		event.nativeCompletionOrdinal <= successorCapture.nativeCompletionOrdinal || !DIGEST.test(successorCapture.commitment || "") ||
		!postCapture || postCapture.roomId !== evidence.roomId || postCapture.hostSessionId !== evidence.hostSessionId ||
		postCapture.rootInstanceId !== rootInstanceId || postCapture.engineBuildId !== evidence.engineBuildId ||
		!Array.isArray(postCapture.seatIds) || postCapture.seatIds.some((seat, index) => seat !== seatIds[index]) ||
		postCapture.nativeEventId !== event.nativeEventId || postCapture.seatId !== event.seatId ||
		!Number.isSafeInteger(postCapture.nativeCompletionOrdinal) || postCapture.nativeCompletionOrdinal <= event.nativeCompletionOrdinal ||
		postCapture.boundaryOrdinal !== 2 || !Number.isSafeInteger(postCapture.phaseOverTriggerOrdinal) || postCapture.phaseOverTriggerOrdinal < 2 ||
		postCapture.phaseOverSeatId !== event.seatId || !/^event_[1-9][0-9]{0,6}$/.test(postCapture.phaseOverEventInstanceId || "") ||
		!Number.isSafeInteger(postCapture.captureOrdinal) || postCapture.captureOrdinal < 1 ||
		!Number.isSafeInteger(successorCapture.captureOrdinal) || successorCapture.captureOrdinal < 1 ||
		!DIGEST.test(postCapture.commitment || "") || postCapture.commitment === successorCapture.commitment) {
		return reject("EVENT5_CAPTURE_CAUSALITY_REJECTED");
	}
	if (!seatBinding || seatBinding.roomId !== evidence.roomId || seatBinding.seatId !== event.seatId ||
		seatBinding.current !== true || seatBinding.connected !== true || seatBinding.credentialAuthenticated !== true ||
		seatBinding.ordinaryPlayer !== true || seatBinding.connectionGeneration !== event.connectionGeneration) {
		return reject("EVENT5_SEAT_BINDING_REJECTED");
	}
	if (!actionDelivery || actionDelivery.roomId !== evidence.roomId || actionDelivery.hostSessionId !== evidence.hostSessionId ||
		actionDelivery.nativeEventId !== event.nativeEventId || actionDelivery.seatId !== event.seatId ||
		actionDelivery.choiceId !== event.choiceId || actionDelivery.deliveryId !== event.deliveryId ||
		actionDelivery.optionId !== event.optionId || actionDelivery.resolutionKind !== event.resolutionKind ||
		actionDelivery.connectionGeneration !== event.connectionGeneration || actionDelivery.immutable !== true) {
		return reject("EVENT5_CHOICE_DELIVERY_EVIDENCE_REJECTED");
	}
	const after = proof.afterSummary;
	if (!exactObject(after, ["revision", "predecessorDigest", "actorSeatId", "nativeEventId", "actionCompletionOrdinal", "postFenceCompletionOrdinal",
		"captureOrdinal", "captureCommitment", "phaseOverEventInstanceId"]) ||
		after.revision !== 5 || after.predecessorDigest !== predecessor.digest || after.actorSeatId !== event.seatId ||
		after.nativeEventId !== event.nativeEventId || after.actionCompletionOrdinal !== event.nativeCompletionOrdinal ||
		after.postFenceCompletionOrdinal !== postCapture.nativeCompletionOrdinal || after.phaseOverEventInstanceId !== postCapture.phaseOverEventInstanceId ||
		after.captureOrdinal !== postCapture.captureOrdinal || after.captureCommitment !== postCapture.commitment ||
		sha256(after) !== proof.afterDigest) return reject("EVENT5_AFTER_STATE_REJECTED");
	return Object.freeze({ ok: true, eventSequence: 5, stateRevision: 5, afterDigest: proof.afterDigest,
		rootInstanceId, nativeEventId: event.nativeEventId, seatId: event.seatId });
}

module.exports = { validateExperimentalEvent5 };
