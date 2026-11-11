#!/usr/bin/env python3
"""V2-only controlled proxy client-IP security fix. NOT auto-deployed.

--self-test: offline pinned source/template verification (safe on any machine).
--check: read-only live VPS preflight, no writes or service operations.
--apply: backups + one V2 nginx site edit + one V2 HALL replacement, guarded
         by an exact confirmation string and ZERO established V2 sessions.

No other systemd units, V3/monitor, cloudflared, Pages, DNS or firewall changes.
This adds a security-only exception to the original+loopback HALL byte baseline.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SERVICE = "xingbei-hall.service"
SOURCE = Path("/opt/xingbei-hall/server.js")
SITE = Path("/etc/nginx/sites-available/v2-original-hall-50000.conf")
LINK = Path("/etc/nginx/sites-enabled/v2-original-hall-50000.conf")
BACKUPS = Path("/root/v2-original-hall-backups")
ORIGINAL_BLOB = "49a0ad87ffc2638e3651fe6a08b5a150cdf38de3"
ORIGINAL_LISTENER = b"var wss = new WebSocketServer({ port: 8080 });"
LOOPBACK_LISTENER = b'var wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });'
PROXY_HEADER = "proxy_set_header X-V2-Client-IP $remote_addr;"
XFF_CLEAR = 'proxy_set_header X-Forwarded-For "";'
HOST_ANCHOR = "        proxy_set_header Host $host;\n"

spec = importlib.util.spec_from_file_location("v2_existing_hall_deployer", HERE / "deploy-existing-vps.py")
deployer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployer)


def fail(message):
    raise RuntimeError(message)


def run(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, check=check)


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def inputs():
    original = (ROOT / "game/server.js").read_bytes()
    if git_blob(original) != ORIGINAL_BLOB or original.count(ORIGINAL_LISTENER) != 1:
        fail("The checkout does not contain the approved pinned original HALL source")
    expected_live = original.replace(ORIGINAL_LISTENER, LOOPBACK_LISTENER, 1)
    node_script = (
        'import { CANDIDATE } from "./ops/v2-original-hall/proxy-ip-fix-candidate.mjs"; '
        'process.stdout.write(CANDIDATE);'
    )
    node = subprocess.run(
        ["node", "--input-type=module", "-e", node_script],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True
    )
    candidate = node.stdout
    if candidate == expected_live or b"ws._v2ClientAddress = ip;" not in candidate:
        fail("Proxy-IP candidate was not generated correctly")
    if b'ws.send("heartbeat")' not in candidate or b'if (message == "heartbeat")' not in candidate:
        fail("Original application heartbeat unexpectedly altered")
    return expected_live, candidate


def site_with_identity(data):
    value = data.decode("utf-8")
    if "listen 50000 ssl;" not in value or "proxy_pass http://127.0.0.1:8080;" not in value:
        fail("Selected Nginx site does not match the intended V2 WSS endpoint")
    if value.count("server_name v2-hall-direct.myxingbei.com;") != 1:
        fail("Selected Nginx site hostname mismatch")
    any_custom_header = re.search(r"^\s*proxy_set_header\s+X-V2-Client-IP\b.*$", value, re.M | re.I)
    if any_custom_header:
        if any_custom_header.group(0).strip() != PROXY_HEADER:
            fail("Existing V2 client-IP header is not exactly the trusted $remote_addr")
    else:
        if value.count(HOST_ANCHOR) != 1:
            fail("Nginx Host header anchor missing or duplicated")
        value = value.replace(HOST_ANCHOR,
            HOST_ANCHOR + "        " + PROXY_HEADER + "\n", 1)
    xff = re.search(r"^\s*proxy_set_header\s+X-Forwarded-For\b.*$", value, re.M | re.I)
    if xff:
        if xff.group(0).strip() != XFF_CLEAR:
            fail("Conflicting X-Forwarded-For header; refuse to overwrite unknown policy")
    else:
        value = value.replace("        " + PROXY_HEADER + "\n",
            "        " + PROXY_HEADER + "\n        " + XFF_CLEAR + "\n", 1)
    return value.encode("utf-8")


def check_nginx_realip_trust():
    # $remote_addr must be a real direct TCP peer, not a potentially spoofable
    # result from globally enabled nginx RealIP config.
    config = run("nginx", "-T").stdout
    bare = "\n".join(line.split("#", 1)[0] for line in config.splitlines())
    if re.search(r"^\s*(real_ip_header|set_real_ip_from)\s+", bare, re.M | re.I):
        fail("Nginx has active real_ip_header/set_real_ip_from; inspect trusted peer policy before deployment")


def live_preflight(expected, candidate):
    if os.geteuid() != 0:
        fail("VPS check/apply requires root for exact source/site state audit")
    if not SOURCE.is_file() or SOURCE.is_symlink():
        fail("V2 live HALL source missing or symlinked")
    if not SITE.is_file() or SITE.is_symlink():
        fail("The dedicated V2 Nginx site is missing or symlinked")
    if not LINK.is_symlink() or LINK.resolve() != SITE:
        fail("The enabled V2 Nginx site is not the expected single symlink")
    if SOURCE.stat().st_nlink != 1 or SITE.stat().st_nlink != 1:
        fail("Refusing to replace a file with multiple hard links")
    if run("systemctl", "is-active", "nginx").stdout.strip() != "active":
        fail("nginx.service is not active")
    if run("systemctl", "is-active", SERVICE).stdout.strip() != "active":
        fail("xingbei-hall.service is not active")
    if run("nginx", "-t", check=False).returncode != 0:
        fail("Live nginx -t failed before attempting change")
    check_nginx_realip_trust()
    live = SOURCE.read_bytes()
    if live not in (expected, candidate):
        fail("Unexpected live HALL SHA256: " + hashlib.sha256(live).hexdigest())
    site = SITE.read_bytes()
    patched_site = site_with_identity(site)
    deployer.preflight()  # Original V2 service mapping + zero live :8080 sessions.
    print("CHECK PASS: exact V2 HALL baseline/candidate; exclusive active service, zero sockets")
    print("HALL state:", "proxy-ip candidate" if live == candidate else "original+loopback")
    print("V2 nginx header state:", "ready" if site == patched_site else "requires security header")
    print("Expected candidate SHA256:", hashlib.sha256(candidate).hexdigest())
    return live, site, patched_site


def atomic_write(target, data, original_stat):
    fd, tmp = tempfile.mkstemp(prefix=".v2-proxy-ip-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, original_stat.st_mode & 0o7777)
        os.chown(tmp, original_stat.st_uid, original_stat.st_gid)
        os.replace(tmp, target)
    finally:
        Path(tmp).unlink(missing_ok=True)


def apply(expected, candidate):
    old_source, old_site, new_site = live_preflight(expected, candidate)
    if old_source == candidate and old_site == new_site:
        print("ALREADY PATCHED: no restart, no writes")
        return

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUPS / ("v2-proxy-ip-" + stamp + "-" + str(os.getpid()))
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(backup, 0o700)
    (backup / "server.js.before").write_bytes(old_source)
    (backup / "nginx-site.before").write_bytes(old_site)
    (backup / "expected-candidate.sha256").write_text(hashlib.sha256(candidate).hexdigest() + "\n")
    for filename in ("server.js.before", "nginx-site.before", "expected-candidate.sha256"):
        os.chmod(backup / filename, 0o600)

    source_stat, site_stat = SOURCE.stat(), SITE.stat()
    nginx_touched = False
    service_stopped = False
    print("BACKUP:", backup)
    try:
        if old_site != new_site:
            atomic_write(SITE, new_site, site_stat)
            nginx_touched = True
            run("nginx", "-t")
            run("systemctl", "reload", "nginx")
        if deployer.established_backend_count() != 0:
            fail("New V2 sessions appeared after preflight; aborting without stopping the HALL")
        if old_source != candidate:
            run("systemctl", "stop", SERVICE)
            service_stopped = True
            atomic_write(SOURCE, candidate, source_stat)
            run("systemctl", "start", SERVICE)
            if not deployer.original_listening():
                fail("V2 HALL did not return to 127.0.0.1:8080")
        if SOURCE.read_bytes() != candidate or SITE.read_bytes() != new_site:
            fail("Post-apply file bytes differ from the expected V2 security candidate")
        print("APPLY PASS: trusted proxy identity fix installed on V2 only")
        print("NEXT: run external read-only WSS roomlist/key and 2 heartbeat checks.")
    except Exception:
        print("APPLY FAILED; restoring V2-only source and Nginx site", file=sys.stderr)
        try:
            if service_stopped:
                run("systemctl", "stop", SERVICE, check=False)
                atomic_write(SOURCE, old_source, source_stat)
                run("systemctl", "start", SERVICE)
            if nginx_touched:
                atomic_write(SITE, old_site, site_stat)
                run("nginx", "-t")
                run("systemctl", "reload", "nginx")
            print("ROLLBACK COMPLETED; inspect original services before retry", file=sys.stderr)
        except Exception as rollback_error:
            print("CRITICAL: ROLLBACK INCOMPLETE: " + str(rollback_error), file=sys.stderr)
            print("Recovery copies:", backup, file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--check", action="store_true")
    group.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()
    try:
        expected, candidate = inputs()
        if args.self_test:
            template = (HERE / "nginx-wss-50000.conf.example").read_bytes()
            assert site_with_identity(template) == template, "Nginx candidate template missing header"
            assert site_with_identity(site_with_identity(template)) == template, "Nginx candidate is not idempotent"
            print("SELF-TEST PASS: pinned HALL, minimal security exception, Nginx idempotent header")
        elif args.check:
            live_preflight(expected, candidate)
        else:
            if args.confirm != "APPLY_V2_PROXY_IP_SECURITY_FIX":
                fail("--apply requires --confirm APPLY_V2_PROXY_IP_SECURITY_FIX")
            apply(expected, candidate)
        return 0
    except (OSError, RuntimeError, AssertionError, subprocess.CalledProcessError) as e:
        print("FAIL CLOSED:", e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
