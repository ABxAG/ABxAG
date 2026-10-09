from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent import tools_input


class FakeGui:
    KEYBOARD_KEYS = ["ctrl", "shift", "a", "enter", "esc"]
    FAILSAFE = False
    PAUSE = 0

    def __init__(self):
        self.calls = []

    def size(self):
        return SimpleNamespace(width=1920, height=1080)

    def position(self):
        return SimpleNamespace(x=100, y=200)

    def click(self, **kwargs):
        self.calls.append(("click", kwargs))

    def hotkey(self, *keys):
        self.calls.append(("hotkey", keys))

    def write(self, text, interval=0):
        self.calls.append(("write", text, interval))


class GenericInputTests(unittest.TestCase):
    def setUp(self):
        self.gui = FakeGui()
        self.gui_patch = patch.object(tools_input, "_pyautogui", return_value=self.gui)
        self.bounds_patch = patch.object(tools_input, "_desktop_bounds", return_value=(0, 0, 1920, 1080))
        self.window_patch = patch.object(tools_input, "_active_window", return_value={"title": "Editor", "pid": 1, "bounds": None})
        self.gui_patch.start()
        self.bounds_patch.start()
        self.window_patch.start()

    def tearDown(self):
        self.gui_patch.stop()
        self.bounds_patch.stop()
        self.window_patch.stop()

    def test_click_is_bounded_and_returns_post_action_observation(self):
        result = tools_input.click({"x": 500, "y": 400})
        self.assertEqual(self.gui.calls[0][0], "click")
        self.assertEqual(result["observation"]["active_window"]["title"], "Editor")
        with self.assertRaises(ToolError):
            tools_input.click({"x": 5000, "y": 400})

    def test_hotkey_rejects_unknown_keys(self):
        tools_input.hotkey({"keys": ["ctrl", "a"]})
        self.assertEqual(self.gui.calls[0], ("hotkey", ("ctrl", "a")))
        with self.assertRaises(ToolError):
            tools_input.hotkey({"keys": ["ctrl", "not-a-real-key"]})

    def test_type_text_has_a_hard_size_limit(self):
        result = tools_input.type_text({"text": "hello"})
        self.assertEqual(result["observation"]["cursor"], {"x": 100, "y": 200})
        with self.assertRaises(ToolError):
            tools_input.type_text({"text": "x" * 10_001})


if __name__ == "__main__":
    unittest.main()
