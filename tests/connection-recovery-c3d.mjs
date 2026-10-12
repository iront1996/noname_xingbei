import test from "node:test";
import assert from "node:assert/strict";
import {createV3AuthorityPrivateProjections} from "../game/v3-authority-private-projections.mjs";
import {createV3AuthorityChoiceWindows} from "../game/v3-authority-choice-windows.mjs";
import {createV3RecoveryCandidateProjections,V3_RECOVERY_CANDIDATE_SCHEMA}
  from "../game/v3-authority-recovery-candidate.mjs";

const player=i=>"player_"+String(i+1).padStart(32,"0");
const card=(seat,i)=>({cardId:"v3card_"+(seat*4+i).toString(16).padStart(6,"0"),name:"anMie"});
const seats=(n=4)=>Array.from({length:n},(_,seat)=>({
  seat,playerId:player(seat),character:"youXia",
  ownHand:Array.from({length:4},(_,i)=>card(seat,i)),
  publicOtherHandCounts:Array.from({length:n},(_,i)=>({seat:i,handCount:4}))
}));
const setup=()=>{
  const privateHands=createV3AuthorityPrivateProjections();
  const choiceWindows=createV3AuthorityChoiceWindows({now:()=>1000});
  const workers=new Map(),bindings=new Map();
  const worker={kind:"managed-v3-test-worker"};
  workers.set("ROOM",worker);
  for(let i=0;i<4;i++)bindings.set("ROOM:"+i,"ws"+i);
  const currentWorker=room=>workers.get(room)??null;
  const authorize=({roomId,seat,playerId,connectionId})=>
    roomId==="ROOM"&&playerId===player(seat)&&bindings.get(roomId+":"+seat)===connectionId;
  const recovery=createV3RecoveryCandidateProjections({
    privateHands,choiceWindows,currentWorker,authorize
  });
  const publishRoom=revision=>privateHands.publishRoom({roomId:"ROOM",revision,seats:seats()});
  const input=(revision=1)=>({
    roomId:"ROOM",worker,revision,
    roster:seats().map(({seat,playerId})=>({seat,playerId})),
    publicDigest:"xb-public-v1:000000000000abcd",
    phaseNumber:9,currentSeat:2
  });
  const project=(seat=0,expectedRevision=1,connectionId="ws"+seat)=>recovery.project({
    roomId:"ROOM",seat,playerId:player(seat),connectionId,expectedRevision
  });
  return {privateHands,choiceWindows,workers,bindings,worker,recovery,publishRoom,input,project};
};

test("V3 actual atomic projections supply only authenticated seat-private data",()=>{
  const f=setup();
  assert.equal(f.publishRoom(1).ok,true);
  const published=f.recovery.publish(f.input());
  assert.equal(published.code,"CANDIDATE_METADATA_STORED");
  assert.equal(published.restorable,false);
  const one=f.project();
  assert.equal(one.code,"CANDIDATE_READ_ONLY");
  assert.equal(one.view.schema,V3_RECOVERY_CANDIDATE_SCHEMA);
  assert.equal(one.view.ownHand.length,4);
  assert.equal(one.view.ownHand[0].cardId,card(0,0).cardId);
  assert.equal(one.view.phaseNumber,9);
  assert.equal(one.view.readyToResume,false);
  const dump=JSON.stringify(one);
  assert.equal(dump.includes(card(1,0).cardId),false,"other hand contents not leaked");
  assert.equal(dump.includes("ticket"),false);
  assert.equal(dump.includes("token"),false);
  assert.equal(dump.includes("storage"),false);
  assert.equal(Object.isFrozen(one.view),true);
  assert.equal(Object.isFrozen(one.view.ownHand[0]),true);
  assert.throws(()=>{one.view.ownHand[0].name="tamper"});
  assert.equal(f.project().view.ownHand[0].name,"anMie");
});
test("identity, stale connection, cross-seat and foreign room fail closed",()=>{
  const f=setup();f.publishRoom(1);f.recovery.publish(f.input());
  assert.equal(f.project(0,1,"ws1").code,"CANDIDATE_SEAT_NOT_AUTHORIZED");
  assert.equal(f.project(1,1,"ws0").code,"CANDIDATE_SEAT_NOT_AUTHORIZED");
  assert.equal(f.project(0,0).code,"CANDIDATE_REQUEST_INVALID");
  assert.equal(f.project(0,2).code,"CANDIDATE_STALE_REVISION");
  assert.equal(f.recovery.project({
    roomId:"OTHER",seat:0,playerId:player(0),connectionId:"ws0",expectedRevision:1
  }).code,"CANDIDATE_NOT_FOUND");
  f.bindings.set("ROOM:0","replacement");
  assert.equal(f.project().ok,false,"old seat channel denied after takeover");
  assert.equal(f.project(0,1,"replacement").ok,true);
});
test("different snapshot/private revisions are rejected without partial publication",()=>{
  const f=setup();
  assert.equal(f.recovery.publish(f.input()).code,"CANDIDATE_PRIVATE_REVISION_MISSING");
  assert.equal(f.recovery.size(),0);
  assert.equal(f.publishRoom(1).ok,true);
  assert.equal(f.recovery.publish(f.input(2)).code,"CANDIDATE_PRIVATE_REVISION_MISSING");
  assert.equal(f.recovery.publish(f.input()).ok,true);
  assert.equal(f.recovery.publish(f.input()).code,"CANDIDATE_STALE_OR_WORKER_CHANGED");
  assert.equal(f.publishRoom(2).ok,true);
  assert.equal(f.project().code,"CANDIDATE_PRIVATE_REVISION_MISSING",
    "no stale private data from an older cut may be sent");
  assert.equal(f.recovery.publish(f.input(2)).ok,true);
  assert.equal(f.project(0,2).ok,true);
});
test("inflight choice blocks projection and publication, even with valid hand revisions",()=>{
  const f=setup();f.publishRoom(1);f.recovery.publish(f.input());
  assert.equal(f.choiceWindows.open({
    roomId:"ROOM",seat:1,playerId:player(1),kind:"card",
    prompt:"Choose card",options:["pass","v3card_000004"],source:"preview"
  }).ok,true);
  assert.equal(f.project().code,"CANDIDATE_CHOICE_IN_FLIGHT");
  assert.equal(f.recovery.publish(f.input(2)).code,"CANDIDATE_CHOICE_IN_FLIGHT");
  assert.equal(f.recovery.size(),1,"failed publication retains previous cut");
});
test("worker replacement retires prior authority candidates",()=>{
  const f=setup();f.publishRoom(1);f.recovery.publish(f.input());
  f.workers.set("ROOM",{kind:"replacement"});
  assert.equal(f.project().code,"CANDIDATE_WORKER_NOT_CURRENT");
  assert.equal(f.recovery.publish({...f.input(),revision:2}).code,"CANDIDATE_WORKER_NOT_CURRENT");
  assert.equal(f.recovery.clearRoom("ROOM"),true);
  assert.equal(f.recovery.size(),0);
});
test("malformed data and duplicate identity reject without private exposure",()=>{
  const f=setup();f.publishRoom(1);
  const x=f.input();
  assert.equal(f.recovery.publish({...x,token:"secret"}).code,"CANDIDATE_SHAPE_INVALID");
  assert.equal(f.recovery.publish({...x,publicDigest:"invalid"}).code,"CANDIDATE_METADATA_INVALID");
  const duplicate=f.input();duplicate.roster[2]={seat:2,playerId:player(1)};
  assert.equal(f.recovery.publish(duplicate).code,"CANDIDATE_ROSTER_INVALID");
  const wrong=f.input();wrong.roster[0].playerId="owner";
  assert.equal(f.recovery.publish(wrong).code,"CANDIDATE_ROSTER_INVALID");
  assert.equal(f.recovery.size(),0);
});
