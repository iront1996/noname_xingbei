/**
 * Transport health watchdog for Xingbei browsers. This module does not infer
 * gameplay state from transport health or overwrite game packets.
 */
export class ConnectionHealth {
  constructor({now=Date.now,setIntervalFn=setInterval,clearIntervalFn=clearInterval,
    staleMs=85000,probeEveryMs=5000,onStale=()=>{},onState=()=>{}}={}) {
    this.now=now;this.schedule=setIntervalFn;this.unschedule=clearIntervalFn;
    this.staleMs=staleMs;this.probeEveryMs=probeEveryMs;
    this.onStale=onStale;this.onState=onState;
    this.lastInboundAt=0;this.ws=null;this.timer=null;this.staleReported=false;
    this.state="DISCONNECTED";
    this.wake=()=>this.check();
  }
  transition(value,details={}) {
    if(this.state===value)return;
    this.state=value;
    try{this.onState(value,details);}catch(_){}
  }
  bind(ws) {
    this.dispose();
    this.ws=ws;this.lastInboundAt=this.now();this.staleReported=false;
    this.transition("CONNECTED");
    this.timer=this.schedule(()=>this.check(),this.probeEveryMs);
    if(typeof document!=="undefined")document.addEventListener("visibilitychange",this.wake);
    if(typeof window!=="undefined"){window.addEventListener("online",this.wake);window.addEventListener("focus",this.wake);}
  }
  incoming(ws) {
    if(ws!==this.ws)return;
    this.lastInboundAt=this.now();
    if(this.state==="SUSPECT")this.transition("CONNECTED",{recovered:"inbound_data"});
    this.staleReported=false;
  }
  check() {
    if(!this.ws || this.ws.readyState!==1 || this.staleReported)return;
    const lag=this.now()-this.lastInboundAt;
    if(lag<this.staleMs)return;
    this.staleReported=true;
    this.transition("SUSPECT",{lastIncomingAgeMs:lag});
    try{this.onStale(this.ws,{lastIncomingAgeMs:lag});}catch(_){}
  }
  dispose() {
    if(this.timer!==null)this.unschedule(this.timer);
    if(typeof document!=="undefined")document.removeEventListener("visibilitychange",this.wake);
    if(typeof window!=="undefined"){window.removeEventListener("online",this.wake);window.removeEventListener("focus",this.wake);}
    this.timer=null;this.ws=null;this.staleReported=false;
    this.transition("DISCONNECTED");
  }
}
