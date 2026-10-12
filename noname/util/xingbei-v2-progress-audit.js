/**
 * V2 host-side progress diagnostics only.
 * Neither WebSocket ACKs nor a quiet turn imply successful or failed GameEvent
 * execution. No state restoration, forced AI, disconnection or network sends.
 */
export class V2ProgressAudit {
  constructor({now=Date.now,quietMs=120000,choiceGraceMs=12000,onSignal=()=>{}}={}) {
    if(!Number.isSafeInteger(quietMs)||quietMs<30000)throw Error("bad quiet threshold");
    if(!Number.isSafeInteger(choiceGraceMs)||choiceGraceMs<0)throw Error("bad choice grace");
    this.now=now;this.quietMs=quietMs;this.choiceGraceMs=choiceGraceMs;
    this.onSignal=onSignal;this.quiet=null;this.choiceReports=new Map();
  }
  emit(data) {
    // Structured minimal metadata only: no token, card, private hand, socket,
    // raw choice payload, nickname, event stack or stored game snapshot.
    try{this.onSignal(data)}catch(_){}
  }
  observe({seatId,client,hostSequence,phase,lastAckAgeMs,
    gameStarted=false,hostPaused=false,pendingChoiceCount=null,
    waitingChoice=false,choiceLease=null}={}) {
    const now=this.now();
    // Only a currently initialized, explicitly supplied trusted host seat.
    if(typeof seatId!=="string"||!seatId||!client||client.closed||
       client.inited!==true||gameStarted!==true) return false;
    if(!Number.isSafeInteger(hostSequence)||hostSequence<0)return false;
    const validPhase=Number.isSafeInteger(phase)&&phase>=0?phase:null;
    const ackAge=Number.isFinite(lastAckAgeMs)&&lastAckAgeMs>=0?
      Math.floor(lastAckAgeMs):null;
    // A running C3 ACK means only the message handler executed.
    const responsive=ackAge!==null&&ackAge<=45000;
    const lease=choiceLease?.state==="WAITING"&&
      Number.isFinite(choiceLease.deadlineAt)?choiceLease:null;
    if(waitingChoice===true&&lease&&now>=lease.deadlineAt+this.choiceGraceMs) {
      if(this.choiceReports.get(seatId)!==lease) {
        this.choiceReports.set(seatId,lease);
        this.emit({kind:"choice_deadline_overrun_advisory",seatId,
          overdueMs:Math.max(0,Math.floor(now-lease.deadlineAt)),
          transportAckFresh:responsive,ackAgeMs:ackAge});
      }
    } else if(this.choiceReports.has(seatId)&&this.choiceReports.get(seatId)!==lease) {
      this.choiceReports.delete(seatId);
    }
    // Positive progress evidence is a host outbound sequence or phase change.
    // Idle time alone can be normal (host choice, animations, deliberate pause).
    // Do not label a "stall": only flag an *unverified* quiet host window.
    if(validPhase===null||!Number.isSafeInteger(pendingChoiceCount)||
      pendingChoiceCount!==0||hostPaused===true) {
      this.quiet=null;
      return true;
    }
    if(!this.quiet||this.quiet.hostSequence!==hostSequence||
       this.quiet.phase!==validPhase||now<this.quiet.since) {
      this.quiet={hostSequence,phase:validPhase,since:now,reported:false};
    } else if(!this.quiet.reported&&now-this.quiet.since>=this.quietMs) {
      this.quiet.reported=true;
      this.emit({kind:"host_progress_quiet_unverified",phase:validPhase,
        hostSequence,quietMs:Math.floor(now-this.quiet.since),
        transportAckFresh:responsive,ackAgeMs:ackAge});
    }
    return true;
  }
  dispose(){this.quiet=null;this.choiceReports.clear()}
}
