# V2 原版 HALL／DNS-only／WSS 50000 遷移工程

狀態：**已建立隔離 V2 工程分支；尚未部署、尚未切換正式 V2**。

## 核定目標與邊界

- V2 正式入口最終只用 `wss://v2-hall-direct.myxingbei.com:50000`。沒有自動回退至舊 `wss://myxingbei.com:443`。
- V2 網頁、圖片預載、原版遊戲規則、真人房主主持機制與原版 WebSocket 訊息協定不變。
- 使用新的獨立 VPS（優先）或確認不干擾其他版本的獨立資源；DNS A 記錄設 **DNS only**，而不是 Cloudflare Proxied。
- HALL 使用原作者固定基準 `RancherJie/noname_xingbei@bd227231b6edeba5b32f906673b9f3cb0091b90c` 的 `game/server.js`，Git blob SHA 必須為 `49a0ad87ffc2638e3651fe6a08b5a150cdf38de3`。
- 不帶入現有 V2 VPS 上的 A1 Ping/Pong、健康偵測、恢復實驗或監控補丁；不要因為驗證需求改寫原版心跳。
- WSS 的 TLS 終止與必要的防火牆、程序管理不屬於原版遊戲規則修改。
- 未經另行部署核對，不得動到 V1、V3、V4、V5、M2、原版倉庫，或其他正式 VPS 服務／埠／配置。

## 開工前已查核

- V2 基準：`feature/image-preload-cache@d872c6fca19b1333f85aadbfb76c735cf25c7fd8`。
- 原版 `game/server.js` 與這份 V2 前端分支的同路徑檔案，其 Git blob SHA 相同。
- 原版 HALL 的 `ws` 對外開啟 TCP 8080（明文），60 秒發送文字 `heartbeat`，若下一輪未獲回覆會關閉連線；它不自行處理 TLS。
- 本次公開 DNS 查詢（2026-11-10）時，`v2-hall-direct.myxingbei.com` 不存在 A 記錄；**尚未指向任何 VPS**。`hall.myxingbei.com` 已解析到 Cloudflare IP，因此刻意不用它，以防破壞既有服務。
- 任何基於 GitHub 的程式碼比對都不等同於已取得現有 V2 正式 VPS 的完整配置。

## 隔離 VPS 佈署操作手冊（不在現有正式主機直接執行）

### 1. 作業系統與依賴

在**全新** VPS 上使用 Ubuntu LTS、維護中的 Node.js LTS、Nginx、Certbot、Git。僅以最小新 service account 運作。先查驗目前監聽埠和防火牆，確保 50000/8080 不衝突；非新 VPS 須停止並另做影響評估。

以固定 commit 下載原版單檔，而不是覆蓋任何現有 service：

```bash
sudo mkdir -p /opt/v2-original-hall
cd /opt/v2-original-hall
sudo curl -fL \
  https://raw.githubusercontent.com/RancherJie/noname_xingbei/bd227231b6edeba5b32f906673b9f3cb0091b90c/game/server.js \
  -o server.js
git hash-object server.js
# 必須得到：49a0ad87ffc2638e3651fe6a08b5a150cdf38de3
node --check server.js
```

只在 hash 正確時再建立獨立 Node 專案：

```bash
cd /opt/v2-original-hall
sudo npm init -y
sudo npm install --save-exact ws@8
# 保存 package.json 和 package-lock.json，後續以 npm ci 重現
```

不要複製或部署舊 V2 HALL A1／監控檔案。必要時可在隔離測試工作樹核對原版 source，**不能修改原版基準以滿足新架構**。

### 2. DNS、TLS 與開埠

由你擁有的 Cloudflare DNS 區建立獨立 A 記錄 `v2-hall-direct`，值為新 VPS 公開 IPv4，Proxy status 設 **DNS only（灰雲）**。查核 `dig +short v2-hall-direct.myxingbei.com A` 為 VPS IP，而不是 Cloudflare IP。檢查 AAAA 記錄，避免 IPv6 落到其他環境。

WSS 對外 TCP 50000 必須支援有效的公開信任 TLS 憑證。範例使用 Certbot 的 HTTP-01 webroot（需要 TCP 80 暫時或持續能夠到達獨立主機），可參考 `nginx-acme-http.conf.example`；取得憑證後再載入 `nginx-wss-50000.conf.example`。

開放新 VPS 的必要入口：TCP 50000 供 WSS、TCP 80 供 ACME HTTP-01（及維護允許的 SSH）；**不要對公網開放原版明文 TCP 8080**。需同時檢查 VPS 本機與雲服務商安全群組／防火牆，並從外部驗證 8080 不可連。

原版 `server.js` 會在所有介面監聽 8080；此版要維持原始 SHA，所以**不得省略外部封鎖 8080 的安全檢查**。若無法隔離，拒絕上線，而不是偷偷改動原版程式。

Nginx 僅處理 WSS／TLS 入口轉發本機 `127.0.0.1:8080`；`proxy_read_timeout` 與 `proxy_send_timeout` 設 180 秒，避免與原版 60 秒文字心跳的計時碰撞。這是初始防護設定，非保證穩定值。

### 3. 單獨 service 與基本安全

參考 `v2-original-hall.service.example`，使用專用 `v2hall` 帳號、`/opt/v2-original-hall` 工作目錄及獨立 service 名稱 `v2-original-hall.service`。設定檔仍是範例，須確認 Node 路徑、使用者與權限；服務啟動前先測試。

Nginx access/error logs 及 systemd journal 作為**被動記錄**。不主動插入新 Ping/Pong，不為統計而修改原版心跳行為。這些日誌能提供連線起訖和代理錯誤，但**無法憑空提供原版內部每次 heartbeat send/ACK 的精準時間**；若日後需要這項資料，必須另設有界、可審計的觀測方案。

### 4. 封閉驗證與切換門檻

```bash
# 在 V2 原始碼根目錄（本分支）
node --test ops/v2-original-hall/test-contract.mjs

# 在新 VPS 上
sudo nginx -t
sudo systemctl status v2-original-hall.service --no-pager
dig +short v2-hall-direct.myxingbei.com A
openssl s_client -connect v2-hall-direct.myxingbei.com:50000 -servername v2-hall-direct.myxingbei.com </dev/null
```

上述命令只驗證部分靜態條件。仍須使用獨立瀏覽器與測試房，在新入口完成實際 WebSocket 101、原版 `roomlist`／`key` 握手、建立房間、加入房間、4／6／8 人可用性（依原版既有模式）、訊息轉發與持續連線觀測。原版真人房主斷線會關房，此行為不屬於這次修復範圍。

只有當新 DNS、TLS、主機防火牆、HALL、非真人驗證及集中真人驗證均完成，且正式切換窗口內沒有進行中的房間，才把本分支的 `mode/connect.js` 發佈到 V2 的 Cloudflare Pages 正式站。不能先發佈一個不存在的 DNS 或尚未啟用的 WSS URL。

切換時留下舊 443 的離線配置備份與前後 baseline 日誌；切換後舊 443 **不作為官方入口、不自動回退**。既有房間不保證可搬遷。需要 rollback 時另取得明確授權，不在客戶端偷偷切換。

### 5. 驗收與證據

- 新網域 DNS A（及 AAAA）結果、代理狀態、TLS 憑證鏈。
- 新 VPS 的程式 Git blob SHA、Node/`ws` 精確版本、systemd service、Nginx 生效配置。
- 至少記錄每一輪測試的開始／結束時刻、瀏覽器 Network WS Request URL、握手結果、WebSocket Close code、Nginx access/error、Node journal。
- 對舊 443 的歷史連線失敗數／時間與新 50000 相同量測方式做對照，避免把不同偵測器的數字誤當作直接可比。
- 驗收失敗時，**不改動正式 V2**，先分析 DNS／TLS／代理／原版 HALL。

## 已知非目標

- 不是 V3／V4／V5 的 Dedicated Chromium Host；仍由真人房主持有遊戲狀態。
- 不是保證 WebSocket 絕不斷線，也不是承諾重連恢復整場遊戲。
- 不引入 A1 Ping/Pong、V2 guest reclaim／Runner、大量卡牌自動玩局或既有監控整合。
