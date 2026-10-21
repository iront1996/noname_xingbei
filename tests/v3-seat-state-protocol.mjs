import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);


const { SCHEMA, CAPPED_SCHEMA, DISPLAY_SCHEMA, HAND_DISPLAY_SCHEMA, createSeatStateMessage, validateSeatStateMessage,
	createSeatStateDisplayMessage, validateSeatStateDisplayMessage,
	MANAGED_CHOICE_DISPLAY_SCHEMA, createManagedChoiceDisplay, createCompactManagedChoiceDisplay, validateManagedChoiceDisplay,
	createCompactPrivateHandDisplay, validateCompactPrivateHandDisplay,
	createCappedReadOnlySeatState, validateCappedReadOnlySeatState, acceptsReconnectCursor } =
	require("../game/v3-seat-state-protocol.js");
const { createVerifiedSeatStatePublisher, createSeatStateReceiver } = require("../game/v3-verified-seat-state.js");

const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
const base = () => ({ roomId: "room_v3_probe", seatIds, recipientSeatId: "seat_a", connectionGeneration: 2,
	stateSequence: 19, stateVersion: 7, replayFromSequence: 18,
	publicState: { stateVersion: 7, activeSeatId: "seat_b", phase: "xingDong", players: seatIds.map((seatId, index) => ({
		seatId, characterId: `character_${index}`, side: index < 2, handCount: 4 })), resources: { hongShiQi: 3, lanShiQi: 3,
		hongXingBei: 2, lanXingBei: 2, hongBaoShiCount: 0, hongShuiJingCount: 0, lanBaoShiCount: 0, lanShuiJingCount: 0 } },
	privateState: { seatId: "seat_a", handCardViewIds: ["cardview_00000000000001"] },
	pendingChoice: { choiceId: "choice_00000000000001", eventSequence: 4, seatId: "seat_a",
		optionIds: ["option_00000000000001", "option_00000000000002"], deadlineAt: 1900000000000, status: "delivery_pending" } });

test("V3 seat state envelope scopes private state and pending choice to one ordinary seat", () => {
	const result = createSeatStateMessage(base());
	assert.equal(result.ok, true);
	assert.equal(result.message.schema, SCHEMA);
	assert.equal(result.message.recipientSeatId, "seat_a");
	assert.equal(result.message.privateState.seatId, "seat_a");
	assert.equal(result.message.pendingChoice.seatId, "seat_a");
	assert.equal(validateSeatStateMessage(result.message, { roomId: "room_v3_probe", seatId: "seat_a",
		connectionGeneration: 2, seatIds }).ok, true);
	assert.equal(JSON.stringify(result.message).includes("credential"), false);
	assert.equal(JSON.stringify(result.message).includes("hostSession"), false);
});

test("Event 8 capped read-only view is recipient scoped, explicitly nonterminal and never authorizes Event 9", () => {
	const input = { roomId: "room_v3_probe", recipientSeatId: "seat_a", connectionGeneration: 2,
		stateSequence: 4, replayFromSequence: 3, authorityRevision: 8, lastAcceptedEventSequence: 8,
		nextAuthorityEventSequence: 9, captureOrdinal: 6, nativeCompletionOrdinal: 57,
		nativeEventId: `native_event_${"a".repeat(32)}`, phaseOverEventInstanceId: "event_301",
		experimentalCeilingReached: true, gameTerminal: false, gameplayEnabled: false,
		projectionStatus: "verified_capture_payload_unavailable" };
	const created = createCappedReadOnlySeatState(input);
	assert.equal(created.ok, true);
	assert.equal(created.message.schema, CAPPED_SCHEMA);
	assert.equal(validateCappedReadOnlySeatState(created.message, { roomId: input.roomId, seatId: input.recipientSeatId,
		connectionGeneration: 2 }).ok, true);
	assert.equal(created.message.gameTerminal, false);
	assert.equal(created.message.gameplayEnabled, false);
	assert.equal(JSON.stringify(created.message).includes("commitment"), false);
	assert.equal(JSON.stringify(created.message).includes("cardId"), false);
	assert.equal(validateCappedReadOnlySeatState({ ...created.message, authorityRevision: 9 }).ok, false);
	assert.equal(validateCappedReadOnlySeatState({ ...created.message, gameplayEnabled: true }).ok, false);
	assert.equal(validateCappedReadOnlySeatState({ ...created.message, privateState: { hand: [] } }).ok, false);
});

test("V3 seat state envelope rejects cross-seat private data and unknown secret-bearing fields", () => {
	const crossSeat = base();
	crossSeat.privateState.seatId = "seat_b";
	assert.deepEqual(createSeatStateMessage(crossSeat), { ok: false, code: "V3_SEAT_STATE_ENVELOPE_REJECTED" });
	const injected = createSeatStateMessage(base()).message;
	assert.equal(validateSeatStateMessage({ ...injected, hostSessionSecret: "not-allowed" }, { seatIds }).ok, false);
	assert.equal(validateSeatStateMessage({ ...injected, privateState: { ...injected.privateState, otherSeatHand: [] } }, { seatIds }).ok, false);
});

test("versioned hand display accepts only bounded recipient-owned names and ordered opaque IDs", () => {
	const input = base();
	input.privateState = { schema: HAND_DISPLAY_SCHEMA, seatId: "seat_a", cards: [
		{ viewId: "view_000000000000001", name: "gongJi", position: 0, xiBie: "huo" },
		{ viewId: "view_000000000000002", name: "shengGuang", position: 1, xiBie: "guang" },
		{ viewId: "view_000000000000003", name: "anMie", position: 2, xiBie: "an" },
		{ viewId: "view_000000000000004", name: "faShu", position: 3, xiBie: "none" },
	] };
	const created = createSeatStateDisplayMessage(input);
	assert.equal(created.ok, true);
	assert.equal(created.message.schema, DISPLAY_SCHEMA);
	assert.equal(validateSeatStateDisplayMessage(created.message, { roomId: input.roomId, seatId: "seat_a",
		connectionGeneration: 2, seatIds }).ok, true);
	assert.equal(validateSeatStateMessage(created.message, { seatIds }).ok, false, "the new version is not silently accepted as v2");
	const wrongSeat = structuredClone(created.message); wrongSeat.privateState.seatId = "seat_b";
	assert.equal(validateSeatStateDisplayMessage(wrongSeat, { seatIds }).ok, false);
	const rawId = structuredClone(created.message); rawId.privateState.cards[0].cardId = "native-card-id";
	assert.equal(validateSeatStateDisplayMessage(rawId, { seatIds }).ok, false);
	const badOrder = structuredClone(created.message); badOrder.privateState.cards[1].position = 0;
	assert.equal(validateSeatStateDisplayMessage(badOrder, { seatIds }).ok, false);
	const unknownField = structuredClone(created.message); unknownField.privateState.cards[0].name = "<img src=x>";
	assert.equal(validateSeatStateDisplayMessage(unknownField, { seatIds }).ok, false);
	const missingHand = structuredClone(created.message); missingHand.privateState.cards.pop();
	assert.equal(validateSeatStateDisplayMessage(missingHand, { seatIds }).ok, false);
});

test("managed choice display preserves native option identity and only emits evidence-backed operation and target labels", () => {
	const optionIds = [`native_option_${"a".repeat(32)}`, `native_option_${"b".repeat(32)}`, `native_option_${"c".repeat(32)}`];
	const input = { roomId: "room_v3_probe", hostSessionId: `hs_${"d".repeat(32)}`, rootInstanceId: `native_root_${"e".repeat(32)}`,
		nativeEventId: `native_event_${"f".repeat(32)}`, eventInstanceId: "event_20", parentEventInstanceId: "event_19",
		eventSequence: 5, choiceId: "choice_0000000000000001", actingSeatId: "seat_a", connectionGeneration: 4,
		captureOrdinal: 9, nativeCompletionOrdinal: 31, seatIds, optionIds,
		optionKinds: { [optionIds[0]]: "gongJi", [optionIds[1]]: "faShu", [optionIds[2]]: "future_kind" },
		optionTargetSeatIds: { [optionIds[0]]: "seat_b", [optionIds[1]]: "seat_a", [optionIds[2]]: "seat_d" } };
	const created = createManagedChoiceDisplay(input);
	assert.equal(created.ok, true);
	assert.equal(created.message.schema, MANAGED_CHOICE_DISPLAY_SCHEMA);
	assert.deepEqual(created.message.optionItems.map(item => [item.optionId, item.label, item.targetSeatId, item.completeness]), [
		[optionIds[0], "攻擊", "seat_b", "partial"], [optionIds[1], "法術", "seat_a", "partial"],
		[optionIds[2], "合法操作（語意未驗證）", "seat_d", "opaque"],
	]);
	assert.equal(validateManagedChoiceDisplay(created.message, { roomId: input.roomId, hostSessionId: input.hostSessionId,
		rootInstanceId: input.rootInstanceId, eventSequence: 5, choiceId: input.choiceId, seatId: "seat_a",
		nativeEventId: input.nativeEventId, connectionGeneration: 4, captureOrdinal: 9, nativeCompletionOrdinal: 31,
		optionIds, seatIds }), true);
	assert.equal(validateManagedChoiceDisplay(created.message, { optionIds: [...optionIds].reverse(), seatIds }), false);
	assert.equal(validateManagedChoiceDisplay({ ...created.message, nativeEventId: `native_event_${"0".repeat(32)}` },
		{ nativeEventId: input.nativeEventId, seatIds }), false);
	const stale = { ...created.message, connectionGeneration: 3 };
	assert.equal(validateManagedChoiceDisplay(stale, { connectionGeneration: 4, seatIds }), false);
	const targetTamper = structuredClone(created.message); targetTamper.optionItems[0].targetSeatId = "seat_z";
	assert.equal(validateManagedChoiceDisplay(targetTamper, { seatIds }), false);
	const labelTamper = structuredClone(created.message); labelTamper.optionItems[0].label = "一定擊中";
	assert.equal(validateManagedChoiceDisplay(labelTamper, { seatIds }), false);
	assert.equal(JSON.stringify(created.message).includes("cardId"), false);
	assert.equal(JSON.stringify(created.message).includes("commitment"), false);
	assert.equal(JSON.stringify(created.message).includes("secret"), false);
	assert.equal(createManagedChoiceDisplay({ ...input, optionCardNames: Object.fromEntries(optionIds.map(id => [id, "gongJi"])) }).ok, false,
		"unreviewed candidate metadata such as card names must not enter the public display contract");
});

test("choice display v2 accepts only optional recipient-scoped opaque physical hand links", () => {
	const optionIds = [`native_option_${"1".repeat(32)}`, `native_option_${"2".repeat(32)}`];
	const input = { roomId: "room_v3_probe", hostSessionId: `hs_${"3".repeat(32)}`, rootInstanceId: `native_root_${"4".repeat(32)}`,
		nativeEventId: `native_event_${"5".repeat(32)}`, eventInstanceId: "event_30", parentEventInstanceId: "event_29",
		eventSequence: 5, choiceId: "choice_0123456789abcdef", actingSeatId: "seat_b", connectionGeneration: 2,
		captureOrdinal: 3, nativeCompletionOrdinal: 19, seatIds, optionIds,
		optionKinds: { [optionIds[0]]: "gongJi", [optionIds[1]]: "faShu" },
		optionTargetSeatIds: { [optionIds[0]]: "seat_c", [optionIds[1]]: "seat_d" },
		optionCardViewIds: { [optionIds[0]]: "view_0123456789abcdef0123456789abcdef0123456789", [optionIds[1]]: null } };
	const created = createManagedChoiceDisplay(input);
	assert.equal(created.ok, true);
	assert.equal(created.message.schema, "xingbei_v3_managed_choice_display_v2");
	assert.equal(created.message.optionItems[0].cardLinkStatus, "verified_physical_hand_v1");
	assert.equal(created.message.optionItems[1].cardLinkStatus, "unavailable");
	assert.equal(validateManagedChoiceDisplay(created.message, { optionIds, seatIds, seatId: "seat_b", connectionGeneration: 2 }), true);
	const rawId = structuredClone(created.message); rawId.optionItems[0].cardViewId = "native_card_secret_123";
	assert.equal(validateManagedChoiceDisplay(rawId, { seatIds }), false);
	const falseLink = structuredClone(created.message); falseLink.optionItems[1].cardLinkStatus = "verified_physical_hand_v1";
	assert.equal(validateManagedChoiceDisplay(falseLink, { seatIds }), false);
	const cardlessV1 = createManagedChoiceDisplay({ ...input, optionCardViewIds: undefined });
	assert.equal(cardlessV1.ok, false, "an explicitly malformed optional capability is not silently downgraded");
	assert.equal(JSON.stringify(created.message).includes("cardId"), false);
	assert.equal(JSON.stringify(created.message).includes("proof"), false);
});

test("compact choice display v3 preserves option-index bindings and only removes redundant wire metadata", () => {
	const optionIds = Array.from({ length: 12 }, (_, i) => `native_option_${(i + 1).toString(16).padStart(32, "0")}`);
	const input = { roomId: "room_v3_probe", hostSessionId: `hs_${"3".repeat(32)}`, rootInstanceId: `native_root_${"4".repeat(32)}`,
		nativeEventId: `native_event_${"5".repeat(32)}`, eventInstanceId: "event_30", parentEventInstanceId: "event_29",
		eventSequence: 5, choiceId: "choice_0123456789abcdef", actingSeatId: "seat_b", connectionGeneration: 2,
		captureOrdinal: 3, nativeCompletionOrdinal: 19, seatIds, optionIds,
		optionKinds: Object.fromEntries(optionIds.map((id, i) => [id, i % 2 ? "faShu" : "gongJi"])),
		optionTargetSeatIds: Object.fromEntries(optionIds.map((id, i) => [id, seatIds[i % seatIds.length]])),
		optionCardViewIds: Object.fromEntries(optionIds.map((id, i) => [id, i === 0 ? "view_0123456789abcdef0123456789abcdef" : null])) };
	const full = createManagedChoiceDisplay(input);
	assert.equal(full.ok, true);
	const expected = { roomId: input.roomId, hostSessionId: input.hostSessionId, rootInstanceId: input.rootInstanceId,
		nativeEventId: input.nativeEventId, eventSequence: input.eventSequence, choiceId: input.choiceId,
		seatId: input.actingSeatId, connectionGeneration: input.connectionGeneration, captureOrdinal: input.captureOrdinal,
		nativeCompletionOrdinal: input.nativeCompletionOrdinal, optionIds, seatIds };
	const compact = createCompactManagedChoiceDisplay(full.message, expected);
	assert.equal(compact.ok, true);
	assert.equal(compact.message.schema, "xingbei_v3_managed_choice_display_v3");
	assert.ok(Buffer.byteLength(JSON.stringify(compact.message)) < Buffer.byteLength(JSON.stringify(full.message)));
	assert.equal(compact.message.optionItems.length, optionIds.length);
	assert.deepEqual(compact.message.optionItems.map(item => item.index), optionIds.map((_, index) => index));
	assert.equal(compact.message.optionItems[0].cardViewId, input.optionCardViewIds[optionIds[0]]);
	assert.equal(Object.hasOwn(compact.message.optionItems[0], "optionId"), false);
	assert.equal(Object.hasOwn(compact.message.optionItems[0], "label"), false);
	assert.equal(validateManagedChoiceDisplay(compact.message, expected), true);
	const reordered = structuredClone(compact.message); [reordered.optionItems[0], reordered.optionItems[1]] = [reordered.optionItems[1], reordered.optionItems[0]];
	assert.equal(validateManagedChoiceDisplay(reordered, expected), false, "item order is explicitly bound to the outer opaque option list");
	const wrongIndex = structuredClone(compact.message); wrongIndex.optionItems[0].index = 1;
	assert.equal(validateManagedChoiceDisplay(wrongIndex, expected), false);
});

test("compact private hand wire view preserves recipient-owned card identity and order", () => {
	const source = { schema: "xingbei_v3_private_hand_display_v2", seatId: "seat_b", cards: [
		{ viewId: "opaque_view_id_0000000000000001", name: "gongJi", xiBie: "huo", position: 0 },
		{ viewId: "opaque_view_id_0000000000000002", name: "faShu", xiBie: "shui", position: 1 },
	] };
	const compact = createCompactPrivateHandDisplay(source, "seat_b");
	assert.equal(compact.ok, true);
	assert.equal(validateCompactPrivateHandDisplay(compact.message, "seat_b"), true);
	assert.deepEqual(compact.message.cards, source.cards.map(card => [card.viewId, card.name, card.xiBie]));
	assert.ok(Buffer.byteLength(JSON.stringify(compact.message)) < Buffer.byteLength(JSON.stringify(source)));
	assert.equal(validateCompactPrivateHandDisplay(compact.message, "seat_c"), false);
	assert.equal(validateCompactPrivateHandDisplay({ ...compact.message, cards: [["bad"], ...compact.message.cards.slice(1)] }, "seat_b"), false);
});

test("V3 reconnect cursor fences stale generations and rejects gaps outside the requested replay base", () => {
	assert.equal(acceptsReconnectCursor({ currentConnectionGeneration: 3, incomingConnectionGeneration: 3,
		lastSeenSequence: 18, replayFromSequence: 18 }), true);
	assert.equal(acceptsReconnectCursor({ currentConnectionGeneration: 3, incomingConnectionGeneration: 2,
		lastSeenSequence: 18, replayFromSequence: 18 }), false);
	assert.equal(acceptsReconnectCursor({ currentConnectionGeneration: 3, incomingConnectionGeneration: 3,
		lastSeenSequence: 17, replayFromSequence: 18 }), false);
	const staleView = createSeatStateMessage(base()).message;
	assert.equal(validateSeatStateMessage(staleView, { seatIds, seatId: "seat_a", connectionGeneration: 1 }).ok, false);
});

test("V3 pending choice replay keeps identity, legal options and bounded event version", () => {
	const input = base();
	input.pendingChoice.eventSequence = input.stateSequence + 1;
	assert.equal(createSeatStateMessage(input).ok, false);
	input.pendingChoice.eventSequence = 4;
	input.pendingChoice.optionIds.push(input.pendingChoice.optionIds[0]);
	assert.equal(createSeatStateMessage(input).ok, false);
	input.pendingChoice.optionIds = ["option_00000000000001"];
	input.pendingChoice.status = "resolved";
	assert.equal(createSeatStateMessage(input).ok, false);
});

test("V3 isolated publisher refuses unauthenticated and stopped managed-host sources before building a player view", () => {
	let viewReads = 0;
	const publisher = createVerifiedSeatStatePublisher({
		authenticateManagedSource: source => source.hostSessionId === `hs_${"a".repeat(32)}`,
		isHostSessionActive: (_roomId, sessionId) => sessionId === `hs_${"a".repeat(32)}`,
		getPublicState: () => { viewReads++; return { ...base().publicState, stateVersion: 8 }; },
		getSeatPrivateState: (_source, seatId) => ({ seatId, handCardViewIds: [] }),
		getSeatPendingChoice: () => null,
	});
	const input = { source: { roomId: "room_v3_probe", hostSessionId: `hs_${"b".repeat(32)}`,
		rootInstanceId: `native_root_${"c".repeat(32)}`, engineBuildId: "d".repeat(64) },
		seatIds, recipientSeatId: "seat_a", connectionGeneration: 2, stateSequence: 20, stateVersion: 8, replayFromSequence: 19 };
	assert.equal(publisher.createForSeat(input).code, "V3_SEAT_STATE_SOURCE_UNAUTHENTICATED");
	assert.equal(viewReads, 0, "an unauthenticated source must not even invoke player-view projection");
	const authentic = { ...input, source: { ...input.source, hostSessionId: `hs_${"a".repeat(32)}` } };
	assert.equal(publisher.createForSeat(authentic).ok, true);
	assert.equal(viewReads, 1);
});

test("V3 publisher rechecks managed-host lifecycle after per-seat projection construction", () => {
	let active = true, projectionCalls = 0;
	const publisher = createVerifiedSeatStatePublisher({ authenticateManagedSource: () => true,
		isHostSessionActive: () => active,
		getPublicState: () => { projectionCalls++; active = false; return { ...base().publicState, stateVersion: 8 }; },
		getSeatPrivateState: () => ({ seatId: "seat_a", handCardViewIds: [] }), getSeatPendingChoice: () => null });
	const result = publisher.createForSeat({ source: { roomId: "room_v3_probe", hostSessionId: `hs_${"a".repeat(32)}`,
		rootInstanceId: `native_root_${"c".repeat(32)}`, engineBuildId: "d".repeat(64) }, seatIds,
		recipientSeatId: "seat_a", connectionGeneration: 2, stateSequence: 20, stateVersion: 8, replayFromSequence: 19 });
	assert.equal(projectionCalls, 1);
	assert.deepEqual(result, { ok: false, code: "V3_SEAT_STATE_SOURCE_UNAUTHENTICATED" });
});

test("V3 recipient stream fences duplicate/gap sequences, rebind generation and stale private replay", () => {
	const receiver = createSeatStateReceiver({ roomId: "room_v3_probe", seatIds, seatId: "seat_a", connectionGeneration: 2, lastSequence: 18 });
	const make = (sequence, generation, replayFromSequence) => {
		const input = base(); input.stateSequence = sequence; input.connectionGeneration = generation;
		input.stateVersion = sequence - 12; input.publicState.stateVersion = input.stateVersion;
		input.replayFromSequence = replayFromSequence;
		return createSeatStateMessage(input).message;
	};
	assert.equal(receiver.accept(make(19, 2, 18)).ok, true);
	assert.equal(receiver.accept(make(19, 2, 19)).ok, false, "duplicate state sequence must reject");
	assert.equal(receiver.accept(make(21, 2, 19)).ok, false, "a skipped state sequence must reject");
	assert.equal(receiver.rebind({ connectionGeneration: 4, replayFromSequence: 19 }).ok, false, "connection epochs cannot skip");
	assert.equal(receiver.rebind({ connectionGeneration: 3, replayFromSequence: 18 }).ok, false, "rebind cursor must match accepted state");
	assert.equal(receiver.rebind({ connectionGeneration: 3, replayFromSequence: 19 }).ok, true);
	assert.equal(receiver.accept(make(20, 2, 19)).ok, false, "superseded generation cannot replay");
	assert.equal(receiver.accept(make(20, 3, 19)).ok, true);
	const validOtherSequence = make(21, 3, 20);
	const otherSeat = { ...validOtherSequence, privateState: { seatId: "seat_b", handCardViewIds: [] } };
	assert.equal(receiver.accept(otherSeat).ok, false, "private state cannot cross seat recipients");
	receiver.stop();
	assert.equal(receiver.accept(make(21, 3, 20)).code, "V3_SEAT_STATE_RECEIVER_STOPPED");
});
