"""Virtual cursor tools — pure state machine tests.

No test here touches the OS cursor, posts window messages, or needs a
window: hwnd-less calls record intent only, and pause gates everything.
"""
from __future__ import annotations

import unittest

from desktop_agent import tools_virtual_cursor as vc
from desktop_agent.registry import DESKTOP_TOOL_NAMES, ToolError, load_all


EXPECTED_TOOLS = [
    "virtualMove",
    "virtualClick",
    "virtualRightClick",
    "virtualDoubleClick",
    "virtualType",
    "virtualScroll",
    "virtualInspect",
    "virtualFind",
    "virtualUiAction",
    "virtualStatus",
    "pauseVirtual",
    "resumeVirtual",
]


class VirtualCursorTests(unittest.TestCase):
    def setUp(self):
        vc.resume_virtual({})

    def tearDown(self):
        vc.resume_virtual({})

    def test_all_twelve_tools_registered(self):
        load_all()
        for name in EXPECTED_TOOLS:
            self.assertIn(name, DESKTOP_TOOL_NAMES, name)

    def test_move_updates_rendered_state_only(self):
        out = vc.virtual_move({"x": 111, "y": 222, "task": "test"})
        self.assertIn("(111, 222)", out["result"])
        state = vc.virtual_status({})["result"]
        self.assertEqual((state["x"], state["y"]), (111, 222))
        self.assertEqual(state["status"], "active")

    def test_move_needs_integers(self):
        with self.assertRaises(ToolError):
            vc.virtual_move({"x": "left", "y": 10})

    def test_click_without_hwnd_records_intent_no_os_click(self):
        out = vc.virtual_click({"x": 10, "y": 10})
        self.assertIn("no hwnd", out["result"])

    def test_type_needs_text_and_records_intent(self):
        with self.assertRaises(ToolError):
            vc.virtual_type({})
        out = vc.virtual_type({"text": "hello"})
        self.assertIn("intent", out["result"])

    def test_type_rejects_huge_text(self):
        with self.assertRaises(ToolError):
            vc.virtual_type({"text": "x" * 2001})

    def test_find_needs_query(self):
        with self.assertRaises(ToolError):
            vc.virtual_find({})

    def test_ui_action_rejects_pointer_needing_actions(self):
        with self.assertRaises(ToolError) as ctx:
            vc.virtual_ui_action({"action": "drag"})
        self.assertIn("VIRTUAL_NO_POINTER", str(ctx.exception))

    def test_ui_action_set_value_needs_value(self):
        with self.assertRaises(ToolError):
            vc.virtual_ui_action({"action": "set_value", "element_id": "nope"})

    def test_pause_gates_everything_until_resume(self):
        vc.pause_virtual({"reason": "test"})
        self.assertEqual(vc.virtual_status({})["result"]["status"], "paused")
        with self.assertRaises(ToolError) as ctx:
            vc.virtual_move({"x": 1, "y": 1})
        self.assertIn("VIRTUAL_PAUSED", str(ctx.exception))
        vc.resume_virtual({})
        vc.virtual_move({"x": 1, "y": 1})  # works again

    def test_post_click_rejects_unknown_kind_without_messaging(self):
        with self.assertRaises(ToolError):
            vc._post_click(12345, 0, 0, "middle")


if __name__ == "__main__":
    unittest.main()
