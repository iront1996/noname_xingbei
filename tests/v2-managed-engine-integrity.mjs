import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("native source changes produce a different content-addressed build identity", async t => {
	const root = await sourceTree(t);
	const before = createManagedEngineSourceManifest(root);
	await writeFile(path.join(root, "mode/xingBei.js"), "// changed native rule source\n", "utf8");
	const after = createManagedEngineSourceManifest(root);
	assert.notEqual(after.buildId, before.buildId);
	assert.equal(verifyManagedEngineSourceManifest(root, before).code, "MANAGED_ENGINE_SOURCE_MISMATCH");
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
