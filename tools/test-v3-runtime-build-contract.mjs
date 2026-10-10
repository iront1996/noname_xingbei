import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(base,path),"utf8");
const connect=read("mode/connect.js");
const owner=read("game/v3-owner-connection.mjs");
const vault=read("game/v3-recovery-vault.mjs");

test("owner UI, vault and entry imports agree on an actual build id",()=>{
 const ui=owner.match(/const V3_OWNER_INTERFACE_VERSION = "([^"]+)";/);
 const capture=vault.match(/export const V3_CAPTURE_IMPLEMENTATION_VERSION = "([^"]+)";/);
 assert.ok(ui,"owner UI must declare build");
 assert.ok(capture,"vault must declare build");
 assert.equal(ui[1],capture[1]);
 const version=ui[1];
 assert.ok(connect.includes('/game/v3-owner-connection.mjs?v='+version+'"'));
 assert.ok(connect.includes('/game/v3-recovery-vault.mjs?v='+version+'"'));
 assert.ok(owner.includes('from "./v3-recovery-vault.mjs?v='+version+'";'));
});
test("UI renders separately sourced version strings and warns if mismatched",()=>{
 assert.match(owner,/"房主 UI 版本：" \+ V3_OWNER_INTERFACE_VERSION/);
 assert.match(owner,/"快照程式版本：" \+ V3_CAPTURE_IMPLEMENTATION_VERSION/);
 assert.match(owner,/V3_OWNER_INTERFACE_VERSION !== V3_CAPTURE_IMPLEMENTATION_VERSION/);
});
test("recovery observation never claims event continuation certified",()=>{
 assert.match(vault,/safeCheckpointCertified: false/);
 assert.match(vault,/eventContinuationCaptured: false/);
 assert.match(vault,/playerHistoryCompletenessVerified: false/);
 assert.match(vault,/restorable: false/);
 assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"\s*,/);
 assert.match(vault,/inspectV3TurnBoundaryStack\(/);
 assert.match(vault,/inspectV3HistoryEventReferences\(/);
});
