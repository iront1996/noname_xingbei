import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectV3HistoryEventReferences as history,
  inspectV3TurnBoundaryStack as boundary
} from "../game/v3-event-observation-preflight.mjs";

const itemtype=value => value?.__event === true ? "event"
  : Array.isArray(value) ? "array" : "object";

const frame=(name="phaseLoop", next=[], after=[])=>({
  name,player:{playerid:"private-id"},next,after,finished:false
});

test("phase-loop stack must not hide ancestor next or after queues",()=>{
  assert.deepEqual(boundary([frame("root"),frame()]),
    {ok:true,code:"BOUNDARY_STACK_OBSERVABLE",restorable:false});
  assert.equal(boundary([frame("root",[{}]),frame()]).code,
    "BOUNDARY_ANCESTOR_WORK_PENDING");
  assert.equal(boundary([frame("root",[],[{}]),frame()]).code,
    "BOUNDARY_ANCESTOR_WORK_PENDING");
  assert.equal(boundary([frame("root"),frame("useCard")]).code,
    "BOUNDARY_PHASE_LOOP_NOT_ACTIVE");
});
test("malformed frame, empty stack, or too-deep nesting fail closed",()=>{
  assert.equal(boundary([]).code,"BOUNDARY_STACK_UNAVAILABLE");
  assert.equal(boundary(new Array(129).fill(frame())).code,"BOUNDARY_STACK_UNAVAILABLE");
  assert.equal(boundary([frame("root"),{name:"phaseLoop",player:{playerid:"h"}}]).code,
    "BOUNDARY_QUEUE_SHAPE_INVALID");
});
test("opaque historical event marked finished is NOT a replayable continuation",()=>{
  const ref={__event:true,finished:true,player:{playerid:"secret"}};
  const result=history([{useCard:[ref,ref]}],itemtype,[]);
  assert.deepEqual(result,{ok:false,code:"HISTORY_EVENT_FINISHED_FLAG_ONLY",restorable:false});
  assert.equal(JSON.stringify(result).includes("secret"),false);
});
test("unfinished historical events are distinguished from active-stack events",()=>{
  const ref={__event:true,finished:false,choice:"sensitive"};
  assert.equal(history([{useCard:[ref]}],itemtype,[]).code,
    "HISTORY_EVENT_NOT_MARKED_FINISHED");
  assert.equal(history([{useCard:[ref]}],itemtype,[ref]).code,
    "HISTORY_EVENT_IN_ACTIVE_STACK");
});
test("plain histories have no event references, but never certify restorable",()=>{
  const result=history([{useCard:[],respond:[]}],itemtype,[]);
  assert.deepEqual(result,{ok:true,code:"HISTORY_EVENT_REFERENCES_ABSENT",restorable:false});
});
test("cyclic arrays are bounded by object identity; enormous graphs fail closed",()=>{
  const arr=[];arr.push(arr);
  assert.equal(history(arr,itemtype,[]).code,"HISTORY_EVENT_REFERENCES_ABSENT");
  const huge=Array.from({length:12001},()=>({safe:true}));
  assert.equal(history(huge,itemtype,[]).code,"HISTORY_OBSERVATION_LIMIT");
});
test("exceptions and exotic containers return fixed codes without leaking keys",()=>{
  const raw=[{get privateHand(){throw Error("secret cards");}}];
  assert.equal(history(raw,itemtype,[]).code,"HISTORY_OBSERVATION_ACCESSOR_UNSAFE");
  assert.equal(history([new Date()],itemtype,[]).code,
    "HISTORY_OBSERVATION_UNSUPPORTED_OBJECT");
  assert.equal(history(null,itemtype,[]).code,"HISTORY_PROBE_UNAVAILABLE");
});

test("observation never invokes history getters or traverses engine Card/Player internals",()=>{
 let getterCalls=0;
 const sensitive={get cards(){getterCalls++;throw Error("secret hand");}};
 assert.equal(history([sensitive],itemtype,[]).code,
   "HISTORY_OBSERVATION_ACCESSOR_UNSAFE");
 assert.equal(getterCalls,0);
 const engineType=v=>v?.__engine || itemtype(v);
 const hiddenPlayer={__engine:"player",private:{get hidden(){throw Error("private player");}}};
 const hiddenCard={__engine:"card",get secret(){throw Error("private card");}};
 assert.deepEqual(history([{useCard:[hiddenPlayer,hiddenCard]}],engineType,[]),
   {ok:true,code:"HISTORY_EVENT_REFERENCES_ABSENT",restorable:false});
});

test("actual onphase parent.next[0] points at running phaseLoop, never considered an extra sibling",()=>{
 const child=frame("phaseLoop");
 const root=frame("root",[child]);
 assert.deepEqual(boundary([root,child]),{
   ok:false,code:"BOUNDARY_ACTIVE_LINEAGE_AWAITING_COMPLETION",restorable:false
 });
});
test("future sibling and ancestor after queue still block phase boundary",()=>{
 const child=frame("phaseLoop");
 const root=frame("root",[child,{name:"queued"}]);
 assert.equal(boundary([root,child]).code,"BOUNDARY_ANCESTOR_WORK_PENDING");
 root.next=[child];root.after=[{name:"after"}];
 assert.equal(boundary([root,child]).code,"BOUNDARY_ANCESTOR_WORK_PENDING");
});
test("current frame queued work and hostile getter remain strict boundary rejects",()=>{
 const child=frame("phaseLoop",[{}]);
 const root=frame("root",[child]);
 assert.equal(boundary([root,child]).code,"BOUNDARY_CURRENT_WORK_PENDING");
 const clean=frame("phaseLoop");
 const hostile=frame("root",[clean]);
 let calls=0;
 Object.defineProperty(hostile.next,"0",{get(){calls++;throw Error("secret");}});
 assert.equal(boundary([hostile,clean]).code,"BOUNDARY_QUEUE_SHAPE_INVALID");
 assert.equal(calls,0);
});
test("observable empty stack still does not certify game continuation",()=>{
 const child=frame("phaseLoop");
 assert.deepEqual(boundary([frame("root"),child]),{
   ok:true,code:"BOUNDARY_STACK_OBSERVABLE",restorable:false
 });
});
