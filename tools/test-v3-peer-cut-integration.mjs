import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(root,path),"utf8");

test("native guest reconnection is diagnosed, not treated as a signed owner-safe identity mapping",()=>{
  const topology=read("game/v3-peer-topology.mjs");
  const gate=read("game/v3-host-authority-gate.mjs");
  const stager=read("game/v3-host-runtime-stager.mjs");
  assert.match(topology,/PEER_SOCKET_REBOUND_UNVERIFIED/);
  assert.match(topology,/PEER_OBSERVER_PRESENT/);
  assert.match(topology,/playerOL\[playerId\]\?\.ws !== client/);
  assert.match(topology,/playerId !== socketId/);
  assert.match(gate,/binding\.playerId !== binding\.socketId/);
  assert.match(stager,/route\.socketId !== route\.playerId/);
});
test("onphase captures active-child vs extra-sibling cut counts as non-restorable evidence",()=>{
  const cut=read("game/v3-event-cut-audit.mjs");
  const vault=read("game/v3-recovery-vault.mjs");
  const owner=read("game/v3-owner-connection.mjs");
  assert.match(cut,/activeLineageNext/);
  assert.match(cut,/additionalAncestorNext/);
  assert.match(cut,/CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED/);
  assert.match(vault,/summary:inspectV3EventCutQueues\(_status\.eventManager\?\.eventStack\)/);
  assert.match(owner,/activeLineageNext/);
  assert.match(owner,/additionalAncestorNext/);
  assert.match(cut,/safeCheckpointCertified:false/);
  assert.match(cut,/eventContinuationCaptured:false/);
  assert.match(cut,/readyToResume:false/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
test("front door and host share the exact v12 vault instance",()=>{
  const entry=read("mode/connect.js");
  const owner=read("game/v3-owner-connection.mjs");
  const match=owner.match(/from "\.\/v3-recovery-vault\.mjs\?v=([^"]+)";/);
  assert.equal(match?.[1],"v3-peer-cut-classification-12");
  assert.ok(entry.includes('/game/v3-recovery-vault.mjs?v='+match[1]+'"'));
  assert.ok(entry.includes('/game/v3-owner-connection.mjs?v='+match[1]+'"'));
});
