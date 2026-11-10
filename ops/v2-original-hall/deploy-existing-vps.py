#!/usr/bin/env python3
"""V2 original-HALL in-place replacement. No writes unless --apply is explicitly supplied.

Scoped target: xingbei-hall.service -> /opt/xingbei-hall/server.js.
Never edits another unit, nginx config, firewall, DNS or frontend deployment.
"""
import argparse
import datetime as dt
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SERVICE = "xingbei-hall.service"
SOURCE = Path("/opt/xingbei-hall/server.js")
DIR = SOURCE.parent
BACKUPS = Path("/root/v2-original-hall-backups")
EXPECTED_GIT_BLOB = "49a0ad87ffc2638e3651fe6a08b5a150cdf38de3"
HOST = "v2-hall-direct.myxingbei.com"


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def command(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=check)


def fail(message: str) -> None:
    raise RuntimeError(message)


def unit_property(unit: str, prop: str) -> str:
    return command("systemctl", "show", unit, "-p", prop, "--value").stdout.strip()


def established_backend_count() -> int:
    # Connections inside Nginx -> 8080 are also real active players and must be drained.
    output = command("ss", "-H", "-tn", "state", "established").stdout
    count = 0
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 5 and fields[3].rsplit(":", 1)[-1] == "8080":
            count += 1
    return count


def preflight() -> None:
    if not SOURCE.is_file() or SOURCE.is_symlink():
        fail("Expected non-symlink, existing source: " + str(SOURCE))
    stat = SOURCE.stat()
    if stat.st_nlink != 1:
        fail("Source has multiple hard links: refusing to modify")
    state = unit_property(SERVICE, "ActiveState")
    if state != "active":
        fail(f"{SERVICE} is {state!r}, not active; identify the live unit before replacement")
    start = unit_property(SERVICE, "ExecStart")
    if str(SOURCE) not in start:
        fail(f"{SERVICE} ExecStart does not reference {SOURCE}; source/service mapping not verified")
    if not re.search(r"(?:^|[\s;/])node(?:\s|$)", start) and "/node" not in start:
        fail("ExecStart does not appear to run Node.js: manual inspection required")
    working = unit_property(SERVICE, "WorkingDirectory")
    if working and Path(working).resolve() != DIR:
        fail(f"Unexpected WorkingDirectory {working!r}; inspect service before replacement")

    # Fail closed if another known Xingbei/Noname systemd service references this exact source.
    units = command("systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager").stdout
    for line in units.splitlines():
        name = line.split()[0] if line.split() else ""
        if name == SERVICE or not name.endswith(".service"):
            continue
        if not any(word in name.lower() for word in ("xingbei", "noname", "hall", "m2")):
            continue
        if str(SOURCE) in unit_property(name, "ExecStart"):
            fail(f"Another service {name} also uses the same source; sharing must be resolved first")

    result = command("node", "-e", 'require.resolve("ws",{paths:["/opt/xingbei-hall"]})', check=False)
    if result.returncode != 0:
        fail("Node module 'ws' not resolvable from existing HALL path")
    sessions = established_backend_count()
    if sessions:
        fail(f"{sessions} established TCP connections to local 8080: drain all sessions before replacement")
    print("CHECK PASS: source/service mapping, ws dependency, and 0 active :8080 sessions")
    print("Target only:", SERVICE, "->", SOURCE)
    print("Current Git blob:", git_blob_sha(SOURCE.read_bytes()))
    print("Note: CHECK does not prove V1 does not also use this HALL via another route.")
    print("Note: DNS, TLS, firewall, nginx, port collision and other-version dependencies require separate checks.")


def replace_bytes(data: bytes, original_stat: os.stat_result) -> None:
    fd, name = tempfile.mkstemp(prefix=".v2-clean-hall-", suffix=".js", dir=DIR)
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(data)
            fp.flush()
            os.fsync(fp.fileno())
        os.chmod(tmp, original_stat.st_mode & 0o7777)
        os.chown(tmp, original_stat.st_uid, original_stat.st_gid)
        os.replace(tmp, SOURCE)
    finally:
        tmp.unlink(missing_ok=True)


def original_listening() -> bool:
    for _ in range(15):
        if unit_property(SERVICE, "ActiveState") != "active":
            return False
        result = command("ss", "-H", "-ltn", check=False)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 4 and parts[3].rsplit(":", 1)[-1] == "8080":
                    return True
        time.sleep(0.25)
    return False


def apply(source_file: Path, expected_ip: str) -> None:
    if os.geteuid() != 0:
        fail("--apply requires sudo/root")
    if not re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", expected_ip):
        fail("--expect-ip must be the new DNS-only VPS IPv4")
    import socket
    answers = {x[4][0] for x in socket.getaddrinfo(HOST, 50000, socket.AF_INET, socket.SOCK_STREAM)}
    if answers != {expected_ip}:
        fail(f"DNS A mismatch: {HOST} -> {sorted(answers)}, expected only {expected_ip}")

    preflight()
    if not source_file.is_file():
        fail("Provided pinned original game/server.js file not found")
    incoming = source_file.read_bytes()
    if git_blob_sha(incoming) != EXPECTED_GIT_BLOB:
        fail("Original HALL Git blob checksum mismatch; replacement refused")
    old = SOURCE.read_bytes()
    if old == incoming:
        print("ALREADY ORIGINAL: no replacement needed")
        return

    with tempfile.NamedTemporaryFile(suffix=".js", delete=False) as tf:
        tf.write(incoming)
        stage = Path(tf.name)
    try:
        command("node", "--check", str(stage))
    finally:
        stage.unlink(missing_ok=True)

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}"
    backup = BACKUPS / stamp
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(backup, 0o700)
    (backup / "server.js.before").write_bytes(old)
    (backup / "systemd-unit.before.txt").write_text(command("systemctl", "cat", SERVICE).stdout)
    (backup / "old-blob.txt").write_text(git_blob_sha(old) + "\n")
    os.chmod(backup / "server.js.before", 0o600)
    os.chmod(backup / "systemd-unit.before.txt", 0o600)

    original_stat = SOURCE.stat()
    print("Backup saved:", backup)
    try:
        command("systemctl", "stop", SERVICE)
        replace_bytes(incoming, original_stat)
        command("systemctl", "start", SERVICE)
        if not original_listening():
            fail("Service did not remain active and listen on local :8080")
    except Exception:
        print("APPLY FAILED; attempting automatic rollback of this one service", file=sys.stderr)
        command("systemctl", "stop", SERVICE, check=False)
        replace_bytes(old, original_stat)
        rollback = command("systemctl", "start", SERVICE, check=False)
        if rollback.returncode != 0 or not original_listening():
            print("ROLLBACK INCOMPLETE; inspect service immediately. Backup:", backup, file=sys.stderr)
        else:
            print("ROLLBACK SUCCEEDED; old HALL restored", file=sys.stderr)
        raise
    print("APPLY PASS: original HALL installed in-place; only", SERVICE, "was restarted")
    print("New blob:", git_blob_sha(SOURCE.read_bytes()))
    print("Next: verify WSS 101 + gameplay externally before publishing the new V2 frontend.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="read-only VPS and service preflight")
    modes.add_argument("--apply", action="store_true", help="replace in-place after checks and backups")
    modes.add_argument("--self-test", action="store_true", help="offline source and SHA contract only")
    parser.add_argument("--original-file", type=Path, help="staged pinned original game/server.js")
    parser.add_argument("--expect-ip", help="DNS-only public IPv4 of the existing VPS")
    parser.add_argument("--confirm", help="must equal REPLACE_V2_HALL for --apply")
    args = parser.parse_args()
    try:
        if args.self_test:
            local = Path(__file__).resolve().parents[2] / "game/server.js"
            assert git_blob_sha(local.read_bytes()) == EXPECTED_GIT_BLOB
            print("SELF-TEST PASS: pinned original game/server.js Git blob matches")
        elif args.check:
            preflight()
        else:
            if args.confirm != "REPLACE_V2_HALL" or not args.original_file or not args.expect_ip:
                fail("--apply requires --confirm REPLACE_V2_HALL, --original-file and --expect-ip")
            apply(args.original_file, args.expect_ip)
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError, AssertionError) as exc:
        print("FAIL CLOSED:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
