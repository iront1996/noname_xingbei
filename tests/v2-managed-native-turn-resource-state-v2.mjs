import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { MANAGED_NATIVE_TURN_RESOURCE_STATE_V2_SCHEMA: SCHEMA, validateNativeTurnResourceProjectionV2 } =
	require("../game/server-managed-native-turn-resource-state-v2.js");
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
function snapshot() {
	return { schema: SCHEMA, roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, engineBuildId: "b".repeat(64),
		rootInstanceId: `native_root_${"c".repeat(32)}`, seatIds: [...seatIds],
		fence: { kind: "managed_native_quiescent_fence_v1", rootMatches: true, eventStackConsistent: true,
			allChildrenCompleted: true, pendingChildCount: 0, captureLocked: true, nativeCompletionOrdinal: 9 },
		turn: { phase: "xingDong", actorSeatId: "seat_a", phaseLoopSeatId: "seat_a", currentPhaseSeatId: "seat_a",
			gamePhaseNumber: 2, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
		resources: { hongShiQi: 5, lanShiQi: 4, hongXingBei: 1, lanXingBei: 0, hongZhanJi: [], lanZhanJi: [] },
		seats: seatIds.map((seatId, position) => ({ seatId, position, character: `character_${position}`, side: position < 2,
			alive: true, hp: 4, maxHp: 4, zhiLiao: 0, hujiaSupported: false,
			nengLiang: { baoShi: position === 0 ? 1 : 0, shuiJing: 0, effectiveLimit: 3 } })) };
}

test("versioned turn/resource projection binds native energy marks to ordered seats", () => {
	const value = snapshot();
	const expected = { roomId: value.roomId, hostSessionId: value.hostSessionId, engineBuildId: value.engineBuildId,
		rootInstanceId: value.rootInstanceId, seatIds };
	const first = validateNativeTurnResourceProjectionV2(value, expected);
	const repeat = validateNativeTurnResourceProjectionV2(snapshot(), expected);
	assert.equal(first.encoded, repeat.encoded);
	assert.equal(first.canonical.schemaVersion, 2);
	assert.deepEqual(first.canonical.seats[0].nengLiang, { baoShi: 1, shuiJing: 0, effectiveLimit: 3 });
	assert.equal(first.authoritySeedAuthorized, false);
	assert.equal(first.checkpointAvailable, false);
});

test("turn/resource projection rejects impossible energy totals, types and unbound marks", () => {
	for (const alter of [
		v => { v.seats[0].nengLiang.baoShi = -1; },
		v => { v.seats[0].nengLiang.shuiJing = "1"; },
		v => { v.seats[0].nengLiang.effectiveLimit = 0; },
		v => { v.seats[0].nengLiang.unknown = 1; },
		v => { v.seats[0].marks = { _tiLian_baoShi: 1 }; },
	]) {
		const value = snapshot();
		alter(value);
		assert.throws(() => validateNativeTurnResourceProjectionV2(value), /NATIVE_TURN_STATE_V2_/);
	}
});

test("turn/resource projection fails closed at incomplete native fences and unsupported rule state", () => {
	for (const alter of [
		v => { v.fence.pendingChildCount = 1; },
		v => { v.fence.allChildrenCompleted = false; },
		v => { v.fence.captureLocked = false; },
		v => { v.turn.actorSeatId = "seat_z"; },
		v => { v.turn.phaseLoopSeatId = "seat_b"; },
		v => { v.turn.currentPhaseSeatId = "seat_b"; },
		v => { v.turn.extraActionQueueEmpty = false; },
		v => { v.turn.extraXingDong = [{ xingDong: "gongJi" }]; },
		v => { v.seats[0].hujiaSupported = true; },
		v => { v.seats[0].hujia = 0; },
		v => { v.resources.hongZhanJi = ["known", "unknown-value"]; },
	]) {
		const value = snapshot();
		alter(value);
		assert.throws(() => validateNativeTurnResourceProjectionV2(value), /NATIVE_TURN_STATE_V2_/);
	}
});

test("between-turn projection binds completed actor quotas separately from the rotated phase-loop actor", () => {
	const value = snapshot();
	value.turn = { phase: "between_turns", actorSeatId: "seat_a", phaseLoopSeatId: "seat_b", currentPhaseSeatId: null,
		gamePhaseNumber: 2, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true };
	const projection = validateNativeTurnResourceProjectionV2(value);
	assert.equal(projection.canonical.turn.actorSeatId, "seat_a", "quota state belongs to the completed native phase actor");
	assert.equal(projection.canonical.turn.phaseLoopSeatId, "seat_b", "the native loop independently names its rotated next actor");
	const invalid = structuredClone(value);
	invalid.turn.phase = "xingDong";
	assert.throws(() => validateNativeTurnResourceProjectionV2(invalid), /NATIVE_TURN_STATE_V2_TURN_UNSUPPORTED/);
});
