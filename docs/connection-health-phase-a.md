# Connection health – phase A1

Development branch: `feature/connection-health-recovery` (forked from `feature/host-reconnect-v3-playtest`).

## Implemented in this branch

- `noname/util/xingbei-connection-health.js`: browser inbound-silence watchdog (85-second initial threshold); detects half-open WebSocket connections even if `onclose` never arrives.
- `noname/game/index.js`: socket-scoped message and close hooks; stale socket closes, then invokes the original single-shot recovery path if the close handshake does not finish. Does **not** yet implement seamless reconnect or game restoration.

## Backend

A companion, independently deployable HALL+V3 backend upgrade (`xingbei-connection-health.js`) is staged in the phase-A delivery package. It retains legacy application heartbeat messages, adds Ping/Pong and bounded timeout detection, and respects the v2.3 monitoring callbacks.

## Boundary

Transport health does not prove that asynchronous gameplay events advanced. Phase B must implement session-safe automatic reconnect, host/authoritative snapshot synchronization, and timeout/AI action fencing. The production monitor remains unchanged. Do not merge to production until paired backend/client deployment and tests pass.


## Phase B1 – isolated client recovery primitives

- `noname/util/xingbei-connection-recovery.js` implements a retry state machine with connect and sync timeouts, bounded retries, distinct transport and gameplay states, and protection from stale attempt callbacks.
- `tests/connection-recovery.mjs` covers successful reinit, rejected/lobby responses, automatic retry, obsolete callbacks, and finite exhaustion.
- `noname/library/element/client.js` no longer marks a player offline or triggers an AI choice when a **superseded** connection closes after the player seat has already been rebound to a newer socket.

**IMPORTANT: The recovery state machine is intentionally not yet wired into the production WebSocket close handler.** The existing HALL backend sends an initial `roomlist` on each connection and can refuse `enter` after a room starts; treating a new TCP/WebSocket connection as a rejoined game is unsafe. The next batch must introduce authenticated seat reclamation and bypass/descope destructive lobby initialization during in-game rejoin. The host and independent V3 runtime paths also need separate validation.

Do not deploy B1 directly to production. A1 backend remains deployed. Monitor v2.3.0 is unchanged.


## Phase B3 – guest browser reconnect integration (development only)

- `noname/util/xingbei-seat-credentials.js` persists room-bound 256-bit guest secrets in tab-local sessionStorage, keyed by server endpoint. Network packets, logs and telemetry must not contain these secrets except the direct broker reclaim request.
- `noname/util/xingbei-recovery-protocol.js` intercepts the first `roomlist` during recovery so it cannot clear the previous game screen; sends `server.key` then `server.xbResumeSeat` in-order; handles `xbSeatReclaimed` / `xbSeatResumeRejected`.
- `noname/game/index.js` invokes the B1 retry manager for credentialed guests, displays user-facing reconnect/sync states and ignores late `onopen` / `onerror` messages from superseded sockets.
- `noname/library/index.js` distinguishes transport reconnection from host-driven `reinit`. Async snapshot completion is bound to its WebSocket identity. It blocks arbitrary public player-ID rebinds unless the broker's socket ID matches and evicts the old host-side client after a real takeover.
- `tests/connection-recovery-b3.mjs` tests credential scoping, rejection, first `roomlist` suppression, duplicate claim prevention and the gameplay sync gate.

Verified locally against HALL/V3 *redacted reference* backend adapters: valid guest credential can reclaim its existing broker seat, and a bare WebSocket Upgrade / roomlist is never considered gameplay recovery. This is a simulator, not VPS validation.

### Not ready to deploy
- The latest V3 independent Chromium-host architecture is NOT confirmed compatible with B2's legacy room relay.
- The host's asynchronous `reinit` confirms client snapshot application but does not yet verify gameplay-event sequence / reaction-choice correctness.
- Owner reconnect is not supported by this guest-only credential flow.
- The game-engine AI/choose timeout (`player.wait`) must still be fenced from concurrently expiring during reconnect; this is the next C-phase task.
- The backend B2 code must be deployed together with B3 client changes **only after** preflight/testing. Publishing the client first would fall back to legacy reload because no credential has been issued.

A1 VPS heartbeat remains the only deployed part; this branch is not production.


## Phase C1 – AI choice timeout / reconnect race fencing (development only)

- `noname/util/xingbei-choice-lease.js` gives each host-side pending choice a unique generation and deadline, so an old timer callback cannot resolve a superseding action.
- `noname/library/element/player.js` validates the exact pending generation before invoking `unwait("ai")`. If the socket was replaced during the same deadline, it never closes the replacement; a valid choice is settled at most once. A synchronous callback starting another wait no longer has its marker overwritten.
- `noname/library/element/client.js` defers disconnect-triggered AI fallback while an existing choice timer is alive, without resetting that deadline.
- `noname/library/index.js` accepts `result` and `tempResult` only from the current initialized host-side client bound to that seat (not an old or reinitializing socket).
- `tests/connection-recovery-c1.mjs` extracts the *actual* `Player.wait/unwait` methods and runs them under a fake clock/timer and minimal game host; covers superseded callbacks, duplicate results, replaced sockets, unchanged-socket AI timeout, and a reentrant choice callback.

**Limits:** C1 prevents stale-socket actions and stale *host timers*. The existing legacy client wire protocol does not yet send a per-choice `actionId`; delayed results from the **same** still-current socket after a new choice starts remain indistinguishable. C2 must add opt-in request/response action IDs with backward compatibility and explicit acknowledgements. Game-state/event-sequence verification is still pending. C1 does not solve a JavaScript main-thread freeze.

**Deployment:** A1 heartbeat is on VPS. B1/B2/B3/C1 are GitHub experiment branch only, not deployed. Do not merge or deploy before paired frontend/backend tests and real V3 Chromium host verification. Monitor v2.3.0 remains unchanged.


## Phase C2 – host choice operation-ID fencing (development only)

- `noname/util/xingbei-choice-lease.js`: every pending choice has a monotonic per-host `wireId` (`c2:<base36 sequence>`). This ID is a *correlation identifier*, **not** an authentication token; seat ownership remains enforced by the broker and the host-side socket identity check.
- `noname/library/element/player.js`: an opted-in seat receives `xbChoiceLease(wireId)` **before** its choice instruction. After settlement or AI timeout, `xbChoiceSettled(wireId)` invalidates that ID without clearing a subsequent ticket.
- `noname/library/index.js`: clients advertise `xbChoiceHello(1)` only after `inited` or `reinited`, so the host can require a matching ID for both `result(result,wireId)` and `tempResult(result,wireId)`. Strict mode persists for the host player seat after reconnect: an older client cannot silently downgrade it. A current pending ticket is resent after a valid seat takeover.
- `noname/library/init/index.js`: the actual `startOnline()` result-sending path snapshots and consumes the current ID; `noname/game/index.js` attaches it to compatible secondary result senders. Ticket state is cleared when a socket closes.
- `tests/connection-recovery-c2.mjs`: executes the actual `Player.wait` / `unwait`, host result handlers, client handlers and `LibInit.startOnline` with controlled fake transports to check replay, malformed/missing/old IDs, reconnect replacement, downgrade resistance, token ordering and pre-negotiation compatibility.
- `.github/workflows/connection-recovery-experimental.yml`: includes the C2 test for the isolated branch.

### C2 scope and limitations

A submitted **network packet carrying a stale choice ID** is rejected by an upgraded host. C2 does not *fully* protect a stale client-side callback that fires after the client has already received a new choice ID: the legacy client event engine may stamp that callback with the newest global ID. C3 must bind the ID to the originating UI/game event when the action is created, and add an authoritative gameplay progress/version check. Do not claim that the same-socket delayed-callback problem is fully solved.

Legacy clients that do not send `xbChoiceHello(1)` retain the pre-C2 behavior for compatibility; strict-ID protections apply only after opt-in. Opt-in is sticky per seat to prevent downgrade during recovery. UI/browser runtime testing and current V3 independent Chromium-host compatibility remain unverified. No production deployment: A1 heartbeat only; monitor v2.3.0 unchanged.


## Phase C3a – detecting false-online gameplay message processing (development only)

- `noname/util/xingbei-progress-tracker.js`: host-only monotonic broadcast sequence, a 15-second sampled `xbProgressProbe(probeId,seq,hostPhase)`, strict matching acknowledgements, per-socket tracking, a 90-second unanswered threshold with >=3 newer host broadcasts, and an advisory phase-lag signal after three consecutive observations.
- `noname/game/index.js`: increments the probe sequence at `game.broadcast` without altering the original gameplay messages. Creates/disposes a separate tracker with the hosted game's lifecycle. **No kick/disconnect on a suspicion.**
- `noname/library/index.js`: upgraded clients opt in after normal `inited`, recovery `reinited`, and game start. `xbProgressAck` is accepted only from the current initialized player socket, and the client sends an ACK only after its JavaScript WebSocket handler reaches the probe.
- `noname/library/element/client.js`: removes the old socket's tracker state only if it is still the current bound socket.
- `tests/connection-recovery-c3.mjs`: exercises host broadcasts, real browser/host message handler methods, probe/replay rejection, healthy idle periods, a simulated 5-second stall threshold, phase divergence, and old-socket takeover. CI includes C3.

**Important interpretation:** A probe ACK proves *ordered message dispatch reached the probe*, not that every asynchronous game event, animation, choice, card or skill resolution succeeded. Host/client `phaseNumber` comparison is diagnostic; some phases legitimately update asynchronously. The current progression signal monitors `game.broadcast` traffic, not every unicast or server-authoritative state transition. Therefore, C3a is **detection-only**: it deliberately does not forcibly close a socket, auto-reload the game, or declare a snapshot synchronized.

### Next C3b/C4 work before deployment

1. Bind C2 choice tokens to the *originating UI/game event*, rather than reading a mutable global ticket at send time; regression test delayed callbacks across overlapping choices.
2. Add an explicit authoritative state/version snapshot and digest or event checkpoint, gated on the actual host's game application flow (including V3 Chromium host).
3. Validate initial handshake + B2 authenticated seat reclaim + C1/C2 timeouts under real HALL/V3 source; do not substitute mock-probe success for an end-to-end game recovery acceptance test.
4. Choose a conservative escalation policy (warning -> resync -> reconnect) only after the state checkpoint can distinguish expected async work from a true stale client.

Deployment remains A1 server heartbeat only. This branch is not deployed to HALL/V3 websites. No changes to V1/V2 production game flow, V3 live runtime, or monitor v2.3.0.
