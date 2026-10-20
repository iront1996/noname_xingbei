import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateManagedEngineSourceManifest, MANAGED_ENGINE_TRUST_CONTRACT } = require("./server-managed-engine-integrity.js");
const { createManagedRandomBootstrap, isManagedTestSeedAllowed } = require("./server-managed-random-source.js");
const { createManagedNativeCardLedger } = require("./server-managed-native-card-ledger.js");
const EFFECT_STATE_SCHEMA = "xingbei_native_private_effect_state_v1";

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^hs_[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const WAIT_MS = 15000;
// Cold Chromium process startup can exceed the per-command CDP budget before
// DevToolsActivePort exists. This budget applies only to browser bootstrap;
// gameplay and CDP command deadlines remain WAIT_MS.
const CHROMIUM_BOOT_WAIT_MS = 20000;

function experimentalAuthorityEventEnabled(eventSequence) {
	const ceiling = Number(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT);
	const mode = process.env.V2_NATIVE_START_PROBE_MODE;
	const eventSixContinuation = eventSequence === 6 && process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
		mode === "managed_opening_root_action_event5";
	const eventSevenContinuation = eventSequence === 7 && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
		[7, 8].includes(ceiling) && mode === "managed_opening_root_action_event5";
	const eventEightContinuation = eventSequence === 8 && ceiling === 8 && process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
		process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" && process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1" &&
		mode === "managed_opening_root_action_event5";
	return [5, 6, 7, 8].includes(eventSequence) && [5, 6, 7, 8].includes(ceiling) && ceiling === managedAuthorityEventLimit && ceiling >= eventSequence &&
		process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === String(ceiling) &&
		process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
		(mode === `managed_opening_root_action_event${eventSequence}` || eventSixContinuation || eventSevenContinuation || eventEightContinuation);
}

let chromium = null;
let profile = null;
let identity = null;
let stopping = false;
let cdp = null;
let networkPolicyUnsubscribe = null;
let managedRandomFailureUnsubscribe = null;
let interactiveChoice = null;
let choiceCommandChain = Promise.resolve();
let choiceDiagnosticTimer = null;
const nativeAuthorityAckWaiters = new Map();
const pendingNativeActionAuthorities = new Map();
const nativeStartDiagnosticRing = [];
const nextSeatDiagnosticDispatched = new Set();
let nativeStartDiagnosticUnsubscribe = null;
let nativeFailureReported = false;
let managedRandomFailureReported = false;
let nativeFaultApplyBarrier = null;
let nativeEffectSnapshotStopBarrier = null;
let managedNativeCardLedger = null;
let managedSeatIds = null;
let managedAuthorityEventLimit = 4;
let managedCardSidecarNonce = null;
let managedEngineBuildId = null;
const chromiumStartupStderr = [];

function safeChromiumStartupDiagnostics() {
	return chromiumStartupStderr.slice(-16).map(line => line
		.replaceAll(profile || "\u0000", "[managed-profile]")
		.replaceAll(identity?.secret || "\u0000", "[redacted]")
		.replace(/\b(token|password|credential|secret)(?:=|:)\s*\S+/gi, "$1=[redacted]")
		.replace(/\/home\/[^/\s]+/g, "/home/[user]")
		.replace(/\\Users\\[^\\\s]+/gi, "\\Users\\[user]")
		.slice(0, 512));
}

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
			const managedRandomBindingMethod = (method === "Runtime.enable" && Object.keys(params).length === 0) ||
				(method === "Runtime.addBinding" && params.name === "__v2ManagedRandomFailureNotify" && Object.keys(params).sort().join(",") === "name");
			const fetchPolicyMethod = ["Fetch.enable", "Fetch.continueRequest", "Fetch.failRequest"].includes(method);
			if (!(diagnosticMethod || managedRandomBindingMethod || fetchPolicyMethod || ["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Runtime.evaluate"].includes(method)) ||
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
		onInternalEvent(listener) {
			if (typeof listener !== "function") throw new Error("CDP_INTERNAL_LISTENER_INVALID");
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() { socket.close(); },
	};
}

async function cleanup() {
	if (stopping) return;
	stopping = true;
	nextSeatDiagnosticDispatched.clear();
	for (const pending of pendingNativeActionAuthorities.values()) clearTimeout(pending.timer);
	pendingNativeActionAuthorities.clear();
	if (nativeEffectSnapshotStopBarrier) {
		const barrier = nativeEffectSnapshotStopBarrier;
		nativeEffectSnapshotStopBarrier = null;
		barrier.release(false);
	}
	try { managedNativeCardLedger?.destroy(); } catch {}
	managedNativeCardLedger = null;
	managedSeatIds = null;
	managedAuthorityEventLimit = 4;
	managedCardSidecarNonce = null;
	managedEngineBuildId = null;
	try { networkPolicyUnsubscribe?.(); } catch {}
	networkPolicyUnsubscribe = null;
	try { managedRandomFailureUnsubscribe?.(); } catch {}
	managedRandomFailureUnsubscribe = null;
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
		message.trustContract === MANAGED_ENGINE_TRUST_CONTRACT &&
		[4, 5, 6, 7, 8].includes(message.authorityEventLimit) &&
		(message.authorityEventLimit === 4 || (process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === String(message.authorityEventLimit) &&
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && (message.authorityEventLimit !== 8 ||
				process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
				process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1"))) &&
		ROOM_ID.test(message.roomId) && SESSION_ID.test(message.sessionId) && SECRET.test(message.secret) &&
		validateManagedEngineSourceManifest(message.engineSourceManifest);
}

function installSameOriginNetworkPolicy(origin) {
	const state = { blockedRequests: 0 };
	const unsubscribe = cdp.onInternalEvent(message => {
		if (message?.method !== "Fetch.requestPaused") return;
		const requestId = message.params?.requestId;
		const requestUrl = message.params?.request?.url;
		if (typeof requestId !== "string" || typeof requestUrl !== "string") return;
		let sameOrigin = false;
		try { sameOrigin = new URL(requestUrl).origin === origin; } catch {}
		if (!sameOrigin) state.blockedRequests++;
		const command = sameOrigin ? "Fetch.continueRequest" : "Fetch.failRequest";
		const params = sameOrigin ? { requestId } : { requestId, errorReason: "BlockedByClient" };
		cdp.send(command, params).catch(() => {});
	});
	return cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }).then(() => Object.freeze({ state, unsubscribe }));
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
	managedAuthorityEventLimit = message.authorityEventLimit;
	if (process.env.V2_TEST_MATCH_RECORD_POST === "1" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1") {
		throw new Error("TEST_MATCH_POST_REQUIRES_NETWORK_BLOCK");
	}
	if (process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
		!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.V2_GAME_ORIGIN || "")) {
		throw new Error("TEST_NETWORK_ORIGIN_INVALID");
	}
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
		"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
		"--disable-dev-shm-usage",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"about:blank",
	], { stdio: ["ignore", "ignore", process.env.V2_CHROMIUM_START_DIAGNOSTICS === "1" ? "pipe" : "ignore", "ipc"],
		windowsHide: true, detached: process.platform !== "win32" });
	if (process.env.V2_CHROMIUM_START_DIAGNOSTICS === "1") {
		chromium.stderr?.setEncoding("utf8");
		chromium.stderr?.on("data", chunk => {
			for (const line of String(chunk).split(/\r?\n/)) {
				if (!line) continue;
				chromiumStartupStderr.push(line.slice(0, 1024));
				if (chromiumStartupStderr.length > 64) chromiumStartupStderr.shift();
			}
		});
	}
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
	const startupStartedAt = Date.now();
	const deadline = startupStartedAt + CHROMIUM_BOOT_WAIT_MS;
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
	if (!port) {
		if (process.env.V2_CHROMIUM_START_DIAGNOSTICS === "1") {
			const details = { elapsedMs: Date.now() - startupStartedAt, pid: chromium.pid,
				exitCode: chromium.exitCode, signalCode: chromium.signalCode, profileActivePortPresent: false,
				stderr: safeChromiumStartupDiagnostics() };
			throw new Error(`CHROMIUM_BOOT_TIMEOUT:${JSON.stringify(details)}`);
		}
		throw new Error("CHROMIUM_BOOT_TIMEOUT");
	}
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
		signal: AbortSignal.timeout(CHROMIUM_BOOT_WAIT_MS),
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
	const randomFailureCodes = new Set(["MANAGED_RANDOM_SOURCE_UNAVAILABLE", "MANAGED_RANDOM_SOURCE_FAILED", "MANAGED_RANDOM_DRAW_LIMIT_EXCEEDED"]);
	managedRandomFailureUnsubscribe = cdp.onInternalEvent(event => {
		if (managedRandomFailureReported || event.method !== "Runtime.bindingCalled" || event.params?.name !== "__v2ManagedRandomFailureNotify" ||
			typeof event.params.payload !== "string" || !randomFailureCodes.has(event.params.payload)) return;
		managedRandomFailureReported = true;
		const code = event.params.payload;
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
			observed: { kind: "managed_random_failure_v1", failureCode: code } });
		const terminate = () => cleanup().finally(() => process.exit(1));
		if (process.connected) process.send({ ...identity, type: "host_failure", code }, () => terminate());
		else terminate();
	});
	await cdp.send("Runtime.enable");
	await cdp.send("Runtime.addBinding", { name: "__v2ManagedRandomFailureNotify" });
	await cdp.send("Page.enable");
	const networkPolicy = await installSameOriginNetworkPolicy(origin);
	networkPolicyUnsubscribe = networkPolicy.unsubscribe;
	if (process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1") {
		const blockedProbe = await cdp.send("Runtime.evaluate", {
			expression: `fetch('https://example.invalid/v2-managed-network-probe').then(()=>false,()=>true)`,
			awaitPromise: true,
			returnByValue: true,
		}, 3000);
		if (blockedProbe.exceptionDetails || blockedProbe.result?.value !== true || networkPolicy.state.blockedRequests !== 1) {
			networkPolicy.unsubscribe();
			throw new Error("MANAGED_EXTERNAL_NETWORK_POLICY_FAILED");
		}
	}
	let managedRandomSource;
	if (process.env.V2_NATIVE_TEST_RANDOM_SEED !== undefined) {
		if (!isManagedTestSeedAllowed(process.env)) {
			throw new Error("NATIVE_TEST_RANDOM_SEED_REJECTED");
		}
		const seed = Number(process.env.V2_NATIVE_TEST_RANDOM_SEED) >>> 0;
		managedRandomSource = createManagedRandomBootstrap(seed);
	}
	else managedRandomSource = createManagedRandomBootstrap();
	const randomSourceKind = managedRandomSource.kind;
	const testNetworkGuard = process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" ?
		`(()=>{const nativeFetch=window.fetch.bind(window);let blocked=0;Object.defineProperty(window,"__v2ExternalFetchBlockedCount",{configurable:false,get:()=>blocked});window.fetch=(input,init)=>{let url;try{url=new URL(input instanceof Request?input.url:String(input),location.href)}catch{return Promise.reject(new TypeError('V2_TEST_FETCH_URL_INVALID'))}if(url.origin!==location.origin){blocked++;return Promise.reject(new TypeError('V2_TEST_EXTERNAL_NETWORK_BLOCKED'))}return nativeFetch(input,init)}})();` : "";
	await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `${managedRandomSource.source}${testNetworkGuard}Object.defineProperty(window,"isNonameServer",{value:true,writable:false,configurable:false});`,
	});
	const navigation = await cdp.send("Page.navigate", { url: `${origin}/v2-managed-host.html` });
	if (navigation.errorText) throw new Error("ENGINE_NAVIGATION_FAILED");
	const randomReady = await cdp.send("Runtime.evaluate", {
		expression: `(()=>{const audit=window.__v2ManagedRandomAudit;if(window.__v2ManagedRandomFailure||!audit||audit.source!==${JSON.stringify(randomSourceKind)}||audit.failed!==false||audit.active!==true||typeof Math.random!=='function')return {ready:false,code:window.__v2ManagedRandomFailure||'MANAGED_RANDOM_SOURCE_NOT_READY'};const sample=Math.random();return {ready:Number.isFinite(sample)&&sample>=0&&sample<1&&audit.active===true,source:audit.source,drawCount:audit.drawCount,code:'MANAGED_RANDOM_SOURCE_NOT_READY'}})()`,
		returnByValue: true,
	});
	const randomAudit = randomReady.result?.value;
	if (randomReady.exceptionDetails || randomAudit?.ready !== true || randomAudit.source !== randomSourceKind ||
		!Number.isSafeInteger(randomAudit.drawCount) || randomAudit.drawCount < 1) {
		throw new Error(randomAudit?.code || "MANAGED_RANDOM_SOURCE_NOT_READY");
	}
	const integrityCheck = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{
		 const manifest=${JSON.stringify(message.engineSourceManifest)};
		 if(manifest.schema!=='xingbei_managed_engine_source_manifest_v1'||manifest.schemaVersion!==1||
		    !Array.isArray(manifest.files)||manifest.buildId!==${JSON.stringify(message.engineSourceManifest.buildId)})throw Error('ENGINE_SOURCE_MANIFEST_INVALID');
		 let totalBytes=0;
		 for(let offset=0;offset<manifest.files.length;offset+=8){
		  await Promise.all(manifest.files.slice(offset,offset+8).map(async entry=>{
		   const response=await fetch(new URL('/'+entry.path,location.origin),{cache:'no-store',credentials:'omit'});
		   if(!response.ok)throw Error('ENGINE_SOURCE_FILE_MISSING');
		   const rawBytes=await response.arrayBuffer();
		   let sourceText;
		   try{sourceText=new TextDecoder('utf-8',{fatal:true}).decode(rawBytes)}catch{throw Error('ENGINE_SOURCE_ENCODING_INVALID')}
		   const bytes=new TextEncoder().encode(sourceText.replace(/\\r\\n/g,'\\n'));
		   if(bytes.byteLength!==entry.size)throw Error('ENGINE_SOURCE_SIZE_MISMATCH');
		   const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
		   const hex=Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
		   if(hex!==entry.sha256)throw Error('ENGINE_SOURCE_DIGEST_MISMATCH');
		  }));
		 }
		 totalBytes=manifest.files.reduce((sum,entry)=>sum+entry.size,0);
		 return {verified:true,buildId:manifest.buildId,fileCount:manifest.files.length,totalBytes,networkPolicy:'same-origin-only'};
		})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const integrity = integrityCheck.result?.value;
	if (integrityCheck.exceptionDetails || integrity?.verified !== true || integrity.buildId !== message.engineSourceManifest.buildId ||
		integrity.fileCount !== message.engineSourceManifest.fileCount || integrity.totalBytes !== message.engineSourceManifest.totalBytes ||
		integrity.networkPolicy !== "same-origin-only") {
		const detail = `${integrityCheck.exceptionDetails?.text || ""} ${integrityCheck.exceptionDetails?.exception?.description || ""}`;
		const code = ["ENGINE_SOURCE_MANIFEST_INVALID", "ENGINE_SOURCE_FILE_MISSING", "ENGINE_SOURCE_ENCODING_INVALID", "ENGINE_SOURCE_SIZE_MISMATCH", "ENGINE_SOURCE_DIGEST_MISMATCH"]
			.find(candidate => detail.includes(candidate));
		throw new Error(code || "ENGINE_SOURCE_INTEGRITY_FAILED");
	}
	managedEngineBuildId = integrity.buildId;
	if (process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1") {
		const supportedFixture = process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1" ||
			(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") ||
			process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1";
		if (!supportedFixture || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
			process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE !== "1" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" ||
			message.gameSetup?.mode !== "xingBei" || message.gameSetup?.seats?.length !== 4) {
			throw new Error("NATIVE_PREACTION_CAPTURE_TEST_SCOPE_INVALID");
		}
		managedSeatIds = message.gameSetup.seats.map(seat => seat.seatId);
	}
	if (process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1") {
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" || message.gameSetup?.mode !== "xingBei" ||
			message.gameSetup?.seats?.length !== 4) throw new Error("NATIVE_CARD_LEDGER_TEST_SCOPE_INVALID");
		managedSeatIds = message.gameSetup.seats.map(seat => seat.seatId);
		managedCardSidecarNonce = randomBytes(16).toString("hex");
		managedNativeCardLedger = createManagedNativeCardLedger({ roomId: message.roomId, sessionId: message.sessionId,
			engineBuildId: integrity.buildId, seatIds: managedSeatIds, key: randomBytes(32) });
	}
	if (process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1") {
		if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
			process.env.V2_NATIVE_YINYANG_FIXTURE !== "1" || process.env.V2_NATIVE_MANAGED_YINYANG !== "1" ||
			process.env.V2_NATIVE_MANAGED_RESPONSE !== "1" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" ||
			message.gameSetup?.mode !== "xingBei" || message.gameSetup?.seats?.length !== 4) {
			throw new Error("NATIVE_EFFECT_STATE_TEST_SCOPE_INVALID");
		}
		managedSeatIds = message.gameSetup.seats.map(seat => seat.seatId);
	}
	const engine = await cdp.send("Runtime.evaluate", {
		expression: `(async()=>{
		await new Promise(resolve=>document.readyState==='complete'?resolve():addEventListener('load',resolve,{once:true}));
		 if(window.isNonameServer!==true)throw Error('OFFBOARD_FLAG_MISSING');
		 const loadScript=src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(Error('ENGINE_BOOTSTRAP_SCRIPT_FAILED'));document.head.appendChild(script)});
		 await loadScript('/game/config.js');
		 await loadScript('/game/package.js');
		 if(!window.config||typeof window.config!=='object')throw Error('ENGINE_CONFIG_MISSING');
		 window.config.extensions=[];window.config.extension_sources={};window.config.extension_source='';
			 const core=await import('/noname.js');
		 await core.boot();
		 clearTimeout(window.resetGameTimeout);
		 if((Array.isArray(core.lib.config.extensions)&&core.lib.config.extensions.length!==0)||
		    (Array.isArray(core.lib.extensions)&&core.lib.extensions.length!==0))throw Error('UNTRUSTED_EXTENSION_PRESENT');
		 const imported=await import('/mode/xingBei.js');
		 const mode=imported.default();
		 if(!core.game||!core.lib||!core.ui||!core._status||mode.name!=='xingBei'||
		    typeof mode.game?.checkResult!=='function'||
		    typeof mode.game?.checkOnlineResult!=='function'||
		    typeof core.game.randomMapOL!=='function')throw Error('ENGINE_API_MISSING');
		 Object.defineProperty(window,'__v2ManagedEngine',{configurable:false,
		  value:Object.freeze({core,mode})});
		 let testMatchRecordPostBlocked=null;
		 if(${process.env.V2_TEST_MATCH_RECORD_POST === "1"}){
		  if(window.__v2ExternalFetchBlockedCount!==0||typeof mode.game.submitMatchData!=='function')throw Error('TEST_NETWORK_GUARD_MISSING');
		  await mode.game.submitMatchData({kind:'isolated_network_guard_probe'});
		  testMatchRecordPostBlocked=window.__v2ExternalFetchBlockedCount;
		  if(testMatchRecordPostBlocked!==1)throw Error('TEST_MATCH_RECORD_POST_NOT_BLOCKED');
		 }
		 return {loaded:true,mode:mode.name,offboard:true,
		  nativeGame:typeof core.game.randomMapOL==='function',
		  nativeResult:typeof mode.game.checkResult==='function',gameLoopStarted:false,
		  testMatchRecordPostBlocked,engineBuildId:${JSON.stringify(integrity.buildId)},
		  randomSourceAudit:(()=>{const audit=window.__v2ManagedRandomAudit;return {source:audit?.source||null,drawCount:audit?.drawCount??null,failed:audit?.failed??null,active:audit?.active===true}})()};
		})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const proof = engine.result?.value;
	if (engine.exceptionDetails || proof?.loaded !== true || proof.mode !== "xingBei" ||
		proof.offboard !== true || proof.nativeGame !== true || proof.nativeResult !== true ||
		proof.gameLoopStarted !== false || proof.engineBuildId !== integrity.buildId) throw new Error("ENGINE_INITIALIZATION_FAILED");
	const engineRandomAudit = proof.randomSourceAudit;
	if (!engineRandomAudit || engineRandomAudit.source !== randomSourceKind || engineRandomAudit.failed !== false ||
		engineRandomAudit.active !== true || !Number.isSafeInteger(engineRandomAudit.drawCount) || engineRandomAudit.drawCount < 1) {
		throw new Error("MANAGED_RANDOM_SOURCE_CHANGED_DURING_ENGINE_LOAD");
	}
	process.send?.({ ...identity, type: "host_engine_ready", proof: {
		kind: "managed_engine_integrity_v1", trustContract: MANAGED_ENGINE_TRUST_CONTRACT,
		buildId: integrity.buildId, fileCount: integrity.fileCount,
		totalBytes: integrity.totalBytes, networkPolicy: "same-origin-only",
	} });
	if (process.env.V2_TEST_MATCH_RECORD_POST === "1") {
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
			observed: { stage: "test_network_guard_verified", blockedPostCount: proof.testMatchRecordPostBlocked } });
	}
	process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
		observed: { stage: "managed_random_source_ready", source: engineRandomAudit.source,
			drawCount: engineRandomAudit.drawCount, testOnly: engineRandomAudit.source === "test_seeded_v1" } });

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
		 let targetlessDeckFixture=null;
		 if(!ui.arena)ui.create.arena();
		 game.prepareArena(setup.seats.length);
		 // Normal startup defers ui.create.cardsAsync() through the global onfree
		 // queue. A managed headless room has no free-screen transition, so execute
		 // only that native card-pile initialization callback now.
		 if(_status.waitingForCards){const args=_status.waitingForCards;delete _status.waitingForCards;
		  // Opt-in test fixture: arrange real native deck entries so every opening
		  // hand can contain a real no-target ShengGuang. Native card creation,
		  // gameDraw/dealing and response filtering still run unchanged.
		  if(${process.env.V2_NATIVE_RESPONSE_TARGETLESS_FIXTURE === "1"}){
		   if(${process.env.V2_NATIVE_MANAGED_RESPONSE === "1"}!==true||
		      ${process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1"}!==true)throw Error('TARGETLESS_DECK_FIXTURE_SCOPE_REJECTED');
		   const source=lib.card.list;
		   if(!Array.isArray(source)||args.length!==0)throw Error('TARGETLESS_DECK_FIXTURE_INPUT_REJECTED');
		   const picked=[],remaining=[];
		   for(const card of source){if(card?.[2]==='shengGuang'&&picked.length<4)picked.push(card);else remaining.push(card)}
		   if(picked.length!==4||source.length<16)throw Error('TARGETLESS_DECK_FIXTURE_CARDS_UNAVAILABLE');
		   const arranged=Array.from({length:source.length});
		   for(let index=0;index<4;index++)arranged[index*4]=picked[index];
		   let cursor=0;for(let index=0;index<arranged.length;index++)if(arranged[index]===undefined)arranged[index]=remaining[cursor++];
		   if(cursor!==remaining.length||arranged.some((card,index)=>card!==source[index]&&card===undefined))throw Error('TARGETLESS_DECK_FIXTURE_ARRANGEMENT_INVALID');
		   lib.card.list=arranged;args[0]=true;
		   targetlessDeckFixture={kind:'native_card_pile_order_fixture_v1',selectedNativeEntries:picked.length,
		    openingHandSlots:[0,4,8,12],nativeCardCreation:true,nativeGameDraw:true};
		  }
		  if(${process.env.V2_NATIVE_JIRIMO_FIXTURE === "1"}){
		   if(${process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1"}!==true||${process.env.V2_NATIVE_C3_UNIFIED_ROOT === "1"}!==true)
		    throw Error('JIRIMO_DECK_FIXTURE_SCOPE_REJECTED');
		   const source=lib.card.list;if(!Array.isArray(source)||args.length!==0)throw Error('JIRIMO_DECK_FIXTURE_INPUT_REJECTED');
		   const picked=[],remaining=[];
		   const banned=new Set([...(lib.configOL.bannedcards||[]),...(game.bannedcards||[])]);
		   for(const card of source){const definition=lib.card[card?.[2]],replaced=Boolean(card?._replaced);
		    if(definition?.type==='faShu'&&(replaced||!banned.has(card[2]))&&picked.length<16)picked.push(card);else remaining.push(card)}
		   if(picked.length!==16||source.length<16)throw Error('JIRIMO_DECK_FIXTURE_SPELLS_UNAVAILABLE');
		   const arranged=[...picked,...remaining];
		   if(arranged.length!==source.length||new Set(arranged).size!==source.length||source.some(card=>!arranged.includes(card)))throw Error('JIRIMO_DECK_FIXTURE_ARRANGEMENT_INVALID');
		   lib.card.list=arranged;args[0]=true;
		   targetlessDeckFixture={kind:'native_jirimo_spell_hand_fixture_v1',selectedNativeEntries:picked.length,
		    openingHandSlots:Array.from({length:16},(_,index)=>index),nativeCardCreation:true,nativeGameDraw:true,allSeatsReceiveNativeSpell:true,
		    fixtureOnly:true,formalRandomnessUnchanged:true};
		  }
		  ui.create.cards.apply(ui.create,args)}
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
		  ...(targetlessDeckFixture?{targetlessDeckFixture}:{}),
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
	if (preGameSummary.targetlessDeckFixture) process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
		observed: { stage: "native_targetless_deck_fixture_ready", ...preGameSummary.targetlessDeckFixture } });
	process.send?.({
		...identity,
		type: "host_game_ready",
		proof: {
			kind: "pre_game_verification_v1",
			trustContract: MANAGED_ENGINE_TRUST_CONTRACT,
			engineBuildId: integrity.buildId,
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
	 const managed=window.__v2ManagedEngine,container=window.__v2ManagedGame,{game,lib,get,ui,_status}=managed.core,manager=_status.eventManager;
	 if(!container||container.authorityState.revision!==0||container.checkpoint!==null||!_status.connectMode||game.me!==null||
	  game.players.length!==container.setup.seats.length||game.players.some((player,index)=>player.playerid!==container.setup.seats[index].seatId||
	   player.name1||typeof player.side!=='undefined'||player.ws)||manager.eventStack.length!==0)throw Error('UNIFIED_ROOT_PRECONDITION_REJECTED');
	 if(window.__v2ManagedUnifiedRoot)throw Error('UNIFIED_ROOT_DUPLICATE_REJECTED');
	 lib.configOL.chooseSide=false;lib.configOL.choose_mode='多选1';lib.configOL.choose_number='2';
	 lib.configOL.team_sequence='near';lib.configOL.phaseswap=false;
	 const yinyangFixture=${process.env.V2_NATIVE_YINYANG_FIXTURE === "1"};
	 const shengJiResourceFixture=${process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1"};
	 const jiRiResourceFixture=${process.env.V2_NATIVE_JIRIMO_FIXTURE === "1"};
	 if([yinyangFixture,shengJiResourceFixture,jiRiResourceFixture].filter(Boolean).length>1)throw Error('NATIVE_RESOURCE_FIXTURE_CONFLICT');
	 const state={status:'starting',instrumented:false,rootPromiseState:'pending',failureCode:null,
	  waitForPlayerCalls:0,randomMapOLCalls:0,prepareArenaCalls:0,chooseCharacterCalls:0,sideAssignmentCalls:0,
	  dialogBroadcasts:0,trusteeTimerCaptured:false,selectionEventCount:0,sideEventCount:0,gameStartCount:0,
	  drawCreated:false,drawCompleted:false,phaseLoopCreated:false,phaseLoopStartRequested:false,
	  phaseLoopStarted:false,phaseLoopPaused:false,phaseLoopReleased:false,phaseLoopGate:null,phaseLoopStartPromise:null,
	  event1Ready:false,event1Released:false,event2Ready:false,event2Released:false,event3Ready:false,
	  yinyangFixtureEnabled:yinyangFixture,yinyangFixtureSeatId:null,yinyangCandidatePool:null,yinyangFixtureCandidateObserved:false,
	  shengJiResourceFixtureEnabled:shengJiResourceFixture,shengJiResourceFixtureSeatId:null,shengJiCandidatePool:null,shengJiFixtureCandidateObserved:false,
	  jiRiResourceFixtureEnabled:jiRiResourceFixture,jiRiResourceFixtureSeatId:null,jiRiCandidatePool:null,jiRiFixtureCandidateObserved:false,
	  jiRiNativeSkillCandidateCount:0,
	  shengJiResourceTransition:null};
	 state.selectionSignalTrace=[];
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
	  originalCharactersOL=get.charactersOL,originalCharacterGets=get.characterGets,originalRandomRemove=Array.prototype.randomRemove,
	  originalSetTimeout=globalThis.setTimeout,originalGameDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop;
	 state.originals={GameEvent,originalStart,originalWaitNext,originalTrigger,originalCreateEvent,originalWaitForPlayer,
	  originalRandomMapOL,originalPrepareArena,originalChooseCharacterOL,originalInitSide,originalBroadcastAll,originalPause,
	  originalSetTimeout,originalGameDraw,originalPhaseLoop,originalCharactersOL,originalCharacterGets,originalRandomRemove};
	 if(yinyangFixture){
	  if(!lib.character.yinYangShi||typeof get.charactersOL!=='function'||typeof get.characterGets!=='function')throw Error('YINYANG_NATIVE_CHARACTER_POOL_UNAVAILABLE');
		  get.charactersOL=function(...args){
	   if(state.selectionSignalTrace.length<16)state.selectionSignalTrace.push({signal:'charactersOL',currentEventName:_status.event?.name||null,
	    currentEventStep:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,hasRuntimeLegalRole:Boolean(lib.character.jieRiMoDao)});
	   if(args.length)return originalCharactersOL.apply(this,args);
	   if(state.yinyangCandidatePool)return state.yinyangCandidatePool.slice();
	   const native=originalCharactersOL.call(this);
	   if(!native.includes('yinYangShi'))throw Error('YINYANG_CHARACTER_NOT_IN_NATIVE_LEGAL_POOL');
	   const opposing=game.players.filter(player=>player!==_status.firstAct&&player.side!==_status.firstAct?.side&&player.playerid!==container.setup.seats[1]?.seatId);
	   const target=opposing[0]||game.players.find(player=>player!==_status.firstAct&&player.side!==_status.firstAct?.side);
	   if(!target)throw Error('YINYANG_FIXTURE_NO_OPPOSING_SEAT');
	   const targetIndex=game.players.indexOf(target),pool=Array(8).fill(null);pool[targetIndex*2]='yinYangShi';
	   const forbidden=(lib.config.forbidlist||[]).concat(lib.config.customforbid||[]);
	   const conflicts=(candidate,selected)=>forbidden.some(pair=>Array.isArray(pair)&&pair.length>=2&&
	    ((pair[0]===candidate&&selected.includes(pair[1]))||(pair[1]===candidate&&selected.includes(pair[0]))));
	   const used=new Set(['yinYangShi']);
	   for(let index=0;index<pool.length;index++)if(pool[index]===null){
	    const candidate=native.find(name=>!used.has(name)&&!conflicts(name,[...used]));
	    if(!candidate)throw Error('YINYANG_FIXTURE_NATIVE_POOL_TOO_SMALL');pool[index]=candidate;used.add(candidate);
	   }
	   state.yinyangFixtureSeatId=target.playerid;state.yinyangCandidatePool=pool;
	   return pool.slice();
	  };
	  get.characterGets=function(list,...args){
	   const result=originalCharacterGets.call(this,list,...args);
	   if(state.yinyangCandidatePool&&Array.isArray(list)&&list.length===8&&list.includes('yinYangShi')){
	    if(result.length!==8||result.indexOf('yinYangShi')!==game.players.indexOf(game.players.find(player=>player.playerid===state.yinyangFixtureSeatId))*2)
	     throw Error('YINYANG_FIXTURE_POOL_FILTERED_OR_REORDERED');
	    state.yinyangFilteredCandidatePool=result;state.yinyangFixtureCandidateObserved=true;
	   }
	   return result;
	  };
	  const randomRemove=originalRandomRemove;
	  Array.prototype.randomRemove=function(...args){
	   if(this===state.yinyangFilteredCandidatePool&&args.length===0)return this.splice(0,1)[0];
	   return randomRemove.apply(this,args);
	  };
	 }
	 if(shengJiResourceFixture){
	  // Character data, the legal OL pool, and firstAct are established by the
	  // native start/side-assignment events. Validate them when the native event
	  // requests its pool, not while installing the opt-in observer.
	  if(typeof get.charactersOL!=='function'||typeof get.characterGets!=='function')
	   throw Error('SHENGJI_NATIVE_CHARACTER_POOL_UNAVAILABLE');
	  get.charactersOL=function(...args){
	   if(args.length)return originalCharactersOL.apply(this,args);
	   if(state.shengJiCandidatePool)return state.shengJiCandidatePool.slice();
	   if(!lib.character.shengQiangQiShi||!_status.firstAct)
	    throw Error('SHENGJI_NATIVE_CHARACTER_POOL_UNAVAILABLE');
	   const native=originalCharactersOL.call(this);
	   if(!native.includes('shengQiangQiShi'))throw Error('SHENGJI_CHARACTER_NOT_IN_NATIVE_LEGAL_POOL');
	   const actor=_status.firstAct,targetIndex=game.players.indexOf(actor),pool=Array(8).fill(null);
	   if(targetIndex<0)throw Error('SHENGJI_FIXTURE_ACTOR_NOT_SEATED');
	   pool[targetIndex*2]='shengQiangQiShi';
	   const forbidden=(lib.config.forbidlist||[]).concat(lib.config.customforbid||[]),conflicts=(candidate,selected)=>forbidden.some(pair=>Array.isArray(pair)&&pair.length>=2&&
	    ((pair[0]===candidate&&selected.includes(pair[1]))||(pair[1]===candidate&&selected.includes(pair[0]))));
	   const used=new Set(['shengQiangQiShi']);
	   for(let index=0;index<pool.length;index++)if(pool[index]===null){const candidate=native.find(name=>!used.has(name)&&!conflicts(name,[...used]));
	    if(!candidate)throw Error('SHENGJI_FIXTURE_NATIVE_POOL_TOO_SMALL');pool[index]=candidate;used.add(candidate)}
	   state.shengJiResourceFixtureSeatId=actor.playerid;state.shengJiCandidatePool=pool;return pool.slice();
	  };
	  get.characterGets=function(list,...args){const result=originalCharacterGets.call(this,list,...args);
	   if(state.shengJiCandidatePool&&Array.isArray(list)&&list.length===8&&list.includes('shengQiangQiShi')){
	    const index=game.players.findIndex(player=>player.playerid===state.shengJiResourceFixtureSeatId);
	    if(result.length!==8||result.indexOf('shengQiangQiShi')!==index*2)throw Error('SHENGJI_FIXTURE_POOL_FILTERED_OR_REORDERED');
	    state.shengJiFilteredCandidatePool=result;state.shengJiFixtureCandidateObserved=true;
	   }return result;
	  };
	  const randomRemove=originalRandomRemove;
	  Array.prototype.randomRemove=function(...args){if(this===state.shengJiFilteredCandidatePool&&args.length===0)return this.splice(0,1)[0];
	   return randomRemove.apply(this,args)};
	 }
		 if(jiRiResourceFixture){
		  if(typeof get.charactersOL!=='function'||typeof get.characterGets!=='function')throw Error('JIRIMO_NATIVE_CHARACTER_POOL_UNAVAILABLE');
		  const nativeJiRiPack=lib.characterPack.teDian;
		  if(!nativeJiRiPack?.jieRiMoDao||!lib.skill.jiRi_moBaoChongJie||!Array.isArray(lib.configOL.characterPack)||!lib.configOL.characterPack.includes('teDian'))
		   throw Error('JIRIMO_NATIVE_PACK_SOURCE_UNAVAILABLE');
		  if(!lib.character.jieRiMoDao){
		   const previousPackageFlag=lib.config.extension_teDian_characters_enable;
		   lib.config.extension_teDian_characters_enable=true;
		   try{game.addCharacterPack({character:nativeJiRiPack},'teDian')}finally{
		    if(previousPackageFlag===undefined)delete lib.config.extension_teDian_characters_enable;else lib.config.extension_teDian_characters_enable=previousPackageFlag;
		   }
		   if(lib.character.jieRiMoDao!==nativeJiRiPack.jieRiMoDao)throw Error('JIRIMO_NATIVE_PACKAGE_ACTIVATION_FAILED');
		   state.jiRiFixturePackageEnabled=true;
		  }
		  get.charactersOL=function(...args){
	   if(args.length)return originalCharactersOL.apply(this,args);
	   if(state.jiRiCandidatePool)return state.jiRiCandidatePool.slice();
	   if(state.selectionSignalTrace.length<24)state.selectionSignalTrace.push({signal:'jirimoNativeSourceAvailability',characterAvailable:Boolean(lib.character.jieRiMoDao),
	    characterPackAvailable:Boolean(lib.characterPack.teDian),characterPackEntryAvailable:Boolean(lib.characterPack.teDian?.jieRiMoDao),
	    configuredPackAvailable:Array.isArray(lib.configOL.characterPack)&&lib.configOL.characterPack.includes('teDian'),
	    skillAvailable:Boolean(lib.skill.jiRi_moBaoChongJie),firstActAvailable:Boolean(_status.firstAct)});
	   if(!lib.character.jieRiMoDao)throw Error('JIRIMO_NATIVE_CHARACTER_UNAVAILABLE');
		   if(!lib.skill.jiRi_moBaoChongJie)throw Error('JIRIMO_NATIVE_SKILL_UNAVAILABLE');
		   if(!_status.firstAct)throw Error('JIRIMO_NATIVE_FIRST_ACT_UNAVAILABLE');
	   const native=originalCharactersOL.call(this);
	   if(!native.includes('jieRiMoDao'))throw Error('JIRIMO_CHARACTER_NOT_IN_NATIVE_LEGAL_POOL');
	   const actor=_status.firstAct,targetIndex=game.players.indexOf(actor),pool=Array(8).fill(null);
	   if(targetIndex<0)throw Error('JIRIMO_FIXTURE_ACTOR_NOT_SEATED');pool[targetIndex*2]='jieRiMoDao';
	   const forbidden=(lib.config.forbidlist||[]).concat(lib.config.customforbid||[]),conflicts=(candidate,selected)=>forbidden.some(pair=>Array.isArray(pair)&&pair.length>=2&&
	    ((pair[0]===candidate&&selected.includes(pair[1]))||(pair[1]===candidate&&selected.includes(pair[0]))));
	   const used=new Set(['jieRiMoDao']);for(let index=0;index<pool.length;index++)if(pool[index]===null){const candidate=native.find(name=>!used.has(name)&&!conflicts(name,[...used]));
	    if(!candidate)throw Error('JIRIMO_FIXTURE_NATIVE_POOL_TOO_SMALL');pool[index]=candidate;used.add(candidate)}
	   state.jiRiResourceFixtureSeatId=actor.playerid;state.jiRiCandidatePool=pool;return pool.slice();
	  };
	  get.characterGets=function(list,...args){const result=originalCharacterGets.call(this,list,...args);
	   if(state.jiRiCandidatePool&&Array.isArray(list)&&list.length===8&&list.includes('jieRiMoDao')){
	    const index=game.players.findIndex(player=>player.playerid===state.jiRiResourceFixtureSeatId);
	    if(result.length!==8||result.indexOf('jieRiMoDao')!==index*2)throw Error('JIRIMO_FIXTURE_POOL_FILTERED_OR_REORDERED');
	    state.jiRiFilteredCandidatePool=result;state.jiRiFixtureCandidateObserved=true;
	   }return result;
	  };
	  const randomRemove=originalRandomRemove;
	  Array.prototype.randomRemove=function(...args){if(this===state.jiRiFilteredCandidatePool&&args.length===0)return this.splice(0,1)[0];
	   return randomRemove.apply(this,args)};
	 }
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
	 game.chooseCharacterOLDuoXuanYi=(function(nativeMethod){return function(...args){state.selectionSignalTrace.push({signal:'nativeDuoXuanYiEntry',phaseSwap:Boolean(get.phaseswap()),versusMode:lib.configOL.versus_mode||null,
	   chooseMode:lib.configOL.choose_mode||null});return nativeMethod.apply(this,args)}})(game.chooseCharacterOLDuoXuanYi);
	 game.chooseCharacterOL=function(...args){state.chooseCharacterCalls++;if(state.chooseCharacterCalls!==1)throw Error('UNIFIED_CHARACTER_ENTRY_DUPLICATE');
	  state.selectionSignalTrace.push({signal:'nativeChooseCharacterEntry',phaseSwap:Boolean(get.phaseswap()),versusMode:lib.configOL.versus_mode||null,chooseMode:lib.configOL.choose_mode||null});
	  return originalChooseCharacterOL.apply(this,args)};
	 game.initSideAndPosition=function(...args){state.sideAssignmentCalls++;if(state.sideAssignmentCalls!==1)throw Error('UNIFIED_SIDE_ASSIGNMENT_DUPLICATE');
	  return originalInitSide.apply(this,args)};
		 game.broadcastAll=function(callback,...args){const current=manager.eventStack.at(-1);
	  if(state.selectionEvent&&state.selectionSignalTrace.length<16)state.selectionSignalTrace.push({signal:'broadcast',
	   currentEventName:current?.name||null,currentEventStep:Number.isSafeInteger(current?.step)?current.step:null,
	   selectionEventMatches:current===state.selectionEvent,argCount:args.length});
	  if(current===state.selectionEvent&&current.step===1){if(state.dialogBroadcasts!==0||typeof callback!=='function'||args.length!==2||
	    !Number.isSafeInteger(args[0])||!args[1]||Object.keys(args[1]).length!==game.players.length||
	    game.players.some(player=>!Array.isArray(args[1][player.playerid])||args[1][player.playerid].length<2))
	    throw Error('UNIFIED_CHARACTER_DIALOG_CONTRACT_REJECTED');state.dialogBroadcasts++;state.nativeCandidates=args[1];
	    if(yinyangFixture){const seatOptions=args[1][state.yinyangFixtureSeatId]||[];
	     if(!state.yinyangFixtureCandidateObserved||!seatOptions.includes('yinYangShi')||Object.values(args[1]).flat().filter(name=>name==='yinYangShi').length!==1)
	      throw Error('YINYANG_NATIVE_CANDIDATE_NOT_GENERATED');state.yinyangNativeCandidateGenerated=true;
	    }
	    if(shengJiResourceFixture){const seatOptions=args[1][state.shengJiResourceFixtureSeatId]||[];
	     if(!state.shengJiFixtureCandidateObserved||!seatOptions.includes('shengQiangQiShi')||Object.values(args[1]).flat().filter(name=>name==='shengQiangQiShi').length!==1)
	      throw Error('SHENGJI_NATIVE_CANDIDATE_NOT_GENERATED');state.shengJiNativeCandidateGenerated=true;
	    }
	    if(jiRiResourceFixture){const seatOptions=args[1][state.jiRiResourceFixtureSeatId]||[];
	     if(!state.jiRiFixtureCandidateObserved||!seatOptions.includes('jieRiMoDao')||Object.values(args[1]).flat().filter(name=>name==='jieRiMoDao').length!==1)
	      throw Error('JIRIMO_NATIVE_CANDIDATE_NOT_GENERATED');state.jiRiNativeCandidateGenerated=true;
	    }
	    get.charactersOL=originalCharactersOL;get.characterGets=originalCharacterGets;Array.prototype.randomRemove=originalRandomRemove;return;}
	  return originalBroadcastAll.call(this,callback,...args)};
		 globalThis.setTimeout=function(callback,delay,...args){const current=manager.eventStack.at(-1);
	  if(state.selectionEvent&&state.selectionSignalTrace.length<16)state.selectionSignalTrace.push({signal:'timeout',
	   currentEventName:current?.name||null,currentEventStep:Number.isSafeInteger(current?.step)?current.step:null,
	   selectionEventMatches:current===state.selectionEvent,delay:Number.isSafeInteger(delay)?delay:null,
	   aiTargetCount:Array.isArray(current.ai_targets)?current.ai_targets.length:null});
	  if(!state.trusteeTimerCaptured&&current===state.selectionEvent&&current.step===1&&current.ai_targets?.length===game.players.length&&
	   Number(delay)===6000){state.trusteeTimerCaptured=true;state.trusteeTimerSuppressed=true;return 0}
	  return originalSetTimeout(callback,delay,...args)};
		 game.pause=function(...args){const current=manager.eventStack.at(-1);
	  if(current===state.selectionEvent&&state.selectionSignalTrace.length<16)state.selectionSignalTrace.push({signal:'selectionPause',
	   currentEventStep:Number.isSafeInteger(current.step)?current.step:null,aiTargetCount:Array.isArray(current.ai_targets)?current.ai_targets.length:null});
	  if(current===state.selectionEvent&&current.ai_targets?.length===game.players.length){
	   if(state.dialogBroadcasts!==1||!state.trusteeTimerCaptured||!state.nativeCandidates)throw Error('UNIFIED_CHOICE_GATE_PRECONDITION_REJECTED');
	   state.choiceReady=true;state.choiceEventId='native_'+${JSON.stringify(identity.sessionId.slice(3))}+'_character_selection';}
	  return originalPause.apply(this,args)};
	 GameEvent.prototype.trigger=function(name,...args){if(name==='gameStart')state.gameStartCount++;return originalTrigger.call(this,name,...args)};
	 game.createEvent=function(name,...args){const event=originalCreateEvent.call(this,name,...args);
	  if(name==='chooseCharacterOL'){state.selectionEventCount++;if(state.selectionEventCount!==1)throw Error('UNIFIED_SELECTION_EVENT_DUPLICATE');state.selectionEvent=event;event.__v2NativeEventId='native_'+${JSON.stringify(identity.sessionId.slice(3))}+'_character_selection';
	   const nativeGoto=event.goto,nativeUpdateStep=event.updateStep;event.goto=function(step){if(state.selectionSignalTrace.length<24)state.selectionSignalTrace.push({signal:'selectionStepGoto',from:Number.isSafeInteger(event.step)?event.step:null,to:Number.isSafeInteger(step)?step:null});return nativeGoto.call(this,step)};
	   event.updateStep=function(...stepArgs){const before=Number.isSafeInteger(event.step)?event.step:null,result=nativeUpdateStep.apply(this,stepArgs),after=Number.isSafeInteger(event.step)?event.step:null;
	    if(state.selectionSignalTrace.length<24&&before!==after)state.selectionSignalTrace.push({signal:'selectionStepAdvanced',from:before,to:after,finished:event.finished===true});return result};
	   const nativeSetContent=event.setContent;event.setContent=function(content){const result=nativeSetContent.call(this,content);state.selectionSignalTrace.push({signal:'selectionContentSet',contentType:typeof content,compiledContentType:typeof event.content});
	    const compiled=event.content;event.content=function(...contentArgs){if(state.selectionSignalTrace.length<24)state.selectionSignalTrace.push({signal:'selectionContentExecute',eventStep:Number.isSafeInteger(event.step)?event.step:null,
	     finished:event.finished===true,currentEventMatches:_status.event===event,stackTopMatches:manager.eventStack.at(-1)===event});try{const pending=compiled.apply(this,contentArgs);return pending?.then?pending.catch(error=>{
	     const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)?error.code:
	      typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)?error.message:null;
	      if(state.selectionSignalTrace.length<24)state.selectionSignalTrace.push({signal:'selectionContentRejected',eventStep:Number.isSafeInteger(event.step)?event.step:null,
	       errorName:typeof error?.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error.name)?error.name:'Error',errorCode:code});throw error}):pending}
	     catch(error){if(state.selectionSignalTrace.length<24)state.selectionSignalTrace.push({signal:'selectionContentThrew',eventStep:Number.isSafeInteger(event.step)?event.step:null,
	      errorName:typeof error?.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error.name)?error.name:'Error'});throw error}};return result};}
	  if(name==='initSideAndPosition'){state.sideEventCount++;if(state.sideEventCount!==1)throw Error('UNIFIED_SIDE_EVENT_DUPLICATE');state.sideEvent=event}
	  if(name==='gameDraw'){if(state.drawCreated)throw Error('UNIFIED_DRAW_DUPLICATE');state.drawCreated=true;state.draw=event}
	  if(name==='phaseLoop'){if(state.phaseLoopCreated)throw Error('UNIFIED_PHASE_LOOP_DUPLICATE');state.phaseLoopCreated=true;state.phaseLoop=event}
	  return event};
	 GameEvent.prototype.start=function(...args){const event=this;
	  if(event===state.phaseLoop){if(state.phaseLoopStartPromise)return state.phaseLoopStartPromise;
	   state.phaseLoopStartRequested=true;state.phaseLoopPaused=true;state.status='phase_loop_gated';
	   if(!state.drawCompleted||event.parent!==state.root)throw Error('UNIFIED_PHASE_LOOP_PRECONDITION_REJECTED');state.event3Ready=true;
	   state.phaseLoopStartPromise=state.phaseLoopGate.then(()=>{if(state.phaseLoopStarted)throw Error('UNIFIED_PHASE_LOOP_START_DUPLICATE');state.phaseLoopStarted=true;
	    state.phaseLoopPaused=false;return originalStart.apply(event,args)});return state.phaseLoopStartPromise}
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
		 game.gameDraw=function(...args){if(state.drawCreated)throw Error('UNIFIED_DRAW_DUPLICATE_CALL');
		  if(yinyangFixture){
		   try {
		   if(state.yinyangDeckPrepared||!args[0]||args[0]!==_status.firstAct)throw Error('YINYANG_NATIVE_DECK_FIXTURE_PRECONDITION_REJECTED');
	   const target=game.players.find(player=>player.playerid===state.yinyangFixtureSeatId),drawOrder=[];
	   for(let player=args[0],count=0;player&&count<game.players.length;player=player.next,count++)drawOrder.push(player);
	   if(drawOrder.length!==4||drawOrder.at(-1).next!==args[0]||!target||target.side===args[0].side)throw Error('YINYANG_NATIVE_DECK_SEAT_ORDER_REJECTED');
	   const pile=Array.from(ui.cardPile.children),attacks=pile.filter(card=>get.type(card)==='gongJi'&&get.xiBie(card)!=='an');
	   let attack=null,material=null;
	   for(const candidate of attacks){const match=attacks.find(other=>other!==candidate&&get.mingGe(other,false)===get.mingGe(candidate,false));
	    if(match){attack=candidate;material=match;break}}
	   if(!attack||!material||get.mingGe(attack,false)!==get.mingGe(material,false))throw Error('YINYANG_NATIVE_DECK_NO_LEGAL_MINGGE_PAIR');
	   const slots=Array(16).fill(null),targetDrawIndex=drawOrder.indexOf(target);
	   if(targetDrawIndex<1||targetDrawIndex>3)throw Error('YINYANG_NATIVE_DECK_TARGET_ORDER_REJECTED');
	   slots[0]=attack;slots[targetDrawIndex*4]=material;
	   const used=new Set([attack,material]);let cursor=0;
	   for(let index=0;index<slots.length;index++)if(!slots[index]){while(cursor<pile.length&&used.has(pile[cursor]))cursor++;
	    if(!pile[cursor])throw Error('YINYANG_NATIVE_DECK_FIXTURE_UNDERSIZED');slots[index]=pile[cursor];used.add(pile[cursor++])}
	   const ordered=slots.concat(pile.filter(card=>!used.has(card)));
	   if(ordered.length!==pile.length||new Set(ordered).size!==pile.length)throw Error('YINYANG_NATIVE_DECK_FIXTURE_CARD_CONSERVATION_FAILED');
	   for(const card of ordered)ui.cardPile.appendChild(card);
		   state.yinyangDeckPrepared=true;state.yinyangDeckProof={nativePhysicalCards:true,nativeDrawOrder:drawOrder.map(player=>player.playerid),
		    fixtureSeatId:target.playerid,attackAndMaterialSameMingGe:true,attackCanYingZhan:get.xiBie(attack)!=='an',deckCardCount:pile.length};
		   } catch(error) { state.failureCode='YINYANG_NATIVE_DECK_FIXTURE_FAILED';state.failureDetail=String(error?.message||error).slice(0,120);throw error }
		  }
	  return originalGameDraw.apply(this,args)};
	 game.phaseLoop=function(...args){if(state.phaseLoopCreated)throw Error('UNIFIED_PHASE_LOOP_DUPLICATE_CALL');const result=originalPhaseLoop.apply(this,args);
	  if(state.phaseLoop?.parent!==state.root)throw Error('UNIFIED_PHASE_LOOP_PARENT_INVALID');return result};
	 state.root=game.createEvent('game',false).setContent(managed.mode.start);state.rootInstanceId='native_root_'+${JSON.stringify(identity.sessionId.slice(3))};
	 if(state.root.name!=='game'||state.root.parent)throw Error('UNIFIED_ROOT_INVALID');
	 const promise=state.root.start();promise.then(()=>{state.rootPromiseState='fulfilled';state.status='root_fulfilled'},error=>{
	  state.rootPromiseState='rejected';state.failureCode='UNIFIED_ROOT_REJECTED';state.failureDetail=String(error?.message||error).slice(0,160)});
	 return {started:true,rootName:state.root.name,rootEventId:state.root.id||null,hostPlayerAbsent:game.me===null};})()`,
		returnByValue: true }, 5000);
	if (initialized.exceptionDetails || initialized.result?.value?.started !== true || initialized.result.value.hostPlayerAbsent !== true) {
		throw new Error(`UNIFIED_ROOT_START_FAILED:${initialized.exceptionDetails?.exception?.description || initialized.exceptionDetails?.text || JSON.stringify(initialized.result?.value || null)}`);
	}
	const evaluateState = async () => {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2ManagedUnifiedRoot,m=window.__v2ManagedEngine.core,{game,lib,get,_status}=m;
		 return s?{status:s.status,failureCode:s.failureCode,failureDetail:s.failureDetail||null,rootPromiseState:s.rootPromiseState,
		  rootInstanceId:s.rootInstanceId,selectionParentName:s.selectionEvent?.parent?.name||null,sideEventParentName:s.sideEvent?.parent?.name||null,
		  rootStep:Number.isSafeInteger(s.root?.step)?s.root.step:null,rootFinished:Boolean(s.root?.finished),nativeOver:Boolean(_status.over),
		  onlyChooseCharacter:lib.configOL.onlyChooseCharacter===true,phaseSwap:get.phaseswap(),firstActSeatId:_status.firstAct?.playerid||null,
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
	  dialogBroadcasts:s.dialogBroadcasts,trusteeTimerCaptured:s.trusteeTimerCaptured,yinyangFixtureEnabled:s.yinyangFixtureEnabled,
	  yinyangFixtureSeatId:s.yinyangFixtureSeatId,yinyangNativeCandidateGenerated:s.yinyangNativeCandidateGenerated===true,
		  firstActSeatId:_status.firstAct?.playerid||null,
		  yinyangNativeCandidateOptions:s.yinyangFixtureEnabled?(s.nativeCandidates?.[s.yinyangFixtureSeatId]||[]):[],
		  shengJiResourceFixtureEnabled:s.shengJiResourceFixtureEnabled,shengJiResourceFixtureSeatId:s.shengJiResourceFixtureSeatId,
		  shengJiNativeCandidateGenerated:s.shengJiNativeCandidateGenerated===true,
		  shengJiNativeCandidateOptions:s.shengJiResourceFixtureEnabled?(s.nativeCandidates?.[s.shengJiResourceFixtureSeatId]||[]):[],
		  jiRiResourceFixtureEnabled:s.jiRiResourceFixtureEnabled,jiRiResourceFixtureSeatId:s.jiRiResourceFixtureSeatId,
		  jiRiNativeCandidateGenerated:s.jiRiNativeCandidateGenerated===true}:null})()`, returnByValue: true }, 1500);
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
		if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && proof.eventSequence === 1) process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
			observed: { kind: "native_jirimo_root_snapshot_v1", stage: "native_jirimo_event1_ack_accepted", eventSequence: 1 } });
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
	if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
		observed: { kind: "native_jirimo_root_snapshot_v1", stage: "native_jirimo_event1_revision_finalized", eventSequence: 1 } });
	await release("Event1");
	if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
		observed: { kind: "native_jirimo_root_snapshot_v1", stage: "native_jirimo_event1_gate_released", eventSequence: 1 } });
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
	process.send?.({ ...identity, type: "host_choice_candidates", nativeEventId, eventSequence: 2, choices: choiceReady.choices, deadlineMs: 3000,
		...(choiceReady.yinyangFixtureEnabled ? { yinyangFixture: { seatId: choiceReady.yinyangFixtureSeatId,
			nativeCandidateGenerated: choiceReady.yinyangNativeCandidateGenerated === true } } : {}),
		...(choiceReady.shengJiResourceFixtureEnabled ? { firstActSeatId: choiceReady.firstActSeatId,
			resourceFixture: { seatId: choiceReady.shengJiResourceFixtureSeatId,
				nativeCandidateGenerated: choiceReady.shengJiNativeCandidateGenerated === true } } : {}),
		...(choiceReady.jiRiResourceFixtureEnabled ? { firstActSeatId: choiceReady.firstActSeatId,
			jiRiFixture: { seatId: choiceReady.jiRiResourceFixtureSeatId,
				nativeCandidateGenerated: choiceReady.jiRiNativeCandidateGenerated === true } } : {}) });
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
	const openingRootActionMode = experimentalAuthorityEventEnabled(5) ?
			"managed_opening_root_action_event5" : "managed_opening_root_action_event4";
	await runNativeStartDiagnostic({ ...identity, type: "host_native_start_diagnostic", mode: openingRootActionMode });
}

function gameSetupSeatCount() {
	return 4;
}

function waitForAuthorityEventAck(eventSequence, stateRevision, afterDigest, timeoutMs = 15000) {
	const experimentalOptIn = experimentalAuthorityEventEnabled(eventSequence);
	if (!([1, 2, 3, 4].includes(eventSequence) || experimentalOptIn) || stateRevision !== eventSequence || !/^[a-f0-9]{64}$/.test(afterDigest) ||
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
	  phaseLoopStarted:false,phaseLoopPaused:false,phaseLoopGate:null,phaseLoopStartPromise:null,
	  waitForPlayerCalls:0,randomMapOLCalls:0,rootPromiseState:'pending',failureCode:null};
	 let releasePhaseLoop;state.phaseLoopGate=new Promise(resolve=>{releasePhaseLoop=resolve});state.releasePhaseLoop=releasePhaseLoop;
	 window.__v2ManagedOpeningDraw=state;
	 const GameEvent=lib.element.GameEvent,originalWaitNext=GameEvent.prototype.waitNext,originalStart=GameEvent.prototype.start;
	 const originalCreateEvent=game.createEvent,originalWaitForPlayer=game.waitForPlayer,originalRandomMapOL=game.randomMapOL;
	 const originalPrepareArena=game.prepareArena,originalChooseCharacter=game.chooseCharacter,originalInit=game.initSideAndPosition;
	 const originalDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop,originalTrigger=GameEvent.prototype.trigger;
	 GameEvent.prototype.waitNext=function(...args){const event=this;if(event.name==='gameDraw')state.drawEntered=true;return originalWaitNext.apply(this,args).then(value=>{if(event===state.draw){state.drawCompleted=true;state.drawFinalStep=event.step}return value},error=>{state.failureCode='OPENING_DRAW_CHILD_FAILED';throw error})};
	 GameEvent.prototype.start=function(...args){if(this===state.phaseLoop){if(state.phaseLoopStartPromise)return state.phaseLoopStartPromise;
	  state.phaseLoopStartRequested=true;state.phaseLoopPaused=true;state.status='phase_loop_gated';
	  state.phaseLoopStartPromise=state.phaseLoopGate.then(()=>{if(state.phaseLoopStarted)throw Error('OPENING_PHASE_LOOP_START_DUPLICATE');
	   state.phaseLoopStarted=true;state.phaseLoopPaused=false;return originalStart.apply(this,args)});return state.phaseLoopStartPromise}
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
	if (interactiveChoice?.nativeSkillTargetGates?.has(message?.nativeEventId)) {
		return applyManagedJiRiTargetDelivery(message);
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

async function applyManagedJiRiTargetDelivery(message) {
	const gate = interactiveChoice?.nativeSkillTargetGates?.get(message?.nativeEventId);
		if (!gate || !validHostCommand(message) || message.nativeEventId !== gate.nativeEventId || message.seatId !== gate.seatId || typeof message.choiceId !== "string" ||
		typeof message.deliveryId !== "string" || !["player", "trustee"].includes(message.resolution?.kind) ||
		typeof message.resolution?.option !== "string") throw new Error("JIRIMO_TARGET_DELIVERY_REJECTED");
	const prior = gate.delivery;
	if (prior) {
		if (prior.choiceId !== message.choiceId || prior.deliveryId !== message.deliveryId || prior.optionId !== message.resolution.option)
			throw new Error("JIRIMO_TARGET_DELIVERY_CONFLICT");
		if (prior.status === "applying") {
			const replayProof = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,g=s?.nativeSkillTargetGates?.get(${JSON.stringify(gate.nativeEventId)}),o=window.__v2ManagedJiRiTargetOptions?.get(${JSON.stringify(prior.optionId)}),e=g?.event,p=e?.player;return {eventId:g?.eventId||null,seatId:g?.seatId||null,deliveryId:g?.delivery?.deliveryId||null,choiceId:g?.delivery?.choiceId||null,status:g?.status||null,deliveryStatus:g?.delivery?.status||null,eventFinished:e?.finished===true,resultMatches:Boolean(e?.result?.bool===true&&e.result.cards?.length===1&&e.result.cards[0]===o?.card),cardMoved:Boolean(o&&p&&!p.getCards('h').includes(o.card)),rootMatches:g?.rootInstanceId===s?.rootInstanceId,gameMeAbsent:s?.root&&window.__v2ManagedEngine?.core?.game?.me===null}})()`, returnByValue: true }, 1500);
			const proof = replayProof.result?.value;
			if (replayProof.exceptionDetails || proof?.eventId !== gate.nativeEventId || proof?.seatId !== gate.seatId ||
				proof?.choiceId !== prior.choiceId || proof?.deliveryId !== prior.deliveryId || proof?.status !== "applied" ||
				proof?.deliveryStatus !== "applied" || !proof?.eventFinished || !proof?.resultMatches || !proof?.cardMoved ||
				!proof?.rootMatches || !proof?.gameMeAbsent) return;
			prior.status = "applied";
		}
		if (prior.status !== "applied") throw new Error("JIRIMO_TARGET_DELIVERY_UNCERTAIN");
		process.send?.({ ...identity, type: "host_choice_ack", nativeApplied: true, nativeResponseEventCompleted: true,
			choiceId: prior.choiceId, deliveryId: prior.deliveryId, nativeEventId: gate.nativeEventId, seatId: gate.seatId });
		return;
	}
	if (gate.status !== "waiting" || !gate.optionIds.includes(message.resolution.option)) throw new Error("JIRIMO_TARGET_OPTION_REJECTED");
	const delivery = gate.delivery = { choiceId: message.choiceId, deliveryId: message.deliveryId, optionId: message.resolution.option, status: "applying" };
	const expression = `(()=>{const state=window.__v2NativeStartDiagnosticState,g=state?.nativeSkillTargetGates?.get(${JSON.stringify(gate.nativeEventId)}),o=window.__v2ManagedJiRiTargetOptions?.get(${JSON.stringify(delivery.optionId)}),core=window.__v2ManagedEngine?.core,{game,lib,get}=core||{};
	 if(!g||g.eventId!==${JSON.stringify(gate.nativeEventId)}||g.status!=='waiting'||!g.event||g.event.__v2ManagedJiRiTargetGate!==g.eventId||!o||o.event!==g.event||o.seatId!==g.seatId||o.card==null||o.target!==g.event.player)return {ok:false,code:'JIRIMO_TARGET_BINDING_REJECTED'};
	 const e=g.event,p=e.player,range=get.select(e.selectCard),valid=range?.[0]===1&&range?.[1]===1&&p?.playerid===g.seatId&&p.getCards(e.position||'h').includes(o.card)&&
	  e.filterCard?.(o.card,p,e)===true&&lib.filter.cardDiscardable(o.card,p,e)&&get.type(o.card,p)==='faShu';
	 if(!valid)return {ok:false,code:'JIRIMO_TARGET_OPTION_REVALIDATION_REJECTED'};
	 g.status='applying';g.appliedOptionId=${JSON.stringify(delivery.optionId)};g.delivery={choiceId:${JSON.stringify(delivery.choiceId)},deliveryId:${JSON.stringify(delivery.deliveryId)},optionId:${JSON.stringify(delivery.optionId)},status:'applying'};state.nativeAction.nativeSkillTargetChoiceDelivered=true;e.result={bool:true,cards:[o.card],rawcards:[o.card]};game.resume();return {ok:true,eventName:e.name,eventStep:Number.isSafeInteger(e.step)?e.step:null,parentEventName:e.parent?.name||null,seatId:g.seatId,gameMeAbsent:game.me===null};})()`;
	try {
		const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 1500);
		if (response.exceptionDetails || response.result?.value?.ok !== true) throw new Error(response.result?.value?.code || "JIRIMO_TARGET_APPLY_UNCERTAIN");
		gate.status = "applying";
	} catch (error) { delivery.status = "uncertain"; throw error; }
}

async function applyManagedNativeResponseDelivery(message) {
	const gate = interactiveChoice?.nativeResponseGates?.get(message?.nativeEventId);
	if (!gate || !validHostCommand(message) || message.nativeEventId !== gate.nativeEventId || message.seatId !== gate.seatId ||
		(gate.eventSequence === 5 && message.eventSequence !== 5) ||
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
		if (prior.status === "applying" || prior.status === "dispatched") {
			// The native page and this supervisor keep separate gate records. A page
			// completion ACK may have been lost while this Node record remains stale;
			// query the exact native gate read-only before deciding whether to ACK.
			// If the native child is still running, remember the retry and never apply
			// its result again.
			prior.ackRetryRequested = true;
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_response_delivery_retry_v1", stage: "native_response_duplicate_while_applying",
					seatId: gate.seatId, choiceId: prior.choiceId, deliveryId: prior.deliveryId } });
			const completion = await inspectNativeResponseDelivery(gate, prior);
			if (completion?.applied === true) {
				prior.status = "applied";
				gate.status = "applied";
				prior.ackRetryRequested = false;
				process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
					observed: { kind: "native_response_delivery_retry_v1", stage: "native_response_duplicate_verified_applied",
						seatId: gate.seatId, choiceId: prior.choiceId, deliveryId: prior.deliveryId } });
				process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: prior.choiceId,
					deliveryId: prior.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true,
					nativeResponseEventCompleted: true, nativeUseCardChildCount: completion.useCardChildrenCompleted,
					nativeCompletionOrdinal: completion.nativeCompletionOrdinal });
			}
			return;
		}
		if (prior.status !== "applied") throw new Error("NATIVE_RESPONSE_DELIVERY_UNCERTAIN");
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_response_delivery_retry_v1", stage: "native_response_duplicate_after_apply",
				seatId: gate.seatId, choiceId: prior.choiceId, deliveryId: prior.deliveryId } });
		process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: prior.choiceId,
			deliveryId: prior.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true,
			nativeResponseEventCompleted: true, nativeUseCardChildCount: gate.useCardChildrenCompleted,
			nativeCompletionOrdinal: gate.completedProof?.nativeCompletionOrdinal });
		return;
	}
	if (gate.status !== "waiting" || !gate.optionIds.includes(optionId)) throw new Error("NATIVE_RESPONSE_OPTION_REJECTED");
	const delivery = gate.delivery = { choiceId: message.choiceId, deliveryId: message.deliveryId, optionId, status: "applying" };
	const faultMode = process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "";
	const executionFaultModes = ["viewas_result_assignment_throws", "viewas_useCard_child_throws", "viewas_partial_effect_throws", "viewas_partial_effect_stop"];
	let faultBarrier = null;
	if (executionFaultModes.includes(faultMode)) {
		let release;
		const released = new Promise(resolve => { release = resolve; });
		const timer = setTimeout(() => {
			if (nativeFaultApplyBarrier?.choiceId === message.choiceId && nativeFaultApplyBarrier.deliveryId === message.deliveryId) {
				nativeFaultApplyBarrier = null;
				release(false);
			}
		}, 10000);
		if (timer.unref) timer.unref();
		faultBarrier = { choiceId: message.choiceId, deliveryId: message.deliveryId, nativeEventId: gate.nativeEventId, release, timer, released };
		nativeFaultApplyBarrier = faultBarrier;
	}
	await notifyChoiceDeliveryApplying({ ...delivery, nativeEventId: gate.nativeEventId, seatId: gate.seatId });
	if (faultBarrier) {
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_viewas_fault_barrier_v1", stage: "native_viewas_delivery_preapply_barrier",
				choiceId: message.choiceId, deliveryId: message.deliveryId, seatId: gate.seatId } });
		const released = await faultBarrier.released;
		clearTimeout(faultBarrier.timer);
		if (nativeFaultApplyBarrier === faultBarrier) nativeFaultApplyBarrier = null;
		if (released !== true) throw new Error("NATIVE_VIEWAS_FAULT_BARRIER_TIMEOUT");
	}
	const applied = await cdp.send("Runtime.evaluate", { expression: `(()=>{
	 const s=window.__v2NativeStartDiagnosticState,g=s?.managedNativeResponseGates?.get(${JSON.stringify(gate.nativeEventId)}),o=g?.options?.get(${JSON.stringify(optionId)}),
	  core=window.__v2ManagedEngine?.core,game=core?.game,event=g?.event,player=event?.player;
	 if(!g||s.managedNativeResponseGates.get(${JSON.stringify(gate.nativeEventId)})!==g||g.status!=='waiting'||g.waitResolved||!g.waitEvent||g.waitEvent.parent!==event||event?.__v2NativeEventId!==${JSON.stringify(gate.nativeEventId)}||player?.playerid!==${JSON.stringify(gate.seatId)}||!o||o.event!==event||o.seatId!==${JSON.stringify(gate.seatId)}||!core||game.me!==null)return {ok:false,code:'NATIVE_RESPONSE_BINDING_REJECTED'};
	 if(o.kind==='decline'){
	  if(event.forced===true||${JSON.stringify(optionId)}!==g.declineOptionId)return {ok:false,code:'NATIVE_RESPONSE_DECLINE_REJECTED'};
	  g.status='applying';g.delivery={choiceId:${JSON.stringify(message.choiceId)},deliveryId:${JSON.stringify(message.deliveryId)},optionId:${JSON.stringify(optionId)},status:'applying'};
	  event.result={bool:false};g.waitResolved=true;g.resolveWait();return {ok:true,kind:'decline',globalPaused:Boolean(core._status?.paused)};
	 }
	 const {card,target}=o,shape=g.optionShapes[${JSON.stringify(optionId)}];
		 if(o.kind==='view_as_skill'){
	  const previousStatusEvent=core._status?.event;try{if(core._status)core._status.event=event;
	  const info=core.lib.skill?.[o.skillId],material=o.material,resultBefore=event.result;let testFault=null;
	  const faultMode=${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")};
	  if(['viewas_material_removed_before_revalidation','viewas_skill_removed_before_revalidation','viewas_condition_invalid_before_revalidation'].includes(faultMode)){
	   const originalVirtual=info?.viewAs?.call(info,[material],player),candidateWasGenerated=o.kind==='view_as_skill'&&g.optionIds.includes(${JSON.stringify(optionId)})&&o.event===event&&o.seatId===player.playerid&&
	    Boolean(info&&player.hasSkill(o.skillId)&&core.lib.filter.filterEnable(event,player,o.skillId)===true&&info.filter?.call(info,event,player)===true&&material&&player.getCards('h').includes(material)&&
	     info.filterCard?.call(info,material,player)===true&&originalVirtual&&event.filterCard?.(originalVirtual,player,event)&&target&&event.filterTarget?.(originalVirtual,player,target)&&core.lib.filter.targetEnabled(originalVirtual,player,target));
	   if(!candidateWasGenerated||g.status!=='waiting'||g.waitResolved)return {ok:false,code:'NATIVE_VIEWAS_FAULT_PRECONDITION_REJECTED'};
	   if(faultMode==='viewas_material_removed_before_revalidation')material.classList.add('removing');
	   else if(faultMode==='viewas_skill_removed_before_revalidation')player.removeSkill(o.skillId);
	   else event.canYingZhan=false;
	   testFault={mode:faultMode,candidateWasGenerated:true,invalidationApplied:true};
	  }
	  const virtual=info?.viewAs?.call(info,[material],player),
	   checks={skillBound:o.skillId==='yinYangZhanHuan'&&o.kind==='view_as_skill',skillOwned:Boolean(info&&player.hasSkill(o.skillId)),skillEnabled:Boolean(info&&core.lib.filter.filterEnable(event,player,o.skillId)===true),
	    skillFilter:Boolean(info&&info.filter?.call(info,event,player)===true),eventBound:o.event===event&&o.seatId===player.playerid,materialInHand:Boolean(material&&player.getCards('h').includes(material)),
	    materialFilter:Boolean(info&&info.filterCard?.call(info,material,player)===true),virtualMatches:Boolean(virtual&&virtual.name===o.virtualCard?.name&&virtual.xiBie===o.virtualCard?.xiBie&&virtual.isCard===true),
	    eventCardFilter:Boolean(virtual&&event.filterCard?.(virtual,player,event)),cardEnabled:Boolean(virtual&&core.lib.filter.cardEnabled(virtual,player,'forceEnable')),
	    targetFilter:Boolean(virtual&&target&&event.filterTarget?.(virtual,player,target)),targetEnabled:Boolean(virtual&&target&&core.lib.filter.targetEnabled(virtual,player,target))};
	  const legal=Object.values(checks).every(Boolean);
	  if(!legal||g.status!=='waiting'||g.useCardChildrenStarted!==0){const resultUntouched=event.result===resultBefore;if(testFault)testFault.resultUntouched=resultUntouched;
	   return {ok:false,code:'NATIVE_VIEWAS_REVALIDATION_REJECTED',checks,testFault,resultUntouched};}
	  if(faultMode==='viewas_result_assignment_throws'){
	   const snapshot={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,nativeEventId:g.nativeEventId,seatId:g.seatId,
	    candidateWasGenerated:true,originalChecksAccepted:Object.values(checks).every(Boolean),resultUntouched:event.result===resultBefore,useCardChildrenStarted:g.useCardChildrenStarted,
	    failureCode:'NATIVE_VIEWAS_RESULT_SET_FAILED',gameMeAbsent:game.me===null};
	   try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_viewas_result_assignment_exception',snapshot}))}catch{}
	   throw Error('NATIVE_VIEWAS_RESULT_SET_FAILED')
	  }
	  g.status='applying';g.delivery={choiceId:${JSON.stringify(message.choiceId)},deliveryId:${JSON.stringify(message.deliveryId)},optionId:${JSON.stringify(optionId)},status:'applying'};
	  event.result={bool:true,card:virtual,cards:[material],targets:[target],skill:o.skillId};g.waitResolved=true;g.resolveWait();
	  return {ok:true,kind:'view_as_skill',skillId:o.skillId,physicalMaterialCount:1,targetCount:1,globalPaused:Boolean(core._status?.paused)};
	  }finally{if(core._status)core._status.event=previousStatusEvent}
	 }
	 let legal=false;const previousStatusEvent=core._status?.event;
	 try{if(core._status)core._status.event=event;legal=o.kind==='card'&&player.getCards(event.position||'hs').includes(card)&&event.filterCard?.(card,player,event)&&
	  (shape==='native_notarget_card'?target===null&&(()=>{const info=core.get.info(core.get.autoViewAs(card)),range=info?.selectTarget===undefined?(info?.filterTarget===undefined?[0,0]:[1,1]):core.get.select(info.selectTarget);return info?.notarget===true&&(Array.isArray(range)?range[0]===0&&range[1]===0:range===0)})():
	   shape==='native_single_target_card'&&Boolean(target)&&event.filterTarget?.(card,player,target)&&core.lib.filter.targetEnabled(card,player,target))}finally{if(core._status)core._status.event=previousStatusEvent}
	 if(!legal)return {ok:false,code:'NATIVE_RESPONSE_REVALIDATION_REJECTED'};
	 if(g.status!=='waiting'||g.useCardChildrenStarted!==0)return {ok:false,code:'NATIVE_RESPONSE_ALREADY_APPLIED'};
	 g.status='applying';g.delivery={choiceId:${JSON.stringify(message.choiceId)},deliveryId:${JSON.stringify(message.deliveryId)},optionId:${JSON.stringify(optionId)},status:'applying'};
	 event.result={bool:true,card:core.get.autoViewAs(card),cards:[card],targets:target?[target]:[]};g.waitResolved=true;g.resolveWait();
	 return {ok:true,kind:'card',optionShape:shape,targetCount:target?1:0,globalPaused:Boolean(core._status?.paused)};
	})()`, returnByValue: true }, 1500);
	const value = applied.result?.value;
	if (applied.exceptionDetails || value?.ok !== true) {
		delivery.status = "uncertain";
		if (value?.checks && Object.keys(value.checks).every(key => /^[A-Za-z]{1,32}$/.test(key)) && Object.values(value.checks).every(item => typeof item === "boolean")) {
			const fault = value.testFault && ["viewas_material_removed_before_revalidation", "viewas_skill_removed_before_revalidation", "viewas_condition_invalid_before_revalidation"].includes(value.testFault.mode) ? {
				mode: value.testFault.mode, candidateWasGenerated: value.testFault.candidateWasGenerated === true,
				invalidationApplied: value.testFault.invalidationApplied === true, resultUntouched: value.testFault.resultUntouched === true,
				postValidationResultUntouched: value.resultUntouched === true } : null;
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_viewas_revalidation_v1", stage: "native_viewas_revalidation_rejected", failedChecks: Object.keys(value.checks).filter(key => !value.checks[key]).slice(0, 12),
					...(fault ? { testFault: fault } : {}) } });
		}
		const exceptionText = String(applied.exceptionDetails?.exception?.description || "");
		const testFailureCode = /\bNATIVE_VIEWAS_RESULT_SET_FAILED\b/.exec(exceptionText)?.[0];
		throw new Error(testFailureCode || value?.code || "NATIVE_RESPONSE_APPLY_UNCERTAIN");
	}
	delivery.status = "dispatched";
}

async function inspectNativeResponseDelivery(gate, delivery) {
	if (!cdp || !gate || !delivery || !interactiveChoice?.nativeResponseGates?.has(gate.nativeEventId) ||
		interactiveChoice.nativeResponseGates.get(gate.nativeEventId) !== gate) return null;
	try {
		const response = await cdp.send("Runtime.evaluate", { expression: `(()=>{
		 const state=window.__v2NativeStartDiagnosticState,g=state?.managedNativeResponseGates?.get(${JSON.stringify(gate.nativeEventId)}),
		  d=g?.delivery,r=g?.completedResult,m=window.__v2ManagedEngine?.core,manager=m?._status?.eventManager;
		 if(!g||!d||!r)return {found:Boolean(g),applied:false};
		 return {found:true,nativeEventId:g.nativeEventId,seatId:g.seatId,eventName:g.eventName,rootInstanceId:state.rootInstanceId||null,
		  rootObjectMatches:state.root?manager?.rootEvent===state.root:false,gameMeAbsent:m?.game?.me===null,
		  status:g.status,deliveryStatus:d.status,choiceId:d.choiceId,deliveryId:d.deliveryId,optionId:d.optionId,
		  selectedKind:r.selectedKind,bool:r.bool,hasCardName:typeof r.cardName==='string'&&r.cardName.length>0,
		  targetSeatId:r.targetSeatId||null,targetCount:r.targetCount,useCardChildrenStarted:r.useCardChildrenStarted,
		  useCardChildrenCompleted:r.useCardChildrenCompleted,skillId:r.skillId||null,physicalMaterialConsumed:r.physicalMaterialConsumed===true,
		  xiBieApplied:r.xiBieApplied===true,guiHuoDelta:Number.isSafeInteger(r.guiHuoDelta)?r.guiHuoDelta:null,
		  nativeCompletionOrdinal:r.nativeCompletionOrdinal};
	 })()`, returnByValue: true }, 1500);
		const proof = response.result?.value;
		if (response.exceptionDetails || !proof || proof.found !== true || !Number.isSafeInteger(proof.nativeCompletionOrdinal) || proof.nativeCompletionOrdinal < 1) return null;
		const kind = gate.optionKinds?.[delivery.optionId];
		const identityMatches = proof.nativeEventId === gate.nativeEventId && proof.seatId === gate.seatId &&
			proof.eventName === "yingZhan" && proof.rootObjectMatches === true && proof.rootInstanceId === gate.rootInstanceId &&
			proof.gameMeAbsent === true && proof.status === "applied" && proof.deliveryStatus === "applied" &&
			proof.choiceId === delivery.choiceId && proof.deliveryId === delivery.deliveryId && proof.optionId === delivery.optionId;
		const resultMatches = kind === "card" ? proof.bool === true && proof.selectedKind === "card" && proof.hasCardName &&
			proof.useCardChildrenStarted === 1 && proof.useCardChildrenCompleted === 1 &&
			(gate.optionShapes?.[delivery.optionId] === "native_single_target_card" ? proof.targetCount === 1 && typeof proof.targetSeatId === "string" :
				gate.optionShapes?.[delivery.optionId] === "native_notarget_card" && proof.targetCount === 0 && proof.targetSeatId === null) :
			kind === "view_as_skill" ? proof.bool === true && proof.selectedKind === "view_as_skill" && proof.skillId === "yinYangZhanHuan" &&
			proof.physicalMaterialConsumed === true && proof.xiBieApplied === true && Number.isSafeInteger(proof.guiHuoDelta) &&
			proof.guiHuoDelta > 0 && proof.targetCount === 1 && typeof proof.targetSeatId === "string" &&
			proof.useCardChildrenStarted === 1 && proof.useCardChildrenCompleted === 1 :
			kind === "decline" && proof.bool === false && proof.selectedKind === "decline" && proof.targetCount === 0 &&
			proof.useCardChildrenStarted === 0 && proof.useCardChildrenCompleted === 0;
		if (!identityMatches || !resultMatches) return null;
		return Object.freeze({ applied: true, useCardChildrenCompleted: proof.useCardChildrenCompleted,
			nativeCompletionOrdinal: proof.nativeCompletionOrdinal });
	} catch (_) { return null; }
}

async function applyManagedNativeActionDelivery(message) {
	const gate = interactiveChoice?.nativeInputGate;
	if (!gate || !validHostCommand(message) || message.nativeEventId !== gate.nativeEventId || message.seatId !== gate.seatId ||
		([5, 6, 7, 8].includes(gate.eventSequence) && message.eventSequence !== gate.eventSequence) ||
		typeof message.choiceId !== "string" || typeof message.deliveryId !== "string" ||
		!(["player", "trustee"].includes(message.resolution?.kind)) || typeof message.resolution?.option !== "string") {
		throw new Error("NATIVE_ACTION_DELIVERY_REJECTED");
	}
	const prior = gate.actionDeliveries?.get(gate.seatId);
	if (prior) {
		if (prior.choiceId !== message.choiceId || prior.deliveryId !== message.deliveryId ||
			prior.eventSequence !== message.eventSequence || prior.resolutionKind !== message.resolution.kind || prior.option !== message.resolution.option) {
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
			// Do not hold the serialized IPC command chain while authority acceptance
			// itself waits for a later native fence/capture command on that chain.
			// The original immutable delivery owns the commit and ACK; a retry during
			// that interval is inert and will be retried by the controller if needed.
			return;
		}
		if (prior.status !== "authority_committed" && prior.status !== "applied") throw new Error("NATIVE_ACTION_DELIVERY_UNCERTAIN");
		const proofResponse = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,a=s?.nativeAction,o=window.__v2ManagedNativeActionOptions?.get(${JSON.stringify(prior.option)}),p=o?.event?.player;const skill=a?.actionKind==='native_skill',t=skill?[...(s?.nativeSkillTargetGates?.values()||[])].find(g=>g.actionEventId===a.eventId):null;return {eventId:a?.eventId||null,seatId:a?.seatId||null,optionId:a?.optionId||null,actionKind:a?.actionKind||null,skillId:a?.skillId||null,useResultCount:a?.useResultCount||0,childWaitCompleted:a?.nativeChildWaitCompleted===true,eventInstanceMatches:a?.nativeEventInstanceMatches===true,nativeEventStepAfterWait:a?.nativeEventStepAfterWait??null,cardInHand:Boolean(o&&p?.getCards('h').includes(o.card)),useSkillChildCompleted:a?.nativeUseSkillChildCompleted===true,targetChoiceCompleted:a?.nativeTargetChoiceCompleted===true,targetChoiceApplied:t?.status==='applied'&&t?.delivery?.status==='applied',changeZhanJiCompleted:a?.nativeChangeZhanJiCompleted===true,baoShiBefore:a?.nativeChangeZhanJiBefore??null,baoShiAfter:a?.nativeChangeZhanJiAfter??null,completionReported:s?.nativeActionCompletionReported===true,hostPlayerAbsent:window.__v2ManagedEngine?.core?.game?.me===null}})()`, returnByValue: true }, 1500);
		const proof = proofResponse.result?.value;
		const skillProofValid = proof?.actionKind === "native_skill" && proof.skillId === "jiRi_moBaoChongJie" &&
			proof.useSkillChildCompleted && proof.targetChoiceCompleted && proof.targetChoiceApplied && proof.changeZhanJiCompleted &&
			Number.isSafeInteger(proof.baoShiBefore) && proof.baoShiAfter === proof.baoShiBefore + 1 && proof.completionReported;
		const cardProofValid = proof?.actionKind !== "native_skill" && proof?.nativeEventStepAfterWait >= 5 && !proof?.cardInHand;
		if (proofResponse.exceptionDetails || proof?.eventId !== gate.nativeEventId || proof?.seatId !== gate.seatId ||
			proof?.optionId !== prior.option || proof?.useResultCount !== 1 || !proof?.childWaitCompleted ||
			!proof?.eventInstanceMatches || (!skillProofValid && !cardProofValid) || !proof?.hostPlayerAbsent) {
			throw new Error("NATIVE_ACTION_DUPLICATE_PROOF_REJECTED");
		}
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_action_delivery_proof", stage: "native_action_duplicate_delivery_verified", snapshot: proof } });
		process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: prior.choiceId, deliveryId: prior.deliveryId,
			nativeEventId: gate.nativeEventId, nativeApplied: true,
			...(gate.eventSequence >= 5 ? { authorityEventSequence: gate.eventSequence } : {}) });
		return;
	}
	if (gate.status !== "waiting" || !gate.optionIds.includes(message.resolution.option)) throw new Error("NATIVE_ACTION_OPTION_REJECTED");
	// Reserve before touching the engine. An ambiguous CDP outcome is never replayed.
	const record = { choiceId: message.choiceId, deliveryId: message.deliveryId, eventSequence: message.eventSequence,
		resolutionKind: message.resolution.kind,
		option: message.resolution.option, status: "applying" };
	if ([5, 6, 7, 8].includes(gate.eventSequence)) {
		record.authorityCommitPromise = new Promise((resolve, reject) => {
			record.resolveAuthorityCommit = resolve;
			record.rejectAuthorityCommit = reject;
		});
		record.authorityCommitPromise.catch(() => {});
	}
	gate.actionDeliveries.set(gate.seatId, record);
	// Publish the supervised in-flight state before CDP resumes the native event.
	// Chromium may synchronously reach a nested native choice before Runtime.evaluate
	// resolves back to this process.
	gate.status = "applying";
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
	 const {target}=m;let nativeResult;
	 if(m.kind==='native_skill'){
	  const skill=lib.skill[m.skillId];if(m.skillId!=='jiRi_moBaoChongJie'||!skill||!p.hasSkill(m.skillId)||
	   !game.expandSkills(p.getSkills(false).concat(lib.skill.global)).includes(m.skillId)||
	   lib.filter.filterEnable(e,p,m.skillId)!==true||typeof skill.filter!=='function'||skill.filter.call(skill,e,p)!==true)
	   return {ok:false,code:'NATIVE_SKILL_REVALIDATION_REJECTED'};
	  if(!p.getCards(e.position||'hs').includes(m.material)||typeof e.backup!=='function'||typeof e.restore!=='function')
	   return {ok:false,code:'NATIVE_SKILL_MATERIAL_REVALIDATION_REJECTED'};
	  e.backup(m.skillId);
	  let legalMaterial=false,legalTarget=false,targetHasSpell=false;
	  try{
	   legalMaterial=e.filterCard?.(m.material,p,e)===true&&skill.filterCard.call(skill,m.material,p,e)===true;
	   legalTarget=e.filterTarget?.(m.material,p,target)===true;
	   targetHasSpell=${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === '1')}?target?.getCards('h').some(card=>get.type(card,target)==='faShu')===true:true;
	  }finally{e.restore()}
	  if(!legalMaterial||!legalTarget||!targetHasSpell)return {ok:false,code:'NATIVE_SKILL_OPTION_REVALIDATION_REJECTED'};
	  nativeResult={bool:true,skill:m.skillId,cards:[m.material],targets:[target]};
	 }else{
	  const card=m.card;if(!p.getCards(e.position||'h').includes(card)||!e.filterCard?.(card,p,e)||!e.filterTarget?.(card,p,target)||!lib.filter.targetEnabled(card,p,target))return {ok:false,code:'NATIVE_ACTION_REVALIDATION_REJECTED'};
	  nativeResult={bool:true,card:get.autoViewAs(card),cards:[card],targets:[target]};
	 }
	 if(s.nativeAction?.eventId===id)return {ok:false,code:'NATIVE_ACTION_ALREADY_APPLYING'};
	 g.status='applying';s.nativeInputGate.status='applying';s.nativeAction={eventId:id,seatId:seat,optionId:option,actionKind:m.kind==='native_skill'?'native_skill':'physical_card',skillId:m.kind==='native_skill'?m.skillId:null,cardName:m.kind==='native_skill'?null:m.card?.name||null,targetSeatId:target.playerid,useResultCount:0,status:'applying'};
	 if(fault==='before_native_result_set')throw Error('NATIVE_RESULT_SET_INJECTED_FAILURE');
	 e.result=nativeResult;game.resume();return {ok:true};})()`;
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

async function commitNativeJiRiSkillAuthority(gate, record) {
	const base = interactiveChoice?.openingAuthoritySummary;
	if (!base || base.revision !== 3 || !Array.isArray(base.seats) || !/^[a-f0-9]{64}$/.test(interactiveChoice.openingAuthorityDigest || "")) {
		throw new Error("NATIVE_SKILL_AUTHORITY_PREDECESSOR_MISSING");
	}
	const query = await cdp.send("Runtime.evaluate", { expression: `(()=>{let diagnosticStage='lookup',diagnosticExceptionName=null;try{
	 const s=window.__v2NativeStartDiagnosticState,a=s?.nativeAction,core=window.__v2ManagedEngine?.core,game=core?.game,
	  manager=core?._status?.eventManager,ledger=s?.nativeEventCompletionLedger,m=window.__v2ManagedNativeActionOptions?.get(${JSON.stringify(record.option)}),
	  target=[...(s?.nativeSkillTargetGates?.values()||[])].find(item=>item.actionEventId===a?.eventId),
	  targetOption=target?.delivery?.optionId?window.__v2ManagedJiRiTargetOptions?.get(target.delivery.optionId):null,
	  useSkill=s?.nativeUseSkillChildEvent,actionEvent=s?.inputEvent,actor=m?.event?.player,discardEvent=target?.event,
	  zhanJi=s?.nativeChangeZhanJiEvent,
	  actionProof=ledger?.completionEvidence.get(actionEvent),useSkillProof=ledger?.completionEvidence.get(useSkill),
	  zhanJiProof=zhanJi?ledger?.completionEvidence.get(zhanJi):null,discardProof=discardEvent?ledger?.completionEvidence.get(discardEvent):null,
	  parentFence=s?.nativeParentContinuationFence;
	 const targetCard=targetOption?.card,achievementList=actor?.side===true?game?.hongZhanJi:game?.lanZhanJi,
	  achievementBeforeList=s?.jiRiZhanJiBaseline?.orderedList,
	  afterCount=Array.isArray(achievementList)?achievementList.filter(value=>value==='baoShi').length:null;
	 const state=window.__v2ManagedUnifiedRoot;
	 const lineage=(event,ancestor)=>{const result=[],seen=new Set();let current=event?.parent;while(current&&current!==ancestor&&result.length<24&&!seen.has(current)){
	  seen.add(current);result.push({eventName:typeof current.name==='string'?current.name:null,eventInstanceId:ledger?.eventIds.get(current)||null,
	   parentEventInstanceId:current.parent&&ledger?.eventIds.get(current.parent)||null});current=current.parent}
	  if(current!==ancestor||!ancestor)return null;return result};
	 diagnosticStage='completion_evidence';const completionDiagnostics=()=>{const describe=(event,proof)=>event?{eventName:typeof event.name==='string'?event.name:null,
	  eventInstanceId:ledger?.eventIds.get(event)||null,parentEventName:typeof event.parent?.name==='string'?event.parent.name:null,
	  parentEventInstanceId:event.parent&&ledger?.eventIds.get(event.parent)||null,finished:event.finished===true,
	  managerMatches:event.manager===manager,parentContainsEvent:Array.isArray(event.parent?.childEvents)&&event.parent.childEvents.includes(event),
	  parentIsStackTop:manager?.eventStack.at(-1)===event.parent,parentNextIsEvent:Array.isArray(event.parent?.next)&&event.parent.next[0]===event,
	  proofPresent:Boolean(proof),proofEventName:proof?.eventName||null,proofRootMatches:proof?.rootInstanceId===state?.rootInstanceId,
	  proofEventInstanceMatches:proof?.eventInstanceId===(ledger?.eventIds.get(event)||null),
	  proofParentMatches:proof?.parentEventInstanceId===(event.parent&&ledger?.eventIds.get(event.parent)||null),
	  proofOrdinal:Number.isSafeInteger(proof?.completionOrdinal)?proof.completionOrdinal:null}:null;
	   return {useSkill:describe(useSkill,useSkillProof),zhanJi:describe(zhanJi,zhanJiProof),targetDiscard:describe(discardEvent,discardProof),
	    zhanJiLineage:lineage(zhanJi,useSkill),targetDiscardLineage:lineage(discardEvent,useSkill),
	    parentFence:parentFence?{status:parentFence.status||null,releaseCount:parentFence.releaseCount??null,nativeEventId:parentFence.nativeEventId||null,
	     actionEventMatches:parentFence.actionEvent===actionEvent,parentEventName:parentFence.parentEventName||null,rootMatches:parentFence.rootEvent===state?.root,
	     completedChildName:parentFence.completedChildName||null,completedChildFinished:parentFence.completedChildFinished===true,
	     completedChildParentMatches:parentFence.completedChildParentMatches===true,parentNextCount:parentFence.parentNextCount??null,
	     managerStackTopMatches:manager?.eventStack.at(-1)===parentFence.parentEvent}:null,
	   eventStack:(manager?.eventStack||[]).slice(-8).map(event=>({eventName:typeof event?.name==='string'?event.name:null,
	    eventInstanceId:ledger?.eventIds.get(event)||null,parentEventName:typeof event?.parent?.name==='string'?event.parent.name:null,
	    finished:event?.finished===true,step:Number.isSafeInteger(event?.step)?event.step:null})),
	   nativeCompletionOrdinal:Number.isSafeInteger(ledger?.completionOrdinal)?ledger.completionOrdinal:null,
	   recentCompletionEvents:(ledger?.recent||[]).slice(-12).map(entry=>({eventName:entry.eventName,eventInstanceId:entry.eventInstanceId,
	    parentEventName:entry.parentEventName,parentEventInstanceId:entry.parentEventInstanceId,completionOrdinal:entry.completionOrdinal}))};};
	 diagnosticStage='native_invariants';const checks={actionBinding:Boolean(a&&a.eventId===${JSON.stringify(gate.nativeEventId)}&&a.seatId===${JSON.stringify(gate.seatId)}&&a.optionId===${JSON.stringify(record.option)}),
	  actionCompleted:Boolean(a?.actionKind==='native_skill'&&a.skillId==='jiRi_moBaoChongJie'&&a.useResultCount===1&&a.nativeChildWaitCompleted===true&&
	   a.nativeEventInstanceMatches===true&&a.nativeUseSkillChildCompleted===true&&a.nativeTargetChoiceCompleted===true&&a.nativeChangeZhanJiCompleted===true&&
	   a.nativeChangeZhanJiAfter===a.nativeChangeZhanJiBefore+1),
	  skillEventBinding:Boolean(m&&m.kind==='native_skill'&&m.skillId==='jiRi_moBaoChongJie'&&useSkill&&useSkill.finished===true&&useSkill.name==='useSkill'&&
	   useSkill.skill==='jiRi_moBaoChongJie'&&useSkill.player===actor),
	  zhanJiChild:Boolean(zhanJi&&zhanJiProof?.eventName==='changeZhanJi'&&zhanJiProof.rootInstanceId===state?.rootInstanceId&&
	   zhanJiProof.eventInstanceId===ledger?.eventIds.get(zhanJi)&&zhanJiProof.parentEventInstanceId===ledger?.eventIds.get(zhanJi.parent)&&
	   zhanJi.parent?.manager===manager&&lineage(zhanJi,useSkill)!==null),
	  targetDiscard:Boolean(target&&target.status==='applied'&&target.delivery?.status==='applied'&&discardEvent&&discardEvent.finished===true&&
	   discardProof?.eventName==='chooseToDiscard'&&discardProof.rootInstanceId===state?.rootInstanceId&&
	   discardProof.eventInstanceId===ledger?.eventIds.get(discardEvent)&&discardProof.parentEventInstanceId===ledger?.eventIds.get(discardEvent.parent)&&
	   discardEvent.parent?.manager===manager&&lineage(discardEvent,useSkill)!==null&&targetCard&&discardEvent.result?.bool===true&&
	   discardEvent.result.cards?.length===1&&discardEvent.result.cards[0]===targetCard&&!discardEvent.player.getCards('h').includes(targetCard)&&core.get.position(targetCard)==='d'),
	  materialConsumed:Boolean(m?.material&&!actor?.getCards('h').includes(m.material)),
	  actionEventProof:Boolean(actionProof&&actionProof.eventName==='gongJiOrFaShu'&&actionProof.rootInstanceId===state?.rootInstanceId&&
	   actionProof.parentEventInstanceId===ledger?.eventIds.get(actionEvent.parent)),
	  achievementList:Boolean(Array.isArray(achievementBeforeList)&&Array.isArray(achievementList)&&achievementBeforeList.length<128&&achievementList.length<=128&&
	   achievementBeforeList.every(value=>value==='baoShi'||value==='shuiJing')&&achievementList.every(value=>value==='baoShi'||value==='shuiJing')&&
	   JSON.stringify(achievementList)===JSON.stringify([...achievementBeforeList,'baoShi'])&&Number.isSafeInteger(afterCount)&&afterCount===a?.nativeChangeZhanJiAfter),
	  serverRoot:Boolean(game?.me===null&&!game?.players?.some(p=>p.ws)&&manager?.rootEvent===state?.root),
	  actionParentFenceWaiting:Boolean(actionEvent?.finished===true&&actionEvent.parent?.name==='xingDong'&&actionEvent.parent?.player?.playerid===${JSON.stringify(gate.seatId)}&&
	   parentFence?.status==='waiting'&&parentFence.releaseCount===0&&parentFence.nativeEventId===${JSON.stringify(gate.nativeEventId)}&&parentFence.actionEvent===actionEvent&&
	   parentFence.parentEvent===actionEvent.parent&&parentFence.rootEvent===state?.root&&parentFence.rootInstanceId===state?.rootInstanceId&&
	   parentFence.completedChildName==='gongJiOrFaShu'&&parentFence.completedChildFinished===true&&parentFence.completedChildParentMatches===true&&
	   parentFence.parentNextCount===0&&manager?.eventStack.at(-1)===actionEvent.parent&&manager?.rootEvent===state?.root)};
	 if(!a||a.eventId!==${JSON.stringify(gate.nativeEventId)}||a.seatId!==${JSON.stringify(gate.seatId)}||a.optionId!==${JSON.stringify(record.option)}||
	  a.actionKind!=='native_skill'||a.skillId!=='jiRi_moBaoChongJie'||a.useResultCount!==1||a.nativeChildWaitCompleted!==true||
	  a.nativeEventInstanceMatches!==true||a.nativeUseSkillChildCompleted!==true||a.nativeTargetChoiceCompleted!==true||
	  a.nativeChangeZhanJiCompleted!==true||a.nativeChangeZhanJiAfter!==a.nativeChangeZhanJiBefore+1||
	  !m||m.kind!=='native_skill'||m.skillId!=='jiRi_moBaoChongJie'||!useSkill||useSkill.finished!==true||useSkill.name!=='useSkill'||
	  useSkill.skill!=='jiRi_moBaoChongJie'||useSkill.player!==actor||!zhanJi||zhanJiProof?.eventName!=='changeZhanJi'||
	  zhanJiProof.rootInstanceId!==state?.rootInstanceId||zhanJiProof.eventInstanceId!==ledger?.eventIds.get(zhanJi)||
	  zhanJiProof.parentEventInstanceId!==ledger?.eventIds.get(zhanJi.parent)||lineage(zhanJi,useSkill)===null||
	  !target||target.status!=='applied'||target.delivery?.status!=='applied'||!discardEvent||discardEvent.finished!==true||
	  discardProof?.eventName!=='chooseToDiscard'||discardProof.rootInstanceId!==state?.rootInstanceId||
	  discardProof.eventInstanceId!==ledger?.eventIds.get(discardEvent)||discardProof.parentEventInstanceId!==ledger?.eventIds.get(discardEvent.parent)||
	  discardEvent.parent?.manager!==manager||lineage(discardEvent,useSkill)===null||!targetCard||discardEvent.result?.bool!==true||
	  discardEvent.result.cards?.length!==1||discardEvent.result.cards[0]!==targetCard||discardEvent.player.getCards('h').includes(targetCard)||
	  core.get.position(targetCard)!=='d'||!m.material||actor.getCards('h').includes(m.material)||
	  !actionProof||actionProof.eventName!=='gongJiOrFaShu'||actionProof.rootInstanceId!==state?.rootInstanceId||
	  actionProof.parentEventInstanceId!==ledger?.eventIds.get(actionEvent.parent)||
	  !Array.isArray(achievementBeforeList)||!Array.isArray(achievementList)||achievementBeforeList.length>=128||achievementList.length>128||
	  achievementBeforeList.some(value=>value!=='baoShi'&&value!=='shuiJing')||achievementList.some(value=>value!=='baoShi'&&value!=='shuiJing')||
	  JSON.stringify(achievementList)!==JSON.stringify([...achievementBeforeList,'baoShi'])||!Number.isSafeInteger(afterCount)||
	  afterCount!==a.nativeChangeZhanJiAfter||game?.me!==null||game?.players?.some(p=>p.ws)||manager?.rootEvent!==state?.root||
	  actionEvent?.finished!==true||actionEvent.parent?.name!=='xingDong'||actionEvent.parent?.player?.playerid!==${JSON.stringify(gate.seatId)}||
	  parentFence?.status!=='waiting'||parentFence.releaseCount!==0||parentFence.nativeEventId!==${JSON.stringify(gate.nativeEventId)}||parentFence.actionEvent!==actionEvent||
	  parentFence.parentEvent!==actionEvent.parent||parentFence.rootEvent!==state?.root||parentFence.rootInstanceId!==state?.rootInstanceId||
	  parentFence.completedChildName!=='gongJiOrFaShu'||parentFence.completedChildFinished!==true||parentFence.completedChildParentMatches!==true||
	  parentFence.parentNextCount!==0||manager.eventStack.at(-1)!==actionEvent.parent||manager.rootEvent!==state?.root)
	  return {ok:false,code:'JIRIMO_NATIVE_ACTION_COMPLETION_EVIDENCE_INVALID',failedChecks:Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name),
	   proofDiagnostics:completionDiagnostics()};
	 diagnosticStage='private_summary';const hands=game.players.map(p=>({seatId:p.playerid,handCount:p.countCards('h'),hand:p.getCards('h').map(card=>({name:card.name||null,suit:card.suit||null,number:card.number||null,nature:card.nature||null}))}));
	 return {ok:true,nativeEventId:a.eventId,rootInstanceId:state.rootInstanceId,seatId:a.seatId,targetSeatId:target.seatId,optionId:a.optionId,
	  nativeEventStep:a.nativeEventStepAfterWait,nativeEventInstanceMatches:a.nativeEventInstanceMatches===true,nativeChildWaitCompleted:a.nativeChildWaitCompleted===true,
	  useResultCount:a.useResultCount,gameMeNull:game.me===null,connectedTransports:game.players.filter(p=>p.ws).length,
	  firstActSeatId:core._status.firstAct?.playerid||null,actionEventInstanceId:ledger.eventIds.get(actionEvent)||null,
	  actionParentEventInstanceId:actionProof?.parentEventInstanceId||null,
	  useSkillChildEventId:ledger.eventIds.get(useSkill)||null,useSkillParentEventId:useSkillProof?.parentEventInstanceId||null,
	  changeZhanJiEventId:ledger.eventIds.get(zhanJi)||null,changeZhanJiParentEventId:zhanJiProof?.parentEventInstanceId||null,
	  changeZhanJiLineage:lineage(zhanJi,useSkill),targetDiscardEventId:ledger.eventIds.get(discardEvent)||null,targetDiscardParentEventId:discardProof?.parentEventInstanceId||null,
	  targetDiscardLineage:lineage(discardEvent,useSkill),parentFenceStatus:parentFence.status,parentFenceReleaseCount:parentFence.releaseCount,
	  parentFenceEventInstanceId:ledger.eventIds.get(parentFence.actionEvent)||null,parentFenceParentEventInstanceId:ledger.eventIds.get(parentFence.parentEvent),
	  parentFenceParentEventName:parentFence.parentEventName,parentFenceParentNextCount:parentFence.parentNextCount,
	  targetChoiceNativeEventId:target?.eventId||null,
	  useSkillChildCompletionOrdinal:useSkillProof?.completionOrdinal,changeZhanJiCompletionOrdinal:zhanJiProof?.completionOrdinal,
	  targetDiscardCompletionOrdinal:discardProof?.completionOrdinal,actionCompletionOrdinal:actionProof?.completionOrdinal,
	  nativeCompletionOrdinal:ledger.completionOrdinal,nativeUseSkillChildCompleted:true,changeZhanJiChildCompleted:true,targetDiscardChildCompleted:true,
	  targetDiscardCardMoved:true,baoShiBefore:a.nativeChangeZhanJiBefore,baoShiAfter:afterCount,baoShiSide:actor.side,
	  achievementBeforeList:Array.isArray(achievementBeforeList)?[...achievementBeforeList]:null,
	  achievementAfterList:Array.isArray(achievementList)?[...achievementList]:null,
	  materialConsumed:true,targetDiscardSeatId:target.seatId,hands};}catch(error){diagnosticExceptionName=['TypeError','ReferenceError','RangeError','Error'].includes(error?.name)?error.name:'OtherError';const match=error?.name==='ReferenceError'?/^(?:ReferenceError:\s*)?([A-Za-z_$][A-Za-z0-9_$]{0,63}) is not defined$/.exec(error?.message||''):null,referenceIdentifier=match?.[1]||null;return {ok:false,code:'JIRIMO_NATIVE_ACTION_DIAGNOSTIC_EVALUATION_EXCEPTION',diagnosticStage,diagnosticExceptionName,...(referenceIdentifier?{referenceIdentifier}:{})}}})()`, returnByValue: true }, 2000);
	const observed = query.result?.value;
	if (query.exceptionDetails || observed?.ok !== true || observed.nativeEventId !== gate.nativeEventId || observed.seatId !== gate.seatId ||
		observed.optionId !== record.option || observed.nativeEventInstanceMatches !== true || observed.nativeChildWaitCompleted !== true ||
		observed.useResultCount !== 1 || observed.gameMeNull !== true || observed.connectedTransports !== 0 || observed.firstActSeatId !== gate.seatId ||
		observed.baoShiAfter !== observed.baoShiBefore + 1 || observed.targetDiscardSeatId !== observed.targetSeatId ||
		![observed.useSkillChildCompletionOrdinal, observed.changeZhanJiCompletionOrdinal, observed.targetDiscardCompletionOrdinal,
			observed.actionCompletionOrdinal, observed.nativeCompletionOrdinal].every(Number.isSafeInteger)) {
		if (!query.exceptionDetails && observed?.code === "JIRIMO_NATIVE_ACTION_COMPLETION_EVIDENCE_INVALID" &&
			Array.isArray(observed.failedChecks) && observed.failedChecks.length <= 12 &&
			observed.failedChecks.every(value => ["actionBinding", "actionCompleted", "skillEventBinding", "zhanJiChild", "targetDiscard",
	  "materialConsumed", "actionEventProof", "achievementList", "serverRoot", "actionParentFenceWaiting"].includes(value))) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_start_diagnostic", stage: "native_jiri_authority_proof_rejected",
					failureCode: observed.code, failedChecks: [...observed.failedChecks], proofDiagnostics: observed.proofDiagnostics } });
		}
		if (!query.exceptionDetails && observed?.code === "JIRIMO_NATIVE_ACTION_DIAGNOSTIC_EVALUATION_EXCEPTION" &&
			["lookup", "completion_evidence", "native_invariants", "private_summary"].includes(observed.diagnosticStage) &&
			["TypeError", "ReferenceError", "RangeError", "Error", "OtherError"].includes(observed.diagnosticExceptionName)) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_start_diagnostic", stage: "native_jiri_authority_evaluation_exception",
					failureCode: observed.code, diagnosticStage: observed.diagnosticStage, diagnosticExceptionName: observed.diagnosticExceptionName,
					...(observed.referenceIdentifier ? { referenceIdentifier: observed.referenceIdentifier } : {}) } });
			throw new Error(`NATIVE_SKILL_AUTHORITY_DIAGNOSTIC_${observed.diagnosticStage.toUpperCase()}_${observed.diagnosticExceptionName.toUpperCase()}${observed.referenceIdentifier ? `_${observed.referenceIdentifier.toUpperCase()}` : ""}`);
		}
		throw new Error(observed?.code || "NATIVE_SKILL_AUTHORITY_PROOF_REJECTED");
	}
	if (interactiveChoice.nativeRootInstanceId && (observed.rootInstanceId !== interactiveChoice.nativeRootInstanceId || observed.rootInstanceId !== managerRootId())) {
		throw new Error("NATIVE_SKILL_AUTHORITY_ROOT_MISMATCH");
	}
	const seats = observed.hands.map((seat, index) => {
		const previous = base.seats[index];
		if (seat.seatId !== previous.seatId) throw new Error("NATIVE_SKILL_AUTHORITY_SEAT_ORDER_REJECTED");
		return { seatId: seat.seatId, position: previous.position, character: previous.character, side: previous.side,
			handCount: seat.handCount, handCommitment: createHash("sha256").update(canonicalize(seat.hand)).digest("hex") };
	});
	const after = { revision: 4, firstActSeatId: base.firstActSeatId, seats,
		action: { kind: "native_skill", nativeEventId: gate.nativeEventId, nativeEventName: "gongJiOrFaShu", seatId: gate.seatId,
			optionId: record.option, skillId: "jiRi_moBaoChongJie", materialConsumed: true,
			achievement: { kind: "baoShi", countBefore: observed.baoShiBefore, countAfter: observed.baoShiAfter, side: observed.baoShiSide,
				beforeListDigest: createHash("sha256").update(canonicalize(observed.achievementBeforeList)).digest("hex"),
				afterListDigest: createHash("sha256").update(canonicalize(observed.achievementAfterList)).digest("hex") },
			targetDiscard: { eventId: observed.targetDiscardEventId, seatId: observed.targetSeatId, cardMovedToDiscard: true } } };
	const afterDigest = createHash("sha256").update(canonicalize(after)).digest("hex");
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence: 4, stateRevisionBefore: 3, stateRevisionAfter: 4,
		beforeDigest: interactiveChoice.openingAuthorityDigest, afterDigest, beforeSummary: base, afterSummary: after,
		event: { kind: "xingbei_native_skill_action_v1", name: "jiRi_moBaoChongJie", nativeEventName: "gongJiOrFaShu",
			nativeEventId: gate.nativeEventId, nativeEventCompleted: true, rootInstanceId: observed.rootInstanceId,
			seatId: gate.seatId, targetSeatId: observed.targetSeatId, skillId: "jiRi_moBaoChongJie", optionId: record.option,
			actionEventInstanceId: observed.actionEventInstanceId, useSkillParentEventId: observed.useSkillParentEventId,
			actionParentEventInstanceId: observed.actionParentEventInstanceId,
			changeZhanJiParentEventId: observed.changeZhanJiParentEventId, targetDiscardParentEventId: observed.targetDiscardParentEventId,
			changeZhanJiLineage: observed.changeZhanJiLineage, targetDiscardLineage: observed.targetDiscardLineage,
			parentFenceStatus: observed.parentFenceStatus, parentFenceReleaseCount: observed.parentFenceReleaseCount,
			parentFenceEventInstanceId: observed.parentFenceEventInstanceId, parentFenceParentEventInstanceId: observed.parentFenceParentEventInstanceId,
			parentFenceParentEventName: observed.parentFenceParentEventName, parentFenceParentNextCount: observed.parentFenceParentNextCount,
			targetChoiceNativeEventId: observed.targetChoiceNativeEventId,
			achievementBeforeList: observed.achievementBeforeList, achievementAfterList: observed.achievementAfterList,
			nativeEventStep: observed.nativeEventStep, useResultCount: observed.useResultCount,
			nativeEventInstanceMatches: observed.nativeEventInstanceMatches, nativeChildWaitCompleted: observed.nativeChildWaitCompleted,
			nativeUseSkillChildCompleted: observed.nativeUseSkillChildCompleted, useSkillChildEventId: observed.useSkillChildEventId,
			useSkillChildCompletionOrdinal: observed.useSkillChildCompletionOrdinal,
			changeZhanJiChildCompleted: observed.changeZhanJiChildCompleted, changeZhanJiEventId: observed.changeZhanJiEventId,
			changeZhanJiCompletionOrdinal: observed.changeZhanJiCompletionOrdinal, baoShiBefore: observed.baoShiBefore, baoShiAfter: observed.baoShiAfter,
			targetDiscardChildCompleted: observed.targetDiscardChildCompleted, targetDiscardEventId: observed.targetDiscardEventId,
			targetDiscardCompletionOrdinal: observed.targetDiscardCompletionOrdinal, targetDiscardCardMoved: observed.targetDiscardCardMoved,
			actionCompletionOrdinal: observed.actionCompletionOrdinal, nativeCompletionOrdinal: observed.nativeCompletionOrdinal,
			gameMeNull: observed.gameMeNull, connectedTransports: observed.connectedTransports } };
	const ackPromise = waitForAuthorityEventAck(4, 4, afterDigest, 8000);
	let accepted = null;
	for (let attempt = 0; attempt < 3 && accepted === null; attempt++) {
		await new Promise((resolve, reject) => {
			if (!process.send) return reject(new Error("NATIVE_SKILL_AUTHORITY_SEND_FAILED"));
			process.send({ ...identity, type: "host_authority_event", proof }, error => error ? reject(error) : resolve());
		});
		if (attempt < 2) accepted = await Promise.race([ackPromise, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
	}
	if (accepted === null) accepted = await ackPromise;
	if (accepted !== true) throw new Error("NATIVE_SKILL_AUTHORITY_REJECTED");
	const finalized = await cdp.send("Runtime.evaluate", { expression: `(()=>{const c=window.__v2ManagedGame,s=window.__v2ManagedOpeningDraw;if(c?.authorityState?.revision!==3||s?.authorityDigest!==${JSON.stringify(proof.beforeDigest)})return {ok:false};c.authorityState.revision=4;s.authoritySummary=${JSON.stringify(after)};s.authorityDigest=${JSON.stringify(afterDigest)};return {ok:true,revision:c.authorityState.revision}})()`, returnByValue: true }, 1500);
	if (finalized.exceptionDetails || finalized.result?.value?.ok !== true || finalized.result.value.revision !== 4) throw new Error("NATIVE_SKILL_AUTHORITY_FINALIZE_FAILED");
	if (process.env.V2_NATIVE_PARENT_FENCE === "1") {
		const released = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,f=s?.nativeParentContinuationFence,c=window.__v2ManagedGame,a=s?.inputEvent,manager=window.__v2ManagedEngine?.core?._status?.eventManager, nativeEventId=${JSON.stringify(gate.nativeEventId)}, afterDigest=${JSON.stringify(afterDigest)};if(!f||f.status!=='waiting'||f.releaseCount!==0||f.nativeEventId!==nativeEventId||f.actionEvent!==a||f.parentEvent!==a?.parent||f.rootEvent!==s?.root||manager?.rootEvent!==s?.root||c?.authorityState?.revision!==4||window.__v2ManagedOpeningDraw?.authorityDigest!==afterDigest||f.completedChildFinished!==true||f.completedChildParentMatches!==true||f.parentNextCount!==0||!f.resolve||f.completedChildName!=='gongJiOrFaShu')return {ok:false,code:'NATIVE_PARENT_FENCE_BINDING_REJECTED'};f.status='accepted';f.releaseCount=1;f.acceptedAuthority=Object.freeze({nativeEventId,eventSequence:4,stateRevision:4,afterDigest});f.resolve({accepted:true,nativeEventId,eventSequence:4,stateRevision:4,afterDigest});return {ok:true,status:f.status,releaseCount:f.releaseCount,eventSequence:4,stateRevision:4,afterDigest};})()`, returnByValue: true }, 1500);
		const result = released.result?.value;
		if (released.exceptionDetails || result?.ok !== true || result.releaseCount !== 1 || result.afterDigest !== afterDigest) throw new Error("NATIVE_PARENT_FENCE_RELEASE_UNCERTAIN");
	}
	if (process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
		const resumed = await cdp.send("Runtime.evaluate", { expression: `(()=>{const game=window.__v2ManagedEngine?.core?.game,s=window.__v2NativeStartDiagnosticState;
			const fence=s?.nativeParentContinuationFence,revision=window.__v2ManagedGame?.authorityState?.revision;
			if(!game||!fence||fence.releaseCount!==1||revision!==4)return {ok:false,gamePresent:Boolean(game),fenceStatus:fence?.status||null,
				releaseCount:Number.isSafeInteger(fence?.releaseCount)?fence.releaseCount:null,revision:Number.isSafeInteger(revision)?revision:null,
				paused:Boolean(window.__v2ManagedEngine?.core?._status?.paused)};
			if(fence.status==='accepted')game.resume();
			return {ok:true,paused:Boolean(window.__v2ManagedEngine?.core?._status?.paused),fenceStatus:fence.status,
				releaseCount:fence.releaseCount,revision};})()`, returnByValue: true }, 1500);
		if (resumed.exceptionDetails || resumed.result?.value?.ok !== true || resumed.result.value.paused !== false) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "native_start_diagnostic", stage: "native_jiri_authority_resume_rejected",
					failureCode: "NATIVE_JIRIMO_AUTHORITY_RESUME_UNCERTAIN", ...(resumed.result?.value || {}) } });
			throw new Error("NATIVE_JIRIMO_AUTHORITY_RESUME_UNCERTAIN");
		}
	}
	record.status = "authority_committed";
	gate.status = "authority_committed";
	process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
		observed: { kind: "native_authority_event_accepted_v1", stage: "native_skill_action_event_4_accepted", eventSequence: 4,
			stateRevision: 4, beforeDigest: proof.beforeDigest, afterDigest, nativeEventName: "jiRi_moBaoChongJie", seatId: gate.seatId,
			useSkillChildCompleted: true, changeZhanJiChildCompleted: true, targetDiscardChildCompleted: true,
			targetSeatId: observed.targetSeatId, nativeCompletionOrdinal: observed.nativeCompletionOrdinal,
			baoShiDelta: 1, achievement: { side: observed.baoShiSide, countBefore: observed.baoShiBefore, countAfter: observed.baoShiAfter,
				beforeListDigest: proof.event.achievementBeforeList ? createHash("sha256").update(canonicalize(proof.event.achievementBeforeList)).digest("hex") : null,
				afterListDigest: proof.event.achievementAfterList ? createHash("sha256").update(canonicalize(proof.event.achievementAfterList)).digest("hex") : null },
			hostPlayerAbsent: true, connectedTransports: 0, checkpointAvailable: false } });
	process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: record.choiceId,
		deliveryId: record.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true, authorityEventSequence: 4 });
}

function managerRootId() { return interactiveChoice?.nativeRootInstanceId || null; }

async function commitNativeCardActionAuthority(gate, record) {
	if (record.authorityCommitPromise) return record.authorityCommitPromise;
	record.authorityCommitPromise = (async () => {
		if (interactiveChoice?.nativeInputGate?.actionDeliveries?.get(gate.seatId)?.actionKind === "native_skill" ||
			process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
			await commitNativeJiRiSkillAuthority(gate, record);
			return;
		}
		const event5Probe = experimentalAuthorityEventEnabled(5);
		if (!process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4") &&
			!(event5Probe && gate.eventSequence === 4)) {
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
					result.useCardChildrenCompleted === 1 && (responseGate.optionShapes[result.optionId] === "native_single_target_card" ?
						typeof result.targetSeatId === "string" && result.targetCount === 1 :
						responseGate.optionShapes[result.optionId] === "native_notarget_card" && result.targetSeatId === null && result.targetCount === 0) :
					result.kind === "view_as_skill" ? result.forced === false && responseGate.optionShapes[result.optionId] === "native_single_target_view_as_skill" &&
						result.skillId === "yinYangZhanHuan" && result.physicalMaterialConsumed === true && result.xiBieApplied === true &&
						["an", "di", "feng", "guang", "huo", "lei", "shui"].includes(result.resolvedXiBie) &&
						Number.isSafeInteger(result.guiHuoDelta) && result.guiHuoDelta >= 1 && result.guiHuoDelta <= 3 &&
						result.useCardChildrenStarted === 1 && result.useCardChildrenCompleted === 1 &&
						typeof result.targetSeatId === "string" && result.targetCount === 1 :
					result.kind === "decline" && result.forced === false && result.useCardChildrenStarted === 0 &&
					result.useCardChildrenCompleted === 0 && result.targetSeatId === null && result.targetCount === 0)) {
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
				targetCount: result.targetCount, optionShape: responseGate.optionShapes[result.optionId],
				useCardChildrenStarted: result.useCardChildrenStarted, useCardChildrenCompleted: result.useCardChildrenCompleted,
				...(result.kind === "view_as_skill" ? { skillId: result.skillId, physicalMaterialConsumed: result.physicalMaterialConsumed,
					xiBieApplied: result.xiBieApplied, resolvedXiBie: result.resolvedXiBie, guiHuoDelta: result.guiHuoDelta } : {}),
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
		interactiveChoice.openingAuthoritySummary = after;
		interactiveChoice.openingAuthorityDigest = afterDigest;
		interactiveChoice.authorityEvent4Accepted = true;
		if (process.env.V2_NATIVE_PARENT_FENCE === "1") {
			const released = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,f=s?.nativeParentContinuationFence,
				c=window.__v2ManagedGame,a=s?.inputEvent,manager=window.__v2ManagedEngine?.core?._status?.eventManager;
				const nativeEventId=${JSON.stringify(gate.nativeEventId)},afterDigest=${JSON.stringify(afterDigest)};
				if(!f||f.status!=='waiting'||f.releaseCount!==0||f.nativeEventId!==nativeEventId||f.actionEvent!==a||f.parentEvent!==a?.parent||
					f.rootEvent!==s?.root||manager?.rootEvent!==s?.root||c?.authorityState?.revision!==4||window.__v2ManagedOpeningDraw?.authorityDigest!==afterDigest||
					f.completedChildFinished!==true||f.completedChildParentMatches!==true||f.parentNextCount!==0||!f.resolve)return {ok:false,code:'NATIVE_PARENT_FENCE_BINDING_REJECTED'};
				f.status='accepted';f.releaseCount=1;f.acceptedAuthority=Object.freeze({nativeEventId,eventSequence:4,stateRevision:4,afterDigest});
				f.resolve({accepted:true,nativeEventId,eventSequence:4,stateRevision:4,afterDigest});
				return {ok:true,status:f.status,releaseCount:f.releaseCount,eventSequence:f.acceptedAuthority.eventSequence,stateRevision:f.acceptedAuthority.stateRevision,afterDigest:f.acceptedAuthority.afterDigest};})()`, returnByValue: true }, 1500);
			const observedRelease = released.result?.value;
			if (released.exceptionDetails || observedRelease?.ok !== true || observedRelease.status !== "accepted" || observedRelease.releaseCount !== 1 ||
				observedRelease.eventSequence !== 4 || observedRelease.stateRevision !== 4 || observedRelease.afterDigest !== afterDigest) {
				throw new Error("NATIVE_PARENT_FENCE_RELEASE_UNCERTAIN");
			}
		}
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

async function commitNativeSuccessorActionAuthority(command, eventSequence = 5) {
	const eventRevision = eventSequence;
	const predecessorRevision = eventSequence - 1;
	const isEvent6 = eventSequence === 6;
	const isEvent7 = eventSequence === 7;
	const isEvent8 = eventSequence === 8;
	const gate = interactiveChoice?.nativeInputGate;
	const record = gate?.actionDeliveries?.get(gate.seatId);
	const commandFailure = !experimentalAuthorityEventEnabled(eventSequence) ? "MODE_OR_OPT_IN" :
		!validHostCommand(command) || command.type !== (isEvent8 ? "host_native_event8_post_capture_ready" : isEvent7 ? "host_native_event7_post_capture_ready" : isEvent6 ? "host_native_event6_post_capture_ready" : "host_native_event5_post_capture_ready") ? "IDENTITY" :
		Object.keys(command).sort().join(",") !== "afterDigestBefore,captureOrdinal,commitment,connectionGeneration,eventSequence,kind,nativeCompletionOrdinal,nativeEventId,phaseOverEventInstanceId,phaseOverTriggerOrdinal,protocol,roomId,rootInstanceId,seatId,secret,sessionId,stateRevision,type" ? "SCHEMA" :
		command.eventSequence !== eventSequence || command.stateRevision !== predecessorRevision || gate?.eventSequence !== eventSequence ? "SEQUENCE" :
		gate.status !== "native_applied_authority_pending" ? "GATE_STATE" :
		!record || record.status !== "native_applied_authority_pending" ? "DELIVERY_STATE" :
		gate.nativeEventId !== command.nativeEventId || gate.seatId !== command.seatId ? "GATE_BINDING" :
		gate.eventInstanceId == null || gate.parentEventInstanceId == null ||
		(isEvent8 ? !interactiveChoice?.event7AuthorityAccepted : isEvent7 ? !interactiveChoice?.event6AuthorityAccepted : isEvent6 ? !interactiveChoice?.event5AuthorityAccepted : !interactiveChoice?.authorityEvent4Accepted) ? "PREDECESSOR" :
		interactiveChoice.nativeRootInstanceId !== command.rootInstanceId || !/^native_event_[a-f0-9]{32}$/.test(command.nativeEventId || "") ? "ROOT_OR_EVENT" :
		!Number.isSafeInteger(command.captureOrdinal) || command.captureOrdinal < 1 ? "CAPTURE_ORDINAL" :
		!/^[a-f0-9]{64}$/.test(command.commitment || "") ? "COMMITMENT" :
		!Number.isSafeInteger(command.nativeCompletionOrdinal) || command.nativeCompletionOrdinal < 1 ? "COMPLETION_ORDINAL" :
		!Number.isSafeInteger(command.phaseOverTriggerOrdinal) || command.phaseOverTriggerOrdinal < (isEvent8 ? 5 : isEvent7 ? 4 : isEvent6 ? 3 : 2) ? "PHASE_OVER_ORDINAL" :
		!/^[a-f0-9]{64}$/.test(command.afterDigestBefore || "") ? "PREDECESSOR_DIGEST" : null;
	if (commandFailure) throw new Error(`EVENT5_POST_CAPTURE_COMMAND_REJECTED_${commandFailure}`);
	const candidate = isEvent8 ? interactiveChoice.event8SuccessorCandidate : isEvent7 ? interactiveChoice.event7SuccessorCandidate : isEvent6 ? interactiveChoice.event6SuccessorCandidate : interactiveChoice.event5SuccessorCandidate;
	const delivery = record;
	const candidateFailure = !candidate ? "CANDIDATE_MISSING" :
		candidate.nativeEventId !== gate.nativeEventId ? "EVENT_ID" :
		candidate.eventInstanceId !== gate.eventInstanceId ? "EVENT_INSTANCE" :
		candidate.parentEventInstanceId !== gate.parentEventInstanceId ? "PARENT_INSTANCE" :
		candidate.seatId !== gate.seatId ? "SEAT" :
		candidate.waitingCompletionOrdinal !== gate.waitingCompletionOrdinal ? "WAIT_ORDINAL" :
		delivery.eventSequence !== eventSequence ? "DELIVERY_SEQUENCE" :
		delivery.status !== "native_applied_authority_pending" ? "DELIVERY_STATE" :
		delivery.deliveryId == null ? "DELIVERY_ID" : delivery.choiceId == null ? "CHOICE_ID" : null;
	if (candidateFailure) throw new Error(`EVENT5_NATIVE_ACTION_BINDING_REJECTED_${candidateFailure}`);
	const base = interactiveChoice.openingAuthoritySummary;
	const beforeDigest = interactiveChoice.openingAuthorityDigest;
	const predecessorSeatIds = isEvent6 || isEvent7 || isEvent8 ? interactiveChoice.authoritySeatIds : base?.seats?.map(seat => seat.seatId);
	const predecessorCheck = { expectedRevision: predecessorRevision, observedRevision: Number.isSafeInteger(base?.revision) ? base.revision : null,
		summaryPresent: Boolean(base), seatsPresent: Array.isArray(predecessorSeatIds) && predecessorSeatIds.length === 4 && new Set(predecessorSeatIds).size === 4,
		localDigestValid: /^[a-f0-9]{64}$/.test(beforeDigest || ""),
		commandDigestMatchesLocal: command.afterDigestBefore === beforeDigest };
	if (!base || base.revision !== predecessorRevision || command.afterDigestBefore !== beforeDigest ||
		!predecessorCheck.seatsPresent || !/^[a-f0-9]{64}$/.test(beforeDigest || "")) {
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
			observed: { kind: "native_authority_predecessor_check_v1", stage: `event_${eventSequence}_authority_predecessor_rejected`, ...predecessorCheck } });
		const reason = !base || !predecessorCheck.seatsPresent ? "SUMMARY" : base.revision !== predecessorRevision ? "REVISION" :
			command.afterDigestBefore !== beforeDigest ? "DIGEST_MISMATCH" : "DIGEST_INVALID";
		throw new Error(`EVENT${eventSequence}_AUTHORITY_PREDECESSOR_REJECTED_${reason}`);
	}
	const inspected = await cdp.send("Runtime.evaluate", { expression: `(()=>{
		const s=window.__v2NativeStartDiagnosticState,gate=s?.nativeInputResumeGate,a=s?.nativeAction,
			option=window.__v2ManagedNativeActionOptions?.get(${JSON.stringify(delivery.option)}),managed=window.__v2ManagedEngine?.core,
			game=managed?.game,manager=managed?._status?.eventManager,ledger=s?.nativeEventCompletionLedger,
			event=gate?.event,proof=event&&ledger?.completionEvidence?.get(event),f=s?.nativePhaseBoundaryFence;
		const nativeCardType=option&&event?.player&&typeof managed?.get?.type==='function'?managed.get.type(option.card,event.player):null;
		const checks={sessionState:Boolean(s&&gate&&gate.eventSequence===${eventSequence}&&gate.status==='applying'&&s.nativeActionCompletionReported===true),
			actionIdentity:Boolean(gate?.nativeEventId===${JSON.stringify(command.nativeEventId)}&&gate?.seatId===${JSON.stringify(command.seatId)}),
			nativeEventBinding:Boolean(event&&event===s?.inputEvent&&event.__v2NativeEventId===gate?.nativeEventId),
			nativeEventCompletion:Boolean(event?.finished===true&&proof&&proof.rootInstanceId===s?.rootInstanceId&&
				proof.eventInstanceId===${JSON.stringify(candidate.eventInstanceId)}&&proof.parentEventInstanceId===${JSON.stringify(candidate.parentEventInstanceId)}&&
				Number.isSafeInteger(proof.completionOrdinal)),
			actionResult:Boolean(a?.eventId===gate?.nativeEventId&&a?.seatId===gate?.seatId&&a?.optionId===${JSON.stringify(delivery.option)}&&
				a?.useResultCount===1&&a?.nativeChildWaitCompleted===true&&a?.nativeEventInstanceMatches===true&&a?.nativeUseCardChildCompleted===true),
			optionBinding:Boolean(option&&option.event===event&&option.seatId===gate?.seatId&&managed?.game?.me===null&&!game?.players?.some(p=>p.ws)),
			phaseFence:Boolean(f?.boundaryOrdinal===${isEvent8 ? 5 : isEvent7 ? 4 : isEvent6 ? 3 : 2}&&f.status==='waiting'&&f.releaseCount===0&&f.rootEvent===s?.root&&
				f.phaseLoopEvent===s?.phaseLoop&&manager?.rootEvent===s?.root&&f.seatId===gate?.seatId&&f.nativeEventId===gate?.nativeEventId&&
				f.pendingDescendantCount===0&&f.phaseOverTriggerComplete===true&&
			f.phaseOverCompletionEvidence?.triggerOrdinal===${command.phaseOverTriggerOrdinal}&&
				f.phaseOverCompletionEvidence?.ownerEventInstanceId===f.completionEvidence?.parentEventInstanceId),
			completionOrder:Boolean(Number.isSafeInteger(proof?.completionOrdinal)&&proof.completionOrdinal>${candidate.waitingCompletionOrdinal}&&
				proof.completionOrdinal<${command.nativeCompletionOrdinal}),
			cardType:Boolean(['gongJi','faShu'].includes(nativeCardType)),
			targetPresent:Boolean(option?.target&&typeof option.target.playerid==='string'),
			targetMatchesAction:Boolean(option?.target?.playerid===a?.targetSeatId),
			targetIsOtherSeat:Boolean(option?.target?.playerid!==gate?.seatId)};
		const failed=Object.keys(checks).filter(name=>checks[name]!==true);
		if(failed.length)return {ok:false,code:'EVENT5_NATIVE_STATE_PROOF_REJECTED',failedChecks:failed};
		return {ok:true,seatId:gate.seatId,nativeEventId:gate.nativeEventId,rootInstanceId:s.rootInstanceId,
			actionEventInstanceId:proof.eventInstanceId,actionParentEventInstanceId:proof.parentEventInstanceId,
			nativeCompletionOrdinal:proof.completionOrdinal,cardName:option.card.name,cardKind:nativeCardType,targetSeatId:option.target.playerid,
			usedCardPosition:managed.get.position(option.card),useResultCount:a.useResultCount,useCardChildName:a.nativeUseCardChildName||null,
			useCardChildCompleted:a.nativeUseCardChildCompleted===true,nativeChildWaitCompleted:a.nativeChildWaitCompleted===true,
			nativeEventInstanceMatches:a.nativeEventInstanceMatches===true,gameMeNull:game.me===null,connectedTransports:game.players.filter(p=>p.ws).length,
			phaseOverEventInstanceId:f.phaseOverCompletionEvidence?.phaseEventInstanceId||null,
			phaseOverOrdinal:f.phaseOverCompletionEvidence?.phaseCompletionOrdinal||null,
			hands:game.players.map(p=>({seatId:p.playerid,handCount:p.countCards('h'),hand:p.getCards('h').map(card=>({name:card.name||null,suit:card.suit||null,number:card.number||null,nature:card.nature||null}))}))};})()`, returnByValue: true }, 2000);
	const observed = inspected.result?.value;
	if (inspected.exceptionDetails || observed?.ok !== true || observed.seatId !== gate.seatId ||
		observed.nativeEventId !== gate.nativeEventId || observed.rootInstanceId !== command.rootInstanceId ||
		observed.nativeCompletionOrdinal <= candidate.waitingCompletionOrdinal || observed.nativeCompletionOrdinal >= command.nativeCompletionOrdinal ||
		observed.phaseOverEventInstanceId !== command.phaseOverEventInstanceId || observed.gameMeNull !== true ||
		observed.connectedTransports !== 0 || observed.useCardChildName !== "useCard" || observed.useCardChildCompleted !== true ||
		observed.nativeChildWaitCompleted !== true || observed.nativeEventInstanceMatches !== true ||
				(observed.usedCardPosition !== "d" && observed.usedCardPosition !== "x") ||
		observed.cardName !== candidate.optionCardNames[delivery.option] || observed.cardKind !== candidate.optionKinds[delivery.option] ||
		observed.targetSeatId !== candidate.optionTargetSeatIds[delivery.option] || observed.hands?.length !== predecessorSeatIds.length) {
		if (!inspected.exceptionDetails && Array.isArray(observed?.failedChecks) && observed.failedChecks.length <= 9 &&
			observed.failedChecks.every(value => ["sessionState", "actionIdentity", "nativeEventBinding", "nativeEventCompletion", "actionResult",
				"optionBinding", "phaseFence", "completionOrder", "cardType", "targetPresent", "targetMatchesAction", "targetIsOtherSeat"].includes(value))) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId,
				observed: { kind: "event5_native_state_proof_rejected_v1", stage: "event5_native_state_proof_rejected",
					failedChecks: observed.failedChecks } });
		}
		throw new Error(observed?.code || "EVENT5_NATIVE_STATE_PROOF_REJECTED");
	}
	const seats = observed.hands.map((seat, index) => {
		const priorSeatId = predecessorSeatIds[index];
		if (seat.seatId !== priorSeatId) throw new Error(`EVENT${eventSequence}_SEAT_ORDER_REJECTED`);
		return { seatId: seat.seatId, handCount: seat.handCount,
			handCommitment: createHash("sha256").update(canonicalize(seat.hand)).digest("hex") };
	});
	const after = { revision: eventRevision, predecessorDigest: beforeDigest, actorSeatId: gate.seatId, nativeEventId: gate.nativeEventId,
		actionCompletionOrdinal: observed.nativeCompletionOrdinal, postFenceCompletionOrdinal: command.nativeCompletionOrdinal,
		captureOrdinal: command.captureOrdinal, captureCommitment: command.commitment,
		phaseOverEventInstanceId: command.phaseOverEventInstanceId };
	const afterDigest = createHash("sha256").update(canonicalize(after)).digest("hex");
	const proof = { kind: "native_authority_event_v1", checkpoint: null, eventSequence, stateRevisionBefore: predecessorRevision,
		stateRevisionAfter: eventRevision, beforeDigest, afterDigest, beforeSummary: base, afterSummary: after,
			event: { kind: isEvent8 ? "xingbei_native_successor_card_action_v4" : isEvent7 ? "xingbei_native_successor_card_action_v3" : isEvent6 ? "xingbei_native_successor_card_action_v2" : "xingbei_native_successor_card_action_v1", name: "gongJiOrFaShu", nativeEventName: "gongJiOrFaShu",
			nativeEventId: gate.nativeEventId, rootInstanceId: command.rootInstanceId, seatId: gate.seatId, optionId: delivery.option,
			cardName: observed.cardName, cardKind: observed.cardKind, targetSeatId: observed.targetSeatId,
			nativeEventCompleted: true, useResultCount: observed.useResultCount, useCardChildName: observed.useCardChildName,
			useCardChildCompleted: observed.useCardChildCompleted, usedCardPosition: observed.usedCardPosition,
			nativeChildWaitCompleted: observed.nativeChildWaitCompleted, nativeEventInstanceMatches: observed.nativeEventInstanceMatches,
			nativeCompletionOrdinal: observed.nativeCompletionOrdinal, actionEventInstanceId: observed.actionEventInstanceId,
			actionParentEventInstanceId: observed.actionParentEventInstanceId, connectionGeneration: command.connectionGeneration,
			choiceId: delivery.choiceId, deliveryId: delivery.deliveryId, resolutionKind: delivery.resolutionKind,
			gameMeNull: observed.gameMeNull, connectedTransports: observed.connectedTransports } };
	const ack = waitForAuthorityEventAck(eventSequence, eventRevision, afterDigest, 10000);
	let accepted = null;
	for (let attempt = 0; attempt < 3 && accepted === null; attempt++) {
		await new Promise((resolve, reject) => process.send?.({ ...identity, type: "host_authority_event", proof }, error => error ? reject(error) : resolve()));
		if (attempt < 2) accepted = await Promise.race([ack, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
	}
	if (accepted === null) accepted = await ack;
	if (accepted !== true) throw new Error("EVENT5_AUTHORITY_REJECTED");
	const finalized = await cdp.send("Runtime.evaluate", { expression: `(()=>{const state=window.__v2ManagedGame,draw=window.__v2ManagedOpeningDraw;
		if(state?.authorityState?.revision!==${predecessorRevision}||draw?.authorityDigest!==${JSON.stringify(beforeDigest)})return {ok:false};
		state.authorityState.revision=${eventRevision};draw.authoritySummary=${JSON.stringify(after)};draw.authorityDigest=${JSON.stringify(afterDigest)};return {ok:true}})()`,
		returnByValue: true }, 1500);
	if (finalized.exceptionDetails || finalized.result?.value?.ok !== true) throw new Error("EVENT5_AUTHORITY_FINALIZE_FAILED");
	if (eventSequence === 5) {
		if (!Array.isArray(base.seats) || base.seats.length !== 4 || base.seats.some(seat => typeof seat?.seatId !== "string")) {
			throw new Error("EVENT5_AUTHORITY_SEAT_BASELINE_INVALID");
		}
		interactiveChoice.authoritySeatIds = Object.freeze(base.seats.map(seat => seat.seatId));
	}
	interactiveChoice.openingAuthoritySummary = Object.freeze(after);
	interactiveChoice.openingAuthorityDigest = afterDigest;
	if (eventSequence === 5) interactiveChoice.event5AuthorityAccepted = true;
	else if (eventSequence === 6) interactiveChoice.event6AuthorityAccepted = true;
	else if (isEvent7) interactiveChoice.event7AuthorityAccepted = true;
	else interactiveChoice.event8AuthorityAccepted = true;
	// Publish the manager-accepted predecessor to the native loop before releasing
	// its fence. The next GameEvent can start synchronously with fence resolution;
	// setting these flags afterward races candidate dispatch against the authority ACK.
	if (interactiveChoice.nativeInputGate?.nativeEventId === gate.nativeEventId) {
		interactiveChoice.nativeInputGate.status = "authority_committed";
	}
	const released = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,f=s?.nativePhaseBoundaryFence,
		game=window.__v2ManagedEngine?.core?.game,manager=window.__v2ManagedEngine?.core?._status?.eventManager;
		if(!f||f.status!=='waiting'||f.releaseCount!==0||f.boundaryOrdinal!==${isEvent8 ? 5 : isEvent7 ? 4 : isEvent6 ? 3 : 2}||f.nativeEventId!==${JSON.stringify(gate.nativeEventId)}||
			f.seatId!==${JSON.stringify(gate.seatId)}||f.rootEvent!==s?.root||f.phaseLoopEvent!==s?.phaseLoop||manager?.rootEvent!==s?.root||
			f.pendingDescendantCount!==0||f.phaseOverTriggerComplete!==true||game?.me!==null||
			window.__v2ManagedGame?.authorityState?.revision!==${eventRevision}||window.__v2ManagedOpeningDraw?.authorityDigest!==${JSON.stringify(afterDigest)})return {ok:false};
		f.status='accepted';f.releaseCount=1;f.acceptedAuthority=Object.freeze({eventSequence:${eventSequence},stateRevision:${eventRevision},afterDigest:${JSON.stringify(afterDigest)}});
		f.resolve({accepted:true,nativeEventId:f.nativeEventId,rootInstanceId:f.rootInstanceId,seatId:f.seatId,eventSequence:${eventSequence},stateRevision:${eventRevision},afterDigest:${JSON.stringify(afterDigest)}});
		return {ok:true,releaseCount:f.releaseCount}})()`, returnByValue: true }, 1500);
	if (released.exceptionDetails || released.result?.value?.ok !== true || released.result.value.releaseCount !== 1) throw new Error(`EVENT${eventSequence}_PHASE_BOUNDARY_RELEASE_UNCERTAIN`);
	record.status = gate.status = "authority_committed";
	record.resolveAuthorityCommit?.(true);
	record.resolveAuthorityCommit = null;
	record.rejectAuthorityCommit = null;
	process.send?.({ ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: delivery.choiceId,
		deliveryId: delivery.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true, authorityEventSequence: eventSequence });
	emitNativeStartDiagnostic({ stage: `native_successor_card_action_event_${eventSequence}_accepted`, snapshot: { eventSequence, stateRevision: eventRevision,
		beforeDigest, afterDigest, seatId: gate.seatId, nativeEventId: gate.nativeEventId,
		actionCompletionOrdinal: observed.nativeCompletionOrdinal, postFenceCompletionOrdinal: command.nativeCompletionOrdinal,
		captureOrdinal: command.captureOrdinal, gameMeAbsent: true, checkpointAvailable: false } });
}

function emitNativeStartDiagnostic(observed) {
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || !observed || typeof observed !== "object") return;
	if (observed.stage === "native_input_wait_open" && observed.snapshot?.nativeInputGate &&
		typeof observed.snapshot.rootInstanceId === "string" && observed.snapshot.nativeInputGate.rootInstanceId !== observed.snapshot.rootInstanceId) {
		observed = { ...observed, snapshot: { ...observed.snapshot,
			nativeInputGate: { ...observed.snapshot.nativeInputGate, rootInstanceId: observed.snapshot.rootInstanceId } } };
	}
	if (observed.stage === "native_input_wait_open") dispatchManagedNativeActionCandidates(observed.snapshot);
	let nativeResponseAckOutcome = null;
	if (observed.stage === "native_response_applied" && interactiveChoice?.nativeResponseGates?.has(observed.snapshot?.nativeEventId)) {
		const gate = interactiveChoice.nativeResponseGates.get(observed.snapshot.nativeEventId);
		const proof = observed.snapshot;
		const delivery = gate.delivery;
		const selectedKind = delivery && gate.optionKinds?.[delivery.optionId];
		const nativeCompletionValid = proof?.nativeEventId === gate.nativeEventId && proof?.seatId === gate.seatId &&
			proof?.eventName === "yingZhan" && proof?.rootObjectMatches === true &&
			Number.isSafeInteger(proof?.nativeCompletionOrdinal) && proof.nativeCompletionOrdinal > 0 &&
			(!gate.rootInstanceId || proof?.rootInstanceId === gate.rootInstanceId) && proof?.gameMeAbsent === true &&
			(selectedKind === "view_as_skill" ? proof?.bool === true && proof?.selectedKind === "view_as_skill" &&
				proof?.skillId === "yinYangZhanHuan" && proof?.physicalMaterialConsumed === true && proof?.xiBieApplied === true &&
				Number.isSafeInteger(proof?.guiHuoDelta) && proof.guiHuoDelta > 0 && proof?.targetCount === 1 && typeof proof?.targetSeatId === "string" &&
				proof?.useCardChildrenStarted === 1 && proof?.useCardChildrenCompleted === 1 :
			selectedKind === "card" ? proof?.bool === true && proof?.selectedKind === "card" &&
				typeof proof?.cardName === "string" && proof.cardName.length > 0 && proof?.useCardChildrenStarted === 1 && proof?.useCardChildrenCompleted === 1 &&
				(gate.optionShapes?.[delivery?.optionId] === "native_single_target_card" ? proof?.targetCount === 1 && typeof proof?.targetSeatId === "string" :
					gate.optionShapes?.[delivery?.optionId] === "native_notarget_card" && proof?.targetCount === 0 && proof?.targetSeatId === null) :
			selectedKind === "decline" && proof?.bool === false && proof?.selectedKind === "decline" &&
				proof?.targetCount === 0 && proof?.useCardChildrenStarted === 0 && proof?.useCardChildrenCompleted === 0);
		if (delivery && (delivery.status === "applying" || delivery.status === "dispatched") && nativeCompletionValid) {
			gate.status = "applied";
			delivery.status = "applied";
			gate.completedProof = Object.freeze({ nativeEventId: gate.nativeEventId, actionEventId: gate.actionEventId,
				seatId: gate.seatId, sourceSeatId: gate.sourceSeatId, kind: proof.selectedKind,
				optionId: delivery.optionId, optionShape: gate.optionShapes[delivery.optionId], targetSeatId: proof.targetSeatId || null,
				targetCount: proof.targetCount, forced: gate.forced,
				useCardChildrenStarted: proof.useCardChildrenStarted, useCardChildrenCompleted: proof.useCardChildrenCompleted,
				...(proof.selectedKind === "view_as_skill" ? { skillId: proof.skillId, physicalMaterialConsumed: proof.physicalMaterialConsumed,
					xiBieApplied: proof.xiBieApplied, resolvedXiBie: proof.resolvedXiBie, guiHuoDelta: proof.guiHuoDelta } : {}),
				rootInstanceId: proof.rootInstanceId, nativeCompletionOrdinal: proof.nativeCompletionOrdinal });
			if (!delivery.ackSent) {
				delivery.ackSent = true;
				const ack = { ...identity, type: "host_choice_ack", seatId: gate.seatId, choiceId: delivery.choiceId,
					deliveryId: delivery.deliveryId, nativeEventId: gate.nativeEventId, nativeApplied: true,
					nativeCompletionOrdinal: proof.nativeCompletionOrdinal,
					nativeResponseEventCompleted: true, nativeUseCardChildCount: proof.useCardChildrenCompleted };
				process.send?.(ack);
				if (delivery.ackRetryRequested) {
					delivery.ackRetryRequested = false;
					process.send?.(ack);
				}
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
		observed.snapshot?.eventName === "yingZhan" && observed.snapshot?.actionEventId === interactiveChoice?.nativeInputGate?.nativeEventId &&
		!interactiveChoice?.nativeResponseGates?.has(observed.snapshot?.nativeEventId)) {
		const snapshot = observed.snapshot, ids = snapshot.optionIds, kinds = snapshot.optionKinds, shapes = snapshot.optionShapes;
		const optionMetadataValid = Array.isArray(ids) && ids.length > 0 && ids.length <= 64 && kinds && shapes &&
			Object.keys(kinds).length === ids.length && Object.keys(shapes).length === ids.length &&
			ids.every(id => (kinds[id] === "card" && ["native_single_target_card", "native_notarget_card"].includes(shapes[id])) ||
				(kinds[id] === "view_as_skill" && shapes[id] === "native_single_target_view_as_skill") ||
				(kinds[id] === "decline" && shapes[id] === "native_optional_decline"));
		if (!optionMetadataValid) {
			process.send?.({ ...identity, type: "host_failure", code: "NATIVE_RESPONSE_OPTION_SHAPE_REJECTED" });
			return;
		}
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
			optionIds: [...snapshot.optionIds], optionKinds: { ...snapshot.optionKinds }, optionShapes: { ...snapshot.optionShapes }, delivery: null };
		interactiveChoice.nativeResponseGates.set(snapshot.nativeEventId, gate);
		process.send?.({ ...identity, type: "host_native_response_candidates", eventName: "yingZhan",
			eventSequence: 4, nativeEventId: snapshot.nativeEventId, seatId: snapshot.seatId, rootInstanceId: snapshot.rootInstanceId,
			options: [...snapshot.optionIds], optionKinds: snapshot.optionKinds, optionShapes: snapshot.optionShapes,
			...(process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1" ? { optionCanTriggerNestedResponse: snapshot.optionCanTriggerNestedResponse } : {}),
			trusteeOption: snapshot.declineOptionId || snapshot.optionIds[0],
			deadlineMs: process.env.V2_NATIVE_RESPONSE_TRUSTEE === "1" ? 750 : 5000 });
	}
	if (observed.stage === "native_input_wait_open") dispatchManagedNativeActionCandidates(observed.snapshot);
	if (interactiveChoice?.nativeInputGate?.controllerManaged && observed.stage === "native_action_event_completed") {
		const gate = interactiveChoice.nativeInputGate;
		const record = gate.actionDeliveries.get(gate.seatId);
		const proof = observed.snapshot?.nativeAction;
		const nativeSkill = proof?.actionKind === "native_skill";
		const operationComplete = nativeSkill ? proof?.skillId === "jiRi_moBaoChongJie" &&
			proof?.nativeUseSkillChildCompleted === true && proof?.nativeTargetChoiceCompleted === true &&
			proof?.nativeChangeZhanJiCompleted === true && Number.isSafeInteger(proof?.baoShiBefore) &&
			proof?.baoShiAfter === proof.baoShiBefore + 1 : proof?.nativeUseCardChildCompleted === true &&
			proof?.cardInHandAfterNativeWait === false && proof?.nativeEventStepAfterWait >= 5;
		if (record?.status === "applying" && proof?.eventId === gate.nativeEventId && proof?.seatId === gate.seatId &&
			proof?.optionId === record.option && proof?.useResultCount === 1 && proof?.nativeChildWaitCompleted === true &&
			proof?.nativeEventInstanceMatches === true && operationComplete && observed.snapshot?.eventName === "gongJiOrFaShu" &&
			observed.snapshot?.eventFinished === true && observed.snapshot?.hostPlayerAbsent === true) {
			if (process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4") ||
				(experimentalAuthorityEventEnabled(5) && gate.eventSequence === 4) ||
				process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
				record.status = "native_applied_authority_pending";
				gate.status = "native_applied_authority_pending";
				if (nativeSkill && process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR === "1") {
					if (pendingNativeActionAuthorities.size >= 4 || pendingNativeActionAuthorities.has(gate.nativeEventId)) {
						process.send?.({ ...identity, type: "host_failure", code: "NATIVE_PARENT_FENCE_PENDING_LIMIT" }, () => cleanup().finally(() => process.exit(1)));
					} else {
						const pending = { gate, record, timer: null };
						pending.timer = setTimeout(() => {
							if (pendingNativeActionAuthorities.get(gate.nativeEventId) !== pending) return;
							pendingNativeActionAuthorities.delete(gate.nativeEventId);
							process.send?.({ ...identity, type: "host_failure", code: "NATIVE_PARENT_FENCE_WAIT_TIMEOUT" }, () => cleanup().finally(() => process.exit(1)));
						}, WAIT_MS);
						pendingNativeActionAuthorities.set(gate.nativeEventId, pending);
					}
				} else {
					commitNativeCardActionAuthority(gate, record).catch(error => {
						const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "NATIVE_ACTION_AUTHORITY_UNCERTAIN";
						process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
					});
				}
			} else if (experimentalAuthorityEventEnabled(gate.eventSequence) && [5, 6, 7, 8].includes(gate.eventSequence)) {
				// Successor native results remain held until their matching completed
				// phaseOver boundary is captured and the event-specific validator accepts.
				record.status = "native_applied_authority_pending";
				gate.status = "native_applied_authority_pending";
			} else {
				record.status = "applied";
				gate.status = "applied";
			}
			if (!process.env.V2_NATIVE_START_PROBE_MODE?.startsWith("managed_opening_root_action_event4") &&
				!([4, 5, 6, 7, 8].includes(gate.eventSequence) && experimentalAuthorityEventEnabled(gate.eventSequence)) &&
				process.env.V2_NATIVE_JIRIMO_EVENT4_ATOMIC_PAIR !== "1" &&
				process.env.V2_MANAGED_NATIVE_FAULT_INJECTION !== "cdp_result_unknown_after_dispatch") {
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
	if (!nativeFailureReported && ["wait_next_error", "native_useResult_exception", "native_useCard_child_exception", "native_viewas_result_assignment_exception",
		"native_viewas_useCard_child_exception", "native_viewas_partial_effect_exception"].includes(observed.stage) && interactiveChoice?.nativeInputGate?.controllerManaged) {
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
		if (/^(cardName|selectedCardName|handCommitment|secret|credential|hands?)$/i.test(key)) continue;
		safe[key] = sanitizeNativeStartDiagnostic(item);
	}
	return safe;
}

function dispatchManagedNativeActionCandidates(snapshot) {
	const managedModes = new Set(["managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry",
		"managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4",
		"managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe",
		"managed_native_skill_candidate_probe"]);
	const directResumeModes = new Set(["managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop"]);
	const mode = process.env.V2_NATIVE_START_PROBE_MODE;
	const gate = snapshot?.nativeInputGate;
	if (gate?.eventSequence === 6 && process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1") {
		const current = interactiveChoice?.nativeInputGate;
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: gate.nativeEventId || null,
			observed: { kind: "native_event6_candidate_dispatch_v1", stage: "event6_candidate_dispatch_inspected",
				snapshot: { modeAllowed: mode === "managed_opening_root_action_event5", event6ProbeEnabled: true,
					authorityLimit: process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "6",
					networkBlocked: process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1",
					inputGateWaiting: gate.waiting === true, inputGateAction: gate.action === true,
					candidateCount: Array.isArray(gate.candidates) ? gate.candidates.length : 0,
					interactiveChoicePresent: Boolean(interactiveChoice), authorityEvent5Accepted: interactiveChoice?.event5AuthorityAccepted === true,
					currentEventSequence: current?.eventSequence ?? null, currentStatus: current?.status || null,
					rootInstanceMatches: gate.rootInstanceId === snapshot.rootInstanceId, gameMeAbsent: snapshot.hostPlayerAbsent === true } } });
	}
	if (process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1" && gate?.diagnosticOnly === true &&
		["managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss"].includes(mode) &&
		gate.eventName === "gongJiOrFaShu" && gate.waiting === true) {
		if (nextSeatDiagnosticDispatched.has(gate.nativeEventId) || nextSeatDiagnosticDispatched.size >= 8) return false;
		nextSeatDiagnosticDispatched.add(gate.nativeEventId);
		const optionKinds = Object.fromEntries(gate.candidates.map(candidate => [candidate.optionId, candidate.cardType]));
		process.send?.({ ...identity, type: "host_native_input_candidates_diagnostic", eventName: gate.eventName,
			nativeEventId: gate.nativeEventId, rootInstanceId: snapshot.rootInstanceId, seatId: gate.seatId,
			eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
			waitingCompletionOrdinal: gate.waitingCompletionOrdinal,
			options: gate.candidates.map(candidate => candidate.optionId), optionKinds,
			optionCardNames: Object.fromEntries(gate.candidates.filter(candidate => typeof candidate.cardName === "string")
				.map(candidate => [candidate.optionId, candidate.cardName])),
			optionTargetSeatIds: Object.fromEntries(gate.candidates.filter(candidate => typeof candidate.targetSeatId === "string")
				.map(candidate => [candidate.optionId, candidate.targetSeatId])) });
		return true;
	}
	if (!interactiveChoice || (!managedModes.has(mode) && !directResumeModes.has(mode)) || !gate ||
		gate.eventName !== "gongJiOrFaShu" || gate.action !== true || gate.waiting !== true ||
		!/^native_[A-Za-z0-9_-]{16,96}$/.test(gate.nativeEventId || "") ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(gate.seatId || "") || !Array.isArray(gate.candidates) ||
		gate.candidates.length < 1 || gate.candidates.length > 64 || snapshot.eventName !== "gongJiOrFaShu") return false;
	const current = interactiveChoice.nativeInputGate;
	const controllerManaged = managedModes.has(mode);
	if (current?.nativeEventId === gate.nativeEventId && (current.candidateDispatched === true || !controllerManaged)) return false;
		const event5Mode = mode === "managed_opening_root_action_event5" && gate.eventSequence === 5 && experimentalAuthorityEventEnabled(5);
		const event6Mode = mode === "managed_opening_root_action_event5" && gate.eventSequence === 6 &&
			process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
			(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "6" ||
				["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) &&
				process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
				(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1")) &&
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && interactiveChoice.event5AuthorityAccepted === true;
		const event7Mode = mode === "managed_opening_root_action_event5" && gate.eventSequence === 7 &&
			process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" && ["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) &&
			(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") &&
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && interactiveChoice.event6AuthorityAccepted === true;
		const event8Mode = mode === "managed_opening_root_action_event5" && gate.eventSequence === 8 &&
			process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1" && process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "8" &&
			process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && interactiveChoice.event7AuthorityAccepted === true;
	if (current && current.nativeEventId !== gate.nativeEventId &&
		!(event5Mode && current.eventSequence === 4 && current.status === "authority_committed" && interactiveChoice.authorityEvent4Accepted === true) &&
		!(event6Mode && current.eventSequence === 5 && current.status === "authority_committed" && interactiveChoice.event5AuthorityAccepted === true) &&
		!(event7Mode && current.eventSequence === 6 && current.status === "authority_committed" && interactiveChoice.event6AuthorityAccepted === true) &&
		!(event8Mode && current.eventSequence === 7 && current.status === "authority_committed" && interactiveChoice.event7AuthorityAccepted === true)) return false;
	// Event #5's versioned authority validator only represents targeted actions
	// against another seat. Keep native self-target options in the engine's
	// private candidate map, but do not advertise them through this narrower
	// experimental authority protocol.
	const successorMode = event5Mode || event6Mode || event7Mode || event8Mode;
	const candidates = successorMode ? gate.candidates.filter(candidate => typeof candidate?.targetSeatId === "string" &&
		candidate.targetSeatId !== gate.seatId) : gate.candidates;
	const optionIds = candidates.map(candidate => candidate?.optionId);
	if (optionIds.some(optionId => !/^native_option_[a-f0-9]{32}$/.test(optionId || "")) || new Set(optionIds).size !== optionIds.length) return false;
	if (successorMode && (optionIds.length < 1 || optionIds.some(optionId => !gate.candidates.some(candidate => candidate.optionId === optionId &&
		["gongJi", "faShu"].includes(candidate.cardType) && candidate.targetSeatId !== gate.seatId)))) return false;
	const successorSequence = event8Mode ? 8 : event7Mode ? 7 : event6Mode ? 6 : event5Mode ? 5 : 4;
	interactiveChoice.nativeInputGate = { nativeEventId: gate.nativeEventId, eventSequence: successorMode ? successorSequence : 4,
		eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
		waitingCompletionOrdinal: gate.waitingCompletionOrdinal, seatId: gate.seatId, status: "waiting", controllerManaged,
		candidateDispatched: controllerManaged, optionIds, actionDeliveries: controllerManaged ? new Map() : null };
	if (event5Mode) interactiveChoice.event5SuccessorCandidate = Object.freeze({ nativeEventId: gate.nativeEventId,
		eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
		waitingCompletionOrdinal: gate.waitingCompletionOrdinal, seatId: gate.seatId,
		optionKinds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardType]))),
		optionCardNames: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardName]))),
		optionTargetSeatIds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.targetSeatId]))) });
	if (event6Mode) interactiveChoice.event6SuccessorCandidate = Object.freeze({ nativeEventId: gate.nativeEventId,
		eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
		waitingCompletionOrdinal: gate.waitingCompletionOrdinal, seatId: gate.seatId,
		optionKinds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardType]))),
		optionCardNames: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardName]))),
		optionTargetSeatIds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.targetSeatId]))) });
	if (event7Mode) interactiveChoice.event7SuccessorCandidate = Object.freeze({ nativeEventId: gate.nativeEventId,
		eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
		waitingCompletionOrdinal: gate.waitingCompletionOrdinal, seatId: gate.seatId,
		optionKinds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardType]))),
		optionCardNames: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardName]))),
		optionTargetSeatIds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.targetSeatId]))) });
	if (event8Mode) interactiveChoice.event8SuccessorCandidate = Object.freeze({ nativeEventId: gate.nativeEventId,
		eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
		waitingCompletionOrdinal: gate.waitingCompletionOrdinal, seatId: gate.seatId,
		optionKinds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardType]))),
		optionCardNames: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.cardName]))),
		optionTargetSeatIds: Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.optionId, candidate.targetSeatId]))) });
	if (controllerManaged) interactiveChoice.nativeSkillTargetGates = new Map();
	if (!controllerManaged) return true;
	const candidatesForMessage = successorMode ? candidates : gate.candidates;
	const message = { ...identity, type: "host_native_action_candidates", nativeEventId: gate.nativeEventId,
		eventSequence: successorMode ? successorSequence : 4, seatId: gate.seatId, rootInstanceId: snapshot.rootInstanceId || null,
		...(successorMode ? { eventInstanceId: gate.eventInstanceId, parentEventInstanceId: gate.parentEventInstanceId,
			waitingCompletionOrdinal: gate.waitingCompletionOrdinal } : {}), options: optionIds,
		optionKinds: Object.fromEntries(candidatesForMessage.map(candidate => [candidate.optionId, candidate.cardType])),
		optionCardNames: successorMode ? Object.fromEntries(candidatesForMessage.map(candidate => [candidate.optionId, candidate.cardName])) : undefined,
		optionTargetSeatIds: Object.fromEntries(candidatesForMessage.filter(candidate => typeof candidate.targetSeatId === "string")
			.map(candidate => [candidate.optionId, candidate.targetSeatId])),
		...(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" ? { optionNativeTargetSpellEligible: Object.fromEntries(gate.candidates
			.filter(candidate => candidate.cardType === "native_skill").map(candidate => [candidate.optionId, candidate.targetHasNativeSpell === true])) } : {}),
		...(successorMode ? {} : { skillCandidateCount: gate.nativeSkillCandidateCount || 0 }),
		...(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" ? { jiRiFixture: { seatId: gate.seatId, nativeCandidateGenerated: (gate.nativeSkillCandidateCount || 0) > 0 } } : {}),
		...(process.env.V2_NATIVE_YINYANG_FIXTURE === "1" ? { optionTargetSeatIds: Object.fromEntries(gate.candidates.map(candidate => [candidate.optionId, candidate.targetSeatId])) } : {}),
		...(process.env.V2_NATIVE_YINYANG_FIXTURE === "1" ? { optionYinYangEligible: Object.fromEntries(gate.candidates.map(candidate => [candidate.optionId, candidate.yinyangEligible === true])) } : {}),
		...(!successorMode && process.env.V2_NATIVE_MANAGED_RESPONSE === "1"
			? { responseProbeOptions: gate.candidates.filter(candidate => candidate.responseProbePotential === true).map(candidate => candidate.optionId) } : {}),
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
		!cdp || !["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe", "controlled_block", "managed_random_failure_probe"].includes(message.mode) ||
		(message.mode === "managed_random_failure_probe" && process.env.V2_NATIVE_RANDOM_FAILURE_PROBE !== "1")) throw new Error("NATIVE_START_DIAGNOSTIC_REJECTED");
	if ((process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1") &&
		process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE !== "1") {
		throw new Error("NATIVE_PHASE_COMPLETION_LEDGER_REQUIRED");
	}
	if (message.mode === "managed_random_failure_probe") {
		const probe = await cdp.send("Runtime.evaluate", { expression: `(()=>{const notify=window.__v2ManagedRandomFailureNotify;if(typeof notify!=='function')return {ok:false,code:'MANAGED_RANDOM_FAILURE_BINDING_MISSING'};notify('MANAGED_RANDOM_SOURCE_FAILED');return {ok:true}})()`, returnByValue: true }, 1500);
		if (probe.exceptionDetails || probe.result?.value?.ok !== true) throw new Error(probe.result?.value?.code || "MANAGED_RANDOM_FAILURE_PROBE_FAILED");
		emitNativeStartDiagnostic({ stage: "managed_random_failure_binding_invoked", classification: "test_only_binding_probe" });
		return;
	}
	if (!nativeStartDiagnosticUnsubscribe) {
		await cdp.send("Runtime.enable");
		await cdp.send("Runtime.addBinding", { name: "__v2NativeStartTrace" });
		nativeStartDiagnosticUnsubscribe = cdp.onEvent(event => {
			if (event.method !== "Runtime.bindingCalled" || event.params?.name !== "__v2NativeStartTrace" ||
				typeof event.params.payload !== "string" || event.params.payload.length > 65536) return;
			let traceStage = null, traceStep = null;
			try {
				const payload = JSON.parse(event.params.payload);
				traceStage = typeof payload?.stage === "string" ? payload.stage : null;
				if (payload?.kind !== "native_start_trace_v1" || typeof payload.stage !== "string" ||
					!payload.snapshot || typeof payload.snapshot !== "object") return;
				if (payload.stage === "native_parent_fence_waiting") {
					const fence = payload.snapshot;
					const pending = typeof fence.nativeEventId === "string" ? pendingNativeActionAuthorities.get(fence.nativeEventId) : null;
					if (pending) {
						clearTimeout(pending.timer);
						pendingNativeActionAuthorities.delete(fence.nativeEventId);
						if (fence.status !== "waiting" || fence.seatId !== pending.gate.seatId ||
							fence.rootInstanceId !== interactiveChoice?.nativeRootInstanceId || fence.rootObjectMatches !== true ||
							fence.connectedTransports !== 0 || fence.gameMeAbsent !== true) {
							process.send?.({ ...identity, type: "host_failure", code: "NATIVE_PARENT_FENCE_BINDING_REJECTED" }, () => cleanup().finally(() => process.exit(1)));
						} else {
						pending.record.parentFenceTraceAccepted = true;
						commitNativeCardActionAuthority(pending.gate, pending.record).catch(error => {
							const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "NATIVE_ACTION_AUTHORITY_UNCERTAIN";
							process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
						});
						}
					}
				}
				if (payload.stage === "native_jiri_target_choice_candidates") {
					traceStep = "candidate_received";
					const snapshot = payload.snapshot, actionGate = interactiveChoice?.nativeInputGate;
					const optionIdsValid = Array.isArray(snapshot.optionIds) && snapshot.optionIds.length > 0 && snapshot.optionIds.length <= 32 &&
						new Set(snapshot.optionIds).size === snapshot.optionIds.length && snapshot.optionIds.every(option => typeof option === "string" && /^native_option_[a-f0-9]{32}$/.test(option));
					const optionKindsValid = Boolean(optionIdsValid && snapshot.optionKinds && Object.keys(snapshot.optionKinds).length === snapshot.optionIds.length &&
						snapshot.optionIds.every(option => snapshot.optionKinds[option] === "physical_faShu_discard"));
					const bindingValid = process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && actionGate?.status === "applying" &&
						actionGate.nativeEventId === snapshot.actionEventId && actionGate.seatId === snapshot.sourceSeatId &&
						/^native_event_[a-f0-9]{32}$/.test(snapshot.nativeEventId || "") &&
						/^native_[A-Za-z0-9_-]{16,96}$/.test(snapshot.actionEventId || "") &&
						interactiveChoice.choices.has(snapshot.seatId) && snapshot.eventName === "chooseToDiscard" &&
						snapshot.skillEventName === "useSkill" && snapshot.eventInstanceMatches === true && snapshot.gameMeAbsent === true &&
						optionIdsValid && optionKindsValid && snapshot.rootInstanceId === interactiveChoice?.nativeRootInstanceId;
					if (!bindingValid) {
						process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: interactiveChoice?.nativeEventId || null,
							observed: { kind: "native_start_diagnostic", stage: "native_jiri_target_choice_rejected", failureCode: "JIRIMO_TARGET_CANDIDATE_BINDING_REJECTED",
								actionGatePresent: Boolean(actionGate), actionGateStatus: actionGate?.status || null,
								actionEventMatches: actionGate?.nativeEventId === snapshot.actionEventId, sourceSeatMatches: actionGate?.seatId === snapshot.sourceSeatId,
								nativeEventIdValid: /^native_event_[a-f0-9]{32}$/.test(snapshot.nativeEventId || ""),
								actionEventIdValid: /^native_[A-Za-z0-9_-]{16,96}$/.test(snapshot.actionEventId || ""),
								seatIdValid: interactiveChoice?.choices?.has(snapshot.seatId) === true, eventNameValid: snapshot.eventName === "chooseToDiscard",
								skillEventNameIsUseSkill: snapshot.skillEventName === "useSkill", eventInstanceMatches: snapshot.eventInstanceMatches === true,
								skillEventValid: snapshot.skillEventName === "useSkill" && snapshot.eventInstanceMatches === true,
								gameMeAbsent: snapshot.gameMeAbsent === true, optionCount: Array.isArray(snapshot.optionIds) ? snapshot.optionIds.length : null,
								optionIdsValid, optionKindsValid, rootInstanceMatches: snapshot.rootInstanceId === interactiveChoice?.nativeRootInstanceId } });
						return;
					}
					traceStep = "candidate_validated";
					if (interactiveChoice.nativeSkillTargetGates?.has(snapshot.nativeEventId)) {
						return emitNativeStartDiagnostic({ stage: "native_jiri_target_choice_rejected", failureCode: "JIRIMO_TARGET_CANDIDATE_DUPLICATE_REJECTED" });
					}
					interactiveChoice.nativeSkillTargetGates ??= new Map();
					interactiveChoice.nativeSkillTargetGates.set(snapshot.nativeEventId, { nativeEventId: snapshot.nativeEventId,
						actionEventId: snapshot.actionEventId, seatId: snapshot.seatId, sourceSeatId: snapshot.sourceSeatId,
						optionIds: [...snapshot.optionIds], status: "waiting", delivery: null });
					emitNativeStartDiagnostic({ stage: "native_jiri_target_choice_candidates", snapshot: {
						nativeEventId: snapshot.nativeEventId, actionEventId: snapshot.actionEventId, eventName: "chooseToDiscard",
						eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
						parentEventName: snapshot.parentEventName === "jiRi_moBaoChongJie" ? snapshot.parentEventName : null,
						seatId: snapshot.seatId, sourceSeatId: snapshot.sourceSeatId, eventInstanceMatches: true,
						rootInstanceId: snapshot.rootInstanceId, optionIds: [...snapshot.optionIds],
						optionKinds: { ...snapshot.optionKinds }, optionCount: snapshot.optionIds.length,
						deadlineMs: snapshot.deadlineMs, gameMeAbsent: true } });
					traceStep = "candidate_registered";
					if (!process.connected || typeof process.send !== "function") throw new Error("HOST_IPC_UNAVAILABLE");
					process.send?.({ ...identity, type: "host_native_skill_target_candidates", eventName: "chooseToDiscard",
						eventSequence: 4, nativeEventId: snapshot.nativeEventId, actionEventId: snapshot.actionEventId,
						seatId: snapshot.seatId, sourceSeatId: snapshot.sourceSeatId, rootInstanceId: snapshot.rootInstanceId,
						options: [...snapshot.optionIds], optionKinds: { ...snapshot.optionKinds }, trusteeOption: snapshot.optionIds[0], deadlineMs: 3000 });
					return;
				}
				if (payload.stage === "native_jiri_target_applied") {
					const snapshot = payload.snapshot;
					const gate = interactiveChoice?.nativeSkillTargetGates?.get(snapshot.nativeEventId);
					const delivery = gate?.delivery;
					const validAppliedProof = process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && gate && delivery &&
						gate.nativeEventId === snapshot.nativeEventId && gate.seatId === snapshot.seatId &&
						delivery.choiceId === snapshot.choiceId && delivery.deliveryId === snapshot.deliveryId &&
						delivery.optionId === snapshot.optionId && delivery.status === "applying" && gate.status === "applying" &&
						snapshot.eventName === "chooseToDiscard" && snapshot.eventFinished === true && snapshot.resultMatches === true &&
						snapshot.cardMoved === true && snapshot.nativeUseSkillChildCompleted === true &&
						snapshot.nativeChangeZhanJiCompleted === true && snapshot.rootMatches === true && snapshot.gameMeAbsent === true &&
						interactiveChoice.choices.has(snapshot.seatId);
					if (!validAppliedProof) {
						return emitNativeStartDiagnostic({ stage: "native_jiri_target_choice_rejected",
							failureCode: "JIRIMO_TARGET_APPLIED_PROOF_REJECTED", snapshot: { gatePresent: Boolean(gate),
								deliveryApplying: delivery?.status === "applying", eventFinished: snapshot.eventFinished === true,
								resultMatches: snapshot.resultMatches === true, cardMoved: snapshot.cardMoved === true,
								useSkillCompleted: snapshot.nativeUseSkillChildCompleted === true,
								resourceEventCompleted: snapshot.nativeChangeZhanJiCompleted === true,
								rootMatches: snapshot.rootMatches === true, gameMeAbsent: snapshot.gameMeAbsent === true } });
					}
					gate.status = "applied";
					delivery.status = "applied";
					process.send?.({ ...identity, type: "host_choice_ack", nativeApplied: true, nativeResponseEventCompleted: true,
						choiceId: delivery.choiceId, deliveryId: delivery.deliveryId, nativeEventId: gate.nativeEventId, seatId: gate.seatId });
					return;
				}
				if (payload.stage === "native_jiri_target_gate_entered" && process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
					const snapshot = payload.snapshot;
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: { eventName: snapshot.eventName === "chooseToDiscard" ? snapshot.eventName : null,
					eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
						parentEventName: snapshot.parentEventName === "jiRi_moBaoChongJie" ? snapshot.parentEventName : null,
						seatId: typeof snapshot.seatId === "string" ? snapshot.seatId : null,
						skillEventIdentityMatches: snapshot.skillEventIdentityMatches === true,
						mappingKind: snapshot.mappingKind === "native_skill" ? snapshot.mappingKind : null,
						targetSeatMatches: snapshot.targetSeatMatches === true, gameMeAbsent: snapshot.gameMeAbsent === true } });
					return;
				}
				if (payload.stage === "native_jiri_target_send_entered" && process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
					const snapshot = payload.snapshot;
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: { eventName: "chooseToDiscard",
						eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
						seatId: typeof snapshot.seatId === "string" ? snapshot.seatId : null,
						gateStatus: typeof snapshot.gateStatus === "string" ? snapshot.gateStatus : null,
						gateSent: snapshot.gateSent === true, sameEvent: snapshot.sameEvent === true, gameMeAbsent: snapshot.gameMeAbsent === true } });
					return;
				}
				if (payload.stage === "native_jiri_target_loop" && process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
					const snapshot = payload.snapshot;
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: { eventName: "chooseToDiscard",
						eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
						seatId: typeof snapshot.seatId === "string" ? snapshot.seatId : null,
							gateStatus: typeof snapshot.gateStatus === "string" ? snapshot.gateStatus : null,
							isMine: snapshot.isMine === true, isOnline: snapshot.isOnline === true,
							forced: snapshot.forced === true, gateSent: snapshot.gateSent === true,
							autochooseFunctionPresent: snapshot.autochooseFunctionPresent === true,
						resultKind: typeof snapshot.resultKind === "string" ? snapshot.resultKind : null,
							paused: snapshot.paused === true, gameMeAbsent: snapshot.gameMeAbsent === true } });
					return;
				}
				if (payload.stage === "native_jiri_target_choice_rejected" && process.env.V2_NATIVE_JIRIMO_FIXTURE === "1") {
					const snapshot = payload.snapshot;
					emitNativeStartDiagnostic({ stage: payload.stage, failureCode: typeof snapshot.failureCode === "string" ? snapshot.failureCode : "JIRIMO_TARGET_CHOICE_REJECTED",
						snapshot: { eventName: snapshot.eventName === "chooseToDiscard" ? snapshot.eventName : null,
							eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
							parentEventName: typeof snapshot.parentEventName === "string" ? snapshot.parentEventName : null,
							seatId: typeof snapshot.seatId === "string" ? snapshot.seatId : null,
							targetCardCount: Number.isSafeInteger(snapshot.targetCardCount) ? snapshot.targetCardCount : null,
							faShuCardCount: Number.isSafeInteger(snapshot.faShuCardCount) ? snapshot.faShuCardCount : null,
							filterPassingCardCount: Number.isSafeInteger(snapshot.filterPassingCardCount) ? snapshot.filterPassingCardCount : null,
							discardableCardCount: Number.isSafeInteger(snapshot.discardableCardCount) ? snapshot.discardableCardCount : null,
							filterOkIsFunction: snapshot.filterOkIsFunction === true, filterOkMatchesBackup: snapshot.filterOkMatchesBackup === true,
							complexSelect: snapshot.complexSelect === true, complexCard: snapshot.complexCard === true, gameMeAbsent: snapshot.gameMeAbsent === true } });
					return;
				}
				if (payload.stage === "phase_over_wait_next_entered") {
					const snapshot = payload.snapshot;
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: {
						eventName: snapshot.eventName || null, eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
						parentEventName: snapshot.parentEventName || null, rootInstanceId: snapshot.rootInstanceId || null,
						rootObjectMatches: typeof snapshot.managerRootIsStateRoot === "boolean"
							? snapshot.managerRootIsStateRoot : snapshot.rootObjectMatches === true,
						managerRootEventName: snapshot.managerRootEventName || null,
						managerRootEventInstanceId: typeof snapshot.managerRootEventInstanceId === "string" ? snapshot.managerRootEventInstanceId : null,
						stateRootEventInstanceId: typeof snapshot.stateRootEventInstanceId === "string" ? snapshot.stateRootEventInstanceId : null,
						managerEventStackRootName: snapshot.managerEventStackRootName || null,
						managerEventStackRootInstanceId: typeof snapshot.managerEventStackRootInstanceId === "string" ? snapshot.managerEventStackRootInstanceId : null,
						eventInstanceId: typeof snapshot.eventInstanceId === "string" ? snapshot.eventInstanceId : null,
						eventParentName: snapshot.eventParentName || null,
						eventParentInstanceId: typeof snapshot.eventParentInstanceId === "string" ? snapshot.eventParentInstanceId : null,
						phaseLoopIdentityMatches: snapshot.phaseLoopIdentityMatches === true,
						ownerEventInstanceId: typeof snapshot.ownerEventInstanceId === "string" ? snapshot.ownerEventInstanceId : null,
						entryStep: Number.isSafeInteger(snapshot.entryStep) ? snapshot.entryStep : null,
						triggerOrdinal: Number.isSafeInteger(snapshot.triggerOrdinal) ? snapshot.triggerOrdinal : null,
						draftOwnerEventInstanceId: typeof snapshot.draftOwnerEventInstanceId === "string" ? snapshot.draftOwnerEventInstanceId : null,
						draftTriggerOrdinal: Number.isSafeInteger(snapshot.draftTriggerOrdinal) ? snapshot.draftTriggerOrdinal : null,
						draftPresent: snapshot.draftPresent === true || snapshot.phaseOverDraftPresent === true,
						draftRootMatches: snapshot.draftRootMatches === true || snapshot.phaseOverDraftRootMatches === true,
						draftOwnerMatches: snapshot.draftOwnerMatches === true || snapshot.phaseOverDraftOwnerMatches === true,
						draftOwnerStep: Number.isSafeInteger(snapshot.draftOwnerStep) ? snapshot.draftOwnerStep :
							Number.isSafeInteger(snapshot.phaseOverDraftStep) ? snapshot.phaseOverDraftStep : null,
						phaseOverTriggerCount: Number.isSafeInteger(snapshot.phaseOverTriggerCount) ? snapshot.phaseOverTriggerCount : 0,
						phaseOverDraftPresent: snapshot.phaseOverDraftPresent === true,
						phaseOverDraftRootMatches: snapshot.phaseOverDraftRootMatches === true,
						phaseOverDraftOwnerMatches: snapshot.phaseOverDraftOwnerMatches === true,
						phaseOverDraftSeatId: typeof snapshot.phaseOverDraftSeatId === "string" ? snapshot.phaseOverDraftSeatId : null,
						phaseOverDraftStep: Number.isSafeInteger(snapshot.phaseOverDraftStep) ? snapshot.phaseOverDraftStep : null,
						phaseOverDraftOrdinal: Number.isSafeInteger(snapshot.phaseOverDraftOrdinal) ? snapshot.phaseOverDraftOrdinal : null,
						gameMeAbsent: snapshot.hostPlayerAbsent === true,
					} });
					return;
				}
				if (payload.stage === "native_input_wait_open" && process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1" &&
					["managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss"].includes(process.env.V2_NATIVE_START_PROBE_MODE) &&
					payload.snapshot?.nativeInputGate?.diagnosticOnly === true) {
					const source = payload.snapshot.nativeInputGate, native = payload.snapshot;
					const safeStackDetails = Array.isArray(native.eventStackDetails) && native.eventStackDetails.length <= 8 ? native.eventStackDetails.map(detail => ({
						eventName: typeof detail.eventName === "string" ? detail.eventName : null,
						parentEventName: typeof detail.parentEventName === "string" ? detail.parentEventName : null,
						seatId: typeof detail.seatId === "string" ? detail.seatId : null,
						finished: detail.finished === true,
						nextCount: Number.isSafeInteger(detail.nextCount) ? detail.nextCount : null,
						nextHeadName: typeof detail.nextHeadName === "string" ? detail.nextHeadName : null,
						nextHeadFinished: detail.nextHeadFinished === true,
					})) : [];
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: { eventName: "gongJiOrFaShu",
						rootInstanceId: native.rootInstanceId,
						rootObjectMatches: native.rootObjectMatches === true,
						paused: native.paused === true,
						hostPlayerAbsent: native.hostPlayerAbsent === true,
						currentEventName: typeof native.eventName === "string" ? native.eventName : null,
						currentEventStep: Number.isSafeInteger(native.eventStep) ? native.eventStep : null,
						currentSeatId: typeof native.pendingChoiceSeatId === "string" ? native.pendingChoiceSeatId : null,
						eventStack: Array.isArray(native.eventStack) && native.eventStack.length <= 8 ? [...native.eventStack] : [],
						eventStackDetails: safeStackDetails,
						sourcePayloadBytes: Buffer.byteLength(event.params.payload, "utf8"),
						nativeInputGate: { diagnosticOnly: true, eventName: "gongJiOrFaShu", nativeEventId: source.nativeEventId,
							eventInstanceId: typeof source.eventInstanceId === "string" ? source.eventInstanceId : null,
							parentEventInstanceId: typeof source.parentEventInstanceId === "string" ? source.parentEventInstanceId : null,
							waitingCompletionOrdinal: Number.isSafeInteger(source.waitingCompletionOrdinal) ? source.waitingCompletionOrdinal : null,
							seatId: source.seatId, action: source.action === true, waiting: source.waiting === true,
							candidates: Array.isArray(source.candidates) ? source.candidates.slice(0, 64).map(candidate => ({
								optionId: candidate.optionId, cardType: candidate.cardType,
								cardName: candidate.cardName, targetSeatId: candidate.targetSeatId })) : [] } } });
					return;
				}
				if (payload.stage === "native_input_wait_open" && process.env.V2_NATIVE_START_PROBE_MODE === "managed_opening_root_action_event5" &&
				process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1" && [5, 6, 7, 8].includes(payload.snapshot?.nativeInputGate?.eventSequence) &&
					(payload.snapshot.nativeInputGate.eventSequence !== 6 || process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
						["6", "7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) &&
						(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "6" || process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1") &&
						(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1") &&
					(payload.snapshot.nativeInputGate.eventSequence !== 7 || process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
						["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) &&
						(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1") &&
					(payload.snapshot.nativeInputGate.eventSequence !== 8 || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1" &&
						process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "8" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1")) {
					const native = payload.snapshot, source = native.nativeInputGate, candidates = source.candidates;
					const candidateSetValid = Array.isArray(candidates) && candidates.length > 0 && candidates.length <= 64 &&
						candidates.every(candidate => candidate && typeof candidate === "object" &&
							/^native_option_[a-f0-9]{32}$/.test(candidate.optionId || "") &&
							["gongJi", "faShu"].includes(candidate.cardType) &&
							/^[A-Za-z0-9_-]{1,128}$/.test(candidate.cardName || "") &&
							/^[A-Za-z0-9_-]{1,128}$/.test(candidate.targetSeatId || "")) &&
						new Set(candidates.map(candidate => candidate.optionId)).size === candidates.length;
					if (!candidateSetValid || source.waiting !== true || source.action !== true || source.seatId == null ||
						!/^native_event_[a-f0-9]{32}$/.test(source.nativeEventId || "") ||
						!/^event_[1-9][0-9]{0,6}$/.test(source.eventInstanceId || "") ||
						!/^event_[1-9][0-9]{0,6}$/.test(source.parentEventInstanceId || "") ||
						!Number.isSafeInteger(source.waitingCompletionOrdinal) || source.waitingCompletionOrdinal < 1 ||
						native.rootObjectMatches !== true || native.hostPlayerAbsent !== true) {
						process.send?.({ ...identity, type: "host_failure", code: "EVENT5_NATIVE_INPUT_TRACE_REJECTED" });
						return;
					}
					// The full diagnostic ring may already be large after nested native
					// responses. Forward only the bounded gate envelope needed for the
					// authenticated candidate path; other private trace data is omitted.
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: { eventName: "gongJiOrFaShu",
						rootInstanceId: native.rootInstanceId, rootObjectMatches: true, hostPlayerAbsent: true,
							nativeInputGate: { eventName: "gongJiOrFaShu", nativeEventId: source.nativeEventId, eventSequence: source.eventSequence,
							eventInstanceId: source.eventInstanceId, parentEventInstanceId: source.parentEventInstanceId,
							waitingCompletionOrdinal: source.waitingCompletionOrdinal, seatId: source.seatId,
							gameMeAbsent: native.hostPlayerAbsent === true, action: true, waiting: true, candidates: candidates.map(candidate => ({ optionId: candidate.optionId,
								cardType: candidate.cardType, cardName: candidate.cardName, targetSeatId: candidate.targetSeatId })) } } });
					return;
				}
				if (event.params.payload.length > 8192) {
					const criticalStages = new Set(["native_useResult_entered", "native_useResult_exception", "native_useCard_child_exception", "native_viewas_result_assignment_exception",
						"native_viewas_useCard_child_exception", "native_viewas_partial_effect_exception", "native_viewas_partial_effect_barrier", "wait_next_error", "root_promise_rejected",
						"native_input_gate_expired", "native_input_resume_rejected", "native_input_cancel_rejected", "native_input_resume_accepted", "native_input_cancelled"]);
					if (!criticalStages.has(payload.stage)) return;
					const snapshot = payload.snapshot;
					const action = snapshot.nativeAction || {};
					const waitError = snapshot.nativeWaitError || {};
					emitNativeStartDiagnostic({ stage: payload.stage, snapshot: {
						eventName: snapshot.eventName || null, eventStep: Number.isSafeInteger(snapshot.eventStep) ? snapshot.eventStep : null,
						parentEventName: snapshot.parentEventName || null, rootEventName: snapshot.rootEventName || null,
						rootObjectMatches: snapshot.rootObjectMatches === true, nativeEventId: snapshot.nativeInputGate?.nativeEventId || null,
						seatId: action.seatId || snapshot.nativeInputGate?.seatId || null,
						failureCode: typeof snapshot.failureCode === "string" ? snapshot.failureCode : null,
						failureDetailCode: typeof snapshot.failureDetailCode === "string" && /^[A-Z0-9_]{3,96}$/.test(snapshot.failureDetailCode) ? snapshot.failureDetailCode : null,
						nativeWaitError: payload.stage === "wait_next_error" ? {
							name: typeof waitError.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(waitError.name) ? waitError.name : "Error",
							code: typeof waitError.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(waitError.code) ? waitError.code : null,
			nullBase: ["null", "undefined"].includes(waitError.nullBase) ? waitError.nullBase : null,
			property: typeof waitError.property === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,48}$/.test(waitError.property) ? waitError.property : null,
			notFunction: typeof waitError.notFunction === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,48}$/.test(waitError.notFunction) ? waitError.notFunction : null,
							referenceIdentifier: typeof waitError.referenceIdentifier === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,48}$/.test(waitError.referenceIdentifier) ? waitError.referenceIdentifier : null,
						} : null,
						phaseLoopIdentityMatches: snapshot.phaseLoopIdentityMatches === true,
						phaseOverTriggerCount: Number.isSafeInteger(snapshot.phaseOverTriggerCount) ? snapshot.phaseOverTriggerCount : 0,
						phaseOverDraftPresent: snapshot.phaseOverDraftPresent === true,
						phaseOverDraftRootMatches: snapshot.phaseOverDraftRootMatches === true,
						phaseOverDraftOwnerMatches: snapshot.phaseOverDraftOwnerMatches === true,
						phaseOverDraftSeatId: typeof snapshot.phaseOverDraftSeatId === "string" ? snapshot.phaseOverDraftSeatId : null,
						phaseOverDraftStep: Number.isSafeInteger(snapshot.phaseOverDraftStep) ? snapshot.phaseOverDraftStep : null,
						phaseOverDraftOrdinal: Number.isSafeInteger(snapshot.phaseOverDraftOrdinal) ? snapshot.phaseOverDraftOrdinal : null,
						hostPlayerAbsent: snapshot.hostPlayerAbsent === true,
						nativeInputGateStatus: snapshot.nativeInputGate?.status || null,
						nativeInputGate: snapshot.nativeInputGate ? { nativeEventId: snapshot.nativeInputGate.nativeEventId || null,
							seatId: snapshot.nativeInputGate.seatId || null, status: snapshot.nativeInputGate.status || null,
							failureCode: typeof snapshot.nativeInputGate.failureCode === "string" ? snapshot.nativeInputGate.failureCode : null,
							nativeSendCount: Number.isSafeInteger(snapshot.nativeInputGate.nativeSendCount) ? snapshot.nativeInputGate.nativeSendCount : 0,
							nativeResumeCount: Number.isSafeInteger(snapshot.nativeInputGate.nativeResumeCount) ? snapshot.nativeInputGate.nativeResumeCount : 0,
							engineResumeCount: Number.isSafeInteger(snapshot.nativeInputGate.engineResumeCount) ? snapshot.nativeInputGate.engineResumeCount : 0 } : null,
							nativeAction: snapshot.nativeAction ? { eventId: action.eventId || null, seatId: action.seatId || null,
							status: typeof action.status === "string" ? action.status : null,
							useResultCount: Number.isSafeInteger(action.useResultCount) ? action.useResultCount : 0,
							childEventName: typeof action.childEventName === "string" ? action.childEventName : null,
							childEventStep: Number.isSafeInteger(action.childEventStep) ? action.childEventStep : null,
							nativeUseCardHistoryEntries: Number.isSafeInteger(action.nativeUseCardHistoryEntries) ? action.nativeUseCardHistoryEntries : null,
							cardInHandAtFailure: typeof action.cardInHandAtFailure === "boolean" ? action.cardInHandAtFailure : null } : null,
						gameMeAbsent: snapshot.gameMeAbsent === true,
					} });
					return;
				}
				emitNativeStartDiagnostic({ stage: payload.stage, snapshot: payload.snapshot });
			} catch {
				if (traceStage === "native_jiri_target_choice_candidates") emitNativeStartDiagnostic({ stage: "native_jiri_target_choice_rejected",
					failureCode: traceStep === "candidate_received" ? "JIRIMO_TARGET_CANDIDATE_VALIDATION_FAILED" :
						traceStep === "candidate_validated" ? "JIRIMO_TARGET_CANDIDATE_REGISTER_FAILED" : "JIRIMO_TARGET_CANDIDATE_IPC_FAILED",
					snapshot: { stage: traceStep || "candidate_parse_failed" } });
			}
		});
	}
	const install = `(()=>{
	 const managedInputGate=${message.mode === "managed_input_gate"};
	 const reuseOpeningRoot=${["managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe"].includes(message.mode)};
		 const managedInputController=${["managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe"].includes(message.mode)};
	 const event6Continuation=${["6", "7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) && process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
		(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "6" || process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1") &&
		(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && message.mode === "managed_opening_root_action_event5"};
	 const event7Continuation=${["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
		(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && message.mode === "managed_opening_root_action_event5"};
	 const event8Continuation=${process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "8" && process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" && process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && message.mode === "managed_opening_root_action_event5"};
	 const multiTurnInputGateProbe=${process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1" && ["managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event5"].includes(message.mode)};
	 const managedNativeResponse=${process.env.V2_NATIVE_MANAGED_RESPONSE === "1"};
	 const multiTurnCapture=${process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1" && process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE === "1" && ["managed_opening_root_action_event4", "managed_opening_root_action_event5"].includes(message.mode)};
	 const nestedResponseProbe=${process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1"};
	 const managedInputResume=${["managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe"].includes(message.mode)};
	 const managedInputDeadlineMs=${message.mode === "managed_input_timeout" ? 1500 : 10000};
	 const managedStart=${message.mode === "managed_start" || message.mode === "managed_input_gate" || ["managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "managed_native_skill_candidate_probe"].includes(message.mode)};
	 const managed=window.__v2ManagedEngine,{game,lib,get,_status}=managed.core,manager=_status.eventManager,Player=lib.element.Player;
	 const state=reuseOpeningRoot?window.__v2ManagedOpeningDraw:(window.__v2NativeStartDiagnosticState||{traceCount:0,lastSuccessfulEventStep:null,gameStartCount:0,drawCreated:false,drawEntered:false,phaseLoopCreated:false,prepareArenaCalls:0,waitForPlayerCalls:0,randomMapOLCalls:0,chooseCharacterCalls:0,phaseCalls:0,rootPromiseState:'not_started',failureCode:null});
	 state.event6ContinuationProbe=event6Continuation;
		 state.event7ContinuationProbe=event7Continuation;
		 state.event8ContinuationProbe=event8Continuation;
	 state.multiTurnCaptureProbe=multiTurnCapture;
	 state.multiTurnInputGateProbe=multiTurnInputGateProbe;
	 state.nativeSkillTargetGates??=new Map();
	 window.__v2NativeStartDiagnosticState=state;
	 if(!state.managedResponseTraceWrapped&&typeof window.__v2NativeStartTrace==='function'){
	  const nativeTrace=window.__v2NativeStartTrace;
	  window.__v2NativeStartTrace=function(payload){try{const item=JSON.parse(payload);if(item?.stage==='native_response_wait_open'){const gate=state.managedNativeResponseGates?.get(item.snapshot?.nativeEventId);if(gate){item.snapshot.sourceSeatId=gate.sourceSeatId||null;item.snapshot.actionEventId=gate.actionEventId||null;item.snapshot.forced=gate.forced===true;if(${JSON.stringify(process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1")})item.snapshot.optionCanTriggerNestedResponse=gate.optionCanTriggerNestedResponse;payload=JSON.stringify(item)}}else if(item?.stage==='native_response_completed'){const gate=state.managedNativeResponseGates?.get(item.snapshot?.nativeEventId);if(gate&&item.snapshot?.eventName==='yingZhan'&&item.snapshot?.rootObjectMatches===true&&item.snapshot?.gameMeAbsent===true)gate.nativeCompletionFence=Object.freeze({nativeEventId:gate.nativeEventId,seatId:item.snapshot.seatId,eventInstance:gate.event,rootEvent:state.root,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:true,gameMeAbsent:true,useCardChildrenCompleted:gate.useCardChildrenCompleted})}}catch{}return nativeTrace(payload)};
	  state.managedResponseTraceWrapped=true;
	 }
	 const snapshot=()=>{const current=_status.event,top=manager.eventStack.at(-1),phaseLoop=state.phaseLoop||manager.eventStack.find(event=>event.name==='phaseLoop')||manager.rootEvent?.next?.find(event=>event.name==='phaseLoop'),phaseEvent=phaseLoop?.next?.find(event=>event.name==='phase'&&event.player===_status.firstAct),draft=state.nativePhaseOverDispatchDraft;const failureDetailCode=/^[A-Z0-9_]{3,96}$/.test(state.failureDetail||'')?state.failureDetail:null;return {eventName:current?.name||null,eventStep:Number.isSafeInteger(current?.step)?current.step:null,parentEventName:current?.parent?.name||null,rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,eventStackDepth:manager.eventStack.length,eventStackTop:top?.name||null,eventStack:manager.eventStack.map(event=>event.name),eventStackDetails:manager.eventStack.map(event=>({eventName:event.name||null,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,finished:Boolean(event.finished),nextCount:Array.isArray(event.next)?event.next.length:null,nextHeadName:event.next?.[0]?.name||null,nextHeadStep:Number.isSafeInteger(event.next?.[0]?.step)?event.next[0].step:null,nextHeadFinished:Boolean(event.next?.[0]?.finished)})),connectMode:Boolean(_status.connectMode),paused:Boolean(_status.paused),multiTurnInputGateProbe:state.multiTurnInputGateProbe===true,nextSeatInputProbeArmed:state.nextSeatInputProbeArmed===true,nextSeatInputGateSeen:state.nextSeatInputGateSeen===true,gameStartTriggered:state.gameStartCount>0,gameStartCount:state.gameStartCount,gameDrawCreated:state.drawCreated||Boolean(manager.rootEvent?.next?.some(event=>event.name==='gameDraw')),gameDrawEntered:state.drawEntered,gameDrawParentName:state.drawParentName||state.draw?.parent?.name||manager.rootEvent?.next?.find(event=>event.name==='gameDraw')?.parent?.name||null,phaseLoopCreated:state.phaseLoopCreated||Boolean(phaseLoop),phaseLoopStartRequested:state.phaseLoopStartRequested||false,phaseLoopStarted:state.phaseLoopStarted||false,phaseLoopPaused:state.phaseLoopPaused||false,phaseLoopReleased:state.phaseLoopReleased||false,phaseLoopParentName:phaseLoop?.parent?.name||state.phaseLoopParentName||null,phaseLoopIdentityMatches:phaseLoop===state.phaseLoop,phaseOverTriggerCount:state.nativePhaseOverTriggerCount||0,phaseOverDraftPresent:Boolean(draft),phaseOverDraftRootMatches:draft?.rootInstanceId===state.rootInstanceId,phaseOverDraftOwnerMatches:draft?.phaseLoopEvent===phaseLoop,phaseOverDraftSeatId:draft?.seatId||null,phaseOverDraftStep:Number.isSafeInteger(draft?.ownerEventStep)?draft.ownerEventStep:null,phaseOverDraftOrdinal:Number.isSafeInteger(draft?.triggerOrdinal)?draft.triggerOrdinal:null,firstPhaseEventName:phaseEvent?.name||null,firstPhaseParentName:phaseEvent?.parent?.name||null,firstPhaseGate:state.firstPhaseGate||null,nativeInputGate:state.nativeInputGate||null,nativeInputGateStatus:state.nativeInputResumeGate?.status||null,nativeAction:state.nativeAction||null,nativeSkillEventTrace:(state.nativeSkillEventTrace||[]).slice(-24),nativeResponseGates:[...(state.managedNativeResponseGates?.values()||[])].slice(-16).map(gate=>({nativeEventId:gate.nativeEventId,seatId:gate.seatId,eventName:gate.eventName,eventStep:Number.isSafeInteger(gate.event?.step)?gate.event.step:null,status:gate.status,waitEventName:gate.waitEvent?.name||null,waitEventFinished:Boolean(gate.waitEvent?.finished),waitResolved:gate.waitResolved===true,optionCount:gate.optionIds?.length||0,deliveryStatus:gate.delivery?.status||null,useCardChildrenStarted:gate.useCardChildrenStarted||0,useCardChildrenCompleted:gate.useCardChildrenCompleted||0})),testFaultMode:${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")},prepareArenaCalls:state.prepareArenaCalls,waitForPlayerCalls:state.waitForPlayerCalls,randomMapOLCalls:state.randomMapOLCalls,chooseCharacterCalls:state.chooseCharacterCalls,phaseCalls:state.phaseCalls,currentPhaseSeatId:_status.currentPhase?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,pendingChoiceEventName:/choose|respond|useCard/i.test(current?.name||'')?current.name:null,pendingChoiceSeatId:current?.player?.playerid||null,hostPlayerAbsent:game.me===null,seats:game.players.map(player=>({seatId:player.playerid||null,characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')})),nativeEventTrail:(state.nativeEventTrail||[]).slice(-12),lastSuccessfulEventStep:state.lastSuccessfulEventStep,nativeWaitError:state.nativeWaitError||null,rootPromiseState:state.rootPromiseState,failureCode:state.failureCode,failureDetailCode,traceCount:state.traceCount}};
	 const completionLedgerForRoot=()=>{if(${JSON.stringify(process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE === "1")}){let ledger=state.nativeEventCompletionLedger;
	   if(!ledger||ledger.rootEvent!==state.root||ledger.rootInstanceId!==state.rootInstanceId){ledger={rootEvent:state.root,rootInstanceId:state.rootInstanceId,nextInstanceOrdinal:0,completionOrdinal:0,eventIds:new WeakMap(),completed:new WeakSet(),completionEvidence:new WeakMap(),recent:[]};state.nativeEventCompletionLedger=ledger}return ledger}return null};
	 const registerNativeEventInstance=(event,ledger)=>{if(!ledger||!event||typeof event!=='object')return null;
	   if(!ledger.eventIds.has(ledger.rootEvent)){if(ledger.nextInstanceOrdinal>=1000000)throw Error('NATIVE_EVENT_INSTANCE_SEQUENCE_EXHAUSTED');ledger.eventIds.set(ledger.rootEvent,'event_'+(++ledger.nextInstanceOrdinal))}
	   let id=ledger.eventIds.get(event);if(id)return id;
	   const chain=[],seen=new Set();let current=event;while(current&&current!==ledger.rootEvent&&chain.length<64&&!seen.has(current)){seen.add(current);chain.push(current);current=current.parent}
	   if(current!==ledger.rootEvent||chain.length>=64)return null;for(const node of chain.reverse()){if(!ledger.eventIds.has(node)){if(ledger.nextInstanceOrdinal>=1000000)throw Error('NATIVE_EVENT_INSTANCE_SEQUENCE_EXHAUSTED');ledger.eventIds.set(node,'event_'+(++ledger.nextInstanceOrdinal))}}return ledger.eventIds.get(event)};
	 const recordNativeEventCompletion=(event,ledger)=>{if(!ledger||!event||event===ledger.rootEvent||ledger.completed.has(event)||!state.root||state.root!==ledger.rootEvent||
	   ledger.rootInstanceId!==state.rootInstanceId||manager.rootEvent!==state.root||event.manager!==manager||event.finished!==true)return null;
	   const eventInstanceId=registerNativeEventInstance(event,ledger),parent=event.parent,parentEventInstanceId=parent&&ledger.eventIds.get(parent);
	   if(!eventInstanceId||!parentEventInstanceId||parent.manager!==manager||!Array.isArray(parent.childEvents)||!parent.childEvents.includes(event)||
	    manager.eventStack.at(-1)!==parent||!Array.isArray(parent.next)||parent.next[0]!==event)return null;
	   if(ledger.completionOrdinal>=1000000)throw Error('NATIVE_EVENT_COMPLETION_SEQUENCE_EXHAUSTED');const evidence=Object.freeze({rootInstanceId:ledger.rootInstanceId,
	    eventInstanceId,parentEventInstanceId,completionOrdinal:++ledger.completionOrdinal,eventName:typeof event.name==='string'?event.name:null,
	    parentEventName:typeof parent.name==='string'?parent.name:null,seatId:typeof event.player?.playerid==='string'?event.player.playerid:null,
	    eventStep:Number.isSafeInteger(event.step)?event.step:null});ledger.completed.add(event);ledger.completionEvidence.set(event,evidence);ledger.recent.push(evidence);
	   if(ledger.recent.length>128)ledger.recent.shift();return evidence};
	 if(${process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1"}){
	  const originalChangeZhiLiao=Player.prototype.changeZhiLiao;
	  if(typeof originalChangeZhiLiao!=='function'||typeof lib.skill.shengJi?.content!=='function')throw Error('SHENGJI_NATIVE_RESOURCE_SOURCE_UNAVAILABLE');
	  Player.prototype.changeZhiLiao=function(...args){
	   const lineage=[],seen=new Set();for(let current=_status.event;current&&lineage.length<32&&!seen.has(current);current=current.parent){seen.add(current);lineage.push(current)}
	   const skillEvent=lineage.find(item=>item?.name==='shengJi'||item?.skill==='shengJi');
	   if(!skillEvent)return originalChangeZhiLiao.apply(this,args);
	   if(state.shengJiResourceTransition)throw Error('SHENGJI_RESOURCE_TRANSITION_DUPLICATE');
	   const before=this.zhiLiao,invokingEvent=_status.event,child=originalChangeZhiLiao.apply(this,args);
	   if(!child||child.name!=='changeZhiLiao'||child.parent!==invokingEvent||child.player!==this||child.num!==1||!Number.isSafeInteger(before))
	    throw Error('SHENGJI_NATIVE_CHANGE_CHILD_CONTRACT_REJECTED');
	   const ledger=completionLedgerForRoot();state.shengJiResourceTransition={skillEvent,invokingEvent,child,player:this,before,seatId:this.playerid,
	    rootInstanceId:state.rootInstanceId,skillEventInstanceId:registerNativeEventInstance(skillEvent,ledger),
	    invokingEventInstanceId:registerNativeEventInstance(invokingEvent,ledger),childEventInstanceId:registerNativeEventInstance(child,ledger)};
	   return child;
	  };
	 }
	 const ring=state.ring||(state.ring=[]);let emittedMilestones=0,emittedSteps=0,lastEventStepToken='';
	 const emit=stage=>{state.traceCount++;const snap=snapshot();ring.push({stage,snapshot:snap});if(ring.length>128)ring.shift();const token=[snap.eventName,snap.eventStep].join(':');const milestone=new Set(['root_event_created','root_start_dispatched','wait_for_player_called','random_map_ol_called','prepare_arena_called','choose_character_called','game_start_trigger','game_draw_called','phase_loop_called','phase_called','native_input_gate','native_input_gate_waiting','native_input_wait_open','native_input_resume_accepted','native_input_resume_rejected','native_input_cancelled','native_input_cancel_rejected','native_input_gate_expired','native_next_seat_gate_evaluated','native_useResult_entered','native_useResult_dispatched','native_useResult_exception','native_useCard_child_exception','native_action_child_wait_completed','root_promise_fulfilled','root_promise_rejected','wait_next_error']).has(stage);const criticalFailure=['native_input_gate_expired','native_input_resume_rejected','native_input_cancel_rejected','native_useResult_exception','native_useCard_child_exception','root_promise_rejected','wait_next_error'].includes(stage);const successorGateEvaluation=multiTurnInputGateProbe&&state.nextSeatInputProbeArmed===true&&stage==='native_next_seat_gate_evaluated'&&(state.nextSeatGateEvaluationCount||0)<8;if(successorGateEvaluation)state.nextSeatGateEvaluationCount=(state.nextSeatGateEvaluationCount||0)+1;const successorGateProgress=multiTurnInputGateProbe&&(state.nextSeatInputGateSeen===true||state.event5ManagedGateOpened===true)&&['native_input_gate','native_input_gate_waiting','native_input_wait_open'].includes(stage);const criticalProgress=stage==='native_useResult_entered'||successorGateEvaluation||successorGateProgress;const changedStep=token!==lastEventStepToken;lastEventStepToken=token;if(milestone){if(!criticalFailure&&!criticalProgress&&emittedMilestones++>=64)return}else if(changedStep){if(emittedSteps++>=64)return}else return;const payload={kind:'native_start_trace_v1',stage,snapshot:snap};try{window.__v2NativeStartTrace(JSON.stringify(payload))}catch{}};
	 if(!state.instrumented){
	  state.instrumented=true;
	 const GameEvent=lib.element.GameEvent,originalStart=GameEvent.prototype.start,originalWaitNext=GameEvent.prototype.waitNext,originalLoop=GameEvent.prototype.loop,originalTrigger=GameEvent.prototype.trigger,originalCreateEvent=game.createEvent,originalWaitForPlayer=game.waitForPlayer,originalPrepareArena=game.prepareArena,originalChooseCharacter=game.chooseCharacter,originalRandomMapOL=game.randomMapOL,originalDraw=game.gameDraw,originalPhaseLoop=game.phaseLoop,originalPhase=Player.prototype.phase,originalUseResult=Player.prototype.useResult;
	 if(${process.env.V2_NATIVE_YINYANG_FIXTURE === "1"}){
	  const skill=lib.skill.yinYangZhanHuan;if(!skill||typeof skill.filter!=='function'||typeof skill.viewAs!=='function')throw Error('YINYANG_NATIVE_SKILL_CONTRACT_UNAVAILABLE');
	  const originalFilter=skill.filter,originalViewAs=skill.viewAs;
	  skill.filter=function(event,player){const valid=originalFilter.apply(this,arguments);
	   if(player?.playerid===state.yinyangFixtureSeatId){const hasIncomingCard=Boolean(event?.card),matching=hasIncomingCard?player.getCards('h').filter(card=>get.mingGe(card)===get.mingGe(event.card)&&get.type(card)==='gongJi').length:0;
	    state.yinyangSkillProbe??={filterCalls:0,eligibleFilterCalls:0,viewAsCalls:0,matchingPhysicalMaterialCount:0,nativeIncomingAttack:false,eventHadCard:false};
	    state.yinyangSkillProbe.filterCalls++;if(valid)state.yinyangSkillProbe.eligibleFilterCalls++;state.yinyangSkillProbe.nativeIncomingAttack ||= hasIncomingCard&&event.canYingZhan!==false;
	    state.yinyangSkillProbe.eventHadCard ||= hasIncomingCard;state.yinyangSkillProbe.matchingPhysicalMaterialCount=Math.max(state.yinyangSkillProbe.matchingPhysicalMaterialCount,matching);
	   }return valid};
	  skill.viewAs=function(cards,player){const result=originalViewAs.apply(this,arguments);
	   if(player?.playerid===state.yinyangFixtureSeatId&&Array.isArray(cards)&&cards.length===1){state.yinyangSkillProbe??={filterCalls:0,eligibleFilterCalls:0,viewAsCalls:0,matchingPhysicalMaterialCount:0,nativeIncomingAttack:true};state.yinyangSkillProbe.viewAsCalls++}
	   return result};
	 }
	  const observeNativeInputGate=event=>{
	   const player=event.player,options=new Map(),seenOperations=new Map();let cardFilterPassed=0,targetFilterPassed=0,filterErrors=0,unsupportedCardShapes=0;
	   const rangeIsOne=value=>Array.isArray(value)?value[0]===1&&value[1]===1:value===1,
	    rangeIsZero=value=>Array.isArray(value)?value[0]===0&&value[1]===0:value===0;
	   const responseProbePossible=(incoming,defender,source)=>{const incomingXiBie=get.xiBie(incoming),canYingZhan=incomingXiBie!=='an';for(const candidate of defender.getCards('hs')){let type,name;try{type=get.type(candidate,defender);name=get.name(candidate);if(type==='gongJi'){if(!canYingZhan)continue;if(name!=='anMie'&&get.xiBie(candidate)!==incomingXiBie)continue}else if(type==='faShu'){if(name!=='shengGuang')continue}else continue;if(!lib.filter.cardEnabled(candidate,defender,'forceEnable'))continue;const info=get.info(get.autoViewAs(candidate)),targetRange=info?.selectTarget===undefined?(info?.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(type==='faShu'&&info?.notarget===true&&rangeIsZero(targetRange))return true;if(!rangeIsOne(targetRange))continue;for(const target of game.players){if(target!==source&&target.side!==defender.side&&lib.filter.targetEnabled(candidate,defender,target))return true}}catch{}}return false};
	   const actionCardRange=get.select(event.selectCard),eventShapeSupported=rangeIsOne(actionCardRange)&&rangeIsOne(get.select(event.selectTarget))&&!event.filterOk&&!Object.values(event.custom?.add||{}).some(value=>typeof value==='function')&&!Object.values(event.custom?.replace||{}).some(value=>typeof value==='function');
	   for(const card of player.getCards(event.position||'h')){try{if(!eventShapeSupported||typeof event.filterCard!=='function'||!event.filterCard(card,player,event))continue;cardFilterPassed++;const info=get.info(get.autoViewAs(card));if(!info||info.complexSelect||info.complexTarget||info.multitarget||info.singleCard||typeof info.selectTarget==='function'){unsupportedCardShapes++;continue}const targetRange=info.selectTarget===undefined?(info.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(!rangeIsOne(targetRange)){unsupportedCardShapes++;continue}for(const target of game.players){try{if(event.filterTarget?.(card,player,target)&&lib.filter.targetEnabled(card,player,target)){let targets=seenOperations.get(card);if(!targets){targets=new Set();seenOperations.set(card,targets)}if(targets.has(target))continue;targets.add(target);targetFilterPassed++;const bytes=crypto.getRandomValues(new Uint8Array(16));const optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(optionId,Object.freeze({card,target,event,seatId:player.playerid}))}}catch{filterErrors++}}}catch{filterErrors++}}
	   if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1")}&&player.playerid===state.jiRiResourceFixtureSeatId){
	    const skillId='jiRi_moBaoChongJie',skill=lib.skill[skillId],legalSkill=Boolean(skill&&player.hasSkill(skillId)&&
	     game.expandSkills(player.getSkills(false).concat(lib.skill.global)).includes(skillId)&&lib.filter.filterEnable(event,player,skillId)===true&&
	     typeof skill.filter==='function'&&skill.filter.call(skill,event,player)===true);
	    if(!legalSkill)throw Error('JIRIMO_NATIVE_SKILL_NOT_ENABLED');
	    if(typeof event.backup!=='function'||typeof event.restore!=='function')throw Error('JIRIMO_NATIVE_SKILL_BACKUP_UNAVAILABLE');
	    let candidateCount=0,targetCount=0,targetWithSpellCount=0,nativeTargetFilterPassCount=0;const hadEventFilterOk=typeof event.filterOk==='function';
	    try{
	     event.backup(skillId);
	     if(!rangeIsOne(get.select(event.selectCard))||!rangeIsOne(get.select(event.selectTarget))||hadEventFilterOk||typeof skill.filterOk==='function'||
	      event.complexSelect||event.complexCard||event.complexTarget||typeof event.filterCard!=='function'||typeof event.filterTarget!=='function')
	      throw Error('JIRIMO_NATIVE_SKILL_SELECTION_SHAPE_UNSUPPORTED');
	     const material=player.getCards(event.position||'hs').find(card=>get.type(card,player)==='faShu'&&event.filterCard(card,player,event));
	     if(!material)throw Error('JIRIMO_NATIVE_SKILL_MATERIAL_NOT_LEGAL');
	     for(const target of game.players){if(target.side===player.side)continue;targetCount++;const targetHasNativeSpell=target.getCards('h').some(card=>get.type(card,target)==='faShu');
	      if(!targetHasNativeSpell)continue;targetWithSpellCount++;if(!event.filterTarget(material,player,target))continue;nativeTargetFilterPassCount++;
	      const bytes=crypto.getRandomValues(new Uint8Array(16)),optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
	      options.set(optionId,Object.freeze({kind:'native_skill',skillId,material,target,event,seatId:player.playerid,targetSeatId:target.playerid}));candidateCount++;
	     }
	    }finally{event.restore()}
	    state.jiRiNativeSkillCandidateCount=candidateCount;state.jiRiCandidateAudit={targetCount,targetWithSpellCount,nativeTargetFilterPassCount,
	     seatSpellHandCounts:game.players.map(seat=>({seatId:seat.playerid,count:seat.getCards('h').filter(card=>get.type(card,seat)==='faShu').length}))};
	    if(candidateCount>0){const achievementList=player.side===true?game.hongZhanJi:game.lanZhanJi;
		    if(!Array.isArray(achievementList)||achievementList.length>128||!achievementList.every(value=>value==='baoShi'||value==='shuiJing'))throw Error('JIRIMO_NATIVE_ZHANJI_BASELINE_UNSUPPORTED');
		    state.jiRiZhanJiBaseline={seatId:player.playerid,side:player.side,baoShiCount:achievementList.filter(value=>value==='baoShi').length,
		     listLength:achievementList.length,orderedList:[...achievementList],rootInstanceId:state.rootInstanceId};
	    }
	    if(candidateCount===0)throw Error('JIRIMO_NATIVE_SKILL_CANDIDATE_MISSING');
	   }
	   if(options.size>64)throw Error('NATIVE_ACTION_OPTION_CAPACITY_REJECTED');
	   if(options.size===0){if(multiTurnInputGateProbe&&state.nextSeatInputProbeArmed===true&&player!==_status.firstAct){const audit={eventName:event.name,
	    parentEventName:event.parent?.name||null,seatId:player?.playerid||null,eventAction:event.action===true,eventShapeSupported,
	    cardFilterPassCount:cardFilterPassed,targetFilterPassCount:targetFilterPassed,unsupportedCardShapes,filterErrors,
	    nativeCandidateCount:0,probeArmed:true,rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null};
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_next_seat_candidate_set_empty',snapshot:audit}))}catch{}}
	    throw Error('NATIVE_ACTION_NO_SUPPORTED_CANDIDATE')}
	   window.__v2ManagedNativeActionOptions=options;
	   const eventBytes=crypto.getRandomValues(new Uint8Array(16));const nativeEventId='native_event_'+Array.from(eventBytes,value=>value.toString(16).padStart(2,'0')).join('');event.__v2NativeEventId=nativeEventId;
	   const eventLedger=completionLedgerForRoot(),eventInstanceId=eventLedger?registerNativeEventInstance(event,eventLedger):null,
	    parentEventInstanceId=eventLedger&&event.parent?registerNativeEventInstance(event.parent,eventLedger):null,
	    waitingCompletionOrdinal=eventLedger?.completionOrdinal??null;
	   if(${JSON.stringify(process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1")}&&(!eventLedger||eventLedger.rootEvent!==state.root||!eventInstanceId||!parentEventInstanceId||
	    !Number.isSafeInteger(waitingCompletionOrdinal)||waitingCompletionOrdinal<1))throw Error('NATIVE_PREACTION_CAPTURE_EVENT_INSTANCE_REGISTRATION_FAILED')
	   state.nativeInputGate={nativeEventId,eventInstanceId,parentEventInstanceId,waitingCompletionOrdinal,eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:player.playerid,action:Boolean(event.action),handCount:player.countCards('h'),nativeCardFilterPassCount:cardFilterPassed,nativeTargetFilterPassCount:targetFilterPassed,nativeCandidateMappingCount:options.size,nativeSkillCandidateCount:state.jiRiNativeSkillCandidateCount||0,candidates:[...options].map(([optionId,item])=>({optionId,cardName:item.kind==='native_skill'?null:item.card.name||null,cardType:item.kind==='native_skill'?'native_skill':get.type(item.card,player)||null,targetSeatId:item.target.playerid||null,...(item.kind==='native_skill'?{skillId:item.skillId,targetHasNativeSpell:item.target.getCards('h').some(card=>get.type(card,item.target)==='faShu')}:{}),...(${process.env.V2_NATIVE_YINYANG_FIXTURE === "1"}?{yinyangEligible:item.card&&get.type(item.card,player)==='gongJi'&&get.xiBie(item.card)!=='an'&&item.target.getCards('h').some(card=>get.type(card,item.target)==='gongJi'&&get.mingGe(card)===get.mingGe(item.card))}:{}),...(managedNativeResponse&&item.kind!=='native_skill'?{responseProbePotential:get.type(item.card,player)==='gongJi'&&responseProbePossible(item.card,item.target,player)}:{})})),supportedOptionShape:${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1"?'native_physical_card_or_jirimo_skill_probe_v1':'one-native-physical-card-one-native-target')},eventShapeSupported,unsupportedCardShapes,filterErrors,gateBeforeAiBranch:true,offlineAiPrevented:true,nativeAiResultPending:event.result==='ai',eventIsMine:Boolean(event.isMine()),eventIsOnline:Boolean(event.isOnline()),gameMeAbsent:game.me===null,useResultCount:0};emit('native_input_gate')
	  };
	  const nativeResponseContentNames=new WeakMap(),originalSetContent=GameEvent.prototype.setContent;
	  GameEvent.prototype.setContent=function(content,...args){if(this.name==='yingZhan'&&typeof content==='string')nativeResponseContentNames.set(this,content);return originalSetContent.call(this,content,...args)};
	  const prepareManagedNativeResponseGate=event=>{if(!managedNativeResponse||event.name!=='yingZhan'||event.__v2ManagedResponseGate)return null;let actionParent=null;for(let parent=event.parent,count=0;parent&&count<24;parent=parent.parent,count++){if(parent.name==='gongJiOrFaShu'){actionParent=parent;break}}const activeAction=state.nativeInputResumeGate;if(!activeAction||actionParent!==activeAction.event||actionParent.__v2NativeEventId!==activeAction.nativeEventId)return null;const player=event.player;if(!player||typeof event.filterCard!=='function'||typeof event.filterTarget!=='function')return null;
	   const options=new Map(),optionKinds={},optionShapes={},optionCanTriggerNestedResponse={},seen=new Map(),rangeIsOne=value=>Array.isArray(value)?value[0]===1&&value[1]===1:value===1,
	    rangeIsZero=value=>Array.isArray(value)?value[0]===0&&value[1]===0:value===0;
	   const canTriggerNestedResponse=(incoming,defender,source)=>{const incomingXiBie=get.xiBie(incoming),canYingZhan=incomingXiBie!=='an';for(const candidate of defender.getCards('hs')){let type,name;try{type=get.type(candidate,defender);name=get.name(candidate);if(type==='gongJi'){if(!canYingZhan)continue;if(name!=='anMie'&&get.xiBie(candidate)!==incomingXiBie)continue}else if(type==='faShu'){if(name!=='shengGuang')continue}else continue;if(!lib.filter.cardEnabled(candidate,defender,'forceEnable'))continue;const info=get.info(get.autoViewAs(candidate)),candidateRange=info?.selectTarget===undefined?(info?.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(type==='faShu'&&info?.notarget===true&&rangeIsZero(candidateRange))return true;if(!rangeIsOne(candidateRange))continue;for(const target of game.players){if(target!==source&&target.side!==defender.side&&lib.filter.targetEnabled(candidate,defender,target))return true}}catch{}}return false};
	   if(!rangeIsOne(get.select(event.selectCard))||event.filterOk||Object.values(event.custom?.add||{}).some(value=>typeof value==='function')||Object.values(event.custom?.replace||{}).some(value=>typeof value==='function'))return null;
	   for(const card of player.getCards(event.position||'hs')){let legalCard=false,info;try{legalCard=event.filterCard(card,player,event);if(!legalCard)continue;info=get.info(get.autoViewAs(card));if(!info||info.complexSelect||info.complexTarget||info.multitarget||info.singleCard||typeof info.selectTarget==='function')continue;const targetRange=info.selectTarget===undefined?(info.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);
	     if(rangeIsZero(targetRange)){if(info.notarget!==true)continue;const bytes=crypto.getRandomValues(new Uint8Array(16)),optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(optionId,Object.freeze({kind:'card',event,seatId:player.playerid,card,target:null}));optionKinds[optionId]='card';optionShapes[optionId]='native_notarget_card';optionCanTriggerNestedResponse[optionId]=false;continue}
	     if(!rangeIsOne(targetRange))continue}catch{continue}
	    for(const target of game.players){try{if(!event.filterTarget(card,player,target)||!lib.filter.targetEnabled(card,player,target))continue;let targets=seen.get(card);if(!targets){targets=new Set();seen.set(card,targets)}if(targets.has(target))continue;targets.add(target);const bytes=crypto.getRandomValues(new Uint8Array(16)),optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(optionId,Object.freeze({kind:'card',event,seatId:player.playerid,card,target}));optionKinds[optionId]='card';optionShapes[optionId]='native_single_target_card';if(nestedResponseProbe)optionCanTriggerNestedResponse[optionId]=get.type(card,player)==='gongJi'&&canTriggerNestedResponse(card,target,player)}catch{}}
	   }
	   if(${JSON.stringify(process.env.V2_NATIVE_MANAGED_YINYANG === "1")}&&${JSON.stringify(process.env.V2_NATIVE_YINYANG_FIXTURE === "1")}&&player.playerid===state.yinyangFixtureSeatId&&event.canYingZhan===true){
	    const skillId='yinYangZhanHuan',skill=lib.skill[skillId];let skillCandidateCount=0;
	    if(skill&&player.hasSkill(skillId)&&lib.filter.filterEnable(event,player,skillId)===true&&skill.filter?.call(skill,event,player)===true){
	     for(const material of player.getCards('h')){try{if(skill.filterCard.call(skill,material,player)!==true)continue;const virtual=skill.viewAs.call(skill,[material],player),info=virtual&&get.info(get.autoViewAs(virtual));if(!virtual||virtual.isCard!==true||virtual.xiBie!==get.xiBie(event.card)||!event.filterCard(virtual,player,event)||!lib.filter.cardEnabled(virtual,player,'forceEnable')||!info||info.complexSelect||info.complexTarget||info.multitarget||info.singleCard||typeof info.selectTarget==='function')continue;const targetRange=info.selectTarget===undefined?(info.filterTarget===undefined?[0,0]:[1,1]):get.select(info.selectTarget);if(!rangeIsOne(targetRange))continue;
	      for(const target of game.players){try{if(!event.filterTarget(virtual,player,target)||!lib.filter.targetEnabled(virtual,player,target))continue;const bytes=crypto.getRandomValues(new Uint8Array(16)),optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(optionId,Object.freeze({kind:'view_as_skill',skillId,event,seatId:player.playerid,material,virtualCard:Object.freeze({name:virtual.name,xiBie:virtual.xiBie,isCard:virtual.isCard}),card:virtual,target}));optionKinds[optionId]='view_as_skill';optionShapes[optionId]='native_single_target_view_as_skill';skillCandidateCount++}catch{}}
	     }catch{}}
	    }
	    if(skillCandidateCount===0)throw Error('YINYANG_NATIVE_VIEWAS_CANDIDATE_MISSING');
	   }
	   if(options.size===0)return null;let declineOptionId=null;if(event.forced!==true){const bytes=crypto.getRandomValues(new Uint8Array(16));declineOptionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');options.set(declineOptionId,Object.freeze({kind:'decline',event,seatId:player.playerid}));optionKinds[declineOptionId]='decline';optionShapes[declineOptionId]='native_optional_decline';if(nestedResponseProbe)optionCanTriggerNestedResponse[declineOptionId]=false}
	   if(options.size>64)throw Error('NATIVE_RESPONSE_OPTION_CAPACITY_REJECTED');const bytes=crypto.getRandomValues(new Uint8Array(16)),nativeEventId='native_event_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
	   const yinYangBaseline={guiHuo:player.countZhiShiWu('guiHuo')};
	   const gate={nativeEventId,event,seatId:player.playerid,eventName:event.name,nativeContentName:nativeResponseContentNames.get(event)||null,
	    actionEventId:activeAction.nativeEventId,rootInstanceId:state.rootInstanceId,rootEvent:state.root,
	    status:'prepared',options,optionIds:[...options.keys()],optionKinds,optionShapes,optionCanTriggerNestedResponse,declineOptionId,
	    useCardChildrenStarted:0,useCardChildrenCompleted:0,yinYangBaseline,delivery:null,waitPromise:null,resolveWait:null,waitEvent:null,waitResolved:false};
	   gate.waitPromise=new Promise(resolve=>{gate.resolveWait=resolve});event.__v2NativeEventId=nativeEventId;event.__v2ManagedResponseGate=gate;
	   state.managedNativeResponseGates??=new Map();state.managedNativeResponseGates.set(nativeEventId,gate);
	   event.isOnline=()=>true;event.send=function(){
	    if(this!==event)throw Error('NATIVE_RESPONSE_SEND_EVENT_MISMATCH');
	    // Some native response contents finalize event.player only when they
	    // reach their own send/wait boundary.  Discard the early, unannounced
	    // candidate map and rebuild from that now-stable native seat; never bind
	    // the IPC candidate to a different seat than the rules engine.
	    if(event.player!==player||event.player?.playerid!==gate.seatId){
	     gate.status='superseded';state.managedNativeResponseGates.delete(nativeEventId);
	     delete event.__v2ManagedResponseGate;delete event.__v2NativeEventId;
	     const rebound=prepareManagedNativeResponseGate(event);if(!rebound)throw Error('NATIVE_RESPONSE_FINAL_SEAT_CANDIDATE_REJECTED');
	     return event.send.call(this);
	    }
	    if(gate.status!=='prepared'||gate.waitEvent||gate.waitResolved)throw Error('NATIVE_RESPONSE_SEND_DUPLICATE_REJECTED');
	    gate.status='waiting';const waitEvent=game.createEvent('managedNativeResponseWait',false,event);if(waitEvent.parent!==event)throw Error('NATIVE_RESPONSE_WAIT_PARENT_REJECTED');
	    waitEvent.setContent(async()=>{await gate.waitPromise});gate.waitEvent=waitEvent;state.managedNativeResponseGate=gate;
	    state.nativeResponseGate={nativeEventId,seatId:player.playerid,eventName:'yingZhan',eventStep:Number.isSafeInteger(event.step)?event.step:null,
	     parentEventName:event.parent?.name||null,parentChain:(()=>{const chain=[];for(let parent=event.parent,count=0;parent&&count<8;parent=parent.parent,count++)chain.push(parent.name||null);return chain})(),
	     optionIds:gate.optionIds,optionKinds,optionShapes,...(${JSON.stringify(process.env.V2_NATIVE_RESPONSE_REQUIRE_NESTED === "1")} ? {optionCanTriggerNestedResponse} : {}),
	     declineOptionId,waiting:true,status:gate.status,waitEventName:waitEvent.name,waitEventParentName:waitEvent.parent?.name||null,
	     paused:Boolean(_status.paused),gameMeAbsent:game.me===null};
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_wait_open',snapshot:{...state.nativeResponseGate,
	     rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null}}))}catch{}
	    return this};
	   return gate;
	  };
	  const bindManagedResponseContext=event=>{const gate=event?.__v2ManagedResponseGate;if(!gate)return;let sourceSeatId=gate.sourceSeatId||null,actionEventId=gate.actionEventId||null;for(let parent=event.parent,count=0;parent&&count<24;parent=parent.parent,count++){if(!sourceSeatId&&parent.name==='useCard')sourceSeatId=parent.player?.playerid||null;if(!actionEventId&&parent.name==='gongJiOrFaShu'&&typeof parent.__v2NativeEventId==='string')actionEventId=parent.__v2NativeEventId}gate.sourceSeatId=sourceSeatId;gate.actionEventId=actionEventId;gate.forced=event.forced===true};
	  const recordNativeResponse=(event,stage)=>{if(!['yingZhan','chooseToRespond'].includes(event?.name))return;const chain=[];for(let parent=event.parent,count=0;parent&&count<8;parent=parent.parent,count++)chain.push(parent.name||null);const nativeContentName=nativeResponseContentNames.get(event)||null,gate=event.__v2ManagedResponseGate;const selected=gate?.delivery?.optionId?gate.options.get(gate.delivery.optionId):null;const snapshot={nativeEventId:gate?.nativeEventId||event.__v2NativeEventId||null,eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,parentChain:chain,eventStack:manager.eventStack.map(item=>item.name||null),eventStackDetails:manager.eventStack.map(item=>({eventName:item.name||null,eventStep:Number.isSafeInteger(item.step)?item.step:null,parentEventName:item.parent?.name||null,seatId:item.player?.playerid||null,finished:Boolean(item.finished),nextCount:Array.isArray(item.next)?item.next.length:null,nextHeadName:item.next?.[0]?.name||null,nextHeadStep:Number.isSafeInteger(item.next?.[0]?.step)?item.next[0].step:null,nextHeadFinished:Boolean(item.next?.[0]?.finished)})),currentEventName:_status.event?.name||null,currentEventStep:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,paused:Boolean(_status.paused),eventIsMine:Boolean(event.isMine()),eventIsOnline:Boolean(event.isOnline()),playerUnderControl:Boolean(event.player?.isUnderControl()),auto:Boolean(_status.auto),waitEventExists:Boolean(gate?.waitEvent),waitResolved:gate?.waitResolved===true,rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,seatId:event.player?.playerid||null,nativeContentName,nativeChooseToUseContent:event.name==='yingZhan'&&nativeContentName==='chooseToUse',resultBool:typeof event.result?.bool==='boolean'?event.result.bool:null,resultCardCount:Array.isArray(event.result?.cards)?event.result.cards.length:0,resultTargetCount:Array.isArray(event.result?.targets)?event.result.targets.length:0,selectedOptionId:gate?.delivery?.optionId||null,selectedKind:selected?.kind||null,selectedCardName:selected?.card?.name||null,selectedTargetSeatId:selected?.target?.playerid||null,responseGateStatus:gate?.status||null,responseUseCardChildrenStarted:gate?.useCardChildrenStarted||0,responseUseCardChildrenCompleted:gate?.useCardChildrenCompleted||0,...(${process.env.V2_NATIVE_YINYANG_FIXTURE === "1"}?{yinYangNativeCandidate:state.yinyangSkillProbe||null}:{}),gameMeAbsent:game.me===null};state.nativeResponseTrace??=[];state.nativeResponseTrace.push({stage,...snapshot});if(state.nativeResponseTrace.length>32)state.nativeResponseTrace.shift();try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_'+stage,snapshot}))}catch{}};
	  GameEvent.prototype.start=function(...args){
	   const event=this,responseEvent=['yingZhan','chooseToRespond'].includes(event.name),completionLedger=completionLedgerForRoot();let responseChildOwner=null;
	   if(event.name==='useCard'&&event.parent?.name==='yingZhan'&&event.parent.__v2ManagedResponseGate){responseChildOwner=event.parent.__v2ManagedResponseGate;responseChildOwner.useCardChildrenStarted++}
	   if(responseEvent){if(${process.env.V2_NATIVE_YINYANG_FIXTURE === "1"}&&event.name==='yingZhan'&&event.player?.playerid===state.yinyangFixtureSeatId){const skill=lib.skill.yinYangZhanHuan,matchingCards=event.card?event.player.getCards('h').filter(card=>get.type(card)==='gongJi'&&get.mingGe(card)===get.mingGe(event.card)):[],matching=matchingCards.length;
	    state.yinyangSkillProbe??={filterCalls:0,eligibleFilterCalls:0,viewAsCalls:0,matchingPhysicalMaterialCount:matching,nativeIncomingAttack:event.canYingZhan===true,eventHadCard:Boolean(event.card),hasSkill:event.player.hasSkill('yinYangZhanHuan'),nativeSkillPredicateAccepted:false};
	    if(!skill||event.canYingZhan!==true||!event.card||matching<1||!event.player.hasSkill('yinYangZhanHuan'))throw Error('YINYANG_NATIVE_EVENT_PRECONDITION_REJECTED');
	    const eligible=skill.filter.call(skill,event,event.player);state.yinyangSkillProbe.nativeSkillPredicateAccepted=eligible===true;if(!eligible)throw Error('YINYANG_NATIVE_SKILL_FILTER_REJECTED_FIXTURE');
	   }prepareManagedNativeResponseGate(event);recordNativeResponse(event,'started')}
	   registerNativeEventInstance(event,completionLedger);
	   return originalStart.apply(this,args).then(value=>{
	    const completionEvidence=recordNativeEventCompletion(event,completionLedger);
	    const resource=state.shengJiResourceTransition;
	    if(resource?.child===event){
	     const after=resource.player?.zhiLiao;
	     const effectChain=[resource.invokingEvent];for(let parent=resource.invokingEvent?.parent,count=0;parent&&count<16;parent=parent.parent,count++)effectChain.push(parent);
	     if(!completionEvidence||event.finished!==true||event.parent!==resource.invokingEvent||event.player!==resource.player||event.num!==1||
	      completionEvidence.rootInstanceId!==state.rootInstanceId||completionEvidence.eventName!=='changeZhiLiao'||
	      completionEvidence.parentEventInstanceId!==resource.invokingEventInstanceId||!Number.isSafeInteger(after)||after!==resource.before+1||
	      !effectChain.includes(resource.skillEvent))
	      throw Error('SHENGJI_NATIVE_RESOURCE_COMPLETION_PROOF_REJECTED');
	     state.shengJiResourceTransitionProof=Object.freeze({rootInstanceId:state.rootInstanceId,seatId:resource.seatId,skillName:resource.skillEvent.name||null,
	      skillIdentityMatches:resource.skillEvent.name==='shengJi'||resource.skillEvent.skill==='shengJi',invokingEventName:resource.invokingEvent.name||null,
	      invokingEventInstanceId:resource.invokingEventInstanceId,childEventName:event.name,childEventInstanceId:completionEvidence.eventInstanceId,
	      childParentEventInstanceId:completionEvidence.parentEventInstanceId,childCompletionOrdinal:completionEvidence.completionOrdinal,
	      before:resource.before,after,delta:after-resource.before,childFinished:event.finished===true});
	     if(!state.shengJiResourceTransitionProof.skillIdentityMatches||state.shengJiResourceTransitionProof.delta!==1)
	      throw Error('SHENGJI_NATIVE_RESOURCE_SEMANTICS_REJECTED');
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_shengji_zhiLiao_child_completed',snapshot:state.shengJiResourceTransitionProof}))}catch{}
	    }
	    if(responseChildOwner){responseChildOwner.useCardChildrenCompleted++;const selected=responseChildOwner.options.get(responseChildOwner.delivery?.optionId);if(selected?.kind==='view_as_skill')responseChildOwner.nativeSkillEffectProof={childName:event.name,skillId:event.skill||null,cardName:event.card?.name||null,xiBie:get.xiBie(event.card),materialIsSource:Array.isArray(event.cards)&&event.cards.length===1&&event.cards[0]===selected.material,materialStillInHand:event.player?.getCards('h').includes(selected.material)===true,guiHuoBefore:responseChildOwner.yinYangBaseline.guiHuo,guiHuoAfter:event.player?.countZhiShiWu('guiHuo')??null,targetCount:Array.isArray(event.targets)?event.targets.length:null,targetSeatId:event.targets?.[0]?.playerid||null,gameMeAbsent:game.me===null}}
	    if(responseChildOwner?.options.get(responseChildOwner.delivery?.optionId)?.kind==='view_as_skill'){
	     const proof=responseChildOwner.nativeSkillEffectProof,queue=[{event,depth:0}],seen=new Set(),tree=[];
	     while(queue.length&&tree.length<48){const item=queue.shift(),node=item?.event;if(!node||seen.has(node)||item.depth>8)continue;seen.add(node);
	      const safeName=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value)?value:null;
	      tree.push({eventName:safeName(node.name),eventStep:Number.isSafeInteger(node.step)?node.step:null,parentEventName:safeName(node.parent?.name)});
	      if(Array.isArray(node.next))for(const child of node.next)if(child&&typeof child==='object')queue.push({event:child,depth:item.depth+1})}
	     proof.parentEventName=event.parent?.name||null;proof.parentEventInstanceMatches=event.parent===responseChildOwner.event;proof.eventStep=Number.isSafeInteger(event.step)?event.step:null;proof.nativeEffectEventTree=tree;proof.nativeSkillTriggerTrace=responseChildOwner.nativeSkillTriggerTrace||[];proof.nativeSkillTriggerTraceOverflow=responseChildOwner.nativeSkillTriggerTraceOverflow===true}
	    if(responseEvent){
	     const gate=event.__v2ManagedResponseGate;recordNativeResponse(event,'completed');
	     if(gate?.delivery?.status==='applying'){
	      const selected=gate.options.get(gate.delivery.optionId),shape=gate.optionShapes[gate.delivery.optionId];
	      const targetProof=shape==='native_single_target_card'?Array.isArray(event.result?.targets)&&event.result.targets.length===1&&event.result.targets[0]===selected?.target:
	       shape==='native_notarget_card'&&selected?.target===null&&get.info(get.autoViewAs(selected.card))?.notarget===true&&Array.isArray(event.result?.targets)&&event.result.targets.length===0;
	      const valid=event.result?.bool===true&&selected?.kind==='view_as_skill'?event.result.skill==='yinYangZhanHuan'&&
	       Array.isArray(event.result.cards)&&event.result.cards.length===1&&event.result.cards[0]===selected.material&&
	       event.result.card?.name===selected.virtualCard.name&&event.result.card?.xiBie===selected.virtualCard.xiBie&&event.result.card?.isCard===true&&
	       Array.isArray(event.result.targets)&&event.result.targets.length===1&&event.result.targets[0]===selected.target&&
	       !event.player.getCards(event.position||'hs').includes(selected.material)&&gate.useCardChildrenStarted===1&&gate.useCardChildrenCompleted===1&&
	       gate.nativeSkillEffectProof?.childName==='useCard'&&gate.nativeSkillEffectProof.skillId==='yinYangZhanHuan'&&
	       gate.nativeSkillEffectProof.materialIsSource===true&&gate.nativeSkillEffectProof.materialStillInHand===false&&
	       gate.nativeSkillEffectProof.cardName===selected.virtualCard.name&&gate.nativeSkillEffectProof.xiBie===get.xiBie(selected.material)&&
	       Number.isSafeInteger(gate.nativeSkillEffectProof.guiHuoAfter)&&gate.nativeSkillEffectProof.guiHuoAfter>gate.nativeSkillEffectProof.guiHuoBefore&&
	       gate.nativeSkillEffectProof.targetCount===1&&gate.nativeSkillEffectProof.targetSeatId===selected.target.playerid&&gate.nativeSkillEffectProof.gameMeAbsent===true:
	       event.result?.bool===true&&selected?.kind==='card'?event.result.cards?.includes(selected.card)&&
	       !event.player.getCards(event.position||'hs').includes(selected.card)&&gate.useCardChildrenStarted===1&&gate.useCardChildrenCompleted===1&&targetProof:
	       event.result?.bool===false&&selected?.kind==='decline'&&event.forced!==true&&gate.useCardChildrenStarted===0&&
	       (event.result?.targets===undefined||(Array.isArray(event.result.targets)&&event.result.targets.length===0));
	      if(!valid){const skillProof=selected?.kind==='view_as_skill'?{skillId:event.result?.skill||null,physicalMaterialMatches:Array.isArray(event.result?.cards)&&event.result.cards.length===1&&event.result.cards[0]===selected.material,
	       virtualNameMatches:event.result?.card?.name===selected.virtualCard.name,virtualXiBieMatchesNativeViewAs:event.result?.card?.xiBie===selected.virtualCard.xiBie,virtualIsCard:event.result?.card?.isCard===true,
	       materialConsumed:!event.player.getCards(event.position||'hs').includes(selected.material),nativeChildName:gate.nativeSkillEffectProof?.childName||null,
	       nativeChildSkillMatches:gate.nativeSkillEffectProof?.skillId==='yinYangZhanHuan',nativeChildMaterialMatches:gate.nativeSkillEffectProof?.materialIsSource===true,
	       nativeChildMaterialConsumed:gate.nativeSkillEffectProof?.materialStillInHand===false,nativeChildXiBieMatches:gate.nativeSkillEffectProof?.xiBie===get.xiBie(selected.material),
	       guiHuoIncreased:Number.isSafeInteger(gate.nativeSkillEffectProof?.guiHuoAfter)&&gate.nativeSkillEffectProof.guiHuoAfter>gate.nativeSkillEffectProof.guiHuoBefore,
	       nativeTargetMatches:gate.nativeSkillEffectProof?.targetSeatId===selected.target.playerid,nativeGameMeAbsent:gate.nativeSkillEffectProof?.gameMeAbsent===true}:null;
	       const proof={nativeEventId:gate.nativeEventId,seatId:gate.seatId,resultBool:event.result?.bool===true?true:event.result?.bool===false?false:null,
	       resultTargetsIsArray:Array.isArray(event.result?.targets),resultTargetCount:Array.isArray(event.result?.targets)?event.result.targets.length:null,
	       forced:event.forced===true,selectedKind:selected?.kind||null,useCardChildrenStarted:gate.useCardChildrenStarted,useCardChildrenCompleted:gate.useCardChildrenCompleted,
	       targetProof:Boolean(targetProof),...(skillProof?{skillProof}:{}),gameMeAbsent:game.me===null};
	       try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_completion_proof_rejected',snapshot:proof}))}catch{}
	       emit('native_response_completion_proof_rejected',proof);throw Error('NATIVE_RESPONSE_COMPLETION_PROOF_REJECTED')}
	      const nativeCompletionOrdinal=(state.nativeResponseCompletionOrdinal||0)+1;if(!Number.isSafeInteger(nativeCompletionOrdinal)||nativeCompletionOrdinal>1000000)throw Error('NATIVE_RESPONSE_COMPLETION_SEQUENCE_EXHAUSTED');state.nativeResponseCompletionOrdinal=nativeCompletionOrdinal;
	      gate.status='applied';gate.delivery.status='applied';gate.completedResult={nativeCompletionOrdinal,bool:event.result.bool,selectedKind:selected.kind,
	       ...(selected.kind==='card'?{cardName:selected.card?.name||null}:{}),targetSeatId:selected.target?.playerid||null,targetCount:event.result?.targets?.length||0,
	       useCardChildrenStarted:gate.useCardChildrenStarted,useCardChildrenCompleted:gate.useCardChildrenCompleted,
	      ...(selected.kind==='view_as_skill'?{skillId:selected.skillId,physicalMaterialConsumed:gate.nativeSkillEffectProof.materialStillInHand===false,
	       xiBieApplied:gate.nativeSkillEffectProof.xiBie===get.xiBie(selected.material),resolvedXiBie:gate.nativeSkillEffectProof.xiBie,
	       guiHuoDelta:gate.nativeSkillEffectProof.guiHuoAfter-gate.nativeSkillEffectProof.guiHuoBefore,
	       nativeUseCardChild:{eventName:gate.nativeSkillEffectProof.childName,eventStep:gate.nativeSkillEffectProof.eventStep,
	        parentEventName:gate.nativeSkillEffectProof.parentEventName,parentEventInstanceMatchesResponse:gate.nativeSkillEffectProof.parentEventInstanceMatches,
	        effectEventTree:gate.nativeSkillEffectProof.nativeEffectEventTree,nativeSkillTriggerTrace:gate.nativeSkillEffectProof.nativeSkillTriggerTrace,
	        nativeSkillTriggerTraceOverflow:gate.nativeSkillEffectProof.nativeSkillTriggerTraceOverflow}}: {})};
	      try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_response_applied',snapshot:{nativeEventId:gate.nativeEventId,
	       seatId:gate.seatId,eventName:event.name,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,
	       ...gate.completedResult,gameMeAbsent:game.me===null}}))}catch{}
	     }
	    }
	    if(event===state.nativeUseCardChildEvent&&state.nativeAction){state.nativeAction.nativeUseCardChildCompleted=true;state.nativeAction.nativeUseCardChildStep=Number.isSafeInteger(event.step)?event.step:null;state.nativeAction.nativeUseCardChildName=event.name||null;state.nativeUseCardChildName=event.name||null;emit('native_useCard_child_completed')}
	    if(${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")}==='use_card_child_throws'&&event===state.nativeUseCardChildEvent){const action=state.nativeAction,mapping=window.__v2ManagedNativeActionOptions?.get(action?.optionId),player=event.player;action.status='uncertain';action.childEventName=event.name;action.childEventStep=event.step;action.cardInHandAtFailure=Boolean(mapping&&player.getCards('h').includes(mapping.card));action.nativeUseCardHistoryEntries=player.getHistory('useCard').filter(item=>item===event).length;state.failureCode='NATIVE_USE_CARD_CHILD_FAILED';emit('native_useCard_child_exception');throw Error('INJECTED_USE_CARD_CHILD_SETTLEMENT_EXCEPTION')}
	    return value
	   })
	  };
	  GameEvent.prototype.waitNext=function(...args){
	   const event=this;
	   const phaseOverLedger=(${JSON.stringify(process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1")})&&event===state.phaseLoop&&[2,3].includes(event.step)?completionLedgerForRoot():null;
	   const phaseOverEventInstanceId=phaseOverLedger?registerNativeEventInstance(event,phaseOverLedger):null;
	   const phaseOverWaitContext=phaseOverLedger?Object.freeze({
	    event,rootInstanceId:state.rootInstanceId,ownerEventInstanceId:phaseOverEventInstanceId,
	    entryStep:event.step,triggerOrdinal:state.nativePhaseOverTriggerCount||0,draft:state.nativePhaseOverDispatchDraft||null,
	    completionOrdinal:completionLedgerForRoot()?.completionOrdinal??null}):null;
	   if(phaseOverLedger&&!phaseOverEventInstanceId)throw Error('NATIVE_PHASE_OVER_OWNER_EVENT_ID_MISSING');
	   if(phaseOverWaitContext){const draft=phaseOverWaitContext.draft,ledger=state.nativeEventCompletionLedger;try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'phase_over_wait_next_entered',snapshot:{eventName:event.name,eventStep:phaseOverWaitContext.entryStep,
	    rootInstanceId:phaseOverWaitContext.rootInstanceId,ownerEventInstanceId:phaseOverWaitContext.ownerEventInstanceId,
	    managerRootEventName:manager.rootEvent?.name||null,
	    managerRootEventInstanceId:ledger?.eventIds.get(manager.rootEvent)||null,stateRootEventInstanceId:ledger?.eventIds.get(state.root)||null,
	    managerEventStackRootName:manager.eventStack[0]?.name||null,managerEventStackRootInstanceId:ledger?.eventIds.get(manager.eventStack[0])||null,
	    eventInstanceId:ledger?.eventIds.get(event)||null,eventParentName:event.parent?.name||null,eventParentInstanceId:ledger?.eventIds.get(event.parent)||null,
	    managerRootIsStateRoot:manager.rootEvent===state.root,phaseLoopIdentityMatches:event===state.phaseLoop,
	    triggerOrdinal:phaseOverWaitContext.triggerOrdinal,draftPresent:Boolean(draft),draftRootMatches:draft?.rootInstanceId===phaseOverWaitContext.rootInstanceId,
	    draftOwnerMatches:draft?.phaseLoopEvent===event,draftOwnerEventInstanceId:draft?.ownerEventInstanceId||null,draftSeatId:draft?.seatId||null,
	    draftOwnerStep:Number.isSafeInteger(draft?.ownerEventStep)?draft.ownerEventStep:null,draftTriggerOrdinal:Number.isSafeInteger(draft?.triggerOrdinal)?draft.triggerOrdinal:null,
	    nativeCompletionOrdinal:phaseOverWaitContext.completionOrdinal}}))}catch{}}
	   if(phaseOverWaitContext&&!phaseOverWaitContext.draft)throw Error('NATIVE_PHASE_OVER_DRAFT_MISSING');
	   if(event.name==='gameDraw')state.drawEntered=true;
	   if(${JSON.stringify(process.env.V2_NATIVE_QUOTA_RESET_AUDIT === "1")}&&event.name==='xingDong'&&event.step===1){
	    const player=event.player,ledger=completionLedgerForRoot(),eventInstanceId=ledger?.eventIds.get(event)||null;
	    const snapshot={eventName:event.name,eventStep:event.step,parentEventName:event.parent?.name||null,seatId:player?.playerid||null,
	     eventInstanceId,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:Boolean(state.root&&manager.rootEvent===state.root),
	     quotas:{gongJiOrFaShu:Number.isSafeInteger(player?.storage?.gongJiOrFaShu)?player.storage.gongJiOrFaShu:null,
	      faShu:Number.isSafeInteger(player?.storage?.faShu)?player.storage.faShu:null,gongJi:Number.isSafeInteger(player?.storage?.gongJi)?player.storage.gongJi:null,
	      extraXingDongCount:Array.isArray(player?.storage?.extraXingDong)?player.storage.extraXingDong.length:null},gameMeAbsent:game.me===null};
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_xingDong_step0_completed',snapshot}))}catch{}
	   }
	   if(event===state.phaseLoop&&event.step===3&&!phaseOverWaitContext){const diagnostic=snapshot();try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'phase_over_wait_next_entered',snapshot:{eventName:diagnostic.eventName,eventStep:diagnostic.eventStep,parentEventName:diagnostic.parentEventName,rootInstanceId:diagnostic.rootInstanceId,rootObjectMatches:diagnostic.rootObjectMatches,phaseLoopIdentityMatches:diagnostic.phaseLoopIdentityMatches,phaseOverTriggerCount:diagnostic.phaseOverTriggerCount,phaseOverDraftPresent:diagnostic.phaseOverDraftPresent,phaseOverDraftRootMatches:diagnostic.phaseOverDraftRootMatches,phaseOverDraftOwnerMatches:diagnostic.phaseOverDraftOwnerMatches,phaseOverDraftSeatId:diagnostic.phaseOverDraftSeatId,phaseOverDraftStep:diagnostic.phaseOverDraftStep,phaseOverDraftOrdinal:diagnostic.phaseOverDraftOrdinal,hostPlayerAbsent:diagnostic.hostPlayerAbsent}}))}catch{}}
	   emit('wait_next_begin');
	   return originalWaitNext.apply(this,args).then(async value=>{
	    state.lastSuccessfulEventStep={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null};
	    if(${JSON.stringify(process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1")}&&phaseOverWaitContext&&phaseOverWaitContext.event===event&&event.step===3){
	     const draft=phaseOverWaitContext.draft,ledger=completionLedgerForRoot();
	     if(!draft)throw Error('NATIVE_PHASE_OVER_DRAFT_MISSING');
	     if(draft.phaseLoopEvent!==event)throw Error('NATIVE_PHASE_OVER_OWNER_INSTANCE_MISMATCH');
	     if(draft.rootInstanceId!==phaseOverWaitContext.rootInstanceId||draft.rootInstanceId!==state.rootInstanceId)throw Error('NATIVE_PHASE_OVER_ROOT_MISMATCH');
	     if(draft.ownerEventInstanceId!==phaseOverWaitContext.ownerEventInstanceId)throw Error('NATIVE_PHASE_OVER_OWNER_EVENT_MISMATCH');
	     if(draft.triggerOrdinal!==phaseOverWaitContext.triggerOrdinal||draft.triggerOrdinal!==state.nativePhaseOverTriggerCount)throw Error('NATIVE_PHASE_OVER_ORDINAL_MISMATCH');
	     if(draft.triggerName!=='phaseOver'||draft.ownerEventStep!==2)throw Error('NATIVE_PHASE_OVER_SOURCE_STEP_MISMATCH');
	     if(!ledger||ledger.rootEvent!==state.root||ledger.rootInstanceId!==state.rootInstanceId)throw Error('NATIVE_PHASE_OVER_LEDGER_ROOT_MISMATCH');
	     const phaseEvent=draft.phaseEvent,phaseProof=phaseEvent&&ledger.completionEvidence.get(phaseEvent);
	     if(!phaseEvent||phaseEvent!==draft.phaseEvent||phaseEvent.name!=='phase'||phaseEvent.parent!==event||!event.childEvents?.includes(phaseEvent)||
	      phaseEvent.finished!==true||phaseEvent.player?.playerid!==draft.seatId||ledger.eventIds.get(phaseEvent)!==draft.phaseEventInstanceId||
	      !phaseProof||phaseProof.rootInstanceId!==state.rootInstanceId||phaseProof.eventInstanceId!==draft.phaseEventInstanceId||
	      phaseProof.parentEventInstanceId!==draft.ownerEventInstanceId||phaseProof.eventName!=='phase'||phaseProof.seatId!==draft.seatId||
	      phaseProof.completionOrdinal!==draft.phaseCompletionOrdinal||phaseProof.completionOrdinal>ledger.completionOrdinal)throw Error('NATIVE_PHASE_OVER_PHASE_COMPLETION_MISSING');
	     const expectedNextActor=game.players.includes(phaseEvent.player?.next)?phaseEvent.player.next:game.findNext(phaseEvent.player?.next);
	     if(!expectedNextActor||event.player!==expectedNextActor)throw Error('NATIVE_PHASE_OVER_NEXT_ACTOR_MISMATCH');
	     let childCompletionOrdinal=null;
	     if(draft.childEventInstanceId!==null){
	      const child=draft.childEvent,proof=child&&ledger.completionEvidence.get(child);
	      if(!child||child!==state.nativePhaseOverTriggerEvent||child.finished!==true||child.parent!==event||!event.childEvents?.includes(child)||
	       !proof||proof.eventInstanceId!==draft.childEventInstanceId||proof.parentEventInstanceId!==draft.ownerEventInstanceId||proof.eventName!==draft.childEventName)
	       throw Error('NATIVE_PHASE_OVER_CHILD_COMPLETION_MISSING');
	      childCompletionOrdinal=proof.completionOrdinal;
	     }else if(state.nativePhaseOverTriggerEvent!==null)throw Error('NATIVE_PHASE_OVER_UNEXPECTED_CHILD');
	     if(event._triggering&&event._triggering.finished!==true)throw Error('NATIVE_PHASE_OVER_TRIGGER_STILL_PENDING');
	     state.nativePhaseOverDispatchOwner=event;
	     state.nativePhaseOverDispatchEvidence=Object.freeze({kind:'native_phase_over_dispatch_v1',rootInstanceId:draft.rootInstanceId,
	      ownerEventInstanceId:draft.ownerEventInstanceId,ownerEventName:draft.ownerEventName,ownerEventStep:draft.ownerEventStep,
	      triggerOrdinal:draft.triggerOrdinal,triggerName:draft.triggerName,seatId:draft.seatId,
	      phaseEventInstanceId:draft.phaseEventInstanceId,phaseCompletionOrdinal:draft.phaseCompletionOrdinal,
	      childEventInstanceId:draft.childEventInstanceId,childEventName:draft.childEventName,
	      childParentEventInstanceId:draft.childParentEventInstanceId,childCompletionOrdinal});
	    }
	    if(event===state.inputEvent&&state.nativeAction?.eventId===event.__v2NativeEventId&&state.nativeAction.useResultCount===1){
	     const mapping=window.__v2ManagedNativeActionOptions.get(state.nativeAction.optionId);
	     state.nativeAction.nativeChildWaitCompleted=true;state.nativeAction.nativeEventInstanceMatches=event===state.nativeInputResumeGate?.event;
	     state.nativeAction.nativeEventStepAfterWait=Number.isSafeInteger(event.step)?event.step:null;
	     state.nativeAction.cardInHandAfterNativeWait=Boolean(mapping&&event.player.getCards('h').includes(mapping.card));
	     state.nativeAction.cardPositionAfterNativeWait=mapping?get.position(mapping.card):null;state.nativeAction.status='native_child_wait_completed';
	     emit('native_action_child_wait_completed');
	    }
	   if(${JSON.stringify(process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1")}&&event.name==='phaseLoop'){
	    const children=Array.isArray(event.childEvents)?event.childEvents:[],completedChild=[...children].reverse().find(child=>child?.finished===true),
	     phaseOverDispatch=state.nativePhaseOverDispatchEvidence||null,priorBoundary=state.nativePhaseBoundaryFence||null,
	     phaseLoopCompletionLedger=completionLedgerForRoot(),phaseChild=[...children].reverse().find(child=>child?.name==='phase'&&child?.finished===true&&child.parent===event&&
	      (event.step===3&&phaseOverDispatch?phaseLoopCompletionLedger?.eventIds.get(child)===phaseOverDispatch.phaseEventInstanceId:child.player===event.player)),
	     pendingChildren=children.filter(child=>child?.finished!==true).length+(Array.isArray(event.next)?event.next.filter(child=>child&&child.finished!==true).length:0);
	    const phaseBoundary=event.step===1&&phaseChild?.parent===event&&pendingChildren===0;
	    const phaseOverChild=state.nativePhaseOverTriggerEvent||null;
	    const phaseOverChildCompletion=phaseOverChild?completionLedgerForRoot()?.completionEvidence.get(phaseOverChild)||null:null;
	    const phaseOverTriggerComplete=Boolean(phaseOverDispatch&&phaseOverDispatch.rootInstanceId===state.rootInstanceId&&
	     state.nativePhaseOverDispatchOwner===event&&phaseOverDispatch.seatId===phaseChild?.player?.playerid&&phaseOverDispatch.triggerName==='phaseOver'&&
	     phaseOverDispatch.phaseEventInstanceId===phaseLoopCompletionLedger?.eventIds.get(phaseChild)&&
	     phaseOverDispatch.phaseCompletionOrdinal===phaseLoopCompletionLedger?.completionEvidence.get(phaseChild)?.completionOrdinal&&
	     phaseOverDispatch.triggerOrdinal===state.nativePhaseOverTriggerCount&&
	     (phaseOverDispatch.childEventInstanceId===null?phaseOverChild===null&&phaseOverDispatch.childCompletionOrdinal===null:
	      phaseOverChild?.finished===true&&phaseOverChild.parent===event&&phaseOverChildCompletion?.eventInstanceId===phaseOverDispatch.childEventInstanceId&&
	      phaseOverChildCompletion.completionOrdinal===phaseOverDispatch.childCompletionOrdinal&&
	      phaseOverDispatch.childParentEventInstanceId===phaseOverDispatch.ownerEventInstanceId)&&
	     (phaseOverDispatch.childEventInstanceId===null||phaseOverChildCompletion?.parentEventInstanceId===phaseOverDispatch.ownerEventInstanceId));
	    const phaseOverTriggerFresh=state.nativePhaseOverTriggerCount>(priorBoundary?.phaseOverTriggerCount||0)&&
	     phaseOverDispatch!==priorBoundary?.phaseOverDispatchEvidence&&phaseOverDispatch?.seatId===phaseChild?.player?.playerid;
	    const phaseOverBoundary=event.step===3&&phaseChild?.parent===event&&phaseOverTriggerFresh&&phaseOverTriggerComplete&&pendingChildren===0;
	    const completedActor=phaseChild?.player||null,completedActorQuotas={gongJiOrFaShu:Number.isSafeInteger(completedActor?.storage?.gongJiOrFaShu)?completedActor.storage.gongJiOrFaShu:null,
	     faShu:Number.isSafeInteger(completedActor?.storage?.faShu)?completedActor.storage.faShu:null,
	     gongJi:Number.isSafeInteger(completedActor?.storage?.gongJi)?completedActor.storage.gongJi:null,
	     extraXingDongCount:Array.isArray(completedActor?.storage?.extraXingDong)?completedActor.storage.extraXingDong.length:null};
	    const snapshot={boundary:'phaseLoop_wait_next_after_child',isCompletedPhaseBoundary:phaseBoundary,isCompletedPhaseOverBoundary:phaseOverBoundary,
	     phaseOverTriggerCount:state.nativePhaseOverTriggerCount||0,phaseOverTriggerComplete,phaseOverDispatchEvidence:phaseOverDispatch?{
	      kind:phaseOverDispatch.kind,rootInstanceId:phaseOverDispatch.rootInstanceId,ownerEventInstanceId:phaseOverDispatch.ownerEventInstanceId,
	      ownerEventName:phaseOverDispatch.ownerEventName,ownerEventStep:phaseOverDispatch.ownerEventStep,
	      triggerOrdinal:phaseOverDispatch.triggerOrdinal,triggerName:phaseOverDispatch.triggerName,
	      seatId:phaseOverDispatch.seatId,phaseEventInstanceId:phaseOverDispatch.phaseEventInstanceId,phaseCompletionOrdinal:phaseOverDispatch.phaseCompletionOrdinal,
	      childEventInstanceId:phaseOverDispatch.childEventInstanceId,childEventName:phaseOverDispatch.childEventName,
	      childParentEventInstanceId:phaseOverDispatch.childParentEventInstanceId,childCompletionOrdinal:phaseOverDispatch.childCompletionOrdinal}:null,
	     phaseOverTriggerEventName:phaseOverChild?.name||null,
	     phaseOverTriggerEventFinished:phaseOverChild?.finished===true,phaseOverTriggerEventParentMatches:phaseOverChild?.parent===event,
	     eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,
	     phaseOverWaitEntryStep:phaseOverWaitContext?.entryStep??null,
	     phaseOverWaitOwnerEventInstanceId:phaseOverWaitContext?.ownerEventInstanceId||null,
	     phaseOverWaitTriggerOrdinal:phaseOverWaitContext?.triggerOrdinal??null,
	     phaseOverWaitDraftPresent:Boolean(phaseOverWaitContext?.draft),
	     loopSeatId:event.player?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,currentPhaseSeatId:_status.currentPhase?.playerid||null,
	     completedChildName:completedChild?.name||null,completedChildFinished:completedChild?.finished===true,completedChildParentMatches:completedChild?.parent===event,
	     completedPhaseChildName:phaseChild?.name||null,completedPhaseChildFinished:phaseChild?.finished===true,completedPhaseChildParentMatches:phaseChild?.parent===event,
	     completedPhaseSeatId:phaseChild?.player?.playerid||null,
	     completedChildSeatId:completedChild?.player?.playerid||null,completedChildStep:Number.isSafeInteger(completedChild?.step)?completedChild.step:null,
	     pendingChildCount:pendingChildren,childEventCount:children.length,nextCount:Array.isArray(event.next)?event.next.length:null,
	     eventStack:manager.eventStack.map(item=>item.name||null),eventStackTop:manager.eventStack.at(-1)?.name||null,
	     phaseNumber:Number.isSafeInteger(game.phaseNumber)?game.phaseNumber:null,roundNumber:Number.isSafeInteger(game.roundNumber)?game.roundNumber:null,
	     completedActorQuotas,
	     rootEventName:manager.rootEvent?.name||null,rootInstanceId:state.rootInstanceId||null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,
	     nativeCompletionOrdinal:completionLedgerForRoot()?.completionOrdinal??null,nativeCompletionEvidence:completionLedgerForRoot()?.completionEvidence.get(phaseChild)||null,
	     priorAuthorityFence:state.nativeParentContinuationFence?{status:state.nativeParentContinuationFence.status||null,releaseCount:state.nativeParentContinuationFence.releaseCount||0,
	      nativeEventId:state.nativeParentContinuationFence.nativeEventId||null,releaseResolution:state.nativeParentContinuationFence.releaseResolution||null}:null,
	     gameMeAbsent:game.me===null,connectedTransports:game.players.filter(player=>player.ws).length};
	    state.nativePhaseLoopBoundaryAudit??=[];state.nativePhaseLoopBoundaryAudit.push(snapshot);if(state.nativePhaseLoopBoundaryAudit.length>8)state.nativePhaseLoopBoundaryAudit.shift();
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_phase_loop_wait_next_boundary',snapshot}))}catch{}
	    const boundaryOrdinal=(state.nativePhaseBoundaryFences?.length||0)+1;
	    const firstCaptureBoundary=boundaryOrdinal===1&&!priorBoundary;
	    const secondCaptureBoundary=multiTurnCapture&&boundaryOrdinal===2&&priorBoundary?.status==='released'&&phaseChild?.player!==priorBoundary.seatPlayer;
	    const thirdCaptureBoundary=event6Continuation&&multiTurnCapture&&boundaryOrdinal===3&&priorBoundary?.status==='released'&&
	     priorBoundary.boundaryOrdinal===2&&phaseChild?.player?.playerid!==priorBoundary.seatId&&state.event5AuthorityAccepted===true&&
	     priorBoundary.releaseResolution?.eventSequence===5;
	    const fourthCaptureBoundary=event7Continuation&&multiTurnCapture&&boundaryOrdinal===4&&priorBoundary?.status==='released'&&
	     priorBoundary.boundaryOrdinal===3&&phaseChild?.player?.playerid!==priorBoundary.seatId&&state.event6AuthorityAccepted===true&&
	     priorBoundary.releaseResolution?.eventSequence===6;
	    const fifthCaptureBoundary=event8Continuation&&multiTurnCapture&&boundaryOrdinal===5&&priorBoundary?.status==='released'&&
	     priorBoundary.boundaryOrdinal===4&&phaseChild?.player?.playerid!==priorBoundary.seatId&&state.event7AuthorityAccepted===true&&
	     priorBoundary.releaseResolution?.eventSequence===7;
	    if(${JSON.stringify(process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1")}&&phaseOverBoundary&&
	     (!priorBoundary||priorBoundary.status==='released')&&(firstCaptureBoundary||secondCaptureBoundary||thirdCaptureBoundary||fourthCaptureBoundary||fifthCaptureBoundary)){
	     const actionEvent=state.inputEvent,action=state.nativeAction,authority=window.__v2ManagedGame?.authorityState;
	     const pendingDescendants=(root)=>{const seen=new WeakSet();let pending=0,nodes=0,overflow=false;const walk=node=>{if(!node||typeof node!=='object'||seen.has(node))return;seen.add(node);if(++nodes>4096){overflow=true;return}if(node!==root&&node.finished!==true)pending++;for(const child of [...(Array.isArray(node.childEvents)?node.childEvents:[]),...(Array.isArray(node.next)?node.next:[])])walk(child)};walk(root);return {pending,nodes,overflow}};
	     const descendants=pendingDescendants(event),priorFence=state.nativeParentContinuationFence;
	     const skillActionComplete=action?.actionKind==='native_skill'&&action.skillId==='jiRi_moBaoChongJie'&&action.nativeUseSkillChildCompleted===true&&
	      action.nativeTargetChoiceCompleted===true&&action.nativeChangeZhanJiCompleted===true&&action.nativeChangeZhanJiAfter===action.nativeChangeZhanJiBefore+1,
	      physicalActionComplete=action?.actionKind!=='native_skill'&&action?.nativeUseCardChildCompleted===true;
	     const firstFenceValid=firstCaptureBoundary&&actionEvent&&action&&action.eventId===actionEvent.__v2NativeEventId&&action.useResultCount===1&&
	      action.nativeChildWaitCompleted===true&&(skillActionComplete||physicalActionComplete)&&priorFence?.status==='released'&&priorFence.releaseCount===1&&
	      priorFence.nativeEventId===action.eventId&&phaseChild?.player===_status.firstAct&&state.nativePhaseOverTriggerCount===1;
	     const secondFenceValid=secondCaptureBoundary&&priorBoundary?.phaseOverDispatchEvidence!==phaseOverDispatch&&
	      state.nativePhaseOverTriggerCount>priorBoundary.phaseOverTriggerCount&&phaseChild?.player?.playerid!==_status.firstAct?.playerid;
	     const thirdFenceValid=thirdCaptureBoundary&&actionEvent&&action&&action.eventId===actionEvent.__v2NativeEventId&&
	      actionEvent.__v2NativeEventId===state.nativeEvent6Candidate?.nativeEventId&&action.seatId===state.nativeEvent6Candidate?.seatId&&
	      action.useResultCount===1&&action.nativeChildWaitCompleted===true&&action.nativeUseCardChildCompleted===true&&
	      priorBoundary?.releaseCount===1&&priorBoundary.releaseResolution?.eventSequence===5&&
	      phaseChild?.player?.playerid===state.nativeEvent6Candidate?.seatId&&state.nativePhaseOverTriggerCount>priorBoundary.phaseOverTriggerCount;
	     const fourthFenceValid=fourthCaptureBoundary&&actionEvent&&action&&action.eventId===actionEvent.__v2NativeEventId&&
	      actionEvent.__v2NativeEventId===state.nativeEvent7Candidate?.nativeEventId&&action.seatId===state.nativeEvent7Candidate?.seatId&&
	      action.useResultCount===1&&action.nativeChildWaitCompleted===true&&action.nativeUseCardChildCompleted===true&&
	      priorBoundary?.releaseCount===1&&priorBoundary.releaseResolution?.eventSequence===6&&
	      phaseChild?.player?.playerid===state.nativeEvent7Candidate?.seatId&&state.nativePhaseOverTriggerCount>priorBoundary.phaseOverTriggerCount;
	     const fifthFenceValid=fifthCaptureBoundary&&actionEvent&&action&&action.eventId===actionEvent.__v2NativeEventId&&
	      actionEvent.__v2NativeEventId===state.nativeEvent8Candidate?.nativeEventId&&action.seatId===state.nativeEvent8Candidate?.seatId&&
	      action.useResultCount===1&&action.nativeChildWaitCompleted===true&&action.nativeUseCardChildCompleted===true&&
	      priorBoundary?.releaseCount===1&&priorBoundary.releaseResolution?.eventSequence===7&&
	      phaseChild?.player?.playerid===state.nativeEvent8Candidate?.seatId&&state.nativePhaseOverTriggerCount>priorBoundary.phaseOverTriggerCount;
	     const expectedAuthorityRevision=fifthCaptureBoundary?7:fourthCaptureBoundary?6:thirdCaptureBoundary?5:4;
	     const fenceChecks={firstFenceValid,secondFenceValid,thirdFenceValid,fourthFenceValid,fifthFenceValid,localAuthorityRevision:Number.isSafeInteger(authority?.revision)?authority.revision:null,
	      boundaryOrdinal,firstCaptureBoundary,secondCaptureBoundary,thirdCaptureBoundary,fourthCaptureBoundary,fifthCaptureBoundary,actionPresent:Boolean(action),actionEventMatches:Boolean(action&&actionEvent&&action.eventId===actionEvent.__v2NativeEventId),
	      useResultCount:action?.useResultCount??null,nativeChildWaitCompleted:action?.nativeChildWaitCompleted===true,
	      nativeUseCardChildCompleted:action?.nativeUseCardChildCompleted===true,nativeUseSkillChildCompleted:action?.nativeUseSkillChildCompleted===true,
	      nativeTargetChoiceCompleted:action?.nativeTargetChoiceCompleted===true,nativeChangeZhanJiCompleted:action?.nativeChangeZhanJiCompleted===true,
	      priorFenceStatus:priorFence?.status||null,priorFenceReleaseCount:priorFence?.releaseCount??null,
	      priorFenceEventMatches:Boolean(priorFence&&action&&priorFence.nativeEventId===action.eventId),phaseActorIsFirstAct:phaseChild?.player===_status.firstAct,
	      phaseOverTriggerCount:state.nativePhaseOverTriggerCount??0,phaseOverDispatchOwnerMatches:state.nativePhaseOverDispatchOwner===event,
	      phaseOverOwnerStep:phaseOverDispatch?.ownerEventStep??null,pendingDescendantCount:descendants.pending,descendantOverflow:descendants.overflow,
	      rootMatches:manager.rootEvent===state.root&&Boolean(state.root),gameMeAbsent:game.me===null,connectedTransportCount:game.players.filter(player=>player.ws).length,
	      currentPhaseAbsent:_status.currentPhase==null,openingDigestMatches:Boolean(firstCaptureBoundary&&window.__v2ManagedOpeningDraw?.authorityDigest===priorFence?.releaseResolution?.afterDigest),
	      previousBoundaryWasEvent4:Boolean(secondCaptureBoundary&&priorBoundary?.releaseResolution?.eventSequence===4),previousBoundaryWasEvent5:Boolean(thirdCaptureBoundary&&priorBoundary?.releaseResolution?.eventSequence===5)};
	    if((!firstFenceValid&&!secondFenceValid&&!thirdFenceValid&&!fourthFenceValid&&!fifthFenceValid)||authority?.revision!==expectedAuthorityRevision||
	      firstCaptureBoundary&&window.__v2ManagedOpeningDraw?.authorityDigest!==priorFence?.releaseResolution?.afterDigest||
	      secondCaptureBoundary&&priorBoundary?.releaseResolution?.eventSequence!==4||
	      thirdCaptureBoundary&&priorBoundary?.releaseResolution?.eventSequence!==5||
	      fourthCaptureBoundary&&priorBoundary?.releaseResolution?.eventSequence!==6||fifthCaptureBoundary&&priorBoundary?.releaseResolution?.eventSequence!==7||
	      event!==state.phaseLoop||event.step!==3||!phaseChild||!phaseOverTriggerComplete||
	      phaseOverDispatch?.ownerEventStep!==2||descendants.overflow||descendants.pending!==0||
	      manager.rootEvent!==state.root||!state.root||game.me!==null||game.players.some(player=>player.ws)||_status.currentPhase!=null){
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_phase_boundary_fence_precondition_rejected',snapshot:fenceChecks}))}catch{}
	     throw Error('NATIVE_PHASE_BOUNDARY_FENCE_PRECONDITION_REJECTED');
	    }
	    let releaseBoundary;const wait=new Promise(resolve=>{releaseBoundary=resolve});
	    const completionLedger=completionLedgerForRoot(),completedPhaseEvidence=completionLedger?.completionEvidence.get(phaseChild),
	     completedPhaseOverEvidence=phaseOverDispatch;
	    if(!completionLedger||completionLedger.rootEvent!==state.root||completionLedger.rootInstanceId!==state.rootInstanceId||
	     !Number.isSafeInteger(completionLedger.completionOrdinal)||completionLedger.completionOrdinal<1||!completedPhaseEvidence||!completedPhaseOverEvidence||
	     completedPhaseEvidence.rootInstanceId!==state.rootInstanceId||completedPhaseEvidence.eventName!=='phase'||
	     completedPhaseEvidence.parentEventName!=='phaseLoop'||completedPhaseEvidence.seatId!==phaseChild.player?.playerid||
	     completedPhaseEvidence.completionOrdinal>completionLedger.completionOrdinal||completedPhaseOverEvidence.rootInstanceId!==state.rootInstanceId||
	     completedPhaseOverEvidence.kind!=='native_phase_over_dispatch_v1'||completedPhaseOverEvidence.ownerEventInstanceId!==completedPhaseEvidence.parentEventInstanceId||
			completedPhaseOverEvidence.ownerEventName!=='phaseLoop'||completedPhaseOverEvidence.ownerEventStep!==2||completedPhaseOverEvidence.seatId!==phaseChild.player?.playerid||
	     completedPhaseOverEvidence.phaseEventInstanceId!==completedPhaseEvidence.eventInstanceId||
	     completedPhaseOverEvidence.phaseCompletionOrdinal!==completedPhaseEvidence.completionOrdinal||
	     completedPhaseOverEvidence.triggerOrdinal!==state.nativePhaseOverTriggerCount||
	     completedPhaseOverEvidence.childEventInstanceId===null&&(completedPhaseOverEvidence.childEventName!==null||completedPhaseOverEvidence.childCompletionOrdinal!==null)||
	     completedPhaseOverEvidence.childEventInstanceId!==null&&(!phaseOverChildCompletion||
	      phaseOverChildCompletion.parentEventInstanceId!==completedPhaseOverEvidence.ownerEventInstanceId||
	      phaseOverChildCompletion.completionOrdinal!==completedPhaseOverEvidence.childCompletionOrdinal||
	      completedPhaseOverEvidence.childEventName!==phaseOverChildCompletion.eventName))
	     throw Error('NATIVE_EVENT_COMPLETION_EVIDENCE_MISSING');
	     const fence={status:'waiting',releaseCount:0,nativeEventId:action?.eventId||completedPhaseEvidence.eventInstanceId,seatId:phaseChild.player?.playerid||null,
	     boundaryOrdinal,rootInstanceId:state.rootInstanceId,rootEvent:state.root,phaseLoopEvent:event,completedPhaseEvent:phaseChild,phaseOverDispatchEvidence:phaseOverDispatch,
	      seatPlayer:phaseChild.player,nextActorSeatId:event.player?.playerid||null,
	     phaseLoopStep:event.step,phaseOverTriggerCount:state.nativePhaseOverTriggerCount,phaseOverTriggerComplete,
	     nativeCompletionOrdinal:completionLedger.completionOrdinal,completionEvidence:completedPhaseEvidence,phaseOverCompletionEvidence:completedPhaseOverEvidence,
	      priorAuthority:Object.freeze(fifthCaptureBoundary?{eventSequence:7,stateRevision:7,afterDigest:window.__v2ManagedOpeningDraw?.authorityDigest||null}:
	       fourthCaptureBoundary?{eventSequence:6,stateRevision:6,afterDigest:window.__v2ManagedOpeningDraw?.authorityDigest||null}:
	       thirdCaptureBoundary?{eventSequence:5,stateRevision:5,afterDigest:window.__v2ManagedOpeningDraw?.authorityDigest||null}:
	       {eventSequence:4,stateRevision:4,afterDigest:firstCaptureBoundary?priorFence.releaseResolution.afterDigest:window.__v2ManagedOpeningDraw?.authorityDigest||null}),
	      descendantNodeCount:descendants.nodes,pendingDescendantCount:descendants.pending,promise:wait,resolve:releaseBoundary};
	     state.nativePhaseBoundaryFence=fence;
	     state.nativePhaseBoundaryFences??=[];state.nativePhaseBoundaryFences.push(fence);
	     const waiting={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,
	      status:fence.status,nativeEventId:fence.nativeEventId,seatId:fence.seatId,rootInstanceId:fence.rootInstanceId,
	      boundaryOrdinal:fence.boundaryOrdinal,phaseLoopStep:fence.phaseLoopStep,phaseOverTriggerCount:state.nativePhaseOverTriggerCount,phaseOverTriggerComplete,
	      nativeCompletionOrdinal:fence.nativeCompletionOrdinal,completionEvidence:fence.completionEvidence,phaseOverCompletionEvidence:fence.phaseOverCompletionEvidence,
	      phaseOverTriggerEventName:phaseOverChild?.name||null,phaseOverTriggerEventFinished:phaseOverChild?.finished===true,
	     phaseOverTriggerEventParentMatches:phaseOverChild?.parent===event,
	      completedPhaseFinished:phaseChild.finished===true,completedPhaseParentMatches:phaseChild.parent===event,
	      descendantNodeCount:fence.descendantNodeCount,pendingDescendantCount:fence.pendingDescendantCount,
	      priorAuthority:fence.priorAuthority,roundNumber:Number.isSafeInteger(game.roundNumber)?game.roundNumber:null,
	      phaseNumber:Number.isSafeInteger(game.phaseNumber)?game.phaseNumber:null,loopSeatId:event.player?.playerid||null,
	      completedPhaseSeatId:phaseChild.player?.playerid||null,
	      completedPhasePlayerPhaseNumber:Number.isSafeInteger(phaseChild.player?.phaseNumber)?phaseChild.player.phaseNumber:null,
	      nextActorSeatId:event.player?.playerid||null,
	      completedActorQuotas,runtimeHujiaMethodPresent:game.players.some(player=>typeof player.changeHujia==='function'),
	      runtimeHujiaValuePresent:game.players.some(player=>player.hujia!==undefined),
	      runtimeHujiaPrototypeOwnerCount:game.players.reduce((sum,player)=>{let count=0,proto=Object.getPrototypeOf(player),depth=0;while(proto&&depth++<16){if(Object.hasOwn(proto,'changeHujia'))count++;proto=Object.getPrototypeOf(proto)}return sum+count},0),
	      firstActSeatId:_status.firstAct?.playerid||null,currentPhaseSeatId:_status.currentPhase?.playerid||null,
	      rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null,connectedTransports:game.players.filter(player=>player.ws).length};
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_phase_boundary_fence_waiting',snapshot:waiting}))}catch{}
			const release=await fence.promise;
			const acceptedBoundaryAuthority=fence.boundaryOrdinal>=2?fence.acceptedAuthority:fence.priorAuthority;
			if(fence.status!=='accepted'||fence.releaseCount!==1||release?.accepted!==true||
			 release.nativeEventId!==fence.nativeEventId||release.rootInstanceId!==fence.rootInstanceId||release.seatId!==fence.seatId||
			 release.eventSequence!==acceptedBoundaryAuthority?.eventSequence||release.stateRevision!==acceptedBoundaryAuthority?.stateRevision||release.afterDigest!==acceptedBoundaryAuthority?.afterDigest||
			 manager.rootEvent!==fence.rootEvent||event!==fence.phaseLoopEvent||event.step!==3||phaseChild!==fence.completedPhaseEvent||
				state.nativePhaseOverTriggerCount!==fence.phaseOverTriggerCount||fence.boundaryOrdinal===1&&fence.phaseOverTriggerCount!==1||
					fence.boundaryOrdinal===2&&fence.phaseOverTriggerCount<2||fence.boundaryOrdinal===3&&fence.phaseOverTriggerCount<3||
					fence.boundaryOrdinal===4&&fence.phaseOverTriggerCount<4||fence.boundaryOrdinal===5&&fence.phaseOverTriggerCount<5||fence.phaseOverTriggerComplete!==true||
			 fence.phaseOverDispatchEvidence!==state.nativePhaseOverDispatchEvidence||
			 state.nativeAction?.eventId!==fence.nativeEventId||authority?.revision!==acceptedBoundaryAuthority?.stateRevision||
			 window.__v2ManagedOpeningDraw?.authorityDigest!==acceptedBoundaryAuthority?.afterDigest)throw Error('NATIVE_PHASE_BOUNDARY_FENCE_RELEASE_REJECTED');
			fence.status='released';fence.releaseResolution=Object.freeze({eventSequence:acceptedBoundaryAuthority.eventSequence,
			 stateRevision:acceptedBoundaryAuthority.stateRevision,afterDigest:acceptedBoundaryAuthority.afterDigest});
			if(fence.boundaryOrdinal===2&&acceptedBoundaryAuthority.eventSequence===5&&event6Continuation){
			 state.event5AuthorityAccepted=true;state.event5ActorSeatId=fence.seatId;state.event6ManagedGateOpened=false;
			 state.priorNativeInputGate=state.nativeInputGate;state.nativeInputGate=null;state.nativeInputResumeGate=null;state.inputEvent=null;
				 state.nextSeatInputProbeArmed=true;state.nextSeatInputStartObserved=false;state.nextSeatInputLoopObserved=false;
			}
			if(fence.boundaryOrdinal===3&&acceptedBoundaryAuthority.eventSequence===6&&event7Continuation){
				state.event6AuthorityAccepted=true;state.event6ActorSeatId=fence.seatId;state.event7ManagedGateOpened=false;
				state.priorNativeInputGate=state.nativeInputGate;state.nativeInputGate=null;state.nativeInputResumeGate=null;state.inputEvent=null;
				state.nextSeatInputProbeArmed=true;state.nextSeatInputStartObserved=false;state.nextSeatInputLoopObserved=false;
			}
			if(fence.boundaryOrdinal===4&&acceptedBoundaryAuthority.eventSequence===7&&event8Continuation){
				state.event7AuthorityAccepted=true;state.event7ActorSeatId=fence.seatId;state.event8ManagedGateOpened=false;
				state.priorNativeInputGate=state.nativeInputGate;state.nativeInputGate=null;state.nativeInputResumeGate=null;state.inputEvent=null;
				state.nextSeatInputProbeArmed=true;state.nextSeatInputStartObserved=false;state.nextSeatInputLoopObserved=false;
			}
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_phase_boundary_fence_released',snapshot:{status:fence.status,
	      releaseCount:fence.releaseCount,nativeEventId:fence.nativeEventId,seatId:fence.seatId,rootInstanceId:fence.rootInstanceId,
	      releaseResolution:fence.releaseResolution,rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}
	    }
	   }
	   if(${JSON.stringify(process.env.V2_NATIVE_PARENT_FENCE_AUDIT === "1")}&&event.name==='xingDong'){
	    const completedChild=[...(event.childEvents||[])].reverse().find(child=>child.action===true&&child.finished===true),player=event.player;
	    const snapshot={boundary:'parent_wait_next_child_completed',parentEventName:event.name,parentEventStep:Number.isSafeInteger(event.step)?event.step:null,parentFinished:event.finished===true,
	     seatId:player?.playerid||null,completedChildName:completedChild?.name||null,completedChildStep:Number.isSafeInteger(completedChild?.step)?completedChild.step:null,
	     completedChildFinished:completedChild?.finished===true,completedChildParentMatches:completedChild?.parent===event,parentNextCount:Array.isArray(event.next)?event.next.length:null,
	     quotas:{gongJiOrFaShu:Number.isSafeInteger(player?.storage?.gongJiOrFaShu)?player.storage.gongJiOrFaShu:null,faShu:Number.isSafeInteger(player?.storage?.faShu)?player.storage.faShu:null,
	      gongJi:Number.isSafeInteger(player?.storage?.gongJi)?player.storage.gongJi:null,extraXingDongCount:Array.isArray(player?.storage?.extraXingDong)?player.storage.extraXingDong.length:null},
	     rootObjectMatches:state.root?manager.rootEvent===state.root:null,gameMeAbsent:game.me===null};
	    state.nativeParentFenceAudit=snapshot;try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_parent_action_child_wait_completed',snapshot}))}catch{}
	   }
	   if(${JSON.stringify(process.env.V2_NATIVE_PARENT_FENCE === "1")}&&event.name==='xingDong'&&event===state.inputEvent?.parent&&
	    !state.nativeParentContinuationFence){
	    const actionEvent=state.inputEvent,completedChild=[...(event.childEvents||[])].reverse().find(child=>child===actionEvent),action=state.nativeAction,
	     skillActionComplete=action?.actionKind==='native_skill'&&action.skillId==='jiRi_moBaoChongJie'&&action.nativeUseSkillChildCompleted===true&&
	      action.nativeTargetChoiceCompleted===true&&action.nativeChangeZhanJiCompleted===true,
	     physicalActionComplete=action?.actionKind!=='native_skill'&&action?.nativeUseCardChildCompleted===true;
	    if(!completedChild||completedChild.finished!==true||completedChild.parent!==event||!state.nativeActionCompletionReported||
	     action?.eventId!==actionEvent.__v2NativeEventId||action.useResultCount!==1||
	     action.nativeChildWaitCompleted!==true||(!skillActionComplete&&!physicalActionComplete)||
	     !state.root||manager.rootEvent!==state.root||game.me!==null||game.players.some(player=>player.ws))throw Error('NATIVE_PARENT_FENCE_PRECONDITION_REJECTED');
	    if(state.nativeParentContinuationFence)throw Error('NATIVE_PARENT_FENCE_DUPLICATE_REJECTED');
	    let releaseFence;const wait=new Promise(resolve=>{releaseFence=resolve});
	    const fence={status:'waiting',releaseCount:0,nativeEventId:actionEvent.__v2NativeEventId,seatId:actionEvent.player?.playerid||null,
	     parentEvent:event,actionEvent,rootEvent:state.root,rootInstanceId:state.rootInstanceId||null,
	     parentEventName:event.name,parentEventStep:Number.isSafeInteger(event.step)?event.step:null,
	     completedChildName:completedChild.name||null,completedChildStep:Number.isSafeInteger(completedChild.step)?completedChild.step:null,
	     completedChildFinished:completedChild.finished===true,completedChildParentMatches:completedChild.parent===event,
	     parentNextCount:Array.isArray(event.next)?event.next.length:null,
	     quotas:{gongJiOrFaShu:Number.isSafeInteger(event.player?.storage?.gongJiOrFaShu)?event.player.storage.gongJiOrFaShu:null,
	      faShu:Number.isSafeInteger(event.player?.storage?.faShu)?event.player.storage.faShu:null,
	      gongJi:Number.isSafeInteger(event.player?.storage?.gongJi)?event.player.storage.gongJi:null,
	      extraXingDongCount:Array.isArray(event.player?.storage?.extraXingDong)?event.player.storage.extraXingDong.length:null},
	     promise:wait,resolve:releaseFence};
	    state.nativeParentContinuationFence=fence;
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_parent_fence_waiting',snapshot:{status:fence.status,
	     nativeEventId:fence.nativeEventId,seatId:fence.seatId,parentEventName:fence.parentEventName,parentEventStep:fence.parentEventStep,
	     completedChildName:fence.completedChildName,completedChildStep:fence.completedChildStep,completedChildFinished:fence.completedChildFinished,
			     completedChildParentMatches:fence.completedChildParentMatches,parentNextCount:fence.parentNextCount,quotas:fence.quotas,
			     rootInstanceId:fence.rootInstanceId,rootObjectMatches:manager.rootEvent===fence.rootEvent,gameMeAbsent:game.me===null,
			     connectedTransports:game.players.filter(player=>player.ws).length,paused:Boolean(_status.paused)}}))}catch{}
	    const accepted=await fence.promise;
	    if(fence.status!=='accepted'||accepted?.accepted!==true||accepted.nativeEventId!==fence.nativeEventId||
	     accepted.eventSequence!==4||accepted.stateRevision!==4||!/^([a-f0-9]{64})$/.test(accepted.afterDigest||''))throw Error('NATIVE_PARENT_FENCE_RELEASE_REJECTED');
	    fence.status='released';fence.releaseResolution=Object.freeze({eventSequence:accepted.eventSequence,stateRevision:accepted.stateRevision,afterDigest:accepted.afterDigest});
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_parent_fence_released',snapshot:{status:fence.status,
	     nativeEventId:fence.nativeEventId,seatId:fence.seatId,parentEventName:event.name,parentEventStep:Number.isSafeInteger(event.step)?event.step:null,
	     releaseCount:fence.releaseCount,releaseResolution:fence.releaseResolution,rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}
	   }
	   emit('wait_next_end');return value},error=>{const name=typeof error?.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error.name)?error.name:'Error',message=typeof error?.message==='string'?error.message:'';const nullProperty=/^Cannot read properties of (null|undefined) \(reading '([A-Za-z_$][A-Za-z0-9_$]{0,48})'\)$/.exec(message),notFunction=/^([A-Za-z_$][A-Za-z0-9_$]{0,48}) is not a function$/.exec(message),reference=/^([A-Za-z_$][A-Za-z0-9_$]{0,48}) is not defined$/.exec(message),code=/^[A-Z][A-Z0-9_]{0,80}$/.test(message)?message:null;state.nativeWaitError={name,...(nullProperty?{nullBase:nullProperty[1],property:nullProperty[2]}:{}),...(notFunction?{notFunction:notFunction[1]}:{}),...(reference?{referenceIdentifier:reference[1]}:{}),...(code?{code}:{})};state.failureCode='NATIVE_WAIT_NEXT_REJECTED';emit('wait_next_error');throw error})};
	 const completedActionStart=GameEvent.prototype.start;
	 GameEvent.prototype.start=function(...args){const event=this;
	  if(multiTurnInputGateProbe&&state.nextSeatInputProbeArmed===true&&event.name==='gongJiOrFaShu'&&event.player!==_status.firstAct&&!state.nextSeatInputStartObserved){
	   state.nextSeatInputStartObserved=true;try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_next_seat_action_start_observed',snapshot:{eventName:event.name,
	    parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,eventAction:event.action===true,isFirstActSeat:event.player===_status.firstAct,
	    gamePhaseNumber:Number.isSafeInteger(game.phaseNumber)?game.phaseNumber:null,playerPhaseNumber:Number.isSafeInteger(event.player?.phaseNumber)?event.player.phaseNumber:null,
	    quotas:{gongJiOrFaShu:Number.isSafeInteger(event.player?.storage?.gongJiOrFaShu)?event.player.storage.gongJiOrFaShu:null,
	     faShu:Number.isSafeInteger(event.player?.storage?.faShu)?event.player.storage.faShu:null,
	     gongJi:Number.isSafeInteger(event.player?.storage?.gongJi)?event.player.storage.gongJi:null,
	     extraXingDongCount:Array.isArray(event.player?.storage?.extraXingDong)?event.player.storage.extraXingDong.length:null},
	    probeArmed:state.nextSeatInputProbeArmed===true,priorGatePresent:Boolean(state.nativeInputGate),rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}
	  }
	  if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1")}&&
	   ['useSkill','jiRi_moBaoChongJie','jiRi_moBaoChongJieContentBefore','chooseToDiscard','changeZhanJi'].includes(event.name)){
	   state.nativeSkillEventTrace??=[];
	   if(state.nativeSkillEventTrace.length>=48)state.nativeSkillEventTrace.shift();
	   {const parentPath=[];for(let parent=event.parent,count=0;parent&&count<8;parent=parent.parent,count++)parentPath.push({
	    eventName:typeof parent.name==='string'?parent.name:null,skillId:typeof parent.skill==='string'?parent.skill:null,eventInstanceMatches:parent===state.nativeUseSkillChildEvent});
	    const trace={eventName:typeof event.name==='string'?event.name:null,eventStep:Number.isSafeInteger(event.step)?event.step:null,
	     parentEventName:typeof event.parent?.name==='string'?event.parent.name:null,skillId:typeof event.skill==='string'?event.skill:null,
	     seatId:typeof event.player?.playerid==='string'?event.player.playerid:null,eventInstanceMatches:event===state.nativeUseSkillChildEvent,
	     nativeActionKind:state.nativeAction?.actionKind||null,nativeUseSkillChildName:state.nativeUseSkillChildEvent?.name||null,
	     parentPath,rootObjectMatches:manager.rootEvent===state.root};state.nativeSkillEventTrace.push(trace);
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_event_starting',snapshot:trace}))}catch{}}
	  }
	  if(${JSON.stringify(process.env.V2_NATIVE_PARENT_FENCE_AUDIT === "1")}&&event.action===true&&event.parent?.name==='xingDong'){
	   const player=event.parent.player;
	   const snapshot={boundary:'next_action_child_start',eventName:event.name||null,eventStep:Number.isSafeInteger(event.step)?event.step:null,
	    eventParentName:event.parent.name,parentEventStep:Number.isSafeInteger(event.parent.step)?event.parent.step:null,parentFinished:event.parent.finished===true,
	    seatId:event.player?.playerid||null,parentSeatId:player?.playerid||null,parentActionChildCount:Array.isArray(event.parent.childEvents)?event.parent.childEvents.filter(child=>child.action===true).length:null,
	    parentCompletedActionChildCount:Array.isArray(event.parent.childEvents)?event.parent.childEvents.filter(child=>child.action===true&&child.finished===true).length:null,
	    parentNextCount:Array.isArray(event.parent.next)?event.parent.next.length:null,parentNextHeadIsEvent:event.parent.next?.[0]===event,
	    priorParentFence:state.nativeParentContinuationFence?{status:state.nativeParentContinuationFence.status||null,
	     releaseCount:state.nativeParentContinuationFence.releaseCount||0,
	     acceptedAuthority:state.nativeParentContinuationFence.acceptedAuthority||null,
	     releaseResolution:state.nativeParentContinuationFence.releaseResolution||null}:null,
	    quotas:{gongJiOrFaShu:Number.isSafeInteger(player?.storage?.gongJiOrFaShu)?player.storage.gongJiOrFaShu:null,faShu:Number.isSafeInteger(player?.storage?.faShu)?player.storage.faShu:null,
	     gongJi:Number.isSafeInteger(player?.storage?.gongJi)?player.storage.gongJi:null,extraXingDongCount:Array.isArray(player?.storage?.extraXingDong)?player.storage.extraXingDong.length:null},
	    rootObjectMatches:state.root?manager.rootEvent===state.root:null,gameMeAbsent:game.me===null};
	   state.nativeParentFenceAudit=snapshot;try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_parent_next_action_child_start',snapshot}))}catch{}
	  }
	  const result=completedActionStart.apply(this,args);if(!result||typeof result.then!=='function')return result;return result.then(value=>{
	  if(event===state.nativeUseSkillChildEvent&&state.nativeAction?.actionKind==='native_skill'){
	   const action=state.nativeAction;if(event.name!=='useSkill'||event.skill!==action.skillId||event.player?.playerid!==action.seatId||event.finished!==true)
	    throw Error('JIRIMO_NATIVE_USE_SKILL_COMPLETION_INVALID');
	   const mapping=window.__v2ManagedNativeActionOptions?.get(action.optionId),material=mapping?.material,actor=event.player;
	   if(!mapping||mapping.kind!=='native_skill'||!material||actor.getCards('h').includes(material)||get.position(material)==='h'||
	    action.nativeChangeZhanJiCompleted!==true||action.nativeTargetChoiceCompleted!==true||action.nativeChangeZhanJiAfter!==action.nativeChangeZhanJiBefore+1)
	    throw Error('JIRIMO_NATIVE_SKILL_EFFECT_COMPLETION_INVALID');
	   action.nativeUseSkillChildCompleted=true;action.nativeUseSkillChildName=event.name;action.nativeUseSkillChildStep=Number.isSafeInteger(event.step)?event.step:null;
	   action.nativeUseSkillChildIdentityMatches=event===state.nativeUseSkillChildEvent;emit('native_useSkill_child_completed');
	  }
	  if(state.nativeAction?.actionKind==='native_skill'&&event.name==='changeZhanJi'){
	   let underJiRi=false;for(let parent=event,count=0;parent&&count<24;parent=parent.parent,count++)if(parent===state.nativeUseSkillChildEvent){underJiRi=true;break}
	   if(underJiRi){const action=state.nativeAction,actor=game.players.find(player=>player.playerid===action.seatId),teamList=actor?.side===true?game.hongZhanJi:game.lanZhanJi,
	    before=state.jiRiZhanJiBaseline?.baoShiCount,after=Array.isArray(teamList)?teamList.filter(value=>value==='baoShi').length:null;
	    if(event.finished!==true||event.num!==1||event.xingShi!=='baoShi'||event.side!==actor?.side||event.yiChu===true||
	     state.jiRiZhanJiBaseline?.seatId!==action.seatId||state.jiRiZhanJiBaseline?.side!==actor?.side||
	     state.jiRiZhanJiBaseline?.rootInstanceId!==state.rootInstanceId||!Number.isSafeInteger(before)||after!==before+1)
	     throw Error('JIRIMO_CHANGE_ZHANJI_COMPLETION_INVALID');
	    const completionLedger=state.nativeEventCompletionLedger,completionProof=completionLedger?.completionEvidence.get(event),lineage=[];
	    for(let current=event.parent,count=0;current&&current!==state.nativeUseSkillChildEvent&&count<24;current=current.parent,count++){
	     const eventInstanceId=completionLedger?.eventIds.get(current),parentEventInstanceId=current.parent&&completionLedger?.eventIds.get(current.parent);
	     if(!eventInstanceId||!parentEventInstanceId)throw Error('JIRIMO_CHANGE_ZHANJI_LINEAGE_INCOMPLETE');
	     lineage.push(Object.freeze({eventInstanceId,eventName:typeof current.name==='string'?current.name:null,parentEventInstanceId}));
	    }
	    const useSkillEventId=completionLedger?.eventIds.get(state.nativeUseSkillChildEvent);
	    if(!completionProof||completionProof.eventName!=='changeZhanJi'||completionProof.rootInstanceId!==state.rootInstanceId||
	     completionProof.eventInstanceId!==completionLedger?.eventIds.get(event)||completionProof.parentEventInstanceId!==completionLedger?.eventIds.get(event.parent)||
	     !useSkillEventId||lineage.length>=24||event.parent!==state.nativeUseSkillChildEvent&&!lineage.length||
	     (lineage.length?lineage.at(-1).parentEventInstanceId:completionProof.parentEventInstanceId)!==useSkillEventId)
	     throw Error('JIRIMO_CHANGE_ZHANJI_COMPLETION_PROOF_INVALID');
	    state.nativeChangeZhanJiEvent=event;action.nativeChangeZhanJiProof=completionProof;action.nativeChangeZhanJiLineage=Object.freeze(lineage);
	    action.nativeChangeZhanJiCompleted=true;action.nativeChangeZhanJiEventName=event.name;action.nativeChangeZhanJiOrdinal=completionProof.completionOrdinal;
	    action.nativeChangeZhanJiBefore=before;action.nativeChangeZhanJiAfter=after;
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_change_zhanji_completed',snapshot:{eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,
	     parentEventName:event.parent?.name||null,seatId:action.seatId,actorSide:actor.side,achievement:'baoShi',beforeCount:before,afterCount:after,
	     nativeUseSkillChildCompleted:action.nativeUseSkillChildCompleted===true,rootObjectMatches:state.root?manager.rootEvent===state.root:null,gameMeAbsent:game.me===null}}))}catch{}
	   }
	  }
	  if(event.__v2ManagedJiRiTargetGate){const targetGate=state.nativeSkillTargetGates?.get(event.__v2ManagedJiRiTargetGate),action=state.nativeAction,
	    targetOption=targetGate?.delivery?.optionId?window.__v2ManagedJiRiTargetOptions?.get(targetGate.delivery.optionId):null;
	   if(!targetGate||targetGate.event!==event||targetGate.status!=='applying'||targetGate.seatId!==event.player?.playerid||event.finished!==true||
	    event.result?.bool!==true||!Array.isArray(event.result?.cards)||event.result.cards.length!==1||event.result.cards[0]!==targetOption?.card||
	    !event.done||event.done.finished!==true||event.player.getCards('h').includes(targetOption.card)||get.position(targetOption.card)!=='d'||
	    !Number.isSafeInteger(targetGate.eligibleCardCount)||targetGate.eligibleCardCount<1||
	    event.player.getCards(event.position||'h').filter(card=>get.type(card,event.player)==='faShu').length!==targetGate.eligibleCardCount-1||
	    action?.nativeUseSkillChildCompleted===true||action?.nativeChangeZhanJiCompleted!==true||!action?.nativeSkillTargetChoiceDelivered)
	    throw Error('JIRIMO_NATIVE_TARGET_CHOICE_COMPLETION_INVALID');
	   targetGate.status='applied';targetGate.delivery.status='applied';action.nativeTargetChoiceCompleted=true;
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_applied',snapshot:{
	     nativeEventId:targetGate.eventId,seatId:targetGate.seatId,choiceId:targetGate.delivery.choiceId,deliveryId:targetGate.delivery.deliveryId,
	     optionId:targetGate.delivery.optionId,eventName:event.name,eventFinished:event.finished===true,
	     resultMatches:event.result?.bool===true&&event.result.cards?.length===1&&event.result.cards[0]===targetOption.card,
	     cardMoved:!event.player.getCards('h').includes(targetOption.card)&&get.position(targetOption.card)==='d',
	     nativeUseSkillChildCompleted:action.nativeUseSkillChildCompleted===true,nativeChangeZhanJiCompleted:action.nativeChangeZhanJiCompleted===true,
	     rootMatches:targetGate.rootInstanceId===state.rootInstanceId,gameMeAbsent:game.me===null}}))}catch{throw Error('JIRIMO_TARGET_APPLIED_ACK_TRACE_FAILED')}
	  }
	  const faultMode=${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")};
	  if(['viewas_partial_effect_throws','viewas_partial_effect_stop'].includes(faultMode)&&event.name==='changeZhiShiWu'&&event.zhiShiWu==='guiHuo'){
	   const gate=[...(state.managedNativeResponseGates?.values()||[])].find(candidate=>{const selected=candidate.delivery?.optionId?candidate.options.get(candidate.delivery.optionId):null;if(candidate.delivery?.status!=='applying'||selected?.kind!=='view_as_skill'||candidate.event?.player!==event.player)return false;for(let parent=event,count=0;parent&&count<24;parent=parent.parent,count++)if(parent===candidate.event)return true;return false});
	   if(gate){const guiHuoAfter=event.player?.countZhiShiWu('guiHuo')??null,guiHuoBefore=gate.yinYangBaseline?.guiHuo??null,partialEffectApplied=Number.isSafeInteger(guiHuoAfter)&&Number.isSafeInteger(guiHuoBefore)&&guiHuoAfter>guiHuoBefore;
	    state.failureCode=faultMode==='viewas_partial_effect_stop'?'NATIVE_VIEWAS_PARTIAL_EFFECT_STOP_TEST':'NATIVE_VIEWAS_PARTIAL_EFFECT_FAILED';
	    const snapshot={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,nativeEventId:gate.nativeEventId,seatId:gate.seatId,
	     partialEffectApplied,guiHuoDelta:Number.isSafeInteger(guiHuoAfter)&&Number.isSafeInteger(guiHuoBefore)?guiHuoAfter-guiHuoBefore:null,
	     useCardChildrenStarted:gate.useCardChildrenStarted,useCardChildrenCompleted:gate.useCardChildrenCompleted,gameMeAbsent:game.me===null,failureCode:state.failureCode};
	    const stage=faultMode==='viewas_partial_effect_stop'?'native_viewas_partial_effect_barrier':'native_viewas_partial_effect_exception';
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage,snapshot}))}catch{}
	    if(!partialEffectApplied)throw Error('NATIVE_VIEWAS_PARTIAL_EFFECT_NOT_OBSERVED');
	    if(faultMode==='viewas_partial_effect_stop')return new Promise(()=>{});
	    throw Error(state.failureCode)
	   }
	  }
	  const action=state.nativeAction,skillActionComplete=action?.actionKind==='native_skill'&&action.nativeUseSkillChildCompleted===true&&action.nativeTargetChoiceCompleted===true&&action.nativeChangeZhanJiCompleted===true,
	   physicalActionComplete=action?.actionKind!=='native_skill'&&action?.nativeUseCardChildCompleted===true;
	  if(event===state.inputEvent&&action?.eventId===event.__v2NativeEventId&&action.useResultCount===1&&action.nativeChildWaitCompleted===true&&
	   (skillActionComplete||physicalActionComplete)&&!state.nativeActionCompletionReported){state.nativeActionCompletionReported=true;const completion={eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,eventFinished:Boolean(event.finished),paused:Boolean(_status.paused),eventStack:manager.eventStack.map(item=>item.name||null),phaseLoopParentName:state.phaseLoop?.parent?.name||null,nativeInputGateStatus:state.nativeInputGate?.status||null,nativeInputGate:state.nativeInputGate?{nativeEventId:state.nativeInputGate.nativeEventId,seatId:state.nativeInputGate.seatId,eventName:state.nativeInputGate.eventName,parentEventName:state.nativeInputGate.parentEventName,status:state.nativeInputGate.status||null,nativeSendCount:state.nativeInputGate.nativeSendCount||0,nativeResumeCount:state.nativeInputGate.nativeResumeCount||0,useResultCount:state.nativeInputGate.useResultCount||0}:null,nativeAction:{eventId:action.eventId,seatId:action.seatId,optionId:action.optionId,status:action.status||null,actionKind:action.actionKind||'physical_card',skillId:action.skillId||null,cardName:action.cardName||null,targetSeatId:action.targetSeatId||null,useResultCount:action.useResultCount,useResultChildName:action.useResultChildName||null,useCardChildName:action.nativeUseCardChildName||null,useCardChildStep:Number.isSafeInteger(action.nativeUseCardChildStep)?action.nativeUseCardChildStep:null,nativeUseCardChildCompleted:action.nativeUseCardChildCompleted===true,nativeUseSkillChildCompleted:action.nativeUseSkillChildCompleted===true,nativeTargetChoiceCompleted:action.nativeTargetChoiceCompleted===true,nativeChangeZhanJiCompleted:action.nativeChangeZhanJiCompleted===true,baoShiBefore:action.nativeChangeZhanJiBefore??null,baoShiAfter:action.nativeChangeZhanJiAfter??null,nativeChildWaitCompleted:true,nativeEventInstanceMatches:action.nativeEventInstanceMatches===true,nativeEventStepAfterWait:action.nativeEventStepAfterWait,cardInHandAfterNativeWait:action.cardInHandAfterNativeWait===true,cardPositionAfterNativeWait:action.cardPositionAfterNativeWait||null,result:action.result?{...action.result}:null},hostPlayerAbsent:game.me===null,connectedTransports:game.players.filter(player=>player.ws).length,seats:game.players.map(player=>({seatId:player.playerid||null,characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')}))};try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_action_event_completed',snapshot:completion}))}catch{}if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") }&&${JSON.stringify(process.env.V2_NATIVE_PARENT_FENCE !== "1")}&&action.actionKind==='native_skill'){state.nativeActionCompletionPause=true;game.pause()}}return value})};
	 GameEvent.prototype.loop=function(...args){
	   if(managedStart){
	    const event=this,step=Number.isSafeInteger(event.step)?event.step:null,seatId=event.player?.playerid||null;
	    if(multiTurnInputGateProbe&&state.nextSeatInputProbeArmed===true&&event.name==='gongJiOrFaShu'&&event.player!==_status.firstAct&&!state.nextSeatInputLoopObserved){
	     state.nextSeatInputLoopObserved=true;let isUnderControl=null;try{isUnderControl=event.player?.isUnderControl?.()===true}catch{}try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_next_seat_action_loop_observed',snapshot:{eventName:event.name,
	      parentEventName:event.parent?.name||null,seatId,eventAction:event.action===true,isFirstActSeat:event.player===_status.firstAct,
	      probeEnabled:multiTurnInputGateProbe,managedStart,managedInputGate,managedInputResume,
	      event5ModeConfigured:${JSON.stringify(message.mode === "managed_opening_root_action_event5")},
	      event5SuccessorGateEligible:multiTurnInputGateProbe&&${JSON.stringify(message.mode === "managed_opening_root_action_event5")}&&
	       state.nextSeatInputProbeArmed===true&&event.player!==_status.firstAct&&state.event5ManagedGateOpened!==true,
	      diagnosticGateEligible:multiTurnInputGateProbe&&state.nextSeatInputProbeArmed===true&&event.player!==_status.firstAct,
	      isUnderControl,autoMode:Boolean(_status.auto),isMine:event.isMine?.()===true,isOnline:event.isOnline?.()===true,
	      probeArmed:state.nextSeatInputProbeArmed===true,priorGatePresent:Boolean(state.nativeInputGate),rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}
	    }
	    if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1")}&&event.name==='chooseToDiscard'){
	     const action=state.nativeAction,mapping=action?.optionId?window.__v2ManagedNativeActionOptions?.get(action.optionId):null;let skillEvent=null;
	     for(let parent=event.parent,count=0;parent&&count<20;parent=parent.parent,count++){if(parent.name==='useSkill'&&parent.skill==='jiRi_moBaoChongJie'){skillEvent=parent;break}}
	     const snapshot={eventName:event.name,eventStep:step,parentEventName:event.parent?.name||null,seatId,
	      actionKind:action?.actionKind||null,skillId:action?.skillId||null,skillEventName:skillEvent?.name||null,skillEventSkill:skillEvent?.skill||null,
	      skillEventIdentityMatches:skillEvent===state.nativeUseSkillChildEvent,mappingKind:mapping?.kind||null,targetSeatMatches:event.player===mapping?.target,
	      targetSeatId:mapping?.target?.playerid||null,actionTargetSeatId:action?.targetSeatId||null,rootObjectMatches:manager.rootEvent===state.root,
	      selectCardIsExactlyOne:(()=>{const value=get.select(event.selectCard);return value?.[0]===1&&value?.[1]===1})(),
	      filterCardIsFunction:typeof event.filterCard==='function',filterOkIsFunction:typeof event.filterOk==='function',
	      hasBackup:Boolean(event._backup),filterOkMatchesBackup:typeof event.filterOk==='function'&&event.filterOk===event._backup?.filterOk,
	      backupFilterOkIsFunction:typeof event._backup?.filterOk==='function',complexSelect:Boolean(event.complexSelect),complexCard:Boolean(event.complexCard),
	      position:event.position==='h'?'h':event.position==='e'?'e':null,rootInstanceMatches:Boolean(state.rootInstanceId),gameMeAbsent:game.me===null};
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_gate_probe',snapshot}))}catch{}
	    }
	    if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1")}&&event.name==='chooseToDiscard'&&!event.__v2ManagedJiRiTargetGate){
	     const action=state.nativeAction,mapping=action?.optionId?window.__v2ManagedNativeActionOptions?.get(action.optionId):null;
	     let skillEvent=null;for(let parent=event.parent,count=0;parent&&count<20;parent=parent.parent,count++){if(parent.name==='useSkill'&&parent.skill==='jiRi_moBaoChongJie'){skillEvent=parent;break}}
	     if(action?.actionKind==='native_skill'&&action.skillId==='jiRi_moBaoChongJie'&&skillEvent===state.nativeUseSkillChildEvent&&
	      mapping?.kind==='native_skill'&&event.player===mapping.target&&event.player?.playerid===mapping.targetSeatId){
	      try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_gate_entered',snapshot:{eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,
	       parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,skillEventIdentityMatches:skillEvent===state.nativeUseSkillChildEvent,
	       mappingKind:mapping.kind,targetSeatMatches:event.player===mapping.target,gameMeAbsent:game.me===null}}))}catch{}
	      const range=get.select(event.selectCard),filterOkIsNativeBackup=typeof event.filterOk==='function'&&event.filterOk===event._backup?.filterOk;
	      if(range?.[0]!==1||range?.[1]!==1||typeof event.filterCard!=='function'||
	       (typeof event.filterOk==='function'&&!filterOkIsNativeBackup)||event.complexSelect||event.complexCard){
	       try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_choice_rejected',snapshot:{failureCode:'JIRIMO_NATIVE_TARGET_CHOICE_SHAPE_UNSUPPORTED',
	        eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,
	        filterOkIsFunction:typeof event.filterOk==='function',filterOkMatchesBackup:filterOkIsNativeBackup,hasBackup:Boolean(event._backup),
	        backupFilterOkIsFunction:typeof event._backup?.filterOk==='function',complexSelect:Boolean(event.complexSelect),complexCard:Boolean(event.complexCard),gameMeAbsent:game.me===null}}))}catch{}
	       throw Error('JIRIMO_NATIVE_TARGET_CHOICE_SHAPE_UNSUPPORTED');
	      }
	      const options=new Map(),optionKinds={};let targetCards=[],faShuCards=[],filterPassingCards=[],legalCards=[];
	      try{targetCards=event.player.getCards(event.position||'h');for(const card of targetCards){if(get.type(card,event.player)!=='faShu')continue;faShuCards.push(card);
	       if(event.filterCard(card,event.player,event)!==true)continue;filterPassingCards.push(card);if(lib.filter.cardDiscardable(card,event.player,event))legalCards.push(card)}}
	      catch{try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_choice_rejected',snapshot:{failureCode:'JIRIMO_NATIVE_TARGET_FILTER_EXCEPTION',
	       eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,
	       targetCardCount:targetCards.length,faShuCardCount:faShuCards.length,filterPassingCardCount:filterPassingCards.length,discardableCardCount:legalCards.length,gameMeAbsent:game.me===null}}))}catch{}
	       throw Error('JIRIMO_NATIVE_TARGET_FILTER_EXCEPTION')}
	      if(!legalCards.length){try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_choice_rejected',snapshot:{failureCode:'JIRIMO_NATIVE_TARGET_CHOICE_NO_LEGAL_CARD',
	       eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,seatId:event.player?.playerid||null,
	       targetCardCount:targetCards.length,faShuCardCount:faShuCards.length,filterPassingCardCount:filterPassingCards.length,discardableCardCount:legalCards.length,gameMeAbsent:game.me===null}}))}catch{}
	       throw Error('JIRIMO_NATIVE_TARGET_CHOICE_NO_LEGAL_CARD')}
	      if(legalCards.length>32)throw Error('JIRIMO_NATIVE_TARGET_CHOICE_CAPACITY_REJECTED');
	      for(const card of legalCards){const bytes=crypto.getRandomValues(new Uint8Array(16)),optionId='native_option_'+Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
	       options.set(optionId,Object.freeze({card,event,seatId:event.player.playerid,target:event.player}));optionKinds[optionId]='physical_faShu_discard'}
	      const eventBytes=crypto.getRandomValues(new Uint8Array(16)),nativeEventId='native_event_'+Array.from(eventBytes,value=>value.toString(16).padStart(2,'0')).join(''),gate={eventId:nativeEventId,event,seatId:event.player.playerid,
	       sourceSeatId:action.seatId,actionEventId:action.eventId,rootInstanceId:state.rootInstanceId,skillEvent,status:'open',optionIds:[...options.keys()],optionKinds,eligibleCardCount:legalCards.length,delivery:null};
	      state.nativeSkillTargetGates.set(nativeEventId,gate);window.__v2ManagedJiRiTargetOptions=options;event.__v2ManagedJiRiTargetGate=nativeEventId;
	      event.isOnline=()=>true;event.send=function(){try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_send_entered',snapshot:{eventStep:Number.isSafeInteger(event.step)?event.step:null,seatId:event.player?.playerid||null,gateStatus:gate.status,gateSent:gate.sent===true,sameEvent:this===gate.event,gameMeAbsent:game.me===null}}))}catch{}
	       if(this!==gate.event||gate.status!=='open'||gate.sent)throw Error('JIRIMO_NATIVE_TARGET_CHOICE_DUPLICATE_SEND_REJECTED');
	       gate.sent=true;gate.status='waiting';try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_choice_candidates',snapshot:{nativeEventId,
	        actionEventId:gate.actionEventId,skillEventName:skillEvent.name||null,skillEventParentName:skillEvent.parent?.name||null,eventName:event.name,eventStep:Number.isSafeInteger(event.step)?event.step:null,
	        parentEventName:event.parent?.name||null,seatId:gate.seatId,sourceSeatId:gate.sourceSeatId,eventInstanceMatches:true,rootInstanceId:state.rootInstanceId||null,
	        optionIds:gate.optionIds,optionKinds,optionCount:gate.optionIds.length,deadlineMs:3000,gameMeAbsent:game.me===null}}))}catch{}game.pause();
	      };
	     }
	    }
	    if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1")}&&event.name==='chooseToDiscard'&&event.__v2ManagedJiRiTargetGate){
	     const targetGate=state.nativeSkillTargetGates?.get(event.__v2ManagedJiRiTargetGate);
	     if(event.__v2ManagedJiRiTargetLastTraceStep!==step){event.__v2ManagedJiRiTargetLastTraceStep=step;
	      try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_target_loop',snapshot:{eventStep:step,seatId:event.player?.playerid||null,
	       gateStatus:targetGate?.status||null,isMine:event.isMine?.()===true,isOnline:event.isOnline?.()===true,
	       forced:event.forced===true,gateSent:targetGate?.sent===true,hasOwnSend:Object.hasOwn(event,'send'),isMine:event.isMine?.()===true,isOnline:event.isOnline?.()===true,
	       autochooseFunctionPresent:typeof event.autochoose==='function',resultKind:event.result===null?'null':Array.isArray(event.result)?'array':typeof event.result,
	       paused:Boolean(_status.paused),gameMeAbsent:game.me===null}}))}catch{}
	     }
	    }
	    const activeResponseGate=event.name==='useCard'&&event.parent?.name==='yingZhan'?event.parent.__v2ManagedResponseGate:null;
	    const selectedResponse=activeResponseGate?.delivery?.optionId?activeResponseGate.options.get(activeResponseGate.delivery.optionId):null;
	    if(${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")}==='viewas_useCard_child_throws'&&activeResponseGate?.delivery?.status==='applying'&&
	     selectedResponse?.kind==='view_as_skill'&&activeResponseGate.event===event.parent&&activeResponseGate.seatId===event.player?.playerid){
	     state.failureCode='NATIVE_VIEWAS_USE_CARD_CHILD_FAILED';
	     const failure={eventName:event.name,eventStep:step,parentEventName:event.parent?.name||null,nativeEventId:activeResponseGate.nativeEventId,seatId,
	      useCardChildrenStarted:activeResponseGate.useCardChildrenStarted,useCardChildrenCompleted:activeResponseGate.useCardChildrenCompleted,
	      responseResultAssigned:event.parent.result?.bool===true,gameMeAbsent:game.me===null,failureCode:state.failureCode};
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_viewas_useCard_child_exception',snapshot:failure}))}catch{}
	     throw Error(state.failureCode)
	    }
	    if(${process.env.V2_NATIVE_YINYANG_VIEWAS_PROBE === "1"}&&event.name==='yingZhan'&&event.player?.playerid===state.yinyangFixtureSeatId&&!state.yinyangSkillProbe?.nativeContractProbe){
	     const skill=lib.skill.yinYangZhanHuan,info=skill,physical=event.player.getCards('h').find(card=>get.type(card)==='gongJi'&&get.mingGe(card)===get.mingGe(event.card));
	     let virtual=null,nativeEventFilterAccepted=false,materialFilterAccepted=false,engineSkillEnabled=false,nativeSkillExpanded=false,nativeEventEnableMatches=false,nativeSkillFilterAccepted=false,nativeCardEnabled=false,legalTargetCount=0,probeError=null;
	     try{nativeSkillExpanded=game.expandSkills(event.player.getSkills(false).concat(lib.skill.global)).includes('yinYangZhanHuan');nativeEventEnableMatches=Array.isArray(info.enable)?info.enable.includes(event.name):info.enable===event.name;nativeSkillFilterAccepted=info.filter.call(info,event,event.player)===true;engineSkillEnabled=lib.filter.filterEnable(event,event.player,'yinYangZhanHuan')===true;materialFilterAccepted=skill.filterCard.call(skill,physical,event.player)===true;virtual=skill.viewAs.call(skill,[physical],event.player);nativeEventFilterAccepted=Boolean(virtual&&event.filterCard(virtual,event.player,event));nativeCardEnabled=Boolean(virtual&&lib.filter.cardEnabled(virtual,event.player,'forceEnable'));if(virtual)for(const target of game.players){if(event.filterTarget(virtual,event.player,target)&&lib.filter.targetEnabled(virtual,event.player,target))legalTargetCount++}}
	     catch(error){probeError=String(error?.message||'native-contract-error').slice(0,96)}
	     const virtualShape=virtual&&typeof virtual==='object'?{hasName:typeof virtual.name==='string',xiBieMatchesIncoming:virtual.xiBie===get.xiBie(event.card),isCard:virtual.isCard===true,containsPhysicalMaterials:Array.isArray(virtual.cards),hasSkillField:Object.hasOwn(virtual,'skill'),hasSourceSkillField:Object.hasOwn(virtual,'sourceSkill')}:null;
	     const probe={eventName:event.name,eventContent:nativeResponseContentNames.get(event)||null,enableValues:Array.isArray(info.enable)?info.enable.filter(value=>typeof value==='string').slice(0,8):typeof info.enable==='string'?[info.enable]:[],hasSkill:event.player.hasSkill('yinYangZhanHuan'),nativeSkillExpanded,nativeEventEnableMatches,nativeSkillFilterAccepted,engineSkillEnabled,materialFilterAccepted,nativeEventFilterAccepted,nativeCardEnabled,legalTargetCount,virtualShape,viewAsFilterPresent:typeof skill.viewAsFilter==='function',nativeUiCandidateEnumerationObserved:false,probeError};
	     probe.contractAccepted=!probeError&&nativeEventEnableMatches&&nativeSkillFilterAccepted&&materialFilterAccepted&&nativeEventFilterAccepted&&nativeCardEnabled&&legalTargetCount>0&&virtualShape?.xiBieMatchesIncoming===true&&virtualShape?.isCard===true;state.yinyangSkillProbe.nativeContractProbe=probe;
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_yinyang_viewas_contract_probe',snapshot:probe}))}catch{}
	    }
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
	   const event5SuccessorGate=multiTurnInputGateProbe&&${JSON.stringify(message.mode === "managed_opening_root_action_event5")}&&
	    state.nextSeatInputProbeArmed===true&&this.player!==_status.firstAct&&state.event5ManagedGateOpened!==true;
	   const event6SuccessorGate=event6Continuation&&state.event5AuthorityAccepted===true&&state.nextSeatInputProbeArmed===true&&
	    this.player!==state.event5ActorSeatId&&state.event6ManagedGateOpened!==true;
	   const event7SuccessorGate=event7Continuation&&state.event6AuthorityAccepted===true&&state.nextSeatInputProbeArmed===true&&
	    this.player!==state.event6ActorSeatId&&state.event7ManagedGateOpened!==true;
	   const event8SuccessorGate=event8Continuation&&state.event7AuthorityAccepted===true&&state.nextSeatInputProbeArmed===true&&
	    this.player!==state.event7ActorSeatId&&state.event8ManagedGateOpened!==true;
	   if(event7Continuation&&state.event6AuthorityAccepted===true&&state.nextSeatInputProbeArmed===true&&
	    (state.event7GateDiagnosticCount||0)<8){state.event7GateDiagnosticCount=(state.event7GateDiagnosticCount||0)+1;
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'event7_successor_gate_decision',snapshot:{eventName:this.name,
	     eventStep:Number.isSafeInteger(this.step)?this.step:null,parentEventName:this.parent?.name||null,seatId:this.player?.playerid||null,
	     eventSequence:state.nativeInputGate?.eventSequence??null,event6AuthorityAccepted:state.event6AuthorityAccepted===true,
	     event6ActorSeatId:state.event6ActorSeatId||null,nextSeatInputProbeArmed:state.nextSeatInputProbeArmed===true,
	     event7ManagedGateOpened:state.event7ManagedGateOpened===true,event7Continuation,gateSelected:event7SuccessorGate,
	     rootObjectMatches:state.root?manager.rootEvent===state.root:null,gameMeAbsent:game.me===null}}))}catch{}}
	   const diagnosticNextSeatGate=multiTurnInputGateProbe&&state.nextSeatInputProbeArmed===true&&this.player!==_status.firstAct&&!event5SuccessorGate&&!event6SuccessorGate&&!event7SuccessorGate&&!event8SuccessorGate;
	   if(multiTurnInputGateProbe&&this.name==='gongJiOrFaShu'&&(state.nativeNextSeatGateDecisionCount||0)<16){
	    state.nativeNextSeatGateDecisionCount=(state.nativeNextSeatGateDecisionCount||0)+1;
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_next_seat_gate_decision',snapshot:{eventName:this.name,
	     eventStep:Number.isSafeInteger(this.step)?this.step:null,parentEventName:this.parent?.name||null,seatId:this.player?.playerid||null,
	     action:this.action===true,firstActSeatId:_status.firstAct?.playerid||null,managedInputGate,managedInputResume,managedInputController,
	     multiTurnInputGateProbe,nextSeatInputProbeArmed:state.nextSeatInputProbeArmed===true,priorGatePresent:Boolean(state.nativeInputGate),
	     event5Mode:${JSON.stringify(message.mode === "managed_opening_root_action_event5")},event5ManagedGateOpened:state.event5ManagedGateOpened===true,
	     event5SuccessorGate,diagnosticNextSeatGate,rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}
	   }
	   if(multiTurnInputGateProbe&&this.name==='gongJiOrFaShu')emit('native_next_seat_gate_evaluated');
	   if((managedInputGate||managedInputResume)&&(!state.nativeInputGate||diagnosticNextSeatGate)&&this.name==='gongJiOrFaShu'&&
	    (this.player===_status.firstAct||diagnosticNextSeatGate||event5SuccessorGate||event6SuccessorGate||event7SuccessorGate||event8SuccessorGate)&&this.action===true){
	    if(multiTurnInputGateProbe&&(state.nativeNextSeatGateSelectedCount||0)<8){
	     state.nativeNextSeatGateSelectedCount=(state.nativeNextSeatGateSelectedCount||0)+1;
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_next_seat_gate_selected',snapshot:{eventName:this.name,
	      eventStep:Number.isSafeInteger(this.step)?this.step:null,parentEventName:this.parent?.name||null,seatId:this.player?.playerid||null,
	      event5SuccessorGate,diagnosticNextSeatGate,priorGatePresent:Boolean(state.nativeInputGate),event5ManagedGateOpened:state.event5ManagedGateOpened===true,
	      rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}
	    }
	    observeNativeInputGate(this);
	    if(state.nativeInputGate)state.nativeInputGate.rootInstanceId=state.rootInstanceId;
	    if(diagnosticNextSeatGate){state.nativeInputGate.diagnosticOnly=true;state.nextSeatInputProbeArmed=false;state.nextSeatInputGateSeen=true}
	    if(event5SuccessorGate){state.nativeInputGate.eventSequence=5;state.event5ManagedGateOpened=true;state.nextSeatInputProbeArmed=false;state.nativeActionCompletionReported=false;state.nativeAction=null}
	    if(event6SuccessorGate){state.nativeInputGate.eventSequence=6;state.event6ManagedGateOpened=true;state.nextSeatInputProbeArmed=false;state.nativeActionCompletionReported=false;state.nativeAction=null;
	     state.nativeEvent6Candidate=Object.freeze({nativeEventId:state.nativeInputGate.nativeEventId,eventSequence:6,
	      eventInstanceId:state.nativeInputGate.eventInstanceId,parentEventInstanceId:state.nativeInputGate.parentEventInstanceId,
	      waitingCompletionOrdinal:state.nativeInputGate.waitingCompletionOrdinal,seatId:this.player.playerid,rootInstanceId:state.rootInstanceId,
	      options:Object.freeze(state.nativeInputGate.candidates.map(item=>item.optionId)),
	      optionKinds:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.cardType]))),
	      optionCardNames:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.cardName]))),
	      optionTargetSeatIds:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.targetSeatId])))})}
	    if(event7SuccessorGate){state.nativeInputGate.eventSequence=7;state.event7ManagedGateOpened=true;state.nextSeatInputProbeArmed=false;state.nativeActionCompletionReported=false;state.nativeAction=null;
	     state.nativeEvent7Candidate=Object.freeze({nativeEventId:state.nativeInputGate.nativeEventId,eventSequence:7,
	      eventInstanceId:state.nativeInputGate.eventInstanceId,parentEventInstanceId:state.nativeInputGate.parentEventInstanceId,
	      waitingCompletionOrdinal:state.nativeInputGate.waitingCompletionOrdinal,seatId:this.player.playerid,rootInstanceId:state.rootInstanceId,
	      options:Object.freeze(state.nativeInputGate.candidates.map(item=>item.optionId)),
	      optionKinds:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.cardType]))),
	      optionCardNames:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.cardName]))),
	      optionTargetSeatIds:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.targetSeatId])))})}
	    if(event8SuccessorGate){state.nativeInputGate.eventSequence=8;state.event8ManagedGateOpened=true;state.nextSeatInputProbeArmed=false;state.nativeActionCompletionReported=false;state.nativeAction=null;
	     state.nativeEvent8Candidate=Object.freeze({nativeEventId:state.nativeInputGate.nativeEventId,eventSequence:8,
	      eventInstanceId:state.nativeInputGate.eventInstanceId,parentEventInstanceId:state.nativeInputGate.parentEventInstanceId,
	      waitingCompletionOrdinal:state.nativeInputGate.waitingCompletionOrdinal,seatId:this.player.playerid,rootInstanceId:state.rootInstanceId,
	      options:Object.freeze(state.nativeInputGate.candidates.map(item=>item.optionId)),
	      optionKinds:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.cardType]))),
	      optionCardNames:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.cardName]))),
	      optionTargetSeatIds:Object.freeze(Object.fromEntries(state.nativeInputGate.candidates.map(item=>[item.optionId,item.targetSeatId])))})}
	    if(managedInputGate){game.pause();return new Promise(()=>{})}
	    const gate={event:this,nativeEventId:state.nativeInputGate.nativeEventId,seatId:this.player.playerid,status:'open',timer:null,controllerManaged:managedInputController,diagnosticOnly:diagnosticNextSeatGate,eventSequence:event8SuccessorGate?8:event7SuccessorGate?7:event6SuccessorGate?6:event5SuccessorGate?5:4};state.nativeInputResumeGate=gate;state.inputEvent=gate.event;
	    this.isOnline=()=>true;
	    this.send=function(){if(this!==gate.event||gate.status!=='open'||gate.timer)throw Error('NATIVE_INPUT_GATE_DUPLICATE_SEND_REJECTED');gate.status='waiting';gate.nativeSendCount=(gate.nativeSendCount||0)+1;state.nativeInputGate.nativeSendCount=gate.nativeSendCount;state.nativeInputGate.waiting=true;if(multiTurnInputGateProbe&&(gate.diagnosticOnly||gate.eventSequence===5))try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_next_seat_native_send_invoked',snapshot:{eventName:this.name,seatId:gate.seatId,eventSequence:gate.eventSequence,controllerManaged:gate.controllerManaged,diagnosticOnly:gate.diagnosticOnly,nativeSendCount:gate.nativeSendCount,rootObjectMatches:manager.rootEvent===state.root,gameMeAbsent:game.me===null}}))}catch{}if(!gate.controllerManaged)gate.timer=setTimeout(()=>{if(gate.status!=='waiting')return;gate.status='expired';state.nativeInputGate.status='expired';state.nativeInputGate.failureCode='NATIVE_INPUT_DEADLINE_EXPIRED';state.nativeInputGate.engineResumeCount=(state.nativeInputGate.engineResumeCount||0)+1;this.result={bool:false};game.resume();emit('native_input_gate_expired')},managedInputDeadlineMs);game.pause();emit('native_input_wait_open')};
	    emit('native_input_gate_waiting');return originalLoop.apply(this,args)
	   }
	   return originalLoop.apply(this,args)
	  };
	  GameEvent.prototype.trigger=function(name,...args){if(name==='gameStart')state.gameStartCount++;const activeSkillGate=${JSON.stringify(process.env.V2_NATIVE_YINYANG_FIXTURE === "1")}?[...(state.managedNativeResponseGates?.values()||[])].find(gate=>gate.delivery?.status==='applying'&&gate.options.get(gate.delivery?.optionId)?.kind==='view_as_skill'):null;
	   const child=originalTrigger.call(this,name,...args);if(${JSON.stringify(process.env.V2_NATIVE_PHASE_BOUNDARY_AUDIT === "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1")}&&this===state.phaseLoop&&name==='phaseOver'){
	     state.nativePhaseOverTriggerCount=(state.nativePhaseOverTriggerCount||0)+1;state.nativePhaseOverTriggerEvent=child&&typeof child==='object'&&typeof child.start==='function'?child:null;
	     state.nativePhaseOverTriggerSeatId=this.player?.playerid||null;
	     const ledger=completionLedgerForRoot(),ownerEventInstanceId=registerNativeEventInstance(this,ledger),
	      phaseEvent=[...(Array.isArray(this.childEvents)?this.childEvents:[])].reverse().find(item=>item?.name==='phase'&&item.parent===this&&
	       item.finished===true&&item.player===this.player),phaseEventInstanceId=phaseEvent?registerNativeEventInstance(phaseEvent,ledger):null,
	      phaseCompletionProof=phaseEvent&&ledger?.completionEvidence.get(phaseEvent)||null,
	      childEventInstanceId=state.nativePhaseOverTriggerEvent?registerNativeEventInstance(state.nativePhaseOverTriggerEvent,ledger):null;
	     if(!ledger||!ownerEventInstanceId||this!==state.phaseLoop||this.manager!==manager||manager.rootEvent!==state.root||!phaseEvent||!phaseEventInstanceId||
	      !phaseCompletionProof||phaseCompletionProof.eventInstanceId!==phaseEventInstanceId||phaseCompletionProof.parentEventInstanceId!==ownerEventInstanceId||
	      phaseCompletionProof.eventName!=='phase'||phaseCompletionProof.seatId!==this.player?.playerid||
	      state.nativePhaseOverTriggerEvent&&(state.nativePhaseOverTriggerEvent.parent!==this||!childEventInstanceId))throw Error('NATIVE_PHASE_OVER_DISPATCH_BINDING_INVALID');
	     state.nativePhaseOverDispatchDraft=Object.freeze({rootInstanceId:state.rootInstanceId,ownerEventInstanceId,ownerEventName:this.name||null,
	      ownerEventStep:Number.isSafeInteger(this.step)?this.step:null,triggerOrdinal:state.nativePhaseOverTriggerCount,triggerName:name,
	      seatId:this.player?.playerid||null,phaseEvent,phaseEventInstanceId,phaseCompletionOrdinal:phaseCompletionProof.completionOrdinal,
	      childEventInstanceId,childEventName:state.nativePhaseOverTriggerEvent?.name||null,
	      childParentEventInstanceId:childEventInstanceId?ledger.eventIds.get(state.nativePhaseOverTriggerEvent.parent)||null:null,phaseLoopEvent:this,
	      childEvent:state.nativePhaseOverTriggerEvent});
	    try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_phase_over_trigger_called',snapshot:{triggerCount:state.nativePhaseOverTriggerCount,
	     triggerEventName:state.nativePhaseOverTriggerEvent?.name||null,triggerEventCreated:Boolean(state.nativePhaseOverTriggerEvent),
	     triggerEventParentMatches:state.nativePhaseOverTriggerEvent?.parent===this,phaseLoopEventInstanceId:ownerEventInstanceId,
	     phaseLoopStep:Number.isSafeInteger(this.step)?this.step:null,rootObjectMatches:state.root?manager.rootEvent===state.root:null,gameMeAbsent:game.me===null}}))}catch{}
	   }if(activeSkillGate&&['gongJiBefore','yinYangZhanHuan'].includes(name)){let linked=false;for(let item=this,count=0;item&&count<24;item=item.parent,count++)if(item===activeSkillGate.event){linked=true;break}
	    activeSkillGate.nativeSkillTriggerTrace??=[];if(activeSkillGate.nativeSkillTriggerTrace.length<8)activeSkillGate.nativeSkillTriggerTrace.push({ownerEventName:this.name||null,ownerEventStep:Number.isSafeInteger(this.step)?this.step:null,ownerParentEventName:this.parent?.name||null,triggerName:name,
	     triggerEventName:child?.name||null,triggerEventParentName:child?.parent?.name||null,triggerEventParentMatchesOwner:child?.parent===this,linkedToNativeResponse:linked});else activeSkillGate.nativeSkillTriggerTraceOverflow=true}
	   emit(name==='gameStart'?'game_start_trigger':'event_trigger');return child};
	  game.createEvent=function(name,...args){const event=originalCreateEvent.call(this,name,...args);if(name==='gameDraw'){state.drawCreated=true;state.draw=event;state.drawParentName=event.parent?.name||null}if(name==='phaseLoop'){state.phaseLoopCreated=true;state.phaseLoop=event;state.phaseLoopParentName=event.parent?.name||null}
	   if(${JSON.stringify(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1")}&&['useSkill','jiRi_moBaoChongJie','jiRi_moBaoChongJieContentBefore','chooseToDiscard','changeZhanJi'].includes(name)){
	    state.nativeSkillEventTrace??=[];if(state.nativeSkillEventTrace.length>=48)state.nativeSkillEventTrace.shift();{const parentPath=[];for(let parent=event.parent,count=0;parent&&count<8;parent=parent.parent,count++)parentPath.push({eventName:parent.name||null,skillId:parent.skill||null,eventInstanceMatches:parent===state.nativeUseSkillChildEvent});
	     const trace={created:true,eventName:event.name||null,eventStep:Number.isSafeInteger(event.step)?event.step:null,parentEventName:event.parent?.name||null,
	      seatId:event.player?.playerid||null,skillId:event.skill||null,parentPath,rootObjectMatches:manager.rootEvent===state.root};state.nativeSkillEventTrace.push(trace);
	     try{window.__v2NativeStartTrace(JSON.stringify({kind:'native_start_trace_v1',stage:'native_jiri_event_created',snapshot:trace}))}catch{}}}
	   emit('event_created');return event};
	  const verifyCompletedRoom=()=>game.players.length===4&&game.players.every((player,index)=>player.playerid===window.__v2ManagedGame.setup.seats[index]?.seatId&&typeof player.name1==='string'&&!player.ws)&&game.me===null;
	  game.prepareArena=function(...args){state.prepareArenaCalls++;emit('prepare_arena_called');if(managedStart)throw Error('DUPLICATE_PREPARE_ARENA_REJECTED');return originalPrepareArena.apply(this,args)};
	  game.chooseCharacter=function(...args){state.chooseCharacterCalls++;emit('choose_character_called');if(managedStart)throw Error('DUPLICATE_CHARACTER_SELECTION_REJECTED');return originalChooseCharacter.apply(this,args)};
	  game.randomMapOL=function(...args){state.randomMapOLCalls++;emit('random_map_ol_called');if(managedStart){if(!_status.connectMode||!verifyCompletedRoom())throw Error('COMPLETED_ROOM_ROSTER_INVALID');state.randomMapOLAdapter='verified_completed_room_noop';return;}return originalRandomMapOL.apply(this,args)};
	  game.waitForPlayer=function(...args){state.waitForPlayerCalls++;emit('wait_for_player_called');if(managedStart){if(!_status.connectMode||!verifyCompletedRoom())throw Error('COMPLETED_ROOM_ROSTER_INVALID');state.waitForPlayerAdapter='verified_completed_room_callback';if(typeof args[0]==='function')args[0]();return;}return originalWaitForPlayer.apply(this,args)};
	  Player.prototype.phase=function(...args){state.phaseCalls++;const next=originalPhase.apply(this,args);if(managedStart&&!managedInputGate&&!managedInputResume&&!state.firstPhaseGate&&this===_status.firstAct){state.firstPhaseGate={seatId:this.playerid,eventName:next.name,parentName:next.parent?.name||null};game.pause();emit('first_phase_gate');return next}emit('phase_called');return next};
	Player.prototype.useResult=function(result,event){if(event&&event===state.inputEvent){const action=state.nativeAction;if(!action||action.eventId!==event.__v2NativeEventId)throw Error('NATIVE_ACTION_GATE_BINDING_LOST');action.useResultCount++;state.nativeInputGate.useResultCount=action.useResultCount;action.status='native_useResult_entered';action.result={bool:result?.bool===true,cardName:result?.card?.name||null,skillId:typeof result?.skill==='string'?result.skill:null,cardsCount:Array.isArray(result?.cards)?result.cards.length:0,targetCount:Array.isArray(result?.targets)?result.targets.length:0};emit('native_useResult_entered');try{if(${JSON.stringify(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "")}==='use_result_throws')throw Error('INJECTED_USE_RESULT_EXCEPTION');const next=originalUseResult.call(this,result,event);action.useResultChildName=next?.name||null;state.nativeActionChildEvent=next;if(result?.skill&&!result?.card)state.nativeUseSkillChildEvent=next;else state.nativeUseCardChildEvent=next;action.status='native_useResult_dispatched';emit(result?.skill&&!result?.card?'native_useSkill_dispatched':'native_useResult_dispatched');return next}catch(error){action.status='uncertain';state.failureCode='NATIVE_USE_RESULT_FAILED';emit('native_useResult_exception');throw error}}return originalUseResult.call(this,result,event)};
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
		emitNativeStartDiagnostic({ stage: "controlled_block_cdp_started", classification: "cdp_command_dispatched" });
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
			const probe=await cdp.send("Runtime.evaluate",{expression:`(()=>{const s=window.__v2NativeStartDiagnosticState,{game,_status}=window.__v2ManagedEngine.core,phaseLoop=s?.phaseLoop,phaseEvent=phaseLoop?.next?.find(event=>event.name==='phase'&&event.player===_status.firstAct),detail=/^[A-Z0-9_]{3,96}$/.test(s?.failureDetail||'')?s.failureDetail:null,a=s?.jiRiCandidateAudit;return {rootPromiseState:s?.rootPromiseState||'unobserved',snapshot:{eventName:_status.event?.name||null,eventStep:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,parentEventName:_status.event?.parent?.name||null,rootEventName:_status.eventManager.rootEvent?.name||null,rootInstanceId:s?.rootInstanceId||null,rootObjectMatches:s?.root? _status.eventManager.rootEvent===s.root:null,eventStackDepth:_status.eventManager.eventStack.length,eventStackTop:_status.eventManager.eventStack.at(-1)?.name||null,eventStack:_status.eventManager.eventStack.map(event=>event.name),connectMode:Boolean(_status.connectMode),paused:Boolean(_status.paused),gameStartTriggered:(s?.gameStartCount||0)>0,gameStartCount:s?.gameStartCount||0,gameDrawCreated:Boolean(s?.drawCreated),gameDrawEntered:Boolean(s?.drawEntered),gameDrawParentName:s?.drawParentName||null,phaseLoopCreated:Boolean(s?.phaseLoopCreated),phaseLoopParentName:s?.phaseLoopParentName||null,firstPhaseEventName:phaseEvent?.name||null,firstPhaseParentName:phaseEvent?.parent?.name||null,firstPhaseGate:s?.firstPhaseGate||null,nativeInputGate:s?.nativeInputGate||null,prepareArenaCalls:s?.prepareArenaCalls||0,waitForPlayerCalls:s?.waitForPlayerCalls||0,randomMapOLCalls:s?.randomMapOLCalls||0,chooseCharacterCalls:s?.chooseCharacterCalls||0,phaseCalls:s?.phaseCalls||0,currentPhaseSeatId:_status.currentPhase?.playerid||null,firstActSeatId:_status.firstAct?.playerid||null,pendingChoiceEventName:/choose|respond|useCard/i.test(_status.event?.name||'')?_status.event.name:null,pendingChoiceSeatId:_status.event?.player?.playerid||null,hostPlayerAbsent:game.me===null,seats:game.players.map(p=>({seatId:p.playerid||null,characterInitialized:typeof p.name1==='string',handCount:p.countCards('h')})),lastSuccessfulEventStep:s?.lastSuccessfulEventStep||null,failureCode:s?.failureCode||null,failureDetailCode:detail,jiRiCandidateAudit:a?{targetCount:a.targetCount,targetWithSpellCount:a.targetWithSpellCount,nativeTargetFilterPassCount:a.nativeTargetFilterPassCount,seatSpellHandCounts:a.seatSpellHandCounts}:null}}})()`,returnByValue:true},800);
				if(probe.exceptionDetails) {lastProbeError=String(probe.exceptionDetails.text||"CDP_EVALUATION_EXCEPTION").slice(0,256);break;}
				value=probe.result?.value||null;
				const waitForManagedInputGate=['managed_input_resume','managed_input_timeout','managed_input_cancel','managed_input_cancel_resume_race','managed_input_stop','managed_input_controller','managed_input_controller_trustee','managed_input_controller_registry','managed_input_controller_fault_before_apply','managed_opening_root_action','managed_opening_root_action_event4','managed_opening_root_action_event4_ack_loss','managed_opening_root_action_event4_trustee','managed_opening_root_action_event5','managed_native_skill_candidate_probe'].includes(message.mode);
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
		message.type !== "host_native_start_snapshot" ||
		!(["managed_opening_root_action_event4", "managed_native_skill_candidate_probe"].includes(message.mode)) || !cdp) {
		throw new Error("NATIVE_START_SNAPSHOT_REJECTED");
	}
	try {
		if (message.mode === "managed_native_skill_candidate_probe") {
			const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{
				const s=window.__v2ManagedUnifiedRoot,m=window.__v2ManagedEngine?.core,{game,_status}=m||{},manager=_status?.eventManager;
				if(!s||!game||!manager)return {kind:'native_jirimo_root_snapshot_v1',available:false};
				const stack=manager.eventStack||[],selection=s.selectionEvent||null,side=s.sideEvent||null;
				return {kind:'native_jirimo_root_snapshot_v1',available:true,rootName:manager.rootEvent?.name||null,
					rootMatches:manager.rootEvent===s.root,rootInstanceId:s.rootInstanceId||null,
					eventStack:stack.map(event=>({name:event.name||null,step:Number.isSafeInteger(event.step)?event.step:null,
						parentName:event.parent?.name||null,finished:event.finished===true})),
					selection:{exists:Boolean(selection),name:selection?.name||null,step:Number.isSafeInteger(selection?.step)?selection.step:null,
						parentName:selection?.parent?.name||null,finished:selection?.finished===true,
					nextCount:Array.isArray(selection?.next)?selection.next.length:null,
						nextHeadName:selection?.next?.[0]?.name||null,nextHeadFinished:selection?.next?.[0]?.finished===true,
						listCount:Array.isArray(selection?.list)?selection.list.length:null,
						choiceMapKeyCount:Object.keys(selection?._choiceMap||{}).length,
						aiTargetCount:Array.isArray(selection?.ai_targets)?selection.ai_targets.length:null},
					sideAssignment:{exists:Boolean(side),completed:s.sideEventCompleted===true,
						name:side?.name||null,finished:side?.finished===true},
					gates:{event1Ready:s.event1Ready===true,event1Released:s.event1Released===true,
						event2Ready:s.event2Ready===true,event2Released:s.event2Released===true},
					currentEvent:{name:_status.event?.name||null,step:Number.isSafeInteger(_status.event?.step)?_status.event.step:null,
						parentName:_status.event?.parent?.name||null},paused:Boolean(_status.paused),
					firstActSeatBound:Boolean(_status.firstAct&&game.players.includes(_status.firstAct)),
					fixturePoolPrepared:Boolean(s.jiRiCandidatePool),fixtureCandidateObserved:s.jiRiFixtureCandidateObserved===true,
					selectionSignalTrace:(s.selectionSignalTrace||[]).slice(-16),
					nativeChoiceMap:game._characterChoice&&typeof game._characterChoice==='object'?
						Object.values(game._characterChoice).map(options=>Array.isArray(options)?options.length:null):null,
					dialogBroadcastCount:s.dialogBroadcasts||0,trusteeTimerCaptured:s.trusteeTimerCaptured===true,
					choiceReady:s.choiceReady===true,choiceCandidateMapPresent:Boolean(s.nativeCandidates),
					rootPromiseState:s.rootPromiseState||null,failureCode:s.failureCode||null,
					modeConfig:{phaseSwap:Boolean(m.get?.phaseswap?.()),versusMode:typeof m.lib?.configOL?.versus_mode==='string'?m.lib.configOL.versus_mode:null,
						chooseMode:typeof m.lib?.configOL?.choose_mode==='string'?m.lib.configOL.choose_mode:null,
						chooseSide:Boolean(m.lib?.configOL?.chooseSide)},
					gameMeAbsent:game.me===null,connectedTransportCount:game.players.filter(player=>player.ws).length,
					seats:game.players.map(player=>({characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')}))};
			})()`, returnByValue: true }, 1500);
			const snapshot = result.result?.value;
			if (result.exceptionDetails || snapshot?.kind !== "native_jirimo_root_snapshot_v1") throw new Error("NATIVE_JIRIMO_ROOT_SNAPSHOT_FAILED");
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
				observed: { ...snapshot, stage: "native_jirimo_root_snapshot" } });
			return;
		}
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{
			const state=window.__v2NativeStartDiagnosticState,managed=window.__v2ManagedEngine,core=managed?.core,game=core?.game,status=core?._status,manager=status?.eventManager,current=status?.event,stack=manager?.eventStack||[];
			const currentPhase=status?.currentPhase||null,phaseEvent=[...stack].reverse().find(event=>event.name==='phase')||null;
			const xingDongEvent=[...stack].reverse().find(event=>event.name==='xingDong')||null;
			const quota=player=>({gongJiOrFaShu:Number.isSafeInteger(player?.storage?.gongJiOrFaShu)?player.storage.gongJiOrFaShu:null,
				faShu:Number.isSafeInteger(player?.storage?.faShu)?player.storage.faShu:null,
				gongJi:Number.isSafeInteger(player?.storage?.gongJi)?player.storage.gongJi:null,
				extraXingDongCount:Array.isArray(player?.storage?.extraXingDong)?player.storage.extraXingDong.length:null});
			const pendingActionChildCount=(stack||[]).filter(event=>event.name==='xingDong'&&Array.isArray(event.childEvents))
				.reduce((count,event)=>count+event.childEvents.filter(child=>child.action===true&&child.finished!==true).length,0);
			const completedActionChildCount=(stack||[]).filter(event=>event.name==='xingDong'&&Array.isArray(event.childEvents))
				.reduce((count,event)=>count+event.childEvents.filter(child=>child.action===true&&child.finished===true).length,0);
			const projectionAudit={kind:'xingbei_authority_projection_audit_v1',candidateDisposition:'diagnostic_only_not_a_proof',
				authorized:false,checkpointAvailable:false,pendingActionChildCount,completedActionChildCount,
				roomInstancePresent:Boolean(game),rootEventName:manager?.rootEvent?.name||null,
				rootInstanceId:state?.rootInstanceId||null,rootObjectMatches:state?.root?manager?.rootEvent===state.root:null,
				roundNumber:Number.isSafeInteger(game?.roundNumber)?game.roundNumber:null,
				phaseNumber:Number.isSafeInteger(game?.phaseNumber)?game.phaseNumber:null,
				currentSeatId:typeof currentPhase?.playerid==='string'?currentPhase.playerid:null,
				firstActSeatId:typeof status?.firstAct?.playerid==='string'?status.firstAct.playerid:null,
				phaseEvent:phaseEvent?{name:phaseEvent.name,step:Number.isSafeInteger(phaseEvent.step)?phaseEvent.step:null,
					seatId:phaseEvent.player?.playerid||null,finished:phaseEvent.finished===true}:null,
				xingDongEvent:xingDongEvent?{name:xingDongEvent.name,step:Number.isSafeInteger(xingDongEvent.step)?xingDongEvent.step:null,
					seatId:xingDongEvent.player?.playerid||null,finished:xingDongEvent.finished===true,
					actionChildCount:Array.isArray(xingDongEvent.childEvents)?xingDongEvent.childEvents.filter(child=>child.action===true).length:null,
					completedActionChildCount:Array.isArray(xingDongEvent.childEvents)?xingDongEvent.childEvents.filter(child=>child.action===true&&child.finished===true).length:null,
					quotas:quota(xingDongEvent.player)}:null,
				resources:game?{hongShiQi:Number.isSafeInteger(game.hongShiQi)?game.hongShiQi:null,
					lanShiQi:Number.isSafeInteger(game.lanShiQi)?game.lanShiQi:null,
					hongXingBei:Number.isSafeInteger(game.hongXingBei)?game.hongXingBei:null,
					lanXingBei:Number.isSafeInteger(game.lanXingBei)?game.lanXingBei:null,
					hongZhanJiCount:Array.isArray(game.hongZhanJi)?game.hongZhanJi.length:null,
					lanZhanJiCount:Array.isArray(game.lanZhanJi)?game.lanZhanJi.length:null}:null,
				cardZoneCounts:core?.ui?{draw:Number.isSafeInteger(core.ui.cardPile?.childElementCount)?core.ui.cardPile.childElementCount:null,
					discard:Number.isSafeInteger(core.ui.discardPile?.childElementCount)?core.ui.discardPile.childElementCount:null,
					ordering:Number.isSafeInteger(core.ui.ordering?.childElementCount)?core.ui.ordering.childElementCount:null,
					special:Number.isSafeInteger(core.ui.special?.childElementCount)?core.ui.special.childElementCount:null}:null,
				seats:(game?.players||[]).map(player=>({seatId:player.playerid||null,position:Number.isSafeInteger(Number(player.dataset?.position))?Number(player.dataset.position):null,character:typeof player.name1==='string'?player.name1:null,
					side:typeof player.side==='boolean'?player.side:null,alive:typeof player.isIn==='function'?player.isIn():null,
					hp:Number.isSafeInteger(player.hp)?player.hp:null,maxHp:Number.isSafeInteger(player.maxHp)?player.maxHp:null,
					zhiLiao:Number.isSafeInteger(player.zhiLiao)?player.zhiLiao:null,hujia:player.hujia===undefined?0:Number.isSafeInteger(player.hujia)?player.hujia:null,
					handCount:player.countCards('h'),equipmentCount:player.countCards('e'),judgmentCount:player.countCards('j'),expansionCount:player.countCards('x'),
					nengLiang:{baoShi:player.countNengLiang('baoShi'),shuiJing:player.countNengLiang('shuiJing')},
					skillCount:player.getSkills(null,false,false).length,markKeyCount:Object.keys(player.marks||{}).length,
					storageKeyCount:Object.keys(player.storage||{}).length}))};
			return {kind:'native_start_live_snapshot_v1',rootEventName:manager?.rootEvent?.name||null,rootInstanceId:state?.rootInstanceId||null,
				rootObjectMatches:state?.root?manager?.rootEvent===state.root:null,eventName:current?.name||null,
				eventStep:Number.isSafeInteger(current?.step)?current.step:null,parentEventName:current?.parent?.name||null,
				eventStack:stack.map(event=>({name:event.name||null,step:Number.isSafeInteger(event.step)?event.step:null,parentName:event.parent?.name||null,
					seatId:event.player?.playerid||null,nextCount:Array.isArray(event.next)?event.next.length:null,
					nextHeadName:event.next?.[0]?.name||null,nextHeadStep:Number.isSafeInteger(event.next?.[0]?.step)?event.next[0].step:null,
					nextHeadFinished:Boolean(event.next?.[0]?.finished)})),paused:Boolean(status?.paused),
				rootPromiseState:state?.rootPromiseState||null,failureCode:state?.failureCode||null,
				nativeAction:state?.nativeAction?{eventId:state.nativeAction.eventId||null,seatId:state.nativeAction.seatId||null,
					status:state.nativeAction.status||null,useResultCount:state.nativeAction.useResultCount||0,
					nativeChildWaitCompleted:state.nativeAction.nativeChildWaitCompleted===true,
					nativeUseCardChildCompleted:state.nativeAction.nativeUseCardChildCompleted===true}:null,
				nativeParentFence:state?.nativeParentContinuationFence?{status:state.nativeParentContinuationFence.status||null,
					nativeEventId:state.nativeParentContinuationFence.nativeEventId||null,seatId:state.nativeParentContinuationFence.seatId||null,
					parentEventName:state.nativeParentContinuationFence.parentEventName||null,
					parentEventStep:Number.isSafeInteger(state.nativeParentContinuationFence.parentEventStep)?state.nativeParentContinuationFence.parentEventStep:null,
					completedChildName:state.nativeParentContinuationFence.completedChildName||null,
					completedChildStep:Number.isSafeInteger(state.nativeParentContinuationFence.completedChildStep)?state.nativeParentContinuationFence.completedChildStep:null,
					completedChildFinished:state.nativeParentContinuationFence.completedChildFinished===true,
					completedChildParentMatches:state.nativeParentContinuationFence.completedChildParentMatches===true,
					parentNextCount:Number.isSafeInteger(state.nativeParentContinuationFence.parentNextCount)?state.nativeParentContinuationFence.parentNextCount:null,
					releaseCount:state.nativeParentContinuationFence.releaseCount||0,
					releaseResolution:state.nativeParentContinuationFence.releaseResolution||null,
					acceptedAuthority:state.nativeParentContinuationFence.acceptedAuthority||null,
					quotas:state.nativeParentContinuationFence.quotas||null}:null,
				nativePhaseBoundaryFence:state?.nativePhaseBoundaryFence?{status:state.nativePhaseBoundaryFence.status||null,
					nativeEventId:state.nativePhaseBoundaryFence.nativeEventId||null,seatId:state.nativePhaseBoundaryFence.seatId||null,
					rootInstanceId:state.nativePhaseBoundaryFence.rootInstanceId||null,phaseLoopStep:state.nativePhaseBoundaryFence.phaseLoopStep,
					phaseOverTriggerCount:state.nativePhaseBoundaryFence.phaseOverTriggerCount,
					phaseOverTriggerComplete:state.nativePhaseBoundaryFence.phaseOverTriggerComplete,
					descendantNodeCount:state.nativePhaseBoundaryFence.descendantNodeCount,
					pendingDescendantCount:state.nativePhaseBoundaryFence.pendingDescendantCount,
					releaseCount:state.nativePhaseBoundaryFence.releaseCount||0,
					priorAuthority:state.nativePhaseBoundaryFence.priorAuthority||null,
					releaseResolution:state.nativePhaseBoundaryFence.releaseResolution||null}:null,
				responseGates:[...(state?.managedNativeResponseGates?.values()||[])].slice(-16).map(gate=>({nativeEventId:gate.nativeEventId||null,
					seatId:gate.seatId||null,actionEventId:gate.actionEventId||null,sourceSeatId:gate.sourceSeatId||null,
					eventStep:Number.isSafeInteger(gate.event?.step)?gate.event.step:null,status:gate.status||null,
					waitEventName:gate.waitEvent?.name||null,waitEventFinished:Boolean(gate.waitEvent?.finished),waitResolved:gate.waitResolved===true,
					optionCount:gate.optionIds?.length||0,deliveryId:gate.delivery?.deliveryId||null,deliveryStatus:gate.delivery?.status||null,
					useCardChildrenStarted:gate.useCardChildrenStarted||0,useCardChildrenCompleted:gate.useCardChildrenCompleted||0})),
				hostPlayerAbsent:game?.me===null,seats:(game?.players||[]).map(player=>({seatId:player.playerid||null,
					characterInitialized:typeof player.name1==='string',handCount:player.countCards('h')})),projectionAudit};
		})()`, returnByValue: true }, 1500);
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

async function snapshotNativeCardLedger(message) {
	const keys = "kind,mode,protocol,requestId,roomId,seatIds,secret,sessionId,type";
	if (process.env.V2_NATIVE_CARD_LEDGER_PROBE !== "1" || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
		process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" || !validHostCommand(message) ||
		message.type !== "host_native_card_ledger_snapshot" || Object.keys(message).sort().join(",") !== keys ||
		!/^ledger_[a-f0-9]{32}$/.test(message.requestId || "") || !["pre_native_action", "post_phase_over"].includes(message.mode) ||
		!managedNativeCardLedger || !Array.isArray(message.seatIds) || JSON.stringify(message.seatIds) !== JSON.stringify(managedSeatIds) || !cdp) {
		throw new Error("NATIVE_CARD_LEDGER_COMMAND_REJECTED");
	}
		const request = { requestId: message.requestId, mode: message.mode, seatIds: message.seatIds, sidecarNonce: managedCardSidecarNonce };
	try {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{
			const command=${JSON.stringify(request)},state=window.__v2NativeStartDiagnosticState,managed=window.__v2ManagedEngine,
				core=managed?.core,game=core?.game,status=core?._status,manager=status?.eventManager,container=window.__v2ManagedGame;
			if(!state||!game||!status||!manager||manager.rootEvent!==state.root||state.rootInstanceId==null||
				game.me!==null||container?.authorityState?.revision!==(command.mode==='pre_native_action'?3:4)||
				manager.rootEvent.name!=='game'||(game.players||[]).some(player=>player.ws)||
				(command.mode==='pre_native_action'&&(!state.nativeInputGate||state.nativeInputGate.waiting!==true||
					state.nativeInputGate.eventName!=='gongJiOrFaShu'||state.nativeInputGate.seatId!==status.event?.player?.playerid))||
				(command.mode==='post_phase_over'&&(!state.nativePhaseBoundaryFence||state.nativePhaseBoundaryFence.status!=='waiting'||
					state.nativePhaseBoundaryFence.rootInstanceId!==state.rootInstanceId||state.nativePhaseBoundaryFence.pendingDescendantCount!==0||
					state.nativePhaseBoundaryFence.phaseOverTriggerComplete!==true))) throw Error('NATIVE_CARD_LEDGER_FENCE_INVALID');
			const cards=[],seenPlayers=new Set(),registryEntries=Object.entries(core.lib?.cardOL||{}),registryByCard=new Map();
			for(const [id,card] of registryEntries){if(typeof id!=='string'||!id||registryByCard.has(card)||!(card instanceof Element)||!card.classList?.contains('card'))throw Error('NATIVE_CARD_LEDGER_CARD_REGISTRY_INVALID');registryByCard.set(card,id);}
			let sidecar=window.__v2NativeCardLedgerSidecar;
			if(!sidecar){sidecar={nonce:command.sidecarNonce,nextId:0,ids:new WeakMap()};Object.defineProperty(window,'__v2NativeCardLedgerSidecar',{value:sidecar,configurable:true});}
			if(sidecar.nonce!==command.sidecarNonce||!(sidecar.ids instanceof WeakMap))throw Error('NATIVE_CARD_LEDGER_SIDECAR_INVALID');
			const append=(card,zone,ownerSeatId,position)=>{
				if(!(card instanceof Element)||!card.classList?.contains('card')) throw Error('NATIVE_CARD_LEDGER_CARD_NODE_INVALID');
				const registeredId=registryByCard.get(card);
				if(card.cardid!==undefined&&card.cardid!==null&&typeof card.cardid!=='string') throw Error('NATIVE_CARD_LEDGER_CARD_ID_INVALID');
				if(registeredId&&card.cardid&&card.cardid!==registeredId) throw Error('NATIVE_CARD_LEDGER_CARD_ID_INVALID');
				let cardId=sidecar.ids.get(card);if(!cardId){cardId='native_card_'+command.sidecarNonce+'_'+(++sidecar.nextId);sidecar.ids.set(card,cardId);}
				if(typeof card.name!=='string') throw Error('NATIVE_CARD_LEDGER_CARD_NAME_INVALID');
				if(typeof card.xiBie!=='string') throw Error('NATIVE_CARD_LEDGER_CARD_XIBIE_INVALID');
				if(!(typeof card.mingGe==='string'||Number.isSafeInteger(card.mingGe))) throw Error('NATIVE_CARD_LEDGER_CARD_MINGGE_INVALID');
				if(card.duYou!==undefined&&card.duYou!==null&&typeof card.duYou!=='string') throw Error('NATIVE_CARD_LEDGER_CARD_DUYOU_INVALID');
				cards.push({cardId,zone,ownerSeatId,position,name:card.name,xiBie:card.xiBie,mingGe:card.mingGe,
					duYou:card.duYou===undefined?null:card.duYou,kind:'physical_dom_card_v1'});
			};
			const appendGlobal=(root,zone)=>{
				if(!root) throw Error('NATIVE_CARD_LEDGER_ZONE_MISSING');
				Array.from(root.children).forEach((card,position)=>append(card,zone,null,position));
			};
			appendGlobal(core.ui?.cardPile,'draw');appendGlobal(core.ui?.discardPile,'discard');
			appendGlobal(core.ui?.ordering,'ordering');appendGlobal(core.ui?.special,'special');
			const players=[...(game.players||[]),...(game.dead||[])];
			if(players.length!==command.seatIds.length||new Set(players.map(player=>player.playerid)).size!==players.length||
				command.seatIds.some(seatId=>!players.some(player=>player.playerid===seatId))) throw Error('NATIVE_CARD_LEDGER_SEAT_SET_INVALID');
			const zoneTypes=[['h','hand'],['e','equipment'],['j','judgment'],['s','player_special'],['x','expansion']];
			for(const seatId of command.seatIds){const player=players.find(item=>item.playerid===seatId);if(seenPlayers.has(player))throw Error('NATIVE_CARD_LEDGER_SEAT_DUPLICATE');seenPlayers.add(player);
				for(const [slot,zone] of zoneTypes){const list=player.getCards(slot);if(!Array.isArray(list))throw Error('NATIVE_CARD_LEDGER_PLAYER_ZONE_INVALID');
					list.forEach((card,position)=>append(card,zone,seatId,position));}}
			const trackedObjects=new Set([...players.flatMap(player=>zoneTypes.flatMap(([slot])=>player.getCards(slot))),
				...Array.from(core.ui.cardPile.children),...Array.from(core.ui.discardPile.children),...Array.from(core.ui.ordering.children),...Array.from(core.ui.special.children)]);
			if(registryEntries.some(([id,card])=>id!==registryByCard.get(card)||!trackedObjects.has(card)||
				(card.cardid&&card.cardid!==id))) throw Error('NATIVE_CARD_LEDGER_UNASSIGNED_PHYSICAL_CARD');
			return {schema:'xingbei_native_private_card_ledger_v1',rootInstanceId:state.rootInstanceId,
				seatIds:command.seatIds,cards};})()`, returnByValue: true }, 3000);
		const snapshot = result.result?.value;
		if (result.exceptionDetails) {
			const allowedFailureCodes = ["NATIVE_CARD_LEDGER_FENCE_INVALID", "NATIVE_CARD_LEDGER_PHYSICAL_CARD_INVALID",
				"NATIVE_CARD_LEDGER_CARD_NODE_INVALID", "NATIVE_CARD_LEDGER_CARD_ID_INVALID", "NATIVE_CARD_LEDGER_CARD_NAME_INVALID",
				"NATIVE_CARD_LEDGER_CARD_XIBIE_INVALID", "NATIVE_CARD_LEDGER_CARD_MINGGE_INVALID", "NATIVE_CARD_LEDGER_CARD_DUYOU_INVALID",
				"NATIVE_CARD_LEDGER_CARD_REGISTRY_INVALID", "NATIVE_CARD_LEDGER_SIDECAR_INVALID",
				"NATIVE_CARD_LEDGER_ZONE_MISSING", "NATIVE_CARD_LEDGER_SEAT_SET_INVALID", "NATIVE_CARD_LEDGER_SEAT_DUPLICATE",
				"NATIVE_CARD_LEDGER_PLAYER_ZONE_INVALID", "NATIVE_CARD_LEDGER_UNASSIGNED_PHYSICAL_CARD"];
			const exception = `${result.exceptionDetails.text || ""} ${result.exceptionDetails.exception?.description || ""}`;
			const failureCode = allowedFailureCodes.find(candidate => exception.includes(candidate)) ||
				(result.exceptionDetails.exception?.className === "ReferenceError" || exception.includes("ReferenceError")
					? "NATIVE_CARD_LEDGER_CDP_REFERENCE_ERROR" : result.exceptionDetails.exception?.className === "TypeError" || exception.includes("TypeError")
						? "NATIVE_CARD_LEDGER_CDP_TYPE_ERROR" : "NATIVE_CARD_LEDGER_CDP_EXCEPTION");
			throw new Error(failureCode);
		}
		if (snapshot?.schema !== "xingbei_native_private_card_ledger_v1") throw new Error("NATIVE_CARD_LEDGER_CAPTURE_FAILED");
		const commitment = managedNativeCardLedger.commit(snapshot);
		if (commitment.snapshotOrdinal !== (message.mode === "pre_native_action" ? 1 : 2)) throw new Error("NATIVE_CARD_LEDGER_SEQUENCE_INVALID");
		process.send?.({ ...identity, type: "host_private_card_ledger_commitment", requestId: message.requestId,
			mode: message.mode, snapshot: commitment });
	} catch (error) {
		const allowed = new Set(["NATIVE_CARD_LEDGER_COMMAND_REJECTED", "NATIVE_CARD_LEDGER_CAPTURE_FAILED", "NATIVE_CARD_LEDGER_FENCE_INVALID",
			"NATIVE_CARD_LEDGER_PHYSICAL_CARD_INVALID", "NATIVE_CARD_LEDGER_CARD_NODE_INVALID", "NATIVE_CARD_LEDGER_CARD_ID_INVALID",
			"NATIVE_CARD_LEDGER_CARD_NAME_INVALID", "NATIVE_CARD_LEDGER_CARD_XIBIE_INVALID", "NATIVE_CARD_LEDGER_CARD_MINGGE_INVALID",
			"NATIVE_CARD_LEDGER_CARD_DUYOU_INVALID", "NATIVE_CARD_LEDGER_CARD_REGISTRY_INVALID", "NATIVE_CARD_LEDGER_SIDECAR_INVALID",
			"NATIVE_CARD_LEDGER_ZONE_MISSING", "NATIVE_CARD_LEDGER_SEAT_SET_INVALID",
			"NATIVE_CARD_LEDGER_SEAT_DUPLICATE", "NATIVE_CARD_LEDGER_PLAYER_ZONE_INVALID", "NATIVE_CARD_LEDGER_UNASSIGNED_PHYSICAL_CARD",
			"NATIVE_CARD_LEDGER_CDP_REFERENCE_ERROR", "NATIVE_CARD_LEDGER_CDP_TYPE_ERROR", "NATIVE_CARD_LEDGER_CDP_EXCEPTION", "NATIVE_CARD_LEDGER_ROW_INVALID",
			"NATIVE_CARD_LEDGER_OWNER_INVALID", "NATIVE_CARD_LEDGER_ORDER_INVALID", "NATIVE_CARD_LEDGER_ROOT_CHANGED", "NATIVE_CARD_LEDGER_SEQUENCE_INVALID"]);
		const code = allowed.has(error?.message) ? error.message : "NATIVE_CARD_LEDGER_CAPTURE_FAILED";
		process.send?.({ ...identity, type: "host_private_card_ledger_failed", requestId: message.requestId, mode: message.mode, code });
	}
}

async function snapshotNativeAtomicCapture(message) {
	const keys = "boundaryOrdinal,captureOrdinal,engineBuildId,kind,protocol,requestId,roomId,rootInstanceId,seatIds,secret,sessionId,type";
	if (process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE !== "1" || process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" ||
		process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" || process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1" ||
		!validHostCommand(message) || message.type !== "host_native_atomic_capture" || Object.keys(message).sort().join(",") !== keys ||
		!/^atomic_[a-f0-9]{32}$/.test(message.requestId || "") || !Number.isSafeInteger(message.captureOrdinal) || message.captureOrdinal < 1 ||
		!Number.isSafeInteger(message.boundaryOrdinal) || message.boundaryOrdinal < 1 ||
		!(message.boundaryOrdinal <= 2 && (message.boundaryOrdinal !== 2 || process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1") ||
			message.boundaryOrdinal === 3 && process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
			(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "6" ||
				process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "7" && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" ||
				process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "8" && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
				process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") &&
			process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1" ||
			message.boundaryOrdinal === 4 && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
			(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "7" ||
				process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "8" && process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") &&
			process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1") ||
		message.engineBuildId !== managedEngineBuildId || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(message.rootInstanceId || "") ||
		!Array.isArray(message.seatIds) || message.seatIds.length !== 4 || JSON.stringify(message.seatIds) !== JSON.stringify(managedSeatIds) || !cdp) {
		throw new Error("NATIVE_ATOMIC_CAPTURE_COMMAND_REJECTED");
	}
	const request = { requestId: message.requestId, captureOrdinal: message.captureOrdinal, boundaryOrdinal: message.boundaryOrdinal, roomId: message.roomId,
		hostSessionId: message.sessionId, engineBuildId: message.engineBuildId, rootInstanceId: message.rootInstanceId, seatIds: message.seatIds };
	try {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{
			const command=${JSON.stringify(request)},state=window.__v2NativeStartDiagnosticState,managed=window.__v2ManagedEngine,
				core=managed?.core,game=core?.game,status=core?._status,manager=status?.eventManager,fence=state?.nativePhaseBoundaryFence,
				loop=state?.phaseLoop,phase=fence?.completedPhaseEvent;
			if(!state||!game||!status||!manager||manager.rootEvent!==state.root||state.rootInstanceId!==command.rootInstanceId||
				manager.rootEvent?.name!=='game'||game.me!==null||!Array.isArray(game.players)||game.players.length!==4||
				game.players.some(player=>player.ws)||command.seatIds.some(id=>!game.players.some(player=>player.playerid===id))||
				new Set(game.players.map(player=>player.playerid)).size!==4)throw Error('NATIVE_ATOMIC_CAPTURE_ROOT_OR_SEATS_INVALID');
			const pendingDescendants=root=>{const seen=new WeakSet();let pending=0,nodes=0,overflow=false;const walk=node=>{if(!node||typeof node!=='object'||seen.has(node))return;seen.add(node);if(++nodes>4096){overflow=true;return}if(node!==root&&node.finished!==true)pending++;for(const child of [...(Array.isArray(node.childEvents)?node.childEvents:[]),...(Array.isArray(node.next)?node.next:[])])walk(child)};walk(root);return {pending,nodes,overflow}};
			const descendants=loop?pendingDescendants(loop):{pending:1,nodes:0,overflow:true};
			if(!fence||fence.status!=='waiting'||fence.releaseCount!==0||fence.boundaryOrdinal!==command.boundaryOrdinal||
				state.nativePhaseBoundaryFences?.at(-1)!==fence||fence.rootEvent!==state.root||fence.phaseLoopEvent!==loop||
				fence.rootInstanceId!==command.rootInstanceId||fence.pendingDescendantCount!==0||fence.phaseOverTriggerComplete!==true||
				loop?.name!=='phaseLoop'||loop.step!==3||!loop.player||!phase?.player||phase.player!==fence.seatPlayer||
				phase.player.playerid!==fence.seatId||loop.player.playerid!==fence.nextActorSeatId||
				!command.seatIds.includes(fence.seatId)||!command.seatIds.includes(loop.player.playerid)||phase?.name!=='phase'||
				phase.parent!==loop||phase.finished!==true||core._status.currentPhase!=null||manager.eventStack.at(-1)!==loop||
				descendants.overflow||descendants.pending!==0||state.nativePhaseOverTriggerCount!==fence.phaseOverTriggerCount||
				fence.phaseOverDispatchEvidence!==state.nativePhaseOverDispatchEvidence||state.nativePhaseOverDispatchOwner!==loop||
				state.nativePhaseOverTriggerSeatId!==fence.seatId)
				throw Error('NATIVE_ATOMIC_CAPTURE_NATIVE_FENCE_INVALID');
			const completionLedger=state.nativeEventCompletionLedger,phaseProof=completionLedger?.completionEvidence.get(phase),
				phaseOverProof=fence.phaseOverCompletionEvidence;
			if(!completionLedger||completionLedger.rootEvent!==state.root||completionLedger.rootInstanceId!==command.rootInstanceId||
				completionLedger.completionOrdinal!==fence.nativeCompletionOrdinal||!phaseProof||!phaseOverProof||
				JSON.stringify(phaseProof)!==JSON.stringify(fence.completionEvidence)||
				JSON.stringify(phaseOverProof)!==JSON.stringify(state.nativePhaseOverDispatchEvidence)||
				phaseOverProof.ownerEventInstanceId!==phaseProof.parentEventInstanceId||phaseOverProof.ownerEventStep!==2||
				phaseOverProof.childEventInstanceId!==null&&(!state.nativePhaseOverTriggerEvent||
				 completionLedger.completionEvidence.get(state.nativePhaseOverTriggerEvent)?.eventInstanceId!==phaseOverProof.childEventInstanceId||
				 completionLedger.completionEvidence.get(state.nativePhaseOverTriggerEvent)?.completionOrdinal!==phaseOverProof.childCompletionOrdinal)||
				phaseProof.completionOrdinal>completionLedger.completionOrdinal)
				throw Error('NATIVE_ATOMIC_CAPTURE_COMPLETION_EVIDENCE_INVALID');
			let parent=loop,depth=0;while(parent&&parent!==state.root&&depth++<32)parent=parent.parent;
			if(parent!==state.root||depth>32)throw Error('NATIVE_ATOMIC_CAPTURE_EVENT_STACK_INVALID');
			const players=game.players,seatIds=command.seatIds;
			const registryEntries=Object.entries(core.lib?.cardOL||{}),registryByCard=new Map();
			for(const [id,card] of registryEntries){if(typeof id!=='string'||!id||registryByCard.has(card)||!(card instanceof Element)||!card.classList?.contains('card'))throw Error('NATIVE_ATOMIC_CAPTURE_CARD_REGISTRY_INVALID');registryByCard.set(card,id);}
			let sidecar=window.__v2NativeCardLedgerSidecar;
			if(!sidecar){sidecar={nonce:${JSON.stringify(managedCardSidecarNonce)},nextId:0,ids:new WeakMap()};Object.defineProperty(window,'__v2NativeCardLedgerSidecar',{value:sidecar,configurable:true});}
			if(sidecar.nonce!==${JSON.stringify(managedCardSidecarNonce)}||!(sidecar.ids instanceof WeakMap))throw Error('NATIVE_ATOMIC_CAPTURE_CARD_SIDECAR_INVALID');
			const cards=[],seenCards=new Set(),zoneTypes=[['h','hand'],['e','equipment'],['j','judgment'],['s','player_special'],['x','expansion']];
			const append=(card,zone,ownerSeatId,position)=>{if(!(card instanceof Element)||!card.classList?.contains('card')||seenCards.has(card))throw Error('NATIVE_ATOMIC_CAPTURE_CARD_INVALID');
				seenCards.add(card);const registered=registryByCard.get(card);if(card.cardid!==undefined&&card.cardid!==null&&typeof card.cardid!=='string'||registered&&card.cardid&&card.cardid!==registered)throw Error('NATIVE_ATOMIC_CAPTURE_CARD_ID_INVALID');
				let cardId=sidecar.ids.get(card);if(!cardId){cardId='native_card_'+sidecar.nonce+'_'+(++sidecar.nextId);sidecar.ids.set(card,cardId);}
				if(typeof card.name!=='string'||typeof card.xiBie!=='string'||!(typeof card.mingGe==='string'||Number.isSafeInteger(card.mingGe))||
					card.duYou!==undefined&&card.duYou!==null&&typeof card.duYou!=='string')throw Error('NATIVE_ATOMIC_CAPTURE_CARD_SOURCE_INVALID');
				cards.push({cardId,zone,ownerSeatId,position,name:card.name,xiBie:card.xiBie,mingGe:card.mingGe,
					duYou:card.duYou===undefined?null:card.duYou,kind:'physical_dom_card_v1'});};
			const appendGlobal=(node,zone)=>{if(!node)throw Error('NATIVE_ATOMIC_CAPTURE_ZONE_MISSING');Array.from(node.children).forEach((card,index)=>append(card,zone,null,index));};
			appendGlobal(core.ui?.cardPile,'draw');appendGlobal(core.ui?.discardPile,'discard');appendGlobal(core.ui?.ordering,'ordering');appendGlobal(core.ui?.special,'special');
			const allPlayers=[...players,...(game.dead||[])];if(allPlayers.length!==seatIds.length||new Set(allPlayers.map(player=>player.playerid)).size!==allPlayers.length||
				seatIds.some(id=>!allPlayers.some(player=>player.playerid===id)))throw Error('NATIVE_ATOMIC_CAPTURE_SEAT_SET_INVALID');
			for(const seatId of seatIds){const player=allPlayers.find(item=>item.playerid===seatId);for(const [slot,zone] of zoneTypes){const list=player.getCards(slot);if(!Array.isArray(list))throw Error('NATIVE_ATOMIC_CAPTURE_PLAYER_ZONE_INVALID');list.forEach((card,index)=>append(card,zone,seatId,index));}}
			const tracked=new Set([...allPlayers.flatMap(player=>zoneTypes.flatMap(([slot])=>player.getCards(slot))),...Array.from(core.ui.cardPile.children),
				...Array.from(core.ui.discardPile.children),...Array.from(core.ui.ordering.children),...Array.from(core.ui.special.children)]);
			if(registryEntries.some(([id,card])=>id!==registryByCard.get(card)||!tracked.has(card)||(card.cardid&&card.cardid!==id)))throw Error('NATIVE_ATOMIC_CAPTURE_UNASSIGNED_PHYSICAL_CARD');
			const effectSeats=seatIds.map(seatId=>{const player=allPlayers.find(item=>item.playerid===seatId);if(typeof player.hasSkill!=='function'||typeof player.countZhiShiWu!=='function')throw Error('NATIVE_ATOMIC_CAPTURE_EFFECT_SOURCE_INVALID');
				return {seatId,skills:player.hasSkill('yinYangZhanHuan')?[{id:'yinYangZhanHuan',present:true,source:'native_hasSkill'}]:[],guiHuo:player.countZhiShiWu('guiHuo')};});
			const actor=phase.player,loopActor=loop.player,quotas=actor?.storage,resources={hongShiQi:game.hongShiQi,lanShiQi:game.lanShiQi, hongXingBei:game.hongXingBei,lanXingBei:game.lanXingBei,
				hongZhanJi:game.hongZhanJi,lanZhanJi:game.lanZhanJi};
			if(!actor||actor!==fence.seatPlayer||actor.playerid!==fence.seatId||!loopActor||loopActor.playerid!==fence.nextActorSeatId||
				!seatIds.includes(actor.playerid)||!Array.isArray(quotas?.extraXingDong)||quotas.extraXingDong.length!==0||
				![quotas.gongJiOrFaShu,quotas.faShu,quotas.gongJi].every(Number.isSafeInteger)||
				![resources.hongShiQi,resources.lanShiQi,resources.hongXingBei,resources.lanXingBei].every(Number.isSafeInteger)||
				!Array.isArray(resources.hongZhanJi)||!Array.isArray(resources.lanZhanJi)||
				allPlayers.some(player=>player.hujia!==undefined||typeof player.changeHujia==='function'))throw Error('NATIVE_ATOMIC_CAPTURE_TURN_SOURCE_UNSUPPORTED');
			const seats=seatIds.map((seatId,position)=>{const player=allPlayers.find(item=>item.playerid===seatId),limit=player.getNengLiangLimit?.(),baoShi=player.countNengLiang?.('baoShi'),shuiJing=player.countNengLiang?.('shuiJing');
				if(typeof player.name1!=='string'||typeof player.side!=='boolean'||!Number.isSafeInteger(player.hp)||!Number.isSafeInteger(player.maxHp)||
					!Number.isSafeInteger(player.zhiLiao)||typeof player.isDead!=='function'||!Number.isSafeInteger(limit)||!Number.isSafeInteger(baoShi)||!Number.isSafeInteger(shuiJing))throw Error('NATIVE_ATOMIC_CAPTURE_PLAYER_SOURCE_UNSUPPORTED');
				return {seatId,position,character:player.name1,side:player.side,alive:!player.isDead(),hp:player.hp,maxHp:player.maxHp,zhiLiao:player.zhiLiao,
					hujiaSupported:false,nengLiang:{baoShi,shuiJing,effectiveLimit:limit}};});
			const nativeCompletionOrdinal=fence.nativeCompletionOrdinal,completionEvidence=fence.completionEvidence;
			const commonFence={allChildrenCompleted:true,boundaryOrdinal:fence.boundaryOrdinal,captureLocked:true,eventName:'phaseLoop',eventStep:3,eventStackConsistent:true,
				nativeCompletionOrdinal,completionEvidence,phaseOverCompletionEvidence:fence.phaseOverCompletionEvidence,
				phaseOverTriggerCount:fence.phaseOverTriggerCount,pendingChildCount:0,rootMatches:true,seatId:fence.seatId,nextActorSeatId:fence.nextActorSeatId};
			const turnResource={schema:'xingbei_native_private_turn_resource_state_v2',roomId:command.roomId,hostSessionId:command.hostSessionId,
				engineBuildId:command.engineBuildId,rootInstanceId:command.rootInstanceId,seatIds,
				fence:{kind:'managed_native_quiescent_fence_v1',rootMatches:true,eventStackConsistent:true,allChildrenCompleted:true,pendingChildCount:0,
					captureLocked:true,nativeCompletionOrdinal},turn:{phase:'between_turns',actorSeatId:actor.playerid,phaseLoopSeatId:loopActor.playerid,
					currentPhaseSeatId:null,gamePhaseNumber:game.phaseNumber,playerPhaseNumber:actor.phaseNumber,
					quotas:{gongJiOrFaShu:quotas.gongJiOrFaShu,faShu:quotas.faShu,gongJi:quotas.gongJi},extraActionQueueEmpty:true},resources,
				seats};
			return {schema:'xingbei_native_private_atomic_capture_v2',captureOrdinal:command.captureOrdinal,roomId:command.roomId,
				hostSessionId:command.hostSessionId,engineBuildId:command.engineBuildId,rootInstanceId:command.rootInstanceId,seatIds,
				fence:commonFence,cardLedger:{schema:'xingbei_native_private_card_ledger_v1',rootInstanceId:command.rootInstanceId,seatIds,cards},
				effectState:{schema:'xingbei_native_private_effect_state_v1',rootInstanceId:command.rootInstanceId,seatIds,seats:effectSeats},turnResource};})()`, returnByValue: true }, 5000);
		const envelope = result.result?.value;
		if (result.exceptionDetails) {
			const remoteDescriptor = `${result.exceptionDetails.exception?.description || ""} ${result.exceptionDetails.text || ""}`;
			const safeCode = remoteDescriptor.match(/\b(NATIVE_ATOMIC_CAPTURE_[A-Z0-9_]{1,80})\b/)?.[1];
			throw new Error(safeCode || "NATIVE_ATOMIC_CAPTURE_NATIVE_EXTRACTION_REJECTED");
		}
		if (!envelope || envelope.schema !== "xingbei_native_private_atomic_capture_v2" || envelope.captureOrdinal !== message.captureOrdinal)
			throw new Error("NATIVE_ATOMIC_CAPTURE_NATIVE_EXTRACTION_INVALID");
		process.send?.({ ...identity, type: "host_private_atomic_capture", requestId: message.requestId,
			captureOrdinal: message.captureOrdinal, envelope });
	} catch (error) {
		const code = /^NATIVE_ATOMIC_CAPTURE_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "NATIVE_ATOMIC_CAPTURE_NATIVE_EXTRACTION_FAILED";
		process.send?.({ ...identity, type: "host_private_atomic_capture_failed", requestId: message.requestId,
			captureOrdinal: message.captureOrdinal, code });
	}
}

async function snapshotNativePreActionCapture(message, successor = false) {
	const event8Successor = successor && message?.eventSequence === 8 && process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1" &&
		process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "8" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1";
	const event7Successor = successor && message?.eventSequence === 7 && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1" &&
		["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) &&
		(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") &&
		process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1";
	const event6Successor = successor && message?.eventSequence === 6 &&
		process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" &&
		(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === "6" ||
			["7", "8"].includes(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT) && process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1") &&
		(process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== "8" || process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") &&
		process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1";
	const successorSequence = event8Successor ? 8 : event7Successor ? 7 : event6Successor ? 6 : 5;
	const keys = successor
		? `${event6Successor || event7Successor || event8Successor ? "candidateOptionIds,candidateOptionKinds,captureOrdinal,engineBuildId,eventInstanceId,eventSequence,kind,nativeEventId,parentEventInstanceId,previousNativeEventId,previousSeatId,protocol,requestId,roomId,rootInstanceId,seatId,seatIds,secret,sessionId,type,waitingCompletionOrdinal" : "candidateOptionIds,candidateOptionKinds,captureOrdinal,engineBuildId,eventInstanceId,kind,nativeEventId,parentEventInstanceId,previousNativeEventId,previousSeatId,protocol,requestId,roomId,rootInstanceId,seatId,seatIds,secret,sessionId,type,waitingCompletionOrdinal"}`
		: "choiceId,engineBuildId,kind,nativeEventId,protocol,requestId,roomId,rootInstanceId,seatId,seatIds,secret,sessionId,type";
	const supportedFixture = process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1" ||
		(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") ||
		process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1";
	const commandRejectReasons = [
		process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" ? null : "probe_disabled",
		(supportedFixture || process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1") ? null : "fixture_not_supported",
		process.env.V2_NATIVE_START_DIAGNOSTICS === "1" ? null : "diagnostics_disabled",
		process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE === "1" ? null : "completion_ledger_disabled",
		process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" ? null : "network_guard_disabled",
		validHostCommand(message) ? null : "host_identity_mismatch",
		message.type === (event8Successor ? "host_native_event8_preaction_capture" : event7Successor ? "host_native_event7_preaction_capture" : event6Successor ? "host_native_event6_preaction_capture" : successor ? "host_native_successor_preaction_capture" : "host_native_pre_action_capture") ? null : "type_mismatch",
		Object.keys(message).sort().join(",") === keys ? null : "schema_mismatch",
		(successor ? (event8Successor ? /^event8pre_[a-f0-9]{32}$/ : event7Successor ? /^event7pre_[a-f0-9]{32}$/ : event6Successor ? /^event6pre_[a-f0-9]{32}$/ : /^successor_[a-f0-9]{32}$/) : /^preaction_[a-f0-9]{32}$/).test(message.requestId || "") ? null : "request_id_invalid",
		(successor ? (message.previousNativeEventId !== message.nativeEventId && /^native_[A-Za-z0-9_-]{16,96}$/.test(message.previousNativeEventId || "") &&
			(!event6Successor && !event7Successor && !event8Successor || message.eventSequence === successorSequence) &&
			Number.isSafeInteger(message.captureOrdinal) && message.captureOrdinal >= 1 && message.captureOrdinal <= 2 &&
			/^event_[1-9][0-9]{0,6}$/.test(message.eventInstanceId || "") && /^event_[1-9][0-9]{0,6}$/.test(message.parentEventInstanceId || "") &&
			Number.isSafeInteger(message.waitingCompletionOrdinal) && message.waitingCompletionOrdinal > 0 &&
			/^[A-Za-z0-9_-]{1,64}$/.test(message.previousSeatId || "") && Array.isArray(message.candidateOptionIds) &&
			message.candidateOptionIds.length > 0 && message.candidateOptionIds.length <= 64 && new Set(message.candidateOptionIds).size === message.candidateOptionIds.length &&
			message.candidateOptionIds.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) && message.candidateOptionKinds &&
			Object.getPrototypeOf(message.candidateOptionKinds) === Object.prototype && Object.keys(message.candidateOptionKinds).sort().join(",") === [...message.candidateOptionIds].sort().join(",") &&
			Object.values(message.candidateOptionKinds).every(kind => kind === "gongJi" || kind === "faShu")) : /^choice_[a-f0-9]{32}$/.test(message.choiceId || "")) ? null : "choice_or_candidate_invalid",
		/^native_[A-Za-z0-9_-]{16,96}$/.test(message.nativeEventId || "") ? null : "native_event_id_invalid",
		managedEngineBuildId && message.engineBuildId === managedEngineBuildId ? null : "build_mismatch",
		/^native_root_[A-Za-z0-9_-]{16,96}$/.test(message.rootInstanceId || "") ? null : "root_id_invalid",
		Array.isArray(message.seatIds) && message.seatIds.length === 4 && JSON.stringify(message.seatIds) === JSON.stringify(managedSeatIds) ? null : "seat_order_mismatch",
		Array.isArray(message.seatIds) && message.seatIds.includes(message.seatId) ? null : "seat_id_invalid",
		cdp ? null : "cdp_unavailable",
	].filter(Boolean);
	if (commandRejectReasons.length) {
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
			observed: { kind: "native_start_diagnostic", stage: "native_preaction_command_rejected", failureCode: "NATIVE_PREACTION_CAPTURE_COMMAND_REJECTED",
				reasons: commandRejectReasons, seatIdCount: Array.isArray(message.seatIds) ? message.seatIds.length : null,
				managedSeatCount: Array.isArray(managedSeatIds) ? managedSeatIds.length : null,
				seatSetMatches: Array.isArray(message.seatIds) && Array.isArray(managedSeatIds) && message.seatIds.length === managedSeatIds.length &&
					message.seatIds.every(id => managedSeatIds.includes(id)) } });
		throw new Error("NATIVE_PREACTION_CAPTURE_COMMAND_REJECTED");
	}
	const command = { successor, roomId: message.roomId, hostSessionId: message.sessionId, engineBuildId: message.engineBuildId,
		rootInstanceId: message.rootInstanceId, seatIds: message.seatIds, nativeEventId: message.nativeEventId,
		eventInstanceId: successor ? message.eventInstanceId : null, parentEventInstanceId: successor ? message.parentEventInstanceId : null,
		waitingCompletionOrdinal: successor ? message.waitingCompletionOrdinal : null,
		choiceId: successor ? null : message.choiceId, seatId: message.seatId,
		previousNativeEventId: successor ? message.previousNativeEventId : null, previousSeatId: successor ? message.previousSeatId : null,
				candidateOptionIds: successor ? message.candidateOptionIds : null, candidateOptionKinds: successor ? message.candidateOptionKinds : null,
		captureOrdinal: successor ? message.captureOrdinal : 1, eventSequence: successorSequence };
	try {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{
			const command=${JSON.stringify(command)},event6Successor=${JSON.stringify(event6Successor)},event7Successor=${JSON.stringify(event7Successor)},event8Successor=${JSON.stringify(event8Successor)},state=window.__v2NativeStartDiagnosticState,managed=window.__v2ManagedEngine,
				core=managed?.core,game=core?.game,status=core?._status,manager=status?.eventManager,gate=state?.nativeInputResumeGate,
				event=gate?.event,ledger=state?.nativeEventCompletionLedger;
			if(!state||!game||!status||!manager||manager.rootEvent!==state.root||manager.rootEvent?.name!=='game'||game.me!==null||
				state.rootInstanceId!==command.rootInstanceId||!Array.isArray(game.players)||game.players.length!==4||game.players.some(player=>player.ws)||
				new Set(game.players.map(player=>player.playerid)).size!==4||command.seatIds.some(id=>!game.players.some(player=>player.playerid===id)))
				throw Error('NATIVE_PREACTION_CAPTURE_ROOT_OR_SEATS_INVALID');
			const event5CaptureChecks={mode:command.successor===true&&${JSON.stringify(successor && (event8Successor ? experimentalAuthorityEventEnabled(8) : event7Successor ? experimentalAuthorityEventEnabled(7) : event6Successor ? experimentalAuthorityEventEnabled(6) : experimentalAuthorityEventEnabled(5)))},
				opt_in:${JSON.stringify(event8Successor ? experimentalAuthorityEventEnabled(8) : event7Successor ? experimentalAuthorityEventEnabled(7) : event6Successor ? experimentalAuthorityEventEnabled(6) : experimentalAuthorityEventEnabled(5))},
				network_guard:${JSON.stringify(process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1")},
				controller_gate:gate?.controllerManaged===true,sequence:gate?.eventSequence===command.eventSequence,status:gate?.status==='waiting',
				opened:event8Successor?state.event8ManagedGateOpened===true:event7Successor?state.event7ManagedGateOpened===true:event6Successor?state.event6ManagedGateOpened===true:state.event5ManagedGateOpened===true,state_event:state.nativeInputGate?.nativeEventId===command.nativeEventId,
				state_sequence:state.nativeInputGate?.eventSequence===command.eventSequence,state_waiting:state.nativeInputGate?.waiting===true,
				unused:state.nativeInputGate?.useResultCount===0,send_once:gate?.nativeSendCount===1,
				no_applied_action:state.nativeAction?.eventId!==command.nativeEventId};
			const event5SuccessorCapture=Object.values(event5CaptureChecks).every(value=>value===true);
			const gateKindValid=command.successor?
				(gate?.diagnosticOnly===true&&state.nativeInputGate?.diagnosticOnly===true)||event5SuccessorCapture:
				gate?.controllerManaged===true&&state.nativeInputGate?.diagnosticOnly!==true;
			const advertisedCandidates=command.successor?state.nativeInputGate?.candidates?.filter(item=>typeof item?.targetSeatId==='string'&&
				item.targetSeatId!==command.seatId):state.nativeInputGate?.candidates;
			const gateChecks={gate_present:Boolean(gate),gate_waiting:gate?.status==='waiting',gate_kind:gateKindValid,
				gate_event_id:gate?.nativeEventId===command.nativeEventId,gate_seat:gate?.seatId===command.seatId,
				event_present:Boolean(event),event_identity:event===state.inputEvent&&event?.__v2NativeEventId===command.nativeEventId,
				event_contract:event?.name==='gongJiOrFaShu'&&event?.player?.playerid===command.seatId,
				state_waiting:state.nativeInputGate?.waiting===true,state_event_id:state.nativeInputGate?.nativeEventId===command.nativeEventId,
				state_seat:state.nativeInputGate?.seatId===command.seatId,paused:status.paused===true,event_stack:manager.eventStack.at(-1)===event,
				result_unapplied:event?.result===undefined||event.result==='ai',action_unapplied:state.nativeAction?.eventId!==command.nativeEventId,
				use_result_unapplied:state.nativeInputGate?.useResultCount===0};
			if(command.successor)Object.assign(gateChecks,{previous_event_distinct:command.previousNativeEventId!==command.nativeEventId,
				previous_seat_distinct:command.previousSeatId!==command.seatId,candidate_ids_array:Array.isArray(command.candidateOptionIds)&&Array.isArray(state.nativeInputGate?.candidates),
				event_predecessor:event8Successor?state.event7AuthorityAccepted===true&&state.event7ActorSeatId===command.previousSeatId&&state.nativeInputGate?.eventSequence===8:
					event7Successor?state.event6AuthorityAccepted===true&&state.event6ActorSeatId===command.previousSeatId&&state.nativeInputGate?.eventSequence===7:
					!event6Successor||state.event5AuthorityAccepted===true&&state.event5ActorSeatId===command.previousSeatId&&state.nativeInputGate?.eventSequence===6,
				candidate_ids_match:Array.isArray(command.candidateOptionIds)&&Array.isArray(advertisedCandidates)&&
				JSON.stringify(advertisedCandidates.map(item=>item.optionId))===JSON.stringify(command.candidateOptionIds),
				candidate_kinds_match:Array.isArray(advertisedCandidates)&&
				JSON.stringify(Object.fromEntries(advertisedCandidates.map(item=>[item.optionId,item.cardType])))===JSON.stringify(command.candidateOptionKinds)});
			const failedGateCheck=Object.keys(gateChecks).find(key=>gateChecks[key]!==true);
			if(failedGateCheck==='gate_kind'){const failedEvent5GateCheck=Object.keys(event5CaptureChecks).find(key=>event5CaptureChecks[key]!==true);
				throw Error('NATIVE_PREACTION_CAPTURE_INPUT_GATE_INVALID_'+(failedEvent5GateCheck?failedEvent5GateCheck.toUpperCase():'EVENT5_GATE_KIND'))}
			if(failedGateCheck)throw Error('NATIVE_PREACTION_CAPTURE_INPUT_GATE_INVALID_'+failedGateCheck.toUpperCase());
			const names=['game','phaseLoop','phase','xingDong','gongJiOrFaShu'],chain=[];let current=event;
			while(current&&chain.length<6){chain.push(current);current=current.parent;}
			chain.reverse();
			if(chain.length!==5||chain.some((item,index)=>item.name!==names[index])||chain[0]!==state.root||chain[1]!==state.phaseLoop||
				chain[2].parent!==chain[1]||chain[3].parent!==chain[2]||chain[4].parent!==chain[3])throw Error('NATIVE_PREACTION_CAPTURE_PARENT_CHAIN_INVALID');
			const stack=manager.eventStack;if(stack.at(-1)!==event||names.some((name,index)=>stack.findIndex(item=>item===chain[index])<0)||
				names.some((name,index)=>index>0&&stack.indexOf(chain[index-1])>=stack.indexOf(chain[index])))throw Error('NATIVE_PREACTION_CAPTURE_EVENT_STACK_INVALID');
			const descendants=root=>{const seen=new WeakSet(),allowed=new Set(chain);let pendingInput=0,runnable=0,nodes=0,overflow=false;
				const walk=node=>{if(!node||typeof node!=='object'||seen.has(node))return;seen.add(node);if(++nodes>4096){overflow=true;return}
					if(node!==root&&node.finished!==true){if(node===event)pendingInput++;else if(!allowed.has(node))runnable++}
					for(const child of [...(Array.isArray(node.childEvents)?node.childEvents:[]),...(Array.isArray(node.next)?node.next:[])])walk(child)};
				walk(root);return {pendingInput,runnable,nodes,overflow}};
			const pending=descendants(state.root);if(pending.overflow||pending.pendingInput!==1||pending.runnable!==0)throw Error('NATIVE_PREACTION_CAPTURE_PENDING_DESCENDANT_INVALID');
			if(!ledger||ledger.rootEvent!==state.root||ledger.rootInstanceId!==command.rootInstanceId||!Number.isSafeInteger(ledger.completionOrdinal)||
				ledger.completionOrdinal<1)throw Error('NATIVE_PREACTION_CAPTURE_COMPLETION_LEDGER_INVALID');
			const ids=chain.map(item=>{const id=ledger.eventIds.get(item);if(!id)throw Error('NATIVE_PREACTION_CAPTURE_EVENT_INSTANCE_MISSING_'+String(names[chain.indexOf(item)]||'UNKNOWN').toUpperCase());return id});
			if(command.successor&&(ids[4]!==command.eventInstanceId||ids[3]!==command.parentEventInstanceId||ledger.completionOrdinal!==command.waitingCompletionOrdinal))
				throw Error('NATIVE_PREACTION_CAPTURE_INSTANCE_PROVENANCE_MISMATCH');
			const parentChain=chain.map((item,index)=>({eventName:item.name,eventInstanceId:ids[index],step:Number.isSafeInteger(item.step)?item.step:0,
				seatId:item.player?.playerid||null,finished:item.finished===true}));
			const seatIds=command.seatIds,players=game.players,registryEntries=Object.entries(core.lib?.cardOL||{}),registryByCard=new Map();
			for(const [id,card] of registryEntries){if(typeof id!=='string'||!id||registryByCard.has(card)||!(card instanceof Element)||!card.classList?.contains('card'))throw Error('NATIVE_PREACTION_CAPTURE_CARD_REGISTRY_INVALID');registryByCard.set(card,id)}
			let sidecar=window.__v2NativeCardLedgerSidecar;if(!sidecar){sidecar={nonce:${JSON.stringify(managedCardSidecarNonce)},nextId:0,ids:new WeakMap()};Object.defineProperty(window,'__v2NativeCardLedgerSidecar',{value:sidecar,configurable:true})}
			if(sidecar.nonce!==${JSON.stringify(managedCardSidecarNonce)}||!(sidecar.ids instanceof WeakMap))throw Error('NATIVE_PREACTION_CAPTURE_CARD_SIDECAR_INVALID');
			const cards=[],seen=new Set(),zoneTypes=[['h','hand'],['e','equipment'],['j','judgment'],['s','player_special'],['x','expansion']];
			const append=(card,zone,ownerSeatId,position)=>{if(!(card instanceof Element)||!card.classList?.contains('card')||seen.has(card))throw Error('NATIVE_PREACTION_CAPTURE_CARD_INVALID');seen.add(card);
				const registered=registryByCard.get(card);if(card.cardid!==undefined&&card.cardid!==null&&typeof card.cardid!=='string'||registered&&card.cardid&&card.cardid!==registered)throw Error('NATIVE_PREACTION_CAPTURE_CARD_ID_INVALID');
				let cardId=sidecar.ids.get(card);if(!cardId){cardId='native_card_'+sidecar.nonce+'_'+(++sidecar.nextId);sidecar.ids.set(card,cardId)}
				if(typeof card.name!=='string'||typeof card.xiBie!=='string'||!(typeof card.mingGe==='string'||Number.isSafeInteger(card.mingGe))||card.duYou!==undefined&&card.duYou!==null&&typeof card.duYou!=='string')throw Error('NATIVE_PREACTION_CAPTURE_CARD_SOURCE_INVALID');
				cards.push({cardId,zone,ownerSeatId,position,name:card.name,xiBie:card.xiBie,mingGe:card.mingGe,duYou:card.duYou===undefined?null:card.duYou,kind:'physical_dom_card_v1'})};
			const appendGlobal=(node,zone)=>{if(!node)throw Error('NATIVE_PREACTION_CAPTURE_ZONE_MISSING');Array.from(node.children).forEach((card,index)=>append(card,zone,null,index))};
			appendGlobal(core.ui?.cardPile,'draw');appendGlobal(core.ui?.discardPile,'discard');appendGlobal(core.ui?.ordering,'ordering');appendGlobal(core.ui?.special,'special');
			const allPlayers=[...players,...(game.dead||[])];if(allPlayers.length!==seatIds.length||new Set(allPlayers.map(player=>player.playerid)).size!==allPlayers.length||seatIds.some(id=>!allPlayers.some(player=>player.playerid===id)))throw Error('NATIVE_PREACTION_CAPTURE_SEAT_SET_INVALID');
			for(const seatId of seatIds){const player=allPlayers.find(item=>item.playerid===seatId);for(const [slot,zone] of zoneTypes){const list=player.getCards(slot);if(!Array.isArray(list))throw Error('NATIVE_PREACTION_CAPTURE_PLAYER_ZONE_INVALID');list.forEach((card,index)=>append(card,zone,seatId,index))}}
			const tracked=new Set([...allPlayers.flatMap(player=>zoneTypes.flatMap(([slot])=>player.getCards(slot))),...Array.from(core.ui.cardPile.children),
				...Array.from(core.ui.discardPile.children),...Array.from(core.ui.ordering.children),...Array.from(core.ui.special.children)]);
			if(registryEntries.some(([id,card])=>id!==registryByCard.get(card)||!tracked.has(card)||(card.cardid&&card.cardid!==id)))throw Error('NATIVE_PREACTION_CAPTURE_UNASSIGNED_PHYSICAL_CARD');
			const effectSeats=seatIds.map(seatId=>{const player=allPlayers.find(item=>item.playerid===seatId);if(typeof player.hasSkill!=='function'||typeof player.countZhiShiWu!=='function')throw Error('NATIVE_PREACTION_CAPTURE_EFFECT_SOURCE_INVALID');
				return {seatId,skills:player.hasSkill('yinYangZhanHuan')?[{id:'yinYangZhanHuan',present:true,source:'native_hasSkill'}]:[],guiHuo:player.countZhiShiWu('guiHuo')}});
			const actor=event.player,loopActor=state.phaseLoop?.player,quotas=actor?.storage,resources={hongShiQi:game.hongShiQi,lanShiQi:game.lanShiQi,
				hongXingBei:game.hongXingBei,lanXingBei:game.lanXingBei,hongZhanJi:game.hongZhanJi,lanZhanJi:game.lanZhanJi};
			if(actor?.playerid!==command.seatId||loopActor!==actor||status.currentPhase!==actor||!Array.isArray(quotas?.extraXingDong)||quotas.extraXingDong.length!==0||
				![quotas.gongJiOrFaShu,quotas.faShu,quotas.gongJi].every(Number.isSafeInteger)||![resources.hongShiQi,resources.lanShiQi,resources.hongXingBei,resources.lanXingBei].every(Number.isSafeInteger)||
				!Array.isArray(resources.hongZhanJi)||!Array.isArray(resources.lanZhanJi)||allPlayers.some(player=>player.hujia!==undefined||typeof player.changeHujia==='function'))
				throw Error('NATIVE_PREACTION_CAPTURE_TURN_SOURCE_UNSUPPORTED');
			const seats=seatIds.map((seatId,position)=>{const player=allPlayers.find(item=>item.playerid===seatId),limit=player.getNengLiangLimit?.(),baoShi=player.countNengLiang?.('baoShi'),shuiJing=player.countNengLiang?.('shuiJing');
				if(typeof player.name1!=='string'||typeof player.side!=='boolean'||!Number.isSafeInteger(player.hp)||!Number.isSafeInteger(player.maxHp)||!Number.isSafeInteger(player.zhiLiao)||
					typeof player.isDead!=='function'||!Number.isSafeInteger(limit)||!Number.isSafeInteger(baoShi)||!Number.isSafeInteger(shuiJing))throw Error('NATIVE_PREACTION_CAPTURE_PLAYER_SOURCE_UNSUPPORTED');
				return {seatId,position,character:player.name1,side:player.side,alive:!player.isDead(),hp:player.hp,maxHp:player.maxHp,zhiLiao:player.zhiLiao,hujiaSupported:false,nengLiang:{baoShi,shuiJing,effectiveLimit:limit}}});
			const fence=command.successor?{captureLockKind:'successor_native_gate_v1',candidateOptionIds:[...command.candidateOptionIds],
				candidateOptionKinds:{...command.candidateOptionKinds},choiceAllocated:false,controllerStatus:'not_allocated',deliveryCount:0,
				eventInstanceId:ids[4],eventName:event.name,eventStep:event.step,eventStackConsistent:true,gamePaused:true,inputWaiting:true,
				nativeCompletionOrdinal:ledger.completionOrdinal,nativeEventId:command.nativeEventId,parentChain,pendingInputCount:1,
				previousNativeEventId:command.previousNativeEventId,previousSeatId:command.previousSeatId,rootEventInstanceId:ids[0],rootMatches:true,
				runnableDescendantCount:0,seatId:command.seatId,useCardChildCount:0,useResultCount:0}:
				{captureLockKind:'single_turn_native_task_v1',choiceId:command.choiceId,controllerStatus:'pending',deliveryCount:0,eventInstanceId:ids[4],eventName:event.name,eventStep:event.step,
				eventStackConsistent:true,gamePaused:true,inputWaiting:true,nativeCompletionOrdinal:ledger.completionOrdinal,nativeEventId:command.nativeEventId,
				parentChain,pendingInputCount:1,rootEventInstanceId:ids[0],rootMatches:true,runnableDescendantCount:0,resultPresent:false,seatId:command.seatId,
				useCardChildCount:0,useResultCount:0};
			return {schema:command.successor?'xingbei_native_private_successor_preaction_capture_v1':'xingbei_native_private_pre_action_capture_v1',captureOrdinal:command.captureOrdinal,roomId:command.roomId,hostSessionId:command.hostSessionId,
				engineBuildId:command.engineBuildId,rootInstanceId:command.rootInstanceId,seatIds,fence:{...fence},cardLedger:{schema:'xingbei_native_private_card_ledger_v1',rootInstanceId:command.rootInstanceId,seatIds,cards},
				effectState:{schema:'xingbei_native_private_effect_state_v1',rootInstanceId:command.rootInstanceId,seatIds,seats:effectSeats},
				turnResource:{schema:'xingbei_native_private_turn_resource_state_v2',roomId:command.roomId,hostSessionId:command.hostSessionId,
					engineBuildId:command.engineBuildId,rootInstanceId:command.rootInstanceId,seatIds,fence:{kind:'managed_native_input_waiting_fence_v1',
						rootMatches:true,eventStackConsistent:true,allChildrenCompleted:false,pendingChildCount:1,captureLocked:true,nativeCompletionOrdinal:ledger.completionOrdinal},
					turn:{phase:'xingDong',actorSeatId:actor.playerid,phaseLoopSeatId:loopActor.playerid,currentPhaseSeatId:status.currentPhase.playerid,
						gamePhaseNumber:game.phaseNumber,playerPhaseNumber:actor.phaseNumber,quotas:{gongJiOrFaShu:quotas.gongJiOrFaShu,faShu:quotas.faShu,gongJi:quotas.gongJi},extraActionQueueEmpty:true},resources,seats}}})();`, returnByValue: true }, 5000);
		const envelope = result.result?.value;
		if (result.exceptionDetails) {
			const detail = `${result.exceptionDetails.text || ""} ${result.exceptionDetails.exception?.description || ""}`;
			const code = detail.match(/\b(NATIVE_PREACTION_CAPTURE_[A-Z0-9_]{1,80})\b/)?.[1];
			throw new Error(code || "NATIVE_PREACTION_CAPTURE_NATIVE_EXTRACTION_REJECTED");
		}
		if (!envelope || envelope.schema !== (successor ? "xingbei_native_private_successor_preaction_capture_v1" : "xingbei_native_private_pre_action_capture_v1") || envelope.captureOrdinal !== command.captureOrdinal)
			throw new Error("NATIVE_PREACTION_CAPTURE_NATIVE_EXTRACTION_INVALID");
		process.send?.({ ...identity, type: event8Successor ? "host_private_event8_preaction_capture" : event7Successor ? "host_private_event7_preaction_capture" : event6Successor ? "host_private_event6_preaction_capture" :
			successor ? "host_private_successor_preaction_capture" : "host_private_pre_action_capture", requestId: message.requestId, envelope });
	} catch (error) {
		const prefix = event8Successor ? "EVENT8_PREACTION" : event7Successor ? "EVENT7_PREACTION" : event6Successor ? "EVENT6_PREACTION" : successor ? "SUCCESSOR_PREACTION" : "NATIVE_PREACTION_CAPTURE";
		const messageCode = error?.message || "";
		const code = new RegExp(`^${prefix}_[A-Z0-9_]{1,80}$`).test(messageCode) ? messageCode :
			(successor && /^NATIVE_PREACTION_CAPTURE_[A-Z0-9_]{1,80}$/.test(messageCode)
				? `SUCCESSOR_PREACTION_${messageCode.slice("NATIVE_PREACTION_CAPTURE_".length)}` : `${prefix}_NATIVE_EXTRACTION_FAILED`);
		process.send?.({ ...identity, type: event8Successor ? "host_private_event8_preaction_capture_failed" : event7Successor ? "host_private_event7_preaction_capture_failed" : event6Successor ? "host_private_event6_preaction_capture_failed" :
			successor ? "host_private_successor_preaction_capture_failed" : "host_private_pre_action_capture_failed", requestId: message.requestId, code });
	}
}

async function snapshotNativeEffectState(message) {
	const keys = "captureBoundary,engineBuildId,kind,mode,nativeCompletionOrdinal,nativeEventId,protocol,requestId,roomId,rootInstanceId,schema,seatId,seatIds,secret,sessionId,type";
	if (process.env.V2_NATIVE_EFFECT_STATE_PROBE !== "1" || process.env.V2_NATIVE_YINYANG_FIXTURE !== "1" ||
		process.env.V2_NATIVE_MANAGED_YINYANG !== "1" || process.env.V2_NATIVE_MANAGED_RESPONSE !== "1" ||
		process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
		process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1") throw new Error("NATIVE_EFFECT_STATE_PROCESS_GATE_CLOSED");
	if (!validHostCommand(message)) throw new Error("NATIVE_EFFECT_STATE_COMMAND_IDENTITY_INVALID");
	if (!message || Object.getPrototypeOf(message) !== Object.prototype || Object.keys(message).sort().join(",") !== keys)
		throw new Error("NATIVE_EFFECT_STATE_COMMAND_KEYS_INVALID");
	if (message.type !== "host_native_effect_state_snapshot" || !/^effect_[a-f0-9]{32}$/.test(message.requestId || "") ||
		!["before_native_response", "after_native_response", "repeat_native_response"].includes(message.mode))
		throw new Error("NATIVE_EFFECT_STATE_COMMAND_REQUEST_INVALID");
	if (message.schema !== EFFECT_STATE_SCHEMA || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(message.rootInstanceId || "") ||
		!/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(message.seatId || ""))
		throw new Error("NATIVE_EFFECT_STATE_COMMAND_BINDING_INVALID");
	if (!managedEngineBuildId || message.engineBuildId !== managedEngineBuildId) throw new Error("NATIVE_EFFECT_STATE_BUILD_INVALID");
	if (!Array.isArray(managedSeatIds) || !Array.isArray(message.seatIds) || JSON.stringify(message.seatIds) !== JSON.stringify(managedSeatIds))
		throw new Error("NATIVE_EFFECT_STATE_SEATS_INVALID");
	if (!cdp) throw new Error("NATIVE_EFFECT_STATE_CDP_UNAVAILABLE");
	const request = { requestId: message.requestId, mode: message.mode, nativeEventId: message.nativeEventId,
		seatId: message.seatId, nativeCompletionOrdinal: message.nativeCompletionOrdinal, captureBoundary: message.captureBoundary,
		rootInstanceId: message.rootInstanceId, engineBuildId: message.engineBuildId, seatIds: message.seatIds };
	try {
		const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{
			const command=${JSON.stringify(request)},state=window.__v2NativeStartDiagnosticState,managed=window.__v2ManagedEngine,
				core=managed?.core,game=core?.game,status=core?._status,manager=status?.eventManager;
			if(!state||!game||!status||!manager||manager.rootEvent!==state.root||state.rootInstanceId!==command.rootInstanceId||
				state.rootInstanceId==null||manager.rootEvent.name!=='game'||game.me!==null||!Array.isArray(game.players)||
				game.players.length!==4||game.players.some(player=>player.ws)||command.seatIds.length!==4||
				new Set(game.players.map(player=>player.playerid)).size!==4||command.seatIds.some(seatId=>!game.players.some(player=>player.playerid===seatId)))
				throw Error('NATIVE_EFFECT_STATE_ROOT_OR_SEATS_INVALID');
			const gate=state.managedNativeResponseGates?.get(command.nativeEventId);
			let actionParent=null,rootReached=false;for(let parent=gate?.event?.parent,count=0;parent&&count<24;parent=parent.parent,count++){
				if(parent.name==='gongJiOrFaShu'&&parent.__v2NativeEventId===gate.actionEventId)actionParent=parent;
				if(parent===state.root)rootReached=true;
			}
			if(!gate)throw Error('NATIVE_EFFECT_STATE_GATE_MISSING');
			if(gate.nativeEventId!==command.nativeEventId||gate.event?.__v2NativeEventId!==command.nativeEventId)
				throw Error('NATIVE_EFFECT_STATE_EVENT_ID_BINDING_INVALID');
			if(gate.seatId!==command.seatId)throw Error('NATIVE_EFFECT_STATE_GATE_SEAT_BINDING_INVALID_'+command.seatIds.indexOf(command.seatId)+'_'+command.seatIds.indexOf(gate.seatId));
			if(gate.event?.player?.playerid!==command.seatId)throw Error('NATIVE_EFFECT_STATE_PLAYER_SEAT_BINDING_INVALID');
			if(gate.event?.name!=='yingZhan')throw Error('NATIVE_EFFECT_STATE_EVENT_KIND_BINDING_INVALID');
			if(!gate.actionEventId||!actionParent)throw Error('NATIVE_EFFECT_STATE_ACTION_BINDING_INVALID');
			if(gate.rootInstanceId!==command.rootInstanceId||gate.rootEvent!==state.root||!rootReached)
				throw Error('NATIVE_EFFECT_STATE_ROOT_BINDING_INVALID');
			const player=game.players.find(item=>item.playerid===command.seatId);
			if(!player||typeof player.hasSkill!=='function'||typeof player.countZhiShiWu!=='function')throw Error('NATIVE_EFFECT_STATE_NATIVE_SOURCE_INVALID');
			if(command.mode==='before_native_response'){
				const hasNativeSkillOption=[...gate.options.values()].some(option=>option?.kind==='view_as_skill'&&option.skillId==='yinYangZhanHuan'&&option.seatId===command.seatId);
				if(command.captureBoundary!=='native_response_waiting'||command.nativeCompletionOrdinal!==null||gate.status!=='waiting'||
					!gate.waitEvent||gate.waitResolved===true||gate.delivery||gate.useCardChildrenStarted!==0||gate.useCardChildrenCompleted!==0||
					!hasNativeSkillOption||!player.hasSkill('yinYangZhanHuan'))throw Error('NATIVE_EFFECT_STATE_PRE_EVENT_FENCE_INVALID');
			}else{
				const completion=gate.completedResult,fence=gate.nativeCompletionFence;
				if(command.captureBoundary!=='native_response_completed'||!Number.isSafeInteger(command.nativeCompletionOrdinal)||command.nativeCompletionOrdinal<1)
					throw Error('NATIVE_EFFECT_STATE_COMPLETION_COMMAND_INVALID');
				if(gate.status!=='applied'||!completion||completion.nativeCompletionOrdinal!==command.nativeCompletionOrdinal||
					completion.selectedKind!=='view_as_skill'||completion.skillId!=='yinYangZhanHuan'||completion.bool!==true||
					completion.useCardChildrenStarted!==1||completion.useCardChildrenCompleted!==1)
					throw Error('NATIVE_EFFECT_STATE_NATIVE_RESULT_INVALID');
				if(gate.nativeSkillEffectProof?.childName!=='useCard'||gate.nativeSkillEffectProof?.skillId!=='yinYangZhanHuan'||
					gate.nativeSkillEffectProof?.materialIsSource!==true||gate.nativeSkillEffectProof?.materialStillInHand!==false||
					!Number.isSafeInteger(gate.nativeSkillEffectProof?.guiHuoAfter)||gate.nativeSkillEffectProof.guiHuoAfter<=gate.nativeSkillEffectProof.guiHuoBefore)
					throw Error('NATIVE_EFFECT_STATE_NATIVE_EFFECT_PROOF_INVALID');
				if(!fence||fence.nativeEventId!==command.nativeEventId||fence.seatId!==command.seatId||fence.eventInstance!==gate.event||
					fence.rootEvent!==state.root||fence.rootInstanceId!==command.rootInstanceId||fence.useCardChildrenCompleted!==1)
					throw Error('NATIVE_EFFECT_STATE_COMPLETION_FENCE_INVALID');
				if(fence.rootObjectMatches!==true)throw Error('NATIVE_EFFECT_STATE_COMPLETION_TRACE_ROOT_INVALID');
				if(fence.gameMeAbsent!==true)throw Error('NATIVE_EFFECT_STATE_COMPLETION_TRACE_HOST_PLAYER_INVALID');
			}
			const seats=command.seatIds.map(seatId=>{const nativePlayer=game.players.find(item=>item.playerid===seatId);
				const present=nativePlayer.hasSkill('yinYangZhanHuan'),guiHuo=nativePlayer.countZhiShiWu('guiHuo');
				if(typeof present!=='boolean'||!Number.isSafeInteger(guiHuo)||guiHuo<0||guiHuo>3)throw Error('NATIVE_EFFECT_STATE_VALUE_INVALID');
				return {seatId,guiHuo,skills:present?[{id:'yinYangZhanHuan',present:true,source:'native_hasSkill'}]:[]};});
			return {schema:${JSON.stringify(EFFECT_STATE_SCHEMA)},rootInstanceId:state.rootInstanceId,seatIds:command.seatIds,seats};})()`, returnByValue: true }, 2500);
		const snapshot=result.result?.value;
		if(result.exceptionDetails){
			const detail=`${result.exceptionDetails.text||""} ${result.exceptionDetails.exception?.description||""}`;
			const allowed=["NATIVE_EFFECT_STATE_ROOT_OR_SEATS_INVALID","NATIVE_EFFECT_STATE_GATE_MISSING","NATIVE_EFFECT_STATE_EVENT_ID_BINDING_INVALID",
				"NATIVE_EFFECT_STATE_GATE_SEAT_BINDING_INVALID","NATIVE_EFFECT_STATE_PLAYER_SEAT_BINDING_INVALID",
				"NATIVE_EFFECT_STATE_EVENT_SEAT_BINDING_INVALID","NATIVE_EFFECT_STATE_EVENT_KIND_BINDING_INVALID","NATIVE_EFFECT_STATE_EVENT_BINDING_INVALID",
				"NATIVE_EFFECT_STATE_ACTION_BINDING_INVALID","NATIVE_EFFECT_STATE_ROOT_BINDING_INVALID","NATIVE_EFFECT_STATE_NATIVE_SOURCE_INVALID",
				"NATIVE_EFFECT_STATE_PRE_EVENT_FENCE_INVALID","NATIVE_EFFECT_STATE_COMPLETION_COMMAND_INVALID","NATIVE_EFFECT_STATE_NATIVE_RESULT_INVALID",
				"NATIVE_EFFECT_STATE_NATIVE_EFFECT_PROOF_INVALID","NATIVE_EFFECT_STATE_COMPLETION_TRACE_MISSING",
				"NATIVE_EFFECT_STATE_COMPLETION_TRACE_ROOT_INVALID","NATIVE_EFFECT_STATE_COMPLETION_TRACE_HOST_PLAYER_INVALID",
				"NATIVE_EFFECT_STATE_COMPLETION_TRACE_INVALID",
				"NATIVE_EFFECT_STATE_COMPLETION_FENCE_INVALID","NATIVE_EFFECT_STATE_VALUE_INVALID"];
			throw new Error(detail.match(/NATIVE_EFFECT_STATE_GATE_SEAT_BINDING_INVALID_-?\d+_-?\d+/)?.[0]||
				allowed.find(code=>detail.includes(code))||"NATIVE_EFFECT_STATE_CDP_EXCEPTION");
		}
		if(snapshot?.schema!==EFFECT_STATE_SCHEMA)throw new Error("NATIVE_EFFECT_STATE_CAPTURE_FAILED");
		if (process.env.V2_NATIVE_EFFECT_STOP_BARRIER === "1" && message.mode === "before_native_response") {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: message.nativeEventId,
				observed: { stage: "native_effect_snapshot_captured_before_delivery", nativeEventId: message.nativeEventId,
					captureBoundary: message.captureBoundary } });
			const continueDelivery = await new Promise(resolve => { nativeEffectSnapshotStopBarrier = { release: resolve }; });
			nativeEffectSnapshotStopBarrier = null;
			if (!continueDelivery) throw new Error("NATIVE_EFFECT_STATE_STOPPED_BEFORE_DELIVERY");
		}
		process.send?.({ ...identity, type:"host_private_native_effect_state", requestId:message.requestId, mode:message.mode,
			nativeEventId:message.nativeEventId, seatId:message.seatId, nativeCompletionOrdinal:message.nativeCompletionOrdinal,
			captureBoundary:message.captureBoundary, schema:EFFECT_STATE_SCHEMA, snapshot });
	} catch(error) {
		const allowed=new Set(["NATIVE_EFFECT_STATE_PROCESS_GATE_CLOSED","NATIVE_EFFECT_STATE_COMMAND_IDENTITY_INVALID","NATIVE_EFFECT_STATE_COMMAND_KEYS_INVALID",
			"NATIVE_EFFECT_STATE_COMMAND_REQUEST_INVALID","NATIVE_EFFECT_STATE_COMMAND_BINDING_INVALID",
			"NATIVE_EFFECT_STATE_BUILD_INVALID","NATIVE_EFFECT_STATE_SEATS_INVALID","NATIVE_EFFECT_STATE_CDP_UNAVAILABLE","NATIVE_EFFECT_STATE_CAPTURE_FAILED","NATIVE_EFFECT_STATE_ROOT_OR_SEATS_INVALID",
			"NATIVE_EFFECT_STATE_GATE_MISSING","NATIVE_EFFECT_STATE_EVENT_ID_BINDING_INVALID","NATIVE_EFFECT_STATE_GATE_SEAT_BINDING_INVALID",
			"NATIVE_EFFECT_STATE_PLAYER_SEAT_BINDING_INVALID","NATIVE_EFFECT_STATE_EVENT_SEAT_BINDING_INVALID",
			"NATIVE_EFFECT_STATE_EVENT_KIND_BINDING_INVALID","NATIVE_EFFECT_STATE_EVENT_BINDING_INVALID","NATIVE_EFFECT_STATE_ACTION_BINDING_INVALID",
			"NATIVE_EFFECT_STATE_NATIVE_SOURCE_INVALID","NATIVE_EFFECT_STATE_PRE_EVENT_FENCE_INVALID",
			"NATIVE_EFFECT_STATE_COMPLETION_COMMAND_INVALID","NATIVE_EFFECT_STATE_NATIVE_RESULT_INVALID","NATIVE_EFFECT_STATE_NATIVE_EFFECT_PROOF_INVALID",
			"NATIVE_EFFECT_STATE_COMPLETION_TRACE_MISSING","NATIVE_EFFECT_STATE_COMPLETION_TRACE_ROOT_INVALID",
			"NATIVE_EFFECT_STATE_COMPLETION_TRACE_HOST_PLAYER_INVALID","NATIVE_EFFECT_STATE_COMPLETION_TRACE_INVALID","NATIVE_EFFECT_STATE_COMPLETION_FENCE_INVALID",
			"NATIVE_EFFECT_STATE_VALUE_INVALID","NATIVE_EFFECT_STATE_CDP_EXCEPTION"]);
		process.send?.({ ...identity, type:"host_private_native_effect_state_failed", requestId:message.requestId, mode:message.mode,
			code:allowed.has(error?.message)||/^NATIVE_EFFECT_STATE_GATE_SEAT_BINDING_INVALID_-?\d+_-?\d+$/.test(error?.message||"") ? error.message : "NATIVE_EFFECT_STATE_CAPTURE_FAILED" });
	}
}

async function releaseNativePhaseBoundary(message) {
	const keys = "afterDigest,eventSequence,kind,nativeEventId,protocol,roomId,rootInstanceId,seatId,secret,sessionId,stateRevision,type";
	if (process.env.V2_NATIVE_START_DIAGNOSTICS !== "1" || process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE !== "1" ||
		!validHostCommand(message) || message.type !== "host_native_phase_boundary_release" ||
		Object.keys(message).sort().join(",") !== keys || message.eventSequence !== 4 || message.stateRevision !== 4 ||
		!/^[a-f0-9]{64}$/.test(message.afterDigest || "") || !/^native_root_[A-Za-z0-9_-]{16,96}$/.test(message.rootInstanceId || "") ||
		!/^native_event_[a-f0-9]{32}$/.test(message.nativeEventId || "") || typeof message.seatId !== "string" || !cdp) {
		throw new Error("NATIVE_PHASE_BOUNDARY_RELEASE_REJECTED");
	}
	const result = await cdp.send("Runtime.evaluate", { expression: `(()=>{const s=window.__v2NativeStartDiagnosticState,f=s?.nativePhaseBoundaryFence,
		c=window.__v2ManagedGame,a=s?.inputEvent,manager=window.__v2ManagedEngine?.core?._status?.eventManager;
		const command=${JSON.stringify({ nativeEventId: message.nativeEventId, rootInstanceId: message.rootInstanceId, seatId: message.seatId,
			eventSequence: message.eventSequence, stateRevision: message.stateRevision, afterDigest: message.afterDigest })};
		if(!f||f.status!=='waiting'||f.releaseCount!==0||f.nativeEventId!==command.nativeEventId||f.seatId!==command.seatId||
			f.rootInstanceId!==command.rootInstanceId||f.rootEvent!==s?.root||f.phaseLoopEvent!==s?.phaseLoop||manager?.rootEvent!==s?.root||
			f.phaseLoopStep!==3||f.phaseOverTriggerCount!==1||f.phaseOverTriggerComplete!==true||f.phaseOverDispatchEvidence!==s?.nativePhaseOverDispatchEvidence||
			f.phaseOverDispatchEvidence?.ownerEventInstanceId!==f.completionEvidence?.parentEventInstanceId||s?.nativePhaseOverDispatchOwner!==f.phaseLoopEvent||
			f.completedPhaseEvent?.finished!==true||f.completedPhaseEvent?.parent!==f.phaseLoopEvent||
			f.pendingDescendantCount!==0||!a||a.__v2NativeEventId!==command.nativeEventId||
			c?.authorityState?.revision!==4||window.__v2ManagedOpeningDraw?.authorityDigest!==command.afterDigest||
			f.priorAuthority?.eventSequence!==4||f.priorAuthority?.stateRevision!==4||f.priorAuthority?.afterDigest!==command.afterDigest||!f.resolve)
			return {ok:false,code:'NATIVE_PHASE_BOUNDARY_FENCE_BINDING_REJECTED'};
		f.status='accepted';f.releaseCount=1;f.acceptedAuthority=Object.freeze({eventSequence:4,stateRevision:4,afterDigest:command.afterDigest});
		f.resolve({accepted:true,...command});
		if(s?.multiTurnInputGateProbe===true&&f.boundaryOrdinal===1){s.priorNativeInputGate=s.nativeInputGate;s.nativeInputGate=null;s.nativeInputResumeGate=null;s.inputEvent=null;s.nextSeatInputProbeArmed=true}
		return {ok:true,status:f.status,releaseCount:f.releaseCount,nativeEventId:f.nativeEventId,rootInstanceId:f.rootInstanceId,seatId:f.seatId,
			eventSequence:f.acceptedAuthority.eventSequence,stateRevision:f.acceptedAuthority.stateRevision,afterDigest:f.acceptedAuthority.afterDigest,
			multiTurnInputGateProbe:s?.multiTurnInputGateProbe===true,nextSeatInputProbeArmed:s?.nextSeatInputProbeArmed===true,
			priorGateCleared:s?.nativeInputGate==null};})()`, returnByValue: true }, 1500);
	const observed = result.result?.value;
	if (result.exceptionDetails || observed?.ok !== true || observed.releaseCount !== 1 || observed.nativeEventId !== message.nativeEventId ||
		observed.rootInstanceId !== message.rootInstanceId || observed.seatId !== message.seatId || observed.eventSequence !== 4 ||
		observed.stateRevision !== 4 || observed.afterDigest !== message.afterDigest) throw new Error("NATIVE_PHASE_BOUNDARY_RELEASE_UNCERTAIN");
	emitNativeStartDiagnostic({ stage: "native_phase_boundary_release_command_accepted", snapshot: {
		nativeEventId: observed.nativeEventId, rootInstanceId: observed.rootInstanceId, seatId: observed.seatId,
		releaseCount: observed.releaseCount, eventSequence: observed.eventSequence, stateRevision: observed.stateRevision,
		multiTurnInputGateProbe: observed.multiTurnInputGateProbe === true,
		nextSeatInputProbeArmed: observed.nextSeatInputProbeArmed === true, priorGateCleared: observed.priorGateCleared === true } });
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
		if (nativeEffectSnapshotStopBarrier) {
			const barrier = nativeEffectSnapshotStopBarrier;
			nativeEffectSnapshotStopBarrier = null;
			barrier.release(false);
		}
		cleanup().finally(() => process.exit(0));
		return;
	}
	if (message?.type === "host_native_fault_release" && validHostCommand(message) &&
		["viewas_result_assignment_throws", "viewas_useCard_child_throws", "viewas_partial_effect_throws", "viewas_partial_effect_stop"].includes(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "") &&
		Object.keys(message).sort().join(",") === "choiceId,deliveryId,kind,protocol,roomId,secret,sessionId,type" &&
		nativeFaultApplyBarrier?.choiceId === message.choiceId && nativeFaultApplyBarrier.deliveryId === message.deliveryId) {
		const barrier = nativeFaultApplyBarrier;
		nativeFaultApplyBarrier = null;
		clearTimeout(barrier.timer);
		barrier.release(true);
		process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: barrier.nativeEventId,
			observed: { kind: "native_viewas_fault_barrier_v1", stage: "native_viewas_delivery_preapply_released",
				choiceId: barrier.choiceId, deliveryId: barrier.deliveryId } });
		return;
	}
	if (message?.type === "host_authority_event_ack" && validHostCommand(message) &&
		([1, 2, 3, 4].includes(message.eventSequence) || experimentalAuthorityEventEnabled(message.eventSequence)) &&
		message.stateRevision === message.eventSequence &&
		typeof message.afterDigest === "string" && /^[a-f0-9]{64}$/.test(message.afterDigest)) {
		if (process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && message.eventSequence === 1) {
			process.send?.({ ...identity, type: "host_choice_diagnostic", nativeEventId: null,
				observed: { kind: "native_jirimo_root_snapshot_v1", stage: "native_jirimo_event1_ack_received",
					eventSequence: 1, waiterPresent: nativeAuthorityAckWaiters.has(1) } });
		}
		nativeAuthorityAckWaiters.get(message.eventSequence)?.(message);
		return;
	}
	if (message?.type === "host_native_event5_post_capture_ready") {
		choiceCommandChain = choiceCommandChain.then(() => commitNativeSuccessorActionAuthority(message)).catch(error => {
			const gate = interactiveChoice?.nativeInputGate;
			const delivery = gate?.actionDeliveries?.get(gate.seatId);
			if (delivery?.status === "native_applied_authority_pending") {
				delivery.status = "uncertain";
				delivery.rejectAuthorityCommit?.(error);
				delivery.resolveAuthorityCommit = null;
				delivery.rejectAuthorityCommit = null;
			}
			const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "EVENT5_AUTHORITY_UNCERTAIN";
			process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
		});
		return;
	}
	if (message?.type === "host_native_event6_post_capture_ready") {
		choiceCommandChain = choiceCommandChain.then(() => commitNativeSuccessorActionAuthority(message, 6)).catch(error => {
			const gate = interactiveChoice?.nativeInputGate;
			const delivery = gate?.actionDeliveries?.get(gate.seatId);
			if (delivery?.status === "native_applied_authority_pending") {
				delivery.status = "uncertain";
				delivery.rejectAuthorityCommit?.(error);
				delivery.resolveAuthorityCommit = null;
				delivery.rejectAuthorityCommit = null;
			}
			const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "EVENT6_AUTHORITY_UNCERTAIN";
			process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
		});
		return;
	}
	if (message?.type === "host_native_event7_post_capture_ready") {
		choiceCommandChain = choiceCommandChain.then(() => commitNativeSuccessorActionAuthority(message, 7)).catch(error => {
			const gate = interactiveChoice?.nativeInputGate;
			const delivery = gate?.actionDeliveries?.get(gate.seatId);
			if (delivery?.status === "native_applied_authority_pending") {
				delivery.status = "uncertain";
				delivery.rejectAuthorityCommit?.(error);
				delivery.resolveAuthorityCommit = null;
				delivery.rejectAuthorityCommit = null;
			}
			const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "EVENT7_AUTHORITY_UNCERTAIN";
			process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
		});
		return;
	}
	if (message?.type === "host_native_event8_post_capture_ready") {
		choiceCommandChain = choiceCommandChain.then(() => commitNativeSuccessorActionAuthority(message, 8)).catch(error => {
			const gate = interactiveChoice?.nativeInputGate;
			const delivery = gate?.actionDeliveries?.get(gate.seatId);
			if (delivery?.status === "native_applied_authority_pending") {
				delivery.status = "uncertain";
				delivery.rejectAuthorityCommit?.(error);
				delivery.resolveAuthorityCommit = null;
				delivery.rejectAuthorityCommit = null;
			}
			const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "EVENT8_AUTHORITY_UNCERTAIN";
			process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
		});
		return;
	}
	if (message?.type === "host_native_event8_post_capture_ready") {
		choiceCommandChain = choiceCommandChain.then(() => commitNativeSuccessorActionAuthority(message, 8)).catch(error => {
			const gate = interactiveChoice?.nativeInputGate;
			const delivery = gate?.actionDeliveries?.get(gate.seatId);
			if (delivery?.status === "native_applied_authority_pending") {
				delivery.status = "uncertain";
				delivery.rejectAuthorityCommit?.(error);
				delivery.resolveAuthorityCommit = null;
				delivery.rejectAuthorityCommit = null;
			}
			const code = /^[A-Z0-9_]{3,96}$/.test(error?.message || "") ? error.message : "EVENT8_AUTHORITY_UNCERTAIN";
			process.send?.({ ...identity, type: "host_failure", code }, () => cleanup().finally(() => process.exit(1)));
		});
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
	if (message?.type === "host_native_card_ledger_snapshot" && process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativeCardLedger(message)).catch(() => {
			process.send?.({ ...identity, type: "host_private_card_ledger_failed", requestId: message?.requestId,
				mode: message?.mode, code: "NATIVE_CARD_LEDGER_CAPTURE_FAILED" });
		});
		return;
	}
	if (message?.type === "host_native_effect_state_snapshot" && process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativeEffectState(message)).catch(error => {
			process.send?.({ ...identity, type:"host_private_native_effect_state_failed", requestId:message?.requestId,
				mode:message?.mode, code:/^NATIVE_EFFECT_STATE_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "NATIVE_EFFECT_STATE_CAPTURE_FAILED" });
		});
		return;
	}
	if (message?.type === "host_native_atomic_capture" && process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE === "1") {
		if (message.boundaryOrdinal === 3) emitNativeStartDiagnostic({ stage: "event6_atomic_capture_command_received",
			classification: "authenticated_event6_capture_request", snapshot: { boundaryOrdinal: message.boundaryOrdinal,
				captureOrdinal: Number.isSafeInteger(message.captureOrdinal) ? message.captureOrdinal : null,
				rootMatches: message.rootInstanceId === interactiveChoice?.nativeRootInstanceId,
				event6ProbeEnabled: process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1" } });
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativeAtomicCapture(message)).catch(error => {
			const code = /^NATIVE_ATOMIC_CAPTURE_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "NATIVE_ATOMIC_CAPTURE_CAPTURE_FAILED";
			if (message.boundaryOrdinal === 3) emitNativeStartDiagnostic({ stage: "event6_atomic_capture_command_failed",
				classification: "explicit_exception", failureCode: code });
			process.send?.({ ...identity, type: "host_private_atomic_capture_failed", requestId: message?.requestId,
				captureOrdinal: message?.captureOrdinal, code });
		});
		return;
	}
	if (message?.type === "host_native_pre_action_capture" && process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativePreActionCapture(message)).catch(error => {
			const code = /^NATIVE_PREACTION_CAPTURE_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "NATIVE_PREACTION_CAPTURE_CAPTURE_FAILED";
			process.send?.({ ...identity, type: "host_private_pre_action_capture_failed", requestId: message?.requestId, code });
		});
		return;
	}
	if (message?.type === "host_native_successor_preaction_capture" && process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" &&
		process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativePreActionCapture(message, true)).catch(error => {
			const code = /^SUCCESSOR_PREACTION_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "SUCCESSOR_PREACTION_CAPTURE_FAILED";
			process.send?.({ ...identity, type: "host_private_successor_preaction_capture_failed", requestId: message?.requestId, code });
		});
		return;
	}
	if (message?.type === "host_native_event6_preaction_capture" &&
		process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" &&
		process.env.V2_NATIVE_EVENT6_CONTINUATION_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativePreActionCapture(message, true)).catch(error => {
			const code = /^EVENT6_PREACTION_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "EVENT6_PREACTION_CAPTURE_FAILED";
			process.send?.({ ...identity, type: "host_private_event6_preaction_capture_failed", requestId: message?.requestId, code });
		});
		return;
	}
	if (message?.type === "host_native_event7_preaction_capture" &&
		process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" &&
		process.env.V2_NATIVE_EVENT7_CONTINUATION_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativePreActionCapture(message, true)).catch(error => {
			const code = /^EVENT7_PREACTION_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "EVENT7_PREACTION_CAPTURE_FAILED";
			process.send?.({ ...identity, type: "host_private_event7_preaction_capture_failed", requestId: message?.requestId, code });
		});
		return;
	}
	if (message?.type === "host_native_event8_preaction_capture" &&
		process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" &&
		process.env.V2_NATIVE_EVENT8_CONTINUATION_PROBE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => snapshotNativePreActionCapture(message, true)).catch(error => {
			const code = /^EVENT8_PREACTION_[A-Z0-9_]{1,80}$/.test(error?.message || "") ? error.message : "EVENT8_PREACTION_CAPTURE_FAILED";
			process.send?.({ ...identity, type: "host_private_event8_preaction_capture_failed", requestId: message?.requestId, code });
		});
		return;
	}
	if (message?.type === "host_native_phase_boundary_release" && process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1") {
		choiceCommandChain = choiceCommandChain.then(() => releaseNativePhaseBoundary(message)).catch(error => {
			const failureCode = String(error?.message || "NATIVE_PHASE_BOUNDARY_RELEASE_REJECTED").slice(0, 96);
			emitNativeStartDiagnostic({ stage: "native_phase_boundary_release_rejected", classification: "explicit_exception", failureCode });
			process.send?.({ ...identity, type: "host_failure", code: failureCode }, () => cleanup().finally(() => process.exit(1)));
		});
		return;
	}
	if (message?.type === "host_native_start_diagnostic" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1") {
		if (message.mode === "controlled_block") {
			emitNativeStartDiagnostic({ stage: "controlled_block_command_received", classification: "command_dispatched" });
		}
		runNativeStartDiagnostic(message).catch(error => emitNativeStartDiagnostic({ stage: "native_start_diagnostic_rejected",
			classification: "explicit_exception", failureCode: String(error?.message || "NATIVE_START_DIAGNOSTIC_FAILED").slice(0, 96) }));
		return;
	}
	if (message?.type === "host_choice_cancel") return;
});

process.on("disconnect", () => cleanup().finally(() => process.exit(0)));
