import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");

function fixture(options = {}) {
	const launches = [];
	const results = [];
	let nextPid = 4100;
	const launch = options.launch || (async bootstrap => {
		const handle = new EventEmitter();
		handle.pid = nextPid++;
		handle.stops = [];
		handle.stop = async reason => {
			handle.stops.push(reason);
			handle.emit("exit", 0, null);
		};
		launches.push({ bootstrap, handle });
		return handle;
	});
	let byte = 0;
	const manager = createHostSessionManager({
		launch,
		randomBytes(size) {
			byte++;
			return Buffer.alloc(size, byte);
		},
		readyTimeoutMs: options.readyTimeoutMs || 1000,
		onAuthoritativeResult: result => results.push(result),
	});
	return { launches, manager, results };
}

function hostMessage(bootstrap, extra = {}) {
	return {
		kind: "managed_host",
		protocol: bootstrap.protocol,
		roomId: bootstrap.roomId,
		sessionId: bootstrap.sessionId,
		secret: bootstrap.secret,
		...extra,
	};
}

test("host session launches, attests readiness, commits ordered result and stops", async () => {
	const f = fixture();
	const started = await f.manager.start("room_A");
	assert.equal(started.ok, true);
	assert.equal(started.session.state, "starting");
	assert.equal("secret" in started.session, false);
	assert.equal(f.launches[0].bootstrap.kind, "host_session_bootstrap");

	const ready = f.manager.markReady(hostMessage(f.launches[0].bootstrap));
	assert.equal(ready.ok, true);
	assert.equal(ready.session.state, "ready");
	const committed = f.manager.commitAuthoritativeResult(hostMessage(f.launches[0].bootstrap, {
		type: "authoritative_result",
		sequence: 1,
		result: { winner: "team_red" },
	}));
	assert.equal(committed.ok, true);
	assert.equal(f.results.length, 1);
	assert.equal(f.manager.inspect("room_A").nextResultSequence, 2);

	const stopped = await f.manager.stop("room_A", "room_cleanup");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
	assert.deepEqual(f.launches[0].handle.stops, ["room_cleanup"]);
});

test("player and administrator credentials cannot attest or submit authoritative results", async () => {
	const f = fixture();
	await f.manager.start("room_roles");
	const bootstrap = f.launches[0].bootstrap;
	for (const credential of [
		{ kind: "player_seat", token: bootstrap.secret },
		{ kind: "room_administrator", token: bootstrap.secret },
		{ kind: "managed_host", secret: "ff".repeat(32) },
	]) {
		const forged = { ...hostMessage(bootstrap), ...credential };
		assert.equal(f.manager.markReady(forged).code, "HOST_READY_REJECTED");
		assert.equal(f.manager.commitAuthoritativeResult({
			...forged,
			type: "authoritative_result",
			sequence: 1,
			result: { winner: "attacker" },
		}).code, "HOST_AUTHORITY_REJECTED");
	}
	assert.equal(f.results.length, 0);
	assert.equal(f.manager.markReady(hostMessage(bootstrap)).ok, true);

	const adminResult = hostMessage(bootstrap, {
		kind: "room_administrator",
		type: "authoritative_result",
		sequence: 1,
		result: { winner: "admin" },
	});
	assert.equal(f.manager.commitAuthoritativeResult(adminResult).code, "HOST_AUTHORITY_REJECTED");
	assert.equal(f.results.length, 0);
	await f.manager.stop("room_roles");
});

test("duplicate, out-of-order and stale-session results fail closed", async () => {
	const f = fixture();
	await f.manager.start("room_sequence");
	const first = f.launches[0].bootstrap;
	assert.equal(f.manager.markReady(hostMessage(first)).ok, true);
	const result = sequence => hostMessage(first, {
		type: "authoritative_result",
		sequence,
		result: { sequence },
	});
	assert.equal(f.manager.commitAuthoritativeResult(result(2)).code, "HOST_RESULT_SEQUENCE_REJECTED");
	assert.equal(f.manager.commitAuthoritativeResult(result(1)).ok, true);
	assert.equal(f.manager.commitAuthoritativeResult(result(1)).code, "HOST_RESULT_SEQUENCE_REJECTED");
	await f.manager.stop("room_sequence");

	await f.manager.start("room_sequence");
	const second = f.launches[1].bootstrap;
	assert.notEqual(second.sessionId, first.sessionId);
	assert.equal(f.manager.markReady(hostMessage(second)).ok, true);
	assert.equal(f.manager.commitAuthoritativeResult(result(2)).code, "HOST_AUTHORITY_REJECTED");
	assert.equal(f.results.length, 1);
	await f.manager.stop("room_sequence");
});

test("launch failure, readiness timeout and unexpected exit have distinct failed states", async () => {
	const failed = fixture({ launch: async () => { throw new Error("spawn"); } });
	assert.equal((await failed.manager.start("launch_fail")).code, "HOST_LAUNCH_FAILED");
	assert.equal(failed.manager.inspect("launch_fail").failureCode, "HOST_LAUNCH_FAILED");

	const timed = fixture({ readyTimeoutMs: 100 });
	await timed.manager.start("ready_timeout");
	await new Promise(resolve => setTimeout(resolve, 130));
	assert.equal(timed.manager.inspect("ready_timeout").state, "failed");
	assert.equal(timed.manager.inspect("ready_timeout").failureCode, "HOST_READY_TIMEOUT");
	assert.deepEqual(timed.launches[0].handle.stops, ["ready_timeout"]);

	const exited = fixture();
	await exited.manager.start("unexpected_exit");
	exited.launches[0].handle.emit("exit", 12, null);
	assert.equal(exited.manager.inspect("unexpected_exit").state, "failed");
	assert.equal(exited.manager.inspect("unexpected_exit").failureCode, "HOST_EXITED");
});

test("one room cannot start two active host sessions", async () => {
	const f = fixture();
	await f.manager.start("one_host");
	assert.equal((await f.manager.start("one_host")).code, "HOST_SESSION_EXISTS");
	assert.equal(f.launches.length, 1);
	await f.manager.stop("one_host");
});
