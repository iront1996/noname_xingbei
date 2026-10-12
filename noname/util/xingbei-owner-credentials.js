const PREFIX = "xingbei:owner-recovery:v1:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function storageKey(endpoint) {
	if (typeof endpoint != "string" || !endpoint || endpoint.length > 2048) return null;
	return PREFIX + endpoint;
}

export function validOwnerCredentials(value) {
	return Boolean(
		value &&
		typeof value == "object" &&
		value.protocol === 1 &&
		typeof value.roomId == "string" &&
		value.roomId.length > 0 &&
		value.roomId.length <= 256 &&
		typeof value.token == "string" &&
		TOKEN_PATTERN.test(value.token)
	);
}

export function saveOwnerCredentials(storage, endpoint, roomId, credential) {
	const key = storageKey(endpoint);
	const value = {
		protocol: credential?.protocol,
		roomId,
		token: credential?.ownerResumeToken,
	};
	if (!key || !validOwnerCredentials(value)) return false;
	try {
		storage?.setItem(key, JSON.stringify(value));
		return true;
	} catch (_) {
		return false;
	}
}

export function loadOwnerCredentials(storage, endpoint) {
	const key = storageKey(endpoint);
	if (!key) return null;
	try {
		const stored = storage?.getItem(key);
		const value = stored ? JSON.parse(stored) : null;
		return validOwnerCredentials(value) ? value : null;
	} catch (_) {
		return null;
	}
}

export function clearOwnerCredentials(storage, endpoint) {
	const key = storageKey(endpoint);
	if (!key) return;
	try {
		storage?.removeItem(key);
	} catch (_) {}
}
