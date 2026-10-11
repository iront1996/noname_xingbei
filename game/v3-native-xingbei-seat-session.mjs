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
 let draftFailure=null,startingCardsDealt=false,nativeOpeningDrawExecuted=false;
 const physicalCardsBySeat=new Map();
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
  // Complete opening setup checkpoint. Server/CDP only, never publish via
  // a human player socket or room-wide roster. NOT a game-event snapshot.
  exportOpeningCheckpoint({roomId,revision=1}={}){
   if(!startingCardsDealt||drafts.size!==0||chosen.size!==players.length||
      !game.__v3NativeDrawPile||draftFailure)
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
    startingCardsDealt,nativeOpeningDrawExecuted,
    fatalDraftError:draftFailure,
    gameLoopStarted:false,
    pendingNativeChoices:adapter.inspect().pending
   });
  }
 });
 Object.defineProperty(game,'__v3NativeSeatSession',{configurable:false,enumerable:false,value:session});
 return session;
}
