"""
ABxAG Desktop Control Agent — Central tool registry.

Each tool module registers handlers into a flat dict `TOOLS` mapping
tool_name -> callable(args: dict) -> dict.

Handlers return a plain dict, typically {"result": "<status string>"}.
Errors should raise ToolError(message) so main.py can map them to {error}.
Shared state such as confirmation tokens lives on the `State` object so
handlers stay stateless and easy to test.
"""

from __future__ import annotations

import importlib
import threading
from typing import Any, Callable, Dict


class ToolError(Exception):
    """Raised by a tool handler to signal a clean, user-facing failure."""

    def __init__(self, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.message = message
        self.fatal = fatal


class State:
    """Process-wide shared state for tool handlers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # Confirmation tokens for dangerous (power) actions.
        # token -> {"action": <tool_name>, "expires": <epoch>}
        self.confirmations: Dict[str, Dict[str, Any]] = {}


STATE = State()

# tool_name -> handler(args: dict) -> dict
TOOLS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {}


def register(name: str):
    """Decorator to register a handler under a tool name."""

    def deco(fn: Callable[[Dict[str, Any]], Dict[str, Any]]):
        TOOLS[name] = fn
        return fn

    return deco


# The set of all tool names ABxAG may route to this agent.
# Kept in sync with the functionDeclarations added in server.ts.
DESKTOP_TOOL_NAMES = [
    # applications / websites / search
    "openApplication",
    "closeApplication",
    "openWebsite",
    "searchWeb",
    "searchYouTube",
    "searchGoogle",
    "searchGitHub",
    # files
    "createFile",
    "readFile",
    "renameFile",
    "deleteFile",
    "moveFile",
    "openFolder",
    "listFiles",
    "searchFiles",
    # pc control (volume + gated power)
    "volumeUp",
    "volumeDown",
    "muteToggle",
    "setVolume",
    "requestPowerAction",  # first step: issues a confirmation token
    "executePowerAction",  # second step: runs the gated action
    # windows
    "minimizeWindow",
    "maximizeWindow",
    "closeWindow",
    "switchApplication",
    # generic application-independent input and observation
    "locateText",
    "clickText",
    "moveMouse",
    "click",
    "doubleClick",
    "rightClick",
    "drag",
    "scroll",
    "typeText",
    "pressKey",
    "hotkey",
    "getCursorPosition",
    "getActiveWindow",
    "listVisibleWindows",
    "waitForUi",
    "observeDesktopState",
    # clipboard
    "copySelected",
    "pasteClipboard",
    "getClipboard",
    "clearClipboard",
    # screenshot / screen reading
    "takeScreenshot",
    "saveScreenshot",
    "analyzeScreenshot",
    "readScreen",
    "viewScreen",
    # coding assistance
    "createPythonFile",
    "runPythonScript",
    "createProjectFolder",
    "writeCodeFile",
    # system information
    "systemInfo",
    "gpuInfo",
    "temperatureInfo",
    # brightness control (V2)
    "brightnessUp",
    "brightnessDown",
    "setBrightness",
    # Windows auto-start management (V2)
    "enableAutoStart",
    "disableAutoStart",
    "getAutoStartStatus",
    # structured perception + element actions (UI Automation)
    "inspectUi",
    "findUi",
    "uiAction",
    "browserState",
    # visual perception, geometry and input state
    "screenFingerprint",
    "captureForVision",
    "getMonitors",
    "inputState",
    "windowControl",
    # file-system perception
    "knownFolder",
    "recentFiles",
    "statPath",
    "copyFile",
    "openPath",
    # unicode typing + file clipboard
    "typeUnicode",
    "copyFilesToClipboard",
    "setClipboardText",
    # desktop icons (companion's icon game)
    "desktopIcons",
    "moveDesktopIcon",
    # File Explorer selection
    "selectFiles",
]


# --- Eagerly import all tool modules so their @register decorators run. ---
# Each module is imported defensively: a hard import failure here would make
# the whole agent unstartable, which we want to avoid. The modules themselves
# keep optional-dependency imports lazy/try-except.
_MODULE_NAMES = [
    "tools_confirmation",
    "tools_applications",
    "tools_websites",
    "tools_search",
    "tools_files",
    "tools_pc",
    "tools_windows",
    "tools_targeting",
    "tools_input",
    "tools_clipboard",
    "tools_screenshot",
    "tools_coding",
    "tools_system",
    "tools_startup",
    "tools_uia",
    "tools_perception",
    "tools_files_ext",
    "tools_input_ext",
    "tools_desktop_icons",
    "tools_explorer",
]


def load_all() -> None:
    for mod_name in _MODULE_NAMES:
        importlib.import_module(f".{mod_name}", package="desktop_agent")


__all__ = ["TOOLS", "STATE", "DESKTOP_TOOL_NAMES", "ToolError", "register", "load_all"]

