/**
 * V3-only native GameEvent chooseControl experiment.
 *
 * Patches prototypes IN THE OFF-BOARD CHROMIUM PROCESS ONLY. Never edits
 * noname/ source or V1/V2 clients. Real GameEvent/Player.unwait code is used,
 * but ONLY chooseControl with an allowlisted choice is permitted.
 * This is not a complete rules-engine bootstrap or crash recovery.
 */
const failure=code=>Object.assign(new Error(code),{code});
const goodId=x=>typeof x==='string'&&/^player_[a-f0-9]{32}$/.test(x);
const goodPrompt=x=>typeof x==='string'&&x.length>=1&&x.length<=120&&!/[<>\u0000-\u001f]/.test(x);
const legalControls=x=>Array.isArray(x)&&x.length>=2&&x.length<=12&&
 x.every(s=>typeof s==='string'&&s.length>0&&s.length<=80)&&new Set(x).size===x.length;

export function installV3NativeEventWaitAdapter({core,bridge}={}){
 if(typeof window==='undefined'||window.isNonameServer!==true||
    !core||!core.game||!core.lib||!core._status||
    typeof bridge?.getSeatBindings!=='function'||
    typeof bridge?.requestNativeChoice!=='function'||
    typeof bridge?.registerNativeChoiceHooks!=='function')
  throw failure('V3_NATIVE_ADAPTER_NOT_OFFBOARD');
 const {game,lib,_status}=core;
 const Client=lib.element?.Client,Player=lib.element?.Player,GameEvent=lib.element?.GameEvent;
 if(!Client?.prototype||!Player?.prototype||!GameEvent?.prototype||
    typeof game.pause!=='function'||typeof game.resume!=='function')
  throw failure('V3_NATIVE_CLASSES_UNAVAILABLE');
 if(game.__v3NativeWaitAdapter)throw failure('V3_NATIVE_ADAPTER_ALREADY_INSTALLED');
 const original={
  close:Client.prototype.close,
  wait:Player.prototype.wait,
  unwait:Player.prototype.unwait,
  send:GameEvent.prototype.send
 };
 if(Object.values(original).some(f=>typeof f!=='function'))throw failure('V3_NATIVE_METHOD_MISSING');
 const registered=new Map(),pending=new Map();
 let allowConsume=null,alive=true,consumed=0,interrupted=0;
 let armedOriginalUseWait=null,originalUseWaitReached=0,originalUsePassApplied=0;
 let waitingOriginalUse=null;
 const binding=seat=>bridge.getSeatBindings().find(b=>b.seat===seat);
 const requireActive=()=>{if(!alive)throw failure('V3_NATIVE_ADAPTER_STOPPED')};
 const boundPlayer=p=>goodId(p?.playerid)&&registered.get(p.playerid)?.player===p;
 const isValidClient=c=>goodId(c?.id)&&registered.get(c.id)?.client===c;
 // Native Client.close ordinarily invokes player.unwait("ai"). Do not allow
 // disconnect to alter the authoritative in-flight event result.
 Client.prototype.close=function(){
  requireActive();
  if(!isValidClient(this))
   throw failure('V3_NATIVE_UNKNOWN_CLIENT_CLOSE');
  this.closed=true;
  return this;
 };
 // Native Player.wait starts a timeout that forces 'ai' and closes a socket.
 // Store the REAL engine's waiting slot but never arm client-owned timers.
 Player.prototype.wait=function(callback){
  requireActive();
  if(!boundPlayer(this))throw failure('V3_NATIVE_UNKNOWN_PLAYER_WAIT');
  if(!lib.node?.torespond||!lib.node?.torespondtimeout)
   throw failure('V3_NATIVE_NODE_NOT_INITIALIZED');
  const existing=lib.node.torespond[this.playerid];
  if(existing!==undefined&&existing!=='_noname_waiting')
   throw failure('V3_NATIVE_ALREADY_WAITING');
  if(typeof callback==='function'){
   callback._noname_waiting=true;
   lib.node.torespond[this.playerid]=callback;
  }else lib.node.torespond[this.playerid]='_noname_waiting';
  return this;
 };
 // Keep native unwait semantics (including GameEvent.resultOL and resume)
 // but ONLY a verified broker choice delivery can invoke it.
 Player.prototype.unwait=function(value){
  requireActive();
  if(!boundPlayer(this))throw failure('V3_NATIVE_UNKNOWN_PLAYER_UNWAIT');
  if(allowConsume!==this.playerid)throw failure('V3_NATIVE_UNWAIT_DENIED');
  return original.unwait.call(this,value);
 };
 GameEvent.prototype.send=function(){
  requireActive();
  if(armedOriginalUseWait?.event===this){
   // This is the unique, previously paused ORIGINAL XingBei action
   // GameEvent. Do not invoke legacy GameEvent.send/Player.send, which
   // would transmit executable client-side JavaScript.
   const pendingUse=armedOriginalUseWait;
   armedOriginalUseWait=null; // A one-shot privilege, never reusable.
   const player=this.player,reg=registered.get(player?.playerid);
   const gate=game.__v3PausedPhaseRuntime;
   const second=gate?.nextSelectionContentReleased===true;
   const expected=second?gate.nextSelectionEvent:gate?.selectionEvent;
   if(this.name!=='gongJiOrFaShu'||!boundPlayer(player)||
      this.content?.compiled!==true||
      this.content?.original!=='chooseToUse'&&
       this.content?.original!==lib.element.content.chooseToUse||
      !reg||reg.seat!==pendingUse.seat||
      player.playerid!==pendingUse.playerId||
      binding(reg.seat)?.playerId!==pendingUse.playerId||
      expected!==this||
      pending.size!==0||!lib.node?.torespond)
    throw failure('V3_NATIVE_ORIGINAL_USE_WAIT_DENIED');
   // The genuine chooseToUse step 0 has already called onChooseToUse
   // and now reached event.send() in its online branch.
   // Hold the real engine BEFORE step 1/2 can useResult or consume cards.
   player.wait();
   game.pause();
   if(second)gate.nextOriginalUseWaitReached=true;
   else gate.originalUseWaitReached=true;
   waitingOriginalUse={seat:reg.seat,playerId:player.playerid,event:this};
   try{
    const native=game.__v3NativeSeatSession;
    const started=native?.beginNativeUseCardPreview({
     seat:reg.seat,playerId:player.playerid,allowPass:true
    });
    if(started?.started!==true)
     throw failure('V3_NATIVE_ORIGINAL_USE_PREVIEW_UNAVAILABLE');
    originalUseWaitReached++;
    return this;
   }catch(e){
    waitingOriginalUse=null;
    if(second)gate.nextOriginalUseWaitReached=false;
    else gate.originalUseWaitReached=false;
    if(lib.node.torespond?.[player.playerid]==='_noname_waiting')
     delete lib.node.torespond[player.playerid];
    // Never resume this event on any malformed or unsupported condition.
    throw e;
   }
  }
  if(this.name!=='chooseControl'||!boundPlayer(this.player))
   throw failure('V3_NATIVE_EVENT_UNSUPPORTED');
  const player=this.player,reg=registered.get(player.playerid);
  const choices=this.controls;
  // The original engine exposes one global pause/event result slot.
  // Serialise native choice windows until a real multi-event scheduler exists.
  if(!legalControls(choices)||pending.size!==0)
   throw failure('V3_NATIVE_CHOICE_INVALID_OR_PENDING');
  const current=binding(reg.seat);
  if(!current||current.playerId!==player.playerid)
   throw failure('V3_NATIVE_SESSION_STALE');
  if(!lib.node?.torespond||!lib.node?.torespondtimeout)
   throw failure('V3_NATIVE_NODE_NOT_INITIALIZED');
  const prompt=goodPrompt(this.prompt)?this.prompt:'請選擇一項操作';
  const safeOptions=choices.map((_,i)=>'o'+i);
  const record={event:this,seat:reg.seat,playerId:player.playerid,player,
   options:[...choices],tickets:safeOptions,ticket:null,applied:false};
  pending.set(reg.seat,record);
  try{
   player.wait();
   game.pause();
   const accepted=bridge.requestNativeChoice({
    seat:reg.seat,kind:'control',prompt,options:safeOptions
   });
   if(accepted!==true)throw failure('V3_NATIVE_CHOICE_NOT_ROUTED');
   return this;
  }catch(e){
   pending.delete(reg.seat);
   if(lib.node.torespond?.[player.playerid]==='_noname_waiting')
    delete lib.node.torespond[player.playerid];
   game.resume();
   throw e;
  }
 };
 const hooked=bridge.registerNativeChoiceHooks({
  roster(currentBindings){
   if(!alive||!Array.isArray(currentBindings))return;
   for(const [pid,reg] of registered){
    const b=currentBindings.find(x=>x.seat===reg.seat&&x.playerId===pid);
    // No AI fallback, timeout, or GameEvent result modification.
    reg.client.closed=(!b||b.connectionId===null);
    reg.client.inited=!!b?.connectionId;
   }
  },
  opened(message){
   const view=message?.view;
   if(!message?.ok||view?.source!=='native')return false;
   const p=pending.get(view.seat);
   if(!p||p.playerId!==view.playerId||p.ticket!==null||
      view.kind!=='control'||view.state!=='open'||
      JSON.stringify(view.options)!==JSON.stringify(p.tickets))
    return false;
   p.ticket=view.ticket;
   return true;
  },
  delivered(message){
   const p=pending.get(message?.seat);
   if(!p||p.applied||!p.ticket||p.ticket!==message.ticket||
      p.playerId!==message.playerId||!p.tickets.includes(message.option)||
      binding(p.seat)?.playerId!==p.playerId)
    return false;
   const index=p.tickets.indexOf(message.option);
   const result={control:p.options[index],index};
   // Consume through native Player.unwait(), not a simulated callback.
   allowConsume=p.playerId;
   try{p.player.unwait(result)}
   finally{allowConsume=null}
   p.applied=true;
   pending.delete(p.seat);
   consumed++;
   return true;
  },
  interrupted(){
   // No loss of state is claimed. The native event stays paused until a
   // future, separately designed worker-state recovery protocol exists.
   interrupted++;
  }
 });
 if(hooked!==true){
  Client.prototype.close=original.close;
  Player.prototype.wait=original.wait;
  Player.prototype.unwait=original.unwait;
  GameEvent.prototype.send=original.send;
  throw failure('V3_NATIVE_CHOICE_HOOKS_UNAVAILABLE');
 }
 const adapter=Object.freeze({
  consumeOriginalUsePass({seat,playerId:pid,event}={}){
   requireActive();
   const p=registered.get(pid),wait=waitingOriginalUse;
   const gate=game.__v3PausedPhaseRuntime;
   const second=gate?.nextSelectionContentReleased===true;
   if(!wait||!p||p.seat!==seat||wait.seat!==seat||
      wait.playerId!==pid||wait.event!==event||
      p.player!==event?.player||!_status.paused||
      _status.event!==event||event.forced===true||
      event.content?.compiled!==true||
      (second?gate.nextSelectionEvent:gate?.selectionEvent)!==event||
      (second?gate.nextOriginalUseWaitReached:
       gate?.originalUseWaitReached)!==true||
      lib.node?.torespond?.[pid]!=='_noname_waiting'||
      binding(seat)?.playerId!==pid||
      originalUsePassApplied!==(second?1:0))
    throw failure('V3_NATIVE_ORIGINAL_PASS_DENIED');
   waitingOriginalUse=null;originalUsePassApplied++;
   allowConsume=pid;
   try{p.player.unwait({bool:false})}
   finally{allowConsume=null}
   return Object.freeze({nativePassApplied:true,cardConsumed:false,
    actionExecuted:false});
  },
  armOriginalUseWait({seat,playerId:pid,event}={}){
   requireActive();
   const p=registered.get(pid),b=binding(seat);
   const gate=game.__v3PausedPhaseRuntime;
   const second=gate?.nextSelectionContentReleased===true;
   if(!Number.isInteger(seat)||!goodId(pid)||!p||
      p.seat!==seat||p.player?.playerid!==pid||
      b?.playerId!==pid||b.connectionId===null||
      event?.name!=='gongJiOrFaShu'||event.player!==p.player||
      event.content?.compiled!==true||
      !(event.content.original==='chooseToUse'||
        event.content.original===lib.element.content.chooseToUse)||
      !_status.paused||armedOriginalUseWait!==null||
      (second?gate.nextSelectionEvent:gate?.selectionEvent)!==event||
      (second?originalUsePassApplied!==1:originalUsePassApplied!==0)||
      pending.size!==0)
    throw failure('V3_NATIVE_ORIGINAL_USE_ARM_DENIED');
   armedOriginalUseWait={seat,playerId:pid,event};
   return Object.freeze({armed:true,nativeEvent:true,seat,playerId:pid});
  },
  registerPlayer({seat,player,client}={}){
   requireActive();
   const b=binding(seat);
   if(!Number.isInteger(seat)||!b||!goodId(b.playerId)||
      player?.playerid!==b.playerId||client?.id!==b.playerId||
      !(player instanceof Player)||!(client instanceof Client)||
      registered.has(b.playerId))
    throw failure('V3_NATIVE_PLAYER_REGISTRATION_DENIED');
   client.closed=b.connectionId===null;
   client.inited=b.connectionId!==null;
   registered.set(b.playerId,{seat,player,client});
   return b.playerId;
  },
  inspect(){
   return Object.freeze({active:alive,registered:registered.size,pending:pending.size,
    consumed,interrupted,paused:_status.paused===true,
    armedOriginalUseWait:armedOriginalUseWait!==null,
    originalUseWaitReached,originalUsePassApplied,
    waitingOriginalUse:waitingOriginalUse!==null,
    connectedPlayers:Array.from(registered.values()).filter(v=>!v.client.closed).length,
    waitingCount:lib.node?.torespond?Object.keys(lib.node.torespond).length:0});
  }
 });
 Object.defineProperty(game,'__v3NativeWaitAdapter',{
  configurable:false,enumerable:false,value:adapter
 });
 return adapter;
}
