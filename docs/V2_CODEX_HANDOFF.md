# V2 Codex engineering handoff

## Normative final target

The final V2 server-authority design completely removes the human-host role. The creator is an ordinary player seat with a separate, scoped room-administrator capability. Only an authenticated server-managed game process may execute rules or commit authoritative state/results. Creator/admin disconnect is an ordinary player/control-plane event; managed-host failure is a separate M4 checkpoint-recovery event.

Do not extend `room.owner`, `client.owner`, `ownerResumeToken`, `resumeowner`, `awaiting_host`, or `waiting_host_process` into M2/M3. They are tested M1 compatibility mechanisms for the current human-hosted engine and may remain version-gated while the new path is built.

Current classification at PR #1 HEAD `c0968c40ae22d808f283cec7cca53613e7b7e9d5`:

- **Already aligned/reusable:** server room record and bounded lifecycle cleanup; B2 cryptographic room-scoped seat credentials; stable seat identity; stale socket, duplicate takeover and replay defenses; existing V2-1–V2-9 security regressions.
- **Transitional architecture only:** creator stored as `room.owner`; guest `client.owner` routing; browser-generated engine output; owner resume token and host pause/resume states; B2 eligibility coupled to a live human owner.
- **Not implemented:** creator auto-admission as an ordinary seat, separately scoped administrator authorization, managed-host sole authority, browser-independent choice deadlines/game progression, uniform A/B/C/D recovery on the new route, and M4 validated host checkpoint recovery.

The normative requirements, minimal-difference M2/M3 sequence and automatable acceptance IDs `SA-A01` through `SA-A10` live in `docs/V2_SERVER_AUTHORITY_PLAN.md`. No M2 implementation was started by this specification-correction batch.

## M2 batch 1 handoff

- Commit `d110829` adds `game/server-host-session-manager.js` plus deterministic simulated-process tests. It establishes an internal host-only bootstrap/attestation secret, lifecycle and result sequence boundary without changing the legacy HALL path. Linux CI run 38308126401 passed its dedicated host-session step.
- Player and administrator credential kinds cannot attest readiness or commit an authoritative result. Old sessions, duplicate results and out-of-order sequences are rejected.
- Startup, ready, requested stop, launch failure, ready timeout and abnormal exit are covered. Local portable regression passed 75/75 Node tests plus the standalone B2 seat-registry suite.
- V3 Chromium worker/coordinator code was inspected read-only. Its isolated profile, loopback CDP, sandbox gate, timeout, process inspection and cleanup patterns are candidates for a later V2 launcher adapter; no V3 file was changed or imported into production V2.
- **Completed only:** M2 hostSession identity/lifecycle simulation foundation.
- **Not completed:** HALL integration, real Chromium launch, Xingbei engine initialization, player/admin protocol, four-player continuity, pending-choice policy, authoritative state progression, M3 uniform recovery, M4 persistence or real-browser acceptance.

M2 batch 2:

- Commit `79de3fb` adds a real child-process launcher and simulated managed-host executable. Bootstrap secrets travel over IPC only and are verified absent from child argv/environment.
- The manager consumes child readiness/results through the same authentication boundary; normal stop and room-isolated abnormal exit are tested.
- Linux CI run 38308392018 passed. Portable local regression passed 77/77 plus the B2 seat-registry suite.
- This remains simulated-host evidence, not Chromium or game-engine authority evidence.

M2 batch 3:

- Commit `cc5adca` adds the V2-owned real Chromium supervisor and an opt-in real-browser test. It uses an isolated profile, loopback-only ephemeral CDP, startup validation, sandbox fail-closed policy and cleanup on stop.
- Linux CI run 38308610888 passed the dedicated real-Chromium step. Local Chrome regression brought the portable total to 78/78 plus B2 seat-registry.
- Chromium readiness currently proves only browser/CDP liveness. Noname/Xingbei modules, engine initialization, HALL routing and authoritative gameplay are not connected.
- M2+M3 four-player disconnect/continuation acceptance remains entirely unproven and must be tracked separately from these infrastructure passes.

M2 batch 4:

- hostSession now separates `browser_ready` from `engine_ready`; each phase has its own authenticated message, timeout and failure code.
- Only `engine_ready` may submit ordered authoritative results. Real Chromium currently stops at Browser Ready by design; only the simulated engine fixture reaches Engine Ready.
- Status remains: Browser Ready **proven**; Engine Ready **gate implemented but real engine not proven**; Game Ready **not implemented**; Playable **not implemented**; M2+M3 four-player integration **not implemented**.
- Evidence: commit `b943f47`; Linux CI run 38310628904 succeeded.

M2 batch 5:

- The parent launcher now tracks an authenticated Chromium process-group/profile registration and performs cleanup even when the Node supervisor is forcibly killed.
- Real-browser tests cover normal shutdown, startup failure, supervisor kill, Chromium kill, resource residue and cross-room isolation. Sandbox restrictions are unchanged.
- Local full regression passed 81/81 plus B2 seat-registry and left no `v2-managed-host-*` profile behind.
- Evidence: commit `0ec5dc1`; Linux CI run 38311258383 succeeded.
- Completion status is unchanged above Browser Ready; no real engine initialization or gameplay claim is made.

M2 batch 6:

- Real off-board Chromium now reaches Engine Ready only after importing the actual Noname and Xingbei modules from a loopback test origin and verifying the required native APIs.
- The proof deliberately reports `gameLoopStarted:false`; it creates no match state and sends no result. Game Ready, Playable and M2+M3 continuity remain unimplemented.
- Local full regression passed 82/82 plus B2 seat-registry with no managed profile residue. Commit `8e7c7d3`; Linux CI run 38311479712 passed all `node-recovery-tests` steps, including the real-Chromium lifecycle/engine-init step.

M2 batch 7:

- A separate `game_ready` hostSession state now gates authoritative results; Engine Ready alone is deliberately insufficient.
- Launch requires a validated server-supplied Xingbei setup with ordered unique seat bindings. Game Ready attestation must match its canonical setup digest, ordered seat IDs and a valid pre-game verification-summary digest, and has its own bounded timeout.
- Simulated and supervised-process tests exercise the gate, invalid setup, mismatched proof, timeout, stale session, role spoofing and result sequencing. These fixtures are security/lifecycle evidence only.
- Real Chromium Game Ready, Playable engine execution, HALL routing and M2+M3 four-player continuity remain unimplemented and separately tracked.
- Evidence: commit `7805bf2`; Linux CI run 38353870134 succeeded.

M2 batch 8:

- Real managed Chromium now uses native Noname boot/loading functions, loads the Xingbei mode and card/character definitions, creates the arena with `game.prepareArena`, and binds the exact server-supplied ordered seats to native Player instances.
- Game Ready fails closed unless mode/configuration, player positions, loaded card data, absence of a host player (`game.me === null`) and absence of player WebSocket bindings are verified. hostSession retains only the canonical pre-game verification-summary digest.
- No event loop, player choice, turn, skill execution or victory/result path runs yet. Status is now: Browser Ready **proven**; Engine Ready **proven**; Game Ready **proven for the validated native pre-game state**; Playable **not implemented**; HALL routing and M2+M3 four-player continuity **not implemented**.
- Evidence: commit `0267880`; local targeted tests passed 9/9 host-session/process tests, 5/5 real-Chromium tests and B2 seat-registry. Linux CI run 38354781202 passed all steps, including real-Chromium Game Ready.

M2 batch 9:

- Real Chromium Game Ready now covers 4/6/8 native seats. Invalid duplicate/wrong-position seats, room-count mismatch, malformed/mismatched summaries and checkpoint masquerading fail closed.
- `preGameSummaryDigest` is verification metadata only. The live authority is still process memory at revision 0 and `checkpointAvailable:false`; no restorable checkpoint exists.
- Native Xingbei inspection reports 81 direct `game.me` references across mode functions. Keeping `game.me === null` proves there is no human host, but also blocks an unadapted full mode start. A later server-control adapter must address those local-perspective assumptions without turning a human player into the host.
- Playable, choices/deadlines, HALL routing, M3 continuity and M4 recovery remain separately unimplemented.
- Evidence: commit `02772de`; local targeted tests passed 9/9 host-session/process tests, 7/7 real-Chromium lifecycle and seat-count tests, plus B2 seat-registry. Linux CI run 38355673115 passed.

M2 batch 10:

- Real managed Chromium now executes one original Xingbei `initSideAndPosition` GameEvent through native `game.loop()`. It changes the bound Player side map, sets native `_status.firstAct` and advances in-memory authority revision 0→1.
- The adapter must read the created event from `_status.event` because the legacy Xingbei helper does not return it. The no-choice/non-phaseswap configuration avoids the known `game.me`-dependent branches while keeping `game.me === null` and all player WebSockets absent.
- hostSession calls this state `playable_probe`; before/after digests, exact sides, first-act seat and no-human-host properties are authenticated and replay-protected. It is not full Playable.
- Still missing: character/player choices, explicit deadlines and trustee actions, turns, card/skill resolution, victory/results, HALL routing, four-player disconnect continuity and M4 checkpoints.
- Evidence: commit `5681c04`; local targeted tests passed 10/10 host-session/process tests, 8/8 real-Chromium tests and B2 seat-registry. Linux CI run 38356056414 passed, including the real native-event step.

M2 batch 11:

- The managed-host protocol now records native state movement as an authenticated authority-event chain. `eventSequence`, `stateRevisionBefore`, `stateRevisionAfter`, and canonical before/after digests must be adjacent to the server-held live state; replay, stale sequence, digest divergence and malformed proofs fail closed.
- The first registered event remains the real Xingbei `initSideAndPosition` event. Its validator independently checks complete ordered seats, equal red/blue teams, a legal red `_status.firstAct`, `game.me === null`, and zero player transports. It is extensible only by adding further event-specific validators.
- `preGameSummaryDigest`, authority-event digests and `checkpoint` have separate meanings. The first is bounded setup verification, the second is live in-memory continuity evidence, and the third remains absent (`checkpoint:null`/`checkpointAvailable:false`). No M4 recovery claim follows.
- An authoritative-result delivery receipt does not increment the native authority-state revision; it has its own duplicate-protected result sequence. This prevents result transport from silently breaking the native event chain.
- Evidence: commit `8b9ae15`; local targeted regressions passed 10/10 host-session/process, 8/8 real-Chromium tests and B2 seat-registry. Linux CI run 38359398796 passed every workflow step. No HALL routing, choice flow, M3 continuity or M4 checkpoint work was begun in this batch.

M2 batch 12:

- `initSideAndPosition` has an explicit `game_ready` phase fence. It cannot be accepted again in `playable_probe`, even with a new sequence, adjacent revisions and the correct prior digest.
- The rejection suite covers replayed semantic initialization, digest discontinuity and sequence skipping. It intentionally does not manufacture an unrelated accepted event: a two-event accepted chain requires the next real native Xingbei event.
- The initial event digest remains transient in-memory authority evidence, not a complete state chain or checkpoint. Evidence: commit `6e3a0a9`; Linux CI run 38365800591 passed every workflow step.

M2 batch 13:

- Native `chooseCharacterOLDuoXuanYi` first fails without a local perspective at its `broadcastAll` character-dialog callback, which reads `game.me` for browser UI only. The managed adapter suppresses precisely that presentation callback and the wrapper's duplicate side-assignment invocation; it never assigns a player to `game.me`.
- The original native event runs its offline trustee route for the isolated four-seat test, assigns four distinct characters and commits authority event #2 only when event #1's after digest is its exact before digest. The manager validates predecessor phase, ordered seat map, unique names, no human host and no transports.
- This proves a two-event native chain and a minimal server-control compatibility boundary. It does not accept human player selections yet: choice identifiers, seat credentials, deadlines, stale transport rejection and HALL routing remain next work. It is not full Playable, M3 or M4 evidence.
- Evidence: commit `a91a52a`; local targeted regressions passed 10/10 host-session/process, 9/9 real-Chromium tests and B2 seat-registry. Linux CI run 38368237702 passed every workflow step.

M2 batch 14:

- `tests/v2-managed-character-selection.mjs` is now named in the Linux real-Chromium CI command; successful workflow evidence must include the actual native selection test rather than only adjacent Chromium tests.
- The server-control adapter no longer searches callback function text. Its native-selection scope consumes exactly the first `broadcastAll` as the documented local-dialog call and verifies that consumption; any changed ordering requires a new explicit adapter review.
- Evidence: commit `d9cb556`; Linux CI run 38433165248 succeeded, including the completed `V2 M2 real Chromium off-board lifecycle proof` step whose command explicitly names the selection test.

M2 batch 15:

- Added a server-side managed-choice controller for an eventual managed-host route. Each choice binds room, hostSession, seat, opaque choice ID, authority event sequence, exact allowed options, deadline and trustee option.
- Current authenticated seat connection, credential/seat identity, active host session, option membership and deadline are all required. Rebinding rejects the prior connection without discarding the pending choice; expiry yields only the configured valid trustee option.
- This is protocol and security evidence only. It is not connected to HALL or Chromium yet and therefore cannot be described as a real player selection. Evidence: commit `a3cd0e0`; Linux CI run 38433810630 passed every workflow step, including its 3-test suite.

M2 batch 16: trusted host/native-event opening, verified server-only seat binding, generated choice IDs, deadline timers, one-shot resolution, capacity and room/session cleanup are now covered by isolated tests. Chromium IPC and real player operations remain unimplemented; Linux CI evidence is pending.

M2 batch 17: choice resolution now has an in-memory outbox state. A failed sink leaves `delivery_pending` with a stable delivery ID; retry delivers the same result once without recalculating the choice. Successfully delivered records have bounded retention. Chromium IPC acknowledgement remains unimplemented; Linux CI evidence is pending.

M2 batch 19: ACKs now require managed-host protocol identity plus the injected host verifier, exact room/session and delivery ID. Player/admin/forged/wrong-room/stale-session ACKs are rejected. Real supervised IPC integration remains next.

M2 batch 21: the first real native managed-choice loop is implemented and covered by `tests/v2-managed-native-choice-ipc.mjs`. A supervised Chromium process extracts real Xingbei `chooseCharacterOLDuoXuanYi` candidates, opens four server-controller choices, accepts an authenticated player result and deadline trustee result, protects a rebinding seat from its old connection, rejects an invalid option, delivers immutable results through private IPC, applies them using native `event.sendback`, and acknowledges only after native Player initialization. The test keeps `game.me === null`, creates no player transports, and validates authority event #2 after #1. Commits `73e7404`/`206f356`; Linux CI run 38467551154 passed. This does not establish HALL routing, M3 four-real-player recovery, M4 persistence, or full playable turns/cards/skills.

M2 batch 22: ACK timing is now fenced behind the completed native selection event and final Player-role comparison. The Chromium integration deliberately loses the first ACKs, retries the identical deliveries, and proves repeat delivery does not apply a role twice. Linux CI run 38470185857 passed. Investigation of the first native turn confirmed that a direct standalone draw/phase call is not a valid substitute for Xingbei's original startup event-stack topology; it is recorded as a required constrained coordinator rather than being committed as a hanging or fake turn probe. Turn actions, cards, skills, HALL routing, M3 recovery, and M4 persistence remain unverified.

M2 batch 23: asynchronous `sendChoiceDelivery` failure is now retained and automatically retried with the same immutable delivery rather than relying on a test manually calling `retryDelivery`. ACK/room/session cleanup cancels queued retry timers. This closes a C2 transport-reliability gap but does not change the outstanding requirement for an original Xingbei start-event/phase-loop coordinator before any real turn action is claimed.

M2 next-turn investigation from `b6bf5996d858609a6d8cc4e5c550404aa8c43eec`: the four-seat native choice IPC test passed locally in real Chrome with all four deliveries ACK-gated, but an experimental attempt to resume the original `mode.start` root after the isolated choice event caused Chromium's CDP page target to stop answering once `root.start()` was invoked. The observable state remained at authority revision 2; no Event #3 proof was accepted. The experiment was removed from the default path rather than leaving CI hanging or claiming a turn. After removal, the four-seat test passed three consecutive runs; the selected local M2 host/session/controller and Chromium regression set passed 16/16 with no skips. Exact internal stall point is not yet identified because subsequent CDP Runtime.evaluate commands did not return; this is reproducible evidence of a coordinator boundary problem, not evidence that the native start event completed. Opening draw, first phase, first player decision, and authority Events #3/#4 remain unimplemented/unverified. Linux CI has not yet run for this investigation.

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

### M2-C3d native startup diagnostics (working batch)

- Opt-in only: the real-Chromium diagnostic is enabled only with `V2_NATIVE_START_DIAGNOSTICS=1`; it uses a bounded CDP event binding/ring buffer and does not broaden normal CDP access. Diagnostic records contain event/step/stack, safe seat IDs, initialized-role booleans and hand counts, never session secrets or player credentials.
- The raw native `mode.start` probe is a bounded test experiment, not a production startup path. It proved the root promise can remain pending while CDP stays responsive (`native_promise_pending_cdp_responsive`), so a pending root promise alone is not evidence of event-loop starvation. It also reproduced the unsafe duplicate setup: `waitForPlayer`, `randomMapOL`, and `prepareArena` ran after the four-seat room was already initialized; `randomMapOL` created a server-side local player, the roster grew to eight, and `game.me` ceased to be null. The root nevertheless reached `gameStart`, native `gameDraw`, `phaseLoop`, and nested `xingDong` / `gongJiOrFaShu` events. This confirms the duplicate-initialization hypothesis for the raw path and falsifies the general claim that a live root promise necessarily blocks CDP.
- A second opt-in, fail-closed coordinator probe starts the original Xingbei `mode.start` root event with the already verified four-seat roster. Its narrow adapters accept only the completed room state: the wait callback is satisfied from the verified roster; duplicate arena/character setup throws; `randomMapOL` is a verified no-op to avoid its duplicate server-player creation. Native `gameStart`, `game.gameDraw(firstChoose)`, native `phaseLoop(firstChoose)`, four actual opening hands (4 each), and the first native `Player.phase()` child under `phaseLoop` were observed. The probe pauses at that first phase boundary, with `game.me === null`, exactly four initialized seats, and the original root/child stack intact. The root promise remains pending as expected for the continuing game loop while independent CDP diagnostics respond.
- This is C3d diagnosis plus a test-only C3e startup proof, not a production coordinator or a completed player action. No `xingDong`/`gongJiOrFaShu` choice has yet been routed through the authenticated choice controller, and no authority Event #3/#4 validator or submission has been established. Do not claim first player action, Full Playable, HALL routing, M3, or M4.
- C3e-A probe now reaches the actual native decision event `gongJiOrFaShu` (step 0, parent `xingDong`) inside the real `phaseLoop → phase → xingDong → gongJiOrFaShu` stack. For the first-action seat, `event.isMine()` and `event.isOnline()` are both false; the native `chooseToUse` content would otherwise enter its offline AI branch. The opt-in probe wraps only this exact event's native `GameEvent.loop`, records safe event/seat/filter diagnostics, builds a private in-page mapping for the restricted one-physical-card/one-target shape using the event's native card/target filters and pauses before content executes. Probe IDs are test-only and are not controller credentials or final opaque option IDs. Shapes with dynamic target selectors, complex/multitarget selection or event-level filter/custom callbacks are excluded. No candidate is registered with the server controller and no result is applied yet.
- C3e-A local verification: the focused V2 suite passed 16/16; the real-Chromium `managed_input_gate` diagnostic passed 1/1, zero skips. It observed native card/target filter candidates while preserving `game.me === null` and stopping before native AI selection. See the candidate-mapping Linux CI evidence in the following entry.
- C3e-A candidate-mapping refinement: Linux CI run `38535370673` succeeded, including the real Chromium input-gate test (1/1, zero skips). The focused local regression suite also passed 16/16; the separate input-gate run passed 1/1. This still does not register a player choice with the controller.
- C3e-B safety stop: a test-only attempt to move the gate later into the `gongJiOrFaShu` content did not intercept before resolution; the observed native stack had already entered `useSkill → discard → lose`, and no action-gate record was emitted. That prototype was discarded; the retained gate stops at the `gongJiOrFaShu` event boundary before any of its content/AI branch executes. Do not route controller deliveries until a native content boundary can be proven to resume the same event without rerunning step 0 or the offline-AI path.
- C3e-A gate test: focused existing regressions 16/16, plus the real-Chromium input-gate probe 1/1, with zero skips. Linux CI run `38534330718` succeeded, including the dedicated managed native input-gate step. This proves interception before the native offline-AI branch, not an accepted player action.
- The opt-in `controlled_block` case produces a bounded CDP command timeout while the browser remains alive; it is classified as `cdp_command_timeout`, not misreported as an observed native exception. The regular suite remains separate and does not enable diagnostics.
- Local verification: the seven focused V2 suites passed 16/16; raw-root and managed-start real-Chromium diagnostic modes each passed 1/1 with zero skips. Linux CI run `38518177521` succeeded; its two dedicated diagnostic steps both completed successfully, as did all pre-existing workflow steps. No production service, VPS, V1/V2/V3 deployment, or live player environment was touched.

M1 batch 1 adds a server-owned lifecycle record around the still-human-hosted engine. Owner disconnect pauses and retains the room for a bounded grace period; it does not claim gameplay continues. Reclaim requires the original bound online identity plus a rotating server-generated secret. A resumed owner remains in `waiting_host_process` until it reconfigures; guests are not routed to it beforehand. Expired rooms are explicitly cleaned and only then close remaining guests.

- Implementation commit: `34c8dbc` (`feat(v2): add server-owned room lifecycle foundation`)
- HALL harness compatibility commit: `dbe61ee` (`test(v2): load M1 lifecycle in HALL harnesses`)
- Review PR: `#1`, targeting `feature/v2-connection-stability`; left open and unmerged.
- Linux CI run 38304099421: `node-recovery-tests` succeeded after the generated HALL harnesses were taught to load the new local lifecycle dependency. Cloudflare Pages also succeeded, but is not lifecycle acceptance evidence.

M1 continuation on the same PR:

- `e2b0931` fixes paused-room admission and server-mode shutdown cleanup. New visitors are rejected before acquiring a room reference; existing guests remain attached. Server-mode shutdown sends the legacy close signal and clears guest room/owner references. Linux CI run 38304735974 passed.
- Browser owner recovery now stores a protocol-v1 rotating secret in session storage, but automatic resubmission additionally requires a same-page in-memory marker. This prevents a hard reload from pretending the human game engine survived.
- The HALL validates owner-recovery protocol version before token processing. A successful reclaim remains gated in `waiting_host_process` until the browser resends configuration.
- `tests/v2-hall-process-integration.mjs` launches the real HALL entry point on an isolated loopback port with actual WebSocket clients. No VPS or live service is involved.
- `5d4130d` implements the versioned browser owner-resume path and spawned HALL process test. Linux CI run 38305127613 passed all workflow steps.
- `8541fef` corrects the human-host state transition: `createroom` leaves the host in `onlineroom`, so WebSocket close now permits owner recovery from either active online state. Executed actual-client-handler tests cover this path rather than relying on text-only assertions.
- Guest pause/resume control now fails closed unless the client is an online non-owner in the same protocol-v1 room. Pause clears stale choice/progress identifiers; resume carries a server-authenticated room binding.
- `289d082` adds a Linux CI scenario that runs the production B2 patcher over the current M1 HALL and starts the generated server. It covers paused reclaim denial, owner recovery, stable-seat rebinding, resumed bidirectional traffic, duplicate takeover fencing and invalid credential rejection.
- Linux CI run 38306224205 passed. Its dedicated `V2 generated B2 and M1 same-process integration` step and all other 18 substantive setup/test steps completed successfully.
- M1 is not yet declared complete: the generated-server integration is process-level evidence, while real-browser concentrated acceptance and exact deployed-source offline compatibility remain outstanding.
