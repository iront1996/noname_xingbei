"use strict";
/**
 * V2-5: broker-process progress observer independent of a human host tab.
 * Not a game-state authority. No gameplay mutation, network transmission,
 * session token, hidden game state or player card information.
 */
function createHallProgressWatch({now=Date.now,missingMs=70000,quietMs=120000,onAdvisory=()=>{}}={}){
  if(!Number.isSafeInteger(missingMs)||missingMs<30000||
     !Number.isSafeInteger(quietMs)||quietMs<missingMs)
    throw Error("invalid observation windows");
  const rooms=new Map();
  function emit(entry){try{onAdvisory(entry)}catch(_){}}
  function forget(room){return rooms.delete(room)}
  function ownerClosed(room,socket){
    const rec=rooms.get(room);
    if(!rec||rec.owner!==socket)return false;
    emit({kind:"host_socket_closed",roomId:rec.roomId,transportOpen:false});
    rooms.delete(room);
    return true;
  }
  function report(room,socket,protocol,sequence,phase,pendingChoices,paused,active){
    if(!room||room.owner!==socket||!socket||socket.room!==room||
       protocol!==1||!Number.isSafeInteger(sequence)||sequence<0||
       !Number.isSafeInteger(phase)||phase<0||phase>10000000||
       !Number.isSafeInteger(pendingChoices)||pendingChoices<0||pendingChoices>64||
       typeof paused!=="boolean"||typeof active!=="boolean")return false;
    if(!active||room.config?.gameStarted!==true){
      forget(room);return true;
    }
    const current=now(),previous=rooms.get(room);
    if(previous&&previous.owner===socket&&
       (sequence<previous.sequence||phase<previous.phase))return false;
    const progressed=!!previous&&previous.owner===socket&&
       (sequence>previous.sequence||phase>previous.phase);
    const rec=previous&&previous.owner===socket?previous:{
      owner:socket,roomId:room.key,sequence,phase,
      changedAt:current,lastReportAt:current,
      missingReported:false,quietReported:false
    };
    if(progressed||current-rec.lastReportAt>=missingMs){
      rec.changedAt=current;rec.quietReported=false;
    }
    rec.sequence=sequence;rec.phase=phase;rec.pendingChoices=pendingChoices;
    rec.paused=paused;rec.lastReportAt=current;rec.missingReported=false;
    rooms.set(room,rec);
    return true;
  }
  function check(){
    const current=now();
    for(const [room,rec] of rooms){
      if(room.owner!==rec.owner||room.config?.gameStarted!==true){
        rooms.delete(room);continue;
      }
      if(rec.owner.readyState!==1){
        ownerClosed(room,rec.owner);continue;
      }
      if(current-rec.lastReportAt>=missingMs){
        if(!rec.missingReported){
          rec.missingReported=true;
          emit({kind:"host_app_report_missing_socket_open",roomId:rec.roomId,
            silentMs:Math.floor(current-rec.lastReportAt),transportOpen:true});
        }
        continue;
      }
      if(!rec.paused&&rec.pendingChoices===0&&
         current-rec.changedAt>=quietMs&&!rec.quietReported){
        rec.quietReported=true;
        emit({kind:"host_progress_quiet_unverified",roomId:rec.roomId,
          quietMs:Math.floor(current-rec.changedAt),transportOpen:true});
      }
    }
  }
  function snapshot(room){
    const r=rooms.get(room);
    return r?{sequence:r.sequence,phase:r.phase,pendingChoices:r.pendingChoices,
      paused:r.paused,lastReportAgeMs:Math.max(0,now()-r.lastReportAt)}:null;
  }
  return {report,check,forget,ownerClosed,snapshot};
}
module.exports={createHallProgressWatch};
