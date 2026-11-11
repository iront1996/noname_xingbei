#!/usr/bin/env bash
# V2-only WSS entrance; no new game HALL. Execute only on the existing VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST="v2-hall-direct.myxingbei.com"
IP="172.234.84.27"
NAME="v2-original-hall-50000.conf"
AVAILABLE="/etc/nginx/sites-available/$NAME"
ENABLED="/etc/nginx/sites-enabled/$NAME"
TEMPLATE="$ROOT/nginx-wss-50000.conf.example"
BACKUP_ROOT="/root/v2-original-hall-backups"

usage() {
  echo "Usage: sudo bash $0 --check"
  echo "   or: sudo bash $0 --apply --firewall-reviewed --confirm ADD_V2_WSS_50000"
}
MODE=""
FIREWALL_REVIEWED=0
CONFIRM=""
while (($#)); do
  case "$1" in
    --check|--apply)
      [[ -z "$MODE" ]] || { echo "Only one mode allowed" >&2; exit 2; }
      MODE="$1";;
    --firewall-reviewed) FIREWALL_REVIEWED=1;;
    --confirm)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      CONFIRM="$2"; shift;;
    *) usage; exit 2;;
  esac
  shift
done
[[ -n "$MODE" ]] || { usage; exit 2; }

fail() { echo "CHECK FAILED: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Command not installed: $1"; }
for bin in nginx openssl getent ss systemctl readlink cp install ip awk; do require_command "$bin"; done
[[ -f "$TEMPLATE" ]] || fail "Missing V2-only Nginx template: $TEMPLATE"
[[ "$(id -u)" == "0" ]] || fail "Run with sudo/root"
[[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]] || fail "Debian/Ubuntu sites layout required"
[[ "$(systemctl show xingbei-hall.service -p ActiveState --value)" == "active" ]] ||
  fail "Existing V2 service must be active"
[[ -e /opt/xingbei-hall/server.js ]] || fail "V2 HALL source path missing"
[[ "$(ip -4 -o addr show | awk '$4 ~ /^172[.]234[.]84[.]27\// {print $4}' | wc -l)" == "1" ]] ||
  fail "Expected public VPS IPv4 is not assigned locally"

A_RECORDS="$(getent ahostsv4 "$HOST" | awk '{print $1}' | sort -u)"
[[ "$A_RECORDS" == "$IP" ]] ||
  fail "New DNS hostname must resolve only to $IP; got: $A_RECORDS"

CERT="/etc/letsencrypt/live/$HOST/fullchain.pem"
KEY="/etc/letsencrypt/live/$HOST/privkey.pem"
[[ -r "$CERT" && -r "$KEY" ]] || fail "Missing publicly trusted TLS certificate/key for new V2 hostname"
openssl x509 -in "$CERT" -noout -checkhost "$HOST" | grep -Fq "does match" ||
  fail "Certificate SAN does not match new V2 hostname"
openssl x509 -in "$CERT" -checkend 604800 -noout >/dev/null ||
  fail "TLS certificate expires within 7 days"

nginx -t >/dev/null || fail "Existing Nginx configuration invalid before changes"
[[ "$(systemctl show nginx.service -p ActiveState --value)" == "active" ]] ||
  fail "Nginx must already be running"
[[ ! -e "$AVAILABLE" && ! -L "$AVAILABLE" ]] || fail "Refusing to replace existing site: $AVAILABLE"
[[ ! -e "$ENABLED" && ! -L "$ENABLED" ]] || fail "Refusing to replace existing enabled site: $ENABLED"

if ss -H -ltn | awk '$4 ~ /(^|:)50000$/ {found=1} END {exit !found}'; then
  fail "TCP :50000 is already listening; do not hijack an existing service"
fi

echo "PASS: DNS-only A, V2 process, valid TLS certificate, Nginx and free TCP :50000"
echo "NOTE: this does not inspect Akamai Cloud Firewall. Confirm inbound TCP 50000 and SSH policies in its dashboard."
echo "NOTE: this does not prove AAAA is absent or validate off-VPS TCP reachability."
[[ "$MODE" == "--check" ]] && exit 0
[[ "$FIREWALL_REVIEWED" == "1" && "$CONFIRM" == "ADD_V2_WSS_50000" ]] ||
  fail "--apply requires --firewall-reviewed --confirm ADD_V2_WSS_50000"

install -d -m 0700 "$BACKUP_ROOT"
BACKUP="$BACKUP_ROOT/wss-50000-$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0700 "$BACKUP"
nginx -T >"$BACKUP/nginx-before.txt" 2>&1
chmod 0600 "$BACKUP/nginx-before.txt"
cp -- "$TEMPLATE" "$BACKUP/new-site-template.conf"

NEED_ROLLBACK=1
rollback_on_exit() {
  if [[ "$NEED_ROLLBACK" == "1" ]]; then
    echo "WSS activation incomplete; removing only the new V2 Nginx site" >&2
    rm -f -- "$ENABLED"
    rm -f -- "$AVAILABLE"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
}
trap rollback_on_exit EXIT

install -m 0644 "$TEMPLATE" "$AVAILABLE"
ln -s "$AVAILABLE" "$ENABLED"
nginx -t || fail "Nginx config check failed after V2 site addition"
systemctl reload nginx || fail "Nginx reload failed after V2 site addition"
sleep 1
ss -H -ltn | awk '$4 ~ /(^|:)50000$/ {found=1} END {exit !found}' ||
  fail "Nginx reloaded but TCP :50000 is not listening"

NEED_ROLLBACK=0
trap - EXIT
echo "SUCCESS: V2-only direct WSS :50000 added to this VPS; no other HALL service touched."
echo "Backup of previous effective Nginx config: $BACKUP/nginx-before.txt"
echo "NEXT: verify TLS 101/roomlist externally before replacing old V2 HALL."
