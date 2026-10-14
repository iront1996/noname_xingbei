#!/usr/bin/env node
/**
 * Offline HALL lifecycle regression against checkout game/server.js or supplied
 * server.js. The WebSocket server, all sockets, imports and timers are fake.
 * No bind, no network, no service restart.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const sourcePath = process.argv[2] || path.resolve(__dirname, '../game/server.js');
const clientSourcePath = path.resolve(__dirname, '../noname/library/index.js');
function actualV2SelfcloseHandler(ws) {
  const clientSource = fs.readFileSync(clientSourcePath, 'utf8');
  const m = /selfclose:\s*function\s*\(\)\s*\{/.exec(clientSource);
  assert.ok(m, 'V2 selfclose function missing');
  const fnStart = m.index + m[0].indexOf('function');
  const brace = clientSource.indexOf('{', fnStart);
  let depth = 0, end = -1;
  for (let i = brace; i < clientSource.length; i++) {
    if (clientSource[i] === '{') depth++;
    if (clientSource[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > brace, 'unbalanced V2 selfclose method');
  const fn = vm.runInNewContext('(' + clientSource.slice(fnStart, end) + ')', {
    game: { online: true, onlineroom: true, servermode: false, onlinehall: true,
      saveConfig: () => {}, ws },
    _status: { over: false },
  }, { timeout: 1000 });
  fn();
}
const source = fs.readFileSync(sourcePath, 'utf8');
const hash = crypto.createHash('sha256').update(source).digest('hex');

function environment() {
  const timers = new Map();
  let ticket = 0;
  const timer = (fn, delay, kind) => {
    const id = ++ticket;
    timers.set(id, { fn, delay, kind });
    return id;
  };
  let server;
  class FakeServer extends EventEmitter {
    constructor(options) { super(); this.options = options; server = this; }
  }
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this._socket = { remoteAddress: '127.0.0.1' };
      this.readyState = 1;
      this.sent = [];
      this.closeCount = 0;
      this.terminateCount = 0;
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('send on nonopen socket');
      this.sent.push(String(data));
    }
    close() {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.closeCount++;
      this.emit('close', 1005);
    }
    terminate() {
      if (this.readyState !== 1) return;
      this.readyState = 3; this.terminateCount++;
      this.emit('close', 1006);
    }
    receive(message) { this.emit('message', message); }
    commands() {
      return this.sent.map(s => { try { return JSON.parse(s); } catch { return [s]; } });
    }
    count(type) { return this.commands().filter(x => x[0] === type).length; }
  }
  let seq = 0;
  const fakeMath = Object.create(Math);
  fakeMath.random = () => (++seq) / 10000;
  const addon = new Proxy({}, { get: (_, prop) => {
    if (prop === 'attachSocketHealth') return () => timer(() => {}, 30000, 'health-placeholder');
    return () => {};
  }});
  const mockRequire = spec => {
    if (spec === 'ws') return { Server: FakeServer, WebSocketServer: FakeServer };
    if (/xingbei-(?:connection-health|monitor-bridge)\.js$/.test(spec)) return addon;
    throw new Error('unsupported require in isolated HALL VM: ' + spec);
  };
  const module = { exports: {} };
  const context = {
    require: mockRequire,
    module, exports: module.exports, Buffer, Date, Math: fakeMath,
    setTimeout: (fn, delay) => timer(fn, delay, 'timeout'),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, 'interval'),
    clearInterval: id => timers.delete(id),
    console: { log() {}, error() {}, warn() {} },
    process: { env: {} },
  };
  vm.runInNewContext(source, context, { filename: path.basename(sourcePath), timeout: 1500 });
  assert.ok(server, 'HALL failed to construct a WebSocketServer');
  function connect(key) {
    const s = new FakeSocket();
    server.emit('connection', s);
    assert.equal(typeof s.wsid, 'string', 'HALL should assign socket wsid');
    s.receive(JSON.stringify(['server','key',[key]]));
    return s;
  }
  function command(s, type, ...args) { s.receive(JSON.stringify(['server',type,...args])); }
  function room() {
    const owner = connect('room-owner-key');
    command(owner, 'create', 'room-owner-key', 'owner', 'avatar', {gameStarted:false}, 'connect');
    assert.equal(owner.count('createroom'), 1, 'room not created');
    command(owner, 'config', { gameStarted: false, observe: true, observeReady: true });
    const guest = connect('guest-key');
    command(guest, 'enter', 'room-owner-key', 'guest', 'avatar');
    assert.equal(owner.count('onconnection'), 1, 'guest not attached to owner');
    return { owner, guest };
  }
  return { connect, command, room, timers };
}
const results = [];
function test(name, fn) {
  try { results.push({ name, status:'PASS', ...fn() }); }
  catch(err) { results.push({ name, status:'FAIL', error:err.message }); }
}
test('guest_close_does_not_broadcast_selfclose', () => {
  const e=environment(), {owner,guest}=e.room();
  guest.close();
  assert.equal(owner.count('onclose'),1);
  assert.equal(owner.count('selfclose'),0);
  return { finding:'guest close only alerts the room owner' };
});
test('owner_close_cascades_selfclose_to_guest', () => {
  const e=environment(), {owner,guest}=e.room();
  owner.close();
  assert.equal(guest.count('selfclose'),1,'no room-wide selfclose');
  return { owner_closed:true, guest_selfclose_received:1, finding:'CONFIRMED_LEGACY_ROOM_CASCADE' };
});
test('owner_heartbeat_terminate_triggers_same_room_cascade', () => {
  const e=environment(), {owner,guest}=e.room();
  owner.terminate();
  assert.equal(guest.count('selfclose'),1);
  return { owner_transport_abort:true, guest_selfclose_received:1, finding:'OWNER_SOCKET_LIFETIME_COUPLED_TO_ROOM' };
});
test('guest_socket_close_code_without_status_is_1005', () => {
  const e=environment(), {owner,guest}=e.room();
  let closeCode = null;
  guest.on('close', c => {closeCode=c});
  owner.close();
  assert.equal(guest.count('selfclose'), 1);
  // Execute the exact V2 lib.message.client.selfclose handler from the checkout.
  actualV2SelfcloseHandler(guest);
  assert.equal(closeCode,1005);
  return { actual_v2_selfclose_handler_executed:true, observed_close_code:closeCode };
});
test('owner_close_is_idempotent_under_normal_ws_close', () => {
  const e=environment(), {owner,guest}=e.room();
  owner.close(); owner.close();
  assert.equal(guest.count('selfclose'),1);
  return { selfclose_count:guest.count('selfclose') };
});
test('independent_guest_disconnect_does_not_terminate_other_guest', () => {
  const e=environment(), {owner,guest}=e.room();
  const another=e.connect('guest2-key');
  e.command(another,'enter','room-owner-key','guest2','avatar');
  guest.close();
  assert.equal(another.count('selfclose'),0);
  assert.equal(another.readyState,1);
  assert.equal(owner.readyState,1);
  return { other_guest_healthy:true, owner_healthy:true };
});
test('reconnected_guest_old_socket_close_does_not_directly_close_new_guest', () => {
  const e=environment(), {owner,guest}=e.room();
  const replacement=e.connect('guest-key');
  e.command(replacement,'enter','room-owner-key','guest','avatar');
  guest.close();
  assert.equal(replacement.readyState,1);
  assert.equal(replacement.count('selfclose'),0);
  return {different_socket_ids:guest.wsid!==replacement.wsid, replacement_open:true,
    limit:'does not verify authenticated seat takeover, which legacy HALL lacks'};
});
const summary = {
  audit:'legacy HALL actual-source isolated VM; fake WebSocketServer and socket events',
  source:path.basename(sourcePath), sha256:hash,
  live_server_touched:false, findings:results,
  limitations:['Deployed HALL may differ from GitHub game/server.js.',
    'Simulated A1 terminate and V2 selfclose close(); deployed A1 source separately verified.',
    'Monitor hooks and socket handler integrations not covered by this isolated harness.']
};
console.log(JSON.stringify(summary,null,2));
if(results.some(x=>x.status==='FAIL')) process.exitCode=1;
