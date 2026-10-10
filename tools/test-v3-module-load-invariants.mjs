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
