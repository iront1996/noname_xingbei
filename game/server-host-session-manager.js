"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { verifyManagedEngineRelease, MANAGED_ENGINE_TRUST_CONTRACT } = require("./server-managed-engine-integrity.js");
const { createManagedNativeEffectStateCommitment } = require("./server-managed-native-effect-state.js");
const { createManagedNativeAtomicCapture } = require("./server-managed-native-atomic-capture.js");
const { createManagedNativePreActionCapture } = require("./server-managed-native-preaction-capture.js");

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
	onSessionEnd = () => {},
} = {}) {
	if (typeof launch !== "function" || typeof engineSourceRoot !== "string" || !path.isAbsolute(engineSourceRoot) ||
		(engineReleaseLockPath !== undefined && (typeof engineReleaseLockPath !== "string" || !path.isAbsolute(engineReleaseLockPath))) || typeof randomBytes !== "function" ||
		!Number.isSafeInteger(browserReadyTimeoutMs) || browserReadyTimeoutMs < 100 || browserReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(engineReadyTimeoutMs) || engineReadyTimeoutMs < 100 || engineReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(gameReadyTimeoutMs) || gameReadyTimeoutMs < 100 || gameReadyTimeoutMs > 60000 ||
		typeof onAuthoritativeResult !== "function" || typeof onManagedChoiceMessage !== "function" ||
		typeof isManagedChoicePending !== "function" || typeof onSessionEnd !== "function") {
		throw new TypeError("HOST_SESSION_CONFIG_INVALID");
	}

	const sessions = new Map();
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
		try { onSessionEnd(Object.freeze({ roomId: record.roomId, sessionId: record.sessionId, state: record.state, code: record.failureCode })); } catch (_) {}
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
			nativePhaseBoundaryReleaseSent: false,
			authorityDigestChain: [],
			endNotified: false,
		};
		sessions.set(roomId, record);

		try {
			const handle = await launch(Object.freeze({
				kind: "host_session_bootstrap",
				protocol: PROTOCOL,
				trustContract: MANAGED_ENGINE_TRUST_CONTRACT,
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
					if (["xingbei_side_assignment_v1", "xingbei_character_selection_v1", "xingbei_opening_draw_v1", "xingbei_native_card_action_v1"].includes(message.proof?.event?.kind)) {
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
							captureOrdinal: result.captureOrdinal, stateDigest: result.stateDigest, commitment: result.commitment });
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
					else if (["host_choice_candidates", "host_choice_delivery_started", "host_choice_ack", "host_choice_diagnostic", "host_native_action_candidates", "host_native_response_candidates"].includes(message?.type) && authenticate(record, message)) {
						if (message.type === "host_native_action_candidates" && process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1") {
							const validOptions = Array.isArray(message.options) && message.options.length > 0 && message.options.length <= 64 &&
								new Set(message.options).size === message.options.length && message.options.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
								message.optionKinds && Object.getPrototypeOf(message.optionKinds) === Object.prototype &&
								Object.keys(message.optionKinds).sort().join(",") === [...message.options].sort().join(",") &&
								Object.values(message.optionKinds).every(kind => kind === "gongJi" || kind === "faShu");
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
							if (!ACTIVE_STATES.has(record.state)) return;
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
		if (message?.type === "host_authority_event" && authenticate(record, message) &&
			proof?.event?.kind === "xingbei_native_card_action_v1" && proof.eventSequence === 4 &&
			record.state === "playable_probe" && record.authorityStateRevision === 4 && record.nextAuthorityEventSequence === 5 &&
			record.lastAuthorityEvent?.sequence === 4 && record.acceptedNativeCardActionProofDigest) {
			try {
				const proofDigest = crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
				if (proofDigest === record.acceptedNativeCardActionProofDigest && proof.afterDigest === record.authorityStateDigest) {
					return Object.freeze({ ok: true, idempotent: true, session: publicView(record) });
				}
			} catch (_) { return failure("HOST_AUTHORITY_EVENT_REJECTED"); }
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
			return failure("HOST_AUTHORITY_EVENT_REJECTED");
		}
		record.authorityStateRevision = proof.stateRevisionAfter;
		record.authorityFailureReason = null;
		record.authorityStateDigest = proof.afterDigest;
		record.authorityDigestChain.push(Object.freeze({ eventSequence: proof.eventSequence,
			beforeDigest: proof.beforeDigest, afterDigest: proof.afterDigest }));
		if (record.authorityDigestChain.length > 8) record.authorityDigestChain.shift();
		record.nextAuthorityEventSequence++;
		record.lastAuthorityEvent = Object.freeze({ sequence: proof.eventSequence, name: proof.event.name });
		if (proof.event.kind === "xingbei_native_card_action_v1") {
			record.acceptedNativeCardActionProofDigest = crypto.createHash("sha256").update(canonicalize(proof)).digest("hex");
			record.acceptedNativeCardActionNativeEventId = proof.event.nativeEventId;
			record.acceptedNativeCardActionRootInstanceId = proof.event.rootInstanceId;
			record.acceptedNativeCardActionSeatId = proof.event.seatId;
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
		try {
			await record.handle.sendHostCommand(Object.freeze({ ...delivery, type: "host_choice_delivery", kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret }));
			return Object.freeze({ ok: true });
		} catch (_) { return failure("HOST_CHOICE_DELIVERY_REJECTED"); }
	}

	async function diagnoseNativeStart(roomId, mode = "native_start") {
		const record = sessions.get(roomId);
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe", "controlled_block", "managed_random_failure_probe"].includes(mode) ||
			!record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			(["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee"].includes(mode) && (record.authorityStateRevision !== 3 ||
				record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw"))) return failure("HOST_DIAGNOSTIC_COMMAND_REJECTED");
		try {
			await record.handle.sendHostCommand({ type: "host_native_start_diagnostic", mode, kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret });
			return Object.freeze({ ok: true });
		} catch (_) { return failure("HOST_DIAGNOSTIC_COMMAND_REJECTED"); }
	}

	async function snapshotNativeStart(roomId, mode = "managed_opening_root_action_event4") {
		const record = sessions.get(roomId);
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || mode !== "managed_opening_root_action_event4" ||
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
			record.lastAuthorityEvent?.sequence !== 4 || record.lastAuthorityEvent?.name !== "gongJiOrFaShu" ||
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
		if (process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE !== "1" || process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE !== "1" ||
			process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
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
				.catch(() => {
					const pending = record.privatePreActionCaptureRequests.get(requestId);
					if (!pending) return;
					record.privatePreActionCaptureRequests.delete(requestId);
					clearTimeout(pending.timer);
					pending.resolve(failure("NATIVE_PREACTION_CAPTURE_REQUEST_REJECTED"));
					if (ACTIVE_STATES.has(record.state)) {
						fail(record, "NATIVE_PREACTION_CAPTURE_REQUEST_REJECTED");
						Promise.resolve(record.handle?.stop("native_preaction_capture_request_failed")).catch(() => {});
					}
				});
		});
	}

	async function releaseNativePhaseBoundary(roomId, input) {
		const record = sessions.get(roomId);
		const allowedKeys = ["nativeEventId", "rootInstanceId", "seatId"];
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
			!record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			record.authorityStateRevision !== 4 || record.nextAuthorityEventSequence !== 5 ||
			record.lastAuthorityEvent?.sequence !== 4 || record.lastAuthorityEvent?.name !== "gongJiOrFaShu" ||
			!record.acceptedNativeCardActionProofDigest || !DIGEST.test(record.authorityStateDigest || "") ||
			record.nativePhaseBoundaryReleaseSent || !input || Object.getPrototypeOf(input) !== Object.prototype ||
			record.privateAtomicCaptureRequests.size !== 0 ||
			(process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE === "1" && record.privateAtomicCaptureCount < 1) ||
			Object.keys(input).sort().join(",") !== allowedKeys.sort().join(",") ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(input.nativeEventId || "") ||
			!/^native_root_[A-Za-z0-9_-]{16,96}$/.test(input.rootInstanceId || "") || !record.seatIds.includes(input.seatId)) {
			return failure("NATIVE_PHASE_BOUNDARY_RELEASE_REJECTED");
		}
		if (input.nativeEventId !== record.acceptedNativeCardActionNativeEventId ||
			input.rootInstanceId !== record.acceptedNativeCardActionRootInstanceId ||
			input.seatId !== record.acceptedNativeCardActionSeatId) return failure("NATIVE_PHASE_BOUNDARY_RELEASE_REJECTED");
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
		releaseNativePhaseBoundary,
		resumeNativeInput,
		cancelNativeInput,
		stop,
		inspect: roomId => publicView(sessions.get(roomId)),
	});
}

module.exports = { createHostSessionManager };
