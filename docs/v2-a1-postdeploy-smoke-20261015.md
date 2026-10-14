# V2 A1 post-deployment production loopback smoke — 2026-10-15

**Strict scope:** shared V1/V2 HALL A1 heartbeat and socket lifecycle. Independent of V3 server-authoritative M2 development and PR. No production write or restart was requested or performed by this documentation change.

## Deployment

The user performed the authorized maintenance restart with the guarded retry package:

- `APPLY PASS -- only xingbei-hall.service restarted; V3 service untouched`
- `xingbei-hall.service`: active
- `127.0.0.1:8080`: LISTEN
- `xingbei-connection-health.js` candidate SHA-256: `6199260d4d705e96eadd58da85b4e84ab5352a74359e31ca60092e4060e3cfe8`
- `server.js` SHA-256 remains `321930d886bcb3ef311ca95fd760bc581b1b2d78047e0a28a9d919b810738283`
- `xingbei-monitor-bridge.js` SHA-256 remains `b4c52f687b724bbde8b0e6a71f8311a2823e39aff02c5becd52205dedb7aa80e`
- Saved backup: `/opt/xingbei-v2-a1-backup.20261014T212004Z.506982`

## Observed real HALL 135-second smoke report

User supplied `REPORT_V2_A1_POSTDEPLOY_SMOKE.txt`. It uses three temporary non-room localhost connections; creates no rooms or game messages; makes no service changes.

| Scenario | Handshake | Observed | Result |
|---|---|---|---|
| healthy | 101 | 4 text heartbeats, 4 protocol Pong replies, 4 application ACKs, remains open | PASS |
| recoverable | 101 | 4 Pong replies, 2 text heartbeats, app ACK resumes and next heartbeat arrives, remains open | PASS |
| unresponsive | 101 | 0 Pong, 0 app ACK, connection closes after 90.0s | PASS |

Overall: `pass: true`, runtime 135.0s. The unresponsive `close_code: null` is not an observed Close frame; it must NOT be advertised as a verified WebSocket 1006.

## Remaining acceptance gate — one concentrated real-browser session

This is not yet an end-to-end V1/V2 multiplayer game test, because the synthetic smoke clients never created rooms or exchanged game packets. A human smoke can be completed in **one scheduled session**, ideally two participants with two distinct devices/browser contexts:

1. V1: create a room, join from a second browser, launch the game, complete an actual player-choice and game action, observe consistency, then exit normally.
2. V2: repeat the same steps in V2. Record room creation/join, role/choice dialogs, action delivery, game state agreement and clean exit.
3. Keep a V2 room in a normal responsive, foreground state through multiple heartbeat cycles; no unexplained reload or spontaneous `selfclose`. Do not intentionally freeze a live game with a debugger.
4. If feasible, confirm a guest voluntarily leaves during a throwaway V2 lobby, then joins a new room without affecting another active guest; do not treat owner death as recoverable in legacy V2.
5. Capture outcome and approximate timestamps; screenshot only unexpected UI failures, avoid credentials or private identifiers.

**Abort criteria:** room unexpectedly closes, a player reloads involuntarily, backend HALL not active, repeated failure to enter a room, or event handling stalls. Preserve logs and the backup; do not auto-reapply, restart, or roll back while participants are still playing.

**Success criterion:** V1 and V2 both complete normal room, join, gameplay and exit tests without unexpected disconnection. This is a narrow production smoke, not proof of eliminating every internet-wide transient or restoring a lost legacy owner.

Next production code modifications / any new maintenance restart require explicit new user consent. Keep V3/M2 completely isolated.
