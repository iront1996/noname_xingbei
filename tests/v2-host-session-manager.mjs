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
		browserReadyTimeoutMs: options.browserReadyTimeoutMs || 1000,
		engineReadyTimeoutMs: options.engineReadyTimeoutMs || 1000,
		onAuthoritativeResult: result => results.push(result),
	});
	return { launches, manager, results };
}

function hostMessage(bootstrap, type, extra = {}) {
	return {
		kind: "managed_host",
		type,
		protocol: bootstrap.protocol,
		roomId: bootstrap.roomId,
		sessionId: bootstrap.sessionId,
		secret: bootstrap.secret,
		...extra,
	};
}

test("browser readiness cannot authorize results before separate engine readiness", async () => {
	const f = fixture();
	const started = await f.manager.start("room_A");
	assert.equal(started.ok, true);
	assert.equal(started.session.state, "starting");
	assert.equal("secret" in started.session, false);
	assert.equal(f.launches[0].bootstrap.kind, "host_session_bootstrap");

	const browserReady = f.manager.markBrowserReady(hostMessage(f.launches[0].bootstrap, "host_browser_ready"));
	assert.equal(browserReady.ok, true);
	assert.equal(browserReady.session.state, "browser_ready");
	const result = hostMessage(f.launches[0].bootstrap, "authoritative_result", {
		sequence: 1,
		result: { winner: "team_red" },
	});
	assert.equal(f.manager.commitAuthoritativeResult(result).code, "HOST_AUTHORITY_REJECTED");
	const engineReady = f.manager.markEngineReady(hostMessage(f.launches[0].bootstrap, "host_engine_ready"));
	assert.equal(engineReady.ok, true);
	assert.equal(engineReady.session.state, "engine_ready");
	const committed = f.manager.commitAuthoritativeResult(result);
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
		const forged = { ...hostMessage(bootstrap, "host_browser_ready"), ...credential };
		assert.equal(f.manager.markBrowserReady(forged).code, "HOST_BROWSER_READY_REJECTED");
		assert.equal(f.manager.commitAuthoritativeResult({
			...forged,
			type: "authoritative_result",
			sequence: 1,
			result: { winner: "attacker" },
		}).code, "HOST_AUTHORITY_REJECTED");
	}
	assert.equal(f.results.length, 0);
	assert.equal(f.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready")).ok, true);

	const adminResult = hostMessage(bootstrap, "authoritative_result", {
		kind: "room_administrator",
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
	assert.equal(f.manager.markBrowserReady(hostMessage(first, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(first, "host_engine_ready")).ok, true);
	const result = sequence => hostMessage(first, "authoritative_result", {
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
	assert.equal(f.manager.markBrowserReady(hostMessage(second, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(second, "host_engine_ready")).ok, true);
	assert.equal(f.manager.commitAuthoritativeResult(result(2)).code, "HOST_AUTHORITY_REJECTED");
	assert.equal(f.results.length, 1);
	await f.manager.stop("room_sequence");
});

test("launch, browser-ready and engine-ready failures retain distinct states", async () => {
	const failed = fixture({ launch: async () => { throw new Error("spawn"); } });
	assert.equal((await failed.manager.start("launch_fail")).code, "HOST_LAUNCH_FAILED");
	assert.equal(failed.manager.inspect("launch_fail").failureCode, "HOST_LAUNCH_FAILED");

	const timed = fixture({ browserReadyTimeoutMs: 100 });
	await timed.manager.start("browser_timeout");
	await new Promise(resolve => setTimeout(resolve, 130));
	assert.equal(timed.manager.inspect("browser_timeout").state, "failed");
	assert.equal(timed.manager.inspect("browser_timeout").failureCode, "HOST_BROWSER_READY_TIMEOUT");
	assert.deepEqual(timed.launches[0].handle.stops, ["browser_ready_timeout"]);

	const engineTimed = fixture({ engineReadyTimeoutMs: 100 });
	await engineTimed.manager.start("engine_timeout");
	const bootstrap = engineTimed.launches[0].bootstrap;
	assert.equal(engineTimed.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready")).ok, true);
	await new Promise(resolve => setTimeout(resolve, 130));
	assert.equal(engineTimed.manager.inspect("engine_timeout").failureCode, "HOST_ENGINE_READY_TIMEOUT");
	assert.deepEqual(engineTimed.launches[0].handle.stops, ["engine_ready_timeout"]);

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
