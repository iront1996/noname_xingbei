import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
	createRoomLifecycle,
	releaseRoomClients,
} = require("../game/server-room-lifecycle.js");

function socket(id, onlineKey) {
	return {
		wsid: id,
		onlineKey,
		messages: [],
		sendl(...args) {
			this.messages.push(args);
		},
	};
}

function harness() {
	let time = 1000;
	let tokenNumber = 0;
	const rooms = [];
	const clients = {};
	const lifecycle = createRoomLifecycle({
		rooms,
		now: () => time,
		ownerReconnectMs: 5000,
		createToken: () => `secret-${++tokenNumber}`,
	});

	function add(client) {
		clients[client.wsid] = client;
		return client;
	}

	function create(owner, key) {
		const room = lifecycle.createRoom(owner, key);
		assert.ok(room);
		owner.room = room;
		return room;
	}

	function enter(client, room) {
		if (!room.owner || room.lifecycleState != "active") {
			client.sendl("enterroomfailed", "room_paused");
			return false;
		}
		client.room = room;
		client.owner = room.owner;
		return true;
	}

	function disconnect(client) {
		if (client.room?.owner === client) {
			assert.equal(lifecycle.pauseForOwnerDisconnect(client.room, client), true);
			for (const other of Object.values(clients)) {
				if (other !== client && other.room === client.room) {
					delete other.owner;
					other.sendl("roompaused", "awaiting_host");
				}
			}
		} else if (client.owner) {
			client.owner.sendl("onclose", client.wsid);
		}
		delete clients[client.wsid];
	}

	function resume(owner, room, token) {
		const nextToken = lifecycle.resumeOwner(room, owner, token);
		if (!nextToken) return null;
		owner.room = room;
		return nextToken;
	}

	function activate(owner, room) {
		assert.equal(lifecycle.activateOwner(room, owner), true);
		for (const client of Object.values(clients)) {
			if (client !== owner && client.room === room) client.owner = owner;
		}
	}

	function expire() {
		for (const room of lifecycle.sweepExpired(time)) {
			for (const client of Object.values(clients)) {
				if (client.room === room) {
					client.sendl("selfclose", "room_expired");
					delete client.owner;
					delete client.room;
				}
			}
		}
	}

	return {
		rooms,
		clients,
		lifecycle,
		add,
		create,
		enter,
		disconnect,
		resume,
		activate,
		expire,
		advance(ms) {
			time += ms;
		},
	};
}

test("normal owner and guest room flow remains routed through the live owner", () => {
	const h = harness();
	const owner = h.add(socket("owner-1", "room-key"));
	const guest = h.add(socket("guest-1", "guest-key"));
	const room = h.create(owner, "room-key");
	h.enter(guest, room);

	assert.equal(room.lifecycleState, "active");
	assert.equal(guest.owner, owner);
	assert.equal(room.ownerResumeToken, "secret-1");
	assert.equal(h.lifecycle.activateOwner(room, owner), false);
	assert.deepEqual(guest.messages, []);
});

test("ordinary guest disconnect notifies the owner but keeps the room", () => {
	const h = harness();
	const owner = h.add(socket("owner-1", "room-key"));
	const guest = h.add(socket("guest-1", "guest-key"));
	const room = h.create(owner, "room-key");
	h.enter(guest, room);
	h.disconnect(guest);

	assert.equal(h.rooms.length, 1);
	assert.equal(room.owner, owner);
	assert.equal(room.lifecycleState, "active");
	assert.deepEqual(owner.messages, [["onclose", "guest-1"]]);
});

test("owner disconnect pauses instead of deleting the room or ejecting guests", () => {
	const h = harness();
	const owner = h.add(socket("owner-1", "room-key"));
	const guest = h.add(socket("guest-1", "guest-key"));
	const room = h.create(owner, "room-key");
	h.enter(guest, room);
	h.disconnect(owner);

	assert.equal(h.rooms.length, 1);
	assert.equal(room.owner, null);
	assert.equal(room.lifecycleState, "awaiting_host");
	assert.equal(guest.owner, undefined);
	assert.deepEqual(guest.messages, [["roompaused", "awaiting_host"]]);
	assert.equal(guest.messages.some(message => message[0] == "selfclose"), false);
});

test("paused room retains existing guests but rejects new visitors", () => {
	const h = harness();
	const owner = h.add(socket("owner-1", "room-key"));
	const existingGuest = h.add(socket("guest-1", "guest-key"));
	const room = h.create(owner, "room-key");
	h.enter(existingGuest, room);
	h.disconnect(owner);

	const newcomer = h.add(socket("guest-2", "new-key"));
	assert.equal(h.enter(newcomer, room), false);
	assert.equal(newcomer.room, undefined);
	assert.equal(newcomer.owner, undefined);
	assert.deepEqual(newcomer.messages, [["enterroomfailed", "room_paused"]]);
	assert.equal(existingGuest.room, room);
	assert.deepEqual(existingGuest.messages, [["roompaused", "awaiting_host"]]);
});

test("server-mode host shutdown notifies guests and clears stale room references", () => {
	const owner = socket("server-host", "server-key");
	const guest = socket("guest-1", "guest-key");
	const unrelated = socket("guest-2", "other-key");
	const room = { owner, servermode: true };
	const otherRoom = { owner: unrelated };
	owner.room = room;
	guest.room = room;
	guest.owner = owner;
	unrelated.room = otherRoom;
	const clients = { owner, guest, unrelated };

	assert.equal(releaseRoomClients(clients, room, "server_host_closed", owner), 1);
	assert.equal(guest.room, undefined);
	assert.equal(guest.owner, undefined);
	assert.deepEqual(guest.messages, [["selfclose", "server_host_closed"]]);
	assert.equal(owner.room, room);
	assert.equal(unrelated.room, otherRoom);
	assert.deepEqual(unrelated.messages, []);
});

test("owner reclaim requires both bound identity and rotating secret", () => {
	const h = harness();
	const originalOwner = h.add(socket("owner-1", "room-key"));
	const guest = h.add(socket("guest-1", "guest-key"));
	const room = h.create(originalOwner, "room-key");
	const originalToken = room.ownerResumeToken;
	h.enter(guest, room);
	h.disconnect(originalOwner);

	const attacker = h.add(socket("attacker", "other-key"));
	assert.equal(h.resume(attacker, room, originalToken), null);
	const replacement = h.add(socket("owner-2", "room-key"));
	assert.equal(h.resume(replacement, room, "wrong-token"), null);
	const nextToken = h.resume(replacement, room, originalToken);
	assert.equal(nextToken, "secret-2");
	assert.notEqual(nextToken, originalToken);
	assert.equal(room.lifecycleState, "waiting_host_process");
	assert.equal(guest.owner, undefined);

	h.activate(replacement, room);
	assert.equal(room.lifecycleState, "active");
	assert.equal(guest.owner, replacement);
	assert.equal(h.resume(socket("owner-3", "room-key"), room, originalToken), null);
});

test("expired paused room is cleaned up and only then closes remaining guests", () => {
	const h = harness();
	const owner = h.add(socket("owner-1", "room-key"));
	const guest = h.add(socket("guest-1", "guest-key"));
	const room = h.create(owner, "room-key");
	h.enter(guest, room);
	h.disconnect(owner);
	h.advance(4999);
	h.expire();
	assert.equal(h.rooms.length, 1);
	assert.equal(guest.room, room);

	h.advance(1);
	h.expire();
	assert.equal(h.rooms.length, 0);
	assert.equal(room.lifecycleState, "expired");
	assert.equal(guest.room, undefined);
	assert.deepEqual(guest.messages.at(-1), ["selfclose", "room_expired"]);
});

test("real HALL source integrates lifecycle pause, reclaim and cleanup paths", () => {
	const source = fs.readFileSync(new URL("../game/server.js", import.meta.url), "utf8");
	assert.match(source, /createRoomLifecycle\(\{ rooms: rooms \}\)/);
	assert.match(source, /resumeowner: function \(key, token, nickname, avatar\)/);
	assert.match(source, /roomLifecycle\.pauseForOwnerDisconnect\(room, this\)/);
	assert.match(source, /roomLifecycle\.sweepExpired\(\)/);
	assert.match(source, /"roompaused",\s*"awaiting_host"/);
	assert.match(source, /"enterroomfailed", "room_paused"/);
	assert.match(source, /releaseRoomClients\([\s\S]*?"server_host_closed"/);
	assert.doesNotMatch(
		source,
		/clients\[j\]\.sendl\("selfclose"\);[\s\S]{0,200}rooms\.splice\(i--, 1\)/
	);
});
