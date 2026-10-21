"use strict";

// Isolated V3 integration contract only. It creates no transport and is not
// wired to HALL. The source authenticator and seat-view providers must be
// supplied by a future server integration before any player view is created.
const { createSeatStateMessage, validateSeatStateMessage } = require("./v3-seat-state-protocol.js");
const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^hs_[a-f0-9]{32}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const BUILD = /^[a-f0-9]{64}$/;

function reject(code) { return Object.freeze({ ok: false, code }); }
function exact(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

function createVerifiedSeatStatePublisher({ authenticateManagedSource, isHostSessionActive,
	getPublicState, getSeatPrivateState, getSeatPendingChoice } = {}) {
	if ([authenticateManagedSource, isHostSessionActive, getPublicState, getSeatPrivateState, getSeatPendingChoice].some(fn => typeof fn !== "function")) {
		throw new TypeError("V3_SEAT_STATE_PUBLISHER_CONFIG_INVALID");
	}
	function createForSeat(input) {
		const source = input?.source;
		if (!exact(source, "roomId,hostSessionId,rootInstanceId,engineBuildId".split(",")) || !ROOM.test(source.roomId || "") ||
			!SESSION.test(source.hostSessionId || "") || !ROOT.test(source.rootInstanceId || "") || !BUILD.test(source.engineBuildId || "") ||
			!isHostSessionActive(source.roomId, source.hostSessionId) || !authenticateManagedSource(source)) {
			return reject("V3_SEAT_STATE_SOURCE_UNAUTHENTICATED");
		}
		if (!exact(input, "source,seatIds,recipientSeatId,connectionGeneration,stateSequence,stateVersion,replayFromSequence".split(",")) ||
			!Array.isArray(input.seatIds) || !input.seatIds.includes(input.recipientSeatId)) return reject("V3_SEAT_STATE_RECIPIENT_REJECTED");
		let publicState, privateState, pendingChoice;
		try {
			publicState = getPublicState(source);
			privateState = getSeatPrivateState(source, input.recipientSeatId);
			pendingChoice = getSeatPendingChoice(source, input.recipientSeatId);
		} catch (_) { return reject("V3_SEAT_STATE_VIEW_UNAVAILABLE"); }
		// Providers are intentionally synchronous, but can invoke lifecycle hooks.
		// Recheck after projection so a stop/replacement during view construction
		// cannot publish a stale envelope.
		if (!isHostSessionActive(source.roomId, source.hostSessionId) || !authenticateManagedSource(source)) {
			return reject("V3_SEAT_STATE_SOURCE_UNAUTHENTICATED");
		}
		const created = createSeatStateMessage({ roomId: source.roomId, seatIds: input.seatIds,
			recipientSeatId: input.recipientSeatId, connectionGeneration: input.connectionGeneration,
			stateSequence: input.stateSequence, stateVersion: input.stateVersion, replayFromSequence: input.replayFromSequence,
			publicState, privateState, pendingChoice });
		if (!created.ok) return reject(created.code);
		return Object.freeze({ ok: true, message: created.message });
	}
	return Object.freeze({ createForSeat });
}

function createSeatStateReceiver({ roomId, seatIds, seatId, connectionGeneration = 1, lastSequence = 0 } = {}) {
	if (!ROOM.test(roomId || "") || !Array.isArray(seatIds) || !seatIds.includes(seatId) ||
		!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1 ||
		!Number.isSafeInteger(lastSequence) || lastSequence < 0) throw new TypeError("V3_SEAT_STATE_RECEIVER_CONFIG_INVALID");
	let generation = connectionGeneration;
	let sequence = lastSequence;
	let stopped = false;
	function rebind(input) {
		if (stopped || !exact(input, "connectionGeneration,replayFromSequence".split(",")) ||
			input.connectionGeneration !== generation + 1 || input.replayFromSequence !== sequence) return reject("V3_SEAT_STATE_REBIND_REJECTED");
		generation = input.connectionGeneration;
		return Object.freeze({ ok: true, connectionGeneration: generation, replayFromSequence: sequence });
	}
	function accept(message) {
		if (stopped) return reject("V3_SEAT_STATE_RECEIVER_STOPPED");
		const checked = validateSeatStateMessage(message, { roomId, seatId, connectionGeneration: generation, seatIds });
		if (!checked.ok || message.stateSequence !== sequence + 1 || message.replayFromSequence !== sequence) {
			return reject("V3_SEAT_STATE_SEQUENCE_REJECTED");
		}
		sequence = message.stateSequence;
		return Object.freeze({ ok: true, sequence });
	}
	function stop() { stopped = true; }
	return Object.freeze({ rebind, accept, stop, inspect: () => Object.freeze({ roomId, seatId, connectionGeneration: generation, lastSequence: sequence, stopped }) });
}

module.exports = { createVerifiedSeatStatePublisher, createSeatStateReceiver };
