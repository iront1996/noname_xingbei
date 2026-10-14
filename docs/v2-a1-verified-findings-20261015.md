# A1 verification: deployed module and real Chromium (2026-10-15)

This is an **isolated-test branch**. No production code, backend files, V1/V2/V3 runtimes, or VPS services have been changed.

## Evidence A: deployed module VM audit (read only)

User-run audit against /opt/xingbei-hall/xingbei-connection-health.js:
- module SHA-256: \`2c9d6846543b290dbc890406364f2ae7458883ad03548131e73e1d8c81d7c552\`
- healthy text acknowledgment: PASS (no termination)
- fresh Pong, no text acknowledgment: reproduced A1 termination (\`terminated_despite_fresh_pong=true\`)
- neither reply: PASS (termination)
- close cancels watchdog: PASS, zero active timers
- old socket timer expiration does not directly kill new socket: PASS
- stale callback from old, cancelled timer does not directly kill new socket: PASS

The Pong-only PASS status means the test *observed the diagnostic behavior*; it does **not** mean terminating a transport-alive socket is appropriate for game hosts. The audit is scoped to A1 module behavior; it does not evaluate the HALL \`clients[]\`/room owner lifecycle.

## Evidence B: independent real Chromium experiment

A local-only 127.0.0.1 WebSocket server and real headless Chromium reproduces the mechanism without VPS access. The test deliberately occupies the page's JavaScript main thread for about 2.6 seconds, sends a text heartbeat in parallel with protocol Ping frames, and uses a proportionally shortened approximately 1.2-second timeout. Observed in one run:
- 5/5 protocol Ping/Pong exchanges succeeded while the page's JavaScript was blocked.
- No text heartbeat acknowledgment reached the server before the simulated timeout.
- Server deliberately aborted the socket; browser later processed the queued text heartbeat and recorded a \`1006\` close.
- Chromium outcome is *proof the failure mechanism can occur*, not evidence it did occur on Oct 14.
- This experiment does not execute the deployed A1 source; evidence A is the deployed-source check.

Reproduction: \`python tests/v2-a1-chromium-pong-app-stall.py\`, after installing Python \`playwright\` and \`websockets\` and setting \`CHROMIUM_PATH\` as needed.

## Interpretation and decision gate

1. The shared-HALL historical monitor contains 15 A1 heartbeat-timeout close-intents, but no per-socket last-Pong times or connection IDs. The 15 cases cannot be assigned to V2 (vs V1) or positively attributed to browser JS stalls.
2. The module-level cleanup paths passed. That is **not** sufficient proof that a terminated old owner socket cannot cause \`room.closed\` or \`selfclose\` affecting a different, current room/socket.
3. Do NOT ship a change that treats Pong alone as proof the game is progressing: a permanently blocked JavaScript game must still be detected. A candidate remediation should distinguish:
   - Pong alive + text reply missing = suspected application stall; bounded grace/diagnostic state, not immediate room destruction.
   - Pong missing + text reply missing = transport potentially lost; bounded timeout/cleanup.
   - New socket takes over = strict current-owner/current-seat identity; old close callback must not close the current room.
4. Before production: test real deployed HALL room close/owner replacement in an offline harness, plus Chromium owner/guest behavior and actual code-level timeout policies. Preserve production as-is until explicit authorization.

## Files

- \`tests/v2-a1-heartbeat-lifecycle.cjs\`: reads deployed A1 module with fake timers and sockets.
- \`tests/v2-a1-chromium-pong-app-stall.py\`: true Chromium web runtime and localhost WebSocket Ping/Pong.
