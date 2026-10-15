"use strict";

const crypto = require("node:crypto");

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
	randomBytes = crypto.randomBytes,
	browserReadyTimeoutMs = 15000,
	engineReadyTimeoutMs = 15000,
	gameReadyTimeoutMs = 15000,
	onAuthoritativeResult = () => {},
	onManagedChoiceMessage = () => {},
	onSessionEnd = () => {},
} = {}) {
	if (typeof launch !== "function" || typeof randomBytes !== "function" ||
		!Number.isSafeInteger(browserReadyTimeoutMs) || browserReadyTimeoutMs < 100 || browserReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(engineReadyTimeoutMs) || engineReadyTimeoutMs < 100 || engineReadyTimeoutMs > 60000 ||
		!Number.isSafeInteger(gameReadyTimeoutMs) || gameReadyTimeoutMs < 100 || gameReadyTimeoutMs > 60000 ||
		typeof onAuthoritativeResult !== "function" || typeof onManagedChoiceMessage !== "function" || typeof onSessionEnd !== "function") {
		throw new TypeError("HOST_SESSION_CONFIG_INVALID");
	}

	const sessions = new Map();

	function publicView(record) {
		if (!record) return null;
		return Object.freeze({
			protocol: PROTOCOL,
			roomId: record.roomId,
			sessionId: record.sessionId,
			state: record.state,
			pid: record.pid,
			nextResultSequence: record.nextResultSequence,
			failureCode: record.failureCode,
			setupDigest: record.setupDigest,
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

	function finish(record, code) {
		clearPhaseTimer(record);
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

	async function start(roomId, gameSetup) {
		if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) {
			return failure("HOST_ROOM_ID_INVALID");
		}
		const existing = sessions.get(roomId);
		if (existing && ACTIVE_STATES.has(existing.state)) {
			return failure("HOST_SESSION_EXISTS");
		}
		let prepared;
		try {
			prepared = prepareGameSetup(gameSetup);
		} catch (_) {
			return failure("HOST_GAME_SETUP_INVALID");
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
			nextResultSequence: 1,
			failureCode: null,
			gameSetup: prepared.setup,
			setupDigest: prepared.digest,
			seatIds: prepared.seatIds,
			preGameSummaryDigest: null,
			authorityStateRevision: null,
			authorityStateDigest: null,
			nextAuthorityEventSequence: 1,
			lastAuthorityEvent: null,
			xingbeiAuthorityContext: null,
			acceptedNativeCardActionProofDigest: null,
			authorityDigestChain: [],
			endNotified: false,
		};
		sessions.set(roomId, record);

		try {
			const handle = await launch(Object.freeze({
				kind: "host_session_bootstrap",
				protocol: PROTOCOL,
				roomId,
				sessionId,
				secret,
				gameSetup: record.gameSetup,
				setupDigest: record.setupDigest,
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
					else if (message?.type === "authoritative_result") commitAuthoritativeResult(message);
					else if (["host_choice_candidates", "host_choice_ack", "host_choice_diagnostic", "host_native_action_candidates", "host_native_response_candidates"].includes(message?.type) && authenticate(record, message)) {
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
				if (!response || Object.keys(response).sort().join(",") !==
					"actionEventId,forced,kind,nativeEventId,optionId,rootInstanceId,seatId,sourceSeatId,targetSeatId,useCardChildrenCompleted,useCardChildrenStarted" ||
					response.actionEventId !== event.nativeEventId || response.rootInstanceId !== context.rootInstanceId ||
					!/^native_[A-Za-z0-9_-]{16,96}$/.test(response.nativeEventId || "") || responseEventIds.has(response.nativeEventId) ||
					!/^[A-Za-z0-9_-]{1,128}$/.test(response.seatId || "") || !record.seatIds.includes(response.seatId) ||
					!/^[A-Za-z0-9_-]{1,128}$/.test(response.sourceSeatId || "") || !record.seatIds.includes(response.sourceSeatId) ||
					response.seatId === response.sourceSeatId || !possibleSources.has(response.sourceSeatId) ||
					!/^native_option_[a-f0-9]{32}$/.test(response.optionId || "") || responseOptionIds.has(response.optionId) ||
					typeof response.forced !== "boolean" ||
					(response.kind === "card" ? !record.seatIds.includes(response.targetSeatId) || response.forced !== false ||
						response.useCardChildrenStarted !== 1 || response.useCardChildrenCompleted !== 1 :
						response.kind !== "decline" || response.targetSeatId !== null || response.forced !== false ||
						response.useCardChildrenStarted !== 0 || response.useCardChildrenCompleted !== 0)) return reject("CARD_ACTION_RESPONSE_EVIDENCE");
				responseEventIds.add(response.nativeEventId);
				responseOptionIds.add(response.optionId);
				if (response.kind === "card") {
					possibleSources.add(response.seatId);
					seatsWithCardConsumption.add(response.seatId);
					seatsTouchedByNativeCardTree.add(response.seatId);
					seatsTouchedByNativeCardTree.add(response.targetSeatId);
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
		if (message?.type !== "host_engine_ready" || !authenticate(record, message) || record.state !== "browser_ready") {
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
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "controlled_block"].includes(mode) ||
			!record || record.state !== "playable_probe" || !record.handle?.sendHostCommand ||
			(["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee"].includes(mode) && (record.authorityStateRevision !== 3 ||
				record.lastAuthorityEvent?.sequence !== 3 || record.lastAuthorityEvent?.name !== "gameDraw"))) return failure("HOST_DIAGNOSTIC_COMMAND_REJECTED");
		try {
			await record.handle.sendHostCommand({ type: "host_native_start_diagnostic", mode, kind: "managed_host", protocol: PROTOCOL,
				roomId: record.roomId, sessionId: record.sessionId, secret: record.secret });
			return Object.freeze({ ok: true });
		} catch (_) { return failure("HOST_DIAGNOSTIC_COMMAND_REJECTED"); }
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
		resumeNativeInput,
		cancelNativeInput,
		stop,
		inspect: roomId => publicView(sessions.get(roomId)),
	});
}

module.exports = { createHostSessionManager };
