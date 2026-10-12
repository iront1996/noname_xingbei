/**
 * V3-only offboard XingBei native Player seat topology.
 *
 * This creates REAL Noname Player/Client DOM instances from authenticated
 * WebSocket identities, but intentionally does NOT execute the native
 * xingBei.start(), character draft, gameDraw or phaseLoop.
 * It is the isolated prerequisite for wiring those engines safely.
 */
import {installV3NativeEventWaitAdapter} from './v3-native-event-wait-adapter.mjs';
import {createV3NativeDrawPile} from './v3-native-xingbei-content-stager.mjs';

const err=code=>Object.assign(new Error(code),{code});
const pid=x=>typeof x==='string'&&/^player_[a-f0-9]{32}$/.test(x);

export function prepareV3NativeXingBeiSeats({core,bridge}={}){
 if(globalThis.isNonameServer!==true||!core?.game?.__v3NativeContentStage||
    !core?.ui?.create?.player||!core?.lib?.element?.Client||
    typeof bridge?.getSeatBindings!=='function'||typeof bridge?.registerNativeChoiceHooks!=='function')
  throw err('V3_NATIVE_SEAT_BOOT_MISSING_DEPENDENCY');
 const {game,lib,ui,_status}=core;
 // Cold opening checkpoint rehydration supplies a deliberately minimal
 // synthetic bridge. Optional preview hooks exist only on a LIVE broker-
 // authenticated Chromium channel, and must never prevent cold rebuild.
 const previewHooksAvailable=typeof bridge?.registerNativeSelectionPreviewHooks==='function'&&
  typeof bridge?.requestNativeSelectionPreview==='function';
 if(!previewHooksAvailable&&
    (typeof bridge?.registerNativeSelectionPreviewHooks==='function'||
     typeof bridge?.requestNativeSelectionPreview==='function'))
  throw err('V3_NATIVE_USE_PREVIEW_PARTIAL_BRIDGE');

 if(game.__v3NativeSeatSession)throw err('V3_NATIVE_SEAT_ALREADY_BOOTED');
 const bindings=bridge.getSeatBindings().sort((a,b)=>a.seat-b.seat);
 if(![4,6,8].includes(bindings.length)||
    bindings.some((b,i)=>b.seat!==i||!pid(b.playerId)||
      typeof b.connectionId!=='string'||!(/^[a-f0-9]{24}$/.test(b.connectionId)))||
    new Set(bindings.map(x=>x.playerId)).size!==bindings.length||
    !Array.isArray(game.players)||game.players.length!==0)
  throw err('V3_NATIVE_SEAT_TOPOLOGY_INVALID');

 // Original boot establishes a root GameEvent before Player.init/unwait.
 if(!_status.eventManager.rootEvent)
  _status.eventManager.rootEvent=new lib.element.GameEvent('v3NativeRoomSetup',false);
 if(!lib.node)lib.node={};
 if(!lib.node.torespond)lib.node.torespond={};
 if(!lib.node.torespondtimeout)lib.node.torespondtimeout={};
 if(!lib.playerOL)lib.playerOL={};
 lib.configOL.number=bindings.length;
 lib.configOL.versus_mode=(bindings.length/2)+'v'+(bindings.length/2);
 lib.configOL.mode='xingBei';

 const container=document.createElement('div');
 container.dataset.v3Offboard='true';
 container.style.display='none';
 document.body.appendChild(container);
 const host=ui.create.player(container);
 // The server is NOT one of the red or blue players.
 game.me=host;
 const players=[];
 const clients=[];
 for(const b of bindings){
  const player=ui.create.player(container);
  player.playerid=b.playerId;
  // Alternate factions solely for the offboard test topology; the final
  // rules-owned seating policy must later replace this provisional mapping.
  player.side=b.seat%2===0;
  player.dataset.position=String(b.seat);
  player.nickname='Seat '+(b.seat+1);
  player.setNickname();
  const client=new lib.element.Client({
   wsid:b.playerId,
   send(){throw err('V3_NATIVE_RAW_CLIENT_SEND_DENIED')},
   close(){throw err('V3_NATIVE_RAW_CLIENT_CLOSE_DENIED')}
  },true);
  player.ws=client;
  lib.playerOL[b.playerId]=player;
  game.playerMap[b.playerId]=player;
  players.push(player);clients.push(client);
 }
 for(let i=0;i<players.length;i++){
  const p=players[i];
  p.next=players[(i+1)%players.length];
  p.previous=players[(i+players.length-1)%players.length];
  p.nextSeat=p.next;p.previousSeat=p.previous;
 }
 game.players.push(...players);
 const adapter=installV3NativeEventWaitAdapter({core,bridge});
 for(let i=0;i<players.length;i++)
  adapter.registerPlayer({seat:i,player:players[i],client:clients[i]});
 const drafts=new Map(),chosen=new Set();
 const legalCharacters=new Set(game.__v3NativeContentStage.rosterChoices());
 let draftFailure=null,startingCardsDealt=false,nativeOpeningDrawExecuted=false,restoredOpening=false;
 const physicalCardsBySeat=new Map();
 // Read-only intent owned by the paused original GameEvent, not a replacement
 // GameEvent result, target decision, or gameplay state transition.
 let useCardPreview=null;
 const ensureNativeSecurity=async()=>{
  if(game.__v3NativeSecurityBootstrapped)return;
  const realms=await import('/noname/util/initRealms.js');
  const security=(await import('/noname/util/security.js')).default;
  await realms.initializeSandboxRealms(true);
  await security.initSecurity({
   lib,game,ui,get:core.get,ai:core.ai,_status,gnc:core.gnc
  });
  Object.defineProperty(game,'__v3NativeSecurityBootstrapped',{
   value:true,enumerable:false,configurable:false
  });
 };
 const ensureCardSorter=()=>{
  if(typeof lib.config?.sort_card==='function')return;
  const sort=core.get?.sortCard?.(lib.config?.sort);
  if(typeof sort!=='function')throw err('V3_NATIVE_CARD_SORTER_UNAVAILABLE');
  lib.config.sort_card=sort;
 };
 const session=Object.freeze({
  // Controlled choices are real GameEvents over the authenticated Chromium
  // channel. The legacy online chooseCharacterOL implementation is NOT used.
  beginCharacterDraft({seat,offers}={}){
   if(draftFailure)throw err('V3_DRAFT_FATAL_ERROR');
   if(!Number.isInteger(seat)||seat<0||seat>=players.length||
      !Array.isArray(offers)||offers.length<2||offers.length>12||
      !offers.every(id=>legalCharacters.has(id)&&!chosen.has(id))||
      new Set(offers).size!==offers.length||
      drafts.size!==0||players[seat].name1)
    throw err('V3_NATIVE_DRAFT_INVALID');
   const event=new lib.element.GameEvent('chooseControl',false);
   event.player=players[seat];event.controls=offers.slice();
   event.prompt='請選擇角色';
   // Native unwait writes to _status.event and game.resume()s this event.
   _status.eventManager.rootEvent=event;
   drafts.set(seat,{event,offers:offers.slice()});
   try{event.send()}
   catch(e){draftFailure='EVENT_SEND_FAILED';throw e}
   return Object.freeze({seat,playerId:players[seat].playerid,
    nativeEvent:event instanceof lib.element.GameEvent,pending:true,
    candidateCount:offers.length});
  },
  async dealOpeningCardsNative(){
   // V3-only genuine original gameDraw Event.start(), *instead of* manual
   // opening directgain. Runs only after real authenticated character drafts.
   if(draftFailure||startingCardsDealt||drafts.size!==0||
      chosen.size!==players.length||game.__v3NativeDrawPile||
      adapter.inspect().pending!==0)
    throw err('V3_NATIVE_REAL_OPENING_DRAW_NOT_READY');
   try{
    await ensureNativeSecurity();
    ensureCardSorter();
    const pile=createV3NativeDrawPile({core});
    if(pile.remaining()<players.length*4)
     throw err('V3_NATIVE_REAL_OPENING_DECK_TOO_SMALL');
    if(!ui.cardPile){
     const zone=document.createElement('div');
     zone.style.display='none';
     document.body.appendChild(zone);
     ui.cardPile=zone;
    }
    if(ui.cardPile.hasChildNodes())
     throw err('V3_NATIVE_REAL_OPENING_PILE_DIRTY');
    // The canonical shuffled native card content becomes genuine Card DOM
    // instances in ui.cardPile, which original get.cards() consumes.
    while(pile.remaining()){
     const item=pile.draw();
     const card=ui.create.card(ui.cardPile).init(item.face);
     if(!(card instanceof lib.element.Card))
      throw err('V3_NATIVE_REAL_OPENING_CARD_BUILD_FAILED');
     Object.defineProperty(card,'__v3PhysicalId',{
      value:item.instanceId,configurable:false,enumerable:false
     });
    }
    const manager=_status.eventManager;
    if(manager.eventStack.length!==0)
     throw err('V3_NATIVE_REAL_OPENING_EVENT_STACK_BUSY');
    const root=new lib.element.GameEvent('v3OpeningGameDraw',false);
    manager.rootEvent=root;
    manager.eventStack.push(root);
    let draw;
    try{draw=game.gameDraw(players[0],4)}
    finally{
     if(manager.eventStack.pop()!==root)
      throw err('V3_NATIVE_REAL_OPENING_STACK_CHANGED');
    }
    if(!(draw instanceof lib.element.GameEvent)||draw.name!=='gameDraw')
     throw err('V3_NATIVE_REAL_OPENING_WRONG_EVENT');
    await draw.start();
    const instances=[];
    for(let seat=0;seat<players.length;seat++){
     const hand=players[seat].getCards('h');
     if(hand.length!==4||hand.some(c=>!(c instanceof lib.element.Card)||
        typeof c.__v3PhysicalId!=='string'))
      throw err('V3_NATIVE_REAL_OPENING_HAND_MISMATCH');
     physicalCardsBySeat.set(seat,hand.slice());
     instances.push(...hand.map(c=>c.__v3PhysicalId));
    }
    const remaining=Array.from(ui.cardPile.childNodes).map(c=>c.__v3PhysicalId);
    if(remaining.some(id=>typeof id!=='string')||
       new Set([...instances,...remaining]).size!==instances.length+remaining.length)
     throw err('V3_NATIVE_REAL_OPENING_DECK_INCONSISTENT');
    nativeOpeningDrawExecuted=true;
    startingCardsDealt=true;
    return Object.freeze({
     nativeCards:true,physicalCardsUnique:true,
     nativeGameDrawTriggered:true,realNativeGameEventCompleted:true,
     totalDealt:instances.length,
     handCounts:players.map(()=>4),
     nativeHandCounts:players.map(p=>p.getCards('h').length),
     remaining:remaining.length,privateDetailsIncluded:false
    });
   }catch(e){
    draftFailure='V3_NATIVE_REAL_OPENING_DRAW_FAILED';
    throw e;
   }
  },
  dealOpeningCards(){
   if(draftFailure||startingCardsDealt||drafts.size!==0||
      chosen.size!==players.length)
    throw err('V3_NATIVE_OPENING_DEAL_NOT_READY');
   if(typeof ui.create.card!=='function')throw err('V3_NATIVE_CARD_UI_UNAVAILABLE');
   const pile=createV3NativeDrawPile({core});
   if(pile.remaining()<players.length*4)
    throw err('V3_NATIVE_DRAW_PILE_TOO_SMALL');
   const all=new Set();
   try{
    for(let round=0;round<4;round++){
     for(let seat=0;seat<players.length;seat++){
      const instance=pile.draw();
      if(!instance||all.has(instance.instanceId))
       throw err('V3_NATIVE_CARD_INSTANCE_DUPLICATE');
      // Original native Card constructor + native Card.init. This *stages*
      // opening hands directly, not yet the full game.gameDraw event/skills.
      const card=ui.create.card(players[seat].node.handcards1)
       .init(instance.face);
      if(!(card instanceof lib.element.Card))
       throw err('V3_NATIVE_CARD_BUILD_MISMATCH');
      Object.defineProperty(card,'__v3PhysicalId',{
       configurable:false,enumerable:false,value:instance.instanceId
      });
      if(!physicalCardsBySeat.has(seat))physicalCardsBySeat.set(seat,[]);
      physicalCardsBySeat.get(seat).push(card);
      all.add(instance.instanceId);
     }
    }
   }catch(e){
    draftFailure='V3_OPENING_DRAW_FAILED';
    throw e; // Hard-stop this room; never pretend partial draw can resume.
   }
   startingCardsDealt=true;
   const copies=Array.from(physicalCardsBySeat.values()).flat();
   return Object.freeze({
    nativeCards:copies.every(x=>x instanceof lib.element.Card),
    physicalCardsUnique:new Set(copies.map(x=>x.__v3PhysicalId)).size===copies.length,
    totalDealt:copies.length,
    handCounts:players.map((_,seat)=>physicalCardsBySeat.get(seat)?.length??0),
    nativeHandCounts:players.map(player=>player.getCards('h').length),
    remaining:pile.remaining(),
    // These are counts only. Never return opponents' private card identities.
    privateDetailsIncluded:false,
    nativeGameDrawTriggered:false
   });
  },
  restoreOpeningCheckpoint({checkpoint,roomId}={}){
   // Fully staged native ESM+Player objects in a FRESH offboard Chromium.
   // This is opening-only state rehydration, NOT EventStack/turn recovery.
   if(globalThis.isNonameServer!==true||!checkpoint||
      typeof checkpoint!=='object'||Array.isArray(checkpoint)||
      typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)||
      !game.__v3NativeContentStage||startingCardsDealt||
      restoredOpening||nativeOpeningDrawExecuted||chosen.size!==0||
      drafts.size!==0||draftFailure||game.__v3NativeDrawPile)
    throw err('V3_OPENING_RESTORE_DENIED');
   const specs=game.__v3NativeContentStage.cardEntries();
   const validCardId=x=>typeof x==='string'&&/^v3card_[a-f0-9]{6}$/.test(x);
   const cardIndex=id=>parseInt(id.slice(7),16);
   const acceptedKeys=['schema','roomId','seatMode','revision','totalCards','players','remainingCardIds'];
   if(Object.keys(checkpoint).some(k=>!acceptedKeys.includes(k))||
      checkpoint.schema!=='xingbei-v3-native-opening-only-v1'||
      checkpoint.roomId!==roomId||
      checkpoint.seatMode!==(players.length/2)+'v'+(players.length/2)||
      !Number.isSafeInteger(checkpoint.revision)||checkpoint.revision<1||
      checkpoint.totalCards!==specs.length||!Array.isArray(checkpoint.players)||
      checkpoint.players.length!==players.length||
      !Array.isArray(checkpoint.remainingCardIds)||
      checkpoint.remainingCardIds.length!==specs.length-4*players.length)
    throw err('V3_OPENING_RESTORE_SCHEMA_INVALID');
   const allowedCharacters=new Set(game.__v3NativeContentStage.rosterChoices());
   const usedCharacters=new Set(),usedCards=new Set();
   const validateCard=c=>{
    if(!c||typeof c!=='object'||Array.isArray(c)||
       Object.keys(c).some(k=>!['cardId','name'].includes(k))||
       !validCardId(c.cardId)||typeof c.name!=='string'||
       cardIndex(c.cardId)>=specs.length||
       specs[cardIndex(c.cardId)][2]!==c.name||
       usedCards.has(c.cardId))
     throw err('V3_OPENING_RESTORE_CARD_INVALID');
    usedCards.add(c.cardId);
   };
   // Reject EVERY inconsistency before mutating any native card or Player.
   for(let seat=0;seat<players.length;seat++){
    const p=checkpoint.players[seat];
    if(!p||typeof p!=='object'||Array.isArray(p)||
       Object.keys(p).some(k=>!['seat','playerId','character','hand'].includes(k))||
       p.seat!==seat||p.playerId!==players[seat].playerid||
       !allowedCharacters.has(p.character)||usedCharacters.has(p.character)||
       !Array.isArray(p.hand)||p.hand.length!==4)
     throw err('V3_OPENING_RESTORE_PLAYER_MISMATCH');
    usedCharacters.add(p.character);
    for(const c of p.hand)validateCard(c);
   }
   for(const id of checkpoint.remainingCardIds){
    const ix=validCardId(id)?cardIndex(id):-1;
    if(ix<0||ix>=specs.length||usedCards.has(id))
     throw err('V3_OPENING_RESTORE_DECK_INVALID');
    usedCards.add(id);
   }
   if(usedCards.size!==specs.length)
    throw err('V3_OPENING_RESTORE_DECK_INCOMPLETE');
   for(let ix=0;ix<specs.length;ix++){
    const id='v3card_'+ix.toString(16).padStart(6,'0');
    if(!usedCards.has(id))throw err('V3_OPENING_RESTORE_CARD_MISSING');
   }
   if(ui.cardPile?.hasChildNodes())
    throw err('V3_OPENING_RESTORE_EXISTING_PILE');
   if(typeof ui.create.card!=='function')throw err('V3_OPENING_RESTORE_CARD_UI_MISSING');
   try{
    if(!ui.cardPile){
     const pileNode=document.createElement('div');
     pileNode.style.display='none';
     document.body.appendChild(pileNode);
     ui.cardPile=pileNode;
    }
    const makeCard=({cardId})=>{
     const index=cardIndex(cardId);
     const c=ui.create.card().init(specs[index]);
     if(!(c instanceof lib.element.Card))
      throw err('V3_OPENING_RESTORE_CARD_BUILD_FAILED');
     Object.defineProperty(c,'__v3PhysicalId',{
      configurable:false,enumerable:false,value:cardId
     });
     return c;
    };
    for(const p of checkpoint.players){
     const native=players[p.seat];
     native.init(p.character,null,null,false);
     if(native.name1!==p.character)
      throw err('V3_OPENING_RESTORE_CHARACTER_INIT_FAILED');
     chosen.add(p.character);
     const cards=p.hand.map(makeCard);
     for(const c of cards)native.node.handcards1.appendChild(c);
     physicalCardsBySeat.set(p.seat,cards);
    }
    for(const cardId of checkpoint.remainingCardIds)
     ui.cardPile.appendChild(makeCard({cardId}));
    const nativeIds=players.flatMap(p=>p.getCards('h').map(c=>c.__v3PhysicalId));
    const remaining=Array.from(ui.cardPile.childNodes).map(c=>c.__v3PhysicalId);
    if(nativeIds.length!==players.length*4||
       JSON.stringify(remaining)!==JSON.stringify(checkpoint.remainingCardIds)||
       checkpoint.players.some((p,seat)=>
        JSON.stringify(players[seat].getCards('h').map(c=>c.__v3PhysicalId))!==
        JSON.stringify(p.hand.map(c=>c.cardId))))
     throw err('V3_OPENING_RESTORE_POSTCHECK_FAILED');
    nativeOpeningDrawExecuted=true;
    restoredOpening=true;
    startingCardsDealt=true;
    return Object.freeze({
     restoredOpening:true,restorableRunningGame:false,
     realNativePlayers:players.every(p=>p instanceof lib.element.Player),
     realNativeCards:players.every(p=>p.getCards('h').every(c=>c instanceof lib.element.Card)),
     roomId,revision:checkpoint.revision,seatMode:checkpoint.seatMode,
     seatCount:players.length,handCounts:players.map(p=>p.getCards('h').length),
     deckRemaining:remaining.length,playerIdsMatch:true,
     gameLoopStarted:false,gameEventStackRestored:false
    });
   }catch(e){
    draftFailure='V3_OPENING_RESTORE_FATAL_ERROR';
    throw e;
   }
  },
  // Complete opening setup checkpoint. Server/CDP only, never publish via
  // a human player socket or room-wide roster. NOT a game-event snapshot.
  exportOpeningCheckpoint({roomId,revision=1}={}){
   if(!startingCardsDealt||drafts.size!==0||chosen.size!==players.length||
      (!game.__v3NativeDrawPile&&!restoredOpening)||draftFailure||
      game.__v3PausedPhaseRuntime||_status.eventManager.eventStack.length!==0||
      adapter.inspect().pending!==0)
    throw err('V3_OPENING_CHECKPOINT_NOT_READY');
   if(typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)||
      !Number.isSafeInteger(revision)||revision<1)
    throw err('V3_OPENING_CHECKPOINT_ARGS_INVALID');
   const remaining=nativeOpeningDrawExecuted
    ?Array.from(ui.cardPile.childNodes).map(card=>card.__v3PhysicalId)
    :game.__v3NativeDrawPile.inspectIds();
   const snapshot={
    schema:'xingbei-v3-native-opening-only-v1',
    roomId,seatMode:(players.length/2)+'v'+(players.length/2),
    revision,totalCards:remaining.length+players.length*4,
    players:players.map((p,seat)=>({
     seat,playerId:p.playerid,character:p.name1,
     hand:(physicalCardsBySeat.get(seat)??[]).map(c=>({
      cardId:c.__v3PhysicalId,name:c.name
     }))
    })),
    remainingCardIds:remaining
   };
   // The opening-only checkpoint verifier is also run on the server process
   // before encrypting; this client-side check catches staging mistakes early.
   if(snapshot.players.some(p=>p.hand.length!==4||!p.character)||
      new Set(snapshot.players.flatMap(p=>p.hand.map(c=>c.cardId)).concat(remaining)).size!==snapshot.totalCards)
    throw err('V3_OPENING_CHECKPOINT_INCONSISTENT');
   return snapshot;
  },
  async stageOpeningTurnBoundary({firstSeat=0}={}){
   // Creates the ORIGINAL native GameEvent objects; does not start game.loop().
   // A later V3-only rules dispatcher must explicitly resolve them, validating
   // all turn skills and player actions, before a playable room is possible.
   if(!startingCardsDealt||drafts.size!==0||chosen.size!==players.length||
      draftFailure||!Number.isInteger(firstSeat)||firstSeat<0||firstSeat>=players.length||
      game.__v3OpeningTurnBoundary||adapter.inspect().pending!==0)
    throw err('V3_NATIVE_TURN_BOUNDARY_NOT_READY');
   // Mirror original boot's security initialization BEFORE compiling any
   // native step-content. Never suppress sandbox failures or fall back to eval.
   await ensureNativeSecurity();
   const first=players[firstSeat];
   const root=new lib.element.GameEvent('v3OpeningBoundary',false);
   const manager=_status.eventManager;
   // game.createEvent attaches child GameEvents to the STARTED event stack,
   // not the rootEvent slot. Mirror the native scheduler's stack topology.
   if(manager.eventStack.length!==0)
    throw err('V3_NATIVE_TURN_EVENT_STACK_NOT_EMPTY');
   manager.rootEvent=root;
   manager.eventStack.push(root);
   let draw=null;
   try{
    // If opening hands were already drawn by original GameEvent.start(),
    // NEVER schedule gameDraw again. Otherwise the next native turn would
    // silently double-deal the entire room.
    if(!nativeOpeningDrawExecuted)draw=game.gameDraw(first,4);
    game.phaseLoop(first);
   }finally{
    if(manager.eventStack.pop()!==root)
     throw err('V3_NATIVE_TURN_EVENT_STACK_CORRUPTED');
   }
   const siblings=Array.isArray(root.next)?root.next:[];
   const phase=siblings.find(x=>x.name==='phaseLoop');
   if(!(phase instanceof lib.element.GameEvent)||phase.player!==first||
      phase._isStandardLoop!==true||
      (!nativeOpeningDrawExecuted&&(!(draw instanceof lib.element.GameEvent)||
       draw.name!=='gameDraw'||draw.player!==first||draw.num!==4||
       !siblings.includes(draw)))||
      (nativeOpeningDrawExecuted&&siblings.some(x=>x.name==='gameDraw')))
    throw err('V3_NATIVE_TURN_EVENT_SHAPE_INVALID');
   const result=Object.freeze({
    realNativeEvents:true,firstSeat,playerId:first.playerid,
    drawEvent:'gameDraw',phaseEvent:phase.name,drawCount:4,
    openingDrawAlreadyExecuted:nativeOpeningDrawExecuted,
    standardPhaseLoop:phase._isStandardLoop===true,
    eventsQueued:siblings.map(x=>x.name),
    eventLoopStarted:false,turnResolved:false
   });
   Object.defineProperty(game,'__v3OpeningTurnBoundary',{
    enumerable:false,configurable:false,value:result
   });
   return result;
  },
  startPausedFirstNativePhase(){
   // Strictly offline: allow the ORIGINAL phaseLoop.start() to run through
   // step 0 and queue the real first Player.phase() GameEvent, but pause
   // BEFORE that child resolves or any player action can execute.
   if(!nativeOpeningDrawExecuted||!startingCardsDealt||draftFailure||
      !game.__v3OpeningTurnBoundary||game.__v3PausedPhaseRuntime||
      adapter.inspect().pending!==0||_status.eventManager.eventStack.length!==0)
    throw err('V3_NATIVE_PHASE_PROBE_NOT_READY');
   const manager=_status.eventManager;
   const phase=manager.rootEvent?.next?.find(e=>e.name==='phaseLoop');
   if(!(phase instanceof lib.element.GameEvent)||
      !(phase.player instanceof lib.element.Player))
    throw err('V3_NATIVE_PHASE_EVENT_MISSING');
   if(!ui.window){
    ui.window=document.createElement('div');
    ui.window.style.display='none';
    document.body.appendChild(ui.window);
   }
   if(!Array.isArray(lib.onphase))throw err('V3_NATIVE_PHASE_HOOKS_MISSING');
   const state={phase,pauseTriggered:false,failure:null,finished:false,
    entryReleased:false,actionGate:false,actionEvent:null,hold:null,
    actionEntryReleased:false,selectionGate:false,selectionEvent:null,
    nextActionGate:null,nextActionEntryReleased:false,
    nextSelectionGate:false,nextSelectionEvent:null,
    nextSelectionContentReleased:false,nextOriginalUseWaitReached:false,
    thirdActionGate:null,thirdActionEntryReleased:false,
    thirdSelectionGate:false,thirdSelectionEvent:null,
    thirdSelectionContentReleased:false,thirdOriginalUseWaitReached:false,
    fourthActionGate:null,fourthActionEntryReleased:false,
    fourthSelectionGate:false,fourthSelectionEvent:null};
   // This hook runs in original content.js phaseLoop step 1, immediately
   // BEFORE the native Player.phase() event is queued. It is NOT a gameplay
   // hook and must never be installed in production V3.
   const hold=()=>{
    state.pauseTriggered=true;
    game.pause();
   };
   state.hold=hold;
   lib.onphase.push(hold);
   Object.defineProperty(game,'__v3PausedPhaseRuntime',{
    enumerable:false,configurable:false,value:state
   });
   try{
    phase.start().then(()=>{state.finished=true}).catch(e=>{
     state.failure=String(e?.code??e?.message??e).slice(0,100);
     state.trace=String(e?.stack??'').slice(0,320);
    });
   }catch(e){
    state.failure=String(e?.message??e).slice(0,100);
   }
   return Object.freeze({started:state.failure===null,
    event:phase.name,realEvent:phase instanceof lib.element.GameEvent});
  },
  releaseOriginalPhaseToActionGate(){
   // Offline-only proof of the authentic Player.phase() control flow,
   // with the real XingBei xingDong event stopped BEFORE any card, skill
   // or untrusted remote-send callback can execute.
   const state=game.__v3PausedPhaseRuntime;
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   if(!state||state.failure||!state.pauseTriggered||
      !_status.paused||state.entryReleased||!first||
      state.phase.next?.find(e=>e.name==='phase')?.player!==first)
    throw err('V3_NATIVE_ACTION_GATE_NOT_READY');
   const Player=lib.element.Player;
   const originalSend=Player.prototype.send;
   const originalXingDong=Player.prototype.xingDong;
   if(typeof originalSend!=='function'||typeof originalXingDong!=='function')
    throw err('V3_NATIVE_ACTION_GATE_METHOD_UNAVAILABLE');
   // Normal full UI boot initializes its dialogs registry before phase step 4.
   // Plain isolated ESM imports leave the field undefined.
   if(ui.dialogs===undefined)ui.dialogs=[];
   if(!Array.isArray(ui.dialogs))
    throw err('V3_NATIVE_DIALOG_REGISTRY_INVALID');
   // Full native UI boot also creates the log containers before phaseBegin.
   // Keep them hidden in the independent server Chromium; do not create
   // browser-side player UI, spoof real recipients, or send any JS.
   for(const key of ['sidebar','arenalog','historybar']){
    if(!ui[key]){
     const node=document.createElement('div');
     node.style.display='none';
     document.body.appendChild(node);
     ui[key]=node;
    }
   }
   const hookIndex=lib.onphase.indexOf(state.hold);
   if(hookIndex<0)throw err('V3_NATIVE_ACTION_GATE_HOOK_MISSING');
   // Original phase step 2 notifies the active human client to play a local
   // sound. In server-only Chromium it cannot transmit arbitrary JS. Permit
   // exactly this audiovisual NO-OP; everything else remains fail-closed.
   Player.prototype.send=function(callback,...args){
    // Only the ORIGINAL actor's Player.phase step-2 audiovisual notice
    // is allowed as a NO-OP, including the next seat after an explicit
    // no-card pass. Never forward or execute any callback in human JS.
    if(!(this instanceof Player)||!players.includes(this)||
       _status.event?.name!=='phase'||_status.event.player!==this||
       typeof callback!=='function'||args.length!==0)
     throw err('V3_NATIVE_REMOTE_CODE_SEND_DENIED');
    const source=Function.prototype.toString.call(callback)
     .replace(/\s+/g,'');
    const allowedSound=new Set([
     "function(){game.playAudio('effect','phaseStart');}",
     "function(){game.playAudio('effect','phaseStart')}",
     'function(){game.playAudio("effect","phaseStart");}',
     'function(){game.playAudio("effect","phaseStart")}'
    ]);
    if(!allowedSound.has(source))
     throw err('V3_NATIVE_REMOTE_CODE_SEND_DENIED');
    return false; // Never execute arbitrary JS in a real human browser.
   };
   Player.prototype.xingDong=function(...args){
    if(args.length!==0||!players.includes(this)||
       _status.event?.name!=='phase'||_status.event.player!==this)
     throw err('V3_NATIVE_ACTION_UNEXPECTED_OWNER');
    if(this===first&&!state.actionGate){
     const event=originalXingDong.call(this);
     if(!(event instanceof lib.element.GameEvent)||
        event.name!=='xingDong'||event.player!==first)
      throw err('V3_NATIVE_ACTION_EVENT_INVALID');
     state.actionEvent=event;state.actionGate=true;
     game.pause(); // Before original first xingDong step 0.
     return event;
    }
    // Strict next-seat experimental gate after a verified native no-card
    // pass. This proves authentic phase-loop turn advancement but does NOT
    // authorize the second player's actions/skills or let the event run.
    if(this===first.nextSeat&&state.actionEntryReleased&&
       state.originalUseWaitReached===true&&
       adapter.inspect().originalUsePassApplied===1&&
       state.nextActionGate===null){
     const event=originalXingDong.call(this);
     if(!(event instanceof lib.element.GameEvent)||
        event.name!=='xingDong'||event.player!==this)
      throw err('V3_NATIVE_NEXT_ACTION_EVENT_INVALID');
     state.nextActionGate={player:this,event};
     game.pause(); // Before second actor xingDong step 0.
     return event;
    }
    // A second authentic pass advances the native scheduler but still
    // stops the third player BEFORE original xingDong step 0.
    if(this===first.nextSeat?.nextSeat&&
       state.nextSelectionContentReleased&&state.nextOriginalUseWaitReached&&
       adapter.inspect().originalUsePassApplied===2&&
       state.thirdActionGate===null){
     const event=originalXingDong.call(this);
     if(!(event instanceof lib.element.GameEvent)||
        event.name!=='xingDong'||event.player!==this)
      throw err('V3_NATIVE_THIRD_ACTION_EVENT_INVALID');
     state.thirdActionGate={player:this,event};
     game.pause();return event;
    }
    if(this===first.nextSeat?.nextSeat?.nextSeat&&
       state.thirdSelectionContentReleased&&state.thirdOriginalUseWaitReached&&
       adapter.inspect().originalUsePassApplied===3&&
       state.fourthActionGate===null){
     const event=originalXingDong.call(this);
     if(!(event instanceof lib.element.GameEvent)||
        event.name!=='xingDong'||event.player!==this)
      throw err('V3_NATIVE_FOURTH_ACTION_EVENT_INVALID');
     state.fourthActionGate={player:this,event};
     game.pause();return event;
    }
    throw err('V3_NATIVE_ACTION_UNEXPECTED_OWNER');
   };
   lib.onphase.splice(hookIndex,1);
   state.entryReleased=true;
   game.resume();
   return Object.freeze({
    started:true,firstPlayerId:first.playerid,
    originalPhaseEvent:true,actualActionStepExecuted:false
   });
  },
  releaseOriginalActionToSelectionGate(){
   // Original native XingBei xingDong content now executes, but its first
   // card/skill selection child must remain paused before chooseToUse.
   const state=game.__v3PausedPhaseRuntime;
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   if(!state||state.failure||!state.actionGate||state.actionEntryReleased||
      !_status.paused||!first||
      state.actionEvent?.player!==first)
    throw err('V3_NATIVE_SELECTION_GATE_NOT_READY');
   const Player=lib.element.Player;
   const original=Player.prototype.gongJiOrFaShu;
   if(typeof original!=='function')
    throw err('V3_NATIVE_SELECTION_GATE_METHOD_MISSING');
   Player.prototype.gongJiOrFaShu=function(...args){
    const firstActor=this===first&&!state.selectionGate&&
     !state.nextActionEntryReleased;
    const secondActor=this===state.nextActionGate?.player&&
     state.nextActionEntryReleased&&!state.nextSelectionGate&&
     state.nextActionGate?.event instanceof lib.element.GameEvent&&
     _status.event?.name==='xingDong'&&_status.event.player===this&&
     adapter.inspect().originalUsePassApplied===1;
    const thirdActor=this===state.thirdActionGate?.player&&
     state.thirdActionEntryReleased&&!state.thirdSelectionGate&&
     state.thirdActionGate?.event instanceof lib.element.GameEvent&&
     _status.event?.name==='xingDong'&&_status.event.player===this&&
     adapter.inspect().originalUsePassApplied===2;
    const fourthActor=this===state.fourthActionGate?.player&&
     state.fourthActionEntryReleased&&!state.fourthSelectionGate&&
     state.fourthActionGate.event instanceof lib.element.GameEvent&&
     _status.event?.name==='xingDong'&&_status.event.player===this&&
     adapter.inspect().originalUsePassApplied===3;
    if(args.length!==0||(!firstActor&&!secondActor&&!thirdActor&&!fourthActor))
     throw err('V3_NATIVE_SELECTION_UNEXPECTED_OWNER');
    const event=original.call(this);
    if(!(event instanceof lib.element.GameEvent)||
       event.name!=='gongJiOrFaShu'||event.player!==this)
     throw err('V3_NATIVE_SELECTION_EVENT_INVALID');
    if(firstActor){
     state.selectionEvent=event;state.selectionGate=true;
    }else if(secondActor){
     state.nextSelectionEvent=event;state.nextSelectionGate=true;
    }else if(thirdActor){
     state.thirdSelectionEvent=event;state.thirdSelectionGate=true;
    }else{
     state.fourthSelectionEvent=event;state.fourthSelectionGate=true;
    }
    game.pause(); // Never run this actor's chooseToUse without an explicit gate.
    return event;
   };
   state.actionEntryReleased=true;
   game.resume();
   return Object.freeze({started:true,ownerPlayerId:first.playerid,
    actualSelectionContentExecuted:false});
  },
  releaseNextOriginalActionToSelectionGate(){
   // The first actor has genuinely passed and the original phaseLoop has
   // reached the second seat. Permit only its native xingDong step zero,
   // then hold the new gongJiOrFaShu BEFORE any chooseToUse content runs.
   // This is an offline test gate, never a general gameplay permission.
   const state=game.__v3PausedPhaseRuntime;
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   const next=state?.nextActionGate;
   if(!state||state.failure||!first||!next||
      next.player!==first.nextSeat||
      !(next.event instanceof lib.element.GameEvent)||
      next.event.name!=='xingDong'||next.event.player!==next.player||
      !state.actionEntryReleased||!state.selectionContentReleased||
      !state.originalUseWaitReached||
      adapter.inspect().originalUsePassApplied!==1||
      useCardPreview?.state!=='passed'||!_status.paused||
      state.nextActionEntryReleased||state.nextSelectionGate||
      adapter.inspect().pending!==0)
    throw err('V3_NATIVE_NEXT_SELECTION_RELEASE_DENIED');
   state.nextActionEntryReleased=true;
   game.resume();
   return Object.freeze({started:true,ownerPlayerId:next.player.playerid,
    originalNextXingDong:true,actualSelectionContentExecuted:false,
    actualCardPlayed:false,fullRulesValidated:false});
  },
  releaseThirdOriginalActionToSelectionGate(){
   // Third authentic player is paused at native xingDong step zero.
   // Releasing this gate must stop at that player's genuine
   // gongJiOrFaShu BEFORE any chooseToUse/card/skill callback runs.
   const state=game.__v3PausedPhaseRuntime;
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   const third=state?.thirdActionGate;
   if(!state||state.failure||!first||!third||
      third.player!==first.nextSeat?.nextSeat||
      !(third.event instanceof lib.element.GameEvent)||
      third.event.name!=='xingDong'||third.event.player!==third.player||
      !state.nextActionEntryReleased||!state.nextSelectionContentReleased||
      !state.nextOriginalUseWaitReached||
      adapter.inspect().originalUsePassApplied!==2||
      useCardPreview?.state!=='passed'||!_status.paused||
      state.thirdActionEntryReleased||state.thirdSelectionGate||
      adapter.inspect().pending!==0)
    throw err('V3_NATIVE_THIRD_SELECTION_RELEASE_DENIED');
   state.thirdActionEntryReleased=true;
   game.resume();
   return Object.freeze({
    started:true,ownerPlayerId:third.player.playerid,
    originalThirdXingDong:true,actualSelectionContentExecuted:false,
    actionExecuted:false,cardConsumed:false,fullRulesValidated:false
   });
  },
  releaseFourthOriginalActionToSelectionGate(){
   // Authentic fourth actor advances through original xingDong step zero,
   // but its own gongJiOrFaShu child is captured BEFORE use/skill logic.
   // This does not authorize card use or continuation to a fifth player.
   const gate=game.__v3PausedPhaseRuntime;
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   const fourth=gate?.fourthActionGate;
   if(!gate||gate.failure||!first||!fourth||
      fourth.player!==first.nextSeat?.nextSeat?.nextSeat||
      !(fourth.event instanceof lib.element.GameEvent)||
      fourth.event.name!=='xingDong'||fourth.event.player!==fourth.player||
      !gate.thirdActionEntryReleased||!gate.thirdSelectionContentReleased||
      !gate.thirdOriginalUseWaitReached||
      adapter.inspect().originalUsePassApplied!==3||
      useCardPreview?.state!=='passed'||!_status.paused||
      gate.fourthActionEntryReleased||gate.fourthSelectionGate||
      adapter.inspect().pending!==0)
    throw err('V3_NATIVE_FOURTH_SELECTION_RELEASE_DENIED');
   gate.fourthActionEntryReleased=true;
   game.resume();
   return Object.freeze({
    started:true,ownerPlayerId:fourth.player.playerid,
    originalFourthXingDong:true,selectionContentExecuted:false,
    actionExecuted:false,cardConsumed:false,fullRulesValidated:false
   });
  },
  releaseThirdOriginalSelectionToNativeWait(){
   const gate=game.__v3PausedPhaseRuntime;
   const actor=gate?.thirdActionGate?.player;
   const seat=players.indexOf(actor),event=gate?.thirdSelectionEvent;
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   if(!previewHooksAvailable||!gate||gate.failure||
      !gate.thirdActionEntryReleased||!gate.thirdSelectionGate||
      !(event instanceof lib.element.GameEvent)||
      event.name!=='gongJiOrFaShu'||event.player!==actor||
      actor!==first?.nextSeat?.nextSeat||seat<0||
      gate.thirdSelectionContentReleased||
      gate.thirdOriginalUseWaitReached||!_status.paused||
      useCardPreview?.state!=='passed'||
      adapter.inspect().originalUsePassApplied!==2||
      adapter.inspect().pending!==0)
    throw err('V3_NATIVE_THIRD_ORIGINAL_USE_RELEASE_DENIED');
   gate.thirdSelectionContentReleased=true;
   try{adapter.armOriginalUseWait({seat,playerId:actor.playerid,event})}
   catch(e){gate.thirdSelectionContentReleased=false;throw e}
   useCardPreview=null;
   game.resume();
   return Object.freeze({started:true,nativeChooseToUse:true,
    ownerPlayerId:actor.playerid,originalThirdPlayer:true,
    actionExecuted:false,cardConsumed:false,fullRulesValidated:false});
  },
  releaseNextOriginalSelectionToNativeWait(){
   const gate=game.__v3PausedPhaseRuntime;
   const actor=gate?.nextActionGate?.player;
   const seat=players.indexOf(actor);
   const event=gate?.nextSelectionEvent;
   if(!previewHooksAvailable||!gate||gate.failure||
      !gate.nextActionEntryReleased||!gate.nextSelectionGate||
      !(event instanceof lib.element.GameEvent)||
      event.name!=='gongJiOrFaShu'||event.player!==actor||
      actor!==players[game.__v3OpeningTurnBoundary?.firstSeat]?.nextSeat||
      seat<0||gate.nextSelectionContentReleased||
      gate.nextOriginalUseWaitReached||!_status.paused||
      useCardPreview?.state!=='passed'||
      adapter.inspect().originalUsePassApplied!==1||
      adapter.inspect().pending!==0)
    throw err('V3_NATIVE_NEXT_ORIGINAL_USE_RELEASE_DENIED');
   gate.nextSelectionContentReleased=true;
   try{
    adapter.armOriginalUseWait({seat,playerId:actor.playerid,event});
   }catch(e){
    gate.nextSelectionContentReleased=false;
    throw e;
   }
   useCardPreview=null; // First ticket is already finalized.
   game.resume();
   return Object.freeze({started:true,nativeChooseToUse:true,
    ownerPlayerId:actor.playerid,originalNextPlayer:true,
    actionExecuted:false,cardConsumed:false,fullRulesValidated:false});
  },
  releaseOriginalSelectionToNativeWait(){
   // The only deliberate CI path allowed to execute the original
   // chooseToUse step 0. Arm a ONE-SHOT GameEvent.send interception,
   // then let original engine reach that native online waiting point.
   // All actual human choices and useResult remain blocked.
   const gate=game.__v3PausedPhaseRuntime;
   const seat=game.__v3OpeningTurnBoundary?.firstSeat,actor=players[seat];
   if(!previewHooksAvailable||!gate?.selectionGate||gate.failure||
      !gate.selectionEvent||gate.selectionEvent.player!==actor||
      gate.selectionContentReleased||gate.originalUseWaitReached||
      useCardPreview!==null||!_status.paused||
      adapter.inspect().pending!==0||
      !actor||typeof actor.playerid!=='string')
    throw err('V3_NATIVE_ORIGINAL_USE_RELEASE_DENIED');
   const armed=adapter.armOriginalUseWait({
    seat,playerId:actor.playerid,event:gate.selectionEvent
   });
   if(armed.armed!==true)
    throw err('V3_NATIVE_ORIGINAL_USE_ARM_FAILED');
   gate.selectionContentReleased=true;
   game.resume();
   return Object.freeze({
    started:true,nativeChooseToUse:true,
    ownerPlayerId:actor.playerid,
    originalStep0Reached:false,
    originalStep2Executed:false,cardConsumed:false,
    actionExecuted:false,fullRulesValidated:false
   });
  },
  beginNativeUseCardPreview({seat,playerId,allowPass=false}={}){
   // Original gongJiOrFaShu already contains a chooseToUse handler, but
   // chooseToUse step 0 is unsafe until skill callbacks are isolated.
   // Offer physical, PRIVATE hand identifiers only to its authenticated owner.
   const gate=game.__v3PausedPhaseRuntime;
   // There is no authorized fourth original chooseToUse bridge yet.
   // The third actor's old event must not be reused after seat four starts.
   if(gate?.fourthActionGate)
    throw err('V3_NATIVE_USE_PREVIEW_NOT_READY');
   const third=gate?.thirdSelectionContentReleased===true;
   const second=!third&&gate?.nextSelectionContentReleased===true;
   const event=third?gate.thirdSelectionEvent:
    second?gate.nextSelectionEvent:gate?.selectionEvent;
   const actorSeat=third?players.indexOf(gate.thirdActionGate?.player):
    second?players.indexOf(gate.nextActionGate?.player):
    game.__v3OpeningTurnBoundary?.firstSeat;
   if(!previewHooksAvailable||useCardPreview||!gate||gate.failure||
      !(third?gate.thirdSelectionGate:
       second?gate.nextSelectionGate:gate.selectionGate)||
      !(event instanceof lib.element.GameEvent)||
      event.name!=='gongJiOrFaShu'||event.player!==players[seat]||
      !_status.paused||seat!==actorSeat||
      typeof playerId!=='string'||players[seat]?.playerid!==playerId)
    throw err('V3_NATIVE_USE_PREVIEW_NOT_READY');
   if(event.filterCard!==lib.filter.filterCard||
      event.filterTarget!==lib.filter.filterTarget||
      event.selectTarget!==lib.filter.selectTarget||
      !Array.isArray(event.selectCard)||event.selectCard.length!==2||
      event.selectCard[0]!==1||event.selectCard[1]!==1||
      event.position!=='hs')
    throw err('V3_NATIVE_USE_EVENT_CONTRACT_UNSUPPORTED');
   const cards=players[seat].getCards('h');
   const handIds=cards.map(c=>c.__v3PhysicalId);
   if(typeof allowPass!=='boolean'||cards.length<2||
      cards.length>(allowPass?11:12)||
      cards.some(c=>!(c instanceof lib.element.Card))||
      handIds.some(id=>typeof id!=='string'||!/^v3card_[a-f0-9]{6}$/.test(id))||
      new Set(handIds).size!==handIds.length)
    throw err('V3_NATIVE_USE_HAND_INVALID');
   for(const cardId of handIds)
    this.preflightNativeActionCardOwnership({seat,playerId,cardId});
   // 'pass' exists ONLY after the original chooseToUse step 0 has
   // reached the verified server waiting boundary; manual CI-only
   // read-only card previews never have the privilege to unwind an event.
   if(allowPass&&(third?gate.thirdOriginalUseWaitReached!==true:
       second?gate.nextOriginalUseWaitReached!==true:
       gate.originalUseWaitReached!==true))
    throw err('V3_NATIVE_USE_PASS_NOT_AUTHORIZED');
   const options=allowPass?[...handIds,'pass']:handIds;
   useCardPreview={event,seat,playerId,options:[...options],
    allowPass,ticket:null,state:'requested',selectedCardId:null};
   try{
    if(bridge.requestNativeSelectionPreview({
     seat,kind:'card',prompt:'原生行動：選擇一張手牌（僅預檢，不會出牌）',
     options
    })!==true)throw err('V3_NATIVE_USE_PREVIEW_NOT_ROUTED');
   }catch(e){useCardPreview=null;throw e}
   return Object.freeze({started:true,originalEvent:'gongJiOrFaShu',
    nativeGameEvent:true,awaitingVerifiedSeat:true,handCount:options.length,
    originalChooseToUseExecuted:false,fullRulesValidated:false,
    actionExecuted:false,cardConsumed:false});
  },
  beginNativeUsePrintedTargetPreview({seat,playerId,previousTicket}={}){
   const p=useCardPreview,gate=game.__v3PausedPhaseRuntime;
   if(!previewHooksAvailable||!p||p.state!=='recorded'||p.targetStage||
      p.seat!==seat||p.playerId!==playerId||
      p.ticket!==previousTicket||
      (gate?.thirdSelectionContentReleased?
       gate.thirdSelectionEvent:gate?.nextSelectionContentReleased?
       gate.nextSelectionEvent:gate?.selectionEvent)!==p.event||
      !_status.paused)
    throw err('V3_NATIVE_USE_TARGET_PREVIEW_DENIED');
   this.preflightNativeActionCardOwnership({
    seat,playerId,cardId:p.selectedCardId
   });
   // STRICTLY the original printed one-target XingBei strikes. The
   // complete chooseToUse skill/range/game.checkMod pipeline is not run.
   // All other card classes fail closed without suggesting a target.
   const candidates=[];
   for(let targetSeat=0;targetSeat<players.length;targetSeat++){
    if(targetSeat===seat)continue;
    const result=this.preflightNativePrintedAttackTarget({
     seat,playerId,cardId:p.selectedCardId,targetSeat
    });
    if(result.supportedPrintedAttack&&result.printedTargetEligible)
     candidates.push('s'+targetSeat);
   }
   if(candidates.length<2)
    return Object.freeze({started:false,code:'V3_PRINTED_TARGET_PREVIEW_UNSUPPORTED',
     fullRulesValidated:false,actionExecuted:false});
   p.targetStage={options:candidates,ticket:null,state:'requested',
    selectedTargetSeat:null};
   try{
    if(bridge.requestNativeSelectionPreview({
     seat,kind:'target',prompt:'原生行動：選擇印刷規則允許的目標（不會攻擊）',
     options:candidates,previousTicket:p.ticket,previousOption:p.selectedCardId
    })!==true)
     throw err('V3_NATIVE_TARGET_PREVIEW_NOT_ROUTED');
   }catch(e){p.targetStage=null;throw e}
   return Object.freeze({started:true,printedTargetsOnly:true,
    targetCount:candidates.length,fullRulesValidated:false,
    targetFullyValidated:false,actionExecuted:false});
  },
  inspectNativeChooseToUseWaitContract({seat,playerId}={}){
   // Identity/provenance preflight for the ORIGINAL GameEvent waiting
   // boundary, not an interpreter, client-owned event or use-card action.
   const gate=game.__v3PausedPhaseRuntime,actor=players[seat],
    event=gate?.selectionEvent;
   if(!Number.isInteger(seat)||seat!==game.__v3OpeningTurnBoundary?.firstSeat||
      typeof playerId!=='string'||actor?.playerid!==playerId||
      !gate?.selectionGate||gate.failure||!_status.paused||
      !(event instanceof lib.element.GameEvent)||event.player!==actor||
      event.name!=='gongJiOrFaShu'||gate.actionEvent?.name!=='xingDong'||
      lib.playerOL[playerId]!==actor||game.playerMap[playerId]!==actor||
      actor.ws?.id!==playerId)
    throw err('V3_NATIVE_WAIT_OWNER_DENIED');
   const compiled=event.content?.compiled===true&&
    (event.content.original==='chooseToUse'||
     event.content.original===lib.element.content?.chooseToUse);
   if(!compiled||!Array.isArray(event._args)||event._args.length!==0||
      event.filterCard!==lib.filter.filterCard||
      event.filterTarget!==lib.filter.filterTarget)
    throw err('V3_NATIVE_WAIT_CONTENT_UNSUPPORTED');
   const local=actor.getSkills('invisible'),global=lib.skill.global;
   if(!Array.isArray(local)||!Array.isArray(global))
    throw err('V3_NATIVE_WAIT_SKILLS_UNAVAILABLE');
   const skills=new Set([...local,...global]);
   const callbackCount=Array.from(skills).filter(id=>
    typeof lib.skill[id]?.onChooseToUse==='function').length;
   return Object.freeze({
    originalNativeGameEvent:true,
    originalGameEventName:event.name,
    compiledChooseToUse:true,
    originalCompilerType:event.content.type??null,
    stablePlayerBound:true,
    playerOnlineViaServer:actor.isOnline()===true,
    ownerSeat:seat,playerId,
    originalEventPaused:true,
    originalContentExecuted:false,
    potentialOnChooseToUseCallbacks:callbackCount,
    callbacksExecuted:false,arbitraryRemoteCodeAllowed:false,
    waitingTransportHookImplemented:false,
    nativeChoiceApplied:false,fullRulesValidated:false,
    actionExecuted:false
   });
  },
  inspectNativeActionInvariant(){
   // Trusted CI/CDP-only full-state comparison. This is never sent to
   // public players: it contains ALL seats' physical card identifiers.
   const gate=game.__v3PausedPhaseRuntime;
   if(!gate||!gate.selectionGate||!_status.paused||
      gate.selectionEvent?.name!=='gongJiOrFaShu')
    throw err('V3_NATIVE_INVARIANT_NOT_READY');
   return Object.freeze({
    paused:_status.paused===true,
    nativeActionEvent:gate.actionEvent instanceof lib.element.GameEvent,
    nativeSelectionEvent:gate.selectionEvent instanceof lib.element.GameEvent,
    actionEventName:gate.actionEvent.name,
    selectionEventName:gate.selectionEvent.name,
    actorId:gate.selectionEvent.player.playerid,
    phaseNumber:game.phaseNumber,
    currentPhaseId:_status.currentPhase?.playerid??null,
    actionCounter:gate.selectionEvent.player?.storage?.gongJiOrFaShu??null,
    redMorale:game.hongShiQi,blueMorale:game.lanShiQi,
    maxMorale:game.shiQiMax,
    eventStackDepth:_status.eventManager.eventStack.length,
    // The active hand is read from REAL native Card/Player DOM, never from
    // a client-owned mirror or a broker private projection.
    hands:players.map(p=>p.getCards('h').map(c=>c.__v3PhysicalId)),
    hp:players.map(p=>p.hp??null),
    maxHp:players.map(p=>p.maxHp??null),
    activePlayers:game.players.map(p=>p.playerid),
    deck:Array.from(ui.cardPile?.childNodes??[]).map(c=>c.__v3PhysicalId),
    waitingNodes:Object.keys(lib.node?.torespond??{}).sort(),
    originalSelectionContentExecuted:false,
    fullRulesValidated:false
   });
  },
  auditNativePrintedAttackStaticRules({seat,playerId,cardId,targetSeat}={}){
   // Read-only capability audit, NOT a legal chooseToUse / useResult.
   // Original lib.filter.filterCard/cardUsable can write event.addCount_extra
   // and game.checkMod executes arbitrary character skill callbacks.
   // Never call those functions on the paused authoritative event here.
   const target=this.preflightNativePrintedAttackTarget({
    seat,playerId,cardId,targetSeat
   });
   const actor=players[seat],def=lib.card[actor.getCards('h').find(c=>
    c.__v3PhysicalId===cardId)?.name];
   const gate=game.__v3PausedPhaseRuntime;
   // Static printed-rule evidence must be bound to the SAME native
   // selection GameEvent as the caller's current (read-only) ownership
   // check. A former actor's filter is never proof for a later seat.
   const activeSelection=gate?.fourthActionGate?
    gate.fourthSelectionEvent:gate?.thirdActionGate?
    gate.thirdSelectionEvent:gate?.nextActionGate?
    gate.nextSelectionEvent:gate?.selectionEvent;
   const activeEventOwned=activeSelection instanceof lib.element.GameEvent&&
    activeSelection.player===actor&&
    activeSelection.name==='gongJiOrFaShu';
   const staticCardContract=activeEventOwned&&
    target.supportedPrintedAttack===true&&
    def?.enable===true&&def?.selectTarget===1&&
    def?.usable===undefined&&def?.updateUsable===undefined&&
    def?.range===undefined&&def?.outrange===undefined&&
    def?.modTarget===undefined&&def?.singleCard===undefined&&
    activeSelection.filterCard===lib.filter.filterCard&&
    activeSelection.filterTarget===lib.filter.filterTarget;
   // Original chooseToUse step 0 expands invisible/global skills and
   // invokes onChooseToUse. Original game.checkMod may invoke mod hooks.
   // Detect possible callbacks by inspecting definitions, never execute.
   // Even zero detected hooks is not a full legality proof: hidden skill
   // expansion, virtual cards, usage history, response windows remain.
   const actorSkills=actor.getSkills('invisible');
   const targetSkills=players[targetSeat].getSkills('invisible');
   const globalSkills=lib.skill.global;
   const listsWellFormed=Array.isArray(actorSkills)&&
    Array.isArray(targetSkills)&&Array.isArray(globalSkills);
   const ids=listsWellFormed?new Set([
    ...actorSkills,...targetSkills,...globalSkills
   ]):new Set();
   let dynamicHookCount=0,unresolvedSkillDefinitions=0;
   for(const skillId of ids){
    if(typeof skillId!=='string'||!skillId||
       !lib.skill[skillId]||typeof lib.skill[skillId]!=='object'){
     unresolvedSkillDefinitions++;continue;
    }
    const info=lib.skill[skillId];
    if(info.mod!==undefined||info.onChooseToUse!==undefined||
       info.group!==undefined||info.global!==undefined||
       info.inherit!==undefined)
     dynamicHookCount++;
   }
   const staticPreconditionsPassed=staticCardContract&&
    target.printedTargetEligible===true&&listsWellFormed&&
    unresolvedSkillDefinitions===0;
   return Object.freeze({
    staticPreconditionsPassed,
    printedTargetEligible:target.printedTargetEligible,
    printedDefinitionVerified:staticCardContract,
    dynamicHooksPresent:dynamicHookCount>0,
    dynamicHookCount,unresolvedSkillDefinitions,
    dynamicRulesEvaluated:false,cardEnabledEvaluated:false,
    cardUsableEvaluated:false,rangeModsEvaluated:false,
    fullRulesValidated:false,actionExecuted:false,cardConsumed:false,
    originalEventStillPaused:_status.paused===true&&activeEventOwned,
    activeOriginalEventPlayerId:activeEventOwned?actor.playerid:null,
    seat,playerId,cardId,targetSeat
   });
  },
  inspectNativeUseCardPreview(){
   const p=useCardPreview;
   if(!p)return Object.freeze({opened:false,recorded:false});
   const gate=game.__v3PausedPhaseRuntime;
   return Object.freeze({opened:p.ticket!==null,
    state:p.state,recorded:p.state==='recorded',
    passed:p.state==='passed',
    seat:p.seat,playerId:p.playerId,
    selectedCardId:p.selectedCardId,
    targetPreviewOpened:p.targetStage?.ticket!==null&&
     p.targetStage?.ticket!==undefined,
    targetPreviewState:p.targetStage?.state??null,
    targetOptions:p.targetStage?[...p.targetStage.options]:[],
    selectedTargetSeat:p.targetStage?.selectedTargetSeat??null,
    staticRuleAudit:p.targetStage?.staticRuleAudit??null,
    nativeGameEvent:p.event instanceof lib.element.GameEvent,
    originalEvent:p.event.name,
    samePausedEvent:(gate?.thirdSelectionContentReleased?
     gate.thirdSelectionEvent:gate?.nextSelectionContentReleased?
     gate.nextSelectionEvent:gate?.selectionEvent)===p.event&&_status.paused===true,
    fullRulesValidated:false,actionExecuted:false,cardConsumed:false,
    nativeUnwaitInvoked:false});
  },
  preflightNativeActionCardOwnership({seat,playerId,cardId}={}){
   // Read-only, NOT a legal card-action authorization. Only checks that
   // the authenticated active native Player physically holds this card.
   // Full target legality, costs, skills, and effect resolution are pending.
   const gate=game.__v3PausedPhaseRuntime;
   // An actor that has already passed must never retain a usable
   // ownership preflight after the scheduler advances to another seat.
   // Resolve from the MOST RECENT authentic native action boundary.
   const fourth=Boolean(gate?.fourthActionGate);
   const third=!fourth&&Boolean(gate?.thirdActionGate);
   const second=!fourth&&!third&&Boolean(gate?.nextActionGate);
   const actorSeat=fourth?players.indexOf(gate.fourthActionGate.player):
    third?players.indexOf(gate.thirdActionGate.player):
    second?players.indexOf(gate.nextActionGate.player):
    game.__v3OpeningTurnBoundary?.firstSeat;
   const actor=players[actorSeat];
   const selection=fourth?gate.fourthSelectionEvent:
    third?gate.thirdSelectionEvent:
    second?gate.nextSelectionEvent:gate?.selectionEvent;
   const action=fourth?gate.fourthActionGate.event:
    third?gate.thirdActionGate.event:
    second?gate.nextActionGate.event:gate?.actionEvent;
   const selectionReached=fourth?gate.fourthSelectionGate:
    third?gate.thirdSelectionGate:
    second?gate.nextSelectionGate:gate?.selectionGate;
   if(!gate||gate.failure||!selectionReached||
      !(selection instanceof lib.element.GameEvent)||
      selection.name!=='gongJiOrFaShu'||
      !(action instanceof lib.element.GameEvent)||
      action.name!=='xingDong'||
      !_status.paused||selection.player!==actor||
      !Number.isInteger(seat)||seat!==actorSeat||
      typeof playerId!=='string'||actor?.playerid!==playerId||
      typeof cardId!=='string'||!/^v3card_[a-f0-9]{6}$/.test(cardId))
    throw err('V3_NATIVE_CARD_OWNERSHIP_DENIED');
   const owned=actor.getCards('h').filter(c=>
    c instanceof lib.element.Card&&c.__v3PhysicalId===cardId);
   if(owned.length!==1)
    throw err('V3_NATIVE_CARD_OWNERSHIP_DENIED');
   return Object.freeze({
    ownedByActivePlayer:true,
    ownershipPreflightOnly:true,
    fullRulesValidated:false,
    targetValidated:false,actionExecuted:false,
    cardConsumed:false,seat,playerId
   });
  },
  preflightNativePrintedAttackTarget({seat,playerId,cardId,targetSeat}={}){
   // Read-only printed-card target check at the still-paused original
   // gongJiOrFaShu event. NOT a rules authorization or target selection.
   this.preflightNativeActionCardOwnership({seat,playerId,cardId});
   if(!Number.isInteger(targetSeat)||targetSeat<0||
      targetSeat>=players.length)
    throw err('V3_NATIVE_ATTACK_TARGET_DENIED');
   const actor=players[seat],target=players[targetSeat];
   if(!game.players.includes(actor)||!game.players.includes(target)||
      target===actor||!target.isIn())
    throw err('V3_NATIVE_ATTACK_TARGET_DENIED');
   const physical=actor.getCards('h').find(c=>
    c instanceof lib.element.Card&&c.__v3PhysicalId===cardId);
   if(!physical)throw err('V3_NATIVE_ATTACK_TARGET_DENIED');
   // These five printed XingBei strikes have an original one-target
   // enemy-only predicate. Never infer rules for spells/skills/virtual cards.
   const printedStrikes=new Set([
    'anMie','shuiLianZhan','huoYanZhan','fengShenZhan','leiGuangZhan'
   ]);
   const info=lib.card[physical.name];
   const supported=printedStrikes.has(physical.name)&&
    info?.type==='gongJi'&&info.selectTarget===1&&
    typeof info.filterTarget==='function';
   let printedTargetEligible=false;
   if(supported){
    // No changing _status.event, ui.selected or pause state. If the
    // original filter throws, deny rather than accepting a guessed target.
    try{printedTargetEligible=info.filterTarget(physical,actor,target)===true}
    catch{throw err('V3_NATIVE_ATTACK_TARGET_DENIED')}
   }
   return Object.freeze({
    ownershipPreflightPassed:true,
    supportedPrintedAttack:supported,
    printedTargetEligible,
    fullRulesValidated:false,targetFullyValidated:false,
    actionExecuted:false,cardConsumed:false,
    targetSeat,seat,playerId
   });
  },
  inspectOriginalSelectionGate(){
   const state=game.__v3PausedPhaseRuntime;
   if(!state)throw err('V3_NATIVE_SELECTION_GATE_NOT_STARTED');
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   const event=state.selectionEvent;
   return Object.freeze({
    actionEntryReleased:state.actionEntryReleased,
    failed:state.failure!==null,error:state.failure,trace:state.trace??null,
    selectionGateReached:state.selectionGate===true,
    nextSelectionGateReached:state.nextSelectionGate===true,
    nextSelectionEventNative:state.nextSelectionEvent instanceof lib.element.GameEvent,
    nextSelectionEventName:state.nextSelectionEvent?.name??null,
    nextSelectionOwnerPlayerId:state.nextSelectionEvent?.player?.playerid??null,
    nextSelectionContentExecuted:state.nextOriginalUseWaitReached===true,
    nextOriginalOnlineWaitReached:state.nextOriginalUseWaitReached===true,
    nextSelectionContentReleased:state.nextSelectionContentReleased===true,
    thirdSelectionGateReached:state.thirdSelectionGate===true,
    thirdSelectionEventNative:state.thirdSelectionEvent instanceof lib.element.GameEvent,
    thirdSelectionEventName:state.thirdSelectionEvent?.name??null,
    thirdSelectionOwnerPlayerId:state.thirdSelectionEvent?.player?.playerid??null,
    thirdSelectionContentExecuted:state.thirdOriginalUseWaitReached===true,
    thirdSelectionContentReleased:state.thirdSelectionContentReleased===true,
    thirdOriginalOnlineWaitReached:state.thirdOriginalUseWaitReached===true,
    fourthSelectionGateReached:state.fourthSelectionGate===true,
    fourthSelectionEventNative:state.fourthSelectionEvent instanceof lib.element.GameEvent,
    fourthSelectionEventName:state.fourthSelectionEvent?.name??null,
    fourthSelectionOwnerPlayerId:state.fourthSelectionEvent?.player?.playerid??null,
    fourthSelectionContentExecuted:false,
    originalXingDongEvent:state.actionEvent instanceof lib.element.GameEvent,
    selectionEventNative:event instanceof lib.element.GameEvent,
    selectionEventName:event?.name??null,
    selectionOwnerPlayerId:event?.player?.playerid??null,
    expectedOwnerPlayerId:first?.playerid??null,
    phaseNumber:game.phaseNumber,
    actionCounter:first?.storage?.gongJiOrFaShu??null,
    paused:_status.paused===true,phaseLoopComplete:state.finished,
    selectionContentExecuted:state.originalUseWaitReached===true,
    originalOnlineWaitReached:state.originalUseWaitReached===true,
    selectionContentReleased:state.selectionContentReleased===true,
    skillsVerified:false,replaySafe:false
   });
  },
  inspectOriginalActionGate(){
   const state=game.__v3PausedPhaseRuntime;
   if(!state)throw err('V3_NATIVE_ACTION_GATE_NOT_STARTED');
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   const event=state.actionEvent;
   return Object.freeze({
    entryReleased:state.entryReleased,
    failed:state.failure!==null,error:state.failure,
    trace:state.trace??null,
    actionGateReached:state.actionGate===true,
    actionEventNative:event instanceof lib.element.GameEvent,
    actionEventName:event?.name??null,
    actionPlayerId:event?.player?.playerid??null,
    firstPlayerId:first?.playerid??null,
    phaseNumber:game.phaseNumber,
    currentPhasePlayerId:_status.currentPhase?.playerid??null,
    nextActionGateReached:state.nextActionGate!==null,
    thirdActionGateReached:state.thirdActionGate!==null,
    thirdActionPlayerId:state.thirdActionGate?.player?.playerid??null,
    thirdActionEventNative:state.thirdActionGate?.event instanceof lib.element.GameEvent,
    thirdActionEntryReleased:state.thirdActionEntryReleased===true,
    fourthActionGateReached:state.fourthActionGate!==null,
    fourthActionPlayerId:state.fourthActionGate?.player?.playerid??null,
    fourthActionEventNative:state.fourthActionGate?.event instanceof lib.element.GameEvent,
    fourthActionEntryReleased:state.fourthActionEntryReleased===true,
    nextActionEntryReleased:state.nextActionEntryReleased===true,
    nextActionPlayerId:state.nextActionGate?.player?.playerid??null,
    nextActionEventNative:state.nextActionGate?.event instanceof lib.element.GameEvent,
    paused:_status.paused===true,loopComplete:state.finished,
    actualActionStepExecuted:false,
    replaySafe:false // Mid-turn event state remains non-persisted.
   });
  },
  inspectPausedFirstNativePhase(){
   const state=game.__v3PausedPhaseRuntime;
   if(!state)throw err('V3_NATIVE_PHASE_PROBE_NOT_STARTED');
   const firstPhase=state.phase.next?.find(e=>e.name==='phase');
   const first=players[game.__v3OpeningTurnBoundary?.firstSeat??-1];
   return Object.freeze({
    pauseTriggered:state.pauseTriggered,
    failed:state.failure!==null,error:state.failure,
    firstPhaseQueued:firstPhase instanceof lib.element.GameEvent&&
     firstPhase.player===first&&
     state.phase.player===first,
    firstPhasePlayerId:first?.playerid??null,
    firstPhaseActualNativeEvent:firstPhase instanceof lib.element.GameEvent,
    paused:_status.paused===true,
    seatNumbers:players.map(p=>p.getSeatNum()),
    redMorale:game.hongShiQi,blueMorale:game.lanShiQi,
    maxMorale:game.shiQiMax,
    scoreboardCreated:!!ui.shiQiInfo,
    phaseLoopCompleted:state.finished,
    hostOffboard:!players.includes(game.me)&&game.me?.side===undefined
   });
  },
  probeNativeFirstPhaseSetup(){
   // Execute original Player.setSeatNum and XingBei $initZhanJi, which are
   // called in phaseLoop step 0. Does not run phaseLoop.start()/skills.
   const turn=game.__v3OpeningTurnBoundary;
   if(!turn||game.__v3FirstPhaseSetup||adapter.inspect().pending!==0||
      !nativeOpeningDrawExecuted||!startingCardsDealt||draftFailure)
    throw err('V3_FIRST_PHASE_SETUP_NOT_READY');
   const start=players[turn.firstSeat];
   if(!start||players.some(p=>p.getSeatNum()!==0))
    throw err('V3_FIRST_PHASE_SEATS_NOT_CLEAN');
   for(let i=0,p=start;i<players.length;i++,p=p.next)
    p.setSeatNum(i+1);
   if(new Set(players.map(p=>p.getSeatNum())).size!==players.length)
    throw err('V3_FIRST_PHASE_SEAT_DUPLICATE');
   // The native game UI normally owns ui.window. Here it is a hidden,
   // independent Chromium-only DOM element with no connection to a human host.
   if(!ui.window){
    ui.window=document.createElement('div');
    ui.window.style.display='none';
    document.body.appendChild(ui.window);
   }
   game.$initZhanJi();
   if(!ui.shiQiInfo||game.hongShiQi!==game.shiQiMax||
      game.lanShiQi!==game.shiQiMax||game.me?.side!==undefined)
    throw err('V3_FIRST_PHASE_MORALE_BOOT_FAILED');
   const result=Object.freeze({
    realNativeSeatNumbers:true,
    realNativeMorale:true,
    seatNumbers:players.map(p=>p.getSeatNum()),
    redMorale:game.hongShiQi,blueMorale:game.lanShiQi,
    maxMorale:game.shiQiMax,
    nativeScoreboard:true,firstSeat:turn.firstSeat,
    eventLoopStarted:false,skillsStarted:false
   });
   Object.defineProperty(game,'__v3FirstPhaseSetup',{
    configurable:false,enumerable:false,value:result
   });
   return result;
  },
  async probeNativeGameDrawExecution(){
   // Destructive OFFLINE ONLY. The 4 native opening cards were already staged
   // for snapshot verification. This separately exercises the ORIGINAL
   // gameDraw GameEvent on top of that state; never treat resulting 8-card
   // hands as a playable/recoverable game state.
   if(!game.__v3OpeningTurnBoundary||game.__v3NativeDrawProbe||
      !game.__v3NativeDrawPile||draftFailure||!startingCardsDealt||
      adapter.inspect().pending!==0||_status.eventManager.eventStack.length!==0)
    throw err('V3_NATIVE_DRAW_PROBE_NOT_READY');
   const root=_status.eventManager.rootEvent;
   const draw=root?.next?.find(x=>x.name==='gameDraw');
   if(!(draw instanceof lib.element.GameEvent)||
      !players.includes(draw.player)||draw.num!==4)
    throw err('V3_NATIVE_DRAW_PROBE_EVENT_INVALID');
   // Physically seed original native Card instances in the original ui pile.
   if(!ui.cardPile){
    const holder=document.createElement('div');
    holder.style.display='none';
    document.body.appendChild(holder);
    ui.cardPile=holder;
   }
   if(ui.cardPile.hasChildNodes())throw err('V3_NATIVE_DRAW_PILE_DIRTY');
   // Native boot normally derives a card comparator from get.sortCard().
   // This isolated ESM bootstrap must use that ORIGINAL comparator too.
   ensureCardSorter();
   const originalCount=players.map(x=>x.getCards('h').length);
   for(let i=0;i<players.length*4;i++){
    const card=game.__v3NativeDrawPile.draw();
    if(!card)throw err('V3_NATIVE_DRAW_PROBE_DECK_EXHAUSTED');
    const node=ui.create.card(ui.cardPile).init(card.face);
    if(!(node instanceof lib.element.Card))
     throw err('V3_NATIVE_DRAW_PROBE_CARD_INVALID');
    Object.defineProperty(node,'__v3PhysicalId',{value:card.instanceId,
     configurable:false,enumerable:false});
   }
   let finished=false;
   try{
    // Native scheduler executes the real content.js gameDraw content.
    await draw.start();
    finished=true;
   }catch(e){
    throw Object.assign(err('V3_NATIVE_DRAW_PROBE_EXECUTION_FAILED'),{cause:e});
   }
   const afterCount=players.map(x=>x.getCards('h').length);
   const result=Object.freeze({
    realNativeGameDrawExecuted:finished,
    eventName:draw.name,firstSeat:players.indexOf(draw.player),
    before:originalCount,after:afterCount,
    gainedExactlyFour:afterCount.every((n,i)=>n===originalCount[i]+4),
    // No phaseLoop.start()/skills were executed by this probe.
    nativePhaseLoopExecuted:false,turnResolved:false
   });
   Object.defineProperty(game,'__v3NativeDrawProbe',{value:result,
    configurable:false,enumerable:false});
   if(!result.gainedExactlyFour)throw err('V3_NATIVE_DRAW_PROBE_COUNT_MISMATCH');
   return result;
  },
  // Strictly trusted Chromium-side accessor only; broker must authenticate
  // before ever projecting this to a human WebSocket.
  privateSeatView({seat}={}){
   if(!Number.isInteger(seat)||seat<0||seat>=players.length)
    throw err('V3_NATIVE_PRIVATE_SEAT_INVALID');
   return Object.freeze({
    playerId:players[seat].playerid,seat,
    character:players[seat].name1??null,
    ownHand:(physicalCardsBySeat.get(seat)??[]).map(card=>Object.freeze({
     cardId:card.__v3PhysicalId,name:card.name
    })),
    publicOtherHandCounts:players.map((_,i)=>({
     seat:i,handCount:physicalCardsBySeat.get(i)?.length??0
    }))
   });
  },
  commitCharacterDraft({seat}={}){
   const draft=drafts.get(seat);
   if(!draft||draftFailure)throw err('V3_DRAFT_NOT_PENDING');
   const answer=draft.event.result?.control;
   if(!answer)return Object.freeze({ok:false,code:'V3_DRAFT_AWAITING_VERIFIED_REPLY'});
   if(!draft.offers.includes(answer)||!legalCharacters.has(answer)||chosen.has(answer)){
    draftFailure='ILLEGAL_CHARACTER_RESULT';
    throw err('V3_DRAFT_RESULT_INVALID');
   }
   const player=players[seat];
   try{
    player.init(answer,null,null,false);
    if(player.name1!==answer)throw err('V3_NATIVE_CHARACTER_INIT_MISMATCH');
   }catch(e){draftFailure='NATIVE_CHARACTER_INIT_FAILED';throw e}
   drafts.delete(seat);chosen.add(answer);
   return Object.freeze({ok:true,code:'V3_NATIVE_CHARACTER_INITIALIZED',
    seat,playerId:player.playerid,character:answer,
    actualNativePlayer:player instanceof lib.element.Player,
    nativeSkillCount:player.skills.length});
  },
  mode:'xingBei',
  stagingOnly:true,
  fullRulesStarted:false,
  roster(){
   return players.map((p,seat)=>Object.freeze({
    seat,playerId:p.playerid,connected:!p.ws.closed,
    nativePlayer:p instanceof lib.element.Player,
    nativeClient:p.ws instanceof lib.element.Client,
    side:p.side?'hong':'lan',
    character:p.name1??null,
    handCount:physicalCardsBySeat.get(seat)?.length??0
   }));
  },
  inspect(){
   return Object.freeze({
    offboard:!players.includes(game.me)&&!game.me.playerid,
    seatCount:players.length,
    actualNativePlayers:players.every(p=>p instanceof lib.element.Player),
    cardContentLoaded:!!game.__v3NativeContentStage,
    characterCount:chosen.size,draftPending:drafts.size,
    startingCardsDealt,nativeOpeningDrawExecuted,restoredOpening,
    fatalDraftError:draftFailure,
    gameLoopStarted:false,
    pendingNativeChoices:adapter.inspect().pending
   });
  }
 });
 if(previewHooksAvailable){
 const previewHooked=bridge.registerNativeSelectionPreviewHooks({
  opened(message){
   const view=message?.view,p=useCardPreview;
   if(!message?.ok||!p||view?.source!=='preview'||
      view.state!=='open'||view.seat!==p.seat||
      view.playerId!==p.playerId||
      typeof view.ticket!=='string'||!(/^[a-f0-9]{32}$/.test(view.ticket)))
    return false;
   if(view.kind==='card'){
    if(p.state!=='requested'||p.ticket!==null||
       JSON.stringify(view.options)!==JSON.stringify(p.options))return false;
    p.ticket=view.ticket;p.state='open';return true;
   }
   const target=p.targetStage;
   if(view.kind!=='target'||p.state!=='recorded'||!target||
      target.state!=='requested'||target.ticket!==null||
      JSON.stringify(view.options)!==JSON.stringify(target.options))
    return false;
   target.ticket=view.ticket;target.state='open';return true;
  },
  delivered(message){
   const p=useCardPreview,gate=game.__v3PausedPhaseRuntime;
   if(!p||(gate?.thirdSelectionContentReleased?
       gate.thirdSelectionEvent:gate?.nextSelectionContentReleased?
       gate.nextSelectionEvent:gate?.selectionEvent)!==p.event||!_status.paused||
      message?.seat!==p.seat||message.playerId!==p.playerId)
    return false;
   if(p.state==='open'&&p.ticket===message.ticket&&
      p.options.includes(message.option)){
    if(message.option==='pass'){
     if(!p.allowPass)return false;
     // A trusted, real native Player.unwait({bool:false}) advances
     // the original engine only with a NO-CARD response.
     p.state='passed';
     try{
      const applied=adapter.consumeOriginalUsePass({
       seat:p.seat,playerId:p.playerId,event:p.event
      });
      if(applied?.nativePassApplied===true)return true;
     }catch{}
     p.state='open';return false;
    }
    try{session.preflightNativeActionCardOwnership({
     seat:p.seat,playerId:p.playerId,cardId:message.option
    })}catch{return false}
    p.selectedCardId=message.option;p.state='recorded';
    return true;
   }
   const target=p.targetStage;
   if(p.state!=='recorded'||!target||target.state!=='open'||
      target.ticket!==message.ticket||
      !target.options.includes(message.option)||!/^s[0-7]$/.test(message.option))
    return false;
   const targetSeat=Number(message.option.slice(1));
   let audit;
   try{
    audit=session.auditNativePrintedAttackStaticRules({
     seat:p.seat,playerId:p.playerId,cardId:p.selectedCardId,targetSeat
    });
    if(!audit.printedTargetEligible||!audit.printedDefinitionVerified)return false;
   }catch{return false}
   // Only record a still-eligible intended target and its conservative
   // original-definition audit; no GameEvent result or skill effects.
   target.staticRuleAudit=audit;
   target.selectedTargetSeat=targetSeat;target.state='recorded';
   return true;
  }
 });
 if(previewHooked!==true)throw err('V3_NATIVE_USE_PREVIEW_HOOKS_UNAVAILABLE');
 }
 Object.defineProperty(game,'__v3NativeSeatSession',{configurable:false,enumerable:false,value:session});
 return session;
}
