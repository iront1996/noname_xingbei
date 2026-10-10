import test from "node:test";
import assert from "node:assert/strict";
import {
  V3_EFFECT_FENCE_SCHEMA,
  emptyV3EffectFence,
  inspectV3EffectReplayFence as inspect,
  classifyV3EffectReplayRequest as classify
} from "../game/v3-effect-transaction-fence.mjs";

const epoch="1234567890abcdef1234567890abcdef";
const make=(records,override={})=>({...emptyV3EffectFence(epoch),records,...override});
const record=(seq,effectOrdinal,stage,type="hp_change",eventOrdinal=7)=>({
  seq,effectOrdinal,eventOrdinal,type,stage
});
const never=(value)=>{
  assert.equal(value.restorable,false);
  assert.equal(value.readyToResume,false);
};
test("empty ledger is not a replay permit or proof that effects never happened",()=>{
  const value=inspect(emptyV3EffectFence(epoch));
  assert.equal(value.code,"EFFECT_FENCE_NO_EFFECTS_OBSERVED");
  assert.equal(value.summary.effectCount,0);
  assert.equal(value.summary.completeCoverage,false);
  never(value);
  assert.equal(classify(emptyV3EffectFence(epoch),0).executionAuthorized,false);
  assert.equal(classify(emptyV3EffectFence(epoch),0).code,"EFFECT_REPLAY_NOT_OBSERVED");
});
test("crash immediately after intent remains ambiguous; replay forbidden",()=>{
  const ledger=make([record(1,0,"intent")]);
  const value=inspect(ledger);
  assert.equal(value.code,"EFFECT_FENCE_AMBIGUOUS_CRASH_WINDOW");
  assert.equal(value.summary.intentsWithoutApply,1);
  assert.equal(classify(ledger,0).code,"EFFECT_REPLAY_OUTCOME_UNKNOWN");
  assert.equal(classify(ledger,0).executionAuthorized,false);
  never(value);
});
test("crash after JS state change before durable seal cannot trigger double damage",()=>{
  const ledger=make([record(1,0,"intent"),record(2,0,"applied")]);
  const checked=inspect(ledger);
  assert.equal(checked.code,"EFFECT_FENCE_AMBIGUOUS_CRASH_WINDOW");
  assert.equal(checked.summary.appliedWithoutSeal,1);
  assert.equal(classify(ledger,0).code,"EFFECT_REPLAY_OUTCOME_UNKNOWN");
  assert.equal(classify(ledger,0).executionAuthorized,false);
  never(checked);
});
test("sealed synthetic effect is accounted for, not authorized to repeat",()=>{
  const ledger=make([
    record(1,0,"intent"),record(2,0,"applied"),
    record(3,0,"state_sealed")
  ]);
  const checked=inspect(ledger);
  assert.equal(checked.code,"EFFECT_FENCE_INERT_SEALS_ONLY");
  assert.equal(checked.summary.sealedCount,1);
  assert.equal(checked.summary.stateCheckpointAtomic,false);
  assert.equal(classify(ledger,0).code,"EFFECT_REPLAY_ALREADY_ACCOUNTED");
  assert.equal(classify(ledger,0).executionAuthorized,false);
  never(checked);
});
test("interleaved effect intents track each transaction separately",()=>{
  const ledger=make([
    record(1,0,"intent","card_transfer"),
    record(2,1,"intent","choice_resolution",9),
    record(3,0,"applied","card_transfer"),
    record(4,0,"state_sealed","card_transfer"),
    record(5,1,"applied","choice_resolution",9)
  ]);
  const x=inspect(ledger);
  assert.equal(x.ok,true);
  assert.equal(x.summary.effectCount,2);
  assert.equal(x.summary.sealedCount,1);
  assert.equal(x.summary.appliedWithoutSeal,1);
  assert.equal(classify(ledger,0).code,"EFFECT_REPLAY_ALREADY_ACCOUNTED");
  assert.equal(classify(ledger,1).code,"EFFECT_REPLAY_OUTCOME_UNKNOWN");
  never(x);
});
test("duplicate intents, applies, seals and skipped effect identifiers are rejected",()=>{
  assert.equal(inspect(make([
    record(1,0,"intent"),record(2,0,"intent")
  ])).code,"EFFECT_FENCE_DUPLICATE_OR_UNORDERED_INTENT");
  assert.equal(inspect(make([
    record(1,2,"intent")
  ])).code,"EFFECT_FENCE_DUPLICATE_OR_UNORDERED_INTENT");
  assert.equal(inspect(make([
    record(1,0,"intent"),record(2,0,"applied"),record(3,0,"applied")
  ])).code,"EFFECT_FENCE_DUPLICATE_OR_REORDERED_APPLY");
  assert.equal(inspect(make([
    record(1,0,"intent"),record(2,0,"applied"),
    record(3,0,"state_sealed"),record(4,0,"state_sealed")
  ])).code,"EFFECT_FENCE_UNSEALED_APPLY");
});
test("missing stages, event or type substitution fail closed",()=>{
  assert.equal(inspect(make([record(1,0,"applied")])).code,
    "EFFECT_FENCE_ORPHAN_OR_MISMATCHED_STAGE");
  assert.equal(inspect(make([
    record(1,0,"intent"),record(2,0,"state_sealed")
  ])).code,"EFFECT_FENCE_UNSEALED_APPLY");
  assert.equal(inspect(make([
    record(1,0,"intent"),record(2,0,"applied","card_transfer")
  ])).code,"EFFECT_FENCE_ORPHAN_OR_MISMATCHED_STAGE");
  assert.equal(inspect(make([
    record(1,0,"intent"),record(2,0,"applied","hp_change",8)
  ])).code,"EFFECT_FENCE_ORPHAN_OR_MISMATCHED_STAGE");
  assert.equal(inspect(make([record(2,0,"intent")])).code,
    "EFFECT_FENCE_RECORD_INVALID");
});
test("untrusted claims, unknown effect types and payload injection cannot grant replay",()=>{
  assert.equal(emptyV3EffectFence("short"),null);
  assert.equal(inspect(make([], {readyToResume:true})).ok,false);
  assert.equal(inspect(make([], {stateCheckpointAtomic:true})).ok,false);
  assert.equal(inspect(make([], {engineAdapterInstalled:true})).ok,false);
  assert.equal(inspect(make([], {eventContinuationCaptured:true})).ok,false);
  const withHand=record(1,0,"intent");
  withHand.hiddenCards=["do-not-leak"];
  const answer=inspect(make([withHand]));
  assert.equal(answer.ok,false);
  assert.doesNotMatch(JSON.stringify(answer),/do-not-leak/);
  assert.equal(inspect(make([record(1,0,"intent","unknown")] )).ok,false);
  assert.equal(classify(make([]),"0").executionAuthorized,false);
});
test("malicious getters and stale records cannot expose private values",()=>{
  const rec=record(1,0,"intent");
  Object.defineProperty(rec,"type",{enumerable:true,get(){throw Error("SECRET")}});
  const x=inspect(make([rec]));
  assert.equal(x.ok,false);
  assert.doesNotMatch(JSON.stringify(x),/SECRET/);
  const forged=make([], {records: Array.from({length:4097},(_,i)=>
    record(i+1,i,"intent"))});
  assert.equal(inspect(forged).code,"EFFECT_FENCE_SCHEMA_UNTRUSTED");
});
test("none of crash scenarios may execute a synthetic side effect",()=>{
  const examples=[
    make([]),
    make([record(1,0,"intent")]),
    make([record(1,0,"intent"),record(2,0,"applied")]),
    make([record(1,0,"intent"),record(2,0,"applied"),
      record(3,0,"state_sealed")])
  ];
  let replayCalls=0;
  for(const l of examples){
    const permission=classify(l,0);
    if(permission.executionAuthorized)replayCalls++;
    assert.equal(permission.executionAuthorized,false);
    assert.equal(permission.readyToResume,false);
  }
  assert.equal(replayCalls,0);
});
