import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../docs/xingbei-native-state-coverage-v1.json", import.meta.url), "utf8"));

test("native state coverage manifest cannot claim a seed or complete schema while unsupported families remain", () => {
	assert.equal(manifest.schema, "xingbei_native_state_coverage_v1");
	assert.equal(manifest.status, "incomplete");
	assert.equal(manifest.fullCanonicalStateEligible, false);
	assert.equal(manifest.seedAuthorized, false);
	assert.equal(manifest.authorityStateRevision, 4);
	assert.equal(manifest.event5Enabled, false);
	assert.equal(manifest.checkpointAvailable, false);
	assert.equal(manifest.unknownStatePolicy, "fail_closed");
	assert.ok(Array.isArray(manifest.families) && manifest.families.length >= 8);
	const ids = manifest.families.map(family => family.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const family of manifest.families) {
		assert.ok(["partial", "unsupported"].includes(family.status), `${family.id} must not silently become complete`);
		assert.ok(Array.isArray(family.nativeSources) && family.nativeSources.length > 0, `${family.id} must identify its source`);
		assert.ok(Array.isArray(family.unsupported) && family.unsupported.length > 0, `${family.id} must identify its gaps`);
		if (family.status === "unsupported") assert.equal(family.supportedBoundary, null);
	}
	assert.equal(manifest.families.find(family => family.id === "hujia").requiresNativeRuleChangeAuthorization, true);
	assert.equal(manifest.families.find(family => family.id === "dynamic_skills_storage_and_effects").status, "unsupported");
	const turn = manifest.families.find(family => family.id === "turn_and_action_quotas");
	assert.equal(turn.status, "partial");
	assert.match(turn.supportedBoundary, /two distinct completed native seat phases/);
	assert.deepEqual(turn.verifiedEvidence, {
		linuxCiRunId: "39061677334",
		workflowStep: 33,
		completedSeatCount: 2,
		acceptedCaptureCountIncludingStableRepeats: 4,
		nativeCompletionOrdinals: [112, 223],
		inputGateQuotaReset: {
			linuxCiRunId: "39063275363",
			workflowStep: "V2 M2 C3 authority Event 1-4 same-session and Chromium-chain audit",
			nativeEvent: "xingDong",
			nativeStep: 0,
			quotas: { gongJiOrFaShu: 1, faShu: 0, gongJi: 0, extraXingDongCount: 0 },
			actorBoundToPendingAction: true,
			observationIsAtomicCapture: false,
		},
		completedPhaseQuotaConsumption: {
			linuxCiRunId: "39063275363",
			workflowStep: "V2 M2 T3-B1 ledger plus restricted atomic capture across a real four-seat action",
			nativeCompletionOrdinal: 112,
			consumedQuotas: { gongJiOrFaShu: 0, faShu: 0, gongJi: 0 },
		},
		authorityStateRevision: 4,
		event5Enabled: false,
	});
	assert.match(turn.unsupported[0], /arbitrary multi-turn capture/);
	assert.match(turn.unsupported[2], /all quota reset\/decrement and round-boundary semantics/);
	assert.equal(turn.verifiedEvidence.inputGateQuotaReset.observationIsAtomicCapture, false,
		"live input-gate observation must not be misrepresented as an atomic canonical snapshot");
});
