import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';

const executable=process.env.V3_CHROMIUM;
const enabled=typeof executable==='string'&&executable.startsWith('/');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let request=0;
async function until(check,timeout=12000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  const value=await check();if(value)return value;
  await sleep(30);
 }
 throw Error('MATRIX_WAIT_TIMEOUT');
}
async function newClient(uri){
 const ws=new WebSocket(uri),received=[];
 ws.addEventListener('message',e=>{try{received.push(JSON.parse(e.data))}catch{}});
 await Promise.race([
  new Promise((ok,fail)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',fail,{once:true})}),
  sleep(10000).then(()=>{throw Error('MATRIX_WS_TIMEOUT')})
 ]);
 return {ws,received};
}
async function ask(client,type,params={}){
 const requestId='mx'+(++request);
 client.ws.send(JSON.stringify({requestId,type,...params}));
 return until(()=>client.received.find(x=>x.type==='reply'&&x.requestId===requestId));
}
for(const [seatMode,count,guestSeat] of [['3v3',6,4],['4v4',8,6]]){
 test('native host-neutral event survives creator and guest reconnect '+seatMode,{
  skip:!enabled,timeout:75000
 },async()=>{
  const {WebSocketServer}=await import('ws');
  const host=await createV3NativeModuleTestServer({root:resolve(dirname(fileURLToPath(import.meta.url)),'..')});
  let browser;
  const broker=await createV3AuthorityWebSocketBroker({
   WebSocketServer,enableChoiceWindowExperiments:true,
   launchWorker:async()=>{
    browser=await launchV3ChromiumAuthorityWorker({executable});
    assert.equal((await browser.loadV3NativeModules({origin:host.origin})).loaded,true);
    return browser;
   }
  });
  const clients=[];
  try{
   for(let i=0;i<count;i++)clients.push(await newClient(broker.address));
   const roomId='V3_NATIVE_'+seatMode;
   const sessions=[await ask(clients[0],'create',{roomId,config:{mode:'xingBei',seatMode}})];
   for(let i=1;i<count;i++)sessions.push(await ask(clients[i],'join',{roomId}));
   assert.ok(sessions.every(x=>x.ok));
   assert.equal(new Set(sessions.map(x=>x.playerId)).size,count);
   assert.equal((await ask(clients[0],'launch')).code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
   const pid=browser.pid;
   for(const [seat,selection,expected] of [
    [guestSeat,'o0','block'],[0,'o1','charge']
   ]){
    const native=await browser.beginNativeChoiceExperiment({
     seat,controls:['block','charge'],prompt:'請選擇操作'
    });
    assert.equal(native.nativeInstance,true);
    assert.equal(native.nativePlayer,true);
    assert.equal(native.paused,true);
    assert.equal(native.noAITimer,true);
    const window=await until(()=>clients[seat].received.find(x=>
     x.type==='choice_window'&&x.window.source==='native'));
    const ticket=window.window.ticket;
    const stranger=(seat+1)%count;
    assert.equal((await ask(clients[stranger],'choice_submit',{ticket,option:selection})).code,
     'CHOICE_WINDOW_NOT_FOUND');
    clients[seat].ws.close();
    await until(()=>broker.roomView(roomId).roster[seat].connected===false);
    await until(async()=>(await browser.inspectNativeChoiceExperiment({seat})).closed===true);
    const replacement=await newClient(broker.address);clients.push(replacement);
    const reconnected=await ask(replacement,'reconnect',{
     roomId,seat,reconnectToken:sessions[seat].reconnectToken
    });
    assert.equal(reconnected.playerId,sessions[seat].playerId);
    assert.equal((await until(()=>replacement.received.find(x=>x.type==='choice_window'))).window.ticket,ticket);
    await until(async()=>(await browser.inspectNativeChoiceExperiment({seat})).closed===false);
    assert.equal((await ask(replacement,'choice_submit',{ticket,option:selection})).code,
     'CHOICE_SUBMITTED_NOT_APPLIED');
    const state=await until(async()=>{
     const x=await browser.inspectNativeChoiceExperiment({seat});
     return x.nativeResult?.control===expected&&x.nativePaused===false&&x;
    });
    assert.equal(state.nativeResult.control,expected);
    await until(async()=>(await ask(replacement,'choice_query')).window?.state==='applied');
    assert.equal((await ask(replacement,'choice_submit',{ticket,option:selection})).code,
     'CHOICE_ALREADY_APPLIED');
    assert.equal(browser.pid,pid);
    assert.equal((await broker.inspectWorker(roomId)).code,'WORKER_PROOF_ALIVE');
    for(const peer of clients)
     if(peer!==replacement&&peer!==clients[seat])
      assert.equal(JSON.stringify(peer.received).includes(ticket),false);
   }
   assert.equal((await ask(clients[1],'command',{action:'playCard'})).code,
    'RULES_ENGINE_NOT_IMPLEMENTED');
  }finally{
   for(const c of clients)try{c.ws.close()}catch{}
   await broker.close();
   await host.close();
  }
 });
}
