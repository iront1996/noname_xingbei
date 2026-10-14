#!/usr/bin/env node
/**
 * Offline, read-only A1 heartbeat lifecycle audit.
 *
 * Run on the VPS against the deployed module:
 *   node tests/v2-a1-heartbeat-lifecycle.cjs /opt/xingbei-hall/xingbei-connection-health.js
 *
 * Loads ONLY the standalone A1 module inside a restricted VM, never server.js.
 * No real sockets, timers, service restarts, or game messages.
 */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');

const sourcePath = process.argv[2] || '/opt/xingbei-hall/xingbei-connection-health.js';
if (!fs.existsSync(sourcePath)) {
  console.error('ERROR: deployed A1 module not found. Supply its file path.');
  process.exit(2);
}
const source = fs.readFileSync(sourcePath, 'utf8');
const sha256 = crypto.createHash('sha256').update(source).digest('hex');

function makeClock() {
  let now = 1000000;
  let id = 0;
  const jobs = new Map(), archived = new Map();
  const start = (fn, delay, repeat) => {
    if (!Number.isFinite(delay) || delay < 1 || typeof fn !== 'function') throw Error('bad fake timer');
    const ticket = { id: ++id, unref() { return this; }, ref() { return this; }, hasRef() { return true; } };
    const job = { fn, delay, due: now + delay, repeat };
    jobs.set(ticket, job);
    archived.set(ticket, fn);
    return ticket;
  };
  return {
    now: () => now,
    setInterval: (fn, delay) => start(fn, delay, true),
    setTimeout: (fn, delay) => start(fn, delay, false),
    clear: ticket => jobs.delete(ticket),
    active: () => jobs.size,
    allCallbacks: () => [...archived.values()],
    advance(ms) {
      const end = now + ms;
      for (let safety = 0; safety < 5000; safety++) {
        let earliest = null, key = null;
        for (const [k, j] of jobs) {
          if (j.due <= end && (!earliest || j.due < earliest.due)) {
            earliest = j; key = k;
          }
        }
        if (!earliest) { now = end; return; }
        now = earliest.due;
        if (earliest.repeat) earliest.due += earliest.delay;
        else jobs.delete(key);
        earliest.fn();
      }
      throw Error('fake-clock runaway');
    },
  };
}
function makeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1; ws.readyState = 1;
  ws.sent = []; ws.pings = 0; ws.terminations = 0; ws.closes = 0;
  ws.send = data => {
    if (ws.readyState !== 1) throw Error('send to closed mock socket');
    ws.sent.push(String(data));
  };
  ws.ping = () => {
    if (ws.readyState !== 1) throw Error('ping to closed mock socket');
    ws.pings++;
  };
  ws.terminate = () => { ws.terminations++; ws.readyState = 3; ws.emit('close', 1006); };
  ws.close = () => { ws.closes++; ws.readyState = 3; ws.emit('close', 1005); };
  return ws;
}
function scene() {
  const clock = makeClock();
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    setInterval: clock.setInterval, clearInterval: clock.clear,
    setTimeout: clock.setTimeout, clearTimeout: clock.clear,
    require: () => { throw Error('Module imports are not allowed in offline audit'); },
  };
  vm.runInNewContext(source, sandbox, { filename: path.basename(sourcePath), timeout: 1000 });
  const attach = module.exports.attachSocketHealth;
  assert.equal(typeof attach, 'function', 'deployed A1 module must export attachSocketHealth');
  const marks = [];
  const connect = ws => {
    attach(ws, { intervalMs: 100, timeoutMs: 150, now: clock.now,
      mark: (name, fields) => marks.push({ name: String(name), fields: fields || {} }) });
    return ws;
  };
  return { clock, connect, marks };
}
const findings = [];
function run(name, fn) {
  try { findings.push({ scenario: name, status: 'PASS', ...fn() }); }
  catch (err) { findings.push({ scenario: name, status: 'FAIL', error: String(err && err.message || err) }); }
}
run('healthy_text_ack_keeps_socket_alive', () => {
  const s = scene(), ws = s.connect(makeSocket());
  for (let i = 0; i < 8; i++) {
    s.clock.advance(100);
    ws.emit('message', 'heartbeat');
    ws.emit('pong');
  }
  assert.equal(ws.terminations, 0);
  assert.ok(ws.sent.filter(x => x === 'heartbeat').length >= 5);
  return { result: 'healthy text replies protect socket' };
});
run('pong_only_fresh_but_text_ack_missing', () => {
  const s = scene(), ws = s.connect(makeSocket());
  s.clock.advance(100);
  ws.emit('pong');
  s.clock.advance(100);
  ws.emit('pong');
  s.clock.advance(100);
  return {
    terminated_despite_fresh_pong: ws.terminations > 0,
    sent_text_probes: ws.sent.filter(x => x === 'heartbeat').length,
    pong_received_before_timeout: true,
    conclusion: ws.terminations > 0 ? 'CONFIRMED_RISK' : 'NOT_REPRODUCED',
  };
});
run('both_transport_and_app_unresponsive', () => {
  const s = scene(), ws = s.connect(makeSocket());
  s.clock.advance(500);
  assert.ok(ws.terminations + ws.closes > 0, 'unresponsive socket was not closed');
  return { result: 'timeout closes an unresponsive socket' };
});
run('closed_socket_cancels_its_watchdog', () => {
  const s = scene(), ws = s.connect(makeSocket());
  s.clock.advance(100);
  const prior = ws.sent.length;
  ws.readyState = 3;
  ws.emit('close', 1005);
  const activeAfterClose = s.clock.active();
  s.clock.advance(600);
  assert.equal(ws.sent.length, prior, 'closed socket received another probe');
  assert.equal(ws.terminations, 0, 'closed socket was subsequently terminated');
  assert.equal(activeAfterClose, 0, 'timer survived close');
  return { active_timers_after_close: activeAfterClose };
});
run('old_socket_timeout_does_not_terminate_new_socket', () => {
  const s = scene(), oldWs = s.connect(makeSocket());
  s.clock.advance(100);
  const newWs = s.connect(makeSocket());
  for (let i = 0; i < 4; i++) {
    s.clock.advance(100);
    newWs.emit('message', 'heartbeat');
    newWs.emit('pong');
  }
  assert.ok(oldWs.terminations + oldWs.closes > 0, 'old socket did not age out');
  assert.equal(newWs.terminations + newWs.closes, 0, 'old timeout killed replacement socket directly');
  return {
    old_closed: true, new_healthy: true,
    limit: 'Only A1 socket isolation tested; room-owner/clients[] integration NOT tested',
  };
});
run('late_cancelled_timer_cannot_kill_new_socket', () => {
  const s = scene(), oldWs = s.connect(makeSocket());
  const savedOldCallbacks = s.clock.allCallbacks();
  oldWs.readyState = 3;
  oldWs.emit('close', 1005);
  const newWs = s.connect(makeSocket());
  for (const fn of savedOldCallbacks) fn();
  assert.equal(newWs.terminations + newWs.closes, 0);
  return { new_healthy: true, limit: 'Simulated stale timer only' };
});

console.log(JSON.stringify({
  audit: 'A1 deployed heartbeat module / isolated VM / fake sockets / fake timers',
  module_sha256: sha256,
  executed_live_service_operations: false,
  scenarios: findings,
  note: 'Pong-only is a diagnostic observation. This does not establish October 14 physical root cause or HALL room rebind safety.',
}, null, 2));
if (findings.some(x => x.status === 'FAIL')) process.exitCode = 1;
