from __future__ import annotations

import unittest
from unittest.mock import patch

from desktop_agent import tools_websites


class SingleTabNavigationTests(unittest.TestCase):
    @patch.object(tools_websites.webbrowser, "open")
    @patch.object(tools_websites, "_navigate_active_browser", return_value=True)
    def test_active_browser_reuses_current_tab(self, _navigate, browser_open) -> None:
        result = tools_websites.open_url("https://www.youtube.com/results?search_query=ABxAG")
        self.assertIn("youtube.com/results", result)
        browser_open.assert_not_called()

    @patch.object(tools_websites.time, "sleep")
    @patch.object(tools_websites.webbrowser, "open", return_value=True)
    @patch.object(tools_websites, "_navigate_active_browser", return_value=False)
    def test_inactive_browser_receives_exactly_one_open_request(self, _navigate, browser_open, _sleep) -> None:
        tools_websites.open_url("youtube.com")
        browser_open.assert_called_once_with("https://youtube.com", new=2)


if __name__ == "__main__":
    unittest.main()

