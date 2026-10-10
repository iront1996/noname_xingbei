import test from "node:test";
import assert from "node:assert/strict";
import {readV3XingbeiState as read,
 createV3XingbeiStateDeltaObserver as make} from "../game/v3-xingbei-state-delta.mjs";
const p=t=>({zhiLiao:t,hp:999,playerid:"SECRET_ID",secretCards:["SECRET_CARD"]});
const g=()=>({hongShiQi:15,lanShiQi:15,hongXingBei:0,lanXingBei:0,
 hongZhanJi:["baoShi"],lanZhanJi:["shuiJing"]});
const z=n=>({children:{length:n}});
const intent=n=>({status:"EFFECT_INTENT_CALLS_ONLY",totalCalls:n});
const never=x=>{
 assert.equal(x.appliedEffectsProven,false);
 assert.equal(x.atomicStateCheckpoint,false);
 assert.equal(x.completeCoverage,false);
 assert.equal(x.restorable,false);
 assert.equal(x.readyToResume,false);
 assert.doesNotMatch(JSON.stringify(x),/SECRET_ID|SECRET_CARD|hp/);
};
test("extract actual Xingbei morale, grails, stones, treatment, deck without HP",()=>{
 const game=g(),players=[p(1),p(2)],s=read(game,players,z(100),z(50));
 assert.deepEqual([s.redMorale,s.redGrails,s.redGem,s.blueCrystal],
 [15,0,1,1]);
 assert.equal(s.seats[1].treatment,2);
 assert.equal(Object.hasOwn(s,"hp"),false);
 const observer=make({getScope:()=>"R"});
 never(observer.observe(s,intent(0)));
});
test("team morale, starstones and treatment are distinct mechanical windows",()=>{
 const game=g(),players=[p(1),p(2)],obs=make({getScope:()=>"R"});
 const sample=()=>read(game,players,z(80),z(20));
 obs.observe(sample(),intent(0));
 game.hongShiQi=13;game.hongZhanJi.push("shuiJing");players[0].zhiLiao=0;
 const x=obs.observe(sample(),intent(1));
 assert.equal(x.comparedWindows,1);
 assert.equal(x.moraleWindows,1);
 assert.equal(x.starstoneWindows,1);
 assert.equal(x.treatmentWindows,1);
 assert.equal(x.grailWindows,0);
 assert.equal(x.zoneWindows,0);
 never(x);
});
test("grail and deck windows may change with no observed native Player intent call",()=>{
 const game=g(),players=[p(1),p(2)],obs=make({getScope:()=>"R"});
 obs.observe(read(game,players,z(80),z(20)),intent(0));
 game.lanXingBei=1;
 const x=obs.observe(read(game,players,z(77),z(23)),intent(0));
 assert.equal(x.grailWindows,1);
 assert.equal(x.zoneWindows,1);
 assert.equal(x.unattributedWindows,1);
 assert.equal(x.appliedEffectsProven,false);
 never(x);
});
test("legacy player hp values do not contribute to any Xingbei delta",()=>{
 const game=g(),players=[p(1),p(2)],obs=make({getScope:()=>"R"});
 obs.observe(read(game,players,z(80),z(20)),intent(0));
 players[0].hp=99999;
 const x=obs.observe(read(game,players,z(80),z(20)),intent(0));
 assert.equal(x.comparedWindows,1);
 assert.equal(x.moraleWindows+x.grailWindows+x.starstoneWindows+
 x.treatmentWindows+x.zoneWindows,0);
 never(x);
});
test("unknown starstone, getters, duplicate seats and invalid treatment fail closed",()=>{
 const game=g(),players=[p(1),p(2)];
 assert.equal(read({...game,hongZhanJi:["fake"]},players,z(80),z(20)),null);
 let called=0;const hostile=p(1);
 Object.defineProperty(hostile,"zhiLiao",{get(){called++;throw Error("PRIVATE")},enumerable:true});
 assert.equal(read(game,[hostile,players[1]],z(80),z(20)),null);
 assert.equal(called,0);
 assert.equal(read(game,[players[0],players[0]],z(80),z(20)),null);
 assert.equal(read(game,[p(-1),p(1)],z(80),z(20)),null);
});
test("room and seat identity changes reset window comparison",()=>{
 let room="A";const game=g(),players=[p(1),p(2)];
 const obs=make({getScope:()=>room});
 obs.observe(read(game,players,z(80),z(20)),intent(0));
 players.reverse();
 const swapped=obs.observe(read(game,players,z(80),z(20)),intent(0));
 assert.equal(swapped.seatingResets,1);
 room="B";
 const x=obs.snapshot();
 assert.equal(x.comparedWindows,0);
 assert.equal(x.status,"XINGBEI_STATE_BASELINE_NOT_READY");
 never(x);
});
