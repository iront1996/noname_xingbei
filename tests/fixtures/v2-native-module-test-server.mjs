import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MIME = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
};
const page = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>V2 managed engine</title><script src="/game/config.js"></script><script src="/game/package.js"></script></head><body></body></html>';

export async function createV2NativeModuleTestServer({ root } = {}) {
	if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("ABSOLUTE_TEST_ROOT_REQUIRED");
	const base = path.resolve(root);
	const server = createServer(async (request, response) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405); response.end(); return;
		}
		let pathname;
		try {
			const parsed = new URL(request.url, "http://127.0.0.1");
			if (parsed.search || parsed.hash) throw new Error("QUERY_DENIED");
			pathname = decodeURIComponent(parsed.pathname);
			if (pathname === "/v2-managed-host.html") {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				response.end(request.method === "HEAD" ? undefined : page); return;
			}
			if (!/^\/[A-Za-z0-9_./-]+$/.test(pathname) || pathname.includes("..")) throw new Error("PATH_DENIED");
		} catch {
			response.writeHead(400); response.end(); return;
		}
		const file = path.resolve(base, `.${pathname}`);
		if (!file.startsWith(`${base}${path.sep}`)) {
			response.writeHead(403); response.end(); return;
		}
		try {
			const details = await stat(file);
			if (!details.isFile()) throw new Error("NOT_FILE");
			const bytes = await readFile(file);
			response.writeHead(200, {
				"Content-Type": MIME[path.extname(file)] || "application/octet-stream",
				"Cache-Control": "no-store",
			});
			response.end(request.method === "HEAD" ? undefined : bytes);
		} catch {
			response.writeHead(404); response.end();
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return Object.freeze({
		origin: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise(resolve => server.close(resolve)),
	});
}
