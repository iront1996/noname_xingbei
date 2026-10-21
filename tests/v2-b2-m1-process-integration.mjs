import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

function packetSocket(url) {
	const ws = new WebSocket(url);
	const packets = [];
	const waiters = [];
	ws.on("message", data => {
		const raw = data.toString();
		let packet = raw;
		try {
			packet = JSON.parse(raw);
		} catch (_) {}
		packets.push(packet);
		for (const wake of waiters.splice(0)) wake();
	});
	return {
		ws,
		packets,
		async open() {
			if (ws.readyState === WebSocket.OPEN) return;
			await new Promise((resolve, reject) => {
				ws.once("open", resolve);
				ws.once("error", reject);
			});
		},
		send(...args) {
			ws.send(JSON.stringify(["server", ...args]));
		},
		sendRaw(value) {
			ws.send(value);
		},
		async take(type, timeoutMs = 3000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const index = packets.findIndex(packet => Array.isArray(packet) && packet[0] === type);
				if (index >= 0) return packets.splice(index, 1)[0];
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						const index = waiters.indexOf(wake);
						if (index >= 0) waiters.splice(index, 1);
						reject(new Error(`timeout waiting for ${type}`));
					}, Math.max(1, deadline - Date.now()));
					function wake() {
						clearTimeout(timer);
						resolve();
					}
					waiters.push(wake);
				});
			}
			throw new Error(`timeout waiting for ${type}`);
		},
		async closed(timeoutMs = 3000) {
			if (ws.readyState === WebSocket.CLOSED) return;
			await Promise.race([
				new Promise(resolve => ws.once("close", resolve)),
				new Promise((_, reject) => setTimeout(() => reject(new Error("socket did not close")), timeoutMs)),
			]);
		},
		close() {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		},
		terminate() {
			if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
		},
	};
}

function buildPatchedServer(directory) {
	let pythonCommand = "python3";
	let python = spawnSync(pythonCommand, ["--version"], { encoding: "utf8" });
	if ((python.error || python.status !== 0) && process.platform === "win32") {
		pythonCommand = "python";
		python = spawnSync(pythonCommand, ["--version"], { encoding: "utf8" });
	}
	if (python.error || python.status !== 0) return false;
	const source = fs.readFileSync(path.join(root, "game/server.js"), "utf8");
	const markedSource = path.join(directory, "server-source.js");
	const output = path.join(directory, "server.js");
	fs.writeFileSync(
		markedSource,
		`// XINGBEI-CONNECTION-HEALTH A1\n// XINGBEI-MONITOR DISCONNECT V2.3\n${source}`
	);
	for (const [sourcePath, target] of [
		["game/server-room-lifecycle.js", "server-room-lifecycle.js"],
		["tools/connection-recovery/seat-registry.js", "xingbei-seat-registry.js"],
		["tools/connection-recovery/xingbei-hall-progress-watch.js", "xingbei-hall-progress-watch.js"],
	]) {
		fs.copyFileSync(path.join(root, sourcePath), path.join(directory, target));
	}
	const patch = spawnSync(
		pythonCommand,
		[
			path.join(root, "tools/connection-recovery/patch_server_b2.py"),
			"--source",
			markedSource,
			"--output",
			output,
		],
		{ encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } }
	);
	assert.equal(patch.status, 0, patch.stderr || patch.stdout);
	return output;
}

test("generated B2 HALL preserves M1 lifecycle and fences duplicate seat takeovers", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xingbei-b2-m1-"));
	const serverPath = buildPatchedServer(directory);
	if (!serverPath) {
		fs.rmSync(directory, { recursive: true, force: true });
		t.skip("python3 is required to exercise the production B2 patcher");
		return;
	}

	const port = await freePort();
	const stderr = [];
	const child = spawn(process.execPath, [serverPath], {
		cwd: directory,
		env: { ...process.env, XINGBEI_HALL_PORT: String(port) },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", chunk => stderr.push(chunk.toString()));

	const url = `ws://127.0.0.1:${port}`;
	let owner;
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			owner = packetSocket(url);
			await owner.open();
			break;
		} catch (_) {
			owner?.close();
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
	assert.ok(owner, `patched HALL did not start: ${stderr.join("")}`);
	const sockets = [owner];
	t.after(async () => {
		sockets.forEach(socket => socket.terminate());
		if (!child.killed) {
			const exited = new Promise(resolve => child.once("exit", resolve));
			child.kill();
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
		}
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await owner.take("roomlist");
	owner.send("key", ["room-key", "test"]);
	owner.send("create", "room-key", "Host", "avatar");
	const created = await owner.take("createroom");
	owner.send("config", { gameStarted: false, observe: true, observeReady: true });

	const guest = packetSocket(url);
	sockets.push(guest);
	await guest.open();
	await guest.take("roomlist");
	guest.send("key", ["guest-key", "test"]);
	guest.send("enter", "room-key", "Guest", "avatar");
	const connected = await owner.take("onconnection");
	const seatId = connected[1];
	const credentials = await guest.take("xbSeatCredentials");
	assert.deepEqual(credentials.slice(1, 3), ["room-key", seatId]);
	assert.match(credentials[3], /^[a-f0-9]{64}$/);

	owner.close();
	await guest.take("roompaused");
	const pausedClaim = packetSocket(url);
	sockets.push(pausedClaim);
	await pausedClaim.open();
	await pausedClaim.take("roomlist");
	pausedClaim.send("key", ["guest-key", "test"]);
	pausedClaim.send("xbResumeSeat", "room-key", seatId, credentials[3]);
	await pausedClaim.take("xbSeatResumeRejected");

	const replacementOwner = packetSocket(url);
	sockets.push(replacementOwner);
	await replacementOwner.open();
	await replacementOwner.take("roomlist");
	replacementOwner.send("key", ["room-key", "test"]);
	replacementOwner.send("resumeowner", 1, "room-key", created[2].ownerResumeToken, "Host", "avatar");
	await replacementOwner.take("ownerresumed");
	replacementOwner.send("config", { gameStarted: true, observe: true, observeReady: true });
	assert.deepEqual((await guest.take("roomresumed"))[1], { protocol: 1, roomId: "room-key" });
	assert.equal((await replacementOwner.take("onconnection"))[1], seatId);

	guest.sendRaw("guest-message-after-owner-resume");
	const resumedMessage = await replacementOwner.take("onmessage");
	assert.equal(resumedMessage[1], seatId);

	const takeover = packetSocket(url);
	sockets.push(takeover);
	await takeover.open();
	await takeover.take("roomlist");
	takeover.send("key", ["guest-key", "test"]);
	takeover.send("xbResumeSeat", "room-key", seatId, credentials[3]);
	assert.deepEqual((await takeover.take("xbSeatReclaimed")).slice(1), ["room-key", seatId]);
	assert.equal((await replacementOwner.take("onconnection"))[1], seatId);
	await guest.closed();

	const duplicate = packetSocket(url);
	sockets.push(duplicate);
	await duplicate.open();
	await duplicate.take("roomlist");
	duplicate.send("key", ["guest-key", "test"]);
	duplicate.send("xbResumeSeat", "room-key", seatId, credentials[3]);
	assert.deepEqual((await duplicate.take("xbSeatReclaimed")).slice(1), ["room-key", seatId]);
	assert.equal((await replacementOwner.take("onconnection"))[1], seatId);
	await takeover.closed();

	duplicate.sendRaw("current-seat-message");
	const currentMessage = await replacementOwner.take("onmessage");
	assert.equal(currentMessage[1], seatId);
	replacementOwner.send("send", seatId, JSON.stringify(["owner-to-current-seat"]));
	await duplicate.take("owner-to-current-seat");
	assert.equal(
		replacementOwner.packets.some(packet => Array.isArray(packet) && packet[0] === "onmessage" && packet[2] === "stale-seat-message"),
		false
	);

	const badClaim = packetSocket(url);
	sockets.push(badClaim);
	await badClaim.open();
	await badClaim.take("roomlist");
	badClaim.send("key", ["guest-key", "test"]);
	badClaim.send("xbResumeSeat", "room-key", seatId, "00".repeat(32));
	await badClaim.take("xbSeatResumeRejected");
});
