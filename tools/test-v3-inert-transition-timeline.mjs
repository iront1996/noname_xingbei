import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileV3InertTimeline as merge,verifyV3InertTimeline as verify
} from "../game/v3-inert-transition-timeline.mjs";
const window=(first,last,{droppedStarts=0,status="OBSERVATION_PARTIAL"}={})=>({
  seq:last,started:last,droppedStarts,status,
  completeCoverage:false,eventContinuationCaptured:false,
  restorable:false,readyToResume:false,
  records:Array.from({length:last-first+1},(_,i)=>({
    seq:first+i,eventOrdinal:Math.floor((first+i-1)/2),
    transition:(first+i)%2===1?"started":"fulfilled"
  }))
});
test("observed consecutive windows join without duplicates or loss",()=>{
 const first=merge(null,window(1,6));
 assert.equal(first.ok,true);
 assert.equal(first.timeline.records.length,6);
 const next=merge(first.timeline,window(4,11));
 assert.equal(next.ok,true);
 assert.equal(next.timeline.records.length,11);
 assert.equal(next.timeline.missingTransitions,0);
 assert.equal(next.timeline.evictedTransitions,0);
 assert.equal(next.timeline.completeCoverage,false);
 assert.equal(next.timeline.restorable,false);
 assert.equal(verify(next.timeline).ok,true);
 assert.equal(JSON.stringify(next.timeline).includes("playerid"),false);
});
test("ring truncation before first archive and missed windows report gaps",()=>{
 const first=merge(null,window(102,120,{status:"OBSERVATION_RING_TRUNCATED"}));
 assert.equal(first.timeline.missingTransitions,101);
 const next=merge(first.timeline,window(150,160));
 assert.equal(next.timeline.missingTransitions,130);
 assert.equal(verify(next.timeline).ok,true);
});
test("different payload for repeated sequence is rejected, not silently overwritten",()=>{
 const first=merge(null,window(1,9));
 const b=window(6,12);b.records[0].transition="rejected";
 assert.equal(merge(first.timeline,b).code,"TIMELINE_OVERLAP_CONFLICT");
});
test("a restarted observer epoch cannot splice into an old timeline",()=>{
 const first=merge(null,window(1,30));
 assert.equal(merge(first.timeline,window(1,4)).code,"TIMELINE_EPOCH_OR_COUNTER_RESET");
});
test("bounded archive evicts old records but keeps explicit lost-entry count",()=>{
 let state=null;
 for(let start=1;start<=4097;start+=400){
   const end=Math.min(4496,start+399);
   const w=window(start,end,{status:"OBSERVATION_RING_TRUNCATED"});
   const outcome=merge(state,w);
   assert.equal(outcome.ok,true);
   state=outcome.timeline;
 }
 assert.equal(state.records.length,4096);
 assert.equal(state.evictedTransitions,304);
 assert.equal(state.missingTransitions,0);
 assert.equal(verify(state).ok,true);
});
test("invalid transitions and injection attempts fail closed",()=>{
 let w=window(1,4);
 w.records[2].transition="handSecret";
 assert.equal(merge(null,w).code,"TIMELINE_WINDOW_INVALID");
 w=window(1,4);
 w.records[2].secretSkill="leak";
 assert.equal(merge(null,w).code,"TIMELINE_WINDOW_INVALID");
 const good=merge(null,window(1,5)).timeline;
 const tampered=JSON.parse(JSON.stringify(good));
 tampered.restorable=true;
 assert.equal(verify(tampered).ok,false);
 tampered.restorable=false;
 tampered.records[0].seq=0;
 assert.equal(verify(tampered).ok,false);
});
test("none of the archive states can authorize replay or cold owner takeover",()=>{
 let archive=null;
 for(const w of [window(20,30),window(25,55)]){
   const out=merge(archive,w);
   assert.equal(out.ok,true);
   archive=out.timeline;
   for(const prop of ["completeCoverage","eventContinuationCaptured",
     "safeCheckpointCertified","restorable","readyToResume"])
     assert.equal(archive[prop],false);
 }
});
