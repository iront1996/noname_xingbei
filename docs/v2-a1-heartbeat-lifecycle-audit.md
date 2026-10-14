# V2 A1 heartbeat / stale-socket lifecycle audit (isolated)

**Scope:** This branch adds a test file only. It does not alter V1, V2 or V3 game code, production WebSocket endpoints, VPS services, monitor databases, or heartbeat policy.

## Why

The 2026-10-14 22:00–24:00 Asia/Taipei historical shared-HALL telemetry contains 15 heartbeat timeout close-intents. The bridge ticked approximately every 10 seconds; that argues against a sustained global Node event-loop stall, but does **not** establish whether an individual browser application thread, WebSocket transport, or A1 state machine was responsible.

The deployed A1 source lives at /opt/xingbei-hall/xingbei-connection-health.js on the VPS; it is **not** included in this development branch. A passing mock/reference-fixture test is NOT a deployed-source result.

## Offline execution against the deployed A1 source

Copy tests/v2-a1-heartbeat-lifecycle.cjs to the VPS as /tmp/v2-a1-heartbeat-lifecycle.cjs, then run:

    node /tmp/v2-a1-heartbeat-lifecycle.cjs /opt/xingbei-hall/xingbei-connection-health.js > /tmp/REPORT_A1_LIFECYCLE.txt

The Node script reads the module, evaluates its text inside an isolated VM with fake timers and fake EventEmitter WebSockets, and prints only test results and a source SHA-256. It **never loads server.js**, opens sockets, accesses credentials, writes a database, or restarts services. No real time elapses for simulated 30/45-second probes. Inspect the report before sharing.

Tests:
1. Application heartbeat replies keep a socket alive.
2. Fresh Pong without app heartbeat reply: report whether A1 terminates anyway (diagnostic risk; not automatically a test failure).
3. No Pong and no app reply: the unresponsive socket must time out.
4. Closing the socket must cancel its interval; no delayed termination.
5. A stale socket may time out while a distinct healthy socket stays alive.
6. A queued callback from a cancelled stale timer must not close the replacement socket.

## Validation boundaries

- The fake WebSocket is not a browser and does not reproduce actual Chrome freezing or Cloudflare transport behavior.
- A1-only tests cannot establish correct room-owner identity, clients[] rebind behavior, or whether a close cascade is caused by a HALL room lifecycle handler. Those require a second isolated integration suite against the deployed HALL server.js, also with no live port binding.
- This audit does not prove physical transport state on October 14: historical Pong and connection_id timestamps were not retained.
- Do not change A1 timeouts or V2 production based solely on this audit. First reproduce, write a targeted fix on an isolated branch, and gate deployment on HALL owner/guest integration plus Chromium tests.

## Local harness validation

The harness was exercised against a locally constructed **reference-model fixture** corresponding to the incident report's A1 API/behavior: 6/6 scenarios passed. A deliberate broken-timer-cleanup fixture made the relevant cancellation test fail, demonstrating detection sensitivity. Neither fixture should be confused with the deployed A1 source.
