"use strict";

// Read-only preparation contract for a successor native input gate. This module
// deliberately does not allocate a managed choice, deadline, delivery or
// authority event and must not be wired to openChoice().
const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^hs_[a-f0-9]{32}$/;
const SEAT = /^[A-Za-z0-9_-]{1,64}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const EVENT = /^native_event_[a-f0-9]{32}$/;
const OPTION = /^native_option_[a-f0-9]{32}$/;
const BUILD = /^[a-f0-9]{64}$/;
const CONNECTION = /^[A-Za-z0-9_-]{1,128}$/;

function reject(code) { return Object.freeze({ ok: false, code }); }
function exact(value, keys) {
	return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
function uniqueSeats(value) {
	return Array.isArray(value) && value.length === 4 && value.every(seat => SEAT.test(seat)) && new Set(value).size === 4;
}

function validateNativeFenceEvidence(candidate, evidence) {
	if (!exact(evidence, "stage,rootInstanceId,rootObjectMatches,paused,gameMeAbsent,currentEventName,currentEventStep,currentSeatId,eventStack,eventStackDetails,nativeInputGate".split(",")) ||
		evidence.stage !== "native_input_wait_open" || evidence.rootInstanceId !== candidate.rootInstanceId || evidence.rootObjectMatches !== true || evidence.paused !== true || evidence.gameMeAbsent !== true ||
		evidence.currentEventName !== candidate.eventName || !Number.isSafeInteger(evidence.currentEventStep) || evidence.currentEventStep < 0 ||
		evidence.currentSeatId !== candidate.seatId || !Array.isArray(evidence.eventStack) || !Array.isArray(evidence.eventStackDetails) ||
		evidence.eventStack.length !== 5 || evidence.eventStackDetails.length !== 5 ||
		evidence.eventStack.join(",") !== "game,phaseLoop,phase,xingDong,gongJiOrFaShu") return false;
	const expectedParents = [null, "game", "phaseLoop", "phase", "xingDong"];
	for (let index = 0; index < evidence.eventStackDetails.length; index++) {
		const detail = evidence.eventStackDetails[index];
		if (!exact(detail, "eventName,parentEventName,seatId,finished,nextCount,nextHeadName,nextHeadFinished".split(",")) ||
			detail.eventName !== evidence.eventStack[index] || detail.parentEventName !== expectedParents[index] || detail.finished !== false ||
			!Number.isSafeInteger(detail.nextCount) || detail.nextCount < 0 || typeof detail.nextHeadFinished !== "boolean") return false;
		if (index > 0 && detail.seatId !== candidate.seatId) return false;
		if (index < evidence.eventStackDetails.length - 1 &&
			(detail.nextCount !== 1 || detail.nextHeadName !== evidence.eventStackDetails[index + 1].eventName || detail.nextHeadFinished !== false)) return false;
		if (index === evidence.eventStackDetails.length - 1 &&
			(detail.nextCount !== 0 || detail.nextHeadName !== null || detail.nextHeadFinished !== false)) return false;
	}
	const gate = evidence.nativeInputGate;
	return exact(gate, "diagnosticOnly,eventName,nativeEventId,seatId,action,waiting".split(",")) &&
		gate.diagnosticOnly === true && gate.eventName === candidate.eventName && gate.nativeEventId === candidate.nativeEventId &&
		gate.seatId === candidate.seatId && gate.action === true && gate.waiting === true;
}

function prepareNextSeatChoice(input) {
	const fields = "candidate,authorityTip,seatBinding,priorChoice,managedContext,expectedNextSeatId,previousActorSeatId,seatIds,hostProcessStable,chromiumProcessStable,nativeFenceEvidence";
	if (!exact(input, fields.split(","))) return reject("NEXT_SEAT_PREPARATION_INPUT_REJECTED");
	const candidate = input.candidate;
	const managedContext = input.managedContext;
	if (!exact(managedContext, "roomId,hostSessionId,rootInstanceId,engineBuildId,seatIds".split(",")) ||
		!ROOM.test(managedContext.roomId || "") || !SESSION.test(managedContext.hostSessionId || "") ||
		!ROOT.test(managedContext.rootInstanceId || "") || !BUILD.test(managedContext.engineBuildId || "") || !uniqueSeats(managedContext.seatIds)) {
		return reject("NEXT_SEAT_MANAGED_CONTEXT_REJECTED");
	}
	const candidateKeys = "roomId,hostSessionId,rootInstanceId,engineBuildId,seatIds,nativeEventId,eventName,parentEventName,seatId,options,optionKinds,waiting,diagnosticOnly";
	if (!exact(candidate, candidateKeys.split(",")) || !ROOM.test(candidate.roomId || "") || !SESSION.test(candidate.hostSessionId || "") ||
		!ROOT.test(candidate.rootInstanceId || "") || !BUILD.test(candidate.engineBuildId || "") || !uniqueSeats(candidate.seatIds) ||
		candidate.eventName !== "gongJiOrFaShu" || candidate.parentEventName !== "xingDong" || candidate.waiting !== true ||
		candidate.diagnosticOnly !== true || candidate.roomId !== managedContext.roomId ||
		candidate.hostSessionId !== managedContext.hostSessionId || candidate.rootInstanceId !== managedContext.rootInstanceId ||
		candidate.engineBuildId !== managedContext.engineBuildId || candidate.seatIds.join(",") !== managedContext.seatIds.join(",") ||
		!EVENT.test(candidate.nativeEventId || "") || !SEAT.test(candidate.seatId || "") ||
		!Array.isArray(candidate.options) || candidate.options.length < 1 || candidate.options.length > 64 ||
		new Set(candidate.options).size !== candidate.options.length || candidate.options.some(option => !OPTION.test(option)) ||
		!candidate.optionKinds || Object.getPrototypeOf(candidate.optionKinds) !== Object.prototype ||
		Object.keys(candidate.optionKinds).sort().join(",") !== [...candidate.options].sort().join(",") ||
		Object.values(candidate.optionKinds).some(kind => kind !== "gongJi" && kind !== "faShu")) {
		return reject("NEXT_SEAT_NATIVE_GATE_REJECTED");
	}
	if (!exact(input.authorityTip, "revision,nextSequence,lastSequence,event5Accepted,checkpointAvailable".split(",")) ||
		input.authorityTip.revision !== 4 || input.authorityTip.nextSequence !== 5 || input.authorityTip.lastSequence !== 4 ||
		input.authorityTip.event5Accepted !== false || input.authorityTip.checkpointAvailable !== false) {
		return reject("NEXT_SEAT_AUTHORITY_TIP_REJECTED");
	}
	const binding = input.seatBinding;
	if (!exact(binding, "roomId,seatId,connectionId,connectionGeneration,connected,current,credentialAuthenticated,ordinaryPlayer".split(",")) ||
		binding.roomId !== candidate.roomId || binding.seatId !== candidate.seatId || !CONNECTION.test(binding.connectionId || "") ||
		!Number.isSafeInteger(binding.connectionGeneration) || binding.connectionGeneration < 1 || binding.connected !== true ||
		binding.current !== true || binding.credentialAuthenticated !== true || binding.ordinaryPlayer !== true) {
		return reject("NEXT_SEAT_BINDING_REJECTED");
	}
	const prior = input.priorChoice;
	if (!exact(prior, "roomId,hostSessionId,nativeEventId,seatId,state,deadlineActive,deliveryActive".split(",")) ||
		prior.roomId !== candidate.roomId || prior.hostSessionId !== candidate.hostSessionId || prior.seatId !== input.previousActorSeatId ||
		!EVENT.test(prior.nativeEventId || "") || prior.nativeEventId === candidate.nativeEventId || prior.state !== "resolved" ||
		prior.deadlineActive !== false || prior.deliveryActive !== false) {
		return reject("NEXT_SEAT_PRIOR_CHOICE_NOT_CLEAN");
	}
	if (!uniqueSeats(input.seatIds) || input.seatIds.join(",") !== candidate.seatIds.join(",") ||
		input.seatIds.join(",") !== managedContext.seatIds.join(",") ||
		!SEAT.test(input.expectedNextSeatId || "") || input.expectedNextSeatId !== candidate.seatId ||
		!SEAT.test(input.previousActorSeatId || "") || input.previousActorSeatId === candidate.seatId ||
		input.hostProcessStable !== true || input.chromiumProcessStable !== true ||
		!validateNativeFenceEvidence(candidate, input.nativeFenceEvidence)) {
		return reject("NEXT_SEAT_CONTINUATION_NOT_QUIESCENT");
	}
	const optionKinds = Object.freeze(Object.fromEntries(candidate.options.map(option => [option, candidate.optionKinds[option]])));
	return Object.freeze({ ok: true, preparation: Object.freeze({
		schema: "xingbei_next_seat_choice_preparation_v1", readOnly: true, sideEffectFree: true,
		roomId: candidate.roomId, hostSessionId: candidate.hostSessionId, rootInstanceId: candidate.rootInstanceId,
		engineBuildId: candidate.engineBuildId, seatIds: Object.freeze([...input.seatIds]), seatId: candidate.seatId,
		connectionGeneration: binding.connectionGeneration, nativeEventId: candidate.nativeEventId,
		eventName: candidate.eventName, parentEventName: candidate.parentEventName,
		options: Object.freeze([...candidate.options]), optionKinds,
		authorityRevision: 4, nextAuthorityEventSequence: 5, choiceAllocated: false, deadlineAllocated: false,
		deliveryAllocated: false, nativeDeliveryAllowed: false, authoritySubmissionAllowed: false,
	}) });
}

module.exports = { prepareNextSeatChoice, validateNativeFenceEvidence };
