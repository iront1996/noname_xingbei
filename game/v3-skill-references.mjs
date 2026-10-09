/**
 * V3 staged-only skill/history reference materializer.
 *
 * Resolves serialized _noname_card: and _noname_player: references against
 * the ORIGINAL in-memory detached Player/Card maps. It refuses functions,
 * GameEvents, virtual cards and unknown live references. It does not invoke
 * skills or trigger engine actions.
 *
 * Atomicity: validate and materialize all players before applying anything
 * to staged Player objects; revert original fields if an assignment fails.
 */
const CARD_TAG = "_noname_card:";
const PLAYER_TAG = "_noname_player:";
const UNSAFE_TAGS = ["_noname_event:", "_noname_func:", "_noname_vcard:"];
const MAX_NODES = 60000;
const MAX_DEPTH = 32;
const SECTIONS = [
  "skills", "hiddenSkills", "invisibleSkills", "additionalSkills",
  "disabledSkills", "tempSkills", "storage"
];
const LISTS = new Set(["skills", "hiddenSkills", "invisibleSkills"]);
const RECORDS = new Set(["additionalSkills", "disabledSkills", "tempSkills", "storage"]);

function fail(code) {
  return { ok: false, code, applied: false, readyToResume: false };
}
function plainObject(obj) {
  if (obj === null || typeof obj !== "object") return false;
  const prototype = Object.getPrototypeOf(obj);
  return prototype === Object.prototype || prototype === null;
}
function isForbiddenProperty(key) {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function materialize(value, context, depth) {
  context.count++;
  if (context.count > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error("RESTORE_STRUCTURE_LIMIT");
  }
  if (typeof value === "string") {
    if (value === "_noname_infinity") return Infinity;
    if (UNSAFE_TAGS.some(s => value.startsWith(s))) {
      throw new Error("UNSUPPORTED_EXECUTABLE_REFERENCE");
    }
    if (value.startsWith(PLAYER_TAG)) {
      const id = value.slice(PLAYER_TAG.length);
      if (!id || !context.players.has(id)) throw new Error("UNKNOWN_PLAYER_REFERENCE");
      return context.players.get(id).player;
    }
    if (value.startsWith(CARD_TAG)) {
      let parts;
      try { parts = JSON.parse(value.slice(CARD_TAG.length)); }
      catch { throw new Error("INVALID_CARD_REFERENCE"); }
      const id = parts?.[0];
      if (!Array.isArray(parts) || parts.length !== 5 ||
          typeof id !== "string" || !context.cards.has(id)) {
        throw new Error("UNKNOWN_CARD_REFERENCE");
      }
      const card = context.cards.get(id);
      if (card.name !== parts[3] || card.xiBie !== parts[1] ||
          card.mingGe !== parts[2] || card.duYou !== parts[4]) {
        throw new Error("CARD_REFERENCE_MISMATCH");
      }
      return card;
    }
    return value;
  }
  if (value === null || typeof value === "boolean" ||
      typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("NONFINITE_NUMBER");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => materialize(item, context, depth + 1));
  }
  if (!plainObject(value)) throw new Error("UNSUPPORTED_OBJECT_PROTOTYPE");
  const out = Object.create(null);
  for (const key of Object.keys(value)) {
    if (isForbiddenProperty(key)) throw new Error("UNSAFE_PROPERTY_NAME");
    out[key] = materialize(value[key], context, depth + 1);
  }
  return out;
}

/**
 * @param staged Detached native staging result
 * @returns only aggregate counts; no hidden data or raw references
 */
export function materializeStagedSkillReferences(staged) {
  if (!staged?.ok || staged.readyToResume !== false ||
      staged.authoritativeRuntimeRebuilt !== false ||
      !(staged.runtime?.players instanceof Map) ||
      !(staged.runtime?.cards instanceof Map)) {
    return fail("STAGING_NOT_READY");
  }
  const runtime = staged.runtime;
  const prepared = [];
  const context = { players: runtime.players, cards: runtime.cards, count: 0 };
  try {
    for (const [id, entry] of runtime.players) {
      const skills = entry.serializedSkillState;
      const history = entry.serializedHistory;
      if (!plainObject(skills) || !plainObject(history) ||
          !entry.player || entry.player.playerid !== id) {
        throw new Error("SKILL_SECTION_MISSING");
      }
      const update = Object.create(null);
      for (const key of SECTIONS) {
        if (!Object.prototype.hasOwnProperty.call(skills, key)) {
          throw new Error("SKILL_SECTION_MISSING");
        }
        if (LISTS.has(key) && !Array.isArray(skills[key])) {
          throw new Error("SKILL_LIST_INVALID");
        }
        if (RECORDS.has(key) && !plainObject(skills[key])) {
          throw new Error("SKILL_RECORD_INVALID");
        }
        update[key] = materialize(skills[key], context, 0);
      }
      if (!Array.isArray(history.stat) || !Array.isArray(history.actionHistory) ||
          !Array.isArray(history.skipList)) {
        throw new Error("HISTORY_SHAPE_INVALID");
      }
      update.stat = materialize(history.stat, context, 0);
      update.actionHistory = materialize(history.actionHistory, context, 0);
      update.skipList = materialize(history.skipList, context, 0);
      if (history.phaseNumber !== null &&
          history.phaseNumber !== undefined &&
          (!Number.isInteger(history.phaseNumber) || history.phaseNumber < 0)) {
        throw new Error("PHASE_COUNTER_INVALID");
      }
      update.phaseNumber = history.phaseNumber ?? entry.player.phaseNumber;
      prepared.push({ player: entry.player, update });
    }

    const undo = [];
    try {
      for (const { player, update } of prepared) {
        for (const key of Object.keys(update)) {
          const had = Object.prototype.hasOwnProperty.call(player, key);
          const previous = player[key];
          undo.push({ player, key, had, previous });
          player[key] = update[key];
        }
      }
    } catch {
      for (let i = undo.length - 1; i >= 0; i--) {
        const { player, key, had, previous } = undo[i];
        try {
          if (had) player[key] = previous;
          else delete player[key];
        } catch {}
      }
      throw new Error("STAGED_ASSIGNMENT_FAILED");
    }
    return {
      ok: true,
      applied: true,
      stagedPlayersUpdated: prepared.length,
      referencesExamined: context.count,
      executableReferencesAllowed: false,
      authoritativeRuntimeRebuilt: false,
      eventContinuationInstalled: false,
      readyToResume: false,
    };
  } catch (error) {
    return fail(error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message : "REFERENCE_MATERIALIZATION_FAILED");
  }
}
