import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { MANAGED_NATIVE_EFFECT_STATE_SCHEMA, createManagedNativeEffectStateCommitment } = require("../game/server-managed-native-effect-state.js");
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];
const rootInstanceId = `native_root_${"a".repeat(32)}`;
const engineBuildId = "b".repeat(64);
const hostSessionId = `hs_${"c".repeat(32)}`;
const key = Buffer.alloc(32, 0x51);

function nativeSnapshot(guiHuo = 0, overrides = {}) {
	return { schema: MANAGED_NATIVE_EFFECT_STATE_SCHEMA, rootInstanceId, seatIds,
		seats: seatIds.map((seatId, index) => ({ seatId, guiHuo: index === 0 ? guiHuo : 0,
			skills: index === 0 ? [{ id: "yinYangZhanHuan", present: true, source: "native_hasSkill" }] : [] })), ...overrides };
}

function ledger(options = {}) {
	return createManagedNativeEffectStateCommitment({ roomId: options.roomId || "effect_room", hostSessionId: options.hostSessionId || hostSessionId,
		engineBuildId: options.engineBuildId || engineBuildId, rootInstanceId: options.rootInstanceId || rootInstanceId,
		seatIds, key: options.key || key });
}

test("private effect commitment is stable and binds verified YinYang presence and native guiHuo count", () => {
	const current = ledger();
	const first = current.commit(nativeSnapshot());
	const same = current.commit(nativeSnapshot());
	const changed = current.commit(nativeSnapshot(1));
	assert.match(first.commitment, /^[a-f0-9]{64}$/);
	assert.equal(same.commitment, first.commitment);
	assert.equal(same.stableWithPrevious, true);
	assert.notEqual(changed.commitment, first.commitment);
	assert.equal(changed.stableWithPrevious, false);
	assert.equal(changed.checkpointAvailable, false);
	assert.equal(JSON.stringify(changed).includes("yinYangZhanHuan"), false);
	assert.equal(JSON.stringify(changed).includes("guiHuo"), false);
});

test("private effect commitment is room, session, build, root and key scoped", () => {
	const sample = nativeSnapshot();
	const value = ledger().commit(sample).commitment;
	assert.notEqual(value, ledger({ roomId: "other_room" }).commit(sample).commitment);
	assert.notEqual(value, ledger({ hostSessionId: `hs_${"d".repeat(32)}` }).commit(sample).commitment);
	assert.notEqual(value, ledger({ engineBuildId: "e".repeat(64) }).commit(sample).commitment);
	assert.notEqual(value, ledger({ key: Buffer.alloc(32, 0x52) }).commit(sample).commitment);
	assert.throws(() => ledger().commit(nativeSnapshot(0, { rootInstanceId: `native_root_${"d".repeat(32)}` })), /NATIVE_EFFECT_STATE_ROOT_MISMATCH/);
});

test("unsupported skill, mark, object storage, duplicate seat, malformed count and excess data fail closed", () => {
	const bad = [
		 nativeSnapshot(0, { extra: true }),
		 nativeSnapshot(0, { seats: nativeSnapshot().seats.map((seat, index) => index ? seat : ({ ...seat, skills: [{ id: "unknown_skill", present: true, source: "native_hasSkill" }] })) }),
		 nativeSnapshot(0, { seats: nativeSnapshot().seats.map((seat, index) => index ? seat : ({ ...seat, storage: { unexpected: true } })) }),
		 nativeSnapshot(0, { seats: nativeSnapshot().seats.map((seat, index) => index ? seat : ({ ...seat, guiHuo: 4 })) }),
		 nativeSnapshot(0, { seats: nativeSnapshot().seats.map((seat, index) => index ? seat : ({ ...seat, skills: [{ id: "yinYangZhanHuan", present: true, source: "guessed" }] })) }),
	];
	for (const snapshot of bad) assert.throws(() => ledger().commit(snapshot), /NATIVE_EFFECT_STATE_/);
	const cyclic = {}; cyclic.self = cyclic;
	assert.throws(() => ledger().commit(nativeSnapshot(0, { ignored: cyclic })), /NATIVE_EFFECT_STATE_/);
});

test("effect commitment destroys derived key and enforces bounded lifecycle", () => {
	const current = ledger();
	for (let index = 0; index < 64; index++) current.commit(nativeSnapshot(index % 4));
	assert.throws(() => current.commit(nativeSnapshot()), /NATIVE_EFFECT_STATE_SNAPSHOT_LIMIT/);
	current.destroy();
	assert.throws(() => current.commit(nativeSnapshot()), /NATIVE_EFFECT_STATE_DESTROYED/);
});
