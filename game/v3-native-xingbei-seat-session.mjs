/**
 * V3-only offboard XingBei native Player seat topology.
 *
 * This creates REAL Noname Player/Client DOM instances from authenticated
 * WebSocket identities, but intentionally does NOT execute the native
 * xingBei.start(), character draft, gameDraw or phaseLoop.
 * It is the isolated prerequisite for wiring those engines safely.
 */
import {installV3NativeEventWaitAdapter} from './v3-native-event-wait-adapter.mjs';

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
 const session=Object.freeze({
  mode:'xingBei',
  stagingOnly:true,
  fullRulesStarted:false,
  roster(){
   return players.map((p,seat)=>Object.freeze({
    seat,playerId:p.playerid,connected:!p.ws.closed,
    nativePlayer:p instanceof lib.element.Player,
    nativeClient:p.ws instanceof lib.element.Client,
    side:p.side?'hong':'lan',
    character:p.name1??null
   }));
  },
  inspect(){
   return Object.freeze({
    offboard:!players.includes(game.me)&&!game.me.playerid,
    seatCount:players.length,
    actualNativePlayers:players.every(p=>p instanceof lib.element.Player),
    cardContentLoaded:!!game.__v3NativeContentStage,
    gameLoopStarted:false,
    pendingNativeChoices:adapter.inspect().pending
   });
  }
 });
 Object.defineProperty(game,'__v3NativeSeatSession',{configurable:false,enumerable:false,value:session});
 return session;
}
