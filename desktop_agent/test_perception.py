from __future__ import annotations

import unittest

from desktop_agent.perception import collect_snapshot
from desktop_agent.tools_confirmation import consume_token, request_power_action
from desktop_agent.registry import ToolError


class PerceptionTests(unittest.TestCase):
    def test_snapshot_has_privacy_limited_shape(self) -> None:
        snapshot = collect_snapshot()
        self.assertEqual(
            set(snapshot),
            {"timestamp", "activeWindow", "applications", "disk", "downloads", "userIdleSeconds"},
        )
        self.assertNotIn("screenshot", snapshot)
        self.assertNotIn("clipboard", snapshot)
        self.assertNotIn("audio", snapshot)

    def test_power_confirmation_is_action_bound_and_single_use(self) -> None:
        pending = request_power_action({"action": "restart"})
        token = pending["token"]
        with self.assertRaises(ToolError):
            consume_token("shutdown", token)
        consume_token("restart", token)
        with self.assertRaises(ToolError):
            consume_token("restart", token)


if __name__ == "__main__":
    unittest.main()
