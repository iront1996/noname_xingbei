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
async function setup({latency=0,choiceExperiment=false,ownershipExperiment=false,privateHandExperiment=false,workerHealthIntervalMs=3000}={}){
 let started=0,stopped=0,authority,crashWorker,nextInspectGate;
 const broker=await createV3AuthorityWebSocketBroker({
  WebSocketServer:FakeWebSocketServer,
  enableChoiceWindowExperiments:choiceExperiment,
  enablePrivateHandExperiments:privateHandExperiment,
  enableNativeOwnershipProbes:ownershipExperiment,
  workerHealthIntervalMs,
  launchWorker:async()=>{
   started++;let alive=true;
   crashWorker=()=>{alive=false};
   return {
    async connectRoomChannel({roomId,secret}){
     if(latency)await new Promise(r=>setTimeout(r,latency));
     authority=FakeWebSocketServer.instance.connect();
     const originalSend=authority.send.bind(authority);
     authority.send=text=>{
      originalSend(text);
      const msg=JSON.parse(text);
      if(msg.type==='authority_choice_delivery')authority.clientSend({
       type:'authority_choice_receipt',roomId:msg.roomId,seat:msg.seat,
       playerId:msg.playerId,ticket:msg.ticket,option:msg.option
      });
      if(msg.type==='authority_transport_probe')authority.clientSend({
       type:'authority_probe_ack',roomId:msg.roomId,seat:msg.seat,
       playerId:msg.playerId,traceId:msg.traceId
      });
     };
     authority.clientSend({type:'authority_hello',roomId,secret});
    },
    async inspect(){
     const gate=nextInspectGate;
     if(gate){nextInspectGate=null;gate.enter();await gate.wait}
     if(!alive)throw Error('crashed');
     return {alive:true,offboard:true,pid:123,gameRulesLoaded:false,statePersisted:false}
    },
    async stop(){alive=false;stopped++}
   };
  }
 });
 return {
  broker,connect:()=>FakeWebSocketServer.instance.connect(),
  crashWorker:()=>crashWorker?.(),
  pauseNextInspect(){
   if(nextInspectGate)throw Error('INSPECT_ALREADY_PAUSED');
   let enter,release;
   const entered=new Promise(r=>{enter=r});
   const wait=new Promise(r=>{release=r});
   nextInspectGate={enter,wait};
   return {entered,release};
  },
  get started(){return started},get stopped(){return stopped},get authority(){return authority}
 };
}
async function fill(runtime){
 const ws=Array.from({length:4},()=>runtime.connect());
 const sessions=[await ask(ws[0],{type:'create',roomId:'TEST',config})];
 for(let i=1;i<4;i++)sessions.push(await ask(ws[i],{type:'join',roomId:'TEST'}));
 assert.ok(sessions.every(s=>s.ok));
 assert.equal(new Set(sessions.map(s=>s.playerId)).size,4);
 assert.ok(sessions.every(s=>/^player_[a-f0-9]{32}$/.test(s.playerId)));
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
  const firstHop=await ask(ws[0],{type:'transport_probe'});
  assert.equal(firstHop.code,'TRANSPORT_PROBE_ROUNDTRIP');
  assert.equal(firstHop.playerId,sessions[0].playerId);
  ws[0].close();ws[2].close();
  for(const seat of [0,2]){
   const replacement=x.connect();
   const next=await ask(replacement,{type:'reconnect',roomId:'TEST',seat,reconnectToken:sessions[seat].reconnectToken});
   assert.ok(next.ok);assert.notEqual(next.reconnectToken,sessions[seat].reconnectToken);
   assert.equal(next.playerId,sessions[seat].playerId);
   const hop=await ask(replacement,{type:'transport_probe'});
   assert.equal(hop.code,'TRANSPORT_PROBE_ROUNDTRIP');
   assert.equal(hop.playerId,sessions[seat].playerId);
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
  assert.equal((await ask(creator,{type:'transport_probe'})).code,'WORKER_CHANNEL_OFFLINE');
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

test('private choice pending state persists for creator and guest despite socket replacement',async()=>{
 const x=await setup({choiceExperiment:true});
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const issue=(seat,options)=>{
   x.authority.clientSend({type:'authority_choice_open',roomId:'TEST',seat,
    playerId:sessions[seat].playerId,kind:'control',prompt:'請選擇測試回應',options});
  };
  issue(0,['yes','no']);
  const opened=await waitFor(x.authority,m=>m.type==='authority_choice_open_result');
  assert.equal(opened.ok,true);
  const ticket=opened.view.ticket;
  const privateOwner=await waitFor(ws[0],m=>m.type==='choice_window');
  assert.equal(privateOwner.window.ticket,ticket);
  for(let i=1;i<4;i++)assert.equal(ws[i].outbound.some(m=>m.type==='choice_window'),false);
  assert.equal((await ask(ws[1],{type:'choice_submit',ticket,option:'yes'})).code,'CHOICE_WINDOW_NOT_FOUND');
  assert.equal((await ask(ws[0],{type:'choice_submit',ticket,option:'evil'})).code,'CHOICE_OPTION_NOT_ALLOWED');
  ws[0].close();
  const replacement=x.connect();
  const reconnected=await ask(replacement,{type:'reconnect',roomId:'TEST',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(reconnected.playerId,sessions[0].playerId);
  assert.equal((await waitFor(replacement,m=>m.type==='choice_window')).window.ticket,ticket);
  assert.equal((await ask(replacement,{type:'choice_submit',ticket,option:'yes'})).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  const delivered=await waitFor(replacement,m=>m.type==='choice_window'&&m.window.state==='delivered');
  assert.equal(delivered.window.state,'delivered');
  assert.equal((await ask(replacement,{type:'choice_submit',ticket,option:'no'})).code,'CHOICE_ALREADY_LOCKED');
  ws[2].close();
  issue(2,['accept','decline']);
  const second=await waitFor(x.authority,m=>m.type==='authority_choice_open_result'&&m.view?.seat===2);
  assert.equal(second.ok,true);
  const guest=x.connect();
  await ask(guest,{type:'reconnect',roomId:'TEST',seat:2,reconnectToken:sessions[2].reconnectToken});
  assert.equal((await waitFor(guest,m=>m.type==='choice_window')).window.ticket,second.view.ticket);
  assert.equal((await ask(guest,{type:'choice_submit',ticket:second.view.ticket,option:'decline'})).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  assert.equal(x.started,1);
 }finally{await x.broker.close()}
});
test('server target preview requires delivered authenticated card ticket and locks old stage',async()=>{
 const previous=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 process.env.V3_ALLOW_SEAT_EXPERIMENT='1';
 let x;
 try{
  x=await setup({choiceExperiment:true,ownershipExperiment:true});
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const source=x.authority;
  const publish=obj=>source.clientSend({type:'authority_choice_open',
   roomId:'TEST',seat:0,playerId:sessions[0].playerId,
   source:'preview',...obj});
  const card='v3card_123456';
  publish({kind:'card',prompt:'請選擇手牌',options:[card,'v3card_abcdef']});
  const first=await waitFor(source,m=>m.type==='authority_choice_open_result'&&m.view?.kind==='card');
  assert.equal(first.ok,true);
  const ticket=first.view.ticket;
  const next={kind:'target',prompt:'請選擇印刷目標',options:['s1','s3'],
   previousTicket:ticket,previousOption:card};
  publish(next);
  assert.equal((await waitFor(source,m=>m.type==='authority_choice_open_result'&&
   m.code==='PREVIEW_ADVANCE_DENIED')).ok,false);
  assert.equal((await ask(ws[1],{type:'choice_submit',
   ticket,option:card})).code,'CHOICE_WINDOW_NOT_FOUND');
  assert.equal((await ask(ws[0],{type:'choice_submit',
   ticket,option:card})).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.state==='delivered'&&
   m.window.ticket===ticket);
  publish({...next,previousOption:'v3card_abcdef'});
  const bad=await waitFor(source,m=>m.type==='authority_choice_open_result'&&
   m.code==='PREVIEW_ADVANCE_DENIED'&&m!==undefined);
  assert.equal(bad.ok,false);
  publish(next);
  const opened=await waitFor(source,m=>m.type==='authority_choice_open_result'&&
   m.view?.kind==='target');
  assert.equal(opened.ok,true);
  assert.notEqual(opened.view.ticket,ticket);
  assert.deepEqual(opened.view.options,['s1','s3']);
  assert.equal((await ask(ws[0],{type:'choice_submit',
   ticket,option:card})).code,'CHOICE_WINDOW_NOT_FOUND');
  assert.equal((await ask(ws[1],{type:'choice_submit',
   ticket:opened.view.ticket,option:'s1'})).code,'CHOICE_WINDOW_NOT_FOUND');
  assert.equal((await ask(ws[0],{type:'choice_submit',
   ticket:opened.view.ticket,option:'s0'})).code,'CHOICE_OPTION_NOT_ALLOWED');
  assert.equal((await ask(ws[0],{type:'choice_submit',
   ticket:opened.view.ticket,option:'s1'})).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.ticket===opened.view.ticket&&
   m.window.state==='delivered');
  source.clientSend({type:'authority_choice_native_applied',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,
   ticket:opened.view.ticket,option:'s1'});
  assert.equal((await waitFor(source,m=>m.type==='error'&&
   m.code==='CHOICE_NATIVE_APPLY_DENIED')).code,'CHOICE_NATIVE_APPLY_DENIED');
  assert.equal((await ask(ws[0],{type:'command',action:'playCard'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{
  if(x)await x.broker.close();
  if(previous===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=previous;
 }
});
test('only authenticated worker can renew live native preview, never a human or stale ticket',async()=>{
 const previous=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 process.env.V3_ALLOW_SEAT_EXPERIMENT='1';
 let x;
 try{
  x=await setup({choiceExperiment:true,ownershipExperiment:true});
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const worker=x.authority;
  const option='v3card_123456';
  worker.clientSend({type:'authority_choice_open',source:'preview',
   roomId:'TEST',seat:0,playerId:sessions[0].playerId,
   kind:'card',prompt:'選擇手牌',options:[option,'v3card_abcdef']});
  const opened=await waitFor(worker,m=>m.type==='authority_choice_open_result'&&m.view?.kind==='card');
  assert.equal(opened.ok,true);
  const first=opened.view;
  assert.equal((await ask(ws[0],{type:'authority_choice_renew',
   roomId:'TEST',seat:0,playerId:sessions[0].playerId,ticket:first.ticket})).code,
   'UNKNOWN_MESSAGE_TYPE');
  worker.clientSend({type:'authority_choice_renew',roomId:'TEST',seat:1,
   playerId:sessions[1].playerId,ticket:first.ticket});
  assert.equal((await waitFor(worker,m=>m.type==='error'&&
   m.code==='PREVIEW_LEASE_RENEW_DENIED')).code,'PREVIEW_LEASE_RENEW_DENIED');
  await new Promise(ok=>setTimeout(ok,15));
  worker.clientSend({type:'authority_choice_renew',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,ticket:first.ticket});
  const renewed=await waitFor(worker,m=>m.type==='authority_choice_lease_renewed'&&m.ticket===first.ticket);
  assert.ok(renewed.expiresAt>first.expiresAt);
  assert.equal((await ask(ws[0],{type:'choice_query'})).window.ticket,first.ticket);
  assert.equal((await ask(ws[0],{type:'choice_submit',
   ticket:first.ticket,option})).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.ticket===first.ticket&&m.window.state==='delivered');
  worker.clientSend({type:'authority_choice_open',source:'preview',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,kind:'target',prompt:'選擇目標',
   options:['s1','s3'],previousTicket:first.ticket,previousOption:option});
  const target=await waitFor(worker,m=>m.type==='authority_choice_open_result'&&m.view?.kind==='target');
  assert.equal(target.ok,true);
  assert.notEqual(target.view.ticket,first.ticket);
  worker.clientSend({type:'authority_choice_renew',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,ticket:first.ticket});
  assert.equal((await waitFor(worker,m=>m.type==='error'&&
   m.code==='PREVIEW_LEASE_RENEW_DENIED')).code,'PREVIEW_LEASE_RENEW_DENIED');
  await new Promise(ok=>setTimeout(ok,15));
  worker.clientSend({type:'authority_choice_renew',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,ticket:target.view.ticket});
  const second=await waitFor(worker,m=>m.type==='authority_choice_lease_renewed'&&m.ticket===target.view.ticket);
  assert.ok(second.expiresAt>target.view.expiresAt);
  // The proof belongs to the offboard worker channel. Its loss cancels
  // both the only active ticket and further renewal capability.
  worker.close();
  await waitFor(ws[0],m=>m.type==='choice_interrupted');
  assert.equal((await ask(ws[0],{type:'choice_query'})).window,null);
 }finally{
  if(x)await x.broker.close();
  if(previous===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=previous;
 }
});
test('native no-card pass application needs real worker identity and delivered preview receipt',async()=>{
 const previous=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 process.env.V3_ALLOW_SEAT_EXPERIMENT='1';
 let x;
 try{
  x=await setup({choiceExperiment:true,ownershipExperiment:true});
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const w=x.authority;
  w.clientSend({type:'authority_choice_open',source:'preview',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,kind:'card',
   prompt:'原版行動等待',options:['v3card_123456','pass']});
  const opened=await waitFor(w,m=>m.type==='authority_choice_open_result'&&m.view?.kind==='card');
  assert.equal(opened.ok,true);
  const ticket=opened.view.ticket;
  assert.equal((await ask(ws[1],{type:'authority_choice_preview_pass_applied',
   seat:0,playerId:sessions[0].playerId,ticket})).code,'UNKNOWN_MESSAGE_TYPE');
  w.clientSend({type:'authority_choice_preview_pass_applied',seat:0,
   roomId:'TEST',playerId:sessions[0].playerId,ticket});
  assert.equal((await waitFor(w,m=>m.type==='error'&&
   m.code==='CHOICE_PREVIEW_PASS_APPLY_DENIED')).code,'CHOICE_PREVIEW_PASS_APPLY_DENIED');
  assert.equal((await ask(ws[0],{type:'choice_submit',ticket,option:'pass'})).code,
   'CHOICE_SUBMITTED_NOT_APPLIED');
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.ticket===ticket&&
   m.window.state==='delivered');
  w.clientSend({type:'authority_choice_preview_pass_applied',roomId:'TEST',
   seat:0,playerId:sessions[1].playerId,ticket});
  assert.equal((await waitFor(w,m=>m.type==='error'&&
   m.code==='NATIVE_PASS_SEAT_DENIED')).code,'NATIVE_PASS_SEAT_DENIED');
  w.clientSend({type:'authority_choice_preview_pass_applied',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,ticket});
  const applied=await waitFor(w,m=>m.type==='authority_choice_applied_confirmed'&&
   m.code==='CHOICE_PREVIEW_PASS_APPLIED');
  assert.equal(applied.ticket,ticket);
  assert.equal((await ask(ws[0],{type:'choice_query'})).window.state,'applied');
  assert.equal((await ask(ws[0],{type:'command',action:'playCard'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{
  if(x)await x.broker.close();
  if(previous===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=previous;
 }
});
test('choice delivery captures exact connection generation, never stable player identity alone',async()=>{
 const previous=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 process.env.V3_ALLOW_SEAT_EXPERIMENT='1';
 let x;
 try{
  x=await setup({choiceExperiment:true,ownershipExperiment:true});
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const worker=x.authority;
  const oldRoster=await waitFor(worker,m=>m.type==='authority_roster'&&
   m.bindings?.some(b=>b.seat===0&&b.connectionId!==null));
  const oldId=oldRoster.bindings.find(b=>b.seat===0).connectionId;
  assert.match(oldId,/^[a-f0-9]{24}$/);
  const playerId=sessions[0].playerId;
  worker.clientSend({type:'authority_choice_open',roomId:'TEST',source:'preview',
   seat:0,playerId,kind:'card',prompt:'請選擇手牌',
   options:['v3card_123456','v3card_abcdef']});
  const choice=await waitFor(worker,m=>m.type==='authority_choice_open_result'&&
   m.view?.kind==='card'&&m.ok);
  assert.equal(choice.ok,true);
  // A new socket claims the SAME authenticated player seat using the
  // rotating token, replacing the still-connected original socket.
  const replacement=x.connect();
  const attached=await ask(replacement,{type:'reconnect',roomId:'TEST',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(attached.playerId,playerId);
  assert.equal(ws[0].readyState,3);
  assert.notEqual(attached.reconnectToken,sessions[0].reconnectToken);
  const newRoster=await waitFor(worker,m=>m.type==='authority_roster'&&
   m.bindings?.some(b=>b.seat===0&&b.connectionId!==null&&
    b.connectionId!==oldId));
  const newId=newRoster.bindings.find(b=>b.seat===0).connectionId;
  assert.match(newId,/^[a-f0-9]{24}$/);
  assert.notEqual(newId,oldId);
  assert.equal(newRoster.bindings.find(b=>b.seat===0).playerId,playerId);
  const resumed=await waitFor(replacement,m=>m.type==='choice_window'&&
   m.window?.ticket===choice.view.ticket);
  assert.equal(resumed.window.playerId,playerId);
  assert.equal((await ask(replacement,{type:'choice_submit',
   ticket:choice.view.ticket,option:'v3card_123456'})).code,'CHOICE_SUBMITTED_NOT_APPLIED');
  const delivery=await waitFor(worker,m=>m.type==='authority_choice_delivery'&&
   m.ticket===choice.view.ticket);
  assert.equal(delivery.playerId,playerId);
  assert.equal(delivery.seat,0);
  assert.equal(delivery.connectionId,newId);
  assert.notEqual(delivery.connectionId,oldId);
  assert.equal((await ask(replacement,{type:'choice_query'})).window.state,'delivered');
  // A stale old socket is not allowed to affect the already accepted
  // result. The authority delivery identifies one socket generation.
  assert.equal((await ask(replacement,{type:'choice_submit',
   ticket:choice.view.ticket,option:'v3card_abcdef'})).code,'CHOICE_ALREADY_LOCKED');
  assert.equal((await ask(replacement,{type:'command',action:'playCard'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{
  if(x)await x.broker.close();
  if(previous===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=previous;
 }
});
test('choice experiment disabled by default and worker loss cancels all pending choices',async()=>{
 const x=await setup();
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  x.authority.clientSend({type:'authority_choice_open',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,kind:'control',prompt:'Select',options:['yes','no']});
  assert.equal((await waitFor(x.authority,m=>m.type==='error'&&m.code==='CHOICE_EXPERIMENT_DISABLED')).code,'CHOICE_EXPERIMENT_DISABLED');
  assert.equal((await ask(ws[0],{type:'choice_query'})).code,'CHOICE_EXPERIMENT_DISABLED');
 }finally{await x.broker.close()}
 const y=await setup({choiceExperiment:true});
 try{
  const {ws,sessions}=await fill(y);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  y.authority.clientSend({type:'authority_choice_open',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,kind:'control',prompt:'Select',options:['yes','no']});
  const opened=await waitFor(y.authority,m=>m.type==='authority_choice_open_result');
  assert.equal(opened.ok,true);
  y.authority.close();
  const interrupt=await waitFor(ws[0],m=>m.type==='choice_interrupted');
  assert.equal(interrupt.code,'WORKER_CHANNEL_OFFLINE');
  assert.equal((await ask(ws[0],{type:'choice_query'})).window,null);
  assert.equal((await ask(ws[0],{type:'choice_submit',ticket:opened.view.ticket,option:'yes'})).code,'WORKER_CHANNEL_OFFLINE');
 }finally{await y.broker.close()}
});


test('dead Chromium with still-open worker channel cannot reveal or submit stale choice tickets',async()=>{
 const x=await setup({choiceExperiment:true});
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  x.authority.clientSend({type:'authority_choice_open',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,kind:'control',prompt:'Select',options:['yes','no']});
  const opened=await waitFor(x.authority,m=>m.type==='authority_choice_open_result');
  assert.equal(opened.ok,true);
  const ticket=opened.view.ticket;
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.ticket===ticket);
  x.crashWorker(); // Intentionally keep the authenticated worker socket OPEN.
  assert.equal(x.authority.readyState,1);
  assert.equal((await x.broker.inspectWorker('TEST')).code,'WORKER_UNAVAILABLE');
  const stale=await ask(ws[0],{type:'choice_query'});
  assert.equal(stale.ok,false);
  assert.equal(stale.code,'WORKER_UNAVAILABLE');
  assert.equal(Object.hasOwn(stale,'window'),false);
  assert.equal((await ask(ws[0],{type:'choice_submit',ticket,option:'yes'})).code,
   'WORKER_UNAVAILABLE');
  assert.equal(x.authority.outbound.some(m=>m.type==='authority_choice_delivery'),false);
  const replacement=x.connect();
  const resumed=await ask(replacement,{type:'reconnect',roomId:'TEST',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(resumed.ok,true);
  assert.equal(resumed.playerId,sessions[0].playerId);
  assert.equal((await waitFor(replacement,m=>m.type==='choice_interrupted')).code,
   'WORKER_UNAVAILABLE');
  assert.equal(replacement.outbound.some(m=>
   m.type==='choice_window'&&m.window.ticket===ticket),false);
  assert.equal((await ask(replacement,{type:'choice_submit',ticket,option:'yes'})).code,
   'WORKER_UNAVAILABLE');
  x.authority.close();
  await waitFor(replacement,m=>m.type==='choice_interrupted'&&
   m.code==='WORKER_CHANNEL_OFFLINE');
  assert.equal((await ask(replacement,{type:'choice_query'})).window,null);
 }finally{await x.broker.close()}
});
test('watchdog interrupts every online seat when Chromium dies before private socket close',async()=>{
 const x=await setup({choiceExperiment:true,workerHealthIntervalMs:100});
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  x.authority.clientSend({type:'authority_choice_open',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,kind:'control',prompt:'Select',options:['yes','no']});
  const opened=await waitFor(x.authority,m=>m.type==='authority_choice_open_result');
  assert.equal(opened.ok,true);
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.ticket===opened.view.ticket);
  // A dead/frozen browser will not acknowledge a graceful close request.
  // The watchdog must TERMINATE, not wait for that WebSocket handshake.
  const originalClose=x.authority.close.bind(x.authority);
  x.authority.close=()=>{}; // Simulate an unacknowledged close frame.
  x.authority.terminate=()=>originalClose();
  // No player request after this point triggers failure recognition.
  x.crashWorker();
  for(let seat=0;seat<4;seat++){
   const event=await waitFor(ws[seat],m=>m.type==='choice_interrupted');
   assert.equal(event.code,'WORKER_CHANNEL_OFFLINE');
  }
  assert.equal(x.authority.readyState,3);
  assert.equal((await ask(ws[0],{type:'choice_query'})).window,null);
  assert.equal((await ask(ws[0],{type:'choice_submit',
   ticket:opened.view.ticket,option:'yes'})).code,'WORKER_CHANNEL_OFFLINE');
  assert.equal(x.broker.roomView('TEST').roster.every(s=>s.connected),true);
  assert.equal((await x.broker.inspectWorker('TEST')).code,'WORKER_UNAVAILABLE');
 }finally{await x.broker.close()}
});

test('all probe classes reject a dead Chromium even while its WebSocket is still open',async()=>{
 const previous=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 process.env.V3_ALLOW_SEAT_EXPERIMENT='1';
 let x;
 try{
  x=await setup({ownershipExperiment:true});
  const {ws}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  x.crashWorker();
  assert.equal(x.authority.readyState,1);
  for(const request of [
   {type:'transport_probe'},
   {type:'action_ownership_probe',cardId:'v3card_123456'},
   {type:'action_target_probe',cardId:'v3card_123456',targetSeat:1}
  ]){
   const answer=await ask(ws[0],request);
   assert.equal(answer.code,'WORKER_UNAVAILABLE');
   assert.equal(answer.ok,false);
  }
  assert.equal(x.authority.outbound.some(m=>
   ['authority_transport_probe','authority_action_ownership_probe',
    'authority_action_target_probe'].includes(m.type)),false);
 }finally{
  if(x)await x.broker.close();
  if(previous===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=previous;
 }
});

test('socket replacement while Chromium health check is pending cannot submit previous generation ticket',async()=>{
 const x=await setup({choiceExperiment:true});
 let gate;
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  x.authority.clientSend({type:'authority_choice_open',roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,kind:'control',prompt:'Select',options:['yes','no']});
  const opened=await waitFor(x.authority,m=>m.type==='authority_choice_open_result');
  const ticket=opened.view.ticket;
  await waitFor(ws[0],m=>m.type==='choice_window'&&m.window.ticket===ticket);
  gate=x.pauseNextInspect();
  ws[0].clientSend({type:'choice_submit',requestId:'stale_submit',ticket,option:'yes'});
  await gate.entered;
  const replacement=x.connect();
  const resumed=await ask(replacement,{type:'reconnect',roomId:'TEST',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(resumed.ok,true);
  assert.equal(resumed.playerId,sessions[0].playerId);
  await waitFor(replacement,m=>m.type==='choice_window'&&m.window.ticket===ticket);
  gate.release();
  const view=await ask(replacement,{type:'choice_query'});
  assert.equal(view.window.state,'open');
  assert.equal(x.authority.outbound.some(m=>m.type==='authority_choice_delivery'),false);
  assert.equal((await ask(replacement,{type:'choice_submit',ticket,option:'yes'})).code,
   'CHOICE_SUBMITTED_NOT_APPLIED');
  await waitFor(replacement,m=>m.type==='choice_window'&&m.window.state==='delivered');
  const delivery=x.authority.outbound.filter(m=>m.type==='authority_choice_delivery');
  assert.equal(delivery.length,1);
  assert.equal(delivery[0].playerId,sessions[0].playerId);
 }finally{
  gate?.release();
  await x.broker.close();
 }
});

test('worker loss fails outstanding transport immediately and ignores stale host acks',async()=>{
 const x=await setup();
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const authority=x.authority;
  const emit=authority.clientSend.bind(authority);
  authority.clientSend=msg=>{
   // Simulate a crashed browser which received the request but never ACKed it.
   if(msg.type!=='authority_probe_ack')emit(msg);
  };
  const pending=ask(ws[0],{type:'transport_probe'});
  const outbound=await waitFor(authority,m=>m.type==='authority_transport_probe');
  assert.equal(outbound.playerId,sessions[0].playerId);
  authority.close();
  const answer=await pending;
  assert.equal(answer.code,'WORKER_CHANNEL_OFFLINE');
  assert.equal(answer.ok,false);
  assert.equal((await x.broker.inspectWorker('TEST')).code,'WORKER_CHANNEL_OFFLINE');
  // A stray late host packet cannot override a failed request.
  authority.clientSend=emit;
  authority.clientSend({type:'authority_probe_ack',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,traceId:outbound.traceId});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(ws[0].outbound.filter(m=>m.type==='reply'&&
   m.requestId===answer.requestId).length,1);
  assert.equal((await ask(ws[0],{type:'transport_probe'})).code,'WORKER_CHANNEL_OFFLINE');
  assert.equal((await ask(ws[0],{type:'command',action:'attack'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{await x.broker.close()}
});

test('native action ownership preflight is disabled by default and can never become arbitrary gameplay',async()=>{
 const x=await setup();
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  for(const [seat,cardId] of [[0,'v3card_000001'],[1,'v3card_000001']]){
   const denied=await ask(ws[seat],{type:'action_ownership_probe',cardId});
   assert.equal(denied.ok,false);
   assert.equal(denied.code,'ACTION_PROBE_DISABLED');
  }
  x.authority.clientSend({type:'authority_action_ownership_result',
   roomId:'TEST',traceId:'f'.repeat(32),seat:0,
   playerId:sessions[0].playerId,owned:true});
  assert.equal((await waitFor(x.authority,m=>
   m.type==='error'&&m.code==='ACTION_PROBE_DISABLED')).code,
   'ACTION_PROBE_DISABLED');
  assert.equal((await ask(ws[0],{type:'command',action:'playCard',
   cardId:'v3card_000001'})).code,'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{await x.broker.close()}
});
test('native attack target reply is bound to original player, trace, target and session',async()=>{
 const prior=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 process.env.V3_ALLOW_SEAT_EXPERIMENT='1';
 let x;
 try{x=await setup({ownershipExperiment:true})}
 finally{
  if(prior===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=prior;
 }
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const cardId='v3card_000001';
  const pending=ask(ws[0],{type:'action_target_probe',cardId,targetSeat:1});
  const sent=await waitFor(x.authority,m=>m.type==='authority_action_target_probe');
  assert.equal(sent.seat,0);
  assert.equal(sent.playerId,sessions[0].playerId);
  assert.equal(sent.targetSeat,1);
  assert.equal(sent.cardId,cardId);
  // Invalid target cannot borrow a pending authenticated trace.
  x.authority.clientSend({
   type:'authority_action_target_result',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,targetSeat:2,traceId:sent.traceId,
   supportedPrintedAttack:true,printedTargetEligible:true
  });
  assert.equal((await waitFor(x.authority,m=>
   m.type==='error'&&m.code==='ACTION_TARGET_ACK_INVALID')).code,
   'ACTION_TARGET_ACK_INVALID');
  x.authority.clientSend({
   type:'authority_action_target_result',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,targetSeat:1,traceId:sent.traceId,
   supportedPrintedAttack:true,printedTargetEligible:true
  });
  const result=await pending;
  assert.equal(result.ok,true);
  assert.equal(result.code,'ACTION_PRINTED_TARGET_PRECHECK_PASSED');
  assert.equal(result.fullRulesValidated,false);
  assert.equal(result.targetFullyValidated,false);
  assert.equal(result.cardConsumed,false);
  assert.equal(result.actionExecuted,false);
  assert.equal(JSON.stringify(result).includes(cardId),false);
  // Replay cannot acknowledge the same trace twice.
  x.authority.clientSend({
   type:'authority_action_target_result',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,targetSeat:1,traceId:sent.traceId,
   supportedPrintedAttack:true,printedTargetEligible:true
  });
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(ws[0].outbound.filter(r=>r.type==='reply'&&
   r.requestId===result.requestId).length,1);
  // A real session takeover replaces socket ownership before the delayed
  // Chromium answer is considered, and the old socket sees no reply.
  const later=ask(ws[0],{type:'action_target_probe',cardId,targetSeat:3}).catch(()=>null);
  const second=await waitFor(x.authority,m=>
   m.type==='authority_action_target_probe'&&m.targetSeat===3);
  const replacement=x.connect();
  const auth=await ask(replacement,{type:'reconnect',roomId:'TEST',seat:0,
   reconnectToken:sessions[0].reconnectToken});
  assert.equal(auth.playerId,sessions[0].playerId);
  x.authority.clientSend({
   type:'authority_action_target_result',roomId:'TEST',
   seat:0,playerId:sessions[0].playerId,targetSeat:3,traceId:second.traceId,
   supportedPrintedAttack:true,printedTargetEligible:true
  });
  for(let i=0;i<100&&x.authority.outbound.filter(m=>m.type==='error'&&
   m.code==='ACTION_TARGET_ACK_INVALID').length<3;i++)
   await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(x.authority.outbound.filter(m=>m.type==='error'&&
   m.code==='ACTION_TARGET_ACK_INVALID').length,3);
  assert.equal((await ask(replacement,{type:'command',action:'playCard'})).code,
   'RULES_ENGINE_NOT_IMPLEMENTED');
  // The old pending Promise cannot produce a late reply after takeover.
  assert.equal(await later,null);
 }finally{await x.broker.close()}
});
test('native printed attack target preflight defaults to denied and cannot enable gameplay',async()=>{
 const x=await setup();
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  assert.equal((await ask(ws[0],{type:'action_target_probe',
   cardId:'v3card_000001',targetSeat:1})).code,'ACTION_PROBE_DISABLED');
  assert.equal((await ask(ws[1],{type:'action_target_probe',
   cardId:'v3card_000001',targetSeat:0})).code,'ACTION_PROBE_DISABLED');
  x.authority.clientSend({type:'authority_action_target_result',
   traceId:'f'.repeat(32),roomId:'TEST',seat:0,
   playerId:sessions[0].playerId,targetSeat:1,
   supportedPrintedAttack:true,printedTargetEligible:true});
  assert.equal((await waitFor(x.authority,m=>
   m.type==='error'&&m.code==='ACTION_PROBE_DISABLED')).code,'ACTION_PROBE_DISABLED');
  assert.equal((await ask(ws[0],{type:'command',action:'playCard',
   targetSeat:1})).code,'RULES_ENGINE_NOT_IMPLEMENTED');
 }finally{await x.broker.close()}
});
test('native action ownership probe cannot be enabled without isolated CI flag',async()=>{
 if(process.env.V3_ALLOW_SEAT_EXPERIMENT==='1')return;
 await assert.rejects(
  createV3AuthorityWebSocketBroker({
   WebSocketServer:FakeWebSocketServer,
   launchWorker:async()=>{},
   enableNativeOwnershipProbes:true
  }),
  /NATIVE_CARD_OWNERSHIP_PROBE_CI_ONLY/
 );
});


test('worker-only whole-room private snapshot commits atomically and does not leak cards',async()=>{
 const x=await setup({privateHandExperiment:true});
 try{
  const {ws,sessions}=await fill(x);
  assert.equal((await ask(ws[0],{type:'launch'})).ok,true);
  const cards=seat=>Array.from({length:4},(_,i)=>({
   cardId:'v3card_'+(seat*4+i).toString(16).padStart(6,'0'),
   name:i%2===0?'anMie':'shuiLianZhan'
  }));
  const next=(revision=1)=>({
   type:'authority_private_hands_batch',roomId:'TEST',revision,
   seats:Array.from({length:4},(_,seat)=>({
    seat,playerId:sessions[seat].playerId,character:'youXia',
    ownHand:cards(seat),
    publicOtherHandCounts:Array.from({length:4},(_,i)=>({seat:i,handCount:4}))
   }))
  });
  assert.equal((await ask(ws[0],next())).code,'UNKNOWN_MESSAGE_TYPE');
  x.authority.clientSend(next());
  const stored=await waitFor(x.authority,m=>
   m.type==='authority_private_hands_batch_stored'&&m.revision===1);
  assert.equal(stored.code,'PRIVATE_PROJECTION_ROOM_STORED');
  assert.equal(Object.hasOwn(stored,'seats'),false);
  assert.equal(JSON.stringify(stored).includes('v3card_'),false);
  for(let seat=0;seat<4;seat++){
   const own=await ask(ws[seat],{type:'private_hand_query'});
   assert.equal(own.view.revision,1);
   assert.deepEqual(own.view.ownHand,cards(seat));
   assert.deepEqual(own.view.publicOtherHandCounts.map(x=>x.handCount),[4,4,4,4]);
  }
  // Moves across seats are one transaction: no brief duplicate ownership.
  const transferred=next(2);
  const moved=transferred.seats[0].ownHand.pop();
  transferred.seats[1].ownHand.push(moved);
  for(const s of transferred.seats){
   s.publicOtherHandCounts[0].handCount=3;
   s.publicOtherHandCounts[1].handCount=5;
  }
  x.authority.clientSend(transferred);
  await waitFor(x.authority,m=>
   m.type==='authority_private_hands_batch_stored'&&m.revision===2);
  for(let seat=0;seat<4;seat++){
   const own=await ask(ws[seat],{type:'private_hand_query'});
   assert.equal(own.view.revision,2);
   assert.equal(own.view.ownHand.length,seat===0?3:seat===1?5:4);
   assert.deepEqual(own.view.publicOtherHandCounts.map(x=>x.handCount),[3,5,4,4]);
  }
  const corrupted=next(3);
  corrupted.seats[1].playerId=sessions[0].playerId;
  x.authority.clientSend(corrupted);
  await waitFor(x.authority,m=>m.type==='error'&&m.code==='PRIVATE_HAND_SEAT_DENIED');
  for(let seat=0;seat<4;seat++)
   assert.equal((await ask(ws[seat],{type:'private_hand_query'})).view.revision,2);
  x.authority.clientSend(next(1));
  await waitFor(x.authority,m=>m.type==='error'&&
   m.code==='PRIVATE_PROJECTION_STALE_OR_ID_MISMATCH');
  assert.equal((await ask(ws[1],{type:'private_hand_query'})).view.revision,2);
 }finally{await x.broker.close()}
});
