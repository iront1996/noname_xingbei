'use strict';
const assert=require('node:assert/strict');
const {classify}=require('./a1-policy-candidate.cjs');
const policy={appAckTimeoutMs:45000,pongFreshMs:45000,maxApplicationSilenceMs:120000};
const base={isCurrentSocket:true,readyState:1,now:1000000,lastAppResponseAt:940000,
  pendingSince:940000,lastProbeAt:970000,lastPongAt:990000};
const tests=[
  ['fresh Pong but delayed application ack enters finite grace',()=>{
    assert.equal(classify(base,policy).action,'APPLICATION_STALL_GRACE');
  }],
  ['missing Pong must not excuse app timeout',()=>{
    assert.equal(classify({...base,lastPongAt:0},policy).action,'TERMINATE_SOCKET');
  }],
  ['Pong received only before the probe does not excuse timeout',()=>{
    assert.equal(classify({...base,lastPongAt:950000},policy).action,'TERMINATE_SOCKET');
  }],
  ['application heartbeat reply clears pending state',()=>{
    assert.equal(classify({...base,pendingSince:0,lastAppResponseAt:999999},policy).action,'WAIT');
  }],
  ['fresh Pong cannot excuse a permanently stalled application',()=>{
    assert.equal(classify({...base,lastAppResponseAt:860000,lastPongAt:999000},policy).action,'TERMINATE_SOCKET');
  }],
  ['old websocket has no authority to close replacement',()=>{
    assert.equal(classify({...base,isCurrentSocket:false},policy).action,'IGNORE_STALE_SOCKET');
  }],
  ['closed websocket cancels further action',()=>{
    assert.equal(classify({...base,readyState:3},policy).action,'STOP_CLOSED_SOCKET');
  }],
  ['under app threshold leaves connection unchanged',()=>{
    assert.equal(classify({...base,pendingSince:980000},policy).action,'WAIT');
  }],
];
let failures=0;for(const [name,fn] of tests){try{fn();console.log('PASS',name)}catch(e){failures++;console.log('FAIL',name,e.message)}}
if(failures)process.exit(1);
