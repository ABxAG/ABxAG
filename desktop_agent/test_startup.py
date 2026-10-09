from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from desktop_agent import tools_startup


class StartupTests(unittest.TestCase):
    def test_packaged_runtime_uses_the_real_executable_without_python_or_npm(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "ABxAG runtime.exe"
            executable.write_bytes(b"test")
            with patch.dict(os.environ, {"ABxAG_EXECUTABLE": str(executable)}, clear=False):
                command, target = tools_startup._startup_command()
        self.assertEqual(command, f'"{executable}"')
        self.assertEqual(target, str(executable))
        self.assertNotIn("python", command.lower())
        self.assertNotIn("npm", command.lower())


if __name__ == "__main__":
    unittest.main()



