import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const load=path=>readFileSync(resolve(base,path),"utf8");
const vault=load("game/v3-recovery-vault.mjs");
const owner=load("game/v3-owner-connection.mjs");
const connect=load("mode/connect.js");

test("V3-only actual onphase hook stores bounded anonymous queue counts",()=>{
  const start=vault.indexOf('lib.onphase.push(() => {');
  assert.ok(start>0);
  const body=vault.slice(start);
  assert.ok(body.includes('summary:inspectV3EventCutQueues(_status.eventManager?.eventStack)'));
  assert.ok(body.indexOf("summary:inspectV3EventCutQueues") <
    body.indexOf("inspectV3TurnBoundaryStack("));
  assert.match(vault,/lastBoundaryCut\.ownerSocket !== game\.ws/);
  assert.match(vault,/lastBoundaryCut\.roomId !== game\.roomId/);
  assert.match(vault,/export function getV3LastBoundaryCutHealth\(/);
});
test("owner UI displays live and at-boundary queues but never labels them resumable",()=>{
  assert.match(owner,/getV3EventCutHealth\(\)/);
  assert.match(owner,/getV3LastBoundaryCutHealth\(\)/);
  assert.match(owner,/上次換回合切點/);
  assert.match(owner,/事件切點只提供阻斷證據，尚不可恢復原局/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
  assert.match(vault,/safeCheckpointCertified: false/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/restorable: false/);
});
test("single recovery vault instance shared by owner UI and connect entry",()=>{
  const version=owner.match(/from "\.\/v3-recovery-vault\.mjs\?v=([^"]+)";/);
  assert.ok(version);
  assert.ok(connect.includes('/game/v3-owner-connection.mjs?v='+version[1]+'"'));
  assert.ok(owner.includes("installV3RecoveryVault();"));
});
