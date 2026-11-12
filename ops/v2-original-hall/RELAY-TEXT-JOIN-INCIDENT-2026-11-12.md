# V2 玩家無法加入房間：WebSocket 文字轉發 Buffer 變形事件

日期：2026-11-12。狀態：取得真實封包、隔離重現並驗證修正 PASS；正式 V2 尚未部署此項修正。

## 真實事件

- 訪客可連到新 WSS 50000，房間未滿且版本相符，但 enteringRoom=true 無法進入。
- 房主端收到 onconnection，送出 opened；之後 onmessage 中，訪客原本的 JSON 文字 init 變成 {type:"Buffer",data:[...]} 物件。
- 該訊息內含身分鍵、房間密碼等，不應在 GitHub 儲存真實值；本報告不保存原封包內容。

## 原因

原版 game/server.js 在 ws.on("message") 後，將收到的 message 直接傳給 this.owner.sendl("onmessage", this.wsid, message)。新的 ws 套件可用 Buffer 傳遞文字 frame。sendl 使用 JSON.stringify(args)，把 Buffer 轉成 {type:"Buffer",data:[...]}。房主端 lib.init.connection 內透過 JSON.parse(messagestr) 接收原生 JSON 文字，遇到該物件無法完成 init。

所以已通過的 WebSocket 101、roomlist/key、heartbeat、owner→guest 通訊，不能證明 guest→host init JSON 字串保持正確。

## 僅兩處的修正候選

在已安裝的 V2 HALL（SHA256 963f3a155ad00f5a7b1cdc00937c6d4240fb34f93a94938f2e4629cbf2ea9bb6）之上，只替換：
1. ws.on("message", function (message, isBinary) {
2. this.owner.sendl("onmessage", this.wsid, !isBinary && Buffer.isBuffer(message) ? message.toString("utf8") : message);

新候選 SHA256：1388ec5b559354a1ce6bba59ca8e2ac625e402655fcd81c845fa104e37f18b52。

此修正保留原版心跳、所有原版玩法／規則／房主職責、二進位訊息舊行為，以及上次通過的 X-V2-Client-IP 代理來源安全修正。不修改 Nginx、DNS、Cloudflare 或其它版本。

## 隔離測試證據

GitHub Actions run #54：https://github.com/iront1996/noname_xingbei/actions/runs/43240342255，completed success。

在一次性、隨機 loopback 埠的真正 Nginx＋固定版本 V2 HALL 上：
- 目前已部署的 HALL：真實文字 init 封包經 HALL 被轉成 Buffer JSON 物件；房主 JSON.parse 失敗。
- 最小候選版本：同一文字 init 以字串型別交給房主，JSON.parse 正常；房主回傳 init 可再轉發訪客。
- 二進位資料仍保留原版 Buffer 序列化。
- 既有可信來源 IP 隔離、原版 heartbeat、房間 enter、房主到訪客轉送回歸仍通過。
- 部署器的固定 SHA 及兩處精準變動檢查、無人連線 gate、備份、啟動失敗回復等離線模擬均 PASS。

這不等於已完成真實瀏覽器全局或正式真人多人驗收。

## 受控部署準備：尚未執行

候選產生器：ops/v2-original-hall/proxy-relay-text-fix-candidate.mjs。
V2-only 部署器：ops/v2-original-hall/deploy-relay-text-fix.py。

先於正確 GitHub 分支、乾淨工作樹下，更新 V2 專用 /tmp 工作目錄；不得覆寫未知本機修改。之後僅唯讀：

    cd /tmp/v2-original-hall-release
    python3 ops/v2-original-hall/deploy-relay-text-fix.py --self-test
    sudo python3 ops/v2-original-hall/deploy-relay-text-fix.py --check

注意 CHECK 要求零已建立的 :8080 連線，因此正在有人遊玩的環境會拒絕；不可為了通過而踢玩家、kill 或強制重啟。

只有使用者明確核准此項新的 V2 WebSocket 文字轉發相容性修正，且確定 V2 沒有玩家連線後，才可在維護時間使用：

    sudo python3 ops/v2-original-hall/deploy-relay-text-fix.py --apply --confirm APPLY_V2_TEXT_RELAY_FIX

部署器只會更換原 V2 systemd 所使用的 /opt/xingbei-hall/server.js，事先備份並在失敗時嘗試恢復，不會修改 Nginx 或其它版本服務。但安全准入 CHECK 只保證已檢查的服務映射，不保證沒有其它舊網站透過既有 HALL 路由共用此服務，需留意。

## 後續驗收

- sha256sum /opt/xingbei-hall/server.js 等於新候選 1388ec5b...，CHECK 表示 relay-text candidate。
- xingbei-hall、xingbei-hall-v3、nginx、cloudflared、xingbei-monitor 均 active。
- Windows 外部驗證 DNS / TLS / WebSocket 101 / roomlist-key / 2 輪原版 heartbeat。
- 使用正常玩家建房與入房；僅核對 onconnection / opened / init 等訊息名稱，不在正式線上送非法測試封包。
- 完成後再驗收 2V2、3V3、4V4 原版玩法及長期連線穩定性。

## 其它獨立線索

先前瀏覽器 Console 出現 checkFile 預期 JSON 卻讀到 HTML，以及 game.readFileAsText is not a function，屬另一項靜態網頁資源初始化線索。不能當作本次已確認的 Buffer 轉發問題之替代原因，也不應與本輪修正混在一起。

資料安全：使用者提供的完整 init 封包含線上身分鍵及房間密碼，建議重設已曝光的房間密碼，避免再公開貼出完整 WebSocket 訊息。
