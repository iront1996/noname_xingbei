import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createV3XingbeiStateDeltaObserver,readV3XingbeiState
} from "../game/v3-xingbei-state-delta.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const get=path=>readFileSync(resolve(root,path),"utf8");
const vault=get("game/v3-recovery-vault.mjs");
const owner=get("game/v3-owner-connection.mjs");
const entry=get("mode/connect.js");
const mechanics=get("game/v3-xingbei-state-delta.mjs");
const mode=get("mode/xingBei.js");
const engine=get("noname/game/index.js");

test("the current V3 sampling uses Xingbei own data, NEVER legacy HP",()=>{
  assert.match(vault,/createV3XingbeiStateDeltaObserver/);
  assert.match(vault,/readV3XingbeiState\(/);
  assert.match(vault,/get\.mode\(\)==="xingBei"/);
  assert.match(vault,/sampleV3XingbeiDelta\(\);/);
  assert.match(vault,/getV3XingbeiStateHealth\(/);
  assert.doesNotMatch(vault,/readV3MechanicalStateSample|sampleV3MechanicalDelta/);
  assert.doesNotMatch(mechanics,/\.hp\b|\.maxHp\b|\.hujia\b/);
  assert.match(mechanics,/hongShiQi/);
  assert.match(mechanics,/lanShiQi/);
  assert.match(mechanics,/hongZhanJi/);
  assert.match(mechanics,/zhiLiao/);
  assert.match(mechanics,/Object\.getOwnPropertyDescriptor/);
  assert.match(mechanics,/appliedEffectsProven:false/);
  assert.match(mechanics,/atomicStateCheckpoint:false/);
});
test("state fields are sourced from actual Xingbei engine and win condition",()=>{
  assert.match(engine,/hongShiQi=0/);
  assert.match(engine,/lanShiQi=0/);
  assert.match(engine,/hongXingBei=0/);
  assert.match(engine,/lanXingBei=0/);
  assert.match(mode,/game\.hongShiQi<=0/);
  assert.match(mode,/game\.lanShiQi<=0/);
});
test("V3 UI explicitly distinguishes game rules from generic game engine API",()=>{
  assert.match(owner,/星杯規則狀態取樣/);
  assert.match(owner,/傷害通常導致摸牌/);
  assert.match(owner,/治療是抵禦傷害的資源/);
  assert.match(owner,/非星杯規則資源/);
  assert.doesNotMatch(owner,/體力變更區間|牌堆變更區間/);
  assert.match(owner,/前端版本：v3-xingbei-rule-state-20/);
  assert.match(owner,/from "\.\/v3-recovery-vault\.mjs\?v=v3-xingbei-rule-state-20"/);
  assert.match(entry,/import\("\/game\/v3-owner-connection\.mjs\?v=v3-xingbei-rule-state-20"\)/);
  assert.doesNotMatch(entry,/import\("\/game\/v3-recovery-vault\.mjs/);
  assert.match(owner,/installV3RecoveryVault\(\);/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/restorable: false/);
});
test("changes to morale are not incorrectly interpreted as HP transaction replay",()=>{
  const p=[{zhiLiao:1,hp:20,playerid:"PRIVATE"},
    {zhiLiao:2,hp:100,playerid:"SECRET"}];
  const g={hongShiQi:15,lanShiQi:15,hongXingBei:0,lanXingBei:0,
    hongZhanJi:["baoShi"],lanZhanJi:["shuiJing"]};
  const observer=createV3XingbeiStateDeltaObserver({getScope:()=>"A"});
  const mk=()=>readV3XingbeiState(g,p,{children:{length:100}},{children:{length:50}});
  observer.observe(mk(),{status:"EFFECT_INTENT_CALLS_ONLY",totalCalls:0});
  g.hongShiQi=14;
  const verdict=observer.observe(mk(),{status:"EFFECT_INTENT_CALLS_ONLY",totalCalls:0});
  assert.equal(verdict.moraleWindows,1);
  assert.equal(verdict.appliedEffectsProven,false);
  assert.equal(verdict.restorable,false);
  assert.doesNotMatch(JSON.stringify(verdict),/PRIVATE|SECRET|hp/);
});
