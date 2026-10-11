import test from 'node:test';
import assert from 'node:assert/strict';
import {launchV3ChromiumAuthorityWorker as launch} from '../game/v3-chromium-authority-worker.mjs';

test('V3 never silently enables unsafe browser mode',async()=>{
 const unsafe=process.env.V3_ALLOW_UNSANDBOXED_TESTS;
 const experiment=process.env.V3_ALLOW_SEAT_EXPERIMENT;
 try{
  delete process.env.V3_ALLOW_UNSANDBOXED_TESTS;
  await assert.rejects(launch({executable:'/usr/bin/chromium',unsafeTestSandbox:true}),
   {code:'WORKER_UNSANDBOXED_DENIED'});
  if(typeof process.getuid==='function'&&process.getuid()===0)
   await assert.rejects(launch({executable:'/usr/bin/chromium'}),
    {code:'WORKER_ROOT_SANDBOX_REQUIRED'});
 }finally{
  if(unsafe===undefined)delete process.env.V3_ALLOW_UNSANDBOXED_TESTS;
  else process.env.V3_ALLOW_UNSANDBOXED_TESTS=unsafe;
  if(experiment===undefined)delete process.env.V3_ALLOW_SEAT_EXPERIMENT;
  else process.env.V3_ALLOW_SEAT_EXPERIMENT=experiment;
 }
});
