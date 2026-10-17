import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	loadOwnerCredentials,
	validOwnerCredentials,
} from "../noname/util/xingbei-owner-credentials.js";
import { handleOwnerRecoveryControl } from "../noname/util/xingbei-owner-recovery-protocol.js";

function storage() {
	const values = new Map();
	return {
		getItem: key => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: key => values.delete(key),
	};
}

function fixture() {
	const sent = [];
	const phases = [];
	const store = storage();
	const recovery = {
		active: true,
		phase: "SYNCING",
		reject(reason) {
			this.active = false;
			this.phase = "REJECTED";
			phases.push(["reject", reason]);
		},
		connectionLost() {
			phases.push(["lost"]);
		},
		synchronized(kind) {
			this.active = false;
			this.phase = "RECOVERED";
			phases.push(["recovered", kind]);
		},
	};
	const state = { roomId: "owner-key", _xingbeiRecovery: recovery };
	const context = {
		state,
		storage: store,
		endpoint: "wss://hall.invalid",
		onlineKey: "owner-key",
		version: "1.0",
		nickname: "Host",
		avatar: "avatar",
		config: { gameStarted: true },
		send: (...args) => sent.push(args),
	};
	return { context, phases, recovery, sent, state, store };
}

test("owner credential is tab-scoped, protocol-versioned and not logged into public state", () => {
	const f = fixture();
	const firstToken = "a".repeat(43);
	assert.equal(
		handleOwnerRecoveryControl(
			["createroom", "owner-key", { protocol: 1, ownerResumeToken: firstToken }],
			f.context
		),
		false
	);
	assert.deepEqual(f.state._xingbeiOwnerResumeReady, { roomId: "owner-key", protocol: 1 });
	assert.deepEqual(loadOwnerCredentials(f.store, f.context.endpoint), {
		protocol: 1,
		roomId: "owner-key",
		token: firstToken,
	});
	assert.equal(validOwnerCredentials({ protocol: 2, roomId: "owner-key", token: firstToken }), false);
	assert.equal(JSON.stringify(f.state).includes(firstToken), false);
});

test("owner roomlist recovery submits key then versioned resume exactly once", () => {
	const f = fixture();
	const token = "a".repeat(43);
	handleOwnerRecoveryControl(
		["createroom", "owner-key", { protocol: 1, ownerResumeToken: token }],
		f.context
	);
	assert.equal(handleOwnerRecoveryControl(["roomlist"], f.context), true);
	assert.deepEqual(f.sent, [
		["server", "key", ["owner-key", "1.0"]],
		["server", "resumeowner", 1, "owner-key", token, "Host", "avatar"],
	]);
	handleOwnerRecoveryControl(["roomlist"], f.context);
	assert.equal(f.sent.length, 2);
});

test("valid owner acknowledgement rotates secret, reconfigures, then completes recovery", () => {
	const f = fixture();
	const firstToken = "a".repeat(43);
	const nextToken = "b".repeat(43);
	handleOwnerRecoveryControl(
		["createroom", "owner-key", { protocol: 1, ownerResumeToken: firstToken }],
		f.context
	);
	handleOwnerRecoveryControl(["roomlist"], f.context);
	assert.equal(
		handleOwnerRecoveryControl(
			["ownerresumed", "owner-key", {
				protocol: 1,
				ownerResumeToken: nextToken,
				state: "waiting_host_process",
			}],
			f.context
		),
		true
	);
	assert.deepEqual(f.sent.at(-1), ["server", "config", { gameStarted: true }]);
	assert.equal(loadOwnerCredentials(f.store, f.context.endpoint).token, nextToken);
	assert.equal(
		handleOwnerRecoveryControl(
			["roomresumed", { protocol: 1, roomId: "owner-key" }],
			f.context
		),
		true
	);
	assert.deepEqual(f.phases, [["recovered", "owner_resume"]]);
});

test("wrong protocol or unsolicited acknowledgement cannot authorize owner recovery", () => {
	const f = fixture();
	const token = "a".repeat(43);
	handleOwnerRecoveryControl(
		["createroom", "owner-key", { protocol: 1, ownerResumeToken: token }],
		f.context
	);
	assert.equal(
		handleOwnerRecoveryControl(
			["ownerresumed", "owner-key", {
				protocol: 1,
				ownerResumeToken: "b".repeat(43),
				state: "waiting_host_process",
			}],
			f.context
		),
		true
	);
	assert.equal(f.state._xingbeiOwnerReclaimed, undefined);
	assert.equal(f.sent.length, 0);

	handleOwnerRecoveryControl(["roomlist"], f.context);
	handleOwnerRecoveryControl(
		["ownerresumed", "owner-key", {
			protocol: 2,
			ownerResumeToken: "b".repeat(43),
			state: "waiting_host_process",
		}],
		f.context
	);
	assert.deepEqual(f.phases, [["reject", "invalid_owner_resume_ack"]]);
});

test("real browser path invokes owner control before guest reclaim and keeps reload fail-closed", () => {
	const library = fs.readFileSync(new URL("../noname/library/index.js", import.meta.url), "utf8");
	const game = fs.readFileSync(new URL("../noname/game/index.js", import.meta.url), "utf8");
	const ownerIndex = library.indexOf("handleOwnerRecoveryControl(message");
	const guestIndex = library.indexOf("handleSeatRecoveryControl(message");
	assert.ok(ownerIndex >= 0 && guestIndex > ownerIndex);
	assert.match(library, /game\.beginXingbeiOwnerRecovery\?\.\(\)/);
	assert.match(game, /this\._xingbeiOwnerResumeReady\?\.roomId !== this\.roomId/);
	assert.match(game, /loadOwnerCredentials\(storage, _status\.ip\)/);
});
