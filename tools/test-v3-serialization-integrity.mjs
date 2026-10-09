// node --test tools/test-v3-serialization-integrity.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { auditV3Serialization as audit } from "../game/v3-serialization-integrity.mjs";

const itemtype = value => value?.engineType;
test("valid defined fields and dropped undefined object properties survive",()=>{
  const source={skills:["skillA"],storage:{duration:3,expiry:undefined}};
  const serialized={skills:["skillA"],storage:{duration:3}};
  const report=audit(source,serialized,itemtype);
  assert.equal(report.ok,true);
  assert.equal(report.omittedUndefinedProperties,1);
  assert.equal(report.restorable,false);
});
test("silently truncated deeply nested fields are rejected",()=>{
  const original={};let cursor=original;
  for(let i=0;i<12;i++){cursor.next={};cursor=cursor.next;}
  cursor.turn=1;
  const result=audit(original,{next:{next:{}}},itemtype);
  assert.equal(result.ok,false);
  assert.equal(result.code,"DEFINED_FIELD_TRUNCATED");
});
test("live events and executable functions are not continuations",()=>{
  const event={engineType:"event"};
  assert.equal(
    audit({pending:event},{pending:"_noname_event:3"},itemtype).code,
    "LIVE_EVENT_NOT_RESTORABLE"
  );
  assert.equal(
    audit({effect:()=>1},{effect:"_noname_func:abc"},itemtype).code,
    "EXECUTABLE_FUNCTION_NOT_RESTORABLE"
  );
});
test("card and player references retain engine markers",()=>{
  const input={owner:{engineType:"player"},card:{engineType:"card"}};
  const output={owner:"_noname_player:H",card:"_noname_card:[\"C\",\"shui\",1,\"gongJi\",null]"};
  const result=audit(input,output,itemtype);
  assert.equal(result.ok,true);
  assert.equal(result.encodedCardRefs,1);
  assert.equal(result.encodedPlayerRefs,1);
});
test("array holes and undefined elements are rejected",()=>{
  assert.equal(audit([1,undefined],[1,null],itemtype).code,"ARRAY_UNDEFINED_OR_HOLE");
  assert.equal(audit([1,,3],[1,null,3],itemtype).code,"ARRAY_UNDEFINED_OR_HOLE");
});
test("non-json prototypes and changed primitives are rejected",()=>{
  assert.equal(audit({x:new Date(0)},{x:{}},itemtype).code,"UNSUPPORTED_OBJECT");
  assert.equal(audit({x:2},{x:3},itemtype).code,"PRIMITIVE_VALUE_CHANGED");
});
