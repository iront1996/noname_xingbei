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
    this.onSuspect=onSuspect;this.phaseNow=phaseNow;this.sequence=0;this.probeSerial=0;this.clients=new Map();
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
      suspect:false,phaseSuspect:false
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
  get(seatId) {
    const r=this.clients.get(seatId);
    if(!r)return null;
    return {acknowledgedSequence:r.lastAckSeq,hostSequence:this.sequence,
      lastAckAgeMs:this.now()-r.lastAckAt,suspect:r.suspect,phaseSuspect:r.phaseSuspect};
  }
  dispose(){
    if(this.timer!==null)this.unschedule(this.timer);
    this.timer=null;this.clients.clear();this.sequence=0;this.probeSerial=0;
  }
}
