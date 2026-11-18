#!/usr/bin/env node
/** Read-only V2 candidate branch contract regression, no Git or deploy writes. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const src = "tools/v2-upstream-sync.mjs";
const upstream = "27ad858dbeea5da35fc434cc226b0302792d2ba3";
const stem = "v2-sync-candidate-" + upstream.slice(0, 12);
const allowed = [
  stem,
  stem + "-2026111713",
  stem + "-2026111802",
  stem + "-2026111813"
];
const denied = [
  "master",
  "feature/image-preload-cache",
  "integration/v2-candidate-branch-fix-20261118",
  "v2-sync-candidate-abd687ff7237-2026111802", // wrong original commit
  stem + "-smoke",
  stem + "-202611180200", // minute timestamp is not authorized
  stem + "-20261118", // missing UTC hour
  stem + "-2026111802-extra",
  stem + "-2026111802/evil",
  stem + "-2026111802;echo",
  stem.toUpperCase(),
  "v2-sync-candidate-" + upstream + "-2026111802"
];
for (const candidate of allowed) {
  const result = spawnSync(process.execPath, [src, "--check-branch", candidate, upstream], { encoding: "utf8" });
  assert.equal(result.status, 0, "expected allowed candidate " + candidate + "\n" + result.stderr);
  assert.match(result.stdout, /V2_CANDIDATE_BRANCH_PASS/);
}
for (const candidate of denied) {
  const result = spawnSync(process.execPath, [src, "--check-branch", candidate, upstream], { encoding: "utf8" });
  assert.notEqual(result.status, 0, "unsafe candidate must not pass " + candidate);
}
const workflow = readFileSync(".github/workflows/v2-upstream-controlled-auto-sync.yml", "utf8");
assert.ok(workflow.includes('node tools/v2-upstream-sync.mjs --check-branch "$GITHUB_REF_NAME" "$upstream"'),
  "GitHub preflight and prepare must share the same validator");
assert.ok(workflow.includes('test "$(git rev-parse HEAD^)" = "$baseline"'),
  "candidate's sole parent must remain exactly the V2 production HEAD");
assert.ok(workflow.includes("HEAD^{tree}"),
  "candidate tree must equal V2 production tree");
assert.ok(workflow.includes("if: env.CHANGED == 'true' && env.RISKY == 'false'"),
  "high-risk changes must not auto-deploy");
assert.ok(workflow.includes("if: env.CHANGED == 'true' && env.RISKY == 'true'"),
  "gameplay/UI changes must enter review hold");
console.log("V2_CANDIDATE_BRANCH_CONTRACT_PASS", JSON.stringify({
  allowed: allowed.length, denied: denied.length,
  timestamped: stem + "-2026111802",
  upstream
}));
