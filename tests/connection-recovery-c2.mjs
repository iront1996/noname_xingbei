import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ChoiceLeaseRegistry} from "../noname/util/xingbei-choice-lease.js";

const source = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");
function segment(text,startText,endText){
  const start=text.indexOf(startText), end=text.indexOf(endText,start+startText.length);
  assert.ok(start>=0 && end>start, "missing method boundary: "+startText);
  return text.slice(start,end);
}
const timers=new Map();let tid=0, resumes=0, previews=0;
const schedule=(fn,ms)=>{const id=++tid;timers.set(id,{fn,ms});return id;};
const unschedule=id=>timers.delete(id);
const lib={node:{torespond:{},torespondtimeout:{},observing:[]},playerOL:{},configOL:{choose_timeout:10}};
const status={event:{_global_timer:false,getParent:()=>({skillHidden:false})},paused:true,noclearcountdown:null};
const game={players:[],resume(){resumes++;}},get={event:()=>false};
const playerCode=source("noname/library/element/player.js");
const libraryCode=source("noname/library/index.js");
const playerMethods=new Function("lib","_status","game","get","ChoiceLeaseRegistry","setTimeout","clearTimeout",
  "return class{"+segment(playerCode,"\twait(callback) {","\ttempUnwait(result) {")+"}")
  (lib,status,game,get,ChoiceLeaseRegistry,schedule,unschedule).prototype;
const host=new Function("lib","return ({"+
  segment(libraryCode,"\t\t\txbChoiceHello(protocolVersion) {","\t\t\tstartGame() {")+"})")(lib);
function socket(id){return {id,inited:true,closed:false,sent:[],send(...msg){this.sent.push(msg);}};}
function seat(id,ws){
  const p={playerid:id,ws,wait:playerMethods.wait,unwait:playerMethods.unwait,
    tempUnwait(){previews++;},showTimer(){},hideTimer(){}};
  lib.playerOL[id]=p;game.players.push(p);return p;
}
const ws=socket("seat"),player=seat("seat",ws);
host.xbChoiceHello.call(ws,1);
assert.equal(player._xingbeiChoiceRequired,true);
player.wait();
let ticket=ws.sent.findLast(m=>m[0]==="xbChoiceLease")[1];
assert.match(ticket,/^c2:[0-9a-z]+$/);
host.result.call(ws,{bool:true},"c2:invalid");
host.result.call(ws,{bool:true});
assert.equal(resumes,0,"missing/wrong IDs rejected");
host.result.call(ws,{bool:true},ticket);
host.result.call(ws,{bool:true},ticket);
assert.equal(resumes,1,"one accepted settlement");
assert.deepEqual(ws.sent.findLast(m=>m[0]==="xbChoiceSettled"),["xbChoiceSettled",ticket]);
player.wait();
const old=ws.sent.findLast(m=>m[0]==="xbChoiceLease")[1];
player.wait();
const next=ws.sent.findLast(m=>m[0]==="xbChoiceLease")[1];
assert.notEqual(old,next);
host.result.call(ws,{bool:true},old);
host.tempResult.call(ws,{bool:true},old);
assert.equal(resumes,1);assert.equal(previews,0);
host.tempResult.call(ws,{bool:true},next);
assert.equal(previews,1);
const ws2=socket("seat");player.ws=ws2;
host.result.call(ws,{bool:true},next);
host.result.call(ws2,{bool:true},next);
assert.equal(resumes,1,"old socket and downgraded client rejected");
host.xbChoiceHello.call(ws2,1);
assert.deepEqual(ws2.sent.findLast(m=>m[0]==="xbChoiceLease"),["xbChoiceLease",next]);
host.result.call(ws2,{bool:true},next);
assert.equal(resumes,2,"reclaimed socket with correct ID accepted");
const legacy=socket("legacy");
seat("legacy",legacy).wait();
host.result.call(legacy,{bool:true});
assert.equal(resumes,3,"unnegotiated legacy client remains supported");
const client={_xingbeiChoiceTicket:null};
const handlers=new Function("game","return ({"+
  segment(libraryCode,"\t\t\txbChoiceLease(wireId) {","\t\t\tlog: function (arr) {")+"})")(client);
handlers.xbChoiceLease("c2:old");
handlers.xbChoiceLease("c2:new");
handlers.xbChoiceSettled("c2:old");
assert.equal(client._xingbeiChoiceTicket,"c2:new");
handlers.xbChoiceSettled("c2:new");
assert.equal(client._xingbeiChoiceTicket,null);
handlers.xbChoiceLease("invalid");
assert.equal(client._xingbeiChoiceTicket,null);
const initCode=source("noname/library/init/index.js");
const emission=[], clientGame={_xingbeiChoiceTicket:"c2:sample",pause(){},send(...a){emission.push(a);}};
const ev={_resultid:null,goto(){}}, reply={bool:true};
new Function("game","event","result","return ({"+
  segment(initCode,"\tstartOnline() {","\tonfree() {")+"})")
  (clientGame,ev,reply).startOnline();
assert.deepEqual(emission,[["result",reply,"c2:sample"]]);
assert.equal(clientGame._xingbeiChoiceTicket,null);
console.log("PASS C2: strict ticket negotiation, replay protection, reconnect handoff, legacy clients, client result");
