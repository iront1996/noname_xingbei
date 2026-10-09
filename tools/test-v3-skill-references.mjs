// node --test tools/test-v3-skill-references.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { materializeStagedSkillReferences as materialize } from "../game/v3-skill-references.mjs";

const cardInfo = id => "_noname_card:" + JSON.stringify([id, "feng", 2, "gongJi", null]);
function fixture() {
  const owner = { playerid:"owner", storage:{original:true}, phaseNumber:1 };
  const guest = { playerid:"guest", storage:{original:true}, phaseNumber:1 };
  const card = { cardid:"c1", name:"gongJi", xiBie:"feng", mingGe:2, duYou:null };
  const sections = storage => ({
    skills:[],hiddenSkills:[],invisibleSkills:[],
    additionalSkills:{},disabledSkills:{},tempSkills:{},storage
  });
  const history = () => ({ stat:[{}],actionHistory:[{}],skipList:[],phaseNumber:7 });
  const runtime = {
    players:new Map([
      ["owner",{
        player:owner,serializedSkillState:sections({
          teammate:"_noname_player:guest",pickedCard:cardInfo("c1"),
          infinite:"_noname_infinity"
        }),serializedHistory:history()
      }],
      ["guest",{
        player:guest,serializedSkillState:sections({}),serializedHistory:history()
      }]
    ]),
    cards:new Map([["c1",card]])
  };
  const staged = {ok:true,readyToResume:false,authoritativeRuntimeRebuilt:false,runtime};
  return {staged,owner,guest,card};
}
test("strict card/player references resolve to detached original objects only",()=>{
  const {staged,owner,guest,card}=fixture();
  const result=materialize(staged);
  assert.equal(result.ok,true);
  assert.equal(owner.storage.teammate,guest);
  assert.equal(owner.storage.pickedCard,card);
  assert.equal(owner.storage.infinite,Infinity);
  assert.equal(owner.phaseNumber,7);
  assert.equal(result.readyToResume,false);
});
test("missing card fails without applying earlier prepared player changes",()=>{
  const {staged,owner,guest}=fixture();
  staged.runtime.players.get("guest").serializedSkillState.storage=
    {invalid:cardInfo("unknown")};
  const before=owner.storage;
  const result=materialize(staged);
  assert.equal(result.ok,false);
  assert.equal(result.code,"UNKNOWN_CARD_REFERENCE");
  assert.equal(owner.storage,before);
  assert.deepEqual(guest.storage,{original:true});
});
test("untrusted functions and unfinished events never execute",()=>{
  for(const marker of ["_noname_func:evil", "_noname_event:123", "_noname_vcard:123"]){
    const {staged}=fixture();
    staged.runtime.players.get("owner").serializedSkillState.storage.bad=marker;
    const result=materialize(staged);
    assert.equal(result.ok,false);
    assert.equal(result.code,"UNSUPPORTED_EXECUTABLE_REFERENCE");
  }
});
test("card metadata mismatch refuses reference identity confusion",()=>{
  const {staged}=fixture();
  staged.runtime.cards.get("c1").name="anotherCard";
  assert.equal(materialize(staged).code,"CARD_REFERENCE_MISMATCH");
});
test("prototype pollution and overly deep data fail closed",()=>{
  const {staged}=fixture();
  const malicious=JSON.parse('{"__proto__":{"polluted":true}}');
  staged.runtime.players.get("owner").serializedSkillState.storage=malicious;
  assert.equal(materialize(staged).code,"UNSAFE_PROPERTY_NAME");
  assert.equal({}.polluted,undefined);
  const next=fixture();
  let nested={};const root=nested;
  for(let i=0;i<36;i++){nested.x={};nested=nested.x;}
  next.staged.runtime.players.get("owner").serializedSkillState.storage=root;
  assert.equal(materialize(next.staged).code,"RESTORE_STRUCTURE_LIMIT");
});
test("write failure rolls back every previous staged mutation",()=>{
  const {staged,owner,guest}=fixture();
  const old=owner.storage;
  Object.defineProperty(guest,"storage",{get:()=>({original:true}),set(){throw new Error("refuse")},configurable:true});
  const result=materialize(staged);
  assert.equal(result.ok,false);
  assert.equal(result.code,"STAGED_ASSIGNMENT_FAILED");
  assert.equal(owner.storage,old);
});
