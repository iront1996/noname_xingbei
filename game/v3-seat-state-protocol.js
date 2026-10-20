"use strict";

// V3 integration preparation only. This module defines a transport envelope;
// it does not extract native state, authenticate sockets, or publish messages.
const SCHEMA = "xingbei_v3_seat_state_v2";
const CAPPED_SCHEMA = "xingbei_v3_capped_readonly_state_v1";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{16,96}$/;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

function reject(code) { return Object.freeze({ ok: false, code }); }
function plain(value) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype); }
function exact(value, keys) {
	return plain(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function safeOpaqueList(value, max = 64) {
	return Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every(item => OPAQUE.test(item));
}
function validPublicState(value, seatIds) {
	if (!exact(value, ["activeSeatId", "phase", "players", "resources", "stateVersion"]) || !seatIds.includes(value.activeSeatId) ||
		!["phaseLoop", "phase", "xingDong", "between_turns"].includes(value.phase) ||
		!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0 || !Array.isArray(value.players) ||
		value.players.length !== seatIds.length || !exact(value.resources, ["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei", "hongBaoShiCount", "hongShuiJingCount", "lanBaoShiCount", "lanShuiJingCount"]) ||
		![value.resources.hongShiQi, value.resources.lanShiQi].every(n => Number.isSafeInteger(n) && n >= -1000000 && n <= 1000000) ||
		![value.resources.hongXingBei, value.resources.lanXingBei, value.resources.hongBaoShiCount, value.resources.hongShuiJingCount,
			value.resources.lanBaoShiCount, value.resources.lanShuiJingCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)) return false;
	const seen = new Set();
	for (const player of value.players) {
		if (!exact(player, ["characterId", "handCount", "seatId", "side"]) || !seatIds.includes(player.seatId) || seen.has(player.seatId) ||
			(player.characterId !== null && (typeof player.characterId !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(player.characterId))) ||
			(player.side !== null && typeof player.side !== "boolean") || !Number.isSafeInteger(player.handCount) || player.handCount < 0 || player.handCount > 200) return false;
		seen.add(player.seatId);
	}
	return seatIds.every(seatId => seen.has(seatId));
}
function validPrivateState(value, recipientSeatId) {
	return exact(value, ["handCardViewIds", "seatId"]) && value.seatId === recipientSeatId && safeOpaqueList(value.handCardViewIds, 200);
}
function validPendingChoice(value, recipientSeatId, sequence) {
	if (value === null) return true;
	return exact(value, ["choiceId", "deadlineAt", "eventSequence", "optionIds", "seatId", "status"]) &&
		value.seatId === recipientSeatId && OPAQUE.test(value.choiceId || "") && Number.isSafeInteger(value.eventSequence) &&
		value.eventSequence >= 1 && value.eventSequence <= sequence && Number.isSafeInteger(value.deadlineAt) &&
		value.deadlineAt > 0 && ["pending", "delivery_pending", "applying"].includes(value.status) &&
		safeOpaqueList(value.optionIds, 64) && value.optionIds.length > 0;
}

function createSeatStateMessage(input) {
	if (!plain(input) || !Array.isArray(input.seatIds) || input.seatIds.length < 2 || input.seatIds.length > 8 ||
		input.seatIds.some(seatId => !ID.test(seatId)) || new Set(input.seatIds).size !== input.seatIds.length ||
		!ID.test(input.roomId || "") || !ID.test(input.recipientSeatId || "") || !input.seatIds.includes(input.recipientSeatId) ||
		!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1 ||
		!Number.isSafeInteger(input.stateSequence) || input.stateSequence < 1 || input.stateSequence > MAX_SEQUENCE ||
		!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 1 || input.stateVersion > MAX_SEQUENCE ||
		!Number.isSafeInteger(input.replayFromSequence) || input.replayFromSequence < 0 || input.replayFromSequence >= input.stateSequence ||
		!validPublicState(input.publicState, input.seatIds) || input.publicState.stateVersion !== input.stateVersion ||
		!validPrivateState(input.privateState, input.recipientSeatId) ||
		!validPendingChoice(input.pendingChoice, input.recipientSeatId, input.stateSequence)) return reject("V3_SEAT_STATE_ENVELOPE_REJECTED");
	return Object.freeze({ ok: true, message: Object.freeze({ schema: SCHEMA, roomId: input.roomId,
		recipientSeatId: input.recipientSeatId, connectionGeneration: input.connectionGeneration,
		stateSequence: input.stateSequence, stateVersion: input.stateVersion, replayFromSequence: input.replayFromSequence,
		publicState: Object.freeze({ ...input.publicState, resources: Object.freeze({ ...input.publicState.resources }),
			players: Object.freeze(input.publicState.players.map(player => Object.freeze({ ...player }))) }),
		privateState: Object.freeze({ seatId: input.recipientSeatId, handCardViewIds: Object.freeze([...input.privateState.handCardViewIds]) }),
		pendingChoice: input.pendingChoice === null ? null : Object.freeze({ ...input.pendingChoice,
			optionIds: Object.freeze([...input.pendingChoice.optionIds]) }) }) });
}

function validateSeatStateMessage(message, expected = {}) {
	if (!exact(message, ["schema", "roomId", "recipientSeatId", "connectionGeneration", "stateSequence", "stateVersion",
		"replayFromSequence", "publicState", "privateState", "pendingChoice"]) || message.schema !== SCHEMA ||
		(expected.roomId !== undefined && message.roomId !== expected.roomId) ||
		(expected.seatId !== undefined && message.recipientSeatId !== expected.seatId) ||
		(expected.connectionGeneration !== undefined && message.connectionGeneration !== expected.connectionGeneration) ||
		!ID.test(message.roomId || "") || !ID.test(message.recipientSeatId || "") ||
		!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration < 1 ||
		!Number.isSafeInteger(message.stateSequence) || message.stateSequence < 1 ||
		!Number.isSafeInteger(message.stateVersion) || message.stateVersion < 1 ||
		!Number.isSafeInteger(message.replayFromSequence) || message.replayFromSequence < 0 || message.replayFromSequence >= message.stateSequence ||
		!plain(message.publicState) || !Array.isArray(expected.seatIds) || !validPublicState(message.publicState, expected.seatIds) ||
		message.publicState.stateVersion !== message.stateVersion || !validPrivateState(message.privateState, message.recipientSeatId) ||
		!validPendingChoice(message.pendingChoice, message.recipientSeatId, message.stateSequence)) return reject("V3_SEAT_STATE_MESSAGE_REJECTED");
	return Object.freeze({ ok: true, message });
}

function acceptsReconnectCursor({ currentConnectionGeneration, incomingConnectionGeneration, lastSeenSequence, replayFromSequence }) {
	return Number.isSafeInteger(currentConnectionGeneration) && currentConnectionGeneration >= 1 &&
		Number.isSafeInteger(incomingConnectionGeneration) && incomingConnectionGeneration === currentConnectionGeneration &&
		Number.isSafeInteger(lastSeenSequence) && lastSeenSequence >= 0 &&
		Number.isSafeInteger(replayFromSequence) && replayFromSequence === lastSeenSequence;
}

function createCappedReadOnlySeatState(input) {
	if (!plain(input) || !ID.test(input.roomId || "") || !ID.test(input.recipientSeatId || "") ||
		!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1 ||
		!Number.isSafeInteger(input.stateSequence) || input.stateSequence < 1 ||
		!Number.isSafeInteger(input.replayFromSequence) || input.replayFromSequence < 0 || input.replayFromSequence >= input.stateSequence ||
		input.authorityRevision !== 8 || input.lastAcceptedEventSequence !== 8 || input.nextAuthorityEventSequence !== 9 ||
		!Number.isSafeInteger(input.captureOrdinal) || input.captureOrdinal < 1 ||
		!Number.isSafeInteger(input.nativeCompletionOrdinal) || input.nativeCompletionOrdinal < 1 ||
		!/^native_event_[a-f0-9]{32}$/.test(input.nativeEventId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(input.phaseOverEventInstanceId || "") ||
		input.experimentalCeilingReached !== true || input.gameTerminal !== false || input.gameplayEnabled !== false ||
		input.projectionStatus !== "verified_capture_payload_unavailable") return reject("V3_CAPPED_STATE_ENVELOPE_REJECTED");
	return Object.freeze({ ok: true, message: Object.freeze({ schema: CAPPED_SCHEMA, roomId: input.roomId,
		recipientSeatId: input.recipientSeatId, connectionGeneration: input.connectionGeneration,
		stateSequence: input.stateSequence, replayFromSequence: input.replayFromSequence,
		authorityRevision: 8, lastAcceptedEventSequence: 8, nextAuthorityEventSequence: 9,
		captureOrdinal: input.captureOrdinal, nativeCompletionOrdinal: input.nativeCompletionOrdinal,
		nativeEventId: input.nativeEventId, phaseOverEventInstanceId: input.phaseOverEventInstanceId,
		experimentalCeilingReached: true, gameTerminal: false, gameplayEnabled: false,
		projectionStatus: "verified_capture_payload_unavailable" }) });
}

function validateCappedReadOnlySeatState(message, expected = {}) {
	const keys = ["schema", "roomId", "recipientSeatId", "connectionGeneration", "stateSequence", "replayFromSequence",
		"authorityRevision", "lastAcceptedEventSequence", "nextAuthorityEventSequence", "captureOrdinal", "nativeCompletionOrdinal",
		"nativeEventId", "phaseOverEventInstanceId", "experimentalCeilingReached", "gameTerminal", "gameplayEnabled", "projectionStatus"];
	if (!exact(message, keys) || message.schema !== CAPPED_SCHEMA ||
		(expected.roomId !== undefined && message.roomId !== expected.roomId) ||
		(expected.seatId !== undefined && message.recipientSeatId !== expected.seatId) ||
		(expected.connectionGeneration !== undefined && message.connectionGeneration !== expected.connectionGeneration) ||
		!ID.test(message.roomId || "") || !ID.test(message.recipientSeatId || "") ||
		!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration < 1 ||
		!Number.isSafeInteger(message.stateSequence) || message.stateSequence < 1 ||
		!Number.isSafeInteger(message.replayFromSequence) || message.replayFromSequence < 0 || message.replayFromSequence >= message.stateSequence ||
		message.authorityRevision !== 8 || message.lastAcceptedEventSequence !== 8 || message.nextAuthorityEventSequence !== 9 ||
		!Number.isSafeInteger(message.captureOrdinal) || message.captureOrdinal < 1 ||
		!Number.isSafeInteger(message.nativeCompletionOrdinal) || message.nativeCompletionOrdinal < 1 ||
		!/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(message.phaseOverEventInstanceId || "") ||
		message.experimentalCeilingReached !== true || message.gameTerminal !== false || message.gameplayEnabled !== false ||
		message.projectionStatus !== "verified_capture_payload_unavailable") return reject("V3_CAPPED_STATE_MESSAGE_REJECTED");
	return Object.freeze({ ok: true, message });
}

module.exports = { SCHEMA, CAPPED_SCHEMA, createSeatStateMessage, validateSeatStateMessage,
	createCappedReadOnlySeatState, validateCappedReadOnlySeatState, acceptsReconnectCursor };
