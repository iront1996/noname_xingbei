/**
 * V2 Xingbei own-seat poison source restoration only. No arbitrary Player.storage
 * serialization, game event execution, extra skill registration, or triggers.
 * card/xingBei.js records source Player refs in target.storage.zhongDu.
 */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SOURCES = 32;
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
function validSeat(id,roster) {
  return typeof id==="string"&&ID.test(id)&&roster&&typeof roster==="object"&&
    !Array.isArray(roster)&&own(roster,id)&&roster[id]&&
    typeof roster[id]==="object";
}
export function captureXingbeiOwnPoisonSources(seatId,player,roster) {
  if(!validSeat(seatId,roster)||roster[seatId]!==player||
     !player.storage||!Array.isArray(player.storage.zhongDu)||
     player.storage.zhongDu.length>MAX_SOURCES)return null;
  const sources=[];
  for(const source of player.storage.zhongDu){
    if(!source||!validSeat(source.playerid,roster)||
       roster[source.playerid]!==source)return null;
    sources.push(source.playerid);
  }
  return {protocol:1,seatId,zhongDuSources:sources};
}
export function applyXingbeiOwnPoisonSources(report,seatId,roster) {
  // Validate entirely before any write. Reject new keys and cross-seat data.
  if(!report||typeof report!=="object"||Array.isArray(report)||
     Object.keys(report).length!==3||
     !["protocol","seatId","zhongDuSources"].every(k=>own(report,k))||
     report.protocol!==1||report.seatId!==seatId||!validSeat(seatId,roster)||
     !Array.isArray(report.zhongDuSources)||
     report.zhongDuSources.length>MAX_SOURCES)return false;
  const sources=[];
  for(const id of report.zhongDuSources){
    if(!validSeat(id,roster))return false;
    sources.push(roster[id]);
  }
  const player=roster[seatId];
  if(!player.storage||typeof player.storage!=="object"||
     Array.isArray(player.storage))return false;
  player.storage.zhongDu=sources; // No skill/event/card methods called.
  return true;
}
