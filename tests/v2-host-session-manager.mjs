import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

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
	if (type === "host_engine_ready" && extra.proof === undefined) extra = { ...extra, proof: {
		kind: "managed_engine_integrity_v1", trustContract: bootstrap.trustContract, buildId: bootstrap.engineSourceManifest.buildId,
		fileCount: bootstrap.engineSourceManifest.fileCount, totalBytes: bootstrap.engineSourceManifest.totalBytes,
		networkPolicy: "same-origin-only",
	} };
	if (type === "host_game_ready" && extra.proof && extra.proof.engineBuildId === undefined) extra = { ...extra, proof: {
		...extra.proof, trustContract: extra.proof.trustContract ?? bootstrap.trustContract, engineBuildId: bootstrap.engineSourceManifest.buildId,
	} };
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

test("engine readiness is bound to the server manifest and rejects a stale engine build", async () => {
	const f = fixture();
	assert.equal((await f.manager.start("room_engine_integrity", gameSetup)).ok, true);
	const bootstrap = f.launches[0].bootstrap;
	assert.equal(f.manager.markBrowserReady(hostMessage(bootstrap, "host_browser_ready")).ok, true);
	assert.equal(f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready", { proof: {
		kind: "managed_engine_integrity_v1", trustContract: bootstrap.trustContract, buildId: "0".repeat(64), fileCount: bootstrap.engineSourceManifest.fileCount,
		totalBytes: bootstrap.engineSourceManifest.totalBytes, networkPolicy: "same-origin-only",
	} })).code, "HOST_ENGINE_READY_REJECTED");
	assert.equal(f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready", { proof: {
		kind: "managed_engine_integrity_v1", trustContract: "xingbei_managed_native_trust_v0", buildId: bootstrap.engineSourceManifest.buildId,
		fileCount: bootstrap.engineSourceManifest.fileCount, totalBytes: bootstrap.engineSourceManifest.totalBytes, networkPolicy: "same-origin-only",
	} })).code, "HOST_ENGINE_READY_REJECTED");
	assert.equal(f.manager.inspect("room_engine_integrity").state, "browser_ready");
	assert.equal(f.manager.markEngineReady(hostMessage(bootstrap, "host_engine_ready")).ok, true);
	assert.equal(f.manager.inspect("room_engine_integrity").engineBuildId, bootstrap.engineSourceManifest.buildId);
	assert.equal("engineSourceManifest" in f.manager.inspect("room_engine_integrity"), false);
	await f.manager.stop("room_engine_integrity");
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
		{ ...gameReadyProof(bootstrap), trustContract: "xingbei_managed_native_trust_v0" },
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
		{ ...gameSetup, config: { playerCount: 4, extensions: ["untrusted"] } },
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

test("authority event chain requires authenticated balanced native Xingbei side assignment", async t => {
	const oldDiagnostics = process.env.V2_NATIVE_START_DIAGNOSTICS;
	process.env.V2_NATIVE_START_DIAGNOSTICS = "1";
	t.after(() => oldDiagnostics === undefined ? delete process.env.V2_NATIVE_START_DIAGNOSTICS : process.env.V2_NATIVE_START_DIAGNOSTICS = oldDiagnostics);
	const f = fixture();
	await f.manager.start("native_progress_gate", gameSetup);
	const bootstrap = f.launches[0].bootstrap;
	const sentCommands = [];
	f.launches[0].handle.sendHostCommand = async command => { sentCommands.push(command); };
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
	assert.equal((await f.manager.diagnoseNativeStart("native_progress_gate", "managed_opening_root_action")).ok, false,
		"phaseLoop release must stay blocked until the authoritative opening draw commits");
	assert.equal(sentCommands.length, 0);
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: characterSelection })).code,
		"HOST_AUTHORITY_EVENT_REJECTED");
	const openingDraw = {
		...characterSelection,
		eventSequence: 3,
		stateRevisionBefore: 2,
		stateRevisionAfter: 3,
		beforeDigest: characterSelection.afterDigest,
		afterDigest: "00".repeat(32),
		event: {
			kind: "xingbei_opening_draw_v1",
			name: "gameDraw",
			nativeEventId: "native_0123456789abcdef_opening_draw",
			nativeEventCompleted: true,
			nativeEventStep: 1,
			gameStartTriggered: true,
			gameStartCount: 1,
			rootEventName: "game",
			parentEventName: "game",
			phaseLoopCreated: true,
			phaseLoopStartRequested: true,
			phaseLoopParentName: "game",
			phaseLoopPaused: true,
			firstActSeatId: "seat_1",
			seats: gameSetup.seats.map((seat, index) => ({ seatId: seat.seatId, position: index,
				character: `character_${index + 1}`, side: index < 2, handCount: 4, handCommitment: (index + 5).toString(16).padStart(2, "0").repeat(32) })),
			gameMeNull: true,
			connectedTransports: 0,
		},
	};
	openingDraw.afterDigest = createHash("sha256").update(canonicalize({ revision: 3,
		firstActSeatId: openingDraw.event.firstActSeatId,
		seats: openingDraw.event.seats.map(({ seatId, position, character, side, handCount, handCommitment }) =>
			({ seatId, position, character, side, handCount, handCommitment })) })).digest("hex");
	for (const invalid of [
		{ ...openingDraw, eventSequence: 4 },
		{ ...openingDraw, beforeDigest: "fe".repeat(32) },
		{ ...openingDraw, afterDigest: "aa".repeat(32) },
		{ ...openingDraw, stateRevisionAfter: 4 },
		{ ...openingDraw, event: { ...openingDraw.event, nativeEventCompleted: false } },
		{ ...openingDraw, event: { ...openingDraw.event, gameStartCount: 2 } },
		{ ...openingDraw, event: { ...openingDraw.event, rootEventName: "chooseCharacterOL" } },
		{ ...openingDraw, event: { ...openingDraw.event, parentEventName: "chooseCharacterOL" } },
		{ ...openingDraw, event: { ...openingDraw.event, phaseLoopPaused: false } },
		{ ...openingDraw, event: { ...openingDraw.event, phaseLoopStartRequested: false } },
		{ ...openingDraw, event: { ...openingDraw.event, phaseLoopParentName: "chooseCharacterOL" } },
		{ ...openingDraw, event: { ...openingDraw.event, firstActSeatId: "seat_foreign" } },
		{ ...openingDraw, event: { ...openingDraw.event, seats: openingDraw.event.seats.slice(1) } },
		{ ...openingDraw, event: { ...openingDraw.event, seats: openingDraw.event.seats.map((seat, index) => index ? seat : { ...seat, handCount: 3 }) } },
		{ ...openingDraw, event: { ...openingDraw.event, seats: openingDraw.event.seats.map((seat, index) => index ? seat : { ...seat, seatId: "seat_foreign" }) } },
		{ ...openingDraw, event: { ...openingDraw.event, seats: openingDraw.event.seats.map((seat, index) => index ? seat : { ...seat, handCommitment: "not-a-digest" }) } },
		{ ...openingDraw, event: { ...openingDraw.event, gameMeNull: false } },
		{ ...openingDraw, event: { ...openingDraw.event, connectedTransports: 1 } },
		{ ...openingDraw, event: { ...openingDraw.event, nativeEventId: "public-event-id" } },
	]) {
		assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: invalid })).code,
			"HOST_AUTHORITY_EVENT_REJECTED");
	}
	const drawCommitted = f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: openingDraw }));
	assert.equal(drawCommitted.ok, true);
	assert.equal(drawCommitted.session.authorityStateRevision, 3);
	assert.equal(drawCommitted.session.authorityStateDigest, openingDraw.afterDigest);
	assert.equal(drawCommitted.session.nextAuthorityEventSequence, 4);
	assert.deepEqual(drawCommitted.session.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
	assert.equal((await f.manager.diagnoseNativeStart("native_progress_gate", "managed_opening_root_action")).ok, true);
	assert.equal(sentCommands.length, 1);
	assert.equal(sentCommands[0].type, "host_native_start_diagnostic");
	assert.equal(sentCommands[0].mode, "managed_opening_root_action");
	assert.equal((await f.manager.diagnoseNativeStart("native_progress_gate", "managed_native_response_probe")).ok, true,
		"the opt-in response-event probe must pass the host manager's diagnostic allowlist");
	assert.equal(sentCommands.length, 2);
	assert.equal(sentCommands[1].mode, "managed_native_response_probe");
	assert.equal((await f.manager.snapshotNativeStart("native_progress_gate")).ok, true,
		"an authenticated snapshot request must be available without restarting or re-instrumenting the native root");
	assert.equal(sentCommands.length, 3);
	assert.equal(sentCommands[2].type, "host_native_start_snapshot");
	assert.equal((await f.manager.snapshotNativeStart("native_progress_gate", "native_start")).ok, false,
		"live snapshots must remain restricted to the managed Event #4 diagnostic mode");
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: openingDraw })).code,
		"HOST_AUTHORITY_EVENT_REJECTED", "native opening draw must be one-shot");
	const beforeSummary = { revision: 3, firstActSeatId: openingDraw.event.firstActSeatId,
		seats: openingDraw.event.seats.map(seat => ({ ...seat })) };
	const afterSeats = beforeSummary.seats.map((seat, index) => index === 0 ? { ...seat, handCount: 3,
		handCommitment: "ef".repeat(32) } : index === 2 ? { ...seat, handCount: 3, handCommitment: "ab".repeat(32) } : { ...seat });
	const nativeResponse = { nativeEventId: "native_abcdef0123456789abcdef0123456789", actionEventId: "native_event_0123456789abcdef0123456789abcdef",
		seatId: "seat_3", sourceSeatId: "seat_1", kind: "card", optionId: "native_option_abcdef0123456789abcdef0123456789",
		optionShape: "native_single_target_card", targetSeatId: "seat_1", targetCount: 1,
		forced: false, useCardChildrenStarted: 1, useCardChildrenCompleted: 1, rootInstanceId: null };
	const cardAction = {
		kind: "native_authority_event_v1", checkpoint: null, eventSequence: 4,
		stateRevisionBefore: 3, stateRevisionAfter: 4, beforeDigest: openingDraw.afterDigest,
		beforeSummary, afterSummary: { revision: 4, firstActSeatId: beforeSummary.firstActSeatId, seats: afterSeats, responses: [nativeResponse],
			action: { nativeEventId: "native_event_0123456789abcdef0123456789abcdef", nativeEventName: "gongJiOrFaShu",
				seatId: "seat_1", cardName: "sha", targetSeatId: "seat_2", optionId: "native_option_0123456789abcdef0123456789abcdef", usedCardPosition: "d" } },
		afterDigest: "00".repeat(32),
		event: { kind: "xingbei_native_card_action_v1", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
			nativeEventId: "native_event_0123456789abcdef0123456789abcdef", nativeEventCompleted: true,
			seatId: "seat_1", cardName: "sha", targetSeatId: "seat_2", optionId: "native_option_0123456789abcdef0123456789abcdef",
			nativeEventStep: 6, useResultCount: 1, useCardChildName: "useCard", useCardChildStep: 3,
			nativeUseCardChildCompleted: true, usedCardPosition: "d",
			nativeChildWaitCompleted: true, nativeEventInstanceMatches: true,
			gameMeNull: true, connectedTransports: 0, responseActions: [nativeResponse] },
	};
	cardAction.afterDigest = createHash("sha256").update(canonicalize(cardAction.afterSummary)).digest("hex");
	const skillResponse = { ...nativeResponse, kind: "view_as_skill", optionShape: "native_single_target_view_as_skill",
		skillId: "yinYangZhanHuan", physicalMaterialConsumed: true, xiBieApplied: true, resolvedXiBie: "an", guiHuoDelta: 2 };
	const proofWithResponses = responses => {
		const proof = { ...cardAction, afterSummary: { ...cardAction.afterSummary, responses },
			event: { ...cardAction.event, responseActions: responses } };
		proof.afterDigest = createHash("sha256").update(canonicalize(proof.afterSummary)).digest("hex");
		return proof;
	};
	for (const invalidResponse of [
		{ ...skillResponse, optionShape: "native_single_target_card" },
		{ ...skillResponse, skillId: "forgedSkill" },
		{ ...skillResponse, physicalMaterialConsumed: false },
		{ ...skillResponse, xiBieApplied: false },
		{ ...skillResponse, resolvedXiBie: "invalid" },
		{ ...skillResponse, guiHuoDelta: 0 },
		{ ...skillResponse, guiHuoDelta: 4 },
	]) {
		assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", {
			proof: proofWithResponses([invalidResponse]),
		})).code, "HOST_AUTHORITY_EVENT_REJECTED", "malformed native viewAs skill evidence must fail closed");
	}
	for (const invalid of [
		{ ...cardAction, beforeDigest: "fe".repeat(32) },
		{ ...cardAction, beforeSummary: { ...beforeSummary, revision: 2 } },
		{ ...cardAction, eventSequence: 5 },
		{ ...cardAction, stateRevisionAfter: 5 },
		{ ...cardAction, afterDigest: "cd".repeat(32) },
		{ ...cardAction, event: { ...cardAction.event, seatId: "seat_2" } },
		{ ...cardAction, event: { ...cardAction.event, targetSeatId: "seat_missing" } },
		{ ...cardAction, event: { ...cardAction.event, nativeEventStep: 4 } },
		{ ...cardAction, event: { ...cardAction.event, useResultCount: 2 } },
		{ ...cardAction, event: { ...cardAction.event, nativeUseCardChildCompleted: false } },
		{ ...cardAction, event: { ...cardAction.event, nativeChildWaitCompleted: false } },
		{ ...cardAction, event: { ...cardAction.event, nativeEventInstanceMatches: false } },
		{ ...cardAction, event: { ...cardAction.event, connectedTransports: 1 } },
		{ ...cardAction, event: { ...cardAction.event, gameMeNull: false } },
		{ ...cardAction, event: { ...cardAction.event, responseActions: [] } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary, responses: [{ ...nativeResponse, sourceSeatId: "seat_3" }] },
			event: { ...cardAction.event, responseActions: [{ ...nativeResponse, sourceSeatId: "seat_3" }] } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary, responses: [{ ...nativeResponse, forced: true }] },
			event: { ...cardAction.event, responseActions: [{ ...nativeResponse, forced: true }] } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary, responses: [{ ...nativeResponse, targetSeatId: "seat_missing" }] },
			event: { ...cardAction.event, responseActions: [{ ...nativeResponse, targetSeatId: "seat_missing" }] } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary, responses: [{ ...nativeResponse, optionShape: "native_notarget_card", targetSeatId: null }] },
			event: { ...cardAction.event, responseActions: [{ ...nativeResponse, optionShape: "native_notarget_card", targetSeatId: null }] } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary, responses: [{ ...nativeResponse, targetCount: 0 }] },
			event: { ...cardAction.event, responseActions: [{ ...nativeResponse, targetCount: 0 }] } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary,
			seats: cardAction.afterSummary.seats.map((seat, index) => index === 2 ? { ...seat, handCommitment: beforeSummary.seats[index].handCommitment } : seat) } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary,
			seats: cardAction.afterSummary.seats.map((seat, index) => index === 0 ? { ...seat, handCount: 4 } : seat) } },
		{ ...cardAction, afterSummary: { ...cardAction.afterSummary,
			seats: cardAction.afterSummary.seats.map((seat, index) => index === 1 ? { ...seat, handCount: 3 } : seat) } },
	]) {
		assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: invalid })).code,
			"HOST_AUTHORITY_EVENT_REJECTED");
	}
	assert.equal(f.manager.commitAuthorityEvent(hostMessage({ ...bootstrap, sessionId: `hs_${"b".repeat(32)}` },
		"host_authority_event", { proof: cardAction })).code, "HOST_AUTHORITY_EVENT_REJECTED", "old host session cannot commit Event #4");
	assert.equal(f.manager.commitAuthorityEvent({ kind: "player", protocol: 1, roomId: bootstrap.roomId,
		sessionId: bootstrap.sessionId, type: "host_authority_event", proof: cardAction }).code,
		"HOST_AUTHORITY_EVENT_REJECTED", "ordinary player cannot submit Event #4");
	assert.equal(f.manager.commitAuthorityEvent({ kind: "room_administrator", protocol: 1, roomId: bootstrap.roomId,
		sessionId: bootstrap.sessionId, type: "host_authority_event", proof: cardAction }).code,
		"HOST_AUTHORITY_EVENT_REJECTED", "room administrator cannot submit Event #4");
	const cardCommitted = f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: cardAction }));
	assert.equal(cardCommitted.ok, true);
	assert.equal(cardCommitted.session.authorityStateRevision, 4);
	assert.equal(cardCommitted.session.nextAuthorityEventSequence, 5);
	assert.deepEqual(cardCommitted.session.lastAuthorityEvent, { sequence: 4, name: "gongJiOrFaShu" });
	assert.equal(cardCommitted.session.authorityStateDigest, cardAction.afterDigest);
	const unsupportedEvent5 = { ...cardAction, eventSequence: 5, stateRevisionBefore: 4, stateRevisionAfter: 5,
		beforeDigest: cardAction.afterDigest, afterDigest: "ef".repeat(32), event: { ...cardAction.event,
			kind: "xingbei_native_transition_v2", name: "phaseLoop", nativeEventId: "native_event_" + "e".repeat(32) } };
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: unsupportedEvent5 })).code,
		"HOST_AUTHORITY_EVENT_REJECTED", "Event #5 remains disabled until a trusted schema-v2 seed and event-specific validator exist");
	assert.equal(f.manager.inspect(bootstrap.roomId).authorityStateRevision, 4,
		"an unsupported Event #5 must not advance the legacy authority revision");
	const publicSessionJson = JSON.stringify(cardCommitted.session);
	assert.equal(publicSessionJson.includes("handCommitment"), false, "public session inspection must not disclose hidden-hand commitments");
	assert.equal(Object.hasOwn(cardCommitted.session, "secret"), false, "public session inspection must not expose the managed-host secret field");
	assert.equal(Object.hasOwn(cardCommitted.session, "credential"), false, "public session inspection must not expose a credential field");
	assert.equal(/seatCredential|credentialDigest|seatToken/.test(publicSessionJson), false,
		"public session inspection must not disclose seat credential material");
	assert.ok(cardCommitted.session.authorityDigestChain.every(entry => Object.keys(entry).sort().join(",") === "afterDigest,beforeDigest,eventSequence"),
		"public authority-chain entries must contain only event sequencing and digests");
	const privateCommitments = [...openingDraw.event.seats.map(seat => seat.handCommitment), afterSeats[0].handCommitment];
	const exposedCommitmentFields = Object.entries(cardCommitted.session).filter(([, value]) =>
		privateCommitments.some(commitment => JSON.stringify(value).includes(commitment))).map(([key]) => key);
	assert.deepEqual(exposedCommitmentFields, [], "public session inspection leaked a hidden-hand commitment field");
	const replayed = f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", { proof: cardAction }));
	assert.equal(replayed.ok, true, "identical Event #4 retransmission must replay its ACK idempotently");
	assert.equal(replayed.idempotent, true);
	assert.equal(replayed.session.authorityStateRevision, 4);
	assert.equal(replayed.session.nextAuthorityEventSequence, 5);
	assert.equal(replayed.session.authorityDigestChain.length, 4, "idempotent ACK replay must not append an authority event");
	assert.equal(f.manager.commitAuthorityEvent(hostMessage(bootstrap, "host_authority_event", {
		proof: { ...cardAction, afterDigest: "cd".repeat(32) },
	})).code, "HOST_AUTHORITY_EVENT_REJECTED", "a changed Event #4 retransmission is not idempotent");
	await f.manager.stop("native_progress_gate");
});
