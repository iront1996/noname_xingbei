# V2 server-authority plan and evidence

## Non-negotiable architecture boundary

HALL owns room lifecycle, credentials and routing. During M1 the existing human browser may still own game execution, so a disconnected host produces an explicit paused state rather than a false claim of continued gameplay. M2 is required before host-independent game progression can be claimed.

## M1 — server-owned room lifecycle

Status: batch 1 implemented; Linux CI passed; PR review pending.

Lifecycle states:

1. `active`: HALL holds the room record and routes guests to the current human host.
2. `awaiting_host`: the host transport closed; guests remain associated but are unrouted and receive `roompaused`.
3. `waiting_host_process`: an authenticated owner reclaimed the room, but HALL waits for host reconfiguration before routing guests.
4. `expired`: the grace deadline elapsed; HALL removes the room and sends `selfclose` with `room_expired` to remaining guests.

Security decisions:

- Owner reclaim requires both the original `onlineKey` binding and a 256-bit server-generated resume secret.
- Resume secrets are compared with a timing-safe equality check and rotated after successful use.
- Public room identifiers alone cannot reclaim ownership.
- Guest routing is removed while the room is paused, so stale owner sockets cannot continue receiving packets.
- Duplicate room keys fail closed.
- Legacy server-mode workers cannot claim a paused managed room.

Batch 1 implementation:

- `game/server-room-lifecycle.js`: deterministic lifecycle/state/expiry component with injectable clock and token source.
- `game/server.js`: create, pause, owner reclaim, activation, guest rerouting and periodic cleanup integration.
- `tests/v2-server-room-lifecycle.mjs`: simulated WebSocket coverage for normal flow, guest disconnect, host disconnect, authenticated host reclaim, token rotation and expiry cleanup, plus real-source integration anchors.
- CI now runs the M1 test on pull requests targeting the V2 base.

Known M1 limitations and next batches:

- The browser client does not yet persist and submit the new owner resume credential; batch 1 proves the HALL contract with simulated sockets only.
- Room and token state are memory-only; process restart recovery belongs to M4.
- The host still executes the engine. `waiting_host_process` prevents this batch from claiming gameplay continued during host absence.
- Add client credential storage/reclaim negotiation, explicit protocol version handling, rate limiting/audit telemetry, and a real HALL WebSocket process test before declaring M1 complete.
- Verify compatibility against the exact redacted VPS HALL source offline before any deployment request.

### M1 browser owner recovery and real-process test

- The browser stores protocol-v1 owner credentials in tab-scoped session storage and resubmits them only from the same live page that originally received the credential. A hard reload does not possess the in-memory readiness marker and therefore cannot pretend the human-host engine survived.
- Owner recovery sends the normal HALL key binding first, then `resumeowner` with explicit protocol version 1. The HALL rejects unsupported versions before token processing.
- A valid reclaim rotates the secret, leaves the room in `waiting_host_process`, and requires the surviving browser host to resend its configuration before guest routing resumes.
- A spawned-process integration test starts the actual `game/server.js` on an isolated loopback port and uses real `ws` clients to verify create, guest join, owner pause, paused-room admission rejection, protocol rejection, authenticated owner resume, token rotation and guest rerouting.

### M1 client state-transition correction

- The actual `createroom` handler intentionally changes a human host from `online=true` to `online=false, onlineroom=true`. Owner recovery therefore keys off either live online state, not guest-only `game.online`.
- Actual handler execution tests run `createroom` followed by the real WebSocket `onclose` body and prove the owner recovery entry point is reached.
- Guest `roompaused` accepts only bounded deadlines and known states for an online, non-owner HALL client; it clears stale choice/progress identifiers. `roomresumed` requires protocol 1 plus the current room ID before reopening the guest lifecycle state.

### M1 and B2 same-process integration

- Linux CI generates a HALL server from the current `game/server.js` through the production B2 patcher, then starts that generated server on an isolated loopback port with real WebSocket clients.
- The integration verifies that an authenticated guest seat cannot be reclaimed while the room is paused, survives owner recovery, is rebound to the replacement owner, and resumes bidirectional game-message routing.
- Repeated valid takeovers retain one stable seat identity, terminate the superseded transport, route only the newest socket, and reject an invalid credential without disturbing the live seat.
- This is equivalent server-process integration evidence, not real-browser acceptance. M1 remains incomplete until the browser client and engine path are exercised end to end.

### M1 review hardening

- Paused rooms now reject fresh `enter` attempts with `room_paused` before assigning any room or owner reference. Existing associated guests remain attached and can wait for recovery.
- Closing a legacy server-mode host releases every attached guest, sends `selfclose` with `server_host_closed`, and clears both `room` and `owner` references. Unrelated rooms and the already-closing host are not mutated.
- Expiry cleanup and server-mode shutdown share the same tested reference-release helper.

## M2 — managed server host process

Status: not started.

Research the existing engine and V3 hosting approach read-only. Build a supervised, isolated Chromium/game-host process per room (or a justified bounded pool), with startup handshake, resource limits, routing identity, crash/timeout handling and cleanup. Reuse the existing Xingbei engine rather than reimplementing rules. Required tests cover launch failure, process isolation, message routing, resource ceilings, exit and orphan cleanup.

## M3 — uniform player recovery

Status: not started; blocked on M2.

Treat the creator as an ordinary authenticated seat. Extend the V2-1 through V2-9 credential/replay protections to every seat, reject public-ID takeover, fence stale sockets and duplicate packets, and retain all prior security regressions.

## M4 — persistence and host recovery

Status: not started; blocked on M2/M3.

Persist lifecycle, authenticated seat bindings, confirmed engine checkpoints and replay identifiers. Prove behavior under host crash, process restart, duplicate submission, event replay, inconsistent checkpoints and unrecoverable state. A restarted process alone is not recovery evidence.

## Evidence ledger

- Base GitHub CI: run 38301778625 succeeded at `2baf366`.
- M1 plus locally portable V2 regressions: 58/58 Node tests passed; the standalone B2 seat-registry suite also passed.
- PR Linux CI: run 38304099421 `node-recovery-tests` succeeded for M1 implementation plus generated-HALL harness compatibility commits.
- Review-hardening Linux CI: run 38304735974 succeeded for paused admission and server-mode cleanup.
- Current local M1 continuation: 66/66 portable Node tests plus the standalone seat-registry suite passed, including a spawned real HALL process with real loopback WebSockets.
- Owner-recovery Linux CI: run 38305127613 succeeded, including the isolated `ws@8.18.3` real-process test dependency and the actual HALL entry point.
- Syntax checks: `game/server.js` and `game/server-room-lifecycle.js` passed `node --check`.
- Production/VPS compatibility: not verified.
- Real browser/player acceptance: not verified.
- Deployment or live service changes: none.
