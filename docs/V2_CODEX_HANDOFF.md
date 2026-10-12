# V2 Codex engineering handoff

## Verified starting point

- Repository: `iront1996/noname_xingbei`
- Protected base: `feature/v2-connection-stability`
- Remote HEAD verified on 2026-10-13: `2baf3667e4cfb8dc0bef88a601413d6f4fa0499b`
- Working branch: `codex/v2-server-authority-m1`
- GitHub Actions run 38301778625: success for commit `2baf366`, job 12 seconds, total 16 seconds.
- No newer remote base commit existed when this batch started.

## Confirmed prior V2 work

`docs/V2_CONNECTION_STABILITY.md` and the implementation/tests confirm V2-1 through V2-9: broker-gated seat reclaim, host reinit readiness, choice lease/ticket protection, progress and HALL observation, stale lobby close fencing, asynchronous reinit generation/shape guards, snapshot coverage diagnostics, and scoped own-seat poison-source restoration. These remain human-hosted recovery mechanisms and do not prove complete engine replay.

Important sources:

- `game/server.js`: legacy HALL room broker and the M1 integration point.
- `noname/library/index.js`: host/client recovery messages and reinit handling.
- `noname/game/index.js`: game broadcast, snapshot and host behavior.
- `tools/connection-recovery/`: B2 seat registry, patcher, preflight and HALL progress observer.
- `tests/v2-*.mjs`: V2 security and recovery regression suites.
- `.github/workflows/connection-recovery-experimental.yml`: isolated V2 CI.

V2-10 pending-choice UI restoration is explicitly paused.

## Legacy HALL findings

Before M1, a room was a plain object whose `owner` was the human host WebSocket. Guest packets were forwarded directly through `client.owner`. Closing that socket sent `selfclose` to every guest and immediately removed the room. There was no host-disconnect grace state, server-held expiry deadline, owner reclaim secret, credential rotation, or lifecycle cleanup model.

## Local baseline evidence

The complete command represented 69 Node tests: 59 passed and 10 failed on Windows before M1 changes. The failures are pre-existing local portability constraints:

- Two source-extraction tests expect LF-only anchors, while this checkout is materialized as CRLF. Their anchors exist in the source and the referenced GitHub Linux CI passed.
- B2 patch/preflight generated-source tests invoke Unix-style Python tooling and fail under this Windows Python 3.14 environment; the seat-registry test passes independently.

These local failures are not treated as product regressions, but the PR must obtain Linux CI evidence. No VPS source compatibility, deployment, real Chromium game continuation, or real-player acceptance was performed.

## Current batch

M1 batch 1 adds a server-owned lifecycle record around the still-human-hosted engine. Owner disconnect pauses and retains the room for a bounded grace period; it does not claim gameplay continues. Reclaim requires the original bound online identity plus a rotating server-generated secret. A resumed owner remains in `waiting_host_process` until it reconfigures; guests are not routed to it beforehand. Expired rooms are explicitly cleaned and only then close remaining guests.
