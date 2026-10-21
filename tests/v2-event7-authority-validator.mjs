import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateExperimentalEvent7 } = require("../game/server-managed-authority-event7.js");
const canonicalize = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ?
	`[${value.map(canonicalize).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
const digest = value => createHash("sha256").update(canonicalize(value)).digest("hex");
const id = char => `native_event_${char.repeat(32)}`;
const option = `native_option_${"1".repeat(32)}`;
const roomId = "room_test";
const hostSessionId = `hs_${"b".repeat(32)}`;
const rootInstanceId = `native_root_${"a".repeat(32)}`;
const engineBuildId = "c".repeat(64);
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];

function fixture() {
	const beforeSummary = { revision: 6, predecessorDigest: "d".repeat(64), actorSeatId: "seat_c", nativeEventId: id("6"),
		actionCompletionOrdinal: 80, postFenceCompletionOrdinal: 81, captureOrdinal: 4,
		captureCommitment: "e".repeat(64), phaseOverEventInstanceId: "event_82" };
	const beforeDigest = digest(beforeSummary);
	const candidate = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: id("7"), eventSequence: 7,
		eventInstanceId: "event_91", parentEventInstanceId: "event_90", waitingCompletionOrdinal: 82, eventName: "gongJiOrFaShu",
		seatId: "seat_d", previousActorSeatId: "seat_c", options: [option], optionKinds: { [option]: "gongJi" },
		optionCardNames: { [option]: "sha" }, optionTargetSeatIds: { [option]: "seat_a" }, connectionGeneration: 12 };
	const successorCapture = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: id("7"),
		eventInstanceId: "event_91", parentEventInstanceId: "event_90", seatId: "seat_d", captureOrdinal: 5,
		nativeCompletionOrdinal: 82, commitment: "f".repeat(64) };
	const postCapture = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: id("7"), seatId: "seat_d",
		captureOrdinal: 6, nativeCompletionOrdinal: 88, boundaryOrdinal: 4, phaseOverTriggerOrdinal: 4,
		phaseOverSeatId: "seat_d", phaseOverEventInstanceId: "event_92", commitment: "1".repeat(64) };
	const event = { kind: "xingbei_native_successor_card_action_v3", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
		nativeEventId: id("7"), rootInstanceId, seatId: "seat_d", optionId: option, cardName: "sha", cardKind: "gongJi",
		targetSeatId: "seat_a", nativeEventCompleted: true, useResultCount: 1, useCardChildName: "useCard", useCardChildCompleted: true,
		usedCardPosition: "d", nativeChildWaitCompleted: true, nativeEventInstanceMatches: true, nativeCompletionOrdinal: 87,
		actionEventInstanceId: "event_91", actionParentEventInstanceId: "event_90", connectionGeneration: 12,
		choiceId: `choice_${"2".repeat(32)}`, deliveryId: `delivery_choice_${"3".repeat(32)}`,
		resolutionKind: "player", gameMeNull: true, connectedTransports: 0 };
	const afterSummary = { revision: 7, predecessorDigest: beforeDigest, actorSeatId: "seat_d", nativeEventId: id("7"),
		actionCompletionOrdinal: 87, postFenceCompletionOrdinal: 88, captureOrdinal: 6, captureCommitment: postCapture.commitment,
		phaseOverEventInstanceId: postCapture.phaseOverEventInstanceId };
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 7, stateRevisionBefore: 6,
		stateRevisionAfter: 7, beforeDigest, afterDigest: digest(afterSummary), beforeSummary, afterSummary, event };
	const evidence = { roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds,
		predecessor: { eventSequence: 6, revision: 6, digest: beforeDigest, predecessorDigest: beforeSummary.predecessorDigest,
			summary: beforeSummary, actorSeatId: "seat_c", nativeEventId: id("6") }, successorCandidate: candidate, successorCapture, postCapture,
		seatBinding: { roomId, seatId: "seat_d", connected: true, current: true, credentialAuthenticated: true,
			ordinaryPlayer: true, connectionGeneration: 12 },
		actionDelivery: { roomId, hostSessionId, nativeEventId: id("7"), seatId: "seat_d", choiceId: event.choiceId,
			deliveryId: event.deliveryId, optionId: option, eventSequence: 7, resolutionKind: "player", connectionGeneration: 12, immutable: true } };
	return { proof, evidence };
}

test("Event #7 is opt-in only and requires a real Event #6 predecessor with boundary 4", () => {
	const value = fixture();
	assert.equal(validateExperimentalEvent7(value.proof, value.evidence).code, "EVENT7_EXPERIMENTAL_OPT_IN_REQUIRED");
	const accepted = validateExperimentalEvent7(value.proof, value.evidence, { enabled: true });
	assert.equal(accepted.ok, true, accepted.code);
	assert.equal(accepted.eventSequence, 7);
	assert.equal(accepted.stateRevision, 7);
	for (const mutate of [
		({ proof }) => { proof.eventSequence = 8; },
		({ proof }) => { proof.stateRevisionBefore = 5; },
		({ evidence }) => { evidence.predecessor.eventSequence = 5; },
		({ evidence }) => { evidence.predecessor.summary.revision = 5; },
		({ evidence }) => { evidence.successorCandidate.eventSequence = 6; },
		({ evidence }) => { evidence.successorCandidate.previousActorSeatId = "seat_a"; },
		({ evidence }) => { evidence.successorCandidate.nativeEventId = id("6"); },
		({ evidence }) => { evidence.successorCapture.nativeCompletionOrdinal--; },
		({ evidence }) => { evidence.postCapture.boundaryOrdinal = 3; },
		({ evidence }) => { evidence.postCapture.phaseOverTriggerOrdinal = 3; },
		({ evidence }) => { evidence.postCapture.nativeCompletionOrdinal = 87; },
		({ evidence }) => { evidence.postCapture.captureOrdinal = 4; },
		({ evidence }) => { evidence.seatBinding.connectionGeneration++; },
		({ evidence }) => { evidence.actionDelivery.immutable = false; },
		({ evidence }) => { evidence.actionDelivery.eventSequence = 6; },
	]) {
		const invalid = fixture();
		mutate(invalid);
		assert.equal(validateExperimentalEvent7(invalid.proof, invalid.evidence, { enabled: true }).ok, false);
	}
});

test("Event #7 rejects replay, unfinished native completion, wrong seat, invalid choice delivery, and mismatched digest", () => {
	for (const mutate of [
		({ proof }) => { proof.event.nativeEventId = id("6"); },
		({ proof }) => { proof.event.nativeChildWaitCompleted = false; },
		({ proof }) => { proof.event.seatId = "seat_c"; },
		({ proof }) => { proof.event.optionId = `native_option_${"9".repeat(32)}`; },
		({ evidence }) => { evidence.successorCandidate.connectionGeneration++; },
		({ evidence }) => { evidence.postCapture.rootInstanceId = `native_root_${"f".repeat(32)}`; },
		({ proof }) => { proof.afterDigest = "9".repeat(64); },
	]) {
		const invalid = fixture();
		mutate(invalid);
		assert.equal(validateExperimentalEvent7(invalid.proof, invalid.evidence, { enabled: true }).ok, false);
	}
});
