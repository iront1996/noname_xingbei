"use strict";

// Common submission preflight for the isolated Event #5-#8 action loop.
// This intentionally does not validate native game semantics or accept an
// event: every caller must still run the matching event-specific validator.
const CONTRACTS = Object.freeze({
	xingbei_native_successor_card_action_v1: 5,
	xingbei_native_successor_card_action_v2: 6,
	xingbei_native_successor_card_action_v3: 7,
	xingbei_native_successor_card_action_v4: 8,
});
const DIGEST = /^[a-f0-9]{64}$/;
const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^hs_[a-f0-9]{32}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;

function reject(code) { return Object.freeze({ ok: false, code }); }

function prepareManagedAuthorityAction({ record, proof, authenticated, experimentalEnabled } = {}) {
	const kind = proof?.event?.kind;
	const expectedSequence = CONTRACTS[kind];
	if (!expectedSequence) return reject("AUTHORITY_ACTION_KIND_UNSUPPORTED");
	if (authenticated !== true) return reject("AUTHORITY_ACTION_IDENTITY_REJECTED");
	if (experimentalEnabled !== true) return reject("AUTHORITY_ACTION_EXPERIMENTAL_CAPABILITY_REQUIRED");
	if (!record || !ROOM.test(record.roomId || "") || !SESSION.test(record.sessionId || "") ||
		!ROOT.test(record.xingbeiAuthorityContext?.rootInstanceId || "") || record.state !== "playable_probe") {
		return reject("AUTHORITY_ACTION_SESSION_CONTEXT_REJECTED");
	}
	if (!Number.isSafeInteger(record.experimentalAuthorityEventLimit) || record.experimentalAuthorityEventLimit < expectedSequence ||
		record.experimentalAuthorityEventLimit > 8 || proof.eventSequence !== expectedSequence ||
		record.authorityStateRevision !== expectedSequence - 1 || record.nextAuthorityEventSequence !== expectedSequence ||
		record.lastAuthorityEvent?.sequence !== expectedSequence - 1) return reject("AUTHORITY_ACTION_CEILING_OR_SEQUENCE_REJECTED");
	if (proof.kind !== "native_authority_event_v1" || proof.checkpoint !== null ||
		proof.stateRevisionBefore !== record.authorityStateRevision || proof.stateRevisionAfter !== record.authorityStateRevision + 1 ||
		!DIGEST.test(proof.beforeDigest || "") || !DIGEST.test(proof.afterDigest || "") || proof.beforeDigest === proof.afterDigest ||
		!DIGEST.test(record.authorityStateDigest || "") || proof.beforeDigest !== record.authorityStateDigest) {
		return reject("AUTHORITY_ACTION_PREDECESSOR_REJECTED");
	}
	return Object.freeze({ ok: true, eventSequence: expectedSequence, eventKind: kind,
		roomId: record.roomId, hostSessionId: record.sessionId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId,
		beforeDigest: proof.beforeDigest, afterDigest: proof.afterDigest, eventSpecificValidationRequired: true });
}

module.exports = { prepareManagedAuthorityAction };
