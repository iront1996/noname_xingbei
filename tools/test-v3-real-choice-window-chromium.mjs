import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';

const executable=process.env.V3_CHROMIUM;
const enabled=typeof executable==='string'&&executable.startsWith('/');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let seq=0;
async function connect(url){
 const ws=new WebSocket(url),received=[];
 ws.addEventListener('message',e=>{try{received.push(JSON.parse(e.data))}catch{}});
 await Promise.race([new Promise((ok,fail)=>{
  ws.addEventListener('open',ok,{once:true});
  ws.addEventListener('error',()=>fail(Error('CHOICE_SOCKET_FAILED')),{once:true});
 }),pause(10000).then(()=>{throw Error('CHOICE_SOCKET_TIMEOUT')})]);
 return {ws,received};
}
async function until(testFn,deadlineMs=6000){
 const deadline=Date.now()+deadlineMs;
 while(Date.now()<deadline){
  const value=await testFn();if(value)return value;
  await pause(25);
 }
 throw Error('CHOICE_WAIT_TIMEOUT');
}
async function ask(peer,type,payload={}){
 const requestId='choice_r'+(++seq);
 peer.ws.send(JSON.stringify({type,requestId,...payload}));
 return until(()=>peer.received.find(x=>x.type==='reply'&&x.requestId===requestId));
}
test('true Chromium owns private choice windows across owner and guest network loss',{
 skip:!enabled,timeout:70000
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
   const native=await chrome.loadV3NativeModules({origin:host.origin});
   assert.equal(native.loaded,true);
   return chrome;
  }
 });
 const peers=[];
 try{
  for(let i=0;i<4;i++)peers.push(await connect(broker.address));
  const sessions=[await ask(peers[0],'create',{roomId:'CHOICE_ROOM',config:{mode:'xingBei',seatMode:'2v2'}})];
  for(let i=1;i<4;i++)sessions.push(await ask(peers[i],'join',{roomId:'CHOICE_ROOM'}));
  assert.ok(sessions.every(x=>x.ok));
  const launch=await ask(peers[0],'launch');
  assert.equal(launch.code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  const pid=chrome.pid;
  const ownerChoice=await chrome.openChoiceExperiment({
   seat:0,kind:'control',prompt:'請選擇防禦方式',options:['guard','evade']
  });
  assert.equal(ownerChoice.playerId,sessions[0].playerId);
  assert.equal(ownerChoice.state,'open');
  const ownerDelivery=await until(()=>peers[0].received.find(x=>x.type==='choice_window'));
  assert.equal(ownerDelivery.window.ticket,ownerChoice.ticket);
  for(let i=1;i<4;i++)
   assert.equal(peers[i].received.some(x=>x.type==='choice_window'),false);
  assert.equal((await ask(peers[1],'choice_query')).window,null);
  const bad=await ask(peers[1],'choice_submit',{ticket:ownerChoice.ticket,option:'guard'});
  assert.equal(bad.code,'CHOICE_WINDOW_NOT_FOUND');
  peers[0].ws.close();
  await until(()=>broker.roomView('CHOICE_ROOM').roster[0].connected===false);
  const replacement=await connect(broker.address);peers.push(replacement);
  const reconnect=await ask(replacement,'reconnect',{roomId:'CHOICE_ROOM',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(reconnect.playerId,sessions[0].playerId);
  const replay=await until(()=>replacement.received.find(x=>x.type==='choice_window'));
  assert.equal(replay.window.ticket,ownerChoice.ticket);
  assert.equal((await ask(replacement,'choice_query')).window.ticket,ownerChoice.ticket);
  const badOption=await ask(replacement,'choice_submit',{
   ticket:ownerChoice.ticket,option:'execute_code'
  });
  assert.equal(badOption.code,'CHOICE_OPTION_NOT_ALLOWED');
  const submit=await ask(replacement,'choice_submit',{ticket:ownerChoice.ticket,option:'guard'});
  assert.equal(submit.code,'CHOICE_SUBMITTED_NOT_APPLIED');
  await until(async()=>((await chrome.inspectChoiceExperiment()).receipts.length===1));
  const delivered=await until(async()=>{
   const result=await ask(replacement,'choice_query');
   return result.window?.state==='delivered'&&result;
  });
  assert.equal(delivered.window.state,'delivered');
  assert.equal((await ask(replacement,'choice_submit',{
   ticket:ownerChoice.ticket,option:'guard'
  })).code,'CHOICE_DELIVERED_NOT_APPLIED');
  assert.equal((await ask(replacement,'choice_submit',{
   ticket:ownerChoice.ticket,option:'evade'
  })).code,'CHOICE_ALREADY_LOCKED');
  peers[2].ws.close();
  await until(()=>broker.roomView('CHOICE_ROOM').roster[2].connected===false);
  await until(async()=>(await chrome.inspectRoomChannel()).boundPeerCount===3);
  const guestChoice=await chrome.openChoiceExperiment({
   seat:2,kind:'skill',prompt:'技能回應測試',options:['accept','decline']
  });
  assert.equal(guestChoice.playerId,sessions[2].playerId);
  assert.equal(guestChoice.state,'open');
  assert.equal(peers[1].received.some(x=>x.type==='choice_window'),false);
  const guest=await connect(broker.address);peers.push(guest);
  const resumed=await ask(guest,'reconnect',{roomId:'CHOICE_ROOM',seat:2,
   reconnectToken:sessions[2].reconnectToken});
  assert.equal(resumed.playerId,sessions[2].playerId);
  const guestDelivery=await until(()=>guest.received.find(x=>x.type==='choice_window'));
  assert.equal(guestDelivery.window.ticket,guestChoice.ticket);
  assert.equal((await ask(guest,'choice_submit',{ticket:guestChoice.ticket,option:'decline'})).code,
   'CHOICE_SUBMITTED_NOT_APPLIED');
  await until(async()=>(await chrome.inspectChoiceExperiment()).receipts.length===2);
  assert.equal(chrome.pid,pid);
  assert.equal((await broker.inspectWorker('CHOICE_ROOM')).code,'WORKER_PROOF_ALIVE');
  assert.equal((await ask(guest,'command',{action:'attack'})).code,'RULES_ENGINE_NOT_IMPLEMENTED');
  assert.equal(JSON.stringify(broker.roomView('CHOICE_ROOM')).includes(guestChoice.ticket),false);
  for(const other of [peers[1],peers[3],replacement]){
   assert.equal(JSON.stringify(other.received).includes(guestChoice.ticket),false);
  }
 }finally{
  for(const p of peers)try{p.ws.close()}catch{}
  await broker.close();
  await host.close();
 }
});
