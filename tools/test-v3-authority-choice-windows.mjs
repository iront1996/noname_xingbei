import test from 'node:test';
import assert from 'node:assert/strict';
import {createV3AuthorityChoiceWindows} from '../game/v3-authority-choice-windows.mjs';
const id=n=>'player_'+n.toString(16).padStart(32,'0');
const defaults={roomId:'roomA',seat:0,playerId:id(1),kind:'control',prompt:'選擇角色行動',options:['defend','pass']};
const started=(clock=()=>1_000)=>createV3AuthorityChoiceWindows({now:clock,ttlMs:10000});
test('open pending prompt and only valid option accepts one-time delivery',()=>{
 const m=started(),opened=m.open(defaults);assert.equal(opened.code,'CHOICE_WINDOW_OPENED');
 assert.equal(m.size(),1);
 assert.equal(opened.view.state,'open');
 assert.match(opened.view.ticket,/^[a-f0-9]{32}$/);
 const submitted=m.submit({...defaults,ticket:opened.view.ticket,option:'defend'});
 assert.equal(submitted.code,'CHOICE_SUBMITTED_NOT_APPLIED');
 assert.deepEqual(submitted.delivery,{roomId:'roomA',seat:0,playerId:id(1),ticket:opened.view.ticket,option:'defend'});
 assert.equal(m.submit({...defaults,ticket:opened.view.ticket,option:'pass'}).code,'CHOICE_ALREADY_LOCKED');
 assert.equal(m.submit({...defaults,ticket:opened.view.ticket,option:'defend'}).code,'CHOICE_ALREADY_SUBMITTED');
 assert.equal(m.deliveryReceipt({...defaults,ticket:opened.view.ticket,option:'pass'}).code,'CHOICE_DELIVERY_DENIED');
 assert.equal(m.deliveryReceipt({...defaults,ticket:opened.view.ticket,option:'defend'}).code,'CHOICE_DELIVERED_NOT_APPLIED');
 assert.equal(m.deliveryReceipt({...defaults,ticket:opened.view.ticket,option:'defend'}).code,'CHOICE_RECEIPT_ALREADY_SEEN');
 assert.equal(m.view('roomA',0,id(1)).state,'delivered');
});
test('disconnected player can retrieve same pending window without changing ticket',()=>{
 const m=started(),opened=m.open(defaults);
 assert.deepEqual(m.view('roomA',0,id(1)),opened.view);
 assert.equal(m.view('roomA',0,id(2)),null);
 assert.equal(m.view('another',0,id(1)),null);
 assert.equal(m.submit({...defaults,playerId:id(2),ticket:opened.view.ticket,option:'pass'}).code,'CHOICE_WINDOW_NOT_FOUND');
 assert.equal(m.submit({...defaults,roomId:'other',ticket:opened.view.ticket,option:'pass'}).code,'CHOICE_WINDOW_NOT_FOUND');
 assert.equal(m.submit({...defaults,seat:1,ticket:opened.view.ticket,option:'pass'}).code,'CHOICE_WINDOW_NOT_FOUND');
 assert.equal(m.submit({...defaults,ticket:'0'.repeat(32),option:'pass'}).code,'CHOICE_WINDOW_NOT_FOUND');
});
test('expired windows disappear deterministically without auto-choosing',()=>{
 let n=2000;const m=started(()=>n);
 const opened=m.open(defaults);n=11999;
 assert.equal(m.view('roomA',0,id(1)).ticket,opened.view.ticket);
 n=12000;assert.equal(m.view('roomA',0,id(1)),null);assert.equal(m.size(),0);
 assert.equal(m.submit({...defaults,ticket:opened.view.ticket,option:'pass'}).ok,false);
 assert.equal(m.open(defaults).ok,true);
});
test('cannot override existing window, guess options, or forge script payload',()=>{
 const m=started(),w=m.open(defaults);
 assert.equal(m.open(defaults).code,'CHOICE_WINDOW_ALREADY_OPEN');
 assert.equal(m.submit({...defaults,ticket:w.view.ticket,option:'arbitrary'}).code,'CHOICE_OPTION_NOT_ALLOWED');
 for(const d of [
  {...defaults,options:['a','a']}, {...defaults,options:['a']},
  {...defaults,options:['good','<script>']}, {...defaults,prompt:'<img src=x>'},
  {...defaults,kind:'javascript'}, {...defaults,playerId:'attacker'},
  {...defaults,seat:-1},{...defaults,roomId:'../../tmp'}
 ])assert.equal(createV3AuthorityChoiceWindows().open(d).ok,false);
});
test('separate rooms and seats are private; room cancellation cleans all',()=>{
 const m=started(),first=m.open(defaults),second=m.open({...defaults,roomId:'roomB'}),third=m.open({...defaults,seat:1,playerId:id(2)});
 assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(third.ok,true);
 assert.equal(m.cancelRoom('roomA'),2);assert.equal(m.size(),1);
 assert.equal(m.view('roomA',0,id(1)),null);
 assert.equal(m.view('roomB',0,id(1)).ticket,second.view.ticket);
});
test('strict capacity bound limits open windows',()=>{
 const m=createV3AuthorityChoiceWindows({maxOpen:1});
 assert.equal(m.open(defaults).ok,true);
 assert.equal(m.open({...defaults,roomId:'roomB'}).code,'CHOICE_CAPACITY_EXCEEDED');
});
