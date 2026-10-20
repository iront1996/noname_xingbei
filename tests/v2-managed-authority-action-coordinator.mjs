import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { prepareManagedAuthorityAction } = require("../game/server-managed-authority-action-coordinator.js");
const digest = value => createHash("sha256").update(value).digest("hex");
const kinds = [null, null, null, null, null,
	"xingbei_native_successor_card_action_v1", "xingbei_native_successor_card_action_v2",
	"xingbei_native_successor_card_action_v3", "xingbei_native_successor_card_action_v4"];

function fixture(sequence) {
	const beforeDigest = digest(`before_${sequence}`);
	const record = { roomId: "room_action", sessionId: `hs_${"a".repeat(32)}`, state: "playable_probe",
		experimentalAuthorityEventLimit: sequence, authorityStateRevision: sequence - 1,
		nextAuthorityEventSequence: sequence, authorityStateDigest: beforeDigest,
		lastAuthorityEvent: { sequence: sequence - 1 }, xingbeiAuthorityContext: { rootInstanceId: `native_root_${"b".repeat(32)}` } };
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: sequence,
		stateRevisionBefore: sequence - 1, stateRevisionAfter: sequence, beforeDigest, afterDigest: digest(`after_${sequence}`),
		event: { kind: kinds[sequence] } };
	return { record, proof };
}

test("common action preflight supports only experimental Event #5-#8 and leaves semantics to strict validators", () => {
	for (let sequence = 5; sequence <= 8; sequence++) {
		const { record, proof } = fixture(sequence);
		assert.deepEqual(prepareManagedAuthorityAction({ record, proof, authenticated: true, experimentalEnabled: true }), {
			ok: true, eventSequence: sequence, eventKind: kinds[sequence], roomId: record.roomId,
			hostSessionId: record.sessionId, rootInstanceId: record.xingbeiAuthorityContext.rootInstanceId,
			beforeDigest: proof.beforeDigest, afterDigest: proof.afterDigest, eventSpecificValidationRequired: true });
	}
	assert.equal(prepareManagedAuthorityAction({ ...fixture(5), authenticated: true, experimentalEnabled: true }).eventSpecificValidationRequired, true);
});

test("common action preflight rejects untrusted, stale, skipped, wrong-kind and over-ceiling submissions", () => {
	let state = fixture(5);
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: false, experimentalEnabled: true }).code, "AUTHORITY_ACTION_IDENTITY_REJECTED");
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: true, experimentalEnabled: false }).code, "AUTHORITY_ACTION_EXPERIMENTAL_CAPABILITY_REQUIRED");
	state = fixture(6); state.record.experimentalAuthorityEventLimit = 5;
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: true, experimentalEnabled: true }).code, "AUTHORITY_ACTION_CEILING_OR_SEQUENCE_REJECTED");
	state = fixture(7); state.proof.eventSequence = 6;
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: true, experimentalEnabled: true }).code, "AUTHORITY_ACTION_CEILING_OR_SEQUENCE_REJECTED");
	state = fixture(8); state.proof.event.kind = "xingbei_native_successor_card_action_v9";
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: true, experimentalEnabled: true }).code, "AUTHORITY_ACTION_KIND_UNSUPPORTED");
	state = fixture(5); state.proof.beforeDigest = "f".repeat(64);
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: true, experimentalEnabled: true }).code, "AUTHORITY_ACTION_PREDECESSOR_REJECTED");
	state = fixture(5); state.proof.checkpoint = {};
	assert.equal(prepareManagedAuthorityAction({ ...state, authenticated: true, experimentalEnabled: true }).code, "AUTHORITY_ACTION_PREDECESSOR_REJECTED");
});
