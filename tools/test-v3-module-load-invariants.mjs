import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const get=path=>readFileSync(resolve(base,path),"utf8");

test("owner UI and capture worker reuse the same versioned recovery vault instance",()=>{
  const connect=get("mode/connect.js");
  const owner=get("game/v3-owner-connection.mjs");
  const connected=connect.match(/import\("\/game\/v3-recovery-vault\.mjs\?v=([^"]+)"\)/);
  const ownerImport=owner.match(/from "\.\/v3-recovery-vault\.mjs\?v=([^"]+)";/);
  assert.ok(connected,"V3 connect must have a versioned import");
  assert.ok(ownerImport,"V3 owner must import the same versioned vault");
  assert.equal(connected[1],ownerImport[1],"a duplicate ESM module would break capture status sharing");
  assert.match(connect,/v3-owner-connection\.mjs\?v=/);
});

test("reload probe remains read-only and cannot resume by checking a candidate",()=>{
  const owner=get("game/v3-owner-connection.mjs");
  const fn=owner.slice(owner.indexOf("lib.message.client.v3roomstatus ="),owner.indexOf("lib.message.client.v3restoreprobeDenied ="));
  assert.ok(fn.includes('"v3restoreprobe"'));
  assert.ok(!fn.includes('"v3resume"'));
  assert.ok(!fn.includes('"v3ready"'));
});

test("candidate snapshot cannot certify unfinished event continuation",()=>{
  const vault=get("game/v3-recovery-vault.mjs");
  assert.ok(vault.includes("safeCheckpointCertified: false"));
  assert.ok(vault.includes("eventContinuationCaptured: false"));
  assert.ok(vault.includes("restorable: false"));
});

test("mixed human/AI topology travels from capture through safe shadow registry",()=>{
  const vault=get("game/v3-recovery-vault.mjs");
  const gate=get("game/v3-host-authority-gate.mjs");
  const blueprint=get("game/v3-rehydration-blueprint.mjs");
  const stager=get("game/v3-host-runtime-stager.mjs");
  const registry=get("game/v3-host-registry-transaction.mjs");
  assert.match(vault,/classifyV3HostPeerTopology\(/);
  assert.match(vault,/botPlayerIds: topology\.botPlayerIds|const botPlayerIds = topology\.botPlayerIds/);
  assert.match(gate,/const botPlayerIds = data\.botPlayerIds/);
  assert.match(blueprint,/botPlayerIds: Object\.freeze/);
  assert.match(stager,/blueprint\.botPlayerIds/);
  assert.match(registry,/blueprint\.botPlayerIds/);
  assert.doesNotMatch(vault,/guestBindings\.length !== ids\.length - 1/);
  assert.doesNotMatch(gate,/claim\.guestSocketIds\.length !== playerIds\.length - 1/);
});

test("V3 passive GameEvent journal and history linkage do not bypass existing recovery gate",()=>{
  const vault=get("game/v3-recovery-vault.mjs");
  const owner=get("game/v3-owner-connection.mjs");
  const journal=get("game/v3-event-lifecycle-journal.mjs");
  const history=get("game/v3-inert-history-reference-index.mjs");
  assert.match(vault,/installV3EventLifecycleObserver\(/);
  assert.match(vault,/getV3EventLifecycleHealth/);
  assert.match(vault,/getV3HistoryReferenceLinkHealth/);
  assert.match(vault,/eventLifecycleJournal\.lookup\(event\)/);
  assert.match(owner,/getV3HistoryReferenceLinkHealth\(/);
  assert.match(journal,/Reflect\.apply\(original,this,args\)/);
  assert.match(journal,/return result;/);
  assert.match(journal,/completeCoverage:false/);
  assert.match(history,/HISTORY_EVENT_PROMISE_NOT_FULFILLED/);
  assert.match(vault,/safeCheckpointCertified: false/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/restorable: false/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
