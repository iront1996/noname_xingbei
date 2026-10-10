/**
 * V3 cold-host rehydration blueprint.
 *
 * Converts the locally decrypted candidate into a validated PRIVATE plan for
 * future authoritative engine setup. No DOM, WebSocket, timers, event
 * scheduler, or global game state are mutated. No continuation is installed.
 *
 * A blueprint is NOT a resumed or playable game.
 */
import { evaluateColdOwnerPreflight } from "./v3-host-authority-gate.mjs";

const MAX_DECK_CARDS = 1200;
const CARD_TAG = "_noname_card:";
const BOUNDARY = "turn_boundary";

function reject(code) {
  return {
    ok: false,
    code,
    blueprint: null,
    authoritativeRuntimeRebuilt: false,
    eventContinuationInstalled: false,
    readyToResume: false,
  };
}

function parsePhysicalCard(serialized, ids) {
  if (typeof serialized !== "string" ||
      !serialized.startsWith(CARD_TAG)) return null;
  let fields;
  try {
    fields = JSON.parse(serialized.slice(CARD_TAG.length));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length !== 5) return null;
  const cardId = fields[0];
  if (typeof cardId !== "string" || !cardId ||
      cardId.length > 128 || ids.has(cardId)) return null;
  ids.add(cardId);
  // Retain exact encoded engine card data; do not create mutable Cards yet.
  return Object.freeze({ cardId, serialized });
}

/**
 * PRIVATE DATA WARNING: 'blueprint' contains hidden hands, skills and
 * deck order. It must stay inside the trusted authoritative client.
 * UI receives only the separate metadata field.
 */
export function buildHostRehydrationBlueprint(candidate, serverClaim, now = Date.now()) {
  const gate = evaluateColdOwnerPreflight(candidate, serverClaim, now);
  if (!gate.ok) return reject(gate.code);

  if (candidate.observationKind !== BOUNDARY ||
      candidate.arena?.mode == null ||
      typeof candidate.arena?.players !== "object") {
    return reject("ARENA_METADATA_MISSING");
  }
  const playerIds = Object.keys(candidate.arena.players);
  const uniqueSeats = new Set();
  const seats = [];
  for (const id of playerIds) {
    const state = candidate.arena.players[id];
    if (!state || !Number.isInteger(state.position) ||
        state.position < 0 || state.position >= playerIds.length ||
        uniqueSeats.has(state.position) ||
        typeof state.name1 !== "string" || !state.name1 ||
        !Number.isFinite(state.hp) || !Number.isFinite(state.maxHp)) {
      return reject("PLAYER_SEAT_OR_STATE_INVALID");
    }
    uniqueSeats.add(state.position);
    seats.push(Object.freeze({
      playerId: id,
      originalSeat: state.position,
      state,
      skills: candidate.skills[id],
      execution: candidate.playerExecution[id],
      originalHost: id === candidate.hostPlayerId,
    }));
  }
  seats.sort((a, b) => a.originalSeat - b.originalSeat);

  if (candidate.drawPile.length + candidate.discardPile.length > MAX_DECK_CARDS) {
    return reject("CARD_PILES_TOO_LARGE");
  }
  const ids = new Set();
  const drawPile = [];
  const discardPile = [];
  for (const card of candidate.drawPile) {
    const decoded = parsePhysicalCard(card, ids);
    if (!decoded) return reject("DRAW_PILE_CARD_INVALID_OR_DUPLICATE");
    drawPile.push(decoded);
  }
  for (const card of candidate.discardPile) {
    const decoded = parsePhysicalCard(card, ids);
    if (!decoded) return reject("DISCARD_PILE_CARD_INVALID_OR_DUPLICATE");
    discardPile.push(decoded);
  }

  const routes = [];
  for (const bind of candidate.peerBindings) {
    routes.push(Object.freeze({
      playerId: bind.playerId,
      socketId: bind.socketId,
      // These are original, still-connected guest sockets, NOT new clients.
    }));
  }

  // Blueprint never performs any state mutation or starts a phase.
  const blueprint = Object.freeze({
    schema: "xingbei-v3-host-runtime-blueprint-1",
    roomId: candidate.roomId,
    mode: "xingBei",
    hostPlayerId: candidate.hostPlayerId,
    playerSeats: Object.freeze(seats),
    remoteRoutes: Object.freeze(routes),
    botPlayerIds: Object.freeze([...(candidate.botPlayerIds || [])]),
    drawPile: Object.freeze(drawPile),
    discardPile: Object.freeze(discardPile),
    modeState: candidate.gameState,
    cardTags: candidate.cardtag,
    config: candidate.config,
    phaseNumber: candidate.phaseNumber,
    roundNumber: candidate.roundNumber,
    nextTurnPlayerId: candidate.nextTurnPlayerId,
    currentPhaseId: candidate.currentPhaseId,
    roundStartPlayerId: candidate.roundStartPlayerId,
    lastPhasedPlayerId: candidate.lastPhasedPlayerId,
    eventOutline: candidate.eventObservation.stackOutline,
    authoritativeRuntimeRebuilt: false,
    eventContinuationInstalled: false,
    readyToResume: false,
  });

  return {
    ok: true,
    blueprint,
    summary: Object.freeze({
      seatsMapped: seats.length,
      originalRemoteSocketsMapped: routes.length,
      botSeatsMapped: candidate.botPlayerIds?.length || 0,
      drawPileCardsMapped: drawPile.length,
      discardPileCardsMapped: discardPile.length,
      eventOutlineCount: blueprint.eventOutline.length,
      authoritativeRuntimeRebuilt: false,
      eventContinuationInstalled: false,
      readyToResume: false,
    }),
    authoritativeRuntimeRebuilt: false,
    eventContinuationInstalled: false,
    readyToResume: false,
  };
}
