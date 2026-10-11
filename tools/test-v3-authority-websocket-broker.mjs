import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createV3AuthorityWebSocketBroker} from '../game/v3-authority-websocket-broker.mjs';

class FakeSocket extends EventEmitter {
 readyState=1;outbound=[];
 send(text){if(this.readyState!==1)throw Error('closed');this.outbound.push(JSON.parse(text))}
 clientSend(value){this.emit('message',Buffer.from(JSON.stringify(value)),false)}
 close(){if(this.readyState!==1)return;this.readyState=3;this.emit('close')}
 terminate(){this.close()}
}
class FakeWebSocketServer extends EventEmitter {
 static instance;
 constructor(options){super();assert.equal(options.host,'127.0.0.1');assert.equal(options.port,0);FakeWebSocketServer.instance=this}
 address(){return {address:'127.0.0.1',port:19876}}
 connect(){const ws=new FakeSocket();this.emit('connection',ws);return ws}
 close(cb){cb?.()}
}
let seq=0;
async function waitFor(ws,predicate){
 for(let n=0;n<150;n++){
  const found=ws.outbound.find(predicate);if(found)return found;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw Error('REPLY_TIMEOUT');
}
async function ask(ws,obj){
 const requestId='r'+(++seq);
 ws.clientSend({...obj,requestId});
 return waitFor(ws,r=>r.type==='reply'&&r.requestId===requestId);
}
const config={mode:'xingBei',seatMode:'2v2'};
async function setup({latency=0}={}){
 let started=0,stopped=0,authority;
 const broker=await createV3AuthorityWebSocketBroker({
  WebSocketServer:FakeWebSocketServer,
  launchWorker:async()=>{
   started++;let alive=true;
   return {
    async connectRoomChannel({roomId,secret}){
     if(latency)await new Promise(r=>setTimeout(r,latency));
     authority=FakeWebSocketServer.instance.connect();
     authority.clientSend({type:'authority_hello',roomId,secret});
    },
    async inspect(){if(!alive)throw Error('crashed');return {alive:true,offboard:true,pid:123,gameRulesLoaded:false,statePersisted:false}},
    async stop(){alive=false;stopped++}
   };
  }
 });
 return {broker,connect:()=>FakeWebSocketServer.instance.connect(),get started(){return started},get stopped(){return stopped},get authority(){return authority}};
}
async function fill(runtime){
 const ws=Array.from({length:4},()=>runtime.connect());
 const sessions=[await ask(ws[0],{type:'create',roomId:'TEST',config})];
 for(let i=1;i<4;i++)sessions.push(await ask(ws[i],{type:'join',roomId:'TEST'}));
 assert.ok(sessions.every(s=>s.ok));
 return {ws,sessions};
}
test('owner and guest reconnect with rotated credentials; Chromium host remains independent',async()=>{
 const x=await setup();
 try{
  const {ws,sessions}=await fill(x);
  const ready=await ask(ws[0],{type:'launch'});
  assert.equal(ready.code,'WORKER_PROOF_RUNNING_NOT_PLAYABLE');
  assert.equal(x.started,1);
  await waitFor(x.authority,r=>r.type==='authority_accepted');
  ws[0].close();ws[2].close();
  for(const seat of [0,2]){
   const replacement=x.connect();
   const next=await ask(replacement,{type:'reconnect',roomId:'TEST',seat,reconnectToken:sessions[seat].reconnectToken});
   assert.ok(next.ok);assert.notEqual(next.reconnectToken,sessions[seat].reconnectToken);
   assert.equal((await x.broker.inspectWorker('TEST')).code,'WORKER_PROOF_ALIVE');
   assert.equal((await ask(replacement,{type:'command',action:'attack'})).code,'RULES_ENGINE_NOT_IMPLEMENTED');
  }
  assert.equal(x.started,1);
  assert.equal(x.broker.roomView('TEST').roster.every(s=>s.connected),true);
  assert.ok(!JSON.stringify(x.broker.roomView('TEST')).includes(sessions[0].reconnectToken));
 }finally{await x.broker.close()}
 assert.equal(x.stopped,1);
});
test('live old connection loses authority on same-seat token takeover',async()=>{
 const x=await setup();
 try{
  const old=x.connect(),initial=await ask(old,{type:'create',roomId:'TEST',config});
  const next=x.connect(),resumed=await ask(next,{type:'reconnect',roomId:'TEST',seat:0,reconnectToken:initial.reconnectToken});
  assert.equal(resumed.ok,true);assert.equal(old.readyState,3);
  assert.equal(x.broker.roomView('TEST').roster[0].connected,true);
  assert.equal((await ask(next,{type:'status'})).code,'ROOM_STATUS');
  const intruder=x.connect();
  assert.equal((await ask(intruder,{type:'reconnect',roomId:'TEST',seat:0,reconnectToken:initial.reconnectToken})).code,'RECONNECT_DENIED');
 }finally{await x.broker.close()}
});
test('untrusted peer cannot take worker identity or start private browser',async()=>{
 const x=await setup();
 try{
  const creator=x.connect(),first=await ask(creator,{type:'create',roomId:'TEST',config});
  const spy=x.connect();
  assert.equal((await ask(spy,{type:'launch'})).code,'NOT_AUTHENTICATED');
  assert.equal((await ask(spy,{type:'authority_hello',roomId:'TEST',secret:'f'.repeat(64)})).code,'WORKER_AUTH_DENIED');
  assert.equal(spy.readyState,3);
  assert.ok(!JSON.stringify(x.broker.roomView('TEST')).includes(first.reconnectToken));
  assert.equal(x.started,0);
 }finally{await x.broker.close()}
});
test('guest launch prohibited; partial roster cannot start authority',async()=>{
 const x=await setup();
 try{
  const a=x.connect(),b=x.connect();
  await ask(a,{type:'create',roomId:'TEST',config});
  await ask(b,{type:'join',roomId:'TEST'});
  assert.equal((await ask(b,{type:'launch'})).code,'SETUP_PRIVILEGE_REQUIRED');
  assert.equal((await ask(a,{type:'launch'})).code,'INCOMPLETE_ROSTER');
  assert.equal(x.started,0);
 }finally{await x.broker.close()}
});
test('disconnect during slow Chromium startup rejects and stops launched worker',async()=>{
 const x=await setup({latency:40});
 try{
  const {ws}=await fill(x);
  const pending=ask(ws[0],{type:'launch'});
  await new Promise(r=>setTimeout(r,8));
  ws[3].close();
  assert.equal((await pending).code,'WORKER_START_ABORTED_ROOM_CHANGED');
  assert.equal(x.stopped,1);
  assert.equal(x.broker.roomView('TEST').status,'waiting');
 }finally{await x.broker.close()}
});
test('separate broker can only listen on loopback random port',async()=>{
 for(const args of [{host:'0.0.0.0'},{port:8081},{port:8080}])
  await assert.rejects(createV3AuthorityWebSocketBroker({WebSocketServer:FakeWebSocketServer,launchWorker:async()=>{},...args}),/EXPERIMENT_LOOPBACK_EPHEMERAL_ONLY/);
});
