from __future__ import annotations

import base64
import unittest
from unittest.mock import patch

from PIL import Image

from desktop_agent.registry import ToolError
from desktop_agent import tools_screenshot


class ScreenVisionCaptureTests(unittest.TestCase):
    def test_view_screen_returns_legible_jpeg_without_creating_a_temp_file(self):
        image = Image.new("RGB", (2000, 1000), color=(35, 70, 105))
        with (
            patch.object(tools_screenshot, "_capture_active_display", return_value=(image, "Example App")),
            patch.object(tools_screenshot, "_cleanup_old_temp_files", return_value=0),
            patch.object(tools_screenshot, "_save_temp_frame") as save_temp,
        ):
            result = tools_screenshot.view_screen({"max_dim": 800, "keep_file": False})

        self.assertTrue(result["ok"])
        self.assertEqual(result["payload_width"], 800)
        self.assertEqual(result["payload_height"], 400)
        self.assertEqual(result["active_window"], "Example App")
        self.assertEqual(result["image_mime"], "image/jpeg")
        self.assertTrue(base64.b64decode(result["image_base64"]).startswith(b"\xff\xd8"))
        self.assertNotIn("temp_path", result)
        save_temp.assert_not_called()

    def test_view_screen_can_keep_an_explicit_debug_copy(self):
        image = Image.new("RGB", (640, 480), color="white")
        with (
            patch.object(tools_screenshot, "_capture_active_display", return_value=(image, "Editor")),
            patch.object(tools_screenshot, "_cleanup_old_temp_files", return_value=0),
            patch.object(
                tools_screenshot,
                "_save_temp_frame",
                return_value={"path": r"C:\Temp\view.jpg", "size_bytes": 123},
            ),
        ):
            result = tools_screenshot.view_screen({"keep_file": True})

        self.assertEqual(result["temp_path"], r"C:\Temp\view.jpg")
        self.assertEqual(result["temp_size_bytes"], 123)

    def test_capture_failure_is_returned_as_a_normal_tool_error(self):
        with patch.object(
            tools_screenshot,
            "_capture_active_display",
            side_effect=ToolError("Windows blocked capture"),
        ):
            result = tools_screenshot.view_screen({})

        self.assertFalse(result["ok"])
        self.assertIn("Windows blocked capture", result["error"])

    def test_only_the_packaged_abxag_window_is_excluded(self):
        self.assertTrue(tools_screenshot._is_abxag_window("ABxAG"))
        self.assertFalse(tools_screenshot._is_abxag_window("ABxAG docs - Browser"))
        self.assertFalse(tools_screenshot._is_abxag_window("Myra Analytics"))


if __name__ == "__main__":
    unittest.main()

