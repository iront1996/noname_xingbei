# 星杯傳說：V3 規則與恢復狀態對照

建立：2026-10-11。適用於 `feature/host-reconnect-v3-playtest` 的《星杯傳說》連線模式。這是**設計依據，不是規則書的全文翻印**。

## 資料來源與優先次序

1. 繁體中文《星杯傳說百科》〈規則說明書〉：
   https://xingbeichuanshuobaike.webnode.tw/遊戲指南-規則說明書/
2. 同網站〈新手攻略〉：
   https://xingbeichuanshuobaike.webnode.tw/遊戲指南-新手攻略/
3. 實際運行中的本專案程式（**實作行為以此為準，若與外部規則不同須標示差異**）：
   `mode/xingBei.js`、`card/xingBei.js`、
   `noname/game/index.js`、`noname/library/element/player.js`、
   `noname/library/element/content.js`，以及 `character/*.js`。

百科屬社群彙整資料，角色、擴充版及可選遊戲模式可能不同。V3 恢復工程應先對準**目前部署程式真正執行的規則**，不可直接以桌遊其他版本覆蓋現有技能。

## 需要避免的通用無名殺假設

- 星杯角色沒有標準三國殺那種「HP 減到 0 就死亡」勝利模式。
- **傷害**的基礎效果通常是受害角色摸相應張數的牌；受傷前可能以治療抵禦，手牌超上限時依規則處理並可能降低**陣營士氣**。
- **治療（zhiLiao）**是能抵禦傷害的專門資源，**不是恢復 HP**。通用引擎 `recover/loseHp/changeHp` API 的存在不代表本模式以 HP 為核心。
- 勝利通常發生在對方陣營士氣降至 0 以下，或己方取得 5 個星杯（以現有 `game.xingBeiMax` 及規則設定為準）。
- 本遊戲有攻擊、法術、購買、合成、提煉，行動前中毒／虛弱可影響結算。開始階段和回應／應戰／技能觸發形成複雜非同步事件序列。
- 星石分 `baoShi`（寶石）與 `shuiJing`（水晶）；存在於陣營戰績區或個人能量。遊戲內有治療、手牌、牌庫／棄牌堆、指示物、額外行動、專屬技能等子系統。

## 源碼核實的主要狀態欄位

| 遊戲概念 | 專案原生資料 | 備註 |
|---|---|---|
| 紅／藍士氣 | `game.hongShiQi`, `game.lanShiQi` | `changeShiQi` 事件／遊戲方法 |
| 紅／藍星杯 | `game.hongXingBei`, `game.lanXingBei` | `changeXingBei`、`game.checkResult` |
| 紅／藍戰績區星石 | `game.hongZhanJi`, `game.lanZhanJi` | 陣列元素為 `baoShi`／`shuiJing` |
| 個人治療 | `player.zhiLiao` | `changeZhiLiao`，不是 HP |
| 個人寶石／水晶能量 | `player.countNengLiang('baoShi'/'shuiJing')` | 對應 `_tiLian_*` 標記；尚未納入 V20 安全讀取器 |
| 個人手牌與區域 | Player 卡牌節點／遊戲物件 | 私密卡牌身分、順序；不可當作匿名指標公開 |
| 共用牌庫、棄牌堆 | `ui.cardPile`, `ui.discardPile` | V20 只統計張數，無法還原牌的精確順序 |
| 技能／標記／臨時效果 | `player.storage`、marks、skills 等 | 非任意 JSON；可能包含 Event、Card、Player、閉包 |
| 事件、選擇、非同步續行 | `GameEvent`、`phaseLoop`、Promise、網路響應 | 現有純觀測日誌**無法重新執行** |

### 原生程式證據

- `noname/game/index.js` 的 `Game` 明確定義 `shiQiMax`、`xingBeiMax`、`zhanJiMax`、`hongShiQi`、`lanShiQi`、`hongZhanJi`、`lanZhanJi`、`hongXingBei`、`lanXingBei`、`zhiLiaoMax` 等。
- `noname/library/element/content.js` 的 Xingbei `damage` 結算會執行 `player.draw(num,source).set('cause','damage')`；`changeShiQi`、`changeZhanJi`、`changeXingBei`、`changeZhiLiao` 各自修改對應值，`changeNengLiang` 修改星石標記。
- `mode/xingBei.js` 的勝利判定使用 `hongShiQi/lanShiQi` 與 `hongXingBei/lanXingBei`，不使用一般 HP 死亡條件。

## 第 19 版數據的重新解讀

實測 `v3-mechanical-delta-19`：

- 原生 Player API 排程呼叫：44 次（`damage 9 / gain 9 / lose 17 / draw 9`），這是**呼叫數**，非已確認的損血或摸牌結算。
- `STATE_DELTA_WINDOWS_OBSERVED`：有效區間 6、所謂「體力變更區間 3」、牌庫棄牌堆數量變更區間 6。
- 本模式中「體力變更區間 3」是通用引擎 HP 原始欄位的變化統計，**不能拿來推斷星杯受傷、治療、或士氣變動**。
- 事件時間線 `ENCRYPTED_INERT_TIMELINE_VERIFIED`：轉移 2017、缺口 0、淘汰 0；獨立證據驗證成功，但正式定期及回合邊界快照仍不可續行。

## V3 第 20 版設計修正

新增 `game/v3-xingbei-state-delta.mjs`，替換 V19 對 `hp/maxHp/hujia` 的即時取樣：

- 每約 6 秒，只取紅／藍**士氣、星杯數、寶石與水晶數、各座位治療數、共用牌庫／棄牌堆張數**。
- 不存 Player ID、Player/Card/Event 物件或卡牌內容；在記憶體以 `WeakMap` 對照同一座位物件，只累積匿名區間統計。
- 對不合法狀態、意外資料型別、getter、座位變更／觀測計數重設 fail closed，不能假裝狀態無變化。
- 健康畫面使用「星杯規則狀態取樣」、「士氣／星杯／星石／治療／牌庫變化區間」；通用 Player API 類別獨立標成引擎觀測，不用「扣血／恢復體力」作為星杯概念。
- `energyObserved:false`、`skillStorageObserved:false`，明示**尚未涵蓋**能量、技能／指示物、手牌真實內容；這個讀取器**不是**完整 game snapshot。
- 原有 V3 encrypted timeline 與事件 evidence 持續保留；`safeCheckpointCertified`、`eventContinuationCaptured`、`restorable`、`readyToResume` 一律不得由這些區間觀測提升為 true。
- 不更動 V1、V2、V3 VPS broker、真正引擎技能計算或 server room protocol。

## 後續真正的 cold-resume 狀態清單（未實作，不是允許重播）

1. 必須還原**精確**陣營士氣、星杯、戰績區星石的類型與數量；不能只用總數和區間統計。
2. 必須還原每個角色的治療、能量類型／數量、永久／臨時技能、技能存儲和指示物；並保留玩家座位及陣營對應。
3. 必須以加密、權威方式保存每張牌的**確切身分與原本位置／順序**，含共用牌庫、棄牌堆、手牌及場上持續牌；「牌庫剩幾張」不足以續局。
4. 必須保存或安全重建本回合所處行動階段、已執行行動類型、回應／應戰鏈、未完成玩家選擇和所有排隊的子事件。
5. 需要對每次實際的星杯副作用（傷害導致摸牌／爆牌士氣、治療消耗、能量轉移、星石／星杯變更等）建立防重複結算機制。已保存的 API 計數或 Promise fulfilled 不等於已持久化套用結果。
6. 網路房主身份與真人席位重連須有 server 驗證；不能只信任 `playerid` 或前端傳入的恢復 token。

**結論：V20 是星杯規則化的唯讀診斷，尚不是可恢復原局的引擎。**
