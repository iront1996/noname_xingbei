"use strict";

const crypto = require("node:crypto");

const SCHEMA = "xingbei_native_private_effect_state_v1";
const MAX_SEATS = 8;
const MAX_CANONICAL_BYTES = 8192;
const MAX_SNAPSHOTS = 64;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const ROOT = /^native_root_[A-Za-z0-9_-]{16,96}$/;
const BUILD = /^[a-f0-9]{64}$/;
const SEAT_SKILLS = new Set(["yinYangZhanHuan"]);
const SEAT_MARKS = new Set(["guiHuo"]);

function fail(code) { throw new TypeError(code); }
function plain(value) { return Boolean(value && Object.getPrototypeOf(value) === Object.prototype); }

function canonicalize(value, depth = 0) {
	if (depth > 8) fail("NATIVE_EFFECT_STATE_TOO_DEEP");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
	if (Array.isArray(value)) {
		if (value.length > 128) fail("NATIVE_EFFECT_STATE_TOO_LARGE");
		return `[${value.map(item => canonicalize(item, depth + 1)).join(",")}]`;
	}
	if (plain(value)) {
		const keys = Object.keys(value).sort();
		if (keys.length > 32) fail("NATIVE_EFFECT_STATE_TOO_LARGE");
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
	}
	fail("NATIVE_EFFECT_STATE_VALUE_UNSUPPORTED");
}

function validateSnapshot(snapshot, expected) {
	if (!plain(snapshot) || Object.keys(snapshot).sort().join(",") !==
		"rootInstanceId,schema,seatIds,seats" || snapshot.schema !== SCHEMA || !ROOT.test(snapshot.rootInstanceId || "") ||
		!Array.isArray(snapshot.seatIds) || snapshot.seatIds.length < 2 || snapshot.seatIds.length > MAX_SEATS ||
		new Set(snapshot.seatIds).size !== snapshot.seatIds.length || snapshot.seatIds.some(id => !IDENTIFIER.test(id)) ||
		canonicalize(snapshot.seatIds) !== canonicalize(expected.seatIds) || !Array.isArray(snapshot.seats) ||
		snapshot.seats.length !== snapshot.seatIds.length) fail("NATIVE_EFFECT_STATE_SNAPSHOT_INVALID");
	const seen = new Set();
	const seats = snapshot.seats.map((seat, index) => {
		if (!plain(seat) || Object.keys(seat).sort().join(",") !== "guiHuo,seatId,skills" ||
			seat.seatId !== snapshot.seatIds[index] || seen.has(seat.seatId) || !Array.isArray(seat.skills) ||
			seat.skills.length > SEAT_SKILLS.size || !Number.isSafeInteger(seat.guiHuo) || seat.guiHuo < 0 || seat.guiHuo > 3) {
			fail("NATIVE_EFFECT_STATE_SEAT_INVALID");
		}
		seen.add(seat.seatId);
		let prior = "";
		const skills = seat.skills.map(row => {
			if (!plain(row) || Object.keys(row).sort().join(",") !== "id,present,source" ||
				!SEAT_SKILLS.has(row.id) || row.id <= prior || row.present !== true || row.source !== "native_hasSkill") {
				fail("NATIVE_EFFECT_STATE_SKILL_UNSUPPORTED");
			}
			prior = row.id;
			return Object.freeze({ id: row.id, present: true, source: row.source });
		});
		return Object.freeze({ seatId: seat.seatId, skills: Object.freeze(skills), marks: Object.freeze([
			Object.freeze({ id: "guiHuo", count: seat.guiHuo, source: "native_countZhiShiWu" }),
		]) });
	});
	const canonical = { schema: SCHEMA, schemaVersion: 1, roomId: expected.roomId, hostSessionId: expected.hostSessionId,
		engineBuildId: expected.engineBuildId, rootInstanceId: snapshot.rootInstanceId, seatIds: expected.seatIds, seats };
	const encoded = canonicalize(canonical);
	if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES) fail("NATIVE_EFFECT_STATE_TOO_LARGE");
	return { canonical, encoded };
}

function createManagedNativeEffectStateCommitment({ roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds, key }) {
	if (!IDENTIFIER.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(hostSessionId || "") || !BUILD.test(engineBuildId || "") ||
		!ROOT.test(rootInstanceId || "") || !Array.isArray(seatIds) || seatIds.length < 2 || seatIds.length > MAX_SEATS ||
		new Set(seatIds).size !== seatIds.length || seatIds.some(id => !IDENTIFIER.test(id)) || !Buffer.isBuffer(key) || key.length !== 32) {
		fail("NATIVE_EFFECT_STATE_CONFIG_INVALID");
	}
	const scope = Object.freeze({ schema: SCHEMA, schemaVersion: 1, roomId, hostSessionId, engineBuildId, rootInstanceId, seatIds: [...seatIds] });
	const derivedKey = crypto.createHmac("sha256", key).update("noname-xingbei/private-effect-state/v1\0", "utf8")
		.update(canonicalize(scope), "utf8").digest();
	let destroyed = false;
	let snapshotCount = 0;
	let lastEncodedDigest = null;
	return Object.freeze({
		commit(snapshot) {
			if (destroyed) fail("NATIVE_EFFECT_STATE_DESTROYED");
			if (snapshotCount >= MAX_SNAPSHOTS) fail("NATIVE_EFFECT_STATE_SNAPSHOT_LIMIT");
			if (snapshot?.rootInstanceId !== rootInstanceId) fail("NATIVE_EFFECT_STATE_ROOT_MISMATCH");
			const { encoded } = validateSnapshot(snapshot, scope);
			const preimage = `${canonicalize(scope)}\n${encoded}`;
			const commitment = crypto.createHmac("sha256", derivedKey).update(preimage, "utf8").digest("hex");
			const stateDigest = crypto.createHash("sha256").update(encoded, "utf8").digest("hex");
			const stable = lastEncodedDigest === stateDigest;
			lastEncodedDigest = stateDigest;
			snapshotCount++;
			return Object.freeze({ schema: "xingbei_native_private_effect_commitment_v1", schemaVersion: 1,
				snapshotOrdinal: snapshotCount, rootInstanceId, engineBuildId, commitment, stableWithPrevious: snapshotCount === 1 ? null : stable,
				checkpointAvailable: false });
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			derivedKey.fill(0);
			lastEncodedDigest = null;
		},
	});
}

module.exports = { MANAGED_NATIVE_EFFECT_STATE_SCHEMA: SCHEMA, createManagedNativeEffectStateCommitment,
	validateManagedNativeEffectStateSnapshot: validateSnapshot };
