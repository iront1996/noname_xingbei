"use strict";

// Review-only protocol schema. This module is intentionally not imported by
// HostSession manager/authority submission code and can never accept Event #5.
const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^hs_[a-f0-9]{32}$/;
const SEAT = /^[A-Za-z0-9_-]{1,64}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const EVENT = /^native_event_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{16,96}$/;

function reject(code) { return Object.freeze({ ok: false, code }); }
function exact(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
function idList(value, pattern, min, max) {
	return Array.isArray(value) && value.length >= min && value.length <= max &&
		value.every(item => pattern.test(item)) && new Set(value).size === value.length;
}

function validateEvent5Proposal(value) {
	const keys = "schema,proposalOnly,submissionEnabled,roomId,hostSessionId,engineBuildId,rootInstanceId,seatIds,predecessor,phaseOver,actorRotation,inputGate,seatBinding,choice,delivery,nativeSettlement,postStateFence,privateStatePolicy,unknownStatePolicy";
	if (!exact(value, keys.split(",")) || value.schema !== "xingbei_native_action_event5_proposal_v1" ||
		value.proposalOnly !== true || value.submissionEnabled !== false || !ROOM.test(value.roomId || "") ||
		!SESSION.test(value.hostSessionId || "") || !DIGEST.test(value.engineBuildId || "") || !ROOT.test(value.rootInstanceId || "") ||
		!idList(value.seatIds, SEAT, 4, 4)) return reject("EVENT5_PROPOSAL_ENVELOPE_REJECTED");
	if (!exact(value.predecessor, "digest,digestDomain,eventSequence,revision".split(",")) || value.predecessor.eventSequence !== 4 ||
		value.predecessor.revision !== 4 || value.predecessor.digestDomain !== "xingbei_authority_state_v2" ||
		!DIGEST.test(value.predecessor.digest || "")) return reject("EVENT5_PROPOSAL_PREDECESSOR_REJECTED");
	if (!exact(value.phaseOver, "nativeEventId,completionOrdinal,parentEventId,completed".split(",")) ||
		!EVENT.test(value.phaseOver.nativeEventId || "") || !Number.isSafeInteger(value.phaseOver.completionOrdinal) ||
		value.phaseOver.completionOrdinal < 1 || !EVENT.test(value.phaseOver.parentEventId || "") || value.phaseOver.completed !== true) {
		return reject("EVENT5_PROPOSAL_PHASE_FENCE_REJECTED");
	}
	if (!exact(value.actorRotation, "priorSeatId,nextSeatId,rootInstanceId,nativePhaseEventId,rotationVerified".split(",")) ||
		!value.seatIds.includes(value.actorRotation.priorSeatId) || !value.seatIds.includes(value.actorRotation.nextSeatId) ||
		value.actorRotation.priorSeatId === value.actorRotation.nextSeatId || value.actorRotation.rootInstanceId !== value.rootInstanceId ||
		!EVENT.test(value.actorRotation.nativePhaseEventId || "") || value.actorRotation.rotationVerified !== true) {
		return reject("EVENT5_PROPOSAL_ACTOR_ROTATION_REJECTED");
	}
	if (!exact(value.inputGate, "nativeEventId,parentEventId,seatId,eventName,rootInstanceId,optionIds,optionKinds,waiting".split(",")) ||
		!EVENT.test(value.inputGate.nativeEventId || "") || !EVENT.test(value.inputGate.parentEventId || "") ||
		value.inputGate.seatId !== value.actorRotation.nextSeatId || value.inputGate.eventName !== "gongJiOrFaShu" ||
		value.inputGate.rootInstanceId !== value.rootInstanceId || value.inputGate.waiting !== true ||
		!idList(value.inputGate.optionIds, OPAQUE, 1, 64) || !exact(value.inputGate.optionKinds, value.inputGate.optionIds) ||
		Object.values(value.inputGate.optionKinds).some(kind => !["gongJi", "faShu", "native_skill"].includes(kind))) {
		return reject("EVENT5_PROPOSAL_INPUT_GATE_REJECTED");
	}
	if (!exact(value.seatBinding, "seatId,connectionGeneration,authenticated,ordinaryPlayer".split(",")) ||
		value.seatBinding.seatId !== value.inputGate.seatId || !Number.isSafeInteger(value.seatBinding.connectionGeneration) ||
		value.seatBinding.connectionGeneration < 1 || value.seatBinding.authenticated !== true || value.seatBinding.ordinaryPlayer !== true) {
		return reject("EVENT5_PROPOSAL_SEAT_BINDING_REJECTED");
	}
	if (!exact(value.choice, "choiceId,seatId,nativeEventId,optionId,immutable".split(",")) ||
		!OPAQUE.test(value.choice.choiceId || "") || value.choice.seatId !== value.inputGate.seatId ||
		value.choice.nativeEventId !== value.inputGate.nativeEventId || !value.inputGate.optionIds.includes(value.choice.optionId) ||
		value.choice.immutable !== true || !exact(value.delivery, "deliveryId,choiceId,nativeEventId,immutable,ackIdempotent".split(",")) ||
		!OPAQUE.test(value.delivery.deliveryId || "") || value.delivery.deliveryId === value.choice.choiceId || value.delivery.choiceId !== value.choice.choiceId ||
		value.delivery.nativeEventId !== value.choice.nativeEventId || value.delivery.immutable !== true || value.delivery.ackIdempotent !== true) {
		return reject("EVENT5_PROPOSAL_CHOICE_DELIVERY_REJECTED");
	}
	if (!exact(value.nativeSettlement, "useResultCompleted,children,allChildrenCompleted,duplicateApplicationCount".split(",")) ||
		value.nativeSettlement.useResultCompleted !== true || value.nativeSettlement.allChildrenCompleted !== true ||
		value.nativeSettlement.duplicateApplicationCount !== 0 || !Array.isArray(value.nativeSettlement.children) ||
		value.nativeSettlement.children.length > 32 || value.nativeSettlement.children.some(child =>
			!exact(child, "nativeEventId,parentEventId,completionOrdinal,completed".split(",")) || !EVENT.test(child.nativeEventId || "") ||
			!EVENT.test(child.parentEventId || "") || !Number.isSafeInteger(child.completionOrdinal) || child.completionOrdinal < 1 || child.completed !== true)) {
		return reject("EVENT5_PROPOSAL_NATIVE_SETTLEMENT_REJECTED");
	}
	if (!exact(value.postStateFence, "nativeEventId,completionOrdinal,atomicCaptureId,authorityPredecessorDigest,privateStateDigestDomain,beforePrivateStateDigest,afterPrivateStateDigest,knownStateOnly".split(",")) ||
		!EVENT.test(value.postStateFence.nativeEventId || "") || !Number.isSafeInteger(value.postStateFence.completionOrdinal) ||
		value.postStateFence.completionOrdinal <= value.phaseOver.completionOrdinal || !OPAQUE.test(value.postStateFence.atomicCaptureId || "") ||
		value.postStateFence.authorityPredecessorDigest !== value.predecessor.digest ||
		value.postStateFence.privateStateDigestDomain !== "xingbei_native_private_action_transition_v1" ||
		!DIGEST.test(value.postStateFence.beforePrivateStateDigest || "") || !DIGEST.test(value.postStateFence.afterPrivateStateDigest || "") ||
		value.postStateFence.knownStateOnly !== true ||
		!exact(value.privateStatePolicy, "noCrossSeatPrivateDisclosure,unknownStateFailsClosed".split(",") ) ||
		value.privateStatePolicy.noCrossSeatPrivateDisclosure !== true || value.privateStatePolicy.unknownStateFailsClosed !== true ||
		!exact(value.unknownStatePolicy, "unsupportedSkillsRejected,unfinishedChildrenRejected,unsupportedDynamicStateRejected".split(",")) ||
		Object.values(value.unknownStatePolicy).some(flag => flag !== true)) return reject("EVENT5_PROPOSAL_POST_FENCE_REJECTED");
	return Object.freeze({ ok: true, reviewable: true, acceptedAuthorityEvent: false, submissionEnabled: false,
		sequence: 5, resultingRevision: null, checkpointAvailable: false });
}

module.exports = { validateEvent5Proposal };
