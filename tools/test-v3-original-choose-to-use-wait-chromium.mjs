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

test('original XingBei chooseToUse executes step zero but waits in server Chrome without running card',{
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
  for(let i=0;i<4;i++)peers.push(await connect(broker.address));
  const roomId='V3_ORIGINAL_NATIVE_WAIT';
  const sessions=[await ask(peers[0],'create',{
   roomId,config:{mode:'xingBei',seatMode:'2v2'}
  })];
  for(let i=1;i<4;i++)sessions.push(await ask(peers[i],'join',{roomId}));
  assert.ok(sessions.every(x=>x.ok));
  assert.equal((await ask(peers[0],'launch')).code,
   'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  const stage=await chrome.stageNativeXingBeiSeats();
  assert.equal(stage.ok,true);
  for(let seat=0;seat<4;seat++){
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
  assert.deepEqual(dealt.nativeHandCounts,[4,4,4,4]);
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
   before.ownHand.map(c=>c.cardId).sort());
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
  peers[0].ws.close();
  await until(()=>!broker.roomView(roomId).roster[0].connected);
  const next=await connect(broker.address);peers.push(next);
  const resumed=await ask(next,'reconnect',{
   roomId,seat:0,reconnectToken:sessions[0].reconnectToken
  });
  assert.equal(resumed.playerId,sessions[0].playerId);
  const reopened=await until(()=>next.received.find(x=>
   x.type==='choice_window'&&x.window?.source==='preview'&&
   x.window.ticket===window.ticket
  )?.window);
  assert.deepEqual(reopened.options,window.options);
  assert.equal((await ask(next,'choice_submit',{
   ticket:reopened.ticket,option:reopened.options[0]
  })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  await until(async()=>(await chrome.inspectNativeUseCardPreview()).recorded);
  const after=await chrome.inspectNativePrivateHand({seat:0});
  assert.deepEqual(after.ownHand,before.ownHand);
  assert.equal((await chrome.inspectNativeUseCardPreview()).nativeUnwaitInvoked,false);
  assert.equal((await chrome.inspectOriginalSelectionGate()).paused,true);
  assert.equal((await ask(next,'command',{action:'playCard'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
  assert.equal(chrome.pid,pid);
  // The original step 0 may legitimately initialize dynamic skill state;
  // it has not reached the original useResult, card movement or next step.
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
 }finally{
  for(const p of peers)try{p.ws.close()}catch{}
  await broker.close();
  await host.close();
 }
});
