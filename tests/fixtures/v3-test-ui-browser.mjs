import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const assets=new Map([
 ['/','index.html'],['/index.html','index.html'],['/client.js','client.js'],['/style.css','style.css'],
]);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};

export async function startV3TestUiServer({handleApiRequest,maxRequestsPerMinute=90}={}){
 if(!Number.isSafeInteger(maxRequestsPerMinute)||maxRequestsPerMinute<1||maxRequestsPerMinute>1000)throw Error('V3_TEST_UI_RATE_LIMIT_INVALID');
 const requestTimes=new Map();
 const server=createServer(async(req,res)=>{
  const requestOrigin=typeof req.headers.origin==='string'?req.headers.origin:null;
  const remote=req.socket.remoteAddress||'';
  const loopback=remote==='127.0.0.1'||remote==='::ffff:127.0.0.1';
  const requestUrl=new URL(req.url||'/',`http://127.0.0.1`);
  if(requestUrl.pathname.startsWith('/api/')){
   const sendJson=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'content-security-policy':"default-src 'none'; frame-ancestors 'none'; object-src 'none'",
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin'});res.end(JSON.stringify(value));};
   if(!loopback){sendJson(403,{ok:false,code:'V3_TEST_UI_LOOPBACK_REQUIRED'});return;}
   const expectedOrigin=`http://127.0.0.1:${server.address()?.port}`;
   if(requestOrigin){
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(requestOrigin)||requestOrigin!==expectedOrigin){sendJson(403,{ok:false,code:'V3_TEST_UI_ORIGIN_REJECTED'});return;}
   }else if(req.headers['sec-fetch-site']!=='same-origin'){
    sendJson(403,{ok:false,code:'V3_TEST_UI_ORIGIN_REJECTED'});return;
   }
   if(typeof handleApiRequest!=='function'){sendJson(403,{ok:false,code:'V3_TEST_UI_HANDLER_UNAVAILABLE'});return;}
   const capability=req.headers['x-v3-test-capability'];
   if(typeof capability!=='string'||!/^[a-f0-9]{64}$/.test(capability)){
    sendJson(401,{ok:false,code:'V3_TEST_UI_CAPABILITY_REQUIRED'});return;
   }
   const now=Date.now(),recent=(requestTimes.get(capability)||[]).filter(time=>now-time<60000);
   if(recent.length>=maxRequestsPerMinute){sendJson(429,{ok:false,code:'V3_TEST_UI_RATE_LIMITED'});return;}
   recent.push(now);requestTimes.set(capability,recent);
   const route=requestUrl.pathname.slice('/api/'.length);
   const allowedMethod=route==='room'||route==='gateway'?'GET':new Set(['create-room','join','ready','unready','seat-credential']).has(route)?'POST':null;
   if(!allowedMethod||req.method!==allowedMethod){sendJson(404,{ok:false,code:'V3_TEST_UI_ROUTE_REJECTED'});return;}
   let body={};
   if(req.method==='POST'){
    const chunks=[];let size=0,tooLarge=false;
    try{
     for await(const chunk of req){size+=chunk.length;if(size>4096){tooLarge=true;break;}chunks.push(chunk);}
    }catch{sendJson(400,{ok:false,code:'V3_TEST_UI_REQUEST_INVALID'});return;}
    if(tooLarge){sendJson(413,{ok:false,code:'V3_TEST_UI_REQUEST_TOO_LARGE'});return;}
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{sendJson(400,{ok:false,code:'V3_TEST_UI_REQUEST_INVALID'});return;}
    if(!body||Object.getPrototypeOf(body)!==Object.prototype||Array.isArray(body)){sendJson(400,{ok:false,code:'V3_TEST_UI_REQUEST_INVALID'});return;}
   }
   try{
    const value=await handleApiRequest({route,capability,body,roomId:requestUrl.searchParams.get('roomId')});
    sendJson(value?.ok===false?403:200,value||{ok:false,code:'V3_TEST_UI_REQUEST_REJECTED'});
   }catch{sendJson(500,{ok:false,code:'V3_TEST_UI_CONTROL_FAILED'});}
   return;
  }
  const file=assets.get(req.url||'');
  if(req.method!=='GET'||!file){res.writeHead(404,{'cache-control':'no-store'});res.end('not found');return;}
  try{
   const body=await readFile(path.join(root,'game/v3-test-ui',file));
   res.writeHead(200,{'content-type':mime[path.extname(file)],'cache-control':'no-store',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin'});
   res.end(body);
  }catch{res.writeHead(500,{'cache-control':'no-store'});res.end('unavailable');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();
 return Object.freeze({origin:`http://127.0.0.1:${address.port}`,close:()=>new Promise(resolve=>server.close(()=>resolve()))});
}

export async function launchV3TestUiBrowser({executable,origin,startupTimeoutMs=15000}={}){
 if(typeof executable!=='string'||!path.isAbsolute(executable)||typeof origin!=='string'||!origin.startsWith('http://127.0.0.1:'))throw Error('V3_UI_BROWSER_CONFIG_INVALID');
 const WebSocket=require('ws');
 const profile=await mkdtemp(path.join(tmpdir(),'v3-player-ui-'));
 const child=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking',
  '--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
 let processExited=child.exitCode!==null,resolveProcessExit;
 const processExit=new Promise(resolve=>{resolveProcessExit=resolve;});
 if(processExited)resolveProcessExit();else child.once('exit',()=>{processExited=true;resolveProcessExit();});
 let cdp, closed=false, closePromise=null, profileRemoved=false, pollers=new Set(),contexts=new Set(),peers=new Set(),nextId=1;
 const peerPages=new WeakMap();
 const configuredPages=new Map();
 const pending=new Map();
 function command(method,params={},sessionId){
  if(!cdp||cdp.readyState!==WebSocket.OPEN)return Promise.reject(Error('V3_UI_CDP_CLOSED'));
  const id=nextId++;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('V3_UI_CDP_COMMAND_TIMEOUT'));},10000);pending.set(id,{resolve,reject,timer});
   cdp.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 }
 async function readDevtoolsUrl(){
  const file=path.join(profile,'DevToolsActivePort'),end=Date.now()+startupTimeoutMs;
  while(Date.now()<end){if(child.exitCode!==null)throw Error('V3_UI_CHROMIUM_EXITED_DURING_START');try{const [port,browserPath]= (await readFile(file,'utf8')).trim().split(/\r?\n/);if(port&&browserPath)return `ws://127.0.0.1:${port}${browserPath}`;}catch{}await new Promise(r=>setTimeout(r,40));}
  throw Error('V3_UI_CHROMIUM_CDP_START_TIMEOUT');
 }
 try{
  cdp=new WebSocket(await readDevtoolsUrl());
  await new Promise((resolve,reject)=>{cdp.once('open',resolve);cdp.once('error',reject);});
  cdp.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('V3_UI_CDP_COMMAND_FAILED')):p.resolve(m.result);}});
  async function evaluate(sessionId,expression){
   const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);
   if(result.exceptionDetails)throw Error('V3_UI_PAGE_EVALUATION_FAILED');
   return result.result?.value;
  }
  async function page(){
   const context=(await command('Target.createBrowserContext',{disposeOnDetach:true})).browserContextId;contexts.add(context);
   const target=(await command('Target.createTarget',{url:'about:blank',browserContextId:context})).targetId;
   const session=(await command('Target.attachToTarget',{targetId:target,flatten:true})).sessionId;
   await command('Runtime.enable',{},session);
   await command('Page.enable',{},session);
   await command('Page.navigate',{url:origin+'/'},session);
   const end=Date.now()+10000;
   while(Date.now()<end){if(await evaluate(session,'Boolean(window.v3TestClient)'))return {context,target,session};await new Promise(r=>setTimeout(r,20));}
   throw Error('V3_UI_PAGE_READY_TIMEOUT');
  }
  async function configure(pageInfo,{seatId,capability,roomId=null}={}){
   if(!/^seat_[a-d]$/.test(seatId||'')||!/^[a-f0-9]{64}$/.test(capability||''))throw Error('V3_UI_TEST_PAGE_CONFIG_REJECTED');
   const value={seatId,capability,controlUrl:origin+'/api',roomId};
   await evaluate(pageInfo.session,`window.v3TestClient.configureHarness(${JSON.stringify(value)})`);
   configuredPages.set(seatId,{...pageInfo,capability,roomId});return pageInfo;
  }
  async function createPage({seatId,capability,roomId=null}={}){
   if(closed)throw Error('V3_UI_BROWSER_CLOSED');
   const info=await page();await configure(info,{seatId,capability,roomId});return Object.freeze({seatId});
  }
  async function pageForSeat(seatId){
   const existing=configuredPages.get(seatId);
   if(existing&&contexts.has(existing.context))return existing;
   if(!existing)throw Error('V3_UI_SEAT_PAGE_NOT_CONFIGURED');
   const info=await page();await configure(info,{seatId,capability:existing.capability,roomId:existing.roomId});return info;
  }
  async function clickControl(seatId,control){
   const allowed=new Set(['createRoom','joinRoom','ready','unready','connectGame','refreshRoom']);
   if(!allowed.has(control))throw Error('V3_UI_CONTROL_NOT_ALLOWED');
   const info=await pageForSeat(seatId);
   await evaluate(info.session,`window.v3TestClient.clickControl(${JSON.stringify(control)})`);
  }
  async function configureRoom(seatId,roomId){
   if(!/^room_[a-f0-9]{32}$/.test(roomId))throw Error('V3_UI_ROOM_ID_INVALID');
   const old=configuredPages.get(seatId);if(!old)throw Error('V3_UI_SEAT_PAGE_NOT_CONFIGURED');
   old.roomId=roomId;
   const info=await pageForSeat(seatId);
   await evaluate(info.session,`window.v3TestClient.configureRoom(${JSON.stringify(roomId)})`);
  }
  async function reloadPage(seatId){
   const old=configuredPages.get(seatId);if(!old)throw Error('V3_UI_SEAT_PAGE_NOT_CONFIGURED');
   const info=await pageForSeat(seatId);
   await command('Page.reload',{ignoreCache:true},info.session);
   const end=Date.now()+10000;
   while(Date.now()<end){if(await evaluate(info.session,'Boolean(window.v3TestClient)'))break;await new Promise(r=>setTimeout(r,20));}
   await configure(info,{seatId,capability:old.capability,roomId:old.roomId});
   return Object.freeze({seatId});
  }
  async function inspectPage(seatId){const info=await pageForSeat(seatId);return await evaluate(info.session,'window.v3TestClient?.state()||null');}
  function peerFor(pageInfo){
   const emitter=new EventEmitter();let readyState=0,dead=false,queue=[],polling=false,authStarted=false,wasConnected=false;
   const peer={
    get readyState(){return readyState;},
    on(event,fn){emitter.on(event,fn);if(event==='message'&&queue.length)queue.splice(0).forEach(value=>queueMicrotask(()=>emitter.emit('message',value)));if(event==='open'&&readyState===1)queueMicrotask(()=>emitter.emit('open'));return peer;},
    once(event,fn){emitter.once(event,fn);if(event==='message'&&queue.length){const value=queue.shift();queueMicrotask(()=>emitter.emit('message',value));}if(event==='open'&&readyState===1)queueMicrotask(()=>emitter.emit('open'));return peer;},
    off(event,fn){emitter.off(event,fn);return peer;},
   async send(text){
     if(dead)throw Error('V3_UI_PAGE_CLOSED');
     const message=JSON.parse(String(text));
     const encoded=JSON.stringify(message);
     if(message.type==='seat_auth'){
      authStarted=true;
      await evaluate(pageInfo.session,`window.v3TestClient.connectGame()`);
      return;
     }
     if(message.type==='choice_submit'){
      await evaluate(pageInfo.session,`window.v3TestClient.submitThroughUi(${JSON.stringify(message)})`);return;
     }
     await evaluate(pageInfo.session,`window.v3TestClient.sendProtocol(${JSON.stringify(message)})`);
    },
    close(){if(dead)return;dead=true;readyState=3;void evaluate(pageInfo.session,'window.v3TestClient?.disconnect()').catch(()=>{});stopPolling();
     // A player transport loss closes only the page's WebSocket. Keep the ordinary
     // player page/context alive so rebind exercises the same browser identity.
     peers.delete(peer);emitter.emit('close');},
    terminate(){peer.close();},url:null,
   };
   // The adapter is available for the test harness to issue seat_auth; the
   // actual browser WebSocket is created only by the rendered UI form submit.
   readyState=1;queueMicrotask(()=>emitter.emit('open'));
   function stopPolling(){if(polling){polling=false;pollers.delete(timer);clearInterval(timer);}}
   const timer=setInterval(async()=>{if(dead||polling)return;polling=true;try{
    const messages=await evaluate(pageInfo.session,'window.v3TestClient?.drainMessages()||[]');
    for(const message of messages||[]){const data=Buffer.from(JSON.stringify(message));if(emitter.listenerCount('message'))emitter.emit('message',data);else queue.push(data);}
    const connected=await evaluate(pageInfo.session,'window.v3TestClient?.state().connected===true');
    if(connected)wasConnected=true;
    if(!connected&&authStarted&&wasConnected&&readyState===1){readyState=3;emitter.emit('close');}
   }catch{if(!dead){readyState=3;emitter.emit('error',Error('V3_UI_PAGE_CHANNEL_FAILED'));peer.close();}}finally{polling=false;}},20);
   timer.unref?.();pollers.add(timer);peers.add(peer);peerPages.set(peer,pageInfo);return peer;
  }
  async function createPeer(url,seatId){
   if(closed||!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url))throw Error('V3_UI_GATEWAY_URL_REJECTED');
   const pageInfo=seatId?await pageForSeat(seatId):await page();const peer=peerFor(pageInfo);peer.url=url;
   // The caller's normal socket-open wait resolves when the real browser WebSocket opens.
   return peer;
  }
  async function inspectPeer(peer){
   const pageInfo=peerPages.get(peer);if(!pageInfo)throw Error('V3_UI_PEER_NOT_FOUND');
   const end=Date.now()+5000;let state=null;
   while(Date.now()<end){state=await evaluate(pageInfo.session,'window.v3TestClient?.state()||null');
    if(state?.connected&&state.generation)return state;
    await new Promise(r=>setTimeout(r,20));}
   throw Error(`V3_UI_BROWSER_AUTH_TIMEOUT:${state?.lastErrorCode||'NO_GATEWAY_ERROR'}:${state?.connected?'connected':'disconnected'}`);
  }
  return Object.freeze({createPeer,createPage,configureRoom,reloadPage,clickControl,inspectPage,inspectPeer,origin,
   inspect:()=>Object.freeze({pageCount:contexts.size,contextCount:contexts.size,closed}),
   cleanupStatus:()=>Object.freeze({closed,processExited,contextCount:contexts.size,peerCount:peers.size,
    timerCount:pollers.size,profileRemoved}),close(){
   if(closePromise)return closePromise;closed=true;closePromise=(async()=>{
    for(const peer of [...peers])peer.close();
    for(const timer of pollers)clearInterval(timer);pollers.clear();
    for(const context of [...contexts])try{await command('Target.disposeBrowserContext',{browserContextId:context});}catch{}contexts.clear();
    if(!processExited)try{await command('Browser.close');}catch{}
    if(!processExited)await Promise.race([processExit,new Promise(resolve=>setTimeout(resolve,3000))]);
    if(!processExited){child.kill('SIGTERM');await Promise.race([processExit,new Promise(resolve=>setTimeout(resolve,3000))]);}
    if(!processExited){child.kill('SIGKILL');await Promise.race([processExit,new Promise(resolve=>setTimeout(resolve,3000))]);}
    try{cdp?.close();}catch{}
    try{await rm(profile,{recursive:true,force:true});profileRemoved=true;}catch{}
    if(!processExited)throw Error('V3_UI_CHROMIUM_PROCESS_CLEANUP_FAILED');
   })();return closePromise;
  }});
 }catch(error){try{cdp?.close();}catch{}if(child.exitCode===null)child.kill('SIGKILL');await rm(profile,{recursive:true,force:true}).catch(()=>{});throw error;}
}
