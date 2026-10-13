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
	seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `selection_seat_${position + 1}`, position })),
};

async function until(check, timeoutMs = 45000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("condition timeout");
}

test("managed Chromium uses native Xingbei selection without a human local player", { skip: !active, timeout: 60000 }, async t => {
	const server = await createV2NativeModuleTestServer({ root });
	t.after(() => server.close());
	const previousOrigin = process.env.V2_GAME_ORIGIN;
	const previousProof = process.env.V2_PLAYABLE_PROOF;
	const previousSelection = process.env.V2_CHARACTER_SELECTION_PROBE;
	process.env.V2_GAME_ORIGIN = server.origin;
	process.env.V2_PLAYABLE_PROOF = "1";
	process.env.V2_CHARACTER_SELECTION_PROBE = "1";
	t.after(() => {
		if (previousOrigin === undefined) delete process.env.V2_GAME_ORIGIN;
		else process.env.V2_GAME_ORIGIN = previousOrigin;
		if (previousProof === undefined) delete process.env.V2_PLAYABLE_PROOF;
		else process.env.V2_PLAYABLE_PROOF = previousProof;
		if (previousSelection === undefined) delete process.env.V2_CHARACTER_SELECTION_PROBE;
		else process.env.V2_CHARACTER_SELECTION_PROBE = previousSelection;
	});
	const manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 }),
		browserReadyTimeoutMs: 20000,
		engineReadyTimeoutMs: 30000,
		gameReadyTimeoutMs: 30000,
	});
	t.after(() => manager.stop("character_selection_room", "test_cleanup"));
	assert.equal((await manager.start("character_selection_room", setup)).ok, true);
	const session = await until(() => {
		const current = manager.inspect("character_selection_room");
		if (current?.state === "failed") throw new Error(`character_selection_room:${current.failureCode}`);
		return current?.authorityStateRevision === 2 && current;
	});
	assert.equal(session.state, "playable_probe");
	assert.match(session.authorityStateDigest, /^[a-f0-9]{64}$/);
	assert.equal(session.nextAuthorityEventSequence, 3);
	assert.deepEqual(session.lastAuthorityEvent, { sequence: 2, name: "chooseCharacterOL" });
	assert.equal(session.checkpointAvailable, false);
	assert.equal((await manager.stop("character_selection_room", "test_complete")).ok, true);
});
