from __future__ import annotations

import unittest
from unittest.mock import patch

from desktop_agent.registry import ToolError
from desktop_agent import tools_applications


class ApplicationDiscoveryTests(unittest.TestCase):
    def test_exact_installed_name_beats_similar_name(self) -> None:
        self.assertGreater(
            tools_applications._candidate_score("Steam", "Steam"),
            tools_applications._candidate_score("Steam", "SteamTools"),
        )
        self.assertEqual(tools_applications._candidate_score("Steam", "SteamTools"), 0)
        self.assertEqual(tools_applications._candidate_score("Discord", "Adobe Photoshop"), 0)

    @patch.object(tools_applications, "_launch_via_windows_search")
    @patch.object(tools_applications, "_discover_application", return_value=None)
    def test_unknown_app_uses_windows_search_instead_of_supported_list(self, _discover, search) -> None:
        result = tools_applications.open_application({"name": "A New Installed App"})
        search.assert_called_once_with("A New Installed App")
        self.assertEqual(result["method"], "windows_search_keyboard")

    @patch.object(tools_applications, "_launch_discovered")
    @patch.object(tools_applications, "_discover_application")
    def test_discovered_app_is_launched(self, discover, launch) -> None:
        discover.return_value = {"label": "Steam", "path": "C:/Steam/steam.exe", "method": "installed_apps"}
        result = tools_applications.open_application({"name": "Steam"})
        launch.assert_called_once_with(discover.return_value)
        self.assertEqual(result["application"], "Steam")

    @patch.object(tools_applications, "_close_windows_with_keyboard", return_value=1)
    @patch.object(tools_applications, "_matching_windows")
    def test_arbitrary_visible_app_closes_with_keyboard(self, matching, close_windows) -> None:
        matching.return_value = [{"hwnd": 10, "title": "Example App", "score": 1000}]
        result = tools_applications.close_application({"name": "Example App"})
        close_windows.assert_called_once()
        self.assertEqual(result["method"], "keyboard_alt_f4")

    @patch.object(tools_applications, "_matching_windows", return_value=[])
    def test_missing_running_app_reports_search_not_allowlist(self, _matching) -> None:
        with self.assertRaises(ToolError) as caught:
            tools_applications.close_application({"name": "Not Running"})
        self.assertIn("not limited by a supported-app list", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
