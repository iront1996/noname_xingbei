import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../game/v2-managed-chromium-host.mjs");
const active = typeof process.env.V2_CHROMIUM === "string" && path.isAbsolute(process.env.V2_CHROMIUM);

async function until(check, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("condition timeout");
}

test("real Chromium reaches off-board hostSession ready and cleans up", { skip: !active }, async () => {
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 }),
		readyTimeoutMs: 20000,
	});
	const started = await manager.start("chromium_room");
	assert.equal(started.ok, true);
	assert.ok(started.session.pid > 0);
	assert.equal("secret" in started.session, false);
	await until(() => manager.inspect("chromium_room").state === "ready");
	assert.equal(manager.inspect("chromium_room").nextResultSequence, 1);
	const stopped = await manager.stop("chromium_room", "test_complete");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
});
