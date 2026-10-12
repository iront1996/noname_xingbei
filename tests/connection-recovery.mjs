import assert from "node:assert/strict";
import { ConnectionRecovery } from "../noname/util/xingbei-connection-recovery.js";

function fixture(overrides={}) {
  let now=0, id=0;
  const tasks=new Map(), calls=[];
  const manager=new ConnectionRecovery({
    connect:(endpoint,cb)=>calls.push({endpoint,cb}),
    now:()=>now,
    setTimer:(fn,delay)=>{ const key=++id; tasks.set(key,{fn,due:now+delay});return key; },
    clearTimer:key=>tasks.delete(key),
    ...overrides
  });
  const tick=ms=>{
    const end=now+ms;
    for (;;) {
      const upcoming=[...tasks].filter(([,v])=>v.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];
      if (!upcoming) break;
      now=upcoming[1].due;
      tasks.delete(upcoming[0]);
      upcoming[1].fn();
    }
    now=end;
  };
  return {manager,calls,tick};
}
{
  const x=fixture();
  x.manager.start("wss://test.invalid", {wasInGame:true});x.tick(0);
  x.calls[0].cb(true);
  assert.equal(x.manager.phase,"SYNCING");
  assert.equal(x.manager.synchronized("roomlist"),false);
  assert.equal(x.manager.synchronized("reinit"),true);
  assert.equal(x.manager.phase,"RECOVERED");
}
{
  const x=fixture();
  x.manager.start("wss://test.invalid");x.tick(0);
  x.calls[0].cb(false);x.tick(2000);
  assert.equal(x.calls.length,2);
  x.calls[0].cb(true);
  assert.equal(x.manager.phase,"CONNECTING","stale callback ignored");
  x.calls[1].cb(true);
  x.manager.connectionLost();x.tick(4000);
  assert.equal(x.calls.length,3);
}
{
  const x=fixture();
  x.manager.start("wss://test.invalid",{wasInGame:false});x.tick(0);
  x.calls[0].cb(true);
  assert.equal(x.manager.synchronized("roomlist"),true);
}
{
  const x=fixture();
  x.manager.start("wss://test.invalid");x.tick(0);
  x.manager.reject("banned");x.calls[0].cb(true);x.tick(200000);
  assert.equal(x.calls.length,1);
}
{
  let exhausted=0;
  const x=fixture({maxElapsedMs:4000,onExhausted:()=>exhausted++});
  x.manager.start("wss://test.invalid");x.tick(0);
  x.calls[0].cb(false);x.tick(2000);
  x.calls[1].cb(false);x.tick(2000);
  assert.equal(x.manager.phase,"EXHAUSTED");
  assert.equal(exhausted,1);
}
console.log("PASS: connection recovery state machine");
