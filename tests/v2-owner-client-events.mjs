import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs
	.readFileSync(new URL("../noname/library/index.js", import.meta.url), "utf8")
	.replaceAll("\r\n", "\n");

function span(begin, end) {
	const start = source.indexOf(begin);
	const finish = source.indexOf(end, start + begin.length);
	assert.ok(start >= 0 && finish > start, `missing actual handler ${begin}`);
	return source.slice(start, finish);
}

function clientHandlers(game) {
	const methods = span(
		"\t\t\troompaused: function (state, remainingMs) {",
		"\t\t\txbProgressProbe(probeId, sequence, hostPhase) {"
	);
	return new Function("game", `return ({${methods}})`)(game);
}

function createRoomHandler(game) {
	const method = span(
		"\t\t\tcreateroom: function (index, config, mode) {",
		"\t\t\tenterroomfailed: function () {"
	);
	const lib = { node: {}, configOL: { mode: "xingBei" } };
	const ui = { create: { connecting() {} } };
	const window = { isNonameServer: false };
	return new Function("game", "lib", "ui", "window", `return ({${method}}).createroom`)(
		game,
		lib,
		ui,
		window
	);
}

function closeHandler(game, status = {}) {
	const method = span(
		"\t\t\tonclose: function () {",
		"\t\t},\n\t\t/**"
	);
	const localStorage = { setItem() {} };
	return new Function(
		"game",
		"_status",
		"localStorage",
		`return ({${method}}).onclose`
	)(game, status, localStorage);
}

test("actual createroom then actual socket close starts owner recovery from onlineroom state", () => {
	let recoveryAttempts = 0;
	const game = {
		online: true,
		onlineroom: false,
		roomId: null,
		switchMode() {},
		beginXingbeiOwnerRecovery() {
			recoveryAttempts++;
			return true;
		},
	};
	createRoomHandler(game)("owner-key", null, null);
	assert.equal(game.online, false);
	assert.equal(game.onlineroom, true);
	assert.equal(game.roomId, "owner-key");

	const socket = {};
	closeHandler(game).call(socket);
	assert.equal(recoveryAttempts, 1);
	assert.equal(game.ws, null);
	assert.equal(game.sandbox, null);
});

test("actual guest pause handler fails closed for host, invalid state and invalid deadline", () => {
	const host = { onlinehall: true, onlineroom: true, online: true };
	clientHandlers(host).roompaused("awaiting_host", 1000);
	assert.equal(host._xingbeiRoomPaused, undefined);

	const guest = { onlinehall: true, onlineroom: false, online: true };
	const handlers = clientHandlers(guest);
	handlers.roompaused("forged", 1000);
	handlers.roompaused("awaiting_host", -1);
	assert.equal(guest._xingbeiRoomPaused, undefined);
});

test("actual guest pause and resume handlers bind protocol and room before reopening messages", () => {
	const guest = {
		onlinehall: true,
		onlineroom: false,
		online: true,
		roomId: "room-key",
		_xingbeiChoiceTicket: "old-choice",
		_xingbeiProgressServerSeq: 12,
	};
	const handlers = clientHandlers(guest);
	handlers.roompaused("awaiting_host", 5000);
	assert.equal(guest._xingbeiRoomPaused, true);
	assert.equal(guest._xingbeiChoiceTicket, null);
	assert.equal(guest._xingbeiProgressServerSeq, null);

	handlers.roomresumed({ protocol: 2, roomId: "room-key" });
	handlers.roomresumed({ protocol: 1, roomId: "other-room" });
	assert.equal(guest._xingbeiRoomPaused, true);
	handlers.roomresumed({ protocol: 1, roomId: "room-key" });
	assert.equal(guest._xingbeiRoomPaused, false);
	assert.equal(guest._xingbeiRoomLifecycleState, "active");
});
