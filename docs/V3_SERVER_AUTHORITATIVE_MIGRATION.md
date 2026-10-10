# V3 方向調整：真正由伺服器主持星杯對局（Server-Authoritative）

狀態：技術設計與離線原型，**尚未啟用於現有 V3 Preview / VPS**。取代過去「每一版找真人測快照」的優先順序。2026-10-11。

## 產品需求

1. 開房玩家只在房間建立與等待階段設定規則／邀請玩家；**不是遊戲運算主機**。
2. 真正的房間、權威遊戲狀態與規則結算在遊戲伺服器。房主與加入玩家都具有同一種 session/reconnect 協定；離線玩家的座位可保留，其他玩家不因其 WebSocket 中斷而失去房間。
3. 服務端應驗證操作合法性、輪到哪個玩家行動、玩家身分、牌的持有權、技能效果與勝負；**客戶端只送意圖與顯示自己的投影狀態**。
4. 如果要連**伺服器進程崩潰／重新啟動**也能續局，就必須建立持久化權威狀態（例如事務式 database），僅將遊戲保存在 Node.js RAM 不夠。
5. 至少兩名真人可遊玩並經驗證；AI 座位、觀戰者及斷線後超時策略要明確規格化，不能偷當成真人連線。

## 已確認的現況，不可與目標混淆

- `game/v3-playtest-server.cjs` 目前管理房號、房主 token、WebSocket、玩家 socket、訊息轉送及 180 秒房主暫停；`room.owner` 是玩家 WebSocket，並不是遊戲邏輯處理程序。遊戲事件仍在房主瀏覽器。
- `mode/xingBei.js` 啟動流程依賴 `localStorage`、`ui.*`、`game.phaseLoop` 等瀏覽器上下文。
- `noname/library/element/player.js` 的 `Player extends HTMLDivElement` 並建立大量 DOM 元件；`gameEvent.js` 的 async Event 與 `content.js` 技能含選擇視窗、UI、持續 Promise。**不能只把 JS 檔案丟到 Node.js，就成為 headless 星杯引擎。**
- V3 第 21 版的 IndexedDB AES-GCM 本機資源證據不是權威遊戲快照，不含正確手牌／牌庫順序、技能狀態或事件續行。
- 目前既有的 `v3ready` + runtimeTicket 流程保護的是**原本還活著的房主引擎重連**。不得在沒有權威引擎和 state persistence 的情況下繞過它。

## 建議架構

```text
             玩家 A / 原開房者  ───┐
             玩家 B              ├── HTTPS/WSS ── VPS V3
             玩家 C              ┘                    │
                               Session & Seat Binding │
                          Authoritative Room Manager  │
                            XingBei Rules Reducer    │
                         Per-player Private Views    │
                        Durable Snapshot + Event Log │
                         Server-generated RNG        │
```

- WebSocket 連線／重連憑證只決定**有權提交哪個 seat 的操作**；不擁有房間。
- Client action = `{room,seat,sessionToken,expectedRevision,operationId,type,payload}`，`expectedRevision` 防止舊畫面提交；`operationId` 提供去重（不代表僅靠 Redis/記憶體即可達成持久化一次結算）。
- 狀態變化只由服務端 reducer 完成。`stateVersion` 與操作去重紀錄須跟狀態以**同一筆持久交易**寫入，才能避免「扣士氣／摸牌結算兩次」。
- `room.state` 要描述星杯**真的使用的資源**：紅／藍士氣、星杯、戰績區星石類型與順序、每人治療／能量／技能 marks、手牌／牌堆／棄牌堆**卡牌 ID 與順序**、當前行動、回應窗口、等待選擇、回合及亂數狀態。
- 不可把伺服器權威手牌全部廣播。每位玩家只收到自己合法知道的牌，公開資訊另外投影。斷線重連後，依座位重送可見狀態。
- 瀏覽器端既有畫面可逐漸改成 state renderer，不必第一步就重寫 UI；只是遊戲規則最終不能再依賴 client DOM。

## 伺服器無 UI 的規則核心（工作順序）

**Phase A — 可測試的 Lobby + Session**（第一階段實作 `game/v3-authoritative-room-model.mjs`，暫時不掛上 VPS）：
- server 建立房間、嚴格模式設定、座位及加密隨機 reconnect token；只有開房者設定房間規則，所有玩家同樣重連。失聯不刪房，座位不會被 `join` 佔領。
- 從原本的房主特權切成 lobby setup privilege 與遊戲參與 session。
- 所有 gameplay 指令 **`RULES_ENGINE_NOT_IMPLEMENTED`**：確保尚未實作星杯 reducer 前不會開始不存在的遊戲。

**Phase B — Headless 星杯狀態與規則，與瀏覽器拆分**：
- 嚴格定義 `XingBeiState` 完整 schema、卡牌身分及順序、亂數來源、玩家秘密分區、選擇流程狀態機。
- 先確保基礎洗牌、發牌、回合、士氣、傷害摸牌、治療、寶石／水晶／合成／星杯與勝負可由 reducer 執行。
- 逐項抽出 `mode/xingBei.js`／`content.js`／星杯角色技能效果，將 UI side effects 改成可序列化 action/resolution/state transition；每項技能對照原專案規則建案例。
- AI 也由伺服器提交受驗證的操作，而不是依賴某個玩家的瀏覽器來執行。
- 此階段不可假設 DOM polyfill 已經可靠地解決所有事件閉包／async 等待。

**Phase C — Durable correctness + session reconnection**：
- 以 SQLite（單機 MVP）或其他合適交易型儲存體，在同一原子交易內保存版本、狀態、玩家可見的資訊界線、操作去重、待決選擇與 RNG 進度；資料庫故障時 fail closed，不返回假成功。
- 同時防止操作重送、過期 revision、同座位雙連線爭權、越權查看手牌／操作非己方卡牌。
- service restart 後載入快照、驗證一致性，再容許玩家重連，不能藉此重播已經結算的技能效果。
- 明確設定單人斷線時「等待／自動託管／超時」策略；若目標是完全不停局，非當前操作者斷線不需暫停，當前操作者則需可重現的超時政策。

**Phase D — 舊版畫面整合、全自動多人瀏覽器驗收**：
- 建獨立 Playwright／無頭瀏覽器測試，兩到四名虛擬真人各自有私密 session。
- 自動建立房間、指定陣營、發牌、攻擊、治療、改變士氣、星石、星杯、回應和技能；同時驗證所有玩家只見合法狀態。
- 在不同流程階段用 browser reload、WebSocket 強制中斷、延遲與重複訊息做故障注入。
- 另測伺服器 process restart 與 DB rehydrate（這需要單獨測試持久化，不能用單純 browser reload 取代）。
- CI 結果包含可重現的 seed、操作序列、狀態差異、影片或 trace；先全面修掉自動測試找到的缺陷。

## 集中真人驗收（只在 Phase D 核心端對端測試通過後提出）

**暫停逐版真人測試。** 直到以下自動化門檻全部達到才安排一次集中測試：
1. 四人以上房間可建立與完成一局星杯，遊戲規則與原版比對通過。
2. 每個角色的至少指定代表性技能案例都已自動化；沒有測到的技能要清楚標示未支援，不能默認已通過。
3. 原開房者與一般玩家各自能刷新／斷線／重連；房間座位、私有手牌、技能和計時器狀態正確。
4. 重複指令、過期請求、非法玩家、重啟服務與持久化失敗不會多次結算或洩漏私密資訊。
5. V1/V2 服務與網址不受影響；V3 必須能單獨部署並可回退。

最後的一次集中真人測試應依照事先準備的 checklist，涵蓋多玩家正常對局、原房主斷線、普通玩家斷線、同時斷線、重新整理、超時、技能在回應窗口中的斷線以及整場勝負。這是**縮減**反覆測試，而非保證只需一次就能修盡所有在現場才出現的缺陷。

## 部署與驗收限制

- 目前不得改動 `xingbei-hall-v3.service` 或其 8081 port，不能動 V1/V2。
- `game/v3-authoritative-room-model.mjs` 是孤立的 Node prototype；現有 V3 實際上**仍然是房主主導**。不能宣稱只是建立檔案，就完成了房主無關的持久對局。
- 先保留可用的 Playtest 舊路徑。伺服器權威 MVP 經可靠端對端驗證後才切換，不再要求每新增一筆取樣就請真人重測。
- 一旦確定服務端運算引擎的技能支援範圍，才決定是否將版本名稱換成 V3-authoritative preview；避免混淆原有第 21 版的測試結果。
