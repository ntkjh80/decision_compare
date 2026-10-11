"""실제 임시 venv로 생성·재사용·인자 전달과 기존 환경 보존을 확인한다."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import bootstrap


class BootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 다른 이름·공백·한글 경로에서도 경로를 쉘 문자열로 잘못 분리하지 않는지 확인한다.
        cls.temp = tempfile.TemporaryDirectory(prefix="decision venv ")
        cls.root = Path(cls.temp.name) / "한글 project"
        cls.root.mkdir()
        with contextlib.redirect_stdout(io.StringIO()):
            cls.python = bootstrap.ensure_environment(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_creation_and_reuse_preserve_installed_files(self):
        sentinel = self.root / ".venv/keep-existing.txt"
        sentinel.write_text("existing package or user file")
        cfg = self.root / ".venv/pyvenv.cfg"
        original = cfg.read_bytes()
        self.assertEqual(bootstrap.ensure_environment(self.root), self.python)
        self.assertEqual(cfg.read_bytes(), original)
        self.assertEqual(sentinel.read_text(), "existing package or user file")
        info = json.loads(subprocess.check_output(
            [str(self.python), "-c", "import sys,json;print(json.dumps([sys.prefix,sys.base_prefix]))"],
            text=True,
        ))
        self.assertEqual(Path(info[0]).resolve(), self.root.resolve() / ".venv")
        self.assertNotEqual(info[0], info[1])

    def test_script_uses_venv_forwards_arguments_and_exit_status(self):
        # 모델이나 웹 서버 대신 허용된 진입 파일 이름에 짧은 확인 프로그램을 둔다.
        shutil.copy2(bootstrap.__file__, self.root / "bootstrap.py")
        (self.root / "server.py").write_text(
            "import json,sys,os\n"
            "print(json.dumps({'prefix':sys.prefix,'args':sys.argv[1:],"
            "'virtual_env':os.environ.get('VIRTUAL_ENV'),"
            "'pythonpath':os.environ.get('PYTHONPATH')}))\n"
            "sys.exit(7)\n"
        )
        result = subprocess.run(
            [sys.executable, str(self.root / "bootstrap.py"), "server.py", "--port", "8123", "공백 인자"],
            env=dict(os.environ, PYTHONPATH="/unused-other-project", VIRTUAL_ENV="/another-venv"),
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 7, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(Path(data["prefix"]).resolve(), self.root.resolve() / ".venv")
        self.assertEqual(data["args"], ["--port", "8123", "공백 인자"])
        self.assertEqual(data["virtual_env"], str(self.root.resolve() / ".venv"))
        self.assertIsNone(data["pythonpath"])

    def test_incomplete_existing_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".venv").mkdir()
            note = root / ".venv/important.txt"
            note.write_text("keep me")
            with self.assertRaisesRegex(RuntimeError, "삭제하지 않았습니다"):
                bootstrap.ensure_environment(root)
            self.assertEqual(note.read_text(), "keep me")
            self.assertFalse((root / ".venv/pyvenv.cfg").exists())

    @unittest.skipUnless(shutil.which("zsh"), "Finder launcher requires zsh")
    def test_finder_launcher_passes_flags_and_failure_status_without_prompt(self):
        # setup_mac의 실제 다운로드 대신 독립된 확인 파일로 Finder 래퍼까지 실행한다.
        source = Path(bootstrap.__file__).parent
        shutil.copy2(source / "bootstrap.py", self.root / "bootstrap.py")
        shutil.copy2(source / "setup.command", self.root / "setup.command")
        (self.root / "setup_mac.py").write_text(
            "import json,sys\nprint(json.dumps([sys.prefix,sys.argv[1:]]))\nsys.exit(9)\n"
        )
        result = subprocess.run(
            ["zsh", str(self.root / "setup.command"), "--check"],
            env=dict(os.environ, PYTHONHOME="/invalid-other-python", PYTHONPATH="/another-project"),
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 9, result.stderr)
        prefix, args = json.loads(result.stdout)
        self.assertEqual(Path(prefix).resolve(), self.root.resolve() / ".venv")
        self.assertEqual(args, ["--check"])

    def test_copied_environment_requests_recreation_without_overwriting(self):
        marker = self.root / ".venv" / bootstrap.LOCATION_FILE
        saved = marker.read_text()
        try:
            marker.write_text("/different-mac/project/.venv\n")
            with self.assertRaisesRegex(RuntimeError, "다른 위치"):
                bootstrap.ensure_environment(self.root)
            self.assertEqual(marker.read_text(), "/different-mac/project/.venv\n")
        finally:
            marker.write_text(saved)

    def test_shared_system_packages_are_rejected_without_config_changes(self):
        cfg = self.root / ".venv/pyvenv.cfg"
        saved = cfg.read_text()
        shared = saved.replace("include-system-site-packages = false", "include-system-site-packages = true")
        self.assertNotEqual(saved, shared)
        try:
            cfg.write_text(shared)
            with self.assertRaisesRegex(RuntimeError, "분리된 venv"):
                bootstrap.ensure_environment(self.root)
            self.assertEqual(cfg.read_text(), shared)
        finally:
            cfg.write_text(saved)

    def test_symlink_does_not_modify_another_project(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            marker = self.root / ".venv" / bootstrap.LOCATION_FILE
            saved = marker.read_bytes()
            (root / ".venv").symlink_to(self.root / ".venv", target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "링크"):
                bootstrap.ensure_environment(root)
            self.assertEqual(marker.read_bytes(), saved)

    def test_unknown_entry_point_is_rejected_before_creating_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shutil.copy2(bootstrap.__file__, root / "bootstrap.py")
            result = subprocess.run(
                [sys.executable, str(root / "bootstrap.py"), "other.py"],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertFalse((root / ".venv").exists())


if __name__ == "__main__":
    unittest.main()
