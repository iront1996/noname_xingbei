import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateExperimentalEvent6 } = require("../game/server-managed-authority-event6.js");
const canonicalize = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ?
	`[${value.map(canonicalize).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
const digest = value => createHash("sha256").update(canonicalize(value)).digest("hex");
const eventId = n => `native_event_${String(n).repeat(32)}`;
const optionId = n => `native_option_${String(n).repeat(32)}`;
const roomId = "room_test";
const hostSessionId = `hs_${"b".repeat(32)}`;
const rootInstanceId = `native_root_${"a".repeat(32)}`;
const engineBuildId = "c".repeat(64);
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];

function fixture() {
	const beforeSummary = { revision: 5, predecessorDigest: "d".repeat(64), actorSeatId: "seat_b", nativeEventId: eventId(2),
		actionCompletionOrdinal: 59, postFenceCompletionOrdinal: 60, captureOrdinal: 3, captureCommitment: "e".repeat(64),
		phaseOverEventInstanceId: "event_72" };
	const beforeDigest = digest(beforeSummary);
	const successorCandidate = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, eventSequence: 6, nativeEventId: eventId(3),
		eventInstanceId: "event_81", parentEventInstanceId: "event_80", waitingCompletionOrdinal: 61,
		seatId: "seat_c", eventName: "gongJiOrFaShu", previousActorSeatId: "seat_b", options: [optionId(1)],
		connectionGeneration: 7, optionKinds: { [optionId(1)]: "gongJi" }, optionCardNames: { [optionId(1)]: "sha" },
		optionTargetSeatIds: { [optionId(1)]: "seat_d" } };
	const successorCapture = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: eventId(3),
		eventInstanceId: "event_81", parentEventInstanceId: "event_80", seatId: "seat_c", captureOrdinal: 3,
		nativeCompletionOrdinal: 61, commitment: "f".repeat(64) };
	const postCapture = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: eventId(3), seatId: "seat_c",
		captureOrdinal: 4, nativeCompletionOrdinal: 66, boundaryOrdinal: 3, phaseOverTriggerOrdinal: 3,
		phaseOverSeatId: "seat_c", phaseOverEventInstanceId: "event_82", commitment: "1".repeat(64) };
	const event = { kind: "xingbei_native_successor_card_action_v2", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
		nativeEventId: eventId(3), rootInstanceId, seatId: "seat_c", optionId: optionId(1), cardName: "sha", cardKind: "gongJi",
		targetSeatId: "seat_d", nativeEventCompleted: true, useResultCount: 1, useCardChildName: "useCard",
		useCardChildCompleted: true, usedCardPosition: "d", nativeChildWaitCompleted: true, nativeEventInstanceMatches: true,
		nativeCompletionOrdinal: 65, actionEventInstanceId: "event_81", actionParentEventInstanceId: "event_80",
		connectionGeneration: 7, choiceId: `choice_${"1".repeat(32)}`, deliveryId: `delivery_choice_${"2".repeat(32)}`,
		resolutionKind: "player", gameMeNull: true, connectedTransports: 0 };
	const afterSummary = { revision: 6, predecessorDigest: beforeDigest, actorSeatId: "seat_c", nativeEventId: eventId(3),
		actionCompletionOrdinal: 65, postFenceCompletionOrdinal: 66, captureOrdinal: 4,
		captureCommitment: postCapture.commitment, phaseOverEventInstanceId: "event_82" };
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 6, stateRevisionBefore: 5,
		stateRevisionAfter: 6, beforeDigest, afterDigest: digest(afterSummary), beforeSummary, afterSummary, event };
	const evidence = { roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds,
		predecessor: { eventSequence: 5, revision: 5, digest: beforeDigest, predecessorDigest: beforeSummary.predecessorDigest,
			summary: beforeSummary, actorSeatId: "seat_b", nativeEventId: eventId(2) }, successorCandidate, successorCapture, postCapture,
		seatBinding: { roomId, seatId: "seat_c", connected: true, current: true, credentialAuthenticated: true,
			ordinaryPlayer: true, connectionGeneration: 7 },
		actionDelivery: { roomId, hostSessionId, nativeEventId: eventId(3), seatId: "seat_c", choiceId: event.choiceId,
			deliveryId: event.deliveryId, optionId: event.optionId, resolutionKind: "player", connectionGeneration: 7, immutable: true } };
	return { proof, evidence };
}

test("Event #6 is opt-in only and accepts only a continuous Event #5 predecessor with boundary 3 evidence", () => {
	const value = fixture();
	assert.equal(validateExperimentalEvent6(value.proof, value.evidence).code, "EVENT6_EXPERIMENTAL_OPT_IN_REQUIRED");
	const accepted = validateExperimentalEvent6(value.proof, value.evidence, { enabled: true });
	assert.equal(accepted.ok, true, accepted.code);
	assert.equal(accepted.eventSequence, 6);
	assert.equal(accepted.stateRevision, 6);
	for (const mutate of [
		({ proof }) => { proof.eventSequence = 7; },
		({ proof }) => { proof.stateRevisionBefore = 4; },
		({ proof }) => { proof.beforeDigest = "a".repeat(64); },
		({ evidence }) => { evidence.predecessor.eventSequence = 4; },
		({ evidence }) => { evidence.predecessor.summary.actorSeatId = "seat_a"; },
		({ evidence }) => { evidence.predecessor.summary.captureCommitment = "a".repeat(64); },
		({ evidence }) => { evidence.successorCandidate.eventSequence = 5; },
		({ evidence }) => { evidence.successorCandidate.previousActorSeatId = "seat_a"; },
		({ evidence }) => { evidence.successorCandidate.nativeEventId = eventId(2); },
		({ evidence }) => { evidence.successorCapture.nativeCompletionOrdinal = 60; },
		({ evidence }) => { evidence.postCapture.boundaryOrdinal = 2; },
		({ evidence }) => { evidence.postCapture.phaseOverTriggerOrdinal = 2; },
		({ evidence }) => { evidence.postCapture.nativeCompletionOrdinal = 65; },
		({ evidence }) => { evidence.postCapture.captureOrdinal = 3; },
		({ evidence }) => { evidence.seatBinding.connectionGeneration++; },
		({ evidence }) => { evidence.actionDelivery.immutable = false; },
	]) {
		const invalid = fixture();
		mutate(invalid);
		assert.equal(validateExperimentalEvent6(invalid.proof, invalid.evidence, { enabled: true }).ok, false);
	}
});

test("Event #6 rejects native replay, unfinished children, bad targets and non-player authority", () => {
	for (const mutate of [
		({ proof }) => { proof.event.nativeEventId = eventId(2); },
		({ proof }) => { proof.event.seatId = "seat_b"; },
		({ proof }) => { proof.event.nativeEventCompleted = false; },
		({ proof }) => { proof.event.useResultCount = 2; },
		({ proof }) => { proof.event.useCardChildCompleted = false; },
		({ proof }) => { proof.event.nativeChildWaitCompleted = false; },
		({ proof }) => { proof.event.nativeCompletionOrdinal = 61; },
		({ proof }) => { proof.event.targetSeatId = "seat_c"; },
		({ proof }) => { proof.event.gameMeNull = false; },
		({ proof }) => { proof.event.connectedTransports = 1; },
		({ proof }) => { proof.event.resolutionKind = "admin"; },
		({ proof }) => { proof.event.extra = true; },
		({ proof }) => { proof.afterSummary.captureCommitment = "a".repeat(64); },
	]) {
		const invalid = fixture();
		mutate(invalid);
		assert.equal(validateExperimentalEvent6(invalid.proof, invalid.evidence, { enabled: true }).ok, false);
	}
});
