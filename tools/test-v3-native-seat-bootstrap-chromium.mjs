import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV3NativeOpeningCheckpointStore,verifyV3NativeOpeningCheckpoint}
 from '../game/v3-native-opening-checkpoint.mjs';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';
const executable=process.env.V3_CHROMIUM;
const enabled=typeof executable==='string'&&executable.startsWith('/');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let seq=0;
async function until(check){
 for(let i=0;i<220;i++){
  const result=await check();if(result)return result;
  await sleep(30);
 }
 throw Error('NATIVE_SEAT_REAL_WS_TIMEOUT');
}
async function connect(url){
 const ws=new WebSocket(url),received=[];
 ws.addEventListener('message',e=>{try{received.push(JSON.parse(e.data))}catch{}});
 await Promise.race([
  new Promise((ok,bad)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',bad,{once:true})}),
  sleep(10000).then(()=>{throw Error('NATIVE_SEAT_OPEN_TIMEOUT')})
 ]);
 return {ws,received};
}
async function ask(p,type,extra={}){
 const requestId='seats_'+(++seq);
 p.ws.send(JSON.stringify({type,requestId,...extra}));
 return until(()=>p.received.find(x=>x.type==='reply'&&x.requestId===requestId));
}
for(const [mode,count] of [['2v2',4],['3v3',6],['4v4',8]]){
 test('real native Player/Client seat roster persists when original owner disconnects '+mode,{
  skip:!enabled,timeout:75000
 },async()=>{
  const {WebSocketServer}=await import('ws');
  const host=await createV3NativeModuleTestServer({
   root:resolve(dirname(fileURLToPath(import.meta.url)),'..')
  });
  let chrome;
  const broker=await createV3AuthorityWebSocketBroker({
   WebSocketServer,enableChoiceWindowExperiments:true,
   enablePrivateHandExperiments:true,
   launchWorker:async()=>{
    chrome=await launchV3ChromiumAuthorityWorker({executable});
    assert.equal((await chrome.loadV3NativeModules({origin:host.origin})).loaded,true);
    return chrome;
   }
  });
  const peers=[];
  try{
   for(let i=0;i<count;i++)peers.push(await connect(broker.address));
   const roomId='NATIVE_SEATS_'+mode;
   const sessions=[await ask(peers[0],'create',{roomId,config:{mode:'xingBei',seatMode:mode}})];
   for(let i=1;i<count;i++)sessions.push(await ask(peers[i],'join',{roomId}));
   assert.ok(sessions.every(s=>s.ok));
   assert.equal((await ask(peers[0],'launch')).code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
   const original=await chrome.stageNativeXingBeiSeats();
   assert.equal(original.ok,true);
   assert.equal(original.pack.realSource,true);
   assert.equal(original.session.seatCount,count);
   assert.ok(original.characters.length>=count*2);
   assert.equal(original.session.offboard,true);
   assert.equal(original.session.actualNativePlayers,true);
   assert.equal(original.session.gameLoopStarted,false);
   assert.equal(original.session.pendingNativeChoices,0);
   assert.deepEqual(original.roster.map(p=>p.playerId),sessions.map(p=>p.playerId));
   assert.ok(original.roster.every(p=>p.connected&&p.nativePlayer&&p.nativeClient));
   assert.equal(original.roster.filter(p=>p.side==='hong').length,count/2);
   assert.equal(original.roster.filter(p=>p.side==='lan').length,count/2);
   const pid=chrome.pid;
   const currentBySeat=peers.slice(0,count);
   const reconnectCredentials=sessions.map(x=>x.reconnectToken);
   const guestSeat=count-2;
   peers[0].ws.close();peers[guestSeat].ws.close();
   await until(()=>!broker.roomView(roomId).roster[0].connected&&
    !broker.roomView(roomId).roster[guestSeat].connected);
   const offline=await until(async()=>{
    const current=await chrome.inspectNativeXingBeiSeats();
    return !current.roster[0].connected&&!current.roster[guestSeat].connected&&current;
   });
   assert.deepEqual(offline.roster.map(x=>x.playerId),original.roster.map(x=>x.playerId));
   assert.equal(offline.session.seatCount,count);
   for(const seat of [0,guestSeat]){
    const replacement=await connect(broker.address);
    peers.push(replacement);currentBySeat[seat]=replacement;
    const reconnected=await ask(replacement,'reconnect',{
     roomId,seat,reconnectToken:sessions[seat].reconnectToken
    });
    assert.equal(reconnected.playerId,sessions[seat].playerId);
    assert.notEqual(reconnected.reconnectToken,sessions[seat].reconnectToken);
    reconnectCredentials[seat]=reconnected.reconnectToken;
   }
   await until(async()=>{
    const current=await chrome.inspectNativeXingBeiSeats();
    return current.roster.every(x=>x.connected)&&current;
   });
   const after=await chrome.inspectNativeXingBeiSeats();
   assert.deepEqual(after.roster.map(x=>x.playerId),original.roster.map(x=>x.playerId));
   assert.equal(after.session.offboard,true);
   assert.equal(after.session.seatCount,count);
   assert.equal(chrome.pid,pid);
   assert.equal((await broker.inspectWorker(roomId)).code,'WORKER_PROOF_ALIVE');
   // First genuine native character draft on the actual authenticated
   // Player instances. No prototype-only mock Player is used here.
   for(let seat=0;seat<count;seat++){
    const offers=original.characters.slice(seat*2,seat*2+2);
    const started=await chrome.beginNativeCharacterDraft({seat,offers});
    assert.equal(started.nativeEvent,true);
    assert.equal(started.playerId,sessions[seat].playerId);
    const message=await until(()=>currentBySeat[seat].received.find(x=>
     x.type==='choice_window'&&x.window.source==='native'&&
     x.window.playerId===sessions[seat].playerId
    ));
    assert.deepEqual(message.window.options,['o0','o1']);
    assert.equal((await ask(currentBySeat[seat],'choice_submit',{
     ticket:message.window.ticket,option:'o0'
    })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
    const committed=await until(async()=>{
     const result=await chrome.commitNativeCharacterDraft({seat});
     return result.ok&&result;
    });
    assert.equal(committed.character,offers[0]);
    assert.equal(committed.actualNativePlayer,true);
    assert.ok(committed.nativeSkillCount>0);
    await until(async()=>(await ask(currentBySeat[seat],'choice_query')).window?.state==='applied');
   }
   const drafted=await chrome.inspectNativeXingBeiSeats();
   assert.equal(drafted.session.characterCount,count);
   assert.equal(drafted.session.draftPending,0);
   assert.equal(drafted.session.fullRulesStarted,undefined);
   assert.equal(drafted.session.gameLoopStarted,false);
   assert.ok(drafted.roster.every(p=>p.character!==null));
   assert.equal(new Set(drafted.roster.map(p=>p.character)).size,count);
   // Original native Card instances must physically inhabit the right
   // native Player hand zone, never the host virtual Player or other seats.
   // All roster sizes use ORIGINAL native gameDraw Event.start() to
   // construct the genuine four-card opening hands (not manual directgain).
   const originalOpening=true;
   const dealt=await chrome.dealNativeOpeningCardsByOriginalEvent();
   assert.equal(dealt.nativeCards,true);
   assert.equal(dealt.physicalCardsUnique,true);
   assert.equal(dealt.totalDealt,count*4);
   assert.deepEqual(dealt.handCounts,Array(count).fill(4));
   assert.deepEqual(dealt.nativeHandCounts,Array(count).fill(4));
   assert.equal(dealt.privateDetailsIncluded,false);
   assert.equal(dealt.nativeGameDrawTriggered,originalOpening);
   if(originalOpening)assert.equal(dealt.realNativeGameEventCompleted,true);
   // Real native cards and untouched remaining draw pile -> encrypted disk.
   // This test proves save/reload of opening data, NOT restoration of an
   // executing GameEvent, RNG state, battle, or a crashed Chromium.
   const snapshot=await chrome.exportNativeOpeningCheckpoint({roomId,revision:1});
   const verified=verifyV3NativeOpeningCheckpoint(snapshot);
   assert.equal(verified.ok,true);
   assert.equal(verified.restorable,false);
   assert.equal(snapshot.seatMode,mode);
   assert.deepEqual(snapshot.players.map(p=>p.playerId),sessions.map(p=>p.playerId));
   assert.deepEqual(snapshot.players.map(p=>p.hand.length),Array(count).fill(4));
   assert.equal(snapshot.remainingCardIds.length,snapshot.totalCards-4*count);
   const allCardIds=[
    ...snapshot.players.flatMap(p=>p.hand.map(c=>c.cardId)),
    ...snapshot.remainingCardIds
   ];
   assert.equal(new Set(allCardIds).size,snapshot.totalCards);
   const checkpointDir=await mkdtemp(join(tmpdir(),'v3-auth-real-opening-'));
   const key=randomBytes(32);
   try{
    const store=createV3NativeOpeningCheckpointStore({directory:checkpointDir,key});
    assert.equal((await store.save(snapshot)).code,'OPENING_CHECKPOINT_ENCRYPTED');
    const disk=await readFile(join(checkpointDir,roomId+'.v3opening'),'utf8');
    for(const p of snapshot.players){
     assert.equal(disk.includes(p.playerId),false);
     assert.equal(disk.includes(p.character),false);
     for(const card of p.hand)assert.equal(disk.includes(card.cardId),false);
    }
    const coldStore=createV3NativeOpeningCheckpointStore({directory:checkpointDir,key});
    const cold=await coldStore.load(roomId);
    assert.equal(cold.restorable,false);
    assert.deepEqual(cold.value,snapshot);
   }finally{await rm(checkpointDir,{recursive:true,force:true})}
   const seatViews=[];
   for(let seat=0;seat<count;seat++){
    const own=await chrome.inspectNativePrivateHand({seat});
    assert.equal(own.playerId,sessions[seat].playerId);
    assert.equal(own.ownHand.length,4);
    assert.deepEqual(own.publicOtherHandCounts.map(x=>x.handCount),Array(count).fill(4));
    assert.ok(own.ownHand.every(c=>c.cardId&&c.name));
    seatViews.push(own);
   }
   const cards=seatViews.flatMap(x=>x.ownHand.map(c=>c.cardId));
   assert.equal(new Set(cards).size,count*4);
   for(let seat=0;seat<count;seat++){
    const foreign=new Set(cards.filter(id=>!seatViews[seat].ownHand.some(c=>c.cardId===id)));
    const projection=JSON.stringify(seatViews[seat]);
    for(const id of foreign)assert.equal(projection.includes(id),false);
   }
   const publication=await chrome.publishNativeOpeningHands();
   assert.equal(publication.count,count);
   assert.deepEqual(publication.seats,Array.from({length:count},(_,i)=>i));
   for(let seat=0;seat<count;seat++){
    const own=seatViews[seat];
    const player=currentBySeat[seat];
    const message=await until(()=>player.received.find(x=>x.type==='private_hand'));
    assert.equal(message.view.roomId,roomId);
    assert.equal(message.view.playerId,sessions[seat].playerId);
    assert.equal(message.view.revision,1);
    assert.deepEqual(message.view.ownHand,own.ownHand);
    assert.deepEqual(message.view.publicOtherHandCounts,own.publicOtherHandCounts);
    const query=await ask(player,'private_hand_query');
    assert.equal(query.code,'PRIVATE_HAND_STATE');
    assert.deepEqual(query.view.ownHand,own.ownHand);
    const personal=new Set(own.ownHand.map(x=>x.cardId));
    for(let other=0;other<count;other++){
     if(other===seat)continue;
     for(const foreign of seatViews[other].ownHand)
      assert.equal(JSON.stringify(message.view).includes(foreign.cardId),false);
    }
    assert.equal(personal.size,4);
    assert.equal(JSON.stringify(broker.roomView(roomId)).includes(own.ownHand[0].cardId),false);
   }
   // Re-authentication after the cards are dealt must restore only the
   // reconnecting user's original private hand and not another seat's cards.
   for(const seat of [0,guestSeat]){
    currentBySeat[seat].ws.close();
    await until(()=>broker.roomView(roomId).roster[seat].connected===false);
    const replacement=await connect(broker.address);
    peers.push(replacement);
    const token=(await ask(replacement,'reconnect',{
     roomId,seat,
     reconnectToken:reconnectCredentials[seat]
    }));
    assert.equal(token.playerId,sessions[seat].playerId);
    reconnectCredentials[seat]=token.reconnectToken;
    currentBySeat[seat]=replacement;
    const replay=await until(()=>replacement.received.find(x=>x.type==='private_hand'));
    assert.deepEqual(replay.view.ownHand,seatViews[seat].ownHand);
    for(let other=0;other<count;other++){
     if(other===seat)continue;
     for(const foreign of seatViews[other].ownHand)
      assert.equal(JSON.stringify(replay.view).includes(foreign.cardId),false);
    }
   }
   // gameDraw has ALREADY executed to deal the four opening cards.
   // Queue ONLY original phaseLoop, so next start cannot deal twice.
   const turn=await chrome.stageNativeOpeningTurnBoundary({firstSeat:0});
   assert.equal(turn.realNativeEvents,true);
   assert.equal(turn.firstSeat,0);
   assert.equal(turn.playerId,sessions[0].playerId);
   assert.equal(turn.drawEvent,'gameDraw');
   assert.equal(turn.phaseEvent,'phaseLoop');
   assert.equal(turn.drawCount,4);
   assert.equal(turn.standardPhaseLoop,true);
   assert.equal(turn.openingDrawAlreadyExecuted,true);
   assert.deepEqual(turn.eventsQueued,['phaseLoop']);
   assert.equal(turn.eventLoopStarted,false);
   assert.equal(turn.turnResolved,false);
   await assert.rejects(chrome.stageNativeOpeningTurnBoundary({firstSeat:0}),
    /V3_TURN_BOUNDARY_FAILED_V3_NATIVE_TURN_BOUNDARY_NOT_READY/);
   const firstPhase=await chrome.probeNativeFirstPhaseSetup();
   assert.equal(firstPhase.realNativeSeatNumbers,true);
   assert.equal(firstPhase.realNativeMorale,true);
   assert.equal(firstPhase.nativeScoreboard,true);
   assert.equal(firstPhase.redMorale,firstPhase.maxMorale);
   assert.equal(firstPhase.blueMorale,firstPhase.maxMorale);
   assert.deepEqual(firstPhase.seatNumbers,Array.from({length:count},(_,i)=>i+1));
   assert.equal(firstPhase.eventLoopStarted,false);
   assert.equal(firstPhase.skillsStarted,false);
   await assert.rejects(chrome.probeNativeFirstPhaseSetup(),
    /V3_FIRST_PHASE_SETUP_FAILED_V3_FIRST_PHASE_SETUP_NOT_READY/);
   const afterDraw=await chrome.inspectNativeXingBeiSeats();
   assert.equal(afterDraw.session.startingCardsDealt,true);
   assert.deepEqual(afterDraw.roster.map(x=>x.handCount),Array(count).fill(4));
   assert.equal((await ask(currentBySeat[0],'command',{action:'draw'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
   assert.equal(chrome.pid,pid);
   const spy=await connect(broker.address);peers.push(spy);
   assert.equal((await ask(spy,'reconnect',{
    roomId,seat:0,reconnectToken:sessions[0].reconnectToken
   })).code,'RECONNECT_DENIED');
   assert.equal((await ask(peers[1],'command',{action:'skill'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
   // Run one *original* gameDraw event only after all private-hand
   // projections/restore contracts have been checked. This is a destructive
   // staging probe and cannot be published as a valid play session.
   if(!originalOpening){
    const executed=await chrome.probeNativeOriginalGameDraw();
    assert.equal(executed.realNativeGameDrawExecuted,true);
    assert.equal(executed.eventName,'gameDraw');
    assert.equal(executed.gainedExactlyFour,true);
    assert.deepEqual(executed.before,Array(count).fill(4));
    assert.deepEqual(executed.after,Array(count).fill(8));
    assert.equal(executed.nativePhaseLoopExecuted,false);
    assert.equal(executed.turnResolved,false);
   }
  }finally{
   for(const p of peers)try{p.ws.close()}catch{}
   await broker.close();
   await host.close();
  }
 });
}
