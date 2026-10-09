/**
 * V3 detached DOM zone staging. Cards remain uninitialized and offscreen.
 * Every move is confined to a detached native Player/card graph. Failure
 * rolls back the original parent and sibling position, without touching
 * any document-connected node or live engine registry.
 */
const ZONES = ["handcards","equips","judges","expansions"];
const NODES = {
  handcards: "handcards1",
  equips: "equips",
  judges: "judges",
  expansions: "expansions",
};
function reject(code) {
  return {ok:false,code,readyToResume:false,liveUIUpdated:false};
}

export function attachDetachedCardZones(staged,blueprint,environment={createFragment:()=>document.createDocumentFragment()}) {
  if(!staged?.ok || staged.readyToResume!==false ||
     !staged.runtime?.cards || !staged.runtime?.players ||
     blueprint?.readyToResume!==false ||
     blueprint?.schema!=="xingbei-v3-host-runtime-blueprint-1" ||
     typeof environment?.createFragment!=="function")return reject("INVALID_STAGE");
  const {cards,players}=staged.runtime;
  const moves=[];
  const planned=[];
  const used=new Set();
  try{
    for(const seat of blueprint.playerSeats){
      const entry=players.get(seat.playerId);
      if(!entry?.player?.node)throw Error("PLAYER_DOM_MISSING");
      for(const zone of ZONES){
        const container=entry.player.node[NODES[zone]];
        if(!container || typeof container.appendChild!=="function")throw Error("ZONE_CONTAINER_MISSING");
        const ids=entry.cardZoneIds[zone];
        if(!Array.isArray(ids))throw Error("ZONE_MAPPING_MISSING");
        for(const id of ids){
          const card=cards.get(id);
          if(!card||used.has(id))throw Error("CARD_MAPPING_CONFLICT");
          used.add(id);
          planned.push({card,container});
        }
      }
    }
    const draw=environment.createFragment();
    const discard=environment.createFragment();
    if(!draw||!discard||typeof draw.appendChild!=="function"||
       typeof discard.appendChild!=="function")throw Error("DETACHED_PILE_MISSING");
    for(const [pile,container] of [[blueprint.drawPile,draw],[blueprint.discardPile,discard]]){
      if(!Array.isArray(pile))throw Error("PILE_MAPPING_INVALID");
      for(const item of pile){
        const card=cards.get(item.cardId);
        if(!card||used.has(item.cardId))throw Error("CARD_MAPPING_CONFLICT");
        used.add(item.cardId);
        planned.push({card,container});
      }
    }
    if(used.size!==cards.size)throw Error("UNASSIGNED_PHYSICAL_CARDS");

    for(const {card,container} of planned){
      const parent=card.parentNode;
      if(!parent || parent.isConnected || container.isConnected) {
        throw Error("DOCUMENT_CONNECTED_NODE");
      }
      const next=card.nextSibling;
      moves.push({card,parent,next});
      container.appendChild(card);
    }
    return {
      ok:true,
      // PRIVATE: offscreen node graphs only.
      detachedPiles:{draw,discard},
      summary:{
        stagedCardCount:used.size,
        livingDocumentMoves:0,
        drawPileCards:blueprint.drawPile.length,
        discardPileCards:blueprint.discardPile.length,
        liveUIUpdated:false,
        readyToResume:false,
      },
      liveUIUpdated:false,
      readyToResume:false,
    };
  }catch(error){
    for(let i=moves.length-1;i>=0;i--){
      const {card,parent,next}=moves[i];
      try{
        if(next?.parentNode===parent&&typeof parent.insertBefore==="function")parent.insertBefore(card,next);
        else parent.appendChild(card);
      }catch{}
    }
    return reject(error instanceof Error&&/^[A-Z_]+$/.test(error.message)
      ? error.message:"DETACHED_MOVE_FAILED");
  }
}
