import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
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
		await until(() => observed.filter(message => message?.type === "host_command_observed").length === 2);
		assert.deepEqual(observed.filter(message => message?.type === "host_command_observed").map(message => message.bootCount), [1, 1]);
		assert.equal(observed.filter(message => message?.type === "host_game_ready").length, 1);
		await assert.rejects(handle.sendHostCommand({ type: "host_session_bootstrap" }), /HOST_COMMAND_REJECTED/);
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
