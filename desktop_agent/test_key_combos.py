import unittest

from desktop_agent.tools_input import _split_combo


class KeyComboTests(unittest.TestCase):
    def test_combos_written_by_models_are_understood(self):
        self.assertEqual(_split_combo("Shift+End"), ["shift", "end"])
        self.assertEqual(_split_combo("ctrl + a"), ["ctrl", "a"])
        self.assertEqual(_split_combo(["shift+down", "shift+down"]), ["shift", "down", "shift", "down"])
        self.assertEqual(_split_combo("Control+Return"), ["ctrl", "enter"])
        self.assertEqual(_split_combo(""), [])


if __name__ == "__main__":
    unittest.main()
