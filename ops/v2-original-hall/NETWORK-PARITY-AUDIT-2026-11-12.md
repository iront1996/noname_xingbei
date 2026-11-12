# 原版 vs V2：實際網路架構與連線協定逐項稽核

檢查日：2026-11-12。範圍：公開原版 https://rancherjie.github.io/noname_xingbei/、V2 https://feature-image-preload-cache.xingbei-play.pages.dev/；RancherJie/noname_xingbei@bd227231b6edeba5b32f906673b9f3cb0091b90c 與 iront1996/noname_xingbei 的 feature/image-preload-cache（2026-11-12 版本）。

## 主要結論

- V2 **已達成外部 DNS-only WSS :50000 直連自己 VPS 且沿用原版 HALL 協定**；真實 V2 網路測試 DNS/TLSv1.3/101/roomlist/key/兩輪原版 heartbeat PASS，且 VPS 部署 server.js 與固定原版僅加 127.0.0.1 listener 的預期結果逐位元組相符。
- 兩者的實際公網 IP、遊戲網頁 CDN 與已知 TLS 終止方式**不相同**。原版公開伺服器的內部 TLS 代理與真正運行的 server.js 未經獨立驗證，不能宣稱其實際後端部署與 GitHub 原始碼完全相同。
- GitHub 原始碼一致：noname/game/index.js SHA db0f532084de7266ea16ccb589ca664adc424537、noname/library/index.js SHA 9d0c9d942ff8a1d2c5b1d1c77a8bc813afbd89c0、game/server.js SHA 49a0ad87ffc2638e3651fe6a08b5a150cdf38de3、mode/xingBei.js SHA b85bcfc6a848f94d3fc31fae4ef671ab52151e1f、index.html SHA 83d92c93a3768e9b488e164cc13c21e868cbf2e6。
- 完全獨立原版所有網路服務的主張**不成立**：賽後對局資料仍由原版 mode/xingBei.js 發送到原版 agdatabase.ssyy.tech:50000/v1/matches。
- 有一項由 Nginx 本機反向代理引起的**潛在全體用戶封鎖風險**：原版 HALL 依 ws._socket.remoteAddress 進行 bannedIps 判斷，而代理至 127.0.0.1:8080 會讓不同外部用戶的 TCP remoteAddress 看起來相同。沒有證據顯示事故已發生，但不能因兩輪心跳 PASS 排除此問題。

## A. 公開 DNS / 網路路徑（2026-11-12 實測）

| 分項 | 原版 | V2 |
|---|---|---|
| 靜態網站 | rancherjie.github.io/noname_xingbei/ → GitHub Pages，A 185.199.108.153 / .109.153 / .110.153 / .111.153 | feature-image-preload-cache.xingbei-play.pages.dev → Cloudflare Pages，A 172.66.47.163 / 172.66.44.93 |
| HALL 用戶預設位址 | 由 lib.config.last_ip 或 lib.hallURL（agserver.ssyy.tech:50000）決定 | mode/connect.js 固定 wss://v2-hall-direct.myxingbei.com:50000 |
| HALL 公網 IPv4 | agserver.ssyy.tech A = 60.179.53.142（無 AAAA 應答） | v2-hall-direct.myxingbei.com A = 172.234.84.27，Cloudflare DNS only（無 AAAA 應答） |
| TLS / 反代 | 客戶端預設 wss_mode init=true；原版實際外網 :50000 的 TLS 終止/內部代理**未知** | 實測 TLS 1.3、WebSocket 101；部署工程採 Nginx :50000 → 127.0.0.1:8080 |
| 內部 HALL | GitHub 原始 game/server.js 預設 ws://*:8080；正式 agserver 內部部署未知 | 真實 VPS 上固定原版 game/server.js 僅修改 host=127.0.0.1；部署 SHA256 f1b41a09d6513749b0ec13093ab90ce253d21a3994b6ea230d65e74b42ef1a49 |
| 外部原版 DB | agdatabase.ssyy.tech → 60.179.53.142，HTTPS :50000 | 原版 mode/xingBei.js 保留同一外部資料庫依賴 |

注意：公開 DNS 解析只是目前路由證據，不能據此推論原版服務器軟硬體、實際延遲、吞吐量或 WS 長期穩定性。

## B. 客戶端連線程式的差異

- 原版 mode/connect.js 預填 `lib.config.last_ip || lib.hallURL`；「聯機大廳」按鈕使用 `get.config('hall_ip') || lib.hallURL`。原版 lib.hallURL 為 agserver.ssyy.tech:50000，wss_mode 預設 init=true，但使用者可修改設定及儲存連線位址。
- V2 mode/connect.js 預填明確 WSS 50000 完整 URL；「聯機大廳」按鈕也固定使用此地址，不會自動回退 :443。可編輯地址與「最近連線」仍可由使用者自主選擇其他地址；noname/library/index.js 中未用於此按鈕的原版 lib.hallURL 尚存在，不能把 V2 描述為完全刪掉所有上游網域參考。
- 原版與 V2 使用逐位元組相同的 noname/game/index.js（game.connect、WebSocket 事件綁定、game.send/sendTo），以及相同的 noname/library/index.js WebSocket onmessage handler。收到字面 heartbeat 時，瀏覽器以相同字面 heartbeat 回覆。
- V2 在啟用連線前要求圖片預載驗證完成；image/theme 使用 Service Worker 快取。這是前端資源路徑／連線時機差異，而非 HALL 規則修改。
- V2 檔案中仍保留 `lib.hallURL = "agserver.ssyy.tech:50000"`，但 V2 正式 mode/connect.js 的預設入口與「聯機大廳」按鈕均不使用這個設定。使用者仍可手動輸入／透過最近連線連向別處；**沒有自動 fallback** 不能被寫成 **網路上不存在任何舊入口**。
- **原版 mode/connect.js 的 read_clipboard 邀請連結解析分支在 V2 中已移除**。因此儘管一般建房、手動入房的底層引擎相同，不能宣稱原版所有邀請加入流程 100% 保留。

## C. HALL 協定與房主職責

- GitHub 原版 game/server.js 與 V2 repo 的相同：連線後送 roomlist，2 秒內要求 key；create/enter/config/send 與房間/玩家列表更新均沿用原版。
- 客戶端 → HALL → 真人房主；房主經 HALL 回傳給其他用戶。HALL 不是獨立遊戲規則引擎，也不會因 V2 改版讓真人房主斷線後自動復原房間。
- 原版每 60 秒傳文字 heartbeat，第二次檢查時若前次未被回覆則關閉 socket；V2 外部測試已完成兩輪，這不等於多日實測斷線率。
- V2 Nginx 範本 proxy_read_timeout/proxy_send_timeout 180s；仍需正式 VPS 的 nginx -T 確認生效配置、proxy_pass 及續期任務，不能只用部署範本代替線上證據。

## D. 重要差異、風險與結論

1. **潛在高風險：全體玩家被視為同一 IP**。原版 game/server.js 以 ws._socket.remoteAddress 記錄及比對 bannedIps；在 Nginx 代理到 127.0.0.1:8080 後，用戶 TCP remoteAddress 一致。如被封鎖，後續新連線可能全部被拒絕。只加 X-Forwarded-For 標頭不會讓原版 HALL 自動改用真實 IP。應在不改動原版玩法的前提下另行做安全與可靠性風險評估；不能未經核准修改正式 server.js。
2. **外部統計 API 仍用原版**。noname/game/index.js 的 `game.over` 會呼叫 `game.submitMatchResult`（若存在）；mode/xingBei.js 定義的函數在 `_status.connectMode` 為 true 時建立 mode、players、record，並嘗試 POST 到原版 agdatabase.ssyy.tech:50000/v1/matches，附有前端原始碼中公開的固定授權值（本報告不重複）。這條 HTTPS 流量不經新的 V2 HALL。其 CORS、API 是否存活、資料是否成功寫入均未經實測；不能宣稱每局都成功回報。
3. **邀請/圖片資源行為不完全同原版**：V2 刪除了原版 read_clipboard 設定所控制的剪貼簿邀請網址自動解析及連入分支，並額外在圖片準備完成前暫緩連線。這是連線入口 UI 的功能差異；是否要恢復邀請自動加入需要獨立決策。
4. **可觀測與效能無法判定同等**：原版真正運作的 agserver 未驗證 WSS／長期 heartbeat、V2 只有兩輪 heartbeat PASS、沒有雙站相同線路的延遲/斷線分布、沒有 2V2/3V3/4V4 完整對局紀錄；故不能計算穩定性提升比率。
5. **其它網路風險**：V2 DNS only 直接暴露 Linode 公網 IP，放棄舊 :443 Tunnel 的代理保護；外部 50000 在企業/校園網路可能被封鎖。兩者都使用 HTTPS 前端、WSS 遊戲資料，但 GitHub Pages/Cloudflare Pages CDN 路徑不同。
6. **舊 Cloudflare Tunnel 物理路由**：先前已實證 `hall.myxingbei.com` 和 `myxingbei.com` 都指向本機 8080。V2 正式連線 UI 不再使用這些路由；若未於 Dashboard 移除，舊路由仍可能通往新版 HALL。此次唯讀稽核未重新核對兩條 Tunnel 路由是否已刪除，不能宣稱它們已不存在。
7. **原版 WSS 服務當前健康與延遲尚未測量**：已驗原版程式預設 WSS（`wss_mode` init=true）、DNS A、端口設定，**沒有**完成原版 agserver.ssyy.tech:50000 的實際 TLS/101/heartbeat。不能將網路架構相似推論為雙方同等穩定。

**稽核結論：主要目標「原版 HALL 行為、直接 WSS :50000、同 VPS、無舊 A1 心跳補丁」已達成；「所有連線相關功能與原版逐項無差、無外部依賴、長期穩定性達原版」尚未證實或不完全符合。** 本稽核為唯讀分析，不執行正式 VPS、Cloudflare、Nginx 或任何版本的修改。

### 可重現來源

- 原版程式：https://github.com/RancherJie/noname_xingbei/tree/bd227231b6edeba5b32f906673b9f3cb0091b90c
- V2 靜態網站：https://feature-image-preload-cache.xingbei-play.pages.dev/；原版：https://rancherjie.github.io/noname_xingbei/
- V2 技術驗收：ops/v2-original-hall/ACCEPTANCE-2026-11-12.md
- 網路 DNS 資料：Google Public DNS 的 A、AAAA 查詢（2026-11-12），可能隨時間變更。
