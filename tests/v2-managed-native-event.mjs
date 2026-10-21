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
const setup = {
	mode: "xingBei",
	config: { playerCount: 4 },
	seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `native_seat_${position + 1}`, position })),
};

async function until(check, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("condition timeout");
}

test("managed Chromium executes native Xingbei side assignment without a human host", { skip: !active, timeout: 60000 }, async t => {
	const server = await createV2NativeModuleTestServer({ root });
	t.after(() => server.close());
	const previousOrigin = process.env.V2_GAME_ORIGIN;
	const previousProof = process.env.V2_PLAYABLE_PROOF;
	process.env.V2_GAME_ORIGIN = server.origin;
	process.env.V2_PLAYABLE_PROOF = "1";
	t.after(() => {
		if (previousOrigin === undefined) delete process.env.V2_GAME_ORIGIN;
		else process.env.V2_GAME_ORIGIN = previousOrigin;
		if (previousProof === undefined) delete process.env.V2_PLAYABLE_PROOF;
		else process.env.V2_PLAYABLE_PROOF = previousProof;
	});
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 }),
		browserReadyTimeoutMs: 20000,
		engineReadyTimeoutMs: 30000,
		gameReadyTimeoutMs: 30000,
	});
	t.after(() => manager.stop("native_event_room", "test_cleanup"));
	assert.equal((await manager.start("native_event_room", setup)).ok, true);
	const session = await until(() => {
		const current = manager.inspect("native_event_room");
		if (current?.state === "failed") throw new Error(`native_event_room:${current.failureCode}`);
		return current?.state === "playable_probe" && current;
	});
	assert.equal(session.authorityStateRevision, 1);
	assert.match(session.authorityStateDigest, /^[a-f0-9]{64}$/);
	assert.equal(session.nextAuthorityEventSequence, 2);
	assert.deepEqual(session.lastAuthorityEvent, { sequence: 1, name: "initSideAndPosition" });
	assert.equal(session.checkpointAvailable, false);
	assert.equal(session.nextResultSequence, 1);
	const stopped = await manager.stop("native_event_room", "test_complete");
	assert.equal(stopped.ok, true);
});
