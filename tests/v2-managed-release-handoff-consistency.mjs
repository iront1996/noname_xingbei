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
	const currentHandoff = handoff.split(/^## (?:Accepted|Current in-progress) batch:/m)[1]?.split("\n## ")[0] || "";
	const currentPlan = plan.split(/^## (?:Accepted|Current in-progress) batch:/m)[1]?.split("\n## ")[0] || "";
	assert.ok(currentHandoff.includes(verified.buildId), "handoff's latest batch must identify the verified lock build for this checkout");
	assert.ok(currentPlan.includes(verified.buildId), "plan's latest batch must identify the verified lock build for this checkout");
});
