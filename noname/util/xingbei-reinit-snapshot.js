/**
 * V2-only structural preflight for host arena snapshots before destructive
 * game reinit. This checks the shape emitted by get.arenaState()/Player.getState(),
 * not whether the async game engine has reached the same event checkpoint.
 * No DOM or global state is modified.
 */
export function validateXingbeiSeatSnapshot(state, seatId) {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      typeof seatId !== "string" || !seatId ||
      !state.players || typeof state.players !== "object" ||
      Array.isArray(state.players) ||
      !Object.prototype.hasOwnProperty.call(state.players, seatId) ||
      !Number.isSafeInteger(Number(state.number)) ||
      Number(state.number) <= 0) return false;
  const seats = Object.values(state.players);
  if (seats.length === 0) return false;
  for (const seat of seats) {
    if (!seat || typeof seat !== "object" || Array.isArray(seat) ||
        !Number.isSafeInteger(Number(seat.position)) || Number(seat.position) < 0)
      return false;
    // These arrays are consumed by the real reinit roster/card constructor.
    for (const key of ["handcards", "gaintag", "equips", "judges",
                        "views", "specials", "expansions", "expansion_gaintag"]) {
      if (!Array.isArray(seat[key])) return false;
    }
    if (seat.gaintag.length !== seat.handcards.length ||
        seat.views.length !== seat.judges.length ||
        seat.expansion_gaintag.length !== seat.expansions.length) return false;
    if (seat.vcardsMap != null &&
        (!Array.isArray(seat.vcardsMap.equips) ||
         !Array.isArray(seat.vcardsMap.judges))) return false;
  }
  return true;
}
