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
	const old = Object.fromEntries(["V2_GAME_ORIGIN", "V2_PLAYABLE_PROOF", "V2_MANAGED_CHOICE_IPC"].map(key => [key, process.env[key]]));
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
});
