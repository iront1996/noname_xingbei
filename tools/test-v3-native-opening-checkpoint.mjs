import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 createV3NativeOpeningCheckpointStore,verifyV3NativeOpeningCheckpoint
} from '../game/v3-native-opening-checkpoint.mjs';
const playerId=n=>'player_'+n.toString(16).padStart(32,'0');
const cardId=n=>'v3card_'+n.toString(16).padStart(6,'0');
const character=n=>'hero_'+n;
const generate=(size=4)=>{
 const players=Array.from({length:size},(_,seat)=>({
  seat,playerId:playerId(seat+1),character:character(seat),
  hand:Array.from({length:4},(_,i)=>({
   cardId:cardId(seat*4+i),name:i%2?'anMie':'shuiLianZhan'
  }))
 }));
 return {schema:'xingbei-v3-native-opening-only-v1',roomId:'STAGE_ROOM',
  seatMode:(size/2)+'v'+(size/2),revision:1,totalCards:80,
  players,remainingCardIds:Array.from({length:80-4*size},(_,i)=>cardId(size*4+i))
 };
};
test('native staging checkpoint structure validates 4/6/8 rooms',()=>{
 for(const n of [4,6,8]){
  const c=generate(n);
  assert.equal(verifyV3NativeOpeningCheckpoint(c).ok,true);
  assert.equal(verifyV3NativeOpeningCheckpoint(c).restorable,false);
 }
});
test('AES-GCM save/restart/load with out-of-band key, no plaintext on disk',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'xingbei-native-checkpoint-'));
 const key=randomBytes(32),state=generate(8);
 try{
  const first=createV3NativeOpeningCheckpointStore({directory,key});
  const saved=await first.save(state);
  assert.equal(saved.code,'OPENING_CHECKPOINT_ENCRYPTED');
  const onDisk=await readFile(join(directory,'STAGE_ROOM.v3opening'),'utf8');
  for(const secret of [state.players[0].playerId,state.players[0].character,
   state.players[0].hand[0].cardId])
   assert.equal(onDisk.includes(secret),false);
  assert.equal(onDisk.includes(key.toString('hex')),false);
  const restarted=createV3NativeOpeningCheckpointStore({directory,key});
  const restored=await restarted.load('STAGE_ROOM');
  assert.equal(restored.restorable,false);
  assert.deepEqual(restored.value,state);
  restored.value.players[0].character='tampered'; // clone only
  assert.equal((await restarted.load('STAGE_ROOM')).value.players[0].character,'hero_0');
  assert.equal(await restarted.remove('STAGE_ROOM'),true);
  assert.equal(await restarted.load('STAGE_ROOM'),null);
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('tampered storage, wrong key or room binding never discloses data',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'xingbei-native-checkpoint-'));
 const key=randomBytes(32);
 try{
  const first=createV3NativeOpeningCheckpointStore({directory,key});
  await first.save(generate());
  const other=createV3NativeOpeningCheckpointStore({directory,key:randomBytes(32)});
  await assert.rejects(other.load('STAGE_ROOM'),{code:'CHECKPOINT_AUTHENTICATION_FAILED'});
  const path=join(directory,'STAGE_ROOM.v3opening');
  const record=JSON.parse(await readFile(path,'utf8'));
  record.ciphertext='AAAA'+record.ciphertext.slice(4);
  await writeFile(path,JSON.stringify(record),'utf8');
  await assert.rejects(first.load('STAGE_ROOM'),{code:'CHECKPOINT_AUTHENTICATION_FAILED'});
  assert.equal(await first.load('OTHER'),null);
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('replay revision and card ownership inconsistencies fail closed',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'xingbei-native-checkpoint-'));
 const key=randomBytes(32),store=createV3NativeOpeningCheckpointStore({directory,key});
 try{
  const base=generate();
  await store.save(base);
  await assert.rejects(store.save(base),{code:'CHECKPOINT_STALE_REVISION'});
  const update={...base,revision:2};
  assert.equal((await store.save(update)).revision,2);
  const bad=generate();
  bad.players[1].hand[0].cardId=bad.players[0].hand[0].cardId;
  assert.equal(verifyV3NativeOpeningCheckpoint(bad).ok,false);
  const missing=generate();
  missing.remainingCardIds.pop();
  assert.equal(verifyV3NativeOpeningCheckpoint(missing).ok,false);
  const gap=generate();
  gap.remainingCardIds[0]='v3card_ffffff';
  assert.equal(verifyV3NativeOpeningCheckpoint(gap).ok,false);
  const changed=generate();changed.players[0].character='<script>';
  assert.equal(verifyV3NativeOpeningCheckpoint(changed).ok,false);
  const hidden=generate();hidden.players[0].reconnectToken='secret';
  assert.equal(verifyV3NativeOpeningCheckpoint(hidden).ok,false);
 }finally{await rm(directory,{recursive:true,force:true})}
});
