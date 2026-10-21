import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createManagedV3SeatStateProjection } = require("../game/server-managed-v3-seat-state-projection.js");
const { createManagedSuccessorPreActionCapture } = require("../game/server-managed-successor-preaction-capture.js");
const seats = ["seat_a", "seat_b", "seat_c", "seat_d"];
const scope = { roomId: "room_v3", hostSessionId: `hs_${"a".repeat(32)}`, engineBuildId: "b".repeat(64),
	rootInstanceId: `native_root_${"c".repeat(32)}` };
const previous = { ...scope, seatIds: seats, nativeEventId: `native_${"1".repeat(32)}`, eventInstanceId: "event_5",
	nativeCompletionOrdinal: 9, stateDigest: "d".repeat(64), commitment: "e".repeat(64), captureOrdinal: 1, seatId: "seat_a" };
const binding = { roomId: scope.roomId, seatId: "seat_b", connectionGeneration: 1, connected: true, current: true,
	credentialAuthenticated: true, ordinaryPlayer: true };

function envelope() {
	const option = `native_option_${"f".repeat(32)}`;
	const parentChain = ["game", "phaseLoop", "phase", "xingDong", "gongJiOrFaShu"].map((eventName, index) => ({
		eventName, eventInstanceId: `event_${index + 1}`, step: index === 4 ? 2 : 0, seatId: index === 0 ? null : "seat_b", finished: false }));
	const cards = [
		{ cardId: "secret-card-a", zone: "hand", ownerSeatId: "seat_a", position: 0 },
		{ cardId: "secret-card-b", zone: "hand", ownerSeatId: "seat_b", position: 0 },
		{ cardId: "secret-card-c", zone: "hand", ownerSeatId: "seat_c", position: 0 },
		{ cardId: "secret-card-d", zone: "hand", ownerSeatId: "seat_d", position: 0 },
		{ cardId: "draw-card", zone: "draw", ownerSeatId: null, position: 0 },
	].map((card, index) => ({ ...card, duYou: null, kind: "physical_dom_card_v1", mingGe: "red", name: "gongJi", xiBie: "huo" }));
	return { schema: "xingbei_native_private_successor_preaction_capture_v1", captureOrdinal: 1, ...scope,
		seatIds: [...seats], fence: { captureLockKind: "successor_native_gate_v1", candidateOptionIds: [option], candidateOptionKinds: { [option]: "gongJi" },
			choiceAllocated: false, controllerStatus: "not_allocated", deliveryCount: 0, eventInstanceId: "event_5", eventName: "gongJiOrFaShu",
			eventStep: 2, eventStackConsistent: true, gamePaused: true, inputWaiting: true, nativeCompletionOrdinal: 12,
			nativeEventId: `native_event_${"2".repeat(32)}`, parentChain, pendingInputCount: 1, previousNativeEventId: previous.nativeEventId,
			previousSeatId: "seat_a", rootEventInstanceId: "event_1", rootMatches: true, runnableDescendantCount: 0,
			seatId: "seat_b", useCardChildCount: 0, useResultCount: 0 },
		cardLedger: { schema: "xingbei_native_private_card_ledger_v1", rootInstanceId: scope.rootInstanceId, seatIds: [...seats], cards },
		effectState: { schema: "xingbei_native_private_effect_state_v1", rootInstanceId: scope.rootInstanceId, seatIds: [...seats],
			seats: seats.map(seatId => ({ seatId, skills: [], guiHuo: 0 })) },
		turnResource: { schema: "xingbei_native_private_turn_resource_state_v2", ...scope, seatIds: [...seats],
			fence: { kind: "managed_native_input_waiting_fence_v1", rootMatches: true, eventStackConsistent: true,
				allChildrenCompleted: false, pendingChildCount: 1, captureLocked: true, nativeCompletionOrdinal: 12 },
			turn: { phase: "xingDong", actorSeatId: "seat_b", phaseLoopSeatId: "seat_b", currentPhaseSeatId: "seat_b",
				gamePhaseNumber: 2, playerPhaseNumber: 1, quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0 }, extraActionQueueEmpty: true },
			resources: { hongShiQi: 5, lanShiQi: 4, hongXingBei: 1, lanXingBei: 0, hongZhanJi: ["baoShi"], lanZhanJi: [] },
			seats: seats.map((seatId, position) => ({ seatId, position, character: `character_${position}`, side: position < 2,
				alive: true, hp: 4, maxHp: 4, zhiLiao: 0, hujiaSupported: false,
				nengLiang: { baoShi: 0, shuiJing: 0, effectiveLimit: 3 } })) } };
}

function committed() {
	const native = envelope();
	const capture = createManagedSuccessorPreActionCapture({ ...scope, seatIds: seats, sessionId: scope.hostSessionId,
		previousCapture: previous, previousActorSeatId: "seat_a", seatBinding: binding, key: Buffer.alloc(32, 7) });
	const accepted = capture.commit(native, { nativeEventId: native.fence.nativeEventId, seatId: "seat_b" });
	return { native, accepted };
}

test("same accepted successor envelope yields recipient-scoped public and private V3 projections", () => {
	const { native, accepted } = committed();
	const projection = createManagedV3SeatStateProjection({ key: Buffer.alloc(32, 8) });
	const messages = seats.map((recipientSeatId, index) => projection.project({ envelope: native, capture: accepted, ...scope,
		seatIds: seats, recipientSeatId, connectionGeneration: index + 1, stateSequence: 1 }));
	assert.ok(messages.every(item => item.ok), JSON.stringify(messages.map(item => item.code)));
	const firstPublic = JSON.stringify(messages[0].message.publicState);
	for (const item of messages) {
		assert.equal(JSON.stringify(item.message.publicState), firstPublic);
		assert.equal(item.message.publicState.activeSeatId, "seat_b");
		assert.equal(item.message.publicState.phase, "xingDong");
		assert.equal(item.message.pendingChoice, null);
		assert.equal(item.message.privateState.handCardViewIds.length, 1);
	}
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i].message;
		assert.equal(message.privateState.seatId, seats[i]);
		assert.equal(JSON.stringify(message).includes(`secret-card-${String.fromCharCode(97 + i)}`), false);
		assert.equal(JSON.stringify(message).includes(scope.hostSessionId), false);
		assert.equal(JSON.stringify(message).includes(accepted.stateDigest), false);
		assert.notEqual(message.privateState.handCardViewIds[0], messages[(i + 1) % messages.length].message.privateState.handCardViewIds[0]);
	}
	assert.deepEqual(messages.map(item => item.message.publicState.resources.hongBaoShiCount), [1, 1, 1, 1]);
	assert.deepEqual(messages.map(item => item.message.stateSequence), [1, 1, 1, 1]);
	projection.destroy();
});

test("projection rejects cross-seat, stale capture identity, wrong actor, and use after destruction", () => {
	const { native, accepted } = committed();
	const projection = createManagedV3SeatStateProjection({ key: Buffer.alloc(32, 9) });
	assert.equal(projection.project({ envelope: native, capture: accepted, ...scope, seatIds: seats, recipientSeatId: "seat_a",
		connectionGeneration: 1, stateSequence: 1 }).ok, true, "the same authorized native envelope can create another separately scoped seat view");
	assert.equal(projection.project({ envelope: native, capture: accepted, ...scope, rootInstanceId: `native_root_${"d".repeat(32)}`,
		seatIds: seats, recipientSeatId: "seat_b", connectionGeneration: 1, stateSequence: 1 }).ok, false);
	const wrongActor = structuredClone(native); wrongActor.turnResource.turn.actorSeatId = "seat_a";
	assert.equal(projection.project({ envelope: wrongActor, capture: accepted, ...scope, seatIds: seats, recipientSeatId: "seat_b",
		connectionGeneration: 1, stateSequence: 1 }).code, "NATIVE_TURN_STATE_V2_TURN_UNSUPPORTED");
	projection.destroy();
	assert.equal(projection.project({ envelope: native, capture: accepted, ...scope, seatIds: seats, recipientSeatId: "seat_b",
		connectionGeneration: 1, stateSequence: 1 }).code, "V3_SEAT_PROJECTION_DESTROYED");
});

test("opt-in v3 hand display binds ordered real ledger names to this seat's opaque physical-card view IDs", () => {
	const { native, accepted } = committed();
	const projection = createManagedV3SeatStateProjection({ key: Buffer.alloc(32, 10) });
	const messages = seats.map((recipientSeatId, index) => projection.project({ envelope: native, capture: accepted, ...scope,
		seatIds: seats, recipientSeatId, connectionGeneration: index + 1, stateSequence: 1, includeOwnCardDisplay: true }));
	assert.ok(messages.every(item => item.ok), JSON.stringify(messages.map(item => item.code)));
	for (let index = 0; index < seats.length; index++) {
		const message = messages[index].message;
		assert.equal(message.schema, "xingbei_v3_seat_state_v3");
		assert.equal(message.privateState.schema, "xingbei_v3_private_hand_display_v1");
		assert.equal(message.privateState.seatId, seats[index]);
		assert.deepEqual(message.privateState.cards, [{ viewId: message.privateState.cards[0].viewId, name: "gongJi", position: 0, xiBie: "huo" }]);
		assert.equal(message.privateState.cards[0].viewId, messages[index].message.privateState.cards[0].viewId);
		assert.equal(JSON.stringify(message).includes(`secret-card-${String.fromCharCode(97 + index)}`), false);
		assert.equal(JSON.stringify(message).includes('"cardId"'), false);
		assert.equal(JSON.stringify(message).includes(scope.hostSessionId), false);
		assert.equal(JSON.stringify(message).includes(accepted.stateDigest), false);
		for (const otherIndex of seats.keys()) if (otherIndex !== index)
			assert.equal(JSON.stringify(message).includes(`secret-card-${String.fromCharCode(97 + otherIndex)}`), false);
	}
	assert.deepEqual(messages.map(item => item.message.publicState), messages.map(item => messages[0].message.publicState));
	projection.destroy();
});
