"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
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
		const exitWaiters = [];

		function finish(code, signal) {
			if (exited) return;
			exited = true;
			exitInfo = { code, signal };
			handle.emit("exit", code, signal);
			for (const resolve of exitWaiters.splice(0)) resolve(exitInfo);
		}

		child.on("message", message => handle.emit("message", message));
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
		handle.stop = async reason => {
			if (exited) return exitInfo;
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
				return await exitedPromise;
			} finally {
				clearTimeout(timer);
			}
		};
		return handle;
	};
}

module.exports = { createManagedHostProcessLauncher };
