/**
 * V3-only, in-memory, server-authoritative choice-window prototype.
 * Produces proof-of-delivery receipts, NOT native GameEvent resolution.
 * A worker may open a window, but only the authenticated seat may answer.
 * All state remains owned by the broker and is lost on broker restart.
 */
import {randomBytes} from 'node:crypto';

const ok=(code,more={})=>Object.freeze({ok:true,code,...more});
const no=code=>Object.freeze({ok:false,code});
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
const playerId=x=>typeof x==='string'&&/^player_[a-f0-9]{32}$/.test(x);
const optionId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(x);
const ticket=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
const key=(roomId,seat)=>roomId+':'+seat;
const expose=e=>Object.freeze({roomId:e.roomId,seat:e.seat,playerId:e.playerId,
 ticket:e.ticket,kind:e.kind,prompt:e.prompt,options:[...e.options],
 state:e.state,source:e.source,expiresAt:e.expiresAt});

export function createV3AuthorityChoiceWindows({now=()=>Date.now(),ttlMs=120000,maxOpen=128}={}){
 if(typeof now!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>600000||
    !Number.isSafeInteger(maxOpen)||maxOpen<1||maxOpen>1024)
  throw new TypeError('CHOICE_WINDOW_CONFIG_INVALID');
 const windows=new Map();
 const expire=()=>{
  const ts=now();
  for(const [k,v] of windows)if(ts>=v.expiresAt)windows.delete(k);
 };
 const locate=({roomId,seat,ticket:proof,playerId:pid}={})=>{
  if(!id(roomId)||!Number.isInteger(seat)||seat<0||seat>7||
     !ticket(proof)||!playerId(pid))return null;
  const v=windows.get(key(roomId,seat));
  return v&&v.ticket===proof&&v.playerId===pid?v:null;
 };
 return Object.freeze({
  open({roomId,seat,playerId:pid,kind,prompt,options,source='experiment'}={}){
   expire();
   if(!id(roomId)||!Number.isInteger(seat)||seat<0||seat>7||
      !playerId(pid)||!['character','card','skill','control','target'].includes(kind)||
      (kind==='target'&&source!=='preview')||
      !['experiment','native','preview'].includes(source)||
      typeof prompt!=='string'||prompt.length<1||prompt.length>120||
      /[<>\u0000-\u001f]/.test(prompt)||
      !Array.isArray(options)||options.length<2||options.length>12||
      !options.every(optionId)||new Set(options).size!==options.length)
    return no('CHOICE_DEFINITION_INVALID');
   const k=key(roomId,seat);
   // Retire a previously applied native result before a new event starts.
   if(windows.get(k)?.state==='applied')windows.delete(k);
   if(windows.has(k))return no('CHOICE_WINDOW_ALREADY_OPEN');
   if(windows.size>=maxOpen)return no('CHOICE_CAPACITY_EXCEEDED');
   const e={roomId,seat,playerId:pid,kind,prompt,options:[...options],
    ticket:randomBytes(16).toString('hex'),source,state:'open',
    expiresAt:now()+ttlMs,selection:null,deliveryAcknowledged:false};
   windows.set(k,e);
   return ok('CHOICE_WINDOW_OPENED',{view:expose(e)});
  },
  advancePreview({roomId,seat,playerId:pid,previousTicket,previousOption,
   kind,prompt,options}={}){
   // An authenticated Chromium worker may advance an ACKNOWLEDGED native
   // card preview to a NEW target-preview ticket. The previous card ticket
   // becomes permanently unusable. This is not GameEvent resolution.
   expire();
   const prior=locate({roomId,seat,playerId:pid,ticket:previousTicket});
   if(!prior||prior.source!=='preview'||prior.kind!=='card'||
      prior.state!=='delivered'||prior.selection!==previousOption||
      !prior.options.includes(previousOption)||kind!=='target'||
      typeof prompt!=='string'||prompt.length<1||prompt.length>120||
      /[<>\u0000-\u001f]/.test(prompt)||
      !Array.isArray(options)||options.length<2||options.length>8||
      !options.every(x=>typeof x==='string'&&/^s[0-7]$/.test(x))||
      new Set(options).size!==options.length)
    return no('PREVIEW_ADVANCE_DENIED');
   const k=key(roomId,seat);
   windows.delete(k);
   const next=this.open({roomId,seat,playerId:pid,kind,prompt,options,
    source:'preview'});
   if(!next.ok)windows.set(k,prior);
   return next.ok?ok('PREVIEW_TARGET_WINDOW_OPENED',{view:next.view}):next;
  },
  view(roomId,seat,pid){
   expire();
   const e=windows.get(key(roomId,seat));
   return e&&e.playerId===pid?expose(e):null;
  },
  submit({roomId,seat,playerId:pid,ticket:proof,option}={}){
   expire();
   const e=locate({roomId,seat,playerId:pid,ticket:proof});
   if(!e)return no('CHOICE_WINDOW_NOT_FOUND');
   if(!optionId(option)||!e.options.includes(option))return no('CHOICE_OPTION_NOT_ALLOWED');
   if(e.state==='submitted'){
    return e.selection===option
      ?ok('CHOICE_ALREADY_SUBMITTED',{view:expose(e)})
      :no('CHOICE_ALREADY_LOCKED');
   }
   if(e.state==='delivered'||e.state==='applied')
    return e.selection===option
      ?ok(e.state==='applied'?'CHOICE_ALREADY_APPLIED':'CHOICE_DELIVERED_NOT_APPLIED',{view:expose(e)})
      :no('CHOICE_ALREADY_LOCKED');
   e.state='submitted';e.selection=option;
   return ok('CHOICE_SUBMITTED_NOT_APPLIED',{view:expose(e),delivery:Object.freeze({
    roomId:e.roomId,seat:e.seat,playerId:e.playerId,ticket:e.ticket,option:e.selection,source:e.source
   })});
  },
  deliveryReceipt({roomId,seat,playerId:pid,ticket:proof,option}={}){
   expire();
   const e=locate({roomId,seat,playerId:pid,ticket:proof});
   if(!e||e.state==='open'||e.selection!==option)return no('CHOICE_DELIVERY_DENIED');
   if(e.state==='delivered'||e.state==='applied')return ok('CHOICE_RECEIPT_ALREADY_SEEN',{view:expose(e)});
   e.state='delivered';e.deliveryAcknowledged=true;
   // Do NOT mark resolved; a native GameEvent has not consumed the response.
   return ok('CHOICE_DELIVERED_NOT_APPLIED',{view:expose(e)});
  },
  nativeApplied({roomId,seat,playerId:pid,ticket:proof,option}={}){
   expire();
   const e=locate({roomId,seat,playerId:pid,ticket:proof});
   if(!e||e.source!=='native'||e.selection!==option||e.state==='open'||
      e.state==='submitted')return no('CHOICE_NATIVE_APPLY_DENIED');
   if(e.state==='applied')return ok('CHOICE_ALREADY_APPLIED',{view:expose(e)});
   if(e.state!=='delivered')return no('CHOICE_NATIVE_APPLY_DENIED');
   e.state='applied';
   return ok('CHOICE_NATIVE_APPLIED',{view:expose(e)});
  },
  cancelRoom(roomId){
   let count=0;
   for(const [k,v] of windows)if(v.roomId===roomId){windows.delete(k);count++}
   return count;
  },
  size(){expire();return windows.size}
 });
}
