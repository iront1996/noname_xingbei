import {saveSeatCredentials,loadSeatCredentials,clearSeatCredentials} from "./xingbei-seat-credentials.js";
/**
 * Browser guest-reclaim wire protocol; no game-engine or DOM mutations.
 * Return true when the message has been consumed and MUST NOT reach roomlist().
 */
export function handleSeatRecoveryControl(message,{state,storage,endpoint,onlineKey,version,send}) {
  if(!Array.isArray(message))return false;
  if(message[0]==="xbSeatCredentials"){
    saveSeatCredentials(storage,endpoint,message[1],message[2],message[3]);
    return true;
  }
  const recovery=state?._xingbeiRecovery;
  if(!recovery?.active)return false;
  if(message[0]==="roomlist"){
    const seat=loadSeatCredentials(storage,endpoint);
    if(!seat || seat.roomId!==state.roomId || seat.seatId!==state.onlineID){
      recovery.reject("missing_seat_credentials");
      state._xingbeiSuppressRecovery=true;
      return true;
    }
    if(!state._xingbeiReclaimRequested){
      state._xingbeiReclaimRequested=true;
      try{
        send("server","key",[onlineKey,version]);
        send("server","xbResumeSeat",seat.roomId,seat.seatId,seat.token);
      }catch(_){
        state._xingbeiReclaimRequested=false;
        recovery.connectionLost();
      }
    }
    return true;
  }
  if(message[0]==="xbSeatReclaimed"){
    // The broker's acknowledgement must correspond to this socket's
    // outbound reclaim request, in the current connection's SYNCING phase.
    // A late/unsolicited packet cannot unlock a host game-state rebuild.
    if(!state._xingbeiReclaimRequested || recovery.phase!=="SYNCING")return true;
    if(message[1]===state.roomId && message[2]===state.onlineID){
      state._xingbeiSeatReclaimed=true;
    }else{
      recovery.reject("seat_mismatch");
      state._xingbeiSuppressRecovery=true;
    }
    return true;
  }
  if(message[0]==="xbSeatResumeRejected"){
    // Do not invalidate credentials on an unsolicited/stale rejection.
    if(!state._xingbeiReclaimRequested || recovery.phase!=="SYNCING")return true;
    recovery.reject("seat_rejected");
    state._xingbeiSuppressRecovery=true;
    clearSeatCredentials(storage,endpoint);
    return true;
  }
  return false;
}
