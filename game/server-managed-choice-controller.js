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
	onDeliveryFailed = () => {},
	maxPendingChoices = 128,
	maxResolvedChoices = 256,
	deliveryRetryMs = 1000,
	maxDeliveryAttempts = 5,
	applicationTimeoutMs = 85000,
} = {}) {
	if ([now, isHostSessionActive, authenticateSeat, authorizeManagedHost, authorizeSeatBinding, randomBytes, schedule, cancel, onResolved]
		.some(value => typeof value !== "function") || typeof onDeliveryFailed !== "function" || !Number.isSafeInteger(maxPendingChoices) || maxPendingChoices < 1 || maxPendingChoices > 1024 || !Number.isSafeInteger(maxResolvedChoices) || maxResolvedChoices < 1 || maxResolvedChoices > 1024 || !Number.isSafeInteger(deliveryRetryMs) || deliveryRetryMs < 100 || deliveryRetryMs > 60000 || !Number.isSafeInteger(maxDeliveryAttempts) || maxDeliveryAttempts < 1 || maxDeliveryAttempts > 100 || !Number.isSafeInteger(applicationTimeoutMs) || applicationTimeoutMs < 1000 || applicationTimeoutMs > 300000) {
		throw new TypeError("MANAGED_CHOICE_CONFIG_INVALID");
	}
	const choices = new Map();
	const connections = new Map();
	const deliveryInFlight = new Map();

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
			deliveryId: record.deliveryId || null,
			resolution: record.resolution ? Object.freeze({ ...record.resolution }) : null,
			deliveryAttempts: record.deliveryAttempts || 0,
			applicationDeadlineAt: record.applicationDeadlineAt || null,
			deliveryFailureCode: record.deliveryFailureCode || null,
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
		if ([...choices.values()].filter(choice => choice.state !== "resolved").length >= maxPendingChoices) return failure("MANAGED_CHOICE_CAPACITY_REJECTED");
		if ([...choices.values()].some(choice => choice.hostSessionId === request.hostSessionId &&
			choice.nativeEventId === request.nativeEventId && choice.seatId === request.seatId)) return failure("MANAGED_CHOICE_NATIVE_EVENT_EXISTS");
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
		const resolved = Object.freeze({ ...record, timer: null, deliveryTimer: null, deliveryAttempts: 0, state: "delivery_pending", resolution: Object.freeze(resolution), deliveryId: `delivery_${record.choiceId}`, resolvedAt: now() });
		choices.set(key(record.roomId, record.choiceId), resolved);
		return deliver(resolved);
	}
	function pruneResolved() {
		const records = [...choices.entries()].filter(([, record]) => record.state === "resolved").sort((a, b) => a[1].resolvedAt - b[1].resolvedAt);
		while (records.length > maxResolvedChoices) choices.delete(records.shift()[0]);
	}
	function deliver(record) {
		if (!record || !["delivery_pending", "applying"].includes(record.state)) return failure("MANAGED_CHOICE_DELIVERY_REJECTED");
		const choiceKey = key(record.roomId, record.choiceId);
		const current = choices.get(choiceKey);
		if (!current || !["delivery_pending", "applying"].includes(current.state) || current.deliveryId !== record.deliveryId) return failure("MANAGED_CHOICE_DELIVERY_REJECTED");
		if (deliveryInFlight.has(choiceKey)) return Object.freeze({ ok: true, delivery: "pending", choice: publicChoice(current) });
		if (current.state === "delivery_pending" && (current.deliveryAttempts || 0) >= maxDeliveryAttempts) {
			failDelivery(current);
			return failure("MANAGED_CHOICE_DELIVERY_REJECTED");
		}
		const attempting = Object.freeze({ ...current, deliveryAttempts: (current.deliveryAttempts || 0) + 1 });
		choices.set(key(record.roomId, record.choiceId), attempting);
		let outcome;
		try { outcome = onResolved(publicChoice(attempting)); } catch (_) { scheduleDeliveryRetry(attempting); return Object.freeze({ ok: true, delivery: "pending", choice: publicChoice(attempting) }); }
		if (outcome && typeof outcome.then === "function") {
			const flight = { timer: null };
			deliveryInFlight.set(choiceKey, flight);
			flight.timer = schedule(() => {
				if (deliveryInFlight.get(choiceKey) !== flight) return;
				deliveryInFlight.delete(choiceKey);
				const latest = choices.get(choiceKey);
				if (!latest || !["delivery_pending", "applying"].includes(latest.state) || latest.deliveryId !== attempting.deliveryId) return;
				if (latest.state === "delivery_pending" && (latest.deliveryAttempts || 0) >= maxDeliveryAttempts) failDelivery(latest);
				else deliver(latest);
			}, deliveryRetryMs);
			Promise.resolve(outcome).then(() => {
				if (deliveryInFlight.get(choiceKey) !== flight) return;
				cancel(flight.timer);
				deliveryInFlight.delete(choiceKey);
				scheduleDeliveryRetry(attempting);
			}, () => {
				if (deliveryInFlight.get(choiceKey) !== flight) return;
				cancel(flight.timer);
				deliveryInFlight.delete(choiceKey);
				scheduleDeliveryRetry(attempting);
			});
		} else {
			scheduleDeliveryRetry(attempting);
		}
		return Object.freeze({ ok: true, delivery: "sent", choice: publicChoice(attempting) });
	}

	// Read-only inspection for an authenticated native input boundary. This does
	// not allocate a choice, sequence, timer, delivery, or authority event; it is
	// suitable for diagnostic continuation while the authority chain is closed.
	function inspectNativeCandidateSet(request) {
		const keys = "eventName,hostProof,hostSessionId,kind,nativeEventId,optionKinds,options,protocol,roomId,rootInstanceId,seatId";
		const kinds = request?.optionKinds;
		if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).sort().join(",") !== keys ||
			request.protocol !== 1 || request.kind !== "managed_host" || !ROOM_ID.test(request.roomId) ||
			!SESSION_ID.test(request.hostSessionId) || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(request.rootInstanceId || "") ||
			!NATIVE_EVENT_ID.test(request.nativeEventId || "") || !SEAT_ID.test(request.seatId) || request.eventName !== "gongJiOrFaShu" ||
			!Array.isArray(request.options) || request.options.length < 1 || request.options.length > 64 ||
			new Set(request.options).size !== request.options.length ||
			request.options.some(option => !/^native_option_[a-f0-9]{32}$/.test(option)) ||
			!kinds || Object.getPrototypeOf(kinds) !== Object.prototype ||
			Object.keys(kinds).sort().join(",") !== [...request.options].sort().join(",") ||
			Object.values(kinds).some(kind => kind !== "gongJi" && kind !== "faShu") ||
			!isHostSessionActive(request.roomId, request.hostSessionId) || !authorizeManagedHost(request)) {
			return failure("MANAGED_NATIVE_CANDIDATE_INSPECTION_REJECTED");
		}
		return Object.freeze({ ok: true, roomId: request.roomId, hostSessionId: request.hostSessionId,
			rootInstanceId: request.rootInstanceId, nativeEventId: request.nativeEventId, seatId: request.seatId,
			eventName: request.eventName, optionCount: request.options.length,
			optionIds: Object.freeze([...request.options]) });
	}
	function scheduleDeliveryRetry(record) {
		const current = choices.get(key(record?.roomId, record?.choiceId));
		if (!current || !["delivery_pending", "applying"].includes(current.state) || current.deliveryId !== record.deliveryId || current.deliveryTimer) return;
		if (current.state === "delivery_pending" && (current.deliveryAttempts || 0) >= maxDeliveryAttempts) {
			failDelivery(current);
			return;
		}
		const timer = schedule(() => {
			const latest = choices.get(key(record.roomId, record.choiceId));
			if (!latest || !["delivery_pending", "applying"].includes(latest.state) || latest.deliveryId !== record.deliveryId) return;
			const retrying = Object.freeze({ ...latest, deliveryTimer: null });
			choices.set(key(retrying.roomId, retrying.choiceId), retrying);
			deliver(retrying);
		}, deliveryRetryMs);
		choices.set(key(current.roomId, current.choiceId), Object.freeze({ ...current, deliveryTimer: timer }));
	}
	function failDelivery(current) {
		if (!current || !["delivery_pending", "applying"].includes(current.state)) return;
		if (current.deliveryTimer) cancel(current.deliveryTimer);
		if (current.applicationTimer) cancel(current.applicationTimer);
		const flight = deliveryInFlight.get(key(current.roomId, current.choiceId));
		if (flight) cancel(flight.timer);
		deliveryInFlight.delete(key(current.roomId, current.choiceId));
		const failed = Object.freeze({ ...current, state: "delivery_failed", deliveryTimer: null,
			applicationTimer: null, deliveryFailureCode: current.state === "applying" ? "MANAGED_CHOICE_APPLICATION_TIMEOUT" : "MANAGED_CHOICE_ACK_RETRY_EXHAUSTED" });
		choices.set(key(current.roomId, current.choiceId), failed);
		try { onDeliveryFailed(publicChoice(failed)); } catch (_) {}
	}
	function markDeliveryApplying(message) {
		const record = choices.get(key(message?.roomId, message?.choiceId));
		if (!record || message?.protocol !== 1 || message.kind !== "managed_host" ||
			!["delivery_pending", "applying"].includes(record.state) || message.roomId !== record.roomId ||
			message.hostSessionId !== record.hostSessionId || message.nativeEventId !== record.nativeEventId ||
			message.seatId !== record.seatId || message.deliveryId !== record.deliveryId ||
			!isHostSessionActive(record.roomId, record.hostSessionId) || !authorizeManagedHost(message)) {
			return failure("MANAGED_CHOICE_APPLYING_REJECTED");
		}
		if (record.state === "applying") return Object.freeze({ ok: true, duplicate: true, choice: publicChoice(record) });
		if (record.deliveryTimer) cancel(record.deliveryTimer);
		const flight = deliveryInFlight.get(key(record.roomId, record.choiceId));
		if (flight) cancel(flight.timer);
		deliveryInFlight.delete(key(record.roomId, record.choiceId));
		const applying = Object.freeze({ ...record, state: "applying", deliveryTimer: null,
			applicationDeadlineAt: now() + applicationTimeoutMs });
		const timer = schedule(() => {
			const latest = choices.get(key(record.roomId, record.choiceId));
			if (!latest || latest.state !== "applying" || latest.deliveryId !== record.deliveryId) return;
			failDelivery(latest);
		}, applicationTimeoutMs);
		choices.set(key(record.roomId, record.choiceId), Object.freeze({ ...applying, applicationTimer: timer }));
		scheduleDeliveryRetry(choices.get(key(record.roomId, record.choiceId)));
		return Object.freeze({ ok: true, duplicate: false, choice: publicChoice(choices.get(key(record.roomId, record.choiceId)) ) });
	}
	function acknowledgeDelivery(message) {
		const record = choices.get(key(message?.roomId, message?.choiceId));
		if (!record || message?.protocol !== 1 || message.kind !== "managed_host" || !["delivery_pending", "applying"].includes(record.state) ||
			message.roomId !== record.roomId || message.hostSessionId !== record.hostSessionId ||
			message.deliveryId !== record.deliveryId || !isHostSessionActive(record.roomId, record.hostSessionId) ||
			!authorizeManagedHost(message)) return failure("MANAGED_CHOICE_ACK_REJECTED");
		if (record.deliveryTimer) cancel(record.deliveryTimer);
		if (record.applicationTimer) cancel(record.applicationTimer);
		const choiceKey = key(record.roomId, record.choiceId);
		const flight = deliveryInFlight.get(choiceKey);
		if (flight) cancel(flight.timer);
		deliveryInFlight.delete(choiceKey);
		const acknowledged = Object.freeze({ ...record, deliveryTimer: null, applicationTimer: null, state: "resolved" });
		choices.set(key(record.roomId, record.choiceId), acknowledged); pruneResolved();
		return Object.freeze({ ok: true, choice: publicChoice(acknowledged) });
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
		if (!record || record.state !== "pending" || hostSessionId !== record.hostSessionId ||
			!isHostSessionActive(record.roomId, record.hostSessionId)) return failure("MANAGED_CHOICE_EXPIRE_REJECTED");
		const remaining = record.deadlineAt - now();
		if (remaining > 0) {
			// Node timers can fire slightly before the wall-clock deadline. Dropping
			// that callback permanently strands an unanswered native player choice.
			// Re-arm only the remaining interval, preserving the original choice.
			if (record.timer) cancel(record.timer);
			const retry = Object.freeze({ ...record, timer: schedule(
				() => expireChoice({ roomId, choiceId, hostSessionId }), remaining,
			) });
			choices.set(key(roomId, choiceId), retry);
			return Object.freeze({ ok: true, delivery: "waiting", choice: publicChoice(retry) });
		}
		return resolve(record, Object.freeze({ kind: "trustee", option: record.trusteeOption }));
	}

	function cleanupRoom(roomId) {
		if (!ROOM_ID.test(roomId)) return failure("MANAGED_CHOICE_CLEANUP_REJECTED");
		for (const [choiceKey, record] of choices) if (record.roomId === roomId) { if (record.timer) cancel(record.timer); if (record.deliveryTimer) cancel(record.deliveryTimer); if (record.applicationTimer) cancel(record.applicationTimer); choices.delete(choiceKey); }
		for (const [choiceKey, flight] of deliveryInFlight) if (choiceKey.startsWith(`${roomId}\u0000`)) { cancel(flight.timer); deliveryInFlight.delete(choiceKey); }
		for (const connectionKeyValue of connections.keys()) if (connectionKeyValue.startsWith(`${roomId}\u0000`)) connections.delete(connectionKeyValue);
		return Object.freeze({ ok: true });
	}
	function cleanupHostSession(roomId, hostSessionId) {
		if (!ROOM_ID.test(roomId) || !SESSION_ID.test(hostSessionId)) return failure("MANAGED_CHOICE_CLEANUP_REJECTED");
		for (const [choiceKey, record] of choices) if (record.roomId === roomId && record.hostSessionId === hostSessionId) { if (record.timer) cancel(record.timer); if (record.deliveryTimer) cancel(record.deliveryTimer); if (record.applicationTimer) cancel(record.applicationTimer); const flight = deliveryInFlight.get(choiceKey); if (flight) cancel(flight.timer); deliveryInFlight.delete(choiceKey); choices.delete(choiceKey); }
		return Object.freeze({ ok: true });
	}

	return Object.freeze({
		openChoice,
		inspectNativeCandidateSet,
		bindSeatConnection,
		submitChoice,
		expireChoice,
		cleanupRoom,
		cleanupHostSession,
		retryDelivery: ({ roomId, choiceId }) => {
			const choiceKey = key(roomId, choiceId);
			const current = choices.get(choiceKey);
			if (!current || !["delivery_pending", "applying"].includes(current.state)) return failure("MANAGED_CHOICE_DELIVERY_REJECTED");
			if (current.deliveryTimer) cancel(current.deliveryTimer);
			const retry = Object.freeze({ ...current, deliveryTimer: null });
			choices.set(choiceKey, retry);
			return deliver(retry);
		},
		markDeliveryApplying,
		acknowledgeDelivery,
		pendingCount: () => [...choices.values()].filter(choice => choice.state === "pending").length,
		inspect: (roomId, choiceId) => publicChoice(choices.get(key(roomId, choiceId))),
		findPendingChoice: ({ roomId, hostSessionId, seatId, eventSequence } = {}) => {
			if (!ROOM_ID.test(roomId || "") || !SESSION_ID.test(hostSessionId || "") || !SEAT_ID.test(seatId || "") ||
				!Number.isSafeInteger(eventSequence) || eventSequence < 5 || eventSequence > 8) return null;
			const matches = [...choices.values()].filter(record => record.roomId === roomId && record.hostSessionId === hostSessionId &&
				record.seatId === seatId && record.eventSequence === eventSequence && record.state === "pending");
			return matches.length === 1 ? publicChoice(matches[0]) : null;
		},
	});
}

module.exports = { createManagedChoiceController };
