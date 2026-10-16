"use strict";

const crypto = require("node:crypto");

const SCHEMA = "xingbei_native_private_card_ledger_v1";
const ZONES = Object.freeze(["draw", "discard", "ordering", "special", "hand", "equipment", "judgment", "player_special", "expansion"]);
const GLOBAL_ZONES = new Set(["draw", "discard", "ordering", "special"]);
const MAX_CARDS = 4096;
const MAX_SEATS = 8;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("NATIVE_CARD_LEDGER_VALUE_INVALID");
}

function fail(code) { throw new TypeError(code); }

function validateRows(snapshot, seatIds) {
	const keys = "cards,rootInstanceId,schema,seatIds";
	if (!snapshot || Object.getPrototypeOf(snapshot) !== Object.prototype || Object.keys(snapshot).sort().join(",") !== keys ||
		snapshot.schema !== SCHEMA || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(snapshot.rootInstanceId || "") ||
		!Array.isArray(snapshot.seatIds) || snapshot.seatIds.length < 2 || snapshot.seatIds.length > MAX_SEATS ||
		new Set(snapshot.seatIds).size !== snapshot.seatIds.length || canonicalize(snapshot.seatIds) !== canonicalize(seatIds) ||
		!Array.isArray(snapshot.cards) || snapshot.cards.length === 0 || snapshot.cards.length > MAX_CARDS) fail("NATIVE_CARD_LEDGER_SNAPSHOT_INVALID");
	const seen = new Set();
	const rows = [];
	const indexes = new Map();
	for (const row of snapshot.cards) {
		if (!row || Object.getPrototypeOf(row) !== Object.prototype ||
			Object.keys(row).sort().join(",") !== "cardId,duYou,kind,mingGe,name,ownerSeatId,position,xiBie,zone" ||
			!IDENTIFIER.test(row.cardId || "") || seen.has(row.cardId) || !ZONES.includes(row.zone) ||
			!Number.isSafeInteger(row.position) || row.position < 0 ||
			![row.name, row.xiBie, row.mingGe, row.duYou].every(value => typeof value === "string" && value.length <= 128) ||
			row.kind !== "physical_dom_card_v1") fail("NATIVE_CARD_LEDGER_ROW_INVALID");
		seen.add(row.cardId);
		const global = GLOBAL_ZONES.has(row.zone);
		if (global ? row.ownerSeatId !== null : !seatIds.includes(row.ownerSeatId)) fail("NATIVE_CARD_LEDGER_OWNER_INVALID");
		const group = `${row.zone}\u0000${row.ownerSeatId ?? ""}`;
		const next = indexes.get(group) || 0;
		if (row.position !== next) fail("NATIVE_CARD_LEDGER_ORDER_INVALID");
		indexes.set(group, next + 1);
		rows.push(Object.freeze({ cardId: row.cardId, zone: row.zone, ownerSeatId: row.ownerSeatId,
			position: row.position, name: row.name, xiBie: row.xiBie, mingGe: row.mingGe, duYou: row.duYou,
			kind: row.kind }));
	}
	return rows;
}

function createManagedNativeCardLedger({ roomId, sessionId, engineBuildId, seatIds, key }) {
	if (!IDENTIFIER.test(roomId || "") || !/^hs_[a-f0-9]{32}$/.test(sessionId || "") ||
		!/^[a-f0-9]{64}$/.test(engineBuildId || "") || !Array.isArray(seatIds) || seatIds.length < 2 || seatIds.length > MAX_SEATS ||
		new Set(seatIds).size !== seatIds.length || seatIds.some(seatId => !IDENTIFIER.test(seatId)) ||
		!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("NATIVE_CARD_LEDGER_CONFIG_INVALID");
	const privateKey = Buffer.from(key);
	const priorRows = new Map();
	let priorCommitment = null;
	let snapshotCount = 0;
	let destroyed = false;
	return Object.freeze({
		commit(snapshot) {
			if (destroyed) fail("NATIVE_CARD_LEDGER_DESTROYED");
			if (snapshotCount >= 16) fail("NATIVE_CARD_LEDGER_SNAPSHOT_LIMIT");
			const rows = validateRows(snapshot, seatIds);
			if (priorCommitment && snapshot.rootInstanceId !== priorCommitment.rootInstanceId) fail("NATIVE_CARD_LEDGER_ROOT_CHANGED");
			const ordered = rows.slice().sort((left, right) => {
				const zone = ZONES.indexOf(left.zone) - ZONES.indexOf(right.zone);
				if (zone) return zone;
				const leftSeat = left.ownerSeatId === null ? -1 : seatIds.indexOf(left.ownerSeatId);
				const rightSeat = right.ownerSeatId === null ? -1 : seatIds.indexOf(right.ownerSeatId);
				return leftSeat - rightSeat || left.position - right.position;
			});
			const context = { schema: SCHEMA, schemaVersion: 1, roomId, sessionId, engineBuildId,
				rootInstanceId: snapshot.rootInstanceId, seatIds };
			const encoded = canonicalize({ context, cards: ordered });
			const commitment = crypto.createHmac("sha256", privateKey).update(encoded, "utf8").digest("hex");
			const zoneCounts = Object.fromEntries(ZONES.map(zone => [zone, rows.filter(row => row.zone === zone).length]));
			const changed = new Map(), present = new Set(rows.map(row => row.cardId));
			for (const row of rows) {
				const prior = priorRows.get(row.cardId);
				if (!prior || canonicalize(prior) !== canonicalize(row)) changed.set(row.cardId, row.zone);
			}
			for (const [cardId, prior] of priorRows) if (!present.has(cardId)) changed.set(cardId, prior.zone);
			const priorZoneCounts = priorCommitment?.zoneCounts || null;
			const priorPhysicalCardCount = priorRows.size;
			const zoneDelta = priorZoneCounts ? Object.fromEntries(ZONES.map(zone => [zone, zoneCounts[zone] - priorZoneCounts[zone]])) : null;
			priorRows.clear();
			for (const row of rows) priorRows.set(row.cardId, row);
			priorCommitment = { rootInstanceId: snapshot.rootInstanceId, zoneCounts };
			snapshotCount++;
			return Object.freeze({ schema: "xingbei_native_private_card_commitment_v1", schemaVersion: 1,
				snapshotOrdinal: snapshotCount, rootInstanceId: snapshot.rootInstanceId, engineBuildId,
				physicalCardCount: rows.length, zoneCounts: Object.freeze(zoneCounts), commitment,
				changedPhysicalCardCount: snapshotCount === 1 ? 0 : changed.size,
				zoneDelta: zoneDelta && Object.freeze(zoneDelta), totalCountConserved: snapshotCount === 1 ? null :
					rows.length === priorPhysicalCardCount, virtualCardsIncluded: false,
				checkpointAvailable: false });
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			privateKey.fill(0);
			priorRows.clear();
			priorCommitment = null;
		},
	});
}

module.exports = { MANAGED_NATIVE_CARD_LEDGER_SCHEMA: SCHEMA, MANAGED_NATIVE_CARD_ZONES: ZONES,
	createManagedNativeCardLedger, validateNativeCardLedgerSnapshot: validateRows };
