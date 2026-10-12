import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const base=readFileSync(join(root,"game/server.js"),"utf8");
const markers="// XINGBEI-CONNECTION-HEALTH A1\n"+
 "// XINGBEI-MONITOR DISCONNECT V2.3\n";
const fixture=markers+base;
const dir=mkdtempSync(join(tmpdir(),"xingbei-v2-preflight-"));
const file=join(dir,"server.js");
function check(source,extra=[]){
 writeFileSync(file,source);
 const p=spawnSync("python3",[
  join(root,"tools/connection-recovery/preflight_v2_hall.py"),
  "--source",file,...extra
 ],{encoding:"utf8",timeout:15000});
 return {code:p.status,out:JSON.parse(p.stdout.trim()),stderr:p.stderr};
}
test("offline validator accepts a synthetic A1+v2.3 source without modifying it",()=>{
 const expect=createHash("sha256").update(fixture).digest("hex");
 const result=check(fixture,["--expected-sha256",expect]);
 assert.equal(result.code,0,result.stderr);
 assert.equal(result.out.ok,true);
 assert.equal(result.out.deploy_performed,false);
 assert.equal(result.out.runtime_compatible,"not_verified");
 assert.equal(result.out.checks.source_sha256,expect);
 assert.equal(result.out.checks.monitor_and_health_markers_preserved,true);
 assert.equal(result.out.checks.patched_node_syntax,true);
 assert.equal(readFileSync(file,"utf8"),fixture);
});
test("source SHA mismatch fails closed and does not change existing source",()=>{
 const result=check(fixture,["--expected-sha256","0".repeat(64)]);
 assert.equal(result.code,1);
 assert.equal(result.out.ok,false);
 assert.match(result.out.error,/SHA-256/);
 assert.equal(readFileSync(file,"utf8"),fixture);
});
test("A1, monitor, or ambiguous duplicate marker prevents patch",()=>{
 for(const source of [
  base,
  "// XINGBEI-CONNECTION-HEALTH A1\n"+base,
  markers+"// XINGBEI-MONITOR DISCONNECT V2.3\n"+base
 ]){
  const result=check(source);
  assert.equal(result.code,1);
  assert.match(result.out.error,/marker/);
  assert.equal(readFileSync(file,"utf8"),source);
 }
});
test("unknown backend source anchors cause a safe failure",()=>{
 const incompatible=fixture.replace('var WebSocketServer = require("ws").Server;',
  'var WebSocketServer = require("ws").Server2;');
 const result=check(incompatible);
 assert.equal(result.code,1);
 assert.match(result.out.error,/anchor/);
 assert.equal(readFileSync(file,"utf8"),incompatible);
});
test("Node parser failure in existing HALL source is flagged before deployment",()=>{
 const broken=fixture+"not valid node javascript ;;;;;";
 const result=check(broken);
 assert.equal(result.code,1);
 assert.match(result.out.error,/syntax check failed/);
 assert.equal(readFileSync(file,"utf8"),broken);
});
process.on("exit",()=>rmSync(dir,{recursive:true,force:true}));
