import test from 'node:test';
import assert from 'node:assert/strict';
import {validateV3NativeEnvelope as check} from '../game/v3-native-response-envelope.mjs';
const id='player_'+'a'.repeat(32);
const bindings=[{seat:0,playerId:id,connectionId:'c'.repeat(24)}];
const message={type:'native_player_response',roomId:'ROOM',traceId:'f'.repeat(32),seat:0,playerId:id};
test('authenticated envelope is metadata-only',()=>assert.equal(check({message,roomId:'ROOM',bindings}).ok,true));
test('no cross seat, stale or absent binding',()=>{
 for(const patch of [{seat:1},{playerId:'player_'+'b'.repeat(32)},{roomId:'OTHER'}])
  assert.equal(check({message:{...message,...patch},roomId:'ROOM',bindings}).ok,false);
 assert.equal(check({message,roomId:'ROOM',bindings:[{...bindings[0],connectionId:null}]}).ok,false);
});
test('native arbitrary actions and code remain disabled',()=>{
 for(const patch of [{script:'alert(1)'},{action:'attack'},{result:{cards:[]}}])
  assert.equal(check({message:{...message,...patch},roomId:'ROOM',bindings}).code,'NATIVE_GAMEPLAY_DISABLED');
});
