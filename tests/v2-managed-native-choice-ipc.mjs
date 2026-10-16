import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createV2NativeModuleTestServer } from "./fixtures/v2-native-module-test-server.mjs";

const require = createRequire(import.meta.url);
const { createHostSessionManager } = require("../game/server-host-session-manager.js");
const { createManagedHostProcessLauncher } = require("../game/server-managed-host-launcher.js");
const { createManagedChoiceController } = require("../game/server-managed-choice-controller.js");
const { createManagedRoomSeatRegistry } = require("../game/server-managed-room-seat-registry.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "game/v2-managed-chromium-host.mjs");
const active = typeof process.env.V2_CHROMIUM === "string" && path.isAbsolute(process.env.V2_CHROMIUM);
const roomId = "native_choice_room";
const setup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `native_seat_${position + 1}`, position })) };
const viewasRevalidationFaultModes = ["viewas_material_removed_before_revalidation", "viewas_skill_removed_before_revalidation", "viewas_condition_invalid_before_revalidation"];
const viewasExecutionFaultModes = ["viewas_result_assignment_throws", "viewas_useCard_child_throws", "viewas_partial_effect_throws", "viewas_partial_effect_stop"];

async function until(check, timeoutMs = 45000, diagnostic = () => null) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`condition timeout:${JSON.stringify(diagnostic())}`);
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

test("managed Chromium applies four native Xingbei choices through authenticated controller IPC", { skip: !active, timeout: 90000 }, async t => {
	const server = await createV2NativeModuleTestServer({ root });
	t.after(() => server.close());
	const old = Object.fromEntries(["V2_GAME_ORIGIN", "V2_PLAYABLE_PROOF", "V2_MANAGED_CHOICE_IPC", "V2_NATIVE_START_DIAGNOSTICS", "V2_NATIVE_PARENT_FENCE_AUDIT", "V2_NATIVE_PARENT_FENCE", "V2_NATIVE_REJECT_PARENT_FENCE_EVENT4", "V2_MANAGED_NATIVE_FAULT_INJECTION", "V2_NATIVE_OPENING_DRAW_EVENT3", "V2_NATIVE_REJECT_OPENING_DRAW_EVENT3", "V2_NATIVE_C3_UNIFIED_ROOT", "V2_NATIVE_TEST_RANDOM_SEED", "V2_NATIVE_ACTION_KIND", "V2_NATIVE_YINYANG_FIXTURE", "V2_NATIVE_YINYANG_VIEWAS_PROBE", "V2_NATIVE_MANAGED_YINYANG", "V2_TEST_BLOCK_EXTERNAL_NETWORK", "V2_TEST_MATCH_RECORD_POST"].map(key => [key, process.env[key]]));
	Object.assign(process.env, { V2_GAME_ORIGIN: server.origin, V2_PLAYABLE_PROOF: "1", V2_MANAGED_CHOICE_IPC: "1", V2_TEST_BLOCK_EXTERNAL_NETWORK: "1" });
	if (process.env.V2_NATIVE_START_PROBE_MODE === "managed_input_controller_fault_before_apply") process.env.V2_MANAGED_NATIVE_FAULT_INJECTION = "before_native_apply";
	const nativeFaultMode = process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "";
	t.after(() => { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; });
	let manager, controller, sessionSecret, engineReadyProof = null, opened = [], candidatesSeen, nativeYinYangFixtureSeatId = null, nativeActionChoice = null, nativeActionCandidate = null, nativeActionOptionId = null, nativeNoOptionCandidateAvailable = false, nativeResponseChoice = null, nativeResponseCandidate = null, nativeResponseOptionId = null, nativeResponseChoices = [], nativeResponseAccepted = false, nativeResponseAckCount = 0, nativeResponseAckResults = [], nativeResponseAckAttempts = new Map(), droppedNativeResponseAckChoiceId = null, nativeResponseAckDropped = false, dropNativeResponseAckOnce = process.env.V2_NATIVE_RESPONSE_ACK_LOSS === "1", event3Proof = null, dropAcks = process.env.V2_NATIVE_REJECT_OPENING_DRAW_EVENT3 !== "1", dropNativeActionAckOnce = true, nativeActionAckDropped = false, droppedAcks = 0, nativeDiagnostic = [], ackCount = 0, nativeActionAckCount = 0, deliveryCount = 0, deliveryFailures = [], sessionEnds = [], applyingReceipts = [], applyingRetryIssued = false, viewasRedeliveryIssued = false, viewasRedeliveryIdentity = null, viewasBarrierReleasePromise = null, viewasBarrierReleased = false, nativeFaultStopPromise = null, event4AckDropCount = 0, event4SubmissionCount = 0, event4ProofSubmissions = [], event4AckBarrierWaitCount = 0, event4AckBarrierReleased = false, event4AuthorityJoinCount = 0, event4ControllerRetryTriggered = false, event4AckSendErrors = [], duplicateEvent4AuthorityAckSent = false, ackTrace = [];
	const droppedChoiceAckIds = new Set();
	const authoritySubmissions = [];
	let releaseEvent4AckBarrier;
	const event4AckBarrier = new Promise(resolve => { releaseEvent4AckBarrier = resolve; });
	const launchedHandles = new Map();
	const useSeatRegistry = process.env.V2_NATIVE_START_PROBE_MODE === "managed_input_controller_registry" ||
		process.env.V2_NATIVE_RESPONSE_REBIND === "1";
	const seatRegistry = useSeatRegistry ? createManagedRoomSeatRegistry() : null;
	const seatCredentials = new Map(), seatSockets = new Map();
	if (seatRegistry) {
		assert.equal(seatRegistry.createRoom(roomId, setup.seats.map(seat => seat.seatId)), true);
		for (const seat of setup.seats) seatCredentials.set(seat.seatId, seatRegistry.issueSeat(roomId, seat.seatId).credential);
	}
	const credentialFor = seatId => seatCredentials.get(seatId) || `credential_${seatId}`;
	const bindSeat = (seatId, connectionId) => {
		if (!seatRegistry) return controller.bindSeatConnection({ roomId, seatId, connectionId, serverProof: connectionId });
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
		launch: async bootstrap => {
			const handle = await createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 })(bootstrap);
			launchedHandles.set(bootstrap.sessionId, handle);
			handle.on("message", message => {
				if (message?.type === "host_engine_ready") engineReadyProof = message.proof;
				if (message?.type === "host_authority_event") {
					authoritySubmissions.push({ roomId: message.roomId, sessionId: message.sessionId, proof: message.proof,
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
		browserReadyTimeoutMs: 20000, engineReadyTimeoutMs: 30000, gameReadyTimeoutMs: 30000,
		onSessionEnd: event => { sessionEnds.push({ roomId: event.roomId, sessionId: event.sessionId, state: event.state, code: event.code });
			controller.cleanupHostSession(event.roomId, event.sessionId); },
		onManagedChoiceMessage: async ({ type, message }) => {
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
				for (const candidate of message.choices) {
					const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
						seatId: candidate.seatId, eventSequence: message.eventSequence, options: candidate.options, trusteeOption: candidate.options[0],
						deadlineAt: Date.now() + 3000, hostProof: sessionSecret });
					assert.equal(openedChoice.ok, true); opened.push(openedChoice.choice);
					assert.equal(bindSeat(candidate.seatId, `conn_${candidate.seatId}`).ok, true);
				}
			} else if (type === "host_native_action_candidates") {
				sessionSecret = message.secret;
				assert.equal(message.eventName, "gongJiOrFaShu");
				assert.equal(message.eventSequence, 4, "first action choice must reserve native authority event #4 after opening-state event #3");
				assert.match(message.nativeEventId, /^native_[A-Za-z0-9_-]{16,96}$/);
				assert.equal(message.seatId, setup.seats.find(seat => seat.seatId === message.seatId)?.seatId);
				assert.ok(Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64);
				assert.equal(new Set(message.options).size, message.options.length);
				assert.ok(message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)));
				if (process.env.V2_NATIVE_ACTION_KIND) {
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
				const oldConnectionId = `old_${message.seatId}`, connectionId = `action_${message.seatId}`;
				assert.equal(bindSeat(message.seatId, oldConnectionId).ok, true);
				const request = { protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, choiceId: openedChoice.choice.choiceId, connectionId: oldConnectionId,
					credential: credentialFor(message.seatId), option: nativeActionOptionId };
				assert.equal(controller.submitChoice({ ...request, seatId: "wrong_seat" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, nativeEventId: `${message.nativeEventId}_stale` }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, eventSequence: message.eventSequence + 1 }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				if (seatRegistry) {
					const priorSession = manager.inspect(roomId);
					const priorConnectionId = seatSockets.get(message.seatId);
					assert.ok(priorConnectionId);
					assert.equal(seatRegistry.disconnect({ roomId, seatId: message.seatId, connectionId: priorConnectionId }), true,
						"ordinary player disconnect must release only its seat binding");
					assert.equal(seatRegistry.bindConnection({ roomId, seatId: message.seatId, credential: credentialFor(message.seatId),
						socket: { kind: "room_administrator", roomId, seatId: message.seatId, connectionId: "admin_action_socket" } }), null,
					"administrator socket must not take a player seat");
					assert.equal(seatRegistry.bindConnection({ roomId, seatId: message.seatId, credential: "f".repeat(64),
						socket: { kind: "player", roomId, seatId: message.seatId, connectionId: "forged_action_socket" } }), null,
					"forged credential must not bind a player seat");
					const rebound = seatRegistry.bindConnection({ roomId, seatId: message.seatId, credential: credentialFor(message.seatId),
						socket: { kind: "player", roomId, seatId: message.seatId, connectionId } });
					assert.ok(rebound, "valid credential must reclaim the disconnected seat");
					seatSockets.set(message.seatId, connectionId);
					assert.equal(controller.bindSeatConnection(rebound).ok, true);
					assert.equal(manager.inspect(roomId)?.sessionId, priorSession?.sessionId, "player rebind must not replace the host session");
					assert.equal(manager.inspect(roomId)?.pid, priorSession?.pid, "player rebind must not restart the managed host");
					assert.equal(manager.inspect(roomId)?.state, priorSession?.state, "player disconnect/rebind must leave host state active");
				} else assert.equal(bindSeat(message.seatId, connectionId).ok, true);
				assert.equal(controller.submitChoice(request).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, hostSessionId: `hs_${"b".repeat(32)}`, connectionId,
					credential: credentialFor(message.seatId) }).code, "MANAGED_CHOICE_SUBMIT_REJECTED", "stale host session must not commit player input");
				if (!["managed_input_controller_trustee", "managed_opening_root_action_event4_trustee"].includes(process.env.V2_NATIVE_START_PROBE_MODE)) {
					const accepted = { ...request, connectionId, credential: credentialFor(message.seatId), option: nativeActionOptionId };
					assert.equal(controller.submitChoice(accepted).ok, true);
					assert.equal(controller.submitChoice(accepted).code, "MANAGED_CHOICE_SUBMIT_REJECTED", "duplicate native action input must be rejected");
				}
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
				const nestedResponseProbe = process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1";
				const responseTrusteeProbe = process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1";
				if (nestedResponseProbe) {
					assert.ok(message.optionCanTriggerNestedResponse,
						"nested-response probe requires native-only response mapping metadata");
					assert.deepEqual(Object.keys(message.optionCanTriggerNestedResponse).sort(), [...message.options].sort(),
						"nested-response eligibility must be bound to the exact native option set");
					assert.ok(Object.values(message.optionCanTriggerNestedResponse).every(value => typeof value === "boolean"));
				}
				const submittedResponseOption = firstManagedResponse ? yinYangManaged ? message.options.find(option => message.optionKinds[option] === "view_as_skill" &&
					message.optionShapes[option] === "native_single_target_view_as_skill") : nestedResponseProbe ? message.options.find(option =>
					message.optionKinds[option] === "card" && message.optionCanTriggerNestedResponse[option] === true) : message.options.find(option => message.optionKinds[option] === "card" &&
					(!targetlessProbe || message.optionShapes[option] === "native_notarget_card")) : message.trusteeOption;
				if (firstManagedResponse) {
					nativeResponseOptionId = submittedResponseOption;
					assert.ok(nativeResponseOptionId, yinYangManaged ? "the native yingZhan event exposed no native YinYang viewAs candidate" : nestedResponseProbe ? `the native yingZhan event exposed no legal response whose native target can itself respond: ${JSON.stringify({
						optionKinds: message.optionKinds, optionCanTriggerNestedResponse: message.optionCanTriggerNestedResponse,
					})}` : targetlessProbe ? "the native yingZhan event exposed no legal native no-target response candidate" :
						"the native yingZhan event exposed no legal physical-card response candidate");
					if (targetlessProbe) assert.equal(message.optionShapes[nativeResponseOptionId], "native_notarget_card");
					nativeResponseCandidate = message;
					if (responseTrusteeProbe) assert.equal(message.optionKinds[message.trusteeOption], "decline",
						"response timeout must use the native optional-decline candidate as trustee");
				} else assert.equal(message.optionKinds[submittedResponseOption], "decline", "nested response trustee should decline through the native optional-choice contract");
				const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
					deadlineAt: Date.now() + Math.min(5000, message.deadlineMs), hostProof: sessionSecret });
				assert.equal(openedChoice.ok, true, `native response choice registration failed: ${openedChoice.code}`);
				if (firstManagedResponse) nativeResponseChoice = openedChoice.choice;
				nativeResponseChoices.push({ choice: openedChoice.choice, candidate: message, option: submittedResponseOption });
				const connectionId = `response_${message.seatId}`;
				assert.equal(bindSeat(message.seatId, connectionId).ok, true);
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
				const isNativeResponseAck = nativeResponseChoices.some(entry => entry.choice.choiceId === message.choiceId);
				const nativeResponseEntry = nativeResponseChoices.find(entry => entry.choice.choiceId === message.choiceId) || null;
				const isYinYangResponseAck = nativeResponseEntry?.candidate?.optionKinds?.[nativeResponseEntry.option] === "view_as_skill";
				if (isNativeResponseAck) {
					nativeResponseAckCount++;
					nativeResponseAckAttempts.set(message.choiceId, (nativeResponseAckAttempts.get(message.choiceId) || 0) + 1);
				}
				ackTrace.push({ at: Date.now(), choiceId: message.choiceId, nativeAction: nativeActionChoice?.choiceId === message.choiceId, nativeResponse: isNativeResponseAck, dropAcks,
					responseEventCompleted: message.nativeResponseEventCompleted === true,
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
				if (message.observed?.stage === "native_action_delivery_joined_authority_commit") {
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
		},
	});
	t.after(() => manager.stop(roomId, "test_cleanup"));
	assert.equal((await manager.start(roomId, setup)).ok, true);
	if (process.env.V2_TEST_MATCH_RECORD_POST === "1") {
		await until(() => engineReadyProof?.testMatchRecordPostBlocked === 1, 10000,
			() => ({ engineReady: engineReadyProof && { mode: engineReadyProof.mode, offboard: engineReadyProof.offboard,
				testMatchRecordPostBlocked: engineReadyProof.testMatchRecordPostBlocked } }));
		assert.equal(engineReadyProof.testMatchRecordPostBlocked, 1,
			"the real Xingbei match-record method must be intercepted before any external request leaves Chromium");
	}
	await until(() => {
		const current = manager.inspect(roomId);
		if (current?.state === "failed") throw new Error(`native choice host failed: ${current.failureCode}:${JSON.stringify({ nativeDiagnostic: nativeDiagnostic.slice(-18), authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })), opened: opened.map(choice => choice.choiceId) })}`);
		if (current && ["stopped", "stopping"].includes(current.state)) throw new Error(`native choice host stopped before opening choices:${JSON.stringify({
			state: current.state, code: sessionEnds.at(-1)?.code || null, failureCode: current.failureCode,
			authoritySubmissions: authoritySubmissions.map(entry => ({ sequence: entry.proof?.eventSequence, kind: entry.proof?.event?.kind })),
			openedCount: opened.length, choiceStates: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state || null),
			deliveryFailures: deliveryFailures.map(({ deliveryAttempts, code }) => ({ deliveryAttempts, code })),
			engineReady: engineReadyProof ? { browserReady: engineReadyProof.browserReady, engineReady: engineReadyProof.engineReady, mode: engineReadyProof.mode } : null,
			hostResources: launchedHandles.get(current.sessionId)?.resources().length ?? null,
		})}`);
		return opened.length === 4;
	}, 15000);
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
	if (process.env.V2_NATIVE_YINYANG_FIXTURE === "1") {
		for (const choice of opened) {
			const option = choice.options.includes("yinYangShi") && choice.seatId === nativeYinYangFixtureSeatId ? "yinYangShi" : choice.options[0];
			assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: choice.hostSessionId, nativeEventId: choice.nativeEventId,
				seatId: choice.seatId, eventSequence: 2, choiceId: choice.choiceId, connectionId: `conn_${choice.seatId}`,
				credential: credentialFor(choice.seatId), option }).ok, true, `native fixture choice rejected for ${choice.seatId}`);
		}
	} else assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: a.hostSessionId, nativeEventId: a.nativeEventId, seatId: a.seatId, eventSequence: 2, choiceId: a.choiceId, connectionId: `conn_${a.seatId}`, credential: credentialFor(a.seatId), option: a.options[1] }).ok, true);
	if (process.env.V2_NATIVE_YINYANG_FIXTURE !== "1") {
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
		(process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4") ? 4 : 3) : 2;
	const probeMode = process.env.V2_NATIVE_START_PROBE_MODE || "native_start";
	let actionDiagnosticDispatched = process.env.V2_NATIVE_C3_UNIFIED_ROOT === "1";
	let completed;
	let openingDrawAccepted = null;
	if (probeMode === "managed_opening_root_action_stop_before_release") {
		await until(() => manager.inspect(roomId)?.authorityStateRevision === 3, 45000,
			() => ({ session: manager.inspect(roomId), nativeDiagnostic }));
		assert.equal((await manager.stop(roomId, "event3_accepted_before_phase_release")).ok, true);
		assert.equal(manager.inspect(roomId)?.state, "stopped");
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
		assert.ok(event4SubmissionCount >= 1, "the altered Event #4 proof never reached the server validation boundary");
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
			if (session?.state === "failed") throw new Error(`native choice failed:${JSON.stringify({ failureCode: session.failureCode, authorityFailureReason: session.authorityFailureReason, state: session.state, opened: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), droppedAcks, responseAuthority: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("response_authority")).slice(-4), responseSummary: nativeDiagnostic.filter(entry => entry?.stage === "native_response_action_summary").slice(-3), actionAuthorityDiagnostics: nativeDiagnostic.filter(entry => ["event4_local_proof_rejected", "native_action_event_completed"].includes(entry?.stage)).slice(-4), responseStages: nativeDiagnostic.filter(entry => String(entry?.stage || "").includes("response")).slice(-8).map(entry => entry?.stage) })}`);
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
	await until(() => opened.every(choice => controller.inspect(roomId, choice.choiceId)?.state === "resolved") &&
		(!nativeActionChoice || manager.inspect(roomId)?.authorityStateRevision !== 4 || controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved"),
		15000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state || null),
			actionChoice: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), deliveryCount, ackCount, nativeActionAckCount,
			event4AckDropCount, event4SubmissionCount, event4AckBarrierWaitCount, event4ControllerRetryTriggered,
				event4AuthorityJoinCount, event4AckBarrierReleased, event4AckSendErrors, diagnostics: nativeDiagnostic.slice(-12).map(entry => entry?.stage), ackTrace: ackTrace.slice(-12) }));
	assert.equal(completed.state, "playable_probe");
	if (expectedAuthorityRevision >= 3) {
		if (expectedAuthorityRevision === 3) {
			assert.deepEqual(completed.lastAuthorityEvent, { sequence: 3, name: "gameDraw" });
			assert.equal(completed.nextAuthorityEventSequence, 4);
		} else {
			assert.deepEqual(completed.lastAuthorityEvent, { sequence: 4, name: "gongJiOrFaShu" });
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
	} else {
		assert.equal(controller.inspect(roomId, a.choiceId).resolution.option, a.options[1]);
		assert.equal(controller.inspect(roomId, b.choiceId).resolution.kind, "trustee");
		assert.equal(controller.inspect(roomId, d.choiceId).state, "resolved");
	}
	if (process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		const probeMode = ["managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(process.env.V2_NATIVE_START_PROBE_MODE) ? process.env.V2_NATIVE_START_PROBE_MODE : "native_start";
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
		} else if (["managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(probeMode)) {
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
			assert.ok(nativeActionCandidate?.options.length > 1);
			if (["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(probeMode)) {
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
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), choice: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), latest: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null }));
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
				error.message += `; diagnostic request=${JSON.stringify(requested)}; session=${JSON.stringify(sessionBeforeDiagnostic)}; deliveryFailures=${JSON.stringify(deliveryFailures)}; sessionEnds=${JSON.stringify(sessionEnds)}; nativeResponseChoices=${JSON.stringify(responseState)}; responseAckCount=${nativeResponseAckCount}; recentNativeMilestones=${JSON.stringify(safeNativeDiagnostic(nativeDiagnostic.slice(-10).map(entry => ({ stage: entry?.stage, snapshot: entry?.snapshot || null })) ))}; live native snapshot=${JSON.stringify(safeNativeDiagnostic(latest?.snapshot || null))}`;
				throw error;
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
				} else if (process.env.V2_NATIVE_MANAGED_YINYANG === "1") {
					assert.equal(nativeApplied.snapshot?.selectedKind, "view_as_skill");
					assert.equal(nativeApplied.snapshot?.skillId, "yinYangZhanHuan");
					assert.equal(nativeApplied.snapshot?.physicalMaterialConsumed, true);
					assert.equal(nativeApplied.snapshot?.xiBieApplied, true);
					assert.ok(nativeApplied.snapshot?.guiHuoDelta > 0, "native guiHuo effect must be observed after the completed useCard child");
					assert.equal(nativeApplied.snapshot?.targetCount, 1);
					assert.equal(nativeApplied.snapshot?.useCardChildrenStarted, 1);
					assert.equal(nativeApplied.snapshot?.useCardChildrenCompleted, 1);
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
					assert.ok(nativeApplied.at <= nativeResponseAck?.at,
						"the native skill effects must be observed before its response ACK reaches the controller");
					assert.ok(nativeResponseAck?.at < authorityEvent4?.receivedAt,
						`response acknowledgement ordering mismatch: ${JSON.stringify({ nativeAppliedAt: nativeApplied.at,
							responseAck: nativeResponseAck, authorityEvent4At: authorityEvent4?.receivedAt,
							nativeActionAck, responseAckAttempts: ackTrace.filter(entry => entry.choiceId === nativeResponseChoice.choiceId) })}`);
					assert.ok(authorityEvent4?.receivedAt <= nativeActionAck?.at,
						`parent action ACK ordering mismatch: ${JSON.stringify({ authorityEvent4At: authorityEvent4?.receivedAt,
							nativeActionAck, nativeActionAckAttempts: ackTrace.filter(entry => entry.nativeAction) })}`);
				} else {
					assert.equal(nativeApplied.snapshot?.selectedKind, "card");
					assert.equal(nativeApplied.snapshot?.targetCount, process.env.V2_NATIVE_RESPONSE_TARGETLESS === "1" ? 0 : 1,
						"managed response must preserve the actual native card target shape");
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
							choice: controller.inspect(roomId, nativeResponseChoice.choiceId), host: manager.inspect(roomId), ackTrace: ackTrace.slice(-8),
							responseAckCounts: nativeResponseChoices.map(entry => ({ choiceId: entry.choice.choiceId, count: nativeResponseAckAttempts.get(entry.choice.choiceId) || 0 })) }));
				}
				assert.equal(nativeResponseAckCount, nativeResponseChoices.length + (nativeResponseAckDropped ? 1 : 0),
					`each native response must ACK exactly once after its event and any useCard child completed: ${JSON.stringify({ nativeResponseChoices: nativeResponseChoices.map(entry => entry.choice.choiceId), nativeResponseAckResults, ackTrace: ackTrace.slice(-12) })}`);
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
				}
				}
			}
			await until(() => controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved", 15000,
				() => ({ choice: controller.inspect(roomId, nativeActionChoice.choiceId), host: manager.inspect(roomId), stages: nativeDiagnostic.map(entry => entry?.stage) }));
			if (process.env.V2_NATIVE_PARENT_FENCE === "1") {
				const fenceReleased = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_parent_fence_released" &&
					entry?.snapshot?.nativeEventId === nativeActionCandidate?.nativeEventId), 5000,
					() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), latest: nativeDiagnostic.slice(-12), host: manager.inspect(roomId) }));
				const hostTip = manager.inspect(roomId);
				assert.equal(fenceReleased.snapshot.status, "released");
				assert.equal(fenceReleased.snapshot.releaseCount, 1, "parent continuation must have one accepted release");
				assert.deepEqual(fenceReleased.snapshot.releaseResolution, { eventSequence: 4, stateRevision: 4,
					afterDigest: hostTip.authorityStateDigest });
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
					assert.equal(nativeDiagnostic.some(entry => entry?.snapshot?.rootObjectMatches === false), false,
						"native root object identity changed during the four-event chain");
					const actionGate = nativeDiagnostic.find(entry => entry?.stage === "native_start_probe_outcome")?.snapshot;
					assert.equal(actionGate?.rootObjectMatches, true);
					assert.equal(actionGate?.rootInstanceId, rootIds[0]);
					if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1") {
						const beforeSnapshot = nativeDiagnostic.length;
						assert.equal((await manager.snapshotNativeStart(roomId, "managed_opening_root_action_event4")).ok, true,
							"authenticated live snapshot must not restart/re-instrument the continuing native root");
						const liveSnapshot = await until(() => nativeDiagnostic.slice(beforeSnapshot).find(entry => entry?.stage === "native_start_live_snapshot"), 3000,
							() => ({ session: manager.inspect(roomId), diagnostics: nativeDiagnostic.slice(beforeSnapshot) }));
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
						assert.notEqual(audit.currentSeatId, audit.firstActSeatId,
							"after Event #4 the native root has already advanced beyond the first actor; the legacy Event #4 tip is not a current-turn snapshot");
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
		if (probeMode !== "managed_input_stop") assert.equal((await manager.stop(roomId, "native_start_diagnostic_complete")).ok, true);
	}
});
