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

## 權威房主安全接管前置層（本輪新增）

後續真正的房主權威引擎重建不得直接使用 `lib.message.client.reinit` 冒充成功；這是客戶端視角，不具房主所需事件執行環境。為了避免恢復後將遠端回應送給錯誤玩家，本輪已實作**獨立的接管前置層**：

- `game/v3-recovery-vault.mjs`：新增 `hostPlayerId` 與 `peerBindings`（原玩家 ID ↔ 原 NodeWS socket ID）；只在綁定完整時保存候選資料。包含死亡角色座位，避免只計算仍存活角色。
- `game/v3-playtest-server.cjs`：新增 `server/v3restoreprobe`，必須通過原房主 onlineKey 與 256-bit token 驗證，而且房間仍保留、已開局且沒有其他房主接管，才回傳**仍連線中的玩家 socket ID 清單**。**不轉移控制權、不呼叫 v3ready、不解除等待、不回傳原房主 token**。
- `game/v3-host-authority-gate.mjs`：純函式驗證房主本機解密候選資料與 VPS 仍連線的原玩家 socket 集合是否完全吻合、玩家資料與候選資料期限；任何衝突 fail closed。
- `game/v3-rehydration-blueprint.mjs`：純函式建構私有重建藍圖，包含原座位順序、角色與技能候選資料、原 socket 路由、牌堆／棄牌堆原順序和回合資訊；拒絕原座位衝突、錯誤牌格式、重複卡牌 ID。不觸碰 DOM、不建立引擎 GameEvent、不建立新的玩家 socket、不向伺服器傳送私密卡牌。
- `game/v3-owner-connection.mjs`：若房主刷新後本機存在可解密的回合交界候選資料，向 VPS 請求受保護的原玩家 roster，執行上述核對，並在 UI 顯示**未能恢復遊戲**。仍可安全結束舊房間。

### 當前精確狀態

- **已有：** 一份可以讀取、驗證並整理的私有重建藍圖，且伺服器可核對原玩家仍連線的身分。
- **未有：** 實際的 DOM/player/card 引擎物件重建；原房主新分頁的 `game.createServer()` 與 `NodeWS` / `Client` 真正接管；技能效果/計時器/非同步流程續行；任何安全的 `v3ready` 切換。
- **禁止：** 僅因 `preflight.ok` 或 `blueprint.ok` 就向 VPS 送出 `v3ready`，或聲稱原局可接續。
- **部署：** 本輪新增伺服器協定僅在 GitHub Playtest 分支，VPS 8081 尚未套用。前端即使已自動部署，也不能依賴新協定已在線上提供服務。需要在引擎續行完成後，才安排下一次實際多人驗收。

### 本輪模擬測試

- 全部原玩家 socket 一一對應：PASS，仍回傳 `readyToResume: false`。
- 伺服器驗證：無效 owner token、其他 onlineKey、房主已返回、非法房間狀態拒絕。
- 藍圖：正確保留座位與牌堆順序；錯誤/重複 socket、重複卡 ID、座位衝突、過期資料均拒絕。
- 界線：目前的模擬測試**不等同真實引擎與四人對局恢復驗收**。

## 原生遊戲物件隔離預建層（新增）

本輪新增 `game/v3-host-runtime-stager.mjs`，由通過前置驗證的私有重建藍圖建立**真實引擎類別的非執行態物件**：

- `lib.element.Player`：使用 `DocumentFragment` 作為暫存根節點，執行 `buildProperty()` / `buildNode()`，暫存原玩家 ID、座位、名稱、血量，以及死亡／存活玩家的座位連結。尚未 `player.init()`。
- `lib.element.Card`：建立 `Card` 原生節點，填入原始卡牌 ID、系別、命格、名稱與屬性；保留抽牌／棄牌及各玩家手牌、裝備、判定區、擴充區對應。**故意不呼叫 `card.init()`**，避免在未接管房主時寫入 `lib.cardOL` 或引發技能效果。
- `lib.element.NodeWS` / `lib.element.Client`：使用原玩家 socket ID 建立對應的原生遠端通道物件，但一律設為 `closed = true`，沒有任何對外 `send()`。未註冊至 `lib.node.clients`。
- `specials` 由本引擎 `getCards("s")` 取出，是 `getCards("hs")` 的重複視圖，僅檢查該別名是否出現在手牌中，不建立第二張卡牌。其他獨立卡牌區域若出現重複實體卡 ID，直接拒絕。
- 建立前先完整檢查所有列舉區域、卡牌編碼與重複實體 ID。任何錯誤都會阻擋本次 staging，不啟動引擎。
- `game/v3-owner-connection.mjs` 在受驗證的房主返回流程內呼叫隔離預建工具，僅顯示物件數量；原始隱藏手牌、玩家 ID、原生物件、路由及完整技能狀態不出現在畫面或日誌中。
- `tools/test-v3-native-staging.mjs`：6 個測試涵蓋 native 物件建立、停用通道、禁止送訊、無牌堆重複 ID、合法／非法特殊手牌別名、缺少卡牌區域與 native 初始化失敗。

**這不是完整遊戲重建**：目前未安裝玩家／卡牌至 `game.players`、`game.dead`、`lib.playerOL`、`lib.cardOL`、`lib.node.clients`，沒有套用含巢狀引擎參照的技能儲存資料，沒有重新啟動任何 `GameEvent`、計時器或等待玩家的回呼，亦未將卡牌的 `Card.init()` 副作用納入可交易式恢復程序。即使隔離預建成功，永遠保持 `readyToResume: false`。

下一步核心工程是具回滾保證的權威狀態交易式安裝、技能儲存參照解析及事件續行／回放。這些未完成前，不得觸發 `v3ready`。

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
