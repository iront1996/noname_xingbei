// Real Nginx process + pinned HALL in isolated GitHub Actions; no VPS involved.
// Tests that the exact V2 nginx site forwards its actual TCP peer as the ONLY
// trusted client IP, even if the WebSocket client sends a forged IP header.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { ORIGINAL, CANDIDATE } from "./proxy-ip-fix-candidate.mjs";
import { RELAY_TEXT_CANDIDATE } from "./proxy-relay-text-fix-candidate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nginxTemplate = readFileSync(join(root, "ops/v2-original-hall/nginx-wss-50000.conf.example"), "utf8");
const oldListener = 'var wss = new WebSocketServer({ port: 8080 });';
const newListener = 'var wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });';

function sandboxHall(src) {
  let backend;
  class TestServer extends WebSocketServer {
    constructor(options) { super(options); backend = this; }
  }
  const listener = src.includes(oldListener) ? oldListener : newListener;
  assert.ok(src.includes(listener));
  const script = src.replace(listener, 'var wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });');
  vm.runInNewContext(script, {
    require(name) {
      if (name === "ws") return { Server: TestServer };
      if (name === "node:net") return net;
      throw Error("Unexpected dependency");
    },
    setTimeout, clearTimeout, Buffer,
    setInterval(fn, ms) {
      assert.equal(ms, 60000);
      return 1;
    },
    clearInterval() {},
    console: { log() {} }
  });
  return backend;
}

async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}

async function waitForNginx(port, process) {
  for (let i = 0; i < 80; i++) {
    if (process.exitCode !== null) throw new Error("Nginx exited before listening: " + process.exitCode);
    const ok = await new Promise(resolve => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Isolated Nginx never started on ephemeral TCP port");
}

function startClient(port, ip, headers = {}) {
  const ws = new WebSocket("ws://127.0.0.1:" + port, {
    localAddress: ip, headers, handshakeTimeout: 4000
  });
  const messages = [], waiters = [];
  ws.on("error", () => {});
  ws.on("message", data => {
    let v = data.toString();
    try { v = JSON.parse(v); } catch {}
    const w = waiters.findIndex(x => x.predicate(v));
    if (w === -1) messages.push(v);
    else waiters.splice(w, 1)[0].resolve(v);
  });
  return {
    ws,
    open: () => once(ws, "open"),
    next(predicate) {
      const i = messages.findIndex(predicate);
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const pending = { predicate, resolve: v => { clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(pending);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timeout: nginx/HALL response " + JSON.stringify(messages)));
        }, 3500);
        waiters.push(pending);
      });
    },
    send: (...x) => ws.send(JSON.stringify(x))
  };
}

async function withRealNginx(src, check) {
  const hall = sandboxHall(src);
  await once(hall, "listening");
  const port = await freePort();
  const folder = mkdtempSync(join(tmpdir(), "xingbei-nginx-isolated-"));
  const configPath = join(folder, "nginx.conf");
  const site = nginxTemplate
    .replace("listen 50000 ssl;", "listen 127.0.0.1:" + port + ";")
    .replace(/^\s*ssl_certificate .*;\n/gm, "")
    .replace(/^\s*ssl_certificate_key .*;\n/gm, "")
    .replace(/^\s*ssl_protocols .*;\n/gm, "")
    .replace("proxy_pass http://127.0.0.1:8080;", "proxy_pass http://127.0.0.1:" + hall.address().port + ";")
    .replace("/var/log/nginx/v2-original-hall-access.log", join(folder, "access.log"))
    .replace("/var/log/nginx/v2-original-hall-error.log", join(folder, "error.log"));
  assert.ok(site.includes("proxy_set_header X-V2-Client-IP $remote_addr;"));
  assert.ok(site.includes('proxy_set_header X-Forwarded-For "";'));
  assert.ok(!site.includes("/etc/letsencrypt/live"), "Do not use production certs in isolated test");
  writeFileSync(configPath, [
    "worker_processes 1;",
    "pid " + join(folder, "nginx.pid") + ";",
    "error_log " + join(folder, "nginx-master-error.log") + " warn;",
    "events { worker_connections 128; }",
    "http {",
    site,
    "}"
  ].join("\n"));
  const nginx = spawn("nginx", ["-c", configPath, "-p", folder + "/", "-g", "daemon off;"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let errorLog = "";
  nginx.stderr.on("data", d => { errorLog += d.toString(); });
  const clients = [];
  function browser(address, headers) {
    const c = startClient(port, address, headers);
    clients.push(c);
    return c;
  }
  try {
    await waitForNginx(port, nginx);
    await check(browser);
  } catch (e) {
    e.message += " | isolated nginx stderr: " + errorLog.slice(-1100);
    throw e;
  } finally {
    for (const c of clients) if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
    for (const c of hall.clients) c.terminate();
    nginx.kill("SIGTERM");
    await Promise.race([
      once(nginx, "exit"),
      new Promise(resolve => setTimeout(resolve, 2500))
    ]);
    if (nginx.exitCode === null && nginx.signalCode === null) nginx.kill("SIGKILL");
    await new Promise(resolve => hall.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
}

const initial = x => Array.isArray(x) && (x[0] === "roomlist" || x[0] === "denied");

async function banOne(browser) {
  const offender = browser("127.0.0.2", { "X-V2-Client-IP": "127.0.0.3" });
  await offender.open();
  assert.equal((await offender.next(initial))[0], "roomlist");
  offender.send("server", "key", ["nginx-offender"]);
  offender.send("server", "events", {}, "invalid-nginx-offender-id", "join");
  await Promise.race([
    once(offender.ws, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Offender did not disconnect")), 3000))
  ]);
}

test("real isolated Nginx: pinned original HALL mistakenly bans the different-IP next client", async () => {
  await withRealNginx(ORIGINAL, async browser => {
    await banOne(browser);
    const innocent = browser("127.0.0.3");
    await innocent.open();
    assert.deepEqual([...(await innocent.next(initial))], ["denied", "banned"]);
  });
});

test("real isolated Nginx: header overwrite + candidate HALL isolate different IPs", async () => {
  await withRealNginx(CANDIDATE, async browser => {
    await banOne(browser);
    const innocent = browser("127.0.0.3");
    await innocent.open();
    assert.equal((await innocent.next(initial))[0], "roomlist");
    innocent.send("server", "key", ["nginx-innocent"]);
    const repeating = browser("127.0.0.2");
    await repeating.open();
    assert.deepEqual([...(await repeating.next(initial))], ["denied", "banned"]);
  });
});


test("real isolated Nginx: protected HALL accepts ordinary host room, guest enter and host-to-guest relay", async () => {
  await withRealNginx(CANDIDATE, async browser => {
    const host = browser("127.0.0.2");
    await host.open();
    assert.equal((await host.next(initial))[0], "roomlist");
    host.send("server", "key", ["normal-room-host-key"]);
    host.send("server", "create", "normal-room-host-key", "normal-host", "avatar", {}, "xingBei");
    const created = await host.next(x => Array.isArray(x) && x[0] === "createroom");
    assert.equal(created[1], "normal-room-host-key");
    const roomConfig = {
      version: 27, mode: "xingBei", number: 4, characterPack: [],
      gameStarted: false, observe: true, observeReady: true
    };
    host.send("server", "config", roomConfig);

    const guest = browser("127.0.0.3");
    await guest.open();
    const roomlist = await guest.next(initial);
    assert.equal(roomlist[0], "roomlist");
    const rooms = roomlist[1];
    const offered = rooms.find(room => Array.isArray(room) && room[4] === "normal-room-host-key");
    assert.ok(offered, "The normal host's room must be visible in the guest roomlist");
    assert.equal(offered[2].version, 27, "Game version must be retained as original host sent it");
    assert.equal(offered[2].number, 4);
    guest.send("server", "key", ["normal-room-guest-key"]);
    guest.send("server", "enter", "normal-room-host-key", "normal-guest", "avatar");

    const notification = await host.next(x => Array.isArray(x) && x[0] === "onconnection");
    assert.equal(typeof notification[1], "string", "HALL must forward visitor WSID to real host");
    host.send("server", "send", notification[1], "native-host-to-guest-ack");
    assert.equal(await guest.next(x => x === "native-host-to-guest-ack"),
      "native-host-to-guest-ack", "HALL must relay host response to guest");
  });
});


async function enterWithNativeHandshake(browser) {
  const host = browser("127.0.0.2");
  await host.open();
  assert.equal((await host.next(initial))[0], "roomlist");
  host.send("server", "key", ["relay-test-host-key"]);
  host.send("server", "create", "relay-test-host-key", "host", "avatar", {}, "xingBei");
  assert.equal((await host.next(x => Array.isArray(x) && x[0] === "createroom"))[1], "relay-test-host-key");
  host.send("server", "config", {
    version: 27, mode: "xingBei", number: 4, characterPack: [],
    gameStarted: false, observe: true, observeReady: true
  });
  const guest = browser("127.0.0.3");
  await guest.open();
  const roomlist = await guest.next(initial);
  assert.equal(roomlist[0], "roomlist");
  assert.ok(roomlist[1].some(x => Array.isArray(x) && x[4] === "relay-test-host-key"),
    "Guest must see host's configured room");
  guest.send("server", "key", ["relay-test-guest-key"]);
  guest.send("server", "enter", "relay-test-host-key", "guest", "avatar");
  const onconnection = await host.next(x => Array.isArray(x) && x[0] === "onconnection");
  assert.equal(typeof onconnection[1], "string");
  host.send("server", "send", onconnection[1], '["opened"]');
  assert.equal(await guest.next(x => x === '["opened"]'), '["opened"]');
  // Native browser-side lib.message.client.opened sends init as a JSON text frame.
  guest.send("init", 27, {
    onlineKey: "relay-test-guest-key",
    nickname: "測試訪客",
    versionLocal: "1.6.9",
    extension: false
  }, null);
  const hostReceived = await host.next(x => Array.isArray(x) && x[0] === "onmessage");
  assert.equal(hostReceived[1], onconnection[1], "Message must be mapped to original guest wsid");
  return { host, guest, hostReceived, guestWsid: onconnection[1] };
}

test("INCIDENT REPRO: current V2 security HALL relays native guest init as JSON Buffer object", async () => {
  await withRealNginx(CANDIDATE, async browser => {
    const { hostReceived } = await enterWithNativeHandshake(browser);
    const forwarded = hostReceived[2];
    assert.equal(forwarded?.type, "Buffer",
      "Expected current live V2 HALL to corrupt WebSocket text type during JSON forwarding");
    assert.ok(Array.isArray(forwarded.data));
    // Native host lib.init.connection receives message as JS object and JSON.parse fails.
    assert.throws(() => JSON.parse(forwarded), SyntaxError);
    const raw = Buffer.from(forwarded.data).toString("utf8");
    assert.deepEqual(JSON.parse(raw).slice(0, 2), ["init", 27],
      "UTF-8 Buffer contains intact original JSON content, but its shape was lost");
  });
});

test("RELAY FIX: real Nginx + V2 HALL deliver JSON text init verbatim and host can continue", async () => {
  await withRealNginx(RELAY_TEXT_CANDIDATE, async browser => {
    const { host, guest, hostReceived, guestWsid } = await enterWithNativeHandshake(browser);
    const forwarded = hostReceived[2];
    assert.equal(typeof forwarded, "string", "Forwarded native message must stay a JSON text string");
    const nativeInit = JSON.parse(forwarded);
    assert.equal(nativeInit[0], "init");
    assert.equal(nativeInit[1], 27);
    assert.equal(nativeInit[2].nickname, "測試訪客");
    assert.equal(nativeInit[2].onlineKey, "relay-test-guest-key");

    host.send("server", "send", guestWsid, '["init","test-guest-id",{},null,false,null]');
    assert.equal(await guest.next(x => x === '["init","test-guest-id",{},null,false,null]'),
      '["init","test-guest-id",{},null,false,null]');
    assert.equal(host.ws.readyState, WebSocket.OPEN);
    assert.equal(guest.ws.readyState, WebSocket.OPEN);
  });
});

test("RELAY FIX: binary frames retain original Buffer serialization rather than text reinterpretation", async () => {
  await withRealNginx(RELAY_TEXT_CANDIDATE, async browser => {
    const { host, guest } = await enterWithNativeHandshake(browser);
    guest.ws.send(Buffer.from([0, 255, 1, 128]), { binary: true });
    const forwarded = await host.next(x => Array.isArray(x) &&
      x[0] === "onmessage" && x[2]?.type === "Buffer");
    assert.deepEqual([...forwarded[2].data], [0, 255, 1, 128]);
  });
});
