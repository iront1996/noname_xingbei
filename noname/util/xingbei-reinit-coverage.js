/**
 * V2-only reconnect coverage advisory. Nothing here authorizes a game action.
 * A card array present in a snapshot is NOT evidence that an interrupted
 * skill/GameEvent stack has been replayed.
 *
 * Wire report contains fixed vocabulary only. Never transmit skill storage,
 * card IDs, session secrets, private hands, nicknames or event objects here.
 */
const LIMITATIONS = Object.freeze([
  "card_zone_shape_unverified",
  "skill_state_unverified",
  "game_event_stack_unverified",
  "mode_update_unavailable",
  "mode_snapshot_empty",
  "choice_ui_unverified",
]);
const KNOWN = new Set(LIMITATIONS);
const CARD_ZONES = ["handcards","equips","judges","specials","expansions"];

export function assessXingbeiReinitCoverage(arena, modeState, {
  canApplyModeState = false, pendingChoice = false
} = {}) {
  const players = arena && typeof arena === "object" &&
    arena.players && typeof arena.players === "object" &&
    !Array.isArray(arena.players) ? Object.values(arena.players) : [];
  const cardZonesIncluded = players.length > 0 && players.every(seat =>
    seat && typeof seat === "object" && CARD_ZONES.every(key => Array.isArray(seat[key])));
  const limitations = [];
  if (!cardZonesIncluded) limitations.push("card_zone_shape_unverified");
  // The real Player.getState()/get.arenaState() do not explicitly capture
  // Player.storage, hidden/additional/temp skills or their runtime callbacks.
  limitations.push("skill_state_unverified","game_event_stack_unverified");
  if (!canApplyModeState) limitations.push("mode_update_unavailable");
  if (!modeState || typeof modeState !== "object" ||
      Object.keys(modeState).length === 0) limitations.push("mode_snapshot_empty");
  if (pendingChoice) limitations.push("choice_ui_unverified");
  return {protocol:1,cardZonesIncluded,limitations};
}

export function normalizeXingbeiReinitCoverage(report) {
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      report.protocol !== 1 || typeof report.cardZonesIncluded !== "boolean" ||
      !Array.isArray(report.limitations) || report.limitations.length > LIMITATIONS.length ||
      new Set(report.limitations).size !== report.limitations.length ||
      report.limitations.some(flag => typeof flag !== "string" || !KNOWN.has(flag))) return null;
  return {protocol:1,cardZonesIncluded:report.cardZonesIncluded,
    limitations:report.limitations.slice()};
}
