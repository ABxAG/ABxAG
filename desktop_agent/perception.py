"""Lightweight local desktop observation for ABxAG's event-driven runtime.

The snapshot contains metadata only: active window/app names, visible app names,
disk capacity, download file metadata, and idle time. It never captures screen
pixels, microphone audio, clipboard contents, or file contents.
"""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

try:
    import psutil  # type: ignore
except ImportError:  # metadata observation degrades gracefully in minimal dev runtimes
    psutil = None  # type: ignore


PARTIAL_DOWNLOAD_SUFFIXES = {".crdownload", ".part", ".partial", ".tmp"}


def collect_snapshot() -> Dict[str, Any]:
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "activeWindow": _active_window(),
        "applications": _visible_applications(),
        "disk": _disk_snapshot(),
        "downloads": _download_snapshot(),
        "userIdleSeconds": _idle_seconds(),
    }


def _active_window() -> Dict[str, Any]:
    fallback = {"title": None, "application": None, "pid": None}
    if platform.system() != "Windows":
        return fallback
    try:
        import win32gui  # type: ignore
        import win32process  # type: ignore

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return fallback
        title = win32gui.GetWindowText(hwnd).strip() or None
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        application = None
        if pid and psutil is not None:
            try:
                application = psutil.Process(pid).name()
            except Exception:
                pass
        return {"title": title, "application": application, "pid": pid or None}
    except Exception:
        return fallback


def _visible_applications() -> List[str]:
    if platform.system() != "Windows":
        return []
    if psutil is None:
        return []
    applications: set[str] = set()
    try:
        import win32gui  # type: ignore
        import win32process  # type: ignore

        def visit(hwnd: int, _extra: object) -> bool:
            try:
                if not win32gui.IsWindowVisible(hwnd):
                    return True
                if not win32gui.GetWindowText(hwnd).strip():
                    return True
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                if pid:
                    name = psutil.Process(pid).name()
                    if name:
                        applications.add(name)
            except Exception:
                pass
            return True

        win32gui.EnumWindows(visit, None)
    except Exception:
        return []
    return sorted(applications)[:80]


def _disk_snapshot() -> Dict[str, Any] | None:
    try:
        target = os.environ.get("SystemDrive", "C:") + "\\" if platform.system() == "Windows" else "/"
        usage = psutil.disk_usage(target) if psutil is not None else shutil.disk_usage(target)
        percent_used = float(usage.percent) if psutil is not None else (float(usage.used) / max(1, float(usage.total))) * 100
        return {
            "path": target,
            "freeBytes": int(usage.free),
            "totalBytes": int(usage.total),
            "percentUsed": percent_used,
        }
    except Exception:
        return None


def _download_snapshot() -> List[Dict[str, Any]]:
    downloads = Path.home() / "Downloads"
    if not downloads.is_dir():
        return []
    cutoff = time.time() - 2 * 86_400
    entries: List[tuple[float, Dict[str, Any]]] = []
    try:
        for item in downloads.iterdir():
            if not item.is_file():
                continue
            try:
                stat = item.stat()
            except OSError:
                continue
            if stat.st_mtime < cutoff:
                continue
            entries.append(
                (
                    stat.st_mtime,
                    {
                        "name": item.name,
                        "path": str(item),
                        "size": int(stat.st_size),
                        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                        "status": "downloading" if item.suffix.lower() in PARTIAL_DOWNLOAD_SUFFIXES else "complete",
                    },
                )
            )
    except OSError:
        return []
    entries.sort(key=lambda entry: entry[0], reverse=True)
    return [entry for _mtime, entry in entries[:40]]


def _idle_seconds() -> float:
    if platform.system() != "Windows":
        return 0.0
    try:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
            return 0.0
        tick = ctypes.windll.kernel32.GetTickCount()
        return max(0.0, (tick - info.dwTime) / 1000.0)
    except Exception:
        return 0.0


__all__ = ["collect_snapshot"]

