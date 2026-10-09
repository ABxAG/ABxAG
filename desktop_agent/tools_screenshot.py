"""
Screenshot & screen-reading: capture, save, OCR, and read on-screen text.

  takeScreenshot    -> capture full screen, return metadata (+ small base64)
  saveScreenshot    -> capture & write to a file under the Screenshots folder
  analyzeScreenshot-> capture, run OCR (pytesseract), return extracted text
  readScreen        -> OCR the active window region + name the active window
  viewScreen        -> explicit ABxAG screen-vision: capture the active display,
                       return an optimized JPEG + dimensions + active window
                       title. A temp copy is created only when requested.

OCR requires the Tesseract OCR engine + the pytesseract wrapper. If either is
missing, the OCR tools return a graceful 'unavailable' message instead of
crashing; non-OCR capture still works.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .registry import ToolError, register

log = logging.getLogger("abxag.screenshot")

SCREENSHOTS_DIR = Path(os.path.expanduser("~")) / "Pictures" / "ABxAGScreenshots"

# Dedicated folder under the OS temp dir used by viewScreen for short-lived
# frame copies. Keeps capture out of the source tree / user Pictures, and
# isolates cleanup so we never delete unrelated files.
VIEWSCREEN_TEMP_DIR = Path(tempfile.gettempdir()) / "abxag-screen-vision"
VIEWSCREEN_TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Maximum age of a temp viewScreen file before it is reaped (seconds).
# Generous so multi-step AI processing still has the file if needed; the
# capture path itself can be deleted earlier by passing cleanup=True.
VIEWSCREEN_TEMP_MAX_AGE_S = 5 * 60


def _capture() -> "Any":
    """Capture the full virtual screen as a PIL Image."""
    try:
        import win32api
        import win32con

        left = win32api.GetSystemMetrics(win32con.SM_XVIRTUALSCREEN)
        top = win32api.GetSystemMetrics(win32con.SM_YVIRTUALSCREEN)
        width = win32api.GetSystemMetrics(win32con.SM_CXVIRTUALSCREEN)
        height = win32api.GetSystemMetrics(win32con.SM_CYVIRTUALSCREEN)
        return _capture_region((left, top, left + width, top + height))
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Screen capture failed: {e}")


def _capture_region_gdi(bbox):
    """Capture a physical Windows rectangle through GDI.

    Pillow's ``ImageGrab`` can fail after PyInstaller freezing even though it
    works from source. GDI uses the pywin32 modules already shipped for ABxAG's
    desktop controls and behaves identically in source and frozen runtimes.
    """
    from PIL import Image
    import win32con
    import win32gui
    import win32ui

    left, top, right, bottom = (int(value) for value in bbox)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise ValueError("Capture bounds are empty.")

    desktop_dc = win32gui.GetDC(0)
    source_dc = win32ui.CreateDCFromHandle(desktop_dc)
    memory_dc = source_dc.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(source_dc, width, height)
        memory_dc.SelectObject(bitmap)
        raster_operation = win32con.SRCCOPY | getattr(win32con, "CAPTUREBLT", 0x40000000)
        memory_dc.BitBlt((0, 0), (width, height), source_dc, (left, top), raster_operation)
        bits = bitmap.GetBitmapBits(True)
        return Image.frombuffer("RGB", (width, height), bits, "raw", "BGRX", 0, 1).copy()
    finally:
        try:
            memory_dc.DeleteDC()
        except Exception:
            pass
        try:
            source_dc.DeleteDC()
        except Exception:
            pass
        try:
            win32gui.ReleaseDC(0, desktop_dc)
        except Exception:
            pass
        try:
            win32gui.DeleteObject(bitmap.GetHandle())
        except Exception:
            pass


def _capture_region_mss(bbox):
    """Capture a physical rectangle with the headless-safe MSS backend."""
    from PIL import Image
    from mss import mss

    left, top, right, bottom = (int(value) for value in bbox)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        raise ValueError("Capture bounds are empty.")
    with mss() as capture:
        shot = capture.grab({"left": left, "top": top, "width": width, "height": height})
        return Image.frombytes("RGB", shot.size, shot.rgb)


def _capture_region(bbox):
    try:
        return _capture_region_mss(bbox)
    except Exception as mss_error:  # noqa: BLE001
        try:
            return _capture_region_gdi(bbox)
        except Exception as gdi_error:  # noqa: BLE001
            try:
                from PIL import ImageGrab

                # Source-only fallback. all_screens=True preserves negative coords.
                return ImageGrab.grab(bbox=bbox, all_screens=True)
            except Exception as image_grab_error:  # noqa: BLE001
                raise ToolError(
                    "Region capture failed: "
                    f"{image_grab_error} (MSS: {mss_error}; GDI: {gdi_error})"
                ) from image_grab_error


def _foreground_monitor_bbox(hwnd=None):
    """Return the physical bounds of the display containing ``hwnd``."""
    try:
        import win32api
        import win32con
        import win32gui

        target = hwnd or win32gui.GetForegroundWindow()
        if not target:
            return None
        monitor = win32api.MonitorFromWindow(target, win32con.MONITOR_DEFAULTTONEAREST)
        info = win32api.GetMonitorInfo(monitor)
        rect = info.get("Monitor")
        return tuple(rect) if rect and len(rect) == 4 else None
    except Exception:
        return None


def _is_abxag_window(title: str) -> bool:
    """Match only ABxAG's own packaged window, not arbitrary browser pages."""
    return title.strip().casefold() == "abxag"


def _capture_active_display() -> tuple[Any, str]:
    """Capture the display containing the user's foreground application.

    Capturing only the foreground *window* made typed requests photograph
    ABxAG itself, because the user had to focus ABxAG to type the question.
    The packaged app window is therefore hidden for the duration of this one
    capture and restored immediately; the newly exposed foreground display is
    then captured in full. Voice requests made while another app is focused do
    not hide or modify that app.
    """
    own_hwnd = None
    own_placement = None
    original_title = _active_window_title()
    try:
        import win32con
        import win32gui

        candidate = win32gui.GetForegroundWindow()
        if candidate and _is_abxag_window(original_title):
            own_hwnd = candidate
            own_placement = win32gui.GetWindowPlacement(own_hwnd)
            win32gui.ShowWindow(own_hwnd, win32con.SW_HIDE)
            # Let DWM expose and focus the window underneath before grabbing.
            time.sleep(0.12)

        target_hwnd = win32gui.GetForegroundWindow()
        target_title = win32gui.GetWindowText(target_hwnd) if target_hwnd else original_title
        bbox = _foreground_monitor_bbox(target_hwnd)
        if bbox:
            try:
                return _capture_region(bbox), target_title
            except ToolError as error:
                log.warning("[ScreenVision] active-display capture failed (%s); using primary display", error)

        # Primary-display fallback is more legible than shrinking the complete
        # virtual desktop when several monitors are attached.
        try:
            import win32api
            import win32con

            width = win32api.GetSystemMetrics(win32con.SM_CXSCREEN)
            height = win32api.GetSystemMetrics(win32con.SM_CYSCREEN)
            return _capture_region((0, 0, width, height)), target_title
        except Exception as error:  # noqa: BLE001
            if isinstance(error, ToolError):
                raise
            raise ToolError(f"Primary display capture failed: {error}") from error
    finally:
        if own_hwnd:
            try:
                import win32con
                import win32gui

                win32gui.ShowWindow(own_hwnd, win32con.SW_SHOWNA)
                if own_placement is not None:
                    win32gui.SetWindowPlacement(own_hwnd, own_placement)
                win32gui.SetForegroundWindow(own_hwnd)
            except Exception as error:  # noqa: BLE001
                log.warning("[ScreenVision] ABxAG window restore failed: %s", error)


def _active_window_bbox():
    """Return (left, top, right, bottom) of the foreground window, or None."""
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        rect = win32gui.GetWindowRect(hwnd)  # (l, t, r, b)
        return rect
    except Exception:
        return None


def _active_window_title() -> str:
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        return win32gui.GetWindowText(hwnd) if hwnd else ""
    except Exception:
        return ""


def _image_to_b64(img, fmt="PNG", quality=70) -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.convert("RGB").save(
            buf,
            format="JPEG",
            quality=quality,
            optimize=True,
            progressive=True,
        )
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_size_kb(img) -> int:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return len(buf.getvalue()) // 1024


def _run_ocr(img) -> str:
    # Windows' in-box OCR is bundled with ABxAG and needs no separately
    # installed Tesseract executable. It is also the same physical-pixel OCR
    # used by clickText, so reading and clicking agree on visible labels.
    if os.name == "nt":
        try:
            from .tools_targeting import _windows_ocr

            _lines, text = _windows_ocr(img)
            return text
        except Exception as windows_error:
            log.debug("Windows OCR unavailable; trying Tesseract: %s", windows_error)
    try:
        import pytesseract
    except ImportError:
        raise ToolError(
            "OCR unavailable: the 'pytesseract' package is not installed."
        )
    # Ensure the Tesseract binary is discoverable.
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe
    try:
        return pytesseract.image_to_string(img)
    except Exception as e:  # noqa: BLE001
        raise ToolError(
            "OCR failed (is the Tesseract engine installed?). Detail: " + str(e)
        )


def _find_tesseract_exe() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def _trim_ocr(text: str, max_chars: int = 1500) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = "\n".join(lines)
    if len(out) > max_chars:
        out = out[:max_chars] + "…"
    return out


@register("takeScreenshot")
def take_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    include_image = bool(args.get("include_image", False))
    result: Dict[str, Any] = {
        "result": f"Captured screen ({img.width}x{img.height}).",
        "width": img.width,
        "height": img.height,
    }
    if include_image:
        # Downscale + JPEG to keep payload small for the WS bridge.
        max_dim = int(args.get("max_dim", 1280))
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img_small = img.resize(
                (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            )
        else:
            img_small = img
        result["image_base64"] = _image_to_b64(img_small, fmt="JPEG", quality=60)
        result["image_mime"] = "image/jpeg"
    return result


@register("saveScreenshot")
def save_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = args.get("name")
    fname = f"{name}-{stamp}.png" if name else f"screenshot-{stamp}.png"
    out_path = SCREENSHOTS_DIR / fname
    img.save(out_path, format="PNG")
    return {"result": f"Saved screenshot to {out_path}.", "path": str(out_path)}


@register("analyzeScreenshot")
def analyze_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    try:
        text = _run_ocr(img)
    except ToolError as e:
        return {"result": f"Screenshot captured, but OCR unavailable: {e.message}"}
    return {
        "result": "Screenshot analyzed via OCR.",
        "text": _trim_ocr(text, int(args.get("max_chars", 1500))),
    }


@register("readScreen")
def read_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """OCR the active window and report its title + visible text."""
    title = _active_window_title()
    bbox = _active_window_bbox()
    if bbox:
        try:
            img = _capture_region(bbox)
        except ToolError:
            img = _capture()
    else:
        img = _capture()
    try:
        text = _run_ocr(img)
        visible = _trim_ocr(text, int(args.get("max_chars", 1500))) or "(no readable text)"
    except ToolError as e:
        return {
            "result": f"Active window: {title or 'unknown'}. OCR unavailable: {e.message}",
            "active_window": title,
        }
    return {
        "result": f"Active window '{title or 'unknown'}' contains readable text.",
        "active_window": title,
        "text": visible,
    }


def _cleanup_old_temp_files(max_age_s: int = VIEWSCREEN_TEMP_MAX_AGE_S) -> int:
    """Best-effort reaping of stale abxag-screen-vision temp files."""
    removed = 0
    try:
        now = time.time()
        for entry in VIEWSCREEN_TEMP_DIR.iterdir():
            try:
                if entry.is_file() and (now - entry.stat().st_mtime) > max_age_s:
                    entry.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                # File in use or already gone — skip silently.
                continue
    except OSError:
        pass
    return removed


def _save_temp_frame(img, prefix: str = "view") -> Dict[str, Any]:
    """Write a downsized JPEG of the captured image into the temp dir.

    Returns a dict with the saved path, file size, and the JPEG bytes
    separately so the caller can choose whether to keep or delete it.
    """
    max_dim = 1280
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        img = img.resize(
            (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
        )
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=70)
    raw = buf.getvalue()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"{prefix}-{stamp}-{os.getpid()}.jpg"
    out_path = VIEWSCREEN_TEMP_DIR / name
    out_path.write_bytes(raw)
    return {
        "path": str(out_path),
        "size_bytes": len(raw),
    }


@register("viewScreen")
def view_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """Capture the screen for the AI to see.

    The ABxAG Node bridge calls this only when the user has explicitly asked
    to look at / analyse / read their screen. The function:

      1. Captures the full display containing the foreground application;
         falls back to the primary display.
      2. Optionally stores a downsized JPEG under the OS temp directory only
         when ``keep_file`` is true.
      3. Returns the JPEG as base64 plus metadata so the bridge can hand it
         to the multimodal model as visual context.
      4. Reaps any stale temp files left over from previous calls.
    """
    log.info("[ScreenVision] Screen request received (args=%s)", sorted(args.keys()))

    cleanup = bool(args.get("cleanup", True))
    keep_file = bool(args.get("keep_file", False))
    max_dim = int(args.get("max_dim", 1024))
    max_dim = max(320, min(max_dim, 1920))  # safety bounds

    try:
        img, active_window = _capture_active_display()
    except ToolError as e:
        log.warning("[ScreenVision] capture failed: %s", e.message)
        return {
            "result": f"Screen capture failed: {e.message}",
            "error": e.message,
            "ok": False,
        }

    width, height = img.size

    # Build a base64 payload sized for AI consumption. The temp file uses a
    # 1280px cap for human readability; the base64 payload is sized for
    # multimodal API limits via the caller's max_dim argument.
    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        payload_img = img.resize(
            (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
        )
    else:
        payload_img = img
    payload_b64 = _image_to_b64(payload_img, fmt="JPEG", quality=72)

    if cleanup:
        _cleanup_old_temp_files()

    file_info: Optional[Dict[str, Any]] = None
    if keep_file:
        try:
            file_info = _save_temp_frame(img, prefix="view")
        except OSError as e:
            log.warning("[ScreenVision] failed to persist temp frame: %s", e)

    log.info(
        "[ScreenVision] Capture complete %dx%d payload=%dKB",
        width,
        height,
        len(payload_b64) * 3 // 4096,
    )

    result: Dict[str, Any] = {
        "result": f"Captured screen ({width}x{height}). Describe what you see and answer the user's question.",
        "ok": True,
        "width": width,
        "height": height,
        "payload_width": payload_img.size[0],
        "payload_height": payload_img.size[1],
        "image_base64": payload_b64,
        "image_mime": "image/jpeg",
        "active_window": active_window or None,
        "temp_dir": str(VIEWSCREEN_TEMP_DIR),
    }
    if file_info:
        result["temp_path"] = file_info["path"]
        result["temp_size_bytes"] = file_info["size_bytes"]
    return result


__all__ = [
    "take_screenshot",
    "save_screenshot",
    "analyze_screenshot",
    "read_screen",
    "view_screen",
]


