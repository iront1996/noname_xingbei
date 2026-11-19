#!/usr/bin/env node
/** Exact old->new original public release delta: 2 source-inventory entries and one Genesis skill fix. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const base="f0510164518037dda1c330849dd6754d10ca1b19";
const old=path=>execFileSync("git",["show",base+":"+path],{encoding:"utf8",maxBuffer:16*1024*1024});
const current=path=>readFileSync(path,"utf8");
const extension="extension/创世纪/extension.js";
const first='await target.faShuDamage(1, player, "nocard");';
const second='await target.faShuDamage(2, player, "nocard");';
const before=old(extension).split("\n");
const after=current(extension).split("\n");
assert.equal(after.length,before.length,"Original Genesis extension line count changed");
const changes=before.flatMap((value,i)=>value===after[i]?[]:[i]);
assert.equal(changes.length,1,"Genesis public extension contains unreviewed gameplay edits");
const line=changes[0];
assert.equal(before[line].trim(),first,"Original skill damage source differs");
assert.equal(after[line].trim(),second,"Published skill damage is not exactly original v2.7");
assert.match(before[line-1],/if\(target && target\.isIn\(\)\)/);
assert.match(before[line-2],/var target = event\.target/);
const oldInfo=old("extension/创世纪/info.json");
assert.equal(oldInfo.split('"version": "2.6"').length-1,1);
assert.equal(current("extension/创世纪/info.json"),
  oldInfo.replace('"version": "2.6"','"version": "2.7"'),
  "Genesis published metadata differs beyond authorized original version update");
const inventory=current("game/source.js");
const tutorialCss='\"layout/mode/tutorial.css\",';
const tutorialModule='\"mode/tutorial-scene.js\",';
assert.equal(inventory.split(tutorialCss).length-1,1);
assert.equal(inventory.split(tutorialModule).length-1,1);
const reconstructed=inventory.split("\n").filter(line=>!line.includes(tutorialCss)&&!line.includes(tutorialModule)).join("\n");
assert.equal(reconstructed,old("game/source.js"),
  "Published original source manifest differs beyond 2 tutorial source entries");
console.log("V2_172_OFFICIAL_GENESIS_DAMAGE_1_TO_2_AND_TUTORIAL_INVENTORY_ONLY_PASS");
