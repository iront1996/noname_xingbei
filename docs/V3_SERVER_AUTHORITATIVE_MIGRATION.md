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
