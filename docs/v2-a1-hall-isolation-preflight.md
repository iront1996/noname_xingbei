# V2 A1 / HALL stability verification — isolated engineering checkpoint

Date: 2026-10-15. Scope is **V2 legacy HALL**, independent of V3/M2
and its PR. No production files, ports, services, Cloudflare Pages project,
A1 backend or monitor deployment have been modified by this work.

## Historical evidence (shared HALL = V1 plus V2)

2026-10-14 22:00–00:00 Asia/Taipei monitor showed:
- 51 recorded HALL disconnections: 18 code 1005, 17 code 1006, 16 code 1001.
- 15 A1 timeout close-intents; 3 owner-requested close-intents.
- HALL bridge emitted 720/720 10-second samples with a max sample interval
  of 11 seconds, arguing against sustained *global* Node event-loop blockage.
- Timeout samples had app-heartbeat pending with last send age ~60 seconds;
  most last text replies were ~89 seconds old.
- **No stored per-WebSocket Pong-age or connection IDs.** These historic
  cases cannot be assigned exclusively to V2 or attributed to browser stalls.

## Confirmed off-production behavior

1. **Deployed A1 source**, audited read-only by user on VPS, SHA-256:
   \`2c9d6846543b290dbc890406364f2ae7458883ad03548131e73e1d8c81d7c552\`.
   - Pong delivered, no app text ACK: A1 still terminates that socket.
   - Closing an old socket cancels its timers; no direct kill of a distinct
     healthy socket in the A1-only test.
   - The A1 audit does NOT cover HALL room ownership and client mappings.

2. **Real local Chromium** (shortened timing), with a deliberate JS main-thread
   stall: protocol Ping/Pong succeeded even while app text heartbeat was
   not dispatched. A 1006 browser close followed a simulated server abort.

3. **Actual GitHub \`game/server.js\`** run through an isolated VM with fake
   WebSocketServer and client sockets (no port bind): owner close, including
   a simulated terminate, emits \`selfclose\` to all guests. Guest close alone
   does not. The test now executes the exact V2 \`lib.message.client.selfclose\`
   function from \`noname/library/index.js\` rather than only modeling it.

4. **Real local Chromium** with loopback WebSocket: a received \`selfclose\`
   followed by code-less \`ws.close()\` gave close code **1005 at both ends**.

## Two-browser loopback comparison (additional evidence)

Using **two real Chromium pages** (one owner and one guest), a synthetic server
reproduced original HALL/A1 decisions with scaled-down timing; owner JS was
deliberately blocked for 2.4 seconds. The result is saved outside GitHub as
\`V2_A1_OWNER_GUEST_CHROMIUM_RESULT.json\` and the reproducer is
\`tests/v2-a1-owner-guest-chromium-comparison.py\`.

- Both experiments received four WebSocket Pong responses while owner JS was
  stalled; no text ACK was received before the simulated deadline.
- **Original decision**: synthetic terminate aborted the owner socket (1006);
  synthetic HALL room close delivered selfclose to the guest; guest closed (1005).
- **Bounded grace candidate**: retained transport after fresh Pong; owner
  application recovered and sent ACK; owner and guest sockets remained OPEN.
- The experiment deliberately simulates policy and HALL notification and
  does **not** execute the original deployed HALL server.js or A1 source.

An independent one-browser loopback case with real Chromium established that
a bare ws.close() on selfclose produces 1005 at both ends.
Do not infer real Oct 14 browser stalls or declare this a production fix.

## Experimental mitigation candidate (not wired or deployed)

\`tests/experimental/a1-policy-candidate.cjs\` is a **pure decision prototype**,
not a drop-in production A1 replacement. Tests assert:
- App ACK in time -> no change.
- App ACK missing but recent **post-probe Pong** -> classify suspected application
  stall and grant only a bounded grace period.
- Missing/stale Pong -> transport suspect, still terminal under timeout.
- App silence >=120 seconds -> terminal even with fresh Pong; transport alive
  does **not** imply game progression.
- Stale/replaced socket -> do not authorize termination of replacement.

The 120s is an *experimental hypothesis*, NOT a selected deployment value.
It requires end-to-end A1/HALL tests with actual deployed source and Chromium
background-page scenarios before adoption.

The HALL lifecycle test also checks candidate grace avoids the owner
close cascade when a recent Pong exists, whereas missing Pong still causes
the existing room-close behavior. This validates the *integration concept*
in a fake-socket environment; it does not prove a patch is safe to deploy.

## Non-negotiable blockers to production rollout

- The deployed HALL \`/opt/xingbei-hall/server.js\` and A1 module are **not**
  in this GitHub branch. Reference \`game/server.js\` is similar but not
  byte-identical to deployed HALL (deployed file includes A1 and monitor hooks).
- Preserve V2.3 monitor hooks, authenticated room/key paths, and existing
  server port 8080; **never** substitute this reference source for deployed code.
- The V1 and V2 frontends share the HALL backend. Any live A1 change
  affects both, so an isolated test branch alone is insufficient approval.
- Legacy HALL cannot preserve gameplay after actual owner death because
  owner browser hosts the game. Do not quietly fold in V3/M2 authority code.
- Need identity-safe old-socket cleanup verification against **actual deployed
  HALL**, including owner and guest and send/failure handlers, and a paired
  Chromium run against a **test server only**.
- Do not force a production restart, alter V1/V2/V3, or merge M2 without the
  user's explicit approval and a preflight/rollback package.

## Evidence and CI

- \`tests/v2-a1-heartbeat-lifecycle.cjs\`: directly audits deployed A1 when
  pointed to an explicit source path. Historical VPS report confirms 6 tests.
- \`tests/v2-hall-owner-lifecycle.cjs\`: uses actual checked-out HALL reference
  module in a fake server; check the current branch's CI.
- \`tests/experimental/test-a1-policy-candidate.cjs\`: 8 candidate assertions.
- \`tests/v2-a1-chromium-pong-app-stall.py\`: browser stall reproduction.
- \`tests/v2-selfclose-chromium-repro.py\`: browser selfclose/1005 reproduction.
- Dedicated GitHub Actions workflow triggers only this isolated test branch.

## Decision

**Root mechanism confirmed**: app heartbeat silence can terminate an
otherwise Pong-responsive socket, and an owner socket close cascades to
room-wide selfclose messages. **Historical original trigger still unknown**
for lack of per-socket Pong metrics. The candidate should remain unshipped
until deployed HALL source integration and browser validation are available.
