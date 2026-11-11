# V2 網路驗收紀錄 — 2026-11-12

## 來源與可信度

本紀錄依**使用者從 Windows PowerShell 與 VPS Linux 終端貼出的實際輸出**整理；它不是 GitHub Actions 直接對正式 VPS 做的驗證，也不是自動擷取的 systemd 部署日誌。VPS 上 HALL 原版一致性的讀取驗證已通過，但仍不代表 V2 Cloudflare Pages 已發布或所有玩法已通過驗收。

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

## 需再核對，才可稱為整體 V2 正式上線

1. **VPS 來源內容比對已 PASS**，四個指定服務皆 active；若需補上完整機器可重複稽核（當前 systemd ExecStart、Nginx 50000 實際 listener 與固定原版 Git blob），可執行 `sudo python3 ops/v2-original-hall/audit-live-v2.py --check`。此項是補充證據，不應把已完成的位元組比對重新標成未通過。
2. **V2 Cloudflare Pages 正式發布**：檢查目前正在對玩家服務的 V2 網頁是否真的載入新 `mode/connect.js`，預設 `wss://v2-hall-direct.myxingbei.com:50000`、不自動回退舊 443。GitHub PR #2 仍處於 Draft、未合併，不能以 GitHub 分支存在推定正式發布完成。
3. **玩法驗收**：針對 2V2（4 真人）、3V3（6 真人）、4V4（8 真人）核對原版房規、建房、加入、原版遊戲實際流程。V2 保留真人房主行為，不是 V4/V5 Dedicated Host。
4. **長期連線**：目前只通過約兩輪 60 秒應用心跳測試；要判斷穩定性，仍需長時間使用情境及斷線事件證據，不能拿兩次心跳外推斷線率。

## 下一步順序

HALL 原版位元組比對已通過；下一個關鍵步驟是第 2 項正式 V2 網站發布來源確認及必要的網頁切換，再集中實際玩法驗收。完整 VPS 稽核工具可作為額外證據。此次網路測試無需重做 Cloudflare DNS、Linode Cloud Firewall 或重新簽發憑證。正式改動只針對 V2；不得影響 V3、統一監控、cloudflared 自己的服務或其它版本程式。

依使用者核准，舊 V1 客戶端透過 `hall.myxingbei.com`／`myxingbei.com` 連向舊 V2 HALL 的相容性不是新版阻擋條件；不可因此修改 V3／monitor Tunnel routes。

