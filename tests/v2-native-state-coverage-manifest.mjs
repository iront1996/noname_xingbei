import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../game/xingbei-native-state-coverage-v1.json", import.meta.url), "utf8"));

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
	assert.equal(manifest.families.find(family => family.id === "turn_and_action_quotas").status, "partial");
});
