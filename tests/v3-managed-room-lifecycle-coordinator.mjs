import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedRoomSeatRegistry } = require("../game/server-managed-room-seat-registry.js");
const { createManagedV3RoomLifecycleCoordinator } = require("../game/server-managed-v3-room-lifecycle-coordinator.js");

const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];

function fixture(overrides = {}) {
	const registry = createManagedRoomSeatRegistry();
	const credentials = new Map(), stopped = [], gatewayClosed = [];
	const hostState = new Map();
	const manager = {
		inspect(roomId) { return hostState.get(roomId) || null; },
		inspectManagedHostTransportContext(roomId) {
			const host = hostState.get(roomId);
			return host?.state === "playable_probe" ? { roomId, hostSessionId: host.sessionId,
				engineBuildId: host.engineBuildId, rootInstanceId: `native_root_${"e".repeat(32)}`,
				hostPid: host.pid, authorityStateRevision: 4, nextAuthorityEventSequence: 5,
				seatIds: [...seatIds], checkpointAvailable: false } : null;
		},
		async stop(roomId, reason) { stopped.push({ roomId, reason }); const state = hostState.get(roomId); if (state) state.state = "stopped"; return { ok: true }; },
		subscribeLifecycle() { return () => {}; },
	};
	const coordinator = createManagedV3RoomLifecycleCoordinator({ hostSessionManager: manager, seatRegistry: registry,
		deliverSeatCredential({ roomId, seatId, credential, role }) {
			assert.equal(role, "ordinary_player"); credentials.set(`${roomId}:${seatId}`, credential);
		},
		async startManagedHost({ roomId, gameSetup }) {
			assert.deepEqual(gameSetup.seats.map(seat => seat.seatId), seatIds);
			const sessionId = `hs_${"a".repeat(32)}`;
			hostState.set(roomId, { roomId, sessionId, engineBuildId: "b".repeat(64), pid: 4321,
				state: "playable_probe", checkpointAvailable: false });
			return { ok: true, session: { sessionId } };
		},
		async createGateway(input) {
			assert.equal(input.creatorIsOrdinaryPlayer, true);
			return { listen: async () => {}, close: async () => { gatewayClosed.push(input.roomId); } };
		},
		cleanupManagedChoices: roomId => { if (overrides.onCleanup) overrides.onCleanup(roomId); },
		...overrides,
	});
	return { coordinator, registry, credentials, stopped, gatewayClosed, hostState };
}

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

test("server-owned lifecycle treats creator as ordinary seat and player disconnect/rebind never stops managed host", async t => {
	const f = fixture(); t.after(() => f.coordinator.close());
	const created = await f.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
	assert.equal(created.ok, true);
	const { roomId } = created.room;
	assert.match(roomId, /^room_[a-f0-9]{32}$/);
	assert.equal(created.room.state, "waiting_for_players");
	assert.deepEqual(created.room.seatIds, seatIds);
	assert.equal(Object.hasOwn(created.room, "credentials"), false);
	assert.equal(JSON.stringify(created.room).includes(f.credentials.get(`${roomId}:seat_b`)), false,
		"the public room descriptor must not expose another seat's credential");
	assert.equal(f.coordinator.joinSeat({ roomId, seatId: "seat_a", credential: f.credentials.get(`${roomId}:seat_a`),
		connectionId: "admin_attempt", principal: { kind: "administrator" } }).code, "V3_SEAT_JOIN_REJECTED");
	assert.equal(f.coordinator.joinSeat({ roomId, seatId: "seat_b", credential: f.credentials.get(`${roomId}:seat_a`),
		connectionId: "cross_seat_attempt", principal: { kind: "ordinary_player" } }).code, "V3_SEAT_JOIN_REJECTED",
		"a valid credential is bound to exactly one immutable seat");
	for (const [index, seatId] of seatIds.entries()) {
		const joined = f.coordinator.joinSeat({ roomId, seatId, credential: f.credentials.get(`${roomId}:${seatId}`),
			connectionId: `socket_${index}`, principal: { kind: "ordinary_player" } });
		assert.equal(joined.ok, true);
	}
	assert.equal(f.coordinator.inspect(roomId).state, "waiting_for_players", "all four connections do not imply player readiness");
	assert.equal(f.coordinator.markSeatReady({ roomId, seatId: "seat_a", credential: "f".repeat(64),
		connectionId: "socket_0", principal: { kind: "ordinary_player" } }).code, "V3_SEAT_READY_REJECTED");
	for (const [index, seatId] of seatIds.entries()) {
		const ready = f.coordinator.markSeatReady({ roomId, seatId, credential: f.credentials.get(`${roomId}:${seatId}`),
			connectionId: `socket_${index}`, principal: { kind: "ordinary_player" } });
		assert.equal(ready.ok, true);
		if (index === 2) assert.equal(ready.room.state, "waiting_for_players");
	}
	assert.equal(f.coordinator.inspect(roomId).state, "ready");
	assert.deepEqual(f.coordinator.inspect(roomId).readySeatIds, seatIds);
	const unready = f.coordinator.markSeatUnready({ roomId, seatId: "seat_d", credential: f.credentials.get(`${roomId}:seat_d`),
		connectionId: "socket_3", principal: { kind: "ordinary_player" } });
	assert.equal(unready.ok, true);
	assert.equal(unready.room.state, "waiting_for_players");
	assert.equal(unready.room.readySeatIds.includes("seat_d"), false);
	assert.equal(f.coordinator.markSeatUnready({ roomId, seatId: "seat_d", credential: f.credentials.get(`${roomId}:seat_a`),
		connectionId: "socket_3", principal: { kind: "ordinary_player" } }).code, "V3_SEAT_UNREADY_REJECTED");
	assert.equal(f.coordinator.markSeatReady({ roomId, seatId: "seat_d", credential: f.credentials.get(`${roomId}:seat_d`),
		connectionId: "socket_3", principal: { kind: "ordinary_player" } }).room.state, "ready");
	assert.equal(f.coordinator.disconnectSeat({ roomId, seatId: "seat_c", connectionId: "socket_2" }).ok, true);
	assert.equal(f.coordinator.inspect(roomId).state, "waiting_for_players");
	assert.equal(f.coordinator.inspect(roomId).readySeatIds.includes("seat_c"), false,
		"disconnect before game start invalidates that ordinary seat's readiness");
	const rejoinedC = f.coordinator.joinSeat({ roomId, seatId: "seat_c", credential: f.credentials.get(`${roomId}:seat_c`),
		connectionId: "socket_c_new", principal: { kind: "ordinary_player" } });
	assert.equal(rejoinedC.ok, true);
	assert.equal(f.registry.inspect(roomId, "seat_c").epoch, 2);
	assert.equal(f.coordinator.markSeatReady({ roomId, seatId: "seat_c", credential: f.credentials.get(`${roomId}:seat_c`),
		connectionId: "socket_2", principal: { kind: "ordinary_player" } }).code, "V3_SEAT_READY_REJECTED");
	assert.equal(f.coordinator.markSeatReady({ roomId, seatId: "seat_c", credential: f.credentials.get(`${roomId}:seat_c`),
		connectionId: "socket_c_new", principal: { kind: "ordinary_player" } }).room.state, "ready");
	const started = await f.coordinator.startRoom({ roomId });
	assert.equal(started.ok, true);
	assert.equal(started.room.state, "running");
	const initialHost = f.coordinator.inspect(roomId);
	const disconnected = f.coordinator.disconnectSeat({ roomId, seatId: "seat_a", connectionId: "socket_0" });
	assert.equal(disconnected.ok, true);
	assert.equal(disconnected.hostUnaffected, true);
	assert.equal(f.coordinator.inspect(roomId).state, "running");
	assert.equal(f.hostState.get(roomId).sessionId, initialHost.hostSessionId);
	assert.equal(f.hostState.get(roomId).pid, initialHost.hostPid);
	assert.deepEqual(f.stopped, [], "ordinary player transport loss cannot stop the managed host");
	const rebound = f.coordinator.joinSeat({ roomId, seatId: "seat_a", credential: f.credentials.get(`${roomId}:seat_a`),
		connectionId: "socket_a_new", principal: { kind: "ordinary_player" } });
	assert.equal(rebound.ok, true);
	assert.equal(f.registry.inspect(roomId, "seat_a").epoch, 2);
	assert.equal(f.registry.authenticateSeat({ roomId, seatId: "seat_a", connectionId: "socket_0",
		credential: f.credentials.get(`${roomId}:seat_a`) }, { roomId, seatId: "seat_a" }), false);
	assert.equal(f.coordinator.inspect(roomId).hostPid, initialHost.hostPid);
	assert.equal(f.coordinator.inspect(roomId).transitions.join(","),
		"created,waiting_for_players,ready,waiting_for_players,ready,waiting_for_players,ready,starting,running");
	const stopped = await f.coordinator.stopRoom(roomId);
	assert.equal(stopped.ok, true);
	assert.equal(stopped.room.state, "closed");
	assert.deepEqual(f.gatewayClosed, [roomId]);
	assert.equal(f.registry.inspect(roomId, "seat_a"), null);
});

test("room lifecycle bounds rooms, isolates parallel rooms and rolls failed credential delivery back", async t => {
	const f = fixture({ maxRooms: 2 }); t.after(() => f.coordinator.close());
	const first = await f.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
	const second = await f.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
	assert.equal(first.ok, true); assert.equal(second.ok, true);
	assert.notEqual(first.room.roomId, second.room.roomId);
	assert.equal((await f.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } })).code, "V3_ROOM_LIMIT_REACHED");
	assert.equal(f.coordinator.inspect(first.room.roomId).state, "waiting_for_players");
	assert.equal(f.coordinator.inspect(second.room.roomId).state, "waiting_for_players");
	const bad = fixture({ deliverSeatCredential: () => { throw new Error("delivery denied"); } });
	t.after(() => bad.coordinator.close());
	const rolledBack = await bad.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
	assert.equal(rolledBack.ok, false);
	assert.equal(rolledBack.code, "V3_ROOM_CREATION_ROLLED_BACK");
	assert.equal(bad.coordinator.inspect(rolledBack.roomId || "room_missing"), null);
});

test("coordinator and gateway share one atomic seat binding; retries are idempotent and stale disconnects are fenced", async t => {
	const bound = [];
	const f = fixture({ onSeatBound(binding) { bound.push(binding); } }); t.after(() => f.coordinator.close());
	const created = await f.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
	const { roomId } = created.room;
	for (const [index, seatId] of seatIds.entries()) {
		assert.equal(f.coordinator.joinSeat({ roomId, seatId, credential: f.credentials.get(`${roomId}:${seatId}`),
			connectionId: `lobby_${index}`, principal: { kind: "ordinary_player" } }).ok, true);
	}
	for (const [index, seatId] of seatIds.entries()) assert.equal(f.coordinator.markSeatReady({ roomId, seatId,
		credential: f.credentials.get(`${roomId}:${seatId}`), connectionId: `lobby_${index}`,
		principal: { kind: "ordinary_player" } }).ok, true);
	assert.equal((await f.coordinator.startRoom({ roomId })).ok, true);
	const oldEpoch = f.registry.inspect(roomId, "seat_a").epoch;
	const gatewayBind = f.coordinator.bindGatewaySeat({ roomId, seatId: "seat_a",
		credential: f.credentials.get(`${roomId}:seat_a`), connectionId: "ws_generation_2" });
	assert.equal(gatewayBind.ok, true);
	assert.equal(f.registry.inspect(roomId, "seat_a").epoch, oldEpoch + 1,
		"replacing a lobby binding with its authenticated socket advances exactly one generation");
	assert.equal(f.coordinator.inspect(roomId).connectedSeatIds.includes("seat_a"), true);
	assert.equal(f.coordinator.disconnectSeat({ roomId, seatId: "seat_a", connectionId: "lobby_0" }).code,
		"V3_SEAT_DISCONNECT_REJECTED", "late close from the old connection must not clear the new binding");
	const duplicate = f.coordinator.bindGatewaySeat({ roomId, seatId: "seat_a",
		credential: f.credentials.get(`${roomId}:seat_a`), connectionId: "ws_generation_2" });
	assert.equal(duplicate.ok, true); assert.equal(duplicate.idempotent, true);
	assert.equal(f.registry.inspect(roomId, "seat_a").epoch, oldEpoch + 1, "same-generation retry must not increment the epoch");
	assert.equal(f.coordinator.bindGatewaySeat({ roomId, seatId: "seat_a", credential: "f".repeat(64),
		connectionId: "ws_forged" }).code, "V3_GATEWAY_SEAT_AUTH_REJECTED");
	assert.equal(f.registry.inspect(roomId, "seat_a").epoch, oldEpoch + 1);
	assert.equal(f.coordinator.disconnectSeat({ roomId, seatId: "seat_a", connectionId: "ws_generation_2" }).ok, true);
	assert.equal(f.coordinator.inspect(roomId).state, "running");
	assert.equal(f.hostState.get(roomId).state, "playable_probe");
	assert.deepEqual(f.stopped, [], "socket loss remains separate from managed-host lifecycle");
	assert.equal(bound.length, 5);
});

test("room close racing a pending host bootstrap stops the late managed session", async t => {
	const entered = deferred(), release = deferred();
	let f;
	f = fixture({ startManagedHost: async ({ roomId }) => {
		entered.resolve();
		await release.promise;
		f.hostState.set(roomId, { roomId, sessionId: `hs_${"c".repeat(32)}`, engineBuildId: "d".repeat(64),
			pid: 5678, state: "playable_probe", checkpointAvailable: false });
		return { ok: true, session: { sessionId: `hs_${"c".repeat(32)}` } };
	} });
	t.after(() => f.coordinator.close());
	const created = await f.coordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
	const roomId = created.room.roomId;
	for (const [index, seatId] of seatIds.entries()) f.coordinator.joinSeat({ roomId, seatId,
		credential: f.credentials.get(`${roomId}:${seatId}`), connectionId: `slow_socket_${index}`,
		principal: { kind: "ordinary_player" } });
	for (const [index, seatId] of seatIds.entries()) f.coordinator.markSeatReady({ roomId, seatId,
		credential: f.credentials.get(`${roomId}:${seatId}`), connectionId: `slow_socket_${index}`,
		principal: { kind: "ordinary_player" } });
	const start = f.coordinator.startRoom({ roomId });
	await entered.promise;
	const closed = await f.coordinator.stopRoom(roomId, "close_during_host_bootstrap");
	assert.equal(closed.ok, true);
	assert.deepEqual(f.stopped, [], "no session existed yet when the room close completed");
	release.resolve();
	const lateStart = await start;
	assert.equal(lateStart.ok, false);
	assert.equal(f.hostState.get(roomId).state, "stopped");
	assert.deepEqual(f.stopped, [{ roomId, reason: "managed_host_start_aborted" }]);
	assert.equal(f.coordinator.inspect(roomId).state, "closed");
	assert.equal(f.registry.inspect(roomId, "seat_a"), null);
});
