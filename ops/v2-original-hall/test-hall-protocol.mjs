import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import WebSocket, { WebSocketServer } from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(resolve(root, "game/server.js"), "utf8");
const originalListener = 'var wss = new WebSocketServer({ port: 8080 });';
assert.equal(source.split(originalListener).length - 1, 1, "pinned original listener must appear once");

// Execute the authentic HALL source in a sandbox with only its listener port
// redirected to an ephemeral loopback TCP port. No modifications to game logic.
function createHall() {
  let server;
  let nextIntervalId = 1;
  const intervalCallbacks = new Map();
  class CapturedServer extends WebSocketServer {
    constructor(options) {
      super(options);
      server = this;
    }
  }
  const harness = {
    require(id) {
      assert.equal(id, "ws");
      return { Server: CapturedServer };
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      assert.equal(ms, 60000, "original heartbeat interval must be 60 s");
      const id = nextIntervalId++;
      intervalCallbacks.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervalCallbacks.delete(id);
    }
  };
  const executable = source.replace(originalListener,
    'var wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });');
  vm.runInNewContext(executable, harness, { filename: "original-game-server.js" });
  assert.ok(server instanceof WebSocketServer);
  return { server, intervalCallbacks };
}

function client(url) {
  const ws = new WebSocket(url, { handshakeTimeout: 3000 });
  const received = [];
  const pending = [];
  ws.on("message", data => {
    const text = data.toString();
    let message = text;
    try { message = JSON.parse(text); } catch {}
    received.push(message);
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i];
      if (item.predicate(message)) {
        clearTimeout(item.timer);
        pending.splice(i, 1);
        item.resolve(message);
      }
    }
  });
  ws.on("error", () => {}); // tests assert their own open/message deadlines
  return {
    ws,
    async open() {
      if (ws.readyState === WebSocket.OPEN) return;
      await Promise.race([
        once(ws, "open"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket open timeout")), 3500))
      ]);
    },
    send(...args) {
      ws.send(JSON.stringify(args));
    },
    next(predicate, ms = 3000) {
      const match = received.find(predicate);
      if (match !== undefined) return Promise.resolve(match);
      return new Promise((resolve, reject) => {
        const item = { predicate, resolve, timer: null };
        item.timer = setTimeout(() => {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error("Timeout waiting for original HALL message"));
        }, ms);
        pending.push(item);
      });
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) ws.terminate();
    }
  };
}

const eventType = type => m => Array.isArray(m) && m[0] === type;
const textMessage = text => m => m === text;

test("original HALL: roomlist/key, room creation, room joining, host-to-guest relay, and literal heartbeat", async () => {
  const { server, intervalCallbacks } = createHall();
  await once(server, "listening");
  const url = "ws://127.0.0.1:" + server.address().port;
  const owner = client(url);
  let guest;
  try {
    await owner.open();
    const roomlist = await owner.next(eventType("roomlist"));
    assert.ok(Array.isArray(roomlist[1]), "original roomlist must contain array");
    assert.equal(typeof roomlist[4], "string", "wsid must be transmitted");
    owner.send("server", "key", ["test-owner-key"]);
    owner.send("server", "create", "test-owner-key", "owner", "avatar", {}, "xingBei");
    const created = await owner.next(eventType("createroom"));
    assert.equal(created[1], "test-owner-key");
    owner.send("server", "config", { observe: true, observeReady: true, gameStarted: false });

    guest = client(url);
    await guest.open();
    const guestInitial = await guest.next(eventType("roomlist"));
    assert.equal(typeof guestInitial[4], "string");
    guest.send("server", "key", ["test-guest-key"]);
    const connected = owner.next(eventType("onconnection"));
    guest.send("server", "enter", "test-owner-key", "guest", "avatar");
    const join = await connected;
    const guestWsid = join[1];
    assert.equal(typeof guestWsid, "string");

    owner.send("server", "send", guestWsid, "original-native-transport-message");
    assert.equal(await guest.next(textMessage("original-native-transport-message")),
      "original-native-transport-message");

    assert.equal(intervalCallbacks.size, 2, "owner and guest must each have original heartbeat interval");
    for (const callback of [...intervalCallbacks.values()]) callback();
    await owner.next(textMessage("heartbeat"));
    await guest.next(textMessage("heartbeat"));
    owner.ws.send("heartbeat");
    guest.ws.send("heartbeat");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(owner.ws.readyState, WebSocket.OPEN);
    assert.equal(guest.ws.readyState, WebSocket.OPEN);
  } finally {
    guest?.close();
    owner.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test("original HALL: malformed client key is rejected, without introducing A1 protocol", async () => {
  const { server } = createHall();
  await once(server, "listening");
  const user = client("ws://127.0.0.1:" + server.address().port);
  try {
    await user.open();
    await user.next(eventType("roomlist"));
    user.send("server", "key", null);
    const denied = await user.next(eventType("denied"));
    assert.equal(denied[1], "key");
  } finally {
    user.close();
    await new Promise(resolve => server.close(resolve));
  }
});
