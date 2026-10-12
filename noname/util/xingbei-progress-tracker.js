/**
 * C3: host-owned gameplay message progress sampling.
 *
 * A client acknowledgement only proves that its WebSocket message handler
 * reached the probe; it does NOT prove the full asynchronous game engine
 * successfully applied prior events. Never treat a probe ACK as a snapshot.
 */
export class XingbeiProgressTracker {
  constructor({now=Date.now,setIntervalFn=setInterval,clearIntervalFn=clearInterval,
    intervalMs=15000,staleMs=90000,minPending=3,phaseNow=()=>null,onSuspect=()=>{}}={}) {
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error("bad interval");
    if(!Number.isSafeInteger(staleMs)||staleMs<=intervalMs)throw new Error("bad stale timeout");
    this.now=now;this.schedule=setIntervalFn;this.unschedule=clearIntervalFn;
    this.intervalMs=intervalMs;this.staleMs=staleMs;this.minPending=minPending;
    this.onSuspect=onSuspect;this.phaseNow=phaseNow;this.sequence=0;this.probeSerial=0;this.checkpointSerial=0;this.clients=new Map();
    this.timer=null;
  }
  broadcastAdvanced() {
    if(this.clients.size) this.sequence++;
  }
  bind(seatId,client,send,{phase=null}={}) {
    if(typeof seatId!=="string"||!seatId||!client||typeof send!=="function")return false;
    const existing=this.clients.get(seatId);
    // A renewed transport requires a fresh observation window; retain no
    // ACK state from an obsolete connection at the same player seat.
    if(existing?.client===client)return true;
    this.clients.set(seatId,{
      client,send,startedAt:this.now(),lastAckAt:this.now(),
      lastAckSeq:this.sequence,lastSentSeq:this.sequence,
      lastProbeAt:0,lastProbeId:0,lastAckProbeId:0,phase,clientPhase:null,phaseLagStreak:0,
      suspect:false,phaseSuspect:false,
      checkpoint:null,checkpointFirstUnackedAt:null,checkpointSuspect:false,checkpointMismatchCount:0,
      fingerprintMismatchCount:0,lastPublicFingerprintVerified:false
    });
    if(this.timer===null)this.timer=this.schedule(()=>this.probe(),this.intervalMs);
    return true;
  }
  forget(seatId,client) {
    const old=this.clients.get(seatId);
    if(!old||old.client!==client)return false;
    this.clients.delete(seatId);
    if(!this.clients.size && this.timer!==null){this.unschedule(this.timer);this.timer=null;}
    return true;
  }
  probe() {
    const time=this.now();
    const phase=this.phaseNow();
    for(const [seatId,rec] of this.clients) {
      if(rec.client.closed||rec.client.inited!==true){
        this.forget(seatId,rec.client);continue;
      }
      if(rec.checkpoint && rec.checkpointFirstUnackedAt!==null &&
         time-rec.checkpointFirstUnackedAt>=this.staleMs && !rec.checkpointSuspect){
        rec.checkpointSuspect=true;
        try{this.onSuspect({seatId,kind:"state_checkpoint_unconfirmed",
          checkpointId:rec.checkpoint.id,ageMs:time-rec.checkpointFirstUnackedAt});}catch(_){}
      }
      const behind=this.sequence-rec.lastAckSeq;
      if(behind>=this.minPending && time-rec.lastAckAt>=this.staleMs && !rec.suspect){
        rec.suspect=true;
        try{this.onSuspect({seatId,kind:"message_processing_stalled",pending:behind,ageMs:time-rec.lastAckAt});}catch(_){}
      }
      // Sequence identifies the latest broadcast *issued by the host*,
      // not the number of actions applied by this client.
      try {
        rec.lastSentSeq=this.sequence;
        rec.lastProbeAt=time;
        rec.phase=Number.isSafeInteger(phase)&&phase>=0?phase:null;
        rec.lastProbeId=++this.probeSerial;
        rec.send(rec.lastProbeId,this.sequence,rec.phase);
      } catch(_){/* transport close handler owns reconnection */}
    }
  }
  acknowledge(seatId,client,probeId,sequence,clientPhase=null) {
    const rec=this.clients.get(seatId);
    if(!rec||rec.client!==client||rec.client.closed||rec.client.inited!==true)return false;
    // Probe ID prevents replayed ACKs from refreshing a stale connection.
    if(!Number.isSafeInteger(probeId)||probeId<=rec.lastAckProbeId ||
       probeId!==rec.lastProbeId)return false;
    if(!Number.isSafeInteger(sequence)||sequence!==rec.lastSentSeq ||
       sequence<rec.lastAckSeq)return false;
    rec.lastAckProbeId=probeId;
    rec.lastAckSeq=sequence;
    rec.lastAckAt=this.now();
    rec.suspect=false;
    rec.clientPhase=Number.isSafeInteger(clientPhase)&&clientPhase>=0?clientPhase:null;
    // Phase divergence is diagnostic only: older clients may intentionally
    // render asynchronous phases after host state transitions.
    if(rec.phase!==null && rec.clientPhase!==null && rec.clientPhase+1<rec.phase){
      rec.phaseLagStreak++;
      if(rec.phaseLagStreak>=3&&!rec.phaseSuspect){
        rec.phaseSuspect=true;
        try{this.onSuspect({seatId,kind:"game_phase_behind",hostPhase:rec.phase,clientPhase:rec.clientPhase});}catch(_){}
      }
    }else{rec.phaseLagStreak=0;rec.phaseSuspect=false;}
    return true;
  }
  /**
   * Issue an authoritative checkpoint AFTER the host has captured the state
   * fields that its existing syncState broadcast will apply to each client.
   * This is a semantic checkpoint, not proof every asynchronous choice ended.
   */
  issueCheckpoint(phase,currentSeatId=null,publicDigest=null) {
    if(!Number.isSafeInteger(phase)||phase<0)return null;
    if(currentSeatId!==null && (typeof currentSeatId!=="string" || !currentSeatId))return null;
    const data={id:++this.checkpointSerial,phase,currentSeatId};
    // Optional C3c diagnostic; older C3b clients can ignore this field.
    if(typeof publicDigest==="string" && /^xb-public-v1:[0-9a-f]{16}$/.test(publicDigest))
      data.publicDigest=publicDigest;
    for(const [,rec] of this.clients) {
      if(rec.client.closed||rec.client.inited!==true)continue;
      rec.checkpoint=data;
      if(rec.checkpointFirstUnackedAt===null)rec.checkpointFirstUnackedAt=this.now();
    }
    return data;
  }
  acknowledgeCheckpoint(seatId,client,checkpointId,appliedPhase,appliedSeatId=null,publicDigest=null) {
    const rec=this.clients.get(seatId);
    if(!rec||rec.client!==client||rec.client.closed||rec.client.inited!==true ||
       !rec.checkpoint||rec.checkpoint.id!==checkpointId)return false;
    if(!Number.isSafeInteger(appliedPhase)||appliedPhase<0||
       (appliedSeatId!==null && (typeof appliedSeatId!=="string"||!appliedSeatId)))return false;
    const expected=rec.checkpoint;
    if(appliedPhase!==expected.phase||appliedSeatId!==expected.currentSeatId){
      rec.checkpointMismatchCount++;
      try{this.onSuspect({seatId,kind:"state_checkpoint_mismatch",checkpointId,
        expectedPhase:expected.phase,appliedPhase,
        expectedSeatId:expected.currentSeatId,appliedSeatId});}catch(_){}
      return false;
    }
    // A legacy ACK has no digest: accept its phase/seat check, but never
    // report it as verified. C3c must not break existing C3b clients.
    if(expected.publicDigest && publicDigest!==null &&
       publicDigest!==expected.publicDigest){
      rec.fingerprintMismatchCount++;
      rec.lastPublicFingerprintVerified=false;
      try{this.onSuspect({seatId,kind:"state_public_digest_mismatch",checkpointId,
        expectedDigest:expected.publicDigest,appliedDigest:publicDigest});}catch(_){}
      return false;
    }
    rec.lastPublicFingerprintVerified=Boolean(expected.publicDigest &&
      publicDigest===expected.publicDigest);
    rec.checkpoint=null;
    rec.checkpointFirstUnackedAt=null;
    rec.checkpointSuspect=false;
    return true;
  }
  get(seatId) {
    const r=this.clients.get(seatId);
    if(!r)return null;
    return {acknowledgedSequence:r.lastAckSeq,hostSequence:this.sequence,
      lastAckAgeMs:this.now()-r.lastAckAt,suspect:r.suspect,phaseSuspect:r.phaseSuspect,
      pendingCheckpointId:r.checkpoint?.id??null,checkpointSuspect:r.checkpointSuspect,
      checkpointMismatchCount:r.checkpointMismatchCount,
      fingerprintMismatchCount:r.fingerprintMismatchCount,
      lastPublicFingerprintVerified:r.lastPublicFingerprintVerified};
  }
  dispose(){
    if(this.timer!==null)this.unschedule(this.timer);
    this.timer=null;this.clients.clear();this.sequence=0;this.probeSerial=0;this.checkpointSerial=0;
  }
}
