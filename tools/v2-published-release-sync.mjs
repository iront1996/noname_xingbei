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
  changed: [], risky: [], safe: [], missingOptional: [], unverifiedOptional: [], verified: 0
};

async function remote(path, required) {
  const url = pub.originalWebsite + path.split("/").map(encodeURIComponent).join("/") +
    "?v2_publication=" + sentinel;
  for (let attempt = 0; attempt < 6; attempt++) {
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
      if (path.endsWith(".png") && content.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
        throw new Error("invalid published PNG " + path);
      if (/\.(?:jpg|jpeg)$/i.test(path) &&
          content.subarray(0, 3).toString("hex") !== "ffd8ff")
        throw new Error("invalid published JPEG " + path);
      return content;
    } catch (error) {
      const integrityError = /invalid|too large/.test(String(error));
      if (integrityError) throw error;
      if (attempt === 5) {
        if (!required) {
          // No verified bytes: preserve the prior candidate asset, record
          // a review hold, and never silently count it as parity PASS.
          report.unverifiedOptional.push({ path, reason: String(error).slice(0, 200) });
          report.risky.push("UNVERIFIED_OPTIONAL: " + path);
          return null;
        }
        throw error; // Required original scripts/extension entrypoints fail closed.
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, 900 * 2 ** attempt)));
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
// Also compare every tracked published WebP and every runtime extension asset.
// The Git tree remains the inventory authority: no discovery of executable
// content from an unreviewed remote directory listing.
const publishedFiles = execFileSync("git", ["ls-files", "-z", "--", "image", "theme", "extension"],
  { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).split("\0").filter(Boolean);
for (const path of publishedFiles) {
  if (/^(?:image|theme)\/.+\.webp$/i.test(path)) {
    tasks.push({ path, kind: "published-image", required: false });
  } else if (path.startsWith("extension/") &&
             pub.bundledExtensions.some(name => path.startsWith("extension/" + name + "/")) &&
             !/(?:^|\/)(?:README(?:\.md)?|LICENSE(?:\.md)?)$/i.test(path)) {
    const suffix = extname(path).toLowerCase();
    const kind = [".webp", ".png", ".jpg", ".jpeg"].includes(suffix) ?
      "published-image" : "published-extension";
    tasks.push({ path, kind, required: false });
  }
}
const seen = new Set();
const distinctTasks = tasks.filter(task => !seen.has(task.path) && seen.add(task.path));
if (distinctTasks.length > 1700) throw new Error("unreviewed public asset inventory size");
let cursor = 0;
const jobs = Array.from({ length: 4 }, async () => {
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
// A later --check must never erase risks discovered during --sync.
if (mode === "--sync") {
  writeFileSync("/tmp/v2-auto-sync/prepare-publication.json", JSON.stringify(report, null, 2));
}
const outcome = report.unverifiedOptional.length > 0 ? "INCOMPLETE_REVIEW_REQUIRED" : "PASS";
console.log("V2_OFFICIAL_PUBLICATION_" + (mode === "--sync" ? "SYNC" : "CHECK") + "_" + outcome,
  JSON.stringify({ verified: report.verified, changed: report.changed.length,
    risky: report.risky, safe: report.safe, omitted: report.missingOptional.length,
    unverified: report.unverifiedOptional.length, upstream: newUpstream }));
