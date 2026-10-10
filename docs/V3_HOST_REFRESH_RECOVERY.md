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
