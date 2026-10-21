import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedNativePreActionCapture } = require("../game/server-managed-native-preaction-capture.js");
const seats = ["seat_a", "seat_b", "seat_c", "seat_d"];
const root = `native_root_${"c".repeat(32)}`;
const sessionId = `hs_${"a".repeat(32)}`;
const engineBuildId = "b".repeat(64);

function envelope() {
	const parentChain = ["game", "phaseLoop", "phase", "xingDong", "gongJiOrFaShu"].map((eventName, index) => ({
		eventName, eventInstanceId: `event_${index + 1}`, step: index === 4 ? 1 : 0,
		seatId: index === 0 ? null : "seat_a", finished: false,
	}));
	const seatsProjection = seats.map((seatId, position) => ({ seatId, position, character: `character_${position}`,
		side: position < 2, alive: true, hp: 4, maxHp: 4, zhiLiao: 0, hujiaSupported: false,
		nengLiang: { baoShi: 0, shuiJing: 0, effectiveLimit: 3 } }));
	return {
		schema: "xingbei_native_private_pre_action_capture_v1", captureOrdinal: 1, roomId: "room_a", hostSessionId: sessionId,
		engineBuildId, rootInstanceId: root, seatIds: [...seats],
		fence: { captureLockKind: "single_turn_native_task_v1", choiceId: `choice_${"d".repeat(32)}`,
			controllerStatus: "pending", deliveryCount: 0, eventInstanceId: "event_5", eventName: "gongJiOrFaShu", eventStep: 1,
			eventStackConsistent: true, gamePaused: true, inputWaiting: true, nativeCompletionOrdinal: 9,
			nativeEventId: `native_${"e".repeat(32)}`, parentChain, pendingInputCount: 1,
			rootEventInstanceId: "event_1", rootMatches: true, runnableDescendantCount: 0, resultPresent: false,
			seatId: "seat_a", useCardChildCount: 0, useResultCount: 0 },
		cardLedger: { schema: "xingbei_native_private_card_ledger_v1", rootInstanceId: root, seatIds: [...seats], cards: [
			{ cardId: "card_1", duYou: null, kind: "physical_dom_card_v1", mingGe: "red", name: "gongJi", ownerSeatId: null,
				position: 0, xiBie: "fire", zone: "draw" },
		] },
		effectState: { schema: "xingbei_native_private_effect_state_v1", rootInstanceId: root, seatIds: [...seats],
			seats: seats.map(seatId => ({ seatId, skills: [], guiHuo: 0 })) },
		turnResource: { schema: "xingbei_native_private_turn_resource_state_v2", roomId: "room_a", hostSessionId: sessionId,
			engineBuildId, rootInstanceId: root, seatIds: [...seats],
			fence: { kind: "managed_native_input_waiting_fence_v1", rootMatches: true, eventStackConsistent: true,
				allChildrenCompleted: false, pendingChildCount: 1, captureLocked: true, nativeCompletionOrdinal: 9 },
			turn: { phase: "xingDong", actorSeatId: "seat_a", phaseLoopSeatId: "seat_a", currentPhaseSeatId: "seat_a",
				gamePhaseNumber: 1, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
			resources: { hongShiQi: 5, lanShiQi: 5, hongXingBei: 0, lanXingBei: 0, hongZhanJi: [], lanZhanJi: [] },
			seats: seatsProjection },
	};
}

function createCapture() {
	return createManagedNativePreActionCapture({ roomId: "room_a", sessionId, engineBuildId, rootInstanceId: root,
		seatIds: seats, key: Buffer.alloc(32, 7) });
}

test("pre-action capture validates an input-waiting fence without claiming native event completion", () => {
	const coordinator = createCapture();
	const result = coordinator.commit(envelope(), { nativeCompletionOrdinal: 9, nativeEventId: `native_${"e".repeat(32)}`,
		choiceId: `choice_${"d".repeat(32)}`, seatId: "seat_a" });
	assert.equal(result.boundaryKind, "native_input_waiting_quiescent");
	assert.equal(result.nativeCompletionOrdinal, 9);
	assert.equal(result.projectionCount, 3);
	assert.equal(result.authoritySeedAuthorized, false);
	assert.equal(result.checkpointAvailable, false);
	assert.equal(result.eventInstanceId, "event_5");
	assert.equal(result.captureOrdinal, 1);
	assert.deepEqual(result.achievementResourceBinding.hong, { count: 0, baoShiCount: 0, shuiJingCount: 0,
		digest: crypto.createHash("sha256").update("[]").digest("hex") });
	assert.deepEqual(result.achievementResourceBinding.lan, result.achievementResourceBinding.hong);
	assert.equal(result.roomId, "room_a");
	assert.equal(result.hostSessionId, sessionId);
	coordinator.destroy();
});

test("pre-action fence rejects completed-event claims, changed event identities, and premature results", () => {
	const cases = [
		f => { f.pendingInputCount = 0; },
		f => { f.resultPresent = true; },
		f => { f.useResultCount = 1; },
		f => { f.useCardChildCount = 1; },
		f => { f.gamePaused = false; },
		f => { f.runnableDescendantCount = 1; },
		f => { f.parentChain[2].eventName = "other"; },
		f => { f.parentChain[4].eventInstanceId = "event_9"; },
	];
	for (const mutate of cases) {
		const coordinator = createCapture();
		const candidate = envelope();
		mutate(candidate.fence);
		assert.throws(() => coordinator.commit(candidate), /NATIVE_PREACTION_CAPTURE_/);
		assert.equal(coordinator.commit(envelope()).captureOrdinal, 1, "a rejected proof must not consume an ordinal");
		coordinator.destroy();
	}
});

test("pre-action capture binds all projections and rejects duplicate or cross-session evidence", () => {
	const coordinator = createCapture();
	const candidate = envelope();
	candidate.turnResource.fence.nativeCompletionOrdinal++;
	assert.throws(() => coordinator.commit(candidate), /NATIVE_PREACTION_CAPTURE_PROJECTION_MISMATCH/);
	const accepted = coordinator.commit(envelope());
	assert.equal(accepted.captureOrdinal, 1);
	assert.throws(() => coordinator.commit(envelope()), /NATIVE_PREACTION_CAPTURE_ALREADY_COMMITTED/);
	coordinator.destroy();
	assert.throws(() => coordinator.commit(envelope()), /NATIVE_PREACTION_CAPTURE_DESTROYED/);
});

test("turn/resource projection accepts a distinct input-waiting fence without weakening completed fences", () => {
	const coordinator = createCapture();
	const value = envelope();
	value.turnResource.fence.kind = "managed_native_quiescent_fence_v1";
	value.turnResource.fence.allChildrenCompleted = true;
	value.turnResource.fence.pendingChildCount = 0;
	assert.throws(() => coordinator.commit(value), /NATIVE_PREACTION_CAPTURE_PROJECTION_MISMATCH/);
	coordinator.destroy();
});
