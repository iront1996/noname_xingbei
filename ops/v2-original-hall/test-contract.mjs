import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = relative => readFileSync(resolve(root, relative), "utf8");
const originalServerBlob = "49a0ad87ffc2638e3651fe6a08b5a150cdf38de3";
const directEndpoint = "wss://v2-hall-direct.myxingbei.com:50000";

test("HALL still matches the pinned original Git blob", () => {
  const actual = execFileSync("git", ["hash-object", "game/server.js"], {
    cwd: root, encoding: "utf8"
  }).trim();
  assert.equal(actual, originalServerBlob);
});

test("V2 official default and hall button use the direct WSS endpoint", () => {
  const connect = file("mode/connect.js");
  assert.match(connect, /const autoLobbyAddress = "wss:\/\/v2-hall-direct\.myxingbei\.com:50000";/);
  assert.ok(connect.includes("node.textContent = autoLobbyAddress;"));
  assert.ok(!connect.includes("wss://myxingbei.com:443"), "Old 443 endpoint must not be hardcoded");
  assert.ok(connect.includes("node.contentEditable = true"), "Keep manual test access");
  assert.ok(connect.includes("prepareImageAssets"), "Preserve existing image preload gate");
  assert.ok(connect.includes(directEndpoint), "Require the exact canonical URL");
});

test("original HALL keeps its application heartbeat; no A1 replacement", () => {
  const hall = file("game/server.js");
  assert.ok(hall.includes('var WebSocketServer = require("ws").Server;'));
  assert.ok(hall.includes('var wss = new WebSocketServer({ port: 8080 });'));
  assert.ok(hall.includes('ws.send("heartbeat")'));
  assert.ok(hall.includes('if (message == "heartbeat")'));
  assert.ok(hall.includes("}, 60000);"));
});

test("front-end must remain an original-game plus image-preload derivative", () => {
  assert.ok(file("game/preload-images.mjs").includes("prepareImageAssets"));
  assert.ok(file("xingbei-image-sw.js").length > 100);
});
