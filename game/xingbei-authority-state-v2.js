"use strict";

const crypto = require("node:crypto");

const SCHEMA = "xingbei_authority_state_v2";
const VERSION = 1;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SIDES = new Set([true, false]);
const PHASES = new Set(["phaseLoop", "phase", "xingDong", "between_turns"]);
const MAX_SEATS = 8;
const MAX_COLLECTION_COUNT = 512;
const MAX_CANONICAL_BYTES = 65536;

function ownObject(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

function assertInteger(value, min, max) {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
}

function canonicalize(value, depth = 0) {
	if (depth > 12) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
	if (Array.isArray(value)) {
		if (value.length > MAX_COLLECTION_COUNT) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
		return `[${value.map(item => canonicalize(item, depth + 1)).join(",")}]`;
	}
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		const keys = Object.keys(value).sort();
		if (keys.length > 64) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
	}
	throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
}

function validateState(state, expected = {}) {
	if (!ownObject(state, ["schema", "schemaVersion", "roomId", "rootInstanceId", "authorityEventSequence", "authorityStateRevision", "firstActSeatId", "turn", "resources", "cardZones", "seats"]) ||
		state.schema !== SCHEMA || state.schemaVersion !== VERSION || !IDENTIFIER.test(state.roomId || "") ||
		!IDENTIFIER.test(state.rootInstanceId || "") || !Number.isSafeInteger(state.authorityEventSequence) || state.authorityEventSequence < 0 ||
		!Number.isSafeInteger(state.authorityStateRevision) || state.authorityStateRevision < 0 || !IDENTIFIER.test(state.firstActSeatId || "") ||
		!Array.isArray(state.seats) || state.seats.length < 2 || state.seats.length > MAX_SEATS) {
		throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	}
	if (expected.roomId !== undefined && state.roomId !== expected.roomId ||
		expected.rootInstanceId !== undefined && state.rootInstanceId !== expected.rootInstanceId ||
		expected.firstActSeatId !== undefined && state.firstActSeatId !== expected.firstActSeatId ||
		expected.seatIds !== undefined && (state.seats.length !== expected.seatIds.length ||
			state.seats.some((seat, index) => seat.seatId !== expected.seatIds[index]))) {
		throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_BINDING_INVALID");
	}
	if (!ownObject(state.turn, ["currentSeatId", "roundNumber", "phaseNumber", "phase", "actionIndex", "quotas"]) ||
		!(state.turn.currentSeatId === null || state.seats.some(seat => seat.seatId === state.turn.currentSeatId)) ||
		!PHASES.has(state.turn.phase) || !ownObject(state.turn.quotas, ["gongJiOrFaShu", "faShu", "gongJi", "extraXingDongCount"])) {
		throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	}
	assertInteger(state.turn.roundNumber, 0, 1000000);
	assertInteger(state.turn.phaseNumber, 0, 1000000);
	assertInteger(state.turn.actionIndex, 0, 1000000);
	for (const value of Object.values(state.turn.quotas)) assertInteger(value, 0, MAX_COLLECTION_COUNT);
	if (!ownObject(state.resources, ["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei", "hongZhanJiCount", "hongZhanJiCommitment", "lanZhanJiCount", "lanZhanJiCommitment"])) {
		throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	}
	for (const key of ["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei", "hongZhanJiCount", "lanZhanJiCount"]) assertInteger(state.resources[key], 0, MAX_COLLECTION_COUNT);
	for (const key of ["hongZhanJiCommitment", "lanZhanJiCommitment"]) if (!DIGEST.test(state.resources[key] || "")) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	if (!ownObject(state.cardZones, ["drawCount", "drawCommitment", "discardCount", "discardCommitment", "orderingCount", "orderingCommitment", "specialCount", "specialCommitment"])) {
		throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	}
	for (const [countKey, digestKey] of [["drawCount", "drawCommitment"], ["discardCount", "discardCommitment"], ["orderingCount", "orderingCommitment"], ["specialCount", "specialCommitment"]]) {
		assertInteger(state.cardZones[countKey], 0, MAX_COLLECTION_COUNT);
		if (!DIGEST.test(state.cardZones[digestKey] || "")) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
	}
	const ids = new Set();
	state.seats.forEach((seat, position) => {
		if (!ownObject(seat, ["seatId", "position", "character", "side", "alive", "hp", "maxHp", "handCount", "handCommitment", "equipmentCount", "judgmentCount", "nengLiangCommitment", "skillStateCommitment", "marksCommitment"]) ||
			!IDENTIFIER.test(seat.seatId || "") || ids.has(seat.seatId) || seat.position !== position ||
			typeof seat.character !== "string" || seat.character.length < 1 || seat.character.length > 128 ||
			!SIDES.has(seat.side) || typeof seat.alive !== "boolean") {
			throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
		}
		ids.add(seat.seatId);
		assertInteger(seat.maxHp, 0, 1000);
		assertInteger(seat.hp, 0, Math.max(1000, seat.maxHp));
		for (const key of ["handCount", "equipmentCount", "judgmentCount"]) assertInteger(seat[key], 0, MAX_COLLECTION_COUNT);
		for (const key of ["handCommitment", "nengLiangCommitment", "skillStateCommitment", "marksCommitment"]) {
			if (!DIGEST.test(seat[key] || "")) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_INVALID");
		}
	});
	if (!ids.has(state.firstActSeatId)) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_BINDING_INVALID");
	const encoded = canonicalize(state);
	if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES) throw new TypeError("XINGBEI_AUTHORITY_STATE_V2_TOO_LARGE");
	return encoded;
}

function digestState(state, expected) {
	return crypto.createHash("sha256").update(validateState(state, expected)).digest("hex");
}

function validateTransition({ before, after, event, expected }) {
	try {
		const beforeEncoded = validateState(before, expected);
		const afterEncoded = validateState(after, expected);
		if (!ownObject(event, ["kind", "nativeEventId", "nativeEventName", "eventSequence", "stateRevisionBefore", "stateRevisionAfter", "rootInstanceId", "completed", "pendingChildCount"]) ||
			event.kind !== "xingbei_native_transition_v2" || !IDENTIFIER.test(event.nativeEventId || "") ||
			!IDENTIFIER.test(event.nativeEventName || "") || event.rootInstanceId !== before.rootInstanceId ||
			event.rootInstanceId !== after.rootInstanceId || event.completed !== true || event.pendingChildCount !== 0 ||
			event.eventSequence !== before.authorityEventSequence + 1 || event.eventSequence !== after.authorityEventSequence ||
			event.stateRevisionBefore !== before.authorityStateRevision || event.stateRevisionAfter !== before.authorityStateRevision + 1 ||
			event.stateRevisionAfter !== after.authorityStateRevision ||
			before.roomId !== after.roomId || before.firstActSeatId !== after.firstActSeatId ||
			before.seats.length !== after.seats.length || before.seats.some((seat, index) => seat.seatId !== after.seats[index].seatId) ||
			beforeEncoded === afterEncoded) return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_TRANSITION_INVALID" });
		return Object.freeze({ ok: true, beforeDigest: crypto.createHash("sha256").update(beforeEncoded).digest("hex"),
			afterDigest: crypto.createHash("sha256").update(afterEncoded).digest("hex") });
	} catch (error) {
		return Object.freeze({ ok: false, code: error?.message === "XINGBEI_AUTHORITY_STATE_V2_BINDING_INVALID" ? error.message : "XINGBEI_AUTHORITY_STATE_V2_INVALID" });
	}
}

module.exports = Object.freeze({ SCHEMA, VERSION, canonicalize, validateState, digestState, validateTransition });
