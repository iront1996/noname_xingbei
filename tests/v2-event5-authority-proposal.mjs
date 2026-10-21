import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateEvent5Proposal } = require("../game/server-managed-authority-event5-proposal.js");
const event = n => `native_event_${String(n).repeat(32)}`;
const opaque = n => `opaque_${String(n).repeat(16)}`;
const base = () => ({ schema: "xingbei_native_action_event5_proposal_v1", proposalOnly: true, submissionEnabled: false,
	roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, engineBuildId: "b".repeat(64), rootInstanceId: `native_root_${"c".repeat(32)}`,
	seatIds: ["seat_a", "seat_b", "seat_c", "seat_d"], predecessor: { eventSequence: 4, revision: 4,
		digestDomain: "xingbei_authority_state_v2", digest: "d".repeat(64) },
	phaseOver: { nativeEventId: event(1), completionOrdinal: 40, parentEventId: event(2), completed: true },
	actorRotation: { priorSeatId: "seat_a", nextSeatId: "seat_b", rootInstanceId: `native_root_${"c".repeat(32)}`,
		nativePhaseEventId: event(3), rotationVerified: true },
	inputGate: { nativeEventId: event(4), parentEventId: event(5), seatId: "seat_b", eventName: "gongJiOrFaShu",
		rootInstanceId: `native_root_${"c".repeat(32)}`, optionIds: [opaque(1), opaque(2)],
		optionKinds: { [opaque(1)]: "gongJi", [opaque(2)]: "native_skill" }, waiting: true },
	seatBinding: { seatId: "seat_b", connectionGeneration: 2, authenticated: true, ordinaryPlayer: true },
	choice: { choiceId: opaque(3), seatId: "seat_b", nativeEventId: event(4), optionId: opaque(1), immutable: true },
	delivery: { deliveryId: opaque(4), choiceId: opaque(3), nativeEventId: event(4), immutable: true, ackIdempotent: true },
	nativeSettlement: { useResultCompleted: true, children: [{ nativeEventId: event(6), parentEventId: event(4), completionOrdinal: 41, completed: true }],
		allChildrenCompleted: true, duplicateApplicationCount: 0 },
	postStateFence: { nativeEventId: event(7), completionOrdinal: 42, atomicCaptureId: opaque(5),
		authorityPredecessorDigest: "d".repeat(64), privateStateDigestDomain: "xingbei_native_private_action_transition_v1",
		beforePrivateStateDigest: "a".repeat(64), afterPrivateStateDigest: "e".repeat(64), knownStateOnly: true },
	privateStatePolicy: { noCrossSeatPrivateDisclosure: true, unknownStateFailsClosed: true },
	unknownStatePolicy: { unsupportedSkillsRejected: true, unfinishedChildrenRejected: true, unsupportedDynamicStateRejected: true } });

test("Event #5 protocol draft is reviewable but cannot enable or accept submission", () => {
	const result = validateEvent5Proposal(base());
	assert.deepEqual(result, { ok: true, reviewable: true, acceptedAuthorityEvent: false, submissionEnabled: false,
		sequence: 5, resultingRevision: null, checkpointAvailable: false });
});

test("Event #5 proposal rejects stale predecessor, first-actor assumptions and cross-root/session event reuse", () => {
	for (const mutate of [
		p => { p.predecessor.revision = 3; },
		p => { p.predecessor.eventSequence = 5; },
		p => { p.actorRotation.nextSeatId = p.actorRotation.priorSeatId; },
		p => { p.inputGate.seatId = "seat_a"; },
		p => { p.inputGate.rootInstanceId = `native_root_${"f".repeat(32)}`; },
		p => { p.inputGate.nativeEventId = p.phaseOver.nativeEventId; },
		p => { p.phaseOver.completed = false; },
	]) { const proposal = base(); mutate(proposal); assert.equal(validateEvent5Proposal(proposal).ok, false); }
});

test("Event #5 proposal rejects stale seat generations, mutable delivery and duplicate native application", () => {
	for (const mutate of [
		p => { p.seatBinding.connectionGeneration = 0; },
		p => { p.seatBinding.ordinaryPlayer = false; },
		p => { p.choice.optionId = opaque(99); },
		p => { p.delivery.deliveryId = p.choice.choiceId; },
		p => { p.delivery.ackIdempotent = false; },
		p => { p.nativeSettlement.duplicateApplicationCount = 1; },
		p => { p.nativeSettlement.allChildrenCompleted = false; },
		p => { p.postStateFence.authorityPredecessorDigest = "f".repeat(64); },
		p => { p.postStateFence.privateStateDigestDomain = "xingbei_authority_state_v2"; },
	]) { const proposal = base(); mutate(proposal); assert.equal(validateEvent5Proposal(proposal).ok, false); }
});

test("Event #5 proposal keeps authority SHA-256 and private T3 digest domains distinct", () => {
	const proposal = base();
	proposal.postStateFence.beforePrivateStateDigest = proposal.predecessor.digest;
	proposal.postStateFence.afterPrivateStateDigest = "f".repeat(64);
	assert.equal(validateEvent5Proposal(proposal).ok, true,
		"equal digest bytes across distinct domains are not treated as semantic equivalence");
	proposal.predecessor.digestDomain = "xingbei_native_private_successor_preaction_capture_v1";
	assert.equal(validateEvent5Proposal(proposal).ok, false, "authority predecessor must carry its own schema domain");
});

test("Event #5 proposal rejects unknown state and attempts to turn review data into authority", () => {
	const unknown = base(); unknown.unknownStatePolicy.unsupportedDynamicStateRejected = false;
	assert.equal(validateEvent5Proposal(unknown).ok, false);
	const enabled = base(); enabled.submissionEnabled = true;
	assert.equal(validateEvent5Proposal(enabled).ok, false);
	const extra = base(); extra.authorityAccepted = true;
	assert.equal(validateEvent5Proposal(extra).ok, false);
});
