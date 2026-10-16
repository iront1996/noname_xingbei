import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SCHEMA, VERSION, canonicalize, digestState, validateEvent4SeedBridge, validateState, validateTransition, createAuthorityStateChainV2 } = require("../game/xingbei-authority-state-v2.js");
const digest = value => String(value).repeat(64).slice(0, 64);

function state(overrides = {}) {
	return {
		schema: SCHEMA,
		schemaVersion: VERSION,
		roomId: "room_p1",
		rootInstanceId: "root_p1",
		authorityEventSequence: 4,
		authorityStateRevision: 4,
		firstActSeatId: "seat_a",
		turn: { currentSeatId: "seat_a", roundNumber: 1, phaseNumber: 1, phase: "xingDong", actionIndex: 0,
			quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 } },
		resources: { hongShiQi: 8, lanShiQi: 8, hongXingBei: 0, lanXingBei: 0,
			hongZhanJiCount: 0, hongZhanJiCommitment: digest("a"), lanZhanJiCount: 0, lanZhanJiCommitment: digest("b") },
		cardZones: { drawCount: 60, drawCommitment: digest("c"), discardCount: 0, discardCommitment: digest("d"),
			orderingCount: 0, orderingCommitment: digest("e"), specialCount: 0, specialCommitment: digest("f") },
		seats: ["seat_a", "seat_b", "seat_c", "seat_d"].map((seatId, position) => ({ seatId, position,
			character: `char_${seatId}`, side: position % 2 === 0, alive: true, hp: 4, maxHp: 4,
			handCount: 4, handCommitment: digest(String(position)), equipmentCount: 0, judgmentCount: 0,
			nengLiangCommitment: digest("0"), skillStateCommitment: digest("1"), marksCommitment: digest("2") })),
		...overrides,
	};
}

test("canonical Xingbei authority state v2 is fixed, bounded and deterministic", () => {
	const value = state();
	const reordered = JSON.parse(JSON.stringify(value));
	reordered.turn = Object.fromEntries(Object.entries(reordered.turn).reverse());
	assert.equal(validateState(value), validateState(reordered));
	assert.equal(digestState(value), digestState(reordered));
	assert.match(digestState(value), /^[a-f0-9]{64}$/);
});

test("projection contains only bounded commitments, never raw hidden card identities", () => {
	const value = state();
	assert.equal(validateState(value).includes("card_"), false);
	assert.throws(() => validateState(state({ seats: state().seats.map(seat => ({ ...seat, hand: ["hidden_card"] })) })), /INVALID/);
	assert.throws(() => validateState(state({ cardZones: { ...state().cardZones, drawPile: ["hidden_card"] } })), /INVALID/);
});

test("unknown fields and non-canonical objects fail closed", () => {
	assert.throws(() => validateState(state({ gameMe: "seat_a" })), /INVALID/);
	assert.throws(() => validateState(state({ seats: state().seats.map(seat => ({ ...seat, credential: "secret" })) })), /INVALID/);
	assert.throws(() => canonicalize({ value: undefined }), /INVALID/);
	assert.throws(() => canonicalize(Object.create(null)), /INVALID/);
});

test("seat, room, root and first-actor bindings are independently checked", () => {
	assert.throws(() => validateState(state(), { roomId: "another_room" }), /BINDING/);
	assert.throws(() => validateState(state(), { rootInstanceId: "another_root" }), /BINDING/);
	assert.throws(() => validateState(state(), { firstActSeatId: "seat_b" }), /BINDING/);
	assert.throws(() => validateState(state(), { seatIds: ["seat_a", "seat_b", "seat_d", "seat_c"] }), /BINDING/);
});

test("seat order, uniqueness, numeric ranges, phase and digest commitments are validated", () => {
	const duplicate = state();
	duplicate.seats[1].seatId = duplicate.seats[0].seatId;
	assert.throws(() => validateState(duplicate), /INVALID/);
	assert.throws(() => validateState(state({ turn: { ...state().turn, phase: "invented" } })), /INVALID/);
	assert.doesNotThrow(() => validateState(state({ resources: { ...state().resources, hongShiQi: -1 } })),
		"native Xingbei resource events may produce a value below zero before checkResult resolves the match");
	assert.throws(() => validateState(state({ resources: { ...state().resources, hongShiQi: -1000001 } })), /INVALID/);
	assert.throws(() => validateState(state({ cardZones: { ...state().cardZones, drawCommitment: "not-a-digest" } })), /INVALID/);
});

test("Event #4 to v2 seed bridge is explicit, recomputed and cross-checks the native seat projection", () => {
	const projected = state();
	const summarySeats = projected.seats.map(({ seatId, position, character, side, handCount, handCommitment }) =>
		({ seatId, position, character, side, handCount, handCommitment }));
	const summary = { revision: 4, firstActSeatId: projected.firstActSeatId, seats: summarySeats, responses: [],
		action: { nativeEventId: "native_action_0000000000000001", nativeEventName: "gongJiOrFaShu",
			seatId: "seat_a", cardName: "sha", targetSeatId: "seat_b", optionId: "native_option_0000000000000001", usedCardPosition: "d" } };
	const beforeSummary = { revision: 3, firstActSeatId: projected.firstActSeatId,
		seats: summarySeats.map(seat => ({ ...seat })) };
	const beforeDigest = createHash("sha256").update(canonicalize(beforeSummary)).digest("hex");
	const afterDigest = createHash("sha256").update(canonicalize(summary)).digest("hex");
	const event = { kind: "xingbei_native_card_action_v1", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
		nativeEventId: summary.action.nativeEventId, rootInstanceId: projected.rootInstanceId, nativeEventCompleted: true,
		seatId: summary.action.seatId, cardName: summary.action.cardName, targetSeatId: summary.action.targetSeatId,
		optionId: summary.action.optionId, usedCardPosition: summary.action.usedCardPosition,
		useResultCount: 1, useCardChildName: "useCard", nativeUseCardChildCompleted: true,
		nativeChildWaitCompleted: true, nativeEventInstanceMatches: true, gameMeNull: true, connectedTransports: 0, responseActions: [] };
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 4, stateRevisionBefore: 3,
		stateRevisionAfter: 4, beforeDigest, afterDigest, beforeSummary, afterSummary: summary, event };
	const expected = { roomId: projected.roomId, rootInstanceId: projected.rootInstanceId,
		firstActSeatId: projected.firstActSeatId, seatIds: projected.seats.map(seat => seat.seatId) };
	const bridge = args => validateEvent4SeedBridge({ state: projected, event4Proof: proof,
		expected, expectedLegacyBeforeDigest: beforeDigest, expectedLegacyAfterDigest: afterDigest, ...args });
	assert.equal(bridge().ok, true);
	assert.equal(bridge().authorityStateDigest, digestState(projected));
	assert.equal(bridge().legacyDigest, afterDigest);
	assert.equal(bridge().checkpointAvailable, false);
	for (const invalid of [
		{ state: { ...projected, authorityEventSequence: 5 } },
		{ state: { ...projected, rootInstanceId: "different_root" } },
		{ state: { ...projected, seats: projected.seats.map((seat, index) => index ? seat : { ...seat, handCommitment: digest("z") }) } },
		{ event4Proof: { ...proof, afterDigest: digest("x") } },
		{ event4Proof: { ...proof, event: { ...event, rootInstanceId: "different_root" } } },
		{ event4Proof: { ...proof, event: { ...event, gameMeNull: false } } },
		{ expectedLegacyAfterDigest: digest("x") },
	]) assert.equal(bridge(invalid).ok, false);
});

test("completed native transition requires same root, immutable room topology and a real state delta", () => {
	const before = state();
	const after = state();
	after.authorityEventSequence++;
	after.authorityStateRevision++;
	after.seats[0].handCount = 3;
	after.seats[0].handCommitment = digest("9");
	after.cardZones.discardCount = 1;
	after.cardZones.discardCommitment = digest("8");
	const event = { kind: "xingbei_native_transition_v2", nativeEventId: "native_evt_5", nativeEventName: "gongJiOrFaShu",
		eventSequence: 5, stateRevisionBefore: 4, stateRevisionAfter: 5, rootInstanceId: "root_p1", completed: true, pendingChildCount: 0 };
	const validateNativeEvent = () => true;
	const result = validateTransition({ before, after, event, validateNativeEvent });
	assert.equal(result.ok, true);
	assert.equal(result.beforeDigest, digestState(before));
	assert.equal(result.afterDigest, digestState(after));
	assert.notEqual(result.beforeDigest, result.afterDigest);
	assert.equal(validateTransition({ before, after: state(), event, validateNativeEvent }).code, "XINGBEI_AUTHORITY_TRANSITION_INVALID");
	assert.equal(validateTransition({ before, after, event, validateNativeEvent: undefined }).code, "XINGBEI_AUTHORITY_TRANSITION_INVALID");
	assert.equal(validateTransition({ before, after, event: { ...event, pendingChildCount: 1 }, validateNativeEvent }).code,
		"XINGBEI_AUTHORITY_TRANSITION_INVALID");
	assert.equal(validateTransition({ before, after, event: { ...event, rootInstanceId: "other_root" }, validateNativeEvent }).code,
		"XINGBEI_AUTHORITY_TRANSITION_INVALID");
	assert.equal(validateTransition({ before, after, event: { ...event, eventSequence: 7 }, validateNativeEvent }).code,
		"XINGBEI_AUTHORITY_TRANSITION_INVALID");
	assert.equal(validateTransition({ before, after, event: { ...event, stateRevisionBefore: 3 }, validateNativeEvent }).code,
		"XINGBEI_AUTHORITY_TRANSITION_INVALID");
});

test("server canonical chain accepts one validated transition and exact proof replay only", () => {
	const beforeState = state();
	const afterState = state();
	afterState.authorityEventSequence++;
	afterState.authorityStateRevision++;
	afterState.seats[0].handCount--;
	afterState.seats[0].handCommitment = digest("9");
	afterState.cardZones.discardCount++;
	afterState.cardZones.discardCommitment = digest("8");
	const event = { kind: "xingbei_native_transition_v2", nativeEventId: "native_evt_5", nativeEventName: "gongJiOrFaShu",
		eventSequence: 5, stateRevisionBefore: 4, stateRevisionAfter: 5, rootInstanceId: "root_p1", completed: true, pendingChildCount: 0 };
	const proof = { beforeState, afterState, event, beforeDigest: digestState(beforeState), afterDigest: digestState(afterState) };
	const chain = createAuthorityStateChainV2({ initialState: beforeState, validateInitialState: () => true, validateNativeEvent: () => true });
	assert.equal(chain.commit(proof).ok, true);
	assert.equal(chain.inspect().authorityEventSequence, 5);
	assert.equal(chain.inspect().authorityStateRevision, 5);
	assert.equal(chain.inspect().authorityStateDigest, proof.afterDigest);
	assert.equal(chain.inspect().checkpointAvailable, false);
	assert.deepEqual(chain.commit(proof), { ok: true, idempotent: true, state: chain.inspect() });
	assert.equal(chain.commit({ ...proof, afterState: { ...afterState, turn: { ...afterState.turn, roundNumber: 2 } } }).code,
		"XINGBEI_AUTHORITY_REPLAY_V2_REJECTED");
});

test("authority chain rejects missing/failed event validator, stale predecessor and skipped revisions", () => {
	const beforeState = state();
	const afterState = state();
	afterState.authorityEventSequence++;
	afterState.authorityStateRevision++;
	afterState.seats[0].handCount--;
	afterState.seats[0].handCommitment = digest("9");
	const event = { kind: "xingbei_native_transition_v2", nativeEventId: "native_evt_5", nativeEventName: "gongJiOrFaShu",
		eventSequence: 5, stateRevisionBefore: 4, stateRevisionAfter: 5, rootInstanceId: "root_p1", completed: true, pendingChildCount: 0 };
	const baseProof = { beforeState, afterState, event, beforeDigest: digestState(beforeState), afterDigest: digestState(afterState) };
	assert.throws(() => createAuthorityStateChainV2({ initialState: beforeState, validateNativeEvent: () => true }), /CONFIG_INVALID/);
	assert.throws(() => createAuthorityStateChainV2({ initialState: beforeState, validateInitialState: () => false,
		validateNativeEvent: () => true }), /INITIAL_STATE_REJECTED/);
	let observedInitial;
	const failedValidator = createAuthorityStateChainV2({ initialState: beforeState,
		validateInitialState: value => { observedInitial = value; return true; }, validateNativeEvent: () => false });
	assert.notEqual(observedInitial.state, beforeState, "initializer must receive a detached candidate, not mutable internal state");
	assert.equal(failedValidator.inspect().authorityStateRevision, 4, "the accepted native boundary seeds revision 4 explicitly");
	assert.equal(failedValidator.commit(baseProof).ok, false);
	const staleProof = { ...baseProof, beforeDigest: digest("0") };
	const chain = createAuthorityStateChainV2({ initialState: beforeState, validateInitialState: () => true, validateNativeEvent: () => true });
	assert.equal(chain.commit(staleProof).code, "XINGBEI_AUTHORITY_PREDECESSOR_V2_REJECTED");
	assert.equal(chain.commit({ ...baseProof, afterState: { ...afterState, authorityStateRevision: 6 },
		event: { ...event, stateRevisionAfter: 6 } }).code,
		"XINGBEI_AUTHORITY_PREDECESSOR_V2_REJECTED");
	assert.equal(chain.commit({ ...baseProof, padding: "x".repeat(170000) }).code,
		"XINGBEI_AUTHORITY_PROOF_V2_INVALID");
	assert.equal(chain.inspect().authorityStateRevision, 4);
});

test("canonical projection rejects oversized or malformed state before hashing", () => {
	assert.throws(() => validateState(state({ seats: Array.from({ length: 9 }, (_, position) => ({
		seatId: `seat_${position}`, position, character: "char", side: position % 2 === 0, alive: true,
		hp: 4, maxHp: 4, handCount: 4, handCommitment: digest("a"), equipmentCount: 0, judgmentCount: 0,
		nengLiangCommitment: digest("0"), skillStateCommitment: digest("1"), marksCommitment: digest("2"),
	})) })), /INVALID/);
	assert.throws(() => validateState(state({ seats: state().seats.map((seat, index) => index ? seat : { ...seat, character: "x".repeat(129) }) })), /INVALID/);
});
