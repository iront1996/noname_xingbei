import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createV3MechanicalDeltaObserver,readV3MechanicalStateSample
} from "../game/v3-mechanical-state-delta.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const get=path=>readFileSync(resolve(root,path),"utf8");
const vault=get("game/v3-recovery-vault.mjs");
const owner=get("game/v3-owner-connection.mjs");
const entry=get("mode/connect.js");
const mechanical=get("game/v3-mechanical-state-delta.mjs");

test("mechanical sampling uses only primitive HP and public pile totals",()=>{
  assert.match(vault,/createV3MechanicalDeltaObserver/);
  assert.match(vault,/readV3MechanicalStateSample\(/);
  assert.match(vault,/ui\.cardPile,ui\.discardPile/);
  assert.match(vault,/sampleV3MechanicalDelta\(\);/);
  assert.match(vault,/getV3MechanicalStateHealth\(/);
  assert.match(mechanical,/Object\.getOwnPropertyDescriptor\(object,key\)/);
  assert.doesNotMatch(mechanical,/getCards\(|get\.cardsInfo|\.skills|\.storage|\.playerid|\.name\b|\.eventStack|\.send\(/);
  assert.match(mechanical,/appliedEffectsProven:false/);
  assert.match(mechanical,/stateCheckpointAtomic:false/);
});
test("same owner/V3-only ESM instance exposes sampled counters without recovery permits",()=>{
  assert.match(owner,/getV3MechanicalStateHealth\(\)/);
  assert.match(owner,/機械狀態取樣/);
  assert.match(owner,/定期取樣不能確認副作用來源或原子結算/);
  assert.match(owner,/前端版本：v3-mechanical-delta-19/);
  assert.match(owner,/from "\.\/v3-recovery-vault\.mjs\?v=v3-mechanical-delta-19"/);
  assert.match(entry,/import\("\/game\/v3-owner-connection\.mjs\?v=v3-mechanical-delta-19"\)/);
  assert.doesNotMatch(entry,/import\("\/game\/v3-recovery-vault\.mjs/);
  assert.match(owner,/installV3RecoveryVault\(\);/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/safeCheckpointCertified: false/);
  assert.match(vault,/restorable: false/);
});
test("normal HP and card-zone changes remain only a sampled correlation, not committed transactions",()=>{
  const p=[{hp:4,maxHp:4,hujia:0,secret:"PRIVATE"},
    {hp:3,maxHp:4,hujia:0,secret:"SECRET"}];
  const j=createV3MechanicalDeltaObserver({getScope:()=>"A"});
  const mk=()=>readV3MechanicalStateSample(p,
    {children:{length:20}},{children:{length:5}});
  j.observe(mk(),{status:"EFFECT_INTENT_CALLS_ONLY",totalCalls:0});
  p[0].hp=3;
  const result=j.observe(mk(),{status:"EFFECT_INTENT_CALLS_ONLY",totalCalls:0});
  assert.equal(result.hpChangeWithoutIntentWindows,1);
  assert.equal(result.appliedEffectsProven,false);
  assert.equal(result.restorable,false);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|SECRET/);
});
