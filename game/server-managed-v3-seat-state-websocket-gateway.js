"use strict";

// Isolated, loopback-only V3 seat-state transport. This gateway publishes only
// the HostSession manager's verified seat projection; it has no gameplay,
// choice, native-command, or authority-event handler.
const crypto = require("node:crypto");
const { CAPPED_SCHEMA, validateSeatStateMessage, validateCappedReadOnlySeatState } = require("./v3-seat-state-protocol.js");

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CREDENTIAL = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^hs_[a-f0-9]{32}$/;
const BUILD = /^[a-f0-9]{64}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const MAX_MESSAGE_BYTES = 4096;
const MAX_QUEUE = 16;
const MAX_AUTH_MS = 5000;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 32;
const MESSAGE_WINDOW_MS = 1000;

function reject(code) { return Object.freeze({ ok: false, code }); }
function exact(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
function live(socket) { return socket?.readyState === 1; }
function same(a, b) { return a === b; }

function createManagedV3SeatStateWebSocketGateway({ WebSocketServer, roomId, seatIds, hostSessionId,
	engineBuildId, rootInstanceId, hostPid, hostSessionManager, seatRegistry, bindSeat, disconnectSeat,
	getExperimentalActionCapability = null, getCurrentManagedChoice = null, submitManagedChoice = null,
	beforeSocketWrite = async () => {}, randomBytes = crypto.randomBytes, maxReplayMessages = 8,
	maxMessageBytes = MAX_MESSAGE_BYTES, maxConnections = DEFAULT_MAX_CONNECTIONS,
	maxMessagesPerWindow = DEFAULT_MAX_MESSAGES_PER_WINDOW, now = Date.now } = {}) {
	if (typeof WebSocketServer !== "function" || !ID.test(roomId || "") || !Array.isArray(seatIds) ||
		seatIds.length !== 4 || seatIds.some(seat => !ID.test(seat)) || new Set(seatIds).size !== 4 ||
		!SESSION.test(hostSessionId || "") || !BUILD.test(engineBuildId || "") || !ROOT.test(rootInstanceId || "") ||
		!Number.isSafeInteger(hostPid) || hostPid < 1 || !hostSessionManager ||
		typeof hostSessionManager.createV3SeatStateForRequest !== "function" ||
		typeof hostSessionManager.inspect !== "function" || typeof hostSessionManager.subscribeLifecycle !== "function" ||
		!seatRegistry || typeof seatRegistry.bindConnection !== "function" || typeof seatRegistry.disconnect !== "function" ||
		typeof seatRegistry.authorizeSeatBinding !== "function" || typeof bindSeat !== "function" ||
		typeof disconnectSeat !== "function" || typeof beforeSocketWrite !== "function" || typeof randomBytes !== "function" ||
		(getExperimentalActionCapability !== null && typeof getExperimentalActionCapability !== "function") ||
		(getCurrentManagedChoice !== null && typeof getCurrentManagedChoice !== "function") ||
		(submitManagedChoice !== null && typeof submitManagedChoice !== "function") ||
		((getExperimentalActionCapability || getCurrentManagedChoice || submitManagedChoice) &&
			!(getExperimentalActionCapability && getCurrentManagedChoice && submitManagedChoice)) ||
		!Number.isSafeInteger(maxReplayMessages) || maxReplayMessages < 1 || maxReplayMessages > 32 ||
		!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 512 || maxMessageBytes > 16384 ||
		!Number.isSafeInteger(maxConnections) || maxConnections < 4 || maxConnections > 16 ||
		!Number.isSafeInteger(maxMessagesPerWindow) || maxMessagesPerWindow < 4 || maxMessagesPerWindow > 256 ||
		typeof now !== "function") {
		throw new TypeError("V3_SEAT_STATE_GATEWAY_CONFIG_INVALID");
	}
	const immutableSeats = Object.freeze([...seatIds]);
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: maxMessageBytes, perMessageDeflate: false });
	const clients = new Set();
	const peers = new Set();
	const currentBySeat = new Map();
	const stateBySeat = new Map(immutableSeats.map(seatId => [seatId, {
		lastSequence: 0, lastAcknowledgedSequence: 0, latestUnacknowledged: null, replay: new Map(),
	}]));
	let closed = false;
	let serverListening = false;
	let closePromise = null;
	let unsubscribeSessionEnd = () => {};
	let address = null;

	function hostIsCurrent() {
		const current = hostSessionManager.inspect(roomId);
		if (closed || current?.state !== "playable_probe" || current.roomId !== roomId || current.sessionId !== hostSessionId ||
			current.engineBuildId !== engineBuildId || current.pid !== hostPid || current.checkpointAvailable !== false) return false;
		if (!getExperimentalActionCapability) return current.authorityStateRevision === 4 && current.nextAuthorityEventSequence === 5;
		let capability;
		try { capability = getExperimentalActionCapability(roomId); } catch (_) { return false; }
		return exact(capability, ["schema", "roomId", "hostSessionId", "engineBuildId", "rootInstanceId", "hostPid",
			"authorityRevision", "nextAuthorityEventSequence", "authorityCeiling", "activeSeatId", "captureVerified"]) &&
			capability.schema === "xingbei_v3_managed_action_capability_v1" && capability.roomId === roomId &&
			capability.hostSessionId === hostSessionId && capability.engineBuildId === engineBuildId && capability.rootInstanceId === rootInstanceId &&
			capability.hostPid === hostPid && capability.authorityRevision === current.authorityStateRevision &&
			capability.nextAuthorityEventSequence === current.nextAuthorityEventSequence &&
			Number.isSafeInteger(capability.authorityCeiling) && capability.authorityCeiling >= 5 && capability.authorityCeiling <= 8 &&
			capability.nextAuthorityEventSequence >= 5 && capability.nextAuthorityEventSequence <= capability.authorityCeiling &&
			capability.authorityRevision === capability.nextAuthorityEventSequence - 1 && immutableSeats.includes(capability.activeSeatId) &&
			capability.captureVerified === true;
	}

	function hostSessionIsCurrent() {
		const current = hostSessionManager.inspect(roomId);
		return !closed && current?.state === "playable_probe" && current.roomId === roomId &&
			current.sessionId === hostSessionId && current.engineBuildId === engineBuildId && current.pid === hostPid &&
			current.checkpointAvailable === false;
	}

	function currentChoiceFor(context) {
		if (!getCurrentManagedChoice || !hostIsCurrent()) return null;
		let capability, choice;
		try { capability = getExperimentalActionCapability(roomId); choice = getCurrentManagedChoice({ roomId, hostSessionId,
			eventSequence: capability.nextAuthorityEventSequence, seatId: context.seatId }); } catch (_) { return null; }
		if (!choice || Object.getPrototypeOf(choice) !== Object.prototype ||
			Object.keys(choice).sort().join(",") !== "choiceId,deadlineAt,eventSequence,hostSessionId,nativeEventId,options,roomId,seatId,state" ||
			choice.roomId !== roomId || choice.hostSessionId !== hostSessionId || choice.seatId !== context.seatId ||
			choice.seatId !== capability.activeSeatId || choice.eventSequence !== capability.nextAuthorityEventSequence ||
			choice.state !== "pending" || !/^choice_[A-Za-z0-9_-]{16,64}$/.test(choice.choiceId || "") ||
			!/^native_[A-Za-z0-9_-]{16,96}$/.test(choice.nativeEventId || "") || !Number.isSafeInteger(choice.deadlineAt) ||
			!Array.isArray(choice.options) || choice.options.length < 1 || choice.options.length > 64 ||
			choice.options.some(optionId => !/^native_option_[a-f0-9]{32}$/.test(optionId)) || new Set(choice.options).size !== choice.options.length) return null;
		return choice;
	}

	function send(socket, payload, context = null) {
		return Promise.resolve().then(async () => {
			if (closed || !live(socket)) return false;
			if (context) await beforeSocketWrite(Object.freeze({ roomId, seatId: context.seatId,
				connectionGeneration: context.connectionGeneration, stateSequence: payload.stateSequence || null }));
			// Delivery liveness is separate from action capability. At the Event 8
			// ceiling the host may still authenticate/ACK/read a terminal projection,
			// while every choice/action path continues to require hostIsCurrent().
			const hostValid = hostSessionIsCurrent();
			if (closed || !live(socket) || (context && (currentBySeat.get(context.seatId) !== context || !hostValid))) return false;
			const encoded = JSON.stringify(payload);
			if (Buffer.byteLength(encoded, "utf8") > maxMessageBytes) return false;
			const delivered = await new Promise(resolve => {
				try { socket.send(encoded, error => resolve(!error)); } catch (_) { resolve(false); }
			});
			if (!delivered && live(socket)) { try { socket.close(1011, "send failed"); } catch (_) {} }
			return delivered;
		}).catch(() => {
			if (live(socket)) { try { socket.close(1011, "send failed"); } catch (_) {} }
			return false;
		});
	}

	function sendError(socket, code) {
		return send(socket, Object.freeze({ type: "gateway_error", code }));
	}

	function issueConnectionId() {
		const bytes = randomBytes(18);
		if (!Buffer.isBuffer(bytes) || bytes.length !== 18) return null;
		return `ws_${bytes.toString("hex")}`;
	}

	function clearSeatReplay(seatId) {
		const state = stateBySeat.get(seatId);
		if (!state) return;
		state.replay.clear();
		state.latestUnacknowledged = null;
	}

	function remember(state, requestId, fingerprint, message) {
		state.replay.set(requestId, Object.freeze({ fingerprint, message }));
		while (state.replay.size > maxReplayMessages) {
			const oldest = state.replay.keys().next().value;
			const item = state.replay.get(oldest);
			if (item?.message === state.latestUnacknowledged?.message) break;
			state.replay.delete(oldest);
		}
	}

	async function authenticate(socket, message, onAuthenticated) {
		if (!exact(message, ["type", "roomId", "seatId", "credential"]) || message.type !== "seat_auth" ||
			message.roomId !== roomId || !immutableSeats.includes(message.seatId) || !CREDENTIAL.test(message.credential || "") || !hostSessionIsCurrent()) {
			await sendError(socket, "SEAT_AUTH_REJECTED");
			try { socket.close(1008, "authentication rejected"); } catch (_) {}
			return;
		}
		const connectionId = issueConnectionId();
		if (!connectionId) {
			await sendError(socket, "SEAT_AUTH_REJECTED");
			try { socket.close(1011, "connection unavailable"); } catch (_) {}
			return;
		}
		let binding;
		try { binding = bindSeat({ roomId, seatId: message.seatId, credential: message.credential, connectionId }); } catch (_) { binding = null; }
		const seatRecord = seatRegistry.inspect(roomId, message.seatId);
		if (!binding || Object.getPrototypeOf(binding) !== Object.prototype ||
			!seatRegistry.authorizeSeatBinding(binding) || binding.roomId !== roomId || binding.seatId !== message.seatId ||
			binding.connectionId !== connectionId || !seatRecord?.connected || seatRecord.revoked || !Number.isSafeInteger(seatRecord.epoch) ||
			seatRecord.epoch < 1 || !hostSessionIsCurrent() || !live(socket)) {
			try { if (binding?.connectionId === connectionId) disconnectSeat({ roomId, seatId: message.seatId, connectionId }); } catch (_) {}
			await sendError(socket, "SEAT_AUTH_REJECTED");
			try { socket.close(1008, "authentication rejected"); } catch (_) {}
			return;
		}
		const context = { socket, roomId, seatId: message.seatId, credential: message.credential, connectionId,
			connectionGeneration: seatRecord.epoch, queue: Promise.resolve(), queued: 0, authTimer: null, active: true,
			submissions: new Map() };
		const prior = currentBySeat.get(context.seatId);
		if (prior) {
			// A successful bind above proves that the trusted binding callback has
			// already advanced the Seat Registry to this connection. Supersede the
			// old peer without disconnecting the new generation; its delayed close is
			// fenced by both this map check and the registry's exact connection ID.
			if (prior.connectionId === context.connectionId || !seatRegistry.authorizeSeatBinding(binding)) {
				context.active = false;
				try { disconnectSeat({ roomId, seatId: context.seatId, connectionId }); } catch (_) {}
				await sendError(socket, "SEAT_ALREADY_CONNECTED");
				try { socket.close(1008, "seat already connected"); } catch (_) {}
				return;
			}
			prior.active = false;
			prior.submissions.clear();
			clients.delete(prior);
			currentBySeat.delete(context.seatId);
			try { prior.socket.close(4001, "seat connection replaced"); } catch (_) {}
		}
		currentBySeat.set(context.seatId, context);
		clients.add(context);
		if (context.authTimer) clearTimeout(context.authTimer);
		clearSeatReplay(context.seatId); // a new generation never receives old-generation private bytes
		const state = stateBySeat.get(context.seatId);
		state.lastSequence = state.lastAcknowledgedSequence;
		try { onAuthenticated(context); } catch (_) {}
		await send(socket, Object.freeze({ type: "seat_authenticated", roomId, seatId: context.seatId,
			connectionGeneration: context.connectionGeneration,
			lastAcknowledgedSequence: state.lastAcknowledgedSequence }));
		}

	async function processMessage(context, message) {
		if (!context.active || currentBySeat.get(context.seatId) !== context || !hostSessionIsCurrent()) {
			await sendError(context.socket, "SEAT_CONNECTION_STALE");
			return;
		}
		if (exact(message, ["type", "requestId", "lastSeenSequence"]) && message.type === "state_read" &&
			REQUEST.test(message.requestId || "") && Number.isSafeInteger(message.lastSeenSequence) && message.lastSeenSequence >= 0) {
			const state = stateBySeat.get(context.seatId);
			const fingerprint = `${message.lastSeenSequence}`;
			const prior = state.replay.get(message.requestId);
			if (prior) {
				if (prior.fingerprint !== fingerprint || prior.message.connectionGeneration !== context.connectionGeneration) {
					await sendError(context.socket, "STATE_REQUEST_REPLAY_REJECTED");
					return;
				}
				await send(context.socket, prior.message, context);
				return;
			}
			if (message.lastSeenSequence !== state.lastAcknowledgedSequence) {
				await sendError(context.socket, state.latestUnacknowledged ? "STATE_RESYNC_REQUIRED" : "STATE_REPLAY_CURSOR_REJECTED");
				return;
			}
			if (state.latestUnacknowledged) {
				if (state.latestUnacknowledged.connectionGeneration !== context.connectionGeneration) {
					state.latestUnacknowledged = null;
				} else if (state.latestUnacknowledged.message.replayFromSequence !== message.lastSeenSequence) {
					await sendError(context.socket, "STATE_RESYNC_REQUIRED");
					return;
				} else {
					remember(state, message.requestId, fingerprint, state.latestUnacknowledged.message);
					await send(context.socket, state.latestUnacknowledged.message, context);
					return;
				}
			}
			let hostBefore;
			try { hostBefore = hostSessionManager.inspect(roomId); } catch (_) { hostBefore = null; }
			if (!hostSessionIsCurrent() || hostBefore?.sessionId !== hostSessionId) {
				await sendError(context.socket, "HOST_SESSION_UNAVAILABLE");
				return;
			}
			let projected;
			const projectionMethod = hostIsCurrent() ? hostSessionManager.createV3SeatStateForRequest :
				hostSessionManager.createV3CappedReadOnlySeatStateForRequest;
			try { projected = typeof projectionMethod === "function" ? projectionMethod.call(hostSessionManager, roomId, {
				recipientSeatId: context.seatId, request: { connectionId: context.connectionId, credential: context.credential },
				stateSequence: state.lastAcknowledgedSequence + 1,
			}) : null; } catch (_) { projected = null; }
			let hostAfter;
			try { hostAfter = hostSessionManager.inspect(roomId); } catch (_) { hostAfter = null; }
			const capped = projected?.message?.schema === CAPPED_SCHEMA;
			if (!projected?.ok || !(capped ? hostSessionIsCurrent() : hostIsCurrent()) || hostAfter?.sessionId !== hostSessionId ||
				currentBySeat.get(context.seatId) !== context || !context.active) {
				await sendError(context.socket, projected?.code || "SEAT_STATE_UNAVAILABLE");
				return;
			}
			const checked = capped ? validateCappedReadOnlySeatState(projected.message, { roomId, seatId: context.seatId,
				connectionGeneration: context.connectionGeneration }) : validateSeatStateMessage(projected.message, { roomId, seatId: context.seatId,
				connectionGeneration: context.connectionGeneration, seatIds: immutableSeats });
			if (!checked.ok || projected.message.stateSequence !== state.lastSequence + 1 ||
				projected.message.replayFromSequence !== state.lastSequence || state.lastSequence !== state.lastAcknowledgedSequence) {
				await sendError(context.socket, "SEAT_STATE_SEQUENCE_REJECTED");
				return;
			}
			state.lastSequence = projected.message.stateSequence;
			state.latestUnacknowledged = Object.freeze({ connectionGeneration: context.connectionGeneration, message: projected.message });
			remember(state, message.requestId, fingerprint, projected.message);
			await send(context.socket, projected.message, context);
			return;
		}
		if (exact(message, ["type", "stateSequence"]) && message.type === "state_ack" &&
			Number.isSafeInteger(message.stateSequence) && message.stateSequence > 0) {
			const state = stateBySeat.get(context.seatId);
			if (message.stateSequence === state.lastAcknowledgedSequence) {
				await send(context.socket, Object.freeze({ type: "transport_acknowledged", stateSequence: message.stateSequence,
					connectionGeneration: context.connectionGeneration, duplicate: true }), context);
				return;
			}
			if (!state.latestUnacknowledged || state.latestUnacknowledged.connectionGeneration !== context.connectionGeneration ||
				state.latestUnacknowledged.message.stateSequence !== message.stateSequence) {
				await sendError(context.socket, "STATE_ACK_REJECTED");
				return;
			}
			state.lastAcknowledgedSequence = message.stateSequence;
			state.latestUnacknowledged = null;
			await send(context.socket, Object.freeze({ type: "transport_acknowledged", stateSequence: message.stateSequence,
				connectionGeneration: context.connectionGeneration, duplicate: false }), context);
			return;
		}
		if (exact(message, ["type", "requestId"]) && message.type === "choice_read" && REQUEST.test(message.requestId || "")) {
			const choice = currentChoiceFor(context);
			if (!choice) {
				await send(context.socket, Object.freeze({ type: "managed_choice_unavailable", requestId: message.requestId }), context);
				return;
			}
			await send(context.socket, Object.freeze({ type: "managed_choice", requestId: message.requestId, roomId,
				seatId: context.seatId, choiceId: choice.choiceId, eventSequence: choice.eventSequence,
				deadlineAt: choice.deadlineAt, optionIds: Object.freeze([...choice.options]) }), context);
			return;
		}
		if (exact(message, ["type", "requestId", "choiceId", "optionId"]) && message.type === "choice_submit" &&
			REQUEST.test(message.requestId || "") && /^choice_[A-Za-z0-9_-]{16,64}$/.test(message.choiceId || "") &&
			/^native_option_[a-f0-9]{32}$/.test(message.optionId || "")) {
			const fingerprint = `${message.choiceId}\0${message.optionId}`;
			const prior = context.submissions.get(message.requestId);
			if (prior) {
				if (prior.fingerprint !== fingerprint) {
					await sendError(context.socket, "MANAGED_CHOICE_REQUEST_REPLAY_REJECTED");
					return;
				}
				await send(context.socket, Object.freeze({ ...prior.ack, duplicate: true }), context);
				return;
			}
			const choice = currentChoiceFor(context);
			if (!choice || choice.choiceId !== message.choiceId || !choice.options.includes(message.optionId)) {
				await sendError(context.socket, "MANAGED_CHOICE_SUBMISSION_REJECTED");
				return;
			}
			let result;
			try { result = await submitManagedChoice({ protocol: 1, roomId, hostSessionId,
				nativeEventId: choice.nativeEventId, seatId: context.seatId, eventSequence: choice.eventSequence,
				choiceId: choice.choiceId, option: message.optionId, connectionId: context.connectionId,
				connectionGeneration: context.connectionGeneration, credential: context.credential }); } catch (_) { result = null; }
			const accepted = result?.ok === true;
			const ack = Object.freeze({ type: "choice_submission_ack", requestId: message.requestId,
				choiceId: choice.choiceId, accepted, stage: "controller", duplicate: false });
			if (accepted) {
				context.submissions.set(message.requestId, Object.freeze({ fingerprint, ack }));
				while (context.submissions.size > 8) context.submissions.delete(context.submissions.keys().next().value);
			}
			await send(context.socket, ack, context);
			return;
		}
		await sendError(context.socket, "GAMEPLAY_TRANSPORT_DISABLED");
	}

	function onConnection(socket) {
		if (closed) { try { socket.close(1012, "gateway stopped"); } catch (_) {} return; }
		if (peers.size >= maxConnections) { try { socket.close(1013, "connection limit"); } catch (_) {} return; }
		let initialTime;
		try { initialTime = now(); } catch (_) { try { socket.close(1011, "gateway unavailable"); } catch (_) {} return; }
		if (!Number.isFinite(initialTime)) { try { socket.close(1011, "gateway unavailable"); } catch (_) {} return; }
		const peer = { socket, authTimer: null, context: null, authPending: false,
			windowStartedAt: initialTime, messagesInWindow: 0 };
		peers.add(peer);
		peer.authTimer = setTimeout(() => {
			if (!peer.context) { void sendError(socket, "SEAT_AUTH_TIMEOUT"); try { socket.close(1008, "authentication timeout"); } catch (_) {} }
		}, MAX_AUTH_MS);
		if (peer.authTimer.unref) peer.authTimer.unref();
		socket.on("message", data => {
			const time = now();
			if (!Number.isFinite(time)) { try { socket.close(1011, "gateway unavailable"); } catch (_) {} return; }
			if (time - peer.windowStartedAt >= MESSAGE_WINDOW_MS || time < peer.windowStartedAt) {
				peer.windowStartedAt = time;
				peer.messagesInWindow = 0;
			}
			if (++peer.messagesInWindow > maxMessagesPerWindow) {
				try { socket.close(1008, "message rate limit"); } catch (_) {}
				return;
			}
			const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
			if (size > maxMessageBytes) { try { socket.close(1009, "message too large"); } catch (_) {} return; }
			let message;
			try {
				if (Buffer.isBuffer(data)) message = JSON.parse(data.toString("utf8"));
				else message = JSON.parse(String(data));
			} catch (_) { void sendError(socket, "MESSAGE_INVALID"); return; }
			if (!peer.context) {
				if (peer.authPending) { void sendError(socket, "SEAT_AUTH_REJECTED"); return; }
				peer.authPending = true;
				void authenticate(socket, message, context => {
					peer.context = context;
					clearTimeout(peer.authTimer);
				}).catch(() => {
					void sendError(socket, "SEAT_AUTH_REJECTED");
					try { socket.close(1008, "authentication rejected"); } catch (_) {}
				}).finally(() => { peer.authPending = false; });
				return;
			}
			const context = peer.context;
			if (++context.queued > MAX_QUEUE) { try { socket.close(1008, "message queue full"); } catch (_) {} return; }
			context.queue = context.queue.then(() => processMessage(context, message)).catch(() => sendError(socket, "MESSAGE_REJECTED"))
				.finally(() => { context.queued = Math.max(0, context.queued - 1); });
		});
		socket.once("close", () => {
			clearTimeout(peer.authTimer);
			peers.delete(peer);
			const context = peer.context || [...clients].find(item => item.socket === socket);
			if (!context) return;
			context.active = false;
			if (currentBySeat.get(context.seatId) === context) {
				currentBySeat.delete(context.seatId);
				try { disconnectSeat({ roomId, seatId: context.seatId, connectionId: context.connectionId }); } catch (_) {}
				clearSeatReplay(context.seatId);
				const state = stateBySeat.get(context.seatId);
				if (state) state.lastSequence = state.lastAcknowledgedSequence;
			}
			clients.delete(context);
			context.submissions.clear();
		});
		socket.once("error", () => {});
	}

	server.on("connection", onConnection);
	const listening = new Promise((resolve, rejectListening) => {
		server.once("listening", () => {
			serverListening = true;
			address = server.address();
			if (!address || address.address !== "127.0.0.1" || address.family !== "IPv4" || address.port < 1) {
				close().finally(() => rejectListening(new Error("V3_SEAT_STATE_GATEWAY_BIND_REJECTED")));
				return;
			}
			resolve();
		});
		server.once("error", rejectListening);
	});
	server.on("listening", () => {
		try {
			unsubscribeSessionEnd = hostSessionManager.subscribeLifecycle(event => {
				if (event?.roomId === roomId && event.sessionId === hostSessionId &&
					(event.stage === "stopping" || event.stage === "ended")) void close();
			});
		} catch (_) { void close(); }
	});

	async function close() {
		if (closePromise) return closePromise;
		closed = true;
		try { unsubscribeSessionEnd(); } catch (_) {}
		unsubscribeSessionEnd = () => {};
		for (const state of stateBySeat.values()) { state.replay.clear(); state.latestUnacknowledged = null; }
		const socketClosures = [];
		for (const context of clients) {
			context.active = false;
			try { disconnectSeat({ roomId, seatId: context.seatId, connectionId: context.connectionId }); } catch (_) {}
			if (context.socket.readyState !== 3) socketClosures.push(new Promise(resolve => context.socket.once("close", resolve)));
			try { context.socket.terminate(); } catch (_) {}
		}
		for (const peer of peers) {
			clearTimeout(peer.authTimer);
			if (peer.context) peer.context.active = false;
			try { peer.socket.terminate(); } catch (_) {}
		}
		peers.clear();
		clients.clear(); currentBySeat.clear(); stateBySeat.clear();
		closePromise = Promise.all(socketClosures).then(() => new Promise(resolve => {
			try {
				server.close(() => resolve());
				if (!serverListening) resolve();
			} catch (_) { resolve(); }
		}));
		return closePromise;
	}

	return Object.freeze({
		listen: async () => { await listening; return Object.freeze({ host: "127.0.0.1", port: address.port,
			url: `ws://127.0.0.1:${address.port}` }); },
		close,
		inspect: () => Object.freeze({ closed, roomId, hostSessionId, clientCount: clients.size,
			connectionCount: peers.size, maxConnections, maxMessagesPerWindow,
			bufferedMessages: [...stateBySeat.values()].reduce((sum, state) => sum + state.replay.size, 0),
			seats: Object.freeze([...stateBySeat].map(([seatId, state]) => Object.freeze({ seatId,
				lastSequence: state.lastSequence, lastAcknowledgedSequence: state.lastAcknowledgedSequence,
				replayEntries: state.replay.size }))) }),
	});
}

module.exports = { createManagedV3SeatStateWebSocketGateway };
