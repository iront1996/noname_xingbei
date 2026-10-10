import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
const src=readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),"../game/v3-owner-connection.mjs"),"utf8");
const between=(start,end)=>{
  const a=src.indexOf(start),b=src.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`missing UI lifecycle ${start}`);
  return src.slice(a,b);
};
test("rejected create triggers a room-status request instead of a permanent dead-end overlay",()=>{
  const handler=between("lib.message.client.v3createblocked =","lib.message.client.v3resumerejected =");
  assert.match(handler,/blockedCreateRoomId = key/);
  assert.match(handler,/queryOldRoomStatus\(key\)/);
  assert.doesNotMatch(handler,/"v3abandon"/);
});
test("room status requires a verified owner token for the abandon option",()=>{
  const handler=between("lib.message.client.v3roomstatus =","lib.message.client.v3restoreprobe =");
  assert.match(handler,/evaluateV3BlockedRoomStatus\(status, Boolean\(getToken\(key\)\)\)/);
  assert.match(handler,/decision\.action === "RECHECK_ONLY"/);
  assert.match(handler,/status === "room_absent"/);
  assert.match(handler,/requestConfirmedAbandon\(key\)/);
  assert.doesNotMatch(handler,/"v3ready"/);
  assert.doesNotMatch(handler,/"v3resume"/);
});
test("only explicit confirmation sends owner-authenticated abandonment",()=>{
  const handler=between("function requestConfirmedAbandon","function removeOverlay");
  assert.match(handler,/pausedRoomOnReload/);
  assert.match(handler,/window\.confirm/);
  assert.match(handler,/game\.send\("server", "v3abandon", roomId, token\)/);
  assert.equal((src.match(/game\.send\("server", "v3abandon"/g)||[]).length,1);
});
test("server ack, not the button click, releases local identity and redirects to new lobby",()=>{
  const ack=between("lib.message.client.v3roomabandonedHost =","lib.message.client.v3roomabandoned =");
  assert.match(ack,/purgeLocalRecoveryCandidate\(key\)/);
  assert.match(ack,/sessionStorage\.removeItem\(TOKEN_PREFIX \+ key\)/);
  assert.match(ack,/returnToLobbyAfterAbandon/);
  const navigation=between("function returnToLobbyAfterAbandon","function queryOldRoomStatus");
  assert.match(navigation,/tmp_owner_roomId/);
  assert.match(navigation,/reconnect_info/);
  assert.match(navigation,/game\.reload\(\)/);
});
test("denied abandonment remains blocked and never fabricates a successful end",()=>{
  const handler=between("lib.message.client.v3resumerejected =","lib.element.ws.onerror =");
  assert.match(handler,/code !== "abandon_denied"/);
  assert.match(handler,/舊房間沒有被刪除/);
  assert.match(handler,/queryOldRoomStatus\(key\)/);
});
