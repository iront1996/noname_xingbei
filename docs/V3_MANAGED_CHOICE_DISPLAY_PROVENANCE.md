# V3 managed-choice display provenance (isolated experiment)

Schema: `xingbei_v3_managed_choice_display_v1`.

This is a read-only presentation projection. It is separate from `choice_submit`; clients still submit only the server-issued `choiceId` and the exact opaque `optionId`. Labels cannot grant authority or change a resolution.

| Display field | Trusted source | Stability/binding | Privacy and limit |
|---|---|---|---|
| `optionId` | Native action candidate generated at `gongJiOrFaShu`, then accepted by the authenticated HostSession manager | Exact ordered list must equal the currently pending controller choice; duplicate IDs are rejected | Opaque random ID only; never decoded by the browser |
| `operationKind` / `label` | Candidate `cardType` from the managed Chromium native enumerator (`gongJi` or `faShu`) | Host manager stores the accepted type map on the candidate; display is bound to its native event and accepted pre-action capture | Render only “攻擊” or “法術”; no rules text or outcome prediction |
| `targetSeatId` | Candidate target object after the native event's `filterTarget` and target-enabled checks; manager validates it against immutable room seats | Kept on the same option ID and native candidate; exact event/root/seat/capture binding required | Seat identity only. Invalid/unavailable target is rendered as absent, never inferred |
| `cardViewId` | No accepted option-to-physical-card identity relation exists in the current candidate contract | Always `null` in v1 | Card names and array position are insufficient. The UI does not claim “use this physical card” |
| `completeness` | Derived by the server display builder from the bounded semantics available | `partial` for reviewed kind labels, `opaque` for unsupported kinds | Does not mean a complete card/skill description |
| `roomId`, `hostSessionId`, `rootInstanceId`, native event/parent IDs, sequence, choice ID, actor seat, connection generation, capture ordinal and native completion ordinal | Candidate + sequence-specific accepted pre-action capture + active Seat Registry binding | HostSession capability check rechecks the current candidate, capture, native identity, event sequence, actor, and connection generation. Gateway validates the same binding before sending | Identifiers/progress only; no proof, digest, HMAC, native object, card ledger, credential, or host secret is sent |

## Fallback and UI behavior

The recipient Gateway returns display metadata only for the current authenticated actor and pending choice. The browser checks schema, choice/event/seat/generation identity, item order, labels and target shape. If this display validation fails, buttons remain available with a generic “合法操作（語意未驗證）” fallback, while their `data-option-id` remains the original opaque ID. The client uses `textContent`; it never turns display text into an action payload.

Event #8 capped state clears stale choices and remains read-only. Event #9 has no choice/display path. The display protocol does not alter candidate eligibility, trustee/controller races, delivery identity, native application, or authority acceptance.

## Evidence status

Protocol and Gateway Node tests pass locally. The existing required Linux Event #8 real-Chromium four-page job now asserts that displayed item IDs, kinds, and targets match the native candidate and that each browser renders the same labels while the native action still uses the opaque ID. A local Windows real-Chrome run passed the full Event #5–#8 page-driven room flow, including controller resolution, authority acceptance, Event #8 capped read, Event #9 rejection and teardown. Linux CI for this change is pending.

No physical-card-to-option mapping is claimed. `optionCardNames` may be available as native metadata but is not a unique card identity; the display contract deliberately excludes it and sets `cardViewId: null`. This batch does not complete T3, Full Playable, M3/M4, or formal V3/HALL integration. The authority seed remains unauthorized and Event #9 remains rejected.
