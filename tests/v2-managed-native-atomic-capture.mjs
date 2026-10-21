import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedNativeAtomicCapture } = require("../game/server-managed-native-atomic-capture.js");
const seats = ["seat_a", "seat_b", "seat_c", "seat_d"];
const root = `native_root_${"c".repeat(32)}`;
const sessionId = `hs_${"a".repeat(32)}`;
const engineBuildId = "b".repeat(64);

function envelope(ordinal = 1) {
	const seatRows = seats.map((seatId, position) => ({ seatId, position, character: `character_${position}`,
		side: position < 2, alive: true, hp: 4, maxHp: 4, zhiLiao: 0, hujiaSupported: false,
		nengLiang: { baoShi: 0, shuiJing: 0, effectiveLimit: 3 } }));
	return {
		schema: "xingbei_native_private_atomic_capture_v2", captureOrdinal: ordinal, roomId: "room_a", hostSessionId: sessionId,
		engineBuildId, rootInstanceId: root, seatIds: [...seats],
		fence: { allChildrenCompleted: true, boundaryOrdinal: 1, captureLocked: true, eventName: "phaseLoop", eventStep: 3,
			eventStackConsistent: true, nativeCompletionOrdinal: 9, nextActorSeatId: "seat_b", pendingChildCount: 0, phaseOverTriggerCount: 1, rootMatches: true, seatId: "seat_a",
			completionEvidence: { rootInstanceId: root, eventInstanceId: "event_4", parentEventInstanceId: "event_3",
				completionOrdinal: 8, eventName: "phase", parentEventName: "phaseLoop", seatId: "seat_a", eventStep: 4 },
			phaseOverCompletionEvidence: { kind: "native_phase_over_dispatch_v1", rootInstanceId: root, ownerEventInstanceId: "event_3",
				ownerEventName: "phaseLoop", ownerEventStep: 2, triggerOrdinal: 1, triggerName: "phaseOver", seatId: "seat_a",
				phaseEventInstanceId: "event_4", phaseCompletionOrdinal: 8,
				childEventInstanceId: null, childEventName: null, childParentEventInstanceId: null, childCompletionOrdinal: null } },
		cardLedger: { schema: "xingbei_native_private_card_ledger_v1", rootInstanceId: root, seatIds: [...seats], cards: [
			{ cardId: "card_1", duYou: null, kind: "physical_dom_card_v1", mingGe: "red", name: "sha", ownerSeatId: null,
				position: 0, xiBie: "fire", zone: "draw" },
		] },
		effectState: { schema: "xingbei_native_private_effect_state_v1", rootInstanceId: root, seatIds: [...seats],
			seats: seats.map(seatId => ({ seatId, skills: [], guiHuo: 0 })) },
		turnResource: {
			schema: "xingbei_native_private_turn_resource_state_v2", roomId: "room_a", hostSessionId: sessionId,
			engineBuildId, rootInstanceId: root, seatIds: [...seats],
			fence: { kind: "managed_native_quiescent_fence_v1", rootMatches: true, eventStackConsistent: true,
				allChildrenCompleted: true, pendingChildCount: 0, captureLocked: true, nativeCompletionOrdinal: 9 },
			turn: { phase: "between_turns", actorSeatId: "seat_a", phaseLoopSeatId: "seat_b", currentPhaseSeatId: null,
				gamePhaseNumber: 1, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
			resources: { hongShiQi: 5, lanShiQi: 5, hongXingBei: 0, lanXingBei: 0, hongZhanJi: [], lanZhanJi: [] },
			seats: seatRows,
		},
	};
}

function coordinator() {
	return createManagedNativeAtomicCapture({ roomId: "room_a", sessionId, engineBuildId, rootInstanceId: root,
		seatIds: seats, key: Buffer.alloc(32, 7) });
}

test("atomic capture commits all three validated native projections at one ordinal", () => {
	const capture = coordinator();
	const result = capture.commit(envelope());
	assert.equal(result.captureOrdinal, 1);
	assert.equal(result.nativeFenceOrdinal, 1);
	assert.equal(result.nativeCompletionOrdinal, 9);
	assert.equal(result.projectionCount, 3);
	assert.equal(result.atomicWithEffectSnapshots, true);
	assert.deepEqual(result.nativeTurnSummary, { actorSeatId: "seat_a", phaseLoopSeatId: "seat_b", phase: "between_turns",
		gamePhaseNumber: 1, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 } });
	assert.equal(result.authoritySeedAuthorized, false);
	assert.deepEqual(result.achievementResourceSummary.hong, { count: 0, baoShiCount: 0, shuiJingCount: 0,
		digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" });
	assert.deepEqual(result.achievementResourceSummary.lan, result.achievementResourceSummary.hong);
	assert.equal(result.checkpointAvailable, false);
	assert.equal(result.stableProjectionsWithPrevious, null);
	capture.destroy();
});

test("atomic capture is fail-closed and a rejected projection consumes no ordinal", () => {
	const capture = coordinator();
	const invalid = envelope();
	invalid.turnResource.turn.extraXingDong = [{ xingDong: "gongJi" }];
	assert.throws(() => capture.commit(invalid), /NATIVE_TURN_STATE_V2_/);
	assert.equal(capture.commit(envelope()).captureOrdinal, 1);
	capture.destroy();
});

test("atomic capture rejects unsupported effect state without committing a partial private snapshot", () => {
	const invalidCases = [
		{ code: "NATIVE_EFFECT_STATE_SKILL_UNSUPPORTED", mutate: value => {
			value.effectState.seats[0].skills = [{ id: "unreviewedSkill", present: true, source: "native_hasSkill" }];
		} },
		{ code: "NATIVE_EFFECT_STATE_SEAT_INVALID", mutate: value => {
			value.effectState.seats[0].storage = { unreviewed: true };
		} },
		{ code: "NATIVE_EFFECT_STATE_SEAT_INVALID", mutate: value => {
			value.effectState.seats[0].guiHuo = 4;
		} },
		{ code: "NATIVE_EFFECT_STATE_SNAPSHOT_INVALID", mutate: value => {
			value.effectState.seats.pop();
		} },
	];
	for (const { code, mutate } of invalidCases) {
		const capture = coordinator();
		const invalid = envelope();
		mutate(invalid);
		assert.throws(() => capture.commit(invalid), { message: code });
		const accepted = capture.commit(envelope());
		assert.equal(accepted.captureOrdinal, 1,
			"a rejected effect projection must not consume an ordinal or expose a partial commitment");
		assert.equal(accepted.projectionCount, 3);
		capture.destroy();
	}
});

test("atomic capture rejects projection boundary drift, replay and post-destroy use", () => {
	const capture = coordinator();
	const drift = envelope();
	drift.turnResource.fence.nativeCompletionOrdinal++;
	assert.throws(() => capture.commit(drift), /NATIVE_ATOMIC_CAPTURE_PROJECTION_MISMATCH/);
	const first = capture.commit(envelope());
	assert.throws(() => capture.commit(envelope()), /NATIVE_ATOMIC_CAPTURE_BINDING_INVALID/);
	assert.equal(first.captureOrdinal, 1);
	capture.destroy();
	assert.throws(() => capture.commit(envelope(2)), /NATIVE_ATOMIC_CAPTURE_DESTROYED/);
});

test("atomic capture requires same-root native phase completion evidence before commitment", () => {
	const capture = coordinator();
	const invalid = envelope();
	invalid.fence.completionEvidence.parentEventName = "otherRoot";
	assert.throws(() => capture.commit(invalid), /NATIVE_ATOMIC_CAPTURE_COMPLETION_EVIDENCE_INVALID/);
	assert.equal(capture.commit(envelope()).captureOrdinal, 1, "invalid completion evidence must not consume a capture ordinal");
	const replay = envelope(2);
	replay.fence.completionEvidence.eventInstanceId = replay.fence.completionEvidence.parentEventInstanceId;
	assert.throws(() => capture.commit(replay), /NATIVE_ATOMIC_CAPTURE_COMPLETION_EVIDENCE_INVALID/);
	capture.destroy();
});

test("atomic capture rejects the phaseLoop step before native phaseOver dispatch", () => {
	const capture = coordinator();
	const candidate = envelope();
	candidate.fence.eventStep = 2;
	assert.throws(() => capture.commit(candidate), { message: "NATIVE_ATOMIC_CAPTURE_FENCE_INVALID" });
	assert.equal(capture.commit(envelope()).captureOrdinal, 1, "rejecting the pre-trigger step must not consume the ordinal");
});

test("atomic capture distinguishes an empty native trigger dispatch from a completed trigger child", () => {
	const capture = coordinator();
	const noChild = envelope();
	assert.equal(capture.commit(noChild).captureOrdinal, 1,
		"a real phaseOver trigger dispatch with no scheduled trigger event is valid only at the completed parent boundary");
	const childBoundary = envelope(2);
	childBoundary.fence.nativeCompletionOrdinal = 11;
	childBoundary.fence.boundaryOrdinal = 2;
	childBoundary.fence.completionEvidence.completionOrdinal = 9;
	childBoundary.fence.completionEvidence.eventInstanceId = "event_8";
	childBoundary.fence.completionEvidence.parentEventInstanceId = "event_7";
	childBoundary.fence.completionEvidence.seatId = "seat_b";
	childBoundary.fence.phaseOverTriggerCount = 2;
	childBoundary.fence.phaseOverCompletionEvidence = { kind: "native_phase_over_dispatch_v1", rootInstanceId: root,
		ownerEventInstanceId: "event_7", ownerEventName: "phaseLoop", ownerEventStep: 2, triggerOrdinal: 2,
		triggerName: "phaseOver", seatId: "seat_b", phaseEventInstanceId: "event_8", phaseCompletionOrdinal: 9,
		childEventInstanceId: "event_9", childEventName: "arrangeTrigger",
		childParentEventInstanceId: "event_7", childCompletionOrdinal: 10 };
	childBoundary.fence.seatId = "seat_b";
	childBoundary.fence.nextActorSeatId = "seat_c";
	childBoundary.turnResource.turn.actorSeatId = "seat_b";
	childBoundary.turnResource.turn.phaseLoopSeatId = "seat_c";
	childBoundary.turnResource.fence.nativeCompletionOrdinal = 11;
	assert.equal(capture.commit(childBoundary).captureOrdinal, 2,
		"a scheduled native trigger child must be represented by a completed child instance and ordinal");
	capture.destroy();

	const invalid = coordinator();
	const missingChildCompletion = envelope();
	missingChildCompletion.fence.phaseOverCompletionEvidence = { ...missingChildCompletion.fence.phaseOverCompletionEvidence,
		childEventInstanceId: "event_6", childEventName: "arrangeTrigger" };
	assert.throws(() => invalid.commit(missingChildCompletion), /NATIVE_ATOMIC_CAPTURE_PHASE_OVER_EVIDENCE_INVALID/);
	invalid.destroy();
});

test("atomic capture accepts a later completed phase from another seat on the same root", () => {
	const capture = coordinator();
	const first = capture.commit(envelope());
	assert.equal(first.captureOrdinal, 1);
	const later = envelope(2);
	later.fence.boundaryOrdinal = 2;
	later.fence.phaseOverTriggerCount = 2;
	later.fence.seatId = "seat_b";
	later.fence.nextActorSeatId = "seat_c";
	later.fence.nativeCompletionOrdinal = 12;
	later.fence.completionEvidence = { rootInstanceId: root, eventInstanceId: "event_8", parentEventInstanceId: "event_7",
		completionOrdinal: 11, eventName: "phase", parentEventName: "phaseLoop", seatId: "seat_b", eventStep: 4 };
	later.fence.phaseOverCompletionEvidence = { kind: "native_phase_over_dispatch_v1", rootInstanceId: root, ownerEventInstanceId: "event_7",
		ownerEventName: "phaseLoop", ownerEventStep: 2, triggerOrdinal: 2, triggerName: "phaseOver", seatId: "seat_b",
		phaseEventInstanceId: "event_8", phaseCompletionOrdinal: 11,
		childEventInstanceId: null, childEventName: null, childParentEventInstanceId: null, childCompletionOrdinal: null };
	later.turnResource.fence.nativeCompletionOrdinal = 12;
	later.turnResource.turn.actorSeatId = "seat_b";
	later.turnResource.turn.phaseLoopSeatId = "seat_c";
	const second = capture.commit(later);
	assert.equal(second.captureOrdinal, 2);
	assert.equal(second.nativeFenceOrdinal, 2);
	assert.equal(second.nativeCompletionOrdinal, 12);
	assert.deepEqual(second.nativeTurnSummary, { actorSeatId: "seat_b", phaseLoopSeatId: "seat_c", phase: "between_turns",
		gamePhaseNumber: 1, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 } });
	assert.notEqual(second.commitment, first.commitment,
		"a subsequent distinct native phase/state capture must receive a distinct commitment");
	capture.destroy();
});

test("atomic capture rejects completion ordinal rollback and replayed event instances", () => {
	const capture = coordinator();
	assert.equal(capture.commit(envelope()).captureOrdinal, 1);
	const forkedSameOrdinal = envelope(2);
	forkedSameOrdinal.fence.completionEvidence.eventInstanceId = "event_6";
	forkedSameOrdinal.fence.completionEvidence.parentEventInstanceId = "event_5";
	forkedSameOrdinal.fence.phaseOverCompletionEvidence.ownerEventInstanceId = "event_5";
	forkedSameOrdinal.fence.phaseOverCompletionEvidence.phaseEventInstanceId = "event_6";
	forkedSameOrdinal.fence.phaseOverCompletionEvidence.phaseCompletionOrdinal = 8;
	assert.throws(() => capture.commit(forkedSameOrdinal), /NATIVE_ATOMIC_CAPTURE_COMPLETION_SEQUENCE_INVALID/);
	const rollback = envelope(2);
	rollback.fence.nativeCompletionOrdinal = 8;
	rollback.fence.completionEvidence.completionOrdinal = 7;
	rollback.fence.completionEvidence.eventInstanceId = "event_6";
	rollback.fence.completionEvidence.parentEventInstanceId = "event_5";
	rollback.fence.phaseOverCompletionEvidence.ownerEventInstanceId = "event_5";
	rollback.fence.phaseOverCompletionEvidence.phaseEventInstanceId = "event_6";
	rollback.fence.phaseOverCompletionEvidence.phaseCompletionOrdinal = 7;
	rollback.turnResource.fence.nativeCompletionOrdinal = 8;
	assert.throws(() => capture.commit(rollback), /NATIVE_ATOMIC_CAPTURE_COMPLETION_SEQUENCE_INVALID/);
	const replay = envelope(2);
	replay.fence.nativeCompletionOrdinal = 10;
	replay.fence.completionEvidence.completionOrdinal = 9;
	replay.fence.phaseOverCompletionEvidence.phaseCompletionOrdinal = 9;
	replay.turnResource.fence.nativeCompletionOrdinal = 10;
	assert.throws(() => capture.commit(replay), /NATIVE_ATOMIC_CAPTURE_COMPLETION_SEQUENCE_INVALID/);
	assert.equal(capture.commit(envelope(2)).captureOrdinal, 2,
		"refused proof must not consume an ordinal or poison the last accepted completion tip");
	capture.destroy();
});

test("atomic capture binds completed phase evidence to its next live actor", () => {
	const badPhase = coordinator();
	const phaseMismatch = envelope();
	phaseMismatch.fence.phaseOverCompletionEvidence.phaseEventInstanceId = "event_5";
	assert.throws(() => badPhase.commit(phaseMismatch), /NATIVE_ATOMIC_CAPTURE_PHASE_OVER_EVIDENCE_INVALID/);
	assert.equal(badPhase.commit(envelope()).captureOrdinal, 1, "a mismatched phase proof must not consume a capture ordinal");
	badPhase.destroy();

	const badRotation = coordinator();
	const wrongNext = envelope();
	wrongNext.fence.nextActorSeatId = "seat_d";
	wrongNext.turnResource.turn.phaseLoopSeatId = "seat_d";
	assert.throws(() => badRotation.commit(wrongNext), /NATIVE_ATOMIC_CAPTURE_NEXT_ACTOR_INVALID/);
	assert.equal(badRotation.commit(envelope()).captureOrdinal, 1, "a wrong native successor must not consume a capture ordinal");
	badRotation.destroy();
});

test("atomic capture rejects skipped, reused-seat and non-advancing native fences", () => {
	const cases = [
		{ code: "NATIVE_ATOMIC_CAPTURE_COMPLETION_SEQUENCE_INVALID", mutate: later => {
			later.fence.boundaryOrdinal = 3;
			later.fence.phaseOverTriggerCount = 3;
			later.fence.phaseOverCompletionEvidence.triggerOrdinal = 3;
		} },
		{ code: "NATIVE_ATOMIC_CAPTURE_COMPLETION_SEQUENCE_INVALID", mutate: later => {
			later.fence.boundaryOrdinal = 2;
			later.fence.phaseOverTriggerCount = 2;
			later.fence.seatId = "seat_a";
			later.fence.completionEvidence.seatId = "seat_a";
			later.fence.phaseOverCompletionEvidence.seatId = "seat_a";
			later.turnResource.turn.actorSeatId = "seat_a";
			later.turnResource.turn.phaseLoopSeatId = "seat_a";
		} },
		{ code: "NATIVE_ATOMIC_CAPTURE_FENCE_INVALID", mutate: later => {
			later.fence.boundaryOrdinal = 2;
			later.fence.phaseOverTriggerCount = 1;
			later.fence.phaseOverCompletionEvidence.triggerOrdinal = 1;
		} },
	];
	for (const { code, mutate } of cases) {
		const capture = coordinator();
		capture.commit(envelope());
		const later = envelope(2);
		later.fence.seatId = "seat_b";
		later.fence.nextActorSeatId = "seat_c";
		later.fence.nativeCompletionOrdinal = 12;
		later.fence.completionEvidence = { rootInstanceId: root, eventInstanceId: "event_8", parentEventInstanceId: "event_7",
			completionOrdinal: 11, eventName: "phase", parentEventName: "phaseLoop", seatId: "seat_b", eventStep: 4 };
			later.fence.phaseOverCompletionEvidence = { kind: "native_phase_over_dispatch_v1", rootInstanceId: root, ownerEventInstanceId: "event_7",
				ownerEventName: "phaseLoop", ownerEventStep: 2, triggerOrdinal: 2, triggerName: "phaseOver", seatId: "seat_b",
				phaseEventInstanceId: "event_8", phaseCompletionOrdinal: 11,
				childEventInstanceId: null, childEventName: null, childParentEventInstanceId: null, childCompletionOrdinal: null };
		later.turnResource.fence.nativeCompletionOrdinal = 12;
		later.turnResource.turn.actorSeatId = "seat_b";
		later.turnResource.turn.phaseLoopSeatId = "seat_c";
		mutate(later);
		assert.throws(() => capture.commit(later), new RegExp(code));
		assert.equal(capture.commit(envelope(2)).captureOrdinal, 2, "rejected fence must leave the accepted tip and capture ordinal unchanged");
		capture.destroy();
	}
});
