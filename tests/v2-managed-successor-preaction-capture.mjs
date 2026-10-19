import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedSuccessorPreActionCapture } = require("../game/server-managed-successor-preaction-capture.js");
const seats = ["seat_a", "seat_b", "seat_c", "seat_d"];
const root = `native_root_${"c".repeat(32)}`;
const session = `hs_${"a".repeat(32)}`;
const build = "b".repeat(64);
const previous = Object.freeze({ roomId: "room_a", hostSessionId: session, rootInstanceId: root, engineBuildId: build,
	seatIds: Object.freeze([...seats]), nativeEventId: `native_${"1".repeat(32)}`, eventInstanceId: "event_5",
	nativeCompletionOrdinal: 9, stateDigest: "d".repeat(64), commitment: "e".repeat(64), captureOrdinal: 1, seatId: "seat_a" });
const binding = Object.freeze({ roomId: "room_a", seatId: "seat_b", connected: true, current: true,
	credentialAuthenticated: true, ordinaryPlayer: true, connectionGeneration: 3 });

function envelope(captureOrdinal = 1) {
	const parentChain = ["game", "phaseLoop", "phase", "xingDong", "gongJiOrFaShu"].map((eventName, index) => ({
		eventName, eventInstanceId: `event_${index + 1}`, step: index === 4 ? 2 : 0,
		seatId: index === 0 ? null : "seat_b", finished: false,
	}));
	const option = `native_option_${"f".repeat(32)}`;
	const resourceSeats = seats.map((seatId, position) => ({ seatId, position, character: `character_${position}`,
		side: position < 2, alive: true, hp: 4, maxHp: 4, zhiLiao: 0, hujiaSupported: false,
		nengLiang: { baoShi: 0, shuiJing: 0, effectiveLimit: 3 } }));
	return { schema: "xingbei_native_private_successor_preaction_capture_v1", captureOrdinal, roomId: "room_a", hostSessionId: session,
		engineBuildId: build, rootInstanceId: root, seatIds: [...seats],
		fence: { captureLockKind: "successor_native_gate_v1", candidateOptionIds: [option], candidateOptionKinds: { [option]: "gongJi" },
			choiceAllocated: false, controllerStatus: "not_allocated", deliveryCount: 0, eventInstanceId: "event_5", eventName: "gongJiOrFaShu",
			eventStep: 2, eventStackConsistent: true, gamePaused: true, inputWaiting: true, nativeCompletionOrdinal: 12,
			nativeEventId: `native_event_${"2".repeat(32)}`, parentChain, pendingInputCount: 1, previousNativeEventId: previous.nativeEventId,
			previousSeatId: "seat_a", rootEventInstanceId: "event_1", rootMatches: true, runnableDescendantCount: 0,
			seatId: "seat_b", useCardChildCount: 0, useResultCount: 0 },
		cardLedger: { schema: "xingbei_native_private_card_ledger_v1", rootInstanceId: root, seatIds: [...seats], cards: [
			{ cardId: "card_1", duYou: null, kind: "physical_dom_card_v1", mingGe: "red", name: "gongJi", ownerSeatId: null,
				position: 0, xiBie: "fire", zone: "draw" }] },
		effectState: { schema: "xingbei_native_private_effect_state_v1", rootInstanceId: root, seatIds: [...seats],
			seats: seats.map(seatId => ({ seatId, skills: [], guiHuo: 0 })) },
		turnResource: { schema: "xingbei_native_private_turn_resource_state_v2", roomId: "room_a", hostSessionId: session,
			engineBuildId: build, rootInstanceId: root, seatIds: [...seats],
			fence: { kind: "managed_native_input_waiting_fence_v1", rootMatches: true, eventStackConsistent: true,
				allChildrenCompleted: false, pendingChildCount: 1, captureLocked: true, nativeCompletionOrdinal: 12 },
			turn: { phase: "xingDong", actorSeatId: "seat_b", phaseLoopSeatId: "seat_b", currentPhaseSeatId: "seat_b",
				gamePhaseNumber: 2, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
			resources: { hongShiQi: 5, lanShiQi: 5, hongXingBei: 0, lanXingBei: 0, hongZhanJi: [], lanZhanJi: [] }, seats: resourceSeats },
	};
}

function createCapture() {
	return createManagedSuccessorPreActionCapture({ roomId: "room_a", sessionId: session, engineBuildId: build,
		rootInstanceId: root, seatIds: seats, previousCapture: previous, previousActorSeatId: "seat_a", seatBinding: binding,
		key: Buffer.alloc(32, 9) });
}

test("successor gate capture binds a distinct actor/event and repeats only stable state without allocating a choice", () => {
	const capture = createCapture();
	const first = capture.commit(envelope(), { nativeEventId: `native_event_${"2".repeat(32)}`, seatId: "seat_b", nativeCompletionOrdinal: 12,
		eventInstanceId: "event_5", parentEventInstanceId: "event_4" });
	assert.equal(first.seatId, "seat_b");
	assert.equal(first.previousSeatId, "seat_a");
	assert.equal(first.captureOrdinal, 1);
	assert.equal(first.choiceAllocated, false);
	assert.equal(first.authoritySubmissionAllowed, false);
	assert.equal(first.authorityRevision, 4);
	assert.equal(first.nextAuthorityEventSequence, 5);
	assert.equal(first.checkpointAvailable, false);
	const repeated = capture.commit(envelope(2), { nativeEventId: first.nativeEventId, seatId: "seat_b", nativeCompletionOrdinal: 12,
		eventInstanceId: "event_5", parentEventInstanceId: "event_4" });
	assert.equal(repeated.captureOrdinal, 2);
	assert.equal(repeated.stateDigest, first.stateDigest);
	assert.equal(repeated.stableWithPrevious, true);
	assert.notEqual(repeated.commitment, first.commitment);
	capture.destroy();
});

test("successor gate capture rejects caller claims, stale identities, cross-seat projections and changed repeat state", () => {
	const mutations = [
		e => { e.captureOrdinal = 2; },
		e => { e.fence.choiceAllocated = true; },
		e => { e.fence.controllerStatus = "pending"; },
		e => { e.fence.previousNativeEventId = e.fence.nativeEventId; },
		e => { e.fence.nativeEventId = previous.nativeEventId; },
		e => { e.fence.seatId = "seat_a"; },
		e => { e.fence.nativeCompletionOrdinal = 9; },
		e => { e.fence.pendingInputCount = 0; },
		e => { e.fence.runnableDescendantCount = 1; },
		e => { e.turnResource.turn.actorSeatId = "seat_a"; },
		e => { e.fence.candidateOptionKinds[Object.keys(e.fence.candidateOptionKinds)[0]] = "arbitrary"; },
	];
	for (const mutate of mutations) {
		const capture = createCapture();
		const candidate = envelope(); mutate(candidate);
		assert.throws(() => capture.commit(candidate), /(?:SUCCESSOR_PREACTION_|NATIVE_(?:TURN|CARD|EFFECT)_)/);
		assert.equal(capture.commit(envelope()).captureOrdinal, 1, "rejected evidence must not consume an ordinal");
		capture.destroy();
	}
	const capture = createCapture();
	const first = capture.commit(envelope());
	const changed = envelope(2); changed.turnResource.resources.hongShiQi = 4;
	assert.throws(() => capture.commit(changed), /SUCCESSOR_PREACTION_REPEAT_STATE_CHANGED/);
	capture.destroy();
});

test("successor capture rejects caller event-instance claims that do not match native parent-chain evidence", () => {
	for (const expected of [
		{ eventInstanceId: "event_6", parentEventInstanceId: "event_4" },
		{ eventInstanceId: "event_5", parentEventInstanceId: "event_3" },
	]) {
		const capture = createCapture();
		assert.throws(() => capture.commit(envelope(), { nativeEventId: `native_event_${"2".repeat(32)}`,
			seatId: "seat_b", nativeCompletionOrdinal: 12, ...expected }), /SUCCESSOR_PREACTION_EVENT_BINDING_INVALID/);
		capture.destroy();
	}
});

test("successor capture rejects stale seat generation and destroys private commitment key", () => {
	assert.throws(() => createManagedSuccessorPreActionCapture({ roomId: "room_a", sessionId: session, engineBuildId: build,
		rootInstanceId: root, seatIds: seats, previousCapture: previous, previousActorSeatId: "seat_a",
		seatBinding: { ...binding, current: false }, key: Buffer.alloc(32, 9) }), /SUCCESSOR_PREACTION_CONFIG_INVALID/);
	const capture = createCapture(); capture.destroy();
	assert.throws(() => capture.commit(envelope()), /SUCCESSOR_PREACTION_DESTROYED/);
});
