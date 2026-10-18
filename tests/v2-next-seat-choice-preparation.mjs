import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { prepareNextSeatChoice } = require("../game/server-managed-next-seat-choice-preparation.js");
const seats = ["seat_a", "seat_b", "seat_c", "seat_d"];
const nativeFence = () => {
	const eventStack = ["game", "phaseLoop", "phase", "xingDong", "gongJiOrFaShu"];
	const parents = [null, "game", "phaseLoop", "phase", "xingDong"];
	return { stage: "native_input_wait_open", rootInstanceId: `native_root_${"b".repeat(32)}`, rootObjectMatches: true, paused: true, gameMeAbsent: true,
		currentEventName: "gongJiOrFaShu", currentEventStep: 3, currentSeatId: "seat_b", eventStack,
		eventStackDetails: eventStack.map((eventName, index) => ({ eventName, parentEventName: parents[index], seatId: index === 0 ? null : "seat_b",
			finished: false, nextCount: index < 4 ? 1 : 0, nextHeadName: index < 4 ? eventStack[index + 1] : null, nextHeadFinished: false })),
		nativeInputGate: { diagnosticOnly: true, eventName: "gongJiOrFaShu", nativeEventId: `native_event_${"d".repeat(32)}`,
			seatId: "seat_b", action: true, waiting: true } };
};
const base = () => ({
	candidate: { roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, rootInstanceId: `native_root_${"b".repeat(32)}`,
		engineBuildId: "c".repeat(64), seatIds: [...seats], nativeEventId: `native_event_${"d".repeat(32)}`,
		eventName: "gongJiOrFaShu", parentEventName: "xingDong", seatId: "seat_b",
		options: [`native_option_${"1".repeat(32)}`, `native_option_${"2".repeat(32)}`],
		optionKinds: { [`native_option_${"1".repeat(32)}`]: "gongJi", [`native_option_${"2".repeat(32)}`]: "faShu" },
		waiting: true, diagnosticOnly: true },
	authorityTip: { revision: 4, nextSequence: 5, lastSequence: 4, event5Accepted: false, checkpointAvailable: false },
	seatBinding: { roomId: "room_a", seatId: "seat_b", connectionId: "socket_b_2", connectionGeneration: 2,
		connected: true, current: true, credentialAuthenticated: true, ordinaryPlayer: true },
	priorChoice: { roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, nativeEventId: `native_event_${"e".repeat(32)}`,
		seatId: "seat_a", state: "resolved", deadlineActive: false, deliveryActive: false },
	managedContext: { roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, rootInstanceId: `native_root_${"b".repeat(32)}`,
		engineBuildId: "c".repeat(64), seatIds: [...seats] },
	expectedNextSeatId: "seat_b", previousActorSeatId: "seat_a", seatIds: [...seats], hostProcessStable: true,
	chromiumProcessStable: true, nativeFenceEvidence: nativeFence(),
});

test("next-seat preparation yields only an immutable read-only candidate, not a managed choice", () => {
	const result = prepareNextSeatChoice(base());
	assert.equal(result.ok, true);
	assert.deepEqual(result.preparation, { schema: "xingbei_next_seat_choice_preparation_v1", readOnly: true, sideEffectFree: true,
		roomId: "room_a", hostSessionId: `hs_${"a".repeat(32)}`, rootInstanceId: `native_root_${"b".repeat(32)}`,
		engineBuildId: "c".repeat(64), seatIds: seats, seatId: "seat_b", connectionGeneration: 2,
		nativeEventId: `native_event_${"d".repeat(32)}`, eventName: "gongJiOrFaShu", parentEventName: "xingDong",
		options: [`native_option_${"1".repeat(32)}`, `native_option_${"2".repeat(32)}`],
		optionKinds: { [`native_option_${"1".repeat(32)}`]: "gongJi", [`native_option_${"2".repeat(32)}`]: "faShu" },
		authorityRevision: 4, nextAuthorityEventSequence: 5, choiceAllocated: false, deadlineAllocated: false,
		deliveryAllocated: false, nativeDeliveryAllowed: false, authoritySubmissionAllowed: false });
	assert.equal(Object.hasOwn(result.preparation, "choiceId"), false);
	assert.equal(Object.hasOwn(result.preparation, "deadlineAt"), false);
	assert.equal(Object.hasOwn(result.preparation, "deliveryId"), false);
});

test("next-seat preparation rejects prior actor, stale seat generation, administrator identity and changed native event", () => {
	for (const mutate of [
		input => { input.candidate.seatId = "seat_a"; },
		input => { input.seatBinding.connectionGeneration = 1; input.seatBinding.current = false; },
		input => { input.seatBinding.ordinaryPlayer = false; },
		input => { input.candidate.nativeEventId = input.priorChoice.nativeEventId; },
	]) assert.equal(prepareNextSeatChoice((() => { const input = base(); mutate(input); return input; })()).ok, false);
});

test("next-seat preparation rejects missing or malformed native fence evidence and altered authority continuations", () => {
	for (const mutate of [
		input => { input.authorityTip.revision = 5; },
		input => { input.authorityTip.event5Accepted = true; },
		input => { input.nativeFenceEvidence.paused = false; },
		input => { input.nativeFenceEvidence.eventStackDetails[2].nextCount = 2; },
		input => { input.nativeFenceEvidence.eventStackDetails[3].nextHeadName = "unrelatedEvent"; },
		input => { input.nativeFenceEvidence.eventStackDetails[4].nextCount = 1; },
		input => { input.nativeFenceEvidence.nativeInputGate.waiting = false; },
		input => { input.nativeFenceEvidence.nativeInputGate.nativeEventId = `native_event_${"f".repeat(32)}`; },
		input => { input.priorChoice.deliveryActive = true; },
		input => { input.candidate.optionKinds[input.candidate.options[0]] = "arbitrary"; },
	]) assert.equal(prepareNextSeatChoice((() => { const input = base(); mutate(input); return input; })()).ok, false);
});

test("next-seat preparation rejects malformed and cross-root/session/seat evidence", () => {
	for (const mutate of [
		input => { input.candidate.rootInstanceId = `native_root_${"f".repeat(32)}`; },
		input => { input.candidate.hostSessionId = `hs_${"f".repeat(32)}`; },
		input => { input.candidate.seatIds.reverse(); },
		input => { input.managedContext.rootInstanceId = `native_root_${"f".repeat(32)}`; },
		input => { input.seatBinding.roomId = "other_room"; },
		input => { input.candidate.waiting = false; },
		input => { input.candidate.diagnosticOnly = false; },
	]) assert.equal(prepareNextSeatChoice((() => { const input = base(); mutate(input); return input; })()).ok, false);
});
