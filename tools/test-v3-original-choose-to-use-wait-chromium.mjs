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
 {answer:'pass',seatCount:8},
 {answer:'crash',seatCount:4}
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
  const replacements=[],currentTokens=[];
  for(let seat=0;seat<seatCount;seat++){
   const peer=await connect(broker.address);peers.push(peer);
   replacements.push(peer);
   const resumed=await ask(peer,'reconnect',{
    roomId,seat,reconnectToken:sessions[seat].reconnectToken
   });
   assert.equal(resumed.playerId,sessions[seat].playerId);
   assert.notEqual(resumed.reconnectToken,sessions[seat].reconnectToken);
   currentTokens[seat]=resumed.reconnectToken;
  }
  const next=replacements[0];
  let finalSeatZero=next;
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
  const submittedOption=answer==='card'?
   reopened.options.find(c=>c!=='pass'):'pass';
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
   // The second actor can lose the socket at an authentic native event
   // boundary; no human client owns the Chromium process or can close it.
   const originalSecond=replacements[1];
   const beforeSecondGeneration=boundAfterReconnect[1].connectionId;
   originalSecond.ws.close();
   await until(()=>broker.roomView(roomId).roster[1].connected===false);
   const missingSecond=await chrome.inspectOriginalSelectionGate();
   assert.equal(missingSecond.nextSelectionGateReached,true);
   assert.equal(missingSecond.nextSelectionOwnerPlayerId,sessions[1].playerId);
   assert.equal(missingSecond.paused,true);
   assert.equal(chrome.pid,pid);
   const newSecond=await connect(broker.address);
   peers.push(newSecond);
   const secondResumed=await ask(newSecond,'reconnect',{
    roomId,seat:1,reconnectToken:currentTokens[1]
   });
   assert.equal(secondResumed.ok,true);
   assert.equal(secondResumed.playerId,sessions[1].playerId);
   assert.notEqual(secondResumed.reconnectToken,currentTokens[1]);
   assert.equal((await ask(newSecond,'reconnect',{
    roomId,seat:1,reconnectToken:currentTokens[1]
   })).ok,false);
   const freshBindings=await until(async()=>{
    const list=await chrome.evaluateSeatExperiment(
     'window.__v3AuthorityBridge.getSeatBindings()');
    return list[1]?.connectionId!==beforeSecondGeneration&&list;
   });
   assert.equal(freshBindings[1].playerId,sessions[1].playerId);
   assert.match(freshBindings[1].connectionId,/^[a-f0-9]{24}$/);
   assert.equal((await chrome.inspectOriginalSelectionGate()).paused,true);
   assert.equal((await chrome.inspectOriginalSelectionGate()).nextSelectionContentExecuted,false);
   assert.equal((await ask(newSecond,'command',{action:'playCard'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
   assert.equal(chrome.pid,pid);
   await assert.rejects(chrome.releaseNextOriginalActionToSelectionGate(),
    /V3_NATIVE_NEXT_SELECTION_RELEASE_DENIED/);
   // A reconnected second actor enters its OWN genuine native online
   // wait, receives a fresh private pass ticket, and is allowed only to
   // decline the card: never authorize an actual card/skill action.
   const secondWait=await chrome.releaseNextOriginalSelectionToNativeWait();
   assert.equal(secondWait.started,true);
   assert.equal(secondWait.ownerPlayerId,sessions[1].playerId);
   const waited=await until(async()=>{
    const state=await chrome.inspectOriginalSelectionGate();
    if(state.failed)throw Error('NEXT_ORIGINAL_WAIT_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,230));
    return state.nextOriginalOnlineWaitReached&&state.paused&&state;
   });
   assert.equal(waited.nextSelectionContentReleased,true);
   const secondWindow=await until(()=>newSecond.received.find(m=>
    m.type==='choice_window'&&m.window?.source==='preview'&&
    m.window?.kind==='card'&&m.window?.options.includes('pass')
   )?.window);
   assert.equal(secondWindow.seat,1);
   assert.equal(secondWindow.playerId,sessions[1].playerId);
   assert.deepEqual(secondWindow.options.slice(0,-1).sort(),
    (await chrome.inspectNativePrivateHand({seat:1})).ownHand.map(c=>c.cardId).sort());
   assert.equal((await ask(replacements[0],'choice_submit',{
    ticket:secondWindow.ticket,option:'pass'
   })).code,'CHOICE_WINDOW_NOT_FOUND');
   // Disconnect the ENTIRE human roster again while actor #2 waits
   // inside the original chooseToUse event. Chromium must still own it.
   for(const peer of replacements)peer.ws.close();
   newSecond.ws.close();
   await until(()=>broker.roomView(roomId).roster.every(x=>!x.connected));
   await until(async()=> (await chrome.inspectRoomChannel()).boundPeerCount===0);
   const offlineWait=await chrome.inspectNativeUseCardPreview();
   assert.equal(offlineWait.state,'open');
   assert.equal(offlineWait.samePausedEvent,true);
   assert.equal(offlineWait.playerId,sessions[1].playerId);
   assert.equal(chrome.pid,pid);
   const finalPeers=[],finalTokens=[];
   for(let seat=0;seat<seatCount;seat++){
    const peer=await connect(broker.address);peers.push(peer);
    finalPeers.push(peer);
    const oldToken=seat===1?secondResumed.reconnectToken:currentTokens[seat];
    const resumed=await ask(peer,'reconnect',{
     roomId,seat,reconnectToken:oldToken
    });
    assert.equal(resumed.ok,true);
    assert.equal(resumed.playerId,sessions[seat].playerId);
    assert.notEqual(resumed.reconnectToken,oldToken);
    finalTokens[seat]=resumed.reconnectToken;
   }
   finalSeatZero=finalPeers[0];
   const finalSecond=finalPeers[1];
   const restoredTicket=await until(()=>finalSecond.received.find(m=>
    m.type==='choice_window'&&m.window?.source==='preview'&&
    m.window?.ticket===secondWindow.ticket
   )?.window);
   assert.deepEqual(restoredTicket.options,secondWindow.options);
   assert.equal(restoredTicket.playerId,sessions[1].playerId);
   assert.equal(finalPeers.some((peer,i)=>i!==1&&peer.received.some(m=>
    m.type==='choice_window'&&m.window?.ticket===secondWindow.ticket)),false);
   assert.equal((await chrome.inspectRoomChannel()).boundPeerCount,seatCount);
   assert.equal(chrome.pid,pid);
   if(answer==='crash'){
    // A mid-event Chromium death is NOT a resumable checkpoint.
    // Never grant the still-visible ticket a false native success.
    await chrome.stop();
    const health=await until(async()=>{
     const status=await broker.inspectWorker(roomId);
     return status.code==='WORKER_UNAVAILABLE'&&status;
    });
    assert.equal(health.ok,false);
    assert.equal((await ask(finalSecond,'choice_submit',{
     ticket:restoredTicket.ticket,option:'pass'
    })).code,'WORKER_CHANNEL_OFFLINE');
    const roomAfterDeath=broker.roomView(roomId);
    assert.equal(roomAfterDeath.roster.length,seatCount);
    assert.ok(roomAfterDeath.roster.every(p=>p.connected));
    assert.equal((await broker.recoverOpeningCheckpoint(roomId)).code,
     'OPENING_RECOVERY_DISABLED');
    return; // Finally closes the still-isolated broker and sockets.
   }
   assert.equal((await ask(finalSecond,'choice_submit',{
    ticket:restoredTicket.ticket,option:'pass'
   })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
   await until(async()=>(await chrome.evaluateSeatExperiment(
    'window.__v3NativeXingBeiTest.core.game.__v3NativeWaitAdapter.inspect()'
   )).originalUsePassApplied===2);
   const thirdActor=await until(async()=>{
    const state=await chrome.inspectOriginalActionGate();
    if(state.failed)throw Error('THIRD_NATIVE_ACTOR_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,230));
    return state.thirdActionGateReached&&state.paused&&state;
   });
   assert.equal(thirdActor.thirdActionPlayerId,sessions[2].playerId);
   assert.equal(thirdActor.thirdActionEventNative,true);
   // Third actor may advance only to its ORIGINAL chooseToUse boundary:
   // do not grant an action or create a ticket before explicit approval.
   assert.equal(thirdActor.thirdActionEntryReleased,false);
   const thirdRelease=await chrome.releaseThirdOriginalActionToSelectionGate();
   assert.equal(thirdRelease.started,true);
   assert.equal(thirdRelease.ownerPlayerId,sessions[2].playerId);
   assert.equal(thirdRelease.actionExecuted,false);
   const thirdSelection=await until(async()=>{
    const state=await chrome.inspectOriginalSelectionGate();
    if(state.failed)throw Error('THIRD_NATIVE_SELECTION_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,230));
    return state.thirdSelectionGateReached&&state.paused&&state;
   });
   assert.equal(thirdSelection.thirdSelectionEventNative,true);
   assert.equal(thirdSelection.thirdSelectionEventName,'gongJiOrFaShu');
   assert.equal(thirdSelection.thirdSelectionOwnerPlayerId,sessions[2].playerId);
   assert.equal(thirdSelection.thirdSelectionContentExecuted,false);
   assert.equal((await chrome.inspectOriginalActionGate()).thirdActionEntryReleased,true);
   await assert.rejects(chrome.releaseThirdOriginalActionToSelectionGate(),
    /V3_NATIVE_THIRD_SELECTION_RELEASE_DENIED/);
   assert.equal(finalPeers.some(peer=>peer.received.some(m=>
    m.type==='choice_window'&&m.window?.seat===2&&
    m.window?.source==='preview')),false);
   // Read-only physical hand preflight now belongs ONLY to the latest
   // native actor; a completed second player's old event is stale.
   const thirdHand=await chrome.inspectNativePrivateHand({seat:2});
   const ownThird=await ask(finalPeers[2],'action_ownership_probe',{
    cardId:thirdHand.ownHand[0].cardId
   });
   assert.equal(ownThird.code,'ACTION_CARD_OWNERSHIP_PRECHECK_PASSED');
   assert.equal(ownThird.actionExecuted,false);
   // Inspect the original event provenance without calling a dynamic
   // filter or exposing any other player's private cards.
   const thirdEventLineage=await chrome.evaluateSeatExperiment(`(()=>{
    const {game,lib,_status}=window.__v3NativeXingBeiTest.core;
    const gate=game.__v3PausedPhaseRuntime,actor=game.players[2];
    return {paused:_status.paused===true,
     actorBound:gate.thirdSelectionEvent?.player===actor,
     native:gate.thirdSelectionEvent instanceof lib.element.GameEvent,
     oldSelectionDifferent:gate.nextSelectionEvent!==gate.thirdSelectionEvent,
     stepExecuted:gate.thirdSelectionContentReleased===true};
   })()`);
   assert.equal(thirdEventLineage.paused,true);
   assert.equal(thirdEventLineage.actorBound,true);
   assert.equal(thirdEventLineage.native,true);
   assert.equal(thirdEventLineage.oldSelectionDifferent,true);
   assert.equal(thirdEventLineage.stepExecuted,false);
   const oldSecondHand=await chrome.inspectNativePrivateHand({seat:1});
   const obsolete=await ask(finalSecond,'action_ownership_probe',{
    cardId:oldSecondHand.ownHand[0].cardId
   });
   assert.equal(obsolete.code,'ACTION_CARD_OWNERSHIP_DENIED');
   assert.equal(obsolete.actionExecuted,false);
   const thirdWait=await chrome.releaseThirdOriginalSelectionToNativeWait();
   assert.equal(thirdWait.started,true);
   assert.equal(thirdWait.ownerPlayerId,sessions[2].playerId);
   const waitingThird=await until(async()=>{
    const state=await chrome.inspectOriginalSelectionGate();
    if(state.failed)throw Error('THIRD_WAIT_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,240));
    return state.thirdOriginalOnlineWaitReached&&state.paused&&state;
   });
   assert.equal(waitingThird.thirdSelectionContentReleased,true);
   const thirdWindow=await until(()=>finalPeers[2].received.find(m=>
    m.type==='choice_window'&&m.window?.source==='preview'&&
    m.window?.kind==='card'&&m.window?.seat===2&&
    m.window?.options.includes('pass')
   )?.window);
   assert.equal(thirdWindow.playerId,sessions[2].playerId);
   assert.deepEqual(thirdWindow.options.slice(0,-1).sort(),
    thirdHand.ownHand.map(c=>c.cardId).sort());
   for(let seat=0;seat<seatCount;seat++){
    if(seat===2)continue;
    assert.equal(finalPeers[seat].received.some(m=>
     m.type==='choice_window'&&m.window?.ticket===thirdWindow.ticket),false);
    assert.equal((await ask(finalPeers[seat],'choice_submit',{
     ticket:thirdWindow.ticket,option:'pass'
    })).code,'CHOICE_WINDOW_NOT_FOUND');
   }
   assert.equal((await ask(finalPeers[2],'choice_submit',{
    ticket:thirdWindow.ticket,option:'pass'
   })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
   await until(async()=>(await chrome.evaluateSeatExperiment(
    'window.__v3NativeXingBeiTest.core.game.__v3NativeWaitAdapter.inspect()'
   )).originalUsePassApplied===3);
   const fourth=await until(async()=>{
    const state=await chrome.inspectOriginalActionGate();
    if(state.failed)throw Error('FOURTH_NATIVE_ACTOR_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,240));
    return state.fourthActionGateReached&&state.paused&&state;
   });
   assert.equal(fourth.fourthActionPlayerId,sessions[3].playerId);
   assert.equal(fourth.fourthActionEventNative,true);
   await assert.rejects(chrome.releaseThirdOriginalSelectionToNativeWait(),
    /V3_NATIVE_THIRD_ORIGINAL_USE_RELEASE_DENIED/);
   const finalNative=await chrome.evaluateSeatExperiment(`(()=>{
    const {game,ui}=window.__v3NativeXingBeiTest.core;
    return {hands:game.players.map(p=>p.getCards('h').map(c=>c.__v3PhysicalId)),
     deck:Array.from(ui.cardPile?.childNodes??[]).map(c=>c.__v3PhysicalId),
     hp:game.players.map(p=>p.hp??null),
     secondCounter:game.players[1].storage.gongJiOrFaShu,
     thirdCounter:game.players[2].storage.gongJiOrFaShu};
   })()`);
   // The fourth native phase has legitimately advanced through its
   // original draw hook BEFORE the xingDong entry gate. Prove exactly
   // one physical card moved from the deck to that actor; do not
   // mistake that real game transition for card-use side effects.
   for(let seat=0;seat<seatCount;seat++){
    if(seat!==3)assert.deepEqual(finalNative.hands[seat],beforeNative.hands[seat]);
   }
   const initialFourth=beforeNative.hands[3],actualFourth=finalNative.hands[3];
   assert.equal(actualFourth.length,initialFourth.length+1);
   const added=actualFourth.filter(id=>!initialFourth.includes(id));
   assert.equal(added.length,1);
   const drawnCardId=added[0];
   assert.match(drawnCardId,/^v3card_[a-f0-9]{6}$/);
   assert.deepEqual(actualFourth.filter(id=>id!==drawnCardId),initialFourth);
   assert.equal(beforeNative.deck.filter(id=>id===drawnCardId).length,1);
   assert.equal(finalNative.deck.includes(drawnCardId),false);
   assert.equal(finalNative.deck.length,beforeNative.deck.length-1);
   assert.deepEqual(finalNative.deck,
    beforeNative.deck.filter(id=>id!==drawnCardId));
   // Exactly one card is transferred, never generated or duplicated.
   const initialPhysical=[...beforeNative.hands.flat(),...beforeNative.deck].sort();
   const finalPhysical=[...finalNative.hands.flat(),...finalNative.deck].sort();
   assert.deepEqual(finalPhysical,initialPhysical);
   assert.deepEqual(finalNative.hp,beforeNative.hp);
   assert.equal(finalNative.secondCounter,0);
   assert.equal(finalNative.thirdCounter,0);
   const fourthRelease=await chrome.releaseFourthOriginalActionToSelectionGate();
   assert.equal(fourthRelease.started,true);
   assert.equal(fourthRelease.ownerPlayerId,sessions[3].playerId);
   assert.equal(fourthRelease.actionExecuted,false);
   const fourthSelection=await until(async()=>{
    const state=await chrome.inspectOriginalSelectionGate();
    if(state.failed)throw Error('FOURTH_SELECTION_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,240));
    return state.fourthSelectionGateReached&&state.paused&&state;
   });
   assert.equal(fourthSelection.fourthSelectionEventNative,true);
   assert.equal(fourthSelection.fourthSelectionEventName,'gongJiOrFaShu');
   assert.equal(fourthSelection.fourthSelectionOwnerPlayerId,sessions[3].playerId);
   assert.equal(fourthSelection.fourthSelectionContentExecuted,false);
   // The fourth native selection event must outlive its human socket.
   // No host migration or AI unwait is permitted during this reconnect.
   const fourthPid=chrome.pid;
   const fourthBeforeBinding=await chrome.evaluateSeatExperiment(
    'window.__v3AuthorityBridge.getSeatBindings()'
   );
   const previousFourthConnection=fourthBeforeBinding[3].connectionId;
   finalPeers[3].ws.close();
   await until(()=>broker.roomView(roomId).roster[3].connected===false);
   const pausedWithoutFourth=await chrome.inspectOriginalSelectionGate();
   assert.equal(pausedWithoutFourth.fourthSelectionGateReached,true);
   assert.equal(pausedWithoutFourth.fourthSelectionOwnerPlayerId,sessions[3].playerId);
   assert.equal(pausedWithoutFourth.paused,true);
   assert.equal(chrome.pid,fourthPid);
   const returnedFourth=await connect(broker.address);
   peers.push(returnedFourth);
   const fourthResumed=await ask(returnedFourth,'reconnect',{
    roomId,seat:3,reconnectToken:finalTokens[3]
   });
   assert.equal(fourthResumed.ok,true);
   assert.equal(fourthResumed.playerId,sessions[3].playerId);
   assert.notEqual(fourthResumed.reconnectToken,finalTokens[3]);
   // Testing a token on the already-bound new socket proves nothing:
   // the broker would reject that socket even with a valid token.
   // Replay the stale credential from a brand-new unauthenticated peer.
   const staleFourth=await connect(broker.address);
   peers.push(staleFourth);
   const staleReplay=await ask(staleFourth,'reconnect',{
    roomId,seat:3,reconnectToken:finalTokens[3]
   });
   assert.equal(staleReplay.ok,false);
   assert.equal(staleReplay.code,'RECONNECT_DENIED');
   assert.equal((await ask(staleFourth,'choice_query')).code,'NOT_AUTHENTICATED');
   const fourthRebinding=await until(async()=>{
    const now=await chrome.evaluateSeatExperiment(
     'window.__v3AuthorityBridge.getSeatBindings()'
    );
    return now[3]?.connectionId!==previousFourthConnection&&now;
   });
   assert.equal(fourthRebinding[3].playerId,sessions[3].playerId);
   assert.match(fourthRebinding[3].connectionId,/^[a-f0-9]{24}$/);
   assert.equal((await chrome.inspectOriginalSelectionGate()).paused,true);
   assert.equal(chrome.pid,fourthPid);
   assert.equal(returnedFourth.received.some(m=>
    m.type==='choice_window'&&m.window?.source==='preview'&&
    m.window?.seat===3),false);
   const fourthHand=await chrome.inspectNativePrivateHand({seat:3});
   const ownFourth=await ask(returnedFourth,'action_ownership_probe',{
    cardId:fourthHand.ownHand[0].cardId
   });
   assert.equal(ownFourth.code,'ACTION_CARD_OWNERSHIP_PRECHECK_PASSED');
   assert.equal(ownFourth.actionExecuted,false);
   assert.equal((await ask(finalPeers[2],'action_ownership_probe',{
    cardId:thirdHand.ownHand[0].cardId
   })).code,'ACTION_CARD_OWNERSHIP_DENIED');
   assert.equal(finalPeers.some(peer=>peer.received.some(m=>
    m.type==='choice_window'&&m.window?.source==='preview'&&
    m.window?.seat===3)),false);
   const fourthSafe=await chrome.evaluateSeatExperiment(`(()=>{
    const {game,ui,_status}=window.__v3NativeXingBeiTest.core;
    return {paused:_status.paused===true,
     hands:game.players.map(p=>p.getCards('h').map(c=>c.__v3PhysicalId)),
     deck:Array.from(ui.cardPile?.childNodes??[]).map(c=>c.__v3PhysicalId),
     hp:game.players.map(p=>p.hp??null)};
   })()`);
   assert.equal(fourthSafe.paused,true);
   assert.deepEqual(fourthSafe.hands,finalNative.hands);
   assert.deepEqual(fourthSafe.deck,finalNative.deck);
   assert.deepEqual(fourthSafe.hp,finalNative.hp);
   await assert.rejects(chrome.releaseFourthOriginalActionToSelectionGate(),
    /V3_NATIVE_FOURTH_SELECTION_RELEASE_DENIED/);
   await assert.rejects(chrome.releaseNextOriginalSelectionToNativeWait(),
    /V3_NATIVE_NEXT_ORIGINAL_USE_RELEASE_DENIED/);
   // Only the currently authenticated fourth actor reaches the real
   // original chooseToUse wait: it must issue a PRIVATE, unconsumed ticket.
   const fourthWait=await chrome.releaseFourthOriginalSelectionToNativeWait();
   assert.equal(fourthWait.started,true);
   assert.equal(fourthWait.ownerPlayerId,sessions[3].playerId);
   assert.equal(fourthWait.actionExecuted,false);
   const fourthWaiting=await until(async()=>{
    const state=await chrome.inspectOriginalSelectionGate();
    if(state.failed)throw Error('FOURTH_ORIGINAL_WAIT_FAILED_'+state.error+
     '_'+String(state.trace??'').slice(0,230));
    return state.fourthOriginalOnlineWaitReached&&state.paused&&state;
   });
   assert.equal(fourthWaiting.fourthSelectionContentReleased,true);
   const fourthWindow=await until(()=>returnedFourth.received.find(m=>
    m.type==='choice_window'&&m.window?.seat===3&&
    m.window?.source==='preview'&&m.window?.options.includes('pass')
   )?.window);
   assert.equal(fourthWindow.playerId,sessions[3].playerId);
   // The genuine fourth phase previously drew the extra physical card.
   // Entering chooseToUse must NOT draw a second card or mutate HP.
   const postFourthWait=await chrome.evaluateSeatExperiment(`(()=>{
    const {game,ui,_status}=window.__v3NativeXingBeiTest.core;
    return {paused:_status.paused===true,
     hands:game.players.map(p=>p.getCards('h').map(c=>c.__v3PhysicalId)),
     deck:Array.from(ui.cardPile?.childNodes??[]).map(c=>c.__v3PhysicalId),
     hp:game.players.map(p=>p.hp??null)};
   })()`);
   assert.equal(postFourthWait.paused,true);
   assert.deepEqual(postFourthWait.hands,fourthSafe.hands);
   assert.deepEqual(postFourthWait.deck,fourthSafe.deck);
   assert.deepEqual(postFourthWait.hp,fourthSafe.hp);
   // The native private view MUST be sourced from live Player.getCards('h'),
   // not from a stale opening-only physicalCardsBySeat cache.
   const refreshedFourth=await chrome.inspectNativePrivateHand({seat:3});
   assert.deepEqual(refreshedFourth.ownHand.map(c=>c.cardId),
    postFourthWait.hands[3]);
   assert.deepEqual(refreshedFourth.publicOtherHandCounts.map(x=>x.handCount),
    postFourthWait.hands.map(x=>x.length));
   assert.deepEqual(fourthWindow.options.slice(0,-1).sort(),
    [...postFourthWait.hands[3]].sort());
   const fourthPreview=await chrome.inspectNativeUseCardPreview();
   assert.equal(fourthPreview.state,'open');
   assert.equal(fourthPreview.samePausedEvent,true);
   assert.equal(fourthPreview.nativeUnwaitInvoked,false);
   for(const peer of [...finalPeers.slice(0,3),staleFourth]){
    assert.equal(peer.received.some(m=>
     m.type==='choice_window'&&m.window?.ticket===fourthWindow.ticket),false);
    assert.equal((await ask(peer,'choice_submit',{
     ticket:fourthWindow.ticket,option:'pass'
    })).code,peer===staleFourth?'NOT_AUTHENTICATED':'CHOICE_WINDOW_NOT_FOUND');
   }
   assert.equal((await ask(returnedFourth,'command',{action:'playCard'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
   await assert.rejects(chrome.releaseFourthOriginalSelectionToNativeWait(),
    /V3_NATIVE_FOURTH_ORIGINAL_USE_RELEASE_DENIED/);
   assert.equal(chrome.pid,fourthPid);
   assert.equal((await ask(finalSecond,'command',{action:'playCard'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
  }
  const after=await chrome.inspectNativePrivateHand({seat:0});
  assert.deepEqual(after.ownHand,before.ownHand);
  assert.equal((await ask(finalSeatZero,'command',{action:'playCard'})).code,
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
