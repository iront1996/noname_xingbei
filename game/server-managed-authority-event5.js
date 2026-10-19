"use strict";

const crypto = require("node:crypto");

const DIGEST = /^[a-f0-9]{64}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^native_event_[a-f0-9]{32}$/;
const ROOT_ID = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const OPAQUE_OPTION = /^native_option_[a-f0-9]{32}$/;

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
	const { predecessor, successorCandidate, successorCapture, postCapture, seatBinding, rootInstanceId, seatIds } = evidence;
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
		"connectionGeneration", "gameMeNull", "connectedTransports"];
	const event = proof.event;
	if (!exactObject(event, eventKeys) || event.kind !== "xingbei_native_successor_card_action_v1" ||
		event.name !== "gongJiOrFaShu" || event.nativeEventName !== event.name || !EVENT_ID.test(event.nativeEventId || "") ||
		event.rootInstanceId !== rootInstanceId || !seatIds.includes(event.seatId) || event.seatId === predecessor.actorSeatId ||
		!OPAQUE_OPTION.test(event.optionId || "") || typeof event.cardName !== "string" || event.cardName.length < 1 || event.cardName.length > 128 ||
		!new Set(["gongJi", "faShu"]).has(event.cardKind) ||
		!seatIds.includes(event.targetSeatId) || event.targetSeatId === event.seatId || event.nativeEventCompleted !== true ||
		event.useResultCount !== 1 || event.useCardChildName !== "useCard" || event.useCardChildCompleted !== true ||
		!new Set(["d", "x"]).has(event.usedCardPosition) || event.nativeChildWaitCompleted !== true ||
		event.nativeEventInstanceMatches !== true || !Number.isSafeInteger(event.nativeCompletionOrdinal) ||
		!/^event_[1-9][0-9]{0,6}$/.test(event.actionEventInstanceId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(event.actionParentEventInstanceId || "") ||
		!Number.isSafeInteger(event.connectionGeneration) || event.connectionGeneration < 1 || event.gameMeNull !== true || event.connectedTransports !== 0) {
		return reject("EVENT5_NATIVE_ACTION_EVIDENCE_REJECTED");
	}
	if (!successorCandidate || successorCandidate.roomId !== evidence.roomId || successorCandidate.hostSessionId !== evidence.hostSessionId ||
		successorCandidate.rootInstanceId !== rootInstanceId || successorCandidate.nativeEventId !== event.nativeEventId ||
		successorCandidate.seatId !== event.seatId || successorCandidate.eventName !== event.name ||
		successorCandidate.previousActorSeatId !== predecessor.actorSeatId ||
		!Array.isArray(successorCandidate.options) || !successorCandidate.options.includes(event.optionId) ||
		!successorCandidate.optionKinds || successorCandidate.optionKinds[event.optionId] === undefined ||
		successorCandidate.optionKinds[event.optionId] !== event.cardKind ||
		!successorCandidate.optionCardNames || successorCandidate.optionCardNames[event.optionId] !== event.cardName ||
		!successorCandidate.optionTargetSeatIds || successorCandidate.optionTargetSeatIds[event.optionId] !== event.targetSeatId ||
		!successorCapture || successorCapture.roomId !== evidence.roomId || successorCapture.hostSessionId !== evidence.hostSessionId ||
		successorCapture.rootInstanceId !== rootInstanceId || successorCapture.nativeEventId !== event.nativeEventId ||
		successorCapture.seatId !== event.seatId || !Number.isSafeInteger(successorCapture.nativeCompletionOrdinal) ||
		event.nativeCompletionOrdinal <= successorCapture.nativeCompletionOrdinal || !DIGEST.test(successorCapture.commitment || "") ||
		!postCapture || postCapture.roomId !== evidence.roomId || postCapture.hostSessionId !== evidence.hostSessionId ||
		postCapture.rootInstanceId !== rootInstanceId || postCapture.engineBuildId !== evidence.engineBuildId ||
		!Array.isArray(postCapture.seatIds) || postCapture.seatIds.some((seat, index) => seat !== seatIds[index]) ||
		postCapture.nativeEventId !== event.nativeEventId || postCapture.seatId !== event.seatId ||
		!Number.isSafeInteger(postCapture.nativeCompletionOrdinal) || postCapture.nativeCompletionOrdinal !== event.nativeCompletionOrdinal ||
		!Number.isSafeInteger(postCapture.captureOrdinal) || postCapture.captureOrdinal !== successorCapture.captureOrdinal + 1 ||
		!DIGEST.test(postCapture.commitment || "") || postCapture.commitment === successorCapture.commitment) {
		return reject("EVENT5_CAPTURE_CAUSALITY_REJECTED");
	}
	if (!seatBinding || seatBinding.roomId !== evidence.roomId || seatBinding.seatId !== event.seatId ||
		seatBinding.current !== true || seatBinding.connected !== true || seatBinding.credentialAuthenticated !== true ||
		seatBinding.ordinaryPlayer !== true || seatBinding.connectionGeneration !== event.connectionGeneration) {
		return reject("EVENT5_SEAT_BINDING_REJECTED");
	}
	const after = proof.afterSummary;
	if (!exactObject(after, ["revision", "predecessorDigest", "actorSeatId", "nativeEventId", "nativeCompletionOrdinal", "captureOrdinal", "captureCommitment"]) ||
		after.revision !== 5 || after.predecessorDigest !== predecessor.digest || after.actorSeatId !== event.seatId ||
		after.nativeEventId !== event.nativeEventId || after.nativeCompletionOrdinal !== event.nativeCompletionOrdinal ||
		after.captureOrdinal !== postCapture.captureOrdinal || after.captureCommitment !== postCapture.commitment ||
		sha256(after) !== proof.afterDigest) return reject("EVENT5_AFTER_STATE_REJECTED");
	return Object.freeze({ ok: true, eventSequence: 5, stateRevision: 5, afterDigest: proof.afterDigest,
		rootInstanceId, nativeEventId: event.nativeEventId, seatId: event.seatId });
}

module.exports = { validateExperimentalEvent5 };
