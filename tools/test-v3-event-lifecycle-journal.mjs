import test from "node:test";
import assert from "node:assert/strict";
import {
  createV3EventLifecycleJournal as journal,
  installV3EventLifecycleObserver as install
} from "../game/v3-event-lifecycle-journal.mjs";

const deferred=()=>{
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej});
  return {promise,resolve,reject};
};
test("original start Promise identity and fulfillment timing remain intact",async()=>{
  const d=deferred();
  class GameEvent {start(){return d.promise}}
  let room="R";
  const j=journal({getScope:()=>room});
  const old=GameEvent.prototype.start;
  const tool=install(GameEvent,j);
  assert.equal(tool.installed,true);
  const e=new GameEvent();
  const promise=e.start();
  assert.strictEqual(promise,d.promise);
  assert.equal(j.snapshot().pending,1);
  d.resolve("unchanged-result");
  assert.equal(await promise,"unchanged-result");
  await Promise.resolve();
  const snapshot=j.snapshot();
  assert.equal(snapshot.started,1);
  assert.equal(snapshot.fulfilled,1);
  assert.equal(snapshot.pending,0);
  assert.deepEqual(snapshot.records.map(x=>x.transition),["started","fulfilled"]);
  assert.equal(snapshot.completeCoverage,false);
  assert.equal(snapshot.eventContinuationCaptured,false);
  assert.equal(snapshot.readyToResume,false);
  assert.equal(tool.uninstall(),true);
  assert.strictEqual(GameEvent.prototype.start,old);
});
test("rejected Promise is still rejected to the original caller",async()=>{
  const error=new Error("secret internal rejection");
  class Event{start(){return Promise.reject(error)}}
  const j=journal({getScope:()=>"R"});
  const observer=install(Event,j);
  const promise=new Event().start();
  await assert.rejects(promise,e=>e===error);
  await Promise.resolve();
  assert.equal(j.snapshot().rejected,1);
  assert.equal(JSON.stringify(j.snapshot()).includes("secret"),false);
  assert.equal(observer.uninstall(),true);
});
test("throwing start preserves original synchronous exception",()=>{
  const err=new Error("game error");
  class Event{start(){throw err}}
  const j=journal({getScope:()=>"R"}), observer=install(Event,j);
  assert.throws(()=>new Event().start(),e=>e===err);
  assert.equal(j.snapshot().threw,1);
  observer.uninstall();
});
test("room change invalidates previous pending and old Promise observers",async()=>{
  const d=deferred();let room="R";
  class Event{start(){return d.promise}}
  const j=journal({getScope:()=>room}), observer=install(Event,j);
  new Event().start();
  assert.equal(j.snapshot().pending,1);
  room="NEW";
  assert.equal(j.snapshot().pending,0);
  d.resolve();
  await d.promise; await Promise.resolve();
  assert.equal(j.snapshot().fulfilled,0);
  observer.uninstall();
});
test("duplicate starts of same event count only once",async()=>{
  const d=deferred();
  class Event{start(){return d.promise}}
  const j=journal({getScope:()=>"R"}),observer=install(Event,j);
  const e=new Event();
  e.start();e.start();
  assert.equal(j.snapshot().started,1);
  d.resolve();await d.promise;await Promise.resolve();
  assert.equal(j.snapshot().fulfilled,1);
  observer.uninstall();
});
test("overflow, invalid scope and privacy bounds never imply journal completeness",()=>{
  const j=journal({getScope:()=>"R",capacity:8});
  const before=j.snapshot();
  assert.equal(before.completeCoverage,false);
  for(let i=0;i<10;i++)j.started({});
  const out=j.snapshot();
  assert.equal(out.status,"OBSERVATION_OVERFLOW");
  assert.equal(out.started,8);
  assert.equal(out.pending,8);
  assert.equal(out.overflowed,true);
  assert.equal(out.records.length,8);
  assert.equal(Object.prototype.hasOwnProperty.call(out,"scope"),false);
  assert.deepEqual(journal({getScope:()=>null}).snapshot(),{
    schema:"xingbei-v3-event-lifecycle-observation-1",
    status:"NOT_ACTIVE_OWNER",restorable:false,
    eventContinuationCaptured:false,completeCoverage:false,readyToResume:false
  });
});
test("reinstall refused and original start method restored on uninstall",()=>{
  class Event {start(){return Promise.resolve()}}
  const j=journal({getScope:()=>"R"});
  const one=install(Event,j),two=install(Event,j);
  assert.equal(one.installed,true);
  assert.deepEqual(two,{installed:false,code:"OBSERVER_ALREADY_INSTALLED"});
  assert.equal(one.uninstall(),true);
  assert.equal(one.uninstall(),false);
  const three=install(Event,j);
  assert.equal(three.installed,true);
  three.uninstall();
});
test("not a promise is observed as unsupported without changing value",()=>{
  class Event{start(){return "test-result"}}
  const j=journal({getScope:()=>"R"}),tool=install(Event,j);
  assert.equal(new Event().start(),"test-result");
  assert.equal(j.snapshot().threw,1);
  assert.equal(j.snapshot().readyToResume,false);
  tool.uninstall();
});
test("unavailable or hostile telemetry never changes original game result",async()=>{
  const badJournal={
    started(){throw Error("telemetry failure")},
    settle(){throw Error("telemetry failure")}
  };
  class Event{start(){return Promise.resolve(5)}}
  const obs=install(Event,badJournal);
  assert.equal(await new Event().start(),5);
  obs.uninstall();
});
