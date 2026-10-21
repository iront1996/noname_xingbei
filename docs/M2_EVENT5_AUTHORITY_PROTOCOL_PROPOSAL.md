# Event #5 authority protocol proposal (review-only)

Status: draft only. This document and `game/server-managed-authority-event5-proposal.js` are not connected to HostSession submission, do not raise the revision limit, and cannot accept or create Event #5. The accepted authority tip stays at sequence 4 / revision 4; next sequence is 5; `seedAuthorized=false`; `checkpointAvailable=false`.

Evidence provenance is tracked separately in [`M2_EVENT5_EVIDENCE_PROVENANCE.md`](M2_EVENT5_EVIDENCE_PROVENANCE.md). All booleans, digests and ordinals supplied by a proposal caller are claims until matched to current manager-owned records and authenticated managed-host evidence. The review-only assessor does not authorize or submit events.

## Proposed event envelope

Schema: `xingbei_native_action_event5_proposal_v1`.

The proposed envelope is scoped to one `roomId`, active `hostSessionId`, pinned `engineBuildId`, `rootInstanceId`, and the exact ordered four-seat roster. The predecessor digest is explicitly tagged `xingbei_authority_state_v2`. It names the completed preceding `phaseOver` event and parent, and a separately identified native phase/actor-rotation event proving that the next actor is an ordinary seat different from the preceding actor.

The next actor's `gongJiOrFaShu` native event must be a real waiting instance under its observed native parent. Its candidate set contains only opaque option IDs and bounded kinds (`gongJi`, `faShu`, `native_skill`); private card faces, other seats' candidates, and arbitrary client-supplied rule objects are excluded. A future managed choice would bind the native event, seat, current Seat Registry connection generation, server-issued `choiceId`, immutable option, and a distinct immutable `deliveryId`. It must also retain the controller's current-session authentication, deadline/trustee policy, one-time resolution, native application deduplication, ACK retry, and stale-connection fencing.

The digest namespaces are intentionally not interchangeable: the accepted Event #4 SHA-256 digest is over canonical authority schema v2; successor pre-action `stateDigest` is over a private T3 projection/fence preimage and its HMAC commitment is keyed; V3 `stateSequence/stateVersion` are recipient stream counters; and native completion/capture ordinals describe separate ordering domains. Equal digest bytes do not prove equal state. The review schema therefore requires `authorityPredecessorDigest` to equal the authority predecessor only within that same domain, while any future before/after private state pair must name one shared private transition schema. A bridge accounting for native phaseOver, actor rotation and quota initialization after Event #4 is currently unavailable. No post-action state is available because the second-seat action has not been executed. The proposal remains review-only; no digest is copied across domains to imply continuity.

Completion evidence for any future action must identify the actual native `useResult` and every relevant child/trigger by event instance, parent path, and completion ordinal. Only after those complete may a reviewed safe fence produce a private post-state capture. The proposal validator requires `knownStateOnly=true`; unknown skills, storage, effects, unfinished children, or privacy violations reject the proposal. It also checks there is no duplicate native application and that a proposed revision would be continuous, but the action/state bridge remains unavailable. The pure validator returns `acceptedAuthorityEvent=false`, `submissionEnabled=false`, and no resulting revision.

## Reuse and first-actor assumptions

- Reusable from Event #4: managed-host source authentication, room/session/build/root binding, strict proof parsing, digest-chain continuity, server-side proof validation, opaque option IDs, controller delivery/ACK idempotency, and fail-closed rejection.
- First-actor assumptions that must not carry forward: `_status.firstAct` as a permanent actor, first phase/choice identity, first-seat credential generation, the opening-action-specific native parent path, and any completion proof minted for the previous actor. Every action needs a fresh native event instance, current actor derived from the live native phase loop, current seat-generation proof, and newly scoped child-completion ledger path.
- Cross-player proof isolation: bind proof to the same managed root/session/build and the new native event instance plus its exact actor seat; reject event-instance reuse, non-increasing completion ordinals, a prior-seat binding, old connection generation, old delivery, or any child proof whose ancestry is not connected to this action.
- Unsupported state handling: the existing authority acceptance path remains closed to Event #5. If an action changes a state family without a reviewed canonical source/validator, reject it without advancing the current tip or releasing the native parent. Do not broaden Event #4 semantics to absorb later actions.

## Draft lifecycle and errors

Proposed lifecycle: `input_waiting` → `choice_pending` → `delivery_pending/applying` → `native_children_pending` → `native_complete` → `post_state_fenced` → `proposal_validated`. Every transition is one-way and scoped to a single event/choice/delivery identity. Timeout may resolve only through an allowed native trustee choice. Stop, replacement session, uncertain native application, or failed post-state validation aborts and fences the action; uncertain results are never replayed blindly.

Review-only rejection codes include `EVENT5_PROPOSAL_ENVELOPE_REJECTED`, `EVENT5_PROPOSAL_PREDECESSOR_REJECTED`, `EVENT5_PROPOSAL_PHASE_FENCE_REJECTED`, `EVENT5_PROPOSAL_ACTOR_ROTATION_REJECTED`, `EVENT5_PROPOSAL_INPUT_GATE_REJECTED`, `EVENT5_PROPOSAL_SEAT_BINDING_REJECTED`, `EVENT5_PROPOSAL_CHOICE_DELIVERY_REJECTED`, `EVENT5_PROPOSAL_NATIVE_SETTLEMENT_REJECTED`, and `EVENT5_PROPOSAL_POST_FENCE_REJECTED`. These are draft validator outputs, not production manager state transitions.

## Required acceptance before any future authorization request

1. Real Linux Chromium: next ordinary actor and legal candidate from the same root after accepted Event #4; no second action executed for this current milestone.
2. Future isolated action test: actual next-seat choice, stale/old socket/admin/wrong-seat rejection, deadline/trustee, delivery/ACK loss, reconnect generation, and exactly-once native application.
3. Native `useResult`, all children/triggers, parent resume, and post-state safe fence verified with real event ancestry.
4. Event-specific canonical state validator covering physical-card movement, resources, quota/actor rotation, and every supported effect; unknown state fails closed.
5. Node protocol negatives for stale predecessor/root/session/build/seat, wrong event, sequence/revision gap, digest mismatch, duplicate proof/application, mutable delivery, stale ACK, unfinished child, unsupported state, and stop/replacement races.
6. Full serialized Linux CI, necessary tests non-skipped, release-lock verification, and independent review of the proposal.

Even after these checks, accepting Event #5 requires separate explicit authorization. It is not authorized by this proposal, by the next-seat preparation contract, or by passing tests. Any authorization request must specify the new event validator, state family, revision transition, and exact acceptance scope. Formal V1/V2/V3, HALL, VPS, and external services remain out of scope.
