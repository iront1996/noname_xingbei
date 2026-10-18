"use strict";

const crypto = require("node:crypto");
const { validateNativeCardLedgerSnapshot } = require("./server-managed-native-card-ledger.js");
const { validateManagedNativeEffectStateSnapshot } = require("./server-managed-native-effect-state.js");
const { validateNativeTurnResourceProjectionV2 } = require("./server-managed-native-turn-resource-state-v2.js");

const SCHEMA = "xingbei_native_private_successor_preaction_capture_v1";
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const EVENT = /^native_event_[a-f0-9]{32}$/;
const INSTANCE = /^event_[1-9][0-9]{0,6}$/;
const OPTION = /^native_option_[a-f0-9]{32}$/;

function reject(code) { throw new TypeError(code); }
function plain(value) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype); }
function canonicalize(value, depth = 0) {
	if (depth > 12) reject("SUCCESSOR_PREACTION_TOO_DEEP");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) {
		if (value.length > 8192) reject("SUCCESSOR_PREACTION_TOO_LARGE");
		return `[${value.map(item => canonicalize(item, depth + 1)).join(",")}]`;
	}
	if (plain(value)) {
		const keys = Object.keys(value).sort();
		if (keys.length > 64) reject("SUCCESSOR_PREACTION_TOO_LARGE");
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
	}
	reject("SUCCESSOR_PREACTION_VALUE_UNSUPPORTED");
}

function createManagedSuccessorPreActionCapture({ roomId, sessionId, engineBuildId, rootInstanceId, seatIds,
	previousCapture, previousActorSeatId, seatBinding, key }) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(sessionId || "") ||
		!/^[a-f0-9]{64}$/.test(engineBuildId || "") || !ROOT.test(rootInstanceId || "") || !Array.isArray(seatIds) ||
		seatIds.length !== 4 || new Set(seatIds).size !== 4 || seatIds.some(id => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
		!previousCapture || previousCapture.roomId !== roomId || previousCapture.hostSessionId !== sessionId ||
		previousCapture.rootInstanceId !== rootInstanceId || previousCapture.engineBuildId !== engineBuildId ||
		canonicalize(previousCapture.seatIds) !== canonicalize(seatIds) || !seatIds.includes(previousActorSeatId) ||
		!seatBinding || seatBinding.roomId !== roomId || !seatIds.includes(seatBinding.seatId) ||
		!Number.isSafeInteger(seatBinding.connectionGeneration) || seatBinding.connectionGeneration < 1 ||
		seatBinding.connected !== true || seatBinding.current !== true || seatBinding.credentialAuthenticated !== true ||
		seatBinding.ordinaryPlayer !== true || !Buffer.isBuffer(key) || key.length !== 32) {
		reject("SUCCESSOR_PREACTION_CONFIG_INVALID");
	}
	const scope = Object.freeze({ schema: SCHEMA, schemaVersion: 1, roomId, sessionId, engineBuildId, rootInstanceId,
		seatIds: [...seatIds], previousActorSeatId, previousNativeEventId: previousCapture.nativeEventId,
		previousNativeCompletionOrdinal: previousCapture.nativeCompletionOrdinal, previousStateDigest: previousCapture.stateDigest,
		seatId: seatBinding.seatId, connectionGeneration: seatBinding.connectionGeneration });
	const derivedKey = crypto.createHmac("sha256", key).update("noname-xingbei/private-successor-preaction/v1\0", "utf8")
		.update(canonicalize(scope), "utf8").digest();
	let destroyed = false;
	let ordinal = 0;
	let previousStateDigest = null;
	let previousFence = null;
	return Object.freeze({
		commit(envelope, expected = {}) {
			if (destroyed) reject("SUCCESSOR_PREACTION_DESTROYED");
			const topKeys = "captureOrdinal,cardLedger,effectState,engineBuildId,fence,hostSessionId,roomId,rootInstanceId,schema,seatIds,turnResource";
			if (!plain(envelope) || Object.keys(envelope).sort().join(",") !== topKeys || envelope.schema !== SCHEMA ||
				envelope.captureOrdinal !== ordinal + 1 || envelope.captureOrdinal > 2 || envelope.roomId !== roomId || envelope.hostSessionId !== sessionId ||
				envelope.engineBuildId !== engineBuildId || envelope.rootInstanceId !== rootInstanceId || canonicalize(envelope.seatIds) !== canonicalize(seatIds)) {
				reject("SUCCESSOR_PREACTION_BINDING_INVALID");
			}
			const fence = envelope.fence;
			const fenceKeys = "captureLockKind,candidateOptionIds,candidateOptionKinds,choiceAllocated,controllerStatus,deliveryCount,eventInstanceId,eventName,eventStackConsistent,eventStep,gamePaused,inputWaiting,nativeCompletionOrdinal,nativeEventId,parentChain,pendingInputCount,previousNativeEventId,previousSeatId,rootEventInstanceId,rootMatches,runnableDescendantCount,seatId,useCardChildCount,useResultCount";
			if (!plain(fence) || Object.keys(fence).sort().join(",") !== fenceKeys.split(",").sort().join(",") || fence.captureLockKind !== "successor_native_gate_v1" ||
				fence.choiceAllocated !== false || fence.controllerStatus !== "not_allocated" || fence.deliveryCount !== 0 ||
				fence.eventName !== "gongJiOrFaShu" || fence.nativeEventId === previousCapture.nativeEventId || !EVENT.test(fence.nativeEventId || "") ||
				!INSTANCE.test(fence.eventInstanceId || "") || !seatIds.includes(fence.seatId) || fence.seatId === previousActorSeatId ||
				fence.previousSeatId !== previousActorSeatId || fence.previousNativeEventId !== previousCapture.nativeEventId ||
				fence.inputWaiting !== true || fence.gamePaused !== true || fence.pendingInputCount !== 1 || fence.runnableDescendantCount !== 0 ||
				fence.useResultCount !== 0 || fence.useCardChildCount !== 0 || fence.rootMatches !== true || fence.eventStackConsistent !== true ||
				!INSTANCE.test(fence.rootEventInstanceId || "") || !Number.isSafeInteger(fence.eventStep) || fence.eventStep < 0 ||
				!Number.isSafeInteger(fence.nativeCompletionOrdinal) || fence.nativeCompletionOrdinal <= previousCapture.nativeCompletionOrdinal ||
				!Array.isArray(fence.parentChain) || fence.parentChain.length !== 5 || !Array.isArray(fence.candidateOptionIds) ||
				fence.candidateOptionIds.length < 1 || fence.candidateOptionIds.length > 64 || new Set(fence.candidateOptionIds).size !== fence.candidateOptionIds.length ||
				fence.candidateOptionIds.some(option => !OPTION.test(option)) || !plain(fence.candidateOptionKinds) ||
				Object.keys(fence.candidateOptionKinds).sort().join(",") !== [...fence.candidateOptionIds].sort().join(",") ||
				Object.values(fence.candidateOptionKinds).some(kind => kind !== "gongJi" && kind !== "faShu")) reject("SUCCESSOR_PREACTION_FENCE_INVALID");
			if (ordinal === 1 && fence.nativeCompletionOrdinal <= previousCapture.nativeCompletionOrdinal || ordinal === 2 &&
				(fence.nativeEventId !== previousFence?.nativeEventId || fence.eventInstanceId !== previousFence?.eventInstanceId ||
				fence.nativeCompletionOrdinal !== previousFence?.nativeCompletionOrdinal || fence.seatId !== previousFence?.seatId)) {
				reject("SUCCESSOR_PREACTION_FENCE_REPLAY_INVALID");
			}
			const names = ["game", "phaseLoop", "phase", "xingDong", "gongJiOrFaShu"];
			for (let i = 0; i < names.length; i++) {
				const row = fence.parentChain[i];
				if (!plain(row) || Object.keys(row).sort().join(",") !== "eventInstanceId,eventName,finished,seatId,step" || row.eventName !== names[i] ||
					!INSTANCE.test(row.eventInstanceId || "") || typeof row.finished !== "boolean" || !Number.isSafeInteger(row.step) ||
					(i > 0 && row.seatId !== fence.seatId) || row.finished !== false) reject("SUCCESSOR_PREACTION_PARENT_CHAIN_INVALID");
			}
			if (fence.parentChain[0].eventInstanceId !== fence.rootEventInstanceId || fence.parentChain[4].eventInstanceId !== fence.eventInstanceId ||
				fence.parentChain[4].step !== fence.eventStep || fence.parentChain[4].seatId !== fence.seatId || fence.parentChain[0].seatId !== null ||
				fence.parentChain.some((row, i) => fence.parentChain.slice(i + 1).some(next => next.eventInstanceId === row.eventInstanceId)) ||
				(expected.nativeEventId !== undefined && expected.nativeEventId !== fence.nativeEventId) ||
				(expected.seatId !== undefined && expected.seatId !== fence.seatId) ||
				(expected.nativeCompletionOrdinal !== undefined && expected.nativeCompletionOrdinal !== fence.nativeCompletionOrdinal)) reject("SUCCESSOR_PREACTION_EVENT_BINDING_INVALID");
			const bindings = { roomId, hostSessionId: sessionId, engineBuildId, rootInstanceId, seatIds };
			const cardRows = validateNativeCardLedgerSnapshot(envelope.cardLedger, seatIds);
			const effect = validateManagedNativeEffectStateSnapshot(envelope.effectState, bindings);
			const turn = validateNativeTurnResourceProjectionV2(envelope.turnResource, bindings);
			if (!cardRows.length || envelope.cardLedger.rootInstanceId !== rootInstanceId || envelope.effectState.rootInstanceId !== rootInstanceId ||
				turn.canonical.nativeCompletionOrdinal !== fence.nativeCompletionOrdinal || turn.canonical.turn.phase !== "xingDong" ||
				turn.canonical.turn.actorSeatId !== fence.seatId || turn.canonical.turn.phaseLoopSeatId !== fence.seatId ||
				turn.canonical.turn.currentPhaseSeatId !== fence.seatId || turn.canonical.turn.extraActionQueueEmpty !== true ||
				fence.parentChain[1].eventInstanceId === previousCapture.eventInstanceId) reject("SUCCESSOR_PREACTION_PROJECTION_MISMATCH");
			const preimage = canonicalize({ scope, captureOrdinal: envelope.captureOrdinal, fence, cardLedger: envelope.cardLedger, effectState: envelope.effectState,
				turnResource: turn.canonical });
			if (Buffer.byteLength(preimage, "utf8") > 2 * 1024 * 1024) reject("SUCCESSOR_PREACTION_TOO_LARGE");
			const stateDigest = crypto.createHash("sha256").update(canonicalize({ scope, fence, cardLedger: envelope.cardLedger,
				effectState: envelope.effectState, turnResource: turn.canonical }), "utf8").digest("hex");
			if (ordinal === 1 && stateDigest !== previousStateDigest) reject("SUCCESSOR_PREACTION_REPEAT_STATE_CHANGED");
			const result = Object.freeze({ schema: "xingbei_native_private_successor_preaction_commitment_v1", schemaVersion: 1,
				roomId, hostSessionId: sessionId, rootInstanceId, engineBuildId, seatIds: Object.freeze([...seatIds]),
				captureOrdinal: envelope.captureOrdinal, nativeCompletionOrdinal: fence.nativeCompletionOrdinal, nativeEventId: fence.nativeEventId,
				eventInstanceId: fence.eventInstanceId, seatId: fence.seatId, connectionGeneration: seatBinding.connectionGeneration,
				previousNativeEventId: previousCapture.nativeEventId, previousSeatId: previousActorSeatId,
				previousCommitment: previousCapture.commitment, priorStateDigest: previousCapture.stateDigest,
				candidateOptionCount: fence.candidateOptionIds.length,
				candidateKinds: Object.freeze(Object.fromEntries(["gongJi", "faShu"].map(kind => [kind, fence.candidateOptionIds.filter(id => fence.candidateOptionKinds[id] === kind).length]))),
				stateDigest, stableWithPrevious: ordinal === 0 ? null : true,
				commitment: crypto.createHmac("sha256", derivedKey).update(preimage, "utf8").digest("hex"),
				projectionCount: 3, choiceAllocated: false, nativeDeliveryAllowed: false, authoritySubmissionAllowed: false,
				authorityRevision: 4, nextAuthorityEventSequence: 5, authoritySeedAuthorized: false, checkpointAvailable: false });
			ordinal++;
			previousStateDigest = stateDigest;
			previousFence = Object.freeze({ nativeEventId: fence.nativeEventId, eventInstanceId: fence.eventInstanceId,
				nativeCompletionOrdinal: fence.nativeCompletionOrdinal, seatId: fence.seatId });
			return result;
		},
		destroy() { if (!destroyed) { destroyed = true; derivedKey.fill(0); ordinal = 0; previousStateDigest = null; previousFence = null; } },
	});
}

module.exports = { MANAGED_SUCCESSOR_PREACTION_CAPTURE_SCHEMA: SCHEMA, createManagedSuccessorPreActionCapture };
