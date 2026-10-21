# V3 managed-choice display provenance (isolated experiment)

Schemas: `xingbei_v3_managed_choice_display_v1` (legacy/fallback) and `xingbei_v3_managed_choice_display_v2` (optional verified physical-hand link).

This is a read-only presentation projection. It is separate from `choice_submit`; clients still submit only the server-issued `choiceId` and the exact opaque `optionId`. Labels cannot grant authority or change a resolution.

| Display field | Trusted source | Stability/binding | Privacy and limit |
|---|---|---|---|
| `optionId` | Native action candidate generated at `gongJiOrFaShu`, then accepted by the authenticated HostSession manager | Exact ordered list must equal the currently pending controller choice; duplicate IDs are rejected | Opaque random ID only; never decoded by the browser |
| `operationKind` / `label` | Candidate `cardType` from the managed Chromium native enumerator (`gongJi` or `faShu`) | Host manager stores the accepted type map on the candidate; display is bound to its native event and accepted pre-action capture | Render only “攻擊” or “法術”; no rules text or outcome prediction |
| `targetSeatId` | Candidate target object after the native event's `filterTarget` and target-enabled checks; manager validates it against immutable room seats | Kept on the same option ID and native candidate; exact event/root/seat/capture binding required | Seat identity only. Invalid/unavailable target is rendered as absent, never inferred |
| `cardViewId` | v1 has no link; v2 derives a recipient hand-view HMAC only from a same-capture native Card object → private Ledger row join | Null for v1 and unsupported/ambiguous v2 options; non-null v2 is marked `verified_physical_hand_v1` | Recipient-scoped opaque view ID only; native Card/Ledger ID stays private |
| `completeness` | Derived by the server display builder from the bounded semantics available | `partial` for reviewed kind labels, `opaque` for unsupported kinds | Does not mean a complete card/skill description |
| `roomId`, `hostSessionId`, `rootInstanceId`, native event/parent IDs, sequence, choice ID, actor seat, connection generation, capture ordinal and native completion ordinal | Candidate + sequence-specific accepted pre-action capture + active Seat Registry binding | HostSession capability check rechecks the current candidate, capture, native identity, event sequence, actor, and connection generation. Gateway validates the same binding before sending | Identifiers/progress only; no proof, digest, HMAC, native object, card ledger, credential, or host secret is sent |

## Fallback and UI behavior

The recipient Gateway returns display metadata only for the current authenticated actor and pending choice. The browser checks schema, choice/event/seat/generation identity, item order, labels and target shape. If this display validation fails, buttons remain available with a generic “合法操作（語意未驗證）” fallback, while their `data-option-id` remains the original opaque ID. The client uses `textContent`; it never turns display text into an action payload.

Event #8 capped state clears stale choices and remains read-only. Event #9 has no choice/display path. The display protocol does not alter candidate eligibility, trustee/controller races, delivery identity, native application, or authority acceptance.

## Evidence status

- P0 root cause: a valid `managed_choice` was found and passed display validation, but serialized to 4,462 bytes against `maxMessageBytes=4096`. The Gateway rejected it before WebSocket `send()`, so there was no socket callback or browser message event and the pending request remained unresolved.
- The Gateway now emits allowlisted low-sensitivity diagnostics, compacts redundant display fields, and returns a requestId-scoped bounded error if a response still cannot fit. Recipient hand data travels as a versioned ordered tuple projection from the same accepted capture as the option/card link; opaque option IDs and the legal option set are unchanged.
- A separate post-delivery mismatch was the browser retaining a hand projection from an earlier capture while the option link used the current accepted pre-action capture. The current actor's hand display is now included in that same `managed_choice`; the browser validates the seat/schema and linked view IDs before updating its hand.
- Local evidence: focused Node tests passed 30/30, zero failures/skips. Real local Windows Chrome four-page Event #5–#8 passed 1/1, zero skips. The traced Event #7 reply was 5,566 bytes pre-compaction and 4,002 bytes on wire under the unchanged 4,096-byte cap. Lookup/schema, `beforeSocketWrite`, serialization, send callback, browser listener and pending-request settlement all succeeded. The page showed the same-capture single physical-card association and submitted the original opaque option through its UI handler; Events #5–#8, reconnect, Event #8 cap, Event #9 rejection and teardown also passed.
- Linux CI remains pending; Cloudflare was not rechecked and no push occurred. This is local fixture evidence only and does not generalize to multi-card, viewAs, skill, or unsupported operations.

The preceding semantic labels (“攻擊”/“法術”), target projection, opaque submission, Event #5–#8 flow and Linux run `39576014870` remain previously accepted evidence. They do not prove a physical-card-to-option identity.

Earlier attempts included `HOST_CHOICE_IPC_HANDLER_FAILED` and the bounded 4,462-byte rejection above; these historical diagnostics are retained. The final local test verified the same-capture native physical Card → unique sidecar Ledger row → recipient hand-view ID link, page display/selection, original opaque option submission, native completion, authority acceptance and cleanup. Linux CI is still required before claiming Linux coverage.

## `choice_read` P0 local revalidation (2026-10-22)

- The 4,096-byte wire cap remains unchanged. A real four-page Chromium Event #5–#8 run observed successful UTF-8 replies at 3,609, 3,612 and 4,002 bytes (the 4,002-byte reply followed compaction from 5,566 bytes); each stayed within 4,096 bytes, completed the WebSocket send callback, reached the page listener, rendered the exact native option set and settled the matching request.
- A Node boundary test forces an oversized choice response with a 512-byte test cap and confirms a bounded `gateway_error` carrying the same `requestId` is delivered successfully. A separate injected write-guard failure confirms the gateway closes the peer instead of leaving a response silently pending. The browser now rejects and clears pending requests on socket close or connection replacement; request-send exceptions also settle with an explicit error.
- Latest focused local Node suite: 32/32 passed, 0 failed, 0 skipped. Latest real local Windows Chrome four-seat flow: 1/1 passed, 0 failed, 0 skipped; Event #5–#8, rebind, Event #8 read-only cap, Event #9 rejection, and process/profile teardown passed.
- Release lock was recomputed after managed Gateway/UI source edits: build ID `cbaefd2e6a7f171e89cd87491612fd3c7c31d91de73ac71bc37373ea86ecc12e`, 225 files, 19,537,729 bytes; local verification passed. Linux CI remains pending. This batch did not push or start remote CI; Cloudflare settings were not checked or modified.
- Physical-card linkage remains limited to the verified single-card fixture. No general card-family, multi-card, `viewAs`, skill, or unsupported-shape coverage is claimed; unsupported linkage remains null/fallback.

## Physical-card association (versioned and source-limited)

The successor pre-action capture envelope is now `xingbei_native_private_successor_preaction_capture_v2`. At a real paused `gongJiOrFaShu` input gate, Chromium may associate an option with a physical card only if the exact native option-map entry points to the same event instance and actor seat; it is a direct single-card candidate (no skill/material/viewAs shape); the selected object is a native DOM Card still in that actor's `h` zone; native selection shape is exactly one card and one target; candidate name/type/target match that same object; and the capture's Card Ledger sidecar `WeakMap` resolves that exact object to one unique physical ledger row owned by the actor in `hand`.

The per-option private card-ID map is part of the v2 fence and is included in the accepted private capture digest/HMAC. HostSession then requires exact room/session/build/root/seat/native event/event-instance/parent/capture/ordered-option identity. The server-only V3 projector independently validates that every non-null ID resolves to exactly one current actor-owned hand row and derives the recipient's ordinary hand-view HMAC with the same key, scope and capture ordinal as the own-hand projection. Only that opaque view ID is exposed; raw card IDs, proof, key, ledger and other players' private data remain server-side.

`xingbei_v3_managed_choice_display_v2` is an optional, display-only capability. It does not alter candidate membership, choice identity, deadlines, delivery or submission. UI card selection only filters the already-rendered legal option buttons; each button still submits its original opaque option ID. Multiple targets/options linked to one physical card remain distinct buttons. Skills, virtual/viewAs cards, multi-card candidates, moved/out-of-hand cards, cross-seat IDs and unprovable shapes remain unlinked and use fallback. Names, card order and UI state never create the relation.

Local Node tests cover same-capture linking, duplicate-name physical cards, wrong-seat/non-hand rejection, opaque protocol shape and non-disclosure. The local real-Chromium page-driven selection assertion passed for the restricted single-physical-card fixture; the required Linux job remains pending, so the coverage manifest does not promote the general physical-card family. This does not complete T3, Full Playable, M3/M4, or formal V3/HALL integration. The authority seed remains unauthorized and Event #9 remains rejected.
