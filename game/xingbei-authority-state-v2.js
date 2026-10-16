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
const MAX_PROOF_BYTES = 160000;

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
	for (const key of ["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei"]) assertInteger(state.resources[key], -1000000, 1000000);
	for (const key of ["hongZhanJiCount", "lanZhanJiCount"]) assertInteger(state.resources[key], 0, MAX_COLLECTION_COUNT);
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

function validateEvent4SeedBridge({ state, event4Proof, expected, expectedLegacyBeforeDigest, expectedLegacyAfterDigest } = {}) {
	try {
		const expectedKeys = ["roomId", "rootInstanceId", "firstActSeatId", "seatIds"];
		const event = event4Proof?.event;
		const summary = event4Proof?.afterSummary;
		const beforeSummary = event4Proof?.beforeSummary;
		if (!expected || Object.keys(expected).sort().join(",") !== expectedKeys.sort().join(",") ||
			!Array.isArray(expected.seatIds) || !Array.isArray(summary?.seats) ||
			Object.keys(summary).sort().join(",") !== "action,firstActSeatId,responses,revision,seats" ||
			!event || event.kind !== "xingbei_native_card_action_v1" || event.name !== "gongJiOrFaShu" ||
			event.nativeEventName !== "gongJiOrFaShu" || event.nativeEventCompleted !== true ||
			event.useResultCount !== 1 || event.useCardChildName !== "useCard" ||
			event.nativeUseCardChildCompleted !== true || event.nativeChildWaitCompleted !== true ||
			event.nativeEventInstanceMatches !== true || event.gameMeNull !== true || event.connectedTransports !== 0 ||
			event.rootInstanceId !== expected.rootInstanceId ||
			event4Proof.kind !== "native_authority_event_v1" || event4Proof.checkpoint !== null ||
			event4Proof.eventSequence !== 4 || event4Proof.stateRevisionBefore !== 3 || event4Proof.stateRevisionAfter !== 4 ||
			event4Proof.beforeDigest !== expectedLegacyBeforeDigest || event4Proof.afterDigest !== expectedLegacyAfterDigest ||
			!DIGEST.test(expectedLegacyBeforeDigest || "") || !DIGEST.test(expectedLegacyAfterDigest || "") ||
			!beforeSummary || Object.keys(beforeSummary).sort().join(",") !== "firstActSeatId,revision,seats" ||
			beforeSummary.revision !== 3 || beforeSummary.firstActSeatId !== expected.firstActSeatId ||
			summary.revision !== 4 || summary.firstActSeatId !== expected.firstActSeatId ||
			!Array.isArray(summary.responses) || !summary.action || Object.keys(summary.action).sort().join(",") !==
			"cardName,nativeEventId,nativeEventName,optionId,seatId,targetSeatId,usedCardPosition" ||
			summary.action.nativeEventName !== "gongJiOrFaShu") {
			return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_SEED_BRIDGE_REJECTED" });
		}
		if (!Array.isArray(event.responseActions) || canonicalize(event.responseActions) !== canonicalize(summary.responses) ||
			!IDENTIFIER.test(event.nativeEventId || "") || event.nativeEventId !== summary.action.nativeEventId ||
			event.seatId !== summary.action.seatId || event.cardName !== summary.action.cardName ||
			event.targetSeatId !== summary.action.targetSeatId || event.optionId !== summary.action.optionId ||
			event.usedCardPosition !== summary.action.usedCardPosition) {
			return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_SEED_BRIDGE_REJECTED" });
		}
		const oldDigest = crypto.createHash("sha256").update(canonicalize(summary)).digest("hex");
		const oldBeforeDigest = crypto.createHash("sha256").update(canonicalize(beforeSummary)).digest("hex");
		if (oldDigest !== expectedLegacyAfterDigest || oldBeforeDigest !== expectedLegacyBeforeDigest ||
			summary.seats.length !== expected.seatIds.length || beforeSummary.seats?.length !== expected.seatIds.length) {
			return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_SEED_BRIDGE_REJECTED" });
		}
		validateState(state, { roomId: expected.roomId, rootInstanceId: expected.rootInstanceId,
			firstActSeatId: expected.firstActSeatId, seatIds: expected.seatIds });
		if (state.authorityEventSequence !== 4 || state.authorityStateRevision !== 4 || state.turn.phase !== "xingDong" ||
			state.turn.currentSeatId !== event.seatId || summary.seats.some((seat, index) => {
				const projected = state.seats[index];
				return Object.keys(seat).sort().join(",") !== "character,handCommitment,handCount,position,seatId,side" ||
					seat.seatId !== expected.seatIds[index] || seat.position !== index ||
					seat.seatId !== projected.seatId || seat.position !== projected.position ||
					seat.character !== projected.character || seat.side !== projected.side ||
					seat.handCount !== projected.handCount || seat.handCommitment !== projected.handCommitment;
			})) return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_SEED_BRIDGE_REJECTED" });
		return Object.freeze({ ok: true, legacyDigest: oldDigest, authorityStateDigest: digestState(state, expected),
			legacyEventSequence: 4, authorityEventSequence: state.authorityEventSequence,
			legacyRevision: 4, authorityStateRevision: state.authorityStateRevision, checkpointAvailable: false });
	} catch (_) {
		return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_SEED_BRIDGE_REJECTED" });
	}
}

function validateTransition({ before, after, event, expected, validateNativeEvent }) {
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
			beforeEncoded === afterEncoded || typeof validateNativeEvent !== "function" ||
			validateNativeEvent({ before, after, event }) !== true) return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_TRANSITION_INVALID" });
		return Object.freeze({ ok: true, beforeDigest: crypto.createHash("sha256").update(beforeEncoded).digest("hex"),
			afterDigest: crypto.createHash("sha256").update(afterEncoded).digest("hex") });
	} catch (error) {
		return Object.freeze({ ok: false, code: error?.message === "XINGBEI_AUTHORITY_STATE_V2_BINDING_INVALID" ? error.message : "XINGBEI_AUTHORITY_STATE_V2_INVALID" });
	}
}

function createAuthorityStateChainV2({ initialState, expected, validateInitialState, validateNativeEvent, maxAcceptedDigests = 64 } = {}) {
	if (typeof validateInitialState !== "function" || typeof validateNativeEvent !== "function" ||
		!Number.isSafeInteger(maxAcceptedDigests) || maxAcceptedDigests < 1 || maxAcceptedDigests > 256) {
		throw new TypeError("XINGBEI_AUTHORITY_CHAIN_V2_CONFIG_INVALID");
	}
	let current;
	try {
		current = JSON.parse(validateState(initialState, expected));
	} catch (_) {
		throw new TypeError("XINGBEI_AUTHORITY_CHAIN_V2_INITIAL_STATE_REJECTED");
	}
	let initialAccepted = false;
	try { initialAccepted = validateInitialState({ state: JSON.parse(canonicalize(current)), expected }) === true; } catch (_) {}
	if (!initialAccepted) throw new TypeError("XINGBEI_AUTHORITY_CHAIN_V2_INITIAL_STATE_REJECTED");
	let currentDigest = digestState(current, expected);
	const accepted = new Map();
	const digestChain = [];
	function inspect() {
		return Object.freeze({ schema: SCHEMA, schemaVersion: VERSION, roomId: current.roomId,
			rootInstanceId: current.rootInstanceId, authorityEventSequence: current.authorityEventSequence,
			authorityStateRevision: current.authorityStateRevision, authorityStateDigest: currentDigest,
			checkpointAvailable: false, digestChain: Object.freeze(digestChain.slice()) });
	}
	function commit(proof) {
		let proofDigest;
		try {
			const encodedProof = canonicalize(proof);
			if (Buffer.byteLength(encodedProof, "utf8") > MAX_PROOF_BYTES) return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_PROOF_V2_INVALID" });
			proofDigest = crypto.createHash("sha256").update(encodedProof).digest("hex");
		}
		catch (_) { return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_PROOF_V2_INVALID" }); }
		const sequence = proof?.event?.eventSequence;
		if (Number.isSafeInteger(sequence) && sequence <= current.authorityEventSequence) {
			return accepted.get(sequence) === proofDigest ? Object.freeze({ ok: true, idempotent: true, state: inspect() }) :
				Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_REPLAY_V2_REJECTED" });
		}
		let beforeMatches = false;
		try { beforeMatches = canonicalize(proof?.beforeState) === canonicalize(current); } catch (_) {}
		if (!proof || !beforeMatches || proof.beforeDigest !== currentDigest || proof.event?.eventSequence !== current.authorityEventSequence + 1 ||
			proof.event?.stateRevisionBefore !== current.authorityStateRevision ||
			proof.event?.stateRevisionAfter !== current.authorityStateRevision + 1) {
			return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_PREDECESSOR_V2_REJECTED" });
		}
		const validation = validateTransition({ before: current, after: proof.afterState, event: proof.event, expected, validateNativeEvent });
		if (!validation.ok || proof.beforeDigest !== validation.beforeDigest || proof.afterDigest !== validation.afterDigest) {
			return Object.freeze({ ok: false, code: "XINGBEI_AUTHORITY_TRANSITION_V2_REJECTED" });
		}
		current = JSON.parse(canonicalize(proof.afterState));
		currentDigest = validation.afterDigest;
		accepted.set(sequence, proofDigest);
		if (accepted.size > maxAcceptedDigests) accepted.delete(accepted.keys().next().value);
		digestChain.push(Object.freeze({ eventSequence: sequence, beforeDigest: validation.beforeDigest, afterDigest: validation.afterDigest }));
		if (digestChain.length > 8) digestChain.shift();
		return Object.freeze({ ok: true, idempotent: false, state: inspect() });
	}
	return Object.freeze({ inspect, commit });
}

module.exports = Object.freeze({ SCHEMA, VERSION, canonicalize, validateState, digestState, validateEvent4SeedBridge,
	validateTransition, createAuthorityStateChainV2 });
