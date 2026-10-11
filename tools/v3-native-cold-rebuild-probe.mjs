/**
 * CI-ONLY native opening cold rehydration proof.
 * Fresh Chrome profile/ESM realm and synthetic seat bindings, NOT a live broker.
 * Never claim running GameEvent, transport token, or mid-turn crash recovery.
 */
async function probe({checkpoint,roomId,bindings}){
 try{
  if(window.isNonameServer!==true||window.__v3AuthorityBridge)
   throw Error('COLD_PROBE_NOT_FRESH_CHROME');
  Object.defineProperty(window,'__v3AuthorityBridge',{
   configurable:false,
   value:Object.freeze({
    getSeatBindings:()=>bindings.map(x=>({...x})),
    registerNativeChoiceHooks:hooks=>
     !!hooks&&typeof hooks.delivered==='function'&&
     typeof hooks.opened==='function',
    requestNativeChoice:()=>false
   })
  });
  const {core}=window.__v3NativeXingBeiTest;
  const stage=(await import('/game/v3-native-xingbei-content-stager.mjs'))
   .stageV3NativeXingBeiContent;
  const seats=(await import('/game/v3-native-xingbei-seat-session.mjs'))
   .prepareV3NativeXingBeiSeats;
  const pack=await stage({core});
  const session=seats({core,bridge:window.__v3AuthorityBridge});
  const before=session.inspect();
  let tamperRejected=false,wrongRoomRejected=false,wrongIdRejected=false;
  const tampered=structuredClone(checkpoint);
  tampered.players[0].hand[0].name='forged_card';
  try{session.restoreOpeningCheckpoint({checkpoint:tampered,roomId})}
  catch(e){tamperRejected=e?.code==='V3_OPENING_RESTORE_CARD_INVALID'}
  try{session.restoreOpeningCheckpoint({checkpoint,roomId:'WRONG'})}
  catch(e){wrongRoomRejected=e?.code==='V3_OPENING_RESTORE_SCHEMA_INVALID'}
  const forged=structuredClone(checkpoint);
  forged.players[0].playerId='player_'+'a'.repeat(32);
  try{session.restoreOpeningCheckpoint({checkpoint:forged,roomId})}
  catch(e){wrongIdRejected=e?.code==='V3_OPENING_RESTORE_PLAYER_MISMATCH'}
  if(!tamperRejected||!wrongRoomRejected||!wrongIdRejected||
     session.inspect().characterCount!==0)
   throw Error('COLD_RESTORE_PREFLIGHT_NOT_ATOMIC');
  const restored=session.restoreOpeningCheckpoint({checkpoint,roomId});
  const exported=session.exportOpeningCheckpoint({
   roomId,revision:checkpoint.revision
  });
  const same=JSON.stringify(exported)===JSON.stringify(checkpoint);
  const duplicateDenied=(()=>{
   try{session.restoreOpeningCheckpoint({checkpoint,roomId})}
   catch(e){return e?.code==='V3_OPENING_RESTORE_DENIED'}
   return false;
  })();
  const next=await session.stageOpeningTurnBoundary({firstSeat:0});
  return {
   ok:true,pack:pack.realSource,preflightNoCharacters:before.characterCount===0,
   tamperRejected,wrongRoomRejected,wrongIdRejected,
   restored,byteEquivalent:same,
   allPlayerIdsMatch:session.roster().every((p,seat)=>
    p.playerId===checkpoint.players[seat].playerId&&
    p.character===checkpoint.players[seat].character&&p.handCount===4),
   duplicateDenied,
   phaseEvent:next.phaseEvent,
   phaseOnly:next.eventsQueued.length===1&&
    next.eventsQueued[0]==='phaseLoop'&&next.openingDrawAlreadyExecuted,
   phaseStarted:false,brokerConnected:false
  };
 }catch(e){
  return {ok:false,code:String(e?.code??e?.message??e).slice(0,125),
   cause:String(e?.stack??'').slice(0,240)};
 }
}

export async function proveV3ColdNativeOpening({worker,snapshot,roomId}={}){
 if(!worker||typeof worker.evaluateSeatExperiment!=='function'||
    typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)||
    snapshot?.roomId!==roomId||![4,6,8].includes(snapshot?.players?.length))
  throw new TypeError('COLD_PROBE_ARGUMENT_INVALID');
 const bindings=snapshot.players.map(p=>({
  seat:p.seat,playerId:p.playerId,
  connectionId:'f'.repeat(24) // Synthetic test, NOT a real WS connection.
 }));
 const expression='('+probe.toString()+')('+JSON.stringify({
  checkpoint:snapshot,roomId,bindings
 })+')';
 return worker.evaluateSeatExperiment(expression);
}
