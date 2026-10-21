import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const { createManagedEngineSourceManifest } = require("../game/server-managed-engine-integrity.js");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/v2-managed-host-child.mjs");
const gameSetup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `seat_${position + 1}`, position })) };

async function until(check, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error("condition timeout");
}

test("real child-process adapter privately bootstraps, readies, commits and stops", async () => {
	const results = [];
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script: fixture }),
		onAuthoritativeResult: result => results.push(result),
	});
	const started = await manager.start("process_room", gameSetup);
	assert.equal(started.ok, true);
	assert.ok(started.session.pid > 0);
	assert.equal("secret" in started.session, false);
	await until(() => manager.inspect("process_room").state === "game_ready");
	await until(() => results.length === 1);
	assert.equal(results[0].result.source, "simulated_managed_host");
	assert.equal(results[0].result.secretInArgv, false);
	assert.equal(results[0].result.secretInEnvironment, false);
	assert.equal(results[0].sequence, 1);
	const stopped = await manager.stop("process_room", "test_complete");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
});

test("managed child bootstraps once and choice commands cannot bootstrap it again", async () => {
	const launcher = createManagedHostProcessLauncher({ script: fixture });
	const bootstrap = Object.freeze({
		kind: "host_session_bootstrap", protocol: 1, roomId: "one_boot_room", sessionId: "session_once",
		secret: "private_test_secret", setupDigest: "a".repeat(64), gameSetup,
	});
	const handle = await launcher(bootstrap);
	const observed = [];
	handle.on("message", message => observed.push(message));
	try {
		await handle.start();
		await until(() => observed.some(message => message?.type === "host_game_ready"));
		await handle.sendHostCommand({ type: "host_choice_delivery", choiceId: "choice_once", deliveryId: "delivery_once" });
		await handle.sendHostCommand({ type: "host_choice_cancel", choiceId: "choice_once" });
		await handle.sendHostCommand({ kind: "managed_host", type: "host_authority_event_ack", accepted: true, protocol: 1,
			roomId: bootstrap.roomId, sessionId: bootstrap.sessionId, secret: bootstrap.secret,
			eventSequence: 2, stateRevision: 2, afterDigest: "a".repeat(64) });
		await handle.sendHostCommand({ kind: "managed_host", type: "host_authority_event_ack", accepted: true, protocol: 1,
			roomId: bootstrap.roomId, sessionId: bootstrap.sessionId, secret: bootstrap.secret,
			eventSequence: 3, stateRevision: 3, afterDigest: "a".repeat(64) });
		await until(() => observed.filter(message => message?.type === "host_command_observed").length === 4);
		assert.deepEqual(observed.filter(message => message?.type === "host_command_observed").map(message => message.bootCount), [1, 1, 1, 1]);
		assert.equal(observed.filter(message => message?.command === "host_authority_event_ack").length, 2);
		assert.equal(observed.filter(message => message?.type === "host_game_ready").length, 1);
		await assert.rejects(handle.sendHostCommand({ type: "host_session_bootstrap" }), /HOST_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ kind: "managed_host", type: "host_authority_event_ack", protocol: 1,
			roomId: bootstrap.roomId, sessionId: bootstrap.sessionId, secret: "wrong", eventSequence: 3, stateRevision: 3 }), /HOST_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ kind: "managed_host", type: "host_authority_event_ack", protocol: 1,
			roomId: bootstrap.roomId, sessionId: bootstrap.sessionId, secret: bootstrap.secret,
			eventSequence: 2, stateRevision: 2, afterDigest: "a".repeat(64) }), /HOST_COMMAND_REJECTED/);
	} finally {
		await handle.stop("test_complete");
	}
});

test("managed child accepts only the scoped opt-in private effect snapshot command", async t => {
	const envKeys = ["V2_NATIVE_EFFECT_STATE_PROBE", "V2_NATIVE_YINYANG_FIXTURE", "V2_NATIVE_MANAGED_YINYANG",
		"V2_NATIVE_MANAGED_RESPONSE", "V2_NATIVE_START_DIAGNOSTICS", "V2_NATIVE_PHASE_BOUNDARY_FENCE", "V2_TEST_BLOCK_EXTERNAL_NETWORK"];
	const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
	for (const key of envKeys) process.env[key] = "1";
	t.after(() => { for (const key of envKeys) prior[key] === undefined ? delete process.env[key] : process.env[key] = prior[key]; });
	const engineSourceManifest = createManagedEngineSourceManifest(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
	const bootstrap = Object.freeze({ kind: "host_session_bootstrap", protocol: 1, roomId: "effect_process_room",
		sessionId: `hs_${"a".repeat(32)}`, secret: "b".repeat(64), setupDigest: "c".repeat(64), gameSetup,
		engineSourceManifest });
	const handle = await createManagedHostProcessLauncher({ script: fixture })(bootstrap);
	const observed = [];
	handle.on("message", message => observed.push(message));
	try {
		await handle.start();
		await until(() => observed.some(message => message?.type === "host_game_ready"));
		const command = { kind: "managed_host", type: "host_native_effect_state_snapshot", protocol: 1,
			roomId: bootstrap.roomId, sessionId: bootstrap.sessionId, secret: bootstrap.secret, requestId: `effect_${"d".repeat(32)}`,
			mode: "before_native_response", nativeEventId: `native_event_${"e".repeat(32)}`, seatId: gameSetup.seats[0].seatId,
			nativeCompletionOrdinal: null, captureBoundary: "native_response_waiting", schema: "xingbei_native_private_effect_state_v1",
			rootInstanceId: `native_root_${"f".repeat(32)}`, engineBuildId: engineSourceManifest.buildId,
			seatIds: gameSetup.seats.map(seat => seat.seatId) };
		await handle.sendHostCommand(command);
		await until(() => observed.some(message => message?.type === "host_command_observed" &&
			message.command === "host_native_effect_state_snapshot"));
		await assert.rejects(handle.sendHostCommand({ ...command, secret: "0".repeat(64) }), /HOST_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ ...command, seatId: "unknown_seat" }), /HOST_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ ...command, unreviewed: true }), /HOST_COMMAND_REJECTED/);
		assert.equal(observed.filter(message => message?.command === "host_native_effect_state_snapshot").length, 1);
	} finally {
		await handle.stop("test_complete");
	}
});

test("managed child accepts only scoped atomic capture commands with a valid boundary ordinal", async t => {
	const envKeys = ["V2_NATIVE_ATOMIC_CAPTURE_PROBE", "V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE", "V2_NATIVE_START_DIAGNOSTICS",
		"V2_NATIVE_PHASE_BOUNDARY_FENCE", "V2_TEST_BLOCK_EXTERNAL_NETWORK"];
	const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
	for (const key of envKeys) process.env[key] = "1";
	t.after(() => { for (const key of envKeys) prior[key] === undefined ? delete process.env[key] : process.env[key] = prior[key]; });
	const engineSourceManifest = createManagedEngineSourceManifest(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
	const bootstrap = Object.freeze({ kind: "host_session_bootstrap", protocol: 1, roomId: "atomic_process_room",
		sessionId: `hs_${"a".repeat(32)}`, secret: "b".repeat(64), setupDigest: "c".repeat(64), gameSetup,
		engineSourceManifest });
	const handle = await createManagedHostProcessLauncher({ script: fixture })(bootstrap);
	const observed = [];
	handle.on("message", message => observed.push(message));
	try {
		await handle.start();
		await until(() => observed.some(message => message?.type === "host_game_ready"));
		const command = { kind: "managed_host", type: "host_native_atomic_capture", protocol: 1, roomId: bootstrap.roomId,
			sessionId: bootstrap.sessionId, secret: bootstrap.secret, requestId: `atomic_${"d".repeat(32)}`, captureOrdinal: 1,
			boundaryOrdinal: 1, engineBuildId: engineSourceManifest.buildId, rootInstanceId: `native_root_${"e".repeat(32)}`,
			seatIds: gameSetup.seats.map(seat => seat.seatId) };
		await handle.sendHostCommand(command);
		await until(() => observed.some(message => message?.type === "host_command_observed" && message.command === command.type));
		await handle.sendHostCommand({ ...command, requestId: `atomic_${"f".repeat(32)}`, captureOrdinal: 2, boundaryOrdinal: 2 });
		await until(() => observed.filter(message => message?.type === "host_command_observed" && message.command === command.type).length === 2);
		await assert.rejects(handle.sendHostCommand({ ...command, boundaryOrdinal: 0 }), /HOST_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ ...command, boundaryOrdinal: 3 }), /HOST_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ ...command, unreviewed: true }), /HOST_COMMAND_REJECTED/);
		assert.equal(observed.filter(message => message?.type === "host_command_observed" && message.command === command.type).length, 2);
	} finally {
		await handle.stop("test_complete");
	}
});

test("managed child accepts only the isolated native pre-action capture command", async t => {
	const envKeys = ["V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE", "V2_NATIVE_RESOURCE_SHENGJI_FIXTURE", "V2_NATIVE_START_DIAGNOSTICS",
		"V2_NATIVE_PHASE_BOUNDARY_FENCE", "V2_NATIVE_EVENT_COMPLETION_SEQUENCE", "V2_TEST_BLOCK_EXTERNAL_NETWORK"];
	const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
	for (const key of envKeys) process.env[key] = "1";
	t.after(() => { for (const key of envKeys) prior[key] === undefined ? delete process.env[key] : process.env[key] = prior[key]; });
	const engineSourceManifest = createManagedEngineSourceManifest(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
	const bootstrap = Object.freeze({ kind: "host_session_bootstrap", protocol: 1, roomId: "preaction_process_room",
		sessionId: `hs_${"a".repeat(32)}`, secret: "b".repeat(64), setupDigest: "c".repeat(64), gameSetup, engineSourceManifest });
	const handle = await createManagedHostProcessLauncher({ script: fixture })(bootstrap);
	const observed = [];
	handle.on("message", message => observed.push(message));
	try {
		await handle.start();
		await until(() => observed.some(message => message?.type === "host_game_ready"));
		const command = { kind: "managed_host", type: "host_native_pre_action_capture", protocol: 1,
			roomId: bootstrap.roomId, sessionId: bootstrap.sessionId, secret: bootstrap.secret,
			requestId: `preaction_${"d".repeat(32)}`, choiceId: `choice_${"e".repeat(32)}`,
			nativeEventId: `native_event_${"f".repeat(32)}`, seatId: gameSetup.seats[0].seatId,
			engineBuildId: engineSourceManifest.buildId, rootInstanceId: `native_root_${"1".repeat(32)}`,
			seatIds: gameSetup.seats.map(seat => seat.seatId) };
		await handle.sendHostCommand(command);
		await until(() => observed.some(message => message?.type === "host_command_observed" && message.command === command.type));
		await assert.rejects(handle.sendHostCommand({ ...command, roomId: "other_room" }), /HOST_PREACTION_CAPTURE_COMMAND_REJECTED/);
		await assert.rejects(handle.sendHostCommand({ ...command, unreviewed: true }), /HOST_PREACTION_CAPTURE_COMMAND_REJECTED/);
		assert.equal(observed.filter(message => message?.type === "host_command_observed" && message.command === command.type).length, 1);
	} finally {
		await handle.stop("test_complete");
	}
});

test("real child abnormal exit fails its hostSession without affecting another room", async t => {
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script: fixture }),
	});
	await manager.start("stable_room", gameSetup);
	t.after(() => manager.stop("stable_room", "test_cleanup"));
	await manager.start("crash_room", gameSetup);
	await until(() => manager.inspect("stable_room").state === "game_ready");
	await until(() => manager.inspect("crash_room").state === "failed");
	assert.equal(manager.inspect("crash_room").failureCode, "HOST_EXITED");
	assert.equal(manager.inspect("stable_room").state, "game_ready");
});
