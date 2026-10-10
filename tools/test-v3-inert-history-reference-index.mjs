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

test("lifecycle correlation requires actual observed fulfilled Promise per event identity",()=>{
  const x=event(true), y=event(true);
  const history=[[row({useCard:[x,y],respond:[x]})]];
  const evidence=new Map([[x,{observed:true,ordinal:9,outcome:"fulfilled"}],
    [y,{observed:true,ordinal:12,outcome:"fulfilled"}]]);
  const result=index(history,kind,[],ref=>evidence.get(ref));
  assert.equal(result.ok,true);
  assert.equal(result.readyToResume,false);
  assert.equal(result.ledger.lifecycleEvidence,"OBSERVED_FULFILLMENT_ONLY");
  assert.deepEqual(result.ledger.slots.map(slot=>slot.lifecycleOrdinal),[9,12,9]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
});
test("unobserved, pending or rejected Promise denies correlation even if finished=true",()=>{
  const e=event(true);
  const history=[[row({useCard:[e]})]];
  assert.equal(index(history,kind,[],()=>({observed:false})).code,
    "HISTORY_EVENT_NOT_JOURNALED");
  for(const outcome of ["pending","rejected","threw"]){
    assert.equal(index(history,kind,[],()=>({observed:true,ordinal:1,outcome})).code,
      "HISTORY_EVENT_PROMISE_NOT_FULFILLED");
  }
  assert.equal(index(history,kind,[],()=>({observed:true,ordinal:-1,outcome:"fulfilled"})).code,
    "HISTORY_JOURNAL_ORDINAL_INVALID");
  assert.equal(index(history,kind,[],()=>{throw Error("private data");}).code,
    "HISTORY_INDEX_UNAVAILABLE");
});

test("engine useSkill stores logInfo, not a GameEvent; index only its referenced Event",()=>{
  const skillEvent=event(true);
  const target={__player:true,secretHand:"DO_NOT_EXPOSE"};
  const skillLog={
    skill:"hidden_internal_skill",targets:[target],
    event:skillEvent,sourceSkill:"actual_parent",type:"player"
  };
  const itemtype=v=>v?.__event===true?"event":v?.__player===true?"player":"object";
  const result=index([[row({useSkill:[skillLog],useCard:[skillEvent]})]],
    itemtype,[],ref=>({observed:ref===skillEvent,ordinal:3,outcome:"fulfilled"}));
  assert.equal(result.ok,true);
  assert.equal(result.ledger.distinctEventCount,1);
  assert.equal(result.ledger.duplicateReferenceCount,1);
  assert.equal(result.ledger.slots.length,2);
  assert.equal(result.ledger.slots[1].referenceKind,"skill_log");
  assert.equal(result.ledger.slots[1].lifecycleOrdinal,3);
  const output=JSON.stringify(result);
  assert.doesNotMatch(output,/hidden_internal_skill|DO_NOT_EXPOSE|actual_parent|secretHand/);
  assert.equal(result.readyToResume,false);
});
test("malformed useSkill logs reject unrecognized fields or invalid player targets",()=>{
  const itemtype=v=>v?.__event?"event":v?.__player?"player":"object";
  const e=event(true);
  const probe=log=>index([[row({useSkill:[log]})]],itemtype,[]);
  assert.equal(probe({skill:"a",targets:[],event:e,secretHand:"x"}).code,
    "HISTORY_SKILL_LOG_FIELD_UNSUPPORTED");
  assert.equal(probe({skill:"a",targets:[{unknown:1}],event:e}).code,
    "HISTORY_SKILL_LOG_TARGET_SHAPE_INVALID");
  assert.equal(probe({skill:"a",targets:[],event:{bad:true}}).code,
    "HISTORY_SKILL_LOG_EVENT_INVALID");
  assert.equal(probe({skill:"",targets:[],event:e}).code,
    "HISTORY_SKILL_LOG_EVENT_INVALID");
});
test("engine history isSkipped metadata is boolean and cannot invoke getter",()=>{
  const v=row();v.isSkipped=true;
  assert.equal(build([[v]]).ok,true);
  const bad=row();bad.isSkipped="true";
  assert.equal(build([[bad]]).code,"HISTORY_METADATA_INVALID");
  const accessor=row();Object.defineProperty(accessor,"isMe",{enumerable:true,
    get(){throw Error("PRIVATE")}})
  assert.equal(build([[accessor]]).code,"HISTORY_ACCESSOR_UNSUPPORTED");
});
