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
   assert.equal(original.session.offboard,true);
   assert.equal(original.session.actualNativePlayers,true);
   assert.equal(original.session.gameLoopStarted,false);
   assert.equal(original.session.pendingNativeChoices,0);
   assert.deepEqual(original.roster.map(p=>p.playerId),sessions.map(p=>p.playerId));
   assert.ok(original.roster.every(p=>p.connected&&p.nativePlayer&&p.nativeClient));
   assert.equal(original.roster.filter(p=>p.side==='hong').length,count/2);
   assert.equal(original.roster.filter(p=>p.side==='lan').length,count/2);
   const pid=chrome.pid;
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
    peers.push(replacement);
    const reconnected=await ask(replacement,'reconnect',{
     roomId,seat,reconnectToken:sessions[seat].reconnectToken
    });
    assert.equal(reconnected.playerId,sessions[seat].playerId);
    assert.notEqual(reconnected.reconnectToken,sessions[seat].reconnectToken);
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
   const spy=await connect(broker.address);peers.push(spy);
   assert.equal((await ask(spy,'reconnect',{
    roomId,seat:0,reconnectToken:sessions[0].reconnectToken
   })).code,'RECONNECT_DENIED');
   assert.equal((await ask(peers[1],'command',{action:'skill'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
  }finally{
   for(const p of peers)try{p.ws.close()}catch{}
   await broker.close();
   await host.close();
  }
 });
}
