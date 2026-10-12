"use strict";

const crypto = require("node:crypto");

const PROTOCOL = 1;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^hs_[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const ACTIVE_STATES = new Set(["starting", "ready", "stopping"]);

function failure(code) {
	return Object.freeze({ ok: false, code });
}

function safeEqualHex(left, right) {
	if (typeof left !== "string" || typeof right !== "string" ||
		!SECRET.test(left) || !SECRET.test(right)) return false;
	const a = Buffer.from(left, "hex");
	const b = Buffer.from(right, "hex");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createHostSessionManager({
	launch,
	randomBytes = crypto.randomBytes,
	readyTimeoutMs = 15000,
	onAuthoritativeResult = () => {},
} = {}) {
	if (typeof launch !== "function" || typeof randomBytes !== "function" ||
		!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 100 || readyTimeoutMs > 60000 ||
		typeof onAuthoritativeResult !== "function") {
		throw new TypeError("HOST_SESSION_CONFIG_INVALID");
	}

	const sessions = new Map();

	function publicView(record) {
		if (!record) return null;
		return Object.freeze({
			protocol: PROTOCOL,
			roomId: record.roomId,
			sessionId: record.sessionId,
			state: record.state,
			pid: record.pid,
			nextResultSequence: record.nextResultSequence,
			failureCode: record.failureCode,
		});
	}

	function clearReadyTimer(record) {
		if (!record.readyTimer) return;
		clearTimeout(record.readyTimer);
		record.readyTimer = null;
	}

	function finish(record, code) {
		clearReadyTimer(record);
		if (record.state === "stopping") {
			record.state = "stopped";
			record.failureCode = null;
		} else if (record.state === "starting" || record.state === "ready") {
			record.state = "failed";
			record.failureCode = code || "HOST_EXITED";
		}
	}

	function authenticate(record, message) {
		return Boolean(record && message &&
			message.kind === "managed_host" &&
			message.protocol === PROTOCOL &&
			message.roomId === record.roomId &&
			message.sessionId === record.sessionId &&
			safeEqualHex(message.secret, record.secret));
	}

	async function start(roomId) {
		if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) {
			return failure("HOST_ROOM_ID_INVALID");
		}
		const existing = sessions.get(roomId);
		if (existing && ACTIVE_STATES.has(existing.state)) {
			return failure("HOST_SESSION_EXISTS");
		}

		const sessionId = `hs_${randomBytes(16).toString("hex")}`;
		const secret = randomBytes(32).toString("hex");
		if (!SESSION_ID.test(sessionId) || !SECRET.test(secret)) {
			return failure("HOST_RANDOM_SOURCE_INVALID");
		}
		const record = {
			roomId,
			sessionId,
			secret,
			state: "starting",
			pid: null,
			handle: null,
			readyTimer: null,
			nextResultSequence: 1,
			failureCode: null,
		};
		sessions.set(roomId, record);

		try {
			const handle = await launch(Object.freeze({
				kind: "host_session_bootstrap",
				protocol: PROTOCOL,
				roomId,
				sessionId,
				secret,
			}));
			if (!handle || !Number.isSafeInteger(handle.pid) || handle.pid <= 0 ||
				typeof handle.once !== "function" || typeof handle.on !== "function" ||
				typeof handle.stop !== "function") {
				throw new Error("HOST_HANDLE_INVALID");
			}
			record.handle = handle;
			record.pid = handle.pid;
			handle.once("exit", () => finish(record, "HOST_EXITED"));
			handle.on("message", message => {
				if (message?.type === "host_ready") markReady(message);
				else if (message?.type === "authoritative_result") commitAuthoritativeResult(message);
			});
			record.readyTimer = setTimeout(() => {
				if (record.state !== "starting") return;
				record.state = "failed";
				record.failureCode = "HOST_READY_TIMEOUT";
				Promise.resolve(handle.stop("ready_timeout")).catch(() => {});
			}, readyTimeoutMs);
			if (record.readyTimer.unref) record.readyTimer.unref();
			if (typeof handle.start === "function") await handle.start();
			if (record.state === "failed") return failure(record.failureCode);
			return Object.freeze({ ok: true, session: publicView(record) });
		} catch (_) {
			if (record.handle) Promise.resolve(record.handle.stop("launch_failed")).catch(() => {});
			record.state = "failed";
			record.failureCode = "HOST_LAUNCH_FAILED";
			return failure("HOST_LAUNCH_FAILED");
		}
	}

	function markReady(message) {
		const record = sessions.get(message?.roomId);
		if (message?.type !== "host_ready" || !authenticate(record, message) || record.state !== "starting") {
			return failure("HOST_READY_REJECTED");
		}
		clearReadyTimer(record);
		record.state = "ready";
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function commitAuthoritativeResult(message) {
		const record = sessions.get(message?.roomId);
		if (!authenticate(record, message) || record.state !== "ready") {
			return failure("HOST_AUTHORITY_REJECTED");
		}
		if (message.type !== "authoritative_result" ||
			!Number.isSafeInteger(message.sequence) ||
			message.sequence !== record.nextResultSequence) {
			return failure("HOST_RESULT_SEQUENCE_REJECTED");
		}
		let encoded;
		try {
			encoded = JSON.stringify(message.result);
		} catch (_) {
			return failure("HOST_RESULT_INVALID");
		}
		if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 65536) {
			return failure("HOST_RESULT_INVALID");
		}
		const accepted = Object.freeze({
			roomId: record.roomId,
			sessionId: record.sessionId,
			sequence: message.sequence,
			result: JSON.parse(encoded),
		});
		try {
			onAuthoritativeResult(accepted);
		} catch (_) {
			return failure("HOST_RESULT_SINK_FAILED");
		}
		record.nextResultSequence++;
		return Object.freeze({ ok: true, accepted });
	}

	async function stop(roomId, reason = "server_stop") {
		const record = sessions.get(roomId);
		if (!record || !ACTIVE_STATES.has(record.state)) {
			return failure("HOST_SESSION_NOT_ACTIVE");
		}
		clearReadyTimer(record);
		record.state = "stopping";
		try {
			await record.handle.stop(reason);
			if (record.state === "stopping") finish(record);
			return Object.freeze({ ok: true, session: publicView(record) });
		} catch (_) {
			record.state = "failed";
			record.failureCode = "HOST_STOP_FAILED";
			return failure("HOST_STOP_FAILED");
		}
	}

	return Object.freeze({
		start,
		markReady,
		commitAuthoritativeResult,
		stop,
		inspect: roomId => publicView(sessions.get(roomId)),
	});
}

module.exports = { createHostSessionManager };
