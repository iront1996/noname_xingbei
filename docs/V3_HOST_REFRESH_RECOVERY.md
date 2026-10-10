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

## 權威狀態安裝準備與事件安全性（本輪最新進展）

本輪在上述原生物件預建之上，完成了**仍不會啟動遊戲**的完整預備流程：

1. `game/v3-serialization-integrity.mjs`：審查 `get.stringifiedResult` 與實際 JSON 存檔前後的資料欄位完整性；若深層已定義欄位因預設深度 8 截斷、JSON 陣列有 undefined、事件／函式參照不可恢復，則拒絕候選資料。一般物件中的 undefined 屬性仍遵守原定「省略並計數」政策。
2. `game/v3-recovery-vault.mjs`：在加密候選資料前比對 arena、skillState 與每名玩家的 stat/actionHistory/skipList；新增 `structuralAudit` 覆蓋標記。嚴格檢查可能使複雜對局的候選資料**無法儲存**，這是刻意的 fail closed，不應改成假陽性。
3. `game/v3-skill-references.mjs`：只將序列化的 `_noname_player` / `_noname_card` 參照還原到**隔離環境內原生物件**；拒絕任意 `_noname_func`、`_noname_event`、`_noname_vcard` 與找不到的參照；所有玩家成功驗證後才一次套用技能與歷史資料，失敗則回滾。
4. `game/v3-detached-zones.mjs`：在畫面外的 Player 子節點組裝原手牌、裝備、判定與擴充區；將原抽牌堆、棄牌堆依原始順序放到隔離 DocumentFragment；任何不一致不觸碰正式畫面。
5. `game/v3-host-registry-transaction.mjs`：建立原玩家、死亡角色、原卡牌和**停用遠端 Client** 的影子權威註冊表。可在測試用注入環境執行「同步安裝 → 核對 → 還原所有原有 property descriptor」的回滾乾跑；**沒有呼叫正式的 game/lib 全域物件永久安裝**。
6. `game/v3-owner-connection.mjs`：在既有房主驗證之後依序串接物件、技能、卡牌區域與影子註冊表預備流程。成功與失敗均不呼叫 `v3resume`、`v3ready`，也不解除其他玩家等待。
7. `tools/deploy-v3-playtest.sh`：限定更新 `xingbei-hall-v3.service` / 8081 的部署腳本，新增服務重啟後 TCP 8081 健康檢查，未就緒時自動回滾。V1 / V2 / 正式 tunnel 不動。

### 已通過的隔離模擬回歸測試

- 原玩家 socket 驗證與牌堆／座位藍圖：6 個案例。
- 原生 Player/Card/NodeWS/Client 的隔離預建：6 個案例。
- 技能參照還原、禁止執行式參照、回滾：6 個案例。
- 序列化截斷與未定義欄位政策：6 個案例。
- 影子註冊表／測試環境屬性描述符回滾：5 個案例。
- 合計 29 個獨立測試案例由 JavaScript 隔離 harness 驗證。由於當前執行容器無法連接 GitHub，尚未在真實瀏覽器與此 VPS 上執行完整 Node / WebSocket / DOM 整合測試；不可稱為實際續局驗收。

### 仍然無法續局的原因

原房主刷新後的 **GameEvent 執行堆疊、未完成 async/Promise、技能結算副作用、等待中的遠端操作與精確回應順序**沒有可靠的可重建事件日誌。只有隔離物件與影子註冊表尚不足以重啟權威遊戲。

目前不應以 `v3ready` 解除等待。後續必須設計與實作可靠事件續行／重播及重建後與各玩家的 revision/ack 同步。所有遊戲效果都必須證明不重複、不遺漏。

## 原分頁權威身分證明（最新安全修正）

在最新 V3 Playtest 中，**原分頁網路暫斷**與**房主重新整理後**不再使用同一張通行證：

- VPS 專用 8081 的 `room.ownerToken`（256-bit）可存在房主 `sessionStorage`，只供暫停房間查詢、原玩家 socket 核對、或主動結束無法恢復的舊房間。
- VPS 在建立房間時另外產生 `room.runtimeTicket`（獨立 256-bit）。房主只保留於 `game/v3-owner-connection.mjs` 的 JavaScript module heap **局部變數**。嚴禁寫入 `sessionStorage`、`localStorage`、IndexedDB、加密快照、日誌或對其他玩家廣播。
- 原分頁短暫斷線後執行 `server/v3resume(roomId,ownerToken,runtimeTicket)`，兩份都有效才可重新接管原 Socket；成功後兩份隨機憑證都輪替。
- 只允許新接管 Socket 以**新 runtimeTicket** 回覆 `server/v3ready` 才能解除玩家等待；持舊 ticket 的封包不生效。
- 房主刷新後，JS module heap 已經銷毀，沒有 runtimeTicket；即使 sessionStorage 仍有原 ownerToken，伺服器也應拒絕直接 `v3resume`。但經 ownerToken 驗證的 `v3restoreprobe` 仍可取得原 socket 名單供後續真正冷啟動恢復使用。
- 新增 `tools/test-v3-runtime-ticket.cjs`，包含原房主原分頁合法續線、只持久化 ownerToken 的刷新分頁被拒、冒名 ticket 被拒、憑證輪替、舊 ticket 無法解除等待，以及原房主冷恢復 preflight 不觸發續線，共 5 項自動化 regression。

**尚未解決的核心問題：**刷新後完整重建並續行 `GameEvent` / Promise / 選擇／技能效果、阻止重複結算及各個客户端的一致性核對。雙憑證只防止錯誤續線，不代表已實作完整刷新續局。

**相容性注意：**此協定將 `v3resume`、`v3ready` 改為帶有 JS heap ticket 的新版本，前端與 VPS 必須同時更新。跨版本舊分頁不能被視為已驗證可靠恢復，更新部署將終止既有 V3 測試房間。V1、V2、原 V3 及生產用 8080 不受影響。

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


## 2026-10-10：快照保存健康診斷與獨立候選盤點（V3 Playtest 前端）

本輪僅變更 `feature/host-reconnect-v3-playtest` 的 V3 相關模組及回歸測試；**未改 VPS、V1/V2 或生產用 8080**。

- 新增 `game/v3-capture-observability.mjs`：捕捉前執行可明確分辨房主資格、連線、對局啟動、牌堆、玩家映射與引擎 getter 的唯讀檢查。無法擷取時不再無聲跳過；房主在進行中的對局會留下受白名單限制的原因碼。
- `game/v3-recovery-vault.mjs`：候選資料成功、拒絕、擷取／加密／儲存失敗時，只把狀態碼、原因碼、種類與時間存入**同分頁 sessionStorage**，供重新整理後顯示。絕不儲存原始牌、手牌、Socket/Player ID、Token 或 WebCrypto 密鑰在診斷記錄中。資料限期 10 分鐘，跨房間不混用。候選加密資料仍放 IndexedDB，金鑰仍維持既有 sessionStorage 設計。
- 新增 `game/v3-candidate-inventory.mjs`：定期快照與回合邊界快照獨立驗證。任一份沒有保存／過期／無法解密，不應直接隱藏另一份。驗證僅回傳狀態、時間差及人數，不回傳明文。若只有回合邊界候選有效，可進行既有**只讀**的 VPS 原玩家 socket 核對，絕不解開暫停。
- `game/v3-owner-connection.mjs`：房主原頁新增「V3 測試：檢查本機快照」按鈕，顯示不含個資的保存狀態及原因。重新整理後即使沒有任何候選，也能顯示最近的保存結果。修正回合邊界候選單獨存在時的誤判。
- `game/v3-host-runtime-stager.mjs`：移除頂層瀏覽器引擎引用，改由前端明確注入 native classes/DocumentFragment；既有模擬 native 測試可直接在 Node.js 執行。
- 新增 `tools/test-v3-capture-observability.mjs`、`tools/test-v3-candidate-inventory.mjs` 與 V3 專用 GitHub Actions workflow，驗證 fail-closed 條件、候選獨立性、過期、資料損壞與保密性，並對全部 V3 相關程式進行語法檢查。

**仍未實作／禁止宣稱完成：**任何全域權威物件安裝、事件或 Promise 續行、掉線技能結算、切換房主、玩家狀態同步與 `v3ready`。目前所有候選繼續是 `restorable:false`，安全協定保持雙憑證；切勿因為看見 `ENCRYPTED_CANDIDATE_VERIFIED` 就解除暫停。

**下一項真實瀏覽器證據**：在 V3 預覽四人對局中等待大於 10 秒，房主檢查快照健康，記錄狀態碼、原因碼和兩種候選驗證結果（不截取手牌／金鑰），確認 UI 有導入最新版。此測試不是刷新續局驗收，不應額外重啟 VPS。


## 2026-10-10：PEER_COUNT_MISMATCH 真實對局診斷與修復候選

使用者在 V3 Playtest 遊戲中按下「V3 測試：檢查本機快照」後，畫面實測：

```text
最近擷取：CAPTURE_FAILED
原因碼：PEER_COUNT_MISMATCH
定期候選：NOT_FOUND
回合邊界候選：NOT_FOUND
```

引擎機制：`game.randomMapOL()` 會把實際連線的 `lib.node.clients` 指派給部分 `game.players`，其餘未配置真人的座位會由引擎配置玩家 ID。舊版 `v3-recovery-vault.mjs` 強制 `guestBindings.length === ids.length - 1`，錯誤地假定每個非房主座位都有真人 Socket。**截圖沒有揭露當時真人玩家數，不能單憑圖片判斷具體有幾個 AI 座位。**

本次 V3-only 修正：
- `game/v3-peer-topology.mjs`：每個仍連線客端都必須已初始化、未關閉、不在觀戰名單，且 `Client.id === NodeWS.wsid === playerId` 及 `lib.playerOL[playerId].ws === client`。重複或異常 socket fail closed。
- 沒有 `Player.ws` 的其餘非房主座位明列 `botPlayerIds`，不虛構 Client。若原真人仍有殘留 `Player.ws` 而不在 guest roster，直接拒絕；至少要有一個真人 guest 才符合 VPS probe 規則。
- 本機加密候選同時保存 `peerBindings` 與 `botPlayerIds`；不向伺服器／UI 洩漏 ID、手牌或密鑰。
- `v3-host-authority-gate.mjs` 必須嚴格比對 VPS 仍連線 guest IDs、真人綁定與 AI 座位，所有非房主座位須被恰好覆蓋一次。
- `v3-rehydration-blueprint.mjs`、`v3-host-runtime-stager.mjs` 與 `v3-host-registry-transaction.mjs` 支援混合座位：真人分配停用的遠端 Client，AI 只分配原生 Player。全部維持 `readyToResume:false`，禁止呼叫 `v3ready`。
- 新增 `tools/test-v3-peer-topology.mjs` 以及 AI preflight/native/registry 測試，並加入整合防退化測試。
- 前端動態匯入版本更新為 `v3-peer-topology-3`，避免載入過期快取。

仍待真實瀏覽器驗證：該局配置下 `PEER_COUNT_MISMATCH` 是否消失、後續是否還存在 `CANDIDATE_STRUCTURE_LOSS` 等其他擷取拒絕條件、Cloudflare Pages 是否確實部署新版本。**本輪沒有修改或部署 VPS，亦未修改 V1/V2。** 快照依然不是可執行續行點，重新整理後仍須保持暫停。


## 2026-10-10：玩家歷史序列化實測阻斷及 V3 診斷細化

繼上一輪修正真人／AI 映射後，使用者在 V3 遊戲中測得：

```text
最近擷取：CAPTURE_FAILED
原因碼：PLAYER_HISTORY_STRUCTURE_LOSS
定期候選：ENCRYPTED_CANDIDATE_VERIFIED
回合邊界候選：NOT_FOUND
```

可確認至少一份較早的定期快照加密及解密驗證成功；但最近一次擷取在玩家歷史完整性稽核被拒，已存在的候選不可誤認為當下完整快照。既有 `get.stringifiedResult` 在遞迴深度 8 時可能截斷欄位，且 `Player.actionHistory` 可能包含尚有作用中的 `GameEventPromise`；**當前沒有足夠現場資訊判定最先觸發的是 `stat`、`actionHistory` 或 `skipList`，也不能斷言一定是 Event**。

新增 V3-only `game/v3-player-history-audit.mjs`：對 `stat`、`actionHistory`、`skipList` 分別進行既有嚴格完整性驗證，第一次失敗只回傳有限白名單原因碼（如 `HIST_ACTION_LIVE_EVENT_NOT_RESTORABLE`、`HIST_ACTION_DEFINED_FIELD_TRUNCATED` 或 `HIST_STAT_EXECUTABLE_FUNCTION_NOT_RESTORABLE`），絕不回傳玩家 ID、手牌、事件內容或例外原始字串；無法驗證的玩家歷史不會保存為完整候選。**沒有放寬任何可恢復檢查，也沒有把 Event 當作續行紀錄。**

`game/v3-recovery-vault.mjs` 進一步把最近定期擷取與回合邊界擷取各自的狀態碼記錄在房主同分頁 `sessionStorage`，並只顯示目前快照保存的年齡。若 `lib.onphase` 觸發、但事件堆疊並非符合條件的 `phaseLoop` 或有待處理子事件，保守回報 `BOUNDARY_EVENT_OUTLINE_UNAVAILABLE`／`BOUNDARY_PENDING_CHILD_EVENTS`，不進行回合邊界擷取。

`game/v3-owner-connection.mjs` 的 V3 房主快照健康畫面現在另外顯示：
- 前端版本 `v3-history-diagnostics-5`；
- 最近擷取與原因碼；
- 定期／回合邊界各自最近嘗試狀態與有限原因碼；
- 加密定期候選驗證結果與年齡、回合邊界候選驗證結果。

動態 import 版本只在 `feature/host-reconnect-v3-playtest` 更新，主頁與房主程式共用相同模組 URL。新增 `tools/test-v3-player-history-audit.mjs` 的純函式回歸，涵蓋可保存結構、Event 拒絕、深度截斷、函式拒絕、缺少欄位與例外保密。全程 **V1/V2、VPS 8081、production 8080 均未修改**。

**下一次實測門檻：**必須在 V3 預覽版開始一場新遊戲並確定健康畫面顯示 `v3-history-diagnostics-5`，讓對局進行一段時間並至少走到新回合的 `phaseLoop`，截圖完整健康檢查狀態。這是資料診斷驗收，不是重新整理後續局驗收；禁止對未經認證的事件傳送 `v3ready`。


## 2026-10-10：房主刷新後被舊房間阻擋，無法重新開房

使用者實測刷新原房主網頁後，看到 `原房間仍被保留` 與 V3 `v3createblocked` 的純文字遮罩，沒有安全結束房間入口。

已確認是前端 UI 死角，**不是可任意覆蓋伺服器舊局的錯誤**：

- V3 broker `server/create` 會拒絕在舊房號還存在時創建新房間。
- V3 broker `server/v3roomstatus` 可在有效 `onlineKey`＋`ownerToken` 且舊房暫停時回報 `owner_disconnected`；無憑證、舊房有人控制或憑證無效都回報 `not_available`，房間不存在才回報 `room_absent`。
- V3 broker `server/v3abandon` 已存在，要求原房主 `onlineKey`＋256-bit `ownerToken`、目前無房間及舊局暫停，且會在成功時回傳 `v3roomabandonedHost` 並通知等待中的客端。本輪未調整任何 VPS 服務。

新增 `game/v3-stale-room-policy.mjs`；更新 `game/v3-owner-connection.mjs`：

1. `v3createblocked` 不再顯示無按鈕死局：自動要求伺服器確認舊房間狀態，並可手動重新檢查。
2. 有有效 Token 且收到 `owner_disconnected` 才顯示現有「結束無法恢復的舊房間」按鈕；使用者仍須確認後才送出 `server/v3abandon`。
3. **等待 `v3roomabandonedHost` 確認**才清除本機房主 Token／加密候選，並引導返回大廳；清理 `tmp_owner_roomId`、`tmp_user_roomId` 及回連記錄的房號，避免重載後重試錯誤的舊房間。
4. 如果 Token 遺失、房間還未暫停或身分驗證未通過，只提供讀取狀態和重查，不會強行刪房。舊房在房主斷線後的保留期限（180 秒）結束會由伺服器清除，再查詢可確認 `room_absent` 並返回大廳。
5. `v3resumerejected("abandon_denied")` 會顯示「舊房間沒有被刪除」並允許重查，不會假裝成功。
6. V3 Playtest owner 模組版本參數更新 `v3-stale-room-unlock-6`，但共用的 vault 模組維持一致路徑及已驗證的安全快照協定。

測試：
- `tools/test-v3-runtime-ticket.cjs` 新增有／無 Token、持錯誤 Token、房主仍在線、已暫停房間可驗證結束及重新開房，並涵蓋**尚未開局、沒有其他玩家時刷新房主**。
- `tools/test-v3-stale-room-policy.mjs`、`tools/test-v3-blocked-create-ui.mjs` 驗證 UI 不會在未經確認的狀態允許刪房，必須收到 V3 伺服器 ack 才清除憑證及返回大廳。
- V3 原房主刷新後的**完整遊戲續局仍未實作**，不曾強制送出 `v3resume`、`v3ready`，不宣稱可恢復原局。
- VPS 8081、V1、V2、production 8080 沒有變更。

下一輪可由使用者單獨驗證前端舊房間清理，不必找其他玩家：用 V3 Playtest 新開空房、同分頁重新整理、確認看到 `stale-room-unlock-6` 及可結束舊房間，確認結束後回大廳可開新房。若沒有 Token，應只出現重查及等待期限；**不要透過 Console 編造 Token 或刪除伺服器資料**。


## 2026-10-10：V3 History diagnostics 現場回報後的事件觀測邊界

使用者回報已完成「重開房間」實測（未提供操作細節），並在 V3 前端 `v3-history-diagnostics-5` 的遊戲中取得：

```text
最近擷取：CAPTURE_BLOCKED
原因碼：BOUNDARY_PENDING_CHILD_EVENTS
定期最近：CAPTURE_FAILED / HIST_ACTION_LIVE_EVENT_NOT_RESTORABLE
邊界最近：CAPTURE_BLOCKED / BOUNDARY_PENDING_CHILD_EVENTS
定期候選：NOT_FOUND
回合邊界候選：NOT_FOUND
```

已在原生引擎核對：
- `noname/library/element/content.js` 中 `phaseLoop` step 1 先執行 `lib.onphase` 再呼叫 `player.phase()`。此時有回合切換時機，**不等於 event stack、祖先排隊的 next/after、Promise 後續或局部回呼均已完成**。
- `noname/library/element/gameEvent.js` `GameEvent.start()` 是非同步執行，進入 `eventStack` 並在 `loop()` 完成後退出；`event.finished` 是事件旗標，**不等同於 Promise 已結算或可重新執行**。
- `Player.actionHistory` 會容納 `GameEventPromise` 參考；嚴格的 `auditV3Serialization` 會拒絕任何 `_noname_event:` 參考作為可續行事件。不能刪除、放寬或直接將這些引用轉回會執行的 GameEvent。

本輪提交新 `game/v3-event-observation-preflight.mjs` 及 `tools/test-v3-event-observation-preflight.mjs`：
- 只看結構、只回傳固定代碼，不向伺服器／UI 輸出事件本體、手牌、玩家 ID、函式或 Promise；歷史掃描有節點／深度限制，且在事件引用處停止。
- 區分 `HIST_ACTION_EVENT_ACTIVE_STACK`（歷史 Event 仍在活躍執行堆疊）、`HIST_ACTION_EVENT_NOT_FINISHED`（未標記完成）、`HIST_ACTION_EVENT_FINISHED_ONLY`（有 finished 旗標但絕非續行憑證）。其他無法驗證資料仍拒絕擷取。
- 回合觀測時同時檢查祖先 `next` **與 `after`** 是否排隊，若有則回報 `BOUNDARY_ANCESTOR_WORK_PENDING`；Event 堆疊缺失、形狀不符等維持 fail closed。
- 以上每個欄位仍經原嚴格完整性稽核，**沒有啟用真正冷續局**；`safeCheckpointCertified:false`、`eventContinuationCaptured:false`、`restorable:false`、`v3ready` 不會因為這些觀測改變。
- V3 Playtest 共用 vault 模組的兩處 import 與 owner UI 載入版本更新成 `v3-event-observation-7`。僅 GitHub V3 預覽分支；**VPS、V1、V2 均未更新**。

下一個現場證據：新的 V3 對局開始後待至少 15 秒並跨過一次回合轉移，房主按本機快照健康檢查，確認畫面「前端版本：v3-event-observation-7」，回傳固定代碼。無須重新整理房主或額外招募玩家。此測試用於選擇後續歷史引用／事件執行序列化工程，不是恢復原局驗收。
 
## 2026-10-10：截圖更正與版本誤判修正

使用者更正先前誤傳的畫面。正確截圖**同時**顯示
`房主 UI 版本：v3-event-lifecycle-8` 與
`快照程式版本：v3-event-lifecycle-8`，兩個模組版本一致。
因此撤回之前的「前端 UI／快照版本不一致」診斷，不能歸因於 Cloudflare Pages 快取或部署先後。

正確現場結果：
```text
最近擷取：CAPTURE_BLOCKED
原因碼：BOUNDARY_ANCESTOR_WORK_PENDING
定期最近：CAPTURE_FAILED / HIST_ACTION_EVENT_FINISHED_ONLY
邊界最近：CAPTURE_BLOCKED / BOUNDARY_ANCESTOR_WORK_PENDING
定期候選：NOT_FOUND
回合邊界候選：NOT_FOUND
```

針對**誤判版本不一致**加入的以下變更已精準回退：
- 移除 `V3_CAPTURE_IMPLEMENTATION_VERSION` 與 `V3_OWNER_INTERFACE_VERSION` 額外常數。
- 健康檢查恢復單一版號文字（`v3-event-observation-7`），`mode/connect.js` 及 owner 模組的兩個 vault import 亦恢復當時共用的 `v3-event-observation-7` URL。
- 刪除只用於雙版本 UI 的 `tools/test-v3-runtime-build-contract.mjs`。原有 `tools/test-v3-module-load-invariants.mjs` 仍持續守護 vault import 的同一 ESM 實例。

**保留與誤判無關的安全修正：**
- `game/v3-event-observation-preflight.mjs` 避免執行自訂 getter、拒絕展開 Card/Player 的內部資料；歷史資料掃描保有深度限制與無敏感資料輸出。
- `game/v3-inert-history-reference-index.mjs` 的隔離實驗及相關測試不會建立可執行事件、亦不能解除 `readyToResume:false`。
- 所有快照仍維持 `safeCheckpointCertified:false`、`eventContinuationCaptured:false`、`restorable:false`，不會直接調用 `v3ready`。

**正確後續工程：**修正 `actionHistory` 的事件引用與續行模型，並設計可證明祖先佇列無待處理工作的一致檢查點，不因 `finished` 旗標存在就認定 Promise 已結算。僅修改 V3 Playtest GitHub 分支，VPS、V1、V2 均不動。


## 2026-10-10：事件 Promise 生命周期記錄與 History 引用對照（V3 only）

本輪根據使用者更正後的圖片進行研發，不再把版本不同步當成錯誤：
```text
房主 UI 版本：v3-event-lifecycle-8
快照程式版本：v3-event-lifecycle-8
定期最近：CAPTURE_FAILED / HIST_ACTION_EVENT_FINISHED_ONLY
邊界最近：CAPTURE_BLOCKED / BOUNDARY_ANCESTOR_WORK_PENDING
加密定期候選：NOT_FOUND
加密邊界候選：NOT_FOUND
```

原生引擎 `GameEvent.finish()` 只修改 `finished` 旗標；`start()` 會啟動非同步 `loop()`、等待 `waitNext()` 內的子事件完成，再讓原本的 Promise settle。`finished` 為 `true` **並不等於** 已觀測到完整 Promise settlement。即使觀測到 Promise fulfilled，舊的 closures、尚未註冊的 callbacks、UI 選擇結果與遊戲非同步副作用仍未被捕捉。

本輪已加入：

- `game/v3-event-lifecycle-journal.mjs`：V3 專用、可安裝／移除的被動觀測器，包住原生 `GameEvent.prototype.start`、立即回傳**完全相同的 Promise 物件**；只記錄事件匿名序號與 `started / fulfilled / rejected / threw`，不干預執行順序或判定。事件身分用 `WeakMap`；每個房間獨立觀測 epoch，避免前一房間 Promise 在新局亂入。有限緩衝、溢位 fail closed。
- `game/v3-inert-history-reference-index.mjs` 的歷史位置／同一引用索引新增可選的 `settlementLookup`：對照同一 Event 的真實觀測紀錄。如果沒有追蹤到 `start`、Promise 尚未 fulfilled、rejected 或 ordinal 不一致，一律拒絕「歷史索引關聯成立」。即使完全對上，該索引仍 `restorable:false`、`readyToResume:false`，不能反向啟動或還原 Event。
- `game/v3-recovery-vault.mjs` 於 V3 Connect 初始化時安裝上述被動 observer，僅在原房主正式遊戲期間收集 metadata。快照 `eventObservation.lifecycle` 包含匿名狀態統計，不含任何玩家 ID、手牌、技能、事件名稱及 Token。增加 `getV3HistoryReferenceLinkHealth` 與 `getV3EventLifecycleHealth` 兩個唯讀 API。
- `game/v3-owner-connection.mjs` 的房主健康檢查多顯示 `事件 Promise 觀測`／`歷史事件引用` 結果與整數計數，並再次說明沒有完整續行認證。**這不是恢復原局功能驗收**。
- 兩個入站動態 import 和 owner -> vault import 共用 `v3-event-lifecycle-journal-9` 版本 URL，避免 ESM 重複實例；使用單行版號而非先前因誤傳圖片建立的雙版號比較 UI。
- `tools/test-v3-event-lifecycle-journal.mjs` 覆蓋 Promise 身分不變、resolve/reject/throw、換房 epoch、重複 start、不完整涵蓋、匿名性、溢位、移除觀測器後還原原函式；`tools/test-v3-inert-history-reference-index.mjs` 覆蓋已完成 Promise 與缺漏／未完成／拒絕／異常 ordinal 的對應；並加入 V3 模組整合防退化測試。

**未實作事項：**本版本的紀錄僅保存在活躍分頁記憶體中，**尚未是可重播或可持久保存的事件日誌**。擷取雖可附上匿名統計，但歷史序列化仍因 Event 引用被拒；回合邊界依然有祖先工作待處理。原房主刷新不能接續原局；保持 `safeCheckpointCertified:false`、`eventContinuationCaptured:false`、`restorable:false`、`readyToResume:false`，嚴禁因觀測到 promise fulfilled 就調用 `v3ready`。

**下一步實際瀏覽器驗收（不需更新 VPS）**：等 Cloudflare Pages V3 預覽版載入新版後，由原房主與至少一位玩家使用新房間開始遊戲，至少進行兩個回合，點開「V3 測試：檢查本機快照」，截圖含 `前端版本：v3-event-lifecycle-journal-9`、`事件 Promise 觀測`、`歷史事件引用` 的視窗，並說明是否仍可正常出牌、換回合。不要刷新房主，也不要結束仍有玩家進行中的對局。


## 2026-10-11：V3 事件觀測實測（journal-9）及 History SkillLog 格式修復

房主實際遊戲中看到：

```text
前端版本：v3-event-lifecycle-journal-9
事件 Promise 觀測：OBSERVATION_OVERFLOW
開始 759 / 已完成 750 / 失敗 0 / 待觀測結束 9
歷史事件引用：HISTORY_ENTRY_NOT_EVENT
定期最近：CAPTURE_FAILED / HIST_ACTION_EVENT_ACTIVE_STACK
邊界最近：CAPTURE_BLOCKED / BOUNDARY_ANCESTOR_WORK_PENDING
定期候選：NOT_FOUND / 邊界候選：NOT_FOUND
```

因 `GameEvent.start` 被動觀測器的內存環形佇列僅有 512 筆轉移容量，759 次 start 加上 750 次 settle 必然使舊的匿名轉移紀錄移出環形佇列；**這不等於 9 筆仍未完成的 Promise 就是丟失資訊或可直接續局**。另外只要未完成的 Event 同時超過容量，無法再追蹤新的事件，必須另外回報。已在 `game/v3-event-lifecycle-journal.mjs` 區分：
- `OBSERVATION_RING_TRUNCATED` + `truncatedTransitions`：僅代表有限的匿名診斷環形紀錄輪替，WeakMap 裡已觀測的事件 Promise 結果仍可檢索，**不具備完整事件回放資訊**。
- `OBSERVATION_CAPACITY_EXCEEDED` + `droppedStarts`：大量**同時未結算事件**用完追蹤槽位，確實無法觀測所有新事件，仍 fail closed。
- 上述情形的 `completeCoverage`、`eventContinuationCaptured`、`restorable`、`readyToResume` 一律維持 false；不調用任何房主續局或事件重啟。

已從真實原生引擎 `noname/library/element/player.js` 的 `logSkill` 與 `noname/library/element/content.js` 的 `useSkill` 實作確認：`actionHistory.useSkill` 可以保存 **`logInfo = {skill, targets, event, sourceSkill?, type?}` 普通物件**，而不是直接保存 GameEvent。舊的 `v3-inert-history-reference-index.mjs` 把所有 useSkill 元素都當 Event，便會回報 `HISTORY_ENTRY_NOT_EVENT`。新版為 `useSkill` 增加嚴格的 logInfo 驗證，不輸出技能名稱、目標或玩家識別；僅索引經原生 `itemtype` 證實的內層 `event`，並以 WeakMap 維護跨 history bucket 的相同 Event 引用關係。未知欄位、錯誤 targets、getter、自訂型別、已在活躍事件堆疊的事件依舊拒絕。元資料另允許原生引擎使用的 `isSkipped === true`。

健康檢查新增 `事件紀錄環形截短`／`無法追蹤的新事件` 整數，並版本釘選 `v3-history-skilllog-10`（Owner 模組與 Vault 共享相同 ESM 實例）。新增原生形狀 logInfo、重複引用、錯誤欄位、active Event、getter 不執行、環形紀錄回轉與超出同時進行中事件上限的回歸。

**不宣稱解決的項目：**目前定期快照仍因 `HIST_ACTION_EVENT_ACTIVE_STACK` 失敗，回合邊界仍因 `BOUNDARY_ANCESTOR_WORK_PENDING` 被拒。這是安全性要求，不能靠降低檢查要求來清除。現有候選仍不可用，完整冷重連仍未開放。

**下一步瀏覽器測試**：原房主新開 V3 Playtest 對局，至少兩人正常進行出牌和技能，等待 15 秒以上並至少換一次回合，健康檢查需顯示 `v3-history-skilllog-10`。檢查是否把原本的 `HISTORY_ENTRY_NOT_EVENT` 變成其他更具體的歷史型別或 Event 狀態碼、是否顯示 `OBSERVATION_RING_TRUNCATED` 而非誤導的 `OBSERVATION_OVERFLOW`。不要重新整理房主或試圖強制執行舊局。


## 2026-10-11：V3 Playtest-10 真實事件觀測與安全切點佇列稽核

使用者房主畫面回報：

```text
前端版本：v3-history-skilllog-10
事件 Promise 觀測：OBSERVATION_RING_TRUNCATED
開始 782 / 已完成 773 / 失敗 0 / 待觀測結束 9
歷史事件引用：HISTORY_EVENT_IN_ACTIVE_STACK
事件紀錄環形截短：1043 / 無法追蹤的新事件：0
定期最近：CAPTURE_FAILED / HIST_ACTION_EVENT_FINISHED_ONLY
邊界最近：CAPTURE_BLOCKED / BOUNDARY_ANCESTOR_WORK_PENDING
定期候選：NOT_FOUND / 回合邊界候選：NOT_FOUND
```

證據：原本的 `HISTORY_ENTRY_NOT_EVENT` 不再出現，表示 `useSkill.logInfo` 實作於該次實測通過格式檢查。環形紀錄截短代表 512 筆匿名轉移紀錄已輪替；`droppedStarts=0` 表示觀測器沒有因**同時未結算的事件數達容量上限**而捨棄新的開始紀錄。這仍**不保證**涵蓋安裝觀測器之前的事件、Promise 以外的所有計時器和遠端選擇。

`HISTORY_EVENT_IN_ACTIVE_STACK` 是執行中歷史引用，不得被轉成已完成日誌；`HIST_ACTION_EVENT_FINISHED_ONLY` 表示只是歷史事件有 `finished` 旗標，與 Promise 或技能副作用安全重播無法畫上等號。`BOUNDARY_ANCESTOR_WORK_PENDING` 需區分祖先排隊 `next` 與 `after`，不能只靠回合切換鉤子宣稱安全。

新增純函式 `game/v3-event-cut-audit.mjs`：
- 唯讀稽核可見的 `GameEvent.manager.eventStack`，只讀取各 Frame 自有的 `next/after/finished/name` 資料欄位，排除 getter 呼叫，限制堆疊深度與佇列數量。
- 對祖先及當前 frame 分別回報匿名的 `next`、`after` 計數，區分 `CUT_ANCESTOR_QUEUES_PENDING`、`CUT_CURRENT_QUEUES_PENDING`、`CUT_NOT_PHASE_LOOP` 及 `CUT_VISIBLE_QUEUES_EMPTY_NOT_CERTIFIED`。
- 即使觀測到零佇列，也保持 `completeCoverage:false`、`safeCheckpointCertified:false`、`eventContinuationCaptured:false`、`restorable:false`、`readyToResume:false`；此結果是**負面阻斷證據，不是安全恢復許可**。
- `game/v3-recovery-vault.mjs` 的原生 `lib.onphase` callback 另外同步保存**當下**的匿名切點統計（僅內存），以原房主 `game.ws` 及 roomId 綁定，避免在點擊健康檢查時因為時序已移動而錯判上次回合邊界；UI 不顯示 roomId、Socket、玩家名稱。
- 房主健康檢查分別顯示點擊當下「事件切點／祖先佇列」及「上次換回合切點／換回合祖先佇列」，便於識別實際排隊類型。
- 前端載入版本 `v3-event-cut-audit-11`，owner 和 vault 共用相同版本化 ESM 實例。自動化測試涵蓋不安全 queue、不存在/超長堆疊、getters、隱私、切點被保守拒絕，以及 hook 的同步取樣先於既有 `inspectV3TurnBoundaryStack` 和重新整理未開放的事實。

**此版本只是切點工程的安全診斷基礎，沒有可恢復事件的錄製、重放或 checkpoint 安裝。** V1/V2 和 VPS 未變更。下一步須由原房主新開 V3 Playtest 對局、至少換一次回合，檢查健康視窗是否載入 `v3-event-cut-audit-11`，並傳回「上次換回合切點／換回合祖先佇列」的結果。測試期間請勿重新整理房主，亦不可強制 `v3ready`。


## 2026-10-11：V3 切點與真人 Socket 回連證據（Playtest-11 → Playtest-12）

房主實際回報 `v3-event-cut-audit-11`：

```text
Promise 觀測：OBSERVATION_RING_TRUNCATED / 開始 738 / 完成 734 / 失敗 0 / 待觀測結束 4
歷史引用：INERT_HISTORY_REFERENCE_INDEX_READY / 引用 34 / 重複引用 2
點擊時切點：CUT_NOT_PHASE_LOOP / 祖先 next 4 / after 0；當前 next 0 / after 0
上次換回合切點：CUT_ANCESTOR_QUEUES_PENDING / 祖先 next 1 / after 0；當前 next 0 / after 0
定期最近：CAPTURE_FAILED / PEER_BINDING_INCOMPLETE
邊界最近：CAPTURE_BLOCKED / BOUNDARY_ANCESTOR_WORK_PENDING
定期候選：ENCRYPTED_CANDIDATE_VERIFIED（約 33 秒前）；邊界候選：NOT_FOUND
```

**待修正的兩個邏輯假設：**

1. 在原生引擎 `lib.message.server.init(version,config)` 的 `config.id` 回連分支，`Client.id` 會恢復舊的 `playerid`，但 `NodeWS.wsid` 是 broker 新分配的 Socket 識別。因此原 V3 `client.id === client.ws.wsid` 的約束遇到重連會拒絕。然而原生 `config.id` 並非由 V3 broker 用不可偽造的重連憑證綁定；若放寬為只要求 `player.ws === client`，可能讓不受信任的連線宣稱既有玩家 ID，因此絕不可直接解除驗證。
2. `GameEvent.waitNext()` 在 `await next.start()` 期間仍保留 `this.next[0]`，等子事件完成才 shift。因而上次回合邊界 `祖先 next 1` 可能是**正在執行的 phaseLoop 子事件**，不代表獨立於正在執行事件之外的第二個排程工作，也更不代表該階段可以從冷啟動恢復。

本輪 V3-only 前端修正：

- `game/v3-peer-topology.mjs` 精確拆分 `PEER_OBSERVER_PRESENT`、`PEER_CLIENT_CLOSED`、`PEER_CLIENT_NOT_INITIALIZED`、`PEER_SOCKET_REBOUND_UNVERIFIED` 與既有不合法映射；**遇到 guest playerId 不同於其新 Socket ID 時仍 fail closed**。現有 `v3-host-authority-gate.mjs`、native stage／shadow registry 的嚴格相等條件都保持不動。這是診斷改進，並非正式支援重連後的冷續局。
- `game/v3-event-cut-audit.mjs` 針對每個祖先 `next[0]`，只使用屬性描述符比對是否為當下堆疊的直接子事件，新增 `activeLineageNext`（正在執行的子事件引用）與 `additionalAncestorNext`（真正額外的 next 工作）兩個匿名計數。額外 queued next / after 存在仍為 `CUT_ANCESTOR_QUEUES_PENDING`；若只有被 await 的活躍子事件，回報 `CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED`，**絕不標記安全**。
- 保留舊的 `inspectV3TurnBoundaryStack` 對未完成排程與所有 event continuation 的 fail-closed 行為，不因此開始儲存「安全可續行」回合快照。
- 健康檢查同時顯示即時與上次 `lib.onphase` 的祖先 next/after、活躍子事件與額外排隊數。Owner/Vault 動態匯入版本同步為 `v3-peer-cut-classification-12`。
- `tools/test-v3-peer-topology.mjs`、`tools/test-v3-event-cut-audit.mjs`、`tools/test-v3-peer-cut-integration.mjs` 對原生回連、觀戰、冒名 Socket、內建子事件、額外兄弟事件、accessor 不執行及安全閘持續關閉加上回歸。

**下一個工程安全邊界**：要讓 guest 原玩家在 Socket ID 重新分配後也能成為「受驗證的同一玩家」，必須有 broker 發行／校驗且綁定原玩家身分的重連證明，並同步調整 V3 broker 與 V3 前端。單靠前端的 `config.id` 不足以證明。這會是未來可能需要更新 VPS 的工作；目前不能假裝已有這個保證。

下一次 V3 真實對局只需要房主及至少一名其他真人，按「檢查本機快照」回傳 `v3-peer-cut-classification-12` 的「上次換回合切點」、「換回合祖先佇列」及定期擷取拒絕碼。現階段不要刷新房主試續局，V1/V2/VPS 均未修改。


## 2026-10-11：實測確認正常 phaseLoop 活躍子事件，V3 boundary-13 嚴格分類

實測前端 `v3-peer-cut-classification-12`：

```text
Promise：OBSERVATION_RING_TRUNCATED / started 514 / fulfilled 510 / rejected 0 / pending 4
歷史事件索引：INERT_HISTORY_REFERENCE_INDEX_READY / 引用 38 / 重複引用 6
即時事件切點：CUT_NOT_PHASE_LOOP / 祖先 next 4、活躍子事件 4、額外排隊 0、after 0
上次換回合：CUT_ACTIVE_LINEAGE_ONLY_NOT_CERTIFIED / 祖先 next 1、活躍子事件 1、額外排隊 0、after 0
定期：CAPTURE_FAILED / HIST_ACTION_EVENT_FINISHED_ONLY
邊界：CAPTURE_BLOCKED / BOUNDARY_ANCESTOR_WORK_PENDING
定期與邊界候選：NOT_FOUND
```

這確認舊邊界檢查把目前正在執行的 `phaseLoop` 子事件（仍保留於父事件 `next[0]`，直至 `GameEvent.waitNext()` 的 `await next.start()` 結束）當作「額外等待工作」，而較新、準確的 queue-cut audit 已顯示它其實是正常正在執行的父子關係。**但這絕非可立即 cold-resume 的檢查點**：父 Promise 仍停在 await，快照無法捕捉 closure、局部狀態及完整事件續行。

本輪 `v3-boundary-lineage-13`：
- `game/v3-event-observation-preflight.mjs` 的 `inspectV3TurnBoundaryStack` 直接共用已驗證的 `inspectV3EventCutQueues`，對「僅有正常活躍父子等待」保守回報 `BOUNDARY_ACTIVE_LINEAGE_AWAITING_COMPLETION` 並拒絕保存；真正有額外 `next`／`after` 任務仍回報 `BOUNDARY_ANCESTOR_WORK_PENDING`，而當前 `phaseLoop` 有待執行任務則回報 `BOUNDARY_CURRENT_WORK_PENDING`。
- 僅當可見事件堆疊及工作佇列均為空時才**准許走到後續嚴格快照稽核**，絕不因切點看似整潔而視為 `safeCheckpointCertified`。未完整序列化 `actionHistory` Event／Promise 仍 fail closed。任何狀態都不能憑這個檢查直接 `v3ready`。
- 新增純函式與 onphase 整合回歸測試，包括活躍子事件識別、額外兄弟／after 任務阻斷、getter 不執行、完整的 V3-only ESM 版本一致性。
- 入口、房主 UI 與 vault 共用 `v3-boundary-lineage-13` 的模組版本；未修改 VPS、V1 或 V2。

驗收：重新建立 V3 Playtest 對局（不要在活躍局刷新房主），至少切換一次回合並開啟房主快照健康檢查，確認「邊界最近：CAPTURE_BLOCKED / BOUNDARY_ACTIVE_LINEAGE_AWAITING_COMPLETION」。如因額外子事件或其他狀態回報不同代碼，請保留完整畫面供後續原生引擎分析。此測試只是驗證負面安全分類，不是 cold-resume 驗收。
