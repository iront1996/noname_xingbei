"use strict";

const crypto = require("node:crypto");

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^hs_[a-f0-9]{32}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHOICE_ID = /^choice_[A-Za-z0-9_-]{16,64}$/;
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NATIVE_EVENT_ID = /^native_[A-Za-z0-9_-]{16,96}$/;

function failure(code) {
	return Object.freeze({ ok: false, code });
}

function validOptions(options) {
	return Array.isArray(options) && options.length >= 1 && options.length <= 64 &&
		options.every(option => typeof option === "string" && option.length >= 1 && option.length <= 128) &&
		new Set(options).size === options.length;
}

function createManagedChoiceController({
	now = () => Date.now(),
	isHostSessionActive = () => false,
	authenticateSeat = () => false,
	authorizeManagedHost = () => false,
	authorizeSeatBinding = () => false,
	randomBytes = crypto.randomBytes,
	schedule = (callback, delay) => setTimeout(callback, delay),
	cancel = handle => clearTimeout(handle),
	onResolved = () => {},
	maxPendingChoices = 128,
} = {}) {
	if ([now, isHostSessionActive, authenticateSeat, authorizeManagedHost, authorizeSeatBinding, randomBytes, schedule, cancel, onResolved]
		.some(value => typeof value !== "function") || !Number.isSafeInteger(maxPendingChoices) || maxPendingChoices < 1 || maxPendingChoices > 1024) {
		throw new TypeError("MANAGED_CHOICE_CONFIG_INVALID");
	}
	const choices = new Map();
	const connections = new Map();

	function key(roomId, choiceId) {
		return `${roomId}\u0000${choiceId}`;
	}
	function connectionKey(roomId, seatId) {
		return `${roomId}\u0000${seatId}`;
	}
	function publicChoice(record) {
		if (!record) return null;
		return Object.freeze({
			roomId: record.roomId,
			hostSessionId: record.hostSessionId,
			seatId: record.seatId,
			choiceId: record.choiceId, nativeEventId: record.nativeEventId,
			eventSequence: record.eventSequence,
			options: Object.freeze([...record.options]),
			deadlineAt: record.deadlineAt,
			state: record.state,
			resolution: record.resolution ? Object.freeze({ ...record.resolution }) : null,
		});
	}

	function openChoice(request) {
		const deadlineAt = request?.deadlineAt;
		if (!request || request.protocol !== 1 || !ROOM_ID.test(request.roomId) || !SESSION_ID.test(request.hostSessionId) ||
			!SEAT_ID.test(request.seatId) || !NATIVE_EVENT_ID.test(request.nativeEventId) || !Number.isSafeInteger(request.eventSequence) ||
			request.eventSequence < 1 || !validOptions(request.options) || !Number.isSafeInteger(deadlineAt) ||
			deadlineAt <= now() || deadlineAt - now() > 300000 || typeof request.trusteeOption !== "string" ||
			!request.options.includes(request.trusteeOption) || !isHostSessionActive(request.roomId, request.hostSessionId) ||
			!authorizeManagedHost(request)) {
			return failure("MANAGED_CHOICE_OPEN_REJECTED");
		}
		if ([...choices.values()].filter(choice => choice.state === "pending").length >= maxPendingChoices) return failure("MANAGED_CHOICE_CAPACITY_REJECTED");
		let choiceId;
		try { choiceId = `choice_${randomBytes(16).toString("hex")}`; } catch (_) { return failure("MANAGED_CHOICE_OPEN_REJECTED"); }
		if (!CHOICE_ID.test(choiceId)) return failure("MANAGED_CHOICE_OPEN_REJECTED");
		const choiceKey = key(request.roomId, choiceId);
		if (choices.has(choiceKey)) return failure("MANAGED_CHOICE_EXISTS");
		const record = {
			roomId: request.roomId,
			hostSessionId: request.hostSessionId,
			seatId: request.seatId,
			choiceId, nativeEventId: request.nativeEventId,
			eventSequence: request.eventSequence,
			options: Object.freeze([...request.options]),
			deadlineAt,
			trusteeOption: request.trusteeOption,
			state: "pending",
			resolution: null, timer: null,
		};
		record.timer = schedule(() => expireChoice({ roomId: record.roomId, choiceId: record.choiceId, hostSessionId: record.hostSessionId }), deadlineAt - now());
		const frozen = Object.freeze(record);
		choices.set(choiceKey, frozen);
		return Object.freeze({ ok: true, choice: publicChoice(frozen) });
	}

	function bindSeatConnection({ roomId, seatId, connectionId }) {
		if (!ROOM_ID.test(roomId) || !SEAT_ID.test(seatId) || !CONNECTION_ID.test(connectionId) || !authorizeSeatBinding(arguments[0])) {
			return failure("MANAGED_CHOICE_CONNECTION_REJECTED");
		}
		connections.set(connectionKey(roomId, seatId), connectionId);
		return Object.freeze({ ok: true });
	}

	function resolve(record, resolution) {
		if (record.state !== "pending") return failure("MANAGED_CHOICE_RESOLUTION_REJECTED");
		if (record.timer) cancel(record.timer);
		const resolved = Object.freeze({ ...record, timer: null, state: "resolved", resolution: Object.freeze(resolution) });
		choices.set(key(record.roomId, record.choiceId), resolved);
		try { onResolved(publicChoice(resolved)); } catch (_) { return failure("MANAGED_CHOICE_SINK_FAILED"); }
		return Object.freeze({ ok: true, choice: publicChoice(resolved) });
	}

	function submitChoice(message) {
		const record = choices.get(key(message?.roomId, message?.choiceId));
		if (!record || message?.protocol !== 1 || record.state !== "pending" || message.hostSessionId !== record.hostSessionId ||
			message.nativeEventId !== record.nativeEventId || message.seatId !== record.seatId || message.eventSequence !== record.eventSequence ||
			!CONNECTION_ID.test(message.connectionId) || typeof message.option !== "string" ||
			now() >= record.deadlineAt || !record.options.includes(message.option) ||
			connections.get(connectionKey(record.roomId, record.seatId)) !== message.connectionId ||
			!isHostSessionActive(record.roomId, record.hostSessionId) ||
			!authenticateSeat(message, record)) {
			return failure("MANAGED_CHOICE_SUBMIT_REJECTED");
		}
		return resolve(record, Object.freeze({ kind: "player", option: message.option, connectionId: message.connectionId }));
	}

	function expireChoice({ roomId, choiceId, hostSessionId }) {
		const record = choices.get(key(roomId, choiceId));
		if (!record || record.state !== "pending" || hostSessionId !== record.hostSessionId || now() < record.deadlineAt ||
			!isHostSessionActive(record.roomId, record.hostSessionId)) return failure("MANAGED_CHOICE_EXPIRE_REJECTED");
		return resolve(record, Object.freeze({ kind: "trustee", option: record.trusteeOption }));
	}

	function cleanupRoom(roomId) {
		if (!ROOM_ID.test(roomId)) return failure("MANAGED_CHOICE_CLEANUP_REJECTED");
		for (const [choiceKey, record] of choices) if (record.roomId === roomId) { if (record.timer) cancel(record.timer); choices.delete(choiceKey); }
		for (const connectionKeyValue of connections.keys()) if (connectionKeyValue.startsWith(`${roomId}\u0000`)) connections.delete(connectionKeyValue);
		return Object.freeze({ ok: true });
	}
	function cleanupHostSession(roomId, hostSessionId) {
		if (!ROOM_ID.test(roomId) || !SESSION_ID.test(hostSessionId)) return failure("MANAGED_CHOICE_CLEANUP_REJECTED");
		for (const [choiceKey, record] of choices) if (record.roomId === roomId && record.hostSessionId === hostSessionId) { if (record.timer) cancel(record.timer); choices.delete(choiceKey); }
		return Object.freeze({ ok: true });
	}

	return Object.freeze({
		openChoice,
		bindSeatConnection,
		submitChoice,
		expireChoice,
		cleanupRoom,
		cleanupHostSession,
		pendingCount: () => [...choices.values()].filter(choice => choice.state === "pending").length,
		inspect: (roomId, choiceId) => publicChoice(choices.get(key(roomId, choiceId))),
	});
}

module.exports = { createManagedChoiceController };
