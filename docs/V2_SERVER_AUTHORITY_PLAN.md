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
- Syntax checks: `game/server.js` and `game/server-room-lifecycle.js` passed `node --check`.
- Production/VPS compatibility: not verified.
- Real browser/player acceptance: not verified.
- Deployment or live service changes: none.
