"""Unicode-safe typing and file clipboard.

typeUnicode          SendInput with KEYEVENTF_UNICODE: types any character
                     (Hindi, emoji, accents) into the focused control, unlike
                     pyautogui.write which only knows US-keyboard keys.
copyFilesToClipboard places files on the clipboard as CF_HDROP, exactly like
                     Ctrl+C in File Explorer, so any app that accepts pasted
                     files (chat apps, mail, upload fields) can receive them.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import os
import platform
import struct
import time
from pathlib import Path
from typing import Any, Dict, List

from .registry import ToolError, register

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("union", _INPUTUNION)]


def _send_unicode_char(code_unit: int) -> None:
    down = INPUT(type=INPUT_KEYBOARD, union=_INPUTUNION(ki=KEYBDINPUT(0, code_unit, KEYEVENTF_UNICODE, 0, 0)))
    up = INPUT(type=INPUT_KEYBOARD, union=_INPUTUNION(ki=KEYBDINPUT(0, code_unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)))
    array = (INPUT * 2)(down, up)
    if ctypes.windll.user32.SendInput(2, array, ctypes.sizeof(INPUT)) != 2:
        raise ToolError("Typing was blocked by Windows (another app may have elevated focus).")


@register("typeUnicode")
def type_unicode(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("Unicode typing is implemented for Windows.")
    text = args.get("text")
    if not isinstance(text, str) or not text:
        raise ToolError("Non-empty text is required.")
    if len(text) > 5_000:
        raise ToolError("Text is too long for one typing action (maximum 5,000 characters).")
    interval = max(0.0, min(0.1, float(args.get("interval", 0.004))))
    encoded = text.encode("utf-16-le")
    for index in range(0, len(encoded), 2):
        code_unit = struct.unpack("<H", encoded[index:index + 2])[0]
        if code_unit == 0x0A:  # newline -> Enter keeps line breaks in most editors
            ctypes.windll.user32.keybd_event(0x0D, 0, 0, 0)
            ctypes.windll.user32.keybd_event(0x0D, 0, KEYEVENTF_KEYUP, 0)
        elif code_unit != 0x0D:
            _send_unicode_char(code_unit)
        if interval:
            time.sleep(interval)
    return {"result": f"Typed {len(text)} characters.", "characters": len(text)}


@register("copyFilesToClipboard")
def copy_files_to_clipboard(args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("File clipboard is implemented for Windows.")
    import win32clipboard
    import win32con

    raw_paths = args.get("paths")
    if not isinstance(raw_paths, list) or not raw_paths or len(raw_paths) > 20:
        raise ToolError("paths must be a list of 1 to 20 files.")
    paths: List[str] = []
    for raw in raw_paths:
        path = Path(os.path.expandvars(os.path.expanduser(str(raw)))).resolve()
        if not path.exists():
            raise ToolError(f"File does not exist: {path}")
        paths.append(str(path))
    # DROPFILES header (20 bytes) followed by a double-NUL-terminated UTF-16 list.
    file_list = ("\0".join(paths) + "\0\0").encode("utf-16-le")
    header = struct.pack("<IiiII", 20, 0, 0, 0, 1)  # pFiles=20, pt=(0,0), fNC=0, fWide=1
    win32clipboard.OpenClipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_HDROP, header + file_list)
    finally:
        win32clipboard.CloseClipboard()
    return {"result": f"Copied {len(paths)} file(s) to the clipboard.", "paths": paths}


@register("setClipboardText")
def set_clipboard_text(args: Dict[str, Any]) -> Dict[str, Any]:
    text = args.get("text")
    if not isinstance(text, str):
        raise ToolError("text is required.")
    if len(text) > 100_000:
        raise ToolError("Clipboard text is limited to 100,000 characters.")
    import pyperclip

    pyperclip.copy(text)
    return {"result": f"Placed {len(text)} characters on the clipboard (not pasted)."}


__all__ = ["type_unicode", "copy_files_to_clipboard", "set_clipboard_text"]
