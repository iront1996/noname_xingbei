"use strict";

// Isolated V3 projection from one already-accepted successor pre-action
// envelope. This is not HALL transport and does not authorize a native action.
const crypto = require("node:crypto");
const { createSeatStateMessage } = require("./v3-seat-state-protocol.js");
const { validateNativeCardLedgerSnapshot } = require("./server-managed-native-card-ledger.js");
const { validateManagedNativeEffectStateSnapshot } = require("./server-managed-native-effect-state.js");
const { validateNativeTurnResourceProjectionV2 } = require("./server-managed-native-turn-resource-state-v2.js");

const HEX = /^[a-f0-9]{64}$/;
const SCHEMA = "xingbei_native_private_successor_preaction_capture_v1";

function reject(code) { return Object.freeze({ ok: false, code }); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function createManagedV3SeatStateProjection({ key } = {}) {
	if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("V3_SEAT_PROJECTION_KEY_INVALID");
	const privateKey = Buffer.from(key);
	let destroyed = false;
	function project({ envelope, capture, roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds,
	recipientSeatId, connectionGeneration, stateSequence } = {}) {
		if (destroyed) return reject("V3_SEAT_PROJECTION_DESTROYED");
		if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype || envelope.schema !== SCHEMA ||
			envelope.roomId !== roomId || envelope.hostSessionId !== hostSessionId || envelope.engineBuildId !== engineBuildId ||
			envelope.rootInstanceId !== rootInstanceId || !same(envelope.seatIds, seatIds)) return reject("V3_SEAT_PROJECTION_ENVELOPE_BINDING_REJECTED");
		if (!capture || capture.schema !== "xingbei_native_private_successor_preaction_commitment_v1") return reject("V3_SEAT_PROJECTION_CAPTURE_SCHEMA_REJECTED");
		if (capture.roomId !== roomId || capture.hostSessionId !== hostSessionId || capture.engineBuildId !== engineBuildId ||
			capture.rootInstanceId !== rootInstanceId) return reject("V3_SEAT_PROJECTION_CAPTURE_SCOPE_REJECTED");
		if (!same(capture.seatIds, seatIds)) return reject("V3_SEAT_PROJECTION_CAPTURE_SEATS_REJECTED");
		if (capture.nativeEventId !== envelope.fence?.nativeEventId || capture.eventInstanceId !== envelope.fence?.eventInstanceId ||
			capture.seatId !== envelope.fence?.seatId || capture.nativeCompletionOrdinal !== envelope.fence?.nativeCompletionOrdinal ||
			capture.captureOrdinal !== envelope.captureOrdinal) return reject("V3_SEAT_PROJECTION_FENCE_BINDING_REJECTED");
		if (!seatIds?.includes(recipientSeatId) || !Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1 ||
			!Number.isSafeInteger(stateSequence) || stateSequence < 1) return reject("V3_SEAT_PROJECTION_RECIPIENT_BINDING_REJECTED");
		let cards, effect, turn;
		try {
			cards = validateNativeCardLedgerSnapshot(envelope.cardLedger, seatIds);
			effect = validateManagedNativeEffectStateSnapshot(envelope.effectState, { roomId, hostSessionId,
				engineBuildId, rootInstanceId, seatIds });
			turn = validateNativeTurnResourceProjectionV2(envelope.turnResource, { roomId, hostSessionId,
				engineBuildId, rootInstanceId, seatIds });
		} catch (error) {
			const code = typeof error?.message === "string" && /^NATIVE_(?:CARD_LEDGER|EFFECT_STATE|TURN_STATE_V2)_[A-Z0-9_]{1,80}$/.test(error.message)
				? error.message : "V3_SEAT_PROJECTION_SOURCE_UNSUPPORTED";
			return reject(code);
		}
		const actor = envelope.fence.seatId;
		if (turn.canonical.turn.actorSeatId !== actor || turn.canonical.turn.phase !== "xingDong" ||
			turn.canonical.turn.phaseLoopSeatId !== actor || turn.canonical.turn.currentPhaseSeatId !== actor ||
			turn.canonical.nativeCompletionOrdinal !== capture.nativeCompletionOrdinal ||
			envelope.cardLedger.rootInstanceId !== rootInstanceId || envelope.effectState.rootInstanceId !== rootInstanceId) {
			return reject("V3_SEAT_PROJECTION_NATIVE_STATE_MISMATCH");
		}
		const players = turn.canonical.seats.map(seat => Object.freeze({ seatId: seat.seatId,
			characterId: seat.character, side: seat.side, handCount: cards.filter(card => card.zone === "hand" && card.ownerSeatId === seat.seatId).length }));
		const resources = turn.canonical.resources;
		const publicState = Object.freeze({ activeSeatId: actor, phase: turn.canonical.turn.phase, stateVersion: stateSequence,
			players: Object.freeze(players), resources: Object.freeze({ hongShiQi: resources.hongShiQi, lanShiQi: resources.lanShiQi,
				hongXingBei: resources.hongXingBei, lanXingBei: resources.lanXingBei,
				hongBaoShiCount: resources.hongZhanJi.filter(kind => kind === "baoShi").length,
				hongShuiJingCount: resources.hongZhanJi.filter(kind => kind === "shuiJing").length,
				lanBaoShiCount: resources.lanZhanJi.filter(kind => kind === "baoShi").length,
				lanShuiJingCount: resources.lanZhanJi.filter(kind => kind === "shuiJing").length }) });
		const hand = cards.filter(card => card.zone === "hand" && card.ownerSeatId === recipientSeatId);
		const handCardViewIds = hand.map(card => crypto.createHmac("sha256", privateKey)
			.update("xingbei-v3-seat-card-view-v1\0", "utf8")
			.update(`${roomId}\0${hostSessionId}\0${rootInstanceId}\0${capture.captureOrdinal}\0${recipientSeatId}\0${card.cardId}`, "utf8")
			.digest("base64url"));
		const created = createSeatStateMessage({ roomId, seatIds, recipientSeatId, connectionGeneration,
			stateSequence, stateVersion: stateSequence, replayFromSequence: stateSequence - 1,
			publicState, privateState: { seatId: recipientSeatId, handCardViewIds }, pendingChoice: null });
		if (!created.ok) return reject(created.code);
		return Object.freeze({ ok: true, message: created.message, source: Object.freeze({ captureOrdinal: capture.captureOrdinal,
			nativeCompletionOrdinal: capture.nativeCompletionOrdinal, nativeEventId: capture.nativeEventId,
			stateDigestDomain: "xingbei_native_private_successor_preaction_capture_v1" }) });
	}
	function destroy() { if (!destroyed) { destroyed = true; privateKey.fill(0); } }
	return Object.freeze({ project, destroy });
}

module.exports = { createManagedV3SeatStateProjection };
