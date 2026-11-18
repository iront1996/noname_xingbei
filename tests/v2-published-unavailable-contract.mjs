#!/usr/bin/env node
/** Standalone local contract: optional origin 503 => mandatory review, required 503 => hard failure. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const script = resolve("tools/v2-published-release-sync.mjs");
const dir = mkdtempSync(join(tmpdir(), "v2-unverified-publication-"));
const pinned="abd687ff7237c24a1fcd05b6524309c73b9cb818";
let denyRequired = false;
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/ui.js" && !denyRequired) {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("window.v2Test = true;\n");
  } else if (path === "/extension/test/extension.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("window.v2ExtensionTest = true;\n");
  } else if (path === "/extension/test/info.json" || (denyRequired && path === "/ui.js")) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("temporarily unavailable");
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
function runCheck() {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath,[script,"--check",pinned,pinned],{cwd:dir});
    let stdout="",stderr="";
    child.stdout.on("data",b=>stdout+=b);
    child.stderr.on("data",b=>stderr+=b);
    child.on("close",code=>resolveRun({code,stdout,stderr}));
    child.on("error",error=>resolveRun({code:-1,stdout,stderr:String(error)}));
  });
}
try {
  await new Promise(resolveListen => server.listen(0,"127.0.0.1",resolveListen));
  mkdirSync(join(dir,"ops"),{recursive:true});
  mkdirSync(join(dir,"extension/test"),{recursive:true});
  writeFileSync(join(dir,"ops/v2-official-publication.json"),JSON.stringify({
    schemaVersion:1,originalWebsite:"http://127.0.0.1:"+server.address().port+"/",
    publishedTextOverlays:["ui.js"],bundledExtensions:["test"]
  }));
  writeFileSync(join(dir,"ui.js"),"window.v2Test = true;\n");
  writeFileSync(join(dir,"extension/test/extension.js"),"window.v2ExtensionTest = true;\n");
  writeFileSync(join(dir,"extension/test/info.json"),'{"v":"old"}\n');
  execFileSync("git",["init","--quiet"],{cwd:dir});
  execFileSync("git",["add","."],{cwd:dir});
  const safe = await runCheck();
  assert.equal(safe.code,0,safe.stderr);
  assert.match(safe.stdout,/CHECK_INCOMPLETE_REVIEW_REQUIRED/);
  const report=JSON.parse(readFileSync("/tmp/v2-auto-sync/publication.json","utf8"));
  assert.equal(report.changed.length,0);
  assert.equal(report.unverifiedOptional.length,1);
  assert.match(report.unverifiedOptional[0].path,/extension\/test\/info.json/);
  assert.ok(report.risky.some(s=>s.includes("UNVERIFIED_OPTIONAL: extension/test/info.json")));
  denyRequired = true;
  const denied = await runCheck();
  assert.notEqual(denied.code,0,"Required published JS HTTP503 must fail closed");
  assert.match(denied.stderr,/HTTP 503 ui.js/);
  console.log("V2_PUBLICATION_OPTIONAL_503_REVIEW_AND_REQUIRED_503_DENIAL_PASS");
} finally {
  server.close();
  rmSync(dir,{recursive:true,force:true});
}
