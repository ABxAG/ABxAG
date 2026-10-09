"""Cheap visual perception primitives and window/monitor geometry.

screenFingerprint  coarse luminance grid of a region; ABxAG diffs these to
                   decide whether anything changed before spending a model call.
captureForVision   occlusion-free capture of one window (PrintWindow with
                   full-content rendering) or of a screen region, downscaled
                   to a JPEG, plus the exact image->screen coordinate mapping
                   so model-proposed boxes convert back to live pixels.
getMonitors        every monitor with physical bounds, work area and DPI scale.
windowControl      focus / move / resize / min / max / restore / close with
                   verification of the resulting rectangle.
inputState         OS idle time and cursor position (for user-conflict checks).
"""

from __future__ import annotations

import base64
import ctypes
import io
import platform
import time
from typing import Any, Dict, Optional, Tuple

from .registry import ToolError, register
from .tools_screenshot import _capture_region
from .tools_targeting import _enable_dpi_awareness

_enable_dpi_awareness()


def _virtual_bounds() -> Tuple[int, int, int, int]:
    from .tools_input import _desktop_bounds

    return _desktop_bounds()


def _region_from_args(args: Dict[str, Any]) -> Tuple[Tuple[int, int, int, int], Optional[int]]:
    import win32gui

    target = str(args.get("target") or "screen")
    if target == "rect":
        rect = args.get("rect") or {}
        try:
            box = (int(rect["left"]), int(rect["top"]), int(rect["right"]), int(rect["bottom"]))
        except Exception as error:
            raise ToolError("rect needs left, top, right and bottom.") from error
        return box, None
    if target in {"window", "active_window"}:
        hwnd = int(args.get("hwnd") or 0) or win32gui.GetForegroundWindow()
        if not hwnd or not win32gui.IsWindow(hwnd):
            raise ToolError("WINDOW_NOT_OPEN: target window not found.")
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        return (left, top, right, bottom), hwnd
    if target == "monitor":
        import win32api
        import win32con

        hwnd = win32gui.GetForegroundWindow()
        monitor = win32api.MonitorFromWindow(hwnd, win32con.MONITOR_DEFAULTTONEAREST)
        return tuple(win32api.GetMonitorInfo(monitor)["Monitor"]), None  # type: ignore[return-value]
    return _virtual_bounds(), None


def _clip(box: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
    vl, vt, vr, vb = _virtual_bounds()
    left, top, right, bottom = max(box[0], vl), max(box[1], vt), min(box[2], vr), min(box[3], vb)
    if right - left < 2 or bottom - top < 2:
        raise ToolError("Capture region is outside every monitor.")
    return left, top, right, bottom


def _print_window(hwnd: int):
    """Capture a window's own pixels even when other windows cover it."""
    import win32gui
    import win32ui
    from PIL import Image

    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0 or win32gui.IsIconic(hwnd):
        raise ToolError("WINDOW_NOT_OPEN: the window is minimized; restore it before capturing.")
    window_dc = win32gui.GetWindowDC(hwnd)
    source = win32ui.CreateDCFromHandle(window_dc)
    memory = source.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(source, width, height)
        memory.SelectObject(bitmap)
        PW_RENDERFULLCONTENT = 0x00000002
        ok = ctypes.windll.user32.PrintWindow(hwnd, memory.GetSafeHdc(), PW_RENDERFULLCONTENT)
        bits = bitmap.GetBitmapBits(True)
        image = Image.frombuffer("RGB", (width, height), bits, "raw", "BGRX", 0, 1).copy()
        if not ok:
            raise ToolError("PrintWindow failed")
        # A fully black frame means the app refused PrintWindow (some GPU apps).
        if image.convert("L").getextrema()[1] < 4:
            raise ToolError("PrintWindow returned an empty frame")
        return image, (left, top, right, bottom)
    finally:
        for cleanup in (memory.DeleteDC, source.DeleteDC):
            try:
                cleanup()
            except Exception:
                pass
        try:
            win32gui.ReleaseDC(hwnd, window_dc)
        except Exception:
            pass
        try:
            win32gui.DeleteObject(bitmap.GetHandle())
        except Exception:
            pass


@register("screenFingerprint")
def screen_fingerprint(args: Dict[str, Any]) -> Dict[str, Any]:
    started = time.perf_counter()
    box, _hwnd = _region_from_args(args)
    box = _clip(box)
    columns = max(4, min(32, int(args.get("columns", 16))))
    rows = max(3, min(24, int(args.get("rows", 9))))
    image = _capture_region(box).convert("L").resize((columns, rows))
    cells = list(image.getdata())
    return {
        "result": f"Fingerprinted {columns}x{rows} grid.",
        "region": {"left": box[0], "top": box[1], "right": box[2], "bottom": box[3]},
        "columns": columns,
        "rows": rows,
        "cells": cells,
        "duration_ms": round((time.perf_counter() - started) * 1000),
    }


@register("captureForVision")
def capture_for_vision(args: Dict[str, Any]) -> Dict[str, Any]:
    from PIL import Image

    started = time.perf_counter()
    box, hwnd = _region_from_args(args)
    method = "screen"
    image = None
    if hwnd and args.get("occlusion_free", True):
        try:
            image, box = _print_window(hwnd)
            method = "print_window"
        except ToolError:
            image = None
    if image is None:
        box = _clip(box)
        image = _capture_region(box)
    crop = args.get("crop")
    if isinstance(crop, dict):
        # Crop is given in screen pixels; translate into the captured image.
        left = max(0, int(crop.get("left", box[0])) - box[0])
        top = max(0, int(crop.get("top", box[1])) - box[1])
        right = min(image.width, int(crop.get("right", box[2])) - box[0])
        bottom = min(image.height, int(crop.get("bottom", box[3])) - box[1])
        if right - left > 4 and bottom - top > 4:
            image = image.crop((left, top, right, bottom))
            box = (box[0] + left, box[1] + top, box[0] + right, box[1] + bottom)
    max_dim = max(320, min(2048, int(args.get("max_dim", 1280))))
    scale = min(1.0, max_dim / float(max(image.width, image.height)))
    if scale < 1.0:
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))), Image.LANCZOS)
    quality = max(35, min(90, int(args.get("quality", 62))))
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality, optimize=True)
    return {
        "result": f"Captured {image.width}x{image.height} via {method}.",
        "image_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "image_mime": "image/jpeg",
        "width": image.width,
        "height": image.height,
        # screen_x = origin_x + image_x / scale
        "mapping": {"origin_x": box[0], "origin_y": box[1], "scale": scale},
        "method": method,
        "duration_ms": round((time.perf_counter() - started) * 1000),
    }


@register("getMonitors")
def get_monitors(_args: Dict[str, Any]) -> Dict[str, Any]:
    if platform.system() != "Windows":
        raise ToolError("Monitor enumeration is Windows-only.")
    import win32api

    monitors = []
    for handle, _dc, rect in win32api.EnumDisplayMonitors(None, None):
        info = win32api.GetMonitorInfo(handle)
        dpi_x = ctypes.c_uint(96)
        dpi_y = ctypes.c_uint(96)
        try:
            ctypes.windll.shcore.GetDpiForMonitor(int(handle), 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y))
        except Exception:
            pass
        monitors.append({
            "device": info.get("Device"),
            "primary": bool(info.get("Flags", 0) & 1),
            "rect": dict(zip(("left", "top", "right", "bottom"), info["Monitor"])),
            "work": dict(zip(("left", "top", "right", "bottom"), info["Work"])),
            "dpi": int(dpi_x.value),
            "scale": round(dpi_x.value / 96.0, 2),
        })
    left, top, right, bottom = _virtual_bounds()
    return {
        "result": f"{len(monitors)} monitor(s).",
        "monitors": monitors,
        "virtual": {"left": left, "top": top, "right": right, "bottom": bottom},
    }


@register("inputState")
def input_state(_args: Dict[str, Any]) -> Dict[str, Any]:
    import ctypes.wintypes as wintypes

    from .perception import _idle_seconds

    point = wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return {"result": "Read input state.", "idle_ms": int(_idle_seconds() * 1000), "cursor": {"x": point.x, "y": point.y}}


@register("windowControl")
def window_control(args: Dict[str, Any]) -> Dict[str, Any]:
    import win32con
    import win32gui

    from .tools_windows import _find_window_by_title, _focus

    hwnd = int(args.get("hwnd") or 0)
    if not hwnd:
        title = str(args.get("title") or "").strip()
        hwnd = int(_find_window_by_title(title) or 0) if title else int(win32gui.GetForegroundWindow())
    if not hwnd or not win32gui.IsWindow(hwnd):
        raise ToolError("WINDOW_NOT_OPEN: window not found.")
    action = str(args.get("action") or "focus").lower()
    if action == "focus":
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.15)
        _focus(hwnd)
    elif action in {"move", "resize", "move_resize"}:
        if win32gui.IsIconic(hwnd) or _is_maximized(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.12)
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        x = int(args.get("x", left))
        y = int(args.get("y", top))
        width = int(args.get("width", right - left))
        height = int(args.get("height", bottom - top))
        if width < 120 or height < 80:
            raise ToolError("Window size too small (minimum 120x80).")
        vl, vt, vr, vb = _virtual_bounds()
        if x + 40 > vr or y + 20 > vb or x + width - 40 < vl or y < vt - 10:
            raise ToolError("Target position would put the window off-screen.")
        win32gui.SetWindowPos(hwnd, 0, x, y, width, height, win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
    elif action == "minimize":
        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
    elif action == "maximize":
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    elif action == "restore":
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    elif action == "close":
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    else:
        raise ToolError(f"Unsupported window action '{action}'.")
    time.sleep(0.18)
    exists = bool(win32gui.IsWindow(hwnd))
    rect = win32gui.GetWindowRect(hwnd) if exists else None
    return {
        "result": f"Window {action} done.",
        "hwnd": hwnd,
        "exists": exists,
        "title": win32gui.GetWindowText(hwnd) if exists else None,
        "rect": dict(zip(("left", "top", "right", "bottom"), rect)) if rect else None,
        "minimized": bool(win32gui.IsIconic(hwnd)) if exists else None,
        "maximized": _is_maximized(hwnd) if exists else None,
        "foreground": exists and int(win32gui.GetForegroundWindow()) == hwnd,
    }


def _is_maximized(hwnd: int) -> bool:
    import win32gui

    try:
        return win32gui.GetWindowPlacement(hwnd)[1] == 3
    except Exception:
        return False


__all__ = ["screen_fingerprint", "capture_for_vision", "get_monitors", "input_state", "window_control"]

