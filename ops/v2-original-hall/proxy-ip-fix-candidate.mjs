// V2 proxy IP safety candidate. PURE TRANSFORM: NO LIVE APPLY OR FILE WRITES.
// The input must be the byte-identical upstream HALL file game/server.js.
// Only the network-side bannedIps identity is changed; room/gameplay behavior
// and original 60-second application-layer heartbeat remain unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_ORIGINAL_SHA = "49a0ad87ffc2638e3651fe6a08b5a150cdf38de3";
export const TRUSTED_HEADER = "X-V2-Client-IP";
const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../game/server.js");

function gitBlob(text) {
  const bytes = Buffer.from(text);
  return createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex");
}
function replaceExact(source, before, after, count = 1) {
  assert.equal(source.split(before).length - 1, count,
    "Original HALL source drifted: expected exactly " + count + " occurrences of " + before);
  return source.split(before).join(after);
}

export function buildProxyIpCandidate(original) {
  assert.equal(gitBlob(original), PINNED_ORIGINAL_SHA, "Refusing to patch unpinned original HALL");
  let s = original;
  s = replaceExact(s,
    'var WebSocketServer = require("ws").Server;',
    'var WebSocketServer = require("ws").Server;\n\tvar net = require("node:net");');
  s = replaceExact(s,
    'var wss = new WebSocketServer({ port: 8080 });',
    'var wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });');
  s = replaceExact(s,
    'wss.on("connection", function (ws) {\n\t\tws.sendl = util.sendl;',
    'wss.on("connection", function (ws, request) {\n' +
    '\t\t// Ingress trust boundary: HALL accepts only local Nginx connections.\n' +
    '\t\t// Nginx MUST overwrite X-V2-Client-IP with $remote_addr (not XFF).\n' +
    '\t\t// Refuse missing/bad metadata; never record loopback as a banned player IP.\n' +
    '\t\tvar peer = ws._socket.remoteAddress;\n' +
    '\t\tvar ip = request && request.headers && request.headers["x-v2-client-ip"];\n' +
    '\t\tif (peer !== "127.0.0.1" || typeof ip !== "string" ||\n' +
    '\t\t\t!net.isIP(ip) || ip === "127.0.0.1" || ip === "::1" ||\n' +
    '\t\t\tip === "0.0.0.0" || ip === "::") {\n' +
    '\t\t\tws.close(1008, "trusted ingress required");\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n' +
    '\t\tws._v2ClientAddress = ip;\n' +
    '\t\tws.sendl = util.sendl;');
  s = replaceExact(s, 'bannedIps.push(this._socket.remoteAddress);',
    'bannedIps.push(this._v2ClientAddress);', 2);
  s = replaceExact(s, 'console.log(id, this._socket.remoteAddress);',
    'console.log(id, this._v2ClientAddress);');
  s = replaceExact(s, 'bannedIps.indexOf(ws._socket.remoteAddress)',
    'bannedIps.indexOf(ws._v2ClientAddress)');
  assert.ok(!s.includes("bannedIps.push(this._socket.remoteAddress)"));
  assert.ok(!s.includes("bannedIps.indexOf(ws._socket.remoteAddress)"));
  return s;
}

export const ORIGINAL = readFileSync(path, "utf8");
export const CANDIDATE = buildProxyIpCandidate(ORIGINAL);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.includes("--check"), "Only --check is supported; no deploy mode");
  console.log("ORIGINAL HALL GIT SHA", gitBlob(ORIGINAL));
  console.log("PROXY IP CANDIDATE SHA256", createHash("sha256").update(CANDIDATE).digest("hex"));
  console.log("PASS: pinned HALL + loopback-only listener + four IP-security references patched");
  console.log("NO FILES WRITTEN. DO NOT INSTALL WITHOUT AN EXPLICIT SAFETY REVIEW.");
}
