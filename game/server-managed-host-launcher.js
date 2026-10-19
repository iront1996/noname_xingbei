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
				command?.type === "host_native_start_diagnostic" && ["native_start", "managed_start", "managed_input_gate", "managed_input_resume", "managed_input_timeout", "managed_input_cancel", "managed_input_cancel_resume_race", "managed_input_stop", "managed_input_controller", "managed_input_controller_trustee", "managed_input_controller_registry", "managed_input_controller_fault_before_apply", "managed_opening_root_action", "managed_opening_root_action_event4", "managed_opening_root_action_event4_ack_loss", "managed_opening_root_action_event4_trustee", "managed_opening_root_action_event5", "managed_native_response_probe", "controlled_block", "managed_random_failure_probe"].includes(command.mode);
			const nativeSnapshotCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				command?.type === "host_native_start_snapshot" && ["managed_opening_root_action_event4", "managed_opening_root_action_event5", "managed_native_skill_candidate_probe"].includes(command.mode);
			const nativeCardLedgerCommand = process.env.V2_NATIVE_CARD_LEDGER_PROBE === "1" &&
				process.env.V2_NATIVE_START_DIAGNOSTICS === "1" && process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1" &&
				command?.type === "host_native_card_ledger_snapshot" && command.kind === "managed_host" &&
				command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				/^ledger_[a-f0-9]{32}$/.test(command.requestId || "") && ["pre_native_action", "post_phase_over"].includes(command.mode) &&
				Array.isArray(command.seatIds) && command.seatIds.length === bootstrap.gameSetup.seats.length &&
				command.seatIds.every((seatId, index) => seatId === bootstrap.gameSetup.seats[index].seatId) &&
				Object.keys(command).sort().join(",") === "kind,mode,protocol,requestId,roomId,seatIds,secret,sessionId,type";
			const nativeEffectStateCommand = process.env.V2_NATIVE_EFFECT_STATE_PROBE === "1" &&
				process.env.V2_NATIVE_YINYANG_FIXTURE === "1" && process.env.V2_NATIVE_MANAGED_YINYANG === "1" &&
				process.env.V2_NATIVE_MANAGED_RESPONSE === "1" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
				command?.type === "host_native_effect_state_snapshot" && command.kind === "managed_host" &&
				command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				/^effect_[a-f0-9]{32}$/.test(command.requestId || "") &&
				["before_native_response", "after_native_response", "repeat_native_response"].includes(command.mode) &&
				/^native_event_[a-f0-9]{32}$/.test(command.nativeEventId || "") &&
				bootstrap.gameSetup?.seats?.some(seat => seat.seatId === command.seatId) &&
				command.schema === "xingbei_native_private_effect_state_v1" &&
				/^native_root_[A-Za-z0-9_-]{16,96}$/.test(command.rootInstanceId || "") &&
				command.engineBuildId === bootstrap.engineSourceManifest?.buildId &&
				Array.isArray(command.seatIds) && command.seatIds.length === bootstrap.gameSetup.seats.length &&
				command.seatIds.every((seatId, index) => seatId === bootstrap.gameSetup.seats[index].seatId) &&
				(command.mode === "before_native_response" ? command.captureBoundary === "native_response_waiting" && command.nativeCompletionOrdinal === null :
					command.captureBoundary === "native_response_completed" && Number.isSafeInteger(command.nativeCompletionOrdinal) && command.nativeCompletionOrdinal > 0) &&
				Object.keys(command).sort().join(",") === "captureBoundary,engineBuildId,kind,mode,nativeCompletionOrdinal,nativeEventId,protocol,requestId,roomId,rootInstanceId,schema,seatId,seatIds,secret,sessionId,type";
			const nativeAtomicCaptureCommand = process.env.V2_NATIVE_ATOMIC_CAPTURE_PROBE === "1" &&
				process.env.V2_NATIVE_START_DIAGNOSTICS === "1" && process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1" &&
				process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && command?.type === "host_native_atomic_capture" &&
				command.kind === "managed_host" && command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				/^atomic_[a-f0-9]{32}$/.test(command.requestId || "") && Number.isSafeInteger(command.captureOrdinal) && command.captureOrdinal > 0 &&
				Number.isSafeInteger(command.boundaryOrdinal) && command.boundaryOrdinal >= 1 && command.boundaryOrdinal <= 2 &&
				(command.boundaryOrdinal !== 2 || process.env.V2_NATIVE_MULTI_TURN_ATOMIC_CAPTURE_PROBE === "1") &&
				command.engineBuildId === bootstrap.engineSourceManifest?.buildId &&
				/^native_root_[A-Za-z0-9_-]{16,96}$/.test(command.rootInstanceId || "") &&
				Array.isArray(command.seatIds) && command.seatIds.length === 4 &&
				command.seatIds.every((seatId, index) => seatId === bootstrap.gameSetup.seats[index].seatId) &&
				Object.keys(command).sort().join(",") === "boundaryOrdinal,captureOrdinal,engineBuildId,kind,protocol,requestId,roomId,rootInstanceId,seatIds,secret,sessionId,type";
			const nativePreActionCaptureCommand = process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" &&
				(process.env.V2_NATIVE_RESOURCE_SHENGJI_FIXTURE === "1" ||
					(process.env.V2_NATIVE_JIRIMO_FIXTURE === "1" && process.env.V2_NATIVE_JIRIMO_ACTION_PROBE === "1") ||
					process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1") &&
				process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE === "1" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
				command?.type === "host_native_pre_action_capture" && command.kind === "managed_host" &&
				command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				/^preaction_[a-f0-9]{32}$/.test(command.requestId || "") &&
				/^choice_[a-f0-9]{32}$/.test(command.choiceId || "") &&
				/^native_[A-Za-z0-9_-]{16,96}$/.test(command.nativeEventId || "") &&
				bootstrap.gameSetup?.seats?.some(seat => seat.seatId === command.seatId) &&
				command.engineBuildId === bootstrap.engineSourceManifest?.buildId &&
				/^native_root_[A-Za-z0-9_-]{16,96}$/.test(command.rootInstanceId || "") &&
				Array.isArray(command.seatIds) && command.seatIds.length === bootstrap.gameSetup.seats.length &&
				command.seatIds.every((seatId, index) => seatId === bootstrap.gameSetup.seats[index].seatId) &&
				Object.keys(command).sort().join(",") === "choiceId,engineBuildId,kind,nativeEventId,protocol,requestId,roomId,rootInstanceId,seatId,seatIds,secret,sessionId,type";
			const nativeSuccessorPreActionCaptureCommand = process.env.V2_NATIVE_PREACTION_ATOMIC_CAPTURE_PROBE === "1" &&
				process.env.V2_NATIVE_MULTI_TURN_INPUT_GATE_PROBE === "1" && process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				process.env.V2_NATIVE_EVENT_COMPLETION_SEQUENCE === "1" && process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" &&
				command?.type === "host_native_successor_preaction_capture" && command.kind === "managed_host" &&
				command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId && command.sessionId === bootstrap.sessionId &&
				command.secret === bootstrap.secret && /^successor_[a-f0-9]{32}$/.test(command.requestId || "") &&
				Number.isSafeInteger(command.captureOrdinal) && command.captureOrdinal >= 1 && command.captureOrdinal <= 2 &&
				/^native_[A-Za-z0-9_-]{16,96}$/.test(command.previousNativeEventId || "") &&
				/^native_event_[a-f0-9]{32}$/.test(command.nativeEventId || "") && command.nativeEventId !== command.previousNativeEventId &&
				bootstrap.gameSetup.seats.some(seat => seat.seatId === command.previousSeatId) &&
				bootstrap.gameSetup.seats.some(seat => seat.seatId === command.seatId) && command.previousSeatId !== command.seatId &&
				Array.isArray(command.candidateOptionIds) && command.candidateOptionIds.length > 0 && command.candidateOptionIds.length <= 64 &&
				new Set(command.candidateOptionIds).size === command.candidateOptionIds.length && command.candidateOptionIds.every(option => /^native_option_[a-f0-9]{32}$/.test(option)) &&
				command.candidateOptionKinds && Object.getPrototypeOf(command.candidateOptionKinds) === Object.prototype &&
				Object.keys(command.candidateOptionKinds).sort().join(",") === [...command.candidateOptionIds].sort().join(",") &&
				Object.values(command.candidateOptionKinds).every(kind => kind === "gongJi" || kind === "faShu") &&
				/^event_[1-9][0-9]{0,6}$/.test(command.eventInstanceId || "") &&
				/^event_[1-9][0-9]{0,6}$/.test(command.parentEventInstanceId || "") &&
				Number.isSafeInteger(command.waitingCompletionOrdinal) && command.waitingCompletionOrdinal > 0 &&
				command.engineBuildId === bootstrap.engineSourceManifest?.buildId &&
				/^native_root_[A-Za-z0-9_-]{16,96}$/.test(command.rootInstanceId || "") &&
				Array.isArray(command.seatIds) && command.seatIds.length === bootstrap.gameSetup.seats.length &&
				command.seatIds.every((seatId, index) => seatId === bootstrap.gameSetup.seats[index].seatId) &&
				Object.keys(command).sort().join(",") === "candidateOptionIds,candidateOptionKinds,captureOrdinal,engineBuildId,eventInstanceId,kind,nativeEventId,parentEventInstanceId,previousNativeEventId,previousSeatId,protocol,requestId,roomId,rootInstanceId,seatId,seatIds,secret,sessionId,type,waitingCompletionOrdinal";
			const nativePhaseBoundaryReleaseCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				process.env.V2_NATIVE_PHASE_BOUNDARY_FENCE === "1" && command?.type === "host_native_phase_boundary_release" &&
				command.kind === "managed_host" && command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
				typeof command.nativeEventId === "string" && typeof command.rootInstanceId === "string" && typeof command.seatId === "string" &&
				command.eventSequence === 4 && command.stateRevision === 4 && /^[a-f0-9]{64}$/.test(command.afterDigest || "") &&
				Object.keys(command).sort().join(",") === "afterDigest,eventSequence,kind,nativeEventId,protocol,roomId,rootInstanceId,seatId,secret,sessionId,stateRevision,type";
			const nativeEvent5PostCaptureReadyFailure = (() => {
				if (command?.type !== "host_native_event5_post_capture_ready") return null;
				if (![5, 6].includes(bootstrap.authorityEventLimit) || bootstrap.authorityEventLimit < 5 ||
					process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT !== String(bootstrap.authorityEventLimit) ||
					process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK !== "1") return "OPT_IN";
				if (command.kind !== "managed_host" || command.protocol !== bootstrap.protocol || command.roomId !== bootstrap.roomId ||
					command.sessionId !== bootstrap.sessionId || command.secret !== bootstrap.secret) return "IDENTITY";
				if (command.eventSequence !== 5 || command.stateRevision !== 4) return "SEQUENCE";
				if (!Number.isSafeInteger(command.connectionGeneration) || command.connectionGeneration < 1) return "GENERATION";
				if (!Number.isSafeInteger(command.captureOrdinal) || command.captureOrdinal < 1 ||
					!Number.isSafeInteger(command.nativeCompletionOrdinal) || command.nativeCompletionOrdinal < 1) return "ORDINAL";
				if (!/^[a-f0-9]{64}$/.test(command.commitment || "") || !/^[a-f0-9]{64}$/.test(command.afterDigestBefore || "")) return "DIGEST";
				if (!/^native_event_[a-f0-9]{32}$/.test(command.nativeEventId || "") ||
					!/^event_[1-9][0-9]{0,6}$/.test(command.phaseOverEventInstanceId || "")) return "EVENT_ID";
				if (!Number.isSafeInteger(command.phaseOverTriggerOrdinal) || command.phaseOverTriggerOrdinal < 2) return "TRIGGER_ORDINAL";
				if (!/^native_root_[A-Za-z0-9_-]{16,96}$/.test(command.rootInstanceId || "") ||
					!bootstrap.gameSetup.seats.some(seat => seat.seatId === command.seatId)) return "ROOT_OR_SEAT";
				const expectedKeys = "afterDigestBefore,captureOrdinal,commitment,connectionGeneration,eventSequence,kind,nativeCompletionOrdinal,nativeEventId,phaseOverEventInstanceId,phaseOverTriggerOrdinal,protocol,roomId,rootInstanceId,secret,seatId,sessionId,stateRevision,type".split(",");
				const actualKeys = Object.keys(command);
				if (actualKeys.sort().join(",") !== expectedKeys.sort().join(",")) {
					const extra = actualKeys.find(key => !expectedKeys.includes(key));
					const missing = expectedKeys.find(key => !Object.hasOwn(command, key));
					return `SCHEMA_${extra ? `EXTRA_${extra}` : missing ? `MISSING_${missing}` : "ORDER"}`;
				}
				return null;
			})();
			const nativeEvent5PostCaptureReadyCommand = [5, 6].includes(bootstrap.authorityEventLimit) && bootstrap.authorityEventLimit >= 5 &&
				process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === String(bootstrap.authorityEventLimit) &&
				process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1" && command?.type === "host_native_event5_post_capture_ready" &&
				command.kind === "managed_host" && command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
				command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret && command.eventSequence === 5 &&
				command.stateRevision === 4 && Number.isSafeInteger(command.connectionGeneration) && command.connectionGeneration > 0 &&
				Number.isSafeInteger(command.captureOrdinal) && command.captureOrdinal > 0 && /^[a-f0-9]{64}$/.test(command.commitment || "") &&
				Number.isSafeInteger(command.nativeCompletionOrdinal) && command.nativeCompletionOrdinal > 0 &&
				/^native_event_[a-f0-9]{32}$/.test(command.nativeEventId || "") &&
				/^event_[1-9][0-9]{0,6}$/.test(command.phaseOverEventInstanceId || "") &&
				Number.isSafeInteger(command.phaseOverTriggerOrdinal) && command.phaseOverTriggerOrdinal >= 2 &&
				/^native_root_[A-Za-z0-9_-]{16,96}$/.test(command.rootInstanceId || "") && bootstrap.gameSetup.seats.some(seat => seat.seatId === command.seatId) &&
				/^[a-f0-9]{64}$/.test(command.afterDigestBefore || "") &&
				Object.keys(command).sort().join(",") === "afterDigestBefore,captureOrdinal,commitment,connectionGeneration,eventSequence,kind,nativeCompletionOrdinal,nativeEventId,phaseOverEventInstanceId,phaseOverTriggerOrdinal,protocol,roomId,rootInstanceId,seatId,secret,sessionId,stateRevision,type";
			const inputResumeCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" &&
				command?.type === "host_native_input_resume" && typeof command.nativeEventId === "string" &&
				typeof command.seatId === "string" && typeof command.optionId === "string" &&
				Object.keys(command).every(key => ["type", "nativeEventId", "seatId", "optionId"].includes(key));
			const inputCancelCommand = process.env.V2_NATIVE_START_DIAGNOSTICS === "1" && command?.type === "host_native_input_cancel" &&
				typeof command.nativeEventId === "string" && typeof command.seatId === "string" &&
				Object.keys(command).every(key => ["type", "nativeEventId", "seatId"].includes(key));
			if (exited || !child.connected || !command ||
				!(diagnosticCommand || nativeSnapshotCommand || nativeCardLedgerCommand || nativeEffectStateCommand || nativeAtomicCaptureCommand || nativePreActionCaptureCommand || nativeSuccessorPreActionCaptureCommand || nativePhaseBoundaryReleaseCommand || nativeEvent5PostCaptureReadyCommand || inputResumeCommand || inputCancelCommand || nativeFaultReleaseCommand ||
					(command?.type === "host_authority_event_ack" && command.kind === "managed_host" &&
						command.accepted === true &&
						command.protocol === bootstrap.protocol && command.roomId === bootstrap.roomId &&
						command.sessionId === bootstrap.sessionId && command.secret === bootstrap.secret &&
						([1, 2, 3, 4].includes(command.eventSequence) || (command.eventSequence === 5 &&
							[5, 6].includes(bootstrap.authorityEventLimit) && bootstrap.authorityEventLimit >= command.eventSequence &&
							process.env.V2_EXPERIMENTAL_AUTHORITY_EVENT_LIMIT === String(bootstrap.authorityEventLimit) &&
							process.env.V2_TEST_BLOCK_EXTERNAL_NETWORK === "1")) &&
						command.stateRevision === command.eventSequence &&
						/^[a-f0-9]{64}$/.test(command.afterDigest)) ||
					["host_choice_delivery", "host_choice_cancel"].includes(command.type)) ||
				Object.getPrototypeOf(command) !== Object.prototype) throw new Error(command?.type === "host_native_pre_action_capture"
				? "HOST_PREACTION_CAPTURE_COMMAND_REJECTED" : command?.type === "host_native_event5_post_capture_ready"
					? `HOST_EVENT5_COMMAND_REJECTED_${nativeEvent5PostCaptureReadyFailure || "UNKNOWN"}` : "HOST_COMMAND_REJECTED");
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
