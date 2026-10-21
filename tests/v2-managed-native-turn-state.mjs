import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { MANAGED_NATIVE_TURN_RESOURCE_STATE_SCHEMA: SCHEMA, validateNativeTurnResourceProjection } =
	require("../game/server-managed-native-turn-state.js");
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
const base = () => ({ schema: SCHEMA, roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`,
	engineBuildId: "b".repeat(64), rootInstanceId: `native_root_${"c".repeat(32)}`, seatIds: [...seatIds],
	fence: { kind: "managed_native_quiescent_fence_v1", rootMatches: true, eventStackConsistent: true,
		allChildrenCompleted: true, pendingChildCount: 0, captureLocked: true, nativeCompletionOrdinal: 7 },
	turn: { phase: "xingDong", actorSeatId: "seat_a", phaseLoopSeatId: "seat_a", currentPhaseSeatId: "seat_a",
		gamePhaseNumber: 1, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
	resources: { hongShiQi: 5, lanShiQi: 5, hongXingBei: 0, lanXingBei: 0, hongZhanJi: [], lanZhanJi: [] },
	seats: seatIds.map((seatId, position) => ({ seatId, position, character: `character_${position}`, side: position < 2,
		alive: true, hp: 4, maxHp: 4, zhiLiao: 0, hujiaSupported: false })) });

test("limited native turn/resource projection binds a single completed fence and canonical source values", () => {
	const snapshot = base();
	const expected = { roomId: snapshot.roomId, hostSessionId: snapshot.hostSessionId, engineBuildId: snapshot.engineBuildId,
		rootInstanceId: snapshot.rootInstanceId, seatIds };
	const first = validateNativeTurnResourceProjection(snapshot, expected);
	const repeat = validateNativeTurnResourceProjection(base(), expected);
	assert.equal(first.encoded, repeat.encoded);
	assert.equal(first.canonical.turn.actorSeatId, "seat_a");
	assert.equal(first.canonical.nativeCompletionOrdinal, 7);
	assert.equal(first.projectionOnly, true);
	assert.equal(first.authoritySeedAuthorized, false);
	assert.equal(first.checkpointAvailable, false);
});

test("turn/resource projection rejects mismatched fences, actors and unfinished action quotas", () => {
	const cases = [
		value => { value.fence.pendingChildCount = 1; },
		value => { value.fence.captureLocked = false; },
		value => { value.fence.rootMatches = false; },
		value => { value.turn.phaseLoopSeatId = "seat_b"; },
		value => { value.turn.currentPhaseSeatId = "seat_b"; },
		value => { value.turn.actorSeatId = "seat_x"; },
		value => { value.turn.quotas.gongJiOrFaShu = "1"; },
		value => { value.turn.extraActionQueueEmpty = false; },
		value => { value.turn.extraXingDong = []; },
	];
	for (const alter of cases) assert.throws(() => validateNativeTurnResourceProjection((() => { const value = base(); alter(value); return value; })()), /NATIVE_TURN_STATE_/);
});

test("turn/resource projection refuses unsupported or malformed state instead of defaulting it", () => {
	const cases = [
		value => { value.seats[0].hujiaSupported = true; },
		value => { delete value.seats[0].zhiLiao; },
		value => { value.resources.hongZhanJi = ["not a reviewed achievement identifier with spaces"]; },
		value => { value.resources.unknown = 0; },
		value => { value.seats[0].storage = {}; },
		value => { value.seats[1].seatId = "seat_a"; },
		value => { value.fence.nativeCompletionOrdinal = 0; },
	];
	for (const alter of cases) assert.throws(() => validateNativeTurnResourceProjection((() => { const value = base(); alter(value); return value; })()), /NATIVE_TURN_STATE_/);
	const snapshot = base();
	assert.throws(() => validateNativeTurnResourceProjection(snapshot, { roomId: "another_room" }), /NATIVE_TURN_STATE_BINDING_INVALID/);
});
