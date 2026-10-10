/**
 * V3-only read-only, numeric mechanical-state delta observer.
 *
 * The original Player methods schedule events. A method call can precede
 * a later HP / pile change, can be cancelled, or may have no visible effect.
 * Conversely, effects may mutate state without calling those methods.
 * This compares periodic primitive samples only, never captures Card,
 * Player, Event, skill payloads, hidden hand or any replay operation.
 *
 * All counts are APPROXIMATE windows, NOT applied transaction counts.
 */
const MAX_PLAYERS=8;
const MAX_COUNT=200000;
const MAX_SAMPLES=1000000;
const fields=["hp","maxHp","hujia"];
const finite=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
const nonnegative=v=>Number.isSafeInteger(v)&&v>=0&&v<=MAX_COUNT;
const denied=(code)=>Object.freeze({
  status:code,samples:0,comparedWindows:0,
  hpChangedWindows:0,pileChangedWindows:0,
  hpChangedSeats:0,windowsWithIntentCalls:0,
  hpChangeWithoutIntentWindows:0,pileChangeWithoutIntentWindows:0,
  topologyResets:0,invalidSamples:0,
  appliedEffectsProven:false,sideEffectsCaptured:false,
  stateCheckpointAtomic:false,completeCoverage:false,
  restorable:false,readyToResume:false
});

function primitive(object,key) {
  const desc=Object.getOwnPropertyDescriptor(object,key);
  if(!desc||!("value" in desc))throw Error("STATE_FIELD_UNAVAILABLE");
  return desc.value;
}

/** Extract only engine primitive HP and UI zone totals; never enumerate cards. */
export function readV3MechanicalStateSample(players,drawPile,discardPile) {
  try {
    if(!Array.isArray(players)||players.length<2||
       players.length>MAX_PLAYERS||
       !nonnegative(drawPile?.children?.length) ||
       !nonnegative(discardPile?.children?.length)) return null;
    const rows=players.map(player=>{
      if(!player||(typeof player!=="object"&&typeof player!=="function"))
        throw Error("PLAYER_INVALID");
      const hp=primitive(player,"hp");
      const maxHp=primitive(player,"maxHp");
      const guard=Object.getOwnPropertyDescriptor(player,"hujia");
      const hujia=guard===undefined?0:primitive(player,"hujia");
      if(!finite(hp,-1000,1000) || !finite(maxHp,0,1000) ||
         !finite(hujia,0,1000))throw Error("HP_INVALID");
      return {reference:player,hp,maxHp,hujia};
    });
    if(new Set(players).size!==players.length)return null;
    return {rows,drawPileCount:drawPile.children.length,
      discardPileCount:discardPile.children.length};
  }catch{
    return null;
  }
}

export function createV3MechanicalDeltaObserver({getScope}={}){
  if(typeof getScope!=="function")throw new TypeError("STATE_SCOPE_REQUIRED");
  let scope=null,previous=null,identity=new WeakMap(),nextId=0;
  let counts;
  function reset(){
    previous=null;
    identity=new WeakMap();
    nextId=0;
    counts={
      samples:0,comparedWindows:0,hpChangedWindows:0,
      pileChangedWindows:0,hpChangedSeats:0,
      windowsWithIntentCalls:0,hpChangeWithoutIntentWindows:0,
      pileChangeWithoutIntentWindows:0,topologyResets:0,
      invalidSamples:0
    };
  }
  reset();
  function refresh(){
    let s;
    try{s=getScope()}catch{return false}
    if(typeof s!=="string"||!s||s.length>127)return false;
    if(scope!==s){scope=s;reset()}
    return true;
  }
  function view(status){
    return Object.freeze({status,...counts,
      appliedEffectsProven:false,sideEffectsCaptured:false,
      stateCheckpointAtomic:false,completeCoverage:false,
      restorable:false,readyToResume:false});
  }
  function snapshot(){
    if(!refresh())return denied("STATE_DELTA_NOT_ACTIVE");
    return view(previous===null?"STATE_DELTA_BASELINE_NOT_READY":
      counts.comparedWindows===0?"STATE_DELTA_BASELINE_ONLY":
      "STATE_DELTA_WINDOWS_OBSERVED");
  }
  /** Called synchronously only; no waiting or game calls. */
  function observe(sample,intents){
    if(!refresh())return view("STATE_DELTA_NOT_ACTIVE");
    try {
      if(!sample || !Array.isArray(sample.rows) ||
         sample.rows.length<2||sample.rows.length>MAX_PLAYERS ||
         !nonnegative(sample.drawPileCount)||
         !nonnegative(sample.discardPileCount)||
         !nonnegative(intents?.totalCalls) ||
         !["EFFECT_INTENT_CALLS_ONLY","EFFECT_INTENT_COUNTER_OVERFLOW"]
           .includes(intents.status)) throw Error("SAMPLE_INVALID");
      const seats=[];
      for(const row of sample.rows){
        if(!row||!row.reference||
           (typeof row.reference!=="object"&&typeof row.reference!=="function")||
           !finite(row.hp,-1000,1000)||
           !finite(row.maxHp,0,1000)||!finite(row.hujia,0,1000))
          throw Error("SAMPLE_INVALID");
        let id=identity.get(row.reference);
        if(id===undefined){id=nextId++;identity.set(row.reference,id)}
        seats.push({id,hp:row.hp,maxHp:row.maxHp,hujia:row.hujia});
      }
      if(new Set(seats.map(p=>p.id)).size!==seats.length)
        throw Error("DUPLICATE_SEAT");
      if(counts.samples>=MAX_SAMPLES) {
        return view("STATE_DELTA_COUNTER_LIMIT");
      }
      const frame={
        seats,drawPileCount:sample.drawPileCount,
        discardPileCount:sample.discardPileCount,
        intentCount:intents.totalCalls
      };
      counts.samples++;
      if(previous){
        const sameSeats=previous.seats.length===seats.length&&
          previous.seats.every((p,i)=>p.id===seats[i].id);
        if(!sameSeats||frame.intentCount<previous.intentCount||
           intents.status==="EFFECT_INTENT_COUNTER_OVERFLOW"){
          counts.topologyResets++;
        }else{
          let changed=0;
          for(let i=0;i<seats.length;i++){
            const a=previous.seats[i],b=seats[i];
            if(fields.some(k=>a[k]!==b[k]))changed++;
          }
          const pileChanged=
            frame.drawPileCount!==previous.drawPileCount ||
            frame.discardPileCount!==previous.discardPileCount;
          const calls=frame.intentCount>previous.intentCount;
          counts.comparedWindows++;
          if(changed){
            counts.hpChangedWindows++;
            counts.hpChangedSeats+=changed;
            if(!calls)counts.hpChangeWithoutIntentWindows++;
          }
          if(pileChanged){
            counts.pileChangedWindows++;
            if(!calls)counts.pileChangeWithoutIntentWindows++;
          }
          if(calls)counts.windowsWithIntentCalls++;
        }
      }
      previous=frame;
      return snapshot();
    }catch{
      counts.invalidSamples++;
      previous=null;
      return view("STATE_DELTA_SAMPLE_INVALID");
    }
  }
  return Object.freeze({observe,snapshot});
}
