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
// Chromium child processes may still flush profile data after the parent exits.
const removeProfile=profile=>rm(profile,{recursive:true,force:true,maxRetries:30,retryDelay:100});

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
   if(!['Runtime.enable','Runtime.evaluate','Page.enable','Page.navigate','Page.addScriptToEvaluateOnNewDocument'].includes(method))
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

export async function launchV3ChromiumAuthorityWorker({executable,timeoutMs=MAX_WAIT_MS,unsafeTestSandbox=false}={}){
 if(typeof executable!=='string'||!executable.startsWith('/')||!Number.isInteger(timeoutMs)||
    timeoutMs<500||timeoutMs>60000||typeof unsafeTestSandbox!=='boolean')
  throw fail('WORKER_CONFIG_INVALID');
 // Unsafe only in a deliberately opted-in isolated test. No live worker
 // can silently launch without Chromium's process sandbox.
 const unsafe=unsafeTestSandbox&&process.env.V3_ALLOW_SEAT_EXPERIMENT==='1'&&
   process.env.V3_ALLOW_UNSANDBOXED_TESTS==='1';
 if(unsafeTestSandbox&&!unsafe)throw fail('WORKER_UNSANDBOXED_DENIED');
 if(typeof process.getuid==='function'&&process.getuid()===0&&!unsafe)
  throw fail('WORKER_ROOT_SANDBOX_REQUIRED');
 const profile=await mkdtemp(join(tmpdir(),'v3-authority-worker-'));
 let child,session,closed=false,spawnError=null;
 try{
  child=spawn(executable,[
   '--headless=new','--no-first-run','--no-default-browser-check',
   '--disable-extensions','--disable-background-networking',
   '--disable-dev-shm-usage',...(unsafe?['--no-sandbox']:[]),
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
   async loadV3NativeModules({origin}={}){
    if(closed||typeof origin!=='string'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
     throw fail('NATIVE_MODULE_ORIGIN_DENIED');
    const nav=await session.send('Page.navigate',{url:origin+'/v3-native-isolated.html'});
    if(nav.errorText)throw fail('NATIVE_MODULE_NAVIGATION_FAILED');
    const expression=`(async()=>{
      if(window.isNonameServer!==true)throw Error('OFFBOARD_FLAG_MISSING');
      const core=await import('/noname.js');
      const imported=await import('/mode/xingBei.js');
      const mode=imported.default();
      if(!core.game||!core.lib||!core.ui||!core._status||
         mode.name!=='xingBei'||typeof mode.game?.checkResult!=='function'||
         typeof mode.game?.checkOnlineResult!=='function'||
         typeof core.game.randomMapOL!=='function')throw Error('NATIVE_MODE_API_MISSING');
      Object.defineProperty(window,'__v3NativeXingBeiTest',{configurable:false,
        value:Object.freeze({core,mode})});
      return {loaded:true,mode:mode.name,offboard:window.isNonameServer===true,
       nativeGame:typeof core.game.randomMapOL==='function',
       nativeResult:typeof mode.game.checkResult==='function',
       // This is a module-import proof, NOT the game start or engine loops.
       gameLoopStarted:false};
    })()`;
    let out;
    try{out=await session.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})}
    catch{throw fail('NATIVE_MODULE_LOAD_FAILED')}
    if(out.exceptionDetails||out.result?.value?.loaded!==true)throw fail('NATIVE_MODULE_LOAD_FAILED');
    return Object.freeze(out.result.value);
   },
   async connectRoomChannel({roomId,url,secret}={}){
    // Trusted server only. Never evaluate player-supplied JavaScript.
    if(closed||typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)||
       typeof url!=='string'||!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url)||
       typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))
      throw fail('WORKER_BRIDGE_CONFIG_INVALID');
    const cfg=JSON.stringify({roomId,url,secret});
    const script=`(()=>{
      if(window.__v3AuthorityBridge)return false;
      const opts=${cfg};
      const ws=new WebSocket(opts.url);
      let connected=false,seenRoster=false,seatCount=0,revision=-1,bindings=[];
      let choiceOpenResult=null;const deliveryReceipts=[];let nativeChoiceHooks=null;
      ws.addEventListener('open',()=>ws.send(JSON.stringify({
       type:'authority_hello',roomId:opts.roomId,secret:opts.secret
      })));
      ws.addEventListener('message',event=>{
       let msg;try{msg=JSON.parse(event.data)}catch{return}
       if(msg.type==='authority_accepted'&&msg.roomId===opts.roomId)connected=true;
       if(msg.type==='authority_choice_open_result'){
        if(msg.ok===true&&msg.view?.roomId===opts.roomId)choiceOpenResult=msg.view;
        if(msg.view?.source==='native'&&nativeChoiceHooks){
         try{nativeChoiceHooks.opened(msg)}catch{}
        }
       }
       if(msg.type==='authority_choice_delivery'&&connected&&msg.roomId===opts.roomId&&
          Number.isInteger(msg.seat)&&typeof msg.playerId==='string'&&
          typeof msg.ticket==='string'&&/^[a-f0-9]{32}$/.test(msg.ticket)&&
          typeof msg.option==='string'){
        const b=bindings.find(x=>x.seat===msg.seat&&x.playerId===msg.playerId);
        if(b){
         if(msg.source==='native'){
          if(!nativeChoiceHooks)return;
          let consumed=false;
          try{consumed=nativeChoiceHooks.delivered(msg)===true}catch{return}
          if(!consumed)return;
         }
         deliveryReceipts.push(Object.freeze({roomId:opts.roomId,seat:msg.seat,
          playerId:msg.playerId,ticket:msg.ticket,option:msg.option}));
         // Only receipt of delivery. Does NOT unblock or resolve GameEvent.
         ws.send(JSON.stringify({type:'authority_choice_receipt',roomId:opts.roomId,
          seat:msg.seat,playerId:msg.playerId,ticket:msg.ticket,option:msg.option}));
         if(msg.source==='native')
          ws.send(JSON.stringify({type:'authority_choice_native_applied',roomId:opts.roomId,
           seat:msg.seat,playerId:msg.playerId,ticket:msg.ticket,option:msg.option}));
        }
       }
       if(msg.type==='authority_transport_probe'&&connected&&msg.roomId===opts.roomId&&
          typeof msg.traceId==='string'&&/^[a-f0-9]{32}$/.test(msg.traceId)&&
          Number.isInteger(msg.seat)&&typeof msg.playerId==='string'){
        const b=bindings.find(x=>x.seat===msg.seat&&x.playerId===msg.playerId);
        if(b&&b.connectionId!==null)ws.send(JSON.stringify({
          type:'authority_probe_ack',roomId:opts.roomId,
          traceId:msg.traceId,seat:msg.seat,playerId:msg.playerId
        }));
       }
       if(msg.type==='authority_roster'&&msg.view?.roomId===opts.roomId&&
          Array.isArray(msg.view.roster)&&Number.isInteger(msg.view.revision)){
        const next=msg.bindings;
        if(!Array.isArray(next)||next.length!==msg.view.roster.length||
           !next.every(b=>Number.isInteger(b.seat)&&b.seat>=0&&
             typeof b.playerId==='string'&&/^player_[a-f0-9]{32}$/.test(b.playerId)&&
             (b.connectionId===null||typeof b.connectionId==='string'&&/^[a-f0-9]{24}$/.test(b.connectionId))))return;
        const seats=new Set(next.map(b=>b.seat));
        const ids=new Set(next.map(b=>b.playerId));
        if(seats.size!==next.length||ids.size!==next.length)return;
        bindings=next.map(b=>Object.freeze({seat:b.seat,playerId:b.playerId,connectionId:b.connectionId}));
        seenRoster=true;seatCount=msg.view.roster.length;revision=msg.view.revision;
       }
      });
      ws.addEventListener('close',()=>{connected=false});
      ws.addEventListener('error',()=>{connected=false});
      Object.defineProperty(window,'__v3AuthorityBridge',{configurable:false,
        value:Object.freeze({inspect:()=>({connected,seenRoster,seatCount,revision,
         boundPeerCount:bindings.filter(b=>b.connectionId!==null).length}),
         // Used by trusted V3-only native engine bootstrap, never by human clients.
         getSeatBindings:()=>bindings.map(b=>({...b})),
         registerNativeChoiceHooks:hooks=>{
          if(nativeChoiceHooks||!hooks||typeof hooks.opened!=='function'||
             typeof hooks.delivered!=='function')return false;
          nativeChoiceHooks=hooks;
          return true;
         },
         requestNativeChoice:data=>{
          if(!nativeChoiceHooks||!connected||!seenRoster||!data||typeof data!=='object')
           return false;
          const b=bindings.find(x=>x.seat===data.seat);
          if(!b)return false;
          if(data.kind!=='control'||!Array.isArray(data.options))return false;
          ws.send(JSON.stringify({type:'authority_choice_open',source:'native',
            roomId:opts.roomId,seat:b.seat,playerId:b.playerId,
            kind:'control',prompt:data.prompt,options:data.options}));
          return true;
         },
         openChoiceExperiment:data=>{
          if(!connected||!seenRoster||!data||typeof data!=='object')return false;
          const b=bindings.find(x=>x.seat===data.seat);
          if(!b)return false;
          choiceOpenResult=null;
          ws.send(JSON.stringify({type:'authority_choice_open',roomId:opts.roomId,
            seat:b.seat,playerId:b.playerId,kind:data.kind,prompt:data.prompt,options:data.options}));
          return true;
         },
         inspectChoiceExperiment:()=>({opened:choiceOpenResult?{...choiceOpenResult}:null,
          receipts:deliveryReceipts.map(x=>({...x}))})})});
      return true;
    })()`;
    const result=await session.send('Runtime.evaluate',{expression:script,returnByValue:true});
    if(result.exceptionDetails||result.result?.value!==true)throw fail('WORKER_BRIDGE_ATTACH_FAILED');
    for(let i=0;i<100;i++){
     const state=await this.inspectRoomChannel();
     if(state.connected&&state.seenRoster)return state;
     await sleep(50);
    }
    throw fail('WORKER_BRIDGE_HANDSHAKE_TIMEOUT');
   },
   async openChoiceExperiment({seat,kind='control',prompt='選擇一個測試選項',options=['alpha','beta']}={}){
    // Hard gate: only offline CI may request an experimental choice.
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('CHOICE_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7||
       !['character','card','skill','control'].includes(kind)||
       typeof prompt!=='string'||prompt.length<1||prompt.length>120||
       !Array.isArray(options)||options.length<2||options.length>12||
       !options.every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(x)))
      throw fail('CHOICE_EXPERIMENT_INVALID');
    const expression='window.__v3AuthorityBridge?.openChoiceExperiment('+JSON.stringify({seat,kind,prompt,options})+')';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value!==true)throw fail('CHOICE_EXPERIMENT_REJECTED');
    for(let i=0;i<100;i++){
     const state=await this.inspectChoiceExperiment();
     if(state.opened?.ticket)return state.opened;
     await sleep(40);
    }
    throw fail('CHOICE_EXPERIMENT_TIMEOUT');
   },
   async inspectChoiceExperiment(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('CHOICE_EXPERIMENT_DISABLED');
    if(closed||child.exitCode!==null||child.signalCode!==null)throw fail('WORKER_UNAVAILABLE');
    const r=await session.send('Runtime.evaluate',{
     expression:'window.__v3AuthorityBridge?.inspectChoiceExperiment() ?? null',returnByValue:true
    });
    if(r.exceptionDetails||!r.result?.value)throw fail('CHOICE_EXPERIMENT_NOT_READY');
    return r.result.value;
   },
   async inspectRoomChannel(){
    if(closed||child.exitCode!==null||child.signalCode!==null)throw fail('WORKER_UNAVAILABLE');
    const result=await session.send('Runtime.evaluate',{
     expression:'window.__v3AuthorityBridge?.inspect() ?? null',returnByValue:true
    });
    if(result.exceptionDetails||!result.result?.value)throw fail('WORKER_BRIDGE_NOT_READY');
    const state=result.result.value;
    return Object.freeze({connected:state.connected===true,seenRoster:state.seenRoster===true,
      seatCount:state.seatCount,revision:state.revision,
      boundPeerCount:state.boundPeerCount});
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
    await removeProfile(profile);
   }
  });
 }catch(err){
  session?.close();
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await removeProfile(profile);
  throw err;
 }
}
