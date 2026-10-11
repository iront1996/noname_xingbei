import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchV3ChromiumAuthorityWorker as launch} from '../game/v3-chromium-authority-worker.mjs';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';
const executable=process.env.V3_CHROMIUM;
const enabled=typeof executable==='string'&&executable.startsWith('/');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('original XingBei card deck and character packs import in real offboard Chromium',{
 skip:!enabled,timeout:60000
},async()=>{
 const server=await createV3NativeModuleTestServer({root});
 let chrome;
 try{
  chrome=await launch({executable});
  const native=await chrome.loadV3NativeModules({origin:server.origin});
  assert.equal(native.loaded,true);
  const report=await chrome.evaluateSeatExperiment(String.raw`(async()=>{
  try{
   const {core}=window.__v3NativeXingBeiTest;
   const {stageV3NativeXingBeiContent,createV3NativeDrawPile}=
    await import('/game/v3-native-xingbei-content-stager.mjs');
   const stage=await stageV3NativeXingBeiContent({core});
   const cards=core.game.__v3NativeContentStage.cardEntries();
   const characterNames=core.game.__v3NativeContentStage.rosterChoices();
   const usable=characterNames.every(name=>core.lib.character[name] instanceof core.lib.element.Character);
   const definedCards=cards.every(c=>typeof core.lib.card[c[2]]==='object');
   const uniqueCharacters=new Set(characterNames).size===characterNames.length;
   const before=Object.getOwnPropertyDescriptor(window,'game');
   let denied=false;
   try{await stageV3NativeXingBeiContent({core})}
   catch(e){denied=e.code==='V3_CONTENT_ALREADY_STAGED'}
   const pile=createV3NativeDrawPile({core});
   const hands=Array.from({length:8},()=>[]);
   for(let round=0;round<4;round++)for(let seat=0;seat<8;seat++)hands[seat].push(pile.draw());
   const assigned=hands.flat(),remaining=pile.inspectIds();
   const uniqueCopies=new Set([...assigned.map(c=>c.instanceId),...remaining]).size===stage.cardCount;
   const oneSeat=hands[0].map(c=>({id:c.instanceId,name:c.name}));
   const separate=hands.every((hand,i)=>i===0||hand.every(c=>!oneSeat.some(own=>own.id===c.instanceId)));
   const exposed=Object.getOwnPropertyDescriptor(window,'game');
   return {stage,usable,definedCards,uniqueCharacters,denied,
    oldGlobalRestored:before===undefined&&exposed===undefined,
    copied:assigned.length,remaining:pile.remaining(),uniqueCopies,separate,
    originalPackIsArray:cards.every(c=>Array.isArray(c)),
    minHandSize:Math.min(...hands.map(x=>x.length)),
    hasPlayableCharacters:characterNames.length>=8,
    firstSeatHand:oneSeat.map(c=>c.name)};
  }catch(e){return {stageError:String(e?.code??e?.message??e),details:String(e?.cause?.stack??e?.stack??'').slice(0,850)}}
  })()`);
  assert.equal(report.stageError,undefined,JSON.stringify(report));
  assert.equal(report.stage.realSource,true);
  assert.equal(report.stage.cardPack,'xingBei');
  assert.deepEqual(report.stage.characterPacks,['poXiao','yiDuanYeHuo']);
  assert.ok(report.stage.characterCount>=8);
  assert.ok(report.stage.cardCount>=40);
  assert.equal(report.usable,true);
  assert.equal(report.definedCards,true);
  assert.equal(report.uniqueCharacters,true);
  assert.equal(report.denied,true);
  assert.equal(report.oldGlobalRestored,true);
  assert.equal(report.copied,32);
  assert.equal(report.remaining,report.stage.cardCount-32);
  assert.equal(report.uniqueCopies,true);
  assert.equal(report.separate,true);
  assert.equal(report.originalPackIsArray,true);
  assert.equal(report.minHandSize,4);
  assert.equal(report.hasPlayableCharacters,true);
  assert.equal(report.firstSeatHand.length,4);
  assert.equal((await chrome.inspect()).offboard,true);
 }finally{
  await chrome?.stop();
  await server.close();
 }
});
