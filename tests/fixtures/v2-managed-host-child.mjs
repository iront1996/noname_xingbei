import process from "node:process";

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
		type: "authoritative_result",
		sequence: 1,
		result: {
			source: "simulated_managed_host",
			secretInArgv: process.argv.some(value => value.includes(message.secret)),
			secretInEnvironment: Object.values(process.env).some(value => value?.includes(message.secret)),
		},
	});
});
