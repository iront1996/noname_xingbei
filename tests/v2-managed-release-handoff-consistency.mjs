import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyManagedEngineRelease } = require("../game/server-managed-engine-integrity.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("handoff and plan report the release lock's verified managed source build", async () => {
	const verified = verifyManagedEngineRelease(root);
	assert.equal(verified.ok, true, verified.code);
	const [handoff, plan] = await Promise.all([
		readFile(path.join(root, "docs/V2_CODEX_HANDOFF.md"), "utf8"),
		readFile(path.join(root, "docs/V2_SERVER_AUTHORITY_PLAN.md"), "utf8"),
	]);
	const currentHandoff = handoff.split("## Current in-progress batch:")[1]?.split("\n## ")[0] || "";
	const currentPlan = plan.split("## Current in-progress batch:")[1]?.split("\n## ")[0] || "";
	const match = currentHandoff.match(/release lock was recomputed and verified as `([a-f0-9]{64})`/i);
	assert.ok(match, "handoff must identify the verified lock build");
	assert.equal(match[1], verified.buildId);
	assert.ok(currentPlan.includes(`Release lock verifies as \`${verified.buildId}\``), "plan current batch must agree with the verified lock build");
});
