import test from "node:test";
import assert from "node:assert/strict";
import {inspectV3EventCutQueues as cut} from "../game/v3-event-cut-audit.mjs";

const frame=(name="phaseLoop",next=[],after=[],finished=false)=>({
  name,next,after,finished,player:{playerid:"private-player"}
});
const neverCertified=result=>{
  assert.equal(result.completeCoverage,false);
  assert.equal(result.safeCheckpointCertified,false);
  assert.equal(result.eventContinuationCaptured,false);
  assert.equal(result.restorable,false);
  assert.equal(result.readyToResume,false);
  assert.doesNotMatch(JSON.stringify(result),/private-player|phaseLoop|secret-card/);
};
test("ancestor next and after queues stay pending even if current phase is clean",()=>{
  const a=cut([frame("root",[{secret:"secret-card"}]),frame()]);
  assert.equal(a.code,"CUT_ANCESTOR_QUEUES_PENDING");
  assert.equal(a.ancestorNext,1);assert.equal(a.ancestorAfter,0);
  neverCertified(a);
  const b=cut([frame("root",[],[{}]),frame()]);
  assert.equal(b.code,"CUT_ANCESTOR_QUEUES_PENDING");
  assert.equal(b.ancestorAfter,1);
  neverCertified(b);
});
test("current phaseLoop next/after work is diagnosed separately",()=>{
  const v=cut([frame("root"),frame("phaseLoop",[{}],[{}])]);
  assert.equal(v.code,"CUT_CURRENT_QUEUES_PENDING");
  assert.equal(v.currentNext,1);assert.equal(v.currentAfter,1);
  neverCertified(v);
});
test("visible-empty queue never certifies a resumable checkpoint",()=>{
  const v=cut([frame("root"),frame()]);
  assert.equal(v.code,"CUT_VISIBLE_QUEUES_EMPTY_NOT_CERTIFIED");
  assert.equal(v.ancestorNext,0);
  assert.equal(v.currentNext,0);
  neverCertified(v);
});
test("non phase event is not a safe turn boundary",()=>{
  const v=cut([frame("root"),frame("skill")]);
  assert.equal(v.code,"CUT_NOT_PHASE_LOOP");
  neverCertified(v);
});
test("frame shape, missing own fields and custom getter fail closed without invocation",()=>{
  assert.equal(cut([]).code,"CUT_STACK_UNAVAILABLE");
  assert.equal(cut(Array(129).fill(frame())).code,"CUT_STACK_UNAVAILABLE");
  assert.equal(cut([{}]).code,"CUT_STACK_FIELD_UNAVAILABLE");
  assert.equal(cut([frame("phaseLoop",null)]).code,"CUT_STACK_FRAME_INVALID");
  let called=0;const f=frame();
  Object.defineProperty(f,"after",{get(){called++;throw Error("PRIVATE")},enumerable:true});
  assert.equal(cut([f]).code,"CUT_STACK_FIELD_UNAVAILABLE");
  assert.equal(called,0);
});
test("queue total bounded; finished flags are only observational",()=>{
  const v=cut([frame("root",[],[],true),frame("phaseLoop",[],[],true)]);
  assert.equal(v.finishedFrames,2);
  neverCertified(v);
  const big=frame("root",Array(20001).fill({}));
  assert.equal(cut([big,frame()]).code,"CUT_STACK_FRAME_INVALID");
});
