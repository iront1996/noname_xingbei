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
