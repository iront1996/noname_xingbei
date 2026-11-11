# V2 同台 VPS 原地改版：可執行上線手冊

狀態：GitHub 程式及離線測試準備中；VPS、DNS、Cloudflare Pages 正式入口尚未部署。

## 核定範圍

- 在現有 Akamai/Linode VPS 172.234.84.27 原地取代既有 xingbei-hall.service，**不新增第二個遊戲 HALL**。
- 新 V2 唯一預設為 wss://v2-hall-direct.myxingbei.com:50000，DNS A 使用 Cloudflare DNS only，不走 Cloudflare HTTP proxy / Tunnel。
- 以原版 game/server.js 為遊戲協定及心跳基準；為避免明文 8080 暴露外網，部署器僅修改一處 WebSocket listener，使其監聽 127.0.0.1。
- 舊 V1 客戶端若仍透過 hall.myxingbei.com 或 myxingbei.com 使用 8080，連線中斷或行為改變屬已接受影響；但 V3、監控、cloudflared、V4/V5/M2 等獨立服務不得直接修改。

## 實際核對的環境

- VPS eth0 持有 172.234.84.27，與出口 IPv4 相同。
- V2 = /opt/xingbei-hall/server.js（127.0.0.1:8080）；V3 = /opt/xingbei-hall-v3/server.js（127.0.0.1:8081）。
- Cloudflare Tunnel 兩條舊 V2 route 均指向 8080；v3.myxingbei.com → 8081；monitor.myxingbei.com → 18763。維持 cloudflared.service 運行。
- 已在使用者已開啟的 Akamai Cloud Manager 網頁確認 VPS 綁定 Cloud Firewall「xing」，規則頁：
  https://cloud.linode.com/firewalls/198170117/rules
- UFW inactive、nftables 無列印規則、iptables INPUT ACCEPT；但**供應商 Cloud Firewall 內的入站規則尚未確認**。新 WSS 50000 是否可從公網到達仍未知。
- 先前 VPS 無 Nginx/Caddy/HAProxy/Traefik；需在同台 VPS 補上必要的 TLS 入口，這不算第二個遊戲 HALL。

## 1. 在控制台完成防火牆與 DNS

在 Linode Cloud Firewall「xing」的 Rules 檢查 inbound policy、已存在的 SSH 規則和其它規則。如果 inbound policy 為 DROP，才新增一條 TCP 50000、來源 IPv4 0.0.0.0/0、Action ACCEPT 的規則。**勿刪除或改動 SSH/V3/monitor 的既有規則。**不要因本機 UFW inactive 就假設供應商沒有封鎖。

Cloudflare → myxingbei.com → DNS → Records，只新增一筆：
- A record，Name = v2-hall-direct
- Content = 172.234.84.27
- Proxy status = DNS only（灰雲）
- TTL = Auto
- 不新增 AAAA；不改現有 hall、apex、V3、monitor、Pages 記錄。

確保新域名 A 僅解析到 172.234.84.27，而非 Cloudflare Anycast IP。

## 2. 安裝同 VPS TLS 入口與公開信任的憑證

此組命令只適用使用 apt-get 的 Debian/Ubuntu VPS。無法判定發行版時先看 /etc/os-release：

~~~bash
cat /etc/os-release
command -v apt-get
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-dns-cloudflare
~~~

注意安裝 Nginx 套件可能自動開啟範例 80 埠站台；這台 VPS 在安裝前沒有 Nginx，應僅移除套件新建立的預設站台 symlink，避免留下無關的對外 HTTP 入口：

~~~bash
if [ -L /etc/nginx/sites-enabled/default ] &&
   [ "$(readlink -f /etc/nginx/sites-enabled/default)" = "/etc/nginx/sites-available/default" ]; then
  sudo rm -- /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
fi
sudo ss -ltnp | grep -E ':(80|443|50000)([[:space:]]|$)' || true
~~~

到 Cloudflare API Tokens 建立僅限 myxingbei.com 區域 Zone:DNS:Edit 的專用權杖。不要使用 Global API Key，也**不要在聊天室、GitHub、shell history 或截圖中暴露它**。

~~~bash
sudo install -d -m 700 /root/.secrets/certbot
sudo nano /root/.secrets/certbot/cloudflare.ini
# 在 nano 內輸入一行：dns_cloudflare_api_token = <你自己的 Token>
sudo chmod 600 /root/.secrets/certbot/cloudflare.ini
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/certbot/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 60 \
  -d v2-hall-direct.myxingbei.com
~~~

Certbot 會依實際配置要求 Email 與憑證條款授權。簽發成功後，檢查有效期間和 SAN，並設定 Certbot 續期後的 Nginx reload：

~~~bash
sudo openssl x509 -in /etc/letsencrypt/live/v2-hall-direct.myxingbei.com/fullchain.pem \
  -noout -checkhost v2-hall-direct.myxingbei.com -dates
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/90-v2-wss-nginx-reload.sh >/dev/null <<'EOF'
#!/bin/sh
case " $RENEWED_DOMAINS " in
  *" v2-hall-direct.myxingbei.com "*)
    /usr/sbin/nginx -t && /bin/systemctl reload nginx
    ;;
esac
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/90-v2-wss-nginx-reload.sh
sudo certbot renew --dry-run
~~~

憑證 DNS-01 不需要開啟 80/443 入站埠；DNS Token 只存於 VPS 的 root-only 檔案。安裝後要確保 Certbot 的自動續期 timer 確實運作。

## 3. 取得本 V2 GitHub 工程，僅啟用新的 TLS 入口

取得 feature/v2-original-hall-direct-wss50000 分支，確保 checkout 的 commit 與最新 CI 結果一致，且磁碟有空間。以下僅建立一個暫存工作目錄，不動現有其他版本程式：

~~~bash
df -h /
git clone --depth 1 --branch feature/v2-original-hall-direct-wss50000 \
  https://github.com/iront1996/noname_xingbei.git /tmp/v2-original-hall-release
cd /tmp/v2-original-hall-release
git rev-parse HEAD
~~~

尚未檢查 GitHub commit SHA 與 CI 時不得直接 apply。先唯讀：

~~~bash
sudo bash ops/v2-original-hall/activate-wss-existing-vps.sh --check
sudo python3 ops/v2-original-hall/deploy-existing-vps.py --check
python3 ops/v2-original-hall/deploy-existing-vps.py --self-test
~~~

當新 A DNS-only、有效憑證、Nginx 及 Cloud Firewall SSH/50000 規則均查核通過後：

~~~bash
sudo bash ops/v2-original-hall/activate-wss-existing-vps.sh \
  --apply --firewall-reviewed --confirm ADD_V2_WSS_50000
~~~

這只新增 Nginx :50000 WSS 入口，轉發現有 HALL 127.0.0.1:8080，不停止或變更 HALL。執行失敗時，工具會嘗試移除新虛擬站台並重新載入 Nginx；不影響 cloudflared 與 V3。

## 4. V2 原版 HALL 原地覆蓋

**僅在外部確認新 WSS :50000 可連、沒有進行中的 V2 對局、部署檢查通過後**，執行：

~~~bash
cd /tmp/v2-original-hall-release
sudo python3 ops/v2-original-hall/deploy-existing-vps.py \
  --apply \
  --original-file game/server.js \
  --expect-ip 172.234.84.27 \
  --confirm REPLACE_V2_HALL
~~~

只替換 /opt/xingbei-hall/server.js，停止/啟動原有 xingbei-hall.service，保留備份並在啟動失敗時嘗試自動回復；不新增遊戲服務。舊 V2 HALL 上的 A1/監控補丁不移植，原版 60 秒文字 heartbeat 保留；8080 保持 loopback-only。

## 5. 外部網路驗證、正式切換

在**外部電腦**（Node.js 22+，不是 VPS 本機）執行：

~~~bash
node ops/v2-original-hall/verify-direct-wss.mjs
node ops/v2-original-hall/verify-direct-wss.mjs --heartbeat
~~~

檢查直接 DNS A、有效 TLS、WebSocket 101、原版 roomlist/key、連續兩輪 60 秒原版心跳。這個工具只建立臨時連線，不建房、不自動玩牌、不擷取玩家私人訊息。

再完成原版 HALL 的真實建房／入房／房規／訊息轉發及 2V2、3V3、4V4 對應相容性驗證。上列技術檢查通過不代表遊戲已通過真人驗收或長期穩定。

所有門檻完成後，才把本 V2 分支的 mode/connect.js 發布到 V2 專屬 Cloudflare Pages 正式分支。須先核實 Pages 的實際 production branch，不能因本 PR 的 base 就推定現行部署來源。V2 新客戶端唯一預設 WSS 50000，無舊 443 自動回退。最後可只移除兩條舊 V2 Tunnel Published applications，不需考慮舊 V1 客戶端，但絕不關閉 cloudflared.service 或 V3/monitor 的路由。

## 2026-11-12 確認的 Cloud Firewall 阻擋原因

在已開啟的 Akamai/Linode Cloud Firewall `xing` Rules 頁（ID `198170117`）實際讀到：
- **Default inbound policy：Drop**
- 允許的外部入站只有 SSH TCP 22、ICMP；另有 RFC1918 私有網段 TCP/UDP 全埠允許。
- **沒有允許一般公網 IPv4 TCP 50000 的規則**。

Windows PowerShell `Test-NetConnection v2-hall-direct.myxingbei.com -Port 50000` 返回 DNS `172.234.84.27`、Ping 成功（64 ms）、`TcpTestSucceeded=False`。這與 Cloud Firewall 拒絕入站 TCP 50000 的配置吻合。

**授權後只需針對此已綁定 VPS 的防火牆新增一條規則**：Label `V2-WSS-50000`、Action Accept、Protocol TCP、Port 50000、Sources `0.0.0.0/0`（公開玩家 IPv4）。儲存後重試 PowerShell TCP，並在 VPS 檢查 `sudo ss -lntp | grep ':50000'` 和本機 TLS。**不修改原有 SSH／ICMP／RFC1918 規則、Default inbound policy、V3／監控服務**。Cloud Firewall 開埠不能保證 nginx 已監聽，也不能證明 WSS/TLS 已驗證通過。

## 5A. Windows 報告 TLS connection timed out 時的分層診斷

2026-11-12 從外部 Windows 實測：DNS-only A = 172.234.84.27 PASS；TLS connect 到 :50000 超時。這尚不是 WebSocket／原版 HALL／心跳測試失敗；不能由一條 TLS 超時訊息單獨斷言故障發生在哪一層。

### Windows PowerShell（唯讀）

~~~powershell
Test-NetConnection v2-hall-direct.myxingbei.com -Port 50000 -InformationLevel Detailed
~~~

以 TcpTestSucceeded 為準，PingSucceeded 不代表 TCP 開放與否。

### 同一台 VPS（唯讀）

~~~bash
echo '== nginx service =='
sudo systemctl is-active nginx
sudo nginx -t
echo '== listeners =='
sudo ss -lntp | grep -E ':(50000|8080|8081)([[:space:]]|$)' || true
echo '== effective nginx V2 directives =='
sudo nginx -T 2>&1 | grep -nE 'listen 50000|v2-hall-direct|proxy_pass http://127.0.0.1:8080' || true
echo '== local TLS with actual SNI =='
timeout 10 openssl s_client -connect 127.0.0.1:50000 -servername v2-hall-direct.myxingbei.com -verify_hostname v2-hall-direct.myxingbei.com -brief </dev/null
~~~

### 判斷

- ss 找不到 :50000：Nginx 沒有開始監聽，優先檢查 nginx.service、nginx -t 及 V2 site 是否真正啟用；此時 Cloud Firewall 開埠也不能修正沒有監聽的服務。
- ss 只顯示 127.0.0.1:50000：公開網路無法直達該 Nginx listener。WSS TLS 入口應在對外介面監聽；只有明文 HALL 8080 維持 loopback-only。
- VPS localhost TLS 正常但 Windows TCP False：優先到 Akamai/Linode 防火牆 xing 檢查入站規則。該 Cloud Firewall 已確定掛載在 VPS，且不會出現在 iptables/nft/ufw 列表。若 inbound policy = DROP，確認有允許 TCP 50000 的規則，且沒有優先命中的衝突 DROP。保留 SSH 與其他規則，僅新增必要允許。
- Windows TCP True 但 Node TLS 超時：優先檢查 TLS listener、SNI、Nginx 設定及錯誤日誌，不能推斷是 HALL heartbeat。
- 外部 TLS 成功但 WebSocket 101、roomlist 失敗：再檢查 WebSocket Upgrade、proxy_pass 及 HALL 原版 key 握手。

注意：未從外部確認 TCP、TLS、WS 101 之前，不執行 HALL 原地覆蓋，不發布新 V2 網頁，也不停止 Cloudflare Tunnel／V3／監控服務。

## 驗收與回復

保存新／舊 source blob、HALL 備份、原 Nginx 設定、DNS A、Cloud Firewall 規則、TLS cert SAN／有效期、WSS Upgrade 結果、原版 HALL roomlist/key／心跳、房間運作與 browser close codes。Nginx 與 systemd 的被動日誌不等於原版心跳逐次 ACK 紀錄；不要謊稱每次心跳都已自動記錄。

只在全部部署、真實網路驗證、遊戲相容性及正式 Pages 發布完成後，才能稱為 V2 改版完成。不能因 GitHub CI 綠燈就聲稱正式 VPS 已改版。
