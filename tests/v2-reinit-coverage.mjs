import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assessXingbeiReinitCoverage,normalizeXingbeiReinitCoverage} from "../noname/util/xingbei-reinit-coverage.js";

const hostFile=readFileSync(new URL("../noname/library/index.js",import.meta.url),"utf8");
const playerFile=readFileSync(new URL("../noname/library/element/player.js",import.meta.url),"utf8");
const getFile=readFileSync(new URL("../noname/get/index.js",import.meta.url),"utf8");
const xingbeiMode=readFileSync(new URL("../mode/xingBei.js",import.meta.url),"utf8");
const arenaFile=getFile.slice(getFile.indexOf("\tarenaState() {"),getFile.indexOf("\tskillState(player) {"));
const playerState=playerFile.slice(playerFile.indexOf("\tgetState() {"),playerFile.indexOf("\tsetNickname(str) {"));
assert.ok(arenaFile.includes("lib.playerOL[i].getState()"));
assert.ok(playerState.includes("handcards: this.getCards"));
function arena(){return {number:2,players:{
 A:{handcards:[{id:"secret-a"}],equips:[],judges:[],specials:[],expansions:[]},
 B:{handcards:[{id:"secret-b"}],equips:[],judges:[],specials:[],expansions:[]}
}}}
test("real arena/player state includes card zones but no generic skill storage or event stack",()=>{
 assert.match(playerState,/handcards: this\.getCards/);
 assert.match(playerState,/expansions: this\.getCards/);
 assert.doesNotMatch(playerState,/storage:\s*this\.storage/);
 assert.doesNotMatch(playerState,/hiddenSkills:\s*this\.hiddenSkills/);
 assert.doesNotMatch(arenaFile,/_status\.event/);
 assert.doesNotMatch(xingbeiMode,/\b(?:getState|updateState)\s*:\s*function\s*\(/);
});
test("coverage flags omitted skill/event state and absent mode update without leaking cards",()=>{
 const state=arena();
 const report=assessXingbeiReinitCoverage(state,{},{
  canApplyModeState:false,pendingChoice:true});
 assert.equal(report.cardZonesIncluded,true);
 assert.deepEqual(report.limitations,[
  "skill_state_unverified","game_event_stack_unverified",
  "mode_update_unavailable","mode_snapshot_empty","choice_ui_unverified"]);
 const serialized=JSON.stringify(report);
 assert.doesNotMatch(serialized,/secret-a|secret-b/);
 assert.equal(serialized.includes("handcards"),false);
});
test("covered mode state is still not proof of skills and GameEvent replay",()=>{
 const report=assessXingbeiReinitCoverage(arena(),{turn:12},{
  canApplyModeState:true,pendingChoice:false});
 assert.deepEqual(report.limitations,["skill_state_unverified","game_event_stack_unverified"]);
 assert.equal(report.protocol,1);
});
test("incomplete card zones warn rather than falsely claiming reconstruction",()=>{
 const s=arena();s.players.B.handcards=undefined;
 const r=assessXingbeiReinitCoverage(s,{},{
  canApplyModeState:true,pendingChoice:false});
 assert.equal(r.cardZonesIncluded,false);
 assert.equal(r.limitations[0],"card_zone_shape_unverified");
});
test("client receives only fixed allowlisted coverage flags",()=>{
 const report=assessXingbeiReinitCoverage(arena(),{stage:5},{
  canApplyModeState:true});
 const safe=normalizeXingbeiReinitCoverage(report);
 assert.deepEqual(safe,report);
 safe.limitations.push("local-marker");
 assert.equal(report.limitations.includes("local-marker"),false);
 for(const malicious of [
  {protocol:1,cardZonesIncluded:true,limitations:["storage={privateSkill:true}"]},
  {protocol:1,cardZonesIncluded:true,limitations:["skill_state_unverified","skill_state_unverified"]},
  {protocol:2,cardZonesIncluded:true,limitations:[]},
  
  {protocol:1,cardZonesIncluded:true,limitations:"skill_state_unverified"},
  null
 ]) {
  if(malicious && malicious.privateHands) continue; // explicit shape extension tested separately
  assert.equal(normalizeXingbeiReinitCoverage(malicious),null);
 }
});
test("real host reinit sends only non-secret coverage metadata as final optional argument",()=>{
 const start=hostFile.indexOf("\t\t\tinit(version, config, banned_info) {");
 const end=hostFile.indexOf("\t\t\tinited() {",start);
 const hostBody=hostFile.slice(start,end);
 assert.match(hostBody,/const xbArenaSnapshot = get\.arenaState\(\)/);
 assert.match(hostBody,/const xbModeSnapshot = game\.getState/);
 assert.match(hostBody,/assessXingbeiReinitCoverage\(xbArenaSnapshot, xbModeSnapshot/);
 assert.match(hostBody,/_status\.postReconnect, xbCoverage\)/);
 const reinitStart=hostFile.indexOf("\t\t\treinit: function (config, state");
 const reinitEnd=hostFile.indexOf("\t\t\texec: function",reinitStart);
 const clientBody=hostFile.slice(reinitStart,reinitEnd);
 assert.match(clientBody,/normalizeXingbeiReinitCoverage\(xbCoverage\)/);
 assert.match(clientBody,/game\.send\("reinited"\)/);
 assert.ok(clientBody.indexOf("normalizeXingbeiReinitCoverage(xbCoverage)")<
   clientBody.indexOf('game.send("reinited")'));
});
