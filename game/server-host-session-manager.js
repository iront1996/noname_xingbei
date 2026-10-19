"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { verifyManagedEngineRelease, MANAGED_ENGINE_TRUST_CONTRACT } = require("./server-managed-engine-integrity.js");
const { createManagedNativeEffectStateCommitment } = require("./server-managed-native-effect-state.js");
const { createManagedNativeAtomicCapture } = require("./server-managed-native-atomic-capture.js");
const { createManagedNativePreActionCapture } = require("./server-managed-native-preaction-capture.js");
const { createManagedSuccessorPreActionCapture } = require("./server-managed-successor-preaction-capture.js");
const { createManagedV3SeatStateProjection } = require("./server-managed-v3-seat-state-projection.js");
const { validateExperimentalEvent5 } = require("./server-managed-authority-event5.js");

const PROTOCOL = 1;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^hs_[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_STATES = new Set(["starting", "browser_ready", "engine_ready", "game_ready", "playable_probe", "stopping"]);

function failure(code) {
	return Object.freeze({ ok: false, code });
}

function safeEqualHex(left, right) {
	if (typeof left !== "string" || typeof right !== "string" ||
		!SECRET.test(left) || !SECRET.test(right)) return false;
	const a = Buffer.from(left, "hex");
	const b = Buffer.from(right, "hex");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("HOST_GAME_SETUP_INVALID");
}

function validateNativeEventLineage(path, childParentId, ancestorEventId) {
	const validId = value => /^event_[1-9][0-9]{0,6}$/.test(value || "");
	if (!validId(childParentId) || !validId(ancestorEventId) || !Array.isArray(path) || path.length > 24) return false;
	if (path.length === 0) return childParentId === ancestorEventId;
	const ids = new Set();
	for (let index = 0; index < path.length; index++) {
		const node = path[index];
		if (!node || Object.getPrototypeOf(node) !== Object.prototype ||
			Object.keys(node).sort().join(",") !== "eventInstanceId,eventName,parentEventInstanceId" ||
			!validId(node.eventInstanceId) || !validId(node.parentEventInstanceId) ||
			typeof node.eventName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(node.eventName) ||
			ids.has(node.eventInstanceId) || node.eventInstanceId === ancestorEventId ||
			(index === 0 ? node.eventInstanceId !== childParentId : path[index - 1].parentEventInstanceId !== node.eventInstanceId)) return false;
		ids.add(node.eventInstanceId);
	}
	return path.at(-1).parentEventInstanceId === ancestorEventId;
}

function prepareGameSetup(value) {
	if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.mode !== "xingBei" ||
		!Array.isArray(value.seats) || value.seats.length < 2 || value.seats.length > 8 ||
		!value.config || Object.getPrototypeOf(value.config) !== Object.prototype ||
		Object.keys(value.config).some(key => key !== "playerCount") ||
		![4, 6, 8].includes(value.config.playerCount) || value.config.playerCount !== value.seats.length) {
		throw new TypeError("HOST_GAME_SETUP_INVALID");
	}
	const seats = value.seats.map((seat, position) => {
		if (!seat || Object.getPrototypeOf(seat) !== Object.prototype || !SEAT_ID.test(seat.seatId) ||
			seat.position !== position || Object.keys(seat).some(key => !["seatId", "position"].includes(key))) {
			throw new TypeError("HOST_GAME_SETUP_INVALID");
		}
		return Object.freeze({ seatId: seat.seatId, position });
	});
	if (new Set(seats.map(seat => seat.seatId)).size !== seats.length) throw new TypeError("HOST_GAME_SETUP_INVALID");
	const setup = JSON.parse(canonicalize({ mode: value.mode, config: value.config, seats }));
	const encoded = canonicalize(setup);
	if (Buffer.byteLength(encoded, "utf8") > 65536) throw new TypeError("HOST_GAME_SETUP_INVALID");
	return Object.freeze({
		setup: Object.freeze(setup),
		digest: crypto.createHash("sha256").update(encoded).digest("hex"),
		seatIds: Object.freeze(seats.map(seat => seat.seatId)),
	});
}

function createHostSessionManager({
	launch,
	engineSourceRoot = path.resolve(__dirname, ".."),
	engineReleaseLockPath,
	randomBytes = crypto.randomBytes,
	browserReadyTimeoutMs = 15000,
	engineReadyTimeoutMs = 15000,
	gameReadyTimeoutMs = 15000,
	onAuthoritativeResult = () => {},
	onManagedChoiceMessage = () => {},
	isManagedChoicePending = () => false,
	hasPendingManagedChoices = () => false,
	getCurrentSeatBinding = () => null,
	authorizeSeatStateRequest = () => null,
	onSessionEnd = () => {},
	experimentalAuthorityEventLimit = 4,
} = {}) {
	if (typeof launch !== "function" || typeof engineSourceRoot !== "string" || !path.isAbsolute(engineSourceRoot) ||
		(engineReleaseLockPath !== undefined && (typeof engineReleaseLockPath !== "string" || !path.isAbsolute(engineReleaseLockPath))) || typeof randomBytes !== "function" ||
		!Number.isSafeInteger(browserReadyTimeoutMs) || browserReadyTimeoutMs < 100 || browserReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(engineReadyTimeoutMs) || engineReadyTimeoutMs < 100 || engineReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(gameReadyTimeoutMs) || gameReadyTimeoutMs < 100 || gameReadyTimeoutMs > 60000 ||
		typeof onAuthoritativeResult !== "function" || typeof onManagedChoiceMessage !== "function" ||
		typeof isManagedChoicePending !== "function" || typeof hasPendingManagedChoices !== "function" ||
		typeof getCurrentSeatBinding !== "function" || typeof authorizeSeatStateRequest !== "function" || typeof onSessionEnd !== "function" ||
		![4, 5].includes(experimentalAuthorityEventLimit) || (experimentalAuthorityEventLimit === 5 &&
			(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "5" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1"))) {
		throw new TypeError("HOST_SESSION_CONFIG_INVALID");
	}

	const sessions = new Map();
	const sessionEndListeners = new Set();
	const sessionLifecycleListeners = new Set();
	const releaseLockPath = engineReleaseLockPath || path.resolve(engineSourceRoot, "managed-engine-release.json");

	function publicView(record) {
		if (!record) return null;
		return Object.freeze({
			protocol: PROTOCOL,
			trustContract: MANAGED_ENGINE_TRUST_CONTRACT,
			roomId: record.roomId,
			sessionId: record.sessionId,
			state: record.state,
			pid: record.pid,
			nextResultSequence: record.nextResultSequence,
			failureCode: record.failureCode,
			setupDigest: record.setupDigest,
			engineBuildId: record.engineBuildId,
			preGameSummaryDigest: record.preGameSummaryDigest,
			authorityStateRevision: record.authorityStateRevision,
			authorityStateDigest: record.authorityStateDigest,
			nextAuthorityEventSequence: record.nextAuthorityEventSequence,
			seedAuthorized: false,
			checkpointAvailable: false,
			lastAuthorityEvent: record.lastAuthorityEvent,
			authorityFailureReason: record.authorityFailureReason,
			authorityDigestChain: Object.freeze(record.authorityDigestChain.slice()),
		});
	}

	function clearPhaseTimer(record) {
		if (!record.phaseTimer) return;
		clearTimeout(record.phaseTimer);
		record.phaseTimer = null;
	}

	function armPhaseTimer(record, expectedState, timeoutMs, failureCode, stopReason) {
		clearPhaseTimer(record);
		record.phaseTimer = setTimeout(() => {
			if (record.state !== expectedState) return;
			fail(record, failureCode);
			Promise.resolve(record.handle?.stop(stopReason)).catch(() => {});
		}, timeoutMs);
		if (record.phaseTimer.unref) record.phaseTimer.unref();
	}

	function cancelPrivateCardLedgerRequests(record) {
		for (const [requestId, pending] of record.privateCardLedgerRequests) {
			clearTimeout(pending.timer);
			pending.resolve(failure("NATIVE_CARD_LEDGER_SESSION_ENDED"));
			record.privateCardLedgerRequests.delete(requestId);
		}
	}

	function cancelPrivateNativeEffectRequests(record) {
		for (const [requestId, pending] of record.privateNativeEffectRequests) {
			clearTimeout(pending.timer);
			pending.resolve(failure("NATIVE_EFFECT_STATE_SESSION_ENDED"));
			record.privateNativeEffectRequests.delete(requestId);
		}
	}

	function cancelPrivateAtomicCaptureRequests(record) {
		for (const [requestId, pending] of record.privateAtomicCaptureRequests) {
			clearTimeout(pending.timer);
			pending.resolve(failure("NATIVE_ATOMIC_CAPTURE_SESSION_ENDED"));
			record.privateAtomicCaptureRequests.delete(requestId);
		}
	}

	function destroyPrivateAtomicCapture(record) {
		cancelPrivateAtomicCaptureRequests(record);
		try { record.privateAtomicCapture?.destroy(); } catch (_) {}
		record.privateAtomicCapture = null;
		record.privateAtomicCaptureCount = 0;
		record.privateAtomicCaptureFenceProofs?.clear();
	}

	function destroyPrivatePreActionCapture(record) {
		for (const [requestId, pending] of record.privatePreActionCaptureRequests || []) {
			clearTimeout(pending.timer);
			pending.resolve(failure("NATIVE_PREACTION_CAPTURE_SESSION_ENDED"));
			record.privatePreActionCaptureRequests.delete(requestId);
		}
		try { record.privatePreActionCapture?.destroy(); } catch (_) {}
		record.privatePreActionCapture = null;
		record.privatePreActionCaptureCandidate = null;
		record.privatePreActionCaptureRequestCount = 0;
		for (const [requestId, pending] of record.successorPreActionCaptureRequests || []) {
			clearTimeout(pending.timer);
			pending.resolve(failure("SUCCESSOR_PREACTION_SESSION_ENDED"));
			record.successorPreActionCaptureRequests.delete(requestId);
		}
		try { record.successorPreActionCapture?.destroy(); } catch (_) {}
		record.successorPreActionCapture = null;
		record.successorPreActionCaptureRequestCount = 0;
		record.successorPreActionCaptureResult = null;
		record.successorPreActionCaptureEnvelope = null;
		record.v3SeatStateProjection?.destroy();
		record.v3SeatStateProjection = null;
		record.v3SeatStateSequences?.clear();
		record.v3SeatStateGenerations?.clear();
		record.nativeNextSeatCandidate = null;
	}

	function destroyPrivateNativeEffectState(record) {
		cancelPrivateNativeEffectRequests(record);
		try { record.privateNativeEffectState?.destroy(); } catch (_) {}
		record.privateNativeEffectState = null;
		record.privateNativeEffectKey?.fill(0);
		record.privateNativeEffectKey = null;
		record.privateNativeEffectLast = null;
		record.privateNativeEffectEvent = null;
		record.privateNativeEffectCandidate = null;
		record.privateNativeEffectRequestCount = 0;
		record.privateNativeEffectSnapshotCount = 0;
	}

	function finish(record, code) {
		clearPhaseTimer(record);
		cancelPrivateCardLedgerRequests(record);
		destroyPrivateNativeEffectState(record);
		destroyPrivateAtomicCapture(record);
		destroyPrivatePreActionCapture(record);
		let ended = false;
		if (record.state === "stopping") {
			record.state = "stopped";
			record.failureCode = null;
			ended = true;
		} else if (["starting", "browser_ready", "engine_ready", "game_ready", "playable_probe"].includes(record.state)) {
			record.state = "failed";
			record.failureCode = code || "HOST_EXITED";
			ended = true;
		}
		if (ended) notifySessionEnd(record);
	}

	function notifySessionEnd(record) {
		if (record.endNotified) return;
		record.endNotified = true;
		const event = Object.freeze({ roomId: record.roomId, sessionId: record.sessionId, state: record.state, code: record.failureCode });
		try { onSessionEnd(event); } catch (_) {}
		for (const listener of sessionEndListeners) { try { listener(event); } catch (_) {} }
		notifySessionLifecycle(Object.freeze({ ...event, stage: "ended" }));
	}

	function notifySessionLifecycle(event) {
		for (const listener of sessionLifecycleListeners) { try { listener(event); } catch (_) {} }
	}

	function subscribeSessionEnd(listener) {
		if (typeof listener !== "function") throw new TypeError("HOST_SESSION_LISTENER_INVALID");
		sessionEndListeners.add(listener);
		return () => sessionEndListeners.delete(listener);
	}

	function subscribeLifecycle(listener) {
		if (typeof listener !== "function") throw new TypeError("HOST_SESSION_LISTENER_INVALID");
		sessionLifecycleListeners.add(listener);
		return () => sessionLifecycleListeners.delete(listener);
	}

	function fail(record, code) {
		if (!record || !ACTIVE_STATES.has(record.state)) return;
		clearPhaseTimer(record);
		cancelPrivateCardLedgerRequests(record);
		destroyPrivateNativeEffectState(record);
		destroyPrivateAtomicCapture(record);
		destroyPrivatePreActionCapture(record);
		record.state = "failed";
		record.failureCode = code;
		notifySessionEnd(record);
	}

	function authenticate(record, message) {
		return Boolean(record && message &&
			message.kind === "managed_host" &&
			message.protocol === PROTOCOL &&
			message.roomId === record.roomId &&
			message.sessionId === record.sessionId &&
			safeEqualHex(message.secret, record.secret));
	}

	function validPrivateCardLedgerSummary(record, message) {
		const snapshot = message.snapshot;
		const zones = "discard,draw,equipment,expansion,hand,judgment,ordering,player_special,special";
		if (!snapshot || Object.getPrototypeOf(snapshot) !== Object.prototype ||
			Object.keys(snapshot).sort().join(",") !== "changedPhysicalCardCount,checkpointAvailable,commitment,engineBuildId,movedZonePhysicalCardCount,physicalCardCount,rootInstanceId,schema,schemaVersion,snapshotOrdinal,totalCountConserved,virtualCardsIncluded,zoneCounts,zoneDelta" ||
			snapshot.schema !== "xingbei_native_private_card_commitment_v1" || snapshot.schemaVersion !== 1 ||
			snapshot.snapshotOrdinal !== record.privateCardLedgerSnapshotCount + 1 || snapshot.engineBuildId !== record.engineBuildId ||
			snapshot.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId || !DIGEST.test(snapshot.commitment || "") ||
			!Number.isSafeInteger(snapshot.physicalCardCount) || snapshot.physicalCardCount < 1 || snapshot.physicalCardCount > 4096 ||
			!Number.isSafeInteger(snapshot.changedPhysicalCardCount) || snapshot.changedPhysicalCardCount < 0 ||
			!Number.isSafeInteger(snapshot.movedZonePhysicalCardCount) || snapshot.movedZonePhysicalCardCount < 0 || snapshot.movedZonePhysicalCardCount > snapshot.changedPhysicalCardCount ||
			snapshot.virtualCardsIncluded !== false || snapshot.checkpointAvailable !== false ||
			!snapshot.zoneCounts || Object.getPrototypeOf(snapshot.zoneCounts) !== Object.prototype || Object.keys(snapshot.zoneCounts).sort().join(",") !== zones ||
			Object.values(snapshot.zoneCounts).some(value => !Number.isSafeInteger(value) || value < 0) ||
			Object.values(snapshot.zoneCounts).reduce((sum, value) => sum + value, 0) !== snapshot.physicalCardCount) return false;
		if (snapshot.snapshotOrdinal === 1) return snapshot.changedPhysicalCardCount === 0 && snapshot.movedZonePhysicalCardCount === 0 && snapshot.zoneDelta === null && snapshot.totalCountConserved === null;
		if (snapshot.snapshotOrdinal !== 2 || snapshot.changedPhysicalCardCount === 0 || snapshot.totalCountConserved !== true ||
			!record.privateCardLedgerPriorZoneCounts || snapshot.physicalCardCount !== record.privateCardLedgerPriorPhysicalCount ||
			snapshot.commitment === record.privateCardLedgerPriorCommitment || !snapshot.zoneDelta ||
			Object.getPrototypeOf(snapshot.zoneDelta) !== Object.prototype || Object.keys(snapshot.zoneDelta).sort().join(",") !== zones) return false;
		const orderedZones = Object.keys(snapshot.zoneCounts).sort();
		if (orderedZones.some(zone => !Number.isSafeInteger(snapshot.zoneDelta[zone]) ||
			snapshot.zoneDelta[zone] !== snapshot.zoneCounts[zone] - record.privateCardLedgerPriorZoneCounts[zone])) return false;
		return Object.values(snapshot.zoneDelta).reduce((sum, value) => sum + value, 0) === 0;
	}

	function validatePrivateNativeEffectMessage(record, message, pending) {
		const keys = "captureBoundary,kind,mode,nativeCompletionOrdinal,nativeEventId,protocol,requestId,roomId,schema,seatId,secret,sessionId,snapshot,type";
		if (!pending || !message || Object.getPrototypeOf(message) !== Object.prototype ||
			Object.keys(message).sort().join(",") !== keys || message.type !== "host_private_native_effect_state" ||
			message.schema !== "xingbei_native_private_effect_state_v1" || message.requestId !== pending.requestId ||
			message.mode !== pending.mode || message.nativeEventId !== record.privateNativeEffectEvent?.nativeEventId ||
			message.seatId !== record.privateNativeEffectEvent?.seatId ||
			message.captureBoundary !== pending.captureBoundary ||
			message.nativeCompletionOrdinal !== pending.nativeCompletionOrdinal ||
			message.snapshot?.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId) return false;
		if (pending.mode === "before_native_response") {
			return pending.captureBoundary === "native_response_waiting" && pending.nativeCompletionOrdinal === null;
		}
		return pending.captureBoundary === "native_response_completed" && Number.isSafeInteger(pending.nativeCompletionOrdinal) &&
			pending.nativeCompletionOrdinal > 0 && Number.isSafeInteger(record.privateNativeEffectEvent?.nativeCompletionOrdinal) &&
			record.privateNativeEffectEvent.nativeCompletionOrdinal === pending.nativeCompletionOrdinal;
	}

	function validPrivateNativeEffectCommitment(record, message, commitment, pending) {
		return commitment && Object.getPrototypeOf(commitment) === Object.prototype &&
			Object.keys(commitment).sort().join(",") === "checkpointAvailable,commitment,engineBuildId,rootInstanceId,schema,schemaVersion,snapshotOrdinal,stableWithPrevious" &&
			commitment.schema === "xingbei_native_private_effect_commitment_v1" && commitment.schemaVersion === 1 &&
			commitment.snapshotOrdinal === record.privateNativeEffectSnapshotCount + 1 &&
			commitment.engineBuildId === record.engineBuildId &&
			commitment.rootInstanceId === record.xingbeiAuthorityContext?.rootInstanceId && DIGEST.test(commitment.commitment || "") &&
			commitment.checkpointAvailable === false &&
			(commitment.snapshotOrdinal === 1 ? commitment.stableWithPrevious === null : typeof commitment.stableWithPrevious === "boolean") &&
			((pending.mode === "before_native_response" && commitment.snapshotOrdinal === 1) ||
			 (pending.mode === "after_native_response" && commitment.snapshotOrdinal === 2 && commitment.stableWithPrevious === false) ||
			 (pending.mode === "repeat_native_response" && commitment.snapshotOrdinal === 3 && commitment.stableWithPrevious === true));
	}

	async function start(roomId, gameSetup) {
		if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) {
			return failure("HOST_ROOM_ID_INVALID");
		}
		const existing = sessions.get(roomId);
		if (existing && ACTIVE_STATES.has(existing.state)) {
			return failure("HOST_SESSION_EXISTS");
		}
		let prepared;
		let sourceManifest;
		try {
			prepared = prepareGameSetup(gameSetup);
		} catch (_) {
			return failure("HOST_GAME_SETUP_INVALID");
		}
		try {
			const release = verifyManagedEngineRelease(engineSourceRoot, releaseLockPath);
			if (!release.ok) return failure(`HOST_${release.code}`);
			sourceManifest = release.manifest;
		} catch (_) {
			return failure("HOST_ENGINE_SOURCE_UNAVAILABLE");
		}

		const sessionId = `hs_${randomBytes(16).toString("hex")}`;
		const secret = randomBytes(32).toString("hex");
		if (!SESSION_ID.test(sessionId) || !SECRET.test(secret)) {
			return failure("HOST_RANDOM_SOURCE_INVALID");
		}
		const record = {
			roomId,
			sessionId,
			secret,
			state: "starting",
			pid: null,
			handle: null,
			phaseTimer: null,
			privateCardLedgerRequests: new Map(),
			privateCardLedgerSnapshotCount: 0,
			privateCardLedgerRequestCount: 0,
			privateCardLedgerPriorCommitment: null,
			privateCardLedgerPriorPhysicalCount: null,
			privateCardLedgerPriorZoneCounts: null,
			privateNativeEffectRequests: new Map(),
			privateNativeEffectRequestCount: 0,
			privateNativeEffectSnapshotCount: 0,
			privateNativeEffectKey: null,
			privateNativeEffectState: null,
			privateNativeEffectEvent: null,
			privateNativeEffectCandidate: null,
			privateNativeEffectLast: null,
			privateAtomicCaptureRequests: new Map(),
			privateAtomicCaptureRequestCount: 0,
			privateAtomicCaptureCount: 0,
			privateAtomicCapture: null,
			privateAtomicCaptureFenceProofs: new Map(),
			privatePreActionCaptureRequests: new Map(),
			privatePreActionCaptureRequestCount: 0,
			privatePreActionCapture: null,
			privatePreActionCaptureCandidate: null,
			successorPreActionCaptureRequests: new Map(),
			successorPreActionCaptureRequestCount: 0,
			successorPreActionCapture: null,
			successorPreActionCaptureResult: null,
			successorPreActionCaptureEnvelope: null,
			v3SeatStateProjection: null,
			v3SeatStateSequences: new Map(),
			v3SeatStateGenerations: new Map(),
				nativeNextSeatCandidate: null,
				nativeEvent5Candidate: null,
				experimentalEvent5PostCapture: null,
				experimentalEvent5PostCaptureStarted: false,
				experimentalEvent5CaptureProgress: null,
				experimentalEvent5Delivery: null,
			nextResultSequence: 1,
			failureCode: null,
			gameSetup: prepared.setup,
			setupDigest: prepared.digest,
			engineBuildId: sourceManifest.buildId,
			engineSourceFileCount: sourceManifest.fileCount,
			engineSourceTotalBytes: sourceManifest.totalBytes,
			seatIds: prepared.seatIds,
			preGameSummaryDigest: null,
			authorityStateRevision: null,
			authorityStateDigest: null,
			nextAuthorityEventSequence: 1,
			lastAuthorityEvent: null,
			xingbeiAuthorityContext: null,
			acceptedNativeCardActionProofDigest: null,
			acceptedNativeCardActionNativeEventId: null,
			acceptedNativeCardActionRootInstanceId: null,
			acceptedNativeCardActionSeatId: null,
			acceptedNativeActionProofDigest: null,
			acceptedNativeActionKind: null,
			acceptedNativeActionName: null,
			acceptedNativeActionNativeEventId: null,
			acceptedNativeActionRootInstanceId: null,
			acceptedNativeActionSeatId: null,
			nativeJiRiActionCandidate: null,
			nativeJiRiTargetCandidate: null,
			nativeJiRiActionDelivery: null,
			nativeJiRiTargetDelivery: null,
			nativePhaseBoundaryReleaseSent: false,
			experimentalAuthorityEventLimit,
			experimentalEvent5AcceptedProofDigest: null,
			authorityStateSummary: null,
			authorityDigestChain: [],
			endNotified: false,
		};
		sessions.set(roomId, record);

		try {
			const handle = await launch(Object.freeze({
				kind: "host_session_bootstrap",
				protocol: PROTOCOL,
				trustContract: MANAGED_ENGINE_TRUST_CONTRACT,
				authorityEventLimit: record.experimentalAuthorityEventLimit,
				roomId,
				sessionId,
				secret,
				gameSetup: record.gameSetup,
				setupDigest: record.setupDigest,
				engineSourceManifest: sourceManifest,
			}));
			if (!handle || !Number.isSafeInteger(handle.pid) || handle.pid <= 0 ||
				typeof handle.once !== "function" || typeof handle.on !== "function" ||
				typeof handle.stop !== "function") {
				throw new Error("HOST_HANDLE_INVALID");
			}
			record.handle = handle;
			record.pid = handle.pid;
			handle.once("exit", () => finish(record, "HOST_EXITED"));
			handle.on("message", message => {
				if (message?.type === "host_browser_ready") markBrowserReady(message);
				else if (message?.type === "host_engine_ready") markEngineReady(message);
				else if (message?.type === "host_game_ready") markGameReady(message);
				else if (message?.type === "host_authority_event") {
					const committed = commitAuthorityEvent(message);
					if (["xingbei_side_assignment_v1", "xingbei_character_selection_v1", "xingbei_opening_draw_v1", "xingbei_native_card_action_v1", "xingbei_native_skill_action_v1", "xingbei_native_successor_card_action_v1"].includes(message.proof?.event?.kind)) {
						if (!committed.ok) {
							fail(record, committed.code);
							Promise.resolve(record.handle?.stop("authority_event_rejected")).catch(() => {});
						} else {
							const eventAck = { kind: "managed_host", type: "host_authority_event_ack", accepted: true, protocol: PROTOCOL,
								roomId: record.roomId, sessionId: record.sessionId, secret: record.secret,
								eventSequence: message.proof.eventSequence, stateRevision: committed.session.authorityStateRevision,
								afterDigest: message.proof.afterDigest };
							Promise.resolve(record.handle?.sendHostCommand?.(eventAck)).catch(() => {
								if (record.state !== "failed") fail(record, "HOST_AUTHORITY_ACK_DELIVERY_FAILED");
								Promise.resolve(record.handle?.stop("authority_ack_delivery_failed")).catch(() => {});
							});
						}
				}
				}
				else if (message?.type === "host_failure" && authenticate(record, message)) {
					fail(record, typeof message.code === "string" && /^[A-Z0-9_]{3,96}$/.test(message.code) ? message.code : "HOST_MANAGED_EXECUTION_FAILED");
				}
				else if (message?.type === "host_private_card_ledger_commitment" && authenticate(record, message)) {
					const pending = record.privateCardLedgerRequests.get(message.requestId);
					if (pending && message.mode === pending.mode && validPrivateCardLedgerSummary(record, message)) {
						record.privateCardLedgerRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						record.privateCardLedgerSnapshotCount++;
						record.privateCardLedgerPriorCommitment = message.snapshot.commitment;
						record.privateCardLedgerPriorPhysicalCount = message.snapshot.physicalCardCount;
						record.privateCardLedgerPriorZoneCounts = Object.freeze({ ...message.snapshot.zoneCounts });
						pending.resolve(Object.freeze({ ok: true, snapshot: Object.freeze({ ...message.snapshot,
							zoneCounts: Object.freeze({ ...message.snapshot.zoneCounts }),
							zoneDelta: message.snapshot.zoneDelta ? Object.freeze({ ...message.snapshot.zoneDelta }) : null }) }));
					}
				}
				else if (message?.type === "host_private_card_ledger_failed" && authenticate(record, message)) {
					const pending = record.privateCardLedgerRequests.get(message.requestId);
					if (pending && pending.mode === message.mode && /^[A-Z0-9_]{3,96}$/.test(message.code || "")) {
						record.privateCardLedgerRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure(message.code));
					}
				}
				else if (message?.type === "host_private_native_effect_state" && authenticate(record, message)) {
					const pending = record.privateNativeEffectRequests.get(message.requestId);
					if (!pending) return;
					if (record.state !== "playable_probe" || !record.privateNativeEffectState) {
						record.privateNativeEffectRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_EFFECT_STATE_SESSION_ENDED"));
						return;
					}
					if (!validatePrivateNativeEffectMessage(record, message, pending)) {
						record.privateNativeEffectRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_EFFECT_STATE_BOUNDARY_REJECTED"));
						fail(record, "NATIVE_EFFECT_STATE_BOUNDARY_REJECTED");
						Promise.resolve(record.handle?.stop("native_effect_state_boundary_rejected")).catch(() => {});
						return;
					}
					try {
						const commitment = record.privateNativeEffectState.commit(message.snapshot);
						if (!validPrivateNativeEffectCommitment(record, message, commitment, pending)) throw new TypeError("NATIVE_EFFECT_STATE_COMMITMENT_REJECTED");
						record.privateNativeEffectRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						record.privateNativeEffectSnapshotCount++;
						record.privateNativeEffectLast = commitment.commitment;
						const accepted = Object.freeze({ ok: true, snapshot: Object.freeze({ ...commitment,
							mode: pending.mode, captureBoundary: pending.captureBoundary,
							nativeEventId: record.privateNativeEffectEvent.nativeEventId,
							nativeCompletionOrdinal: pending.nativeCompletionOrdinal }) });
						// IPC validation and commitment happen synchronously in this handler,
						// but the caller observes the Promise on a later microtask. Re-check
						// the exact session state at that delivery boundary so a concurrent
						// stop cannot leak an apparently usable post-stop snapshot.
						queueMicrotask(() => pending.resolve(record.state === "playable_probe" && record.privateNativeEffectState
							? accepted : failure("NATIVE_EFFECT_STATE_SESSION_ENDED")));
					} catch (_) {
						record.privateNativeEffectRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_EFFECT_STATE_SNAPSHOT_REJECTED"));
						fail(record, "NATIVE_EFFECT_STATE_SNAPSHOT_REJECTED");
						Promise.resolve(record.handle?.stop("native_effect_state_rejected")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_native_effect_state_failed" && authenticate(record, message)) {
					const pending = record.privateNativeEffectRequests.get(message.requestId);
					if (pending && message.mode === pending.mode && /^[A-Z0-9_]{3,96}$/.test(message.code || "")) {
						record.privateNativeEffectRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure(message.code));
						fail(record, message.code);
						Promise.resolve(record.handle?.stop("native_effect_state_capture_failed")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_atomic_capture" && authenticate(record, message)) {
					const pending = record.privateAtomicCaptureRequests.get(message.requestId);
					const keys = "captureOrdinal,envelope,kind,protocol,requestId,roomId,secret,sessionId,type";
					if (!pending) return;
					const envelopeFence = message.envelope?.fence;
					const envelopeProof = envelopeFence?.completionEvidence;
					const expectedBoundary = pending.boundaryOrdinal;
					const firstFence = record.privateAtomicCaptureFenceProofs.get(1);
					const acceptedFence = record.privateAtomicCaptureFenceProofs.get(expectedBoundary);
					const proofMatches = (left, right) => {
						try { return Boolean(left && right && canonicalize(left) === canonicalize(right)); }
						catch (_) { return false; }
					};
					const boundaryAllowed = expectedBoundary === 1
						? !record.nativePhaseBoundaryReleaseSent && envelopeFence?.boundaryOrdinal === 1 &&
							(!acceptedFence || proofMatches(acceptedFence, { completion: envelopeProof, phaseOver: envelopeFence.phaseOverCompletionEvidence,
								seatId: envelopeFence.seatId, nativeCompletionOrdinal: envelopeFence.nativeCompletionOrdinal,
								phaseOverTriggerCount: envelopeFence.phaseOverTriggerCount }))
						: process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1" && record.nativePhaseBoundaryReleaseSent &&
							record.privateAtomicCaptureCount >= 2 && envelopeFence?.boundaryOrdinal === 2 && firstFence &&
							envelopeFence.seatId !== firstFence.seatId && envelopeProof?.completionOrdinal > firstFence.completion.completionOrdinal &&
							(!acceptedFence || proofMatches(acceptedFence, { completion: envelopeProof, phaseOver: envelopeFence.phaseOverCompletionEvidence,
								seatId: envelopeFence.seatId, nativeCompletionOrdinal: envelopeFence.nativeCompletionOrdinal,
								phaseOverTriggerCount: envelopeFence.phaseOverTriggerCount }));
					if (record.state !== "playable_probe" || !boundaryAllowed ||
						Object.getPrototypeOf(message) !== Object.prototype || Object.keys(message).sort().join(",") !== keys ||
						message.type !== "host_private_atomic_capture" || message.captureOrdinal !== pending.captureOrdinal ||
						message.envelope?.captureOrdinal !== pending.captureOrdinal || envelopeFence?.boundaryOrdinal !== expectedBoundary) {
						record.privateAtomicCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_ATOMIC_CAPTURE_BOUNDARY_REJECTED"));
						fail(record, "NATIVE_ATOMIC_CAPTURE_BOUNDARY_REJECTED");
						Promise.resolve(record.handle?.stop("native_atomic_capture_boundary_rejected")).catch(() => {});
						return;
					}
					try {
						const commitment = record.privateAtomicCapture.commit(message.envelope);
						if (commitment.captureOrdinal !== pending.captureOrdinal || commitment.nativeFenceOrdinal !== expectedBoundary ||
							commitment.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
							commitment.engineBuildId !== record.engineBuildId || commitment.checkpointAvailable !== false ||
							commitment.authoritySeedAuthorized !== false) throw new TypeError("NATIVE_ATOMIC_CAPTURE_COMMITMENT_INVALID");
						if (!acceptedFence) record.privateAtomicCaptureFenceProofs.set(expectedBoundary, Object.freeze({
							completion: Object.freeze({ ...envelopeProof }), phaseOver: Object.freeze({ ...envelopeFence.phaseOverCompletionEvidence }),
							seatId: envelopeFence.seatId, nativeCompletionOrdinal: envelopeFence.nativeCompletionOrdinal,
							phaseOverTriggerCount: envelopeFence.phaseOverTriggerCount }));
						record.privateAtomicCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						record.privateAtomicCaptureCount++;
						const result = Object.freeze({ ok: true, snapshot: Object.freeze({ ...commitment }) });
						queueMicrotask(() => pending.resolve(record.state === "playable_probe" &&
							(expectedBoundary === 1 ? !record.nativePhaseBoundaryReleaseSent : record.nativePhaseBoundaryReleaseSent)
							? result : failure("NATIVE_ATOMIC_CAPTURE_SESSION_ENDED")));
					} catch (_) {
						record.privateAtomicCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_ATOMIC_CAPTURE_REJECTED"));
						fail(record, "NATIVE_ATOMIC_CAPTURE_REJECTED");
						Promise.resolve(record.handle?.stop("native_atomic_capture_rejected")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_pre_action_capture" && authenticate(record, message)) {
					const pending = record.privatePreActionCaptureRequests.get(message.requestId);
					const keys = "envelope,kind,protocol,requestId,roomId,secret,sessionId,type";
					const candidate = record.privatePreActionCaptureCandidate;
					if (!pending) return;
					if (record.state !== "playable_probe" || Object.getPrototypeOf(message) !== Object.prototype ||
						Object.keys(message).sort().join(",") !== keys || message.type !== "host_private_pre_action_capture" ||
						message.envelope?.captureOrdinal !== 1 || message.envelope?.hostSessionId !== record.sessionId ||
						message.envelope?.roomId !== record.roomId || message.envelope?.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
						message.envelope?.engineBuildId !== record.engineBuildId || message.envelope?.fence?.nativeEventId !== pending.nativeEventId ||
						message.envelope?.fence?.choiceId !== pending.choiceId || message.envelope?.fence?.seatId !== pending.seatId ||
						!candidate || candidate.nativeEventId !== pending.nativeEventId || candidate.seatId !== pending.seatId ||
						candidate.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId) {
						record.privatePreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_PREACTION_CAPTURE_BOUNDARY_REJECTED"));
						fail(record, "NATIVE_PREACTION_CAPTURE_BOUNDARY_REJECTED");
						Promise.resolve(record.handle?.stop("native_preaction_capture_boundary_rejected")).catch(() => {});
						return;
					}
					try {
						const result = record.privatePreActionCapture.commit(message.envelope, { nativeEventId: pending.nativeEventId,
							choiceId: pending.choiceId, seatId: pending.seatId });
						record.privatePreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						record.privatePreActionCaptureCandidate = Object.freeze({ ...candidate, choiceId: pending.choiceId,
							captureOrdinal: result.captureOrdinal, eventInstanceId: result.eventInstanceId,
							nativeCompletionOrdinal: result.nativeCompletionOrdinal, stateDigest: result.stateDigest, commitment: result.commitment,
							achievementResourceBinding: result.achievementResourceBinding });
						const accepted = Object.freeze({ ok: true, snapshot: Object.freeze({ ...result }) });
						queueMicrotask(() => pending.resolve(record.state === "playable_probe" && record.privatePreActionCapture
							? accepted : failure("NATIVE_PREACTION_CAPTURE_SESSION_ENDED")));
					} catch (_) {
						record.privatePreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("NATIVE_PREACTION_CAPTURE_REJECTED"));
						fail(record, "NATIVE_PREACTION_CAPTURE_REJECTED");
						Promise.resolve(record.handle?.stop("native_preaction_capture_rejected")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_pre_action_capture_failed" && authenticate(record, message)) {
					const pending = record.privatePreActionCaptureRequests.get(message.requestId);
					if (pending && /^[A-Z0-9_]{3,96}$/.test(message.code || "")) {
						record.privatePreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure(message.code));
						fail(record, message.code);
						Promise.resolve(record.handle?.stop("native_preaction_capture_failed")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_successor_preaction_capture" && authenticate(record, message)) {
					const pending = record.successorPreActionCaptureRequests.get(message.requestId);
					const candidate = record.nativeNextSeatCandidate;
					const keys = "envelope,kind,protocol,requestId,roomId,secret,sessionId,type";
					if (!pending) return;
					if (record.state !== "playable_probe" || record.authorityStateRevision !== 4 || record.nextAuthorityEventSequence !== 5 ||
						Object.getPrototypeOf(message) !== Object.prototype || Object.keys(message).sort().join(",") !== keys ||
						message.envelope?.captureOrdinal !== pending.captureOrdinal || message.envelope?.roomId !== record.roomId ||
						message.envelope?.hostSessionId !== record.sessionId || message.envelope?.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
						message.envelope?.engineBuildId !== record.engineBuildId || message.envelope?.fence?.nativeEventId !== pending.nativeEventId ||
						message.envelope?.fence?.eventInstanceId !== candidate?.eventInstanceId ||
						message.envelope?.fence?.nativeCompletionOrdinal !== candidate?.waitingCompletionOrdinal ||
						message.envelope?.fence?.parentChain?.[3]?.eventInstanceId !== candidate?.parentEventInstanceId ||
						message.envelope?.fence?.seatId !== pending.seatId || !candidate || candidate.nativeEventId !== pending.nativeEventId ||
						candidate.seatId !== pending.seatId || candidate.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
						!record.privatePreActionCaptureCandidate?.commitment) {
						record.successorPreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("SUCCESSOR_PREACTION_BOUNDARY_REJECTED"));
						fail(record, "SUCCESSOR_PREACTION_BOUNDARY_REJECTED");
						Promise.resolve(record.handle?.stop("successor_preaction_boundary_rejected")).catch(() => {});
						return;
					}
					try {
		const result = record.successorPreActionCapture.commit(message.envelope,
			{ nativeEventId: pending.nativeEventId, seatId: pending.seatId,
				nativeCompletionOrdinal: candidate.waitingCompletionOrdinal, eventInstanceId: candidate.eventInstanceId,
				parentEventInstanceId: candidate.parentEventInstanceId });
						record.successorPreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						record.successorPreActionCaptureResult = Object.freeze({ ...result });
						record.successorPreActionCaptureEnvelope = structuredClone(message.envelope);
						queueMicrotask(() => pending.resolve(record.state === "playable_probe" ? Object.freeze({ ok: true, snapshot: result }) :
							failure("SUCCESSOR_PREACTION_SESSION_ENDED")));
					} catch (_) {
						record.successorPreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure("SUCCESSOR_PREACTION_REJECTED"));
						fail(record, "SUCCESSOR_PREACTION_REJECTED");
						Promise.resolve(record.handle?.stop("successor_preaction_rejected")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_successor_preaction_capture_failed" && authenticate(record, message)) {
					const pending = record.successorPreActionCaptureRequests.get(message.requestId);
					if (pending && /^[A-Z0-9_]{3,96}$/.test(message.code || "")) {
						record.successorPreActionCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure(message.code));
						fail(record, message.code);
						Promise.resolve(record.handle?.stop("successor_preaction_capture_failed")).catch(() => {});
					}
				}
				else if (message?.type === "host_private_atomic_capture_failed" && authenticate(record, message)) {
					const pending = record.privateAtomicCaptureRequests.get(message.requestId);
					if (pending && message.captureOrdinal === pending.captureOrdinal && /^[A-Z0-9_]{3,96}$/.test(message.code || "")) {
						record.privateAtomicCaptureRequests.delete(message.requestId);
						clearTimeout(pending.timer);
						pending.resolve(failure(message.code));
						fail(record, message.code);
						Promise.resolve(record.handle?.stop("native_atomic_capture_failed")).catch(() => {});
					}
				}
					else if (message?.type === "authoritative_result") commitAuthoritativeResult(message);
				else if (["host_choice_candidates", "host_choice_delivery_started", "host_choice_ack", "host_choice_diagnostic", "host_native_action_candidates", "host_native_response_candidates", "host_native_skill_target_candidates", "host_native_input_candidates_diagnostic"].includes(message?.type) && authenticate(record, message)) {
						if (message.type === "host_native_action_candidates" && message.eventSequence === 5) {
							const keys = ["kind", "type", "protocol", "secret", "roomId", "sessionId", "nativeEventId", "eventSequence", "seatId", "rootInstanceId",
								"eventInstanceId", "parentEventInstanceId", "waitingCompletionOrdinal", "options", "optionKinds", "optionCardNames", "optionTargetSeatIds",
								"trusteeOption", "deadlineMs", "eventName"].sort().join(",");
							const candidateKeysValid = Object.keys(message).sort().join(",") === keys;
							const validOptions = Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64 &&
								new Set(message.options).size === message.options.length && message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
								message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
								Object.keys(message.optionKinds).sort().join(",") === [...message.options].sort().join(",") &&
								Object.values(message.optionKinds).every(kind => kind === "gongJi" || kind === "faShu") &&
								message.optionCardNames && Object.getPrototypeOf(message.optionCardNames) === Object.prototype &&
								Object.keys(message.optionCardNames).sort().join(",") === [...message.options].sort().join(",") &&
								message.options.every(option => /^[A-Za-z0-9_-]{1,128}$/.test(message.optionCardNames[option] || "")) &&
								message.optionTargetSeatIds && Object.getPrototypeOf(message.optionTargetSeatIds) === Object.prototype &&
								Object.keys(message.optionTargetSeatIds).sort().join(",") === [...message.options].sort().join(",") &&
								message.options.every(option => record.seatIds.includes(message.optionTargetSeatIds[option]) &&
									message.optionTargetSeatIds[option] !== message.seatId) && message.options.includes(message.trusteeOption);
							const context = record.xingbeiAuthorityContext;
							let binding = null;
							try { binding = getCurrentSeatBinding(record.roomId, message.seatId); } catch (_) {}
							const candidateChecks = {
								opt_in: process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "5" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
									record.experimentalAuthorityEventLimit === 5,
								predecessor: record.state === "playable_probe" && record.authorityStateRevision === 4 &&
									record.nextAuthorityEventSequence === 5 && record.lastAuthorityEvent?.sequence === 4 && record.nativePhaseBoundaryReleaseSent,
								schema: candidateKeysValid,
								event: message.eventName === "gongJiOrFaShu" && message.eventSequence === 5,
								seat: record.seatIds.includes(message.seatId) && message.seatId !== record.acceptedNativeActionSeatId &&
									/^[A-Za-z0-9_-]{1,64}$/.test(message.seatId || ""),
								root: message.rootInstanceId === context?.rootInstanceId,
								identity: /^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") &&
									/^event_[1-9][0-9]{0,6}$/.test(message.eventInstanceId || "") &&
									/^event_[1-9][0-9]{0,6}$/.test(message.parentEventInstanceId || ""),
								ordinal: Number.isSafeInteger(message.waitingCompletionOrdinal) && message.waitingCompletionOrdinal >= 1,
								options: validOptions,
								deadline: Number.isSafeInteger(message.deadlineMs) && message.deadlineMs >= 100 && message.deadlineMs <= 300000,
								binding: Boolean(binding && Object.getPrototypeOf(binding) === Object.prototype && binding.roomId === record.roomId &&
									binding.seatId === message.seatId && binding.connected === true && binding.current === true &&
									binding.credentialAuthenticated === true && binding.ordinaryPlayer === true &&
									Number.isSafeInteger(binding.connectionGeneration) && binding.connectionGeneration >= 1),
								unique: !record.nativeEvent5Candidate && !record.nativeNextSeatCandidate,
							};
							const candidateFailure = Object.keys(candidateChecks).find(key => !candidateChecks[key]);
							if (candidateFailure) {
								const expectedKeys = keys.split(",");
								const schemaDifference = !candidateKeysValid ? Object.keys(message).filter(key =>
									!expectedKeys.includes(key)).map(key => `EXTRA_${key}`).concat(expectedKeys.filter(key => !Object.hasOwn(message, key)).map(key => `MISSING_${key}`))[0] : null;
								const rejectionDetail = candidateFailure === "schema" && schemaDifference && /^[A-Za-z0-9_]{1,64}$/.test(schemaDifference)
									? `SCHEMA_${schemaDifference.toUpperCase()}` : candidateFailure.toUpperCase();
								fail(record, `NATIVE_EVENT5_CANDIDATE_REJECTED_${rejectionDetail}`);
								Promise.resolve(record.handle?.stop("native_event5_action_candidate_rejected")).catch(() => {});
								return;
							}
							const kinds = Object.freeze({ ...message.optionKinds });
							const names = Object.freeze({ ...message.optionCardNames });
							const targets = Object.freeze({ ...message.optionTargetSeatIds });
			const event5Candidate = Object.freeze({ roomId: record.roomId, hostSessionId: record.sessionId,
							rootInstanceId: context.rootInstanceId, engineBuildId: record.engineBuildId, seatIds: Object.freeze([...record.seatIds]),
							 nativeEventId: message.nativeEventId, eventSequence: 5, eventInstanceId: message.eventInstanceId,
								parentEventInstanceId: message.parentEventInstanceId, waitingCompletionOrdinal: message.waitingCompletionOrdinal,
								eventName: message.eventName, seatId: message.seatId, options: Object.freeze([...message.options]),
								optionKinds: kinds, optionCardNames: names, optionTargetSeatIds: targets,
								previousActorSeatId: record.acceptedNativeActionSeatId, connectionGeneration: binding.connectionGeneration });
							record.nativeEvent5Candidate = event5Candidate;
							record.nativeNextSeatCandidate = event5Candidate;
						}
						if (message.type === "host_native_input_candidates_diagnostic") {
						const keys = ["kind", "type", "protocol", "secret", "roomId", "sessionId", "eventName", "nativeEventId", "rootInstanceId", "seatId",
							"eventInstanceId", "parentEventInstanceId", "waitingCompletionOrdinal", "options", "optionKinds", "optionCardNames", "optionTargetSeatIds"];
						const context = record.xingbeiAuthorityContext;
						const validOptions = Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64 &&
							new Set(message.options).size === message.options.length && message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
							message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
							Object.keys(message.optionKinds).sort().join(",") === [...message.options].sort().join(",") &&
							Object.values(message.optionKinds).every(kind => kind === "gongJi" || kind === "faShu") &&
							message.optionTargetSeatIds && Object.getPrototypeOf(message.optionTargetSeatIds) === Object.prototype &&
							Object.keys(message.optionTargetSeatIds).sort().join(",") === [...message.options].sort().join(",") &&
							// Native spell candidates may legally target their own actor. This
							// read-only candidate set is broader than an accepted Event #5 action.
							message.options.every(option => record.seatIds.includes(message.optionTargetSeatIds[option])) &&
							message.optionCardNames && Object.getPrototypeOf(message.optionCardNames) === Object.prototype &&
							Object.keys(message.optionCardNames).sort().join(",") === [...message.options].sort().join(",") &&
							message.options.every(option => typeof message.optionCardNames[option] === "string" &&
								/^[A-Za-z0-9_-]{1,128}$/.test(message.optionCardNames[option]));
						const candidateSchemaValid = Object.keys(message).sort().join(",") === keys.sort().join(",");
						const candidateInstanceProofValid = /^event_[1-9][0-9]{0,6}$/.test(message.eventInstanceId || "") &&
							/^event_[1-9][0-9]{0,6}$/.test(message.parentEventInstanceId || "") &&
							Number.isSafeInteger(message.waitingCompletionOrdinal) && message.waitingCompletionOrdinal > 0;
						if (process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE !== "1" || record.state !== "playable_probe" ||
							record.authorityStateRevision !== 4 || record.lastAuthorityEvent?.sequence !== 4 ||
							!candidateSchemaValid || message.eventName !== "gongJiOrFaShu" ||
							!/^[A-Za-z0-9_-]{1,64}$/.test(message.seatId || "") || !record.seatIds.includes(message.seatId) ||
							message.seatId === context?.firstActSeatId || message.rootInstanceId !== context?.rootInstanceId ||
							!/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") || !validOptions || !candidateInstanceProofValid) {
							fail(record, !candidateSchemaValid ? "NATIVE_NEXT_SEAT_CANDIDATE_SCHEMA_REJECTED" :
								!candidateInstanceProofValid ? "NATIVE_NEXT_SEAT_INSTANCE_PROVENANCE_REJECTED" : "NATIVE_NEXT_SEAT_CANDIDATE_REJECTED");
							Promise.resolve(record.handle?.stop("native_next_seat_candidate_rejected")).catch(() => {});
							return;
						}
						}
						if (message.type === "host_choice_diagnostic" && message.observed?.stage === "native_phase_boundary_fence_waiting" &&
							record.experimentalAuthorityEventLimit === 5 && process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "5" &&
							process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1") {
							const observed = message.observed.snapshot;
							record.experimentalEvent5CaptureProgress = Object.freeze({
								stage: "phase_fence_observed",
								boundaryOrdinal: Number.isSafeInteger(observed?.boundaryOrdinal) ? observed.boundaryOrdinal : null,
								seatId: typeof observed?.seatId === "string" ? observed.seatId : null,
							nativeEventIdMatches: observed?.nativeEventId === record.nativeEvent5Candidate?.nativeEventId,
								candidatePresent: Boolean(record.nativeEvent5Candidate),
								phaseOverComplete: observed?.phaseOverTriggerComplete === true,
								rootMatches: observed?.rootObjectMatches === true,
								completionOrdinal: Number.isSafeInteger(observed?.nativeCompletionOrdinal) ? observed.nativeCompletionOrdinal : null,
							});
						}
						if (message.type === "host_choice_diagnostic" && message.observed?.stage === "native_phase_boundary_fence_waiting" &&
							message.observed.snapshot?.boundaryOrdinal === 2 && record.experimentalAuthorityEventLimit === 5 &&
							process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "5" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
							record.nativeEvent5Candidate && !record.experimentalEvent5PostCapture && !record.experimentalEvent5PostCaptureStarted) {
							record.experimentalEvent5PostCaptureStarted = true;
							record.experimentalEvent5CaptureProgress = Object.freeze({ ...record.experimentalEvent5CaptureProgress,
								stage: "atomic_capture_started", boundaryOrdinal: 2 });
							Promise.resolve().then(async () => {
								const capture = await snapshotNativeAtomicCapture(record.roomId);
								record.experimentalEvent5CaptureProgress = Object.freeze({ ...record.experimentalEvent5CaptureProgress,
									stage: capture.ok ? "atomic_capture_accepted" : "atomic_capture_rejected", captureCode: capture.code || null,
									captureOrdinal: capture.snapshot?.captureOrdinal ?? null,
									atomicCaptureCount: record.privateAtomicCaptureCount });
							if (!capture.ok || record.state !== "playable_probe" || record.authorityStateRevision !== 4) {
								fail(record, capture.code || "EVENT5_POST_CAPTURE_REJECTED");
								await record.handle?.stop("event5_post_capture_rejected");
								return;
							}
							const fence = record.privateAtomicCaptureFenceProofs.get(2);
							const candidate = record.nativeEvent5Candidate;
							if (!fence || fence.seatId !== candidate?.seatId || fence.completion?.completionOrdinal <= candidate.waitingCompletionOrdinal) {
								fail(record, "EVENT5_POST_CAPTURE_CAUSALITY_REJECTED");
								await record.handle?.stop("event5_post_capture_causality_rejected");
								return;
							}
							record.experimentalEvent5PostCapture = Object.freeze({ roomId: record.roomId, hostSessionId: record.sessionId,
								rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId, engineBuildId: record.engineBuildId,
								seatIds: Object.freeze([...record.seatIds]), nativeEventId: candidate.nativeEventId, seatId: candidate.seatId,
								nativeCompletionOrdinal: fence.completion.completionOrdinal,
								boundaryOrdinal: 2, phaseOverTriggerOrdinal: fence.phaseOver.triggerOrdinal,
								phaseOverSeatId: fence.phaseOver.seatId,
								phaseOverEventInstanceId: fence.phaseOver.phaseEventInstanceId,
								captureOrdinal: capture.snapshot.captureOrdinal, commitment: capture.snapshot.commitment });
							await record.handle.sendHostCommand({ type: "host_native_event5_post_capture_ready", kind: "managed_host", protocol: PROTOCOL,
								roomId: record.roomId, sessionId: record.sessionId, secret: record.secret,
								afterDigestBefore: record.authorityStateDigest, connectionGeneration: candidate.connectionGeneration,
								captureOrdinal: record.experimentalEvent5PostCapture.captureOrdinal,
								commitment: record.experimentalEvent5PostCapture.commitment,
								eventSequence: 5, nativeCompletionOrdinal: record.experimentalEvent5PostCapture.nativeCompletionOrdinal,
								nativeEventId: candidate.nativeEventId, phaseOverEventInstanceId: record.experimentalEvent5PostCapture.phaseOverEventInstanceId,
								phaseOverTriggerOrdinal: record.experimentalEvent5PostCapture.phaseOverTriggerOrdinal,
								rootInstanceId: candidate.rootInstanceId, seatId: candidate.seatId, stateRevision: 4 });
							}).catch(error => {
								const reference = error?.name === "ReferenceError" &&
									/^([A-Za-z_$][A-Za-z0-9_$]{0,80}) is not defined$/.exec(error.message || "");
								record.experimentalEvent5CaptureProgress = Object.freeze({ ...record.experimentalEvent5CaptureProgress,
									stage: "post_capture_command_failed",
									failureCode: /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message :
										/^[A-Z0-9_]{3,96}$/.test(error?.code || "") ? error.code :
										reference ? `REFERENCE_${reference[1]}` :
										`ERROR_${/^[A-Za-z]+$/.test(error?.name || "") ? error.name.toUpperCase() : "UNKNOWN"}` });
								if (record.state === "playable_probe") fail(record, "EVENT5_POST_CAPTURE_IPC_FAILED");
								Promise.resolve(record.handle?.stop("event5_post_capture_ipc_failed")).catch(() => {});
							});
						}
						if (message.type === "host_native_input_candidates_diagnostic") {
						if (record.nativeEvent5Candidate && message.nativeEventId === record.nativeEvent5Candidate.nativeEventId &&
							message.rootInstanceId === record.nativeEvent5Candidate.rootInstanceId &&
							message.eventInstanceId === record.nativeEvent5Candidate.eventInstanceId &&
							message.parentEventInstanceId === record.nativeEvent5Candidate.parentEventInstanceId &&
							message.seatId === record.nativeEvent5Candidate.seatId &&
							message.waitingCompletionOrdinal === record.nativeEvent5Candidate.waitingCompletionOrdinal) {
							// The authenticated action-candidate envelope already registered this
							// exact native gate. The parallel diagnostic is corroboration, not a
							// second candidate registration.
						} else {
						if (record.nativeNextSeatCandidate !== null || !record.nativePhaseBoundaryReleaseSent ||
							message.seatId === record.acceptedNativeActionSeatId) {
							fail(record, "NATIVE_NEXT_SEAT_CANDIDATE_REPLAY_REJECTED");
							Promise.resolve(record.handle?.stop("native_next_seat_candidate_replay_rejected")).catch(() => {});
							return;
						}
						record.nativeNextSeatCandidate = Object.freeze({ roomId: record.roomId, hostSessionId: record.sessionId,
							rootInstanceId: message.rootInstanceId, engineBuildId: record.engineBuildId, seatIds: Object.freeze([...record.seatIds]),
							nativeEventId: message.nativeEventId, eventInstanceId: message.eventInstanceId,
							parentEventInstanceId: message.parentEventInstanceId, waitingCompletionOrdinal: message.waitingCompletionOrdinal,
							eventName: message.eventName, seatId: message.seatId,
							options: Object.freeze([...message.options]), optionKinds: Object.freeze({ ...message.optionKinds }),
							optionCardNames: Object.freeze({ ...message.optionCardNames }),
							optionTargetSeatIds: Object.freeze({ ...message.optionTargetSeatIds }),
							previousActorSeatId: record.acceptedNativeActionSeatId });
						}
					}
						if (message.type === "host_native_action_candidates" && process.env.V2_NATIVE_START_PROBE_MODE === "managed_native_skill_candidate_probe" &&
							process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1" && process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
							const validOptions = Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64 &&
								new Set(message.options).size === message.options.length && message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
								message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
								Object.keys(message.optionKinds).sort().join(",") === [...message.options].sort().join(",") &&
								message.options.includes(message.trusteeOption) &&
								Object.values(message.optionKinds).every(kind => kind === "native_skill" || kind === "gongJi" || kind === "faShu");
							const skillOptions = message.options.filter(option => message.optionKinds[option] === "native_skill");
							if (record.state !== "playable_probe" || record.authorityStateRevision !== 3 || message.eventName !== "gongJiOrFaShu" ||
								message.eventSequence !== 4 || !/^native_[A-Za-z0-9_-]{16,96}$/.test(message.nativeEventId || "") ||
								message.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId || !record.seatIds.includes(message.seatId) ||
								!validOptions || skillOptions.length < 1 || message.skillCandidateCount !== skillOptions.length ||
								Object.keys(message.optionTargetSeatIds || {}).sort().join(",") !== [...message.options].sort().join(",") ||
								!skillOptions.every(option => message.optionTargetSeatIds[option] !== message.seatId && record.seatIds.includes(message.optionTargetSeatIds[option]) &&
									message.optionNativeTargetSpellEligible?.[option] === true)) {
								fail(record, "NATIVE_JIRIMO_ACTION_CANDIDATE_REJECTED");
								Promise.resolve(record.handle?.stop("native_jirimo_action_candidate_rejected")).catch(() => {});
								return;
							}
							record.nativeJiRiActionCandidate = Object.freeze({ nativeEventId: message.nativeEventId, seatId: message.seatId,
								rootInstanceId: message.rootInstanceId, eventSequence: message.eventSequence,
								trusteeOption: message.trusteeOption,
								skillOptions: Object.freeze(Object.fromEntries(skillOptions.map(option => [option, message.optionTargetSeatIds[option]]))),
								targetSeatIds: Object.freeze(skillOptions.map(option => message.optionTargetSeatIds[option])) });
						}
						if (message.type === "host_native_skill_target_candidates") {
							const source = record.nativeJiRiActionCandidate;
							const validOptions = Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 32 &&
								new Set(message.options).size === message.options.length && message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
								message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
								Object.keys(message.optionKinds).sort().join(",") === [...message.options].sort().join(",") &&
								Object.values(message.optionKinds).every(kind => kind === "physical_faShu_discard") &&
								message.options.includes(message.trusteeOption);
							const allowedKeys = ["kind", "type", "protocol", "secret", "roomId", "sessionId", "eventName", "eventSequence", "nativeEventId",
								"actionEventId", "seatId", "sourceSeatId", "rootInstanceId", "options", "optionKinds", "trusteeOption", "deadlineMs"];
							if (process.env.V2_NATIVE_START_PROBE_MODE !== "managed_native_skill_candidate_probe" || process.env.V2_NATIVE_JIRIMO_ACTION_PROBE !== "1" ||
								process.env.V2_NATIVE_JIRIMO_FIXTURE !== "1" ||
								Object.keys(message).some(key => !allowedKeys.includes(key)) ||
								record.state !== "playable_probe" || record.authorityStateRevision !== 3 || message.eventName !== "chooseToDiscard" ||
								message.eventSequence !== 4 || !source || message.actionEventId !== source.nativeEventId ||
								message.nativeEventId === source.nativeEventId || !/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") ||
								message.rootInstanceId !== source.rootInstanceId || message.sourceSeatId !== source.seatId ||
								!record.seatIds.includes(message.seatId) || message.seatId === source.seatId || !source.targetSeatIds.includes(message.seatId) ||
								!validOptions || !Number.isSafeInteger(message.deadlineMs) || message.deadlineMs < 100 || message.deadlineMs > 300000) {
								fail(record, "NATIVE_JIRIMO_TARGET_CANDIDATE_REJECTED");
								Promise.resolve(record.handle?.stop("native_jirimo_target_candidate_rejected")).catch(() => {});
								return;
							}
							if (record.nativeJiRiTargetCandidate) {
								fail(record, "NATIVE_JIRIMO_TARGET_CANDIDATE_DUPLICATE");
								Promise.resolve(record.handle?.stop("native_jirimo_target_candidate_duplicate")).catch(() => {});
								return;
							}
							record.nativeJiRiTargetCandidate = Object.freeze({ nativeEventId: message.nativeEventId, actionEventId: message.actionEventId,
							seatId: message.seatId, sourceSeatId: message.sourceSeatId, rootInstanceId: message.rootInstanceId,
							options: Object.freeze([...message.options]), trusteeOption: message.trusteeOption });
						}
						if (message.type === "host_native_action_candidates" && message.eventSequence === 4 &&
							process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1") {
							const validOptions = Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64 &&
								new Set(message.options).size === message.options.length && message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
								message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
								Object.keys(message.optionKinds).sort().join(",") === [...message.options].sort().join(",") &&
								Object.values(message.optionKinds).every(kind => kind === "gongJi" || kind === "faShu" ||
									(kind === "native_skill" && process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" &&
									process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1"));
							if (record.privatePreActionCaptureCandidate !== null || record.state !== "playable_probe" || record.authorityStateRevision !== 3 ||
								message.eventName !== "gongJiOrFaShu" || message.eventSequence !== 4 || !/^native_[A-Za-z0-9_-]{16,96}$/.test(message.nativeEventId || "") ||
								!record.seatIds.includes(message.seatId) || message.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
								!validOptions || !message.options.includes(message.trusteeOption) || !Number.isSafeInteger(message.deadlineMs) || message.deadlineMs < 100 || message.deadlineMs > 300000) {
								fail(record, "NATIVE_PREACTION_ACTION_CANDIDATE_REJECTED");
								Promise.resolve(record.handle?.stop("native_preaction_action_candidate_rejected")).catch(() => {});
								return;
							}
							record.privatePreActionCaptureCandidate = Object.freeze({ nativeEventId: message.nativeEventId, seatId: message.seatId,
								rootInstanceId: message.rootInstanceId, eventSequence: message.eventSequence, options: Object.freeze([...message.options]) });
						}
						if (message.type === "host_native_response_candidates" && process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1" &&
							process.env.V2_NATIVE_MANAGED_YINYANG === "1" && record.privateNativeEffectCandidate === null &&
							Array.isArray(message.options) && message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
							message.optionShapes && Object.getPrototypeOf(message.optionShapes) === Object.prototype &&
							message.options.some(option => message.optionKinds[option] === "view_as_skill" &&
								message.optionShapes[option] === "native_single_target_view_as_skill")) {
							const keys = Object.keys(message.optionKinds).sort();
							if (message.eventName !== "yingZhan" || message.eventSequence !== 4 ||
								!/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") || !record.seatIds.includes(message.seatId) ||
								message.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId || !Array.isArray(message.options) ||
								message.options.length < 1 || message.options.length > 64 || new Set(message.options).size !== message.options.length ||
								message.options.some(option => !/^native_option_[a-f0-9]{32}$/.test(option)) ||
								keys.length !== message.options.length || keys.join(",") !== [...message.options].sort().join(",") ||
								Object.keys(message.optionShapes).sort().join(",") !== keys.join(",")) {
								fail(record, "NATIVE_EFFECT_STATE_CANDIDATE_REJECTED");
								Promise.resolve(record.handle?.stop("native_effect_state_candidate_rejected")).catch(() => {});
								return;
							}
							record.privateNativeEffectCandidate = Object.freeze({ nativeEventId: message.nativeEventId, seatId: message.seatId,
								eventSequence: message.eventSequence, rootInstanceId: message.rootInstanceId });
						}
						// A trusted-host IPC consumer is part of the authority path.  Do not
						// silently lose a candidate/ACK and leave the native event paused forever.
						Promise.resolve(onManagedChoiceMessage(Object.freeze({ type: message.type, roomId: record.roomId, sessionId: record.sessionId, message }))).catch(() => {
							// A stop request is a terminal fence. Late choice ACKs may race with
							// controller cleanup; they cannot convert an intentional stop into a
							// host failure after authority and private state are already fenced.
							if (!ACTIVE_STATES.has(record.state) || record.state === "stopping") return;
							fail(record, "HOST_CHOICE_IPC_HANDLER_FAILED");
							Promise.resolve(record.handle?.stop("choice_ipc_handler_failed")).catch(() => {});
						});
					}
			});
			armPhaseTimer(record, "starting", browserReadyTimeoutMs,
				"HOST_BROWSER_READY_TIMEOUT", "browser_ready_timeout");
			if (typeof handle.start === "function") await handle.start();
			if (record.state === "failed") return failure(record.failureCode);
			return Object.freeze({ ok: true, session: publicView(record) });
		} catch (_) {
			if (record.handle) Promise.resolve(record.handle.stop("launch_failed")).catch(() => {});
			fail(record, "HOST_LAUNCH_FAILED");
			return failure("HOST_LAUNCH_FAILED");
		}
	}

	function validateXingbeiSideAssignment(record, event) {
		if (!event || event.kind !== "xingbei_side_assignment_v1" || event.name !== "initSideAndPosition" ||
			event.hostPlayerAbsent !== true || event.connectedTransports !== 0 ||
			!record.seatIds.includes(event.firstActSeatId) || !Array.isArray(event.sides) ||
			event.sides.length !== record.seatIds.length || event.sides.some((side, index) =>
			side?.seatId !== record.seatIds[index] || typeof side.side !== "boolean")) return false;
		if (event.rootInstanceId !== undefined && (!/^native_root_[A-Za-z0-9_-]{16,96}$/.test(event.rootInstanceId) ||
			event.rootEventName !== "game" || event.rootParentName !== null || event.selectionEventName !== "chooseCharacterOL" ||
			event.selectionParentName !== "game" || event.sideEventParentName !== "chooseCharacterOL")) return false;
		const red = event.sides.filter(side => side.side).length;
		const blue = event.sides.length - red;
		const firstActor = event.sides.find(side => side.seatId === event.firstActSeatId);
		return red === event.sides.length / 2 && blue === event.sides.length / 2 && firstActor?.side === true;
	}

	function validateAuthorityEvent(record, event, proof) {
		// This dispatch is intentionally event-specific: later native events add a validator
		// instead of weakening the common sequence/digest chain.
		if (event?.kind === "xingbei_side_assignment_v1" && event.name === "initSideAndPosition") {
			// Side assignment is the one pre-character-selection transition.  Accepting
			// it after the probe phase would re-run a semantic initialization event even
			// when its sequence/digest fields look fresh.
			return record.state === "game_ready" && validateXingbeiSideAssignment(record, event);
		}
		if (event?.kind === "xingbei_native_successor_card_action_v1") {
			const candidate = record.nativeNextSeatCandidate;
			let seatBinding = null;
			try { seatBinding = candidate ? getCurrentSeatBinding(record.roomId, candidate.seatId) : null; } catch (_) {}
			const result = validateExperimentalEvent5(proof, {
				roomId: record.roomId, hostSessionId: record.sessionId, engineBuildId: record.engineBuildId,
				rootInstanceId: record.xingbeiAuthorityContext?.rootInstanceId, seatIds: record.seatIds,
				predecessor: record.authorityStateSummary ? { eventSequence: 4, revision: 4,
					digest: record.authorityStateDigest, summary: record.authorityStateSummary,
					actorSeatId: record.acceptedNativeActionSeatId } : null,
				successorCandidate: candidate,
				successorCapture: record.successorPreActionCaptureResult ? { ...record.successorPreActionCaptureResult,
					roomId: record.roomId, hostSessionId: record.sessionId, rootInstanceId: record.xingbeiAuthorityContext?.rootInstanceId } : null,
				postCapture: record.experimentalEvent5PostCapture || null,
				actionDelivery: record.experimentalEvent5Delivery || null,
				seatBinding,
			}, { enabled: record.experimentalAuthorityEventLimit === 5 });
			record.authorityFailureReason = result.ok ? null : result.code;
			return result.ok;
		}
		if (event?.kind === "xingbei_character_selection_v1" && event.name === "chooseCharacterOL") {
			if (record.state !== "playable_probe" || record.lastAuthorityEvent?.name !== "initSideAndPosition" ||
				event.hostPlayerAbsent !== true || event.connectedTransports !== 0 || !Array.isArray(event.characters) ||
				event.characters.length !== record.seatIds.length || event.characters.some((entry, index) =>
				entry?.seatId !== record.seatIds[index] || typeof entry.character !== "string" ||
				entry.character.length < 1 || entry.character.length > 128)) return false;
			if (record.xingbeiAuthorityContext?.rootInstanceId && event.rootInstanceId !== record.xingbeiAuthorityContext.rootInstanceId) return false;
			if (event.rootInstanceId !== undefined && (event.rootEventName !== "game" || event.rootParentName !== null ||
				event.selectionParentName !== "game" || event.selectionEventName !== "chooseCharacterOL")) return false;
			return new Set(event.characters.map(entry => entry.character)).size === event.characters.length &&
				record.xingbeiAuthorityContext?.firstActSeatId && record.xingbeiAuthorityContext.sides?.length === record.seatIds.length;
		}
		if (event?.kind === "xingbei_opening_draw_v1" && event.name === "gameDraw") {
			const context = record.xingbeiAuthorityContext;
			if (record.state !== "playable_probe" || record.lastAuthorityEvent?.sequence !== 2 ||
				record.lastAuthorityEvent?.name !== "chooseCharacterOL" || !context?.characters || !context?.sides ||
				event.nativeEventCompleted !== true || event.gameStartTriggered !== true ||
				!Number.isSafeInteger(event.nativeEventStep) || event.gameStartCount !== 1 ||
				event.rootEventName !== "game" || event.parentEventName !== "game" ||
				event.phaseLoopCreated !== true || event.phaseLoopStartRequested !== true || event.phaseLoopParentName !== "game" || event.phaseLoopPaused !== true ||
				event.gameMeNull !== true || event.connectedTransports !== 0 || event.firstActSeatId !== context.firstActSeatId ||
				!/^native_[A-Za-z0-9_-]{16,96}$/.test(event.nativeEventId || "") ||
				!Array.isArray(event.seats) || event.seats.length !== record.seatIds.length) return false;
			if (context.rootInstanceId && event.rootInstanceId !== context.rootInstanceId) return false;
			const seatsValid = event.seats.every((seat, index) => seat && Object.keys(seat).sort().join(",") ===
				"character,handCommitment,handCount,position,seatId,side" && seat.seatId === record.seatIds[index] &&
				seat.position === index && seat.character === context.characters[index]?.character &&
				seat.side === context.sides[index]?.side && seat.handCount === 4 && DIGEST.test(seat.handCommitment || ""));
			if (!seatsValid) return false;
			const canonicalAfter = { revision: 3, firstActSeatId: event.firstActSeatId,
				seats: event.seats.map(({ seatId, position, character, side, handCount, handCommitment }) =>
					({ seatId, position, character, side, handCount, handCommitment })) };
			return crypto.createHash("sha256").update(canonicalize(canonicalAfter)).digest("hex") === proof?.afterDigest;
		}
		if (event?.kind === "xingbei_native_skill_action_v1" && event.name === "jiRi_moBaoChongJie") {
			const reject = reason => { record.authorityFailureReason = reason; return false; };
			const context = record.xingbeiAuthorityContext;
			const before = context?.openingSummary;
			const eventKeys = "achievementAfterList,achievementBeforeList,actionCompletionOrdinal,actionEventInstanceId,actionParentEventInstanceId,baoShiAfter,baoShiBefore,changeZhanJiChildCompleted,changeZhanJiCompletionOrdinal,changeZhanJiEventId,changeZhanJiLineage,changeZhanJiParentEventId,connectedTransports,gameMeNull,kind,name,nativeChildWaitCompleted,nativeCompletionOrdinal,nativeEventCompleted,nativeEventId,nativeEventInstanceMatches,nativeEventName,nativeEventStep,nativeUseSkillChildCompleted,optionId,parentFenceEventInstanceId,parentFenceParentEventInstanceId,parentFenceParentEventName,parentFenceParentNextCount,parentFenceReleaseCount,parentFenceStatus,rootInstanceId,seatId,skillId,targetChoiceNativeEventId,targetDiscardCardMoved,targetDiscardChildCompleted,targetDiscardCompletionOrdinal,targetDiscardEventId,targetDiscardLineage,targetDiscardParentEventId,targetSeatId,useResultCount,useSkillChildCompletionOrdinal,useSkillChildEventId,useSkillParentEventId";
			const actionCandidate = record.nativeJiRiActionCandidate;
			const targetCandidate = record.nativeJiRiTargetCandidate;
			const preAction = record.privatePreActionCaptureCandidate;
			const actionDelivery = record.nativeJiRiActionDelivery;
			const targetDelivery = record.nativeJiRiTargetDelivery;
			if (record.state !== "playable_probe" || record.authorityStateRevision !== 3 || record.nextAuthorityEventSequence !== 4 ||
				record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw" || !context?.openingDrawCommitted || !before ||
				!actionCandidate || !targetCandidate || !preAction || !actionDelivery || !targetDelivery)
				return reject("NATIVE_SKILL_ACTION_PHASE");
			if (!event || Object.keys(event).sort().join(",") !== eventKeys) return reject("NATIVE_SKILL_ACTION_EVENT_SCHEMA");
			if (event.nativeEventCompleted !== true || event.nativeEventName !== "gongJiOrFaShu" ||
				!/^native_event_[a-f0-9]{32}$/.test(event.nativeEventId || "") ||
				!/^native_root_[A-Za-z0-9_-]{16,96}$/.test(event.rootInstanceId || "")) return reject("NATIVE_SKILL_ACTION_EVENT_IDENTITY");
			if (![event.actionEventInstanceId, event.actionParentEventInstanceId, event.useSkillChildEventId,
				event.changeZhanJiEventId, event.targetDiscardEventId, event.useSkillParentEventId,
				event.changeZhanJiParentEventId, event.targetDiscardParentEventId].every(value => /^event_[1-9][0-9]{0,6}$/.test(value || "")))
				return reject("NATIVE_SKILL_ACTION_EVENT_INSTANCE_IDENTITY");
			if (typeof event.targetChoiceNativeEventId !== "string") return reject("NATIVE_SKILL_ACTION_TARGET_EVENT_ID_MISSING");
			if (!/^native_event_[a-f0-9]{32}$/.test(event.targetChoiceNativeEventId)) return reject("NATIVE_SKILL_ACTION_TARGET_EVENT_ID_FORMAT");
			if (!validateNativeEventLineage(event.changeZhanJiLineage, event.changeZhanJiParentEventId, event.useSkillChildEventId) ||
				!validateNativeEventLineage(event.targetDiscardLineage, event.targetDiscardParentEventId, event.useSkillChildEventId) ||
				event.parentFenceStatus !== "waiting" || event.parentFenceReleaseCount !== 0 ||
				event.parentFenceEventInstanceId !== event.actionEventInstanceId ||
				event.parentFenceParentEventInstanceId !== event.actionParentEventInstanceId ||
				event.parentFenceParentEventName !== "xingDong" || event.parentFenceParentNextCount !== 0) return reject("NATIVE_SKILL_ACTION_NATIVE_LINEAGE");
			if (context.rootInstanceId && event.rootInstanceId !== context.rootInstanceId) return reject("NATIVE_SKILL_ACTION_ROOT_IDENTITY");
			if (!record.seatIds.includes(event.seatId) || event.seatId !== before.firstActSeatId ||
				!record.seatIds.includes(event.targetSeatId) || event.targetSeatId === event.seatId ||
				event.skillId !== "jiRi_moBaoChongJie" || !/^native_option_[a-f0-9]{32}$/.test(event.optionId || "") ||
				event.useResultCount !== 1 || event.nativeUseSkillChildCompleted !== true || event.changeZhanJiChildCompleted !== true ||
				event.targetDiscardChildCompleted !== true || event.targetDiscardCardMoved !== true ||
				event.nativeChildWaitCompleted !== true || event.nativeEventInstanceMatches !== true || event.gameMeNull !== true ||
				event.connectedTransports !== 0 || !Number.isSafeInteger(event.nativeEventStep) || event.nativeEventStep < 5 ||
				![event.useSkillChildCompletionOrdinal, event.changeZhanJiCompletionOrdinal, event.targetDiscardCompletionOrdinal,
					event.actionCompletionOrdinal, event.nativeCompletionOrdinal].every(Number.isSafeInteger) ||
				!(event.actionEventInstanceId === preAction.eventInstanceId && event.nativeEventId === actionCandidate.nativeEventId &&
					event.seatId === actionCandidate.seatId && event.rootInstanceId === actionCandidate.rootInstanceId &&
					actionCandidate.eventSequence === 4 && Object.hasOwn(actionCandidate.skillOptions, event.optionId) &&
					actionCandidate.skillOptions[event.optionId] === event.targetSeatId && preAction.nativeEventId === event.nativeEventId &&
					preAction.captureOrdinal === 1 && event.actionCompletionOrdinal > preAction.nativeCompletionOrdinal &&
					preAction.choiceId === actionDelivery.choiceId &&
					actionDelivery.nativeEventId === event.nativeEventId && actionDelivery.seatId === event.seatId &&
					actionDelivery.optionId === event.optionId && actionDelivery.targetSeatId === event.targetSeatId &&
					["player", "trustee"].includes(actionDelivery.resolutionKind) &&
					targetCandidate.actionEventId === event.nativeEventId && targetCandidate.nativeEventId === event.targetChoiceNativeEventId &&
					targetCandidate.seatId === event.targetSeatId && targetCandidate.sourceSeatId === event.seatId &&
					targetCandidate.rootInstanceId === event.rootInstanceId && targetCandidate.options.includes(targetDelivery.optionId) &&
								targetDelivery.nativeEventId === targetCandidate.nativeEventId && targetDelivery.seatId === targetCandidate.seatId &&
									["player", "trustee"].includes(targetDelivery.resolutionKind) &&
									(targetDelivery.resolutionKind !== "trustee" || targetDelivery.optionId === targetCandidate.trusteeOption) &&
									(actionDelivery.resolutionKind !== "trustee" || actionDelivery.optionId === actionCandidate.trusteeOption) &&
					event.useSkillParentEventId === event.actionEventInstanceId &&
					event.actionParentEventInstanceId !== event.actionEventInstanceId &&
					validateNativeEventLineage(event.changeZhanJiLineage, event.changeZhanJiParentEventId, event.useSkillChildEventId) &&
					validateNativeEventLineage(event.targetDiscardLineage, event.targetDiscardParentEventId, event.useSkillChildEventId) &&
					event.changeZhanJiCompletionOrdinal < event.useSkillChildCompletionOrdinal &&
					event.targetDiscardCompletionOrdinal < event.useSkillChildCompletionOrdinal &&
					event.useSkillChildCompletionOrdinal < event.actionCompletionOrdinal &&
					event.targetDiscardCompletionOrdinal < event.actionCompletionOrdinal &&
					event.changeZhanJiCompletionOrdinal < event.actionCompletionOrdinal &&
					event.actionCompletionOrdinal <= event.nativeCompletionOrdinal)) return reject("NATIVE_SKILL_ACTION_COMPLETION_EVIDENCE");
			if (!proof.beforeSummary || Object.getPrototypeOf(proof.beforeSummary) !== Object.prototype) return reject("NATIVE_SKILL_ACTION_BEFORE_BINDING");
			try { if (canonicalize(proof.beforeSummary) !== canonicalize(before)) return reject("NATIVE_SKILL_ACTION_BEFORE_BINDING"); }
			catch (_) { return reject("NATIVE_SKILL_ACTION_BEFORE_BINDING"); }
			if (crypto.createHash("sha256").update(canonicalize(before)).digest("hex") !== proof.beforeDigest) return reject("NATIVE_SKILL_ACTION_BEFORE_DIGEST");
			const after = proof.afterSummary;
			if (!after || Object.keys(after).sort().join(",") !== "action,firstActSeatId,revision,seats" || after.revision !== 4 ||
				after.firstActSeatId !== before.firstActSeatId || !Array.isArray(after.seats) || after.seats.length !== record.seatIds.length ||
				!after.action || Object.keys(after.action).sort().join(",") !== "achievement,kind,materialConsumed,nativeEventId,nativeEventName,optionId,seatId,skillId,targetDiscard" ||
				after.action.kind !== "native_skill" || after.action.nativeEventId !== event.nativeEventId ||
				after.action.nativeEventName !== "gongJiOrFaShu" || after.action.seatId !== event.seatId ||
				after.action.optionId !== event.optionId || after.action.skillId !== "jiRi_moBaoChongJie" ||
				after.action.materialConsumed !== true || !after.action.achievement ||
				Object.keys(after.action.achievement).sort().join(",") !== "afterListDigest,beforeListDigest,countAfter,countBefore,kind,side" ||
					after.action.achievement.kind !== "baoShi" || typeof after.action.achievement.side !== "boolean" ||
					after.action.achievement.side !== before.seats.find(seat => seat.seatId === event.seatId)?.side ||
				!Number.isSafeInteger(after.action.achievement.countBefore) || after.action.achievement.countBefore < 0 ||
				after.action.achievement.countAfter !== after.action.achievement.countBefore + 1 ||
				!DIGEST.test(after.action.achievement.beforeListDigest || "") || !DIGEST.test(after.action.achievement.afterListDigest || "") ||
				!after.action.targetDiscard || Object.keys(after.action.targetDiscard).sort().join(",") !== "cardMovedToDiscard,eventId,seatId" ||
				after.action.targetDiscard.eventId !== event.targetDiscardEventId || after.action.targetDiscard.seatId !== event.targetSeatId ||
				after.action.targetDiscard.cardMovedToDiscard !== true) return reject("NATIVE_SKILL_ACTION_AFTER_SUMMARY");
			const allowedAchievements = new Set(["baoShi", "shuiJing"]);
			const beforeList = event.achievementBeforeList;
			const afterList = event.achievementAfterList;
			const priorAchievement = after.action.achievement.side === true ? preAction.achievementResourceBinding?.hong : preAction.achievementResourceBinding?.lan;
			const listDigest = list => crypto.createHash("sha256").update(canonicalize(list)).digest("hex");
			if (!Array.isArray(beforeList) || !Array.isArray(afterList) || beforeList.length >= 128 || afterList.length !== beforeList.length + 1 ||
				beforeList.some(value => !allowedAchievements.has(value)) || afterList.some(value => !allowedAchievements.has(value)) ||
				canonicalize(afterList) !== canonicalize([...beforeList, "baoShi"]) || !priorAchievement ||
				event.baoShiBefore !== after.action.achievement.countBefore || event.baoShiAfter !== after.action.achievement.countAfter ||
				listDigest(beforeList) !== priorAchievement.digest || listDigest(beforeList) !== after.action.achievement.beforeListDigest ||
				listDigest(afterList) !== after.action.achievement.afterListDigest ||
				beforeList.filter(value => value === "baoShi").length !== after.action.achievement.countBefore ||
				afterList.filter(value => value === "baoShi").length !== after.action.achievement.countAfter) return reject("NATIVE_SKILL_ACTION_ACHIEVEMENT_TRANSITION");
			const beforeSeats = before.seats;
			const seatsValid = after.seats.every((seat, index) => {
				const prior = beforeSeats[index];
				if (!seat || Object.keys(seat).sort().join(",") !== "character,handCommitment,handCount,position,seatId,side" ||
					seat.seatId !== record.seatIds[index] || seat.seatId !== prior.seatId || seat.position !== prior.position ||
					seat.character !== prior.character || seat.side !== prior.side || !Number.isSafeInteger(seat.handCount) ||
					seat.handCount < 0 || seat.handCount > 32 || !DIGEST.test(seat.handCommitment || "")) return false;
				const expectedConsumption = seat.seatId === event.seatId || seat.seatId === event.targetSeatId;
				return expectedConsumption ? seat.handCount === prior.handCount - 1 && seat.handCommitment !== prior.handCommitment :
					seat.handCount === prior.handCount && seat.handCommitment === prior.handCommitment;
			});
			if (!seatsValid) return reject("NATIVE_SKILL_ACTION_SEAT_TRANSITION");
			if (crypto.createHash("sha256").update(canonicalize(after)).digest("hex") !== proof.afterDigest) return reject("NATIVE_SKILL_ACTION_AFTER_DIGEST");
			return true;
		}
		if (event?.kind === "xingbei_native_card_action_v1" && event.name === "gongJiOrFaShu") {
			const reject = reason => { record.authorityFailureReason = reason; return false; };
			const context = record.xingbeiAuthorityContext;
			const before = context?.openingSummary;
			if (record.state !== "playable_probe" || record.authorityStateRevision !== 3 || record.nextAuthorityEventSequence !== 4 ||
				record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw" ||
				!context?.openingDrawCommitted || !before) return reject("CARD_ACTION_PHASE");
			if (event.nativeEventCompleted !== true || event.nativeEventName !== "gongJiOrFaShu" ||
				!/^[A-Za-z0-9_-]{1,128}$/.test(event.nativeEventId || "")) return reject("CARD_ACTION_EVENT_IDENTITY");
			if (context.rootInstanceId && event.rootInstanceId !== context.rootInstanceId) return reject("CARD_ACTION_ROOT_IDENTITY");
			if (!record.seatIds.includes(event.seatId) || event.seatId !== before.firstActSeatId) return reject("CARD_ACTION_ACTOR");
			if (typeof event.cardName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(event.cardName) ||
				!record.seatIds.includes(event.targetSeatId) ||
				typeof event.optionId !== "string" || !/^native_option_[a-f0-9]{32}$/.test(event.optionId)) return reject("CARD_ACTION_SELECTION");
			if (!Number.isSafeInteger(event.nativeEventStep) || event.nativeEventStep < 5) return reject("CARD_ACTION_NATIVE_STEP");
			if (event.useResultCount !== 1) return reject("CARD_ACTION_USE_RESULT_COUNT");
			if (event.useCardChildName !== "useCard" || !Number.isSafeInteger(event.useCardChildStep)) return reject("CARD_ACTION_CHILD_IDENTITY");
			if (event.nativeUseCardChildCompleted !== true) return reject("CARD_ACTION_CHILD_INCOMPLETE");
			if (!["d", "x"].includes(event.usedCardPosition)) return reject("CARD_ACTION_CARD_POSITION");
			if (event.nativeChildWaitCompleted !== true) return reject("CARD_ACTION_PARENT_WAIT");
			if (event.nativeEventInstanceMatches !== true) return reject("CARD_ACTION_EVENT_INSTANCE");
			if (event.gameMeNull !== true || event.connectedTransports !== 0) return reject("CARD_ACTION_HOST_BOUNDARY");
			if (!proof.beforeSummary || Object.getPrototypeOf(proof.beforeSummary) !== Object.prototype) return reject("CARD_ACTION_BEFORE_BINDING");
			try {
				if (canonicalize(proof.beforeSummary) !== canonicalize(before)) return reject("CARD_ACTION_BEFORE_BINDING");
			} catch (_) { return reject("CARD_ACTION_BEFORE_BINDING"); }
			const beforeDigest = crypto.createHash("sha256").update(canonicalize(before)).digest("hex");
			if (beforeDigest !== proof.beforeDigest || canonicalize(before) !== canonicalize({
				revision: 3, firstActSeatId: before.firstActSeatId,
				seats: before.seats.map(({ seatId, position, character, side, handCount, handCommitment }) =>
					({ seatId, position, character, side, handCount, handCommitment })),
			})) return reject("CARD_ACTION_BEFORE_SUMMARY");
			const after = proof.afterSummary;
			if (!after || Object.keys(after).sort().join(",") !== "action,firstActSeatId,responses,revision,seats" ||
				after.revision !== 4 || after.firstActSeatId !== before.firstActSeatId ||
				!Array.isArray(after.seats) || after.seats.length !== record.seatIds.length ||
				!Array.isArray(after.responses) || after.responses.length > 16 ||
				!Array.isArray(event.responseActions) ||
				!after.action || Object.keys(after.action).sort().join(",") !==
				"cardName,nativeEventId,nativeEventName,optionId,seatId,targetSeatId,usedCardPosition" ||
				after.action.nativeEventId !== event.nativeEventId || after.action.nativeEventName !== "gongJiOrFaShu" ||
				after.action.seatId !== event.seatId || after.action.cardName !== event.cardName ||
				after.action.targetSeatId !== event.targetSeatId || after.action.optionId !== event.optionId ||
				! ["d", "x"].includes(after.action.usedCardPosition)) return reject("CARD_ACTION_AFTER_SUMMARY");
			try {
				if (canonicalize(event.responseActions) !== canonicalize(after.responses)) return reject("CARD_ACTION_RESPONSE_BINDING");
			} catch (_) { return reject("CARD_ACTION_RESPONSE_BINDING"); }
			const responseEventIds = new Set(), responseOptionIds = new Set(), possibleSources = new Set([event.seatId]);
			const seatsWithCardConsumption = new Set([event.seatId]);
			const seatsTouchedByNativeCardTree = new Set([event.seatId, event.targetSeatId]);
			for (const response of after.responses) {
				const baseResponseKeys = "actionEventId,forced,kind,nativeEventId,optionId,optionShape,rootInstanceId,seatId,sourceSeatId,targetCount,targetSeatId,useCardChildrenCompleted,useCardChildrenStarted";
				const skillResponseKeys = [...baseResponseKeys.split(","), "guiHuoDelta", "physicalMaterialConsumed", "resolvedXiBie", "skillId", "xiBieApplied"].sort().join(",");
				if (!response || ![baseResponseKeys, skillResponseKeys].includes(Object.keys(response).sort().join(",")) ||
					response.actionEventId !== event.nativeEventId || response.rootInstanceId !== context.rootInstanceId ||
					!/^native_[A-Za-z0-9_-]{16,96}$/.test(response.nativeEventId || "") || responseEventIds.has(response.nativeEventId) ||
					!/^[A-Za-z0-9_-]{1,128}$/.test(response.seatId || "") || !record.seatIds.includes(response.seatId) ||
					!/^[A-Za-z0-9_-]{1,128}$/.test(response.sourceSeatId || "") || !record.seatIds.includes(response.sourceSeatId) ||
					response.seatId === response.sourceSeatId || !possibleSources.has(response.sourceSeatId) ||
					!/^native_option_[a-f0-9]{32}$/.test(response.optionId || "") || responseOptionIds.has(response.optionId) ||
					typeof response.forced !== "boolean" ||
					(response.kind === "card" ? Object.keys(response).sort().join(",") !== baseResponseKeys || response.forced !== false || response.useCardChildrenStarted !== 1 || response.useCardChildrenCompleted !== 1 ||
						!(response.optionShape === "native_single_target_card" && response.targetCount === 1 && record.seatIds.includes(response.targetSeatId) ||
							response.optionShape === "native_notarget_card" && response.targetCount === 0 && response.targetSeatId === null) :
					response.kind === "view_as_skill" ? Object.keys(response).sort().join(",") !== skillResponseKeys ||
						response.optionShape !== "native_single_target_view_as_skill" || response.skillId !== "yinYangZhanHuan" ||
						response.forced !== false || response.targetCount !== 1 || !record.seatIds.includes(response.targetSeatId) ||
						response.useCardChildrenStarted !== 1 || response.useCardChildrenCompleted !== 1 ||
						response.physicalMaterialConsumed !== true || response.xiBieApplied !== true ||
						!['an', 'di', 'feng', 'guang', 'huo', 'lei', 'shui'].includes(response.resolvedXiBie) ||
						!Number.isSafeInteger(response.guiHuoDelta) || response.guiHuoDelta < 1 || response.guiHuoDelta > 3 :
						response.kind !== "decline" || Object.keys(response).sort().join(",") !== baseResponseKeys ||
						response.optionShape !== "native_optional_decline" || response.targetCount !== 0 ||
						response.targetSeatId !== null || response.forced !== false ||
						response.useCardChildrenStarted !== 0 || response.useCardChildrenCompleted !== 0)) return reject("CARD_ACTION_RESPONSE_EVIDENCE");
				responseEventIds.add(response.nativeEventId);
				responseOptionIds.add(response.optionId);
				if (response.kind === "card" || response.kind === "view_as_skill") {
					possibleSources.add(response.seatId);
					seatsWithCardConsumption.add(response.seatId);
					seatsTouchedByNativeCardTree.add(response.seatId);
					if (response.targetCount === 1) seatsTouchedByNativeCardTree.add(response.targetSeatId);
				}
			}
			const seatsValid = after.seats.every((seat, index) => {
				const previous = before.seats[index];
				if (!seat || Object.keys(seat).sort().join(",") !== "character,handCommitment,handCount,position,seatId,side" ||
					seat.seatId !== record.seatIds[index] || seat.seatId !== previous.seatId ||
					seat.position !== previous.position || seat.character !== previous.character || seat.side !== previous.side ||
					!Number.isSafeInteger(seat.handCount) || seat.handCount < 0 || seat.handCount > 32 ||
					!DIGEST.test(seat.handCommitment || "")) return false;
				if (seat.handCount !== previous.handCount && seat.handCommitment === previous.handCommitment) return false;
				if (seatsWithCardConsumption.has(seat.seatId)) return seat.handCommitment !== previous.handCommitment;
				if (seatsTouchedByNativeCardTree.has(seat.seatId)) return true;
				return seat.handCount === previous.handCount && seat.handCommitment === previous.handCommitment;
			});
			if (!seatsValid) return reject("CARD_ACTION_SEAT_TRANSITION");
			if (crypto.createHash("sha256").update(canonicalize(after)).digest("hex") !== proof.afterDigest) return reject("CARD_ACTION_AFTER_DIGEST");
			return true;
		}
		return false;
	}

	function commitAuthorityEvent(message) {
		const record = sessions.get(message?.roomId);
		const proof = message?.proof;
		if (record && proof?.event?.kind === "xingbei_native_successor_card_action_v1") record.authorityFailureReason = null;
		if (message?.type === "host_authority_event" && authenticate(record, message) &&
			["xingbei_native_card_action_v1", "xingbei_native_skill_action_v1"].includes(proof?.event?.kind) && proof.eventSequence === 4 &&
			record.state === "playable_probe" && record.authorityStateRevision === 4 && record.nextAuthorityEventSequence === 5 &&
			record.lastAuthorityEvent?.sequence === 4 && record.acceptedNativeActionProofDigest) {
			try {
				const proofDigest = crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
				if (proofDigest === record.acceptedNativeActionProofDigest && proof.afterDigest === record.authorityStateDigest) {
					return Object.freeze({ ok: true, idempotent: true, session: publicView(record) });
				}
			} catch (_) { return failure("HOST_AUTHORITY_EVENT_REJECTED"); }
		}
		if (message?.type === "host_authority_event" && authenticate(record, message) &&
			proof?.event?.kind === "xingbei_native_successor_card_action_v1" && proof.eventSequence === 5 &&
			record.experimentalAuthorityEventLimit === 5 && record.state === "playable_probe" &&
			record.authorityStateRevision === 5 && record.nextAuthorityEventSequence === 6 &&
			record.lastAuthorityEvent?.sequence === 5 && record.experimentalEvent5AcceptedProofDigest) {
			try {
				const proofDigest = crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
				if (proofDigest === record.experimentalEvent5AcceptedProofDigest && proof.afterDigest === record.authorityStateDigest) {
					return Object.freeze({ ok: true, idempotent: true, session: publicView(record) });
				}
			} catch (_) { return failure("HOST_AUTHORITY_EVENT_REJECTED"); }
		}
		if (proof?.event?.kind === "xingbei_native_successor_card_action_v1") {
			const precheckFailure = !authenticate(record, message) ? "IDENTITY" :
				!['game_ready', 'playable_probe'].includes(record.state) ? "SESSION_STATE" :
				proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null ? "PROOF_KIND" :
				!Number.isSafeInteger(proof.eventSequence) || proof.eventSequence !== record.nextAuthorityEventSequence ? "SEQUENCE" :
				!Number.isSafeInteger(proof.stateRevisionBefore) || proof.stateRevisionBefore !== record.authorityStateRevision ||
				!Number.isSafeInteger(proof.stateRevisionAfter) || proof.stateRevisionAfter !== proof.stateRevisionBefore + 1 ? "REVISION" :
				!DIGEST.test(proof.beforeDigest || "") || !DIGEST.test(proof.afterDigest || "") || proof.beforeDigest === proof.afterDigest ? "DIGEST" :
				record.authorityStateDigest !== null && proof.beforeDigest !== record.authorityStateDigest ? "PREDECESSOR_DIGEST" : null;
			if (precheckFailure) {
				record.authorityFailureReason = `PRECHECK_${precheckFailure}`;
				return failure(`EVENT5_AUTHORITY_PRECHECK_${precheckFailure}`);
			}
		}
		if (message?.type !== "host_authority_event" || !authenticate(record, message) ||
			!['game_ready', 'playable_probe'].includes(record.state) || !proof ||
			proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null ||
			!Number.isSafeInteger(proof.eventSequence) || proof.eventSequence !== record.nextAuthorityEventSequence ||
			!Number.isSafeInteger(proof.stateRevisionBefore) || proof.stateRevisionBefore !== record.authorityStateRevision ||
			!Number.isSafeInteger(proof.stateRevisionAfter) || proof.stateRevisionAfter !== proof.stateRevisionBefore + 1 ||
			!DIGEST.test(proof.beforeDigest) || !DIGEST.test(proof.afterDigest) || proof.beforeDigest === proof.afterDigest ||
			(record.authorityStateDigest !== null && proof.beforeDigest !== record.authorityStateDigest) ||
			!validateAuthorityEvent(record, proof.event, proof)) {
			const event5Reason = proof?.event?.kind === "xingbei_native_successor_card_action_v1" &&
				/^[A-Z0-9_]{3,96}$/.test(record.authorityFailureReason || "") ?
					(record.authorityFailureReason.startsWith("EVENT5_") ? record.authorityFailureReason : `EVENT5_${record.authorityFailureReason}`) : null;
			return failure(event5Reason || "HOST_AUTHORITY_EVENT_REJECTED");
		}
		record.authorityStateRevision = proof.stateRevisionAfter;
		record.authorityFailureReason = null;
		record.authorityStateDigest = proof.afterDigest;
		record.authorityDigestChain.push(Object.freeze({ eventSequence: proof.eventSequence,
			beforeDigest: proof.beforeDigest, afterDigest: proof.afterDigest }));
		if (record.authorityDigestChain.length > 8) record.authorityDigestChain.shift();
		record.nextAuthorityEventSequence++;
		record.lastAuthorityEvent = Object.freeze({ sequence: proof.eventSequence, name: proof.event.name });
		if (proof.afterSummary) record.authorityStateSummary = structuredClone(proof.afterSummary);
		if (["xingbei_native_card_action_v1", "xingbei_native_skill_action_v1"].includes(proof.event.kind)) {
			record.acceptedNativeActionProofDigest = crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
			record.acceptedNativeActionKind = proof.event.kind;
			record.acceptedNativeActionName = proof.event.name;
			record.acceptedNativeActionNativeEventId = proof.event.nativeEventId;
			record.acceptedNativeActionRootInstanceId = proof.event.rootInstanceId;
			record.acceptedNativeActionSeatId = proof.event.seatId;
			if (proof.event.kind === "xingbei_native_card_action_v1") {
				record.acceptedNativeCardActionProofDigest = record.acceptedNativeActionProofDigest;
				record.acceptedNativeCardActionNativeEventId = proof.event.nativeEventId;
				record.acceptedNativeCardActionRootInstanceId = proof.event.rootInstanceId;
				record.acceptedNativeCardActionSeatId = proof.event.seatId;
			}
		}
		if (proof.event.kind === "xingbei_side_assignment_v1") {
			record.xingbeiAuthorityContext = { firstActSeatId: proof.event.firstActSeatId, sides: proof.event.sides.map(side => ({ ...side })),
				characters: null, rootInstanceId: proof.event.rootInstanceId || null };
		} else if (proof.event.kind === "xingbei_character_selection_v1") {
			record.xingbeiAuthorityContext.characters = proof.event.characters.map(entry => ({ ...entry }));
		}
		record.state = "playable_probe";
		if (proof.event.kind === "xingbei_opening_draw_v1") {
			record.xingbeiAuthorityContext.openingDrawCommitted = true;
			record.xingbeiAuthorityContext.openingSummary = Object.freeze({ revision: 3,
				firstActSeatId: proof.event.firstActSeatId,
				seats: proof.event.seats.map(seat => Object.freeze({ ...seat })) });
		}
		if (proof.event.kind === "xingbei_native_successor_card_action_v1") {
			record.experimentalEvent5AcceptedProofDigest = crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
		}
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function markBrowserReady(message) {
		const record = sessions.get(message?.roomId);
		if (message?.type !== "host_browser_ready" || !authenticate(record, message) || record.state !== "starting") {
			return failure("HOST_BROWSER_READY_REJECTED");
		}
		record.state = "browser_ready";
		armPhaseTimer(record, "browser_ready", engineReadyTimeoutMs,
			"HOST_ENGINE_READY_TIMEOUT", "engine_ready_timeout");
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function markEngineReady(message) {
		const record = sessions.get(message?.roomId);
		const proof = message?.proof;
		if (message?.type !== "host_engine_ready" || !authenticate(record, message) || record.state !== "browser_ready" ||
		!proof || Object.getPrototypeOf(proof) !== Object.prototype || Object.keys(proof).sort().join(",") !== "buildId,fileCount,kind,networkPolicy,totalBytes,trustContract" ||
			proof.kind !== "managed_engine_integrity_v1" || proof.trustContract !== MANAGED_ENGINE_TRUST_CONTRACT || proof.buildId !== record.engineBuildId ||
			proof.fileCount !== record.engineSourceFileCount || proof.totalBytes !== record.engineSourceTotalBytes ||
			proof.networkPolicy !== "same-origin-only") {
			return failure("HOST_ENGINE_READY_REJECTED");
		}
		clearPhaseTimer(record);
		record.state = "engine_ready";
		armPhaseTimer(record, "engine_ready", gameReadyTimeoutMs,
			"HOST_GAME_READY_TIMEOUT", "game_ready_timeout");
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function markGameReady(message) {
		const record = sessions.get(message?.roomId);
		const proof = message?.proof;
		if (message?.type !== "host_game_ready" || !authenticate(record, message) || record.state !== "engine_ready" ||
			!proof || proof.kind !== "pre_game_verification_v1" || proof.setupDigest !== record.setupDigest ||
			proof.engineBuildId !== record.engineBuildId || proof.trustContract !== MANAGED_ENGINE_TRUST_CONTRACT ||
			!DIGEST.test(proof.preGameSummaryDigest) || proof.checkpoint !== null ||
			!Array.isArray(proof.seatIds) || proof.seatIds.length !== record.seatIds.length ||
			proof.seatIds.some((seatId, index) => seatId !== record.seatIds[index])) {
			return failure("HOST_GAME_READY_REJECTED");
		}
		clearPhaseTimer(record);
		record.preGameSummaryDigest = proof.preGameSummaryDigest;
		record.authorityStateRevision = 0;
		record.authorityStateDigest = null;
		record.nextAuthorityEventSequence = 1;
		record.lastAuthorityEvent = null;
		record.xingbeiAuthorityContext = null;
		record.authorityDigestChain = [];
		record.state = "game_ready";
		return Object.freeze({ ok: true, session: publicView(record) });
	}

	function commitAuthoritativeResult(message) {
		const record = sessions.get(message?.roomId);
		if (!authenticate(record, message) || !["game_ready", "playable_probe"].includes(record.state)) {
			return failure("HOST_AUTHORITY_REJECTED");
		}
		if (message.type !== "authoritative_result" ||
			!Number.isSafeInteger(message.sequence) ||
			message.sequence !== record.nextResultSequence) {
			return failure("HOST_RESULT_SEQUENCE_REJECTED");
		}
		let encoded;
		try {
			encoded = JSON.stringify(message.result);
		} catch (_) {
			return failure("HOST_RESULT_INVALID");
		}
		if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 65536) {
			return failure("HOST_RESULT_INVALID");
		}
		const accepted = Object.freeze({
			roomId: record.roomId,
			sessionId: record.sessionId,
			sequence: message.sequence,
			result: JSON.parse(encoded),
		});
		try {
			onAuthoritativeResult(accepted);
		} catch (_) {
			return failure("HOST_RESULT_SINK_FAILED");
		}
		record.nextResultSequence++;
		// Result delivery is not a native state transition. Only authenticated native
		// authority events may advance the digest/version chain.
		return Object.freeze({ ok: true, accepted });
	}

	async function stop(roomId, reason = "server_stop") {
		const record = sessions.get(roomId);
		if (!record || !ACTIVE_STATES.has(record.state)) {
			return failure("HOST_SESSION_NOT_ACTIVE");
		}
		clearPhaseTimer(record);
		record.state = "stopping";
		notifySessionLifecycle(Object.freeze({ roomId: record.roomId, sessionId: record.sessionId,
			state: record.state, code: null, stage: "stopping" }));
		// Fence private snapshots as soon as stop is requested, not only after the
		// child exits. A response already in flight must not mint a commitment for
		// a session whose shutdown has begun.
		destroyPrivateNativeEffectState(record);
		destroyPrivateAtomicCapture(record);
		try {
			await record.handle.stop(reason);
			if (record.state === "stopping") finish(record);
			return Object.freeze({ ok: true, session: publicView(record) });
		} catch (_) {
			fail(record, "HOST_STOP_FAILED");
			return failure("HOST_STOP_FAILED");
		}
	}

	async function sendChoiceDelivery(roomId, delivery) {
		const record = sessions.get(roomId);
		if (!record || !["game_ready", "playable_probe"].includes(record.state) || !record.handle?.sendHostCommand ||
			!delivery || Object.getPrototypeOf(delivery) !== Object.prototype || typeof delivery.choiceId !== "string" ||
			typeof delivery.deliveryId !== "string" || typeof delivery.nativeEventId !== "string" || typeof delivery.seatId !== "string" ||
			!delivery.resolution || Object.getPrototypeOf(delivery.resolution) !== Object.prototype ||
			!["player", "trustee"].includes(delivery.resolution.kind) || typeof delivery.resolution.option !== "string") return failure("HOST_CHOICE_DELIVERY_REJECTED");
		const option = delivery.resolution.option;
		const event5Candidate = record.nativeEvent5Candidate;
		const isEvent5Choice = Boolean(event5Candidate && delivery.nativeEventId === event5Candidate.nativeEventId &&
			delivery.seatId === event5Candidate.seatId);
		let event5Binding = null;
		if (isEvent5Choice) {
			try { event5Binding = getCurrentSeatBinding(roomId, event5Candidate.seatId); } catch (_) {}
			if (record.experimentalAuthorityEventLimit !== 5 || process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "5" ||
				process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" || record.authorityStateRevision !== 4 ||
				delivery.eventSequence !== 5 || !/^choice_[a-f0-9]{32}$/.test(delivery.choiceId || "") ||
				!/^delivery_choice_[a-f0-9]{32}$/.test(delivery.deliveryId || "") || !event5Candidate.options.includes(option) ||
				!event5Binding || event5Binding.connected !== true || event5Binding.current !== true ||
				event5Binding.credentialAuthenticated !== true || event5Binding.ordinaryPlayer !== true ||
				event5Binding.connectionGeneration !== event5Candidate.connectionGeneration ||
				(record.experimentalEvent5Delivery && (record.experimentalEvent5Delivery.choiceId !== delivery.choiceId ||
					record.experimentalEvent5Delivery.deliveryId !== delivery.deliveryId ||
					record.experimentalEvent5Delivery.optionId !== option ||
					record.experimentalEvent5Delivery.resolutionKind !== delivery.resolution.kind))) {
				return failure("EVENT5_CHOICE_DELIVERY_REJECTED");
			}
		}
		const actionCandidate = record.nativeJiRiActionCandidate;
		const isJiRiAction = Boolean(actionCandidate && record.privatePreActionCaptureCandidate?.captureOrdinal === 1 &&
			delivery.nativeEventId === actionCandidate.nativeEventId && delivery.seatId === actionCandidate.seatId &&
			delivery.choiceId === record.privatePreActionCaptureCandidate.choiceId && Object.hasOwn(actionCandidate.skillOptions || {}, option));
		const targetCandidate = record.nativeJiRiTargetCandidate;
		const isJiRiTarget = Boolean(targetCandidate && delivery.nativeEventId === targetCandidate.nativeEventId &&
			delivery.seatId === targetCandidate.seatId && targetCandidate.options.includes(option));
		const sameDelivery = (existing, candidate) => !existing ||
			(existing.choiceId === delivery.choiceId && existing.deliveryId === delivery.deliveryId &&
				existing.nativeEventId === delivery.nativeEventId && existing.seatId === delivery.seatId &&
				existing.optionId === option && existing.resolutionKind === delivery.resolution.kind &&
				(!candidate.targetSeatId || existing.targetSeatId === candidate.targetSeatId));
		if ((isJiRiAction && !sameDelivery(record.nativeJiRiActionDelivery, { targetSeatId: actionCandidate.skillOptions[option] })) ||
			(isJiRiTarget && !sameDelivery(record.nativeJiRiTargetDelivery, {}))) return failure("NATIVE_JIRIMO_DELIVERY_CONFLICT");
		try {
			let event5Accepted = null;
			if (isEvent5Choice) {
				event5Accepted = Object.freeze({ roomId: record.roomId, hostSessionId: record.sessionId,
					nativeEventId: delivery.nativeEventId, seatId: delivery.seatId, eventSequence: delivery.eventSequence,
					choiceId: delivery.choiceId, deliveryId: delivery.deliveryId, optionId: option,
					resolutionKind: delivery.resolution.kind, connectionGeneration: event5Binding.connectionGeneration, immutable: true });
				if (record.experimentalEvent5Delivery && (record.experimentalEvent5Delivery.choiceId !== event5Accepted.choiceId ||
					record.experimentalEvent5Delivery.deliveryId !== event5Accepted.deliveryId ||
					record.experimentalEvent5Delivery.optionId !== event5Accepted.optionId)) {
					fail(record, "EVENT5_CHOICE_DELIVERY_REPLAY_CONFLICT");
					Promise.resolve(record.handle?.stop("event5_choice_delivery_replay_conflict")).catch(() => {});
					return failure("EVENT5_CHOICE_DELIVERY_REPLAY_CONFLICT");
				}
				// Reserve immutable delivery provenance before IPC can resume the native
				// event. A send callback may race with the page's next phase boundary.
				record.experimentalEvent5Delivery ||= event5Accepted;
			}
			await record.handle.sendHostCommand(Object.freeze({ ...delivery, type: "host_choice_delivery", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret }));
			if (isEvent5Choice) {
				let current = null;
				try { current = getCurrentSeatBinding(roomId, event5Candidate.seatId); } catch (_) {}
				if (sessions.get(roomId) !== record || record.state !== "playable_probe" || !current || current.connected !== true ||
					current.current !== true || current.connectionGeneration !== event5Candidate.connectionGeneration) {
					fail(record, "EVENT5_CHOICE_CONNECTION_CHANGED_AFTER_DELIVERY");
					Promise.resolve(record.handle?.stop("event5_choice_connection_changed_after_delivery")).catch(() => {});
					return failure("EVENT5_CHOICE_CONNECTION_CHANGED_AFTER_DELIVERY");
				}
				if (current.connectionGeneration !== event5Accepted.connectionGeneration) {
					fail(record, "EVENT5_CHOICE_CONNECTION_GENERATION_CHANGED");
					Promise.resolve(record.handle?.stop("event5_choice_connection_generation_changed")).catch(() => {});
					return failure("EVENT5_CHOICE_CONNECTION_GENERATION_CHANGED");
				}
			}
			if (isJiRiAction && !record.nativeJiRiActionDelivery) {
				record.nativeJiRiActionDelivery = Object.freeze({ choiceId: delivery.choiceId, deliveryId: delivery.deliveryId,
					nativeEventId: delivery.nativeEventId, seatId: delivery.seatId, optionId: option,
					targetSeatId: actionCandidate.skillOptions[option], resolutionKind: delivery.resolution.kind });
			}
			if (isJiRiTarget && !record.nativeJiRiTargetDelivery) {
				record.nativeJiRiTargetDelivery = Object.freeze({ choiceId: delivery.choiceId, deliveryId: delivery.deliveryId,
					nativeEventId: delivery.nativeEventId, seatId: delivery.seatId, optionId: option,
					resolutionKind: delivery.resolution.kind });
			}
			return Object.freeze({ ok: true });
		} catch (_) { return failure("HOST_CHOICE_DELIVERY_REJECTED"); }
	}

	async function diagnoseNativeStart(roomId, mode = "native_start") {
		const record = sessions.get(roomId);
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "controlled_block", "managed_random_failure_probe"].includes(mode) ||
			!record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			(["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5"].includes(mode) && (record.authorityStateRevision !== 3 ||
				record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw"))) return failure("HOST_DIAGNOSTIC_COMMAND_REJECTED");
		try {
			await record.handle.sendHostCommand({ type: "host_native_start_diagnostic", mode, kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret });
			return Object.freeze({ ok: true });
		} catch (_) { return failure("HOST_DIAGNOSTIC_COMMAND_REJECTED"); }
	}

	async function snapshotNativeStart(roomId, mode = "managed_opening_root_action_event4") {
		const record = sessions.get(roomId);
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
			!(["managed_opening_root_action_event4", "managed_native_skill_candidate_probe"].includes(mode)) ||
			!record || record.state !== "playable_probe" || !record.handle?.sendHostCommand) return failure("HOST_NATIVE_SNAPSHOT_REJECTED");
		try {
			await record.handle.sendHostCommand({ type: "host_native_start_snapshot", mode, kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret });
			return Object.freeze({ ok: true });
		} catch (_) { return failure("HOST_NATIVE_SNAPSHOT_REJECTED"); }
	}

	async function snapshotNativeCardLedger(roomId, mode) {
		const record = sessions.get(roomId);
		const expectedRevision = mode === "pre_native_action" ? 3 : mode === "post_phase_over" ? 4 : null;
		if (process.env.V2_NATIVE_CARD_LEDGER_PROBE !== "1" || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
			process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" || !record || record.state !== "playable_probe" ||
			!record.handle?.sendHostCommand || expectedRevision !== record.authorityStateRevision ||
			record.xingbeiAuthorityContext?.rootInstanceId == null || record.privateCardLedgerRequestCount >= 2 ||
			record.privateAtomicCaptureRequests.size !== 0 ||
			(mode === "pre_native_action" && record.privateCardLedgerRequestCount !== 0) ||
			(mode === "post_phase_over" && (record.privateCardLedgerRequestCount !== 1 || record.privateCardLedgerSnapshotCount !== 1)) ||
			(mode === "pre_native_action" && (record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw")) ||
			(mode === "post_phase_over" && (record.lastAuthorityEvent?.sequence !== 4 || record.lastAuthorityEvent?.name !== "gongJiOrFaShu"))) {
			return failure("NATIVE_CARD_LEDGER_PROBE_REJECTED");
		}
		const requestId = `ledger_${randomBytes(16).toString("hex")}`;
		if (!/^ledger_[a-f0-9]{32}$/.test(requestId)) return failure("NATIVE_CARD_LEDGER_PROBE_REJECTED");
		record.privateCardLedgerRequestCount++;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				record.privateCardLedgerRequests.delete(requestId);
				resolve(failure("NATIVE_CARD_LEDGER_PROBE_TIMEOUT"));
			}, 5000);
			if (timer.unref) timer.unref();
			record.privateCardLedgerRequests.set(requestId, { timer, resolve, mode });
			Promise.resolve(record.handle.sendHostCommand({ type: "host_native_card_ledger_snapshot", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret, requestId, mode, seatIds: record.seatIds }))
				.catch(() => {
					const pending = record.privateCardLedgerRequests.get(requestId);
					if (!pending) return;
					record.privateCardLedgerRequests.delete(requestId);
					clearTimeout(pending.timer);
					pending.resolve(failure("NATIVE_CARD_LEDGER_PROBE_REJECTED"));
				});
		});
	}

	async function snapshotNativeEffectState(roomId, input) {
		const record = sessions.get(roomId);
		const modes = new Set(["before_native_response", "after_native_response", "repeat_native_response"]);
		if (process.env.V2_NATIVE_EFFECT_STATE_PROBE !== "1" || process.env.V2_NATIVE_YINYANG_FIXTURE !== "1" ||
			process.env.V2_NATIVE_MANAGED_YINYANG !== "1" || process.env.V2_NATIVE_MANAGED_RESPONSE !== "1" ||
			process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" || !record || record.state !== "playable_probe" ||
			!record.handle?.sendHostCommand || record.seatIds?.length !== 4 ||
			!record.xingbeiAuthorityContext?.rootInstanceId || !input || Object.getPrototypeOf(input) !== Object.prototype ||
			Object.keys(input).sort().join(",") !== "mode,nativeCompletionOrdinal,nativeEventId,seatId" || !modes.has(input.mode) ||
			!/^native_event_[a-f0-9]{32}$/.test(input.nativeEventId || "") || !record.seatIds.includes(input.seatId) ||
			record.privateNativeEffectRequestCount >= 3 || record.privateNativeEffectRequests.size !== 0 ||
			record.privateAtomicCaptureRequests.size !== 0) {
			return failure("NATIVE_EFFECT_STATE_PROBE_REJECTED");
		}
		const event = record.privateNativeEffectEvent;
		const pre = input.mode === "before_native_response";
		const post = input.mode === "after_native_response";
		const repeat = input.mode === "repeat_native_response";
		const candidate = record.privateNativeEffectCandidate;
		const last = record.lastAuthorityEvent;
		if ((pre && (!candidate || candidate.nativeEventId !== input.nativeEventId || candidate.seatId !== input.seatId ||
			candidate.eventSequence !== 4 || candidate.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
			record.privateNativeEffectRequestCount !== 0 || record.authorityStateRevision !== 3 ||
			last?.sequence !== 3 || last?.name !== "gameDraw" || input.nativeCompletionOrdinal !== null)) ||
			(post && (record.privateNativeEffectRequestCount !== 1 || record.privateNativeEffectSnapshotCount !== 1 ||
				!Number.isSafeInteger(input.nativeCompletionOrdinal) || input.nativeCompletionOrdinal < 1 || !event ||
				event.nativeEventId !== input.nativeEventId || event.seatId !== input.seatId ||
				!((record.authorityStateRevision === 3 && last?.sequence === 3 && last?.name === "gameDraw") ||
					(record.authorityStateRevision === 4 && last?.sequence === 4 && last?.name === "gongJiOrFaShu")))) ||
			(repeat && (record.privateNativeEffectRequestCount !== 2 || record.privateNativeEffectSnapshotCount !== 2 ||
				!Number.isSafeInteger(input.nativeCompletionOrdinal) || input.nativeCompletionOrdinal !== event?.nativeCompletionOrdinal ||
				!event || event.nativeEventId !== input.nativeEventId || event.seatId !== input.seatId))) {
			return failure("NATIVE_EFFECT_STATE_SEQUENCE_REJECTED");
		}
		if (pre && event) return failure("NATIVE_EFFECT_STATE_EVENT_EXISTS");
		if (!pre && !event) return failure("NATIVE_EFFECT_STATE_EVENT_MISSING");
		if (pre) record.privateNativeEffectEvent = { nativeEventId: input.nativeEventId, seatId: input.seatId, nativeCompletionOrdinal: null };
		else if (post) record.privateNativeEffectEvent.nativeCompletionOrdinal = input.nativeCompletionOrdinal;
		if (!record.privateNativeEffectState) {
			const key = randomBytes(32);
			if (!Buffer.isBuffer(key) || key.length !== 32) return failure("NATIVE_EFFECT_STATE_KEY_UNAVAILABLE");
			try {
				record.privateNativeEffectState = createManagedNativeEffectStateCommitment({ roomId: record.roomId,
					hostSessionId: record.sessionId, engineBuildId: record.engineBuildId,
					rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId, seatIds: record.seatIds, key });
			} catch (_) { key.fill(0); return failure("NATIVE_EFFECT_STATE_INITIALIZATION_REJECTED"); }
			key.fill(0);
		}
		const requestId = `effect_${randomBytes(16).toString("hex")}`;
		if (!/^effect_[a-f0-9]{32}$/.test(requestId)) return failure("NATIVE_EFFECT_STATE_REQUEST_REJECTED");
		record.privateNativeEffectRequestCount++;
		const captureBoundary = pre ? "native_response_waiting" : "native_response_completed";
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				record.privateNativeEffectRequests.delete(requestId);
				resolve(failure("NATIVE_EFFECT_STATE_TIMEOUT"));
				if (ACTIVE_STATES.has(record.state)) {
					fail(record, "NATIVE_EFFECT_STATE_TIMEOUT");
					Promise.resolve(record.handle?.stop("native_effect_state_timeout")).catch(() => {});
				}
			}, 5000);
			if (timer.unref) timer.unref();
			record.privateNativeEffectRequests.set(requestId, { requestId, mode: input.mode, captureBoundary,
				nativeCompletionOrdinal: pre ? null : input.nativeCompletionOrdinal, timer, resolve });
			Promise.resolve(record.handle.sendHostCommand({ type: "host_native_effect_state_snapshot", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret, requestId, mode: input.mode,
				nativeEventId: input.nativeEventId, seatId: input.seatId, nativeCompletionOrdinal: pre ? null : input.nativeCompletionOrdinal,
				captureBoundary, schema: "xingbei_native_private_effect_state_v1",
				rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId, engineBuildId: record.engineBuildId,
				seatIds: record.seatIds }))
				.catch(() => {
					const pending = record.privateNativeEffectRequests.get(requestId);
					if (!pending) return;
					record.privateNativeEffectRequests.delete(requestId);
					clearTimeout(pending.timer);
					pending.resolve(failure("NATIVE_EFFECT_STATE_REQUEST_REJECTED"));
					if (ACTIVE_STATES.has(record.state)) {
						fail(record, "NATIVE_EFFECT_STATE_REQUEST_REJECTED");
						Promise.resolve(record.handle?.stop("native_effect_state_request_failed")).catch(() => {});
					}
				});
		});
	}

	async function snapshotNativeAtomicCapture(roomId) {
		const record = sessions.get(roomId);
		const boundaryOrdinal = record?.nativePhaseBoundaryReleaseSent ? 2 : 1;
		if (process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE !== "1" || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
			process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" ||
			!record || record.state !== "playable_probe" || record.authorityStateRevision !== 4 ||
			record.lastAuthorityEvent?.sequence !== 4 || !["gongJiOrFaShu", "jiRi_moBaoChongJie"].includes(record.lastAuthorityEvent?.name) ||
			(boundaryOrdinal === 1 && record.nativePhaseBoundaryReleaseSent) ||
			(boundaryOrdinal === 2 && (process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE !== "1" ||
				record.privateAtomicCaptureCount < 2 || !record.privateAtomicCaptureFenceProofs?.has(1) || record.privateAtomicCaptureCount >= 4)) ||
			!record.handle?.sendHostCommand || record.seatIds?.length !== 4 ||
			!record.xingbeiAuthorityContext?.rootInstanceId || record.privateAtomicCaptureRequestCount >= 8 ||
			record.privateAtomicCaptureRequests.size !== 0 || record.privateCardLedgerRequests.size !== 0 ||
			record.privateNativeEffectRequests.size !== 0) return failure("NATIVE_ATOMIC_CAPTURE_PROBE_REJECTED");
		if (!record.privateAtomicCapture) {
			const key = randomBytes(32);
			if (!Buffer.isBuffer(key) || key.length !== 32) return failure("NATIVE_ATOMIC_CAPTURE_KEY_UNAVAILABLE");
			try {
				record.privateAtomicCapture = createManagedNativeAtomicCapture({ roomId: record.roomId, sessionId: record.sessionId,
					engineBuildId: record.engineBuildId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId,
					seatIds: record.seatIds, key });
			} catch (_) { return failure("NATIVE_ATOMIC_CAPTURE_INITIALIZATION_REJECTED"); }
			finally { key.fill(0); }
		}
		const requestId = `atomic_${randomBytes(16).toString("hex")}`;
		if (!/^atomic_[a-f0-9]{32}$/.test(requestId)) return failure("NATIVE_ATOMIC_CAPTURE_REQUEST_REJECTED");
		const captureOrdinal = record.privateAtomicCaptureRequestCount + 1;
		record.privateAtomicCaptureRequestCount++;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				record.privateAtomicCaptureRequests.delete(requestId);
				resolve(failure("NATIVE_ATOMIC_CAPTURE_TIMEOUT"));
				if (ACTIVE_STATES.has(record.state)) {
					fail(record, "NATIVE_ATOMIC_CAPTURE_TIMEOUT");
					Promise.resolve(record.handle?.stop("native_atomic_capture_timeout")).catch(() => {});
				}
			}, 5000);
			if (timer.unref) timer.unref();
			record.privateAtomicCaptureRequests.set(requestId, { requestId, captureOrdinal, boundaryOrdinal, timer, resolve });
			Promise.resolve(record.handle.sendHostCommand({ type: "host_native_atomic_capture", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret, requestId, captureOrdinal,
				boundaryOrdinal,
				engineBuildId: record.engineBuildId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId,
				seatIds: record.seatIds }))
				.catch(() => {
					const pending = record.privateAtomicCaptureRequests.get(requestId);
					if (!pending) return;
					record.privateAtomicCaptureRequests.delete(requestId);
					clearTimeout(pending.timer);
					pending.resolve(failure("NATIVE_ATOMIC_CAPTURE_REQUEST_REJECTED"));
					if (ACTIVE_STATES.has(record.state)) {
						fail(record, "NATIVE_ATOMIC_CAPTURE_REQUEST_REJECTED");
						Promise.resolve(record.handle?.stop("native_atomic_capture_request_failed")).catch(() => {});
					}
				});
		});
	}

	async function snapshotNativePreActionCapture(roomId, input) {
		const record = sessions.get(roomId);
		const allowed = "choiceId,nativeEventId,seatId";
		const candidate = record?.privatePreActionCaptureCandidate;
		const supportedFixture = process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1" ||
			(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") ||
			process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1";
		if (process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE !== "1" || !supportedFixture ||
			process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE !== "1" ||
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" || !record || record.state !== "playable_probe" ||
			record.authorityStateRevision !== 3 || record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw" ||
			!record.handle?.sendHostCommand || record.seatIds?.length !== 4 || !record.xingbeiAuthorityContext?.rootInstanceId ||
			!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(",") !== allowed ||
			!/^native_[A-Za-z0-9_-]{16,96}$/.test(input.nativeEventId || "") || !/^choice_[a-f0-9]{32}$/.test(input.choiceId || "") ||
			!record.seatIds.includes(input.seatId) || !candidate || candidate.captureOrdinal || candidate.nativeEventId !== input.nativeEventId ||
			candidate.seatId !== input.seatId || candidate.rootInstanceId !== record.xingbeiAuthorityContext.rootInstanceId ||
			candidate.eventSequence !== 4 || !isManagedChoicePending(Object.freeze({ roomId: record.roomId, hostSessionId: record.sessionId,
				nativeEventId: input.nativeEventId, choiceId: input.choiceId, seatId: input.seatId, eventSequence: candidate.eventSequence })) ||
			record.privatePreActionCaptureRequestCount !== 0 || record.privatePreActionCaptureRequests.size !== 0 ||
			record.privateAtomicCaptureRequests.size !== 0 || record.privateCardLedgerRequests.size !== 0 || record.privateNativeEffectRequests.size !== 0) {
			return failure("NATIVE_PREACTION_CAPTURE_PROBE_REJECTED");
		}
		if (!record.privatePreActionCapture) {
			const key = randomBytes(32);
			if (!Buffer.isBuffer(key) || key.length !== 32) return failure("NATIVE_PREACTION_CAPTURE_KEY_UNAVAILABLE");
			try { record.privatePreActionCapture = createManagedNativePreActionCapture({ roomId: record.roomId, sessionId: record.sessionId,
				engineBuildId: record.engineBuildId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId, seatIds: record.seatIds, key }); }
			catch (_) { return failure("NATIVE_PREACTION_CAPTURE_INITIALIZATION_REJECTED"); }
			finally { key.fill(0); }
		}
		const requestId = `preaction_${randomBytes(16).toString("hex")}`;
		if (!/^preaction_[a-f0-9]{32}$/.test(requestId)) return failure("NATIVE_PREACTION_CAPTURE_REQUEST_REJECTED");
		record.privatePreActionCaptureRequestCount++;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				record.privatePreActionCaptureRequests.delete(requestId);
				resolve(failure("NATIVE_PREACTION_CAPTURE_TIMEOUT"));
				if (ACTIVE_STATES.has(record.state)) {
					fail(record, "NATIVE_PREACTION_CAPTURE_TIMEOUT");
					Promise.resolve(record.handle?.stop("native_preaction_capture_timeout")).catch(() => {});
				}
			}, 5000);
			if (timer.unref) timer.unref();
			record.privatePreActionCaptureRequests.set(requestId, { requestId, nativeEventId: input.nativeEventId,
				choiceId: input.choiceId, seatId: input.seatId, timer, resolve });
			Promise.resolve(record.handle.sendHostCommand({ type: "host_native_pre_action_capture", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret, requestId,
				engineBuildId: record.engineBuildId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId,
				seatIds: record.seatIds, nativeEventId: input.nativeEventId, choiceId: input.choiceId, seatId: input.seatId }))
				.catch(error => {
					const pending = record.privatePreActionCaptureRequests.get(requestId);
					if (!pending) return;
					record.privatePreActionCaptureRequests.delete(requestId);
					clearTimeout(pending.timer);
					const code = error?.message === "HOST_PREACTION_CAPTURE_COMMAND_REJECTED"
						? "NATIVE_PREACTION_CAPTURE_COMMAND_NOT_ALLOWED" : "NATIVE_PREACTION_CAPTURE_REQUEST_REJECTED";
					pending.resolve(failure(code));
					if (ACTIVE_STATES.has(record.state)) {
						fail(record, "NATIVE_PREACTION_CAPTURE_REQUEST_REJECTED");
						Promise.resolve(record.handle?.stop("native_preaction_capture_request_failed")).catch(() => {});
					}
				});
		});
	}

	async function snapshotSuccessorPreActionCapture(roomId) {
		const record = sessions.get(roomId);
		const candidate = record?.nativeNextSeatCandidate;
		const previous = record?.privatePreActionCaptureCandidate;
		let seatBinding = null;
		try { seatBinding = candidate ? getCurrentSeatBinding(roomId, candidate.seatId) : null; } catch (_) { seatBinding = null; }
		if (process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE !== "1" ||
			process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE !== "1" || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
			process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE !== "1" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" ||
			!record || record.state !== "playable_probe" || record.authorityStateRevision !== 4 || record.nextAuthorityEventSequence !== 5 ||
			record.lastAuthorityEvent?.sequence !== 4 || !record.nativePhaseBoundaryReleaseSent || !record.handle?.sendHostCommand ||
			!candidate || !previous || previous.captureOrdinal !== 1 || candidate.roomId !== roomId || candidate.hostSessionId !== record.sessionId ||
			candidate.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId || candidate.previousActorSeatId !== previous.seatId ||
			candidate.seatId === previous.seatId || candidate.nativeEventId === previous.nativeEventId ||
			!seatBinding || Object.getPrototypeOf(seatBinding) !== Object.prototype ||
			Object.keys(seatBinding).sort().join(",") !== "connected,connectionGeneration,credentialAuthenticated,current,ordinaryPlayer,roomId,seatId" ||
			seatBinding.roomId !== roomId || seatBinding.seatId !== candidate.seatId || seatBinding.connected !== true || seatBinding.current !== true ||
			seatBinding.credentialAuthenticated !== true || seatBinding.ordinaryPlayer !== true || !Number.isSafeInteger(seatBinding.connectionGeneration) ||
			seatBinding.connectionGeneration < 1 || hasPendingManagedChoices(roomId, record.sessionId) !== false ||
			record.successorPreActionCaptureRequestCount >= 2 || record.successorPreActionCaptureRequests.size !== 0 ||
			record.privateAtomicCaptureRequests.size !== 0 || record.privateCardLedgerRequests.size !== 0 || record.privateNativeEffectRequests.size !== 0) {
			return failure("SUCCESSOR_PREACTION_CAPTURE_PROBE_REJECTED");
		}
		if (!record.successorPreActionCapture) {
			const key = randomBytes(32);
			if (!Buffer.isBuffer(key) || key.length !== 32) return failure("SUCCESSOR_PREACTION_KEY_UNAVAILABLE");
			const previousCommitment = Object.freeze({ roomId: record.roomId, hostSessionId: record.sessionId,
				rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId, engineBuildId: record.engineBuildId,
				seatIds: Object.freeze([...record.seatIds]), nativeEventId: previous.nativeEventId,
				eventInstanceId: previous.eventInstanceId, nativeCompletionOrdinal: previous.nativeCompletionOrdinal,
				stateDigest: previous.stateDigest, commitment: previous.commitment, captureOrdinal: previous.captureOrdinal,
				seatId: previous.seatId });
			try { record.successorPreActionCapture = createManagedSuccessorPreActionCapture({ roomId, sessionId: record.sessionId,
				engineBuildId: record.engineBuildId, rootInstanceId: candidate.rootInstanceId, seatIds: record.seatIds,
				previousCapture: previousCommitment, previousActorSeatId: previous.seatId, seatBinding, key }); }
			catch (_) { return failure("SUCCESSOR_PREACTION_INITIALIZATION_REJECTED"); }
			finally { key.fill(0); }
		}
		const requestId = `successor_${randomBytes(16).toString("hex")}`;
		if (!/^successor_[a-f0-9]{32}$/.test(requestId)) return failure("SUCCESSOR_PREACTION_REQUEST_REJECTED");
		const captureOrdinal = record.successorPreActionCaptureRequestCount + 1;
		record.successorPreActionCaptureRequestCount++;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				record.successorPreActionCaptureRequests.delete(requestId);
				resolve(failure("SUCCESSOR_PREACTION_TIMEOUT"));
				if (ACTIVE_STATES.has(record.state)) {
					fail(record, "SUCCESSOR_PREACTION_TIMEOUT");
					Promise.resolve(record.handle?.stop("successor_preaction_timeout")).catch(() => {});
				}
			}, 5000);
			if (timer.unref) timer.unref();
			record.successorPreActionCaptureRequests.set(requestId, { requestId, captureOrdinal, nativeEventId: candidate.nativeEventId,
				seatId: candidate.seatId, waitingCompletionOrdinal: candidate.waitingCompletionOrdinal, timer, resolve });
			Promise.resolve(record.handle.sendHostCommand({ type: "host_native_successor_preaction_capture", kind: "managed_host", protocol: PROTOCOL,
				roomId, sessionId: record.sessionId, secret: record.secret, requestId, engineBuildId: record.engineBuildId,
				rootInstanceId: candidate.rootInstanceId, seatIds: record.seatIds, captureOrdinal, nativeEventId: candidate.nativeEventId,
				eventInstanceId: candidate.eventInstanceId, parentEventInstanceId: candidate.parentEventInstanceId,
				waitingCompletionOrdinal: candidate.waitingCompletionOrdinal,
				seatId: candidate.seatId, previousNativeEventId: previous.nativeEventId, previousSeatId: previous.seatId,
				candidateOptionIds: candidate.options, candidateOptionKinds: candidate.optionKinds })).catch(() => {
				const pending = record.successorPreActionCaptureRequests.get(requestId);
				if (!pending) return;
				record.successorPreActionCaptureRequests.delete(requestId);
				clearTimeout(pending.timer);
				pending.resolve(failure("SUCCESSOR_PREACTION_REQUEST_REJECTED"));
				if (ACTIVE_STATES.has(record.state)) {
					fail(record, "SUCCESSOR_PREACTION_REQUEST_REJECTED");
					Promise.resolve(record.handle?.stop("successor_preaction_request_failed")).catch(() => {});
				}
			});
		});
	}

	function createV3SeatStateForRequest(roomId, input) {
		const record = sessions.get(roomId);
		const exact = (value, keys) => Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
			Object.keys(value).sort().join(",") === [...keys].sort().join(","));
		if (!record || record.state !== "playable_probe" || record.authorityStateRevision !== 4 || record.nextAuthorityEventSequence !== 5 ||
			record.lastAuthorityEvent?.sequence !== 4 || !(exact(input, ["recipientSeatId", "request"]) ||
				exact(input, ["recipientSeatId", "request", "stateSequence"])) ||
			!SEAT_ID.test(input.recipientSeatId || "") || !record.seatIds.includes(input.recipientSeatId) ||
			!input.request || Object.getPrototypeOf(input.request) !== Object.prototype || !record.successorPreActionCaptureResult ||
			!record.successorPreActionCaptureEnvelope || hasPendingManagedChoices(roomId, record.sessionId) !== false ||
			(input.stateSequence !== undefined && (!Number.isSafeInteger(input.stateSequence) || input.stateSequence < 1))) return failure("V3_SEAT_STATE_NOT_AVAILABLE");
		let authorized = null, binding = null;
		try {
			authorized = authorizeSeatStateRequest({ roomId, recipientSeatId: input.recipientSeatId, request: input.request });
			binding = getCurrentSeatBinding(roomId, input.recipientSeatId);
		} catch (_) { return failure("V3_SEAT_STATE_RECIPIENT_REJECTED"); }
		const validBinding = value => value && Object.getPrototypeOf(value) === Object.prototype && value.roomId === roomId &&
			value.seatId === input.recipientSeatId && value.connected === true && value.current === true &&
			value.credentialAuthenticated === true && value.ordinaryPlayer === true && Number.isSafeInteger(value.connectionGeneration) &&
			value.connectionGeneration > 0;
		if (!validBinding(authorized) || !validBinding(binding) || authorized.connectionGeneration !== binding.connectionGeneration) {
			return failure("V3_SEAT_STATE_RECIPIENT_REJECTED");
		}
		if (!record.v3SeatStateProjection) {
			const key = randomBytes(32);
			if (!Buffer.isBuffer(key) || key.length !== 32) return failure("V3_SEAT_STATE_KEY_UNAVAILABLE");
			try { record.v3SeatStateProjection = createManagedV3SeatStateProjection({ key }); }
			catch (_) { key.fill(0); return failure("V3_SEAT_STATE_PROJECTION_UNAVAILABLE"); }
			key.fill(0);
		}
		const previousSequence = record.v3SeatStateSequences.get(input.recipientSeatId) || 0;
		const previousGeneration = record.v3SeatStateGenerations.get(input.recipientSeatId) || 0;
		const nextSequence = input.stateSequence === undefined ? previousSequence + 1 : input.stateSequence;
		const isNextLogicalState = nextSequence === previousSequence + 1;
		const isFreshGenerationProjection = nextSequence === previousSequence && binding.connectionGeneration > previousGeneration;
		if (!isNextLogicalState && !isFreshGenerationProjection) return failure("V3_SEAT_STATE_SEQUENCE_REJECTED");
		const projected = record.v3SeatStateProjection.project({ envelope: record.successorPreActionCaptureEnvelope,
			capture: record.successorPreActionCaptureResult, roomId, hostSessionId: record.sessionId, engineBuildId: record.engineBuildId,
			rootInstanceId: record.xingbeiAuthorityContext?.rootInstanceId, seatIds: record.seatIds,
			recipientSeatId: input.recipientSeatId, connectionGeneration: binding.connectionGeneration, stateSequence: nextSequence });
		let activeBinding = null, active = sessions.get(roomId), reauthorized = null;
		try {
			activeBinding = getCurrentSeatBinding(roomId, input.recipientSeatId);
			reauthorized = authorizeSeatStateRequest({ roomId, recipientSeatId: input.recipientSeatId, request: input.request });
		} catch (_) {}
		if (!projected.ok || active !== record || record.state !== "playable_probe" || !validBinding(activeBinding) ||
			!validBinding(reauthorized) || activeBinding.connectionGeneration !== binding.connectionGeneration ||
			reauthorized.connectionGeneration !== binding.connectionGeneration) return failure(projected.code || "V3_SEAT_STATE_SOURCE_STALE");
		record.v3SeatStateSequences.set(input.recipientSeatId, Math.max(previousSequence, nextSequence));
		record.v3SeatStateGenerations.set(input.recipientSeatId, binding.connectionGeneration);
		return Object.freeze({ ok: true, message: projected.message });
	}

	// Read-only review evidence assembled from already accepted manager state.
	// This is deliberately not consumed by validateAuthorityEvent/commitAuthorityEvent.
	function inspectEvent5ReviewEvidence(roomId) {
		const record = sessions.get(roomId);
		const candidate = record?.nativeNextSeatCandidate;
		const priorCapture = record?.privatePreActionCaptureCandidate;
		const successorCapture = record?.successorPreActionCaptureResult;
		const phaseOverProof = record?.privateAtomicCaptureFenceProofs?.get(2) || record?.privateAtomicCaptureFenceProofs?.get(1);
		if (!record || record.state !== "playable_probe" || record.authorityStateRevision !== 4 || record.nextAuthorityEventSequence !== 5 ||
			record.lastAuthorityEvent?.sequence !== 4 || !candidate || !priorCapture || !successorCapture || !phaseOverProof ||
			phaseOverProof.phaseOver?.kind !== "native_phase_over_dispatch_v1" || !record.nativePhaseBoundaryReleaseSent ||
			candidate.roomId !== record.roomId || candidate.hostSessionId !== record.sessionId || candidate.rootInstanceId !== record.xingbeiAuthorityContext?.rootInstanceId ||
			candidate.engineBuildId !== record.engineBuildId || !record.seatIds.includes(candidate.seatId) ||
			candidate.previousActorSeatId !== record.acceptedNativeActionSeatId || candidate.seatId === record.acceptedNativeActionSeatId ||
			successorCapture.nativeEventId !== candidate.nativeEventId || successorCapture.seatId !== candidate.seatId) return null;
		let binding;
		try { binding = getCurrentSeatBinding(roomId, candidate.seatId); } catch (_) { return null; }
		if (!binding || binding.roomId !== roomId || binding.seatId !== candidate.seatId || binding.connected !== true || binding.current !== true ||
			binding.credentialAuthenticated !== true || binding.ordinaryPlayer !== true || !Number.isSafeInteger(binding.connectionGeneration) ||
			binding.connectionGeneration < 1 || !Array.isArray(candidate.options) || !candidate.options.length) return null;
		return Object.freeze({ schema: "managed_event5_review_observation_v1", reviewOnly: true, event5Accepted: false,
			submissionEnabled: false, authorityRevision: record.authorityStateRevision, nextAuthorityEventSequence: record.nextAuthorityEventSequence,
			seedAuthorized: false, checkpointAvailable: false, roomId: record.roomId, hostSessionId: record.sessionId,
			engineBuildId: record.engineBuildId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId,
			seatIds: Object.freeze([...record.seatIds]), predecessorDigest: record.authorityStateDigest,
			predecessorDigestDomain: "xingbei_authority_state_v2",
			phaseBoundaryReleased: true, phaseOverCompleted: true, phaseOverCompletionOrdinal: phaseOverProof.phaseOver.phaseCompletionOrdinal,
			priorSeatId: record.acceptedNativeActionSeatId, nextSeatId: candidate.seatId,
			successorNativeEventId: candidate.nativeEventId, successorCaptureSchema: successorCapture.schema,
			nativeCompletionOrdinal: successorCapture.nativeCompletionOrdinal,
			preActionCaptureOrdinal: priorCapture.captureOrdinal, nextInputWaiting: true, choiceAllocated: false,
			nativeDeliveryAllowed: false, authoritySubmissionAllowed: false,
			connectionGeneration: binding.connectionGeneration, connectionAuthenticated: true, ordinaryPlayer: true,
			optionKinds: Object.freeze([...new Set(Object.values(candidate.optionKinds))].sort()) });
	}

	function inspectEvent5CaptureProgress(roomId) {
		const record = sessions.get(roomId);
		if (!record || record.experimentalAuthorityEventLimit !== 5 ||
			process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "5" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1") return null;
		return record.experimentalEvent5CaptureProgress ? Object.freeze({ ...record.experimentalEvent5CaptureProgress,
			postCaptureStarted: record.experimentalEvent5PostCaptureStarted,
			postCaptureAccepted: Boolean(record.experimentalEvent5PostCapture),
			postCaptureCommitment: record.experimentalEvent5PostCapture?.commitment || null,
			atomicCaptureCount: record.experimentalEvent5CaptureProgress.atomicCaptureCount ?? record.privateAtomicCaptureCount,
			authorityRevision: record.authorityStateRevision }) : null;
	}

	async function releaseNativePhaseBoundary(roomId, input) {
		const record = sessions.get(roomId);
		const allowedKeys = ["nativeEventId", "rootInstanceId", "seatId"];
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
			!record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			record.authorityStateRevision !== 4 || record.nextAuthorityEventSequence !== 5 ||
			record.lastAuthorityEvent?.sequence !== 4 || !["gongJiOrFaShu", "jiRi_moBaoChongJie"].includes(record.lastAuthorityEvent?.name) ||
			!record.acceptedNativeActionProofDigest || !DIGEST.test(record.authorityStateDigest || "") ||
			record.nativePhaseBoundaryReleaseSent || !input || Object.getPrototypeOf(input) !== Object.prototype ||
			record.privateAtomicCaptureRequests.size !== 0 ||
			(process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE === "1" && record.privateAtomicCaptureCount < 1) ||
			Object.keys(input).sort().join(",") !== allowedKeys.sort().join(",") ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(input.nativeEventId || "") ||
			!/^native_root_[A-Za-z0-9_-]{16,96}$/.test(input.rootInstanceId || "") || !record.seatIds.includes(input.seatId)) {
			return failure("NATIVE_PHASE_BOUNDARY_RELEASE_REJECTED");
		}
		if (input.nativeEventId !== record.acceptedNativeActionNativeEventId ||
			input.rootInstanceId !== record.acceptedNativeActionRootInstanceId ||
			input.seatId !== record.acceptedNativeActionSeatId) return failure("NATIVE_PHASE_BOUNDARY_RELEASE_REJECTED");
		record.nativePhaseBoundaryReleaseSent = true;
		try {
			await record.handle.sendHostCommand({ type: "host_native_phase_boundary_release", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret,
				nativeEventId: input.nativeEventId, rootInstanceId: input.rootInstanceId, seatId: input.seatId,
				eventSequence: 4, stateRevision: 4, afterDigest: record.authorityStateDigest });
			return Object.freeze({ ok: true, requested: true });
		} catch (_) {
			fail(record, "NATIVE_PHASE_BOUNDARY_RELEASE_FAILED");
			Promise.resolve(record.handle?.stop("native_phase_boundary_release_failed")).catch(() => {});
			return failure("NATIVE_PHASE_BOUNDARY_RELEASE_FAILED");
		}
	}

	async function resumeNativeInput(roomId, input) {
		const record = sessions.get(roomId);
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !["nativeEventId", "seatId", "optionId"].includes(key)) ||
			![input.nativeEventId, input.seatId, input.optionId].every(value => typeof value === "string" && value.length >= 1 && value.length <= 128)) {
			return failure("NATIVE_INPUT_RESUME_REJECTED");
		}
		try {
			await record.handle.sendHostCommand({ type: "host_native_input_resume", ...input });
			return Object.freeze({ ok: true });
		} catch (_) { return failure("NATIVE_INPUT_RESUME_REJECTED"); }
	}

	async function cancelNativeInput(roomId, input) {
		const record = sessions.get(roomId);
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !["nativeEventId", "seatId"].includes(key)) ||
			![input.nativeEventId, input.seatId].every(value => typeof value === "string" && value.length >= 1 && value.length <= 128)) return failure("NATIVE_INPUT_CANCEL_REJECTED");
		try {
			await record.handle.sendHostCommand({ type: "host_native_input_cancel", ...input });
			return Object.freeze({ ok: true });
		} catch (_) { return failure("NATIVE_INPUT_CANCEL_REJECTED"); }
	}

	return Object.freeze({
		start,
		markBrowserReady,
		markEngineReady,
		markGameReady,
		commitAuthorityEvent,
		commitAuthoritativeResult,
		sendChoiceDelivery,
		diagnoseNativeStart,
		snapshotNativeStart,
		snapshotNativeCardLedger,
		snapshotNativeEffectState,
		snapshotNativeAtomicCapture,
		snapshotNativePreActionCapture,
		snapshotSuccessorPreActionCapture,
		createV3SeatStateForRequest,
		inspectEvent5ReviewEvidence,
		inspectEvent5CaptureProgress,
		releaseNativePhaseBoundary,
		resumeNativeInput,
		cancelNativeInput,
		subscribeSessionEnd,
		subscribeLifecycle,
		stop,
		inspect: roomId => publicView(sessions.get(roomId)),
	});
}

module.exports = { createHostSessionManager, validateNativeEventLineage };
