import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createV2NativeModuleTestServer } from "./fixtures/v2-native-module-test-server.mjs";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const { createManagedChoiceController } = require("../game/server-managed-choice-controller.js");
const { createManagedRoomSeatRegistry } = require("../game/server-managed-room-seat-registry.js");
const { createManagedV3SeatStateWebSocketGateway } = require("../game/server-managed-v3-seat-state-websocket-gateway.js");
const { createManagedV3RoomLifecycleCoordinator } = require("../game/server-managed-v3-room-lifecycle-coordinator.js");
const { prepareNextSeatChoice } = require("../game/server-managed-next-seat-choice-preparation.js");
const { assessEvent5Evidence } = require("../game/server-managed-authority-event5-provenance.js");
const { validateSeatStateMessage, validateCappedReadOnlySeatState } = require("../game/v3-seat-state-protocol.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "game/v2-managed-chromium-host.mjs");
const active = typeof process.env.V2_CHROMIUM === "string" && path.isAbsolute(process.env.V2_CHROMIUM);
let roomId = "native_choice_room";
let setup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `native_seat_${position + 1}`, position })) };
let immutableServerSeatIds = Object.freeze(setup.seats.map(({ seatId }) => seatId));
const viewasRevalidationFaultModes = ["viewas_material_removed_before_revalidation", "viewas_skill_removed_before_revalidation", "viewas_condition_invalid_before_revalidation"];
const viewasExecutionFaultModes = ["viewas_result_assignment_throws", "viewas_useCard_child_throws", "viewas_partial_effect_throws", "viewas_partial_effect_stop"];
// Keep this observation window aligned with the manager's independent browser,
// engine and game readiness budgets below. It must not abort before the manager
// can report its own bounded startup failure; these values do not extend any
// browser, native event, IPC or player-choice deadline.
// Chromium's own DevToolsActivePort bootstrap budget is 20s. Keep the manager's
// outer Browser Ready watchdog later so it cannot preempt the child at the same
// deadline and erase the child's precise startup result. This margin does not
// extend Chromium's internal boot, native-event, IPC, or player-choice deadlines.
const managedHostReadyBudgets = Object.freeze({ browserReadyTimeoutMs: 25000, engineReadyTimeoutMs: 30000, gameReadyTimeoutMs: 30000 });
const managedChoiceOpenObservationMs = Object.values(managedHostReadyBudgets).reduce((total, timeout) => total + timeout, 0) + 5000;

async function until(check, timeoutMs = 45000, diagnostic = () => null) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`condition timeout:${JSON.stringify(diagnostic())}`);
}

function receiveWebSocketMessage(socket, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("V3_SEAT_WS_MESSAGE_TIMEOUT")); }, timeoutMs);
		const onMessage = data => { clearTimeout(timer); socket.off("message", onMessage); resolve(JSON.parse(data.toString("utf8"))); };
		socket.on("message", onMessage);
	});
}

async function connectWebSocket(WebSocket, url) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
	return socket;
}

async function closeWebSocket(socket) {
	if (!socket || socket.readyState === 3) return;
	await new Promise(resolve => { socket.once("close", resolve); try { socket.close(); } catch (_) { resolve(); } });
}

function safeNativeDiagnostic(value) {
	const copy = JSON.parse(JSON.stringify(value));
	const scrub = node => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const entry of node) scrub(entry); return; }
		for (const key of Object.keys(node)) {
			if (/^(cardName|selectedCardName|handCommitment|secret|credential)$/i.test(key)) delete node[key];
			else scrub(node[key]);
		}
	};
	scrub(copy);
	return copy;
}

function safeChoiceHandlerFailure(type, error) {
	const location = typeof error?.stack === "string" ? error.stack.match(/v2-managed-native-choice-ipc\.mjs:(\d+):(\d+)/) : null;
	return { type: typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : "unknown",
		name: error?.name === "AssertionError" ? "AssertionError" : "Error",
		code: /^[A-Z][A-Z0-9_]{0,64}$/.test(error?.code || "") ? error.code : null,
		failureSite: location ? `${location[1]}:${location[2]}` : "unknown" };
}

test("managed Chromium applies four native Xingbei choices through authenticated controller IPC", { skip: !active, timeout: 90000 }, async t => {
	if (process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1") assert.equal(process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE, "1",
		"a held native phase boundary requires the managed native event-completion evidence source");
	const server = await createV2NativeModuleTestServer({ root });
	const old = Object.fromEntries(["V2_GAME_ORIGIN", "V2_PLAYABLE_PROOF", "V2_MANAGED_CHOICE_IPC", "V2_NATIVE_START_DIAGNOSTICS", "V2_NATIVE_PARENT_FENCE_AUDIT", "V2_NATIVE_PHASE_BOUNDARY_AUDIT", "V2_NATIVE_PHASE_BOUNDARY_FENCE", "V2_NATIVE_PHASE_BOUNDARY_STOP_AT_WAIT", "V2_NATIVE_PARENT_FENCE", "V2_NATIVE_REJECT_PARENT_FENCE_EVENT4", "V2_MANAGED_NATIVE_FAULT_INJECTION", "V2_NATIVE_OPENING_DRAW_EVENT3", "V2_NATIVE_REJECT_OPENING_DRAW_EVENT3", "V2_NATIVE_C3_UNIFIED_ROOT", "V2_NATIVE_TEST_RANDOM_SEED", "V2_NATIVE_ACTION_KIND", "V2_NATIVE_YINYANG_FIXTURE", "V2_NATIVE_RESOURCE_SHENGJI_FIXTURE", "V2_NATIVE_JIRIMO_FIXTURE", "V2_NATIVE_JIRIMO_ACTION_PROBE", "V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR", "V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE", "V2_NATIVE_YINYANG_VIEWAS_PROBE", "V2_NATIVE_MANAGED_YINYANG", "V2_NATIVE_RESPONSE_TARGETLESS_FIXTURE", "V2_NATIVE_CARD_LEDGER_PROBE", "V2_NATIVE_EFFECT_STOP_BARRIER", "V2_NATIVE_ATOMIC_CAPTURE_PROBE", "V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE", "V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE", "V2_NATIVE_EVENT_COMPLETION_SEQUENCE", "V2_NATIVE_MULTI_TURN_COMPLETION_SEQUENCE", "V2_NATIVE_QUOTA_RESET_AUDIT", "V2_NATIVE_DISCONNECT_ACTION_TO_TRUSTEE", "V2_V3_SEAT_STATE_PROJECTION_PROBE", "V2_V3_SEAT_STATE_WEBSOCKET_PROBE", "V2_V3_WEBSOCKET_ACTION_PROBE", "V2_V3_CAPPED_STATE_WEBSOCKET_PROBE", "V2_TEST_BLOCK_EXTERNAL_NETWORK", "V2_TEST_MATCH_RECORD_POST", "V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT", "V2_NATIVE_EVENT6_CONTINUATION_PROBE", "V2_NATIVE_EVENT7_CONTINUATION_PROBE"].map(key => [key, process.env[key]]));
	old.V2_NATIVE_EVENT8_CONTINUATION_PROBE = process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE;
	Object.assign(process.env, { V2_GAME_ORIGIN: server.origin, V2_PLAYABLE_PROOF: "1", V2_MANAGED_CHOICE_IPC: "1", V2_TEST_BLOCK_EXTERNAL_NETWORK: "1" });
	if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_input_controller_fault_before_apply") process.env.V2_MANAGED_NATIVE_FAULT_INJECTION = "before_native_apply";
	const nativeFaultMode = process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "";
	let manager, controller, sessionSecret, seatStateGateway = null, engineReadyProof = null, targetlessDeckFixtureProof = null, opened = [], candidatesSeen, nativeYinYangFixtureSeatId = null, nativeResourceFixtureSeatId = null, nativeJiRiFixtureSeatId = null, nativeResourceTransition = null, nativeActionChoice = null, nativeActionCandidate = null, nativeActionOptionId = null, nativeJiRiTargetChoice = null, nativeJiRiTargetCandidate = null, nativeJiRiTargetAckCount = 0, nativeJiRiTargetAckDropped = false, dropNativeJiRiTargetAckOnce = process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1", nativeLiveSnapshotAtInputGate = null, nativeNoOptionCandidateAvailable = false, nativeResponseChoice = null, nativeResponseCandidate = null, nativeResponseOptionId = null, nativeResponseChoices = [], nativeResponseAccepted = false, nativeResponseAckCount = 0, nativeResponseAckResults = [], nativeResponseAckAttempts = new Map(), droppedNativeResponseAckChoiceId = null, nativeResponseAckDropped = false, dropNativeResponseAckOnce = process.env.V2_NATIVE_RESPONSE_ACK_LOSS === "1", event3Proof = null, dropAcks = process.env.V2_NATIVE_REJECT_OPENING_DRAW_EVENT3 !== "1", dropNativeActionAckOnce = true, nativeActionAckDropped = false, droppedAcks = 0, nativeDiagnostic = [], ackCount = 0, nativeActionAckCount = 0, deliveryCount = 0, deliveryFailures = [], sessionEnds = [], managedChoiceHandlerFailures = [], applyingReceipts = [], applyingRetryIssued = false, viewasRedeliveryIssued = false, viewasRedeliveryIdentity = null, viewasBarrierReleasePromise = null, viewasBarrierReleased = false, nativeFaultStopPromise = null, event4AckDropCount = 0, event4SubmissionCount = 0, event4ProofSubmissions = [], event4AckBarrierWaitCount = 0, event4AckBarrierReleased = false, event4AuthorityJoinCount = 0, event4ControllerRetryTriggered = false, event4AckSendErrors = [], duplicateEvent4AuthorityAckSent = false, ackTrace = [], disconnectedActionHostIdentity = null;
	let event4AcceptedProjection = null;
	let nextSeatCandidateInspection = null, nextSeatCandidateMessage = null, nextSeatPreparation = null, event5CandidateMessage = null, event5Choice = null, event5NativeActionAckCount = 0,
		event6CandidateMessage = null, event6Choice = null, event6NativeActionAckCount = 0, event6PreActionCapture = null, event6PostCaptureObserved = null,
		event7CandidateMessage = null, event7Choice = null, event7NativeActionAckCount = 0,
		event8CandidateMessage = null, event8Choice = null, event8NativeActionAckCount = 0;
	let event5ReviewAfterGatewayRebind = null;
	let nativeHostPidAtFirstCandidate = null, nativeChromiumPidAtFirstCandidate = null;
	let firstAtomicCapture = null, firstAtomicRepeat = null, atomicCaptureSessionId = null, atomicCapturePid = null, atomicChromiumPid = null;
	let nativeCardLedgerBefore = null, nativeCardLedgerAfter = null, nativeCardLedgerFailures = [];
	const nativeCardLedgerCaptureContexts = [];
	let nativeEffectStateBefore = null, nativeEffectStateAfter = null, nativeEffectStateRepeat = null, nativeEffectStateAfterPromise = null,
		nativeEffectStateFailures = [];
	let nativeEffectStopSnapshotPromise = null, nativeEffectStopSnapshotSettled = false;
	let nativePreActionCapture = null;
	const droppedChoiceAckIds = new Set();
	const authoritySubmissions = [];
	let releaseEvent4AckBarrier;
	const event4AckBarrier = new Promise(resolve => { releaseEvent4AckBarrier = resolve; });
	const launchedHandles = new Map();
	const event6LogStage = stage => {
		if (process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE !== "1") return;
		const safeStage = typeof stage === "string" && /^[a-z0-9_:.-]{1,128}$/.test(stage) ? stage : "invalid_stage";
		const line = `event6-test-progress:${new Date().toISOString()}:${safeStage}\n`;
		process.stderr.write(line);
		const diagnosticFile = process.env.V2_NATIVE_EVENT6_DIAGNOSTIC_FILE;
		const diagnosticsRoot = path.resolve(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir());
		if (typeof diagnosticFile === "string" && path.isAbsolute(diagnosticFile) && path.dirname(path.resolve(diagnosticFile)) === diagnosticsRoot &&
			["event6-progress.log", "event7-progress.log", "event8-progress.log"].includes(path.basename(diagnosticFile))) {
			appendFileSync(diagnosticFile, line, { encoding: "utf8", mode: 0o600 });
		}
	};
	const logEvent6Message = (type, stage = null) => {
		if (process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE !== "1") return;
		const safeType = typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : "unknown";
		const safeStage = typeof stage === "string" && /^[a-z0-9_]{1,96}$/.test(stage) ? stage : null;
		event6LogStage(`host-message:${safeType}${safeStage ? `:${safeStage}` : ""}`);
	};
	event6LogStage("test-start");
	const disconnectActionToTrustee = process.env.V2_NATIVE_DISCONNECT_ACTION_TO_TRUSTEE === "1";
	const useSeatRegistry = disconnectActionToTrustee || process.env.V2_V3_SEAT_STATE_WEBSOCKET_PROBE === "1" || process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1" || process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1" || process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" || process.env.V2_NATIVE_START_PROBE_MODE === "managed_native_skill_candidate_probe" || process.env.V2_NATIVE_START_PROBE_MODE === "managed_input_controller_registry" ||
		process.env.V2_NATIVE_RESPONSE_REBIND === "1";
	const lifecycleE2E = process.env.V2_V3_ROOM_LIFECYCLE_E2E === "1";
	const seatRegistry = useSeatRegistry || lifecycleE2E ? createManagedRoomSeatRegistry() : null;
	const seatCredentials = new Map(), seatSockets = new Map();
	if (seatRegistry) {
		if (!lifecycleE2E) {
			assert.equal(seatRegistry.createRoom(roomId, setup.seats.map(seat => seat.seatId)), true);
			for (const seat of setup.seats) seatCredentials.set(seat.seatId, seatRegistry.issueSeat(roomId, seat.seatId).credential);
		}
	}
	let lifecycleCoordinator = null, lifecycleGatewayAddress = null;
	const credentialFor = seatId => seatCredentials.get(seatId) || `credential_${seatId}`;
	const bindSeat = (seatId, connectionId) => {
		if (!seatRegistry) return controller.bindSeatConnection({ roomId, seatId, connectionId, serverProof: connectionId });
		if (lifecycleCoordinator) {
			const rebound = lifecycleCoordinator.joinSeat({ roomId, seatId, credential: credentialFor(seatId), connectionId,
				principal: { kind: "ordinary_player" } });
			return rebound.ok ? controller.bindSeatConnection(rebound.binding) : rebound;
		}
		const current = seatSockets.get(seatId);
		if (current) assert.equal(seatRegistry.disconnect({ roomId, seatId, connectionId: current }), true);
		const binding = seatRegistry.bindConnection({ roomId, seatId, credential: credentialFor(seatId),
			socket: { kind: "player", roomId, seatId, connectionId } });
		assert.ok(binding, `seat registry refused ${seatId} connection ${connectionId}`);
		seatSockets.set(seatId, connectionId);
		return controller.bindSeatConnection(binding);
	};
	controller = createManagedChoiceController({
		// Keep production retry cadence under this test. A short (250ms) test-only
		// retry interval races the four opening-seat deliveries on slower runners,
		// before the response ACK-loss scenario has even begun.
		deliveryRetryMs: 3000,
		isHostSessionActive: (candidateRoom, sessionId) => manager?.inspect(candidateRoom)?.sessionId === sessionId && manager.inspect(candidateRoom)?.state === "playable_probe",
		authorizeManagedHost: message => message.hostProof === sessionSecret,
		authorizeSeatBinding: message => seatRegistry ? seatRegistry.authorizeSeatBinding(message) : message.serverProof === message.connectionId,
		authenticateSeat: (message, record) => seatRegistry ? seatRegistry.authenticateSeat(message, record) : message.credential === credentialFor(record.seatId),
		onResolved: choice => {
			deliveryCount++;
			if (process.env.V2_NATIVE_C3_FULL_CHAIN === "1") {
				const encoded = JSON.stringify(choice);
				assert.equal(encoded.includes("handCommitment"), false, "player-choice delivery must not contain hand commitments");
				assert.equal(encoded.includes(sessionSecret), false, "player-choice delivery must not contain the managed-host secret");
				for (const credential of seatCredentials.values()) assert.equal(encoded.includes(credential), false,
					"player-choice delivery must not contain seat credentials");
			}
			return manager.sendChoiceDelivery(roomId, choice).then(result => result.ok);
		},
		onDeliveryFailed: choice => { deliveryFailures.push({ choiceId: choice.choiceId, nativeEventId: choice.nativeEventId,
			seatId: choice.seatId, deliveryAttempts: choice.deliveryAttempts, code: choice.deliveryFailureCode }); void manager.stop(choice.roomId, "choice_delivery_failed"); },
	});
	manager = createHostSessionManager({
		experimentalAuthorityEventLimit: [5, 6, 7, 8].includes(Number(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT))
			? Number(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) : 4,
		isManagedChoicePending: input => {
			const choice = controller?.inspect(input.roomId, input.choiceId);
			return Boolean(choice && choice.state === "pending" && choice.deliveryId === null && choice.roomId === input.roomId &&
				choice.hostSessionId === input.hostSessionId && choice.nativeEventId === input.nativeEventId &&
				choice.seatId === input.seatId && choice.eventSequence === input.eventSequence);
		},
		hasPendingManagedChoices: () => controller?.pendingCount() > 0,
		getManagedChoice: input => controller?.findPendingChoice(input) || null,
		authorizeSeatBinding: binding => Boolean(seatRegistry?.authorizeSeatBinding(binding)),
		getCurrentSeatBinding: (candidateRoom, seatId) => {
			if (!seatRegistry || candidateRoom !== roomId) return null;
			const connectionId = seatSockets.get(seatId), seat = seatRegistry.inspect(candidateRoom, seatId);
			if (!connectionId || !seat) return null;
			const credentialAuthenticated = seatRegistry.authenticateSeat({ roomId: candidateRoom, seatId, connectionId,
				credential: credentialFor(seatId) }, { roomId: candidateRoom, seatId });
			return Object.freeze({ roomId: candidateRoom, seatId, connected: seat.connected, current: seat.connected && !seat.revoked,
				credentialAuthenticated, ordinaryPlayer: true, connectionGeneration: seat.epoch });
		},
		authorizeSeatStateRequest: ({ roomId: candidateRoom, recipientSeatId, request }) => {
			if (!seatRegistry || candidateRoom !== roomId || !request || Object.getPrototypeOf(request) !== Object.prototype ||
				Object.keys(request).sort().join(",") !== "connectionId,credential" || request.connectionId !== seatSockets.get(recipientSeatId) ||
				!seatRegistry.authenticateSeat({ roomId: candidateRoom, seatId: recipientSeatId, connectionId: request.connectionId,
					credential: request.credential }, { roomId: candidateRoom, seatId: recipientSeatId })) return null;
			const seat = seatRegistry.inspect(candidateRoom, recipientSeatId);
			return seat ? Object.freeze({ roomId: candidateRoom, seatId: recipientSeatId, connected: seat.connected,
				current: seat.connected && !seat.revoked, credentialAuthenticated: true, ordinaryPlayer: true,
				connectionGeneration: seat.epoch }) : null;
		},
		launch: async bootstrap => {
			const handle = await createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 })(bootstrap);
			launchedHandles.set(bootstrap.sessionId, handle);
			handle.on("message", message => {
				if (message?.type === "host_engine_ready") engineReadyProof = message.proof;
				if (message?.type === "host_authority_event") {
					// Preserve the exact proof as received from the supervised IPC boundary.
					// Later test assertions/replays must not retain a mutable alias to the
					// message object shared with other in-process listeners.
					authoritySubmissions.push({ roomId: message.roomId, sessionId: message.sessionId, proof: structuredClone(message.proof),
						resourcePids: handle.resources().map(resource => resource.pid) });
				}
				if (message?.type === "host_authority_event" && message.proof?.event?.kind === "xingbei_opening_draw_v1") event3Proof = message.proof;
				if (message?.type === "host_authority_event" && message.proof?.event?.kind === "xingbei_native_card_action_v1") {
					event4SubmissionCount++;
					event4ProofSubmissions.push(JSON.stringify(message.proof));
					if (process.env.V2_NATIVE_REJECT_PARENT_FENCE_EVENT4 === "1") {
						message.proof.afterDigest = "0".repeat(64);
						event4ProofSubmissions[event4ProofSubmissions.length - 1] = JSON.stringify(message.proof);
					}
				}
			});
			const sendHostCommand = handle.sendHostCommand.bind(handle);
		handle.sendHostCommand = async command => {
			if (process.env.V2_NATIVE_T4_DELTA_AUDIT === "1" && command?.type === "host_authority_event_ack" &&
				command.accepted === true && command.eventSequence === 4 && command.stateRevision === 4 && !event4AcceptedProjection) {
				const priorSnapshots = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot").length;
				const requested = await manager.snapshotNativeStart(roomId, "managed_opening_root_action_event4");
				if (!requested.ok) throw new Error(`T4_EVENT4_SNAPSHOT_REQUEST_REJECTED:${requested.code}`);
				const acceptedSnapshot = await until(() => { const snapshots = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot");
					return snapshots.length > priorSnapshots ? snapshots.at(-1) : null; }, 3000,
					() => ({ stage: "T4_EVENT4_ACCEPTED_SNAPSHOT_TIMEOUT", host: manager.inspect(roomId), stages: nativeDiagnostic.slice(-12) }));
				const audit = acceptedSnapshot.projectionAudit;
				if (acceptedSnapshot.rootInstanceId == null || acceptedSnapshot.nativeParentFence?.status !== "waiting" ||
					audit?.candidateDisposition !== "diagnostic_only_not_a_proof" || audit?.authorized !== false ||
					manager.inspect(roomId)?.authorityStateRevision !== 4 || manager.inspect(roomId)?.authorityStateDigest !== command.afterDigest) {
					throw new Error("T4_EVENT4_ACCEPTED_SNAPSHOT_BINDING_REJECTED");
				}
				event4AcceptedProjection = Object.freeze({ rootInstanceId: acceptedSnapshot.rootInstanceId,
					afterDigest: command.afterDigest, projectionAudit: audit, checkpointAvailable: manager.inspect(roomId).checkpointAvailable });
			}
			if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_opening_root_action_event4_ack_loss" &&
				command?.type === "host_authority_event_ack" && command.eventSequence === 4 && event4AckDropCount === 0) {
				event4AckDropCount++;
				return;
			}
			if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_opening_root_action_event4_ack_loss" &&
				command?.type === "host_authority_event_ack" && command.eventSequence === 4 && event4AckDropCount === 1) {
				event4AckBarrierWaitCount++;
				if (!event4ControllerRetryTriggered) {
					event4ControllerRetryTriggered = true;
					if (!nativeActionChoice || !["delivery_pending", "applying"].includes(controller.inspect(roomId, nativeActionChoice.choiceId)?.state)) {
						throw new Error("EVENT4_ACK_BARRIER_CHOICE_NOT_PENDING");
					}
					// This explicit test barrier creates the ACK-loss interleaving deterministically.
					// Production still exercises its bounded automatic retries; the injection only
					// ensures Chromium receives the duplicate immutable delivery before ACK release.
					const retry = controller.retryDelivery({ roomId, choiceId: nativeActionChoice.choiceId });
					if (!retry.ok) throw new Error(`EVENT4_ACK_BARRIER_RETRY_FAILED:${retry.code}`);
				}
				await event4AckBarrier;
			}
			try {
				const result = await sendHostCommand(command);
				if (process.env.V2_NATIVE_PARENT_FENCE === "1" &&
					process.env.V2_NATIVE_START_PROBE_MODE === "managed_opening_root_action_event4_ack_loss" &&
					command?.type === "host_authority_event_ack" && command.eventSequence === 4 && !duplicateEvent4AuthorityAckSent) {
					duplicateEvent4AuthorityAckSent = true;
					// Replay the exact authenticated ACK after the one-shot native waiter has
					// consumed it; this must be inert and cannot release the parent twice.
					await sendHostCommand(command);
				}
				return result;
			} catch (error) {
				if (command?.type === "host_authority_event_ack" && command.eventSequence === 4) event4AckSendErrors.push(String(error?.message || "unknown").slice(0, 96));
				throw error;
			}
			};
			return handle;
		},
		...managedHostReadyBudgets,
		onSessionEnd: event => { sessionEnds.push({ roomId: event.roomId, sessionId: event.sessionId, state: event.state, code: event.code });
			controller.cleanupHostSession(event.roomId, event.sessionId); },
		onManagedChoiceMessage: async ({ type, message }) => {
			logEvent6Message(type, message?.observed?.stage);
			try {
		if (type === "host_native_action_candidates" && message?.eventSequence === 6) {
			assert.equal(process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE, "1");
			assert.ok(["6", "7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT));
				assert.equal(process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK, "1");
				assert.equal(manager.inspect(roomId)?.authorityStateRevision, 5);
				assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 6);
				assert.equal(manager.inspect(roomId)?.lastAuthorityEvent?.sequence, 5);
				assert.equal(message.eventName, "gongJiOrFaShu");
				assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64);
				assert.equal(new Set(message.options).size, message.options.length);
				assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
				assert.deepEqual(Object.keys(message.optionKinds).sort(), [...message.options].sort());
				assert.deepEqual(Object.keys(message.optionCardNames).sort(), [...message.options].sort());
				assert.deepEqual(Object.keys(message.optionTargetSeatIds).sort(), [...message.options].sort());
				assert.ok(message.options.every(option => ["gongJi", "faShu"].includes(message.optionKinds[option]) &&
					typeof message.optionCardNames[option] === "string" &&
					setup.seats.some(seat => seat.seatId === message.optionTargetSeatIds[option]) &&
					message.optionTargetSeatIds[option] !== message.seatId));
				assert.notEqual(message.seatId, event5CandidateMessage?.seatId, "Event #6 must belong to the next native actor");
				const candidate = controller.inspectNativeCandidateSet({ protocol: 1, kind: "managed_host", roomId,
					hostSessionId: message.sessionId, rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventName: message.eventName, options: message.options,
					optionKinds: message.optionKinds, hostProof: message.secret });
				assert.equal(candidate.ok, true, `Event #6 native candidate authentication failed: ${candidate.code}`);
				assert.equal(candidate.seatId, message.seatId);
				assert.ok(seatRegistry, "Event #6 must use the ordinary-seat registry");
				const currentConnection = seatSockets.get(message.seatId);
				assert.ok(currentConnection);
				assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: message.seatId, connectionId: currentConnection,
					credential: credentialFor(message.seatId) }, { roomId, seatId: message.seatId }), true);
			event6CandidateMessage = Object.freeze({ ...message, options: Object.freeze([...message.options]),
				optionKinds: Object.freeze({ ...message.optionKinds }), optionCardNames: Object.freeze({ ...message.optionCardNames }),
				optionTargetSeatIds: Object.freeze({ ...message.optionTargetSeatIds }) });
			return;
		}
		if (type === "host_native_action_candidates" && message?.eventSequence === 7) {
			assert.equal(process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE, "1");
			assert.ok(["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT));
			assert.equal(manager.inspect(roomId)?.authorityStateRevision, 6);
			assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 7);
			assert.equal(manager.inspect(roomId)?.lastAuthorityEvent?.sequence, 6);
			assert.equal(message.eventName, "gongJiOrFaShu");
			assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64);
			assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
			assert.deepEqual(Object.keys(message.optionKinds).sort(), [...message.options].sort());
			assert.deepEqual(Object.keys(message.optionCardNames).sort(), [...message.options].sort());
			assert.deepEqual(Object.keys(message.optionTargetSeatIds).sort(), [...message.options].sort());
			assert.ok(message.options.every(option => ["gongJi", "faShu"].includes(message.optionKinds[option]) &&
				setup.seats.some(seat => seat.seatId === message.optionTargetSeatIds[option]) && message.optionTargetSeatIds[option] !== message.seatId));
			assert.notEqual(message.seatId, event6CandidateMessage?.seatId, "Event #7 must belong to a different native actor than Event #6");
			const candidate = controller.inspectNativeCandidateSet({ protocol: 1, kind: "managed_host", roomId,
				hostSessionId: message.sessionId, rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId,
				seatId: message.seatId, eventName: message.eventName, options: message.options, optionKinds: message.optionKinds, hostProof: message.secret });
			assert.equal(candidate.ok, true, `Event #7 native candidate authentication failed: ${candidate.code}`);
			const connectionId = seatSockets.get(message.seatId);
			assert.ok(connectionId && seatRegistry?.inspect(roomId, message.seatId)?.connected);
			assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: message.seatId, connectionId,
				credential: credentialFor(message.seatId) }, { roomId, seatId: message.seatId }), true);
		event7CandidateMessage = Object.freeze({ ...message, options: Object.freeze([...message.options]),
				optionKinds: Object.freeze({ ...message.optionKinds }), optionCardNames: Object.freeze({ ...message.optionCardNames }),
				optionTargetSeatIds: Object.freeze({ ...message.optionTargetSeatIds }) });
			return;
		}
		if (type === "host_native_action_candidates" && message?.eventSequence === 8) {
			assert.equal(process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE, "1");
			assert.equal(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT, "8");
			assert.equal(manager.inspect(roomId)?.authorityStateRevision, 7);
			assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 8);
			assert.equal(manager.inspect(roomId)?.lastAuthorityEvent?.sequence, 7);
			assert.equal(message.eventName, "gongJiOrFaShu");
			assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64);
			assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
			assert.deepEqual(Object.keys(message.optionKinds).sort(), [...message.options].sort());
			assert.deepEqual(Object.keys(message.optionCardNames).sort(), [...message.options].sort());
			assert.deepEqual(Object.keys(message.optionTargetSeatIds).sort(), [...message.options].sort());
			assert.ok(message.options.every(option => ["gongJi", "faShu"].includes(message.optionKinds[option]) &&
				setup.seats.some(seat => seat.seatId === message.optionTargetSeatIds[option]) && message.optionTargetSeatIds[option] !== message.seatId));
			assert.notEqual(message.seatId, event7CandidateMessage?.seatId, "Event #8 must belong to a different native actor than Event #7");
			const candidate = controller.inspectNativeCandidateSet({ protocol: 1, kind: "managed_host", roomId,
				hostSessionId: message.sessionId, rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId,
				seatId: message.seatId, eventName: message.eventName, options: message.options, optionKinds: message.optionKinds, hostProof: message.secret });
			assert.equal(candidate.ok, true, `Event #8 native candidate authentication failed: ${candidate.code}`);
			const connectionId = seatSockets.get(message.seatId);
			assert.ok(connectionId && seatRegistry?.inspect(roomId, message.seatId)?.connected);
			assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: message.seatId, connectionId,
				credential: credentialFor(message.seatId) }, { roomId, seatId: message.seatId }), true);
			event8CandidateMessage = Object.freeze({ ...message, options: Object.freeze([...message.options]),
				optionKinds: Object.freeze({ ...message.optionKinds }), optionCardNames: Object.freeze({ ...message.optionCardNames }),
				optionTargetSeatIds: Object.freeze({ ...message.optionTargetSeatIds }) });
			return;
		}
			if (type === "host_native_action_candidates" && message?.eventSequence === 5) {
				assert.equal(process.env.V2_NATIVE_START_PROBE_MODE, "managed_opening_root_action_event5");
				assert.ok(["5", "6", "7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT),
					"the isolated ceiling must permit Event #5 without exceeding the configured maximum");
				assert.equal(process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK, "1");
				assert.equal(manager.inspect(roomId)?.authorityStateRevision, 4);
				assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 5);
				assert.equal(message.eventName, "gongJiOrFaShu");
				assert.ok(Array.isArray(message.options) && message.options.length > 0);
				assert.deepEqual(Object.keys(message.optionKinds).sort(), [...message.options].sort());
				assert.deepEqual(Object.keys(message.optionCardNames).sort(), [...message.options].sort());
				assert.deepEqual(Object.keys(message.optionTargetSeatIds).sort(), [...message.options].sort());
				assert.ok(message.options.every(option => ["gongJi", "faShu"].includes(message.optionKinds[option]) &&
					setup.seats.some(seat => seat.seatId === message.optionTargetSeatIds[option]) && message.optionTargetSeatIds[option] !== message.seatId));
				const authenticatedCandidate = controller.inspectNativeCandidateSet({ protocol: 1, kind: "managed_host", roomId,
					hostSessionId: message.sessionId, rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventName: message.eventName, options: message.options,
					optionKinds: message.optionKinds, hostProof: message.secret });
				assert.equal(authenticatedCandidate.ok, true,
					`Event #5 options must be independently authenticatable before the later read-only gate diagnostic arrives: ${authenticatedCandidate.code}`);
				assert.ok(setup.seats.some(seat => seat.seatId === message.seatId), "successor action candidate must name an immutable ordinary seat");
				event5CandidateMessage = Object.freeze({ ...message, options: Object.freeze([...message.options]),
					optionKinds: Object.freeze({ ...message.optionKinds }), optionCardNames: Object.freeze({ ...message.optionCardNames }),
					optionTargetSeatIds: Object.freeze({ ...message.optionTargetSeatIds }) });
				nextSeatCandidateInspection = Object.freeze({ ok: true, seatId: message.seatId, eventName: message.eventName,
					optionCount: message.options.length, rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId,
					eventSequence: message.eventSequence, source: "authenticated_event5_action_candidate" });
				nextSeatCandidateMessage = event5CandidateMessage;
				return;
			}
			if (type === "host_native_input_candidates_diagnostic") {
				assert.equal(process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE, "1");
				assert.deepEqual(Object.keys(message.optionCardNames).sort(), [...message.options].sort(),
					"private successor routing must retain native card metadata for every opaque option");
				assert.deepEqual(Object.keys(message.optionTargetSeatIds).sort(), [...message.options].sort(),
					"private successor routing must retain native target metadata for every opaque option");
				assert.ok(message.options.every(option => setup.seats.some(seat => seat.seatId === message.optionTargetSeatIds[option])));
				const candidate = controller.inspectNativeCandidateSet({ protocol: 1, kind: "managed_host", roomId,
					hostSessionId: message.sessionId, rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventName: message.eventName, options: message.options, optionKinds: message.optionKinds,
					hostProof: message.secret });
				assert.equal(candidate.ok, true, `read-only next-seat candidate inspection rejected: ${candidate.code}`);
				assert.ok(seatRegistry, "the diagnostic input must be backed by the Seat Registry");
				const connectionId = seatSockets.get(message.seatId);
				assert.ok(connectionId, "next actor must have a current ordinary-player connection binding");
				assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: message.seatId, connectionId,
					credential: credentialFor(message.seatId) }, { roomId, seatId: message.seatId }), true);
				nextSeatCandidateInspection = candidate;
				nextSeatCandidateMessage = Object.freeze({ type: message.type, roomId: message.roomId, sessionId: message.sessionId,
					rootInstanceId: message.rootInstanceId, nativeEventId: message.nativeEventId, eventName: message.eventName,
					eventInstanceId: message.eventInstanceId, parentEventInstanceId: message.parentEventInstanceId,
					waitingCompletionOrdinal: message.waitingCompletionOrdinal,
					seatId: message.seatId, options: Object.freeze([...message.options]),
					optionKinds: Object.freeze({ ...message.optionKinds }) });
				return;
			}
			if (type === "host_choice_diagnostic" && message?.observed?.stage === "native_targetless_deck_fixture_ready") {
				targetlessDeckFixtureProof = message.observed;
				if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
					assert.equal(targetlessDeckFixtureProof.kind, "native_jirimo_spell_hand_fixture_v1");
					assert.equal(targetlessDeckFixtureProof.allSeatsReceiveNativeSpell, true);
					assert.equal(targetlessDeckFixtureProof.fixtureOnly, true);
					assert.equal(targetlessDeckFixtureProof.formalRandomnessUnchanged, true);
					assert.equal(targetlessDeckFixtureProof.selectedNativeEntries, 16);
					assert.deepEqual(targetlessDeckFixtureProof.openingHandSlots, Array.from({ length: 16 }, (_, index) => index));
				} else assert.equal(targetlessDeckFixtureProof.kind, "native_card_pile_order_fixture_v1");
				if (process.env.V2_NATIVE_JIRIMO_FIXTURE !== "1") {
					assert.equal(targetlessDeckFixtureProof.selectedNativeEntries, 4);
					assert.deepEqual(targetlessDeckFixtureProof.openingHandSlots, [0, 4, 8, 12]);
				}
				assert.equal(targetlessDeckFixtureProof.nativeCardCreation, true);
				assert.equal(targetlessDeckFixtureProof.nativeGameDraw, true);
			}
			if (type === "host_choice_diagnostic" && message?.observed?.stage === "native_successor_card_action_event_6_accepted") {
				event6PostCaptureObserved = message.observed.snapshot || null;
			}
			if (type === "host_choice_diagnostic" && message?.observed?.stage === "test_network_guard_verified") {
				engineReadyProof = { ...engineReadyProof, testMatchRecordPostBlocked: message.observed.blockedPostCount };
			}
			if (type === "host_choice_delivery_started") {
				const marked = controller.markDeliveryApplying({ ...message, hostSessionId: message.sessionId, hostProof: sessionSecret });
				assert.equal(marked.ok, true, `authenticated native delivery receipt rejected: ${marked.code}`);
				applyingReceipts.push({ choiceId: message.choiceId, deliveryId: message.deliveryId, nativeEventId: message.nativeEventId });
				const managedResponseForDelivery = nativeResponseChoices.find(entry => entry.choice.choiceId === message.choiceId);
				if ([...viewasRevalidationFaultModes, ...viewasExecutionFaultModes].includes(nativeFaultMode) &&
					managedResponseForDelivery?.candidate?.optionKinds?.[managedResponseForDelivery.option] === "view_as_skill" && !viewasRedeliveryIssued) {
					const beforeRetry = controller.inspect(roomId, message.choiceId);
					assert.equal(beforeRetry?.state, "applying");
					viewasRedeliveryIdentity = { choiceId: beforeRetry.choiceId, deliveryId: beforeRetry.deliveryId,
						nativeEventId: beforeRetry.nativeEventId, option: beforeRetry.resolution?.option };
					viewasRedeliveryIssued = true;
					assert.equal(controller.retryDelivery({ roomId, choiceId: message.choiceId }).ok, true,
						"the unchanged native viewAs delivery should be safely fenced when retried while applying");
					const afterRetry = controller.inspect(roomId, message.choiceId);
					assert.deepEqual({ choiceId: afterRetry.choiceId, deliveryId: afterRetry.deliveryId,
						nativeEventId: afterRetry.nativeEventId, option: afterRetry.resolution?.option }, viewasRedeliveryIdentity,
					"a retry must retain the immutable original native skill result identity");
					if (viewasExecutionFaultModes.includes(nativeFaultMode)) {
						const faultHandle = launchedHandles.get(message.sessionId);
						assert.ok(faultHandle, "native skill delivery has no supervised child handle");
					viewasBarrierReleasePromise = faultHandle.sendHostCommand({ kind: "managed_host", type: "host_native_fault_release",
						protocol: 1, roomId, sessionId: message.sessionId, secret: sessionSecret,
						choiceId: message.choiceId, deliveryId: message.deliveryId });
					}
				}
			} else if (type === "host_choice_candidates") {
				sessionSecret = message.secret;
				candidatesSeen = message.choices;
				if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1") {
					nativeYinYangFixtureSeatId = message.yinyangFixture?.seatId || null;
					assert.equal(message.yinyangFixture?.nativeCandidateGenerated, true);
					assert.ok(message.choices.some(choice => choice.seatId === nativeYinYangFixtureSeatId && choice.options.includes("yinYangShi")),
						"yinYangShi must be supplied by the real native chooseCharacterOL candidate map");
				}
				if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
					nativeResourceFixtureSeatId = message.resourceFixture?.seatId || null;
					assert.equal(message.resourceFixture?.nativeCandidateGenerated, true);
					assert.ok(message.choices.some(choice => choice.seatId === nativeResourceFixtureSeatId && choice.options.includes("shengQiangQiShi")),
						"shengQiangQiShi must come from the native chooseCharacterOL candidate map");
					assert.equal(nativeResourceFixtureSeatId, message.firstActSeatId,
						"resource fixture character must be assigned to the native first actor");
				}
				if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
					nativeJiRiFixtureSeatId = message.jiRiFixture?.seatId || null;
					assert.equal(message.jiRiFixture?.nativeCandidateGenerated, true);
					assert.ok(message.choices.some(choice => choice.seatId === nativeJiRiFixtureSeatId && choice.options.includes("jieRiMoDao")),
						"jieRiMoDao must be selected from the original native chooseCharacterOL candidate map");
					assert.equal(nativeJiRiFixtureSeatId, message.firstActSeatId);
				}
				for (const candidate of message.choices) {
					const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
						seatId: candidate.seatId, eventSequence: message.eventSequence, options: candidate.options, trusteeOption: candidate.options[0],
						deadlineAt: Date.now() + 3000, hostProof: sessionSecret });
					assert.equal(openedChoice.ok, true); opened.push(openedChoice.choice);
					assert.equal(bindSeat(candidate.seatId, `conn_${candidate.seatId}`).ok, true);
				}
			} else if (type === "host_native_action_candidates") {
				sessionSecret = message.secret;
				const firstActionHost = launchedHandles.get(message.sessionId);
				if (firstActionHost) { nativeHostPidAtFirstCandidate = firstActionHost.pid; nativeChromiumPidAtFirstCandidate = firstActionHost.resources()[0]?.pid ?? null; }
				assert.equal(message.eventName, "gongJiOrFaShu");
				assert.equal(message.eventSequence, 4, "first action choice must reserve native authority event #4 after opening-state event #3");
				assert.match(message.nativeEventId, /^native_[A-Za-z0-9_-]{16,96}$/);
				assert.equal(message.seatId, setup.seats.find(seat => seat.seatId === message.seatId)?.seatId);
				assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64);
				assert.equal(new Set(message.options).size, message.options.length);
				assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
				if (process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1") {
					nativeCardLedgerCaptureContexts.push({ ordinal: 1, mode: "pre_native_action", boundary: "native_action_candidates",
						nativeEventId: message.nativeEventId, eventSequence: message.eventSequence, nativeCompletionOrdinal: null });
					const result = await manager.snapshotNativeCardLedger(roomId, "pre_native_action");
					if (!result.ok) nativeCardLedgerFailures.push({ stage: "pre_native_action", code: result.code });
					assert.equal(result.ok, true, `private native card ledger baseline failed: ${result.code}`);
					nativeCardLedgerBefore = result.snapshot;
					assert.equal(nativeCardLedgerBefore.snapshotOrdinal, 1);
					assert.equal(nativeCardLedgerBefore.virtualCardsIncluded, false);
				}
				if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_native_skill_candidate_probe") {
					assert.equal(process.env.V2_NATIVE_JIRIMO_FIXTURE, "1");
					assert.ok(message.skillCandidateCount >= 1, "the exact fixture skill should produce a bounded native candidate for a legal enemy target");
					assert.equal(message.optionKinds && Object.values(message.optionKinds).filter(kind => kind === "native_skill").length, message.skillCandidateCount);
					nativeActionOptionId = message.options.find(option => message.optionKinds[option] === "native_skill");
					assert.ok(nativeActionOptionId, "native legal skill option was not routed to the controller");
					assert.ok(message.optionTargetSeatIds?.[nativeActionOptionId]);
					assert.equal(message.optionNativeTargetSpellEligible?.[nativeActionOptionId], true,
						"the selected target must actually hold a native-dealt spell accepted by the skill's discard branch");
					assert.notEqual(message.optionTargetSeatIds[nativeActionOptionId], message.seatId,
						"the native skill target must be a different ordinary seat");
				} else if (process.env.V2_NATIVE_ACTION_KIND) {
					assert.ok(["gongJi", "faShu"].includes(process.env.V2_NATIVE_ACTION_KIND),
						"native action kind must be an allowlisted Xingbei card category");
					nativeActionOptionId = message.options.find(option => message.optionKinds[option] === process.env.V2_NATIVE_ACTION_KIND);
					assert.ok(nativeActionOptionId,
						`native event produced no legal ${process.env.V2_NATIVE_ACTION_KIND} action candidate`);
				} else if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1" && process.env.V2_NATIVE_RESPONSE_NO_OPTIONS === "1") {
					assert.ok(Array.isArray(message.responseProbeOptions), "native response eligibility evidence was not supplied");
					nativeActionOptionId = message.options.find(option => message.optionKinds[option] === "gongJi" && !message.responseProbeOptions.includes(option));
					nativeNoOptionCandidateAvailable = Boolean(nativeActionOptionId);
					nativeActionOptionId ||= message.options.find(option => message.optionKinds[option] === "gongJi");
					assert.ok(nativeActionOptionId, "seeded native opening did not produce a legal native gongJi action candidate");
				} else if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1" && process.env.V2_NATIVE_MANAGED_YINYANG === "1") {
					assert.ok(message.optionTargetSeatIds && Object.keys(message.optionTargetSeatIds).length === message.options.length,
						"fixture action target map must be derived from the actual native card/target candidate mapping");
					const eligibleOptions = message.options.filter(option => message.optionKinds[option] === "gongJi" &&
						message.optionTargetSeatIds[option] === nativeYinYangFixtureSeatId && message.optionYinYangEligible?.[option] === true);
					if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1") {
						assert.ok(Array.isArray(message.responseProbeOptions));
						nativeActionOptionId = eligibleOptions.find(option => message.responseProbeOptions.includes(option));
					} else nativeActionOptionId = eligibleOptions[0];
					assert.ok(nativeActionOptionId, "native action must target the YinYang fixture seat with an attack accepted by the original response predicates");
				} else if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
					assert.ok(Array.isArray(message.responseProbeOptions) && message.responseProbeOptions.length > 0,
						"resource transition fixture requires a real native attack whose target has a legal response gate");
					nativeActionOptionId = message.responseProbeOptions.find(option => message.optionKinds[option] === "gongJi");
					assert.ok(nativeActionOptionId, "shengJi fixture must use a legal native gongJi action");
				} else if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1") {
					assert.ok(Array.isArray(message.responseProbeOptions) && message.responseProbeOptions.length > 0,
						"test could not select a native attack whose target has a card accepted by the native yingZhan response predicate");
					nativeActionOptionId = message.responseProbeOptions.find(option => message.optionKinds[option] === "gongJi");
					assert.ok(nativeActionOptionId, "response-capable target candidate must be an attack card");
				} else if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1" && process.env.V2_NATIVE_START_PROBE_MODE === "managed_native_response_probe") {
					assert.ok(message.optionTargetSeatIds && message.optionYinYangEligible,
						"YinYang native probe must bind candidates to real native target/material eligibility");
					nativeActionOptionId = message.options.find(option => message.optionKinds[option] === "gongJi" &&
						message.optionTargetSeatIds[option] === nativeYinYangFixtureSeatId && message.optionYinYangEligible[option] === true);
					assert.ok(nativeActionOptionId, "probe must choose an actual native attack targeting the eligible YinYang ordinary seat");
				} else if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_native_response_probe") {
					assert.ok(message.optionKinds && Object.keys(message.optionKinds).length === message.options.length);
					nativeActionOptionId = message.options.find(option => message.optionKinds[option] === "gongJi");
					assert.ok(nativeActionOptionId, "native event produced no legal gongJi action candidate for the response topology probe");
				} else nativeActionOptionId = message.options.at(-1);
				nativeActionCandidate = message;
				if (seatRegistry) {
					const staleHostSessionId = `hs_${"b".repeat(32)}`;
					assert.equal(controller.openChoice({ protocol: 1, roomId, hostSessionId: staleHostSessionId, nativeEventId: message.nativeEventId,
						seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
						deadlineAt: Date.now() + 5000, hostProof: message.secret }).code, "MANAGED_CHOICE_OPEN_REJECTED",
					"stale host session must not register a real native action choice");
				}
				const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
					deadlineAt: Date.now() + Math.min(5000, message.deadlineMs), hostProof: message.secret });
				assert.equal(openedChoice.ok, true); nativeActionChoice = openedChoice.choice;
				assert.equal(controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
					deadlineAt: Date.now() + 5000, hostProof: message.secret }).code, "MANAGED_CHOICE_NATIVE_EVENT_EXISTS");
				if (process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1") {
					assert.ok(process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1" ||
						(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") ||
						process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1",
					"pre-action capture must run only under a verified native resource fixture");
					nativePreActionCapture = await manager.snapshotNativePreActionCapture(roomId, { nativeEventId: message.nativeEventId,
						choiceId: openedChoice.choice.choiceId, seatId: message.seatId });
					assert.equal(nativePreActionCapture.ok, true, `pre-action atomic capture rejected: ${nativePreActionCapture.code}`);
					assert.equal(nativePreActionCapture.snapshot.boundaryKind, "native_input_waiting_quiescent");
					assert.equal(nativePreActionCapture.snapshot.nativeEventId, message.nativeEventId);
					assert.equal(nativePreActionCapture.snapshot.choiceId, openedChoice.choice.choiceId);
					assert.equal(nativePreActionCapture.snapshot.seatId, message.seatId);
					assert.equal(nativePreActionCapture.snapshot.eventInstanceId.startsWith("event_"), true);
					assert.equal(nativePreActionCapture.snapshot.projectionCount, 3);
					assert.equal(nativePreActionCapture.snapshot.authoritySeedAuthorized, false);
					assert.equal(nativePreActionCapture.snapshot.checkpointAvailable, false);
					assert.equal(JSON.stringify(nativePreActionCapture.snapshot).includes("shengJi"), false,
						"private pre-action commitment must not disclose skills, resources, or card faces");
				}
				const oldConnectionId = `old_${message.seatId}`, connectionId = `action_${message.seatId}`;
				if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE !== "1") assert.equal(bindSeat(message.seatId, oldConnectionId).ok, true);
				const request = { protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, choiceId: openedChoice.choice.choiceId, connectionId: oldConnectionId,
					credential: credentialFor(message.seatId), option: nativeActionOptionId };
				assert.equal(controller.submitChoice({ ...request, seatId: "wrong_seat" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, nativeEventId: `${message.nativeEventId}_stale` }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, eventSequence: message.eventSequence + 1 }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				if (seatRegistry && process.env.V2_V3_WEBSOCKET_ACTION_PROBE !== "1") {
					const priorSession = manager.inspect(roomId);
					const priorConnectionId = seatSockets.get(message.seatId);
					assert.ok(priorConnectionId);
					assert.equal(seatRegistry.disconnect({ roomId, seatId: message.seatId, connectionId: priorConnectionId }), true,
						"ordinary player disconnect must release only its seat binding");
					if (disconnectActionToTrustee) {
						assert.equal(seatRegistry.inspect(roomId, message.seatId)?.connected, false,
							"the ordinary actor must remain disconnected while its native choice is pending");
						assert.equal(controller.inspect(roomId, openedChoice.choice.choiceId)?.state, "pending",
							"player transport loss must preserve the pending native choice for its deadline policy");
						disconnectedActionHostIdentity = { sessionId: priorSession?.sessionId, pid: priorSession?.pid,
							state: priorSession?.state, seatId: message.seatId, choiceId: openedChoice.choice.choiceId,
							priorConnectionId };
						assert.ok(disconnectedActionHostIdentity.sessionId && disconnectedActionHostIdentity.pid,
							"managed host identity must be present before the isolated player disconnect");
					}
					assert.equal(seatRegistry.bindConnection({ roomId, seatId: message.seatId, credential: credentialFor(message.seatId),
						socket: { kind: "room_administrator", roomId, seatId: message.seatId, connectionId: "admin_action_socket" } }), null,
					"administrator socket must not take a player seat");
					assert.equal(seatRegistry.bindConnection({ roomId, seatId: message.seatId, credential: "f".repeat(64),
						socket: { kind: "player", roomId, seatId: message.seatId, connectionId: "forged_action_socket" } }), null,
					"forged credential must not bind a player seat");
					if (!disconnectActionToTrustee) {
						const rebound = seatRegistry.bindConnection({ roomId, seatId: message.seatId, credential: credentialFor(message.seatId),
							socket: { kind: "player", roomId, seatId: message.seatId, connectionId } });
						assert.ok(rebound, "valid credential must reclaim the disconnected seat");
						seatSockets.set(message.seatId, connectionId);
						assert.equal(controller.bindSeatConnection(rebound).ok, true);
						assert.equal(manager.inspect(roomId)?.sessionId, priorSession?.sessionId, "player rebind must not replace the host session");
						assert.equal(manager.inspect(roomId)?.pid, priorSession?.pid, "player rebind must not restart the managed host");
						assert.equal(manager.inspect(roomId)?.state, priorSession?.state, "player disconnect/rebind must leave host state active");
					}
				} else assert.equal(bindSeat(message.seatId, connectionId).ok, true);
				assert.equal(controller.submitChoice(request).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, hostSessionId: `hs_${"b".repeat(32)}`, connectionId,
					credential: credentialFor(message.seatId) }).code, "MANAGED_CHOICE_SUBMIT_REJECTED", "stale host session must not commit player input");
				if (!["managed_input_controller_trustee", "managed_opening_root_action_event4_trustee"].includes(process.env.V2_NATIVE_START_PROBE_MODE)) {
					if (process.env.V2_NATIVE_C3_FULL_CHAIN === "1" && process.env.V2_NATIVE_MANAGED_RESPONSE === "1" &&
						process.env.V2_NATIVE_START_PROBE_MODE === "managed_opening_root_action_event4") {
						const beforeSnapshot = nativeDiagnostic.length;
						assert.equal((await manager.snapshotNativeStart(roomId, process.env.V2_NATIVE_START_PROBE_MODE)).ok, true,
							"the live read-only snapshot must be requested while the native action choice is still pending");
						nativeLiveSnapshotAtInputGate = await until(() => nativeDiagnostic.slice(beforeSnapshot).find(entry => entry?.stage === "native_start_live_snapshot"),
							3000, () => ({ stages: nativeDiagnostic.slice(beforeSnapshot).map(entry => entry?.stage), session: manager.inspect(roomId) }));
						const liveProjection = nativeLiveSnapshotAtInputGate.projectionAudit;
						const liveActorSeatId = liveProjection?.xingDongEvent?.seatId;
						t.diagnostic(`native pending-input snapshot binding: ${JSON.stringify({ actor: liveActorSeatId ?? null,
							phaseActor: liveProjection?.phaseEvent?.seatId ?? null, currentActor: liveProjection?.currentSeatId ?? null,
							serverSeats: immutableServerSeatIds, eventStack: nativeLiveSnapshotAtInputGate.eventStack?.map(event => event.name) || [] })}`);
						assert.equal(nativeLiveSnapshotAtInputGate.rootObjectMatches, true);
						assert.equal(nativeLiveSnapshotAtInputGate.hostPlayerAbsent, true);
						assert.ok(immutableServerSeatIds.includes(liveActorSeatId),
							"the pending native action must be owned by a server-bound ordinary seat");
						assert.equal(liveProjection.phaseEvent?.name, "phase");
						assert.equal(liveProjection.phaseEvent?.seatId, liveActorSeatId);
						assert.equal(liveProjection.xingDongEvent?.name, "xingDong");
						assert.equal(liveProjection.currentSeatId, liveActorSeatId);
						if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
							const resourceSeat = liveProjection.seats?.find(seat => seat.seatId === nativeResourceFixtureSeatId);
							assert.equal(liveActorSeatId, nativeResourceFixtureSeatId);
							assert.equal(resourceSeat?.character, "shengQiangQiShi");
							assert.ok(Number.isSafeInteger(resourceSeat?.zhiLiao), "baseline resource must come from live native state");
							nativeResourceTransition = { baseline: resourceSeat.zhiLiao, seatId: resourceSeat.seatId,
								rootInstanceId: nativeLiveSnapshotAtInputGate.rootInstanceId };
						}
						const expectedNativeQuotas = {
							gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0,
						};
						assert.deepEqual(liveProjection.xingDongEvent.quotas, expectedNativeQuotas,
							"the live native xingDong input boundary must expose the original step-0 quota reset, not a synthesized quota");
						assert.ok(liveProjection.pendingActionChildCount >= 1,
							"snapshot must remain inside the native input gate before the ordinary player's choice is applied");
						assert.equal(liveActorSeatId, nativeActionCandidate.seatId,
							"the quota snapshot must belong to the same server-bound actor as the pending native action");
					}
					const accepted = { ...request, connectionId, credential: credentialFor(message.seatId), option: nativeActionOptionId };
					assert.equal(controller.submitChoice(accepted).ok, true);
					assert.equal(controller.submitChoice(accepted).code, "MANAGED_CHOICE_SUBMIT_REJECTED", "duplicate native action input must be rejected");
				}
			} else if (type === "host_native_skill_target_candidates") {
				assert.equal(process.env.V2_NATIVE_JIRIMO_ACTION_PROBE, "1");
				assert.equal(process.env.V2_NATIVE_JIRIMO_FIXTURE, "1");
				assert.equal(message.eventName, "chooseToDiscard");
				assert.equal(message.eventSequence, 4);
				assert.equal(message.actionEventId, nativeActionCandidate?.nativeEventId);
				assert.equal(message.rootInstanceId, nativeActionCandidate?.rootInstanceId);
				assert.equal(message.sourceSeatId, nativeJiRiFixtureSeatId);
				assert.ok(setup.seats.some(seat => seat.seatId === message.seatId));
				assert.notEqual(message.seatId, message.sourceSeatId);
				assert.ok(nativeActionCandidate.optionTargetSeatIds?.[nativeActionOptionId] === message.seatId,
					"native skill target choice must be bound to the original candidate's enemy target");
				assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 32);
				assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
				assert.deepEqual(Object.keys(message.optionKinds).sort(), [...message.options].sort());
				assert.ok(Object.values(message.optionKinds).every(kind => kind === "physical_faShu_discard"));
				nativeJiRiTargetCandidate = message;
				const connectionId = seatSockets.get(message.seatId);
				assert.ok(connectionId, "target's ordinary seat must already be bound through the Seat Registry");
				const openedTarget = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId,
					nativeEventId: message.nativeEventId, seatId: message.seatId, eventSequence: message.eventSequence,
					options: message.options, trusteeOption: message.trusteeOption, deadlineAt: Date.now() + message.deadlineMs,
					hostProof: message.secret });
				assert.equal(openedTarget.ok, true, `native target discard choice rejected: ${openedTarget.code}`);
				nativeJiRiTargetChoice = openedTarget.choice;
				opened.push(openedTarget.choice);
				assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: message.sessionId,
					nativeEventId: message.nativeEventId, seatId: message.seatId, eventSequence: message.eventSequence,
					choiceId: openedTarget.choice.choiceId, connectionId, credential: "administrator_credential", option: message.options[0] }).code,
					"MANAGED_CHOICE_SUBMIT_REJECTED", "manager credentials cannot submit a player's nested discard");
				assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: message.sessionId,
					nativeEventId: message.nativeEventId, seatId: message.sourceSeatId, eventSequence: message.eventSequence,
					choiceId: openedTarget.choice.choiceId, connectionId: seatSockets.get(message.sourceSeatId),
					credential: credentialFor(message.sourceSeatId), option: message.options[0] }).code,
					"MANAGED_CHOICE_SUBMIT_REJECTED", "the skill owner cannot submit the target seat's discard");
				assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: message.sessionId,
					nativeEventId: message.nativeEventId, seatId: message.seatId, eventSequence: message.eventSequence,
					choiceId: openedTarget.choice.choiceId, connectionId, credential: credentialFor(message.seatId), option: "forged_native_option" }).code,
					"MANAGED_CHOICE_SUBMIT_REJECTED", "unregistered physical discard options must be rejected");
				const submitted = controller.submitChoice({ protocol: 1, roomId, hostSessionId: message.sessionId,
					nativeEventId: message.nativeEventId, seatId: message.seatId, eventSequence: message.eventSequence,
					choiceId: openedTarget.choice.choiceId, connectionId, credential: credentialFor(message.seatId), option: message.options[0] });
				assert.equal(submitted.ok, true, `target ordinary seat could not select a native legal discard: ${submitted.code}`);
				assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: message.sessionId,
					nativeEventId: message.nativeEventId, seatId: message.seatId, eventSequence: message.eventSequence,
					choiceId: openedTarget.choice.choiceId, connectionId, credential: credentialFor(message.seatId), option: message.options[0] }).code,
					"MANAGED_CHOICE_SUBMIT_REJECTED", "the native target discard must settle once");
			} else if (type === "host_native_response_candidates") {
				assert.equal(process.env.V2_NATIVE_MANAGED_RESPONSE, "1");
				sessionSecret = message.secret;
				assert.equal(message.eventName, "yingZhan");
				assert.equal(message.eventSequence, 4, "nested response is part of the still-open native card-action event #4");
				assert.match(message.nativeEventId, /^native_[A-Za-z0-9_-]{16,96}$/);
				assert.ok(setup.seats.some(seat => seat.seatId === message.seatId));
				assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64);
				assert.equal(new Set(message.options).size, message.options.length);
				assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
				assert.ok(message.optionKinds && Object.keys(message.optionKinds).length === message.options.length);
				assert.ok(message.optionShapes && Object.keys(message.optionShapes).length === message.options.length);
				assert.ok(message.options.every(option => ["native_single_target_card", "native_notarget_card", "native_optional_decline", "native_single_target_view_as_skill"].includes(message.optionShapes[option])));
				const firstManagedResponse = nativeResponseChoices.length === 0;
				const yinYangManaged = process.env.V2_NATIVE_MANAGED_YINYANG === "1";
				const targetlessProbe = process.env.V2_NATIVE_RESPONSE_TARGETLESS === "1";
				if (targetlessProbe) {
					assert.ok(targetlessDeckFixtureProof, "native targetless response requires the declared opt-in native deck fixture proof");
				}
				const nestedResponseProbe = process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1";
				const responseTrusteeProbe = process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1";
				if (nestedResponseProbe) {
					assert.ok(message.optionCanTriggerNestedResponse,
						"nested-response probe requires native-only response mapping metadata");
					assert.deepEqual(Object.keys(message.optionCanTriggerNestedResponse).sort(), [...message.options].sort(),
						"nested-response eligibility must be bound to the exact native option set");
					assert.ok(Object.values(message.optionCanTriggerNestedResponse).every(value => typeof value === "boolean"));
				}
				const resourceFixture = process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1";
				const expectedResponseShapes = yinYangManaged ? ["native_single_target_view_as_skill"] : resourceFixture ?
					["native_optional_decline"] : targetlessProbe ?
					["native_notarget_card"] : ["native_single_target_card", "native_notarget_card"];
				const submittedResponseOption = firstManagedResponse ? resourceFixture ? message.options.find(option => message.optionKinds[option] === "decline") : yinYangManaged ? message.options.find(option => message.optionKinds[option] === "view_as_skill" &&
					expectedResponseShapes.includes(message.optionShapes[option])) : nestedResponseProbe ? message.options.find(option =>
					message.optionKinds[option] === "card" && message.optionCanTriggerNestedResponse[option] === true) : message.options.find(option => message.optionKinds[option] === "card" &&
					expectedResponseShapes.includes(message.optionShapes[option])) : message.trusteeOption;
				if (firstManagedResponse) {
					nativeResponseOptionId = submittedResponseOption;
					assert.ok(nativeResponseOptionId, yinYangManaged ? "the native yingZhan event exposed no native YinYang viewAs candidate" : nestedResponseProbe ? `the native yingZhan event exposed no legal response whose native target can itself respond: ${JSON.stringify({
						optionKinds: message.optionKinds, optionCanTriggerNestedResponse: message.optionCanTriggerNestedResponse,
					})}` : targetlessProbe ? "the native yingZhan event exposed no legal native no-target response candidate" :
						"the native yingZhan event exposed no legal physical-card response candidate");
					assert.ok(expectedResponseShapes.includes(message.optionShapes[nativeResponseOptionId]),
						"managed response test must select from its explicitly allowed native response shapes");
					nativeResponseCandidate = message;
					if (yinYangManaged && process.env.V2_NATIVE_EFFECT_STOP_BARRIER === "1") {
						nativeEffectStopSnapshotPromise = manager.snapshotNativeEffectState(roomId, { mode: "before_native_response",
							nativeEventId: message.nativeEventId, seatId: message.seatId, nativeCompletionOrdinal: null });
						nativeEffectStopSnapshotPromise.then(() => { nativeEffectStopSnapshotSettled = true; });
						return;
					}
					if (yinYangManaged && process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1") {
						const wrongSeat = setup.seats.find(seat => seat.seatId !== message.seatId);
						const rejected = await manager.snapshotNativeEffectState(roomId, { mode: "before_native_response",
							nativeEventId: message.nativeEventId, seatId: wrongSeat.seatId, nativeCompletionOrdinal: null });
						assert.equal(rejected.ok, false, "effect-state request for another seat must fail closed before touching the child");
						const staleEvent = await manager.snapshotNativeEffectState(roomId, { mode: "before_native_response",
							nativeEventId: `${message.nativeEventId}_stale`, seatId: message.seatId, nativeCompletionOrdinal: null });
						assert.equal(staleEvent.ok, false, "snapshot requests for an unregistered native event must fail before child IPC");
						nativeEffectStateBefore = await manager.snapshotNativeEffectState(roomId, { mode: "before_native_response",
							nativeEventId: message.nativeEventId, seatId: message.seatId, nativeCompletionOrdinal: null });
						assert.equal(nativeEffectStateBefore.ok, true, `pre-skill native snapshot failed: ${nativeEffectStateBefore.code}`);
						assert.equal(nativeEffectStateBefore.snapshot.snapshotOrdinal, 1);
						assert.equal(nativeEffectStateBefore.snapshot.captureBoundary, "native_response_waiting");
						assert.equal(nativeEffectStateBefore.snapshot.nativeEventId, message.nativeEventId);
						assert.equal(nativeEffectStateBefore.snapshot.nativeCompletionOrdinal, null);
						assert.equal(nativeEffectStateBefore.snapshot.checkpointAvailable, false);
						const duplicatePre = await manager.snapshotNativeEffectState(roomId, { mode: "before_native_response",
							nativeEventId: message.nativeEventId, seatId: message.seatId, nativeCompletionOrdinal: null });
						assert.equal(duplicatePre.ok, false, "one native response lifecycle must not accept a second pre-state snapshot");
						assert.equal(manager.inspect(roomId)?.state, "playable_probe",
							"rejected stale/duplicate diagnostic requests must not mutate the host session");
					}
					if (responseTrusteeProbe) assert.equal(message.optionKinds[message.trusteeOption], "decline",
						"response timeout must use the native optional-decline candidate as trustee");
				} else assert.equal(message.optionKinds[submittedResponseOption], "decline", "nested response trustee should decline through the native optional-choice contract");
				const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
					deadlineAt: Date.now() + Math.min(5000, message.deadlineMs), hostProof: sessionSecret });
				assert.equal(openedChoice.ok, true, `native response choice registration failed: ${openedChoice.code}`);
				if (firstManagedResponse) nativeResponseChoice = openedChoice.choice;
				nativeResponseChoices.push({ choice: openedChoice.choice, candidate: message, option: submittedResponseOption });
				const connectionId = process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1" ? seatSockets.get(message.seatId) : `response_${message.seatId}`;
				if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE !== "1") assert.equal(bindSeat(message.seatId, connectionId).ok, true);
				const request = { protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, choiceId: openedChoice.choice.choiceId, connectionId,
					credential: credentialFor(message.seatId), option: submittedResponseOption };
					assert.equal(controller.submitChoice({ ...request, option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
					if (yinYangManaged) {
						assert.equal(controller.submitChoice({ ...request, option: "yinYangZhanHuan" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED",
							"player skill identifiers must not substitute for server-issued opaque options");
						assert.equal(controller.submitChoice({ ...request, option: nativeActionOptionId }).code, "MANAGED_CHOICE_SUBMIT_REJECTED",
							"an option issued for the parent card action cannot be replayed as a native skill response");
						assert.equal(controller.submitChoice({ ...request, nativeEventId: `${message.nativeEventId}_stale` }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
						assert.equal(controller.submitChoice({ ...request, eventSequence: message.eventSequence + 1 }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
						assert.equal(controller.submitChoice({ ...request, hostSessionId: `hs_${"b".repeat(32)}` }).code,
							"MANAGED_CHOICE_SUBMIT_REJECTED", "an old host session cannot submit against the live native choice");
						assert.equal(controller.submitChoice({ ...request, roomId: `${roomId}_other` }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
						const otherSeat = setup.seats.find(seat => seat.seatId !== message.seatId);
						assert.ok(otherSeat);
						assert.equal(controller.submitChoice({ ...request, credential: credentialFor(otherSeat.seatId) }).code,
							"MANAGED_CHOICE_SUBMIT_REJECTED", "another ordinary seat's credential cannot submit this skill response");
						assert.equal(controller.inspect(roomId, openedChoice.choice.choiceId)?.state, "pending",
							"rejected skill-response packets must not resolve the native choice");
					}
					assert.equal(controller.submitChoice({ ...request, seatId: setup.seats.find(seat => seat.seatId !== message.seatId).seatId }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				if (firstManagedResponse && responseTrusteeProbe) {
					assert.equal(controller.inspect(roomId, openedChoice.choice.choiceId)?.state, "pending");
				} else if (firstManagedResponse && process.env.V2_NATIVE_RESPONSE_REBIND === "1") {
					const activeHost = manager.inspect(roomId);
					const replacementConnectionId = `response_rebound_${message.seatId}`;
					assert.equal(controller.inspect(roomId, openedChoice.choice.choiceId)?.state, "pending");
					assert.equal(bindSeat(message.seatId, replacementConnectionId).ok, true,
						"valid seat credential should rebind while the native response remains pending");
					assert.equal(controller.inspect(roomId, openedChoice.choice.choiceId)?.state, "pending",
						"transport loss must retain the native response choice");
					assert.equal(controller.submitChoice(request).code, "MANAGED_CHOICE_SUBMIT_REJECTED",
						"old response connection must be fenced after the seat rebind");
					assert.equal(manager.inspect(roomId)?.sessionId, activeHost?.sessionId);
					assert.equal(manager.inspect(roomId)?.pid, activeHost?.pid,
						"seat disconnect/rebind must not restart or replace the managed game host");
					const rebound = controller.submitChoice({ ...request, connectionId: replacementConnectionId });
					assert.equal(rebound.ok, true, `rebound ordinary seat could not submit its native response: ${rebound.code}`);
					if (firstManagedResponse) nativeResponseAccepted = rebound.ok === true;
				} else {
					const submitted = controller.submitChoice(request);
					assert.equal(submitted.ok, true, `authenticated ordinary seat could not submit its native response: ${submitted.code}`);
					if (firstManagedResponse) nativeResponseAccepted = submitted.ok === true;
				}
			} else if (type === "host_choice_ack") {
				ackCount++;
				if (nativeActionChoice?.choiceId === message.choiceId) nativeActionAckCount++;
				if (event5Choice?.choiceId === message.choiceId) event5NativeActionAckCount++;
				if (event6Choice?.choiceId === message.choiceId) event6NativeActionAckCount++;
				if (event7Choice?.choiceId === message.choiceId) event7NativeActionAckCount++;
				if (event8Choice?.choiceId === message.choiceId) event8NativeActionAckCount++;
				if (nativeJiRiTargetChoice?.choiceId === message.choiceId) {
					nativeJiRiTargetAckCount++;
					assert.equal(message.nativeApplied, true, "nested discard ACK must follow native chooseToDiscard completion");
					assert.equal(message.nativeResponseEventCompleted, true);
					assert.equal(message.nativeEventId, nativeJiRiTargetCandidate?.nativeEventId);
					if (dropNativeJiRiTargetAckOnce) {
						dropNativeJiRiTargetAckOnce = false;
						nativeJiRiTargetAckDropped = true;
						return;
					}
				}
				const isNativeResponseAck = nativeResponseChoices.some(entry => entry.choice.choiceId === message.choiceId);
				const nativeResponseEntry = nativeResponseChoices.find(entry => entry.choice.choiceId === message.choiceId) || null;
				const isYinYangResponseAck = nativeResponseEntry?.candidate?.optionKinds?.[nativeResponseEntry.option] === "view_as_skill";
				if (isNativeResponseAck) {
					nativeResponseAckCount++;
					nativeResponseAckAttempts.set(message.choiceId, (nativeResponseAckAttempts.get(message.choiceId) || 0) + 1);
				}
				if (isYinYangResponseAck && process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1" && !nativeEffectStateAfterPromise) {
					assert.equal(message.nativeApplied, true);
					assert.equal(message.nativeResponseEventCompleted, true);
					assert.ok(Number.isSafeInteger(message.nativeCompletionOrdinal) && message.nativeCompletionOrdinal > 0);
					nativeEffectStateAfterPromise = (async () => {
						const after = await manager.snapshotNativeEffectState(roomId, { mode: "after_native_response",
							nativeEventId: nativeResponseEntry.candidate.nativeEventId, seatId: nativeResponseEntry.candidate.seatId,
							nativeCompletionOrdinal: message.nativeCompletionOrdinal });
						if (!after.ok) { nativeEffectStateFailures.push({ stage: "post_native_response", code: after.code || null }); return { after, repeat: null }; }
						const repeat = await manager.snapshotNativeEffectState(roomId, { mode: "repeat_native_response",
							nativeEventId: nativeResponseEntry.candidate.nativeEventId, seatId: nativeResponseEntry.candidate.seatId,
							nativeCompletionOrdinal: message.nativeCompletionOrdinal });
						if (!repeat.ok) nativeEffectStateFailures.push({ stage: "repeat_native_response", code: repeat.code || null });
						return { after, repeat };
					})();
					const captured = await nativeEffectStateAfterPromise;
					nativeEffectStateAfter = captured.after;
					nativeEffectStateRepeat = captured.repeat;
				}
				ackTrace.push({ at: Date.now(), choiceId: message.choiceId, nativeAction: nativeActionChoice?.choiceId === message.choiceId, nativeResponse: isNativeResponseAck, dropAcks,
					responseEventCompleted: message.nativeResponseEventCompleted === true,
					nativeCompletionOrdinal: Number.isSafeInteger(message.nativeCompletionOrdinal) ? message.nativeCompletionOrdinal : null,
					choiceState: controller.inspect(roomId, message.choiceId)?.state || null,
					nativeApplied: message.nativeApplied === true, authorityEventSequence: message.authorityEventSequence || null });
				if (isNativeResponseAck && dropNativeResponseAckOnce &&
					(process.env.V2_NATIVE_MANAGED_YINYANG !== "1" || isYinYangResponseAck)) {
					dropNativeResponseAckOnce = false;
					nativeResponseAckDropped = true;
					droppedNativeResponseAckChoiceId = message.choiceId;
					return;
				}
				if (dropAcks && !isNativeResponseAck) {
					const isNativeActionAck = nativeActionChoice?.choiceId === message.choiceId;
					if (!isNativeActionAck && !droppedChoiceAckIds.has(message.choiceId)) {
						droppedAcks++;
						droppedChoiceAckIds.add(message.choiceId);
						return;
					}
				}
				if (nativeActionChoice && message.choiceId === nativeActionChoice.choiceId) {
					if (seatRegistry) {
						const beforeStaleAck = controller.inspect(roomId, message.choiceId);
						assert.equal(controller.acknowledgeDelivery({ ...message, hostSessionId: `hs_${"b".repeat(32)}`, hostProof: sessionSecret }).code,
							"MANAGED_CHOICE_ACK_REJECTED", "stale host session ACK must not confirm the Chromium-applied native result");
						assert.equal(controller.inspect(roomId, message.choiceId)?.state, beforeStaleAck?.state);
					}
					if (dropNativeActionAckOnce) { dropNativeActionAckOnce = false; nativeActionAckDropped = true; return; }
					assert.equal(message.nativeApplied, true, "native action ACK lacked post-child-wait evidence");
					const beforeAck = controller.inspect(roomId, message.choiceId);
					const acked = controller.acknowledgeDelivery({ ...message, hostSessionId: message.sessionId, hostProof: sessionSecret });
					if (isNativeResponseAck) nativeResponseAckResults.push({ choiceId: message.choiceId, before: beforeAck?.state || null,
						accepted: acked.ok === true, result: acked.code || "ok" });
					ackTrace.at(-1).ackResult = acked.code || "ok";
					ackTrace.at(-1).choiceStateAfter = controller.inspect(roomId, message.choiceId)?.state || null;
					if (beforeAck?.state === "resolved") assert.equal(acked.code, "MANAGED_CHOICE_ACK_REJECTED");
					else assert.equal(acked.ok, true, `native action ACK rejected: ${acked.code}`);
				} else {
					const beforeAck = controller.inspect(roomId, message.choiceId);
					const acked = controller.acknowledgeDelivery({ ...message, hostSessionId: message.sessionId, hostProof: sessionSecret });
					if (isNativeResponseAck) nativeResponseAckResults.push({ choiceId: message.choiceId, before: beforeAck?.state || null,
						accepted: acked.ok === true, result: acked.code || "ok", responseEventCompleted: message.nativeResponseEventCompleted === true });
					ackTrace.at(-1).ackResult = acked.code || "ok";
					ackTrace.at(-1).choiceStateAfter = controller.inspect(roomId, message.choiceId)?.state || null;
					if (beforeAck?.state === "resolved") assert.equal(acked.code, "MANAGED_CHOICE_ACK_REJECTED");
					else assert.equal(acked.ok, true, `choice ACK rejected: ${acked.code}`);
				}
			} else if (type === "host_choice_diagnostic") {
				 nativeDiagnostic.push({ ...message.observed, receivedAt: Date.now() });
				if (nativeFaultMode === "viewas_partial_effect_stop" && message.observed?.stage === "native_viewas_partial_effect_barrier" && !nativeFaultStopPromise) {
					nativeFaultStopPromise = manager.stop(roomId, "native_viewas_partial_effect_stop_race");
				}
				if (message.observed?.stage === "native_viewas_delivery_preapply_released") viewasBarrierReleased = true;
				if (message.observed?.stage === "native_action_delivery_joined_authority_commit" &&
					message.nativeEventId === nativeActionCandidate?.nativeEventId) {
					event4AuthorityJoinCount++;
					if (!event4AckBarrierReleased) {
						if (process.env.V2_NATIVE_PARENT_FENCE === "1") {
							const waitingFence = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_fence_waiting" &&
								entry?.snapshot?.status === "waiting" && entry?.snapshot?.nativeEventId === nativeActionCandidate?.nativeEventId), 5000,
								() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-10), host: manager.inspect(roomId) }));
							const snapshotCount = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot").length;
							assert.equal((await manager.snapshotNativeStart(roomId, "managed_opening_root_action_event4")).ok, true,
								"authenticated snapshot must remain available while the parent continuation is fenced");
							const held = await until(() => nativeDiagnostic.slice().reverse().find(entry => entry?.stage === "native_start_live_snapshot" &&
								 nativeDiagnostic.indexOf(entry) >= nativeDiagnostic.findIndex(item => item?.stage === "native_parent_fence_waiting")), 5000,
								() => ({ countBefore: snapshotCount, latest: nativeDiagnostic.slice(-10), host: manager.inspect(roomId) }));
							assert.equal(held.nativeParentFence?.status, "waiting");
							assert.equal(held.nativeParentFence?.nativeEventId, waitingFence.snapshot.nativeEventId);
							assert.equal(held.nativeParentFence?.parentEventName, "xingDong");
							assert.equal(held.nativeParentFence?.completedChildName, "gongJiOrFaShu");
							assert.equal(held.nativeParentFence?.completedChildFinished, true);
							assert.equal(held.nativeParentFence?.completedChildParentMatches, true);
							assert.equal(held.nativeParentFence?.parentNextCount, 0);
							assert.equal(held.rootObjectMatches, true);
							assert.equal(held.hostPlayerAbsent, true);
							assert.equal(held.paused, waitingFence.snapshot.paused,
								"parent fence must preserve the pre-existing pause state rather than change global pause state");
							assert.equal(held.projectionAudit?.candidateDisposition, "diagnostic_only_not_a_proof");
							assert.equal(held.projectionAudit?.authorized, false);
							assert.equal(held.projectionAudit?.checkpointAvailable, false);
							assert.equal(held.projectionAudit?.rootObjectMatches, true);
							assert.equal(held.projectionAudit?.currentSeatId, held.projectionAudit?.firstActSeatId);
							assert.equal(held.projectionAudit?.xingDongEvent?.name, "xingDong");
							assert.equal(held.projectionAudit?.xingDongEvent?.finished, false);
							assert.equal(held.projectionAudit?.pendingActionChildCount, 0,
								"a diagnostic candidate may not be observed while any native action child is pending");
							assert.equal(held.projectionAudit?.completedActionChildCount, 1);
							assert.equal(held.projectionAudit?.seats?.length, 4);
							assert.equal(Object.hasOwn(held.projectionAudit.seats[0], "skillStateCommitment"), false);
							assert.equal(Object.hasOwn(held.projectionAudit.seats[0], "marksCommitment"), false,
								"the current live projection deliberately lacks commitments needed for a schema-v2 seed");
							assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_parent_fence_released" &&
								 entry?.snapshot?.nativeEventId === waitingFence.snapshot.nativeEventId), false,
								"parent fence released before the authority ACK barrier was opened");
							const fenceIndex = nativeDiagnostic.indexOf(waitingFence);
							assert.equal(nativeDiagnostic.slice(fenceIndex + 1).some(entry => entry?.stage === "native_parent_next_action_child_start"), false,
								"a subsequent native action started while Event #4 authority acceptance was withheld");
						}
						event4AckBarrierReleased = true;
						releaseEvent4AckBarrier();
					}
				}
				if (nativeFaultMode === "retry_while_applying" && message.observed?.stage === "native_useResult_entered" && !applyingRetryIssued && nativeActionChoice) {
					applyingRetryIssued = true;
					assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId)?.state, "applying",
						"the controller must fence a redelivery after the supervised host has begun applying the native action");
					assert.equal(controller.retryDelivery({ roomId, choiceId: nativeActionChoice.choiceId }).ok, true,
						"same immutable delivery could not be retried during native applying");
				}
			}
			} catch (error) {
				managedChoiceHandlerFailures.push(safeChoiceHandlerFailure(type, error));
				throw error;
			}
		},
	});
	const actionGatewaySockets = new Map();
	let actionGatewayStateSequences = new Map(immutableServerSeatIds.map(seatId => [seatId, 0]));
	let actionGatewayRequestOrdinal = 0;
	let actionGatewayContext = null;
	async function startExperimentalActionGateway(rootInstanceId) {
		const WebSocket = require("ws");
		const host = manager.inspect(roomId);
		const handle = launchedHandles.get(host?.sessionId);
		const chromiumPid = handle?.resources()[0]?.pid;
		assert.ok(chromiumPid > 0, "action gateway must bind to the existing supervised Chromium PID");
		if (!lifecycleCoordinator) seatStateGateway = createManagedV3SeatStateWebSocketGateway({
			WebSocketServer: WebSocket.Server, roomId, seatIds: immutableServerSeatIds,
			hostSessionId: host.sessionId, engineBuildId: host.engineBuildId, rootInstanceId, hostPid: host.pid,
			hostSessionManager: manager, seatRegistry,
			getExperimentalActionCapability: candidateRoom => manager.inspectV3ExperimentalActionCapability(candidateRoom),
			getCurrentManagedChoice: input => manager.getV3CurrentManagedChoice(input),
			submitManagedChoice: input => controller.submitChoice(input),
			bindSeat: ({ roomId: candidateRoom, seatId, credential, connectionId }) => {
				if (lifecycleCoordinator) return lifecycleCoordinator.bindGatewaySeat({ roomId: candidateRoom, seatId, credential, connectionId }).binding || null;
				const previous = seatSockets.get(seatId);
				if (previous) seatRegistry.disconnect({ roomId: candidateRoom, seatId, connectionId: previous });
				const binding = seatRegistry.bindConnection({ roomId: candidateRoom, seatId, credential,
					socket: { kind: "player", roomId: candidateRoom, seatId, connectionId } });
				if (binding) {
					seatSockets.set(seatId, connectionId);
					assert.equal(controller.bindSeatConnection(binding).ok, true);
				}
				return binding;
			},
			disconnectSeat: ({ roomId: candidateRoom, seatId, connectionId }) => {
				if (lifecycleCoordinator) return lifecycleCoordinator.disconnectSeat({ roomId: candidateRoom, seatId, connectionId });
				seatRegistry.disconnect({ roomId: candidateRoom, seatId, connectionId });
				if (seatSockets.get(seatId) === connectionId) seatSockets.delete(seatId);
			},
		});
		const address = lifecycleGatewayAddress || await seatStateGateway.listen();
		assert.equal(address.host, "127.0.0.1", "experimental player action gateway must bind to loopback");
		for (const seatId of immutableServerSeatIds) {
			const socket = await connectWebSocket(WebSocket, address.url);
			const response = receiveWebSocketMessage(socket);
			socket.send(JSON.stringify({ type: "seat_auth", roomId, seatId, credential: credentialFor(seatId) }));
			const authenticated = await response;
			assert.equal(authenticated.type, "seat_authenticated");
			assert.equal(authenticated.seatId, seatId);
			assert.equal(authenticated.connectionGeneration, seatRegistry.inspect(roomId, seatId).epoch);
			actionGatewaySockets.set(seatId, socket);
		}
		const context = Object.freeze({ address, hostSessionId: host.sessionId, chromiumPid, rootInstanceId });
		actionGatewayContext = context;
		if (lifecycleCoordinator) {
			const coordinated = lifecycleCoordinator.inspect(roomId);
			assert.equal(coordinated.state, "running");
			assert.deepEqual(coordinated.transitions, ["created", "waiting_for_players", "ready", "starting", "running"]);
			assert.deepEqual(coordinated.connectedSeatIds, immutableServerSeatIds,
				"the coordinator and Gateway must agree on all four current socket bindings");
			for (const seatId of immutableServerSeatIds) {
				const registrySeat = seatRegistry.inspect(roomId, seatId);
				assert.equal(registrySeat.connected, true);
				assert.ok(Number.isSafeInteger(registrySeat.epoch) && registrySeat.epoch >= 1);
			}
			assert.equal(coordinated.hostSessionId, host.sessionId);
			assert.equal(coordinated.hostPid, host.pid, "the coordinator binds the manager-owned host process identity");
			assert.equal(launchedHandles.get(host.sessionId)?.resources()[0]?.pid, chromiumPid,
				"the real Chromium browser PID is tracked separately from the managed host wrapper PID");
			const nativeContext = manager.inspectManagedHostTransportContext(roomId);
			assert.equal(nativeContext.rootInstanceId, rootInstanceId);
			assert.equal(nativeContext.hostPid, host.pid);
			// Exercise the room creator's ordinary-player disconnect independently of
			// later active-actor recovery. The managed host and native root must live on.
			const creatorReconnect = await reconnectDuringManagedGame(immutableServerSeatIds[0]);
			assert.equal(creatorReconnect.hostSessionId, host.sessionId);
			assert.equal(creatorReconnect.rootInstanceId, rootInstanceId);
			assert.equal(lifecycleCoordinator.inspect(roomId).state, "running");
			event6LogStage("room-creator-rebound");
			t.diagnostic(`creator remained an ordinary seat through independent reconnect: ${JSON.stringify({
				seatId: immutableServerSeatIds[0], oldGeneration: creatorReconnect.oldGeneration,
				currentGeneration: creatorReconnect.currentGeneration, sameHost: true, sameRoot: true })}`);
		}
		return context;
	}
	async function reconnectDuringManagedGame(seatId) {
		const hostBefore = manager.inspect(roomId), oldSocket = actionGatewaySockets.get(seatId);
		const oldConnectionId = seatSockets.get(seatId), oldGeneration = seatRegistry.inspect(roomId, seatId)?.epoch;
		assert.ok(actionGatewayContext && oldSocket && oldConnectionId && Number.isSafeInteger(oldGeneration));
		await closeWebSocket(oldSocket);
		actionGatewaySockets.delete(seatId);
		await until(() => seatRegistry.inspect(roomId, seatId)?.connected === false, 3000,
			() => ({ seatId, seat: seatRegistry.inspect(roomId, seatId) }));
		const WebSocket = require("ws"), socket = await connectWebSocket(WebSocket, actionGatewayContext.address.url);
		const authenticatedMessage = receiveWebSocketMessage(socket);
		socket.send(JSON.stringify({ type: "seat_auth", roomId, seatId, credential: credentialFor(seatId) }));
		const authenticated = await authenticatedMessage;
		const currentGeneration = seatRegistry.inspect(roomId, seatId)?.epoch;
		assert.deepEqual(authenticated, { type: "seat_authenticated", roomId, seatId, connectionGeneration: currentGeneration });
		assert.equal(currentGeneration, oldGeneration + 1, "reconnect must fence the prior connection generation");
		assert.equal(seatRegistry.authenticateSeat({ roomId, seatId, connectionId: oldConnectionId,
			credential: credentialFor(seatId) }, { roomId, seatId }), false);
		assert.equal(manager.inspect(roomId)?.sessionId, hostBefore.sessionId);
		assert.equal(launchedHandles.get(hostBefore.sessionId)?.resources()[0]?.pid, actionGatewayContext.chromiumPid);
		assert.equal(manager.inspect(roomId)?.authorityStateRevision, hostBefore.authorityStateRevision);
		actionGatewaySockets.set(seatId, socket);
		return Object.freeze({ seatId, oldGeneration, currentGeneration, hostSessionId: hostBefore.sessionId,
			rootInstanceId: actionGatewayContext.rootInstanceId, chromiumPid: actionGatewayContext.chromiumPid });
	}
	async function readActionStateThroughGateway(seatId, expectedRevision) {
		const actor = actionGatewaySockets.get(seatId);
		assert.ok(actor, "active native actor must be connected through its ordinary-player WebSocket");
		const sequence = actionGatewayStateSequences.get(seatId);
		const stateRequestId = `action_state_${++actionGatewayRequestOrdinal}`;
		let received = receiveWebSocketMessage(actor);
		actor.send(JSON.stringify({ type: "state_read", requestId: stateRequestId, lastSeenSequence: sequence }));
		const view = await received;
		assert.equal(validateSeatStateMessage(view, { roomId, seatId, connectionGeneration: seatRegistry.inspect(roomId, seatId).epoch,
			seatIds: immutableServerSeatIds }).ok, true, `actor WebSocket state projection rejected: ${JSON.stringify(view)}`);
		assert.equal(view.publicState.activeSeatId, seatId);
		assert.equal(view.privateState.seatId, seatId);
		assert.equal(view.pendingChoice, null, "state sync and choice protocol are separate messages");
		assert.equal(manager.inspect(roomId).authorityStateRevision, expectedRevision,
			"recipient projection is derived while the expected authority revision is current");
		const host = manager.inspect(roomId);
		for (const secret of [sessionSecret, ...seatCredentials.values()]) assert.equal(JSON.stringify(view).includes(secret), false);
		assert.equal(JSON.stringify(view).includes(host.sessionId), false);
		const nextSequence = view.stateSequence;
		received = receiveWebSocketMessage(actor);
		actor.send(JSON.stringify({ type: "state_ack", stateSequence: nextSequence }));
		const transportAck = await received;
		assert.equal(transportAck.type, "transport_acknowledged");
		assert.equal(transportAck.stateSequence, nextSequence);
		actionGatewayStateSequences.set(seatId, nextSequence);
		return view;
	}
	async function submitActionThroughGateway({ seatId, choice, option, expectedRevision }) {
		const actor = actionGatewaySockets.get(seatId);
		let received;
		assert.ok(actor, "active native actor must be connected through its ordinary-player WebSocket");
		assert.equal(manager.inspect(roomId).authorityStateRevision, expectedRevision,
			"choice submission must be bound to the current accepted authority predecessor");

		for (const otherSeatId of immutableServerSeatIds.filter(id => id !== seatId)) {
			const other = actionGatewaySockets.get(otherSeatId);
			received = receiveWebSocketMessage(other);
			other.send(JSON.stringify({ type: "choice_read", requestId: `not_actor_${++actionGatewayRequestOrdinal}` }));
			assert.equal((await received).type, "managed_choice_unavailable", "only current native actor can see the pending choice");
		}
		const requestId = `action_submit_${++actionGatewayRequestOrdinal}`;
		received = receiveWebSocketMessage(actor);
		actor.send(JSON.stringify({ type: "choice_read", requestId: `choice_read_${++actionGatewayRequestOrdinal}` }));
		const publicChoice = await received;
		assert.equal(publicChoice.type, "managed_choice");
		assert.equal(publicChoice.roomId, roomId);
		assert.equal(publicChoice.seatId, seatId);
		assert.equal(publicChoice.choiceId, choice.choiceId);
		assert.ok(publicChoice.optionIds.includes(option));
		for (const otherSeatId of immutableServerSeatIds.filter(id => id !== seatId)) {
			const other = actionGatewaySockets.get(otherSeatId);
			received = receiveWebSocketMessage(other);
			other.send(JSON.stringify({ type: "choice_submit", requestId: `spoof_${++actionGatewayRequestOrdinal}`,
				choiceId: choice.choiceId, optionId: option }));
			assert.equal((await received).type, "gateway_error", "non-actor submission must be rejected before controller resolution");
		}
		const request = JSON.stringify({ type: "choice_submit", requestId, choiceId: choice.choiceId, optionId: option });
		received = receiveWebSocketMessage(actor);
		actor.send(request);
		const choiceAck = await received;
		assert.equal(choiceAck.type, "choice_submission_ack");
		assert.equal(choiceAck.accepted, true);
		assert.equal(choiceAck.stage, "controller", "transport/controller ACK must not claim native or authority acceptance");
		const authorityBeforeAck = manager.inspect(roomId);
		assert.equal(authorityBeforeAck.authorityStateRevision, expectedRevision, "choice ACK must not advance authority revision");
		received = receiveWebSocketMessage(actor);
		actor.send(request);
		const duplicateAck = await received;
		assert.equal(duplicateAck.choiceId, choice.choiceId);
		assert.equal(duplicateAck.duplicate, true, "same transport submission is idempotent");
		assert.equal(duplicateAck.stage, "controller");
		return Object.freeze({ publicChoice, choiceAck, duplicateAck, stateSequence: actionGatewayStateSequences.get(seatId) });
	}
	t.after(async () => {
		event6LogStage("cleanup-start");
		try {
			await seatStateGateway?.close();
			event6LogStage("gateway-closed");
		} finally {
			try {
				await lifecycleCoordinator?.close();
				event6LogStage("room-coordinator-closed");
				// Stop Chromium before closing its origin server, or its live page can
				// keep the server close callback pending and strand host cleanup.
				await manager?.stop(roomId, "test_cleanup");
				event6LogStage("manager-stopped");
				if (process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1" && atomicCaptureSessionId) {
					const handle = launchedHandles.get(atomicCaptureSessionId);
					assert.ok(handle, "the captured managed host must remain registered for cleanup verification");
					event6LogStage("host-cleanup-wait-start");
					await handle.waitForCleanup();
					event6LogStage("host-cleanup-wait-finished");
					assert.equal(handle.resources().length, 0, "both real Chromium fence captures must clean the host and temporary profile");
					assert.equal(manager.inspect(roomId)?.state, "stopped");
				}
			} finally {
				event6LogStage("server-close-start");
				try {
					await server.close();
					event6LogStage("server-closed");
				} finally {
					for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
				}
			}
		}
		event6LogStage("cleanup-finished");
	});
	event6LogStage("manager-start-called");
	let startResult;
	if (lifecycleE2E) {
		lifecycleCoordinator = createManagedV3RoomLifecycleCoordinator({ hostSessionManager: manager, seatRegistry,
			deliverSeatCredential({ seatId, credential, role }) {
				assert.equal(role, "ordinary_player");
				assert.equal(seatCredentials.has(seatId), false, "credential delivery is once per seat");
				seatCredentials.set(seatId, credential);
			},
			onSeatBound(binding) {
				assert.equal(seatRegistry.authorizeSeatBinding(binding), true);
				seatSockets.set(binding.seatId, binding.connectionId);
				assert.equal(controller.bindSeatConnection(binding).ok, true);
				const refreshed = manager.refreshV3ExperimentalActionSeatBinding(roomId, binding);
				assert.equal(refreshed.ok, true, `trusted rebind must safely refresh only the active native candidate binding: ${refreshed.code}`);
			},
			async startManagedHost({ roomId: managedRoom, gameSetup }) {
				const started = await manager.start(managedRoom, gameSetup);
				if (!started.ok) return started;
				await until(() => manager.inspect(managedRoom)?.state === "playable_probe" &&
					manager.inspect(managedRoom)?.authorityStateRevision >= 1, 45000,
					() => ({ state: manager.inspect(managedRoom)?.state, revision: manager.inspect(managedRoom)?.authorityStateRevision }));
				return { ok: true, session: manager.inspect(managedRoom) };
			},
			async createGateway(context) {
				const WebSocket = require("ws");
				const nativeContext = manager.inspectManagedHostTransportContext(context.roomId);
				assert.ok(nativeContext, "Coordinator may attach transport only to the live managed native root");
				assert.equal(nativeContext.hostSessionId, context.hostSessionId);
				assert.equal(nativeContext.rootInstanceId, context.rootInstanceId);
				seatStateGateway = createManagedV3SeatStateWebSocketGateway({
					WebSocketServer: WebSocket.Server, roomId: context.roomId, seatIds: context.seatIds,
					hostSessionId: context.hostSessionId, engineBuildId: context.engineBuildId,
					rootInstanceId: context.rootInstanceId, hostPid: context.hostPid,
					hostSessionManager: manager, seatRegistry,
					bindSeat: input => context.bindSeat(input).binding || null,
					disconnectSeat: context.disconnectSeat,
					getExperimentalActionCapability: candidateRoom => manager.inspectV3ExperimentalActionCapability(candidateRoom),
					getCurrentManagedChoice: input => manager.getV3CurrentManagedChoice(input),
					submitManagedChoice: input => controller.submitChoice(input),
				});
				lifecycleGatewayAddress = await seatStateGateway.listen();
				return seatStateGateway;
			},
			cleanupManagedChoices: candidateRoom => controller.cleanupRoom(candidateRoom),
		});
		const created = await lifecycleCoordinator.createRoom({ config: { mode: "xingBei", playerCount: 4 } });
		assert.equal(created.ok, true, `room creation rejected: ${created.code || "unknown"}`);
		roomId = created.room.roomId;
		setup = { mode: "xingBei", config: { playerCount: 4 }, seats: ["seat_a", "seat_b", "seat_c", "seat_d"].map((seatId, position) => ({ seatId, position })) };
		immutableServerSeatIds = Object.freeze(setup.seats.map(({ seatId }) => seatId));
		actionGatewayStateSequences = new Map(immutableServerSeatIds.map(seatId => [seatId, 0]));
		assert.equal(Object.hasOwn(created.room, "credentials"), false);
		for (const credential of seatCredentials.values()) assert.equal(JSON.stringify(created.room).includes(credential), false,
			"the server-generated public room descriptor must not expose any per-seat credential");
		assert.equal(seatCredentials.size, 4, "the server-only delivery callback receives one credential per immutable seat");
		for (const seatId of immutableServerSeatIds) {
			const joined = lifecycleCoordinator.joinSeat({ roomId, seatId, credential: credentialFor(seatId),
				connectionId: `conn_${seatId}`, principal: { kind: "ordinary_player" } });
			assert.equal(joined.ok, true);
			assert.equal(lifecycleCoordinator.markSeatReady({ roomId, seatId, credential: credentialFor(seatId),
				connectionId: `conn_${seatId}`, principal: { kind: "ordinary_player" } }).ok, true);
		}
		assert.equal(lifecycleCoordinator.inspect(roomId).state, "ready");
		startResult = await lifecycleCoordinator.startRoom({ roomId });
		assert.equal(startResult.ok, true, `Coordinator did not start the managed room: ${startResult.code || "unknown"}`);
		assert.equal(startResult.room.state, "running");
		event6LogStage("room-coordinator-running");
	} else startResult = await manager.start(roomId, setup);
	event6LogStage(`manager-start-result:${startResult?.ok ? "ok" : startResult?.code || "unknown"}`);
	assert.equal(startResult.ok, true, `managed host start rejected: ${startResult.code || "unknown"}`);
	if (process.env.V2_NATIVE_EFFECT_STATE_ONLY === "1") {
		await until(() => nativeEffectStateFailures.length > 0 || nativeEffectStateRepeat?.ok && nativeResponseChoice &&
			controller.inspect(roomId, nativeResponseChoice.choiceId)?.state === "resolved" && manager.inspect(roomId)?.state === "playable_probe",
			15000, () => ({ session: manager.inspect(roomId), effectSnapshots: [nativeEffectStateBefore?.ok, nativeEffectStateAfter?.ok,
				nativeEffectStateRepeat?.ok], responseChoiceState: nativeResponseChoice && controller.inspect(roomId, nativeResponseChoice.choiceId)?.state,
				effectFailures: nativeEffectStateFailures, responseStages: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("response")).slice(-8).map(entry => entry?.stage) }));
		assert.deepEqual(nativeEffectStateFailures, [], `native effect snapshot failure: ${JSON.stringify(nativeEffectStateFailures)}`);
		assert.equal(manager.inspect(roomId)?.authorityStateRevision, 4,
			"the constrained effect-state projection must not advance authority beyond the already validated Event #4");
		assert.deepEqual(manager.inspect(roomId)?.lastAuthorityEvent, { sequence: 4, name: "gongJiOrFaShu" });
		assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 5);
		assert.equal(nativeEffectStateBefore?.snapshot?.snapshotOrdinal, 1);
		assert.equal(nativeEffectStateAfter?.snapshot?.snapshotOrdinal, 2);
		assert.equal(nativeEffectStateRepeat?.snapshot?.snapshotOrdinal, 3);
		assert.equal(nativeEffectStateAfter.snapshot.nativeEventId, nativeResponseCandidate.nativeEventId);
		assert.equal(nativeEffectStateAfter.snapshot.nativeCompletionOrdinal, nativeEffectStateRepeat.snapshot.nativeCompletionOrdinal);
		assert.equal(nativeEffectStateAfter.snapshot.stableWithPrevious, false);
		assert.equal(nativeEffectStateRepeat.snapshot.stableWithPrevious, true);
		assert.equal(nativeEffectStateRepeat.snapshot.commitment, nativeEffectStateAfter.snapshot.commitment);
		assert.notEqual(nativeEffectStateBefore.snapshot.commitment, nativeEffectStateAfter.snapshot.commitment);
		assert.ok(nativeDiagnostic.some(entry => entry?.stage === "native_response_completed" &&
			entry?.snapshot?.nativeEventId === nativeResponseCandidate.nativeEventId &&
			entry?.snapshot?.responseUseCardChildrenCompleted === 1 && entry?.snapshot?.rootObjectMatches === true &&
			entry?.snapshot?.gameMeAbsent === true), "effect commitment lacks the completed native response/useCard boundary");
						assert.equal(nativeEffectStateAfter.snapshot.checkpointAvailable, false);
						assert.equal(nativeEffectStateRepeat.snapshot.checkpointAvailable, false);
						assert.equal(manager.inspect(roomId)?.checkpointAvailable, false);
						for (const snapshot of [nativeEffectStateBefore.snapshot, nativeEffectStateAfter.snapshot,
							nativeEffectStateRepeat.snapshot]) {
							assert.deepEqual(Object.keys(snapshot).sort(), ["captureBoundary", "checkpointAvailable", "commitment",
								"engineBuildId", "mode", "nativeCompletionOrdinal", "nativeEventId", "rootInstanceId", "schema",
								"schemaVersion", "snapshotOrdinal", "stableWithPrevious"].sort(),
							"private IPC result must expose only its bounded commitment envelope");
							assert.match(snapshot.commitment, /^[a-f0-9]{64}$/);
							assert.equal(snapshot.checkpointAvailable, false);
						}
					const publicEffectEnvelope = JSON.stringify([nativeEffectStateBefore.snapshot, nativeEffectStateAfter.snapshot,
						nativeEffectStateRepeat.snapshot]);
					for (const privateValue of ["yinYangZhanHuan", "guiHuo", "skills", "storage", ...setup.seats.map(seat => seat.seatId)]) {
						assert.equal(publicEffectEnvelope.includes(privateValue), false,
							"effect snapshot envelope must not expose private skill/mark values or seat identities");
					}
					const effectHost = launchedHandles.get(manager.inspect(roomId)?.sessionId);
		assert.ok(effectHost, "effect probe lost its managed host handle before cleanup");
		assert.equal((await manager.stop(roomId, "native_effect_probe_complete")).ok, true);
		await until(() => effectHost.resources().length === 0, 10000, () => ({ resources: effectHost.resources() }));
		await effectHost.waitForCleanup();
		return;
	}
	if (process.env.V2_NATIVE_EFFECT_STOP_BARRIER === "1") {
		await until(() => nativeEffectStopSnapshotPromise && nativeResponseCandidate &&
			nativeDiagnostic.some(entry => entry?.stage === "native_effect_snapshot_captured_before_delivery" &&
				entry?.nativeEventId === nativeResponseCandidate.nativeEventId), 30000,
			() => ({ session: manager.inspect(roomId), authoritySubmissions: authoritySubmissions.map(entry => ({
				sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })), candidate: nativeResponseCandidate && {
				eventName: nativeResponseCandidate.eventName, seatId: nativeResponseCandidate.seatId,
				nativeEventId: nativeResponseCandidate.nativeEventId }, stages: nativeDiagnostic.slice(-12).map(entry => entry?.stage) }));
		assert.equal(nativeEffectStopSnapshotSettled, false,
			"the host must be blocked after native capture but before sending its authenticated snapshot response");
		const beforeStop = manager.inspect(roomId);
		assert.equal(beforeStop.state, "playable_probe");
		assert.equal(beforeStop.authorityStateRevision, 3);
		assert.deepEqual(beforeStop.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(beforeStop.nextAuthorityEventSequence, 4);
		assert.equal(nativeResponseChoices.length, 0, "no player choice may be registered before this snapshot boundary");
		const waitOpen = nativeDiagnostic.find(entry => entry?.stage === "native_response_wait_open" &&
			entry?.snapshot?.nativeEventId === nativeResponseCandidate.nativeEventId);
		assert.ok(waitOpen, "real native response wait gate was not observed before snapshot capture");
		assert.equal(waitOpen.snapshot?.waitEventName, "managedNativeResponseWait");
		assert.equal(waitOpen.snapshot?.waitEventParentName, "yingZhan");
		const host = launchedHandles.get(beforeStop.sessionId);
		assert.ok(host?.pid > 0, "the managed Chromium process must exist at the native response boundary");
		assert.equal((await manager.stop(roomId, "native_effect_snapshot_pending_stop")).ok, true);
		assert.deepEqual(await nativeEffectStopSnapshotPromise, { ok: false, code: "NATIVE_EFFECT_STATE_SESSION_ENDED" },
			"a captured but undelivered native snapshot must be canceled when its host stops");
		const stopped = manager.inspect(roomId);
		assert.equal(stopped.state, "stopped");
		assert.equal(stopped.authorityStateRevision, 3, "stopping at the private snapshot fence must not create authority Event #4");
		assert.deepEqual(stopped.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(stopped.nextAuthorityEventSequence, 4);
		assert.equal(stopped.checkpointAvailable, false);
		assert.equal(authoritySubmissions.some(entry => entry.proof?.eventSequence >= 4), false);
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_phase_boundary_release_command_accepted"), false);
		assert.equal(sessionEnds.filter(entry => entry.sessionId === beforeStop.sessionId).length, 1,
			"stop must notify cleanup exactly once for the matching host session");
		await until(() => host.resources().length === 0, 10000, () => ({ resources: host.resources(), state: manager.inspect(roomId)?.state }));
		await host.waitForCleanup();
		assert.equal(host.resources().length, 0, "Chromium process/profile resources must be fully cleaned after stop");
		t.diagnostic(`T3-B2-C3 real Chromium stop fence: ${JSON.stringify({ sameRoot: true,
			nativeEventId: nativeResponseCandidate.nativeEventId, authorityRevision: stopped.authorityStateRevision,
			lastAuthorityEvent: stopped.lastAuthorityEvent, sessionState: stopped.state, resourcesAfterCleanup: host.resources().length,
			gameMeNull: waitOpen.snapshot?.gameMeAbsent === true, event5Rejected: true, checkpointAvailable: stopped.checkpointAvailable })}`);
		return;
	}
	if (process.env.V2_TEST_MATCH_RECORD_POST === "1") {
		await until(() => engineReadyProof?.testMatchRecordPostBlocked === 1, 10000,
			() => ({ engineReady: engineReadyProof && { mode: engineReadyProof.mode, offboard: engineReadyProof.offboard,
				testMatchRecordPostBlocked: engineReadyProof.testMatchRecordPostBlocked } }));
		assert.equal(engineReadyProof.testMatchRecordPostBlocked, 1,
			"the real Xingbei match-record method must be intercepted before any external request leaves Chromium");
	}
	if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_native_skill_candidate_probe" &&
		process.env.V2_NATIVE_C3_UNIFIED_ROOT === "1") {
		await until(() => opened.length === 4 || manager.inspect(roomId)?.authorityStateRevision >= 1,
			15000, () => ({ session: manager.inspect(roomId), openedCount: opened.length,
				handlerFailures: managedChoiceHandlerFailures.slice(-4), diagnostics: nativeDiagnostic.slice(-8).map(entry => entry?.stage) }));
		if (opened.length !== 4) {
			const before = nativeDiagnostic.length;
			const snapshotRequest = await manager.snapshotNativeStart(roomId, "managed_native_skill_candidate_probe");
			assert.equal(snapshotRequest.ok, true,
				`the read-only unified-root snapshot command was rejected: ${snapshotRequest.code || "unknown"}; state=${JSON.stringify(manager.inspect(roomId))}; ` +
				`diagnostics=${JSON.stringify(nativeDiagnostic.slice(-8))}; handlerFailures=${JSON.stringify(managedChoiceHandlerFailures.slice(-4))}`);
			await until(() => nativeDiagnostic.slice(before).some(entry => entry?.stage === "native_jirimo_root_snapshot"),
				3000, () => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-8).map(entry => entry?.stage),
					diagnostics: nativeDiagnostic.slice(-8), sessionEnds: sessionEnds.slice(-3) }));
			await until(() => nativeDiagnostic.some(entry => entry?.stage === "native_jirimo_event1_gate_released"),
				3000, () => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-8).map(entry => entry?.stage) }));
			const afterReleaseSnapshot = nativeDiagnostic.filter(entry => entry?.stage === "native_jirimo_root_snapshot").length;
			const afterReleaseRequest = await manager.snapshotNativeStart(roomId, "managed_native_skill_candidate_probe");
			assert.equal(afterReleaseRequest.ok, true,
				`the post-Event-#1 read-only unified-root snapshot was rejected: ${afterReleaseRequest.code || "unknown"}; state=${JSON.stringify(manager.inspect(roomId))}; `+
				`diagnostics=${JSON.stringify(nativeDiagnostic.slice(-10))}; handlerFailures=${JSON.stringify(managedChoiceHandlerFailures.slice(-6))}`);
			await until(() => nativeDiagnostic.filter(entry => entry?.stage === "native_jirimo_root_snapshot").length > afterReleaseSnapshot,
				3000, () => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-8).map(entry => entry?.stage) }));
		}
	}
	await until(() => {
		const current = manager.inspect(roomId);
		if (current?.state === "failed") throw new Error(`native choice host failed: ${current.failureCode}:${JSON.stringify({ nativeDiagnostic: nativeDiagnostic.slice(-18), handlerFailures: managedChoiceHandlerFailures.slice(-4), authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })), opened: opened.map(choice => choice.choiceId) })}`);
		if (current && ["stopped", "stopping"].includes(current.state)) throw new Error(`native choice host stopped before opening choices:${JSON.stringify({
			state: current.state, code: sessionEnds.at(-1)?.code || null, failureCode: current.failureCode,
			authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })),
			openedCount: opened.length, choiceStates: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state || null),
			deliveryFailures: deliveryFailures.map(({ deliveryAttempts, code }) => ({ deliveryAttempts, code })),
			engineReady: engineReadyProof ? { browserReady: engineReadyProof.browserReady, engineReady: engineReadyProof.engineReady, mode: engineReadyProof.mode } : null,
			hostResources: launchedHandles.get(current.sessionId)?.resources().length ?? null,
		})}`);
		return opened.length === 4;
	}, managedChoiceOpenObservationMs, () => ({ session: manager.inspect(roomId), openedCount: opened.length,
		characterCandidateCount: candidatesSeen?.length || 0, nativeDiagnostic: nativeDiagnostic.slice(-12),
		handlerFailures: managedChoiceHandlerFailures.slice(-4) }));
	assert.ok(candidatesSeen.every(choice => choice.options.length >= 2));
	const [a, b, c, d] = opened;
	if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_input_controller_fault_before_apply") {
		assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: a.hostSessionId, nativeEventId: a.nativeEventId, seatId: a.seatId,
			eventSequence: 2, choiceId: a.choiceId, connectionId: `conn_${a.seatId}`, credential: credentialFor(a.seatId), option: a.options[1] }).ok, true);
		assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: c.hostSessionId, nativeEventId: c.nativeEventId, seatId: c.seatId,
			eventSequence: 2, choiceId: c.choiceId, connectionId: `conn_${c.seatId}`, credential: credentialFor(c.seatId), option: c.options[0] }).ok, true);
		assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: d.hostSessionId, nativeEventId: d.nativeEventId, seatId: d.seatId,
			eventSequence: 2, choiceId: d.choiceId, connectionId: `conn_${d.seatId}`, credential: credentialFor(d.seatId), option: d.options[0] }).ok, true);
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 2, 20000,
			() => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state) }));
		assert.equal((await manager.diagnoseNativeStart(roomId, "managed_input_controller_fault_before_apply")).ok, true);
		await until(() => manager.inspect(roomId)?.state === "failed", 20000,
			() => ({ session: manager.inspect(roomId), action: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), nativeDiagnostic: nativeDiagnostic.slice(-8) }));
		assert.equal(manager.inspect(roomId).failureCode, "NATIVE_ACTION_APPLY_UNCERTAIN", JSON.stringify(nativeDiagnostic.slice(-10)));
		assert.equal(nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), null, "failed host must clear its controller-owned pending choice");
		assert.ok(opened.slice(0, 4).every(choice => controller.inspect(roomId, choice.choiceId) === null), "failed host left character-choice records behind");
		const faultHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
		await until(() => faultHandle.resources().length === 0, 10000, () => ({ resources: faultHandle.resources() }));
		await faultHandle.waitForCleanup();
		return;
	}
	if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
		for (const choice of opened) {
			const option = choice.seatId === nativeResourceFixtureSeatId ? "shengQiangQiShi" : choice.options[0];
			assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: choice.hostSessionId, nativeEventId: choice.nativeEventId,
				seatId: choice.seatId, eventSequence: 2, choiceId: choice.choiceId, connectionId: `conn_${choice.seatId}`,
				credential: credentialFor(choice.seatId), option }).ok, true, `native shengJi fixture character choice rejected for ${choice.seatId}`);
		}
	} else if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
		for (const choice of opened) {
			const option = choice.seatId === nativeJiRiFixtureSeatId ? "jieRiMoDao" : choice.options[0];
			assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: choice.hostSessionId, nativeEventId: choice.nativeEventId,
				seatId: choice.seatId, eventSequence: 2, choiceId: choice.choiceId, connectionId: `conn_${choice.seatId}`,
				credential: credentialFor(choice.seatId), option }).ok, true, `native jieRiMoDao fixture character choice rejected for ${choice.seatId}`);
		}
	} else if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1") {
		for (const choice of opened) {
			const option = choice.options.includes("yinYangShi") && choice.seatId === nativeYinYangFixtureSeatId ? "yinYangShi" : choice.options[0];
			assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: choice.hostSessionId, nativeEventId: choice.nativeEventId,
				seatId: choice.seatId, eventSequence: 2, choiceId: choice.choiceId, connectionId: `conn_${choice.seatId}`,
				credential: credentialFor(choice.seatId), option }).ok, true, `native fixture choice rejected for ${choice.seatId}`);
		}
	} else assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: a.hostSessionId, nativeEventId: a.nativeEventId, seatId: a.seatId, eventSequence: 2, choiceId: a.choiceId, connectionId: `conn_${a.seatId}`, credential: credentialFor(a.seatId), option: a.options[1] }).ok, true);
	// Fixture paths submit every seat's immutable native candidate above; keep
	// the default-path rebind/replay assertions from submitting seat C twice.
	if (process.env.V2_NATIVE_YINYANG_FIXTURE !== "1" && process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE !== "1" && process.env.V2_NATIVE_JIRIMO_FIXTURE !== "1") {
	assert.equal(bindSeat(c.seatId, `new_${c.seatId}`).ok, true);
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: c.hostSessionId, nativeEventId: c.nativeEventId, seatId: c.seatId, eventSequence: 2, choiceId: c.choiceId, connectionId: `conn_${c.seatId}`, credential: credentialFor(c.seatId), option: c.options[0] }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: c.hostSessionId, nativeEventId: c.nativeEventId, seatId: c.seatId, eventSequence: 2, choiceId: c.choiceId, connectionId: `new_${c.seatId}`, credential: credentialFor(c.seatId), option: c.options[0] }).ok, true);
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: d.hostSessionId, nativeEventId: d.nativeEventId, seatId: d.seatId, eventSequence: 2, choiceId: d.choiceId, connectionId: `conn_${d.seatId}`, credential: credentialFor(d.seatId), option: "forged" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: d.hostSessionId, nativeEventId: d.nativeEventId, seatId: d.seatId, eventSequence: 2, choiceId: d.choiceId, connectionId: `conn_${d.seatId}`, credential: credentialFor(d.seatId), option: d.options[0] }).ok, true);
	}
	if (process.env.V2_NATIVE_REJECT_OPENING_DRAW_EVENT3 === "1") {
		await until(() => manager.inspect(roomId)?.state === "failed", 15000,
			() => ({ session: manager.inspect(roomId), nativeDiagnostic }));
		assert.equal(manager.inspect(roomId).failureCode, "HOST_AUTHORITY_EVENT_REJECTED");
		assert.equal(manager.inspect(roomId).authorityStateRevision, 2, "rejected Event #3 must not advance authority state");
		assert.deepEqual(manager.inspect(roomId).lastAuthorityEvent, { sequence: 2, name: "chooseCharacterOL" });
		assert.ok(event3Proof, "managed host did not produce the native opening-draw proof");
		assert.equal(event3Proof.eventSequence, 3);
		assert.equal(event3Proof.event.phaseLoopPaused, true, "rejected Event #3 must be submitted while the original root holds phaseLoop");
		assert.equal(event3Proof.beforeDigest, manager.inspect(roomId).authorityDigestChain[1].afterDigest);
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "existing_root_phase_loop_released"), false,
			"phaseLoop cannot release after Event #3 rejection");
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "opening_draw_event_3_accepted"), false);
		const failedHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
		await until(() => failedHandle.resources().length === 0, 10000, () => ({ resources: failedHandle.resources() }));
		await failedHandle.waitForCleanup();
		return;
	}
	const expectedAuthorityRevision = process.env.V2_NATIVE_OPENING_DRAW_EVENT3 === "1" ?
		(process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4") ||
			process.env.V2_NATIVE_START_PROBE_MODE === "managed_opening_root_action_event5" ||
			process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1" ? 4 : 3) : 2;
	const probeMode = process.env.V2_NATIVE_START_PROBE_MODE || "native_start";
	if (probeMode === "managed_opening_root_action_event5") t.diagnostic(`Event #5 diagnostic gates: ${JSON.stringify({
		phaseBoundaryAudit: process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1",
		phaseBoundaryFence: process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1",
		parentFence: process.env.V2_NATIVE_PARENT_FENCE === "1",
		multiTurnInput: process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1",
		multiTurnCompletion: process.env.V2_NATIVE_MULTI_TURN_COMPLETION_SEQUENCE === "1",
		multiTurnCapture: process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1",
		eventLimit: process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT || null,
	})}`);
	if (process.env.V2_NATIVE_RANDOM_FAILURE_PROBE === "1") {
		assert.equal(expectedAuthorityRevision, 3, "the runtime RNG failure probe must stop after accepted native opening draw");
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 3, 45000,
			() => ({ session: manager.inspect(roomId), nativeDiagnostic: nativeDiagnostic.slice(-12) }));
		assert.equal((await manager.diagnoseNativeStart(roomId, "managed_random_failure_probe")).ok, true);
		await until(() => manager.inspect(roomId)?.state === "failed", 10000,
			() => ({ session: manager.inspect(roomId), nativeDiagnostic: nativeDiagnostic.slice(-12) }));
		const randomFailureDiagnostic = await until(() => nativeDiagnostic.find(entry => entry?.kind === "managed_random_failure_v1"), 5000,
			() => ({ session: manager.inspect(roomId), nativeDiagnostic: nativeDiagnostic.slice(-12) }));
		const failed = manager.inspect(roomId);
		assert.equal(failed.failureCode, "MANAGED_RANDOM_SOURCE_FAILED");
		assert.equal(randomFailureDiagnostic.failureCode, "MANAGED_RANDOM_SOURCE_FAILED");
		assert.equal(failed.authorityStateRevision, 3, "an RNG failure must not advance authority state beyond Event #3");
		assert.deepEqual(failed.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(failed.nextAuthorityEventSequence, 4, "the RNG-failed game must not create Event #4 or Event #5");
		assert.equal(authoritySubmissions.some(entry => entry.proof?.eventSequence >= 4), false);
		assert.ok(opened.every(choice => controller.inspect(roomId, choice.choiceId) === null), "host failure must clear all native choices");
		const failedHandle = launchedHandles.get(failed.sessionId);
		await until(() => failedHandle.resources().length === 0, 10000, () => ({ resources: failedHandle.resources() }));
		await failedHandle.waitForCleanup();
		return;
	}
	let actionDiagnosticDispatched = process.env.V2_NATIVE_C3_UNIFIED_ROOT === "1";
	let completed;
	let openingDrawAccepted = null;
	if (probeMode === "managed_opening_root_action_stop_before_release") {
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 3, 45000,
			() => ({ session: manager.inspect(roomId), nativeDiagnostic }));
		assert.equal((await manager.stop(roomId, "event3_accepted_before_phase_release")).ok, true);
		assert.equal(manager.inspect(roomId)?.state, "stopped", JSON.stringify({
			session: manager.inspect(roomId), sessionEnds: sessionEnds.slice(-3),
			managedChoiceHandlerFailures: managedChoiceHandlerFailures.slice(-4),
			nativeStages: safeNativeDiagnostic(nativeDiagnostic.slice(-12).map(entry => ({ stage: entry?.stage,
				classification: entry?.classification, failureCode: entry?.failureCode, snapshot: entry?.snapshot || null }))),
		}));
		assert.equal(manager.inspect(roomId)?.authorityStateRevision, 3);
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "existing_root_phase_loop_released"), false,
			"stop after Event #3 but before phase release cannot start the phase loop");
		const stoppedHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
		await until(() => stoppedHandle.resources().length === 0, 10000, () => ({ resources: stoppedHandle.resources() }));
		await stoppedHandle.waitForCleanup();
		return;
	}
	if (probeMode.startsWith("managed_opening_root_action_event4")) {
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 3,
			45000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), nativeDiagnostic }));
		if (process.env.V2_NATIVE_C3_UNIFIED_ROOT !== "1") {
			assert.equal((await manager.diagnoseNativeStart(roomId, probeMode)).ok, true);
		}
		actionDiagnosticDispatched = true;
	}
	if (probeMode.startsWith("managed_opening_root_action_event4") && ["use_result_throws", "use_card_child_throws"].includes(nativeFaultMode)) {
		await until(() => manager.inspect(roomId)?.state === "failed", 20000,
			() => ({ session: manager.inspect(roomId), choice: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), nativeDiagnostic: nativeDiagnostic.slice(-12) }));
		const expectedFailure = nativeFaultMode === "use_result_throws" ? "NATIVE_USE_RESULT_FAILED" : "NATIVE_USE_CARD_CHILD_FAILED";
		assert.equal(manager.inspect(roomId).failureCode, expectedFailure, JSON.stringify(nativeDiagnostic.slice(-12)));
		assert.equal(manager.inspect(roomId).authorityStateRevision, 3, "an incomplete native card action cannot commit Event #4");
		assert.deepEqual(manager.inspect(roomId).lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(nativeActionAckCount, 0, "an incomplete or uncertain native action cannot be ACKed");
		assert.ok(nativeActionChoice, "fault injection did not reach the native action choice");
		assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null, "failed host must clear the pending action choice");
		const actionEntries = nativeDiagnostic.filter(entry => entry?.snapshot?.nativeAction?.eventId === nativeActionCandidate?.nativeEventId);
		const useResultCount = Math.max(0, ...actionEntries.map(entry => entry.snapshot.nativeAction.useResultCount || 0));
		assert.equal(useResultCount, 1, "failure after dispatch must never replay native useResult");
		if (nativeFaultMode === "use_card_child_throws") {
			const childFailure = nativeDiagnostic.find(entry => entry?.stage === "native_useCard_child_exception");
			assert.equal(childFailure?.snapshot?.nativeAction?.nativeUseCardHistoryEntries, 1);
			assert.equal(childFailure?.snapshot?.nativeAction?.cardInHandAtFailure, false);
		}
		const failedHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
		await until(() => failedHandle.resources().length === 0, 10000, () => ({ resources: failedHandle.resources() }));
		await failedHandle.waitForCleanup();
		return;
	}
	if (viewasRevalidationFaultModes.includes(nativeFaultMode)) {
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 3,
			45000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), nativeDiagnostic }));
		if (process.env.V2_NATIVE_C3_UNIFIED_ROOT !== "1") {
			assert.equal((await manager.diagnoseNativeStart(roomId, probeMode)).ok, true);
		}
		await until(() => nativeResponseChoice || manager.inspect(roomId)?.state === "failed", 20000,
			() => ({ session: manager.inspect(roomId), actionCandidate: Boolean(nativeActionCandidate), stages: nativeDiagnostic.slice(-20).map(entry => entry?.stage) }));
		assert.ok(nativeResponseChoice, `viewAs fault did not reach an actual managed native response choice: ${JSON.stringify({ session: manager.inspect(roomId),
			actionCandidate: nativeActionCandidate && { nativeEventId: nativeActionCandidate.nativeEventId, optionCount: nativeActionCandidate.options?.length },
			stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage), response: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("response")).slice(-12) })}`);
		assert.ok(nativeResponseCandidate);
		assert.equal(nativeResponseCandidate.optionKinds[nativeResponseOptionId], "view_as_skill",
			"fault injection requires the live native viewAs candidate, not a synthetic option");
		assert.equal(nativeResponseAccepted, true, "the ordinary player's valid credential must first be accepted by the controller");
		const rejected = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_viewas_revalidation_rejected"), 12000,
			() => ({ session: manager.inspect(roomId), response: controller.inspect(roomId, nativeResponseChoice.choiceId),
				stages: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("viewas")).slice(-6) }));
		const expectedFailedCheck = nativeFaultMode === "viewas_material_removed_before_revalidation" ? "materialInHand" :
			nativeFaultMode === "viewas_skill_removed_before_revalidation" ? "skillOwned" : "skillFilter";
		assert.deepEqual(rejected.testFault, { mode: nativeFaultMode, candidateWasGenerated: true,
			invalidationApplied: true, resultUntouched: true, postValidationResultUntouched: true },
		"test-only invalidation must occur after a real candidate was issued and before native result assignment");
		assert.ok(rejected.failedChecks.includes(expectedFailedCheck),
			`existing native legality revalidation did not reject ${nativeFaultMode}: ${JSON.stringify(rejected.failedChecks)}`);
		await until(() => manager.inspect(roomId)?.state === "failed", 12000,
			() => ({ session: manager.inspect(roomId), rejected, ends: sessionEnds.slice(-3) }));
		const failedSession = manager.inspect(roomId);
		assert.equal(failedSession.failureCode, "NATIVE_VIEWAS_REVALIDATION_REJECTED");
		assert.equal(failedSession.authorityStateRevision, 3, "invalidated skill context must not submit or accept Event #4");
		assert.deepEqual(failedSession.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(event4SubmissionCount, 0);
		assert.equal(authoritySubmissions.some(entry => entry.proof?.eventSequence === 4), false);
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_response_applied"), false,
			"revalidation failure must not report a native response as applied");
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_card_action_event_4_accepted"), false);
		assert.equal(viewasRedeliveryIssued, true, "same immutable native delivery was not retried during application");
		assert.equal(viewasRedeliveryIdentity?.choiceId, nativeResponseChoice.choiceId);
		assert.equal(viewasRedeliveryIdentity?.nativeEventId, nativeResponseChoice.nativeEventId);
		assert.equal(nativeDiagnostic.filter(entry => entry?.stage === "native_viewas_revalidation_rejected").length, 1,
			"the immutable retry must not apply or revalidate the skill a second time");
		assert.equal(ackTrace.some(entry => entry.choiceId === nativeResponseChoice.choiceId && entry.nativeApplied), false,
			"invalid native response must not emit a success ACK");
		assert.equal(controller.inspect(roomId, nativeResponseChoice.choiceId), null,
			"managed-host failure cleanup must remove the pending skill choice and its timers");
		assert.equal(controller.pendingCount(), 0);
		assert.equal(sessionEnds.filter(entry => entry.sessionId === failedSession.sessionId).length, 1,
			"failed native revalidation must end the host session exactly once");
		const failedHandle = launchedHandles.get(failedSession.sessionId);
		await until(() => failedHandle.resources().length === 0, 10000, () => ({ resources: failedHandle.resources() }));
		await failedHandle.waitForCleanup();
		return;
	}
	if (viewasExecutionFaultModes.includes(nativeFaultMode)) {
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 3,
			45000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), nativeDiagnostic }));
		if (process.env.V2_NATIVE_C3_UNIFIED_ROOT !== "1") assert.equal((await manager.diagnoseNativeStart(roomId, probeMode)).ok, true);
		await until(() => nativeResponseChoice || ["failed", "stopped", "stopping"].includes(manager.inspect(roomId)?.state), 20000,
			() => ({ session: manager.inspect(roomId), actionCandidate: nativeActionCandidate && { eventName: nativeActionCandidate.eventName, seatId: nativeActionCandidate.seatId },
				stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage) }));
		assert.ok(nativeResponseChoice, `native skill failure did not reach its managed response choice: ${JSON.stringify({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-20).map(entry => entry?.stage) })}`);
		assert.equal(nativeResponseCandidate?.optionKinds?.[nativeResponseOptionId], "view_as_skill");
		assert.equal(nativeResponseAccepted, true, "fault must occur after a valid ordinary-seat selection was accepted");
		await until(() => viewasRedeliveryIssued, 5000, () => ({
			choice: controller.inspect(roomId, nativeResponseChoice.choiceId),
			applyingReceipts: applyingReceipts.map(entry => ({ choiceId: entry.choiceId, nativeEventId: entry.nativeEventId })),
			responseNativeEventId: nativeResponseChoice.nativeEventId,
			session: manager.inspect(roomId) ? { state: manager.inspect(roomId).state, failureCode: manager.inspect(roomId).failureCode } : null,
		}));
		assert.equal(viewasRedeliveryIssued, true, `the applying skill result was not retried with its original immutable identity: ${JSON.stringify({
			responseChoiceId: nativeResponseChoice?.choiceId || null, responseOptionId: nativeResponseOptionId || null,
			responseOptionKind: nativeResponseCandidate?.optionKinds?.[nativeResponseOptionId] || null,
			registeredResponses: nativeResponseChoices.map(entry => ({ choiceId: entry.choice.choiceId, nativeEventId: entry.candidate.nativeEventId,
				optionKind: entry.candidate.optionKinds?.[entry.option] || null })),
			applyingReceipts: applyingReceipts.map(entry => ({ choiceId: entry.choiceId, nativeEventId: entry.nativeEventId })),
			session: manager.inspect(roomId) ? { state: manager.inspect(roomId).state, failureCode: manager.inspect(roomId).failureCode,
				authorityStateRevision: manager.inspect(roomId).authorityStateRevision } : null,
			deliveryFailures: deliveryFailures.slice(-4), stages: nativeDiagnostic.slice(-20).map(entry => entry?.stage),
			lastDiagnostics: nativeDiagnostic.slice(-6).map(entry => ({ stage: entry?.stage || null,
				failureCode: entry?.failureCode || null, nativeEventId: entry?.nativeEventId || null,
				kind: entry?.kind || null, detail: String(entry?.detail || "").replaceAll(sessionSecret || "", "[redacted]").slice(0, 160),
				detailCode: String(entry?.detail || "").match(/[A-Z][A-Z0-9_]{2,95}/)?.[0] || null })),
		})}`);
		if (viewasExecutionFaultModes.includes(nativeFaultMode)) {
			assert.ok(viewasBarrierReleasePromise, "native application barrier was not released after the immutable retry");
			await viewasBarrierReleasePromise;
			await until(() => viewasBarrierReleased, 5000, () => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-12).map(entry => entry?.stage) }));
		}
		assert.equal(viewasRedeliveryIdentity?.choiceId, nativeResponseChoice.choiceId);
		assert.equal(viewasRedeliveryIdentity?.nativeEventId, nativeResponseChoice.nativeEventId);
		if (nativeFaultMode === "viewas_partial_effect_stop") {
			const barrier = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_viewas_partial_effect_barrier"), 15000,
				() => ({ session: manager.inspect(roomId), response: controller.inspect(roomId, nativeResponseChoice.choiceId), stages: nativeDiagnostic.slice(-12) }));
			assert.equal(barrier.snapshot?.eventName, "changeZhiShiWu");
			assert.equal(barrier.snapshot?.partialEffectApplied, true, "native guiHuo change must have completed before stop barrier");
			assert.ok(barrier.snapshot?.guiHuoDelta > 0);
			assert.equal(barrier.snapshot?.useCardChildrenStarted, 1);
			assert.equal(barrier.snapshot?.useCardChildrenCompleted, 0, "the parent native useCard must remain incomplete at the stop barrier");
			assert.equal(barrier.snapshot?.gameMeAbsent, true);
			assert.ok(nativeFaultStopPromise, "the parent process did not issue stop while the native effect was held at its barrier");
			const stopped = await nativeFaultStopPromise;
			assert.equal(stopped.ok, true, `managed host stop lost its race with the partial skill effect: ${stopped.code}`);
			const stoppedSession = manager.inspect(roomId);
			assert.equal(stoppedSession.state, "stopped");
			assert.equal(stoppedSession.authorityStateRevision, 3);
			assert.deepEqual(stoppedSession.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
			assert.equal(event4SubmissionCount, 0);
			assert.equal(nativeResponseAckCount, 0, "stop during partial effect cannot emit response success ACK");
			assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_response_applied"), false);
			assert.equal(controller.inspect(roomId, nativeResponseChoice.choiceId), null);
			assert.equal(controller.pendingCount(), 0);
			assert.equal(sessionEnds.filter(entry => entry.sessionId === stoppedSession.sessionId).length, 1);
			const stoppedHandle = launchedHandles.get(stoppedSession.sessionId);
			await until(() => stoppedHandle.resources().length === 0, 10000, () => ({ resources: stoppedHandle.resources() }));
			await stoppedHandle.waitForCleanup();
			return;
		}
		const expectedStage = nativeFaultMode === "viewas_result_assignment_throws" ? "native_viewas_result_assignment_exception" :
			nativeFaultMode === "viewas_useCard_child_throws" ? "native_viewas_useCard_child_exception" : "native_viewas_partial_effect_exception";
		const expectedFailureCode = nativeFaultMode === "viewas_result_assignment_throws" ? "NATIVE_VIEWAS_RESULT_SET_FAILED" :
			nativeFaultMode === "viewas_useCard_child_throws" ? "NATIVE_VIEWAS_USE_CARD_CHILD_FAILED" : "NATIVE_VIEWAS_PARTIAL_EFFECT_FAILED";
		const faultProof = await until(() => nativeDiagnostic.find(entry => entry?.stage === expectedStage), 15000,
			() => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-18).map(entry => entry?.stage) }));
		await until(() => manager.inspect(roomId)?.state === "failed", 12000,
			() => ({ session: manager.inspect(roomId), faultProof, ends: sessionEnds.slice(-3) }));
		const failedSession = manager.inspect(roomId);
		assert.equal(failedSession.failureCode, expectedFailureCode);
		assert.equal(failedSession.authorityStateRevision, 3, "incomplete native skill settlement cannot submit Event #4");
		assert.deepEqual(failedSession.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(event4SubmissionCount, 0);
		assert.equal(authoritySubmissions.some(entry => entry.proof?.eventSequence === 4), false);
		assert.equal(nativeResponseAckCount, 0, "native response result cannot ACK before the full skill child completes");
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_response_applied"), false);
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_card_action_event_4_accepted"), false);
		assert.equal(faultProof.snapshot?.gameMeAbsent, true);
		if (nativeFaultMode === "viewas_result_assignment_throws") {
			assert.equal(faultProof.snapshot?.candidateWasGenerated, true);
			assert.equal(faultProof.snapshot?.originalChecksAccepted, true);
			assert.equal(faultProof.snapshot?.resultUntouched, true);
			assert.equal(faultProof.snapshot?.useCardChildrenStarted, 0);
		} else if (nativeFaultMode === "viewas_useCard_child_throws") {
			assert.equal(faultProof.snapshot?.eventName, "useCard");
			assert.equal(faultProof.snapshot?.parentEventName, "yingZhan");
			assert.equal(faultProof.snapshot?.responseResultAssigned, true);
			assert.equal(faultProof.snapshot?.useCardChildrenStarted, 1);
			assert.equal(faultProof.snapshot?.useCardChildrenCompleted, 0);
		} else {
			assert.equal(faultProof.snapshot?.eventName, "changeZhiShiWu");
			assert.equal(faultProof.snapshot?.partialEffectApplied, true,
				"the fault must occur after a real native guiHuo state-change child completes");
			assert.ok(faultProof.snapshot?.guiHuoDelta > 0);
			assert.equal(faultProof.snapshot?.useCardChildrenStarted, 1);
			assert.equal(faultProof.snapshot?.useCardChildrenCompleted, 0);
		}
		assert.equal(controller.inspect(roomId, nativeResponseChoice.choiceId), null, "failed host must clear the pending native skill choice");
		assert.equal(controller.pendingCount(), 0);
		assert.equal(sessionEnds.filter(entry => entry.sessionId === failedSession.sessionId).length, 1);
		const failedHandle = launchedHandles.get(failedSession.sessionId);
		await until(() => failedHandle.resources().length === 0, 10000, () => ({ resources: failedHandle.resources() }));
		await failedHandle.waitForCleanup();
		return;
	}
	if (process.env.V2_NATIVE_REJECT_PARENT_FENCE_EVENT4 === "1") {
		const waiting = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_fence_waiting"), 10000,
			() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), session: manager.inspect(roomId) }));
		await until(() => event4SubmissionCount >= 1, 10000, () => ({
			session: (() => { const current = manager.inspect(roomId); return current && { state: current.state,
				failureCode: current.failureCode, authorityFailureReason: current.authorityFailureReason,
				authorityStateRevision: current.authorityStateRevision, lastAuthorityEvent: current.lastAuthorityEvent }; })(),
			proofCount: event4SubmissionCount,
			authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence,
				kind: entry.proof?.event?.kind })),
			stages: nativeDiagnostic.slice(-24).map(entry => ({ stage: entry?.stage || null,
				failureCode: entry?.failureCode || null, rejectionCode: entry?.rejectionCode || null,
				eventName: entry?.snapshot?.eventName || null, eventStep: entry?.snapshot?.eventStep ?? null,
				rootObjectMatches: entry?.snapshot?.rootObjectMatches ?? null,
				nativeUseCardChildCompleted: entry?.snapshot?.nativeUseCardChildCompleted ?? null })),
			fence: waiting?.snapshot && { status: waiting.snapshot.status, eventName: waiting.snapshot.parentEventName,
				nativeEventIdPresent: typeof waiting.snapshot.nativeEventId === "string" },
		}));
		assert.equal(event4SubmissionCount, 1, "the held native parent must produce exactly one Event #4 proof before any release");
		assert.equal(JSON.parse(event4ProofSubmissions[0]).afterDigest, "0".repeat(64), "test mutation did not reach the authority validator");
		await until(() => manager.inspect(roomId)?.state === "failed", 10000,
			() => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.map(entry => entry?.stage) }));
		const rejected = manager.inspect(roomId);
		assert.equal(rejected.failureCode, "HOST_AUTHORITY_EVENT_REJECTED");
		assert.equal(rejected.authorityStateRevision, 3, "rejected Event #4 must leave the accepted authority tip at revision 3");
		assert.deepEqual(rejected.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_parent_fence_released"), false,
			"rejected Event #4 released the native parent continuation");
		assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_card_action_event_4_accepted"), false,
			"rejected Event #4 emitted an accepted authority milestone");
		const fenceWaitIndex = nativeDiagnostic.indexOf(waiting);
		assert.equal(nativeDiagnostic.slice(fenceWaitIndex + 1).some(entry => entry?.stage === "native_parent_next_action_child_start"), false,
			"native action loop continued after Event #4 rejection");
		assert.equal(nativeActionAckCount, 0, "a rejected authority event must not receive a successful player-choice ACK");
		assert.ok(waiting.snapshot?.rootObjectMatches && waiting.snapshot?.gameMeAbsent,
			"the rejected fence was not bound to the live managed root or lost the headless-player invariant");
		assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null, "rejected host left its action choice pending");
		const rejectedHandle = launchedHandles.get(rejected.sessionId);
		await until(() => rejectedHandle.resources().length === 0, 10000, () => ({ resources: rejectedHandle.resources() }));
		await rejectedHandle.waitForCleanup();
		return;
	}
	try {
		completed = await until(() => {
			const session = manager.inspect(roomId);
			if (session?.state === "failed") throw new Error(`native choice failed:${JSON.stringify({ failureCode: session.failureCode, authorityFailureReason: session.authorityFailureReason, state: session.state, opened: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })), event4SubmissionCount, nativeActionAckCount, handlerFailureCount: managedChoiceHandlerFailures.length, droppedAcks, nativeCardLedgerFailures, responseAuthority: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("response_authority")).slice(-4), responseSummary: nativeDiagnostic.filter(entry => entry?.stage === "native_response_action_summary").slice(-3), actionAuthorityDiagnostics: safeNativeDiagnostic(nativeDiagnostic.filter(entry => ["event4_local_proof_rejected", "native_jiri_authority_proof_rejected", "native_action_event_completed"].includes(entry?.stage)).slice(-6).map(entry => ({ stage: entry.stage, failureCode: entry.failureCode || null, failedChecks: Array.isArray(entry.failedChecks) ? entry.failedChecks.slice(0, 12) : [], proofDiagnostics: entry.proofDiagnostics || null, snapshot: entry.snapshot || null }))), waitNextErrors: nativeDiagnostic.filter(entry => entry?.stage === "wait_next_error").slice(-3), responseStages: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("response")).slice(-8).map(entry => entry?.stage) })}`);
			return session?.authorityStateRevision === expectedAuthorityRevision && session;
		}, 45000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), deliveryCount, ackCount, droppedAcks, nativeDiagnostic }));
	} catch (error) {
		// This diagnostic is deliberately requested even when the host has not
		// failed: a live native child wait is distinct from a dead process. It
		// reports only event/seat/status/count metadata and never card identities,
		// credentials, or private hand commitments.
		const prior = nativeDiagnostic.length;
		const requested = await manager.snapshotNativeStart(roomId, "managed_opening_root_action_event4");
		if (requested.ok) {
			try { await until(() => nativeDiagnostic.slice(prior).some(entry => entry?.stage === "native_start_live_snapshot" || entry?.stage === "native_start_live_snapshot_failed"), 3000,
				() => ({ requested, session: manager.inspect(roomId) })); } catch { /* bounded best-effort diagnostic only */ }
		}
		const responses = nativeResponseChoices.map(({ choice, candidate }) => {
			const current = controller.inspect(roomId, choice.choiceId);
			return { nativeEventId: candidate.nativeEventId, seatId: candidate.seatId, choiceId: choice.choiceId,
				state: current?.state || null, deliveryAttempts: current?.deliveryAttempts || 0,
				acknowledged: current?.acknowledged === true };
		});
		const live = nativeDiagnostic.slice(prior).filter(entry => entry?.stage === "native_start_live_snapshot" || entry?.stage === "native_start_live_snapshot_failed").at(-1) || null;
		error.message += `; liveResponseDiagnostic=${JSON.stringify({ requested, session: manager.inspect(roomId), responses,
			responseAckCount: nativeResponseAckCount, recentResponseStages: safeNativeDiagnostic(nativeDiagnostic
				.filter(entry => String(entry?.stage || "").includes("response")).slice(-12)), live: safeNativeDiagnostic(live) })}`;
		throw error;
	}
	assert.ok(droppedAcks >= 4, `expected initial ACK loss plus bounded automatic retries, got ${droppedAcks}`);
	// Simulate lost parent-side ACK processing. Retry uses the unchanged delivery
	// IDs; Chromium must acknowledge the already-applied native result without
	// running `event.sendback` or Player.init a second time.
	dropAcks = false;
	for (const choice of opened) {
		const current = controller.inspect(roomId, choice.choiceId);
		if (current?.state === "delivery_pending") assert.equal(controller.retryDelivery({ roomId, choiceId: choice.choiceId }).ok, true);
		else assert.equal(current?.state, "resolved", "character-choice ACK retry must resolve before teardown");
	}
	if (nativeActionChoice && manager.inspect(roomId)?.authorityStateRevision === 4 && controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "delivery_pending") {
		assert.equal(controller.retryDelivery({ roomId, choiceId: nativeActionChoice.choiceId }).ok, true,
			"native action result must be redelivered after the intentionally dropped choice ACK");
	}
	await until(() => {
		const session = manager.inspect(roomId);
		if (session?.state === "failed") {
			const waitErrors = nativeDiagnostic.filter(entry => entry?.stage === "wait_next_error").slice(-4)
				.map(entry => ({ eventName: entry?.snapshot?.eventName || null,
					eventStep: Number.isSafeInteger(entry?.snapshot?.eventStep) ? entry.snapshot.eventStep : null,
					parentEventName: entry?.snapshot?.parentEventName || null,
					phaseLoopIdentityMatches: entry?.snapshot?.phaseLoopIdentityMatches === true,
					phaseOverTriggerCount: entry?.snapshot?.phaseOverTriggerCount ?? null,
					phaseOverDraftPresent: entry?.snapshot?.phaseOverDraftPresent === true,
					phaseOverDraftRootMatches: entry?.snapshot?.phaseOverDraftRootMatches === true,
					phaseOverDraftOwnerMatches: entry?.snapshot?.phaseOverDraftOwnerMatches === true,
					phaseOverDraftSeatId: entry?.snapshot?.phaseOverDraftSeatId || null,
					phaseOverDraftStep: entry?.snapshot?.phaseOverDraftStep ?? null,
					phaseOverDraftOrdinal: entry?.snapshot?.phaseOverDraftOrdinal ?? null,
						error: entry?.snapshot?.nativeWaitError || null }));
			const phaseOverEvidence = nativeDiagnostic.filter(entry => ["native_phase_over_trigger_called", "phase_over_wait_next_entered",
				"native_phase_loop_wait_next_boundary"].includes(entry?.stage)).slice(-8).map(entry => ({ stage: entry.stage,
				eventName: entry?.snapshot?.eventName || null, eventStep: Number.isSafeInteger(entry?.snapshot?.eventStep) ? entry.snapshot.eventStep : null,
				parentEventName: entry?.snapshot?.parentEventName || null, rootInstanceId: entry?.snapshot?.rootInstanceId || null,
				rootObjectMatches: entry?.snapshot?.rootObjectMatches === true, phaseLoopIdentityMatches: entry?.snapshot?.phaseLoopIdentityMatches === true,
				phaseLoopEventInstanceId: entry?.snapshot?.phaseLoopEventInstanceId || null, phaseOverTriggerCount: entry?.snapshot?.phaseOverTriggerCount ?? entry?.snapshot?.triggerCount ?? null,
				phaseOverDraftPresent: entry?.snapshot?.phaseOverDraftPresent === true,
				phaseOverDraftRootMatches: entry?.snapshot?.phaseOverDraftRootMatches === true,
				phaseOverDraftOwnerMatches: entry?.snapshot?.phaseOverDraftOwnerMatches === true,
				phaseOverDraftSeatId: entry?.snapshot?.phaseOverDraftSeatId || null,
				phaseOverDraftStep: entry?.snapshot?.phaseOverDraftStep ?? null,
				phaseOverDraftOrdinal: entry?.snapshot?.phaseOverDraftOrdinal ?? null,
				triggerEventName: entry?.snapshot?.triggerEventName || null,
				triggerEventParentMatches: entry?.snapshot?.triggerEventParentMatches === true,
				completionOrdinal: entry?.snapshot?.completionOrdinal ?? entry?.snapshot?.nativeCompletionOrdinal ?? null,
				phaseLoopSeatId: entry?.snapshot?.loopSeatId || null,
				completedPhaseSeatId: entry?.snapshot?.completedPhaseSeatId || null }));
			throw new Error(`native choice host failed before ACK resolution:${JSON.stringify({ failureCode: session.failureCode,
				choiceStates: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state || null),
				actionChoiceState: nativeActionChoice ? controller.inspect(roomId, nativeActionChoice.choiceId)?.state || null : null,
				waitErrors, phaseOverEvidence, preActionRejection: nativeDiagnostic.find(entry => entry?.stage === "native_preaction_command_rejected") || null,
				recentStages: nativeDiagnostic.slice(-16).map(entry => entry?.stage) })}`);
		}
		return opened.every(choice => controller.inspect(roomId, choice.choiceId)?.state === "resolved") &&
			(!nativeActionChoice || session?.authorityStateRevision !== 4 || controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved");
	},
		15000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state || null),
			actionChoice: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), deliveryCount, ackCount, nativeActionAckCount,
			event4AckDropCount, event4SubmissionCount, event4AckBarrierWaitCount, event4ControllerRetryTriggered,
				event4AuthorityJoinCount, event4AckBarrierReleased, event4AckSendErrors, diagnostics: nativeDiagnostic.slice(-12).map(entry => entry?.stage), ackTrace: ackTrace.slice(-12) }));
	assert.equal(completed.state, "playable_probe");
	if (probeMode === "managed_opening_root_action_event5") t.diagnostic(`Event #5 after Event #4 completion: ${JSON.stringify({
		state: completed.state, authorityRevision: completed.authorityStateRevision,
		multiTurnInput: process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1",
		phaseBoundaryAudit: process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1",
		phaseBoundaryFence: process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1",
		stopAtWait: process.env.V2_NATIVE_PHASE_BOUNDARY_STOP_AT_WAIT === "1",
	})}`);
	if (process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1") {
		if (probeMode === "managed_opening_root_action_event5") t.diagnostic("Event #5 entered phase-boundary audit/fence block");
		// The Jiri Event #4 path deliberately holds the native parent until the
		// authority manager accepts revision 4, then releases it and resumes the
		// engine. The manager's revision can therefore become visible before the
		// native root reaches the phaseOver boundary. Synchronize on the completed
		// native boundary, not on authority-revision visibility or a fixed delay.
		if (process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1" &&
			!nativeDiagnostic.some(entry => entry?.stage === "native_phase_loop_wait_next_boundary" &&
				entry?.snapshot?.isCompletedPhaseOverBoundary === true)) {
			await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_loop_wait_next_boundary" &&
				entry?.snapshot?.isCompletedPhaseOverBoundary === true), 5000,
				() => ({ session: (() => { const current = manager.inspect(roomId); return current && {
					state: current.state, failureCode: current.failureCode, authorityStateRevision: current.authorityStateRevision,
					nextAuthorityEventSequence: current.nextAuthorityEventSequence, checkpointAvailable: current.checkpointAvailable,
				}; })(), stages: nativeDiagnostic.slice(-16).map(entry => entry?.stage || null),
					phaseEvidence: safeNativeDiagnostic(nativeDiagnostic.filter(entry => ["native_phase_over_trigger_called",
						"phase_over_wait_next_entered", "native_phase_loop_wait_next_boundary", "native_phase_boundary_fence_waiting"].includes(entry?.stage))
						.slice(-8).map(entry => ({ stage: entry.stage, snapshot: entry.snapshot && {
							eventName: entry.snapshot.eventName || null, eventStep: entry.snapshot.eventStep ?? null,
							rootInstanceId: entry.snapshot.rootInstanceId || null, rootObjectMatches: entry.snapshot.rootObjectMatches === true,
							phaseLoopIdentityMatches: entry.snapshot.phaseLoopIdentityMatches === true,
							phaseOverTriggerCount: entry.snapshot.phaseOverTriggerCount ?? entry.snapshot.triggerCount ?? null,
							draftPresent: entry.snapshot.draftPresent ?? entry.snapshot.phaseOverDraftPresent ?? false,
							completionOrdinal: entry.snapshot.completionOrdinal ?? entry.snapshot.nativeCompletionOrdinal ?? null,
							gameMeAbsent: entry.snapshot.gameMeAbsent === true,
						} || null }))) }));
		}
		const dispatch = nativeDiagnostic.find(entry => entry?.stage === "native_phase_over_trigger_called");
		const waitEntry = nativeDiagnostic.find(entry => entry?.stage === "phase_over_wait_next_entered" && entry?.snapshot?.eventStep === 2 &&
			typeof entry?.snapshot?.ownerEventInstanceId === "string");
		const proofWaitEntry = nativeDiagnostic.find(entry => entry?.stage === "phase_over_wait_next_entered" && entry?.snapshot?.eventStep === 3 &&
			typeof entry?.snapshot?.ownerEventInstanceId === "string");
		const completedWait = nativeDiagnostic.find(entry => entry?.stage === "native_phase_loop_wait_next_boundary" &&
			entry?.snapshot?.eventStep === 3 && entry?.snapshot?.phaseOverWaitEntryStep === 3);
		assert.ok(dispatch, "the native phaseOver trigger dispatch must be observed");
		assert.ok(waitEntry, `the step-2 native phaseOver dispatch wait must capture its entry state before awaiting children: ${JSON.stringify(
			nativeDiagnostic.filter(entry => entry?.stage === "phase_over_wait_next_entered" && [2, 3].includes(entry?.snapshot?.eventStep))
				.slice(-8).map(entry => ({ eventStep: entry.snapshot?.eventStep, ownerEventInstanceId: entry.snapshot?.ownerEventInstanceId || null,
					managerRootEventName: entry.snapshot?.managerRootEventName || null,
					managerRootEventInstanceId: entry.snapshot?.managerRootEventInstanceId || null,
					stateRootEventInstanceId: entry.snapshot?.stateRootEventInstanceId || null,
					managerEventStackRootName: entry.snapshot?.managerEventStackRootName || null,
					managerEventStackRootInstanceId: entry.snapshot?.managerEventStackRootInstanceId || null,
					managerRootIsStateRoot: entry.snapshot?.rootObjectMatches ?? null,
					eventInstanceId: entry.snapshot?.eventInstanceId || null,
					eventParentName: entry.snapshot?.eventParentName || null,
					eventParentInstanceId: entry.snapshot?.eventParentInstanceId || null,
					phaseLoopIdentityMatches: entry.snapshot?.phaseLoopIdentityMatches ?? null,
					triggerOrdinal: entry.snapshot?.triggerOrdinal ?? null, draftPresent: entry.snapshot?.draftPresent ?? false })))}`);
		assert.ok(proofWaitEntry, "the step-3 native continuation wait must capture the draft before its asynchronous completion");
		assert.ok(completedWait, `the phaseOver wait invocation must carry its captured step context through native completion: ${JSON.stringify(
			nativeDiagnostic.filter(entry => ["phase_over_wait_next_entered", "native_phase_over_trigger_called", "native_phase_loop_wait_next_boundary"].includes(entry?.stage))
				.slice(-12).map(entry => ({ stage: entry.stage, rootInstanceId: entry.snapshot?.rootInstanceId || null,
					eventStep: entry.snapshot?.eventStep ?? null, entryStep: entry.snapshot?.phaseOverWaitEntryStep ?? null,
					ownerEventInstanceId: entry.snapshot?.ownerEventInstanceId || entry.snapshot?.phaseLoopEventInstanceId ||
						entry.snapshot?.phaseOverWaitOwnerEventInstanceId || null, triggerOrdinal: entry.snapshot?.triggerOrdinal ??
						entry.snapshot?.triggerCount ?? entry.snapshot?.phaseOverWaitTriggerOrdinal ?? null,
					draftPresent: entry.snapshot?.draftPresent ?? entry.snapshot?.phaseOverWaitDraftPresent ?? false,
					phaseOverBoundary: entry.snapshot?.isCompletedPhaseOverBoundary ?? null })))}`);
		assert.equal(waitEntry.snapshot.phaseLoopIdentityMatches, true);
		assert.equal(waitEntry.snapshot.draftPresent, true);
		assert.equal(waitEntry.snapshot.draftRootMatches, true);
		assert.equal(waitEntry.snapshot.draftOwnerMatches, true);
		assert.equal(waitEntry.snapshot.draftOwnerStep, 2);
		assert.equal(waitEntry.snapshot.ownerEventInstanceId, dispatch.snapshot.phaseLoopEventInstanceId);
		assert.equal(waitEntry.snapshot.draftTriggerOrdinal, dispatch.snapshot.triggerCount);
		assert.equal(proofWaitEntry.snapshot.phaseLoopIdentityMatches, true);
		assert.equal(proofWaitEntry.snapshot.draftPresent, true);
		assert.equal(proofWaitEntry.snapshot.draftRootMatches, true);
		assert.equal(proofWaitEntry.snapshot.draftOwnerMatches, true);
		assert.equal(proofWaitEntry.snapshot.draftOwnerEventInstanceId, dispatch.snapshot.phaseLoopEventInstanceId);
		assert.equal(proofWaitEntry.snapshot.draftTriggerOrdinal, dispatch.snapshot.triggerCount);
		assert.equal(completedWait.snapshot.phaseOverWaitDraftPresent, true);
		assert.equal(completedWait.snapshot.phaseOverWaitOwnerEventInstanceId, proofWaitEntry.snapshot.ownerEventInstanceId);
		assert.equal(completedWait.snapshot.phaseOverWaitTriggerOrdinal, proofWaitEntry.snapshot.triggerOrdinal);
		assert.equal(completedWait.snapshot.rootInstanceId, proofWaitEntry.snapshot.rootInstanceId);
	}
	if (expectedAuthorityRevision >= 3) {
		if (expectedAuthorityRevision === 3) {
			assert.deepEqual(completed.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
			assert.equal(completed.nextAuthorityEventSequence, 4);
		} else {
			assert.deepEqual(completed.lastAuthorityEvent, { sequence: 4, name: process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1" ? "jiRi_moBaoChongJie" : "gongJiOrFaShu" });
			assert.equal(completed.nextAuthorityEventSequence, 5);
		}
		assert.match(completed.authorityStateDigest, /^[a-f0-9]{64}$/);
		const drawAccepted = await until(() => nativeDiagnostic.find(entry => entry?.stage === "opening_draw_event_3_accepted"), 5000,
			() => ({ diagnostics: nativeDiagnostic.slice(-8), session: manager.inspect(roomId) }));
		openingDrawAccepted = drawAccepted;
		assert.equal(drawAccepted.kind, "native_authority_event_accepted_v1");
		assert.equal(drawAccepted.eventSequence, 3);
		assert.equal(drawAccepted.stateRevision, 3);
		assert.equal(completed.authorityDigestChain.length, expectedAuthorityRevision === 3 ? 3 : 4);
		assert.equal(completed.authorityDigestChain[1].eventSequence, 2);
		assert.equal(completed.authorityDigestChain[1].afterDigest, completed.authorityDigestChain[2].beforeDigest);
		assert.equal(drawAccepted.beforeDigest, completed.authorityDigestChain[1].afterDigest);
		assert.equal(drawAccepted.afterDigest, completed.authorityDigestChain[2].afterDigest);
		assert.equal(drawAccepted.eventName, "gameDraw");
		assert.equal(drawAccepted.parentEventName, "game");
		assert.equal(drawAccepted.phaseLoopPaused, true);
		assert.equal(drawAccepted.hostPlayerAbsent, true);
		assert.equal(drawAccepted.connectedTransports, 0);
		assert.equal(drawAccepted.checkpointAvailable, false);
		assert.deepEqual(drawAccepted.seatHandCounts.map(entry => entry.handCount), [4, 4, 4, 4]);
	} else assert.deepEqual(completed.lastAuthorityEvent, { sequence: 2, name: "chooseCharacterOL" });
	if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1") {
		const selected = controller.inspect(roomId, nativeYinYangFixtureSeatId === a.seatId ? a.choiceId :
			nativeYinYangFixtureSeatId === b.seatId ? b.choiceId : nativeYinYangFixtureSeatId === c.seatId ? c.choiceId : d.choiceId);
		assert.equal(selected?.resolution?.option, "yinYangShi");
		const characterAuthorityEvent = authoritySubmissions.find(entry => entry.proof?.eventSequence === 2)?.proof?.event;
		assert.ok(characterAuthorityEvent?.characters?.some(entry => entry.seatId === nativeYinYangFixtureSeatId && entry.character === "yinYangShi"),
			"the real native Event #2 result must assign the fixture's native-generated choice to the target seat");
	} else if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
		const resourceChoice = opened.find(choice => choice.seatId === nativeResourceFixtureSeatId);
		const selected = controller.inspect(roomId, resourceChoice?.choiceId);
		assert.equal(selected?.resolution?.option, "shengQiangQiShi",
			"the managed player selection must preserve the native shengJi fixture candidate");
		const characterAuthorityEvent = authoritySubmissions.find(entry => entry.proof?.eventSequence === 2)?.proof?.event;
		assert.ok(characterAuthorityEvent?.characters?.some(entry => entry.seatId === nativeResourceFixtureSeatId && entry.character === "shengQiangQiShi"),
			"the native Event #2 result must initialize the first actor with the selected fixture role");
	} else if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
		const fixtureChoice = opened.find(choice => choice.seatId === nativeJiRiFixtureSeatId);
		const selected = controller.inspect(roomId, fixtureChoice?.choiceId);
		assert.equal(selected?.resolution?.option, "jieRiMoDao",
			"the managed player selection must preserve the native jieRiMoDao fixture candidate");
		const characterAuthorityEvent = authoritySubmissions.find(entry => entry.proof?.eventSequence === 2)?.proof?.event;
		assert.ok(characterAuthorityEvent?.characters?.some(entry => entry.seatId === nativeJiRiFixtureSeatId && entry.character === "jieRiMoDao"),
			"the native Event #2 result must initialize the first actor with the selected fixture role");
	} else {
		assert.equal(controller.inspect(roomId, a.choiceId).resolution.option, a.options[1]);
		assert.equal(controller.inspect(roomId, b.choiceId).resolution.kind, "trustee");
		assert.equal(controller.inspect(roomId, d.choiceId).state, "resolved");
	}
	if (process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		const probeMode = ["managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe"].includes(process.env.V2_NATIVE_START_PROBE_MODE) ? process.env.V2_NATIVE_START_PROBE_MODE : "native_start";
		assert.equal((await manager.diagnoseNativeStart(roomId, "controlled_block")).ok, true);
		const controlled = await until(() => nativeDiagnostic.find(entry => entry?.stage === "controlled_block_outcome"), 5000,
			() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
		assert.equal(controlled.classification, "cdp_command_timeout");
		if (!actionDiagnosticDispatched) {
			const requested = await manager.diagnoseNativeStart(roomId, probeMode);
			assert.equal(requested.ok, true, `native diagnostic command rejected for ${probeMode}: ${JSON.stringify(requested)}`);
		}
		if (["before_native_result_set", "cdp_result_unknown_after_dispatch", "use_result_throws", "use_card_child_throws"].includes(nativeFaultMode)) {
			await until(() => manager.inspect(roomId)?.state === "failed", 10000,
				() => ({ session: manager.inspect(roomId), nativeDiagnostic: nativeDiagnostic.slice(-12) }));
			const expectedFailure = nativeFaultMode === "use_result_throws" ? "NATIVE_USE_RESULT_FAILED" :
				nativeFaultMode === "use_card_child_throws" ? "NATIVE_USE_CARD_CHILD_FAILED" : "NATIVE_ACTION_APPLY_UNCERTAIN";
			assert.equal(manager.inspect(roomId).failureCode, expectedFailure, JSON.stringify(nativeDiagnostic.slice(-12)));
			assert.equal(nativeActionAckCount, 0, "uncertain native operation must never be ACKed");
			assert.ok(nativeActionChoice, "fault injection did not reach a controller-owned native choice");
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null, "failed host left its pending choice alive");
			assert.ok(opened.slice(0, 4).every(choice => controller.inspect(roomId, choice.choiceId) === null));
			const actionEntries = nativeDiagnostic.filter(entry => entry?.snapshot?.nativeAction?.eventId === nativeActionCandidate?.nativeEventId);
			const useResultCount = Math.max(0, ...actionEntries.map(entry => entry.snapshot.nativeAction.useResultCount || 0));
			assert.ok(useResultCount <= 1, `uncertain native action ran useResult ${useResultCount} times`);
			if (nativeFaultMode === "before_native_result_set") assert.equal(useResultCount, 0);
			if (["use_result_throws", "use_card_child_throws"].includes(nativeFaultMode)) assert.equal(useResultCount, 1);
			if (nativeFaultMode === "use_card_child_throws") {
				const childFailure = nativeDiagnostic.find(entry => entry?.stage === "native_useCard_child_exception");
				assert.equal(childFailure?.snapshot?.nativeAction?.childEventName, "useCard", "fault was not injected at the native useCard child boundary");
				assert.ok(Number.isSafeInteger(childFailure?.snapshot?.nativeAction?.childEventStep), "native useCard child step was not observed");
				assert.equal(childFailure?.snapshot?.nativeAction?.cardInHandAtFailure, false, "fault did not occur after native card movement");
				assert.equal(childFailure?.snapshot?.nativeAction?.nativeUseCardHistoryEntries, 1, "native useCard history must show exactly one completed child before uncertain settlement");
			}
			assert.equal(manager.inspect(roomId)?.authorityStateRevision, 2, "failed native action must not advance authority revision");
			const failedHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
			await until(() => failedHandle.resources().length === 0, 10000, () => ({ resources: failedHandle.resources() }));
			await failedHandle.waitForCleanup();
			return;
		}
		const outcome = await until(() => nativeDiagnostic.find(entry =>
			["native_start_probe_outcome", "native_start_root_evaluation_outcome", "native_start_diagnostic_rejected"].includes(entry?.stage)), 5000,
			() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), failures: nativeDiagnostic.map(entry => entry?.failureCode), hostAlive: manager.inspect(roomId)?.state }));
		assert.ok(["native_promise_pending_cdp_responsive", "native_exception_observed", "native_root_fulfilled", "explicit_exception",
			"javascript_loop_starvation_suspected", "undetermined", "chromium_exit"].includes(outcome.classification));
		const snapshot = outcome.snapshot;
		assert.ok(snapshot, `native startup state was not observable: ${JSON.stringify(outcome)}`);
		t.diagnostic(`native startup pre-assert (${probeMode}): ${JSON.stringify(safeNativeDiagnostic(outcome))}`);
		if (probeMode === "native_start") {
			assert.equal(outcome.classification, "native_promise_pending_cdp_responsive");
			assert.equal(snapshot.waitForPlayerCalls, 1);
			assert.equal(snapshot.randomMapOLCalls, 1);
			assert.equal(snapshot.prepareArenaCalls, 1);
			assert.equal(snapshot.hostPlayerAbsent, false);
			assert.equal(snapshot.seats.length, 8);
		} else if (probeMode === "managed_start") {
			assert.equal(outcome.classification, "native_promise_pending_cdp_responsive");
			assert.equal(snapshot.waitForPlayerCalls, 1);
			assert.equal(snapshot.randomMapOLCalls, 1);
			assert.equal(snapshot.prepareArenaCalls, 0);
			assert.equal(snapshot.chooseCharacterCalls, 0);
			assert.equal(snapshot.gameStartCount, 1);
			assert.equal(snapshot.gameDrawEntered, true);
			assert.equal(snapshot.gameDrawParentName, "game");
			assert.equal(snapshot.phaseLoopCreated, true);
			assert.equal(snapshot.phaseLoopParentName, "game");
			assert.equal(snapshot.firstPhaseGate?.seatId, snapshot.firstActSeatId);
			assert.equal(snapshot.firstPhaseEventName, "phase");
			assert.equal(snapshot.firstPhaseParentName, "phaseLoop");
			assert.deepEqual(snapshot.eventStack.slice(0, 2), ["game", "phaseLoop"]);
			assert.equal(snapshot.hostPlayerAbsent, true);
			assert.equal(snapshot.seats.length, 4);
			assert.deepEqual(snapshot.seats.map(seat => seat.handCount), [4, 4, 4, 4]);
		} else if (["managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe"].includes(probeMode)) {
			assert.equal(outcome.classification, "native_promise_pending_cdp_responsive");
			assert.equal(snapshot.nativeInputGate?.eventName, "gongJiOrFaShu");
			assert.equal(snapshot.nativeInputGate?.parentEventName, "xingDong");
			assert.equal(snapshot.nativeInputGate?.waiting, true);
			assert.equal(snapshot.nativeInputGate?.gameMeAbsent, true);
			assert.ok(nativeActionChoice, `native action candidate/controller callback did not complete: ${JSON.stringify({
				host: manager.inspect(roomId), candidateReceived: Boolean(nativeActionCandidate),
				openedChoiceCount: opened.length, diagnosticStages: nativeDiagnostic.map(entry => entry?.stage),
				latestDiagnostic: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null,
			})}`);
			if (process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") {
				assert.ok(nativeActionCandidate?.options.length > 0);
				assert.ok(nativeActionCandidate?.skillCandidateCount > 0);
			} else assert.ok(nativeActionCandidate?.options.length > 1);
			if (probeMode === "managed_native_skill_candidate_probe") {
				assert.equal(process.env.V2_NATIVE_JIRIMO_FIXTURE, "1");
				assert.equal(manager.inspect(roomId)?.authorityStateRevision, process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1" ? 4 : 3,
					"candidate-only mode stays at Event #3; the explicit atomic-pair mode may submit only its validated Event #4");
				assert.equal(nativeActionCandidate.seatId, nativeJiRiFixtureSeatId);
				assert.equal(nativeActionCandidate.optionKinds[nativeActionOptionId], "native_skill");
				assert.ok(nativeActionCandidate.skillCandidateCount >= 1);
				assert.equal(nativeActionChoice.options.includes(nativeActionOptionId), true);
				if (process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
					assert.equal(manager.inspect(roomId)?.authorityStateRevision, 4, "the paired skill probe must wait for accepted Event #4");
					assert.ok([null, "resolved"].includes(controller.inspect(roomId, nativeActionChoice.choiceId)?.state || null),
						"the controller choice must be settled after the native action and authority acknowledgement");
				} else if (process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") {
					assert.ok(["pending", "delivery_pending", "applying"].includes(controller.inspect(roomId, nativeActionChoice.choiceId)?.state));
				} else assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId)?.state, "pending");
				const nativeGateTrace = nativeDiagnostic.find(entry => entry?.stage === "native_input_wait_open" &&
					entry?.snapshot?.nativeInputGate?.nativeEventId === nativeActionCandidate.nativeEventId);
				assert.ok(nativeGateTrace, "skill option must come from a real native input waiting boundary");
				assert.equal(nativeGateTrace.snapshot.nativeInputGate.nativeSkillCandidateCount, nativeActionCandidate.skillCandidateCount);
				assert.equal(nativeGateTrace.snapshot.nativeInputGate.gameMeAbsent, true);
				if (process.env.V2_NATIVE_JIRIMO_ACTION_PROBE !== "1") assert.equal(nativeActionAckCount, 0, "a candidate probe must not claim native application");
				const request = { protocol: 1, roomId, hostSessionId: nativeActionChoice.hostSessionId,
					nativeEventId: nativeActionChoice.nativeEventId, seatId: nativeActionChoice.seatId,
					eventSequence: nativeActionChoice.eventSequence, choiceId: nativeActionChoice.choiceId,
					connectionId: `action_${nativeActionChoice.seatId}`, credential: credentialFor(nativeActionChoice.seatId), option: nativeActionOptionId };
				assert.equal(controller.submitChoice({ ...request, credential: "administrator_credential" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				const otherSeat = setup.seats.find(seat => seat.seatId !== request.seatId).seatId;
				assert.equal(controller.submitChoice({ ...request, seatId: otherSeat, credential: credentialFor(otherSeat) }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, option: "forged_skill_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				if (process.env.V2_NATIVE_JIRIMO_ACTION_PROBE !== "1") assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId)?.state, "pending",
					"rejected player/admin submissions must leave the immutable native choice untouched");
				if (process.env.V2_NATIVE_JIRIMO_ACTION_PROBE !== "1") {
					assert.equal((await manager.stop(roomId, "jirimo_native_candidate_probe_complete")).ok, true);
					const stopped = manager.inspect(roomId);
					assert.equal(stopped?.state, "stopped");
					assert.equal(stopped?.authorityStateRevision, 3);
					assert.equal(stopped?.nextAuthorityEventSequence, 4);
					assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null, "stop must clean the pending skill choice");
					assert.equal(nativeActionAckCount, 0);
					assert.equal(authoritySubmissions.some(entry => entry.proof?.eventSequence >= 4), false);
					assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_action_event_completed"), false,
						"candidate generation must not be mistaken for a resolved native skill operation");
					const handle = launchedHandles.get(stopped.sessionId);
					await until(() => handle.resources().length === 0, 10000, () => ({ resources: handle.resources() }));
					await handle.waitForCleanup();
					return;
				}
			}
			if (["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe"].includes(probeMode)) {
				if (process.env.V2_NATIVE_C3_FULL_CHAIN === "1" && process.env.V2_NATIVE_MANAGED_RESPONSE === "1" && probeMode === "managed_opening_root_action_event4") {
					assert.ok(nativeLiveSnapshotAtInputGate,
						"the native live snapshot must be captured before the simulated ordinary player releases its action gate");
				}
				assert.ok(expectedAuthorityRevision >= 3, "opening-root action must start from accepted Event #3");
				assert.equal(snapshot.gameStartCount, 1);
				assert.equal(snapshot.gameDrawEntered, true);
				assert.equal(snapshot.phaseLoopCreated, true);
				assert.equal(snapshot.hostPlayerAbsent, true);
			}
			if (nativeFaultMode === "delivery_stop_barrier") {
				const barrierEntry = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_delivery_barrier_entered"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), session: manager.inspect(roomId), choice: controller.inspect(roomId, nativeActionChoice.choiceId) }));
				assert.equal(barrierEntry.snapshot?.nativeAction?.useResultCount ?? barrierEntry.snapshot?.useResultCount, 0,
					"barrier must stop before native useResult begins");
				assert.equal(barrierEntry.snapshot?.gateStatus ?? barrierEntry.snapshot?.nativeInputGateStatus, "waiting");
				assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId)?.state, "delivery_pending");
				assert.equal(nativeActionAckCount, 0);
				assert.equal((await manager.stop(roomId, "delivery_stop_race")).ok, true);
				assert.equal(manager.inspect(roomId)?.state, "stopped");
				assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null);
				assert.ok(opened.every(choice => controller.inspect(roomId, choice.choiceId) === null));
				assert.equal(nativeActionAckCount, 0);
				assert.equal(manager.inspect(roomId)?.authorityStateRevision, 2, "stop during delivery must not fabricate authority Event #4");
				const stoppedHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
				await until(() => stoppedHandle.resources().length === 0, 10000, () => ({ resources: stoppedHandle.resources() }));
				await stoppedHandle.waitForCleanup();
				return;
			}
			let applied;
			try {
				applied = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_event_completed"), 15000,
					() => ({ stages: nativeDiagnostic.map(entry => ({ stage: entry?.stage, failureCode: entry?.failureCode || null,
						snapshot: entry?.stage === "native_jiri_target_choice_rejected" ? entry.snapshot : null })),
						choice: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), latest: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null }));
			} catch (error) {
				// Ask the live supervised host for a fresh bounded snapshot before the
				// test cleanup stops Chromium. The root Promise may remain pending while
				// CDP is still responsive, so buffered milestones alone are insufficient
				// to distinguish a native child wait from an IPC/authority failure.
				const before = nativeDiagnostic.length;
				const sessionBeforeDiagnostic = manager.inspect(roomId);
				const requested = await manager.diagnoseNativeStart(roomId, probeMode);
				if (requested.ok) {
					try { await until(() => nativeDiagnostic.slice(before).some(entry => ["native_start_diagnostic", "native_start_diagnostic_rejected"].includes(entry?.stage)), 3000,
						() => ({ requested, session: manager.inspect(roomId) })); } catch {}
				}
				const latest = nativeDiagnostic.slice(before).filter(entry => ["native_start_diagnostic", "native_start_diagnostic_rejected"].includes(entry?.stage)).at(-1);
				const responseState = nativeResponseChoices.map(({ choice, candidate }) => ({ choiceId: choice.choiceId,
					nativeEventId: candidate.nativeEventId, seatId: candidate.seatId, optionCount: candidate.options?.length || 0,
					state: controller.inspect(roomId, choice.choiceId)?.state || null,
					deliveryAttempts: controller.inspect(roomId, choice.choiceId)?.deliveryAttempts || 0 }));
				error.message += `; diagnostic request=${JSON.stringify(requested)}; session=${JSON.stringify(sessionBeforeDiagnostic)}; deliveryFailures=${JSON.stringify(deliveryFailures)}; sessionEnds=${JSON.stringify(sessionEnds)}; nativeResponseChoices=${JSON.stringify(responseState)}; responseAckCount=${nativeResponseAckCount}; nativeSkillLifecycle=${JSON.stringify(safeNativeDiagnostic(nativeDiagnostic.filter(entry=>/^native_jiri_(event_(created|starting)|target_|authority_proof_rejected)/.test(entry?.stage||'')).map(entry=>({stage:entry.stage,failureCode:entry.failureCode||null,
						actionGateStatus:entry.actionGateStatus||null,actionEventMatches:entry.actionEventMatches===true,sourceSeatMatches:entry.sourceSeatMatches===true,
						eventNameValid:entry.eventNameValid===true,skillEventValid:entry.skillEventValid===true,gameMeAbsent:entry.gameMeAbsent===true,
						optionCount:Number.isSafeInteger(entry.optionCount)?entry.optionCount:null,optionIdsValid:typeof entry.optionIdsValid==='boolean'?entry.optionIdsValid:null,
						optionKindsValid:typeof entry.optionKindsValid==='boolean'?entry.optionKindsValid:null,rootInstanceMatches:typeof entry.rootInstanceMatches==='boolean'?entry.rootInstanceMatches:null,snapshot:entry.snapshot}))))}; recentNativeMilestones=${JSON.stringify(safeNativeDiagnostic(nativeDiagnostic.slice(-10).map(entry => ({ stage: entry?.stage, snapshot: entry?.snapshot || null })) ))}; live native snapshot=${JSON.stringify(safeNativeDiagnostic(latest?.snapshot || null))}`;
				throw error;
			}
			if (probeMode === "managed_native_skill_candidate_probe" && process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") {
				const action = applied.snapshot?.nativeAction;
				assert.equal(action?.actionKind, "native_skill");
				assert.equal(action?.skillId, "jiRi_moBaoChongJie");
				assert.equal(action?.useResultCount, 1);
				assert.equal(action?.useResultChildName, "useSkill");
				assert.equal(action?.nativeChildWaitCompleted, true);
				assert.equal(action?.nativeEventInstanceMatches, true);
				assert.equal(action?.nativeUseSkillChildCompleted, true);
				assert.equal(action?.nativeTargetChoiceCompleted, true);
				assert.equal(action?.nativeChangeZhanJiCompleted, true);
				assert.equal(action?.baoShiAfter, action?.baoShiBefore + 1,
					"the original native contentBefore must complete exactly one non-overflow baoShi change");
				assert.equal(applied.snapshot?.eventName, "gongJiOrFaShu");
				assert.equal(applied.snapshot?.eventFinished, true);
				assert.equal(applied.snapshot?.hostPlayerAbsent, true);
				assert.equal(nativeActionCandidate.seatId, nativeJiRiFixtureSeatId);
				assert.equal(nativeJiRiTargetCandidate?.actionEventId, nativeActionCandidate.nativeEventId);
				assert.equal(nativeJiRiTargetCandidate?.sourceSeatId, nativeJiRiFixtureSeatId);
				assert.ok(nativeJiRiTargetChoice);
				if (process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
					// In pair mode the main controller ACK is deliberately withheld until
					// Event #4 is accepted; wait for the nested discard ACK first so this
					// test does not deadlock on the authority gate it is validating.
					await until(() => controller.inspect(roomId, nativeJiRiTargetChoice.choiceId)?.state === "resolved", 12000,
						() => ({ action: controller.inspect(roomId, nativeActionChoice.choiceId)?.state,
							target: controller.inspect(roomId, nativeJiRiTargetChoice.choiceId)?.state, nativeActionAckCount,
							nativeJiRiTargetAckCount, diagnostics: nativeDiagnostic.slice(-10).map(entry => entry?.stage) }));
				} else {
					await until(() => controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved" &&
						controller.inspect(roomId, nativeJiRiTargetChoice.choiceId)?.state === "resolved", 12000,
						() => ({ action: controller.inspect(roomId, nativeActionChoice.choiceId)?.state,
							target: controller.inspect(roomId, nativeJiRiTargetChoice.choiceId)?.state, nativeActionAckCount,
							nativeJiRiTargetAckCount, diagnostics: nativeDiagnostic.slice(-10).map(entry => entry?.stage) }));
				}
				assert.ok(nativeJiRiTargetAckCount >= 2, "lost nested-choice ACK must retry the same immutable physical discard delivery");
				assert.equal(nativeJiRiTargetAckDropped, true, "the nested-choice retry assertion requires an actually dropped first ACK");
				if (process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR !== "1") {
					assert.ok(nativeActionAckCount >= 2, "lost main-choice ACK must retry the same immutable native skill delivery");
				}
				const resourceProof = nativeDiagnostic.find(entry => entry?.stage === "native_jiri_change_zhanji_completed")?.snapshot;
				assert.ok(resourceProof, "a completed native changeZhanJi child must be observed");
				assert.equal(resourceProof.rootObjectMatches, true);
				assert.equal(resourceProof.seatId, nativeJiRiFixtureSeatId);
				assert.equal(resourceProof.achievement, "baoShi");
				assert.equal(resourceProof.afterCount, resourceProof.beforeCount + 1);
				const targetTrace = nativeDiagnostic.find(entry => entry?.stage === "native_jiri_target_choice_candidates")?.snapshot;
				assert.ok(targetTrace, "nested native chooseToDiscard must have supplied real legal faShu options");
				assert.equal(targetTrace.eventName, "chooseToDiscard");
				assert.equal(targetTrace.seatId, nativeJiRiTargetCandidate.seatId);
				assert.equal(targetTrace.sourceSeatId, nativeJiRiFixtureSeatId);
				assert.ok(targetTrace.optionCount > 0 && targetTrace.optionCount <= 32);
				assert.equal(nativeActionAckCount, 2, "the exactly-once native skill should receive only its original and retry ACK");
				if (process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
					const accepted = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_skill_action_event_4_accepted"), 10000,
						() => ({ session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-18).map(entry => entry?.stage), authoritySubmissions }));
					const boundary = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_boundary_fence_waiting"), 10000,
						() => ({ session: manager.inspect(roomId), phaseBoundaries: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => entry.snapshot) }));
					const acceptedSession = manager.inspect(roomId);
					assert.equal(accepted.eventSequence, 4);
					assert.equal(accepted.stateRevision, 4);
					assert.equal(accepted.hostPlayerAbsent, true);
					assert.equal(accepted.connectedTransports, 0);
					assert.equal(accepted.useSkillChildCompleted, true);
					assert.equal(accepted.changeZhanJiChildCompleted, true);
					assert.equal(accepted.targetDiscardChildCompleted, true);
					assert.equal(accepted.achievement.countAfter, accepted.achievement.countBefore + 1);
					assert.equal(acceptedSession.authorityStateRevision, 4);
					assert.equal(acceptedSession.nextAuthorityEventSequence, 5);
					assert.equal(acceptedSession.lastAuthorityEvent?.sequence, 4);
					assert.equal(acceptedSession.lastAuthorityEvent?.name, "jiRi_moBaoChongJie");
					assert.equal(acceptedSession.checkpointAvailable, false);
					assert.equal(boundary.snapshot.rootInstanceId, nativePreActionCapture.snapshot.rootInstanceId);
					assert.equal(boundary.snapshot.rootObjectMatches, true);
					assert.equal(boundary.snapshot.gameMeAbsent, true);
					assert.equal(boundary.snapshot.eventName, "phaseLoop");
					assert.equal(boundary.snapshot.eventStep, 3);
					assert.equal(boundary.snapshot.pendingDescendantCount, 0);
					assert.equal(boundary.snapshot.priorAuthority?.eventSequence, 4);
					assert.equal(boundary.snapshot.priorAuthority?.stateRevision, 4);
					assert.equal(boundary.snapshot.priorAuthority?.afterDigest, accepted.afterDigest);
					assert.equal(accepted.afterDigest, acceptedSession.authorityStateDigest);
					await until(() => controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved", 12000,
						() => ({ action: controller.inspect(roomId, nativeActionChoice.choiceId)?.state,
							nativeActionAckCount, session: manager.inspect(roomId), diagnostics: nativeDiagnostic.slice(-10).map(entry => entry?.stage) }));
					assert.ok(nativeActionAckCount >= 2, "lost main-choice ACK must retry after the authorized Event #4 commit");
					const post = await manager.snapshotNativeAtomicCapture(roomId);
					assert.equal(post.ok, true, `post-phaseOver Jiri atomic commitment rejected: ${post.code}`);
					assert.equal(post.snapshot.schema, "xingbei_native_private_atomic_commitment_v2");
					assert.equal(post.snapshot.projectionCount, 3);
					assert.equal(post.snapshot.atomicWithEffectSnapshots, true);
					assert.equal(post.snapshot.authoritySeedAuthorized, false);
					assert.equal(post.snapshot.checkpointAvailable, false);
					assert.equal(post.snapshot.nativeCompletionOrdinal > nativePreActionCapture.snapshot.nativeCompletionOrdinal, true,
						"post-action phaseOver evidence must follow the pre-action waiting fence in the same native completion ledger");
					assert.equal(post.snapshot.rootInstanceId, nativePreActionCapture.snapshot.rootInstanceId);
					assert.equal(post.snapshot.engineBuildId, nativePreActionCapture.snapshot.engineBuildId);
					assert.equal(post.snapshot.captureOrdinal, 1);
					const sideKey = accepted.achievement.side === true ? "hong" : "lan";
					const oppositeKey = sideKey === "hong" ? "lan" : "hong";
				const resourceBefore = nativePreActionCapture.snapshot.achievementResourceBinding[sideKey];
				const resourceAfter = post.snapshot.achievementResourceSummary[sideKey];
					assert.equal(resourceBefore.digest, accepted.achievement.beforeListDigest);
					assert.equal(resourceAfter.digest, accepted.achievement.afterListDigest);
				assert.equal(resourceAfter.count, resourceBefore.count + 1);
				assert.equal(resourceAfter.baoShiCount, resourceBefore.baoShiCount + 1);
				assert.equal(resourceAfter.shuiJingCount, resourceBefore.shuiJingCount);
				assert.deepEqual(post.snapshot.achievementResourceSummary[oppositeKey], nativePreActionCapture.snapshot.achievementResourceBinding[oppositeKey]);
				const repeat = await manager.snapshotNativeAtomicCapture(roomId);
				assert.equal(repeat.ok, true, `stable post-phaseOver Jiri commitment repeat rejected: ${repeat.code}`);
				assert.equal(repeat.snapshot.captureOrdinal, 2);
				assert.equal(repeat.snapshot.nativeCompletionOrdinal, post.snapshot.nativeCompletionOrdinal);
				assert.equal(repeat.snapshot.stableWithPrevious, true);
				assert.deepEqual(repeat.snapshot.stableProjectionsWithPrevious, { cardLedger: true, effectState: true, turnResource: true });
				assert.deepEqual(repeat.snapshot.achievementResourceSummary, post.snapshot.achievementResourceSummary);
				assert.notEqual(repeat.snapshot.commitment, post.snapshot.commitment);
				assert.equal(manager.inspect(roomId).authorityStateRevision, 4, "the isolated fixture must not open Event #5");
				assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
				assert.equal(manager.inspect(roomId).checkpointAvailable, false);
				assert.equal(authoritySubmissions.filter(entry => entry.proof?.eventSequence > 4).length, 0);
				const handle = launchedHandles.get(acceptedSession.sessionId);
				assert.ok(handle && handle.pid > 0);
				const pid = handle.pid;
				assert.equal((await manager.stop(roomId, "jirimo_atomic_pair_complete")).ok, true);
				assert.equal(manager.inspect(roomId).state, "stopped");
				assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null);
				assert.equal(controller.inspect(roomId, nativeJiRiTargetChoice.choiceId), null);
				await handle.waitForCleanup();
				assert.equal(handle.resources().length, 0, "paired native skill captures must clean Chromium and its profile");
					t.diagnostic(`jiRi native Event #4 and post-phaseOver commitment pair: ${JSON.stringify({ pid, rootInstanceId: post.snapshot.rootInstanceId,
						seatId: nativeActionCandidate.seatId, targetSeatId: accepted.targetSeatId, preCompletionOrdinal: nativePreActionCapture.snapshot.nativeCompletionOrdinal,
					postCompletionOrdinal: post.snapshot.nativeCompletionOrdinal, captureOrdinals: [post.snapshot.captureOrdinal, repeat.snapshot.captureOrdinal],
					baoShiCount: resourceAfter.baoShiCount, authorityRevision: acceptedSession.authorityStateRevision,
					checkpointAvailable: post.snapshot.checkpointAvailable })}`);
				return;
				}
				assert.equal(manager.inspect(roomId)?.authorityStateRevision, 3,
					"this isolated native-skill diagnostic must not fabricate or authorize Event #4/#5");
				assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 4);
				assert.equal(authoritySubmissions.some(entry => entry.proof?.eventSequence >= 4), false);
				const skillDeliveryIds = nativeDiagnostic.filter(entry => entry?.stage === "native_action_event_completed").map(entry => entry.snapshot?.nativeAction?.useResultCount);
				assert.deepEqual(skillDeliveryIds, [1], "a duplicate immutable delivery must not re-run native useResult/useSkill");
				assert.equal((await manager.stop(roomId, "jirimo_native_action_probe_complete")).ok, true);
				assert.equal(manager.inspect(roomId)?.state, "stopped");
				assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId), null);
				assert.equal(controller.inspect(roomId, nativeJiRiTargetChoice.choiceId), null);
				const stoppedHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
				await until(() => stoppedHandle.resources().length === 0, 10000, () => ({ resources: stoppedHandle.resources() }));
				await stoppedHandle.waitForCleanup();
				return;
			}
			assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1);
			assert.equal(applied.snapshot?.nativeAction?.useResultChildName, "useCard");
			assert.equal(applied.snapshot?.nativeAction?.nativeChildWaitCompleted, true);
			assert.equal(applied.snapshot?.nativeAction?.nativeEventInstanceMatches, true);
			assert.equal(applied.snapshot?.nativeAction?.cardInHandAfterNativeWait, false);
			assert.notEqual(applied.snapshot?.nativeAction?.cardPositionAfterNativeWait, "h");
			assert.equal(applied.snapshot?.eventFinished, true, "authority action proof must follow the completed native GameEvent, not an intermediate child wait");
			assert.equal(applied.snapshot?.nativeAction?.result?.cardsCount, 1);
			assert.equal(applied.snapshot?.nativeAction?.result?.targetCount, 1);
			assert.equal(applied.snapshot?.nativeAction?.result?.cardName, applied.snapshot?.nativeAction?.cardName);
			assert.ok(setup.seats.some(seat => seat.seatId === applied.snapshot?.nativeAction?.targetSeatId));
			assert.equal(applied.snapshot?.nativeInputGate?.nativeResumeCount || 0, 0, "controller path must not use the test-only direct resume command");
			assert.equal(applied.snapshot?.hostPlayerAbsent, true);
			assert.equal(applied.snapshot?.seats?.length, 4);
			if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
				assert.equal(nativeActionCandidate?.seatId, nativeResourceFixtureSeatId);
				assert.ok(nativeResourceTransition && Number.isSafeInteger(nativeResourceTransition.baseline));
				const transition = nativeDiagnostic.find(entry => entry?.stage === "native_shengji_zhiLiao_child_completed")?.snapshot;
				assert.ok(transition, `native shengJi resource child completion was not observed: ${JSON.stringify(nativeDiagnostic.slice(-20).map(entry => entry?.stage))}`);
				assert.equal(transition.rootInstanceId, nativeResourceTransition.rootInstanceId);
				assert.equal(transition.seatId, nativeResourceFixtureSeatId);
				assert.equal(transition.skillIdentityMatches, true);
				assert.equal(transition.childEventName, "changeZhiLiao");
				assert.equal(transition.childFinished, true);
				assert.equal(transition.before, nativeResourceTransition.baseline);
				assert.equal(transition.delta, 1);
				assert.equal(transition.after, nativeResourceTransition.baseline + 1);
				assert.ok(Number.isSafeInteger(transition.childCompletionOrdinal) && transition.childCompletionOrdinal > 0);
				assert.equal(transition.childParentEventInstanceId, transition.invokingEventInstanceId);
				nativeResourceTransition = { ...nativeResourceTransition, ...transition };
			}
			const safeDiagnostics = JSON.stringify(nativeDiagnostic);
			const privateDiagnosticKeys = [...safeDiagnostics.matchAll(/"(cardName|selectedCardName|handCommitment|secret|credential|hand)"\s*:/gi)].map(match => match[1]);
			assert.deepEqual(privateDiagnosticKeys, [], "native startup diagnostics must not disclose card identities, hidden-hand data, or credentials");
			if (probeMode === "managed_native_response_probe") {
				const rootProbe = nativeDiagnostic.find(entry => entry?.stage === "native_start_probe_outcome");
				const responseStarted = nativeDiagnostic.find(entry => entry?.stage === "native_response_started" && entry?.snapshot?.eventName === "yingZhan");
				const responseCompleted = nativeDiagnostic.find(entry => entry?.stage === "native_response_completed" && entry?.snapshot?.eventName === "yingZhan");
				assert.ok(rootProbe, `native start root evidence missing: ${JSON.stringify(nativeDiagnostic.slice(-20))}`);
				assert.ok(responseStarted, `native attack did not enter the _yingZhan child event: ${JSON.stringify(nativeDiagnostic.slice(-20))}`);
				assert.ok(responseCompleted, "native yingZhan child event did not complete before parent action wait resumed");
				assert.equal(responseStarted.snapshot.nativeChooseToUseContent, true,
					"Player.yingZhan must retain the native chooseToUse content contract");
				assert.equal(responseStarted.snapshot.rootEventName, "game");
				assert.equal(responseStarted.snapshot.rootObjectMatches, true,
					"native response must reference the same event-manager root object");
				assert.equal(responseStarted.snapshot.rootInstanceId, rootProbe.snapshot?.rootInstanceId,
					"native response and start probe must identify the same original root instance");
				assert.ok(responseStarted.snapshot.parentChain.includes("useCard"),
					"yingZhan must stay nested below the real incoming native useCard event");
				assert.ok(responseStarted.snapshot.parentChain.includes("phaseLoop"),
					"native response must remain nested in the original Xingbei phase path");
				assert.notEqual(responseStarted.snapshot.seatId, nativeActionCandidate.seatId,
					"the response event must belong to the attacked ordinary seat, not the attacking seat");
				assert.equal(responseCompleted.snapshot.gameMeAbsent, true);
				if (process.env.V2_NATIVE_YINYANG_VIEWAS_PROBE !== "1") assert.equal(typeof responseCompleted.snapshot.resultBool, "boolean",
					"native chooseToUse must produce an actual response/decline result");
				if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1") {
					assert.equal(responseStarted.snapshot.seatId, nativeYinYangFixtureSeatId,
						"the actual native response event must belong to the selected yinYangShi ordinary seat");
					assert.equal(responseStarted.snapshot.yinYangNativeCandidate?.nativeSkillPredicateAccepted, true,
						`the original skill predicate must accept the actual native yingZhan event: ${JSON.stringify(responseStarted.snapshot.yinYangNativeCandidate)}`);
					assert.equal(responseStarted.snapshot.yinYangNativeCandidate?.nativeIncomingAttack, true);
					assert.equal(responseStarted.snapshot.yinYangNativeCandidate?.eventHadCard, true);
					assert.equal(responseStarted.snapshot.yinYangNativeCandidate?.hasSkill, true);
					assert.ok(responseStarted.snapshot.yinYangNativeCandidate?.filterCalls > 0);
					assert.ok(responseStarted.snapshot.yinYangNativeCandidate?.eligibleFilterCalls > 0,
						"the original skill filter did not expose an eligible native candidate");
					assert.ok(responseStarted.snapshot.yinYangNativeCandidate?.matchingPhysicalMaterialCount > 0,
						"the seat did not receive a real matching physical gongJi material through native gameDraw");
				if (process.env.V2_NATIVE_YINYANG_VIEWAS_PROBE === "1") {
					const contractTrace = nativeDiagnostic.find(entry => entry?.stage === "native_yinyang_viewas_contract_probe");
					const contract = contractTrace?.snapshot;
					assert.ok(contract, `the live native yingZhan did not expose the opt-in YinYang viewAs contract probe: ${JSON.stringify(nativeDiagnostic.filter(entry => String(entry?.stage).includes("yinyang")))}`);
					assert.equal(contract.eventName, "yingZhan");
					assert.equal(contract.eventContent, "chooseToUse");
					assert.equal(contract.hasSkill, true);
					assert.equal(contract.nativeEventEnableMatches, true,
						`the native skill enable contract must include the actual event: ${JSON.stringify(contract)}`);
					assert.equal(contract.nativeSkillFilterAccepted, true);
					assert.equal(contract.engineSkillEnabled, contract.nativeSkillExpanded,
						"filterEnable must reflect the actual player skill expansion result, not a fabricated candidate");
					assert.equal(contract.materialFilterAccepted, true,
						"the original skill.filterCard must accept a physical hand material");
					assert.equal(contract.nativeEventFilterAccepted, true,
						"the original yingZhan event.filterCard must accept the skill's virtual viewAs card");
					assert.equal(contract.nativeCardEnabled, true);
					assert.ok(contract.legalTargetCount > 0, "native target filters must accept at least one target for the virtual card");
					assert.deepEqual(contract.virtualShape, { hasName: true, xiBieMatchesIncoming: true, isCard: true,
						containsPhysicalMaterials: false, hasSkillField: false, hasSourceSkillField: false });
					assert.equal(contract.viewAsFilterPresent, false,
						"yinYangZhanHuan has no viewAsFilter; enable/filter/filterCard are the controlling predicates");
					assert.equal(contract.nativeUiCandidateEnumerationObserved, false,
						"this probe validates native eligibility and result shape, not the legacy local-UI candidate enumerator");
					assert.equal(contract.probeError, null);
					assert.equal(contract.contractAccepted, true, `native skill contract rejected: ${JSON.stringify(contract)}`);
					console.info(`native_yinyang_viewas_contract=${JSON.stringify(contract)}`);
				}
				}
			}
			if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1") {
				if (process.env.V2_NATIVE_RESPONSE_NO_OPTIONS === "1") {
					assert.equal(nativeNoOptionCandidateAvailable, true,
						"seeded opening did not yield a gongJi target excluded by the response-candidate probe; inspect whether the native response set is complete");
					assert.equal(nativeResponseChoices.length, 0, "no-option native response must not register a controller choice");
					assert.equal(nativeResponseAckCount, 0, "no-option native response must not emit a managed-choice ACK");
					const responseStarted = nativeDiagnostic.find(entry => entry?.stage === "native_response_started" && entry?.snapshot?.eventName === "yingZhan");
					const responseCompleted = nativeDiagnostic.find(entry => entry?.stage === "native_response_completed" && entry?.snapshot?.eventName === "yingZhan");
					assert.ok(responseStarted, `native no-option attack did not enter the original yingZhan event: ${JSON.stringify(nativeDiagnostic.filter(entry => String(entry?.stage).includes("response")).slice(-10))}`);
					assert.ok(responseCompleted, "native no-option yingZhan event did not complete");
					assert.equal(responseCompleted.snapshot.resultBool, false,
						"native chooseToUse must resolve a no-option response as an actual decline through its original AI path");
					assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_response_wait_open"), false,
						"the server adapter must not open an event-local choice gate when the original native filters expose no legal response");
					assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_response_applied"), false,
						"no-option fallback must not fabricate a managed response application");
				} else {
				assert.ok(nativeResponseChoice, `no server-managed native response choice was registered: ${JSON.stringify(nativeDiagnostic.filter(entry => String(entry?.stage).includes("response")).slice(-12))}`);
				assert.ok(nativeResponseCandidate);
				const responseWaitOpen = nativeDiagnostic.find(entry => entry?.stage === "native_response_wait_open" &&
					entry?.snapshot?.nativeEventId === nativeResponseCandidate.nativeEventId);
				assert.ok(responseWaitOpen, "managed response must expose its event-local native wait gate");
				assert.equal(responseWaitOpen.snapshot?.waitEventName, "managedNativeResponseWait");
				assert.equal(responseWaitOpen.snapshot?.waitEventParentName, "yingZhan");
				assert.equal(responseWaitOpen.snapshot?.paused, false,
					"managed response waiting must suspend only its native parent/child path, never globally pause the event manager");
				assert.notEqual(nativeResponseCandidate.seatId, nativeActionCandidate.seatId,
					"the response seat must be distinct from the active attacker seat");
				const nativeApplied = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_response_applied" && entry?.snapshot?.nativeEventId === nativeResponseCandidate.nativeEventId), 5000,
					() => ({ responseChoices: nativeResponseChoices.map(entry => controller.inspect(roomId, entry.choice.choiceId)),
						responseStages: nativeDiagnostic.filter(entry => String(entry?.stage).includes("response")).slice(-12), host: manager.inspect(roomId) }));
				assert.equal(nativeApplied.snapshot?.rootObjectMatches, true);
				assert.equal(nativeApplied.snapshot?.rootInstanceId, nativeDiagnostic.find(entry => entry?.stage === "native_start_probe_outcome")?.snapshot?.rootInstanceId);
				assert.equal(nativeApplied.snapshot?.gameMeAbsent, true);
				if (process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1") {
					assert.equal(nativeApplied.snapshot?.selectedKind, "decline");
					assert.equal(nativeApplied.snapshot?.bool, false, "deadline trustee must return the native optional-decline result");
					assert.equal(nativeApplied.snapshot?.useCardChildrenStarted, 0, "trustee decline must not create a useCard child");
					assert.equal(nativeApplied.snapshot?.useCardChildrenCompleted, 0);
				} else if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
					assert.equal(nativeApplied.snapshot?.selectedKind, "decline",
						"the shengJi fixture must use the defender's managed native optional-decline choice to reach the original shengJi trigger");
					assert.equal(nativeApplied.snapshot?.bool, false,
						"the managed response must preserve chooseToUse's native decline result");
					assert.equal(nativeApplied.snapshot?.useCardChildrenStarted, 0,
						"native decline must not manufacture a response useCard child");
					assert.equal(nativeApplied.snapshot?.useCardChildrenCompleted, 0);
				} else if (process.env.V2_NATIVE_MANAGED_YINYANG === "1") {
					assert.equal(nativeApplied.snapshot?.selectedKind, "view_as_skill");
					assert.equal(nativeApplied.snapshot?.skillId, "yinYangZhanHuan");
					assert.equal(nativeApplied.snapshot?.physicalMaterialConsumed, true);
					assert.equal(nativeApplied.snapshot?.xiBieApplied, true);
					assert.ok(nativeApplied.snapshot?.guiHuoDelta > 0, "native guiHuo effect must be observed after the completed useCard child");
					assert.equal(nativeApplied.snapshot?.targetCount, 1);
					assert.equal(nativeApplied.snapshot?.useCardChildrenStarted, 1);
					assert.equal(nativeApplied.snapshot?.useCardChildrenCompleted, 1);
					if (process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1") {
						assert.equal(nativeEffectStateBefore?.snapshot?.schema, "xingbei_native_private_effect_commitment_v1");
						assert.equal(nativeEffectStateAfter?.snapshot?.schema, "xingbei_native_private_effect_commitment_v1");
						assert.equal(nativeEffectStateRepeat?.snapshot?.schema, "xingbei_native_private_effect_commitment_v1");
						assert.equal(nativeEffectStateBefore.snapshot.snapshotOrdinal, 1);
						assert.equal(nativeEffectStateAfter.snapshot.snapshotOrdinal, 2);
						assert.equal(nativeEffectStateRepeat.snapshot.snapshotOrdinal, 3);
						assert.equal(nativeEffectStateBefore.snapshot.mode, "before_native_response");
						assert.equal(nativeEffectStateBefore.snapshot.captureBoundary, "native_response_waiting");
						assert.equal(nativeEffectStateAfter.snapshot.mode, "after_native_response");
						assert.equal(nativeEffectStateAfter.snapshot.captureBoundary, "native_response_completed");
						assert.equal(nativeEffectStateAfter.snapshot.nativeEventId, nativeResponseCandidate.nativeEventId);
						assert.equal(nativeEffectStateAfter.snapshot.nativeCompletionOrdinal, nativeApplied.snapshot.nativeCompletionOrdinal);
						assert.equal(nativeEffectStateAfter.snapshot.stableWithPrevious, false,
							"native guiHuo/skill effect must change the private effect commitment");
						assert.equal(nativeEffectStateRepeat.snapshot.stableWithPrevious, true,
							"repeating the same stable native state must reproduce the same private commitment");
						assert.equal(nativeEffectStateRepeat.snapshot.commitment, nativeEffectStateAfter.snapshot.commitment);
						assert.notEqual(nativeEffectStateBefore.snapshot.commitment, nativeEffectStateAfter.snapshot.commitment);
						assert.ok(nativeDiagnostic.some(entry => entry?.stage === "native_response_completed" &&
							entry?.snapshot?.nativeEventId === nativeResponseCandidate.nativeEventId),
							"post snapshot must follow the native response GameEvent completion ordinal, not IPC arrival order");
						assert.equal(nativeEffectStateAfter.snapshot.checkpointAvailable, false);
						assert.equal(JSON.stringify([nativeEffectStateBefore.snapshot, nativeEffectStateAfter.snapshot,
							nativeEffectStateRepeat.snapshot]).includes("yinYangZhanHuan"), false,
							"private effect state must not disclose per-seat skill contents");
					}
					const responseStarted = nativeDiagnostic.find(entry => entry?.stage === "native_response_started" &&
						entry?.snapshot?.eventName === "yingZhan" && entry?.snapshot?.seatId === nativeResponseCandidate.seatId);
					const responseCompleted = nativeDiagnostic.find(entry => entry?.stage === "native_response_completed" &&
						entry?.snapshot?.eventName === "yingZhan" && entry?.snapshot?.seatId === nativeResponseCandidate.seatId &&
						entry?.snapshot?.selectedKind === "view_as_skill");
					assert.equal(responseStarted?.snapshot?.eventName, "yingZhan");
					assert.equal(responseStarted?.snapshot?.nativeContentName, "chooseToUse");
					assert.ok(responseStarted?.snapshot?.parentChain?.includes("_yingZhan"),
						"the tested response must be the native _yingZhan → yingZhan → chooseToUse path");
					assert.equal(responseCompleted?.snapshot?.parentEventName, "_yingZhan");
					assert.equal(responseCompleted?.snapshot?.responseUseCardChildrenStarted, 1);
					assert.equal(responseCompleted?.snapshot?.responseUseCardChildrenCompleted, 1);
					const child = nativeApplied.snapshot?.nativeUseCardChild;
					assert.deepEqual({ eventName: child?.eventName, parentEventName: child?.parentEventName,
						parentEventInstanceMatchesResponse: child?.parentEventInstanceMatchesResponse },
					{ eventName: "useCard", parentEventName: "yingZhan", parentEventInstanceMatchesResponse: true },
					"the skill must complete through its actual native useCard child under the same response event instance");
					assert.ok(Array.isArray(child.effectEventTree) && child.effectEventTree.length > 0);
					assert.equal(child.effectEventTree[0].eventName, "useCard");
					assert.equal(child.effectEventTree[0].parentEventName, "yingZhan");
					const skillTriggers = child.nativeSkillTriggerTrace || [];
					assert.equal(child.nativeSkillTriggerTraceOverflow, false, "bounded topology observer must not truncate this tested native effect path");
					const gongJiBefore = skillTriggers.find(entry => entry.triggerName === "gongJiBefore");
					const yinYangSkillTrigger = skillTriggers.find(entry => entry.triggerName === "yinYangZhanHuan");
					assert.deepEqual({ ownerEventName: gongJiBefore?.ownerEventName, triggerEventName: gongJiBefore?.triggerEventName,
						triggerEventParentName: gongJiBefore?.triggerEventParentName, triggerEventParentMatchesOwner: gongJiBefore?.triggerEventParentMatchesOwner,
						linkedToNativeResponse: gongJiBefore?.linkedToNativeResponse },
					{ ownerEventName: "useCard", triggerEventName: "arrangeTrigger", triggerEventParentName: "useCard",
						triggerEventParentMatchesOwner: true, linkedToNativeResponse: true },
					"the native useCard event must schedule Xingbei's gongJiBefore trigger under itself");
					assert.deepEqual({ ownerEventName: yinYangSkillTrigger?.ownerEventName, triggerEventName: yinYangSkillTrigger?.triggerEventName,
						triggerEventParentName: yinYangSkillTrigger?.triggerEventParentName, triggerEventParentMatchesOwner: yinYangSkillTrigger?.triggerEventParentMatchesOwner,
						linkedToNativeResponse: yinYangSkillTrigger?.linkedToNativeResponse },
					{ ownerEventName: "yinYangZhanHuan_xiaoGuo", triggerEventName: "arrangeTrigger", triggerEventParentName: "yinYangZhanHuan_xiaoGuo",
						triggerEventParentMatchesOwner: true, linkedToNativeResponse: true },
					"the native skill subskill must schedule its yinYangZhanHuan trigger beneath its actual trigger event");
					const nativeResponseAck = ackTrace.find(entry => entry.choiceId === nativeResponseChoice.choiceId);
					const authorityEvent4 = nativeDiagnostic.find(entry => entry?.stage === "native_card_action_event_4_accepted");
					const nativeActionAck = ackTrace.find(entry => entry.nativeAction && entry.authorityEventSequence === 4);
					assert.ok(Number.isSafeInteger(nativeApplied.snapshot?.nativeCompletionOrdinal) && nativeApplied.snapshot.nativeCompletionOrdinal > 0,
						"the native engine must stamp the completed response after validating its child effects");
					assert.equal(nativeResponseAck?.nativeCompletionOrdinal, nativeApplied.snapshot.nativeCompletionOrdinal,
						"the response ACK must reference the exact native completion proof; parent IPC receive-time ordering is not a native execution order");
					assert.ok(nativeResponseAck?.at < authorityEvent4?.receivedAt,
						`response acknowledgement ordering mismatch: ${JSON.stringify({ nativeAppliedAt: nativeApplied.at,
							responseAck: nativeResponseAck, authorityEvent4At: authorityEvent4?.receivedAt,
							nativeActionAck, responseAckAttempts: ackTrace.filter(entry => entry.choiceId === nativeResponseChoice.choiceId) })}`);
					assert.ok(authorityEvent4?.receivedAt <= nativeActionAck?.at,
						`parent action ACK ordering mismatch: ${JSON.stringify({ authorityEvent4At: authorityEvent4?.receivedAt,
							nativeActionAck, nativeActionAckAttempts: ackTrace.filter(entry => entry.nativeAction) })}`);
				} else {
					assert.equal(nativeApplied.snapshot?.selectedKind, "card");
					const selectedNativeShape = nativeResponseCandidate.optionShapes[nativeResponseOptionId];
					assert.ok(["native_notarget_card", "native_single_target_card"].includes(selectedNativeShape),
						"managed response must select a supported native card shape");
					assert.equal(nativeApplied.snapshot?.targetCount, selectedNativeShape === "native_notarget_card" ? 0 : 1,
						"managed response must preserve the exact native option shape selected by its opaque ID");
					assert.equal(nativeApplied.snapshot?.useCardChildrenStarted, 1);
					assert.equal(nativeApplied.snapshot?.useCardChildrenCompleted, 1);
				}
				assert.equal(nativeApplied.snapshot?.nativeEventId, nativeResponseCandidate.nativeEventId);
				assert.equal(Object.hasOwn(nativeApplied.snapshot || {}, "cardName"), false,
					"private response card names must not enter host diagnostics");
				assert.equal(Object.hasOwn(nativeApplied.snapshot || {}, "selectedCardName"), false,
					"private response selections must not enter host diagnostics");
				assert.equal(controller.inspect(roomId, nativeResponseChoice.choiceId)?.resolution?.kind,
					process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1" ? "trustee" : "player");
				assert.equal(controller.inspect(roomId, nativeResponseChoice.choiceId)?.resolution?.option,
					process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1" ? nativeResponseCandidate.trusteeOption : nativeResponseOptionId);
				await until(() => controller.inspect(roomId, nativeResponseChoice.choiceId)?.state === "resolved", 5000,
					() => ({ choice: controller.inspect(roomId, nativeResponseChoice.choiceId), ackTrace: ackTrace.slice(-8), host: manager.inspect(roomId) }));
				assert.ok(nativeResponseChoices.length >= 1);
				assert.ok(nativeResponseChoices.length > 0);
				if (process.env.V2_NATIVE_RESPONSE_ACK_LOSS === "1") {
					await until(() => (nativeResponseAckAttempts.get(droppedNativeResponseAckChoiceId) || 0) >= 2, 5000,
						() => ({ nativeResponseAckCount, nativeResponseChoices: nativeResponseChoices.map(entry => entry.choice.choiceId),
							droppedNativeResponseAckChoiceId, nativeResponseAckAttempts: Object.fromEntries(nativeResponseAckAttempts),
							droppedChoice: controller.inspect(roomId, droppedNativeResponseAckChoiceId),
							choice: controller.inspect(roomId, nativeResponseChoice.choiceId), host: manager.inspect(roomId), ackTrace: ackTrace.slice(-8),
							retryDiagnostics: nativeDiagnostic.filter(item => item?.choiceId === droppedNativeResponseAckChoiceId ||
								item?.deliveryId === controller.inspect(roomId, droppedNativeResponseAckChoiceId)?.deliveryId),
							responseAckCounts: nativeResponseChoices.map(entry => ({ choiceId: entry.choice.choiceId, count: nativeResponseAckAttempts.get(entry.choice.choiceId) || 0 })) }));
				}
				assert.ok(nativeResponseChoices.every(entry => {
					const results = nativeResponseAckResults.filter(ack => ack.choiceId === entry.choice.choiceId);
					const accepted = results.filter(ack => ack.accepted === true);
					const duplicateAfterResolve = results.filter(ack => ack.before === "resolved");
					const completed = nativeDiagnostic.find(item => item?.stage === "native_response_applied" && item?.snapshot?.nativeEventId === entry.candidate.nativeEventId);
					const ackAttempts = ackTrace.filter(item => item.choiceId === entry.choice.choiceId);
					return accepted.length === 1 && accepted[0].responseEventCompleted === true &&
						duplicateAfterResolve.every(ack => ack.accepted === false && ack.result === "MANAGED_CHOICE_ACK_REJECTED") &&
						Number.isSafeInteger(completed?.snapshot?.nativeCompletionOrdinal) && completed.snapshot.nativeCompletionOrdinal > 0 &&
						ackAttempts.length >= 1 && ackAttempts.every(ack => ack.nativeCompletionOrdinal === completed.snapshot.nativeCompletionOrdinal);
				}), `each native response must have exactly one accepted post-completion ACK; retries after resolution must be rejected without reapplying: ${JSON.stringify({ nativeResponseChoices: nativeResponseChoices.map(entry => entry.choice.choiceId), nativeResponseAckResults, ackTrace: ackTrace.slice(-12) })}`);
				assert.ok(nativeResponseChoices.every(entry => nativeResponseAckResults.some(ack => ack.choiceId === entry.choice.choiceId && ack.accepted && ack.responseEventCompleted)),
					"controller must accept each post-completion ACK before its host session is cleaned up");
				assert.ok(nativeResponseChoices.every(entry => nativeDiagnostic.filter(item => item?.stage === "native_response_applied" &&
					item?.snapshot?.nativeEventId === entry.candidate.nativeEventId).length === 1),
					"native response delivery/ACK retry must not apply the same response twice");
				if (process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1") {
					assert.ok(nativeResponseChoices.length >= 2, "native response action did not produce the expected nested response choice");
					const nestedResponse = nativeResponseChoices.map(entry => ({ entry,
						gate: nativeDiagnostic.find(item => item?.stage === "native_response_wait_open" &&
							item?.snapshot?.nativeEventId === entry.candidate.nativeEventId)?.snapshot,
					})).find(item => item.gate?.parentChain?.includes("yingZhan"));
					assert.ok(nestedResponse, `native engine did not create a managed response beneath an earlier yingZhan event: ${JSON.stringify(
						nativeResponseChoices.map(entry => nativeDiagnostic.find(item => item?.stage === "native_response_wait_open" &&
							item?.snapshot?.nativeEventId === entry.candidate.nativeEventId)?.snapshot?.parentChain || null))}`);
					assert.equal(nestedResponse.gate?.rootObjectMatches, true);
					assert.equal(nestedResponse.gate?.waitEventParentName, "yingZhan");
					assert.equal(nestedResponse.gate?.gameMeAbsent, true);
					assert.ok(nativeResponseAckResults.some(ack => ack.choiceId === nestedResponse.entry.choice.choiceId && ack.accepted),
						"nested native response must complete through authenticated post-event ACK");
				}
				if (process.env.V2_NATIVE_RESPONSE_ACK_LOSS === "1") {
					assert.equal(nativeResponseAckDropped, true, "response ACK-loss injection did not drop the first native completion ACK");
					assert.ok(nativeResponseAckResults.find(ack => ack.choiceId === nativeResponseChoice.choiceId)?.accepted,
						"response ACK loss did not trigger stable managed-choice redelivery");
					assert.ok(nativeDiagnostic.some(item => ["native_response_duplicate_while_applying", "native_response_duplicate_after_apply",
						"native_response_duplicate_verified_applied"].includes(item?.stage) &&
						item?.choiceId === droppedNativeResponseAckChoiceId),
						"ACK-loss retry must reach the native idempotency fence and verify the same immutable response delivery");
				}
				}
			}
			await until(() => {
				const session = manager.inspect(roomId);
				if (session?.state === "failed") {
					const waitErrors = nativeDiagnostic.filter(entry => entry?.stage === "wait_next_error").slice(-4)
						.map(entry => ({ eventName: entry?.snapshot?.eventName || null,
							eventStep: Number.isSafeInteger(entry?.snapshot?.eventStep) ? entry.snapshot.eventStep : null,
							parentEventName: entry?.snapshot?.parentEventName || null,
							error: entry?.snapshot?.nativeWaitError || null }));
					throw new Error(`native action host failed before choice resolution:${JSON.stringify({ failureCode: session.failureCode,
						choiceState: controller.inspect(roomId, nativeActionChoice.choiceId)?.state || null, waitErrors,
						recentStages: nativeDiagnostic.slice(-16).map(entry => entry?.stage) })}`);
				}
				return controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved";
			}, 15000, () => ({ choice: controller.inspect(roomId, nativeActionChoice.choiceId), host: manager.inspect(roomId), stages: nativeDiagnostic.map(entry => entry?.stage) }));
			if (process.env.V2_NATIVE_PARENT_FENCE === "1") {
				const fenceReleased = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_fence_released" &&
					entry?.snapshot?.nativeEventId === nativeActionCandidate?.nativeEventId), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-12), host: manager.inspect(roomId) }));
				const hostTip = manager.inspect(roomId);
				assert.equal(fenceReleased.snapshot.status, "released");
				assert.equal(fenceReleased.snapshot.releaseCount, 1, "parent continuation must have one accepted release");
				assert.deepEqual(fenceReleased.snapshot.releaseResolution, { eventSequence: 4, stateRevision: 4,
					afterDigest: hostTip.authorityStateDigest });
				if (process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1") {
					const successor = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_next_action_child_start" &&
						nativeDiagnostic.indexOf(entry) > nativeDiagnostic.indexOf(fenceReleased)), 5000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-12), host: manager.inspect(roomId) }));
					assert.deepEqual(successor.snapshot.priorParentFence, { status: "released", releaseCount: 1,
						acceptedAuthority: { nativeEventId: nativeActionCandidate.nativeEventId, eventSequence: 4,
							stateRevision: 4, afterDigest: hostTip.authorityStateDigest },
						releaseResolution: { eventSequence: 4, stateRevision: 4, afterDigest: hostTip.authorityStateDigest } },
						"the next native action must observe the immutable server-accepted Event #4 release tuple");
					assert.equal(successor.snapshot.rootObjectMatches, true);
					assert.equal(successor.snapshot.gameMeAbsent, true);
				} else {
					assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_parent_next_action_child_start" &&
						nativeDiagnostic.indexOf(entry) > nativeDiagnostic.indexOf(fenceReleased)), false,
						"the phase boundary fence must hold before the next native action is created");
				}
			}
			if (process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1") {
				if (probeMode === "managed_opening_root_action_event5") t.diagnostic("Event #5 waiting for completed phase boundary observation");
				const phaseBoundary = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_loop_wait_next_boundary" &&
					entry?.snapshot?.isCompletedPhaseBoundary === true), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-12), host: manager.inspect(roomId) }));
				if (probeMode === "managed_opening_root_action_event5") t.diagnostic(`Event #5 observed phase boundary: ${JSON.stringify({
					eventName: phaseBoundary.snapshot.eventName, eventStep: phaseBoundary.snapshot.eventStep,
					loopSeatId: phaseBoundary.snapshot.loopSeatId, completedPhaseSeatId: phaseBoundary.snapshot.completedPhaseSeatId,
					completionOrdinal: phaseBoundary.snapshot.nativeCompletionOrdinal, sameRoot: phaseBoundary.snapshot.rootObjectMatches,
				})}`);
				assert.equal(phaseBoundary.snapshot.eventName, "phaseLoop");
				assert.equal(phaseBoundary.snapshot.eventStep, 1);
				assert.equal(phaseBoundary.snapshot.completedChildName, "phase");
				assert.equal(phaseBoundary.snapshot.completedChildFinished, true);
				assert.equal(phaseBoundary.snapshot.completedChildParentMatches, true);
				assert.equal(phaseBoundary.snapshot.pendingChildCount, 0);
				assert.equal(phaseBoundary.snapshot.nextCount, 0);
				assert.equal(phaseBoundary.snapshot.eventStackTop, "phaseLoop");
				assert.equal(phaseBoundary.snapshot.eventStack.includes("phase"), false);
				assert.equal(phaseBoundary.snapshot.currentPhaseSeatId, null);
				assert.equal(phaseBoundary.snapshot.loopSeatId, phaseBoundary.snapshot.firstActSeatId);
				assert.equal(phaseBoundary.snapshot.loopSeatId, nativeActionCandidate.seatId);
				assert.deepEqual(phaseBoundary.snapshot.completedActorQuotas, { gongJiOrFaShu: 0, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
					"the phase boundary must follow native xingDong quota consumption");
				assert.match(phaseBoundary.snapshot.rootInstanceId, /^native_root_[A-Za-z0-9_-]{16,96}$/);
				assert.equal(phaseBoundary.snapshot.rootObjectMatches, true);
				assert.equal(phaseBoundary.snapshot.gameMeAbsent, true);
				assert.equal(phaseBoundary.snapshot.connectedTransports, 0);
				const phaseBoundaryAuthority = manager.inspect(roomId);
				assert.equal(phaseBoundaryAuthority.authorityStateRevision, 4);
				assert.equal(phaseBoundaryAuthority.nextAuthorityEventSequence, 5);
				assert.equal(phaseBoundaryAuthority.authorityStateDigest, phaseBoundary.snapshot.priorAuthorityFence.releaseResolution.afterDigest,
					"the read-only boundary audit must not seed or advance the authority chain");
				assert.equal(phaseBoundaryAuthority.checkpointAvailable, false);
				assert.deepEqual(phaseBoundary.snapshot.priorAuthorityFence, {
					status: "released", releaseCount: 1, nativeEventId: nativeActionCandidate.nativeEventId,
					releaseResolution: { eventSequence: 4, stateRevision: 4, afterDigest: manager.inspect(roomId).authorityStateDigest },
				}, "the completed native phase must follow, not precede, accepted Event #4");
				const phaseBoundaryIndex = nativeDiagnostic.indexOf(phaseBoundary);
				const nextActionStartIndex = nativeDiagnostic.findIndex(entry => entry?.stage === "native_parent_next_action_child_start" &&
					entry?.snapshot?.priorParentFence?.status === "released");
				if (process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1") assert.equal(nextActionStartIndex, -1,
					"the scoped fence must prevent next action creation until the boundary is released");
				else assert.ok(nextActionStartIndex > phaseBoundaryIndex,
					"phaseLoop must expose a completed, empty phase boundary before starting the next native action");
				t.diagnostic(`native phase boundary candidate: ${JSON.stringify({ phaseBoundary: phaseBoundary.snapshot,
					nextActionStartIndex, phaseBoundaryIndex, transitionAuthorized: false, seedAuthorized: false })}`);
				if (process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1") {
					const waitingBoundaryFence = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_boundary_fence_waiting"), 5000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-12), host: manager.inspect(roomId) }));
					const waitingSnapshot = waitingBoundaryFence.snapshot;
					assert.equal(waitingSnapshot.status, "waiting");
					assert.equal(waitingSnapshot.nativeEventId, nativeActionCandidate.nativeEventId);
					assert.equal(waitingSnapshot.rootInstanceId, phaseBoundary.snapshot.rootInstanceId);
					assert.equal(waitingSnapshot.seatId, nativeActionCandidate.seatId);
					assert.equal(waitingSnapshot.completedPhaseFinished, true);
					assert.equal(waitingSnapshot.completedPhaseParentMatches, true);
					assert.equal(waitingSnapshot.completionEvidence?.rootInstanceId, waitingSnapshot.rootInstanceId);
					assert.equal(waitingSnapshot.completionEvidence?.eventName, "phase");
					assert.equal(waitingSnapshot.completionEvidence?.parentEventName, "phaseLoop");
					assert.equal(waitingSnapshot.completionEvidence?.seatId, waitingSnapshot.seatId);
					assert.ok(Number.isSafeInteger(waitingSnapshot.completionEvidence?.completionOrdinal));
					assert.ok(Number.isSafeInteger(waitingSnapshot.nativeCompletionOrdinal));
					assert.ok(waitingSnapshot.completionEvidence.completionOrdinal <= waitingSnapshot.nativeCompletionOrdinal);
					assert.equal(waitingSnapshot.runtimeHujiaMethodPresent, false);
					assert.equal(waitingSnapshot.runtimeHujiaValuePresent, false);
					assert.equal(waitingSnapshot.runtimeHujiaPrototypeOwnerCount, 0);
					assert.equal(waitingSnapshot.pendingDescendantCount, 0);
					assert.deepEqual(waitingSnapshot.completedActorQuotas, { gongJiOrFaShu: 0, faShu: 0, gongJi: 0, extraXingDongCount: 0 });
					assert.equal(waitingSnapshot.priorAuthority.afterDigest, phaseBoundaryAuthority.authorityStateDigest);
					if (process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE === "1") {
						const atomic = await manager.snapshotNativeAtomicCapture(roomId);
						assert.equal(atomic.ok, true, `native atomic capture rejected: ${atomic.code}`);
						assert.deepEqual(Object.keys(atomic.snapshot).sort(), ["achievementResourceSummary", "atomicWithEffectSnapshots", "authoritySeedAuthorized", "captureOrdinal",
							"checkpointAvailable", "commitment", "engineBuildId", "nativeCompletionOrdinal", "nativeFenceOrdinal", "nativeTurnSummary", "projectionCount", "rootInstanceId",
							"schema", "schemaVersion", "stableProjectionsWithPrevious", "stableWithPrevious"].sort());
						assert.equal(atomic.snapshot.captureOrdinal, 1);
						assert.equal(atomic.snapshot.nativeFenceOrdinal, 1);
						assert.equal(atomic.snapshot.nativeCompletionOrdinal, waitingSnapshot.nativeCompletionOrdinal,
							"the ordinal must come from completed native GameEvent.start/waitNext boundaries, not phaseOverTriggerCount");
						if (process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1") {
							assert.equal(waitingSnapshot.seatId, nativeResourceFixtureSeatId,
								"the resource transition and private turn/resource projection must describe the same native actor");
							assert.equal(atomic.snapshot.rootInstanceId, nativeResourceTransition?.rootInstanceId);
							assert.ok(atomic.snapshot.nativeCompletionOrdinal > nativeResourceTransition?.childCompletionOrdinal,
								"the three-projection private commitment must be captured after the completed native changeZhiLiao child");
							if (process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1") {
								assert.ok(nativePreActionCapture?.ok, "the same native action must have an accepted pre-action atomic commitment");
								assert.equal(nativePreActionCapture.snapshot.roomId, roomId);
								assert.equal(nativePreActionCapture.snapshot.hostSessionId, atomicCaptureSessionId || manager.inspect(roomId).sessionId);
								assert.equal(nativePreActionCapture.snapshot.rootInstanceId, atomic.snapshot.rootInstanceId);
								assert.equal(nativePreActionCapture.snapshot.engineBuildId, atomic.snapshot.engineBuildId);
								assert.equal(nativePreActionCapture.snapshot.seatId, nativeResourceFixtureSeatId);
								assert.equal(nativePreActionCapture.snapshot.nativeEventId, nativeActionCandidate.nativeEventId);
								assert.equal(nativePreActionCapture.snapshot.commitment === atomic.snapshot.commitment, false,
									"the pre-input and post-phaseOver snapshots are distinct commitments at distinct native fences");
								assert.equal(nativeResourceTransition?.childEventName, "changeZhiLiao");
								assert.equal(nativeResourceTransition?.delta, 1);
							}
						}
						assert.equal(atomic.snapshot.projectionCount, 3);
						assert.equal(atomic.snapshot.atomicWithEffectSnapshots, true);
						assert.equal(atomic.snapshot.authoritySeedAuthorized, false);
						assert.equal(atomic.snapshot.checkpointAvailable, false);
						assert.equal(atomic.snapshot.rootInstanceId, waitingSnapshot.rootInstanceId);
						assert.deepEqual(atomic.snapshot.nativeTurnSummary, {
							actorSeatId: waitingSnapshot.seatId, phaseLoopSeatId: waitingSnapshot.nextActorSeatId, phase: "between_turns",
							gamePhaseNumber: waitingSnapshot.phaseNumber, playerPhaseNumber: waitingSnapshot.completedPhasePlayerPhaseNumber,
							quotas: { gongJiOrFaShu: waitingSnapshot.completedActorQuotas.gongJiOrFaShu,
								faShu: waitingSnapshot.completedActorQuotas.faShu, gongJi: waitingSnapshot.completedActorQuotas.gongJi },
						}, "atomic turn projection must bind completed actor quotas separately from native loop successor");
						assert.equal(manager.inspect(roomId).authorityStateRevision, 4);
						assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
						assert.equal(manager.inspect(roomId).checkpointAvailable, false);
						const atomicRepeat = await manager.snapshotNativeAtomicCapture(roomId);
						assert.equal(atomicRepeat.ok, true, `stable held-fence atomic repeat rejected: ${atomicRepeat.code}`);
						assert.equal(atomicRepeat.snapshot.captureOrdinal, 2);
						assert.equal(atomicRepeat.snapshot.nativeCompletionOrdinal, atomic.snapshot.nativeCompletionOrdinal);
						assert.deepEqual(atomicRepeat.snapshot.stableProjectionsWithPrevious, { cardLedger: true, effectState: true, turnResource: true });
						assert.equal(atomicRepeat.snapshot.stableWithPrevious, true);
						assert.notEqual(atomicRepeat.snapshot.commitment, atomic.snapshot.commitment,
							"commitments bind distinct capture ordinals even when the underlying native state is stable");
						firstAtomicCapture = atomic.snapshot;
						firstAtomicRepeat = atomicRepeat.snapshot;
						atomicCaptureSessionId = manager.inspect(roomId).sessionId;
						const firstCaptureHandle = launchedHandles.get(atomicCaptureSessionId);
						assert.ok(firstCaptureHandle && firstCaptureHandle.pid > 0);
						atomicCapturePid = firstCaptureHandle.pid;
						assert.equal(firstCaptureHandle.resources().length, 1);
						atomicChromiumPid = firstCaptureHandle.resources()[0].pid;
						t.diagnostic(`managed atomic private capture accepted at held native fence: ${JSON.stringify({ ordinal: atomic.snapshot.captureOrdinal,
							nativeCompletionOrdinal: atomic.snapshot.nativeCompletionOrdinal, projectionCount: atomic.snapshot.projectionCount,
							atomicWithEffectSnapshots: atomic.snapshot.atomicWithEffectSnapshots, stableRepeat: atomicRepeat.snapshot.stableWithPrevious,
							seedAuthorized: atomic.snapshot.authoritySeedAuthorized,
							checkpointAvailable: atomic.snapshot.checkpointAvailable })}`);
					}
					if (process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1") {
						nativeCardLedgerCaptureContexts.push({ ordinal: 2, mode: "post_phase_over", boundary: "completed_native_phaseOver_fence",
							nativeEventId: waitingSnapshot.nativeEventId, eventSequence: waitingSnapshot.priorAuthority?.eventSequence ?? null,
							nativeCompletionOrdinal: null });
						const result = await manager.snapshotNativeCardLedger(roomId, "post_phase_over");
						if (!result.ok) nativeCardLedgerFailures.push({ stage: "post_phase_over", code: result.code });
						assert.equal(result.ok, true, `private post-phaseOver ledger failed: ${result.code}`);
						nativeCardLedgerAfter = result.snapshot;
						assert.equal(nativeCardLedgerAfter.snapshotOrdinal, 2);
					}
					let liveSnapshotCount = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot").length;
					const heldBefore = await manager.snapshotNativeStart(roomId);
					assert.equal(heldBefore.ok, true);
					const heldSnapshotA = await until(() => { const matches = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot");
						return matches.length > liveSnapshotCount ? matches.at(-1) : null; }, 3000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), host: manager.inspect(roomId) }));
					liveSnapshotCount = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot").length;
					const heldAfter = await manager.snapshotNativeStart(roomId);
					assert.equal(heldAfter.ok, true);
					const heldSnapshotB = await until(() => { const matches = nativeDiagnostic.filter(entry => entry?.stage === "native_start_live_snapshot");
						return matches.length > liveSnapshotCount ? matches.at(-1) : null; }, 3000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), host: manager.inspect(roomId) }));
					const stableNativeBoundary = snapshot => ({ eventStack: snapshot.eventStack, projectionAudit: snapshot.projectionAudit,
						nativePhaseBoundaryFence: snapshot.nativePhaseBoundaryFence, hostPlayerAbsent: snapshot.hostPlayerAbsent });
					assert.deepEqual(stableNativeBoundary(heldSnapshotB), stableNativeBoundary(heldSnapshotA),
						"the held native boundary projection must remain unchanged while authority is not advanced");
					assert.equal(heldSnapshotB.nativePhaseBoundaryFence?.status, "waiting");
					assert.equal(heldSnapshotB.hostPlayerAbsent, true);
					if (process.env.V2_NATIVE_T4_DELTA_AUDIT === "1") {
						assert.ok(event4AcceptedProjection, "Event #4 acceptance snapshot was not captured before the native fence release");
						const openingProof = JSON.parse(event4ProofSubmissions[0]);
						assert.equal(openingProof.eventSequence, 4);
						assert.equal(openingProof.afterDigest, event4AcceptedProjection.afterDigest);
						assert.equal(event4AcceptedProjection.rootInstanceId, heldSnapshotA.rootInstanceId);
						assert.equal(event4AcceptedProjection.rootInstanceId, heldSnapshotA.nativePhaseBoundaryFence?.rootInstanceId);
						assert.equal(event4AcceptedProjection.checkpointAvailable, false);
						assert.equal(event4AcceptedProjection.projectionAudit.seats.length, 4);
						assert.deepEqual(openingProof.afterSummary.seats.map(seat => ({ seatId: seat.seatId,
							character: seat.character, side: seat.side, handCount: seat.handCount })),
							event4AcceptedProjection.projectionAudit.seats.map(seat => ({ seatId: seat.seatId,
							character: seat.character, side: seat.side, handCount: seat.handCount })),
							"accepted Event #4 seat summary must agree with the live native state before phaseOver");
						assert.deepEqual(event4AcceptedProjection.projectionAudit.seats.map(seat => ({ seatId: seat.seatId, position: seat.position })),
							setup.seats.map(({ seatId, position }) => ({ seatId, position })),
							"live native Player.dataset.position must match the server-bound seat registry mapping");
						assert.deepEqual(event4AcceptedProjection.projectionAudit.seats.map(seat => seat.seatId),
							openingProof.afterSummary.seats.map(seat => seat.seatId), "legacy seat order must equal the live ordered native seat set");
						const publicProjection = audit => ({ roundNumber: audit.roundNumber, phaseNumber: audit.phaseNumber,
							currentSeatId: audit.currentSeatId, firstActSeatId: audit.firstActSeatId, resources: audit.resources,
							cardZoneCounts: audit.cardZoneCounts, seats: audit.seats });
						const before = publicProjection(event4AcceptedProjection.projectionAudit);
						const after = publicProjection(heldSnapshotA.projectionAudit);
						const changed = [];
						const walk = (left, right, path) => {
							if (JSON.stringify(left) === JSON.stringify(right)) return;
							if (left && right && typeof left === "object" && typeof right === "object" &&
								!Array.isArray(left) && !Array.isArray(right)) {
								for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(left[key], right[key], path ? `${path}.${key}` : key);
								return;
							}
							if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
								for (let index = 0; index < left.length; index++) walk(left[index], right[index], `${path}[${index}]`);
								return;
							}
							changed.push({ path, before: left ?? null, after: right ?? null });
						};
						walk(before, after, "");
						assert.equal(heldSnapshotA.projectionAudit?.candidateDisposition, "diagnostic_only_not_a_proof");
						assert.equal(heldSnapshotA.projectionAudit?.authorized, false);
						assert.equal(manager.inspect(roomId).authorityStateRevision, 4,
							"the Event #4-to-fence diagnostic must not advance authority state");
						assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
						assert.equal(manager.inspect(roomId).checkpointAvailable, false);
						assert.equal(JSON.stringify({ before, after, changed }).includes("handCommitment"), false);
						t.diagnostic(`T4 Event #4 accepted-to-post-phaseOver native delta (diagnostic only): ${JSON.stringify({
							rootInstanceId: event4AcceptedProjection.rootInstanceId, revision: manager.inspect(roomId).authorityStateRevision,
							before, after, changed, seedAuthorized: false, checkpointAvailable: false })}`);
					}
					assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_parent_next_action_child_start" &&
						nativeDiagnostic.indexOf(entry) > nativeDiagnostic.indexOf(waitingBoundaryFence)), false,
						"the parent must not start the next action while the boundary fence is held");
					const sentBeforeRejectedRelease = nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_release_command_accepted").length;
					assert.equal((await manager.releaseNativePhaseBoundary(roomId, { nativeEventId: waitingSnapshot.nativeEventId,
						rootInstanceId: waitingSnapshot.rootInstanceId, seatId: "seat_attacker" })).ok, false);
					assert.equal((await manager.releaseNativePhaseBoundary(roomId, { nativeEventId: "native_event_" + "0".repeat(32),
						rootInstanceId: waitingSnapshot.rootInstanceId, seatId: waitingSnapshot.seatId })).ok, false);
					assert.equal((await manager.releaseNativePhaseBoundary(roomId, { nativeEventId: waitingSnapshot.nativeEventId,
						rootInstanceId: "native_root_" + "0".repeat(32), seatId: waitingSnapshot.seatId })).ok, false);
					assert.equal(nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_release_command_accepted").length, sentBeforeRejectedRelease);
						if (process.env.V2_NATIVE_PHASE_BOUNDARY_STOP_AT_WAIT === "1") {
						const sessionBeforeStop = manager.inspect(roomId);
						assert.equal(sessionBeforeStop.state, "playable_probe");
						const stopResult = await manager.stop(roomId, "test_phase_boundary_stop");
						assert.equal(stopResult.ok, true);
						assert.equal(manager.inspect(roomId).state, "stopped");
						assert.equal(sessionEnds.filter(entry => entry.roomId === roomId && entry.sessionId === sessionBeforeStop.sessionId).length, 1);
						assert.equal(nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_released").length, 0,
							"stopping while held must not release the native parent");
						assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_parent_next_action_child_start" &&
							nativeDiagnostic.indexOf(entry) > nativeDiagnostic.indexOf(waitingBoundaryFence)), false,
							"the native parent must not create its next action when the held host is stopped");
						const handle = launchedHandles.get(sessionBeforeStop.sessionId);
						assert.ok(handle);
						await handle.waitForCleanup();
						assert.equal(handle.resources().length, 0, "stopped held-fence host must clean Chromium and profile resources");
						t.diagnostic("native phase boundary stop: held parent remained unreleased; host ended once and managed browser resources were cleaned");
						return;
					}
					if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1") {
						assert.equal(manager.inspect(roomId).authorityStateRevision, 4);
						assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
						const gatewayContext = await startExperimentalActionGateway(waitingSnapshot.rootInstanceId);
						actionGatewayContext = gatewayContext;
						assert.equal(gatewayContext.hostSessionId, manager.inspect(roomId).sessionId);
						assert.equal(gatewayContext.chromiumPid, launchedHandles.get(gatewayContext.hostSessionId).resources()[0].pid);
						assert.equal(actionGatewaySockets.size, 4, "four ordinary-player WebSockets must bind before the next native candidate is created");
					}
					const release = await manager.releaseNativePhaseBoundary(roomId, { nativeEventId: waitingSnapshot.nativeEventId,
						rootInstanceId: waitingSnapshot.rootInstanceId, seatId: waitingSnapshot.seatId });
					assert.equal(release.ok, true);
					if (process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1") {
						const releaseTrace = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_boundary_release_command_accepted"), 3000,
							() => ({ stages: nativeDiagnostic.slice(-12).map(entry => entry?.stage), host: manager.inspect(roomId) }));
						assert.equal(releaseTrace.snapshot?.multiTurnInputGateProbe, true,
							"the ACK-loss probe mode must explicitly enable the diagnostic-only next-seat gate");
						assert.equal(releaseTrace.snapshot?.nextSeatInputProbeArmed, true,
							"the authenticated Event #4 phase boundary must arm the one-shot next-seat gate");
						assert.equal(releaseTrace.snapshot?.priorGateCleared, true,
							"the completed first-seat gate must be cleared before the successor gate is considered");
					}
					const releasedBoundaryFence = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_boundary_fence_released"), 3000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), host: manager.inspect(roomId) }));
					assert.equal(releasedBoundaryFence.snapshot.releaseCount, 1);
					assert.equal(releasedBoundaryFence.snapshot.releaseResolution.afterDigest, phaseBoundaryAuthority.authorityStateDigest);
					assert.equal((await manager.releaseNativePhaseBoundary(roomId, { nativeEventId: waitingSnapshot.nativeEventId,
						rootInstanceId: waitingSnapshot.rootInstanceId, seatId: waitingSnapshot.seatId })).ok, false,
						"a boundary fence release is one-shot");
					assert.equal(nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_released").length, 1);
					const successor = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_next_action_child_start" &&
						nativeDiagnostic.indexOf(entry) > nativeDiagnostic.indexOf(releasedBoundaryFence)), 5000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-12), host: manager.inspect(roomId) }));
					assert.equal(successor.snapshot.rootObjectMatches, true);
					assert.equal(successor.snapshot.gameMeAbsent, true);
					if (process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1") {
						const nextInput = await until(() => nextSeatCandidateInspection, 10000,
							() => ({ relevantNativeStages: nativeDiagnostic.map(entry => entry?.observed?.stage || entry?.stage).filter(stage =>
								typeof stage === "string" && /next_seat|input_gate|native_action_candidate/.test(stage)).slice(-40),
								gateDecisions: nativeDiagnostic.filter(entry => entry?.observed?.stage === "native_next_seat_gate_decision")
								.slice(-8).map(entry => ({ ...entry.observed.snapshot })),
								inputGateSnapshots: nativeDiagnostic.filter(entry => ["native_input_gate", "native_input_wait_open"].includes(entry?.observed?.stage))
								.slice(-4).map(entry => ({ stage: entry.observed.stage, eventName: entry.observed.snapshot?.eventName,
									seatId: entry.observed.snapshot?.nativeInputGate?.seatId, eventSequence: entry.observed.snapshot?.nativeInputGate?.eventSequence,
									waiting: entry.observed.snapshot?.nativeInputGate?.waiting, candidateCount: entry.observed.snapshot?.nativeInputGate?.candidates?.length })),
								authority: manager.inspect(roomId) }));
						if (probeMode === "managed_opening_root_action_event5") {
							assert.equal(nextInput.source, "authenticated_event5_action_candidate");
							assert.equal(nextInput.eventSequence, 5);
						}
						assert.notEqual(nextInput.seatId, waitingSnapshot.firstActSeatId);
						assert.equal(nextInput.seatId, waitingSnapshot.nextActorSeatId,
							"the input gate must belong to the next seat selected by the native phaseLoop rotation");
						assert.equal(nextInput.eventName, "gongJiOrFaShu");
						assert.ok(nextInput.optionCount > 0);
						assert.equal(nextInput.rootInstanceId, waitingSnapshot.rootInstanceId);
						const nextSeatActionStart = nativeDiagnostic.find(entry => entry?.stage === "native_next_seat_action_start_observed" &&
							entry.snapshot?.seatId === nextInput.seatId && entry.snapshot?.eventName === "gongJiOrFaShu");
						assert.ok(nextSeatActionStart, "the native xingDong must create the successor's ordinary action child");
						assert.equal(nextSeatActionStart.snapshot.parentEventName, "xingDong");
						assert.equal(nextSeatActionStart.snapshot.eventAction, true);
						assert.ok(Number.isSafeInteger(nextSeatActionStart.snapshot.gamePhaseNumber) && nextSeatActionStart.snapshot.gamePhaseNumber >= 1);
						assert.ok(Number.isSafeInteger(nextSeatActionStart.snapshot.playerPhaseNumber) && nextSeatActionStart.snapshot.playerPhaseNumber >= 1);
						assert.deepEqual(nextSeatActionStart.snapshot.quotas,
							{ gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
							"the next actor's action quota must come from native xingDong initialization");
						assert.ok(nextSeatCandidateMessage, "the read-only preparation must use the authenticated native candidate message");
						const activeContext = manager.inspect(roomId);
						const priorChoice = controller.inspect(roomId, nativeActionChoice.choiceId);
						assert.equal(priorChoice?.state, "resolved", "the previous managed choice must be fully resolved before successor preparation");
						assert.equal(controller.pendingCount(), 0, "no previous pending choice may remain before successor preparation");
						const currentSeatConnection = seatSockets.get(nextInput.seatId);
						const seatRecord = seatRegistry.inspect(roomId, nextInput.seatId);
						assert.ok(currentSeatConnection && seatRecord?.connected && !seatRecord.revoked);
						assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: nextInput.seatId,
							connectionId: currentSeatConnection, credential: credentialFor(nextInput.seatId) },
							{ roomId, seatId: nextInput.seatId }), true, "successor must have the current ordinary-seat credential binding");
						const successorFenceTrace = nativeDiagnostic.find(entry => entry?.stage === "native_input_wait_open" &&
							entry.snapshot?.nativeInputGate?.nativeEventId === nextInput.nativeEventId &&
							entry.snapshot.nativeInputGate.seatId === nextInput.seatId);
						assert.ok(successorFenceTrace, "successor capture requires the authenticated Chromium's actual native waiting-fence trace");
						const fenceSnapshot = successorFenceTrace.snapshot;
						if (probeMode === "managed_opening_root_action_event5") {
							assert.equal(fenceSnapshot.nativeInputGate.diagnosticOnly, undefined,
								"Event #5 must use a real controller-managed gate, never a diagnostic-only gate masquerading as a player input");
							assert.equal(fenceSnapshot.nativeInputGate.waiting, true);
							assert.equal(fenceSnapshot.nativeInputGate.gameMeAbsent, true);
							assert.equal(manager.inspect(roomId)?.authorityStateRevision, 4);
							assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 5);
							assert.equal(controller.pendingCount(), 0, "pre-action capture must precede allocating the Event #5 managed choice");
						} else {
						const prepResult = prepareNextSeatChoice({
							candidate: { roomId, hostSessionId: nextSeatCandidateMessage.sessionId,
								rootInstanceId: nextSeatCandidateMessage.rootInstanceId, engineBuildId: activeContext.engineBuildId,
								seatIds: immutableServerSeatIds, nativeEventId: nextSeatCandidateMessage.nativeEventId,
								eventInstanceId: nextSeatCandidateMessage.eventInstanceId,
								parentEventInstanceId: nextSeatCandidateMessage.parentEventInstanceId,
								waitingCompletionOrdinal: nextSeatCandidateMessage.waitingCompletionOrdinal,
								eventName: nextSeatCandidateMessage.eventName, parentEventName: nextSeatActionStart.snapshot.parentEventName,
								seatId: nextSeatCandidateMessage.seatId, options: [...nextSeatCandidateMessage.options],
								optionKinds: { ...nextSeatCandidateMessage.optionKinds }, waiting: true, diagnosticOnly: true },
							authorityTip: { revision: activeContext.authorityStateRevision,
								nextSequence: activeContext.nextAuthorityEventSequence, lastSequence: activeContext.lastAuthorityEvent?.sequence,
								event5Accepted: false, checkpointAvailable: activeContext.checkpointAvailable },
							seatBinding: { roomId, seatId: nextInput.seatId, connectionId: currentSeatConnection,
								connectionGeneration: seatRecord.epoch, connected: seatRecord.connected, current: true,
								credentialAuthenticated: true, ordinaryPlayer: true },
							priorChoice: { roomId, hostSessionId: priorChoice.hostSessionId, nativeEventId: priorChoice.nativeEventId,
								seatId: priorChoice.seatId, state: priorChoice.state, deadlineActive: false, deliveryActive: false },
							managedContext: { roomId, hostSessionId: activeContext.sessionId,
								rootInstanceId: waitingSnapshot.rootInstanceId, engineBuildId: activeContext.engineBuildId,
								seatIds: immutableServerSeatIds },
							expectedNextSeatId: waitingSnapshot.nextActorSeatId, previousActorSeatId: waitingSnapshot.seatId,
							seatIds: immutableServerSeatIds, hostProcessStable: activeContext.state === "playable_probe" && activeContext.pid === nativeHostPidAtFirstCandidate,
							chromiumProcessStable: (nextHost => nextHost?.resources()[0]?.pid === nativeChromiumPidAtFirstCandidate)(launchedHandles.get(activeContext.sessionId)),
							nativeFenceEvidence: { stage: "native_input_wait_open", rootInstanceId: fenceSnapshot.rootInstanceId,
								rootObjectMatches: fenceSnapshot.rootObjectMatches,
								paused: fenceSnapshot.paused, gameMeAbsent: fenceSnapshot.hostPlayerAbsent,
								currentEventName: fenceSnapshot.currentEventName, currentEventStep: fenceSnapshot.currentEventStep,
								currentSeatId: fenceSnapshot.currentSeatId, eventStack: fenceSnapshot.eventStack,
								eventStackDetails: fenceSnapshot.eventStackDetails,
								nativeInputGate: { diagnosticOnly: fenceSnapshot.nativeInputGate.diagnosticOnly,
									eventName: fenceSnapshot.nativeInputGate.eventName, nativeEventId: fenceSnapshot.nativeInputGate.nativeEventId,
									eventInstanceId: fenceSnapshot.nativeInputGate.eventInstanceId,
									parentEventInstanceId: fenceSnapshot.nativeInputGate.parentEventInstanceId,
									waitingCompletionOrdinal: fenceSnapshot.nativeInputGate.waitingCompletionOrdinal,
									seatId: fenceSnapshot.nativeInputGate.seatId, action: fenceSnapshot.nativeInputGate.action,
									waiting: fenceSnapshot.nativeInputGate.waiting } },
						});
						assert.equal(prepResult.ok, true, `successor read-only preparation failed: ${prepResult.code}; native fence=${JSON.stringify(fenceSnapshot)}`);
						assert.equal(prepResult.preparation.connectionGeneration, seatRecord.epoch);
						assert.equal(prepResult.preparation.nativeDeliveryAllowed, false);
						assert.equal(prepResult.preparation.authoritySubmissionAllowed, false);
							nextSeatPreparation = prepResult.preparation;
						}
					assert.ok(nativePreActionCapture?.ok, "the first actor must have an independently accepted pre-action capture for successor binding");
					const successorCapture = await manager.snapshotSuccessorPreActionCapture(roomId);
					assert.equal(successorCapture.ok, true, `successor pre-action capture rejected: ${successorCapture.code}`);
					assert.equal(successorCapture.snapshot.schema, "xingbei_native_private_successor_preaction_commitment_v1");
					assert.equal(successorCapture.snapshot.roomId, roomId);
					assert.equal(successorCapture.snapshot.hostSessionId, activeContext.sessionId);
					assert.equal(successorCapture.snapshot.rootInstanceId, waitingSnapshot.rootInstanceId);
					assert.equal(successorCapture.snapshot.engineBuildId, activeContext.engineBuildId);
					assert.deepEqual(successorCapture.snapshot.seatIds, immutableServerSeatIds);
					assert.equal(successorCapture.snapshot.seatId, nextInput.seatId);
					assert.equal(successorCapture.snapshot.eventInstanceId, nextSeatCandidateMessage.eventInstanceId,
						"successor capture must be bound to the exact native event object reported by the managed Chromium");
					assert.equal(successorCapture.snapshot.nativeCompletionOrdinal, nextSeatCandidateMessage.waitingCompletionOrdinal,
						"successor capture must bind the completion ledger ordinal observed at the waiting gate");
					assert.equal(nextSeatCandidateMessage.parentEventInstanceId,
						fenceSnapshot.nativeInputGate.parentEventInstanceId, "candidate IPC must retain the native parent event instance");
					assert.equal(successorCapture.snapshot.connectionGeneration, seatRecord.epoch);
					assert.equal(successorCapture.snapshot.previousSeatId, waitingSnapshot.seatId);
					assert.notEqual(successorCapture.snapshot.nativeEventId, nativePreActionCapture.snapshot.nativeEventId);
					assert.notEqual(successorCapture.snapshot.eventInstanceId, nativePreActionCapture.snapshot.eventInstanceId);
					assert.ok(successorCapture.snapshot.nativeCompletionOrdinal > nativePreActionCapture.snapshot.nativeCompletionOrdinal);
					assert.ok(successorCapture.snapshot.candidateOptionCount > 0);
					assert.equal(successorCapture.snapshot.choiceAllocated, false);
					assert.equal(successorCapture.snapshot.nativeDeliveryAllowed, false);
					assert.equal(successorCapture.snapshot.authoritySubmissionAllowed, false);
					assert.equal(successorCapture.snapshot.authorityRevision, 4);
					assert.equal(successorCapture.snapshot.nextAuthorityEventSequence, 5);
					assert.equal(successorCapture.snapshot.checkpointAvailable, false);
					assert.notEqual(successorCapture.snapshot.stateDigest, nativePreActionCapture.snapshot.stateDigest,
						"the successor capture must reflect a different native actor/event context, not reuse the first actor preimage");
					const successorRepeat = await manager.snapshotSuccessorPreActionCapture(roomId);
					assert.equal(successorRepeat.ok, true, `stable successor gate reread rejected: ${successorRepeat.code}`);
					assert.equal(successorRepeat.snapshot.captureOrdinal, 2);
					assert.equal(successorRepeat.snapshot.nativeEventId, successorCapture.snapshot.nativeEventId);
					assert.equal(successorRepeat.snapshot.nativeCompletionOrdinal, successorCapture.snapshot.nativeCompletionOrdinal);
					assert.equal(successorRepeat.snapshot.stateDigest, successorCapture.snapshot.stateDigest);
					assert.equal(successorRepeat.snapshot.stableWithPrevious, true);
					assert.notEqual(successorRepeat.snapshot.commitment, successorCapture.snapshot.commitment,
						"ordinal-scoped commitments must not be replay-identical even when the captured state is stable");
					if (probeMode === "managed_opening_root_action_event5") {
						assert.ok(["5", "6", "7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT));
						assert.ok(event5CandidateMessage, "the authenticated Chromium must expose the next-seat native action candidates");
					assert.equal(event5CandidateMessage.nativeEventId, successorCapture.snapshot.nativeEventId);
					assert.equal(event5CandidateMessage.eventInstanceId, successorCapture.snapshot.eventInstanceId);
					assert.equal(event5CandidateMessage.seatId, successorCapture.snapshot.seatId);
					assert.equal(event5CandidateMessage.rootInstanceId, successorCapture.snapshot.rootInstanceId);
					assert.equal(controller.pendingCount(), 0, "successor pre-action commitment must precede allocation of the Event #5 choice");
					const actorConnectionId = seatSockets.get(event5CandidateMessage.seatId);
					const actorSeat = seatRegistry.inspect(roomId, event5CandidateMessage.seatId);
					assert.ok(actorConnectionId && actorSeat?.connected && !actorSeat.revoked);
					assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: event5CandidateMessage.seatId,
						connectionId: actorConnectionId, credential: credentialFor(event5CandidateMessage.seatId) },
						{ roomId, seatId: event5CandidateMessage.seatId }), true);
					if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1") {
						const projection5 = await readActionStateThroughGateway(event5CandidateMessage.seatId, 4);
						assert.equal(projection5.publicState.activeSeatId, event5CandidateMessage.seatId);
					}
					const event5Opened = controller.openChoice({ protocol: 1, roomId, hostSessionId: event5CandidateMessage.sessionId,
						nativeEventId: event5CandidateMessage.nativeEventId, seatId: event5CandidateMessage.seatId, eventSequence: 5,
						options: event5CandidateMessage.options, trusteeOption: event5CandidateMessage.trusteeOption,
						deadlineAt: Date.now() + Math.min(5000, event5CandidateMessage.deadlineMs), hostProof: event5CandidateMessage.secret });
					assert.equal(event5Opened.ok, true, `server-managed Event #5 choice registration failed: ${event5Opened.code}`);
					event5Choice = event5Opened.choice;
					const selectedEvent5Option = event5CandidateMessage.options.find(option => event5CandidateMessage.optionKinds[option] === "gongJi") ||
						event5CandidateMessage.options[0];
					assert.ok(event5CandidateMessage.options.includes(selectedEvent5Option));
					assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: event5CandidateMessage.sessionId,
						nativeEventId: event5CandidateMessage.nativeEventId, seatId: event5CandidateMessage.seatId, eventSequence: 5,
						choiceId: event5Choice.choiceId, connectionId: actorConnectionId, credential: credentialFor(event5CandidateMessage.seatId),
						option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
					const event5AckBaseline = event5NativeActionAckCount;
					const submittedEvent5 = process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1" ?
						await submitActionThroughGateway({ seatId: event5CandidateMessage.seatId, choice: event5Choice,
							option: selectedEvent5Option, expectedRevision: 4 }).then(() => ({ ok: true })) :
						controller.submitChoice({ protocol: 1, roomId, hostSessionId: event5CandidateMessage.sessionId,
							nativeEventId: event5CandidateMessage.nativeEventId, seatId: event5CandidateMessage.seatId, eventSequence: 5,
							choiceId: event5Choice.choiceId, connectionId: actorConnectionId, credential: credentialFor(event5CandidateMessage.seatId),
							option: selectedEvent5Option });
					assert.equal(submittedEvent5.ok, true, `ordinary player Event #5 choice rejected: ${submittedEvent5.code}`);
					const acceptedEvent5Session = await until(() => {
						const session = manager.inspect(roomId);
						if (session?.state === "failed") throw new Error(`Event #5 host failed: ${session.failureCode}:${JSON.stringify({ event5CaptureProgress: manager.inspectEvent5CaptureProgress(roomId),
							stages: nativeDiagnostic.slice(-16).map(entry => entry?.stage),
							proofFailures: nativeDiagnostic.filter(entry => entry?.kind === "event5_native_state_proof_rejected_v1").slice(-2).map(entry => ({ stage: entry.stage, failedChecks: entry.failedChecks })),
							handlerFailures: managedChoiceHandlerFailures.slice(-4), submissions: authoritySubmissions.map(entry => ({
								sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind, eventKeys: Object.keys(entry.proof?.event || {}).sort() })) })}`);
						return session?.authorityStateRevision === 5 && controller.inspect(roomId, event5Choice.choiceId)?.state === "resolved" ? session : null;
					}, 30000, () => ({ session: manager.inspect(roomId), choice: controller.inspect(roomId, event5Choice.choiceId),
						stages: nativeDiagnostic.slice(-20).map(entry => entry?.stage),
						phaseFences: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => ({
							boundaryOrdinal: entry.snapshot?.boundaryOrdinal ?? null, seatId: entry.snapshot?.seatId ?? null,
							eventName: entry.snapshot?.eventName ?? null, eventStep: entry.snapshot?.eventStep ?? null,
							phaseOverComplete: entry.snapshot?.phaseOverTriggerComplete === true,
							completionOrdinal: entry.snapshot?.nativeCompletionOrdinal ?? null, rootMatches: entry.snapshot?.rootObjectMatches === true })),
						event5CaptureProgress: manager.inspectEvent5CaptureProgress(roomId),
						submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence) }));
					assert.equal(acceptedEvent5Session.nextAuthorityEventSequence, 6);
					assert.equal(acceptedEvent5Session.lastAuthorityEvent.sequence, 5);
					assert.equal(acceptedEvent5Session.checkpointAvailable, false);
					assert.equal(acceptedEvent5Session.seedAuthorized, false);
					assert.deepEqual(authoritySubmissions.map(entry => entry.proof.eventSequence), [1, 2, 3, 4, 5]);
					for (let index = 0; index < authoritySubmissions.length; index++) {
						const proof = authoritySubmissions[index].proof;
						assert.equal(proof.stateRevisionBefore, index);
						assert.equal(proof.stateRevisionAfter, index + 1);
						assert.equal(proof.eventSequence, index + 1);
						if (index) assert.equal(proof.beforeDigest, authoritySubmissions[index - 1].proof.afterDigest);
						assert.ok(authoritySubmissions[index].resourcePids.length > 0 &&
							authoritySubmissions[index].resourcePids.every(pid => pid === nativeChromiumPidAtFirstCandidate),
							"every authority submission must come from the same managed Chromium resource");
					}
					const event5Proof = authoritySubmissions[4].proof;
					assert.equal(event5Proof.event.kind, "xingbei_native_successor_card_action_v1");
					assert.equal(event5Proof.event.seatId, event5CandidateMessage.seatId);
					assert.equal(event5Proof.event.nativeEventId, event5CandidateMessage.nativeEventId);
					assert.equal(event5Proof.event.rootInstanceId, event5CandidateMessage.rootInstanceId);
					assert.equal(event5Proof.event.optionId, selectedEvent5Option);
					assert.equal(event5Proof.event.connectionGeneration, actorSeat.epoch);
					assert.equal(event5Proof.event.nativeEventCompleted, true);
					assert.equal(event5Proof.event.useResultCount, 1);
					assert.equal(event5Proof.event.useCardChildCompleted, true);
					assert.equal(event5Proof.event.nativeChildWaitCompleted, true);
					assert.equal(event5Proof.event.gameMeNull, true);
					assert.equal(event5Proof.event.connectedTransports, 0);
					assert.equal(event5Proof.afterSummary.captureCommitment, manager.inspectEvent5CaptureProgress(roomId)?.postCaptureCommitment);
					assert.equal(manager.inspect(roomId).authorityStateDigest, event5Proof.afterDigest);
					assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence > 5), false);
				assert.equal(event5NativeActionAckCount, event5AckBaseline + 1,
					"the second ordinary player's native choice ACK must follow Event #5 authority acceptance");
				assert.equal(launchedHandles.get(acceptedEvent5Session.sessionId).resources()[0]?.pid, nativeChromiumPidAtFirstCandidate);
				assert.equal(acceptedEvent5Session.pid, nativeHostPidAtFirstCandidate);
				t.diagnostic(`isolated Event #5 accepted: ${JSON.stringify({ sequence: 5, revision: acceptedEvent5Session.authorityStateRevision,
					seatId: event5Proof.event.seatId, nativeEventId: event5Proof.event.nativeEventId, rootInstanceId: event5Proof.event.rootInstanceId,
					nativeCompletionOrdinal: event5Proof.event.nativeCompletionOrdinal, postFenceOrdinal: event5Proof.afterSummary.postFenceCompletionOrdinal,
					captureOrdinal: event5Proof.afterSummary.captureOrdinal, gameMeNull: event5Proof.event.gameMeNull,
					checkpointAvailable: acceptedEvent5Session.checkpointAvailable })}`);
					if (process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1") {
						assert.ok(["6", "7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT));
						event6LogStage("event5-accepted-await-candidate");
						const candidate = await until(() => event6CandidateMessage, 15000, () => ({
							session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage || entry?.observed?.stage),
							event6DispatchChecks: nativeDiagnostic.filter(entry => entry?.kind === "native_event6_candidate_dispatch_v1")
								.slice(-4).map(entry => entry.snapshot),
							successorGates: nativeDiagnostic.filter(entry => ["native_next_seat_gate_decision", "native_next_seat_gate_selected", "native_input_wait_open"].includes(entry?.stage))
								.slice(-8).map(entry => ({ stage: entry.stage, eventName: entry.snapshot?.eventName,
									seatId: entry.snapshot?.seatId || entry.snapshot?.nativeInputGate?.seatId,
									eventSequence: entry.snapshot?.nativeInputGate?.eventSequence,
									probeArmed: entry.snapshot?.nextSeatInputProbeArmed, event5Accepted: entry.snapshot?.event5AuthorityAccepted,
									event5ActorSeatId: entry.snapshot?.event5ActorSeatId,
									event5SuccessorGate: entry.snapshot?.event5SuccessorGate, event6SuccessorGate: entry.snapshot?.event6SuccessorGate,
									diagnosticNextSeatGate: entry.snapshot?.diagnosticNextSeatGate, candidateCount: entry.snapshot?.nativeInputGate?.candidates?.length })),
							phaseFences: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => ({
								boundaryOrdinal: entry.snapshot?.boundaryOrdinal, seatId: entry.snapshot?.seatId,
								completionOrdinal: entry.snapshot?.nativeCompletionOrdinal, eventStep: entry.snapshot?.eventStep })),
							handlerFailures: managedChoiceHandlerFailures.slice(-4) }));
						event6LogStage("event6-candidate-received");
						assert.equal(candidate.eventSequence, 6);
						assert.notEqual(candidate.seatId, event5CandidateMessage.seatId);
						assert.equal(candidate.rootInstanceId, event5Proof.event.rootInstanceId);
						assert.equal(manager.inspect(roomId)?.authorityStateRevision, 5);
						assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 6);
						assert.equal(controller.pendingCount(), 0);
						const e6Host = launchedHandles.get(acceptedEvent5Session.sessionId);
						assert.ok(e6Host && e6Host.pid === nativeHostPidAtFirstCandidate);
						assert.equal(e6Host.resources()[0]?.pid, nativeChromiumPidAtFirstCandidate,
							"Event #6 must stay in the same supervised Chromium process");
						const e6Seat = seatRegistry.inspect(roomId, candidate.seatId);
						const e6Connection = seatSockets.get(candidate.seatId);
						assert.ok(e6Seat?.connected && !e6Seat.revoked && e6Connection);
						assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: candidate.seatId, connectionId: e6Connection,
							credential: credentialFor(candidate.seatId) }, { roomId, seatId: candidate.seatId }), true);
					event6LogStage("pre-capture-a-start");
					event6PreActionCapture = await manager.snapshotEvent6PreActionCapture(roomId);
					event6LogStage(`pre-capture-a-result:${event6PreActionCapture?.ok ? "ok" : event6PreActionCapture?.code || "unknown"}`);
					if (!event6PreActionCapture.ok) t.diagnostic(`Event #6 pre-capture failure diagnostics: ${JSON.stringify({ progress: manager.inspectEvent6CaptureProgress(roomId), session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-12) })}`);
					assert.equal(event6PreActionCapture.ok, true, `Event #6 pre-action capture rejected: ${event6PreActionCapture.code}`);
					const firstE6Capture = event6PreActionCapture.snapshot;
					assert.equal(firstE6Capture.captureOrdinal, 1);
					assert.equal(firstE6Capture.stableWithPrevious, null);
					event6LogStage("pre-capture-b-start");
					const repeatedE6Capture = await manager.snapshotEvent6PreActionCapture(roomId);
					event6LogStage(`pre-capture-b-result:${repeatedE6Capture?.ok ? "ok" : repeatedE6Capture?.code || "unknown"}`);
					assert.equal(repeatedE6Capture.ok, true, `same-gate Event #6 recapture rejected: ${repeatedE6Capture.code}`);
					const e6Capture = repeatedE6Capture.snapshot;
					assert.equal(e6Capture.captureOrdinal, 2);
					assert.equal(e6Capture.stableWithPrevious, true);
					assert.equal(e6Capture.stateDigest, firstE6Capture.stateDigest,
						"the same native waiting gate must project a stable pre-action state");
					assert.notEqual(e6Capture.commitment, firstE6Capture.commitment,
						"capture-specific HMAC commitments must remain scoped to their ordinal");
						assert.equal(e6Capture.roomId, roomId);
						assert.equal(e6Capture.hostSessionId, acceptedEvent5Session.sessionId);
						assert.equal(e6Capture.rootInstanceId, candidate.rootInstanceId);
						assert.equal(e6Capture.engineBuildId, acceptedEvent5Session.engineBuildId);
						assert.deepEqual(e6Capture.seatIds, immutableServerSeatIds);
						assert.equal(e6Capture.nativeEventId, candidate.nativeEventId);
						assert.equal(e6Capture.eventInstanceId, candidate.eventInstanceId);
						assert.equal(e6Capture.parentEventInstanceId, candidate.parentEventInstanceId);
						assert.equal(e6Capture.seatId, candidate.seatId);
						assert.equal(e6Capture.nativeCompletionOrdinal, candidate.waitingCompletionOrdinal);
						assert.equal(e6Capture.captureOrdinal, 2,
							"the second stable read uses the next capture ordinal without changing the waiting gate");
						assert.equal(e6Capture.authoritySubmissionAllowed, false);
						assert.equal(e6Capture.checkpointAvailable, false);
						assert.notEqual(e6Capture.nativeEventId, event5Proof.event.nativeEventId);
						assert.notEqual(e6Capture.commitment, event5Proof.afterSummary.captureCommitment);
						const candidateGate = nativeDiagnostic.find(entry => entry?.stage === "native_input_wait_open" &&
							entry.snapshot?.nativeInputGate?.nativeEventId === candidate.nativeEventId);
						assert.ok(candidateGate, "Event #6 capture must bind the real native paused input gate");
						assert.equal(candidateGate.snapshot.nativeInputGate.seatId, candidate.seatId);
						assert.equal(candidateGate.snapshot.nativeInputGate.waiting, true);
						assert.equal(candidateGate.snapshot.nativeInputGate.diagnosticOnly, undefined);
						const secondActionStart = nativeDiagnostic.find(entry => entry?.stage === "native_next_seat_action_start_observed" &&
							entry.snapshot?.seatId === candidate.seatId && entry.snapshot?.eventName === "gongJiOrFaShu");
						assert.ok(secondActionStart, "Event #6 candidate must belong to the next native xingDong child");
						assert.deepEqual(secondActionStart.snapshot.quotas,
							{ gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 });
						const option = candidate.options.find(id => candidate.optionKinds[id] === "gongJi");
						assert.ok(option, "the real native Event #6 gate must expose an allowlisted, non-terminal gongJi option");
						const targetSeatId = candidate.optionTargetSeatIds[option];
						assert.ok(immutableServerSeatIds.includes(targetSeatId) && targetSeatId !== candidate.seatId);
						if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1") {
							const projection6 = await readActionStateThroughGateway(candidate.seatId, 5);
						assert.equal(projection6.publicState.activeSeatId, candidate.seatId);
						assert.notEqual(candidate.seatId, event5CandidateMessage.seatId);
						assert.equal(projection6.connectionGeneration, seatRegistry.inspect(roomId, candidate.seatId).epoch);
					}
					const opened6 = controller.openChoice({ protocol: 1, roomId, hostSessionId: candidate.sessionId,
							nativeEventId: candidate.nativeEventId, seatId: candidate.seatId, eventSequence: 6,
							options: candidate.options, trusteeOption: candidate.trusteeOption,
							deadlineAt: Date.now() + Math.min(5000, candidate.deadlineMs), hostProof: candidate.secret });
						assert.equal(opened6.ok, true, `managed Event #6 choice registration rejected: ${opened6.code}`);
						event6Choice = opened6.choice;
						const invalidSeat = setup.seats.find(seat => seat.seatId !== candidate.seatId);
						assert.ok(invalidSeat);
						assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: candidate.sessionId,
							nativeEventId: candidate.nativeEventId, seatId: invalidSeat.seatId, eventSequence: 6,
							choiceId: event6Choice.choiceId, connectionId: e6Connection, credential: credentialFor(candidate.seatId), option }).code,
							"MANAGED_CHOICE_SUBMIT_REJECTED");
						assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: candidate.sessionId,
							nativeEventId: candidate.nativeEventId, seatId: candidate.seatId, eventSequence: 6,
							choiceId: event6Choice.choiceId, connectionId: e6Connection, credential: credentialFor(candidate.seatId),
							option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
						const event6AckBaseline = event6NativeActionAckCount;
						event6LogStage("choice-submit-start");
						const submitted6 = process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1" ?
							await submitActionThroughGateway({ seatId: candidate.seatId, choice: event6Choice, option, expectedRevision: 5 }).then(() => ({ ok: true })) :
							controller.submitChoice({ protocol: 1, roomId, hostSessionId: candidate.sessionId,
								nativeEventId: candidate.nativeEventId, seatId: candidate.seatId, eventSequence: 6,
								choiceId: event6Choice.choiceId, connectionId: e6Connection, credential: credentialFor(candidate.seatId), option });
						assert.equal(submitted6.ok, true, `ordinary Event #6 seat could not submit legal native action: ${submitted6.code}`);
						event6LogStage("choice-submit-accepted-await-authority");
						const accepted6 = await until(() => {
							const session = manager.inspect(roomId);
							if (session?.state === "failed") throw new Error(`Event #6 host failed ${session.failureCode}: ${JSON.stringify({
								progress: manager.inspectEvent6CaptureProgress?.(roomId) || null,
								fences: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => ({
									boundary: entry.snapshot?.boundaryOrdinal, seatId: entry.snapshot?.seatId,
									ordinal: entry.snapshot?.nativeCompletionOrdinal })),
								stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage || entry?.observed?.stage),
								handlerFailures: managedChoiceHandlerFailures.slice(-4), submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence) })}`);
							return session?.authorityStateRevision === 6 && session?.nextAuthorityEventSequence === 7 &&
								session?.lastAuthorityEvent?.sequence === 6 && controller.inspect(roomId, event6Choice.choiceId)?.state === "resolved" ? session : null;
						}, 30000, () => ({ session: manager.inspect(roomId), choice: controller.inspect(roomId, event6Choice.choiceId),
							stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage || entry?.observed?.stage),
							fences: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => ({
								boundary: entry.snapshot?.boundaryOrdinal, seatId: entry.snapshot?.seatId,
								ordinal: entry.snapshot?.nativeCompletionOrdinal, step: entry.snapshot?.eventStep })),
							submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence) }));
						assert.deepEqual(authoritySubmissions.map(entry => entry.proof.eventSequence), [1, 2, 3, 4, 5, 6]);
						for (let index = 0; index < authoritySubmissions.length; index++) {
							const proof = authoritySubmissions[index].proof;
							assert.equal(proof.stateRevisionBefore, index);
							assert.equal(proof.stateRevisionAfter, index + 1);
							assert.equal(proof.eventSequence, index + 1);
							if (index) assert.equal(proof.beforeDigest, authoritySubmissions[index - 1].proof.afterDigest);
							assert.ok(authoritySubmissions[index].resourcePids.length > 0 &&
								authoritySubmissions[index].resourcePids.every(pid => pid === nativeChromiumPidAtFirstCandidate));
						}
						const proof6 = authoritySubmissions[5].proof;
						assert.equal(proof6.event.kind, "xingbei_native_successor_card_action_v2");
						assert.equal(proof6.event.seatId, candidate.seatId);
						assert.equal(proof6.event.nativeEventId, candidate.nativeEventId);
						assert.equal(proof6.event.optionId, option);
						assert.equal(proof6.event.cardKind, "gongJi");
						assert.equal(proof6.event.targetSeatId, targetSeatId);
						assert.equal(proof6.event.nativeEventCompleted, true);
						assert.equal(proof6.event.useResultCount, 1);
						assert.equal(proof6.event.useCardChildCompleted, true);
						assert.equal(proof6.event.nativeChildWaitCompleted, true);
						assert.equal(proof6.event.gameMeNull, true);
						assert.equal(proof6.event.connectedTransports, 0);
						assert.equal(proof6.event.connectionGeneration, e6Seat.epoch);
						const event6Progress = manager.inspectEvent6CaptureProgress(roomId);
						assert.equal(event6Progress?.accepted, true);
						assert.equal(event6Progress?.preCaptureOrdinal, 2);
						assert.equal(proof6.afterSummary.captureCommitment, event6Progress?.postCaptureCommitment);
						assert.ok(event6Progress.postCaptureOrdinal > e6Capture.captureOrdinal);
						assert.equal(event6Progress.boundaryOrdinal, 3);
						assert.equal(event6NativeActionAckCount, event6AckBaseline + 1,
							"Event #6 success ACK must follow host acceptance of the complete native event proof");
						assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence > 6), false, "Event #7 remains closed");
						event6LogStage("authority-event6-accepted");
						assert.equal(manager.inspect(roomId)?.authorityStateRevision, 6);
						assert.equal(manager.inspect(roomId)?.checkpointAvailable, false);
						assert.equal(manager.inspect(roomId)?.seedAuthorized, false);
						assert.equal(manager.inspect(roomId)?.pid, nativeHostPidAtFirstCandidate);
						assert.equal(e6Host.resources()[0]?.pid, nativeChromiumPidAtFirstCandidate);
						assert.ok(event6PostCaptureObserved || nativeDiagnostic.some(entry => entry?.stage === "native_successor_card_action_event_6_accepted"));
					t.diagnostic(`isolated Event #6 accepted: ${JSON.stringify({ sequence: 6, revision: accepted6.authorityStateRevision,
							seatId: proof6.event.seatId, nativeEventId: proof6.event.nativeEventId, rootInstanceId: proof6.event.rootInstanceId,
						actionCompletionOrdinal: proof6.event.nativeCompletionOrdinal,
						postFenceOrdinal: proof6.afterSummary.postFenceCompletionOrdinal, captureOrdinal: proof6.afterSummary.captureOrdinal,
						gameMeNull: proof6.event.gameMeNull, checkpointAvailable: accepted6.checkpointAvailable })}`);
						if (process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1") {
							assert.ok(["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT));
						const candidate7 = await until(() => event7CandidateMessage, 20000, () => ({
								session: manager.inspect(roomId), stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage || entry?.observed?.stage),
								event7GateDecisions: nativeDiagnostic.filter(entry => entry?.stage === "event7_successor_gate_decision").slice(-8).map(entry => ({
									eventName: entry.snapshot?.eventName, eventStep: entry.snapshot?.eventStep, seatId: entry.snapshot?.seatId,
									eventSequence: entry.snapshot?.eventSequence, event6AuthorityAccepted: entry.snapshot?.event6AuthorityAccepted,
									event6ActorPresent: typeof entry.snapshot?.event6ActorSeatId === "string",
									nextSeatInputProbeArmed: entry.snapshot?.nextSeatInputProbeArmed,
									event7ManagedGateOpened: entry.snapshot?.event7ManagedGateOpened, event7Continuation: entry.snapshot?.event7Continuation,
									gateSelected: entry.snapshot?.gateSelected, rootObjectMatches: entry.snapshot?.rootObjectMatches,
									gameMeAbsent: entry.snapshot?.gameMeAbsent })),
								fences: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => ({
									boundary: entry.snapshot?.boundaryOrdinal, seatId: entry.snapshot?.seatId, ordinal: entry.snapshot?.nativeCompletionOrdinal })),
								handlerFailures: managedChoiceHandlerFailures.slice(-4) }));
							assert.equal(candidate7.eventSequence, 7);
							assert.notEqual(candidate7.seatId, event6CandidateMessage.seatId);
							assert.equal(candidate7.rootInstanceId, proof6.event.rootInstanceId);
							assert.equal(manager.inspect(roomId)?.authorityStateRevision, 6);
							assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 7);
							assert.equal(controller.pendingCount(), 0);
							const e7CaptureFirst = await manager.snapshotEvent7PreActionCapture(roomId);
						assert.equal(e7CaptureFirst.ok, true, `Event #7 pre-action capture rejected: ${e7CaptureFirst.code}`);
						const e7CaptureRepeat = await manager.snapshotEvent7PreActionCapture(roomId);
						assert.equal(e7CaptureRepeat.ok, true, `Event #7 stable pre-action capture rejected: ${e7CaptureRepeat.code}`);
						assert.equal(e7CaptureRepeat.snapshot.captureOrdinal, 2);
						assert.equal(e7CaptureRepeat.snapshot.stableWithPrevious, true);
						assert.equal(e7CaptureRepeat.snapshot.stateDigest, e7CaptureFirst.snapshot.stateDigest);
						assert.equal(e7CaptureRepeat.snapshot.nativeEventId, candidate7.nativeEventId);
						assert.equal(e7CaptureRepeat.snapshot.seatId, candidate7.seatId);
						assert.equal(e7CaptureRepeat.snapshot.authoritySubmissionAllowed, false);
						const e7Connection = seatSockets.get(candidate7.seatId);
						assert.ok(e7Connection && seatRegistry.authenticateSeat({ roomId, seatId: candidate7.seatId,
							connectionId: e7Connection, credential: credentialFor(candidate7.seatId) }, { roomId, seatId: candidate7.seatId }));
						const e7Option = candidate7.options.find(id => candidate7.optionKinds[id] === "gongJi");
						assert.ok(e7Option, "Event #7 must expose a native, non-terminal gongJi candidate");
						if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1") {
							const projection7 = await readActionStateThroughGateway(candidate7.seatId, 6);
						assert.equal(projection7.publicState.activeSeatId, candidate7.seatId);
						assert.ok(![event5CandidateMessage.seatId, event6CandidateMessage.seatId].includes(candidate7.seatId));
						assert.equal(projection7.connectionGeneration, seatRegistry.inspect(roomId, candidate7.seatId).epoch);
					}
					const opened7 = controller.openChoice({ protocol: 1, roomId, hostSessionId: candidate7.sessionId,
							nativeEventId: candidate7.nativeEventId, seatId: candidate7.seatId, eventSequence: 7,
							options: candidate7.options, trusteeOption: candidate7.trusteeOption,
							deadlineAt: Date.now() + Math.min(5000, candidate7.deadlineMs), hostProof: candidate7.secret });
						assert.equal(opened7.ok, true, `Event #7 choice open rejected: ${opened7.code}`);
						event7Choice = opened7.choice;
						assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: candidate7.sessionId,
							nativeEventId: candidate7.nativeEventId, seatId: candidate7.seatId, eventSequence: 7,
							choiceId: event7Choice.choiceId, connectionId: e7Connection, credential: credentialFor(candidate7.seatId),
							option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
						const e7AckBaseline = event7NativeActionAckCount;
						const submitted7 = process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1" ?
							await submitActionThroughGateway({ seatId: candidate7.seatId, choice: event7Choice, option: e7Option, expectedRevision: 6 }).then(() => ({ ok: true })) :
							controller.submitChoice({ protocol: 1, roomId, hostSessionId: candidate7.sessionId,
								nativeEventId: candidate7.nativeEventId, seatId: candidate7.seatId, eventSequence: 7,
								choiceId: event7Choice.choiceId, connectionId: e7Connection, credential: credentialFor(candidate7.seatId), option: e7Option });
						assert.equal(submitted7.ok, true, `Event #7 ordinary seat selection rejected: ${submitted7.code}`);
						const accepted7 = await until(() => {
							const session = manager.inspect(roomId);
							if (session?.state === "failed") throw new Error(`Event #7 host failed ${session.failureCode}: ${JSON.stringify({
								progress: manager.inspectEvent7CaptureProgress(roomId), stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage),
								submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence), handlerFailures: managedChoiceHandlerFailures.slice(-3) })}`);
							return session?.authorityStateRevision === 7 && session?.nextAuthorityEventSequence === 8 &&
								session?.lastAuthorityEvent?.sequence === 7 && controller.inspect(roomId, event7Choice.choiceId)?.state === "resolved" ? session : null;
						}, 30000, () => ({ session: manager.inspect(roomId), progress: manager.inspectEvent7CaptureProgress(roomId),
							stages: nativeDiagnostic.slice(-24).map(entry => entry?.stage), submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence) }));
						assert.deepEqual(authoritySubmissions.map(entry => entry.proof.eventSequence), [1, 2, 3, 4, 5, 6, 7]);
						const proof7 = authoritySubmissions[6].proof;
						assert.equal(proof7.event.kind, "xingbei_native_successor_card_action_v3");
						assert.equal(proof7.event.seatId, candidate7.seatId);
						assert.equal(proof7.event.nativeEventId, candidate7.nativeEventId);
						assert.equal(proof7.event.optionId, e7Option);
						assert.equal(proof7.event.cardKind, "gongJi");
						assert.equal(proof7.event.nativeEventCompleted, true);
						assert.equal(proof7.event.useCardChildCompleted, true);
						assert.equal(proof7.event.nativeChildWaitCompleted, true);
						assert.equal(proof7.event.gameMeNull, true);
						assert.equal(proof7.event.connectedTransports, 0);
						assert.equal(proof7.beforeDigest, proof6.afterDigest);
						assert.equal(proof7.stateRevisionBefore, 6);
						assert.equal(proof7.stateRevisionAfter, 7);
						assert.equal(proof7.afterSummary.captureOrdinal, manager.inspectEvent7CaptureProgress(roomId)?.postCaptureOrdinal);
						assert.equal(manager.inspectEvent7CaptureProgress(roomId)?.boundaryOrdinal, 4);
						assert.equal(event7NativeActionAckCount, e7AckBaseline + 1);
						assert.equal(accepted7.checkpointAvailable, false);
						assert.equal(accepted7.seedAuthorized, false);
						assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence > 7), false, "Event #8 remains closed until Linux Event #7 acceptance");
						assert.equal(launchedHandles.get(accepted7.sessionId).resources()[0]?.pid, nativeChromiumPidAtFirstCandidate);
						t.diagnostic(`isolated Event #7 accepted: ${JSON.stringify({ sequence: 7, revision: accepted7.authorityStateRevision,
							seatId: proof7.event.seatId, nativeEventId: proof7.event.nativeEventId, rootInstanceId: proof7.event.rootInstanceId,
							actionCompletionOrdinal: proof7.event.nativeCompletionOrdinal, postFenceOrdinal: proof7.afterSummary.postFenceCompletionOrdinal,
							captureOrdinal: proof7.afterSummary.captureOrdinal, boundaryOrdinal: 4, gameMeNull: proof7.event.gameMeNull })}`);
						if (process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") {
							assert.equal(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT, "8");
							const candidate8 = await until(() => event8CandidateMessage, 20000, () => ({
								session: manager.inspect(roomId),
								stages: nativeDiagnostic.slice(-32).map(entry => entry?.stage || entry?.observed?.stage),
								fences: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").slice(-4)
									.map(entry => ({ boundary: entry.snapshot?.boundaryOrdinal, seatId: entry.snapshot?.seatId,
										ordinal: entry.snapshot?.nativeCompletionOrdinal })),
								handlerFailures: managedChoiceHandlerFailures.slice(-4) }));
							assert.equal(candidate8.eventSequence, 8);
							assert.notEqual(candidate8.seatId, candidate7.seatId);
							assert.notEqual(candidate8.nativeEventId, candidate7.nativeEventId);
							assert.equal(candidate8.rootInstanceId, proof7.event.rootInstanceId);
							assert.equal(manager.inspect(roomId)?.authorityStateRevision, 7);
							assert.equal(manager.inspect(roomId)?.nextAuthorityEventSequence, 8);
							assert.equal(controller.pendingCount(), 0);
							if (process.env.V2_V3_CAPPED_STATE_WEBSOCKET_PROBE === "1") {
								const reconnect = await reconnectDuringManagedGame(candidate8.seatId);
								assert.equal(reconnect.hostSessionId, candidate8.sessionId);
								assert.equal(reconnect.rootInstanceId, candidate8.rootInstanceId);
								assert.equal(manager.inspect(roomId)?.authorityStateRevision, 7,
									"active actor transport loss/rebind cannot advance or reset authority state");
								assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: candidate8.seatId,
									connectionId: seatSockets.get(candidate8.seatId), credential: credentialFor(candidate8.seatId) },
								{ roomId, seatId: candidate8.seatId }), true,
								"current native actor must be rebound to its current authenticated generation before choice delivery");
								t.diagnostic(`active ordinary actor safely disconnected/rebound at native input: ${JSON.stringify(reconnect)}`);
							}
							const e8CaptureFirst = await manager.snapshotEvent8PreActionCapture(roomId);
							assert.equal(e8CaptureFirst.ok, true, `Event #8 pre-action capture rejected: ${e8CaptureFirst.code}`);
							if (process.env.V2_V3_CAPPED_STATE_WEBSOCKET_PROBE === "1") {
								assert.equal(manager.inspectV3ExperimentalActionCapability(roomId)?.activeSeatId, candidate8.seatId,
									"the trusted binding refresh must preserve the same native actor capability after capture acceptance");
								assert.equal(e8CaptureFirst.snapshot.connectionGeneration, seatRegistry.inspect(roomId, candidate8.seatId).epoch,
									"the new pre-action commitment must bind the current authenticated generation");
							}
							const e8CaptureRepeat = await manager.snapshotEvent8PreActionCapture(roomId);
							assert.equal(e8CaptureRepeat.ok, true, `Event #8 stable pre-action capture rejected: ${e8CaptureRepeat.code}`);
							assert.equal(e8CaptureFirst.snapshot.captureOrdinal, 1);
							assert.equal(e8CaptureRepeat.snapshot.captureOrdinal, 2);
							assert.equal(e8CaptureRepeat.snapshot.stableWithPrevious, true);
							assert.equal(e8CaptureRepeat.snapshot.stateDigest, e8CaptureFirst.snapshot.stateDigest);
							assert.equal(e8CaptureFirst.snapshot.nativeEventId, candidate8.nativeEventId);
							assert.equal(e8CaptureFirst.snapshot.seatId, candidate8.seatId);
							assert.equal(e8CaptureFirst.snapshot.authoritySubmissionAllowed, false);
							const e8Connection = seatSockets.get(candidate8.seatId);
							assert.ok(e8Connection && seatRegistry.authenticateSeat({ roomId, seatId: candidate8.seatId,
								connectionId: e8Connection, credential: credentialFor(candidate8.seatId) }, { roomId, seatId: candidate8.seatId }));
						const e8Option = candidate8.options.find(id => candidate8.optionKinds[id] === "gongJi");
						assert.ok(e8Option, "Event #8 must expose a legal native gongJi candidate");
						if (process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1") {
							const projection8 = await readActionStateThroughGateway(candidate8.seatId, 7);
						assert.equal(projection8.publicState.activeSeatId, candidate8.seatId);
						assert.ok(![event5CandidateMessage.seatId, event6CandidateMessage.seatId, event7CandidateMessage.seatId].includes(candidate8.seatId));
						assert.equal(projection8.connectionGeneration, seatRegistry.inspect(roomId, candidate8.seatId).epoch);
					}
					const opened8 = controller.openChoice({ protocol: 1, roomId, hostSessionId: candidate8.sessionId,
								nativeEventId: candidate8.nativeEventId, seatId: candidate8.seatId, eventSequence: 8,
								options: candidate8.options, trusteeOption: candidate8.trusteeOption,
								deadlineAt: Date.now() + Math.min(5000, candidate8.deadlineMs), hostProof: candidate8.secret });
							assert.equal(opened8.ok, true, `Event #8 choice open rejected: ${opened8.code}`);
							event8Choice = opened8.choice;
							const e8AckBaseline = event8NativeActionAckCount;
							const submitted8 = process.env.V2_V3_WEBSOCKET_ACTION_PROBE === "1" ?
								await submitActionThroughGateway({ seatId: candidate8.seatId, choice: event8Choice, option: e8Option, expectedRevision: 7 }).then(() => ({ ok: true })) :
								controller.submitChoice({ protocol: 1, roomId, hostSessionId: candidate8.sessionId,
									nativeEventId: candidate8.nativeEventId, seatId: candidate8.seatId, eventSequence: 8,
									choiceId: event8Choice.choiceId, connectionId: e8Connection, credential: credentialFor(candidate8.seatId), option: e8Option });
							assert.equal(submitted8.ok, true, `Event #8 ordinary seat selection rejected: ${submitted8.code}`);
							const accepted8 = await until(() => {
								const session = manager.inspect(roomId);
								if (session?.state === "failed") throw new Error(`Event #8 host failed ${session.failureCode}: ${JSON.stringify({
									authorityFailureReason: session.authorityFailureReason || null,
									proof8Provenance: authoritySubmissions[7]?.proof ? {
										eventCompletionOrdinal: authoritySubmissions[7].proof.event.nativeCompletionOrdinal,
										waitingCompletionOrdinal: candidate8.waitingCompletionOrdinal,
										captureCompletionOrdinal: manager.inspectEvent8CaptureProgress(roomId)?.preCaptureNativeCompletionOrdinal ?? null,
										eventInstanceMatches: authoritySubmissions[7].proof.event.actionEventInstanceId === candidate8.eventInstanceId,
										parentInstanceMatches: authoritySubmissions[7].proof.event.actionParentEventInstanceId === candidate8.parentEventInstanceId,
										connectionGeneration: authoritySubmissions[7].proof.event.connectionGeneration,
										candidateGeneration: candidate8.connectionGeneration,
									} : null,
									progress: manager.inspectEvent8CaptureProgress(roomId),
									stages: nativeDiagnostic.slice(-32).map(entry => entry?.stage),
									submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence),
									handlerFailures: managedChoiceHandlerFailures.slice(-4) })}`);
								return session?.authorityStateRevision === 8 && session?.nextAuthorityEventSequence === 9 &&
									session?.lastAuthorityEvent?.sequence === 8 && controller.inspect(roomId, event8Choice.choiceId)?.state === "resolved" ? session : null;
							}, 30000, () => ({ session: manager.inspect(roomId), progress: manager.inspectEvent8CaptureProgress(roomId),
								stages: nativeDiagnostic.slice(-32).map(entry => entry?.stage),
								submissions: authoritySubmissions.map(entry => entry.proof?.eventSequence) }));
							assert.deepEqual(authoritySubmissions.map(entry => entry.proof.eventSequence), [1, 2, 3, 4, 5, 6, 7, 8]);
							const proof8 = authoritySubmissions[7].proof;
							assert.equal(proof8.event.kind, "xingbei_native_successor_card_action_v4");
							assert.equal(proof8.event.seatId, candidate8.seatId);
							assert.equal(proof8.event.nativeEventId, candidate8.nativeEventId);
							assert.equal(proof8.event.optionId, e8Option);
							assert.equal(proof8.event.cardKind, "gongJi");
							assert.equal(proof8.event.nativeEventCompleted, true);
							assert.equal(proof8.event.useCardChildCompleted, true);
							assert.equal(proof8.event.nativeChildWaitCompleted, true);
							assert.equal(proof8.event.gameMeNull, true);
							assert.equal(proof8.beforeDigest, proof7.afterDigest);
							assert.equal(proof8.stateRevisionBefore, 7);
							assert.equal(proof8.stateRevisionAfter, 8);
							assert.equal(proof8.eventSequence, 8);
							const progress8 = manager.inspectEvent8CaptureProgress(roomId);
							assert.equal(progress8?.accepted, true);
							assert.equal(progress8?.preCaptureOrdinal, 2);
							assert.equal(progress8?.boundaryOrdinal, 5);
							assert.equal(proof8.afterSummary.captureCommitment, progress8?.postCaptureCommitment);
							assert.equal(event8NativeActionAckCount, e8AckBaseline + 1);
							assert.equal(accepted8.authorityStateRevision, 8);
							assert.equal(accepted8.nextAuthorityEventSequence, 9);
							assert.equal(accepted8.checkpointAvailable, false);
							assert.equal(accepted8.seedAuthorized, false);
							assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence > 8), false, "Event #9 remains closed");
							const duplicate8 = manager.commitAuthorityEvent({ type: "host_authority_event", kind: "managed_host", protocol: 1, roomId,
								sessionId: accepted8.sessionId, secret: sessionSecret, proof: proof8 });
							assert.equal(duplicate8.ok, true, `exact Event #8 replay rejected: ${duplicate8.code || "unknown"}; revision=${manager.inspect(roomId)?.authorityStateRevision}; next=${manager.inspect(roomId)?.nextAuthorityEventSequence}; last=${manager.inspect(roomId)?.lastAuthorityEvent?.sequence}`);
							assert.equal(duplicate8.idempotent, true);
							assert.equal(manager.inspect(roomId)?.authorityStateRevision, 8,
								"an exact Event #8 retry must not advance revision or apply the native action twice");
							assert.equal(launchedHandles.get(accepted8.sessionId).resources()[0]?.pid, nativeChromiumPidAtFirstCandidate);
							t.diagnostic(`isolated Event #8 accepted: ${JSON.stringify({ sequence: 8, revision: accepted8.authorityStateRevision,
					seatId: proof8.event.seatId, nativeEventId: proof8.event.nativeEventId, rootInstanceId: proof8.event.rootInstanceId,
					actionCompletionOrdinal: proof8.event.nativeCompletionOrdinal, postFenceOrdinal: proof8.afterSummary.postFenceCompletionOrdinal,
					captureOrdinal: proof8.afterSummary.captureOrdinal, boundaryOrdinal: 5, gameMeNull: proof8.event.gameMeNull })}`);
				if (process.env.V2_V3_CAPPED_STATE_WEBSOCKET_PROBE === "1") {
					assert.equal(manager.inspect(roomId).authorityStateRevision, 8);
					assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 9);
					assert.ok(seatStateGateway && actionGatewaySockets.size === 4,
						"the capped view must use the same loopback gateway and four ordinary-seat WebSockets");
					for (const seatId of immutableServerSeatIds) {
						const socket = actionGatewaySockets.get(seatId);
						assert.ok(socket && seatRegistry.inspect(roomId, seatId).connected);
						const sequence = actionGatewayStateSequences.get(seatId) || 0;
						let received = receiveWebSocketMessage(socket);
						socket.send(JSON.stringify({ type: "state_read", requestId: `cap8_${seatId}`, lastSeenSequence: sequence }));
						const view = await received;
						assert.equal(validateCappedReadOnlySeatState(view, { roomId, seatId,
							connectionGeneration: seatRegistry.inspect(roomId, seatId).epoch }).ok, true,
							`Event 8 capped state rejected for ${seatId}: ${JSON.stringify(view)}`);
						assert.equal(view.authorityRevision, 8);
						assert.equal(view.lastAcceptedEventSequence, 8);
						assert.equal(view.nextAuthorityEventSequence, 9);
						assert.equal(view.gameTerminal, false);
						assert.equal(view.gameplayEnabled, false);
						assert.equal(view.projectionStatus, "verified_capture_payload_unavailable");
						for (const secret of [sessionSecret, ...seatCredentials.values()]) assert.equal(JSON.stringify(view).includes(secret), false);
						assert.equal(JSON.stringify(view).includes(manager.inspect(roomId).sessionId), false);
						received = receiveWebSocketMessage(socket);
						socket.send(JSON.stringify({ type: "state_ack", stateSequence: view.stateSequence }));
						assert.equal((await received).type, "transport_acknowledged");
						actionGatewayStateSequences.set(seatId, view.stateSequence);
					}
					const actor = actionGatewaySockets.get(immutableServerSeatIds[0]);
					let received = receiveWebSocketMessage(actor);
					actor.send(JSON.stringify({ type: "choice_read", requestId: "cap8_no_choice" }));
					assert.deepEqual(await received, { type: "managed_choice_unavailable", requestId: "cap8_no_choice" });
					for (const type of ["choice_submit", "native_command", "authority_event"]) {
						received = receiveWebSocketMessage(actor);
						actor.send(JSON.stringify({ type, eventSequence: 9, choiceId: "forged", optionId: "forged" }));
						assert.equal((await received).type, "gateway_error", `${type} must remain disabled beyond the Event 8 ceiling`);
					}
					assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence === 9), false);
					assert.equal(manager.inspect(roomId).authorityStateRevision, 8);
					assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 9);
					assert.equal(manager.inspect(roomId).checkpointAvailable, false);
					t.diagnostic("Event 8 post-phaseOver capture serves four authenticated read-only seat envelopes; Event 9 action and submission remain rejected");
				}
				if (lifecycleE2E) {
					const hostAtStop = manager.inspect(roomId);
					const gatewayAtStop = seatStateGateway?.inspect();
					assert.ok(gatewayAtStop && gatewayAtStop.clientCount === 4,
						"the lifecycle-owned Gateway must still own all four authenticated player sockets before stopRoom");
					const stoppedRoom = await lifecycleCoordinator.stopRoom(roomId, "chromium_room_e2e_complete");
					assert.equal(stoppedRoom.ok, true);
					assert.equal(lifecycleCoordinator.inspect(roomId)?.state, "closed");
					assert.equal(lifecycleCoordinator.inspect(roomId)?.hostSessionId, hostAtStop.sessionId);
					assert.equal(seatStateGateway.inspect().closed, true);
					assert.equal(seatStateGateway.inspect().clientCount, 0);
					assert.equal(seatStateGateway.inspect().connectionCount, 0);
					assert.equal(seatStateGateway.inspect().bufferedMessages, 0);
					for (const seatId of immutableServerSeatIds) assert.equal(seatRegistry.inspect(roomId, seatId), null);
					assert.equal(controller.pendingCount(), 0);
					const stoppedHost = manager.inspect(roomId);
					assert.equal(stoppedHost?.state, "stopped");
					const stoppedHandle = launchedHandles.get(hostAtStop.sessionId);
					assert.ok(stoppedHandle);
					await stoppedHandle.waitForCleanup();
					assert.equal(stoppedHandle.resources().length, 0, "stopRoom must reap the managed Chromium and temporary profile");
					assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence > 8), false);
					event6LogStage("room-stop-complete");
					t.diagnostic("real Chromium room lifecycle stopped through stopRoom: Gateway, four seat bindings, choice state, Chromium and profile are cleared");
				}
						}
						}
						return;
					}
				return;
				}
					if (process.env.V2_V3_SEAT_STATE_PROJECTION_PROBE === "1") {
						const views = new Map();
						for (const seatId of immutableServerSeatIds) {
							const connectionId = seatSockets.get(seatId);
							assert.ok(connectionId, `seat ${seatId} must have a current registry connection`);
							const view = manager.createV3SeatStateForRequest(roomId, { recipientSeatId: seatId,
								request: { connectionId, credential: credentialFor(seatId) } });
							assert.equal(view.ok, true, `authenticated seat projection failed for ${seatId}: ${view.code}`);
							assert.equal(validateSeatStateMessage(view.message, { roomId, seatId, connectionGeneration: seatRegistry.inspect(roomId, seatId).epoch,
								seatIds: immutableServerSeatIds }).ok, true);
							assert.equal(view.message.pendingChoice, null, "diagnostic input gate is not a fabricated managed choice");
							assert.equal(view.message.publicState.activeSeatId, nextInput.seatId);
							assert.equal(view.message.publicState.phase, "xingDong");
							assert.equal(view.message.stateSequence, 1);
							assert.deepEqual(view.message.publicState.players.map(player => player.seatId), immutableServerSeatIds);
							const encoded = JSON.stringify(view.message);
							for (const secret of [sessionSecret, ...seatCredentials.values()]) assert.equal(encoded.includes(secret), false);
							assert.equal(encoded.includes("hostSessionId"), false);
							assert.equal(encoded.includes("stateDigest"), false);
							assert.equal(encoded.includes('"cardId"'), false);
							assert.equal(encoded.includes('"name":"gongJi"'), false);
							views.set(seatId, view.message);
						}
						for (const [seatId, view] of views) {
							assert.equal(view.privateState.seatId, seatId);
							for (const [otherSeatId, other] of views) if (otherSeatId !== seatId) {
								assert.notDeepEqual(view.privateState.handCardViewIds, other.privateState.handCardViewIds,
									"recipient private projection must not reuse another seat's opaque card view IDs");
							}
						}
					const seatAConnection = seatSockets.get(immutableServerSeatIds[0]);
					assert.equal(manager.createV3SeatStateForRequest(roomId, { recipientSeatId: immutableServerSeatIds[1],
						request: { connectionId: seatAConnection, credential: credentialFor(immutableServerSeatIds[0]) } }).code,
						"V3_SEAT_STATE_RECIPIENT_REJECTED", "a different ordinary seat cannot request another seat's private view");
					assert.equal(manager.createV3SeatStateForRequest(roomId, { recipientSeatId: immutableServerSeatIds[0],
						request: { connectionId: seatAConnection, credential: "0".repeat(64) } }).code,
						"V3_SEAT_STATE_RECIPIENT_REJECTED", "invalid seat credentials cannot receive a private view");
					const oldGeneration = seatRegistry.inspect(roomId, immutableServerSeatIds[0]).epoch;
					assert.equal(bindSeat(immutableServerSeatIds[0], "projection_rebind_seat_a").ok, true);
					assert.equal(seatRegistry.inspect(roomId, immutableServerSeatIds[0]).epoch, oldGeneration + 1);
					assert.equal(manager.createV3SeatStateForRequest(roomId, { recipientSeatId: immutableServerSeatIds[0],
						request: { connectionId: seatAConnection, credential: credentialFor(immutableServerSeatIds[0]) } }).code,
						"V3_SEAT_STATE_RECIPIENT_REJECTED", "old connection generation cannot read a newer seat view");
					const reboundView = manager.createV3SeatStateForRequest(roomId, { recipientSeatId: immutableServerSeatIds[0],
						request: { connectionId: "projection_rebind_seat_a", credential: credentialFor(immutableServerSeatIds[0]) } });
					assert.equal(reboundView.ok, true);
					assert.equal(reboundView.message.connectionGeneration, oldGeneration + 1);
					assert.equal(reboundView.message.stateSequence, 2);
					}
					if (process.env.V2_V3_SEAT_STATE_WEBSOCKET_PROBE === "1") {
						const WebSocket = require("ws");
						assert.ok(seatRegistry, "the loopback gateway requires the ordinary-player Seat Registry");
						const gatewayHost = manager.inspect(roomId);
						const gatewayHandle = launchedHandles.get(gatewayHost.sessionId);
						const gatewayChromiumPid = gatewayHandle?.resources()[0]?.pid;
						assert.ok(gatewayChromiumPid > 0);
						for (const seatId of immutableServerSeatIds) {
							const priorConnection = seatSockets.get(seatId);
							if (priorConnection) {
								assert.equal(seatRegistry.disconnect({ roomId, seatId, connectionId: priorConnection }), true);
								seatSockets.delete(seatId);
							}
						}
					seatStateGateway = createManagedV3SeatStateWebSocketGateway({
						WebSocketServer: WebSocket.Server, roomId, seatIds: immutableServerSeatIds,
						hostSessionId: gatewayHost.sessionId, engineBuildId: gatewayHost.engineBuildId,
						rootInstanceId: successorCapture.snapshot.rootInstanceId, hostPid: gatewayHost.pid,
						hostSessionManager: manager, seatRegistry,
						bindSeat: ({ roomId: candidateRoom, seatId, credential, connectionId }) => {
							const binding = seatRegistry.bindConnection({ roomId: candidateRoom, seatId, credential,
								socket: { kind: "player", roomId: candidateRoom, seatId, connectionId } });
							if (binding) seatSockets.set(seatId, connectionId);
							return binding;
						},
						disconnectSeat: ({ roomId: candidateRoom, seatId, connectionId }) => {
							seatRegistry.disconnect({ roomId: candidateRoom, seatId, connectionId });
							if (seatSockets.get(seatId) === connectionId) seatSockets.delete(seatId);
						},
					});
					const gatewayAddress = await seatStateGateway.listen();
					assert.equal(gatewayAddress.host, "127.0.0.1", "test gateway must bind loopback only");
					assert.match(gatewayAddress.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
					const sockets = new Map(), views = new Map(), generations = new Map();
					for (const seatId of immutableServerSeatIds) {
						const socket = await connectWebSocket(WebSocket, gatewayAddress.url);
						sockets.set(seatId, socket);
						const authenticated = receiveWebSocketMessage(socket);
						socket.send(JSON.stringify({ type: "seat_auth", roomId, seatId, credential: credentialFor(seatId) }));
						const auth = await authenticated;
						const currentGeneration = seatRegistry.inspect(roomId, seatId).epoch;
						assert.deepEqual(auth, { type: "seat_authenticated", roomId, seatId, connectionGeneration: currentGeneration });
						generations.set(seatId, currentGeneration);
						const response = receiveWebSocketMessage(socket);
						socket.send(JSON.stringify({ type: "state_read", requestId: `initial_${seatId}`, lastSeenSequence: 0 }));
						const view = await response;
						assert.equal(validateSeatStateMessage(view, { roomId, seatId, connectionGeneration: currentGeneration,
							seatIds: immutableServerSeatIds }).ok, true);
						assert.equal(view.stateSequence, 1);
						assert.equal(view.replayFromSequence, 0);
						assert.equal(view.pendingChoice, null, "the second-seat diagnostic waiting gate is not a managed choice");
						assert.equal(view.publicState.activeSeatId, nextInput.seatId);
						assert.equal(view.publicState.phase, "xingDong");
						assert.deepEqual(view.publicState.players.map(player => player.seatId), immutableServerSeatIds);
						assert.equal(view.privateState.seatId, seatId);
						assert.equal(view.privateState.handCardViewIds.length,
							view.publicState.players.find(player => player.seatId === seatId).handCount,
							"private opaque hand IDs must match only this recipient's public hand count");
						assert.ok(view.privateState.handCardViewIds.every(id => /^[A-Za-z0-9_-]{16,96}$/.test(id)));
						const encoded = JSON.stringify(view);
						for (const secret of [sessionSecret, ...seatCredentials.values()]) assert.equal(encoded.includes(secret), false);
						assert.equal(encoded.includes(gatewayHost.sessionId), false);
						assert.equal(encoded.includes(successorCapture.snapshot.stateDigest), false);
						assert.equal(encoded.includes('"cardId"'), false);
						assert.equal(encoded.includes('"name":"gongJi"'), false);
						views.set(seatId, view);
						const ack = receiveWebSocketMessage(socket);
						socket.send(JSON.stringify({ type: "state_ack", stateSequence: 1 }));
						assert.deepEqual(await ack, { type: "transport_acknowledged", stateSequence: 1,
							connectionGeneration: currentGeneration, duplicate: false });
					}
					for (const seatId of immutableServerSeatIds) {
						for (const otherSeatId of immutableServerSeatIds.filter(other => other !== seatId)) {
							assert.equal(JSON.stringify(views.get(seatId)).includes(`opaque_${otherSeatId}_`), false);
							for (const privateId of views.get(otherSeatId).privateState.handCardViewIds) {
								assert.equal(views.get(seatId).privateState.handCardViewIds.includes(privateId), false,
									"opaque private hand identifiers must be recipient-scoped");
							}
						}
						assert.equal(views.get(seatId).privateState.seatId, seatId);
					}
					const firstHostState = manager.inspect(roomId);
					const firstHostHandle = launchedHandles.get(firstHostState.sessionId);
					const firstHostPids = firstHostHandle.resources().map(resource => resource.pid);
					const aSocket = sockets.get(immutableServerSeatIds[0]);
					const duplicateRead = receiveWebSocketMessage(aSocket);
					aSocket.send(JSON.stringify({ type: "state_read", requestId: `initial_${immutableServerSeatIds[0]}`, lastSeenSequence: 0 }));
					assert.deepEqual(await duplicateRead, views.get(immutableServerSeatIds[0]), "duplicate logical read must not allocate another state sequence");
					const deniedAction = receiveWebSocketMessage(aSocket);
					aSocket.send(JSON.stringify({ type: "choice_submit", choiceId: "forged", optionId: "forged" }));
					assert.deepEqual(await deniedAction, { type: "gateway_error", code: "GAMEPLAY_TRANSPORT_DISABLED" });
					const adminSocket = await connectWebSocket(WebSocket, gatewayAddress.url);
					const deniedAdmin = receiveWebSocketMessage(adminSocket);
					adminSocket.send(JSON.stringify({ type: "seat_auth", roomId, seatId: immutableServerSeatIds[0], credential: "f".repeat(64) }));
					assert.deepEqual(await deniedAdmin, { type: "gateway_error", code: "SEAT_AUTH_REJECTED" });
					await closeWebSocket(adminSocket);
					for (const seatId of immutableServerSeatIds) {
						const oldSocket = sockets.get(seatId), oldGeneration = generations.get(seatId);
						await closeWebSocket(oldSocket);
						await until(() => seatRegistry.inspect(roomId, seatId).connected === false, 3000,
							() => ({ seatId, registry: seatRegistry.inspect(roomId, seatId) }));
						const rebound = await connectWebSocket(WebSocket, gatewayAddress.url);
						sockets.set(seatId, rebound);
						const reboundAuth = receiveWebSocketMessage(rebound);
						rebound.send(JSON.stringify({ type: "seat_auth", roomId, seatId, credential: credentialFor(seatId) }));
						const auth = await reboundAuth;
						assert.equal(auth.connectionGeneration, oldGeneration + 1);
						const nextGeneration = auth.connectionGeneration;
						generations.set(seatId, nextGeneration);
						const freshRead = receiveWebSocketMessage(rebound);
						rebound.send(JSON.stringify({ type: "state_read", requestId: `rebound_${seatId}`, lastSeenSequence: 1 }));
						const fresh = await freshRead;
						assert.equal(validateSeatStateMessage(fresh, { roomId, seatId, connectionGeneration: nextGeneration,
							seatIds: immutableServerSeatIds }).ok, true);
						assert.equal(fresh.stateSequence, 2);
						assert.equal(fresh.replayFromSequence, 1);
					assert.equal(fresh.privateState.handCardViewIds.length,
						fresh.publicState.players.find(player => player.seatId === seatId).handCount);
						assert.notDeepEqual(fresh, views.get(seatId), "rebind must create a new current-generation projection, not replay private bytes from the old socket");
						const freshAck = receiveWebSocketMessage(rebound);
						rebound.send(JSON.stringify({ type: "state_ack", stateSequence: 2 }));
						assert.deepEqual(await freshAck, { type: "transport_acknowledged", stateSequence: 2,
							connectionGeneration: nextGeneration, duplicate: false });
						assert.equal(manager.inspect(roomId).sessionId, firstHostState.sessionId);
						assert.equal(manager.inspect(roomId).pid, firstHostState.pid);
						assert.deepEqual(firstHostHandle.resources().map(resource => resource.pid), firstHostPids);
						assert.equal(firstHostHandle.resources()[0]?.pid, gatewayChromiumPid);
					}
					assert.equal(manager.inspect(roomId).authorityStateRevision, 4);
					assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
					assert.equal(manager.inspect(roomId).checkpointAvailable, false);
					assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence === 5), false);
					assert.equal(controller.pendingCount(), 0);
					event5ReviewAfterGatewayRebind = manager.inspectEvent5ReviewEvidence(roomId);
					assert.ok(event5ReviewAfterGatewayRebind, "review evidence requires a currently bound successor seat before transport cleanup");
					for (const socket of sockets.values()) await closeWebSocket(socket);
					await until(() => immutableServerSeatIds.every(seatId => seatRegistry.inspect(roomId, seatId).connected === false), 3000,
						() => ({ gateway: seatStateGateway.inspect(), connectedSeats: immutableServerSeatIds.filter(seatId => seatRegistry.inspect(roomId, seatId).connected) }));
					assert.equal(seatStateGateway.inspect().clientCount, 0);
					assert.equal((await manager.inspect(roomId)).sessionId, gatewayHost.sessionId);
					assert.equal((await manager.inspect(roomId)).pid, gatewayHost.pid);
					assert.equal(seatStateGateway.inspect().bufferedMessages, 0, "all per-seat replay buffers are bounded and cleared when clients leave");
					t.diagnostic("isolated loopback four-seat WebSocket sync/rebind passed; creator remains an ordinary seat; no gameplay command, choice, authority event, or host lifecycle change");
				}
					const event5Review = event5ReviewAfterGatewayRebind || manager.inspectEvent5ReviewEvidence(roomId);
					assert.ok(event5Review, "review evidence must be derived from accepted Event #4, phase fence, native gate, and current seat binding");
					const provenance = assessEvent5Evidence({ proposalOnly: true, submissionEnabled: false,
						phaseOver: { completed: true }, actorRotation: { rotationVerified: true },
						seatBinding: { authenticated: true }, postStateFence: { knownStateOnly: true,
							afterPrivateStateDigest: "f".repeat(64), completionOrdinal: 999 } }, event5Review);
					assert.equal(provenance.reviewObservationShapeValid, true);
					assert.equal(provenance.classifications.predecessor.status, "manager_scoped_review_candidate");
					assert.equal(provenance.classifications.phaseOver.status, "manager_scoped_review_candidate",
						"phaseOver provenance must come from the validated atomic native fence, not candidate booleans");
					assert.equal(provenance.classifications.inputGate.status, "manager_scoped_review_candidate");
					assert.equal(provenance.classifications.seatBinding.value.connectionGeneration,
						seatRegistry.inspect(roomId, nextInput.seatId).epoch);
					assert.equal(provenance.digestDomains.crossDomainEquality.status, "unavailable");
					assert.equal(provenance.digestDomains.bridgeFromEvent4ToSuccessor.status, "unavailable");
					assert.equal(provenance.classifications.nativeSettlement.status, "unavailable");
					assert.equal(provenance.classifications.postStateFence.status, "unavailable");
					assert.equal(provenance.proposalClaims.completed, "caller_claim_unverified");
					assert.equal(provenance.proposalClaims.digest, "caller_claim_unverified");
					assert.equal(provenance.event5Accepted, false);
					assert.equal(provenance.authorityRevision, 4);
					assert.equal(controller.pendingCount(), 0, "read-only preparation must not allocate a managed choice or deadline");
						assert.equal(manager.inspect(roomId).authorityStateRevision, 4);
						assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
						assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence === 5), false);
						const compactGateTrace = successorFenceTrace;
						assert.ok(compactGateTrace, "the successor's compact input-wait diagnostic must reach the authenticated host channel");
						t.diagnostic(`successor diagnostic binding payload bytes: ${compactGateTrace.snapshot.sourcePayloadBytes}`);
						assert.equal(manager.inspect(roomId).sessionId, nativeActionCandidate.sessionId);
						const nextHost = launchedHandles.get(nativeActionCandidate.sessionId);
						assert.ok(nextHost && nextHost.pid === nativeHostPidAtFirstCandidate);
						assert.equal(nextHost.resources()[0]?.pid, nativeChromiumPidAtFirstCandidate,
							"the input boundary must remain in the original managed Chromium process");
						assert.equal(manager.inspect(roomId).authorityStateRevision, 4);
						assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
						assert.equal(manager.inspect(roomId).checkpointAvailable, false);
						assert.equal(authoritySubmissions.some(entry => entry.proof.eventSequence === 5), false);
						assert.equal(nativeDiagnostic.some(entry => entry?.stage === "native_input_wait_open" &&
							entry.snapshot?.nativeInputGate?.seatId === nextInput.seatId &&
							entry.snapshot?.nativeInputGate?.diagnosticOnly === true), true);
						t.diagnostic(`next-seat native input boundary reached without authority submission: ${JSON.stringify({ seatId: nextInput.seatId,
							nativeEventId: nextInput.nativeEventId, optionCount: nextInput.optionCount, rootInstanceId: nextInput.rootInstanceId,
							preparedReadOnly: nextSeatPreparation.readOnly, connectionGeneration: nextSeatPreparation.connectionGeneration,
							preActionCaptureOrdinal: successorCapture.snapshot.captureOrdinal, repeatedCaptureStable: successorRepeat.snapshot.stableWithPrevious,
							authorityRevision: manager.inspect(roomId).authorityStateRevision, nextAuthorityEventSequence: manager.inspect(roomId).nextAuthorityEventSequence,
							gameMeAbsent: true })}`);
					}
					let nextSeatBoundary = null;
					if (process.env.V2_NATIVE_MULTI_TURN_COMPLETION_SEQUENCE === "1") {
						nextSeatBoundary = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_loop_wait_next_boundary" &&
							entry.snapshot?.eventStep === 3 && entry.snapshot?.isCompletedPhaseOverBoundary === true &&
							entry.snapshot?.loopSeatId !== waitingSnapshot.firstActSeatId &&
							Number.isSafeInteger(entry.snapshot?.nativeCompletionOrdinal) &&
							entry.snapshot.nativeCompletionOrdinal > waitingSnapshot.nativeCompletionOrdinal), 10000,
							() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), phaseBoundaries: nativeDiagnostic.filter(entry =>
								entry?.stage === "native_phase_loop_wait_next_boundary").slice(-8), host: manager.inspect(roomId) }));
						assert.equal(nextSeatBoundary.snapshot.rootInstanceId, waitingSnapshot.rootInstanceId);
						assert.equal(nextSeatBoundary.snapshot.rootObjectMatches, true);
						assert.equal(nextSeatBoundary.snapshot.completedPhaseChildFinished, true);
						assert.equal(nextSeatBoundary.snapshot.completedPhaseChildParentMatches, true);
						assert.equal(nextSeatBoundary.snapshot.nativeCompletionEvidence?.eventName, "phase");
						assert.equal(nextSeatBoundary.snapshot.nativeCompletionEvidence?.parentEventName, "phaseLoop");
						assert.equal(nextSeatBoundary.snapshot.completedPhaseSeatId, waitingSnapshot.nextActorSeatId,
							"the completed phase must belong to the seat that became active after the prior native rotation");
						assert.equal(nextSeatBoundary.snapshot.nativeCompletionEvidence?.seatId, nextSeatBoundary.snapshot.completedPhaseSeatId);
						assert.ok(nextSeatBoundary.snapshot.nativeCompletionEvidence.completionOrdinal > waitingSnapshot.nativeCompletionOrdinal);
						assert.equal(nextSeatBoundary.snapshot.gameMeAbsent, true);
						assert.equal(nextSeatBoundary.snapshot.connectedTransports, 0);
						t.diagnostic(`second-seat native phase completion sequence: ${JSON.stringify({ first: { seatId: waitingSnapshot.seatId,
							ordinal: waitingSnapshot.nativeCompletionOrdinal }, second: { seatId: nextSeatBoundary.snapshot.completedPhaseSeatId,
							ordinal: nextSeatBoundary.snapshot.nativeCompletionOrdinal }, sameRoot: nextSeatBoundary.snapshot.rootObjectMatches,
							gameMeAbsent: nextSeatBoundary.snapshot.gameMeAbsent })}`);
					}
					if (process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1") {
						assert.ok(nextSeatBoundary, "the multi-turn atomic probe requires the second real native seat completion");
						assert.ok(firstAtomicCapture && firstAtomicRepeat, "first-seat atomic capture was not accepted before native continuation");
						const secondFence = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_phase_boundary_fence_waiting" &&
							entry.snapshot?.boundaryOrdinal === 2 && entry.snapshot?.seatId === nextSeatBoundary.snapshot.completedPhaseSeatId), 10000,
							() => ({ boundaries: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").map(entry => entry.snapshot),
								phaseBoundaries: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_loop_wait_next_boundary").slice(-8).map(entry => entry.snapshot),
								host: manager.inspect(roomId) }));
						assert.notEqual(secondFence.snapshot.seatId, waitingSnapshot.seatId);
						assert.equal(secondFence.snapshot.phaseNumber, waitingSnapshot.phaseNumber + 1,
							"native phaseNumber must advance once through the original phaseLoop, not through a synthesized actor change");
						assert.equal(waitingSnapshot.completedPhasePlayerPhaseNumber, 1);
						assert.equal(secondFence.snapshot.completedPhasePlayerPhaseNumber, 1,
							"the next ordinary seat's native phaseNumber must come from that Player's own phase initialization");
						assert.equal(secondFence.snapshot.rootInstanceId, waitingSnapshot.rootInstanceId);
						assert.equal(secondFence.snapshot.rootObjectMatches, true);
						assert.equal(secondFence.snapshot.loopSeatId, nextSeatBoundary.snapshot.loopSeatId);
						assert.equal(secondFence.snapshot.completedPhaseSeatId, nextSeatBoundary.snapshot.completedPhaseSeatId);
						assert.equal(secondFence.snapshot.completedPhaseFinished, true);
						assert.equal(secondFence.snapshot.completedPhaseParentMatches, true);
						assert.equal(secondFence.snapshot.phaseOverTriggerComplete, true);
						assert.ok(Number.isSafeInteger(secondFence.snapshot.phaseOverTriggerCount) &&
							secondFence.snapshot.phaseOverTriggerCount > waitingSnapshot.phaseOverTriggerCount);
						assert.ok(secondFence.snapshot.completedActorQuotas &&
							Object.values(secondFence.snapshot.completedActorQuotas).every(value => Number.isSafeInteger(value)));
						const secondSeatQuotaReset = nativeDiagnostic.find(entry => entry?.stage === "native_xingDong_step0_completed" &&
							entry.snapshot?.seatId === secondFence.snapshot.completedPhaseSeatId);
						assert.ok(secondSeatQuotaReset,
							"the second completed actor must have an observation after its own native xingDong step 0, even when it has no external choice candidate");
						assert.equal(secondSeatQuotaReset.snapshot.eventName, "xingDong");
						assert.equal(secondSeatQuotaReset.snapshot.eventStep, 1,
						"the quota observation must occur at native waitNext after content step 0 completed");
						assert.equal(secondSeatQuotaReset.snapshot.parentEventName, "phase");
						assert.ok(secondSeatQuotaReset.snapshot.eventInstanceId);
						assert.equal(secondSeatQuotaReset.snapshot.rootInstanceId, waitingSnapshot.rootInstanceId);
						assert.equal(secondSeatQuotaReset.snapshot.rootObjectMatches, true);
						assert.equal(secondSeatQuotaReset.snapshot.gameMeAbsent, true);
						assert.deepEqual(secondSeatQuotaReset.snapshot.quotas,
							{ gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
							"the next actor's quota reset must be observed directly after native step 0, not inferred from the prior phase");
						assert.equal(secondFence.snapshot.currentPhaseSeatId, null);
						assert.equal(secondFence.snapshot.gameMeAbsent, true);
						assert.equal(secondFence.snapshot.connectedTransports, 0);
						assert.equal(secondFence.snapshot.completionEvidence.eventName, "phase");
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.kind, "native_phase_over_dispatch_v1");
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.ownerEventInstanceId,
							secondFence.snapshot.completionEvidence.parentEventInstanceId);
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.ownerEventStep, 2);
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.triggerName, "phaseOver");
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.seatId, secondFence.snapshot.seatId);
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.phaseEventInstanceId, secondFence.snapshot.completionEvidence.eventInstanceId);
						assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.phaseCompletionOrdinal, secondFence.snapshot.completionEvidence.completionOrdinal);
						if (secondFence.snapshot.phaseOverCompletionEvidence.childEventInstanceId === null) {
							assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.childEventName, null);
							assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.childParentEventInstanceId, null);
							assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.childCompletionOrdinal, null,
								"the native trigger dispatcher explicitly scheduled no child event at this boundary");
						} else {
							assert.equal(secondFence.snapshot.phaseOverCompletionEvidence.childParentEventInstanceId,
								secondFence.snapshot.phaseOverCompletionEvidence.ownerEventInstanceId);
							assert.ok(Number.isSafeInteger(secondFence.snapshot.phaseOverCompletionEvidence.childCompletionOrdinal),
								"a scheduled phaseOver child must have actual native completion evidence");
						}
						const secondCaptureResult = await manager.snapshotNativeAtomicCapture(roomId);
						assert.equal(secondCaptureResult.ok, true, `second-seat atomic capture rejected: ${secondCaptureResult.code}`);
						assert.equal(secondCaptureResult.snapshot.captureOrdinal, 3);
						assert.equal(secondCaptureResult.snapshot.nativeFenceOrdinal, 2);
						assert.ok(secondCaptureResult.snapshot.nativeCompletionOrdinal > firstAtomicCapture.nativeCompletionOrdinal);
						assert.deepEqual(secondCaptureResult.snapshot.nativeTurnSummary, {
							actorSeatId: secondFence.snapshot.seatId, phaseLoopSeatId: secondFence.snapshot.nextActorSeatId, phase: "between_turns",
							gamePhaseNumber: secondFence.snapshot.phaseNumber, playerPhaseNumber: secondFence.snapshot.completedPhasePlayerPhaseNumber,
							quotas: { gongJiOrFaShu: secondFence.snapshot.completedActorQuotas.gongJiOrFaShu,
								faShu: secondFence.snapshot.completedActorQuotas.faShu, gongJi: secondFence.snapshot.completedActorQuotas.gongJi },
						}, "second-seat capture must bind the completed second actor and actual remaining quotas, not uninitialized successor quotas");
						assert.notEqual(secondCaptureResult.snapshot.commitment, firstAtomicCapture.commitment);
						assert.equal(secondCaptureResult.snapshot.stableWithPrevious, false,
							"the second actor boundary is a different native state from the first actor boundary");
						const secondCaptureRepeat = await manager.snapshotNativeAtomicCapture(roomId);
						assert.equal(secondCaptureRepeat.ok, true, `same second-fence repeat rejected: ${secondCaptureRepeat.code}`);
						assert.equal(secondCaptureRepeat.snapshot.captureOrdinal, 4);
						assert.equal(secondCaptureRepeat.snapshot.nativeFenceOrdinal, 2);
						assert.equal(secondCaptureRepeat.snapshot.nativeCompletionOrdinal, secondCaptureResult.snapshot.nativeCompletionOrdinal);
						assert.equal(secondCaptureRepeat.snapshot.stableWithPrevious, true);
						assert.deepEqual(secondCaptureRepeat.snapshot.stableProjectionsWithPrevious,
							{ cardLedger: true, effectState: true, turnResource: true });
						assert.notEqual(secondCaptureRepeat.snapshot.commitment, secondCaptureResult.snapshot.commitment,
							"capture ordinals are independent of the stable native state commitment comparison");
						assert.equal(manager.inspect(roomId).authorityStateRevision, 4,
							"diagnostic second-turn native work must not authorize Event #5 or advance the authority chain");
						assert.equal(manager.inspect(roomId).nextAuthorityEventSequence, 5);
						assert.equal(manager.inspect(roomId).checkpointAvailable, false);
						const liveHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
						assert.ok(liveHandle && liveHandle.pid > 0);
						assert.equal(manager.inspect(roomId).sessionId, atomicCaptureSessionId);
						assert.equal(liveHandle.pid, atomicCapturePid, "both fences must belong to the same supervised host process");
						assert.equal(liveHandle.resources().length, 1);
						assert.equal(liveHandle.resources()[0].pid, atomicChromiumPid,
							"both native boundaries must belong to the same real Chromium process");
						assert.equal(nativeDiagnostic.slice(nativeDiagnostic.indexOf(secondFence) + 1).some(entry =>
							entry?.stage === "native_parent_next_action_child_start"), false,
							"native parent must remain held throughout the second atomic capture and repeat");
						t.diagnostic(`cross-seat native atomic captures accepted: ${JSON.stringify({ sameRoom: roomId,
							sessionId: manager.inspect(roomId).sessionId, pid: liveHandle.pid, rootInstanceId: waitingSnapshot.rootInstanceId,
							firstSeatId: waitingSnapshot.seatId, secondSeatId: secondFence.snapshot.seatId,
							firstCompletionOrdinal: firstAtomicCapture.nativeCompletionOrdinal,
							secondCompletionOrdinal: secondCaptureResult.snapshot.nativeCompletionOrdinal,
							captureOrdinals: [firstAtomicCapture.captureOrdinal, firstAtomicRepeat.captureOrdinal,
								secondCaptureResult.snapshot.captureOrdinal, secondCaptureRepeat.snapshot.captureOrdinal],
							stateRevision: manager.inspect(roomId).authorityStateRevision, checkpointAvailable: false })}`);
					}
					t.diagnostic(`native phaseLoop waitNext boundaries: ${JSON.stringify(nativeDiagnostic.filter(entry => entry?.stage === "native_phase_loop_wait_next_boundary").map(entry => ({
						eventStep: entry.snapshot?.eventStep, childName: entry.snapshot?.completedChildName, childFinished: entry.snapshot?.completedChildFinished,
						parentMatches: entry.snapshot?.completedChildParentMatches, pending: entry.snapshot?.pendingChildCount, top: entry.snapshot?.eventStackTop,
						loopSeatId: entry.snapshot?.loopSeatId, currentPhaseSeatId: entry.snapshot?.currentPhaseSeatId,
					})))}`);
				}
			}
			if (process.env.V2_NATIVE_PARENT_FENCE_AUDIT === "1" && probeMode.startsWith("managed_opening_root_action_event4")) {
				const actionCompleted = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_event_completed"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), host: manager.inspect(roomId) }));
				const parentWait = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_action_child_wait_completed" &&
					entry?.snapshot?.completedChildName === "gongJiOrFaShu" && entry?.snapshot?.completedChildFinished === true), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-8), host: manager.inspect(roomId) }));
				const nextActionStart = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_next_action_child_start" &&
					nativeDiagnostic.indexOf(entry) > nativeDiagnostic.indexOf(parentWait) && entry?.snapshot?.eventName === "gongJiOrFaShu" &&
					entry?.snapshot?.eventParentName === "xingDong"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-8), host: manager.inspect(roomId) }));
				const event4Accepted = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_card_action_event_4_accepted"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-8), host: manager.inspect(roomId) }));
				const actionIndex = nativeDiagnostic.indexOf(actionCompleted);
				const parentIndex = nativeDiagnostic.indexOf(parentWait);
				const nextActionIndex = nativeDiagnostic.indexOf(nextActionStart);
				const event4Index = nativeDiagnostic.indexOf(event4Accepted);
				assert.ok(actionIndex >= 0 && parentIndex > actionIndex,
					"native action completion must be observed before the xingDong parent resumes after waitNext");
				assert.ok(nextActionIndex > parentIndex && event4Index >= 0,
					"the same root must expose the next native action boundary and accepted Event #4");
				assert.equal(parentWait.snapshot.parentEventName, "xingDong");
				assert.equal(parentWait.snapshot.completedChildParentMatches, true);
				assert.equal(parentWait.snapshot.rootObjectMatches, true);
				assert.equal(parentWait.snapshot.gameMeAbsent, true);
				assert.ok(parentWait.snapshot.quotas && Object.values(parentWait.snapshot.quotas).every(value => value === null || Number.isSafeInteger(value)));
				assert.equal(nextActionStart.snapshot.rootObjectMatches, true);
				assert.equal(nextActionStart.snapshot.gameMeAbsent, true);
				const acceptedFence = nextActionStart.snapshot.priorParentFence?.status === "released" &&
					nextActionStart.snapshot.priorParentFence?.releaseCount === 1 &&
					nextActionStart.snapshot.priorParentFence?.acceptedAuthority?.eventSequence === 4 &&
					nextActionStart.snapshot.priorParentFence?.acceptedAuthority?.stateRevision === 4 &&
					nextActionStart.snapshot.priorParentFence?.acceptedAuthority?.afterDigest === event4Accepted.afterDigest;
				const continuationClassification = acceptedFence
					? "next native action observed the exact server-accepted Event #4 fence tuple; host acceptance diagnostic can arrive later"
					: nextActionIndex < event4Index ? "next native action began before Event #4 acceptance" : "Event #4 accepted before next native action began";
				if (process.env.V2_NATIVE_PARENT_FENCE === "1") assert.equal(acceptedFence, true,
					"native continuation lacked the exact accepted Event #4 fence tuple");
				t.diagnostic(`native parent boundary order: ${JSON.stringify({ actionCompleted: actionIndex, parentWaitNextCompleted: parentIndex,
					nextActionChildStarted: nextActionIndex, event4AuthorityAccepted: event4Index,
					continuationClassification, acceptedFence,
					parentWait: parentWait.snapshot, nextAction: nextActionStart.snapshot })}`);
			}
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).resolution.kind,
				["managed_input_controller_trustee", "managed_opening_root_action_event4_trustee"].includes(probeMode) ? "trustee" : "player");
			if (disconnectActionToTrustee) {
				assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).resolution.kind, "trustee",
					"a disconnected ordinary seat must resolve only through its server deadline/trustee policy");
				assert.equal(seatRegistry.inspect(roomId, disconnectedActionHostIdentity?.seatId)?.connected, false,
					"the player seat must remain offline through trustee resolution");
				const hostAfterTrustee = manager.inspect(roomId);
				assert.equal(hostAfterTrustee?.sessionId, disconnectedActionHostIdentity?.sessionId,
					"ordinary player disconnect must not replace the managed host session");
				assert.equal(hostAfterTrustee?.pid, disconnectedActionHostIdentity?.pid,
					"ordinary player disconnect must not restart the managed Chromium process");
				assert.equal(hostAfterTrustee?.state, disconnectedActionHostIdentity?.state,
					"ordinary player disconnect must leave the managed host state unchanged");
				assert.equal(hostAfterTrustee?.authorityStateRevision, 4,
					"the isolated probe may finish the already-authorized Event #4 only; it must not open Event #5");
				assert.equal(hostAfterTrustee?.nextAuthorityEventSequence, 5);
				const reconnectedConnectionId = `reconnected_${disconnectedActionHostIdentity.seatId}`;
				const rebound = seatRegistry.bindConnection({ roomId, seatId: disconnectedActionHostIdentity.seatId,
					credential: credentialFor(disconnectedActionHostIdentity.seatId),
					socket: { kind: "player", roomId, seatId: disconnectedActionHostIdentity.seatId,
						connectionId: reconnectedConnectionId } });
				assert.ok(rebound, "the ordinary player must reclaim the same seat using its seat credential after trustee completion");
				assert.equal(controller.bindSeatConnection(rebound).ok, true,
					"the restored player connection must be bound through the trusted Seat Registry path");
				const resolvedChoice = controller.inspect(roomId, disconnectedActionHostIdentity.choiceId);
				assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: disconnectedActionHostIdentity.seatId,
					connectionId: disconnectedActionHostIdentity.priorConnectionId,
					credential: credentialFor(disconnectedActionHostIdentity.seatId) }, resolvedChoice), false,
				"the superseded socket must remain fenced after the valid seat rebind");
				assert.equal(seatRegistry.authenticateSeat({ roomId, seatId: disconnectedActionHostIdentity.seatId,
					connectionId: reconnectedConnectionId,
					credential: credentialFor(disconnectedActionHostIdentity.seatId) }, resolvedChoice), true,
				"the replacement socket must authenticate to the same ordinary seat");
				assert.equal(seatRegistry.inspect(roomId, disconnectedActionHostIdentity.seatId)?.connected, true);
				const hostAfterRebind = manager.inspect(roomId);
				assert.equal(hostAfterRebind?.sessionId, disconnectedActionHostIdentity.sessionId);
				assert.equal(hostAfterRebind?.pid, disconnectedActionHostIdentity.pid);
				assert.equal(hostAfterRebind?.state, disconnectedActionHostIdentity.state);
				t.diagnostic(`ordinary seat disconnect, trustee resolution, and credentialed rebind preserved managed host: ${JSON.stringify({
					seatId: disconnectedActionHostIdentity.seatId, choiceId: disconnectedActionHostIdentity.choiceId,
					hostSessionUnchanged: true, hostPidUnchanged: true, hostStateUnchanged: true,
					seatOfflineThroughTrustee: true, seatReconnectedWithOriginalCredential: true,
					oldConnectionFenced: true, hostUnchangedAfterRebind: true,
					authorityStateRevision: hostAfterTrustee.authorityStateRevision,
					nextAuthorityEventSequence: hostAfterTrustee.nextAuthorityEventSequence })}`);
			}
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).resolution.option,
				["managed_input_controller_trustee", "managed_opening_root_action_event4_trustee"].includes(probeMode) ? nativeActionCandidate.trusteeOption : nativeActionOptionId);
			if (process.env.V2_NATIVE_ACTION_KIND) {
				assert.equal(nativeActionCandidate.optionKinds[controller.inspect(roomId, nativeActionChoice.choiceId).resolution.option],
					process.env.V2_NATIVE_ACTION_KIND, "managed host must apply the requested native card category");
			}
			assert.equal(applied.snapshot?.nativeAction?.optionId, controller.inspect(roomId, nativeActionChoice.choiceId).resolution.option,
				"native engine applied an option other than the controller resolution");
			assert.equal(nativeActionAckDropped, true);
			assert.ok(controller.inspect(roomId, nativeActionChoice.choiceId).deliveryAttempts >= 2, "ACK loss did not trigger an automatic stable-delivery retry");
			assert.ok(nativeActionAckCount >= 2, "lost ACK must cause a stable-delivery retry");
			const duplicateProof = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_duplicate_delivery_verified"), 5000,
				() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), host: manager.inspect(roomId) }));
			assert.equal(duplicateProof.snapshot?.useResultCount, 1, "ACK retry re-executed native useResult");
			assert.equal(duplicateProof.snapshot?.childWaitCompleted, true);
			assert.equal(duplicateProof.snapshot?.cardInHand, false, "ACK retry did not prove native card movement");
			assert.equal(manager.inspect(roomId)?.authorityStateRevision, expectedAuthorityRevision, "C2-1 must prove the native operation without prematurely submitting authority Event #4");
			if (["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee"].includes(probeMode)) {
				if (probeMode === "managed_opening_root_action") assert.equal(expectedAuthorityRevision, 3);
				const released = await until(() => nativeDiagnostic.find(entry => entry?.stage === "existing_root_phase_loop_released"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null }));
				assert.equal(released.snapshot?.phaseLoopCreated, true);
				assert.equal(released.snapshot?.phaseLoopStartRequested, true);
				assert.equal(released.snapshot?.phaseLoopReleased, true);
				assert.equal(released.snapshot?.gameStartCount, 1);
				assert.equal(released.snapshot?.gameDrawEntered, true);
				assert.equal(released.snapshot?.hostPlayerAbsent, true);
				const nativeGate = nativeDiagnostic.find(entry => entry?.stage === "native_input_wait_open" &&
					entry?.snapshot?.nativeInputGate?.nativeEventId === nativeActionCandidate.nativeEventId);
				assert.ok(nativeGate, "the native action candidate must come from an observed, event-local input wait gate");
				assert.equal(nativeGate.snapshot?.nativeInputGate?.eventName, "gongJiOrFaShu");
				assert.equal(nativeGate.snapshot?.nativeInputGate?.parentEventName, "xingDong");
				assert.ok(applied.snapshot?.eventStack?.includes("game"));
				assert.ok(applied.snapshot?.eventStack?.includes("phaseLoop"));
				assert.deepEqual(applied.snapshot?.eventStack?.slice(0, 4), ["game", "phaseLoop", "phase", "xingDong"]);
				assert.equal(applied.snapshot?.phaseLoopParentName, "game");
				assert.equal(applied.snapshot?.nativeInputGate?.nativeEventId, nativeActionCandidate.nativeEventId);
				assert.equal(applied.snapshot?.nativeInputGate?.eventName, "gongJiOrFaShu");
				assert.equal(applied.snapshot?.nativeInputGate?.parentEventName, "xingDong");
			}
			if (probeMode.startsWith("managed_opening_root_action_event4")) {
				const accepted = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_card_action_event_4_accepted"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), session: manager.inspect(roomId), latest: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null }));
				assert.equal(accepted.eventSequence, 4);
				assert.equal(accepted.stateRevision, 4);
				assert.equal(accepted.beforeDigest, openingDrawAccepted.afterDigest);
				assert.equal(accepted.afterDigest, completed.authorityStateDigest);
				assert.deepEqual(completed.lastAuthorityEvent, { sequence: 4, name: "gongJiOrFaShu" });
				assert.equal(completed.nextAuthorityEventSequence, 5);
				assert.equal(completed.authorityDigestChain.length, 4);
				assert.equal(completed.authorityDigestChain[2].afterDigest, completed.authorityDigestChain[3].beforeDigest);
				assert.equal(accepted.nativeUseCardChildCompleted, true);
				assert.equal(accepted.hostPlayerAbsent, true);
				assert.equal(accepted.checkpointAvailable, false);
				if (process.env.V2_NATIVE_MANAGED_YINYANG === "1") {
					const acceptedProof = authoritySubmissions.find(entry => entry.proof?.eventSequence === 4)?.proof;
					const responses = acceptedProof?.afterSummary?.responses || [];
					if (process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1") {
						assert.equal(responses.some(response => response.kind === "view_as_skill"), false,
							"trustee decline must not claim a YinYang skill effect");
						assert.equal(responses.some(response => response.kind === "decline"), true,
							"Event #4 must record the native optional-decline result selected by the timeout trustee");
					} else {
						const skillResponse = responses.find(response => response.kind === "view_as_skill");
						assert.ok(skillResponse, "Event #4 must include the completed native YinYang response in its canonical summary");
						assert.equal(skillResponse.skillId, "yinYangZhanHuan");
						assert.equal(skillResponse.physicalMaterialConsumed, true);
						assert.equal(skillResponse.xiBieApplied, true);
						assert.ok(["an", "di", "feng", "guang", "huo", "lei", "shui"].includes(skillResponse.resolvedXiBie));
						assert.ok(Number.isSafeInteger(skillResponse.guiHuoDelta) && skillResponse.guiHuoDelta >= 1 && skillResponse.guiHuoDelta <= 3,
							"native skill and eligible character triggers must produce a bounded, recorded guiHuo transition");
						assert.equal(Object.hasOwn(skillResponse, "materialCard"), false, "authority summary must not reveal hidden material identity");
						assert.equal(acceptedProof.event.responseActions.some(response => response.kind === "view_as_skill"), true);
					}
				}
				assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1, "Event #4 delivery retry must not re-run useResult");
				if (probeMode === "managed_opening_root_action_event4_ack_loss") {
					assert.equal(event4AckDropCount, 1, "test must drop the first authority Event #4 ACK");
					assert.ok(event4SubmissionCount >= 2, "host must retry the same Event #4 proof after the dropped ACK");
					assert.ok(event4ProofSubmissions.every(proof => proof === event4ProofSubmissions[0]), "authority retry must preserve the immutable Event #4 proof");
					assert.ok(event4AckBarrierWaitCount >= 1, "the retried authority ACK must be held at the explicit test barrier");
					assert.equal(event4ControllerRetryTriggered, true, "controller retry must be deterministic while the authority ACK is withheld");
					assert.equal(event4AuthorityJoinCount, 1, "ACK barrier releases only after the controller retry joined the pending commit");
					assert.equal(event4AckBarrierReleased, true);
					if (process.env.V2_NATIVE_PARENT_FENCE === "1") assert.equal(duplicateEvent4AuthorityAckSent, true,
						"the exact Event #4 authority ACK replay was not exercised in the fenced probe");
					assert.equal(completed.authorityDigestChain.length, 4, "ACK replay must not append Event #4 twice");
					assert.equal(nativeActionAckCount >= 2, true, "choice ACK waits for authority acceptance after retry");
					assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1, "overlapping delivery retry cannot re-run native useResult");
				}
			}
			if (process.env.V2_NATIVE_C3_FULL_CHAIN === "1" && probeMode === "managed_opening_root_action_event4") {
				const session = manager.inspect(roomId);
				assert.equal(session.authorityStateRevision, 4);
				assert.equal(session.nextAuthorityEventSequence, 5);
				assert.equal(session.checkpointAvailable, false);
				assert.deepEqual(authoritySubmissions.map(entry => entry.proof.eventSequence), [1, 2, 3, 4],
					"one managed-host run must submit exactly authority events 1 through 4");
				assert.ok(authoritySubmissions.every(entry => entry.roomId === roomId && entry.sessionId === session.sessionId),
					"authority events must use the same room and managed host session");
				if (process.env.V2_NATIVE_C3_UNIFIED_ROOT === "1") {
					const rootIds = authoritySubmissions.map(entry => entry.proof.event.rootInstanceId);
					assert.ok(rootIds.every(rootId => typeof rootId === "string" && /^native_root_[A-Za-z0-9_-]{16,96}$/.test(rootId)),
						"all four native authority proofs must bind an explicit root identity");
					assert.equal(new Set(rootIds).size, 1, "Events #1–#4 must bind the same native root instance");
					assert.equal(authoritySubmissions[0].proof.event.sideEventParentName, "chooseCharacterOL");
					assert.equal(authoritySubmissions[0].proof.event.selectionParentName, "game");
					assert.equal(authoritySubmissions[2].proof.event.rootEventName, "game");
					const rootIdentityMismatches = nativeDiagnostic.filter(entry => entry?.snapshot?.rootObjectMatches === false)
						.map(entry => ({ stage: entry.stage || null, eventName: entry.snapshot?.eventName || null,
							eventStep: Number.isSafeInteger(entry.snapshot?.eventStep) ? entry.snapshot.eventStep : null,
							parentEventName: entry.snapshot?.parentEventName || null,
							rootInstanceId: entry.snapshot?.rootInstanceId || null,
							managerRootEventName: entry.snapshot?.managerRootEventName || null,
							managerRootEventInstanceId: entry.snapshot?.managerRootEventInstanceId || null,
							stateRootEventInstanceId: entry.snapshot?.stateRootEventInstanceId || null,
							managerEventStackRootName: entry.snapshot?.managerEventStackRootName || null,
							managerEventStackRootInstanceId: entry.snapshot?.managerEventStackRootInstanceId || null,
							phaseLoopIdentityMatches: typeof entry.snapshot?.phaseLoopIdentityMatches === "boolean"
								? entry.snapshot.phaseLoopIdentityMatches : null }));
					assert.equal(rootIdentityMismatches.length, 0,
						`native root object identity changed during the four-event chain: ${JSON.stringify(rootIdentityMismatches)}`);
					const actionGate = nativeDiagnostic.find(entry => entry?.stage === "native_start_probe_outcome")?.snapshot;
					assert.equal(actionGate?.rootObjectMatches, true);
					assert.equal(actionGate?.rootInstanceId, rootIds[0]);
					if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1") {
						let liveSnapshot = nativeLiveSnapshotAtInputGate, lastSnapshot = liveSnapshot;
						if (!liveSnapshot) {
							const snapshotDeadline = Date.now() + 3000;
							while (!liveSnapshot && Date.now() < snapshotDeadline) {
								const beforeSnapshot = nativeDiagnostic.length;
								assert.equal((await manager.snapshotNativeStart(roomId, "managed_opening_root_action_event4")).ok, true,
									"authenticated live snapshot must not restart/re-instrument the continuing native root");
								const remaining = Math.max(1, snapshotDeadline - Date.now());
								lastSnapshot = await until(() => nativeDiagnostic.slice(beforeSnapshot).find(entry => entry?.stage === "native_start_live_snapshot"),
									Math.min(remaining, 1000), () => ({ session: manager.inspect(roomId), diagnostics: nativeDiagnostic.slice(beforeSnapshot) }));
								if (lastSnapshot?.projectionAudit?.phaseEvent?.name === "phase" && lastSnapshot?.projectionAudit?.xingDongEvent?.name === "xingDong") liveSnapshot = lastSnapshot;
							}
						}
						assert.ok(liveSnapshot, `native phase snapshot was not observed at a stable phase/xingDong boundary: ${JSON.stringify(lastSnapshot)}`);
						assert.equal(liveSnapshot.rootObjectMatches, true);
						assert.equal(liveSnapshot.rootInstanceId, rootIds[0]);
						assert.equal(liveSnapshot.hostPlayerAbsent, true);
						assert.equal(liveSnapshot.responseGates.every(gate => gate.status === "applied"), true,
							"the read-only snapshot must expose no stranded managed response gate after Event #4");
						const audit = liveSnapshot.projectionAudit;
						assert.equal(audit?.kind, "xingbei_authority_projection_audit_v1");
						assert.equal(audit.candidateDisposition, "diagnostic_only_not_a_proof");
						assert.equal(audit.authorized, false, "a diagnostic projection audit must never authorize the v2 seed");
						assert.equal(audit.checkpointAvailable, false);
						assert.equal(audit.rootObjectMatches, true);
						assert.ok(setup.seats.some(seat => seat.seatId === audit.currentSeatId),
							"currentPhase must be an actual seat, not inferred from the immutable first actor");
						assert.ok(setup.seats.some(seat => seat.seatId === audit.firstActSeatId),
							"the original first actor must remain a separate, stable identity");
						const acceptedEvent4 = authoritySubmissions.find(entry => entry.proof?.eventSequence === 4)?.proof;
						assert.ok(acceptedEvent4?.afterSummary, "the accepted Event #4 summary must remain available for boundary comparison");
						assert.equal(acceptedEvent4.afterSummary.firstActSeatId, audit.firstActSeatId,
							"the legacy Event #4 summary retains the original first actor identity");
						assert.equal(Object.hasOwn(acceptedEvent4.afterSummary, "currentSeatId"), false,
							"the legacy Event #4 tip does not claim to capture the live current turn");
						assert.ok(Number.isSafeInteger(audit.roundNumber) && audit.roundNumber >= 0);
						assert.ok(Number.isSafeInteger(audit.phaseNumber) && audit.phaseNumber > 0);
						assert.equal(audit.phaseEvent?.name, "phase");
						assert.equal(audit.xingDongEvent?.name, "xingDong");
						assert.ok(setup.seats.some(seat => seat.seatId === audit.xingDongEvent?.seatId),
							"the live xingDong event must expose its own actual actor independently from currentPhase");
						assert.equal(audit.xingDongEvent.seatId, audit.currentSeatId,
							"this live snapshot records the next player's actual native action phase, not the immutable first actor");
						assert.ok(Number.isSafeInteger(audit.xingDongEvent.actionChildCount) && audit.xingDongEvent.actionChildCount >= 1);
						assert.ok(Number.isSafeInteger(audit.pendingActionChildCount) && audit.pendingActionChildCount >= 1,
							`expected the live snapshot to identify its pending native child: ${JSON.stringify(audit.xingDongEvent)}`);
						assert.ok(Number.isSafeInteger(audit.completedActionChildCount) && audit.completedActionChildCount >= 0);
						assert.deepEqual(audit.seats.map(seat => seat.seatId), setup.seats.map(seat => seat.seatId));
						assert.ok(audit.seats.every(seat => typeof seat.character === "string" && typeof seat.side === "boolean" &&
							typeof seat.alive === "boolean" && Number.isSafeInteger(seat.hp) && Number.isSafeInteger(seat.maxHp) &&
							Number.isSafeInteger(seat.zhiLiao) && Number.isSafeInteger(seat.hujia) &&
							[seat.handCount, seat.equipmentCount, seat.judgmentCount, seat.expansionCount, seat.skillCount, seat.markKeyCount, seat.storageKeyCount]
								.every(Number.isSafeInteger) && Number.isSafeInteger(seat.nengLiang?.baoShi) && Number.isSafeInteger(seat.nengLiang?.shuiJing)),
							`native seat audit contains an unsupported/missing field: ${JSON.stringify(audit.seats)}`);
						assert.ok(["draw", "discard", "ordering", "special"].every(zone => Number.isSafeInteger(audit.cardZoneCounts?.[zone])));
						assert.ok(["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei", "hongZhanJiCount", "lanZhanJiCount"]
							.every(key => Number.isSafeInteger(audit.resources?.[key])));
					}
				}
				for (let index = 0; index < authoritySubmissions.length; index++) {
					const { proof, resourcePids } = authoritySubmissions[index];
					assert.equal(proof.stateRevisionBefore, index);
					assert.equal(proof.stateRevisionAfter, index + 1);
					assert.equal(proof.eventSequence, index + 1);
					assert.equal(proof.checkpoint, null);
					if (index) assert.equal(proof.beforeDigest, authoritySubmissions[index - 1].proof.afterDigest,
						`authority digest discontinuity before event ${index + 1}`);
					assert.ok(resourcePids.length >= 1, "Chromium resource identity was not registered before authority submission");
					assert.ok(resourcePids.every(pid => pid === resourcePids[0]), "more than one Chromium PID appeared during the match");
				}
				const chromiumPids = new Set(authoritySubmissions.flatMap(entry => entry.resourcePids));
				assert.equal(chromiumPids.size, 1, "the complete event chain must stay in one Chromium process");
				const chain = session.authorityDigestChain;
				assert.deepEqual(chain.map(entry => entry.eventSequence), [1, 2, 3, 4]);
				assert.equal(session.authorityStateDigest, authoritySubmissions[3].proof.afterDigest,
					"server authority tip must match the final native proof");
				assert.equal(session.authorityStateRevision, 4);
				if (process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1") {
					assert.ok(nativeCardLedgerBefore && nativeCardLedgerAfter,
						`the real four-seat card action must be bracketed by two private native ledger captures: ${JSON.stringify({
							before: Boolean(nativeCardLedgerBefore), after: Boolean(nativeCardLedgerAfter), failures: nativeCardLedgerFailures,
							contexts: nativeCardLedgerCaptureContexts, phaseFence: nativeDiagnostic.filter(entry => entry?.stage === "native_phase_boundary_fence_waiting").slice(-1)[0]?.snapshot || null,
							session: manager.inspect(roomId)?.state, authorityRevision: manager.inspect(roomId)?.authorityStateRevision })}`);
					assert.equal(nativeCardLedgerBefore.rootInstanceId, authoritySubmissions[0].proof.event.rootInstanceId);
					assert.equal(nativeCardLedgerAfter.rootInstanceId, nativeCardLedgerBefore.rootInstanceId);
					assert.equal(nativeCardLedgerBefore.engineBuildId, session.engineBuildId);
					assert.equal(nativeCardLedgerAfter.engineBuildId, session.engineBuildId);
					assert.equal(nativeCardLedgerBefore.physicalCardCount, nativeCardLedgerAfter.physicalCardCount);
					assert.notEqual(nativeCardLedgerBefore.commitment, nativeCardLedgerAfter.commitment,
						"native physical-card state changed across the real action, so the private commitment must change");
					assert.ok(nativeCardLedgerAfter.changedPhysicalCardCount > 0);
					assert.ok(nativeCardLedgerAfter.movedZonePhysicalCardCount > 0,
						"at least one stable sidecar-tracked native physical Card must move between actual engine zones");
					assert.equal(nativeCardLedgerAfter.totalCountConserved, true);
					assert.equal(Object.values(nativeCardLedgerAfter.zoneDelta).reduce((sum, value) => sum + value, 0), 0);
					assert.equal(nativeCardLedgerBefore.checkpointAvailable, false);
					assert.equal(nativeCardLedgerAfter.checkpointAvailable, false);
					assert.equal(nativeCardLedgerCaptureContexts.length, 2);
					assert.equal(nativeCardLedgerCaptureContexts[0].nativeEventId, nativeActionCandidate.nativeEventId);
					assert.equal(nativeCardLedgerCaptureContexts[0].eventSequence, 4);
					assert.equal(nativeCardLedgerCaptureContexts[1].nativeEventId, nativeActionCandidate.nativeEventId);
					assert.equal(nativeCardLedgerCaptureContexts[1].eventSequence, 4);
					assert.equal(nativeCardLedgerCaptureContexts[0].nativeCompletionOrdinal, null,
						"the card ledger pre-action capture is bound to the native candidate boundary, not a completed action ordinal");
					assert.equal(nativeCardLedgerCaptureContexts[1].nativeCompletionOrdinal, null,
						"the card ledger protocol does not expose a shared native completion ordinal for its post-phaseOver boundary");
					if (process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1") {
						assert.ok(nativeEffectStateBefore?.snapshot && nativeEffectStateAfter?.snapshot,
							"combined B1/B2 acceptance requires both effect snapshots before comparing their bindings");
						assert.equal(nativeCardLedgerBefore.rootInstanceId, nativeEffectStateBefore.snapshot.rootInstanceId);
						assert.equal(nativeCardLedgerAfter.rootInstanceId, nativeEffectStateAfter.snapshot.rootInstanceId);
						assert.equal(nativeCardLedgerBefore.engineBuildId, nativeEffectStateBefore.snapshot.engineBuildId);
						assert.equal(nativeCardLedgerAfter.engineBuildId, nativeEffectStateAfter.snapshot.engineBuildId);
					}
					assert.equal(nativeCardLedgerAfter.virtualCardsIncluded, false,
						"virtual YinYang viewAs cards must not be added to the physical card ledger");
					const privateSummary = JSON.stringify([nativeCardLedgerBefore, nativeCardLedgerAfter]);
					assert.equal(/physical_[A-Za-z0-9_-]+|gongJi|faShu|mingGe/.test(privateSummary), false,
						"only HMAC commitments and aggregate deltas may cross the internal host boundary");
					t.diagnostic(`T3-B1 private native card ledger: ${JSON.stringify({ schema: nativeCardLedgerAfter.schema,
						physicalCardCount: nativeCardLedgerAfter.physicalCardCount, changedPhysicalCardCount: nativeCardLedgerAfter.changedPhysicalCardCount,
						movedZonePhysicalCardCount: nativeCardLedgerAfter.movedZonePhysicalCardCount,
						zoneDelta: nativeCardLedgerAfter.zoneDelta, sameRoot: true, sameBuild: true, checkpointAvailable: false,
						captureContexts: nativeCardLedgerCaptureContexts, atomicWithEffectSnapshots: false })}`);
				}
				const publicViewJson = JSON.stringify(session);
				const diagnosticJson = JSON.stringify(nativeDiagnostic);
				assert.equal(publicViewJson.includes("handCommitment"), false, "server public view must not expose hidden-hand commitments");
				assert.equal(diagnosticJson.includes("handCommitment"), false, "native diagnostics must not expose hidden-hand commitments");
				assert.equal(/\"hand\"\s*:/.test(diagnosticJson), false, "native diagnostics must not expose complete hidden hands");
				assert.equal(publicViewJson.includes(sessionSecret), false, "server public view leaked the managed-host secret");
				assert.equal(diagnosticJson.includes(sessionSecret), false, "native diagnostics leaked the managed-host secret");
				for (const credential of seatCredentials.values()) {
					assert.equal(publicViewJson.includes(credential), false, "server public view leaked a seat credential");
					assert.equal(diagnosticJson.includes(credential), false, "native diagnostics leaked a seat credential");
				}
				const handle = launchedHandles.get(session.sessionId);
				assert.ok(handle);
				assert.ok(handle.pid > 0, "supervised host PID must remain available for the full match");
				assert.equal(handle.resources().length, 1, "the managed match must retain exactly one Chromium resource until cleanup");
				assert.equal(handle.resources()[0].pid, [...chromiumPids][0]);
			}
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).deliveryId, `delivery_${nativeActionChoice.choiceId}`);
			if (nativeFaultMode === "retry_while_applying") {
				assert.equal(applyingRetryIssued, true, "test did not redeliver while native useResult was executing");
				assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1, "same delivery executed native useResult more than once");
				assert.equal(nativeActionAckCount, 2, "one original ACK plus one lost-ACK retry should be observed, not an applying duplicate ACK");
			}
			if (nativeFaultMode === "late_stale_delivery") {
				const beforeAckCount = nativeActionAckCount;
				const late = controller.inspect(roomId, nativeActionChoice.choiceId);
				assert.equal((await manager.sendChoiceDelivery(roomId, { ...late, nativeEventId: `${late.nativeEventId}_stale` })).ok, true);
				await until(() => manager.inspect(roomId)?.state === "failed", 10000,
					() => ({ session: manager.inspect(roomId), nativeDiagnostic: nativeDiagnostic.slice(-8) }));
				assert.equal(manager.inspect(roomId).failureCode, "NATIVE_ACTION_STALE_DELIVERY_REJECTED");
				assert.equal(nativeActionAckCount, beforeAckCount, "stale delivery produced an ACK");
				assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1);
				const lateHandle = launchedHandles.get(manager.inspect(roomId).sessionId);
				await until(() => lateHandle.resources().length === 0, 10000, () => ({ resources: lateHandle.resources() }));
				await lateHandle.waitForCleanup();
				return;
			}
		} else if (probeMode === "managed_input_gate") {
			assert.equal(outcome.classification, "native_promise_pending_cdp_responsive");
			assert.equal(snapshot.firstPhaseGate, null);
			assert.equal(snapshot.gameStartCount, 1);
			assert.equal(snapshot.gameDrawEntered, true);
			assert.equal(snapshot.phaseLoopCreated, true);
			assert.equal(snapshot.nativeInputGate?.eventName, "gongJiOrFaShu");
			assert.equal(snapshot.nativeInputGate?.eventStep, 0);
			assert.equal(snapshot.nativeInputGate?.parentEventName, "xingDong");
			assert.equal(snapshot.nativeInputGate?.seatId, snapshot.firstActSeatId);
			assert.equal(snapshot.nativeInputGate?.eventShapeSupported, true);
			assert.equal(snapshot.nativeInputGate?.nativeCandidateMappingCount, snapshot.nativeInputGate?.nativeTargetFilterPassCount);
			assert.equal(snapshot.nativeInputGate?.gateBeforeAiBranch, true);
			assert.equal(snapshot.nativeInputGate?.nativeAiResultPending, false);
			assert.equal(snapshot.nativeInputGate?.offlineAiPrevented, true);
			assert.equal(snapshot.nativeInputGate?.eventIsMine, false);
			assert.equal(snapshot.nativeInputGate?.eventIsOnline, false);
			assert.equal(snapshot.hostPlayerAbsent, true);
			assert.equal(snapshot.seats.length, 4);
			assert.ok(snapshot.seats.every(seat => Number.isSafeInteger(seat.handCount) && seat.handCount >= 0));
		} else {
			assert.equal(outcome.classification, "native_promise_pending_cdp_responsive");
			assert.equal(snapshot.nativeInputGate?.eventName, "gongJiOrFaShu");
			assert.equal(snapshot.nativeInputGate?.parentEventName, "xingDong");
			assert.equal(snapshot.nativeInputGate?.eventShapeSupported, true);
			assert.equal(snapshot.nativeInputGate?.waiting, true);
			assert.ok(snapshot.nativeInputGate?.candidates?.length > 0, "native input gate has no safe card/target candidates");
			assert.equal(snapshot.nativeInputGate?.offlineAiPrevented, true);
			assert.equal(snapshot.hostPlayerAbsent, true);
			if (probeMode === "managed_input_resume") {
				const candidate = snapshot.nativeInputGate.candidates[0];
				const rejectNativeInput = async input => {
					const priorCount = nativeDiagnostic.filter(entry => entry?.stage === "native_input_resume_rejected").length;
					assert.equal((await manager.resumeNativeInput(roomId, input)).ok, true);
					await until(() => nativeDiagnostic.filter(entry => entry?.stage === "native_input_resume_rejected").length > priorCount, 5000,
						() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), gate: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot?.nativeInputGate || null }));
				};
				await rejectNativeInput({ nativeEventId: `${snapshot.nativeInputGate.nativeEventId}_stale`, seatId: snapshot.nativeInputGate.seatId, optionId: candidate.optionId });
				await rejectNativeInput({ nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: "wrong_seat", optionId: candidate.optionId });
				await rejectNativeInput({ nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: "forged_option" });
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: candidate.optionId })).ok, true);
				const applied = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_event_completed" && entry.snapshot?.eventFinished === true), 15000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null, host: manager.inspect(roomId) }));
				assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1);
				assert.equal(applied.snapshot?.nativeAction?.useResultChildName, "useCard");
				assert.equal(applied.snapshot?.nativeAction?.status, "native_child_wait_completed");
				assert.equal(applied.snapshot?.nativeAction?.nativeEventInstanceMatches, true);
				assert.ok(applied.snapshot?.nativeAction?.nativeEventStepAfterWait >= 5);
				assert.equal(applied.snapshot?.nativeAction?.cardInHandAfterNativeWait, false);
				assert.notEqual(applied.snapshot?.nativeAction?.cardPositionAfterNativeWait, "h");
				assert.equal(applied.snapshot?.nativeInputGateStatus, "accepted");
				assert.equal(applied.snapshot?.nativeInputGate?.nativeResumeCount, 1);
				assert.equal(applied.snapshot?.nativeInputGate?.nativeSendCount, 1);
				assert.equal(applied.snapshot?.hostPlayerAbsent, true);
				assert.equal(applied.snapshot?.paused, false);
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: candidate.optionId })).ok, true);
				const rejectedReplay = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_resume_rejected"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				assert.equal(rejectedReplay.failureCode, "NATIVE_INPUT_RESUME_REJECTED");
				assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1);
				assert.equal(applied.snapshot?.nativeInputGate?.nativeResumeCount, 1);
			} else if (probeMode === "managed_input_timeout") {
				const expired = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_gate_expired"), 6000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				assert.equal(expired.snapshot?.nativeInputGateStatus, "expired");
				assert.equal(expired.snapshot?.nativeInputGate?.failureCode, "NATIVE_INPUT_DEADLINE_EXPIRED");
				assert.equal(expired.snapshot?.nativeInputGate?.engineResumeCount, 1);
				assert.equal(expired.snapshot?.nativeAction, null);
				assert.equal(expired.snapshot?.hostPlayerAbsent, true);
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: snapshot.nativeInputGate.candidates[0].optionId })).ok, true);
				const rejectedLateInput = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_resume_rejected"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				assert.equal(rejectedLateInput.failureCode, "NATIVE_INPUT_BINDING_REJECTED");
			} else if (probeMode === "managed_input_cancel") {
				assert.equal((await manager.cancelNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId })).ok, true);
				const cancelled = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_cancelled"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				assert.equal(cancelled.snapshot?.eventName, "gongJiOrFaShu");
				assert.equal(cancelled.snapshot?.parentEventName, "xingDong");
				assert.equal(cancelled.snapshot?.useResultCount, 0);
				assert.equal(cancelled.snapshot?.engineResumeCount, 1);
				assert.equal(cancelled.snapshot?.gameMeAbsent, true);
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: snapshot.nativeInputGate.candidates[0].optionId })).ok, true);
				const rejectedCancelled = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_resume_rejected"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				assert.equal(rejectedCancelled.failureCode, "NATIVE_INPUT_RESUME_REJECTED");
			} else if (probeMode === "managed_input_cancel_resume_race") {
				const commands = await Promise.all([
					manager.cancelNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId }),
					manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: snapshot.nativeInputGate.candidates[0].optionId }),
				]);
				assert.ok(commands.every(result => result.ok), "both messages should reach the serialized managed-host command queue");
				const cancelled = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_cancelled"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				const rejectedResume = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_input_resume_rejected"), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
				assert.equal(cancelled.snapshot?.gateStatus, "cancelled");
				assert.equal(cancelled.snapshot?.engineResumeCount, 1);
				assert.equal(cancelled.snapshot?.useResultCount, 0);
				assert.equal(cancelled.snapshot?.gameMeAbsent, true);
				assert.equal(rejectedResume.failureCode, "NATIVE_INPUT_RESUME_REJECTED");
			} else {
				assert.equal((await manager.stop(roomId, "pending_native_input_stop_test")).ok, true);
				assert.equal(manager.inspect(roomId)?.state, "stopped");
			}
		}
		const trace = nativeDiagnostic.filter(entry => entry?.kind === "native_start_diagnostic");
		t.diagnostic(`native start probe (${probeMode}): ${JSON.stringify(safeNativeDiagnostic({ controlledBlock: controlled.classification, outcome: outcome.classification,
			traceStages: trace.map(entry => entry.stage), lastSnapshot: trace.filter(entry => entry.snapshot).at(-1)?.snapshot || null,
			failureCode: outcome.failureCode || null }))}`);
		if (probeMode !== "managed_input_stop") {
			const stopResult = await manager.stop(roomId, "native_start_diagnostic_complete");
			assert.equal(stopResult.ok, true, `diagnostic cleanup stop rejected: ${JSON.stringify({ stopCode: stopResult.code || null,
				session: manager.inspect(roomId), sessionEnds: sessionEnds.slice(-3), handlerFailures: managedChoiceHandlerFailures.slice(-4),
				authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })),
				event5CandidateReceived: Boolean(event5CandidateMessage), event5ChoiceOpened: Boolean(event5Choice), nativeStages: nativeDiagnostic.slice(-20).map(entry => entry?.stage) })}`);
		}
	}
});
