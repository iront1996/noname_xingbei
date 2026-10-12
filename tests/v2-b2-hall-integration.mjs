/**
 * V2-2: execute the exact B2 HALL patch output with a fake WebSocket network.
 * No TCP port, no VPS, no timers, no production backend changes.
 * Checks broker ownership + browser B3 reclaim packets, not native game replay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {dirname,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import vm from "node:vm";
import {createRequire} from "node:module";
import {saveSeatCredentials,loadSeatCredentials} from "../noname/util/xingbei-seat-credentials.js";
import {handleSeatRecoveryControl} from "../noname/util/xingbei-recovery-protocol.js";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const realRequire=createRequire(import.meta.url);
const MARK_HEALTH="// XINGBEI-CONNECTION-HEALTH A1";
const MARK_MONITOR="// XINGBEI-MONITOR DISCONNECT V2.3";
const base=readFileSync(join(root,"game/server.js"),"utf8");
const tmp=mkdtempSync(join(tmpdir(),"xingbei-v2-b2-contract-"));
function patch(source){
 const input=join(tmp,"source.js"),output=join(tmp,"patched.js");
 writeFileSync(input,source);
 const p=spawnSync("python3",[
  join(root,"tools/connection-recovery/patch_server_b2.py"),
  "--source",input,"--output",output
 ],{cwd:root,encoding:"utf8",timeout:10000});
 return {status:p.status,stderr:p.stderr,stdout:p.stdout,
  code:p.status===0?readFileSync(output,"utf8"):null};
}
class FakeWS{
 constructor(){
  this.handlers=new Map();
  this.outbound=[];
  this._socket={remoteAddress:"127.0.0.1"};
  this.closed=false;
 }
 on(name,cb){this.handlers.set(name,cb);return this}
 send(value){if(this.closed)throw Error("CLOSED_SOCKET");this.outbound.push(String(value))}
 receive(packet){
  const text=typeof packet==="string"?packet:JSON.stringify(packet);
  this.handlers.get("message")?.call(this,text);
 }
 close(){
  if(this.closed)return;
  this.closed=true;
  this.handlers.get("close")?.call(this);
 }
 terminate(){this.close()}
 packets(){
  return this.outbound.map(raw=>{
   try{return JSON.parse(raw)}catch{return raw}
  });
 }
 last(type){return this.packets().filter(x=>Array.isArray(x)&&x[0]===type).at(-1)}
}
function runFakeHall(code){
 let server=null;
 class FakeWSS {
  constructor({port}){assert.equal(port,8080);server=this}
  on(event,cb){if(event==="connection")this.accept=cb}
  connect(){const socket=new FakeWS();this.accept(socket);return socket}
 }
 vm.runInNewContext(code,{
  require(spec){
   if(spec==="ws")return {Server:FakeWSS};
   if(spec==="./xingbei-seat-registry.js")
    return realRequire("../tools/connection-recovery/seat-registry.js");
   if(spec==="./xingbei-hall-progress-watch.js")
    return realRequire("../tools/connection-recovery/xingbei-hall-progress-watch.js");
   throw Error("UNEXPECTED_DEPENDENCY:"+spec);
  },
  setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>2,clearInterval:()=>{},
  console:{log(){},warn(){},error(){}}
 },{filename:"B2-isolated-hall.js",timeout:1000});
 assert.ok(server);
 return server;
}
const secret="ab".repeat(32);
const endpoint="wss://hall.invalid";
const publicKey="public-id-not-a-secret";
const roomKey="room-A";
function send(ws,...message){ws.receive(["server",...message])}
test("B2 patch fails closed for incomplete deployment prerequisites",()=>{
 const noA=patch(base);
 assert.notEqual(noA.status,0);
 assert.match(noA.stderr,/A1 heartbeat upgrade required/);
 const noMonitor=patch(MARK_HEALTH+"\n"+base);
 assert.notEqual(noMonitor.status,0);
 assert.match(noMonitor.stderr,/monitor v2.3 hook marker missing/);
});
test("generated B2 HALL and B3 browser reclaim prevent old-socket false-online",()=>{
 const result=patch(MARK_HEALTH+"\n"+MARK_MONITOR+"\n"+base);
 assert.equal(result.status,0,result.stderr);
 assert.ok(result.code.includes(MARK_HEALTH));
 assert.ok(result.code.includes(MARK_MONITOR));
 assert.ok(result.code.includes("// XINGBEI-RECOVERY B2"));
 const srv=runFakeHall(result.code);
 const owner=srv.connect();
 send(owner,"key",[roomKey,"version"]);
 send(owner,"create",roomKey,"Host","avatar");
 send(owner,"config",{gameStarted:false,observe:false});
 const guest=srv.connect();
 send(guest,"key",[publicKey,"version"]);
 send(guest,"enter",roomKey,"Guest","avatar");
 const initialSeat=guest.wsid;
 const credential=guest.last("xbSeatCredentials");
 assert.ok(credential,"accepted guest gets a direct credential");
 assert.deepEqual(credential.slice(1,3),[roomKey,initialSeat]);
 assert.match(credential[3],/^[0-9a-f]{64}$/);
 assert.equal(owner.last("onconnection")[1],initialSeat);
 assert.equal(owner.packets().some(p=>Array.isArray(p)&&p[0]==="xbSeatCredentials"),false,
  "guest secret not sent to owner or lobby");
 // Running games reject new 'enter', but a credentialed seat may reclaim.
 send(owner,"config",{gameStarted:true,observe:false});
 const attacker=srv.connect();
 send(attacker,"key",[publicKey,"version"]);
 send(attacker,"xbResumeSeat",roomKey,initialSeat,"00".repeat(32));
 assert.equal(attacker.last("xbSeatResumeRejected")[0],"xbSeatResumeRejected");
 assert.equal(attacker.owner,undefined);
 const gate={
  active:true,phase:"SYNCING",completed:false,
  synchronized(kind){if(!this.active||kind!=="reinit")return false;
   this.active=false;this.completed=true;return true},
  reject(reason){this.active=false;this.rejected=reason},
  connectionLost(){}
 };
 const state={roomId:roomKey,onlineID:initialSeat,
  _xingbeiRecovery:gate,_xingbeiReclaimRequested:false,_xingbeiSeatReclaimed:false};
 const storage={map:new Map(),
  getItem(k){return this.map.get(k)??null},
  setItem(k,v){this.map.set(k,String(v))},
  removeItem(k){this.map.delete(k)}
 };
 assert.equal(handleSeatRecoveryControl(credential,{state:{},storage,endpoint}),true);
 assert.deepEqual(loadSeatCredentials(storage,endpoint),{
  roomId:roomKey,seatId:initialSeat,token:credential[3]
 });
 const restored=srv.connect();
 const reply=[];const opts={state,storage,endpoint,onlineKey:publicKey,version:"version",
  send(...packet){reply.push(packet);restored.receive(packet)}};
 const lobby=restored.last("roomlist");
 assert.equal(handleSeatRecoveryControl(lobby,opts),true);
 assert.deepEqual(reply.map(p=>p.slice(0,2)),[
  ["server","key"],["server","xbResumeSeat"]
 ]);
 assert.equal(restored.wsid,initialSeat,"current guest receives original stable id");
 assert.equal(guest.closed,true,"old socket forcibly retired");
 assert.equal(owner.last("onconnection")[1],initialSeat);
 assert.equal(owner.packets().filter(p=>Array.isArray(p)&&p[0]==="onclose").length,0,
  "old socket close must not mark the replacement offline");
 assert.equal(restored.last("xbSeatReclaimed")[0],"xbSeatReclaimed");
 assert.equal(gate.completed,false,"broker takeover is not completed game state");
 assert.equal(state._xingbeiSeatReclaimed,false);
 assert.equal(handleSeatRecoveryControl(restored.last("xbSeatReclaimed"),opts),true);
 assert.equal(state._xingbeiSeatReclaimed,true);
 const before=owner.packets().length;
 guest.receive(["result",{cheat:true}]);
 guest.receive(["server","status","malicious"]);
 guest.close();
 assert.equal(owner.packets().length,before,"stale guest cannot relay packets or emit close");
 send(owner,"send",initialSeat,JSON.stringify(["reinit",{phaseNumber:7}]));
 assert.deepEqual(restored.last("reinit"),["reinit",{phaseNumber:7}],
  "owner sends recovery snapshot to newly bound stable seat");
 assert.equal(gate.completed,false,"receiving a packet is not an applied snapshot");
 assert.equal(gate.synchronized("reinit"),true);
 assert.equal(gate.completed,true);
 const newConnectionCount=owner.packets().filter(p=>Array.isArray(p)&&p[0]==="onconnection").length;
 assert.equal(newConnectionCount,2);
 // The same credential works for a subsequent authenticated retry after loss.
 restored.close();
 assert.equal(owner.last("onclose")[1],initialSeat);
 const again=srv.connect();send(again,"key",[publicKey,"version"]);
 send(again,"xbResumeSeat",roomKey,initialSeat,credential[3]);
 assert.equal(again.last("xbSeatReclaimed")[2],initialSeat);
 assert.equal(owner.last("onconnection")[1],initialSeat);
 owner.close();
 const afterOwner=srv.connect();send(afterOwner,"key",[publicKey,"version"]);
 send(afterOwner,"xbResumeSeat",roomKey,initialSeat,credential[3]);
 assert.ok(afterOwner.last("xbSeatResumeRejected"),
  "legacy owner leaving invalidates room; cannot pretend room persists");
});
process.on("exit",()=>{rmSync(tmp,{recursive:true,force:true})});
