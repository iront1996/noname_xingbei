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
function gameSetup(playerCount) {
	return { mode: "xingBei", config: { playerCount }, seats: Array.from({ length: playerCount }, (_, position) => ({ seatId: `seat_${playerCount}_${position + 1}`, position })) };
}

async function until(check, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("condition timeout");
}

for (const playerCount of [4, 6, 8]) test(`real Chromium creates native ${playerCount}-seat Xingbei arena before Game Ready`, { skip: !active, timeout: 60000 }, async t => {
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
	const roomId = `engine_room_${playerCount}`;
	t.after(() => manager.stop(roomId, "test_cleanup"));
	assert.equal((await manager.start(roomId, gameSetup(playerCount))).ok, true);
	await until(() => {
		const session = manager.inspect(roomId);
		if (session?.state === "failed") throw new Error(`${roomId}:${session.failureCode}`);
		return session?.state === "game_ready";
	});
	const session = manager.inspect(roomId);
	assert.equal(session.nextResultSequence, 1);
	assert.equal(session.authorityStateRevision, 0);
	assert.equal(session.checkpointAvailable, false);
	assert.match(session.setupDigest, /^[a-f0-9]{64}$/);
	assert.match(session.preGameSummaryDigest, /^[a-f0-9]{64}$/);
	const stopped = await manager.stop(roomId, "test_complete");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
});

test("real managed Chromium fails closed when the served native rules source differs from the server manifest", { skip: !active, timeout: 60000 }, async t => {
	const server = await createV2NativeModuleTestServer({ root, transformAsset: (pathname, bytes) => {
		if (pathname !== "/mode/xingBei.js") return bytes;
		const changed = Buffer.from(bytes);
		changed[0] = changed[0] === 0x20 ? 0x09 : 0x20;
		return changed;
	} });
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
	t.after(() => manager.stop("engine_integrity_room", "test_cleanup"));
	assert.equal((await manager.start("engine_integrity_room", gameSetup(4))).ok, true);
	await until(() => {
		const session = manager.inspect("engine_integrity_room");
		if (session?.state === "failed") return session;
		return null;
	});
	const session = manager.inspect("engine_integrity_room");
	assert.equal(session.state, "failed");
	assert.equal(session.failureCode, "ENGINE_SOURCE_DIGEST_MISMATCH");
	assert.equal(session.authorityStateRevision, null);
	assert.equal(session.nextAuthorityEventSequence, 1);
});
