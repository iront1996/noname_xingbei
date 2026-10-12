import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/v2-managed-host-child.mjs");

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
	const started = await manager.start("process_room");
	assert.equal(started.ok, true);
	assert.ok(started.session.pid > 0);
	assert.equal("secret" in started.session, false);
	await until(() => manager.inspect("process_room").state === "engine_ready");
	await until(() => results.length === 1);
	assert.equal(results[0].result.source, "simulated_managed_host");
	assert.equal(results[0].result.secretInArgv, false);
	assert.equal(results[0].result.secretInEnvironment, false);
	assert.equal(results[0].sequence, 1);
	const stopped = await manager.stop("process_room", "test_complete");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
});

test("real child abnormal exit fails its hostSession without affecting another room", async t => {
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script: fixture }),
	});
	await manager.start("stable_room");
	t.after(() => manager.stop("stable_room", "test_cleanup"));
	await manager.start("crash_room");
	await until(() => manager.inspect("stable_room").state === "engine_ready");
	await until(() => manager.inspect("crash_room").state === "failed");
	assert.equal(manager.inspect("crash_room").failureCode, "HOST_EXITED");
	assert.equal(manager.inspect("stable_room").state, "engine_ready");
});
