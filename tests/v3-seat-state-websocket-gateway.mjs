import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { createManagedRoomSeatRegistry } = require("../game/server-managed-room-seat-registry.js");
const { createManagedV3SeatStateWebSocketGateway } = require("../game/server-managed-v3-seat-state-websocket-gateway.js");
const { createSeatStateMessage, validateSeatStateMessage } = require("../game/v3-seat-state-protocol.js");

const roomId = "gateway_room";
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
const hostSessionId = `hs_${"a".repeat(32)}`;
const engineBuildId = "b".repeat(64);
const rootInstanceId = `native_root_${"c".repeat(32)}`;

function setupGateway({ beforeSocketWrite = async () => {}, gatewayOptions = {} } = {}) {
	const registry = createManagedRoomSeatRegistry();
	assert.equal(registry.createRoom(roomId, seatIds), true);
	const credentials = new Map(seatIds.map(seatId => [seatId, registry.issueSeat(roomId, seatId).credential]));
	const bindings = new Map();
	const projectionCalls = [];
	const listeners = new Set();
	const manager = {
		inspect(candidateRoom) {
			return candidateRoom === roomId ? { roomId, sessionId: hostSessionId, engineBuildId, pid: 4567,
				state: "playable_probe", authorityStateRevision: 4, nextAuthorityEventSequence: 5, checkpointAvailable: false } : null;
		},
		subscribeLifecycle(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		createV3SeatStateForRequest(candidateRoom, input) {
			const binding = bindings.get(input.recipientSeatId);
			const credential = credentials.get(input.recipientSeatId);
			if (candidateRoom !== roomId || !binding || input.request.connectionId !== binding.connectionId || input.request.credential !== credential ||
				!registry.authenticateSeat({ roomId, seatId: input.recipientSeatId, connectionId: binding.connectionId, credential },
					{ roomId, seatId: input.recipientSeatId })) return { ok: false, code: "SEAT_STATE_SOURCE_REJECTED" };
			projectionCalls.push({ seatId: input.recipientSeatId, sequence: input.stateSequence, generation: binding.connectionGeneration });
			const publicState = { activeSeatId: "seat_b", phase: "xingDong", stateVersion: input.stateSequence,
				players: seatIds.map((seatId, index) => ({ seatId, characterId: `char_${index}`, side: index < 2, handCount: 1 })),
				resources: { hongShiQi: 5, lanShiQi: 4, hongXingBei: 1, lanXingBei: 0, hongBaoShiCount: 0,
					hongShuiJingCount: 0, lanBaoShiCount: 0, lanShuiJingCount: 0 } };
			const created = createSeatStateMessage({ roomId, seatIds, recipientSeatId: input.recipientSeatId,
				connectionGeneration: binding.connectionGeneration, stateSequence: input.stateSequence, stateVersion: input.stateSequence,
				replayFromSequence: input.stateSequence - 1, publicState,
				privateState: { seatId: input.recipientSeatId, handCardViewIds: [`opaque_${input.recipientSeatId}_0123456789`] }, pendingChoice: null });
			return created.ok ? { ok: true, message: created.message } : created;
		},
	};
	const gateway = createManagedV3SeatStateWebSocketGateway({ WebSocketServer: WebSocket.Server, roomId, seatIds,
		hostSessionId, engineBuildId, rootInstanceId, hostPid: 4567, hostSessionManager: manager, seatRegistry: registry,
		bindSeat({ roomId: candidateRoom, seatId, credential, connectionId }) {
			const proof = registry.bindConnection({ roomId: candidateRoom, seatId, credential,
				socket: { kind: "player", roomId: candidateRoom, seatId, connectionId } });
			if (!proof) return null;
			const connectionGeneration = registry.inspect(candidateRoom, seatId).epoch;
			const binding = Object.freeze({ ...proof, connectionGeneration });
			bindings.set(seatId, { connectionId, connectionGeneration });
			return binding;
		},
		disconnectSeat({ roomId: candidateRoom, seatId, connectionId }) {
			registry.disconnect({ roomId: candidateRoom, seatId, connectionId });
			if (bindings.get(seatId)?.connectionId === connectionId) bindings.delete(seatId);
		},
		beforeSocketWrite,
		...gatewayOptions,
	});
	return { registry, credentials, bindings, projectionCalls, manager, gateway, listeners };
}

function onceMessage(socket) {
	return new Promise((resolve, reject) => {
		const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); };
		const timer = setTimeout(() => { cleanup(); reject(new Error("WS_MESSAGE_TIMEOUT")); }, 3000);
		const onClose = () => { cleanup(); reject(new Error("WS_SOCKET_CLOSED")); };
		const onMessage = data => { cleanup(); resolve(JSON.parse(data.toString("utf8"))); };
		socket.on("message", onMessage);
		socket.once("close", onClose);
	});
}

async function waitFor(check, code) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(code);
}

async function connect(url) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
	return socket;
}

async function authenticate(socket, seatId, credential) {
	const response = onceMessage(socket);
	socket.send(JSON.stringify({ type: "seat_auth", roomId, seatId, credential }));
	return response;
}

async function readState(socket, requestId, lastSeenSequence) {
	const response = onceMessage(socket);
	socket.send(JSON.stringify({ type: "state_read", requestId, lastSeenSequence }));
	return response;
}

async function ackState(socket, stateSequence) {
	const response = onceMessage(socket);
	socket.send(JSON.stringify({ type: "state_ack", stateSequence }));
	return response;
}

async function closeSocket(socket) {
	if (socket.readyState === WebSocket.CLOSED) return;
	await new Promise(resolve => { socket.once("close", resolve); try { socket.close(); } catch (_) { resolve(); } });
}

test("loopback seat gateway serves four isolated views and rebinds uniformly without gameplay authority", async t => {
	const fixture = setupGateway();
	t.after(async () => fixture.gateway.close());
	const { url } = await fixture.gateway.listen();
	assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/);
	const clients = new Map();
	t.after(async () => Promise.all([...clients.values()].map(closeSocket)));
	const views = new Map();
	for (const [index, seatId] of seatIds.entries()) {
		const socket = await connect(url); clients.set(seatId, socket);
		const auth = await authenticate(socket, seatId, fixture.credentials.get(seatId));
		assert.deepEqual(auth, { type: "seat_authenticated", roomId, seatId, connectionGeneration: 1 });
		const view = await readState(socket, `initial_${seatId}`, 0);
		assert.equal(validateSeatStateMessage(view, { roomId, seatId, connectionGeneration: 1, seatIds }).ok, true);
		assert.equal(view.stateSequence, 1);
		assert.equal(view.publicState.activeSeatId, "seat_b");
		assert.equal(view.publicState.phase, "xingDong");
		assert.equal(view.privateState.seatId, seatId);
		assert.equal(view.privateState.handCardViewIds.length, 1);
		for (const otherSeat of seatIds.filter(candidate => candidate !== seatId)) {
			assert.equal(JSON.stringify(view).includes(`opaque_${otherSeat}_`), false);
		}
		views.set(seatId, view);
		assert.deepEqual(await ackState(socket, 1), { type: "transport_acknowledged", stateSequence: 1,
			connectionGeneration: 1, duplicate: false });
		assert.equal(index + 1, fixture.projectionCalls.length);
	}
	for (const a of seatIds) for (const b of seatIds) if (a !== b) {
		assert.notDeepEqual(views.get(a).privateState.handCardViewIds, views.get(b).privateState.handCardViewIds);
	}
	const a = clients.get("seat_a"), aView = views.get("seat_a");
	const duplicate = await readState(a, "initial_seat_a", 0);
	assert.deepEqual(duplicate, aView, "same logical request must replay identical bytes and keep its sequence");
	assert.equal(fixture.projectionCalls.filter(call => call.seatId === "seat_a").length, 1);
	assert.deepEqual(await ackState(a, 1), { type: "transport_acknowledged", stateSequence: 1, connectionGeneration: 1, duplicate: true });
	assert.deepEqual(await ackState(a, 1), { type: "transport_acknowledged", stateSequence: 1, connectionGeneration: 1, duplicate: true });
	const rejectedAction = onceMessage(a);
	a.send(JSON.stringify({ type: "choice_submit", choiceId: "fake", optionId: "fake" }));
	assert.deepEqual(await rejectedAction, { type: "gateway_error", code: "GAMEPLAY_TRANSPORT_DISABLED" });
	const rejectedAdmin = await (async () => {
		const socket = await connect(url);
		const response = await authenticate(socket, "seat_a", "e".repeat(64));
		await closeSocket(socket);
		return response;
	})();
	assert.deepEqual(rejectedAdmin, { type: "gateway_error", code: "SEAT_AUTH_REJECTED" });
	assert.equal(fixture.manager.inspect(roomId).authorityStateRevision, 4);
	assert.equal(fixture.manager.inspect(roomId).nextAuthorityEventSequence, 5);
	for (const seatId of seatIds) {
		const old = clients.get(seatId);
		const priorGeneration = fixture.registry.inspect(roomId, seatId).epoch;
		await closeSocket(old);
		await waitFor(() => !fixture.registry.inspect(roomId, seatId).connected, "WS_DISCONNECT_NOT_RECORDED");
		assert.equal(fixture.registry.inspect(roomId, seatId).connected, false);
		const rebound = await connect(url); clients.set(seatId, rebound);
		const auth = await authenticate(rebound, seatId, fixture.credentials.get(seatId));
		assert.deepEqual(auth, { type: "seat_authenticated", roomId, seatId, connectionGeneration: priorGeneration + 1 });
		const fresh = await readState(rebound, `rebound_${seatId}`, 1);
		assert.equal(validateSeatStateMessage(fresh, { roomId, seatId, connectionGeneration: priorGeneration + 1, seatIds }).ok, true);
		assert.equal(fresh.stateSequence, 2);
		assert.equal(fresh.replayFromSequence, 1);
		assert.notDeepEqual(fresh, views.get(seatId), "new generation receives a newly projected envelope, not old-generation bytes");
		assert.equal(fresh.privateState.seatId, seatId);
		assert.equal(fixture.registry.authenticateSeat({ roomId, seatId, connectionId: `stale_${seatId}`,
			credential: fixture.credentials.get(seatId) }, { roomId, seatId }), false);
		assert.equal(fixture.manager.inspect(roomId).sessionId, hostSessionId);
		assert.equal(fixture.manager.inspect(roomId).pid, 4567);
	}
	assert.equal(fixture.gateway.inspect().clientCount, 4);
	assert.ok(fixture.gateway.inspect().bufferedMessages <= seatIds.length * 8);
	for (const socket of clients.values()) await closeSocket(socket);
	await waitFor(() => fixture.gateway.inspect().clientCount === 0, "WS_CLIENT_CLEANUP_TIMEOUT");
	assert.equal(fixture.gateway.inspect().clientCount, 0);
	assert.equal(fixture.gateway.inspect().bufferedMessages, 0, "disconnect clears recipient-private replay bytes");
	assert.ok(seatIds.every(seatId => !fixture.registry.inspect(roomId, seatId).connected));
	assert.equal(fixture.gateway.inspect().closed, false);
});

test("disconnected in-flight private write is fenced and regenerated for the new generation with stable logical sequence", async t => {
	let hold = false;
	let entered;
	const enteredPromise = new Promise(resolve => { entered = resolve; });
	let release;
	const releasePromise = new Promise(resolve => { release = resolve; });
	const fixture = setupGateway({ beforeSocketWrite: async context => {
		if (hold && context.stateSequence === 1) { hold = false; entered(); await releasePromise; }
	} });
	t.after(async () => fixture.gateway.close());
	const { url } = await fixture.gateway.listen();
	const oldSocket = await connect(url);
	assert.equal((await authenticate(oldSocket, "seat_a", fixture.credentials.get("seat_a"))).connectionGeneration, 1);
	hold = true;
	const oldMessagePromise = readState(oldSocket, "held_read", 0).then(value => value, () => null);
	await enteredPromise;
	await closeSocket(oldSocket);
	await waitFor(() => !fixture.registry.inspect(roomId, "seat_a").connected, "WS_DISCONNECT_NOT_RECORDED");
	const newSocket = await connect(url);
	assert.equal((await authenticate(newSocket, "seat_a", fixture.credentials.get("seat_a"))).connectionGeneration, 2);
	const newMessagePromise = readState(newSocket, "recovered_read", 0);
	const fresh = await newMessagePromise;
	assert.equal(fresh.schema, "xingbei_v3_seat_state_v2", JSON.stringify(fresh));
	assert.equal(fresh.connectionGeneration, 2);
	assert.equal(fresh.stateSequence, 1, "same unacknowledged logical state is regenerated with the current generation without advancing its sequence");
	assert.equal(fresh.replayFromSequence, 0);
	release();
	const oldResult = await oldMessagePromise;
	assert.equal(oldResult, null, "stale async write must not deliver private bytes to the old socket after rebind");
	assert.equal(fixture.projectionCalls.filter(call => call.seatId === "seat_a").length, 2);
	assert.equal(fixture.gateway.inspect().clientCount, 1);
	await closeSocket(newSocket);
	await waitFor(() => !fixture.registry.inspect(roomId, "seat_a").connected, "WS_DISCONNECT_NOT_RECORDED");
	assert.equal(fixture.registry.inspect(roomId, "seat_a").connected, false);
	assert.equal(fixture.manager.inspect(roomId).authorityStateRevision, 4);
});

test("HostSession end clears gateway buffers and rejects all further seat projections", async t => {
	const fixture = setupGateway();
	t.after(async () => fixture.gateway.close());
	const { url } = await fixture.gateway.listen();
	const socket = await connect(url);
	assert.equal((await authenticate(socket, "seat_a", fixture.credentials.get("seat_a"))).type, "seat_authenticated");
	assert.equal((await readState(socket, "one", 0)).stateSequence, 1);
	for (const listener of fixture.listeners) listener({ roomId, sessionId: hostSessionId, state: "stopped", code: null, stage: "ended" });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(fixture.gateway.inspect().closed, true);
	assert.equal(fixture.gateway.inspect().clientCount, 0);
	assert.equal(fixture.gateway.inspect().bufferedMessages, 0);
	assert.equal(fixture.registry.inspect(roomId, "seat_a").connected, false);
});

test("gateway enforces bounded unauthenticated connections and closes every peer on stop", async t => {
	const fixture = setupGateway({ gatewayOptions: { maxConnections: 4 } });
	t.after(async () => fixture.gateway.close());
	const { url } = await fixture.gateway.listen();
	const sockets = [];
	t.after(async () => Promise.all(sockets.map(closeSocket)));
	for (let i = 0; i < 4; i++) sockets.push(await connect(url));
	assert.equal(fixture.gateway.inspect().connectionCount, 4);
	const overflow = new WebSocket(url);
	const overflowClose = new Promise(resolve => overflow.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
	const closed = await overflowClose;
	assert.equal(closed.code, 1013);
	assert.equal(fixture.gateway.inspect().connectionCount, 4);
	await fixture.gateway.close();
	assert.equal(fixture.gateway.inspect().connectionCount, 0);
	assert.equal(fixture.gateway.inspect().clientCount, 0);
	assert.equal(fixture.gateway.inspect().bufferedMessages, 0);
});

test("gateway applies deterministic per-socket rate limits and malformed input reveals no private state", async t => {
	let clock = 1000;
	const fixture = setupGateway({ gatewayOptions: { maxMessagesPerWindow: 4, now: () => clock } });
	t.after(async () => fixture.gateway.close());
	const { url } = await fixture.gateway.listen();
	const socket = await connect(url);
	const auth = await authenticate(socket, "seat_a", fixture.credentials.get("seat_a"));
	assert.equal(auth.type, "seat_authenticated");
	const malformed = onceMessage(socket);
	socket.send("{not-json");
	assert.deepEqual(await malformed, { type: "gateway_error", code: "MESSAGE_INVALID" });
	assert.equal(fixture.projectionCalls.length, 0);
	const closed = new Promise(resolve => socket.once("close", code => resolve(code)));
	// Auth and malformed input consumed two entries in the fixed window.
	for (let i = 0; i < 3; i++) socket.send(JSON.stringify({ type: "unknown", privateProbe: "must-not-echo" }));
	assert.equal(await closed, 1008);
	assert.equal(fixture.projectionCalls.length, 0);
	await waitFor(() => fixture.gateway.inspect().clientCount === 0, "WS_RATE_LIMIT_CLEANUP_TIMEOUT");
	assert.equal(fixture.gateway.inspect().clientCount, 0);
	clock += 1000;
	assert.equal(clock, 2000);
});
