import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedRoomSeatRegistry } = require("../game/server-managed-room-seat-registry.js");
const { createManagedChoiceController } = require("../game/server-managed-choice-controller.js");

test("managed room registry uses room-scoped credentials, a single current socket and controller binding proofs", () => {
	let byte = 0;
	const registry = createManagedRoomSeatRegistry({ randomBytes: n => Buffer.alloc(n, ++byte) });
	assert.equal(registry.createRoom("managed_room_a", ["seat_A", "seat_B", "seat_C", "seat_D"]), true);
	assert.equal(registry.createRoom("managed_room_b", ["seat_A", "seat_B"]), true);
	const credentials = Object.fromEntries(["seat_A", "seat_B", "seat_C", "seat_D"].map(seatId => [seatId, registry.issueSeat("managed_room_a", seatId).credential]));
	assert.equal(new Set(Object.values(credentials)).size, 4);
	assert.equal(registry.issueSeat("managed_room_a", "seat_A"), null, "issued credentials cannot be rotated by a duplicate request");
	const hostSessionId = `hs_${"a".repeat(32)}`;
	const controller = createManagedChoiceController({
		isHostSessionActive: (roomId, sessionId) => roomId === "managed_room_a" && sessionId === hostSessionId,
		authorizeManagedHost: message => message.hostProof === "trusted_managed_host",
		authenticateSeat: (message, record) => registry.authenticateSeat(message, record),
		authorizeSeatBinding: message => registry.authorizeSeatBinding(message),
	});
	for (const seatId of Object.keys(credentials)) {
		const socket = { kind: "player", roomId: "managed_room_a", seatId, connectionId: `socket_${seatId}` };
		const binding = registry.bindConnection({ roomId: "managed_room_a", seatId, credential: credentials[seatId], socket });
		assert.ok(binding);
		assert.equal(controller.bindSeatConnection(binding).ok, true);
		assert.equal(registry.bindConnection({ roomId: "managed_room_a", seatId, credential: credentials[seatId], socket: { ...socket, connectionId: `duplicate_${seatId}` } }), null);
	}
	const fakeRoomToken = registry.issueSeat("managed_room_b", "seat_A").credential;
	assert.notEqual(fakeRoomToken, credentials.seat_A);
	assert.equal(registry.bindConnection({ roomId: "managed_room_a", seatId: "seat_A", credential: fakeRoomToken,
		socket: { kind: "player", roomId: "managed_room_a", seatId: "seat_A", connectionId: "wrong_room_token" } }), null);
	assert.equal(registry.bindConnection({ roomId: "managed_room_a", seatId: "seat_A", credential: credentials.seat_A,
		socket: { kind: "room_administrator", roomId: "managed_room_a", seatId: "seat_A", connectionId: "admin_socket" } }), null);
	const opened = controller.openChoice({ protocol: 1, roomId: "managed_room_a", hostSessionId,
		seatId: "seat_A", nativeEventId: "native_registry_choice_0001", eventSequence: 7, options: ["option_1", "option_2"],
		trusteeOption: "option_1", deadlineAt: Date.now() + 60000, hostProof: "trusted_managed_host" });
	assert.equal(opened.ok, true);
	const playerMessage = { protocol: 1, roomId: "managed_room_a", hostSessionId, seatId: "seat_A", nativeEventId: opened.choice.nativeEventId,
		eventSequence: 7, choiceId: opened.choice.choiceId, connectionId: "socket_seat_A", credential: credentials.seat_A, option: "option_2" };
	assert.equal(controller.submitChoice({ ...playerMessage, credential: credentials.seat_B }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	assert.equal(controller.submitChoice({ ...playerMessage, roomId: "managed_room_b" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	for (const seatId of ["seat_B", "seat_C", "seat_D"]) {
		const choice = controller.openChoice({ protocol: 1, roomId: "managed_room_a", hostSessionId, seatId,
			nativeEventId: `native_registry_${seatId}_0001`, eventSequence: 7, options: ["left", "right"], trusteeOption: "left",
			deadlineAt: Date.now() + 60000, hostProof: "trusted_managed_host" });
		assert.equal(choice.ok, true);
		const connectionId = `socket_${seatId}`;
		const request = { protocol: 1, roomId: "managed_room_a", hostSessionId, seatId, nativeEventId: choice.choice.nativeEventId,
			eventSequence: 7, choiceId: choice.choice.choiceId, connectionId, option: "right" };
		assert.equal(controller.submitChoice({ ...request, credential: credentials["seat_A"] }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
		assert.equal(controller.submitChoice({ ...request, credential: credentials[seatId] }).ok, true);
	}
	const valid = registry.bindConnection({ roomId: "managed_room_a", seatId: "seat_A", credential: credentials.seat_A,
		socket: { kind: "player", roomId: "managed_room_a", seatId: "seat_A", connectionId: "seat_A_rebound" } });
	assert.equal(valid, null, "an online seat cannot be taken over with a second socket");
	assert.equal(registry.disconnect({ roomId: "managed_room_a", seatId: "seat_A", connectionId: "socket_seat_A" }), true);
	const rebound = registry.bindConnection({ roomId: "managed_room_a", seatId: "seat_A", credential: credentials.seat_A,
		socket: { kind: "player", roomId: "managed_room_a", seatId: "seat_A", connectionId: "seat_A_rebound" } });
	assert.ok(rebound);
	assert.equal(controller.bindSeatConnection(rebound).ok, true);
	assert.equal(controller.submitChoice(playerMessage).code, "MANAGED_CHOICE_SUBMIT_REJECTED", "old socket must be fenced after takeover");
	assert.equal(controller.submitChoice({ ...playerMessage, connectionId: "seat_A_rebound" }).ok, true);
	assert.equal(registry.authorizeSeatBinding({ ...rebound, connectionId: "socket_seat_A" }), false);
	assert.equal(registry.authorizeSeatBinding(rebound), true);
	assert.equal(registry.revoke("managed_room_a", "seat_A"), true);
	assert.equal(registry.authenticateSeat({ roomId: "managed_room_a", seatId: "seat_A", credential: credentials.seat_A, connectionId: "seat_A_rebound" },
		{ roomId: "managed_room_a", seatId: "seat_A" }), false);
	controller.cleanupRoom("managed_room_a");
	assert.equal(registry.clearRoom("managed_room_a"), true);
});

test("managed registry fails closed on malformed or duplicate rooms and seats", () => {
	const registry = createManagedRoomSeatRegistry();
	assert.equal(registry.createRoom("managed_room", ["same", "same"]), false);
	assert.equal(registry.createRoom("managed_room", ["seat_1", "seat_2"]), true);
	assert.equal(registry.createRoom("managed_room", ["seat_1", "seat_2"]), false);
	assert.equal(registry.issueSeat("managed_room", "unknown"), null);
	assert.equal(registry.bindConnection({ roomId: "managed_room", seatId: "seat_1", credential: "00", socket: {} }), null);
});
