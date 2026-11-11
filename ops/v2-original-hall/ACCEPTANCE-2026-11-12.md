# V2 網路驗收紀錄 — 2026-11-12

## 來源與可信度

本紀錄依**使用者從 Windows PowerShell 貼出的實際輸出**整理；它不是 GitHub Actions 對正式 VPS 做的驗證，也不包含從 VPS 擷取的 systemd 部署日誌。不得將本紀錄當作已獨立證明正式 HALL 程式版本或 V2 Cloudflare Pages 發布成功。

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

## 需再核對，才可稱為整體 V2 正式上線

1. **VPS 實際部署的原版 HALL**：從本專用 checkout 於 VPS 以 `sudo python3 ops/v2-original-hall/audit-live-v2.py --check` 唯讀驗證現有 `/opt/xingbei-hall/server.js` 與固定原版、唯一 loopback 監聽調整完全一致；核對 `xingbei-hall.service`、`127.0.0.1:8080`、公開 TLS :50000 及 V3/cloudflared/monitor 仍 active。
2. **V2 Cloudflare Pages 正式發布**：檢查目前正在對玩家服務的 V2 網頁是否真的載入新 `mode/connect.js`，預設 `wss://v2-hall-direct.myxingbei.com:50000`、不自動回退舊 443。GitHub PR #2 仍處於 Draft、未合併，不能以 GitHub 分支存在推定正式發布完成。
3. **玩法驗收**：針對 2V2（4 真人）、3V3（6 真人）、4V4（8 真人）核對原版房規、建房、加入、原版遊戲實際流程。V2 保留真人房主行為，不是 V4/V5 Dedicated Host。
4. **長期連線**：目前只通過約兩輪 60 秒應用心跳測試；要判斷穩定性，仍需長時間使用情境及斷線事件證據，不能拿兩次心跳外推斷線率。

## 下一步順序

先完成第 1 項唯讀來源稽核與第 2 項正式網站確認；若皆通過，再集中實際玩法驗收。此次網路測試無需重做 Cloudflare DNS、Linode Cloud Firewall 或重新簽發憑證。正式改動只針對 V2；不得影響 V3、統一監控、cloudflared 自己的服務或其它版本程式。

依使用者核准，舊 V1 客戶端透過 `hall.myxingbei.com`／`myxingbei.com` 連向舊 V2 HALL 的相容性不是新版阻擋條件；不可因此修改 V3／monitor Tunnel routes。

