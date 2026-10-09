"""Structured desktop perception and element-level actions via UI Automation.

`inspectUi` returns a compact, reading-ordered list of the visible controls of
a window (role, name, value, live state, physical rectangle) with short IDs.
`uiAction` acts on one of those IDs: it prefers UIA control patterns
(Invoke, Value, Toggle, SelectionItem, ExpandCollapse, ScrollItem) that work
without moving the user's mouse, and otherwise clicks the element's *current*
rectangle, re-read at action time. Coordinates are never remembered: a moved
window or re-laid-out page simply yields a different live rectangle, and a
vanished element yields ELEMENT_NOT_FOUND instead of a click on stale pixels.

All COM work happens on one dedicated MTA thread because UIA interface
pointers must not be used from arbitrary FastAPI worker threads.
"""

from __future__ import annotations

import platform
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register

_EXECUTOR: Optional[ThreadPoolExecutor] = None
_EXECUTOR_LOCK = threading.Lock()
_STATE: Dict[str, Any] = {"iuia": None, "U": None, "snapshots": {}, "order": [], "counter": 0}

ROLE_NAMES = {
    50000: "button", 50001: "calendar", 50002: "checkbox", 50003: "combobox", 50004: "edit",
    50005: "link", 50006: "image", 50007: "listitem", 50008: "list", 50009: "menu",
    50010: "menubar", 50011: "menuitem", 50012: "progressbar", 50013: "radio", 50014: "scrollbar",
    50015: "slider", 50016: "spinner", 50017: "statusbar", 50018: "tab", 50019: "tabitem",
    50020: "text", 50021: "toolbar", 50022: "tooltip", 50023: "tree", 50024: "treeitem",
    50025: "custom", 50026: "group", 50027: "thumb", 50028: "datagrid", 50029: "dataitem",
    50030: "document", 50031: "splitbutton", 50032: "window", 50033: "pane", 50034: "header",
    50035: "headeritem", 50036: "table", 50037: "titlebar", 50038: "separator", 50039: "semanticzoom",
    50040: "appbar",
}

INTERACTIVE = {
    "button", "checkbox", "combobox", "edit", "link", "listitem", "menuitem", "radio", "slider",
    "spinner", "tabitem", "treeitem", "splitbutton", "dataitem", "headeritem", "scrollbar",
}
CONTENT = {"text", "image", "document", "headeritem", "statusbar", "progressbar"}

MAX_SNAPSHOTS = 6


def _init_thread() -> None:
    import comtypes

    try:
        comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
    except OSError:
        # RPC_E_CHANGED_MODE: COM is already initialised on this thread (STA).
        # Every UIA object stays on this single thread, so either apartment works.
        pass


def _executor() -> ThreadPoolExecutor:
    global _EXECUTOR
    with _EXECUTOR_LOCK:
        if _EXECUTOR is None:
            _EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="abxag-uia", initializer=_init_thread)
        return _EXECUTOR


def _run(fn, *args, timeout: float = 20.0):
    if platform.system() != "Windows":
        raise ToolError("UI Automation is available on Windows only.")
    future = _executor().submit(fn, *args)
    try:
        return future.result(timeout=timeout)
    except ToolError:
        raise
    except TimeoutError as error:
        raise ToolError("UI_TIMEOUT: UI Automation did not respond in time (the application may be busy).") from error


def _uia():
    if _STATE["iuia"] is None:
        import comtypes.client

        comtypes.client.GetModule("UIAutomationCore.dll")
        from comtypes.gen import UIAutomationClient as U  # type: ignore

        try:
            iuia = comtypes.client.CreateObject(U.CUIAutomation8, interface=U.IUIAutomation)
            try:
                # A hung target app must not block ABxAG's perception thread.
                iuia2 = iuia.QueryInterface(U.IUIAutomation2)
                iuia2.ConnectionTimeout = 2000
                iuia2.TransactionTimeout = 6000
            except Exception:
                pass
        except Exception:
            iuia = comtypes.client.CreateObject(U.CUIAutomation, interface=U.IUIAutomation)
        _STATE["iuia"], _STATE["U"] = iuia, U
    return _STATE["iuia"], _STATE["U"]


def _rect_tuple(rect) -> Tuple[int, int, int, int]:
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def _resolve_hwnd(args: Dict[str, Any]) -> int:
    import win32gui

    hwnd = args.get("hwnd")
    if hwnd:
        hwnd = int(hwnd)
        if not win32gui.IsWindow(hwnd):
            raise ToolError("WINDOW_NOT_OPEN: that window no longer exists.")
        return hwnd
    title = str(args.get("window_title") or "").strip()
    if title:
        from .tools_windows import _find_window_by_title

        found = _find_window_by_title(title)
        if not found:
            raise ToolError(f"WINDOW_NOT_OPEN: no visible window titled like '{title}'.")
        return int(found)
    found = win32gui.GetForegroundWindow()
    if not found:
        raise ToolError("WINDOW_NOT_OPEN: no foreground window.")
    return int(found)


def _window_info(hwnd: int) -> Dict[str, Any]:
    import win32gui
    import win32process

    try:
        import psutil  # type: ignore
    except ImportError:  # pragma: no cover
        psutil = None  # type: ignore
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    process = None
    if psutil is not None:
        try:
            process = psutil.Process(pid).name()
        except Exception:
            process = None
    return {
        "hwnd": int(hwnd),
        "title": win32gui.GetWindowText(hwnd),
        "class": win32gui.GetClassName(hwnd),
        "process": process,
        "pid": int(pid),
        "rect": {"left": left, "top": top, "right": right, "bottom": bottom},
        "minimized": bool(win32gui.IsIconic(hwnd)),
        "foreground": int(win32gui.GetForegroundWindow()) == int(hwnd),
    }


def _normalize(text: str) -> str:
    return " ".join(re.findall(r"[\w]+", str(text).casefold()))


def _snapshot_worker(hwnd: int, max_elements: int, query: str, roles: List[str]) -> Dict[str, Any]:
    iuia, U = _uia()
    started = time.perf_counter()
    root = iuia.ElementFromHandle(hwnd)
    cache = iuia.CreateCacheRequest()
    props = [
        U.UIA_NamePropertyId, U.UIA_ControlTypePropertyId, U.UIA_BoundingRectanglePropertyId,
        U.UIA_IsEnabledPropertyId, U.UIA_HasKeyboardFocusPropertyId, U.UIA_IsKeyboardFocusablePropertyId,
        U.UIA_AutomationIdPropertyId, U.UIA_IsPasswordPropertyId, U.UIA_IsOffscreenPropertyId,
        U.UIA_IsInvokePatternAvailablePropertyId, U.UIA_IsValuePatternAvailablePropertyId,
        U.UIA_IsTogglePatternAvailablePropertyId, U.UIA_IsExpandCollapsePatternAvailablePropertyId,
        U.UIA_IsSelectionItemPatternAvailablePropertyId, U.UIA_IsScrollItemPatternAvailablePropertyId,
        U.UIA_ValueValuePropertyId, U.UIA_ValueIsReadOnlyPropertyId,
        U.UIA_ToggleToggleStatePropertyId, U.UIA_ExpandCollapseExpandCollapseStatePropertyId,
        U.UIA_SelectionItemIsSelectedPropertyId,
    ]
    for prop in props:
        try:
            cache.AddProperty(prop)
        except Exception:
            pass
    condition = iuia.CreateAndCondition(
        iuia.ControlViewCondition,
        iuia.CreatePropertyCondition(U.UIA_IsOffscreenPropertyId, False),
    )
    # Asked for specific roles: let UI Automation filter by control type
    # itself. Walking and caching every element of a big WebView window
    # (WhatsApp, Teams) takes seconds; a typed query takes a fraction.
    wanted_types = [code for code, role_name in ROLE_NAMES.items() if role_name in {r.lower() for r in roles}] if roles else []
    if wanted_types:
        type_condition = iuia.CreatePropertyCondition(U.UIA_ControlTypePropertyId, wanted_types[0])
        for code in wanted_types[1:]:
            type_condition = iuia.CreateOrCondition(type_condition, iuia.CreatePropertyCondition(U.UIA_ControlTypePropertyId, code))
        condition = iuia.CreateAndCondition(condition, type_condition)
    found = root.FindAllBuildCache(U.TreeScope_Descendants, condition, cache)
    total = int(found.Length)
    window = _window_info(hwnd)
    wl, wt, wr, wb = (window["rect"][k] for k in ("left", "top", "right", "bottom"))
    norm_query = _normalize(query) if query else ""
    wanted_roles = {role.lower() for role in roles} if roles else set()

    candidates: List[Tuple[int, Dict[str, Any], Any]] = []
    seen = set()
    for index in range(total):
        element = found.GetElement(index)
        try:
            role = ROLE_NAMES.get(int(element.CachedControlType), "custom")
            name = (element.CachedName or "").strip()
            left, top, right, bottom = _rect_tuple(element.CachedBoundingRectangle)
        except Exception:
            continue
        # Clip to the window; skip zero-area and fully clipped controls.
        left, top, right, bottom = max(left, wl), max(top, wt), min(right, wr), min(bottom, wb)
        if right - left < 2 or bottom - top < 2:
            continue
        interactive = role in INTERACTIVE
        if not interactive and not (role in CONTENT and name):
            continue
        if role in {"text", "image"} and len(name) > 300:
            name = name[:300] + "…"
        key = (role, name, left // 3, top // 3)
        if key in seen:
            continue
        seen.add(key)
        if wanted_roles and role not in wanted_roles:
            continue
        if norm_query and norm_query not in _normalize(name) and norm_query not in _normalize(str(_safe(lambda: element.CachedAutomationId) or "")):
            continue
        patterns = []
        for label, prop in (
            ("invoke", "CachedIsInvokePatternAvailable"), ("value", "CachedIsValuePatternAvailable"),
            ("toggle", "CachedIsTogglePatternAvailable"), ("expand", "CachedIsExpandCollapsePatternAvailable"),
            ("select", "CachedIsSelectionItemPatternAvailable"), ("scroll_into_view", "CachedIsScrollItemPatternAvailable"),
        ):
            if _safe(lambda p=prop: bool(element.GetCachedPropertyValue(getattr(U, "UIA_" + p.replace("Cached", "") + "PropertyId")))):
                patterns.append(label)
        record: Dict[str, Any] = {
            "role": role,
            "name": name,
            "rect": {"left": left, "top": top, "right": right, "bottom": bottom},
            "enabled": bool(_safe(lambda: element.CachedIsEnabled, True)),
        }
        if _safe(lambda: element.CachedHasKeyboardFocus):
            record["focused"] = True
        automation_id = _safe(lambda: element.CachedAutomationId)
        if automation_id and len(str(automation_id)) <= 60:
            record["automation_id"] = str(automation_id)
        if patterns:
            record["actions"] = patterns
        if "value" in patterns:
            is_password = bool(_safe(lambda: element.CachedIsPassword))
            if is_password:
                record["password"] = True
            else:
                value = _safe(lambda: element.GetCachedPropertyValue(U.UIA_ValueValuePropertyId))
                if isinstance(value, str) and value:
                    record["value"] = value[:200]
        if "toggle" in patterns:
            state = _safe(lambda: element.GetCachedPropertyValue(U.UIA_ToggleToggleStatePropertyId))
            if state is not None:
                record["checked"] = {0: False, 1: True}.get(int(state), "mixed")
        if "select" in patterns and _safe(lambda: element.GetCachedPropertyValue(U.UIA_SelectionItemIsSelectedPropertyId)):
            record["selected"] = True
        if "expand" in patterns:
            state = _safe(lambda: element.GetCachedPropertyValue(U.UIA_ExpandCollapseExpandCollapseStatePropertyId))
            if state is not None:
                record["expanded"] = int(state) in (1, 2)
        priority = 0 if record.get("focused") else 1 if interactive and name else 2 if interactive else 3
        candidates.append((priority, record, element))

    candidates.sort(key=lambda item: (item[0], item[1]["rect"]["top"], item[1]["rect"]["left"]))
    selected = candidates[:max_elements]
    selected.sort(key=lambda item: (item[1]["rect"]["top"] // 8, item[1]["rect"]["left"]))

    _STATE["counter"] += 1
    snapshot_id = f"s{_STATE['counter']}"
    elements = []
    store: Dict[str, Any] = {}
    for position, (_priority, record, element) in enumerate(selected, start=1):
        element_id = f"e{position}"
        record = {"id": element_id, **record}
        elements.append(record)
        store[element_id] = {"element": element, "record": record}
    _STATE["snapshots"][snapshot_id] = {"hwnd": hwnd, "elements": store, "created": time.time()}
    _STATE["order"].append(snapshot_id)
    while len(_STATE["order"]) > MAX_SNAPSHOTS:
        _STATE["snapshots"].pop(_STATE["order"].pop(0), None)

    return {
        "snapshot_id": snapshot_id,
        "window": window,
        "elements": elements,
        "element_count_total": total,
        "truncated": len(candidates) > len(selected),
        "duration_ms": round((time.perf_counter() - started) * 1000),
    }


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _lookup(element_id: str, snapshot_id: Optional[str]) -> Tuple[Any, Dict[str, Any], int]:
    order = list(_STATE["order"])
    if not order:
        raise ToolError("ELEMENT_NOT_FOUND: no UI snapshot exists yet; call inspectUi first.")
    snapshot_key = snapshot_id or order[-1]
    snapshot = _STATE["snapshots"].get(snapshot_key)
    if snapshot is None:
        raise ToolError(f"ELEMENT_NOT_FOUND: snapshot {snapshot_key} expired; inspect the UI again.")
    entry = snapshot["elements"].get(str(element_id))
    if entry is None:
        raise ToolError(f"ELEMENT_NOT_FOUND: {element_id} is not in snapshot {snapshot_key}.")
    return entry["element"], entry["record"], snapshot["hwnd"]


def _live_rect(element) -> Tuple[int, int, int, int]:
    try:
        rect = _rect_tuple(element.CurrentBoundingRectangle)
    except Exception as error:
        raise ToolError("ELEMENT_NOT_FOUND: the element no longer exists (the UI changed).") from error
    if rect[2] - rect[0] < 1 or rect[3] - rect[1] < 1:
        raise ToolError("ELEMENT_NOT_FOUND: the element is no longer visible.")
    try:
        if element.CurrentIsOffscreen:
            raise ToolError("ELEMENT_NOT_FOUND: the element scrolled out of view; scroll or inspect again.")
    except ToolError:
        raise
    except Exception:
        pass
    return rect


def _pattern(element, pattern_id, interface):
    unknown = element.GetCurrentPattern(pattern_id)
    if not unknown:
        return None
    return unknown.QueryInterface(interface)


def _action_worker(element_id: str, snapshot_id: Optional[str], action: str, value: Optional[str], method: str) -> Dict[str, Any]:
    _iuia, U = _uia()
    element, record, hwnd = _lookup(element_id, snapshot_id)
    rect = _live_rect(element)
    try:
        enabled = bool(element.CurrentIsEnabled)
    except Exception:
        enabled = True
    if not enabled and action not in {"focus", "scroll_into_view"}:
        raise ToolError(f"ELEMENT_DISABLED: '{record.get('name') or record['role']}' is disabled right now.")

    moved = rect != (record["rect"]["left"], record["rect"]["top"], record["rect"]["right"], record["rect"]["bottom"])
    result: Dict[str, Any] = {
        "element": {"id": element_id, "role": record["role"], "name": record.get("name", "")},
        "rect": {"left": rect[0], "top": rect[1], "right": rect[2], "bottom": rect[3]},
        "moved_since_snapshot": moved,
        "used_pointer": False,
    }

    def pointer_click(kind: str) -> Dict[str, Any]:
        from .tools_targeting import _physical_click

        x = (rect[0] + rect[2]) // 2
        y = (rect[1] + rect[3]) // 2
        if kind == "double":
            cursor = _physical_click(x, y, "left")
            time.sleep(0.06)
            cursor = _physical_click(x, y, "left")
        else:
            cursor = _physical_click(x, y, "right" if kind == "right" else "left")
        result["used_pointer"] = True
        return cursor

    if action in {"click", "invoke"} and method != "mouse":
        try:
            if action == "invoke" or record["role"] in {"button", "link", "menuitem", "splitbutton", "hyperlink"}:
                invoke = _pattern(element, U.UIA_InvokePatternId, U.IUIAutomationInvokePattern)
                if invoke is not None:
                    invoke.Invoke()
                    result["method"] = "uia.invoke"
                    return result
            if record["role"] in {"listitem", "treeitem", "tabitem", "dataitem", "radio"}:
                select = _pattern(element, U.UIA_SelectionItemPatternId, U.IUIAutomationSelectionItemPattern)
                if select is not None:
                    select.Select()
                    result["method"] = "uia.select"
                    return result
            if record["role"] == "checkbox":
                toggle = _pattern(element, U.UIA_TogglePatternId, U.IUIAutomationTogglePattern)
                if toggle is not None:
                    toggle.Toggle()
                    result["method"] = "uia.toggle"
                    return result
        except Exception:
            pass  # fall through to a real click on the live rectangle
        if action == "invoke":
            raise ToolError("ACTION_UNSUPPORTED: this element cannot be invoked; use click instead.")

    if action in {"click", "invoke"}:
        result["cursor"] = pointer_click("left")
        result["method"] = "pointer.click"
    elif action == "double_click":
        result["cursor"] = pointer_click("double")
        result["method"] = "pointer.double_click"
    elif action == "right_click":
        result["cursor"] = pointer_click("right")
        result["method"] = "pointer.right_click"
    elif action == "focus":
        element.SetFocus()
        result["method"] = "uia.focus"
    elif action == "set_value":
        if value is None:
            raise ToolError("set_value requires a value.")
        done = False
        try:
            pattern = _pattern(element, U.UIA_ValuePatternId, U.IUIAutomationValuePattern)
            if pattern is not None and not pattern.CurrentIsReadOnly:
                pattern.SetValue(str(value))
                done = True
                result["method"] = "uia.set_value"
        except Exception:
            done = False
        if not done:
            import pyautogui

            element.SetFocus()
            time.sleep(0.05)
            pyautogui.hotkey("ctrl", "a")
            pyautogui.write(str(value), interval=0.01)
            result["method"] = "keyboard.replace_text"
        try:
            pattern = _pattern(element, U.UIA_ValuePatternId, U.IUIAutomationValuePattern)
            current = pattern.CurrentValue if pattern is not None else None
            result["verified_value"] = current == str(value) if isinstance(current, str) else None
        except Exception:
            result["verified_value"] = None
    elif action == "toggle":
        _require(_pattern(element, U.UIA_TogglePatternId, U.IUIAutomationTogglePattern), "toggle").Toggle()
        result["method"] = "uia.toggle"
    elif action in {"expand", "collapse"}:
        pattern = _require(_pattern(element, U.UIA_ExpandCollapsePatternId, U.IUIAutomationExpandCollapsePattern), action)
        pattern.Expand() if action == "expand" else pattern.Collapse()
        result["method"] = f"uia.{action}"
    elif action == "select":
        _require(_pattern(element, U.UIA_SelectionItemPatternId, U.IUIAutomationSelectionItemPattern), "select").Select()
        result["method"] = "uia.select"
    elif action in {"scroll", "hover"}:
        import pyautogui

        x = (rect[0] + rect[2]) // 2
        y = (rect[1] + rect[3]) // 2
        if action == "hover":
            pyautogui.moveTo(x, y, duration=0.12)
        else:
            amount = int(float(value or -5))
            pyautogui.scroll(max(-25, min(25, amount)) * 120, x=x, y=y)
        result["used_pointer"] = True
        result["method"] = f"pointer.{action}"
    elif action == "scroll_into_view":
        _require(_pattern(element, U.UIA_ScrollItemPatternId, U.IUIAutomationScrollItemPattern), "scroll_into_view").ScrollIntoView()
        result["method"] = "uia.scroll_into_view"
    else:
        raise ToolError(f"Unsupported UI action '{action}'.")
    return result


def _require(pattern, name: str):
    if pattern is None:
        raise ToolError(f"ACTION_UNSUPPORTED: element does not support {name}.")
    return pattern


def _browser_worker(hwnd: int) -> Dict[str, Any]:
    iuia, U = _uia()
    window = _window_info(hwnd)
    root = iuia.ElementFromHandle(hwnd)
    cache = iuia.CreateCacheRequest()
    for prop in (U.UIA_NamePropertyId, U.UIA_ControlTypePropertyId, U.UIA_ValueValuePropertyId):
        cache.AddProperty(prop)
    edits = root.FindAllBuildCache(
        U.TreeScope_Descendants,
        iuia.CreatePropertyCondition(U.UIA_ControlTypePropertyId, 50004),
        cache,
    )
    url = None
    for index in range(min(int(edits.Length), 40)):
        element = edits.GetElement(index)
        name = (_safe(lambda: element.CachedName) or "").lower()
        if "address" in name or "search bar" in name or "url" in name:
            value = _safe(lambda: element.GetCachedPropertyValue(U.UIA_ValueValuePropertyId))
            if isinstance(value, str) and value:
                url = value
                break
    buttons = root.FindAllBuildCache(
        U.TreeScope_Descendants,
        iuia.CreatePropertyCondition(U.UIA_ControlTypePropertyId, 50000),
        cache,
    )
    loading = None
    for index in range(min(int(buttons.Length), 120)):
        name = (_safe(lambda i=index: buttons.GetElement(i).CachedName) or "").lower()
        if name.startswith("stop") or "stop loading" in name:
            loading = True
            break
        if name == "reload" or name.startswith("reload") or name.startswith("refresh"):
            loading = False
    process = (window.get("process") or "").lower()
    browser = "chrome" if "chrome" in process else "edge" if "msedge" in process else "firefox" if "firefox" in process else "brave" if "brave" in process else process or "unknown"
    return {"window": window, "browser": browser, "url": url, "title": window["title"], "loading": loading}


@register("inspectUi")
def inspect_ui(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd = _resolve_hwnd(args)
    max_elements = max(10, min(400, int(args.get("max_elements", 160))))
    roles = args.get("roles") if isinstance(args.get("roles"), list) else []
    snapshot = _run(_snapshot_worker, hwnd, max_elements, str(args.get("query") or ""), [str(r) for r in roles])
    window = snapshot["window"]
    note = ""
    if window["minimized"]:
        note = " The window is minimized, so few controls are visible; restore it first."
    snapshot["result"] = f"Inspected {len(snapshot['elements'])} controls in '{window['title']}'.{note}"
    return snapshot


@register("findUi")
def find_ui(args: Dict[str, Any]) -> Dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("findUi requires a query.")
    hwnd = _resolve_hwnd(args)
    snapshot = _run(_snapshot_worker, hwnd, max(5, min(60, int(args.get("limit", 20)))), query, [str(r) for r in (args.get("roles") or [])])
    snapshot["result"] = f"Found {len(snapshot['elements'])} controls matching '{query}'."
    return snapshot


@register("uiAction")
def ui_action(args: Dict[str, Any]) -> Dict[str, Any]:
    element_id = str(args.get("element_id") or "").strip()
    if not element_id:
        raise ToolError("uiAction requires element_id from inspectUi.")
    action = str(args.get("action") or "click").strip().lower()
    method = str(args.get("method") or "auto").lower()
    value = args.get("value")
    outcome = _run(_action_worker, element_id, args.get("snapshot_id"), action, None if value is None else str(value), method)
    outcome["result"] = f"{action} on {outcome['element']['role']} '{outcome['element']['name']}' via {outcome.get('method')}."
    return outcome


@register("browserState")
def browser_state(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd = _resolve_hwnd(args)
    state = _run(_browser_worker, hwnd)
    state["result"] = f"{state['browser']} at {state['url'] or 'unknown URL'}" + (" (loading)" if state["loading"] else "")
    return state


__all__ = ["inspect_ui", "find_ui", "ui_action", "browser_state", "ROLE_NAMES"]

