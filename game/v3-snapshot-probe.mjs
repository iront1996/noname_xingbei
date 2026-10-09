/**
 * V3-only manual snapshot feasibility probe.
 *
 * Captures a candidate snapshot in browser memory for structural validation
 * and a SHA-256 fingerprint. It NEVER persists, transmits, logs, or returns
 * the raw snapshot (which contains hidden handcards and deck order).
 *
 * This is NOT a checkpoint writer, serializer for durable recovery, or a
 * feature that can resume interrupted game events.
 */
import { game, get, ui, _status } from "../noname.js";

const SNAPSHOT_SCHEMA = "xingbei-v3-probe-1";

function reject(code) {
  return { ok: false, code, restorable: false, checkpointCommitted: false };
}

export async function inspectHostSnapshot() {
  // Only the V3 room owner's active match is eligible for this diagnostic.
  if (!game.onlineroom || game.online || !_status.connectMode) {
    return reject("NOT_ROOM_HOST");
  }
  if (!_status.gameStarted || !game.players?.length || !game.ws || game.ws.readyState !== WebSocket.OPEN) {
    return reject("MATCH_NOT_READY");
  }
  if (!ui.cardPile || !ui.discardPile || typeof get.arenaState !== "function") {
    return reject("STATE_API_NOT_READY");
  }

  try {
    // Every raw value below stays local to this invocation. Never return it.
    const arena = get.arenaState();
    const ids = Object.keys(arena.players || {});
    if (!ids.length) return reject("NO_PLAYER_STATES");

    const drawCards = Array.from(ui.cardPile.children);
    const discardCards = Array.from(ui.discardPile.children);
    const ownedCards = ids.reduce((sum, id) => {
      const player = arena.players[id];
      return sum + ["handcards", "equips", "judges", "specials", "expansions"]
        .reduce((count, zone) => count + (Array.isArray(player?.[zone]) ? player[zone].length : 0), 0);
    }, 0);

    // Use the game's established card/player wire-format conversion rather
    // than serializing DOM nodes or attempting to reconstruct live objects.
    const candidate = {
      schema: SNAPSHOT_SCHEMA,
      capturedAt: new Date().toISOString(),
      roomId: game.roomId,
      phaseNumber: game.phaseNumber,
      arena: get.stringifiedResult(arena),
      drawPile: get.cardsInfoOL(drawCards),
      discardPile: get.cardsInfoOL(discardCards),
      eventDiagnostic: {
        name: typeof _status.event?.name === "string" ? _status.event.name : null,
        step: typeof _status.event?.step === "number" ? _status.event.step : null,
      },
    };

    const json = JSON.stringify(candidate);
    if (!json) return reject("SERIALIZATION_EMPTY");
    const decoded = JSON.parse(json);
    const decodedPlayers = decoded.arena?.players;
    if (!decodedPlayers || Object.keys(decodedPlayers).length !== ids.length) {
      return reject("PLAYER_ROUNDTRIP_MISMATCH");
    }
    for (const id of ids) {
      if (!decodedPlayers[id]) return reject("PLAYER_ROUNDTRIP_MISMATCH");
      for (const zone of ["handcards", "equips", "judges", "specials", "expansions"]) {
        const original = arena.players[id]?.[zone];
        const serialized = decodedPlayers[id]?.[zone];
        if (!Array.isArray(original) || !Array.isArray(serialized) || original.length !== serialized.length) {
          return reject("CARD_ZONE_ROUNDTRIP_MISMATCH");
        }
      }
    }
    if (decoded.drawPile?.length !== drawCards.length || decoded.discardPile?.length !== discardCards.length) {
      return reject("PILE_ROUNDTRIP_MISMATCH");
    }

    const bytes = new TextEncoder().encode(json);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");

    // The report intentionally includes no identifiers, hidden cards, or
    // raw serialized payload. Its hash proves only repeatable bytes.
    return {
      ok: true,
      schema: SNAPSHOT_SCHEMA,
      byteLength: bytes.byteLength,
      sha256,
      playerCount: ids.length,
      cardCountInPlayerZones: ownedCards,
      drawPileCount: drawCards.length,
      discardPileCount: discardCards.length,
      phaseNumber: typeof game.phaseNumber === "number" ? game.phaseNumber : null,
      restorable: false,
      checkpointCommitted: false,
      eventContinuationCaptured: false,
      storedOnServer: false,
    };
  } catch (error) {
    return {
      ...reject("CAPTURE_FAILED"),
      errorType: error instanceof Error ? error.name : "UnknownError",
    };
  }
}
