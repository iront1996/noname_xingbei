import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const get=path=>readFileSync(resolve(root,path),"utf8");
const entry=get("mode/connect.js");
const owner=get("game/v3-owner-connection.mjs");
const vault=get("game/v3-recovery-vault.mjs");
const contract=get("game/v3-inert-event-evidence.mjs");

test("connect mode has one V3 bootstrap entry and no competing vault dynamic import",()=>{
  assert.equal((entry.match(/import\("\/game\/v3-owner-connection\.mjs\?v=/g)||[]).length,1);
  assert.doesNotMatch(entry,/import\("\/game\/v3-recovery-vault\.mjs\?v=/);
  assert.match(owner,/installV3RecoveryVault,/);
  const bootstrap=owner.slice(owner.indexOf("export function installV3OwnerConnection()"));
  assert.ok(bootstrap.indexOf("installV3RecoveryVault();")>=0);
  assert.ok(bootstrap.indexOf("installV3RecoveryVault();") <
    bootstrap.indexOf("installed = true;"));
  assert.ok(bootstrap.indexOf("installV3RecoveryVault();") <
    bootstrap.indexOf("installCaptureHealthButton();"));
});
test("owner and vault module build references use a single canonical V3 URL",()=>{
 const fromOwner=owner.match(/from "\.\/v3-recovery-vault\.mjs\?v=([^"]+)";/);
 const fromEntry=entry.match(/import\("\/game\/v3-owner-connection\.mjs\?v=([^"]+)"\)/);
 assert.equal(fromOwner?.[1],"v3-owner-bootstrap-15");
 assert.equal(fromOwner?.[1],fromEntry?.[1]);
 assert.match(owner,/前端版本：v3-owner-bootstrap-15/);
});
test("only installed real GameEvent observer may write nonempty encrypted evidence",()=>{
 assert.match(vault,/eventObserverInstallCode !== "OBSERVER_INSTALLED"/);
 assert.match(vault,/lifecycle\.started < 1 \|\| lifecycle\.seq < 1/);
 assert.match(contract,/lifecycle\.started===0 \|\| lifecycle\.seq===0/);
 assert.match(vault,/async function saveInertEventEvidence/);
 assert.match(vault,/void saveInertEventEvidence\(\);/);
 assert.match(vault,/safeCheckpointCertified: false/);
 assert.match(vault,/eventContinuationCaptured: false/);
 assert.match(vault,/restorable: false/);
 assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
});
