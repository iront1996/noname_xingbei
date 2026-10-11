/**
 * V3-only transport envelope validation. Never executes a native GameEvent.
 * Gameplay is denied until the server owns rule validation and replay state.
 */
const id=x=>typeof x==='string'&&/^player_[a-f0-9]{32}$/.test(x);
const trace=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
export function validateV3NativeEnvelope({message,roomId,bindings}={}){
 if(!message||typeof message!=='object'||Array.isArray(message)||
    message.type!=='native_player_response'||message.roomId!==roomId||
    !trace(message.traceId)||!Number.isInteger(message.seat)||!id(message.playerId))
  return Object.freeze({ok:false,code:'NATIVE_ENVELOPE_INVALID'});
 if(!Array.isArray(bindings))return Object.freeze({ok:false,code:'NATIVE_ROSTER_NOT_READY'});
 const binding=bindings.find(x=>x.seat===message.seat);
 if(!binding||binding.playerId!==message.playerId||binding.connectionId===null)
  return Object.freeze({ok:false,code:'NATIVE_SESSION_NOT_AUTHORIZED'});
 // Deliberately do not accept arbitrary JS or action payloads.
 if(Object.hasOwn(message,'script')||Object.hasOwn(message,'action')||
    Object.hasOwn(message,'result'))
  return Object.freeze({ok:false,code:'NATIVE_GAMEPLAY_DISABLED'});
 return Object.freeze({ok:true,code:'NATIVE_ENVELOPE_AUTHENTICATED',seat:message.seat,playerId:message.playerId});
}
