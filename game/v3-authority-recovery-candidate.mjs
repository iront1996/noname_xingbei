/**
 * C3d-1: V3-only in-memory, READ-ONLY per-seat recovery candidate projection.
 *
 * Builds upon the existing server-owned atomic private-hand projections.
 * Not a GameEvent snapshot, not an executable replay cut, not a safe resume.
 * No WebSocket route, automatic rejoin, state application, or disk persistence.
 * Callers MUST supply authoritative broker-derived bindings (not client IDs).
 */
export const V3_RECOVERY_CANDIDATE_SCHEMA="xingbei-v3-recovery-candidate-projection-1";
const reply=(ok,code,more={})=>Object.freeze({ok,code,...more});
const roomOk=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
const playerOk=x=>typeof x==="string"&&/^player_[a-f0-9]{32}$/.test(x);
const digestOk=x=>typeof x==="string"&&/^xb-public-v1:[0-9a-f]{16}$/.test(x);
const revisionOk=x=>Number.isSafeInteger(x)&&x>=1;
const own=(v,keys)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&
  Object.keys(v).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(v,k));
const ROSTER_KEYS=["seat","playerId"];
const CANDIDATE_KEYS=["roomId","worker","revision","roster","publicDigest","phaseNumber","currentSeat"];

export function createV3RecoveryCandidateProjections({
  privateHands,choiceWindows,currentWorker,authorize,maxRooms=48
}={}){
  if(typeof privateHands?.get!=="function"||
     typeof choiceWindows?.view!=="function"||
     typeof currentWorker!=="function"||typeof authorize!=="function"||
     !Number.isSafeInteger(maxRooms)||maxRooms<1||maxRooms>256)
    throw new TypeError("RECOVERY_CANDIDATE_DEPENDENCY_INVALID");
  const rooms=new Map();
  const active=roomId=>{try{return currentWorker(roomId)}catch{return null}};
  const approved=binding=>{try{return authorize(binding)===true}catch{return false}};
  const notReady=code=>reply(false,code,{restorable:false,readyToResume:false});

  function assertNoChoice(roomId,roster) {
    try {
      return roster.every(s=>choiceWindows.view(roomId,s.seat,s.playerId)===null);
    }catch{return false}
  }

  return Object.freeze({
    publish(input){
      if(!own(input,CANDIDATE_KEYS))return notReady("CANDIDATE_SHAPE_INVALID");
      const {roomId,worker,revision,roster,publicDigest,phaseNumber,currentSeat}=input;
      if(!roomOk(roomId)||!revisionOk(revision)||
         !Array.isArray(roster)||![4,6,8].includes(roster.length)||
         !digestOk(publicDigest)||!Number.isSafeInteger(phaseNumber)||phaseNumber<0||
         !(currentSeat===null||
           (Number.isInteger(currentSeat)&&currentSeat>=0&&currentSeat<roster.length)))
        return notReady("CANDIDATE_METADATA_INVALID");
      if(!worker||typeof worker!=="object"||active(roomId)!==worker)
        return notReady("CANDIDATE_WORKER_NOT_CURRENT");
      const ids=new Set();
      for(let i=0;i<roster.length;i++){
        const s=roster[i];
        if(!own(s,ROSTER_KEYS)||s.seat!==i||!playerOk(s.playerId)||ids.has(s.playerId))
          return notReady("CANDIDATE_ROSTER_INVALID");
        ids.add(s.playerId);
      }
      if(!assertNoChoice(roomId,roster))
        return notReady("CANDIDATE_CHOICE_IN_FLIGHT");
      // Accept only a single, complete, already committed private-hand revision.
      // Never merge partial seat updates into a snapshot.
      for(const s of roster){
        let hand;
        try{hand=privateHands.get(roomId,s.seat,s.playerId)}catch{return notReady("CANDIDATE_PRIVATE_REVISION_MISSING")}
        if(!hand||hand.revision!==revision||
           !Array.isArray(hand.publicOtherHandCounts)||
           hand.publicOtherHandCounts.length!==roster.length)
          return notReady("CANDIDATE_PRIVATE_REVISION_MISSING");
      }
      const old=rooms.get(roomId);
      if(old && (old.worker!==worker||revision<=old.revision))
        return notReady("CANDIDATE_STALE_OR_WORKER_CHANGED");
      if(!old&&rooms.size>=maxRooms)return notReady("CANDIDATE_ROOM_LIMIT");
      // Store public metadata only; hidden cards remain in the V3 private store.
      rooms.set(roomId,{
        worker,revision,roomId,publicDigest,phaseNumber,currentSeat,
        roster:roster.map(s=>Object.freeze({seat:s.seat,playerId:s.playerId}))
      });
      return reply(true,"CANDIDATE_METADATA_STORED",{
        schema:V3_RECOVERY_CANDIDATE_SCHEMA,revision,seatCount:roster.length,
        restorable:false,readyToResume:false
      });
    },
    project({roomId,seat,playerId,connectionId,expectedRevision}={}){
      if(!roomOk(roomId)||!Number.isInteger(seat)||seat<0||seat>7||
         !playerOk(playerId)||typeof connectionId!=="string"||!connectionId||
         connectionId.length>128||!revisionOk(expectedRevision))
        return notReady("CANDIDATE_REQUEST_INVALID");
      const cut=rooms.get(roomId);
      if(!cut)return notReady("CANDIDATE_NOT_FOUND");
      if(cut.worker!==active(roomId))return notReady("CANDIDATE_WORKER_NOT_CURRENT");
      if(cut.revision!==expectedRevision)return notReady("CANDIDATE_STALE_REVISION");
      const claim=cut.roster[seat];
      if(!claim||claim.seat!==seat||claim.playerId!==playerId||
         !approved({roomId,seat,playerId,connectionId}))
        return notReady("CANDIDATE_SEAT_NOT_AUTHORIZED");
      if(!assertNoChoice(roomId,cut.roster))
        return notReady("CANDIDATE_CHOICE_IN_FLIGHT");
      let hand;
      try{hand=privateHands.get(roomId,seat,playerId)}catch{return notReady("CANDIDATE_PRIVATE_REVISION_MISSING")}
      if(!hand||hand.revision!==cut.revision||
         !Array.isArray(hand.ownHand)||
         !Array.isArray(hand.publicOtherHandCounts)||
         hand.publicOtherHandCounts.length!==cut.roster.length)
        return notReady("CANDIDATE_PRIVATE_REVISION_MISSING");
      // Explicit whitelist. Other seats' hidden cards, deck order, RNG,
      // timers, choice tickets, credentials and skill storage never escape.
      const ownHand=Object.freeze(hand.ownHand.map(c=>Object.freeze({
        cardId:c.cardId,name:c.name
      })));
      const publicHandCounts=Object.freeze(hand.publicOtherHandCounts.map(c=>
        Object.freeze({seat:c.seat,handCount:c.handCount})));
      const view=Object.freeze({
        schema:V3_RECOVERY_CANDIDATE_SCHEMA,
        roomId,seat,revision:cut.revision,phaseNumber:cut.phaseNumber,
        currentSeat:cut.currentSeat,publicDigest:cut.publicDigest,
        character:hand.character,ownHand,publicOtherHandCounts:publicHandCounts,
        captureKind:"read_only_candidate",
        eventContinuationCaptured:false,fullGameStateCaptured:false,
        restorable:false,readyToResume:false
      });
      return reply(true,"CANDIDATE_READ_ONLY",{
        view,restorable:false,readyToResume:false
      });
    },
    clearRoom(roomId){
      if(!roomOk(roomId))return false;
      return rooms.delete(roomId);
    },
    size(){return rooms.size}
  });
}
