import os
import platform
import tempfile
import time
import unittest
from pathlib import Path

from desktop_agent.registry import TOOLS, ToolError, load_all

load_all()


class FileExtTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_kind_classification(self):
        from desktop_agent.tools_files_ext import kind_of

        self.assertEqual(kind_of(Path("a.PNG")), "image")
        self.assertEqual(kind_of(Path("setup.msi")), "executable")
        self.assertEqual(kind_of(Path("notes.md")), "document")
        self.assertEqual(kind_of(Path("x.unknown")), "other")

    def test_recent_files_orders_by_mtime_and_dedupes_nested_roots(self):
        nested = self.root / "Screens"
        nested.mkdir()
        older = self.root / "old.png"
        newer = nested / "new.png"
        older.write_bytes(b"x")
        newer.write_bytes(b"x")
        past = time.time() - 3600
        os.utime(older, (past, past))
        (self.root / "doc.txt").write_text("x")
        result = TOOLS["recentFiles"]({"folders": [str(self.root), str(nested)], "kinds": ["image"], "allow_anywhere": True})
        names = [item["name"] for item in result["files"]]
        self.assertEqual(names, ["new.png", "old.png"])

    def test_open_path_refuses_executables_without_confirmation(self):
        script = self.root / "run.bat"
        script.write_text("echo hi")
        with self.assertRaises(ToolError) as caught:
            TOOLS["openPath"]({"path": str(script)})
        self.assertIn("CONFIRMATION_REQUIRED", caught.exception.message)

    def test_copy_never_overwrites_silently(self):
        source = self.root / "a.txt"
        source.write_text("one")
        target = self.root / "b.txt"
        target.write_text("two")
        with self.assertRaises(ToolError):
            TOOLS["copyFile"]({"path": str(source), "destination": str(target), "allow_anywhere": True})
        self.assertEqual(target.read_text(), "two")
        TOOLS["copyFile"]({"path": str(source), "destination": str(target), "overwrite": True, "allow_anywhere": True})
        self.assertEqual(target.read_text(), "one")

    def test_stat_reports_partial_download(self):
        final = self.root / "blender.msi"
        Path(str(final) + ".crdownload").write_bytes(b"partial")
        result = TOOLS["statPath"]({"path": str(final)})
        self.assertFalse(result["exists"])
        self.assertTrue(result["partial_download"].endswith(".crdownload"))


@unittest.skipUnless(platform.system() == "Windows", "UI Automation is Windows-only")
class UiaTests(unittest.TestCase):
    def test_unknown_element_is_reported_not_clicked(self):
        with self.assertRaises(ToolError) as caught:
            TOOLS["uiAction"]({"element_id": "e9999", "snapshot_id": "s-missing"})
        self.assertIn("ELEMENT_NOT_FOUND", caught.exception.message)

    def test_inspect_returns_ids_roles_and_live_rects(self):
        snapshot = TOOLS["inspectUi"]({"max_elements": 20})
        self.assertTrue(snapshot["snapshot_id"].startswith("s"))
        for element in snapshot["elements"]:
            self.assertRegex(element["id"], r"^e\d+$")
            rect = element["rect"]
            self.assertLess(rect["left"], rect["right"])
            self.assertLess(rect["top"], rect["bottom"])
            self.assertNotIn("value", element if element.get("password") else {})

    def test_fingerprint_grid_shape(self):
        result = TOOLS["screenFingerprint"]({"columns": 8, "rows": 4})
        self.assertEqual(len(result["cells"]), 32)


if __name__ == "__main__":
    unittest.main()
