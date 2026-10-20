"use strict";

const crypto = require("node:crypto");

const DIGEST = /^[a-f0-9]{64}$/;
const EVENT_ID = /^native_event_[a-f0-9]{32}$/;
const ROOT_ID = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPTION_ID = /^native_option_[a-f0-9]{32}$/;

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	throw new TypeError("EVENT8_CANONICAL_STATE_INVALID");
}
function exact(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
function digest(value) { return crypto.createHash("sha256").update(canonicalize(value)).digest("hex"); }

function validateExperimentalEvent8(proof, evidence, { enabled = false } = {}) {
	const reject = code => Object.freeze({ ok: false, code });
	try {
		if (enabled !== true) return reject("EVENT8_EXPERIMENTAL_OPT_IN_REQUIRED");
		if (!exact(proof, ["kind", "checkpoint", "eventSequence", "stateRevisionBefore", "stateRevisionAfter", "beforeDigest", "afterDigest", "beforeSummary", "afterSummary", "event"]) || !evidence) return reject("EVENT8_PROOF_SCHEMA_REJECTED");
		const { roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds, predecessor, successorCandidate, successorCapture, postCapture, seatBinding, actionDelivery } = evidence;
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(hostSessionId || "") || !DIGEST.test(engineBuildId || "") ||
			!ROOT_ID.test(rootInstanceId || "") || !Array.isArray(seatIds) || seatIds.length !== 4 || new Set(seatIds).size !== 4 || seatIds.some(seat => !SEAT_ID.test(seat || "")) ||
			!predecessor || predecessor.eventSequence !== 7 || predecessor.revision !== 7 || !DIGEST.test(predecessor.digest || "") || !predecessor.summary) return reject("EVENT8_PREDECESSOR_UNAVAILABLE");
		const prior = predecessor.summary;
		if (!exact(prior, ["revision", "predecessorDigest", "actorSeatId", "nativeEventId", "actionCompletionOrdinal", "postFenceCompletionOrdinal", "captureOrdinal", "captureCommitment", "phaseOverEventInstanceId"]) ||
			prior.revision !== 7 || prior.actorSeatId !== predecessor.actorSeatId || prior.nativeEventId !== predecessor.nativeEventId || !seatIds.includes(prior.actorSeatId) ||
			!EVENT_ID.test(prior.nativeEventId || "") || !DIGEST.test(prior.predecessorDigest || "") || prior.predecessorDigest !== predecessor.predecessorDigest ||
			!Number.isSafeInteger(prior.actionCompletionOrdinal) || prior.actionCompletionOrdinal < 1 || !Number.isSafeInteger(prior.postFenceCompletionOrdinal) || prior.postFenceCompletionOrdinal <= prior.actionCompletionOrdinal ||
			!Number.isSafeInteger(prior.captureOrdinal) || prior.captureOrdinal < 1 || !DIGEST.test(prior.captureCommitment || "") || !/^event_[1-9][0-9]{0,6}$/.test(prior.phaseOverEventInstanceId || "") ||
			digest(prior) !== predecessor.digest) return reject("EVENT8_PREDECESSOR_REJECTED");
		if (proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null || proof.eventSequence !== 8 || proof.stateRevisionBefore !== 7 || proof.stateRevisionAfter !== 8 ||
			proof.beforeDigest !== predecessor.digest || !DIGEST.test(proof.afterDigest || "") || proof.afterDigest === proof.beforeDigest || digest(proof.beforeSummary) !== predecessor.digest ||
			canonicalize(proof.beforeSummary) !== canonicalize(prior)) return reject("EVENT8_PREDECESSOR_CHAIN_REJECTED");
		const event = proof.event;
		const eventKeys = ["kind", "name", "nativeEventName", "nativeEventId", "rootInstanceId", "seatId", "optionId", "cardName", "cardKind", "targetSeatId", "nativeEventCompleted", "useResultCount",
			"useCardChildName", "useCardChildCompleted", "usedCardPosition", "nativeChildWaitCompleted", "nativeEventInstanceMatches", "nativeCompletionOrdinal", "actionEventInstanceId", "actionParentEventInstanceId",
			"connectionGeneration", "choiceId", "deliveryId", "resolutionKind", "gameMeNull", "connectedTransports"];
		if (!exact(event, eventKeys) || event.kind !== "xingbei_native_successor_card_action_v4" || event.name !== "gongJiOrFaShu" || event.nativeEventName !== event.name || !EVENT_ID.test(event.nativeEventId || "") ||
			event.nativeEventId === prior.nativeEventId || event.rootInstanceId !== rootInstanceId || !seatIds.includes(event.seatId) || event.seatId === prior.actorSeatId || !OPTION_ID.test(event.optionId || "") ||
			typeof event.cardName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(event.cardName) || !["gongJi", "faShu"].includes(event.cardKind) || !seatIds.includes(event.targetSeatId) || event.targetSeatId === event.seatId ||
			event.nativeEventCompleted !== true || event.useResultCount !== 1 || event.useCardChildName !== "useCard" || event.useCardChildCompleted !== true || !["d", "x"].includes(event.usedCardPosition) ||
			event.nativeChildWaitCompleted !== true || event.nativeEventInstanceMatches !== true || !Number.isSafeInteger(event.nativeCompletionOrdinal) || event.nativeCompletionOrdinal <= prior.postFenceCompletionOrdinal ||
			!/^event_[1-9][0-9]{0,6}$/.test(event.actionEventInstanceId || "") || !/^event_[1-9][0-9]{0,6}$/.test(event.actionParentEventInstanceId || "") || !Number.isSafeInteger(event.connectionGeneration) || event.connectionGeneration < 1 ||
			!/^choice_[a-f0-9]{32}$/.test(event.choiceId || "") || !/^delivery_choice_[a-f0-9]{32}$/.test(event.deliveryId || "") || !["player", "trustee"].includes(event.resolutionKind) || event.gameMeNull !== true || event.connectedTransports !== 0) return reject("EVENT8_ACTION_REJECTED");
		const candidateKeys = ["roomId", "hostSessionId", "rootInstanceId", "engineBuildId", "seatIds", "nativeEventId", "eventSequence", "eventInstanceId", "parentEventInstanceId", "waitingCompletionOrdinal", "eventName", "seatId", "options", "optionKinds", "optionCardNames", "optionTargetSeatIds", "previousActorSeatId", "connectionGeneration"];
		if (!exact(successorCandidate, candidateKeys) || successorCandidate.roomId !== roomId || successorCandidate.hostSessionId !== hostSessionId || successorCandidate.rootInstanceId !== rootInstanceId ||
			successorCandidate.engineBuildId !== engineBuildId || canonicalize(successorCandidate.seatIds) !== canonicalize(seatIds) || successorCandidate.nativeEventId !== event.nativeEventId || successorCandidate.eventSequence !== 8 ||
			successorCandidate.eventInstanceId !== event.actionEventInstanceId || successorCandidate.parentEventInstanceId !== event.actionParentEventInstanceId || successorCandidate.seatId !== event.seatId || successorCandidate.eventName !== event.name ||
			successorCandidate.previousActorSeatId !== prior.actorSeatId || !Number.isSafeInteger(successorCandidate.waitingCompletionOrdinal) || successorCandidate.waitingCompletionOrdinal <= prior.postFenceCompletionOrdinal ||
			!Array.isArray(successorCandidate.options) || !successorCandidate.options.includes(event.optionId) || successorCandidate.optionKinds?.[event.optionId] !== event.cardKind ||
			successorCandidate.optionCardNames?.[event.optionId] !== event.cardName || successorCandidate.optionTargetSeatIds?.[event.optionId] !== event.targetSeatId || successorCandidate.connectionGeneration !== event.connectionGeneration) return reject("EVENT8_CANDIDATE_REJECTED");
		const captureKeys = ["roomId", "hostSessionId", "rootInstanceId", "engineBuildId", "seatIds", "nativeEventId", "eventInstanceId", "parentEventInstanceId", "seatId", "captureOrdinal", "nativeCompletionOrdinal", "commitment"];
		if (!exact(successorCapture, captureKeys) || successorCapture.roomId !== roomId || successorCapture.hostSessionId !== hostSessionId || successorCapture.rootInstanceId !== rootInstanceId ||
			successorCapture.engineBuildId !== engineBuildId || canonicalize(successorCapture.seatIds) !== canonicalize(seatIds) || successorCapture.nativeEventId !== event.nativeEventId ||
			successorCapture.eventInstanceId !== event.actionEventInstanceId || successorCapture.parentEventInstanceId !== event.actionParentEventInstanceId || successorCapture.seatId !== event.seatId ||
			!Number.isSafeInteger(successorCapture.captureOrdinal) || successorCapture.captureOrdinal <= prior.captureOrdinal || successorCapture.nativeCompletionOrdinal !== successorCandidate.waitingCompletionOrdinal ||
			!DIGEST.test(successorCapture.commitment || "") || event.nativeCompletionOrdinal <= successorCapture.nativeCompletionOrdinal) return reject("EVENT8_PRE_CAPTURE_REJECTED");
		const postKeys = ["roomId", "hostSessionId", "rootInstanceId", "engineBuildId", "seatIds", "nativeEventId", "seatId", "captureOrdinal", "nativeCompletionOrdinal", "boundaryOrdinal", "phaseOverTriggerOrdinal", "phaseOverSeatId", "phaseOverEventInstanceId", "commitment"];
		if (!exact(postCapture, postKeys) || postCapture.roomId !== roomId || postCapture.hostSessionId !== hostSessionId || postCapture.rootInstanceId !== rootInstanceId || postCapture.engineBuildId !== engineBuildId ||
			canonicalize(postCapture.seatIds) !== canonicalize(seatIds) || postCapture.nativeEventId !== event.nativeEventId || postCapture.seatId !== event.seatId || !Number.isSafeInteger(postCapture.nativeCompletionOrdinal) ||
			postCapture.nativeCompletionOrdinal <= event.nativeCompletionOrdinal || postCapture.boundaryOrdinal !== 5 || !Number.isSafeInteger(postCapture.phaseOverTriggerOrdinal) || postCapture.phaseOverTriggerOrdinal < 5 ||
			postCapture.phaseOverSeatId !== event.seatId || !/^event_[1-9][0-9]{0,6}$/.test(postCapture.phaseOverEventInstanceId || "") || !Number.isSafeInteger(postCapture.captureOrdinal) ||
			postCapture.captureOrdinal <= successorCapture.captureOrdinal || !DIGEST.test(postCapture.commitment || "") || postCapture.commitment === successorCapture.commitment) return reject("EVENT8_POST_CAPTURE_REJECTED");
		if (!exact(seatBinding, ["roomId", "seatId", "connected", "current", "credentialAuthenticated", "ordinaryPlayer", "connectionGeneration"]) || seatBinding.roomId !== roomId || seatBinding.seatId !== event.seatId ||
			seatBinding.connected !== true || seatBinding.current !== true || seatBinding.credentialAuthenticated !== true || seatBinding.ordinaryPlayer !== true || seatBinding.connectionGeneration !== event.connectionGeneration) return reject("EVENT8_SEAT_BINDING_REJECTED");
		if (!exact(actionDelivery, ["roomId", "hostSessionId", "nativeEventId", "seatId", "choiceId", "deliveryId", "optionId", "eventSequence", "resolutionKind", "connectionGeneration", "immutable"]) ||
			actionDelivery.roomId !== roomId || actionDelivery.hostSessionId !== hostSessionId || actionDelivery.nativeEventId !== event.nativeEventId || actionDelivery.seatId !== event.seatId ||
			actionDelivery.choiceId !== event.choiceId || actionDelivery.deliveryId !== event.deliveryId || actionDelivery.optionId !== event.optionId || actionDelivery.eventSequence !== 8 ||
			actionDelivery.resolutionKind !== event.resolutionKind || actionDelivery.connectionGeneration !== event.connectionGeneration || actionDelivery.immutable !== true) return reject("EVENT8_DELIVERY_REJECTED");
		const after = proof.afterSummary;
		if (!exact(after, ["revision", "predecessorDigest", "actorSeatId", "nativeEventId", "actionCompletionOrdinal", "postFenceCompletionOrdinal", "captureOrdinal", "captureCommitment", "phaseOverEventInstanceId"]) ||
			after.revision !== 8 || after.predecessorDigest !== predecessor.digest || after.actorSeatId !== event.seatId || after.nativeEventId !== event.nativeEventId || after.actionCompletionOrdinal !== event.nativeCompletionOrdinal ||
			after.postFenceCompletionOrdinal !== postCapture.nativeCompletionOrdinal || after.captureOrdinal !== postCapture.captureOrdinal || after.captureCommitment !== postCapture.commitment ||
			after.phaseOverEventInstanceId !== postCapture.phaseOverEventInstanceId || digest(after) !== proof.afterDigest) return reject("EVENT8_AFTER_STATE_REJECTED");
		return Object.freeze({ ok: true, eventSequence: 8, stateRevision: 8, afterDigest: proof.afterDigest, rootInstanceId, nativeEventId: event.nativeEventId, seatId: event.seatId });
	} catch (_) { return reject("EVENT8_PROOF_INVALID"); }
}

module.exports = { validateExperimentalEvent8 };
