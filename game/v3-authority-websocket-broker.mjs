/**
 * V3-only experimental WebSocket broker. Loopback ephemeral port ONLY.
 * Original V3/V1/V2 servers and native game files remain untouched.
 * Sessions are server owned and in memory; gameplay is intentionally disabled.
 */
import {randomBytes} from 'node:crypto';
import {createV3AuthorityRuntimeCoordinator} from './v3-authority-runtime-coordinator.mjs';

const reply=(ok,code,extra={})=>({ok,code,...extra});
const idOk=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
const tokenOk=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const requestOk=s=>s===undefined||(typeof s==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(s));
const live=ws=>ws?.readyState===1;
const send=(ws,obj)=>{if(!live(ws))return;try{ws.send(JSON.stringify(obj))}catch{try{ws.close(1011)}catch{}}};

export async function createV3AuthorityWebSocketBroker({WebSocketServer,launchWorker,host='127.0.0.1',port=0}={}){
 if(typeof WebSocketServer!=='function'||typeof launchWorker!=='function')throw new TypeError('BROKER_DEPENDENCY_MISSING');
 if(host!=='127.0.0.1'||port!==0)throw new Error('EXPERIMENT_LOOPBACK_EPHEMERAL_ONLY');
 const seatsByRoom=new Map(),pendingWorker=new Map(),workersByRoom=new Map(),allSockets=new Set();
 let closed=false,server;
 const seats=id=>seatsByRoom.get(id);
 const current=(roomId,seat,ws)=>seats(roomId)?.get(seat)?.ws===ws;
 const sendRoster=id=>{
  const view=coordinator.roomView(id);
  if(!view)return;
  for(const entry of seats(id)?.values()??[])send(entry.ws,{type:'roster',view});
  const authority=workersByRoom.get(id);
  if(authority)send(authority,{type:'authority_roster',view});
 };
 const localPort=()=>{
  const a=server?.address();
  if(!a||typeof a==='string'||!Number.isInteger(a.port))throw Error('BROKER_NOT_LISTENING');
  return a.port;
 };
 const coordinator=createV3AuthorityRuntimeCoordinator({launchWorker:async ctx=>{
  if(closed)throw Error('BROKER_CLOSED');
  const secret=randomBytes(32).toString('hex');
  let accept,reject;
  const accepted=new Promise((resolve,rej)=>{accept=resolve;reject=rej});
  accepted.catch(()=>{});
  let timer=null;
  pendingWorker.set(ctx.roomId,{secret,accept,reject});
  let worker;
  try{
   worker=await launchWorker({...ctx,channelUrl:'ws://127.0.0.1:'+localPort(),channelSecret:secret});
   if(!worker||typeof worker.connectRoomChannel!=='function')throw Error('WORKER_BRIDGE_REQUIRED');
   // Begin handshake timeout AFTER cold Chromium startup, not before it.
   timer=setTimeout(()=>reject(Error('WORKER_HANDSHAKE_TIMEOUT')),10000);
   await worker.connectRoomChannel({roomId:ctx.roomId,url:'ws://127.0.0.1:'+localPort(),secret});
   await accepted;
   return worker;
  }catch(err){
   if(worker)try{await worker.stop()}catch{}
   const ws=workersByRoom.get(ctx.roomId);
   if(ws){workersByRoom.delete(ctx.roomId);try{ws.close(1011)}catch{}}
   throw err;
  }finally{clearTimeout(timer);pendingWorker.delete(ctx.roomId)}
 }});
 const handle=async(ws,raw,isBinary)=>{
  if(closed||isBinary)return send(ws,{type:'error',code:'INVALID_FRAME'});
  const value=typeof raw==='string'?raw:Buffer.isBuffer(raw)?raw.toString('utf8'):null;
  if(!value||Buffer.byteLength(value)>16384)return send(ws,{type:'error',code:'INVALID_FRAME'});
  let obj;try{obj=JSON.parse(value)}catch{return send(ws,{type:'error',code:'INVALID_JSON'})}
  if(!obj||typeof obj!=='object'||Array.isArray(obj)||!requestOk(obj.requestId))
   return send(ws,{type:'error',code:'INVALID_MESSAGE'});
  if(ws.__v3AuthorityRoom){
   if(obj.type==='authority_ping'&&obj.roomId===ws.__v3AuthorityRoom)
    return send(ws,{type:'authority_pong'});
   return send(ws,{type:'error',code:'WORKER_GAMEPLAY_NOT_IMPLEMENTED'});
  }
  const respond=result=>send(ws,{type:'reply',requestId:obj.requestId??null,...result});
  if(obj.type==='authority_hello'&&!ws.__v3Player){
   const pending=pendingWorker.get(obj.roomId);
   if(!pending||!tokenOk(obj.secret)||pending.secret!==obj.secret||workersByRoom.has(obj.roomId)){
    respond(reply(false,'WORKER_AUTH_DENIED'));try{ws.close(1008)}catch{};return;
   }
   ws.__v3AuthorityRoom=obj.roomId;
   workersByRoom.set(obj.roomId,ws);
   pending.accept();
   sendRoster(obj.roomId);
   return send(ws,{type:'authority_accepted',roomId:obj.roomId});
  }
  if(['create','join','reconnect'].includes(obj.type)){
   if(ws.__v3Player)return respond(reply(false,'CONNECTION_ALREADY_BOUND'));
   const connectionId=randomBytes(12).toString('hex');
   let result;
   if(obj.type==='create')result=coordinator.create({roomId:obj.roomId,config:obj.config,connectionId});
   else if(obj.type==='join')result=coordinator.join({roomId:obj.roomId,connectionId});
   else result=coordinator.reconnect({roomId:obj.roomId,seat:obj.seat,reconnectToken:obj.reconnectToken,connectionId});
   if(!result.ok)return respond(result);
   let roster=seats(obj.roomId);
   if(!roster){roster=new Map();seatsByRoom.set(obj.roomId,roster)}
   const previous=roster.get(result.seat);
   roster.set(result.seat,{ws,connectionId});
   ws.__v3Player={roomId:obj.roomId,seat:result.seat,connectionId};
   respond(result);
   if(previous?.ws&&previous.ws!==ws){
    previous.ws.__v3Player=null;
    send(previous.ws,{type:'session_revoked'});
    try{previous.ws.close(4001,'seat_replaced')}catch{}
   }
   sendRoster(obj.roomId);
   return;
  }
  const bound=ws.__v3Player;
  if(!bound||!current(bound.roomId,bound.seat,ws))return respond(reply(false,'NOT_AUTHENTICATED'));
  switch(obj.type){
   case 'configure':{
    const result=coordinator.configure({...bound,config:obj.config});
    respond(result);if(result.ok)sendRoster(bound.roomId);return;
   }
   case 'launch':{
    if(bound.seat!==0)return respond(reply(false,'SETUP_PRIVILEGE_REQUIRED'));
    const ids=Array.from(seats(bound.roomId)?.values()??[]).filter(x=>live(x.ws)).map(x=>x.connectionId);
    const result=await coordinator.launchRoomWorker({roomId:bound.roomId,workerClientIds:ids});
    if(current(bound.roomId,bound.seat,ws))respond(result);
    return;
   }
   case 'command':return respond(coordinator.command({...bound,action:obj.action}));
   case 'status':return respond(reply(true,'ROOM_STATUS',{view:coordinator.roomView(bound.roomId)}));
   default:return respond(reply(false,'UNKNOWN_MESSAGE_TYPE'));
  }
 };
 server=new WebSocketServer({host,port,maxPayload:16384,perMessageDeflate:false});
 server.on('connection',ws=>{
  if(closed){ws.close(1001);return}
  allSockets.add(ws);
  let chain=Promise.resolve();
  ws.on('message',(raw,isBinary)=>{chain=chain.then(()=>handle(ws,raw,isBinary)).catch(()=>send(ws,{type:'error',code:'BROKER_INTERNAL_ERROR'}))});
  ws.on('close',()=>{
   allSockets.delete(ws);
   if(ws.__v3AuthorityRoom){
    if(workersByRoom.get(ws.__v3AuthorityRoom)===ws)workersByRoom.delete(ws.__v3AuthorityRoom);
    return;
   }
   const p=ws.__v3Player;
   if(!p||!current(p.roomId,p.seat,ws))return;
   seats(p.roomId).delete(p.seat);
   coordinator.disconnect(p);
   sendRoster(p.roomId);
  });
 });
 await new Promise((resolve,reject)=>{
  if(server.address())return resolve();
  server.once('listening',resolve);server.once('error',reject);
 });
 return Object.freeze({
  address:'ws://127.0.0.1:'+localPort(),
  roomView:id=>coordinator.roomView(id),
  inspectWorker:id=>coordinator.inspectWorker(id),
  async close(){
   if(closed)return;
   closed=true;
   for(const ws of allSockets)try{ws.terminate?.()}catch{}
   for(const id of seatsByRoom.keys())await coordinator.stopRoomWorker(id);
   await new Promise(resolve=>server.close(()=>resolve()));
  }
 });
}
