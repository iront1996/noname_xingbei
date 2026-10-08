/**
 * Complete built-in image preparation for the dedicated browser lobby.
 * Uses a versioned Cache Storage namespace. A later service worker will
 * consume the same cache for actual gameplay image requests.
 */
const CACHE_PREFIX = "xingbei-image-assets-v1-";
const CONCURRENCY = 4;
const IMAGE_ROOT = new URL("../", import.meta.url);
const MANIFEST_URL = new URL("./preload-manifest.json", import.meta.url);
const encoder = new TextEncoder();

function assetURL(path) {
	return new URL(path, IMAGE_ROOT);
}

async function sha1GitBlob(buffer) {
	const header = encoder.encode("blob " + buffer.byteLength + "\0");
	const input = new Uint8Array(header.byteLength + buffer.byteLength);
	input.set(header);
	input.set(new Uint8Array(buffer), header.byteLength);
	const hash = await crypto.subtle.digest("SHA-1", input);
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function decodeImage(buffer, mimeType) {
	const url = URL.createObjectURL(new Blob([buffer], { type: mimeType || "application/octet-stream" }));
	const image = new Image();
	try {
		const loaded = new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = () => reject(new Error("圖片無法解碼"));
		});
		image.src = url;
		if (typeof image.decode === "function") await image.decode();
		else await loaded;
		if (!image.naturalWidth || !image.naturalHeight) throw new Error("圖片尺寸無效");
	} finally {
		image.onload = null;
		image.onerror = null;
		URL.revokeObjectURL(url);
	}
}

async function verifiedResponse(response, item, decode) {
	if (!response || !response.ok || response.type === "opaque") return false;
	try {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength !== item.bytes) return false;
		if (await sha1GitBlob(buffer) !== item.gitBlobSha) return false;
		if (decode) await decodeImage(buffer, response.headers.get("content-type"));
		return true;
	} catch {
		// Corrupted cached entries must be treated as misses, not permanent blockers.
		return false;
	}
}

function validateManifest(manifest) {
	if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error("圖片清單格式不正確");
	if (!/^[a-f0-9]{40}-[a-f0-9]{40}$/.test(manifest.version)) throw new Error("圖片清單版本不正確");
	if (manifest.count !== manifest.assets.length || !manifest.count) throw new Error("圖片數量不一致");
	let totalBytes = 0;
	const seen = new Set();
	for (const asset of manifest.assets) {
		if (typeof asset.path !== "string" || !/^(?:image|theme)\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(asset.path) || asset.path.split("/").includes("..")) {
			throw new Error("圖片路徑不合法");
		}
		if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{40}$/.test(asset.gitBlobSha) || seen.has(asset.path)) {
			throw new Error("圖片清單有無效或重複資料");
		}
		seen.add(asset.path);
		totalBytes += asset.bytes;
	}
	if (manifest.totalBytes !== totalBytes) throw new Error("圖片容量與清單不一致");
}

async function loadManifest() {
	const response = await fetch(MANIFEST_URL, { cache: "no-store" });
	if (!response.ok) throw new Error("無法取得圖片清單（HTTP " + response.status + "）");
	const manifest = await response.json();
	validateManifest(manifest);
	return manifest;
}

async function downloadAndVerify(url, item, target) {
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok || response.type === "opaque") throw new Error("下載失敗（HTTP " + response.status + "）");
	if (!await verifiedResponse(response.clone(), item, true)) throw new Error("圖片大小或內容雜湊不正確");
	// Write only successfully verified AND decoded images into Cache Storage.
	await target.put(url, response);
}

/**
 * @param {(progress: {total:number, checked:number, ready:number, cached:number, downloaded:number, failed:number})=>void} onProgress
 * @returns {Promise<{total:number, cached:number, downloaded:number, version:string}>}
 */
export async function prepareImageAssets(onProgress = () => {}) {
	if (!("caches" in window) || !crypto?.subtle) {
		throw new Error("此瀏覽器不支援必要的圖片快取與完整性檢查");
	}
	const manifest = await loadManifest();
	const cacheName = CACHE_PREFIX + manifest.version;
	const cache = await caches.open(cacheName);
	const previousNames = (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX) && name !== cacheName);
	const olderCaches = await Promise.all(previousNames.map(name => caches.open(name)));
	const status = { total: manifest.count, checked: 0, ready: 0, cached: 0, downloaded: 0, failed: 0 };
	const failures = [];
	let cursor = 0;
	onProgress({ ...status });
	async function checkOne(item) {
		const url = assetURL(item.path).href;
		try {
			// Verify every cached asset against its actual Git blob hash.
			const current = await cache.match(url);
			if (await verifiedResponse(current, item, false)) {
				status.cached++;
				status.ready++;
				return;
			}
			if (current) await cache.delete(url);
			for (const oldCache of olderCaches) {
				const older = await oldCache.match(url);
				if (await verifiedResponse(older.clone(), item, false)) {
					await cache.put(url, older);
					status.cached++;
					status.ready++;
					return;
				}
			}
			await downloadAndVerify(url, item, cache);
			status.downloaded++;
			status.ready++;
		} catch (error) {
			status.failed++;
			failures.push({ path: item.path, message: error instanceof Error ? error.message : String(error) });
		} finally {
			status.checked++;
			onProgress({ ...status });
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.count) }, async () => {
		while (cursor < manifest.assets.length) {
			const item = manifest.assets[cursor++];
			await checkOne(item);
		}
	}));
	if (failures.length) {
		const error = new Error("有 " + failures.length + " 張圖片尚未成功準備");
		error.failures = failures;
		throw error;
	}
	// Only remove previous complete generations after the new one succeeds.
	await Promise.allSettled(previousNames.map(name => caches.delete(name)));
	return { total: manifest.count, cached: status.cached, downloaded: status.downloaded, version: manifest.version };
}
