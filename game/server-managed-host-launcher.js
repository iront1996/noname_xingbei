"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

function createManagedHostProcessLauncher({
	command = process.execPath,
	script,
	spawnProcess = spawn,
	stopTimeoutMs = 2000,
} = {}) {
	if (typeof command !== "string" || !path.isAbsolute(command) ||
		typeof script !== "string" || !path.isAbsolute(script) ||
		typeof spawnProcess !== "function" ||
		!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 100 || stopTimeoutMs > 10000) {
		throw new TypeError("HOST_LAUNCHER_CONFIG_INVALID");
	}

	return async function launch(bootstrap) {
		const child = spawnProcess(command, [script], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			windowsHide: true,
			env: { ...process.env, XINGBEI_MANAGED_HOST: "1" },
		});
		const handle = new EventEmitter();
		let exited = false;
		let started = false;
		let exitInfo = null;
		let cleanupPromise = Promise.resolve();
		const resources = new Map();
		const exitWaiters = [];
		const profilePrefix = path.resolve(tmpdir(), "v2-managed-host-");

		function authenticatedResource(message) {
			return message?.type === "host_resource" && message.kind === "managed_host" &&
				message.protocol === bootstrap.protocol && message.roomId === bootstrap.roomId &&
				message.sessionId === bootstrap.sessionId && message.secret === bootstrap.secret &&
				Number.isSafeInteger(message.pid) && message.pid > 0 &&
				message.processGroupId === message.pid && typeof message.profile === "string" &&
				path.resolve(message.profile).startsWith(profilePrefix);
		}

		async function cleanupResources() {
			for (const resource of resources.values()) {
				try {
					if (process.platform === "win32") process.kill(resource.pid, "SIGTERM");
					else process.kill(-resource.processGroupId, "SIGTERM");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
				try {
					if (process.platform === "win32") process.kill(resource.pid, "SIGKILL");
					else process.kill(-resource.processGroupId, "SIGKILL");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
				const resolvedProfile = path.resolve(resource.profile);
				if (resolvedProfile.startsWith(profilePrefix)) {
					await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
				}
			}
			resources.clear();
		}

		function finish(code, signal) {
			if (exited) return;
			exited = true;
			exitInfo = { code, signal };
			cleanupPromise = cleanupResources().catch(() => {});
			handle.emit("exit", code, signal);
			for (const resolve of exitWaiters.splice(0)) resolve(exitInfo);
		}

		child.on("message", message => {
			if (authenticatedResource(message)) {
				resources.set(message.pid, Object.freeze({
					pid: message.pid,
					processGroupId: message.processGroupId,
					profile: path.resolve(message.profile),
				}));
				return;
			}
			handle.emit("message", message);
		});
		child.once("exit", finish);
		child.once("error", () => finish(null, "spawn_error"));
		handle.pid = child.pid;
		handle.start = async () => {
			if (started || exited || !child.connected) throw new Error("HOST_PROCESS_START_INVALID");
			started = true;
			await new Promise((resolve, reject) => {
				child.send(bootstrap, error => error ? reject(error) : resolve());
			});
		};
		handle.sendHostCommand = async command => {
			const nativeFaultReleaseCommand = ["viewas_result_assignment_throws", "viewas_useCard_child_throws", "viewas_partial_effect_throws", "viewas_partial_effect_stop"].includes(process.env.V2_MANAGED_NATIVE_FAULT_INJECTION || "") &&
				command?.type === "host_native_fault_release" && command.kind === "managed_host" && command.protocol === bootstrap.protocol &&
				command.roomId === bootstrap.roomId && command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				typeof command.choiceId === "string" && /^choice_[a-f0-9]{32}$/.test(command.choiceId) &&
				typeof command.deliveryId === "string" && /^delivery_choice_[a-f0-9]{32}$/.test(command.deliveryId) &&
				Object.keys(command).sort().join(",") === "choiceId,deliveryId,kind,protocol,roomId,secret,sessionId,type";
			const diagnosticCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				command?.type === "host_native_start_diagnostic" && ["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_native_response_probe", "controlled_block", "managed_random_failure_probe"].includes(command.mode);
			const nativeSnapshotCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				command?.type === "host_native_start_snapshot" && ["managed_opening_root_action_event4"].includes(command.mode);
			const nativeCardLedgerCommand = process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1" &&
				process.env.V2_NATIVE_START_DIAGNOSTICS === "1" && process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1" &&
				command?.type === "host_native_card_ledger_snapshot" && command.kind === "managed_host" &&
				command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				/^ledger_[a-f0-9]{32}$/.test(command.requestId || "") && ["pre_native_action", "post_phase_over"].includes(command.mode) &&
				Array.isArray(command.seatIds) && command.seatIds.length === bootstrap.gameSetup.seats.length &&
				command.seatIds.every((seatId, index) => seatId === bootstrap.gameSetup.seats[index].seatId) &&
				Object.keys(command).sort().join(",") === "kind,mode,protocol,requestId,roomId,seatIds,secret,sessionId,type";
			const nativePhaseBoundaryReleaseCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1" && command?.type === "host_native_phase_boundary_release" &&
				command.kind === "managed_host" && command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				typeof command.nativeEventId === "string" && typeof command.rootInstanceId === "string" && typeof command.seatId === "string" &&
				command.eventSequence === 4 && command.stateRevision === 4 && /^[a-f0-9]{64}$/.test(command.afterDigest || "") &&
				Object.keys(command).sort().join(",") === "afterDigest,eventSequence,kind,nativeEventId,protocol,roomId,rootInstanceId,seatId,secret,sessionId,stateRevision,type";
			const inputResumeCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				command?.type === "host_native_input_resume" && typeof command.nativeEventId === "string" &&
				typeof command.seatId === "string" && typeof command.optionId === "string" &&
				Object.keys(command).every(key => ["type", "nativeEventId", "seatId", "optionId"].includes(key));
			const inputCancelCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" && command?.type === "host_native_input_cancel" &&
				typeof command.nativeEventId === "string" && typeof command.seatId === "string" &&
				Object.keys(command).every(key => ["type", "nativeEventId", "seatId"].includes(key));
			if (exited || !child.connected || !command ||
				!(diagnosticCommand || nativeSnapshotCommand || nativeCardLedgerCommand || nativePhaseBoundaryReleaseCommand || inputResumeCommand || inputCancelCommand || nativeFaultReleaseCommand ||
					(command?.type === "host_authority_event_ack" && command.kind === "managed_host" &&
						command.accepted === true &&
						command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
						command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
						[1, 2, 3, 4].includes(command.eventSequence) && command.stateRevision === command.eventSequence &&
						/^[a-f0-9]{64}$/.test(command.afterDigest)) ||
					["host_choice_delivery", "host_choice_cancel"].includes(command.type)) ||
				Object.getPrototypeOf(command) !== Object.prototype) throw new Error("HOST_COMMAND_REJECTED");
			await new Promise((resolve, reject) => child.send(command, error => error ? reject(error) : resolve()));
		};
		handle.stop = async reason => {
			if (exited) {
				await cleanupPromise;
				return exitInfo;
			}
			const exitedPromise = new Promise(resolve => exitWaiters.push(resolve));
			try {
				if (child.connected) child.send({ type: "host_stop", reason: String(reason).slice(0, 64) });
				else child.kill();
			} catch (_) {
				child.kill();
			}
			const timer = setTimeout(() => {
				if (!exited) child.kill("SIGKILL");
			}, stopTimeoutMs);
			if (timer.unref) timer.unref();
			try {
				const info = await exitedPromise;
				await cleanupPromise;
				return info;
			} finally {
				clearTimeout(timer);
			}
		};
		handle.resources = () => Object.freeze([...resources.values()].map(resource => Object.freeze({ ...resource })));
		handle.waitForCleanup = () => cleanupPromise;
		return handle;
	};
}

module.exports = { createManagedHostProcessLauncher };
