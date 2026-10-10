/**
 * V3 playtest: shadow authoritative registry / reversible dry-run.
 *
 * This module does NOT install to the actual browser game. The caller
 * must supply a separate target, and any temporary writes are rolled
 * back before returning, even on exception.
 *
 * The live host-restoration commit is deliberately NOT implemented:
 * activating cards, skills, timers and GameEvent continuations is missing.
 */
function fail(code) {
  return {ok:false,code,readyToResume:false,authoritativeRuntimeRebuilt:false};
}
function plainRecordFromMap(map) {
  const record=Object.create(null);
  for(const [id,value] of map) {
    if(typeof id!=="string" || !id || id==="__proto__" ||
       id==="constructor" || id==="prototype") return null;
    if(Object.prototype.hasOwnProperty.call(record,id))return null;
    record[id]=value;
  }
  return record;
}

/**
 * Retains sensitive Player/Card references in the PRIVATE shadow only.
 * Never send or JSON.stringify this object or expose it to client UI.
 */
export function prepareShadowHostRegistry(staged,skillResult,blueprint) {
  if(!staged?.ok || !skillResult?.ok || !skillResult.applied ||
     staged.readyToResume!==false || skillResult.readyToResume!==false ||
     blueprint?.schema!=="xingbei-v3-host-runtime-blueprint-1" ||
     blueprint.readyToResume!==false ||
     !(staged.runtime?.players instanceof Map) ||
     !(staged.runtime?.cards instanceof Map) ||
     !(staged.runtime?.dormantRemoteClients instanceof Map)) {
    return fail("PRECONDITIONS_NOT_MET");
  }
  const runtime=staged.runtime;
  const allSeats=blueprint.playerSeats;
  const playerRefs=new Map();
  const physicalCards=new Map();
  const originalClients=new Map();
  const alive=[];
  const dead=[];
  for(const seat of allSeats) {
    const stagedEntry=runtime.players.get(seat.playerId);
    if(!stagedEntry || stagedEntry.player?.playerid!==seat.playerId ||
       Number(stagedEntry.player.dataset?.position)!==seat.originalSeat ||
       playerRefs.has(seat.playerId))return fail("PLAYER_IDENTITY_CONFLICT");
    const player=stagedEntry.player;
    playerRefs.set(seat.playerId,player);
    if(seat.state?.dead)dead.push(player);else alive.push(player);
  }
  if(playerRefs.size!==runtime.players.size)return fail("PLAYER_SET_EXTRA");
  const botIds=blueprint.botPlayerIds;
  if(!playerRefs.has(blueprint.hostPlayerId) ||
     !Array.isArray(botIds) ||
     !(runtime.botPlayerIds instanceof Array) ||
     botIds.length!==runtime.botPlayerIds.length ||
     botIds.some(id=>!runtime.botPlayerIds.includes(id) || !playerRefs.has(id) ||
       id===blueprint.hostPlayerId) ||
     new Set(botIds).size!==botIds.length ||
     blueprint.remoteRoutes.length<1 ||
     blueprint.remoteRoutes.length+botIds.length!==playerRefs.size-1) {
    return fail("HOST_OR_ROUTES_INVALID");
  }
  for(const entry of blueprint.remoteRoutes) {
    const client=runtime.dormantRemoteClients.get(entry.socketId);
    if(!client || !client.closed || client.id!==entry.socketId ||
       !playerRefs.has(entry.playerId) ||
       entry.socketId!==entry.playerId ||
       originalClients.has(entry.socketId) ||
       entry.playerId===blueprint.hostPlayerId){
      return fail("UNSAFE_OR_DUPLICATE_CLIENT");
    }
    originalClients.set(entry.socketId,client);
  }
  if(originalClients.size!==runtime.dormantRemoteClients.size) {
    return fail("UNMAPPED_REMOTE_CLIENT");
  }
  for(const [id,card] of runtime.cards) {
    if(!card || card.cardid!==id || physicalCards.has(id)) {
      return fail("CARD_IDENTITY_CONFLICT");
    }
    physicalCards.set(id,card);
  }
  const pObj=plainRecordFromMap(playerRefs);
  const cObj=plainRecordFromMap(physicalCards);
  if(!pObj||!cObj)return fail("REGISTRY_KEY_INVALID");
  return {
    ok:true,
    shadow:Object.freeze({
      game:Object.freeze({
        players:Object.freeze(alive),
        dead:Object.freeze(dead),
        me:playerRefs.get(blueprint.hostPlayerId),
        phaseNumber:blueprint.phaseNumber,
        roundNumber:blueprint.roundNumber,
      }),
      lib:Object.freeze({
        playerOL:pObj,
        cardOL:cObj,
        // Remote clients remain CLOSED and cannot send messages.
        clients:Object.freeze([...originalClients.values()]),
      }),
      // Critical: does not contain a PhaseLoop, action journal, reinit or
      // choice continuation; it is not sufficient to run a match.
      botSeatCount:botIds.length,
      eventContinuationInstalled:false,
      readyToResume:false,
    }),
    summary:Object.freeze({
      mappedPlayers:playerRefs.size,
      livingPlayers:alive.length,
      deadPlayers:dead.length,
      cards:physicalCards.size,
      dormantRemoteClients:originalClients.size,
      botSeats:botIds.length,
      readyToResume:false,
      authoritativeRuntimeRebuilt:false,
    }),
    readyToResume:false,
    authoritativeRuntimeRebuilt:false,
  };
}

/**
 * Unit-test-only reversible installation rehearsal, in an explicitly
 * injected target object. NEVER pass the real game/lib runtime here:
 * callbacks and event hooks could observe partially prepared maps.
 *
 * Restores property descriptors, including absence of old properties.
 */
export function rehearseHostRegistrySwap(shadowResult, target, inspect) {
  if(!shadowResult?.ok || !shadowResult.shadow ||
     typeof inspect!=="function" ||
     !target?.game || !target?.lib || !target.lib.node ||
     !Object.isExtensible(target.game) ||
     !Object.isExtensible(target.lib) ||
     !Object.isExtensible(target.lib.node))return fail("DRY_RUN_INVALID");
  const undo=[];
  const replacements=[
    [target.game,"players",shadowResult.shadow.game.players],
    [target.game,"dead",shadowResult.shadow.game.dead],
    [target.game,"me",shadowResult.shadow.game.me],
    [target.game,"phaseNumber",shadowResult.shadow.game.phaseNumber],
    [target.game,"roundNumber",shadowResult.shadow.game.roundNumber],
    [target.lib,"playerOL",shadowResult.shadow.lib.playerOL],
    [target.lib,"cardOL",shadowResult.shadow.lib.cardOL],
    [target.lib.node,"clients",shadowResult.shadow.lib.clients],
  ];
  let code=null;
  try{
    for(const [object,key,value] of replacements) {
      const old=Object.getOwnPropertyDescriptor(object,key);
      if(old && old.configurable===false)throw Error("TARGET_PROPERTY_LOCKED");
      undo.push({object,key,old});
      Object.defineProperty(object,key,{
        value,writable:true,configurable:true,enumerable:true
      });
    }
    // Inspect synchronously. No output includes raw player or hand state.
    if(inspect(target)!==true)throw Error("DRY_RUN_INSPECTION_FAILED");
  }catch(e){
    code=e instanceof Error&&/^[A-Z_]+$/.test(e.message)
      ?e.message:"DRY_RUN_FAILED";
  }finally{
    for(let i=undo.length-1;i>=0;i--){
      const {object,key,old}=undo[i];
      if(old)Object.defineProperty(object,key,old);
      else delete object[key];
    }
  }
  if(code)return fail(code);
  return {
    ok:true,
    rolledBack:true,
    authoritativeRuntimeRebuilt:false,
    readyToResume:false,
  };
}
