// node --test tools/test-v3-runtime-ticket.cjs
// Offline V3-only mock broker. No real port, VPS or network opened.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const crypto = require("node:crypto");

function mockRoomBroker() {
  let broker;
  const timerCallbacks = new Map();
  let timerId = 0;

  class MockSocket {
    constructor() {
      this._socket = { remoteAddress:"127.0.0.1" };
      this.sent = [];
      this.handlers = Object.create(null);
      this.closed = false;
    }
    on(event, listener) { this.handlers[event] = listener; }
    send(text) { this.sent.push(String(text)); }
    emit(event, payload) { this.handlers[event]?.call(this, payload); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }
    message(...args) { this.emit("message", JSON.stringify(["server", ...args])); }
    last(tag) {
      return this.sent
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(packet => Array.isArray(packet) && packet[0] === tag).at(-1);
    }
  }
  class MockWebSocketServer {
    constructor(options) { this.options = options; broker = this; }
    on(event, listener) {
      if (event === "connection") this.connection = listener;
    }
    connect() {
      const socket = new MockSocket();
      this.connection(socket);
      return socket;
    }
  }

  const source = readFileSync(resolve(__dirname, "../game/v3-playtest-server.cjs"), "utf8");
  const fakeRequire = name => {
    if (name === "ws") return { Server:MockWebSocketServer };
    if (name === "crypto") return crypto;
    throw Error("Unexpected require: " + name);
  };
  const timer = callback => {
    const id = ++timerId;
    timerCallbacks.set(id, callback);
    return id;
  };
  const clearTimer = id => timerCallbacks.delete(id);
  new Function(
    "require","Buffer","setTimeout","clearTimeout",
    "setInterval","clearInterval","process", source
  )(fakeRequire, Buffer, timer, clearTimer, timer, clearTimer, {env:{}});
  return { broker, timerCallbacks };
}

function openMatch() {
  const {broker} = mockRoomBroker();
  const owner = broker.connect();
  owner.message("key", ["ROOM", "test-version"]);
  owner.message("create", "ROOM", "owner", "avatar");
  const tokenMessage = owner.last("v3ownerToken");
  assert.equal(tokenMessage.length, 4);
  assert.match(tokenMessage[2], /^[a-f0-9]{64}$/);
  assert.match(tokenMessage[3], /^[a-f0-9]{64}$/);
  assert.notEqual(tokenMessage[2], tokenMessage[3]);
  owner.message("config", {gameStarted:false,number:4});
  const guest = broker.connect();
  guest.message("key", ["GUEST", "test-version"]);
  guest.message("enter", "ROOM", "guest", "avatar");
  owner.message("config", {gameStarted:true,number:4});
  owner.close();
  assert.ok(guest.last("v3ownerpaused"));
  assert.equal(guest.last("selfclose"), undefined);
  return {
    broker, guest,
    persistedOwnerToken:tokenMessage[2],
    liveRuntimeTicket:tokenMessage[3]
  };
}

test("room pause preserves guests without closing the match", () => {
  const { guest } = openMatch();
  assert.equal(guest.closed, false);
});

test("refresh cannot resume using persisted owner token alone", () => {
  const f = openMatch(), refreshed = f.broker.connect();
  refreshed.message("key", ["ROOM", "test-version"]);
  refreshed.message("v3resume", "ROOM", f.persistedOwnerToken);
  assert.deepEqual(refreshed.last("v3resumerejected"),
    ["v3resumerejected","missing_live_runtime"]);
  assert.equal(f.guest.last("v3ownerresumed"), undefined);
});

test("impostor with wrong heap credential cannot resume", () => {
  const f = openMatch(), attacker = f.broker.connect();
  attacker.message("key", ["ROOM", "test-version"]);
  attacker.message("v3resume", "ROOM", f.persistedOwnerToken, "f".repeat(64));
  assert.equal(attacker.last("v3resumerejected")[1], "missing_live_runtime");
  assert.equal(f.guest.last("v3ownerresumed"), undefined);
});

test("original tab rejoins only with both credentials and rotates both", () => {
  const f = openMatch(), restored = f.broker.connect();
  restored.message("key", ["ROOM", "test-version"]);
  restored.message("v3resume", "ROOM", f.persistedOwnerToken, f.liveRuntimeTicket);
  const rotated = restored.last("v3ownerresumedHost");
  assert.equal(rotated.length, 4);
  assert.notEqual(rotated[2], f.persistedOwnerToken);
  assert.notEqual(rotated[3], f.liveRuntimeTicket);
  assert.equal(f.guest.last("v3ownerresumed"), undefined);
  restored.message("v3ready", "ROOM", f.liveRuntimeTicket);
  assert.equal(f.guest.last("v3ownerresumed"), undefined);
  restored.message("v3ready", "ROOM", rotated[3]);
  assert.ok(f.guest.last("v3ownerresumed"));
});

test("refreshed owner can inspect paused room but cannot unpause it", () => {
  const f = openMatch(), refreshed = f.broker.connect();
  refreshed.message("key", ["ROOM", "test-version"]);
  refreshed.message("v3restoreprobe", "ROOM", f.persistedOwnerToken);
  assert.equal(refreshed.last("v3restoreprobe")[1].state, "paused_owner_missing");
  refreshed.message("v3ready", "ROOM", f.liveRuntimeTicket);
  assert.equal(f.guest.last("v3ownerresumed"), undefined);
});
