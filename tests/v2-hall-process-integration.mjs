import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
		for (const waiter of waiters.splice(0)) waiter();
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
		async next(type, timeoutMs = 3000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const found = packets.find(packet => Array.isArray(packet) && packet[0] === type);
				if (found) return found;
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
		close() {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		},
	};
}

test("real HALL process preserves, authenticates and resumes a human-hosted room", async t => {
	const port = await freePort();
	const stderr = [];
	const child = spawn(process.execPath, [path.join(root, "game/server.js")], {
		cwd: root,
		env: { ...process.env, XINGBEI_HALL_PORT: String(port) },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", chunk => stderr.push(chunk.toString()));
	t.after(() => {
		if (!child.killed) child.kill();
	});

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
	assert.ok(owner, `HALL did not start: ${stderr.join("")}`);
	const sockets = [owner];
	t.after(() => sockets.forEach(socket => socket.close()));

	await owner.next("roomlist");
	owner.send("key", ["room-key", "test"]);
	owner.send("create", "room-key", "Host", "avatar");
	const created = await owner.next("createroom");
	assert.equal(created[1], "room-key");
	assert.equal(created[2].protocol, 1);
	assert.match(created[2].ownerResumeToken, /^[A-Za-z0-9_-]{43}$/);
	owner.send("config", { gameStarted: false, observe: true, observeReady: true });

	const guest = packetSocket(url);
	sockets.push(guest);
	await guest.open();
	await guest.next("roomlist");
	guest.send("key", ["guest-key", "test"]);
	guest.send("enter", "room-key", "Guest", "avatar");
	await owner.next("onconnection");

	owner.close();
	const paused = await guest.next("roompaused");
	assert.deepEqual(paused.slice(1, 2), ["awaiting_host"]);
	assert.equal(guest.packets.some(packet => Array.isArray(packet) && packet[0] === "selfclose"), false);

	const newcomer = packetSocket(url);
	sockets.push(newcomer);
	await newcomer.open();
	await newcomer.next("roomlist");
	newcomer.send("key", ["new-key", "test"]);
	newcomer.send("enter", "room-key", "New", "avatar");
	assert.deepEqual((await newcomer.next("enterroomfailed")).slice(1), ["room_paused"]);

	const replacement = packetSocket(url);
	sockets.push(replacement);
	await replacement.open();
	await replacement.next("roomlist");
	replacement.send("key", ["room-key", "test"]);
	replacement.send("resumeowner", 2, "room-key", created[2].ownerResumeToken, "Host", "avatar");
	assert.deepEqual((await replacement.next("resumeownerfailed")).slice(1), ["protocol"]);
	replacement.send("resumeowner", 1, "room-key", created[2].ownerResumeToken, "Host", "avatar");
	const resumed = await replacement.next("ownerresumed");
	assert.equal(resumed[2].protocol, 1);
	assert.equal(resumed[2].state, "waiting_host_process");
	assert.notEqual(resumed[2].ownerResumeToken, created[2].ownerResumeToken);
	replacement.send("config", { gameStarted: true, observe: true, observeReady: true });
	await replacement.next("roomresumed");
	await guest.next("roomresumed");
	assert.ok(replacement.packets.some(packet => Array.isArray(packet) && packet[0] === "onconnection"));
});

