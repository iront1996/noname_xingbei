import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { createManagedRoomSeatRegistry } = require("../game/server-managed-room-seat-registry.js");
const { createManagedV3SeatStateWebSocketGateway } = require("../game/server-managed-v3-seat-state-websocket-gateway.js");
const { createSeatStateMessage, validateSeatStateMessage, createCappedReadOnlySeatState, createManagedChoiceDisplay } = require("../game/v3-seat-state-protocol.js");

const roomId = "gateway_room";
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
const hostSessionId = `hs_${"a".repeat(32)}`;
const engineBuildId = "b".repeat(64);
const rootInstanceId = `native_root_${"c".repeat(32)}`;

function setupGateway({ beforeSocketWrite = async () => {}, gatewayOptions = {}, onSeatBound = () => true, capped = false } = {}) {
	const registry = createManagedRoomSeatRegistry();
	assert.equal(registry.createRoom(roomId, seatIds), true);
	const credentials = new Map(seatIds.map(seatId => [seatId, registry.issueSeat(roomId, seatId).credential]));
	const bindings = new Map();
	const projectionCalls = [];
	const listeners = new Set();
	const manager = {
		inspect(candidateRoom) {
			return candidateRoom === roomId ? { roomId, sessionId: hostSessionId, engineBuildId, pid: 4567,
				state: "playable_probe", authorityStateRevision: capped ? 8 : 4, nextAuthorityEventSequence: capped ? 9 : 5, checkpointAvailable: false } : null;
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
		createV3CappedReadOnlySeatStateForRequest(candidateRoom, input) {
			const binding = bindings.get(input.recipientSeatId), credential = credentials.get(input.recipientSeatId);
			if (!capped || candidateRoom !== roomId || !binding || input.request.connectionId !== binding.connectionId ||
				input.request.credential !== credential || !registry.authenticateSeat({ roomId, seatId: input.recipientSeatId,
					connectionId: binding.connectionId, credential }, { roomId, seatId: input.recipientSeatId }))
				return { ok: false, code: "V3_CAPPED_STATE_RECIPIENT_REJECTED" };
			projectionCalls.push({ seatId: input.recipientSeatId, sequence: input.stateSequence, generation: binding.connectionGeneration, capped: true });
			const created = createCappedReadOnlySeatState({ roomId, recipientSeatId: input.recipientSeatId,
				connectionGeneration: binding.connectionGeneration, stateSequence: input.stateSequence,
				replayFromSequence: input.stateSequence - 1, authorityRevision: 8, lastAcceptedEventSequence: 8,
				nextAuthorityEventSequence: 9, captureOrdinal: 6, nativeCompletionOrdinal: 57,
				nativeEventId: `native_event_${"a".repeat(32)}`, phaseOverEventInstanceId: "event_301",
				experimentalCeilingReached: true, gameTerminal: false, gameplayEnabled: false,
				projectionStatus: "verified_capture_payload_unavailable" });
			return created.ok ? created : created;
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
			if (!onSeatBound({ roomId: candidateRoom, seatId, connectionId, credential, connectionGeneration, binding })) return null;
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

test("Event 8 cap permits authenticated recipient-only final status reads while all Event 9 actions remain disabled", async t => {
	const fixture = setupGateway({ capped: true });
	t.after(async () => fixture.gateway.close());
	const { url } = await fixture.gateway.listen();
	const sockets = new Map(), views = new Map();
	t.after(async () => Promise.all([...sockets.values()].map(closeSocket)));
	for (const seatId of seatIds) {
		const socket = await connect(url); sockets.set(seatId, socket);
		assert.equal((await authenticate(socket, seatId, fixture.credentials.get(seatId)).catch(error => { throw new Error(`CAPPED_AUTH_${seatId}:${error.message}`); })).connectionGeneration, 1);
		const view = await readState(socket, `capped_${seatId}`, 0).catch(error => { throw new Error(`CAPPED_READ_${seatId}:${error.message}`); });
		assert.equal(view.schema, "xingbei_v3_capped_readonly_state_v1");
		assert.equal(view.recipientSeatId, seatId);
		assert.equal(view.authorityRevision, 8);
		assert.equal(view.lastAcceptedEventSequence, 8);
		assert.equal(view.nextAuthorityEventSequence, 9);
		assert.equal(view.experimentalCeilingReached, true);
		assert.equal(view.gameTerminal, false, "an experiment ceiling is not an in-game terminal result");
		assert.equal(view.gameplayEnabled, false);
		assert.equal(view.projectionStatus, "verified_capture_payload_unavailable");
		assert.equal(JSON.stringify(view).includes("commitment"), false);
		assert.equal(JSON.stringify(view).includes("hostSession"), false);
		views.set(seatId, view);
		assert.deepEqual(await ackState(socket, 1), { type: "transport_acknowledged", stateSequence: 1,
			connectionGeneration: 1, duplicate: false });
	}
	assert.equal(new Set([...views.values()].map(view => view.recipientSeatId)).size, 4);
	assert.deepEqual(await readChoice(sockets.get("seat_a"), "event9_choice"),
		{ type: "managed_choice_unavailable", requestId: "event9_choice" });
	for (const type of ["choice_submit", "authority_event", "native_command"]) {
		const response = onceMessage(sockets.get("seat_a"));
		sockets.get("seat_a").send(JSON.stringify({ type, eventSequence: 9, choiceId: "forged", optionId: "forged" }));
		assert.deepEqual(await response, { type: "gateway_error", code: "GAMEPLAY_TRANSPORT_DISABLED" });
	}
	assert.equal(fixture.manager.inspect(roomId).authorityStateRevision, 8);
	assert.equal(fixture.manager.inspect(roomId).nextAuthorityEventSequence, 9);
	assert.equal(fixture.projectionCalls.length, 4);
	assert.ok(fixture.projectionCalls.every(call => call.capped === true));
	assert.equal(fixture.gateway.inspect().bufferedMessages, 4);
	await fixture.gateway.close();
	assert.equal(fixture.gateway.inspect().bufferedMessages, 0);
});

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

async function readChoice(socket, requestId) {
	const response = onceMessage(socket);
	socket.send(JSON.stringify({ type: "choice_read", requestId }));
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
		assert.deepEqual(auth, { type: "seat_authenticated", roomId, seatId, connectionGeneration: 1, lastAcknowledgedSequence: 0 });
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
		assert.deepEqual(auth, { type: "seat_authenticated", roomId, seatId, connectionGeneration: priorGeneration + 1,
			lastAcknowledgedSequence: 1 });
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

test("experimental choice submission is capability-scoped, actor-only, controller-validated and request-idempotent", async t => {
	const { createManagedChoiceController } = require("../game/server-managed-choice-controller.js");
	const optionIds = [`native_option_${"1".repeat(32)}`, `native_option_${"2".repeat(32)}`];
	const delivered = [];
	const connections = new Map();
	const choiceLookups = [];
	const controller = createManagedChoiceController({
		isHostSessionActive: (candidateRoom, candidateSession) => candidateRoom === roomId && candidateSession === hostSessionId,
		authorizeManagedHost: () => true,
		authorizeSeatBinding: () => true,
		authenticateSeat: request => {
			const current = connections.get(request.seatId);
			return Boolean(current && current.connectionId === request.connectionId && current.credential === request.credential &&
				request.connectionGeneration === current.connectionGeneration);
		},
		onResolved: choice => { delivered.push(choice); return undefined; },
		deliveryRetryMs: 60000,
	});
	const capability = Object.freeze({ schema: "xingbei_v3_managed_action_capability_v1", roomId, hostSessionId,
		engineBuildId, rootInstanceId, hostPid: 4567, authorityRevision: 4, nextAuthorityEventSequence: 5,
		authorityCeiling: 8, activeSeatId: "seat_a", captureVerified: true });
	const fixture = setupGateway({
		onSeatBound: ({ roomId: candidateRoom, seatId, connectionId, credential, connectionGeneration }) => {
			connections.set(seatId, { connectionId, credential, connectionGeneration });
			return controller.bindSeatConnection({ roomId: candidateRoom, seatId, connectionId }).ok;
		},
		gatewayOptions: {
			getExperimentalActionCapability: () => capability,
			getCurrentManagedChoice: scope => {
				choiceLookups.push({ seatId: scope.seatId, eventSequence: scope.eventSequence });
				const choice = controller.findPendingChoice(scope);
				if (!choice) return null;
				const generation = fixture.bindings.get(choice.seatId)?.connectionGeneration;
				const ids = choice.options;
				const display = createManagedChoiceDisplay({ roomId, hostSessionId,
					rootInstanceId, nativeEventId: choice.nativeEventId, eventInstanceId: "event_41", parentEventInstanceId: "event_40",
					eventSequence: choice.eventSequence, choiceId: choice.choiceId, actingSeatId: choice.seatId,
					connectionGeneration: generation, captureOrdinal: 2, nativeCompletionOrdinal: 10, seatIds, optionIds: ids,
					optionKinds: { [ids[0]]: "gongJi", [ids[1]]: "faShu" },
					optionTargetSeatIds: { [ids[0]]: "seat_b", [ids[1]]: "seat_c" } });
				return display.ok ? { roomId: choice.roomId, hostSessionId: choice.hostSessionId, seatId: choice.seatId,
					choiceId: choice.choiceId, nativeEventId: choice.nativeEventId, eventSequence: choice.eventSequence,
					connectionGeneration: generation, display: display.message,
					options: choice.options, deadlineAt: choice.deadlineAt, state: choice.state } : null;
			},
			submitManagedChoice: message => controller.submitChoice(message),
		},
	});
	t.after(async () => { await fixture.gateway.close(); controller.cleanupHostSession(roomId, hostSessionId); });
	const opened = controller.openChoice({ protocol: 1, roomId, hostSessionId, seatId: "seat_a",
		nativeEventId: `native_event_${"a".repeat(32)}`, eventSequence: 5, options: optionIds,
		trusteeOption: optionIds[0], deadlineAt: Date.now() + 60000, kind: "managed_host", hostProof: "trusted-test" });
	assert.equal(opened.ok, true);
	const { url } = await fixture.gateway.listen();
	const clients = new Map();
	t.after(async () => Promise.all([...clients.values()].map(closeSocket)));
	for (const seatId of seatIds) {
		const socket = await connect(url); clients.set(seatId, socket);
		const auth = await authenticate(socket, seatId, fixture.credentials.get(seatId));
		assert.equal(auth.type, "seat_authenticated");
		if (seatId === "seat_a") {
			let choice;
			try { choice = await readChoice(socket, "choice_read_actor"); } catch (error) {
				assert.fail(`${error.message}; choiceLookups=${JSON.stringify(choiceLookups)}; gateway=${JSON.stringify(fixture.gateway.inspect())}; choiceState=${JSON.stringify(controller.inspect(roomId, opened.choice.choiceId)?.state)}`);
			}
			assert.deepEqual(choice, { type: "managed_choice", requestId: "choice_read_actor", roomId, seatId, choiceId: opened.choice.choiceId,
				eventSequence: 5, connectionGeneration: 1, deadlineAt: opened.choice.deadlineAt, optionIds,
				display: { schema: "xingbei_v3_managed_choice_display_v1", roomId, hostSessionId, rootInstanceId,
					nativeEventId: opened.choice.nativeEventId, eventInstanceId: "event_41", parentEventInstanceId: "event_40",
					eventSequence: 5, choiceId: opened.choice.choiceId, actingSeatId: "seat_a", connectionGeneration: 1,
					captureOrdinal: 2, nativeCompletionOrdinal: 10, optionItems: [
						{ optionId: optionIds[0], operationKind: "gongJi", label: "攻擊", targetSeatId: "seat_b", cardViewId: null, completeness: "partial" },
						{ optionId: optionIds[1], operationKind: "faShu", label: "法術", targetSeatId: "seat_c", cardViewId: null, completeness: "partial" },
					] } });
		} else {
			assert.deepEqual(await readChoice(socket, `choice_read_${seatId}`), { type: "managed_choice_unavailable", requestId: `choice_read_${seatId}` });
			const spoofed = onceMessage(socket);
			socket.send(JSON.stringify({ type: "choice_submit", requestId: `spoof_${seatId}`,
				choiceId: opened.choice.choiceId, optionId: optionIds[0] }));
			assert.deepEqual(await spoofed, { type: "gateway_error", code: "MANAGED_CHOICE_SUBMISSION_REJECTED" });
		}
	}
	const submit = { type: "choice_submit", requestId: "actor_submit_1", choiceId: opened.choice.choiceId, optionId: optionIds[1] };
	const firstAck = onceMessage(clients.get("seat_a"));
	clients.get("seat_a").send(JSON.stringify(submit));
	assert.deepEqual(await firstAck, { type: "choice_submission_ack", requestId: "actor_submit_1",
		choiceId: opened.choice.choiceId, accepted: true, stage: "controller", duplicate: false });
	assert.equal(controller.inspect(roomId, opened.choice.choiceId).state, "delivery_pending");
	assert.equal(delivered.length, 1);
	const retryAck = onceMessage(clients.get("seat_a"));
	clients.get("seat_a").send(JSON.stringify(submit));
	assert.deepEqual(await retryAck, { type: "choice_submission_ack", requestId: "actor_submit_1",
		choiceId: opened.choice.choiceId, accepted: true, stage: "controller", duplicate: true });
	assert.equal(delivered.length, 1, "a transport retry must not invoke controller resolution twice");
	assert.equal(fixture.manager.inspect(roomId).authorityStateRevision, 4, "transport/controller acceptance is not authority acceptance");
	assert.equal(fixture.manager.inspect(roomId).nextAuthorityEventSequence, 5);
	assert.equal(fixture.gateway.inspect().closed, false);
});
