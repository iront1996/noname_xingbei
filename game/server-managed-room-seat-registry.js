"use strict";

const crypto = require("node:crypto");

const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
const SEAT = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const CONNECTION = /^[A-Za-z0-9_-]{1,128}$/;

function createManagedRoomSeatRegistry({ randomBytes = crypto.randomBytes, graceMs = 600000, now = Date.now } = {}) {
	if (typeof randomBytes !== "function" || typeof now !== "function" || !Number.isSafeInteger(graceMs) || graceMs < 1000 || graceMs > 86400000) {
		throw new TypeError("MANAGED_SEAT_REGISTRY_CONFIG_INVALID");
	}
	const rooms = new Map();
	const proofKey = randomBytes(32);
	if (!Buffer.isBuffer(proofKey) || proofKey.length !== 32) throw new TypeError("MANAGED_SEAT_REGISTRY_RANDOM_INVALID");

	function roomSeats(roomId) { return rooms.get(roomId); }
	function tokenDigest(token) {
		if (typeof token !== "string" || !TOKEN.test(token)) return null;
		return crypto.createHash("sha256").update(Buffer.from(token, "hex")).digest();
	}
	function sameDigest(expected, token) {
		const supplied = tokenDigest(token);
		return Boolean(expected && supplied && crypto.timingSafeEqual(expected, supplied));
	}
	function bindingProof(roomId, seatId, connectionId, epoch) {
		return crypto.createHmac("sha256", proofKey).update(`${roomId}\0${seatId}\0${connectionId}\0${epoch}`).digest("hex");
	}
	function createRoom(roomId, seatIds) {
		if (typeof roomId !== "string" || !ROOM.test(roomId) || !Array.isArray(seatIds) || seatIds.length < 2 || seatIds.length > 8 ||
			seatIds.some(seat => typeof seat !== "string" || !SEAT.test(seat)) || new Set(seatIds).size !== seatIds.length || rooms.has(roomId)) return false;
		rooms.set(roomId, new Map(seatIds.map(seatId => [seatId, { digest: null, current: null, epoch: 0, offlineAt: null, revoked: false }])));
		return true;
	}
	function issueSeat(roomId, seatId) {
		const record = roomSeats(roomId)?.get(seatId);
		if (!record || record.revoked || record.digest) return null;
		const raw = randomBytes(32);
		if (!Buffer.isBuffer(raw) || raw.length !== 32) return null;
		const credential = raw.toString("hex");
		record.digest = tokenDigest(credential);
		return Object.freeze({ roomId, seatId, credential });
	}
	function verifySeatCredential({ roomId, seatId, credential } = {}) {
		const record = roomSeats(roomId)?.get(seatId);
		return Boolean(record && !record.revoked && sameDigest(record.digest, credential));
	}
	function bindConnection({ roomId, seatId, credential, socket }) {
		const record = roomSeats(roomId)?.get(seatId);
		if (!record || record.revoked || !sameDigest(record.digest, credential) || !socket || socket.kind !== "player" ||
			socket.roomId !== roomId || socket.seatId !== seatId || typeof socket.connectionId !== "string" || !CONNECTION.test(socket.connectionId) || record.current) return null;
		if (record.offlineAt !== null && now() - record.offlineAt > graceMs) return null;
		record.epoch++;
		record.current = socket.connectionId;
		record.offlineAt = null;
		return Object.freeze({ roomId, seatId, connectionId: socket.connectionId, serverProof: bindingProof(roomId, seatId, socket.connectionId, record.epoch) });
	}
	function disconnect({ roomId, seatId, connectionId }) {
		const record = roomSeats(roomId)?.get(seatId);
		if (!record || record.current !== connectionId) return false;
		record.current = null;
		record.offlineAt = now();
		return true;
	}
	function authenticateSeat(message, choice) {
		const record = roomSeats(message?.roomId)?.get(choice?.seatId);
		return Boolean(record && !record.revoked && choice?.roomId === message.roomId && message.seatId === choice.seatId &&
			record.current === message.connectionId && sameDigest(record.digest, message.credential));
	}
	function authorizeSeatBinding(message) {
		const record = roomSeats(message?.roomId)?.get(message?.seatId);
		if (!record || record.revoked || !record.current || record.current !== message.connectionId || !TOKEN.test(message?.serverProof || "")) return false;
		const expected = Buffer.from(bindingProof(message.roomId, message.seatId, message.connectionId, record.epoch), "hex");
		const supplied = Buffer.from(message.serverProof, "hex");
		return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
	}
	function revoke(roomId, seatId) {
		const record = roomSeats(roomId)?.get(seatId);
		if (!record) return false;
		record.revoked = true; record.current = null; record.digest = null; record.offlineAt = null;
		return true;
	}
	function clearRoom(roomId) { return rooms.delete(roomId); }
	function inspect(roomId, seatId) {
		const record = roomSeats(roomId)?.get(seatId);
		return record ? Object.freeze({ roomId, seatId, issued: Boolean(record.digest), connected: Boolean(record.current), epoch: record.epoch, revoked: record.revoked }) : null;
	}
	return Object.freeze({ createRoom, issueSeat, verifySeatCredential, bindConnection, disconnect, authenticateSeat, authorizeSeatBinding, revoke, clearRoom, inspect });
}

module.exports = { createManagedRoomSeatRegistry };
