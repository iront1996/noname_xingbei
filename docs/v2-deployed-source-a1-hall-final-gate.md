# V2 deployed-source A1/HALL integration review — 2026-10-15

This is **V2-only** and separate from the ongoing V3 M2 Codex work and PR. No live VPS, V1, V2, V3, production Cloudflare Pages, monitoring service, or M2 changes were made.

## Exact deployed files received and checked locally

The user supplied a three-file source archive, processed locally and **not committed to GitHub**.

| Source | SHA-256 |
|---|---|
| `server.js` | `321930d886bcb3ef311ca95fd760bc581b1b2d78047e0a28a9d919b810738283` |
| `xingbei-connection-health.js` | `2c9d6846543b290dbc890406364f2ae7458883ad03548131e73e1d8c81d7c552` |
| `xingbei-monitor-bridge.js` | `b4c52f687b724bbde8b0e6a71f8311a2823e39aff02c5becd52205dedb7aa80e` |

The HALL is explicitly bound to localhost port 8080. The V2.3 monitor bridge registers before the game connection handler. HALL sends `selfclose` to guests when the owner socket closes, and the V2 client executes a bare `game.ws.close()` on selfclose.

## Actual deployed code run in isolated fake-socket environment

A deterministic offline suite evaluated the **exact** supplied HALL, A1 and V2.3 bridge JS with a virtual clock, fake WebSocketServer and sockets, and a fake outbound monitor HTTP client. No live listener, monitor endpoint, or network traffic. **23/23 assertions passed**.

It confirmed:
- Original A1 kills an owner with Pong alive but application heartbeat delayed, causing owner `1006` and guest `1005`.
- Candidate with fresh post-probe Pong grants *bounded* stall grace; when an application heartbeat resumes, owner and guests remain in-room.
- Missing transport Pong still times out at the original deadline.
- Indefinitely stalled application still terminates at 120s since last application ACK even with Pong alive; transport liveness is not proof of game progression.
- Original and candidate auth timeout, guest closure, owner-requested close, old socket timer cleanup, monitor intent and room closure, and 4/6/8 socket scenarios retained expected behavior.
- Actual monitor bridge captured original disconnect and room close, and no room closed in the candidate recoverable-stall case.

The specific provisional A1 candidate file has SHA-256 `6199260d4d705e96eadd58da85b4e84ab5352a74359e31ca60092e4060e3cfe8`.

## Candidate change is restricted to A1

Existing `intervalMs=30000` and `timeoutMs=45000` remain. Adds `pongFreshMs=45000` and `maxAppSilenceMs=120000` as **experimental, not yet deployed**. An extra WS protocol Ping while app heartbeat is pending permits recent Pong after probe to establish transport liveness but **does not clear app pending or prove gameplay progress**. If app silence reaches its finite limit, terminate; if Pong stale/missing, terminate at original deadline.

Production `server.js`, `xingbei-monitor-bridge.js`, V3 and M2 are unchanged. A checksum-guarded HALL-only deployment/rollback bundle is prepared separately for user approval, **not** deployed.

## Deployment gate

The shared HALL serves V1 **and** V2. Restarting `xingbei-hall.service` interrupts both and may destroy active games. A1 candidate must not be applied until the user explicitly authorizes a maintenance window. A follow-up concentrated smoke/real-player validation is required; offline fake sockets and local Chromium are not equivalent to full live gameplay. Do not ship V3 M2 code or attempt host-seat transfer in this V2 fix.

Historical 2026-10-14 Pong and connection IDs were not retained, so the actual underlying initial trigger remains unproven.
