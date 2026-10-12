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
      let nativeSelectionPreviewHooks=null;
      const previewLeases=new Map();
      const privateHandAcks=new Map();
      ws.addEventListener('open',()=>ws.send(JSON.stringify({
       type:'authority_hello',roomId:opts.roomId,secret:opts.secret
      })));
      ws.addEventListener('message',event=>{
       let msg;try{msg=JSON.parse(event.data)}catch{return}
       if(msg.type==='authority_accepted'&&msg.roomId===opts.roomId)connected=true;
       if(msg.type==='authority_private_hand_stored'&&connected&&
          Number.isInteger(msg.seat)&&typeof msg.playerId==='string'&&
          Number.isSafeInteger(msg.revision)&&msg.revision>=1&&
          msg.code==='PRIVATE_PROJECTION_STORED'){
        const b=bindings.find(x=>x.seat===msg.seat&&x.playerId===msg.playerId);
        if(b)privateHandAcks.set(msg.seat,msg.revision);
       }
       if(msg.type==='authority_choice_open_result'){
        if(msg.ok===true&&msg.view?.roomId===opts.roomId)choiceOpenResult=msg.view;
        if(msg.view?.source==='native'&&nativeChoiceHooks){
         try{nativeChoiceHooks.opened(msg)}catch{}
        }
        if(msg.view?.source==='preview'&&nativeSelectionPreviewHooks){
         try{
          if(nativeSelectionPreviewHooks.opened(msg)===true&&
             msg.ok===true&&msg.view.roomId===opts.roomId&&
             /^[a-f0-9]{32}$/.test(msg.view.ticket)){
           previewLeases.set(msg.view.seat,Object.freeze({
            seat:msg.view.seat,playerId:msg.view.playerId,
            ticket:msg.view.ticket
           }));
          }
         }catch{}
        }
       }
       if(msg.type==='authority_choice_delivery'&&connected&&msg.roomId===opts.roomId&&
          Number.isInteger(msg.seat)&&typeof msg.playerId==='string'&&
          typeof msg.ticket==='string'&&/^[a-f0-9]{32}$/.test(msg.ticket)&&
          typeof msg.option==='string'&&
          typeof msg.connectionId==='string'&&
          /^[a-f0-9]{24}$/.test(msg.connectionId)){
        // A seat's stable Player ID survives reconnect; its socket
        // generation does NOT. Late delivery from a revoked session
        // must not consume an action on the replacement session.
        const b=bindings.find(x=>x.seat===msg.seat&&
         x.playerId===msg.playerId&&
         x.connectionId===msg.connectionId);
        if(b){
         if(msg.source==='native'){
          if(!nativeChoiceHooks)return;
          let consumed=false;
          try{consumed=nativeChoiceHooks.delivered(msg)===true}catch{return}
          if(!consumed)return;
         }
         if(msg.source==='preview'){
          if(!nativeSelectionPreviewHooks)return;
          let recorded=false;
          try{recorded=nativeSelectionPreviewHooks.delivered(msg)===true}catch{return}
          if(!recorded)return;
         }
         deliveryReceipts.push(Object.freeze({roomId:opts.roomId,seat:msg.seat,
          playerId:msg.playerId,ticket:msg.ticket,option:msg.option}));
         // Only receipt of delivery. Does NOT unblock or resolve GameEvent.
         ws.send(JSON.stringify({type:'authority_choice_receipt',roomId:opts.roomId,
          seat:msg.seat,playerId:msg.playerId,ticket:msg.ticket,option:msg.option}));
         if(msg.source==='native')
          ws.send(JSON.stringify({type:'authority_choice_native_applied',roomId:opts.roomId,
           seat:msg.seat,playerId:msg.playerId,ticket:msg.ticket,option:msg.option}));
         if(msg.source==='preview'&&msg.option==='pass')
          ws.send(JSON.stringify({type:'authority_choice_preview_pass_applied',
           roomId:opts.roomId,seat:msg.seat,playerId:msg.playerId,
           ticket:msg.ticket}));
         if(msg.source==='preview'&&/^v3card_[a-f0-9]{6}$/.test(msg.option)){
          // The previous receipt was sent first on this same ordered
          // authenticated WS. Only the original paused native event may
          // request the next read-only target candidate window.
          try{
           const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
           native?.beginNativeUsePrintedTargetPreview({
            seat:msg.seat,playerId:msg.playerId,previousTicket:msg.ticket
           });
          }catch{}
         }
        }
       }
       if(msg.type==='authority_action_ownership_probe'&&connected&&
          msg.roomId===opts.roomId&&
          typeof msg.traceId==='string'&&/^[a-f0-9]{32}$/.test(msg.traceId)&&
          Number.isInteger(msg.seat)&&msg.seat>=0&&msg.seat<8&&
          typeof msg.playerId==='string'&&/^player_[a-f0-9]{32}$/.test(msg.playerId)&&
          typeof msg.cardId==='string'&&/^v3card_[a-f0-9]{6}$/.test(msg.cardId)){
        const binding=bindings.find(x=>x.seat===msg.seat&&
         x.playerId===msg.playerId&&x.connectionId!==null);
        if(binding){
         let owned=false;
         try{
          const session=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
          owned=session?.preflightNativeActionCardOwnership({
           seat:msg.seat,playerId:msg.playerId,cardId:msg.cardId
          })?.ownedByActivePlayer===true;
         }catch{owned=false}
         ws.send(JSON.stringify({type:'authority_action_ownership_result',
          roomId:opts.roomId,traceId:msg.traceId,seat:msg.seat,
          playerId:msg.playerId,owned}));
        }
       }
       if(msg.type==='authority_action_target_probe'&&connected&&
          msg.roomId===opts.roomId&&
          typeof msg.traceId==='string'&&/^[a-f0-9]{32}$/.test(msg.traceId)&&
          Number.isInteger(msg.seat)&&msg.seat>=0&&msg.seat<8&&
          Number.isInteger(msg.targetSeat)&&msg.targetSeat>=0&&msg.targetSeat<8&&
          typeof msg.playerId==='string'&&/^player_[a-f0-9]{32}$/.test(msg.playerId)&&
          typeof msg.cardId==='string'&&/^v3card_[a-f0-9]{6}$/.test(msg.cardId)){
        const binding=bindings.find(x=>x.seat===msg.seat&&
         x.playerId===msg.playerId&&x.connectionId!==null);
        if(binding){
         let printedTargetEligible=false,supportedPrintedAttack=false;
         try{
          const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
          const check=native?.preflightNativePrintedAttackTarget({
           seat:msg.seat,playerId:msg.playerId,cardId:msg.cardId,
           targetSeat:msg.targetSeat
          });
          printedTargetEligible=check?.printedTargetEligible===true;
          supportedPrintedAttack=check?.supportedPrintedAttack===true;
         }catch{}
         ws.send(JSON.stringify({type:'authority_action_target_result',
          roomId:opts.roomId,traceId:msg.traceId,seat:msg.seat,
          playerId:msg.playerId,targetSeat:msg.targetSeat,
          printedTargetEligible,supportedPrintedAttack}));
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
        // Native V3 Client identity persists while the transport changes.
        if(nativeChoiceHooks&&typeof nativeChoiceHooks.roster==='function'){
         try{nativeChoiceHooks.roster(bindings.map(x=>({...x})))}catch{}
        }
       }
      });
      ws.addEventListener('close',()=>{connected=false;previewLeases.clear()});
      ws.addEventListener('error',()=>{connected=false});
      // Only the live authenticated offboard worker renews pending
      // previews; human disconnects do not affect that authority lease.
      const renewPreviewLeases=()=>{
       if(!connected||!seenRoster||ws.readyState!==WebSocket.OPEN)return false;
       for(const p of previewLeases.values()){
        const bound=bindings.find(b=>b.seat===p.seat&&b.playerId===p.playerId);
        if(!bound)continue;
        ws.send(JSON.stringify({type:'authority_choice_renew',roomId:opts.roomId,
         seat:p.seat,playerId:p.playerId,ticket:p.ticket}));
       }
       return true;
      };
      setInterval(renewPreviewLeases,25000);
      Object.defineProperty(window,'__v3AuthorityBridge',{configurable:false,
        value:Object.freeze({${process.env.V3_ALLOW_SEAT_EXPERIMENT==='1' ? "testDisconnectChannel:()=>{ws.close(4000,'CI_channel_drop');return true;},testRenewPreviewLeases:()=>renewPreviewLeases(),inspectPreviewLeaseCount:()=>previewLeases.size," : ""}inspect:()=>({connected,seenRoster,seatCount,revision,
         boundPeerCount:bindings.filter(b=>b.connectionId!==null).length}),
         // Used by trusted V3-only native engine bootstrap, never by human clients.
         getSeatBindings:()=>bindings.map(b=>({...b})),
         publishNativeOpeningHands:()=>{
          if(!connected||!seenRoster)return false;
          const game=window.__v3NativeXingBeiTest?.core?.game;
          const native=game?.__v3NativeSeatSession;
          if(!native||native.inspect().startingCardsDealt!==true||
             native.inspect().characterCount!==bindings.length)return false;
          privateHandAcks.clear();
          for(const b of bindings){
           const own=native.privateSeatView({seat:b.seat});
           if(own.playerId!==b.playerId)return false;
           ws.send(JSON.stringify({type:'authority_private_hand',
            roomId:opts.roomId,seat:b.seat,playerId:b.playerId,
            revision:1,character:own.character,
            ownHand:own.ownHand,
            publicOtherHandCounts:own.publicOtherHandCounts
           }));
          }
          return true;
         },
         inspectPrivateHandAcks:()=>({
          count:privateHandAcks.size,
          seats:Array.from(privateHandAcks.keys()).sort((a,b)=>a-b)
         }),
         registerNativeChoiceHooks:hooks=>{
          if(nativeChoiceHooks||!hooks||typeof hooks.opened!=='function'||
             typeof hooks.delivered!=='function')return false;
          nativeChoiceHooks=hooks;
          return true;
         },
         registerNativeSelectionPreviewHooks:hooks=>{
          if(nativeSelectionPreviewHooks||!hooks||
             typeof hooks.opened!=='function'||typeof hooks.delivered!=='function')
           return false;
          nativeSelectionPreviewHooks=hooks;
          return true;
         },
         requestNativeSelectionPreview:data=>{
          if(!nativeSelectionPreviewHooks||!connected||!seenRoster||
             !data||!['card','target'].includes(data.kind)||
             !Array.isArray(data.options)||data.options.length<2||
             data.options.length>(data.kind==='target'?8:12)||
             !data.options.every((id,index)=>typeof id==='string'&&
              (data.kind==='card'?
               /^v3card_[a-f0-9]{6}$/.test(id)||
                (id==='pass'&&index===data.options.length-1):
               /^s[0-7]$/.test(id)))||
             new Set(data.options).size!==data.options.length)
           return false;
          if(data.kind==='target'&&
             (typeof data.previousTicket!=='string'||
              !/^[a-f0-9]{32}$/.test(data.previousTicket)||
              typeof data.previousOption!=='string'||
              !/^v3card_[a-f0-9]{6}$/.test(data.previousOption)))
           return false;
          const b=bindings.find(x=>x.seat===data.seat&&x.connectionId!==null);
          if(!b)return false;
          ws.send(JSON.stringify({type:'authority_choice_open',source:'preview',
           roomId:opts.roomId,seat:b.seat,playerId:b.playerId,
           kind:data.kind,prompt:data.prompt,options:data.options,
           ...(data.kind==='target'?{previousTicket:data.previousTicket,
            previousOption:data.previousOption}:{})}));
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
   async restoreTrustedOpeningCheckpoint({checkpoint,roomId}={}){
    // Trusted CI-host recovery only; not available to human WS clients.
    // Node caller must verify authenticated checkpoint and exact Player IDs.
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed||!checkpoint||typeof checkpoint!=='object'||
       typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)||
       checkpoint.roomId!==roomId||
       ![4,6,8].includes(checkpoint.players?.length))
     throw fail('V3_TRUSTED_OPENING_RESTORE_DENIED');
    const restore=async ({checkpoint,roomId})=>{
     try{
      if(window.isNonameServer!==true||
         !window.__v3AuthorityBridge?.inspect()?.seenRoster||
         !window.__v3AuthorityBridge?.inspect()?.connected)
       throw Error('V3_RESTORE_UNTRUSTED_CHROMIUM');
      const {core}=window.__v3NativeXingBeiTest;
      const stageModule=await import('/game/v3-native-xingbei-content-stager.mjs');
      const seatsModule=await import('/game/v3-native-xingbei-seat-session.mjs');
      const pack=await stageModule.stageV3NativeXingBeiContent({core});
      const seats=seatsModule.prepareV3NativeXingBeiSeats({
       core,bridge:window.__v3AuthorityBridge
      });
      const result=seats.restoreOpeningCheckpoint({checkpoint,roomId});
      return {ok:true,pack:pack.realSource,result,roster:seats.roster()};
     }catch(e){
      return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)};
     }
    };
    const expression='('+restore.toString()+')('+JSON.stringify({checkpoint,roomId})+')';
    const r=await session.send('Runtime.evaluate',{
     expression,awaitPromise:true,returnByValue:true
    });
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_TRUSTED_OPENING_RESTORE_FAILED_'+String(r.result?.value?.code??'CDP'));
    return Object.freeze(r.result.value);
   },
   async stageNativeXingBeiSeats(){
    // Explicit offboard test staging only. The real game start remains disabled.
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression=`(async()=>{
     try{
      if(window.isNonameServer!==true||
         !window.__v3AuthorityBridge?.inspect()?.seenRoster||
         !window.__v3NativeXingBeiTest)return {ok:false,code:'NATIVE_SEAT_BRIDGE_NOT_READY'};
      const {core}=window.__v3NativeXingBeiTest;
      const stageModule=await import('/game/v3-native-xingbei-content-stager.mjs');
      const seatsModule=await import('/game/v3-native-xingbei-seat-session.mjs');
      const pack=await stageModule.stageV3NativeXingBeiContent({core});
      const session=seatsModule.prepareV3NativeXingBeiSeats({
       core,bridge:window.__v3AuthorityBridge
      });
      return {ok:true,pack,session:session.inspect(),roster:session.roster(),
       characters:core.game.__v3NativeContentStage.rosterChoices()};
     }catch(e){
      return {ok:false,code:String(e?.code??e?.message??e).slice(0,100),
       trace:String(e?.stack??'').slice(0,300)};
     }
    })()`;
    const r=await session.send('Runtime.evaluate',{
     expression,awaitPromise:true,returnByValue:true
    });
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_SEAT_STAGE_FAILED_'+String(r.result?.value?.code??'CDP_EXCEPTION'));
    return Object.freeze(r.result.value);
   },
   async beginNativeCharacterDraft({seat,offers}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7||
       !Array.isArray(offers)||offers.length<2||offers.length>12||
       !offers.every(x=>typeof x==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(x)))
     throw fail('V3_DRAFT_TEST_INVALID');
    const args=JSON.stringify({seat,offers});
    const expression=`(()=>{
     try{
      const s=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return s?{ok:true,choice:s.beginCharacterDraft(${args})}:
       {ok:false,code:'V3_DRAFT_SESSION_NOT_READY'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_DRAFT_START_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.choice;
   },
   async commitNativeCharacterDraft({seat}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7)throw fail('V3_DRAFT_TEST_INVALID');
    const expression=`(()=>{
     try{
      const s=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return s?{ok:true,result:s.commitCharacterDraft({seat:${seat}})}:
       {ok:false,code:'V3_DRAFT_SESSION_NOT_READY'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_DRAFT_COMMIT_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async publishNativeOpeningHands(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='window.__v3AuthorityBridge?.publishNativeOpeningHands()??false';
    const result=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(result.exceptionDetails||result.result?.value!==true)
     throw fail('V3_PRIVATE_NATIVE_HAND_PUBLISH_DENIED');
    for(let i=0;i<120;i++){
     const result=await session.send('Runtime.evaluate',{
      expression:'window.__v3AuthorityBridge.inspectPrivateHandAcks()',
      returnByValue:true
     });
     const stats=result.result?.value;
     const target=(await this.inspectNativeXingBeiSeats()).session.seatCount;
     if(stats?.count===target)return stats;
     await sleep(40);
    }
    throw fail('V3_PRIVATE_NATIVE_HAND_PUBLISH_TIMEOUT');
   },
   async dealNativeOpeningCardsByOriginalEvent(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression=`(async()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:await native.dealOpeningCardsNative()}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_REAL_OPENING_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async dealNativeOpeningCards(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    const expression=`(()=>{
     try{
      const s=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return s?{ok:true,result:s.dealOpeningCards()}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_OPENING_DEAL_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async startPausedNativePhaseLoop(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression=`(()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:native.startPausedFirstNativePhase()}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_PHASE_START_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async releaseOriginalPhaseToActionGate(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.releaseOriginalPhaseToActionGate()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_ACTION_GATE_RELEASE_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async releaseOriginalActionToSelectionGate(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.releaseOriginalActionToSelectionGate()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_SELECTION_RELEASE_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async releaseNextOriginalActionToSelectionGate(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.releaseNextOriginalActionToSelectionGate()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_NEXT_SELECTION_RELEASE_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async releaseNextOriginalSelectionToNativeWait(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.releaseNextOriginalSelectionToNativeWait()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_NEXT_ORIGINAL_WAIT_RELEASE_FAILED_'+
      String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async releaseOriginalSelectionToNativeWait(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.releaseOriginalSelectionToNativeWait()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{
     expression,returnByValue:true
    });
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_ORIGINAL_WAIT_RELEASE_FAILED_'+
      String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async beginNativeUseCardPreview({seat,playerId}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed||!Number.isInteger(seat)||seat<0||seat>7||
       typeof playerId!=='string'||!/^player_[a-f0-9]{32}$/.test(playerId))
     throw fail('V3_NATIVE_USE_PREVIEW_DENIED');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.beginNativeUseCardPreview('+JSON.stringify({seat,playerId})+')}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_USE_PREVIEW_DENIED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async inspectNativeUseCardPreview(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.inspectNativeUseCardPreview()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_USE_PREVIEW_INSPECT_FAILED');
    return r.result.value.result;
   },
   async preflightNativeActionCardOwnership({seat,playerId,cardId}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed||!Number.isInteger(seat)||seat<0||seat>7||
       typeof playerId!=='string'||!/^player_[a-f0-9]{32}$/.test(playerId)||
       typeof cardId!=='string'||!/^v3card_[a-f0-9]{6}$/.test(cardId))
     throw fail('V3_NATIVE_CARD_OWNERSHIP_DENIED');
    const args=JSON.stringify({seat,playerId,cardId});
    const inspect=({seat,playerId,cardId})=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:native.preflightNativeActionCardOwnership({
       seat,playerId,cardId
      })}:{ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch{return {ok:false,code:'V3_NATIVE_CARD_OWNERSHIP_DENIED'}}
    };
    const expression='('+inspect.toString()+')('+args+')';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_CARD_OWNERSHIP_DENIED');
    return r.result.value.result;
   },
   async preflightNativePrintedAttackTarget({seat,playerId,cardId,targetSeat}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed||!Number.isInteger(seat)||seat<0||seat>7||
       !Number.isInteger(targetSeat)||targetSeat<0||targetSeat>7||
       typeof playerId!=='string'||!/^player_[a-f0-9]{32}$/.test(playerId)||
       typeof cardId!=='string'||!/^v3card_[a-f0-9]{6}$/.test(cardId))
     throw fail('V3_NATIVE_ATTACK_TARGET_DENIED');
    const args=JSON.stringify({seat,playerId,cardId,targetSeat});
    const inspect=({seat,playerId,cardId,targetSeat})=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:native.preflightNativePrintedAttackTarget({
       seat,playerId,cardId,targetSeat
      })}:{ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch{return {ok:false,code:'V3_NATIVE_ATTACK_TARGET_DENIED'}}
    };
    const r=await session.send('Runtime.evaluate',{
     expression:'('+inspect.toString()+')('+args+')',returnByValue:true
    });
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_ATTACK_TARGET_DENIED');
    return r.result.value.result;
   },
   async inspectOriginalSelectionGate(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.inspectOriginalSelectionGate()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_SELECTION_INSPECT_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async inspectOriginalActionGate(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression='(()=>{try{const n=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return n?{ok:true,result:n.inspectOriginalActionGate()}:{ok:false,code:"V3_NATIVE_SEAT_SESSION_MISSING"}}catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}})()';
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_ACTION_GATE_INSPECT_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async inspectPausedNativePhaseLoop(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression=`(()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:native.inspectPausedFirstNativePhase()}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_PHASE_INSPECT_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async probeNativeFirstPhaseSetup(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')
     throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression=`(()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:native.probeNativeFirstPhaseSetup()}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){
      return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)};
     }
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_FIRST_PHASE_SETUP_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async probeNativeOriginalGameDraw(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const expression=`(async()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:await native.probeNativeGameDrawExecution()}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){
      return {ok:false,code:String(e?.code??e?.message??e).slice(0,100),
       reason:String(e?.cause?.stack??e?.stack??'').slice(0,400)};
     }
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true){
     // Offline CI only. Constrain diagnostic content to a safe error prefix;
     // do not echo server secrets, card IDs, or raw player supplied input.
     const safe=String(r.result?.value?.reason??'UNSPECIFIED')
      .replace(/[^A-Za-z0-9_ ]/g,'_').slice(0,180);
     throw fail('V3_REAL_GAME_DRAW_FAILED_'+String(r.result?.value?.code??'CDP')+'_'+safe);
    }
    return r.result.value.result;
   },
   async stageNativeOpeningTurnBoundary({firstSeat=0}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(firstSeat)||firstSeat<0||firstSeat>7)
     throw fail('V3_TURN_BOUNDARY_SEAT_INVALID');
    const expression=`(async()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,result:await native.stageOpeningTurnBoundary({firstSeat:${firstSeat}})}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_TURN_BOUNDARY_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async exportNativeOpeningCheckpoint({roomId,revision=1}={}){
    // Trusted offline integration only. Contains ALL private hands.
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(typeof roomId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)||
       !Number.isSafeInteger(revision)||revision<1)
     throw fail('V3_CHECKPOINT_REQUEST_INVALID');
    const expression=`(()=>{
     try{
      const native=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return native?{ok:true,value:native.exportOpeningCheckpoint(${JSON.stringify({roomId,revision})})}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_CHECKPOINT_EXPORT_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.value;
   },
   async inspectNativePrivateHand({seat}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7)throw fail('V3_PRIVATE_VIEW_TEST_INVALID');
    const expression=`(()=>{
     try{
      const s=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;
      return s?{ok:true,result:s.privateSeatView({seat:${seat}})}:
       {ok:false,code:'V3_NATIVE_SEAT_SESSION_MISSING'};
     }catch(e){return {ok:false,code:String(e?.code??e?.message??e).slice(0,100)}}
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)
     throw fail('V3_NATIVE_PRIVATE_VIEW_FAILED_'+String(r.result?.value?.code??'CDP'));
    return r.result.value.result;
   },
   async inspectNativeXingBeiSeats(){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const r=await session.send('Runtime.evaluate',{
     expression:'(()=>{const s=window.__v3NativeXingBeiTest?.core?.game?.__v3NativeSeatSession;return s?{session:s.inspect(),roster:s.roster()}:null})()',
     returnByValue:true
    });
    if(r.exceptionDetails||!r.result?.value)throw fail('V3_NATIVE_SEAT_STAGE_NOT_READY');
    return r.result.value;
   },
   async beginNativeChoiceExperiment({seat,controls=['guard','evade'],prompt='請選擇防禦方式'}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7||
       !Array.isArray(controls)||controls.length<2||controls.length>12||
       !controls.every(x=>typeof x==='string'&&x.length>0&&x.length<=80)||
       new Set(controls).size!==controls.length||
       typeof prompt!=='string'||prompt.length<1||prompt.length>120||
       /[<>\u0000-\u001f]/.test(prompt))throw fail('NATIVE_CHOICE_TEST_INVALID');
    const args=JSON.stringify({seat,controls,prompt});
    const expression=`(async()=>{
      if(window.isNonameServer!==true||!window.__v3AuthorityBridge||
         !window.__v3NativeXingBeiTest)return {ok:false,error:'NOT_READY'};
      const cfg=${args};
      const bridge=window.__v3AuthorityBridge;
      const b=bridge.getSeatBindings().find(x=>x.seat===cfg.seat);
      if(!b)return {ok:false,error:'SEAT_NOT_BOUND'};
      const {core}=window.__v3NativeXingBeiTest;
      const game=core.game,lib=core.lib,status=core._status;
      if(!game.__v3NativeWaitAdapter){
       const module=await import('/game/v3-native-event-wait-adapter.mjs');
       module.installV3NativeEventWaitAdapter({core,bridge});
      }
      if(!lib.node)lib.node={};
      if(!lib.node.torespond)lib.node.torespond={};
      if(!lib.node.torespondtimeout)lib.node.torespondtimeout={};
      if(!lib.playerOL)lib.playerOL={};
      if(!window.__v3NativeEventTestSessions)
       window.__v3NativeEventTestSessions=new Map();
      let record=window.__v3NativeEventTestSessions.get(cfg.seat);
      if(!record){
       const p=document.createElement('div');
       Object.setPrototypeOf(p,lib.element.Player.prototype);
       p.playerid=b.playerId;
       p.hideTimer=()=>{};
       p.showTimer=()=>{};
       const ws=new lib.element.Client({wsid:b.playerId,send(){},close(){}},true);
       p.ws=ws;
       lib.playerOL[b.playerId]=p;
       game.__v3NativeWaitAdapter.registerPlayer({seat:cfg.seat,player:p,client:ws});
       record={player:p,client:ws,event:null};
       window.__v3NativeEventTestSessions.set(cfg.seat,record);
      }
      if(record.player.playerid!==b.playerId)return {ok:false,error:'PLAYER_ID_CHANGED'};
      const event=new lib.element.GameEvent('chooseControl',false);
      event.player=record.player;
      event.controls=cfg.controls;
      event.prompt=cfg.prompt;
      status.eventManager.rootEvent=event;
      record.event=event;
      event.send();
      return {ok:true,nativeInstance:event instanceof lib.element.GameEvent,
       nativePlayer:record.player instanceof lib.element.Player,
       paused:status.paused===true,
       pending:game.__v3NativeWaitAdapter.inspect().pending,
       waitSlot:lib.node.torespond[b.playerId],
       noAITimer:Object.keys(lib.node.torespondtimeout).length===0,
       playerId:b.playerId,seat:b.seat};
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails||r.result?.value?.ok!==true)throw fail('NATIVE_CHOICE_TEST_START_FAILED');
    return r.result.value;
   },
   async inspectNativeChoiceExperiment({seat}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7)throw fail('NATIVE_CHOICE_TEST_INVALID');
    const expression=`(()=>{
      const session=window.__v3NativeEventTestSessions?.get(${seat});
      const {core}=window.__v3NativeXingBeiTest??{};
      const adapter=core?.game?.__v3NativeWaitAdapter;
      if(!session||!adapter)return null;
      return {nativeResult:session.event?.result??null,
       nativeResultOL:session.event?.resultOL??null,
       nativePaused:core._status.paused===true,
       waiting:core.lib.node.torespond[session.player.playerid]??null,
       closed:session.client.closed===true,
       adapter:adapter.inspect()};
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||!r.result?.value)throw fail('NATIVE_CHOICE_TEST_INSPECT_FAILED');
    return r.result.value;
   },
   async simulateNativeClientClose({seat}={}){
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(!Number.isInteger(seat)||seat<0||seat>7)throw fail('NATIVE_CHOICE_TEST_INVALID');
    const expression=`(()=>{
      const session=window.__v3NativeEventTestSessions?.get(${seat});
      if(!session)return false;
      session.client.close();
      return true;
    })()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});
    if(r.exceptionDetails||r.result?.value!==true)throw fail('NATIVE_CHOICE_TEST_CLIENT_CLOSE_FAILED');
    return true;
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
   async simulateRoomChannelLoss(){
    // Strictly server-held CI control; never exposed to human WebSockets.
    if(process.env.V3_ALLOW_SEAT_EXPERIMENT!=='1')throw fail('WORKER_EXPERIMENT_DISABLED');
    if(closed)throw fail('WORKER_UNAVAILABLE');
    const result=await session.send('Runtime.evaluate',{
     expression:'window.__v3AuthorityBridge?.testDisconnectChannel?.() === true',returnByValue:true
    });
    if(result.exceptionDetails||result.result?.value!==true)
     throw fail('WORKER_CHANNEL_TEST_DROP_FAILED');
    return true;
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
