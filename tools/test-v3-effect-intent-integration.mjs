import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {emptyV3EffectFence,inspectV3EffectReplayFence} from "../game/v3-effect-transaction-fence.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const get=path=>readFileSync(resolve(root,path),"utf8");
const vault=get("game/v3-recovery-vault.mjs");
const owner=get("game/v3-owner-connection.mjs");
const entry=get("mode/connect.js");
const engine=get("noname/library/element/player.js");
const observer=get("game/v3-effect-intent-observer.mjs");

test("all seven observed native APIs exist on engine Player prototype",()=>{
  for(const m of ["damage","recover","loseHp","changeHp","gain","lose","draw"]){
    assert.match(engine,new RegExp("\\n\\t"+m+"\\([^\\n]*\\) \\{"));
  }
});
test("V3 owner installs passive effect intent observer before health dialog exposure",()=>{
  assert.match(vault,/installV3EffectIntentObserver\(/);
  assert.match(vault,/lib\.element\?\.Player,effectIntentJournal/);
  assert.match(vault,/getV3EffectIntentHealth\(/);
  assert.match(owner,/getV3EffectIntentHealth\(\)/);
  assert.match(owner,/這些只是 API 呼叫，未證明效果已結算或可安全重播/);
  assert.match(owner,/v3-effect-intent-17/);
  assert.match(entry,/v3-effect-intent-17/);
  assert.match(owner,/installV3RecoveryVault\(\);/);
});
test("passive instrument does not peek native args or invoke a returned GameEvent",()=>{
  assert.match(observer,/Reflect\.apply\(descriptor\.value,this,args\)/);
  assert.match(observer,/return output;/);
  assert.doesNotMatch(observer,/\.then\(/);
  assert.doesNotMatch(observer,/JSON\.stringify\(args/);
  assert.doesNotMatch(observer,/get\.cardsInfo|game\.send|v3ready|v3resume/);
  assert.match(observer,/sideEffectsCaptured:false/);
  assert.match(observer,/stateCheckpointAtomic:false/);
  assert.match(observer,/readyToResume:false/);
});
test("effect safety fence remains disconnected from engine state replay",()=>{
  const fence=inspectV3EffectReplayFence(emptyV3EffectFence(
    "1234567890abcdef1234567890abcdef"));
  assert.equal(fence.ok,true);
  assert.equal(fence.summary.engineAdapterInstalled,undefined);
  assert.equal(fence.summary.stateCheckpointAtomic,false);
  assert.equal(fence.restorable,false);
  assert.equal(fence.readyToResume,false);
  assert.doesNotMatch(vault,/applyV3EffectReplay|replayEffects\(/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
