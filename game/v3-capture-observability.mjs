/** V3-only, metadata-only recovery capture health; never logs room state, tokens or cards. */
export function inspectV3CaptureReadiness(context) {
  const { game, status, ui, lib, get, socketOpenState = 1 } = context || {};
  const reject = code => ({ ready: false, code });
  if (!game?.onlineroom || game.online) return reject("NOT_AUTHORITATIVE_OWNER");
  if (!status?.connectMode || !status.gameStarted) return reject("MATCH_NOT_STARTED");
  if (game.ws?.readyState !== socketOpenState) return reject("SOCKET_NOT_OPEN");
  if (typeof game.roomId !== "string" || game.roomId.length < 1 || game.roomId.length >= 128) return reject("ROOM_ID_UNAVAILABLE");
  if (!game.players || typeof game.players.length !== "number" || game.players.length < 1) return reject("PLAYERS_NOT_READY");
  if (!ui?.cardPile || !ui?.discardPile) return reject("PILE_NODES_NOT_READY");
  if (!Array.isArray(lib?.node?.clients)) return reject("PEER_ROSTER_UNAVAILABLE");
  if (typeof game.me?.playerid !== "string" || !game.me.playerid) return reject("HOST_PLAYER_ID_UNAVAILABLE");
  if (!lib?.playerOL?.[game.me.playerid]) return reject("HOST_PLAYER_RUNTIME_UNAVAILABLE");
  if (typeof get?.arenaState !== "function" || typeof get?.skillState !== "function" ||
      typeof get?.stringifiedResult !== "function" || typeof get?.cardsInfoOL !== "function" ||
      typeof get?.itemtype !== "function") return reject("ENGINE_GETTERS_UNAVAILABLE");
  return { ready: true, code: "CAPTURE_READY" };
}

export function publicV3CaptureCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value : "UNCLASSIFIED_CAPTURE_ERROR";
}

const STATUSES = ["CAPTURE_BLOCKED","CAPTURE_FAILED","BOUNDARY_CAPTURE_FAILED","ENCRYPTED_CANDIDATE_SAVED"];
export function makeV3CaptureDiagnostic(status, code, kind, at) {
  if (!STATUSES.includes(status)) throw new Error("INVALID_DIAGNOSTIC_STATUS");
  return {
    status, code: status === "ENCRYPTED_CANDIDATE_SAVED" ? null : publicV3CaptureCode(code),
    kind: kind === "turn_boundary" ? "turn_boundary" : "periodic", at
  };
}

export function parseV3CaptureDiagnostic(raw, now, maxAgeMs = 600000) {
  if (typeof raw !== "string" || raw.length > 512) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || !STATUSES.includes(data.status) ||
        !Number.isSafeInteger(data.at) || data.at > now + 60000 ||
        data.at < now - maxAgeMs ||
        (data.kind !== "periodic" && data.kind !== "turn_boundary") ||
        (data.code !== null && (typeof data.code !== "string" ||
         publicV3CaptureCode(data.code) !== data.code))) return null;
    if (data.status === "ENCRYPTED_CANDIDATE_SAVED" && data.code !== null) return null;
    if (data.status !== "ENCRYPTED_CANDIDATE_SAVED" && !data.code) return null;
    return {status:data.status,code:data.code,kind:data.kind,at:data.at};
  } catch { return null; }
}
