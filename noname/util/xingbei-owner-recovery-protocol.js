import {
	clearOwnerCredentials,
	loadOwnerCredentials,
	saveOwnerCredentials,
} from "./xingbei-owner-credentials.js";

export function handleOwnerRecoveryControl(message, context) {
	if (!Array.isArray(message)) return false;
	const { state, storage, endpoint, onlineKey, version, nickname, avatar, config, send } = context;

	if (message[0] === "createroom") {
		const roomId = message[1];
		const credential = message[2];
		if (saveOwnerCredentials(storage, endpoint, roomId, credential)) {
			state._xingbeiOwnerResumeReady = { roomId, protocol: 1 };
		}
		return false;
	}

	const recovery = state?._xingbeiRecovery;
	const ready = state?._xingbeiOwnerResumeReady;
	if (message[0] === "roomlist" && recovery?.active && ready?.protocol === 1) {
		const credential = loadOwnerCredentials(storage, endpoint);
		if (!credential || credential.roomId !== state.roomId || ready.roomId !== state.roomId) {
			recovery.reject("missing_owner_credentials");
			state._xingbeiSuppressRecovery = true;
			return true;
		}
		if (!state._xingbeiOwnerResumeRequested) {
			state._xingbeiOwnerResumeRequested = true;
			try {
				send("server", "key", [onlineKey, version]);
				send(
					"server",
					"resumeowner",
					1,
					credential.roomId,
					credential.token,
					nickname,
					avatar
				);
			} catch (_) {
				state._xingbeiOwnerResumeRequested = false;
				recovery.connectionLost();
			}
		}
		return true;
	}

	if (message[0] === "ownerresumed") {
		if (!state?._xingbeiOwnerResumeRequested || recovery?.phase !== "SYNCING") return true;
		const roomId = message[1];
		const credential = message[2];
		if (
			roomId !== state.roomId ||
			credential?.protocol !== 1 ||
			credential?.state !== "waiting_host_process" ||
			!saveOwnerCredentials(storage, endpoint, roomId, credential)
		) {
			recovery.reject("invalid_owner_resume_ack");
			state._xingbeiSuppressRecovery = true;
			return true;
		}
		state._xingbeiOwnerReclaimed = true;
		send("server", "config", config);
		return true;
	}

	if (message[0] === "resumeownerfailed") {
		if (!state?._xingbeiOwnerResumeRequested || recovery?.phase !== "SYNCING") return true;
		clearOwnerCredentials(storage, endpoint);
		recovery.reject("owner_resume_rejected");
		state._xingbeiSuppressRecovery = true;
		return true;
	}

	if (message[0] === "roomresumed" && state?._xingbeiOwnerReclaimed) {
		if (message[1]?.protocol !== 1 || message[1]?.roomId !== state.roomId) {
			recovery?.reject("invalid_owner_resume_ready");
			state._xingbeiSuppressRecovery = true;
			return true;
		}
		if (recovery?.active && recovery.phase === "SYNCING") {
			recovery.synchronized("owner_resume");
		}
		state._xingbeiOwnerResumeRequested = false;
		state._xingbeiOwnerReclaimed = false;
		return true;
	}

	return false;
}
