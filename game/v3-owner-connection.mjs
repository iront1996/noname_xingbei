/**
 * V3 Playtest: transport-only room-owner reconnection.
 *
 * Covers a temporary socket interruption while the owner's original browser
 * tab stays alive. It CANNOT restore an authoritative game after reload,
 * tab closure, device loss, or VPS restart.
 *
 * Installed once by the V3 connect screen; no production V1/V2 imports.
 */
import { game, lib, _status } from "../noname.js";

const BACKEND = "wss://v3.myxingbei.com:443";
const TOKEN_PREFIX = "xingbei-v3-owner-token:";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
let installed = false;
let overlay;
let retryTimer = null;
let connecting = false;
let retryCount = 0;
let pauseOwned = false;
let simulatedHoldUntil = 0;

function getToken(roomId) {
  try {
    const value = sessionStorage.getItem(TOKEN_PREFIX + roomId);
    return value && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function saveToken(roomId, token) {
  if (typeof roomId !== "string" || !TOKEN_PATTERN.test(token)) return false;
  try {
    sessionStorage.setItem(TOKEN_PREFIX + roomId, token);
    return true;
  } catch {
    return false;
  }
}

function removeOverlay() {
  if (overlay) overlay.remove();
  overlay = null;
}

function displayOverlay(title, body) {
  if (!document.body) return;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#090f1be8;" +
      "display:flex;align-items:center;justify-content:center;padding:18px;" +
      "box-sizing:border-box;";
    const shadow = overlay.attachShadow({ mode: "closed" });
    const panel = document.createElement("section");
    panel.style.cssText =
      "display:block;max-width:480px;width:100%;padding:28px;" +
      "box-sizing:border-box;border:1px solid #64748b;border-radius:14px;" +
      "background:#182638;color:#f8fafc;font:16px/1.6 system-ui,sans-serif;" +
      "text-align:center;box-shadow:0 24px 60px #0008;";
    const heading = document.createElement("h2");
    heading.dataset.role = "v3-heading";
    heading.style.cssText = "margin:0 0 16px;font-size:22px;color:#fff;";
    const text = document.createElement("p");
    text.dataset.role = "v3-body";
    text.style.cssText = "margin:0;color:#cbd5e1;white-space:pre-line;";
    panel.append(heading, text);
    shadow.append(panel);
    overlay.__v3Heading = heading;
    overlay.__v3Body = text;
    document.body.append(overlay);
  }
  overlay.__v3Heading.textContent = title;
  overlay.__v3Body.textContent = body;
}

function isLiveOwner() {
  return Boolean(
    game.onlineroom && !game.online && _status.connectMode &&
    _status.gameStarted && typeof game.roomId === "string"
  );
}

function scheduleRetry() {
  if (retryTimer || !isLiveOwner()) return;
  if (!getToken(game.roomId)) {
    displayOverlay("房主暫時離線", "無法找到本分頁的重新連線憑證。請勿重新整理；此局目前無法自動恢復。");
    return;
  }
  const delay = Math.max(
    Math.min(8000, 700 * Math.pow(1.5, Math.min(retryCount++, 7))),
    simulatedHoldUntil - Date.now()
  );
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void reconnectOwner();
  }, delay);
}

function reconnectOwner() {
  if (connecting || !isLiveOwner() || game.ws?.readyState === WebSocket.OPEN) return;
  const key = game.roomId;
  const token = getToken(key);
  if (!token) {
    displayOverlay("房主暫時離線", "重連憑證不存在。請勿重新整理遊戲。");
    return;
  }
  connecting = true;
  let accepted = false;
  let rejected = false;
  const socket = new WebSocket(BACKEND);
  const timeout = setTimeout(() => {
    if (!accepted && !rejected) socket.close();
  }, 10000);

  socket.onopen = () => {};
  socket.onmessage = messageEvent => {
    if (messageEvent.data === "heartbeat") {
      socket.send("heartbeat");
      return;
    }
    let msg;
    try {
      msg = JSON.parse(messageEvent.data);
      if (!Array.isArray(msg)) throw new Error("invalid response");
    } catch {
      return;
    }
    if (msg[0] === "roomlist") {
      socket.send(JSON.stringify(["server", "key", [game.onlineKey, lib.version]]));
      socket.send(JSON.stringify(["server", "v3resume", key, token]));
      return;
    }
    if (msg[0] === "v3ownerresumedHost" && msg[1] === key && TOKEN_PATTERN.test(msg[2])) {
      accepted = true;
      clearTimeout(timeout);
      connecting = false;
      retryCount = 0;
      saveToken(key, msg[2]);
      game.ws = socket;
      socket.onopen = lib.element.ws.onopen;
      socket.onmessage = lib.element.ws.onmessage;
      socket.onerror = lib.element.ws.onerror;
      socket.onclose = lib.element.ws.onclose;
      // Release peers only after this tab has installed its live message handlers.
      socket.send(JSON.stringify(["server", "v3ready", key]));
      if (pauseOwned) {
        pauseOwned = false;
        game.resume();
      }
      removeOverlay();
      console.info("[V3 playtest] 房主網路連線已恢復（原分頁保留）");
      return;
    }
    if (msg[0] === "v3resumerejected") {
      rejected = true;
      clearTimeout(timeout);
      displayOverlay(
        "房主重連未完成",
        "伺服器拒絕恢復原連線，原因：" + String(msg[1] || "unknown") +
        "。不要重新整理或直接建立同編號房間。"
      );
      socket.close();
    }
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    clearTimeout(timeout);
    if (accepted) return;
    connecting = false;
    if (!rejected) scheduleRetry();
  };
}

function installPlaytestButton() {
  if (!document.body || document.getElementById("v3-playtest-owner-drop")) return;
  const button = document.createElement("button");
  button.id = "v3-playtest-owner-drop";
  button.type = "button";
  button.textContent = "V3 測試：模擬房主斷線";
  button.style.cssText =
    "position:fixed;bottom:14px;right:14px;z-index:999999;" +
    "border:1px solid #64748b;border-radius:8px;background:#182638;" +
    "color:#f8fafc;padding:8px 12px;font:13px system-ui,sans-serif;" +
    "box-shadow:0 2px 10px #0007;cursor:pointer;display:none;";
  button.addEventListener("click", () => {
    if (!isLiveOwner() || game.ws?.readyState !== WebSocket.OPEN) return;
    if (!window.confirm(
      "僅測試房主「原分頁仍開啟」時的網路中斷。\n" +
      "斷線約 5 秒後自動嘗試恢復。\n" +
      "這不會測試重新整理後的續局能力。\n\n是否開始？"
    )) return;
    simulatedHoldUntil = Date.now() + 5000;
    game.ws.close();
  });
  document.body.append(button);
  setInterval(() => {
    button.style.display =
      isLiveOwner() && game.ws?.readyState === WebSocket.OPEN ? "block" : "none";
  }, 1000);
}

export function installV3OwnerConnection() {
  if (installed) return;
  installed = true;
  installPlaytestButton();
  const defaultOnclose = lib.element.ws.onclose;
  const defaultOnerror = lib.element.ws.onerror;

  lib.message.client.v3ownerToken = (key, token) => {
    if (game.onlineroom && !game.online && game.roomId === key) {
      if (!saveToken(key, token)) {
        console.warn("[V3 playtest] 無法保存房主臨時重連憑證");
      }
    }
  };
  lib.message.client.v3ownerpaused = () => {
    if (game.online && _status.gameStarted) {
      displayOverlay("等待房主重新連線", "房主網路暫時中斷，房間已保留。\n請保持此頁面開啟，暫勿重新整理。");
    }
  };
  lib.message.client.v3ownerresumed = () => {
    if (game.online) removeOverlay();
  };
  lib.message.client.v3roomexpired = () => {
    displayOverlay("房間已逾時", "房主未在保留期限內返回。本局無法繼續，請重新建立新房間。");
  };
  lib.message.client.v3createblocked = () => {
    displayOverlay(
      "原房間仍被保留",
      "此房間已有未完成的對局。\n本測試版僅支援房主網路斷線後原分頁自動重連；重新整理後的完整遊戲恢復尚未支援。"
    );
  };
  lib.element.ws.onerror = function (error) {
    if (isLiveOwner()) return;
    return defaultOnerror.call(this, error);
  };
  lib.element.ws.onclose = function () {
    if (!this._nocallback && this === game.ws && isLiveOwner()) {
      game.ws = null;
      if (!_status.paused) {
        game.pause();
        pauseOwned = true;
      }
      displayOverlay(
        "房主正在重新連線",
        "已暫停此分頁，其他玩家會看到等待畫面。\n請勿重新整理或關閉分頁。"
      );
      scheduleRetry();
      return;
    }
    return defaultOnclose.call(this);
  };
}
