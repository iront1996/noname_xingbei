/**
 * V3-only pure winner derivation independent of a human host's game.me.side.
 * Mirrors mode/xingBei.js checkResult predicates. Call only at a completed
 * authoritative rules transition, not during partial nested event resolution.
 * NOT wired to current V3. Does not supply a full rules engine.
 */
const err=code=>Object.freeze({ok:false,code});
export function deriveV3XingBeiWinner(state){
 if(!state||typeof state!=='object'||Array.isArray(state))return err('STATE_INVALID');
 const keys=['hongShiQi','lanShiQi','hongXingBei','lanXingBei','xingBeiMax'];
 const val={};
 for(const key of keys){
  const descriptor=Object.getOwnPropertyDescriptor(state,key);
  if(!descriptor||!('value' in descriptor)||!Number.isSafeInteger(descriptor.value))
   return err('STATE_INVALID');
  val[key]=descriptor.value;
 }
 if(val.hongXingBei<0||val.lanXingBei<0||val.xingBeiMax<1)
  return err('STATE_INVALID');
 const hongWin=val.lanShiQi<=0||val.hongXingBei>=val.xingBeiMax;
 const lanWin=val.hongShiQi<=0||val.lanXingBei>=val.xingBeiMax;
 if(hongWin&&lanWin)return err('CONFLICTING_TERMINAL_CONDITIONS');
 const winner=hongWin?'hong':lanWin?'lan':null;
 return Object.freeze({ok:true,terminal:winner!==null,winner});
}
export function deriveV3SeatVictory(outcome,side){
 if(!outcome||outcome.ok!==true||outcome.terminal!==true||
    !['hong','lan'].includes(outcome.winner)||!['hong','lan'].includes(side))
  return err('NO_CERTIFIED_TERMINAL_RESULT');
 return Object.freeze({ok:true,won:side===outcome.winner});
}
