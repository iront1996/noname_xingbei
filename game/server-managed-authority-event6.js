"use strict";

const crypto = require("node:crypto");

const DIGEST = /^[a-f0-9]{64}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^native_event_[a-f0-9]{32}$/;
const ROOT_ID = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const OPTION_ID = /^native_option_[a-f0-9]{32}$/;

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("EVENT6_CANONICAL_STATE_INVALID");
}

function exactObject(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

function digest(value) {
	return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

/**
 * Event #6's isolated, event-specific proof contract. This deliberately does
 * not accept caller-supplied booleans as provenance: candidate, capture,
 * delivery, seat binding, and Event #5 predecessor must be assembled by the
 * active HostSession from authenticated native IPC and server-private state.
 * It is opt-in and is not a generic successor-event validator.
 */
function validateExperimentalEvent6Internal(proof, evidence, { enabled = false } = {}) {
	const reject = code => Object.freeze({ ok: false, code });
	if (enabled !== true) return reject("EVENT6_EXPERIMENTAL_OPT_IN_REQUIRED");
	if (!exactObject(proof, ["kind", "checkpoint", "eventSequence", "stateRevisionBefore", "stateRevisionAfter", "beforeDigest", "afterDigest", "beforeSummary", "afterSummary", "event"]) || !evidence) {
		return reject("EVENT6_PROOF_SCHEMA_REJECTED");
	}
	const { roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds, predecessor, successorCandidate,
		successorCapture, postCapture, seatBinding, actionDelivery } = evidence;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(hostSessionId || "") ||
		!DIGEST.test(engineBuildId || "") || !ROOT_ID.test(rootInstanceId || "") || !Array.isArray(seatIds) || seatIds.length !== 4 ||
		new Set(seatIds).size !== 4 || seatIds.some(seat => !SEAT_ID.test(seat || "")) || !predecessor ||
		predecessor.eventSequence !== 5 || predecessor.revision !== 5 || !DIGEST.test(predecessor.digest || "") ||
		!predecessor.summary || !seatIds.includes(predecessor.actorSeatId)) return reject("EVENT6_PREDECESSOR_EVIDENCE_UNAVAILABLE");
	const prior = predecessor.summary;
	const predecessorSummaryFailure = !exactObject(prior, ["revision", "predecessorDigest", "actorSeatId", "nativeEventId", "actionCompletionOrdinal", "postFenceCompletionOrdinal", "captureOrdinal", "captureCommitment", "phaseOverEventInstanceId"]) ? "SCHEMA" :
		prior.revision !== 5 ? "REVISION" : prior.actorSeatId !== predecessor.actorSeatId ? "ACTOR" :
		prior.nativeEventId !== predecessor.nativeEventId ? "EVENT_ID_BINDING" :
		!DIGEST.test(prior.predecessorDigest || "") || prior.predecessorDigest !== predecessor.predecessorDigest ? "PREDECESSOR_DIGEST" :
		!EVENT_ID.test(prior.nativeEventId || "") ? "EVENT_ID" :
		!Number.isSafeInteger(prior.actionCompletionOrdinal) || prior.actionCompletionOrdinal < 1 ? "ACTION_ORDINAL" :
		!Number.isSafeInteger(prior.postFenceCompletionOrdinal) || prior.postFenceCompletionOrdinal <= prior.actionCompletionOrdinal ? "POST_FENCE_ORDINAL" :
		!Number.isSafeInteger(prior.captureOrdinal) || prior.captureOrdinal < 1 ? "CAPTURE_ORDINAL" :
		!DIGEST.test(prior.captureCommitment || "") ? "COMMITMENT" :
		!/^event_[1-9][0-9]{0,6}$/.test(prior.phaseOverEventInstanceId || "") ? "PHASE_OVER_INSTANCE" :
		digest(prior) !== predecessor.digest ? "DIGEST_MISMATCH" : null;
	if (predecessorSummaryFailure) return reject(`EVENT6_PREDECESSOR_SUMMARY_REJECTED_${predecessorSummaryFailure}`);
	if (proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null || proof.eventSequence !== 6 ||
		proof.stateRevisionBefore !== 5 || proof.stateRevisionAfter !== 6 || proof.beforeDigest !== predecessor.digest ||
		!DIGEST.test(proof.afterDigest || "") || proof.afterDigest === proof.beforeDigest ||
		digest(predecessor.summary) !== predecessor.digest || canonicalize(proof.beforeSummary) !== canonicalize(predecessor.summary)) {
		return reject("EVENT6_PREDECESSOR_CHAIN_REJECTED");
	}
	const eventKeys = ["kind", "name", "nativeEventName", "nativeEventId", "rootInstanceId", "seatId", "optionId", "cardName", "cardKind",
		"targetSeatId", "nativeEventCompleted", "useResultCount", "useCardChildName", "useCardChildCompleted", "usedCardPosition",
		"nativeChildWaitCompleted", "nativeEventInstanceMatches", "nativeCompletionOrdinal", "actionEventInstanceId", "actionParentEventInstanceId",
		"connectionGeneration", "choiceId", "deliveryId", "resolutionKind", "gameMeNull", "connectedTransports"];
	const event = proof.event;
	const eventFailure = !exactObject(event, eventKeys) ? "SCHEMA" :
		event.kind !== "xingbei_native_successor_card_action_v2" ? "KIND" :
		event.name !== "gongJiOrFaShu" || event.nativeEventName !== event.name ? "EVENT_NAME" :
		!EVENT_ID.test(event.nativeEventId || "") || event.nativeEventId === prior.nativeEventId ? "EVENT_ID" :
		event.rootInstanceId !== rootInstanceId ? "ROOT" :
		!seatIds.includes(event.seatId) || event.seatId === predecessor.actorSeatId ? "ACTOR_SEAT" :
		!OPTION_ID.test(event.optionId || "") ? "OPTION_ID" :
		typeof event.cardName !== "string" || event.cardName.length < 1 || event.cardName.length > 128 ? "CARD_NAME" :
		!["gongJi", "faShu"].includes(event.cardKind) ? "CARD_KIND" :
		!seatIds.includes(event.targetSeatId) || event.targetSeatId === event.seatId ? "TARGET" :
		event.nativeEventCompleted !== true || event.useResultCount !== 1 ? "EVENT_COMPLETION" :
		event.useCardChildName !== "useCard" || event.useCardChildCompleted !== true ? "USE_CARD_CHILD" :
		!["d", "x"].includes(event.usedCardPosition) ? "CARD_POSITION" :
		event.nativeChildWaitCompleted !== true || event.nativeEventInstanceMatches !== true ? "PARENT_WAIT" :
		!Number.isSafeInteger(event.nativeCompletionOrdinal) || event.nativeCompletionOrdinal <= prior.postFenceCompletionOrdinal ? "COMPLETION_ORDINAL" :
		!/^event_[1-9][0-9]{0,6}$/.test(event.actionEventInstanceId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(event.actionParentEventInstanceId || "") ? "EVENT_INSTANCE" :
		!Number.isSafeInteger(event.connectionGeneration) || event.connectionGeneration < 1 ? "CONNECTION_GENERATION" :
		!/^choice_[a-f0-9]{32}$/.test(event.choiceId || "") || !/^delivery_choice_[a-f0-9]{32}$/.test(event.deliveryId || "") ? "DELIVERY_ID" :
		!["player", "trustee"].includes(event.resolutionKind) ? "RESOLUTION_KIND" :
		event.gameMeNull !== true || event.connectedTransports !== 0 ? "HOST_BOUNDARY" : null;
	if (eventFailure) return reject(`EVENT6_NATIVE_ACTION_EVIDENCE_REJECTED_${eventFailure}`);
	const candidateFailure = !exactObject(successorCandidate, ["roomId", "hostSessionId", "rootInstanceId", "engineBuildId", "seatIds", "nativeEventId", "eventSequence",
		"eventInstanceId", "parentEventInstanceId", "waitingCompletionOrdinal", "eventName", "seatId", "options", "optionKinds", "optionCardNames",
		"optionTargetSeatIds", "previousActorSeatId", "connectionGeneration"]) ? "SCHEMA" :
		successorCandidate.roomId !== roomId || successorCandidate.hostSessionId !== hostSessionId ? "SESSION" :
		successorCandidate.rootInstanceId !== rootInstanceId || successorCandidate.engineBuildId !== engineBuildId ? "ENGINE_BINDING" :
		successorCandidate.eventSequence !== 6 || canonicalize(successorCandidate.seatIds) !== canonicalize(seatIds) ? "SEQUENCE_OR_SEATS" :
		successorCandidate.nativeEventId !== event.nativeEventId || successorCandidate.eventInstanceId !== event.actionEventInstanceId ||
		successorCandidate.parentEventInstanceId !== event.actionParentEventInstanceId ? "EVENT_BINDING" :
		successorCandidate.seatId !== event.seatId || successorCandidate.eventName !== event.name ||
		successorCandidate.previousActorSeatId !== predecessor.actorSeatId ? "ACTOR_BINDING" :
		!Number.isSafeInteger(successorCandidate.waitingCompletionOrdinal) || successorCandidate.waitingCompletionOrdinal <= prior.postFenceCompletionOrdinal ? "WAIT_ORDINAL" :
		!Array.isArray(successorCandidate.options) || !successorCandidate.options.includes(event.optionId) ? "OPTION" :
		successorCandidate.optionKinds?.[event.optionId] !== event.cardKind || successorCandidate.optionCardNames?.[event.optionId] !== event.cardName ||
		successorCandidate.optionTargetSeatIds?.[event.optionId] !== event.targetSeatId ? "OPTION_MAPPING" : null;
	if (candidateFailure) return reject(`EVENT6_CANDIDATE_CAUSALITY_REJECTED_${candidateFailure}`);
	const captureFailure = !exactObject(successorCapture, ["roomId", "hostSessionId", "rootInstanceId", "engineBuildId", "seatIds", "nativeEventId", "eventInstanceId",
		"parentEventInstanceId", "seatId", "captureOrdinal", "nativeCompletionOrdinal", "commitment"]) ? "SCHEMA" :
		successorCapture.roomId !== roomId || successorCapture.hostSessionId !== hostSessionId ? "SESSION" :
		successorCapture.rootInstanceId !== rootInstanceId || successorCapture.engineBuildId !== engineBuildId ? "ENGINE_BINDING" :
		!Array.isArray(successorCapture.seatIds) || canonicalize(successorCapture.seatIds) !== canonicalize(seatIds) ? "SEATS" :
		successorCapture.nativeEventId !== event.nativeEventId || successorCapture.eventInstanceId !== event.actionEventInstanceId ||
		successorCapture.parentEventInstanceId !== event.actionParentEventInstanceId || successorCapture.seatId !== event.seatId ? "EVENT_BINDING" :
		!Number.isSafeInteger(successorCapture.captureOrdinal) || successorCapture.captureOrdinal < 1 ? "CAPTURE_ORDINAL" :
		successorCapture.nativeCompletionOrdinal !== successorCandidate.waitingCompletionOrdinal ? "WAIT_ORDINAL" :
		!DIGEST.test(successorCapture.commitment || "") || event.nativeCompletionOrdinal <= successorCapture.nativeCompletionOrdinal ? "COMPLETION_ORDER" : null;
	if (captureFailure) return reject(`EVENT6_PRE_CAPTURE_CAUSALITY_REJECTED_${captureFailure}`);
	const postCaptureFailure = !exactObject(postCapture, ["roomId", "hostSessionId", "rootInstanceId", "engineBuildId", "seatIds", "nativeEventId", "seatId",
		"captureOrdinal", "nativeCompletionOrdinal", "boundaryOrdinal", "phaseOverTriggerOrdinal", "phaseOverSeatId", "phaseOverEventInstanceId", "commitment"]) ? "SCHEMA" :
		postCapture.roomId !== roomId || postCapture.hostSessionId !== hostSessionId ? "SESSION" :
		postCapture.rootInstanceId !== rootInstanceId || postCapture.engineBuildId !== engineBuildId ? "ENGINE_BINDING" :
		!Array.isArray(postCapture.seatIds) || canonicalize(postCapture.seatIds) !== canonicalize(seatIds) ? "SEATS" :
		postCapture.nativeEventId !== event.nativeEventId || postCapture.seatId !== event.seatId ? "EVENT_BINDING" :
		!Number.isSafeInteger(postCapture.nativeCompletionOrdinal) || postCapture.nativeCompletionOrdinal <= event.nativeCompletionOrdinal ? "COMPLETION_ORDER" :
		postCapture.boundaryOrdinal !== 3 || !Number.isSafeInteger(postCapture.phaseOverTriggerOrdinal) || postCapture.phaseOverTriggerOrdinal < 3 ? "PHASE_BOUNDARY" :
		postCapture.phaseOverSeatId !== event.seatId || !/^event_[1-9][0-9]{0,6}$/.test(postCapture.phaseOverEventInstanceId || "") ? "PHASE_EVENT" :
		!Number.isSafeInteger(postCapture.captureOrdinal) || postCapture.captureOrdinal <= prior.captureOrdinal ? "CAPTURE_ORDER" :
		!DIGEST.test(postCapture.commitment || "") || postCapture.commitment === successorCapture.commitment ? "COMMITMENT" : null;
	if (postCaptureFailure) return reject(`EVENT6_POST_CAPTURE_CAUSALITY_REJECTED_${postCaptureFailure}`);
	if (!exactObject(seatBinding, ["roomId", "seatId", "connected", "current", "credentialAuthenticated", "ordinaryPlayer", "connectionGeneration"]) ||
		seatBinding.roomId !== roomId || seatBinding.seatId !== event.seatId || seatBinding.current !== true ||
		seatBinding.connected !== true || seatBinding.credentialAuthenticated !== true || seatBinding.ordinaryPlayer !== true ||
		seatBinding.connectionGeneration !== event.connectionGeneration) return reject("EVENT6_SEAT_BINDING_REJECTED");
	if (!exactObject(actionDelivery, ["roomId", "hostSessionId", "nativeEventId", "seatId", "choiceId", "deliveryId", "optionId",
		"resolutionKind", "connectionGeneration", "immutable"]) || actionDelivery.roomId !== roomId || actionDelivery.hostSessionId !== hostSessionId ||
		actionDelivery.nativeEventId !== event.nativeEventId || actionDelivery.seatId !== event.seatId ||
		actionDelivery.choiceId !== event.choiceId || actionDelivery.deliveryId !== event.deliveryId ||
		actionDelivery.optionId !== event.optionId || actionDelivery.resolutionKind !== event.resolutionKind ||
		actionDelivery.connectionGeneration !== event.connectionGeneration || actionDelivery.immutable !== true) {
		return reject("EVENT6_CHOICE_DELIVERY_EVIDENCE_REJECTED");
	}
	const after = proof.afterSummary;
	if (!exactObject(after, ["revision", "predecessorDigest", "actorSeatId", "nativeEventId", "actionCompletionOrdinal", "postFenceCompletionOrdinal", "captureOrdinal", "captureCommitment", "phaseOverEventInstanceId"]) ||
		after.revision !== 6 || after.predecessorDigest !== predecessor.digest || after.actorSeatId !== event.seatId ||
		after.nativeEventId !== event.nativeEventId || after.actionCompletionOrdinal !== event.nativeCompletionOrdinal ||
		after.postFenceCompletionOrdinal !== postCapture.nativeCompletionOrdinal || after.captureOrdinal !== postCapture.captureOrdinal ||
		after.captureCommitment !== postCapture.commitment || after.phaseOverEventInstanceId !== postCapture.phaseOverEventInstanceId ||
		digest(after) !== proof.afterDigest) return reject("EVENT6_AFTER_STATE_REJECTED");
	return Object.freeze({ ok: true, eventSequence: 6, stateRevision: 6, afterDigest: proof.afterDigest, rootInstanceId,
		nativeEventId: event.nativeEventId, seatId: event.seatId });
}

function validateExperimentalEvent6(proof, evidence, options) {
	try { return validateExperimentalEvent6Internal(proof, evidence, options); }
	catch (_) { return Object.freeze({ ok: false, code: "EVENT6_PROOF_INVALID" }); }
}

module.exports = { validateExperimentalEvent6 };
