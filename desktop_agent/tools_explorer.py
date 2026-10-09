"""File Explorer control: open a folder and select files in it.

"Open Downloads and select all the .zip files" is one deterministic action,
not a guessing game of keystrokes and screen text: the folder is opened (or
an Explorer window already showing it is reused), the matching items are
selected through the window's own Shell view (ShellFolderView.SelectItem),
and the window is brought to the front. What gets selected is returned, so
the caller can verify it.

Selecting is harmless: nothing is opened, moved or deleted.
"""

from __future__ import annotations

import fnmatch
import os
import platform
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

from .registry import ToolError, register

_EXECUTOR: Optional[ThreadPoolExecutor] = None
_LOCK = threading.Lock()

# ShellFolderView.SelectItem flags
SVSI_SELECT = 0x1
SVSI_DESELECTOTHERS = 0x4
SVSI_ENSUREVISIBLE = 0x8
SVSI_FOCUSED = 0x10


def _executor() -> ThreadPoolExecutor:
    global _EXECUTOR
    with _LOCK:
        if _EXECUTOR is None:
            def init() -> None:
                import pythoncom

                pythoncom.CoInitialize()

            _EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="abxag-explorer", initializer=init)
        return _EXECUTOR


def _resolve(folder: str) -> Path:
    from .tools_files import _resolve_folder

    try:
        from .tools_files_ext import known_folder

        known = known_folder(folder)
        if known:
            return Path(known)
    except Exception:
        pass
    return _resolve_folder(folder)


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def _explorer_view(folder: Path):
    """The ShellWindows entry showing `folder`, or None."""
    import win32com.client

    windows = win32com.client.Dispatch("Shell.Application").Windows()
    wanted = _norm(str(folder))
    for index in range(windows.Count):
        try:
            window = windows.Item(index)
            if window is None:
                continue
            document = window.Document
            path = document.Folder.Self.Path
            if path and _norm(path) == wanted:
                return window, document
        except Exception:
            continue
    return None


def _patterns(args: Dict[str, Any]) -> List[str]:
    patterns: List[str] = []
    for key in ("pattern", "patterns", "extension", "extensions"):
        value = args.get(key)
        values = value if isinstance(value, list) else [value] if value else []
        for item in values:
            text = str(item).strip()
            if not text:
                continue
            if key.startswith("extension"):
                text = "*." + text.lstrip("*.").lower()
            patterns.append(text.lower())
    return patterns


def _select(args: Dict[str, Any]) -> Dict[str, Any]:
    folder = _resolve(str(args.get("folder") or args.get("path") or "downloads"))
    if not folder.is_dir():
        raise ToolError(f"Folder not found: {folder}")
    patterns = _patterns(args)
    names = {str(n).lower() for n in (args.get("names") or []) if str(n).strip()}
    if not patterns and not names:
        raise ToolError("Say which files to select: pattern (e.g. *.zip), extension (zip) or names.")

    found = _explorer_view(folder)
    if not found:
        subprocess.Popen(["explorer.exe", str(folder)], close_fds=True)
        deadline = time.time() + 8
        while time.time() < deadline and not found:
            time.sleep(0.3)
            found = _explorer_view(folder)
    if not found:
        raise ToolError(f"File Explorer did not open {folder} in time.")
    window, document = found
    # Match on the disk listing (fast), then fetch only the matching items
    # from the view: reading every item over COM costs ~3 ms each.
    try:
        entries = [entry for entry in os.scandir(folder) if entry.is_file()]
    except OSError as error:
        raise ToolError(f"Could not read {folder}: {error}") from error
    wanted = [
        entry for entry in entries
        if (names and entry.name.lower() in names) or any(fnmatch.fnmatch(entry.name.lower(), p) for p in patterns)
    ]
    if not wanted:
        return {"result": f"No files in {folder} match {', '.join(patterns or sorted(names))}.", "selected": 0, "files": [], "folder": str(folder)}
    shell_folder = None
    for _ in range(25):
        try:
            shell_folder = document.Folder
            if shell_folder is not None:
                break
        except Exception:
            pass
        time.sleep(0.2)
    if shell_folder is None:
        raise ToolError("Could not read the folder in File Explorer.")
    matched = []
    for entry in wanted[:2000]:
        try:
            item = shell_folder.ParseName(entry.name)
        except Exception:
            item = None
        if item is not None:
            matched.append((item, entry.path))

    first = True
    selected: List[str] = []
    for item, path in matched[:2000]:
        flags = SVSI_SELECT | (SVSI_DESELECTOTHERS | SVSI_ENSUREVISIBLE | SVSI_FOCUSED if first else 0)
        try:
            document.SelectItem(item, flags)
            selected.append(path)
            first = False
        except Exception:
            continue
    try:
        import win32con
        import win32gui

        hwnd = int(window.HWND)
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    return {
        "result": f"Selected {len(selected)} file(s) in {folder.name or folder}.",
        "selected": len(selected),
        "files": selected[:60],
        "folder": str(folder),
    }


@register("selectFiles")
def select_files(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("Selecting files in File Explorer is available on Windows only.")
    try:
        return _executor().submit(_select, dict(args)).result(timeout=20)
    except ToolError:
        raise
    except Exception as error:
        raise ToolError(f"Could not select the files: {error}") from error


__all__ = ["select_files"]

