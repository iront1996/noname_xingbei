#!/usr/bin/env python3
"""Read-only attestation: deployed V2 HALL must equal pinned original + loopback listener.

Run on existing VPS from checkout root:
    sudo python3 ops/v2-original-hall/audit-live-v2.py --check

No writes, restarts, firewall changes, remote connections, or deployments.
"""
import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ORIGINAL = ROOT / "game/server.js"
LIVE = Path("/opt/xingbei-hall/server.js")
ORIGINAL_GIT_BLOB = "49a0ad87ffc2638e3651fe6a08b5a150cdf38de3"
NEEDLE = b"var wss = new WebSocketServer({ port: 8080 });"
REPLACEMENT = b'var wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });'


def git_blob(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def expected() -> bytes:
    src = ORIGINAL.read_bytes()
    assert git_blob(src) == ORIGINAL_GIT_BLOB, "checkout is not the pinned original HALL"
    assert src.count(NEEDLE) == 1, "unexpected original HALL listener"
    return src.replace(NEEDLE, REPLACEMENT, 1)


def cmd(*args: str) -> str:
    p = subprocess.run(args, capture_output=True, text=True, check=True)
    return p.stdout.strip()


def check() -> int:
    errors = []
    patched = expected()
    actual = LIVE.read_bytes()
    match = actual == patched
    print(("PASS" if match else "FAIL") + " deployed source equals original HALL with only loopback bind")
    print("  original Git blob: " + ORIGINAL_GIT_BLOB)
    print("  expected live SHA256: " + hashlib.sha256(patched).hexdigest())
    print("  actual live SHA256:   " + hashlib.sha256(actual).hexdigest())
    if not match:
        errors.append("live V2 HALL is not the exact expected original listener-only build")

    for service in ("xingbei-hall.service", "xingbei-hall-v3.service", "cloudflared.service", "xingbei-monitor.service"):
        state = cmd("systemctl", "is-active", service)
        print(("PASS" if state == "active" else "FAIL") + " service " + service + " = " + state)
        if state != "active":
            errors.append("not active: " + service)
    v2_start = cmd("systemctl", "show", "xingbei-hall.service", "-p", "ExecStart", "--value")
    if str(LIVE) not in v2_start:
        errors.append("V2 service ExecStart does not reference the checked live source")

    listeners = cmd("ss", "-H", "-ltn").splitlines()
    port_8080 = []
    port_50000 = []
    for line in listeners:
        columns = line.split()
        if len(columns) < 4:
            continue
        address = columns[3]
        if address.rsplit(":", 1)[-1] == "8080":
            port_8080.append(address)
        if address.rsplit(":", 1)[-1] == "50000":
            port_50000.append(address)

    v2_safe = port_8080 == ["127.0.0.1:8080"]
    print(("PASS" if v2_safe else "FAIL") + " V2 TCP 8080 listeners: " + repr(port_8080))
    if not v2_safe:
        errors.append("V2 8080 must be loopback only")
    external_listen = any(addr not in ("127.0.0.1:50000", "[::1]:50000") for addr in port_50000)
    print(("PASS" if external_listen else "FAIL") + " WSS TCP 50000 listeners: " + repr(port_50000))
    if not external_listen:
        errors.append("WSS 50000 not listening on a public-capable interface")

    print("NOTE: this is a local read-only build/service check; does not prove Pages deployment, room behavior, or longevity")
    for error in errors:
        print("FAIL: " + error, file=sys.stderr)
    return 0 if not errors else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        patched = expected()
        if args.self_test:
            assert patched.count(REPLACEMENT) == 1
            assert NEEDLE not in patched
            print("SELF-TEST PASS: pinned source and listener-only transformation")
            return 0
        return check()
    except (AssertionError, OSError, subprocess.CalledProcessError) as exc:
        print("FAIL CLOSED: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
