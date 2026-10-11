"""ABxAG Dual-Cursor — Virtual (software) pointer.

Physical mouse = user only (pyautogui path, untouched).
Virtual cursor = AI software only. It NEVER calls SetCursorPos / mouse_event
/ pyautogui.moveTo. Instead:

  1. UIA control patterns (Invoke/Value/SetFocus) — preferred, no mouse move.
  2. PostMessage WM_* to a background HWND — no focus steal, no cursor move.
  3. Queued fallback is handled by the Node bridge, not here.

State (x, y, status, task) is kept in-process so the Electron overlay can
render a neon virtual cursor without touching the OS cursor.
"""

from __future__ import annotations

import platform
import threading
import time
from typing import Any, Dict

from .registry import ToolError, register

_LOCK = threading.Lock()
_STATE: Dict[str, Any] = {
    "x": 500,
    "y": 400,
    "visible": True,
    "status": "idle",  # idle | active | paused
    "task": "",
    "paused": False,
    "history": [],  # last 50 virtual events
}

# Win32 message constants (no dependency needed for constants)
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_LBUTTONDBLCLK = 0x0203
WM_MOUSEMOVE = 0x0200
WM_MOUSEWHEEL = 0x020A
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
MK_LBUTTON = 0x0001


def _push_history(kind: str, detail: str) -> None:
    with _LOCK:
        _STATE["history"].append({"t": time.time(), "kind": kind, "detail": detail[:200]})
        if len(_STATE["history"]) > 50:
            _STATE["history"] = _STATE["history"][-50:]


def _need_windows() -> None:
    if platform.system() != "Windows":
        raise ToolError("Virtual cursor background messaging needs Windows.")


def _resolve_hwnd(args: Dict[str, Any]):
    """Return hwnd or None. Never activates the window."""
    import win32gui

    hwnd = args.get("hwnd")
    if hwnd:
        hwnd = int(hwnd)
        if not win32gui.IsWindow(hwnd):
            raise ToolError("WINDOW_NOT_OPEN: target window no longer exists.")
        return hwnd
    title = str(args.get("window_title") or "").strip()
    if title:
        from .tools_windows import _find_window_by_title  # local import, lazy

        found = _find_window_by_title(title)
        if not found:
            raise ToolError(f"WINDOW_NOT_FOUND: no window matching '{title}'.")
        return found
    return None


def _post_click(hwnd: int, x: int, y: int, kind: str) -> str:
    """Send a background click via PostMessage. Cursor never moves."""
    import win32api
    import win32gui

    # lParam = y << 16 | x (client coords). We treat screen x,y as client
    # offset after ScreenToClient so background windows get the right point.
    try:
        pt = win32gui.ScreenToClient(hwnd, (x, y))
    except Exception:
        pt = (x, y)
    lparam = win32api.MAKELONG(pt[0], pt[1])
    if kind == "left":
        win32gui.PostMessage(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lparam)
        time.sleep(0.03)
        win32gui.PostMessage(hwnd, WM_LBUTTONUP, 0, lparam)
    elif kind == "right":
        win32gui.PostMessage(hwnd, WM_RBUTTONDOWN, 0, lparam)
        time.sleep(0.03)
        win32gui.PostMessage(hwnd, WM_RBUTTONUP, 0, lparam)
    elif kind == "double":
        win32gui.PostMessage(hwnd, WM_LBUTTONDBLCLK, MK_LBUTTON, lparam)
        time.sleep(0.03)
        win32gui.PostMessage(hwnd, WM_LBUTTONUP, 0, lparam)
    else:
        raise ToolError(f"Unsupported virtual click kind: {kind}")
    return f"posted {kind} to hwnd={hwnd} client=({pt[0]},{pt[1]})"


def _check_paused() -> None:
    with _LOCK:
        if _STATE["paused"]:
            raise ToolError("VIRTUAL_PAUSED: virtual cursor is paused. Call resumeVirtual first.")


@register("virtualMove")
def virtual_move(args: Dict[str, Any]) -> Dict[str, Any]:
    """Move only the virtual (rendered) cursor. OS cursor untouched."""
    _check_paused()
    try:
        x, y = int(args["x"]), int(args["y"])
    except (KeyError, TypeError, ValueError):
        raise ToolError("virtualMove needs integer x and y.")
    with _LOCK:
        _STATE["x"], _STATE["y"] = x, y
        _STATE["status"] = "active"
        if args.get("task"):
            _STATE["task"] = str(args["task"])[:160]
    _push_history("move", f"({x},{y})")
    return {"result": f"Virtual cursor -> ({x}, {y}). Physical mouse untouched."}


@register("virtualClick")
def virtual_click(args: Dict[str, Any]) -> Dict[str, Any]:
    _check_paused()
    x = int(args.get("x", _STATE["x"]))
    y = int(args.get("y", _STATE["y"]))
    with _LOCK:
        _STATE["x"], _STATE["y"] = x, y
        _STATE["status"] = "active"
    hwnd = _resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd:
        _need_windows()
        out = _post_click(hwnd, x, y, "left")
        _push_history("click", out)
        return {"result": f"Virtual background left-click at ({x},{y}). {out}. Physical cursor untouched."}
    # No hwnd: record intent only — Node overlay shows it, no OS click happens.
    _push_history("click-intent", f"({x},{y}) no hwnd")
    return {"result": f"Virtual click intent at ({x},{y}) recorded (no hwnd — no OS click). Pass hwnd/window_title for background click."}


@register("virtualRightClick")
def virtual_right_click(args: Dict[str, Any]) -> Dict[str, Any]:
    _check_paused()
    x = int(args.get("x", _STATE["x"]))
    y = int(args.get("y", _STATE["y"]))
    hwnd = _resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd:
        out = _post_click(hwnd, x, y, "right")
        _push_history("rightclick", out)
        return {"result": f"Virtual background right-click at ({x},{y}). {out}."}
    _push_history("rightclick-intent", f"({x},{y})")
    return {"result": f"Virtual right-click intent at ({x},{y}) recorded (no hwnd)."}


@register("virtualDoubleClick")
def virtual_double_click(args: Dict[str, Any]) -> Dict[str, Any]:
    _check_paused()
    x = int(args.get("x", _STATE["x"]))
    y = int(args.get("y", _STATE["y"]))
    hwnd = _resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd:
        out = _post_click(hwnd, x, y, "double")
        _push_history("doubleclick", out)
        return {"result": f"Virtual background double-click at ({x},{y}). {out}."}
    return {"result": f"Virtual double-click intent at ({x},{y}) recorded (no hwnd)."}


@register("virtualType")
def virtual_type(args: Dict[str, Any]) -> Dict[str, Any]:
    """Type into a background window via WM_CHAR — no focus steal, no cursor move."""
    _check_paused()
    text = str(args.get("text", ""))
    if not text:
        raise ToolError("virtualType needs 'text'.")
    if len(text) > 2000:
        raise ToolError("virtualType text too long (max 2000 chars).")
    hwnd = _resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd:
        import win32gui

        for ch in text[:2000]:
            win32gui.PostMessage(hwnd, WM_CHAR, ord(ch), 0)
            time.sleep(0.002)
        _push_history("type", f"{len(text)} chars -> hwnd={hwnd}")
        return {"result": f"Posted {len(text)} chars to hwnd={hwnd} in background. Focus + cursor untouched."}
    _push_history("type-intent", text[:80])
    return {"result": "Virtual type intent recorded (no hwnd — pass hwnd/window_title to inject in background)."}


@register("virtualScroll")
def virtual_scroll(args: Dict[str, Any]) -> Dict[str, Any]:
    _check_paused()
    import win32api

    delta = int(args.get("delta", 120))
    x = int(args.get("x", _STATE["x"]))
    y = int(args.get("y", _STATE["y"]))
    hwnd = _resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd:
        import win32gui

        wparam = win32api.MAKELONG(0, delta)
        try:
            pt = win32gui.ScreenToClient(hwnd, (x, y))
        except Exception:
            pt = (x, y)
        lparam = win32api.MAKELONG(pt[0], pt[1])
        win32gui.PostMessage(hwnd, WM_MOUSEWHEEL, wparam, lparam)
        _push_history("scroll", f"delta={delta} hwnd={hwnd}")
        return {"result": f"Background scroll delta={delta} at ({x},{y}) -> hwnd={hwnd}."}
    return {"result": f"Virtual scroll intent delta={delta} at ({x},{y}) recorded (no hwnd)."}


@register("virtualInspect")
def virtual_inspect(args: Dict[str, Any]) -> Dict[str, Any]:
    """Read-only UIA scan for the virtual cursor. Never moves any mouse.

    Same as inspectUi but tagged as virtual work (overlay shows the task).
    Args: { hwnd?, window_title?, max_elements?, query?, roles? }
    """
    _check_paused()
    from . import tools_uia as uia

    hwnd = uia._resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd is None:
        raise ToolError("virtualInspect needs hwnd or window_title on Windows.")
    max_elements = max(10, min(400, int(args.get("max_elements", 160))))
    raw_roles = args.get("roles")
    roles_list = raw_roles if isinstance(raw_roles, list) else []
    snapshot = uia._run(
        uia._snapshot_worker, hwnd, max_elements,
        str(args.get("query") or ""), [str(r) for r in roles_list],
    )
    task = str(args.get("task") or f"inspect {snapshot['window']['title']}"[:120])
    with _LOCK:
        _STATE["status"] = "active"
        _STATE["task"] = task
    _push_history("inspect", f"{len(snapshot['elements'])} controls in '{snapshot['window']['title']}'")
    snapshot["virtual_cursor"] = {"x": _STATE["x"], "y": _STATE["y"]}
    snapshot["result"] = (
        f"Virtual-inspected {len(snapshot['elements'])} controls in "
        f"'{snapshot['window']['title']}' (snapshot {snapshot['snapshot_id']}). "
        f"Physical mouse untouched."
    )
    return snapshot


@register("virtualFind")
def virtual_find(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find controls by name for the virtual cursor. Read-only, no mouse move.

    Args: { query, hwnd?, window_title?, limit?, roles? }
    """
    _check_paused()
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("virtualFind needs 'query' (control name to search).")
    from . import tools_uia as uia

    hwnd = uia._resolve_hwnd(args) if platform.system() == "Windows" else None
    if hwnd is None:
        raise ToolError("virtualFind needs hwnd or window_title on Windows.")
    snapshot = uia._run(
        uia._snapshot_worker, hwnd,
        max(5, min(60, int(args.get("limit", 20)))), query,
        [str(r) for r in (args.get("roles") or [])],
    )
    with _LOCK:
        _STATE["status"] = "active"
        _STATE["task"] = f"find '{query}'"[:120]
    _push_history("find", f"'{query}' -> {len(snapshot['elements'])} match(es)")
    snapshot["virtual_cursor"] = {"x": _STATE["x"], "y": _STATE["y"]}
    snapshot["result"] = f"Virtual-found {len(snapshot['elements'])} control(s) matching '{query}'. Physical mouse untouched."
    return snapshot


_VIRTUAL_UIFORM_ACTIONS = {
    "invoke", "focus", "set_value", "toggle",
    "expand", "collapse", "select", "scroll_into_view",
}


@register("virtualUiAction")
def virtual_ui_action(args: Dict[str, Any]) -> Dict[str, Any]:
    """Full virtual UIA action — the software pointer's hands. Zero OS mouse.

    Two calling styles:
      1. element_id (+ snapshot_id?) — from virtualInspect/virtualFind/inspectUi.
      2. query + window_title/hw​nd — auto find best match then act.
    The virtual (rendered) cursor glides to the element's live centre so the
    Electron overlay shows what the AI is touching. The OS cursor never moves.

    Args: { element_id?, snapshot_id?, query?, hwnd?, window_title?,
            action='invoke', value?, task? }
    """
    _check_paused()
    from . import tools_uia as uia

    action = str(args.get("action", "invoke")).strip().lower()
    if action not in _VIRTUAL_UIFORM_ACTIONS:
        raise ToolError(
            f"VIRTUAL_NO_POINTER: '{action}' needs the physical mouse. "
            f"Use virtualClick (background PostMessage) or uiAction instead. "
            f"Allowed: {sorted(_VIRTUAL_UIFORM_ACTIONS)}."
        )
    value = args.get("value")
    value_str = None if value is None else str(value)
    if action == "set_value" and value_str is None:
        raise ToolError("virtualUiAction set_value needs 'value'.")

    element_id = str(args.get("element_id") or "").strip()
    snapshot_id = args.get("snapshot_id")

    # Style 2: auto find-then-act when no element_id is given.
    if not element_id:
        query = str(args.get("query") or "").strip()
        if not query:
            raise ToolError("virtualUiAction needs 'element_id' or ('query' + window_title/hw​nd).")
        if platform.system() != "Windows":
            raise ToolError("virtualUiAction needs Windows.")
        hwnd = uia._resolve_hwnd(args)
        snapshot = uia._run(uia._snapshot_worker, hwnd, 20, query, [])
        if not snapshot["elements"]:
            raise ToolError(f"ELEMENT_NOT_FOUND: no control matching '{query}'.")
        element_id = snapshot["elements"][0]["id"]
        snapshot_id = snapshot["snapshot_id"]

    # Peak at the live rect FIRST so the overlay can glide there even if the
    # action itself later fails (user sees where the AI tried).
    try:
        element, record, _hwnd = uia._lookup(element_id, snapshot_id)
        live = uia._live_rect(element)
        cx, cy = (live[0] + live[2]) // 2, (live[1] + live[3]) // 2
    except ToolError:
        raise
    except Exception as error:
        raise ToolError(f"ELEMENT_NOT_FOUND: cannot read element {element_id}: {error}")

    task = str(args.get("task") or f"{action} '{record.get('name') or record.get('role')}'"[:120])
    with _LOCK:
        _STATE["x"], _STATE["y"] = cx, cy
        _STATE["status"] = "active"
        _STATE["task"] = task

    out = uia._run(
        uia._action_worker, element_id, snapshot_id, action, value_str, "auto",
        timeout=15.0,
    )
    # Safety net: _action_worker with method="auto" only uses pointer-free
    # patterns for our allowed set, but double-check it never touched it.
    if out.get("used_pointer"):
        raise ToolError(
            "VIRTUAL_SAFETY: UIA fell back to the physical pointer; "
            "aborted to protect the user's mouse. Use virtualClick instead."
        )
    with _LOCK:
        _STATE["status"] = "active"
    _push_history("uiaction", f"{element_id}:{action} via {out.get('method')} @({cx},{cy})")
    return {
        "element": out.get("element"),
        "rect": out.get("rect"),
        "method": out.get("method"),
        "verified_value": out.get("verified_value"),
        "moved_since_snapshot": out.get("moved_since_snapshot"),
        "virtual_cursor": {"x": cx, "y": cy, "task": task},
        "result": (
            f"Virtual UIA {action} on {out['element']['role']} "
            f"'{out['element']['name']}' via {out.get('method')} at ({cx},{cy}). "
            f"Physical mouse untouched."
        ),
    }


@register("virtualStatus")
def virtual_status(args: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        return {"result": dict(_STATE)}


@register("pauseVirtual")
def pause_virtual(args: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        _STATE["paused"] = True
        _STATE["status"] = "paused"
    _push_history("paused", str(args.get("reason", "user")))
    return {"result": "Virtual cursor PAUSED. Physical mouse fully free."}


@register("resumeVirtual")
def resume_virtual(args: Dict[str, Any]) -> Dict[str, Any]:
    with _LOCK:
        _STATE["paused"] = False
        _STATE["status"] = "idle"
    _push_history("resumed", "")
    return {"result": "Virtual cursor RESUMED."}
