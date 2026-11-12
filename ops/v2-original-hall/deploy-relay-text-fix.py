#!/usr/bin/env python3
"""V2-only TEXT relay compatibility fix on TOP of already deployed proxy-IP security.
NO changes without --apply AND --confirm; never touches Nginx, DNS or other HALLs.

--self-test : verify pinned current HALL and exact two-pattern transform, no writes
--check     : read-only real VPS preflight; requires zero established :8080 sessions
--apply     : explicit, V2-only backup & replacement with fail-closed rollback
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
EXPECTED_LIVE_SHA256 = "963f3a155ad00f5a7b1cdc00937c6d4240fb34f93a94938f2e4629cbf2ea9bb6"
SERVICE = "xingbei-hall.service"
SOURCE = Path("/opt/xingbei-hall/server.js")
BACKUPS = Path("/root/v2-original-hall-backups")

spec = importlib.util.spec_from_file_location("v2_proxy_ip_preflight", HERE / "deploy-proxy-ip-fix.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)

def fail(message):
    raise RuntimeError(message)

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def run(*cmd, check=True):
    return subprocess.run(cmd, capture_output=True, text=True, check=check)

def inputs():
    # Rebuild both versions on demand from the pinned original game/server.js.
    _orig_loopback, deployed = proxy.inputs()
    if sha256(deployed) != EXPECTED_LIVE_SHA256:
        fail("Previous V2 proxy-IP HALL candidate drifted; refusing to create new candidate")
    script = (
        'import { RELAY_TEXT_CANDIDATE } from "./ops/v2-original-hall/proxy-relay-text-fix-candidate.mjs"; '
        'process.stdout.write(RELAY_TEXT_CANDIDATE);'
    )
    result = subprocess.run(["node", "--input-type=module", "-e", script],
                            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    candidate = result.stdout
    if candidate == deployed:
        fail("New text-relay candidate unexpectedly equals previous HALL")
    prior_listener = b'ws.on("message", function (message) {'
    next_listener = b'ws.on("message", function (message, isBinary) {'
    prior_relay = b'this.owner.sendl("onmessage", this.wsid, message);'
    next_relay = (b'this.owner.sendl("onmessage", this.wsid, '
                  b'!isBinary && Buffer.isBuffer(message) ? message.toString("utf8") : message);')
    if deployed.count(prior_listener) != 1 or deployed.count(prior_relay) != 1:
        fail("Previous HALL is missing unique relay transform anchors")
    expected = deployed.replace(prior_listener, next_listener, 1).replace(prior_relay, next_relay, 1)
    if candidate != expected:
        fail("Candidate modifies more than the two explicitly approved text relay sites")
    if b'ws._v2ClientAddress = ip;' not in candidate:
        fail("Existing trusted source-IP security exception was lost")
    if b'if (message == "heartbeat")' not in candidate or b'ws.send("heartbeat")' not in candidate:
        fail("Original 60-second heartbeat source drift")
    return deployed, candidate

def preflight(previous, candidate):
    if os.geteuid() != 0:
        fail("VPS --check/--apply requires sudo/root")
    if not SOURCE.is_file() or SOURCE.is_symlink() or SOURCE.stat().st_nlink != 1:
        fail("Existing V2 HALL source missing, symlinked or hardlinked")
    # Preserves original V2 target service, dependency mapping, zero-session gate.
    proxy.deployer.preflight()
    if run("systemctl", "is-active", "nginx").stdout.strip() != "active":
        fail("nginx not active")
    if run("nginx", "-t", check=False).returncode != 0:
        fail("nginx -t failed; abort")
    proxy.check_nginx_realip_trust()
    if not proxy.SITE.is_file() or proxy.SITE.is_symlink() or proxy.SITE.stat().st_nlink != 1:
        fail("V2-only Nginx site is missing, symlinked, or hardlinked")
    if not proxy.LINK.is_symlink() or proxy.LINK.resolve() != proxy.SITE:
        fail("V2 Nginx enabled-site mapping not verified")
    site = proxy.SITE.read_bytes()
    if proxy.site_with_identity(site) != site:
        fail("Trusted-proxy IP header not fully enabled; refuse to weaken source IP fix")
    actual = SOURCE.read_bytes()
    if actual not in (previous, candidate):
        fail("Current V2 live HALL differs from both pinned security and relay fix versions: " +
             sha256(actual))
    print("CHECK PASS: V2-only service, trusted Nginx header, no established :8080 sessions")
    print("HALL state:", "relay-text candidate" if actual == candidate else "proxy-ip baseline (join-init broken)")
    print("Expected previous SHA256:", sha256(previous))
    print("Expected fixed SHA256:", sha256(candidate))
    return actual

def atomic_write(data, st):
    proxy.atomic_write(SOURCE, data, st)

def apply(previous, candidate):
    actual = preflight(previous, candidate)
    if actual == candidate:
        print("ALREADY PATCHED: no writes or restart")
        return
    # Syntax validation before making any change.
    with tempfile.NamedTemporaryFile(prefix="v2-relay-check-", suffix=".js", delete=False) as tmp:
        tmp.write(candidate)
        tmp_path = Path(tmp.name)
    try:
        run("node", "--check", str(tmp_path))
    finally:
        tmp_path.unlink(missing_ok=True)

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + str(os.getpid())
    backup = BACKUPS / ("v2-relay-text-" + stamp)
    backup.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(backup, 0o700)
    (backup / "server.js.before").write_bytes(actual)
    (backup / "server.js.before.sha256").write_text(sha256(actual) + "\n")
    (backup / "server.js.candidate.sha256").write_text(sha256(candidate) + "\n")
    (backup / "systemd-unit.before.txt").write_text(run("systemctl", "cat", SERVICE).stdout)
    for f in backup.iterdir():
        os.chmod(f, 0o600)
    print("V2-only backup:", backup)
    # Protection against new joins since the read-only preflight.
    if proxy.deployer.established_backend_count():
        fail("V2 has players since preflight; original source retained, restart blocked")
    stat = SOURCE.stat()
    was_stopped = False
    try:
        run("systemctl", "stop", SERVICE)
        was_stopped = True
        if SOURCE.read_bytes() != previous:
            fail("V2 source changed between check and update; refusing to overwrite")
        atomic_write(candidate, stat)
        run("systemctl", "start", SERVICE)
        if not proxy.deployer.original_listening():
            fail("V2 HALL not healthy or not loopback-only after fix")
        if SOURCE.read_bytes() != candidate:
            fail("Post-deployment exact candidate SHA mismatch")
        if proxy.site_with_identity(proxy.SITE.read_bytes()) != proxy.SITE.read_bytes():
            fail("Nginx trusted source-IP header drifted")
        print("APPLY PASS: V2 text WebSocket relay fix, existing IP security preserved")
        print("LIVE SHA256:", sha256(SOURCE.read_bytes()))
        print("NEXT: external WSS roomlist/key + 2 native heartbeat checks; normal host/guest join.")
    except Exception as e:
        print("APPLY FAILED; attempting V2-only HALL rollback", file=sys.stderr)
        try:
            if was_stopped:
                run("systemctl", "stop", SERVICE, check=False)
                atomic_write(previous, stat)
                run("systemctl", "start", SERVICE)
                if not proxy.deployer.original_listening():
                    fail("Rollback restart failed; immediate manual recovery required")
                print("ROLLBACK SUCCESS: prior V2 HALL source restored", file=sys.stderr)
        except Exception as rollback_error:
            print("CRITICAL ROLLBACK INCOMPLETE: " + str(rollback_error) +
                  "; recovery backup at " + str(backup), file=sys.stderr)
        raise e

def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    p.add_argument("--confirm", default="")
    opts = p.parse_args()
    try:
        previous, candidate = inputs()
        if opts.self_test:
            print("SELF-TEST PASS: pinned previous security SHA, exactly two relay changes, heartbeat unchanged")
            print("NEW CANDIDATE SHA256:", sha256(candidate))
        elif opts.check:
            preflight(previous, candidate)
        else:
            if opts.confirm != "APPLY_V2_TEXT_RELAY_FIX":
                fail("Explicit approval required: --confirm APPLY_V2_TEXT_RELAY_FIX")
            apply(previous, candidate)
        return 0
    except (RuntimeError, OSError, AssertionError, subprocess.CalledProcessError) as e:
        print("FAIL CLOSED:", e, file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
