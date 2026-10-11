import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveV3XingBeiWinner as result,deriveV3SeatVictory as forSeat} from '../game/v3-xingbei-authority-outcome.mjs';
const base=()=>({hongShiQi:15,lanShiQi:15,hongXingBei:0,lanXingBei:0,xingBeiMax:5});
test('ongoing game has no terminal winner and no player-specific win claim',()=>{
 const r=result(base());assert.deepEqual(r,{ok:true,terminal:false,winner:null});
 assert.equal(forSeat(r,'hong').code,'NO_CERTIFIED_TERMINAL_RESULT');
});
test('morale threshold resolves red or blue independently of a local host',()=>{
 const a=result({...base(),lanShiQi:0});
 assert.deepEqual(a,{ok:true,terminal:true,winner:'hong'});
 assert.deepEqual(forSeat(a,'hong'),{ok:true,won:true});
 assert.deepEqual(forSeat(a,'lan'),{ok:true,won:false});
 const b=result({...base(),hongShiQi:-1});
 assert.equal(b.winner,'lan');
});
test('fifth star cup triggers the owning faction, not a worker player seat',()=>{
 assert.equal(result({...base(),hongXingBei:5}).winner,'hong');
 assert.equal(result({...base(),lanXingBei:6}).winner,'lan');
});
test('conflicting simultaneous win state fails closed, not arbitrary victory',()=>{
 assert.equal(result({...base(),hongShiQi:0,lanShiQi:0}).code,'CONFLICTING_TERMINAL_CONDITIONS');
 assert.equal(result({...base(),hongXingBei:5,lanXingBei:5}).code,'CONFLICTING_TERMINAL_CONDITIONS');
});
test('malformed snapshots and accessor getters cannot choose a winner',()=>{
 assert.equal(result(null).code,'STATE_INVALID');
 assert.equal(result({...base(),xingBeiMax:0}).code,'STATE_INVALID');
 assert.equal(result({...base(),hongShiQi:NaN}).code,'STATE_INVALID');
 let called=0;const s=base();Object.defineProperty(s,'lanShiQi',{get(){called++;return 0}});
 assert.equal(result(s).code,'STATE_INVALID');assert.equal(called,0);
 assert.equal(forSeat({ok:true,terminal:true,winner:'hong'},'fake').code,'NO_CERTIFIED_TERMINAL_RESULT');
});
