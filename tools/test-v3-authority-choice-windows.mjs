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
 assert.deepEqual(submitted.delivery,{roomId:'roomA',seat:0,playerId:id(1),ticket:opened.view.ticket,option:'defend',source:'experiment'});
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

test('native choice must pass delivered receipt before applied and then may retire',()=>{
 const m=started();
 const opened=m.open({...defaults,source:'native'});assert.equal(opened.ok,true);
 const body={...defaults,ticket:opened.view.ticket,option:'pass'};
 assert.equal(m.nativeApplied(body).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.submit(body).code,'CHOICE_SUBMITTED_NOT_APPLIED');
 assert.equal(m.nativeApplied(body).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.deliveryReceipt(body).code,'CHOICE_DELIVERED_NOT_APPLIED');
 assert.equal(m.nativeApplied({...body,playerId:id(2)}).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.nativeApplied({...body,option:'defend'}).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.nativeApplied(body).code,'CHOICE_NATIVE_APPLIED');
 assert.equal(m.nativeApplied(body).code,'CHOICE_ALREADY_APPLIED');
 assert.equal(m.view('roomA',0,id(1)).state,'applied');
 assert.equal(m.submit(body).code,'CHOICE_ALREADY_APPLIED');
 const second=m.open({...defaults,source:'native'});
 assert.equal(second.ok,true);
 assert.notEqual(second.view.ticket,opened.view.ticket);
 assert.equal(m.submit(body).code,'CHOICE_WINDOW_NOT_FOUND');
});
test('experimental choice cannot falsely claim native application',()=>{
 const m=started(),opened=m.open(defaults);
 const body={...defaults,ticket:opened.view.ticket,option:'defend'};
 m.submit(body);m.deliveryReceipt(body);
 assert.equal(m.nativeApplied(body).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.view('roomA',0,id(1)).state,'delivered');
});

test('native chooseToUse read-only card preview receives a ticket but never applies GameEvent',()=>{
 const m=started();
 const preview=m.open({...defaults,source:'preview',kind:'card',
  prompt:'原生選牌預覽',options:['v3card_abcdef','v3card_123456']});
 assert.equal(preview.ok,true);
 assert.equal(preview.view.source,'preview');
 assert.equal(preview.view.state,'open');
 const body={...defaults,ticket:preview.view.ticket,option:'v3card_abcdef'};
 assert.equal(m.submit({...body,playerId:id(2)}).code,'CHOICE_WINDOW_NOT_FOUND');
 assert.equal(m.submit({...body,option:'v3card_ffffff'}).code,'CHOICE_OPTION_NOT_ALLOWED');
 assert.equal(m.submit(body).code,'CHOICE_SUBMITTED_NOT_APPLIED');
 assert.equal(m.deliveryReceipt(body).code,'CHOICE_DELIVERED_NOT_APPLIED');
 assert.equal(m.nativeApplied(body).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.view('roomA',0,id(1)).state,'delivered');
 assert.equal(m.submit({...body,option:'v3card_123456'}).code,'CHOICE_ALREADY_LOCKED');
 assert.equal(m.open({...defaults,source:'native'}).code,'CHOICE_WINDOW_ALREADY_OPEN');
 assert.equal(m.cancelRoom('roomA'),1);
 assert.equal(m.view('roomA',0,id(1)),null);
});

test('only delivered original card preview can advance to a distinct target ticket',()=>{
 const m=started();
 const first=m.open({...defaults,source:'preview',kind:'card',
  prompt:'請選牌',options:['v3card_012345','v3card_abcdef']});
 const args={roomId:'roomA',seat:0,playerId:id(1),
  previousTicket:first.view.ticket,previousOption:'v3card_012345',
  kind:'target',prompt:'印刷目標預覽',options:['s1','s3']};
 assert.equal(m.advancePreview(args).code,'PREVIEW_ADVANCE_DENIED');
 assert.equal(m.submit({...defaults,ticket:first.view.ticket,
  option:'v3card_012345'}).code,'CHOICE_SUBMITTED_NOT_APPLIED');
 assert.equal(m.advancePreview(args).code,'PREVIEW_ADVANCE_DENIED');
 assert.equal(m.deliveryReceipt({...defaults,ticket:first.view.ticket,
  option:'v3card_012345'}).code,'CHOICE_DELIVERED_NOT_APPLIED');
 for(const forged of [
  {...args,previousTicket:'f'.repeat(32)},
  {...args,previousOption:'v3card_abcdef'},
  {...args,playerId:id(2)},{...args,seat:1},
  {...args,kind:'skill'},{...args,options:['s0','<script>']},
  {...args,options:['s1','s1']},{...args,options:['s1']},
  {...args,options:['s1','s8']}
 ])assert.equal(m.advancePreview(forged).code,'PREVIEW_ADVANCE_DENIED');
 assert.equal(m.view('roomA',0,id(1)).ticket,first.view.ticket);
 const next=m.advancePreview(args);
 assert.equal(next.code,'PREVIEW_TARGET_WINDOW_OPENED');
 assert.equal(next.view.source,'preview');
 assert.equal(next.view.kind,'target');
 assert.equal(next.view.state,'open');
 assert.notEqual(next.view.ticket,first.view.ticket);
 assert.deepEqual(next.view.options,['s1','s3']);
 assert.equal(m.submit({...defaults,ticket:first.view.ticket,
  option:'v3card_012345'}).code,'CHOICE_WINDOW_NOT_FOUND');
 assert.equal(m.advancePreview(args).code,'PREVIEW_ADVANCE_DENIED');
 assert.equal(m.nativeApplied({...defaults,ticket:next.view.ticket,
  option:'s1'}).code,'CHOICE_NATIVE_APPLY_DENIED');
 const target={...defaults,ticket:next.view.ticket,option:'s3'};
 assert.equal(m.submit(target).code,'CHOICE_SUBMITTED_NOT_APPLIED');
 assert.equal(m.deliveryReceipt(target).code,'CHOICE_DELIVERED_NOT_APPLIED');
 assert.equal(m.nativeApplied(target).code,'CHOICE_NATIVE_APPLY_DENIED');
 assert.equal(m.submit({...target,option:'s1'}).code,'CHOICE_ALREADY_LOCKED');
 assert.equal(m.view('roomA',0,id(2)),null);
});
