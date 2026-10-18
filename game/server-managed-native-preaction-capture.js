"use strict";

const crypto = require("node:crypto");
const { validateNativeCardLedgerSnapshot } = require("./server-managed-native-card-ledger.js");
const { validateManagedNativeEffectStateSnapshot } = require("./server-managed-native-effect-state.js");
const { validateNativeTurnResourceProjectionV2 } = require("./server-managed-native-turn-resource-state-v2.js");

const SCHEMA = "xingbei_native_private_pre_action_capture_v1";
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const EVENT = /^event_[1-9][0-9]{0,6}$/;
const NATIVE_EVENT = /^native_[A-Za-z0-9_-]{16,96}$/;
const CHOICE = /^choice_[a-f0-9]{32}$/;

function fail(code) { throw new TypeError(code); }
function plain(value) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype); }
function canonicalize(value, depth = 0) {
	if (depth > 12) fail("NATIVE_PREACTION_CAPTURE_TOO_DEEP");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) {
		if (value.length > 8192) fail("NATIVE_PREACTION_CAPTURE_TOO_LARGE");
		return `[${value.map(item => canonicalize(item, depth + 1)).join(",")}]`;
	}
	if (plain(value)) {
		const keys = Object.keys(value).sort();
		if (keys.length > 64) fail("NATIVE_PREACTION_CAPTURE_TOO_LARGE");
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
	}
	fail("NATIVE_PREACTION_CAPTURE_VALUE_UNSUPPORTED");
}

function createManagedNativePreActionCapture({ roomId, sessionId, engineBuildId, rootInstanceId, seatIds, key }) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(sessionId || "") ||
		!/^[a-f0-9]{64}$/.test(engineBuildId || "") || !ROOT.test(rootInstanceId || "") || !Array.isArray(seatIds) ||
		seatIds.length !== 4 || new Set(seatIds).size !== 4 || seatIds.some(id => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
		!Buffer.isBuffer(key) || key.length !== 32) fail("NATIVE_PREACTION_CAPTURE_CONFIG_INVALID");
	const scope = Object.freeze({ schema: SCHEMA, schemaVersion: 1, roomId, sessionId, engineBuildId, rootInstanceId, seatIds: [...seatIds] });
	const derivedKey = crypto.createHmac("sha256", key).update("noname-xingbei/private-pre-action-capture/v1\0", "utf8")
		.update(canonicalize(scope), "utf8").digest();
	let destroyed = false;
	let committed = false;
	return Object.freeze({
		commit(envelope, expected = {}) {
			if (destroyed) fail("NATIVE_PREACTION_CAPTURE_DESTROYED");
			if (committed) fail("NATIVE_PREACTION_CAPTURE_ALREADY_COMMITTED");
			const keys = "captureOrdinal,cardLedger,effectState,engineBuildId,fence,hostSessionId,roomId,rootInstanceId,schema,seatIds,turnResource";
			if (!plain(envelope) || Object.keys(envelope).sort().join(",") !== keys || envelope.schema !== SCHEMA ||
				envelope.captureOrdinal !== 1 || envelope.roomId !== roomId || envelope.hostSessionId !== sessionId ||
				envelope.engineBuildId !== engineBuildId || envelope.rootInstanceId !== rootInstanceId ||
				canonicalize(envelope.seatIds) !== canonicalize(seatIds)) fail("NATIVE_PREACTION_CAPTURE_BINDING_INVALID");
			const fence = envelope.fence;
			if (!plain(fence) || Object.keys(fence).sort().join(",") !==
				"captureLockKind,choiceId,controllerStatus,deliveryCount,eventInstanceId,eventName,eventStackConsistent,eventStep,gamePaused,inputWaiting,nativeCompletionOrdinal,nativeEventId,parentChain,pendingInputCount,resultPresent,rootEventInstanceId,rootMatches,runnableDescendantCount,seatId,useCardChildCount,useResultCount" ||
				fence.captureLockKind !== "single_turn_native_task_v1" || fence.eventName !== "gongJiOrFaShu" ||
				!NATIVE_EVENT.test(fence.nativeEventId || "") || !EVENT.test(fence.eventInstanceId || "") ||
				!CHOICE.test(fence.choiceId || "") || !seatIds.includes(fence.seatId) || fence.inputWaiting !== true ||
				fence.gamePaused !== true || fence.resultPresent !== false || fence.useResultCount !== 0 ||
				fence.useCardChildCount !== 0 || fence.pendingInputCount !== 1 || fence.deliveryCount !== 0 || fence.runnableDescendantCount !== 0 ||
				fence.controllerStatus !== "pending" || fence.rootMatches !== true || fence.eventStackConsistent !== true ||
				!EVENT.test(fence.rootEventInstanceId || "") ||
				!Number.isSafeInteger(fence.eventStep) || fence.eventStep < 0 ||
				!Number.isSafeInteger(fence.nativeCompletionOrdinal) || fence.nativeCompletionOrdinal < 1 ||
				!Array.isArray(fence.parentChain) || fence.parentChain.length !== 5) fail("NATIVE_PREACTION_CAPTURE_FENCE_INVALID");
			const names = ["game", "phaseLoop", "phase", "xingDong", "gongJiOrFaShu"];
			for (let index = 0; index < names.length; index++) {
				const row = fence.parentChain[index];
				if (!plain(row) || Object.keys(row).sort().join(",") !== "eventInstanceId,eventName,finished,seatId,step" ||
					row.eventName !== names[index] || !EVENT.test(row.eventInstanceId || "") || typeof row.finished !== "boolean" ||
					!Number.isSafeInteger(row.step) || (index > 0 && row.seatId !== fence.seatId)) fail("NATIVE_PREACTION_CAPTURE_PARENT_CHAIN_INVALID");
			}
			if (fence.parentChain[0].eventInstanceId !== fence.rootEventInstanceId ||
				fence.parentChain[4].eventInstanceId !== fence.eventInstanceId || fence.parentChain[4].step !== fence.eventStep ||
				fence.parentChain[4].seatId !== fence.seatId || fence.parentChain[0].seatId !== null ||
				fence.parentChain.slice(1).some(row => row.finished === true) ||
				fence.parentChain.some((row, index) => fence.parentChain.slice(index + 1).some(next => next.eventInstanceId === row.eventInstanceId)) ||
				(expected.nativeEventId !== undefined && fence.nativeEventId !== expected.nativeEventId) ||
				(expected.choiceId !== undefined && fence.choiceId !== expected.choiceId) ||
				(expected.seatId !== undefined && fence.seatId !== expected.seatId) ||
				(expected.nativeCompletionOrdinal !== undefined && fence.nativeCompletionOrdinal !== expected.nativeCompletionOrdinal)) {
				fail("NATIVE_PREACTION_CAPTURE_EVENT_BINDING_INVALID");
			}
			const cardRows = validateNativeCardLedgerSnapshot(envelope.cardLedger, seatIds);
			const effect = validateManagedNativeEffectStateSnapshot(envelope.effectState,
				{ roomId, hostSessionId: sessionId, engineBuildId, rootInstanceId, seatIds });
			const turn = validateNativeTurnResourceProjectionV2(envelope.turnResource,
				{ roomId, hostSessionId: sessionId, engineBuildId, rootInstanceId, seatIds });
			const turnData = turn.canonical.turn;
			if (envelope.turnResource.fence.kind !== "managed_native_input_waiting_fence_v1" ||
				cardRows.length < 1 || envelope.cardLedger.rootInstanceId !== rootInstanceId ||
				envelope.effectState.rootInstanceId !== rootInstanceId ||
				turn.canonical.nativeCompletionOrdinal !== fence.nativeCompletionOrdinal || turnData.phase !== "xingDong" ||
				turnData.actorSeatId !== fence.seatId || turnData.phaseLoopSeatId !== fence.seatId ||
				turnData.currentPhaseSeatId !== fence.seatId || turnData.extraActionQueueEmpty !== true) {
				fail("NATIVE_PREACTION_CAPTURE_PROJECTION_MISMATCH");
			}
			const statePreimage = canonicalize({ scope, fence, cardLedger: envelope.cardLedger,
				effectState: envelope.effectState, turnResource: turn.canonical });
			if (Buffer.byteLength(statePreimage, "utf8") > 2 * 1024 * 1024) fail("NATIVE_PREACTION_CAPTURE_TOO_LARGE");
			const commitment = crypto.createHmac("sha256", derivedKey).update(statePreimage, "utf8").digest("hex");
			const stateDigest = crypto.createHash("sha256").update(statePreimage, "utf8").digest("hex");
			committed = true;
			return Object.freeze({ schema: "xingbei_native_private_pre_action_commitment_v1", schemaVersion: 1,
				roomId, hostSessionId: sessionId,
				captureOrdinal: 1, nativeCompletionOrdinal: fence.nativeCompletionOrdinal, nativeEventId: fence.nativeEventId,
				eventInstanceId: fence.eventInstanceId, choiceId: fence.choiceId, seatId: fence.seatId,
				rootInstanceId, engineBuildId, stateDigest, commitment, projectionCount: 3,
				boundaryKind: "native_input_waiting_quiescent", authoritySeedAuthorized: false, checkpointAvailable: false });
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			derivedKey.fill(0);
			committed = false;
		},
	});
}

module.exports = { MANAGED_NATIVE_PREACTION_CAPTURE_SCHEMA: SCHEMA, createManagedNativePreActionCapture };
