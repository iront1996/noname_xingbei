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
import {
  inspectLocalRecoveryCandidate,
  getLocalVaultStatus,
  loadLocalCandidateForEngine,
  purgeLocalRecoveryCandidate
} from "./v3-recovery-vault.mjs?v=v3-capture-health-2";
import { evaluateColdOwnerPreflight } from "./v3-host-authority-gate.mjs";
import { buildHostRehydrationBlueprint } from "./v3-rehydration-blueprint.mjs";
import { stageDetachedHostRuntime } from "./v3-host-runtime-stager.mjs";
import { materializeStagedSkillReferences } from "./v3-skill-references.mjs";
import { attachDetachedCardZones } from "./v3-detached-zones.mjs";
import { prepareShadowHostRegistry } from "./v3-host-registry-transaction.mjs";

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
let pausedRoomOnReload = false;
let pendingDetachedColdRuntime = null;
// Short-lived transport continuity proof. NEVER write it to sessionStorage,
// IndexedDB or any persistent store; refreshing destroys the event runtime.
let liveRuntimeRoomId = null;
let liveRuntimeTicket = null;
function rememberLiveRuntimeTicket(roomId, ticket) {
  if (typeof roomId !== "string" || !TOKEN_PATTERN.test(ticket)) return false;
  liveRuntimeRoomId = roomId;
  liveRuntimeTicket = ticket;
  return true;
}
function getLiveRuntimeTicket(roomId) {
  return roomId === liveRuntimeRoomId && TOKEN_PATTERN.test(liveRuntimeTicket)
    ? liveRuntimeTicket : null;
}

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

function displayOverlay(title, body, actionLabel, actionHandler) {
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
    const action = document.createElement("button");
    action.type = "button";
    action.style.cssText =
      "display:none;margin:18px auto 0;border:1px solid #aebed0;" +
      "border-radius:8px;padding:10px 16px;background:#38516b;" +
      "color:#fff;font:inherit;cursor:pointer;";
    panel.append(heading, text, action);
    shadow.append(panel);
    overlay.__v3Heading = heading;
    overlay.__v3Body = text;
    overlay.__v3Action = action;
    document.body.append(overlay);
  }
  overlay.__v3Heading.textContent = title;
  overlay.__v3Body.textContent = body;
  overlay.__v3Action.style.display =
    actionLabel && typeof actionHandler === "function" ? "block" : "none";
  overlay.__v3Action.textContent = actionLabel || "";
  overlay.__v3Action.onclick = actionHandler || null;
}

function isLiveOwner() {
  return Boolean(
    game.onlineroom && !game.online && _status.connectMode &&
    _status.gameStarted && typeof game.roomId === "string"
  );
}

function scheduleRetry() {
  if (retryTimer || !isLiveOwner()) return;
  if (!getToken(game.roomId) || !getLiveRuntimeTicket(game.roomId)) {
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
  const runtimeTicket = getLiveRuntimeTicket(key);
  if (!token || !runtimeTicket) {
    displayOverlay("房主暫時離線", "原分頁執行憑證已遺失，不能直接續行遊戲。");
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
      socket.send(JSON.stringify(["server", "v3resume", key, token, runtimeTicket]));
      return;
    }
    if (msg[0] === "v3ownerresumedHost" && msg[1] === key &&
        TOKEN_PATTERN.test(msg[2]) && TOKEN_PATTERN.test(msg[3])) {
      accepted = true;
      clearTimeout(timeout);
      connecting = false;
      retryCount = 0;
      saveToken(key, msg[2]);
      rememberLiveRuntimeTicket(key, msg[3]);
      game.ws = socket;
      socket.onopen = lib.element.ws.onopen;
      socket.onmessage = lib.element.ws.onmessage;
      socket.onerror = lib.element.ws.onerror;
      socket.onclose = lib.element.ws.onclose;
      // Release peers only after this tab has installed its live message handlers.
      socket.send(JSON.stringify(["server", "v3ready", key, msg[3]]));
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

function installCaptureHealthButton() {
  if (!document.body || document.getElementById("v3-playtest-capture-health")) return;
  const button = document.createElement("button");
  button.id = "v3-playtest-capture-health";
  button.type = "button";
  button.textContent = "V3 測試：檢查本機快照";
  button.style.cssText =
    "position:fixed;bottom:54px;right:14px;z-index:999999;" +
    "border:1px solid #64748b;border-radius:8px;background:#182638;" +
    "color:#f8fafc;padding:8px 12px;font:13px system-ui,sans-serif;" +
    "box-shadow:0 2px 10px #0007;cursor:pointer;display:none;";
  button.addEventListener("click", async () => {
    if (!isLiveOwner()) return;
    const roomId = game.roomId;
    const diagnostic = getLocalVaultStatus(roomId);
    const vault = await inspectLocalRecoveryCandidate(roomId);
    if (!isLiveOwner() || game.roomId !== roomId) return;
    // Status codes and aggregate counts only; never expose hidden cards,
    // encrypted payload, keys or socket/player identifiers.
    const detail = [
      "最近擷取：" + String(diagnostic.status || "NOT_YET_CAPTURED"),
      "原因碼：" + String(diagnostic.code || "NONE"),
      "定期候選：" + String(vault.status),
      "回合邊界候選：" + String(vault.turnBoundaryStatus || "NOT_FOUND"),
      "此資料不包含可續行的事件，不能當成可恢復遊戲的證明。"
    ].join("\n");
    displayOverlay("V3 房主本機快照健康檢查", detail, "關閉", removeOverlay);
  });
  document.body.append(button);
  setInterval(() => {
    button.style.display = isLiveOwner() && game.ws?.readyState === WebSocket.OPEN
      ? "block" : "none";
  }, 1000);
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
  installCaptureHealthButton();
  const defaultRoomlist = lib.message.client.roomlist;
  lib.message.client.roomlist = function (...args) {
    const result = defaultRoomlist.apply(this, args);
    // The engine's reconnect_info may try to recreate a room after a refresh.
    // Query its authenticated status instead of pretending game state survived.
    const key = game.onlineKey;
    const token = typeof key === "string" ? getToken(key) : null;
    if (token && game.ws?.readyState === WebSocket.OPEN) {
      game.send("server", "v3roomstatus", key, token);
    }
    return result;
  };
  lib.message.client.v3roomstatus = async (key, status) => {
    if (key !== game.onlineKey) return;
    if (status === "room_absent") {
      try { sessionStorage.removeItem(TOKEN_PREFIX + key); } catch {}
      pausedRoomOnReload = false;
      pendingDetachedColdRuntime = null;
      liveRuntimeTicket = null;
      liveRuntimeRoomId = null;
      return;
    }
    if (status !== "owner_disconnected") return;
    pausedRoomOnReload = true;
    const vault = await inspectLocalRecoveryCandidate(key);
    const captureDiagnostic = getLocalVaultStatus(key);
    if (!pausedRoomOnReload || key !== game.onlineKey) return;
    // Only an independently verified boundary candidate is needed for this
    // read-only, owner-token-authenticated roster probe. Never call v3resume
    // or v3ready from a refreshed runtime.
    if (vault.turnBoundaryStatus === "ENCRYPTED_CANDIDATE_VERIFIED" &&
        getToken(key) && game.ws?.readyState === WebSocket.OPEN) {
      game.send("server", "v3restoreprobe", key, getToken(key));
    }
    const vaultNotice = vault.turnBoundaryStatus === "ENCRYPTED_CANDIDATE_VERIFIED"
      ? "本機找到約 " + vault.ageSeconds + " 秒前的加密回合邊界候選資料（" +
        vault.playerCount + " 位玩家），但不包含可續行的事件資訊。\\n"
      : vault.status === "ENCRYPTED_CANDIDATE_VERIFIED"
        ? "本機找到定期加密候選資料，但尚無可驗證的回合邊界資料。\\n"
        : vault.status === "NOT_FOUND"
          ? "本機未找到定期加密候選資料。回合邊界狀態：" +
            String(vault.turnBoundaryStatus || "NOT_FOUND") + "。\\n"
          : "本機資料狀態：" + vault.status +
            "，回合邊界：" + String(vault.turnBoundaryStatus || "NOT_FOUND") +
            "（不可直接續局）。\\n";
    const diagnosticNotice = vault.status === "NOT_FOUND" &&
      vault.turnBoundaryStatus !== "ENCRYPTED_CANDIDATE_VERIFIED" ?
      "最近擷取狀態：" + String(captureDiagnostic.status || "NOT_YET_CAPTURED") +
      "（" + String(captureDiagnostic.code || "未記錄原因") + "）\n" : "";
    displayOverlay(
      "原房間仍保留，但無法從重新整理恢復",
      "伺服器尚保留原房間，其他玩家正在等待。\n" +
      vaultNotice + diagnosticNotice +
      "事件續行機制仍在開發，重新整理後不能接續原局。\\n" +
      "你可以結束舊房間，通知其他玩家重新開局。",
      "結束無法恢復的舊房間",
      () => {
        if (!window.confirm("確定結束原房間？其他玩家將收到通知，原局不可恢復。")) return;
        const token = getToken(key);
        if (token && game.ws?.readyState === WebSocket.OPEN) {
          game.send("server", "v3abandon", key, token);
          displayOverlay("正在結束舊房間", "已提出結束請求，正在等待伺服器確認。");
        }
      }
    );
  };
  lib.message.client.v3restoreprobe = async claim => {
    // Read-only preflight. Never restore the engine or lift the pause here.
    const key = claim?.roomId;
    if (!pausedRoomOnReload || typeof key !== "string" ||
        key !== game.onlineKey || !getToken(key)) return;
    const loaded = await loadLocalCandidateForEngine(key, "turn_boundary");
    if (!pausedRoomOnReload || key !== game.onlineKey) return;
    const assessment = loaded.ok
      ? evaluateColdOwnerPreflight(loaded.data, claim)
      : { ok: false, code: loaded.code || "CANDIDATE_NOT_AVAILABLE" };
    // Convert the verified candidate into a private immutable plan. No
    // player entities, DOM cards, or game events are created at this stage.
    const plan = assessment.ok
      ? buildHostRehydrationBlueprint(loaded.data, claim)
      : { ok: false, code: assessment.code };
    // Native Player/Card/NodeWS/Client objects are staged only in an
    // off-document graph. The live engine, global card maps and server room
    // are untouched. Runtime objects must never reach a log or guest client.
    const staged = plan.ok
      ? stageDetachedHostRuntime(plan.blueprint, {
        element: lib.element,
        createFragment: () => document.createDocumentFragment()
      })
      : { ok: false, code: plan.code };
    // Resolve nested references exclusively inside the isolated object
    // graph. Do not register new objects or execute serialized functions.
    const skills = staged.ok
      ? materializeStagedSkillReferences(staged)
      : { ok: false, code: staged.code };
    const zones = skills.ok
      ? attachDetachedCardZones(staged, plan.blueprint)
      : { ok: false, code: skills.code };
    const shadow = zones.ok
      ? prepareShadowHostRegistry(staged, skills, plan.blueprint)
      : { ok: false, code: zones.code };
    // Private in-memory only. No global registry mutation, live card
    // initialization, skill activation, WS transfer or event resume.
    pendingDetachedColdRuntime = shadow.ok
      ? { native: staged.runtime, zones: zones.detachedPiles, registries: shadow.shadow }
      : null;
    const message = shadow.ok
      ? "原玩家 " + shadow.summary.mappedPlayers +
        " 位、卡牌 " + shadow.summary.cards + " 張及遠端連線 " +
        shadow.summary.dormantRemoteClients +
        " 條，已建立隔離對應及影子註冊表。\\n" +
        "但尚未還原事件續行與同步原有玩家畫面，所以本局仍不可解除暫停。"
      : "房主權威引擎重建準備作業未通過。\\n" +
        "原因：" + String(shadow.code || "UNKNOWN") + "。為避免狀態錯亂，此局保持暫停。";
    displayOverlay(
      shadow.ok ? "隔離權威環境準備完成（尚不能續局）" : "房主接管檢查未通過",
      message + "\\n其他玩家仍保持等待，請勿將此畫面視為遊戲已恢復。",
      "結束無法恢復的舊房間",
      () => {
        if (!window.confirm("確定結束原房間？其他玩家將收到通知，原局不可恢復。")) return;
        const token = getToken(key);
        if (token && game.ws?.readyState === WebSocket.OPEN) {
          game.send("server", "v3abandon", key, token);
          displayOverlay("正在結束舊房間", "等待伺服器確認。");
        }
      }
    );
  };
  lib.message.client.v3restoreprobeDenied = code => {
    if (!pausedRoomOnReload) return;
    console.warn("[V3 playtest] host takeover preflight rejected:", String(code).slice(0, 64));
  };
  lib.message.client.v3roomabandonedHost = key => {
    if (key !== game.onlineKey) return;
    try { sessionStorage.removeItem(TOKEN_PREFIX + key); } catch {}
    void purgeLocalRecoveryCandidate(key);
    pausedRoomOnReload = false;
    pendingDetachedColdRuntime = null;
    liveRuntimeTicket = null;
    liveRuntimeRoomId = null;
    displayOverlay(
      "原房間已結束",
      "其他玩家已收到房間結束通知。\n請返回大廳建立新局。",
      "返回大廳",
      () => removeOverlay()
    );
  };
  lib.message.client.v3roomabandoned = () => {
    displayOverlay(
      "房主已結束舊房間",
      "房主先前重新整理而遺失遊戲狀態，已結束等待。\n請返回大廳重新建立房間。"
    );
  };
  const defaultOnclose = lib.element.ws.onclose;
  const defaultOnerror = lib.element.ws.onerror;

  lib.message.client.v3ownerToken = (key, token, runtimeTicket) => {
    if (game.onlineroom && !game.online && game.roomId === key) {
      if (!saveToken(key, token) || !rememberLiveRuntimeTicket(key, runtimeTicket)) {
        liveRuntimeTicket = null;
        liveRuntimeRoomId = null;
        console.warn("[V3 playtest] 房主執行憑證未建立，原分頁斷線續行不可用");
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
    if (pausedRoomOnReload) return;
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
