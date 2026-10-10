/**
 * V3-only Star Cup Legend / 星杯傳說 mechanical state diagnostic.
 *
 * No individual HP model exists in the Star Cup rules. Damage normally
 * produces draws; treatment (zhiLiao) is a defensive resource, not healHP.
 * Read only primitive counts of morale, grails, two starstones, treatment and
 * public draw/discard zones. No card IDs, hidden hand, names, or skill state.
 *
 * These six-second interval deltas are OBSERVATIONS, not atomic effects.
 * They can never authorize playback or a cold host resume.
 */
const MAX_SEATS=8;
const MAX_ZONE=200000;
const MAX_VALUE=100000;
const safeInt=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const own=(o,k)=>{
  const d=o&&Object.getOwnPropertyDescriptor(o,k);
  if(!d || !Object.prototype.hasOwnProperty.call(d,"value"))
    throw Error("XINGBEI_FIELD_NOT_OWN_DATA");
  return d.value;
};
function stones(g,field){
  const list=own(g,field);
  if(!Array.isArray(list)||list.length>64)return null;
  let gem=0,crystal=0;
  for(let i=0;i<list.length;i++){
    const value=own(list,String(i));
    if(value==="baoShi")gem++;
    else if(value==="shuiJing")crystal++;
    else return null;
  }
  return {gem,crystal};
}
function zoneLength(node){
  if(!node || !node.children)return null;
  const length=node.children.length;
  return safeInt(length,0,MAX_ZONE)?length:null;
}
export function readV3XingbeiState(game,players,drawPile,discardPile){
  try{
    if(!Array.isArray(players)||players.length<2||players.length>MAX_SEATS||
       new Set(players).size!==players.length)return null;
    const redMorale=own(game,"hongShiQi"),blueMorale=own(game,"lanShiQi");
    const redGrails=own(game,"hongXingBei"),blueGrails=own(game,"lanXingBei");
    if(![redMorale,blueMorale].every(v=>safeInt(v,-1000,MAX_VALUE))||
       ![redGrails,blueGrails].every(v=>safeInt(v,0,MAX_VALUE)))return null;
    const red=stones(game,"hongZhanJi"),blue=stones(game,"lanZhanJi");
    if(!red||!blue)return null;
    const deck=zoneLength(drawPile),discard=zoneLength(discardPile);
    if(deck===null||discard===null)return null;
    const seats=players.map(p=>{
      if(!p || (typeof p!=="object"&&typeof p!=="function"))
        throw Error("XINGBEI_SEAT_INVALID");
      const treatment=own(p,"zhiLiao");
      if(!safeInt(treatment,0,MAX_VALUE))
        throw Error("XINGBEI_TREATMENT_INVALID");
      return {ref:p,treatment};
    });
    return {redMorale,blueMorale,redGrails,blueGrails,
      redGem:red.gem,redCrystal:red.crystal,
      blueGem:blue.gem,blueCrystal:blue.crystal,
      deck,discard,seats};
  }catch{return null}
}
const zero=()=>({
  samples:0,comparedWindows:0,moraleWindows:0,grailWindows:0,
  starstoneWindows:0,treatmentWindows:0,zoneWindows:0,
  windowsWithNativeCalls:0,unattributedWindows:0,
  seatingResets:0,invalidSamples:0
});
const view=(status,counts)=>Object.freeze({
  status,...counts,mode:"XINGBEI",
  // Other native APIs, private hands, per-character energy and skill marks
  // are not instrumented by this read-only sampling contract.
  energyObserved:false,skillStorageObserved:false,
  completeCoverage:false,appliedEffectsProven:false,
  atomicStateCheckpoint:false,restorable:false,readyToResume:false
});
const metricFields=[
  "redMorale","blueMorale","redGrails","blueGrails","redGem","redCrystal",
  "blueGem","blueCrystal","deck","discard"
];
export function createV3XingbeiStateDeltaObserver({getScope}={}){
  if(typeof getScope!=="function")throw TypeError("XINGBEI_SCOPE_REQUIRED");
  let scope=null,last=null,nextId=0,seats=new WeakMap(),counts=zero();
  function ready(){
    let id=null;
    try{id=getScope()}catch{return false}
    if(typeof id!=="string"||!id||id.length>127)return false;
    if(scope!==id){scope=id;last=null;nextId=0;seats=new WeakMap();counts=zero()}
    return true;
  }
  function snapshot(){
    if(!ready())return view("XINGBEI_STATE_NOT_ACTIVE",zero());
    return view(last===null?"XINGBEI_STATE_BASELINE_NOT_READY":
      counts.comparedWindows===0?"XINGBEI_STATE_BASELINE_ONLY":
      "XINGBEI_STATE_WINDOWS_OBSERVED",counts);
  }
  function observe(sample,intents){
    if(!ready())return view("XINGBEI_STATE_NOT_ACTIVE",zero());
    try{
      if(!sample || !Array.isArray(sample.seats) ||
         sample.seats.length<2||sample.seats.length>MAX_SEATS||
         metricFields.some(f=>!safeInt(sample[f],
           f.endsWith("Morale")?-1000:0,MAX_ZONE))||
         !safeInt(intents?.totalCalls,0,10000000)||
         !["EFFECT_INTENT_CALLS_ONLY","EFFECT_INTENT_COUNTER_OVERFLOW"]
           .includes(intents.status))throw Error("BAD_SAMPLE");
      const identified=sample.seats.map(p=>{
        if(!p||!p.ref||!safeInt(p.treatment,0,MAX_VALUE))
          throw Error("BAD_TREATMENT");
        let id=seats.get(p.ref);
        if(id===undefined){id=nextId++;seats.set(p.ref,id)}
        return {id,treatment:p.treatment};
      });
      if(new Set(identified.map(p=>p.id)).size!==identified.length)
        throw Error("DUPLICATE_SEATS");
      const frame={...Object.fromEntries(metricFields.map(k=>[k,sample[k]])),
        seats:identified,nativeCalls:intents.totalCalls};
      counts.samples++;
      if(last){
        const same=last.seats.length===frame.seats.length&&
          last.seats.every((p,i)=>p.id===frame.seats[i].id);
        if(!same||frame.nativeCalls<last.nativeCalls||
           intents.status==="EFFECT_INTENT_COUNTER_OVERFLOW")counts.seatingResets++;
        else{
          const changed=keys=>keys.some(k=>last[k]!==frame[k]);
          const morale=changed(["redMorale","blueMorale"]);
          const grail=changed(["redGrails","blueGrails"]);
          const stones=changed(["redGem","redCrystal","blueGem","blueCrystal"]);
          const treatment=frame.seats.some((p,i)=>
            p.treatment!==last.seats[i].treatment);
          const zone=changed(["deck","discard"]);
          const calls=frame.nativeCalls>last.nativeCalls;
          counts.comparedWindows++;
          if(morale)counts.moraleWindows++;
          if(grail)counts.grailWindows++;
          if(stones)counts.starstoneWindows++;
          if(treatment)counts.treatmentWindows++;
          if(zone)counts.zoneWindows++;
          if(calls)counts.windowsWithNativeCalls++;
          if((morale||grail||stones||treatment||zone)&&!calls)
            counts.unattributedWindows++;
        }
      }
      last=frame;
      return snapshot();
    }catch{
      counts.invalidSamples++;
      last=null;
      return view("XINGBEI_STATE_INVALID_SAMPLE",counts);
    }
  }
  return Object.freeze({observe,snapshot});
}
