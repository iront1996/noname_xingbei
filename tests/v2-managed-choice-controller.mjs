import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedChoiceController } = require("../game/server-managed-choice-controller.js");
const roomId = "choice_room";
const hostSessionId = `hs_${"a".repeat(32)}`;
const seatId = "seat_1";
const choiceId = "choice_character_pick_0001";

function fixture() {
	let clock = 1000;
	const active = new Set([`${roomId}\u0000${hostSessionId}`]);
	const controller = createManagedChoiceController({
		now: () => clock,
		isHostSessionActive: (room, session) => active.has(`${room}\u0000${session}`),
		authenticateSeat: (message, record) => message.seatCredential === `credential:${record.seatId}`,
	});
	const open = extra => controller.openChoice({
		protocol: 1, roomId, hostSessionId, seatId, choiceId, eventSequence: 2,
		options: ["character_a", "character_b"], trusteeOption: "character_b", deadlineAt: 2000, ...extra,
	});
	const submit = extra => controller.submitChoice({
		protocol: 1, roomId, hostSessionId, seatId, choiceId, eventSequence: 2,
		connectionId: "connection_1", seatCredential: "credential:seat_1", option: "character_a", ...extra,
	});
	return { controller, open, submit, active, setClock: value => { clock = value; } };
}

test("managed choice accepts only the authenticated current seat connection and valid native option", () => {
	const f = fixture();
	assert.equal(f.open().ok, true);
	assert.equal(f.controller.bindSeatConnection({ roomId, seatId, connectionId: "connection_1" }).ok, true);
	for (const invalid of [
		{ seatId: "seat_2" }, { option: "forged_character" }, { connectionId: "old_connection" },
		{ seatCredential: "credential:seat_2" }, { eventSequence: 3 },
	]) assert.equal(f.submit(invalid).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	const accepted = f.submit();
	assert.equal(accepted.ok, true);
	assert.deepEqual(accepted.choice.resolution, { kind: "player", option: "character_a", connectionId: "connection_1" });
	assert.equal(f.submit().code, "MANAGED_CHOICE_SUBMIT_REJECTED");
});

test("managed choice retains disconnect state and resolves a timed-out seat through trustee", () => {
	const f = fixture();
	assert.equal(f.open().ok, true);
	assert.equal(f.controller.bindSeatConnection({ roomId, seatId, connectionId: "connection_1" }).ok, true);
	assert.equal(f.controller.bindSeatConnection({ roomId, seatId, connectionId: "connection_2" }).ok, true);
	assert.equal(f.submit({ connectionId: "connection_1" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	f.setClock(2000);
	assert.equal(f.submit({ connectionId: "connection_2" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	const resolved = f.controller.expireChoice({ roomId, choiceId, hostSessionId });
	assert.equal(resolved.ok, true);
	assert.deepEqual(resolved.choice.resolution, { kind: "trustee", option: "character_b" });
});

test("managed choice fails closed for invalid setup or expired host session", () => {
	const f = fixture();
	assert.equal(f.open({ options: ["duplicate", "duplicate"] }).code, "MANAGED_CHOICE_OPEN_REJECTED");
	assert.equal(f.open({ deadlineAt: 1000 }).code, "MANAGED_CHOICE_OPEN_REJECTED");
	f.active.clear();
	assert.equal(f.open().code, "MANAGED_CHOICE_OPEN_REJECTED");
});
