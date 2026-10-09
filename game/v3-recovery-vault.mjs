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

const DB_NAME = "xingbei-v3-playtest-recovery";
const STORE = "encryptedCandidates";
const VERSION = 1;
const SCHEMA = "xingbei-v3-candidate-1";
const KEY_PREFIX = "xingbei-v3-recovery-aes:";
const INTERVAL_MS = 6000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 10 * 60 * 1000;
let installed = false;
let busy = false;
let lastOutcome = { status: "NOT_YET_CAPTURED" };

function validRoomId(id) {
  return typeof id === "string" && id.length > 0 && id.length < 128;
}

function activeOwner() {
  return Boolean(
    game.onlineroom && !game.online && _status.connectMode &&
    _status.gameStarted && game.ws?.readyState === WebSocket.OPEN &&
    validRoomId(game.roomId) && game.players?.length &&
    ui.cardPile && ui.discardPile &&
    typeof get.arenaState === "function" &&
    typeof get.skillState === "function"
  );
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

function captureCandidate() {
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
  const state = {
    schema: SCHEMA,
    capturedAt: Date.now(),
    roomId: game.roomId,
    phaseNumber: game.phaseNumber ?? null,
    roundNumber: game.roundNumber ?? null,
    currentPhaseId: _status.currentPhase?.playerid ?? null,
    arena: get.stringifiedResult(arena),
    skills: get.stringifiedResult(skills),
    drawPile: get.cardsInfoOL(Array.from(ui.cardPile.children)),
    discardPile: get.cardsInfoOL(Array.from(ui.discardPile.children)),
    gameState: typeof game.getState === "function"
      ? get.stringifiedResult(game.getState()) : null,
    config: get.stringifiedResult(lib.configOL),
    cardtag: get.stringifiedResult(_status.cardtag),
    eventObservation: {
      // Event continuations, Promises, closure locals and outstanding
      // responses are not encoded by these fields.
      stackDepth: _status.eventManager?.eventStack?.length ?? null,
      activeEventName: _status.event?.name ?? null,
      activeEventStep: _status.event?.step ?? null,
      paused: Boolean(_status.paused),
    },
    safeCheckpointCertified: false,
    eventContinuationCaptured: false,
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
      decoded.discardPile.length !== ui.discardPile.children.length) {
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

async function saveCandidate() {
  if (busy || !activeOwner()) return;
  busy = true;
  try {
    const roomId = game.roomId;
    const snapshot = captureCandidate();
    const key = await cryptoKey(roomId, true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, snapshot.bytes)
    );
    if (roomId !== game.roomId || !game.onlineroom) return;
    await transact("readwrite", store => store.put({
      roomId,
      schema: SCHEMA,
      capturedAt: snapshot.capturedAt,
      playerCount: snapshot.playerCount,
      drawPileCount: snapshot.drawPileCount,
      discardPileCount: snapshot.discardPileCount,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(encrypted),
    }));
    lastOutcome = { status: "ENCRYPTED_CANDIDATE_SAVED", capturedAt: snapshot.capturedAt };
  } catch (error) {
    lastOutcome = {
      status: "CAPTURE_FAILED",
      code: error instanceof Error ? error.message : "UnknownError",
    };
  } finally {
    busy = false;
  }
}

export async function inspectLocalRecoveryCandidate(roomId) {
  if (!validRoomId(roomId)) return { status: "INVALID_ROOM" };
  try {
    const candidate = await transact("readonly", store => store.get(roomId));
    if (!candidate) return { status: "NOT_FOUND" };
    const ageMs = Math.max(0, Date.now() - candidate.capturedAt);
    if (ageMs > MAX_AGE_MS) return { status: "EXPIRED", ageSeconds: Math.floor(ageMs / 1000) };
    const key = await cryptoKey(roomId, false);
    const iv = decodeBase64(candidate.iv);
    if (iv.length !== 12) throw new Error("INVALID_IV");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv }, key, decodeBase64(candidate.ciphertext)
    );
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    if (data.schema !== SCHEMA || data.roomId !== roomId ||
        data.safeCheckpointCertified !== false ||
        data.eventContinuationCaptured !== false ||
        data.restorable !== false) {
      throw new Error("INVALID_CANDIDATE_SCHEMA");
    }
    // Do NOT return the raw state (which includes hidden information).
    return {
      status: "ENCRYPTED_CANDIDATE_VERIFIED",
      ageSeconds: Math.floor(ageMs / 1000),
      playerCount: candidate.playerCount,
      restorable: false,
      eventContinuationCaptured: false,
    };
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      code: error instanceof Error ? error.message : "UnknownError",
    };
  }
}

export async function purgeLocalRecoveryCandidate(roomId) {
  if (!validRoomId(roomId)) return false;
  try {
    await transact("readwrite", store => store.delete(roomId));
    sessionStorage.removeItem(sessionKeyName(roomId));
    return true;
  } catch {
    return false;
  }
}

export function getLocalVaultStatus() {
  // Status only; never expose the encrypted payload or key.
  return { ...lastOutcome, restorable: false, serverStored: false };
}

export function installV3RecoveryVault() {
  if (installed) return;
  installed = true;
  setInterval(() => { void saveCandidate(); }, INTERVAL_MS);
}
