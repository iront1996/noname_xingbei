import test from "node:test";
import assert from "node:assert/strict";
import {auditV3PlayerHistory as audit} from "../game/v3-player-history-audit.mjs";

// A deliberately narrow fake of get.stringifiedResult and get.itemtype:
// executable and event-bearing history must never be marked restorable.
function itemtype(item) {
  if (item && item.__event === true) return "event";
  if (item && item.__player === true) return "player";
  if (item && item.__card === true) return "card";
  return Array.isArray(item) ? "array" : "object";
}
function engineSerialize(item, depth=8) {
  if (item && item.__event) return "_noname_event:{}";
  if (item && item.__player) return "_noname_player:TEST";
  if (item && item.__card) return "_noname_card:[\"card\",\"fire\",2,\"attack\",false]";
  if (typeof item==="function") return "_noname_func:function(){}";
  if (Array.isArray(item)) return depth ? item.map(x=>engineSerialize(x,depth-1)) : [];
  if (item && typeof item==="object") {
    if (!depth) return {};
    return Object.fromEntries(Object.entries(item).map(([k,v])=>[k,engineSerialize(v,depth-1)]));
  }
  return item;
}
const empty = () => ({
  stat:[{card:{},skill:{}}],
  actionHistory:[{useCard:[],respond:[],lose:[],gain:[],damage:[],useSkill:[]}],
  skipList:[]
});
test("empty initial history passes but is explicitly not restorable",()=>{
  const v=audit(empty(),engineSerialize,itemtype);
  assert.equal(v.ok,true);
  assert.equal(v.restorable,false);
  assert.ok(Array.isArray(v.execution.actionHistory));
  assert.equal(JSON.stringify(v).includes("TEST"),false);
});
test("completed and active event references are never treated as replayable",()=>{
  const f=empty();
  f.actionHistory[0].useCard.push({__event:true,player:{__player:true}});
  const v=audit(f,engineSerialize,itemtype);
  assert.deepEqual(v,{ok:false,code:"HIST_ACTION_LIVE_EVENT_NOT_RESTORABLE",execution:null});
});
test("history nested serialization loss reports field category, not hidden content",()=>{
  const f=empty();f.actionHistory[0].custom=[{a:{b:{c:{d:{e:{f:{g:{private:"secret hand data"}}}}}}}}];
  const v=audit(f,engineSerialize,itemtype);
  assert.equal(v.ok,false);
  assert.equal(v.code,"HIST_ACTION_DEFINED_FIELD_TRUNCATED");
  assert.equal(JSON.stringify(v).includes("secret hand data"),false);
});
test("stats and skipped phases are audited independently",()=>{
  const f=empty();f.stat[0].skill.foo=()=>42;
  assert.equal(audit(f,engineSerialize,itemtype).code,"HIST_STAT_EXECUTABLE_FUNCTION_NOT_RESTORABLE");
  const s=empty();s.skipList.push(undefined);
  assert.equal(audit(s,engineSerialize,itemtype).code,"HIST_SKIP_ARRAY_UNDEFINED_OR_HOLE");
});
test("unsupported shapes and exceptions never embed raw data in error codes",()=>{
  const f=empty();f.actionHistory=null;
  assert.equal(audit(f,engineSerialize,itemtype).code,"HIST_ACTION_NOT_ARRAY");
  const g=empty();
  assert.equal(audit(g,()=>{throw Error("secret token");},itemtype).code,"HIST_STAT_ENCODING_FAILED");
  assert.equal(audit(g,engineSerialize,null).code,"HIST_ENGINE_SERIALIZER_UNAVAILABLE");
});
test("invalid serialization stays fail-closed and never returns partial execution",()=>{
  const f=empty();f.skipList=[{__event:true}];
  const v=audit(f,engineSerialize,itemtype);
  assert.equal(v.ok,false);
  assert.equal(v.execution,null);
  assert.equal(v.code,"HIST_SKIP_LIVE_EVENT_NOT_RESTORABLE");
});
