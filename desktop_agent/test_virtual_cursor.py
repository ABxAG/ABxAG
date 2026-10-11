"""Tests for the dual-cursor virtual (software) pointer.

Import-safe, no side effects: only exercises the in-process virtual state
machine and the pointer-safety guards. Never touches the OS cursor, never
needs a window. UIA/PostMessage paths are covered by live verification.
"""

import unittest

from desktop_agent.registry import TOOLS, ToolError
from desktop_agent import tools_virtual_cursor as vc


EXPECTED_TOOLS = [
    "virtualMove", "virtualClick", "virtualRightClick", "virtualDoubleClick",
    "virtualType", "virtualScroll", "virtualInspect", "virtualFind",
    "virtualUiAction", "virtualStatus", "pauseVirtual", "resumeVirtual",
]


class VirtualCursorTest(unittest.TestCase):
    def setUp(self) -> None:
        vc.resume_virtual({})

    def test_all_virtual_tools_registered(self) -> None:
        for name in EXPECTED_TOOLS:
            self.assertIn(name, TOOLS, f"{name} must be registered")

    def test_move_updates_state_only(self) -> None:
        out = vc.virtual_move({"x": 111, "y": 222, "task": "unit"})
        self.assertIn("Physical mouse untouched", out["result"])
        state = vc.virtual_status({})["result"]
        self.assertEqual((state["x"], state["y"]), (111, 222))
        self.assertEqual(state["task"], "unit")

    def test_move_needs_coordinates(self) -> None:
        with self.assertRaises(ToolError):
            vc.virtual_move({})

    def test_click_without_hwnd_records_intent_only(self) -> None:
        out = vc.virtual_click({"x": 10, "y": 10})
        self.assertIn("intent", out["result"])

    def test_type_needs_text(self) -> None:
        with self.assertRaises(ToolError):
            vc.virtual_type({})

    def test_type_without_hwnd_records_intent_only(self) -> None:
        out = vc.virtual_type({"text": "hello"})
        self.assertIn("intent", out["result"])

    def test_pointer_actions_rejected(self) -> None:
        for action in ("click", "double_click", "right_click", "hover", "scroll"):
            with self.assertRaises(ToolError, msg=action):
                vc.virtual_ui_action({"element_id": "e1", "action": action})

    def test_uiaction_needs_element_or_query(self) -> None:
        with self.assertRaises(ToolError):
            vc.virtual_ui_action({"action": "invoke"})

    def test_set_value_needs_value(self) -> None:
        with self.assertRaises(ToolError):
            vc.virtual_ui_action({"element_id": "e1", "action": "set_value"})

    def test_pause_blocks_actions(self) -> None:
        vc.pause_virtual({"reason": "unit"})
        with self.assertRaises(ToolError):
            vc.virtual_move({"x": 1, "y": 1})
        vc.resume_virtual({})
        vc.virtual_move({"x": 1, "y": 1})  # works again

    def test_no_pyautogui_import(self) -> None:
        import sys

        self.assertNotIn("pyautogui", sys.modules,
                         "virtual cursor module must never load pyautogui")


if __name__ == "__main__":
    unittest.main()
