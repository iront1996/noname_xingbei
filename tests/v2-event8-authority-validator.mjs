import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateExperimentalEvent8 } = require("../game/server-managed-authority-event8.js");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const id = char => `native_event_${char.repeat(32)}`;
const option = `native_option_${"1".repeat(32)}`;
const roomId = "event8_room", hostSessionId = `hs_${"2".repeat(32)}`, rootInstanceId = `native_root_${"3".repeat(32)}`;
const engineBuildId = "4".repeat(64), seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];

function fixture() {
	const previous = { revision: 7, predecessorDigest: "5".repeat(64), actorSeatId: "seat_a", nativeEventId: id("7"), actionCompletionOrdinal: 70,
		postFenceCompletionOrdinal: 71, captureOrdinal: 7, captureCommitment: "6".repeat(64), phaseOverEventInstanceId: "event_72" };
	const beforeDigest = digest(previous);
	const candidate = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: id("8"), eventSequence: 8,
		eventInstanceId: "event_81", parentEventInstanceId: "event_80", waitingCompletionOrdinal: 72, eventName: "gongJiOrFaShu", seatId: "seat_b",
		options: [option], optionKinds: { [option]: "gongJi" }, optionCardNames: { [option]: "sha" }, optionTargetSeatIds: { [option]: "seat_c" }, previousActorSeatId: "seat_a", connectionGeneration: 4 };
	const successorCapture = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: id("8"), eventInstanceId: "event_81",
		parentEventInstanceId: "event_80", seatId: "seat_b", connectionGeneration: 4, captureOrdinal: 2, nativeCompletionOrdinal: 72, commitment: "8".repeat(64) };
	const postCapture = { roomId, hostSessionId, rootInstanceId, engineBuildId, seatIds, nativeEventId: id("8"), seatId: "seat_b", captureOrdinal: 8,
		nativeCompletionOrdinal: 78, boundaryOrdinal: 5, phaseOverTriggerOrdinal: 5, phaseOverSeatId: "seat_b", phaseOverEventInstanceId: "event_79", commitment: "9".repeat(64) };
	const event = { kind: "xingbei_native_successor_card_action_v4", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu", nativeEventId: id("8"), rootInstanceId,
		seatId: "seat_b", optionId: option, cardName: "sha", cardKind: "gongJi", targetSeatId: "seat_c", nativeEventCompleted: true, useResultCount: 1,
		useCardChildName: "useCard", useCardChildCompleted: true, usedCardPosition: "d", nativeChildWaitCompleted: true, nativeEventInstanceMatches: true,
		nativeCompletionOrdinal: 77, actionEventInstanceId: "event_81", actionParentEventInstanceId: "event_80", connectionGeneration: 4,
		choiceId: `choice_${"a".repeat(32)}`, deliveryId: `delivery_choice_${"b".repeat(32)}`, resolutionKind: "player", gameMeNull: true, connectedTransports: 0 };
	const after = { revision: 8, predecessorDigest: beforeDigest, actorSeatId: "seat_b", nativeEventId: id("8"), actionCompletionOrdinal: 77,
		postFenceCompletionOrdinal: 78, captureOrdinal: 8, captureCommitment: postCapture.commitment, phaseOverEventInstanceId: "event_79" };
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 8, stateRevisionBefore: 7, stateRevisionAfter: 8,
		beforeDigest, afterDigest: digest(after), beforeSummary: previous, afterSummary: after, event };
	const evidence = { roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds, predecessor: { eventSequence: 7, revision: 7, digest: beforeDigest,
		predecessorDigest: previous.predecessorDigest, summary: previous, actorSeatId: "seat_a", nativeEventId: id("7") }, successorCandidate: candidate, successorCapture, postCapture,
		seatBinding: { roomId, seatId: "seat_b", connected: true, current: true, credentialAuthenticated: true, ordinaryPlayer: true, connectionGeneration: 4 },
		actionDelivery: { roomId, hostSessionId, nativeEventId: id("8"), seatId: "seat_b", choiceId: event.choiceId, deliveryId: event.deliveryId,
			optionId: option, eventSequence: 8, resolutionKind: "player", connectionGeneration: 4, immutable: true } };
	return { proof, evidence };
}

test("Event #8 requires opt-in and a contiguous accepted Event #7 predecessor", () => {
	const value = fixture();
	assert.equal(validateExperimentalEvent8(value.proof, value.evidence).code, "EVENT8_EXPERIMENTAL_OPT_IN_REQUIRED");
	assert.equal(validateExperimentalEvent8(value.proof, value.evidence, { enabled: true }).ok, true);
	for (const mutate of [
		({ proof }) => { proof.eventSequence = 9; }, ({ proof }) => { proof.stateRevisionBefore = 6; },
		({ evidence }) => { evidence.predecessor.eventSequence = 6; }, ({ evidence }) => { evidence.predecessor.summary.revision = 6; },
		({ evidence }) => { evidence.successorCandidate.eventSequence = 7; }, ({ evidence }) => { evidence.successorCapture.nativeCompletionOrdinal--; },
		({ evidence }) => { evidence.successorCapture.connectionGeneration++; },
		({ evidence }) => { evidence.successorCapture.captureOrdinal = 3; },
		({ evidence }) => { evidence.postCapture.boundaryOrdinal = 4; }, ({ evidence }) => { evidence.postCapture.nativeCompletionOrdinal = 77; },
		({ evidence }) => { evidence.postCapture.captureOrdinal = 7; }, ({ evidence }) => { evidence.seatBinding.connectionGeneration++; },
		({ evidence }) => { evidence.actionDelivery.eventSequence = 7; }, ({ proof }) => { proof.event.nativeChildWaitCompleted = false; },
	]) {
		const invalid = fixture(); mutate(invalid);
		assert.equal(validateExperimentalEvent8(invalid.proof, invalid.evidence, { enabled: true }).ok, false);
	}
});

test("Event #8 compares native completion across capture domains, not unrelated local capture ordinals", () => {
	const value = fixture();
	assert.equal(value.evidence.predecessor.summary.captureOrdinal, 7);
	assert.equal(value.evidence.successorCapture.captureOrdinal, 2, "successor pre-action capture is locally bounded and repeats once");
	assert.equal(value.evidence.successorCapture.nativeCompletionOrdinal, 72);
	assert.equal(value.evidence.postCapture.captureOrdinal, 8, "post-phaseOver capture continues the predecessor atomic-capture sequence");
	assert.equal(validateExperimentalEvent8(value.proof, value.evidence, { enabled: true }).ok, true);
});

test("Event #8 rejects stale action identity, mismatched options, changed digest, and cross-root evidence", () => {
	for (const mutate of [
		({ proof }) => { proof.event.nativeEventId = id("7"); }, ({ evidence }) => { evidence.successorCandidate.previousActorSeatId = "seat_d"; },
		({ evidence }) => { evidence.successorCandidate.optionKinds[option] = "faShu"; },
		({ evidence }) => { evidence.postCapture.rootInstanceId = `native_root_${"f".repeat(32)}`; },
		({ proof }) => { proof.afterDigest = "0".repeat(64); }, ({ evidence }) => { evidence.actionDelivery.immutable = false; },
	]) {
		const invalid = fixture(); mutate(invalid);
		assert.equal(validateExperimentalEvent8(invalid.proof, invalid.evidence, { enabled: true }).ok, false);
	}
});
