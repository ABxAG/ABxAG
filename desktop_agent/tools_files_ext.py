"""File-system perception and safe file actions for the autonomous agent.

knownFolder   resolve Pictures/Downloads/… through SHGetKnownFolderPath, so a
              OneDrive-redirected Pictures folder is found where it really is.
recentFiles   newest files of a kind (image, video, document, …) under the
              user's folders, bounded by depth, count and time.
statPath      existence/size/mtime/kind of one path (download verification).
copyFile      copy without overwriting unless explicitly asked.
openPath      open a file/folder with its default app. Executables, scripts
              and installers are refused unless the backend passes
              `allow_executable` after an explicit user confirmation.
"""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .registry import ToolError, register
from .tools_files import SAFE_ROOTS, _ensure_safe, _resolve_file

KNOWN_FOLDER_IDS = {
    "desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
    "downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
    "pictures": "{33E28130-4E1E-4676-835A-98395C3BC3BB}",
    "music": "{4BD8D571-6D19-48D3-BE97-422220080E43}",
    "videos": "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}",
    "screenshots": "{B7BEDE81-DF94-4682-A7D8-57A52620B86F}",
    "camera_roll": "{AB5FB87B-7CE2-4F83-915D-550846C9537B}",
}
ALIASES = {"photos": "pictures", "images": "pictures", "download": "downloads", "docs": "documents", "video": "videos"}

KINDS = {
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".tif", ".tiff", ".svg"},
    "video": {".mp4", ".mkv", ".mov", ".avi", ".webm", ".wmv", ".m4v"},
    "audio": {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".opus"},
    "document": {".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt", ".ppt", ".pptx", ".xls", ".xlsx", ".csv"},
    "archive": {".zip", ".rar", ".7z", ".tar", ".gz", ".tgz"},
    "executable": {".exe", ".msi", ".msix", ".appx", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".scr", ".com", ".jar", ".reg", ".lnk", ".hta", ".cpl"},
    "design": {".psd", ".blend", ".fbx", ".obj", ".pmx", ".ai", ".xcf", ".kra"},
}
PARTIAL_SUFFIXES = {".crdownload", ".part", ".partial", ".tmp", ".download"}


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16), ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]


def known_folder(name: str) -> Optional[Path]:
    key = ALIASES.get(name.strip().lower(), name.strip().lower())
    folder_id = KNOWN_FOLDER_IDS.get(key)
    if folder_id and platform.system() == "Windows":
        value = uuid.UUID(folder_id)
        guid = _GUID(value.fields[0], value.fields[1], value.fields[2], (ctypes.c_ubyte * 8)(*value.bytes[8:]))
        pointer = ctypes.c_wchar_p()
        try:
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(pointer)) == 0 and pointer.value:
                return Path(pointer.value)
        finally:
            if pointer:
                ctypes.windll.ole32.CoTaskMemFree(pointer)
    fallback = Path.home() / key.capitalize()
    return fallback if fallback.exists() else None


def kind_of(path: Path) -> str:
    suffix = path.suffix.lower()
    for kind, suffixes in KINDS.items():
        if suffix in suffixes:
            return kind
    return "other"


# Redirected known folders (OneDrive etc.) are legitimate user folders.
for _name in ("desktop", "documents", "downloads", "pictures", "music", "videos", "screenshots"):
    _path = known_folder(_name)
    if _path and _path not in SAFE_ROOTS:
        SAFE_ROOTS.append(_path)


def _walk(roots: Iterable[Path], max_depth: int, deadline: float, max_entries: int) -> Iterable[os.DirEntry]:
    visited = 0
    stack = [(root, 0) for root in roots if root and root.exists()]
    while stack:
        folder, depth = stack.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    visited += 1
                    if visited > max_entries or time.monotonic() > deadline:
                        return
                    name = entry.name
                    if name.startswith(".") or name.lower() in {"node_modules", "$recycle.bin", "appdata", "__pycache__"}:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if depth < max_depth:
                                stack.append((Path(entry.path), depth + 1))
                        elif entry.is_file(follow_symlinks=False):
                            yield entry
                    except OSError:
                        continue
        except OSError:
            continue


def _describe(path: Path, stat: Optional[os.stat_result] = None) -> Dict[str, Any]:
    stat = stat or path.stat()
    return {
        "path": str(path),
        "name": path.name,
        "kind": kind_of(path),
        "size": int(stat.st_size),
        "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)),
        "modified_epoch": stat.st_mtime,
    }


@register("knownFolder")
def known_folder_tool(args: Dict[str, Any]) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        return {"result": "Known folders.", "folders": {key: str(known_folder(key) or "") for key in KNOWN_FOLDER_IDS}}
    path = known_folder(name)
    if not path:
        raise ToolError(f"Unknown or missing known folder '{name}'.")
    return {"result": f"{name} is {path}.", "path": str(path), "exists": path.exists()}


@register("recentFiles")
def recent_files(args: Dict[str, Any]) -> Dict[str, Any]:
    kinds = {str(kind).lower() for kind in (args.get("kinds") or [])}
    folders = args.get("folders") or ["pictures", "downloads", "desktop", "documents", "videos", "screenshots"]
    roots: List[Path] = []
    for folder in folders:
        resolved = known_folder(str(folder)) or Path(os.path.expandvars(os.path.expanduser(str(folder))))
        if resolved and resolved.exists():
            _ensure_safe(resolved.resolve(), bool(args.get("allow_anywhere")))
            roots.append(resolved)
    # Drop roots nested inside other roots (e.g. Pictures\Screenshots).
    resolved_roots = sorted({root.resolve() for root in roots}, key=lambda item: len(str(item)))
    roots = [root for index, root in enumerate(resolved_roots)
             if not any(str(root).lower().startswith(str(parent).lower() + os.sep) for parent in resolved_roots[:index])]
    since_hours = float(args.get("since_hours", 24 * 30))
    cutoff = time.time() - since_hours * 3600
    name_contains = str(args.get("name_contains") or "").lower()
    limit = max(1, min(100, int(args.get("limit", 20))))
    deadline = time.monotonic() + max(0.5, min(6.0, float(args.get("time_budget", 3.0))))
    found: List[Dict[str, Any]] = []
    for entry in _walk(roots, max(0, min(6, int(args.get("max_depth", 3)))), deadline, 60_000):
        path = Path(entry.path)
        if kinds and kind_of(path) not in kinds:
            continue
        if name_contains and name_contains not in path.name.lower():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        if stat.st_mtime < cutoff:
            continue
        found.append(_describe(path, stat))
    found.sort(key=lambda item: item["modified_epoch"], reverse=True)
    return {
        "result": f"Found {len(found)} matching file(s); returning {min(limit, len(found))}.",
        "files": found[:limit],
        "roots": [str(root) for root in roots],
        "searched_until_deadline": time.monotonic() > deadline,
    }


@register("statPath")
def stat_path(args: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_file(args.get("path"))
    if not path.exists():
        partials = [str(path) + suffix for suffix in PARTIAL_SUFFIXES if Path(str(path) + suffix).exists()]
        return {"result": f"{path} does not exist.", "exists": False, "path": str(path), "partial_download": partials[0] if partials else None}
    info = _describe(path) if path.is_file() else {"path": str(path), "name": path.name, "kind": "folder"}
    return {"result": f"{path.name} exists.", "exists": True, "is_dir": path.is_dir(), **info}


@register("copyFile")
def copy_file(args: Dict[str, Any]) -> Dict[str, Any]:
    source = _resolve_file(args.get("path"), must_exist=True)
    destination = _resolve_file(args.get("destination"))
    _ensure_safe(source, bool(args.get("allow_anywhere")))
    _ensure_safe(destination, bool(args.get("allow_anywhere")))
    if destination.is_dir():
        destination = destination / source.name
    if destination.exists() and not args.get("overwrite"):
        raise ToolError(f"Destination already exists: {destination}. Pass overwrite=true to replace it.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=bool(args.get("overwrite")))
    else:
        shutil.copy2(source, destination)
    return {"result": f"Copied to {destination}.", "path": str(destination), "exists": destination.exists()}


@register("openPath")
def open_path(args: Dict[str, Any]) -> Dict[str, Any]:
    path = _resolve_file(args.get("path"), must_exist=True)
    if path.is_file() and kind_of(path) == "executable" and not args.get("allow_executable"):
        raise ToolError(
            "CONFIRMATION_REQUIRED: this is an executable, installer or script. "
            "It will only be opened after the user explicitly confirms."
        )
    if args.get("select") and path.exists():
        import subprocess

        subprocess.Popen(["explorer.exe", "/select,", str(path)])
        return {"result": f"Showed {path.name} in File Explorer.", "path": str(path), "method": "explorer_select"}
    if platform.system() != "Windows":
        raise ToolError("openPath is implemented for Windows.")
    os.startfile(str(path))  # type: ignore[attr-defined]
    return {"result": f"Opened {path.name}.", "path": str(path), "kind": kind_of(path) if path.is_file() else "folder"}


__all__ = ["known_folder", "kind_of", "recent_files", "stat_path", "copy_file", "open_path"]
