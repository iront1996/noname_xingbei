import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = relative => readFileSync(resolve(root, relative), "utf8");

test("HALL remains pinned to exact original Git blob", () => {
  const hash = execFileSync("git", ["hash-object", "game/server.js"], {cwd:root,encoding:"utf8"}).trim();
  assert.equal(hash, "49a0ad87ffc2638e3651fe6a08b5a150cdf38de3");
});

test("V2 defaults only to the DNS-only direct WSS entrance", () => {
  const connect = file("mode/connect.js");
  assert.ok(connect.includes('const autoLobbyAddress = "wss://v2-hall-direct.myxingbei.com:50000";'));
  assert.ok(connect.includes("node.textContent = autoLobbyAddress;"));
  assert.ok(!connect.includes("wss://myxingbei.com:443"));
  assert.ok(connect.includes("node.contentEditable = true"));
  assert.ok(connect.includes("prepareImageAssets"));
});

test("original HALL retains 60-second application heartbeat", () => {
  const src = file("game/server.js");
  assert.ok(src.includes('var wss = new WebSocketServer({ port: 8080 });'));
  assert.ok(src.includes('ws.send("heartbeat")'));
  assert.ok(src.includes('if (message == "heartbeat")'));
  assert.ok(src.includes("}, 60000);"));
});

test("V2 image preloading is preserved", () => {
  assert.ok(file("game/preload-images.mjs").includes("prepareImageAssets"));
  assert.ok(file("xingbei-image-sw.js").length > 100);
});

test("in-place deployment refers to existing HALL service only", () => {
  const deploy = file("ops/v2-original-hall/deploy-existing-vps.py");
  assert.ok(deploy.includes('SERVICE = "xingbei-hall.service"'));
  assert.ok(deploy.includes('SOURCE = Path("/opt/xingbei-hall/server.js")'));
  assert.ok(deploy.includes("--apply"));
  assert.ok(deploy.includes("--check"));
  assert.ok(deploy.includes("--original-file"));
  assert.ok(deploy.includes("--expect-ip"));
  assert.ok(deploy.includes("ROLLBACK"));
  assert.ok(!deploy.includes('command("systemctl", "stop", "xingbei-hall-v3.service")'));
  const nginx = file("ops/v2-original-hall/nginx-wss-50000.conf.example");
  assert.ok(nginx.includes("listen 50000 ssl;"));
  assert.ok(nginx.includes("proxy_pass http://127.0.0.1:8080;"));
  assert.ok(nginx.includes("proxy_read_timeout 180s;"));
});
