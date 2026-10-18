import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { SCHEMA, createSeatStateMessage, validateSeatStateMessage, acceptsReconnectCursor } =
	require("../game/v3-seat-state-protocol.js");

const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
const base = () => ({ roomId: "room_v3_probe", seatIds, recipientSeatId: "seat_a", connectionGeneration: 2,
	stateSequence: 19, stateVersion: 7, replayFromSequence: 18,
	publicState: { stateVersion: 7, activeSeatId: "seat_b", players: seatIds.map((seatId, index) => ({
		seatId, characterId: `character_${index}`, side: index < 2, handCount: 4 })) },
	privateState: { seatId: "seat_a", handCardViewIds: ["cardview_00000000000001"] },
	pendingChoice: { choiceId: "choice_00000000000001", eventSequence: 4, seatId: "seat_a",
		optionIds: ["option_00000000000001", "option_00000000000002"], deadlineAt: 1900000000000, status: "delivery_pending" } });

test("V3 seat state envelope scopes private state and pending choice to one ordinary seat", () => {
	const result = createSeatStateMessage(base());
	assert.equal(result.ok, true);
	assert.equal(result.message.schema, SCHEMA);
	assert.equal(result.message.recipientSeatId, "seat_a");
	assert.equal(result.message.privateState.seatId, "seat_a");
	assert.equal(result.message.pendingChoice.seatId, "seat_a");
	assert.equal(validateSeatStateMessage(result.message, { roomId: "room_v3_probe", seatId: "seat_a",
		connectionGeneration: 2, seatIds }).ok, true);
	assert.equal(JSON.stringify(result.message).includes("credential"), false);
	assert.equal(JSON.stringify(result.message).includes("hostSession"), false);
});

test("V3 seat state envelope rejects cross-seat private data and unknown secret-bearing fields", () => {
	const crossSeat = base();
	crossSeat.privateState.seatId = "seat_b";
	assert.deepEqual(createSeatStateMessage(crossSeat), { ok: false, code: "V3_SEAT_STATE_ENVELOPE_REJECTED" });
	const injected = createSeatStateMessage(base()).message;
	assert.equal(validateSeatStateMessage({ ...injected, hostSessionSecret: "not-allowed" }, { seatIds }).ok, false);
	assert.equal(validateSeatStateMessage({ ...injected, privateState: { ...injected.privateState, otherSeatHand: [] } }, { seatIds }).ok, false);
});

test("V3 reconnect cursor fences stale generations and rejects gaps outside the requested replay base", () => {
	assert.equal(acceptsReconnectCursor({ currentConnectionGeneration: 3, incomingConnectionGeneration: 3,
		lastSeenSequence: 18, replayFromSequence: 18 }), true);
	assert.equal(acceptsReconnectCursor({ currentConnectionGeneration: 3, incomingConnectionGeneration: 2,
		lastSeenSequence: 18, replayFromSequence: 18 }), false);
	assert.equal(acceptsReconnectCursor({ currentConnectionGeneration: 3, incomingConnectionGeneration: 3,
		lastSeenSequence: 17, replayFromSequence: 18 }), false);
	const staleView = createSeatStateMessage(base()).message;
	assert.equal(validateSeatStateMessage(staleView, { seatIds, seatId: "seat_a", connectionGeneration: 1 }).ok, false);
});

test("V3 pending choice replay keeps identity, legal options and bounded event version", () => {
	const input = base();
	input.pendingChoice.eventSequence = input.stateSequence + 1;
	assert.equal(createSeatStateMessage(input).ok, false);
	input.pendingChoice.eventSequence = 4;
	input.pendingChoice.optionIds.push(input.pendingChoice.optionIds[0]);
	assert.equal(createSeatStateMessage(input).ok, false);
	input.pendingChoice.optionIds = ["option_00000000000001"];
	input.pendingChoice.status = "resolved";
	assert.equal(createSeatStateMessage(input).ok, false);
});
