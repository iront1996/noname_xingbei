# Connection health – phase A1

Development branch: `feature/connection-health-recovery` (forked from `feature/host-reconnect-v3-playtest`).

## Implemented in this branch

- `noname/util/xingbei-connection-health.js`: browser inbound-silence watchdog (85-second initial threshold); detects half-open WebSocket connections even if `onclose` never arrives.
- `noname/game/index.js`: socket-scoped message and close hooks; stale socket closes, then invokes the original single-shot recovery path if the close handshake does not finish. Does **not** yet implement seamless reconnect or game restoration.

## Backend

A companion, independently deployable HALL+V3 backend upgrade (`xingbei-connection-health.js`) is staged in the phase-A delivery package. It retains legacy application heartbeat messages, adds Ping/Pong and bounded timeout detection, and respects the v2.3 monitoring callbacks.

## Boundary

Transport health does not prove that asynchronous gameplay events advanced. Phase B must implement session-safe automatic reconnect, host/authoritative snapshot synchronization, and timeout/AI action fencing. The production monitor remains unchanged. Do not merge to production until paired backend/client deployment and tests pass.
