#!/usr/bin/env python3
"""No-VPS and no-service side effects: rollback simulation for relay text security fix."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("v2_text_relay_release", HERE / "deploy-relay-text-fix.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RelayTextFixOfflineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before, cls.after = module.inputs()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.live = self.base / "server.js"
        self.live.write_bytes(self.before)
        self.backups = self.base / "backups"
        self.called = []
        self.failed_command_once = None
        p = [
            patch.object(module, "SOURCE", self.live),
            patch.object(module, "BACKUPS", self.backups),
            patch.object(module, "preflight", side_effect=lambda old, new: self.live.read_bytes()),
            patch.object(module.proxy.deployer, "original_listening", return_value=True),
            patch.object(module.proxy.deployer, "established_backend_count", return_value=0),
            patch.object(module.proxy, "site_with_identity", side_effect=lambda content: content),
            patch.object(module.proxy.SITE.__class__, "read_bytes", autospec=True) if False else None,
        ]
        for item in p:
            if item is None:
                continue
            item.start()
            self.addCleanup(item.stop)
        # Live Nginx site check in apply can be satisfied by an isolated temp file.
        site = self.base / "nginx-site.conf"
        site.write_bytes(b"trusted-proxy-header-pass")
        patcher = patch.object(module.proxy, "SITE", site)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.site = site

    def fake_run(self, *args, check=True):
        self.called.append(args)
        if args == self.failed_command_once:
            self.failed_command_once = None
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, "active\n", "")

    def test_pinned_text_transform_exactly_preserves_previous_security_baseline(self):
        self.assertEqual(module.sha256(self.before), module.EXPECTED_LIVE_SHA256)
        self.assertNotEqual(self.before, self.after)
        self.assertEqual(self.after.count(b"ws._v2ClientAddress = ip;"), 1)
        self.assertEqual(self.after.count(b'ws.send("heartbeat")'), 1)
        self.assertEqual(self.after.count(b'message.toString("utf8")'), 1)

    def test_success_updates_single_v2_server_only_and_creates_backup(self):
        with patch.object(module, "run", side_effect=self.fake_run):
            module.apply(self.before, self.after)
        self.assertEqual(self.live.read_bytes(), self.after)
        self.assertIn(("systemctl", "stop", module.SERVICE), self.called)
        self.assertIn(("systemctl", "start", module.SERVICE), self.called)
        self.assertEqual(len(list(self.backups.iterdir())), 1)
        self.assertEqual(self.site.read_bytes(), b"trusted-proxy-header-pass")

    def test_hall_start_failure_rolls_back_original_v2_security_candidate(self):
        self.failed_command_once = ("systemctl", "start", module.SERVICE)
        with patch.object(module, "run", side_effect=self.fake_run):
            with self.assertRaises(subprocess.CalledProcessError):
                module.apply(self.before, self.after)
        self.assertEqual(self.live.read_bytes(), self.before)
        self.assertEqual(self.called.count(("systemctl", "start", module.SERVICE)), 2)

    def test_existing_player_blocks_restart_and_keeps_source_untouched(self):
        with patch.object(module.proxy.deployer, "established_backend_count", return_value=1), \
             patch.object(module, "run", side_effect=self.fake_run):
            with self.assertRaises(RuntimeError):
                module.apply(self.before, self.after)
        self.assertEqual(self.live.read_bytes(), self.before)
        self.assertNotIn(("systemctl", "stop", module.SERVICE), self.called)

    def test_already_patched_does_not_restart(self):
        self.live.write_bytes(self.after)
        with patch.object(module, "run", side_effect=self.fake_run):
            module.apply(self.before, self.after)
        self.assertEqual(self.called, [])

if __name__ == "__main__":
    unittest.main()
