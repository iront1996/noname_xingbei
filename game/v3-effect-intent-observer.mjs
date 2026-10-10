/**
 * V3-only passive intent observer for native Player APIs.
 *
 * It counts calls to scheduling methods, NOT applied HP/card effects.
 * The same Engine GameEvent / Promise is returned untouched, and no
 * argument, Player, Card, or Event object is ever stored or inspected.
 * Mutations outside these entry points are not covered.
 *
 * This is a diagnostic, not an executable event-effect journal.
 */
export const V3_EFFECT_INTENT_METHODS=Object.freeze([
  "damage","recover","loseHp","changeHp","gain","lose","draw"
]);
const INSTALLATIONS=new WeakMap();
const DEFAULT_LIMIT=1000000;
export function createV3EffectIntentObserver({getScope,limit=DEFAULT_LIMIT}={}){
  if(typeof getScope!=="function"||!Number.isSafeInteger(limit)||limit<1||
     limit>10000000)throw new TypeError("INVALID_EFFECT_INTENT_OPTIONS");
  let scope=null,overflow=false,counts=null,failures=null;
  function fresh(){
    counts=Object.fromEntries(V3_EFFECT_INTENT_METHODS.map(name=>[name,0]));
    failures=Object.fromEntries(V3_EFFECT_INTENT_METHODS.map(name=>[name,0]));
    overflow=false;
  }
  fresh();
  function refresh(){
    let s=null;
    try{s=getScope()}catch{return false}
    if(typeof s!=="string"||!s||s.length>=128)return false;
    if(s!==scope){scope=s;fresh()}
    return true;
  }
  function observe(method,threw){
    if(!refresh()||!Object.prototype.hasOwnProperty.call(counts,method))return;
    if(counts[method]>=limit){
      overflow=true;
      return;
    }
    counts[method]++;
    if(threw)failures[method]++;
  }
  function snapshot(){
    if(!refresh())return Object.freeze({
      status:"EFFECT_INTENT_NOT_ACTIVE",
      totalCalls:0,failedCalls:0,counts:Object.freeze({}),
      methodsInstrumented:0,sideEffectsCaptured:false,
      engineAdapterInstalled:false,stateCheckpointAtomic:false,
      completeCoverage:false,restorable:false,readyToResume:false
    });
    const totalCalls=Object.values(counts).reduce((a,b)=>a+b,0);
    const failedCalls=Object.values(failures).reduce((a,b)=>a+b,0);
    return Object.freeze({
      status:overflow?"EFFECT_INTENT_COUNTER_OVERFLOW":"EFFECT_INTENT_CALLS_ONLY",
      totalCalls,failedCalls,counts:Object.freeze({...counts}),
      methodsInstrumented:V3_EFFECT_INTENT_METHODS.length,
      sideEffectsCaptured:false,engineAdapterInstalled:false,
      stateCheckpointAtomic:false,completeCoverage:false,
      restorable:false,readyToResume:false
    });
  }
  return Object.freeze({observe,snapshot});
}
export function installV3EffectIntentObserver(Player,journal){
  const proto=Player?.prototype;
  if(!proto||typeof journal?.observe!=="function"||
     typeof journal?.snapshot!=="function")
    return {installed:false,code:"EFFECT_INTENT_DEPENDENCIES_UNAVAILABLE"};
  if(INSTALLATIONS.has(proto))
    return {installed:false,code:"EFFECT_INTENT_ALREADY_INSTALLED"};
  const originals=new Map();
  for(const method of V3_EFFECT_INTENT_METHODS){
    const d=Object.getOwnPropertyDescriptor(proto,method);
    if(!d||typeof d.value!=="function"||(!d.configurable&&!d.writable))
      return {installed:false,code:"EFFECT_INTENT_METHOD_UNAVAILABLE"};
    originals.set(method,d);
  }
  const wrapped=new Map();
  const installed=[];
  try{
    for(const method of V3_EFFECT_INTENT_METHODS){
      const descriptor=originals.get(method);
      function observed(...args){
        let output;
        try{
          output=Reflect.apply(descriptor.value,this,args);
        }catch(err){
          try{journal.observe(method,true)}catch{}
          throw err;
        }
        try{journal.observe(method,false)}catch{}
        return output;
      }
      Object.defineProperty(proto,method,{...descriptor,value:observed});
      installed.push(method);
      wrapped.set(method,observed);
    }
  }catch{
    for(const method of installed.reverse()){
      try{Object.defineProperty(proto,method,originals.get(method))}catch{}
    }
    return {installed:false,code:"EFFECT_INTENT_INSTALL_FAILED"};
  }
  INSTALLATIONS.set(proto,wrapped);
  return {
    installed:true,code:"EFFECT_INTENT_INSTALLED",
    uninstall(){
      if(INSTALLATIONS.get(proto)!==wrapped)return false;
      for(const [method,fn] of wrapped){
        if(Object.getOwnPropertyDescriptor(proto,method)?.value!==fn)
          return false;
      }
      for(const [method,descriptor] of originals){
        Object.defineProperty(proto,method,descriptor);
      }
      INSTALLATIONS.delete(proto);
      return true;
    }
  };
}
