import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';

const chromePath=process.env.V3_CHROMIUM;
const enabled=typeof chromePath==='string'&&chromePath.startsWith('/');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let request=0;
async function wait(check,ms=10000){
 const end=Date.now()+ms;
 while(Date.now()<end){
  const value=await check();if(value)return value;
  await sleep(30);
 }
 throw Error('NATIVE_WAIT_TIMEOUT');
}
async function peer(url){
 const ws=new WebSocket(url),inbox=[];
 ws.addEventListener('message',e=>{try{inbox.push(JSON.parse(e.data))}catch{}});
 await Promise.race([
  new Promise((ok,bad)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',bad,{once:true})}),
  sleep(10000).then(()=>{throw Error('SOCKET_TIMEOUT')})
 ]);
 return {ws,inbox};
}
async function ask(p,type,body={}){
 const requestId='native_r'+(++request);
 p.ws.send(JSON.stringify({type,...body,requestId}));
 return wait(()=>p.inbox.find(x=>x.type==='reply'&&x.requestId===requestId));
}
test('real GameEvent.send and Player.unwait continue safely after real owner and guest disconnect', {
 skip:!enabled,timeout:75000
},async()=>{
 const {WebSocketServer}=await import('ws');
 const host=await createV3NativeModuleTestServer({root:resolve(dirname(fileURLToPath(import.meta.url)),'..')});
 let browser;
 const broker=await createV3AuthorityWebSocketBroker({
  WebSocketServer,enableChoiceWindowExperiments:true,
  launchWorker:async()=>{
   browser=await launchV3ChromiumAuthorityWorker({executable:chromePath});
   const proof=await browser.loadV3NativeModules({origin:host.origin});
   assert.equal(proof.loaded,true);
   return browser;
  }
 });
 const clients=[];
 try{
  for(let i=0;i<4;i++)clients.push(await peer(broker.address));
  const sessions=[await ask(clients[0],'create',{roomId:'NATIVE_EVT_ROOM',config:{mode:'xingBei',seatMode:'2v2'}})];
  for(let i=1;i<4;i++)sessions.push(await ask(clients[i],'join',{roomId:'NATIVE_EVT_ROOM'}));
  assert.ok(sessions.every(x=>x.ok));
  const launch=await ask(clients[0],'launch');
  assert.equal(launch.code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  const pid=browser.pid;
  const native=await browser.beginNativeChoiceExperiment({seat:0,controls:['guard','evade']});
  assert.equal(native.ok,true);
  assert.equal(native.nativeInstance,true);
  assert.equal(native.nativePlayer,true);
  assert.equal(native.paused,true);
  assert.equal(native.noAITimer,true);
  assert.equal(native.pending,1);
  assert.equal(native.waitSlot,'_noname_waiting');
  assert.equal(native.playerId,sessions[0].playerId);
  const first=await wait(()=>clients[0].inbox.find(x=>x.type==='choice_window'&&x.window.source==='native'));
  assert.equal(first.window.state,'open');
  assert.deepEqual(first.window.options,['o0','o1']);
  // Legacy AI / client-side direct unwait are not trusted in V3.
  const guard=await browser.evaluateSeatExperiment(`(()=>{
   const session=window.__v3NativeEventTestSessions.get(0);
   const {core}=window.__v3NativeXingBeiTest;
   let denied=false,unsupported=false;
   try{session.player.unwait('ai')}catch(e){denied=e.code==='V3_NATIVE_UNWAIT_DENIED'}
   const bad=new core.lib.element.GameEvent('chooseToUse',false);
   bad.player=session.player;
   try{bad.send()}catch(e){unsupported=e.code==='V3_NATIVE_EVENT_UNSUPPORTED'}
   return {denied,unsupported,pending:core.game.__v3NativeWaitAdapter.inspect().pending,
    paused:core._status.paused,unresolved:session.event.result===undefined};
  })()`);
  assert.equal(guard.denied,true);
  assert.equal(guard.unsupported,true);
  assert.equal(guard.pending,1);
  assert.equal(guard.paused,true);
  assert.equal(guard.unresolved,true);
  await browser.simulateNativeClientClose({seat:0});
  const before=await browser.inspectNativeChoiceExperiment({seat:0});
  assert.equal(before.closed,true);
  assert.equal(before.waiting,'_noname_waiting');
  assert.equal(before.nativePaused,true);
  assert.equal(before.nativeResult,null);
  clients[0].ws.close();
  await wait(()=>broker.roomView('NATIVE_EVT_ROOM').roster[0].connected===false);
  await wait(async()=>(await browser.inspectNativeChoiceExperiment({seat:0})).closed===true);
  const reattached=await peer(broker.address);clients.push(reattached);
  const newSession=await ask(reattached,'reconnect',{roomId:'NATIVE_EVT_ROOM',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(newSession.playerId,sessions[0].playerId);
  assert.notEqual(newSession.reconnectToken,sessions[0].reconnectToken);
  await wait(async()=>(await browser.inspectNativeChoiceExperiment({seat:0})).closed===false);
  assert.equal((await wait(()=>reattached.inbox.find(x=>x.type==='choice_window'))).window.ticket,first.window.ticket);
  assert.equal((await ask(clients[1],'choice_submit',{
   ticket:first.window.ticket,option:'o0'
  })).code,'CHOICE_WINDOW_NOT_FOUND');
  assert.equal((await ask(reattached,'choice_submit',{
   ticket:first.window.ticket,option:'arbitrary'
  })).code,'CHOICE_OPTION_NOT_ALLOWED');
  assert.equal((await ask(reattached,'choice_submit',{
   ticket:first.window.ticket,option:'o0'
  })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  const applied=await wait(async()=>{
   const state=await browser.inspectNativeChoiceExperiment({seat:0});
   return state.nativeResult?.control==='guard'&&state;
  });
  assert.equal(applied.nativeResult.index,0);
  assert.equal(applied.nativePaused,false);
  assert.equal(applied.adapter.consumed,1);
  assert.equal(applied.adapter.pending,0);
  await wait(async()=>(await ask(reattached,'choice_query')).window?.state==='applied');
  assert.equal((await ask(reattached,'choice_submit',{
   ticket:first.window.ticket,option:'o0'
  })).code,'CHOICE_ALREADY_APPLIED');
  assert.equal((await ask(reattached,'choice_submit',{
   ticket:first.window.ticket,option:'o1'
  })).code,'CHOICE_ALREADY_LOCKED');
  // Consecutive events on the same seat must start with a NEW ticket.
  const follow=await browser.beginNativeChoiceExperiment({seat:0,controls:['stay','leave']});
  assert.equal(follow.ok,true);
  const followWindow=await wait(()=>reattached.inbox.find(x=>
   x.type==='choice_window'&&x.window.source==='native'&&x.window.ticket!==first.window.ticket));
  assert.notEqual(followWindow.window.ticket,first.window.ticket);
  assert.equal((await ask(reattached,'choice_submit',{
   ticket:first.window.ticket,option:'o0'
  })).code,'CHOICE_WINDOW_NOT_FOUND');
  assert.equal((await ask(reattached,'choice_submit',{
   ticket:followWindow.window.ticket,option:'o1'
  })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  await wait(async()=>{
   const state=await browser.inspectNativeChoiceExperiment({seat:0});
   return state.nativeResult?.control==='leave'&&state.nativePaused===false&&state;
  });
  // Third live native GameEvent: guest can disconnect while awaiting it.
  const second=await browser.beginNativeChoiceExperiment({seat:2,controls:['accept','decline']});
  assert.equal(second.playerId,sessions[2].playerId);
  const guestWindow=await wait(()=>clients[2].inbox.find(x=>x.type==='choice_window'&&x.window.source==='native'));
  clients[2].ws.close();
  await wait(()=>broker.roomView('NATIVE_EVT_ROOM').roster[2].connected===false);
  // A genuine private authority roster update closes the native Client
  // without original Client.close() invoking unwait('ai').
  await wait(async()=>(await browser.inspectNativeChoiceExperiment({seat:2})).closed===true);
  const guest=await peer(broker.address);clients.push(guest);
  assert.equal((await ask(guest,'reconnect',{roomId:'NATIVE_EVT_ROOM',seat:2,
   reconnectToken:sessions[2].reconnectToken})).playerId,sessions[2].playerId);
  await wait(async()=>(await browser.inspectNativeChoiceExperiment({seat:2})).closed===false);
  assert.equal((await wait(()=>guest.inbox.find(x=>x.type==='choice_window'))).window.ticket,guestWindow.window.ticket);
  assert.equal((await ask(guest,'choice_submit',{
   ticket:guestWindow.window.ticket,option:'o1'
  })).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  const finished=await wait(async()=>{
   const result=await browser.inspectNativeChoiceExperiment({seat:2});
   return result.nativeResult?.control==='decline'&&result;
  });
  assert.equal(finished.nativePaused,false);
  assert.equal(finished.adapter.consumed,3);
  assert.equal(browser.pid,pid);
  assert.equal((await broker.inspectWorker('NATIVE_EVT_ROOM')).code,'WORKER_PROOF_ALIVE');
  assert.equal((await ask(guest,'command',{action:'attack'})).code,'RULES_ENGINE_NOT_IMPLEMENTED');
  for(const p of [clients[1],clients[3],reattached])
   assert.equal(JSON.stringify(p.inbox).includes(guestWindow.window.ticket),false);
 }finally{
  for(const p of clients)try{p.ws.close()}catch{}
  await broker.close();
  await host.close();
 }
});
