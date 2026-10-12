import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {captureXingbeiOwnPoisonSources,applyXingbeiOwnPoisonSources} from "../noname/util/xingbei-v2-skill-resume.js";
function setup(){
 const alice={playerid:"seatA",storage:{}};
 const bob={playerid:"seatB",storage:{secretSkill:{hand:"secret-private"}}};
 const carol={playerid:"seatC",storage:{lockedSkill:"hidden"}};
 return {alice,bob,carol,roster:{seatA:alice,seatB:bob,seatC:carol}};
}
test("only own poison source references captured, no hidden skill storage",()=>{
 const f=setup();f.alice.storage.zhongDu=[f.bob,f.bob,f.carol];
 const report=captureXingbeiOwnPoisonSources("seatA",f.alice,f.roster);
 assert.deepEqual(report,{protocol:1,seatId:"seatA",zhongDuSources:["seatB","seatB","seatC"]});
 assert.doesNotMatch(JSON.stringify(report),/secret-private|hidden|hand|lockedSkill/);
 assert.deepEqual(f.alice.storage.zhongDu,[f.bob,f.bob,f.carol]);
});
test("forged source object, unknown seat, cross-seat capture fail closed",()=>{
 const f=setup();
 f.alice.storage.zhongDu=[{playerid:"seatB",storage:{secret:"X"}}];
 assert.equal(captureXingbeiOwnPoisonSources("seatA",f.alice,f.roster),null);
 f.alice.storage.zhongDu=[{playerid:"other"}];
 assert.equal(captureXingbeiOwnPoisonSources("seatA",f.alice,f.roster),null);
 f.alice.storage.zhongDu=[f.bob];
 assert.equal(captureXingbeiOwnPoisonSources("seatB",f.alice,f.roster),null);
});
test("absent poison list yields no sidecar; empty is legitimate",()=>{
 const f=setup();
 assert.equal(captureXingbeiOwnPoisonSources("seatA",f.alice,f.roster),null);
 f.alice.storage.zhongDu=[];
 assert.deepEqual(captureXingbeiOwnPoisonSources("seatA",f.alice,f.roster),
   {protocol:1,seatId:"seatA",zhongDuSources:[]});
});
test("client references newly reconstructed players without triggering events",()=>{
 const host=setup();host.alice.storage.zhongDu=[host.bob,host.bob,host.carol];
 const wire=captureXingbeiOwnPoisonSources("seatA",host.alice,host.roster);
 const current=setup();let triggers=0;
 for(const seat of Object.values(current.roster)){
  seat.addSkill=()=>{triggers++};seat.markSkill=()=>{triggers++};
  seat.createEvent=()=>{triggers++};
 }
 current.alice.storage.zhongDu=["obsolete"];
 assert.equal(applyXingbeiOwnPoisonSources(wire,"seatA",current.roster),true);
 assert.deepEqual(current.alice.storage.zhongDu,[current.bob,current.bob,current.carol]);
 assert.equal(triggers,0);
 assert.equal(current.bob.storage.secretSkill.hand,"secret-private");
});
test("invalid or oversized payload rejects without partial mutation",()=>{
 const f=setup();f.alice.storage.zhongDu=["old"];
 const good={protocol:1,seatId:"seatA",zhongDuSources:["seatB"]};
 for(const bad of [
  null,{...good,seatId:"seatB"},{...good,protocol:2},
  {...good,zhongDuSources:["seatB","wrong"]},
  {...good,zhongDuSources:["seatB"],storage:{steal:true}},
  {...good,zhongDuSources:["seatB",{}]},
  {...good,zhongDuSources:Array(33).fill("seatB")},
  {...good,zhongDuSources:"seatB"},["seatB"]
 ]){
  assert.equal(applyXingbeiOwnPoisonSources(bad,"seatA",f.roster),false);
  assert.deepEqual(f.alice.storage.zhongDu,["old"]);
 }
});
test("missing player or storage fails closed",()=>{
 const f=setup(),r={protocol:1,seatId:"seatA",zhongDuSources:["seatB"]};
 assert.equal(applyXingbeiOwnPoisonSources(r,"seatA",{}),false);
 delete f.alice.storage;
 assert.equal(applyXingbeiOwnPoisonSources(r,"seatA",f.roster),false);
});
test("actual Xingbei card stores source Player references",()=>{
 const code=readFileSync(new URL("../card/xingBei.js",import.meta.url),"utf8");
 assert.match(code,/target\.storage\.zhongDu\.push\(player\)/);
});
test("real reinit host sends own sidecar; guest applies only after roster",()=>{
 const src=readFileSync(new URL("../noname/library/index.js",import.meta.url),"utf8");
 const h=src.slice(src.indexOf("\t\t\tinit(version, config, banned_info) {"),
   src.indexOf("\t\t\tinited() {"));
 assert.match(h,/captureXingbeiOwnPoisonSources\(this\.id, player, lib\.playerOL\)/);
 assert.match(h,/_status\.postReconnect, xbCoverage, xbOwnPoison\)/);
 const guest=src.slice(src.indexOf("\t\t\treinit: function (config, state"),
  src.indexOf("\t\t\texec: function (func) {"));
 const rosterAt=guest.indexOf("lib.playerOL[i] = player;");
 const effectAt=guest.indexOf("applyXingbeiOwnPoisonSources(xbOwnPoison");
 const ackAt=guest.indexOf('game.send("reinited")');
 assert.ok(rosterAt>=0 && effectAt>rosterAt && ackAt>effectAt);
 assert.match(guest,/if \(xbRecovery && xbReinitCurrent\(\) &&/);
});
