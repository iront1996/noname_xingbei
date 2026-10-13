"use strict";

const crypto = require("node:crypto");

const PROTOCOL = 1;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^hs_[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_STATES = new Set(["starting", "browser_ready", "engine_ready", "game_ready", "playable_probe", "stopping"]);

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

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("HOST_GAME_SETUP_INVALID");
}

function prepareGameSetup(value) {
	if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.mode !== "xingBei" ||
		!Array.isArray(value.seats) || value.seats.length < 2 || value.seats.length > 8 ||
		!value.config || Object.getPrototypeOf(value.config) !== Object.prototype ||
		![4, 6, 8].includes(value.config.playerCount) || value.config.playerCount !== value.seats.length) {
		throw new TypeError("HOST_GAME_SETUP_INVALID");
	}
	const seats = value.seats.map((seat, position) => {
		if (!seat || Object.getPrototypeOf(seat) !== Object.prototype || !SEAT_ID.test(seat.seatId) ||
			seat.position !== position || Object.keys(seat).some(key => !["seatId", "position"].includes(key))) {
			throw new TypeError("HOST_GAME_SETUP_INVALID");
		}
		return Object.freeze({ seatId: seat.seatId, position });
	});
	if (new Set(seats.map(seat => seat.seatId)).size !== seats.length) throw new TypeError("HOST_GAME_SETUP_INVALID");
	const setup = JSON.parse(canonicalize({ mode: value.mode, config: value.config, seats }));
	const encoded = canonicalize(setup);
	if (Buffer.byteLength(encoded, "utf8") > 65536) throw new TypeError("HOST_GAME_SETUP_INVALID");
	return Object.freeze({
		setup: Object.freeze(setup),
		digest: crypto.createHash("sha256").update(encoded).digest("hex"),
		seatIds: Object.freeze(seats.map(seat => seat.seatId)),
	});
}

function createHostSessionManager({
	launch,
	randomBytes = crypto.randomBytes,
	browserReadyTimeoutMs = 15000,
	engineReadyTimeoutMs = 15000,
	gameReadyTimeoutMs = 15000,
	onAuthoritativeResult = () => {},
} = {}) {
	if (typeof launch !== "function" || typeof randomBytes !== "function" ||
		!Number.isSafeInteger(browserReadyTimeoutMs) || browserReadyTimeoutMs < 100 || browserReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(engineReadyTimeoutMs) || engineReadyTimeoutMs < 100 || engineReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(gameReadyTimeoutMs) || gameReadyTimeoutMs < 100 || gameReadyTimeoutMs > 60000 ||
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
			setupDigest: record.setupDigest,
			preGameSummaryDigest: record.preGameSummaryDigest,
			authorityStateRevision: record.authorityStateRevision,
			authorityStateDigest: record.authorityStateDigest,
			nextAuthorityEventSequence: record.nextAuthorityEventSequence,
			checkpointAvailable: false,
			lastAuthorityEvent: record.lastAuthorityEvent,
		});
	}

	function clearPhaseTimer(record) {
		if (!record.phaseTimer) return;
		clearTimeout(record.phaseTimer);
		record.phaseTimer = null;
	}

	function armPhaseTimer(record, expectedState, timeoutMs, failureCode, stopReason) {
		clearPhaseTimer(record);
		record.phaseTimer = setTimeout(() => {
			if (record.state !== expectedState) return;
			record.state = "failed";
			record.failureCode = failureCode;
			Promise.resolve(record.handle?.stop(stopReason)).catch(() => {});
		}, timeoutMs);
		if (record.phaseTimer.unref) record.phaseTimer.unref();
	}

	function finish(record, code) {
		clearPhaseTimer(record);
		if (record.state === "stopping") {
			record.state = "stopped";
			record.failureCode = null;
		} else if (["starting", "browser_ready", "engine_ready", "game_ready", "playable_probe"].includes(record.state)) {
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

	async function start(roomId, gameSetup) {
		if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) {
			return failure("HOST_ROOM_ID_INVALID");
		}
		const existing = sessions.get(roomId);
		if (existing && ACTIVE_STATES.has(existing.state)) {
			return failure("HOST_SESSION_EXISTS");
		}
		let prepared;
		try {
			prepared = prepareGameSetup(gameSetup);
		} catch (_) {
			return failure("HOST_GAME_SETUP_INVALID");
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
			phaseTimer: null,
			nextResultSequence: 1,
			failureCode: null,
			gameSetup: prepared.setup,
			setupDigest: prepared.digest,
			seatIds: prepared.seatIds,
			preGameSummaryDigest: null,
			authorityStateRevision: null,
			authorityStateDigest: null,
			nextAuthorityEventSequence: 1,
			lastAuthorityEvent: null,
		};
		sessions.set(roomId, record);

		try {
			const handle = await launch(Object.freeze({
				kind: "host_session_bootstrap",
				protocol: PROTOCOL,
				roomId,
				sessionId,
				secret,
				gameSetup: record.gameSetup,
				setupDigest: record.setupDigest,
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
				if (message?.type === "host_browser_ready") markBrowserReady(message);
				else if (message?.type === "host_engine_ready") markEngineReady(message);
				else if (message?.type === "host_game_ready") markGameReady(message);
				else if (message?.type === "host_authority_event") commitAuthorityEvent(message);
				else if (message?.type === "authoritative_result") commitAuthoritativeResult(message);
			});
			armPhaseTimer(record, "starting", browserReadyTimeoutMs,
				"HOST_BROWSER_READY_TIMEOUT", "browser_ready_timeout");
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

	function validateXingbeiSideAssignment(record, event) {
		if (!event || event.kind !== "xingbei_side_assignment_v1" || event.name !== "initSideAndPosition" ||
			event.hostPlayerAbsent !== true || event.connectedTransports !== 0 ||
			!record.seatIds.includes(event.firstActSeatId) || !Array.isArray(event.sides) ||
			event.sides.length !== record.seatIds.length || event.sides.some((side, index) =>
				side?.seatId !== record.seatIds[index] || typeof side.side !== "boolean")) return false;
		const red = event.sides.filter(side => side.side).length;
		const blue = event.sides.length - red;
		const firstActor = event.sides.find(side => side.seatId === event.firstActSeatId);
		return red === event.sides.length / 2 && blue === event.sides.length / 2 && firstActor?.side === true;
	}

	function validateAuthorityEvent(record, event) {
		// This dispatch is intentionally event-specific: later native events add a validator
		// instead of weakening the common sequence/digest chain.
		if (event?.kind === "xingbei_side_assignment_v1" && event.name === "initSideAndPosition") {
			// Side assignment is the one pre-character-selection transition.  Accepting
			// it after the probe phase would re-run a semantic initialization event even
			// when its sequence/digest fields look fresh.
			return record.state === "game_ready" && validateXingbeiSideAssignment(record, event);
		}
		return false;
	}

	function commitAuthorityEvent(message) {
		const record = sessions.get(message?.roomId);
		const proof = message?.proof;
		if (message?.type !== "host_authority_event" || !authenticate(record, message) ||
			!['game_ready', 'playable_probe'].includes(record.state) || !proof ||
			proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null ||
			!Number.isSafeInteger(proof.eventSequence) || proof.eventSequence !== record.nextAuthorityEventSequence ||
			!Number.isSafeInteger(proof.stateRevisionBefore) || proof.stateRevisionBefore !== record.authorityStateRevision ||
			!Number.isSafeInteger(proof.stateRevisionAfter) || proof.stateRevisionAfter !== proof.stateRevisionBefore + 1 ||
			!DIGEST.test(proof.beforeDigest) || !DIGEST.test(proof.afterDigest) || proof.beforeDigest === proof.afterDigest ||
			(record.authorityStateDigest !== null && proof.beforeDigest !== record.authorityStateDigest) ||
			!validateAuthorityEvent(record, proof.event)) {
			return failure("HOST_AUTHORITY_EVENT_REJECTED");
		}
		record.authorityStateRevision = proof.stateRevisionAfter;
		record.authorityStateDigest = proof.afterDigest;
		record.nextAuthorityEventSequence++;
		record.lastAuthorityEvent = Object.freeze({ sequence: proof.eventSequence, name: proof.event.name });
		record.state = "playable_probe";
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function markBrowserReady(message) {
		const record = sessions.get(message?.roomId);
		if (message?.type !== "host_browser_ready" || !authenticate(record, message) || record.state !== "starting") {
			return failure("HOST_BROWSER_READY_REJECTED");
		}
		record.state = "browser_ready";
		armPhaseTimer(record, "browser_ready", engineReadyTimeoutMs,
			"HOST_ENGINE_READY_TIMEOUT", "engine_ready_timeout");
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function markEngineReady(message) {
		const record = sessions.get(message?.roomId);
		if (message?.type !== "host_engine_ready" || !authenticate(record, message) || record.state !== "browser_ready") {
			return failure("HOST_ENGINE_READY_REJECTED");
		}
		clearPhaseTimer(record);
		record.state = "engine_ready";
		armPhaseTimer(record, "engine_ready", gameReadyTimeoutMs,
			"HOST_GAME_READY_TIMEOUT", "game_ready_timeout");
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function markGameReady(message) {
		const record = sessions.get(message?.roomId);
		const proof = message?.proof;
		if (message?.type !== "host_game_ready" || !authenticate(record, message) || record.state !== "engine_ready" ||
			!proof || proof.kind !== "pre_game_verification_v1" || proof.setupDigest !== record.setupDigest ||
			!DIGEST.test(proof.preGameSummaryDigest) || proof.checkpoint !== null ||
			!Array.isArray(proof.seatIds) || proof.seatIds.length !== record.seatIds.length ||
			proof.seatIds.some((seatId, index) => seatId !== record.seatIds[index])) {
			return failure("HOST_GAME_READY_REJECTED");
		}
		clearPhaseTimer(record);
		record.preGameSummaryDigest = proof.preGameSummaryDigest;
		record.authorityStateRevision = 0;
		record.authorityStateDigest = null;
		record.nextAuthorityEventSequence = 1;
		record.lastAuthorityEvent = null;
		record.state = "game_ready";
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function commitAuthoritativeResult(message) {
		const record = sessions.get(message?.roomId);
		if (!authenticate(record, message) || !["game_ready", "playable_probe"].includes(record.state)) {
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
		// Result delivery is not a native state transition. Only authenticated native
		// authority events may advance the digest/version chain.
		return Object.freeze({ ok: true, accepted });
	}

	async function stop(roomId, reason = "server_stop") {
		const record = sessions.get(roomId);
		if (!record || !ACTIVE_STATES.has(record.state)) {
			return failure("HOST_SESSION_NOT_ACTIVE");
		}
		clearPhaseTimer(record);
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
		markBrowserReady,
		markEngineReady,
		markGameReady,
		commitAuthorityEvent,
		commitAuthoritativeResult,
		stop,
		inspect: roomId => publicView(sessions.get(roomId)),
	});
}

module.exports = { createHostSessionManager };
