/** Test-only: execute native randomMapOL with real authenticated room identities. */
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const file=resolve(dirname(fileURLToPath(import.meta.url)),'../noname/game/index.js');
const native=readFileSync(file,'utf8');
const start=native.indexOf('\n\trandomMapOL(type) {');
const end=native.indexOf('\n\tcloseMenu() {',start);
if(start<0||end<0)throw new Error('NATIVE_RANDOM_MAP_NOT_FOUND');
const method=native.slice(start+1,end).trim();
export function buildV3NativeAuthorizedSeatProbe(){
 return `(()=>{
  const bridge=window.__v3AuthorityBridge;
  if(!bridge||!window.isNonameServer)return {error:'NOT_OFFBOARD'};
  const bindings=bridge.getSeatBindings();
  if(!Array.isArray(bindings)||!bindings.length||bindings.some(x=>!x.connectionId))return {error:'INCOMPLETE_BINDINGS'};
  Array.prototype.randomRemove=function(){return this.pop()};
  const clients=bindings.map(b=>({id:b.playerId,wsid:b.connectionId,nickname:'player'+b.seat}));
  const game={players:[],me:null,
   prepareArena(){this.players=Array.from({length:bindings.length},(_,seat)=>{
    const div=document.createElement('div');div.dataset.seat=''+seat;
    div.setNickname=function(){this.dataset.nickname=this.nickname};return div;
   })},
   broadcast(_callback,map){this.nativeMap=map},
   chooseCharacterOL(){this.reachedCharacterSelection=true}
  };
  const ui={arena:{classList:{add(){}}},create:{player(){return document.createElement('div')}}};
  const lib={node:{clients},playerOL:{},configOL:{mode:'xingBei',xingBei_mode:'2v2'}};
  const get={id:()=>{throw Error('PHANTOM_PLAYER_ID')},connectNickname:()=> 'authority'};
  const _status={};
  const native=Function('game','ui','lib','get','_status','return ({'+${JSON.stringify(method)}+'}).randomMapOL')(game,ui,lib,get,_status);
  native();
  const ids=game.nativeMap.map(x=>x[0]).sort();
  return {
   offboard:game.me instanceof HTMLDivElement&&!game.players.includes(game.me)&&!game.me.playerid,
   playerCount:game.players.length,
   nativeReachedChoice:game.reachedCharacterSelection===true,
   ids,serverIds:bindings.map(b=>b.playerId).sort(),
   socketBindingsPreserved:game.players.every(p=>p.ws&&p.ws.wsid&&p.ws.id===p.playerid),
   nativeSeatToPlayerId:game.players.map((p,i)=>({nativeSeat:i,playerId:p.playerid}))
  };
 })()`;
}
