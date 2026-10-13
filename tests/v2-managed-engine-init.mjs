import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createV2NativeModuleTestServer } from "./fixtures/v2-native-module-test-server.mjs";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "game/v2-managed-chromium-host.mjs");
const active = typeof process.env.V2_CHROMIUM === "string" && path.isAbsolute(process.env.V2_CHROMIUM);
const gameSetup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `seat_${position + 1}`, position })) };

async function until(check, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("condition timeout");
}

test("real Chromium loads actual Noname and Xingbei APIs before Engine Ready", { skip: !active, timeout: 60000 }, async t => {
	const server = await createV2NativeModuleTestServer({ root });
	t.after(() => server.close());
	const previousOrigin = process.env.V2_GAME_ORIGIN;
	process.env.V2_GAME_ORIGIN = server.origin;
	t.after(() => {
		if (previousOrigin === undefined) delete process.env.V2_GAME_ORIGIN;
		else process.env.V2_GAME_ORIGIN = previousOrigin;
	});
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 }),
		browserReadyTimeoutMs: 20000,
		engineReadyTimeoutMs: 30000,
	});
	t.after(() => manager.stop("engine_room", "test_cleanup"));
	assert.equal((await manager.start("engine_room", gameSetup)).ok, true);
	await until(() => manager.inspect("engine_room").state === "engine_ready");
	assert.equal(manager.inspect("engine_room").nextResultSequence, 1);
	const stopped = await manager.stop("engine_room", "test_complete");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
});
