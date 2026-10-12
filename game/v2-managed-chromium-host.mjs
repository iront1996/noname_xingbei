import { spawn } from "node:child_process";
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
		send(method, params = {}) {
			if (!["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Runtime.evaluate"].includes(method) ||
				socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CHROMIUM_CDP_METHOD_DENIED"));
			const id = ++sequence;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); reject(new Error("CHROMIUM_CDP_TIMEOUT")); }, WAIT_MS);
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
			if (error.code !== "ENOENT") throw error;
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
}

process.on("message", message => {
	if (message?.type === "host_stop") {
		cleanup().finally(() => process.exit(0));
		return;
	}
	boot(message).catch(async () => {
		await cleanup();
		process.exit(1);
	});
});

process.on("disconnect", () => cleanup().finally(() => process.exit(0)));
