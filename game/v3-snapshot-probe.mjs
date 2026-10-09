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

const SNAPSHOT_SCHEMA = "xingbei-v3-probe-4";

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
  if (!ui.cardPile || !ui.discardPile || typeof get.arenaState !== "function" || typeof get.skillState !== "function") {
    return reject("STATE_API_NOT_READY");
  }

  try {
    // Every raw value below stays local to this invocation. Never return it.
    const arena = get.arenaState();
    const ids = Object.keys(arena.players || {});
    if (!ids.length) return reject("NO_PLAYER_STATES");

    // Candidate skill payload from the engine's existing reconnect helpers.
    // This includes live player skill lists, temporary skills and storage;
    // the engine serializer is depth-limited, so this probe only verifies
    // section presence and top-level key shapes, NOT nested completeness.
    const skillState = get.skillState();
    const skillSections = [
      "skills", "hiddenSkills", "invisibleSkills", "additionalSkills",
      "disabledSkills", "tempSkills", "storage",
    ];
    const skillStateKeys = Object.keys(skillState).filter(key => key !== "global" && key !== "skillinfo" && key !== "stat");
    if (skillStateKeys.length !== ids.length || ids.some(id => !Object.prototype.hasOwnProperty.call(skillState, id))) {
      return reject("SKILL_PLAYER_SET_MISMATCH");
    }
    let skillStorageKeyCount = 0;
    let temporarySkillKeyCount = 0;
    for (const id of ids) {
      const info = skillState[id];
      if (!info || typeof info !== "object") return reject("SKILL_PLAYER_STATE_MISSING");
      skillStorageKeyCount += info.storage && typeof info.storage === "object" ? Object.keys(info.storage).length : 0;
      temporarySkillKeyCount += info.tempSkills && typeof info.tempSkills === "object" ? Object.keys(info.tempSkills).length : 0;
    }

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
      roomId: game.roomId,
      phaseNumber: game.phaseNumber,
      arena: get.stringifiedResult(arena),
      skillState: get.stringifiedResult(skillState),
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
    // JSON.stringify omits object properties with undefined values.
    // Record those omissions; do not silently treat them as lossless storage.
    let omittedUndefinedSkillFieldCount = 0;
    const decodedSkillState = decoded.skillState;
    if (!decodedSkillState || typeof decodedSkillState !== "object") return reject("SKILL_STATE_ROUNDTRIP_MISMATCH");
    for (const id of ids) {
      const original = skillState[id];
      const serialized = decodedSkillState[id];
      if (!serialized || typeof serialized !== "object") return reject("SKILL_STATE_ROUNDTRIP_MISMATCH");
      for (const section of skillSections) {
        const source = original[section];
        const output = serialized[section];
        if (source === undefined) {
          if (output !== undefined) return reject("SKILL_SECTION_ROUNDTRIP_MISMATCH");
          continue;
        }
        if (source === null || typeof source !== "object") {
          if (source !== output) return reject("SKILL_SECTION_ROUNDTRIP_MISMATCH");
          continue;
        }
        if (!output || typeof output !== "object" || Array.isArray(source) !== Array.isArray(output)) {
          return reject("SKILL_SECTION_ROUNDTRIP_MISMATCH");
        }
        const keys = Object.keys(source);
        const expectedKeys = keys.filter(key => source[key] !== undefined);
        const outputKeys = Object.keys(output);
        // Every non-undefined top-level entry must survive, with no extras.
        // Array holes / undefined elements become null, not omissions, and
        // therefore still fail validation rather than being accepted.
        if (expectedKeys.length !== outputKeys.length ||
            expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(output, key))) {
          return reject("SKILL_SECTION_ROUNDTRIP_MISMATCH");
        }
        omittedUndefinedSkillFieldCount += keys.length - expectedKeys.length;
      }
    }
    if (decoded.drawPile?.length !== drawCards.length || decoded.discardPile?.length !== discardCards.length) {
      return reject("PILE_ROUNDTRIP_MISMATCH");
    }

    // Hash only the candidate content. Capture timestamps would otherwise
    // make identical, unchanged game states always produce different hashes.
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
      hashScope: "candidate_state_without_capture_time",
      playerCount: ids.length,
      cardCountInPlayerZones: ownedCards,
      skillStatePlayerCount: ids.length,
      skillStorageKeyCount,
      temporarySkillKeyCount,
      skillSectionsVerified: true,
      omittedUndefinedSkillFieldCount,
      undefinedSkillFieldPolicy: "omitted_and_counted_not_restorable",
      nestedSkillStateCompletenessVerified: false,
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
