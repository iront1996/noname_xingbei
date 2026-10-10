import test from "node:test";
import assert from "node:assert/strict";
import {
 V3_EFFECT_INTENT_METHODS as METHODS,
 createV3EffectIntentObserver as journal,
 installV3EffectIntentObserver as install
} from "../game/v3-effect-intent-observer.mjs";

function mock(){
  class Player{}
  const seen=[];
  const result={privateHand:"a secret"};
  for(const method of METHODS){
    Object.defineProperty(Player.prototype,method,{
      configurable:true,writable:true,value(...args){
        seen.push({method,args,thisValue:this});
        return result;
      }
    });
  }
  return {Player,seen,result};
}
test("native API wrappers preserve same this, argument identity and return object",()=>{
  const {Player,seen,result}=mock();
  let scope="ROOM";
  const j=journal({getScope:()=>scope});
  const original=Player.prototype.damage;
  const tool=install(Player,j);
  assert.equal(tool.installed,true);
  const p=new Player(), privateData={privateCard:"do not expose"};
  assert.strictEqual(p.damage(privateData),result);
  assert.strictEqual(seen[0].thisValue,p);
  assert.strictEqual(seen[0].args[0],privateData);
  assert.equal(j.snapshot().counts.damage,1);
  assert.equal(j.snapshot().totalCalls,1);
  assert.equal(j.snapshot().methodsInstrumented,7);
  assert.equal(j.snapshot().sideEffectsCaptured,false);
  assert.equal(j.snapshot().engineAdapterInstalled,false);
  assert.equal(j.snapshot().stateCheckpointAtomic,false);
  assert.equal(j.snapshot().readyToResume,false);
  assert.doesNotMatch(JSON.stringify(j.snapshot()),/do not expose|secret|ROOM/);
  assert.equal(tool.uninstall(),true);
  assert.strictEqual(Player.prototype.damage,original);
});
test("all seven native API schedules counted, but zero proof of application",()=>{
  const {Player}=mock(), p=new Player();
  const j=journal({getScope:()=>"ROOM"}),tool=install(Player,j);
  for(const method of METHODS)p[method]();
  const snapshot=j.snapshot();
  assert.equal(snapshot.totalCalls,METHODS.length);
  assert.deepEqual(Object.values(snapshot.counts),METHODS.map(()=>1));
  assert.equal(snapshot.sideEffectsCaptured,false);
  assert.equal(snapshot.restorable,false);
  tool.uninstall();
});
test("native exceptions keep same identity, are only counted anonymously",()=>{
  const {Player}=mock();
  const err=new Error("secret engine data");
  Player.prototype.gain=function(){throw err};
  const j=journal({getScope:()=>"ROOM"}),tool=install(Player,j);
  assert.throws(()=>new Player().gain(),e=>e===err);
  const snapshot=j.snapshot();
  assert.equal(snapshot.totalCalls,1);
  assert.equal(snapshot.failedCalls,1);
  assert.equal(snapshot.counts.gain,1);
  assert.equal(JSON.stringify(snapshot).includes("secret engine data"),false);
  tool.uninstall();
});
test("distinct rooms are isolated and no room token leaves the observer",()=>{
  const {Player}=mock();
  let room="ROOM A";
  const j=journal({getScope:()=>room}),tool=install(Player,j);
  new Player().damage();
  assert.equal(j.snapshot().totalCalls,1);
  room="ROOM B";
  assert.equal(j.snapshot().totalCalls,0);
  new Player().draw();
  assert.equal(j.snapshot().counts.damage,0);
  assert.equal(j.snapshot().counts.draw,1);
  tool.uninstall();
});
test("counter overflow is explicit and does not claim to cover all effects",()=>{
  const {Player}=mock(),j=journal({getScope:()=>"ROOM",limit:2});
  const tool=install(Player,j);
  for(let i=0;i<5;i++)new Player().damage();
  const x=j.snapshot();
  assert.equal(x.status,"EFFECT_INTENT_COUNTER_OVERFLOW");
  assert.equal(x.counts.damage,2);
  assert.equal(x.totalCalls,2);
  assert.equal(x.completeCoverage,false);
  assert.equal(x.readyToResume,false);
  tool.uninstall();
});
test("missing native method rejects installation without partial monkey-patch",()=>{
  const {Player}=mock();
  const orig=Player.prototype.draw;
  delete Player.prototype.lose;
  const out=install(Player,journal({getScope:()=>"ROOM"}));
  assert.equal(out.installed,false);
  assert.equal(out.code,"EFFECT_INTENT_METHOD_UNAVAILABLE");
  assert.strictEqual(Player.prototype.draw,orig);
});
test("a second install is refused; uninstall restores all original methods",()=>{
  const {Player}=mock();
  const originals=new Map(METHODS.map(m=>[m,Player.prototype[m]]));
  const j=journal({getScope:()=>"ROOM"});
  const a=install(Player,j),b=install(Player,j);
  assert.equal(a.installed,true);
  assert.equal(b.code,"EFFECT_INTENT_ALREADY_INSTALLED");
  assert.equal(a.uninstall(),true);
  assert.equal(a.uninstall(),false);
  for(const m of METHODS)assert.strictEqual(Player.prototype[m],originals.get(m));
  const again=install(Player,j);
  assert.equal(again.installed,true);
  again.uninstall();
});
test("telemetry exceptions cannot affect engine scheduling results",()=>{
  const {Player,result}=mock();
  const j={observe(){throw Error("ignore diagnostics")},
    snapshot(){return {}}};
  const tool=install(Player,j);
  assert.strictEqual(new Player().draw({privateCard:"a"}),result);
  tool.uninstall();
});
test("invalid scope fails closed and never records calls",()=>{
  const {Player}=mock();
  const j=journal({getScope:()=>null}),tool=install(Player,j);
  new Player().damage();
  assert.equal(j.snapshot().status,"EFFECT_INTENT_NOT_ACTIVE");
  assert.equal(j.snapshot().totalCalls,0);
  tool.uninstall();
});
