#!/usr/bin/env node
/** V2 official live-only tutorial 1.7.2 provenance and module dependency lock. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const original="27ad858dbeea5da35fc434cc226b0302792d2ba3";
const files={
 "mode/tutorial.js":"21fcb831288ef2c4187afc92d932744295daddf0",
 "mode/tutorial-scene.js":"98bb573fac247f2587e326bb4db34a0485d83e0f",
 "layout/mode/tutorial.css":"d2c62047229e1608a453ba903d89edd2d7013aa5"
};
const source=JSON.parse(readFileSync("ops/v2-official-publication.json","utf8"));
assert.deepEqual(source.publishedOnlyFiles.slice().sort(),
 ["layout/mode/tutorial.css","mode/tutorial-scene.js"]);
for(const [path,sha] of Object.entries(files)){
 const actual=execFileSync("git",["rev-parse","HEAD:"+path],{encoding:"utf8"}).trim();
 assert.equal(actual,sha,"official public-only asset bytes modified "+path);
 assert.ok(source.publishedTextOverlays.includes(path),"missing official overlay "+path);
}
const officialGit=execFileSync("git",["rev-parse",original+":mode/tutorial.js"],{encoding:"utf8"}).trim();
assert.equal(officialGit,"15f9bec4520a9f94fcd1712b867c2b0e8d1060ca");
assert.notEqual(officialGit,files["mode/tutorial.js"],"official public tutorial not represented");
for(const p of ["mode/tutorial-scene.js","layout/mode/tutorial.css"]){
 const r=spawnSync("git",["cat-file","-e",original+":"+p]);
 assert.notEqual(r.status,0,"Original master gained extra path; provenance must be re-evaluated "+p);
}
const tutorial=readFileSync("mode/tutorial.js","utf8");
const scene=readFileSync("mode/tutorial-scene.js","utf8");
const css=readFileSync("layout/mode/tutorial.css","utf8");
for(const imp of ["./tutorial-scene.js","./xingBei.js","../noname.js"])
 assert.ok(tutorial.includes(imp),"missing original tutorial dependency "+imp);
assert.match(tutorial,/startRuleTutorial/);
assert.match(scene,/export function startRuleTutorial/);
assert.match(scene,/game\.createEvent\("ruleTutorial"/);
assert.match(css,/\.tutorial-battle-hint/);
assert.match(css,/\.tutorial-focus/);
console.log("V2_172_OFFICIAL_TUTORIAL_SOURCE_DEPENDENCIES_PASS",JSON.stringify(files));
