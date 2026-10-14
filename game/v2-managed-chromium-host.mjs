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
let interactiveChoice = null;
let choiceCommandChain = Promise.resolve();
let choiceDiagnosticTimer = null;
const nativeStartDiagnosticRing = [];
let nativeStartDiagnosticUnsubscribe = null;

function createCdpSession(url) {
	if (typeof url !== "string" || !/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/[A-Za-z0-9-]+$/.test(url)) {
		throw new Error("CHROMIUM_CDP_SOCKET_INVALID");
	}
	const socket = new WebSocket(url);
	let sequence = 0;
	const pending = new Map();
	const listeners = new Set();
	socket.addEventListener("message", event => {
		let message;
		try { message = JSON.parse(event.data); } catch { return; }
		if (typeof message.method === "string") {
			for (const listener of listeners) {
				try { listener(message); } catch {}
			}
			return;
		}
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
			const diagnosticMethod = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				["Runtime.enable", "Runtime.addBinding"].includes(method);
			if (!(diagnosticMethod || ["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Runtime.evaluate"].includes(method)) ||
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
		onEvent(listener) {
			if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || typeof listener !== "function") throw new Error("CDP_EVENT_OBSERVER_DENIED");
			listeners.add(listener);
			return () => listeners.delete(listener);
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
		 const {game,lib,ui,get,_status}=managed.core;
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
		 // Mirror the initialization performed by noname/init/onload.js before the
		 // native gameDraw event reaches Player.directgain.
		 lib.config.sort_card=get.sortCard(lib.config.sort);
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
		  characterPack:Object.keys(lib.characterPack),banned:[],bannedcards:[]});
		 lib.config.bannedcards??=[];
		 _status.connectMode=true;
		 _status.mode=lib.configOL.versus_mode;
		 if(typeof ui.create.table!=='function')ui.create.table=(rows,columns,parent)=>{
		  const table=document.createElement('table');
		  for(let row=0;row<rows;row++){const tr=table.insertRow();for(let column=0;column<columns;column++)tr.insertCell();}
		  parent?.appendChild(table);return table;
		 };
		 if(!ui.arena)ui.create.arena();
		 game.prepareArena(setup.seats.length);
		 // Normal startup defers ui.create.cardsAsync() through the global onfree
		 // queue. A managed headless room has no free-screen transition, so execute
		 // only that native card-pile initialization callback now.
		 if(_status.waitingForCards){const args=_status.waitingForCards;delete _status.waitingForCards;ui.create.cards.apply(ui.create,args)}
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
		throw new Error(`GAME_INITIALIZATION_FAILED:${initialized.exceptionDetails?.text || JSON.stringify(preGameSummary)}`);
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

	if (process.env.V2_MANAGED_CHOICE_IPC === "1") {
		await runManagedNativeChoice();
		return;
	}

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

function validHostCommand(message) {
	return message?.kind === "managed_host" && message.protocol === identity?.protocol &&
		message.roomId === identity?.roomId && message.sessionId === identity?.sessionId &&
		message.secret === identity?.secret;
}

async function runManagedNativeChoice() {
	const nativeEventId = `native_${identity.sessionId.slice(3)}_character_selection`;
	const prepared = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{
		 const managed=window.__v2ManagedEngine,container=window.__v2ManagedGame;
		 const {game,lib,_status}=managed.core;
		 if(game.me!==null||container.authorityState.revision!==1||game.players.some(player=>player.ws))throw Error('MANAGED_CHOICE_PRECONDITION_FAILED');
		 const originalBroadcastAll=game.broadcastAll,originalInit=game.initSideAndPosition,originalSetTimeout=globalThis.setTimeout;
		 let dialogBroadcasts=0,capturedTrusteeSchedule=false,coordinateNativeTrustee=true;
		 game.broadcastAll=function(fn,...args){if(dialogBroadcasts++===0)return;return originalBroadcastAll.call(this,fn,...args)};
		 game.initSideAndPosition=function(){return null};
		 // This adapter recognizes the selection event's explicit coordination state,
		 // not a magic delay or callback source text.  It captures exactly its one
		 // deferred offline-trustee schedule while server choices are pending.
		 globalThis.setTimeout=function(fn,delay,...args){
		  const current=_status.event;
		  if(coordinateNativeTrustee&&!capturedTrusteeSchedule&&current?.name==='chooseCharacterOL'&&
		     current.ai_targets?.length===game.players.length){capturedTrusteeSchedule=true;return 0}
		  return originalSetTimeout(fn,delay,...args)
		 };
		 try{
		  lib.configOL.choose_number='2'; game.chooseCharacterOLDuoXuanYi(); const event=_status.event;
		  if(event?.name!=='chooseCharacterOL')throw Error('MANAGED_CHOICE_EVENT_MISSING');
		  window.__v2ManagedChoiceState={event,nativeEventId:${JSON.stringify(nativeEventId)},applied:new Set()};
		  // The native event intentionally pauses at step 4 while the managed
		  // controller owns its choices. Starting (rather than awaiting) the loop
		  // exposes its genuine candidate set without waiting for a human UI.
		  game.loop(event); await new Promise(resolve=>originalSetTimeout(resolve,0));
		  const choices=game.players.map(player=>({seatId:player.playerid,options:[...(game._characterChoice[player.playerid]||[])]}));
		  coordinateNativeTrustee=false;
		  if(!capturedTrusteeSchedule||dialogBroadcasts!==1||choices.some(choice=>choice.options.length<2))throw Error('MANAGED_CHOICE_CANDIDATES_INVALID');
		  return {choices,before:{revision:1,firstActSeatId:_status.firstAct?.playerid||null,sides:game.players.map(player=>({seatId:player.playerid,side:player.side}))}};
		 }finally{game.broadcastAll=originalBroadcastAll;game.initSideAndPosition=originalInit;globalThis.setTimeout=originalSetTimeout}
		})()`, awaitPromise: true, returnByValue: true,
	}, 45000);
	const value = prepared.result?.value;
	if (prepared.exceptionDetails || !Array.isArray(value?.choices) || value.choices.length < 2 || value.choices.some(choice => !Array.isArray(choice.options) || choice.options.length < 2)) {
		throw new Error("MANAGED_CHOICE_PREPARE_FAILED");
	}
	interactiveChoice = { nativeEventId, before: value.before, choices: new Map(value.choices.map(choice => [choice.seatId, choice])), deliveries: new Map(), completed: null, resolve: null, reject: null };
	choiceDiagnosticTimer = setTimeout(() => emitManagedChoiceDiagnostic(), 5000);
	process.send?.({ ...identity, type: "host_choice_candidates", nativeEventId, eventSequence: 2, choices: value.choices, deadlineMs: 1000 });
	const completed = await new Promise((resolve, reject) => { interactiveChoice.resolve = resolve; interactiveChoice.reject = reject; });
	const beforeDigest = createHash("sha256").update(canonicalize(completed.before)).digest("hex");
	const afterDigest = createHash("sha256").update(canonicalize(completed.after)).digest("hex");
	if (beforeDigest === afterDigest) throw new Error("MANAGED_CHOICE_NO_PROGRESS");
	process.send?.({ ...identity, type: "host_authority_event", proof: { kind: "native_authority_event_v1", checkpoint: null,
		eventSequence: 2, stateRevisionBefore: 1, stateRevisionAfter: 2, beforeDigest, afterDigest,
		event: { kind: "xingbei_character_selection_v1", name: "chooseCharacterOL", characters: completed.after.characters,
			hostPlayerAbsent: true, connectedTransports: 0 } } });
}

async function applyManagedChoice(message) {
	if (!interactiveChoice || !validHostCommand(message) || message.nativeEventId !== interactiveChoice.nativeEventId ||
		typeof message.deliveryId !== "string" || typeof message.choiceId !== "string" || typeof message.seatId !== "string" ||
		typeof message.resolution?.option !== "string" || !interactiveChoice.choices.has(message.seatId)) return;
	const applied = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{const state=window.__v2ManagedChoiceState,payload=${JSON.stringify({ deliveryId: message.deliveryId, seatId: message.seatId, option: message.resolution.option })};
		if(!state||state.nativeEventId!==${JSON.stringify(interactiveChoice.nativeEventId)})throw Error('MANAGED_CHOICE_STATE_MISSING');
		if(state.applied.has(payload.deliveryId))return {duplicate:true,completed:false};
		const {game,_status}=window.__v2ManagedEngine.core,event=state.event,player=game.players.find(item=>item.playerid===payload.seatId);
		if(!player||!game._characterChoice[payload.seatId]?.includes(payload.option)||event._choiceMap[payload.seatId])throw Error('MANAGED_CHOICE_DELIVERY_INVALID');
		event.sendback({result:true,links:[payload.option]},player);state.applied.add(payload.deliveryId);
		if(state.applied.size!==game.players.length)return {duplicate:false,completed:false};
		game.resume();const deadline=Date.now()+5000;while(game.players.some(item=>!item.name1)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
		const before={revision:1,firstActSeatId:_status.firstAct?.playerid||null,sides:game.players.map(item=>({seatId:item.playerid,side:item.side}))};
		const characters=game.players.map(item=>({seatId:item.playerid,character:item.name1||null}));
		if(characters.some(item=>typeof item.character!=='string')||new Set(characters.map(item=>item.character)).size!==characters.length||game.me!==null||game.players.some(item=>item.ws))throw Error('MANAGED_CHOICE_APPLY_FAILED');
		return {duplicate:false,completed:true,before,after:{revision:2,firstActSeatId:before.firstActSeatId,sides:before.sides,characters}}})()`, awaitPromise: true, returnByValue: true,
	}, 15000);
	const result = applied.result?.value;
	if (applied.exceptionDetails || !result) throw new Error("MANAGED_CHOICE_APPLY_FAILED");
	if (result.duplicate && interactiveChoice.completed) {
		const prior = interactiveChoice.deliveries.get(message.seatId);
		if (!prior || prior.choiceId !== message.choiceId || prior.deliveryId !== message.deliveryId || prior.option !== message.resolution.option) {
			throw new Error("MANAGED_CHOICE_DUPLICATE_CONFLICT");
		}
		process.send?.({ ...identity, type: "host_choice_ack", seatId: message.seatId, choiceId: prior.choiceId, deliveryId: prior.deliveryId, nativeEventId: message.nativeEventId });
		return;
	}
	interactiveChoice.deliveries.set(message.seatId, Object.freeze({ choiceId: message.choiceId, deliveryId: message.deliveryId, option: message.resolution.option }));
	if (!result.completed || interactiveChoice.completed) return;
	// Native step 5 has now initialized every Player.  ACK each immutable delivery
	// only after matching its final native role; a sendback call alone is not proof.
	for (const entry of result.after.characters) {
		const delivery = interactiveChoice.deliveries.get(entry.seatId);
		if (!delivery || delivery.option !== entry.character) throw new Error("MANAGED_CHOICE_NATIVE_RESULT_MISMATCH");
	}
	if (interactiveChoice.deliveries.size !== result.after.characters.length) throw new Error("MANAGED_CHOICE_ACK_INCOMPLETE");
	interactiveChoice.completed = result;
	if (choiceDiagnosticTimer) { clearTimeout(choiceDiagnosticTimer); choiceDiagnosticTimer = null; }
	for (const [seatId, delivery] of interactiveChoice.deliveries) process.send?.({ ...identity, type: "host_choice_ack", seatId, choiceId: delivery.choiceId, deliveryId: delivery.deliveryId, nativeEventId: message.nativeEventId });
	interactiveChoice.resolve(result);
}

async function emitManagedChoiceDiagnostic() {
	if (!interactiveChoice || interactiveChoice.completed || !cdp) return;
	try {
		const observed = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2ManagedChoiceState,e=s?.event,g=window.__v2ManagedEngine?.core?.game;
		return {eventName:e?.name||null,eventStep:Number.isSafeInteger(e?.step)?e.step:null,choiceMapCount:Object.keys(e?._choiceMap||{}).length,
		appliedDeliveryCount:s?.applied?.size??null,resumed:!window.__v2ManagedEngine?.core?._status?.paused,
		players:(g?.players||[]).map(p=>({seatId:p.playerid,initialized:typeof p.name1==='string'}))}})()`, returnByValue: true });
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice.nativeEventId,
			deliveries: [...interactiveChoice.deliveries.values()].map(value => ({ choiceId: value.choiceId, deliveryId: value.deliveryId })), observed: observed.result?.value || null });
	} catch { process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice.nativeEventId, deliveries: [], observed: null }); }
}

function emitNativeStartDiagnostic(observed) {
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !observed || typeof observed !== "object") return;
	const entry = Object.freeze({ at: Date.now(), ...observed });
	nativeStartDiagnosticRing.push(entry);
	if (nativeStartDiagnosticRing.length > 128) nativeStartDiagnosticRing.shift();
	process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice?.nativeEventId || null,
		observed: { kind: "native_start_diagnostic", ...entry } });
}

async function runNativeStartDiagnostic(message) {
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !interactiveChoice?.completed || !validHostCommand(message) ||
		!cdp || !["native_start", "managed_start", "managed_input_gate", "controlled_block"].includes(message.mode)) throw new Error("NATIVE_START_DIAGNOSTIC_REJECTED");
	if (!nativeStartDiagnosticUnsubscribe) {
		await cdp.send("Runtime.enable");
		await cdp.send("Runtime.addBinding", { name: "__v2NativeStartTrace" });
		nativeStartDiagnosticUnsubscribe = cdp.onEvent(event => {
			if (event.method !== "Runtime.bindingCalled" || event.params?.name !== "__v2NativeStartTrace" ||
				typeof event.params.payload !== "string" || event.params.payload.length > 8192) return;
			try {
				const payload = JSON.parse(event.params.payload);
				if (payload?.kind !== "native_start_trace_v1" || typeof payload.stage !== "string" ||
					!payload.snapshot || typeof payload.snapshot !== "object") return;
				emitNativeStartDiagnostic({ stage: payload.stage, snapshot: payload.snapshot });
			} catch {}
		});
	}
	const install = `(()=>{
	 const managedInputGate=${message.mode === "managed_input_gate"};
	 const managedStart=${message.mode === "managed_start" || message.mode === "managed_input_gate"};
	 const managed=window.__v2ManagedEngine,{game,lib,get,_status}=managed.core,manager=_status.eventManager,Player=lib.element.Player;
	 const state=window.__v2NativeStartDiagnosticState||{traceCount:0,lastSuccessfulEventStep:null,gameStartCount:0,drawCreated:false,drawEntered:false,phaseLoopCreated:false,prepareArenaCalls:0,waitForPlayerCalls:0,randomMapOLCalls:0,chooseCharacterCalls:0,phaseCalls:0,rootPromiseState:'not_started',failureCode:null};
	 window.__v2NativeStartDiagnosticState=state;
	 const snapshot=()=>{const current=_status.event,top=manager.eventStack.at(-1),phaseLoop=state.phaseLoop,phaseEvent=phaseLoop?.next?.find(event=>event.name==='phase'&&event.player===_status.firstAct);return {eventName:current?.name||null,eventStep:Number.isSafeInteger(current?.step)?current.step:null,parentEventName:current?.parent?.name||null,rootEventName:manager.rootEvent?.name||null,eventStackDepth:manager.eventStack.length,eventStackTop:top?.name||null,eventStack:manager.eventStack.map(event=>event.name),connectMode:Boolean(_status.connectMode),paused:Boolean(_status.paused),gameStartTriggered:state.gameStartCount>0,gameStartCount:state.gameStartCount,gameDrawCreated:state.drawCreated,gameDrawEntered:state.drawEntered,gameDrawParentName:state.drawParentName||null,phaseLoopCreated:state.phaseLoopCreated,phaseLoopParentName:state.phaseLoopParentName||null,firstPhaseEventName:phaseEvent?.name||null,firstPhaseParentName:phaseEvent?.parent?.name||null,firstPhaseGate:state.firstPhaseGate||null,nativeInputGate:state.nativeInputGate||null,prepareArenaCalls:state.prepareArenaCalls,waitForPlayerCalls:state.waitForPlayerCalls,randomMapOLCalls:state.randomMapOLCalls,chooseCharacterCalls:state.chooseCharacterCalls,phaseCalls:state.phaseCalls,currentPhaseSeatId:_status.currentPhase?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,pendingChoiceEventName:/choose|respond|useCard/i.test(current?.name||'')?current.name:null,pendingChoiceSeatId:current?.player?.playerid||null,hostPlayerAbsent:game.me===null,seats:game.players.map(player=>({seatId:player.playerid||null,characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')})),lastSuccessfulEventStep:state.lastSuccessfulEventStep,rootPromiseState:state.rootPromiseState,failureCode:state.failureCode,traceCount:state.traceCount}};
	 const ring=state.ring||(state.ring=[]);let emittedMilestones=0,emittedSteps=0,lastEventStepToken='';
	 const emit=stage=>{state.traceCount++;const snap=snapshot();ring.push({stage,snapshot:snap});if(ring.length>128)ring.shift();const token=[snap.eventName,snap.eventStep].join(':');const milestone=new Set(['root_event_created','root_start_dispatched','wait_for_player_called','random_map_ol_called','prepare_arena_called','choose_character_called','game_start_trigger','game_draw_called','phase_loop_called','phase_called','native_input_gate','root_promise_fulfilled','root_promise_rejected','wait_next_error']).has(stage);const changedStep=token!==lastEventStepToken;lastEventStepToken=token;if(milestone){if(emittedMilestones++>=64)return}else if(changedStep){if(emittedSteps++>=64)return}else return;const payload={kind:'native_start_trace_v1',stage,snapshot:snap};try{window.__v2NativeStartTrace(JSON.stringify(payload))}catch{}};
	 if(!state.instrumented){
	  state.instrumented=true;
	  const GameEvent=lib.element.GameEvent,originalWaitNext=GameEvent.prototype.waitNext,originalLoop=GameEvent.prototype.loop,originalTrigger=GameEvent.prototype.trigger,originalCreateEvent=game.createEvent,originalWaitForPlayer=game.waitForPlayer,originalPrepareArena=game.prepareArena,originalChooseCharacter=game.chooseCharacter,originalRandomMapOL=game.randomMapOL,originalDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop,originalPhase=Player.prototype.phase;
	  const observeNativeInputGate=event=>{const player=event.player,options=new Map();let cardFilterPassed=0,targetFilterPassed=0,filterErrors=0,unsupportedCardShapes=0;const rangeIsOne=value=>Array.isArray(value)?value[0]===1&&value[1]===1:value===1;const actionCardRange=get.select(event.selectCard),eventShapeSupported=rangeIsOne(actionCardRange)&&rangeIsOne(get.select(event.selectTarget))&&!event.filterOk&&!Object.values(event.custom?.add||{}).some(value=>typeof value==='function')&&!Object.values(event.custom?.replace||{}).some(value=>typeof value==='function');for(const card of player.getCards(event.position||'h')){try{if(!eventShapeSupported||typeof event.filterCard!=='function'||!event.filterCard(card,player,event))continue;cardFilterPassed++;const info=get.info(get.autoViewAs(card));if(!info||info.complexSelect||info.complexTarget||info.multitarget||info.singleCard||typeof info.selectTarget==='function'){unsupportedCardShapes++;continue}const targetRange=info.selectTarget===undefined?(info.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(!rangeIsOne(targetRange)){unsupportedCardShapes++;continue}for(const target of game.players){try{if(event.filterTarget?.(card,player,target)&&lib.filter.targetEnabled(card,player,target)){targetFilterPassed++;const optionId='probe_option_'+(options.size+1);options.set(optionId,Object.freeze({card,target,event,seatId:player.playerid}))}}catch{filterErrors++}}}catch{filterErrors++}}window.__v2ManagedNativeActionOptions=options;state.nativeInputGate={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:player.playerid,action:Boolean(event.action),handCount:player.countCards('h'),nativeCardFilterPassCount:cardFilterPassed,nativeTargetFilterPassCount:targetFilterPassed,opaqueProbeOptionCount:options.size,supportedOptionShape:'one-native-physical-card-one-native-target',eventShapeSupported,unsupportedCardShapes,filterErrors,gateBeforeAiBranch:true,offlineAiPrevented:true,nativeAiResultPending:event.result==='ai',eventIsMine:Boolean(event.isMine()),eventIsOnline:Boolean(event.isOnline()),gameMeAbsent:game.me===null};emit('native_input_gate')};
	  GameEvent.prototype.waitNext=function(...args){const event=this;if(event.name==='gameDraw')state.drawEntered=true;emit('wait_next_begin');return originalWaitNext.apply(this,args).then(value=>{state.lastSuccessfulEventStep={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null};emit('wait_next_end');return value},error=>{state.failureCode='NATIVE_WAIT_NEXT_REJECTED';emit('wait_next_error');throw error})};
	  GameEvent.prototype.loop=function(...args){if(managedInputGate&&!state.nativeInputGate&&this.name==='gongJiOrFaShu'&&this.player===_status.firstAct&&this.action===true){observeNativeInputGate(this);game.pause();return new Promise(()=>{})}return originalLoop.apply(this,args)};
	  GameEvent.prototype.trigger=function(name,...args){if(name==='gameStart')state.gameStartCount++;emit(name==='gameStart'?'game_start_trigger':'event_trigger');return originalTrigger.call(this,name,...args)};
	  game.createEvent=function(name,...args){const event=originalCreateEvent.call(this,name,...args);if(name==='gameDraw'){state.drawCreated=true;state.draw=event;state.drawParentName=event.parent?.name||null}if(name==='phaseLoop'){state.phaseLoopCreated=true;state.phaseLoop=event;state.phaseLoopParentName=event.parent?.name||null}emit('event_created');return event};
	  const verifyCompletedRoom=()=>game.players.length===4&&game.players.every((player,index)=>player.playerid===window.__v2ManagedGame.setup.seats[index]?.seatId&&typeof player.name1==='string'&&!player.ws)&&game.me===null;
	  game.prepareArena=function(...args){state.prepareArenaCalls++;emit('prepare_arena_called');if(managedStart)throw Error('DUPLICATE_PREPARE_ARENA_REJECTED');return originalPrepareArena.apply(this,args)};
	  game.chooseCharacter=function(...args){state.chooseCharacterCalls++;emit('choose_character_called');if(managedStart)throw Error('DUPLICATE_CHARACTER_SELECTION_REJECTED');return originalChooseCharacter.apply(this,args)};
	  game.randomMapOL=function(...args){state.randomMapOLCalls++;emit('random_map_ol_called');if(managedStart){if(!_status.connectMode||!verifyCompletedRoom())throw Error('COMPLETED_ROOM_ROSTER_INVALID');state.randomMapOLAdapter='verified_completed_room_noop';return;}return originalRandomMapOL.apply(this,args)};
	  game.waitForPlayer=function(...args){state.waitForPlayerCalls++;emit('wait_for_player_called');if(managedStart){if(!_status.connectMode||!verifyCompletedRoom())throw Error('COMPLETED_ROOM_ROSTER_INVALID');state.waitForPlayerAdapter='verified_completed_room_callback';if(typeof args[0]==='function')args[0]();return;}return originalWaitForPlayer.apply(this,args)};
	  Player.prototype.phase=function(...args){state.phaseCalls++;const next=originalPhase.apply(this,args);if(managedStart&&!managedInputGate&&!state.firstPhaseGate&&this===_status.firstAct){state.firstPhaseGate={seatId:this.playerid,eventName:next.name,parentName:next.parent?.name||null};game.pause();emit('first_phase_gate');return next}emit('phase_called');return next};
	  game.gameDraw=function(...args){state.drawCreated=true;emit('game_draw_called');return originalDraw.apply(this,args)};
	  game.phaseLoop=function(...args){state.phaseLoopCreated=true;emit('phase_loop_called');return originalPhaseLoop.apply(this,args)};
	 }
	 if(state.probeStarted)return {started:false,reason:'DUPLICATE_START_PROBE',snapshot:snapshot()};
	 if(game.me!==null||game.players.some(player=>player.ws)||manager.eventStack.length!==0||game.players.length!==4||game.players.some(player=>!player.name1))throw Error('NATIVE_START_DIAGNOSTIC_PRECONDITION_FAILED');
		state.probeStarted=true;state.rootPromiseState='pending';state.root=game.createEvent('game',false).setContent(managed.mode.start);emit('root_event_created');
	 const promise=state.root.start();promise.then(()=>{state.rootPromiseState='fulfilled';emit('root_promise_fulfilled')},error=>{state.rootPromiseState='rejected';state.failureCode='NATIVE_ROOT_PROMISE_REJECTED';emit('root_promise_rejected')});
	 emit('root_start_dispatched');return {started:true,snapshot:snapshot()};
	})()`;
	if (message.mode === "controlled_block") {
		try {
			await cdp.send("Runtime.evaluate", { expression: `(()=>{const until=performance.now()+700;while(performance.now()<until){};return 'released'})()`, returnByValue: true }, 150);
			emitNativeStartDiagnostic({ stage: "controlled_block_unexpectedly_responded", classification: "undetermined" });
		} catch (error) {
			emitNativeStartDiagnostic({ stage: "controlled_block_outcome", classification: error.message === "CHROMIUM_CDP_TIMEOUT" ? "cdp_command_timeout" : "undetermined",
				chromiumAlive: chromium?.exitCode === null && chromium?.signalCode === null });
		}
		return;
	}
	try {
		await cdp.send("Runtime.evaluate", { expression: install, returnByValue: true }, 1500);
		emitNativeStartDiagnostic({ stage: "native_start_root_evaluation_returned", classification: "evaluation_returned" });
	} catch (error) {
		const chromiumAlive = chromium?.exitCode === null && chromium?.signalCode === null;
		const classification = error.message === "CHROMIUM_CDP_TIMEOUT" && chromiumAlive ? "javascript_loop_starvation_suspected" :
			chromiumAlive ? "undetermined" : "chromium_exit";
		emitNativeStartDiagnostic({ stage: "native_start_root_evaluation_outcome", classification,
			failureCode: error.message === "CHROMIUM_CDP_TIMEOUT" ? "CDP_COMMAND_TIMEOUT" : "NATIVE_START_DIAGNOSTIC_FAILED", chromiumAlive });
		return;
	}
	try {
		let value=null,lastProbeError=null;
		const deadline=Date.now()+2500;
		while(Date.now()<deadline){
			try {
				const probe=await cdp.send("Runtime.evaluate",{expression:`(()=>{const s=window.__v2NativeStartDiagnosticState,{game,_status}=window.__v2ManagedEngine.core,phaseLoop=s?.phaseLoop,phaseEvent=phaseLoop?.next?.find(event=>event.name==='phase'&&event.player===_status.firstAct);return {rootPromiseState:s?.rootPromiseState||'unobserved',snapshot:{eventName:_status.event?.name||null,eventStep:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,parentEventName:_status.event?.parent?.name||null,rootEventName:_status.eventManager.rootEvent?.name||null,eventStackDepth:_status.eventManager.eventStack.length,eventStackTop:_status.eventManager.eventStack.at(-1)?.name||null,eventStack:_status.eventManager.eventStack.map(event=>event.name),connectMode:Boolean(_status.connectMode),paused:Boolean(_status.paused),gameStartTriggered:(s?.gameStartCount||0)>0,gameStartCount:s?.gameStartCount||0,gameDrawCreated:Boolean(s?.drawCreated),gameDrawEntered:Boolean(s?.drawEntered),gameDrawParentName:s?.drawParentName||null,phaseLoopCreated:Boolean(s?.phaseLoopCreated),phaseLoopParentName:s?.phaseLoopParentName||null,firstPhaseEventName:phaseEvent?.name||null,firstPhaseParentName:phaseEvent?.parent?.name||null,firstPhaseGate:s?.firstPhaseGate||null,nativeInputGate:s?.nativeInputGate||null,prepareArenaCalls:s?.prepareArenaCalls||0,waitForPlayerCalls:s?.waitForPlayerCalls||0,randomMapOLCalls:s?.randomMapOLCalls||0,chooseCharacterCalls:s?.chooseCharacterCalls||0,phaseCalls:s?.phaseCalls||0,currentPhaseSeatId:_status.currentPhase?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,pendingChoiceEventName:/choose|respond|useCard/i.test(_status.event?.name||'')?_status.event.name:null,pendingChoiceSeatId:_status.event?.player?.playerid||null,hostPlayerAbsent:game.me===null,seats:game.players.map(p=>({seatId:p.playerid||null,characterInitialized:typeof p.name1==='string',handCount:p.countCards('h')})),lastSuccessfulEventStep:s?.lastSuccessfulEventStep||null,failureCode:s?.failureCode||null}}})()`,returnByValue:true},800);
				if(probe.exceptionDetails) {lastProbeError=String(probe.exceptionDetails.text||"CDP_EVALUATION_EXCEPTION").slice(0,256);break;}
				value=probe.result?.value||null;
				if((message.mode === "managed_input_gate" ? value?.snapshot?.nativeInputGate : value?.snapshot?.phaseLoopCreated)||value?.snapshot?.failureCode)break;
			} catch(error) { lastProbeError=error.message; break; }
			await new Promise(resolve=>setTimeout(resolve,50));
		}
		const classification=lastProbeError==="CHROMIUM_CDP_TIMEOUT"&&chromium?.exitCode===null&&chromium?.signalCode===null ? "javascript_loop_starvation_suspected" :
			lastProbeError ? "undetermined" : value?.rootPromiseState==="pending" ? "native_promise_pending_cdp_responsive" :
			value?.rootPromiseState==="rejected" ? "native_exception_observed" : value?.rootPromiseState==="fulfilled" ? "native_root_fulfilled" : "undetermined";
		emitNativeStartDiagnostic({ stage: "native_start_probe_outcome", classification,
			failureCode: lastProbeError ? (lastProbeError==="CHROMIUM_CDP_TIMEOUT"?"CDP_COMMAND_TIMEOUT":"CDP_EVALUATION_EXCEPTION") : null,
			snapshot: value?.snapshot || null });
	} catch (error) {
		const chromiumAlive = chromium?.exitCode === null && chromium?.signalCode === null;
		emitNativeStartDiagnostic({ stage: "native_start_probe_outcome", classification: error.message === "CHROMIUM_CDP_TIMEOUT" && chromiumAlive ? "javascript_loop_starvation_suspected" : chromiumAlive ? "undetermined" : "chromium_exit",
			failureCode: error.message === "CHROMIUM_CDP_TIMEOUT" ? "CDP_COMMAND_TIMEOUT" : "NATIVE_START_PROBE_FAILED", chromiumAlive });
	}
}

process.on("message", message => {
	// Bootstrap is the one private launch envelope.  Commands deliberately use
	// `type`, so they can never be mistaken for a second bootstrap.
	if (message?.kind === "host_session_bootstrap") {
		boot(message).catch(async error => {
			const detail=String(error?.message||"HOST_BOOT_FAILED").replaceAll(identity?.secret||"", "[redacted]").slice(0,3072);
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null, observed: { failureCode: "HOST_BOOT_FAILED", detail } });
			const code=detail.match(/[A-Z][A-Z0-9_]{2,95}/)?.[0]||"HOST_BOOT_FAILED";
			process.send?.({ ...identity, type: "host_failure", code });
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
	if (message?.type === "host_choice_delivery") {
		// IPC may deliver all four resolutions in one event-loop turn.  Serialize
		// CDP evaluations so event.sendback and the native resume transition cannot
		// race each other or observe a half-written choice map.
		choiceCommandChain = choiceCommandChain.then(() => applyManagedChoice(message)).catch(error => {
			interactiveChoice?.reject?.(error);
			const detail = String(error?.message || "HOST_MANAGED_COMMAND_FAILED")
				.replaceAll(identity?.secret || "", "[redacted]").slice(0, 3072);
			const code = detail.match(/[A-Z][A-Z0-9_]{2,95}/)?.[0] || "HOST_MANAGED_COMMAND_FAILED";
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice?.nativeEventId || null,
				observed: { failureCode: code, detail } });
			if (process.connected) process.send?.({ ...identity, type: "host_failure", code }, () => {
				cleanup().finally(() => process.exit(1));
			});
		});
		return;
	}
	if (message?.type === "host_native_start_diagnostic" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		runNativeStartDiagnostic(message).catch(error => emitNativeStartDiagnostic({ stage: "native_start_diagnostic_rejected",
			classification: "explicit_exception", failureCode: String(error?.message || "NATIVE_START_DIAGNOSTIC_FAILED").slice(0, 96) }));
		return;
	}
	if (message?.type === "host_choice_cancel") return;
});

process.on("disconnect", () => cleanup().finally(() => process.exit(0)));
