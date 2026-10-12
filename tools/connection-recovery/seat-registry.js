'use strict';
/**
 * Room-scoped guest seat recovery. Public onlineKey and WebSocket/player IDs
 * are NOT bearer credentials. Never report transport takeover as game sync.
 */
const crypto = require('crypto');
function createSeatRegistry({now=Date.now,randomBytes=crypto.randomBytes,graceMs=600000}={}) {
  if (!Number.isSafeInteger(graceMs) || graceMs<1000) throw Error('invalid grace');
  const rooms=new WeakMap();
  function entries(room) {
    let seats=rooms.get(room);
    if(!seats){ seats=new Map(); rooms.set(room,seats); }
    return seats;
  }
  function tokenDigest(token) {
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/i.test(token))return null;
    return crypto.createHash('sha256').update(Buffer.from(token,'hex')).digest();
  }
  function issue(room,socket) {
    if(!room || !socket || room.owner===socket || socket.owner!==room.owner ||
       socket.room!==room || typeof socket.wsid!=='string' ||
       typeof socket.onlineKey!=='string' || !socket.onlineKey)return null;
    const seats=entries(room);
    if(seats.has(socket.wsid))return null;
    const token=randomBytes(32).toString('hex');
    seats.set(socket.wsid,{id:socket.wsid,digest:tokenDigest(token),
      onlineKey:socket.onlineKey,current:socket,offlineAt:null,
      nickname:socket.nickname,avatar:socket.avatar});
    return {roomId:room.key,seatId:socket.wsid,token};
  }
  function drop(room,socket) {
    const rec=rooms.get(room)?.get(socket?.wsid);
    if(rec && rec.current===socket){
      rec.current=null;rec.offlineAt=now();return true;
    }
    return false;
  }
  function eligible(room,incoming,seatId,token){
    if(!room || !room.owner || room.paused || room.resuming ||
       !incoming || incoming.room || incoming.owner ||
       typeof incoming.onlineKey!=='string' || !incoming.onlineKey ||
       typeof seatId!=='string' || typeof room.key!=='string')return null;
    const rec=rooms.get(room)?.get(seatId), digest=tokenDigest(token);
    if(!rec || !digest || rec.onlineKey!==incoming.onlineKey ||
       rec.digest.length!==digest.length || !crypto.timingSafeEqual(rec.digest,digest))return null;
    if(rec.offlineAt!==null && now()-rec.offlineAt>graceMs)return null;
    return rec;
  }
  function adopt(room,incoming,seatId,token){
    const rec=eligible(room,incoming,seatId,token);
    if(!rec)return null;
    const old=rec.current;
    rec.current=incoming;rec.offlineAt=null;
    return {oldSocket:old,stableSeatId:rec.id,nickname:rec.nickname,avatar:rec.avatar};
  }
  function revoke(room,seatId){return rooms.get(room)?.delete(seatId)||false;}
  return {issue,drop,eligible,adopt,revoke};
}
module.exports={createSeatRegistry};
