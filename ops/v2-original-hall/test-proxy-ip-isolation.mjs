// ISOLATED test: reproduces shared-loopback ban with genuine upstream HALL,
// then verifies the network-IP-only candidate using a loopback proxy simulation.
// All sockets use ephemeral local ports. NO public hosts, no VPS, no gameplay.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import net from "node:net";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { ORIGINAL, CANDIDATE } from "./proxy-ip-fix-candidate.mjs";

const OLD_LISTENER = 'var wss = new WebSocketServer({ port: 8080 });';
const NEW_LISTENER = 'var wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });';

function createSandboxHall(source) {
  let server;
  class CapturedServer extends WebSocketServer {
    constructor(options) {
      super(options);
      server = this;
    }
  }
  const portAnchor = source.includes(OLD_LISTENER) ? OLD_LISTENER : NEW_LISTENER;
  assert.equal(source.split(portAnchor).length - 1, 1);
  const isolated = source.replace(portAnchor, 'var wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });');
  const context = {
    require(name) {
      if (name === "ws") return { Server: CapturedServer };
      if (name === "node:net") return net;
      throw new Error("Unexpected import in isolated HALL: " + name);
    },
    console: { log() {} },
    setTimeout,
    clearTimeout,
    setInterval(fn, duration) {
      assert.equal(duration, 60000, "Original application heartbeat must stay 60 seconds");
      return { isolatedHeartbeat: fn };
    },
    clearInterval() {}
  };
  vm.runInNewContext(isolated, context, { filename: "isolated-original-hall.js" });
  assert.ok(server);
  return server;
}

async function createSimulatedNginx(hallPort) {
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const upstreams = new Set();
  proxy.on("connection", (browser, req) => {
    // This simulates Nginx proxy_set_header X-V2-Client-IP $remote_addr.
    // A client-supplied X-V2-Client-IP is deliberately NEVER forwarded.
    const upstream = new WebSocket("ws://127.0.0.1:" + hallPort, {
      headers: { "X-V2-Client-IP": req.socket.remoteAddress },
      handshakeTimeout: 3000
    });
    upstreams.add(upstream);
    upstream.on("open", () => {});
    upstream.on("message", (data, binary) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
    });
    browser.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    upstream.on("error", () => browser.terminate());
    browser.on("error", () => {});
    browser.on("close", () => {
      if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    });
    upstream.on("close", () => {
      upstreams.delete(upstream);
      if (browser.readyState !== WebSocket.CLOSED) browser.terminate();
    });
  });
  await once(proxy, "listening");
  return { proxy, upstreams };
}

function createClient(port, sourceAddress, extraHeaders = {}) {
  const ws = new WebSocket("ws://127.0.0.1:" + port, {
    localAddress: sourceAddress,
    headers: extraHeaders,
    handshakeTimeout: 3000
  });
  const messages = [];
  const waiting = [];
  ws.on("error", () => {});
  ws.on("message", data => {
    let message = data.toString();
    try { message = JSON.parse(message); } catch {}
    const index = waiting.findIndex(w => w.predicate(message));
    if (index < 0) messages.push(message);
    else waiting.splice(index, 1)[0].resolve(message);
  });
  function next(predicate, timeoutMs = 3000) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const pending = {
        predicate,
        resolve(value) { clearTimeout(timer); resolve(value); }
      };
      const timer = setTimeout(() => {
        const idx = waiting.indexOf(pending);
        if (idx >= 0) waiting.splice(idx, 1);
        reject(new Error("Timeout waiting for HALL message; received: " + JSON.stringify(messages)));
      }, timeoutMs);
      waiting.push(pending);
    });
  }
  return {
    ws,
    open: () => once(ws, "open"),
    next,
    send: (...args) => ws.send(JSON.stringify(args)),
    close: () => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }
  };
}

async function withSandbox(source, exercise) {
  const hall = createSandboxHall(source);
  await once(hall, "listening");
  const sim = await createSimulatedNginx(hall.address().port);
  const clients = [];
  function browser(address, headers) {
    const c = createClient(sim.proxy.address().port, address, headers);
    clients.push(c);
    return c;
  }
  try {
    await exercise({ browser, hall });
  } finally {
    for (const client of clients) client.close();
    for (const socket of sim.upstreams) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    for (const socket of sim.proxy.clients) socket.terminate();
    for (const socket of hall.clients) socket.terminate();
    await Promise.all([
      new Promise(resolve => sim.proxy.close(resolve)),
      new Promise(resolve => hall.close(resolve))
    ]);
  }
}

const isType = type => msg => Array.isArray(msg) && msg[0] === type;
const firstResult = msg => Array.isArray(msg) && (msg[0] === "denied" || msg[0] === "roomlist");

async function causeBanThroughProxy(browser, address, headers = {}) {
  const offender = browser(address, headers);
  await offender.open();
  assert.equal((await offender.next(firstResult))[0], "roomlist");
  offender.send("server", "key", ["offender-key"]);
  offender.send("server", "events", {}, "not-offender-key", "join");
  await Promise.race([
    once(offender.ws, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Offender not closed")), 3000))
  ]);
}

test("REPRODUCTION: original HALL behind loopback proxy bans innocent clients from a different source IP", async () => {
  await withSandbox(ORIGINAL, async ({ browser }) => {
    await causeBanThroughProxy(browser, "127.0.0.2");
    const innocent = browser("127.0.0.3");
    await innocent.open();
    const outcome = await innocent.next(firstResult);
    assert.deepEqual([...outcome], ["denied", "banned"],
      "Original HALL incorrectly bans other source addresses sharing 127.0.0.1 upstream");
  });
});

test("FIX: original room/key protocol retained, offender is denied, independent source remains allowed", async () => {
  await withSandbox(CANDIDATE, async ({ browser }) => {
    await causeBanThroughProxy(browser, "127.0.0.2", {
      // A malicious client tries to supply the innocent party's IP;
      // simulated Nginx overwrites this header with its actual TCP peer.
      "X-V2-Client-IP": "127.0.0.3"
    });
    const innocent = browser("127.0.0.3");
    await innocent.open();
    assert.equal((await innocent.next(firstResult))[0], "roomlist",
      "The second player's independent IP must not be banned");
    innocent.send("server", "key", ["innocent-key"]);
    innocent.send("server", "create", "innocent-key", "owner", "avatar", {}, "xingBei");
    assert.equal((await innocent.next(isType("createroom")))[1], "innocent-key");
    const repeatOffender = browser("127.0.0.2");
    await repeatOffender.open();
    assert.deepEqual([...(await repeatOffender.next(firstResult))], ["denied", "banned"],
      "Original-style per-IP ban must still work for the offending source");
  });
});

test("FIX: backend refuses missing or invalid trusted-proxy IP rather than banning loopback", async () => {
  await withSandbox(CANDIDATE, async ({ hall, browser }) => {
    for (const fakeIp of [undefined, "not-an-ip", "127.0.0.1", "198.51.100.2, 198.51.100.3"]) {
      const headers = fakeIp === undefined ? {} : { "X-V2-Client-IP": fakeIp };
      const ws = new WebSocket("ws://127.0.0.1:" + hall.address().port, {
        headers, handshakeTimeout: 3000
      });
      ws.on("error", () => {});
      await once(ws, "open");
      const [code] = await once(ws, "close");
      assert.equal(code, 1008, "Untrusted backend ingress must close with policy violation");
    }
    const innocent = browser("127.0.0.3");
    await innocent.open();
    assert.equal((await innocent.next(firstResult))[0], "roomlist");
  });
});
