/**
 * V3 preview: cold-owner authority reconstruction preflight.
 * Pure validation; does not mutate any game engine, room, or WebSocket.
 *
 * NEVER treat this check as a certified event checkpoint. A valid peer
 * mapping is necessary but insufficient to resume a running game.
 */
const CANDIDATE_SCHEMA = "xingbei-v3-candidate-1";
const GATE_SCHEMA = "xingbei-v3-authority-preflight-1";
const MAX_CANDIDATE_AGE_MS = 10 * 60 * 1000;
const MAX_PLAYERS = 8;

function reject(code) {
  return Object.freeze({
    ok: false,
    code,
    schema: GATE_SCHEMA,
    originalGuestSocketsMatched: false,
    authoritativeRuntimeRebuilt: false,
    eventContinuationCaptured: false,
    readyToResume: false,
  });
}

/**
 * @param {object} data - decrypted local candidate; NEVER send to server.
 * @param {object} claim - authorized response from the paused-room broker.
 * @returns only metadata. No hidden cards, player ids, encryption tokens.
 */
export function evaluateColdOwnerPreflight(data, claim, now = Date.now()) {
  if (!data || data.schema !== CANDIDATE_SCHEMA ||
      data.observationKind !== "turn_boundary" ||
      data.config?.mode !== "xingBei" ||
      !data.roomId || data.roomId !== claim?.roomId ||
      claim?.schema !== GATE_SCHEMA ||
      claim?.state !== "paused_owner_missing" ||
      claim?.roomStarted !== true) return reject("ROOM_OR_CANDIDATE_MISMATCH");

  if (!Number.isFinite(data.capturedAt) || !Number.isFinite(now) ||
      now < data.capturedAt || now - data.capturedAt > MAX_CANDIDATE_AGE_MS) {
    return reject("CANDIDATE_AGE_INVALID");
  }
  // Require explicit negative flags in every candidate until certified
  // action/continuation journaling has been implemented.
  if (data.restorable !== false ||
      data.safeCheckpointCertified !== false ||
      data.eventContinuationCaptured !== false ||
      data.playerHistoryCompletenessVerified !== false) {
    return reject("CANDIDATE_FLAGS_UNTRUSTED");
  }
  const playerIds = Object.keys(data.arena?.players || {});
  if (playerIds.length < 2 || playerIds.length > MAX_PLAYERS ||
      !playerIds.includes(data.hostPlayerId) ||
      data.nextTurnPlayerId == null ||
      !playerIds.includes(data.nextTurnPlayerId) ||
      !Array.isArray(data.peerBindings) ||
      !Array.isArray(claim.guestSocketIds) ||
      claim.guestSocketIds.length !== playerIds.length - 1 ||
      data.peerBindings.length !== playerIds.length - 1) {
    return reject("PLAYER_SET_INCONSISTENT");
  }
  const claimIds = new Set();
  for (const id of claim.guestSocketIds) {
    if (typeof id !== "string" || !id || claimIds.has(id)) {
      return reject("SERVER_ROSTER_INVALID");
    }
    claimIds.add(id);
  }
  const boundIds = new Set();
  for (const binding of data.peerBindings) {
    if (typeof binding?.playerId !== "string" ||
        typeof binding?.socketId !== "string" ||
        binding.playerId !== binding.socketId ||
        binding.playerId === data.hostPlayerId ||
        !playerIds.includes(binding.playerId) ||
        boundIds.has(binding.socketId) ||
        !claimIds.has(binding.socketId)) {
      return reject("ORIGINAL_PEER_SOCKET_MISMATCH");
    }
    boundIds.add(binding.socketId);
  }
  if (boundIds.size !== claimIds.size ||
      !Array.isArray(data.drawPile) || !Array.isArray(data.discardPile) ||
      !playerIds.every(id => Boolean(data.skills?.[id] && data.playerExecution?.[id])) ||
      !Number.isInteger(data.phaseNumber) ||
      !Number.isInteger(data.roundNumber)) {
    return reject("GAME_STATE_SHAPE_INCOMPLETE");
  }
  const stack = data.eventObservation?.stackOutline;
  if (!Array.isArray(stack) || stack.length < 1) {
    return reject("EVENT_OUTLINE_ABSENT");
  }

  // Private data is deliberately not copied into the result. In particular,
  // neither the original player IDs nor card lists nor room credentials
  // are exposed outside the trusted game module.
  return Object.freeze({
    ok: true,
    schema: GATE_SCHEMA,
    originalGuestSocketsMatched: true,
    playerCount: playerIds.length,
    pendingBufferedGuestMessageCount: Number.isInteger(claim.bufferedGuestMessageCount)
      ? claim.bufferedGuestMessageCount : null,
    retainedTurnBoundaryCandidate: true,
    authoritativeRuntimeRebuilt: false,
    eventContinuationCaptured: false,
    readyToResume: false,
    nextBlocker: "ENGINE_RUNTIME_AND_EVENT_CONTINUATION_NOT_REBUILT",
  });
}
