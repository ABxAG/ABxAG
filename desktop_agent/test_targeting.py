from __future__ import annotations

import unittest

from PIL import Image

from desktop_agent import tools_targeting


class ExactTextMatchingTests(unittest.TestCase):
    def setUp(self) -> None:
        # Regression fixture from the reported Steam navigation row. Rectangles
        # are physical screenshot pixels: x, y, right, bottom.
        self.lines = [[
            {"text": "STORE", "rect": (69, 33, 126, 46)},
            {"text": "LIBRARY", "rect": (148, 33, 221, 46)},
            {"text": "COMMUNITY", "rect": (241, 33, 353, 46)},
            {"text": "SENSEI", "rect": (373, 33, 434, 46)},
        ]]

    def test_library_resolves_to_its_own_exact_center(self) -> None:
        matches = tools_targeting._match_ocr_lines(self.lines, "library")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["rect"], (148, 33, 221, 46))
        left, top, right, bottom = matches[0]["rect"]
        self.assertEqual(((left + right) // 2, (top + bottom) // 2), (184, 39))

    def test_typo_never_falls_through_to_neighboring_label(self) -> None:
        self.assertEqual(tools_targeting._match_ocr_lines(self.lines, "libary"), [])
        self.assertEqual(tools_targeting._match_ocr_lines(self.lines, "community library"), [])

    def test_multi_word_label_requires_consecutive_exact_words(self) -> None:
        lines = [[
            {"text": "Manage", "rect": (884, 1009, 931, 1023)},
            {"text": "Downloads", "rect": (935, 1009, 1007, 1023)},
        ]]
        matches = tools_targeting._match_ocr_lines(lines, "Manage Downloads")
        self.assertEqual(matches[0]["rect"], (884, 1009, 1007, 1023))

    def test_full_youtube_video_title_targets_the_mrbeast_card(self) -> None:
        lines = [[
            {"text": "MrBeast", "rect": (1401, 536, 1461, 548)},
            {"text": "Hit", "rect": (1466, 536, 1486, 548)},
            {"text": "1", "rect": (1491, 536, 1497, 548)},
            {"text": "Subscriber!", "rect": (1503, 536, 1584, 548)},
        ]]
        matches = tools_targeting._match_ocr_lines(lines, "MrBeast Hit 1 Subscriber!")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["rect"], (1401, 536, 1584, 548))


class VisualVerificationTests(unittest.TestCase):
    def test_identical_frames_have_zero_change(self) -> None:
        frame = Image.new("RGB", (100, 80), "black")
        self.assertEqual(tools_targeting._change_score(frame, frame.copy()), 0.0)

    def test_different_frames_report_change(self) -> None:
        before = Image.new("RGB", (100, 80), "black")
        after = Image.new("RGB", (100, 80), "white")
        self.assertEqual(tools_targeting._change_score(before, after), 1.0)


if __name__ == "__main__":
    unittest.main()
