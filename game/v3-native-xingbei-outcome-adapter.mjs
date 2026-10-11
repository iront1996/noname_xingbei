/**
 * V3-only host-neutral XingBei terminal adapter. Never imported by V1/V2.
 * The real XingBei mode checks game.me.side (a human host). An off-seat
 * Chromium engine cannot use that perspective. Its authoritative result must
 * be per faction and projected to each real, authenticated Player ID.
 *
 * This module installs only AFTER native mode boot and authenticated seat
 * mapping. It does not replace GameEvent, card skills or persistent state.
 */
import {deriveV3XingBeiWinner,deriveV3SeatVictory} from './v3-xingbei-authority-outcome.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const idOk=x=>typeof x==='string'&&/^player_[a-f0-9]{32}$/.test(x);
export function installV3HostNeutralOutcome({game,mode,onTerminal}={}){
 if(!game||typeof game!=='object'||!mode||mode.name!=='xingBei'||
    !mode.game||typeof onTerminal!=='function'||
    typeof mode.game.checkResult!=='function'||
    typeof mode.game.checkOnlineResult!=='function')
  throw fail('V3_NATIVE_OUTCOME_BOOT_INVALID');
 if(game.__v3HostNeutralOutcome)throw fail('V3_NATIVE_OUTCOME_ALREADY_INSTALLED');
 let terminal=null;
 const ensureOffboard=()=>{
  if(!game.me||!Array.isArray(game.players)||game.players.includes(game.me)||
     game.me.side===true||game.me.side===false)
   throw fail('V3_OFFBOARD_HOST_REQUIRED');
 };
 const collectPlayerResults=outcome=>{
  if(!Array.isArray(game.players)||game.players.length!==[4,6,8].find(x=>x===game.players.length))
   throw fail('V3_NATIVE_ROSTER_INCOMPLETE');
  const seen=new Set();
  const players=game.players.map(p=>{
   if(!idOk(p.playerid)||seen.has(p.playerid)||(p.side!==true&&p.side!==false))
    throw fail('V3_NATIVE_PLAYER_SIDE_INVALID');
   seen.add(p.playerid);
   const r=deriveV3SeatVictory(outcome,p.side===true?'hong':'lan');
   if(!r.ok)throw fail(r.code);
   return Object.freeze({playerId:p.playerid,won:r.won});
  });
  return Object.freeze(players);
 };
 const checkResult=function(){
  ensureOffboard();
  const outcome=deriveV3XingBeiWinner({
   hongShiQi:game.hongShiQi,lanShiQi:game.lanShiQi,
   hongXingBei:game.hongXingBei,lanXingBei:game.lanXingBei,
   xingBeiMax:game.xingBeiMax
  });
  if(!outcome.ok)throw fail(outcome.code);
  if(!outcome.terminal)return outcome;
  if(terminal){
   if(terminal.winner!==outcome.winner)throw fail('V3_TERMINAL_WINNER_CHANGED');
   return terminal;
  }
  const perPlayer=collectPlayerResults(outcome);
  const payload=Object.freeze({ok:true,terminal:true,winner:outcome.winner,perPlayer});
  // Never use legacy game.over(bool): it treats game.me.side as a human and
  // may leak all hands in the end-of-game dialog.
  onTerminal(payload);
  terminal=payload;
  return payload;
 };
 const checkOnlineResult=function(player){
  ensureOffboard();
  if(!terminal)return undefined;
  if(!player||!idOk(player.playerid))throw fail('V3_NATIVE_PLAYER_SIDE_INVALID');
  const result=terminal.perPlayer.find(x=>x.playerId===player.playerid);
  if(!result)throw fail('V3_NATIVE_PLAYER_UNAUTHORIZED');
  return result.won;
 };
 game.checkResult=checkResult;
 game.checkOnlineResult=checkOnlineResult;
 mode.game.checkResult=checkResult;
 mode.game.checkOnlineResult=checkOnlineResult;
 Object.defineProperty(game,'__v3HostNeutralOutcome',{configurable:false,enumerable:false,
  value:Object.freeze({terminalResult:()=>terminal,checkResult,checkOnlineResult})});
 return game.__v3HostNeutralOutcome;
}
