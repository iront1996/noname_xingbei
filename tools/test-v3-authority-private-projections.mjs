import test from 'node:test';
import assert from 'node:assert/strict';
import {createV3AuthorityPrivateProjections} from '../game/v3-authority-private-projections.mjs';
const id=n=>'player_'+n.toString(16).padStart(32,'0');
const cards=seat=>Array.from({length:4},(_,i)=>({
 cardId:'v3card_'+(seat*4+i).toString(16).padStart(6,'0'),name:i%2===0?'anMie':'shuiLianZhan'
}));
const state=(seat=0,roomId='ROOM')=>({
 roomId,seat,playerId:id(seat+1),revision:1,character:'youXia',
 ownHand:cards(seat),
 publicOtherHandCounts:Array.from({length:4},(_,i)=>({seat:i,handCount:4}))
});
test('only owner can retrieve private hand and copies cannot be mutated',()=>{
 const m=createV3AuthorityPrivateProjections();
 const value=state();
 assert.equal(m.publish(value).code,'PRIVATE_PROJECTION_STORED');
 value.ownHand[0].name='malicious';
 const got=m.get('ROOM',0,id(1));
 assert.equal(got.ownHand[0].name,'anMie');
 assert.equal(m.get('ROOM',0,id(2)),null);
 assert.equal(m.get('ROOM',1,id(1)),null);
 assert.equal(m.get('OTHER',0,id(1)),null);
 assert.equal(Object.hasOwn(got,'reconnectToken'),false);
 assert.equal(m.size(),1);
});
test('replayed versions and stolen IDs cannot change private hand',()=>{
 const m=createV3AuthorityPrivateProjections();
 assert.equal(m.publish(state()).ok,true);
 assert.equal(m.publish(state()).code,'PRIVATE_PROJECTION_STALE_OR_ID_MISMATCH');
 assert.equal(m.publish({...state(),playerId:id(2),revision:2}).code,'PRIVATE_PROJECTION_STALE_OR_ID_MISMATCH');
 assert.equal(m.publish({...state(),revision:2}).code,'PRIVATE_PROJECTION_STORED');
 assert.equal(m.get('ROOM',0,id(1)).revision,2);
});
test('physical card instance cannot be held by two seats simultaneously',()=>{
 const m=createV3AuthorityPrivateProjections();
 assert.equal(m.publish(state(0)).ok,true);
 const bad=state(1);bad.ownHand[0].cardId=cards(0)[0].cardId;
 assert.equal(m.publish(bad).code,'PRIVATE_PROJECTION_CARD_OWNERSHIP_CONFLICT');
 assert.equal(m.publish(state(1)).ok,true);
});
test('all public counts contain no cards or private images',()=>{
 const m=createV3AuthorityPrivateProjections();
 const s=state(2);
 assert.equal(m.publish(s).ok,true);
 const v=m.get('ROOM',2,id(3));
 assert.deepEqual(v.publicOtherHandCounts.map(x=>x.handCount),[4,4,4,4]);
 assert.equal(JSON.stringify(v.publicOtherHandCounts).includes('v3card_'),false);
 for(const invalid of [
  {...s,revision:0},{...s,ownHand:[{cardId:'../../etc',name:'anMie'}]},
  {...s,ownHand:[...s.ownHand,s.ownHand[0]]},
  {...s,publicOtherHandCounts:[{seat:0,handCount:4}]},
  {...s,publicOtherHandCounts:s.publicOtherHandCounts.map(x=>({...x,handCount:5}))},
  {...s,character:'<script>'}
 ])assert.equal(m.publish(invalid).ok,false);
});
test('bounded room storage and explicit worker-stop cleanup',()=>{
 const m=createV3AuthorityPrivateProjections({maxRooms:1});
 assert.equal(m.publish(state()).ok,true);
 assert.equal(m.publish(state(0,'SECOND')).code,'PRIVATE_PROJECTION_ROOM_LIMIT');
 assert.equal(m.clearRoom('ROOM'),true);
 assert.equal(m.size(),0);
 assert.equal(m.publish(state(0,'SECOND')).ok,true);
});


const roomView=(revision=1)=>({
 roomId:'ROOM',revision,seats:Array.from({length:4},(_,seat)=>({
  ...state(seat),revision,
  publicOtherHandCounts:Array.from({length:4},(_,i)=>({seat:i,handCount:4}))
 }))
});
test('whole room private revision is atomic and never reveals other seats',()=>{
 const model=createV3AuthorityPrivateProjections();
 const input=roomView();
 const saved=model.publishRoom(input);
 assert.deepEqual(saved,{ok:true,code:'PRIVATE_PROJECTION_ROOM_STORED',
  revision:1,seatCount:4});
 input.seats[0].ownHand[0].name='tamper';
 assert.equal(model.size(),4);
 assert.equal(model.get('ROOM',0,id(1)).ownHand[0].name,'anMie');
 assert.equal(model.get('ROOM',0,id(2)),null);
 assert.equal(Object.hasOwn(saved,'seats'),false);
 assert.equal(JSON.stringify(saved).includes('v3card_'),false);
 for(let seat=0;seat<4;seat++)
  assert.equal(model.get('ROOM',seat,id(seat+1)).revision,1);
});
test('cross-seat physical card transfer commits simultaneously',()=>{
 const model=createV3AuthorityPrivateProjections();
 assert.equal(model.publishRoom(roomView()).ok,true);
 const next=roomView(2);
 const transfer=next.seats[0].ownHand.pop();
 next.seats[1].ownHand.push(transfer);
 for(const s of next.seats){
  s.publicOtherHandCounts[0].handCount=3;
  s.publicOtherHandCounts[1].handCount=5;
 }
 assert.equal(model.publishRoom(next).code,'PRIVATE_PROJECTION_ROOM_STORED');
 assert.deepEqual(model.get('ROOM',0,id(1)).ownHand.map(c=>c.cardId),
  cards(0).slice(0,3).map(c=>c.cardId));
 assert.deepEqual(model.get('ROOM',1,id(2)).ownHand.map(c=>c.cardId),
  [...cards(1).map(c=>c.cardId),transfer.cardId]);
 assert.equal(model.get('ROOM',1,id(2)).publicOtherHandCounts[0].handCount,3);
});
test('invalid or stale whole-room revision leaves every old seat unchanged',()=>{
 const model=createV3AuthorityPrivateProjections();
 assert.equal(model.publishRoom(roomView()).ok,true);
 const before=Array.from({length:4},(_,i)=>model.get('ROOM',i,id(i+1)));
 const bads=[
  roomView(1),
  {...roomView(2),seats:roomView(2).seats.slice(0,3)},
  (()=>{const x=roomView(2);x.seats[2].playerId=id(1);return x})(),
  (()=>{const x=roomView(2);x.seats[3].ownHand[0].cardId=x.seats[0].ownHand[0].cardId;return x})(),
  (()=>{const x=roomView(2);x.seats[0].ownHand.pop();return x})()
 ];
 for(const bad of bads){
  assert.equal(model.publishRoom(bad).ok,false);
  assert.deepEqual(Array.from({length:4},(_,i)=>model.get('ROOM',i,id(i+1))),before);
 }
});


test('atomic room mode forbids legacy per-seat writes until room is cleared',()=>{
 const model=createV3AuthorityPrivateProjections();
 for(let seat=0;seat<4;seat++)
  assert.equal(model.publish(state(seat)).ok,true);
 assert.equal(model.publishRoom(roomView(2)).ok,true);
 const v=model.get('ROOM',0,id(1));
 assert.equal(model.publish({...state(0),revision:3}).code,
  'PRIVATE_PROJECTION_ROOM_BATCH_REQUIRED');
 for(let seat=0;seat<4;seat++)
  assert.equal(model.get('ROOM',seat,id(seat+1)).revision,2);
 assert.deepEqual(model.get('ROOM',0,id(1)),v);
 assert.equal(model.publishRoom(roomView(3)).ok,true);
 assert.equal(model.clearRoom('ROOM'),true);
 assert.equal(model.publish(state(0)).ok,true);
 assert.equal(model.get('ROOM',0,id(1)).revision,1);
});
