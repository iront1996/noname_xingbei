import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createV3NativeModuleTestServer} from './v3-native-module-test-server.mjs';
import {launchV3ChromiumAuthorityWorker} from '../game/v3-chromium-authority-worker.mjs';

const executable=process.env.V3_CHROMIUM;
const active=typeof executable==='string'&&executable.startsWith('/');
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('load ACTUAL Noname and XingBei modules in independent Chrome, install off-board result adapter',
 {skip:!active,timeout:60000},async()=>{
 const host=await createV3NativeModuleTestServer({root:repoRoot});
 let chrome;
 try{
  chrome=await launchV3ChromiumAuthorityWorker({executable});
  const native=await chrome.loadV3NativeModules({origin:host.origin});
  assert.deepEqual(native,{
   loaded:true,mode:'xingBei',offboard:true,nativeGame:true,nativeResult:true,gameLoopStarted:false
  });
  const result=await chrome.evaluateSeatExperiment(`(async()=>{
   const {core,mode}=window.__v3NativeXingBeiTest;
   const {installV3HostNeutralOutcome}=await import('/game/v3-native-xingbei-outcome-adapter.mjs');
   const game=core.game;
   game.me=document.createElement('div'); // off-board engine identity
   const playerId=n=>'player_'+n.toString(16).padStart(32,'0');
   game.players=Array.from({length:4},(_,i)=>({
    playerid:playerId(i+1),side:i%2===0
   }));
   game.hongShiQi=15;game.lanShiQi=15;
   game.hongXingBei=0;game.lanXingBei=0;game.xingBeiMax=5;
   // Game.over exists in the native object, but MUST NOT be invoked.
   const originalOver=game.over;
   game.over=()=>{throw Error('HOST_SIDE_DEPENDENT_OVER_FORBIDDEN')};
   const published=[];
   const installed=installV3HostNeutralOutcome({
    game,mode,onTerminal:payload=>published.push(payload)
   });
   const ongoing=game.checkResult();
   game.lanShiQi=0;
   const terminal=mode.game.checkResult();
   const firstWon=mode.game.checkOnlineResult(game.players[0]);
   const secondWon=mode.game.checkOnlineResult(game.players[1]);
   const again=game.checkResult();
   game.over=originalOver;
   return {ongoing,terminal,publishedCount:published.length,firstWon,secondWon,
    deterministic:again===terminal,installed:installed.terminalResult()===terminal,
    usedActualGame:typeof core.Game==='function'&&game instanceof core.Game};
  })()`);
  assert.equal(result.usedActualGame,true);
  assert.deepEqual(result.ongoing,{ok:true,terminal:false,winner:null});
  assert.equal(result.terminal.winner,'hong');
  assert.equal(result.publishedCount,1);
  assert.equal(result.firstWon,true);
  assert.equal(result.secondWon,false);
  assert.equal(result.deterministic,true);
  assert.equal(result.installed,true);
  assert.equal((await chrome.inspect()).offboard,true);
 }finally{
  await chrome?.stop();
  await host.close();
 }
});
