import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "package-skill.py"
spec = importlib.util.spec_from_file_location("package_skill", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        (self.repo / "scripts").mkdir()
        self.root = self.repo / "skills/demo"
        self.root.mkdir(parents=True)
        (self.repo / "scripts/package-skill.py").write_bytes(SCRIPT.read_bytes())
        self.manifest = self.repo / "scripts/skill-packages.json"
        self.manifest.write_text(json.dumps({"demo": ["SKILL.md"]}))
        (self.root / "SKILL.md").write_text("# Generic skill\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def test_whitelist_excludes_unlisted_private_files_and_requires_tracking(self):
        (self.root / "config.json").write_text('{"private":true}')
        files, untracked = module.collect_files(self.repo, "demo")
        self.assertEqual([name for name, _ in files], ["SKILL.md"])
        self.assertEqual(untracked, ["SKILL.md"])
        command = ["python3", str(self.repo / "scripts/package-skill.py"), "demo"]
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        subprocess.run(["git", "-C", str(self.repo), "add", "skills/demo/SKILL.md"], check=True)
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        with zipfile.ZipFile(self.repo / "dist/demo.skill") as archive:
            self.assertEqual(archive.namelist(), ["demo/SKILL.md"])
            self.assertIsNone(archive.testzip())

    def test_sensitive_content_is_rejected_without_echoing_value(self):
        for content in ["/Users/private-person/Work/app", "ou_0123456789abcdef0123456789abcdef", 'app_secret="sensitive-value-123456789"']:
            (self.root / "SKILL.md").write_text(content)
            with self.assertRaises(ValueError) as error: module.collect_files(self.repo, "demo")
            self.assertNotIn(content, str(error.exception))

    def test_symlinks_and_private_manifest_entries_are_rejected(self):
        (self.root / "SKILL.md").unlink()
        (self.repo / "private.txt").write_text("private")
        (self.root / "SKILL.md").symlink_to(self.repo / "private.txt")
        with self.assertRaisesRegex(ValueError, "软链接"): module.collect_files(self.repo, "demo")
        for entry in ["../private.txt", "config.json", "state/ledger.json"]:
            self.manifest.write_text(json.dumps({"demo": [entry]}))
            with self.assertRaises(ValueError): module.collect_files(self.repo, "demo")


if __name__ == "__main__": unittest.main()
