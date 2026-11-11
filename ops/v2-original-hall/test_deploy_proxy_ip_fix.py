#!/usr/bin/env python3
"""Offline V2-only rollback simulations. No writes to /opt or /etc."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location("v2_proxy_security_rollout", HERE / "deploy-proxy-ip-fix.py")
module = importlib.util.module_from_spec(s)
s.loader.exec_module(module)


class ProxySecurityRolloutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original, cls.candidate = module.inputs()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source = self.base / "server.js"
        self.source.write_bytes(self.original)
        self.site = self.base / "v2-original-hall-50000.conf"
        self.site.write_bytes((HERE / "nginx-wss-50000.conf.example").read_bytes().replace(
            b"        proxy_set_header X-V2-Client-IP $remote_addr;\n", b""
        ).replace(b'        proxy_set_header X-Forwarded-For "";\n', b""))
        self.backups = self.base / "backups"
        self.old_site = self.site.read_bytes()
        self.new_site = module.site_with_identity(self.old_site)
        self.fake_preflight = lambda expected, candidate: (self.source.read_bytes(), self.old_site, self.new_site)
        patches = [
            patch.object(module, "SOURCE", self.source),
            patch.object(module, "SITE", self.site),
            patch.object(module, "BACKUPS", self.backups),
            patch.object(module, "live_preflight", self.fake_preflight),
            patch.object(module.deployer, "established_backend_count", return_value=0),
            patch.object(module.deployer, "original_listening", return_value=True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.calls = []
        self.fail_once = None

    def fake_run(self, *args, check=True):
        self.calls.append(args)
        if self.fail_once and args == self.fail_once:
            self.fail_once = None
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, "active\n", "")

    def test_header_template_is_strict_idempotent_and_rejects_client_header_value(self):
        template = (HERE / "nginx-wss-50000.conf.example").read_bytes()
        self.assertEqual(module.site_with_identity(template), template)
        self.assertEqual(module.site_with_identity(self.new_site), self.new_site)
        poisoned = self.new_site.replace(b"$remote_addr", b"$http_x_v2_client_ip")
        with self.assertRaises(RuntimeError):
            module.site_with_identity(poisoned)

    def test_success_modifies_only_expected_v2_files(self):
        with patch.object(module, "run", side_effect=self.fake_run):
            module.apply(self.original, self.candidate)
        self.assertEqual(self.source.read_bytes(), self.candidate)
        self.assertEqual(self.site.read_bytes(), self.new_site)
        self.assertIn(("systemctl", "stop", module.SERVICE), self.calls)
        self.assertIn(("systemctl", "reload", "nginx"), self.calls)
        self.assertEqual(len(list(self.backups.iterdir())), 1)

    def test_failed_nginx_reload_rolls_back_site_before_touching_hall(self):
        self.fail_once = ("systemctl", "reload", "nginx")
        with patch.object(module, "run", side_effect=self.fake_run):
            with self.assertRaises(subprocess.CalledProcessError):
                module.apply(self.original, self.candidate)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.site.read_bytes(), self.old_site)
        self.assertNotIn(("systemctl", "stop", module.SERVICE), self.calls)

    def test_failed_hall_start_restores_source_and_nginx_site(self):
        self.fail_once = ("systemctl", "start", module.SERVICE)
        with patch.object(module, "run", side_effect=self.fake_run):
            with self.assertRaises(subprocess.CalledProcessError):
                module.apply(self.original, self.candidate)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.site.read_bytes(), self.old_site)
        self.assertEqual(self.calls.count(("systemctl", "start", module.SERVICE)), 2)

    def test_session_appears_after_nginx_reload_fails_closed(self):
        with patch.object(module, "run", side_effect=self.fake_run), patch.object(
            module.deployer, "established_backend_count", return_value=1
        ):
            with self.assertRaises(RuntimeError):
                module.apply(self.original, self.candidate)
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(self.site.read_bytes(), self.old_site)
        self.assertNotIn(("systemctl", "stop", module.SERVICE), self.calls)


if __name__ == "__main__":
    unittest.main()
