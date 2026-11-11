# V2 原版 HALL｜現有 VPS 原地替換／DNS only／WSS :50000

**正式上線流程以 [GO-LIVE.md](./GO-LIVE.md) 為準。**此 README 為詳細設計及歷史查核紀錄；所有即時 DNS／防火牆／憑證狀態仍須重新驗證。最新工具包括 [activate-wss-existing-vps.sh](./activate-wss-existing-vps.sh)、[deploy-existing-vps.py](./deploy-existing-vps.py) 及 [verify-direct-wss.mjs](./verify-direct-wss.mjs)。

狀態：GitHub 草稿分支已建立；尚未部署 VPS、DNS 或 Cloudflare Pages。

## 已授權方案與保護範圍

使用者已授權直接覆蓋現有 V2 聯機服務，並表示改版前可以容忍既有 V2 HALL 停機。**2026-11-11 範圍修正：使用者明確接受舊 V1 網頁／其他客戶端若仍連向 `hall.myxingbei.com` 或 `myxingbei.com`，其連線在 V2 改版過程中可能中斷、失效或改變行為；不再要求調查這些舊客戶端的依賴，也不以舊 V1 的持續可連線性作為 V2 覆蓋阻擋條件。**本工程不新增第二個常駐 HALL systemd 服務，不強制沿用 A1 Ping/Pong 或舊監控。此授權**僅**涵蓋 V2 原有 HALL 及其兩個舊聯機入口，並不授權修改其他版本的程式、檔案或獨立服務。

新預設入口：wss://v2-hall-direct.myxingbei.com:50000；V2 網頁與圖片預載留在 Cloudflare Pages。新入口使用 DNS only A 記錄指向**現有 VPS**。**已核實 VPS 有 cloudflared Tunnel，但未發現本機 Nginx/Caddy/HAProxy/Traefik 或外部 TLS :50000 listener**，因此必須在同 VPS 新增 TLS 終止層，代理至唯一現有 HALL 的 loopback 8080；這不是第二個遊戲 HALL。仍採真人房主主持，不改原版遊戲規則與訊息協定。

原版基準：RancherJie/noname_xingbei@bd227231b6edeba5b32f906673b9f3cb0091b90c，game/server.js Git Blob SHA 為 49a0ad87ffc2638e3651fe6a08b5a150cdf38de3。**部署工具保留該檔為輸入基準，但為維持 VPS 現有的本機-only 安全邊界，部署時僅加上 WebSocket listener 的 host: "127.0.0.1" 參數；這個必要的監聽範圍調整會讓實際部署檔的 SHA 與原版不同，不影響心跳、房間或遊戲訊息協定。**

**2026-11-11 現有 VPS 唯讀證據（已結合 Tunnel 截圖核實）：** systemd MainPID 1900742 = `/usr/bin/node /opt/xingbei-hall/server.js` = `127.0.0.1:8080`；MainPID 193545 = `/usr/bin/node /opt/xingbei-hall-v3/server.js` = `127.0.0.1:8081`。`cloudflared.service`、`xingbei-monitor.service`、`xingbei-v2-observer.service` 均在運行。現有 V2 外部兩個 hostname 已**確認**透過 Cloudflare Tunnel 指向 `127.0.0.1:8080`；V3 和監控各有其他 route。`command -v` 只找到 `/usr/local/bin/cloudflared`，未找到 Nginx、Caddy、HAProxy、Traefik；VPS 無本機 TCP :80、:443、:50000 監聽。不能把 cloudflared 當作 DNS-only :50000 的 TLS 入口，更不可直接停止它。無需再核對舊 V1／其他客戶端是否保存使用上述兩個 V2 hostname；使用者已接受這些入口改版造成的相容性影響。其他版本獨立的 systemd、程式路徑與 Tunnel 路由仍受保護。

## 2026-11-11 追加 VPS 公網／防火牆查核結果（依使用者實際終端輸出）

- `eth0` 實際配置 `172.234.84.27/24`，預設路由經 `172.234.84.1`；`api.ipify.org` 回報出口 IPv4 也是 `172.234.84.27`。這證明 VPS 持有公開 IPv4，而非只有 Cloudflare Tunnel 的出口，但**沒有單獨證明新的外部 TCP 50000 可入站**。
- `ufw status verbose` 顯示 `Status: inactive`：不得視為已開放或已防護 50000；還需查 `nftables/iptables` 及 VPS 供應商控制台防火牆，先確保 SSH 管理通道，再設定必要入站政策。
- `cloudflared.service`：active，MainPID 657，單元檔 `/etc/systemd/system/cloudflared.service`。在四個常見路徑沒有找到 Cloudflare Tunnel 本機 YAML 設定檔；這**支持但不證實**目前使用遠端受管 Tunnel。應到 Cloudflare Zero Trust 控制台查看 Public Hostnames／Published applications 的實際 ingress → `localhost:8080/8081` 對應關係；**禁止貼 Tunnel Token、認證 JSON 或完整含 token 的 ExecStart**。
- `xingbei-monitor.service`（PID 3401804）與 `xingbei-v2-observer.service`（PID 3401805）均 active，目錄分別為 `/opt/xingbei-monitor`、`/opt/xingbei-v2-observer`。清除 V2 A1／監控補丁後可以不再保留其 V2 資料，但必須確認 V1/V3 共用監控不被中斷。
- 現有 V2、V3 的 Node 服務仍然獨立，並且 `8080`、`8081` 都是 loopback-only；V2 原地替換時的唯一 listener 安全調整必須維持此性質。
- 下一個階段先完成：**既有 Tunnel 路由確認（已完成）、主機和供應商入站 ACL、TLS 簽發方法**。檢查成功後，才在同台 VPS 啟動 WSS :50000，最後再執行 V2 原地替換與正式前端切換。

> 不要啟用 Cloudflare 帳戶級「強制 DNS only」選項；只調整**新建立**的 `v2-hall-direct.myxingbei.com` 一筆 A 記錄，避免對其他版本的 Cloudflare Tunnel 或 Pages 造成影響。該子網域的 DNS only 會對外公開 VPS IP，須配合主機及供應商防火牆與服務加固。

### 下一輪唯讀核對指令

~~~bash
echo '=== kernel firewall ==='
sudo nft list ruleset 2>&1 | sed -n '1,140p'
sudo iptables -S 2>&1 | sed -n '1,100p'
echo '=== existing open ports ==='
sudo ss -ltnp | grep -E ':(22|80|443|8080|8081|50000)([[:space:]]|$)' || true
echo '=== V2 source, ownership and Node dependency ==='
ls -ld /opt/xingbei-hall /opt/xingbei-hall/server.js
node -v
sudo -u xingbei node -e 'console.log(require.resolve("ws",{paths:["/opt/xingbei-hall"]}))'
~~~

命令均為唯讀。還要在主機供應商的防火牆控制台檢查是否已綁定防火牆及目前入站規則；不應只根據 VPS 內的 UFW 判斷。若沒有 Cloudflare Tunnel 本機 YAML，直接到 Cloudflare 控制台查看發佈路由即可，不執行任何包含憑證的登入命令。

## 2026-11-11 Cloudflare Tunnel 真實公開路由與主機防火牆（使用者截圖＋VPS 指令）

已由 Cloudflare Zero Trust → Tunnel → Routes 畫面逐項核對，這**不是**推測：

| 公開 hostname | Tunnel target | 判讀 |
| --- | --- | --- |
| `hall.myxingbei.com` | `http://127.0.0.1:8080` | V2 舊 HALL 入口 |
| `myxingbei.com` | `http://127.0.0.1:8080` | V2 舊 HALL 入口 |
| `v3.myxingbei.com` | `http://127.0.0.1:8081` | 獨立 V3 HALL |
| `monitor.myxingbei.com` | `http://127.0.0.1:18763` | 統一監控入口 |

實際網路鏈：舊 V2 瀏覽器 → Cloudflare HTTP／WebSocket 入口 → Cloudflare Tunnel（cloudflared）→ `127.0.0.1:8080`。DNS only 的新 V2 50000 不可沿用這一條 Tunnel 鏈，必須有同 VPS 的可入站 TLS listener。

主機防火牆檢查：`ufw status verbose` = inactive；`sudo nft list ruleset` 未列規則；`sudo iptables -S` = `-P INPUT ACCEPT`、`-P FORWARD ACCEPT`、`-P OUTPUT ACCEPT`。**此三項顯示未看到主機封鎖規則，但不能證明上游供應商 Cloud Firewall 允許 TCP 50000 或安全。**在確認 SSH 可持續管理與供應商既有入站政策之前，不啟用 UFW、不清除 iptables、不修改雲端政策。

此圖也確立一項需在最終切換時處理的事：**直接覆蓋 V2 `/opt/xingbei-hall/server.js` 會讓 `hall.myxingbei.com` 和 `myxingbei.com` 兩個舊 Tunnel 入口同時使用新原版 HALL**。使用者已明確接受舊 V1 網頁及其他客戶端因此可能失去連線或改變行為；**不用再追查舊客戶端是否仍使用這兩條路由**。新 V2 前端不再將這兩個 hostname 作為正式預設。正式新入口驗證完成後，可安排只停用／移除**這兩條 V2 舊 Published applications**，不必等待 V1 舊客戶端相容性確認。**絕對不停止 `cloudflared.service`、不刪 `v3.myxingbei.com` 或 `monitor.myxingbei.com` 路由。**

GitHub master 分支的原始 `mode/connect.js` 預設由 `lib.config.last_ip || lib.hallURL` 決定，而該分支 `lib.hallURL` 為 `agserver.ssyy.tech:50000`。這個背景不再是 V2 切換門檻；對自行輸入或保存舊 V2 hostname 的客戶端，連線中斷或相容性變更為已接受影響。

### 下一階段已明確的執行順序

1. **供應商 Cloud Firewall 檢查（只看，不改）**：確認 VPS `172.234.84.27` 的實際入站 policy 是否允許 `50000/tcp` 以及現有 SSH 規則。Linode/Akamai 若有綁定 Cloud Firewall，需核對該台實例；未綁定不代表自動阻擋。
2. **Cloudflare 僅新增**一筆 `A v2-hall-direct → 172.234.84.27`，設定 DNS only（灰雲）。不刪除、改動任何目前正在使用的路由／DNS 記錄。若 AAAA 存在則須核對其目的地。
3. 在**同一台**現有 VPS 建立 TLS 憑證與最小化加密 WSS `:50000` 轉發入口（建議以 Nginx 作為 TLS 入口，但**不建立第二個遊戲 HALL**）。新入口先轉發現有 V2 `127.0.0.1:8080`，此時仍有 A1，僅用於 TLS/WS 握手及 TCP 入站測試，**不可當成原版 HALL 的穩定性驗收**。
4. 不再進行舊 V1 客戶端是否使用 V2 兩個舊 hostname 的調查；備份 V2 舊檔，使用已實作的 fail-closed 工具原地替換 `xingbei-hall.service` 的 HALL，維持 `127.0.0.1:8080` loopback-only，然後驗證原版 roomlist/key、遊戲訊息及連線持續性。
5. 完成驗證後才發佈 V2 前端，預設唯一新入口 `wss://v2-hall-direct.myxingbei.com:50000`。正式 V2 穩定驗證後，如決定停止舊 V2 入口，直接只移除兩條 V2 Published applications，**不再因舊 V1 客戶端而延遲**；保留 cloudflared 本身與 V3/monitor 路由。

## 目前最先進行的唯讀網路／路由核對

在任何新埠、憑證、DNS 或 HALL 覆蓋之前，先檢查：
- 現有 VPS **是否有真正可入站的公開 IPv4**（不是只有 Cloudflare Tunnel 的對外通路）；從 VPS 查詢的出口公網 IP 不代表 IPv4 一定直掛在 VPS 上，也不保證 TCP 50000 可以入站。
- Cloudflare Dashboard 的 ingress 路由已確認：兩個舊 V2 hostname 指向 :8080，V3 指向 :8081，監控指向 :18763。不再調查舊 V1 客戶端使用哪些 V2 hostname。
- `xingbei-monitor.service` 是 V1／V2／V3 統一監控，仍需保護其獨立服務，不因移除 V2 的 A1 補丁而停止或覆蓋整體監控；`xingbei-v2-observer.service` 可另評估是否需要關閉，但不屬於 HALL 原地替換操作。
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

回傳輸出時刪去 token、密碼、憑證內容及不必要的私有資料。重點查明 50000 是否佔用、TLS 入口目前由誰處理，以及對外埠、防火牆、相同實體程式檔是否被其他 systemd 服務引用。不再追查舊 V1 客戶端使用哪些 V2 聯機地址。

在 GitHub 本工程分支的工作目錄：

~~~bash
python3 ops/v2-original-hall/deploy-existing-vps.py --self-test
sudo python3 ops/v2-original-hall/deploy-existing-vps.py --check
~~~

--check 完全唯讀；核對既有服務、來源檔、Node ws 套件，以及 :8080 現有 TCP 連線。若路徑與預期不符，會拒絕而不是覆蓋未知檔案。舊 V1 網頁／其他客戶端是否仍連向兩個 V2 舊網域，已不再構成阻擋；但若其他 systemd 服務實際共用同一程式檔，部署器仍須拒絕覆蓋以免直接修改其他服務。

## 步驟 2：設定 DNS only + WSS，不開新 HALL service

Cloudflare DNS 新增子網域 v2-hall-direct 的 A 記錄，指向**此現有 VPS 的真實公開 IPv4**，Proxy status 選 DNS only（灰雲）。不能改動主網域 myxingbei.com 或目前已存在的 hall.myxingbei.com；不要動 Cloudflare Pages。檢查 AAAA 記錄，避免意外 IPv6 路由。

TLS 憑證須涵蓋 v2-hall-direct.myxingbei.com，且具備可維護的自動續期方式。可使用已涵蓋此子網域的現有憑證，或以 ACME DNS-01 簽發，避免為新增域名覆蓋既有 80/443 虛擬主機。不得把 Cloudflare API token 放入 GitHub。

**已確認 VPS 上沒有已知本機 TLS 服務**（目前僅發現 cloudflared，不是 DNS-only 直連入口）。必須先查 VPS 是否擁有可由公網路由到達的 IPv4、主機與供應商入站 ACL，再於**同一台 VPS**新增必要的 TLS 終止層（優先評估 Nginx；這是加密入口，不是第二個遊戲 HALL），使新 WSS :50000 代理到唯一現有 HALL 的 `127.0.0.1:8080`。範本見 `nginx-wss-50000.conf.example`。**不可停止 cloudflared.service**，因為它可能仍為 V1／V3／其他入口提供路由；也不能把 Cloudflare Tunnel 原有 hostname 直接改成 DNS only 而沒有建立新 TLS 入口。不得使用未加密 :8080 對外。初始 `proxy_read_timeout` 與 `proxy_send_timeout` 均為 180 秒，以避開原版 60 秒心跳週期與 60 秒代理讀取逾時的競態。

對外只新增 TCP 50000；確保公開網路**無法**直接存取原版明文 8080。公開原始碼的 server.js 預設監聽所有介面，但**本工程部署器僅改一處 listener 為 127.0.0.1**，因此不應讓公網監聽 8080；另外仍應以主機及供應商防火牆建立縱深防護。保留現有 SSH、其他服務與舊站台所需的埠。

## 步驟 3：原地覆蓋 V2 HALL（只停止同一個服務）

取得本工程分支後，先執行 self-test、--check 和 node --check game/server.js。**只要確認系統服務與原始檔的對應無誤、沒有其他 systemd 服務共用實體檔案、DNS 已就緒、TLS／防火牆／代理檢查通過且無 8080 使用中的連線，便可執行 --apply；舊 V1 網頁／其他客戶端是否還記住舊 V2 hostname 不再是阻擋條件。**

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

只在新入口驗收通過且沒有進行中對局後，才把本 PR 的 mode/connect.js 發佈到 V2 Cloudflare Pages，讓 V2 預設唯一官方入口變為 wss://v2-hall-direct.myxingbei.com:50000。舊 :443 不做自動回退。**不必保留 `hall.myxingbei.com` 與 `myxingbei.com` 兩條舊 V2 WebSocket Tunnel 路由給 V1 舊客戶端**；正式新入口驗證後可依 V2 切換計畫停用這兩條 Published applications，但不得停掉整個 cloudflared.service 或影響 V3／監控的其他路由。

保留切換前 443 歷史日誌、原始碼備份與新 50000 被動 Nginx/systemd 觀測作對照。原版 HALL 本身不輸出每次 heartbeat ACK 的詳細時間，故不應謊稱在完全保留原版的情況下已實現逐次心跳監控。正式上線後若仍不穩，再依證據評估是否增加最小診斷能力。

## 安全與限制

- --check 唯讀；--apply 會修改**既有 V2 HALL 服務程式**並短暫停止／啟動它，只有通過安全檢查時才能實際使用。
- 自動 rollback 範圍僅限被此腳本取代的 server.js；Nginx、DNS、Cloudflare Pages 的變更須另行保留並執行回復流程。
- 不新增第二套服務、不再沿用 A1/監控修正、不動 V1、V3、V4、V5、M2、原版與其他正式服務。
- 現有 VPS 尚未取得可供本聊天室實際管理的 SSH 權限，因此**目前這份 GitHub 工程不是已部署完成**。
