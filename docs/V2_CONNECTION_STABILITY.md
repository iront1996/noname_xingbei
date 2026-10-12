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

## V2-2: generated B2 HALL integration regression

- `tests/v2-b2-hall-integration.mjs` invokes the real Python B2 HALL patcher against an isolated legacy `game/server.js` source fixture with A1+v2.3 markers, then runs the generated code with fake WebSocket transports. This does not change a running broker.
- Tests fresh guest credential issuance, wrong-token rejection, B3 browser ordered key/resume messages, stable seat ID, forced old-socket retirement, stale WebSocket packet and close fencing, owner-to-new-guest reinit routing, repeated guest recovery, and denial after room owner departure.
- Distinguishes broker takeover, delivery of a reinit packet, and application of a valid snapshot; the simulator only verifies the first two plus explicit recovery-state gating, not engine-level snapshot completeness.
- Asserts patcher refuses backend sources missing either A1 or monitoring v2.3 markers. The markers in the test fixture are synthetically inserted: this does **not** establish a verified match with the current VPS deployed source.
- GitHub CI runs this separately from the current V2-1 safety-gate tests. No server, VPS, V1, V3 or monitor deployment/change.

**Next:** use a redacted copy of the exact A1+v2.3 HALL production source to check patcher anchor compatibility and monitor observer retention, then add browser-host `init` → `reinit` and C3 false-online diagnostic acceptance, finally plan one concentrated manual playtest. No claim of fully authoritative/replayable V2 engine state.

## V2-3: host-side reinit readiness fence

- The existing human-host `init` rebinds a B2 broker-authenticated reconnecting seat but does **not** change its `isAuto`, nickname or initialized status before the client `reinited` response.
- `inited` cannot bypass a pending reinit. `reinited` now requires an actually issued, current-socket pending reinit, and rejects duplicates, old/closed sockets, wrong seat identities and unregistered observers.
- Existing `xbProgressHello` remains unavailable while the replacement is pending; initial-lobby `inited` and the approved observer path remain available. The new V2 host handshake test executes the real engine handlers, not a duplicate implementation.
- **Limit:** a client-side `reinited` message is not proof of fully replayable GameEvent, pending skills, or hidden state. It does not justify automatic overwrite or forced reconnect. No deployment.


## V2-4: distinguish heartbeat from game execution

- `noname/util/xingbei-v2-progress-audit.js`: room-scoped, detection-only observer which correlates host broadcast sequence, turn phase, host pause, currently pending player choices, actual C2 lease deadlines and recent C3 WebSocket ACK age. It emits **advisories**, never declares a socket dead, forces AI, resets game state, or broadcasts diagnostics to players.
- `XingbeiProgressTracker` gains optional `onSample` callback from its existing 15-second probe, preserving the existing probe wire protocol and exception isolation. The V2 human host `game.createServer()` wires this callback only for its current initialized real `xingBei` guest seat.
- **Choice deadline overrun:** if a verified pending choice remains after its C2 lease deadline + 12s grace, emits a single advisory for that choice generation, even when the network ACK is still fresh. The existing choice timeout continues to own actual AI/choice completion.
- **Quiet host activity:** if a started game exhibits **neither** outbound host broadcast advancement **nor** phase change for 120 seconds, and **no** pending choice, deliberate host pause or unknown waiting state is present, emits one room-level `host_progress_quiet_unverified` advisory. This can be a legitimate animation or untracked host-side choice, not proof of a frozen game.
- Observations intentionally contain no session token, private hand, card contents, raw choice result or WebSocket. The audit holds no timers, game-state snapshots or transport refs. It resets when a new host starts.
- `tests/v2-progress-audit.mjs` covers responsive-but-overdue choice, normal waits, idle suppression, phase or host activity resetting the quiet window, one-shot advisory and session replacement, and verifies the real `createServer` integration.

**Boundary:** A blocked host JavaScript thread cannot run this host-local diagnostic. Client-side acknowledgements cannot prove that GameEvent processing continued. Future V2 work should add an independent observer and safe concentrated integration acceptance before any VPS deployment.


## V2-5: independent HALL liveness / game-progress observation

- The **uninstalled** B2 backend patch now also requires `xingbei-hall-progress-watch.js` deployed alongside the seat registry if/when B2 is authorized for deployment. The adapter attaches a separate Node.js 15-second interval that continues while the human Chromium host is frozen, provided HALL itself continues running.
- The browser human host reports a versioned `server.xbHostProgressV2` telemetry packet approximately every 15s when it is hosting `xingBei` through HALL; it contains only an outbound-message sequence, turn phase, count of unresolved choices, host pause boolean, and active-game boolean. No secret credentials, hidden game state, or game events are transmitted.
- HALL accepts telemetry **only from the current owner socket of the same room**, with fail-closed type and bound checks. The owner connection identity also fences room removal. Legacy HALLs ignore this optional server verb.
- **`host_socket_closed`** means the broker observed that the actual owner transport closed; the legacy room will be closed and is not recoverable using guest-only B2.
- **`host_app_report_missing_socket_open`** means the owner WebSocket was still reported open by the broker but valid host telemetry disappeared for 70 seconds. It is **not proof** of a frozen browser; timer throttling, page suspension, packet loss and browser overload can have the same symptom.
- **`host_progress_quiet_unverified`** means the host reports kept arriving but its phase and outbound message sequence both stayed unchanged for 120 seconds, with no pending human-choice, no deliberate pause and active gameplay. This is diagnostic only.
- Inactive/finished games clear tracking; old/unupgraded hosts are not automatically accused of being stalled because the observer only begins after an explicit valid report. Repeated identical alerts are deduplicated and a new observation window begins after silence ends.
- Backend observer logs are separate from the existing **monitor v2.3.0** and do not change its hook, identity, data retention or startup. Alerts never close sockets, replace human choices, initiate AI, overwrite snapshots or send client messages.
- `tests/v2-hall-progress-watch.mjs` runs a deterministic fake-clock observer and a generated B2 HALL backend with synthetic WebSockets. `tests/v2-b2-hall-integration.mjs` retains the original reclaim behavior using the new optional dependency.

### Remaining deployment and acceptance gates
- CI patches a synthetic `game/server.js` using inserted A1/monitor markers, **not an exact dump of the currently deployed VPS HALL**. Full source compatibility and observer-hook preservation must be verified offline from the real redacted source before any deployment.
- A fully blocked HALL Node event loop cannot run its own watchdog. The host-origin telemetry cannot independently prove that asynchronous engine events completed. This phase adds external liveness classification, not an authoritative game server.
- Continue V2-first, then V1, then V3. All production service changes require explicit permission.

## V2-6: offline HALL compatibility preflight and lobby stale-close fencing

- `tools/connection-recovery/preflight_v2_hall.py` accepts a **local copy** of a HALL backend source, optional pinned SHA-256, validates unique A1 and v2.3 monitor markers, invokes the same B2 patcher strictly in memory, checks both existing markers persist, and runs `node --check` on a temporary patched file. It verifies its input source was not modified and reports no production deployment. It returns `runtime_compatible: not_verified` even on success.
- `tests/v2-hall-preflight.mjs` covers pinned hash, synthetic compatible fixture, absent/duplicate prerequisites, drifted anchors and parser rejection. The CI fixture is not the real VPS backend. The command is intentionally **read-only** and has no `--apply` or `--output` mode.
- `noname/library/element/client.js` now prevents the close event of an old lobby socket from uninitializing a newly rebound player slot or resetting `onlinezhu`. It also ignores repeated close calls. This is critical for a recoverable seat during pre-game player management; the gameplay `player.ws === this` fence is retained.
- `tests/v2-lobby-stale-close.mjs` executes the real Client.close method for stale socket, current socket, unrelated socket and repeat close.

**Unverified and not deployed:** The real redacted VPS HALL source has not been supplied to the preflight; no exact deployed monitor hook code was inspected. `node --check` verifies syntax only and cannot prove monitor callback behavior, runtime dependencies, UI game-engine replay, or correct player choices. Approval for a staged deployment and concentrated real-player acceptance remains a separate prerequisite.
