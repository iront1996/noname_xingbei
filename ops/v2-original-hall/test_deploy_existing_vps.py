"""Offline unit tests for the in-place V2 Hall deployer; never call real systemctl."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

THIS = Path(__file__).resolve()
SCRIPT = THIS.with_name("deploy-existing-vps.py")
spec = importlib.util.spec_from_file_location("v2_inplace", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ORIGINAL = THIS.parents[1] / ".." / "game" / "server.js"
ORIGINAL = ORIGINAL.resolve()


class InPlaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "server.js"
        self.source.write_bytes(b"old-v2-a1-monitored-service")
        self.source_patch = patch.object(module, "SOURCE", self.source)
        self.dir_patch = patch.object(module, "DIR", self.root)
        self.backup_patch = patch.object(module, "BACKUPS", self.root / "backups")
        self.source_patch.start()
        self.dir_patch.start()
        self.backup_patch.start()
        self.addCleanup(self.source_patch.stop)
        self.addCleanup(self.dir_patch.stop)
        self.addCleanup(self.backup_patch.stop)

    def test_original_hash_matches_pinned_commit(self):
        self.assertEqual(module.git_blob_sha(ORIGINAL.read_bytes()), module.EXPECTED_GIT_BLOB)
        hardened = module.original_with_loopback(ORIGINAL.read_bytes())
        self.assertEqual(hardened.count(module.LOOPBACK_LISTENER), 1)
        self.assertNotIn(module.ORIGINAL_LISTENER, hardened)
        self.assertEqual(len(hardened.splitlines()), len(ORIGINAL.read_bytes().splitlines()))

    def test_preflight_rejects_wrong_unit_mapping_before_mutation(self):
        def prop(unit, p):
            return {"ActiveState": "active", "ExecStart": "/usr/bin/node /opt/other/server.js"}[p]
        with patch.object(module, "unit_property", side_effect=prop):
            with self.assertRaisesRegex(RuntimeError, "does not reference"):
                module.preflight()
        self.assertEqual(self.source.read_bytes(), b"old-v2-a1-monitored-service")

    def test_preflight_rejects_nonzero_active_connections(self):
        def prop(unit, p):
            return {"ActiveState": "active",
                    "ExecStart": "node " + str(self.source),
                    "WorkingDirectory": str(self.root)}[p]
        with patch.object(module, "unit_property", side_effect=prop):
            with patch.object(module, "command", side_effect=[
                    subprocess.CompletedProcess([], 0, "xingbei-hall.service enabled\n", ""),
                    subprocess.CompletedProcess([], 0, "", "")]):
                with patch.object(module, "established_backend_count", return_value=1):
                    with self.assertRaisesRegex(RuntimeError, "established TCP"):
                        module.preflight()
        self.assertEqual(self.source.read_bytes(), b"old-v2-a1-monitored-service")

    @staticmethod
    def mocked_dns(*args, **kwargs):
        return [(2, 1, 6, "", ("203.0.113.10", 50000))]

    def test_apply_rejects_wrong_original_source_before_backup_or_stop(self):
        replacement = self.root / "not-original.js"
        replacement.write_bytes(b"tampered")
        with patch.object(module.os, "geteuid", return_value=0), \
             patch("socket.getaddrinfo", side_effect=self.mocked_dns), \
             patch.object(module, "preflight"), \
             patch.object(module, "command") as cmd:
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                module.apply(replacement, "203.0.113.10")
            cmd.assert_not_called()
        self.assertEqual(self.source.read_bytes(), b"old-v2-a1-monitored-service")
        self.assertFalse((self.root / "backups").exists())

    def test_apply_success_reuses_current_service_and_saves_backup(self):
        original = ORIGINAL.read_bytes()
        with patch.object(module.os, "geteuid", return_value=0), \
             patch("socket.getaddrinfo", side_effect=self.mocked_dns), \
             patch.object(module, "preflight"), \
             patch.object(module, "original_listening", return_value=True), \
             patch.object(module, "command") as cmd:
            cmd.return_value = subprocess.CompletedProcess([], 0, "checked", "")
            module.apply(ORIGINAL, "203.0.113.10")
            operations = [tuple(c.args) for c in cmd.call_args_list]
        self.assertEqual(self.source.read_bytes(), module.original_with_loopback(original))
        self.assertIn(("systemctl", "stop", "xingbei-hall.service"), operations)
        self.assertIn(("systemctl", "start", "xingbei-hall.service"), operations)
        self.assertEqual(len(list((self.root / "backups").glob("*/server.js.before"))), 1)

    def test_listening_checker_requires_loopback_only(self):
        with patch.object(module, "unit_property", return_value="active"):
            with patch.object(module, "command", return_value=subprocess.CompletedProcess(
                [], 0, "LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*\n", ""
            )), patch.object(module.time, "sleep"):
                # No unconditional acceptance of public exposure, even if port 8080 exists.
                self.assertFalse(module.original_listening())
            with patch.object(module, "command", return_value=subprocess.CompletedProcess(
                [], 0, "LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*\n", ""
            )), patch.object(module.time, "sleep"):
                self.assertTrue(module.original_listening())

    def test_apply_rolls_back_on_failed_start(self):
        def cmd(*args, **kwargs):
            if args[:2] == ("systemctl", "start") and not getattr(cmd, "failed", False):
                cmd.failed = True
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, "old unit", "")
        with patch.object(module.os, "geteuid", return_value=0), \
             patch("socket.getaddrinfo", side_effect=self.mocked_dns), \
             patch.object(module, "preflight"), \
             patch.object(module, "original_listening", return_value=True), \
             patch.object(module, "command", side_effect=cmd):
            with self.assertRaises(subprocess.CalledProcessError):
                module.apply(ORIGINAL, "203.0.113.10")
        self.assertEqual(self.source.read_bytes(), b"old-v2-a1-monitored-service")
        self.assertEqual(len(list((self.root / "backups").glob("*/server.js.before"))), 1)


if __name__ == "__main__":
    unittest.main()
