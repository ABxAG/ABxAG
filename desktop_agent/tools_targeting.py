"""High-accuracy, text-targeted desktop pointing for Windows.

The generic ``click`` tool accepts coordinates and is useful for canvases, but
coordinates inferred by a vision model are not precise enough for adjacent UI
labels.  These tools resolve an exact visible label at action time using UI
Automation first and Windows' built-in OCR second.  They deliberately refuse
to click when the label is absent or ambiguous.
"""

from __future__ import annotations

import asyncio
import io
import platform
import re
import time
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from PIL import ImageChops, ImageStat

from .registry import ToolError, register
from .tools_input import _desktop_bounds
from .tools_screenshot import _capture_region
from .tools_windows import SW_RESTORE, _find_window_by_title, _focus, _show_window


Rect = Tuple[int, int, int, int]


def _enable_dpi_awareness() -> None:
    """Make screenshot pixels, OCR boxes, and cursor coordinates use one scale."""
    if platform.system() != "Windows":
        return
    try:
        import ctypes

        # PER_MONITOR_AWARE_V2 where supported (Windows 10+).
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


_enable_dpi_awareness()


def _normalize(value: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value).casefold()))


def _union(rectangles: Iterable[Rect]) -> Rect:
    rects = list(rectangles)
    return (
        min(rect[0] for rect in rects),
        min(rect[1] for rect in rects),
        max(rect[2] for rect in rects),
        max(rect[3] for rect in rects),
    )


def _match_ocr_lines(lines: Sequence[Sequence[Dict[str, Any]]], text: str) -> List[Dict[str, Any]]:
    """Return only exact token matches, including consecutive multi-word labels."""
    target_tokens = _normalize(text).split()
    if not target_tokens:
        return []
    matches: List[Dict[str, Any]] = []
    for line_index, words in enumerate(lines):
        normalized = [_normalize(word.get("text", "")) for word in words]
        width = len(target_tokens)
        for start in range(0, len(words) - width + 1):
            if normalized[start : start + width] != target_tokens:
                continue
            selected = words[start : start + width]
            rect = _union(tuple(word["rect"]) for word in selected)
            matches.append({
                "text": " ".join(str(word["text"]) for word in selected),
                "rect": rect,
                "line": line_index,
                "word_start": start,
                "source": "windows_ocr",
            })
    return matches


async def _windows_ocr_async(image) -> Tuple[List[List[Dict[str, Any]]], str]:
    try:
        from winrt.windows.globalization import Language
        from winrt.windows.graphics.imaging import BitmapDecoder
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream
    except ImportError as error:
        raise ToolError("Exact text targeting requires the Windows OCR components.") from error

    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream)
    writer.write_bytes(encoded.getvalue())
    await writer.store_async()
    writer.detach_stream()
    stream.seek(0)

    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        engine = OcrEngine.try_create_from_language(Language("en-US"))
    if engine is None:
        raise ToolError("Windows OCR could not initialize an OCR language.")
    result = await engine.recognize_async(bitmap)
    lines: List[List[Dict[str, Any]]] = []
    for line in result.lines:
        words: List[Dict[str, Any]] = []
        for word in line.words:
            bounds = word.bounding_rect
            left, top = int(round(bounds.x)), int(round(bounds.y))
            right = int(round(bounds.x + bounds.width))
            bottom = int(round(bounds.y + bounds.height))
            if right > left and bottom > top:
                words.append({"text": word.text, "rect": (left, top, right, bottom)})
        if words:
            lines.append(words)
    return lines, str(result.text or "")


def _windows_ocr(image) -> Tuple[List[List[Dict[str, Any]]], str]:
    return asyncio.run(_windows_ocr_async(image))


def _uia_matches(hwnd: int, text: str) -> List[Dict[str, Any]]:
    """Find exact visible UI Automation labels (works for native apps)."""
    if platform.system() != "Windows":
        return []
    target = _normalize(text)
    if not target:
        return []
    try:
        from pywinauto import Desktop

        root = Desktop(backend="uia").window(handle=hwnd)
        candidates = [root, *root.descendants()]
    except Exception:
        return []
    matches: List[Dict[str, Any]] = []
    seen = set()
    for control in candidates:
        try:
            label = control.window_text().strip()
            if _normalize(label) != target or not control.is_visible() or not control.is_enabled():
                continue
            box = control.rectangle()
            rect = (int(box.left), int(box.top), int(box.right), int(box.bottom))
            if rect in seen or rect[2] <= rect[0] or rect[3] <= rect[1]:
                continue
            seen.add(rect)
            matches.append({"text": label, "rect": rect, "source": "windows_uia"})
        except Exception:
            continue
    return matches


def _window(args: Dict[str, Any], *, focus_named: bool) -> Tuple[int, str, Rect]:
    if platform.system() != "Windows":
        raise ToolError("Exact text targeting is currently available on Windows.")
    try:
        import win32gui
    except ImportError as error:
        raise ToolError("Exact text targeting requires Windows desktop components.") from error

    title_query = str(args.get("window_title") or "").strip()
    if title_query:
        hwnd = _find_window_by_title(title_query)
        if not hwnd:
            raise ToolError(f"No visible window with title containing '{title_query}'.")
        if focus_named:
            _show_window(hwnd, SW_RESTORE)
            _focus(hwnd)
            time.sleep(0.18)
    else:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            raise ToolError("No active window found.")

    title = win32gui.GetWindowText(hwnd) or title_query or "active window"
    window_rect = tuple(int(value) for value in win32gui.GetWindowRect(hwnd))
    desktop = _desktop_bounds()
    rect = (
        max(window_rect[0], desktop[0]),
        max(window_rect[1], desktop[1]),
        min(window_rect[2], desktop[2]),
        min(window_rect[3], desktop[3]),
    )
    if rect[2] <= rect[0] or rect[3] <= rect[1]:
        raise ToolError(f"Window '{title}' has no visible capture area.")
    return int(hwnd), title, rect


def _locate(args: Dict[str, Any], *, focus_named: bool) -> Tuple[Dict[str, Any], Any, Rect, str]:
    text = args.get("text")
    if not isinstance(text, str) or not _normalize(text):
        raise ToolError("A non-empty visible text label is required.")
    hwnd, title, capture_rect = _window(args, focus_named=focus_named)

    matches = _uia_matches(hwnd, text)
    image = None
    if not matches:
        image = _capture_region(capture_rect)
        lines, visible_text = _windows_ocr(image)
        local_matches = _match_ocr_lines(lines, text)
        for match in local_matches:
            left, top, right, bottom = match["rect"]
            match["rect"] = (
                left + capture_rect[0], top + capture_rect[1],
                right + capture_rect[0], bottom + capture_rect[1],
            )
        matches = local_matches
        if not matches:
            preview = " ".join(visible_text.split())[:240]
            suffix = f" Visible text included: {preview}" if preview else ""
            raise ToolError(
                f"Exact label '{text}' was not found in window '{title}'. No click was made.{suffix}"
            )

    occurrence_raw = args.get("occurrence")
    if len(matches) > 1 and occurrence_raw is None:
        raise ToolError(
            f"Exact label '{text}' appears {len(matches)} times in window '{title}'. "
            "Specify occurrence to disambiguate; no click was made."
        )
    try:
        occurrence = int(occurrence_raw or 1)
    except (TypeError, ValueError) as error:
        raise ToolError("Occurrence must be a positive integer.") from error
    if occurrence < 1 or occurrence > len(matches):
        raise ToolError(f"Occurrence {occurrence} is outside the {len(matches)} exact match(es).")

    match = matches[occurrence - 1]
    left, top, right, bottom = match["rect"]
    match = {
        **match,
        "rect": {"left": left, "top": top, "right": right, "bottom": bottom},
        "center": {"x": (left + right) // 2, "y": (top + bottom) // 2},
        "window": title,
        "exact": True,
        "match_count": len(matches),
    }
    return match, image, capture_rect, title


def _physical_click(x: int, y: int, button: str = "left") -> Dict[str, Any]:
    if button not in {"left", "right"}:
        raise ToolError("Text-targeted click supports left or right click only.")
    try:
        import win32api
        import win32con
    except ImportError as error:
        raise ToolError("Exact clicking requires Windows desktop components.") from error

    left, top, right, bottom = _desktop_bounds()
    if not (left <= x < right and top <= y < bottom):
        raise ToolError(f"Resolved target point ({x}, {y}) is outside the virtual desktop.")
    current_x, current_y = win32api.GetCursorPos()
    corners = ((left, top), (right - 1, top), (left, bottom - 1), (right - 1, bottom - 1))
    if any(abs(current_x - cx) <= 1 and abs(current_y - cy) <= 1 for cx, cy in corners):
        raise ToolError("Mouse fail-safe is active at a screen corner; no click was made.")

    # A moving hand on the mouse can nudge the cursor between placing and
    # checking it: place it again a few times before giving up.
    for _attempt in range(4):
        win32api.SetCursorPos((x, y))
        time.sleep(0.035)
        actual_x, actual_y = win32api.GetCursorPos()
        if abs(actual_x - x) <= 2 and abs(actual_y - y) <= 2:
            break
        time.sleep(0.06)
    if abs(actual_x - x) > 2 or abs(actual_y - y) > 2:
        raise ToolError(
            f"Cursor verification failed: requested ({x}, {y}), reached ({actual_x}, {actual_y}). "
            "No click was made."
        )
    if button == "left":
        down, up = win32con.MOUSEEVENTF_LEFTDOWN, win32con.MOUSEEVENTF_LEFTUP
    else:
        down, up = win32con.MOUSEEVENTF_RIGHTDOWN, win32con.MOUSEEVENTF_RIGHTUP
    win32api.mouse_event(down, 0, 0, 0, 0)
    time.sleep(0.035)
    win32api.mouse_event(up, 0, 0, 0, 0)
    return {"x": int(actual_x), "y": int(actual_y), "verified_within_pixels": 2}


def _change_score(before, after) -> float:
    if before.size != after.size:
        return 1.0
    # A small thumbnail makes the check fast and prevents single-pixel noise
    # from dominating. This verifies a visual response, not semantic success.
    size = (min(240, before.width), min(135, before.height))
    before_small = before.convert("RGB").resize(size)
    after_small = after.convert("RGB").resize(size)
    mean = ImageStat.Stat(ImageChops.difference(before_small, after_small)).mean
    return round(sum(mean) / (255.0 * len(mean)), 6)


@register("locateText")
def locate_text(args: Dict[str, Any]) -> Dict[str, Any]:
    match, _image, _capture_rect, title = _locate(args, focus_named=False)
    return {
        "result": f"Located exact visible label '{match['text']}' in '{title}' without clicking.",
        "match": match,
        "clicked": False,
    }


@register("clickText")
def click_text(args: Dict[str, Any]) -> Dict[str, Any]:
    match, before, capture_rect, title = _locate(args, focus_named=True)
    if before is None:
        before = _capture_region(capture_rect)
    point = match["center"]
    cursor = _physical_click(point["x"], point["y"], str(args.get("button") or "left").lower())
    wait = max(0.15, min(2.0, float(args.get("verify_wait", 0.65))))
    time.sleep(wait)
    try:
        after = _capture_region(capture_rect)
        score = _change_score(before, after)
    except Exception:
        score = 0.0
    return {
        "result": f"Clicked the exact visible label '{match['text']}' in '{title}'.",
        "match": match,
        "clicked": True,
        "cursor": cursor,
        "verification": {
            "visual_change_detected": score >= 0.003,
            "visual_change_score": score,
            "note": "The cursor destination was verified before mouse-down; visual change is a secondary check.",
        },
    }


__all__ = ["locate_text", "click_text", "_match_ocr_lines", "_change_score"]
