/**
 * V3-only memory-backed per-seat native hand projections.
 *
 * The trusted Chromium provides only the owning player's cards, while every
 * seat may see other seats' hand counts. All snapshots are cloned, validated
 * and versioned by the V3 server. No snapshot/recovery claim.
 */
const ok=(code,rest={})=>Object.freeze({ok:true,code,...rest});
const no=code=>Object.freeze({ok:false,code});
const roomOk=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
const playerOk=s=>typeof s==='string'&&/^player_[a-f0-9]{32}$/.test(s);
const cardIdOk=s=>typeof s==='string'&&/^v3card_[a-f0-9]{6}$/.test(s);
const cardNameOk=s=>typeof s==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(s);
const seatOk=s=>Number.isInteger(s)&&s>=0&&s<8;
const view=e=>Object.freeze({
 roomId:e.roomId,seat:e.seat,playerId:e.playerId,revision:e.revision,
 character:e.character,
 ownHand:e.ownHand.map(c=>Object.freeze({...c})),
 publicOtherHandCounts:e.publicOtherHandCounts.map(x=>Object.freeze({...x}))
});

export function createV3AuthorityPrivateProjections({maxRooms=50,maxCards=100}={}){
 if(!Number.isSafeInteger(maxRooms)||maxRooms<1||maxRooms>500||
    !Number.isSafeInteger(maxCards)||maxCards<4||maxCards>500)
  throw new TypeError('PRIVATE_PROJECTION_CONFIG_INVALID');
 const rooms=new Map();
 return Object.freeze({
  publish({roomId,seat,playerId,revision,character,ownHand,publicOtherHandCounts}={}){
   if(!roomOk(roomId)||!seatOk(seat)||!playerOk(playerId)||
      !Number.isSafeInteger(revision)||revision<1||
      !cardNameOk(character)||
      !Array.isArray(ownHand)||ownHand.length>maxCards||
      !ownHand.every(c=>c&&typeof c==='object'&&!Array.isArray(c)&&
       cardIdOk(c.cardId)&&cardNameOk(c.name))||
      new Set(ownHand.map(c=>c.cardId)).size!==ownHand.length||
      !Array.isArray(publicOtherHandCounts)||
      ![4,6,8].includes(publicOtherHandCounts.length)||
      !publicOtherHandCounts.every((x,i)=>x&&x.seat===i&&
       Number.isSafeInteger(x.handCount)&&x.handCount>=0&&x.handCount<=maxCards)||
      seat>=publicOtherHandCounts.length||
      publicOtherHandCounts[seat].handCount!==ownHand.length)
    return no('PRIVATE_PROJECTION_INVALID');
   let room=rooms.get(roomId);
   if(!room){
    if(rooms.size>=maxRooms)return no('PRIVATE_PROJECTION_ROOM_LIMIT');
    room=new Map();rooms.set(roomId,room);
   }
   const old=room.get(seat);
   if(old&&(old.playerId!==playerId||
      revision<=old.revision))
    return no('PRIVATE_PROJECTION_STALE_OR_ID_MISMATCH');
   for(const [otherSeat,other] of room){
    if(otherSeat===seat)continue;
    const occupied=new Set(other.ownHand.map(c=>c.cardId));
    if(ownHand.some(c=>occupied.has(c.cardId)))
     return no('PRIVATE_PROJECTION_CARD_OWNERSHIP_CONFLICT');
   }
   const entry={roomId,seat,playerId,revision,character,
    ownHand:ownHand.map(c=>({cardId:c.cardId,name:c.name})),
    publicOtherHandCounts:publicOtherHandCounts.map(x=>({seat:x.seat,handCount:x.handCount}))};
   room.set(seat,entry);
   return ok('PRIVATE_PROJECTION_STORED',{view:view(entry)});
  },
  get(roomId,seat,playerId){
   if(!roomOk(roomId)||!seatOk(seat)||!playerOk(playerId))return null;
   const entry=rooms.get(roomId)?.get(seat);
   return entry?.playerId===playerId?view(entry):null;
  },
  clearRoom(roomId){return rooms.delete(roomId)},
  size(){return Array.from(rooms.values()).reduce((n,m)=>n+m.size,0)}
 });
}
