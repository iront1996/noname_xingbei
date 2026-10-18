"use strict";

// Review-only evidence classifier. It is deliberately not imported by the
// authority submission path and cannot authorize Event #5.
const DIGEST = /^[a-f0-9]{64}$/;

function unavailable(reason) { return Object.freeze({ status: "unavailable", reason }); }
function observed(source, value) { return Object.freeze({ status: "manager_scoped_review_candidate", source, value }); }

function assessEvent5Evidence(proposal, managerObservation) {
	const proposalValid = Boolean(proposal && proposal.proposalOnly === true && proposal.submissionEnabled === false);
	const observationKeys = "authorityRevision,authoritySubmissionAllowed,checkpointAvailable,choiceAllocated,connectionAuthenticated,connectionGeneration,engineBuildId,event5Accepted,hostSessionId,nativeCompletionOrdinal,nextAuthorityEventSequence,nextInputWaiting,nextSeatId,nativeDeliveryAllowed,optionKinds,ordinaryPlayer,phaseBoundaryReleased,phaseOverCompleted,phaseOverCompletionOrdinal,preActionCaptureOrdinal,predecessorDigest,priorSeatId,roomId,rootInstanceId,reviewOnly,schema,seatIds,seedAuthorized,successorNativeEventId,submissionEnabled";
	const managerValid = Boolean(managerObservation && Object.getPrototypeOf(managerObservation) === Object.prototype &&
		Object.keys(managerObservation).sort().join(",") === observationKeys.split(",").sort().join(",") &&
		managerObservation.schema === "managed_event5_review_observation_v1" && managerObservation.reviewOnly === true &&
		managerObservation.event5Accepted === false && managerObservation.seedAuthorized === false &&
		managerObservation.checkpointAvailable === false && managerObservation.authorityRevision === 4 &&
		managerObservation.nextAuthorityEventSequence === 5 && Number.isSafeInteger(managerObservation.connectionGeneration) &&
		managerObservation.connectionGeneration > 0 && DIGEST.test(managerObservation.predecessorDigest || "") &&
		DIGEST.test(managerObservation.engineBuildId || "") && typeof managerObservation.roomId === "string" &&
		typeof managerObservation.hostSessionId === "string" && typeof managerObservation.rootInstanceId === "string" &&
		Array.isArray(managerObservation.seatIds) && managerObservation.seatIds.length === 4 &&
		managerObservation.seatIds.includes(managerObservation.nextSeatId) && managerObservation.seatIds.includes(managerObservation.priorSeatId) &&
		managerObservation.priorSeatId !== managerObservation.nextSeatId &&
		/^native_event_[a-f0-9]{32}$/.test(managerObservation.successorNativeEventId || "") &&
		Number.isSafeInteger(managerObservation.preActionCaptureOrdinal) && managerObservation.preActionCaptureOrdinal > 0 &&
		Number.isSafeInteger(managerObservation.nativeCompletionOrdinal) && Number.isSafeInteger(managerObservation.phaseOverCompletionOrdinal) &&
		managerObservation.phaseOverCompletionOrdinal > 0 && managerObservation.nativeCompletionOrdinal > managerObservation.phaseOverCompletionOrdinal &&
		managerObservation.preActionCaptureOrdinal === 1 && managerObservation.phaseBoundaryReleased === true && managerObservation.phaseOverCompleted === true &&
		managerObservation.nextInputWaiting === true && managerObservation.choiceAllocated === false &&
		managerObservation.authoritySubmissionAllowed === false && managerObservation.nativeDeliveryAllowed === false &&
		managerObservation.connectionAuthenticated === true && managerObservation.ordinaryPlayer === true &&
		Array.isArray(managerObservation.optionKinds) && managerObservation.optionKinds.length > 0 &&
		managerObservation.optionKinds.every(kind => kind === "gongJi" || kind === "faShu"));

	const classifications = {
		predecessor: managerValid ? observed("host_session_manager_accepted_event4", Object.freeze({ eventSequence: 4,
			revision: 4, digest: managerObservation.predecessorDigest })) : unavailable("accepted_event4_source_missing"),
		phaseOver: managerValid ? observed("validated_managed_atomic_phase_over_fence", Object.freeze({ completed: true,
			completionOrdinal: managerObservation.phaseOverCompletionOrdinal })) : unavailable("phase_over_manager_evidence_missing"),
		actorRotation: managerValid ? observed("authenticated_managed_host_next_input_candidate", Object.freeze({
			priorSeatId: managerObservation.priorSeatId, nextSeatId: managerObservation.nextSeatId,
			nativeEventId: managerObservation.successorNativeEventId, completionOrdinal: managerObservation.nativeCompletionOrdinal })) : unavailable("successor_gate_source_missing"),
		inputGate: managerValid ? observed("authenticated_managed_host_next_input_candidate", Object.freeze({ seatId: managerObservation.nextSeatId,
			nativeEventId: managerObservation.successorNativeEventId, optionKinds: Object.freeze([...managerObservation.optionKinds]), waiting: true })) : unavailable("successor_gate_source_missing"),
		seatBinding: managerValid ? observed("current_seat_registry_binding", Object.freeze({ seatId: managerObservation.nextSeatId,
			connectionGeneration: managerObservation.connectionGeneration, authenticated: true, ordinaryPlayer: true })) : unavailable("seat_registry_source_missing"),
		choice: unavailable("second_seat_action_not_authorized_or_executed"),
		delivery: unavailable("no_second_seat_choice_or_delivery_allocated"),
		nativeSettlement: unavailable("second_seat_native_action_not_executed"),
		postStateFence: unavailable("no_post_action_capture_or_event5_authority"),
	};
	const proposalClaims = Object.freeze({
		completed: proposal?.phaseOver?.completed === true ? "caller_claim_unverified" : "absent_or_false",
		rotationVerified: proposal?.actorRotation?.rotationVerified === true ? "caller_claim_unverified" : "absent_or_false",
		authenticated: proposal?.seatBinding?.authenticated === true ? "caller_claim_unverified" : "absent_or_false",
		knownStateOnly: proposal?.postStateFence?.knownStateOnly === true ? "caller_claim_unverified" : "absent_or_false",
		digest: typeof proposal?.postStateFence?.afterDigest === "string" ? "caller_claim_unverified" : "absent_or_false",
		completionOrdinal: Number.isSafeInteger(proposal?.postStateFence?.completionOrdinal) ? "caller_claim_unverified" : "absent_or_false",
	});
	return Object.freeze({ schema: "xingbei_event5_evidence_provenance_review_v1", reviewOnly: true, proposalStructurallyValid: proposalValid,
		event5Accepted: false, submissionEnabled: false, authorityRevision: 4, nextAuthorityEventSequence: 5,
		seedAuthorized: false, checkpointAvailable: false, reviewObservationShapeValid: managerValid,
		classifications: Object.freeze(classifications), proposalClaims });
}

module.exports = { assessEvent5Evidence };
