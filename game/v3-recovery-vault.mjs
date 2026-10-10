/**
 * V3 playtest recovery foundation: encrypted, local-only candidate state.
 *
 * IMPORTANT:
 *  - This is NOT a certified checkpoint and CANNOT resume game events.
 *  - Neither hidden hands nor encryption keys are sent to the VPS.
 *  - AES-GCM key lives in this tab's sessionStorage so it survives a refresh.
 *  - Ciphertext is in IndexedDB and expires after ten minutes.
 *  - No changes to the engine, timers, events, or player actions.
 */
import { game, get, lib, ui, _status } from "../noname.js";
import { auditV3Serialization } from "./v3-serialization-integrity.mjs";
import {
  inspectV3CaptureReadiness, makeV3CaptureDiagnostic,
  parseV3CaptureDiagnostic, publicV3CaptureCode
} from "./v3-capture-observability.mjs";
import { inspectV3EncryptedRecord } from "./v3-candidate-inventory.mjs";
import { classifyV3HostPeerTopology } from "./v3-peer-topology.mjs";

const DB_NAME = "xingbei-v3-playtest-recovery";
const STORE = "encryptedCandidates";
const VERSION = 1;
const SCHEMA = "xingbei-v3-candidate-1";
const KEY_PREFIX = "xingbei-v3-recovery-aes:";
const DIAGNOSTIC_PREFIX = "xingbei-v3-capture-diagnostic:";
const INTERVAL_MS = 6000;
const BOUNDARY_SUFFIX = "::turn-boundary";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 10 * 60 * 1000;
let installed = false;
let busy = false;
let pendingBoundary = null;
let lastOutcome = { status: "NOT_YET_CAPTURED" };
let lastOutcomeRoomId = null;

function validRoomId(id) {
  return typeof id === "string" && id.length > 0 && id.length < 128;
}

function captureReadiness() {
  return inspectV3CaptureReadiness({
    game, lib, ui, get, status: _status,
    socketOpenState: typeof WebSocket !== "undefined" ? WebSocket.OPEN : 1
  });
}

function activeOwner() {
  return captureReadiness().ready;
}

// A per-room, same-tab reload diagnostic. Never store raw snapshots, error
// messages, socket IDs, credential material or hidden cards in this record.
function recordCaptureOutcome(status, code, kind, roomId = game.roomId, at = Date.now()) {
  const diagnostic = makeV3CaptureDiagnostic(status, code, kind, at);
  lastOutcome = diagnostic;
  lastOutcomeRoomId = validRoomId(roomId) ? roomId : null;
  if (validRoomId(roomId)) {
    try {
      sessionStorage.setItem(DIAGNOSTIC_PREFIX + roomId, JSON.stringify(diagnostic));
    } catch {
      // Storage failures must not break the existing encrypted capture path.
    }
  }
}


function encodeBase64(bytes) {
  let binary = "";
  for (const v of bytes) binary += String.fromCharCode(v);
  return btoa(binary);
}

function decodeBase64(raw) {
  if (typeof raw !== "string" || raw.length > 4 * MAX_BYTES) {
    throw new Error("INVALID_ENCODING");
  }
  return Uint8Array.from(atob(raw), c => c.charCodeAt(0));
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("INDEXED_DB_UNAVAILABLE"));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "roomId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("DATABASE_OPEN_FAILED"));
    request.onblocked = () => reject(new Error("DATABASE_BLOCKED"));
  });
}

async function transact(mode, operation) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = operation(tx.objectStore(STORE));
      let value;
      req.onsuccess = () => { value = req.result; };
      req.onerror = () => reject(req.error || new Error("DATABASE_REQUEST_FAILED"));
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error("DATABASE_TRANSACTION_FAILED"));
      tx.onabort = () => reject(tx.error || new Error("DATABASE_ABORTED"));
    });
  } finally {
    db.close();
  }
}

function sessionKeyName(roomId) { return KEY_PREFIX + roomId; }

async function cryptoKey(roomId, allowCreation) {
  if (!globalThis.crypto?.subtle) throw new Error("WEB_CRYPTO_UNAVAILABLE");
  let raw = sessionStorage.getItem(sessionKeyName(roomId));
  if (!raw && allowCreation) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = encodeBase64(bytes);
    sessionStorage.setItem(sessionKeyName(roomId), raw);
  }
  if (!raw) throw new Error("ENCRYPTION_KEY_MISSING");
  const bytes = decodeBase64(raw);
  if (bytes.length !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function captureCandidate(kind = "periodic") {
  // Capture the individual synchronous engine getters without await.
  // This is still not an atomic / restartable engine checkpoint.
  const arena = get.arenaState();
  const skills = get.skillState();
  const ids = Object.keys(arena?.players || {});
  if (!ids.length || ids.length !== game.players.length + (game.dead?.length || 0)) {
    throw new Error("PLAYER_SET_MISMATCH");
  }
  if (ids.some(id => !Object.prototype.hasOwnProperty.call(skills, id))) {
    throw new Error("SKILL_SET_MISMATCH");
  }
  // game.randomMapOL() fills vacant seats with AI players (no Player.ws).
  // Exactly map EVERY still-connected human to their original socket; do not
  // mistake bot seats for disconnected humans or silently adopt observers.
  const topology = classifyV3HostPeerTopology({
    playerIds: ids,
    playerOL: lib.playerOL,
    clients: lib.node?.clients,
    observing: lib.node?.observing,
    hostPlayerId: game.me?.playerid,
  });
  if (!topology.ok) throw new Error(topology.code);
  const guestBindings = topology.peerBindings;
  const botPlayerIds = topology.botPlayerIds;
  const arenaEncoded = JSON.parse(JSON.stringify(get.stringifiedResult(arena)));
  const skillsEncoded = JSON.parse(JSON.stringify(get.stringifiedResult(skills)));
  const auditArena = auditV3Serialization(arena, arenaEncoded, get.itemtype);
  const auditSkills = auditV3Serialization(skills, skillsEncoded, get.itemtype);
  if (!auditArena.ok || !auditSkills.ok) {
    throw new Error("CANDIDATE_STRUCTURE_LOSS");
  }
  const playerExecution = {};
  for (const id of ids) {
    const player = lib.playerOL?.[id];
    if (!player) throw new Error("PLAYER_RUNTIME_MISSING");
    const stat = player.stat || [];
    const history = player.actionHistory || [];
    const skipped = player.skipList || [];
    const statEncoded = JSON.parse(JSON.stringify(get.stringifiedResult(stat)));
    const historyEncoded = JSON.parse(JSON.stringify(get.stringifiedResult(history)));
    const skipEncoded = JSON.parse(JSON.stringify(get.stringifiedResult(skipped)));
    const checks = [
      auditV3Serialization(stat, statEncoded, get.itemtype),
      auditV3Serialization(history, historyEncoded, get.itemtype),
      auditV3Serialization(skipped, skipEncoded, get.itemtype),
    ];
    if (checks.some(result => !result.ok)) {
      throw new Error("PLAYER_HISTORY_STRUCTURE_LOSS");
    }
    playerExecution[id] = {
      stat: statEncoded,
      actionHistory: historyEncoded,
      skipList: skipEncoded,
      phaseNumber: player.phaseNumber ?? null,
    };
  }
  const manager = _status.eventManager;
  const stack = Array.isArray(manager?.eventStack) ? manager.eventStack : [];
  const state = {
    schema: SCHEMA,
    capturedAt: Date.now(),
    roomId: game.roomId,
    hostPlayerId: game.me.playerid,
    peerBindings: guestBindings,
    botPlayerIds,
    observationKind: kind,
    nextTurnPlayerId: kind === "turn_boundary"
      ? _status.eventManager?.getStartedEvent?.()?.player?.playerid ?? null
      : null,
    phaseNumber: game.phaseNumber ?? null,
    roundNumber: game.roundNumber ?? null,
    currentPhaseId: _status.currentPhase?.playerid ?? null,
    arena: arenaEncoded,
    skills: skillsEncoded,
    structuralAudit: {
      arenaVerified: true,
      skillStateVerified: true,
      playerHistoryVerified: true,
      omittedUndefinedProperties:
        auditArena.omittedUndefinedProperties +
        auditSkills.omittedUndefinedProperties,
    },
    drawPile: get.cardsInfoOL(Array.from(ui.cardPile.children)),
    discardPile: get.cardsInfoOL(Array.from(ui.discardPile.children)),
    gameState: typeof game.getState === "function"
      ? get.stringifiedResult(game.getState()) : null,
    config: get.stringifiedResult(lib.configOL),
    cardtag: get.stringifiedResult(_status.cardtag),
    playerExecution,
    roundStartPlayerId: _status.roundStart?.playerid ?? null,
    lastPhasedPlayerId: _status.lastPhasedPlayer?.playerid ?? null,
    eventObservation: {
      // Event continuations, Promises, closure locals and outstanding
      // responses are not encoded by these fields.
      stackDepth: stack.length,
      stackOutline: stack.map(event => ({
        name: typeof event?.name === "string" ? event.name : null,
        step: typeof event?.step === "number" ? event.step : null,
        finished: Boolean(event?.finished),
        nextCount: event?.next?.length ?? null,
        afterCount: event?.after?.length ?? null,
      })),
      activeEventName: _status.event?.name ?? null,
      activeEventStep: _status.event?.step ?? null,
      paused: Boolean(_status.paused),
    },
    safeCheckpointCertified: false,
    eventContinuationCaptured: false,
    playerHistoryCompletenessVerified: false,
    restorable: false,
  };
  const json = JSON.stringify(state);
  if (typeof json !== "string") throw new Error("SERIALIZATION_EMPTY");
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_BYTES) throw new Error("CANDIDATE_TOO_LARGE");
  const decoded = JSON.parse(json);
  if (decoded.schema !== SCHEMA ||
      Object.keys(decoded.arena?.players || {}).length !== ids.length ||
      decoded.drawPile.length !== ui.cardPile.children.length ||
      decoded.discardPile.length !== ui.discardPile.children.length ||
      decoded.hostPlayerId !== game.me.playerid ||
      !Array.isArray(decoded.peerBindings) ||
      decoded.peerBindings.length !== guestBindings.length) {
    throw new Error("STRUCTURE_ROUNDTRIP_MISMATCH");
  }
  return {
    bytes,
    capturedAt: state.capturedAt,
    playerCount: ids.length,
    drawPileCount: state.drawPile.length,
    discardPileCount: state.discardPile.length,
  };
}

async function saveCandidate(kind = "periodic", captured = null) {
  const readiness = captureReadiness();
  if (!readiness.ready) {
    if (game.onlineroom && !game.online && _status.gameStarted) {
      recordCaptureOutcome("CAPTURE_BLOCKED", readiness.code, kind);
    }
    return;
  }
  if (busy) {
    // A boundary is a narrow synchronous moment, so capture it NOW and
    // defer only encryption/IndexedDB writing. Do not lose it to a timer.
    if (kind === "turn_boundary") {
      try {
        pendingBoundary = { roomId: game.roomId, snapshot: captureCandidate(kind) };
      } catch (error) {
        recordCaptureOutcome("BOUNDARY_CAPTURE_FAILED",
          publicV3CaptureCode(error instanceof Error ? error.message : ""),
          "turn_boundary");
      }
    }
    return;
  }
  busy = true;
  try {
    const roomId = game.roomId;
    const snapshot = captured || captureCandidate(kind);
    const key = await cryptoKey(roomId, true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, snapshot.bytes)
    );
    if (roomId !== game.roomId || !game.onlineroom) return;
    await transact("readwrite", store => store.put({
      roomId: kind === "turn_boundary" ? roomId + BOUNDARY_SUFFIX : roomId,
      schema: SCHEMA,
      capturedAt: snapshot.capturedAt,
      playerCount: snapshot.playerCount,
      drawPileCount: snapshot.drawPileCount,
      discardPileCount: snapshot.discardPileCount,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(encrypted),
    }));
    recordCaptureOutcome("ENCRYPTED_CANDIDATE_SAVED", null, kind, roomId);
  } catch (error) {
    recordCaptureOutcome("CAPTURE_FAILED",
      publicV3CaptureCode(error instanceof Error ? error.message : ""),
      kind);
  } finally {
    busy = false;
    if (pendingBoundary) {
      const next = pendingBoundary;
      pendingBoundary = null;
      if (activeOwner() && game.roomId === next.roomId) {
        void saveCandidate("turn_boundary", next.snapshot);
      }
    }
  }
}

/**
 * Internal handoff for the future authoritative host-restoration engine.
 * This returns SENSITIVE decrypted candidate data to trusted in-origin code.
 * Do not log, display, postMessage, or transmit the result to guests.
 *
 * It does NOT make the data executable or mark it as a certified checkpoint.
 */
export async function loadLocalCandidateForEngine(roomId, kind = "turn_boundary") {
  if (!validRoomId(roomId) || !["periodic", "turn_boundary"].includes(kind)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  try {
    const recordKey = kind === "turn_boundary" ? roomId + BOUNDARY_SUFFIX : roomId;
    const record = await transact("readonly", store => store.get(recordKey));
    if (!record || record.schema !== SCHEMA) return { ok: false, code: "CANDIDATE_NOT_FOUND" };
    if (Date.now() - record.capturedAt > MAX_AGE_MS) return { ok: false, code: "CANDIDATE_EXPIRED" };
    const key = await cryptoKey(roomId, false);
    const iv = decodeBase64(record.iv);
    if (iv.length !== 12) return { ok: false, code: "INVALID_IV" };
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv }, key, decodeBase64(record.ciphertext)
    );
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    const ids = Object.keys(data.arena?.players || {});
    if (data.schema !== SCHEMA || data.roomId !== roomId ||
        data.observationKind !== kind ||
        data.config?.mode !== "xingBei" ||
        !Array.isArray(data.drawPile) || !Array.isArray(data.discardPile) ||
        !ids.length || ids.length > 8 ||
        ids.length !== record.playerCount ||
        typeof data.hostPlayerId !== "string" || !ids.includes(data.hostPlayerId) ||
        !Array.isArray(data.peerBindings) ||
        data.peerBindings.length !== ids.length - 1 ||
        new Set(data.peerBindings.map(b => b?.socketId)).size !== data.peerBindings.length ||
        data.peerBindings.some(b =>
          typeof b?.playerId !== "string" || typeof b?.socketId !== "string" ||
          b.playerId !== b.socketId ||
          !ids.includes(b.playerId) || b.playerId === data.hostPlayerId
        ) ||
        ids.some(id => !data.skills?.[id] || !data.playerExecution?.[id]) ||
        data.structuralAudit?.arenaVerified !== true ||
        data.structuralAudit?.skillStateVerified !== true ||
        data.structuralAudit?.playerHistoryVerified !== true ||
        data.safeCheckpointCertified !== false ||
        data.eventContinuationCaptured !== false ||
        data.restorable !== false ||
        (kind === "turn_boundary" &&
         (!data.nextTurnPlayerId || !data.arena.players[data.nextTurnPlayerId]))) {
      return { ok: false, code: "CANDIDATE_SHAPE_INVALID" };
    }
    // No event/phase resume is performed here.
    return {
      ok: true,
      kind,
      data,
      safeCheckpointCertified: false,
      eventContinuationCaptured: false,
      restorable: false,
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error ? error.message : "LOAD_FAILED",
      restorable: false,
    };
  }
}

export async function inspectLocalRecoveryCandidate(roomId) {
  if (!validRoomId(roomId)) return { status: "INVALID_ROOM" };
  try {
    // These two records are saved independently. A failed periodic capture
    // must not hide a valid turn-boundary candidate from read-only preflight.
    const [periodic, boundary] = await Promise.all([
      transact("readonly", store => store.get(roomId)),
      transact("readonly", store => store.get(roomId + BOUNDARY_SUFFIX))
    ]);
    if (!periodic && !boundary) {
      return { status:"NOT_FOUND", turnBoundaryStatus:"NOT_FOUND", restorable:false };
    }
    const now = Date.now();
    let keyPromise;
    const decrypt = async record => {
      if (!keyPromise) keyPromise = cryptoKey(roomId, false);
      const key = await keyPromise;
      const iv = decodeBase64(record.iv);
      if (iv.length !== 12) throw new Error("INVALID_IV");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv }, key, decodeBase64(record.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    };
    const [periodicResult, boundaryResult] = await Promise.all([
      inspectV3EncryptedRecord({ record:periodic, roomId, kind:"periodic",
        now, maxAgeMs:MAX_AGE_MS, decrypt }),
      inspectV3EncryptedRecord({ record:boundary, roomId, kind:"turn_boundary",
        now, maxAgeMs:MAX_AGE_MS, decrypt })
    ]);
    return {
      status:periodicResult.status,
      code:periodicResult.code || null,
      ageSeconds:periodicResult.ageSeconds ?? boundaryResult.ageSeconds ?? null,
      playerCount:periodicResult.playerCount ?? boundaryResult.playerCount ?? null,
      turnBoundaryStatus:boundaryResult.status,
      turnBoundaryCode:boundaryResult.code || null,
      restorable:false,
      eventContinuationCaptured:false,
    };
  } catch {
    return { status:"UNAVAILABLE", code:"INVENTORY_READ_FAILED",
      turnBoundaryStatus:"UNAVAILABLE", restorable:false };
  }
}

export async function purgeLocalRecoveryCandidate(roomId) {
  if (!validRoomId(roomId)) return false;
  try {
    await transact("readwrite", store => store.delete(roomId));
    await transact("readwrite", store => store.delete(roomId + BOUNDARY_SUFFIX));
    sessionStorage.removeItem(sessionKeyName(roomId));
    sessionStorage.removeItem(DIAGNOSTIC_PREFIX + roomId);
    return true;
  } catch {
    return false;
  }
}

export function getLocalVaultStatus(roomId) {
  // Read only metadata from the same tab; no credentials or raw state.
  let persisted = null;
  if (validRoomId(roomId)) {
    try {
      persisted = parseV3CaptureDiagnostic(
        sessionStorage.getItem(DIAGNOSTIC_PREFIX + roomId), Date.now(), MAX_AGE_MS
      );
    } catch {
      // sessionStorage may be unavailable in private browsing.
    }
  }
  const fallback = roomId === lastOutcomeRoomId
    ? lastOutcome : { status:"NOT_YET_CAPTURED" };
  return { ...(persisted || fallback), restorable: false, serverStored: false };
}

export function installV3RecoveryVault() {
  if (installed) return;
  installed = true;
  setInterval(() => { void saveCandidate(); }, INTERVAL_MS);
  // 'phaseLoop' calls lib.onphase before scheduling the next phase.
  // Persist a separate candidate for that transition. This is stronger than
  // a random timer sample, but still NOT a certified resumable checkpoint:
  // execution locals / promises / choice callbacks remain unrecorded.
  if (Array.isArray(lib.onphase)) {
    lib.onphase.push(() => {
      if (!activeOwner() || lib.configOL?.mode !== "xingBei") return;
      const stack = _status.eventManager?.eventStack;
      const current = stack?.at(-1);
      if (!Array.isArray(stack) || current?.name !== "phaseLoop" ||
          !current.player?.playerid ||
          stack.some(event => event !== current && event?.next?.length > 0)) return;
      void saveCandidate("turn_boundary");
    });
  }
}
