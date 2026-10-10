import test from "node:test";
import assert from "node:assert/strict";
import {indexV3InertHistoryReferences as index} from "../game/v3-inert-history-reference-index.mjs";

const event=(finished=true)=>({__event:true,finished,hiddenHand:"PRIVATE"});
const kind=obj=>obj?.__event===true?"event":"object";
const row=({useCard=[],respond=[],skipped=[],lose=[],gain=[],sourceDamage=[],damage=[],custom=[],useSkill=[]}={})=>
  ({useCard,respond,skipped,lose,gain,sourceDamage,damage,custom,useSkill});
const build=(histories,stack=[])=>index(histories,kind,stack);

test("event identity is preserved across turns and buckets without serializing content",()=>{
  const a=event(),b=event();
  const result=build([[row({useCard:[a,b],respond:[a]}),row({useSkill:[b],skipped:["phaseUse"]})]]);
  assert.equal(result.ok,true);
  assert.deepEqual(result.ledger.slots.map(s=>s.eventOrdinal),[0,1,0,1]);
  assert.equal(result.ledger.distinctEventCount,2);
  assert.equal(result.ledger.eventReferenceCount,4);
  assert.equal(result.ledger.duplicateReferenceCount,2);
  assert.equal(result.eventContinuationCaptured,false);
  assert.equal(result.restorable,false);
  assert.equal(result.readyToResume,false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
});
test("separate host and guest history indices have no player identities",()=>{
  const a=event();
  const out=build([[row({useCard:[a]})],[row({lose:[a]})]]);
  assert.deepEqual(out.ledger.slots.map(s=>s.playerIndex),[0,1]);
  assert.equal(out.ledger.distinctEventCount,1);
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE|HOST_TOKEN|playerid|wsid/);
});
test("history event whose finished flag is true is still NOT a runnable continuation",()=>{
  const e=event();
  const out=build([[row({useCard:[e]})]]);
  assert.equal(out.ok,true);
  assert.equal(out.restorable,false);
  assert.equal("continuation" in out.ledger,false);
});
test("active, unfinished, unverified-finished events are rejected without partial data",()=>{
  const a=event();
  assert.deepEqual(build([[row({useCard:[a]})]],[a]),
    {ok:false,code:"HISTORY_EVENT_IN_ACTIVE_STACK",ledger:null,restorable:false,readyToResume:false});
  assert.equal(build([[row({respond:[event(false)]})]]).code,"HISTORY_EVENT_NOT_SETTLED_PROVEN");
  const missing={__event:true};
  assert.equal(build([[row({respond:[missing]})]]).code,"HISTORY_EVENT_NOT_SETTLED_PROVEN");
});
test("rejects unknown custom buckets, non-events and malformed slot arrays",()=>{
  const withCustom=row();withCustom.unsafe={private:"SECRET"};
  assert.equal(build([[withCustom]]).code,"HISTORY_UNKNOWN_FIELD");
  assert.equal(build([[row({gain:[{value:1}]})]]).code,"HISTORY_ENTRY_NOT_EVENT");
  const hole=new Array(1);
  assert.equal(build([[row({useCard:hole})]]).code,"HISTORY_ARRAY_HOLE");
  assert.equal(build([[row({skipped:[42]})]]).code,"HISTORY_ENTRY_NOT_EVENT");
});
test("getters are never executed, even when nested in an accepted history shape",()=>{
  let invoked=0;
  const withAccessor=row();
  Object.defineProperty(withAccessor,"useCard",{enumerable:true,get(){invoked++;return [event()]}});
  assert.equal(build([[withAccessor]]).code,"HISTORY_ACCESSOR_UNSUPPORTED");
  assert.equal(invoked,0);
  const e={__event:true};Object.defineProperty(e,"finished",{get(){invoked++;return true}});
  assert.equal(build([[row({useCard:[e]})]]).code,"HISTORY_EVENT_NOT_SETTLED_PROVEN");
  assert.equal(invoked,0);
});
test("frozen output and bounded input block oversized event indexes",()=>{
  const tooMany=Array.from({length:4097},()=>event());
  assert.equal(build([[row({damage:tooMany})]]).code,"HISTORY_INDEX_LIMIT_EXCEEDED");
  assert.equal(build(Array.from({length:9},()=>[row()])).code,"HISTORY_INDEX_INPUT_INVALID");
  assert.equal(build([[row()]],null).code,"HISTORY_INDEX_INPUT_INVALID");
  const good=build([[row({useCard:[event()]})]]);
  assert.equal(Object.isFrozen(good.ledger.slots),true);
  assert.equal(Object.isFrozen(good.ledger.slots[0]),true);
});
