"""Generic, application-independent mouse and keyboard primitives.

Every mutating primitive is deliberately short and bounded, leaves PyAutoGUI's
corner fail-safe enabled, and returns a fresh metadata observation.  This lets
ABxAG use an observe -> act -> verify loop instead of firing blind click chains.
"""

from __future__ import annotations

import platform
import time
from typing import List, Any, Dict, Iterable, Tuple

from .registry import ToolError, register


def _pyautogui():
    try:
        import pyautogui
    except ImportError as error:
        raise ToolError("Generic input control requires the pyautogui package.") from error
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.04
    return pyautogui


def _desktop_bounds() -> Tuple[int, int, int, int]:
    """Return left, top, right, bottom for the Windows virtual desktop."""
    if platform.system() == "Windows":
        try:
            import win32api
            import win32con

            left = win32api.GetSystemMetrics(win32con.SM_XVIRTUALSCREEN)
            top = win32api.GetSystemMetrics(win32con.SM_YVIRTUALSCREEN)
            width = win32api.GetSystemMetrics(win32con.SM_CXVIRTUALSCREEN)
            height = win32api.GetSystemMetrics(win32con.SM_CYVIRTUALSCREEN)
            return left, top, left + width, top + height
        except Exception:
            pass
    size = _pyautogui().size()
    return 0, 0, int(size.width), int(size.height)


def _coordinate(args: Dict[str, Any], x_name: str = "x", y_name: str = "y") -> Tuple[int, int]:
    if x_name not in args or y_name not in args:
        raise ToolError(f"Both {x_name} and {y_name} are required.")
    try:
        x, y = int(args[x_name]), int(args[y_name])
    except (TypeError, ValueError) as error:
        raise ToolError("Mouse coordinates must be integers.") from error
    left, top, right, bottom = _desktop_bounds()
    if not (left <= x < right and top <= y < bottom):
        raise ToolError(
            f"Coordinate ({x}, {y}) is outside the virtual desktop "
            f"({left}, {top})-({right - 1}, {bottom - 1})."
        )
    return x, y


def _duration(value: Any, maximum: float = 2.5) -> float:
    try:
        return max(0.0, min(maximum, float(value or 0.0)))
    except (TypeError, ValueError) as error:
        raise ToolError("Duration must be a number.") from error


def _button(value: Any, allowed: Iterable[str] = ("left", "middle", "right")) -> str:
    button = str(value or "left").lower()
    if button not in set(allowed):
        raise ToolError(f"Unsupported mouse button: {button}.")
    return button


def _active_window() -> Dict[str, Any]:
    if platform.system() != "Windows":
        return {"title": None, "pid": None, "bounds": None}
    try:
        import win32gui
        import win32process

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return {"title": None, "pid": None, "bounds": None}
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        return {
            "title": win32gui.GetWindowText(hwnd) or None,
            "pid": int(pid),
            "bounds": {"left": left, "top": top, "right": right, "bottom": bottom},
        }
    except Exception:
        return {"title": None, "pid": None, "bounds": None}


_PROCESS_NAMES: Dict[int, str] = {}


def _process_name(pid: int) -> str | None:
    if pid in _PROCESS_NAMES:
        return _PROCESS_NAMES[pid]
    try:
        import psutil

        name = psutil.Process(pid).name()
    except Exception:
        name = None
    if len(_PROCESS_NAMES) > 500:
        _PROCESS_NAMES.clear()
    if name:
        _PROCESS_NAMES[pid] = name
    return name


def _visible_windows(limit: int = 50) -> list[Dict[str, Any]]:
    if platform.system() != "Windows":
        return []
    output: list[Dict[str, Any]] = []
    try:
        import win32gui
        import win32process

        def callback(hwnd, _):
            if len(output) >= limit or not win32gui.IsWindowVisible(hwnd):
                return True
            title = win32gui.GetWindowText(hwnd).strip()
            if not title:
                return True
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            if right <= left or bottom <= top:
                return True
            output.append({
                "hwnd": int(hwnd),
                "title": title[:300],
                "class": win32gui.GetClassName(hwnd),
                "pid": int(pid),
                "process": _process_name(int(pid)),
                "minimized": bool(win32gui.IsIconic(hwnd)),
                "bounds": {"left": left, "top": top, "right": right, "bottom": bottom},
            })
            return True

        win32gui.EnumWindows(callback, None)
    except Exception:
        return []
    return output


def _observation(include_windows: bool = False) -> Dict[str, Any]:
    gui = _pyautogui()
    point = gui.position()
    left, top, right, bottom = _desktop_bounds()
    observed: Dict[str, Any] = {
        "timestamp": time.time(),
        "cursor": {"x": int(point.x), "y": int(point.y)},
        "active_window": _active_window(),
        "virtual_desktop": {"left": left, "top": top, "right": right, "bottom": bottom},
    }
    if include_windows:
        observed["visible_windows"] = _visible_windows()
    return observed


@register("moveMouse")
def move_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    x, y = _coordinate(args)
    _pyautogui().moveTo(x, y, duration=_duration(args.get("duration", 0.2)))
    return {"result": f"Moved cursor to ({x}, {y}).", "observation": _observation()}


@register("click")
def click(args: Dict[str, Any]) -> Dict[str, Any]:
    gui = _pyautogui()
    if "x" in args or "y" in args:
        x, y = _coordinate(args)
        gui.click(x=x, y=y, button=_button(args.get("button")))
    else:
        gui.click(button=_button(args.get("button")))
    return {"result": "Clicked once.", "observation": _observation()}


@register("doubleClick")
def double_click(args: Dict[str, Any]) -> Dict[str, Any]:
    gui = _pyautogui()
    interval = max(0.03, min(0.5, float(args.get("interval", 0.12))))
    if "x" in args or "y" in args:
        x, y = _coordinate(args)
        gui.doubleClick(x=x, y=y, interval=interval, button="left")
    else:
        gui.doubleClick(interval=interval, button="left")
    return {"result": "Double-clicked.", "observation": _observation()}


@register("rightClick")
def right_click(args: Dict[str, Any]) -> Dict[str, Any]:
    forwarded = dict(args)
    forwarded["button"] = "right"
    result = click(forwarded)
    result["result"] = "Right-clicked."
    return result


@register("drag")
def drag(args: Dict[str, Any]) -> Dict[str, Any]:
    gui = _pyautogui()
    target_x, target_y = _coordinate(args)
    if "start_x" in args or "start_y" in args:
        start_x, start_y = _coordinate(args, "start_x", "start_y")
        gui.moveTo(start_x, start_y, duration=min(0.5, _duration(args.get("duration", 0.4))))
    gui.dragTo(
        target_x,
        target_y,
        duration=_duration(args.get("duration", 0.5)),
        button=_button(args.get("button"), ("left", "right")),
    )
    return {"result": f"Dragged to ({target_x}, {target_y}).", "observation": _observation()}


@register("scroll")
def scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        amount = max(-5000, min(5000, int(args.get("amount", 0))))
    except (TypeError, ValueError) as error:
        raise ToolError("Scroll amount must be an integer.") from error
    if amount == 0:
        raise ToolError("Scroll amount must not be zero.")
    gui = _pyautogui()
    if "x" in args or "y" in args:
        x, y = _coordinate(args)
        gui.scroll(amount, x=x, y=y)
    else:
        gui.scroll(amount)
    return {"result": f"Scrolled {amount} units.", "observation": _observation()}


@register("typeText")
def type_text(args: Dict[str, Any]) -> Dict[str, Any]:
    text = args.get("text")
    if not isinstance(text, str) or not text:
        raise ToolError("Non-empty text is required.")
    if len(text) > 10_000:
        raise ToolError("Text is too long for one input action (maximum 10,000 characters).")
    interval = max(0.0, min(0.25, float(args.get("interval", 0.01))))
    _pyautogui().write(text, interval=interval)
    return {"result": f"Typed {len(text)} characters.", "observation": _observation()}


_KEY_ALIASES = {
    "control": "ctrl", "cmd": "win", "windows": "win", "super": "win", "escape": "esc",
    "return": "enter", "del": "delete", "ins": "insert", "pgup": "pageup", "pgdn": "pagedown",
    "page up": "pageup", "page down": "pagedown", "arrowup": "up", "arrowdown": "down",
    "arrowleft": "left", "arrowright": "right", "spacebar": "space", "option": "alt",
}


def _split_combo(value: Any) -> List[str]:
    """'Shift+End', 'ctrl + a', ['shift+down'] -> ['shift', 'end'] etc."""
    parts: List[str] = []
    items = value if isinstance(value, list) else [value]
    for item in items:
        for piece in str(item or "").replace(" + ", "+").split("+"):
            key = piece.strip().lower()
            if key:
                parts.append(_KEY_ALIASES.get(key, key))
    return parts


@register("pressKey")
def press_key(args: Dict[str, Any]) -> Dict[str, Any]:
    gui = _pyautogui()
    keys = _split_combo(args.get("key"))
    presses = max(1, min(20, int(args.get("presses", 1))))
    interval = max(0.0, min(0.5, float(args.get("interval", 0.05))))
    if not keys:
        raise ToolError("Unsupported keyboard key: (empty).")
    invalid = [key for key in keys if key not in gui.KEYBOARD_KEYS]
    if invalid:
        raise ToolError(f"Unsupported keyboard key: {', '.join(invalid)}.")
    if len(keys) == 1:
        gui.press(keys[0], presses=presses, interval=interval)
    else:
        # A combo such as shift+end: hold the modifiers, press the last key.
        for _ in range(presses):
            gui.hotkey(*keys)
            time.sleep(interval)
    label = "+".join(keys)
    return {"result": f"Pressed {label} {presses} time(s).", "observation": _observation()}


@register("hotkey")
def hotkey(args: Dict[str, Any]) -> Dict[str, Any]:
    gui = _pyautogui()
    raw = args.get("keys", args.get("key"))
    # Accept ["ctrl", "a"], "ctrl+a", or ["shift+down", "shift+down"] (repeat).
    combos: List[List[str]] = []
    if isinstance(raw, list) and raw and all("+" in str(item) for item in raw):
        combos = [_split_combo(item) for item in raw]
    else:
        combos = [_split_combo(raw)]
    combos = [combo for combo in combos if combo]
    if not combos or any(len(combo) > 5 for combo in combos):
        raise ToolError("Hotkey needs 1 to 5 keys, e.g. [\"ctrl\", \"a\"] or \"shift+end\".")
    invalid = sorted({key for combo in combos for key in combo if key not in gui.KEYBOARD_KEYS})
    if invalid:
        raise ToolError(f"Unsupported hotkey key(s): {', '.join(invalid)}.")
    for combo in combos[:20]:
        if len(combo) == 1:
            gui.press(combo[0])
        else:
            gui.hotkey(*combo)
        time.sleep(0.04)
    label = ", ".join("+".join(combo) for combo in combos)
    return {"result": f"Pressed hotkey {label}.", "observation": _observation()}


@register("getCursorPosition")
def get_cursor_position(_args: Dict[str, Any]) -> Dict[str, Any]:
    observation = _observation()
    return {"result": "Read cursor position.", **observation["cursor"]}


@register("getActiveWindow")
def get_active_window(_args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": "Read active window metadata.", **_active_window()}


@register("listVisibleWindows")
def list_visible_windows(args: Dict[str, Any]) -> Dict[str, Any]:
    limit = max(1, min(100, int(args.get("limit", 50))))
    windows = _visible_windows(limit)
    return {"result": f"Found {len(windows)} visible windows.", "windows": windows}


@register("waitForUi")
def wait_for_ui(args: Dict[str, Any]) -> Dict[str, Any]:
    delay = max(0.05, min(5.0, float(args.get("seconds", 0.5))))
    previous_title = str(args.get("previous_title") or "")
    time.sleep(delay)
    observation = _observation(include_windows=bool(args.get("include_windows", False)))
    current_title = str(observation["active_window"].get("title") or "")
    return {
        "result": f"Waited {delay:.2f}s and observed the UI.",
        "changed": bool(previous_title and current_title != previous_title),
        "observation": observation,
    }


@register("observeDesktopState")
def observe_desktop_state(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": "Observed current desktop metadata.",
        "observation": _observation(include_windows=bool(args.get("include_windows", True))),
    }


__all__ = [
    "move_mouse", "click", "double_click", "right_click", "drag", "scroll",
    "type_text", "press_key", "hotkey", "get_cursor_position", "get_active_window",
    "list_visible_windows", "wait_for_ui", "observe_desktop_state",
]

