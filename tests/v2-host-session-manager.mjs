import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const gameSetup = Object.freeze({
	mode: "xingBei",
	config: Object.freeze({ playerCount: 4 }),
	seats: Object.freeze(Array.from({ length: 4 }, (_, position) => Object.freeze({ seatId: `seat_${position + 1}`, position }))),
});

function fixture(options = {}) {
	const launches = [];
	const results = [];
	let nextPid = 4100;
	const launch = options.launch || (async bootstrap => {
		const handle = new EventEmitter();
		handle.pid = nextPid++;
		handle.stops = [];
		handle.stop = async reason => {
			handle.stops.push(reason);
			handle.emit("exit", 0, null);
		};
		launches.push({ bootstrap, handle });
		return handle;
	});
	let byte = 0;
	const manager = createHostSessionManager({
		launch,
		randomBytes(size) {
			byte++;
			return Buffer.alloc(size, byte);
		},
		browserReadyTimeoutMs: options.browserReadyTimeoutMs || 1000,
		engineReadyTimeoutMs: options.engineReadyTimeoutMs || 1000,
		gameReadyTimeoutMs: options.gameReadyTimeoutMs || 1000,
		onAuthoritativeResult: result => results.push(result),
		onSessionEnd: options.onSessionEnd || (() => {}),
	});
	return { launches, manager, results };
}

function hostMessage(bootstrap, type, extra = {}) {
	return {
		kind: "managed_host",
		type,
		protocol: bootstrap.protocol,
		roomId: bootstrap.roomId,
		sessionId: bootstrap.sessionId,
		secret: bootstrap.secret,
		...extra,
	};
}

function gameReadyProof(bootstrap, digest = "ab".repeat(32), seatIds = gameSetup.seats.map(seat => seat.seatId)) {
	return { kind: "pre_game_verification_v1", setupDigest: bootstrap.setupDigest, preGameSummaryDigest: digest, seatIds, checkpoint: null };
}

test("browser readiness cannot authorize results before separate engine readiness", async () => {
	const f = fixture();
	const started = await f.manager.start("room_A", gameSetup);
	assert.equal(started.ok, true);
	assert.equal(started.session.state, "starting");
	assert.equal("secret" in started.session, false);
	assert.equal(f.launches[0].bootstrap.kind, "host_session_bootstrap");

	const browserReady = f.manager.markBrowserReady(hostMessage(f.launches[0].bootstrap, "host_browser_ready"));
	assert.equal(browserReady.ok, true);
	assert.equal(browserReady.session.state, "browser_ready");
	const result = hostMessage(f.launches[0].bootstrap, "authoritative_result", {
		sequence: 1,
		result: { winner: "team_red" },
	});
	assert.equal(f.manager.commitAuthoritativeResult(result).code, "HOST_AUTHORITY_REJECTED");
	const engineReady = f.manager.markEngineReady(hostMessage(f.launches[0].bootstrap, "host_engine_ready"));
	assert.equal(engineReady.ok, true);
	assert.equal(engineReady.session.state, "engine_ready");
	assert.equal(f.manager.commitAuthoritativeResult(result).code, "HOST_AUTHORITY_REJECTED");
	const gameReady = f.manager.markGameReady(hostMessage(f.launches[0].bootstrap, "host_game_ready", {
		proof: gameReadyProof(f.launches[0].bootstrap),
	}));
	assert.equal(gameReady.ok, true);
	assert.equal(gameReady.session.state, "game_ready");
	const committed = f.manager.commitAuthoritativeResult(result);
	assert.equal(committed.ok, true);
	assert.equal(f.results.length, 1);
	assert.equal(f.manager.inspect("room_A").nextResultSequence, 2);
	assert.equal(f.manager.inspect("room_A").authorityStateRevision, 0);

	const stopped = await f.manager.stop("room_A", "room_cleanup");
	assert.equal(stopped.ok, true);
	assert.equal(stopped.session.state, "stopped");
	assert.deepEqual(f.launches[0].handle.stops, ["room_cleanup"]);
});

test("player and administrator credentials cannot attest or submit authoritative results", async () => {
	const f = fixture();
	await f.manager.start("room_roles", gameSetup);
	const bootstrap = f.launches[0].bootstrap;
	for (const credential of [
		{ kind: "player_seat", token: bootstrap.secret },
		{ kind: "room_administrator", token: bootstrap.secret },
		{ kind: "managed_host", secret: "ff".repeat(32) },
	]) {
		const forged = { ...hostMessage(bootstrap, "host_browser_ready"), ...credential };
		assert.equal(f.manager.markBrowserReady(forged).code, "HOST_BROWSER_READY_REJECTED");
		assert.equal(f.manager.commitAuthoritativeResult({
			...forged,
			type: "authoritative_result",
			sequence: 1,
			result: { winner: "attacker" },
		}).code, "HOST_AUTHORITY_REJECTED");
	}
	assert.equal(f.results.length, 0);
	assert.equal(f.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready")).ok, true);
	assert.equal(f.manager.markGameReady(hostMessage(bootstrap, "host_game_ready", {
		proof: gameReadyProof(bootstrap, "cd".repeat(32)),
	})).ok, true);

	const adminResult = hostMessage(bootstrap, "authoritative_result", {
		kind: "room_administrator",
		sequence: 1,
		result: { winner: "admin" },
	});
	assert.equal(f.manager.commitAuthoritativeResult(adminResult).code, "HOST_AUTHORITY_REJECTED");
	assert.equal(f.results.length, 0);
	await f.manager.stop("room_roles");
});

test("duplicate, out-of-order and stale-session results fail closed", async () => {
	const f = fixture();
	await f.manager.start("room_sequence", gameSetup);
	const first = f.launches[0].bootstrap;
	assert.equal(f.manager.markBrowserReady(hostMessage(first, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(first, "host_engine_ready")).ok, true);
	assert.equal(f.manager.markGameReady(hostMessage(first, "host_game_ready", {
		proof: gameReadyProof(first, "ef".repeat(32)),
	})).ok, true);
	const result = sequence => hostMessage(first, "authoritative_result", {
		sequence,
		result: { sequence },
	});
	assert.equal(f.manager.commitAuthoritativeResult(result(2)).code, "HOST_RESULT_SEQUENCE_REJECTED");
	assert.equal(f.manager.commitAuthoritativeResult(result(1)).ok, true);
	assert.equal(f.manager.commitAuthoritativeResult(result(1)).code, "HOST_RESULT_SEQUENCE_REJECTED");
	await f.manager.stop("room_sequence");

	await f.manager.start("room_sequence", gameSetup);
	const second = f.launches[1].bootstrap;
	assert.notEqual(second.sessionId, first.sessionId);
	assert.equal(f.manager.markBrowserReady(hostMessage(second, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(second, "host_engine_ready")).ok, true);
	assert.equal(f.manager.markGameReady(hostMessage(second, "host_game_ready", {
		proof: gameReadyProof(second, "12".repeat(32)),
	})).ok, true);
	assert.equal(f.manager.commitAuthoritativeResult(result(2)).code, "HOST_AUTHORITY_REJECTED");
	assert.equal(f.results.length, 1);
	await f.manager.stop("room_sequence");
});

test("launch, browser-ready and engine-ready failures retain distinct states", async () => {
	const failed = fixture({ launch: async () => { throw new Error("spawn"); } });
	assert.equal((await failed.manager.start("launch_fail", gameSetup)).code, "HOST_LAUNCH_FAILED");
	assert.equal(failed.manager.inspect("launch_fail").failureCode, "HOST_LAUNCH_FAILED");

	const timed = fixture({ browserReadyTimeoutMs: 100 });
	await timed.manager.start("browser_timeout", gameSetup);
	await new Promise(resolve => setTimeout(resolve, 130));
	assert.equal(timed.manager.inspect("browser_timeout").state, "failed");
	assert.equal(timed.manager.inspect("browser_timeout").failureCode, "HOST_BROWSER_READY_TIMEOUT");
	assert.deepEqual(timed.launches[0].handle.stops, ["browser_ready_timeout"]);

	const engineTimed = fixture({ engineReadyTimeoutMs: 100 });
	await engineTimed.manager.start("engine_timeout", gameSetup);
	const bootstrap = engineTimed.launches[0].bootstrap;
	assert.equal(engineTimed.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready")).ok, true);
	await new Promise(resolve => setTimeout(resolve, 130));
	assert.equal(engineTimed.manager.inspect("engine_timeout").failureCode, "HOST_ENGINE_READY_TIMEOUT");
	assert.deepEqual(engineTimed.launches[0].handle.stops, ["engine_ready_timeout"]);

	const gameTimed = fixture({ gameReadyTimeoutMs: 100 });
	await gameTimed.manager.start("game_timeout", gameSetup);
	const gameBootstrap = gameTimed.launches[0].bootstrap;
	assert.equal(gameTimed.manager.markBrowserReady(hostMessage(gameBootstrap, "host_browser_ready")).ok, true);
	assert.equal(gameTimed.manager.markEngineReady(hostMessage(gameBootstrap, "host_engine_ready")).ok, true);
	await new Promise(resolve => setTimeout(resolve, 130));
	assert.equal(gameTimed.manager.inspect("game_timeout").failureCode, "HOST_GAME_READY_TIMEOUT");
	assert.deepEqual(gameTimed.launches[0].handle.stops, ["game_ready_timeout"]);

	const exited = fixture();
	await exited.manager.start("unexpected_exit", gameSetup);
	exited.launches[0].handle.emit("exit", 12, null);
	assert.equal(exited.manager.inspect("unexpected_exit").state, "failed");
	assert.equal(exited.manager.inspect("unexpected_exit").failureCode, "HOST_EXITED");
});

test("one room cannot start two active host sessions", async () => {
	const f = fixture();
	await f.manager.start("one_host", gameSetup);
	assert.equal((await f.manager.start("one_host", gameSetup)).code, "HOST_SESSION_EXISTS");
	assert.equal(f.launches.length, 1);
	await f.manager.stop("one_host");
});

test("game readiness rejects mismatched setup, seat set and initial-state proof", async () => {
	const f = fixture();
	assert.equal((await f.manager.start("room_game_gate", gameSetup)).ok, true);
	const bootstrap = f.launches[0].bootstrap;
	f.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready"));
	f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready"));
	for (const proof of [
		{ ...gameReadyProof(bootstrap), setupDigest: "00".repeat(32) },
		{ ...gameReadyProof(bootstrap), preGameSummaryDigest: "not-a-digest" },
		{ ...gameReadyProof(bootstrap), seatIds: ["seat_1", "seat_2"] },
		{ ...gameReadyProof(bootstrap), kind: "checkpoint_v1" },
		{ ...gameReadyProof(bootstrap), checkpoint: { revision: 0 } },
	]) {
		assert.equal(f.manager.markGameReady(hostMessage(bootstrap, "host_game_ready", { proof })).code, "HOST_GAME_READY_REJECTED");
		assert.equal(f.manager.inspect("room_game_gate").state, "engine_ready");
	}
	await f.manager.stop("room_game_gate");
});

test("invalid server game setup never launches a managed host", async () => {
	const f = fixture();
	for (const setup of [undefined, { ...gameSetup, mode: "identity" }, { ...gameSetup, seats: [] },
		{ ...gameSetup, config: { playerCount: 6 } },
		{ ...gameSetup, seats: gameSetup.seats.map((seat, index) => ({ ...seat, position: index === 2 ? 3 : index })) }, {
		...gameSetup,
		seats: gameSetup.seats.map((seat, index) => ({ seatId: index < 2 ? "duplicate" : seat.seatId, position: index })),
	}]) {
		assert.equal((await f.manager.start("invalid_setup", setup)).code, "HOST_GAME_SETUP_INVALID");
	}
	assert.equal(f.launches.length, 0);
});

test("hostSession terminal lifecycle notifies exact room/session once for cleanup", async () => {
	const ended = [];
	const f = fixture({ onSessionEnd: event => ended.push(event) });
	await f.manager.start("lifecycle_a", gameSetup);
	await f.manager.start("lifecycle_b", gameSetup);
	const first = f.launches[0].bootstrap;
	f.launches[0].handle.emit("exit", 17, null);
	assert.deepEqual(ended, [{ roomId: "lifecycle_a", sessionId: first.sessionId, state: "failed", code: "HOST_EXITED" }]);
	assert.equal(f.manager.inspect("lifecycle_b").state, "starting", "one host failure must not affect another room");
	const next = await f.manager.start("lifecycle_a", gameSetup);
	assert.equal(next.ok, true);
	const second = f.launches.at(-1).bootstrap;
	assert.notEqual(second.sessionId, first.sessionId);
	// A late exit/error from the old process can only notify its own session once.
	f.launches[0].handle.emit("exit", 18, null);
	assert.equal(ended.length, 1);
	await f.manager.stop("lifecycle_a");
	assert.equal(ended.length, 2);
	assert.deepEqual(ended[1], { roomId: "lifecycle_a", sessionId: second.sessionId, state: "stopped", code: null });
	await f.manager.stop("lifecycle_b");
});

test("host termination cleanup is session-scoped, cancels pending choices and isolates other rooms", async () => {
	const timers = new Map(); let timerId = 0;
	let manager;
	const controller = require("../game/server-managed-choice-controller.js").createManagedChoiceController({
		isHostSessionActive: (roomId, sessionId) => manager?.inspect(roomId)?.sessionId === sessionId && manager.inspect(roomId)?.state === "playable_probe",
		authorizeManagedHost: message => message.hostProof === "test-host-proof",
		schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
		cancel: id => timers.delete(id),
	});
	const lifecycle = fixture({ onSessionEnd: event => controller.cleanupHostSession(event.roomId, event.sessionId) });
	manager = lifecycle.manager;
	const makeReady = async (roomId, digest) => {
		await manager.start(roomId, gameSetup);
		const bootstrap = lifecycle.launches.at(-1).bootstrap;
		manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready"));
		manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready"));
		manager.markGameReady(hostMessage(bootstrap, "host_game_ready", { proof: gameReadyProof(bootstrap, digest) }));
		const side = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 1, stateRevisionBefore: 0,
			stateRevisionAfter: 1, beforeDigest: "01".repeat(32), afterDigest: "02".repeat(32),
			event: { kind: "xingbei_side_assignment_v1", name: "initSideAndPosition", firstActSeatId: "seat_1",
				sides: gameSetup.seats.map((seat, index) => ({ seatId: seat.seatId, side: index < 2 })), hostPlayerAbsent: true, connectedTransports: 0 } };
		manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: side }));
		const characters = { ...side, eventSequence: 2, stateRevisionBefore: 1, stateRevisionAfter: 2, beforeDigest: side.afterDigest,
			afterDigest: "03".repeat(32), event: { kind: "xingbei_character_selection_v1", name: "chooseCharacterOL",
				characters: gameSetup.seats.map((seat, index) => ({ seatId: seat.seatId, character: `c_${index}` })), hostPlayerAbsent: true, connectedTransports: 0 } };
		manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: characters }));
		return bootstrap;
	};
	const a = await makeReady("cleanup_room_a", "11".repeat(32));
	const b = await makeReady("cleanup_room_b", "12".repeat(32));
	const open = (bootstrap, suffix) => controller.openChoice({ protocol: 1, roomId: bootstrap.roomId, hostSessionId: bootstrap.sessionId,
		seatId: "seat_1", nativeEventId: `native_cleanup_${suffix}_0001`, eventSequence: 9, options: ["x", "y"], trusteeOption: "y",
		deadlineAt: Date.now() + 60000, hostProof: "test-host-proof" });
	const ca = open(a, "room_a_0001"), cb = open(b, "room_b_0001");
	assert.equal(ca.ok, true); assert.equal(cb.ok, true);
	assert.equal(timers.size, 2);
	lifecycle.launches.find(item => item.bootstrap.sessionId === a.sessionId).handle.emit("exit", 9, null);
	assert.equal(controller.inspect(a.roomId, ca.choice.choiceId), null);
	assert.notEqual(controller.inspect(b.roomId, cb.choice.choiceId), null);
	assert.equal(timers.size, 1);
	assert.equal(manager.inspect(b.roomId).state, "playable_probe");
	await manager.stop(b.roomId);
	assert.equal(controller.inspect(b.roomId, cb.choice.choiceId), null);
	assert.equal(timers.size, 0);
});

test("authority event chain requires authenticated balanced native Xingbei side assignment", async () => {
	const f = fixture();
	await f.manager.start("native_progress_gate", gameSetup);
	const bootstrap = f.launches[0].bootstrap;
	f.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready"));
	f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready"));
	f.manager.markGameReady(hostMessage(bootstrap, "host_game_ready", { proof: gameReadyProof(bootstrap) }));
	const proof = {
		kind: "native_authority_event_v1",
		checkpoint: null,
		eventSequence: 1,
		stateRevisionBefore: 0,
		stateRevisionAfter: 1,
		beforeDigest: "01".repeat(32),
		afterDigest: "02".repeat(32),
		event: {
			kind: "xingbei_side_assignment_v1",
			name: "initSideAndPosition",
			firstActSeatId: "seat_1",
			sides: gameSetup.seats.map((seat, index) => ({ seatId: seat.seatId, side: index < 2 })),
			hostPlayerAbsent: true,
			connectedTransports: 0,
		},
	};
	for (const invalid of [
		{ ...proof, afterDigest: proof.beforeDigest },
		{ ...proof, eventSequence: 2 },
		{ ...proof, stateRevisionAfter: 2 },
		{ ...proof, event: { ...proof.event, firstActSeatId: "foreign_seat" } },
		{ ...proof, event: { ...proof.event, sides: proof.event.sides.slice(1) } },
		{ ...proof, event: { ...proof.event, sides: proof.event.sides.map((side, index) => ({ ...side, side: index === 2 ? true : side.side })) } },
		{ ...proof, event: { ...proof.event, firstActSeatId: "seat_3" } },
		{ ...proof, event: { ...proof.event, hostPlayerAbsent: false } },
		{ ...proof, checkpoint: { misleading: true } },
	]) {
		assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: invalid })).code,
			"HOST_AUTHORITY_EVENT_REJECTED");
	}
	assert.equal(f.manager.commitAuthorityEvent({
		...hostMessage(bootstrap, "host_authority_event", { proof }),
		kind: "room_administrator",
	}).code, "HOST_AUTHORITY_EVENT_REJECTED");
	const accepted = f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof }));
	assert.equal(accepted.ok, true);
	assert.equal(accepted.session.state, "playable_probe");
	assert.equal(accepted.session.authorityStateRevision, 1);
	assert.equal(accepted.session.authorityStateDigest, proof.afterDigest);
	assert.equal(accepted.session.nextAuthorityEventSequence, 2);
	assert.deepEqual(accepted.session.lastAuthorityEvent, { sequence: 1, name: "initSideAndPosition" });
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof })).code,
		"HOST_AUTHORITY_EVENT_REJECTED");
	const repeatedSemanticEvent = {
		...proof,
		eventSequence: 2,
		stateRevisionBefore: 1,
		stateRevisionAfter: 2,
		beforeDigest: proof.afterDigest,
		afterDigest: "03".repeat(32),
	};
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", {
		proof: repeatedSemanticEvent,
	})).code, "HOST_AUTHORITY_EVENT_REJECTED");
	for (const invalidChain of [
		{ ...repeatedSemanticEvent, eventSequence: 3 },
		{ ...repeatedSemanticEvent, beforeDigest: "04".repeat(32) },
	]) {
		assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", {
			proof: invalidChain,
		})).code, "HOST_AUTHORITY_EVENT_REJECTED");
	}
	const characterSelection = {
		kind: "native_authority_event_v1",
		checkpoint: null,
		eventSequence: 2,
		stateRevisionBefore: 1,
		stateRevisionAfter: 2,
		beforeDigest: proof.afterDigest,
		afterDigest: "03".repeat(32),
		event: {
			kind: "xingbei_character_selection_v1",
			name: "chooseCharacterOL",
			characters: gameSetup.seats.map((seat, index) => ({ seatId: seat.seatId, character: `character_${index + 1}` })),
			hostPlayerAbsent: true,
			connectedTransports: 0,
		},
	};
	for (const invalid of [
		{ ...characterSelection, beforeDigest: "04".repeat(32) },
		{ ...characterSelection, eventSequence: 3 },
		{ ...characterSelection, event: { ...characterSelection.event, characters: characterSelection.event.characters.slice(1) } },
		{ ...characterSelection, event: { ...characterSelection.event, characters: characterSelection.event.characters.map((entry, index) => ({ ...entry, character: index ? "character_1" : entry.character })) } },
	]) {
		assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: invalid })).code,
			"HOST_AUTHORITY_EVENT_REJECTED");
	}
	const selected = f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: characterSelection }));
	assert.equal(selected.ok, true);
	assert.equal(selected.session.authorityStateRevision, 2);
	assert.equal(selected.session.authorityStateDigest, characterSelection.afterDigest);
	assert.equal(selected.session.nextAuthorityEventSequence, 3);
	assert.deepEqual(selected.session.lastAuthorityEvent, { sequence: 2, name: "chooseCharacterOL" });
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: characterSelection })).code,
		"HOST_AUTHORITY_EVENT_REJECTED");
	await f.manager.stop("native_progress_gate");
});
