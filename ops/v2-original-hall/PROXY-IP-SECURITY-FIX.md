# V2 原版 HALL 反向代理共用 IP 封鎖：驗證、最小修正與安全准入

**狀態（2026-11-12）：隔離重現／修正測試 PASS，正式 V2 已安裝安全候選且部署驗證 PASS；真人多人遊戲與長期穩定性仍待驗收。** 此最新狀態依使用者從 VPS 與 Windows 終端提供的原始輸出記錄，非由 GitHub CI 遠端登入 VPS 驗證。不得在正式 HALL 發送惡意或非法訊息測試封鎖；這類測試只在 GitHub Actions 的暫時 loopback 網路環境執行。

## 1. 原始缺陷

正式 V2：瀏覽器 → WSS :50000 → Nginx → 127.0.0.1:8080 → 原版 game/server.js。

原版 `game/server.js` 中有三個相關操作：

- `wss.on('connection')` 以 `ws._socket.remoteAddress` 與 `bannedIps` 比對，若命中就發 `denied/banned`，並在 500 毫秒後關閉。
- 原版 `messages.key` 對已封禁 key 分支、及 `messages.events` 對不匹配 onlineKey/錯誤型別分支，會把 `this._socket.remoteAddress` 加進同一個 `bannedIps`。
- 原版 `events` 分支另有 `console.log(id, this._socket.remoteAddress)`。

由於 Nginx 對 HALL 建立的是本機 TCP 連線，不同公開玩家在 HALL 端的 `remoteAddress` 都會是 `127.0.0.1`。當其中某玩家觸發上述 IP 封禁時，新的其他玩家就可能被誤認為同 IP。這個記憶體封鎖狀態維持到 HALL 程序重新啟動，但不代表原有已建立的全部連線立即斷線。

## 2. 隔離環境已完成的證據

### A. 真實 HALL + 本機模擬 Nginx

檔案：`test-proxy-ip-isolation.mjs`。

- 在 GitHub Actions 的暫時 127.0.0.1 後端上執行**完全未修改的原版 HALL**，以本機 WebSocket 代理轉送兩名來源地址分別為 `127.0.0.2`、`127.0.0.3` 的模擬玩家。
- 一個來源先完成 `key`，再傳送不相符的 `events` 身分資訊，被 HALL 封鎖；另一個不同來源的玩家收到 `denied/banned`，成功重現 bug。
- 改用最小修正候選後，第二個來源取得正常 `roomlist` 並成功建房；封鎖來源再次連線仍收到 `denied/banned`。
- 候選版對未附上可信代理來源 IP、非 IP 字串或多值 IP 格式的直接後端連線，以 WebSocket 1008 拒絕，而不記錄錯誤共享的本機 IP。

### B. 真正 Nginx 程序 + 原版 HALL

檔案：`test-proxy-ip-real-nginx.mjs`。GitHub Actions runner 暫時安裝 Nginx，用隨機 loopback 埠與暫存配置執行，完全不接觸正式 Linode。

- 原版 HALL 經由真實 Nginx WebSocket Upgrade 路徑重現 `denied/banned` 的跨來源封鎖。
- Nginx 配置 `proxy_set_header X-V2-Client-IP $remote_addr;`，並清除客戶端傳來的 `X-Forwarded-For`。修正候選能正確依兩個不同來源 IP 分別處理封鎖。
- 模擬用戶故意傳入不屬於自己的 `X-V2-Client-IP`，Nginx 覆寫後送到 HALL，沒有接受用戶自己填入的值。

### C. 受控部署器回復模擬

檔案：`test_deploy_proxy_ip_fix.py`。已測試正常寫入、Nginx reload 失敗回復、HALL 啟動失敗回復，以及新玩家於檢查後接入時拒絕操作；全程僅使用暫時測試檔案及模擬命令，不操作正式服務。

## 3. 候選修正的範圍與安全邊界

- **保留**原版的建房、加入、房主訊息中繼、卡牌、技能、規則、斷線處理與 60 秒字面 `heartbeat`。原版 GitHub `game/server.js` 不修改。
- 僅產生 V2 專用的**部署候選**：在原版基礎上繼續限制 `host:127.0.0.1`，並把 `bannedIps` 的遠端識別從代理的 TCP loopback 來源改為經可信 Nginx 覆寫的真實 TCP 來源 IP。
- 只有 HALL 實際 TCP peer 為 `127.0.0.1`，且 HTTP Upgrade 請求含單一、經 Node `net.isIP` 驗證的 `X-V2-Client-IP` 時才接收；未符合就以 WS close code 1008 拒絕。此機制假設本機程序及 Nginx 配置可信。**不能僅相信客戶端傳入的 X-Forwarded-For**。
- Nginx 的 `$remote_addr` 必須是**原始 TCP 來源 IP**。受控部署器若偵測 Nginx 生效設定內有 `set_real_ip_from`／`real_ip_header` 指令，會停止並要求人工審核，避免其他 RealIP 規則意外信任使用者任意標頭。
- 繼續使用原版**來源 IP 封鎖**策略，所以兩名玩家如果本來就共用一個 NAT 公開 IP，一個被封鎖仍可能連帶影響該 NAT 的其他使用者。這不是此修正要改變的原版設計。
- 舊的 V2 Cloudflare Tunnel 入口若沒有提供相同受信任自訂標頭，套用後可能被 WS 1008 拒絕；這與先前使用者已接受的舊 V2 網域相容性取捨一致。V3 與 monitor 自己的 Tunnel routes 不修改。

**重要產品差異**：套用此安全修正之後，正式 `/opt/xingbei-hall/server.js` 將不再等於「純原版＋唯一 listener 調整」，而是「純原版＋listener 調整＋代理 IP 安全例外」。這是局部連線安全修正，不是遊戲規則改版。不得隱瞞版本 SHA 變化，亦不得當作無須核准的原版程式修改。

## 4. 已完成的候選工程（不會自行部署）

- `proxy-ip-fix-candidate.mjs`：以固定原版 Git blob SHA 建構修正候選，檢查原始 anchor 次數及全部受保護的來源 IP 讀寫點；CLI 只有 `--check`，不寫檔、不重啟服務。
- `nginx-wss-50000.conf.example`：追加 `X-V2-Client-IP $remote_addr` 及明確移除 XFF 轉發；改動 GitHub 範本**不等於修改正式 VPS 的 Nginx site**。
- `deploy-proxy-ip-fix.py`：`--self-test` 離線驗證、`--check` 唯讀檢查、`--apply` 受控修改。只允許已核對的 V2 HALL 與 `/etc/nginx/sites-available/v2-original-hall-50000.conf`；先備份原始檔、檢查沒有任何已建立的 8080 玩家連線、確保其它服務仍分離；若 Nginx 或 HALL 啟動失敗就嘗試復原這兩個 V2 檔案。

## 5. 正式環境安全准入（未執行）

**現階段不建議立即按下 `--apply`：先確認使用者同意在 V2 原版 HALL 加入上述唯一 security-only 例外；並安排 V2 無人遊玩的維護時段。** 不能在有玩家對局時強制停止 HALL。

取得最新、經 CI 通過的 V2 專用工程 checkout 後，先執行**不會寫入 VPS 服務的命令**：

~~~bash
cd /tmp/v2-original-hall-release
python3 ops/v2-original-hall/deploy-proxy-ip-fix.py --self-test
sudo python3 ops/v2-original-hall/deploy-proxy-ip-fix.py --check
~~~

注意 `/tmp/v2-original-hall-release` 必須包含本次新增工具且 Git commit 與已確認 CI 的 commit 相符。不要使用舊下載資料夾執行不存在的腳本；也不要 `git reset --hard`、強行覆寫有本地修改的 checkout。

`--check` 若顯示有已連線玩家、現有 site 結構不一致、服務分離不明確、Nginx RealIP 設定意外啟用、來源 SHA 不符或其它錯誤，應當停下來診斷，不可略過安全檢查。

**只在使用者批准 security-only 例外且確定無遊玩中的 V2 玩家後**，受控部署器的執行命令為：

~~~bash
cd /tmp/v2-original-hall-release
sudo python3 ops/v2-original-hall/deploy-proxy-ip-fix.py \
  --apply --confirm APPLY_V2_PROXY_IP_SECURITY_FIX
~~~

此命令會修改現有 V2 Nginx site、reload Nginx，並原地重啟**唯一 V2 HALL**，所以即使有自動回復能力也會產生短暫中斷。它不允許改動 V3、monitor、cloudflared.service 或 V1/V4/V5/M2。

更新成功後，從外部 Windows 重跑：

~~~powershell
node ops/v2-original-hall/verify-direct-wss.mjs
node ops/v2-original-hall/verify-direct-wss.mjs --heartbeat
~~~

確認 HTTPS 網頁依舊顯示新 WSS :50000，並以真實正常玩家操作測試建房、入房及 2V2/3V3/4V4；**不在正式 HALL 發送非法 `events` 來測封鎖**。

原本的 `audit-live-v2.py --check` 是專門核對純原版＋listener 版本，因此套用候選後其預期 SHA 會不符。改用此工程 `deploy-proxy-ip-fix.py --check` 核對新安全版本；必要時額外比較 `sha256sum /opt/xingbei-hall/server.js` 與部署器輸出的候選 SHA256。

## 5A. 正式環境已完成：來源 IP 安全候選部署與核對

使用者於 2026-11-12 在正式 VPS 的 `/tmp/v2-original-hall-release` 提供以下**實際終端輸出**：

- V2 專用 GitHub 分支 `feature/v2-original-hall-direct-wss50000` 更新至 `0d0040b`；`--self-test` 回報 `SELF-TEST PASS: pinned HALL, minimal security exception, Nginx idempotent header`。
- 首次 `--check` 因 8080 上有一條 ESTABLISHED 連線而 **FAIL CLOSED**，未強行踢除玩家；之後檢查發現 8080／50000 無已建立連線，且 `xingbei-hall.service` 與 `nginx.service` 均 `active`。
- 後續 `--check` 回報 `CHECK PASS: source/service mapping, ws dependency, and 0 active :8080 sessions`、`HALL state: original+loopback`、`V2 nginx header state: requires security header`。確認符合安裝前安全准入。
- 使用者之後回報正式 V2 `/opt/xingbei-hall/server.js` SHA256：`963f3a155ad00f5a7b1cdc00937c6d4240fb34f93a94938f2e4629cbf2ea9bb6`，與隔離候選預期 SHA256 **完全相同**。
- 正式部署後重新執行 `sudo python3 ops/v2-original-hall/deploy-proxy-ip-fix.py --check`，輸出：`CHECK PASS: exact V2 HALL baseline/candidate; exclusive active service, zero sockets`、`HALL state: proxy-ip candidate`、`V2 nginx header state: ready`，候選 SHA256 同上。
- `xingbei-hall.service`、`xingbei-hall-v3.service`、`nginx.service`、`cloudflared.service`、`xingbei-monitor.service` 均回報 `active`。
- 使用者在 Windows 從外部重新執行 `verify-direct-wss.mjs`、`verify-direct-wss.mjs --heartbeat`：DNS only `172.234.84.27`、TLS 1.3、WebSocket 101、`roomlist/key`、兩輪原版文字心跳均 PASS；憑證到期 `2027-02-09 17:20:27 UTC`。

**認定邊界**：正式檔案版本、部署器檢查、五個服務 active 與外部原版 WebSocket 技術冒煙測試皆有輸出證據。因 IP 安全功能的惡意流量測試依既定規範僅在隔離環境執行，**不可宣稱已在正式線上以惡意事件再次重現並修復**。也不可由零 socket 推斷房間正常、長期連線與完整三模式玩法皆已驗收。

## 6. 尚須實際完成的驗收

- 已取得受控部署器 `--check` 的 V2 Nginx 指定來源檔案與預期標頭比對 PASS，以及外部 WSS 101／heartbeat PASS；**若需要進一步的獨立生效設定稽核**，仍可只讀取得 `nginx -T`（避免公開包含憑證路徑以外的敏感設定）。
- 正式安全修正與部署後的外部 WSS／兩輪原版心跳均已驗證通過；尚無 2V2／3V3／4V4 完整真人玩法、一般使用者建房／入房及長時間穩定性驗收。
- 任何對原版玩法、完整對局或長期斷線率的判斷都不能由本次隔離安全測試直接外推。

## 來源

- 原版 HALL：`RancherJie/noname_xingbei@bd227231b6edeba5b32f906673b9f3cb0091b90c/game/server.js`。
- NGINX 官方：`https://nginx.org/en/docs/http/websocket.html`、`https://nginx.org/en/docs/http/ngx_http_proxy_module.html`。
- Node ws 官方：`https://github.com/websockets/ws/blob/master/README.md`，connection callback 取得 HTTP request，透過 reverse proxy 需要可信轉發來源。
