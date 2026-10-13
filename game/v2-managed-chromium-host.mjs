import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^hs_[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const WAIT_MS = 15000;

let chromium = null;
let profile = null;
let identity = null;
let stopping = false;
let cdp = null;

function createCdpSession(url) {
	if (typeof url !== "string" || !/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/[A-Za-z0-9-]+$/.test(url)) {
		throw new Error("CHROMIUM_CDP_SOCKET_INVALID");
	}
	const socket = new WebSocket(url);
	let sequence = 0;
	const pending = new Map();
	socket.addEventListener("message", event => {
		let message;
		try { message = JSON.parse(event.data); } catch { return; }
		if (!Number.isInteger(message.id) || !pending.has(message.id)) return;
		const entry = pending.get(message.id);
		pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) entry.reject(new Error("CHROMIUM_CDP_REJECTED"));
		else entry.resolve(message.result);
	});
	return {
		async open() {
			if (socket.readyState === WebSocket.OPEN) return;
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("CHROMIUM_CDP_TIMEOUT")), WAIT_MS);
				socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
				socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CHROMIUM_CDP_ERROR")); }, { once: true });
			});
		},
		send(method, params = {}, timeoutMs = WAIT_MS) {
			if (!["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Runtime.evaluate"].includes(method) ||
				socket.readyState !== WebSocket.OPEN || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
				return Promise.reject(new Error("CHROMIUM_CDP_METHOD_DENIED"));
			}
			const id = ++sequence;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); reject(new Error("CHROMIUM_CDP_TIMEOUT")); }, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				socket.send(JSON.stringify({ id, method, params }));
			});
		},
		close() { socket.close(); },
	};
}

async function cleanup() {
	if (stopping) return;
	stopping = true;
	try { cdp?.close(); } catch {}
	if (chromium && chromium.exitCode === null && chromium.signalCode === null) {
		chromium.kill("SIGTERM");
		await Promise.race([
			new Promise(resolve => chromium.once("exit", resolve)),
			new Promise(resolve => setTimeout(resolve, 1500)),
		]);
		if (chromium.exitCode === null && chromium.signalCode === null) chromium.kill("SIGKILL");
	}
	if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}

function validBootstrap(message) {
	return message?.kind === "host_session_bootstrap" && message.protocol === 1 &&
		ROOM_ID.test(message.roomId) && SESSION_ID.test(message.sessionId) && SECRET.test(message.secret);
}

function canonicalize(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new Error("GAME_STATE_INVALID");
}

async function boot(message) {
	if (identity || !validBootstrap(message)) throw new Error("HOST_BOOTSTRAP_INVALID");
	const executable = process.env.V2_CHROMIUM;
	if (typeof executable !== "string" || !path.isAbsolute(executable)) {
		throw new Error("CHROMIUM_EXECUTABLE_INVALID");
	}
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		throw new Error("CHROMIUM_ROOT_SANDBOX_REQUIRED");
	}
	await access(executable, fsConstants.X_OK);
	identity = {
		kind: "managed_host",
		type: "host_browser_ready",
		protocol: message.protocol,
		roomId: message.roomId,
		sessionId: message.sessionId,
		secret: message.secret,
	};
	profile = await mkdtemp(path.join(tmpdir(), "v2-managed-host-"));
	let spawnError = null;
	chromium = spawn(executable, [
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-dev-shm-usage",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"about:blank",
	], { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
	chromium.once("error", () => { spawnError = new Error("CHROMIUM_SPAWN_FAILED"); });
	if (!Number.isSafeInteger(chromium.pid) || chromium.pid <= 0) {
		throw new Error("CHROMIUM_SPAWN_FAILED");
	}
	process.send?.({
		...identity,
		type: "host_resource",
		pid: chromium.pid,
		processGroupId: chromium.pid,
		profile,
	});

	chromium.once("exit", () => {
		if (!stopping) {
			stopping = true;
			const savedProfile = profile;
			profile = null;
			rm(savedProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
				.finally(() => process.exit(20));
		}
	});
	const deadline = Date.now() + WAIT_MS;
	let port = null;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		if (chromium.exitCode !== null || chromium.signalCode !== null) {
			throw new Error("CHROMIUM_EXITED_EARLY");
		}
		try {
			const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
			if (/^\d+$/.test(lines[0]) && /^\/devtools\/browser\/[\w-]+$/.test(lines[1])) {
				port = Number(lines[0]);
				break;
			}
		} catch (error) {
			if (!["ENOENT", "EBUSY", "EACCES"].includes(error.code)) throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 40));
	}
	if (!port) throw new Error("CHROMIUM_BOOT_TIMEOUT");
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
		signal: AbortSignal.timeout(WAIT_MS),
	});
	if (!response.ok) throw new Error("CHROMIUM_CDP_DISCOVERY_FAILED");
	const targets = await response.json();
	const page = targets.find(target => target?.type === "page" && target.url === "about:blank" &&
		typeof target.webSocketDebuggerUrl === "string" &&
		target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`));
	if (!page) {
		throw new Error("CHROMIUM_PAGE_MISSING");
	}
	process.send?.(identity);

	const origin = process.env.V2_GAME_ORIGIN;
	if (origin === undefined) return;
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("ENGINE_ORIGIN_INVALID");
	cdp = createCdpSession(page.webSocketDebuggerUrl);
	await cdp.open();
	await cdp.send("Page.enable");
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
		source: 'Object.defineProperty(window,"isNonameServer",{value:true,writable:false,configurable:false});',
	});
	const navigation = await cdp.send("Page.navigate", { url: `${origin}/v2-managed-host.html` });
	if (navigation.errorText) throw new Error("ENGINE_NAVIGATION_FAILED");
	const engine = await cdp.send("Runtime.evaluate", {
		 expression: `(async()=>{
		 await new Promise(resolve=>document.readyState==='complete'?resolve():addEventListener('load',resolve,{once:true}));
		 if(window.isNonameServer!==true)throw Error('OFFBOARD_FLAG_MISSING');
			 const core=await import('/noname.js');
		 await core.boot();
		 clearTimeout(window.resetGameTimeout);
			 const imported=await import('/mode/xingBei.js');
		 const mode=imported.default();
		 if(!core.game||!core.lib||!core.ui||!core._status||mode.name!=='xingBei'||
		    typeof mode.game?.checkResult!=='function'||
		    typeof mode.game?.checkOnlineResult!=='function'||
		    typeof core.game.randomMapOL!=='function')throw Error('ENGINE_API_MISSING');
		 Object.defineProperty(window,'__v2ManagedEngine',{configurable:false,
		  value:Object.freeze({core,mode})});
		 return {loaded:true,mode:mode.name,offboard:true,
		  nativeGame:typeof core.game.randomMapOL==='function',
		  nativeResult:typeof mode.game.checkResult==='function',gameLoopStarted:false};
		})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const proof = engine.result?.value;
	if (engine.exceptionDetails || proof?.loaded !== true || proof.mode !== "xingBei" ||
		proof.offboard !== true || proof.nativeGame !== true || proof.nativeResult !== true ||
		proof.gameLoopStarted !== false) throw new Error("ENGINE_INITIALIZATION_FAILED");
	process.send?.({ ...identity, type: "host_engine_ready", proof });

	const encodedSetup = JSON.stringify(message.gameSetup);
	const initialized = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{
		 const setup=${encodedSetup};
		 const managed=window.__v2ManagedEngine;
		 const {game,lib,ui,_status}=managed.core;
		 const loading=await import('/noname/init/loading.js');
		 const seen=new Set();
		 const countGameMe=value=>{
		  if(typeof value==='function')return (String(value).match(/game.me/g)||[]).length;
		  if(!value||typeof value!=='object'||seen.has(value))return 0;
		  seen.add(value);return Object.values(value).reduce((sum,item)=>sum+countGameMe(item),0);
		 };
		 const gameMeReferenceCount=countGameMe(managed.mode);
		 if(setup.mode!=='xingBei'||![4,6,8].includes(setup.config.playerCount)||
		    setup.config.playerCount!==setup.seats.length)throw Error('GAME_SETUP_INVALID');
		 lib.config.mode='xingBei';
		 lib.storage={};
		 lib.connectCharacterPack=[];
		 lib.connectCardPack=[];
		 lib.disableCharacterPack=[];
		 loading.loadMode(managed.mode);
		 if(lib.imported.character)Object.values(lib.imported.character).forEach(loading.loadCharacter);
		 loading.loadCardPile();
		 if(lib.imported.card)Object.values(lib.imported.card).forEach(loading.loadCard);
		 lib.configOL=Object.assign({},setup.config,{mode:'xingBei',number:setup.seats.length,
		  player_number:setup.seats.length,versus_mode:setup.seats.length===4?'2v2':setup.seats.length===6?'3v3':'4v4',
		  characterPack:Object.keys(lib.characterPack),banned:[]});
		 _status.connectMode=true;
		 _status.mode=lib.configOL.versus_mode;
		 if(typeof ui.create.table!=='function')ui.create.table=(rows,columns,parent)=>{
		  const table=document.createElement('table');
		  for(let row=0;row<rows;row++){const tr=table.insertRow();for(let column=0;column<columns;column++)tr.insertCell();}
		  parent?.appendChild(table);return table;
		 };
		 if(!ui.arena)ui.create.arena();
		 game.prepareArena(setup.seats.length);
		 if(game.players.length!==setup.seats.length||!_status.prepareArena)throw Error('ARENA_INITIALIZATION_FAILED');
		 lib.playerOL=Object.create(null);
		 for(let index=0;index<setup.seats.length;index++){
		  const expected=setup.seats[index],player=game.players[index];
		  if(Number(player.dataset.position)!==expected.position)throw Error('SEAT_POSITION_MISMATCH');
		  player.playerid=expected.seatId;
		  player.nickname=expected.seatId;
		  lib.playerOL[expected.seatId]=player;
		 }
		 game.me=null;
		 const preGameSummary={kind:'pre_game_verification_v1',mode:managed.mode.name,versusMode:_status.mode,playerCount:game.players.length,
		  seats:game.players.map(player=>({seatId:player.playerid,position:Number(player.dataset.position),dead:false})),
		  nativePlayers:game.players.every(player=>player instanceof lib.element.Player),
		  cardDefinitionCount:Object.keys(lib.card).length,configuredCardCount:lib.card.list.length,
		  hostPlayerAbsent:game.me===null,
		  connectedTransports:game.players.filter(player=>player.ws).length,
		  legacyModeFunctionsRequireGameMe:gameMeReferenceCount>0,gameMeReferenceCount,
		  phaseNumber:Number.isSafeInteger(game.phaseNumber)?game.phaseNumber:0,
		  eventLoopStarted:false,gameOver:Boolean(_status.over)};
		 if(preGameSummary.seats.some((seat,index)=>seat.seatId!==setup.seats[index].seatId||seat.position!==index)||
		    !preGameSummary.nativePlayers||preGameSummary.cardDefinitionCount<=0||preGameSummary.configuredCardCount<=0||
		    !preGameSummary.hostPlayerAbsent||preGameSummary.connectedTransports!==0||
		    !preGameSummary.legacyModeFunctionsRequireGameMe||preGameSummary.gameMeReferenceCount<=0||
		    preGameSummary.eventLoopStarted!==false||preGameSummary.gameOver)throw Error('PRE_GAME_SUMMARY_INVALID');
		 Object.defineProperty(window,'__v2ManagedGame',{configurable:false,
		  value:Object.freeze({setup:Object.freeze(setup),preGameSummary:Object.freeze(preGameSummary),
		   authorityState:{storage:'managed_chromium_memory',revision:0},checkpoint:null})});
		 return preGameSummary;
		})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const preGameSummary = initialized.result?.value;
	if (initialized.exceptionDetails || !preGameSummary || preGameSummary.kind !== "pre_game_verification_v1" ||
		preGameSummary.mode !== "xingBei" || preGameSummary.playerCount !== message.gameSetup.seats.length ||
		preGameSummary.eventLoopStarted !== false || preGameSummary.gameOver !== false ||
		preGameSummary.nativePlayers !== true || preGameSummary.cardDefinitionCount <= 0 ||
		preGameSummary.configuredCardCount <= 0 || preGameSummary.hostPlayerAbsent !== true ||
		preGameSummary.connectedTransports !== 0 || preGameSummary.legacyModeFunctionsRequireGameMe !== true ||
		preGameSummary.gameMeReferenceCount <= 0) {
		throw new Error("GAME_INITIALIZATION_FAILED");
	}
	const preGameSummaryDigest = createHash("sha256").update(canonicalize(preGameSummary)).digest("hex");
	process.send?.({
		...identity,
		type: "host_game_ready",
		proof: {
			kind: "pre_game_verification_v1",
			setupDigest: message.setupDigest,
			preGameSummaryDigest,
			seatIds: preGameSummary.seats.map(seat => seat.seatId),
			checkpoint: null,
		},
	});

	if (process.env.V2_PLAYABLE_PROOF !== "1") return;
	const progressed = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{
		 const managed=window.__v2ManagedEngine,container=window.__v2ManagedGame;
		 const {game,lib,_status}=managed.core;
		 if(game.me!==null||game.players.some(player=>player.ws)||container.checkpoint!==null||
		    container.authorityState.revision!==0)throw Error('NATIVE_EVENT_PRECONDITION_FAILED');
		 lib.configOL.chooseSide=false;
		 lib.configOL.choose_mode='normal';
		 lib.configOL.team_sequence='near';
		 lib.configOL.phaseswap=false;
		 const before={revision:0,firstActSeatId:null,
		  sides:game.players.map(player=>({seatId:player.playerid,side:typeof player.side==='boolean'?player.side:null}))};
		 game.initSideAndPosition(false);
		 const event=_status.event;
		 if(event?.name!=='initSideAndPosition')throw Error('NATIVE_EVENT_MISSING');
		 await game.loop(event);
		 const after={revision:1,firstActSeatId:_status.firstAct?.playerid||null,
		  sides:game.players.map(player=>({seatId:player.playerid,side:player.side}))};
		 const red=after.sides.filter(entry=>entry.side===true).length;
		 const blue=after.sides.filter(entry=>entry.side===false).length;
		 if(!after.firstActSeatId||red!==game.players.length/2||blue!==game.players.length/2||
		    after.sides.some(entry=>typeof entry.side!=='boolean')||game.me!==null||
		    game.players.some(player=>player.ws))throw Error('NATIVE_EVENT_STATE_INVALID');
		 container.authorityState.revision=1;
		 return {eventName:event.name,before,after,hostPlayerAbsent:game.me===null,
		  connectedTransports:game.players.filter(player=>player.ws).length};
		})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const nativeProgress = progressed.result?.value;
	if (progressed.exceptionDetails || nativeProgress?.eventName !== "initSideAndPosition" ||
		nativeProgress.hostPlayerAbsent !== true || nativeProgress.connectedTransports !== 0 ||
		!nativeProgress.before || !nativeProgress.after || nativeProgress.after.revision !== 1) {
		throw new Error("NATIVE_EVENT_EXECUTION_FAILED");
	}
	const beforeDigest = createHash("sha256").update(canonicalize(nativeProgress.before)).digest("hex");
	const afterDigest = createHash("sha256").update(canonicalize(nativeProgress.after)).digest("hex");
	if (beforeDigest === afterDigest) throw new Error("NATIVE_EVENT_NO_PROGRESS");
	process.send?.({
		...identity,
		type: "host_authority_event",
		proof: {
			kind: "native_authority_event_v1",
			checkpoint: null,
			eventSequence: 1,
			stateRevisionBefore: 0,
			stateRevisionAfter: 1,
			beforeDigest,
			afterDigest,
			event: {
				kind: "xingbei_side_assignment_v1",
				name: nativeProgress.eventName,
				firstActSeatId: nativeProgress.after.firstActSeatId,
				sides: nativeProgress.after.sides,
				hostPlayerAbsent: true,
				connectedTransports: 0,
			},
		},
	});

	if (process.env.V2_CHARACTER_SELECTION_PROBE !== "1") return;
	const characterSelection = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{
		 const managed=window.__v2ManagedEngine,container=window.__v2ManagedGame;
		 const {game,lib,_status}=managed.core;
		 if(game.me!==null||container.authorityState.revision!==1||game.players.some(player=>player.ws)){
		  throw Error('CHARACTER_SELECTION_PRECONDITION_FAILED');
		 }
		 // The legacy event uses broadcastAll solely to construct each browser's local
		 // character dialog.  A managed host has no local player view, so suppress just
		 // that presentation callback; all rule/event work remains native Xingbei code.
		 const originalBroadcastAll=game.broadcastAll;
		 const originalInitSideAndPosition=game.initSideAndPosition;
		 const adapter=Object.freeze({kind:'v2_server_control_adapter_v1',humanPlayer:false,
		  suppresses:['character_selection_local_dialog','duplicate_side_assignment']});
		 Object.defineProperty(window,'__v2ServerControl',{configurable:false,value:adapter});
		 let suppressedDialog=false, suppressedSideAssignment=false, selectionEventName=null;
		 // The first broadcast in this exact native event only opens the local browser
		 // character dialog.  Its position is a scoped adapter contract, rather than
		 // brittle inspection of the callback's function text. Any missing or extra
		 // suppression fails the post-event invariant below.
		 let pendingLocalDialogBroadcasts=1;
		 game.broadcastAll=function(fn,...args){
		  if(pendingLocalDialogBroadcasts===1){
		   pendingLocalDialogBroadcasts=0;suppressedDialog=true;return;
		  }
		  return originalBroadcastAll.call(this,fn,...args);
		 };
		 // The native online selection wrapper normally owns side assignment.  It has
		 // already been committed as authority event #1, so it must not run twice.
		 game.initSideAndPosition=function(){suppressedSideAssignment=true;return null;};
		 try{
		  lib.configOL.choose_number='1';
		  game.chooseCharacterOLDuoXuanYi();
		  const event=_status.event;
		  if(event?.name!=='chooseCharacterOL')throw Error('CHARACTER_SELECTION_EVENT_MISSING');
		  selectionEventName=event.name;
		  await game.loop(event);
		  // The original event pauses while its built-in offline trustee path resolves
		  // each seat. Wait for that native asynchronous path rather than inventing a
		  // replacement selection result.
		  const deadline=Date.now()+20000;
		  while(game.players.some(player=>!player.name1)&&Date.now()<deadline){
		   await new Promise(resolve=>setTimeout(resolve,25));
		  }
		 }catch(error){
		  throw Error('CHARACTER_SELECTION_NATIVE_ERROR:'+String(error?.stack||error));
		 }finally{
		  game.broadcastAll=originalBroadcastAll;
		  game.initSideAndPosition=originalInitSideAndPosition;
		 }
		 const before={revision:1,firstActSeatId:_status.firstAct?.playerid||null,
		  sides:game.players.map(player=>({seatId:player.playerid,side:player.side}))};
		 const characters=game.players.map(player=>({seatId:player.playerid,character:player.name1||null}));
		 if(!suppressedDialog||pendingLocalDialogBroadcasts!==0||!suppressedSideAssignment||game.me!==null||game.players.some(player=>player.ws)||
		  characters.some(entry=>typeof entry.character!=='string')||new Set(characters.map(entry=>entry.character)).size!==characters.length){
		  throw Error('CHARACTER_SELECTION_STATE_INVALID:'+JSON.stringify({suppressedDialog,suppressedSideAssignment,gameMe:game.me===null,transports:game.players.filter(player=>player.ws).length,characters}));
		 }
		 const after={revision:2,firstActSeatId:before.firstActSeatId,sides:before.sides,characters};
		 container.authorityState.revision=2;
		 return {eventName:selectionEventName,before,after,characters,hostPlayerAbsent:game.me===null,
		  connectedTransports:game.players.filter(player=>player.ws).length,adapter:adapter.kind};
		})()`,
		awaitPromise: true,
		returnByValue: true,
	}, 45000);
	const selectionProgress = characterSelection.result?.value;
	if (characterSelection.exceptionDetails || selectionProgress?.eventName !== "chooseCharacterOL" ||
		selectionProgress.hostPlayerAbsent !== true || selectionProgress.connectedTransports !== 0 ||
		selectionProgress.adapter !== "v2_server_control_adapter_v1" || !selectionProgress.before ||
		!selectionProgress.after || selectionProgress.after.revision !== 2) {
		throw new Error("CHARACTER_SELECTION_EXECUTION_FAILED");
	}
	const selectionBeforeDigest = createHash("sha256").update(canonicalize(selectionProgress.before)).digest("hex");
	const selectionAfterDigest = createHash("sha256").update(canonicalize(selectionProgress.after)).digest("hex");
	if (selectionBeforeDigest !== afterDigest || selectionBeforeDigest === selectionAfterDigest) {
		throw new Error("CHARACTER_SELECTION_DIGEST_CHAIN_INVALID");
	}
	process.send?.({
		...identity,
		type: "host_authority_event",
		proof: {
			kind: "native_authority_event_v1",
			checkpoint: null,
			eventSequence: 2,
			stateRevisionBefore: 1,
			stateRevisionAfter: 2,
			beforeDigest: selectionBeforeDigest,
			afterDigest: selectionAfterDigest,
			event: {
				kind: "xingbei_character_selection_v1",
				name: selectionProgress.eventName,
				characters: selectionProgress.characters,
				hostPlayerAbsent: true,
				connectedTransports: 0,
			},
		},
	});
}

process.on("message", message => {
	// Bootstrap is the one private launch envelope.  Commands deliberately use
	// `type`, so they can never be mistaken for a second bootstrap.
	if (message?.kind === "host_session_bootstrap") {
		boot(message).catch(async () => {
			await cleanup();
			process.exit(1);
		});
		return;
	}
	if (message?.type === "host_stop") {
		cleanup().finally(() => process.exit(0));
		return;
	}
	// Choice delivery is accepted only after the C2 IPC adapter validates the
	// private host identity inside the managed process. Unknown IPC is inert.
	if (message?.type === "host_choice_delivery" || message?.type === "host_choice_cancel") return;
});

process.on("disconnect", () => cleanup().finally(() => process.exit(0)));
