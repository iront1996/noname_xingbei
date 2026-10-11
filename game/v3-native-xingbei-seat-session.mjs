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
 let draftFailure=null,startingCardsDealt=false;
 const physicalCardsBySeat=new Map();
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
    remaining:pile.remaining(),
    // These are counts only. Never return opponents' private card identities.
    privateDetailsIncluded:false,
    nativeGameDrawTriggered:false
   });
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
    startingCardsDealt,
    fatalDraftError:draftFailure,
    gameLoopStarted:false,
    pendingNativeChoices:adapter.inspect().pending
   });
  }
 });
 Object.defineProperty(game,'__v3NativeSeatSession',{configurable:false,enumerable:false,value:session});
 return session;
}
