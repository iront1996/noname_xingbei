import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../game/v2-managed-chromium-host.mjs");
const active = typeof process.env.V2_CHROMIUM === "string" && path.isAbsolute(process.env.V2_CHROMIUM);
const gameSetup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `seat_${position + 1}`, position })) };

async function until(check, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("condition timeout");
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

async function pathExists(value) {
	try {
		await access(value);
		return true;
	} catch {
		return false;
	}
}

function killResource(resource) {
	if (process.platform === "win32") process.kill(resource.pid, "SIGKILL");
	else process.kill(-resource.processGroupId, "SIGKILL");
}

async function profileSet() {
	return new Set((await readdir(tmpdir())).filter(name => name.startsWith("v2-managed-host-")));
}

async function untilState(manager, roomId, expected) {
	return until(() => {
		const state = manager.inspect(roomId);
		if (state?.state === "failed") throw new Error(`${roomId}:${state.failureCode}`);
		return state?.state === expected && state;
	});
}

test("real Chromium reaches off-board hostSession ready and cleans up", { skip: !active }, async () => {
	let processHandle;
	const processLaunch = createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 });
	const manager = createHostSessionManager({
		launch: async bootstrap => (processHandle = await processLaunch(bootstrap)),
		browserReadyTimeoutMs: 20000,
		engineReadyTimeoutMs: 20000,
	});
	const started = await manager.start("chromium_room", gameSetup);
	assert.equal(started.ok, true);
	assert.ok(started.session.pid > 0);
	assert.equal("secret" in started.session, false);
	await untilState(manager, "chromium_room", "browser_ready");
	const [resource] = await until(() => processHandle.resources().length && processHandle.resources());
	assert.equal(processExists(resource.pid), true);
	assert.equal(await pathExists(resource.profile), true);
	assert.equal(manager.commitAuthoritativeResult({
		kind: "managed_host",
		type: "authoritative_result",
		protocol: 1,
		roomId: "chromium_room",
		sessionId: started.session.sessionId,
		secret: "00".repeat(32),
		sequence: 1,
		result: { forged: true },
	}).code, "HOST_AUTHORITY_REJECTED");
	assert.equal(manager.inspect("chromium_room").nextResultSequence, 1);
	const stopped = await manager.stop("chromium_room", "test_complete");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
	await processHandle.waitForCleanup();
	await until(() => !processExists(resource.pid));
	assert.equal(await pathExists(resource.profile), false);
});

test("forced supervisor death cleans Chromium tree and isolates another room", { skip: !active }, async t => {
	const handles = new Map();
	const processLaunch = createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 });
	const manager = createHostSessionManager({
		launch: async bootstrap => {
			const handle = await processLaunch(bootstrap);
			handles.set(bootstrap.roomId, handle);
			return handle;
		},
		browserReadyTimeoutMs: 20000,
		engineReadyTimeoutMs: 20000,
	});
	await manager.start("force_room", gameSetup);
	await manager.start("isolated_room", gameSetup);
	t.after(async () => {
		await manager.stop("force_room", "test_cleanup");
		await manager.stop("isolated_room", "test_cleanup");
	});
	await untilState(manager, "force_room", "browser_ready");
	await untilState(manager, "isolated_room", "browser_ready");
	const forcedHandle = handles.get("force_room");
	const [forcedResource] = await until(() => forcedHandle.resources().length && forcedHandle.resources());
	assert.equal(processExists(forcedResource.pid), true);
	process.kill(manager.inspect("force_room").pid, "SIGKILL");
	await until(() => manager.inspect("force_room").state === "failed");
	await forcedHandle.waitForCleanup();
	await until(() => !processExists(forcedResource.pid));
	assert.equal(await pathExists(forcedResource.profile), false);
	assert.equal(manager.inspect("isolated_room").state, "browser_ready");
});

test("Chromium abnormal exit cleans resources and does not fail another room", { skip: !active }, async t => {
	const handles = new Map();
	const processLaunch = createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 });
	const manager = createHostSessionManager({
		launch: async bootstrap => {
			const handle = await processLaunch(bootstrap);
			handles.set(bootstrap.roomId, handle);
			return handle;
		},
		browserReadyTimeoutMs: 20000,
		engineReadyTimeoutMs: 20000,
	});
	await manager.start("chrome_crash_room", gameSetup);
	await manager.start("chrome_stable_room", gameSetup);
	t.after(async () => {
		await manager.stop("chrome_crash_room", "test_cleanup");
		await manager.stop("chrome_stable_room", "test_cleanup");
	});
	await untilState(manager, "chrome_crash_room", "browser_ready");
	await untilState(manager, "chrome_stable_room", "browser_ready");
	const failedHandle = handles.get("chrome_crash_room");
	const [resource] = await until(() => failedHandle.resources().length && failedHandle.resources());
	killResource(resource);
	await until(() => manager.inspect("chrome_crash_room").state === "failed");
	await failedHandle.waitForCleanup();
	await until(() => !processExists(resource.pid));
	assert.equal(await pathExists(resource.profile), false);
	assert.equal(manager.inspect("chrome_stable_room").state, "browser_ready");
});

test("Chromium startup failure leaves no managed profile", { skip: !active }, async () => {
	const before = await profileSet();
	const executable = process.env.V2_CHROMIUM;
	process.env.V2_CHROMIUM = path.join(path.dirname(executable), "missing-v2-chromium");
	try {
		const manager = createHostSessionManager({
			launch: createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 }),
			browserReadyTimeoutMs: 5000,
			engineReadyTimeoutMs: 5000,
		});
		await manager.start("startup_failure_room", gameSetup);
		await until(() => manager.inspect("startup_failure_room").state === "failed");
		assert.equal(manager.inspect("startup_failure_room").failureCode, "HOST_EXITED");
		await until(async () => {
			const after = await profileSet();
			return [...after].every(name => before.has(name));
		});
	} finally {
		process.env.V2_CHROMIUM = executable;
	}
});
