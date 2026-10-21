import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
	createManagedEngineSourceManifest,
	validateManagedEngineSourceManifest,
	verifyManagedEngineSourceManifest,
	MANAGED_ENGINE_RELEASE_LOCK_SCHEMA,
	validateManagedEngineReleaseLock,
	verifyManagedEngineRelease,
} = require("../game/server-managed-engine-integrity.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sourceTree(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), "managed-engine-manifest-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const file of ["noname.js", "mode/xingBei.js", "noname/game/index.js", "card/pack.js", "character/pack.js", "game/package.js"]) {
		const absolute = path.join(root, file);
		await mkdir(path.dirname(absolute), { recursive: true });
		await writeFile(absolute, `// ${file}\n`, "utf8");
	}
	return root;
}

test("managed engine manifest is deterministic and binds all selected native source files", async t => {
	const root = await sourceTree(t);
	const first = createManagedEngineSourceManifest(root);
	const second = createManagedEngineSourceManifest(root);
	assert.equal(first.buildId, second.buildId);
	assert.equal(first.schema, "xingbei_managed_engine_source_manifest_v1");
	assert.equal(first.schemaVersion, 1);
	assert.equal(first.fileCount, 6);
	assert.equal(validateManagedEngineSourceManifest(first), true);
	assert.equal(verifyManagedEngineSourceManifest(root, first).ok, true);
	assert.equal(first.files.some(entry => entry.path === "mode/xingBei.js"), true);
	assert.equal(first.files.some(entry => entry.path === "noname/game/index.js"), true);
});

test("managed engine source identity is stable across LF and CRLF working trees", async t => {
	const lfRoot = await sourceTree(t);
	const crlfRoot = await sourceTree(t);
	const lfManifest = createManagedEngineSourceManifest(lfRoot);
	for (const entry of lfManifest.files) {
		const absolute = path.join(crlfRoot, entry.path);
		const text = await readFile(absolute, "utf8");
		await writeFile(absolute, text.replace(/\r?\n/g, "\r\n"), "utf8");
	}
	const crlfManifest = createManagedEngineSourceManifest(crlfRoot);
	assert.equal(crlfManifest.buildId, lfManifest.buildId);
	assert.equal(verifyManagedEngineSourceManifest(crlfRoot, lfManifest).ok, true);
});

test("native source changes produce a different content-addressed build identity", async t => {
	const root = await sourceTree(t);
	const before = createManagedEngineSourceManifest(root);
	await writeFile(path.join(root, "mode/xingBei.js"), "// changed native rule source\n", "utf8");
	const after = createManagedEngineSourceManifest(root);
	assert.notEqual(after.buildId, before.buildId);
	assert.equal(verifyManagedEngineSourceManifest(root, before).code, "MANAGED_ENGINE_SOURCE_MISMATCH");
});

test("managed engine release lock pins the native source tree and fails closed on mismatch", async t => {
	const root = await sourceTree(t);
	const manifest = createManagedEngineSourceManifest(root);
	const lockPath = path.join(root, "managed-engine-release.json");
	const lock = { schema: MANAGED_ENGINE_RELEASE_LOCK_SCHEMA, schemaVersion: 1, buildId: manifest.buildId };
	assert.equal(validateManagedEngineReleaseLock(lock), true);
	await writeFile(lockPath, JSON.stringify(lock), "utf8");
	const verified = verifyManagedEngineRelease(root, lockPath);
	assert.equal(verified.ok, true);
	assert.equal(verified.manifest.buildId, manifest.buildId);
	await writeFile(lockPath, JSON.stringify({ ...lock, buildId: "0".repeat(64) }), "utf8");
	assert.deepEqual(verifyManagedEngineRelease(root, lockPath), { ok: false, code: "MANAGED_ENGINE_RELEASE_MISMATCH" });
	await writeFile(lockPath, JSON.stringify({ ...lock, schemaVersion: 2 }), "utf8");
	assert.deepEqual(verifyManagedEngineRelease(root, lockPath), { ok: false, code: "MANAGED_ENGINE_RELEASE_LOCK_INVALID" });
	await writeFile(lockPath, "x".repeat(1025), "utf8");
	assert.deepEqual(verifyManagedEngineRelease(root, lockPath), { ok: false, code: "MANAGED_ENGINE_RELEASE_LOCK_INVALID" });
	assert.equal(verifyManagedEngineRelease(root, path.join(root, "missing.json")).code, "MANAGED_ENGINE_RELEASE_LOCK_UNAVAILABLE");
	assert.equal(verifyManagedEngineRelease("relative-root", lockPath).code, "MANAGED_ENGINE_SOURCE_ROOT_INVALID");
});

test("manifest rejects unknown paths, unsorted entries, and altered digest", async t => {
	const root = await sourceTree(t);
	const manifest = createManagedEngineSourceManifest(root);
	assert.equal(validateManagedEngineSourceManifest({ ...manifest, buildId: "0".repeat(64) }), false);
	assert.equal(validateManagedEngineSourceManifest({ ...manifest, files: [{ ...manifest.files[0], path: "extension/untrusted.js" }, ...manifest.files.slice(1)] }), false);
	assert.equal(validateManagedEngineSourceManifest({ ...manifest, files: [...manifest.files].reverse() }), false);
});

test("manifest source scan rejects symlinked executable sources", async t => {
	const root = await sourceTree(t);
	const outside = path.join(root, "outside.js");
	await writeFile(outside, "// outside\n", "utf8");
	const link = path.join(root, "mode", "linked.js");
	try {
		await symlink(outside, link);
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
			t.skip(`symlink creation unavailable: ${error.code}`);
			return;
		}
		throw error;
	}
	assert.throws(() => createManagedEngineSourceManifest(root), { message: "MANAGED_ENGINE_SOURCE_SYMLINK_REJECTED" });
});

test("checked-in Xingbei engine tree has a bounded manifest without exposing file contents", async () => {
	const manifest = createManagedEngineSourceManifest(repoRoot);
	assert.equal(validateManagedEngineSourceManifest(manifest), true);
	assert.ok(manifest.fileCount > 100);
	assert.ok(manifest.totalBytes > 1_000_000);
	assert.equal(Object.keys(manifest).sort().join(","), "buildId,fileCount,files,schema,schemaVersion,totalBytes");
	assert.equal(JSON.stringify(manifest).includes("secret"), false);
});
