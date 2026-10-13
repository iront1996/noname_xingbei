import process from "node:process";
import { createHash } from "node:crypto";

let started = false;

process.on("message", message => {
	if (message?.type === "host_stop") process.exit(0);
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
	process.send?.({ ...identity, type: "host_engine_ready" });
	process.send?.({
		...identity,
		type: "host_game_ready",
		proof: {
			kind: "pre_game_verification_v1",
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
