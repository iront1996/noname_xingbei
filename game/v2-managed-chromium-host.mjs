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
const nativeAuthorityAckWaiters = new Map();
const nativeStartDiagnosticRing = [];
let nativeStartDiagnosticUnsubscribe = null;
let nativeFailureReported = false;

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

function notifyChoiceDeliveryApplying(choice) {
	if (!identity || !choice || typeof process.send !== "function" || !process.connected) {
		return Promise.reject(new Error("CHOICE_APPLYING_RECEIPT_UNAVAILABLE"));
	}
	return new Promise((resolve, reject) => process.send({ ...identity, type: "host_choice_delivery_started",
		choiceId: choice.choiceId, deliveryId: choice.deliveryId, nativeEventId: choice.nativeEventId,
		seatId: choice.seatId }, error => error ? reject(new Error("CHOICE_APPLYING_RECEIPT_FAILED")) : resolve()));
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
	let testRandomSource = "";
	if (process.env.V2_NATIVE_TEST_RANDOM_SEED !== undefined) {
		if (process.env.V2_NATIVE_MANAGED_RESPONSE !== "1" || !/^(0|[1-9][0-9]{0,9})$/.test(process.env.V2_NATIVE_TEST_RANDOM_SEED)) {
			throw new Error("NATIVE_TEST_RANDOM_SEED_REJECTED");
		}
		const seed = Number(process.env.V2_NATIVE_TEST_RANDOM_SEED) >>> 0;
		testRandomSource = `(()=>{let state=${seed};Math.random=()=>{state=(state+0x6D2B79F5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296}})();`;
	}
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `${testRandomSource}Object.defineProperty(window,"isNonameServer",{value:true,writable:false,configurable:false});`,
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

	if (process.env.V2_NATIVE_C3_UNIFIED_ROOT === "1") {
		await runManagedUnifiedRoot();
		return;
	}

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
	const characterSelectionAck = process.env.V2_NATIVE_OPENING_DRAW_EVENT3 === "1" ?
		waitForAuthorityEventAck(2, 2, afterDigest) : null;
	process.send?.({ ...identity, type: "host_authority_event", proof: { kind: "native_authority_event_v1", checkpoint: null,
		eventSequence: 2, stateRevisionBefore: 1, stateRevisionAfter: 2, beforeDigest, afterDigest,
		event: { kind: "xingbei_character_selection_v1", name: "chooseCharacterOL", characters: completed.after.characters,
			hostPlayerAbsent: true, connectedTransports: 0 } } });
	if (process.env.V2_NATIVE_OPENING_DRAW_EVENT3 === "1") {
		if (!await characterSelectionAck) throw new Error("CHARACTER_SELECTION_AUTHORITY_ACK_REJECTED");
		const finalized = await cdp.send("Runtime.evaluate", { expression: `(()=>{const c=window.__v2ManagedGame,g=window.__v2ManagedEngine?.core?.game;
		 const characters=${JSON.stringify(completed.after.characters)},sides=${JSON.stringify(completed.after.sides)};
		 if(!c||!g||c.authorityState.revision!==1||g.me!==null||g.players.length!==characters.length||g.players.some((player,index)=>
		  player.playerid!==characters[index]?.seatId||player.name1!==characters[index]?.character||player.side!==sides[index]?.side||player.ws))
		  throw Error('CHARACTER_SELECTION_FINALIZE_REJECTED');
		 c.authorityState.revision=2;return {revision:c.authorityState.revision}})()`, returnByValue: true });
		if (finalized.exceptionDetails || finalized.result?.value?.revision !== 2) throw new Error("CHARACTER_SELECTION_FINALIZE_FAILED");
		await runManagedOpeningDraw(completed.after, afterDigest);
	}
}

async function runManagedUnifiedRoot() {
	if (process.env.V2_PLAYABLE_PROOF !== "1" || process.env.V2_MANAGED_CHOICE_IPC !== "1" ||
		process.env.V2_NATIVE_OPENING_DRAW_EVENT3 !== "1" || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1") {
		throw new Error("UNIFIED_ROOT_TEST_CONTRACT_REQUIRED");
	}
	const initialized = await cdp.send("Runtime.evaluate", { expression: `(()=>{
	 const managed=window.__v2ManagedEngine,container=window.__v2ManagedGame,{game,lib,_status}=managed.core,manager=_status.eventManager;
	 if(!container||container.authorityState.revision!==0||container.checkpoint!==null||!_status.connectMode||game.me!==null||
	  game.players.length!==container.setup.seats.length||game.players.some((player,index)=>player.playerid!==container.setup.seats[index].seatId||
	   player.name1||typeof player.side!=='undefined'||player.ws)||manager.eventStack.length!==0)throw Error('UNIFIED_ROOT_PRECONDITION_REJECTED');
	 if(window.__v2ManagedUnifiedRoot)throw Error('UNIFIED_ROOT_DUPLICATE_REJECTED');
	 lib.configOL.chooseSide=false;lib.configOL.choose_mode='多选1';lib.configOL.choose_number='2';
	 lib.configOL.team_sequence='near';lib.configOL.phaseswap=false;
	 const state={status:'starting',instrumented:false,rootPromiseState:'pending',failureCode:null,
	  waitForPlayerCalls:0,randomMapOLCalls:0,prepareArenaCalls:0,chooseCharacterCalls:0,sideAssignmentCalls:0,
	  dialogBroadcasts:0,trusteeTimerCaptured:false,selectionEventCount:0,sideEventCount:0,gameStartCount:0,
	  drawCreated:false,drawCompleted:false,phaseLoopCreated:false,phaseLoopStartRequested:false,
	  phaseLoopStarted:false,phaseLoopPaused:false,phaseLoopReleased:false,phaseLoopGate:null,
	  event1Ready:false,event1Released:false,event2Ready:false,event2Released:false,event3Ready:false};
	 let releaseEvent1,releaseEvent2,releasePhaseLoop;
	 state.event1Gate=new Promise(resolve=>{releaseEvent1=resolve});state.releaseEvent1=()=>{if(state.event1Released)throw Error('UNIFIED_EVENT1_RELEASE_DUPLICATE');state.event1Released=true;releaseEvent1()};
	 state.event2Gate=new Promise(resolve=>{releaseEvent2=resolve});state.releaseEvent2=()=>{if(state.event2Released)throw Error('UNIFIED_EVENT2_RELEASE_DUPLICATE');state.event2Released=true;releaseEvent2()};
	 state.phaseLoopGateSettled=false;state.phaseLoopGate=new Promise(resolve=>{releasePhaseLoop=resolve});state.releasePhaseLoop=()=>{if(state.phaseLoopGateSettled)throw Error('UNIFIED_PHASE_LOOP_RELEASE_DUPLICATE');state.phaseLoopGateSettled=true;state.phaseLoopReleased=true;releasePhaseLoop()};
	 state.beforeEvent1={revision:0,firstActSeatId:null,sides:game.players.map(player=>({seatId:player.playerid,side:null}))};
	 window.__v2ManagedUnifiedRoot=state;window.__v2ManagedOpeningDraw=state;
	 const GameEvent=lib.element.GameEvent,originalStart=GameEvent.prototype.start,originalWaitNext=GameEvent.prototype.waitNext,
	  originalTrigger=GameEvent.prototype.trigger,originalCreateEvent=game.createEvent,originalWaitForPlayer=game.waitForPlayer,
	  originalRandomMapOL=game.randomMapOL,originalPrepareArena=game.prepareArena,originalChooseCharacterOL=game.chooseCharacterOL,
	  originalInitSide=game.initSideAndPosition,originalBroadcastAll=game.broadcastAll,originalPause=game.pause,
	  originalSetTimeout=globalThis.setTimeout,originalGameDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop;
	 state.originals={GameEvent,originalStart,originalWaitNext,originalTrigger,originalCreateEvent,originalWaitForPlayer,
	  originalRandomMapOL,originalPrepareArena,originalChooseCharacterOL,originalInitSide,originalBroadcastAll,originalPause,
	  originalSetTimeout,originalGameDraw,originalPhaseLoop};
	 game.waitForPlayer=function(callback){state.waitForPlayerCalls++;if(state.waitForPlayerCalls!==1||!_status.connectMode||
	  game.me!==null||game.players.length!==container.setup.seats.length||game.players.some((player,index)=>player.ws||
	   player.playerid!==container.setup.seats[index].seatId))throw Error('UNIFIED_WAIT_FOR_PLAYER_ADAPTER_REJECTED');
	  if(typeof callback==='function')callback()};
	 game.prepareArena=function(){state.prepareArenaCalls++;throw Error('UNIFIED_DUPLICATE_PREPARE_ARENA_REJECTED')};
	 game.randomMapOL=function(){state.randomMapOLCalls++;if(state.randomMapOLCalls!==1||!_status.connectMode||game.me!==null||
	  game.players.length!==container.setup.seats.length||game.players.some((player,index)=>player.ws||
	   player.playerid!==container.setup.seats[index].seatId||player.name1))throw Error('UNIFIED_MANAGED_SEAT_MAPPING_REJECTED');
	  state.randomMapOLAdapter='verified_managed_seat_mapping';if(typeof game.chooseCharacterOL!=='function')throw Error('UNIFIED_NATIVE_CHARACTER_ENTRY_MISSING');
	  game.chooseCharacterOL()};
	 game.chooseCharacterOL=function(...args){state.chooseCharacterCalls++;if(state.chooseCharacterCalls!==1)throw Error('UNIFIED_CHARACTER_ENTRY_DUPLICATE');
	  return originalChooseCharacterOL.apply(this,args)};
	 game.initSideAndPosition=function(...args){state.sideAssignmentCalls++;if(state.sideAssignmentCalls!==1)throw Error('UNIFIED_SIDE_ASSIGNMENT_DUPLICATE');
	  return originalInitSide.apply(this,args)};
	 game.broadcastAll=function(callback,...args){const current=manager.eventStack.at(-1);
	  if(current===state.selectionEvent&&current.step===1){if(state.dialogBroadcasts!==0||typeof callback!=='function'||args.length!==2||
	    !Number.isSafeInteger(args[0])||!args[1]||Object.keys(args[1]).length!==game.players.length||
	    game.players.some(player=>!Array.isArray(args[1][player.playerid])||args[1][player.playerid].length<2))
	    throw Error('UNIFIED_CHARACTER_DIALOG_CONTRACT_REJECTED');state.dialogBroadcasts++;state.nativeCandidates=args[1];return;}
	  return originalBroadcastAll.call(this,callback,...args)};
	 globalThis.setTimeout=function(callback,delay,...args){const current=manager.eventStack.at(-1);
	  if(!state.trusteeTimerCaptured&&current===state.selectionEvent&&current.step===1&&current.ai_targets?.length===game.players.length&&
	   Number(delay)===6000){state.trusteeTimerCaptured=true;state.trusteeTimerSuppressed=true;return 0}
	  return originalSetTimeout(callback,delay,...args)};
	 game.pause=function(...args){const current=manager.eventStack.at(-1);
	  if(current===state.selectionEvent&&current.ai_targets?.length===game.players.length){
	   if(state.dialogBroadcasts!==1||!state.trusteeTimerCaptured||!state.nativeCandidates)throw Error('UNIFIED_CHOICE_GATE_PRECONDITION_REJECTED');
	   state.choiceReady=true;state.choiceEventId='native_'+${JSON.stringify(identity.sessionId.slice(3))}+'_character_selection';}
	  return originalPause.apply(this,args)};
	 GameEvent.prototype.trigger=function(name,...args){if(name==='gameStart')state.gameStartCount++;return originalTrigger.call(this,name,...args)};
	 game.createEvent=function(name,...args){const event=originalCreateEvent.call(this,name,...args);
	  if(name==='chooseCharacterOL'){state.selectionEventCount++;if(state.selectionEventCount!==1)throw Error('UNIFIED_SELECTION_EVENT_DUPLICATE');state.selectionEvent=event;event.__v2NativeEventId='native_'+${JSON.stringify(identity.sessionId.slice(3))}+'_character_selection'}
	  if(name==='initSideAndPosition'){state.sideEventCount++;if(state.sideEventCount!==1)throw Error('UNIFIED_SIDE_EVENT_DUPLICATE');state.sideEvent=event}
	  if(name==='gameDraw'){if(state.drawCreated)throw Error('UNIFIED_DRAW_DUPLICATE');state.drawCreated=true;state.draw=event}
	  if(name==='phaseLoop'){if(state.phaseLoopCreated)throw Error('UNIFIED_PHASE_LOOP_DUPLICATE');state.phaseLoopCreated=true;state.phaseLoop=event}
	  return event};
	 GameEvent.prototype.start=function(...args){const event=this;
	  if(event===state.phaseLoop){if(state.phaseLoopStartRequested)throw Error('UNIFIED_PHASE_LOOP_START_DUPLICATE');
	   state.phaseLoopStartRequested=true;state.phaseLoopPaused=true;state.status='phase_loop_gated';
	   if(!state.drawCompleted||event.parent!==state.root)throw Error('UNIFIED_PHASE_LOOP_PRECONDITION_REJECTED');state.event3Ready=true;
	   return state.phaseLoopGate.then(()=>{if(state.phaseLoopStarted)throw Error('UNIFIED_PHASE_LOOP_START_DUPLICATE');state.phaseLoopStarted=true;
	    state.phaseLoopPaused=false;return originalStart.apply(this,args)})}
	  return originalStart.apply(this,args).then(value=>{if(event===state.sideEvent){state.sideEventCompleted=true;state.event1After={revision:1,
	    firstActSeatId:_status.firstAct?.playerid||null,sides:game.players.map(player=>({seatId:player.playerid,side:player.side}))}}
	   if(event===state.selectionEvent){state.selectionEventCompleted=true;state.event2After={revision:2,
	    firstActSeatId:_status.firstAct?.playerid||null,sides:game.players.map(player=>({seatId:player.playerid,side:player.side})),
	    characters:game.players.map(player=>({seatId:player.playerid,character:player.name1||null}))}}
	   if(event===state.draw){state.drawCompleted=true;state.drawFinalStep=Number.isSafeInteger(event.step)?event.step:null;
	    state.event3Seats=game.players.map((player,index)=>({seatId:player.playerid,position:Number(player.dataset.position),
	     character:player.name1||null,side:player.side,handCount:player.countCards('h'),
	     hand:player.getCards('h').map(card=>({name:card.name||null,suit:card.suit||null,number:card.number||null,nature:card.nature||null}))}))}
	   return value})};
	 GameEvent.prototype.waitNext=function(...args){const parent=this;if(parent===state.draw){state.drawEntered=true;state.drawParentName=parent.parent?.name||null}return originalWaitNext.apply(this,args).then(async value=>{
	   if(parent===state.selectionEvent&&state.sideEventCompleted&&!state.event1Released){state.event1Ready=true;await state.event1Gate}
	   if(parent===state.root&&state.selectionEventCompleted&&!state.event2Released){state.event2Ready=true;await state.event2Gate}
	   return value})};
	 game.gameDraw=function(...args){if(state.drawCreated)throw Error('UNIFIED_DRAW_DUPLICATE_CALL');return originalGameDraw.apply(this,args)};
	 game.phaseLoop=function(...args){if(state.phaseLoopCreated)throw Error('UNIFIED_PHASE_LOOP_DUPLICATE_CALL');const result=originalPhaseLoop.apply(this,args);
	  if(state.phaseLoop?.parent!==state.root)throw Error('UNIFIED_PHASE_LOOP_PARENT_INVALID');return result};
	 state.root=game.createEvent('game',false).setContent(managed.mode.start);state.rootInstanceId='native_root_'+${JSON.stringify(identity.sessionId.slice(3))};
	 if(state.root.name!=='game'||state.root.parent)throw Error('UNIFIED_ROOT_INVALID');
	 const promise=state.root.start();promise.then(()=>{state.rootPromiseState='fulfilled';state.status='root_fulfilled'},error=>{
	  state.rootPromiseState='rejected';state.failureCode='UNIFIED_ROOT_REJECTED';state.failureDetail=String(error?.message||error).slice(0,160)});
	 return {started:true,rootName:state.root.name,rootEventId:state.root.id||null,hostPlayerAbsent:game.me===null};})()`,
		returnByValue: true }, 5000);
	if (initialized.exceptionDetails || initialized.result?.value?.started !== true || initialized.result.value.hostPlayerAbsent !== true) {
		throw new Error(`UNIFIED_ROOT_START_FAILED:${initialized.exceptionDetails?.text || JSON.stringify(initialized.result?.value || null)}`);
	}
	const evaluateState = async () => {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2ManagedUnifiedRoot,m=window.__v2ManagedEngine.core,{game,_status}=m;
		 return s?{status:s.status,failureCode:s.failureCode,failureDetail:s.failureDetail||null,rootPromiseState:s.rootPromiseState,
		  rootInstanceId:s.rootInstanceId,selectionParentName:s.selectionEvent?.parent?.name||null,sideEventParentName:s.sideEvent?.parent?.name||null,
		  selectionEventName:s.selectionEvent?.name||null,sideEventName:s.sideEvent?.name||null,
		  rootEventName:_status.eventManager.rootEvent?.name||null,rootMatches:s.root===_status.eventManager.rootEvent,
		  eventStack:_status.eventManager.eventStack.map(event=>event.name),event1Ready:s.event1Ready,event2Ready:s.event2Ready,event3Ready:s.event3Ready,
		  event1After:s.event1After||null,event2After:s.event2After||null,choiceReady:Boolean(s.choiceReady),nativeEventId:s.choiceEventId||null,
		  choices:s.nativeCandidates?Object.entries(s.nativeCandidates).map(([seatId,options])=>({seatId,options:[...options]})):null,
		  drawCompleted:s.drawCompleted,drawFinalStep:s.drawFinalStep,phaseLoopStartRequested:s.phaseLoopStartRequested,
		  phaseLoopParentName:s.phaseLoop?.parent?.name||null,phaseLoopPaused:s.phaseLoopPaused,
		  event3Seats:s.event3Seats||null,gameMeNull:game.me===null,connectedTransports:game.players.filter(player=>player.ws).length,
		  sideAssignmentCalls:s.sideAssignmentCalls,selectionEventCount:s.selectionEventCount,gameStartCount:s.gameStartCount,
		  prepareArenaCalls:s.prepareArenaCalls,waitForPlayerCalls:s.waitForPlayerCalls,randomMapOLCalls:s.randomMapOLCalls,
		  dialogBroadcasts:s.dialogBroadcasts,trusteeTimerCaptured:s.trusteeTimerCaptured}:null})()`, returnByValue: true }, 1500);
		if (result.exceptionDetails || !result.result?.value) throw new Error("UNIFIED_ROOT_STATE_UNAVAILABLE");
		return result.result.value;
	};
	const waitFor = async (predicate, code, timeoutMs = 20000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const state = await evaluateState();
			if (state.failureCode) throw new Error(`${code}:${JSON.stringify(state)}`);
			if (predicate(state)) return state;
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		throw new Error(`${code}:${JSON.stringify(await evaluateState())}`);
	};
	const release = async name => {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2ManagedUnifiedRoot;
		 if(!s||typeof s['release'+${JSON.stringify(name)}]!=='function')throw Error('UNIFIED_RELEASE_GATE_MISSING');
		 s['release'+${JSON.stringify(name)}]();return true})()`, returnByValue: true });
		if (result.exceptionDetails || result.result?.value !== true) throw new Error("UNIFIED_RELEASE_GATE_FAILED");
	};
	const submit = async proof => {
		const ack = waitForAuthorityEventAck(proof.eventSequence, proof.stateRevisionAfter, proof.afterDigest);
		process.send?.({ ...identity, type: "host_authority_event", proof });
		if (!await ack) throw new Error(`UNIFIED_AUTHORITY_EVENT_${proof.eventSequence}_REJECTED`);
	};
	const finalizeRevision = async (revision, expression) => {
		const finalized = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
		if (finalized.exceptionDetails || finalized.result?.value !== true) throw new Error(`UNIFIED_EVENT_${revision}_FINALIZE_FAILED`);
	};
	const event1 = await waitFor(state => state.event1Ready, "UNIFIED_EVENT1_GATE_TIMEOUT");
	if (event1.rootEventName !== "game" || !event1.rootMatches || event1.eventStack.join(">") !== "game>chooseCharacterOL" ||
		event1.event1After?.sides?.length !== gameSetupSeatCount() || !event1.event1After.firstActSeatId || event1.gameMeNull !== true || event1.connectedTransports !== 0) {
		throw new Error(`UNIFIED_EVENT1_TOPOLOGY_INVALID:${JSON.stringify(event1)}`);
	}
	const before1 = { revision: 0, firstActSeatId: null, sides: event1.event1After.sides.map(entry => ({ seatId: entry.seatId, side: null })) };
	const before1Digest = createHash("sha256").update(canonicalize(before1)).digest("hex");
	const after1Digest = createHash("sha256").update(canonicalize(event1.event1After)).digest("hex");
	await submit({ kind: "native_authority_event_v1", checkpoint: null, eventSequence: 1, stateRevisionBefore: 0,
		stateRevisionAfter: 1, beforeDigest: before1Digest, afterDigest: after1Digest,
		event: { kind: "xingbei_side_assignment_v1", name: "initSideAndPosition", firstActSeatId: event1.event1After.firstActSeatId,
			sides: event1.event1After.sides, hostPlayerAbsent: true, connectedTransports: 0, rootInstanceId: event1.rootInstanceId,
			rootEventName: "game", rootParentName: null, selectionEventName: event1.selectionEventName,
			selectionParentName: event1.selectionParentName, sideEventParentName: event1.sideEventParentName } });
	await finalizeRevision(1, `(()=>{const c=window.__v2ManagedGame,s=window.__v2ManagedUnifiedRoot;
	 if(c.authorityState.revision!==0||!s.event1Ready||s.event1Released)throw Error('UNIFIED_EVENT1_FINALIZE_REJECTED');c.authorityState.revision=1;return true})()`);
	await release("Event1");
	const choiceReady = await waitFor(state => state.choiceReady, "UNIFIED_CHOICE_CANDIDATES_TIMEOUT");
	const nativeEventId = choiceReady.nativeEventId;
	if (choiceReady.choices?.length !== 4 || choiceReady.choices.some(choice => choice.options.length < 2) ||
		choiceReady.dialogBroadcasts !== 1 || !choiceReady.trusteeTimerCaptured || choiceReady.eventStack.join(">") !== "game>chooseCharacterOL" ||
		choiceReady.gameMeNull !== true || choiceReady.connectedTransports !== 0) throw new Error(`UNIFIED_CHOICE_CANDIDATES_INVALID:${JSON.stringify(choiceReady)}`);
	const choiceState = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2ManagedUnifiedRoot;
	 if(!s?.selectionEvent||s.choiceEventId!==${JSON.stringify(nativeEventId)}||s.selectionEvent.parent!==s.root)throw Error('UNIFIED_CHOICE_EVENT_BINDING_INVALID');
	 window.__v2ManagedChoiceState={event:s.selectionEvent,nativeEventId:s.choiceEventId,applied:new Set()};return true})()`, returnByValue: true });
	if (choiceState.exceptionDetails || choiceState.result?.value !== true) throw new Error("UNIFIED_CHOICE_STATE_INSTALL_FAILED");
	interactiveChoice = { nativeEventId, before: event1.event1After, choices: new Map(choiceReady.choices.map(choice => [choice.seatId, choice])),
		deliveries: new Map(), completed: null, resolve: null, reject: null };
	choiceDiagnosticTimer = setTimeout(() => emitManagedChoiceDiagnostic(), 5000);
	process.send?.({ ...identity, type: "host_choice_candidates", nativeEventId, eventSequence: 2, choices: choiceReady.choices, deadlineMs: 3000 });
	const completed = await new Promise((resolve, reject) => { interactiveChoice.resolve = resolve; interactiveChoice.reject = reject; });
	const event2 = await waitFor(state => state.event2Ready, "UNIFIED_EVENT2_GATE_TIMEOUT");
	if (event2.rootEventName !== "game" || !event2.rootMatches || event2.eventStack.join(">") !== "game" ||
		event2.event2After?.characters?.length !== 4 || event2.event2After.characters.some(entry => !entry.character) ||
		completed.after.characters.some((entry,index)=>entry.seatId!==event2.event2After.characters[index].seatId||entry.character!==event2.event2After.characters[index].character) ||
		event2.gameMeNull !== true || event2.connectedTransports !== 0) throw new Error(`UNIFIED_EVENT2_TOPOLOGY_INVALID:${JSON.stringify(event2)}`);
	const before2Digest = createHash("sha256").update(canonicalize(event1.event1After)).digest("hex");
	const after2Digest = createHash("sha256").update(canonicalize(event2.event2After)).digest("hex");
	if (before2Digest !== after1Digest || before2Digest === after2Digest) throw new Error("UNIFIED_EVENT2_DIGEST_CHAIN_INVALID");
	await submit({ kind: "native_authority_event_v1", checkpoint: null, eventSequence: 2, stateRevisionBefore: 1,
		stateRevisionAfter: 2, beforeDigest: before2Digest, afterDigest: after2Digest,
			event: { kind: "xingbei_character_selection_v1", name: "chooseCharacterOL", characters: event2.event2After.characters,
				hostPlayerAbsent: true, connectedTransports: 0, rootInstanceId: event2.rootInstanceId, rootEventName: "game",
				rootParentName: null, selectionEventName: event2.selectionEventName, selectionParentName: event2.selectionParentName } });
	await finalizeRevision(2, `(()=>{const c=window.__v2ManagedGame,s=window.__v2ManagedUnifiedRoot;
	 if(c.authorityState.revision!==1||!s.event2Ready||s.event2Released)throw Error('UNIFIED_EVENT2_FINALIZE_REJECTED');c.authorityState.revision=2;return true})()`);
	interactiveChoice.openingAuthoritySummary = event2.event2After;
	interactiveChoice.openingAuthorityDigest = after2Digest;
	await release("Event2");
	const event3 = await waitFor(state => state.event3Ready, "UNIFIED_EVENT3_GATE_TIMEOUT");
	if (event3.rootEventName !== "game" || !event3.rootMatches || event3.eventStack.join(">") !== "game" ||
		event3.gameStartCount !== 1 || event3.drawCompleted !== true || event3.phaseLoopStartRequested !== true ||
		event3.phaseLoopParentName !== "game" || event3.phaseLoopPaused !== true || event3.gameMeNull !== true ||
		event3.connectedTransports !== 0 || event3.event3Seats?.length !== 4 || event3.event3Seats.some(seat => seat.handCount !== 4)) {
		throw new Error(`UNIFIED_EVENT3_GATE_INVALID:${JSON.stringify(event3)}`);
	}
	const seats = event3.event3Seats.map(seat => ({ ...seat, handCommitment: createHash("sha256").update(canonicalize(seat.hand)).digest("hex") }));
	for (const seat of seats) delete seat.hand;
	const after3 = { revision: 3, firstActSeatId: event2.event2After.firstActSeatId,
		seats: seats.map(({ seatId, position, character, side, handCount, handCommitment }) =>
			({ seatId, position, character, side, handCount, handCommitment })) };
	const after3Digest = createHash("sha256").update(canonicalize(after3)).digest("hex");
	await submit({ kind: "native_authority_event_v1", checkpoint: null, eventSequence: 3, stateRevisionBefore: 2,
		stateRevisionAfter: 3, beforeDigest: after2Digest, afterDigest: after3Digest,
			event: { kind: "xingbei_opening_draw_v1", name: "gameDraw", nativeEventId: `native_${identity.sessionId.slice(3)}_opening_draw`,
			rootInstanceId: event3.rootInstanceId,
			nativeEventCompleted: true, nativeEventStep: event3.drawFinalStep, gameStartTriggered: true, gameStartCount: 1,
			rootEventName: "game", parentEventName: "game", phaseLoopCreated: true, phaseLoopStartRequested: true,
			phaseLoopParentName: "game", phaseLoopPaused: true, firstActSeatId: after3.firstActSeatId,
			seats: after3.seats, gameMeNull: true, connectedTransports: 0 } });
	await finalizeRevision(3, `(()=>{const c=window.__v2ManagedGame,s=window.__v2ManagedUnifiedRoot;
	 if(c.authorityState.revision!==2||!s.event3Ready||s.phaseLoopReleased)throw Error('UNIFIED_EVENT3_FINALIZE_REJECTED');
	 c.authorityState.revision=3;s.status='authority_committed';s.authoritySummary=${JSON.stringify(after3)};s.authorityDigest=${JSON.stringify(after3Digest)};return true})()`);
	interactiveChoice.openingAuthoritySummary = after3;
	interactiveChoice.openingAuthorityDigest = after3Digest;
	interactiveChoice.nativeRootInstanceId = event3.rootInstanceId;
	process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: `native_${identity.sessionId.slice(3)}_opening_draw`,
		observed: { kind: "native_authority_event_accepted_v1", stage: "opening_draw_event_3_accepted", eventSequence: 3,
			stateRevision: 3, beforeDigest: after2Digest, afterDigest: after3Digest, eventName: "gameDraw", parentEventName: "game",
			rootEventName: "game", phaseLoopPaused: true, seatHandCounts: seats.map(seat => ({ seatId: seat.seatId, handCount: seat.handCount })),
			hostPlayerAbsent: true, connectedTransports: 0, checkpointAvailable: false } });
	await runNativeStartDiagnostic({ ...identity, type: "host_native_start_diagnostic", mode: "managed_opening_root_action_event4" });
}

function gameSetupSeatCount() {
	return 4;
}

function waitForAuthorityEventAck(eventSequence, stateRevision, afterDigest, timeoutMs = 15000) {
	if (![1, 2, 3, 4].includes(eventSequence) || stateRevision !== eventSequence || !/^[a-f0-9]{64}$/.test(afterDigest) ||
		!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15000 || nativeAuthorityAckWaiters.has(eventSequence)) return Promise.reject(new Error("AUTHORITY_ACK_WAITER_INVALID"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { nativeAuthorityAckWaiters.delete(eventSequence); reject(new Error("AUTHORITY_EVENT_ACK_TIMEOUT")); }, timeoutMs);
		nativeAuthorityAckWaiters.set(eventSequence, message => {
			clearTimeout(timer);
			nativeAuthorityAckWaiters.delete(eventSequence);
			const valid = validHostCommand(message) && message.accepted === true && message.eventSequence === eventSequence &&
				message.stateRevision === stateRevision && message.afterDigest === afterDigest;
			resolve(valid);
		});
	});
}

async function runManagedOpeningDraw(event2After, event2Digest) {
	const nativeEventId = `native_${identity.sessionId.slice(3)}_opening_draw`;
	const reportStage = (stage, details = {}) => process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId,
		observed: { kind: "native_opening_draw_diagnostic_v1", stage, ...details } });
	let readiness = null;
	const idleDeadline = Date.now() + 10000;
	while (Date.now() < idleDeadline) {
		const response = await cdp.send("Runtime.evaluate", { expression: `(()=>{const c=window.__v2ManagedGame,m=window.__v2ManagedEngine?.core,{game,_status}=m||{},manager=_status?.eventManager;
		 return {authorityRevision:c?.authorityState?.revision??null,gameMeNull:game?.me===null,connectMode:Boolean(_status?.connectMode),
		  seatCount:game?.players?.length??null,firstActSeatId:_status?.firstAct?.playerid||null,eventStackDepth:manager?.eventStack?.length??null,
		  eventStack:manager?.eventStack?.map(event=>event.name)||[],tempEventName:manager?.tempEvent?.name||null,
		  seats:game?.players?.map((player,index)=>({seatId:player.playerid,expectedSeatId:c?.setup?.seats?.[index]?.seatId,
		   character:player.name1||null,side:player.side,expectedCharacter:${JSON.stringify(event2After.characters)},
		  expectedSide:${JSON.stringify(event2After.sides)},connected:Boolean(player.ws)}))||[]}})()`, returnByValue: true }, 2000);
		if (response.exceptionDetails) {
			const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "CDP_EVALUATION_EXCEPTION";
			throw new Error(`OPENING_DRAW_READINESS_DIAGNOSTIC_FAILED:${String(detail).replaceAll(identity.secret, "[redacted]").slice(0, 1024)}`);
		}
		readiness = response.result?.value;
		const rosterMatches = readiness?.seatCount === 4 && readiness.seats.every((seat, index) =>
			seat.seatId === seat.expectedSeatId && seat.seatId === event2After.sides[index]?.seatId &&
			seat.character === event2After.characters[index]?.character && seat.side === event2After.sides[index]?.side && !seat.connected);
		if (readiness?.authorityRevision !== 2 || readiness.gameMeNull !== true || !readiness.connectMode ||
			!readiness.firstActSeatId || !rosterMatches) {
			throw new Error(`OPENING_DRAW_READINESS_REJECTED:${JSON.stringify({ ...readiness, seats: readiness?.seats?.map(({ seatId, character, side, connected }) => ({ seatId, character, side, connected })) })}`);
		}
		if (readiness.eventStackDepth === 0 && readiness.tempEventName === null) break;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	if (readiness?.eventStackDepth !== 0 || readiness.tempEventName !== null) {
		throw new Error(`OPENING_NATIVE_EVENT_STACK_DID_NOT_DRAIN:${JSON.stringify({ depth: readiness?.eventStackDepth,
			stack: readiness?.eventStack, tempEventName: readiness?.tempEventName })}`);
	}
	reportStage("opening_draw_root_start_requested", { eventStackDepth: readiness.eventStackDepth, tempEventName: readiness.tempEventName });
	const started = await cdp.send("Runtime.evaluate", { expression: `(()=>{
	 const managed=window.__v2ManagedEngine,container=window.__v2ManagedGame,{game,lib,_status}=managed.core,manager=_status.eventManager;
	 const event2=${JSON.stringify(event2After)},digest2=${JSON.stringify(event2Digest)};
	 const precondition={revision:container.authorityState.revision,gameMeNull:game.me===null,connectMode:Boolean(_status.connectMode),
	  playerCount:game.players.length,eventStackDepth:manager.eventStack.length,tempEventName:manager.tempEvent?.name||null,
	  firstActSeatId:_status.firstAct?.playerid||null};
	 if(container.authorityState.revision!==2||game.me!==null||!_status.connectMode||game.players.length!==4||
	  manager.eventStack.length!==0||manager.tempEvent||!_status.firstAct||
	  game.players.some((player,index)=>player.playerid!==container.setup.seats[index].seatId||!player.name1||
	   player.side!==event2.sides[index]?.side||player.name1!==event2.characters[index]?.character||player.ws))
	  throw Error('OPENING_DRAW_PRECONDITION_REJECTED:'+JSON.stringify(precondition));
	 if(window.__v2ManagedOpeningDraw)throw Error('OPENING_DRAW_DUPLICATE_REJECTED');
	 const state={nativeEventId:${JSON.stringify(nativeEventId)},status:'starting',gameStartCount:0,drawCreated:false,
	  drawEntered:false,drawCompleted:false,phaseLoopCreated:false,phaseLoopStartRequested:false,
	  phaseLoopStarted:false,phaseLoopPaused:false,phaseLoopGate:null,
	  waitForPlayerCalls:0,randomMapOLCalls:0,rootPromiseState:'pending',failureCode:null};
	 let releasePhaseLoop;state.phaseLoopGate=new Promise(resolve=>{releasePhaseLoop=resolve});state.releasePhaseLoop=releasePhaseLoop;
	 window.__v2ManagedOpeningDraw=state;
	 const GameEvent=lib.element.GameEvent,originalWaitNext=GameEvent.prototype.waitNext,originalStart=GameEvent.prototype.start;
	 const originalCreateEvent=game.createEvent,originalWaitForPlayer=game.waitForPlayer,originalRandomMapOL=game.randomMapOL;
	 const originalPrepareArena=game.prepareArena,originalChooseCharacter=game.chooseCharacter,originalInit=game.initSideAndPosition;
	 const originalDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop,originalTrigger=GameEvent.prototype.trigger;
	 GameEvent.prototype.waitNext=function(...args){const event=this;if(event.name==='gameDraw')state.drawEntered=true;return originalWaitNext.apply(this,args).then(value=>{if(event===state.draw){state.drawCompleted=true;state.drawFinalStep=event.step}return value},error=>{state.failureCode='OPENING_DRAW_CHILD_FAILED';throw error})};
	 GameEvent.prototype.start=function(...args){if(this===state.phaseLoop){if(state.phaseLoopStartRequested)throw Error('OPENING_PHASE_LOOP_START_DUPLICATE');
	  state.phaseLoopStartRequested=true;state.phaseLoopPaused=true;state.status='phase_loop_gated';
	  return state.phaseLoopGate.then(()=>{if(state.phaseLoopStarted)throw Error('OPENING_PHASE_LOOP_START_DUPLICATE');
	   state.phaseLoopStarted=true;state.phaseLoopPaused=false;return originalStart.apply(this,args)})}
	  return originalStart.apply(this,args)};
	 GameEvent.prototype.trigger=function(name,...args){if(name==='gameStart')state.gameStartCount++;return originalTrigger.call(this,name,...args)};
	 game.createEvent=function(name,...args){const event=originalCreateEvent.call(this,name,...args);if(name==='gameDraw'){if(state.drawCreated)throw Error('OPENING_DRAW_DUPLICATE_EVENT');state.drawCreated=true;state.draw=event}
	  if(name==='phaseLoop'){if(state.phaseLoopCreated)throw Error('OPENING_PHASE_LOOP_DUPLICATE');state.phaseLoopCreated=true;state.phaseLoop=event}return event};
	 game.waitForPlayer=function(callback){state.waitForPlayerCalls++;if(state.waitForPlayerCalls!==1||!_status.connectMode||game.players.length!==container.setup.seats.length)throw Error('OPENING_WAIT_FOR_PLAYER_ADAPTER_REJECTED');if(typeof callback==='function')callback()};
	 game.randomMapOL=function(){state.randomMapOLCalls++;if(state.randomMapOLCalls!==1||!_status.connectMode||game.players.some((player,index)=>player.playerid!==container.setup.seats[index].seatId||!player.name1))throw Error('OPENING_RANDOM_MAP_ADAPTER_REJECTED')};
	 game.prepareArena=function(){throw Error('OPENING_DUPLICATE_ARENA_REJECTED')};game.chooseCharacter=function(){throw Error('OPENING_DUPLICATE_CHARACTER_SELECTION_REJECTED')};
	 game.initSideAndPosition=function(){throw Error('OPENING_DUPLICATE_SIDE_ASSIGNMENT_REJECTED')};
	 game.gameDraw=function(...args){if(state.drawCreated)throw Error('OPENING_DRAW_DUPLICATE_CALL');return originalDraw.apply(this,args)};
	 game.phaseLoop=function(...args){if(state.phaseLoopCreated)throw Error('OPENING_PHASE_LOOP_DUPLICATE_CALL');const result=originalPhaseLoop.apply(this,args);
	  if(state.phaseLoop?.parent!==state.root)throw Error('OPENING_PHASE_LOOP_PARENT_INVALID');state.phaseLoopPaused=true;return result};
	 state.root=game.createEvent('game',false).setContent(managed.mode.start);
	 if(state.root.name!=='game'||state.root.parent)throw Error('OPENING_ROOT_INVALID');
	 Promise.resolve(state.root.start()).then(()=>{state.rootPromiseState='fulfilled'},error=>{state.rootPromiseState='rejected';state.failureCode='OPENING_ROOT_REJECTED'});
	 return {started:true,rootName:state.root.name,event2Digest:digest2};})()`, returnByValue: true }, 15000);
	if (started.exceptionDetails || started.result?.value?.started !== true) {
		const detail = started.exceptionDetails?.exception?.description || started.exceptionDetails?.text ||
			JSON.stringify(started.result?.value || null);
		throw new Error(`OPENING_DRAW_START_FAILED:${String(detail).replaceAll(identity.secret, "[redacted]").slice(0, 1024)}`);
	}
	reportStage("opening_draw_root_start_returned", { rootName: started.result.value.rootName });
	let observed = null;
	const deadline = Date.now() + 20000;
	let lastObservationKey = null;
	while (Date.now() < deadline) {
		const response = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2ManagedOpeningDraw,m=window.__v2ManagedEngine?.core,game=m?.game,_status=m?._status;
		 if(!s)return {ready:false,code:'OPENING_DRAW_STATE_MISSING'};
		 return {ready:s.drawCompleted&&s.phaseLoopCreated&&s.phaseLoopStartRequested&&s.phaseLoopPaused&&s.gameStartCount===1,
		  status:s.status,failureCode:s.failureCode,rootPromiseState:s.rootPromiseState,rootName:s.root?.name||null,
		  rootParentName:s.root?.parent?.name||null,eventStack:_status?.eventManager?.eventStack?.map(event=>event.name)||[],
		  drawName:s.draw?.name||null,drawParentName:s.draw?.parent?.name||null,drawEntered:s.drawEntered,drawCompleted:s.drawCompleted,
		  drawFinalStep:s.drawFinalStep,phaseLoopName:s.phaseLoop?.name||null,phaseLoopParentName:s.phaseLoop?.parent?.name||null,
		  phaseLoopStartRequested:s.phaseLoopStartRequested,phaseLoopStarted:s.phaseLoopStarted,phaseLoopPaused:s.phaseLoopPaused,gameStartCount:s.gameStartCount,
		  firstActSeatId:_status?.firstAct?.playerid||null,gameMeNull:game?.me===null,connectedTransports:game?.players?.filter(player=>player.ws).length,
		  seats:game?.players?.map(player=>({seatId:player.playerid,position:Number(player.dataset.position),character:player.name1||null,
		   side:player.side,handCount:player.countCards('h'),startCardsCount:player._start_cards?.length||0,hand:player.getCards('h').map(card=>({name:card.name||null,suit:card.suit||null,number:card.number||null,nature:card.nature||null}))}))||[]}})()`, returnByValue: true }, 2000);
		if (response.exceptionDetails) {
			const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "CDP_EVALUATION_EXCEPTION";
			throw new Error(`OPENING_DRAW_OBSERVATION_FAILED:${String(detail).replaceAll(identity.secret, "[redacted]").slice(0, 1024)}`);
		}
		observed = response.result?.value;
		const observationKey = JSON.stringify({ stack: observed?.eventStack, drawEntered: observed?.drawEntered,
			drawCompleted: observed?.drawCompleted, phaseLoopCreated: observed?.phaseLoopCreated,
			phaseLoopStartRequested: observed?.phaseLoopStartRequested, phaseLoopPaused: observed?.phaseLoopPaused,
			gameStartCount: observed?.gameStartCount,
			rootPromiseState: observed?.rootPromiseState, failureCode: observed?.failureCode });
		if (observationKey !== lastObservationKey) {
			reportStage("opening_draw_native_state_observed", {
				rootPromiseState: observed?.rootPromiseState, failureCode: observed?.failureCode,
				eventStack: observed?.eventStack, drawEntered: observed?.drawEntered, drawCompleted: observed?.drawCompleted,
				drawFinalStep: observed?.drawFinalStep, phaseLoopCreated: observed?.phaseLoopCreated,
				phaseLoopStartRequested: observed?.phaseLoopStartRequested,
				phaseLoopStarted: observed?.phaseLoopStarted, phaseLoopPaused: observed?.phaseLoopPaused,
				gameStartCount: observed?.gameStartCount, firstActSeatId: observed?.firstActSeatId,
				gameMeNull: observed?.gameMeNull, connectedTransports: observed?.connectedTransports,
				seatHandCounts: observed?.seats?.map(seat => ({ seatId: seat.seatId, handCount: seat.handCount })),
			});
			lastObservationKey = observationKey;
		}
		if (observed?.failureCode || observed?.rootPromiseState === "rejected") throw new Error(observed.failureCode || "OPENING_ROOT_REJECTED");
		if (observed?.ready) break;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	if (!observed?.ready || observed.drawName !== "gameDraw" || observed.drawParentName !== "game" ||
		observed.rootName !== "game" || observed.rootParentName !== null || observed.phaseLoopName !== "phaseLoop" ||
		observed.phaseLoopParentName !== "game" || observed.phaseLoopStarted !== false || observed.rootPromiseState !== "pending" ||
		observed.firstActSeatId !== event2After.firstActSeatId || observed.gameMeNull !== true || observed.connectedTransports !== 0 ||
		observed.seats?.length !== 4 || observed.seats.some((seat, index) => seat.seatId !== event2After.sides[index]?.seatId ||
			seat.position !== index || seat.character !== event2After.characters[index]?.character ||
			seat.side !== event2After.sides[index]?.side || seat.handCount !== 4 || seat.startCardsCount !== 4)) {
		throw new Error(`NATIVE_OPENING_DRAW_NOT_VERIFIED:${JSON.stringify(observed)}`);
	}
	const seats = observed.seats.map(seat => ({ ...seat, handCommitment: createHash("sha256").update(canonicalize(seat.hand)).digest("hex") }));
	for (const seat of seats) delete seat.hand;
	const after = { revision: 3, firstActSeatId: observed.firstActSeatId,
		seats: seats.map(({ seatId, position, character, side, handCount, handCommitment }) => ({ seatId, position, character, side, handCount, handCommitment })) };
	const afterDigest = createHash("sha256").update(canonicalize(after)).digest("hex");
	if (afterDigest === event2Digest) throw new Error("NATIVE_OPENING_DRAW_NO_STATE_CHANGE");
	if (interactiveChoice) {
		interactiveChoice.openingAuthoritySummary = after;
		interactiveChoice.openingAuthorityDigest = afterDigest;
	}
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 3,
		stateRevisionBefore: 2, stateRevisionAfter: 3, beforeDigest: event2Digest, afterDigest,
		event: { kind: "xingbei_opening_draw_v1", name: "gameDraw", nativeEventId,
			nativeEventCompleted: true, nativeEventStep: observed.drawFinalStep, gameStartTriggered: true, gameStartCount: 1,
			rootEventName: observed.rootName, parentEventName: observed.drawParentName,
		phaseLoopCreated: true, phaseLoopStartRequested: true, phaseLoopParentName: observed.phaseLoopParentName, phaseLoopPaused: true,
			firstActSeatId: observed.firstActSeatId, seats: after.seats, gameMeNull: true, connectedTransports: 0 } };
	const acknowledgement = waitForAuthorityEventAck(3, 3, afterDigest);
	const submittedProof = process.env.V2_NATIVE_REJECT_OPENING_DRAW_EVENT3 === "1" ? { ...proof, afterDigest: "ee".repeat(32) } : proof;
	process.send?.({ ...identity, type: "host_authority_event", proof: submittedProof });
	if (!await acknowledgement) throw new Error("OPENING_DRAW_AUTHORITY_REJECTED");
	 const finalized = await cdp.send("Runtime.evaluate", { expression: `(()=>{const c=window.__v2ManagedGame,s=window.__v2ManagedOpeningDraw;
	 if(!s?.phaseLoopPaused||s.phaseLoopStarted||c.authorityState.revision!==2)throw Error('OPENING_DRAW_FINALIZE_PRECONDITION_REJECTED');
	 c.authorityState.revision=3;s.status='authority_committed';s.authoritySummary=${JSON.stringify(after)};s.authorityDigest=${JSON.stringify(afterDigest)};return {revision:c.authorityState.revision}})()`, returnByValue: true });
	if (finalized.exceptionDetails || finalized.result?.value?.revision !== 3) throw new Error("OPENING_DRAW_FINALIZE_FAILED");
	process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId,
		observed: { kind: "native_authority_event_accepted_v1", stage: "opening_draw_event_3_accepted",
			eventSequence: 3, stateRevision: 3, beforeDigest: event2Digest, afterDigest,
			eventName: "gameDraw", parentEventName: "game", phaseLoopPaused: true,
			firstActSeatId: observed.firstActSeatId, seatHandCounts: seats.map(seat => ({ seatId: seat.seatId, handCount: seat.handCount })),
			hostPlayerAbsent: true, connectedTransports: 0, checkpointAvailable: false } });
}

async function applyManagedChoice(message) {
	if (interactiveChoice?.nativeResponseGates?.has(message?.nativeEventId)) {
		return applyManagedNativeResponseDelivery(message);
	}
	// The native action gate can open while character-choice ACK retries are
	// still in flight. Route by the authenticated native event identity, not by
	// the mere presence of a controller-managed gate, so an older immutable
	// character delivery cannot be mistaken for a card/action delivery.
	if (interactiveChoice?.nativeInputGate?.controllerManaged && message?.nativeEventId === interactiveChoice.nativeInputGate.nativeEventId) {
		return applyManagedNativeActionDelivery(message);
	}
	if (interactiveChoice?.nativeInputGate?.controllerManaged &&
		message?.nativeEventId !== interactiveChoice.nativeInputGate.nativeEventId &&
		message?.nativeEventId !== interactiveChoice.nativeEventId) {
		throw new Error("NATIVE_ACTION_STALE_DELIVERY_REJECTED");
	}
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

async function applyManagedNativeResponseDelivery(message) {
	const gate = interactiveChoice?.nativeResponseGates?.get(message?.nativeEventId);
	if (!gate || !validHostCommand(message) || message.nativeEventId !== gate.nativeEventId || message.seatId !== gate.seatId ||
		typeof message.choiceId !== "string" || typeof message.deliveryId !== "string" ||
		!(message.resolution?.kind === "player" || message.resolution?.kind === "trustee") || typeof message.resolution.option !== "string") {
		throw new Error("NATIVE_RESPONSE_DELIVERY_REJECTED");
	}
	const optionId = message.resolution.option;
	const prior = gate.delivery;
	if (prior) {
		if (prior.choiceId !== message.choiceId || prior.deliveryId !== message.deliveryId || prior.optionId !== optionId) {
			throw new Error("NATIVE_RESPONSE_DELIVERY_CONFLICT");
		}
		if (prior.status === "applying" || prior.status === "dispatched") return;
		if (prior.status !== "applied") throw new Error("NATIVE_RESPONSE_DELIVERY_UNCERTAIN");
		process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: prior.choiceId,
			deliveryId: prior.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true,
			nativeResponseEventCompleted: true, nativeUseCardChildCount: gate.useCardChildrenCompleted });
		return;
	}
	if (gate.status !== "waiting" || !gate.optionIds.includes(optionId)) throw new Error("NATIVE_RESPONSE_OPTION_REJECTED");
	const delivery = gate.delivery = { choiceId: message.choiceId, deliveryId: message.deliveryId, optionId, status: "applying" };
	await notifyChoiceDeliveryApplying({ ...delivery, nativeEventId: gate.nativeEventId, seatId: gate.seatId });
	const applied = await cdp.send("Runtime.evaluate", { expression: `(()=>{
	 const s=window.__v2NativeStartDiagnosticState,g=s?.managedNativeResponseGates?.get(${JSON.stringify(gate.nativeEventId)}),o=g?.options?.get(${JSON.stringify(optionId)}),
	  core=window.__v2ManagedEngine?.core,game=core?.game,event=g?.event,player=event?.player;
	 if(!g||s.managedNativeResponseGates.get(${JSON.stringify(gate.nativeEventId)})!==g||g.status!=='waiting'||g.waitResolved||!g.waitEvent||g.waitEvent.parent!==event||event?.__v2NativeEventId!==${JSON.stringify(gate.nativeEventId)}||player?.playerid!==${JSON.stringify(gate.seatId)}||!o||o.event!==event||o.seatId!==${JSON.stringify(gate.seatId)}||!core||game.me!==null)return {ok:false,code:'NATIVE_RESPONSE_BINDING_REJECTED'};
	 if(o.kind==='decline'){
	  if(event.forced===true||${JSON.stringify(optionId)}!==g.declineOptionId)return {ok:false,code:'NATIVE_RESPONSE_DECLINE_REJECTED'};
	  g.status='applying';g.delivery={choiceId:${JSON.stringify(message.choiceId)},deliveryId:${JSON.stringify(message.deliveryId)},optionId:${JSON.stringify(optionId)},status:'applying'};
	  event.result={bool:false};g.waitResolved=true;g.resolveWait();return {ok:true,kind:'decline',globalPaused:Boolean(core._status?.paused)};
	 }
	 const {card,target}=o;
	 let legal=false;const previousStatusEvent=core._status?.event;
	 try{if(core._status)core._status.event=event;legal=o.kind==='card'&&player.getCards(event.position||'hs').includes(card)&&event.filterCard?.(card,player,event)&&
	  event.filterTarget?.(card,player,target)&&core.lib.filter.targetEnabled(card,player,target)}finally{if(core._status)core._status.event=previousStatusEvent}
	 if(!legal)return {ok:false,code:'NATIVE_RESPONSE_REVALIDATION_REJECTED'};
	 if(g.status!=='waiting'||g.useCardChildrenStarted!==0)return {ok:false,code:'NATIVE_RESPONSE_ALREADY_APPLIED'};
	 g.status='applying';g.delivery={choiceId:${JSON.stringify(message.choiceId)},deliveryId:${JSON.stringify(message.deliveryId)},optionId:${JSON.stringify(optionId)},status:'applying'};
	 event.result={bool:true,card:core.get.autoViewAs(card),cards:[card],targets:[target]};g.waitResolved=true;g.resolveWait();
	 return {ok:true,kind:'card',cardName:card.name||null,targetSeatId:target.playerid,globalPaused:Boolean(core._status?.paused)};
	})()`, returnByValue: true }, 1500);
	const value = applied.result?.value;
	if (applied.exceptionDetails || value?.ok !== true) {
		delivery.status = "uncertain";
		throw new Error(value?.code || "NATIVE_RESPONSE_APPLY_UNCERTAIN");
	}
	delivery.status = "dispatched";
}

async function applyManagedNativeActionDelivery(message) {
	const gate = interactiveChoice?.nativeInputGate;
	if (!gate || !validHostCommand(message) || message.nativeEventId !== gate.nativeEventId || message.seatId !== gate.seatId ||
		typeof message.choiceId !== "string" || typeof message.deliveryId !== "string" ||
		!(["player", "trustee"].includes(message.resolution?.kind)) || typeof message.resolution?.option !== "string") {
		throw new Error("NATIVE_ACTION_DELIVERY_REJECTED");
	}
	const prior = gate.actionDeliveries?.get(gate.seatId);
	if (prior) {
		if (prior.choiceId !== message.choiceId || prior.deliveryId !== message.deliveryId || prior.option !== message.resolution.option) {
			throw new Error("NATIVE_ACTION_DELIVERY_CONFLICT");
		}
		if (prior.status === "applying") return;
		// A choice-controller retry may arrive while the native child is already
		// applied but the authority Event #4 ACK is still in flight. Join the same
		// immutable commit promise; never fail the host or re-run useResult/useCard.
		if (prior.status === "native_applied_authority_pending" && prior.authorityCommitPromise) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_action_authority_pending_retry_v1", stage: "native_action_delivery_joined_authority_commit",
					choiceId: prior.choiceId, deliveryId: prior.deliveryId } });
			await prior.authorityCommitPromise;
		}
		if (prior.status !== "authority_committed" && prior.status !== "applied") throw new Error("NATIVE_ACTION_DELIVERY_UNCERTAIN");
		const proofResponse = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,a=s?.nativeAction,o=window.__v2ManagedNativeActionOptions?.get(${JSON.stringify(prior.option)}),p=o?.event?.player;return {eventId:a?.eventId||null,seatId:a?.seatId||null,optionId:a?.optionId||null,useResultCount:a?.useResultCount||0,childWaitCompleted:a?.nativeChildWaitCompleted===true,eventInstanceMatches:a?.nativeEventInstanceMatches===true,nativeEventStepAfterWait:a?.nativeEventStepAfterWait??null,cardInHand:Boolean(o&&p?.getCards('h').includes(o.card)),hostPlayerAbsent:window.__v2ManagedEngine?.core?.game?.me===null}})()`, returnByValue: true }, 1500);
		const proof = proofResponse.result?.value;
		if (proofResponse.exceptionDetails || proof?.eventId !== gate.nativeEventId || proof?.seatId !== gate.seatId ||
			proof?.optionId !== prior.option || proof?.useResultCount !== 1 || !proof?.childWaitCompleted ||
			!proof?.eventInstanceMatches || proof?.nativeEventStepAfterWait < 5 || proof?.cardInHand || !proof?.hostPlayerAbsent) {
			throw new Error("NATIVE_ACTION_DUPLICATE_PROOF_REJECTED");
		}
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_action_delivery_proof", stage: "native_action_duplicate_delivery_verified", snapshot: proof } });
		process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: prior.choiceId, deliveryId: prior.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true });
		return;
	}
	if (gate.status !== "waiting" || !gate.optionIds.includes(message.resolution.option)) throw new Error("NATIVE_ACTION_OPTION_REJECTED");
	// Reserve before touching the engine. An ambiguous CDP outcome is never replayed.
	const record = { choiceId: message.choiceId, deliveryId: message.deliveryId, option: message.resolution.option, status: "applying" };
	gate.actionDeliveries.set(gate.seatId, record);
	if (process.env.V2_MANAGED_NATIVE_FAULT_INJECTION === "delivery_stop_barrier") {
		const proof = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState;return {eventId:s?.nativeAction?.eventId||null,seatId:s?.nativeAction?.seatId||null,useResultCount:s?.nativeAction?.useResultCount||0,gateStatus:s?.nativeInputResumeGate?.status||null,gameMeAbsent:window.__v2ManagedEngine?.core?.game?.me===null}})()`, returnByValue: true }, 1500);
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_action_test_barrier_v1", stage: "native_action_delivery_barrier_entered", snapshot: proof.result?.value || null } });
		await new Promise(() => {}); // Test-only barrier is released by supervised process stop, never by a player command.
	}
	if (process.env.V2_MANAGED_NATIVE_FAULT_INJECTION === "before_native_apply") {
		record.status = "uncertain";
		throw new Error("NATIVE_ACTION_APPLY_UNCERTAIN");
	}
	await notifyChoiceDeliveryApplying({ choiceId: record.choiceId, deliveryId: record.deliveryId,
		nativeEventId: gate.nativeEventId, seatId: gate.seatId });
	const expression = `(()=>{const s=window.__v2NativeStartDiagnosticState,g=s?.nativeInputResumeGate,o=window.__v2ManagedNativeActionOptions;
	 const fault=${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")};
	 const id=${JSON.stringify(gate.nativeEventId)},seat=${JSON.stringify(gate.seatId)},option=${JSON.stringify(message.resolution.option)};
	 const {game,lib,get}=window.__v2ManagedEngine.core,e=g?.event,p=e?.player,m=o?.get(option);
	 if(!g||g.status!=='waiting'||g.nativeEventId!==id||g.seatId!==seat||e!==s.inputEvent||e.__v2NativeEventId!==id||p?.playerid!==seat||!m||m.event!==e||m.seatId!==seat)return {ok:false,code:'NATIVE_ACTION_BINDING_REJECTED'};
	 const {card,target}=m;if(!p.getCards(e.position||'h').includes(card)||!e.filterCard?.(card,p,e)||!e.filterTarget?.(card,p,target)||!lib.filter.targetEnabled(card,p,target))return {ok:false,code:'NATIVE_ACTION_REVALIDATION_REJECTED'};
	 if(s.nativeAction?.eventId===id)return {ok:false,code:'NATIVE_ACTION_ALREADY_APPLYING'};
	 g.status='applying';s.nativeInputGate.status='applying';s.nativeAction={eventId:id,seatId:seat,optionId:option,cardName:card.name||null,targetSeatId:target.playerid,useResultCount:0,status:'applying'};
	 if(fault==='before_native_result_set')throw Error('NATIVE_RESULT_SET_INJECTED_FAILURE');
	 e.result={bool:true,card:get.autoViewAs(card),cards:[card],targets:[target]};game.resume();return {ok:true};})()`;
	try {
		const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 1500);
		const outcome = response.result?.value;
		if (response.exceptionDetails || !outcome?.ok) throw new Error(outcome?.code || "NATIVE_ACTION_APPLY_UNCERTAIN");
		// Reproduce the ambiguous boundary where Chromium may have accepted and
		// resumed the native event but its command acknowledgement is unavailable.
		// The record remains reserved and this supervised host fails closed.
		if (process.env.V2_MANAGED_NATIVE_FAULT_INJECTION === "cdp_result_unknown_after_dispatch") {
			throw new Error("NATIVE_ACTION_APPLY_UNCERTAIN");
		}
		gate.status = "applying";
	} catch (error) { record.status = "uncertain"; throw error; }
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

async function commitNativeCardActionAuthority(gate, record) {
	if (record.authorityCommitPromise) return record.authorityCommitPromise;
	record.authorityCommitPromise = (async () => {
		if (!process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4")) {
			record.status = "applied";
			gate.status = "applied";
			process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: record.choiceId,
				deliveryId: record.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true });
			return;
		}
		const base = interactiveChoice?.openingAuthoritySummary;
		if (!base || base.revision !== 3 || !Array.isArray(base.seats) || !/^[a-f0-9]{64}$/.test(interactiveChoice.openingAuthorityDigest || "")) {
			throw new Error("NATIVE_ACTION_AUTHORITY_PREDECESSOR_MISSING");
		}
		const response = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,a=s?.nativeAction,o=window.__v2ManagedNativeActionOptions?.get(${JSON.stringify(record.option)}),c=window.__v2ManagedGame,core=window.__v2ManagedEngine?.core,game=core?.game;
		 if(!a||a.eventId!==${JSON.stringify(gate.nativeEventId)}||a.seatId!==${JSON.stringify(gate.seatId)}||a.optionId!==${JSON.stringify(record.option)}||a.useResultCount!==1||a.nativeChildWaitCompleted!==true||a.nativeEventInstanceMatches!==true||a.nativeEventStepAfterWait<5||!o||!c||c.authorityState.revision!==3||game?.me!==null||game?.players?.some(p=>p.ws))return {ok:false,code:'NATIVE_ACTION_STATE_NOT_COMMITTED'};
		 const hands=game.players.map(p=>({seatId:p.playerid,handCount:p.countCards('h'),hand:p.getCards('h').map(card=>({name:card.name||null,suit:card.suit||null,number:card.number||null,nature:card.nature||null}))}));
		 const state=window.__v2ManagedUnifiedRoot;
		 return {ok:true,eventStep:a.nativeEventStepAfterWait,seatId:a.seatId,optionId:a.optionId,cardName:a.cardName,targetSeatId:a.targetSeatId,useResultCount:a.useResultCount,useCardChildName:a.nativeUseCardChildName||null,useCardChildStep:Number.isSafeInteger(a.nativeUseCardChildStep)?a.nativeUseCardChildStep:null,nativeUseCardChildCompleted:a.nativeUseCardChildCompleted===true,usedCardPosition:core.get.position(o.card),nativeChildWaitCompleted:a.nativeChildWaitCompleted,nativeEventInstanceMatches:a.nativeEventInstanceMatches,gameMeNull:game.me===null,connectedTransports:game.players.filter(p=>p.ws).length,hands,firstActSeatId:core?._status?.firstAct?.playerid||null,rootInstanceId:state?.rootInstanceId||null,rootMatches:state?.root===core?._status?.eventManager?.rootEvent}})()`, returnByValue: true }, 2000);
		const observed = response.result?.value;
		let rejectionCode = response.exceptionDetails ? "CDP_EXCEPTION" : !observed?.ok ? (observed?.code || "STATE_QUERY") :
			observed.seatId !== gate.seatId ? "SEAT" : observed.optionId !== record.option ? "OPTION" :
			observed.useCardChildName !== "useCard" ? "CHILD_NAME" : !Number.isSafeInteger(observed.useCardChildStep) ? "CHILD_STEP" :
			observed.nativeUseCardChildCompleted !== true ? "CHILD_NOT_COMPLETED" : !observed.nativeChildWaitCompleted ? "WAIT_NOT_COMPLETED" :
			!observed.nativeEventInstanceMatches ? "EVENT_INSTANCE" : observed.gameMeNull !== true ? "GAME_ME" :
			observed.connectedTransports !== 0 ? "TRANSPORT" : observed.firstActSeatId !== gate.seatId ? "FIRST_ACT" :
			observed.hands?.length !== base.seats.length ? "HAND_SET" : null;
		if (rejectionCode) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_action_authority_proof_diagnostic_v1", stage: "event4_local_proof_rejected",
					rejectionCode, useCardChildName: observed?.useCardChildName || null,
					useCardChildStep: Number.isSafeInteger(observed?.useCardChildStep) ? observed.useCardChildStep : null,
					nativeUseCardChildCompleted: observed?.nativeUseCardChildCompleted === true,
					nativeChildWaitCompleted: observed?.nativeChildWaitCompleted === true,
					nativeEventInstanceMatches: observed?.nativeEventInstanceMatches === true,
					gameMeNull: observed?.gameMeNull === true, connectedTransports: observed?.connectedTransports ?? null,
					firstActMatches: observed?.firstActSeatId === gate.seatId, handSeatCount: observed?.hands?.length ?? null } });
			throw new Error(`NATIVE_ACTION_AUTHORITY_PROOF_${rejectionCode}`);
		}
		if (interactiveChoice.nativeRootInstanceId &&
			(observed.rootInstanceId !== interactiveChoice.nativeRootInstanceId || observed.rootMatches !== true)) {
			throw new Error("NATIVE_ACTION_AUTHORITY_ROOT_MISMATCH");
		}
		const seats = observed.hands.map((seat, index) => {
			const previous = base.seats[index];
			if (seat.seatId !== previous.seatId) throw new Error("NATIVE_ACTION_AUTHORITY_SEAT_ORDER_REJECTED");
			return { seatId: seat.seatId, position: previous.position, character: previous.character, side: previous.side,
				handCount: seat.handCount, handCommitment: createHash("sha256").update(canonicalize(seat.hand)).digest("hex") };
		});
		const responseGates = [...(interactiveChoice.nativeResponseGates?.values() || [])]
			.filter(responseGate => responseGate.actionEventId === gate.nativeEventId);
		const responseActions = responseGates.map(responseGate => {
			const result = responseGate.completedProof;
			if (responseGate.status !== "applied" || !result || result.rootInstanceId !== observed.rootInstanceId ||
				!responseGate.optionIds.includes(result.optionId) || responseGate.optionKinds[result.optionId] !== result.kind ||
				result.nativeEventId !== responseGate.nativeEventId || result.actionEventId !== gate.nativeEventId ||
				result.seatId !== responseGate.seatId || result.sourceSeatId !== responseGate.sourceSeatId ||
				!(result.kind === "card" ? result.forced === responseGate.forced && result.useCardChildrenStarted === 1 &&
					result.useCardChildrenCompleted === 1 && typeof result.targetSeatId === "string" :
					result.kind === "decline" && result.forced === false && result.useCardChildrenStarted === 0 &&
					result.useCardChildrenCompleted === 0 && result.targetSeatId === null)) {
				process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
					observed: { kind: "native_response_authority_rejected_v1", stage: "native_response_authority_proof_rejected",
						eventIdBound: responseGate.actionEventId === gate.nativeEventId,
						gateStatus: responseGate.status, completedProofPresent: Boolean(result),
						rootMatches: result?.rootInstanceId === observed.rootInstanceId,
						optionBound: Boolean(result && responseGate.optionIds.includes(result.optionId) && responseGate.optionKinds[result.optionId] === result.kind),
						seatBound: result?.seatId === responseGate.seatId && result?.sourceSeatId === responseGate.sourceSeatId,
						eventBound: result?.nativeEventId === responseGate.nativeEventId && result?.actionEventId === gate.nativeEventId,
						forcedMatches: result?.forced === responseGate.forced,
						resultKind: result?.kind || null, forced: result?.forced ?? null,
						targetSeatPresent: typeof result?.targetSeatId === "string",
						useCardChildrenStarted: result?.useCardChildrenStarted ?? null,
						useCardChildrenCompleted: result?.useCardChildrenCompleted ?? null } });
				throw new Error("NATIVE_RESPONSE_AUTHORITY_EVIDENCE_INCOMPLETE");
			}
			return { nativeEventId: result.nativeEventId, actionEventId: result.actionEventId,
				seatId: result.seatId, sourceSeatId: result.sourceSeatId,
				kind: result.kind, optionId: result.optionId, targetSeatId: result.targetSeatId, forced: result.forced,
				useCardChildrenStarted: result.useCardChildrenStarted, useCardChildrenCompleted: result.useCardChildrenCompleted,
				rootInstanceId: result.rootInstanceId };
		});
		const after = { revision: 4, firstActSeatId: base.firstActSeatId, seats, responses: responseActions,
			action: { nativeEventId: gate.nativeEventId, nativeEventName: "gongJiOrFaShu", seatId: gate.seatId,
				cardName: observed.cardName, targetSeatId: observed.targetSeatId, optionId: record.option,
				usedCardPosition: observed.usedCardPosition } };
		const responseSeatIds = [...new Set([gate.seatId, ...responseActions.filter(item => item.kind === "card").map(item => item.seatId)])];
		const changedHandSeatIds = seats.filter((seat, index) => seat.handCount !== base.seats[index]?.handCount ||
			seat.handCommitment !== base.seats[index]?.handCommitment).map(seat => seat.seatId);
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_response_action_summary_v1", stage: "native_response_action_summary",
				actionSeatId: gate.seatId, responseCount: responseActions.length, responseSeatIds, changedHandSeatIds } });
		const afterDigest = createHash("sha256").update(canonicalize(after)).digest("hex");
		const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 4, stateRevisionBefore: 3,
			stateRevisionAfter: 4, beforeDigest: interactiveChoice.openingAuthorityDigest, afterDigest,
			beforeSummary: base, afterSummary: after,
			event: { kind: "xingbei_native_card_action_v1", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
				nativeEventId: gate.nativeEventId, nativeEventCompleted: true, seatId: gate.seatId, cardName: observed.cardName,
				...(observed.rootInstanceId ? { rootInstanceId: observed.rootInstanceId } : {}),
				targetSeatId: observed.targetSeatId, optionId: record.option, nativeEventStep: observed.eventStep,
				useResultCount: observed.useResultCount, useCardChildName: observed.useCardChildName, useCardChildStep: observed.useCardChildStep,
				nativeUseCardChildCompleted: observed.nativeUseCardChildCompleted, usedCardPosition: observed.usedCardPosition,
				nativeChildWaitCompleted: observed.nativeChildWaitCompleted,
				nativeEventInstanceMatches: observed.nativeEventInstanceMatches, gameMeNull: observed.gameMeNull,
				connectedTransports: observed.connectedTransports, responseActions } };
		const acknowledgement = waitForAuthorityEventAck(4, 4, afterDigest, 8000);
		const acknowledged = acknowledgement.then(accepted => ({ done: true, accepted }), error => ({ done: true, error }));
		let ackResult = null;
		for (let attempt = 0; attempt < 3 && !ackResult; attempt++) {
			try {
				await new Promise((resolve, reject) => {
					if (!process.send) return reject(new Error("NATIVE_ACTION_AUTHORITY_SEND_FAILED"));
					process.send({ ...identity, type: "host_authority_event", proof }, error => error ? reject(error) : resolve());
				});
			} catch (error) {
				if (attempt === 2) throw new Error("NATIVE_ACTION_AUTHORITY_SEND_FAILED", { cause: error });
			}
			if (attempt < 2) ackResult = await Promise.race([acknowledged, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
		}
		if (!ackResult) ackResult = await acknowledged;
		if (ackResult.error) throw ackResult.error;
		// waitForAuthorityEventAck resolves to a boolean only after validating the
		// private host identity and the exact sequence/revision/digest tuple.
		if (ackResult.accepted !== true) throw new Error("NATIVE_ACTION_AUTHORITY_REJECTED");
		const finalized = await cdp.send("Runtime.evaluate", { expression: `(()=>{const c=window.__v2ManagedGame,s=window.__v2ManagedOpeningDraw;if(c?.authorityState?.revision!==3||s?.authorityDigest!==${JSON.stringify(proof.beforeDigest)})return {ok:false};c.authorityState.revision=4;s.authoritySummary=${JSON.stringify(after)};s.authorityDigest=${JSON.stringify(afterDigest)};return {ok:true,revision:c.authorityState.revision}})()`, returnByValue: true }, 1500);
		if (finalized.exceptionDetails || finalized.result?.value?.ok !== true || finalized.result.value.revision !== 4) throw new Error("NATIVE_ACTION_AUTHORITY_FINALIZE_FAILED");
		record.status = "authority_committed";
		gate.status = "authority_committed";
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_authority_event_accepted_v1", stage: "native_card_action_event_4_accepted", eventSequence: 4,
				stateRevision: 4, beforeDigest: proof.beforeDigest, afterDigest, nativeEventName: "gongJiOrFaShu",
				seatId: gate.seatId, nativeUseCardChildCompleted: true,
				hostPlayerAbsent: true, connectedTransports: 0, checkpointAvailable: false } });
		process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: record.choiceId,
			deliveryId: record.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true, authorityEventSequence: 4 });
	})();
	return record.authorityCommitPromise;
}

function emitNativeStartDiagnostic(observed) {
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !observed || typeof observed !== "object") return;
	if (observed.stage === "native_input_wait_open") dispatchManagedNativeActionCandidates(observed.snapshot);
	let nativeResponseAckOutcome = null;
	if (observed.stage === "native_response_applied" && interactiveChoice?.nativeResponseGates?.has(observed.snapshot?.nativeEventId)) {
		const gate = interactiveChoice.nativeResponseGates.get(observed.snapshot.nativeEventId);
		const proof = observed.snapshot;
		const delivery = gate.delivery;
		const selectedKind = delivery && gate.optionKinds?.[delivery.optionId];
		const nativeCompletionValid = proof?.nativeEventId === gate.nativeEventId && proof?.seatId === gate.seatId &&
			proof?.eventName === "yingZhan" && proof?.rootObjectMatches === true &&
			(!gate.rootInstanceId || proof?.rootInstanceId === gate.rootInstanceId) && proof?.gameMeAbsent === true &&
			(selectedKind === "card" ? proof?.bool === true && proof?.selectedKind === "card" &&
				typeof proof?.cardName === "string" && proof.cardName.length > 0 && proof?.useCardChildrenStarted === 1 && proof?.useCardChildrenCompleted === 1 :
				selectedKind === "decline" && proof?.bool === false && proof?.selectedKind === "decline" &&
				proof?.useCardChildrenStarted === 0 && proof?.useCardChildrenCompleted === 0);
		if (delivery && (delivery.status === "applying" || delivery.status === "dispatched") && nativeCompletionValid) {
			gate.status = "applied";
			delivery.status = "applied";
			gate.completedProof = Object.freeze({ nativeEventId: gate.nativeEventId, actionEventId: gate.actionEventId,
				seatId: gate.seatId, sourceSeatId: gate.sourceSeatId, kind: proof.selectedKind,
				optionId: delivery.optionId, targetSeatId: proof.targetSeatId || null, forced: gate.forced,
				useCardChildrenStarted: proof.useCardChildrenStarted, useCardChildrenCompleted: proof.useCardChildrenCompleted,
				rootInstanceId: proof.rootInstanceId });
			if (!delivery.ackSent) {
				delivery.ackSent = true;
				process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: delivery.choiceId,
					deliveryId: delivery.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true,
					nativeResponseEventCompleted: true, nativeUseCardChildCount: proof.useCardChildrenCompleted });
				nativeResponseAckOutcome = "ack_sent";
			} else nativeResponseAckOutcome = "duplicate_ack_suppressed";
		} else if (!nativeCompletionValid) {
			nativeResponseAckOutcome = "completion_proof_rejected";
			process.send?.({ ...identity, type: "host_failure", code: "NATIVE_RESPONSE_COMPLETION_PROOF_REJECTED" });
		}
	} else if (observed.stage === "native_response_applied") {
		nativeResponseAckOutcome = "managed_response_gate_missing";
	}
	if (process.env.V2_NATIVE_MANAGED_RESPONSE === "1" && observed.stage === "native_response_wait_open" &&
		!interactiveChoice?.nativeResponseGates?.has(observed.snapshot?.nativeEventId) && observed.snapshot?.eventName === "yingZhan" &&
		observed.snapshot?.nativeChooseToUseContent !== false && typeof observed.snapshot?.nativeEventId === "string" &&
		typeof observed.snapshot?.actionEventId === "string" && observed.snapshot.actionEventId === interactiveChoice?.nativeInputGate?.nativeEventId &&
		typeof observed.snapshot?.sourceSeatId === "string" &&
		Array.isArray(observed.snapshot?.optionIds) && observed.snapshot.optionIds.length > 0 &&
		observed.snapshot.optionIds.length <= 64 && typeof observed.snapshot?.seatId === "string" &&
		interactiveChoice?.choices?.has(observed.snapshot.seatId) && observed.snapshot?.rootObjectMatches === true) {
		const snapshot = observed.snapshot;
		interactiveChoice.nativeResponseGates ??= new Map();
		if (interactiveChoice.nativeResponseGates.size >= 16) {
			process.send?.({ ...identity, type: "host_failure", code: "NATIVE_RESPONSE_GATE_CAPACITY_REJECTED" });
			return;
		}
		const gate = { nativeEventId: snapshot.nativeEventId, seatId: snapshot.seatId, sourceSeatId: snapshot.sourceSeatId,
			actionEventId: snapshot.actionEventId, forced: snapshot.forced === true,
			status: "waiting", controllerManaged: true, rootInstanceId: snapshot.rootInstanceId,
			optionIds: [...snapshot.optionIds], optionKinds: { ...snapshot.optionKinds }, delivery: null };
		interactiveChoice.nativeResponseGates.set(snapshot.nativeEventId, gate);
		process.send?.({ ...identity, type: "host_native_response_candidates", eventName: "yingZhan",
			eventSequence: 4, nativeEventId: snapshot.nativeEventId, seatId: snapshot.seatId,
			options: [...snapshot.optionIds], optionKinds: snapshot.optionKinds,
			trusteeOption: snapshot.declineOptionId || snapshot.optionIds[0], deadlineMs: 5000 });
	}
	if (observed.stage === "native_input_wait_open") dispatchManagedNativeActionCandidates(observed.snapshot);
	if (interactiveChoice?.nativeInputGate?.controllerManaged && observed.stage === "native_action_event_completed") {
		const gate = interactiveChoice.nativeInputGate;
		const record = gate.actionDeliveries.get(gate.seatId);
		const proof = observed.snapshot?.nativeAction;
		if (record?.status === "applying" && proof?.eventId === gate.nativeEventId && proof?.seatId === gate.seatId &&
			proof?.optionId === record.option && proof?.useResultCount === 1 && proof?.nativeChildWaitCompleted === true &&
			proof?.nativeEventInstanceMatches === true && proof?.cardInHandAfterNativeWait === false &&
			proof?.nativeEventStepAfterWait >= 5 && observed.snapshot?.eventName === "gongJiOrFaShu" &&
			observed.snapshot?.eventFinished === true && observed.snapshot?.hostPlayerAbsent === true) {
			if (process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4")) {
				record.status = "native_applied_authority_pending";
				commitNativeCardActionAuthority(gate, record).catch(error => {
					const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "NATIVE_ACTION_AUTHORITY_UNCERTAIN";
					process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
				});
			} else {
				record.status = "applied";
				gate.status = "applied";
			}
			if (!process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4") && process.env.V2_MANAGED_NATIVE_FAULT_INJECTION !== "cdp_result_unknown_after_dispatch") {
				process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: record.choiceId,
					deliveryId: record.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true });
			}
		}
	}
	const safeObserved = sanitizeNativeStartDiagnostic(observed);
	const entry = Object.freeze({ at: Date.now(), ...safeObserved, ...(nativeResponseAckOutcome ? { nativeResponseAckOutcome } : {}) });
	nativeStartDiagnosticRing.push(entry);
	if (nativeStartDiagnosticRing.length > 128) nativeStartDiagnosticRing.shift();
	process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice?.nativeEventId || null,
		observed: { kind: "native_start_diagnostic", ...entry } });
	if (!nativeFailureReported && ["wait_next_error", "native_useResult_exception", "native_useCard_child_exception"].includes(observed.stage) && interactiveChoice?.nativeInputGate?.controllerManaged) {
		nativeFailureReported = true;
		const code = /^[A-Z0-9_]{3,96}$/.test(observed.snapshot?.failureCode || "") ? observed.snapshot.failureCode : "HOST_NATIVE_EVENT_UNCERTAIN";
		process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
	}
}

function sanitizeNativeStartDiagnostic(value) {
	if (Array.isArray(value)) return value.map(sanitizeNativeStartDiagnostic);
	if (!value || typeof value !== "object") return value;
	const safe = {};
	for (const [key, item] of Object.entries(value)) {
		if (/^(cardName|selectedCardName|handCommitment|secret|credential|hand)$/i.test(key)) continue;
		safe[key] = sanitizeNativeStartDiagnostic(item);
	}
	return safe;
}

function dispatchManagedNativeActionCandidates(snapshot) {
	const managedModes = new Set(["managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry",
		"managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4",
		"managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"]);
	const gate = snapshot?.nativeInputGate;
	if (!interactiveChoice || !managedModes.has(process.env.V2_NATIVE_START_PROBE_MODE) || !gate ||
		gate.eventName !== "gongJiOrFaShu" || gate.action !== true || gate.waiting !== true ||
		!/^native_[A-Za-z0-9_-]{16,96}$/.test(gate.nativeEventId || "") ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(gate.seatId || "") || !Array.isArray(gate.candidates) ||
		gate.candidates.length < 1 || gate.candidates.length > 64 || snapshot.eventName !== "gongJiOrFaShu") return false;
	const current = interactiveChoice.nativeInputGate;
	if (current?.nativeEventId === gate.nativeEventId && current.candidateDispatched === true) return false;
	if (current && current.nativeEventId !== gate.nativeEventId) return false;
	const optionIds = gate.candidates.map(candidate => candidate?.optionId);
	if (optionIds.some(optionId => !/^native_option_[a-f0-9]{32}$/.test(optionId || "")) || new Set(optionIds).size !== optionIds.length) return false;
	const controllerManaged = true;
	interactiveChoice.nativeInputGate = { nativeEventId: gate.nativeEventId, seatId: gate.seatId, status: "waiting", controllerManaged,
		candidateDispatched: true, optionIds, actionDeliveries: new Map() };
	const message = { ...identity, type: "host_native_action_candidates", nativeEventId: gate.nativeEventId,
		eventSequence: 4, seatId: gate.seatId, options: optionIds,
		optionKinds: Object.fromEntries(gate.candidates.map(candidate => [candidate.optionId, candidate.cardType])),
		...(process.env.V2_NATIVE_MANAGED_RESPONSE === "1" ? { responseProbeOptions: gate.candidates.filter(candidate => candidate.responseProbePotential === true).map(candidate => candidate.optionId) } : {}),
		trusteeOption: optionIds[0], deadlineMs: ["managed_input_controller_trustee", "managed_opening_root_action_event4_trustee"].includes(process.env.V2_NATIVE_START_PROBE_MODE) ? 750 : 5000,
		eventName: "gongJiOrFaShu" };
	process.send?.(message, error => {
		if (!error) return;
		if (process.connected) process.send({ ...identity, type: "host_failure", code: "NATIVE_ACTION_CANDIDATE_IPC_FAILED" }, () => cleanup().finally(() => process.exit(1)));
	});
	return true;
}

async function resumeManagedNativeInput(message) {
	const gate = interactiveChoice?.nativeInputGate;
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !gate || gate.controllerManaged || !cdp ||
		typeof message.nativeEventId !== "string" || typeof message.seatId !== "string" || typeof message.optionId !== "string" ||
		Object.keys(message).some(key => !["type", "nativeEventId", "seatId", "optionId"].includes(key)) ||
		gate.nativeEventId !== message.nativeEventId || gate.seatId !== message.seatId || gate.status !== "waiting") {
		throw new Error("NATIVE_INPUT_RESUME_REJECTED");
	}
	const expression = `(()=>{
	 const state=window.__v2NativeStartDiagnosticState,gate=state?.nativeInputResumeGate,options=window.__v2ManagedNativeActionOptions;
	 const nativeEventId=${JSON.stringify(message.nativeEventId)},seatId=${JSON.stringify(message.seatId)},optionId=${JSON.stringify(message.optionId)};
	 const managed=window.__v2ManagedEngine,{game,lib,get}=managed.core,event=gate?.event,player=event?.player,mapping=options?.get(optionId);
	 if(!gate||gate.status!=='waiting'||gate.nativeEventId!==nativeEventId||gate.seatId!==seatId||!event||event!==state.inputEvent||event.__v2NativeEventId!==nativeEventId||player?.playerid!==seatId||!mapping||mapping.event!==event||mapping.seatId!==seatId||mapping.target?.playerid==null) return {ok:false,code:'NATIVE_INPUT_BINDING_REJECTED'};
	 const {card,target}=mapping;
	 if(!player.getCards(event.position||'h').includes(card)||!event.filterCard?.(card,player,event)||!event.filterTarget?.(card,player,target)||!lib.filter.targetEnabled(card,player,target)) return {ok:false,code:'NATIVE_OPTION_REVALIDATION_REJECTED'};
	 if(state.nativeAction?.eventId===nativeEventId) return {ok:false,code:'NATIVE_INPUT_ALREADY_APPLIED'};
	 const result={bool:true,card:get.autoViewAs(card),cards:[card],targets:[target]};
	 gate.status='accepted';clearTimeout(gate.timer);gate.timer=null;gate.acceptedOptionId=optionId;gate.nativeResumeCount=(gate.nativeResumeCount||0)+1;state.nativeInputGate.status='accepted';state.nativeInputGate.acceptedOptionId=optionId;state.nativeInputGate.nativeResumeCount=gate.nativeResumeCount;
	 state.nativeAction={eventId:nativeEventId,seatId,optionId,cardName:card.name||null,targetSeatId:target.playerid,useResultCount:0,status:'accepted'};
	 event.result=result;game.resume();
	 return {ok:true,eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId,cardName:card.name||null,targetSeatId:target.playerid,gameMeAbsent:game.me===null,nativeResumeCount:gate.nativeResumeCount};
	})()`;
	const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 1500);
	const observed = response.result?.value;
	if (!observed?.ok) throw new Error(observed?.code || "NATIVE_INPUT_RESUME_REJECTED");
	gate.status = "accepted";
	emitNativeStartDiagnostic({ stage: "native_input_resume_accepted", classification: "native_event_resumed", snapshot: observed });
}

async function cancelManagedNativeInput(message) {
	const gate = interactiveChoice?.nativeInputGate;
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !gate || !cdp ||
		typeof message.nativeEventId !== "string" || typeof message.seatId !== "string" ||
		Object.keys(message).some(key => !["type", "nativeEventId", "seatId"].includes(key)) ||
		gate.nativeEventId !== message.nativeEventId || gate.seatId !== message.seatId || gate.status !== "waiting") throw new Error("NATIVE_INPUT_CANCEL_REJECTED");
	 const expression = `(()=>{const state=window.__v2NativeStartDiagnosticState,gate=state?.nativeInputResumeGate,event=gate?.event;const id=${JSON.stringify(message.nativeEventId)},seat=${JSON.stringify(message.seatId)};const {game,_status}=window.__v2ManagedEngine.core;
	 if(!gate||gate.status!=='waiting'||gate.nativeEventId!==id||gate.seatId!==seat||!event||event!==state.inputEvent||event.__v2NativeEventId!==id||event.player?.playerid!==seat)return {ok:false,code:'NATIVE_INPUT_CANCEL_BINDING_REJECTED'};
	 gate.status='cancelled';clearTimeout(gate.timer);gate.timer=null;state.nativeInputGate.status='cancelled';state.nativeInputGate.engineResumeCount=(state.nativeInputGate.engineResumeCount||0)+1;state.nativeInputGate.failureCode='NATIVE_INPUT_CANCELLED';event.result={bool:false};game.resume();return {ok:true,gateStatus:gate.status,eventName:event.name,eventStep:event.step,parentEventName:event.parent?.name||null,eventStack:_status.eventManager.eventStack.map(item=>item.name),paused:Boolean(_status.paused),gameMeAbsent:game.me===null,useResultCount:state.nativeInputGate.useResultCount,engineResumeCount:state.nativeInputGate.engineResumeCount}})()`;
	const response=await cdp.send("Runtime.evaluate",{expression,returnByValue:true},1500),observed=response.result?.value;
	if(!observed?.ok)throw new Error(observed?.code||"NATIVE_INPUT_CANCEL_REJECTED");
	gate.status="cancelled";
	emitNativeStartDiagnostic({stage:"native_input_cancelled",classification:"native_gate_cancelled",snapshot:observed});
}

async function runNativeStartDiagnostic(message) {
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !interactiveChoice?.completed || !validHostCommand(message) ||
		!cdp || !["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe", "controlled_block"].includes(message.mode)) throw new Error("NATIVE_START_DIAGNOSTIC_REJECTED");
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
	 const reuseOpeningRoot=${["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(message.mode)};
	 const managedInputController=${["managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(message.mode)};
	 const managedNativeResponse=${process.env.V2_NATIVE_MANAGED_RESPONSE === "1"};
	 const managedInputResume=${["managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(message.mode)};
	 const managedInputDeadlineMs=${message.mode === "managed_input_timeout" ? 1500 : 10000};
	 const managedStart=${message.mode === "managed_start" || message.mode === "managed_input_gate" || ["managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe"].includes(message.mode)};
	 const managed=window.__v2ManagedEngine,{game,lib,get,_status}=managed.core,manager=_status.eventManager,Player=lib.element.Player;
	 const state=reuseOpeningRoot?window.__v2ManagedOpeningDraw:(window.__v2NativeStartDiagnosticState||{traceCount:0,lastSuccessfulEventStep:null,gameStartCount:0,drawCreated:false,drawEntered:false,phaseLoopCreated:false,prepareArenaCalls:0,waitForPlayerCalls:0,randomMapOLCalls:0,chooseCharacterCalls:0,phaseCalls:0,rootPromiseState:'not_started',failureCode:null});
	 window.__v2NativeStartDiagnosticState=state;
	 if(!state.managedResponseTraceWrapped&&typeof window.__v2NativeStartTrace==='function'){
	  const nativeTrace=window.__v2NativeStartTrace;
	  window.__v2NativeStartTrace=function(payload){try{const item=JSON.parse(payload);if(item?.stage==='native_response_wait_open'){const gate=state.managedNativeResponseGates?.get(item.snapshot?.nativeEventId);if(gate){item.snapshot.sourceSeatId=gate.sourceSeatId||null;item.snapshot.actionEventId=gate.actionEventId||null;item.snapshot.forced=gate.forced===true;payload=JSON.stringify(item)}}}catch{}return nativeTrace(payload)};
	  state.managedResponseTraceWrapped=true;
	 }
	 const snapshot=()=>{const current=_status.event,top=manager.eventStack.at(-1),phaseLoop=state.phaseLoop,phaseEvent=phaseLoop?.next?.find(event=>event.name==='phase'&&event.player===_status.firstAct);return {eventName:current?.name||null,eventStep:Number.isSafeInteger(current?.step)?current.step:null,parentEventName:current?.parent?.name||null,rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,eventStackDepth:manager.eventStack.length,eventStackTop:top?.name||null,eventStack:manager.eventStack.map(event=>event.name),eventStackDetails:manager.eventStack.map(event=>({eventName:event.name||null,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,finished:Boolean(event.finished),nextCount:Array.isArray(event.next)?event.next.length:null,nextHeadName:event.next?.[0]?.name||null,nextHeadStep:Number.isSafeInteger(event.next?.[0]?.step)?event.next[0].step:null,nextHeadFinished:Boolean(event.next?.[0]?.finished)})),connectMode:Boolean(_status.connectMode),paused:Boolean(_status.paused),gameStartTriggered:state.gameStartCount>0,gameStartCount:state.gameStartCount,gameDrawCreated:state.drawCreated,gameDrawEntered:state.drawEntered,gameDrawParentName:state.drawParentName||state.draw?.parent?.name||null,phaseLoopCreated:state.phaseLoopCreated,phaseLoopStartRequested:state.phaseLoopStartRequested||false,phaseLoopStarted:state.phaseLoopStarted||false,phaseLoopPaused:state.phaseLoopPaused||false,phaseLoopReleased:state.phaseLoopReleased||false,phaseLoopParentName:phaseLoop?.parent?.name||state.phaseLoopParentName||null,firstPhaseEventName:phaseEvent?.name||null,firstPhaseParentName:phaseEvent?.parent?.name||null,firstPhaseGate:state.firstPhaseGate||null,nativeInputGate:state.nativeInputGate||null,nativeInputGateStatus:state.nativeInputResumeGate?.status||null,nativeAction:state.nativeAction||null,nativeResponseGates:[...(state.managedNativeResponseGates?.values()||[])].slice(-16).map(gate=>({nativeEventId:gate.nativeEventId,seatId:gate.seatId,eventName:gate.eventName,eventStep:Number.isSafeInteger(gate.event?.step)?gate.event.step:null,status:gate.status,waitEventName:gate.waitEvent?.name||null,waitEventFinished:Boolean(gate.waitEvent?.finished),waitResolved:gate.waitResolved===true,optionCount:gate.optionIds?.length||0,deliveryStatus:gate.delivery?.status||null,useCardChildrenStarted:gate.useCardChildrenStarted||0,useCardChildrenCompleted:gate.useCardChildrenCompleted||0})),testFaultMode:${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")},prepareArenaCalls:state.prepareArenaCalls,waitForPlayerCalls:state.waitForPlayerCalls,randomMapOLCalls:state.randomMapOLCalls,chooseCharacterCalls:state.chooseCharacterCalls,phaseCalls:state.phaseCalls,currentPhaseSeatId:_status.currentPhase?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,pendingChoiceEventName:/choose|respond|useCard/i.test(current?.name||'')?current.name:null,pendingChoiceSeatId:current?.player?.playerid||null,hostPlayerAbsent:game.me===null,seats:game.players.map(player=>({seatId:player.playerid||null,characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')})),nativeEventTrail:(state.nativeEventTrail||[]).slice(-12),lastSuccessfulEventStep:state.lastSuccessfulEventStep,rootPromiseState:state.rootPromiseState,failureCode:state.failureCode,traceCount:state.traceCount}};
	 const ring=state.ring||(state.ring=[]);let emittedMilestones=0,emittedSteps=0,lastEventStepToken='';
	 const emit=stage=>{state.traceCount++;const snap=snapshot();ring.push({stage,snapshot:snap});if(ring.length>128)ring.shift();const token=[snap.eventName,snap.eventStep].join(':');const milestone=new Set(['root_event_created','root_start_dispatched','wait_for_player_called','random_map_ol_called','prepare_arena_called','choose_character_called','game_start_trigger','game_draw_called','phase_loop_called','phase_called','native_input_gate','native_input_gate_waiting','native_input_wait_open','native_input_resume_accepted','native_input_resume_rejected','native_input_cancelled','native_input_cancel_rejected','native_input_gate_expired','native_useResult_entered','native_useResult_dispatched','native_useResult_exception','native_useCard_child_exception','native_action_child_wait_completed','root_promise_fulfilled','root_promise_rejected','wait_next_error']).has(stage);const criticalFailure=['native_input_gate_expired','native_input_resume_rejected','native_input_cancel_rejected','native_useResult_exception','native_useCard_child_exception','root_promise_rejected','wait_next_error'].includes(stage);const changedStep=token!==lastEventStepToken;lastEventStepToken=token;if(milestone){if(!criticalFailure&&emittedMilestones++>=64)return}else if(changedStep){if(emittedSteps++>=64)return}else return;const payload={kind:'native_start_trace_v1',stage,snapshot:snap};try{window.__v2NativeStartTrace(JSON.stringify(payload))}catch{}};
	 if(!state.instrumented){
	  state.instrumented=true;
	 const GameEvent=lib.element.GameEvent,originalStart=GameEvent.prototype.start,originalWaitNext=GameEvent.prototype.waitNext,originalLoop=GameEvent.prototype.loop,originalTrigger=GameEvent.prototype.trigger,originalCreateEvent=game.createEvent,originalWaitForPlayer=game.waitForPlayer,originalPrepareArena=game.prepareArena,originalChooseCharacter=game.chooseCharacter,originalRandomMapOL=game.randomMapOL,originalDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop,originalPhase=Player.prototype.phase,originalUseResult=Player.prototype.useResult;
	  const observeNativeInputGate=event=>{
	   const player=event.player,options=new Map(),seenOperations=new Map();let cardFilterPassed=0,targetFilterPassed=0,filterErrors=0,unsupportedCardShapes=0;
	   const rangeIsOne=value=>Array.isArray(value)?value[0]===1&&value[1]===1:value===1;
	   const responseProbePossible=(incoming,defender,source)=>{const incomingXiBie=get.xiBie(incoming),canYingZhan=incomingXiBie!=='an';for(const candidate of defender.getCards('hs')){let type,name;try{type=get.type(candidate,defender);name=get.name(candidate);if(type==='gongJi'){if(!canYingZhan)continue;if(name!=='anMie'&&get.xiBie(candidate)!==incomingXiBie)continue}else if(type==='faShu'){if(name!=='shengGuang')continue}else continue;if(!lib.filter.cardEnabled(candidate,defender,'forceEnable'))continue;const info=get.info(get.autoViewAs(candidate)),targetRange=info?.selectTarget===undefined?(info?.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(!rangeIsOne(targetRange))continue;for(const target of game.players){if(target!==source&&target.side!==defender.side&&lib.filter.targetEnabled(candidate,defender,target))return true}}catch{}}return false};
	   const actionCardRange=get.select(event.selectCard),eventShapeSupported=rangeIsOne(actionCardRange)&&rangeIsOne(get.select(event.selectTarget))&&!event.filterOk&&!Object.values(event.custom?.add||{}).some(value=>typeof value==='function')&&!Object.values(event.custom?.replace||{}).some(value=>typeof value==='function');
	   for(const card of player.getCards(event.position||'h')){try{if(!eventShapeSupported||typeof event.filterCard!=='function'||!event.filterCard(card,player,event))continue;cardFilterPassed++;const info=get.info(get.autoViewAs(card));if(!info||info.complexSelect||info.complexTarget||info.multitarget||info.singleCard||typeof info.selectTarget==='function'){unsupportedCardShapes++;continue}const targetRange=info.selectTarget===undefined?(info.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(!rangeIsOne(targetRange)){unsupportedCardShapes++;continue}for(const target of game.players){try{if(event.filterTarget?.(card,player,target)&&lib.filter.targetEnabled(card,player,target)){let targets=seenOperations.get(card);if(!targets){targets=new Set();seenOperations.set(card,targets)}if(targets.has(target))continue;targets.add(target);targetFilterPassed++;const bytes=crypto.getRandomValues(new Uint8Array(16));const optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(optionId,Object.freeze({card,target,event,seatId:player.playerid}))}}catch{filterErrors++}}}catch{filterErrors++}}
	   if(options.size>64)throw Error('NATIVE_ACTION_OPTION_CAPACITY_REJECTED');
	   if(options.size===0)throw Error('NATIVE_ACTION_NO_SUPPORTED_CANDIDATE');
	   window.__v2ManagedNativeActionOptions=options;
	   const eventBytes=crypto.getRandomValues(new Uint8Array(16));const nativeEventId='native_event_'+Array.from(eventBytes,value=>value.toString(16).padStart(2,'0')).join('');event.__v2NativeEventId=nativeEventId;
	   state.nativeInputGate={nativeEventId,eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:player.playerid,action:Boolean(event.action),handCount:player.countCards('h'),nativeCardFilterPassCount:cardFilterPassed,nativeTargetFilterPassCount:targetFilterPassed,nativeCandidateMappingCount:options.size,candidates:[...options].map(([optionId,item])=>({optionId,cardName:item.card.name||null,cardType:get.type(item.card,player)||null,targetSeatId:item.target.playerid||null,...(managedNativeResponse?{responseProbePotential:get.type(item.card,player)==='gongJi'&&responseProbePossible(item.card,item.target,player)}:{})})),supportedOptionShape:'one-native-physical-card-one-native-target',eventShapeSupported,unsupportedCardShapes,filterErrors,gateBeforeAiBranch:true,offlineAiPrevented:true,nativeAiResultPending:event.result==='ai',eventIsMine:Boolean(event.isMine()),eventIsOnline:Boolean(event.isOnline()),gameMeAbsent:game.me===null,useResultCount:0};emit('native_input_gate')
	  };
	  const nativeResponseContentNames=new WeakMap(),originalSetContent=GameEvent.prototype.setContent;
	  GameEvent.prototype.setContent=function(content,...args){if(this.name==='yingZhan'&&typeof content==='string')nativeResponseContentNames.set(this,content);return originalSetContent.call(this,content,...args)};
	  const prepareManagedNativeResponseGate=event=>{if(!managedNativeResponse||event.name!=='yingZhan'||event.__v2ManagedResponseGate)return null;let actionParent=null;for(let parent=event.parent,count=0;parent&&count<24;parent=parent.parent,count++){if(parent.name==='gongJiOrFaShu'){actionParent=parent;break}}const activeAction=state.nativeInputResumeGate;if(!activeAction||actionParent!==activeAction.event||actionParent.__v2NativeEventId!==activeAction.nativeEventId)return null;const player=event.player;if(!player||typeof event.filterCard!=='function'||typeof event.filterTarget!=='function')return null;
	   const options=new Map(),optionKinds={},seen=new Map(),rangeIsOne=value=>Array.isArray(value)?value[0]===1&&value[1]===1:value===1;
	   if(!rangeIsOne(get.select(event.selectCard))||event.filterOk||Object.values(event.custom?.add||{}).some(value=>typeof value==='function')||Object.values(event.custom?.replace||{}).some(value=>typeof value==='function'))return null;
	   for(const card of player.getCards(event.position||'hs')){let legalCard=false,info;try{legalCard=event.filterCard(card,player,event);if(!legalCard)continue;info=get.info(get.autoViewAs(card));if(!info||info.complexSelect||info.complexTarget||info.multitarget||info.singleCard||typeof info.selectTarget==='function')continue;const targetRange=info.selectTarget===undefined?(info.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(!rangeIsOne(targetRange))continue}catch{continue}
	    for(const target of game.players){try{if(!event.filterTarget(card,player,target)||!lib.filter.targetEnabled(card,player,target))continue;let targets=seen.get(card);if(!targets){targets=new Set();seen.set(card,targets)}if(targets.has(target))continue;targets.add(target);const bytes=crypto.getRandomValues(new Uint8Array(16)),optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(optionId,Object.freeze({kind:'card',event,seatId:player.playerid,card,target}));optionKinds[optionId]='card'}catch{}}
	   }
	   if(options.size===0)return null;let declineOptionId=null;if(event.forced!==true){const bytes=crypto.getRandomValues(new Uint8Array(16));declineOptionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(declineOptionId,Object.freeze({kind:'decline',event,seatId:player.playerid}));optionKinds[declineOptionId]='decline'}
	   if(options.size>64)throw Error('NATIVE_RESPONSE_OPTION_CAPACITY_REJECTED');const bytes=crypto.getRandomValues(new Uint8Array(16)),nativeEventId='native_event_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
		 const gate={nativeEventId,event,seatId:player.playerid,eventName:event.name,nativeContentName:nativeResponseContentNames.get(event)||null,status:'prepared',options,optionIds:[...options.keys()],optionKinds,declineOptionId,useCardChildrenStarted:0,useCardChildrenCompleted:0,delivery:null,waitPromise:null,resolveWait:null,waitEvent:null,waitResolved:false};gate.waitPromise=new Promise(resolve=>{gate.resolveWait=resolve});event.__v2NativeEventId=nativeEventId;event.__v2ManagedResponseGate=gate;
	   state.managedNativeResponseGates??=new Map();state.managedNativeResponseGates.set(nativeEventId,gate);
	   event.isOnline=()=>true;event.send=function(){if(this!==event||gate.status!=='prepared'||gate.waitEvent||gate.waitResolved)throw Error('NATIVE_RESPONSE_SEND_DUPLICATE_REJECTED');gate.status='waiting';const waitEvent=game.createEvent('managedNativeResponseWait',false,event);if(waitEvent.parent!==event)throw Error('NATIVE_RESPONSE_WAIT_PARENT_REJECTED');waitEvent.setContent(async()=>{await gate.waitPromise});gate.waitEvent=waitEvent;state.managedNativeResponseGate=gate;state.nativeResponseGate={nativeEventId,seatId:player.playerid,eventName:'yingZhan',eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,parentChain:(()=>{const chain=[];for(let parent=event.parent,count=0;parent&&count<8;parent=parent.parent,count++)chain.push(parent.name||null);return chain})(),optionIds:gate.optionIds,optionKinds,declineOptionId,waiting:true,status:gate.status,waitEventName:waitEvent.name,waitEventParentName:waitEvent.parent?.name||null,paused:Boolean(_status.paused),gameMeAbsent:game.me===null};try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_wait_open',snapshot:{...state.nativeResponseGate,rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null}}))}catch{}return this};
	   return gate;
	  };
	  const bindManagedResponseContext=event=>{const gate=event?.__v2ManagedResponseGate;if(!gate||gate.actionEventId)return;let sourceSeatId=null,actionEventId=null;for(let parent=event.parent,count=0;parent&&count<24;parent=parent.parent,count++){if(!sourceSeatId&&parent.name==='useCard')sourceSeatId=parent.player?.playerid||null;if(!actionEventId&&parent.name==='gongJiOrFaShu'&&typeof parent.__v2NativeEventId==='string')actionEventId=parent.__v2NativeEventId}gate.sourceSeatId=sourceSeatId;gate.actionEventId=actionEventId;gate.forced=event.forced===true};
	  const recordNativeResponse=(event,stage)=>{if(!['yingZhan','chooseToRespond'].includes(event?.name))return;const chain=[];for(let parent=event.parent,count=0;parent&&count<8;parent=parent.parent,count++)chain.push(parent.name||null);const nativeContentName=nativeResponseContentNames.get(event)||null,gate=event.__v2ManagedResponseGate;const selected=gate?.delivery?.optionId?gate.options.get(gate.delivery.optionId):null;const snapshot={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,parentChain:chain,eventStack:manager.eventStack.map(item=>item.name||null),eventStackDetails:manager.eventStack.map(item=>({eventName:item.name||null,eventStep:Number.isSafeInteger(item.step)?item.step:null,parentEventName:item.parent?.name||null,seatId:item.player?.playerid||null,finished:Boolean(item.finished),nextCount:Array.isArray(item.next)?item.next.length:null,nextHeadName:item.next?.[0]?.name||null,nextHeadStep:Number.isSafeInteger(item.next?.[0]?.step)?item.next[0].step:null,nextHeadFinished:Boolean(item.next?.[0]?.finished)})),currentEventName:_status.event?.name||null,currentEventStep:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,paused:Boolean(_status.paused),eventIsMine:Boolean(event.isMine()),eventIsOnline:Boolean(event.isOnline()),playerUnderControl:Boolean(event.player?.isUnderControl()),auto:Boolean(_status.auto),waitEventExists:Boolean(gate?.waitEvent),waitResolved:gate?.waitResolved===true,rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,seatId:event.player?.playerid||null,nativeContentName,nativeChooseToUseContent:event.name==='yingZhan'&&nativeContentName==='chooseToUse',resultBool:typeof event.result?.bool==='boolean'?event.result.bool:null,resultCardCount:Array.isArray(event.result?.cards)?event.result.cards.length:0,resultTargetCount:Array.isArray(event.result?.targets)?event.result.targets.length:0,selectedOptionId:gate?.delivery?.optionId||null,selectedKind:selected?.kind||null,selectedCardName:selected?.card?.name||null,selectedTargetSeatId:selected?.target?.playerid||null,responseGateStatus:gate?.status||null,responseUseCardChildrenStarted:gate?.useCardChildrenStarted||0,responseUseCardChildrenCompleted:gate?.useCardChildrenCompleted||0,gameMeAbsent:game.me===null};state.nativeResponseTrace??=[];state.nativeResponseTrace.push({stage,...snapshot});if(state.nativeResponseTrace.length>32)state.nativeResponseTrace.shift();try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_'+stage,snapshot}))}catch{}};
	  GameEvent.prototype.start=function(...args){const event=this,responseEvent=['yingZhan','chooseToRespond'].includes(event.name);let responseChildOwner=null;if(event.name==='useCard'&&event.parent?.name==='yingZhan'&&event.parent.__v2ManagedResponseGate){responseChildOwner=event.parent.__v2ManagedResponseGate;responseChildOwner.useCardChildrenStarted++}if(responseEvent){prepareManagedNativeResponseGate(event);recordNativeResponse(event,'started')}return originalStart.apply(this,args).then(value=>{if(responseChildOwner)responseChildOwner.useCardChildrenCompleted++;if(responseEvent){const gate=event.__v2ManagedResponseGate;recordNativeResponse(event,'completed');if(gate?.delivery?.status==='applying'){const selected=gate.options.get(gate.delivery.optionId),valid=event.result?.bool===true&&selected?.kind==='card'?event.result.cards?.includes(selected.card)&&!event.player.getCards(event.position||'hs').includes(selected.card)&&gate.useCardChildrenStarted===1&&gate.useCardChildrenCompleted===1:event.result?.bool===false&&selected?.kind==='decline'&&event.forced!==true&&gate.useCardChildrenStarted===0;if(!valid)throw Error('NATIVE_RESPONSE_COMPLETION_PROOF_REJECTED');gate.status='applied';gate.delivery.status='applied';gate.completedResult={bool:event.result.bool,selectedKind:selected.kind,cardName:selected.card?.name||null,targetSeatId:selected.target?.playerid||null,useCardChildrenStarted:gate.useCardChildrenStarted,useCardChildrenCompleted:gate.useCardChildrenCompleted};try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_applied',snapshot:{nativeEventId:gate.nativeEventId,seatId:gate.seatId,eventName:event.name,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,...gate.completedResult,gameMeAbsent:game.me===null}}))}catch{}}}if(event===state.nativeUseCardChildEvent&&state.nativeAction){state.nativeAction.nativeUseCardChildCompleted=true;state.nativeAction.nativeUseCardChildStep=Number.isSafeInteger(event.step)?event.step:null;state.nativeAction.nativeUseCardChildName=event.name||null;state.nativeUseCardChildName=event.name||null;emit('native_useCard_child_completed')}if(${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")}==='use_card_child_throws'&&event===state.nativeUseCardChildEvent){const action=state.nativeAction,mapping=window.__v2ManagedNativeActionOptions?.get(action?.optionId),player=event.player;action.status='uncertain';action.childEventName=event.name;action.childEventStep=event.step;action.cardInHandAtFailure=Boolean(mapping&&player.getCards('h').includes(mapping.card));action.nativeUseCardHistoryEntries=player.getHistory('useCard').filter(item=>item===event).length;state.failureCode='NATIVE_USE_CARD_CHILD_FAILED';emit('native_useCard_child_exception');throw Error('INJECTED_USE_CARD_CHILD_SETTLEMENT_EXCEPTION')}if(responseEvent&&event.__v2ManagedResponseGate){const gate=event.__v2ManagedResponseGate,delivery=gate.delivery;if(delivery?.status==='applying'){delivery.status='applied';gate.status='applied';process.send?.({...identity,type:'host_choice_ack',seatId:gate.seatId,choiceId:delivery.choiceId,deliveryId:delivery.deliveryId,nativeEventId:gate.nativeEventId,nativeApplied:true,nativeResponseEventCompleted:true,nativeUseCardChildCount:gate.useCardChildrenCompleted})}}return value})};
	  GameEvent.prototype.waitNext=function(...args){const event=this;if(event.name==='gameDraw')state.drawEntered=true;emit('wait_next_begin');return originalWaitNext.apply(this,args).then(value=>{state.lastSuccessfulEventStep={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null};if(event===state.inputEvent&&state.nativeAction?.eventId===event.__v2NativeEventId&&state.nativeAction.useResultCount===1){const mapping=window.__v2ManagedNativeActionOptions.get(state.nativeAction.optionId);state.nativeAction.nativeChildWaitCompleted=true;state.nativeAction.nativeEventInstanceMatches=event===state.nativeInputResumeGate?.event;state.nativeAction.nativeEventStepAfterWait=Number.isSafeInteger(event.step)?event.step:null;state.nativeAction.cardInHandAfterNativeWait=Boolean(mapping&&event.player.getCards('h').includes(mapping.card));state.nativeAction.cardPositionAfterNativeWait=mapping?get.position(mapping.card):null;state.nativeAction.status='native_child_wait_completed';emit('native_action_child_wait_completed')}emit('wait_next_end');return value},error=>{state.failureCode='NATIVE_WAIT_NEXT_REJECTED';emit('wait_next_error');throw error})};
	 const completedActionStart=GameEvent.prototype.start;
	 GameEvent.prototype.start=function(...args){const event=this,result=completedActionStart.apply(this,args);if(!result||typeof result.then!=='function')return result;return result.then(value=>{const action=state.nativeAction;if(event===state.inputEvent&&action?.eventId===event.__v2NativeEventId&&action.useResultCount===1&&action.nativeChildWaitCompleted===true&&action.nativeUseCardChildCompleted===true&&!state.nativeActionCompletionReported){state.nativeActionCompletionReported=true;const completion={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,eventFinished:Boolean(event.finished),eventStack:manager.eventStack.map(item=>item.name||null),phaseLoopParentName:state.phaseLoop?.parent?.name||null,nativeInputGate:state.nativeInputGate?{nativeEventId:state.nativeInputGate.nativeEventId,seatId:state.nativeInputGate.seatId,eventName:state.nativeInputGate.eventName,parentEventName:state.nativeInputGate.parentEventName,nativeResumeCount:state.nativeInputGate.nativeResumeCount||0,useResultCount:state.nativeInputGate.useResultCount||0}:null,nativeAction:{eventId:action.eventId,seatId:action.seatId,optionId:action.optionId,cardName:action.cardName||null,targetSeatId:action.targetSeatId||null,useResultCount:action.useResultCount,useResultChildName:action.useResultChildName||null,useCardChildName:action.nativeUseCardChildName||null,useCardChildStep:Number.isSafeInteger(action.nativeUseCardChildStep)?action.nativeUseCardChildStep:null,nativeUseCardChildCompleted:true,nativeChildWaitCompleted:true,nativeEventInstanceMatches:action.nativeEventInstanceMatches===true,nativeEventStepAfterWait:action.nativeEventStepAfterWait,cardInHandAfterNativeWait:action.cardInHandAfterNativeWait===true,cardPositionAfterNativeWait:action.cardPositionAfterNativeWait||null,result:action.result?{...action.result}:null},hostPlayerAbsent:game.me===null,connectedTransports:game.players.filter(player=>player.ws).length,seats:game.players.map(player=>({seatId:player.playerid||null,characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')}))};try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_action_event_completed',snapshot:completion}))}catch{}}return value})};
	 GameEvent.prototype.loop=function(...args){
	   if(managedStart){
	    const event=this,step=Number.isSafeInteger(event.step)?event.step:null,seatId=event.player?.playerid||null;
	    const safeLabel=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,96}$/.test(value)?value:null;
	    const skillId=safeLabel(event.skill),triggerName=safeLabel(event.triggername);
	    const parentPath=[];for(let parent=event.parent,count=0;parent&&count<6;parent=parent.parent,count++)parentPath.push({
	     eventName:safeLabel(parent.name),skillId:safeLabel(parent.skill),triggerName:safeLabel(parent.triggername)});
	    const eventToken=[event.name||null,step,event.parent?.name||null,seatId,skillId,triggerName].join(":");
	    if(eventToken!==state.lastNativeEventToken){
	     state.lastNativeEventToken=eventToken;
	     state.nativeEventTrail??=[];
	     state.nativeEventTrail.push({eventName:safeLabel(event.name),eventStep:step,parentEventName:safeLabel(event.parent?.name),
	      seatId,skillId,triggerName,parentPath,phaseNumber:Number.isSafeInteger(game.phaseNumber)?game.phaseNumber:null,
	      currentPhaseSeatId:_status.currentPhase?.playerid||null,
	      handCounts:game.players.map(player=>({seatId:player.playerid||null,count:player.countCards("h")}))});
	     if(state.nativeEventTrail.length>48)state.nativeEventTrail.shift();
	    }
	   }
	   if(managedNativeResponse&&this.name==='yingZhan'){if(!this.__v2ManagedResponseGate)prepareManagedNativeResponseGate(this);bindManagedResponseContext(this)}
	   if((managedInputGate||managedInputResume)&&!state.nativeInputGate&&this.name==='gongJiOrFaShu'&&this.player===_status.firstAct&&this.action===true){
	    observeNativeInputGate(this);
	    if(managedInputGate){game.pause();return new Promise(()=>{})}
	    const gate={event:this,nativeEventId:state.nativeInputGate.nativeEventId,seatId:this.player.playerid,status:'open',timer:null,controllerManaged:managedInputController};state.nativeInputResumeGate=gate;state.inputEvent=gate.event;
	    this.isOnline=()=>true;
	    this.send=function(){if(this!==gate.event||gate.status!=='open'||gate.timer)throw Error('NATIVE_INPUT_GATE_DUPLICATE_SEND_REJECTED');gate.status='waiting';gate.nativeSendCount=(gate.nativeSendCount||0)+1;state.nativeInputGate.nativeSendCount=gate.nativeSendCount;state.nativeInputGate.waiting=true;if(!gate.controllerManaged)gate.timer=setTimeout(()=>{if(gate.status!=='waiting')return;gate.status='expired';state.nativeInputGate.status='expired';state.nativeInputGate.failureCode='NATIVE_INPUT_DEADLINE_EXPIRED';state.nativeInputGate.engineResumeCount=(state.nativeInputGate.engineResumeCount||0)+1;this.result={bool:false};game.resume();emit('native_input_gate_expired')},managedInputDeadlineMs);game.pause();emit('native_input_wait_open')};
	    emit('native_input_gate_waiting');return originalLoop.apply(this,args)
	   }
	   return originalLoop.apply(this,args)
	  };
	  GameEvent.prototype.trigger=function(name,...args){if(name==='gameStart')state.gameStartCount++;emit(name==='gameStart'?'game_start_trigger':'event_trigger');return originalTrigger.call(this,name,...args)};
	  game.createEvent=function(name,...args){const event=originalCreateEvent.call(this,name,...args);if(name==='gameDraw'){state.drawCreated=true;state.draw=event;state.drawParentName=event.parent?.name||null}if(name==='phaseLoop'){state.phaseLoopCreated=true;state.phaseLoop=event;state.phaseLoopParentName=event.parent?.name||null}emit('event_created');return event};
	  const verifyCompletedRoom=()=>game.players.length===4&&game.players.every((player,index)=>player.playerid===window.__v2ManagedGame.setup.seats[index]?.seatId&&typeof player.name1==='string'&&!player.ws)&&game.me===null;
	  game.prepareArena=function(...args){state.prepareArenaCalls++;emit('prepare_arena_called');if(managedStart)throw Error('DUPLICATE_PREPARE_ARENA_REJECTED');return originalPrepareArena.apply(this,args)};
	  game.chooseCharacter=function(...args){state.chooseCharacterCalls++;emit('choose_character_called');if(managedStart)throw Error('DUPLICATE_CHARACTER_SELECTION_REJECTED');return originalChooseCharacter.apply(this,args)};
	  game.randomMapOL=function(...args){state.randomMapOLCalls++;emit('random_map_ol_called');if(managedStart){if(!_status.connectMode||!verifyCompletedRoom())throw Error('COMPLETED_ROOM_ROSTER_INVALID');state.randomMapOLAdapter='verified_completed_room_noop';return;}return originalRandomMapOL.apply(this,args)};
	  game.waitForPlayer=function(...args){state.waitForPlayerCalls++;emit('wait_for_player_called');if(managedStart){if(!_status.connectMode||!verifyCompletedRoom())throw Error('COMPLETED_ROOM_ROSTER_INVALID');state.waitForPlayerAdapter='verified_completed_room_callback';if(typeof args[0]==='function')args[0]();return;}return originalWaitForPlayer.apply(this,args)};
	  Player.prototype.phase=function(...args){state.phaseCalls++;const next=originalPhase.apply(this,args);if(managedStart&&!managedInputGate&&!managedInputResume&&!state.firstPhaseGate&&this===_status.firstAct){state.firstPhaseGate={seatId:this.playerid,eventName:next.name,parentName:next.parent?.name||null};game.pause();emit('first_phase_gate');return next}emit('phase_called');return next};
	Player.prototype.useResult=function(result,event){if(event&&event===state.inputEvent){const action=state.nativeAction;if(!action||action.eventId!==event.__v2NativeEventId)throw Error('NATIVE_ACTION_GATE_BINDING_LOST');action.useResultCount++;state.nativeInputGate.useResultCount=action.useResultCount;action.status='native_useResult_entered';action.result={bool:result?.bool===true,cardName:result?.card?.name||null,cardsCount:Array.isArray(result?.cards)?result.cards.length:0,targetCount:Array.isArray(result?.targets)?result.targets.length:0};emit('native_useResult_entered');try{if(${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")}==='use_result_throws')throw Error('INJECTED_USE_RESULT_EXCEPTION');const next=originalUseResult.call(this,result,event);action.useResultChildName=next?.name||null;state.nativeUseCardChildEvent=next;action.status='native_useResult_dispatched';emit('native_useResult_dispatched');return next}catch(error){action.status='uncertain';state.failureCode='NATIVE_USE_RESULT_FAILED';emit('native_useResult_exception');throw error}}return originalUseResult.call(this,result,event)};
	  game.gameDraw=function(...args){state.drawCreated=true;emit('game_draw_called');return originalDraw.apply(this,args)};
	  game.phaseLoop=function(...args){state.phaseLoopCreated=true;emit('phase_loop_called');return originalPhaseLoop.apply(this,args)};
	 }
	 if(reuseOpeningRoot){
	  if(state.phaseLoopReleased||state.status!=='authority_committed'||state.phaseLoopPaused!==true||state.phaseLoopStarted===true||
	   state.phaseLoopStartRequested!==true||!state.root||state.root!==manager.rootEvent||state.root.name!=='game'||
	   state.phaseLoop?.name!=='phaseLoop'||state.phaseLoop.parent!==state.root||window.__v2ManagedGame.authorityState.revision!==3||
	   game.me!==null||game.players.some(player=>player.ws)||game.players.length!==4||game.players.some(player=>!player.name1))
	   throw Error('MANAGED_OPENING_ROOT_RELEASE_PRECONDITION_REJECTED');
	  state.rootPromiseState='pending';
	  state.phaseLoopReleased=true;state.status='phase_loop_released';state.phaseLoopPaused=false;state.releasePhaseLoop();
	  emit('existing_root_phase_loop_released');return {started:true,reusedRoot:true,snapshot:snapshot()};
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
				const probe=await cdp.send("Runtime.evaluate",{expression:`(()=>{const s=window.__v2NativeStartDiagnosticState,{game,_status}=window.__v2ManagedEngine.core,phaseLoop=s?.phaseLoop,phaseEvent=phaseLoop?.next?.find(event=>event.name==='phase'&&event.player===_status.firstAct);return {rootPromiseState:s?.rootPromiseState||'unobserved',snapshot:{eventName:_status.event?.name||null,eventStep:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,parentEventName:_status.event?.parent?.name||null,rootEventName:_status.eventManager.rootEvent?.name||null,rootInstanceId:s?.rootInstanceId||null,rootObjectMatches:s?.root? _status.eventManager.rootEvent===s.root:null,eventStackDepth:_status.eventManager.eventStack.length,eventStackTop:_status.eventManager.eventStack.at(-1)?.name||null,eventStack:_status.eventManager.eventStack.map(event=>event.name),connectMode:Boolean(_status.connectMode),paused:Boolean(_status.paused),gameStartTriggered:(s?.gameStartCount||0)>0,gameStartCount:s?.gameStartCount||0,gameDrawCreated:Boolean(s?.drawCreated),gameDrawEntered:Boolean(s?.drawEntered),gameDrawParentName:s?.drawParentName||null,phaseLoopCreated:Boolean(s?.phaseLoopCreated),phaseLoopParentName:s?.phaseLoopParentName||null,firstPhaseEventName:phaseEvent?.name||null,firstPhaseParentName:phaseEvent?.parent?.name||null,firstPhaseGate:s?.firstPhaseGate||null,nativeInputGate:s?.nativeInputGate||null,prepareArenaCalls:s?.prepareArenaCalls||0,waitForPlayerCalls:s?.waitForPlayerCalls||0,randomMapOLCalls:s?.randomMapOLCalls||0,chooseCharacterCalls:s?.chooseCharacterCalls||0,phaseCalls:s?.phaseCalls||0,currentPhaseSeatId:_status.currentPhase?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,pendingChoiceEventName:/choose|respond|useCard/i.test(_status.event?.name||'')?_status.event.name:null,pendingChoiceSeatId:_status.event?.player?.playerid||null,hostPlayerAbsent:game.me===null,seats:game.players.map(p=>({seatId:p.playerid||null,characterInitialized:typeof p.name1==='string',handCount:p.countCards('h')})),lastSuccessfulEventStep:s?.lastSuccessfulEventStep||null,failureCode:s?.failureCode||null}}})()`,returnByValue:true},800);
				if(probe.exceptionDetails) {lastProbeError=String(probe.exceptionDetails.text||"CDP_EVALUATION_EXCEPTION").slice(0,256);break;}
				value=probe.result?.value||null;
				const waitForManagedInputGate=['managed_input_resume','managed_input_timeout','managed_input_cancel','managed_input_cancel_resume_race','managed_input_stop','managed_input_controller','managed_input_controller_trustee','managed_input_controller_registry','managed_input_controller_fault_before_apply','managed_opening_root_action','managed_opening_root_action_event4','managed_opening_root_action_event4_ack_loss','managed_opening_root_action_event4_trustee'].includes(message.mode);
				if (waitForManagedInputGate && value?.snapshot?.nativeInputGate?.waiting === true) {
					emitNativeStartDiagnostic({ stage: "native_input_wait_open", snapshot: value.snapshot, observationSource: "bounded_cdp_poll" });
				}
				if((waitForManagedInputGate ? value?.snapshot?.nativeInputGate?.eventName==='gongJiOrFaShu'&&value?.snapshot?.nativeInputGate?.waiting===true : message.mode === "managed_input_gate" ? value?.snapshot?.nativeInputGate : value?.snapshot?.phaseLoopCreated)||value?.snapshot?.failureCode)break;
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

async function snapshotNativeStart(message) {
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !validHostCommand(message) ||
		message.type !== "host_native_start_snapshot" || message.mode !== "managed_opening_root_action_event4" || !cdp) {
		throw new Error("NATIVE_START_SNAPSHOT_REJECTED");
	}
	try {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{const state=window.__v2NativeStartDiagnosticState,managed=window.__v2ManagedEngine,core=managed?.core,game=core?.game,status=core?._status,manager=status?.eventManager,current=status?.event,stack=manager?.eventStack||[];return {kind:'native_start_live_snapshot_v1',rootEventName:manager?.rootEvent?.name||null,rootInstanceId:state?.rootInstanceId||null,rootObjectMatches:state?.root?manager?.rootEvent===state.root:null,eventName:current?.name||null,eventStep:Number.isSafeInteger(current?.step)?current.step:null,parentEventName:current?.parent?.name||null,eventStack:stack.map(event=>({name:event.name||null,step:Number.isSafeInteger(event.step)?event.step:null,parentName:event.parent?.name||null,seatId:event.player?.playerid||null,nextCount:Array.isArray(event.next)?event.next.length:null,nextHeadName:event.next?.[0]?.name||null,nextHeadStep:Number.isSafeInteger(event.next?.[0]?.step)?event.next[0].step:null,nextHeadFinished:Boolean(event.next?.[0]?.finished)})),paused:Boolean(status?.paused),rootPromiseState:state?.rootPromiseState||null,failureCode:state?.failureCode||null,nativeAction:state?.nativeAction?{eventId:state.nativeAction.eventId||null,seatId:state.nativeAction.seatId||null,status:state.nativeAction.status||null,useResultCount:state.nativeAction.useResultCount||0,nativeChildWaitCompleted:state.nativeAction.nativeChildWaitCompleted===true,nativeUseCardChildCompleted:state.nativeAction.nativeUseCardChildCompleted===true}:null,responseGates:[...(state?.managedNativeResponseGates?.values()||[])].slice(-16).map(gate=>({nativeEventId:gate.nativeEventId||null,seatId:gate.seatId||null,actionEventId:gate.actionEventId||null,sourceSeatId:gate.sourceSeatId||null,eventStep:Number.isSafeInteger(gate.event?.step)?gate.event.step:null,status:gate.status||null,waitEventName:gate.waitEvent?.name||null,waitEventFinished:Boolean(gate.waitEvent?.finished),waitResolved:gate.waitResolved===true,optionCount:gate.optionIds?.length||0,deliveryId:gate.delivery?.deliveryId||null,deliveryStatus:gate.delivery?.status||null,useCardChildrenStarted:gate.useCardChildrenStarted||0,useCardChildrenCompleted:gate.useCardChildrenCompleted||0})),hostPlayerAbsent:game?.me===null,seats:(game?.players||[]).map(player=>({seatId:player.playerid||null,characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')}))}})()`, returnByValue: true }, 1500);
		const snapshot = result.result?.value;
		if (result.exceptionDetails || snapshot?.kind !== "native_start_live_snapshot_v1") throw new Error("NATIVE_START_SNAPSHOT_EVALUATION_FAILED");
		const trace = await cdp.send("Runtime.evaluate", { expression: `(()=>{const state=window.__v2NativeStartDiagnosticState;return {traceCount:state?.traceCount||0,tail:(state?.ring||[]).slice(-24).map(entry=>({stage:entry.stage,eventName:entry.snapshot?.eventName||null,eventStep:entry.snapshot?.eventStep??null,seatId:entry.snapshot?.nativeAction?.seatId||entry.snapshot?.seatId||null}))}})()`, returnByValue: true }, 1000);
		snapshot.trace = trace.result?.value || null;
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice?.nativeInputGate?.nativeEventId || null,
			observed: { ...snapshot, stage: "native_start_live_snapshot" } });
	} catch (error) {
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice?.nativeInputGate?.nativeEventId || null,
			observed: { kind: "native_start_live_snapshot_v1", stage: "native_start_live_snapshot_failed",
				classification: error?.message === "CHROMIUM_CDP_TIMEOUT" ? "cdp_command_timeout" : "undetermined",
				chromiumAlive: chromium?.exitCode === null && chromium?.signalCode === null } });
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
	if (message?.type === "host_authority_event_ack" && validHostCommand(message) &&
		[1, 2, 3, 4].includes(message.eventSequence) && message.stateRevision === message.eventSequence &&
		typeof message.afterDigest === "string" && /^[a-f0-9]{64}$/.test(message.afterDigest)) {
		nativeAuthorityAckWaiters.get(message.eventSequence)?.(message);
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
	if (message?.type === "host_native_input_resume" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		choiceCommandChain = choiceCommandChain.then(() => resumeManagedNativeInput(message)).catch(error => emitNativeStartDiagnostic({ stage: "native_input_resume_rejected",
			classification: "explicit_exception", failureCode: String(error?.message || "NATIVE_INPUT_RESUME_REJECTED").slice(0, 96) }));
		return;
	}
	if (message?.type === "host_native_input_cancel" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		choiceCommandChain = choiceCommandChain.then(() => cancelManagedNativeInput(message)).catch(error => emitNativeStartDiagnostic({ stage: "native_input_cancel_rejected",
			classification: "explicit_exception", failureCode: String(error?.message || "NATIVE_INPUT_CANCEL_REJECTED").slice(0, 96) }));
		return;
	}
	if (message?.type === "host_native_start_snapshot" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		snapshotNativeStart(message).catch(() => {});
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
