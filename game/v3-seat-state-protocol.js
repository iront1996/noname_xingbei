"use strict";

// V3 integration preparation only. This module defines a transport envelope;
// it does not extract native state, authenticate sockets, or publish messages.
const SCHEMA = "xingbei_v3_seat_state_v2";
const HAND_DISPLAY_SCHEMA = "xingbei_v3_private_hand_display_v1";
const HAND_DISPLAY_SCHEMA_V2 = "xingbei_v3_private_hand_display_v2";
const HAND_DISPLAY_SCHEMA_V3 = "xingbei_v3_private_hand_display_v3";
const DISPLAY_SCHEMA = "xingbei_v3_seat_state_v3";
const CAPPED_SCHEMA = "xingbei_v3_capped_readonly_state_v1";
const MANAGED_CHOICE_DISPLAY_SCHEMA = "xingbei_v3_managed_choice_display_v1";
const MANAGED_CHOICE_DISPLAY_SCHEMA_V2 = "xingbei_v3_managed_choice_display_v2";
const MANAGED_CHOICE_DISPLAY_SCHEMA_V3 = "xingbei_v3_managed_choice_display_v3";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{16,96}$/;
const HAND_VIEW = /^(?!native_card_|card_|secret|proof|hmac)[A-Za-z0-9_-]{16,96}$/;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

function reject(code) { return Object.freeze({ ok: false, code }); }
function plain(value) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype); }
function exact(value, keys) {
	return plain(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function safeOpaqueList(value, max = 64) {
	return Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every(item => OPAQUE.test(item));
}
function validPublicState(value, seatIds) {
	if (!exact(value, ["activeSeatId", "phase", "players", "resources", "stateVersion"]) || !seatIds.includes(value.activeSeatId) ||
		!["phaseLoop", "phase", "xingDong", "between_turns"].includes(value.phase) ||
		!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0 || !Array.isArray(value.players) ||
		value.players.length !== seatIds.length || !exact(value.resources, ["hongShiQi", "lanShiQi", "hongXingBei", "lanXingBei", "hongBaoShiCount", "hongShuiJingCount", "lanBaoShiCount", "lanShuiJingCount"]) ||
		![value.resources.hongShiQi, value.resources.lanShiQi].every(n => Number.isSafeInteger(n) && n >= -1000000 && n <= 1000000) ||
		![value.resources.hongXingBei, value.resources.lanXingBei, value.resources.hongBaoShiCount, value.resources.hongShuiJingCount,
			value.resources.lanBaoShiCount, value.resources.lanShuiJingCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)) return false;
	const seen = new Set();
	for (const player of value.players) {
		if (!exact(player, ["characterId", "handCount", "seatId", "side"]) || !seatIds.includes(player.seatId) || seen.has(player.seatId) ||
			(player.characterId !== null && (typeof player.characterId !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(player.characterId))) ||
			(player.side !== null && typeof player.side !== "boolean") || !Number.isSafeInteger(player.handCount) || player.handCount < 0 || player.handCount > 200) return false;
		seen.add(player.seatId);
	}
	return seatIds.every(seatId => seen.has(seatId));
}
function validPrivateState(value, recipientSeatId) {
	return exact(value, ["handCardViewIds", "seatId"]) && value.seatId === recipientSeatId && safeOpaqueList(value.handCardViewIds, 200);
}
function validHandDisplay(value, recipientSeatId, handCount) {
	if (!exact(value, ["schema", "seatId", "cards"]) || ![HAND_DISPLAY_SCHEMA, HAND_DISPLAY_SCHEMA_V2].includes(value.schema) || value.seatId !== recipientSeatId ||
		!Array.isArray(value.cards) || value.cards.length > 200 || value.cards.length !== handCount) return false;
	const ids = new Set();
	for (let index = 0; index < value.cards.length; index++) {
		const card = value.cards[index];
		if (!exact(card, ["viewId", "name", "position", "xiBie"]) || !OPAQUE.test(card.viewId || "") || ids.has(card.viewId) ||
			typeof card.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(card.name) ||
			!['an', 'huo', 'di', 'feng', 'lei', 'shui', 'guang', 'none'].includes(card.xiBie) || card.position !== index) return false;
		ids.add(card.viewId);
	}
	return true;
}
function validatePrivateHandDisplay(value, recipientSeatId) {
	return plain(value) && value.schema === HAND_DISPLAY_SCHEMA_V2 && Array.isArray(value.cards) &&
		validHandDisplay(value, recipientSeatId, value.cards.length);
}
function createCompactPrivateHandDisplay(value, recipientSeatId) {
	if (!validatePrivateHandDisplay(value, recipientSeatId)) return reject("V3_PRIVATE_HAND_DISPLAY_INVALID");
	return Object.freeze({ ok: true, message: Object.freeze({ schema: HAND_DISPLAY_SCHEMA_V3, seatId: recipientSeatId,
		cards: Object.freeze(value.cards.map(card => Object.freeze([card.viewId, card.name, card.xiBie]))) }) });
}
function validateCompactPrivateHandDisplay(value, recipientSeatId) {
	if (!exact(value, ["schema", "seatId", "cards"]) || value.schema !== HAND_DISPLAY_SCHEMA_V3 || value.seatId !== recipientSeatId ||
		!Array.isArray(value.cards) || value.cards.length > 200) return false;
	const ids = new Set();
	return value.cards.every(card => Array.isArray(card) && card.length === 3 && OPAQUE.test(card[0] || "") && !ids.has(card[0]) &&
		(typeof card[1] === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(card[1])) &&
		["an", "huo", "di", "feng", "lei", "shui", "guang", "none"].includes(card[2]) && Boolean(ids.add(card[0])));
}
function validPendingChoice(value, recipientSeatId, sequence) {
	if (value === null) return true;
	return exact(value, ["choiceId", "deadlineAt", "eventSequence", "optionIds", "seatId", "status"]) &&
		value.seatId === recipientSeatId && OPAQUE.test(value.choiceId || "") && Number.isSafeInteger(value.eventSequence) &&
		value.eventSequence >= 1 && value.eventSequence <= sequence && Number.isSafeInteger(value.deadlineAt) &&
		value.deadlineAt > 0 && ["pending", "delivery_pending", "applying"].includes(value.status) &&
		safeOpaqueList(value.optionIds, 64) && value.optionIds.length > 0;
}

const OPERATION_LABELS = Object.freeze({ gongJi: "攻擊", faShu: "法術", unsupported: "合法操作（語意未驗證）" });
function validManagedChoiceDisplay(value, expected = {}) {
	if (value?.schema === MANAGED_CHOICE_DISPLAY_SCHEMA_V3) {
		if (!exact(value, ["schema", "roomId", "hostSessionId", "rootInstanceId", "nativeEventId", "eventInstanceId",
			"parentEventInstanceId", "eventSequence", "choiceId", "actingSeatId", "connectionGeneration", "captureOrdinal",
			"nativeCompletionOrdinal", "optionItems"]) || !ID.test(value.roomId || "") ||
			!/^hs_[a-f0-9]{32}$/.test(value.hostSessionId || "") || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(value.rootInstanceId || "") ||
			!/^native_event_[a-f0-9]{32}$/.test(value.nativeEventId || "") || !/^event_[1-9][0-9]{0,6}$/.test(value.eventInstanceId || "") ||
			!/^event_[1-9][0-9]{0,6}$/.test(value.parentEventInstanceId || "") || !Number.isSafeInteger(value.eventSequence) || value.eventSequence < 5 || value.eventSequence > 8 ||
			!/^choice_[A-Za-z0-9_-]{16,64}$/.test(value.choiceId || "") || !ID.test(value.actingSeatId || "") ||
			!Number.isSafeInteger(value.connectionGeneration) || value.connectionGeneration < 1 || !Number.isSafeInteger(value.captureOrdinal) || value.captureOrdinal < 1 ||
			!Number.isSafeInteger(value.nativeCompletionOrdinal) || value.nativeCompletionOrdinal < 1 || !Array.isArray(value.optionItems) ||
			value.optionItems.length < 1 || value.optionItems.length > 64 ||
			(expected.optionIds && value.optionItems.length !== expected.optionIds.length) ||
			(expected.roomId !== undefined && value.roomId !== expected.roomId) ||
			(expected.hostSessionId !== undefined && value.hostSessionId !== expected.hostSessionId) ||
			(expected.rootInstanceId !== undefined && value.rootInstanceId !== expected.rootInstanceId) ||
			(expected.eventSequence !== undefined && value.eventSequence !== expected.eventSequence) ||
			(expected.choiceId !== undefined && value.choiceId !== expected.choiceId) ||
			(expected.seatId !== undefined && value.actingSeatId !== expected.seatId) ||
			(expected.nativeEventId !== undefined && value.nativeEventId !== expected.nativeEventId) ||
			(expected.connectionGeneration !== undefined && value.connectionGeneration !== expected.connectionGeneration) ||
			(expected.captureOrdinal !== undefined && value.captureOrdinal !== expected.captureOrdinal) ||
			(expected.nativeCompletionOrdinal !== undefined && value.nativeCompletionOrdinal !== expected.nativeCompletionOrdinal) ||
			(expected.seatIds && !expected.seatIds.includes(value.actingSeatId))) return false;
		for (const [index, item] of value.optionItems.entries()) {
			if (!exact(item, ["index", "operationKind", "targetSeatId", "cardViewId", "completeness"]) || item.index !== index ||
				!Object.hasOwn(OPERATION_LABELS, item.operationKind) ||
				(item.targetSeatId !== null && (!ID.test(item.targetSeatId) || (expected.seatIds && !expected.seatIds.includes(item.targetSeatId)))) ||
				(item.cardViewId !== null && !HAND_VIEW.test(item.cardViewId || "")) ||
				!(["partial", "opaque"].includes(item.completeness)) ||
				(item.operationKind === "unsupported" ? item.completeness !== "opaque" : item.completeness !== "partial")) return false;
		}
		return true;
	}
	const v2 = value?.schema === MANAGED_CHOICE_DISPLAY_SCHEMA_V2;
	if (!exact(value, ["schema", "roomId", "hostSessionId", "rootInstanceId", "nativeEventId", "eventInstanceId",
		"parentEventInstanceId", "eventSequence", "choiceId", "actingSeatId", "connectionGeneration", "captureOrdinal",
		"nativeCompletionOrdinal", "optionItems"]) ||
		(!v2 && value.schema !== MANAGED_CHOICE_DISPLAY_SCHEMA) ||
		!ID.test(value.roomId || "") || !/^hs_[a-f0-9]{32}$/.test(value.hostSessionId || "") ||
		!/^native_root_[A-Za-z0-9_-]{16,96}$/.test(value.rootInstanceId || "") ||
		!/^native_event_[a-f0-9]{32}$/.test(value.nativeEventId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(value.eventInstanceId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(value.parentEventInstanceId || "") ||
		!Number.isSafeInteger(value.eventSequence) || value.eventSequence < 5 || value.eventSequence > 8 ||
		!/^choice_[A-Za-z0-9_-]{16,64}$/.test(value.choiceId || "") || !ID.test(value.actingSeatId || "") ||
		!Number.isSafeInteger(value.connectionGeneration) || value.connectionGeneration < 1 ||
		!Number.isSafeInteger(value.captureOrdinal) || value.captureOrdinal < 1 ||
		!Number.isSafeInteger(value.nativeCompletionOrdinal) || value.nativeCompletionOrdinal < 1 ||
		!Array.isArray(value.optionItems) || value.optionItems.length < 1 || value.optionItems.length > 64 ||
		new Set(value.optionItems.map(item => item?.optionId)).size !== value.optionItems.length ||
		(expected.roomId !== undefined && value.roomId !== expected.roomId) ||
		(expected.hostSessionId !== undefined && value.hostSessionId !== expected.hostSessionId) ||
		(expected.rootInstanceId !== undefined && value.rootInstanceId !== expected.rootInstanceId) ||
		(expected.eventSequence !== undefined && value.eventSequence !== expected.eventSequence) ||
		(expected.choiceId !== undefined && value.choiceId !== expected.choiceId) ||
		(expected.seatId !== undefined && value.actingSeatId !== expected.seatId) ||
		(expected.nativeEventId !== undefined && value.nativeEventId !== expected.nativeEventId) ||
		(expected.connectionGeneration !== undefined && value.connectionGeneration !== expected.connectionGeneration) ||
		(expected.captureOrdinal !== undefined && value.captureOrdinal !== expected.captureOrdinal) ||
		(expected.nativeCompletionOrdinal !== undefined && value.nativeCompletionOrdinal !== expected.nativeCompletionOrdinal)) return false;
	if (expected.optionIds && (value.optionItems.length !== expected.optionIds.length ||
		value.optionItems.some((item, index) => item?.optionId !== expected.optionIds[index]))) return false;
	if (expected.seatIds && (!Array.isArray(expected.seatIds) || !expected.seatIds.includes(value.actingSeatId))) return false;
	for (const item of value.optionItems) {
		if (!exact(item, v2 ? ["optionId", "operationKind", "label", "targetSeatId", "cardViewId", "cardLinkStatus", "completeness"] :
			["optionId", "operationKind", "label", "targetSeatId", "cardViewId", "completeness"]) ||
			!/^native_option_[a-f0-9]{32}$/.test(item.optionId || "") ||
			!Object.hasOwn(OPERATION_LABELS, item.operationKind) || item.label !== OPERATION_LABELS[item.operationKind] ||
			(item.targetSeatId !== null && (!ID.test(item.targetSeatId) || (expected.seatIds && !expected.seatIds.includes(item.targetSeatId)))) ||
			(item.cardViewId !== null && (!v2 || !HAND_VIEW.test(item.cardViewId || ""))) ||
			(v2 && item.cardLinkStatus !== (item.cardViewId === null ? "unavailable" : "verified_physical_hand_v1")) ||
			!["partial", "opaque"].includes(item.completeness) ||
			(item.operationKind === "unsupported" ? item.completeness !== "opaque" : item.completeness !== "partial")) return false;
	}
	return true;
}

function createCompactManagedChoiceDisplay(display, expected = {}) {
	if (!validManagedChoiceDisplay(display, expected) || display.schema === MANAGED_CHOICE_DISPLAY_SCHEMA_V3) return reject("V3_MANAGED_CHOICE_DISPLAY_REJECTED");
	const message = Object.freeze({ ...display, schema: MANAGED_CHOICE_DISPLAY_SCHEMA_V3,
		optionItems: Object.freeze(display.optionItems.map((item, index) => Object.freeze({ index, operationKind: item.operationKind,
			targetSeatId: item.targetSeatId, cardViewId: item.cardViewId, completeness: item.completeness }))) });
	if (!validManagedChoiceDisplay(message, expected)) return reject("V3_MANAGED_CHOICE_DISPLAY_REJECTED");
	return Object.freeze({ ok: true, message });
}

// Display labels are derived only from the authenticated native candidate kind.
// Physical card identity is deliberately omitted until a same-capture provenance
// link to this option is available; names and ordering are not sufficient proof.
function createManagedChoiceDisplay(input) {
	const hasCardLink = Object.hasOwn(input || {}, "optionCardViewIds");
	if (!exact(input, hasCardLink ? ["roomId", "hostSessionId", "rootInstanceId", "nativeEventId", "eventInstanceId", "parentEventInstanceId",
		"eventSequence", "choiceId", "actingSeatId", "connectionGeneration", "captureOrdinal", "nativeCompletionOrdinal",
		"seatIds", "optionIds", "optionKinds", "optionTargetSeatIds", "optionCardViewIds"] :
		["roomId", "hostSessionId", "rootInstanceId", "nativeEventId", "eventInstanceId", "parentEventInstanceId",
		"eventSequence", "choiceId", "actingSeatId", "connectionGeneration", "captureOrdinal", "nativeCompletionOrdinal",
		"seatIds", "optionIds", "optionKinds", "optionTargetSeatIds"]) || !Array.isArray(input.seatIds) ||
		!Array.isArray(input.optionIds) || !input.optionKinds || Object.getPrototypeOf(input.optionKinds) !== Object.prototype ||
		!input.optionTargetSeatIds || Object.getPrototypeOf(input.optionTargetSeatIds) !== Object.prototype ||
		Object.keys(input.optionKinds).sort().join(",") !== [...input.optionIds].sort().join(",") ||
		Object.keys(input.optionTargetSeatIds).sort().join(",") !== [...input.optionIds].sort().join(",") ||
		(hasCardLink && (!input.optionCardViewIds || Object.getPrototypeOf(input.optionCardViewIds) !== Object.prototype ||
			Object.keys(input.optionCardViewIds).sort().join(",") !== [...input.optionIds].sort().join(",") ||
			input.optionIds.some(id => input.optionCardViewIds[id] !== null && !HAND_VIEW.test(input.optionCardViewIds[id] || ""))))) return reject("V3_MANAGED_CHOICE_DISPLAY_REJECTED");
	const optionItems = input.optionIds.map(optionId => {
		const kind = input.optionKinds[optionId];
		const operationKind = kind === "gongJi" || kind === "faShu" ? kind : "unsupported";
		const targetSeatId = input.optionTargetSeatIds[optionId];
		const cardViewId = hasCardLink ? input.optionCardViewIds[optionId] : null;
		return Object.freeze({ optionId, operationKind, label: OPERATION_LABELS[operationKind],
			targetSeatId: input.seatIds.includes(targetSeatId) ? targetSeatId : null,
			cardViewId, ...(hasCardLink ? { cardLinkStatus: cardViewId === null ? "unavailable" : "verified_physical_hand_v1" } : {}),
			completeness: operationKind === "unsupported" ? "opaque" : "partial" });
	});
	const message = Object.freeze({ schema: hasCardLink ? MANAGED_CHOICE_DISPLAY_SCHEMA_V2 : MANAGED_CHOICE_DISPLAY_SCHEMA, roomId: input.roomId, hostSessionId: input.hostSessionId,
		rootInstanceId: input.rootInstanceId, nativeEventId: input.nativeEventId, eventInstanceId: input.eventInstanceId,
		parentEventInstanceId: input.parentEventInstanceId, eventSequence: input.eventSequence, choiceId: input.choiceId,
		actingSeatId: input.actingSeatId, connectionGeneration: input.connectionGeneration, captureOrdinal: input.captureOrdinal,
		nativeCompletionOrdinal: input.nativeCompletionOrdinal, optionItems: Object.freeze(optionItems) });
	return validManagedChoiceDisplay(message, { ...input, seatId: input.actingSeatId })
		? Object.freeze({ ok: true, message }) : reject("V3_MANAGED_CHOICE_DISPLAY_REJECTED");
}
function validateManagedChoiceDisplay(message, expected = {}) {
	return validManagedChoiceDisplay(message, expected);
}

function createSeatStateMessage(input) {
	if (!plain(input) || !Array.isArray(input.seatIds) || input.seatIds.length < 2 || input.seatIds.length > 8 ||
		input.seatIds.some(seatId => !ID.test(seatId)) || new Set(input.seatIds).size !== input.seatIds.length ||
		!ID.test(input.roomId || "") || !ID.test(input.recipientSeatId || "") || !input.seatIds.includes(input.recipientSeatId) ||
		!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1 ||
		!Number.isSafeInteger(input.stateSequence) || input.stateSequence < 1 || input.stateSequence > MAX_SEQUENCE ||
		!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 1 || input.stateVersion > MAX_SEQUENCE ||
		!Number.isSafeInteger(input.replayFromSequence) || input.replayFromSequence < 0 || input.replayFromSequence >= input.stateSequence ||
		!validPublicState(input.publicState, input.seatIds) || input.publicState.stateVersion !== input.stateVersion ||
		!validPrivateState(input.privateState, input.recipientSeatId) ||
		!validPendingChoice(input.pendingChoice, input.recipientSeatId, input.stateSequence)) return reject("V3_SEAT_STATE_ENVELOPE_REJECTED");
	return Object.freeze({ ok: true, message: Object.freeze({ schema: SCHEMA, roomId: input.roomId,
		recipientSeatId: input.recipientSeatId, connectionGeneration: input.connectionGeneration,
		stateSequence: input.stateSequence, stateVersion: input.stateVersion, replayFromSequence: input.replayFromSequence,
		publicState: Object.freeze({ ...input.publicState, resources: Object.freeze({ ...input.publicState.resources }),
			players: Object.freeze(input.publicState.players.map(player => Object.freeze({ ...player }))) }),
		privateState: Object.freeze({ seatId: input.recipientSeatId, handCardViewIds: Object.freeze([...input.privateState.handCardViewIds]) }),
		pendingChoice: input.pendingChoice === null ? null : Object.freeze({ ...input.pendingChoice,
			optionIds: Object.freeze([...input.pendingChoice.optionIds]) }) }) });
}

function validateSeatStateMessage(message, expected = {}) {
	if (!exact(message, ["schema", "roomId", "recipientSeatId", "connectionGeneration", "stateSequence", "stateVersion",
		"replayFromSequence", "publicState", "privateState", "pendingChoice"]) || message.schema !== SCHEMA ||
		(expected.roomId !== undefined && message.roomId !== expected.roomId) ||
		(expected.seatId !== undefined && message.recipientSeatId !== expected.seatId) ||
		(expected.connectionGeneration !== undefined && message.connectionGeneration !== expected.connectionGeneration) ||
		!ID.test(message.roomId || "") || !ID.test(message.recipientSeatId || "") ||
		!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration < 1 ||
		!Number.isSafeInteger(message.stateSequence) || message.stateSequence < 1 ||
		!Number.isSafeInteger(message.stateVersion) || message.stateVersion < 1 ||
		!Number.isSafeInteger(message.replayFromSequence) || message.replayFromSequence < 0 || message.replayFromSequence >= message.stateSequence ||
		!plain(message.publicState) || !Array.isArray(expected.seatIds) || !validPublicState(message.publicState, expected.seatIds) ||
		message.publicState.stateVersion !== message.stateVersion || !validPrivateState(message.privateState, message.recipientSeatId) ||
		!validPendingChoice(message.pendingChoice, message.recipientSeatId, message.stateSequence)) return reject("V3_SEAT_STATE_MESSAGE_REJECTED");
	return Object.freeze({ ok: true, message });
}

// Opt-in v3 adds only a recipient's ordered physical card display. Existing v2
// messages remain byte/schema compatible and continue to carry opaque IDs only.
function createSeatStateDisplayMessage(input) {
	if (!plain(input) || !Array.isArray(input.seatIds) || input.seatIds.length < 2 || input.seatIds.length > 8 ||
		input.seatIds.some(seatId => !ID.test(seatId)) || new Set(input.seatIds).size !== input.seatIds.length ||
		!ID.test(input.roomId || "") || !ID.test(input.recipientSeatId || "") || !input.seatIds.includes(input.recipientSeatId) ||
		!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1 ||
		!Number.isSafeInteger(input.stateSequence) || input.stateSequence < 1 || input.stateSequence > MAX_SEQUENCE ||
		!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 1 || input.stateVersion > MAX_SEQUENCE ||
		input.replayFromSequence !== input.stateSequence - 1 || !validPublicState(input.publicState, input.seatIds) ||
		input.publicState.stateVersion !== input.stateVersion || !validHandDisplay(input.privateState, input.recipientSeatId,
			input.publicState.players.find(player => player.seatId === input.recipientSeatId)?.handCount) ||
		!validPendingChoice(input.pendingChoice, input.recipientSeatId, input.stateSequence)) return reject("V3_SEAT_DISPLAY_ENVELOPE_REJECTED");
	return Object.freeze({ ok: true, message: Object.freeze({ schema: DISPLAY_SCHEMA, roomId: input.roomId,
		recipientSeatId: input.recipientSeatId, connectionGeneration: input.connectionGeneration,
		stateSequence: input.stateSequence, stateVersion: input.stateVersion, replayFromSequence: input.replayFromSequence,
		publicState: Object.freeze({ ...input.publicState, resources: Object.freeze({ ...input.publicState.resources }),
			players: Object.freeze(input.publicState.players.map(player => Object.freeze({ ...player }))) }),
		privateState: Object.freeze({ schema: input.privateState.schema, seatId: input.recipientSeatId,
			cards: Object.freeze(input.privateState.cards.map(card => Object.freeze({ ...card }))) }),
		pendingChoice: input.pendingChoice === null ? null : Object.freeze({ ...input.pendingChoice,
			optionIds: Object.freeze([...input.pendingChoice.optionIds]) }) }) });
}

function validateSeatStateDisplayMessage(message, expected = {}) {
	if (!exact(message, ["schema", "roomId", "recipientSeatId", "connectionGeneration", "stateSequence", "stateVersion",
		"replayFromSequence", "publicState", "privateState", "pendingChoice"]) || message.schema !== DISPLAY_SCHEMA ||
		(expected.roomId !== undefined && message.roomId !== expected.roomId) ||
		(expected.seatId !== undefined && message.recipientSeatId !== expected.seatId) ||
		(expected.connectionGeneration !== undefined && message.connectionGeneration !== expected.connectionGeneration) ||
		!ID.test(message.roomId || "") || !ID.test(message.recipientSeatId || "") ||
		!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration < 1 ||
		!Number.isSafeInteger(message.stateSequence) || message.stateSequence < 1 ||
		!Number.isSafeInteger(message.stateVersion) || message.stateVersion < 1 ||
		message.replayFromSequence !== message.stateSequence - 1 || !Array.isArray(expected.seatIds) ||
		!validPublicState(message.publicState, expected.seatIds) || message.publicState.stateVersion !== message.stateVersion ||
		!validHandDisplay(message.privateState, message.recipientSeatId,
			message.publicState.players.find(player => player.seatId === message.recipientSeatId)?.handCount) ||
		!validPendingChoice(message.pendingChoice, message.recipientSeatId, message.stateSequence)) return reject("V3_SEAT_DISPLAY_MESSAGE_REJECTED");
	return Object.freeze({ ok: true, message });
}

function acceptsReconnectCursor({ currentConnectionGeneration, incomingConnectionGeneration, lastSeenSequence, replayFromSequence }) {
	return Number.isSafeInteger(currentConnectionGeneration) && currentConnectionGeneration >= 1 &&
		Number.isSafeInteger(incomingConnectionGeneration) && incomingConnectionGeneration === currentConnectionGeneration &&
		Number.isSafeInteger(lastSeenSequence) && lastSeenSequence >= 0 &&
		Number.isSafeInteger(replayFromSequence) && replayFromSequence === lastSeenSequence;
}

function createCappedReadOnlySeatState(input) {
	if (!plain(input) || !ID.test(input.roomId || "") || !ID.test(input.recipientSeatId || "") ||
		!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1 ||
		!Number.isSafeInteger(input.stateSequence) || input.stateSequence < 1 ||
		!Number.isSafeInteger(input.replayFromSequence) || input.replayFromSequence < 0 || input.replayFromSequence >= input.stateSequence ||
		input.authorityRevision !== 8 || input.lastAcceptedEventSequence !== 8 || input.nextAuthorityEventSequence !== 9 ||
		!Number.isSafeInteger(input.captureOrdinal) || input.captureOrdinal < 1 ||
		!Number.isSafeInteger(input.nativeCompletionOrdinal) || input.nativeCompletionOrdinal < 1 ||
		!/^native_event_[a-f0-9]{32}$/.test(input.nativeEventId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(input.phaseOverEventInstanceId || "") ||
		input.experimentalCeilingReached !== true || input.gameTerminal !== false || input.gameplayEnabled !== false ||
		input.projectionStatus !== "verified_capture_payload_unavailable") return reject("V3_CAPPED_STATE_ENVELOPE_REJECTED");
	return Object.freeze({ ok: true, message: Object.freeze({ schema: CAPPED_SCHEMA, roomId: input.roomId,
		recipientSeatId: input.recipientSeatId, connectionGeneration: input.connectionGeneration,
		stateSequence: input.stateSequence, replayFromSequence: input.replayFromSequence,
		authorityRevision: 8, lastAcceptedEventSequence: 8, nextAuthorityEventSequence: 9,
		captureOrdinal: input.captureOrdinal, nativeCompletionOrdinal: input.nativeCompletionOrdinal,
		nativeEventId: input.nativeEventId, phaseOverEventInstanceId: input.phaseOverEventInstanceId,
		experimentalCeilingReached: true, gameTerminal: false, gameplayEnabled: false,
		projectionStatus: "verified_capture_payload_unavailable" }) });
}

function validateCappedReadOnlySeatState(message, expected = {}) {
	const keys = ["schema", "roomId", "recipientSeatId", "connectionGeneration", "stateSequence", "replayFromSequence",
		"authorityRevision", "lastAcceptedEventSequence", "nextAuthorityEventSequence", "captureOrdinal", "nativeCompletionOrdinal",
		"nativeEventId", "phaseOverEventInstanceId", "experimentalCeilingReached", "gameTerminal", "gameplayEnabled", "projectionStatus"];
	if (!exact(message, keys) || message.schema !== CAPPED_SCHEMA ||
		(expected.roomId !== undefined && message.roomId !== expected.roomId) ||
		(expected.seatId !== undefined && message.recipientSeatId !== expected.seatId) ||
		(expected.connectionGeneration !== undefined && message.connectionGeneration !== expected.connectionGeneration) ||
		!ID.test(message.roomId || "") || !ID.test(message.recipientSeatId || "") ||
		!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration < 1 ||
		!Number.isSafeInteger(message.stateSequence) || message.stateSequence < 1 ||
		!Number.isSafeInteger(message.replayFromSequence) || message.replayFromSequence < 0 || message.replayFromSequence >= message.stateSequence ||
		message.authorityRevision !== 8 || message.lastAcceptedEventSequence !== 8 || message.nextAuthorityEventSequence !== 9 ||
		!Number.isSafeInteger(message.captureOrdinal) || message.captureOrdinal < 1 ||
		!Number.isSafeInteger(message.nativeCompletionOrdinal) || message.nativeCompletionOrdinal < 1 ||
		!/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") ||
		!/^event_[1-9][0-9]{0,6}$/.test(message.phaseOverEventInstanceId || "") ||
		message.experimentalCeilingReached !== true || message.gameTerminal !== false || message.gameplayEnabled !== false ||
		message.projectionStatus !== "verified_capture_payload_unavailable") return reject("V3_CAPPED_STATE_MESSAGE_REJECTED");
	return Object.freeze({ ok: true, message });
}

module.exports = { SCHEMA, CAPPED_SCHEMA, HAND_DISPLAY_SCHEMA, DISPLAY_SCHEMA, createSeatStateMessage, validateSeatStateMessage,
	createSeatStateDisplayMessage, validateSeatStateDisplayMessage,
	HAND_DISPLAY_SCHEMA_V2, HAND_DISPLAY_SCHEMA_V3, validatePrivateHandDisplay, createCompactPrivateHandDisplay, validateCompactPrivateHandDisplay,
	MANAGED_CHOICE_DISPLAY_SCHEMA, MANAGED_CHOICE_DISPLAY_SCHEMA_V2, MANAGED_CHOICE_DISPLAY_SCHEMA_V3, createManagedChoiceDisplay,
	createCompactManagedChoiceDisplay, validateManagedChoiceDisplay,
	createCappedReadOnlySeatState, validateCappedReadOnlySeatState, acceptsReconnectCursor };
