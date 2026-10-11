/**
 * V3-only EXPERIMENTAL managed headless browser runtime.
 * Owns a Chromium process independently of human WebSocket connections.
 * Does NOT load XingBei rules, accept actions or claim crash recovery.
 * Never attach this prototype to the current V3 broker without full E2E tests.
 */
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const MAX_WAIT_MS=15000;
const fail=(code)=>Object.assign(new Error(code),{code});

function newCdpSession(url, timeoutMs){
 if(typeof url!=='string'||!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/[a-zA-Z0-9-]+$/.test(url))
  throw fail('UNSAFE_DEBUG_SOCKET');
 const ws=new WebSocket(url);
 let seq=0,dead=false;
 const pending=new Map();
 const abort=err=>{
  if(dead)return;
  dead=true;
  for(const [,entry] of pending){clearTimeout(entry.timer);entry.reject(err)}
  pending.clear();
 };
 ws.addEventListener('close',()=>abort(fail('WORKER_CDP_CLOSED')));
 ws.addEventListener('error',()=>abort(fail('WORKER_CDP_ERROR')));
 ws.addEventListener('message',e=>{
  let obj;
  try{obj=JSON.parse(e.data)}catch{return}
  if(!Number.isInteger(obj.id)||!pending.has(obj.id))return;
  const p=pending.get(obj.id);pending.delete(obj.id);clearTimeout(p.timer);
  if(obj.error)p.reject(fail('WORKER_CDP_REJECTED'));
  else p.resolve(obj.result);
 });
 const open=async()=>{
  if(ws.readyState===WebSocket.OPEN)return;
  if(ws.readyState!==WebSocket.CONNECTING)throw fail('WORKER_CDP_CLOSED');
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(fail('WORKER_CDP_TIMEOUT')),timeoutMs);
   ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
   ws.addEventListener('error',()=>{clearTimeout(timer);reject(fail('WORKER_CDP_ERROR'))},{once:true});
  });
 };
 return {
  open,
  async send(method,params={}){
   if(dead||ws.readyState!==WebSocket.OPEN)throw fail('WORKER_CDP_CLOSED');
   if(!['Runtime.enable','Runtime.evaluate','Page.enable','Page.addScriptToEvaluateOnNewDocument'].includes(method))
    throw fail('WORKER_CDP_METHOD_DENIED');
   const id=++seq;
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(fail('WORKER_CDP_TIMEOUT'))},timeoutMs);
    pending.set(id,{resolve,reject,timer});
    try{ws.send(JSON.stringify({id,method,params}))}
    catch{clearTimeout(timer);pending.delete(id);reject(fail('WORKER_CDP_SEND_FAILED'))}
   });
  },
  close(){abort(fail('WORKER_CDP_CLOSED'));ws.close()}
 };
}

export async function launchV3ChromiumAuthorityWorker({executable,timeoutMs=MAX_WAIT_MS}={}){
 if(typeof executable!=='string'||!executable.startsWith('/')||!Number.isInteger(timeoutMs)||
    timeoutMs<500||timeoutMs>60000)throw fail('WORKER_CONFIG_INVALID');
 const profile=await mkdtemp(join(tmpdir(),'v3-authority-worker-'));
 let child,session,closed=false,spawnError=null;
 try{
  child=spawn(executable,[
   '--headless=new','--no-first-run','--no-default-browser-check',
   '--disable-extensions','--disable-background-networking',
   '--disable-dev-shm-usage','--no-sandbox',
   '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
   `--user-data-dir=${profile}`,'about:blank'
  ],{stdio:'ignore',env:{...process.env,CHROME_LOG_FILE:'/dev/null'}});
  child.on('error',()=>{spawnError=fail('WORKER_SPAWN_FAILED')});
  const deadline=Date.now()+timeoutMs;
  let port,devtoolsPath;
  while(Date.now()<deadline){
   if(spawnError)throw spawnError;
   if(child.exitCode!==null||child.signalCode!==null)throw fail('WORKER_EXITED_EARLY');
   try{
    const lines=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');
    if(/^\d+$/.test(lines[0])&&/^\/devtools\/browser\/[\w-]+$/.test(lines[1])){
     port=Number(lines[0]);devtoolsPath=lines[1];break;
    }
   }catch(e){if(e.code!=='ENOENT')throw e}
   await sleep(40);
  }
  if(!port||!devtoolsPath)throw fail('WORKER_BOOT_TIMEOUT');
  const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw fail('WORKER_CDP_DISCOVERY_FAILED');
  const targets=await response.json();
  const page=targets.find(x=>x.type==='page'&&x.url==='about:blank');
  if(!page||typeof page.webSocketDebuggerUrl!=='string')throw fail('WORKER_PAGE_MISSING');
  session=newCdpSession(page.webSocketDebuggerUrl,timeoutMs);
  await session.open();
  await session.send('Page.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument',{source:'Object.defineProperty(window,"isNonameServer",{value:true,writable:false,configurable:false});'});
  const r=await session.send('Runtime.evaluate',{expression:'Object.defineProperty(window,"isNonameServer",{value:true,writable:false,configurable:false}); window.isNonameServer === true',returnByValue:true});
  if(r.exceptionDetails||r.result?.value!==true)throw fail('WORKER_OFFBOARD_BOOT_FAILED');
  return Object.freeze({
   pid:child.pid,
   async inspect(){
    if(closed||child.exitCode!==null||child.signalCode!==null)throw fail('WORKER_UNAVAILABLE');
    const r=await session.send('Runtime.evaluate',{
     expression:'window.isNonameServer === true',returnByValue:true});
    if(r.exceptionDetails||r.result?.value!==true)throw fail('WORKER_NOT_OFFBOARD');
    return Object.freeze({alive:true,offboard:true,pid:child.pid,gameRulesLoaded:false,statePersisted:false});
   },
   async evaluateSeatExperiment(expression){
    // Only for offline tests, never route untrusted client strings here.
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw fail('WORKER_EXPERIMENT_EXCEPTION');
    return r.result?.value;
   },
   async stop(){
    if(closed)return;
    closed=true;
    session.close();
    if(child.exitCode===null&&child.signalCode===null){
     child.kill('SIGTERM');
     const exited=await Promise.race([new Promise(resolve=>child.once('exit',()=>resolve(true))),sleep(2000).then(()=>false)]);
     if(!exited)child.kill('SIGKILL');
    }
    await rm(profile,{recursive:true,force:true});
   }
  });
 }catch(err){
  session?.close();
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await rm(profile,{recursive:true,force:true});
  throw err;
 }
}
