import process from "node:process";
import { createHash } from "node:crypto";

let started = false;

process.on("message", message => {
	if (message?.type === "host_stop") process.exit(0);
	if (["host_choice_delivery", "host_choice_cancel", "host_authority_event_ack", "host_native_effect_state_snapshot"].includes(message?.type)) {
		process.send?.({ type: "host_command_observed", bootCount: started ? 1 : 0, command: message.type });
		return;
	}
	if (started || message?.kind !== "host_session_bootstrap") return;
	started = true;
	const identity = {
		kind: "managed_host",
		protocol: message.protocol,
		roomId: message.roomId,
		sessionId: message.sessionId,
		secret: message.secret,
	};
	process.send?.({ ...identity, type: "host_browser_ready" });
	if (message.roomId === "crash_room") {
		setTimeout(() => process.exit(17), 20);
		return;
	}
	process.send?.({ ...identity, type: "host_engine_ready", proof: {
		kind: "managed_engine_integrity_v1", trustContract: message.trustContract, buildId: message.engineSourceManifest?.buildId,
		fileCount: message.engineSourceManifest?.fileCount, totalBytes: message.engineSourceManifest?.totalBytes,
		networkPolicy: "same-origin-only",
	} });
	process.send?.({
		...identity,
		type: "host_game_ready",
		proof: {
			kind: "pre_game_verification_v1",
			trustContract: message.trustContract,
			engineBuildId: message.engineSourceManifest?.buildId,
			setupDigest: message.setupDigest,
			preGameSummaryDigest: createHash("sha256").update(JSON.stringify({ simulated: true })).digest("hex"),
			seatIds: message.gameSetup.seats.map(seat => seat.seatId),
			checkpoint: null,
		},
	});
	process.send?.({
		...identity,
		type: "authoritative_result",
		sequence: 1,
		result: {
			source: "simulated_managed_host",
			secretInArgv: process.argv.some(value => value.includes(message.secret)),
			secretInEnvironment: Object.values(process.env).some(value => value?.includes(message.secret)),
		},
	});
});
