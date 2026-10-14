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
	let manager, controller, sessionSecret, opened = [], candidatesSeen, dropAcks = true, droppedAcks = 0, nativeDiagnostic = [], ackCount = 0, deliveryCount = 0;
	controller = createManagedChoiceController({
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
			} else if (type === "host_choice_ack") {
				ackCount++;
				if (dropAcks) { droppedAcks++; return; }
				assert.equal(controller.acknowledgeDelivery({ ...message, hostSessionId: message.sessionId, hostProof: sessionSecret }).ok, true);
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
	assert.equal(droppedAcks, 4);
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
		const probeMode = ["managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_stop"].includes(process.env.V2_NATIVE_START_PROBE_MODE) ? process.env.V2_NATIVE_START_PROBE_MODE : "native_start";
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
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: `${snapshot.nativeInputGate.nativeEventId}_stale`, seatId: snapshot.nativeInputGate.seatId, optionId: candidate.optionId })).ok, true);
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: "wrong_seat", optionId: candidate.optionId })).ok, true);
				assert.equal((await manager.resumeNativeInput(roomId, { nativeEventId: snapshot.nativeInputGate.nativeEventId, seatId: snapshot.nativeInputGate.seatId, optionId: "forged_option" })).ok, true);
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
