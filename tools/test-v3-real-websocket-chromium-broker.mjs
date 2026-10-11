import test from 'node:test';
import assert from 'node:assert/strict';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';
import {buildV3NativeAuthorizedSeatProbe} from './v3-native-seat-probe.mjs';

const chrome=process.env.V3_CHROMIUM;
const enabled=typeof chrome==='string'&&chrome.startsWith('/');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let seq=0;
async function open(url){
 const ws=new WebSocket(url),received=[];
 ws.addEventListener('message',e=>{try{received.push(JSON.parse(e.data))}catch{}});
 await Promise.race([
  new Promise((resolve,reject)=>{
   ws.addEventListener('open',resolve,{once:true});
   ws.addEventListener('error',()=>reject(Error('SOCKET_FAILED')),{once:true});
  }),sleep(10000).then(()=>{throw Error('SOCKET_TIMEOUT')})
 ]);
 return {ws,received};
}
async function ask(peer,type,payload={}){
 const requestId='r'+(++seq);
 peer.ws.send(JSON.stringify({type,...payload,requestId}));
 for(let i=0;i<240;i++){
  const result=peer.received.find(r=>r.type==='reply'&&r.requestId===requestId);
  if(result)return result;
  await sleep(50);
 }
 throw Error('RESPONSE_TIMEOUT_'+type);
}
test('four real socket players reconnect across real Chromium room-host lifetime',{skip:!enabled,timeout:60000},async()=>{
 const {WebSocketServer}=await import('ws');
 let browser;
 const broker=await createV3AuthorityWebSocketBroker({
  WebSocketServer,
  launchWorker:async()=>{
   browser=await launchV3ChromiumAuthorityWorker({executable:chrome});
   return browser;
  }
 });
 const peers=[];
 try{
  for(let i=0;i<4;i++)peers.push(await open(broker.address));
  const first=await ask(peers[0],'create',{roomId:'V3_REAL_POC',config:{mode:'xingBei',seatMode:'2v2'}});
  const sessions=[first];
  for(let i=1;i<4;i++)sessions.push(await ask(peers[i],'join',{roomId:'V3_REAL_POC'}));
  assert.ok(sessions.every(s=>s.ok));
  assert.equal(new Set(sessions.map(s=>s.playerId)).size,4);
  const launched=await ask(peers[0],'launch');
  assert.equal(launched.code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  assert.equal(launched.gameRulesLoaded,false);
  const initialHost=await browser.inspectRoomChannel();
  assert.equal(initialHost.connected,true);
  assert.equal(initialHost.seenRoster,true);
  assert.equal(initialHost.seatCount,4);
  assert.equal(initialHost.boundPeerCount,4);
  // Run the actual randomMapOL() source using this room's authenticated
  // stable playerIds, not fabricated ws_0/1/2/3 identifiers.
  const nativeBefore=await browser.evaluateSeatExperiment(buildV3NativeAuthorizedSeatProbe());
  assert.equal(nativeBefore.offboard,true);
  assert.equal(nativeBefore.playerCount,4);
  assert.equal(nativeBefore.nativeReachedChoice,true);
  assert.equal(nativeBefore.socketBindingsPreserved,true);
  assert.deepEqual(nativeBefore.ids,sessions.map(s=>s.playerId).sort());
  const pid=browser.pid;
  peers[0].ws.close();peers[2].ws.close();
  for(let i=0;i<120;i++){
   const roster=broker.roomView('V3_REAL_POC').roster;
   if(!roster[0].connected&&!roster[2].connected)break;
   await sleep(20);
  }
  const a=await open(broker.address);peers.push(a);
  const resumedA=await ask(a,'reconnect',{roomId:'V3_REAL_POC',seat:0,reconnectToken:sessions[0].reconnectToken});
  assert.equal(resumedA.code,'SESSION_RECONNECTED');
  const c=await open(broker.address);peers.push(c);
  const resumedC=await ask(c,'reconnect',{roomId:'V3_REAL_POC',seat:2,reconnectToken:sessions[2].reconnectToken});
  assert.equal(resumedC.code,'SESSION_RECONNECTED');
  assert.equal(resumedA.playerId,sessions[0].playerId);
  assert.equal(resumedC.playerId,sessions[2].playerId);
  assert.notEqual(resumedA.reconnectToken,sessions[0].reconnectToken);
  assert.notEqual(resumedC.reconnectToken,sessions[2].reconnectToken);
  const intruder=await open(broker.address);peers.push(intruder);
  assert.equal((await ask(intruder,'reconnect',{
   roomId:'V3_REAL_POC',seat:0,reconnectToken:sessions[0].reconnectToken
  })).code,'RECONNECT_DENIED');
  assert.equal((await ask(a,'command',{action:'attack'})).code,'RULES_ENGINE_NOT_IMPLEMENTED');
  assert.equal(browser.pid,pid);
  assert.equal((await browser.inspectRoomChannel()).connected,true);
  for(let i=0;i<100;i++){
   const h=await browser.inspectRoomChannel();
   if(h.revision===broker.roomView('V3_REAL_POC').revision)break;
   await sleep(20);
  }
  assert.equal((await browser.inspectRoomChannel()).boundPeerCount,4);
  const nativeAfter=await browser.evaluateSeatExperiment(buildV3NativeAuthorizedSeatProbe());
  assert.equal(nativeAfter.offboard,true);
  assert.equal(nativeAfter.socketBindingsPreserved,true);
  assert.deepEqual(nativeAfter.ids,nativeBefore.ids);
  assert.equal((await broker.inspectWorker('V3_REAL_POC')).code,'WORKER_PROOF_ALIVE');
  assert.equal(broker.roomView('V3_REAL_POC').roster.every(s=>s.connected),true);
  for(const peer of peers){
   const captured=JSON.stringify(peer.received);
   assert.doesNotMatch(captured,/authority_hello|authority_roster|channelSecret/);
   for(const s of sessions){
    if(!peer.received.some(r=>r.reconnectToken===s.reconnectToken))
     assert.ok(!captured.includes(s.reconnectToken));
   }
  }
 }finally{
  for(const peer of peers)try{peer.ws.close()}catch{}
  await broker.close();
 }
});