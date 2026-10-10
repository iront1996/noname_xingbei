import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {
 V3_XINGBEI_RESOURCE_SCHEMA as SCHEMA,
 buildV3XingbeiResourceEvidence as build,
 verifyV3XingbeiResourceEvidence as verify
} from "../game/v3-xingbei-resource-evidence.mjs";
const now=1781100000000;
const sample=()=>({
 redMorale:13,blueMorale:15,redGrails:1,blueGrails:0,
 redGem:2,redCrystal:1,blueGem:1,blueCrystal:3,deck:77,discard:55,
 seats:[
 {ref:{playerid:"SECRET_P1",cards:["PRIVATE_HAND"]},treatment:1},
 {ref:{playerid:"SECRET_P2",cards:["PRIVATE_HAND2"]},treatment:2},
 {ref:{playerid:"SECRET_P3"},treatment:0}
 ]
});
test("strict resource capsule contains only own numeric Star Cup data",()=>{
 const result=build(sample(),now);
 assert.equal(result.ok,true);
 const capsule=JSON.parse(JSON.stringify(result.capsule));
 assert.equal(verify(capsule).ok,true);
 assert.equal(verify(capsule).seatCount,3);
 for(const prop of ["playerSeatsBound","cardOrderCaptured",
  "playerSkillStateCaptured","stateCheckpointAtomic","safeCheckpointCertified",
  "eventContinuationCaptured","restorable","readyToResume"])
  assert.equal(capsule[prop],false);
 assert.doesNotMatch(JSON.stringify(capsule),/SECRET|PRIVATE|playerid|ref|cards|skill/);
 assert.deepEqual(capsule.treatments,[1,2,0]);
});
test("rejects false recovery authorization even with intact numbers",()=>{
 const base=JSON.parse(JSON.stringify(build(sample(),now).capsule));
 for(const prop of ["playerSeatsBound","cardOrderCaptured","playerSkillStateCaptured",
   "eventContinuationCaptured","safeCheckpointCertified","stateCheckpointAtomic",
   "restorable","readyToResume"]){
   const copy={...base,[prop]:true};
   assert.equal(verify(copy).ok,false,prop);
 }
});
test("rejects nonnumeric, unrecognized and out-of-bound resource values",()=>{
 for(const [field,value] of [["redMorale","13"],["blueMorale",NaN],
   ["redGem",100],["redGrails",-1],["deck",200001],["discard",-1]]){
   const raw=sample();raw[field]=value;
   assert.equal(build(raw,now).ok,false,field);
 }
 const raw=sample();raw.secretHand="not for archive";
 const capsule=build(raw,now).capsule;
 assert.ok(capsule);
 assert.doesNotMatch(JSON.stringify(capsule),/not for archive/);
 const corrupted={...capsule,secretHand:["DO_NOT_STORE"]};
 assert.equal(verify(corrupted).ok,false);
});
test("rejects getter fields without executing them",()=>{
 const raw=sample();let calls=0;
 Object.defineProperty(raw,"blueGrails",{enumerable:true,get(){calls++;throw Error("SECRET")}});
 assert.equal(build(raw,now).ok,false);
 assert.equal(calls,0);
 const forged=JSON.parse(JSON.stringify(build(sample(),now).capsule));
 Object.defineProperty(forged.scalars,"redMorale",{enumerable:true,get(){calls++;return 13}});
 assert.equal(verify(forged).ok,false);
 assert.equal(calls,0);
});
test("arrays with holes or illicit data are rejected",()=>{
 const v=JSON.parse(JSON.stringify(build(sample(),now).capsule));
 const sparse=new Array(3);sparse[0]=1;sparse[2]=0;
 assert.equal(verify({...v,treatments:sparse}).ok,false);
 assert.equal(verify({...v,treatments:[1,"2",0]}).ok,false);
 assert.equal(verify({...v,treatments:[1,2,0,9,0,0,0,0,0]}).ok,false);
});
test("AES-GCM authenticated room, schema and timestamp cannot be substituted",async()=>{
 const key=await webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
 const iv=webcrypto.getRandomValues(new Uint8Array(12));
 const resource=build(sample(),now).capsule;
 const bytes=new TextEncoder().encode(JSON.stringify(resource));
 const aad=(room,time)=>new TextEncoder().encode(SCHEMA+":"+room+":"+time);
 const ciphertext=await webcrypto.subtle.encrypt({name:"AES-GCM",iv,
   additionalData:aad("ROOM1",now)},key,bytes);
 const decoded=await webcrypto.subtle.decrypt({name:"AES-GCM",iv,
   additionalData:aad("ROOM1",now)},key,ciphertext);
 assert.equal(verify(JSON.parse(new TextDecoder().decode(decoded))).ok,true);
 for(const [room,time] of [["ROOM2",now],["ROOM1",now+1]]) {
   await assert.rejects(webcrypto.subtle.decrypt({name:"AES-GCM",iv,
     additionalData:aad(room,time)},key,ciphertext));
 }
 const mutated=new Uint8Array(ciphertext);mutated[0]^=1;
 await assert.rejects(webcrypto.subtle.decrypt({name:"AES-GCM",iv,
   additionalData:aad("ROOM1",now)},key,mutated));
});
