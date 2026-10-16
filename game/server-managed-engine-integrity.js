"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "xingbei_managed_engine_source_manifest_v1";
const TRUST_CONTRACT = "xingbei_managed_native_trust_v1";
const RELEASE_LOCK_SCHEMA = "xingbei_managed_engine_release_lock_v1";
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const EXTENSIONS = new Set([".js", ".mjs", ".json"]);
const SOURCE_DIRECTORIES = Object.freeze(["card", "character", "game", "mode", "noname"]);
const SOURCE_FILES = Object.freeze(["noname.js"]);

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("MANAGED_ENGINE_MANIFEST_INVALID");
}

function digest(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function collectFiles(root, relative, entries, totals) {
	const absolute = path.join(root, relative);
	const details = fs.lstatSync(absolute);
	if (details.isSymbolicLink()) throw new TypeError("MANAGED_ENGINE_SOURCE_SYMLINK_REJECTED");
	if (details.isDirectory()) {
		for (const name of fs.readdirSync(absolute).sort()) {
			collectFiles(root, path.join(relative, name), entries, totals);
		}
		return;
	}
	if (!details.isFile() || !EXTENSIONS.has(path.extname(relative).toLowerCase())) return;
	if (entries.length >= MAX_FILES || details.size > MAX_FILE_BYTES || totals.bytes + details.size > MAX_TOTAL_BYTES) {
		throw new TypeError("MANAGED_ENGINE_SOURCE_LIMIT_EXCEEDED");
	}
	const bytes = fs.readFileSync(absolute);
	if (bytes.length !== details.size) throw new TypeError("MANAGED_ENGINE_SOURCE_CHANGED_DURING_SCAN");
	totals.bytes += bytes.length;
	entries.push(Object.freeze({ path: relative.split(path.sep).join("/"), size: bytes.length, sha256: digest(bytes) }));
}

function createManagedEngineSourceManifest(sourceRoot) {
	if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) throw new TypeError("MANAGED_ENGINE_SOURCE_ROOT_INVALID");
	if (fs.lstatSync(sourceRoot).isSymbolicLink()) throw new TypeError("MANAGED_ENGINE_SOURCE_SYMLINK_REJECTED");
	const root = fs.realpathSync(sourceRoot);
	const entries = [];
	const totals = { bytes: 0 };
	for (const relative of SOURCE_FILES) collectFiles(root, relative, entries, totals);
	for (const relative of SOURCE_DIRECTORIES) collectFiles(root, relative, entries, totals);
	entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	if (!entries.some(entry => entry.path === "mode/xingBei.js") ||
		!entries.some(entry => entry.path === "noname/game/index.js") || entries.length === 0) {
		throw new TypeError("MANAGED_ENGINE_SOURCE_INCOMPLETE");
	}
	const payload = { schema: SCHEMA, schemaVersion: 1, files: entries };
	const encoded = canonicalize(payload);
	return Object.freeze({ ...payload, buildId: digest(Buffer.from(encoded, "utf8")), fileCount: entries.length, totalBytes: totals.bytes });
}

function validateManagedEngineSourceManifest(manifest) {
	try {
		if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype || Object.keys(manifest).sort().join(",") !== "buildId,fileCount,files,schema,schemaVersion,totalBytes" ||
			manifest.schema !== SCHEMA || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) ||
			manifest.files.length < 3 || manifest.files.length > MAX_FILES ||
			!(/^[a-f0-9]{64}$/).test(manifest.buildId || "") || !Number.isSafeInteger(manifest.fileCount) ||
			manifest.fileCount !== manifest.files.length || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) return false;
		const files = [];
		let total = 0;
		let priorPath = "";
		for (const entry of manifest.files) {
			if (!entry || Object.getPrototypeOf(entry) !== Object.prototype || Object.keys(entry).sort().join(",") !== "path,sha256,size" ||
				typeof entry.path !== "string" || !/^(?:noname\.js|(?:card|character|game|mode|noname)\/[A-Za-z0-9_./-]+\.(?:js|mjs|json))$/.test(entry.path) ||
				entry.path.includes("..") || entry.path <= priorPath || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES ||
				!(/^[a-f0-9]{64}$/).test(entry.sha256 || "")) return false;
			priorPath = entry.path;
			total += entry.size;
			if (total > MAX_TOTAL_BYTES) return false;
			files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
		}
		if (manifest.totalBytes !== total) return false;
		if (!files.some(entry => entry.path === "mode/xingBei.js") || !files.some(entry => entry.path === "noname/game/index.js")) return false;
		const buildId = digest(Buffer.from(canonicalize({ schema: SCHEMA, schemaVersion: 1, files }), "utf8"));
		return buildId === manifest.buildId;
	} catch (_) {
		return false;
	}
}

function verifyManagedEngineSourceManifest(sourceRoot, expectedManifest) {
	if (!validateManagedEngineSourceManifest(expectedManifest)) return Object.freeze({ ok: false, code: "MANAGED_ENGINE_MANIFEST_INVALID" });
	let actual;
	try { actual = createManagedEngineSourceManifest(sourceRoot); }
	catch (_) { return Object.freeze({ ok: false, code: "MANAGED_ENGINE_SOURCE_UNAVAILABLE" }); }
	if (actual.buildId !== expectedManifest.buildId || canonicalize(actual.files) !== canonicalize(expectedManifest.files)) {
		return Object.freeze({ ok: false, code: "MANAGED_ENGINE_SOURCE_MISMATCH" });
	}
	return Object.freeze({ ok: true, buildId: actual.buildId, fileCount: actual.fileCount, totalBytes: actual.totalBytes });
}

function validateManagedEngineReleaseLock(lock) {
	return Boolean(lock && Object.getPrototypeOf(lock) === Object.prototype &&
		Object.keys(lock).sort().join(",") === "buildId,schema,schemaVersion" &&
		lock.schema === RELEASE_LOCK_SCHEMA && lock.schemaVersion === 1 &&
		/^[a-f0-9]{64}$/.test(lock.buildId || ""));
}

function verifyManagedEngineRelease(sourceRoot, lockPath) {
	if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) return Object.freeze({ ok: false, code: "MANAGED_ENGINE_SOURCE_ROOT_INVALID" });
	lockPath ||= path.resolve(sourceRoot, "managed-engine-release.json");
	let lock;
	try {
		const details = fs.lstatSync(lockPath);
		if (details.isSymbolicLink() || !details.isFile() || details.size > 1024) {
			return Object.freeze({ ok: false, code: "MANAGED_ENGINE_RELEASE_LOCK_INVALID" });
		}
		lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
	}
	catch (_) { return Object.freeze({ ok: false, code: "MANAGED_ENGINE_RELEASE_LOCK_UNAVAILABLE" }); }
	if (!validateManagedEngineReleaseLock(lock)) return Object.freeze({ ok: false, code: "MANAGED_ENGINE_RELEASE_LOCK_INVALID" });
	let actual;
	try { actual = createManagedEngineSourceManifest(sourceRoot); }
	catch (_) { return Object.freeze({ ok: false, code: "MANAGED_ENGINE_SOURCE_UNAVAILABLE" }); }
	if (actual.buildId !== lock.buildId) return Object.freeze({ ok: false, code: "MANAGED_ENGINE_RELEASE_MISMATCH" });
	return Object.freeze({ ok: true, buildId: actual.buildId, fileCount: actual.fileCount, totalBytes: actual.totalBytes, manifest: actual });
}

module.exports = {
	MANAGED_ENGINE_SOURCE_SCHEMA: SCHEMA,
	MANAGED_ENGINE_TRUST_CONTRACT: TRUST_CONTRACT,
	MANAGED_ENGINE_RELEASE_LOCK_SCHEMA: RELEASE_LOCK_SCHEMA,
	createManagedEngineSourceManifest,
	validateManagedEngineSourceManifest,
	verifyManagedEngineSourceManifest,
	validateManagedEngineReleaseLock,
	verifyManagedEngineRelease,
};
