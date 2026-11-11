#!/usr/bin/env node
// Read-only real-network verification for the future DNS-only WSS :50000 V2 endpoint.
// No room is created. Only a temporary client key is sent, per original HALL protocol.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import tls from "node:tls";

const HOST = "v2-hall-direct.myxingbei.com";
const EXPECTED_IP = "172.234.84.27";
const PORT = 50000;
const heartbeatMode = process.argv.includes("--heartbeat");

async function withDeadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function watchMessages(socket) {
  const received = [];
  const waiter = [];
  let closeReason;
  function failAll(error) {
    for (const item of waiter.splice(0)) item.reject(error);
  }
  socket.addEventListener("message", event => {
    const raw = String(event.data);
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch {}
    for (const item of [...waiter]) {
      if (item.predicate(parsed)) {
        waiter.splice(waiter.indexOf(item), 1);
        item.resolve(parsed);
        return;
      }
    }
    received.push(parsed);
  });
  socket.addEventListener("close", e => {
    closeReason = "code=" + e.code + " clean=" + e.wasClean;
    failAll(new Error("WebSocket closed: " + closeReason));
  });
  socket.addEventListener("error", () => {
    failAll(new Error("WebSocket error" + (closeReason ? ": " + closeReason : "")));
  });
  return {
    next(predicate, ms, label) {
      const index = received.findIndex(predicate);
      if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
      if (socket.readyState === WebSocket.CLOSED) {
        return Promise.reject(new Error("WebSocket already closed: " + closeReason));
      }
      return new Promise((resolve, reject) => {
        const item = {
          predicate,
          resolve(message) { clearTimeout(timer); resolve(message); },
          reject(error) { clearTimeout(timer); reject(error); }
        };
        const timer = setTimeout(() => {
          const index = waiter.indexOf(item);
          if (index >= 0) waiter.splice(index, 1);
          reject(new Error(label + " timed out after " + ms + "ms"));
        }, ms);
        waiter.push(item);
      });
    }
  };
}

async function main() {
  const a = await dns.resolve4(HOST);
  assert.deepEqual([...a].sort(), [EXPECTED_IP], "DNS must return only the actual VPS public IPv4");
  let aaaa = [];
  try {
    aaaa = await dns.resolve6(HOST);
  } catch (e) {
    if (!["ENODATA", "ENOTFOUND", "ESERVFAIL"].includes(e.code)) throw e;
  }
  assert.deepEqual(aaaa, [], "Unexpected AAAA can route browsers to a different origin");
  console.log("PASS DNS only A:", HOST, "=>", a.join(", "));
  const tlsResult = await withDeadline(new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: HOST, port: PORT, servername: HOST,
      rejectUnauthorized: true, timeout: 9000
    });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const result = { protocol: socket.getProtocol(), authorized: socket.authorized, expires: cert.valid_to };
      socket.end();
      resolve(result);
    });
    socket.once("timeout", () => socket.destroy(new Error("TLS connection timed out")));
    socket.once("error", reject);
  }), 11000, "TLS handshake");
  assert.ok(tlsResult.authorized && tlsResult.protocol, "Trusted TLS certificate required");
  console.log("PASS TLS:", tlsResult.protocol, "| cert expires:", tlsResult.expires);

  if (typeof WebSocket !== "function") throw new Error("Node.js 22+ global WebSocket required");
  const socket = new WebSocket("wss://" + HOST + ":" + PORT);
  const received = watchMessages(socket);
  try {
    await withDeadline(new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket 101 upgrade failed")), { once: true });
    }), 11000, "WSS Upgrade 101");
    console.log("PASS WebSocket 101 Upgrade");

    const initial = await received.next(
      msg => Array.isArray(msg) && msg[0] === "roomlist",
      5000, "Original HALL roomlist"
    );
    assert.ok(Array.isArray(initial[1]), "Original HALL roomlist malformed");
    assert.equal(typeof initial[4], "string", "Expected original wsid");
    socket.send(JSON.stringify(["server", "key", [randomUUID()]]));
    console.log("PASS original HALL roomlist/key protocol; temporary key sent");

    if (heartbeatMode) {
      // Original HALL emits application TEXT heartbeat every 60 s. This mode
      // tests two cycles, replying with the matching literal text, not WS PING.
      for (let i = 1; i <= 2; i++) {
        await received.next(msg => msg === "heartbeat", 72000, "Original HALL heartbeat " + i);
        socket.send("heartbeat");
        console.log("PASS original 60-second application heartbeat #" + i);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(socket.readyState, WebSocket.OPEN, "HALL closed despite heartbeat replies");
    }
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "smoke complete");
  }
  console.log("DIRECT WSS CHECK PASS; no gameplay rules or room state modified");
}

main().catch(e => {
  console.error("DIRECT WSS CHECK FAILED:", e.message);
  process.exitCode = 1;
});
