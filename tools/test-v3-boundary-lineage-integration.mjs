import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";
import {inspectV3TurnBoundaryStack} from "../game/v3-event-observation-preflight.mjs";
import {inspectV3EventCutQueues} from "../game/v3-event-cut-audit.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(root,path),"utf8");
const phase=()=>({name:"phaseLoop",player:{playerid:"private"},next:[],after:[],finished:false});

test("onphase active-child relationship is classified consistently by cut and strict blocker",()=>{
  const child=phase(), parent={name:"root",next:[child],after:[],finished:false};
  const stack=[parent,child];
  assert.equal(inspectV3EventCutQueues(stack).code,"CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED");
  assert.deepEqual(inspectV3TurnBoundaryStack(stack),{
    ok:false,code:"BOUNDARY_ACTIVE_LINEAGE_AWAITING_COMPLETION",restorable:false
  });
});
test("an extra queued sibling prevents saving even if its active child is recognized",()=>{
  const child=phase(), parent={name:"root",next:[child,{}],after:[],finished:false};
  assert.equal(inspectV3EventCutQueues([parent,child]).additionalAncestorNext,1);
  assert.equal(inspectV3TurnBoundaryStack([parent,child]).code,"BOUNDARY_ANCESTOR_WORK_PENDING");
});
test("status is fed into the actual onphase capture blocker before storage",()=>{
  const vault=read("game/v3-recovery-vault.mjs");
  const hook=vault.slice(vault.indexOf('lib.onphase.push(() => {'));
  assert.ok(hook.includes("inspectV3TurnBoundaryStack("));
  assert.ok(hook.includes("recordCaptureOutcome(\"CAPTURE_BLOCKED\", barrier.code"));
  assert.ok(hook.indexOf("if (!barrier.ok)")<hook.indexOf('void saveCandidate("turn_boundary")'));
  assert.match(vault,/safeCheckpointCertified: false/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/restorable: false/);
});
test("display version and ESM recovery module instance are aligned",()=>{
  const entry=read("mode/connect.js");
  const owner=read("game/v3-owner-connection.mjs");
  const importPath=owner.match(/from "\.\/v3-recovery-vault\.mjs\?v=([^"]+)";/);
  assert.equal(importPath?.[1],"v3-effect-intent-17");
  assert.ok(owner.includes('前端版本：v3-effect-intent-17'));
  assert.ok(owner.includes("installV3RecoveryVault();"));
  assert.ok(entry.includes('/game/v3-owner-connection.mjs?v='+importPath[1]+'"'));
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
