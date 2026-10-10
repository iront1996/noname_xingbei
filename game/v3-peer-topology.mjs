/**
 * V3 host-only peer topology extraction. Every connected human must map to
 * exactly one active engine player and a broker socket. Unoccupied seats
 * created by game.randomMapOL() have no Player.ws and are explicitly AI.
 *
 * This is structural evidence, NOT proof of a restorable game checkpoint.
 * Caller must keep peerBindings and botPlayerIds private.
 */
function reject(code) {
  return { ok:false, code, peerBindings:null, botPlayerIds:null };
}
export function classifyV3HostPeerTopology({
  playerIds, playerOL, clients, observing, hostPlayerId
}) {
  if (!Array.isArray(playerIds) || playerIds.length < 2 ||
      playerIds.length > 8 || new Set(playerIds).size !== playerIds.length ||
      playerIds.some(id => typeof id !== "string" || !id) ||
      !playerIds.includes(hostPlayerId) ||
      !playerOL || typeof playerOL !== "object" ||
      !Array.isArray(clients) || !Array.isArray(observing)) {
    return reject("TOPOLOGY_INPUT_INVALID");
  }
  const players = new Set(playerIds);
  const byHuman = new Map();
  const bySocket = new Set();
  for (const client of clients) {
    const playerId = client?.id, socketId = client?.ws?.wsid;
    // Every broker guest must be an initialized and unique participant;
    // observers, unknown/uninitialized sockets and reconnect races fail closed.
    if (client?.closed || client?.inited !== true ||
        typeof playerId !== "string" || !playerId ||
        typeof socketId !== "string" || !socketId ||
        playerId !== socketId || playerId === hostPlayerId ||
        !players.has(playerId) || observing.includes(client) ||
        byHuman.has(playerId) || bySocket.has(socketId)) {
      return reject("PEER_BINDING_INCOMPLETE");
    }
    if (playerOL[playerId]?.ws !== client) {
      return reject("PEER_PLAYER_SOCKET_MISMATCH");
    }
    byHuman.set(playerId, client);
    bySocket.add(socketId);
  }
  // The paused server's v3restoreprobe requires at least one guest socket.
  if (byHuman.size < 1 || byHuman.size > 7) {
    return reject("PEER_COUNT_UNSUPPORTED");
  }
  const botPlayerIds = [];
  for (const playerId of playerIds) {
    const player = playerOL[playerId];
    if (!player) return reject("PLAYER_RUNTIME_MISSING");
    if (playerId === hostPlayerId) {
      // Host is local authority; it cannot masquerade as a broker guest.
      if (player.ws || byHuman.has(playerId)) return reject("HOST_PLAYER_MAPPING_INVALID");
    } else if (!byHuman.has(playerId)) {
      // A missing/disconnected human with a lingering ws may not be silently
      // counted as an AI seat. Only seats with no WS binding count as bots.
      if (player.ws) return reject("UNBOUND_HUMAN_PLAYER");
      botPlayerIds.push(playerId);
    }
  }
  const peerBindings = [...byHuman.keys()].sort().map(playerId => ({
    playerId, socketId: byHuman.get(playerId).ws.wsid
  }));
  if (peerBindings.length + botPlayerIds.length + 1 !== playerIds.length) {
    return reject("PEER_TOPOLOGY_INCONSISTENT");
  }
  return {ok:true, peerBindings, botPlayerIds:botPlayerIds.sort()};
}
