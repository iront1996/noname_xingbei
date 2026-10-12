import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';

const executable=process.env.V3_CHROMIUM;
const enabled=typeof executable==='string'&&executable.startsWith('/');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let sequence=0;
async function until(check){
 for(let i=0;i<240;i++){
  const v=await check();if(v)return v;
  await sleep(35);
 }
 throw Error('ORIGINAL_USE_WAIT_TEST_TIMEOUT');
}
async function connect(url){
 const ws=new WebSocket(url),received=[];
 ws.addEventListener('message',e=>{try{received.push(JSON.parse(e.data))}catch{}});
 await Promise.race([
  new Promise((ok,bad)=>{
   ws.addEventListener('open',ok,{once:true});
   ws.addEventListener('error',bad,{once:true});
  }),
  sleep(10000).then(()=>{throw Error('ORIGINAL_USE_SOCKET_TIMEOUT')})
 ]);
 return {ws,received};
}
async function ask(peer,type,body={}){
 const requestId='orig'+(++sequence);
 peer.ws.send(JSON.stringify({type,requestId,...body}));
 return until(()=>peer.received.find(x=>x.type==='reply'&&x.requestId===requestId));
}

for(const {answer,seatCount} of [
 {answer:'card',seatCount:4},
 {answer:'pass',seatCount:4},
 {answer:'pass',seatCount:6},
 {answer:'pass',seatCount:8}
])test('original XingBei '+(seatCount/2)+'v'+(seatCount/2)+' chooseToUse '+answer+
 ' waits or passes without using a card',{
 skip:!enabled,timeout:90000
},async()=>{
 const {WebSocketServer}=await import('ws');
 const host=await createV3NativeModuleTestServer({
  root:resolve(dirname(fileURLToPath(import.meta.url)),'..')
 });
 let chrome;
 const broker=await createV3AuthorityWebSocketBroker({
  WebSocketServer,enableChoiceWindowExperiments:true,
  enableNativeOwnershipProbes:true,
  launchWorker:async()=>{
   chrome=await launchV3ChromiumAuthorityWorker({executable});
   assert.equal((await chrome.loadV3NativeModules({origin:host.origin})).loaded,true);
   return chrome;
  }
 });
 const peers=[];
 try{
  for(let i=0;i<seatCount;i++)peers.push(await connect(broker.address));
  const roomId='V3_ORIGINAL_NATIVE_WAIT';
  const sessions=[await ask(peers[0],'create',{
   roomId,config:{mode:'xingBei',seatMode:(seatCount/2)+'v'+(seatCount/2)}
  })];
  for(let i=1;i<seatCount;i++)sessions.push(await ask(peers[i],'join',{roomId}));
  assert.ok(sessions.every(x=>x.ok));
  assert.equal((await ask(peers[0],'launch')).code,
   'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  const stage=await chrome.stageNativeXingBeiSeats();
  assert.equal(stage.ok,true);
  for(let seat=0;seat<seatCount;seat++){
   const offers=stage.characters.slice(seat*2,seat*2+2);
   await chrome.beginNativeCharacterDraft({seat,offers});
   const choice=await until(()=>peers[seat].received.find(x=>
    x.type==='choice_window'&&x.window?.source==='native'&&
    x.window.kind==='control'
   )?.window);
   assert.equal((await ask(peers[seat],'choice_submit',{
    ticket:choice.ticket,option:'o0'
   })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
   await until(async()=>(await chrome.commitNativeCharacterDraft({seat})).ok);
  }
  const dealt=await chrome.dealNativeOpeningCardsByOriginalEvent();
  assert.equal(dealt.nativeGameDrawTriggered,true);
  assert.equal(dealt.realNativeGameEventCompleted,true);
  assert.deepEqual(dealt.nativeHandCounts,Array(seatCount).fill(4));
  const before=await chrome.inspectNativePrivateHand({seat:0});
  const pid=chrome.pid;
  assert.equal((await chrome.stageNativeOpeningTurnBoundary({firstSeat:0})).realNativeEvents,true);
  assert.equal((await chrome.startPausedNativePhaseLoop()).started,true);
  await until(async()=>{
   const s=await chrome.inspectPausedNativePhaseLoop();
   if(s.failed)throw Error('PHASE_FAILED_'+s.error);
   return s.pauseTriggered&&s.firstPhaseQueued&&s.paused;
  });
  assert.equal((await chrome.releaseOriginalPhaseToActionGate()).started,true);
  await until(async()=>{
   const s=await chrome.inspectOriginalActionGate();
   if(s.failed)throw Error('ACTION_FAILED_'+s.error+'_'+s.trace);
   return s.actionGateReached&&s.paused;
  });
  assert.equal((await chrome.releaseOriginalActionToSelectionGate()).started,true);
  await until(async()=>{
   const s=await chrome.inspectOriginalSelectionGate();
   if(s.failed)throw Error('SELECTION_FAILED_'+s.error+'_'+s.trace);
   return s.selectionGateReached&&s.paused;
  });
  const beforeNative=await chrome.evaluateSeatExperiment(
   'window.__v3NativeXingBeiTest.core.game.__v3NativeSeatSession.inspectNativeActionInvariant()'
  );
  assert.equal(beforeNative.paused,true);
  const released=await chrome.releaseOriginalSelectionToNativeWait();
  assert.equal(released.started,true);
  assert.equal(released.nativeChooseToUse,true);
  assert.equal(released.ownerPlayerId,sessions[0].playerId);
  assert.equal(released.actionExecuted,false);
  const waiting=await until(async()=>{
   const s=await chrome.inspectOriginalSelectionGate();
   if(s.failed)throw Error('ORIGINAL_USE_FAILED_'+s.error+'_'+s.trace);
   return s.originalOnlineWaitReached&&s.paused&&s;
  });
  assert.equal(waiting.selectionContentExecuted,true);
  assert.equal(waiting.phaseLoopComplete,false);
  assert.equal(waiting.actionCounter,1);
  const window=await until(()=>peers[0].received.find(m=>
   m.type==='choice_window'&&m.window?.source==='preview'&&
   m.window.kind==='card'
  )?.window);
  assert.deepEqual([...window.options].sort(),
   [...before.ownHand.map(c=>c.cardId),'pass'].sort());
  assert.equal((await chrome.inspectNativeUseCardPreview()).state,'open');
  const waitState=await chrome.evaluateSeatExperiment(
   'window.__v3NativeXingBeiTest.core.game.__v3NativeWaitAdapter.inspect()'
  );
  assert.equal(waitState.originalUseWaitReached,1);
  assert.equal(waitState.armedOriginalUseWait,false);
  assert.equal(waitState.waitingCount,1);
  const badUnwait=await chrome.evaluateSeatExperiment(`(()=>{
   const p=window.__v3NativeXingBeiTest.core.game.players[0];
   try{p.unwait('ai');return 'UNEXPECTED_UNWAIT'}
   catch(e){return e.code??e.message}
  })()`);
  assert.equal(badUnwait,'V3_NATIVE_UNWAIT_DENIED');
  assert.equal((await ask(peers[1],'choice_submit',{
   ticket:window.ticket,option:window.options[0]
  })).code,'CHOICE_WINDOW_NOT_FOUND');
  const boundBeforeDisconnect=await chrome.evaluateSeatExperiment(
   'window.__v3AuthorityBridge.getSeatBindings()'
  );
  assert.equal(boundBeforeDisconnect.length,seatCount);
  assert.ok(boundBeforeDisconnect.every(p=>/^[a-f0-9]{24}$/.test(p.connectionId)));
  // Every human including the creator leaves at the live original
  // GameEvent wait. The authoritative browser must NOT belong to any
  // human socket, nor answer using AI while all sockets are gone.
  for(const peer of peers)peer.ws.close();
  await until(()=>broker.roomView(roomId).roster.every(x=>!x.connected));
  const empty=await until(async()=>{
   const s=await chrome.inspectNativeXingBeiSeats();
   return s.roster.every(x=>!x.connected)&&s;
  });
  assert.equal(empty.roster.length,seatCount);
  assert.equal((await broker.inspectWorker(roomId)).code,'WORKER_PROOF_ALIVE');
  assert.equal(chrome.pid,pid);
  assert.equal((await chrome.inspectRoomChannel()).boundPeerCount,0);
  const pausedOffline=await chrome.inspectNativeUseCardPreview();
  assert.equal(pausedOffline.state,'open');
  assert.equal(pausedOffline.samePausedEvent,true);
  // A Chromium-authorized renewal succeeds even with ZERO human peers.
  // Human browsers cannot renew any ticket on their own.
  await sleep(25);
  assert.equal(await chrome.evaluateSeatExperiment(
   'window.__v3AuthorityBridge.testRenewPreviewLeases()'),true);
  const replacements=[];
  for(let seat=0;seat<seatCount;seat++){
   const peer=await connect(broker.address);peers.push(peer);
   replacements.push(peer);
   const resumed=await ask(peer,'reconnect',{
    roomId,seat,reconnectToken:sessions[seat].reconnectToken
   });
   assert.equal(resumed.playerId,sessions[seat].playerId);
   assert.notEqual(resumed.reconnectToken,sessions[seat].reconnectToken);
  }
  const next=replacements[0];
  const reopened=await until(()=>next.received.find(x=>
   x.type==='choice_window'&&x.window?.source==='preview'&&
   x.window.ticket===window.ticket
  )?.window);
  assert.deepEqual(reopened.options,window.options);
  assert.ok(reopened.expiresAt>window.expiresAt);
  for(let seat=1;seat<seatCount;seat++){
   assert.equal(replacements[seat].received.some(x=>
    x.type==='choice_window'&&x.window?.ticket===window.ticket),false);
   assert.equal((await ask(replacements[seat],'choice_submit',{
    ticket:window.ticket,option:window.options[0]
   })).code,'CHOICE_WINDOW_NOT_FOUND');
  }
  assert.equal((await chrome.inspectRoomChannel()).boundPeerCount,seatCount);
  assert.equal(chrome.pid,pid);
  const boundAfterReconnect=await chrome.evaluateSeatExperiment(
   'window.__v3AuthorityBridge.getSeatBindings()'
  );
  assert.equal(boundAfterReconnect.length,seatCount);
  for(let seat=0;seat<seatCount;seat++){
   assert.equal(boundAfterReconnect[seat].playerId,boundBeforeDisconnect[seat].playerId);
   assert.match(boundAfterReconnect[seat].connectionId,/^[a-f0-9]{24}$/);
   assert.notEqual(boundAfterReconnect[seat].connectionId,
    boundBeforeDisconnect[seat].connectionId);
  }
  const submittedOption=answer==='pass'?'pass':
   reopened.options.find(c=>c!=='pass');
  assert.equal((await ask(next,'choice_submit',{
   ticket:reopened.ticket,option:submittedOption
  })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  if(answer==='card'){
   await until(async()=>(await chrome.inspectNativeUseCardPreview()).recorded);
   assert.equal((await chrome.inspectNativeUseCardPreview()).nativeUnwaitInvoked,false);
   assert.equal((await chrome.inspectOriginalSelectionGate()).paused,true);
  }else{
   await until(async()=>(await chrome.inspectNativeUseCardPreview()).passed);
   const consumed=await chrome.evaluateSeatExperiment(
    'window.__v3NativeXingBeiTest.core.game.__v3NativeWaitAdapter.inspect()'
   );
   assert.equal(consumed.originalUsePassApplied,1);
   assert.equal(consumed.waitingOriginalUse,false);
   await until(async()=>(await ask(next,'choice_query')).window?.state==='applied');
   assert.equal((await ask(next,'choice_submit',{
    ticket:reopened.ticket,option:submittedOption
   })).code,'CHOICE_ALREADY_APPLIED');
   // A native no-card response must reach the original xingDong step 5
   // and decrement the authentic action allowance, not just ACK a ticket.
   const progressed=await until(async()=>{
    const state=await chrome.evaluateSeatExperiment(`(()=>{
     const {game}=window.__v3NativeXingBeiTest.core;
     const gate=game.__v3PausedPhaseRuntime;
     return {counter:game.players[0].storage.gongJiOrFaShu,
      originalEvent:gate.selectionEvent?.name,
      actionEvent:gate.actionEvent?.name,
      error:gate.failure??null,
      trace:String(gate.trace??'').slice(0,380)}
    })()`);
    if(state.error)throw Error('ORIGINAL_PASS_PROGRESSION_'+state.error+
     '_'+state.trace);
    return state.counter===0&&state;
   });
   assert.equal(progressed.originalEvent,'gongJiOrFaShu');
   assert.equal(progressed.actionEvent,'xingDong');
   assert.equal(progressed.counter,0);
   const nextActor=await until(async()=>{
    const state=await chrome.inspectOriginalActionGate();
    if(state.failed)throw Error('NEXT_NATIVE_ACTOR_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,230));
    return state.nextActionGateReached&&state.paused&&state;
   });
   assert.equal(nextActor.nextActionPlayerId,sessions[1].playerId);
   assert.equal(nextActor.nextActionEventNative,true);
   assert.equal(nextActor.loopComplete,false);
   assert.equal(nextActor.actualActionStepExecuted,false);
   // The first player's genuine no-card result must NOT grant the
   // next seat implicit use-card authority. Release only the original
   // second xingDong to its still-paused gongJiOrFaShu child.
   const release=await chrome.releaseNextOriginalActionToSelectionGate();
   assert.equal(release.started,true);
   assert.equal(release.ownerPlayerId,sessions[1].playerId);
   assert.equal(release.actualCardPlayed,false);
   const secondSelection=await until(async()=>{
    const state=await chrome.inspectOriginalSelectionGate();
    if(state.failed)throw Error('SECOND_NATIVE_SELECTION_FAILED_'+
     state.error+'_'+String(state.trace??'').slice(0,230));
    return state.nextSelectionGateReached&&state.paused&&state;
   });
   assert.equal(secondSelection.nextSelectionEventNative,true);
   assert.equal(secondSelection.nextSelectionEventName,'gongJiOrFaShu');
   assert.equal(secondSelection.nextSelectionOwnerPlayerId,sessions[1].playerId);
   assert.equal(secondSelection.nextSelectionContentExecuted,false);
   const invariant=await chrome.evaluateSeatExperiment(`(()=>{
    const {game,ui,_status}=window.__v3NativeXingBeiTest.core;
    return {
     hands:game.players.map(p=>p.getCards('h').map(c=>c.__v3PhysicalId)),
     deck:Array.from(ui.cardPile?.childNodes??[]).map(c=>c.__v3PhysicalId),
     hp:game.players.map(p=>p.hp??null),
     actor:_status.event?.player?.playerid??null,
     paused:_status.paused===true,
     nextEvent:game.__v3PausedPhaseRuntime.nextSelectionEvent?.name
    };
   })()`);
   assert.deepEqual(invariant.hands,beforeNative.hands);
   assert.deepEqual(invariant.deck,beforeNative.deck);
   assert.deepEqual(invariant.hp,beforeNative.hp);
   assert.equal(invariant.paused,true);
   assert.equal(invariant.nextEvent,'gongJiOrFaShu');
   await assert.rejects(chrome.releaseNextOriginalActionToSelectionGate(),
    /V3_NATIVE_NEXT_SELECTION_RELEASE_DENIED/);
   assert.equal((await ask(replacements[1],'command',{action:'playCard'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
  }
  const after=await chrome.inspectNativePrivateHand({seat:0});
  assert.deepEqual(after.ownHand,before.ownHand);
  assert.equal((await ask(next,'command',{action:'playCard'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
  assert.equal(chrome.pid,pid);
  // A card preview is still paused in original step zero. Native pass
  // may advance original phase actions but cannot consume any card.
  if(answer==='card'){
   const afterNative=await chrome.evaluateSeatExperiment(
    'window.__v3NativeXingBeiTest.core.game.__v3NativeSeatSession.inspectNativeActionInvariant()'
   );
   assert.deepEqual(afterNative.hands,beforeNative.hands);
   assert.deepEqual(afterNative.deck,beforeNative.deck);
   assert.deepEqual(afterNative.hp,beforeNative.hp);
   assert.equal(afterNative.redMorale,beforeNative.redMorale);
   assert.equal(afterNative.blueMorale,beforeNative.blueMorale);
   assert.equal(afterNative.actionCounter,beforeNative.actionCounter);
   assert.equal(afterNative.paused,true);
  }
 }finally{
  for(const p of peers)try{p.ws.close()}catch{}
  await broker.close();
  await host.close();
 }
});
