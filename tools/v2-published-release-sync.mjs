#!/usr/bin/env node
/**
 * Synchronize the *published* original website on an isolated V2 candidate.
 * This does not push, deploy, change another version or contact the Hall.
 * Published scripts/extensions always require review if their bytes changed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { createHash } from "node:crypto";

const [mode, oldUpstream, newUpstream] = process.argv.slice(2);
if (!["--sync", "--check"].includes(mode) ||
    !/^[a-f0-9]{40}$/.test(oldUpstream || "") ||
    !/^[a-f0-9]{40}$/.test(newUpstream || "")) {
  throw new Error("Usage: v2-published-release-sync.mjs --sync|--check <old-sha> <new-sha>");
}
const pub = JSON.parse(readFileSync("ops/v2-official-publication.json", "utf8"));
assert.equal(pub.schemaVersion, 1);
const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
if (mode === "--sync") {
  assert.equal(process.env.V2_SYNC_DISPOSABLE, "1", "mutations are disposable candidate only");
  assert.match(branch, /^v2-sync-candidate-[a-f0-9]{12}(?:-[a-zA-Z0-9-]+)?$/, "wrong worktree");
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sentinel = newUpstream.slice(0, 12) + "-" + Date.now();
const report = {
  oldUpstream, newUpstream, source: pub.originalWebsite,
  changed: [], risky: [], safe: [], missingOptional: [], verified: 0
};

async function remote(path, required) {
  const url = pub.originalWebsite + path.split("/").map(encodeURIComponent).join("/") +
    "?v2_publication=" + sentinel;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25000) });
      if (response.status === 404 && !required) {
        report.missingOptional.push(path);
        return null;
      }
      if (!response.ok) throw new Error("HTTP " + response.status + " " + path);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 30 * 1024 * 1024) throw new Error("resource too large " + path);
      const content = Buffer.from(await response.arrayBuffer());
      if (!content.length || content.length > 30 * 1024 * 1024) throw new Error("invalid size " + path);
      if (path.endsWith(".webp") &&
          (content.toString("ascii", 0, 4) !== "RIFF" ||
           content.toString("ascii", 8, 12) !== "WEBP")) {
        throw new Error("invalid published WebP " + path);
      }
      return content;
    } catch (error) {
      if (attempt === 2 || /invalid|too large/.test(String(error))) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("unreachable " + path);
}
const tasks = pub.publishedTextOverlays.map(path => ({ path, kind: "published-source", required: true }));
for (const name of pub.bundledExtensions) {
  tasks.push({ path: "extension/" + name + "/extension.js", kind: "published-extension", required: true });
  for (const file of ["package.js", "info.json"]) {
    tasks.push({ path: "extension/" + name + "/" + file, kind: "published-extension", required: false });
  }
}
// Only mirror lossless/validated image assets corresponding to changed original images.
// Existing published-only WebP files are preserved by v2-upstream-sync.mjs.
const changedImagePaths = oldUpstream === newUpstream ? [] :
  execFileSync("git", ["diff", "--name-only", oldUpstream, newUpstream, "--", "image", "theme"],
    { encoding: "utf8" }).trim().split("\n").filter(Boolean);
for (const path of changedImagePaths) {
  if (path.endsWith(".png") && /^(image|theme)\//.test(path)) {
    tasks.push({ path: path.slice(0, -4) + ".webp", kind: "published-image", required: false });
  }
}
const seen = new Set();
const distinctTasks = tasks.filter(task => !seen.has(task.path) && seen.add(task.path));
let cursor = 0;
const jobs = Array.from({ length: 6 }, async () => {
  while (cursor < distinctTasks.length) {
    const task = distinctTasks[cursor++];
    const content = await remote(task.path, task.required);
    if (content === null) continue;
    report.verified++;
    const oldContent = existsSync(task.path) ? readFileSync(task.path) : null;
    if (oldContent && sha256(oldContent) === sha256(content)) continue;
    if (mode === "--check") throw new Error("published byte mismatch " + task.path);
    mkdirSync(dirname(task.path), { recursive: true });
    writeFileSync(task.path, content);
    const entry = { path: task.path, kind: task.kind, sha256: sha256(content), bytes: content.length };
    report.changed.push(entry);
    if (task.kind === "published-image") report.safe.push(task.path);
    else report.risky.push(task.path);
  }
});
await Promise.all(jobs);
mkdirSync("/tmp/v2-auto-sync", { recursive: true });
writeFileSync("/tmp/v2-auto-sync/publication.json", JSON.stringify(report, null, 2));
console.log("V2_OFFICIAL_PUBLICATION_" + (mode === "--sync" ? "SYNC" : "CHECK") + "_PASS",
  JSON.stringify({ verified: report.verified, changed: report.changed.length,
    risky: report.risky, safe: report.safe, omitted: report.missingOptional.length,
    upstream: newUpstream }));
