// V2 HALL WebSocket text-relay compatibility candidate.
// Pure, pinned source transform only; NEVER writes /opt or alters any live service.
// Preserve original binary forwarding, heartbeat, native host/game rules and
// the already-deployed trusted Nginx source-IP security exception.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CANDIDATE as PROXY_IP_CANDIDATE } from "./proxy-ip-fix-candidate.mjs";

export const PREVIOUS_LIVE_SHA256 =
  "963f3a155ad00f5a7b1cdc00937c6d4240fb34f93a94938f2e4629cbf2ea9bb6";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function one(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, "Unexpected HALL drift at: " + before);
  return source.replace(before, after);
}

export function buildRelayTextCandidate(source) {
  assert.equal(sha256(source), PREVIOUS_LIVE_SHA256,
    "Refusing to alter any HALL except exactly the deployed V2 proxy-IP candidate");
  let result = one(source,
    'ws.on("message", function (message) {',
    'ws.on("message", function (message, isBinary) {');
  result = one(result,
    'this.owner.sendl("onmessage", this.wsid, message);',
    'this.owner.sendl("onmessage", this.wsid, !isBinary && Buffer.isBuffer(message) ? message.toString("utf8") : message);');
  assert.ok(result.includes('if (message == "heartbeat")'));
  assert.ok(result.includes('ws.send("heartbeat")'));
  assert.ok(result.includes('ws._v2ClientAddress = ip;'));
  assert.ok(result.includes('this.owner.sendl("onconnection", this.wsid);'));
  return result;
}

export const RELAY_TEXT_CANDIDATE = buildRelayTextCandidate(PROXY_IP_CANDIDATE);

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/proxy-relay-text-fix-candidate.mjs")) {
  assert.ok(process.argv.includes("--check"), "Only read-only --check is supported");
  console.log("DEPLOYED PREVIOUS SHA256", PREVIOUS_LIVE_SHA256);
  console.log("NEW CANDIDATE SHA256", sha256(RELAY_TEXT_CANDIDATE));
  console.log("PASS: text WebSocket message -> UTF-8 string only when !isBinary; binary and heartbeat unchanged");
  console.log("NO FILES WRITTEN. Do not deploy without zero-session gate and explicit V2 approval.");
}
