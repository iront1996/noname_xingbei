#!/usr/bin/env node
/**
 * V2 isolated v1.7.2 gameplay delta contract.
 *
 * Runs the ACTUAL four upstream sources unchanged. This is not an alternate
 * gameplay implementation: extract the original method/filter bodies and
 * exercise them with deterministic stubs. All rule files are also compared
 * byte-for-byte against the original Git SHA by the review workflow.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const playerSource = readFileSync("noname/library/element/player.js", "utf8");
const characters = readFileSync("character/shenZiChuangLin.js", "utf8");
const traits = readFileSync("character/teDian.js", "utf8");
const update = readFileSync("game/update.js", "utf8");

function balancedBody(text, open) {
  assert.equal(text[open], "{");
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) {
      return text.slice(open + 1, i);
    }
  }
  throw new Error("Could not isolate original function");
}
function methodBody(source, signature) {
  const i = source.indexOf(signature);
  assert.ok(i !== -1, "Missing original method: " + signature);
  const start = source.indexOf("{", i + signature.length);
  assert.ok(start > i);
  return balancedBody(source, start);
}
function skillFilter(source, skillName) {
  const start = source.indexOf(skillName + ": {");
  assert.ok(start >= 0, "Missing original skill " + skillName);
  const filter = source.indexOf("filter: function (event, player) {", start);
  assert.ok(filter >= start && filter < start + 700, "Unexpected original filter layout");
  return balancedBody(source, source.indexOf("{", filter));
}

const method = methodBody(playerSource, "useSkillBackup(skill,result)");
assert.match(method, /info\.backup\(/);
assert.match(method, /\.sourceSkill = skill/);
assert.match(method, /game\.online/);
assert.match(method, /game\.broadcast/);
assert.match(method, /this\.useSkill\(/);

function runBackup({ online, chooseControl }) {
  const calls = { backup: [], useSkill: [], broadcast: [] };
  const result = { links: ["opaque-yanling"], cards: ["sample-card"], targets: ["sample-target"] };
  const player = { useSkill(...a) { calls.useSkill.push(a); } };
  const backup = { audio: "original-audio" };
  const lib = { skill: {} };
  const info = {
    chooseButton: {
      ...(chooseControl ? { chooseControl: true } : {}),
      backup(payload, who) {
        calls.backup.push([payload, who]);
        return backup;
      }
    }
  };
  const get = { info(name) { assert.equal(name, "zhenYanShu"); return info; } };
  const event = {};
  const game = {
    online,
    broadcast(fn, ...args) {
      calls.broadcast.push(args);
      fn(...args);
    }
  };
  const useSkillBackup = new Function("get","lib","game","event",
    "return function useSkillBackup(skill,result) {" + method + "}")(
    get,lib,game,event
  );
  useSkillBackup.call(player, "zhenYanShu", result, player);
  assert.equal(calls.backup.length,1);
  assert.equal(calls.backup[0][0],chooseControl?result:result.links);
  assert.equal(calls.backup[0][1],player);
  assert.equal(lib.skill.zhenYanShu_backup,backup);
  assert.equal(backup.sourceSkill,"zhenYanShu");
  assert.deepEqual(calls.useSkill,[["zhenYanShu_backup",result.cards,result.targets]]);
  if(online) {
    assert.equal(calls.broadcast.length,0);
    assert.deepEqual(event._sendskill,["zhenYanShu_backup",backup]);
  } else {
    assert.equal(calls.broadcast.length,1);
    assert.equal(lib.skill.zhenYanShu_backup.audio,"original-audio");
    assert.equal(event._sendskill,undefined);
  }
}
for (const online of [false,true]) for (const chooseControl of [false,true])
  runBackup({online,chooseControl});
console.log("V2_172_ORIGINAL_SKILL_BACKUP_OFFLINE_ONLINE_CONTRACT_PASS",4);

// BoYongZhiLi: missing event skill or missing info must not throw.
// The filter body here is the unmodified original source, not a replacement.
const filterBody = skillFilter(traits, "boYongZhiLi");
const skillInfo = new Map([["basic",{tag:{jiChuXiaoGuo:true}}],["plain",{tag:{}}]]);
const originalFilter = new Function("get", "return function(event,player) {" +
  filterBody + "}")({info: name => skillInfo.get(name)});
assert.equal(originalFilter({skill:null},{}),false);
assert.equal(originalFilter({skill:"unregistered"},{}),false);
assert.equal(originalFilter({skill:"plain"},{}),false);
assert.equal(originalFilter({skill:"basic"},{}),true);
console.log("V2_172_ORIGINAL_WAVE_FORCE_NULL_SKILL_GUARD_PASS",4);

// The rewritten original event contract must reference the generated
// backup event and pass the actual choice result to the original API.
const section = characters.slice(characters.indexOf("zhenYanYaZhi:{"),
 characters.indexOf("yanLing:{",characters.indexOf("zhenYanYaZhi:{")));
assert.ok(section.length>100 && section.length<3500);
assert.match(section,/zhenYanShu_backupContentAfterAfter/);
assert.match(section,/player\.chooseCardButton\(yanLing,1,/);
assert.match(section,/if\(result\.bool\)/);
assert.match(section,/player\.useSkillBackup\('zhenYanShu',result,player\)/);
assert.match(characters,/yaoJingMiShu:\s*\{[\s\S]*?zhenYanShu_backupContentAfterAfter/);
console.log("V2_172_ORIGINAL_TRUE_WORD_SKILL_TRIGGER_AND_CHOICE_PASS");

assert.match(update,/version:\s*"1\.7\.2"/);
assert.match(update,/update:\s*"1\.7\.2"/);
console.log("V2_172_OFFICIAL_VERSION_METADATA_PASS");
