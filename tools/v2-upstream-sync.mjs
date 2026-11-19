#!/usr/bin/env node
/**
 * V2 upstream inheritance engine.
 *
 * Only the original game's mode/connect.js is overlaid (V2-HALL default and
 * image preload). All other upstream game files are taken byte-for-byte.
 * Always fail closed on unexpected V2-only files, changed anchors or history
 * rewrites. Run --prepare ONLY in a disposable v2-sync-candidate-* branch.
 *
 * --prepare <upstream-sha>  prepare two local commits; never push/deploy
 * --verify  <upstream-sha>  read-only full-tree and overlay verification
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownRoot = "https://github.com/iront1996/noname_xingbei";
const upstreamName = "RancherJie/noname_xingbei";
const upstreamBranch = "master";
const stateFile = "ops/v2-sync-state.json";
const patchFile = "tools/v2-connect-overlay.patch";
const publication = JSON.parse(readFileSync(join(root, "ops/v2-official-publication.json"), "utf8"));
assert.equal(publication.schemaVersion, 1);
const officialOverlay = new Set(publication.publishedTextOverlays);
const publishedOnly = new Set(publication.publishedOnlyFiles ?? []);
assert.deepEqual([...publishedOnly].sort(), ["layout/mode/tutorial.css", "mode/tutorial-scene.js"]);
for (const path of publishedOnly) assert.ok(officialOverlay.has(path), "published-only file not in verified release inventory: " + path);
const extensionPrefixes = publication.bundledExtensions.map(name => `extension/${name}/`);
const isOfficialExtension = path => extensionPrefixes.some(prefix => path.startsWith(prefix));
const isOfficialExtraImage = path =>
  /^(?:image|theme)\/.+\.(?:webp|avif)$/i.test(path);
const isPublishedException = path => officialOverlay.has(path) || isOfficialExtension(path) || isOfficialExtraImage(path);
const protectedExact = new Set([
  "mode/connect.js",
  "game/preload-images.mjs",
  "game/preload-manifest.json",
  "game/v2-preload-gate.mjs",
  "xingbei-image-sw.js",
  "tools/sync-image-manifest.mjs"
]);
const protectedPrefixes = [".github/", "tests/", "tools/v2-", "ops/v2-"];
const isOwned = path => protectedExact.has(path) || protectedPrefixes.some(p => path.startsWith(p));

/**
 * The trigger may use the legacy SHA-only name or an hourly UTC suffix.
 * Keep the SHA bound to the actual checked-out upstream revision.
 * Also used by the workflow preflight to eliminate split validation policy.
 */
function assertCandidateBranch(branch, upstreamSha) {
  assert.match(upstreamSha, /^[0-9a-f]{40}$/, "invalid upstream SHA");
  const base = "v2-sync-candidate-" + upstreamSha.slice(0, 12);
  const allowed = branch === base || new RegExp("^" + base + "-20[0-9]{8}$").test(branch);
  assert.ok(allowed, "refuse changes outside disposable V2 candidate: " + branch);
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options }).trim();
}
function tracked(ref) {
  const raw = execFileSync("git", ["ls-tree", "-r", "-z", ref], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const entries = new Map();
  for (const line of raw.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(line);
    assert.ok(match, "unrecognized Git tree entry");
    assert.ok(!entries.has(match[4]), "duplicate Git pathname");
    assert.equal(match[2], "blob", "unexpected Git submodule entry: " + match[4]);
    assert.equal(match[1], "100644", "only standard tracked game files supported: " + match[4]);
    entries.set(match[4], match[3]);
  }
  return entries;
}
function expectedConnect(source, patch = patchFile) {
  const scratch = mkdtempSync(join(tmpdir(), "v2-connect-overlay-"));
  try {
    mkdirSync(join(scratch, "mode"), { recursive: true });
    writeFileSync(join(scratch, "mode/connect.js"), source);
    execFileSync("git", ["apply", "--check", resolve(root, patch)], { cwd: scratch, stdio: "pipe" });
    execFileSync("git", ["apply", resolve(root, patch)], { cwd: scratch, stdio: "pipe" });
    return readFileSync(join(scratch, "mode/connect.js"), "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function currentState() {
  const state = JSON.parse(readFileSync(join(root, stateFile), "utf8"));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.upstream.repository, upstreamName);
  assert.equal(state.upstream.branch, upstreamBranch);
  assert.match(state.upstream.sha, /^[0-9a-f]{40}$/);
  return state;
}
function verify(upstreamSha) {
  assert.match(upstreamSha, /^[0-9a-f]{40}$/);
  const state = currentState();
  assert.equal(state.upstream.sha, upstreamSha, "pinned upstream SHA must match");
  const theirs = tracked(upstreamSha);
  const ours = tracked("HEAD");
  for (const [path, sha] of theirs) {
    if (isOwned(path)) continue;
    if (officialOverlay.has(path)) {
      assert.ok(ours.has(path), "missing official published overlay: " + path);
      continue;
    }
    assert.equal(ours.get(path), sha, "original game differs from upstream: " + path);
  }
  for (const [path] of ours) {
    if (isOwned(path)) continue;
    assert.ok(theirs.has(path) || isPublishedException(path), "unapproved V2-only game file: " + path);
  }
  const original = git(["show", upstreamSha + ":mode/connect.js"]);
  const expected = expectedConnect(original + "\n");
  const actual = readFileSync(join(root, "mode/connect.js"), "utf8");
  assert.equal(actual, expected, "V2 connect overlay differs from pinned original + two features");
  for (const path of publication.publishedTextOverlays) {
    // The original's publicly deployed rule tutorial includes two files that
    // are absent from its current master tree. Allow *only* these explicitly
    // inventoried files, never arbitrary remote runtime code.
    if (publishedOnly.has(path)) {
      assert.ok(!theirs.has(path), "published-only file entered original Git; provenance review required: " + path);
    } else {
      assert.ok(theirs.has(path), "original Git source unexpectedly absent: " + path);
    }
    assert.ok(ours.has(path), "missing required published original: " + path);
  }
  for (const name of publication.bundledExtensions) {
    assert.ok(ours.has(`extension/${name}/extension.js`), "missing official bundled extension: " + name);
  }
  const gate = readFileSync(join(root, "game/v2-preload-gate.mjs"), "utf8");
  assert.ok(gate.includes("prepareImageAssets") && gate.includes("ensureImageCacheWorker"));
  assert.ok(actual.includes("wss://v2-hall-direct.myxingbei.com:50000"));
  assert.ok(actual.includes('get.config("read_clipboard", "connect")'));
  assert.ok(actual.includes("await ensureV2Images()"));
  assert.ok(!actual.includes('config.set("mode", "connect")'));
  console.log("V2_UPSTREAM_PARITY_PASS", JSON.stringify({ upstreamSha, files: theirs.size, twoV2Features: true, publishedOverlays: officialOverlay.size, bundledExtensions: publication.bundledExtensions.length }));
}
function prepare(upstreamSha) {
  assert.match(upstreamSha, /^[0-9a-f]{40}$/);
  assert.equal(process.env.V2_SYNC_DISPOSABLE, "1", "requires explicit disposable-worktree opt-in");
  const branch = git(["branch", "--show-current"]);
  assertCandidateBranch(branch, upstreamSha);
  assert.equal(git(["status", "--porcelain"]), "", "worktree must be clean");
  const oldHead = git(["rev-parse", "HEAD"]);
  const state = currentState();
  verify(state.upstream.sha);
  if (state.upstream.sha === upstreamSha) {
    // The original *published* site can update independently of its Git master.
    execFileSync(process.execPath, [
      join(root, "tools/v2-published-release-sync.mjs"), "--sync", upstreamSha, upstreamSha
    ], { cwd: root, stdio: "inherit" });
    git(["add", "--all"]);
    if (!git(["diff", "--cached", "--name-only"])) {
      // This branch is unchanged in content; only the disposable trigger commit exists.
      console.log("V2_PUBLICATION_UNCHANGED", upstreamSha);
      return;
    }
    git(["commit", "-m", "sync(v2): reconcile original published resources " + upstreamSha.slice(0, 12)]);
    execFileSync(process.execPath, [join(root, "tools/sync-image-manifest.mjs"), "--write"], { cwd: root, stdio: "inherit" });
    git(["add", "game/preload-manifest.json"]);
    if (git(["diff", "--cached", "--name-only"])) {
      git(["commit", "-m", "build(v2): update published image manifest"]);
    }
    verify(upstreamSha);
    assert.equal(git(["status", "--porcelain"]), "");
    console.log("V2_PUBLICATION_CANDIDATE_READY", git(["rev-parse", "HEAD"]));
    return;
  }
  const ff = spawnSync("git", ["merge-base", "--is-ancestor", state.upstream.sha, upstreamSha], { cwd: root });
  assert.equal(ff.status, 0, "upstream was rewritten or diverged; manual review required");
  const originalTree = tracked(upstreamSha);
  const oldTree = tracked("HEAD");
  assert.ok(originalTree.has("mode/connect.js") && originalTree.has("noname/init/index.js"));
  assert.ok(oldTree.has(patchFile) && oldTree.has("game/v2-preload-gate.mjs"), "V2 patch missing");
  for (const path of originalTree.keys()) {
    if (isOwned(path) && !oldTree.has(path)) {
      // Do not inherit arbitrary upstream CI or files that collide with V2-owned paths.
      console.log("V2_REJECT_UPSTREAM_RESERVED_PATH", path);
      throw new Error("upstream added a V2-reserved pathname");
    }
  }
  for (const path of oldTree.keys()) {
    assert.ok(isOwned(path) || originalTree.has(path) || isPublishedException(path), "unapproved V2 drift: " + path);
  }
  for (const path of officialOverlay) {
    if (publishedOnly.has(path)) {
      assert.ok(!originalTree.has(path), "published-only tutorial entered upstream: requires provenance re-review " + path);
    } else {
      assert.ok(originalTree.has(path), "upstream removed an audited official published overlay: " + path);
    }
  }
  for (const path of originalTree.keys()) {
    if (isOfficialExtension(path) && !oldTree.has(path)) {
      throw new Error("upstream introduced collision with released extension " + path);
    }
  }
  const overlay = readFileSync(join(root, patchFile), "utf8");
  const upstreamConnect = git(["show", upstreamSha + ":mode/connect.js"]) + "\n";
  const nextConnect = expectedConnect(upstreamConnect);
  assert.ok(overlay.includes("v2-hall-direct.myxingbei.com:50000"));
  // Keep trusted V2-only files, tests, and workflows from the current branch.
  const kept = [...oldTree.keys()].filter(path =>
    isOwned(path) || officialOverlay.has(path) || isOfficialExtension(path) ||
    (isOfficialExtraImage(path) && !originalTree.has(path))
  );
  git(["read-tree", "--reset", "-u", upstreamSha]);
  for (let i = 0; i < kept.length; i += 100) {
    git(["restore", "--source", oldHead, "--staged", "--worktree", "--", ...kept.slice(i, i + 100)]);
  }
  writeFileSync(join(root, "mode/connect.js"), nextConnect);
  writeFileSync(join(root, stateFile), JSON.stringify({
    schemaVersion: 1,
    upstream: { repository: upstreamName, branch: upstreamBranch, sha: upstreamSha },
    previousUpstreamSha: state.upstream.sha
  }, null, 2) + "\n");
  // Reconcile the actual public release, not only GitHub's source tree.
  // All script, CSS and extension drift is review-gated by the workflow.
  execFileSync(process.execPath, [
    join(root, "tools/v2-published-release-sync.mjs"), "--sync", state.upstream.sha, upstreamSha
  ], { cwd: root, stdio: "inherit" });
  git(["add", "--all"]);
  git(["commit", "-m", "sync(v2): inherit published upstream " + upstreamSha.slice(0, 12) + " preserving V2 features"]);
  // The image manifest derives its version from HEAD:image and HEAD:theme.
  // Commit upstream content first, then regenerate and commit the manifest.
  execFileSync(process.execPath, [join(root, "tools/sync-image-manifest.mjs"), "--write"], { cwd: root, stdio: "inherit" });
  git(["add", "game/preload-manifest.json"]);
  if (git(["diff", "--cached", "--name-only"])) {
    git(["commit", "-m", "build(v2): refresh verified image manifest for upstream " + upstreamSha.slice(0, 12)]);
  }
  verify(upstreamSha);
  assert.equal(git(["status", "--porcelain"]), "", "must finish with clean candidate");
  console.log("V2_UPSTREAM_CANDIDATE_READY", JSON.stringify({
    upstreamSha, previousV2Head: oldHead, candidateHead: git(["rev-parse", "HEAD"])
  }));
}
const cmd = process.argv[2], upstreamSha = process.argv[3];
if (cmd === "--prepare" && upstreamSha) prepare(upstreamSha);
else if (cmd === "--verify" && upstreamSha) verify(upstreamSha);
else if (cmd === "--check-branch" && upstreamSha && process.argv[4]) {
  assertCandidateBranch(upstreamSha, process.argv[4]);
  console.log("V2_CANDIDATE_BRANCH_PASS", upstreamSha);
} else {
  console.error("Usage: node tools/v2-upstream-sync.mjs --prepare|--verify <upstream-sha> | --check-branch <candidate-branch> <upstream-sha>");
  process.exitCode = 2;
}
