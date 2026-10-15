import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedChoiceController } = require("../game/server-managed-choice-controller.js");
const roomId = "race_room", seatId = "race_seat", otherRoomId = "other_race_room";
const setup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `race_seat_${position + 1}`, position })) };

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

function barrier() {
	const entered = deferred(), released = deferred();
	return { entered: entered.promise, wait: () => { entered.resolve(); return released.promise; }, release: () => released.resolve() };
}

function controlledTimers() {
	let next = 0;
	const timers = new Map();
	return { timers, schedule: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; }, cancel: id => timers.delete(id) };
}

function readyMessage(bootstrap, type, extra = {}) {
	return { kind: "managed_host", protocol: bootstrap.protocol, roomId: bootstrap.roomId,
		sessionId: bootstrap.sessionId, secret: bootstrap.secret, type, ...extra };
}

function createLifecycle({ ackBarrier = null, deliveryBarrier = null } = {}) {
	const handles = [], ended = [], openAttempts = [], ackProcessed = deferred();
	const timers = controlledTimers();
	let manager, nextPid = 8000, randomByte = 0;
	const controller = createManagedChoiceController({
		now: () => 1000,
		isHostSessionActive: (candidateRoom, sessionId) => {
			const current = manager?.inspect(candidateRoom);
			return current?.sessionId === sessionId && ["game_ready", "playable_probe"].includes(current.state);
		},
		authorizeManagedHost: request => request.hostProof === handles.find(item => item.bootstrap.sessionId === request.hostSessionId)?.bootstrap.secret,
		authenticateSeat: request => request.credential === request.seatId,
		authorizeSeatBinding: request => request.serverProof === request.connectionId,
		randomBytes: size => Buffer.alloc(size, ++randomByte),
		schedule: timers.schedule, cancel: timers.cancel,
		onResolved: choice => {
			if (!deliveryBarrier) return true;
			return manager.sendChoiceDelivery(choice.roomId, choice).then(result => {
				if (!result.ok) throw new Error("delivery stopped");
				return true;
			});
		},
	});
	manager = createHostSessionManager({
		launch: async bootstrap => {
			const handle = new EventEmitter();
			handle.pid = ++nextPid;
			let stopped = false;
			handle.start = async () => {};
			handle.sendHostCommand = async () => {
				if (!deliveryBarrier) return;
				await deliveryBarrier.wait();
				if (stopped) throw new Error("host stopped during delivery");
			};
			handle.stop = async () => {
				stopped = true;
				deliveryBarrier?.release();
				handle.emit("exit", 0, null);
			};
			handles.push({ bootstrap, handle });
			return handle;
		},
		randomBytes: size => Buffer.alloc(size, ++randomByte),
		browserReadyTimeoutMs: 60000, engineReadyTimeoutMs: 60000, gameReadyTimeoutMs: 60000,
		onSessionEnd: event => { ended.push(event); controller.cleanupHostSession(event.roomId, event.sessionId); },
		onManagedChoiceMessage: async ({ type, roomId: candidateRoom, sessionId, message }) => {
			if (type === "host_choice_ack" && ackBarrier) {
				await ackBarrier.wait();
				const result = controller.acknowledgeDelivery({ ...message, hostSessionId: sessionId, hostProof: message.secret });
				openAttempts.push(result);
				ackProcessed.resolve(result);
				return;
			}
			if (type === "host_native_action_candidates") {
				openAttempts.push(controller.openChoice({ protocol: 1, roomId: candidateRoom, hostSessionId: sessionId,
					seatId: message.seatId, nativeEventId: message.nativeEventId, eventSequence: message.eventSequence,
					options: message.options, trusteeOption: message.trusteeOption, deadlineAt: 5000,
					hostProof: message.secret }));
			}
		},
	});
	return { ackProcessed, controller, ended, handles, manager, openAttempts, timers: timers.timers };
}

async function startReady(f, room = roomId) {
	assert.equal((await f.manager.start(room, setup)).ok, true);
	const bootstrap = f.handles.at(-1).bootstrap;
	assert.equal(f.manager.markBrowserReady(readyMessage(bootstrap, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(readyMessage(bootstrap, "host_engine_ready")).ok, true);
	assert.equal(f.manager.markGameReady(readyMessage(bootstrap, "host_game_ready", { proof: {
		kind: "pre_game_verification_v1", setupDigest: bootstrap.setupDigest, preGameSummaryDigest: "ab".repeat(32),
		seatIds: setup.seats.map(seat => seat.seatId), checkpoint: null,
	} })).ok, true);
	return bootstrap;
}

function openControllerChoice(f, bootstrap, suffix) {
	const opened = f.controller.openChoice({ protocol: 1, roomId: bootstrap.roomId, hostSessionId: bootstrap.sessionId,
		seatId, nativeEventId: `native_race_event_${suffix}`, eventSequence: 4, options: ["native_a", "native_b"],
		trusteeOption: "native_b", deadlineAt: 5000, hostProof: bootstrap.secret });
	assert.equal(opened.ok, true);
	assert.equal(f.controller.bindSeatConnection({ roomId: bootstrap.roomId, seatId, connectionId: "race_connection", serverProof: "race_connection" }).ok, true);
	return opened.choice;
}

function submitChoice(f, bootstrap, choice) {
	return f.controller.submitChoice({ protocol: 1, roomId: bootstrap.roomId, hostSessionId: bootstrap.sessionId,
		nativeEventId: choice.nativeEventId, seatId, eventSequence: choice.eventSequence, choiceId: choice.choiceId,
		connectionId: "race_connection", credential: seatId, option: "native_a" });
}

test("player/deadline competing resolutions use the first transition while delivery callbacks are barrier-blocked", async () => {
	for (const winner of ["player", "trustee"]) {
		let now = 1000, nextTimer = 0;
		const timers = new Map(), deliveryBarrier = barrier(), delivered = [];
		const controller = createManagedChoiceController({ now: () => now,
			isHostSessionActive: () => true, authorizeManagedHost: request => request.hostProof === "trusted",
			authenticateSeat: request => request.credential === seatId, authorizeSeatBinding: request => request.serverProof === request.connectionId,
			randomBytes: size => Buffer.alloc(size, ++nextTimer),
			schedule: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, cancel: id => timers.delete(id),
			onResolved: async resolution => { delivered.push(resolution); await deliveryBarrier.wait(); },
		});
		const opened = controller.openChoice({ protocol: 1, roomId, hostSessionId: `hs_${"a".repeat(32)}`, seatId,
			nativeEventId: `native_race_${winner}_event`, eventSequence: 4, options: ["native_a", "native_b"], trusteeOption: "native_b",
			deadlineAt: 2000, hostProof: "trusted" });
		assert.equal(opened.ok, true);
		assert.equal(controller.bindSeatConnection({ roomId, seatId, connectionId: "race_conn", serverProof: "race_conn" }).ok, true);
		if (winner === "player") {
			now = 1999;
			assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: opened.choice.hostSessionId, nativeEventId: opened.choice.nativeEventId,
				seatId, eventSequence: 4, choiceId: opened.choice.choiceId, connectionId: "race_conn", credential: seatId, option: "native_a" }).ok, true);
			await deliveryBarrier.entered;
			now = 2000;
			assert.equal(controller.expireChoice({ roomId, choiceId: opened.choice.choiceId, hostSessionId: opened.choice.hostSessionId }).ok, false);
		} else {
			now = 2000;
			assert.equal(controller.expireChoice({ roomId, choiceId: opened.choice.choiceId, hostSessionId: opened.choice.hostSessionId }).ok, true);
			await deliveryBarrier.entered;
			assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: opened.choice.hostSessionId, nativeEventId: opened.choice.nativeEventId,
				seatId, eventSequence: 4, choiceId: opened.choice.choiceId, connectionId: "race_conn", credential: seatId, option: "native_a" }).ok, false);
		}
		const state = controller.inspect(roomId, opened.choice.choiceId);
		assert.equal(state.state, "delivery_pending");
		assert.deepEqual(state.resolution, winner === "player" ? { kind: "player", option: "native_a", connectionId: "race_conn" } : { kind: "trustee", option: "native_b" });
		assert.equal(delivered.length, 1);
		deliveryBarrier.release();
		await Promise.resolve();
		assert.deepEqual(controller.inspect(roomId, opened.choice.choiceId).resolution, state.resolution);
		for (const id of timers.keys()) timers.delete(id);
	}
});

test("stop during pending and delivery_pending native choices clears only the stopping session and its timers", async () => {
	const deliveryBarrier = barrier();
	const f = createLifecycle({ deliveryBarrier });
	const bootstrap = await startReady(f);
	const pending = openControllerChoice(f, bootstrap, "pending_001");
	const applying = openControllerChoice(f, bootstrap, "delivery_001");
	const submit = submitChoice(f, bootstrap, applying);
	await deliveryBarrier.entered;
	assert.equal(f.controller.inspect(roomId, pending.choiceId).state, "pending");
	assert.equal(f.controller.inspect(roomId, applying.choiceId).state, "delivery_pending");
	assert.deepEqual([...f.timers.values()].map(timer => timer.delay).sort((a, b) => a - b), [1000, 4000],
		"the pending-choice deadline and bounded IPC-send watchdog remain registered while delivery is barrier-blocked");
	assert.equal((await f.manager.stop(roomId, "race_stop_during_delivery")).ok, true);
	assert.equal(f.controller.inspect(roomId, pending.choiceId), null);
	assert.equal(f.controller.inspect(roomId, applying.choiceId), null);
	assert.equal(f.timers.size, 0);
	await submit;
	await Promise.resolve();
	assert.equal(f.timers.size, 0, "late send failure recreated a timer after session cleanup");
	assert.equal(f.ended.length, 1);
	assert.deepEqual(f.ended[0], { roomId, sessionId: bootstrap.sessionId, state: "stopped", code: null });
});

test("ACK generated before host termination is rejected after hostSession cleanup", async () => {
	const ackBarrier = barrier();
	const f = createLifecycle({ ackBarrier });
	const bootstrap = await startReady(f);
	const choice = openControllerChoice(f, bootstrap, "ack_race_001");
	assert.equal(submitChoice(f, bootstrap, choice).ok, true);
	const delivery = f.controller.inspect(roomId, choice.choiceId);
	const ack = readyMessage(bootstrap, "host_choice_ack", { type: "host_choice_ack", choiceId: choice.choiceId,
		deliveryId: delivery.deliveryId, nativeEventId: choice.nativeEventId, seatId, nativeApplied: true });
	f.handles[0].handle.emit("message", ack);
	await ackBarrier.entered;
	assert.equal(f.controller.inspect(roomId, choice.choiceId).state, "delivery_pending");
	assert.equal((await f.manager.stop(roomId, "invalidate_generated_ack")).ok, true);
	ackBarrier.release();
	await f.ackProcessed.promise;
	assert.equal(f.controller.inspect(roomId, choice.choiceId), null);
	assert.equal(f.openAttempts.at(-1).code, "MANAGED_CHOICE_ACK_REJECTED");
});

test("delayed old-session host messages cannot mutate its replacement or another room", async () => {
	const f = createLifecycle();
	const old = await startReady(f);
	f.handles[0].handle.emit("exit", 9, null);
	const replacement = await startReady(f);
	const isolated = await startReady(f, otherRoomId);
	assert.notEqual(old.sessionId, replacement.sessionId);
	const currentChoice = openControllerChoice(f, replacement, "current_001");
	assert.equal(submitChoice(f, replacement, currentChoice).ok, true);
	f.handles[0].handle.emit("message", readyMessage(old, "host_native_action_candidates", {
		seatId, nativeEventId: "native_stale_session_event", eventSequence: 4, options: ["native_a", "native_b"], trusteeOption: "native_b",
	}));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(f.openAttempts.at(-1).code, "MANAGED_CHOICE_OPEN_REJECTED");
	assert.equal(f.manager.inspect(roomId).sessionId, replacement.sessionId);
	assert.equal(f.manager.inspect(roomId).state, "game_ready");
	assert.equal(f.controller.inspect(roomId, currentChoice.choiceId).state, "delivery_pending");
	assert.equal(f.manager.inspect(otherRoomId).sessionId, isolated.sessionId);
	assert.equal(f.manager.inspect(otherRoomId).state, "game_ready");
	await f.manager.stop(roomId);
	await f.manager.stop(otherRoomId);
});
