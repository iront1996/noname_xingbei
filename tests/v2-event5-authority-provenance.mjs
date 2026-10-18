import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { assessEvent5Evidence } = require("../game/server-managed-authority-event5-provenance.js");
const digest = value => String(value).repeat(64);
const event = value => `native_event_${String(value).repeat(32)}`;
const observation = () => ({ schema: "managed_event5_review_observation_v1", reviewOnly: true, event5Accepted: false,
	submissionEnabled: false, authorityRevision: 4, nextAuthorityEventSequence: 5, seedAuthorized: false, checkpointAvailable: false,
	roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, engineBuildId: digest("b"), rootInstanceId: `native_root_${"c".repeat(32)}`,
	seatIds: ["seat_a", "seat_b", "seat_c", "seat_d"], predecessorDigest: digest("d"), predecessorDigestDomain: "xingbei_authority_state_v2",
	successorCaptureSchema: "xingbei_native_private_successor_preaction_commitment_v1", phaseBoundaryReleased: true,
	phaseOverCompleted: true, phaseOverCompletionOrdinal: 40, priorSeatId: "seat_a", nextSeatId: "seat_b", successorNativeEventId: event(1),
	nativeCompletionOrdinal: 45, preActionCaptureOrdinal: 1, nextInputWaiting: true, choiceAllocated: false,
	nativeDeliveryAllowed: false, authoritySubmissionAllowed: false, connectionGeneration: 3, connectionAuthenticated: true,
	ordinaryPlayer: true, optionKinds: ["faShu", "gongJi"] });
const proposal = () => ({ proposalOnly: true, submissionEnabled: false,
	phaseOver: { completed: true, completionOrdinal: 999 }, actorRotation: { rotationVerified: true },
	seatBinding: { authenticated: true }, postStateFence: { knownStateOnly: true, afterPrivateStateDigest: digest("e"), completionOrdinal: 1000 } });

test("Event #5 review provenance independently supports only manager-observed predecessor and successor waiting gate", () => {
	const result = assessEvent5Evidence(proposal(), observation());
	assert.equal(result.proposalStructurallyValid, true);
	assert.equal(result.reviewObservationShapeValid, true);
	for (const field of ["predecessor", "actorRotation", "inputGate", "seatBinding"]) {
		assert.equal(result.classifications[field].status, "manager_scoped_review_candidate", field);
	}
	assert.equal(result.classifications.phaseOver.status, "manager_scoped_review_candidate", "only validated atomic phaseOver evidence may support this field");
	assert.equal(result.digestDomains.authorityPredecessor.value, "xingbei_authority_state_v2");
	assert.equal(result.digestDomains.privateSuccessorCapture.value, "xingbei_native_private_successor_preaction_commitment_v1");
	assert.equal(result.digestDomains.crossDomainEquality.status, "unavailable");
	assert.equal(result.digestDomains.bridgeFromEvent4ToSuccessor.status, "unavailable");
	for (const field of ["choice", "delivery", "nativeSettlement", "postStateFence"]) {
		assert.equal(result.classifications[field].status, "unavailable", field);
	}
	assert.equal(result.proposalClaims.completed, "caller_claim_unverified");
	assert.equal(result.proposalClaims.rotationVerified, "caller_claim_unverified");
	assert.equal(result.proposalClaims.authenticated, "caller_claim_unverified");
	assert.equal(result.proposalClaims.knownStateOnly, "caller_claim_unverified");
	assert.equal(result.proposalClaims.digest, "caller_claim_unverified");
	assert.equal(result.proposalClaims.completionOrdinal, "caller_claim_unverified");
	assert.equal(result.event5Accepted, false);
	assert.equal(result.submissionEnabled, false);
	assert.equal(result.authorityRevision, 4);
	assert.equal(result.nextAuthorityEventSequence, 5);
	assert.equal(result.seedAuthorized, false);
	assert.equal(result.checkpointAvailable, false);
});

test("Event #5 caller claims cannot manufacture provenance when manager observation is missing, stale or cross-bound", () => {
	for (const mutate of [
		value => { value.schema = "forged_observation"; },
		value => { value.predecessorDigestDomain = "xingbei_native_private_successor_preaction_capture_v1"; },
		value => { value.nextAuthorityEventSequence = 6; },
		value => { value.authorityRevision = 3; },
		value => { value.connectionAuthenticated = false; },
		value => { value.nextSeatId = "seat_z"; },
		value => { value.phaseOverCompleted = false; },
		value => { value.choiceAllocated = true; },
		value => { value.authoritySubmissionAllowed = true; },
		value => { value.unreviewedExtra = true; },
	]) {
		let observed = observation(); observed = mutate(observed) || observed;
		const result = assessEvent5Evidence(proposal(), observed);
		assert.equal(result.reviewObservationShapeValid, false);
		for (const field of ["predecessor", "phaseOver", "actorRotation", "inputGate", "seatBinding", "choice", "delivery", "nativeSettlement", "postStateFence"])
			assert.equal(result.classifications[field].status, "unavailable", field);
		assert.equal(result.event5Accepted, false);
	}
	const noObservation = assessEvent5Evidence(proposal(), null);
	assert.equal(noObservation.classifications.inputGate.status, "unavailable");
});
