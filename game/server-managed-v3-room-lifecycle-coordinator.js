"use strict";

// Isolated V3 server-owned room lifecycle coordinator. This is not wired to
// production HALL or server.js; it composes injected managed-host/gateway
// adapters and the managed Seat Registry for test/integration use only.
const crypto = require("node:crypto");

const SEATS = Object.freeze(["seat_a", "seat_b", "seat_c", "seat_d"]);
const ROOM = /^room_[a-f0-9]{32}$/;
const CONNECTION = /^[A-Za-z0-9_-]{1,128}$/;
const LIFE = new Set(["created", "waiting_for_players", "ready", "starting", "running", "stopping", "closed", "failed"]);

function fail(code) { return Object.freeze({ ok: false, code }); }
function exact(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}

function createManagedV3RoomLifecycleCoordinator({ hostSessionManager, seatRegistry, startManagedHost,
	createGateway, cleanupManagedChoices = () => {}, deliverSeatCredential, onSeatBound = () => {}, randomBytes = crypto.randomBytes,
	maxRooms = 32 } = {}) {
	if (!hostSessionManager || typeof hostSessionManager.inspect !== "function" ||
		typeof hostSessionManager.stop !== "function" || !seatRegistry ||
		typeof seatRegistry.createRoom !== "function" || typeof seatRegistry.issueSeat !== "function" ||
		typeof seatRegistry.bindConnection !== "function" || typeof seatRegistry.disconnect !== "function" ||
		typeof seatRegistry.clearRoom !== "function" || typeof startManagedHost !== "function" ||
		typeof createGateway !== "function" || typeof cleanupManagedChoices !== "function" ||
		typeof deliverSeatCredential !== "function" || typeof onSeatBound !== "function" || typeof randomBytes !== "function" ||
		!Number.isSafeInteger(maxRooms) || maxRooms < 1 || maxRooms > 256) throw new TypeError("V3_ROOM_LIFECYCLE_CONFIG_INVALID");
	const rooms = new Map();
	let stopped = false, unsubscribeLifecycle = () => {};

	function transition(record, next) {
		if (!LIFE.has(next)) throw new TypeError("V3_ROOM_LIFECYCLE_STATE_INVALID");
		const allowed = {
			created: ["waiting_for_players", "failed", "stopping"],
			waiting_for_players: ["ready", "stopping", "failed"],
			ready: ["waiting_for_players", "starting", "stopping", "failed"],
			starting: ["running", "stopping", "failed"],
			running: ["stopping", "failed"], stopping: ["closed", "failed"], closed: [], failed: ["stopping", "closed"],
		};
		if (record.state !== next && !allowed[record.state].includes(next)) throw new TypeError("V3_ROOM_LIFECYCLE_TRANSITION_REJECTED");
		if (record.state !== next) { record.state = next; record.transitions.push(next); }
	}
	function publicRoom(record) {
		return Object.freeze({ roomId: record.roomId, state: record.state, config: record.config,
			seatIds: SEATS, connectedSeatIds: Object.freeze(SEATS.filter(id => record.connections.has(id))),
			readySeatIds: Object.freeze(SEATS.filter(id => record.readySeats.has(id))),
			hostSessionId: record.hostSessionId, hostPid: record.hostPid, gameTerminal: false,
			checkpointAvailable: false });
	}
	function validRoomId() {
		const bytes = randomBytes(16);
		if (!Buffer.isBuffer(bytes) || bytes.length !== 16) return null;
		return `room_${bytes.toString("hex")}`;
	}
	function activeHost(record) {
		const host = hostSessionManager.inspect(record.roomId);
		return Boolean(host && host.roomId === record.roomId && host.state === "playable_probe" &&
			typeof host.sessionId === "string" && Number.isSafeInteger(host.pid) && host.pid > 0 &&
		host.checkpointAvailable === false);
	}
	async function disposeResources(record, reason, { stopHost = true } = {}) {
		const gateway = record.gateway; record.gateway = null;
		try { await gateway?.close?.(); } catch (_) {}
		try { cleanupManagedChoices(record.roomId, record.hostSessionId); } catch (_) {}
		if (stopHost && record.hostSessionId) {
			const current = hostSessionManager.inspect(record.roomId);
			if (current?.sessionId === record.hostSessionId && ["starting", "browser_ready", "engine_ready", "game_ready", "playable_probe"].includes(current.state)) {
				try { await hostSessionManager.stop(record.roomId, reason); } catch (_) {}
			}
		}
		for (const [seatId, connectionId] of record.connections) {
			try { seatRegistry.disconnect({ roomId: record.roomId, seatId, connectionId }); } catch (_) {}
		}
		record.connections.clear();
		try { seatRegistry.clearRoom(record.roomId); } catch (_) {}
	}
	async function failRoom(record, code, reason = "room_lifecycle_failed") {
		if (record.state !== "failed" && record.state !== "closed") transition(record, "failed");
		record.failureCode = /^[A-Z0-9_]{3,96}$/.test(code || "") ? code : "V3_ROOM_LIFECYCLE_FAILED";
		record.generation++;
		await disposeResources(record, reason);
		return fail(record.failureCode);
	}

	async function onHostLifecycle(event) {
		const record = rooms.get(event?.roomId);
		if (!record || record.hostSessionId !== event.sessionId || record.state === "stopping" || record.state === "closed") return;
		if (event.stage === "ended" && ["failed", "stopped"].includes(event.state)) {
			if (event.state === "failed") await failRoom(record, event.code || "MANAGED_HOST_FAILED", "managed_host_failed");
			else {
				transition(record, "stopping");
				await disposeResources(record, "managed_host_stopped", { stopHost: false });
				transition(record, "closed");
			}
		}
	}
	if (typeof hostSessionManager.subscribeLifecycle === "function") {
		unsubscribeLifecycle = hostSessionManager.subscribeLifecycle(event => { void onHostLifecycle(event); });
	}

	async function createRoom({ config } = {}) {
		if (stopped) return fail("V3_ROOM_COORDINATOR_STOPPED");
		if (rooms.size >= maxRooms) return fail("V3_ROOM_LIMIT_REACHED");
		if (!exact(config, ["mode", "playerCount"]) || config.mode !== "xingBei" || config.playerCount !== 4)
			return fail("V3_ROOM_CONFIG_REJECTED");
		const roomId = validRoomId();
		if (!roomId || rooms.has(roomId)) return fail("V3_ROOM_ID_UNAVAILABLE");
		const record = { roomId, config: Object.freeze({ mode: "xingBei", playerCount: 4 }), state: "created",
			transitions: ["created"], connections: new Map(), bindings: new Map(), readySeats: new Set(), hostSessionId: null, hostPid: null, gateway: null,
			failureCode: null, generation: 1, startPromise: null, createdAt: Date.now() };
		if (!seatRegistry.createRoom(roomId, SEATS)) return fail("V3_ROOM_SEAT_REGISTRY_REJECTED");
		rooms.set(roomId, record);
		try {
			for (const seatId of SEATS) {
				const issued = seatRegistry.issueSeat(roomId, seatId);
				if (!issued || issued.roomId !== roomId || issued.seatId !== seatId || !/^[a-f0-9]{64}$/.test(issued.credential || ""))
					throw new Error("V3_SEAT_CREDENTIAL_ISSUE_FAILED");
				await deliverSeatCredential(Object.freeze({ roomId, seatId, credential: issued.credential,
					role: "ordinary_player" }));
			}
			transition(record, "waiting_for_players");
			return Object.freeze({ ok: true, room: publicRoom(record) });
		} catch (_) {
			rooms.delete(roomId);
			try { seatRegistry.clearRoom(roomId); } catch (_) {}
			return fail("V3_ROOM_CREATION_ROLLED_BACK");
		}
	}

	function bindSeatConnection(input, { gateway = false } = {}) {
		const code = gateway ? "V3_GATEWAY_SEAT_AUTH_REJECTED" : "V3_SEAT_JOIN_REJECTED";
		const allowedStates = gateway ? ["running"] : ["waiting_for_players", "ready", "starting", "running"];
		if (stopped || !exact(input, ["roomId", "seatId", "credential", "connectionId", ...(gateway ? [] : ["principal"]) ])) return fail(code);
		const record = rooms.get(input.roomId);
		if (!record || !allowedStates.includes(record.state) || !SEATS.includes(input.seatId) ||
			!/^[a-f0-9]{64}$/.test(input.credential || "") || !CONNECTION.test(input.connectionId || "") ||
			(!gateway && (!exact(input.principal, ["kind"]) || input.principal.kind !== "ordinary_player")) ||
			typeof seatRegistry.verifySeatCredential !== "function" ||
			!seatRegistry.verifySeatCredential({ roomId: input.roomId, seatId: input.seatId, credential: input.credential })) return fail(code);
		const current = record.connections.get(input.seatId);
		if (current === input.connectionId) {
			const existing = record.bindings.get(input.seatId);
			if (existing && seatRegistry.authorizeSeatBinding(existing)) return Object.freeze({ ok: true, binding: existing,
				room: publicRoom(record), seatId: input.seatId, idempotent: true });
			return fail(code);
		}
		if (record.state === "starting") return fail(code); // startup permits only idempotent confirmation of an existing seat binding
		// One synchronous coordinator-owned critical section fences the old socket
		// before creating exactly one new Seat Registry generation. A delayed close
		// for the old connection cannot clear this binding.
		if (current) {
			if (!seatRegistry.disconnect({ roomId: record.roomId, seatId: input.seatId, connectionId: current })) return fail(code);
			record.connections.delete(input.seatId);
			record.bindings.delete(input.seatId);
			if (!gateway && record.state === "ready") record.readySeats.delete(input.seatId);
		}
		const binding = seatRegistry.bindConnection({ roomId: input.roomId, seatId: input.seatId, credential: input.credential,
			socket: { kind: "player", roomId: input.roomId, seatId: input.seatId, connectionId: input.connectionId } });
		if (!binding || binding.roomId !== record.roomId || binding.seatId !== input.seatId || binding.connectionId !== input.connectionId)
			return fail(code);
		record.connections.set(input.seatId, input.connectionId);
		record.bindings.set(input.seatId, binding);
		try { onSeatBound(binding); } catch (_) {
			seatRegistry.disconnect({ roomId: input.roomId, seatId: input.seatId, connectionId: input.connectionId });
			record.connections.delete(input.seatId); record.bindings.delete(input.seatId);
			return fail(code);
		}
		if (record.state === "ready") transition(record, "waiting_for_players");
		return Object.freeze({ ok: true, binding, room: publicRoom(record), seatId: input.seatId });
	}
	function joinSeat(input) { return bindSeatConnection(input); }
	function bindGatewaySeat(input) { return bindSeatConnection(input, { gateway: true }); }

	function markSeatReady(input) {
		if (stopped || !exact(input, ["roomId", "seatId", "credential", "connectionId", "principal"])) return fail("V3_SEAT_READY_REJECTED");
		const record = rooms.get(input.roomId);
		if (!record || record.state !== "waiting_for_players" || !SEATS.includes(input.seatId) ||
			record.connections.get(input.seatId) !== input.connectionId || !/^[a-f0-9]{64}$/.test(input.credential || "") ||
			!CONNECTION.test(input.connectionId || "") || !exact(input.principal, ["kind"]) || input.principal.kind !== "ordinary_player" ||
			!seatRegistry.authenticateSeat({ roomId: input.roomId, seatId: input.seatId, connectionId: input.connectionId,
				credential: input.credential }, { roomId: input.roomId, seatId: input.seatId })) return fail("V3_SEAT_READY_REJECTED");
		record.readySeats.add(input.seatId);
		if (record.connections.size === SEATS.length && record.readySeats.size === SEATS.length) transition(record, "ready");
		return Object.freeze({ ok: true, room: publicRoom(record), seatId: input.seatId });
	}

	function markSeatUnready(input) {
		if (stopped || !exact(input, ["roomId", "seatId", "credential", "connectionId", "principal"]))
			return fail("V3_SEAT_UNREADY_REJECTED");
		const record = rooms.get(input.roomId);
		if (!record || !["waiting_for_players", "ready"].includes(record.state) || !SEATS.includes(input.seatId) ||
			record.connections.get(input.seatId) !== input.connectionId || !/^[a-f0-9]{64}$/.test(input.credential || "") ||
			!CONNECTION.test(input.connectionId || "") || !exact(input.principal, ["kind"]) || input.principal.kind !== "ordinary_player" ||
			!seatRegistry.authenticateSeat({ roomId: input.roomId, seatId: input.seatId, connectionId: input.connectionId,
				credential: input.credential }, { roomId: input.roomId, seatId: input.seatId })) return fail("V3_SEAT_UNREADY_REJECTED");
		record.readySeats.delete(input.seatId);
		if (record.state === "ready") transition(record, "waiting_for_players");
		return Object.freeze({ ok: true, room: publicRoom(record), seatId: input.seatId });
	}

	function disconnectSeat({ roomId, seatId, connectionId } = {}) {
		const record = rooms.get(roomId);
		if (!record || !SEATS.includes(seatId) || record.connections.get(seatId) !== connectionId ||
			!seatRegistry.disconnect({ roomId, seatId, connectionId })) return fail("V3_SEAT_DISCONNECT_REJECTED");
		record.connections.delete(seatId);
		record.bindings.delete(seatId);
		record.readySeats.delete(seatId);
		if (record.state === "ready") transition(record, "waiting_for_players");
		// A player transport loss never changes room/HostSession lifecycle.
		return Object.freeze({ ok: true, room: publicRoom(record), hostUnaffected: true });
	}

	async function startRoom({ roomId } = {}) {
		const record = rooms.get(roomId);
		if (stopped || !record || record.state !== "ready" || record.startPromise) return fail("V3_ROOM_NOT_READY");
		transition(record, "starting");
		const generation = record.generation;
		record.startPromise = (async () => {
			try {
				const started = await startManagedHost({ roomId, gameSetup: { mode: "xingBei",
					config: { playerCount: 4 }, seats: SEATS.map((seatId, position) => ({ seatId, position })) } });
				// A close may race a slow host bootstrap. Adopt the exact session as
				// soon as the start call returns so the stale-generation path can stop
				// a partially or fully created child instead of orphaning it.
				const startedSessionId = started?.session?.sessionId || started?.hostSessionId || null;
				if (startedSessionId) record.hostSessionId = startedSessionId;
				if (!started?.ok || generation !== record.generation || record.state !== "starting")
					return failRoom(record, started?.code || "V3_ROOM_START_ABORTED", "managed_host_start_aborted");
				const current = hostSessionManager.inspect(roomId);
				if (!record.hostSessionId || current?.sessionId !== record.hostSessionId || !activeHost(record))
					return failRoom(record, "V3_MANAGED_HOST_NOT_READY");
				record.hostPid = current.pid;
				const transport = typeof hostSessionManager.inspectManagedHostTransportContext === "function"
					? hostSessionManager.inspectManagedHostTransportContext(roomId) : null;
				if (!transport || transport.roomId !== roomId || transport.hostSessionId !== record.hostSessionId ||
					transport.hostPid !== current.pid || transport.engineBuildId !== current.engineBuildId ||
					transport.checkpointAvailable !== false || !Number.isSafeInteger(transport.authorityStateRevision) ||
					transport.authorityStateRevision < 1 ||
					!Array.isArray(transport.seatIds) || transport.seatIds.length !== SEATS.length ||
					transport.seatIds.some((seatId, index) => seatId !== SEATS[index]))
					return failRoom(record, "V3_MANAGED_HOST_TRANSPORT_IDENTITY_REJECTED");
				const gateway = await createGateway({ roomId, hostSessionId: record.hostSessionId,
					seatIds: SEATS, engineBuildId: current.engineBuildId, rootInstanceId: transport.rootInstanceId,
					hostPid: current.pid, authorityStateRevision: transport.authorityStateRevision,
					nextAuthorityEventSequence: transport.nextAuthorityEventSequence,
					bindSeat: bindGatewaySeat, disconnectSeat,
					seatRegistry, creatorIsOrdinaryPlayer: true });
				if (!gateway || typeof gateway.close !== "function" || generation !== record.generation || record.state !== "starting") {
					try { await gateway?.close?.(); } catch (_) {}
					return failRoom(record, "V3_ROOM_GATEWAY_UNAVAILABLE");
				}
				record.gateway = gateway;
				if (typeof gateway.listen === "function") await gateway.listen();
				if (generation !== record.generation || record.state !== "starting" || !activeHost(record))
					return failRoom(record, "V3_ROOM_START_STALE");
				transition(record, "running");
				return Object.freeze({ ok: true, room: publicRoom(record) });
			} catch (_) {
				// startManagedHost can fail after registering its session. Recover only
				// the manager-owned session for this exact room; never infer a session
				// from caller-supplied data.
				try {
					const current = hostSessionManager.inspect(roomId);
					if (current?.roomId === roomId && typeof current.sessionId === "string") record.hostSessionId = current.sessionId;
				} catch (_) {}
				return failRoom(record, "V3_ROOM_START_FAILED");
			}
			finally { record.startPromise = null; }
		})();
		return record.startPromise;
	}

	async function stopRoom(roomId, reason = "server_room_close") {
		const record = rooms.get(roomId);
		if (!record) return fail("V3_ROOM_NOT_FOUND");
		if (record.state === "closed") return Object.freeze({ ok: true, room: publicRoom(record), idempotent: true });
		if (record.state !== "stopping") transition(record, "stopping");
		record.generation++;
		await disposeResources(record, reason);
		if (record.state === "stopping") transition(record, "closed");
		return Object.freeze({ ok: record.state === "closed", code: record.state === "closed" ? "V3_ROOM_CLOSED" : "V3_ROOM_CLEANUP_FAILED",
			room: publicRoom(record) });
	}

	function inspect(roomId) {
		const record = rooms.get(roomId);
		return record ? Object.freeze({ ...publicRoom(record), transitions: Object.freeze([...record.transitions]),
			failureCode: record.failureCode }) : null;
	}
	async function close() {
		if (stopped) return;
		stopped = true;
		try { unsubscribeLifecycle(); } catch (_) {}
		await Promise.all([...rooms.keys()].map(roomId => stopRoom(roomId, "coordinator_shutdown")));
	}
	return Object.freeze({ createRoom, joinSeat, bindGatewaySeat, markSeatReady, markSeatUnready, disconnectSeat, startRoom, stopRoom, inspect, close });
}

module.exports = { createManagedV3RoomLifecycleCoordinator };
