#!/usr/bin/env bash
# V3-only deployment: install the playtest server into the isolated 8081 unit.
# Must be run as root on the VPS after reviewing the source.
set -Eeuo pipefail

SERVICE="xingbei-hall-v3.service"
TARGET="/opt/xingbei-hall-v3/server.js"
SOURCE_URL="https://raw.githubusercontent.com/iront1996/noname_xingbei/1a5b0b88c20dd2c04cff877787d4c7b0511c9371/game/v3-playtest-server.cjs"
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

echo "SUCCESS: only $SERVICE was restarted."
echo "V1 and V2 services and ports were not touched."
echo "Backup: $BACKUP"
