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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "game/v2-managed-chromium-host.mjs");
const active = typeof process.env.V2_CHROMIUM === "string" && path.isAbsolute(process.env.V2_CHROMIUM);
const roomId = "native_choice_room";
const setup = { mode: "xingBei", config: { playerCount: 4 }, seats: Array.from({ length: 4 }, (_, position) => ({ seatId: `native_seat_${position + 1}`, position })) };

async function until(check, timeoutMs = 45000, diagnostic = () => null) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`condition timeout:${JSON.stringify(diagnostic())}`);
}

test("managed Chromium applies four native Xingbei choices through authenticated controller IPC", { skip: !active, timeout: 90000 }, async t => {
	const server = await createV2NativeModuleTestServer({ root });
	t.after(() => server.close());
	const old = Object.fromEntries(["V2_GAME_ORIGIN", "V2_PLAYABLE_PROOF", "V2_MANAGED_CHOICE_IPC", "V2_NATIVE_START_DIAGNOSTICS"].map(key => [key, process.env[key]]));
	Object.assign(process.env, { V2_GAME_ORIGIN: server.origin, V2_PLAYABLE_PROOF: "1", V2_MANAGED_CHOICE_IPC: "1" });
	t.after(() => { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; });
	let manager, controller, sessionSecret, opened = [], candidatesSeen, nativeActionChoice = null, nativeActionCandidate = null, dropAcks = true, dropNativeActionAckOnce = true, nativeActionAckDropped = false, droppedAcks = 0, nativeDiagnostic = [], ackCount = 0, deliveryCount = 0;
	controller = createManagedChoiceController({
		deliveryRetryMs: 3000,
		isHostSessionActive: (candidateRoom, sessionId) => manager?.inspect(candidateRoom)?.sessionId === sessionId && manager.inspect(candidateRoom)?.state === "playable_probe",
		authorizeManagedHost: message => message.hostProof === sessionSecret,
		authorizeSeatBinding: message => message.serverProof === message.connectionId,
		authenticateSeat: (message, record) => message.credential === `credential_${record.seatId}`,
		onResolved: choice => { deliveryCount++; return manager.sendChoiceDelivery(roomId, choice).then(result => result.ok); },
	});
	manager = createHostSessionManager({
		launch: createManagedHostProcessLauncher({ script, stopTimeoutMs: 3000 }),
		browserReadyTimeoutMs: 20000, engineReadyTimeoutMs: 30000, gameReadyTimeoutMs: 30000,
		onManagedChoiceMessage: ({ type, message }) => {
			if (type === "host_choice_candidates") {
				sessionSecret = message.secret;
				candidatesSeen = message.choices;
				for (const candidate of message.choices) {
					const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
						seatId: candidate.seatId, eventSequence: message.eventSequence, options: candidate.options, trusteeOption: candidate.options[0],
						deadlineAt: Date.now() + 3000, hostProof: sessionSecret });
					assert.equal(openedChoice.ok, true); opened.push(openedChoice.choice);
					assert.equal(controller.bindSeatConnection({ roomId, seatId: candidate.seatId, connectionId: `conn_${candidate.seatId}`, serverProof: `conn_${candidate.seatId}` }).ok, true);
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
				nativeActionCandidate = message;
				const openedChoice = controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
					deadlineAt: Date.now() + Math.min(5000, message.deadlineMs), hostProof: message.secret });
				assert.equal(openedChoice.ok, true); nativeActionChoice = openedChoice.choice;
				assert.equal(controller.openChoice({ protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, options: message.options, trusteeOption: message.trusteeOption,
					deadlineAt: Date.now() + 5000, hostProof: message.secret }).code, "MANAGED_CHOICE_NATIVE_EVENT_EXISTS");
				const oldConnectionId = `old_${message.seatId}`, connectionId = `action_${message.seatId}`;
				assert.equal(controller.bindSeatConnection({ roomId, seatId: message.seatId, connectionId: oldConnectionId, serverProof: oldConnectionId }).ok, true);
				const request = { protocol: 1, roomId, hostSessionId: message.sessionId, nativeEventId: message.nativeEventId,
					seatId: message.seatId, eventSequence: message.eventSequence, choiceId: openedChoice.choice.choiceId, connectionId: oldConnectionId,
					credential: `credential_${message.seatId}`, option: message.options.at(-1) };
				assert.equal(controller.submitChoice({ ...request, seatId: "wrong_seat" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, nativeEventId: `${message.nativeEventId}_stale` }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, eventSequence: message.eventSequence + 1 }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.submitChoice({ ...request, option: "forged_native_option" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				assert.equal(controller.bindSeatConnection({ roomId, seatId: message.seatId, connectionId, serverProof: connectionId }).ok, true);
				assert.equal(controller.submitChoice(request).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				if (process.env.V2_NATIVE_START_PROBE_MODE !== "managed_input_controller_trustee") {
					const accepted = { ...request, connectionId };
					assert.equal(controller.submitChoice(accepted).ok, true);
					assert.equal(controller.submitChoice(accepted).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
				}
			} else if (type === "host_choice_ack") {
				ackCount++;
				if (dropAcks) { droppedAcks++; return; }
				if (nativeActionChoice && message.choiceId === nativeActionChoice.choiceId) {
					if (dropNativeActionAckOnce) { dropNativeActionAckOnce = false; nativeActionAckDropped = true; return; }
					assert.equal(message.nativeApplied, true, "native action ACK lacked post-child-wait evidence");
					const beforeAck = controller.inspect(roomId, message.choiceId);
					const acked = controller.acknowledgeDelivery({ ...message, hostSessionId: message.sessionId, hostProof: sessionSecret });
					if (beforeAck?.state === "resolved") assert.equal(acked.code, "MANAGED_CHOICE_ACK_REJECTED");
					else assert.equal(acked.ok, true, `native action ACK rejected: ${acked.code}`);
				} else {
					const beforeAck = controller.inspect(roomId, message.choiceId);
					const acked = controller.acknowledgeDelivery({ ...message, hostSessionId: message.sessionId, hostProof: sessionSecret });
					if (beforeAck?.state === "resolved") assert.equal(acked.code, "MANAGED_CHOICE_ACK_REJECTED");
					else assert.equal(acked.ok, true, `choice ACK rejected: ${acked.code}`);
				}
			} else if (type === "host_choice_diagnostic") {
			 nativeDiagnostic.push(message.observed);
			}
		},
	});
	t.after(() => manager.stop(roomId, "test_cleanup"));
	assert.equal((await manager.start(roomId, setup)).ok, true);
	await until(() => {
		const current = manager.inspect(roomId);
		if (current?.state === "failed") throw new Error(`native choice host failed: ${current.failureCode}:${JSON.stringify(nativeDiagnostic)}`);
		return opened.length === 4;
	}, 15000);
	assert.ok(candidatesSeen.every(choice => choice.options.length >= 2));
	const [a, b, c, d] = opened;
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: a.hostSessionId, nativeEventId: a.nativeEventId, seatId: a.seatId, eventSequence: 2, choiceId: a.choiceId, connectionId: `conn_${a.seatId}`, credential: `credential_${a.seatId}`, option: a.options[1] }).ok, true);
	assert.equal(controller.bindSeatConnection({ roomId, seatId: c.seatId, connectionId: `new_${c.seatId}`, serverProof: `new_${c.seatId}` }).ok, true);
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: c.hostSessionId, nativeEventId: c.nativeEventId, seatId: c.seatId, eventSequence: 2, choiceId: c.choiceId, connectionId: `conn_${c.seatId}`, credential: `credential_${c.seatId}`, option: c.options[0] }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: c.hostSessionId, nativeEventId: c.nativeEventId, seatId: c.seatId, eventSequence: 2, choiceId: c.choiceId, connectionId: `new_${c.seatId}`, credential: `credential_${c.seatId}`, option: c.options[0] }).ok, true);
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: d.hostSessionId, nativeEventId: d.nativeEventId, seatId: d.seatId, eventSequence: 2, choiceId: d.choiceId, connectionId: `conn_${d.seatId}`, credential: `credential_${d.seatId}`, option: "forged" }).code, "MANAGED_CHOICE_SUBMIT_REJECTED");
	assert.equal(controller.submitChoice({ protocol: 1, roomId, hostSessionId: d.hostSessionId, nativeEventId: d.nativeEventId, seatId: d.seatId, eventSequence: 2, choiceId: d.choiceId, connectionId: `conn_${d.seatId}`, credential: `credential_${d.seatId}`, option: d.options[0] }).ok, true);
	const completed = await until(() => {
		const session = manager.inspect(roomId);
		if (session?.state === "failed") throw new Error(`native choice failed:${JSON.stringify({ failureCode: session.failureCode, state: session.state, opened: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), droppedAcks, nativeDiagnostic })}`);
		return session?.authorityStateRevision === 2 && session;
	}, 45000, () => ({ session: manager.inspect(roomId), choices: opened.map(choice => controller.inspect(roomId, choice.choiceId)?.state), deliveryCount, ackCount, droppedAcks, nativeDiagnostic }));
	assert.ok(droppedAcks >= 4, `expected initial ACK loss plus bounded automatic retries, got ${droppedAcks}`);
	// Simulate lost parent-side ACK processing. Retry uses the unchanged delivery
	// IDs; Chromium must acknowledge the already-applied native result without
	// running `event.sendback` or Player.init a second time.
	dropAcks = false;
	for (const choice of opened) assert.equal(controller.retryDelivery({ roomId, choiceId: choice.choiceId }).ok, true);
	await until(() => opened.every(choice => controller.inspect(roomId, choice.choiceId)?.state === "resolved"));
	assert.equal(completed.state, "playable_probe");
	assert.deepEqual(completed.lastAuthorityEvent, { sequence: 2, name: "chooseCharacterOL" });
	assert.equal(controller.inspect(roomId, a.choiceId).resolution.option, a.options[1]);
	assert.equal(controller.inspect(roomId, b.choiceId).resolution.kind, "trustee");
	assert.equal(controller.inspect(roomId, d.choiceId).state, "resolved");
	if (process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		const probeMode = ["managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee"].includes(process.env.V2_NATIVE_START_PROBE_MODE) ? process.env.V2_NATIVE_START_PROBE_MODE : "native_start";
		assert.equal((await manager.diagnoseNativeStart(roomId, "controlled_block")).ok, true);
		const controlled = await until(() => nativeDiagnostic.find(entry => entry?.stage === "controlled_block_outcome"), 5000,
			() => ({ stages: nativeDiagnostic.map(entry => entry?.stage) }));
		assert.equal(controlled.classification, "cdp_command_timeout");
		assert.equal((await manager.diagnoseNativeStart(roomId, probeMode)).ok, true);
		const outcome = await until(() => nativeDiagnostic.find(entry =>
			["native_start_probe_outcome", "native_start_root_evaluation_outcome", "native_start_diagnostic_rejected"].includes(entry?.stage)), 5000,
			() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), failures: nativeDiagnostic.map(entry => entry?.failureCode), hostAlive: manager.inspect(roomId)?.state }));
		assert.ok(["native_promise_pending_cdp_responsive", "native_exception_observed", "native_root_fulfilled", "explicit_exception",
			"javascript_loop_starvation_suspected", "undetermined", "chromium_exit"].includes(outcome.classification));
		const snapshot = outcome.snapshot;
		assert.ok(snapshot, `native startup state was not observable: ${JSON.stringify(outcome)}`);
		t.diagnostic(`native startup pre-assert (${probeMode}): ${JSON.stringify(outcome)}`);
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
		} else if (["managed_input_controller", "managed_input_controller_trustee"].includes(probeMode)) {
			assert.equal(outcome.classification, "native_promise_pending_cdp_responsive");
			assert.equal(snapshot.nativeInputGate?.eventName, "gongJiOrFaShu");
			assert.equal(snapshot.nativeInputGate?.parentEventName, "xingDong");
			assert.equal(snapshot.nativeInputGate?.waiting, true);
			assert.equal(snapshot.nativeInputGate?.gameMeAbsent, true);
			assert.ok(nativeActionChoice);
			assert.ok(nativeActionCandidate?.options.length > 1);
			const applied = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_child_wait_completed"), 15000,
				() => ({ stages: nativeDiagnostic.map(entry => entry?.stage), choice: nativeActionChoice && controller.inspect(roomId, nativeActionChoice.choiceId), latest: nativeDiagnostic.filter(entry => entry?.snapshot).at(-1)?.snapshot || null }));
			assert.equal(applied.snapshot?.nativeAction?.useResultCount, 1);
			assert.equal(applied.snapshot?.nativeAction?.useResultChildName, "useCard");
			assert.equal(applied.snapshot?.nativeAction?.nativeChildWaitCompleted, true);
			assert.equal(applied.snapshot?.nativeAction?.nativeEventInstanceMatches, true);
			assert.equal(applied.snapshot?.nativeAction?.cardInHandAfterNativeWait, false);
			assert.notEqual(applied.snapshot?.nativeAction?.cardPositionAfterNativeWait, "h");
			assert.equal(applied.snapshot?.nativeAction?.result?.cardsCount, 1);
			assert.equal(applied.snapshot?.nativeAction?.result?.targetCount, 1);
			assert.equal(applied.snapshot?.nativeAction?.result?.cardName, applied.snapshot?.nativeAction?.cardName);
			assert.ok(setup.seats.some(seat => seat.seatId === applied.snapshot?.nativeAction?.targetSeatId));
			assert.equal(applied.snapshot?.nativeInputGate?.nativeResumeCount || 0, 0, "controller path must not use the test-only direct resume command");
			assert.equal(applied.snapshot?.hostPlayerAbsent, true);
			assert.equal(applied.snapshot?.seats?.length, 4);
			await until(() => controller.inspect(roomId, nativeActionChoice.choiceId)?.state === "resolved", 15000,
				() => ({ choice: controller.inspect(roomId, nativeActionChoice.choiceId), host: manager.inspect(roomId), stages: nativeDiagnostic.map(entry => entry?.stage) }));
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).resolution.kind,
				probeMode === "managed_input_controller_trustee" ? "trustee" : "player");
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).resolution.option,
				probeMode === "managed_input_controller_trustee" ? nativeActionCandidate.trusteeOption : nativeActionCandidate.options.at(-1));
			assert.equal(applied.snapshot?.nativeAction?.optionId, controller.inspect(roomId, nativeActionChoice.choiceId).resolution.option,
				"native engine applied an option other than the controller resolution");
			assert.equal(nativeActionAckDropped, true);
			assert.ok(controller.inspect(roomId, nativeActionChoice.choiceId).deliveryAttempts >= 2, "ACK loss did not trigger an automatic stable-delivery retry");
			assert.equal(manager.inspect(roomId)?.authorityStateRevision, 2, "B2 native operation must not masquerade as authority Event #4");
			assert.equal(controller.inspect(roomId, nativeActionChoice.choiceId).deliveryId, `delivery_${nativeActionChoice.choiceId}`);
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
				const applied = await until(() => nativeDiagnostic.find(entry => entry?.stage === "native_action_child_wait_completed" && entry.snapshot?.nativeAction?.nativeEventStepAfterWait >= 5), 15000,
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
			} else {
				assert.equal((await manager.stop(roomId, "pending_native_input_stop_test")).ok, true);
				assert.equal(manager.inspect(roomId)?.state, "stopped");
			}
		}
		const trace = nativeDiagnostic.filter(entry => entry?.kind === "native_start_diagnostic");
		t.diagnostic(`native start probe (${probeMode}): ${JSON.stringify({ controlledBlock: controlled.classification, outcome: outcome.classification,
			traceStages: trace.map(entry => entry.stage), lastSnapshot: trace.filter(entry => entry.snapshot).at(-1)?.snapshot || null,
			failureCode: outcome.failureCode || null })}`);
		if (probeMode !== "managed_input_stop") assert.equal((await manager.stop(roomId, "native_start_diagnostic_complete")).ok, true);
	}
});
