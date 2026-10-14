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
			const diagnosticCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				command?.type === "host_native_start_diagnostic" && ["native_start", "managed_start", "controlled_block"].includes(command.mode);
			if (exited || !child.connected || !command ||
				!(diagnosticCommand || ["host_choice_delivery", "host_choice_cancel"].includes(command.type)) ||
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
