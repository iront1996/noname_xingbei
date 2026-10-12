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


## 技術路線比較與優先試驗（不需真人）

考量目前 `Player extends HTMLDivElement` 和 `GameEvent` 深度依賴瀏覽器，**不能預設純 Node reducer 改寫是最快能交付的選項**。先離線驗證兩條路：

| 技術路線 | 可重用既有星杯技能 | 原房主斷線不影響引擎 | 服務端工作程序重啟可續局 |
|---|---|---|---|
| **A. VPS 管理的無頭 Chromium 房間 Worker**：每場獨立瀏覽器遊戲執行環境，真人都是 guest | 可能高度重用，但要先證實原主機 `game.me`、座位、手牌／技能與模式初始化能安全從真人席位分離 | 只要 Worker 持續運作、訊息代理正確，原則上可以 | **不能自動保證**；原本 JS Promise / heap 仍不可簡單 JSON 化，需要額外 checkpoint / deterministic replay |
| **B. 純服務端 XingBei Reducer**：狀態＋操作＋顯式待決選擇 | 必須分批移植大量卡牌／技能及回合規則 | 可以 | 在資料模型、事務式儲存與重放防重複設計完成後可以 |

**本專案近期優先：先做 A 的隔離概念驗證，並平行設計 B 的持久化資料 schema。** A 只能稱為「伺服器擁有遊戲執行程序」；**不能**因為 Chromium 跑在 VPS，就聲稱已實現權威狀態可持久恢復。

A 的第一輪完全自動測試需證實：
- 無頭 Worker 真正是非玩家、只主持規則，不憑空占掉 2v2／3v3／4v4 中某一真人／AI 座位；
- 真人建立房間及設定模式後，能進入自己的座位、收到自己的私密牌而不是 Worker 的牌；
- 原開房者及一般玩家各自中斷 WebSocket、重新整理、重連，都能回到原座位而不干擾 Worker；
- 完成最少一段星杯攻防回應與技能結算，所有玩家可見／私有資料一致；
- Worker 的記憶體與 CPU 佔用可接受；工作程序 crash 必須明確拒絕繼續，不能假裝從 RAM 中復原；
- 如果任何原始規則依賴 `game.me` 是真人房主，必須明確列出阻擋與修改範圍；**不可用虛構玩家偷偷頂替真人**。

若 A 無法在受控測試下做到無玩家席位的引擎 Worker，應立即停止在該方案上堆疊 hack，優先 B 的無 DOM 規則核心。兩種路線都不得把既有第 21 版「匿名資源證據」冒充原局快照。

## 對使用者的真人測試政策

- 立即停止「每版一張健康檢查截圖」的驗收流程。新里程碑先由 CI mock sessions、無頭瀏覽器及伺服器 crash tests 驗證。
- 僅當遊戲操作與 session 恢復都在**真正伺服器主持的端對端遊戲**中自動化通過，才提出**一次集中多人驗收**。
- 若集中驗收真的揭露無法模擬的問題，修復後可能仍需針對性複測；不應無條件承諾任何軟體只需一次真人測試。


## 2026-10-11：原生 off-board 主持人座位可行性初驗（V3-only）

本輪只在 `feature/host-reconnect-v3-playtest` 新增隔離驗證程式與未連線的拓樸守門函式，沒有啟動 VPS/8081 服務，也沒有動 V1/V2 或正式房間。

- `noname/game/index.js` 原生 `randomMapOL()` 內，`window.isNonameServer` 分支會另建 `game.me`，不占用 `game.players` 的真人座位。這為「VPS 主持而開房者只當玩家」提供**既有引擎的可重用入口**，但尚未證明整場對局完整可運行。
- `tools/test-v3-browser-worker-seat-contract.mjs` 從專案**實際源檔**取出原生 `randomMapOL` 方法，在隔離 VM 與模擬 transport/DOM 環境執行。驗證四條真人連線可對應四個座位、傳統真人房主仍占一席，並揭露在少一條連線時原生方法會自動補上 playerid（不能當成真人就緒）。
- `game/v3-authority-seat-preflight.mjs` 與 `tools/test-v3-authority-seat-preflight.mjs` 加入 2v2/3v3/4v4 嚴格數量、座位、連線 ID 一致性檢查，拒絕缺席、重複及偽造拓樸。但**驗證用 session 必須由未來的 server-side broker 認證產生**；函式不接受前端自報身分做授權。
- 本地隔離執行 7/7 案例通過（3 個原生方法 VM 案例及 4 個拓樸函式案例）。CI 的實際執行結果尚未核實。以上不是 Playwright、真實多人遊戲或 Worker 規則運算驗收。
- 新增檔案尚未接入現有 V3 room broker；現有 `v3resume`、`v3ready`、舊房主權威運作完全不變。

**下一個阻塞點：**現有 `mode/xingBei.js` 的 `checkResult()` 透過 `game.me.side` 決定勝負，非真人主持端沒有陣營。需要移除規則引擎對主持席位的依賴，並讓每位玩家從投影狀態接收對自己正確的勝負結果。還要用真正的 Chromium + WebSocket 完成四名真人座位、角色選擇、攻防與技能事件的端對端驗證，才能稱 A 路線成立。Worker 在伺服器進程崩潰後仍需額外持久化／重播機制，不能因為跑在 VPS 就假定可原局恢復。


## 2026-10-11：真正 Chromium 程序的首輪隔離實驗（仍未上線）

新增以下 V3-only 原型，不變更現有 `game/v3-playtest-server.cjs`、8081、V1、V2，也沒有呼叫 `v3ready`：

- `game/v3-chromium-authority-worker.mjs`：Node 22 使用 child process 啟動獨立 Chromium、獨立臨時 profile、127.0.0.1 隨機 DevTools 埠與 CDP 健康探測。標記 `window.isNonameServer=true`；提供顯式 `stop()`，崩潰後 `inspect()` 必須失敗。回傳 `gameRulesLoaded:false`、`statePersisted:false`，不假稱已執行完整星杯。
- `tools/test-v3-chromium-authority-worker.mjs`：從現有 `noname/game/index.js` 抽取原生 `randomMapOL()` 方法，在真正無頭 Chromium 的 DOM 環境中對 2v2/3v3/4v4 執行，確認非玩家主持端不占任何真人座位，所有真人 ID 綁定到各自座位。這個測試仍採模擬 peer 物件，而非真正 WebSocket 的四人對局。
- 測試模擬原開房者失聯時，獨立 Chromium PID 仍存活；主程序被強制殺死則 health probe 失敗；專用實驗執行入口受 `V3_ALLOW_SEAT_EXPERIMENT=1` 限制，不得暴露給任何玩家 API。
- `game/v3-xingbei-authority-outcome.mjs`：純函式化紅藍士氣／星杯勝負判斷，對齊現有 `mode/xingBei.js` 的士氣小於等於 0 與星杯上限邏輯；不讀取 `game.me.side`。同時雙方達成終局、狀態不完整或 getter 等輸入一律拒絕，不任意判勝。尚未接到完整遊戲結算。
- `.github/workflows/v3-chromium-authority-poc.yml`：新增真 Chromium 執行工作（明確找不到 Chrome 即失敗），與既有 V3 mock 測試分開。一般 V3 workflow 不會把未執行 Chromium 的 skipped 測試冒充 pass。

**本地驗證結果：** 真 Chromium 6/6、獨立勝負驗證 5/5，合計新增 11/11 個案例通過；GitHub 提交的四個程式／測試 blob SHA 均與本地已執行檔案一致。尚未取得 GitHub Actions 執行成功證據；不可稱 CI PASS。

**安全限制：** 目前 Chromium 原型為了在隔離的 root 測試容器啟動，帶有 `--no-sandbox`。**禁止以此設定直接部署承載玩家資料的 VPS 服務**；正式版本應使用非 root、有效 Chromium sandbox、受限制的系統帳號／資源配額與工作程序隔離。Chromium CDP 雖綁定 localhost，也只能由可信任服務端存取，不能公開 port 或接收任意玩家 JavaScript。每房 Chrome 的記憶體／CPU 上限仍待實測。

**下一個核心里程碑（尚未完成）：**

1. 用獨立 V3-authoritative broker 建立認證的 seat/session/connection 對應與伺服器擁有的房間；把 Chromium worker 接到真正 WebSocket relay，所有真人（含建立房間的人）走同一重連驗證路徑。
2. 讓 worker 載入現有星杯遊戲引擎、配置 2v2/3v3/4v4 並完成選角、抽牌、攻防、技能回應；無法解耦 `game.me` 的功能都要逐項修正並回歸原版。
3. 定義 worker 權威狀態與只供單一席位的私密資料；證明玩家中斷／刷新不會洩漏其他人手牌與牌堆順序。
4. 增加事務式持久化、命令去重、事件回放／待決選擇，才可談 VPS 重啟續局；若 Chromium runtime 的閉包／Promise 不可恢復，必須切向可序列化的 server reducer。
5. 以上端對端自動化覆蓋前，持續不安排真人反覆驗收、不改 VPS、不移除既有 V3。


### 2026-10-11：房間與 Chromium 主持程序協調原型

新增 `game/v3-authority-runtime-coordinator.mjs`（只供服務端呼叫）及相應 5 項離線測試。它與既有 `createV3AuthoritativeRoomModel()` 整合：

- 由伺服器建立房間、綁定全部真人 seat；原開房者與其他玩家完全共用 `disconnect/reconnect`，reconnect token 由既有 session model 驗證及輪替。公開 roomView 不含 token／connectionId。
- 房間座位人數、綁定與 worker 身分通過嚴格拓樸比對，才可啟動獨立 Chromium。啟動中禁止重複建立；在瀏覽器啟動期間房間 revision 有變化，立即停止該 worker 並拒絕進入可用狀態。
- 原開房者或普通玩家斷線不自動關閉 worker；worker 健康檢查失敗、啟動失敗及重複啟動皆拒絕。任何攻擊／購買／抽牌行為仍只回 `RULES_ENGINE_NOT_IMPLEMENTED`，房間仍是 `waiting`。
- `tools/test-v3-authority-runtime-coordinator.mjs`：5 個生命週期與競態案例。本地 5/5 通過。
- `tools/test-v3-chromium-coordinator-integration.mjs`：再用**真 Chromium** + 對房間模型的真實 API 呼叫驗證 4 個 session／房主及普通玩家斷線重連／credential 輪替／worker PID 不變、無遊戲規則假成功。本地 1/1 通過。此案例尚非 WebSocket 網路測試；GitHub Actions 專用 Chromium workflow 已納入。

合計本輪新增 **17 項**測試：Chromium 座位／生命週期 6，離線勝負 5，房間協調離線 5，Chromium 協調整合 1，本地均通過。舊有 V3 測試另行執行。

GitHub Actions `V3 Chromium Authority Worker PoC` 曾在提交 `1420defd0a5a478efb26999788034cccebe8bf92` 成功；含後續 coordinator 整合的新版 workflow 需要單獨核實。仍**沒有**真正 4 人 WebSocket 全局、完整技能運算或 SQLite 持久化，因此不可向玩家宣稱已完成無房主權威 V3。

下一步將獨立建立真正的網路 broker 及與原生星杯引擎的橋接，不得將未驗證的 Chromium 執行程序直接替換現行 8081。


### 2026-10-11：GitHub Actions 整合驗證結果

- 在加入真正 Chromium + coordinator 的 CI 測試後，首次 GitHub Actions 測試於 Chromium profile 目錄清理遇到 `ENOTEMPTY`；其餘 6 個 Chromium 案例已通過。這是進程退出與子程序寫入 profile 的競態，不是原生星杯座位結算錯誤。
- 修正 `game/v3-chromium-authority-worker.mjs` 清理使用 Node `fs.rm` 的有界重試（最多 30 次、間隔 100ms），保留不能清理成功時的顯式失敗。修正後本地重新執行 7/7 Chromium 測試通過。
- GitHub Actions 在提交 `88934f83f7d5419e3d6da2572f9457556cab0e9b` 上，`V3 Chromium Authority Worker PoC` 與 `V3 Playtest Offline Safety Tests` **均顯示 success**。Chromium CI run：https://github.com/iront1996/noname_xingbei/actions/runs/38112113935；既有 V3 離線回歸：https://github.com/iront1996/noname_xingbei/actions/runs/38112113927。
- 限制未變：只是 CI 隔離的 Chromium 執行程序與 session model 整合，尚無真實 WebSocket 全局、完整星杯規則執行或持久存檔，**禁止直接發布為可原局續玩的伺服器權威版**。


## 2026-10-11：V3 獨立 WebSocket 傳輸 + 真 Chromium 的四人重連驗證

**性質：完全隔離的本機／GitHub Actions 概念驗證，並未啟用於任何 VPS 或正式網址。不得宣稱完整遊戲已可續局。**

### 新增程式

- `game/v3-authority-websocket-broker.mjs`：新的伺服器權威 room/session WebSocket broker，僅允許監聽 `127.0.0.1:0`（系統分配隨機埠），刻意禁止公開監聽與占用 8080／8081。僅透過注入的 `ws.WebSocketServer` 使用，不取代 `game/v3-playtest-server.cjs`。
- 每一真人 WebSocket 由伺服器產生獨立 connectionId，先通過 `createV3AuthoritativeRoomModel` 的座位／256-bit reconnectToken 驗證後才取得 seat。建立房間者只是 seat 0，具有等待階段的啟動權，**不是**房間程序／訊息代理。
- 同一 seat 重連時，舊 WebSocket 會收到撤銷訊息並斷線；因舊 socket 已解除綁定，其遲到的 close 不會把新玩家再踢出。憑證輪替後舊 token 不可再用。其他房間不能冒領該 seat。
- 伺服器另為每一 Chromium 程序簽發一次性 256-bit 內部 secret，僅授權其使用獨立的 `authority_hello` 通道。不給真人座位；私有 secret 不會寫入房間公開 roster 或發給玩家。
- `game/v3-chromium-authority-worker.mjs` 新增 `connectRoomChannel`、`inspectRoomChannel`。真 Chromium 透過本機 WebSocket 收取伺服器的 roster 變化，主持程序不依賴創建者的網頁生命週期。瀏覽器只暴露不含 secret 的連線健康摘要。
- **邊界**：此 Chromium 目前只啟動私有傳輸橋接，**尚未載入星杯完整引擎、選角、卡牌、技能事件與私密 playerView**。因此 `command: attack` 等仍回 `RULES_ENGINE_NOT_IMPLEMENTED`，`room.status` 仍為 `waiting`。此前獨立的 `v3-xingbei-authority-outcome.mjs` 提供了不依賴 `game.me.side` 的勝負純函式，但尚未掛到原生事件結算。

### 自動測試與錯誤修復

- `tools/test-v3-authority-websocket-broker.mjs`：6 項離線協定測試，覆蓋建立房間、真／假操作者重連、舊連線撤銷、密鑰不可見、未授權假主持、座位不足、啟動途中斷線及禁止危險埠。本地 6/6 PASS；V3 offline CI 也成功。
- `tools/test-v3-real-websocket-chromium-broker.mjs`：真正 4 條 Node WebSocket client + `ws` server + 真 Chromium 内部 WebSocket。驗證建立房間、四人入席、私有 host 認證、開房者及普通玩家雙重斷線重連、舊 token 拒絕、主持 PID 不變、身份資訊不廣播、攻擊仍拒絕，不冒充技能成功。
- 第一輪新的真 WS CI 失敗：`WORKER_START_FAILED`。原因是 5 秒的 authority handshake timer 在 Chromium **冷啟動之前**開始，GitHub runner 初始化瀏覽器超時。已把握手計時改成 **launchWorker 成功後**才開始，期限 10 秒；未放寬任何 token／座位驗證。重跑後成功。
- GitHub Actions 實際驗證於提交 `2d8a3ae0ac1f7a800cf5f287ef29cb8cafbce138`：
  - Chromium 端對端工作流程： https://github.com/iront1996/noname_xingbei/actions/runs/38113577027 —— **success**；含原有 7 項與新增 1 項真 WebSocket+Chromium 實驗。
  - V3 離線完整回歸工作流程： https://github.com/iront1996/noname_xingbei/actions/runs/38113577033 —— **success**。
- 這些是網路層與程序生命週期的可重現結果，不是完整星杯遊戲對局的 E2E，也不是伺服器重啟後恢復。

### 不可碰觸範圍／後續實作阻塞

- 沒有修改 `mode/xingBei.js`、`noname/game/index.js` 等可能影響其他版本的原生共用遊戲檔案；沒有部署到 VPS、重啟任何 service、調整 tunnel、動 8080／8081、修改 V1/V2 分支。
- 仍需建立可靠的 V3-only native engine bootstrap：將原生 `Game`、`Player`、`GameEvent`、`randomMapOL` 與 WS routing 綁到以上 worker，並處理原生 `game.me` 在不占席位時的特殊分支；必須確定 sessionSeat 與隨機角色／engineSeat 的映射。
- 要讓勝負判定回到伺服器：在原生星杯所有事件完整結算後，用純函式產生紅藍勝方，對每個 seat 產生合法勝負 projection，不得以假主持端的 `game.me.side` 判斷。
- 更後續才是完整 hidden card privacy、待決技能窗口、idempotent command、持久化 DB、worker 失效恢復以及伺服器程序 crash 後重啟續局。以上未完成前，禁止切換正式 V3 或要求真人反覆測試。


### 2026-10-11：穩定 Player ID 與真實 WebSocket 驗證後的原生初始化試驗

在真正的遊戲重連中，原本 `Player.playerid` 不能直接等同每一次新 WebSocket 的 ID。否則刷新後雖然 seat 回來了，原生技能與選擇回應可能被綁到新身分。

本輪因此把兩者拆開：
- Broker 為每個新真人座位產生一次 `player_<32 hex>` 的穩定 Player ID，保存於該房間伺服器記憶體。重連必須出示原先的 reconnectToken；驗證成功後只輪替 session token 與 connectionId，穩定 Player ID 不變。
- 只對內部受驗證的 Chromium channel 發送 `authority_roster.bindings`：`{seat,playerId,connectionId|null}`。一般玩家的 `roster` 仍沒有其他人的連線 ID／secret；本人收到自己的 Player ID。Chromium 嚴格核對結構、唯一 playerId、座位與連線 ID 格式。
- Chromium 的 `__v3AuthorityBridge.getSeatBindings()` 僅存在於伺服器所持有的瀏覽器，供未來原生遊戲初始建立 `lib.node.clients`／`Player` 路由。它不供真人 WebSocket 呼叫。
- 新增 `tools/v3-native-seat-probe.mjs`：CI 的專用原生驗證模式將**實際的** `noname/game/index.js` 裡 `randomMapOL()` 提取出來，在此 Chromium DOM 上以剛剛驗證過的 Player ID 建立 native player mappings。驗證工作主程序 `game.me` 不占 seat、所有 session 玩家都分配到席位並抵達原生 `chooseCharacterOL()` 入口（測試替身，**未進入實際選角畫面**）、斷線重連後 Player ID 集合完全一致、WebSocket connectionId 可更換。
- `tools/test-v3-authority-websocket-broker.mjs` 與 `tools/test-v3-real-websocket-chromium-broker.mjs` 均新增 Player ID 穩定性與私有 socket bindings 驗證。

**已確認的 CI 實際證據**（以 `b33054498fd6649d3a2e40f1f3fb6c62bfd634aa` 為準）：
- 真 Chromium／四名真 WebSocket 與原生 `randomMapOL` 座位試驗：https://github.com/iront1996/noname_xingbei/actions/runs/38113825757 —— **success**。
- V3 所有離線回歸測試：https://github.com/iront1996/noname_xingbei/actions/runs/38113825766 —— **success**。

**關鍵剩餘工作不可略過**：這仍是原生方法在受控 DOM/mock Game adapter 下的驗證，**尚未載入完整 GameEvent／星杯角色技能、尚未發真牌、尚未啟用回合引擎、尚未持久化**。測試到達 `chooseCharacterOL()` 的替身回呼不等同完成真實選角。需要把原生 WebSocket Client／NodeWS／GameEvent 透過新的 worker 連線代理實際串起來，並將已存在的純函式紅藍勝負判斷接在完整事件結束後。此後才能繼續私人手牌投影、技能結算與伺服器故障恢復。

**隔離承諾**：全部提交僅在 `feature/host-reconnect-v3-playtest`；沒有推送 master、V1、V2，也沒有操作 VPS、8080、8081、Cloudflare Tunnel 或舊 V3 部署。


## 2026-10-11：原生星杯 Game／mode 真實載入、伺服器視角勝負與雙向傳輸（本輪）

本輪只有 `feature/host-reconnect-v3-playtest` 的新增 V3 專用檔案、隔離測試與對上述 V3 原型的修改。**沒有修改任何 `noname/**`、`mode/xingBei.js` 共用原始檔，也沒有修改既有 Playtest 服務、VPS、V1、V2 或 8080/8081。**

### (A) 在真正 Chromium 載入原生 XingBei ESM

- `tools/v3-native-module-test-server.mjs`：從 GitHub Actions checkout 的程式樹以唯讀方式提供原生靜態 ES modules，綁定 `127.0.0.1:0`，拒絕任意對外埠、特殊路徑、路徑穿越、非 GET/HEAD；提供獨立的空白測試 HTML，不載入正式首頁或連接線上大廳。
- `game/v3-chromium-authority-worker.mjs`：新增經驗證的 `loadV3NativeModules({origin})`，只接受 localhost；用 CDP 導覽隔離空白頁並真正 `import('/noname.js')` 與 `import('/mode/xingBei.js')`，檢查實際 `Game`、`lib`、`ui`、`_status`、星杯模式及 `randomMapOL`、`checkResult` 的存在。此處 `gameLoopStarted:false` 必須保留。
- `tools/test-v3-native-module-chromium.mjs`：在實際 Chromium 裡，針對真正從原生模組匯出的 `Game` singleton 與 `mode.default()` 安裝 V3 勝負轉接器，再測士氣結算、不同玩家結果、同一結果不重複結算，以及不得呼叫原版依賴房主的 `game.over(bool)`。
- `tools/test-v3-real-websocket-chromium-broker.mjs` 亦同步提升：**四名真實 WebSocket 玩家及其獨立 Chromium 主持端**先匯入原生 XingBei 模組，再以真實認證 Player ID 完成原生座位映射、原開房者與另一席離線重連，最後在同一個原生 Game 物件驗證紅／藍士氣終局與每席投影。實際 `game.me` 是 offboard 主持虛擬 DOM 節點，不是第一位真人。

### (B) 原生勝負轉接器，不再依賴真人房主

- `game/v3-native-xingbei-outcome-adapter.mjs`：在 V3-only 工作程序裡以 `installV3HostNeutralOutcome({game,mode,onTerminal})` 取代原本依賴 `game.me.side` 的 `game.checkResult` 與 `game.checkOnlineResult`；對每位經認證的 `player_<id>` 配對其陣營與勝負結果。
- 保證 `game.me` 不在 `game.players` 真正真人席位裡、主持端不得具有紅藍陣營、所有 4/6/8 位玩家具有唯一且合格 Player ID 與合法陣營。矛盾的同時達勝狀態、非法玩家身分、重複安裝、終局改寫均明確拒絕。
- 此橋接不執行原版 `game.over()`，原因是該函式從真人主機視角顯示結果，並可能把所有人的手牌放入結果 UI。終局以單次 `onTerminal` callback 供之後的權威傳輸與持久化交易串接。**目前尚未發送任何真實對局勝負結果**。
- `tools/test-v3-native-xingbei-outcome-adapter.mjs` 新增六項 Node 端純函式／原生 callback contract 測試。

### (C) 真正端對端訊息往返，保持規則失效保護

- Broker 支援受認證玩家限定的 `transport_probe`：由伺服器檢查當前座位和唯一固定 Player ID，派生獨立 trace ID，送到**私有 Chromium WebSocket**；Chromium 驗證 trace、seat、Player ID 與當前綁定，才返回 `authority_probe_ack`；Broker 只回傳給 **原本仍持有該座位的玩家 socket**。
- 這是真實網路往返：真人 WebSocket → V3 broker → 獨立 Chromium → V3 broker → 同一位真人 WebSocket；房主與非房主刷新後重新登入也能走同一路徑，期間 Chromium PID 及原生 ESM 模組環境不需要跟著玩家重開。
- 同時設置 64 筆 outstanding probe 上限、每筆 4 秒 timeout、座位驗證、重連後舊 socket 的回覆捨棄與 Close 時清除 pending。沒有讓玩家發送 JS、規則命令、其他玩家的私密資料，也沒有啟動真正的 `GameEvent` 事件循環。遊戲指令維持 `RULES_ENGINE_NOT_IMPLEMENTED`。

### 自動驗收結果／尚未完成

- GitHub Actions 在提交 `808de45550e8f405e330025fcd7612b07f44f226` 驗證：
  - Chromium 原生 ESM＋四人真實 socket＋雙向 probe： https://github.com/iront1996/noname_xingbei/actions/runs/38114322613 —— **success，9 tests / 9 passed / 0 failed**。
  - V3 離線回歸： https://github.com/iront1996/noname_xingbei/actions/runs/38114322602 —— **success**，含新增的六項結果安全案例。
- **仍未完成／不得冒稱**：整場星杯原生選角、抽牌、真正 Player DOM 初始化、技能與 GameEvent、回合與合法行動校驗、私密手牌的端到端投影、同步終局通報、完整持久化、Chromium crash 與 VPS restart 續局。此輪雖匯入了真正原生 Game／mode，某些測試仍以受控的玩家 DOM／狀態替身驗證「原生接口」，不是原生完整遊戲流程。
- 工作程序目前仍使用隔離 CI 專用 `--no-sandbox`，**禁止未經非 root 及 sandbox/資源限制修正就部署到 VPS 接玩家資料**。
- 下一步優先把原生 `GameEvent`／`Client`／`NodeWS` 真正連上座位代理，完成原生選角、發牌、第一個回合與回應窗口的程式化測試；若事件環境無法脫離房主真人視角，需轉向可序列化規則核心。真人仍維持**一次集中驗收**政策。

## 2026-10-11 後續：原生回應封包的拒絕式邊界

新增 `game/v3-native-response-envelope.mjs` 與 `tools/test-v3-native-response-envelope.mjs`。目前僅驗證 roomId、traceId、seat、固定 Player ID 與活躍 connectionId；任何包含 `script`、`action` 或 `result` 的玩家輸入都拒絕。此函式尚未接入原生 `GameEvent` 或正式 V3 WebSocket 服務，不能視為已完成技能、出牌或斷線原局恢復。下一階段應先建立受控的伺服器 pending event window、單次消耗 nonce、座位重連後的綁定更新與結果校驗，再允許有限的原生選擇回應。


## 2026-10-11：伺服器保留待決選擇、斷線續答與 Chromium 沙箱預設（本輪）

**本階段完成的是獨立 V3 實驗的「待決選擇協定」，不是原生星杯 GameEvent、技能或回合已經正式可玩。** V1/V2 及既有線上 V3 的所有服務維持原樣，所有 GitHub 變更只寫入 `feature/host-reconnect-v3-playtest`，沒有修改共用的 `noname/**`、`mode/xingBei.js`、舊 WebSocket Broker 或 VPS。

### 新的伺服器選擇視窗

- `game/v3-authority-choice-windows.mjs` 新增純伺服器記憶體選擇管理器：每個 roomId+seat 最多一個未結束選擇，由經認證的私有主持通道指定合法選項、提示、指定 Player ID，產生 128-bit 隨機 ticket。限制選項型別、數量、格式、不能重複、提示禁止 HTML 特殊字元／控制符；所有視窗有到期時間、總額限制及按房間清理。
- `game/v3-authority-websocket-broker.mjs` 新增 `enableChoiceWindowExperiments`，**預設 false**。只有明確啟用的本機／CI 測試才可由已認證 Chromium 發出 `authority_choice_open`。Broker 核對 seat 和先前簽發的固定 Player ID，再把 `choice_window` 僅交付給擁有該 seat 的玩家。一般玩家的 roomView/roster 不包含其他人的 ticket 或任何私密 choice。
- 玩家斷線時，broker 保留選擇視窗，不會因原開房者離線而停止 Chromium；重新連線後，帶上合法輪替 token 與固定 Player ID，就會收到**同一個 ticket**及尚未回答的選項，無須重開遊戲事件。
- `choice_submit` 只能在目前有效的 socket、正確房間、正確 seat、正確 Player ID、正確 ticket、合法選項下通過；伺服器第一次接收後鎖定選擇。相同選項重送只回狀態，**不再次送入 Chromium**；不同選項改答拒絕。過期 ticket、自定 script、跨房間、跨座位皆拒絕。
- Chromium 收到 `authority_choice_delivery` 後回覆 `authority_choice_receipt`，Broker 將選擇標示為 `delivered`，但**不是** `resolved`、**不觸發** `GameEvent.unwait()` 或 `game.resume()`、**不宣告成功出牌**。在真正原生 GameEvent 取用回應並完成伺服器驗證前，遊戲指令仍是 `RULES_ENGINE_NOT_IMPLEMENTED`。
- 主持 WebSocket 失聯時，該房所有實驗視窗作廢並通知現有玩家 `choice_interrupted`，不假冒恢復遊戲。Broker 結束時取消所有視窗。內存模型沒有進行持久化，程式重啟後不能原局續答。

### 真 Chromium + 多人連線的自動化驗證

- `tools/test-v3-authority-choice-windows.mjs`：六項獨立狀態機案例（唯一選擇、相同答案去重、不同答案拒絕、跨座位／跨房間隱私、expiry、容量限制等）。
- `tools/test-v3-authority-websocket-broker.mjs`：增加 fake WebSocket 的主人與客人選擇重連、非法答案、非當事人不可代答、私人選擇不能廣播、實驗功能預設禁止、主持失聯清理測試。
- `tools/test-v3-real-choice-window-chromium.mjs`：四位**真實 WebSocket 玩家**、獨立受認證 Chromium 主持通道、真正載入原生 Noname / XingBei ESM 模組，驗證房主離線續答、第二名客人**在離線期間由 Chromium 開出待決選擇**、重連後才收到此私人選擇、兩位合法回覆僅由主持程式確認收到、相同答案去重、非法選項及跨座位被拒、主持 PID 不變、其他座位無法看到 ticket。
- 注意：本測試的選擇由 CDP 測試專用 `openChoiceExperiment()` 發起，非原生 `GameEvent.send()` 自動產生；Chromium 的 `authority_choice_receipt` 是傳輸確認，不是星杯技能／卡牌解析。

### Chromium sandbox 硬化

- `game/v3-chromium-authority-worker.mjs` 原本為 CI 容器帶有常駐 `--no-sandbox`；本輪改為**預設執行 Chromium sandbox，不自動加入該參數**。若 Node 以 root 執行，預設拒絕啟動。僅 `unsafeTestSandbox:true`、環境 `V3_ALLOW_SEAT_EXPERIMENT=1` **同時** `V3_ALLOW_UNSANDBOXED_TESTS=1`，才允許離線隔離測試刻意關閉沙箱；正式服務不得使用。
- `tools/test-v3-chromium-sandbox-policy.mjs` 新增回歸，驗證未明確允許時 root 啟動被拒、unsafe 不能默默開啟。GitHub hosted runner 在**預設有沙箱**的模式下已完成所有真 Chrome 測試。
- 沙箱預設更安全，但每房瀏覽器的非 root 系統帳號、CPU／記憶體限制、程序隔離、CDP 資料安全及持久化架構仍需完成，**仍禁止直接部署到承載玩家資料的 VPS**。

### 驗證證據及下一個阻塞點

以程式提交 `aaa1933e24659329401f75a4e1a2e7f3e701d3b1` 為準：

- [V3 Chromium Authority Worker PoC](https://github.com/iront1996/noname_xingbei/actions/runs/38134356828)：**success，11 tests / 11 passed / 0 failed**。包括真 Chromium 原生 ESM、四人 WebSocket 雙向消息、斷線續答與 Chromium sandbox policy。
- [V3 Playtest Offline Safety Tests](https://github.com/iront1996/noname_xingbei/actions/runs/38134356827)：**success**。包含純房間狀態、重連、選擇、V3 隔離等所有既有離線回歸。

**下一個必須修正的原生相容性阻塞**：原版 `noname/library/element/client.js` 的 `Client.close()` 在遊戲中離線時會直接呼叫 `player.unwait("ai")`，原版 `Player.wait()` 也可能在倒數時間結束時強制 AI 續接並關閉 socket。這會破壞 V3 希望保留待決選擇的語義。必須為**僅有 V3 主持程序**建立原生 `Client`／`Player`／`GameEvent` 適配層，讓等待中的事件不會由舊客戶端自動判 AI，並加入首個真正原生選擇執行、回合續行、失聯重連及雙重回覆的端對端測試。嚴禁直接修改共用原版程式來達成此目標。

**目前仍不需要用戶部署 VPS 或召集真人反覆測試；保留最後一次集中真人驗收。**


## 2026-10-11 晚間：真原生 GameEvent.chooseControl 在伺服器主持 Chromium 中續行

**核心里程碑**：原版 `noname/library/element/gameEvent.js` 的 `GameEvent` 類別、原版 `Player.unwait()`、原版 `Game.pause()/resume()` 現在已透過 **V3-only runtime adapter**，在受管理 Chromium 上形成首個可驗證的選擇事件等待／續行流程。不是只有先前的 `authority_choice_receipt`。

### 實際實作

- `game/v3-native-event-wait-adapter.mjs`：只在 `window.isNonameServer===true` 的獨立 Chromium 內動態安裝，會覆蓋該瀏覽器 **記憶體** 中 `Client.prototype.close`、`Player.prototype.wait/unwait`、`GameEvent.prototype.send`；不改動任何 `noname/**`、`mode/xingBei.js` 等共用原始檔。
- 首個允許的原生事件是 `GameEvent('chooseControl')`：事件本身真實存在於 Noname 原生 `GameEvent` 類別，原生 Player 是 `Player.prototype` 的真實 DOM player 節點，原生 Client 具有伺服器簽發的固定 Player ID。基於允許清單，事件的原始 control text 留在 Chromium 內，對外只發 `o0/o1/.../o11` 等不透明代碼，由伺服器管理 ticket／房間／座位驗證。
- 事件經原生 `GameEvent.send()` 進入 V3-only 受控路由，再透過被替換的 `Player.wait()` 設定原版 `lib.node.torespond[playerid]` 並呼叫真實 `game.pause()`；**不設舊版強制 AI 回覆 timer**。玩家斷線時，V3 的原生 `Client.close()` 只標記 socket 離線，不執行原版 `player.unwait('ai')`。非合法伺服器選擇回應即使直接呼叫 `Player.unwait('ai')` 也明確拒絕。
- 合法作答：伺服器透過已有 choice state machine 首次鎖定 `ticket + option`，私有 Chromium 以實際事件記錄再次核對 `seat + playerId + ticket + allowed option`，然後使用原生 `Player.unwait({control, index})` 寫入原始 `GameEvent.result`、觸發原版 `game.resume()`。Chromium 之後送 `authority_choice_receipt` 與 `authority_choice_native_applied`；broker 嚴格要求先確認已送達，才可把 `choice_window.state` 標為 `applied`。只有 applied 的窗口能被下一個合法事件替換；舊 ticket 失效。
- 不支援的事件型態例如 `chooseToUse` 都拒絕 `V3_NATIVE_EVENT_UNSUPPORTED`，不會退回舊版從真人主機廣播 JavaScript 的控制模式。由於原生 event manager 仍採用單一全域 pause/結果槽，**同一時刻只允許一個原生待決事件**，直到未來完成真正的 nested/multi-event 排程。
- `game/v3-chromium-authority-worker.mjs` 的 `beginNativeChoiceExperiment`、`inspectNativeChoiceExperiment`、`simulateNativeClientClose` 僅於 GitHub CI 明確設置 `V3_ALLOW_SEAT_EXPERIMENT=1` 生效；這些是使用真實原生類別的隔離測試入口，而非開放給玩家的執行任意 JavaScript 通道。
- Chromium 的私有 `authority_roster` 訊息現在除了固定 Player ID，也會把受驗證的暫時連線 ID 變化通知 V3 native adapter。原生 Client 的 `closed`／`inited` 會跟著實際人類玩家的斷線／重連更新，不改變 `playerid`，也不自動改成 AI。

### 回歸驗證和限制

- `tools/test-v3-native-gameevent-choice-chromium.mjs`：真 WebSocket 四人（2v2）＋真 Chromium＋真正原生 `GameEvent`：驗證原生事件 pause、斷線不判 AI、舊 Client 的連線離線／重連、座位私密性、跨座位與不合法回覆拒絕、`Player.unwait` 真正解除事件、相同答案不重複 consume、舊 ticket 在後續原生事件中失效、房主與客人都能獨立續答。
- `tools/test-v3-native-choice-matrix-chromium.mjs`：新增 3v3 六人、4v4 八人的原生事件／房主／一般玩家斷線矩陣（CI 驗證資訊須以最新執行結果為準）。
- `game/v3-authority-choice-windows.mjs` 的純狀態機測試新增 native applied 的拒絕式轉移：提交不等於送達、送達不等於實際套用；錯誤玩家／選項／預設實驗模式不能冒充 native applied。
- 以上仍不是完整原生遊戲啟動。此測試採用 **原生 GameEvent、原生 Player prototype 的 DOM 物件及原生 Client 類別，但 Player 的戰鬥屬性和 GameEvent 邊界經由 CI 安全替身搭建**；尚未實際進入 `mode/xingBei.js` 的選角整套流程、發牌、第一回合、卡牌／技能效果、AI 細則、隱藏手牌投影、完整持久化及 VPS 重啟後續局。這些需後續逐項接通與驗證後，才能提出一次性真人驗收。

### 隔離及部署規範

- 全部提交僅在 GitHub `feature/host-reconnect-v3-playtest`；沒有修改 V1/V2 或正式 Git 分支、VPS、Cloudflare、服務或 8080／8081。
- 新 broker 仍僅能綁 `127.0.0.1:0` 且 choice 適配流程預設關閉；正式 V3 尚未切換到此主持方案。
- Chromium 預設使用沙箱；非 root/限制資源/CDP 防護/worker state persistence 仍需要上線前完整驗收。


### 2026-10-11 本輪最終 CI 檢驗紀錄

以提交 `f6e3086a255a7f4f5e13187da4a86e18dce262b4` 為程式快照，**兩套 CI 全綠**：

- 真 Chromium／原生 Noname GameEvent／2v2、3v3、4v4 全人數模式的真 WebSocket 續答： https://github.com/iront1996/noname_xingbei/actions/runs/38139070812 —— **success：14 tests／14 passed／0 failed**。
- V3 離線安全與回歸： https://github.com/iront1996/noname_xingbei/actions/runs/38139070820 —— **success**。

本輪有先遇到一項離線回歸失敗：新增 `source` 後，舊測試的 delivery 期望物件缺少該欄位。已修正原斷言並補上原生 applied 交易的非法轉移測試；修復後才視為驗證通過。本輪所有原生 Chromium 測試在 GitHub hosted runner **預設沙箱啟用**的狀態執行；測試使用原生 `Player.unwait` 完成控制項選擇，而非僅檢查收到的確認碼。

**仍不等同完全可玩／沒有完成原局持久化**：原生整場啟動、技能結算、多人嵌套事件、隱藏資訊、發牌、第一回合與 VPS 重啟後從同一遊戲狀態恢復仍待開發。此測試目前只覆蓋 2～8 人配置的真原生 `chooseControl` 離線續答協定，不應視為所有星杯關鍵詞或技能可正常結算。


## 2026-10-11 深夜：原生四張開局、加密牌堆檢驗與首次 phaseLoop 入口

所有變更持續限制於 `feature/host-reconnect-v3-playtest`，不接現有 V3／V2／V1 服務、不改 `noname/**`、`mode/xingBei.js` 共用原始檔、不碰 VPS。

### 本次新增的原生執行驗證

1. 原始 `game/config.js`、XingBei 卡牌與角色包載入後，全部 4/6/8 位實際原生 `Player` 各完成受驗證的 `GameEvent('chooseControl')` 選角、`Player.init()`。在真 Chromium 裡驗證首位玩家與每張實體卡身分。
2. `game/v3-native-xingbei-seat-session.mjs` 新增 `dealOpeningCardsNative()`：將已由伺服器私有 WebCrypto 隨機洗牌的原生星杯卡組建立為真正的 `ui.cardPile` 原生 Card DOM，排入 `game.gameDraw(...,4)` 原生 `GameEvent`，實際 `await draw.start()`，使用原版 `get.cards` / `Player.directgain` 分別發給 4/6/8 位角色四張牌。**不再把手動 `directgain` 當成正式開局流程**；後者僅保留隔離重試探針。
3. `exportOpeningCheckpoint()` 以真正已抽出的 `Card.__v3PhysicalId` 和 `ui.cardPile.childNodes` 取得手牌和剩餘牌堆，驗證「所有牌 ID 不重複、總數不變、正確座位」後，交由原有 `createV3NativeOpeningCheckpointStore()` 使用 AES-GCM 加密寫入、從全新儲存實例重新讀取。所存的 **仍是開局資料，不是原生 GameEvent／技能／RNG／回合堆疊的恢復**。
4. 在 GameEvent 真正可編譯前，沿用本專案原生 `initializeSandboxRealms(true)`、`security.initSecurity()`、`get.sortCard(lib.config.sort)`；並遵循 `GameEventManager.eventStack` 而非只掛 `rootEvent`。未禁用遊戲程式安全沙箱。先前幾次原生建構／抽牌 CI 失敗均依據 GitHub 錯誤修正、成功後才合併測試證據。
5. 開局已由 `gameDraw` 執行後，`stageOpeningTurnBoundary()` **只排一次 `phaseLoop`**，不會再排第二次 `gameDraw` 導致重複發牌。
6. `startPausedFirstNativePhase()` 在 CI 專用 Chromium 啟動**原版 `phaseLoop.start()`**，實際執行 native phase 的座位編號和 `game.$initZhanJi()` 紅藍士氣／原版計分 UI 初始化，並以 `lib.onphase` 的**測試專用**暫停鉤子，在第一個 `Player.phase()` 待決事件開始前停住。測試加強檢查 `phase` 確為原生 `GameEvent`，且綁定伺服器認證的第一位 Player ID；不會執行任何玩家出牌、技能或敵方私牌揭露。

### 最新已驗證 CI 證據

- 真 Chromium＋WebSocket 2v2／3v3／4v4，原版 gameDraw 開局＋原生 phaseLoop 暫停： https://github.com/iront1996/noname_xingbei/actions/runs/38149230110 —— **success，18/18 passed**。
- 同提交 V3 離線安全回歸：https://github.com/iront1996/noname_xingbei/actions/runs/38149230209 —— **success**。
- 在全部 2v2／3v3／4v4 使用原生 gameDraw 開局且 AES-GCM checkpoint 冷讀取：https://github.com/iront1996/noname_xingbei/actions/runs/38148735422 —— **success，18/18 passed**。

### 並未完成、不可對外宣稱可玩

- 尚未將 `Player.phase()` 運行至第一個**合法玩家出牌或星杯技能**，`chooseToUse` 等原生 `GameEvent.send()` 仍受 `V3_NATIVE_EVENT_UNSUPPORTED` 安全限制，連複雜 nested/parallel events 也無可靠的等待／續行支持。正式回合只能在上述 CI pause gate 停止。
- 原生技能列表雖已載入，但沒有跨版本完整技能效果、規則關鍵詞、角色合法選取、勝負事件串接的完整自動化覆蓋；對局仍會拒絕 `command`（`RULES_ENGINE_NOT_IMPLEMENTED`）。
- 目前只有「加密開局狀態寫入＋冷讀取」，尚不能在 Chromium crash／VPS 重啟後 **恢復原生進行中事件和同一回合**。缺完整規則狀態 checkpoint、事件日志、隨機性及私密資訊重放。
- 仍只有 V3 分支內 loopback ephemeral PoC；線上 V3 使用舊架構。不可提早要求用戶更新 VPS 或召集真人反覆試玩。只在完整合法行動、技能、勝負、掉線、存檔回復安全通過後安排一次集中驗收。


## 2026-10-12：原生開局冷重建、Chromium 接管、原版第一個攻擊／法術事件

本輪只修改 feature/host-reconnect-v3-playtest 上的 V3-only 專用模組、測試及文件。共用 noname/**、mode/xingBei.js、V1/V2、線上 V3、VPS、8080/8081、Cloudflare 未修改。所有新 broker 仍限 127.0.0.1:0。

### 真開局資料可在全新 Chromium 重新生成

- game/v3-native-xingbei-seat-session.mjs 新增 restoreOpeningCheckpoint：於任何原生狀態寫入前校驗 schema、房間 ID、4/6/8 個固定 Player ID 與座位、角色合法與唯一、原版星杯卡牌每張實體 ID 對應原版牌名、全套牌堆 ID 完整且唯一、手牌每席四張。
- 在獨立新 Chromium JS Realm 中，使用原版 Player.init 和 Card.init 重建原生角色、原四張手牌和完全一致順序的剩餘牌堆；再匯出的開局資料與原 AES-GCM 冷讀取 payload 相同。
- tools/v3-native-cold-rebuild-probe.mjs 另起真 Chromium 並利用 CI synthetic binding 驗證上述內容與偽造卡名、房間、Player ID 的拒絕。這是原生內容冷重建，不代表真 broker 斷線或任何 GameEvent mid-turn 恢復。

### 同 broker 真 Chromium 失聯接管

- game/v3-authority-websocket-broker.mjs 新增預設 false 的 enableOpeningRecoveryExperiments；僅 V3_ALLOW_SEAT_EXPERIMENT=1 與 Node AES-GCM openingCheckpointStore 才可啟用。
- 僅 Node host API captureOpeningCheckpoint 會向原主持 Chromium CDP 讀取合法開局快照，重新核對由 broker 簽發的所有 Player ID，將密文落盤。玩家 WS 絕不允許上傳或控制完整手牌存檔。
- 僅 Node host API recoverOpeningCheckpoint 能在同一 broker 中維持已認證真人 socket、token 與固定 Player ID，停止失聯主持、等待舊私有 WS 關閉、再開 Chromium 與新的內部 secret，將加密快照重建為原生 Player/Card／牌堆，最後向每席各自補發本人的私有手牌。4、6、8 席皆在實際瀏覽器測試，驗證 PID 不同且沒有跨座位卡牌外洩。
- 這不是 VPS/broker restart 恢復：目前要求 broker 存活、各席在線；room sessions、token hash、native EventStack、RNG、技能與進行中回合仍不具完整持久化。

### 回合中斷不會被偷換成開局恢復

- broker 以 openingRecoveryArmed 記錄由伺服器擷取且確認未開始回合的開局快照；Node host API beginNativePhaseAtOpening 在啟動原版 phaseLoop 之前撤銷恢復資格。
- CI 在原生 phase 執行中停止真 Chromium，驗證 recoverOpeningCheckpoint 明確回傳 OPENING_RECOVERY_DISARMED，且未暗中恢復舊的起始四張手牌。
- 所有相關控制均為 Node host-only 函式；由真人 WebSocket 傳入同名 type 均為 UNKNOWN_MESSAGE_TYPE。

### 原版首回合已推進至攻擊／法術選擇事件

- V3 專用離線門閘 releaseOriginalPhaseToActionGate 讓原版 Player.phase() 運行直到真 XingBei xingDong GameEvent 建立，綁定經認證的當前 Player ID。
- 第二層門閘 releaseOriginalActionToSelectionGate 讓原版 xingDong 原始內容初始化 gongJiOrFaShu 行動計數並建立真正的 gongJiOrFaShu GameEvent，隨即在選牌、目標與技能內容執行之前再次暫停。原版 2v2、3v3、4v4 模式全部覆蓋。
- 因獨立 Chromium 沒有執行原版完整 UI boot，僅在 CI 測試的 offboard runtime 補上原版 phase/Game.log 所需的隱藏 ui.dialogs、ui.sidebar、ui.arenalog、ui.historybar。
- 原版 Player.phase 的音效 callback 只能在伺服器本地按完全相同函式內容視為 no-op；其他 Player.send，包括內含合法音效語句但夾帶額外 JavaScript 的 callback，均明確拒絕 V3_NATIVE_REMOTE_CODE_SEND_DENIED。沒有將任何 player-provided script 交給 Chromium。
- 上述原生事件尚未讓真人出牌、指定目標、啟動主動／被動技能或處理真實攻防；command 仍是 RULES_ENGINE_NOT_IMPLEMENTED，不能用於真人對局。

### CI 驗證

最新程式提交 2b4df0ce1c79087d4c832929df66d3fd3ef0bef4：
- 真 Chromium／原版事件、2v2/3v3/4v4、多 socket、獨立主持接管、加密開局冷重建與斷線保障： https://github.com/iront1996/noname_xingbei/actions/runs/38170680019 —— SUCCESS，18 tests / 18 passed / 0 failed。
- V3 離線安全回歸： https://github.com/iront1996/noname_xingbei/actions/runs/38170680121 —— SUCCESS。

下一個核心工作：建立原版 gongJiOrFaShu/chooseToUse 的可信合法卡牌 ID、目標與行動驗證協定，接通真正星杯技能與觸發事件，並在持久化 event history、原生事件恢復、broker 重新啟動狀態接管之前保持 fail-closed。現階段不更新 VPS、不請真人測試。


## 2026-10-12：首張真原生手牌的伺服器認證所有權預檢

本階段繼續在 feature/host-reconnect-v3-playtest 隔離分支，不改共用非 V3 程式、既有 VPS 或線上 V3。第一個真正原版 XingBei gongJiOrFaShu GameEvent 尚被安全閘門暫停；此階段只完成「伺服器認證選牌資格的最前置所有權檢查」，**沒有完成合法出牌、選目標、技能效果或攻擊結算**。

- game/v3-native-xingbei-seat-session.mjs 透過 preflightNativeActionCardOwnership，在原生 gongJiOrFaShu 事件已由 original xingDong 建立且仍暫停的狀態下，核對目前原生 Player 是否就是當前行動座位、固定認證 Player ID 是否吻合，並對原版 Player.getCards('h') 的原版 Card DOM 實體以唯一 v3card ID 查核。別人的牌、別人的座位、偽造 ID 一律拒絕；不會消耗或移動卡牌，不會觸發任何卡牌效果。
- game/v3-authority-websocket-broker.mjs 新增預設關閉且 CI-only 的 enableNativeOwnershipProbes；只有 V3_ALLOW_SEAT_EXPERIMENT=1 才能開啟。玩家的 WS action_ownership_probe 只允許 type/requestId/cardId 三個欄位，不接受自稱的 seat、playerId、traceId、target、script 或 action。
- broker 從當前已認證 socket 取 seat 和固定 Player ID，產生不可預測 trace，私訊主持 Chromium authority_action_ownership_probe；原生 Chromium 在真 Player DOM 上重新核對，僅回覆 boolean owned，broker 再把結果回傳原仍持有該座位的 socket。回覆標示 fullRulesValidated:false、actionExecuted:false，且沒有外人手牌名稱／卡牌 ID。
- 64 個 outstanding 上限、4 秒逾時、socket 斷線／替換後不回覆舊 socket、工作程序私有 WS 失聯或 broker close 均清除 outstanding。人類客戶端偽造 authority_action_ownership_result 仍遭 UNKNOWN_MESSAGE_TYPE。
- command(action:'playCard') 等正式指令依舊 RULES_ENGINE_NOT_IMPLEMENTED。此預檢不授權動作，不提供規則結果，且不能被視為出牌合法性驗證。

### 全模式自動驗證

提交 1a501c33f68cac609bc12db33318a7cfc870b36f：
- 真 4/6/8 人 WebSocket＋原版 Card/Player Chromium 原生事件，合法本人持牌、他人卡牌、非行動座位、冒充 Player ID/追蹤碼/目標/腳本／回執，以及 Chromium 失聯： https://github.com/iront1996/noname_xingbei/actions/runs/38171261536 —— **SUCCESS：18/18 passed, 0 failed**。
- V3 offline regressions 含預設禁用保護與任意 gameplay 禁止： https://github.com/iront1996/noname_xingbei/actions/runs/38171261527 —— **SUCCESS**。

下一個關鍵阻塞：原版 chooseToUse 事件的卡牌規則／角色技能／傷害與應戰、目標範圍、隱藏資訊與結果執行的完整伺服器主導方案，以及事件／RNG／reconnect token 持久化。尚不應請求 VPS 更新或真人反覆試玩。


## 2026-10-12：獨立主持通道失聯快速拒絕與 4/6/8 人雙輪重連矩陣

本輪只修改 V3 實驗分支上的 `game/v3-authority-websocket-broker.mjs`、兩個 `tools/test-v3-*.mjs` 測試及本文件；沒有變更共用 `noname/**`、`mode/xingBei.js`、V1/V2／線上 V3 或 VPS 服務。

- 主持 Chromium 的**私有認證 WS** 一旦關閉，broker 立即清掉同房間尚未回應的 transport probes、計時器，通知仍有效的原真人 socket `WORKER_CHANNEL_OFFLINE`；其後即使舊 channel 發出延遲回覆，也不得轉換為成功。
- worker channel 失去當前權威 mapping 時，拒絕任何舊 channel 的投影更新、回執或事件操作（`WORKER_CHANNEL_REVOKED`）。`broker.inspectWorker()` 同時確認 Chromium OS 程序與受驗證通道存在；**僅 PID 存活不足以宣稱主持健康**。
- 假 WebSocket 回歸重現「傳輸探測送達 Chromium 但 Chromium 不回覆」後突然斷線，驗證立刻失敗、舊 ACK 不生效、原本尚未實作的 gameplay 仍拒絕。
- 真 Chromium 整合測試新增 `2v2`、`3v3`、`4v4` 各兩輪原開房者與另一個座位**同時斷線／逆序重連**。斷線期間其他真人依然可以透過原本 Chromium PID 完成 transport probe，恢復後的固定 Player ID 不變、session token 必須輪替、舊 token 被拒絕，重連後所有座位同步且不會偷偷允許出牌。
- **本輪 CI 結果**：V3 Playtest Offline Safety Tests [38173171386](https://github.com/iront1996/noname_xingbei/actions/runs/38173171386) **SUCCESS**；V3 Chromium Authority Worker PoC [38173171463](https://github.com/iront1996/noname_xingbei/actions/runs/38173171463) **SUCCESS**。對應包含程式與測試的提交 `f1f1a7494c42165df0f57e06b8ae12dbebc61a29`。

**仍未達上線／真人驗收門檻**：`gongJiOrFaShu`／`chooseToUse` 真正合法出牌、技能／觸發事件完整執行、私有遊戲行動結果、完整勝負發布和持久化中途事件恢復都沒有完成。這些測試證明的是獨立主持連線的故障邊界，不是完整一局星杯對戰。舊版 V3 playtest 與 V1/V2 均維持不變。


## 2026-10-12：Chromium 程序存活、認證通道中斷時的開局安全接管

- 在 V3-only Chromium worker 增加**僅 `V3_ALLOW_SEAT_EXPERIMENT=1` 時生成的測試注入方法**，由 Node/CDP 本機控制主動切斷內部 authority WebSocket，不更改遊戲引擎，也不向玩家暴露呼叫途徑。
- `broker.inspectWorker(roomId)` 必須同時驗證 worker process 與認證通道；即使 PID 還在，失聯回傳 `WORKER_CHANNEL_OFFLINE`。
- 除既有「Chromium 整個進程消失」的恢復測試外，在真實 2v2 Chromium 開局資料完成加密捕獲、一次冷重建後，再讓**活著的 Chromium**僅失去認證通道：恢復程式確認原房間全部座位在線、原始 Player ID／卡牌順序／開局存檔一致，主動停止舊 Chromium、另起程序重建，逐席重新核對本人手牌與其他玩家手牌不得洩漏。
- 僅在 `openingRecoveryArmed`、尚未開始真實 phaseLoop、持有可信加密開局存檔時，這條路徑才可執行。任何尚在有效連線中的主持不被強制重啟；回合開始後的私有事件／技能／RNG 不可用開局 checkpoint 偷渡恢復，仍回 `OPENING_RECOVERY_DISARMED`。
- 真 Chromium CI 在提交 `669325977a66f76eed32d83d0171a59a4e216258` 驗證通過：[V3 Chromium Authority Worker PoC 38173570549](https://github.com/iront1996/noname_xingbei/actions/runs/38173570549) **SUCCESS**（21/21 tests）；[V3 Playtest Offline Safety Tests 38173570539](https://github.com/iront1996/noname_xingbei/actions/runs/38173570539) **SUCCESS**。
- 某個較早提交 `c81d791...` 的 CI 曾在新 2v2 測試失敗，原因是測試仍比較第一次冷重建的 PID，沒有更新成第二次重建的新 PID；後續提交修正測試比對並**重新跑完**真 Chromium CI 為 SUCCESS。沒有把初次失敗隱藏或視為通過。

這仍**只恢復未開局的原生角色／手牌／牌庫**，不代表已恢復中途 GameEvent、技能效果或任何已執行動作。尚未實作的 `gongJiOrFaShu`、`chooseToUse` 完整合法牌／目標驗證、回應、結算及終局仍採拒絕式安全界線。整個變更在 V3 實驗分支、loopback ephemeral broker 與 GitHub CI；V1/V2、正式 V3、VPS 服務沒有更新。


## 2026-10-12：原版攻擊卡牌目標的伺服器認證預檢（尚不出牌）

本輪延續 V3 Chromium offboard，新增 `action_target_probe` 的**只讀印刷規則預檢**，並未開放 `command: playCard`。此功能延用預設關閉的 `enableNativeOwnershipProbes`，且只能在 `V3_ALLOW_SEAT_EXPERIMENT=1` 的隔離測試啟用；正式 V3 仍不支援此指令。

- 真玩家 WS 只允許 `{type:'action_target_probe',requestId,cardId,targetSeat}`。由 broker 依當前 socket 取得 `seat`、穩定 `playerId`，建立不可預測 trace，轉交私有 Chromium 主持通道；客戶端提交的 `seat`、`playerId`、`traceId`、`script`、`action`、`targetPlayerId` 等一律拒絕。
- Chromium 在**原版 `xingDong → gongJiOrFaShu` 已建立且暫停**的事件上呼叫既有 `preflightNativeActionCardOwnership`，實際確認原生 `Player.getCards('h')` 擁有該唯一實體牌，再驗證目標是存活的 native Player／合法座位。禁止查詢其他玩家秘密牌或在非當前出牌座位預檢。
- 僅對原生 XingBei 卡包明確確認的五種一目標攻擊牌 `anMie`、`shuiLianZhan`、`huoYanZhan`、`fengShenZhan`、`leiGuangZhan`，呼叫**原卡包的** `lib.card[card.name].filterTarget(physicalCard,actor,target)`。同陣營拒絕、異陣營可通過**印刷卡面目標的必要條件**。其餘法術、技能、虛擬牌一律返回 `supportedPrintedAttack:false`，不推測合法性。
- 回覆只有此目標預檢判斷，永遠包含 `fullRulesValidated:false`、`targetFullyValidated:false`、`actionExecuted:false`、`cardConsumed:false`。它不選目標、不扣手牌、不觸發傷害，也不改動 `GameEvent`、`_status.event` 或沙箱。
- 所有 pending 皆有 trace、原 socket／seat／Player ID／目標座位比對、四秒逾時、64 outstanding 共用上限、房間/worker 失聯撤銷，以及同座位重新連線後舊請求回覆捨棄。偽造另一個目標的 ACK、重放同一 trace、玩家冒充 Chromium 回覆和任意 JS 均有安全回歸測試。
- 真 Chromium 2v2、3v3、4v4 測試對所有當前真人座位持有的開局卡牌檢驗目標預檢，並**不依賴亂數手牌恰好抽到攻擊牌**：直接核對原始星杯卡包五種攻擊的印刷 `filterTarget`，確認同陣營／異陣營、卡牌位置和私密投影界線。

### 已完成自動驗證

- [V3 Chromium Authority Worker PoC，38174132791](https://github.com/iront1996/noname_xingbei/actions/runs/38174132791)：**SUCCESS，21/21 passed，0 failed**（含原生 Player/Card、完整三種人數拓樸與新攻擊目標預檢）。
- [V3 Playtest Offline Safety Tests，38174132796](https://github.com/iront1996/noname_xingbei/actions/runs/38174132796)：**SUCCESS**。
- 在提交 `0a706a88...` 的早期測試版本，曾因一個已被 socket 撤銷的模擬 pending Promise 未妥善等待／捕捉而造成 offline CI failure；後續提交 `09614ec0...` 修正並重新跑綠。不可將原 failure 當作已驗證成功。

### 下一個必須解決的阻塞

原版 `chooseToUse` 有 `event.filterCard`、`lib.filter.cardEnabled/cardUsable`、可變技能 `game.checkMod`、`targetInRange`、`ui.selected`、角色技能、遠端原生 `GameEvent.send()`、攻擊應戰與 `Player.useResult()`。上述「五種印刷攻擊牌的目標預檢」**不能替代**任何一個，亦不代表完成合法牌行動、傷害／士氣／星杯與勝負結算。下一個工程先在隔離 Chromium 建立完整原生選牌／目標選擇事件的可驗證 waiting contract，再接到受認證 seat、原版執行與私有結果。直到完整操作/技能/終局/持久化續行驗證通過，不切換線上 V3、不更新 VPS、不安排真人反覆測試。

V1/V2、master、`noname/**`、`mode/xingBei.js`、VPS、Cloudflare、8080/8081 沒有修改或重啟。


## 2026-10-12：原生 `chooseToUse` 安全暫停上的伺服器認證選牌預覽（非出牌）

前一階段只建立原生持牌／攻擊卡面目標預檢。本階段在 **2v2／3v3／4v4 真 Chromium** 的原版 `xingDong → gongJiOrFaShu` 已建立、`chooseToUse` 還未執行的安全閘門上，建立可斷線取回的**選牌意圖預覽視窗**。

- `game/v3-native-xingbei-seat-session.mjs` 透過 `beginNativeUseCardPreview` 驗證 `selectionEvent instanceof GameEvent`、行動玩家固定 Player ID、確實仍暫停、事件原本的 `filterCard`、`filterTarget`、`selectCard=[1,1]`、`selectTarget` 和 `position='hs'` 契約，再由原生 `Player.getCards('h')` 產出唯一實體 `v3card_*` 的四張手牌 ID。它只提出待驗證**候選牌意圖**，並**不呼叫**原版 `event.send()` 或 `chooseToUse` 的 step 0。
- `game/v3-chromium-authority-worker.mjs` 僅透過驗證過的 worker 私有通道送出 `source:'preview'`、`kind:'card'` 選項；`game/v3-authority-websocket-broker.mjs` 只在 `enableNativeOwnershipProbes`、`enableChoiceWindowExperiments` 和 `V3_ALLOW_SEAT_EXPERIMENT=1` 同時成立的離線隔離實驗允許這種視窗，並僅向指定已認證座位送出本人手牌選項／128-bit 隨機票券。
- 玩家 `choice_submit` 必須持有同房間、同座位、同 Player ID、同票券及提供選項之一。伺服器的原生預覽回呼核對**同一個暫停的原生 GameEvent**及牌的當下實體所有權，只在 Chromium 記下所選 `cardId`；原版 `Player.unwait`、`event.result`、`game.resume`、`Player.useResult`、卡牌移動與傷害**均不觸發**。
- 預覽結果仍是 `CHOICE_DELIVERED_NOT_APPLIED`（狀態 `delivered`），不能使用 `authority_choice_native_applied` 假裝原版 GameEvent 已套用。改選別的卡牌、持舊票券跨座位作答、其他玩家讀取私人選項均遭拒絕。
- 開房者在預覽視窗開啟期間斷線，原主持 Chromium 與 pending ticket 仍存活；重新認證同座位後，broker 重發**原本**的 ticket 和私人選項，不要求客戶端保存任何主持狀態。驗證後手牌、action counter 與暫停的原生事件都未改變。
- 原有「不同 Chromium 程序、精簡合成橋接器重建加密開局資料」不應被新增預覽介面阻擋。因此預覽 hooks 在真實 authority bridge 存在時**可選安裝**；合成冷重建橋接器缺少預覽 hooks 仍能驗證原角色與開局手牌。只有半套預覽 API 才拒絕。
- 選擇視窗目前存放在 broker 記憶體，現有 TTL 為 120 秒；**尚無逾時後恢復未完成預覽、重啟 broker 後保留 ticket、持久化原生 GameEvent／RNG／回合中途續行**。不能把短時間內的斷線重連案例解釋成永久續局。

### 隔離自動化驗收

- [真 Chromium CI 38176342050](https://github.com/iront1996/noname_xingbei/actions/runs/38176342050)：**SUCCESS，21/21 passed，0 failed，0 skipped**。含原生 4/6/8 人座位／角色選擇／開局冷重建、原生事件停在首張行動牌、同一手牌視窗經玩家斷線重連與票券交付後仍不出牌。
- V3 離線回歸可獨立驗證 `preview` 來源不得偽裝為 `native` 結算、跨座位／錯誤票券／更換選項拒絕、預設未啟用 preview 功能；參見 [V3 Playtest Offline Safety Tests 38176342116](https://github.com/iront1996/noname_xingbei/actions/runs/38176342116) **SUCCESS**。
- 為避免 Chromium 整合異常永遠等待，V3 專用工作流程現在設有 240 秒的執行界線，未修改任何 V1/V2、正式 V3 或 VPS 啟動方式。

### 下一項阻塞

要變成**真正玩家出牌**，仍須在完整 `chooseToUse` 的安全沙箱內重現 `lib.filter.cardEnabled/cardUsable`、`event.filterCard`、技能／距離／目標選擇、原版 `Player.useResult()`、敵方應戰、傷害、士氣與終局，並有實際原生多回合 4／6／8 人驗證與回合中途持久化。此階段既未執行 step 0，也不能聲稱技能已核准。V1/V2、`master`、`noname/**`、`mode/xingBei.js`、線上 V3、VPS、Cloudflare／8080／8081 未觸碰。


## 2026-10-12：原生選牌後的印刷攻擊目標候選與雙階段重連

只在 V3 隔離分支加入**尚未執行的選牌 → 目標候選**流程。依前一階段的真原版 `gongJiOrFaShu` `GameEvent`（仍 `game.pause()`）持牌選擇預覽，Chromium 接收到已認證座位提交的實體 `v3card_*` 後，在**不執行原版 `chooseToUse` step 0**、不解除暫停的情況下，對原生 `Player` 與原卡包 `lib.card[name].filterTarget` 做只讀的目標候選篩選。

- 目前**只支援** `anMie`、`shuiLianZhan`、`huoYanZhan`、`fengShenZhan`、`leiGuangZhan` 這五種 `gongJi`、一目標的印刷攻擊牌；不支援的法術、技能、虛擬牌、未持有卡牌或事件非暫停狀態一律不開新視窗。原版技能修正、射程、額外目標、真正 `chooseToUse` 選牌合法性均**未驗證**。
- Chromium 僅建立 `s0` 至 `s7` 的目標座位選項，不把其他人的私有卡牌送到任何客戶端；兩階段皆由 broker 建立新的 128-bit 隨機 ticket，綁定同房間、同座位、同固定 `Player ID`。
- `createV3AuthorityChoiceWindows.advancePreview()` 必須看到**前一張選牌票券已提交且已被 Chromium 回執**，並核對前一張卡片的確切選項與票券，才會原子替換成 `kind:'target'`。舊票券立即撤銷。玩家不能直接跳過第一階段、提前開目標視窗，或提交不在清單內的目標。非預覽來源無法開 `target` 選項。
- 原生 preview hooks 再確認目前仍是**同一個暫停的 `gongJiOrFaShu` `GameEvent`**、目前手牌仍屬於本人，以及提交的目標仍通過卡牌印刷目標規則，才記錄 `selectedTargetSeat`。不呼叫 `Player.unwait()`、`game.resume()`、`Player.useResult()`、不扣牌，不使敵方受傷，也不更新星杯／士氣／終局。
- WebSocket 真人座位中途斷線不會清除 broker 的未完成預覽票券：開房者可先在第一階段斷線、重連選牌，再在第二階段斷線、重連選目標；不改 Chromium PID／`GameEvent`。每次重連的 token 按既有機制輪替，別人的座位無法提交舊票券或新票券。
- `tools/test-v3-authority-choice-windows.mjs` 和 `tools/test-v3-authority-websocket-broker.mjs` 增加錯誤先後順序、冒充座位、錯誤前張選項、重放／改選、非預覽來源目標及 `authority_choice_native_applied` 冒充已結算的安全回歸。真 Chromium 測試對 4／6／8 人和真手牌做條件化的印刷攻擊預覽（避免依賴隨機手牌一定抽到指定類型）。

### 測試資源隔離

原先 Node.js 預設同時執行全部 Chromium 測試，曾使單個測試觸發 `MATRIX_WAIT_TIMEOUT`，並使 240 秒 CI 上限失敗。V3-only CI 已將 `--test-concurrency=2` 配合明確 360 秒總上限，限制同時啟動的無頭瀏覽器數量。這是**測試穩定性調整**，不修改真實房間的玩家數、主持服務啟動設定或 V1/V2。

### 尚未完成

**伺服器主導的完整原生合法出牌**需要先安全執行 `event.filterCard`、`lib.filter.cardEnabled/cardUsable`、技能 `game.checkMod`、`targetInRange`，接著執行原版 `chooseToUse` 的觸發、應戰、傷害、士氣及勝負事件，並實作回合中的 `GameEvent`／牌庫／RNG 持久化。此處兩階段的預覽和已確認的印刷 `filterTarget` **不是**完整合法出牌或攻擊結算，也不能自動完成一局遊戲。現階段不應進行 VPS 部署或要求真人反覆試玩。

僅修改 `game/v3-*.mjs`、`tools/test-v3-*.mjs`、V3 Chromium 專用 CI 和本工程文件；`noname/**`、`mode/xingBei.js`、V1/V2、線上 V3、VPS、Cloudflare、8080／8081 未修改。


## 2026-10-12：真原版 chooseToUse 等待、取消出牌、全員重連與連線世代認證

本批功能只在 `feature/host-reconnect-v3-playtest` 及 CI-only `V3_ALLOW_SEAT_EXPERIMENT=1` 隔離。**未修改 V1、V2、共用 Noname／xingBei 原始碼、線上 V3、VPS 或 Cloudflare。** 正式 `command:playCard` 仍然拒絕 `RULES_ENGINE_NOT_IMPLEMENTED`。

### 已完成的原生實驗

1. `game/v3-native-xingbei-seat-session.mjs` 在原版 `gongJiOrFaShu` 已被 `xingDong` 產生而暫停時，能不執行 `game.checkMod` 的情況下保守審核五種原始印刷一目標攻擊卡牌的原始 `enable`、`selectTarget`、`usable`、`range` 等定義。列舉 `getSkills('invisible')` 及全域技能可能的 mod/onChooseToUse hooks，但**不呼叫**回呼。以故意會執行 `game.resume()` 的惡意測試 mod 驗證審核沒有執行該技能。此審核絕不宣稱完整合法出牌。
2. `game/v3-authority-choice-windows.mjs` 新增僅主持端使用的預覽票券續租。真人掉線不會消除開啟中的原生選牌／選目標視窗；`game/v3-chromium-authority-worker.mjs` 在存活且私有認證 WS 正常時按固定間隔續租。已過期、上一階段、非預覽的票券不允許續租。主持通道死亡仍會撤銷視窗，不能延續原本中途狀態。
3. `inspectNativeActionInvariant` 捕獲真原生 Player/Hand、牌庫順序、HP、士氣、行動計數及原版 EventStack；驗證所有*只讀*攻擊／選目標預檢前後沒有變更。這是 CI 私有 accessor，不對任何玩家公開其他玩家手牌。
4. `game/v3-native-event-wait-adapter.mjs` 提供僅對已認證本人的原版 `gongJiOrFaShu` `GameEvent` 生效的**單次** `GameEvent.send` 攔截。經 `releaseOriginalSelectionToNativeWait`，隔離 Chromium 真正執行原版編譯後 `chooseToUse` step 0 及其內部原版前置步驟，直到 native online `event.send()` 才由 V3 攔截：建立真 `Player.wait()` slot、`game.pause()`、本人選牌視窗，而不是執行舊版向客戶端傳送可執行 JS 的途徑。任意額外 `send` 仍拒絕。
5. 只有通過同一原生 `GameEvent`、`Player ID`、`_status.event`、原始等待 slot 和本人已認證票券的檢查後，才可以在新卡牌視窗提交 `pass`，由受管 `Player.unwait({bool:false})` 把「不出牌」回覆交還原版事件。單純只讀的預檢視窗不顯示 pass，已提交的卡牌意圖也不允許冒充 pass。這不代表可以執行真攻擊卡牌。
6. 新增 `tools/test-v3-original-choose-to-use-wait-chromium.mjs`，對真 4 人原版角色、原版 `gameDraw`、原版 `phaseLoop`、原版 `xingDong` 與 `chooseToUse` 的 card preview／pass 兩條路徑，驗證**全部 4 名真人一起斷線**時 Chromium 程序和唯一待選視窗存活。全員分別恢復後固定 Player ID 不變、重連 token 及 `connectionId` 重新產生，舊票券不洩漏給其他座位，選擇或取消後仍不消耗手牌。

### 同一座位的連線世代防護

在 `choice_submit` 向私有 Chromium 投遞原生選擇時，broker 額外附上當下 socket 的 96-bit `connectionId`，Chromium 驗證該 `connectionId` 必須匹配最近的 `authority_roster` binding，不能只比對永遠不變的 Player ID。因此同一座位被新 websocket 接管後，舊連線已排隊的延遲回覆不應在新 session 套用。正式遊戲依然沒有收到任意 `command` 出牌權限。

### 已確認測試基線

- [原生 `chooseToUse` 真正進入受控等待：CI 38179729149](https://github.com/iront1996/noname_xingbei/actions/runs/38179729149)：**22/22 PASS**。
- [原版 `Player.unwait({bool:false})` no-card 回覆：CI 38180057378](https://github.com/iront1996/noname_xingbei/actions/runs/38180057378)：**23/23 PASS**。
- [全房間真人同時斷線與重連：CI 38180212359](https://github.com/iront1996/noname_xingbei/actions/runs/38180212359)：**23/23 PASS**。
- [初版連線世代驗證：CI 38180296685](https://github.com/iront1996/noname_xingbei/actions/runs/38180296685)：**SUCCESS**，並有 V3 離線回歸 [38180296659](https://github.com/iront1996/noname_xingbei/actions/runs/38180296659) **SUCCESS**。

### 嚴格未完成的項目

- **尚未完成原版真正合法出牌**、技能修正完整授權、攻擊與防禦應戰、傷害／士氣／勝負原版結算、所有原生多回合角色技能。
- 真的 `chooseToUse` step 0 會運行原版 `onChooseToUse` 技能回呼，所以 CI 證明的是原版內容能在隔離 Chromium 執行至等待；**不是**技能安全審核、完整 rules engine 或持久化。
- 玩家全部離線仍可保留**活著的** Chromium 原生事件，但若 Chromium 或 broker 崩潰，中途 EventStack/RNG 等依然沒有可靠持久化與重啟恢復功能。只有開局 checkpoint 可冷重建，不能把它冒充中途續局。
- 不部署到 VPS，也不要求真人反覆測試。下一段應檢查通過 pass 後原版 `xingDong` 動作計數及自然續行，再決定是否可以安全接下一張卡牌的真正規則驗證。


## 2026-10-12：第二玩家原版 xingDong → gongJiOrFaShu 安全閘門

- 在上一段已驗證的第一玩家 `Player.unwait({bool:false})`，原版 `xingDong` 正確扣除行動次數並自然抵達第二玩家 `xingDong` 後，新增隔離 `releaseNextOriginalActionToSelectionGate`。只允許同一份 V3 Chromium 記憶體內的**第二玩家**原版 `xingDong` 開始，並在其真正 `gongJiOrFaShu` 子事件建立之後、`chooseToUse` 尚未執行以前立即暫停。
- 驗證前置條件包含第一玩家確實完成原生 pass、第一次預覽標記 passed、第二玩家的 native `GameEvent` 及固定 Player ID、有效暫停點、不可重複釋放。禁止第一玩家重複選牌、跳座位與直接呼叫出牌 API。
- 真 Chromium 原生測試新增第二玩家事件歸屬、靜止中的四名玩家實體手牌、牌庫與 HP 不被這次控制閘門改動，以及重複釋放、未實作 `command:playCard` 拒絕的斷言。此階段**沒有**執行第二玩家 `chooseToUse`、沒產生第二張選牌票券、沒有技能／傷害／終局完整驗證。
- 修改僅限 `game/v3-native-xingbei-seat-session.mjs`、`game/v3-chromium-authority-worker.mjs`、`tools/test-v3-original-choose-to-use-wait-chromium.mjs` 與本文件，仍只由 `V3_ALLOW_SEAT_EXPERIMENT=1` 允許、未部署 VPS、V1/V2/master 未變更。執行結果必須以本次 CI 原始 log 確認，不沿用前一輪 PASS。


## 2026-10-12：原版取消出牌 → 下一玩家安全選牌的 4／6／8 人矩陣

原先只對 2v2 運行的 `tools/test-v3-original-choose-to-use-wait-chromium.mjs` 擴展為 2v2 的選牌／取消兩路徑，以及 3v3、4v4 的取消路徑；全用真人座位 WebSocket 模擬、多席同時離線後重新認證，並通過原版 `gongJiOrFaShu`／`xingDong` 證明第二玩家選牌子事件仍暫停、手牌與牌庫不變。每個人數均採相同伺服器程序所有權，不開放正式出牌權。CI 結果須對應**本次提交**，不能套用以前通過的紀錄。


## 2026-10-12：第二座位真原生等待前斷線／恢復（隔離驗證）

在原本 2v2／3v3／4v4 的連續座位測試中，第二座位的真原版 `gongJiOrFaShu` 已建立但尚未進入 `chooseToUse` 前，再主動關閉**第二座位本人** WebSocket 並重新認證。檢查原生暫停事件、穩定 Player ID、未改動 Chromium PID、重新輪替 connectionId 與 token，舊 token 不得再次使用。第二座位仍不可跳過選牌閘門直接 `command:playCard`。本項只驗證**跨斷線持續存在的原生事件安全邊界**，不是第二座位技能結算或伺服器崩潰恢復。僅限 V3-only CI 與實驗分支。


## 2026-10-12：第二玩家連續原生等待／不出牌 → 第三玩家事件安全閘門

- 之前「第二玩家斷線重連」測試提交 `ac2d8d1` 的真 Chromium CI 失敗，是測試在已關閉的舊 WebSocket 呼叫 `ask()` 而等待逾時；沒有把失敗宣稱為通過。新測試只對新認證 socket 提交訊息。
- 原版第一玩家 `Player.unwait({bool:false})` 後，第二玩家的原生 `xingDong → gongJiOrFaShu` 可按嚴格單次允許進入原版 `chooseToUse` step 0；`GameEvent.send()` 仍攔截可執行 JavaScript 遠端發送，交由受伺服器認證的 WebSocket 本人座位取得新的私密卡牌／pass 票券。
- 原生 `Player.unwait({bool:false})` 只能在對應真 `GameEvent`、原始 `Player.wait` slot、`_status.event`、當前座位與 Player ID 全數相符後發生。第二玩家拒絕出牌後，由原版事件自然推進至第三玩家 `xingDong`，仍於該玩家 step 0 前暫停，不讓技能或攻擊結算偷跑。
- 2v2／3v3／4v4 CI 驗證第二玩家於原版選牌前斷線重連、新 session 身分與票券綁定、跨座位禁止提交、連續兩位玩家取消出牌後 HP、所有私人手牌與牌庫不變、第三玩家原版行動事件為 native 實例。
- 這是**原版取消出牌的離線連續事件通道**，仍然沒有實作真正合法出牌、動態技能、攻防回應、星杯勝負或回合中途崩潰恢復。只能在 `V3_ALLOW_SEAT_EXPERIMENT=1` 的隔離 Chromium 裡測試；V1/V2、master、共享 Noname、正式 V3、VPS 不變。是否成功應以新提交 CI 原始紀錄驗證。


## 2026-10-12：原版第二玩家已開啟的真選擇視窗再次斷線復原

- 在 2v2／3v3／4v4 的**第二玩家原生 chooseToUse 已進入 `GameEvent.send` 並獲得選牌票券**後，再關閉該座位 WebSocket；確認受管 Chromium PID、原版 EventStack 等待與本人票券不消失。用第二輪新憑證再連線，必須重發**同一筆**私人票券至本人新 socket，其他座位不接收。
- 新 socket 本人以同一票券提交原生無牌回覆，原版行動繼續至第三玩家 `xingDong`；手牌、牌庫與 HP 應不變。這是實際原版等待中的連續多次斷線壓力測試，但仍不是中途 Chromium/Node 進程崩潰冷恢復、合法攻擊或勝負結算。


## 2026-10-12：第二個原生選擇視窗期間，全房間再度離線的壓力回歸

將第二玩家原版 `chooseToUse` 真等待中的二次斷線，強化為**全部 4／6／8 位真人同時斷線**；Chromium 私有通道和遊戲事件仍保留，真人 socket 歸零後，各座位依序以自己的最新憑證重連；原第二玩家應取回原私人票券，其他玩家不得看到票券。以原生無牌回覆繼續推進第三座位，對照全體手牌、牌庫、HP。此項仍不代表 Node/Chromium 進程重啟後中途事件能恢復。


## 2026-10-12：原生中途等待的 Chromium 崩潰必須安全拒絕

新增真 2v2 故障注入測試：全部座位在第二個真原版 `chooseToUse` 等待票券開啟時離線、重新認證；然後主動終止受管 Chromium，確認 broker 健康立即判定 `WORKER_UNAVAILABLE`，原票券不能再宣稱 `CHOICE_SUBMITTED_NOT_APPLIED` 成功（應回 `WORKER_CHANNEL_OFFLINE`），但仍存在的真人房間座位不因此被假裝成功恢復。由於本隔離測試沒有啟用開局快照復原，`recoverOpeningCheckpoint` 須返回 `OPENING_RECOVERY_DISABLED`。本項只證明故障後 fail-closed，**中途 GameEvent／Promise／RNG／技能真正冷恢復仍未實作**。


## 2026-10-12：Chromium 已死亡但私有 WebSocket 尚未關閉的票券競態防護

- 在 V3-only broker 的真人 `choice_query`、`choice_submit` 前，驗證受管 Chromium 本身仍能完成私有 CDP 健康檢查，而不僅以 WebSocket `readyState` 認定主持端存活；檢查失敗回 `WORKER_UNAVAILABLE` 且不露出快取票券、不變更選擇狀態、不投遞原生選擇。
- 新憑證重連若遇到尚未關閉的死亡主持通道，只回傳 `choice_interrupted` 而不重發失效的原生票券。健康檢查期間若同一座位被新 socket 接管，舊 socket 不得在 await 後提交。
- 假 Chromium 單元測試刻意只使程序健康失效、保留私有 WebSocket 為 OPEN，核對查詢、提交、重新認證及通道最終關閉的拒絕語意。真 Chromium 中途 GameEvent/RNG 崩潰冷恢復仍未完成；此修改僅限 V3 實驗分支，不部署或變更 V1/V2/VPS。


## 2026-10-12：健康驗證延伸至所有唯讀探測，並覆蓋健康檢查中的座位接管

- 將 Chromium 程序及其當前私有 WebSocket 的雙重健康驗證，延伸至 `transport_probe`、`action_ownership_probe`、`action_target_probe`。受管程序已死亡但私有 WS 暫時未斷時，立即拒絕 `WORKER_UNAVAILABLE`，不建立假待處理探測，也不等待四秒逾時；這些探測仍不授權真出牌。
- 上述探測與 `choice_submit` 一樣，在異步 CDP 健康檢查結束後重新核對「目前 socket 是否仍為本座位 session」和原主持通道，阻止舊座位連線世代的競態提交。
- 新增假 Chromium 單元案例：(1) 程序已死但私有 WS OPEN，三種探測皆拒絕；(2) 特意暫停健康檢查時接管同一座位，舊 socket 不可提交票券，只有新 socket 有效。本批僅限 V3 實驗分支、未部署線上服務或影響 V1/V2。


## 2026-10-12：伺服器主動偵測受管 Chromium 程序死亡

- V3-only broker 現在以單一房間單一監測計時器檢查已認證的獨立 Chromium 主持程序（預設每 3 秒），不需要真人繼續發送訊息；主持程序明確失效時主動關閉私有 WS，沿用既有 `cancelRoom`、清除私人投影與向在線真人廣播 `choice_interrupted` 的安全關閉路徑。
- 監測避免同一房間重疊健康檢查；啟動握手尚未掛入 coordinator 時的 `WORKER_NOT_STARTED` 不當作死亡。私有通道關閉及 broker 結束時都釋放計時器，且任何異步查詢結果必須再次核對目前 room/WS 與 broker 未關閉。
- 假 Chromium 測試讓程序健康失效、保持 WS OPEN 且玩家全程不發送任何請求，驗證 watchdog 自動通知 4 個在線座位、清除舊票券且不冒稱原生 GameEvent 可恢復。此 watchdog 不是 Chromium 崩潰中途冷恢復功能；仍只限 V3 分支，未碰 V1/V2/VPS。


## 2026-10-12：失效主持通道立即中止，不等待關閉握手

- 健康監控已判斷 Chromium 程序失效時，優先對 Node `ws` 伺服器側使用 `terminate()`，而非等待已死亡／卡住的瀏覽器回應正常 Close 帧。這會立即觸發現有私有通道失聯清理、註銷票券、廣播 `choice_interrupted`；只有傳輸實作不支援 `terminate` 時退回 `close`。
- 回歸測試蓄意使假私有 WebSocket 的正常 `close` 不做任何事，但允許 `terminate` 確實中止，確認所有四名在線玩家仍能獲得中斷通知。仍不代表 GameEvent 可跨 Chromium 重啟恢復。


## 2026-10-12：第三玩家原版 xingDong → gongJiOrFaShu 安全入口（V3-only）

第二名玩家真原版 `chooseToUse` 的已驗證 no-card 回覆推進第三名玩家原生 `xingDong` 後，新設立單次 `releaseThirdOriginalActionToSelectionGate`：它只允許第三人原版 `xingDong` step 0 執行，必須在真實 `gongJiOrFaShu` 子 `GameEvent` 生成時立即暫停，不開放 `chooseToUse`、技能回呼、真正出牌、牌庫／HP 改變。所有座位的 Player 身分固定，並驗證 2v2/3v3/4v4、不得重複釋放、第三人私人票券尚不存在。沒有通過合法性與執行授權，正式 `command:playCard` 持續拒絕。

本段只修改 V3-only 原生 seat session、受管 Chromium wrapper、隔離測試和文件；不改 master、V1/V2、線上 V3 或 VPS。是否通過以新提交 CI 為準。


## 2026-10-12：第三玩家原生事件切換後的唯讀所有權授權

已辨識原 `preflightNativeActionCardOwnership` 仍以「第二人的選擇內容曾釋放」推斷目前行動者，在第三人的真原版 `gongJiOrFaShu` 到達後可能錯把已完成的第二玩家事件當作活躍事件。V3-only 修改改以**最新實際原生 `xingDong` 邊界**及其專屬 `GameEvent` 判斷第一、第二、第三玩家，尚未生成該回合選牌事件時直接拒絕，不會回退授權舊座位。

隔離真 Chromium 測試在第三人選牌前暫停點查核：第三人可唯讀查詢自己實體手牌卡牌的持有權；已完成原生 pass 的第二人，即使手中仍保留實體卡，也不能獲得舊回合的 ownership 成功；手牌、牌庫、HP 和未授權出牌狀態維持不變。這不是 `filterCard`、動態技能、目標完整合法性或真正攻擊執行。


## 2026-10-12：印刷攻擊規則預檢綁定當前原生事件

原本 `auditNativePrintedAttackStaticRules` 的印刷定義檢查硬綁第一座位 `selectionEvent`。現改為從伺服器 Chromium 已建立的最新 `xingDong` 原生事件及其所屬 `gongJiOrFaShu` 子事件取出 `filterCard`／`filterTarget` 合約，並確認 `selection.player` 就是此回合的受認證實體 Player。讀取結果額外標明 `activeOriginalEventPlayerId`，避免將第一人的舊 `GameEvent` 誤用於第三人的審核證據。

CI 測試核對第三人的 event provenance、與第二人的 GameEvent 物件分離、未執行第三次選牌 step。這仍只是靜態印刷規則的唯讀證據，不執行完整 `filterCard`、技能修正、效果結算或真出牌。


## 2026-10-12：第三玩家原生等待與第四玩家安全閘門

在前兩位玩家真原版 `Player.unwait({bool:false})` 之後，第三玩家的原版 `gongJiOrFaShu` 可由 CI-only `releaseThirdOriginalSelectionToNativeWait` 進入編譯後 `chooseToUse`，只向已認證本人提供私人票券；等待使用真實 `GameEvent.send` 與 `Player.wait`，禁止遠端執行任意 JS。第三玩家唯一被授權的回覆仍為 `pass`，用真原生 `Player.unwait({bool:false})` 推進至第四玩家真原版 `xingDong`，立即於 step 0 暫停。2v2／3v3／4v4 測試覆蓋第三座位票券不洩漏、回合歸屬、重複釋放拒絕、HP／手牌／牌庫不變。完整技能、實際合法出牌、攻防、勝負、RNG/EventStack 冷恢復仍未實作；只修改 V3 實驗分支，不碰 VPS、V1/V2。


## 2026-10-12：第四名玩家原版階段摸牌的實體牌守恆修復

前一批提交 `8556122` 的真 Chromium CI 在 2v2／3v3／4v4 各發現第四玩家進入 `xingDong` 前，原版回合流程已讓第四玩家獲得額外一張實體牌；原測試錯把「任何原生階段都不得摸牌」當成無牌取消的前提而失敗（23 PASS／3 FAIL）。本批**不放寬對牌的驗證**：逐座位比對前三人及其他玩家手牌完全不變，第四人的舊手牌完全保留且恰有一張新增卡、該卡先前在牌庫唯一存在且之後消失、剩餘牌庫順序不變、所有手牌＋牌庫的實體卡 ID 排序後全等、HP 不變、第二／第三人真原生行動計數歸零。沒有提交任何實際出牌、傷害或技能授權。

如上述嚴格守恆不能通過，應將其視為原版階段或模擬 bug，不能因 CI 方便而跳過。僅修改 V3 實驗分支的 Chromium 驗證檔與工程文件，V1/V2、master、線上 V3、VPS 不變。


## 2026-10-12：第四玩家真原生 xingDong／gongJiOrFaShu 邊界

在原版前三位玩家均只提交真 `Player.unwait({bool:false})`、第四人經原版階段抽一張牌並到達 `xingDong` 前安全閘門之後，新增 V3-only `releaseFourthOriginalActionToSelectionGate`，只允許第四人原版 `xingDong` step 0 執行至真 `gongJiOrFaShu` 子事件產生，立刻暫停，不允許原版 `chooseToUse` 及任何出牌／技能。新增最晚原生事件歸屬的第四座位唯讀實體持有權，原第三座位持有權不再代表活躍回合；封鎖使用第三座位的舊事件建立卡牌預覽。CI 覆蓋 2v2／3v3／4v4，對照前一段已核實的第四階段摸牌後狀態，確認第四安全釋放不再改動手牌、牌庫、HP，且不能重複釋放。本批仍沒有合法出牌、攻防、技能、勝負或中途冷恢復。


## 2026-10-12：第四玩家原生選牌前斷線／重連的程序所有權回歸

於 2v2／3v3／4v4 經三次真原版 no-card 回覆後，第四玩家原版 `xingDong` 已建立並產生真 `gongJiOrFaShu` 子 `GameEvent`，且選牌內容尚未執行。在此狀態主動斷開第四真人 socket，驗證其原生事件仍暫停、Chromium PID 未變、房間持續存在。第四人使用最新一次認證 token 重新連線，確認新 token 和新的 `connectionId` 均輪替、固定 Player ID 不變、舊 token 不可重用，且不會自動出現未授權的選牌票券。第四人自己的唯讀手牌持有權仍可查，第三人已完成回合的持有權不能冒充目前行動權。沒有修改原生規則或增加真人測試要求；只更新 V3 的真 Chromium 自動化測試及文件。


## 2026-10-12：第四座位重連憑證廢止採全新 socket 驗證

強化第四座位原生斷線重連回歸：不再對已認證的新座位 socket 再呼叫 `reconnect`（那只會撞到 `CONNECTION_ALREADY_BOUND`，無法證明舊 token 真的失效）；改由另一條全新、未綁定的真人 WebSocket 使用舊 `reconnectToken` 嘗試認證，必須得到 `RECONNECT_DENIED`，並持續 `NOT_AUTHENTICATED`，確保舊權杖不能趁原生第四玩家等待時奪回座位。此次只有測試與文件變更，絕無執行真出牌。


## 2026-10-12：第四玩家原生 chooseToUse 等待（V3 隔離測試）

最新一批已將原生第四玩家 `xingDong → gongJiOrFaShu` 子事件的單次 CI-only 釋放擴展至原版編譯 `chooseToUse` 的 `GameEvent.send` 等待點。`Player.wait` 由伺服器 Chromium 自行維護，唯一有效私人票券只能發給重新認證的第四玩家，其他三座位與未認證 socket 不得查詢或提交。新增 `fourthSelectionContentReleased`／`fourthOriginalUseWaitReached` 的階段辨識，事件仍在原版 `Player.unwait` 前暫停，所有原本的動態出牌及技能執行仍拒絕。2v2／3v3／4v4 的同一 Chromium 實驗涵蓋票券隔離、原生事件實體歸屬、重複釋放拒絕及 OS 程序不重建。

本次並未授權第四人提交 no-card 造成下一個原生回合的實際推進；該部分需要額外專屬回歸與牌組守恆測試。這不是完整玩法或中途冷恢復。V1/V2/VPS/master 完全不參與。


## 2026-10-12：第四玩家原生 chooseToUse 進入時的牌張異動稽核

前一版 `20fac4e` 兩套 CI 中，離線測試通過，但 Chromium 2v2／3v3／4v4 的第四人測試於舊手牌與私人票券比較時發現票券多一張卡。這並不直接證明該增量為合法原版效果，因此改以真 Chromium 在第四人 `chooseToUse` 前後的實體手牌、牌庫、HP 作嚴格守恆：第四人舊牌完全保留，恰新增一張唯一存在於原始牌庫的卡；牌庫移除該卡且其他牌順序不變，其他玩家手牌完全不變，HP 不變，全體卡 ID multiset 不變，私人票券必須完全等於實際原生手牌（而非較早的私人快照）。若任一條件不成立仍由 CI 報錯。這僅驗證觀察到的物理轉移，**尚未證明摸牌的規則來源或合法性**，仍不會允許生產真人出牌。


## 2026-10-12：修正原生回合摸牌後的過期私有手牌視圖

Chromium CI `20fac4e` 與 `efad4e1` 揭露第四座位原版階段抽牌後，`privateSeatView()` 仍以 `physicalCardsBySeat` 的開局陣列呈現舊四張，而真實 `Player.getCards('h')` 及選擇票券已有第五張。`efad4e1` 的稽核因錯認摸牌時點而失敗。本次修正 V3-only `privateSeatView`：每次從**真實 Chromium Player 手中目前的 Card DOM**讀取實體卡 ID／名稱及其他座位的公開手牌張數，拒絕無實體 ID、重複 ID 或非原生 Card。嚴格比較第四玩家進入 `chooseToUse` 前後的全員手牌、牌庫順序及 HP，要求此時不再抽額外牌；私人視圖和票券必須與原生手牌一致。

這只修正 V3 Chromium 中的視圖讀取，不表示 broker 的連續私人狀態廣播已完成；後續仍需明確的修訂版本與每座位安全投影更新。沒有新增玩家出牌權限，也沒有操作 VPS、V1、V2 或 master。


## 2026-10-12：V3 受管 Chromium 主動刷新 broker 私人投影（手動可信入口）

新增僅受管 Chromium 的私有橋接介面 `publishNativeLiveHands` 與 Node CI-only 封裝：在原生 Player 狀態可讀取時，同步取得所有座位實體手牌與彼此一致的公開手牌張數，使用**遞增的 per-room 修訂版**送至 broker 的 `authority_private_hand`，每份資料仍由既有 broker 驗證穩定 Player ID、每座位所有權與卡牌唯一性，並只向自己的已認證 socket 發出完整手牌。另有 private projection ACK 收斂及修訂版檢查，不能把舊 ACK 誤當新快照完成。

隔離 Chromium 測試在第四玩家已額外摸過一張牌的原生 `chooseToUse` 等待點，由受管 worker 主動刷新所有座位 private projections：第四玩家取得最新完整實體手牌，其他座位只能取得自己的實體牌與全員手牌張數，未認證者不得查詢。此批**不讓人類任意發布快照**，也尚未實作自動在每個原生階段變化後發布、跨玩家牌張交換的原子交易與中途冷恢復。


## 2026-10-12：第四人真原版 pass 接到第五行動者／2v2 回第一座位

隔離 Chromium `chooseToUse` 的第四玩家私人票券已由 broker 驗證後允許唯一的 `pass` 答覆，實際使用原生 `Player.unwait({bool:false})`。新增原版 `xingDong` 第五行動者單次安全閘門（2v2 回第 0 座位，3v3／4v4 第 4 座位），只捕獲真 `GameEvent` 並於 step 0 前立即暫停，任何舊玩家包括循環到首座位都不能沿用已消耗票券／前一輪選牌事件預檢。新增 2v2／3v3／4v4 原生測試，核對恰有一張唯一存在於前牌庫的卡轉移到下一位玩家、其他手牌與 HP 不變、全部物理卡 ID 守恆、第五角色身分正確；再次由 Chromium 發布實體手牌，驗證 broker 私人視圖修訂版恰遞增 1 且與原生手牌一致。**尚未**授權任何真實出牌、攻防或技能執行；中途崩潰冷恢復仍未完成。


## 2026-10-12：第四人 no-card 至第五 xingDong 並不保證額外摸牌

Chromium CI 對 `91b7ecf` 的 2v2、3v3、4v4 證實第四人真原生 `Player.unwait({bool:false})` 已進入第五行動者閘門，但第 5 個玩家在其原生 `xingDong` step 0 尚未摸到任何新卡。先前假定此處一定再摸 1 張，造成同一行斷言 3 組皆失敗。此次維持更嚴格的 **全部原生實體手牌、牌庫順序、HP 完全不變** 檢查，禁止將猜測的摸牌規則包裝為成功；保留第三／第四／第五玩家真實事件歸屬、舊票券拒絕與修訂版重發驗證。是否通過仍依新的 GitHub Actions 結果。


## 2026-10-12：可信原生 xingDong 安全閘門自動刷新私人投影

在 V3-only 隔離 Chromium 框架新增 worker 專屬 `enableNativeHandAutoSync()`：必須先完成受管 worker 發佈與 broker 全座位最新 revision 的 ACK 收斂，才允許開啟。真正的原版第 5 行動者 `Player.xingDong` 已生成 `GameEvent` 並在 step 0 前 `game.pause()` 時，同一受管 Chromium 呼叫 `autoPublishNativeHandsAtGate` 從原版 Player DOM 讀取當前全部實體手牌，再經原有私有 WS 送至 broker；broker 繼續驗證每座位身份、遞增修訂版及卡牌唯一性。若已啟用時發布失敗，原生閘門拒絕繼續執行。

本次回歸測試涵蓋 2v2 座位循環以及 3v3/4v4 的第五行動者：不允許在第四人 pass 後由 Node 測試手動刷新，第五閘門抵達時 broker 直接取得恰好 +1 的全座位新修訂版，真人只能查詢自身完整手牌，其他人只有公開張數，未認證者拒絕。此為**明確啟用下的單一原生安全閘門同步**，不宣稱已攔截所有裝備、技能、棄牌與結算狀態變動，也不實作中途冷恢復或真出牌。
