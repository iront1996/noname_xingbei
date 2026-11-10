# V2 原版 HALL｜現有 VPS 原地替換／DNS only／WSS :50000

狀態：GitHub 草稿分支已建立；尚未部署 VPS、DNS 或 Cloudflare Pages。

## 已授權方案與保護範圍

使用者已授權直接覆蓋現有 V2 聯機服務，並表示改版前可以容忍既有 V2 HALL 停機。因此本工程**不新增第二個常駐 HALL systemd 服務，不強制沿用 A1 Ping/Pong 或舊監控**。

新預設入口：wss://v2-hall-direct.myxingbei.com:50000；V2 網頁與圖片預載留在 Cloudflare Pages。新入口使用 DNS only A 記錄直指**現有 VPS**，WSS 必須有 TLS 終止服務並轉送至現有 HALL 的 8080 埠，但**尚未確認這台 VPS 是否安裝 Nginx／其他代理**；不得假定既有 Nginx 可以使用。仍採真人房主主持，不改原版遊戲規則與訊息協定。

原版基準：RancherJie/noname_xingbei@bd227231b6edeba5b32f906673b9f3cb0091b90c，game/server.js Git Blob SHA 為 49a0ad87ffc2638e3651fe6a08b5a150cdf38de3。**部署工具保留該檔為輸入基準，但為維持 VPS 現有的本機-only 安全邊界，部署時僅加上 WebSocket listener 的 host: "127.0.0.1" 參數；這個必要的監聽範圍調整會讓實際部署檔的 SHA 與原版不同，不影響心跳、房間或遊戲訊息協定。**

**2026-11-11 現有 VPS 唯讀證據（更新）：** systemd MainPID 1900742 = `/usr/bin/node /opt/xingbei-hall/server.js` = `127.0.0.1:8080`；MainPID 193545 = `/usr/bin/node /opt/xingbei-hall-v3/server.js` = `127.0.0.1:8081`。`cloudflared.service`、`xingbei-monitor.service`、`xingbei-v2-observer.service` 均在運行。`command -v` 只找到 `/usr/local/bin/cloudflared`，未找到 Nginx、Caddy、HAProxy、Traefik；VPS 無本機 TCP :80、:443、:50000 監聽。**現有前端外部 WSS 可能透過 Cloudflare Tunnel；Cloudflare Tunnel 的 ingress 路由（是否指向 8080，是否同時供 V1／V3 使用）尚未確認。**不能把 `cloudflared.service` 當作可供 DNS-only :50000 使用的 TLS 直連入口，更不可直接停止它。即使無玩家連線，也不能排除 V1 或其他系統共用 HALL；如存在共用，禁止覆蓋，先解決隔離問題。不可修改 `xingbei-hall-v3.service` 或任何其他版本的服務。

## 目前最先進行的唯讀網路／路由核對

在任何新埠、憑證、DNS 或 HALL 覆蓋之前，先檢查：
- 現有 VPS **是否有真正可入站的公開 IPv4**（不是只有 Cloudflare Tunnel 的對外通路）；從 VPS 查詢的出口公網 IP 不代表 IPv4 一定直掛在 VPS 上，也不保證 TCP 50000 可以入站。
- cloudflared 的 ingress 配置是本機管理或 Cloudflare Dashboard 遠端管理；核對當前 hostname → 本機服務（尤其 :8080/:8081）並標記是否涉及 V1/V3。
- `xingbei-monitor.service`、`xingbei-v2-observer.service` 與 V1 的依賴，避免重建 V2 時破壞其他版本。
- VPS 本機與供應商防火牆，不得因新 TLS 入口直接暴露明文 8080。

唯讀檢查範例：

~~~bash
ip -4 -o addr show scope global
ip -4 route show default
curl -4fsS --max-time 10 https://api.ipify.org; echo
sudo ufw status verbose
sudo systemctl show cloudflared.service -p FragmentPath -p MainPID -p ActiveState
sudo systemctl show xingbei-monitor.service xingbei-v2-observer.service -p Id -p MainPID -p ActiveState -p WorkingDirectory
for f in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml /root/.cloudflared/config.yml /root/.cloudflared/config.yaml; do
  if test -f "$f"; then echo "Local Cloudflare Tunnel config present: $f"; fi
done
~~~

**不回傳 cloudflared token、隧道認證 JSON、憑證私鑰或完整含憑證的 systemd ExecStart。** 若 Tunnel 為遠端管理，需要在 Cloudflare Dashboard 查詢公開 hostname 與 service URL，不能由本機不存在的 config 猜測對應路由。

## 步驟 1：現有 VPS 唯讀檢查（最先執行）

在**現有 VPS** 上執行，暫時不停止或重啟任何服務：

~~~bash
sudo systemctl status xingbei-hall.service --no-pager
sudo systemctl cat xingbei-hall.service
sudo systemctl status xingbei-hall-v3.service --no-pager
sudo systemctl cat xingbei-hall-v3.service
sudo ss -ltnp
sudo ss -tn state established
systemctl show xingbei-hall.service xingbei-hall-v3.service -p Id -p MainPID -p ActiveState --no-pager
ps -o pid,ppid,comm,args -p 1900742,193545
for bin in nginx caddy haproxy traefik cloudflared certbot; do command -v "$bin" || true; done
sudo systemctl list-units --type=service --all --no-pager | grep -Ei 'nginx|caddy|haproxy|traefik|cloudflared|tunnel|xingbei' || true
sudo ss -ltnp | grep -E ':(80|443|8080|8081|50000)([[:space:]]|$)' || true
if command -v nginx >/dev/null; then sudo nginx -t 2>&1; fi
sudo ufw status verbose
sudo ls -l /opt/xingbei-hall/server.js
~~~

回傳輸出時刪去 token、密碼、憑證內容及不必要的私有資料。重點查明 V2 HALL 是否被 V1/其他入口共用、50000 是否佔用、TLS 入口目前由誰處理，以及對外埠與防火牆的實際情況。

在 GitHub 本工程分支的工作目錄：

~~~bash
python3 ops/v2-original-hall/deploy-existing-vps.py --self-test
sudo python3 ops/v2-original-hall/deploy-existing-vps.py --check
~~~

--check 完全唯讀；核對既有服務、來源檔、Node ws 套件，以及 :8080 現有 TCP 連線。若路徑與預期不符，會拒絕而不是覆蓋未知檔案。它無法證明 V1/其他網頁沒有間接引用這台 HALL；此項仍須對照 VPS 路由和其他版本配置。

## 步驟 2：設定 DNS only + WSS，不開新 HALL service

Cloudflare DNS 新增子網域 v2-hall-direct 的 A 記錄，指向**此現有 VPS 的真實公開 IPv4**，Proxy status 選 DNS only（灰雲）。不能改動主網域 myxingbei.com 或目前已存在的 hall.myxingbei.com；不要動 Cloudflare Pages。檢查 AAAA 記錄，避免意外 IPv6 路由。

TLS 憑證須涵蓋 v2-hall-direct.myxingbei.com，且具備可維護的自動續期方式。可使用已涵蓋此子網域的現有憑證，或以 ACME DNS-01 簽發，避免為新增域名覆蓋既有 80/443 虛擬主機。不得把 Cloudflare API token 放入 GitHub。

**已確認 VPS 上沒有已知本機 TLS 服務**（目前僅發現 cloudflared，不是 DNS-only 直連入口）。必須先查 VPS 是否擁有可由公網路由到達的 IPv4、主機與供應商入站 ACL，再於**同一台 VPS**新增必要的 TLS 終止層（優先評估 Nginx；這是加密入口，不是第二個遊戲 HALL），使新 WSS :50000 代理到唯一現有 HALL 的 `127.0.0.1:8080`。範本見 `nginx-wss-50000.conf.example`。**不可停止 cloudflared.service**，因為它可能仍為 V1／V3／其他入口提供路由；也不能把 Cloudflare Tunnel 原有 hostname 直接改成 DNS only 而沒有建立新 TLS 入口。不得使用未加密 :8080 對外。初始 `proxy_read_timeout` 與 `proxy_send_timeout` 均為 180 秒，以避開原版 60 秒心跳週期與 60 秒代理讀取逾時的競態。

對外只新增 TCP 50000；確保公開網路**無法**直接存取原版明文 8080。原版 server.js 監聽所有介面，這項保護必須靠現有 VPS 防火牆及供應商安全群組實施。保留現有 SSH、其他服務與舊站台所需的埠。

## 步驟 3：原地覆蓋 V2 HALL（只停止同一個服務）

取得本工程分支後，先執行 self-test、--check 和 node --check game/server.js。**只有已確認沒有其他版本共用此 HALL、DNS 已就緒、TLS/防火牆/Nginx 通過檢查且無 8080 使用中的連線，才可執行 --apply。**

~~~bash
# 203.0.113.10 是文件保留 IP，必須換成「本 VPS 實際公開 IPv4」，不能照抄
sudo python3 ops/v2-original-hall/deploy-existing-vps.py \
  --apply \
  --original-file game/server.js \
  --expect-ip 203.0.113.10 \
  --confirm REPLACE_V2_HALL
~~~

此程式：核對系統服務／工作目錄、DNS A 記錄與原版輸入 Git Blob；將唯一 WebSocket 監聽位置限制為 127.0.0.1；檢查 Node 語法與現有連線；將既有 /opt/xingbei-hall/server.js 備份至 /root/v2-original-hall-backups/；只停止 xingbei-hall.service；以 atomic replace 換成原版 game/server.js；只啟動相同的 xingbei-hall.service 並確認**僅在 127.0.0.1:8080** 監聽。若啟動失敗會嘗試自動回復舊檔案及服務。**不**新增 service、不修改 systemd unit、不修改 Nginx、DNS 或前端。

若檢查未通過，應修正實際部署認知或調查共享依賴，而不是跳過保護條件。

## 步驟 4：測試 WSS，再正式切換前端

先從**外部客戶端**核對 TLS/SAN、WebSocket 101、原版 roomlist/key 握手（原版 2 秒初始 key 驗證）、建立房間、加入房間、原版真人房主轉發及 2V2/3V3/4V4 玩法相容性。原版房主斷線會關房；本工程不處理這項原版特性。

只在新入口驗收通過且沒有進行中對局後，才把本 PR 的 mode/connect.js 發佈到 V2 Cloudflare Pages，讓 V2 預設唯一官方入口變為 wss://v2-hall-direct.myxingbei.com:50000。舊 :443 不做自動回退。**不得隨意關閉 myxingbei.com 的整個 443 HTTPS 網站服務**；若要移除舊 V2 WebSocket 路由，先確認它不被其他版本或業務使用。

保留切換前 443 歷史日誌、原始碼備份與新 50000 被動 Nginx/systemd 觀測作對照。原版 HALL 本身不輸出每次 heartbeat ACK 的詳細時間，故不應謊稱在完全保留原版的情況下已實現逐次心跳監控。正式上線後若仍不穩，再依證據評估是否增加最小診斷能力。

## 安全與限制

- --check 唯讀；--apply 會修改**既有 V2 HALL 服務程式**並短暫停止／啟動它，只有通過安全檢查時才能實際使用。
- 自動 rollback 範圍僅限被此腳本取代的 server.js；Nginx、DNS、Cloudflare Pages 的變更須另行保留並執行回復流程。
- 不新增第二套服務、不再沿用 A1/監控修正、不動 V1、V3、V4、V5、M2、原版與其他正式服務。
- 現有 VPS 尚未取得可供本聊天室實際管理的 SSH 權限，因此**目前這份 GitHub 工程不是已部署完成**。
