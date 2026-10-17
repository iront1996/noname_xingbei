"use strict";

const crypto = require("crypto");

const DEFAULT_OWNER_RECONNECT_MS = 120000;

function safeTokenEquals(actual, expected) {
	if (typeof actual != "string" || typeof expected != "string") return false;
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return (
		actualBuffer.length == expectedBuffer.length &&
		crypto.timingSafeEqual(actualBuffer, expectedBuffer)
	);
}

function releaseRoomClients(clients, room, reason, exceptClient) {
	let released = 0;
	for (const id in clients) {
		const client = clients[id];
		if (client === exceptClient || client.room !== room) continue;
		client.sendl("selfclose", reason);
		delete client.owner;
		delete client.room;
		released++;
	}
	return released;
}

function createRoomLifecycle(options) {
	options = options || {};
	const rooms = options.rooms || [];
	const now = options.now || Date.now;
	const createToken =
		options.createToken || function () {
			return crypto.randomBytes(32).toString("base64url");
		};
	const ownerReconnectMs =
		options.ownerReconnectMs || DEFAULT_OWNER_RECONNECT_MS;

	function findRoom(key) {
		return rooms.find(function (room) {
			return room.key == key;
		});
	}

	function createRoom(owner, key) {
		if (!owner || typeof key != "string" || !key || findRoom(key)) return null;
		const room = {
			key: key,
			owner: owner,
			ownerOnlineKey: owner.onlineKey,
			ownerResumeToken: createToken(),
			lifecycleState: "active",
			ownerDisconnectedAt: null,
			expiresAt: null,
		};
		rooms.push(room);
		return room;
	}

	function pauseForOwnerDisconnect(room, owner) {
		if (!room || room.owner !== owner) return false;
		const disconnectedAt = now();
		room.owner = null;
		room.lifecycleState = "awaiting_host";
		room.ownerDisconnectedAt = disconnectedAt;
		room.expiresAt = disconnectedAt + ownerReconnectMs;
		return true;
	}

	function resumeOwner(room, owner, token) {
		if (
			!room ||
			room.owner ||
			room.lifecycleState != "awaiting_host" ||
			room.expiresAt <= now() ||
			owner.onlineKey !== room.ownerOnlineKey ||
			!safeTokenEquals(token, room.ownerResumeToken)
		) {
			return null;
		}
		room.owner = owner;
		room.ownerResumeToken = createToken();
		room.lifecycleState = "waiting_host_process";
		room.ownerDisconnectedAt = null;
		room.expiresAt = now() + ownerReconnectMs;
		return room.ownerResumeToken;
	}

	function activateOwner(room, owner) {
		if (!room || room.owner !== owner) return false;
		if (room.lifecycleState != "waiting_host_process") return false;
		room.lifecycleState = "active";
		room.ownerDisconnectedAt = null;
		room.expiresAt = null;
		return true;
	}

	function removeRoom(room) {
		const index = rooms.indexOf(room);
		if (index == -1) return false;
		rooms.splice(index, 1);
		room.lifecycleState = "expired";
		room.owner = null;
		return true;
	}

	function sweepExpired(at) {
		at = typeof at == "number" ? at : now();
		const expired = [];
		for (const room of rooms.slice()) {
			if (
				(room.lifecycleState == "awaiting_host" ||
					room.lifecycleState == "waiting_host_process") &&
				typeof room.expiresAt == "number" &&
				room.expiresAt <= at
			) {
				removeRoom(room);
				expired.push(room);
			}
		}
		return expired;
	}

	return {
		rooms: rooms,
		ownerReconnectMs: ownerReconnectMs,
		findRoom: findRoom,
		createRoom: createRoom,
		pauseForOwnerDisconnect: pauseForOwnerDisconnect,
		resumeOwner: resumeOwner,
		activateOwner: activateOwner,
		removeRoom: removeRoom,
		sweepExpired: sweepExpired,
	};
}

module.exports = {
	DEFAULT_OWNER_RECONNECT_MS,
	createRoomLifecycle,
	releaseRoomClients,
};
