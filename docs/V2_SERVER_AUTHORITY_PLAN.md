# V2 server-authority plan and evidence

## Architecture direction correction (normative)

The final integration target for the M2 server-authority core is **V3**, not the formal V2 product. The `codex/v2-server-authority-m1` branch, its V2 naming, and the V2-oriented test harness are development history and isolation boundaries only; they do not authorize changing formal V2. Formal V2 must remain independent, with its existing protocol, room management, gameplay flow, and deployment unchanged.

After M2 is validated, integrate or port only the required, verified server-authority core through a **new isolated integration branch based on V3**. Do not merge this entire V2 experiment branch into V3. PR #1 targets `feature/v2-connection-stability`, so it must remain open and unmerged. V3 production code and services stay read-only unless the user explicitly approves a scoped change; no production integration or deployment is authorized by this plan.

The V3 end state is server-owned room lifecycle and a server-managed independent game host. Every human, including the room creator, is an ordinary player with the same seat/reconnect behavior; creator administration remains a separate control-plane capability. No single player's disconnect may close the room or stop its game process. Player transport failure and server/host-process failure remain separate recovery classes.

## Normative M2 core architecture contract for future V3 integration

The target is not a recoverable human host. It is the complete removal of every human browser from the game-host role.

1. HALL/server code exclusively creates and owns room records and lifecycle transitions. A browser sends a create request; it never becomes the authoritative room or engine process.
2. The creator is automatically admitted as an ordinary authenticated player seat using the same seat credential and recovery protocol as every later player.
3. The creator may separately receive a scoped room-administrator capability for configuration and moderation. This control-plane capability cannot execute rules, mutate authoritative game state, submit trusted results, impersonate the host process, or derive host credentials.
4. A server-managed, authenticated and supervised game process is the sole game authority. It runs initialization, events, skills/cards, choices, turns, deadlines/timeout or trustee policy, and result determination independently of all player browsers.
5. Creator and non-creator gameplay packets, disconnect handling, seat reclaim, stale-socket fencing and replay protection are identical. No player connection is stored as the game host.
6. Player disconnect/reload/browser closure cannot close the room, stop the managed host, or disconnect other players. Administrator absence cannot pause gameplay.
7. If a disconnected player has a pending choice, the authoritative host applies an explicit server deadline and configured timeout/trustee action; it cannot wait forever for a browser.
8. Administrator recovery or transfer is a separate authenticated policy. It neither resumes nor takes over game execution.
9. Only the managed host may commit authoritative state and results. HALL must reject player/admin attempts to use privileged control messages as engine output.
10. Managed-host/server failure is an M4 recovery event based on validated checkpoints. It is never handled as player disconnect or administrator recovery.

M1 deliberately remains a compatibility bridge: HALL now preserves a human-hosted room safely, but the browser still executes the engine. The M1 `ownerResumeToken`, `resumeowner`, `room.owner`, `awaiting_host`, and `waiting_host_process` paths may remain for legacy compatibility, but M2/M3 must not use them as architectural foundations.

## Current compliance audit

| Area | Classification | Evidence and required adjustment |
| --- | --- | --- |
| Server-held room record, lifecycle state, bounded expiry and cleanup | **Already aligned** | `game/server-room-lifecycle.js` owns records, deadlines and cleanup. Generalize its lifecycle actor from human owner loss to player-count/policy and managed-host state without discarding the tested component. |
| Cryptographic seat credentials, room scope, stale-socket and duplicate takeover fencing | **Already aligned** | `tools/connection-recovery/seat-registry.js` and B2 tests provide reusable identity defenses. Remove its current dependency on `room.owner`/human-host routing when integrating M3. |
| Room creation and creator admission | **Transitional architecture** | `game/server.js` `create` makes the requesting socket `room.owner`; the creator is not issued an ordinary seat. Replace this in the new protocol with server creation followed atomically by normal-seat admission plus a distinct admin capability. |
| Gameplay routing and authority | **Transitional architecture** | `game/server.js` stores `client.owner`, forwards guest traffic to the human at the WebSocket message handler, and trusts that browser to send game messages back. M2 must route player commands to an authenticated managed host identity instead. |
| `ownerResumeToken`, `resumeowner`, host pause/resume | **Transitional architecture** | Retain as a versioned compatibility path only. Never reuse its token as an admin token, seat token or managed-host credential. |
| Non-owner `roompaused`/`roomresumed` safety | **Already aligned for compatibility** | The validation prevents forged legacy lifecycle transitions, but final gameplay must not pause merely because the creator/admin disconnected. |
| Creator equals ordinary player | **Not implemented** | M3 must issue the creator the same B2-derived seat credential and recovery behavior as B/C/D. |
| Separate administrator capability and authorization boundary | **Not implemented** | Add an independently scoped, rotating/revocable server capability and allowlisted admin commands; no engine-output commands. |
| Server-managed authoritative engine | **Not implemented** | M2 must add supervised process identity, authenticated routing, startup/readiness, resource and termination controls, and sole-authority enforcement. |
| Pending-choice server deadline/trustee policy | **Not implemented** | M2 must move choice ownership/deadlines to the managed host and prove deterministic timeout handling without a browser. |
| Managed-host checkpoint recovery | **Not implemented** | M4 must distinguish host failure from player transport loss and validate checkpoints/replay before resuming authority. |

“Already aligned” means reusable toward the target; it does not mean the final architecture is present end to end.

## M1 — human-host compatibility lifecycle

Status: compatibility batches implemented and Linux CI passed; further M1 expansion is paused for final-architecture calibration. PR review remains pending.

Lifecycle states:

1. `active`: HALL holds the room record and routes guests to the current human host.
2. `awaiting_host`: the host transport closed; guests remain associated but are unrouted and receive `roompaused`.
3. `waiting_host_process`: an authenticated owner reclaimed the room, but HALL waits for host reconfiguration before routing guests.
4. `expired`: the grace deadline elapsed; HALL removes the room and sends `selfclose` with `room_expired` to remaining guests.

Security decisions:

- Owner reclaim requires both the original `onlineKey` binding and a 256-bit server-generated resume secret.
- Resume secrets are compared with a timing-safe equality check and rotated after successful use.
- Public room identifiers alone cannot reclaim ownership.
- Guest routing is removed while the room is paused, so stale owner sockets cannot continue receiving packets.
- Duplicate room keys fail closed.
- Legacy server-mode workers cannot claim a paused managed room.

Batch 1 implementation:

- `game/server-room-lifecycle.js`: deterministic lifecycle/state/expiry component with injectable clock and token source.
- `game/server.js`: create, pause, owner reclaim, activation, guest rerouting and periodic cleanup integration.
- `tests/v2-server-room-lifecycle.mjs`: simulated WebSocket coverage for normal flow, guest disconnect, host disconnect, authenticated host reclaim, token rotation and expiry cleanup, plus real-source integration anchors.
- CI now runs the M1 test on pull requests targeting the V2 base.

Known M1 limitations and disposition:

- Browser owner credential persistence/resubmission and actual handler tests are implemented, but exist only to make the transitional human-host route safer.
- Room and token state are memory-only; process restart recovery belongs to M4.
- The host still executes the engine. `waiting_host_process` prevents this batch from claiming gameplay continued during host absence.
- Real HALL WebSocket and generated B2+M1 process tests pass. Real-browser game-engine acceptance, rate limiting/audit telemetry and exact VPS-source compatibility remain unverified.
- Do not expand owner recovery into the final design. Future implementation work starts with the M2 managed-host boundary after explicit approval.
- Verify compatibility against the exact redacted VPS HALL source offline before any deployment request.

### M1 browser owner recovery and real-process test

- The browser stores protocol-v1 owner credentials in tab-scoped session storage and resubmits them only from the same live page that originally received the credential. A hard reload does not possess the in-memory readiness marker and therefore cannot pretend the human-host engine survived.
- Owner recovery sends the normal HALL key binding first, then `resumeowner` with explicit protocol version 1. The HALL rejects unsupported versions before token processing.
- A valid reclaim rotates the secret, leaves the room in `waiting_host_process`, and requires the surviving browser host to resend its configuration before guest routing resumes.
- A spawned-process integration test starts the actual `game/server.js` on an isolated loopback port and uses real `ws` clients to verify create, guest join, owner pause, paused-room admission rejection, protocol rejection, authenticated owner resume, token rotation and guest rerouting.

### M1 client state-transition correction

- The actual `createroom` handler intentionally changes a human host from `online=true` to `online=false, onlineroom=true`. Owner recovery therefore keys off either live online state, not guest-only `game.online`.
- Actual handler execution tests run `createroom` followed by the real WebSocket `onclose` body and prove the owner recovery entry point is reached.
- Guest `roompaused` accepts only bounded deadlines and known states for an online, non-owner HALL client; it clears stale choice/progress identifiers. `roomresumed` requires protocol 1 plus the current room ID before reopening the guest lifecycle state.

### M1 and B2 same-process integration

- Linux CI generates a HALL server from the current `game/server.js` through the production B2 patcher, then starts that generated server on an isolated loopback port with real WebSocket clients.
- The integration verifies that an authenticated guest seat cannot be reclaimed while the room is paused, survives owner recovery, is rebound to the replacement owner, and resumes bidirectional game-message routing.
- Repeated valid takeovers retain one stable seat identity, terminate the superseded transport, route only the newest socket, and reject an invalid credential without disturbing the live seat.
- Evidence: commit `289d082`; Linux CI run 38306224205 completed the dedicated generated-B2/M1 step successfully. The portable local regression also passed 70/70 Node tests plus the standalone B2 seat-registry test.
- This is equivalent server-process integration evidence, not real-browser acceptance. M1 remains incomplete until the browser client and engine path are exercised end to end.

### M1 review hardening

- Paused rooms now reject fresh `enter` attempts with `room_paused` before assigning any room or owner reference. Existing associated guests remain attached and can wait for recovery.
- Closing a legacy server-mode host releases every attached guest, sends `selfclose` with `server_host_closed`, and clears both `room` and `owner` references. Unrelated rooms and the already-closing host are not mutated.
- Expiry cleanup and server-mode shutdown share the same tested reference-release helper.

## M2 — managed server authority and administrator separation

Status: first infrastructure batch implemented; not connected to HALL or Chromium; M2 gameplay authority remains incomplete.

### M2 batch 1 — isolated hostSession foundation

- `game/server-host-session-manager.js` defines an internal protocol-v1 `hostSession` with cryptographically independent session ID and secret. The secret is passed only to the trusted launcher bootstrap and is absent from every public session view.
- Lifecycle states cover `starting`, authenticated `ready`, `stopping`, `stopped`, and `failed`. Launch failure, readiness timeout, unexpected exit and stop failure retain distinct failure codes; a later exit cannot overwrite the first diagnosed failure.
- Only a `managed_host` attestation matching protocol, room, current session ID and timing-safe secret may mark readiness or submit an authoritative result. Player-seat and room-administrator credential kinds are rejected even if their token text is maliciously chosen to match the host secret.
- Authoritative results require the current ready session and exact monotonically increasing sequence. Duplicate, out-of-order and stale-session results fail closed.
- The launcher is dependency-injected. Batch 1 uses a simulated process handle to test lifecycle and security before attaching any real Chromium implementation.
- This component is intentionally not imported by `game/server.js` yet. It does not alter M1 routing, create players/admins, load rules, advance turns or prove SA-A01–SA-A10.
- Evidence: implementation commit `d110829`; Linux CI run 38308126401 passed the dedicated `V2 M2 managed host-session lifecycle and authority boundary` step. Local portable regression passed 75/75 Node tests plus the standalone B2 seat-registry suite.

Read-only V3 research findings:

- `game/v3-chromium-authority-worker.mjs` provides useful process mechanics: server-owned child process, unique temporary profile, loopback-only ephemeral CDP, strict CDP method allowlist, startup deadline, sandbox opt-in guard, early-exit detection, explicit inspection and cleanup.
- V3 tests explicitly distinguish “worker alive/offboard” from “rules loaded/playable/state persisted”. V2 must preserve the same evidence discipline.
- V3 authority bridge and coordinator experiments demonstrate authenticated room channels and creator-independent worker lifetime, but remain V3-only and are not imported or modified by this batch.
- The future V2 Chromium adapter should implement the batch-1 launcher contract rather than weakening or bypassing the hostSession identity boundary.

### M2 batch 2 — supervised simulated host process

- `game/server-managed-host-launcher.js` starts one isolated child process per hostSession with an IPC channel and a bounded graceful-stop timeout followed by forced termination.
- The host bootstrap, including its secret, is delivered only over IPC after manager listeners are installed. It is not placed in command-line arguments or environment variables; the real-child integration test verifies both properties inside the child.
- Child `host_ready` and `authoritative_result` messages are routed through the same hostSession attestation and sequence checks as the direct unit tests. The child cannot bypass the authority gate merely because it was spawned by the server.
- A real Node child fixture proves launch, ready, one accepted result, requested stop and abnormal exit. Failure of one room's child does not change another room's ready session.
- Evidence: implementation commit `79de3fb`; Linux CI run 38308392018 passed the combined host-session/process step. Local portable regression passed 77/77 Node tests plus the B2 seat-registry suite.
- This is process-supervision evidence only. The child is a simulated host and does not load Chromium or the Xingbei engine.

### M2 batch 3 — real Chromium off-board lifecycle proof

- `game/v2-managed-chromium-host.mjs` is a V2-owned supervisor executable launched through the same private-IPC hostSession adapter. No V3 module is imported or changed.
- It starts a real headless Chromium with a unique temporary profile, extensions/background networking disabled, an ephemeral loopback-only CDP endpoint and no automatic sandbox bypass. Root execution fails closed rather than silently adding `--no-sandbox`.
- The supervisor reports `host_ready` only after it discovers the protected `DevToolsActivePort`, queries the loopback CDP endpoint and verifies an `about:blank` page target. Requested stop terminates Chromium and removes the profile.
- Local Windows testing used installed Chrome and passed; Linux CI locates its runner Chromium/Chrome explicitly. Evidence: commit `cc5adca`; Linux CI run 38308610888 passed both the host-session/process tests and the dedicated real-Chromium step. Portable local regression passed 78/78 plus B2 seat-registry.
- Readiness in this batch means only “isolated browser and CDP are alive”. No Noname/Xingbei module is loaded, no game loop runs, no player is routed, and no authoritative result is produced. M2 and SA-A01–SA-A10 remain incomplete.

### M2 batch 4 — browser-ready and engine-ready authority gate

- hostSession readiness is now two mandatory authenticated transitions: `starting -> browser_ready -> engine_ready`. Browser-ready proves only the supervised browser transport; engine-ready is a separate host attestation reserved for validated engine initialization.
- Browser and engine readiness use separate bounded timers and failure codes. A browser-ready process that never initializes the engine is stopped with `HOST_ENGINE_READY_TIMEOUT`; it cannot remain indefinitely half-ready.
- `commitAuthoritativeResult` accepts only the current `engine_ready` session. Results submitted while starting or browser-ready, by stale sessions, with duplicate/out-of-order sequences, or with player/admin credentials fail closed.
- The real Chromium supervisor intentionally emits only `host_browser_ready`. The simulated engine fixture emits both phases so the authority-result path remains testable without falsely treating CDP liveness as engine initialization.
- Completion vocabulary is fixed for later batches: **Browser Ready** = Chromium/CDP alive; **Engine Ready** = required native engine APIs initialized and verified; **Game Ready** = room configuration/roster and authoritative initial state committed; **Playable** = event loop, choices, deadlines, rules and results execute server-side. These are independent of the later M2+M3 four-ordinary-player continuity acceptance.
- Evidence: commit `b943f47`; Linux CI run 38310628904 succeeded.

### M2 batch 5 — Chromium process-tree and resource cleanup

- Chromium runs in its own process group on Linux. The authenticated supervisor registers its Chromium PID/process-group ID and isolated profile with the parent launcher over private IPC; unauthenticated resource messages cannot select cleanup targets.
- The launcher retains cleanup responsibility after supervisor death. It terminates the registered group, escalates to forced termination after a bounded wait, and removes only a validated `v2-managed-host-*` directory under the system temporary root.
- Tests use real Chromium/Edge processes to verify normal stop, invalid-executable startup failure, forced supervisor termination, Chromium abnormal exit, PID disappearance, profile removal and two-room fault isolation. Startup executable access is validated before profile creation.
- Sandbox policy remains unchanged: no automatic `--no-sandbox`, and root launch fails closed.
- Local full regression passed 81/81 plus B2 seat-registry, with no remaining managed-host temp profiles. Evidence: commit `0ec5dc1`; Linux CI run 38311258383 succeeded. This is resource-supervision evidence, not Engine Ready or Game Ready evidence.

### M2 batch 6 — minimal real-engine initialization

- When given an explicit loopback-only game origin, the V2 Chromium supervisor opens a narrow CDP session, installs immutable `window.isNonameServer`, navigates to an isolated empty host page and dynamically imports the checkout's real `noname.js` and `mode/xingBei.js` modules.
- Engine Ready requires concrete native API checks: `game`, `lib`, `ui`, `_status`, Xingbei mode identity, `randomMapOL`, `checkResult` and `checkOnlineResult`. Only after every check succeeds does the supervisor send authenticated `host_engine_ready`.
- The verified proof explicitly requires `gameLoopStarted:false`. No arena, roster, players, cards, events, choices or network routing are initialized, and the engine submits no authoritative result.
- The loopback static module host exists only in test fixtures and rejects traversal, query strings and non-GET/HEAD methods. No service is deployed.
- Local real-browser and full regression passed 82/82 plus B2 seat-registry with no managed profile residue. Evidence: commit `8e7c7d3`; Linux CI run 38311479712 passed every `node-recovery-tests` step, including the real-Chromium lifecycle/engine-init step. This upgrades **Engine Ready** to proven for minimal native module/API initialization only; **Game Ready**, **Playable**, and M2+M3 four-player integration remain not implemented.

### M2 batch 7 — Game Ready authority gate

- hostSession now requires `starting -> browser_ready -> engine_ready -> game_ready`. Engine Ready no longer authorizes authoritative result submission.
- The server validates and binds an immutable Xingbei room setup before launch: bounded configuration, ordered unique seat IDs and positions, plus a canonical SHA-256 setup digest. Invalid setup never starts a process.
- An authenticated managed host may enter Game Ready only by returning the exact server setup digest, exact ordered seat set and a SHA-256 pre-game verification-summary digest. A separate bounded Game Ready timeout stops an engine that never completes initialization.
- Existing managed-host authentication, stale-session fencing and exact result sequence protection remain in force. Player and administrator credentials still cannot attest readiness or submit a result.
- This batch proves the state/authority gate with deterministic and supervised-process fixtures only. It does **not** claim real Game Ready until Chromium constructs and verifies the actual engine state in the next batch; Playable and M2+M3 four-player integration remain unimplemented.
- Evidence: commit `7805bf2`; Linux CI run 38353870134 succeeded.

### M2 batch 8 — real Chromium Game Ready initialization

- The managed Chromium now runs the repository's native `boot()` preparation, loads the actual Xingbei mode through `loadMode`, loads the imported character/card definitions with the engine's own loading functions, and then calls native `game.prepareArena` for the server-supplied seat count.
- Server-supplied ordered seat IDs are bound to native `lib.element.Player` instances and registered in `lib.playerOL`. The initialization fails closed unless the mode, 2v2/3v3/4v4 mapping, native player count/positions, loaded card definitions and configured card list all match.
- The pre-game verification summary also proves `game.me === null` and zero player WebSocket bindings: the managed process has no human-host player. Its canonical digest is retained by hostSession before the `game_ready` transition.
- The engine event loop remains deliberately stopped (`eventLoopStarted:false`), with no winner and no authoritative result emitted. This is **Game Ready** evidence for a validated pre-game native state, not **Playable** evidence.
- The loopback fixture serves the real config/package/module files only to the isolated test Chromium. Chromium sandbox policy and the prior process-tree cleanup controls remain unchanged.
- M2+M3 four-player disconnect/continuation acceptance remains unimplemented and is not implied by Game Ready.
- Evidence: commit `0267880`; local targeted tests passed 9/9 host-session/process tests, 5/5 real-Chromium tests and B2 seat-registry. Linux CI run 38354781202 passed every workflow step, including the real-Chromium Game Ready test.

### M2 batch 9 — Game Ready acceptance hardening

- Real Chromium acceptance now independently initializes native 4-, 6- and 8-seat arenas and verifies the corresponding 2v2, 3v3 and 4v4 configurations.
- Server-side tests reject duplicate seat IDs, non-contiguous/wrong positions, mode/player-count mismatch, setup-digest mismatch, seat-set mismatch, malformed summary digests, a wrong summary kind and any attempt to smuggle checkpoint data through Game Ready.
- Terminology and protocol are explicit: `preGameSummaryDigest` authenticates bounded verification metadata; the live authoritative state remains inside managed Chromium at revision 0; `checkpointAvailable` is false. This summary is neither a serialized authoritative state nor an M4-recoverable checkpoint.
- `game.me === null` is valid for Game Ready initialization, but inspection of the loaded native Xingbei mode finds legacy functions that directly reference `game.me` (81 references in the tested checkout). Therefore the unadapted full mode/event path is not yet safe to run. The next Playable batch must introduce a server-control compatibility boundary without assigning any human browser as `game.me`.
- Game Ready remains proven; Playable, HALL managed-host routing, full checkpoints and M2+M3 continuity remain unimplemented.
- Evidence: commit `02772de`; local targeted tests passed 9/9 host-session/process tests, 7/7 real-Chromium lifecycle and 4/6/8-seat tests, plus B2 seat-registry. Linux CI run 38355673115 passed.

### M2 batch 10 — first native Playable probe

- An opt-in real-Chromium proof invokes the Xingbei mode's native `game.initSideAndPosition(false)`, obtains the native event from `_status.event`, and executes it through the engine's `game.loop()`/`GameEvent.start()` path.
- The original mode event assigns red/blue sides, selects `_status.firstAct`, updates native Player/DOM identity state and advances authority revision from 0 to 1. Canonical before/after digests must differ; merely setting a boolean cannot satisfy the proof.
- The tested branch uses server-selected `chooseSide:false`, `choose_mode:'normal'`, `team_sequence:'near'` and `phaseswap:false`. This is a narrow compatibility configuration for a deterministic no-choice pre-game event, not a replacement rules implementation.
- Execution is rejected unless `game.me` remains null, every player has no WebSocket, the exact server seat set is preserved, teams are balanced and firstAct names a bound seat. Authenticated progress is reported as `playable_probe`, not full Playable.
- hostSession validates the native event name, state revision, changed digests, complete boolean side map, first-act seat, no-human-host proof and zero transports. Player/admin spoofing, replay and malformed progress fail closed.
- **Proven only:** one native Xingbei state-changing event in managed Chromium. Character choice, deadlines/trustee, turn loop, card/skill effects, victory/result production, HALL routing, M3 continuity and checkpoints remain unimplemented.
- Evidence: commit `5681c04`; local targeted tests passed 10/10 host-session/process tests, 8/8 real-Chromium tests and B2 seat-registry. Linux CI run 38356056414 passed every workflow step, including the new native-event proof.

### M2 batch 11 — authenticated authority-event chain

- Native engine progress now crosses the managed-host boundary as an explicit `native_authority_event_v1`: strictly increasing event sequence, adjacent authority-state revisions, and changed canonical before/after digests. The manager retains the resulting authority digest and rejects stale, duplicate, out-of-order or digest-disconnected events.
- The initial native validator is deliberately event-specific. `initSideAndPosition` must report the exact ordered server seat set, an even red/blue split, a red first actor belonging to that set, no human `game.me`, and zero player transports. Future native events must add their own validator rather than bypassing the common chain.
- `preGameSummaryDigest` remains verification metadata only. It is not the initial authority-state digest; the first authenticated native event establishes the live in-memory chain. Every authority-event proof requires `checkpoint:null`, and `checkpointAvailable` remains false. Neither a pre-game digest nor this event chain is an M4 recoverable checkpoint.
- Result delivery keeps its independent monotonically increasing result sequence, but no longer advances `authorityStateRevision`: only authenticated native state events can mutate the authority version/digest chain.
- This remains one native Playable Probe, not full Playable. No player choice, deadline/trustee, turn loop, card/skill resolution, victory flow, HALL managed-host routing, M3 continuity or M4 recovery is proven.
- Evidence: commit `8b9ae15`; local targeted regressions passed 10/10 host-session/process, 8/8 real-Chromium tests and B2 seat-registry. Linux CI run 38359398796 passed every workflow step.

### M2 batch 12 — initialization-event phase fence

- `initSideAndPosition` is now explicitly a one-time pre-character-selection authority event: its native validator accepts it only while the hostSession is `game_ready`. Once the first event reaches `playable_probe`, a fresh sequence/revision/digest cannot replay the same semantic initialization.
- Regression coverage sends a syntactically fresh second side-assignment proof with the correct prior digest and next sequence, plus disconnected and skipped-sequence variants. All fail closed. A second accepted native event will be added only with the next real native event; this batch does not invent a generic/no-op event merely to simulate a chain.
- The first event still establishes only an in-memory live authority digest. It does not prove a complete initialized-state chain and does not change the separation of pre-game summary, event digest, and M4 checkpoint.
- Evidence: commit `6e3a0a9`; local targeted regressions passed 10/10 host-session/process, 8/8 real-Chromium tests and B2 seat-registry. Linux CI run 38365800591 passed every workflow step.

### M2 batch 13 — presentation-free native character-selection adapter

- The first concrete `game.me` blocker in the native `chooseCharacterOLDuoXuanYi` path is its `broadcastAll` callback that builds each browser's local character-dialog UI from `game.me`. That callback is presentation-only; it is not a Xingbei rule transition.
- The managed Chromium installs a narrowly scoped `v2_server_control_adapter_v1` around this one native event. It suppresses only that local-dialog callback and suppresses the wrapper's duplicate `initSideAndPosition` call because side assignment is already authority event #1. It neither assigns `game.me`, creates a human host, nor replaces Xingbei's event/rules implementation.
- The real native `chooseCharacterOL` event then runs with the original offline trustee branch for all four isolated seats. It initializes four distinct native characters, retains `game.me === null` and zero player transports, and commits authority event #2. Its before digest must exactly equal the side-assignment after digest.
- The server now validates the second event's phase, predecessor event, ordered full seat set, nonempty unique character names, absent human host and absent transports. Tests cover the accepted two-event chain plus broken digest, skipped sequence, malformed seat list, duplicate character and replay rejection.
- This is not the requested human-player choice protocol: no external player operation, choice ID, deadline, stale connection fence or HALL routing exists yet. The exercised trustee fallback is native Xingbei behavior used solely to prove the adapter/event-chain boundary. It is not full Playable or M3/M4 evidence.
- Evidence: commit `a91a52a`; local targeted regressions passed 10/10 host-session/process, 9/9 real-Chromium tests and B2 seat-registry. Linux CI run 38368237702 passed every workflow step.

### M2 batch 14 — Chromium selection CI coverage and adapter contract

- The Linux real-Chromium workflow command now explicitly includes `tests/v2-managed-character-selection.mjs`, alongside Browser Ready, Engine Ready, Game Ready and the first native-event test. The selection proof is no longer local-only evidence.
- `v2_server_control_adapter_v1` no longer identifies the presentation callback by searching function source text. During the bounded `chooseCharacterOLDuoXuanYi` adapter scope, it suppresses exactly the first native `broadcastAll` call, documented by the checked-in native event order as the local-dialog creation. It records consumption and fails post-event validation if that one scoped suppression did not occur. Later broadcast calls retain native behavior.
- This is a fail-closed compatibility contract for the tested source revision, not a general `broadcastAll` policy. Any upstream event-order change must be revalidated before managed character selection can proceed.
- Evidence: commit `d9cb556`; local real-Chromium selection regression passed before the workflow change. Linux CI run 38433165248 succeeded; its `V2 M2 real Chromium off-board lifecycle proof` step completed successfully with the explicit selection-test command.

### M2 batch 15 — managed choice-control protocol foundation

- `game/server-managed-choice-controller.js` is an isolated server-side protocol boundary, not a browser-host path and not HALL routing. A pending choice binds `roomId`, authenticated `hostSessionId`, `seatId`, opaque `choiceId`, native event sequence, exact native-produced option set, deadline and a prevalidated trustee option.
- Seat authentication and active-host validation are injected by the caller so future HALL/B2 integration can reuse its credential and stale-transport fencing rather than inventing a second player identity. The controller additionally binds the current seat connection ID; a superseded connection cannot submit after rebind.
- Only the assigned authenticated seat may submit a permitted option before the deadline. Wrong seat, forged option, wrong sequence, stale connection, invalid credential, duplicate response, expired response and inactive host fail closed. Disconnect/rebind does not delete the pending choice.
- At deadline, only the active managed host can resolve the same pending choice through the already-validated trustee option. This makes the bounded timeout policy testable without claiming that it is already wired into a native event or HALL.
- The CI host-session step now includes `tests/v2-managed-choice-controller.mjs`. Native option extraction, Chromium IPC routing and the real player-choice branch remain the next batch.
- Evidence: commit `a3cd0e0`; local protocol tests passed 3/3. Linux CI run 38433810630 passed every workflow step, including the expanded managed host-session/choice-control step.

### M2 batch 16 — choice-control trust and cleanup hardening

- Choice opening now requires an injected authenticated managed-host/native-event verifier; it binds a native event ID and generates the opaque choice ID internally. Seat connection binding likewise requires a trusted server-side B2/socket-verification callback, so player packets cannot overwrite a seat connection.
- Pending choices have a bounded capacity, automatic deadline timer, single-resolution guard, room/session cleanup and timer cancellation. Player-vs-timeout races resolve once; replay after resolution or cleanup fails closed.
- This remains isolated protocol testing: no Chromium IPC, native option extraction, HALL routing or real player operation is claimed. Evidence pending Linux CI.

### M2 batch 17 — reliable managed-choice delivery

- A resolved choice first enters `delivery_pending` with a stable delivery ID. If the managed-host notification sink throws, the resolution remains inspectable and `retryDelivery` resends the same immutable delivery instead of re-running selection logic.
- Successful delivery transitions once to `resolved`; repeated acknowledgement/retry is rejected. Resolved records are bounded by `maxResolvedChoices` and oldest records are pruned after successful delivery.
- This is outbox semantics inside the isolated controller. Chromium IPC acknowledgement and native event application remain C2 work; no claim of player-operable selection is made. Evidence pending Linux CI.

### M2 batch 18 — ACK-gated managed-choice delivery

- Callback success now means only that a delivery was sent. A choice remains `delivery_pending` until an active matching hostSession acknowledges the exact stable delivery ID; duplicate, wrong-ID and stale-session ACKs fail closed.
- Delivery-pending records consume the same bounded active capacity as pending choices, and native-event/seat uniqueness spans the full lifecycle through acknowledgement. Retry always re-emits the immutable result and delivery ID.
- This establishes the server-side prerequisite for Chromium IPC, but does not itself implement IPC or a native ACK. Evidence pending Linux CI.

### M2 batch 19 — authenticated delivery ACK boundary

- Delivery ACK now requires protocol-v1 `managed_host` identity, exact room, current hostSession, delivery ID and the injected managed-host authentication verifier. Public session or delivery identifiers alone cannot complete a choice.
- Tests reject player/admin kinds, forged verifier material, wrong room, stale session, wrong delivery ID and duplicate ACK before accepting the authenticated current managed host.
- This is still controller-level authentication; C2.1 must wire the verifier to the real supervised-child IPC boundary. Evidence pending Linux CI.

### M2 batch 20 — private managed-host IPC command boundary

- The supervised launcher exposes a parent-to-child command method restricted to `host_choice_delivery` and `host_choice_cancel`; arbitrary child IPC is not exposed to player paths.
- hostSession manager validates the active room/session lifecycle and constructs delivery commands with the private managed-host identity before handing them to the child. Child-to-parent choice messages are accepted only after existing `authenticate()` validation.
- The Chromium child now dispatches explicit bootstrap, stop and choice command types. Unknown messages are inert and cannot invoke bootstrap again.
- Candidate extraction and native application/ACK are intentionally not implemented in this batch. Evidence pending Linux CI.

### M2 batch 21 — native managed-choice closed loop

- The managed Chromium now starts the real Xingbei `chooseCharacterOLDuoXuanYi` event after authority event #1, obtains each seat's native `_characterChoice` candidates, and pauses only its built-in offline trustee timer through the narrowly scoped server-control adapter. It does not create a human `game.me`, player WebSocket, substitute character rules, or synthesize Player state.
- An authenticated supervised-child message supplies the native candidates to the server-side controller. The controller retains the server-generated choice ID, seat/session/event binding, option set and deadline; its immutable result returns under a stable delivery ID. Chromium calls the native event's own `event.sendback`, resumes the original event only after all four results, verifies native Player initialization, then emits an authenticated ACK. The same delivery ID is idempotently ignored after application.
- The four-seat real-Chromium test proves: A's second native option becomes its actual character; B follows the controller deadline trustee path; C survives a connection rebind while its old connection is rejected; D's forged option is rejected before its legal result. Native event #2 follows #1's digest chain with `game.me === null` and no player transports.
- A trusted choice IPC handler exception now fails the managed session closed instead of being swallowed and leaving a native event permanently paused. Evidence: commits `73e7404` and `206f356`; local targeted suites passed 15/15 protocol/process tests and 10/10 real-Chromium tests; Linux CI run 38467551154 passed with the new native-choice test explicitly executed. This is not HALL routing, M3 browser recovery, an M4 checkpoint, full turn/card/skill gameplay, or a real-player acceptance claim.

### M2 batch 22 — native-choice apply acknowledgement fence

- A managed-choice ACK is now delayed until the original `chooseCharacterOL` event has resumed through native step 5 and every final native `Player.name1` matches its immutable controller resolution. A prior `event.sendback` is not treated as application proof.
- The four-seat Chromium test intentionally drops all first ACKs, retries the same stable deliveries, and verifies that Chromium emits repeat ACKs without re-running `sendback` or Player initialization. Its trustee deadline is bounded at three seconds to tolerate CI process scheduling; it is not a browser bootstrap timeout increase.
- A direct `game.gameDraw()` / `Player.phase()` call was investigated but intentionally not accepted: outside the original Xingbei startup event-stack topology its loop does not yield a safe, independently controllable turn boundary. The next M2 work must introduce a constrained native start/phase coordinator modelled on the original event stack, then gate the first `xingDong`/`gongJiOrFaShu` selection before connecting it to the controller. No turn, card, skill, or result authority is claimed yet.
- Evidence: commits `bf115c7` and `1cc0f6f`; Linux CI run 38470185857 passed all workflow steps.

### M2 batch 23 — automatic managed-choice delivery retry

- `managed-choice-controller` now treats an asynchronous managed-host IPC rejection as a delivery-pending condition and schedules a bounded-delay retry of the unchanged immutable delivery. This closes the former integration-path bug where a test callback could catch-and-discard a failed `sendChoiceDelivery` promise.
- ACK, room cleanup and host-session cleanup cancel a scheduled delivery retry. The retry never regenerates a choice, option, native event ID or delivery ID; Chromium's existing duplicate-delivery guard remains the second fence.
- This improves C2 reliability only. It does not make a first native turn safe: the next coordinator must reproduce Xingbei's original start-event stack (`gameStart` → opening draw → phaseLoop) before a real `xingDong` selection can be exposed.

### Next-turn investigation from `b6bf599`

- Preserved the verified four-seat native choice path and its event #1 → #2 authority chain.
- A real local Chrome experiment invoked the original Xingbei `mode.start` function through a new root `GameEvent` after selection. After `root.start()` the CDP target stopped answering Runtime.evaluate, so the process could not verify event stack, gameStart, draw, phaseLoop, or a player-input boundary. The host therefore remained at revision 2 and emitted no accepted event #3. The experimental coordinator was removed from the active path; no draw or phase success is claimed.
- Restored/retained the passing four-seat Chromium choice regression (3 consecutive runs, zero skipped); selected local host/session/controller and Chromium regression tests passed 16/16 with zero skips. This is a local Windows Chrome check only; Linux CI for this investigation is pending and no commit was produced here.
- Exact blocking location inside the native root's asynchronous event execution is still unresolved. Next work must isolate the native stack in bounded steps and surface progress without relying on a CDP evaluation that can be starved by the game event loop. Do not increase test timeout, synthesize a phase, or accept a digest-only state as recovery evidence.
- Status: Browser Ready / Engine Ready / Game Ready / four-seat native choice remain prior verified capabilities; root-event startup, native opening draw, phaseLoop, first legal player action, authority event #3/#4, full playable, HALL routing, M3 and M4 are not complete.

Minimal-difference sequence:

1. Introduce an internal `hostSession` identity and authenticated HALL-to-host channel that cannot be acquired with any player, owner-resume or administrator token.
2. Launch a supervised isolated Chromium/game process per room (or a justified bounded pool), reusing the existing Xingbei engine. Keep M1 room IDs, lifecycle storage and cleanup helpers.
3. Split the protocol into three roles: ordinary player seat, scoped room administrator, and internal managed host. Replace new-protocol `room.owner`/`client.owner` routing with explicit host-session routing while leaving the legacy path version-gated.
4. Make the managed host the only accepted source for authoritative state updates and results. Administrator messages are allowlisted configuration/moderation requests and are rejected once outside their permitted phase.
5. Move pending-choice deadlines and timeout/trustee actions into the managed host. Test launch failure, readiness, isolation, resource ceilings, routing, spoof rejection, process exit and orphan cleanup.

M2 is not complete merely because a server Chromium process starts. It must demonstrate that gameplay continues when the creator/admin browser disappears and that no player/admin packet can impersonate host output.

## M3 — uniform player recovery

Status: not started; blocked on M2.

Minimal-difference sequence after M2 authority routing exists:

1. On create, atomically create the server room, admit A through the same seat-registry path used by B/C/D, and separately issue the scoped administrator capability.
2. Generalize B2 registry eligibility away from `room.owner` to the server room plus active managed-host/session state. Preserve room-scoped secrets, timing-safe checks, stable seat IDs, stale socket fencing and duplicate-message defenses.
3. Use one join/reclaim/reinit state machine for A/B/C/D. Delete no compatibility code until equivalent security regression coverage exists; keep legacy human-host messages version-gated and unreachable from the new protocol.
4. Add explicit admin reconnect/transfer tests that prove admin absence has no gameplay effect and admin commands cannot mutate authoritative engine state.

## M4 — persistence and managed-host recovery

Status: not started; blocked on M2/M3.

Persist lifecycle, authenticated seat bindings, confirmed engine checkpoints and replay identifiers. Prove behavior under host crash, process restart, duplicate submission, event replay, inconsistent checkpoints and unrecoverable state. A restarted process alone is not recovery evidence.

Player disconnect events must never enter this flow. M4 begins only for managed-host/server failure, validates checkpoint identity/integrity and replay position, and either resumes equivalent behavior or fails closed with an explicit unrecoverable state.

## Automatable final-architecture acceptance contract

These are specification tests to add incrementally during M2–M4. They are not claimed as passing today.

| ID | Automated setup and required assertions | Planned milestone |
| --- | --- | --- |
| SA-A01 create-and-seat | A sends only a create request. Assert the server creates the room, launches/binds the managed host, admits A through the ordinary seat path, and issues A a seat credential plus a separate admin capability. Assert A is not `room.owner` and has no host credential. | M2/M3 |
| SA-A02 four-equal-seats | A creates; B/C/D join. Assert four entries share the same player-seat schema, credential rules and command route. Assert creator/admin metadata is outside authoritative player/engine state. | M3 |
| SA-A03 creator-offline-continuity | Give A a pending/ordinary turn boundary, disconnect A, keep B/C/D connected. Assert host PID/session and room identity remain, B/C/D commands advance authoritative state, and A's pending choice follows the configured deadline/trustee outcome. | M2/M3 |
| SA-A04 creator-seat-only-reclaim | Reconnect A with its seat credential. Assert only A's stable seat is reclaimed; host session/PID and authoritative sequence do not rotate or restart; no owner/host-resume message is required. | M3 |
| SA-A05 uniform-player-reclaim | Repeat the same disconnect/reclaim cases for B and C. Assert protocol messages, validation, reinit gates, duplicate takeover and stale-socket behavior are identical to A. | M3 |
| SA-A06 admin-absence-independence | Disconnect A's player and admin transports. Assert host and B/C/D gameplay continue. Reauthenticate admin later and assert this changes no turn/event/state sequence. | M2/M3 |
| SA-A07 admin-authority-denial | With a valid admin capability, attempt authoritative state mutation, rule execution, result declaration and host-session takeover. Assert every attempt is rejected/audited and authoritative digest/sequence is unchanged. | M2 |
| SA-A08 all-players-offline-policy | Disconnect A/B/C/D. Assert the host/room follows explicit server retention, timeout and cleanup policy; no transition is keyed to creator/admin presence. Verify both retained and expired branches with an injected clock. | M2/M3 |
| SA-A09 distinct-failure-domains | In one case disconnect a player; in another kill the managed host. Assert the first uses seat recovery without checkpoint restore, while the second enters the M4 host-failure state and requires validated checkpoint/replay recovery. Cross-use of either recovery protocol must fail closed. | M4 |
| SA-A10 sole-result-authority | Submit conflicting victory/result packets from A/B/C/D/admin and from the authenticated managed host. Assert only the managed-host result with the expected room/session/sequence is committed once; duplicates and stale sessions are rejected. | M2/M4 |

## Evidence ledger

### M2-C3d native startup diagnosis (working batch)

- The real-Chromium opt-in diagnostics distinguish a pending native root promise from CDP failure. The raw native `mode.start` probe remains pending while bounded CDP probes continue to respond; therefore the pending root promise is normal for a live game loop, not by itself evidence of starvation.
- The raw path reproducibly reruns connect-mode `waitForPlayer` → `randomMapOL` → `prepareArena` after the managed four-seat selection is already complete. The original `randomMapOL` path creates another server-side `game.me` and expands the roster to eight. This is a concrete duplicate-initialization incompatibility, not a timeout inference.
- A test-only coordinator probe calls the original root event and keeps the native event topology. It fails closed on duplicate `prepareArena`/`chooseCharacter`, admits the `waitForPlayer` callback only after verifying all four initialized seats and no WebSockets, and narrowly suppresses `randomMapOL` only after the same proof. It then observes one `gameStart`, native opening `gameDraw`, native `phaseLoop`, four native opening hands, and the first `phase` child parented by `phaseLoop`; it pauses at that boundary. `game.me` remains null and there are exactly four seats.
- A second opt-in probe reaches the native first-action event `gongJiOrFaShu` at step 0 under `xingDong`, after the original phase/root stack has advanced. It gates only that exact event before its content runs. The inspected event reports `isMine() === false` and `isOnline() === false`; without the gate `chooseToUse` would take the native offline-AI path. The probe builds a private in-page candidate mapping for the constrained one-physical-card/one-target shape by invoking native `event.filterCard`, `event.filterTarget`, and `lib.filter.targetEnabled`; dynamic target selectors, complex/multitarget shapes, event-level `filterOk`, and custom selection callbacks are excluded (fail closed). These probe IDs are not sent to the controller and are not final opaque IDs. This is candidate-extraction evidence only, not a submitted or applied operation.
- An intentional bounded 700ms JavaScript block yields a CDP command timeout classification. Native exception, Chromium exit, CDP timeout, pending Promise with responsive CDP, and undetermined outcomes are not conflated. Samples use a 128-entry in-page ring and bounded event reporting; no credential/secret fields are emitted.
- C3d diagnosis: demonstrated locally with real Chromium. C3e startup, exact native input gate, and restricted in-page candidate mapping: test-only proofs. Server-issued opaque options, authenticated player/trustee result, native card-use resolution, and authority Events #3/#4: not implemented or verified. Focused local regression was 16/16 and the input-gate Chromium run was 1/1 with zero skips. C3d Linux CI `38518177521`, initial C3e-A gate CI `38534330718`, and candidate-mapping CI `38535370673` succeeded. Full Playable, HALL routing, M3 and M4 remain incomplete.
- Earlier C3e-B boundary: a later-in-content gate was removed after the native flow advanced into `useSkill → discard → lose`. The event-local native input adapter and trusted test-only result/resume proof are now recorded in the separate B1 section below. Controller/player integration remains B2 and is not claimed.
- Final boundary revision `33c964a` passed Linux CI run `38535933067` (including the non-skipped real-Chromium input-gate step). The subsequent documentation records this evidence; no operation result or authority Event #3/#4 is claimed.

### M2-C3e-B1 — same-event native input resume (working batch)

- Replaced the diagnostic-only permanent gate with an opt-in, single-instance `gongJiOrFaShu` adapter. It leaves the original compiled Xingbei `chooseToUse` content and step progression intact; only the exact current event's `isOnline()`/`send()` input transport is adapted. The gate is bounded, revalidates its native event/seat/candidate mapping and native card/target filters, writes `event.result` once, then uses `game.resume()` to continue. It never calls `GameEvent.resume()` as a substitute for unpausing.
- Real Chromium proof: the same `gongJiOrFaShu` event instance progresses from the input wait at step 0 through native result handling to step 6; native `Player.useResult()` runs once and creates `useCard`; the selected physical card is no longer in hand. Trace includes root/child stack and first-actor seat; `game.me` stays null, and no player WebSocket or offline-AI result is used.
- Failure-path proofs in separate opt-in Chromium runs: stale event, wrong seat, invalid option, duplicate post-resolution input are rejected; explicit cancel and the 1.5-second test deadline resolve a negative native result without calling `useResult`; stop while pending reaches hostSession `stopped` and uses supervised Chromium/profile cleanup. The 10-second regular probe deadline is bounded; tests use only the isolated shorter deadline mode.
- Scope/status: C3e-B1 native test-input application/resume proof is demonstrated. It is not ordinary-player authentication or B2 controller integration. Native rule effect is limited to the observed legal card-use path; this is not a complete action/skill matrix. C3e-C authority Event #3/#4 and digest chain remain unimplemented; revision remains 2. No full Playable, HALL routing, M3, M4, deployment, or live/VPS validation is claimed. Local results: focused regressions 16/16; each of the four real-Chromium B1 modes 1/1, zero skips. Linux CI run `38558991381` succeeded across all 31 steps, including all four dedicated B1 real-Chromium modes.

### M2-C3e-B2 — controller-mediated native card action (F1–F4 acceptance completed; historical implementation notes follow)

- The opt-in `managed_input_controller` coordinator mode extends the already-running, original Xingbei startup/phase stack to the first eligible `gongJiOrFaShu` event. It extracts only currently legal one-physical-card/one-target operations using native filters. Browser-cryptographic opaque option IDs map privately to the exact card, target, seat and event object. Candidate IPC carries option IDs only, plus the authenticated host/session/room binding, acting seat, event sequence and deadline. Candidate sets above the controller's 64-option bound and unsupported/no-candidate states fail closed rather than truncate or invent a result.
- The authenticated parent opens the existing managed-choice controller, binds a test seat transport, validates seat/event/sequence/option/current connection and either accepts a simulated ordinary-player selection or waits for controller trustee deadline. The B1 diagnostic resume endpoint refuses a controller-owned gate. Chromium revalidates the original native filters, installs a single immutable native result on the same event and resumes the original `GameEvent`; it does not directly mutate player state or use a custom turn/card rule.
- ACK evidence is after the native result is consumed, `Player.useResult()` count is exactly one, the native `useCard` child completes through the native parent wait boundary, the selected physical card leaves the acting hand, and the event/seat/option remain matched. The controller now automatically resends unacknowledged results with the same delivery and immutable resolution, at most five attempts by default; repeated in-progress delivery is inert, and repeated applied delivery returns an evidence-backed ACK without rerunning the operation. Exhaustion is explicit `delivery_failed`.
- Local Windows Chrome checks: the focused host/session/controller/process and base Chromium suites passed 29/29 with zero skips. Seven separate real-Chromium modes (input gate, B1 resume, timeout, cancel, pending-stop, B2 player choice and B2 trustee choice) each passed 1/1 with zero skips. The native action tests intentionally lose the first action ACK; they assert the controller retry count grows and `useResult` remains one. Four real seats and opening hands are present, but this is a single first-actor action, not a four-seat action/skill matrix. Test credentials are stubs; HALL seat-registry authentication is not connected. Linux CI run `38585618995` succeeded with the two new B2 Chromium steps executed, zero skipped.
- These were the remaining gaps at the prior `38585618995` snapshot. F1–F4 below subsequently added and passed native fault injection, deterministic host/choice races, managed Seat Registry rebind/stale-session acceptance, and final full Linux CI. This completes only the requested B2 failure/identity acceptance; it does not connect the registry to production HALL. Authority Event #3/#4 validators/digests remain unimplemented, revision remains 2, and no checkpoint is available. Full Playable, HALL routing, M3 and M4 remain incomplete.

- Base GitHub CI: run 38301778625 succeeded at `2baf366`.
- M1 plus locally portable V2 regressions: 58/58 Node tests passed; the standalone B2 seat-registry suite also passed.
- PR Linux CI: run 38304099421 `node-recovery-tests` succeeded for M1 implementation plus generated-HALL harness compatibility commits.
- Review-hardening Linux CI: run 38304735974 succeeded for paused admission and server-mode cleanup.
- Current local M1 continuation: 66/66 portable Node tests plus the standalone seat-registry suite passed, including a spawned real HALL process with real loopback WebSockets.
- Owner-recovery Linux CI: run 38305127613 succeeded, including the isolated `ws@8.18.3` real-process test dependency and the actual HALL entry point.
- Generated B2+M1 Linux CI: run 38306224205 passed the dedicated same-process takeover/lifecycle scenario.
- Final PR HEAD before this architecture-only batch: `c0968c4`; Linux CI run 38306324498 succeeded. Portable local regression passed 70/70 Node tests plus the standalone B2 seat-registry test.
- M2 hostSession foundation: commit `d110829`; Linux CI run 38308126401 succeeded, including its dedicated lifecycle/authority-boundary step.
- M2 simulated process and real Chromium foundations: commits `79de3fb` and `cc5adca`; Linux CI runs 38308392018 and 38308610888 succeeded. The latter includes a dedicated real-Chromium off-board lifecycle proof.
- Syntax checks: `game/server.js` and `game/server-room-lifecycle.js` passed `node --check`.
- Production/VPS compatibility: not verified.
- Real browser/player acceptance: not verified.
- Deployment or live service changes: none.

- C3e-B2-D1 follow-up (partial): bounded delivery exhaustion now has an explicit callback, and deterministic controller tests establish single-winner deadline/submission behavior plus terminal failure notification. The remaining native fault matrix will be recorded separately; no operation is considered applied without native evidence.
- C3e-B2-D2: host-session termination now signals the exact room/session once, so a trusted integration can cancel only that session's pending choices and timers. Local tests cover unexpected exit, normal stop, stale prior-session exit and two-room isolation. This is fail-closed cleanup, not checkpoint recovery.

### M2-C3e-B2-D/E current acceptance

- The real-Chromium fault mode reaches the controller-managed child command, reserves its immutable resolution in applying state, then fails before native CDP application. The host is failed/cleaned without replay; this covers the explicitly uncertain-before-apply boundary only.
- The isolated managed-room registry supplies ordinary-player seat credentials (256-bit random, hash-at-rest and timing-safe validation), a current-connection HMAC binding proof, stale-socket fencing and lifecycle APIs. Four issued seats are used in a real Chromium native Xingbei action path; wrong-seat/cross-room/rebound-old-socket operations are rejected while a valid action reaches native `useResult`/`useCard`, with `game.me === null`. This is not formal HALL routing.
- Local: focused 25/25 Node tests; registry-backed Chromium 1/1; uncertain-before-apply Chromium 1/1; no skips. Linux CI pending.
- D2 cleanup and E1 isolated registry/native-action integration are implemented. D1 remains partial pending useResult exception, post-dispatch CDP ambiguity, incomplete child, card-moved-before-ACK, and deterministic ACK/stop/cancel race injection. Choice sequence 4 is not an accepted authority sequence; authority revision is still 2 / next sequence 3. No Event #3/#4, Full Playable, HALL, M3, M4 or deployment is claimed.
- Linux CI run `38612443913` passed 21/21 focused controller/process tests; the grouped Chromium step reported 3 startup-timeout failures among 10 tests (7 passed, 0 skipped). The log points to concurrent Chromium test-file launches. The grouped CI command is now serialized instead of masking this with a longer timeout; final Linux result is pending.
- Serialized Linux CI `38612804264` succeeded, including the native seat-registry and fail-closed Chromium steps. The failing earlier run `38612596028` also identified cross-event IPC misrouting: a retried character-choice delivery arriving after action-gate creation was dispatched as an action because only gate presence was checked. Dispatch is now fenced by matching `nativeEventId`; post-fix local evidence is 25/25 focused Node tests and 10/10 serialized real-Chromium tests, plus 3/3 consecutive fault-injection runs, all with zero skips. Linux CI `38613341082` for the source correction succeeded: all 36 workflow steps passed, including real Chromium seat-registry and fail-closed action-injection tests.

### M2-C3e-B2-F1 — native action fault-injection matrix

- Added six isolated real-Chromium controller-path scenarios: exception before native `event.result` assignment; dispatched CDP command with an intentionally unknown/lost result acknowledgement; `Player.useResult()` exception; native `useCard` child settlement exception; same-delivery retry while the action is applying; and stale native-event delivery after completion. The CDP case models post-dispatch ambiguity after Chromium accepts/resumes the event; it is not represented as a real transport timeout.
- The `useCard` fault is injected only after the original child `GameEvent.start()` resolves, at the child-to-parent settlement boundary. Evidence includes native `useResult` count 1, exactly one matching native useCard history entry, the selected physical card no longer in hand, zero ACKs, unchanged authority revision 2, and supervised host cleanup. No uncertain result is replayed.
- Failure scenarios assert no ACK for uncertain work, at most one `useResult`, pending controller-choice cleanup, revision remains 2, and child/profile resources are cleaned. Applying-delivery replay is tested independently; post-apply ACK-loss retry returns an evidence-backed ACK without another native application. The host remains `game.me === null` with four native players.
- Local verification: six real-Chromium fault/retry modes passed 6/6 with zero skips; focused host-session/controller/process/seat-registry suites passed 25/25 with zero skips. Initial probing exposed that a `GameEvent.loop` step assumption did not reach the child failure point; the test now injects after the actual child settlement and asserts observed child/history/card state.
- Linux CI run `38634585841` succeeded for F1 at commit `919873b`; all 39 workflow steps completed, including six dedicated real-Chromium fault/retry steps, with no skipped steps. F2–F4 results are recorded below. Controller `eventSequence: 4` is not an authority Event #4; authority revision remains 2. Full Playable, HALL routing, M3 and M4 remain incomplete.

### M2-C3e-B2-F2 — deterministic host/choice race barriers

- Added Promise-barrier controller/lifecycle tests for player-versus-deadline single-winner resolution, stopping while one native choice remains pending and another delivery is blocked, rejection of an ACK after its generating hostSession terminates, and delayed old-session messages after replacement while a second room remains active. They assert exact-session cleanup, immutable winner, stale ACK rejection and no deadline/retry timer after cleanup.
- Added a true Chromium cancel/resume race through the supervised command queue: cancellation wins once, native resume count is exactly one, `useResult` remains zero, and the later resume command is rejected. Added a real-Chromium barrier after authenticated action-delivery reservation but before native `useResult`; supervised stop terminates the session, clears choices, yields no ACK, and leaves authority revision 2.
- Local: deterministic race suite 4/4; real-Chromium cancel/resume and delivery/stop barriers 2/2; zero skips. Linux CI `38635452534` succeeded at `a9e1a63`; job `node-recovery-tests` completed 45/45 workflow steps with no failures, including both Chromium barriers and managed Seat Registry regression. Existing `onSessionEnd` exactly-once, two-room host failure isolation and delivery-retry-exhaustion fail-closed tests remain in the regression set.
- At the F2 commit, F3 and F4 were still outstanding; their completion evidence is recorded below. No production HALL routing, authority Event #3/#4, Full Playable, M3, M4 or deployment is claimed.

### M2-C3e-B2-F3 — Seat Registry identity and native-operation acceptance

- Expanded managed registry/controller acceptance for four isolated credentials, wrong room/seat, missing/forged credentials, administrator socket impersonation, old/new socket fencing, disconnect/rebind while the same choice is pending, credential revocation, stale hostSession submission/ACK, and replacement-session isolation. No legacy `seat-registry.js` or `room.owner` path was changed.
- Real Chromium registry mode now performs disconnect/rebind while the native action choice is open. It rejects administrator/forged binding, old socket and stale hostSession command, accepts the valid replacement connection against the same pending native choice, confirms player disconnect did not change managed-host PID/session/state, and checks stale-session ACK rejection before the valid authenticated ACK. Native Xingbei action handling, four ordinary seats and `game.me === null` remain unchanged.
- Local: Node managed-registry and deterministic choice-race tests 7/7 passed, zero skips; modified Chromium integration source passed syntax/whitespace validation. No Chromium binary is installed in this Windows workspace; the true Chromium integration is registered in Linux CI and not claimed as locally executed.
- Linux CI `38635998792` succeeded at `891d3d9`; the complete job passed, including true Chromium F3 disconnect/rebind + stale-session action path, managed registry credential/session isolation, and existing guest-seat registry regression. F4 final validation is recorded below. Keep controller `eventSequence: 4` distinct from authority Event #4; authority revision remains 2. No true authority Event #3/#4, Full Playable, HALL routing, M3, M4 or production deployment is claimed.

### M2-C3e-B2-F4 — final serialized Linux regression (complete)

- Final acceptance reruns the complete serialized V2 security/recovery + managed Chromium suite, including F1 native fault boundaries, F2 deterministic host/choice races, and F3 Seat Registry native-action rebind/stale-session coverage. A final additional real-Chromium registry-backed native action repeat runs after all other steps to check serial cleanup/resource stability; no test is removed, skipped, or made to pass by increasing timeouts.
- F3's full Linux workflow `38635998792` passed all 45 workflow steps. Job-log TAP summaries show 146 tests passed, 0 failed, 0 skipped across 37 TAP summaries, including real Chromium and registry/guest-seat cases.
- Final code/workflow commit `1c41a69` passed Linux CI run `38636678075` (complete job success). All 46 workflow steps completed; 38 TAP summaries recorded 147/147 pass, 0 fail, 0 skipped. The additional final real-Chromium Seat Registry native-action repeat passed 1/1 with zero skips. The requested B2 F1–F4 acceptance is complete. PR #1 remains open/unmerged. Authority revision remains 2; controller `eventSequence: 4` is not an authority Event #4. Full Playable, authority Event #3/#4, HALL routing, M3 and M4 remain incomplete. No production systems have been changed or deployed.

### M2-C3e-C1 — native opening draw Event #3 (accepted; Linux CI 38646873399)

- Architecture remains server-owned managed Chromium. The M2 core is ultimately intended for a separate V3-based integration; current V2 naming is R&D history, formal V2 remains independent, and PR #1 must not be merged into its V2 base.
- C1 starts the actual XingBei `mode.start` root only after accepted native Events #1/#2, with fail-closed checks for the completed four-seat roster, sides, characters, first actor and `game.me === null`. Scoped adapters only satisfy already-completed wait-for-players / arena / side / character setup and leave native `gameStart` and `gameDraw` intact.
- The native `gameDraw` child must complete under the original `game` root before a proof is formed. The original `phaseLoop` child is created under that root and paused before it starts, allowing Event #3 to be committed before any first-turn decision. This is not an isolated draw call or replacement phase loop.
- Event-specific validation checks exact seat order/position, Event #2 characters/sides, first actor, one `gameStart`, completed draw, four-card initial hands, host/player transport absence, parent topology and a SHA-256 commitment per hidden hand. Raw hand values are kept out of the server proof; the server recomputes the canonical public-summary digest and verifies the predecessor digest.
- A supervised, private, identity-bound acknowledgement releases the Event #3 coordinator only after the authority manager accepts sequence 3 / revision 3 / the exact digest. Rejection or delivery failure stops the managed host. Tests cover malformed topology/state, hand count/seat/digest tampering, predecessor/sequence/revision errors and duplicate semantic draw.
- A real-CI readiness rejection exposed that the managed page still had local revision 1 after the server accepted Event #2. The manager now returns a private session-bound Event #2 ACK; only after that verified ACK does the page move to revision 2 and fail-closed verify all four native characters/sides before creating the mode root. Event #3 remains separately ACK-gated. This fixes state synchronization rather than manufacturing a revision or digest.
- Linux CI `38646873399` succeeded. The dedicated C1 real Chromium case ran three serial times (3/3 pass, 0 skipped); the prior real-Chromium suite passed 10/10 with zero skips; full Linux workflow passed. Each run proves the original root triggers `gameStart` once, the native `gameDraw` child completes and produces four opening cards per seat, then the native `phaseLoop.start()` is reached and held at a one-shot gate. Event #3 is accepted at sequence 3/revision 3 with exact Event #2 predecessor digest; hidden hand values remain outside the server proof. C1 is **accepted**. Commits: `ff3ed82`, `c458779`, `e2952b6`, `58bcdd7`, `ad4fb39`. C2-1 is active; Event #4 is not submitted. This summary is not a restorable M4 checkpoint.
- Local (Windows): 30/30 focused host-session/controller/process/seat-registry/race tests passed before adding explicit launcher coverage for sequence-2 ACKs; rerun is pending. No local Chromium binary is available, so no local real-browser result is claimed. Authority summary is not a restorable M4 checkpoint.
- C2-1 is **accepted**. Reuse the existing Event-#3-accepted `mode.start` root, validate the one-shot pending phaseLoop gate and root identity, install the existing native-input/controller adapter, then release that gate exactly once. The privileged mode is emitted only after the server authority tip is exactly sequence 3 / revision 3 / `gameDraw`; the child rechecks root identity, parentage, requested-but-not-started phaseLoop, four initialized disconnected seats and absent human `game.me`.
- Linux CI `38688508842` succeeded across all 48 workflow steps. The dedicated real-Chromium C2-1 case passed 1/1 with zero skips. The event stack at input gate was `game → phaseLoop → phase → xingDong → gongJiOrFaShu`; a controller-backed native `gongJiOrFaShu` card choice completed its original `useResult`/`useCard` path and moved one physical card from the acting seat's hand. `game.me === null`; authority remains revision 3 / next sequence 4. C2-1 deliberately did not submit Event #4.
- Initial CI `38688282853` exposed an assertion-data issue: the compact poll snapshot omitted `phaseLoop.parentName`, although the native event had reached the required stack. The corrected test reads parentage from the full native input-gate ring snapshot and reports actual `phaseLoop.parent`; `38688508842` then passed. No timeout was relaxed. Commits: `13237ff`, `3fe6bf4`.

### M2-C3e-C2-2 — native Xingbei card action authority Event #4 (accepted; Linux CI 38690413465)

- Event #3's accepted canonical state summary is now retained in the host-session authority context. Event #4 presents the full same summary; the server recomputes its canonical digest instead of trusting a copied digest string.
- `xingbei_native_card_action_v1` has a dedicated validator for sequence 4, revision 3→4, predecessor digest/summary, actual acting seat/target/card/opaque option, completed native `useResult → useCard`, native child completion and parent wait, seat continuity and bounded hand commitments/counts. The supported native card destination is validated as `d` or `x`; raw hidden-hand values are never sent to the authority server. Duplicate, stale, malformed, skipped and disconnected/human-host proofs fail closed.
- The original C1 `mode.start` root resumes only after accepted Event #3. Its native phase stack reaches `game → phaseLoop → phase → xingDong → gongJiOrFaShu`. A controller delivery is applied through the native event; after the actual `useCard` child completes, Chromium submits Event #4. Only the managed host's authenticated authority ACK advances local revision to 4 and permits the choice ACK. Retry uses the same delivery and leaves `useResult` at one execution.
- Local Windows real-Chromium test passed 1/1, zero skipped; the full four-seat path reached authority revision 4 / next sequence 5 and verified Event #4 `beforeDigest` equals Event #3 `afterDigest`. Node manager/controller/process tests passed 23/23; authority-manager tests passed 10/10; `node --check` and `git diff --check` passed. Linux CI `38690413465` succeeded, including the dedicated Event #4 real-Chromium test and full workflow.
- C2-1 and C2-2 are accepted. C2-3 fault-safety/retry/isolation acceptance remains pending at this checkpoint. Full Playable, formal HALL managed-host routing, M3 recovery and M4 checkpoints remain incomplete; this state summary is not a restorable checkpoint. M2's final target is a future isolated V3 branch; formal V2 stays independent, and PR #1 stays open/unmerged.

### M2-C3e-C2-3 — Event #3/#4 fault safety (accepted; Linux CI 38694044873)

- Event #4 exact proof replay is accepted idempotently only for the current authenticated host/session and the already accepted digest; the authority chain remains length four at revision 4. Changed proofs, stale sessions, player packets and administrator packets are rejected. The supervised host retries the same immutable proof with a bounded retry budget and advances local revision/choice ACK only after an exact authenticated event sequence 4 / revision 4 / digest ACK.
- Native action delivery retransmission while authority confirmation is pending now joins the in-flight commit Promise. It does not repeat the native action. Failure of that Promise remains fail-closed; authority acceptance and native application are separate states.
- True Windows Chrome cases cover normal Event #4, Event #3 proof rejection, Event #3 accepted then host stop before phase-loop release, Event #4 authority ACK loss/idempotent resend, trustee deadline, native `useResult` failure, and native `useCard` child failure. Linux runs `38692563137` and `38693151077` exposed fixed-delay ACK and diagnostic-completion races. The ACK-loss case now uses a Promise barrier released only after a controller retry joins the in-flight authority commit; the root probe waits for the actual `gongJiOrFaShu` gate rather than stopping at `phaseLoopCreated`; native fault assertions do not depend on a competing CDP probe finishing before host teardown. The focused ACK-loss case passed three consecutive local Chrome runs, and the gate and exception cases pass locally. The Event #3 rejection proof records the original root's paused `phaseLoop`; native failures keep authority at Event #3/revision 3 and clean pending choice/process. The manager/controller/process/managed-seat/race regression set passes 30/30, zero skipped; syntax and whitespace checks pass.
- Test debugging exposed and fixed a harness omission: after intentionally dropping the first managed-choice ACK, the test replayed the four character deliveries but not the native-action delivery, so its wait could expire despite the authority event being accepted. It now explicitly retries that same choice delivery and reports all choice/host states on timeout. A separate failure-path assertion now waits for host failure at revision 3 rather than incorrectly waiting for revision 4.
- Previous C2-2 Linux baseline is green at `38690413465`; initial C2-3 Linux CI `38691963640` and deterministic-correction run `38694044873` succeeded. The latter completed all 52 workflow steps; its 49 TAP summaries total 158 passed, 0 failed, 0 skipped, including true Chromium Event #3/#4, ACK-loss retry, fault, trustee, race and Seat Registry scenarios. C2-3 is accepted. Full Playable, formal HALL routing, M3 and M4 remain incomplete; formal V2 remains isolated, M2 targets a future dedicated V3 integration branch, PR #1 remains open/unmerged, and no production systems were changed.

### M2-C3e-C3-A — complete authority-chain audit (partial; same-root gate not met)

- Added a dedicated real-Chromium CI audit for all four authority proofs in one host run: sequences/revisions 1–4, adjacent digest equality, one room/session, one Chromium PID, final server digest tip, no checkpoint claim, and no host secret/seat credential/hand commitment in public session inspection or diagnostics.
- Local Windows Chrome passed the strengthened audit 1/1, 0 skipped. Revision reached 4 and next event sequence 5; server tip matched Event #4. The choice was applied once and the managed host retained its Chromium process for the duration of the game.
- **Important topology finding: C3-A is not accepted.** `game/v2-managed-chromium-host.mjs` calls `game.loop()` directly for `initSideAndPosition` (Event #1) and later for `chooseCharacterOL` (Event #2), with no `mode.start` parent active. `runManagedOpeningDraw()` subsequently creates a fresh `game` root from `managed.mode.start`; only Event #3 `gameDraw`, `phaseLoop`, and Event #4 action are descendants of that root. These are not one original native root, despite sharing a Chromium/game instance and authority chain. The current C3 CI audit proves the latter properties but does not assert root identity; its green result must not be interpreted as satisfying same-root acceptance.
- Correcting this requires reworking the managed initialization coordinator around the actual Xingbei `mode.start` lifecycle while preserving `waitForPlayer`, arena preparation, `randomMapOL`, side assignment and native character selection exactly once. Do not paper over the mismatch by rewriting `event.step`, changing parent links after execution, or adding a broad skip adapter. C3-A remains incomplete pending a safe root-topology solution; no C3 completion is claimed.
- Linux CI `38696521356` passed at `90094dd`; all 56 workflow steps succeeded, with 50 TAP summaries (159/159 passed, 0 failed, 0 skipped). Its new chain audit passed same-session/PID/digest/exposure assertions but did not assert the unsatisfied root identity condition.

### M2-C3e-C3-B — authority-chain and private-data exposure regressions (corrective Linux CI pending)

- Tests now enforce the host manager's public projection boundary after Event #4: no host secret or player credential fields, no hand commitment keys/values, and authority-chain entries limited to event sequence and digests. This avoids treating a hand commitment as public merely because it is a hash.
- The real-Chromium audit also checks player-choice delivery and sanitized diagnostic JSON for host secrets, seat credentials, commitments, and full hidden-hand properties. The existing security matrix remains in place for duplicate/semantic replay, skip/out-of-order/revision/digest rejection, stale-session submissions/ACKs, player/admin impersonation, exact Event #4 retry, failure cleanup and room isolation.
- Local verification: 30/30 host-session/controller/launcher/race/managed-seat tests; host-session focused suite 10/10; real Windows Chrome complete authority-chain/disclosure case 1/1; all zero skips. Linux CI for the new dedicated C3-B steps is pending.
- C3-B does not close the same-native-root gap. C3 remains incomplete until root continuity is actually implemented and proven; Full Playable, HALL routing, M3, M4 and production deployment remain separate/unclaimed.
- The first C3-B run `38697129542` failed in the existing Event #4 trustee Chromium regression after the server had accepted Event #4. Evidence showed one native `useResult`/`useCard`, a duplicate-delivery proof, and a later host stop after choice-delivery retries exhausted. The controller now serializes each async IPC send, lets concurrent manual retry join the active send, replaces any scheduled retry timer when retry is explicit, and clears the in-flight marker on ACK or exact-session cleanup. A Promise-barrier controller regression verifies this ordering. Local controller suite: 11/11; trustee Chromium: focused post-fix pass plus eight consecutive pre-fix repetitions. Safe timeout diagnostics now include ACK outcome/state without secrets. Linux CI for this correction is pending; no timeout or validation was relaxed.
