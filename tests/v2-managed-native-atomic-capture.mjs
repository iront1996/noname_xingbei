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
		schema: "xingbei_native_private_atomic_capture_v1", captureOrdinal: ordinal, roomId: "room_a", hostSessionId: sessionId,
		engineBuildId, rootInstanceId: root, seatIds: [...seats],
		fence: { allChildrenCompleted: true, captureLocked: true, eventName: "phaseLoop", eventStep: 2,
			eventStackConsistent: true, nativeCompletionOrdinal: 9, pendingChildCount: 0, rootMatches: true, seatId: "seat_a" },
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
			turn: { phase: "between_turns", actorSeatId: "seat_a", phaseLoopSeatId: "seat_a", currentPhaseSeatId: null,
				gamePhaseNumber: 1, playerPhaseNumber: 0, quotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
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
	assert.equal(result.nativeCompletionOrdinal, 9);
	assert.equal(result.projectionCount, 3);
	assert.equal(result.atomicWithEffectSnapshots, true);
	assert.equal(result.authoritySeedAuthorized, false);
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
