/**
 * Chromium-only offline test: authentic socket sessions + real native Game and
 * actual XingBei mode object + V3 winner adaptor. No fake gameplay.
 */
export function buildV3RealSessionOutcomeProbe(){
 return `(async()=>{
  if(window.isNonameServer!==true||
     !window.__v3AuthorityBridge||
     !window.__v3NativeXingBeiTest)return {ok:false,code:'MISSING_NATIVE_BRIDGE'};
  const bindings=window.__v3AuthorityBridge.getSeatBindings();
  if(!Array.isArray(bindings)||bindings.length!==4||
     bindings.some(b=>!b.connectionId))return {ok:false,code:'AUTHENTICATED_ROSTER_NOT_READY'};
  const {core,mode}=window.__v3NativeXingBeiTest;
  const {installV3HostNeutralOutcome}=await import('/game/v3-native-xingbei-outcome-adapter.mjs');
  const nativeGame=core.game;
  nativeGame.me=document.createElement('div');
  nativeGame.players=bindings.map(b=>({
   playerid:b.playerId,side:b.seat%2===0
  }));
  nativeGame.hongShiQi=15;nativeGame.lanShiQi=15;
  nativeGame.hongXingBei=0;nativeGame.lanXingBei=0;nativeGame.xingBeiMax=5;
  const originalOver=nativeGame.over;
  nativeGame.over=()=>{throw Error('HUMAN_HOST_OVER_FORBIDDEN')};
  const published=[];
  const adapter=installV3HostNeutralOutcome({game:nativeGame,mode,onTerminal:p=>published.push(p)});
  const before=nativeGame.checkResult();
  nativeGame.lanShiQi=0;
  const ended=mode.game.checkResult();
  const publishedOnce=adapter.terminalResult()===ended&&published.length===1;
  nativeGame.over=originalOver;
  return {ok:publishedOnce&&ended.winner==='hong'&&before.terminal===false,
   publishedOnce,winner:ended.winner,
   perPlayer:ended.perPlayer,
   fromRealGame:nativeGame instanceof core.Game,
   realMode:mode.name,
   fromAuthenticatedBindings:ended.perPlayer.every(p=>bindings.some(b=>b.playerId===p.playerId)),
   hostOffboard:!nativeGame.players.includes(nativeGame.me)}
 })()`;
}
