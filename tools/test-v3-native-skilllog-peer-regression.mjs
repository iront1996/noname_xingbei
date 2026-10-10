import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {indexV3InertHistoryReferences} from "../game/v3-inert-history-reference-index.mjs";
import {classifyV3HostPeerTopology} from "../game/v3-peer-topology.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(resolve(root,path),"utf8");
const player=read("noname/library/element/player.js");
const content=read("noname/library/element/content.js");
const owner=read("game/v3-owner-connection.mjs");
const entry=read("mode/connect.js");
const kind=x=>x?.__event?"event":x?.__player?"player":"object";
const row=entry=>({useCard:[],respond:[],skipped:[],lose:[],gain:[],
  sourceDamage:[],damage:[],custom:[],useSkill:[entry]});
test("engine source proves no log skill target line is a legitimate false value",()=>{
  assert.match(player,/logSkill\(name, targets, nature, logv, args\)/);
  assert.match(player,/targets: targets,/);
  assert.match(content,/info\.logLine === false \? false : targets/);
  const event={__event:true,finished:true};
  const history=indexV3InertHistoryReferences([[row({
    skill:"private-skill",targets:false,event
  })]],kind,[],ref=>({observed:ref===event,ordinal:17,outcome:"fulfilled"}));
  assert.equal(history.ok,true);
  assert.equal(history.ledger.eventReferenceCount,1);
  assert.equal(history.ledger.slots[0].referenceKind,"skill_log");
  assert.equal(history.restorable,false);
  assert.doesNotMatch(JSON.stringify(history),/private-skill/);
});
test("no remote sockets is distinct from unsupported nonempty peer count",()=>{
  const host={playerid:"H"},bot={playerid:"B"};
  const topology=classifyV3HostPeerTopology({
    playerIds:["H","B"],playerOL:{H:host,B:bot},
    clients:[],observing:[],hostPlayerId:"H"
  });
  assert.deepEqual(topology,{ok:false,code:"PEER_NO_CONNECTED_GUEST",
    peerBindings:null,botPlayerIds:null});
});
test("v18 still contains passive intent observer and owner-first canonical vault",()=>{
  const vault=read("game/v3-recovery-vault.mjs");
  assert.match(vault,/installV3EffectIntentObserver\(/);
  assert.match(owner,/getV3EffectIntentHealth\(\)/);
  assert.match(owner,/前端版本：v3-mechanical-delta-19/);
  assert.match(owner,/from "\.\/v3-recovery-vault\.mjs\?v=v3-mechanical-delta-19"/);
  assert.match(entry,/import\("\/game\/v3-owner-connection\.mjs\?v=v3-mechanical-delta-19"\)/);
  assert.doesNotMatch(owner,/game\.send\("server",\s*"v3ready"/);
  assert.match(vault,/safeCheckpointCertified: false/);
  assert.match(vault,/eventContinuationCaptured: false/);
  assert.match(vault,/restorable: false/);
});
