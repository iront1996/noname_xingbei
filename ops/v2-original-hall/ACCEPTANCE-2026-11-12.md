# V2 網路驗收紀錄 — 2026-11-12

## 來源與可信度

本紀錄依**使用者從 Windows PowerShell 與 VPS Linux 終端貼出的實際輸出**整理；它不是 GitHub Actions 直接對正式 VPS 做的驗證，也不是自動擷取的 systemd 部署日誌。VPS 上 HALL 原版一致性的讀取驗證已通過；V2 Cloudflare Pages 的正式公開 connect.js 亦已發布新地址並經外部取得。但這些結果仍不代表所有玩法及長期穩定性已通過驗收。

## 已通過：新網路與連線協定（外部 Windows 實測）

測試腳本：`node ops/v2-original-hall/verify-direct-wss.mjs` 與 `node ops/v2-original-hall/verify-direct-wss.mjs --heartbeat`。

| 指標 | 結果 |
| --- | --- |
| DNS-only A | `v2-hall-direct.myxingbei.com -> 172.234.84.27`，PASS |
| TLS | `TLSv1.3`，PASS |
| 憑證有效期限 | `Feb 9 17:20:27 2027 GMT` |
| WebSocket 握手 | `101 Upgrade`，PASS |
| HALL 初始訊息與身份握手 | `roomlist/key`，PASS |
| 原版文字心跳 | 第 1 輪 PASS、第 2 輪 PASS |
| 總結 | 兩次 `DIRECT WSS CHECK PASS` |

**驗證範圍**：外網至 VPS WSS :50000 的 DNS、TLS、HTTP Upgrade、HALL 初始資料與兩次文字心跳；腳本不建立遊戲房間、不操作牌局。這些結果不涵蓋房規、選角、完整玩局、多人長期穩定或伺服器原始碼是否已原地替換。

## 已通過：正式 VPS 原版 HALL 位元組一致性（使用者於 VPS 實測）

使用者已從 `/tmp/v2-original-hall-release` 執行唯讀 Python 比對：

- 來源：該 checkout 的 `game/server.js`。
- 預期部署檔：將來源內唯一 `var wss = new WebSocketServer({ port: 8080 });` 替換成 `var wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });`，其他內容不變。
- 實際部署檔：`/opt/xingbei-hall/server.js`。
- 比對輸出：`V2 HALL 原版一致性: PASS`。
- 實際部署 SHA256：`f1b41a09d6513749b0ec13093ab90ce253d21a3994b6ea230d65e74b42ef1a49`。
- `systemctl is-active`：`xingbei-hall.service`、`xingbei-hall-v3.service`、`cloudflared.service`、`xingbei-monitor.service` 皆回覆 `active`。

**認定**：正式 V2 HALL 與所用 checkout 的原版 HALL＋僅限 loopback 的單一監聽修改逐位元組相符；先前外網測試也證明此入口可完成 roomlist/key 與兩輪原版心跳。這次操作沒有獨立核對 checkout 本身的 Git commit 或固定原版 Git blob，但 repo CI 對分支已有固定 blob 的自動檢查。V2 網頁發布及遊戲實際玩法仍未驗證。

## 已通過：正式 V2 Cloudflare Pages 新 WSS 入口發布

使用者確認 V2 正式網站：`https://feature-image-preload-cache.xingbei-play.pages.dev/`。

於 2026-11-12 初次查驗：公開 `/mode/connect.js` 仍含 `wss://myxingbei.com:443`，且聯機大廳按鈕使用 `get.config("hall_ip") || lib.hallURL`。與 V2 改版分支不一致。

在完成後端部署、外網 TLS/WSS/心跳與 VPS 原版 HALL 一致性驗證後，**只對 V2 圖片預載分支** `feature/image-preload-cache` 的 `mode/connect.js` 做最小修改，GitHub commit `38b978fb1545128f16dd7902481bce8d8eacf8ac`，公開部署檔案已再次核實：

- `https://feature-image-preload-cache.xingbei-play.pages.dev/mode/connect.js` 回傳 `wss://v2-hall-direct.myxingbei.com:50000`；
- 原 `wss://myxingbei.com:443` 已不在公開模組中；
- 聯機大廳按鈕直接使用 `autoLobbyAddress`，不再取 `hall_ip` 或 `lib.hallURL` 作為按鈕路由；
- `/game/preload-images.mjs` 與 `/xingbei-image-sw.js` 均可從正式網域成功讀取；只修改 `mode/connect.js`，原版遊戲資源與圖片預載程式無變更。
- 只在 GitHub V2 既有已部署分支發布，不合併完整 PR #2，不影響 V1／V3／V4／V5／M2 獨立分支、VPS systemd、Cloudflare Tunnel 或統一監控。

此結果**證明公開 JavaScript 檔案已更新**。仍須以一般瀏覽器實際載入 V2 網頁，觀察聯機大廳顯示新網址、建立房間與加入房間流程，才能確認整個遊戲執行流程正常。瀏覽器若仍顯示舊內容，可先強制重新整理檢查，暫時不要清除整個圖片快取。

## 需再核對，才可稱為整體 V2 正式上線

1. **VPS 來源內容比對已 PASS**，四個指定服務皆 active；若需補上完整機器可重複稽核（當前 systemd ExecStart、Nginx 50000 實際 listener 與固定原版 Git blob），可執行 `sudo python3 ops/v2-original-hall/audit-live-v2.py --check`。此項是補充證據，不應把已完成的位元組比對重新標成未通過。
2. **V2 Cloudflare Pages 公開模組已更新**：已取得部署網域的新版 `mode/connect.js`，其新預設是 `wss://v2-hall-direct.myxingbei.com:50000`，舊 443 不再是自動預設；下一步仍須由瀏覽器實際進入遊戲，驗證 UI 與玩家連線正常。GitHub PR #2 仍可維持 Draft；實際發布的是 V2 既有分支中的最小前端修改。
3. **玩法驗收**：針對 2V2（4 真人）、3V3（6 真人）、4V4（8 真人）核對原版房規、建房、加入、原版遊戲實際流程。V2 保留真人房主行為，不是 V4/V5 Dedicated Host。
4. **長期連線**：目前只通過約兩輪 60 秒應用心跳測試；要判斷穩定性，仍需長時間使用情境及斷線事件證據，不能拿兩次心跳外推斷線率。

## 下一步順序

HALL 原版位元組比對與正式 V2 Pages 公開檔案均已通過；下一步是從瀏覽器實際進入 V2、確認新聯機大廳 UI、以原版真人房主建立房間／加入房間、完成 2V2／3V3／4V4 各模式與連線穩定性驗收。完整 VPS 稽核工具可作為額外證據。此次網路測試無需重做 Cloudflare DNS、Linode Cloud Firewall 或重新簽發憑證。正式改動只針對 V2；不得影響 V3、統一監控、cloudflared 自己的服務或其它版本程式。

依使用者核准，舊 V1 客戶端透過 `hall.myxingbei.com`／`myxingbei.com` 連向舊 V2 HALL 的相容性不是新版阻擋條件；不可因此修改 V3／monitor Tunnel routes。

