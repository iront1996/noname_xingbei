#!/usr/bin/env python3
"""Read-only offline compatibility preflight for a *copy* of the actual HALL source.

Never writes to, reloads, restarts, or calls any production service. A positive
result establishes only syntax, strict patch anchors and marker preservation;
not runtime monitor v2.3 behavior or production build compatibility.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from patch_server_b2 import patch

MONITOR = 'XINGBEI-MONITOR DISCONNECT V2.3'
HEALTH = 'XINGBEI-CONNECTION-HEALTH A1'
WATCH = 'XINGBEI-V2 HALL WATCH'


def preflight(source_path, expected_sha256=None):
    checks = {}
    source_path = Path(source_path)
    original_bytes = source_path.read_bytes()
    digest = hashlib.sha256(original_bytes).hexdigest()
    if expected_sha256 is not None:
        if (len(expected_sha256) != 64 or
                not all(c in '0123456789abcdef' for c in expected_sha256.lower())):
            raise ValueError('expected SHA-256 must contain exactly 64 hex characters')
        if digest.lower() != expected_sha256.lower():
            raise ValueError('source SHA-256 does not match the expected value')
    checks['source_sha256'] = digest
    source = original_bytes.decode('utf-8')
    for mark, label in [(HEALTH, 'a1'), (MONITOR, 'monitor_v2_3')]:
        if source.count(mark) != 1:
            raise ValueError(f'{label} marker must appear exactly once in source')
    checks['prerequisite_markers_unique'] = True
    patched = patch(source)  # patcher itself fails closed for unknown anchors
    checks['strict_patcher_anchors'] = True
    for mark in (HEALTH, MONITOR):
        if patched.count(mark) != 1:
            raise ValueError('an existing health/monitor marker was lost or duplicated')
    if patched.count(WATCH) != 1 or patched.count('// XINGBEI-RECOVERY B2') < 1:
        raise ValueError('required B2/watch addition absent')
    checks['monitor_and_health_markers_preserved'] = True
    # The actual JS parser must accept exactly the emitted server.js.
    node = shutil.which('node')
    if not node:
        raise ValueError('node executable is required for syntax validation')
    with tempfile.TemporaryDirectory(prefix='xingbei-v2-preflight-') as directory:
        candidate = Path(directory) / 'server.js'
        candidate.write_text(patched, encoding='utf-8')
        syntax = subprocess.run([node, '--check', str(candidate)],
                                capture_output=True, text=True, timeout=20)
        if syntax.returncode != 0:
            raise ValueError('patched Node.js syntax check failed')
    checks['patched_node_syntax'] = True
    if source_path.read_bytes() != original_bytes:
        raise ValueError('input source unexpectedly changed during dry run')
    checks['source_unchanged'] = True
    # Never return source text, room/player IDs, secrets or monitored event logs.
    return {'ok': True, 'checks': checks, 'patched_sha256':
            hashlib.sha256(patched.encode('utf-8')).hexdigest(),
            'deploy_performed': False, 'runtime_compatible': 'not_verified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True,
                        help='local, redacted COPY of installed HALL server.js')
    parser.add_argument('--expected-sha256')
    args = parser.parse_args()
    try:
        result = preflight(args.source, args.expected_sha256)
    except (OSError, UnicodeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({'ok': False, 'error': str(exc),
                          'deploy_performed': False}), file=sys.stdout)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
