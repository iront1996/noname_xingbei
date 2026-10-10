import test from "node:test";
import assert from "node:assert/strict";
import {
  readV3MechanicalStateSample as read,
  createV3MechanicalDeltaObserver as create
} from "../game/v3-mechanical-state-delta.mjs";
const player=(hp=4,maxHp=4,hujia=0)=>({hp,maxHp,hujia,
  playerid:"PRIVATE_ID",secretHand:["HIDDEN_CARD"]});
const zone=count=>({children:{length:count,secretCards:["SECRET"]}});
const intent=count=>({status:"EFFECT_INTENT_CALLS_ONLY",totalCalls:count});
const make=(players,pile=30,discard=0)=>read(players,zone(pile),zone(discard));
const safe=output=>{
  assert.equal(output.appliedEffectsProven,false);
  assert.equal(output.sideEffectsCaptured,false);
  assert.equal(output.stateCheckpointAtomic,false);
  assert.equal(output.completeCoverage,false);
  assert.equal(output.restorable,false);
  assert.equal(output.readyToResume,false);
  assert.doesNotMatch(JSON.stringify(output),/PRIVATE_ID|HIDDEN_CARD|SECRET|playerid/);
};
test("read native primitive HP and zone totals without card or player payloads",()=>{
  const p=[player(),player(3)];
  const sample=make(p,22,10);
  assert.ok(sample);
  assert.strictEqual(sample.rows[0].reference,p[0]);
  assert.equal(sample.rows[1].hp,3);
  const j=create({getScope:()=>"room"});
  safe(j.observe(sample,intent(0)));
  safe(j.snapshot());
});
test("HP and pile changes are observed in a window but not claimed applied effects",()=>{
  const p=[player(),player()];
  const j=create({getScope:()=>"room"});
  let s=j.observe(make(p,30,0),intent(2));
  assert.equal(s.status,"STATE_DELTA_BASELINE_ONLY");
  p[0].hp=2;
  s=j.observe(make(p,29,1),intent(3));
  assert.equal(s.status,"STATE_DELTA_WINDOWS_OBSERVED");
  assert.equal(s.comparedWindows,1);
  assert.equal(s.hpChangedWindows,1);
  assert.equal(s.hpChangedSeats,1);
  assert.equal(s.pileChangedWindows,1);
  assert.equal(s.windowsWithIntentCalls,1);
  assert.equal(s.hpChangeWithoutIntentWindows,0);
  safe(s);
});
test("state can change without these scheduling methods; do not invent causality",()=>{
  const p=[player(),player()],j=create({getScope:()=>"room"});
  j.observe(make(p),intent(0));
  p[0].hp=3;
  const s=j.observe(make(p,29,1),intent(0));
  assert.equal(s.hpChangeWithoutIntentWindows,1);
  assert.equal(s.pileChangeWithoutIntentWindows,1);
  assert.equal(s.windowsWithIntentCalls,0);
  safe(s);
});
test("API call without mechanical change is not a committed game effect",()=>{
  const p=[player(),player()],j=create({getScope:()=>"room"});
  j.observe(make(p),intent(0));
  const s=j.observe(make(p),intent(7));
  assert.equal(s.windowsWithIntentCalls,1);
  assert.equal(s.hpChangedWindows,0);
  assert.equal(s.pileChangedWindows,0);
  safe(s);
});
test("reordered seats, changed membership, and counter resets never create false deltas",()=>{
  const p=[player(),player()],j=create({getScope:()=>"room"});
  j.observe(make(p),intent(7));
  p[0].hp=2;
  let s=j.observe(make(p.slice().reverse()),intent(8));
  assert.equal(s.topologyResets,1);
  assert.equal(s.comparedWindows,0);
  s=j.observe(make(p),intent(2));
  assert.equal(s.topologyResets,2);
  assert.equal(s.comparedWindows,0);
  safe(s);
});
test("separate rooms reset and cannot cross-link state or intent counters",()=>{
  const p=[player(),player()];
  let room="A";
  const j=create({getScope:()=>room});
  j.observe(make(p),intent(1));
  p[1].hp=2;j.observe(make(p),intent(2));
  assert.equal(j.snapshot().comparedWindows,1);
  room="B";
  const s=j.snapshot();
  assert.equal(s.samples,0);
  assert.equal(s.comparedWindows,0);
  assert.equal(s.status,"STATE_DELTA_BASELINE_NOT_READY");
  safe(s);
});
test("invalid numeric values or getter property never execute payloads",()=>{
  const p=[player(),player()],j=create({getScope:()=>"A"});
  const target=p[0];
  let calls=0;
  Object.defineProperty(target,"hp",{get(){calls++;throw Error("PRIVATE")},enumerable:true});
  assert.equal(make(p),null);
  assert.equal(calls,0);
  const s=j.observe(null,intent(1));
  assert.equal(s.status,"STATE_DELTA_SAMPLE_INVALID");
  assert.equal(s.invalidSamples,1);
  safe(s);
  assert.equal(make([player(),player(4000)]),null);
  assert.equal(make([player(),player()],-1,1),null);
});
test("invalid scope or saturated intent counters never certify coverage",()=>{
  let scope=null;
  const p=[player(),player()],j=create({getScope:()=>scope});
  assert.equal(j.observe(make(p),intent(0)).status,"STATE_DELTA_NOT_ACTIVE");
  scope="real";
  j.observe(make(p),intent(0));
  const s=j.observe(make(p),{status:"EFFECT_INTENT_COUNTER_OVERFLOW",totalCalls:1});
  assert.equal(s.topologyResets,1);
  assert.equal(s.comparedWindows,0);
  safe(s);
});
