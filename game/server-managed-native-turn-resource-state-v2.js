"use strict";

// Versioned projection contract only. It validates a supplied native snapshot;
// it does not establish a Chromium fence or authorize a schema-v2 seed.
const SCHEMA = "xingbei_native_private_turn_resource_state_v2";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const BUILD = /^[a-f0-9]{64}$/;
const MAX_SEATS = 8;
const MAX_RESOURCE = 1000000;
const MAX_CANONICAL_BYTES = 16384;
const PHASES = new Set(["phaseLoop", "phase", "xingDong", "between_turns"]);
// These are the only Xingbei achievement resource values covered by the
// current source audit. A syntactically valid arbitrary identifier is not a
// safe substitute for a reviewed native resource kind.
const ZHANJI_KINDS = new Set(["baoShi", "shuiJing"]);

function fail(code) { throw new TypeError(code); }
function plain(value) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype); }
function exact(value, keys) { return plain(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function integer(value, min = 0, max = MAX_RESOURCE) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function canonicalize(value, depth = 0) {
	if (depth > 8) fail("NATIVE_TURN_STATE_V2_TOO_DEEP");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) {
		if (value.length > 128) fail("NATIVE_TURN_STATE_V2_TOO_LARGE");
		return `[${value.map(item => canonicalize(item, depth + 1)).join(",")}]`;
	}
	if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
	fail("NATIVE_TURN_STATE_V2_UNSUPPORTED_VALUE");
}

function validateNativeTurnResourceProjectionV2(snapshot, expected = {}) {
	if (!exact(snapshot, ["schema", "roomId", "hostSessionId", "engineBuildId", "rootInstanceId", "seatIds", "fence", "turn", "resources", "seats"]) ||
		snapshot.schema !== SCHEMA || !IDENTIFIER.test(snapshot.roomId || "") || !/^hs_[a-f0-9]{32}$/.test(snapshot.hostSessionId || "") ||
		!BUILD.test(snapshot.engineBuildId || "") || !ROOT.test(snapshot.rootInstanceId || "") || !Array.isArray(snapshot.seatIds) ||
		snapshot.seatIds.length < 2 || snapshot.seatIds.length > MAX_SEATS || new Set(snapshot.seatIds).size !== snapshot.seatIds.length ||
		snapshot.seatIds.some(id => !IDENTIFIER.test(id)) ||
		(expected.roomId !== undefined && snapshot.roomId !== expected.roomId) ||
		(expected.hostSessionId !== undefined && snapshot.hostSessionId !== expected.hostSessionId) ||
		(expected.engineBuildId !== undefined && snapshot.engineBuildId !== expected.engineBuildId) ||
		(expected.rootInstanceId !== undefined && snapshot.rootInstanceId !== expected.rootInstanceId) ||
		(expected.seatIds !== undefined && canonicalize(snapshot.seatIds) !== canonicalize(expected.seatIds))) fail("NATIVE_TURN_STATE_V2_BINDING_INVALID");

	const fence = snapshot.fence;
	if (!exact(fence, ["kind", "rootMatches", "eventStackConsistent", "allChildrenCompleted", "pendingChildCount", "captureLocked", "nativeCompletionOrdinal"]) ||
		fence.kind !== "managed_native_quiescent_fence_v1" || fence.rootMatches !== true || fence.eventStackConsistent !== true ||
		fence.allChildrenCompleted !== true || fence.pendingChildCount !== 0 || fence.captureLocked !== true ||
		!Number.isSafeInteger(fence.nativeCompletionOrdinal) || fence.nativeCompletionOrdinal < 1) fail("NATIVE_TURN_STATE_V2_FENCE_INVALID");

	const turn = snapshot.turn;
	if (!exact(turn, ["phase", "actorSeatId", "phaseLoopSeatId", "currentPhaseSeatId", "gamePhaseNumber", "playerPhaseNumber", "quotas", "extraActionQueueEmpty"]) ||
		!PHASES.has(turn.phase) || !snapshot.seatIds.includes(turn.actorSeatId) || turn.phaseLoopSeatId !== turn.actorSeatId ||
		(turn.phase === "phase" || turn.phase === "xingDong" ? turn.currentPhaseSeatId !== turn.actorSeatId : turn.currentPhaseSeatId !== null) ||
		!integer(turn.gamePhaseNumber) || !integer(turn.playerPhaseNumber) || !exact(turn.quotas, ["gongJiOrFaShu", "faShu", "gongJi"]) ||
		Object.values(turn.quotas).some(value => !integer(value, 0, 512)) || turn.extraActionQueueEmpty !== true) fail("NATIVE_TURN_STATE_V2_TURN_UNSUPPORTED");

	const resources = snapshot.resources;
	if (!exact(resources, ["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei", "hongZhanJi", "lanZhanJi"]) ||
		![resources.hongShiQi, resources.lanShiQi, resources.hongXingBei, resources.lanXingBei].every(value => integer(value, -MAX_RESOURCE, MAX_RESOURCE)) ||
		![resources.hongZhanJi, resources.lanZhanJi].every(list => Array.isArray(list) && list.length <= 128 && list.every(value => ZHANJI_KINDS.has(value)))) {
		fail("NATIVE_TURN_STATE_V2_RESOURCE_INVALID");
	}
	if (!Array.isArray(snapshot.seats) || snapshot.seats.length !== snapshot.seatIds.length) fail("NATIVE_TURN_STATE_V2_SEATS_INVALID");
	const seen = new Set();
	const seats = snapshot.seats.map((seat, index) => {
		if (!exact(seat, ["seatId", "position", "character", "side", "alive", "hp", "maxHp", "zhiLiao", "hujiaSupported", "nengLiang"]) ||
			seat.seatId !== snapshot.seatIds[index] || seen.has(seat.seatId) || seat.position !== index ||
			typeof seat.character !== "string" || seat.character.length < 1 || seat.character.length > 128 || typeof seat.side !== "boolean" ||
			typeof seat.alive !== "boolean" || !integer(seat.hp, 0, 1000) || !integer(seat.maxHp, 0, 1000) || seat.hp > Math.max(1000, seat.maxHp) ||
			!integer(seat.zhiLiao) || seat.hujiaSupported !== false ||
			!exact(seat.nengLiang, ["baoShi", "shuiJing", "effectiveLimit"]) ||
			!integer(seat.nengLiang.baoShi, 0, 512) || !integer(seat.nengLiang.shuiJing, 0, 512) ||
			!integer(seat.nengLiang.effectiveLimit, 0, 512) || seat.nengLiang.baoShi + seat.nengLiang.shuiJing > seat.nengLiang.effectiveLimit) {
			fail("NATIVE_TURN_STATE_V2_SEAT_UNSUPPORTED");
		}
		seen.add(seat.seatId);
		return Object.freeze({ ...seat, nengLiang: Object.freeze({ ...seat.nengLiang }) });
	});
	const canonical = { schema: SCHEMA, schemaVersion: 2, roomId: snapshot.roomId, hostSessionId: snapshot.hostSessionId,
		engineBuildId: snapshot.engineBuildId, rootInstanceId: snapshot.rootInstanceId, seatIds: [...snapshot.seatIds],
		nativeCompletionOrdinal: fence.nativeCompletionOrdinal, turn: { ...turn, quotas: { ...turn.quotas } },
		resources: { hongShiQi: resources.hongShiQi, lanShiQi: resources.lanShiQi, hongXingBei: resources.hongXingBei,
			lanXingBei: resources.lanXingBei, hongZhanJi: [...resources.hongZhanJi], lanZhanJi: [...resources.lanZhanJi] }, seats };
	const encoded = canonicalize(canonical);
	if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES) fail("NATIVE_TURN_STATE_V2_TOO_LARGE");
	return Object.freeze({ canonical: Object.freeze(canonical), encoded, projectionOnly: true,
		authoritySeedAuthorized: false, checkpointAvailable: false });
}

module.exports = { MANAGED_NATIVE_TURN_RESOURCE_STATE_V2_SCHEMA: SCHEMA, validateNativeTurnResourceProjectionV2 };
