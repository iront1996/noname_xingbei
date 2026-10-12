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
