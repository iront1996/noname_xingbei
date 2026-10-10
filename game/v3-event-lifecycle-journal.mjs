/**
 * V3-only, privacy-minimal, non-authoritative Event lifecycle observer.
 *
 * Records that the *original* GameEvent.start() Promise settled. Merely
 * seeing a "finished" field is not evidence of settlement. This observer
 * NEVER encodes local variables, callback closures, pending UI choices,
 * history payloads, cards, player IDs, event names or skill effects.
 *
 * The journal is deliberately NOT an executable Event Journal, replay log,
 * tamper-proof proof, or safe checkpoint. Snapshot always fails closed.
 */
const SCHEMA="xingbei-v3-event-lifecycle-observation-1";
const TRANSITIONS=new Set(["started","fulfilled","rejected","threw"]);
const DEFAULT_CAPACITY=512;

export function createV3EventLifecycleJournal({getScope,now=Date.now,capacity=DEFAULT_CAPACITY}={}) {
  if(typeof getScope!=="function"||typeof now!=="function"||
     !Number.isSafeInteger(capacity)||capacity<8||capacity>4096) {
    throw new TypeError("INVALID_JOURNAL_OPTIONS");
  }
  let scope=null, tracked=new WeakMap(), outcomes=new WeakMap(), nextOrdinal=0, seq=0;
  let pending=new Set(), events=[], overflow=false, truncatedTransitions=0, droppedStarts=0;
  let totals={started:0,fulfilled:0,rejected:0,threw:0};

  function refresh() {
    let candidate=null;
    try {candidate=getScope()}catch{return null}
    if(typeof candidate!=="string"||!candidate||candidate.length>=128) return null;
    if(candidate!==scope) {
      scope=candidate;
      tracked=new WeakMap();
      outcomes=new WeakMap();
      pending=new Set();
      events=[];
      nextOrdinal=0;
      seq=0;
      overflow=false;
      truncatedTransitions=0;
      droppedStarts=0;
      totals={started:0,fulfilled:0,rejected:0,threw:0};
    }
    return scope;
  }
  function record(ordinal,transition) {
    // No sensitive event body, names, seat, timestamps or socket identity.
    if(!TRANSITIONS.has(transition))return;
    seq++;
    totals[transition]++;
    if(events.length>=capacity){
      // A bounded diagnostic ring rotates independently of tracking real
      // Promise settlement (which is held in WeakMaps). This is truncation,
      // NOT evidence that the underlying GameEvent observer stopped working.
      truncatedTransitions++;
      events.shift();
    }
    events.push(Object.freeze({seq,eventOrdinal:ordinal,transition}));
  }
  function started(event) {
    if(!refresh()||!event||(typeof event!=="object"&&typeof event!=="function"))return false;
    if(tracked.has(event))return false;
    if(pending.size>=capacity){
      // A pathological unresolved event flood must not grow a permanent
      // strong Set without bounds or pretend the observation is complete.
      overflow=true;
      droppedStarts++;
      return false;
    }
    const ordinal=nextOrdinal++;
    tracked.set(event,Object.freeze({scope,ordinal}));
    pending.add(ordinal);
    outcomes.set(event,"pending");
    record(ordinal,"started");
    return true;
  }
  function settle(event,transition) {
    if(!refresh()||!["fulfilled","rejected","threw"].includes(transition))return false;
    if(!event||(typeof event!=="object"&&typeof event!=="function"))return false;
    const entry=tracked.get(event);
    if(!entry||entry.scope!==scope||!pending.has(entry.ordinal))return false;
    pending.delete(entry.ordinal);
    outcomes.set(event,transition);
    record(entry.ordinal,transition);
    return true;
  }
  function lookup(event) {
    if(!refresh() || !event ||
       (typeof event!=="object"&&typeof event!=="function")) {
      return Object.freeze({observed:false,code:"LIFECYCLE_NOT_OBSERVED"});
    }
    const entry=tracked.get(event);
    if(!entry||entry.scope!==scope){
      return Object.freeze({observed:false,code:"LIFECYCLE_NOT_OBSERVED"});
    }
    return Object.freeze({
      observed:true,ordinal:entry.ordinal,
      outcome:outcomes.get(event) ?? "pending"
    });
  }
  function snapshot() {
    if(!refresh())return Object.freeze({
      schema:SCHEMA,status:"NOT_ACTIVE_OWNER",restorable:false,
      eventContinuationCaptured:false,completeCoverage:false,readyToResume:false
    });
    return Object.freeze({
      schema:SCHEMA,status:overflow?"OBSERVATION_CAPACITY_EXCEEDED":
        truncatedTransitions>0?"OBSERVATION_RING_TRUNCATED":"OBSERVATION_PARTIAL",
      seq,started:totals.started,fulfilled:totals.fulfilled,
      rejected:totals.rejected,threw:totals.threw,
      pending:pending.size,overflowed:overflow,
      truncatedTransitions,droppedStarts,
      // Logs begin when the V3 observer is installed; earlier Events and
      // external Promise/choice activity may be missing even with zero pending.
      completeCoverage:false,eventContinuationCaptured:false,
      restorable:false,readyToResume:false,
      records:Object.freeze(events.slice())
    });
  }
  return Object.freeze({started,settle,lookup,snapshot});
}

/**
 * Attach a non-blocking observer to a GameEvent class belonging to the V3
 * client. The ORIGINAL Promise is returned by reference, without replacing
 * its resolution, rejection, ordering or exception semantics.
 *
 * No monkey-patch remains after uninstall; multiple installs on one prototype
 * are refused. This is for Playtest only and does not edit the shared engine.
 */
const INSTALLATIONS=new WeakMap();
export function installV3EventLifecycleObserver(GameEvent,journal) {
  const prototype=GameEvent?.prototype;
  if(!prototype||typeof prototype.start!=="function"||
     typeof journal?.started!=="function"||
     typeof journal?.settle!=="function"){
    return {installed:false,code:"OBSERVER_DEPENDENCIES_UNAVAILABLE"};
  }
  if(INSTALLATIONS.has(prototype))return {installed:false,code:"OBSERVER_ALREADY_INSTALLED"};
  const descriptor=Object.getOwnPropertyDescriptor(prototype,"start");
  if(!descriptor||typeof descriptor.value!=="function"||
     (!descriptor.writable&&!descriptor.configurable)){
    return {installed:false,code:"OBSERVER_START_NOT_PATCHABLE"};
  }
  const original=descriptor.value;
  function observedStart(...args) {
    let shouldObserve=false;
    try{shouldObserve=journal.started(this)}catch{}
    let result;
    try{result=Reflect.apply(original,this,args)}
    catch(error){
      if(shouldObserve)try{journal.settle(this,"threw")}catch{}
      throw error;
    }
    if(shouldObserve&&result instanceof Promise){
      // Observe the original Promise; ignore our own derived Promise.
      // Both callbacks must be no-throw, so a telemetry error cannot affect
      // the original game Event or introduce unhandled rejections.
      Promise.prototype.then.call(result,
        ()=>{try{journal.settle(this,"fulfilled")}catch{}},
        ()=>{try{journal.settle(this,"rejected")}catch{}});
    }else if(shouldObserve){
      // A non-Promise start cannot supply settlement evidence.
      try{journal.settle(this,"threw")}catch{}
    }
    return result;
  }
  try {
    Object.defineProperty(prototype,"start",{...descriptor,value:observedStart});
    INSTALLATIONS.set(prototype,observedStart);
  }catch{
    return {installed:false,code:"OBSERVER_INSTALL_FAILED"};
  }
  return {installed:true,code:"OBSERVER_INSTALLED",uninstall() {
    if(INSTALLATIONS.get(prototype)!==observedStart||
       prototype.start!==observedStart)return false;
    Object.defineProperty(prototype,"start",descriptor);
    INSTALLATIONS.delete(prototype);
    return true;
  }};
}
