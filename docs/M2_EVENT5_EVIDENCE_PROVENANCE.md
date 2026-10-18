# Event #5 evidence provenance matrix (review-only)

This matrix audits the draft only. It is not a HostSession authority validator, does not allocate a choice, and cannot submit or accept Event #5. The authority tip remains revision 4 / next sequence 5; `seedAuthorized=false`; `checkpointAvailable=false`.

| Proposed evidence | Classification in this batch | Trusted source / limitation |
| --- | --- | --- |
| Event #4 predecessor sequence, revision, digest | Supported for review | Current HostSession record after its existing Event #4 validator accepted the predecessor. Caller-provided proposal values remain untrusted and are compared to the manager observation. |
| Same room/session/build/root/four-seat identity | Supported for review | Current HostSession record and authenticated managed-child identity. This does not independently attest a compromised Chromium. |
| First-seat native action and Event #4 completion | Supported within existing Event #4 contract | Existing authenticated Chromium proof accepted by HostSession. No inference is made about future actions. |
| First-seat `phaseOver` completion | Supported for review only | Manager-held, previously validated private atomic phase fence proof. The assessor reports observed review evidence; it is not an Event #5 authorization proof. |
| Actor rotation to the next seat and native waiting gate | Supported for review only | Authenticated managed Chromium diagnostic, bound to the actual successor native event and current ordinary Seat Registry binding. |
| Current successor seat connection generation | Supported for review only | Live Seat Registry binding at inspection time. It becomes stale on rebind/session replacement and is not a future action credential. |
| Successor actor/phase/quota and bounded candidate kinds | Partially supported | Values are derived from the managed Chromium successor wait trace and cross-checked against the manager's accepted Event #4 predecessor and seat binding. This is a waiting-state observation, not proof of an action. |
| `completed`, `rotationVerified`, `authenticated`, `knownStateOnly`, proposed digest/ordinal supplied by caller | Unverified caller claims | A structurally valid proposal cannot promote these fields to evidence. The pure assessor labels them `caller_claim_unverified`. |
| Second-seat choice, controller result and delivery | Unavailable | No second-seat choice is opened or delivered in this batch. |
| Second-seat native settlement and child/trigger completion | Unavailable | The second-seat action is deliberately not executed. No completion proof may be synthesized. |
| Second-seat post-action capture / canonical state | Unavailable | No second action or post-action fence occurs; T3 remains partial and `fullCanonicalStateEligible=false`. |
| Event #5 authority acceptance / revision 5 | Prohibited | No submission handler is connected; Event #5 remains rejected and revision remains 4. |
| Full checkpoint / crash recovery | Unavailable | Private commitments are not restorable checkpoints and do not establish M4 recovery. |

## Cross-invariants

- The accepted predecessor and successor wait must share room, active host session, pinned engine build, root instance, and exact ordered four-seat roster.
- The successor actor and native event instance must differ from the prior action actor/event; its current seat binding must be an ordinary authenticated player with a current connection generation.
- A validated phaseOver fence must precede the successor input wait. Native completion ordinals are monotonic and evidence instances cannot be reused; capture ordinal is a separate counter.
- The successor wait has no allocated choice, delivery, timer, trustee result, action settlement, or authority submission.
- Any stale session/root/build/seat/event, pending child, non-increasing ordinal, inconsistent private projection, or unexpected Event #5/revision transition fails closed.
- The review assessor is not a provenance authority. Its structural-shape result is explicitly named `reviewObservationShapeValid`; classifications are `manager_scoped_review_candidate`, not trusted proof. Only the manager integration constructs its input from current manager-owned/authenticated records, and neither path is connected to authority submission.

## Verification scope

The dedicated local Windows Chrome test reached the actual second-seat native waiting gate and accepted a distinct, repeated-stable three-projection private capture in the same managed root. It did not execute the second action. Linux CI must execute this same test before the batch is accepted. The result is a limited successor pre-action commitment, not Event #5, a complete canonical state, or a checkpoint.

## V3 seat-state interface status

The isolated V3 envelope/receiver contract can constrain recipient seat, connection generation, replay cursor, public player records, recipient-scoped opaque hand view, and pending choice identity. Its current publisher deliberately requires future source/provider callbacks; it does not itself extract native state or authenticate live sockets. This batch validates the successor's current Seat Registry generation and input-gate candidate, but has not built a full player view from a unified native capture. Public role/side/hand-count and recipient private data therefore remain only protocol-shape fields until a reviewed source projection is connected. No other-seat hand, raw Card Ledger, `Player.storage`, or host secret is publishable. HALL and M3 remain incomplete.
