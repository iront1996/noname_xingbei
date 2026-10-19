import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateExperimentalEvent5 } = require("../game/server-managed-authority-event5.js");
const canonicalize = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ?
	`[${value.map(canonicalize).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
const digest = value => createHash("sha256").update(canonicalize(value)).digest("hex");
const eventId = n => `native_event_${String(n).repeat(32)}`;
const rootId = `native_root_${"a".repeat(32)}`;
const opaque = n => `native_option_${String(n).repeat(32)}`;
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];

function fixture() {
	const beforeSummary = { revision: 4, predecessor: "event4", actorSeatId: "seat_a" };
	const beforeDigest = digest(beforeSummary);
	const postCapture = { roomId: "room_test", hostSessionId: `hs_${"b".repeat(32)}`, rootInstanceId: rootId,
		engineBuildId: "c".repeat(64), seatIds, nativeEventId: eventId(2), seatId: "seat_b", captureOrdinal: 3,
		nativeCompletionOrdinal: 52, boundaryOrdinal: 2, phaseOverTriggerOrdinal: 2, phaseOverSeatId: "seat_b",
		phaseOverEventInstanceId: "event_72", commitment: "d".repeat(64) };
	const successorCapture = { roomId: "room_test", hostSessionId: `hs_${"b".repeat(32)}`, rootInstanceId: rootId,
		nativeEventId: eventId(2), eventInstanceId: "event_71", parentEventInstanceId: "event_70", seatId: "seat_b",
		captureOrdinal: 2, nativeCompletionOrdinal: 48, commitment: "e".repeat(64) };
	const event = { kind: "xingbei_native_successor_card_action_v1", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
		nativeEventId: eventId(2), rootInstanceId: rootId, seatId: "seat_b", optionId: opaque(1), cardName: "sha", cardKind: "gongJi",
		targetSeatId: "seat_c", nativeEventCompleted: true, useResultCount: 1, useCardChildName: "useCard", useCardChildCompleted: true,
		usedCardPosition: "d",
		nativeChildWaitCompleted: true, nativeEventInstanceMatches: true, nativeCompletionOrdinal: 51,
		actionEventInstanceId: "event_71", actionParentEventInstanceId: "event_70", connectionGeneration: 4,
		choiceId: `choice_${"1".repeat(32)}`, deliveryId: `delivery_choice_${"2".repeat(32)}`, resolutionKind: "player",
		gameMeNull: true, connectedTransports: 0 };
	const afterSummary = { revision: 5, predecessorDigest: beforeDigest, actorSeatId: "seat_b", nativeEventId: eventId(2),
		actionCompletionOrdinal: 51, postFenceCompletionOrdinal: 52, captureOrdinal: 3,
		captureCommitment: postCapture.commitment, phaseOverEventInstanceId: "event_72" };
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 5, stateRevisionBefore: 4,
		stateRevisionAfter: 5, beforeDigest, afterDigest: digest(afterSummary), beforeSummary, afterSummary, event };
	const evidence = { roomId: "room_test", hostSessionId: `hs_${"b".repeat(32)}`, engineBuildId: "c".repeat(64), rootInstanceId: rootId,
		seatIds, predecessor: { eventSequence: 4, revision: 4, digest: beforeDigest, summary: beforeSummary, actorSeatId: "seat_a" },
		successorCandidate: { roomId: "room_test", hostSessionId: `hs_${"b".repeat(32)}`, rootInstanceId: rootId,
			nativeEventId: eventId(2), eventSequence: 5, eventInstanceId: "event_71", parentEventInstanceId: "event_70", waitingCompletionOrdinal: 48,
			seatId: "seat_b", eventName: "gongJiOrFaShu", options: [opaque(1)],
			previousActorSeatId: "seat_a", optionKinds: { [opaque(1)]: "gongJi" }, optionCardNames: { [opaque(1)]: "sha" },
			optionTargetSeatIds: { [opaque(1)]: "seat_c" } },
		successorCapture, postCapture, actionDelivery: { roomId: "room_test", hostSessionId: `hs_${"b".repeat(32)}`,
			nativeEventId: eventId(2), seatId: "seat_b", choiceId: `choice_${"1".repeat(32)}`,
			deliveryId: `delivery_choice_${"2".repeat(32)}`, optionId: opaque(1), resolutionKind: "player", connectionGeneration: 4, immutable: true },
		seatBinding: { roomId: "room_test", seatId: "seat_b", connected: true, current: true,
			credentialAuthenticated: true, ordinaryPlayer: true, connectionGeneration: 4 } };
	return { proof, evidence };
}

test("Event #5 requires explicit experimental opt-in and exact predecessor continuity", () => {
	const { proof, evidence } = fixture();
	assert.equal(validateExperimentalEvent5(proof, evidence).code, "EVENT5_EXPERIMENTAL_OPT_IN_REQUIRED");
	const accepted = validateExperimentalEvent5(proof, evidence, { enabled: true });
	assert.equal(accepted.ok, true, accepted.code);
	for (const mutate of [
		p => { p.eventSequence = 6; },
		p => { p.eventSequence = 9; },
		p => { p.stateRevisionBefore = 3; },
		p => { p.beforeDigest = "f".repeat(64); },
		p => { p.beforeSummary.actorSeatId = "seat_z"; },
		p => { p.afterSummary.captureCommitment = "f".repeat(64); },
		p => { p.extra = true; },
	]) {
		const value = fixture(); mutate(value.proof);
		assert.equal(validateExperimentalEvent5(value.proof, value.evidence, { enabled: true }).ok, false);
	}
});

test("Event #5 requires a different native successor action and current ordinary-seat binding", () => {
	for (const mutate of [
		({ proof }) => { proof.event.nativeEventId = eventId(1); },
		({ proof }) => { proof.event.seatId = "seat_a"; },
		({ proof }) => { proof.event.optionId = "forged"; },
		({ proof }) => { proof.event.nativeEventCompleted = false; },
		({ proof }) => { proof.event.useCardChildCompleted = false; },
		({ proof }) => { proof.event.usedCardPosition = "hand"; },
		({ proof }) => { proof.event.cardKind = "unknown"; },
		({ proof }) => { proof.event.nativeChildWaitCompleted = false; },
		({ proof }) => { proof.event.useResultCount = 2; },
		({ evidence }) => { evidence.successorCapture.nativeCompletionOrdinal = 51; },
		({ evidence }) => { evidence.successorCapture.eventInstanceId = "event_72"; },
		({ evidence }) => { evidence.successorCapture.parentEventInstanceId = "event_72"; },
		({ evidence }) => { evidence.postCapture.nativeCompletionOrdinal = 51; },
		({ evidence }) => { evidence.postCapture.boundaryOrdinal = 1; },
		({ evidence }) => { evidence.postCapture.phaseOverTriggerOrdinal = 1; },
		({ evidence }) => { evidence.postCapture.phaseOverSeatId = "seat_c"; },
		({ evidence }) => { evidence.seatBinding.connectionGeneration++; },
		({ evidence }) => { evidence.seatBinding.ordinaryPlayer = false; },
		({ evidence }) => { evidence.actionDelivery.immutable = false; },
		({ evidence }) => { evidence.actionDelivery.deliveryId = `delivery_choice_${"f".repeat(32)}`; },
		({ proof }) => { proof.event.resolutionKind = "admin"; },
	]) {
		const value = fixture(); mutate(value);
		assert.equal(validateExperimentalEvent5(value.proof, value.evidence, { enabled: true }).ok, false);
	}
});

test("Event #5 binds private post capture to the same root/build/seats and completion", () => {
	{
		const value = fixture();
		value.evidence.postCapture = null;
		assert.equal(validateExperimentalEvent5(value.proof, value.evidence, { enabled: true }).code,
			"EVENT5_CAPTURE_CAUSALITY_REJECTED", "a successor input capture cannot substitute for post-action capture");
	}
	for (const mutate of [
		({ evidence }) => { evidence.postCapture.rootInstanceId = `native_root_${"f".repeat(32)}`; },
		({ evidence }) => { evidence.postCapture.engineBuildId = "f".repeat(64); },
		({ evidence }) => { evidence.postCapture.seatIds = [...seatIds].reverse(); },
		({ evidence }) => { evidence.postCapture.captureOrdinal = 0; },
		({ evidence }) => { evidence.postCapture.commitment = evidence.successorCapture.commitment; },
		({ evidence }) => { evidence.postCapture.nativeEventId = eventId(3); },
		({ evidence }) => { evidence.successorCandidate.eventInstanceId = "event_72"; },
		({ evidence }) => { evidence.successorCandidate.parentEventInstanceId = "event_72"; },
		({ evidence, proof }) => { evidence.successorCandidate.optionTargetSeatIds[proof.event.optionId] = "seat_d"; },
		({ evidence, proof }) => { evidence.successorCandidate.optionKinds[proof.event.optionId] = "faShu"; },
		({ evidence, proof }) => { evidence.successorCandidate.optionCardNames[proof.event.optionId] = "tao"; },
		({ evidence }) => { evidence.successorCandidate.previousActorSeatId = "seat_c"; },
	]) {
		const value = fixture(); mutate(value);
		assert.equal(validateExperimentalEvent5(value.proof, value.evidence, { enabled: true }).ok, false);
	}
});
