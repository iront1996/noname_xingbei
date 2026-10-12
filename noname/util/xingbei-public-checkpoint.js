/**
 * C3c advisory fingerprint of visible Xingbei resources and seats.
 * Deliberately excludes hands, deck order, skill storage, choices, secrets,
 * and private per-seat data. NOT a full authoritative game snapshot.
 */
export function captureXingbeiPublicState(game) {
  if (!game || !Array.isArray(game.players) || !game.players.length ||
      game.players.length > 16 || (game.dead != null &&
      (!Array.isArray(game.dead) || game.dead.length > 16))) return null;
  const integer = value => Number.isSafeInteger(value) ? value : null;
  const seats = [];
  const ids = new Set();
  try {
    for (const [group, list] of [["active", game.players], ["dead", game.dead || []]]) {
      for (const player of list) {
        const id = player?.playerid;
        if (typeof id !== "string" || !id || id.length > 128 || ids.has(id)) return null;
        ids.add(id);
        seats.push([
          id, group, integer(player.hp), integer(player.maxHp),
          integer(player.hujia), typeof player.side === "boolean" ? player.side : null
        ]);
      }
    }
    seats.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return [1, [
      integer(game.hongShiQi), integer(game.lanShiQi),
      integer(game.hongXingBei), integer(game.lanXingBei),
      Array.isArray(game.hongZhanJi) ? game.hongZhanJi.length : null,
      Array.isArray(game.lanZhanJi) ? game.lanZhanJi.length : null
    ], seats];
  } catch (_) {
    return null;
  }
}

/** Diagnostic-only FNV-1a over canonical UTF-16 code units (not cryptographic). */
export function fingerprintXingbeiPublicState(game) {
  const state = captureXingbeiPublicState(game);
  if (!state) return null;
  const serialized = JSON.stringify(state);
  let value = 0xcbf29ce484222325n;
  for (let i = 0; i < serialized.length; i++) {
    const unit = serialized.charCodeAt(i);
    value = ((value ^ BigInt(unit & 255)) * 0x100000001b3n) & 0xffffffffffffffffn;
    value = ((value ^ BigInt(unit >>> 8)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return "xb-public-v1:" + value.toString(16).padStart(16, "0");
}
