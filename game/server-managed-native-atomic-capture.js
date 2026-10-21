"use strict";

const crypto = require("node:crypto");
const { validateNativeCardLedgerSnapshot } = require("./server-managed-native-card-ledger.js");
const { validateManagedNativeEffectStateSnapshot } = require("./server-managed-native-effect-state.js");
const { validateNativeTurnResourceProjectionV2 } = require("./server-managed-native-turn-resource-state-v2.js");

const SCHEMA = "xingbei_native_private_atomic_capture_v2";
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;

function fail(code) { throw new TypeError(code); }
function canonicalize(value, depth = 0) {
	if (depth > 12) fail("NATIVE_ATOMIC_CAPTURE_TOO_DEEP");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) {
		if (value.length > 8192) fail("NATIVE_ATOMIC_CAPTURE_TOO_LARGE");
		return `[${value.map(item => canonicalize(item, depth + 1)).join(",")}]`;
	}
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		const keys = Object.keys(value).sort();
		if (keys.length > 64) fail("NATIVE_ATOMIC_CAPTURE_TOO_LARGE");
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
	}
	fail("NATIVE_ATOMIC_CAPTURE_VALUE_UNSUPPORTED");
}

function createManagedNativeAtomicCapture({ roomId, sessionId, engineBuildId, rootInstanceId, seatIds, key, maxCaptures = 8 }) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(sessionId || "") ||
		!/^[a-f0-9]{64}$/.test(engineBuildId || "") || !ROOT.test(rootInstanceId || "") || !Array.isArray(seatIds) ||
		seatIds.length !== 4 || new Set(seatIds).size !== seatIds.length || seatIds.some(id => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
		!Buffer.isBuffer(key) || key.length !== 32 || !Number.isSafeInteger(maxCaptures) || maxCaptures < 1 || maxCaptures > 8) {
		fail("NATIVE_ATOMIC_CAPTURE_CONFIG_INVALID");
	}
	const scope = Object.freeze({ schema: SCHEMA, schemaVersion: 1, roomId, sessionId, engineBuildId, rootInstanceId, seatIds: [...seatIds] });
	const derivedKey = crypto.createHmac("sha256", key).update("noname-xingbei/private-atomic-capture/v1\0", "utf8")
		.update(canonicalize(scope), "utf8").digest();
	let destroyed = false;
	let ordinal = 0;
	let previousDigest = null;
	let previousProjectionDigests = null;
	let previousCompletionProof = null;
	let previousPhaseOverCompletionProof = null;
	let previousFenceOrdinal = 0;
	let previousPhaseOverTriggerCount = 0;
	let previousNextActorSeatId = null;
	return Object.freeze({
		commit(envelope) {
			if (destroyed) fail("NATIVE_ATOMIC_CAPTURE_DESTROYED");
			if (ordinal >= maxCaptures) fail("NATIVE_ATOMIC_CAPTURE_LIMIT");
			const keys = "captureOrdinal,cardLedger,effectState,engineBuildId,fence,hostSessionId,roomId,rootInstanceId,schema,seatIds,turnResource";
			if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype || Object.keys(envelope).sort().join(",") !== keys ||
				envelope.schema !== SCHEMA || envelope.roomId !== roomId || envelope.hostSessionId !== sessionId ||
				envelope.engineBuildId !== engineBuildId || envelope.rootInstanceId !== rootInstanceId ||
				canonicalize(envelope.seatIds) !== canonicalize(seatIds) || envelope.captureOrdinal !== ordinal + 1) {
				fail("NATIVE_ATOMIC_CAPTURE_BINDING_INVALID");
			}
			const fence = envelope.fence;
			if (!fence || Object.getPrototypeOf(fence) !== Object.prototype || Object.keys(fence).sort().join(",") !==
				"allChildrenCompleted,boundaryOrdinal,captureLocked,completionEvidence,eventName,eventStackConsistent,eventStep,nativeCompletionOrdinal,nextActorSeatId,pendingChildCount,phaseOverCompletionEvidence,phaseOverTriggerCount,rootMatches,seatId" ||
				fence.allChildrenCompleted !== true || fence.captureLocked !== true || fence.eventName !== "phaseLoop" ||
				fence.eventStep !== 3 || fence.eventStackConsistent !== true || fence.rootMatches !== true ||
				fence.pendingChildCount !== 0 || !Number.isSafeInteger(fence.nativeCompletionOrdinal) || fence.nativeCompletionOrdinal < 1 ||
				!Number.isSafeInteger(fence.boundaryOrdinal) || fence.boundaryOrdinal < 1 || fence.boundaryOrdinal > 8 ||
				!Number.isSafeInteger(fence.phaseOverTriggerCount) || fence.phaseOverTriggerCount < fence.boundaryOrdinal ||
				!seatIds.includes(fence.seatId) || !seatIds.includes(fence.nextActorSeatId) || fence.seatId === fence.nextActorSeatId) fail("NATIVE_ATOMIC_CAPTURE_FENCE_INVALID");
			const proof = fence.completionEvidence;
			if (!proof || Object.getPrototypeOf(proof) !== Object.prototype || Object.keys(proof).sort().join(",") !==
				"completionOrdinal,eventInstanceId,eventName,eventStep,parentEventInstanceId,parentEventName,rootInstanceId,seatId" ||
				proof.rootInstanceId !== rootInstanceId || proof.eventName !== "phase" || proof.parentEventName !== "phaseLoop" ||
				!/^event_[1-9][0-9]{0,6}$/.test(proof.eventInstanceId || "") || !/^event_[1-9][0-9]{0,6}$/.test(proof.parentEventInstanceId || "") ||
				proof.eventInstanceId === proof.parentEventInstanceId || !Number.isSafeInteger(proof.eventStep) || proof.eventStep < 0 ||
				!Number.isSafeInteger(proof.completionOrdinal) || proof.completionOrdinal < 1 || proof.completionOrdinal > fence.nativeCompletionOrdinal ||
				proof.seatId !== fence.seatId) fail("NATIVE_ATOMIC_CAPTURE_COMPLETION_EVIDENCE_INVALID");
			const phaseOverProof = fence.phaseOverCompletionEvidence;
			const phaseOverChildValid = phaseOverProof?.childEventInstanceId === null
				? phaseOverProof.childEventName === null && phaseOverProof.childParentEventInstanceId === null && phaseOverProof.childCompletionOrdinal === null
				: Boolean(/^event_[1-9][0-9]{0,6}$/.test(phaseOverProof?.childEventInstanceId || "") &&
					phaseOverProof.childEventInstanceId !== phaseOverProof.ownerEventInstanceId &&
					phaseOverProof.childParentEventInstanceId === phaseOverProof.ownerEventInstanceId &&
					typeof phaseOverProof.childEventName === "string" && phaseOverProof.childEventName.length >= 1 && phaseOverProof.childEventName.length <= 64 &&
					Number.isSafeInteger(phaseOverProof.childCompletionOrdinal) && phaseOverProof.childCompletionOrdinal >= 1 &&
					phaseOverProof.childCompletionOrdinal > phaseOverProof.phaseCompletionOrdinal &&
					phaseOverProof.childCompletionOrdinal <= fence.nativeCompletionOrdinal);
			if (!phaseOverProof || Object.getPrototypeOf(phaseOverProof) !== Object.prototype || Object.keys(phaseOverProof).sort().join(",") !==
				"childCompletionOrdinal,childEventInstanceId,childEventName,childParentEventInstanceId,kind,ownerEventInstanceId,ownerEventName,ownerEventStep,phaseCompletionOrdinal,phaseEventInstanceId,rootInstanceId,seatId,triggerName,triggerOrdinal" ||
				phaseOverProof.kind !== "native_phase_over_dispatch_v1" || phaseOverProof.rootInstanceId !== rootInstanceId ||
				phaseOverProof.ownerEventName !== "phaseLoop" || phaseOverProof.ownerEventInstanceId !== proof.parentEventInstanceId ||
				!/^event_[1-9][0-9]{0,6}$/.test(phaseOverProof.ownerEventInstanceId || "") ||
				phaseOverProof.ownerEventStep !== 2 ||
				!/^event_[1-9][0-9]{0,6}$/.test(phaseOverProof.phaseEventInstanceId || "") ||
				!Number.isSafeInteger(phaseOverProof.phaseCompletionOrdinal) || phaseOverProof.phaseCompletionOrdinal < 1 ||
				phaseOverProof.phaseCompletionOrdinal > fence.nativeCompletionOrdinal ||
				!Number.isSafeInteger(phaseOverProof.triggerOrdinal) || phaseOverProof.triggerOrdinal !== fence.phaseOverTriggerCount ||
				phaseOverProof.triggerName !== "phaseOver" || phaseOverProof.seatId !== fence.seatId ||
				phaseOverProof.phaseEventInstanceId !== proof.eventInstanceId ||
				phaseOverProof.phaseCompletionOrdinal !== proof.completionOrdinal ||
				!phaseOverChildValid) {
				fail("NATIVE_ATOMIC_CAPTURE_PHASE_OVER_EVIDENCE_INVALID");
			}
			if (previousCompletionProof) {
				if (proof.completionOrdinal < previousCompletionProof.completionOrdinal ||
					proof.completionOrdinal === previousCompletionProof.completionOrdinal &&
					canonicalize(proof) !== canonicalize(previousCompletionProof) ||
					proof.completionOrdinal > previousCompletionProof.completionOrdinal &&
					proof.eventInstanceId === previousCompletionProof.eventInstanceId ||
					fence.boundaryOrdinal < previousFenceOrdinal || fence.boundaryOrdinal > previousFenceOrdinal + 1 ||
					fence.boundaryOrdinal === previousFenceOrdinal &&
					(canonicalize(phaseOverProof) !== canonicalize(previousPhaseOverCompletionProof) ||
						fence.phaseOverTriggerCount !== previousPhaseOverTriggerCount) ||
					fence.boundaryOrdinal === previousFenceOrdinal + 1 &&
					(fence.seatId !== previousNextActorSeatId || proof.completionOrdinal <= previousCompletionProof.completionOrdinal ||
						fence.phaseOverTriggerCount <= previousPhaseOverTriggerCount)) {
					fail("NATIVE_ATOMIC_CAPTURE_COMPLETION_SEQUENCE_INVALID");
				}
			}
			const expected = { roomId, hostSessionId: sessionId, engineBuildId, rootInstanceId, seatIds };
			const cardRows = validateNativeCardLedgerSnapshot(envelope.cardLedger, seatIds);
			const effect = validateManagedNativeEffectStateSnapshot(envelope.effectState, expected);
			const turn = validateNativeTurnResourceProjectionV2(envelope.turnResource, expected);
			if (envelope.cardLedger.rootInstanceId !== rootInstanceId || envelope.effectState.rootInstanceId !== rootInstanceId ||
				envelope.turnResource.fence.nativeCompletionOrdinal !== fence.nativeCompletionOrdinal ||
				envelope.effectState.seats.length !== seatIds.length || cardRows.length < 1 ||
				turn.canonical.nativeCompletionOrdinal !== fence.nativeCompletionOrdinal ||
				turn.canonical.turn.actorSeatId !== fence.seatId || turn.canonical.turn.phaseLoopSeatId !== fence.nextActorSeatId) {
				fail("NATIVE_ATOMIC_CAPTURE_PROJECTION_MISMATCH");
			}
			const aliveSeats = turn.canonical.seats;
			const completedPosition = seatIds.indexOf(fence.seatId);
			let expectedNextActor = null;
			for (let offset = 1; offset <= seatIds.length; offset++) {
				const candidatePosition = (completedPosition + offset) % seatIds.length;
				if (aliveSeats[candidatePosition]?.alive === true) { expectedNextActor = seatIds[candidatePosition]; break; }
			}
			if (expectedNextActor !== fence.nextActorSeatId) fail("NATIVE_ATOMIC_CAPTURE_NEXT_ACTOR_INVALID");
			const statePreimage = canonicalize({ scope, fence,
				cardLedger: envelope.cardLedger, effectState: { schema: envelope.effectState.schema, rootInstanceId: envelope.effectState.rootInstanceId,
					seatIds: envelope.effectState.seatIds, seats: envelope.effectState.seats }, turnResource: turn.canonical });
			const privatePreimage = canonicalize({ captureOrdinal: envelope.captureOrdinal, state: statePreimage });
			const digest = crypto.createHmac("sha256", derivedKey).update(privatePreimage, "utf8").digest("hex");
			const projectionDigests = Object.freeze({ cardLedger: crypto.createHash("sha256").update(canonicalize(envelope.cardLedger), "utf8").digest("hex"),
				effectState: crypto.createHash("sha256").update(effect.encoded, "utf8").digest("hex"),
				turnResource: crypto.createHash("sha256").update(turn.encoded, "utf8").digest("hex") });
			const stateDigest = crypto.createHash("sha256").update(statePreimage, "utf8").digest("hex");
			const stableWithPrevious = previousDigest === null ? null : previousDigest === stateDigest;
			const stableProjectionsWithPrevious = previousProjectionDigests === null ? null : Object.freeze(Object.fromEntries(
				Object.keys(projectionDigests).map(name => [name, previousProjectionDigests[name] === projectionDigests[name]])));
			previousDigest = stateDigest;
			previousProjectionDigests = projectionDigests;
			previousCompletionProof = Object.freeze({ ...proof });
			previousPhaseOverCompletionProof = Object.freeze({ ...phaseOverProof });
			previousFenceOrdinal = fence.boundaryOrdinal;
			previousPhaseOverTriggerCount = fence.phaseOverTriggerCount;
			previousNextActorSeatId = fence.nextActorSeatId;
			ordinal++;
			const achievementSummary = list => Object.freeze({ count: list.length,
				baoShiCount: list.filter(value => value === "baoShi").length,
				shuiJingCount: list.filter(value => value === "shuiJing").length,
				digest: crypto.createHash("sha256").update(canonicalize(list), "utf8").digest("hex") });
			return Object.freeze({ schema: "xingbei_native_private_atomic_commitment_v2", schemaVersion: 2,
				captureOrdinal: ordinal, nativeFenceOrdinal: fence.boundaryOrdinal, nativeCompletionOrdinal: fence.nativeCompletionOrdinal, rootInstanceId, engineBuildId,
				commitment: digest, stableWithPrevious, stableProjectionsWithPrevious, projectionCount: 3, atomicWithEffectSnapshots: true,
				// Bounded test-probe evidence only: no card/effect preimage is exposed.
				nativeTurnSummary: Object.freeze({ actorSeatId: turn.canonical.turn.actorSeatId, phaseLoopSeatId: turn.canonical.turn.phaseLoopSeatId,
					phase: turn.canonical.turn.phase, gamePhaseNumber: turn.canonical.turn.gamePhaseNumber,
					playerPhaseNumber: turn.canonical.turn.playerPhaseNumber, quotas: Object.freeze({ ...turn.canonical.turn.quotas }) }),
				achievementResourceSummary: Object.freeze({ hong: achievementSummary(turn.canonical.resources.hongZhanJi),
					lan: achievementSummary(turn.canonical.resources.lanZhanJi) }),
				authoritySeedAuthorized: false, checkpointAvailable: false });
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			derivedKey.fill(0);
			previousDigest = null;
			previousProjectionDigests = null;
			previousCompletionProof = null;
			previousPhaseOverCompletionProof = null;
			previousFenceOrdinal = 0;
			previousPhaseOverTriggerCount = 0;
			previousNextActorSeatId = null;
			ordinal = 0;
		},
	});
}

module.exports = { MANAGED_NATIVE_ATOMIC_CAPTURE_SCHEMA: SCHEMA, createManagedNativeAtomicCapture };
