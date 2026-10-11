import test from 'node:test';
import assert from 'node:assert/strict';
import {installV3HostNeutralOutcome as install} from '../game/v3-native-xingbei-outcome-adapter.mjs';
const id=n=>'player_'+n.toString(16).padStart(32,'0');
const instance=(seatCount=4)=>{
 const me={};const players=Array.from({length:seatCount},(_,i)=>({playerid:id(i+1),side:i%2===0}));
 const game={me,players,hongShiQi:15,lanShiQi:15,hongXingBei:0,lanXingBei:0,xingBeiMax:5,
  over(){throw Error('NATIVE_OVER_MUST_NOT_BE_USED')}};
 const mode={name:'xingBei',game:{checkResult(){throw Error('LEGACY_HOST_RESULT')},
  checkOnlineResult(){throw Error('LEGACY_HOST_CHECK')}}};
 const sent=[];return {game,mode,sent,install:()=>install({game,mode,onTerminal:v=>sent.push(v)})};
};
test('host neutral no-result is side independent',()=>{
 const i=instance();i.install();
 assert.deepEqual(i.game.checkResult(),{ok:true,terminal:false,winner:null});
 assert.equal(i.game.checkOnlineResult(i.game.players[0]),undefined);
 assert.equal(i.sent.length,0);
});
test('real native mode callbacks become host-neutral and per-player',()=>{
 const i=instance();i.install();i.game.hongXingBei=5;
 const result=i.mode.game.checkResult();
 assert.equal(result.winner,'hong');assert.equal(i.sent.length,1);
 assert.deepEqual(result.perPlayer.map(p=>p.won),[true,false,true,false]);
 assert.equal(i.mode.game.checkOnlineResult(i.game.players[1]),false);
 assert.strictEqual(i.game.checkResult(),result);
 assert.equal(i.sent.length,1);
 assert.throws(()=>i.install(),{code:'V3_NATIVE_OUTCOME_ALREADY_INSTALLED'});
});
test('6 and 8 seats, opposite faction, morale threshold',()=>{
 for(const count of [6,8]){
  const i=instance(count);i.install();i.game.hongShiQi=0;
  assert.equal(i.game.checkResult().winner,'lan');
  assert.equal(i.sent[0].perPlayer.length,count);
  assert.equal(i.sent[0].perPlayer.filter(p=>p.won).length,count/2);
 }
});
test('missing or duplicated player ids and invalid sides cannot decide match',()=>{
 for(const mutate of [
  i=>i.game.players.pop(),
  i=>i.game.players[1].playerid=i.game.players[0].playerid,
  i=>i.game.players[1].side=undefined
 ]){
  const i=instance();i.install();mutate(i);i.game.lanShiQi=0;
  assert.throws(()=>i.game.checkResult());assert.equal(i.sent.length,0);
 }
});
test('worker cannot be human and conflicting outcomes do not publish',()=>{
 const i=instance();i.install();i.game.me.side=true;i.game.lanShiQi=0;
 assert.throws(()=>i.game.checkResult(),{code:'V3_OFFBOARD_HOST_REQUIRED'});
 const j=instance();j.install();j.game.lanShiQi=0;j.game.hongShiQi=0;
 assert.throws(()=>j.game.checkResult(),{code:'CONFLICTING_TERMINAL_CONDITIONS'});
 assert.equal(j.sent.length,0);
});
test('no cross player result lookup, and tampering with final winner fails',()=>{
 const i=instance();i.install();i.game.hongXingBei=5;i.game.checkResult();
 assert.throws(()=>i.game.checkOnlineResult({playerid:id(999)}),{code:'V3_NATIVE_PLAYER_UNAUTHORIZED'});
 i.game.lanXingBei=5;
 assert.throws(()=>i.game.checkResult(),{code:'CONFLICTING_TERMINAL_CONDITIONS'});
 assert.equal(i.sent.length,1);
});
