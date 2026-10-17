import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { MANAGED_NATIVE_CARD_LEDGER_SCHEMA, createManagedNativeCardLedger } = require("../game/server-managed-native-card-ledger.js");
const seats = ["seat_a", "seat_b", "seat_c", "seat_d"];
const rootInstanceId = `native_root_${"a".repeat(32)}`;
const buildId = "b".repeat(64);
const key = Buffer.alloc(32, 0x37);

function row(cardId, zone, ownerSeatId, position, name = "gongJi") {
	return { cardId, zone, ownerSeatId, position, name, xiBie: "hong", mingGe: "normal", duYou: null, kind: "physical_dom_card_v1" };
}

function snapshot(cards, overrides = {}) {
	return { schema: MANAGED_NATIVE_CARD_LEDGER_SCHEMA, rootInstanceId, seatIds: seats, cards, ...overrides };
}

function ledger(options = {}) {
	return createManagedNativeCardLedger({ roomId: options.roomId || "ledger_room", sessionId: options.sessionId || `hs_${"c".repeat(32)}`,
		engineBuildId: options.engineBuildId || buildId, seatIds: seats,
		key: options.key || key });
}

test("private native physical-card ledger commits ordered four-seat zones and detects native movement", () => {
	const current = ledger();
	const before = snapshot([row("physical_1", "draw", null, 0), row("physical_2", "hand", "seat_a", 0),
		row("physical_3", "hand", "seat_b", 0), row("physical_4", "discard", null, 0)]);
	const first = current.commit(before);
	const after = snapshot([row("physical_1", "draw", null, 0), row("physical_3", "hand", "seat_b", 0),
		row("physical_4", "discard", null, 0), row("physical_2", "discard", null, 1)]);
	const second = current.commit(after);
	assert.match(first.commitment, /^[a-f0-9]{64}$/);
	assert.notEqual(first.commitment, second.commitment);
	assert.equal(first.physicalCardCount, 4);
	assert.equal(second.physicalCardCount, 4);
	assert.equal(second.changedPhysicalCardCount, 1);
	assert.equal(second.movedZonePhysicalCardCount, 1);
	assert.equal(second.totalCountConserved, true);
	assert.deepEqual(second.zoneDelta, { draw: 0, discard: 1, ordering: 0, special: 0, hand: -1,
		equipment: 0, judgment: 0, player_special: 0, expansion: 0 });
	assert.equal(second.virtualCardsIncluded, false);
	assert.equal(second.checkpointAvailable, false);
	assert.equal(JSON.stringify(second).includes("physical_2"), false, "private card identities must not leave the ledger");
	assert.equal(JSON.stringify(second).includes("gongJi"), false, "card faces must not leave the ledger");
});

test("private commitment is scoped to a per-session secret and exact room/session/build context", () => {
	const input = snapshot([row("physical_1", "draw", null, 0)]);
	const one = ledger().commit(input);
	const two = ledger({ key: Buffer.alloc(32, 0x38) }).commit(input);
	assert.notEqual(one.commitment, two.commitment);
	assert.notEqual(one.commitment, ledger({ roomId: "other_room" }).commit(input).commitment);
	assert.notEqual(one.commitment, ledger({ sessionId: `hs_${"d".repeat(32)}` }).commit(input).commitment);
	assert.notEqual(one.commitment, ledger({ engineBuildId: "e".repeat(64) }).commit(input).commitment);
	assert.throws(() => createManagedNativeCardLedger({ roomId: "ledger_room", sessionId: `hs_${"d".repeat(32)}`,
		engineBuildId: buildId, seatIds: seats, key: Buffer.alloc(31) }), /NATIVE_CARD_LEDGER_CONFIG_INVALID/);
	const lifecycle = ledger();
	lifecycle.commit(input);
	lifecycle.destroy();
	assert.throws(() => lifecycle.commit(input), /NATIVE_CARD_LEDGER_DESTROYED/);
});

test("draw-pile order is committed as native rule-relevant state", () => {
	const first = ledger().commit(snapshot([row("physical_1", "draw", null, 0), row("physical_2", "draw", null, 1)]));
	const reordered = ledger().commit(snapshot([row("physical_2", "draw", null, 0), row("physical_1", "draw", null, 1)]));
	assert.notEqual(first.commitment, reordered.commitment, "draw-pile order must affect the private commitment");
});

test("canonical private ledger is stable for the same captured zone state regardless of input grouping", () => {
	const rows = [row("physical_1", "draw", null, 0), row("physical_2", "hand", "seat_a", 0), row("physical_3", "discard", null, 0)];
	const current = ledger();
	const first = current.commit(snapshot(rows));
	const second = current.commit(snapshot([rows[2], rows[0], rows[1]]));
	assert.equal(first.commitment, second.commitment);
	assert.equal(second.changedPhysicalCardCount, 0);
	assert.deepEqual(second.zoneDelta, { draw: 0, discard: 0, ordering: 0, special: 0, hand: 0,
		equipment: 0, judgment: 0, player_special: 0, expansion: 0 });
});

test("native physical-card face preserves the engine's numeric mingGe and absent duYou explicitly", () => {
	const current = ledger();
	const nativeNumeric = { ...row("physical_1", "draw", null, 0), mingGe: 7, duYou: null };
	const first = current.commit(snapshot([nativeNumeric]));
	assert.match(first.commitment, /^[a-f0-9]{64}$/);
	const asString = ledger().commit(snapshot([{ ...nativeNumeric, mingGe: "7" }]));
	assert.notEqual(first.commitment, asString.commitment, "canonical encoding must preserve native numeric-versus-string face types");
	assert.throws(() => ledger().commit(snapshot([{ ...nativeNumeric, mingGe: 1.5 }])), /NATIVE_CARD_LEDGER_ROW_INVALID/);
	assert.throws(() => ledger().commit(snapshot([{ ...nativeNumeric, duYou: { unknown: true } }])), /NATIVE_CARD_LEDGER_ROW_INVALID/);
});

test("native ledger rejects duplicate identities, unknown zones, malformed ownership and sequence gaps", () => {
	const cases = [
		[snapshot([row("physical_1", "draw", null, 0), row("physical_1", "hand", "seat_a", 0)]), /NATIVE_CARD_LEDGER_ROW_INVALID/],
		[snapshot([row("physical_1", "unknown", null, 0)]), /NATIVE_CARD_LEDGER_ROW_INVALID/],
		[snapshot([row("physical_1", "hand", "seat_z", 0)]), /NATIVE_CARD_LEDGER_OWNER_INVALID/],
		[snapshot([row("physical_1", "draw", "seat_a", 0)]), /NATIVE_CARD_LEDGER_OWNER_INVALID/],
		[snapshot([row("physical_1", "draw", null, 1)]), /NATIVE_CARD_LEDGER_ORDER_INVALID/],
		[snapshot([row("physical_1", "draw", null, 0), { ...row("physical_2", "hand", "seat_a", 0), unexpected: true }]), /NATIVE_CARD_LEDGER_ROW_INVALID/],
		[snapshot([row("physical_1", "draw", null, 0), { ...row("physical_2", "hand", "seat_a", 0), kind: "virtual_view_as" }]), /NATIVE_CARD_LEDGER_ROW_INVALID/],
	];
	for (const [input, expected] of cases) assert.throws(() => ledger().commit(input), expected);
	assert.throws(() => ledger().commit(snapshot([row("physical_1", "draw", null, 0)], { seatIds: [...seats].reverse() })),
		/NATIVE_CARD_LEDGER_SNAPSHOT_INVALID/);
});

test("private ledger rejects root changes, changed seat membership and excessive snapshots", () => {
	const rootBound = ledger();
	rootBound.commit(snapshot([row("physical_1", "draw", null, 0)]));
	assert.throws(() => rootBound.commit(snapshot([row("physical_1", "draw", null, 0)], { rootInstanceId: `native_root_${"d".repeat(32)}` })),
		/NATIVE_CARD_LEDGER_ROOT_CHANGED/);
	const overused = ledger();
	for (let index = 0; index < 16; index++) overused.commit(snapshot([row("physical_1", "draw", null, 0)]));
	assert.throws(() => overused.commit(snapshot([row("physical_1", "draw", null, 0)])), /NATIVE_CARD_LEDGER_SNAPSHOT_LIMIT/);
});
