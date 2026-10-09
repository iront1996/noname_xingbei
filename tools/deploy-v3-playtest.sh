#!/usr/bin/env bash
# V3-only deployment: install the playtest server into the isolated 8081 unit.
# Must be run as root on the VPS after reviewing the source.
set -Eeuo pipefail

SERVICE="xingbei-hall-v3.service"
TARGET="/opt/xingbei-hall-v3/server.js"
SOURCE_URL="https://raw.githubusercontent.com/iront1996/noname_xingbei/9fbf144c1e8f20c275bbd9fe0eb5e2022e1c4efe/game/v3-playtest-server.cjs"
TMP="$(mktemp --suffix=.cjs)"
BACKUP=""
trap 'rm -f "$TMP"' EXIT

if [[ "$(id -u)" != "0" ]]; then
  echo "ERROR: run with sudo on the V3 VPS only" >&2
  exit 1
fi

systemctl cat "$SERVICE" >/dev/null
test -f "$TARGET" && test ! -L "$TARGET"
systemctl is-active --quiet "$SERVICE" || {
  echo "ERROR: V3 unit is not active; aborting (will not start it implicitly)" >&2
  exit 1
}
EXEC="$(systemctl show -P ExecStart "$SERVICE")"
case "$EXEC" in
  *"$TARGET"*) ;;
  *) echo "ERROR: unexpected V3 ExecStart; aborting: $EXEC" >&2; exit 1 ;;
esac
if [[ "$EXEC" == *"/opt/xingbei-hall/server.js"* ]]; then
  echo "ERROR: production server path detected, aborting" >&2
  exit 1
fi

curl -fsSL --connect-timeout 10 --max-time 60 "$SOURCE_URL" -o "$TMP"
node --check "$TMP"
grep -F 'V3_RESUME_TIMEOUT_MS = 180000' "$TMP" >/dev/null
grep -F 'V3_PORT || 8081' "$TMP" >/dev/null
grep -F 'host: "127.0.0.1"' "$TMP" >/dev/null
grep -F 'v3ownerresumedHost' "$TMP" >/dev/null
grep -F 'v3ready:' "$TMP" >/dev/null
grep -F 'v3restoreprobe: function' "$TMP" >/dev/null
OWNER="$(stat -c '%u' "$TARGET")"
GROUP="$(stat -c '%g' "$TARGET")"
MODE="$(stat -c '%a' "$TARGET")"
BACKUP="$TARGET.before-v3-playtest.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$TARGET" "$BACKUP"
echo "V3-only backup: $BACKUP"
install -o "$OWNER" -g "$GROUP" -m "$MODE" "$TMP" "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"

if ! systemctl restart "$SERVICE" || ! systemctl is-active --quiet "$SERVICE"; then
  echo "ERROR: V3 unit failed; rolling back" >&2
  cp -a "$BACKUP" "$TARGET"
  systemctl restart "$SERVICE" || true
  exit 1
fi

# Ensure the new Node process is actually listening on the isolated V3 port.
# A systemd "active" response alone is not sufficient for a healthy rollout.
PORT_READY=0
for attempt in 1 2 3 4 5 6 7 8; do
  if node -e '
    const net = require("node:net");
    const socket = net.createConnection({host:"127.0.0.1",port:8081});
    socket.setTimeout(1200);
    socket.once("connect",()=>{socket.destroy();process.exit(0)});
    socket.once("error",()=>process.exit(1));
    socket.once("timeout",()=>{socket.destroy();process.exit(1)});
  '; then
    PORT_READY=1
    break
  fi
  sleep 1
done
if [[ "$PORT_READY" != "1" ]]; then
  echo "ERROR: V3 port 8081 did not become ready; rolling back." >&2
  cp -a "$BACKUP" "$TARGET"
  systemctl restart "$SERVICE" || true
  exit 1
fi

echo "SUCCESS: only $SERVICE was restarted."
echo "V1 and V2 services and ports were not touched."
echo "Backup: $BACKUP"
