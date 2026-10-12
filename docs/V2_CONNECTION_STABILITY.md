# V2-first connection stability gate (development branch)

Branch: `feature/v2-connection-stability`.

## Priority and isolation

1. **V2**: legacy HALL guest reclaim, owner/guest socket identity, real gameplay acknowledgement, false-online detection and safe snapshot recovery.
2. **V1**: only after V2 tests and review, plan compatible implementation separately.
3. **V3**: defer all new V3 feature work. The existing `feature/connection-health-recovery` branch stays untouched.

This branch was forked from commit `9b4c2a29582e412733014f60e6e70f1f4ec03397`, before the separate C3d V3 candidate change. Changes in this batch are scoped to the existing browser guest-recovery protocol and its test harness, not production services.

## V2-1 implemented: broker-confirmed reclaim must precede reinit

- `xbSeatReclaimed` only sets the success flag after this client sent `xbResumeSeat` and the active recovery controller is in `SYNCING`. Duplicate/unsolicited/stale-phase acknowledgements are consumed but cannot authorize a state rebuild.
- `xbSeatResumeRejected` only clears the tab's credential after an active reclaim attempt in `SYNCING`. An unrelated rejection cannot poison the recovery.
- The **actual** `lib.message.client.reinit` method now returns without clearing or overwriting a V2 guest's current arena if the recovery is active but broker reclaim proof has not been received. Non-recovery reinit remains unchanged.
- `tests/v2-recovery-gate.mjs` tests the real method body and the real control protocol. The CI workflow runs the new V2 gate tests alongside B1–C3c.
- These are application-level guards, not server-side session authentication. The HALL broker must validate room/session-secret takeover. Only A1 heartbeat is currently deployed.

## Limits and next gate

- V2 is still **human-hosted**: a room owner's disconnection can end the match. This batch does not turn V2 into a server-authoritative engine.
- A `reinit` callback cannot prove card/skill async resolution finished. C3 probes and public-state checks remain diagnostic only. Do NOT force a reconnect or declare gameplay restored solely because a WebSocket opened.
- No genuine HALL+B2 deployment compatibility, current VPS source verification, or concentrated browser/real-player acceptance has been performed.
- Do not deploy V2 changes until HALL B2 adapter, seat-credential provisioning, guest reinit and host-side timeout fencing pass a paired end-to-end test.

**No VPS, V1, live V2, live V3 or monitoring v2.3.0 files/services were changed in this batch.**
