/**
 * V3 Playtest - disconnected host native-object staging (NOT restoration).
 *
 * Uses real Player / Card / Client / NodeWS engine classes, allocated under
 * an off-document DocumentFragment. No object is installed in game.players,
 * game.me, lib.playerOL, lib.cardOL, lib.node.clients or the live UI.
 *
 * Cards are deliberately NOT Card.init()-ed (that method adds global skills
 * and registers cards), nor are skills, histories or waiting callbacks
 * reactivated. Client objects are born closed, so send() cannot relay.
 *
 * This is an isolated preparation layer for later transactional rehydration.
 * Never broadcast, resume or declare a playable checkpoint from this module.
 */
import { lib } from "../noname.js";

const ZONES = ["handcards", "equips", "judges", "expansions"];
const PREFIX = "_noname_card:";
const MAX_CARDS = 1200;

function failure(code) {
  return {
    ok: false,
    code,
    runtime: null,
    authoritativeRuntimeRebuilt: false,
    engineContinuationInstalled: false,
    readyToResume: false,
  };
}

function readCard(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith(PREFIX)) return null;
  try {
    const info = JSON.parse(encoded.slice(PREFIX.length));
    if (!Array.isArray(info) || info.length !== 5 ||
        typeof info[0] !== "string" || !info[0] ||
        info[0].length > 128 || typeof info[3] !== "string" ||
        !info[3]) return null;
    return info;
  } catch {
    return null;
  }
}

function planNativeZones(blueprint) {
  if (!blueprint || blueprint.schema !== "xingbei-v3-host-runtime-blueprint-1" ||
      !Array.isArray(blueprint.playerSeats) ||
      !Array.isArray(blueprint.remoteRoutes) ||
      !Array.isArray(blueprint.drawPile) ||
      !Array.isArray(blueprint.discardPile) ||
      blueprint.readyToResume !== false ||
      blueprint.authoritativeRuntimeRebuilt !== false) return failure("INVALID_BLUEPRINT");

  const ids = new Set();
  const layouts = [];
  const zones = [];
  const addCard = (encoded, zone, owner) => {
    const info = readCard(encoded);
    if (!info) return "CARD_ENCODING_INVALID";
    if (ids.has(info[0])) return "CARD_REPEATED_ACROSS_ZONES";
    if (ids.size >= MAX_CARDS) return "CARD_COUNT_EXCEEDED";
    ids.add(info[0]);
    zones.push({ cardId: info[0], encoded, info, zone, owner });
    return null;
  };

  for (const seat of blueprint.playerSeats) {
    if (!seat || typeof seat.playerId !== "string" ||
        !seat.state || !seat.skills ||
        !seat.execution || !Number.isInteger(seat.originalSeat)) {
      return failure("PLAYER_STAGE_SHAPE_INVALID");
    }
    const playerZones = {};
    for (const zone of ZONES) {
      const encodedCards = seat.state[zone];
      if (!Array.isArray(encodedCards)) return failure("PLAYER_ZONE_MISSING");
      playerZones[zone] = [];
      for (const encoded of encodedCards) {
        const error = addCard(encoded, zone, seat.playerId);
        if (error) return failure(error);
        playerZones[zone].push(readCard(encoded)[0]);
      }
    }
    // specials (getCards('s')) is a subset of handcards (getCards('hs'))
    // in this engine. Do not instantiate a second card for this alias.
    if (!Array.isArray(seat.state.specials)) return failure("SPECIAL_ALIAS_INVALID");
    const hand = new Set(playerZones.handcards);
    const specialIds = new Set();
    for (const encoded of seat.state.specials) {
      const info = readCard(encoded);
      if (!info || !hand.has(info[0]) || specialIds.has(info[0])) {
        return failure("SPECIAL_ALIAS_NOT_IN_HAND");
      }
      specialIds.add(info[0]);
    }
    layouts.push({ seat, zones: playerZones, specialIds: [...specialIds] });
  }
  for (const card of blueprint.drawPile) {
    if (!card || typeof card.serialized !== "string" ||
        readCard(card.serialized)?.[0] !== card.cardId) return failure("DRAW_PILE_ENCODING_INVALID");
    const error = addCard(card.serialized, "drawPile", null);
    if (error) return failure(error);
  }
  for (const card of blueprint.discardPile) {
    if (!card || typeof card.serialized !== "string" ||
        readCard(card.serialized)?.[0] !== card.cardId) return failure("DISCARD_PILE_ENCODING_INVALID");
    const error = addCard(card.serialized, "discardPile", null);
    if (error) return failure(error);
  }
  if (blueprint.remoteRoutes.length !== blueprint.playerSeats.length - 1 ||
      !blueprint.playerSeats.some(seat => seat.playerId === blueprint.hostPlayerId)) {
    return failure("REMOTE_ROUTE_COUNT_INVALID");
  }
  return { ok: true, layouts, zones };
}

/**
 * @param {object} blueprint - private validated blueprint, never log it.
 * @param {object} environment - dependency-injected constructors and
 *        DOM factory for unit testing; defaults to actual browser engine.
 */
export function stageDetachedHostRuntime(
  blueprint,
  environment = {
    element: lib.element,
    createFragment: () => document.createDocumentFragment(),
  }
) {
  // Validate everything structural BEFORE creating even detached objects.
  const planned = planNativeZones(blueprint);
  if (!planned.ok) return planned;
  const { element, createFragment } = environment || {};
  if (typeof createFragment !== "function" ||
      typeof element?.Player !== "function" ||
      typeof element?.Card !== "function" ||
      typeof element?.NodeWS !== "function" ||
      typeof element?.Client !== "function") return failure("NATIVE_CONSTRUCTORS_UNAVAILABLE");

  let fragment;
  const byPlayerId = new Map();
  const byCardId = new Map();
  const bySocketId = new Map();
  try {
    fragment = createFragment();
    if (!fragment || typeof fragment.appendChild !== "function") {
      return failure("DETACHED_ROOT_UNAVAILABLE");
    }

    // Make native objects with real Player and Card prototypes, but keep all
    // references in private maps. Never call card.init or player.init.
    for (const item of planned.layouts) {
      const player = new element.Player(fragment);
      if (typeof player.buildProperty !== "function" ||
          typeof player.buildNode !== "function") throw new Error("PLAYER_SHAPE_UNSUPPORTED");
      player.buildProperty();
      player.buildNode();
      player.playerid = item.seat.playerId;
      player.dataset.position = String(item.seat.originalSeat);
      player.name1 = item.seat.state.name1;
      player.name2 = item.seat.state.name2;
      player.name = item.seat.state.name || item.seat.state.name1;
      player.hp = item.seat.state.hp;
      player.maxHp = item.seat.state.maxHp;
      player.side = item.seat.state.side;
      player.identity = item.seat.state.identity;
      player.phaseNumber = item.seat.state.phaseNumber ?? 0;
      // Do NOT apply raw storage/skills here; nested cards and players
      // are still serialized strings and cannot be used by live skill logic.
      byPlayerId.set(item.seat.playerId, {
        player,
        serializedSkillState: item.seat.skills,
        serializedHistory: item.seat.execution,
        cardZoneIds: item.zones,
        specialCardIds: item.specialIds,
      });
    }
    // Seat relationships are installed only in the detached graph.
    const seats = planned.layouts.map(item => byPlayerId.get(item.seat.playerId).player);
    const living = planned.layouts.filter(item => !item.seat.state.dead)
      .map(item => byPlayerId.get(item.seat.playerId).player);
    for (let i = 0; i < seats.length; i++) {
      seats[i].nextSeat = seats[(i + 1) % seats.length];
      seats[i].previousSeat = seats[(i + seats.length - 1) % seats.length];
    }
    for (let i = 0; i < living.length; i++) {
      living[i].next = living[(i + 1) % living.length];
      living[i].previous = living[(i + living.length - 1) % living.length];
    }

    for (const entry of planned.zones) {
      const card = new element.Card(fragment);
      if (typeof card.build !== "function") throw new Error("CARD_SHAPE_UNSUPPORTED");
      card.build("noclick", true);
      card.cardid = entry.cardId;
      card.xiBie = entry.info[1];
      card.mingGe = entry.info[2];
      card.name = entry.info[3];
      card.duYou = entry.info[4];
      byCardId.set(entry.cardId, card);
    }
    for (const route of blueprint.remoteRoutes) {
      if (!byPlayerId.has(route.playerId) || bySocketId.has(route.socketId) ||
          route.socketId !== route.playerId ||
          route.playerId === blueprint.hostPlayerId) {
        throw new Error("REMOTE_ROUTE_UNSAFE");
      }
      const remote = new element.Client(new element.NodeWS(route.socketId), true);
      if (remote.id !== route.socketId) throw new Error("NATIVE_SOCKET_ID_MISMATCH");
      remote.closed = true; // prevent any outbound network traffic
      bySocketId.set(route.socketId, remote);
    }
    if (!byPlayerId.has(blueprint.hostPlayerId) ||
        bySocketId.size !== byPlayerId.size - 1 ||
        byCardId.size !== planned.zones.length) {
      throw new Error("STAGING_INCOMPLETE");
    }

    return {
      ok: true,
      // PRIVATE: retain only in the trusted cold-host controller.
      runtime: {
        fragment,
        players: byPlayerId,
        cards: byCardId,
        dormantRemoteClients: bySocketId,
        originalHostId: blueprint.hostPlayerId,
        // Never transfer to the live game until event continuity exists.
      },
      summary: Object.freeze({
        nativePlayersStaged: byPlayerId.size,
        nativeCardsStaged: byCardId.size,
        dormantRemoteClientsStaged: bySocketId.size,
        detached: true,
        cardInitializationDeferred: true,
        skillActivationDeferred: true,
        authoritativeRuntimeRebuilt: false,
        engineContinuationInstalled: false,
        readyToResume: false,
      }),
      authoritativeRuntimeRebuilt: false,
      engineContinuationInstalled: false,
      readyToResume: false,
    };
  } catch (error) {
    // No global maps were touched; discard private references on failure.
    try { fragment?.replaceChildren?.(); } catch {}
    return failure(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message : "NATIVE_STAGING_FAILED"
    );
  }
}
