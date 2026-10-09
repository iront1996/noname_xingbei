# V3 房主重新整理後續局：整合開發紀錄

## 使用者驗收目標（不可降低標準）

在 4 人或更多玩家的真實對局中，原房主重新整理網頁後：
1. 原房間保留，其他玩家等待，不退出、不自動託管。
2. 僅原房主能通過驗證並取回權威控制權。
3. 重新載入正確的角色、隱藏手牌、牌堆和棄牌堆原順序、技能與到期條件。
4. 恢復等待中的選擇／事件；傷害、棄牌、抽牌不得重複結算或跳過。
5. 房主與其他玩家同步完成後才解除等待，可繼續原本對局。
6. 未達全部條件時必須 fail closed，不可顯示假成功、不可偷偷重開局。
7. **不得修改 V1/V2 正式系統、VPS 8080、production tunnel。**

## 部署與隔離

- V1: `feature/auto-lobby` (expected `4970c744a1e812f1498506b2a2ae6d6701a4db5e`)
- V2: `feature/image-preload-cache` (expected `d872c6fca19b1333f85aadbfb76c735cf25c7fd8`)
- V3 baseline: `feature/host-reconnect-v3` (expected `b0e1784f52304910cb8470fe021ba3d6c4f94469`)
- Isolated work branch: `feature/host-reconnect-v3-playtest`
- Only V3 backend: `xingbei-hall-v3.service`, `/opt/xingbei-hall-v3/server.js`, 127.0.0.1:8081.
- V3 frontend preview: `https://feature-host-reconnect-v3-pl.xingbei-play.pages.dev/`.
- Manual V3 backend deployment only using guarded `tools/deploy-v3-playtest.sh`; no automatic VPS access.

## 已實作與已知限制

### Network stage

- V3 room broker reserves disconnected owner's room for 180 seconds.
- Remaining players see explicit wait overlay.
- Owner may resume WebSocket while **original authoritative browser runtime stays alive**, authenticated by a rotated 32-byte secret.
- Guest messages are buffered with bounds during owner absence.
- Reload of owner's tab is NOT fixed by that connection handshake; it destroys `GameEventManager`, Promise continuations and closure-local effects.
- A refreshed owner sees the saved-room status and can explicitly abandon an unrecoverable room.

### Local recovery foundation (frontend only)

`game/v3-recovery-vault.mjs` now runs only in V3 playtest and only for an active in-game room owner.

- Every six seconds it captures a **candidate** state: arena/players, skillState, draw/discard order, card tags, room configuration, mode state, phase/round markers.
- Includes per-player stats/actionHistory/skipList in engine-converted form. **Deep completeness has not been verified.**
- Includes a diagnostic *outline* of in-flight event names/steps and pending queue counts. **Not a continuation.**
- Encrypts bytes with a fresh AES-GCM IV using a 256-bit key retained in sessionStorage across same-tab refresh; stores ciphertext in IndexedDB. Decryption key and raw hidden cards are never sent to server or logged.
- Preserves a separate turn-boundary candidate through the `lib.onphase` hook just before the next `phaseLoop` turn starts. Pending write collisions are handled by capturing synchronously and queueing the encryption/write.
- Latest candidates expire after ten minutes for loading. Explicitly abandoning the room deletes both local candidate records and encryption key.
- `inspectLocalRecoveryCandidate` returns **metadata only** and confirms whether the ciphertext is decryptable; never returns cards.
- `loadLocalCandidateForEngine` returns decrypted state only to trusted in-origin game code, with validation. It does **not** execute state restoration.

**All candidates intentionally carry `restorable: false`, `safeCheckpointCertified: false`, `eventContinuationCaptured: false`.** Do not override flags until the engine really supports these properties.

## 尚未實作（核心阻塞）

1. **Authoritative runtime rehydration.** Existing `lib.message.client.reinit` makes a *client* view; cannot simply reuse it as a host. Need proper host-side reconstruction and mapping of original player IDs, remote `Client`/NodeWS objects, guest response channels, card references, UI & game helpers.
2. **Full event continuity.** Engine uses `GameEvent.start/loop/waitNext` with runtime Promise continuations and untracked local closures; a serialized `name` + `step` is insufficient. Build explicit safe checkpoint boundaries, restore from a certified phase boundary with a well-defined rollback contract *or* design an engine continuation/action journal. Do not claim exact restoration before test.
3. **Consistency and ordered effects.** Need transactional revision/epoch, duplicate response suppression, remote waiting-choice IDs, deterministic randomization when replaying, and post-restore checksum/ack before unblocking guests.
4. **Snapshot completeness.** Candidate captures engine-provided state but not all card/skill/UI/mark/deck/async fields. Full rehydration and roundtrip must prove no lost fields.
5. **Secure handoff.** The encrypted state is local, not stored on VPS. Need design for abandoned/corrupt/expired records, room timeout, restarted VPS, multi-tab behavior.
6. **Automated end-to-end proof**, with actual engine + several clients, disconnect at safe and mid-event positions, no hidden-info leakage. Do not ask user to manually run dozens of Console commands.

## 已做驗證範圍

- Node/JS syntax checks of playtest-only files.
- V3 mock room-broker tests for owner token, wait, bounded guest buffering, ready handshake, expiry and authenticated abandon.
- Isolated mocked IndexedDB/crypto roundtrip: capture -> encrypted record -> same-tab refresh read -> wrong/missing-key failure -> purge. Mocks do **not** prove real browser WebCrypto or in-game behavior.
- Real multiplayer test (user): room remains while owner disconnected; user observed wait overlay and refreshed owner's cannot-restore overlay. This specifically **does not** pass the ultimate acceptance criteria.

## 下一階段交付標準

Do not ship a new "refresh restorable" version until:
- host runtime can be genuinely reconstructed;
- restoration works after refresh without old game JS stack;
- pending/mid-turn decisions are not silently skipped;
- runtime can safely rebind players;
- end-to-end functional tests prove the no-duplicate-effects invariant.

The current code is foundational infrastructure, not the completed feature.
