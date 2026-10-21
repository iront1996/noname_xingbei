"use strict";
(() => {
	const $ = id => document.getElementById(id);
	const state = { socket: null, credential: null, roomId: null, seatId: null, generation: null, lastSequence: 0,
		requestNo: 0, nextRequestId: null, pending: new Map(), currentChoice: null, closed: false, messages: [], lastErrorCode: null,
		testCapability: null, controlUrl: null, lobbyRoomId: null, lobbyRoom: null };
	function text(id, value) { $(id).textContent = String(value); }
	function verifiedChoiceDisplay(message) {
		const display = message?.display, labels = { gongJi: "攻擊", faShu: "法術", unsupported: "合法操作（語意未驗證）" };
		if (!display || display.schema !== "xingbei_v3_managed_choice_display_v1" || display.roomId !== state.roomId ||
			display.actingSeatId !== state.seatId || display.choiceId !== message.choiceId || display.eventSequence !== message.eventSequence ||
			display.connectionGeneration !== state.generation || display.connectionGeneration !== message.connectionGeneration ||
			!/^hs_[a-f0-9]{32}$/.test(display.hostSessionId || "") || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(display.rootInstanceId || "") ||
			!/^native_event_[a-f0-9]{32}$/.test(display.nativeEventId || "") ||
			!/^event_[1-9][0-9]{0,6}$/.test(display.eventInstanceId || "") || !/^event_[1-9][0-9]{0,6}$/.test(display.parentEventInstanceId || "") ||
			!Number.isSafeInteger(display.captureOrdinal) || display.captureOrdinal < 1 ||
			!Number.isSafeInteger(display.nativeCompletionOrdinal) || display.nativeCompletionOrdinal < 1 ||
			!Array.isArray(display.optionItems) || display.optionItems.length !== message.optionIds.length) return null;
		for (let i = 0; i < display.optionItems.length; i++) {
			const item = display.optionItems[i];
			if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).sort().join(",") !==
				"cardViewId,completeness,label,operationKind,optionId,targetSeatId" || item.optionId !== message.optionIds[i] ||
				!Object.hasOwn(labels, item.operationKind) || item.label !== labels[item.operationKind] || item.cardViewId !== null ||
				!((item.completeness === "partial" && item.operationKind !== "unsupported") ||
					(item.completeness === "opaque" && item.operationKind === "unsupported")) ||
				(item.targetSeatId !== null && !/^seat_[a-d]$/.test(item.targetSeatId))) return null;
		}
		return display;
	}
	function lobbyStatus(value) { text("lobby-status", value); }
	async function api(route, { method = "GET", body, roomId } = {}) {
		if (!state.controlUrl || !state.testCapability) throw new Error("LOBBY_TEST_IDENTITY_UNAVAILABLE");
		const url = new URL(`${state.controlUrl}/${route}`);
		if (roomId) url.searchParams.set("roomId", roomId);
		const response = await fetch(url, { method, cache: "no-store", headers: {
			"x-v3-test-capability": state.testCapability, ...(body ? { "content-type": "application/json" } : {})
		}, ...(body ? { body: JSON.stringify(body) } : {}) });
		const value = await response.json();
		if (!response.ok || value?.ok !== true) throw new Error(value?.code || "LOBBY_REQUEST_REJECTED");
		return value;
	}
	function renderLobby(room) {
		state.lobbyRoom = room; state.lobbyRoomId = room?.roomId || state.lobbyRoomId;
		if (state.lobbyRoomId) $("lobby-room-id").value = state.lobbyRoomId;
		text("lobby-seat", state.seatId || "尚未配置");
		const seats = (room?.seatIds || []).map(seatId => {
			const item = document.createElement("article"); item.className = "player";
			const connected = room.connectedSeatIds?.includes(seatId), ready = room.readySeatIds?.includes(seatId);
			item.textContent = `${seatId}｜${connected ? "已加入" : "等待加入"}｜${ready ? "已準備" : "未準備"}`; return item;
		});
		$("lobby-seats").replaceChildren(...seats);
		const hasRoom = Boolean(state.lobbyRoomId), joined = Boolean(room?.connectedSeatIds?.includes(state.seatId));
		$("create-room").disabled = !state.testCapability || state.seatId !== "seat_a" || hasRoom;
		$("join-room").disabled = !state.testCapability || state.seatId === "seat_a" || !hasRoom || joined || room?.state !== "waiting_for_players";
		$("ready").disabled = !joined || room?.state !== "waiting_for_players" || room?.readySeatIds?.includes(state.seatId);
		$("unready").disabled = !joined || !["waiting_for_players", "ready"].includes(room?.state) || !room?.readySeatIds?.includes(state.seatId);
		$("refresh-room").disabled = !hasRoom;
		$("start-room").disabled = true;
		$("start-room").textContent = room?.state === "running" ? "伺服器已啟動遊戲" : "等待伺服器自動啟動";
		$("connect-game").disabled = room?.state !== "running" || !joined;
		$("stop-room").disabled = true;
	}
	async function refreshRoom() {
		if (!state.lobbyRoomId) throw new Error("LOBBY_ROOM_REQUIRED");
		const value = await api("room", { roomId: state.lobbyRoomId }); renderLobby(value.room); return value.room;
	}
	async function joinLobbyRoom() {
		const roomId = state.lobbyRoomId || $("lobby-room-id").value.trim();
		if (!/^room_[a-f0-9]{32}$/.test(roomId)) throw new Error("LOBBY_ROOM_ID_INVALID");
		state.lobbyRoomId = roomId;
		const value = await api("join", { method: "POST", body: { roomId } }); renderLobby(value.room);
		// The API returns only this capability's seat credential. It is held in page
		// memory and is never rendered, persisted in a URL, or shared with other seats.
		const own = await api("seat-credential", { method: "POST", body: { roomId } });
		state.credential = own.credential;
		return value.room;
	}
	async function lobbyAction(control) {
		try {
			if (control === "createRoom") {
				const value = await api("create-room", { method: "POST", body: { config: { mode: "xingBei", playerCount: 4 } } });
				state.lobbyRoomId = value.room.roomId; renderLobby(value.room); await joinLobbyRoom();
				lobbyStatus("房間已建立；建房者 A 只加入普通玩家 seat_a"); return;
			}
			if (control === "joinRoom") { await joinLobbyRoom(); lobbyStatus("本席已加入普通玩家座位"); return; }
			if (control === "ready" || control === "unready") {
				const value = await api(control, { method: "POST", body: { roomId: state.lobbyRoomId } });
				renderLobby(value.room); lobbyStatus(value.room.state === "running" ? "四席已準備；伺服器已啟動原生遊戲" : "準備狀態已由伺服器接受"); return;
			}
			if (control === "refreshRoom") { await refreshRoom(); lobbyStatus("已更新伺服器房間狀態"); return; }
			if (control === "connectGame") { await connectGame(); lobbyStatus("已透過本席憑證連接伺服器主持遊戲"); return; }
			throw new Error("LOBBY_CONTROL_NOT_AVAILABLE");
		} catch (error) { lobbyStatus(`操作未接受：${error.message}`); }
	}
	function send(message) {
		if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error("SOCKET_NOT_OPEN");
		state.socket.send(JSON.stringify(message));
	}
	function request(type, fields = {}) {
		const requestId = state.nextRequestId || `ui_${++state.requestNo}`;
		state.nextRequestId = null;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { state.pending.delete(requestId); reject(new Error("REQUEST_TIMEOUT")); }, 8000);
			state.pending.set(requestId, { resolve, reject, timer, type });
			send({ type, requestId, ...fields });
		});
	}
	function receive(message) {
		state.messages.push(message);
		if (state.messages.length > 64) state.messages.shift();
		if (message.type === "seat_authenticated") {
			if (message.roomId !== state.roomId || message.seatId !== state.seatId || !Number.isSafeInteger(message.connectionGeneration) ||
				!Number.isSafeInteger(message.lastAcknowledgedSequence) || message.lastAcknowledgedSequence < 0) return;
			if (state.generation !== message.connectionGeneration) {
				state.currentChoice = null; $("options").replaceChildren(); text("choice-status", "連線世代已更新；請重新查詢合法操作");
			}
			state.generation = message.connectionGeneration;
			state.lastSequence = message.lastAcknowledgedSequence; state.resumeSequence = message.lastAcknowledgedSequence;
			text("generation", state.generation); text("connection-status", "已驗證普通玩家席位");
			$("read-choice").disabled = false; $("sync-state").disabled = false;
			return;
		}
		if (message.type === "gateway_error") {
			state.lastErrorCode = typeof message.code === "string" ? message.code : "UNKNOWN";
			text("connection-status", `Gateway 拒絕：${message.code || "UNKNOWN"}`);
			if (message.requestId && state.pending.has(message.requestId)) settle(message.requestId, message, true);
			return;
		}
		if (message.type === "transport_acknowledged") {
			text("transport-stage", `已確認 sequence ${message.stateSequence}（generation ${message.connectionGeneration}）`);
			if (message.requestId) settle(message.requestId, message); else settleFirst("state_ack", message);
			return;
		}
		if (message.type === "choice_submission_ack") {
			text("controller-stage", message.accepted ? "Controller 已接受；原生結算與權威提交仍待確認" : "Controller 拒絕");
			text("native-stage", "尚未由此傳輸確認；不可把 Controller ACK 當作原生完成");
			text("authority-stage", "尚未由此傳輸確認；不可把 Transport ACK 當作權威接受");
			if (message.requestId) settle(message.requestId, message);
			return;
		}
		if (message.type === "managed_choice_unavailable") {
			state.currentChoice = null; $("options").replaceChildren(); text("choice-status", "目前沒有提供給本席的合法操作");
			settle(message.requestId, message); return;
		}
		if (message.type === "managed_choice") {
			if (message.seatId !== state.seatId || message.roomId !== state.roomId || message.connectionGeneration !== state.generation ||
				!Array.isArray(message.optionIds) || !message.optionIds.length) return;
			const display = verifiedChoiceDisplay(message);
			state.currentChoice = message;
			text("choice-status", `事件 ${message.eventSequence} 的本席合法操作（截止 ${new Date(message.deadlineAt).toLocaleTimeString()}）`);
			const buttons = message.optionIds.map((optionId, index) => {
				const item = display?.optionItems[index];
				const button = document.createElement("button"); button.type = "button";
				button.textContent = item ? `${item.label}${item.targetSeatId ? `｜目標 ${item.targetSeatId}` : ""}` : `合法操作 ${index + 1}（語意未驗證）`;
				button.dataset.optionId = optionId; button.addEventListener("click", () => void submitChoice(optionId)); return button;
			});
			$("options").replaceChildren(...buttons); settle(message.requestId, message); return;
		}
		if (["xingbei_v3_seat_state_v2", "xingbei_v3_seat_state_v3"].includes(message.schema) && message.recipientSeatId === state.seatId &&
			message.roomId === state.roomId && message.connectionGeneration === state.generation &&
			Number.isSafeInteger(message.stateSequence) && message.stateSequence > state.lastSequence &&
			message.privateState?.seatId === state.seatId) {
			state.lastSequence = message.stateSequence;
			text("room-view", message.roomId); text("active-seat", message.publicState?.activeSeatId ?? "目前狀態投影尚未提供");
			text("phase", message.publicState?.phase ?? "目前狀態投影尚未提供");
			text("authority-revision", "此投影尚未提供（state sequence 不是 authority revision）");
			const displayCards = message.schema === "xingbei_v3_seat_state_v3" &&
				message.privateState?.schema === "xingbei_v3_private_hand_display_v1" && message.privateState.seatId === state.seatId;
			if (displayCards) {
				const items = message.privateState.cards.map(card => {
					const item = document.createElement("article"); item.className = "player hand-card";
					item.textContent = `${card.name} · ${card.xiBie}`; item.dataset.viewId = card.viewId;
					item.dataset.cardName = card.name; item.dataset.xiBie = card.xiBie; return item;
				});
				$("own-cards").replaceChildren(...items);
				text("private-view", `本席已驗證實體手牌（${items.length} 張；有序展示）`);
			} else {
				const cards = message.privateState.handCardViewIds;
				text("private-view", `本席卡牌展示資料未提供；opaque hand-view IDs（共 ${cards.length} 個）`);
				$("own-cards").replaceChildren();
			}
			const resources = message.publicState.resources;
			text("resources", `公共資源（已驗證投影）：紅方士氣 ${resources.hongShiQi}／星杯 ${resources.hongXingBei}／寶石 ${resources.hongBaoShiCount}／水晶 ${resources.hongShuiJingCount}；藍方士氣 ${resources.lanShiQi}／星杯 ${resources.lanXingBei}／寶石 ${resources.lanBaoShiCount}／水晶 ${resources.lanShuiJingCount}`);
			const players = (message.publicState.players || []).map(player => {
				const card = document.createElement("article"); card.className = "player";
				card.textContent = `${player.seatId}｜${player.characterId ?? "角色投影未提供"}｜${player.side === null ? "陣營未提供" : player.side ? "紅方" : "藍方"}｜手牌數 ${player.handCount}`; return card;
			});
			$("players").replaceChildren(...players);
			$("capped-notice").hidden = true;
			send({ type: "state_ack", stateSequence: message.stateSequence });
			settleFirst("state_read", message); return;
		}
		if (message.schema === "xingbei_v3_capped_readonly_state_v1" && message.recipientSeatId === state.seatId &&
			message.roomId === state.roomId && message.connectionGeneration === state.generation) {
			state.currentChoice = null;
			text("room-view", message.roomId); text("authority-revision", message.authorityRevision);
			$("capped-notice").hidden = false; $("read-choice").disabled = true; $("options").replaceChildren();
			text("choice-status", "實驗事件上限已達；只允許唯讀同步");
			send({ type: "state_ack", stateSequence: message.stateSequence });
			settleFirst("state_read", message); return;
		}
		if (message.requestId && state.pending.has(message.requestId)) settle(message.requestId, message);
	}
	function settle(id, value, failed = false) {
		const item = state.pending.get(id); if (!item) return;
		clearTimeout(item.timer); state.pending.delete(id); failed ? item.reject(new Error(value.code || "REQUEST_REJECTED")) : item.resolve(value);
	}
	function settleFirst(type, value) {
		for (const [id, item] of state.pending) if (item.type === type) { settle(id, value); return; }
	}
	async function readState() {
		text("connection-status", "正在同步受驗證狀態…");
		const view = await request("state_read", { lastSeenSequence: state.lastSequence });
		if (view.type === "gateway_error") throw new Error(view.code);
		if (view.type === "transport_acknowledged") return view;
		return view;
	}
	async function submitChoice(optionId) {
		if (!state.currentChoice || !state.currentChoice.optionIds.includes(optionId)) return;
		for (const button of $("options").querySelectorAll("button")) button.disabled = true;
		text("choice-status", "已送出；等待 Controller 回覆（不是原生或權威成功）");
		try {
			await request("choice_submit", { choiceId: state.currentChoice.choiceId, optionId });
		} catch (error) { text("choice-status", `結果未確認：${error.message}；請同步狀態，不要盲目重送`); }
	}
	function connect(url, roomId, seatId, credential) {
		if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url) || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId) ||
			!/^seat_[a-d]$/.test(seatId) || !/^[a-f0-9]{64}$/.test(credential)) throw new Error("GAME_CONNECTION_INPUT_REJECTED");
		state.currentChoice = null; $("options").replaceChildren();
		state.roomId = roomId; state.seatId = seatId; state.credential = credential;
		$("gateway-url").value = url; $("room-id").value = roomId; $("seat-id").value = seatId; $("seat-credential").value = "";
		text("connection-status", "連線中…");
		if (state.socket) try { state.socket.close(); } catch (_) {}
		const socket = new WebSocket(url); state.socket = socket;
		socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "seat_auth", roomId, seatId, credential: state.credential })));
		socket.addEventListener("message", event => { try { receive(JSON.parse(event.data)); } catch (_) { text("connection-status", "收到無法解讀的訊息"); } });
		socket.addEventListener("close", () => { if (state.socket === socket) { text("connection-status", "已中斷；重新認證本席可重連"); $("read-choice").disabled = true; } });
		socket.addEventListener("error", () => text("connection-status", "WebSocket 連線錯誤"));
		return true;
	}
	async function connectGame() {
		if (!state.lobbyRoomId || !state.seatId) throw new Error("GAME_ROOM_NOT_READY");
		const [credential, gateway] = await Promise.all([
			state.credential ? Promise.resolve({ credential: state.credential }) : api("seat-credential", { method: "POST", body: { roomId: state.lobbyRoomId } }),
			api("gateway", { roomId: state.lobbyRoomId })
		]);
		return connect(gateway.url, state.lobbyRoomId, state.seatId, credential.credential);
	}
	for (const [id, control] of [["create-room", "createRoom"], ["join-room", "joinRoom"], ["ready", "ready"],
		["unready", "unready"], ["refresh-room", "refreshRoom"], ["connect-game", "connectGame"]])
		$(id).addEventListener("click", () => void lobbyAction(control));
	$("lobby-room-id").addEventListener("input", () => {
		if (state.seatId !== "seat_a") state.lobbyRoomId = $("lobby-room-id").value.trim();
		$("join-room").disabled = !state.testCapability || state.seatId === "seat_a" || !/^room_[a-f0-9]{32}$/.test(state.lobbyRoomId || "");
	});
	$("connect-form").addEventListener("submit", event => {
		event.preventDefault();
		const url = $("gateway-url").value, roomId = $("room-id").value, seatId = $("seat-id").value;
		const credential = $("seat-credential").value;
		try { connect(url, roomId, seatId, credential); } catch (error) { text("connection-status", `輸入格式不合法：${error.message}`); }
	});
	$("disconnect").addEventListener("click", () => { state.credential = null; state.socket?.close(); });
	$("read-choice").addEventListener("click", () => void request("choice_read").catch(error => text("choice-status", error.message)));
	$("sync-state").addEventListener("click", () => void readState().catch(error => text("connection-status", `狀態同步未確認：${error.message}`)));
	window.v3TestClient = Object.freeze({
		configureHarness({ seatId, capability, controlUrl, roomId = null }) {
			if (!/^seat_[a-d]$/.test(seatId || "") || !/^[a-f0-9]{64}$/.test(capability || "") ||
				!/^http:\/\/127\.0\.0\.1:\d+\/api$/.test(controlUrl || "")) throw new Error("LOBBY_TEST_CONFIG_REJECTED");
			state.seatId = seatId; state.testCapability = capability; state.controlUrl = controlUrl; state.lobbyRoomId = roomId;
			text("lobby-seat", seatId); $("create-room").disabled = seatId !== "seat_a";
			$("join-room").disabled = seatId === "seat_a"; $("refresh-room").disabled = !roomId;
			$("lobby-room-id").value = roomId || ""; lobbyStatus("隔離測試身分已配置；尚未連線至遊戲");
			if (roomId) void refreshRoom().catch(error => lobbyStatus(`房間同步未確認：${error.message}`));
			return true;
		},
		configureRoom(roomId) { if (!/^room_[a-f0-9]{32}$/.test(roomId || "")) throw new Error("LOBBY_ROOM_ID_INVALID"); state.lobbyRoomId = roomId; $("lobby-room-id").value = roomId; void refreshRoom().catch(error => lobbyStatus(`房間同步未確認：${error.message}`)); return true; },
		clickControl(control) { const ids = { createRoom: "create-room", joinRoom: "join-room", ready: "ready", unready: "unready", refreshRoom: "refresh-room", connectGame: "connect-game" }; const id = ids[control]; if (!id || $(id).disabled) throw new Error("LOBBY_CONTROL_NOT_AVAILABLE"); $(id).click(); return true; },
		connectGame,
		connect({ url, roomId, seatId, credential }) {
			return connect(url, roomId, seatId, credential);
		},
		disconnect() { $("disconnect").click(); },
		// Test automation uses the UI's actual guarded submit handler whenever a legal option is displayed.
		async submitThroughUi(message) {
			if (message.type === "choice_submit" && state.currentChoice?.choiceId === message.choiceId &&
				state.currentChoice.optionIds.includes(message.optionId)) {
				const button = [...$("options").querySelectorAll("button")].find(item => item.dataset.optionId === message.optionId);
				if (button && !button.disabled) { state.nextRequestId = message.requestId; button.click(); return true; }
			}
			send(message); return true;
		},
		sendProtocol(message) { send(message); return true; },
		drainMessages() { const batch = state.messages; state.messages = []; return batch; },
		state() { return { seatId: state.seatId, generation: state.generation, lastSequence: state.lastSequence, resumeSequence: state.resumeSequence ?? 0,
			connected: state.socket?.readyState === WebSocket.OPEN, choiceVisible: Boolean(state.currentChoice),
			lobbyRoomId: state.lobbyRoomId, lobbyStatus: $("lobby-status").textContent, lobbyRoom: state.lobbyRoom,
		ownCardNames: [...$("own-cards").children].map(item => item.dataset.cardName),
		ownCardXiBie: [...$("own-cards").children].map(item => item.dataset.xiBie),
		ownCardLabels: [...$("own-cards").children].map(item => item.textContent),
		choiceLabels: [...$("options").querySelectorAll("button")].map(item => item.textContent),
		choiceOptionIds: [...$("options").querySelectorAll("button")].map(item => item.dataset.optionId),
		choiceDisplaySchema: state.currentChoice?.display?.schema || null,
		publicActiveSeat: $("active-seat").textContent, publicPhase: $("phase").textContent,
		publicResources: $("resources").textContent, publicPlayers: [...$("players").children].map(item => item.textContent),
			controllerText: $("controller-stage").textContent, nativeText: $("native-stage").textContent,
			authorityText: $("authority-stage").textContent, capped: !$("capped-notice").hidden, lastErrorCode: state.lastErrorCode }; },
	});
})();
